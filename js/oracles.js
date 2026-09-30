// Sonnetous oracles: data-checkable markets. PURE evaluators + keyless, CORS-friendly browser fetchers.
// Importable from Node (no DOM, no storage, no imports). Nothing here ever throws on bad data:
// malformed / empty / partial data always evaluates to { status: 'pending' }.
//
// ---------------------------------------------------------------------------------------------
// market.oracle = { type, params, source, label }
//
// type          params                                                            data passed to evaluate()  (what fetchOracleData returns)
// price_above   { symbol:'BTC-USD', threshold, at }                               { candles:[[t,low,high,open,close,vol]...], granularity:60 }
// price_move    { symbol, base, pct }                                              { series:[{ granularity, candles:[...] }, ...] }
// quake         { minMag }                                                         USGS GeoJSON FeatureCollection (raw)
// weather       { metric:'precip'|'tmax', threshold, date:'YYYY-MM-DD', at, tz }   Open-Meteo JSON (raw) + optional asOf (ms)
// wiki_battle   { project, date:'YYYY-MM-DD', a:{article,label}, b:{...} }         { a: <REST json|null>, b: <REST json|null> }
// sports        { sport, league, eventId, date:'YYYYMMDD', draw:boolean }          ESPN scoreboard JSON (raw)
//
// API-shape assumptions (no network in the build sandbox, written from documentation / experience):
//  * Coinbase Exchange  GET https://api.exchange.coinbase.com/products/{id}/candles?granularity=&start=&end=
//      -> JSON array of [time(sec, bucket start), low, high, open, close, volume], newest first, max 300 rows.
//      Empty minutes are omitted. Public + CORS "*". The bucket whose start is the current period is still forming.
//  * Coinbase Exchange  GET .../products/{id}/ticker -> { price:"64000.12", ... }
//  * USGS FDSN          GET https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&...
//      -> { type:'FeatureCollection', metadata:{count}, features:[{ id, properties:{ mag, place, time(ms), type, status, ... },
//      geometry:{ coordinates:[lon,lat,depth] } }] }. CORS "*".
//  * Open-Meteo         GET https://api.open-meteo.com/v1/forecast?...&daily=precipitation_sum,temperature_2m_max&timezone=..&start_date=&end_date=
//      -> { daily:{ time:['2026-10-01'], precipitation_sum:[0.3], temperature_2m_max:[17.2], precipitation_probability_max:[40] } }.
//      Days are in the requested IANA timezone. Keyless, CORS "*". Past dates (last ~3 months) are served from the same endpoint.
//  * Wikimedia REST     GET https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/all-access/user/{title}/daily/{YYYYMMDD}/{YYYYMMDD}
//      -> { items:[{ project, article, granularity:'daily', timestamp:'2026100100', access, agent, views }] }; 404 until the day is published.
//  * ESPN (unofficial)  GET https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=YYYYMMDD
//      -> { events:[{ id, date:'2026-10-01T23:00Z', name, competitions:[{ competitors:[{ homeAway, score:'112', winner, team:{...}, records:[{summary:'64-18'}] },..],
//      status:{ type:{ name:'STATUS_FINAL', state:'pre'|'in'|'post', completed:true } }, odds:[{ details:'BOS -4.5', homeTeamOdds:{moneyLine}, ... }] }] }] }.
//      `dates` is the scoreboard's (US Eastern) calendar day. CORS "*". Postponed / cancelled games never complete => stay pending.
// ---------------------------------------------------------------------------------------------

export const ORACLE_TYPES = Object.freeze(['price_above', 'price_move', 'quake', 'weather', 'wiki_battle', 'sports']);

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const toNum = (x) => {
  if (isNum(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return null;
};
const pending = () => ({ status: 'pending' });
const final = (optionId, eventAt = null) => ({ status: 'final', optionId, eventAt });
const isObj = (o) => o !== null && typeof o === 'object';

// ---------------------------------------------------------------- date / label helpers

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

/** '2026-10-01' | ms -> 'Oct 1' */
export function fmtDay(v) {
  const d = typeof v === 'string' ? new Date(`${v}T00:00:00Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
/** '2026-10-01' | ms -> 'Thu Oct 1' */
export function fmtDayLong(v) {
  const d = typeof v === 'string' ? new Date(`${v}T00:00:00Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
/** ms -> '00:00 UTC Oct 1' */
export function fmtUtc(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export const fmtUsd = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$?';
  const digits = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : 4;
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: digits })}`;
};

const ymd = (dateStr) => String(dateStr).replace(/-/g, '');

// ---------------------------------------------------------------- oracle descriptors

const SOURCES = {
  price_above: 'Coinbase Exchange',
  price_move: 'Coinbase Exchange',
  quake: 'USGS',
  weather: 'Open-Meteo',
  wiki_battle: 'Wikimedia',
  sports: 'ESPN',
};

function labelFor(type, p = {}) {
  switch (type) {
    case 'price_above':
      return `Coinbase ${p.symbol} close at ${isNum(p.at) ? fmtUtc(p.at) : '?'}`;
    case 'price_move':
      return `Coinbase ${p.symbol} candles: first ±${p.pct}% move from ${fmtUsd(p.base)}`;
    case 'quake':
      return `USGS catalog: first M${p.minMag}+ earthquake anywhere`;
    case 'weather':
      return p.metric === 'tmax'
        ? `Open-Meteo daily high in ${p.city || 'city'} on ${fmtDay(p.date)} (≥ ${p.threshold}°C?)`
        : `Open-Meteo daily precipitation in ${p.city || 'city'} on ${fmtDay(p.date)} (≥ ${p.threshold} mm?)`;
    case 'wiki_battle':
      return `Wikimedia daily pageviews on ${fmtDay(p.date)} (UTC): ${p.a?.label} vs ${p.b?.label}`;
    case 'sports':
      return `ESPN final score: ${p.awayName || 'away'} at ${p.homeName || 'home'}`;
    default:
      return String(type);
  }
}

/** Builds the `market.oracle` object stored on a market. */
export function makeOracle(type, params) {
  return { type, params: { ...params }, source: SOURCES[type] || String(type), label: labelFor(type, params) };
}

/** Short source name for badges: 'Coinbase Exchange', 'USGS', ... */
export function sourceLabel(oracle) {
  if (!oracle) return '';
  return oracle.source || SOURCES[oracle.type] || String(oracle.type || '');
}

/** UI sentence: "Auto-checked: Coinbase BTC-USD close at 00:00 UTC Oct 1". */
export function describeOracle(oracle) {
  if (!oracle) return '';
  return `Auto-checked: ${oracle.label || labelFor(oracle.type, oracle.params)}`;
}

// ---------------------------------------------------------------- candle parsing

/** Coinbase rows [time(sec), low, high, open, close, volume] -> [{t(ms), low, high, open, close, g(ms)}] ascending. */
export function parseCandles(raw, granularitySec = 60) {
  if (!Array.isArray(raw)) return [];
  const g = (toNum(granularitySec) || 60) * 1000;
  const out = [];
  for (const row of raw) {
    let t; let low; let high; let open; let close;
    if (Array.isArray(row)) [t, low, high, open, close] = row.map(toNum);
    else if (isObj(row)) [t, low, high, open, close] = [toNum(row.time), toNum(row.low), toNum(row.high), toNum(row.open), toNum(row.close)];
    else continue;
    if (![t, low, high, close].every(isNum) || t <= 0 || low > high) continue;
    out.push({ t: t * 1000, low, high, open: isNum(open) ? open : close, close, g });
  }
  return out.sort((a, b) => a.t - b.t);
}

function candlesFrom(data, defaultGranularity) {
  if (Array.isArray(data)) return parseCandles(data, defaultGranularity);
  if (isObj(data) && Array.isArray(data.candles)) return parseCandles(data.candles, data.granularity || defaultGranularity);
  return [];
}

// ---------------------------------------------------------------- shared: timer bucket lookup

/** Option id of the timer bucket containing eventAt (offset from market.openedAt), or null. */
export function bucketOptionId(market, eventAt) {
  if (!market || !isNum(market.openedAt) || !isNum(eventAt)) return null;
  const off = eventAt - market.openedAt;
  if (off < 0) return null;
  if (isObj(market.bucketsById)) {
    for (const [id, b] of Object.entries(market.bucketsById)) {
      if (isObj(b) && off >= b.fromMs && (b.toMs == null || off < b.toMs)) return id;
    }
    return null;
  }
  for (const o of market.options || []) {
    const from = (isNum(o.fromDays) ? o.fromDays : 0) * DAY_MS;
    const to = o.toDays == null ? Infinity : o.toDays * DAY_MS;
    if (off >= from && off < to) return o.id;
  }
  return null;
}

// ---------------------------------------------------------------- evaluators

function evalPriceAbove(oracle, data) {
  const { threshold, at } = oracle.params || {};
  if (!isNum(threshold) || !isNum(at)) return pending();
  const cs = candlesFrom(data, 60);
  if (!cs.length) return pending();
  // Proof that `at` has passed: a candle starting at/after `at` exists (Coinbase lists the forming candle).
  if (!cs.some((c) => c.t >= at)) return pending();
  // Close of the last candle that ended at or before `at` (with a sane gap).
  const before = cs.filter((c) => c.t + c.g <= at);
  if (!before.length) return pending();
  const last = before[before.length - 1];
  if (at - (last.t + last.g) > 15 * MIN_MS) return pending();
  return final(last.close > threshold ? 'yes' : 'no', null);
}

const round2 = (x) => Math.round(x * 100) / 100;

function evalPriceMove(oracle, data, market) {
  const { base, pct } = oracle.params || {};
  const openedAt = market && isNum(market.openedAt) ? market.openedAt : oracle.params?.openedAt;
  if (!isNum(base) || !isNum(pct) || !isNum(openedAt) || base <= 0 || pct <= 0) return pending();
  const up = round2(base * (1 + pct / 100));
  const down = round2(base * (1 - pct / 100));

  let series = [];
  if (isObj(data) && Array.isArray(data.series)) {
    series = data.series.map((s) => candlesFrom(s, s?.granularity || 3600));
  } else series = [candlesFrom(data, 300)];
  const all = series.flat();
  if (!all.length) return pending();

  const eligible = (c) => c.t >= openedAt || (c.g <= 300_000 && c.t + c.g > openedAt);
  const crossed = all.filter((c) => eligible(c) && (c.high >= up || c.low <= down));
  if (!crossed.length) return pending();
  // Prefer the finest resolution that saw the crossing; earliest first.
  const fine = crossed.filter((c) => c.g < HOUR_MS).sort((a, b) => a.t - b.t);
  const pick = fine.length ? fine[0] : crossed.sort((a, b) => a.t - b.t)[0];
  const eventAt = Math.max(pick.t, openedAt);
  const optionId = bucketOptionId(market, eventAt);
  return optionId ? final(optionId, eventAt) : pending();
}

function evalQuake(oracle, data, market) {
  const minMag = toNum(oracle.params?.minMag);
  const openedAt = market?.openedAt;
  if (!isNum(minMag) || !isNum(openedAt) || !isObj(data) || !Array.isArray(data.features)) return pending();
  let best = null;
  for (const f of data.features) {
    const pr = f && f.properties;
    if (!isObj(pr)) continue;
    const mag = toNum(pr.mag);
    const time = toNum(pr.time);
    if (!isNum(mag) || !isNum(time)) continue;
    if (pr.type && pr.type !== 'earthquake') continue;
    if (mag < minMag || time < openedAt) continue;
    if (best === null || time < best) best = time;
  }
  if (best === null) return pending();
  const optionId = bucketOptionId(market, best);
  return optionId ? final(optionId, best) : pending();
}

function evalWeather(oracle, data) {
  const p = oracle.params || {};
  if (!isObj(data) || !isObj(data.daily) || !Array.isArray(data.daily.time)) return pending();
  if (!isNum(p.threshold) || typeof p.date !== 'string') return pending();
  // Never settle before the local day is over (fetchers also refuse to fetch early).
  if (isNum(data.asOf) && isNum(p.at) && data.asOf < p.at) return pending();
  const idx = data.daily.time.indexOf(p.date);
  if (idx < 0) return pending();
  const arr = p.metric === 'tmax' ? data.daily.temperature_2m_max : data.daily.precipitation_sum;
  const v = Array.isArray(arr) ? toNum(arr[idx]) : null;
  if (!isNum(v)) return pending();
  return final(v >= p.threshold ? 'yes' : 'no', null);
}

/** Daily views for `date` ('YYYY-MM-DD') from a Wikimedia REST response, or null. */
export function wikiViewsOn(json, date) {
  if (!isObj(json) || !Array.isArray(json.items)) return null;
  const stamp = `${ymd(date)}00`;
  const item = json.items.find((i) => isObj(i) && String(i.timestamp) === stamp);
  const v = item ? toNum(item.views) : null;
  return isNum(v) && v >= 0 ? v : null;
}

function evalWiki(oracle, data) {
  const p = oracle.params || {};
  if (!isObj(data) || typeof p.date !== 'string') return pending();
  const a = wikiViewsOn(data.a, p.date);
  const b = wikiViewsOn(data.b, p.date);
  if (a === null || b === null) return pending();
  if (a === b) return pending(); // an exact tie has no winner; leave it to the humans
  return final(a > b ? 'a' : 'b', null);
}

// --- ESPN

function parseAmerican(x) {
  if (typeof x === 'string' && /^even$/i.test(x.trim())) return 100;
  const n = toNum(typeof x === 'string' ? x.replace(/^\+/, '') : x);
  return isNum(n) && n !== 0 ? n : null;
}
const impliedFromAmerican = (ml) => (ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));

/** Parses an ESPN scoreboard JSON into simple event objects (defensive; skips anything malformed). */
export function parseScoreboard(json) {
  if (!isObj(json) || !Array.isArray(json.events)) return [];
  const out = [];
  for (const ev of json.events) {
    try {
      const comp = ev?.competitions?.[0];
      if (!isObj(comp) || !Array.isArray(comp.competitors)) continue;
      const side = (ha) => {
        const c = comp.competitors.find((x) => x?.homeAway === ha);
        if (!c) return null;
        const t = c.team || {};
        const rec = Array.isArray(c.records) ? (c.records.find((r) => /total|overall/i.test(`${r?.type}${r?.name}`)) || c.records[0]) : null;
        return {
          id: String(c.id ?? t.id ?? ''),
          name: t.displayName || t.shortDisplayName || t.name || t.location || '',
          abbr: t.abbreviation || '',
          score: toNum(c.score),
          winner: c.winner === true,
          record: rec && typeof rec.summary === 'string' ? rec.summary : null,
        };
      };
      const home = side('home');
      const away = side('away');
      if (!home || !away) continue;
      const type = comp.status?.type || ev.status?.type || {};
      const o = Array.isArray(comp.odds) && isObj(comp.odds[0]) ? comp.odds[0] : null;
      const ml = (o0, k1, k2) => {
        const a = parseAmerican(o0?.[k1]?.moneyLine);
        if (a !== null) return a;
        return parseAmerican(o0?.moneyline?.[k2]?.close?.odds ?? o0?.moneyline?.[k2]?.open?.odds);
      };
      out.push({
        id: String(ev.id),
        startAt: Date.parse(ev.date || comp.date || ''),
        state: type.state || 'pre',
        statusName: type.name || '',
        completed: type.completed === true,
        home,
        away,
        odds: o
          ? { details: typeof o.details === 'string' ? o.details : null, homeML: ml(o, 'homeTeamOdds', 'home'), awayML: ml(o, 'awayTeamOdds', 'away'), drawML: parseAmerican(o.drawOdds?.moneyLine ?? o.moneyline?.draw?.close?.odds ?? o.moneyline?.draw?.open?.odds) }
          : null,
      });
    } catch { /* skip malformed event */ }
  }
  return out;
}

function evalSports(oracle, data) {
  const p = oracle.params || {};
  const ev = parseScoreboard(data).find((e) => e.id === String(p.eventId));
  if (!ev || !ev.completed || ev.state !== 'post') return pending();
  const { home, away } = ev;
  if (!isNum(home.score) || !isNum(away.score)) return pending();
  if (home.score > away.score) return final('home');
  if (away.score > home.score) return final('away');
  if (p.draw) return final('draw');
  if (home.winner !== away.winner) return final(home.winner ? 'home' : 'away'); // e.g. shootout flagged by ESPN
  return pending();
}

/**
 * Pure oracle evaluator.
 * @returns {{status:'pending'} | {status:'final', optionId:string, eventAt:number|null}}
 */
export function evaluate(oracle, data, market) {
  try {
    if (!isObj(oracle) || data == null) return pending();
    switch (oracle.type) {
      case 'price_above': return evalPriceAbove(oracle, data, market);
      case 'price_move': return evalPriceMove(oracle, data, market);
      case 'quake': return evalQuake(oracle, data, market);
      case 'weather': return evalWeather(oracle, data, market);
      case 'wiki_battle': return evalWiki(oracle, data, market);
      case 'sports': return evalSports(oracle, data, market);
      default: return pending();
    }
  } catch {
    return pending();
  }
}

// ---------------------------------------------------------------- URLs

export const ENDPOINTS = Object.freeze({
  coinbase: 'https://api.exchange.coinbase.com',
  usgs: 'https://earthquake.usgs.gov/fdsnws/event/1/query',
  openMeteo: 'https://api.open-meteo.com/v1/forecast',
  wikimedia: 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article',
  espn: 'https://site.api.espn.com/apis/site/v2/sports',
});

const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoNoZone = (ms) => new Date(ms).toISOString().slice(0, 19); // USGS treats zone-less times as UTC

export const urls = {
  ticker: (symbol) => `${ENDPOINTS.coinbase}/products/${encodeURIComponent(symbol)}/ticker`,
  candles: (symbol, granularity, startMs, endMs) =>
    `${ENDPOINTS.coinbase}/products/${encodeURIComponent(symbol)}/candles?granularity=${granularity}&start=${encodeURIComponent(isoZ(startMs))}&end=${encodeURIComponent(isoZ(endMs))}`,
  quakes: (minMag, startMs) =>
    `${ENDPOINTS.usgs}?format=geojson&eventtype=earthquake&minmagnitude=${minMag}&starttime=${isoNoZone(startMs)}&orderby=time-asc&limit=20`,
  weather: ({ lat, lon, tz, date }) =>
    `${ENDPOINTS.openMeteo}?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,temperature_2m_max,precipitation_probability_max&timezone=${encodeURIComponent(tz)}&start_date=${date}&end_date=${date}`,
  wiki: (project, article, fromDate, toDate) =>
    `${ENDPOINTS.wikimedia}/${project}/all-access/user/${encodeURIComponent(article)}/daily/${ymd(fromDate)}/${ymd(toDate)}`,
  scoreboard: (sport, league, yyyymmdd) => `${ENDPOINTS.espn}/${sport}/${league}/scoreboard?dates=${yyyymmdd}`,
};

// ---------------------------------------------------------------- fetch plumbing

async function getJson(fetchFn, url, timeoutMs = 12_000) {
  const init = {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchFn(url, init);
  if (!res || res.ok === false) throw new Error(`HTTP ${res ? res.status : 'error'} for ${url}`);
  return res.json();
}

/** Pages Coinbase candles (max 300 rows / request) over [startMs, endMs]. Returns raw rows. */
async function fetchCandleRange(fetchFn, symbol, granularity, startMs, endMs, maxPages = 4) {
  const span = (300 - 1) * granularity * 1000;
  const rows = [];
  for (let s = startMs, page = 0; s < endMs && page < maxPages; s += span, page++) {
    const e = Math.min(endMs, s + span);
    const json = await getJson(fetchFn, urls.candles(symbol, granularity, s, e));
    if (!Array.isArray(json)) throw new Error('bad candles');
    rows.push(...json);
  }
  return rows;
}

/**
 * Fetches the raw data evaluate() needs for a market's oracle. Returns null (never throws) when the data
 * is not available yet or the request failed — callers treat null as "pending".
 * Skips the network entirely before the market can possibly be final.
 */
export async function fetchOracleData(oracle, market, { fetch: fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  try {
    if (!isObj(oracle) || typeof fetchFn !== 'function') return null;
    const p = oracle.params || {};
    switch (oracle.type) {
      case 'price_above': {
        if (!isNum(p.at) || now < p.at) return null;
        const rows = await fetchCandleRange(fetchFn, p.symbol, 60, p.at - 15 * MIN_MS, p.at + 10 * MIN_MS);
        return { candles: rows, granularity: 60 };
      }
      case 'price_move': {
        const openedAt = market?.openedAt;
        if (!isNum(openedAt) || now <= openedAt) return null;
        const end = Math.min(now, market.expiresAt ?? now);
        const fineStart = Math.floor(openedAt / 300_000) * 300_000;
        const hourStart = Math.floor(openedAt / HOUR_MS) * HOUR_MS;
        const fineEnd = Math.min(end, fineStart + 299 * 300_000);
        // 5-minute candles cover the first ~25h precisely; hourly candles cover anything longer.
        const [fine, hourly] = await Promise.all([
          fetchCandleRange(fetchFn, p.symbol, 300, fineStart, fineEnd, 1).catch(() => null),
          end > fineEnd ? fetchCandleRange(fetchFn, p.symbol, 3600, hourStart, end, 3).catch(() => null) : null,
        ]);
        const series = [];
        if (fine) series.push({ granularity: 300, candles: fine });
        if (hourly) series.push({ granularity: 3600, candles: hourly });
        return series.length ? { series } : null;
      }
      case 'quake': {
        if (!isNum(market?.openedAt)) return null;
        const json = await getJson(fetchFn, urls.quakes(p.minMag, market.openedAt));
        return isObj(json) && Array.isArray(json.features) ? json : null;
      }
      case 'weather': {
        if (isNum(p.at) && now < p.at) return null;
        const json = await getJson(fetchFn, urls.weather({ lat: p.lat, lon: p.lon, tz: p.tz, date: p.date }));
        return isObj(json) && isObj(json.daily) ? { ...json, asOf: now } : null;
      }
      case 'wiki_battle': {
        if (isNum(p.at) && now < p.at) return null;
        const one = async (art) => {
          try { return await getJson(fetchFn, urls.wiki(p.project || 'en.wikipedia', art.article, p.date, p.date)); } catch { return null; }
        };
        const [a, b] = await Promise.all([one(p.a), one(p.b)]);
        return a || b ? { a, b } : null;
      }
      case 'sports': {
        const json = await getJson(fetchFn, urls.scoreboard(p.sport, p.league, p.date));
        return isObj(json) && Array.isArray(json.events) ? json : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
/** fetchOracleData + evaluate in one call. Never throws. */
export async function checkMarketOracle(market, opts = {}) {
  if (!market || !market.oracle) return pending();
  const data = await fetchOracleData(market.oracle, market, opts);
  return evaluate(market.oracle, data, market);
}

// ---------------------------------------------------------------- baseline fetchers (used when BUILDING house markets)

/** Latest Coinbase ticker price -> number (or throws). */
export function parseTickerPrice(json) {
  const v = toNum(json && json.price);
  if (!isNum(v) || v <= 0) throw new Error('bad ticker');
  return v;
}

/** Open-Meteo single-day forecast -> { tmax, precipSum, precipProb } (nulls allowed) or throws when there is no day. */
export function parseForecast(json, date) {
  const d = json && json.daily;
  const idx = d && Array.isArray(d.time) ? d.time.indexOf(date) : -1;
  if (idx < 0) throw new Error('no forecast day');
  const at = (k) => (Array.isArray(d[k]) ? toNum(d[k][idx]) : null);
  const out = { tmax: at('temperature_2m_max'), precipSum: at('precipitation_sum'), precipProb: at('precipitation_probability_max') };
  if (out.tmax === null && out.precipSum === null) throw new Error('empty forecast');
  return out;
}

/** Wikimedia response -> ascending [{date:'YYYYMMDD', views}] */
export function parseWikiSeries(json) {
  if (!isObj(json) || !Array.isArray(json.items)) return [];
  return json.items
    .map((i) => ({ date: String(i?.timestamp || '').slice(0, 8), views: toNum(i?.views) }))
    .filter((i) => /^\d{8}$/.test(i.date) && isNum(i.views))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Keyless baseline fetchers used by templates.buildDailyMarkets. Every method throws on failure
 * (the caller skips that template). Inject your own object in tests.
 */
export function createFetchers({ fetch: injected } = {}) {
  // resolved lazily so importing this module in a fetch-less environment is harmless
  const fetchFn = (...args) => (injected || globalThis.fetch)(...args);
  return {
    /** spot price of a Coinbase product */
    async spot(symbol) {
      return parseTickerPrice(await getJson(fetchFn, urls.ticker(symbol)));
    },
    /** { tmax, precipSum, precipProb } for a local calendar date */
    async forecast({ lat, lon, tz, date }) {
      return parseForecast(await getJson(fetchFn, urls.weather({ lat, lon, tz, date })), date);
    },
    /** daily views (ascending numbers) for `article` between two 'YYYY-MM-DD' dates inclusive */
    async wikiViews({ project = 'en.wikipedia', article, from, to }) {
      const series = parseWikiSeries(await getJson(fetchFn, urls.wiki(project, article, from, to)));
      if (!series.length) throw new Error('no pageviews');
      return series.map((s) => s.views);
    },
    /** parsed scoreboard events for a YYYYMMDD date */
    async scoreboard(sport, league, yyyymmdd) {
      return parseScoreboard(await getJson(fetchFn, urls.scoreboard(sport, league, yyyymmdd)));
    },
  };
}

// ---------------------------------------------------------------- ESPN odds helpers (used by sports templates)

/** de-vigged win probabilities from an event's odds/records, or null. Returns { home, draw|null, away }. */
export function sportsProbabilities(event, { sport = '', draw = false } = {}) {
  const clamp = (x) => Math.min(0.85, Math.max(0.1, x));
  const o = event.odds;
  if (o && o.homeML !== null && o.awayML !== null && o.homeML !== undefined && o.awayML !== undefined) {
    const h = impliedFromAmerican(o.homeML);
    const a = impliedFromAmerican(o.awayML);
    const d = draw ? (o.drawML !== null && o.drawML !== undefined ? impliedFromAmerican(o.drawML) : null) : 0;
    if (d !== null) {
      const tot = h + a + d;
      return { home: h / tot, draw: draw ? d / tot : null, away: a / tot };
    }
  }
  if (draw) return null; // soccer without a 3-way price: skip rather than guess
  // spread (points sports only)
  const sigma = { nfl: 13.5, nba: 12, wnba: 11 }[sport];
  if (sigma && o && typeof o.details === 'string') {
    const m = /^(.+?)\s+([+-]?\d+(?:\.\d+)?)$/.exec(o.details.trim());
    if (m) {
      const line = Number(m[2]);
      const abbr = m[1].trim().toUpperCase();
      const favHome = abbr === String(event.home.abbr).toUpperCase();
      const favAway = abbr === String(event.away.abbr).toUpperCase();
      if ((favHome || favAway) && line < 0) {
        const pFav = normCdf(Math.abs(line) / sigma);
        const pHome = favHome ? pFav : 1 - pFav;
        return { home: clamp(pHome), draw: null, away: 1 - clamp(pHome) };
      }
    }
    if (/^(even|pk|pick)/i.test(o.details.trim())) return { home: 0.52, draw: null, away: 0.48 };
  }
  // records fallback (log5 with shrinkage + a small home-field edge)
  const win = (r) => {
    const m = r && /^(\d+)-(\d+)(?:-(\d+))?/.exec(r);
    if (!m) return null;
    const w = Number(m[1]); const l = Number(m[2]) + Number(m[3] || 0);
    return w + l >= 4 ? w / (w + l) : 0.5;
  };
  const a = win(event.home.record);
  const b = win(event.away.record);
  if (a === null || b === null) return null;
  const clampW = (x) => Math.min(0.9, Math.max(0.1, x));
  const ha = clampW(a); const hb = clampW(b);
  const log5 = (ha - ha * hb) / (ha + hb - 2 * ha * hb);
  const edge = { nfl: 0.03, nba: 0.03, wnba: 0.03, mlb: 0.02, nhl: 0.02 }[sport] ?? 0.02;
  const pHome = clamp(0.5 + (log5 - 0.5) * 0.6 + edge);
  return { home: pHome, draw: null, away: 1 - pHome };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Ready-made baseline fetchers on the browser's global fetch (what templates.buildDailyMarkets uses by default). */
export const defaultFetchers = createFetchers();
export const fetchers = defaultFetchers;

// ---------------------------------------------------------------- evidence links

/**
 * A URL (<= 300 chars) anybody can open to check an oracle result: the exact keyless API request, or a
 * human page (USGS event page when `data` contains the qualifying event). Returns null when there is none.
 */
export function evidenceUrl(oracle, market, data = null) {
  try {
    if (!isObj(oracle)) return null;
    const p = oracle.params || {};
    let url = null;
    switch (oracle.type) {
      case 'price_above':
        url = urls.candles(p.symbol, 60, p.at - 15 * MIN_MS, p.at + 10 * MIN_MS);
        break;
      case 'price_move':
        url = urls.candles(p.symbol, 3600, Math.floor(market.openedAt / HOUR_MS) * HOUR_MS, Math.min(market.expiresAt ?? Infinity, Math.floor(market.openedAt / HOUR_MS) * HOUR_MS + 299 * HOUR_MS));
        break;
      case 'quake': {
        const hit = isObj(data) && Array.isArray(data.features)
          ? data.features.filter((f) => f?.properties && toNum(f.properties.mag) >= p.minMag && toNum(f.properties.time) >= market.openedAt)
            .sort((a, b) => a.properties.time - b.properties.time)[0]
          : null;
        url = hit && hit.properties.url ? String(hit.properties.url) : urls.quakes(p.minMag, market.openedAt);
        break;
      }
      case 'weather':
        url = urls.weather(p);
        break;
      case 'wiki_battle':
        url = `https://pageviews.wmcloud.org/?project=${encodeURIComponent(p.project || 'en.wikipedia')}.org&platform=all-access&agent=user&redirects=0&start=${p.date}&end=${p.date}&pages=${encodeURIComponent(`${p.a.article}|${p.b.article}`)}`;
        break;
      case 'sports':
        url = p.sport === 'soccer'
          ? `https://www.espn.com/soccer/match/_/gameId/${p.eventId}`
          : `https://www.espn.com/${p.league}/game/_/gameId/${p.eventId}`;
        break;
      default:
        return null;
    }
    return typeof url === 'string' && url.length <= 300 ? url : null;
  } catch {
    return null;
  }
}

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TEMPLATES, PLAIN_TEMPLATE_LIST, ORACLE_TEMPLATE_LIST, FEATURED_TEMPLATE_IDS, pickDailyTemplates, buildAutoMarket, dailyMarkets,
  buildDailyMarkets, expectedHouseMarket, checkHouseMarket, probBuckets, rateBuckets, oddsFor, nextUtcMidnight, localMidnight,
  localDateStr, findTemplate,
} from '../js/templates.js';
import {
  HOUR_MS, DAY_MS, MIN_FIXED_ODDS, MAX_FIXED_ODDS, isBettingOpen, validateBet, newPlayer, finalizeOutcome, validateCreateMarket,
  timerBucketFor, mulberry32,
} from '../js/economy.js';
import { evaluate, parseScoreboard, evidenceUrl, defaultFetchers, fetchers as fetchersAlias } from '../js/oracles.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0); // 2026-09-30 12:00Z
const KEY = '2026-09-30';
const ODDS_OK = (o) => typeof o === 'number' && o >= MIN_FIXED_ODDS && o <= MAX_FIXED_ODDS;
const oddsOf = (m, id) => (m.oddsById ? m.oddsById[id] : m.options.find((o) => o.id === id).odds);

/** Baseline fetchers with plausible data for every template family. */
function goodFetchers(now = NOW, over = {}) {
  const hashViews = (article) => 100_000 + (Array.from(article).reduce((s, c) => s + c.charCodeAt(0), 0) % 17) * 1_000;
  return {
    spot: async (symbol) => ({ 'BTC-USD': 64013.51, 'ETH-USD': 2498.32, 'SOL-USD': 148.77 })[symbol],
    forecast: async ({ tz }) => (tz === 'America/New_York' || tz === 'America/Chicago' || tz === 'Europe/Paris'
      ? { tmax: 19.3, precipSum: 0, precipProb: 8 } : { tmax: 15.4, precipSum: 2.1, precipProb: 62 }),
    wikiViews: async ({ article }) => Array(7).fill(hashViews(article)),
    scoreboard: async (sport, league) => {
      const src = sport === 'soccer' ? 'espn-scoreboard-epl-pre.json' : 'espn-scoreboard-nba-pre.json';
      return parseScoreboard(fx(src)).map((e, i) => ({ ...e, startAt: now + (10 + i) * HOUR_MS }));
    },
    ...over,
  };
}
const failing = (msg = 'offline') => ({
  spot: async () => { throw new Error(msg); },
  forecast: async () => { throw new Error(msg); },
  wikiViews: async () => { throw new Error(msg); },
  scoreboard: async () => { throw new Error(msg); },
});

describe('template catalogue', () => {
  test('counts: >= 20 plain, >= 10 oracle, unique ids, valid shapes', () => {
    assert.ok(PLAIN_TEMPLATE_LIST.length >= 20, `${PLAIN_TEMPLATE_LIST.length} plain`);
    assert.ok(ORACLE_TEMPLATE_LIST.length >= 10, `${ORACLE_TEMPLATE_LIST.length} oracle`);
    assert.equal(TEMPLATES.length, PLAIN_TEMPLATE_LIST.length + ORACLE_TEMPLATE_LIST.length);
    const ids = TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of TEMPLATES) {
      assert.match(t.id, /^[a-z0-9-]+$/, t.id);
      assert.ok(['timer', 'choice'].includes(t.kind), t.id);
      for (const f of ['category', 'emoji', 'title', 'description']) {
        assert.equal(typeof t[f], 'string', `${t.id}.${f}`);
        assert.ok(t[f].trim().length > 0, `${t.id}.${f}`);
      }
      assert.ok(t.title.length >= 3 && t.title.length <= 140, t.id);
      if (t.closeHours !== undefined && t.closeHours !== null) assert.ok(t.closeHours > 0, t.id);
      assert.equal(!!t.oracle, ORACLE_TEMPLATE_LIST.includes(t), t.id);
    }
  });

  test('category coverage', () => {
    const cats = new Set(TEMPLATES.map((t) => t.category));
    for (const c of ['Politics', 'Tech/AI', 'Sports', 'Crypto', 'Weird news', 'Weather', 'Wikipedia']) assert.ok(cats.has(c), `missing ${c}`);
    assert.ok([...cats].some((c) => /friend/i.test(c)));
  });

  test('QUALITY LINT: every plain template has "Counts if:" criteria and asks for an evidence link', () => {
    for (const t of PLAIN_TEMPLATE_LIST) {
      assert.match(t.description, /Counts if: /, `${t.id} missing "Counts if:"`);
      assert.match(t.description, /Evidence link required: /, `${t.id} missing evidence request`);
      assert.match(t.description, /link/i, t.id);
      const criteria = t.description.split('Counts if: ')[1];
      assert.ok(criteria.length > 60, `${t.id} criteria too thin`);
      assert.ok(t.description.length <= 700, `${t.id} description too long`);
    }
  });

  test('QUALITY LINT: no vague crowd-pleasers ("a celebrity", "a politician") and no placeholders', () => {
    for (const t of TEMPLATES) {
      const text = `${t.title} ${t.description}`;
      assert.doesNotMatch(text, /\ba (celebrity|politician|billionaire|tech CEO)\b/i, t.id);
      assert.doesNotMatch(text, /\b(TODO|lorem|undefined|null|NaN)\b|\{[a-z]+\}/i, t.id);
      assert.doesNotMatch(t.title, /^(How long till|Will) .* {2,}/, t.id);
    }
  });

  test('oracle templates describe how they settle', () => {
    for (const t of ORACLE_TEMPLATE_LIST) {
      assert.match(t.description, /Settles automatically/, t.id);
      for (const fn of ['baseline', 'render', 'validate']) assert.equal(typeof t.oracle[fn], 'function', `${t.id}.${fn}`);
      assert.ok(['price_above', 'price_move', 'quake', 'weather', 'wiki_battle', 'sports'].includes(t.oracle.type), t.id);
    }
    const types = new Set(ORACLE_TEMPLATE_LIST.map((t) => t.oracle.type));
    assert.equal(types.size, 6);
  });

  test('trump-constitution has objective criteria', () => {
    const t = findTemplate('trump-constitution');
    assert.ok(t);
    assert.equal(t.kind, 'timer');
    assert.equal(t.category, 'Politics');
    assert.doesNotMatch(t.title, /violates the constitution/i);
    assert.match(t.title, /^How long till a court says a Trump action is unconstitutional\?$/);
    assert.match(t.description, /federal court/);
    assert.match(t.description, /unconstitutional/);
    assert.match(t.description, /constitutional grounds/);
    assert.match(t.description, /Counts if: /);
    assert.match(t.description, /ruling/);
    assert.match(t.description, /Evidence link required/);
  });

  test('friend-group bankruptcy template exists and is settled from in-game data', () => {
    const t = findTemplate('friends-bankrupt');
    assert.equal(t.title, 'How long till one of us goes bankrupt?');
    assert.match(t.description, /Players list/);
  });

  test('timer titles start with "How long till"; every choice title is a question', () => {
    for (const t of TEMPLATES.filter((x) => x.kind === 'timer')) assert.match(t.title, /^How long till .+\?$/, t.id);
    for (const t of TEMPLATES.filter((x) => x.kind === 'choice')) assert.match(t.title, /\?$/, t.id);
  });

  test('timer buckets: contiguous, first from 0, last open-ended, sooner pays more, odds in bounds', () => {
    const timers = TEMPLATES.filter((x) => x.kind === 'timer');
    assert.ok(timers.length >= 20);
    for (const t of timers) {
      const b = t.buckets;
      assert.ok(Array.isArray(b) && b.length >= 3 && b.length <= 6, t.id);
      assert.equal(new Set(b.map((o) => o.id)).size, b.length, `${t.id} unique bucket ids`);
      assert.equal(b[0].fromDays, 0, t.id);
      assert.equal(b[b.length - 1].toDays, null, t.id);
      assert.equal(b[b.length - 1].id, 'never', t.id);
      for (let i = 0; i < b.length; i++) {
        assert.equal(typeof b[i].label, 'string', t.id);
        assert.doesNotMatch(b[i].label, /NaN|undefined/, t.id);
        assert.ok(ODDS_OK(b[i].odds), `${t.id} odds ${b[i].odds}`);
        if (i > 0) {
          assert.equal(b[i].fromDays, b[i - 1].toDays, `${t.id} bucket ${i} contiguous`);
          assert.ok(b[i].odds < b[i - 1].odds, `${t.id} odds must fall as buckets get later`);
        }
        if (i < b.length - 1) assert.ok(b[i].toDays > b[i].fromDays, `${t.id} bucket ${i} non-empty`);
      }
      const implied = b.reduce((s, o) => s + 1 / o.odds, 0);
      assert.ok(implied >= 1.0 && implied <= 1.7, `${t.id} implied ${implied.toFixed(2)}`);
      assert.ok(t.closeHours > 0 && t.closeHours <= 12, t.id);
    }
  });

  test('choice options: 2-6, unique ids, odds in bounds, a small house edge, favourites are cheaper', () => {
    for (const t of PLAIN_TEMPLATE_LIST.filter((x) => x.kind === 'choice')) {
      assert.ok(t.options.length >= 2 && t.options.length <= 6, t.id);
      assert.equal(new Set(t.options.map((o) => o.id)).size, t.options.length, t.id);
      for (const o of t.options) {
        assert.equal(typeof o.label, 'string', t.id);
        assert.ok(ODDS_OK(o.odds), `${t.id}/${o.id}`);
      }
      const implied = t.options.reduce((s, o) => s + 1 / o.odds, 0);
      assert.ok(implied >= 1 && implied <= 1.15, `${t.id} implied ${implied.toFixed(3)}`);
      assert.ok(new Set(t.options.map((o) => o.odds)).size > 1, t.id);
    }
    assert.ok(PLAIN_TEMPLATE_LIST.filter((x) => x.kind === 'choice').length >= 3);
  });

  test('bucket builders', () => {
    const b = rateBuckets(0.5, [3, 12, 24]);
    assert.deepEqual(b.map((x) => x.id), ['h3', 'h12', 'h24', 'never']);
    assert.deepEqual(b.map((x) => x.label), ['Within 3 hours', '3–12 hours', '12–24 hours', '24+ hours']);
    const w = probBuckets([24, 72, 168], [0.05, 0.22, 0.31]);
    assert.deepEqual(w.map((x) => x.label), ['Within 1 day', '1–3 days', '3–7 days', '7+ days']);
    assert.deepEqual(w.map((x) => x.toDays), [1, 3, 7, null]);
    assert.ok(w[0].odds > w[1].odds && w[1].odds > w[2].odds && w[2].odds > w[3].odds);
    assert.equal(oddsFor(0.5), 1.85);
    assert.equal(oddsFor(0.001), 20);
    assert.equal(oddsFor(0.999), 1.05);
  });
});

describe('pickDailyTemplates / dailyMarkets (sync, plain templates only)', () => {
  test('deterministic, distinct, plain-only', () => {
    assert.deepEqual(pickDailyTemplates(KEY).map((t) => t.id), pickDailyTemplates(KEY).map((t) => t.id));
    for (let d = 1; d <= 60; d++) {
      const key = `2026-07-${String(d).padStart(2, '0')}`;
      const picks = pickDailyTemplates(key);
      assert.equal(picks.length, 4);
      assert.equal(new Set(picks.map((t) => t.id)).size, 4, key);
      for (const p of picks) assert.ok(PLAIN_TEMPLATE_LIST.includes(p) && !p.oracle);
    }
  });
  test('different days differ; count honoured / capped; TEMPLATES not mutated', () => {
    const sets = new Set();
    for (let d = 1; d <= 20; d++) sets.add(pickDailyTemplates(`2026-08-${String(d).padStart(2, '0')}`).map((t) => t.id).join(','));
    assert.ok(sets.size >= 15);
    assert.equal(pickDailyTemplates(KEY, 7).length, 7);
    assert.equal(pickDailyTemplates(KEY, 9999).length, PLAIN_TEMPLATE_LIST.length);
    const before = TEMPLATES.map((t) => t.id).join();
    pickDailyTemplates(KEY, 10);
    assert.equal(TEMPLATES.map((t) => t.id).join(), before);
  });
  test('over many days every plain template shows up', () => {
    const seen = new Set();
    for (let d = 0; d < 400; d++) for (const t of pickDailyTemplates(`day-${d}`)) seen.add(t.id);
    assert.equal(seen.size, PLAIN_TEMPLATE_LIST.length);
  });
  test('dailyMarkets: featured first, idempotent ids, featured every day', () => {
    const ms = dailyMarkets(KEY, NOW);
    assert.equal(ms.length, 4 + FEATURED_TEMPLATE_IDS.length);
    const ids = ms.map((m) => m.id);
    assert.deepEqual(ids.slice(0, FEATURED_TEMPLATE_IDS.length), FEATURED_TEMPLATE_IDS.map((id) => `auto-${KEY}-${id}`));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ms.every((m) => m.openedAt === NOW && !m.oracle));
    assert.deepEqual(dailyMarkets(KEY, NOW + 5000).map((m) => m.id), ids);
    assert.equal(dailyMarkets(KEY, NOW, 6).length, 6 + FEATURED_TEMPLATE_IDS.length);
    for (let d = 1; d <= 30; d++) {
      const key = `2026-09-${String(d).padStart(2, '0')}`;
      assert.ok(dailyMarkets(key, NOW).map((m) => m.id).includes(`auto-${key}-trump-constitution`));
    }
  });
});

describe('buildAutoMarket (plain templates): v2 fields', () => {
  test('trump-constitution timer market', () => {
    const t = findTemplate('trump-constitution');
    const m = buildAutoMarket(t, KEY, NOW);
    assert.equal(m.id, 'auto-2026-09-30-trump-constitution');
    assert.equal(m.type, 'auto');
    assert.equal(m.templateId, 'trump-constitution');
    assert.equal(m.kind, 'timer');
    assert.equal(m.mode, 'fixed');
    assert.equal(m.createdBy, 'house');
    assert.equal(m.createdByName, 'The House');
    assert.equal(m.openedAt, NOW);
    assert.equal(m.closesAt, NOW + 6 * HOUR_MS);
    assert.equal(m.status, 'open');
    assert.equal(m.oracle, null);
    assert.deepEqual(m.optionIds, ['h3', 'h12', 'h24', 'never']);
    assert.deepEqual(Object.keys(m.oddsById), m.optionIds);
    assert.deepEqual(m.bucketsById.h3, { fromMs: 0, toMs: 3 * HOUR_MS });
    assert.deepEqual(m.bucketsById.never, { fromMs: DAY_MS, toMs: null });
    assert.equal(m.expiresAt, NOW + DAY_MS);
    assert.equal(m.expiryOptionId, 'never');
    assert.equal(m.reportableAt, NOW);
    assert.deepEqual(m.optionTotals, { h3: 0, h12: 0, h24: 0, never: 0 });
    assert.equal(m.totalPool, 0);
    assert.equal(m.resolvedOptionId, null);
    assert.equal(m.title, t.title);
  });

  test('choice market: reportable at close, no buckets/expiry', () => {
    const m = buildAutoMarket(findTemplate('markets-sp500-direction'), KEY, NOW);
    assert.equal(m.kind, 'choice');
    assert.equal(m.mode, 'fixed');
    assert.equal(m.bucketsById, null);
    assert.equal(m.expiresAt, null);
    assert.equal(m.expiryOptionId, null);
    assert.equal(m.reportableAt, m.closesAt);
    assert.deepEqual(m.oddsById, { up: 1.85, down: 2.05 });
  });

  test('every plain template builds a bettable, resolvable, valid house market without sharing state', () => {
    const player = newPlayer('u', 'name', NOW);
    for (const t of PLAIN_TEMPLATE_LIST) {
      const m = buildAutoMarket(t, KEY, NOW);
      assert.equal(m.id, `auto-${KEY}-${t.id}`);
      assert.equal(m.oracle, null);
      assert.equal(isBettingOpen(m, NOW), true, t.id);
      assert.equal(isBettingOpen(m, m.closesAt), false, t.id);
      assert.equal(validateBet(player, m, m.optionIds[0], 10, NOW), null, t.id);
      assert.equal(validateCreateMarket(player, m, NOW), null, t.id);
      assert.deepEqual(Object.keys(m.optionTotals), m.optionIds, t.id);
      for (const id of m.optionIds) assert.ok(ODDS_OK(m.oddsById[id]), t.id);
      if (t.kind === 'timer') {
        assert.equal(timerBucketFor(m, NOW), m.optionIds[0]);
        assert.equal(finalizeOutcome(m, m.expiresAt - 1), null, t.id);
        assert.deepEqual(finalizeOutcome(m, m.expiresAt), { status: 'resolved', resolvedOptionId: 'never', eventAt: null }, t.id);
        assert.equal(m.reportableAt, NOW);
      } else {
        assert.equal(m.reportableAt, m.closesAt);
      }
      m.options[0].odds = 999;
      assert.notEqual(buildAutoMarket(t, KEY, NOW).options[0].odds, 999, `${t.id} options must be copies`);
    }
  });

  test('oracle templates refuse to build without baseline params', () => {
    assert.throws(() => buildAutoMarket(ORACLE_TEMPLATE_LIST[0], KEY, NOW), /baseline/);
  });
});

describe('every oracle template with a working baseline', () => {
  const build = async (t, key = KEY, now = NOW, fetchers = goodFetchers(now)) => {
    const rand = () => 0.37;
    const params = await t.oracle.baseline({ dateKey: key, now, fetchers, rand });
    return params ? buildAutoMarket(t, key, now, params) : null;
  };

  test('builds valid v2 markets: odds/bounds/implied probability/timing', async () => {
    const built = new Set();
    for (const t of ORACLE_TEMPLATE_LIST) {
      const m = await build(t);
      if (!m) { assert.ok(false, `${t.id} produced no market with good fetchers`); continue; }
      built.add(t.id);
      assert.equal(m.templateId, t.id);
      assert.equal(m.createdBy, 'house');
      assert.equal(m.oracle.type, t.oracle.type);
      assert.ok(m.oracle.source && m.oracle.label && m.oracle.params, t.id);
      assert.ok(m.title.length >= 10 && m.title.length <= 140, `${t.id}: ${m.title}`);
      assert.doesNotMatch(`${m.title} ${m.description} ${m.options.map((o) => o.label)}`, /\b(NaN|undefined|null)\b|\[object/, t.id);
      assert.match(m.description, /Settles automatically/);
      assert.ok(m.closesAt > NOW + 30 * 60_000, `${t.id} closes too soon`);
      assert.ok(m.options.length >= 2 && m.options.length <= 6, t.id);
      for (const id of m.optionIds) assert.ok(ODDS_OK(m.oddsById[id]), `${t.id}/${id}: ${m.oddsById[id]}`);
      const implied = m.optionIds.reduce((s, id) => s + 1 / m.oddsById[id], 0);
      assert.ok(implied >= 1.0 && implied <= 1.75, `${t.id} implied ${implied.toFixed(3)}`);
      assert.equal(validateCreateMarket(newPlayer('u', 'n', NOW), m, NOW), null, t.id);
      assert.equal(checkHouseMarket(m), null, t.id);
      if (m.kind === 'timer') {
        assert.equal(m.reportableAt, NOW, t.id);
        assert.ok(m.bucketsById && m.expiresAt && m.expiryOptionId === 'never', t.id);
        assert.equal(m.closesAt - NOW, t.closeHours * HOUR_MS, t.id);
      } else {
        assert.equal(m.reportableAt, m.oracle.params.at, t.id);
        assert.ok(m.reportableAt >= m.closesAt, `${t.id} must not be reportable before betting closes`);
        assert.ok(m.reportableAt > NOW + HOUR_MS, t.id);
        assert.equal(m.bucketsById, null);
      }
    }
    assert.equal(built.size, ORACLE_TEMPLATE_LIST.length);
  });

  test('deterministic for the same inputs', async () => {
    for (const t of ORACLE_TEMPLATE_LIST) assert.deepEqual(await build(t), await build(t), t.id);
  });

  test('price_above: threshold sits near spot, odds follow the distance', async () => {
    const t = findTemplate('oracle-btc-above');
    const at = Date.UTC(2026, 9, 1);
    const seen = new Set();
    for (let d = 1; d <= 40; d++) {
      const key = `2026-09-${String((d % 28) + 1).padStart(2, '0')}`;
      const params = await t.oracle.baseline({ dateKey: key, now: NOW, fetchers: goodFetchers(), rand: mulberry32(d * 7919) });
      assert.equal(params.at, at);
      assert.equal(params.spot, 64013.51);
      assert.ok(Math.abs(params.threshold / params.spot - 1) < 0.02, `${params.threshold}`);
      assert.equal(params.threshold % 200, 0, 'rounded to a sensible step');
      seen.add(params.threshold);
    }
    assert.ok(seen.size >= 2, 'thresholds should vary between days');
    const render = (threshold) => t.oracle.render({ symbol: 'BTC-USD', coin: 'Bitcoin', spot: 100000, threshold, at }, { openedAt: NOW });
    const near = render(100000);
    const far = render(101500);
    const below = render(98500);
    assert.ok(far.options[0].odds > near.options[0].odds, 'yes pays more when the threshold is far above spot');
    assert.ok(far.options[1].odds < near.options[1].odds);
    assert.ok(below.options[0].odds < near.options[0].odds);
    assert.ok(Math.abs(near.options[0].odds - near.options[1].odds) <= 0.15, 'at the money is a coin flip');
    assert.match(near.title, /^Will Bitcoin close above \$100,000 at 00:00 UTC on Oct 1\?$/);
    assert.match(near.description, /1-minute BTC-USD candle before 00:00 UTC Oct 1/);
  });

  test('price_above end to end with the Coinbase fixture', async () => {
    const t = findTemplate('oracle-btc-above');
    const m = await build(t);
    assert.equal(m.oracle.params.at, Date.UTC(2026, 9, 1));
    const r = evaluate(m.oracle, { candles: fx('coinbase-candles-btc-1m.json'), granularity: 60 }, m);
    assert.equal(r.status, 'final');
    assert.equal(r.optionId, m.oracle.params.threshold < 64230.15 ? 'yes' : 'no');
    assert.ok(m.optionIds.includes(r.optionId));
  });

  test('price_move end to end: base = spot, bucket comes from the market', async () => {
    const t = findTemplate('oracle-btc-move-5');
    const m = await build(t);
    assert.equal(m.oracle.params.base, 64014);
    assert.match(m.title, /^How long till Bitcoin moves ±5% from \$64,014\?$/);
    m.oracle.params.base = 64013; // the fixture was generated for 64013
    const data = { series: [{ granularity: 300, candles: fx('coinbase-candles-btc-5m.json') }, { granularity: 3600, candles: fx('coinbase-candles-btc-1h.json') }] };
    const r = evaluate(m.oracle, data, m);
    assert.deepEqual(r, { status: 'final', optionId: 'h24', eventAt: Date.UTC(2026, 8, 30, 19, 35) });
    assert.equal(m.expiresAt - NOW, 7 * DAY_MS);
    assert.equal(findTemplate('oracle-btc-move-10').buckets.at(-1).fromDays, 14);
  });

  test('quake end to end', async () => {
    const m = await build(findTemplate('oracle-quake-65'));
    assert.equal(m.title, 'How long till an M6.5+ earthquake anywhere?');
    const r = evaluate(m.oracle, fx('usgs-quakes.json'), m);
    assert.equal(r.status, 'final');
    assert.equal(r.optionId, timerBucketFor(m, r.eventAt));
    assert.equal(r.optionId, 'd3');
    assert.equal(findTemplate('oracle-quake-70').title, 'How long till an M7.0+ earthquake anywhere?');
  });

  test('weather: rain odds follow the forecast; dates/times are city-local', async () => {
    const t = findTemplate('oracle-rain-london');
    const wet = await build(t, KEY, NOW, goodFetchers(NOW, { forecast: async () => ({ tmax: 14, precipSum: 6, precipProb: 95 }) }));
    const dry = await build(t, KEY, NOW, goodFetchers(NOW, { forecast: async () => ({ tmax: 14, precipSum: 0, precipProb: 3 }) }));
    assert.ok(wet.oddsById.yes < dry.oddsById.yes);
    assert.ok(wet.oddsById.no > dry.oddsById.no);
    assert.equal(wet.oracle.params.date, '2026-10-01');
    // reportable 3h after London's local day (BST, UTC+1) ends: 2026-10-01 23:00Z + 24h... = 2026-10-02T02:00Z
    assert.equal(wet.reportableAt, Date.UTC(2026, 9, 2, 2, 0));
    assert.equal(wet.closesAt, NOW + 6 * HOUR_MS);
    assert.match(wet.title, /^Will it rain in London on Thu Oct 1\?$/);
    const r = evaluate(wet.oracle, { ...fx('openmeteo-london-wet.json'), asOf: wet.reportableAt }, wet);
    assert.equal(r.optionId, 'yes');
    // close to midnight the "tomorrow" jumps a day so betting never closes before it opens
    const late = Date.UTC(2026, 8, 30, 22, 30);
    const m2 = await build(t, KEY, late, goodFetchers(late));
    assert.equal(m2.oracle.params.date, '2026-10-02');
    assert.ok(m2.closesAt > late);
  });

  test('weather: temperature threshold hugs the forecast', async () => {
    const t = findTemplate('oracle-temp-nyc');
    for (let i = 0; i < 12; i++) {
      const rand = mulberry32(i * 104729 + 3);
      const params = await t.oracle.baseline({ dateKey: KEY, now: NOW, fetchers: goodFetchers(), rand });
      assert.ok(Math.abs(params.threshold - 19.3) <= 3);
      assert.equal(params.metric, 'tmax');
    }
    const m = await build(t);
    const r = evaluate(m.oracle, { ...fx('openmeteo-nyc-warm.json'), asOf: m.reportableAt }, m);
    assert.equal(r.optionId, m.oracle.params.threshold <= 21.4 ? 'yes' : 'no');
    assert.match(m.title, /^Will New York hit \d+°C on Thu Oct 1\?$/);
  });

  test('wiki: lopsided battles and tiny (wrong-title) articles are skipped, fair ones priced by ratio', async () => {
    const t = findTemplate('oracle-wiki-swift-musk'.replace('oracle-', ''));
    assert.ok(t, 'template id');
    const even = await build(t);
    assert.ok(even.oddsById.a > 1.5 && even.oddsById.b > 1.5);
    const tiny = await build(t, KEY, NOW, goodFetchers(NOW, { wikiViews: async () => Array(7).fill(120) }));
    assert.equal(tiny, null);
    const lopsided = await build(t, KEY, NOW, goodFetchers(NOW, { wikiViews: async ({ article }) => Array(7).fill(article === 'Taylor_Swift' ? 900_000 : 90_000) }));
    assert.equal(lopsided, null);
    const leaning = await build(t, KEY, NOW, goodFetchers(NOW, { wikiViews: async ({ article }) => Array(7).fill(article === 'Taylor_Swift' ? 130_000 : 100_000) }));
    assert.ok(leaning.oddsById.a < leaning.oddsById.b, 'the article expected to win pays less');
    assert.equal(leaning.oracle.params.date, '2026-10-01');
    assert.equal(leaning.closesAt, NOW + 12 * HOUR_MS);
    assert.equal(leaning.reportableAt, Date.UTC(2026, 9, 2, 6));
    const r = evaluate(leaning.oracle, { a: fx('wikimedia-swift-20261001.json'), b: fx('wikimedia-musk-20261001.json') }, leaning);
    assert.equal(r.optionId, 'a');
  });

  test('sports: game picked from the schedule, priced from the line, settles from the final score', async () => {
    const t = findTemplate('sports-nba');
    const m = await build(t, '2026-10-01', Date.UTC(2026, 9, 1, 12), goodFetchers(Date.UTC(2026, 9, 1, 12)));
    const now = Date.UTC(2026, 9, 1, 12);
    assert.ok(m, 'nba market');
    assert.equal(m.category, 'Sports');
    assert.match(m.title, /^Who wins: .+ at .+\?$/);
    assert.deepEqual(m.optionIds, ['home', 'away']);
    assert.equal(m.closesAt, m.oracle.params.startAt - 5 * 60_000);
    assert.equal(m.reportableAt, m.oracle.params.startAt + 100 * 60_000);
    assert.ok(m.oracle.params.startAt > now);
    // pricing from real moneylines in the fixture (Knicks +155 vs Celtics -185): the home team is the underdog
    if (m.oracle.params.eventId === '401800001') {
      assert.ok(m.oddsById.home > m.oddsById.away);
      const r = evaluate(m.oracle, fx('espn-scoreboard-nba-final.json'), m);
      assert.deepEqual(r, { status: 'final', optionId: 'away', eventAt: null });
    }
    const soccer = await build(findTemplate('sports-epl'), '2026-10-01', now, goodFetchers(now));
    assert.deepEqual(soccer.optionIds, ['home', 'draw', 'away']);
    assert.match(soccer.title, /^Who wins: .+ vs .+\?$/);
    const implied = soccer.optionIds.reduce((s, id) => s + 1 / soccer.oddsById[id], 0);
    assert.ok(implied > 1 && implied < 1.15);
  });

  test('sports: games too soon / too far / not "pre" / no usable line are skipped', async () => {
    const t = findTemplate('sports-nba');
    const now = Date.UTC(2026, 9, 1, 12);
    const shift = (fn) => goodFetchers(now, { scoreboard: async () => parseScoreboard(fx('espn-scoreboard-nba-pre.json')).map(fn) });
    assert.equal(await build(t, '2026-10-01', now, shift((e) => ({ ...e, startAt: now + 10 * 60_000 }))), null);
    assert.equal(await build(t, '2026-10-01', now, shift((e) => ({ ...e, startAt: now + 40 * HOUR_MS }))), null);
    assert.equal(await build(t, '2026-10-01', now, shift((e) => ({ ...e, startAt: now + 5 * HOUR_MS, state: 'in' }))), null);
    assert.equal(await build(t, '2026-10-01', now, goodFetchers(now, { scoreboard: async () => [] })), null);
    assert.equal(await build(findTemplate('sports-epl'), '2026-10-01', now, shift((e) => ({ ...e, startAt: now + 5 * HOUR_MS, odds: null }))), null, 'no 3-way price');
  });
});

describe('buildDailyMarkets', () => {
  const KEY2 = '2026-10-01';
  const NOW2 = Date.UTC(2026, 9, 1, 12);

  test('success: featured + 2 oracle (different types) + 2 plain, all v2-normalised', async () => {
    const ms = await buildDailyMarkets(KEY2, NOW2, { fetchers: goodFetchers(NOW2) });
    assert.equal(ms.length, 5);
    assert.equal(ms[0].id, `auto-${KEY2}-trump-constitution`);
    assert.ok(!ms[0].oracle);
    assert.ok(ms[1].oracle && ms[2].oracle);
    assert.notEqual(ms[1].oracle.type, ms[2].oracle.type);
    assert.ok(!ms[3].oracle && !ms[4].oracle);
    assert.equal(new Set(ms.map((m) => m.id)).size, 5);
    for (const m of ms) {
      assert.ok(m.id.startsWith(`auto-${KEY2}-`));
      assert.equal(m.openedAt, NOW2);
      assert.equal(m.createdBy, 'house');
      assert.deepEqual(m.optionIds, m.options.map((o) => o.id));
      assert.ok(m.oddsById && m.optionIds.every((id) => ODDS_OK(m.oddsById[id])));
      assert.ok(Number.isFinite(m.reportableAt));
      assert.ok(m.kind === 'timer' ? (m.bucketsById && m.expiresAt && m.expiryOptionId) : m.bucketsById === null);
      assert.equal(validateCreateMarket(newPlayer('u', 'n', NOW2), m, NOW2), null, m.id);
      assert.equal(checkHouseMarket(m), null, m.id);
    }
  });

  test('deterministic per dateKey given the same data; varies over days', async () => {
    const a = await buildDailyMarkets(KEY2, NOW2, { fetchers: goodFetchers(NOW2) });
    const b = await buildDailyMarkets(KEY2, NOW2, { fetchers: goodFetchers(NOW2) });
    assert.deepEqual(a, b);
    const idSets = new Set();
    const templates = new Set();
    for (let d = 1; d <= 25; d++) {
      const key = `2026-10-${String(d).padStart(2, '0')}`;
      const now = Date.UTC(2026, 9, d, 12);
      const ms = await buildDailyMarkets(key, now, { fetchers: goodFetchers(now) });
      assert.equal(ms.length, 5, key);
      assert.ok(ms.map((m) => m.id).includes(`auto-${key}-trump-constitution`), key);
      idSets.add(ms.map((m) => m.templateId).join());
      ms.filter((m) => m.oracle).forEach((m) => templates.add(m.templateId));
    }
    assert.ok(idSets.size >= 20);
    assert.ok(templates.size >= 15, `only ${templates.size} distinct oracle templates in 25 days`);
  });

  test('failing baselines are skipped: only fetch-free (earthquake) oracle markets remain', async () => {
    const ms = await buildDailyMarkets(KEY2, NOW2, { fetchers: failing() });
    assert.equal(ms.length, 5);
    const oracles = ms.filter((m) => m.oracle);
    assert.equal(oracles.length, 2);
    assert.ok(oracles.every((m) => m.oracle.type === 'quake'));
    const none = await buildDailyMarkets(KEY2, NOW2, { fetchers: {} });
    assert.equal(none.filter((m) => m.oracle).length, 2);
  });

  test('a failing template is replaced by another oracle template', async () => {
    // Make every crypto price fetch fail; the day's other templates must still fill both oracle slots.
    let sawSpotFailure = 0;
    const f = goodFetchers(NOW2, { spot: async () => { sawSpotFailure++; throw new Error('coinbase down'); } });
    for (let d = 1; d <= 20; d++) {
      const key = `2026-11-${String(d).padStart(2, '0')}`;
      const now = Date.UTC(2026, 10, d, 12);
      const ms = await buildDailyMarkets(key, now, { fetchers: { ...f, ...goodFetchers(now, { spot: f.spot }) } });
      const oracles = ms.filter((m) => m.oracle);
      assert.equal(oracles.length, 2, key);
      assert.ok(oracles.every((m) => !/^price_/.test(m.oracle.type)), `${key}: price market built despite failing spot`);
    }
    assert.ok(sawSpotFailure > 0, 'the price templates were attempted at least once');
  });

  test('when nothing works, oracleCount larger than what is available just returns what exists', async () => {
    const ms = await buildDailyMarkets(KEY2, NOW2, { fetchers: failing(), oracleCount: 30, maxOracleAttempts: 100 });
    assert.equal(ms.filter((m) => m.oracle).length, 3); // the three earthquake templates need no baseline
  });

  test('a baseline returning garbage is rejected by validation, never thrown', async () => {
    const ms = await buildDailyMarkets(KEY2, NOW2, { fetchers: goodFetchers(NOW2, { spot: async () => NaN, forecast: async () => ({}), wikiViews: async () => [], scoreboard: async () => null }) });
    assert.equal(ms.length, 5);
    assert.ok(ms.filter((m) => m.oracle).every((m) => m.oracle.type === 'quake'));
  });

  test('default fetchers exist and are exported for the app', () => {
    assert.equal(defaultFetchers, fetchersAlias);
    for (const fn of ['spot', 'forecast', 'wikiViews', 'scoreboard']) assert.equal(typeof defaultFetchers[fn], 'function');
  });
});

describe('expectedHouseMarket / checkHouseMarket (tamper detection)', () => {
  const build = async (id) => {
    const t = findTemplate(id);
    const params = await t.oracle.baseline({ dateKey: KEY, now: NOW, fetchers: goodFetchers(), rand: () => 0.5 });
    return buildAutoMarket(t, KEY, NOW, params);
  };

  test('plain markets rebuild identically', () => {
    for (const t of PLAIN_TEMPLATE_LIST) {
      const m = buildAutoMarket(t, KEY, NOW);
      assert.deepEqual(expectedHouseMarket(m), m, t.id);
      assert.equal(checkHouseMarket(m), null);
    }
  });

  test('oracle markets rebuild identically from their stored params (no network)', async () => {
    for (const id of ['oracle-btc-above', 'oracle-btc-move-5', 'oracle-quake-65', 'oracle-rain-london', 'oracle-temp-nyc', 'wiki-swift-musk']) {
      const m = await build(id.replace(/^oracle-wiki/, 'wiki'));
      assert.deepEqual(expectedHouseMarket(m), m, id);
      assert.equal(checkHouseMarket(m), null, id);
    }
  });

  test('flags tampered odds, titles, buckets, timing, params and unknown templates', async () => {
    const plain = buildAutoMarket(findTemplate('friends-whale'), KEY, NOW);
    const tweak = (m, fn) => { const c = structuredClone(m); fn(c); return c; };
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.oddsById.h24 = 19; })), /Odds/);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.options[0].odds = 19; m.oddsById[m.options[0].id] = 19; })), /Odds/);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.title = 'Free money'; })), /Title/);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.bucketsById.h24.toMs += 1; })), /bucket/i);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.closesAt += 60 * DAY_MS; })), /window|Closing/i);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.expiresAt = m.openedAt + HOUR_MS; })), /Expiry/);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.reportableAt = m.openedAt - 1; })), /Reportable/);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.templateId = 'nope'; })), /Unknown/);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.id = 'auto-2026-09-30-friends-plans'; })), /Unknown/);
    assert.match(checkHouseMarket(tweak(plain, (m) => { m.createdBy = 'someone'; })), /Unknown/);
    assert.equal(expectedHouseMarket(null), null);
    assert.equal(expectedHouseMarket({}), null);

    const btc = await build('oracle-btc-above');
    assert.match(checkHouseMarket(tweak(btc, (m) => { m.oracle.params.at += HOUR_MS; })), /./);
    assert.match(checkHouseMarket(tweak(btc, (m) => { m.oracle.params.threshold = Math.round(m.oracle.params.spot * 1.4); })), /Unknown|invalid/i);
    assert.match(checkHouseMarket(tweak(btc, (m) => { m.oracle.params.threshold += 1000; })), /./);
    assert.match(checkHouseMarket(tweak(btc, (m) => { m.oddsById.yes = 19; })), /Odds/);
    assert.match(checkHouseMarket(tweak(btc, (m) => { m.oracle = null; })), /Unknown/);
    assert.match(checkHouseMarket(tweak(btc, (m) => { m.oracle.type = 'quake'; })), /Unknown/);
    assert.match(checkHouseMarket(tweak(btc, (m) => { m.oracle.params.symbol = 'ETH-USD'; })), /Unknown/);
    const rain = await build('oracle-rain-london');
    assert.match(checkHouseMarket(tweak(rain, (m) => { m.oracle.params.pYes = 0.99; })), /Unknown|invalid/i);
    assert.match(checkHouseMarket(tweak(rain, (m) => { m.oracle.params.date = '2026-10-05'; })), /./);
    const q = await build('oracle-quake-65');
    assert.match(checkHouseMarket(tweak(q, (m) => { m.oracle.params.minMag = 5; })), /Unknown|invalid/i);
  });
});

describe('helpers', () => {
  test('nextUtcMidnight', () => {
    assert.equal(nextUtcMidnight(NOW), Date.UTC(2026, 9, 1));
    assert.equal(nextUtcMidnight(NOW, 13 * HOUR_MS), Date.UTC(2026, 9, 2));
    assert.equal(nextUtcMidnight(Date.UTC(2026, 9, 1)), Date.UTC(2026, 9, 2));
  });
  test('local midnight / date in an IANA zone', () => {
    assert.equal(localMidnight('2026-10-01', 'Europe/London'), Date.UTC(2026, 8, 30, 23));
    assert.equal(localMidnight('2026-10-01', 'America/New_York'), Date.UTC(2026, 9, 1, 4));
    assert.equal(localMidnight('2026-10-01', 'Asia/Tokyo'), Date.UTC(2026, 8, 30, 15));
    assert.equal(localMidnight('2026-10-01', 'Australia/Sydney'), Date.UTC(2026, 8, 30, 14));
    assert.equal(localMidnight('2026-12-01', 'Europe/London'), Date.UTC(2026, 11, 1));
    assert.equal(localDateStr(Date.UTC(2026, 8, 30, 23, 30), 'Europe/London'), '2026-10-01');
    assert.equal(localDateStr(Date.UTC(2026, 8, 30, 23, 30), 'America/New_York'), '2026-09-30');
  });
  test('evidenceUrl gives short, checkable links for every oracle type', async () => {
    const m = await buildDailyMarkets('2026-10-01', Date.UTC(2026, 9, 1, 12), { fetchers: goodFetchers(Date.UTC(2026, 9, 1, 12)) });
    const oracles = m.filter((x) => x.oracle);
    for (const x of oracles) {
      const u = evidenceUrl(x.oracle, x, null);
      assert.match(u, /^https:\/\//, x.id);
      assert.ok(u.length <= 300, x.id);
    }
    const q = { oracle: { type: 'quake', params: { minMag: 6.5 } }, openedAt: NOW };
    assert.equal(evidenceUrl(q.oracle, q, fx('usgs-quakes.json')), 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000zzz1');
    assert.match(evidenceUrl(q.oracle, q, null), /earthquake\.usgs\.gov\/fdsnws/);
    assert.equal(evidenceUrl(null, {}), null);
    assert.equal(evidenceUrl({ type: 'mystery', params: {} }, {}), null);
  });
});

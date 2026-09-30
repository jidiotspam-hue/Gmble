import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluate, fetchOracleData, checkMarketOracle, createFetchers, makeOracle, describeOracle, sourceLabel, parseCandles,
  parseScoreboard, sportsProbabilities, bucketOptionId, wikiViewsOn, normCdf, urls, ORACLE_TYPES,
} from '../js/oracles.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const DAY = 86_400_000;
const HOUR = 3_600_000;
const OPEN = Date.UTC(2026, 8, 30, 12, 0, 0);
const AT = Date.UTC(2026, 9, 1, 0, 0, 0);
const isPending = (r) => r.status === 'pending';

const timerMarket = (extra = {}) => ({
  id: 'auto-2026-09-30-x', kind: 'timer', openedAt: OPEN, closesAt: OPEN + 6 * HOUR,
  bucketsById: { d1: { fromMs: 0, toMs: DAY }, d3: { fromMs: DAY, toMs: 3 * DAY }, d7: { fromMs: 3 * DAY, toMs: 7 * DAY }, never: { fromMs: 7 * DAY, toMs: null } },
  ...extra,
});

/** A fake fetch that answers by URL substring and records every call. */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [needle, body] of routes) {
      if (String(url).includes(needle)) {
        if (body instanceof Error) throw body;
        if (body && body.__status) return { ok: false, status: body.__status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => structuredClone(body) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

describe('price_above', () => {
  const oracle = (threshold) => ({ type: 'price_above', params: { symbol: 'BTC-USD', threshold, at: AT } });
  const data = () => ({ candles: fx('coinbase-candles-btc-1m.json'), granularity: 60 });

  test('final yes / no from the last candle before `at`', () => {
    assert.deepEqual(evaluate(oracle(64200), data(), {}), { status: 'final', optionId: 'yes', eventAt: null });
    assert.deepEqual(evaluate(oracle(64300), data(), {}), { status: 'final', optionId: 'no', eventAt: null });
  });

  test('strictly above: a close equal to the threshold is "no"', () => {
    assert.equal(evaluate(oracle(64230.15), data(), {}).optionId, 'no');
    assert.equal(evaluate(oracle(64230.14), data(), {}).optionId, 'yes');
  });

  test('raw array is accepted too', () => {
    assert.equal(evaluate(oracle(64200), fx('coinbase-candles-btc-1m.json'), {}).optionId, 'yes');
  });

  test('pending before `at` has been reached (no candle at/after `at`)', () => {
    const early = data();
    early.candles = early.candles.filter((c) => c[0] * 1000 < AT);
    assert.equal(early.candles.length, 15);
    assert.ok(isPending(evaluate(oracle(64200), early, {})));
  });

  test('pending when the last pre-`at` candle is too old (>15 min gap)', () => {
    const gap = data();
    gap.candles = gap.candles.filter((c) => c[0] * 1000 < AT - 20 * 60_000 || c[0] * 1000 >= AT);
    assert.ok(isPending(evaluate(oracle(64200), gap, {})));
  });

  test('pending on empty / malformed / null data and bad params', () => {
    assert.ok(isPending(evaluate(oracle(64200), { candles: [] }, {})));
    assert.ok(isPending(evaluate(oracle(64200), null, {})));
    assert.ok(isPending(evaluate(oracle(64200), undefined, {})));
    assert.ok(isPending(evaluate(oracle(64200), 'nope', {})));
    assert.ok(isPending(evaluate(oracle(64200), { candles: [[1], 'x', null, { a: 1 }, [1, 'a', 'b', 'c', 'd']] }, {})));
    assert.ok(isPending(evaluate({ type: 'price_above', params: {} }, data(), {})));
    assert.ok(isPending(evaluate({ type: 'price_above' }, data(), {})));
  });

  test('parseCandles sorts ascending, converts to ms and drops junk', () => {
    const cs = parseCandles([[120, 1, 3, 2, 3, 5], [60, '1', '2', '1', '2', 1], [30, 5, 1, 1, 1, 1], 'x'], 60);
    assert.deepEqual(cs.map((c) => c.t), [60_000, 120_000]);
    assert.equal(cs[0].close, 2);
  });
});

describe('price_move', () => {
  const oracle = (over = {}) => ({ type: 'price_move', params: { symbol: 'BTC-USD', base: 64013, pct: 5, ...over } });
  const both = () => ({ series: [{ granularity: 300, candles: fx('coinbase-candles-btc-5m.json') }, { granularity: 3600, candles: fx('coinbase-candles-btc-1h.json') }] });

  test('first crossing candle gives eventAt and its bucket (fine candles preferred)', () => {
    const r = evaluate(oracle(), both(), timerMarket());
    assert.deepEqual(r, { status: 'final', optionId: 'd1', eventAt: Date.UTC(2026, 8, 30, 19, 35) });
  });

  test('hourly-only data falls back to the hour start', () => {
    const r = evaluate(oracle(), { series: [{ granularity: 3600, candles: fx('coinbase-candles-btc-1h.json') }] }, timerMarket());
    assert.equal(r.eventAt, Date.UTC(2026, 8, 30, 19, 0));
    assert.equal(r.optionId, 'd1');
  });

  test('pending when nothing crossed yet (bigger pct)', () => {
    assert.ok(isPending(evaluate(oracle({ pct: 10 }), both(), timerMarket())));
  });

  test('boundary: high exactly at base*(1+pct) crosses, one cent below does not; same for the low side', () => {
    const t = OPEN + 10 * 60_000;
    const mk = (high, low) => ({ series: [{ granularity: 300, candles: [[t / 1000, low, high, 100000, 100000, 1]] }] });
    const o = { type: 'price_move', params: { symbol: 'BTC-USD', base: 100000, pct: 5 } };
    assert.equal(evaluate(o, mk(105000, 99000), timerMarket()).status, 'final');
    assert.ok(isPending(evaluate(o, mk(104999.99, 95000.01), timerMarket())));
    assert.equal(evaluate(o, mk(101000, 95000), timerMarket()).status, 'final');
  });

  test('crossing after 1 day lands in the right bucket; very late lands in the open-ended one', () => {
    const o = { type: 'price_move', params: { symbol: 'BTC-USD', base: 100, pct: 10 } };
    const at = (ms, low = 89, high = 101) => ({ series: [{ granularity: 3600, candles: [[ms / 1000, low, high, 100, 95, 1]] }] });
    assert.equal(evaluate(o, at(OPEN + 30 * HOUR), timerMarket()).optionId, 'd3');
    assert.equal(evaluate(o, at(OPEN + 5 * DAY), timerMarket()).optionId, 'd7');
    assert.equal(evaluate(o, at(OPEN + 9 * DAY), timerMarket()).optionId, 'never');
  });

  test('candles before the market opened are ignored (hourly straddling candle too)', () => {
    const o = { type: 'price_move', params: { symbol: 'BTC-USD', base: 100, pct: 5 } };
    const stale = { series: [{ granularity: 3600, candles: [[(OPEN - 3 * HOUR) / 1000, 80, 120, 100, 100, 1], [(OPEN - 1800_000) / 1000, 80, 120, 100, 100, 1]] }] };
    assert.ok(isPending(evaluate(o, stale, timerMarket())));
  });

  test('pending on empty, junk, or missing market.openedAt', () => {
    assert.ok(isPending(evaluate(oracle(), { series: [] }, timerMarket())));
    assert.ok(isPending(evaluate(oracle(), { series: [{ granularity: 300, candles: 'junk' }] }, timerMarket())));
    assert.ok(isPending(evaluate(oracle(), both(), {})));
    assert.ok(isPending(evaluate(oracle({ base: -1 }), both(), timerMarket())));
  });
});

describe('quake', () => {
  const oracle = (minMag) => ({ type: 'quake', params: { minMag } });
  const market = timerMarket();

  test('earliest qualifying event (feed order does not matter)', () => {
    const r = evaluate(oracle(6.5), fx('usgs-quakes.json'), market);
    assert.equal(r.status, 'final');
    assert.equal(r.eventAt, Date.parse('2026-10-01T15:12:44.120Z'));
    assert.equal(r.optionId, 'd3');
  });

  test('higher threshold skips smaller events', () => {
    const r = evaluate(oracle(7), fx('usgs-quakes.json'), market);
    assert.equal(r.eventAt, Date.parse('2026-10-02T04:41:10.500Z'));
    assert.equal(r.optionId, 'd3');
  });

  test('pending: empty feed, below threshold, before the market opened, non-earthquakes', () => {
    assert.ok(isPending(evaluate(oracle(6.5), fx('usgs-quakes-empty.json'), market)));
    assert.ok(isPending(evaluate(oracle(6.5), fx('usgs-quakes-decoys.json'), market)));
    assert.ok(isPending(evaluate(oracle(8), fx('usgs-quakes.json'), market)));
  });

  test('boundaries: magnitude == minMag counts; an event exactly at openedAt counts', () => {
    const early = timerMarket({ openedAt: Date.parse('2026-09-30T11:00:00Z') });
    early.bucketsById = { d1: { fromMs: 0, toMs: DAY }, never: { fromMs: DAY, toMs: null } };
    const r = evaluate(oracle(7), fx('usgs-quakes-decoys.json'), early);
    assert.equal(r.status, 'final');
    assert.equal(r.eventAt, Date.parse('2026-09-30T11:59:59Z'));
    const exact = timerMarket({ openedAt: Date.parse('2026-09-30T11:59:59Z') });
    assert.equal(evaluate(oracle(7), fx('usgs-quakes-decoys.json'), exact).status, 'final');
    const after = timerMarket({ openedAt: Date.parse('2026-09-30T12:00:00Z') });
    assert.ok(isPending(evaluate(oracle(7), fx('usgs-quakes-decoys.json'), after)));
  });

  test('pending on garbage', () => {
    for (const bad of [null, {}, { features: 'x' }, { features: [null, 1, {}, { properties: { mag: 'x', time: 'y' } }] }]) {
      assert.ok(isPending(evaluate(oracle(6.5), bad, market)));
    }
  });

  test('falls back to options fromDays/toDays when bucketsById is absent', () => {
    const m = { openedAt: OPEN, options: [{ id: 'a', fromDays: 0, toDays: 1 }, { id: 'b', fromDays: 1, toDays: 3 }, { id: 'z', fromDays: 3, toDays: null }] };
    assert.equal(evaluate(oracle(6.5), fx('usgs-quakes.json'), m).optionId, 'b');
    assert.equal(bucketOptionId(m, OPEN - 1), null);
    assert.equal(bucketOptionId(m, OPEN + 10 * DAY), 'z');
  });
});

describe('weather', () => {
  const rain = (over = {}) => ({ type: 'weather', params: { metric: 'precip', threshold: 1, date: '2026-10-01', at: AT + 3 * HOUR, tz: 'Europe/London', ...over } });
  const temp = (threshold) => ({ type: 'weather', params: { metric: 'tmax', threshold, date: '2026-10-01', at: AT + 3 * HOUR, tz: 'America/New_York' } });

  test('rain yes / no', () => {
    assert.equal(evaluate(rain(), fx('openmeteo-london-wet.json'), {}).optionId, 'yes');
    assert.equal(evaluate(rain(), fx('openmeteo-london-dry.json'), {}).optionId, 'no');
    assert.equal(evaluate(rain(), fx('openmeteo-london-wet.json'), {}).eventAt, null);
  });

  test('boundaries: exactly 1.0 mm is rain; 0.99 is not; tmax >= threshold', () => {
    const j = fx('openmeteo-london-dry.json');
    j.daily.precipitation_sum = [1.0];
    assert.equal(evaluate(rain(), j, {}).optionId, 'yes');
    j.daily.precipitation_sum = [0.99];
    assert.equal(evaluate(rain(), j, {}).optionId, 'no');
    assert.equal(evaluate(temp(21), fx('openmeteo-nyc-warm.json'), {}).optionId, 'yes');
    assert.equal(evaluate(temp(21.4), fx('openmeteo-nyc-warm.json'), {}).optionId, 'yes');
    assert.equal(evaluate(temp(22), fx('openmeteo-nyc-warm.json'), {}).optionId, 'no');
    assert.equal(evaluate(temp(20), fx('openmeteo-nyc-cool.json'), {}).optionId, 'no');
  });

  test('pending: fetched before the local day ended (asOf < at), missing date, null value, junk', () => {
    const j = fx('openmeteo-london-wet.json');
    assert.ok(isPending(evaluate(rain(), { ...j, asOf: AT }, {})));
    assert.equal(evaluate(rain(), { ...j, asOf: AT + 3 * HOUR }, {}).optionId, 'yes');
    assert.ok(isPending(evaluate(rain({ date: '2026-10-02' }), j, {})));
    j.daily.precipitation_sum = [null];
    assert.ok(isPending(evaluate(rain(), j, {})));
    for (const bad of [null, {}, { daily: null }, { daily: { time: 'x' } }, { daily: { time: ['2026-10-01'] } }]) {
      assert.ok(isPending(evaluate(rain(), bad, {})));
    }
  });
});

describe('wiki_battle', () => {
  const oracle = { type: 'wiki_battle', params: { date: '2026-10-01', a: { article: 'Taylor_Swift', label: 'Taylor Swift' }, b: { article: 'Elon_Musk', label: 'Elon Musk' } } };
  const data = () => ({ a: fx('wikimedia-swift-20261001.json'), b: fx('wikimedia-musk-20261001.json') });

  test('more views wins', () => {
    assert.deepEqual(evaluate(oracle, data(), {}), { status: 'final', optionId: 'a', eventAt: null });
    assert.equal(evaluate(oracle, { a: data().b, b: data().a }, {}).optionId, 'b');
  });
  test('pending: one side missing (404 / null), other date, exact tie, junk', () => {
    assert.ok(isPending(evaluate(oracle, { a: data().a, b: null }, {})));
    assert.ok(isPending(evaluate(oracle, { a: data().a, b: fx('wikimedia-404.json') }, {})));
    assert.ok(isPending(evaluate({ ...oracle, params: { ...oracle.params, date: '2026-10-02' } }, data(), {})));
    const tie = data();
    tie.b.items[0].views = tie.a.items[0].views;
    assert.ok(isPending(evaluate(oracle, tie, {})));
    assert.ok(isPending(evaluate(oracle, { a: 'x', b: 5 }, {})));
    assert.ok(isPending(evaluate(oracle, {}, {})));
  });
  test('wikiViewsOn picks the right timestamp', () => {
    assert.equal(wikiViewsOn(fx('wikimedia-swift-week.json'), '2026-09-27'), 97650);
    assert.equal(wikiViewsOn(fx('wikimedia-swift-week.json'), '2026-10-27'), null);
  });
});

describe('sports (ESPN)', () => {
  const oracle = (over = {}) => ({ type: 'sports', params: { sport: 'basketball', league: 'nba', eventId: '401800001', date: '20261001', draw: false, ...over } });

  test('final score decides (away wins 112-104)', () => {
    assert.deepEqual(evaluate(oracle(), fx('espn-scoreboard-nba-final.json'), {}), { status: 'final', optionId: 'away', eventAt: null });
  });
  test('pending: scheduled, postponed, unknown id, empty board, junk', () => {
    assert.ok(isPending(evaluate(oracle(), fx('espn-scoreboard-nba-pre.json'), {})));
    assert.ok(isPending(evaluate(oracle({ eventId: '401800002' }), fx('espn-scoreboard-nba-final.json'), {})));
    assert.ok(isPending(evaluate(oracle({ eventId: '999' }), fx('espn-scoreboard-nba-final.json'), {})));
    assert.ok(isPending(evaluate(oracle(), fx('espn-scoreboard-empty.json'), {})));
    assert.ok(isPending(evaluate(oracle(), { events: [null, {}, { id: '401800001' }] }, {})));
  });
  test('soccer draw only with a draw option; home win otherwise', () => {
    const o = oracle({ sport: 'soccer', league: 'eng.1', eventId: '740001', date: '20261003', draw: true });
    assert.equal(evaluate(o, fx('espn-scoreboard-epl-draw.json'), {}).optionId, 'draw');
    const noDraw = oracle({ sport: 'soccer', league: 'eng.1', eventId: '740001', draw: false });
    assert.ok(isPending(evaluate(noDraw, fx('espn-scoreboard-epl-draw.json'), {})));
    const home = fx('espn-scoreboard-epl-draw.json');
    home.events[0].competitions[0].competitors[0].score = '3';
    assert.equal(evaluate(o, home, {}).optionId, 'home');
  });
  test('parseScoreboard shape', () => {
    const [e1, e2] = parseScoreboard(fx('espn-scoreboard-nba-pre.json'));
    assert.equal(e1.id, '401800001');
    assert.equal(e1.state, 'pre');
    assert.equal(e1.startAt, Date.parse('2026-10-01T23:30Z'));
    assert.equal(e1.home.name, 'New York Knicks');
    assert.equal(e1.away.abbr, 'BOS');
    assert.equal(e1.odds.homeML, 155);
    assert.equal(e1.odds.awayML, -185);
    assert.equal(e2.odds, null);
    assert.deepEqual(parseScoreboard(null), []);
    assert.deepEqual(parseScoreboard({ events: 'x' }), []);
  });
  test('sportsProbabilities: moneylines are de-vigged, records fallback, 3-way, unknown => null', () => {
    const [e1, e2] = parseScoreboard(fx('espn-scoreboard-nba-pre.json'));
    const p = sportsProbabilities(e1, { sport: 'nba' });
    assert.ok(Math.abs(p.home + p.away - 1) < 1e-9);
    assert.ok(p.home < p.away && p.home > 0.3 && p.home < 0.45, `home ${p.home}`);
    const fallback = sportsProbabilities(e2, { sport: 'nba' });
    assert.ok(fallback.home > 0.5 && fallback.home < 0.6);
    const [soc] = parseScoreboard(fx('espn-scoreboard-epl-pre.json'));
    const s = sportsProbabilities(soc, { sport: 'soccer', draw: true });
    assert.ok(Math.abs(s.home + s.draw + s.away - 1) < 1e-9);
    assert.ok(s.home > s.away);
    assert.equal(sportsProbabilities({ ...soc, odds: null }, { sport: 'soccer', draw: true }), null);
    const bare = { odds: null, home: { record: null, abbr: 'A' }, away: { record: null, abbr: 'B' } };
    assert.equal(sportsProbabilities(bare, { sport: 'nba' }), null);
  });
});

describe('evaluate: general safety', () => {
  test('unknown type / missing pieces are pending and never throw', () => {
    assert.ok(isPending(evaluate({ type: 'nope', params: {} }, {}, {})));
    assert.ok(isPending(evaluate(null, {}, {})));
    assert.ok(isPending(evaluate(undefined, undefined, undefined)));
    for (const type of ORACLE_TYPES) {
      for (const data of [null, undefined, 0, '', [], {}, [[]], { candles: null }, { series: null }, { features: null }, { daily: {} }, { items: [] }]) {
        assert.ok(isPending(evaluate({ type, params: {} }, data, undefined)), `${type} ${JSON.stringify(data)}`);
        assert.ok(isPending(evaluate({ type }, data, {})), `${type} no params`);
      }
    }
  });
  test('normCdf sanity', () => {
    assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
    assert.ok(Math.abs(normCdf(-1) - 0.1587) < 1e-3);
  });
});

describe('labels', () => {
  test('describeOracle / sourceLabel', () => {
    const o = makeOracle('price_above', { symbol: 'BTC-USD', threshold: 64200, at: AT });
    assert.equal(o.source, 'Coinbase Exchange');
    assert.equal(o.label, 'Coinbase BTC-USD close at 00:00 UTC Oct 1');
    assert.equal(describeOracle(o), 'Auto-checked: Coinbase BTC-USD close at 00:00 UTC Oct 1');
    assert.equal(sourceLabel(o), 'Coinbase Exchange');
    assert.equal(sourceLabel({ type: 'quake' }), 'USGS');
    assert.equal(sourceLabel(null), '');
    assert.equal(describeOracle(null), '');
  });
  test('every type has a source and label', () => {
    const params = {
      price_above: { symbol: 'ETH-USD', at: AT }, price_move: { symbol: 'SOL-USD', pct: 10, base: 150 }, quake: { minMag: 7 },
      weather: { city: 'London', metric: 'precip', threshold: 1, date: '2026-10-01' },
      wiki_battle: { date: '2026-10-01', a: { label: 'A' }, b: { label: 'B' } }, sports: { homeName: 'H', awayName: 'A' },
    };
    for (const type of ORACLE_TYPES) {
      const o = makeOracle(type, params[type]);
      assert.ok(o.source && o.label && !o.label.includes('undefined'), type);
      assert.ok(describeOracle(o).startsWith('Auto-checked: '));
    }
  });
});

describe('fetchOracleData (mocked fetch)', () => {
  test('price_above: refuses to fetch before `at`, then requests a 1-minute window around it', async () => {
    const o = { type: 'price_above', params: { symbol: 'BTC-USD', threshold: 64200, at: AT } };
    const f = mockFetch([['/candles', fx('coinbase-candles-btc-1m.json')]]);
    assert.equal(await fetchOracleData(o, {}, { fetch: f, now: AT - 1000 }), null);
    assert.equal(f.calls.length, 0);
    const data = await fetchOracleData(o, {}, { fetch: f, now: AT + 30_000 });
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0], /^https:\/\/api\.exchange\.coinbase\.com\/products\/BTC-USD\/candles\?granularity=60&start=2026-09-30T23%3A45%3A00Z&end=2026-10-01T00%3A10%3A00Z$/);
    assert.equal(evaluate(o, data, {}).optionId, 'yes');
  });

  test('price_move: 5-minute window for the first day, hourly candles beyond it', async () => {
    const o = { type: 'price_move', params: { symbol: 'BTC-USD', base: 64013, pct: 5 } };
    const market = timerMarket({ expiresAt: OPEN + 7 * DAY });
    const f = mockFetch([['granularity=300', fx('coinbase-candles-btc-5m.json')], ['granularity=3600', fx('coinbase-candles-btc-1h.json')]]);
    const data = await fetchOracleData(o, market, { fetch: f, now: OPEN + 8 * HOUR });
    assert.deepEqual(f.calls.length, 1, 'short lookback needs only the fine series');
    assert.equal(evaluate(o, data, market).eventAt, Date.UTC(2026, 8, 30, 19, 35));
    const f2 = mockFetch([['granularity=300', fx('coinbase-candles-btc-5m.json')], ['granularity=3600', fx('coinbase-candles-btc-1h.json')]]);
    await fetchOracleData(o, market, { fetch: f2, now: OPEN + 3 * DAY });
    assert.ok(f2.calls.some((u) => u.includes('granularity=3600')));
    assert.ok(f2.calls.every((u) => /granularity=(300|3600)/.test(u)));
    assert.equal(await fetchOracleData(o, market, { fetch: f2, now: OPEN }), null, 'nothing to look at yet');
  });

  test('price_move: survives one series failing', async () => {
    const o = { type: 'price_move', params: { symbol: 'BTC-USD', base: 64013, pct: 5 } };
    const market = timerMarket({ expiresAt: OPEN + 7 * DAY });
    const f = mockFetch([['granularity=300', new Error('boom')], ['granularity=3600', fx('coinbase-candles-btc-1h.json')]]);
    const data = await fetchOracleData(o, market, { fetch: f, now: OPEN + 3 * DAY });
    assert.equal(data.series.length, 1);
    assert.equal(evaluate(o, data, market).eventAt, Date.UTC(2026, 8, 30, 19, 0));
  });

  test('quake: USGS query URL', async () => {
    const o = { type: 'quake', params: { minMag: 6.5 } };
    const f = mockFetch([['earthquake.usgs.gov', fx('usgs-quakes.json')]]);
    const data = await fetchOracleData(o, timerMarket(), { fetch: f, now: AT });
    assert.equal(f.calls.length, 1);
    const u = new URL(f.calls[0]);
    assert.equal(u.origin + u.pathname, 'https://earthquake.usgs.gov/fdsnws/event/1/query');
    assert.equal(u.searchParams.get('format'), 'geojson');
    assert.equal(u.searchParams.get('minmagnitude'), '6.5');
    assert.equal(u.searchParams.get('starttime'), '2026-09-30T12:00:00');
    assert.equal(u.searchParams.get('orderby'), 'time-asc');
    assert.equal(u.searchParams.get('eventtype'), 'earthquake');
    assert.equal(evaluate(o, data, timerMarket()).status, 'final');
  });

  test('weather: no request before the day is over; Open-Meteo daily query afterwards', async () => {
    const o = { type: 'weather', params: { metric: 'precip', threshold: 1, date: '2026-10-01', at: AT + 3 * HOUR, tz: 'Europe/London', lat: 51.5072, lon: -0.1276 } };
    const f = mockFetch([['api.open-meteo.com', fx('openmeteo-london-wet.json')]]);
    assert.equal(await fetchOracleData(o, {}, { fetch: f, now: AT }), null);
    assert.equal(f.calls.length, 0);
    const data = await fetchOracleData(o, {}, { fetch: f, now: AT + 4 * HOUR });
    const u = new URL(f.calls[0]);
    assert.equal(u.searchParams.get('timezone'), 'Europe/London');
    assert.equal(u.searchParams.get('start_date'), '2026-10-01');
    assert.equal(u.searchParams.get('end_date'), '2026-10-01');
    assert.match(u.searchParams.get('daily'), /precipitation_sum/);
    assert.equal(evaluate(o, data, {}).optionId, 'yes');
  });

  test('wiki_battle: two per-article requests; a 404 side is null => pending', async () => {
    const o = { type: 'wiki_battle', params: { project: 'en.wikipedia', date: '2026-10-01', at: AT + DAY + 6 * HOUR, a: { article: 'Taylor_Swift' }, b: { article: 'Elon_Musk' } } };
    const f = mockFetch([['Taylor_Swift', fx('wikimedia-swift-20261001.json')], ['Elon_Musk', fx('wikimedia-musk-20261001.json')]]);
    const data = await fetchOracleData(o, {}, { fetch: f, now: AT + 2 * DAY });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0], 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Taylor_Swift/daily/20261001/20261001');
    assert.equal(evaluate(o, data, {}).optionId, 'a');
    const f404 = mockFetch([['Taylor_Swift', { __status: 404 }], ['Elon_Musk', { __status: 404 }]]);
    assert.equal(await fetchOracleData(o, {}, { fetch: f404, now: AT + 2 * DAY }), null);
    const fHalf = mockFetch([['Taylor_Swift', fx('wikimedia-swift-20261001.json')], ['Elon_Musk', { __status: 404 }]]);
    assert.ok(isPending(evaluate(o, await fetchOracleData(o, {}, { fetch: fHalf, now: AT + 2 * DAY }), {})));
    assert.equal(await fetchOracleData(o, {}, { fetch: f, now: AT }), null, 'too early');
  });

  test('sports: scoreboard URL', async () => {
    const o = { type: 'sports', params: { sport: 'basketball', league: 'nba', eventId: '401800001', date: '20261001', draw: false } };
    const f = mockFetch([['site.api.espn.com', fx('espn-scoreboard-nba-final.json')]]);
    const data = await fetchOracleData(o, {}, { fetch: f });
    assert.equal(f.calls[0], 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261001');
    assert.equal(evaluate(o, data, {}).optionId, 'away');
  });

  test('failures => null, never a throw', async () => {
    const o = { type: 'sports', params: { sport: 'basketball', league: 'nba', eventId: '1', date: '20261001' } };
    assert.equal(await fetchOracleData(o, {}, { fetch: mockFetch([['espn', new Error('offline')]]) }), null);
    assert.equal(await fetchOracleData(o, {}, { fetch: mockFetch([]) }), null); // 404
    assert.equal(await fetchOracleData(o, {}, { fetch: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) }), null);
    assert.equal(await fetchOracleData(o, {}, { fetch: async () => ({ ok: true, json: async () => ({ events: 'nope' }) }) }), null);
    assert.equal(await fetchOracleData(o, {}, { fetch: null }), null);
    assert.equal(await fetchOracleData(null, {}, { fetch: mockFetch([]) }), null);
    assert.equal(await fetchOracleData({ type: 'mystery', params: {} }, {}, { fetch: mockFetch([]) }), null);
  });

  test('checkMarketOracle = fetch + evaluate; pending for markets without an oracle', async () => {
    const market = { id: 'm', oracle: { type: 'quake', params: { minMag: 6.5 } }, ...timerMarket() };
    const r = await checkMarketOracle(market, { fetch: mockFetch([['usgs', fx('usgs-quakes.json')]]), now: AT });
    assert.equal(r.status, 'final');
    assert.ok(isPending(await checkMarketOracle({ id: 'x' })));
    assert.ok(isPending(await checkMarketOracle(market, { fetch: mockFetch([]) })));
  });
});

describe('createFetchers (baseline fetchers, mocked fetch)', () => {
  test('spot', async () => {
    const f = createFetchers({ fetch: mockFetch([['/ticker', fx('coinbase-ticker-btc.json')]]) });
    assert.equal(await f.spot('BTC-USD'), 64013.51);
    await assert.rejects(createFetchers({ fetch: mockFetch([['/ticker', { price: 'abc' }]]) }).spot('BTC-USD'));
    await assert.rejects(createFetchers({ fetch: mockFetch([]) }).spot('BTC-USD'));
  });
  test('forecast', async () => {
    const f = createFetchers({ fetch: mockFetch([['open-meteo', fx('openmeteo-forecast-london.json')]]) });
    assert.deepEqual(await f.forecast({ lat: 51.5, lon: -0.12, tz: 'Europe/London', date: '2026-10-01' }), { tmax: 15.4, precipSum: 2.1, precipProb: 62 });
    await assert.rejects(f.forecast({ lat: 51.5, lon: -0.12, tz: 'Europe/London', date: '2026-10-05' }));
  });
  test('wikiViews / scoreboard', async () => {
    const f = createFetchers({ fetch: mockFetch([['Taylor_Swift', fx('wikimedia-swift-week.json')], ['espn', fx('espn-scoreboard-nba-pre.json')]]) });
    const v = await f.wikiViews({ article: 'Taylor_Swift', from: '2026-09-24', to: '2026-09-30' });
    assert.equal(v.length, 7);
    assert.equal(v[0], 104120);
    const ev = await f.scoreboard('basketball', 'nba', '20261001');
    assert.equal(ev.length, 2);
    await assert.rejects(f.wikiViews({ article: 'Nobody', from: '2026-09-24', to: '2026-09-30' }));
  });
  test('urls', () => {
    assert.equal(urls.scoreboard('soccer', 'eng.1', '20261003'), 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20261003');
    assert.match(urls.wiki('en.wikipedia', 'Python_(programming_language)', '2026-10-01', '2026-10-01'), /Python_\(programming_language\)\/daily\/20261001\/20261001$/);
  });
});

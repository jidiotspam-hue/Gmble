import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/economy.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const { DAY_MS, HOUR_MS } = E;

const player = (over = {}) => ({ ...E.newPlayer('u1', 'alice', NOW), lastBetAt: 0, ...over });

const base = (over = {}) => E.normalizeMarket({
  id: 'm1', type: 'custom', kind: 'choice', mode: 'pool', title: 'Will it rain?', description: '',
  category: 'x', emoji: 'x', createdBy: 'u9', createdByName: 'bob',
  openedAt: NOW, closesAt: NOW + HOUR_MS,
  options: [{ id: 'a', label: 'A', odds: null }, { id: 'b', label: 'B', odds: null }],
  ...over,
});
const fixedMarket = (over = {}) => base({
  mode: 'fixed',
  options: [{ id: 'a', label: 'A', odds: 2.5 }, { id: 'b', label: 'B', odds: 1.5 }],
  ...over,
});
const timerMarket = (over = {}) => base({
  kind: 'timer', mode: 'fixed', options: E.DEFAULT_TIMER_BUCKETS.map((o) => ({ ...o })), ...over,
});
const reported = (over = {}) => ({
  ...base(), status: 'reported', reportedBy: 'u2', reportedByName: 'rep', reportedOptionId: 'a',
  reportedAt: NOW + 2 * HOUR_MS, ...over,
});
const challenged = (over = {}) => ({
  ...reported(), status: 'challenged', challengedBy: 'u3', challengedByName: 'chal',
  challengedAt: NOW + 3 * HOUR_MS, ...over,
});
const bet = (over = {}) => ({
  id: 'b1', marketId: 'm1', uid: 'u1', optionId: 'a', amount: 100, odds: null, status: 'open', payout: 0, taxed: 0, ...over,
});

describe('constants, formatting, keys', () => {
  test('constants', () => {
    assert.equal(E.STARTING_BALANCE, 500);
    assert.equal(E.RESTART_BALANCE, 100);
    assert.equal(E.PENALTY_DAYS, 3);
    assert.equal(E.PENALTY_TAX, 0.25);
    assert.equal(E.BOND, 20);
    assert.equal(E.CHALLENGE_WINDOW_MS, 12 * HOUR_MS);
    assert.equal(E.VOTE_WINDOW_MS, 24 * HOUR_MS);
    assert.equal(E.BET_COOLDOWN_MS, 2000);
    assert.equal(E.MAX_MARKETS_PER_DAY, 5);
    assert.equal(E.MIN_FIXED_ODDS, 1.01);
    assert.equal(E.MAX_FIXED_ODDS, 20);
    assert.equal(E.CLOCK_SKEW_MS, 300000);
    assert.deepEqual(E.CURRENCY, { name: 'sonnetous', symbol: '§' });
  });

  test('default buckets', () => {
    const b = E.DEFAULT_TIMER_BUCKETS;
    assert.deepEqual(b.map((x) => x.id), ['d1', 'd4', 'd8', 'never']);
    assert.deepEqual(b.map((x) => x.odds), [6, 3, 1.8, 1.3]);
    assert.equal(b[3].toDays, null);
  });

  test('formatSonnetous', () => {
    assert.equal(E.formatSonnetous(1234), '§1,234');
    assert.equal(E.formatSonnetous(0), '§0');
    assert.equal(E.formatSonnetous(-5), '-§5');
    assert.equal(E.formatSonnetous(1234567), '§1,234,567');
  });

  test('dayKey / utcDayKey / utcDayNumber', () => {
    assert.equal(E.dayKey(new Date(2026, 0, 5, 23, 30).getTime()), '2026-01-05');
    assert.equal(E.utcDayKey(Date.UTC(2026, 11, 31, 23, 59, 59)), '2026-12-31');
    assert.equal(E.utcDayKey(Date.UTC(2027, 0, 1)), '2027-01-01');
    assert.equal(E.utcDayNumber(0), 0);
    assert.equal(E.utcDayNumber(DAY_MS - 1), 0);
    assert.equal(E.utcDayNumber(DAY_MS), 1);
    assert.equal(E.utcDayNumber(Date.UTC(2026, 5, 15, 23, 59, 59, 999)), E.utcDayNumber(Date.UTC(2026, 5, 15)));
  });

  test('newPlayer has every v2 field', () => {
    assert.deepEqual(E.newPlayer('u', 'n', 5), {
      uid: 'u', username: 'n', balance: 500, openStake: 0, createdAt: 5, bankruptcies: 0, brokeSince: null,
      penaltyUntil: null, totalWagered: 0, totalWon: 0, lastBetAt: 0, marketsDay: 0, marketsCount: 0,
      lastClaimId: null, lastBondMarketId: null,
    });
  });

  test('validateUsername', () => {
    assert.equal(E.validateUsername('abc'), null);
    assert.equal(E.validateUsername('a_B_9'.padEnd(20, 'x')), null);
    assert.ok(E.validateUsername('ab'));
    assert.ok(E.validateUsername('a'.repeat(21)));
    assert.ok(E.validateUsername('has space'));
    assert.ok(E.validateUsername(null));
  });

  test('mulberry32 is deterministic in [0,1); hashString stable', () => {
    const a = E.mulberry32(42);
    const b = E.mulberry32(42);
    for (let i = 0; i < 20; i++) { const v = a(); assert.equal(v, b()); assert.ok(v >= 0 && v < 1); }
    assert.equal(E.hashString('abc'), E.hashString('abc'));
    assert.notEqual(E.hashString('abc'), E.hashString('abd'));
  });
});

describe('normalizeMarket', () => {
  test('choice pool market defaults', () => {
    const m = base();
    assert.deepEqual(m.optionIds, ['a', 'b']);
    assert.equal(m.oddsById, null);
    assert.equal(m.bucketsById, null);
    assert.equal(m.expiresAt, null);
    assert.equal(m.expiryOptionId, null);
    assert.equal(m.reportableAt, m.closesAt);
    assert.deepEqual(m.optionTotals, { a: 0, b: 0 });
    for (const [k, v] of Object.entries({
      totalPool: 0, betCount: 0, lastBetId: null, status: 'open', reportedBy: null, reportedByName: null,
      reportedOptionId: null, reportedEventAt: null, reportedAt: null, evidence: null, challengedBy: null,
      challengedByName: null, challengedAt: null, votesUphold: 0, votesOverturn: 0, lastVoteId: null,
      resolvedOptionId: null, resolvedAt: null, eventAt: null, reporterBondPaid: false, challengerBondPaid: false,
      oracle: null, templateId: null,
    })) assert.deepEqual(m[k], v, k);
    assert.ok(!('resolvedBy' in m));
  });

  test('fixed market gets oddsById', () => {
    assert.deepEqual(fixedMarket().oddsById, { a: 2.5, b: 1.5 });
  });

  test('timer market derives buckets, expiry and reportableAt', () => {
    const m = timerMarket();
    assert.deepEqual(m.bucketsById, {
      d1: { fromMs: 0, toMs: DAY_MS },
      d4: { fromMs: DAY_MS, toMs: 4 * DAY_MS },
      d8: { fromMs: 4 * DAY_MS, toMs: 8 * DAY_MS },
      never: { fromMs: 8 * DAY_MS, toMs: null },
    });
    assert.equal(m.expiresAt, NOW + 8 * DAY_MS);
    assert.equal(m.expiryOptionId, 'never');
    assert.equal(m.reportableAt, NOW);
    assert.deepEqual(m.oddsById, { d1: 6, d4: 3, d8: 1.8, never: 1.3 });
  });

  test('timer without an open-ended bucket never expires', () => {
    const m = timerMarket({ options: [{ id: 'x', label: 'x', odds: 2, fromDays: 0, toDays: 1 }, { id: 'y', label: 'y', odds: 2, fromDays: 1, toDays: 2 }] });
    assert.equal(m.expiresAt, null);
    assert.equal(m.expiryOptionId, null);
  });

  test('oracle.params.at drives reportableAt for choice markets', () => {
    const m = base({ oracle: { type: 'price_above', params: { at: NOW + 5 * HOUR_MS }, source: 's', label: 'l' } });
    assert.equal(m.reportableAt, NOW + 5 * HOUR_MS);
  });

  test('never overwrites present fields and does not mutate input', () => {
    const input = { ...base(), reportableAt: 123, totalPool: 77, optionTotals: { a: 70, b: 7 } };
    const frozenOptions = JSON.stringify(input.options);
    const out = E.normalizeMarket(input);
    assert.equal(out.reportableAt, 123);
    assert.equal(out.totalPool, 77);
    assert.notEqual(out.options, input.options);
    assert.equal(JSON.stringify(input.options), frozenOptions);
    assert.deepEqual(E.normalizeMarket(out), out);
  });
});

describe('marketPhase / isBettingOpen', () => {
  test('open, closed at exactly closesAt, and passthrough statuses', () => {
    const m = base();
    assert.equal(E.marketPhase(m, m.closesAt - 1), 'open');
    assert.equal(E.marketPhase(m, m.closesAt), 'closed');
    assert.equal(E.isBettingOpen(m, m.closesAt - 1), true);
    assert.equal(E.isBettingOpen(m, m.closesAt), false);
    for (const s of ['reported', 'challenged', 'resolved', 'void']) {
      assert.equal(E.marketPhase({ ...m, status: s }, NOW), s);
      assert.equal(E.isBettingOpen({ ...m, status: s }, NOW), false);
    }
  });
});

describe('validateBet', () => {
  const m = fixedMarket();
  test('accepts a good bet', () => assert.equal(E.validateBet(player(), m, 'a', 50, NOW), null));
  test('friendly errors', () => {
    assert.match(E.validateBet(null, m, 'a', 5, NOW), /log in/i);
    assert.match(E.validateBet(player(), null, 'a', 5, NOW), /not found/i);
    assert.match(E.validateBet(player(), { ...m, status: 'resolved' }, 'a', 5, NOW), /resolved/);
    assert.match(E.validateBet(player(), { ...m, status: 'void' }, 'a', 5, NOW), /voided/);
    assert.match(E.validateBet(player(), { ...m, status: 'reported' }, 'a', 5, NOW), /closed/i);
    assert.match(E.validateBet(player(), { ...m, status: 'challenged' }, 'a', 5, NOW), /closed/i);
    assert.match(E.validateBet(player(), m, 'a', 5, m.closesAt), /closed/i);
    assert.equal(E.validateBet(player(), m, 'a', 5, m.closesAt - 1), null);
    assert.match(E.validateBet(player(), m, 'zzz', 5, NOW), /unknown option/i);
    assert.match(E.validateBet(player(), m, 'a', 1.5, NOW), /whole number/);
    assert.match(E.validateBet(player(), m, 'a', NaN, NOW), /whole number/);
    assert.match(E.validateBet(player(), m, 'a', '5', NOW), /whole number/);
    assert.match(E.validateBet(player(), m, 'a', 0, NOW), /minimum/i);
    assert.match(E.validateBet(player(), m, 'a', -3, NOW), /minimum/i);
    assert.equal(E.validateBet(player(), m, 'a', 500, NOW), null);
    assert.equal(E.validateBet(player(), m, 'a', 501, NOW), 'Not enough sonnetous');
  });
  test('cooldown: exactly 2s after the last bet is fine', () => {
    const p = player({ lastBetAt: NOW });
    assert.equal(E.validateBet(p, m, 'a', 5, NOW), 'Slow down — one bet every 2 seconds');
    assert.equal(E.validateBet(p, m, 'a', 5, NOW + 1999), 'Slow down — one bet every 2 seconds');
    assert.equal(E.validateBet(p, m, 'a', 5, NOW + 2000), null);
  });
});

describe('potentialPayout / displayOdds / buildBet / applyBetToMarket', () => {
  test('fixed', () => {
    const m = fixedMarket();
    assert.equal(E.potentialPayout(m, 'a', 100), 250);
    assert.equal(E.potentialPayout(m, 'b', 33), 49);
    assert.equal(E.potentialPayout(m, 'a', 0), 0);
    assert.equal(E.potentialPayout(m, 'nope', 10), 0);
    assert.equal(E.potentialPayout(fixedMarket({ options: [{ id: 'a', label: 'A', odds: 1.15 }, { id: 'b', label: 'B', odds: 2 }] }), 'a', 100), 115);
    assert.equal(E.displayOdds(m, 'a'), 2.5);
  });
  test('pool', () => {
    const m = base({ optionTotals: { a: 100, b: 300 }, totalPool: 400 });
    assert.equal(E.potentialPayout(m, 'a', 100), Math.floor(100 * 500 / 200));
    assert.equal(E.potentialPayout(m, 'b', 100), Math.floor(100 * 500 / 400));
    assert.equal(E.displayOdds(m, 'a'), 4);
    assert.equal(E.displayOdds(base(), 'a'), null);
    assert.equal(E.potentialPayout(base(), 'a', 10), 10);
  });
  test('buildBet locks odds for fixed, null for pool; carries claimedAt null', () => {
    const b = E.buildBet({ id: 'x', market: fixedMarket(), player: player(), optionId: 'b', amount: 10, now: NOW });
    assert.deepEqual(b, {
      id: 'x', marketId: 'm1', marketTitle: 'Will it rain?', uid: 'u1', username: 'alice', optionId: 'b', optionLabel: 'B',
      amount: 10, odds: 1.5, placedAt: NOW, status: 'open', payout: 0, taxed: 0, claimedAt: null,
    });
    assert.equal(E.buildBet({ id: 'x', market: base(), player: player(), optionId: 'a', amount: 10, now: NOW }).odds, null);
  });
  test('applyBetToMarket is a pure patch', () => {
    const m = base({ optionTotals: { a: 5, b: 0 }, totalPool: 5, betCount: 1 });
    const patch = E.applyBetToMarket(m, 'a', 10, 'bet9');
    assert.deepEqual(patch, { optionTotals: { a: 15, b: 0 }, totalPool: 15, betCount: 2, lastBetId: 'bet9' });
    assert.deepEqual(m.optionTotals, { a: 5, b: 0 });
  });
});

describe('validateCreateMarket / marketCreationPatch', () => {
  const custom = (over = {}) => base({ createdBy: 'u1', createdByName: 'alice', ...over });
  test('valid custom', () => assert.equal(E.validateCreateMarket(player(), custom(), NOW), null));
  test('daily cap of 5 resets at UTC midnight', () => {
    const today = E.utcDayNumber(NOW);
    assert.equal(E.validateCreateMarket(player({ marketsDay: today, marketsCount: 4 }), custom(), NOW), null);
    assert.equal(E.validateCreateMarket(player({ marketsDay: today, marketsCount: 5 }), custom(), NOW),
      'You can only create 5 markets per day');
    assert.equal(E.validateCreateMarket(player({ marketsDay: today - 1, marketsCount: 5 }), custom(), NOW), null);
    // the last ms of the day still counts, the first ms of the next day resets
    const endOfDay = (today + 1) * DAY_MS - 1;
    const p = player({ marketsDay: today, marketsCount: 5 });
    const m = (t) => custom({ openedAt: t, closesAt: t + HOUR_MS, reportableAt: t + HOUR_MS });
    assert.match(E.validateCreateMarket(p, m(endOfDay), endOfDay), /5 markets/);
    assert.equal(E.validateCreateMarket(p, m(endOfDay + 1), endOfDay + 1), null);
  });
  test('marketCreationPatch increments or resets', () => {
    const today = E.utcDayNumber(NOW);
    assert.deepEqual(E.marketCreationPatch(player(), NOW), { marketsDay: today, marketsCount: 1 });
    assert.deepEqual(E.marketCreationPatch(player({ marketsDay: today, marketsCount: 3 }), NOW), { marketsDay: today, marketsCount: 4 });
    assert.deepEqual(E.marketCreationPatch(player({ marketsDay: today - 2, marketsCount: 5 }), NOW), { marketsDay: today, marketsCount: 1 });
  });
  test('structural errors', () => {
    assert.match(E.validateCreateMarket(null, custom(), NOW), /log in/i);
    assert.match(E.validateCreateMarket(player(), custom({ createdBy: 'u2' }), NOW), /as yourself/);
    assert.match(E.validateCreateMarket(player(), custom({ title: 'hi' }), NOW), /at least 3/);
    assert.match(E.validateCreateMarket(player(), custom({ title: 'x'.repeat(141) }), NOW), /at most 140/);
    assert.match(E.validateCreateMarket(player(), custom({ options: [{ id: 'a', label: 'A', odds: null }] }), NOW), /2–6/);
    assert.match(E.validateCreateMarket(player(), custom({ closesAt: NOW }), NOW), /future/);
    assert.match(E.validateCreateMarket(player(), custom({ openedAt: NOW + E.CLOCK_SKEW_MS + 1 }), NOW), /clock/i);
    assert.equal(E.validateCreateMarket(player(), custom({ openedAt: NOW + E.CLOCK_SKEW_MS, closesAt: NOW + HOUR_MS }), NOW), null);
    assert.match(E.validateCreateMarket(player(), custom({ totalPool: 5 }), NOW), /empty pool/);
    assert.match(E.validateCreateMarket(player(), custom({ status: 'resolved' }), NOW), /open/);
  });
  test('fixed odds bounds [1.01, 20]', () => {
    const fm = (odds) => fixedMarket({ createdBy: 'u1', createdByName: 'alice', kind: 'choice', options: [{ id: 'a', label: 'A', odds }, { id: 'b', label: 'B', odds: 2 }] });
    const hm = (odds) => ({ ...fm(odds), type: 'auto', createdBy: 'house', id: 'auto-2026-06-15-x' });
    assert.equal(E.validateCreateMarket(player(), hm(1.01), NOW), null);
    assert.equal(E.validateCreateMarket(player(), hm(20), NOW), null);
    assert.match(E.validateCreateMarket(player(), hm(1.0), NOW), /between 1.01 and 20/);
    assert.match(E.validateCreateMarket(player(), hm(20.01), NOW), /between 1.01 and 20/);
    assert.match(E.validateCreateMarket(player(), hm(null), NOW), /between/);
  });
  test('house markets: id format, no daily cap, must be createdBy house + auto', () => {
    const house = (over = {}) => ({ ...fixedMarket({ kind: 'choice' }), id: 'auto-2026-06-15-tpl', type: 'auto', createdBy: 'house', ...over });
    const capped = player({ marketsDay: E.utcDayNumber(NOW), marketsCount: 5 });
    assert.equal(E.validateCreateMarket(capped, house(), NOW), null);
    assert.match(E.validateCreateMarket(capped, house({ id: 'nope' }), NOW), /house market id/);
    assert.match(E.validateCreateMarket(capped, house({ type: 'custom' }), NOW), /Invalid/);
  });
  test('custom timer must be fixed, custom choice must be pool', () => {
    assert.match(E.validateCreateMarket(player(), custom({ mode: 'fixed', oddsById: { a: 2, b: 2 } }), NOW), /pool/);
    const t = timerMarket({ createdBy: 'u1', createdByName: 'alice' });
    assert.equal(E.validateCreateMarket(player(), t, NOW), null);
    assert.match(E.validateCreateMarket(player(), { ...t, mode: 'pool' }, NOW), /fixed/);
  });
});

describe('timer helpers', () => {
  const m = timerMarket();
  test('timerBucketFor edges', () => {
    assert.equal(E.timerBucketFor(m, NOW), 'd1');
    assert.equal(E.timerBucketFor(m, NOW - 5), 'd1');
    assert.equal(E.timerBucketFor(m, NOW + DAY_MS - 1), 'd1');
    assert.equal(E.timerBucketFor(m, NOW + DAY_MS), 'd4');
    assert.equal(E.timerBucketFor(m, NOW + 4 * DAY_MS), 'd8');
    assert.equal(E.timerBucketFor(m, NOW + 8 * DAY_MS), 'never');
    assert.equal(E.timerBucketFor(m, NOW + 100 * DAY_MS), 'never');
  });
  test('timerAutoResolution boundary', () => {
    assert.equal(E.timerAutoResolution(m, NOW + 8 * DAY_MS - 1), null);
    assert.equal(E.timerAutoResolution(m, NOW + 8 * DAY_MS), 'never');
    assert.equal(E.timerAutoResolution({ ...m, status: 'reported' }, NOW + 9 * DAY_MS), null);
    assert.equal(E.timerAutoResolution(base(), NOW + 99 * DAY_MS), null);
  });
});

describe('validateReport', () => {
  const closedChoice = base({ createdBy: 'u1' });
  const at = closedChoice.closesAt;
  test('creator-only on custom markets', () => {
    assert.equal(E.validateReport(player(), closedChoice, 'a', null, at), null);
    assert.equal(E.validateReport(player({ uid: 'u5' }), closedChoice, 'a', null, at), 'Only the creator can report this market');
  });
  test('anyone may report house markets', () => {
    const h = { ...closedChoice, type: 'auto', createdBy: 'house' };
    assert.equal(E.validateReport(player({ uid: 'u5' }), h, 'a', null, at), null);
  });
  test('reportableAt boundary', () => {
    assert.match(E.validateReport(player(), closedChoice, 'a', null, at - 1), /too early/i);
    assert.equal(E.validateReport(player(), closedChoice, 'a', null, at), null);
  });
  test('status errors', () => {
    const p = player();
    assert.match(E.validateReport(p, { ...closedChoice, status: 'reported' }, 'a', null, at), /already been reported/);
    assert.match(E.validateReport(p, { ...closedChoice, status: 'challenged' }, 'a', null, at), /already been reported/);
    assert.match(E.validateReport(p, { ...closedChoice, status: 'resolved' }, 'a', null, at), /resolved/);
    assert.match(E.validateReport(p, { ...closedChoice, status: 'void' }, 'a', null, at), /voided/);
    assert.match(E.validateReport(null, closedChoice, 'a', null, at), /log in/i);
    assert.match(E.validateReport(p, null, 'a', null, at), /not found/i);
    assert.match(E.validateReport(p, closedChoice, 'zz', null, at), /unknown option/i);
  });
  test('bond required', () => {
    assert.match(E.validateReport(player({ balance: 19 }), closedChoice, 'a', null, at), /Not enough sonnetous/);
    assert.equal(E.validateReport(player({ balance: 20 }), closedChoice, 'a', null, at), null);
  });
  test('timer: eventAt window and bucket', () => {
    const t = timerMarket({ createdBy: 'u1' });
    const now = NOW + 3 * DAY_MS;
    const p = player();
    assert.equal(E.validateReport(p, t, 'd4', NOW + 2 * DAY_MS, now), null);
    assert.equal(E.validateReport(p, t, 'd4', NOW + DAY_MS, now), null);           // lower edge inclusive
    assert.match(E.validateReport(p, t, 'd1', NOW + DAY_MS, now), /doesn't fit/);  // upper edge exclusive
    assert.equal(E.validateReport(p, t, 'd1', NOW + DAY_MS - 1, now), null);
    assert.match(E.validateReport(p, t, 'd4', NOW - 1, now), /before the market opened/);
    assert.equal(E.validateReport(p, t, 'd1', NOW, now), null);                    // eventAt == openedAt
    assert.match(E.validateReport(p, t, 'd4', now + 1, now), /future/);
    assert.equal(E.validateReport(p, t, 'd4', now, now), null);                    // eventAt == now
    assert.match(E.validateReport(p, t, 'd4', null, now), /when it happened/);
    assert.match(E.validateReport(p, t, 'd4', NaN, now), /when it happened/);
    // reportable immediately after opening (before betting closes)
    assert.equal(E.validateReport(p, t, 'd1', NOW, NOW), null);
    // open-ended bucket
    assert.equal(E.validateReport(p, t, 'never', NOW + 9 * DAY_MS, NOW + 10 * DAY_MS), null);
  });
});

describe('validateChallenge', () => {
  const m = reported();
  const p = player({ uid: 'u3' });
  test('window boundary is exclusive at reportedAt + 12h', () => {
    assert.equal(E.validateChallenge(p, m, m.reportedAt + E.CHALLENGE_WINDOW_MS - 1), null);
    assert.equal(E.validateChallenge(p, m, m.reportedAt + E.CHALLENGE_WINDOW_MS), 'The challenge window has closed');
  });
  test('errors', () => {
    const t = m.reportedAt + 1;
    assert.match(E.validateChallenge(null, m, t), /log in/i);
    assert.match(E.validateChallenge(p, null, t), /not found/i);
    assert.match(E.validateChallenge(p, base(), t), /no reported result/);
    assert.match(E.validateChallenge(p, challenged(), t), /already been challenged/);
    assert.match(E.validateChallenge(player({ uid: 'u2' }), m, t), /own report/);
    assert.match(E.validateChallenge(player({ uid: 'u3', balance: 19 }), m, t), /Not enough sonnetous/);
    assert.equal(E.validateChallenge(player({ uid: 'u3', balance: 20 }), m, t), null);
  });
});

describe('validateVote', () => {
  const m = challenged();
  const p = player({ uid: 'u4' });
  const ok = { hasStake: false, hasVoted: false };
  test('window boundary is exclusive at challengedAt + 24h', () => {
    assert.equal(E.validateVote(p, m, ok, m.challengedAt + E.VOTE_WINDOW_MS - 1), null);
    assert.equal(E.validateVote(p, m, ok, m.challengedAt + E.VOTE_WINDOW_MS), 'The voting window has closed');
  });
  test('eligibility', () => {
    const t = m.challengedAt + 1;
    assert.equal(E.validateVote(p, m, { hasStake: true, hasVoted: false }, t), "You bet on this market, so you can't vote");
    assert.match(E.validateVote(p, m, { hasStake: false, hasVoted: true }, t), /already voted/);
    assert.match(E.validateVote(player({ uid: 'u2' }), m, ok, t), /can't vote/);
    assert.match(E.validateVote(player({ uid: 'u3' }), m, ok, t), /can't vote/);
    assert.match(E.validateVote(p, reported(), ok, t), /not under dispute/);
    assert.match(E.validateVote(null, m, ok, t), /log in/i);
    assert.match(E.validateVote(p, null, ok, t), /not found/i);
  });
});

describe('finalizeOutcome', () => {
  test('nothing to do for open non-expired and final markets', () => {
    assert.equal(E.finalizeOutcome(base(), NOW + 99 * DAY_MS), null);
    assert.equal(E.finalizeOutcome({ ...base(), status: 'resolved' }, NOW + 99 * DAY_MS), null);
    assert.equal(E.finalizeOutcome({ ...base(), status: 'void' }, NOW + 99 * DAY_MS), null);
    assert.equal(E.finalizeOutcome(null, NOW), null);
  });
  test('timer expiry at exactly expiresAt', () => {
    const t = timerMarket();
    assert.equal(E.finalizeOutcome(t, t.expiresAt - 1), null);
    assert.deepEqual(E.finalizeOutcome(t, t.expiresAt), { status: 'resolved', resolvedOptionId: 'never', eventAt: null });
  });
  test('unchallenged report finalizes at reportedAt + 12h (choice, fixed)', () => {
    const m = reported({ mode: 'fixed' });
    assert.equal(E.finalizeOutcome(m, m.reportedAt + E.CHALLENGE_WINDOW_MS - 1), null);
    assert.deepEqual(E.finalizeOutcome(m, m.reportedAt + E.CHALLENGE_WINDOW_MS),
      { status: 'resolved', resolvedOptionId: 'a', eventAt: null });
  });
  test('reported timer keeps the reported eventAt', () => {
    const m = { ...timerMarket(), status: 'reported', reportedOptionId: 'd4', reportedEventAt: NOW + 2 * DAY_MS, reportedAt: NOW + 3 * DAY_MS };
    assert.deepEqual(E.finalizeOutcome(m, m.reportedAt + E.CHALLENGE_WINDOW_MS),
      { status: 'resolved', resolvedOptionId: 'd4', eventAt: NOW + 2 * DAY_MS });
  });
  test('pool with no stake on the reported option is void', () => {
    const m = reported({ optionTotals: { a: 0, b: 50 }, totalPool: 50 });
    assert.deepEqual(E.finalizeOutcome(m, m.reportedAt + E.CHALLENGE_WINDOW_MS), { status: 'void', resolvedOptionId: null, eventAt: null });
    const ok = reported({ optionTotals: { a: 1, b: 50 }, totalPool: 51 });
    assert.equal(E.finalizeOutcome(ok, ok.reportedAt + E.CHALLENGE_WINDOW_MS).status, 'resolved');
  });
  test('challenged: uphold > overturn resolves, otherwise void, only after 24h', () => {
    const at = (m) => m.challengedAt + E.VOTE_WINDOW_MS;
    const up = challenged({ votesUphold: 2, votesOverturn: 1, optionTotals: { a: 5, b: 5 }, totalPool: 10 });
    assert.equal(E.finalizeOutcome(up, at(up) - 1), null);
    assert.deepEqual(E.finalizeOutcome(up, at(up)), { status: 'resolved', resolvedOptionId: 'a', eventAt: null });
    const down = challenged({ votesUphold: 1, votesOverturn: 2, optionTotals: { a: 5, b: 5 }, totalPool: 10 });
    assert.deepEqual(E.finalizeOutcome(down, at(down)), { status: 'void', resolvedOptionId: null, eventAt: null });
    const tie = challenged({ votesUphold: 1, votesOverturn: 1 });
    assert.equal(E.finalizeOutcome(tie, at(tie)).status, 'void');
    const none = challenged();
    assert.equal(E.finalizeOutcome(none, at(none)).status, 'void');
    const zeroPool = challenged({ votesUphold: 3, votesOverturn: 0, optionTotals: { a: 0, b: 5 }, totalPool: 5 });
    assert.equal(E.finalizeOutcome(zeroPool, at(zeroPool)).status, 'void');
  });
});

describe('betClaim', () => {
  const resolvedFixed = fixedMarket({ status: 'resolved', resolvedOptionId: 'a' });
  const resolvedPool = base({ status: 'resolved', resolvedOptionId: 'a', optionTotals: { a: 100, b: 300 }, totalPool: 400 });
  test('refuses unsettled markets', () => {
    assert.throws(() => E.betClaim(bet(), base(), player(), NOW), /not been settled/);
    assert.throws(() => E.betClaim(bet(), reported(), player(), NOW), /not been settled/);
  });
  test('void refunds the stake untaxed', () => {
    const p = player({ penaltyUntil: NOW + DAY_MS });
    assert.deepEqual(E.betClaim(bet(), { ...base(), status: 'void' }, p, NOW), { status: 'void', payout: 100, taxed: 0 });
  });
  test('loser gets nothing', () => {
    assert.deepEqual(E.betClaim(bet({ optionId: 'b' }), resolvedFixed, player(), NOW), { status: 'lost', payout: 0, taxed: 0 });
  });
  test('fixed odds use the locked bet odds, with float epsilon', () => {
    assert.deepEqual(E.betClaim(bet({ odds: 2.5 }), resolvedFixed, player(), NOW), { status: 'won', payout: 250, taxed: 0 });
    assert.equal(E.betClaim(bet({ odds: 1.15 }), resolvedFixed, player(), NOW).payout, 115);
    assert.equal(E.betClaim(bet({ amount: 7, odds: 1.3 }), resolvedFixed, player(), NOW).payout, 9);
    // falls back to market odds when the bet has none
    assert.equal(E.betClaim(bet({ odds: null }), resolvedFixed, player(), NOW).payout, 250);
  });
  test('pool payout is floor(amount * pool / winnerTotal)', () => {
    assert.deepEqual(E.betClaim(bet({ amount: 100 }), resolvedPool, player(), NOW), { status: 'won', payout: 400, taxed: 0 });
    assert.equal(E.betClaim(bet({ amount: 30 }), resolvedPool, player(), NOW).payout, 120);
    const odd = base({ status: 'resolved', resolvedOptionId: 'a', optionTotals: { a: 3, b: 4 }, totalPool: 7 });
    assert.equal(E.betClaim(bet({ amount: 1 }), odd, player(), NOW).payout, 2);   // floor(7/3)
    assert.equal(E.betClaim(bet({ amount: 2 }), odd, player(), NOW).payout, 4);   // floor(14/3)
  });
  test('tax: only on profit, only while penalty active (strict), only when gross > amount', () => {
    const until = NOW + 1000;
    const taxedP = player({ penaltyUntil: until });
    assert.deepEqual(E.betClaim(bet({ odds: 2.5 }), resolvedFixed, taxedP, NOW), { status: 'won', payout: 250 - 37, taxed: 37 }); // floor(150*.25)
    assert.deepEqual(E.betClaim(bet({ odds: 2.5 }), resolvedFixed, taxedP, until - 1), { status: 'won', payout: 213, taxed: 37 });
    assert.deepEqual(E.betClaim(bet({ odds: 2.5 }), resolvedFixed, taxedP, until), { status: 'won', payout: 250, taxed: 0 });
    assert.deepEqual(E.betClaim(bet({ odds: 2.5 }), resolvedFixed, player({ penaltyUntil: null }), NOW), { status: 'won', payout: 250, taxed: 0 });
    // no profit -> no tax
    const evenPool = base({ status: 'resolved', resolvedOptionId: 'a', optionTotals: { a: 100 }, totalPool: 100 });
    assert.deepEqual(E.betClaim(bet(), evenPool, taxedP, NOW), { status: 'won', payout: 100, taxed: 0 });
    // tiny profit floors to zero tax
    const tiny = base({ status: 'resolved', resolvedOptionId: 'a', optionTotals: { a: 100, b: 3 }, totalPool: 103 });
    assert.deepEqual(E.betClaim(bet(), tiny, taxedP, NOW), { status: 'won', payout: 103, taxed: 0 });
    // pool profit taxed
    assert.deepEqual(E.betClaim(bet(), resolvedPool, taxedP, NOW), { status: 'won', payout: 400 - 75, taxed: 75 });
    // losing and void are never taxed
    assert.equal(E.betClaim(bet({ optionId: 'b' }), resolvedFixed, taxedP, NOW).taxed, 0);
  });
});

describe('bondClaims', () => {
  const fin = (over) => ({ ...reported(), status: 'resolved', ...over });
  test('nothing before the market is final or when nobody reported', () => {
    assert.deepEqual(E.bondClaims(reported()), { reporter: 0, challenger: 0 });
    assert.deepEqual(E.bondClaims(challenged()), { reporter: 0, challenger: 0 });
    assert.deepEqual(E.bondClaims({ ...base(), status: 'resolved' }), { reporter: 0, challenger: 0 });
    assert.deepEqual(E.bondClaims({ ...base(), status: 'void' }), { reporter: 0, challenger: 0 });
  });
  test('unchallenged: reporter gets the bond back (also when pool-void)', () => {
    assert.deepEqual(E.bondClaims(fin()), { reporter: 20, challenger: 0 });
    assert.deepEqual(E.bondClaims(fin({ status: 'void' })), { reporter: 20, challenger: 0 });
  });
  test('challenged and upheld: reporter takes both', () => {
    assert.deepEqual(E.bondClaims(fin({ challengedBy: 'u3', votesUphold: 2, votesOverturn: 1 })), { reporter: 40, challenger: 0 });
  });
  test('challenged and overturned: challenger takes both', () => {
    assert.deepEqual(E.bondClaims(fin({ status: 'void', challengedBy: 'u3', votesUphold: 0, votesOverturn: 1 })), { reporter: 0, challenger: 40 });
  });
  test('tie / no votes: both refunded', () => {
    assert.deepEqual(E.bondClaims(fin({ status: 'void', challengedBy: 'u3', votesUphold: 1, votesOverturn: 1 })), { reporter: 20, challenger: 20 });
    assert.deepEqual(E.bondClaims(fin({ status: 'void', challengedBy: 'u3' })), { reporter: 20, challenger: 20 });
  });
  test('bond money is conserved', () => {
    for (const [u, o] of [[0, 0], [1, 0], [0, 1], [3, 3], [2, 5]]) {
      const r = E.bondClaims(fin({ status: 'void', challengedBy: 'u3', votesUphold: u, votesOverturn: o }));
      assert.equal(r.reporter + r.challenger, 40);
    }
  });
});

describe('bankruptcy', () => {
  test('netWorth and isBroke', () => {
    assert.equal(E.netWorth(player({ balance: 40, openStake: 60 })), 100);
    assert.equal(E.isBroke(player({ balance: 0, openStake: 0 })), true);
    assert.equal(E.isBroke(player({ balance: 0.5, openStake: 0 })), true);
    assert.equal(E.isBroke(player({ balance: 1, openStake: 0 })), false);
    assert.equal(E.isBroke(player({ balance: 0, openStake: 5 })), false);
  });
  test('canClaimRestart: next UTC midnight after brokeSince', () => {
    const since = Date.UTC(2026, 5, 15, 23, 59, 59);
    const midnight = Date.UTC(2026, 5, 16);
    const p = player({ balance: 0, brokeSince: since });
    assert.equal(E.canClaimRestart(p, midnight - 1), false);
    assert.equal(E.canClaimRestart(p, midnight), true);
    assert.equal(E.canClaimRestart(player({ balance: 0, brokeSince: Date.UTC(2026, 5, 15, 0, 0, 0) }), midnight - 1), false);
    assert.equal(E.restartAvailableAt(p), midnight);
    assert.equal(E.restartAvailableAt(player()), null);
    assert.equal(E.canClaimRestart(player({ balance: 0, brokeSince: null }), NOW), false);
    assert.equal(E.canClaimRestart(player({ balance: 50, brokeSince: since }), midnight), false);
    assert.equal(E.canClaimRestart(player({ balance: 0, openStake: 3, brokeSince: since }), midnight), false);
  });
  test('restartPatch and penaltyActive', () => {
    const p = player({ balance: 0, bankruptcies: 2 });
    assert.deepEqual(E.restartPatch(p, NOW), { balance: 100, bankruptcies: 3, brokeSince: null, penaltyUntil: NOW + 3 * DAY_MS });
    assert.equal(E.penaltyActive(player({ penaltyUntil: NOW + 1 }), NOW), true);
    assert.equal(E.penaltyActive(player({ penaltyUntil: NOW }), NOW), false);
    assert.equal(E.penaltyActive(player(), NOW), false);
  });
});

describe('buildCustomMarket', () => {
  const args = (over = {}) => ({
    id: 'm9', player: player(), now: NOW, title: '  Will it snow?  ', description: ' d ', kind: 'choice',
    optionLabels: ['Yes', ' No ', ''], closesAt: NOW + DAY_MS, ...over,
  });
  test('choice => pool, fully normalised', () => {
    const m = E.buildCustomMarket(args());
    assert.equal(m.title, 'Will it snow?');
    assert.equal(m.mode, 'pool');
    assert.deepEqual(m.options, [{ id: 'o1', label: 'Yes', odds: null }, { id: 'o2', label: 'No', odds: null }]);
    assert.deepEqual(m.optionIds, ['o1', 'o2']);
    assert.equal(m.oddsById, null);
    assert.equal(m.createdBy, 'u1');
    assert.equal(m.type, 'custom');
    assert.equal(m.status, 'open');
    assert.equal(m.reportableAt, NOW + DAY_MS);
    assert.equal(E.validateCreateMarket(player(), m, NOW), null);
  });
  test('accepts legacy `user` arg', () => {
    assert.equal(E.buildCustomMarket(args({ player: undefined, user: player({ uid: 'z' }) })).createdBy, 'z');
  });
  test('timer => fixed, default buckets, default close 12h', () => {
    const m = E.buildCustomMarket(args({ kind: 'timer', closesAt: undefined, optionLabels: undefined }));
    assert.equal(m.mode, 'fixed');
    assert.equal(m.closesAt, NOW + 12 * HOUR_MS);
    assert.equal(m.expiresAt, NOW + 8 * DAY_MS);
    assert.equal(m.expiryOptionId, 'never');
    assert.equal(m.reportableAt, NOW);
    assert.equal(E.validateCreateMarket(player(), m, NOW), null);
  });
  test('validation errors', () => {
    assert.throws(() => E.buildCustomMarket(args({ title: 'ab' })), /at least 3/);
    assert.throws(() => E.buildCustomMarket(args({ title: 'x'.repeat(141) })), /at most 140/);
    assert.throws(() => E.buildCustomMarket(args({ kind: 'nope' })), /kind/);
    assert.throws(() => E.buildCustomMarket(args({ optionLabels: ['only'] })), /at least 2/);
    assert.throws(() => E.buildCustomMarket(args({ optionLabels: ['1', '2', '3', '4', '5', '6', '7'] })), /At most 6/);
    assert.throws(() => E.buildCustomMarket(args({ optionLabels: ['a', 'A'] })), /unique/);
    assert.throws(() => E.buildCustomMarket(args({ closesAt: NOW })), /future/);
    assert.throws(() => E.buildCustomMarket(args({ closesAt: undefined })), /closing time/i);
  });
});

describe('houseMarketMismatch', () => {
  const tpl = () => ({
    ...fixedMarket({ kind: 'choice', createdBy: 'house', type: 'auto', id: 'auto-2026-06-15-x', title: 'Coin flip' }),
  });
  test('identical markets (even built at different times) match', () => {
    const a = tpl();
    const later = E.normalizeMarket({ ...tpl(), openedAt: NOW + 5000, closesAt: NOW + 5000 + HOUR_MS, reportableAt: undefined });
    assert.equal(E.houseMarketMismatch(later, a), null);
  });
  test('detects tampering', () => {
    const a = tpl();
    assert.match(E.houseMarketMismatch({ ...a, title: 'Free money' }, a), /Title/);
    assert.match(E.houseMarketMismatch({ ...a, oddsById: { a: 20, b: 1.5 } }, a), /Odds/);
    assert.match(E.houseMarketMismatch({ ...a, options: [a.options[0]] }, a), /Options/);
    assert.match(E.houseMarketMismatch({ ...a, options: [{ ...a.options[0], label: 'X' }, a.options[1]] }, a), /labels/);
    assert.match(E.houseMarketMismatch({ ...a, closesAt: a.closesAt + 1 }, a), /window/);
    assert.match(E.houseMarketMismatch({ ...a, mode: 'pool' }, a), /Mode/);
    assert.match(E.houseMarketMismatch({ ...a, createdBy: 'u1' }, a), /house/);
    assert.match(E.houseMarketMismatch({ ...a, kind: 'timer' }, a), /Kind/);
    assert.ok(E.houseMarketMismatch(null, a));
  });
  test('timer buckets are compared', () => {
    const a = timerMarket({ createdBy: 'house', type: 'auto' });
    const b = timerMarket({ createdBy: 'house', type: 'auto' });
    assert.equal(E.houseMarketMismatch(b, a), null);
    b.bucketsById = { ...b.bucketsById, d1: { fromMs: 0, toMs: 5 } };
    assert.match(E.houseMarketMismatch(b, a), /buckets/);
  });
  test('oracle markets ignore baseline-dependent title/labels/params', () => {
    const o = (title, thr) => ({ ...tpl(), title, oracle: { type: 'price_above', params: { threshold: thr }, source: 's', label: 'l' } });
    assert.equal(E.houseMarketMismatch(o('BTC above 65k?', 65000), o('BTC above 66k?', 66000)), null);
    assert.match(E.houseMarketMismatch({ ...o('a', 1), oracle: null }, o('a', 1)), /Oracle/);
  });
});

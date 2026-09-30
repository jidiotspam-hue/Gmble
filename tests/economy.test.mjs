import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/economy.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const { DAY_MS, HOUR_MS } = E;

function user(over = {}) {
  return { ...E.newUser('u1', 'alice', NOW), ...over };
}
function fixedMarket(over = {}) {
  return {
    id: 'm1', type: 'custom', templateId: null, kind: 'choice', mode: 'fixed', title: 'T', description: '',
    category: 'x', emoji: 'x', createdBy: 'u9', createdByName: 'bob',
    openedAt: NOW, closesAt: NOW + HOUR_MS,
    options: [{ id: 'a', label: 'A', odds: 2.5 }, { id: 'b', label: 'B', odds: 1.5 }],
    optionTotals: { a: 0, b: 0 }, totalPool: 0, betCount: 0,
    status: 'open', resolvedOptionId: null, resolvedAt: null, resolvedBy: null, eventAt: null,
    ...over,
  };
}
function poolMarket(over = {}) {
  return fixedMarket({
    mode: 'pool',
    options: [{ id: 'a', label: 'A', odds: null }, { id: 'b', label: 'B', odds: null }],
    ...over,
  });
}
function timerMarket(over = {}) {
  return {
    ...fixedMarket({ kind: 'timer', options: E.DEFAULT_TIMER_BUCKETS.map((o) => ({ ...o })) }),
    optionTotals: { d1: 0, d4: 0, d8: 0, never: 0 },
    ...over,
  };
}
function bet(over = {}) {
  return {
    id: 'b1', marketId: 'm1', marketTitle: 'T', uid: 'u1', username: 'alice', optionId: 'a', optionLabel: 'A',
    amount: 100, odds: null, placedAt: NOW, status: 'open', payout: 0, taxed: 0, ...over,
  };
}

describe('constants and formatting', () => {
  test('constants', () => {
    assert.equal(E.STARTING_BALANCE, 500);
    assert.equal(E.RESTART_BALANCE, 100);
    assert.equal(E.MIN_BET, 1);
    assert.equal(E.DAY_MS, 86_400_000);
    assert.equal(E.HOUR_MS, 3_600_000);
    assert.equal(E.PENALTY_DAYS, 3);
    assert.equal(E.PENALTY_TAX, 0.25);
    assert.equal(E.DEFAULT_TIMER_CLOSE_HOURS, 12);
    assert.deepEqual(E.CURRENCY, { name: 'sonnetous', symbol: '§' });
  });

  test('default buckets', () => {
    const b = E.DEFAULT_TIMER_BUCKETS;
    assert.deepEqual(b.map((x) => x.id), ['d1', 'd4', 'd8', 'never']);
    assert.deepEqual(b.map((x) => x.odds), [6, 3, 1.8, 1.3]);
    assert.equal(b[0].fromDays, 0);
    assert.equal(b[3].toDays, null);
  });

  test('formatSonnetous', () => {
    assert.equal(E.formatSonnetous(1234), '§1,234');
    assert.equal(E.formatSonnetous(0), '§0');
    assert.equal(E.formatSonnetous(-5), '-§5');
    assert.equal(E.formatSonnetous(1234567), '§1,234,567');
  });

  test('dayKey (local) and utcDayKey', () => {
    const ms = new Date(2026, 0, 5, 23, 30).getTime();
    assert.equal(E.dayKey(ms), '2026-01-05');
    assert.equal(E.utcDayKey(Date.UTC(2026, 11, 31, 23, 59, 59)), '2026-12-31');
    assert.equal(E.utcDayKey(Date.UTC(2027, 0, 1, 0, 0, 0)), '2027-01-01');
    assert.match(E.dayKey(), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('newUser', () => {
    assert.deepEqual(E.newUser('u', 'n', 5), {
      uid: 'u', username: 'n', balance: 500, createdAt: 5, bankruptcies: 0, brokeSince: null,
      penaltyUntil: null, totalWagered: 0, totalWon: 0,
    });
  });
});

describe('market phase', () => {
  test('isBettingOpen / marketPhase', () => {
    const m = fixedMarket();
    assert.equal(E.isBettingOpen(m, NOW), true);
    assert.equal(E.isBettingOpen(m, m.closesAt - 1), true);
    assert.equal(E.isBettingOpen(m, m.closesAt), false);
    assert.equal(E.marketPhase(m, NOW), 'open');
    assert.equal(E.marketPhase(m, m.closesAt), 'awaiting');
    assert.equal(E.marketPhase({ ...m, status: 'resolved' }, NOW), 'resolved');
    assert.equal(E.marketPhase({ ...m, status: 'void' }, m.closesAt + 1), 'void');
    assert.equal(E.isBettingOpen({ ...m, status: 'resolved' }, NOW), false);
  });
});

describe('validateBet', () => {
  const m = fixedMarket();
  test('valid bet', () => {
    assert.equal(E.validateBet(user(), m, 'a', 100, NOW), null);
    assert.equal(E.validateBet(user(), m, 'a', 500, NOW), null);
    assert.equal(E.validateBet(user(), m, 'a', 1, NOW), null);
  });
  test('null user', () => {
    assert.equal(typeof E.validateBet(null, m, 'a', 10, NOW), 'string');
  });
  test('closed market', () => {
    assert.match(E.validateBet(user(), m, 'a', 10, m.closesAt), /closed/i);
    assert.match(E.validateBet(user(), m, 'a', 10, m.closesAt + DAY_MS), /closed/i);
  });
  test('resolved / void market', () => {
    assert.match(E.validateBet(user(), { ...m, status: 'resolved' }, 'a', 10, NOW), /resolved/i);
    assert.match(E.validateBet(user(), { ...m, status: 'void' }, 'a', 10, NOW), /void/i);
  });
  test('insufficient balance', () => {
    assert.equal(E.validateBet(user(), m, 'a', 501, NOW), 'Not enough sonnetous');
    assert.equal(E.validateBet(user({ balance: 0 }), m, 'a', 1, NOW), 'Not enough sonnetous');
  });
  test('bad amounts', () => {
    for (const bad of [0, -5, 1.5, NaN, Infinity, '10', null, undefined]) {
      assert.equal(typeof E.validateBet(user(), m, 'a', bad, NOW), 'string', `amount ${String(bad)}`);
    }
  });
  test('unknown option', () => {
    assert.match(E.validateBet(user(), m, 'zzz', 10, NOW), /option/i);
    assert.equal(typeof E.validateBet(user(), m, undefined, 10, NOW), 'string');
  });
});

describe('payout math', () => {
  test('fixed potentialPayout floors', () => {
    const m = fixedMarket();
    assert.equal(E.potentialPayout(m, 'a', 100), 250);
    assert.equal(E.potentialPayout(m, 'a', 3), 7); // 7.5
    assert.equal(E.potentialPayout(m, 'b', 1), 1); // 1.5
    assert.equal(E.potentialPayout(fixedMarket({ options: [{ id: 'a', label: 'A', odds: 1.15 }] }), 'a', 100), 115);
  });
  test('pool potentialPayout', () => {
    const m = poolMarket({ optionTotals: { a: 100, b: 300 }, totalPool: 400 });
    // stake 100 on a: 100*(500)/(200) = 250
    assert.equal(E.potentialPayout(m, 'a', 100), 250);
    // empty option: sole winner takes the pool
    const empty = poolMarket({ optionTotals: { a: 0, b: 300 }, totalPool: 300 });
    assert.equal(E.potentialPayout(empty, 'a', 50), 350);
    assert.equal(E.potentialPayout(poolMarket(), 'a', 10), 10);
  });
  test('displayOdds', () => {
    assert.equal(E.displayOdds(fixedMarket(), 'a'), 2.5);
    const m = poolMarket({ optionTotals: { a: 100, b: 300 }, totalPool: 400 });
    assert.equal(E.displayOdds(m, 'a'), 4);
    assert.equal(E.displayOdds(m, 'b'), 400 / 300);
    assert.equal(E.displayOdds(poolMarket(), 'a'), null);
  });
});

describe('buildBet and applyBetToMarket', () => {
  test('fixed bet locks odds', () => {
    const m = fixedMarket();
    const b = E.buildBet({ id: 'x', market: m, user: user(), optionId: 'a', amount: 40, now: NOW });
    assert.deepEqual(b, {
      id: 'x', marketId: 'm1', marketTitle: 'T', uid: 'u1', username: 'alice', optionId: 'a', optionLabel: 'A',
      amount: 40, odds: 2.5, placedAt: NOW, status: 'open', payout: 0, taxed: 0,
    });
  });
  test('pool bet has null odds', () => {
    const b = E.buildBet({ id: 'x', market: poolMarket(), user: user(), optionId: 'b', amount: 5, now: NOW });
    assert.equal(b.odds, null);
    assert.equal(b.optionLabel, 'B');
  });
  test('applyBetToMarket does not mutate', () => {
    const m = fixedMarket({ optionTotals: { a: 10, b: 0 }, totalPool: 10, betCount: 1 });
    const frozen = JSON.stringify(m);
    const patch = E.applyBetToMarket(m, 'a', 25);
    assert.deepEqual(patch, { optionTotals: { a: 35, b: 0 }, totalPool: 35, betCount: 2 });
    assert.equal(JSON.stringify(m), frozen);
    assert.deepEqual(E.applyBetToMarket(m, 'b', 5).optionTotals, { a: 10, b: 5 });
  });
});

describe('timer buckets', () => {
  const m = timerMarket();
  const at = (days) => NOW + days * DAY_MS;
  test('boundaries', () => {
    assert.equal(E.timerBucketFor(m, at(0)), 'd1');
    assert.equal(E.timerBucketFor(m, at(1) - 1), 'd1');
    assert.equal(E.timerBucketFor(m, at(1)), 'd4');
    assert.equal(E.timerBucketFor(m, at(4) - 1), 'd4');
    assert.equal(E.timerBucketFor(m, at(4)), 'd8');
    assert.equal(E.timerBucketFor(m, at(8) - 1), 'd8');
    assert.equal(E.timerBucketFor(m, at(8)), 'never');
    assert.equal(E.timerBucketFor(m, at(400)), 'never');
  });
  test('event before openedAt maps to first bucket', () => {
    assert.equal(E.timerBucketFor(m, NOW - 5 * DAY_MS), 'd1');
  });
  test('fractional (hours-scale) buckets', () => {
    const fast = timerMarket({
      options: [
        { id: 'h6', label: 'Within 6 hours', odds: 7, fromDays: 0, toDays: 0.25 },
        { id: 'd1', label: '6h-1d', odds: 3, fromDays: 0.25, toDays: 1 },
        { id: 'never', label: '1+ d', odds: 1.3, fromDays: 1, toDays: null },
      ],
    });
    assert.equal(E.timerBucketFor(fast, NOW + 5 * HOUR_MS), 'h6');
    assert.equal(E.timerBucketFor(fast, NOW + 6 * HOUR_MS), 'd1');
    assert.equal(E.timerBucketFor(fast, NOW + 24 * HOUR_MS), 'never');
  });
  test('timerAutoResolution', () => {
    assert.equal(E.timerAutoResolution(m, NOW), null);
    assert.equal(E.timerAutoResolution(m, at(8) - 1), null);
    assert.equal(E.timerAutoResolution(m, at(8)), 'never');
    assert.equal(E.timerAutoResolution(m, at(30)), 'never');
    assert.equal(E.timerAutoResolution({ ...m, status: 'resolved' }, at(30)), null);
    assert.equal(E.timerAutoResolution(fixedMarket(), at(30)), null); // choice market
  });
  test('timerAutoResolution respects custom bucket sets', () => {
    const q = timerMarket({
      options: [
        { id: 'h6', label: 'a', odds: 7, fromDays: 0, toDays: 0.25 },
        { id: 'never', label: 'b', odds: 1.3, fromDays: 0.25, toDays: null },
      ],
    });
    assert.equal(E.timerAutoResolution(q, NOW + 5 * HOUR_MS), null);
    assert.equal(E.timerAutoResolution(q, NOW + 6 * HOUR_MS), 'never');
  });
});

describe('settleMarket (fixed)', () => {
  const m = fixedMarket();
  test('winners paid floor(stake*odds), losers zeroed, only open bets touched', () => {
    const bets = [
      bet({ id: 'w', uid: 'u1', optionId: 'a', amount: 3, odds: 2.5 }),
      bet({ id: 'l', uid: 'u2', optionId: 'b', amount: 50, odds: 1.5 }),
      bet({ id: 'old', uid: 'u3', optionId: 'a', amount: 10, odds: 2.5, status: 'lost' }),
      bet({ id: 'other', marketId: 'zzz', uid: 'u4', optionId: 'a', amount: 10, odds: 2.5 }),
    ];
    const users = { u1: user(), u2: user({ uid: 'u2' }) };
    const before = JSON.stringify([m, bets, users]);
    const r = E.settleMarket(m, bets, 'a', users, NOW + 1000, 'alice', NOW + 500);
    assert.deepEqual(r.marketPatch, {
      status: 'resolved', resolvedOptionId: 'a', resolvedAt: NOW + 1000, resolvedBy: 'alice', eventAt: NOW + 500,
    });
    assert.deepEqual(r.betPatches, {
      w: { status: 'won', payout: 7, taxed: 0 }, // floor(7.5)
      l: { status: 'lost', payout: 0, taxed: 0 },
    });
    assert.deepEqual(r.userDeltas, { u1: { balance: 7, totalWon: 7 } });
    assert.equal(JSON.stringify([m, bets, users]), before, 'inputs not mutated');
  });
  test('eventAt defaults to null; multiple winning bets by one user are summed', () => {
    const bets = [
      bet({ id: 'a1', amount: 10, odds: 2 }),
      bet({ id: 'a2', amount: 20, odds: 3 }),
    ];
    const r = E.settleMarket(m, bets, 'a', {}, NOW, 'auto');
    assert.equal(r.marketPatch.eventAt, null);
    assert.deepEqual(r.userDeltas, { u1: { balance: 80, totalWon: 80 } });
  });
  test('no winners: nobody in userDeltas', () => {
    const r = E.settleMarket(m, [bet({ optionId: 'b', odds: 1.5 })], 'a', {}, NOW, 'x');
    assert.deepEqual(r.userDeltas, {});
    assert.equal(r.marketPatch.status, 'resolved');
  });
  test('unknown winning option throws', () => {
    assert.throws(() => E.settleMarket(m, [], 'nope', {}, NOW, 'x'), /option/i);
  });
});

describe('bankruptcy tax', () => {
  const m = fixedMarket();
  const b = bet({ amount: 100, odds: 2.5 }); // payout 250, profit 150, tax floor(37.5)=37
  test('taxed only on profit while penalty active', () => {
    const u = user({ penaltyUntil: NOW + 1000 });
    const r = E.settleMarket(m, [b], 'a', { u1: u }, NOW, 'x');
    assert.deepEqual(r.betPatches.b1, { status: 'won', payout: 213, taxed: 37 });
    assert.deepEqual(r.userDeltas.u1, { balance: 213, totalWon: 213 });
  });
  test('no tax when penalty expired (boundary) or absent', () => {
    for (const penaltyUntil of [NOW, NOW - 1, null]) {
      const r = E.settleMarket(m, [b], 'a', { u1: user({ penaltyUntil }) }, NOW, 'x');
      assert.deepEqual(r.betPatches.b1, { status: 'won', payout: 250, taxed: 0 }, String(penaltyUntil));
    }
  });
  test('unknown user in usersById is untaxed', () => {
    const r = E.settleMarket(m, [b], 'a', {}, NOW, 'x');
    assert.equal(r.betPatches.b1.taxed, 0);
  });
  test('no tax when payout does not exceed stake', () => {
    const even = bet({ amount: 100, odds: 1 });
    const r = E.settleMarket(m, [even], 'a', { u1: user({ penaltyUntil: NOW + 1000 }) }, NOW, 'x');
    assert.deepEqual(r.betPatches.b1, { status: 'won', payout: 100, taxed: 0 });
  });
  test('losers are never taxed', () => {
    const r = E.settleMarket(m, [bet({ optionId: 'b', odds: 1.5 })], 'a',
      { u1: user({ penaltyUntil: NOW + 1000 }) }, NOW, 'x');
    assert.deepEqual(r.betPatches.b1, { status: 'lost', payout: 0, taxed: 0 });
  });
  test('pool payouts are taxed on profit too', () => {
    const pm = poolMarket();
    const bets = [
      bet({ id: 'p1', uid: 'u1', optionId: 'a', amount: 100 }),
      bet({ id: 'p2', uid: 'u2', optionId: 'b', amount: 300 }),
    ];
    const r = E.settleMarket(pm, bets, 'a', { u1: user({ penaltyUntil: NOW + 1 }) }, NOW, 'x');
    // payout 400, profit 300, tax 75
    assert.deepEqual(r.betPatches.p1, { status: 'won', payout: 325, taxed: 75 });
  });
});

describe('settleMarket (pool)', () => {
  test('pro-rata split with flooring', () => {
    const pm = poolMarket();
    const bets = [
      bet({ id: 'p1', uid: 'u1', optionId: 'a', amount: 10 }),
      bet({ id: 'p2', uid: 'u2', optionId: 'a', amount: 20 }),
      bet({ id: 'p3', uid: 'u3', optionId: 'b', amount: 5 }),
    ];
    const r = E.settleMarket(pm, bets, 'a', {}, NOW, 'x');
    // pool 35, winners 30: 10*35/30 = 11.66 -> 11, 20*35/30 = 23.33 -> 23
    assert.deepEqual(r.betPatches.p1, { status: 'won', payout: 11, taxed: 0 });
    assert.deepEqual(r.betPatches.p2, { status: 'won', payout: 23, taxed: 0 });
    assert.deepEqual(r.betPatches.p3, { status: 'lost', payout: 0, taxed: 0 });
    assert.deepEqual(r.userDeltas, { u1: { balance: 11, totalWon: 11 }, u2: { balance: 23, totalWon: 23 } });
    assert.equal(r.marketPatch.status, 'resolved');
  });
  test('void when nobody bet on the winner', () => {
    const pm = poolMarket();
    const bets = [
      bet({ id: 'p1', uid: 'u1', optionId: 'b', amount: 10 }),
      bet({ id: 'p2', uid: 'u2', optionId: 'b', amount: 20 }),
    ];
    const r = E.settleMarket(pm, bets, 'a', {}, NOW, 'x', NOW - 1);
    assert.deepEqual(r.marketPatch, { status: 'void', resolvedOptionId: null, resolvedAt: NOW, resolvedBy: 'x' });
    assert.deepEqual(r.betPatches.p1, { status: 'void', payout: 10, taxed: 0 });
    assert.deepEqual(r.betPatches.p2, { status: 'void', payout: 20, taxed: 0 });
    assert.equal(r.userDeltas.u1.balance, 10);
    assert.equal(r.userDeltas.u2.balance, 20);
    assert.ok(!r.userDeltas.u1.totalWon);
  });
  test('void with no bets at all', () => {
    const r = E.settleMarket(poolMarket(), [], 'a', {}, NOW, 'x');
    assert.equal(r.marketPatch.status, 'void');
    assert.deepEqual(r.betPatches, {});
    assert.deepEqual(r.userDeltas, {});
  });
});

describe('voidMarket', () => {
  test('refunds everyone, only open bets of this market', () => {
    const m = fixedMarket();
    const bets = [
      bet({ id: 'a1', uid: 'u1', amount: 10 }),
      bet({ id: 'a2', uid: 'u1', amount: 15, optionId: 'b' }),
      bet({ id: 'a3', uid: 'u2', amount: 7 }),
      bet({ id: 'done', uid: 'u3', amount: 99, status: 'won', payout: 200 }),
      bet({ id: 'other', marketId: 'zzz', uid: 'u4', amount: 5 }),
    ];
    const r = E.voidMarket(m, bets, NOW, 'alice');
    assert.deepEqual(r.marketPatch, { status: 'void', resolvedOptionId: null, resolvedAt: NOW, resolvedBy: 'alice' });
    assert.deepEqual(Object.keys(r.betPatches).sort(), ['a1', 'a2', 'a3']);
    assert.deepEqual(r.betPatches.a2, { status: 'void', payout: 15, taxed: 0 });
    assert.equal(r.userDeltas.u1.balance, 25);
    assert.equal(r.userDeltas.u2.balance, 7);
    assert.ok(!r.userDeltas.u1.totalWon, 'refunds do not count as winnings');
    assert.ok(!('u3' in r.userDeltas) && !('u4' in r.userDeltas));
  });
});

describe('netWorth / bankruptcy', () => {
  test('netWorth counts only own open bets', () => {
    const bets = [
      bet({ id: '1', amount: 50 }),
      bet({ id: '2', amount: 25, status: 'won', payout: 60 }),
      bet({ id: '3', amount: 10, uid: 'u2' }),
      bet({ id: '4', amount: 5, status: 'lost' }),
    ];
    assert.equal(E.netWorth(user({ balance: 100 }), bets), 150);
    assert.equal(E.netWorth(user({ balance: 100 }), []), 100);
  });

  test('isBroke', () => {
    assert.equal(E.isBroke(user({ balance: 0 }), []), true);
    assert.equal(E.isBroke(user({ balance: 1 }), []), false);
    assert.equal(E.isBroke(user({ balance: 0 }), [bet({ amount: 5 })]), false, 'open bet keeps you alive');
    assert.equal(E.isBroke(user({ balance: 0 }), [bet({ status: 'lost' }), bet({ uid: 'u2' })]), true);
  });

  test('canClaimRestart across a day boundary', () => {
    const today = E.dayKey(NOW);
    const yesterday = E.dayKey(NOW - DAY_MS);
    const tomorrowMs = NOW + DAY_MS;
    const u = user({ balance: 0, brokeSince: today });
    assert.equal(E.canClaimRestart(u, [], NOW), false, 'same day');
    assert.equal(E.canClaimRestart(u, [], tomorrowMs), true, 'next day');
    assert.equal(E.canClaimRestart(user({ balance: 0, brokeSince: yesterday }), [], NOW), true);
    assert.equal(E.canClaimRestart(user({ balance: 0, brokeSince: null }), [], tomorrowMs), false);
    assert.equal(E.canClaimRestart(user({ balance: 5, brokeSince: yesterday }), [], NOW), false, 'not broke');
    assert.equal(E.canClaimRestart(user({ balance: 0, brokeSince: yesterday }), [bet({ amount: 1 })], NOW), false);
  });

  test('restartPatch and penaltyActive', () => {
    const u = user({ balance: 0, bankruptcies: 2, brokeSince: '2026-06-14' });
    const before = JSON.stringify(u);
    const p = E.restartPatch(u, NOW);
    assert.deepEqual(p, { balance: 100, bankruptcies: 3, brokeSince: null, penaltyUntil: NOW + 3 * DAY_MS });
    assert.equal(JSON.stringify(u), before);
    assert.equal(E.penaltyActive({ ...u, penaltyUntil: NOW + 1 }, NOW), true);
    assert.equal(E.penaltyActive({ ...u, penaltyUntil: NOW }, NOW), false);
    assert.equal(E.penaltyActive({ ...u, penaltyUntil: null }, NOW), false);
    assert.equal(E.penaltyActive({ ...u, ...p }, NOW + 3 * DAY_MS - 1), true);
    assert.equal(E.penaltyActive({ ...u, ...p }, NOW + 3 * DAY_MS), false);
  });
});

describe('buildCustomMarket', () => {
  const base = { id: 'c1', user: user(), now: NOW, title: 'Who wins?', description: ' desc ', kind: 'choice',
    optionLabels: ['Red', ' Blue '], closesAt: NOW + DAY_MS };

  test('choice market is pool with o1.. ids', () => {
    const m = E.buildCustomMarket(base);
    assert.equal(m.mode, 'pool');
    assert.equal(m.kind, 'choice');
    assert.equal(m.type, 'custom');
    assert.equal(m.templateId, null);
    assert.deepEqual(m.options, [{ id: 'o1', label: 'Red', odds: null }, { id: 'o2', label: 'Blue', odds: null }]);
    assert.deepEqual(m.optionTotals, { o1: 0, o2: 0 });
    assert.equal(m.totalPool, 0);
    assert.equal(m.betCount, 0);
    assert.equal(m.status, 'open');
    assert.equal(m.createdBy, 'u1');
    assert.equal(m.createdByName, 'alice');
    assert.equal(m.openedAt, NOW);
    assert.equal(m.closesAt, NOW + DAY_MS);
    assert.equal(m.description, 'desc');
    assert.equal(m.resolvedOptionId, null);
    assert.equal(m.eventAt, null);
  });

  test('timer market uses default buckets and 12h close', () => {
    const m = E.buildCustomMarket({ id: 't1', user: user(), now: NOW, title: 'How long till lunch?', kind: 'timer' });
    assert.equal(m.mode, 'fixed');
    assert.deepEqual(m.options, E.DEFAULT_TIMER_BUCKETS);
    assert.equal(m.closesAt, NOW + 12 * HOUR_MS);
    assert.deepEqual(Object.keys(m.optionTotals), ['d1', 'd4', 'd8', 'never']);
    assert.equal(m.description, '');
    const m2 = E.buildCustomMarket({ id: 't2', user: user(), now: NOW, title: 'abc', kind: 'timer', closesAt: NOW + 5 });
    assert.equal(m2.closesAt, NOW + 5);
  });

  test('timer options are copies, not the shared defaults', () => {
    const m = E.buildCustomMarket({ id: 't1', user: user(), now: NOW, title: 'abc', kind: 'timer' });
    m.options[0].odds = 99;
    assert.equal(E.DEFAULT_TIMER_BUCKETS[0].odds, 6);
  });

  test('validation errors', () => {
    const bad = (over, re) => assert.throws(() => E.buildCustomMarket({ ...base, ...over }), re);
    bad({ title: 'ab' }, /title/i);
    bad({ title: '   ' }, /title/i);
    bad({ title: undefined }, /title/i);
    bad({ title: 'x'.repeat(141) }, /title/i);
    bad({ optionLabels: ['Only'] }, /option/i);
    bad({ optionLabels: ['A', ' '] }, /option/i);
    bad({ optionLabels: ['A', 'a'] }, /unique/i);
    bad({ optionLabels: ['1', '2', '3', '4', '5', '6', '7'] }, /option/i);
    bad({ optionLabels: undefined }, /option/i);
    bad({ closesAt: NOW }, /future/i);
    bad({ closesAt: NOW - 1 }, /future/i);
    bad({ closesAt: undefined }, /clos/i);
    bad({ kind: 'weird' }, /kind/i);
    assert.throws(() => E.buildCustomMarket({ ...base, kind: 'timer', closesAt: NOW - 5 }), /future/i);
  });

  test('boundaries accepted', () => {
    assert.doesNotThrow(() => E.buildCustomMarket({ ...base, title: 'abc' }));
    assert.doesNotThrow(() => E.buildCustomMarket({ ...base, title: 'x'.repeat(140) }));
    assert.doesNotThrow(() => E.buildCustomMarket({ ...base, optionLabels: ['1', '2', '3', '4', '5', '6'] }));
  });
});

describe('prng', () => {
  test('mulberry32 deterministic in [0,1)', () => {
    const a = E.mulberry32(42);
    const b = E.mulberry32(42);
    const seqA = Array.from({ length: 50 }, a);
    const seqB = Array.from({ length: 50 }, b);
    assert.deepEqual(seqA, seqB);
    assert.ok(seqA.every((x) => x >= 0 && x < 1));
    assert.notDeepEqual(seqA, Array.from({ length: 50 }, E.mulberry32(43)));
  });
  test('hashString stable 32-bit unsigned', () => {
    assert.equal(E.hashString('2026-06-15'), E.hashString('2026-06-15'));
    assert.notEqual(E.hashString('2026-06-15'), E.hashString('2026-06-16'));
    const h = E.hashString('anything');
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
  });
});

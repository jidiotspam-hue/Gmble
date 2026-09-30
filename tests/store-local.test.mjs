import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLocalStore, MAINTENANCE_MESSAGE, BANNED_MESSAGE } from '../js/store/local.js';
import * as economy from '../js/economy.js';

const { DAY_MS, HOUR_MS, BOND } = economy;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const CODE = 'open-sesame';
const CODE_HASH = createHash('sha256').update(CODE).digest('hex');

// ---------------------------------------------------------------- harness

/** A shared "browser" (one localStorage) with an independent session per acting user. */
function world() {
  const shared = new Map();
  const clock = { t: T0 };
  const tabs = [];
  function storageFor(session) {
    return {
      getItem: (k) => (k.endsWith(':session') ? (session.has(k) ? session.get(k) : null) : (shared.has(k) ? shared.get(k) : null)),
      setItem: (k, v) => { (k.endsWith(':session') ? session : shared).set(k, String(v)); },
      removeItem: (k) => { (k.endsWith(':session') ? session : shared).delete(k); },
    };
  }
  function tab(opts = {}) {
    const s = createLocalStore({ now: () => clock.t, storage: storageFor(new Map()), adminHash: CODE_HASH, ...opts });
    tabs.push(s);
    return s;
  }
  return { shared, clock, tab, storageFor };
}

const first = (store, sub) => { let d; store[sub]((x) => { d = x; })(); return d; };
const me = (store) => first(store, 'onAuthChange');
const players = (store) => first(store, 'subscribePlayers');
const markets = (store) => first(store, 'subscribeMarkets');
const bets = (store) => first(store, 'subscribeBets');
const market = (store, id) => markets(store).find((m) => m.id === id);
const player = (store, name) => players(store).find((p) => p.username === name);
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

/** Store with admin claimed and maintenance turned off. */
async function openWorld() {
  const w = world();
  w.admin = w.tab();
  await w.admin.signUp('admin', 'secret1').catch(() => {});
  await w.admin.claimAdmin(CODE);
  await w.admin.setMaintenance(false);
  return w;
}
async function user(w, name) {
  const s = w.tab();
  await s.signUp(name, 'secret1');
  return s;
}
const advance = (w, ms) => { w.clock.t += ms; };

function poolMarket(w, creatorStore, id = 'm1', over = {}) {
  return economy.buildCustomMarket({
    id, player: me(creatorStore), now: w.clock.t, title: 'Will it rain tomorrow?', description: '',
    kind: 'choice', optionLabels: ['Yes', 'No'], closesAt: w.clock.t + HOUR_MS, ...over,
  });
}
function houseFixed(w, id = 'auto-2026-01-10-coin', odds = { a: 2, b: 2 }) {
  return economy.normalizeMarket({
    id, type: 'auto', templateId: 'coin', kind: 'choice', mode: 'fixed', title: 'Coin flip', description: 'Counts if: heads',
    category: 'Fun', emoji: '🪙', createdBy: 'house', createdByName: 'The House',
    openedAt: w.clock.t, closesAt: w.clock.t + HOUR_MS,
    options: [{ id: 'a', label: 'Heads', odds: odds.a }, { id: 'b', label: 'Tails', odds: odds.b }],
  });
}

/** creator creates a pool market; alice bets 100 on o1, bob 50 on o2; time passes to just after close. */
async function bettingRound(w) {
  const creator = await user(w, 'creator');
  const alice = await user(w, 'alice');
  const bob = await user(w, 'bob');
  await creator.createMarket(poolMarket(w, creator));
  await alice.placeBet('m1', 'o1', 100);
  await bob.placeBet('m1', 'o2', 50);
  advance(w, HOUR_MS);
  return { creator, alice, bob };
}

// ---------------------------------------------------------------- sign-up, maintenance, admin

test('init reports local mode', async () => {
  assert.deepEqual(await world().tab().init(), { mode: 'local' });
});

test('config absent => maintenance: only the admin claim works', async () => {
  const w = world();
  const s = w.tab();
  assert.deepEqual(first(s, 'subscribeConfig'), { exists: false, maintenance: true, adminUid: null });
  await rejects(s.signUp('alice', 'secret1'), new RegExp(MAINTENANCE_MESSAGE));
  // the account exists but cannot play
  assert.equal(me(s), null);
  assert.equal(first(s, 'onSessionChange').username, 'alice');
  await rejects(s.placeBet('x', 'a', 1), new RegExp(MAINTENANCE_MESSAGE));
  await rejects(s.createMarket({}), new RegExp(MAINTENANCE_MESSAGE));
  await rejects(s.setMaintenance(false), /admin/i);
  assert.deepEqual(players(s), []);
  assert.deepEqual(markets(s), []);
});

test('claimAdmin: wrong code, needs a session, works once, admin can play in maintenance', async () => {
  const w = world();
  const anon = w.tab();
  await rejects(anon.claimAdmin(CODE), /sign in/i);
  const a = w.tab();
  await a.signUp('boss', 'secret1').catch(() => {});
  await rejects(a.claimAdmin('wrong'), /not the admin code/);
  assert.equal(first(a, 'subscribeConfig').exists, false);
  await a.claimAdmin(CODE);
  const cfg = first(a, 'subscribeConfig');
  assert.equal(cfg.exists, true);
  assert.equal(cfg.maintenance, true);
  assert.equal(cfg.adminUid, first(a, 'onSessionChange').uid);
  // the admin bypasses maintenance and got a player
  assert.equal(me(a).username, 'boss');
  assert.equal(me(a).balance, 500);
  // nobody else can claim
  const b = w.tab();
  await b.signUp('mallory', 'secret1').catch(() => {});
  await rejects(b.claimAdmin(CODE), /already been claimed/);
  // config is public, even signed out
  assert.equal(first(w.tab(), 'subscribeConfig').adminUid, cfg.adminUid);
});

test('default admin hash comes from js/admin-hash.js (a wrong code is rejected)', async () => {
  const w = world();
  const s = createLocalStore({ now: () => w.clock.t, storage: w.storageFor(new Map()) });
  await s.signUp('boss', 'secret1').catch(() => {});
  await rejects(s.claimAdmin(CODE), /not the admin code/);
});

test('maintenance toggle: blocks everyone but the admin, then reopens', async () => {
  const w = await openWorld();
  const alice = await user(w, 'alice');
  await alice.createMarket(poolMarket(w, alice));
  await rejects(alice.setMaintenance(true), /admin/i);

  await w.admin.setMaintenance(true);
  assert.equal(first(alice, 'subscribeConfig').maintenance, true);
  assert.equal(me(alice), null);
  assert.deepEqual(markets(alice), []);
  await rejects(alice.placeBet('m1', 'o1', 5), new RegExp(MAINTENANCE_MESSAGE));
  await rejects(alice.markBrokeIfNeeded(), new RegExp(MAINTENANCE_MESSAGE));
  await rejects(w.tab().signUp('newbie', 'secret1'), new RegExp(MAINTENANCE_MESSAGE));
  // signing in mid-maintenance keeps the session but throws
  await alice.signOut();
  await rejects(alice.signIn('alice', 'secret1'), new RegExp(MAINTENANCE_MESSAGE));
  assert.equal(first(alice, 'onSessionChange').username, 'alice');
  // admin still plays
  assert.equal(markets(w.admin).length, 1);
  await w.admin.placeBet('m1', 'o1', 5);
  assert.equal((await w.admin.runHousekeeping()) !== undefined, true);

  await w.admin.setMaintenance(false);
  await alice.signIn('alice', 'secret1');
  assert.equal(me(alice).username, 'alice');
  assert.equal(markets(alice).length, 1);
  await w.tab().signUp('fresh_face', 'secret1');
  // the account made during maintenance can now sign in and gets its player
  assert.equal((await w.tab().signIn('newbie', 'secret1')).balance, 500);
});

test('an account created during maintenance gets its player on the first sign-in after reopening', async () => {
  const w = await openWorld();
  await w.admin.setMaintenance(true);
  const late = w.tab();
  await rejects(late.signUp('latecomer', 'secret1'), new RegExp(MAINTENANCE_MESSAGE));
  await w.admin.setMaintenance(false);
  const p = await late.signIn('latecomer', 'secret1');
  assert.equal(p.balance, 500);
  assert.equal(player(w.admin, 'latecomer').uid, p.uid);
});

test('sign up / sign in / sign out', async () => {
  const w = await openWorld();
  const s = w.tab();
  const seen = [];
  const off = s.onAuthChange((p) => seen.push(p && p.username));
  const p = await s.signUp('Alice', 'secret1');
  assert.equal(p.username, 'Alice');
  assert.equal(p.balance, 500);
  assert.equal(p.openStake, 0);
  assert.deepEqual(Object.keys(p).sort(), Object.keys(economy.newPlayer('u', 'n', 0)).sort());
  await s.signOut();
  assert.equal(me(s), null);
  await rejects(s.signIn('alice', 'wrong-pass'), /Invalid username or password/);
  await rejects(s.signIn('nobody', 'secret1'), /Invalid username or password/);
  assert.equal((await s.signIn('ALICE', 'secret1')).username, 'Alice');
  assert.deepEqual(seen, [null, 'Alice', null, 'Alice']);
  off();
  await s.signOut();
  assert.deepEqual(seen, [null, 'Alice', null, 'Alice']); // unsubscribed
});

test('sign-up validation and duplicate handles', async () => {
  const w = await openWorld();
  const s = w.tab();
  await rejects(s.signUp('ab', 'secret1'), /3–20/);
  await rejects(s.signUp('has space', 'secret1'), /3–20/);
  await rejects(s.signUp('a'.repeat(21), 'secret1'), /3–20/);
  await rejects(s.signUp('valid_name', '12345'), /at least 6/);
  await s.signUp('Taken', 'secret1');
  await rejects(w.tab().signUp('taken', 'secret1'), /already taken/);
});

test('data persists across store instances and subscribers get deep clones', async () => {
  const w = await openWorld();
  const alice = await user(w, 'alice');
  await alice.createMarket(poolMarket(w, alice));
  const snap = markets(alice);
  snap[0].title = 'HACKED';
  snap[0].optionTotals.o1 = 9999;
  assert.equal(market(alice, 'm1').title, 'Will it rain tomorrow?');
  assert.equal(market(alice, 'm1').optionTotals.o1, 0);
  const again = createLocalStore({ now: () => w.clock.t, storage: w.storageFor(new Map()), adminHash: CODE_HASH });
  await again.signIn('alice', 'secret1');
  assert.equal(market(again, 'm1').title, 'Will it rain tomorrow?');
});

test('subscriptions fire on change (and only on change)', async () => {
  const w = await openWorld();
  const alice = await user(w, 'alice');
  const calls = [];
  const off = alice.subscribeMarkets((ms) => calls.push(ms.length));
  await alice.createMarket(poolMarket(w, alice));
  await alice.createMarket(poolMarket(w, alice, 'm2'));
  await alice.signOut(); // markets become unreadable
  off();
  assert.deepEqual(calls, [0, 1, 2, 0]);
});

test('multi-tab: a storage event refreshes subscribers (window guarded)', async () => {
  const handlers = [];
  globalThis.window = { addEventListener: (t, h) => { if (t === 'storage') handlers.push(h); } };
  try {
    const w = await openWorld();
    const s1 = w.tab();
    await s1.signUp('one', 'secret1');
    const s2 = w.tab();
    let n = -1;
    s2.subscribeConfig(() => { n++; });
    assert.equal(handlers.length >= 2, true);
    const before = n;
    for (const h of handlers) h({ key: null });
    assert.equal(n, before); // nothing changed => no spurious callback
    const w2 = w.shared.get('sonnetous:v2');
    const db = JSON.parse(w2);
    db.config.maintenance = true; // another tab wrote this
    w.shared.set('sonnetous:v2', JSON.stringify(db));
    for (const h of handlers) h({ key: 'sonnetous:v2' });
    assert.equal(n, before + 1);
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------- betting

test('placeBet updates player, stake doc, market and bet; enforces cooldown', async () => {
  const w = await openWorld();
  const c = await user(w, 'creator');
  const a = await user(w, 'alice');
  await c.createMarket(poolMarket(w, c));
  const bet = await a.placeBet('m1', 'o1', 120);
  assert.equal(bet.amount, 120);
  assert.equal(bet.odds, null);
  assert.equal(bet.status, 'open');
  assert.equal(bet.claimedAt, null);
  const p = me(a);
  assert.equal(p.balance, 380);
  assert.equal(p.openStake, 120);
  assert.equal(p.totalWagered, 120);
  assert.equal(p.lastBetAt, w.clock.t);
  const m = market(a, 'm1');
  assert.deepEqual(m.optionTotals, { o1: 120, o2: 0 });
  assert.equal(m.totalPool, 120);
  assert.equal(m.betCount, 1);
  assert.equal(m.lastBetId, bet.id);
  assert.equal(bets(a).length, 1);

  await rejects(a.placeBet('m1', 'o2', 10), /Slow down — one bet every 2 seconds/);
  advance(w, 1999);
  await rejects(a.placeBet('m1', 'o2', 10), /Slow down/);
  advance(w, 1);
  await a.placeBet('m1', 'o2', 10);
  assert.equal(me(a).openStake, 130);
  assert.deepEqual(market(a, 'm1').optionTotals, { o1: 120, o2: 10 });
});

test('placeBet validation: funds, options, closing time, unknown market, whole numbers', async () => {
  const w = await openWorld();
  const c = await user(w, 'creator');
  const a = await user(w, 'alice');
  await c.createMarket(poolMarket(w, c));
  await rejects(a.placeBet('m1', 'o1', 501), /Not enough sonnetous/);
  await rejects(a.placeBet('m1', 'o9', 5), /Unknown option/);
  await rejects(a.placeBet('m1', 'o1', 0), /Minimum/);
  await rejects(a.placeBet('m1', 'o1', 2.5), /whole number/);
  await rejects(a.placeBet('nope', 'o1', 5), /not found/i);
  assert.equal(me(a).balance, 500);
  await a.placeBet('m1', 'o1', 500); // all-in
  assert.equal(me(a).balance, 0);
  advance(w, HOUR_MS); // exactly at closesAt
  await rejects(a.placeBet('m1', 'o1', 1), /closed/i);
});

test('fixed-odds house market locks the odds on the bet', async () => {
  const w = await openWorld();
  const a = await user(w, 'alice');
  await a.ensureHouseMarkets([houseFixed(w, 'auto-2026-01-10-coin', { a: 2.5, b: 1.5 })]);
  const bet = await a.placeBet('auto-2026-01-10-coin', 'a', 40);
  assert.equal(bet.odds, 2.5);
});

test('signed-out actions ask you to log in', async () => {
  const w = await openWorld();
  const s = w.tab();
  await rejects(s.placeBet('m1', 'o1', 5), /logged in/i);
  await rejects(s.claimRestart(), /logged in/i);
  assert.deepEqual(await s.runHousekeeping(), { finalized: 0, claimed: 0, bonds: 0 });
});

// ---------------------------------------------------------------- market creation

test('createMarket: 5 per UTC day, resets at UTC midnight, creator only', async () => {
  const w = await openWorld();
  w.clock.t = Date.UTC(2026, 0, 10, 23, 0, 0);
  const a = await user(w, 'alice');
  for (let i = 1; i <= 5; i++) await a.createMarket(poolMarket(w, a, `m${i}`));
  assert.equal(me(a).marketsCount, 5);
  assert.equal(me(a).marketsDay, economy.utcDayNumber(w.clock.t));
  await rejects(a.createMarket(poolMarket(w, a, 'm6')), /You can only create 5 markets per day/);
  advance(w, 59 * 60 * 1000 + 59 * 1000 + 999); // 23:59:59.999
  await rejects(a.createMarket(poolMarket(w, a, 'm6')), /5 markets per day/);
  advance(w, 1); // 00:00:00.000 next UTC day
  await a.createMarket(poolMarket(w, a, 'm6'));
  assert.equal(me(a).marketsCount, 1);
  assert.equal(markets(a).length, 6);
});

test('createMarket rejects duplicates, impersonation, tampered totals and house ids', async () => {
  const w = await openWorld();
  const a = await user(w, 'alice');
  const b = await user(w, 'bob');
  const m = poolMarket(w, a);
  assert.equal(await a.createMarket(m), 'm1');
  await rejects(a.createMarket(m), /already exists/);
  await rejects(b.createMarket(poolMarket(w, a, 'm2')), /as yourself/);
  await rejects(a.createMarket({ ...poolMarket(w, a, 'm3'), totalPool: 99 }), /empty pool/);
  await rejects(a.createMarket({ ...poolMarket(w, a, 'm4'), createdBy: 'house', type: 'auto', id: 'auto-2026-01-10-x' }), /house/i);
  await rejects(a.createMarket({ ...poolMarket(w, a, 'm5'), openedAt: w.clock.t - economy.CLOCK_SKEW_MS - 1 }), /clock/i);
  // uncapped attempts did not count toward the daily limit
  assert.equal(me(a).marketsCount, 1);
});

test('ensureHouseMarkets: creates missing ids only, skips invalid odds, needs no daily quota', async () => {
  const w = await openWorld();
  const a = await user(w, 'alice');
  await a.ensureHouseMarkets([houseFixed(w), houseFixed(w, 'auto-2026-01-10-bad', { a: 25, b: 2 }), houseFixed(w, 'not-an-auto-id')]);
  assert.deepEqual(markets(a).map((m) => m.id), ['auto-2026-01-10-coin']);
  advance(w, 5000);
  await a.ensureHouseMarkets([{ ...houseFixed(w), title: 'Replaced' }]); // existing id: untouched
  assert.equal(market(a, 'auto-2026-01-10-coin').title, 'Coin flip');
  assert.equal(me(a).marketsCount, 0);
});

// ---------------------------------------------------------------- report / challenge / vote / finalize

test('only the creator may report a custom market; anyone may report a house market; bond is taken', async () => {
  const w = await openWorld();
  const { creator, alice } = await bettingRound(w);
  await rejects(alice.reportResult('m1', 'o1', null, null), /Only the creator can report this market/);
  await creator.reportResult('m1', 'o1', null, 'https://example.com/proof');
  const m = market(creator, 'm1');
  assert.equal(m.status, 'reported');
  assert.equal(m.reportedBy, me(creator).uid);
  assert.equal(m.reportedByName, 'creator');
  assert.equal(m.reportedOptionId, 'o1');
  assert.equal(m.reportedAt, w.clock.t);
  assert.equal(m.evidence, 'https://example.com/proof');
  assert.equal(me(creator).balance, 500 - BOND);
  assert.equal(me(creator).lastBondMarketId, 'm1');
  await rejects(creator.reportResult('m1', 'o2', null, null), /already been reported/);
  await rejects(alice.placeBet('m1', 'o1', 1), /closed/i);

  // house market: anyone
  await alice.ensureHouseMarkets([houseFixed(w, 'auto-2026-01-10-h1')]);
  advance(w, 2 * HOUR_MS);
  await alice.reportResult('auto-2026-01-10-h1', 'a', null, null);
  assert.equal(market(alice, 'auto-2026-01-10-h1').status, 'reported');
});

test('report validation: too early, unknown option, evidence length, poor reporter', async () => {
  const w = await openWorld();
  const c = await user(w, 'creator');
  await c.createMarket(poolMarket(w, c));
  await rejects(c.reportResult('m1', 'o1', null, null), /too early/i);
  advance(w, HOUR_MS);
  await rejects(c.reportResult('m1', 'zz', null, null), /Unknown option/);
  await rejects(c.reportResult('m1', 'o1', null, 'x'.repeat(301)), /at most 300/);
  await rejects(c.reportResult('nope', 'o1', null, null), /not found/i);
  await c.reportResult('m1', 'o1', null, 'x'.repeat(300));

  const p = await user(w, 'poor');
  await p.createMarket(poolMarket(w, p, 'm2', { closesAt: w.clock.t + 1000 }));
  await p.placeBet('m2', 'o1', 490);
  advance(w, 1000);
  await rejects(p.reportResult('m2', 'o1', null, null), /Not enough sonnetous/);
});

test('challenge: window closes at exactly 12h, reporter cannot challenge, bond taken', async () => {
  const w = await openWorld();
  const { creator, alice, bob } = await bettingRound(w);
  await creator.reportResult('m1', 'o1', null, null);
  await rejects(creator.challengeReport('m1'), /own report/);
  advance(w, 12 * HOUR_MS - 1);
  await bob.challengeReport('m1');
  const m = market(bob, 'm1');
  assert.equal(m.status, 'challenged');
  assert.equal(m.challengedBy, me(bob).uid);
  assert.equal(m.challengedByName, 'bob');
  assert.equal(m.challengedAt, w.clock.t);
  assert.equal(me(bob).balance, 450 - BOND);
  await rejects(alice.challengeReport('m1'), /no reported result|already been challenged/);

  // a second market: window closed exactly at 12h
  const c2 = await user(w, 'cee_two');
  await c2.createMarket(poolMarket(w, c2, 'm2', { closesAt: w.clock.t + 1000 }));
  advance(w, 1000);
  await c2.reportResult('m2', 'o1', null, null);
  advance(w, 12 * HOUR_MS);
  await rejects(alice.challengeReport('m2'), /The challenge window has closed/);
});

test('finalize an unchallenged report: too early throws, then winners and losers claim, reporter bond back', async () => {
  const w = await openWorld();
  const { creator, alice, bob } = await bettingRound(w);
  await creator.reportResult('m1', 'o1', null, null);
  await rejects(alice.finalizeMarket('m1'), /can't be finalized yet/);
  advance(w, 12 * HOUR_MS - 1);
  await rejects(alice.finalizeMarket('m1'), /can't be finalized yet/);
  advance(w, 1);
  const done = await bob.finalizeMarket('m1'); // anyone
  assert.equal(done.status, 'resolved');
  assert.equal(done.resolvedOptionId, 'o1');
  assert.equal(done.resolvedAt, w.clock.t);
  await alice.finalizeMarket('m1'); // idempotent

  const [aliceBet] = bets(alice).filter((b) => b.uid === me(alice).uid);
  const [bobBet] = bets(bob).filter((b) => b.uid === me(bob).uid);
  await rejects(bob.claimBet(aliceBet.id), /not your bet/);
  const won = await alice.claimBet(aliceBet.id);
  assert.deepEqual([won.status, won.payout, won.taxed], ['won', 150, 0]); // floor(100 * 150 / 100)
  assert.equal(won.claimedAt, w.clock.t);
  await rejects(alice.claimBet(aliceBet.id), /already been claimed/);
  const lost = await bob.claimBet(bobBet.id);
  assert.deepEqual([lost.status, lost.payout], ['lost', 0]);
  assert.equal(me(alice).balance, 400 + 150);
  assert.equal(me(alice).openStake, 0);
  assert.equal(me(alice).totalWon, 150);
  assert.equal(me(alice).lastClaimId, aliceBet.id);
  assert.equal(me(bob).balance, 450);
  assert.equal(me(bob).openStake, 0);

  await rejects(bob.claimBond('m1'), /bond/i);
  assert.equal(await creator.claimBond('m1'), BOND);
  assert.equal(me(creator).balance, 500);
  assert.equal(market(creator, 'm1').reporterBondPaid, true);
  await rejects(creator.claimBond('m1'), /already been paid/);
  // total sonnetous conserved: 500*3 before, same after
  assert.equal(players(alice).filter((p) => ['creator', 'alice', 'bob'].includes(p.username)).reduce((s, p) => s + p.balance, 0), 1500);
});

test('claims are refused before the market is settled', async () => {
  const w = await openWorld();
  const { creator, alice } = await bettingRound(w);
  const b = bets(alice)[0];
  await rejects(alice.claimBet(b.id), /not been settled/);
  await creator.reportResult('m1', 'o1', null, null);
  await rejects(alice.claimBet(b.id), /not been settled/);
  await rejects(creator.claimBond('m1'), /not been settled/);
});

async function dispute(w, votes) {
  const round = await bettingRound(w);
  const voters = {};
  for (const name of ['vote1', 'vote2', 'vote3']) voters[name] = await user(w, name);
  await round.creator.reportResult('m1', 'o1', null, null);
  advance(w, HOUR_MS);
  await round.bob.challengeReport('m1'); // bob staked on o2 and disputes o1
  for (const [name, uphold] of votes) await voters[name].voteOnDispute('m1', uphold);
  return { ...round, ...voters };
}

test('dispute: upheld => reporter wins both bonds, bets settle on the reported option', async () => {
  const w = await openWorld();
  const d = await dispute(w, [['vote1', true], ['vote2', true], ['vote3', false]]);
  assert.equal(market(d.alice, 'm1').votesUphold, 2);
  assert.equal(market(d.alice, 'm1').votesOverturn, 1);
  await rejects(d.alice.finalizeMarket('m1'), /can't be finalized yet/);
  advance(w, 24 * HOUR_MS);
  assert.equal((await d.alice.finalizeMarket('m1')).status, 'resolved');
  assert.equal(await d.creator.claimBond('m1'), 2 * BOND);
  assert.equal(await d.bob.claimBond('m1'), 0);
  assert.equal(me(d.creator).balance, 500 + BOND);
  assert.equal(me(d.bob).balance, 450 - BOND);
  await rejects(d.bob.claimBond('m1'), /already been paid/);
  const won = await d.alice.claimBet(bets(d.alice).find((b) => b.uid === me(d.alice).uid).id);
  assert.equal(won.status, 'won');
});

test('dispute: overturned => market void, everyone refunded, challenger wins both bonds', async () => {
  const w = await openWorld();
  const d = await dispute(w, [['vote1', false], ['vote2', false], ['vote3', true]]);
  advance(w, 24 * HOUR_MS);
  const m = await d.alice.finalizeMarket('m1');
  assert.equal(m.status, 'void');
  assert.equal(m.resolvedOptionId, null);
  assert.equal(await d.bob.claimBond('m1'), 2 * BOND);
  assert.equal(await d.creator.claimBond('m1'), 0);
  const refund = await d.alice.claimBet(bets(d.alice).find((b) => b.uid === me(d.alice).uid).id);
  assert.deepEqual([refund.status, refund.payout], ['void', 100]);
  assert.equal(me(d.alice).balance, 500);
  const bobRefund = await d.bob.claimBet(bets(d.bob).find((b) => b.uid === me(d.bob).uid).id);
  assert.equal(bobRefund.payout, 50);
  assert.equal(me(d.bob).balance, 500 - BOND + 2 * BOND);
  assert.equal(me(d.creator).balance, 500 - BOND);
});

test('dispute: tie => void and both bonds returned', async () => {
  const w = await openWorld();
  const d = await dispute(w, [['vote1', true], ['vote2', false]]);
  advance(w, 24 * HOUR_MS);
  assert.equal((await d.alice.finalizeMarket('m1')).status, 'void');
  assert.equal(await d.creator.claimBond('m1'), BOND);
  assert.equal(await d.bob.claimBond('m1'), BOND);
  assert.equal(me(d.creator).balance, 500);
});

test('dispute: no votes => void and both bonds returned', async () => {
  const w = await openWorld();
  const d = await dispute(w, []);
  advance(w, 24 * HOUR_MS - HOUR_MS - 1);
  await rejects(d.alice.finalizeMarket('m1'), /can't be finalized yet/);
  advance(w, 1);
  // (challengedAt was 1h after the report; 24h after it is now)
  advance(w, HOUR_MS);
  assert.equal((await d.alice.finalizeMarket('m1')).status, 'void');
  assert.equal(await d.creator.claimBond('m1'), BOND);
  assert.equal(await d.bob.claimBond('m1'), BOND);
});

test('voting eligibility', async () => {
  const w = await openWorld();
  const d = await dispute(w, [['vote1', true]]);
  await rejects(d.alice.voteOnDispute('m1', true), /You bet on this market, so you can't vote/);
  await rejects(d.bob.voteOnDispute('m1', false), /bet on this market/);
  await rejects(d.creator.voteOnDispute('m1', true), /can't vote/);
  await rejects(d.vote1.voteOnDispute('m1', false), /already voted/);
  assert.deepEqual(first(d.vote1, 'subscribeMyVotes'), ['m1']);
  assert.deepEqual(first(d.vote2, 'subscribeMyVotes'), []);
  // a non-staker who is not a party can vote right up to the last millisecond
  advance(w, 24 * HOUR_MS - 1);
  await d.vote2.voteOnDispute('m1', false);
  advance(w, 1);
  await rejects(d.vote3.voteOnDispute('m1', true), /The voting window has closed/);
  // voting on an undisputed market is refused
  const c = await user(w, 'cee_nine');
  await c.createMarket(poolMarket(w, c, 'm9'));
  await rejects(d.vote3.voteOnDispute('m9', true), /not under dispute/);
  assert.equal(market(d.vote3, 'm1').votesUphold, 1);
  assert.equal(market(d.vote3, 'm1').votesOverturn, 1);
});

test('pool with nobody on the reported option is void, reporter bond returned', async () => {
  const w = await openWorld();
  const { creator, alice, bob } = await bettingRound(w);
  const m = market(creator, 'm1');
  // both bettors are on o1/o2; create a fresh market where only o2 got bets
  await creator.createMarket(poolMarket(w, creator, 'm2', { closesAt: w.clock.t + HOUR_MS }));
  await bob.placeBet('m2', 'o2', 30);
  advance(w, HOUR_MS);
  await creator.reportResult('m2', 'o1', null, null);
  advance(w, 12 * HOUR_MS);
  const fin = await alice.finalizeMarket('m2');
  assert.equal(fin.status, 'void');
  assert.equal(await creator.claimBond('m2'), BOND);
  const refund = await bob.claimBet(bets(bob).find((b) => b.marketId === 'm2').id);
  assert.deepEqual([refund.status, refund.payout], ['void', 30]);
  assert.ok(m);
});

test('voidMarket: creator only, only while nobody has bet', async () => {
  const w = await openWorld();
  const c = await user(w, 'creator');
  const a = await user(w, 'alice');
  await c.createMarket(poolMarket(w, c));
  await c.createMarket(poolMarket(w, c, 'm2'));
  await rejects(a.voidMarket('m1'), /Only the creator/);
  await a.placeBet('m2', 'o1', 10);
  await rejects(c.voidMarket('m2'), /Bets have been placed/);
  await c.voidMarket('m1');
  assert.equal(market(c, 'm1').status, 'void');
  await rejects(c.voidMarket('m1'), /no longer be voided/);
  await rejects(a.placeBet('m1', 'o1', 5), /voided/);
  await rejects(c.voidMarket('nope'), /not found/i);
});

// ---------------------------------------------------------------- timers

test('timer market: bets are judged from their own placedAt; expiry resolves the open-ended bucket', async () => {
  const w = await openWorld();
  const c = await user(w, 'creator');
  const a = await user(w, 'alice');
  const b = await user(w, 'bob');
  const late = await user(w, 'latecomer');
  const tm = economy.buildCustomMarket({ id: 't1', player: me(c), now: w.clock.t, title: 'How long till lunch?', kind: 'timer' });
  await c.createMarket(tm);
  assert.equal(market(c, 't1').expiresAt, tm.closesAt + 8 * DAY_MS);
  const bet1 = await a.placeBet('t1', 'd4', 100); // 3x, window [1d, 4d) after this bet
  const bet2 = await b.placeBet('t1', 'never', 100);
  assert.equal(bet1.odds, 3);
  // 2 days later the creator reports it happened (bets are still open until 12h, so this bet is closed by then)
  advance(w, 2 * DAY_MS);
  const eventAt = w.clock.t - 3 * HOUR_MS;
  await rejects(c.reportResult('t1', null, w.clock.t + 1, null), /future/);
  await rejects(c.reportResult('t1', null, T0 - 1, null), /before the market opened/);
  await rejects(c.reportResult('t1', null, null, null), /when it happened/);
  await c.reportResult('t1', 'd4', eventAt, null); // option id is ignored for timers
  const rep = market(c, 't1');
  assert.equal(rep.reportedEventAt, eventAt);
  assert.equal(rep.reportedOptionId, null);
  advance(w, 12 * HOUR_MS);
  const fin = await b.finalizeMarket('t1');
  assert.deepEqual([fin.status, fin.resolvedOptionId, fin.eventAt], ['resolved', null, eventAt]);
  // event happened (2d - 3h) after both bets => d4 wins, 'never' loses
  const won = await a.claimBet(bet1.id);
  assert.deepEqual([won.status, won.payout], ['won', 300]);
  assert.equal((await b.claimBet(bet2.id)).status, 'lost');
  assert.equal(await c.claimBond('t1'), BOND);
  assert.equal(late && me(late).balance, 500);
});

test('timer market: a bet placed after the event happened is refunded', async () => {
  const w = await openWorld();
  const c = await user(w, 'creator');
  const early = await user(w, 'early');
  const sniper = await user(w, 'sniper');
  await c.createMarket(economy.buildCustomMarket({ id: 't1', player: me(c), now: w.clock.t, title: 'How long till lunch?', kind: 'timer' }));
  const eBet = await early.placeBet('t1', 'd1', 100);
  advance(w, HOUR_MS);
  const eventAt = w.clock.t; // the event happens now...
  advance(w, 10 * 60 * 1000);
  const sBet = await sniper.placeBet('t1', 'd1', 100); // ...and the sniper bets "within 1 day" afterwards
  advance(w, 2 * HOUR_MS);
  await c.reportResult('t1', null, eventAt, null);
  advance(w, 12 * HOUR_MS);
  await early.finalizeMarket('t1');
  assert.deepEqual((({ status, payout }) => ({ status, payout }))(await early.claimBet(eBet.id)), { status: 'won', payout: 600 });
  assert.deepEqual((({ status, payout }) => ({ status, payout }))(await sniper.claimBet(sBet.id)), { status: 'void', payout: 100 });
  assert.equal(me(sniper).balance, 500);
});

test('timer market: eventAt == placedAt still counts for the bet; unreported timer expires to the open-ended bucket', async () => {
  const w = await openWorld();
  const c = await user(w, 'creator');
  const a = await user(w, 'alice');
  const b = await user(w, 'bob');
  await c.createMarket(economy.buildCustomMarket({ id: 't1', player: me(c), now: w.clock.t, title: 'How long till lunch?', kind: 'timer' }));
  const eqBet = await a.placeBet('t1', 'd1', 100);
  await c.reportResult('t1', null, w.clock.t, null); // eventAt == placedAt
  advance(w, 12 * HOUR_MS);
  await a.finalizeMarket('t1');
  assert.equal((await a.claimBet(eqBet.id)).status, 'won');

  const t2 = economy.buildCustomMarket({ id: 't2', player: me(c), now: w.clock.t, title: 'How long till dinner?', kind: 'timer' });
  await c.createMarket(t2);
  const noEvent = await b.placeBet('t2', 'never', 100);
  const lose = await a.placeBet('t2', 'd8', 50);
  advance(w, 12 * HOUR_MS + 8 * DAY_MS - 1);
  await rejects(b.finalizeMarket('t2'), /can't be finalized yet/);
  advance(w, 1);
  const exp = await a.finalizeMarket('t2');
  assert.deepEqual([exp.status, exp.resolvedOptionId, exp.eventAt], ['resolved', 'never', null]);
  const claimed = await b.claimBet(noEvent.id);
  assert.deepEqual([claimed.status, claimed.payout], ['won', 130]);
  assert.equal((await a.claimBet(lose.id)).status, 'lost');
  // an expired, unreported timer has no bond to pay
  await rejects(c.claimBond('t2'), /bond/i);
});

// ---------------------------------------------------------------- bankruptcy

test('bankruptcy => next-UTC-midnight bailout => 25% winnings tax for 3 days', async () => {
  const w = await openWorld();
  w.clock.t = Date.UTC(2026, 0, 10, 20, 0, 0);
  const a = await user(w, 'alice');
  const b = await user(w, 'bob');
  await a.ensureHouseMarkets([houseFixed(w, 'auto-2026-01-10-h1'), houseFixed(w, 'auto-2026-01-10-h2')]);
  await a.placeBet('auto-2026-01-10-h1', 'a', 500); // all in
  await b.placeBet('auto-2026-01-10-h1', 'b', 10);
  advance(w, HOUR_MS);
  await b.reportResult('auto-2026-01-10-h1', 'b', null, 'https://example.com/tails');
  advance(w, 12 * HOUR_MS);

  // not broke while the losing stake is still unclaimed
  await a.markBrokeIfNeeded();
  assert.equal(me(a).brokeSince, null);
  const summary = await a.runHousekeeping();
  assert.deepEqual(summary, { finalized: 1, claimed: 1, bonds: 0 });
  assert.equal(me(a).balance, 0);
  assert.equal(me(a).openStake, 0);
  assert.equal(me(a).brokeSince, w.clock.t); // housekeeping ran markBroke
  await rejects(a.claimRestart(), /midnight UTC/);

  const brokeAt = me(a).brokeSince;
  const midnight = (Math.floor(brokeAt / DAY_MS) + 1) * DAY_MS;
  w.clock.t = midnight - 1;
  await rejects(a.claimRestart(), /midnight UTC/);
  w.clock.t = midnight;
  await a.claimRestart();
  let p = me(a);
  assert.deepEqual([p.balance, p.bankruptcies, p.brokeSince, p.penaltyUntil], [100, 1, null, midnight + 3 * DAY_MS]);
  await rejects(a.claimRestart(), /not broke/i);

  // a winning bet during the penalty: profit is taxed 25%
  await a.ensureHouseMarkets([houseFixed(w, 'auto-2026-01-11-h3', { a: 3, b: 3 })]);
  const won = await a.placeBet('auto-2026-01-11-h3', 'a', 100); // gross 300, profit 200, tax 50
  advance(w, HOUR_MS);
  await b.reportResult('auto-2026-01-11-h3', 'a', null, 'https://example.com/heads');
  advance(w, 12 * HOUR_MS);
  await a.runHousekeeping();
  const claimed = bets(a).find((x) => x.id === won.id);
  assert.deepEqual([claimed.status, claimed.payout, claimed.taxed], ['won', 250, 50]);
  p = me(a);
  assert.equal(p.balance, 250); // 100 bailout - 100 stake + 250 payout
  assert.equal(p.totalWon, 250);

  // after the penalty expires, no tax
  w.clock.t = p.penaltyUntil;
  await a.ensureHouseMarkets([houseFixed(w, 'auto-2026-01-14-h4', { a: 3, b: 3 })]);
  assert.equal(me(a).balance, 250);
  const later = await a.placeBet('auto-2026-01-14-h4', 'a', 100);
  advance(w, HOUR_MS);
  await b.reportResult('auto-2026-01-14-h4', 'a', null, 'https://example.com/heads');
  advance(w, 12 * HOUR_MS);
  await a.runHousekeeping();
  assert.deepEqual([bets(a).find((x) => x.id === later.id).payout, bets(a).find((x) => x.id === later.id).taxed], [300, 0]);
});

test('markBrokeIfNeeded only marks genuinely broke players once', async () => {
  const w = await openWorld();
  const a = await user(w, 'alice');
  const b = await user(w, 'bob');
  await a.markBrokeIfNeeded();
  assert.equal(me(a).brokeSince, null);
  await a.ensureHouseMarkets([houseFixed(w)]);
  await a.placeBet('auto-2026-01-10-coin', 'a', 500);
  await a.markBrokeIfNeeded(); // has an open stake => not broke
  assert.equal(me(a).brokeSince, null);
  advance(w, HOUR_MS);
  await b.reportResult('auto-2026-01-10-coin', 'b', null, null);
  // alice is at 0 balance with an open stake; she loses it once the market settles
  advance(w, 12 * HOUR_MS);
  await a.runHousekeeping();
  const t1 = me(a).brokeSince;
  assert.ok(t1 > 0);
  advance(w, 1000);
  await a.markBrokeIfNeeded();
  assert.equal(me(a).brokeSince, t1);
});

// ---------------------------------------------------------------- housekeeping

test('runHousekeeping finalizes, claims bets and bonds, and reports counts', async () => {
  const w = await openWorld();
  const { creator, alice, bob } = await bettingRound(w);
  await creator.reportResult('m1', 'o1', null, null);
  assert.deepEqual(await alice.runHousekeeping(), { finalized: 0, claimed: 0, bonds: 0 });
  advance(w, 12 * HOUR_MS);
  assert.deepEqual(await alice.runHousekeeping(), { finalized: 1, claimed: 1, bonds: 0 });
  assert.deepEqual(await bob.runHousekeeping(), { finalized: 0, claimed: 1, bonds: 0 });
  assert.deepEqual(await creator.runHousekeeping(), { finalized: 0, claimed: 0, bonds: 1 });
  assert.deepEqual(await creator.runHousekeeping(), { finalized: 0, claimed: 0, bonds: 0 });
  assert.equal(me(alice).balance, 550);
  assert.equal(me(creator).balance, 500);
});

test('runHousekeeping never throws, even when storage fails', async () => {
  const w = await openWorld();
  const a = await user(w, 'alice');
  const bad = createLocalStore({
    now: () => w.clock.t,
    storage: { getItem: () => { throw new Error('boom'); }, setItem: () => { throw new Error('boom'); }, removeItem: () => {} },
  });
  assert.deepEqual(await bad.runHousekeeping(), { finalized: 0, claimed: 0, bonds: 0 });
  assert.ok(me(a));
});

// ---------------------------------------------------------------- bans

test('ban / unban: banned players are blocked on every action', async () => {
  const w = await openWorld();
  const a = await user(w, 'alice');
  const c = await user(w, 'creator');
  await c.createMarket(poolMarket(w, c));
  await a.placeBet('m1', 'o1', 10);
  const uid = me(a).uid;

  await rejects(a.banPlayer(uid, 'x'), /admin/i);
  await rejects(w.admin.banPlayer(first(w.admin, 'subscribeConfig').adminUid, 'lol'), /can't ban the admin/);
  assert.deepEqual(first(a, 'subscribeMyBan'), null);
  advance(w, 5000);
  await w.admin.banPlayer(uid, 'cheating');

  const ban = first(a, 'subscribeMyBan');
  assert.equal(ban.uid, uid);
  assert.equal(ban.username, 'alice');
  assert.equal(ban.reason, 'cheating');
  assert.equal(ban.at, w.clock.t);
  assert.equal(ban.by, first(w.admin, 'onSessionChange').uid);
  assert.equal(me(a), null);
  assert.deepEqual(markets(a), []);
  assert.deepEqual(first(a, 'subscribeBans'), []);
  assert.equal(first(w.admin, 'subscribeBans').length, 1);

  const B = new RegExp(BANNED_MESSAGE);
  await rejects(a.placeBet('m1', 'o1', 5), B);
  await rejects(a.createMarket(poolMarket(w, c, 'mx')), B);
  await rejects(a.reportResult('m1', 'o1', null, null), B);
  await rejects(a.challengeReport('m1'), B);
  await rejects(a.voteOnDispute('m1', true), B);
  await rejects(a.finalizeMarket('m1'), B);
  await rejects(a.voidMarket('m1'), B);
  await rejects(a.claimBet(bets(w.admin)[0].id), B);
  await rejects(a.claimBond('m1'), B);
  await rejects(a.markBrokeIfNeeded(), B);
  await rejects(a.claimRestart(), B);
  await rejects(a.ensureHouseMarkets([]), B);
  assert.deepEqual(await a.runHousekeeping(), { finalized: 0, claimed: 0, bonds: 0 });
  await a.signOut();
  await rejects(a.signIn('alice', 'secret1'), B);

  // others still see alice's history; admin is unaffected
  assert.equal(player(c, 'alice').openStake, 10);
  await w.admin.placeBet('m1', 'o2', 5);

  await rejects(a.unbanPlayer(uid), /admin/i);
  await w.admin.unbanPlayer(uid);
  assert.equal(first(a, 'subscribeMyBan'), null);
  await a.signIn('alice', 'secret1');
  advance(w, 5000);
  await a.placeBet('m1', 'o1', 5);
  assert.equal(me(a).openStake, 15);
  await w.admin.unbanPlayer(uid); // unbanning an unbanned player is a no-op
});

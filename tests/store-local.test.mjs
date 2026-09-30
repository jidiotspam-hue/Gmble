import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore } from '../js/store/local.js';
import * as economy from '../js/economy.js';

const { DAY_MS, HOUR_MS } = economy;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

function shim() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

function setup() {
  const clock = { t: T0 };
  const storage = shim();
  const store = createLocalStore({ now: () => clock.t, storage });
  return { clock, storage, store };
}

async function snapshot(store, sub) {
  let data;
  const off = store[sub]((d) => { data = d; });
  off();
  return data;
}
const getMarket = async (store, id) => (await snapshot(store, 'subscribeMarkets')).find((m) => m.id === id);
const getUser = async (store, name) =>
  (await snapshot(store, 'subscribeUsers')).find((u) => u.username === name);

async function currentUser(store) {
  let u;
  store.onAuthChange((x) => { u = x; })();
  return u;
}

function customMarket(user, now, over = {}) {
  return economy.buildCustomMarket({
    id: over.id || 'm1', user, now, title: 'Will it rain tomorrow?', description: '',
    kind: 'choice', optionLabels: ['Yes', 'No'], closesAt: now + DAY_MS, ...over,
  });
}

function autoTimerMarket(now, id = 'auto-2026-01-10-test') {
  const m = economy.buildCustomMarket({
    id, user: { uid: 'house', username: 'The House' }, now,
    title: 'How long till the test passes?', description: '', kind: 'timer',
  });
  return { ...m, type: 'auto', templateId: 'test', createdBy: 'house', createdByName: 'The House' };
}

test('sign up / sign in', async () => {
  const { store } = setup();
  assert.deepEqual(await store.init(), { mode: 'local' });
  const u = await store.signUp('Alice', 'secret1');
  assert.equal(u.username, 'Alice');
  assert.equal(u.balance, 500);
  assert.equal((await currentUser(store)).uid, u.uid);

  await assert.rejects(store.signUp('alice', 'another1'), /taken/i);
  await assert.rejects(store.signUp('ALICE', 'another1'), /taken/i);
  await assert.rejects(store.signUp('a!', 'secret1'), /username/i);
  await assert.rejects(store.signUp('bobby', '123'), /password/i);

  await store.signOut();
  assert.equal(await currentUser(store), null);
  await assert.rejects(store.signIn('alice', 'wrongpw'), /invalid/i);
  await assert.rejects(store.signIn('nobody', 'secret1'), /invalid/i);
  const again = await store.signIn('ALICE', 'secret1');
  assert.equal(again.uid, u.uid);
  assert.equal((await currentUser(store)).username, 'Alice');
});

test('session persists across store instances sharing storage', async () => {
  const { storage, clock } = setup();
  const a = createLocalStore({ now: () => clock.t, storage });
  const u = await a.signUp('carol', 'secret1');
  const b = createLocalStore({ now: () => clock.t, storage });
  assert.equal((await currentUser(b)).uid, u.uid);
});

test('subscriber data is deep-cloned', async () => {
  const { store } = setup();
  await store.signUp('alice', 'secret1');
  let users;
  store.subscribeUsers((u) => { users = u; })();
  users[0].balance = 999999;
  assert.equal((await getUser(store, 'alice')).balance, 500);
});

test('placing a bet debits balance, updates market totals; cannot overbet', async () => {
  const { store, clock } = setup();
  const alice = await store.signUp('alice', 'secret1');
  await store.createMarket(customMarket(alice, clock.t));

  const seen = [];
  const off = store.onAuthChange((u) => seen.push(u && u.balance));
  const bet = await store.placeBet('m1', 'o1', 100);
  off();
  assert.equal(bet.amount, 100);
  assert.equal(bet.uid, alice.uid);
  assert.equal(bet.status, 'open');
  assert.deepEqual(seen, [500, 400]); // onAuthChange fires on profile change

  const u = await getUser(store, 'alice');
  assert.equal(u.balance, 400);
  assert.equal(u.totalWagered, 100);
  const m = await getMarket(store, 'm1');
  assert.equal(m.totalPool, 100);
  assert.equal(m.optionTotals.o1, 100);
  assert.equal(m.betCount, 1);

  await assert.rejects(store.placeBet('m1', 'o2', 401), /enough/i);
  await assert.rejects(store.placeBet('m1', 'o2', 0));
  await assert.rejects(store.placeBet('m1', 'nope', 5));
  await assert.rejects(store.placeBet('missing', 'o1', 5));
  assert.equal((await getUser(store, 'alice')).balance, 400);

  // betting closed after closesAt
  clock.t += 2 * DAY_MS;
  await assert.rejects(store.placeBet('m1', 'o1', 5), /closed/i);

  // bets feed is newest first
  const bets = await snapshot(store, 'subscribeBets');
  assert.equal(bets.length, 1);
});

test('resolve settles pool market and credits the winner', async () => {
  const { store, clock } = setup();
  const alice = await store.signUp('alice', 'secret1');
  await store.createMarket(customMarket(alice, clock.t));
  await store.signOut();
  await store.signUp('bob', 'secret1');
  await store.placeBet('m1', 'o1', 100);
  await store.signOut();
  await store.signUp('carol', 'secret1');
  await store.placeBet('m1', 'o2', 100);
  await store.signOut();

  await store.signIn('alice', 'secret1');
  await store.resolveMarket('m1', 'o1'); // creator may resolve before closesAt
  const m = await getMarket(store, 'm1');
  assert.equal(m.status, 'resolved');
  assert.equal(m.resolvedOptionId, 'o1');
  assert.equal(m.resolvedBy, 'alice');
  assert.equal((await getUser(store, 'bob')).balance, 600);
  assert.equal((await getUser(store, 'bob')).totalWon, 200);
  assert.equal((await getUser(store, 'carol')).balance, 400);
  const bets = await snapshot(store, 'subscribeBets');
  assert.deepEqual(bets.map((b) => b.status).sort(), ['lost', 'won']);

  // cannot resolve twice
  await assert.rejects(store.resolveMarket('m1', 'o2'), /already/i);
});

test('custom market can only be resolved / voided by its creator', async () => {
  const { store, clock } = setup();
  const alice = await store.signUp('alice', 'secret1');
  await store.createMarket(customMarket(alice, clock.t));
  await store.signOut();
  await store.signUp('bob', 'secret1');
  await assert.rejects(store.resolveMarket('m1', 'o1'), /creator/i);
  await assert.rejects(store.voidMarket('m1'), /creator/i);
  assert.equal((await getMarket(store, 'm1')).status, 'open');
  // cannot create a market on behalf of someone else
  await assert.rejects(store.createMarket(customMarket(alice, clock.t, { id: 'm2' })));
});

test('creator can void a market and everyone is refunded', async () => {
  const { store, clock } = setup();
  const alice = await store.signUp('alice', 'secret1');
  await store.createMarket(customMarket(alice, clock.t));
  await store.placeBet('m1', 'o1', 50);
  await store.signOut();
  await store.signUp('bob', 'secret1');
  await store.placeBet('m1', 'o2', 70);
  assert.equal((await getUser(store, 'bob')).balance, 430);
  await store.signOut();
  await store.signIn('alice', 'secret1');
  await store.voidMarket('m1');
  const m = await getMarket(store, 'm1');
  assert.equal(m.status, 'void');
  assert.equal((await getUser(store, 'alice')).balance, 500);
  assert.equal((await getUser(store, 'bob')).balance, 500);
  const bets = await snapshot(store, 'subscribeBets');
  assert.ok(bets.every((b) => b.status === 'void'));
  await assert.rejects(store.voidMarket('m1'), /already/i);
});

test('ensureMarkets is idempotent and never overwrites existing markets', async () => {
  const { store, clock } = setup();
  await store.signUp('alice', 'secret1');
  const m = autoTimerMarket(clock.t);
  await store.ensureMarkets([m]);
  await store.placeBet(m.id, 'd1', 25);
  await store.ensureMarkets([m, { ...m, id: 'auto-2026-01-10-other' }]);
  await store.ensureMarkets([m]);
  const all = await snapshot(store, 'subscribeMarkets');
  assert.equal(all.length, 2);
  const stored = await getMarket(store, m.id);
  assert.equal(stored.totalPool, 25);
  assert.equal(stored.betCount, 1);
});

test('any user can resolve an auto timer market by reporting eventAt', async () => {
  const { store, clock } = setup();
  const m = autoTimerMarket(clock.t);
  await store.ensureMarkets([m]);
  await store.signUp('alice', 'secret1');
  await store.placeBet(m.id, 'd4', 100); // 1-4 days, odds 3
  await store.signOut();
  await store.signUp('bob', 'secret1');
  clock.t += 2 * DAY_MS;
  await assert.rejects(store.resolveMarket(m.id, null, clock.t + HOUR_MS), /future/i);
  await store.resolveMarket(m.id, null, T0 + 2 * DAY_MS - HOUR_MS);
  const r = await getMarket(store, m.id);
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolvedOptionId, 'd4');
  assert.equal(r.eventAt, T0 + 2 * DAY_MS - HOUR_MS);
  assert.equal(r.resolvedBy, 'bob');
  assert.equal((await getUser(store, 'alice')).balance, 400 + 300);
});

test('autoResolveExpired resolves expired timer market to the open-ended bucket', async () => {
  const { store, clock } = setup();
  const m = autoTimerMarket(clock.t);
  await store.ensureMarkets([m]);
  await store.signUp('alice', 'secret1');
  await store.placeBet(m.id, 'never', 100);
  await store.signOut();
  await store.signUp('bob', 'secret1');
  await store.placeBet(m.id, 'd1', 100);

  clock.t += 3 * DAY_MS;
  await store.autoResolveExpired();
  assert.equal((await getMarket(store, m.id)).status, 'open'); // not expired yet

  clock.t += 6 * DAY_MS; // 9 days after opening
  await store.autoResolveExpired();
  const r = await getMarket(store, m.id);
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolvedOptionId, 'never');
  assert.equal(r.resolvedBy, 'auto');
  assert.equal((await getUser(store, 'alice')).balance, 400 + Math.floor(100 * 1.3));
  assert.equal((await getUser(store, 'bob')).balance, 400);

  await store.autoResolveExpired(); // idempotent
  assert.equal((await getUser(store, 'alice')).balance, 400 + 130);
});

test('broke flow: brokeSince set, claim rejected same day, allowed next day, penalty tax applies', async () => {
  const { store, clock } = setup();
  const m = autoTimerMarket(clock.t);
  await store.ensureMarkets([m]);
  await store.signUp('alice', 'secret1');
  await store.placeBet(m.id, 'd1', 500);

  // open bet => not broke yet
  await store.markBrokeIfNeeded();
  assert.equal((await getUser(store, 'alice')).brokeSince, null);
  await assert.rejects(store.claimRestart());

  // event happens after 5 days => d1 bettor loses everything
  clock.t += 5 * DAY_MS;
  await store.resolveMarket(m.id, null, clock.t);
  assert.equal((await getUser(store, 'alice')).balance, 0);

  await store.markBrokeIfNeeded();
  const broke = await getUser(store, 'alice');
  assert.equal(broke.brokeSince, economy.dayKey(clock.t));

  await assert.rejects(store.claimRestart(), /tomorrow/i);

  clock.t += 36 * HOUR_MS;
  await store.claimRestart();
  const u = await getUser(store, 'alice');
  assert.equal(u.balance, 100);
  assert.equal(u.bankruptcies, 1);
  assert.equal(u.brokeSince, null);
  assert.equal(u.penaltyUntil, clock.t + 3 * DAY_MS);
  await assert.rejects(store.claimRestart());

  // bankruptcy tax: win 100 @ 6x => payout 600, profit 500, tax 125
  const m2 = autoTimerMarket(clock.t, 'auto-2026-01-16-test');
  await store.ensureMarkets([m2]);
  await store.placeBet(m2.id, 'd1', 100);
  clock.t += HOUR_MS;
  await store.resolveMarket(m2.id, null, clock.t);
  const after = await getUser(store, 'alice');
  assert.equal(after.balance, 475);
  const won = (await snapshot(store, 'subscribeBets')).find((b) => b.marketId === m2.id);
  assert.equal(won.status, 'won');
  assert.equal(won.taxed, 125);
  assert.equal(won.payout, 475);
});

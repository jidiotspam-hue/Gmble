// Integration tests for js/store/firebase.js and firestore.rules against the REAL Firestore + Auth
// emulators. They are SKIPPED unless the emulators are running and the npm firebase SDK is available,
// so plain `node --test` (no deps, no network) stays green.
//
// To run them (needs Java 11+ and Node 20+; nothing is installed into the repo):
//   mkdir /tmp/fb && cd /tmp/fb && npm init -y && npm i firebase@10.12.2 firebase-tools
//   cat > firebase.json   # {"firestore":{"rules":"<repo>/firestore.rules"},
//                         #  "emulators":{"auth":{"port":9099},"firestore":{"port":8080},"ui":{"enabled":false}}}
//   npx firebase emulators:start --only auth,firestore --project demo-sonnetous &
//   FB_SDK_DIR=/tmp/fb node --test --test-force-exit tests/firebase-store.test.mjs
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createFirebaseStore } from '../js/store/firebase.js';
import * as economy from '../js/economy.js';

const PROJECT = 'demo-sonnetous';
const EMU_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const [FS_H, FS_P] = EMU_HOST.split(':');

let sdk = null;
let skip = false;
try {
  if (!process.env.FB_SDK_DIR) throw new Error('set FB_SDK_DIR to a directory with node_modules/firebase@10.12.2');
  const req = createRequire(path.join(process.env.FB_SDK_DIR, 'noop.js'));
  sdk = { app: req('firebase/app'), auth: req('firebase/auth'), firestore: req('firebase/firestore') };
  const ping = await fetch(`http://${EMU_HOST}/`, { signal: AbortSignal.timeout(1500) });
  if (!ping.ok) throw new Error('Firestore emulator not reachable');
} catch (err) {
  skip = 'Firebase emulator tests skipped: ' + (err && err.message);
}
const test0 = test;
const it = (name, fn) => test0(name, { skip }, fn);
const fbApp = sdk && sdk.app; const fbAuth = sdk && sdk.auth; const fbFs = sdk && sdk.firestore;
const F = fbFs;

const { DAY_MS, HOUR_MS } = economy;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const emulator = { authUrl: `http://${AUTH_HOST}`, firestoreHost: FS_H, firestorePort: Number(FS_P) };
const config = { apiKey: 'fake', projectId: PROJECT, authDomain: 'x' };
const REST = `http://${EMU_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

let clock = { t: T0 };
let n = 0;
const clients = [];
async function client(label = 'c') {
  const store = await createFirebaseStore(config, { sdk, emulator, appName: `${label}${++n}`, now: () => clock.t });
  clients.push(store);
  await store.init();
  return store;
}

beforeEach(async () => {
  if (skip) return;
  clock = { t: T0 };
  await fetch(`http://${EMU_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
});
after(async () => {
  if (skip) return;
  for (const c of clients) { try { await c.signOut(); } catch {} }
});

// ---- admin-privileged ground truth via REST (Authorization: Bearer owner bypasses rules)
function dec(v) {
  if ('nullValue' in v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  throw new Error('unknown ' + JSON.stringify(v));
}
async function adminList(coll) {
  const out = [];
  let tok = '';
  do {
    const r = await fetch(`${REST}/${coll}?pageSize=300${tok ? '&pageToken=' + tok : ''}`, { headers: { Authorization: 'Bearer owner' } });
    const j = await r.json();
    for (const d of j.documents || []) out.push({ _id: d.name.split('/').pop(), ...dec({ mapValue: { fields: d.fields } }) });
    tok = j.nextPageToken || '';
  } while (tok);
  return out;
}
const adminUser = async (name) => (await adminList('users')).find((u) => u.username === name);
const adminMarket = async (id) => (await adminList('markets')).find((m) => m.id === id);
const adminBets = async (marketId) => (await adminList('bets')).filter((b) => !marketId || b.marketId === marketId);

const currentUser = (store) => new Promise((res) => { const off = store.onAuthChange((u) => { off(); res(u); }); });
const collect = (store) => { const seen = []; const off = store.onAuthChange((u) => seen.push(u)); return { seen, off }; };
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (Date.now() > end) throw e; }
    if (Date.now() > end) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const first = (store, sub, pred = () => true) => until(() => new Promise((res, rej) => {
  let off; let done = false;
  off = store[sub]((d) => { if (!done && pred(d)) { done = true; setTimeout(() => off && off(), 0); res(d); } });
  setTimeout(() => { if (!done) { done = true; off && off(); rej(new Error('no snapshot')); } }, 1500);
}));

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

it('sign up / sign in, no transient null during sign-up', async () => {
  const s = await client();
  assert.deepEqual(await s.init(), { mode: 'firebase' });
  const { seen, off } = collect(s);
  await until(() => seen.length === 1);
  assert.equal(seen[0], null);
  const u = await s.signUp('Alice', 'secret1');
  assert.equal(u.username, 'Alice');
  assert.equal(u.balance, 500);
  await until(() => seen.length >= 2);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(seen.slice(1).every((x) => x && x.uid === u.uid), 'no null after the initial one: ' + JSON.stringify(seen.map((x) => x && x.username)));
  off();
  assert.equal((await currentUser(s)).uid, u.uid);

  await assert.rejects(s.signUp('alice', 'another1'), /taken/i);
  await assert.rejects(s.signUp('a!', 'secret1'), /username/i);
  await assert.rejects(s.signUp('bobby', '123'), /password/i);
  assert.equal((await currentUser(s)).uid, u.uid, 'failed sign-up must not change session');

  await s.signOut();
  assert.equal(await currentUser(s), null);
  await assert.rejects(s.signIn('alice', 'wrongpw'), /invalid username or password/i);
  await assert.rejects(s.signIn('nobody', 'secret1'), /invalid username or password/i);
  const again = await s.signIn('ALICE', 'secret1');
  assert.equal(again.uid, u.uid);
  assert.equal(again.username, 'Alice');
  assert.equal((await currentUser(s)).username, 'Alice');

  // second client, same username in different case
  const s2 = await client();
  await assert.rejects(s2.signUp('ALICE', 'another1'), /taken/i);
  assert.equal(await currentUser(s2), null);
});

it('sign-up rollback: taken username claim (orphan usernames doc) leaves nothing behind', async () => {
  // Orphan usernames/ghost claimed by someone else with no auth account for it.
  const a = await client();
  const alice = await a.signUp('alice', 'secret1');
  // Manually claim 'ghost' -> alice's uid via a raw admin write
  await fetch(`${REST}/usernames?documentId=ghost`, {
    method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { uid: { stringValue: alice.uid } } }),
  });
  const b = await client();
  await assert.rejects(b.signUp('ghost', 'secret1'), /taken/i);
  assert.equal(await currentUser(b), null);
  // auth account rolled back -> can sign up with that name?? still taken by usernames doc, but auth is free
  await assert.rejects(b.signIn('ghost', 'secret1'), /invalid/i);
});

it('placing a bet debits balance, updates market totals; cannot overbet; feed sorted', async () => {
  const s = await client();
  const alice = await s.signUp('alice', 'secret1');
  await s.createMarket(customMarket(alice, clock.t));
  const seen = [];
  const off = s.onAuthChange((u) => seen.push(u && u.balance));
  await until(() => seen.length >= 1);
  const bet = await s.placeBet('m1', 'o1', 100);
  await until(() => seen.includes(400));
  off();
  assert.equal(bet.amount, 100);
  assert.equal(bet.uid, alice.uid);
  assert.equal(bet.status, 'open');
  const u = await adminUser('alice');
  assert.equal(u.balance, 400);
  assert.equal(u.totalWagered, 100);
  const m = await adminMarket('m1');
  assert.equal(m.totalPool, 100);
  assert.equal(m.optionTotals.o1, 100);
  assert.equal(m.betCount, 1);
  await assert.rejects(s.placeBet('m1', 'o2', 401), /enough/i);
  await assert.rejects(s.placeBet('m1', 'o2', 0));
  await assert.rejects(s.placeBet('m1', 'o2', 1.5));
  await assert.rejects(s.placeBet('m1', 'nope', 5));
  await assert.rejects(s.placeBet('missing', 'o1', 5), /not found/i);
  assert.equal((await adminUser('alice')).balance, 400);
  clock.t += 2 * DAY_MS;
  await assert.rejects(s.placeBet('m1', 'o1', 5), /closed/i);
  assert.equal((await adminBets()).length, 1);
});

it('subscriptions: markets newest openedAt first, bets newest placedAt first, users', async () => {
  const s = await client();
  const alice = await s.signUp('alice', 'secret1');
  for (let i = 0; i < 4; i++) {
    clock.t = T0 + i * 1000;
    await s.createMarket(customMarket(alice, clock.t, { id: 'm' + i, closesAt: T0 + 5 * DAY_MS }));
  }
  for (let i = 0; i < 4; i++) { clock.t = T0 + 10000 + i * 1000; await s.placeBet('m' + ((i * 3) % 4), 'o1', 10 + i); }
  const ms = await first(s, 'subscribeMarkets', (d) => d.length === 4);
  assert.deepEqual(ms.map((m) => m.id), ['m3', 'm2', 'm1', 'm0']);
  const bs = await first(s, 'subscribeBets', (d) => d.length === 4);
  assert.deepEqual(bs.map((b) => b.amount), [13, 12, 11, 10]);
  assert.ok(bs.every((b) => b.id && typeof b.id === 'string'));
  const us = await first(s, 'subscribeUsers', (d) => d.length === 1);
  assert.equal(us[0].uid, alice.uid);
});

it('resolve settles pool market across three clients (cross-user balance writes)', async () => {
  const A = await client('A'); const B = await client('B'); const C = await client('C');
  const alice = await A.signUp('alice', 'secret1');
  await A.createMarket(customMarket(alice, clock.t));
  await B.signUp('bob', 'secret1');
  await B.placeBet('m1', 'o1', 100);
  await C.signUp('carol', 'secret1');
  await C.placeBet('m1', 'o2', 100);

  await A.resolveMarket('m1', 'o1');
  const m = await adminMarket('m1');
  assert.equal(m.status, 'resolved');
  assert.equal(m.resolvedOptionId, 'o1');
  assert.equal(m.resolvedBy, 'alice');
  assert.equal((await adminUser('bob')).balance, 600);
  assert.equal((await adminUser('bob')).totalWon, 200);
  assert.equal((await adminUser('carol')).balance, 400);
  assert.deepEqual((await adminBets('m1')).map((b) => b.status).sort(), ['lost', 'won']);
  // bob's own client sees the new balance through onAuthChange
  await until(async () => (await currentUser(B)).balance === 600);
  await assert.rejects(A.resolveMarket('m1', 'o2'), /already/i);
  await assert.rejects(B.resolveMarket('m1', 'o2'), /creator|already/i);
  assert.equal((await adminUser('bob')).balance, 600);
});

it('custom market only resolved / voided by creator; cannot create as someone else', async () => {
  const A = await client(); const B = await client();
  const alice = await A.signUp('alice', 'secret1');
  await A.createMarket(customMarket(alice, clock.t));
  await B.signUp('bob', 'secret1');
  await assert.rejects(B.resolveMarket('m1', 'o1'), /creator/i);
  await assert.rejects(B.voidMarket('m1'), /creator/i);
  assert.equal((await adminMarket('m1')).status, 'open');
  await assert.rejects(B.createMarket(customMarket(alice, clock.t, { id: 'm2' })), /yourself/i);
  await assert.rejects(A.createMarket(customMarket(alice, clock.t)), /already exists/i);
});

it('creator can void a market and everyone is refunded', async () => {
  const A = await client(); const B = await client();
  const alice = await A.signUp('alice', 'secret1');
  await A.createMarket(customMarket(alice, clock.t));
  await A.placeBet('m1', 'o1', 50);
  await B.signUp('bob', 'secret1');
  await B.placeBet('m1', 'o2', 70);
  assert.equal((await adminUser('bob')).balance, 430);
  await A.voidMarket('m1');
  assert.equal((await adminMarket('m1')).status, 'void');
  assert.equal((await adminUser('alice')).balance, 500);
  assert.equal((await adminUser('bob')).balance, 500);
  assert.ok((await adminBets()).every((b) => b.status === 'void'));
  await assert.rejects(A.voidMarket('m1'), /already/i);
});

it('pool market with nobody on the winner is voided', async () => {
  const A = await client(); const B = await client();
  const alice = await A.signUp('alice', 'secret1');
  await A.createMarket(customMarket(alice, clock.t));
  await B.signUp('bob', 'secret1');
  await B.placeBet('m1', 'o2', 70);
  await A.resolveMarket('m1', 'o1');
  assert.equal((await adminMarket('m1')).status, 'void');
  assert.equal((await adminUser('bob')).balance, 500);
});

it('ensureMarkets is idempotent, never overwrites, and racing clients are fine', async () => {
  const A = await client(); const B = await client();
  await A.signUp('alice', 'secret1');
  await B.signUp('bob', 'secret1');
  const m = autoTimerMarket(clock.t);
  const m2 = { ...autoTimerMarket(clock.t + 5), id: 'auto-2026-01-10-other' };
  await Promise.all([A.ensureMarkets([m, m2]), B.ensureMarkets([{ ...m, openedAt: clock.t + 99 }, m2])]);
  const all = await adminList('markets');
  assert.equal(all.length, 2);
  await A.placeBet(m.id, 'd1', 25);
  await B.ensureMarkets([m]);
  await A.ensureMarkets([m, m2]);
  const stored = await adminMarket(m.id);
  assert.equal(stored.totalPool, 25);
  assert.equal(stored.betCount, 1);
  assert.ok(stored.openedAt === clock.t || stored.openedAt === clock.t + 99);
});

it('unauthenticated store calls fail cleanly', async () => {
  const s = await client();
  await assert.rejects(s.placeBet('m1', 'o1', 5), /logged in/i);
  await assert.rejects(s.ensureMarkets([autoTimerMarket(clock.t)]), /logged in/i);
  await assert.rejects(s.resolveMarket('m1', 'o1'), /logged in/i);
  await s.autoResolveExpired(); // no-op
  await s.markBrokeIfNeeded(); // no-op
});

it('any user can resolve an auto timer market by reporting eventAt', async () => {
  const A = await client(); const B = await client();
  const m = autoTimerMarket(clock.t);
  await A.signUp('alice', 'secret1');
  await A.ensureMarkets([m]);
  await A.placeBet(m.id, 'd4', 100);
  await B.signUp('bob', 'secret1');
  clock.t += 2 * DAY_MS;
  await assert.rejects(B.resolveMarket(m.id, null, clock.t + HOUR_MS), /future/i);
  await B.resolveMarket(m.id, null, T0 + 2 * DAY_MS - HOUR_MS);
  const r = await adminMarket(m.id);
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolvedOptionId, 'd4');
  assert.equal(r.eventAt, T0 + 2 * DAY_MS - HOUR_MS);
  assert.equal(r.resolvedBy, 'bob');
  assert.equal((await adminUser('alice')).balance, 400 + 300);
  const bets = await adminBets(m.id);
  assert.equal(bets[0].status, 'won');
});

it('autoResolveExpired resolves expired timer market; concurrent clients do not double-pay', async () => {
  const A = await client(); const B = await client(); const C = await client();
  const m = autoTimerMarket(clock.t);
  await A.signUp('alice', 'secret1');
  await A.ensureMarkets([m]);
  await A.placeBet(m.id, 'never', 100);
  await B.signUp('bob', 'secret1');
  await B.placeBet(m.id, 'd1', 100);
  await C.signUp('carol', 'secret1');

  clock.t += 3 * DAY_MS;
  await C.autoResolveExpired();
  assert.equal((await adminMarket(m.id)).status, 'open');

  clock.t += 6 * DAY_MS;
  await Promise.all([A.autoResolveExpired(), B.autoResolveExpired(), C.autoResolveExpired()]);
  const r = await adminMarket(m.id);
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolvedOptionId, 'never');
  assert.equal(r.resolvedBy, 'auto');
  assert.equal((await adminUser('alice')).balance, 400 + 130);
  assert.equal((await adminUser('alice')).totalWon, 130);
  assert.equal((await adminUser('bob')).balance, 400);
  await A.autoResolveExpired();
  assert.equal((await adminUser('alice')).balance, 530);
});

it('double resolve race: exactly one wins, payout once', async () => {
  const A = await client(); const B = await client(); const C = await client();
  const m = autoTimerMarket(clock.t);
  await A.signUp('alice', 'secret1');
  await A.ensureMarkets([m]);
  await A.placeBet(m.id, 'd1', 100);
  await B.signUp('bob', 'secret1');
  await B.placeBet(m.id, 'd4', 100);
  await C.signUp('carol', 'secret1');
  clock.t += HOUR_MS;
  const results = await Promise.allSettled([
    A.resolveMarket(m.id, 'd1'), B.resolveMarket(m.id, 'd4'), C.resolveMarket(m.id, 'd1'),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status + ':' + (r.reason && r.reason.message))));
  for (const r of results.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /already/i);
  const total = (await adminUser('alice')).balance + (await adminUser('bob')).balance;
  // either d1 (alice +600) or d4 (bob +300)
  assert.ok(total === 400 + 400 + 600 || total === 400 + 400 + 300, 'total=' + total);
});

it('concurrent bets from many clients stay consistent', async () => {
  const names = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((x) => x + 'aaa');
  const A = await client();
  const owner = await A.signUp('owner', 'secret1');
  await A.createMarket(customMarket(owner, clock.t));
  const cs = [];
  for (const nm of names) { const c = await client(); await c.signUp(nm, 'secret1'); cs.push(c); }
  const rs = await Promise.all(cs.map((c, i) => c.placeBet('m1', i % 2 ? 'o2' : 'o1', 10 * (i + 1))));
  assert.equal(rs.length, 6);
  const m = await adminMarket('m1');
  assert.equal(m.betCount, 6);
  assert.equal(m.totalPool, 210);
  assert.equal(m.optionTotals.o1, 10 + 30 + 50);
  assert.equal(m.optionTotals.o2, 20 + 40 + 60);
  assert.equal((await adminBets('m1')).length, 6);
  // same user double-spend: 3 parallel 200 bets from a 500 balance -> only 2 succeed
  const u = cs[0];
  const rr = await Promise.allSettled([u.placeBet('m1', 'o1', 200), u.placeBet('m1', 'o1', 200), u.placeBet('m1', 'o1', 200)]);
  assert.equal(rr.filter((r) => r.status === 'fulfilled').length, 2);
});

it('bet racing with resolve: everything ends consistent (no lost stake)', async () => {
  const A = await client(); const B = await client(); const C = await client();
  const alice = await A.signUp('alice', 'secret1');
  await A.createMarket(customMarket(alice, clock.t));
  await B.signUp('bob', 'secret1');
  await C.signUp('carol', 'secret1');
  await B.placeBet('m1', 'o1', 50);
  const rs = await Promise.allSettled([A.resolveMarket('m1', 'o1'), C.placeBet('m1', 'o1', 100), C.placeBet('m1', 'o2', 30)]);
  assert.equal(rs[0].status, 'fulfilled');
  const m = await adminMarket('m1');
  assert.equal(m.status, 'resolved');
  const bets = await adminBets('m1');
  for (const b of bets) assert.notEqual(b.status, 'open', 'no bet may remain open on a settled market');
  // conservation: sum(balances) = 1500 (3 users x 500) after all settled
  const total = (await adminList('users')).reduce((s, u) => s + u.balance, 0);
  assert.equal(total, 1500);
});

it('username uniqueness race (sign-up)', async () => {
  const cs = [await client(), await client(), await client()];
  const rs = await Promise.allSettled([
    cs[0].signUp('Racer', 'secret1'), cs[1].signUp('racer', 'secret2'), cs[2].signUp('RACER', 'secret3'),
  ]);
  const ok = rs.filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length, 1);
  for (const r of rs.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /taken/i);
  const users = await adminList('users');
  assert.equal(users.length, 1);
  assert.equal((await adminList('usernames')).length, 1);
  // losers hold no session
  for (let i = 0; i < 3; i++) if (rs[i].status === 'rejected') assert.equal(await currentUser(cs[i]), null);
});

it('broke flow: brokeSince, claim rejected same day, allowed next day, penalty tax applies', async () => {
  const s = await client(); const B = await client();
  const m = autoTimerMarket(clock.t);
  await s.signUp('alice', 'secret1');
  await s.ensureMarkets([m]);
  await s.placeBet(m.id, 'd1', 500);
  await s.markBrokeIfNeeded();
  assert.equal((await adminUser('alice')).brokeSince, null);
  await assert.rejects(s.claimRestart());

  clock.t += 5 * DAY_MS;
  await B.signUp('bob', 'secret1');
  await B.resolveMarket(m.id, null, clock.t); // someone else settles alice's loss
  assert.equal((await adminUser('alice')).balance, 0);

  await s.markBrokeIfNeeded();
  assert.equal((await adminUser('alice')).brokeSince, economy.dayKey(clock.t));
  await assert.rejects(s.claimRestart(), /tomorrow/i);

  clock.t += 36 * HOUR_MS;
  await s.claimRestart();
  const u = await adminUser('alice');
  assert.equal(u.balance, 100);
  assert.equal(u.bankruptcies, 1);
  assert.equal(u.brokeSince, null);
  assert.equal(u.penaltyUntil, clock.t + 3 * DAY_MS);
  await assert.rejects(s.claimRestart());

  const m2 = autoTimerMarket(clock.t, 'auto-2026-01-16-test');
  await s.ensureMarkets([m2]);
  await s.placeBet(m2.id, 'd1', 100);
  clock.t += HOUR_MS;
  await B.resolveMarket(m2.id, null, clock.t);
  assert.equal((await adminUser('alice')).balance, 475);
  const won = (await adminBets(m2.id))[0];
  assert.equal(won.status, 'won');
  assert.equal(won.taxed, 125);
  assert.equal(won.payout, 475);
});

it('sign-out: onAuthChange gets null, listeners unsubscribed, no uncaught errors afterwards', async () => {
  const errs = [];
  const orig = console.error; console.error = (...a) => errs.push(a);
  const s = await client();
  await s.signUp('alice', 'secret1');
  const got = { users: 0, markets: 0, bets: 0 };
  const offs = ['users', 'markets', 'bets'].map((k) => s['subscribe' + k[0].toUpperCase() + k.slice(1)](() => { got[k]++; }));
  await until(() => got.users && got.markets && got.bets);
  const { seen, off } = collect(s);
  await s.signOut();   // do NOT unsubscribe first: simulates the window before app.js endSession()
  await until(() => seen.includes(null));
  offs.forEach((o) => o());
  off();
  await new Promise((r) => setTimeout(r, 500));
  console.error = orig;
  assert.deepEqual(errs.map((e) => String(e[0])), []);
});

it('profile self-repair when users doc is missing (interrupted sign-up)', async () => {
  const s = await client();
  const alice = await s.signUp('Alice', 'secret1');
  await s.signOut();
  // admin deletes profile doc but leaves usernames + auth
  await fetch(`${REST}/users/${alice.uid}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
  const u = await s.signIn('alice', 'secret1');
  assert.equal(u.username, 'Alice');
  assert.equal(u.balance, 500);
  assert.equal((await adminUser('Alice')).uid, alice.uid);
});

it('stale bet-id query (bet lands between query and transaction) is retried, late bet is settled', async () => {
  let hook = null;
  const wrapped = { ...fbFs, getDocs: async (q, ...r) => { const res = await fbFs.getDocs(q, ...r); if (hook) { const h = hook; hook = null; await h(); } return res; } };
  const A = await createFirebaseStore(config, { sdk: { ...sdk, firestore: wrapped }, emulator, appName: 'stale' + ++n, now: () => clock.t });
  clients.push(A);
  const B = await client();
  const alice = await A.signUp('alice', 'secret1');
  await A.createMarket(customMarket(alice, clock.t));
  await B.signUp('bob', 'secret1');
  await A.placeBet('m1', 'o1', 10);
  hook = () => B.placeBet('m1', 'o2', 40);
  await A.resolveMarket('m1', 'o2');
  assert.equal(hook, null, 'hook must have run');
  const bets = await adminBets('m1');
  assert.equal(bets.length, 2);
  assert.ok(bets.every((b) => b.status !== 'open'));
  assert.equal((await adminUser('bob')).balance, 500 - 40 + 50);
  assert.equal((await adminUser('alice')).balance, 490);
});

// ---------------------------------------------------------------- firestore.rules
const RT0 = Date.UTC(2026, 0, 10, 12);

async function raw(email) {
  const app = fbApp.initializeApp(config, 'raw' + ++n);
  const auth = fbAuth.getAuth(app); fbAuth.connectAuthEmulator(auth, emulator.authUrl, { disableWarnings: true });
  const db = F.getFirestore(app); F.connectFirestoreEmulator(db, FS_H, Number(FS_P));
  let uid = null;
  if (email) { const c = await fbAuth.createUserWithEmailAndPassword(auth, email, 'secret1'); uid = c.user.uid; }
  return { db, uid, auth };
}
const denied = (p) => assert.rejects(p, (e) => e.code === 'permission-denied');
const R = (db, path) => F.doc(db, ...path.split('/'));

async function seed() {
  // Real users through the real store: alice (owner of custom market m1), bob (has a bet).
  const mk = async (name) => {
    const s = await createFirebaseStore(config, { sdk, emulator, appName: 's' + ++n, now: () => RT0 });
    const u = await s.signUp(name, 'secret1');
    return { s, u };
  };
  const alice = await mk('alice'); const bob = await mk('bob');
  const m = economy.buildCustomMarket({ id: 'm1', user: alice.u, now: RT0, title: 'Will it rain?', description: '', kind: 'choice', optionLabels: ['Y', 'N'], closesAt: RT0 + 86400000 });
  await alice.s.createMarket(m);
  const auto = { ...economy.buildCustomMarket({ id: 'auto-x', user: { uid: 'house', username: 'h' }, now: RT0, title: 'How long?', description: '', kind: 'timer' }), type: 'auto', createdBy: 'house', createdByName: 'The House' };
  await alice.s.ensureMarkets([auto]);
  const bet = await bob.s.placeBet('m1', 'o1', 50);
  return { alice, bob, bet };
}

it('unauthenticated: no reads, writes, deletes', async () => {
  const { alice, bet } = await seed();
  const { db } = await raw(null);
  await denied(F.getDoc(R(db, `users/${alice.u.uid}`)));
  await denied(F.getDocs(F.collection(db, 'markets')));
  await denied(F.getDocs(F.collection(db, 'bets')));
  await denied(F.getDoc(R(db, 'usernames/alice')));
  await denied(F.setDoc(R(db, 'markets/zzz'), { id: 'zzz' }));
  await denied(F.updateDoc(R(db, `users/${alice.u.uid}`), { balance: 99999 }));
  await denied(F.deleteDoc(R(db, `bets/${bet.id}`)));
  await denied(F.deleteDoc(R(db, 'markets/m1')));
  // REST without a token
  const r = await fetch(`http://${EMU_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/users`);
  assert.equal(r.status, 403);
});

it('authenticated: deletes denied everywhere', async () => {
  const { alice, bob, bet } = await seed();
  const { db } = await raw('mal@users.sonnetous.app');
  await denied(F.deleteDoc(R(db, `users/${bob.u.uid}`)));
  await denied(F.deleteDoc(R(db, `bets/${bet.id}`)));
  await denied(F.deleteDoc(R(db, 'markets/m1')));
  await denied(F.deleteDoc(R(db, 'usernames/alice')));
  // even owner-ish deletions by the actual owners
  await denied(F.deleteDoc(R(alice.s && db, `users/${alice.u.uid}`)));
});

it('user create rules / usernames immutable', async () => {
  const { alice } = await seed();
  const { db, uid } = await raw('mal@users.sonnetous.app');
  const base = { uid, username: 'mal', balance: 500, createdAt: RT0, bankruptcies: 0, brokeSince: null, penaltyUntil: null, totalWagered: 0, totalWon: 0 };
  // profile without a claimed username
  await denied(F.setDoc(R(db, `users/${uid}`), base));
  // claim + rich profile in one batch
  let b = F.writeBatch(db); b.set(R(db, 'usernames/mal'), { uid }); b.set(R(db, `users/${uid}`), { ...base, balance: 1000 });
  await denied(b.commit());
  // profile for someone else's uid
  b = F.writeBatch(db); b.set(R(db, 'usernames/mal'), { uid }); b.set(R(db, `users/${alice.u.uid}`), base);
  await denied(b.commit());
  // stealing a name: claim alice for my uid, or claim mal for alice's uid
  await denied(F.setDoc(R(db, 'usernames/alice'), { uid }));
  await denied(F.setDoc(R(db, 'usernames/mal'), { uid: alice.u.uid }));
  await denied(F.setDoc(R(db, 'usernames/Bad-Name'), { uid }));
  await denied(F.setDoc(R(db, 'usernames/mal'), { uid, extra: 1 }));
  // profile claiming a name that another uid owns
  b = F.writeBatch(db); b.set(R(db, `users/${uid}`), { ...base, username: 'alice' });
  await denied(b.commit());
  // the legit one works
  b = F.writeBatch(db); b.set(R(db, 'usernames/mal'), { uid }); b.set(R(db, `users/${uid}`), base);
  await b.commit();
  // usernames immutable now
  await denied(F.setDoc(R(db, 'usernames/mal'), { uid }));
  await denied(F.updateDoc(R(db, 'usernames/mal'), { uid: alice.u.uid }));
});

it('user updates: identity fixed; others only balance/totalWon; ints >= 0', async () => {
  const { alice, bob } = await seed();
  const { db, uid } = await raw('mal@users.sonnetous.app');
  const base = { uid, username: 'mal', balance: 500, createdAt: RT0, bankruptcies: 0, brokeSince: null, penaltyUntil: null, totalWagered: 0, totalWon: 0 };
  const b = F.writeBatch(db); b.set(R(db, 'usernames/mal'), { uid }); b.set(R(db, `users/${uid}`), base); await b.commit();
  const bobRef = R(db, `users/${bob.u.uid}`);
  await denied(F.updateDoc(bobRef, { username: 'hacked' }));
  await denied(F.updateDoc(bobRef, { uid: 'x' }));
  await denied(F.updateDoc(bobRef, { createdAt: 1 }));
  await denied(F.updateDoc(bobRef, { bankruptcies: 9 }));
  await denied(F.updateDoc(bobRef, { balance: -1 }));
  await denied(F.updateDoc(bobRef, { balance: 10.5 }));
  await denied(F.updateDoc(bobRef, { balance: 5, extraField: 1 }));
  await F.updateDoc(bobRef, { balance: 777, totalWon: 3 }); // settlement-style write is allowed
  // own doc
  const me = R(db, `users/${uid}`);
  await denied(F.updateDoc(me, { username: 'x' }));
  await F.updateDoc(me, { balance: 400, totalWagered: 100, brokeSince: '2026-01-10' });
});

it('bets: create as self only, open+unpaid; settle once; only status/payout/taxed', async () => {
  const { alice, bob, bet } = await seed();
  const { db, uid } = await raw('mal@users.sonnetous.app');
  const mk = (over) => ({ ...bet, id: 'b-x', uid, amount: 5, status: 'open', payout: 0, ...over });
  await denied(F.setDoc(R(db, 'bets/b-x'), mk({ uid: bob.u.uid })));
  await denied(F.setDoc(R(db, 'bets/b-x'), mk({ status: 'won', payout: 100 })));
  await denied(F.setDoc(R(db, 'bets/b-x'), mk({ payout: 100 })));
  await denied(F.setDoc(R(db, 'bets/b-x'), mk({ amount: -5 })));
  await denied(F.setDoc(R(db, 'bets/b-x'), mk({ amount: 1.5 })));
  await denied(F.setDoc(R(db, 'bets/other-id'), mk({ id: 'b-x' })));
  await F.setDoc(R(db, 'bets/b-x'), mk({}));
  const bref = R(db, `bets/${bet.id}`);
  await denied(F.updateDoc(bref, { amount: 1 }));
  await denied(F.updateDoc(bref, { uid }));
  await denied(F.updateDoc(bref, { status: 'open', payout: 5 }));      // not a real transition
  await denied(F.updateDoc(bref, { status: 'weird' }));
  await F.updateDoc(bref, { status: 'won', payout: 100, taxed: 0 });
  await denied(F.updateDoc(bref, { status: 'lost', payout: 0, taxed: 0 })); // second settlement
});

it('markets: create rules; update restricted to totals/result while open; creator-only status for custom', async () => {
  const { alice, bob } = await seed();
  const { db, uid } = await raw('mal@users.sonnetous.app');
  const good = economy.buildCustomMarket({ id: 'mm', user: { uid, username: 'mal' }, now: RT0, title: 'Mal market', description: '', kind: 'choice', optionLabels: ['a', 'b'], closesAt: RT0 + 1e6 });
  await denied(F.setDoc(R(db, 'markets/mm'), { ...good, createdBy: alice.u.uid }));
  await denied(F.setDoc(R(db, 'markets/mm'), { ...good, totalPool: 5 }));
  await denied(F.setDoc(R(db, 'markets/mm'), { ...good, betCount: 1 }));
  await denied(F.setDoc(R(db, 'markets/mm'), { ...good, status: 'resolved' }));
  await denied(F.setDoc(R(db, 'markets/mm'), { ...good, createdBy: 'house' }));
  await denied(F.setDoc(R(db, 'markets/mm'), { ...good, type: 'auto' }));
  await denied(F.setDoc(R(db, 'markets/other'), good));
  await F.setDoc(R(db, 'markets/mm'), good);
  // overwrite existing (create on existing = update)
  await denied(F.setDoc(R(db, 'markets/m1'), { ...good, id: 'm1' }));
  // mal touching alice's market
  const m1 = R(db, 'markets/m1');
  await denied(F.updateDoc(m1, { options: [] }));
  await denied(F.updateDoc(m1, { closesAt: 1 }));
  await denied(F.updateDoc(m1, { createdBy: uid }));
  await denied(F.updateDoc(m1, { status: 'resolved', resolvedOptionId: 'o2', resolvedAt: 1, resolvedBy: 'mal', eventAt: null }));
  await F.updateDoc(m1, { totalPool: 60, betCount: 2, optionTotals: { o1: 50, o2: 10 } }); // bet-style
  // auto market: anyone may resolve
  await F.updateDoc(R(db, 'markets/auto-x'), { status: 'resolved', resolvedOptionId: 'd1', resolvedAt: 1, resolvedBy: 'mal', eventAt: null });
  await denied(F.updateDoc(R(db, 'markets/auto-x'), { status: 'open' }));
  await denied(F.updateDoc(R(db, 'markets/auto-x'), { totalPool: 5 }));
});

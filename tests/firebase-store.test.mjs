// Happy-path integration tests for js/store/firebase.js + firestore.rules (v2) against the REAL Firestore and
// Auth emulators, with several independent clients. They are SKIPPED (not failed) unless the emulators are
// running and the npm firebase SDK is available, so plain `node --test` (no deps, no network) stays green.
// The attack tests live in tests/rules-attacks.test.mjs; the shared harness in tests/rules-helpers.mjs.
//
// To run them (needs Java 11+ and Node 20+; nothing is installed into the repo):
//   mkdir /tmp/fb && cd /tmp/fb && npm init -y && npm i firebase@10.12.2 firebase-tools
//   cat > firebase.json   # {"firestore":{"rules":"<repo>/firestore.rules"},
//                         #  "emulators":{"auth":{"port":9099},"firestore":{"port":8080},"ui":{"enabled":false}}}
//   npx firebase emulators:start --only auth,firestore --project demo-sonnetous &
//   FB_SDK_DIR=/tmp/fb node --test --test-force-exit tests/
// The tests load a TEST copy of firestore.rules into the emulator (admin code 'test-admin-code', 12h/24h
// windows -> 4s, bailout day -> 4s). Real time is used (rules compare against server time), so the suite takes
// a minute or two.
import test, { before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFirebaseStore } from '../js/store/firebase.js';
import * as economy from '../js/economy.js';
import * as templates from '../js/templates.js';
import {
  fbConfig, emulator, loadEnv, pushRules, acquireLock, releaseLock, resetEmulator, adminList, adminGet, adminPatch, sleep, until,
  TEST_ADMIN_CODE, TEST_CHALLENGE_WINDOW_MS, TEST_VOTE_WINDOW_MS, TEST_BAILOUT_DAY_MS,
} from './rules-helpers.mjs';

const { sdk, skip } = await loadEnv();
const it = (name, fn) => test(name, { skip, timeout: 120000 }, fn);
const { DAY_MS, HOUR_MS } = economy;
const todayKey = () => economy.utcDayKey(Date.now());

before(async () => { if (skip) return; await acquireLock(); await pushRules(); });
after(async () => { if (skip) return; releaseLock(); });

let n = 0;
let clients = [];
// decisionNow is far ahead so the store's own "is the 12h/24h window over" checks never hide what the RULES say
// (the rules use the shortened test windows and the real server clock).
async function client(label = 'c', extra = {}) {
  const store = await createFirebaseStore(fbConfig, {
    sdk, emulator, appName: `${label}${++n}`, now: () => Date.now(), decisionNow: () => Date.now() + 26 * HOUR_MS, ...extra,
  });
  clients.push(store);
  await store.init();
  return store;
}
beforeEach(async () => { if (!skip) { await resetEmulator(); clients = []; } });
afterEach(async () => { if (skip) return; for (const c of clients) { try { await c.signOut(); } catch { /* ignore */ } await c._dispose(); } });

// ---- small helpers
const first = (store, sub, pred = () => true, ms = 8000) => new Promise((res, rej) => {
  let off = null; let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; off && off(); rej(new Error(`no ${sub} snapshot matched`)); } }, ms);
  off = store[sub]((d) => {
    if (done || !pred(d)) return;
    done = true; clearTimeout(timer); setTimeout(() => off && off(), 0); res(d);
  });
});
const me = (store, pred) => first(store, 'onAuthChange', (u) => (pred ? pred(u) : !!u));
const player = (uid) => adminGet('players', uid);
const market = (id) => adminGet('markets2', id);
const bet = (id) => adminGet('bets2', id);

/** Fresh world: admin claims the game (test code) and opens it. Returns the admin store. */
let ADMIN = null; // the admin store of the current world: only the admin may create house markets
async function openGame() {
  const admin = await client('admin');
  ADMIN = admin;
  await assert.rejects(admin.signUp('Admin', 'secret1'), /down for maintenance/);
  await admin.claimAdmin(TEST_ADMIN_CODE);
  await admin.setMaintenance(false);
  return admin;
}
/** Signs up `name` on a new client. Returns { s, uid, name }. */
async function join(name) {
  const s = await client(name);
  const p = await s.signUp(name, 'secret1');
  return { s, uid: p.uid, name };
}
async function until2(fn) { return until(fn, 6000); }

function choiceMarket(p, id, opts = {}) {
  const now = Date.now();
  return economy.buildCustomMarket({
    id, player: { uid: p.uid, username: p.name }, now, title: `Will ${id} happen?`, description: '', kind: 'choice',
    optionLabels: ['Yes', 'No'], closesAt: now + (opts.closeInMs ?? 4000),
  });
}
// A short-lived house timer market: buckets [0,3s) and [3s,inf), betting closes after `closeInMs`.
function houseTimer(tpl, opts = {}) {
  const now = Date.now();
  const closeInMs = opts.closeInMs ?? 2500;
  return economy.normalizeMarket({
    id: `auto-${todayKey()}-${tpl}`, type: 'auto', templateId: tpl, kind: 'timer', mode: 'fixed', title: `Timer ${tpl}`,
    description: 'Counts if: test.', category: 'Test', emoji: '⏱️', createdBy: 'house', createdByName: 'The House',
    openedAt: now, closesAt: now + closeInMs, expiresAt: now + closeInMs + 3000,
    options: [
      { id: 'quick', label: 'Within 3s', odds: 3, fromDays: 0, toDays: 3000 / DAY_MS },
      { id: 'never', label: 'Later', odds: 1.5, fromDays: 3000 / DAY_MS, toDays: null },
    ],
  });
}
const waitUntil = async (ms) => { const d = ms - Date.now(); if (d > 0) await sleep(d + 30); };

// -----------------------------------------------------------------------------------------------
it('bootstrap: closed game, admin claim, maintenance on/off, sign-up gate', async () => {
  const a = await client('admin');
  const cfg0 = await first(a, 'subscribeConfig');
  assert.deepEqual(cfg0, { exists: false, maintenance: true, adminUid: null }, 'no config = closed, readable signed out');
  assert.deepEqual(await first(a, 'onAuthChange'), null);

  // Sign-up while closed: the Auth account is kept, no player is created.
  await assert.rejects(a.signUp('Admin', 'secret1'), /down for maintenance/);
  const sess = await first(a, 'onSessionChange', (s) => !!s);
  assert.equal(sess.username, 'Admin');
  assert.equal((await adminList('players')).length, 0);
  assert.deepEqual(await first(a, 'onAuthChange'), null);

  await assert.rejects(a.claimAdmin('wrong-code'), /not the admin code/);
  assert.equal((await adminList('app')).filter((d) => d._id === 'config').length, 0);
  await a.claimAdmin(TEST_ADMIN_CODE);
  const cfg = await first(a, 'subscribeConfig', (c) => c.exists);
  assert.equal(cfg.maintenance, true);
  assert.equal(cfg.adminUid, sess.uid);
  const cfgDoc = await adminGet('app', 'config');
  assert.deepEqual(Object.keys(cfgDoc).sort(), ['_id', 'adminUid', 'maintenance', 'updatedAt'], 'the code is not stored in the public config');
  assert.equal(await adminGet('app', 'claim'), null, 'plaintext code wiped');
  // The admin bypasses maintenance and got a player (+handle) right away.
  const ap = await first(a, 'onAuthChange', (u) => !!u);
  assert.equal(ap.username, 'Admin');
  assert.equal(ap.balance, 500);
  assert.equal((await adminGet('handles', 'admin')).uid, ap.uid);
  await assert.rejects(a.claimAdmin(TEST_ADMIN_CODE), /already been claimed/);

  // Others cannot get in during maintenance, but their session survives.
  const b = await client('b');
  await assert.rejects(b.signUp('Bobby', 'secret1'), /down for maintenance/);
  assert.equal((await adminList('players')).length, 1);
  await b.signOut();
  await assert.rejects(b.signIn('Bobby', 'secret1'), /down for maintenance/);
  assert.equal((await first(b, 'onSessionChange', (s) => !!s)).username, 'Bobby');
  assert.deepEqual(await first(b, 'subscribeMarkets'), [], 'empty list while closed');
  await assert.rejects(b.placeBet('x', 'o1', 5), /down for maintenance/);

  // Non-admin cannot toggle maintenance / ban
  await assert.rejects(b.setMaintenance(false), /Only the admin/);
  await assert.rejects(b.banPlayer(ap.uid, 'x'), /Only the admin/);

  // Open the game: b (already signed in) gets a player through the repair path, no re-login needed.
  await a.setMaintenance(false);
  const bp = await first(b, 'onAuthChange', (u) => !!u);
  assert.equal(bp.username, 'Bobby');
  assert.equal((await player(bp.uid)).balance, 500);
  assert.deepEqual((await first(b, 'subscribePlayers', (l) => l.length === 2)).map((p) => p.username).sort(), ['Admin', 'Bobby']);

  // Maintenance on again: everything shuts, listeners go empty and come back.
  await a.setMaintenance(true);
  assert.deepEqual(await first(b, 'onAuthChange', (u) => u === null), null);
  assert.deepEqual(await first(b, 'subscribePlayers', (l) => l.length === 0), []);
  await assert.rejects(b.markBrokeIfNeeded(), /down for maintenance/);
  await a.setMaintenance(false);
  assert.equal((await first(b, 'onAuthChange', (u) => !!u)).username, 'Bobby');
  assert.equal((await first(b, 'subscribePlayers', (l) => l.length === 2)).length, 2);
});

it('ban / unban', async () => {
  const admin = await openGame();
  const alice = await join('alice');
  const bob = await join('bob');
  await assert.rejects(alice.s.banPlayer(bob.uid, 'nope'), /Only the admin/);
  const adminUid = (await first(admin, 'onAuthChange')).uid;
  await assert.rejects(admin.banPlayer(adminUid, 'lol'), /can't ban the admin/);
  await admin.banPlayer(bob.uid, 'cheating at cards');
  const ban = await first(bob.s, 'subscribeMyBan', (b) => !!b);
  assert.equal(ban.reason, 'cheating at cards');
  assert.equal(ban.username, 'bob');
  assert.deepEqual(await first(bob.s, 'onAuthChange', (u) => u === null), null);
  assert.deepEqual(await first(bob.s, 'subscribeMarkets'), []);
  await assert.rejects(bob.s.placeBet('x', 'o1', 5), /banned/);
  await assert.rejects(bob.s.markBrokeIfNeeded(), /banned/);
  await bob.s.signOut();
  await assert.rejects(bob.s.signIn('bob', 'secret1'), /banned/);
  assert.equal((await first(admin, 'subscribeBans', (l) => l.length === 1))[0].uid, bob.uid);
  assert.deepEqual(await first(alice.s, 'subscribeBans'), [], 'non-admin sees no bans');
  // The admin can still play; alice is unaffected
  assert.ok(await me(alice.s));
  await admin.unbanPlayer(bob.uid);
  await bob.s.signIn('bob', 'secret1');
  assert.equal((await first(bob.s, 'onAuthChange', (u) => !!u)).username, 'bob');
  assert.deepEqual(await first(bob.s, 'subscribeMyBan'), null);
  await bob.s.markBrokeIfNeeded();
});

it('sign-up validation, taken names, repair path for an Auth account without a player doc', async () => {
  await openGame();
  const s = await client('u');
  await assert.rejects(s.signUp('a!', 'secret1'), /Username/);
  await assert.rejects(s.signUp('bobby', '123'), /Password/);
  const u = await s.signUp('Alice', 'secret1');
  assert.equal(u.username, 'Alice');
  assert.equal(u.balance, 500);
  assert.equal((await adminGet('handles', 'alice')).uid, u.uid);
  const t = await client('t');
  await assert.rejects(t.signUp('alice', 'another1'), /taken/i);
  assert.equal(await first(t, 'onSessionChange'), null, 'failed sign-up leaves no session');
  await assert.rejects(t.signIn('Alice', 'wrong-pass'), /Invalid username or password/);
  await t.signIn('ALICE', 'secret1');
  assert.equal((await first(t, 'onAuthChange', (x) => !!x)).uid, u.uid);

  // Repair: an Auth account that never got a player (interrupted sign-up), created behind the store's back.
  const raw = sdk.app.initializeApp(fbConfig, 'raw-auth');
  const rawAuth = sdk.auth.getAuth(raw);
  sdk.auth.connectAuthEmulator(rawAuth, emulator.authUrl, { disableWarnings: true });
  const cred = await sdk.auth.createUserWithEmailAndPassword(rawAuth, 'ghosty@users.sonnetous.app', 'secret1');
  await sdk.auth.updateProfile(cred.user, { displayName: 'Ghosty' });
  await sdk.app.deleteApp(raw);
  assert.equal(await adminGet('players', cred.user.uid), null);
  const g = await client('g');
  const gp = await g.signIn('ghosty', 'secret1');
  assert.equal(gp.uid, cred.user.uid);
  assert.equal(gp.username, 'Ghosty');
  assert.equal(gp.balance, 500);
  assert.equal((await adminGet('handles', 'ghosty')).uid, cred.user.uid);
  // ...and the same through the auth stream alone (session restored, no signIn call)
  const raw2 = sdk.app.initializeApp(fbConfig, 'raw-auth2');
  const rawAuth2 = sdk.auth.getAuth(raw2);
  sdk.auth.connectAuthEmulator(rawAuth2, emulator.authUrl, { disableWarnings: true });
  const cred2 = await sdk.auth.createUserWithEmailAndPassword(rawAuth2, 'phantom@users.sonnetous.app', 'secret1');
  // 'phantom' has no displayName: the name comes from the synthetic email
  const watcher = await createFirebaseStore(fbConfig, { sdk, emulator, appName: 'watch1', now: () => Date.now() });
  clients.push(watcher);
  await watcher.signIn('phantom', 'secret1'); // repair inside signIn
  assert.equal((await player(cred2.user.uid)).username, 'phantom');
  await sdk.app.deleteApp(raw2);
});

it('choice market, unchallenged report: bets, cooldown, finalize after the window, claims (winner, loser), bond claim', async () => {
  await openGame();
  const alice = await join('alice'); const bob = await join('bob'); const carol = await join('carol');
  const m = choiceMarket(alice, 'm1', { closeInMs: 4500 });
  await alice.s.createMarket(m);
  assert.equal((await player(alice.uid)).marketsCount, 1);
  assert.equal((await player(alice.uid)).marketsDay, economy.utcDayNumber(Date.now()));
  await assert.rejects(alice.s.createMarket(m), /already exists/);

  const b1 = await bob.s.placeBet('m1', 'o1', 200);
  const b2 = await carol.s.placeBet('m1', 'o2', 100);
  await assert.rejects(bob.s.placeBet('m1', 'o1', 10), /Slow down/);
  await assert.rejects(bob.s.placeBet('m1', 'o1', 5000), /Not enough/);
  await assert.rejects(bob.s.placeBet('nope', 'o1', 5), /not found/i);
  await sleep(economy.BET_COOLDOWN_MS + 100);
  const b3 = await bob.s.placeBet('m1', 'o1', 50);
  let mk = await market('m1');
  assert.deepEqual(mk.optionTotals, { o1: 250, o2: 100 });
  assert.equal(mk.totalPool, 350);
  assert.equal(mk.betCount, 3);
  assert.equal(mk.lastBetId, b3.id);
  const stake = await adminGet('stakes', `m1_${bob.uid}`);
  assert.equal(stake.amount, 250);
  const pb = await player(bob.uid);
  assert.equal(pb.balance, 250); assert.equal(pb.openStake, 250); assert.equal(pb.totalWagered, 250);
  assert.equal(pb.lastBetId, b3.id);
  await assert.rejects(alice.s.reportResult('m1', 'o1'), /too early/i);
  await assert.rejects(bob.s.claimBet(b1.id), /not been settled/);

  await waitUntil(m.closesAt);
  await assert.rejects(bob.s.placeBet('m1', 'o1', 10), /closed/i);
  await assert.rejects(bob.s.reportResult('m1', 'o1'), /Only the creator/);
  await alice.s.reportResult('m1', 'o1', null, 'https://example.com/proof');
  mk = await market('m1');
  assert.equal(mk.status, 'reported'); assert.equal(mk.reportedBy, alice.uid); assert.equal(mk.reportedByName, 'alice');
  assert.equal(mk.evidence, 'https://example.com/proof');
  assert.equal((await player(alice.uid)).balance, 480);
  assert.equal((await player(alice.uid)).lastBondMarketId, 'm1');
  await assert.rejects(bob.s.placeBet('m1', 'o1', 10), /closed|reported/i);
  await assert.rejects(alice.s.challengeReport('m1'), /your own report/);
  // the store thinks it can finalize (decisionNow is 26h ahead) but the rules know the window is still open
  await assert.rejects(carol.s.finalizeMarket('m1'), /rules rejected/);

  await waitUntil(mk.reportedAt + TEST_CHALLENGE_WINDOW_MS);
  const fin = await carol.s.finalizeMarket('m1');
  assert.equal(fin.status, 'resolved'); assert.equal(fin.resolvedOptionId, 'o1');
  assert.equal((await bob.s.finalizeMarket('m1')).status, 'resolved', 'idempotent');

  // pool payout: floor(amount * totalPool / optionTotals[o1]) = floor(200*350/250) = 280 and floor(50*350/250) = 70
  const c1 = await bob.s.claimBet(b1.id);
  assert.deepEqual([c1.status, c1.payout, c1.taxed], ['won', 280, 0]);
  const c3 = await bob.s.claimBet(b3.id);
  assert.deepEqual([c3.status, c3.payout], ['won', 70]);
  const c2 = await carol.s.claimBet(b2.id);
  assert.deepEqual([c2.status, c2.payout], ['lost', 0]);
  await assert.rejects(bob.s.claimBet(b1.id), /already been claimed/);
  await assert.rejects(carol.s.claimBet(b1.id), /not your bet/);
  const pb2 = await player(bob.uid);
  assert.equal(pb2.balance, 250 + 350); assert.equal(pb2.openStake, 0); assert.equal(pb2.totalWon, 350);
  assert.equal(pb2.lastClaimId, b3.id);
  const pc = await player(carol.uid);
  assert.equal(pc.balance, 400); assert.equal(pc.openStake, 0);
  assert.equal((await bet(b1.id)).status, 'won');

  assert.equal(await alice.s.claimBond('m1'), 20);
  await assert.rejects(alice.s.claimBond('m1'), /already been paid/);
  await assert.rejects(bob.s.claimBond('m1'), /didn't put up a bond/);
  assert.equal((await player(alice.uid)).balance, 500);
  const total = (await adminList('players')).reduce((a, p) => a + p.balance + p.openStake, 0);
  assert.equal(total, 4 * 500, 'no money created or destroyed (pool market)');
});

it('disputes: uphold / overturn / tie / no votes, bond claims both ways, voter rules', async () => {
  await openGame();
  const alice = await join('alice'); const frank = await join('frank');
  const bettors = { A: await join('bob'), B: await join('carol'), C: await join('dave'), D: await join('erin') };
  const gina = await join('gina'); const hank = await join('hank');
  const closesAt = Date.now() + 6000;
  const ids = ['A', 'B', 'C', 'D'].map((k) => `d${k}`);
  for (const id of ids) {
    await alice.s.createMarket(economy.buildCustomMarket({
      id, player: { uid: alice.uid, username: 'alice' }, now: Date.now(), title: `Dispute ${id}?`, description: '',
      kind: 'choice', optionLabels: ['Yes', 'No'], closesAt,
    }));
  }
  assert.equal((await player(alice.uid)).marketsCount, 4);
  for (const k of ['A', 'B', 'C', 'D']) await bettors[k].s.placeBet(`d${k}`, 'o1', 100);
  await waitUntil(closesAt);
  const plan = {
    dA: { votes: [[gina, true]], status: 'resolved', rep: 40, chal: 0 },
    dB: { votes: [[gina, false]], status: 'void', rep: 0, chal: 40 },
    dC: { votes: [[gina, true], [hank, false]], status: 'void', rep: 20, chal: 20 },
    dD: { votes: [], status: 'void', rep: 20, chal: 20 },
  };
  let lastChallenge = 0;
  for (const id of ids) {
    await alice.s.reportResult(id, 'o1');
    await assert.rejects(alice.s.challengeReport(id), /your own report/);
    await frank.s.challengeReport(id);
    lastChallenge = (await market(id)).challengedAt;
    assert.equal((await market(id)).status, 'challenged');
    const k = id.slice(1);
    // the bettor, the reporter and the challenger may not vote; the others once
    await assert.rejects(bettors[k].s.voteOnDispute(id, true), /bet on this market/);
    await assert.rejects(alice.s.voteOnDispute(id, true), /part of this dispute/);
    await assert.rejects(frank.s.voteOnDispute(id, false), /part of this dispute/);
    for (const [who, up] of plan[id].votes) {
      await who.s.voteOnDispute(id, up);
      await assert.rejects(who.s.voteOnDispute(id, up), /already voted/);
    }
    const mk = await market(id);
    assert.equal(mk.votesUphold, plan[id].votes.filter((v) => v[1]).length);
    assert.equal(mk.votesOverturn, plan[id].votes.filter((v) => !v[1]).length);
    if (plan[id].votes.length) assert.equal(mk.lastVoteId, `${id}_${plan[id].votes.at(-1)[0].uid}`);
    await assert.rejects(frank.s.finalizeMarket(id), /rules rejected/, 'voting window still open');
  }
  assert.deepEqual((await first(gina.s, 'subscribeMyVotes', (l) => l.length === 3)).sort(), ['dA', 'dB', 'dC']);
  assert.deepEqual(await first(hank.s, 'subscribeMyVotes', (l) => l.length === 1), ['dC']);
  await waitUntil(lastChallenge + TEST_VOTE_WINDOW_MS);
  for (const id of ids) {
    const fin = await hank.s.finalizeMarket(id);
    assert.equal(fin.status, plan[id].status, id);
    assert.equal(fin.resolvedOptionId, plan[id].status === 'resolved' ? 'o1' : null);
  }
  // bettors: dA wins (pool of 100 all on o1 -> 100 back), the others are voided (refund)
  const c = await bettors.A.s.claimBet((await adminList('bets2')).find((b) => b.marketId === 'dA')._id);
  assert.deepEqual([c.status, c.payout], ['won', 100]);
  for (const k of ['B', 'C', 'D']) {
    const b = (await adminList('bets2')).find((x) => x.marketId === `d${k}`);
    const r = await bettors[k].s.claimBet(b._id);
    assert.deepEqual([r.status, r.payout], ['void', 100]);
    assert.equal((await player(bettors[k].uid)).balance, 500);
  }
  // bonds: both ways; the loser's claim pays 0 but still marks the bond as paid
  const paid = {};
  for (const id of ids) {
    paid[id] = [await alice.s.claimBond(id), await frank.s.claimBond(id)];
    assert.deepEqual(paid[id], [plan[id].rep, plan[id].chal], id);
    const mk = await market(id);
    assert.equal(mk.reporterBondPaid, true); assert.equal(mk.challengerBondPaid, true);
  }
  assert.equal((await player(alice.uid)).balance, 500);
  assert.equal((await player(frank.uid)).balance, 500);
  await assert.rejects(alice.s.claimBond('dA'), /already been paid/);
  const total = (await adminList('players')).reduce((a, p) => a + p.balance + p.openStake, 0);
  assert.equal(total, 9 * 500, 'admin + 8 players');
});

it('pool market whose reported option has no money is voided; reporter gets the bond back', async () => {
  await openGame();
  const alice = await join('alice'); const bob = await join('bob'); const carol = await join('carol');
  const m = choiceMarket(alice, 'z1', { closeInMs: 3500 });
  await alice.s.createMarket(m);
  const bb = await bob.s.placeBet('z1', 'o2', 100);
  const cb = await carol.s.placeBet('z1', 'o2', 50);
  await waitUntil(m.closesAt);
  await alice.s.reportResult('z1', 'o1');
  await waitUntil((await market('z1')).reportedAt + TEST_CHALLENGE_WINDOW_MS);
  const fin = await bob.s.finalizeMarket('z1');
  assert.equal(fin.status, 'void'); assert.equal(fin.resolvedOptionId, null);
  assert.equal((await bob.s.claimBet(bb.id)).payout, 100);
  assert.equal((await carol.s.claimBet(cb.id)).status, 'void');
  assert.equal(await alice.s.claimBond('z1'), 20);
  assert.equal((await player(bob.uid)).balance, 500);
  assert.equal((await player(alice.uid)).balance, 500);
});

it('creator can void an empty market (and only an empty one); daily market cap', async () => {
  await openGame();
  const alice = await join('alice'); const bob = await join('bob');
  for (let i = 1; i <= 5; i++) await alice.s.createMarket(choiceMarket(alice, `c${i}`, { closeInMs: 60000 }));
  await assert.rejects(alice.s.createMarket(choiceMarket(alice, 'c6', { closeInMs: 60000 })), /5 markets per day/);
  assert.equal((await player(alice.uid)).marketsCount, 5);
  await assert.rejects(bob.s.voidMarket('c1'), /Only the creator/);
  await bob.s.placeBet('c2', 'o1', 10);
  await assert.rejects(alice.s.voidMarket('c2'), /Bets have been placed/);
  await alice.s.voidMarket('c1');
  const mk = await market('c1');
  assert.equal(mk.status, 'void');
  assert.equal(await alice.s.voidMarket('c1').then(() => 'ok', (e) => e.message.replace(/\.$/, '')), 'This market can no longer be voided');
  assert.equal((await bob.s.finalizeMarket('c1')).status, 'void');
  await assert.rejects(bob.s.placeBet('c1', 'o1', 10), /voided/);
});

it('timer markets: per-bet windows (event before the bet voids it), report -> finalize, and expiry auto-finalize via housekeeping', async () => {
  await openGame();
  const eve = await join('eve');
  const [carol, dave, frank, gina, hank] = [await join('carol'), await join('dave'), await join('frank'), await join('gina'), await join('hank')];
  const h1 = houseTimer('t1', { closeInMs: 4000 });
  const h2 = houseTimer('t2', { closeInMs: 1500 });
  await ADMIN.ensureHouseMarkets([h1, h2]);
  await ADMIN.ensureHouseMarkets([h1]); // idempotent
  assert.equal((await adminList('markets2')).length, 2);
  const id1 = h1.id; const id2 = h2.id;

  // expiry market: nobody reports
  const g2 = await gina.s.placeBet(id2, 'quick', 100);
  const hk2 = await hank.s.placeBet(id2, 'never', 100);
  // event market: carol bets before the event, dave after it, frank bets 'never' before it
  const c1 = await carol.s.placeBet(id1, 'quick', 100);
  const f1 = await frank.s.placeBet(id1, 'never', 100);
  await sleep(300);
  const eventAt = Date.now();
  await sleep(50);
  const d1 = await dave.s.placeBet(id1, 'quick', 100);
  assert.ok(d1.placedAt > eventAt);
  // eventAt in the future / before the market opened are refused by the store, and by the rules (attack test)
  await assert.rejects(eve.s.reportResult(id1, null, Date.now() + 60000), /future/);
  await assert.rejects(eve.s.reportResult(id1, null, h1.openedAt - 1000), /before the market opened/);
  await eve.s.reportResult(id1, null, eventAt, 'https://example.com/e');
  const rep = await market(id1);
  assert.equal(rep.status, 'reported'); assert.equal(rep.reportedOptionId, null); assert.equal(rep.reportedEventAt, eventAt);

  // the expiry market: finalize by housekeeping of a client that has nothing to do with it
  await waitUntil(h2.expiresAt);
  const hkResult = await eve.s.runHousekeeping();
  assert.ok(hkResult.finalized >= 1, 'housekeeping finalized the expired timer');
  const m2 = await market(id2);
  assert.equal(m2.status, 'resolved'); assert.equal(m2.resolvedOptionId, 'never'); assert.equal(m2.eventAt, null);
  assert.equal((await gina.s.runHousekeeping()).claimed, 1, 'housekeeping claims my settled bets');
  assert.equal((await hank.s.runHousekeeping()).claimed, 1);
  assert.equal((await bet(g2.id)).status, 'lost');
  assert.equal((await bet(hk2.id)).status, 'won'); assert.equal((await bet(hk2.id)).payout, 150);
  assert.equal((await player(hank.uid)).balance, 550);
  assert.equal((await player(gina.uid)).balance, 400);

  // the reported market: finalize after the challenge window
  await waitUntil(rep.reportedAt + TEST_CHALLENGE_WINDOW_MS);
  const fin = await dave.s.finalizeMarket(id1);
  assert.equal(fin.status, 'resolved'); assert.equal(fin.resolvedOptionId, null); assert.equal(fin.eventAt, eventAt);
  const rc = await carol.s.claimBet(c1.id);
  assert.deepEqual([rc.status, rc.payout], ['won', 300]);
  const rd = await dave.s.claimBet(d1.id);
  assert.deepEqual([rd.status, rd.payout], ['void', 100], 'bet placed after the event is refunded');
  const rf = await frank.s.claimBet(f1.id);
  assert.deepEqual([rf.status, rf.payout], ['lost', 0]);
  await eve.s.runHousekeeping(); // pays her bond back (if her earlier housekeeping run has not already)
  await assert.rejects(eve.s.claimBond(id1), /already been paid/);
  assert.equal((await player(eve.uid)).balance, 500);
  assert.equal((await player(dave.uid)).balance, 500);
});

it('bankruptcy: markBroke, no bailout on the same "day", next-day bailout, 25% penalty tax on a win', async () => {
  await openGame();
  const alice = await join('alice'); const bob = await join('bob');
  const h3 = houseTimer('t3', { closeInMs: 1500 });
  await ADMIN.ensureHouseMarkets([h3]);
  const ab = await alice.s.placeBet(h3.id, 'quick', 500);
  await bob.s.placeBet(h3.id, 'never', 10);
  assert.equal(await alice.s.markBrokeIfNeeded(), false, 'not broke while the stake is open');
  await waitUntil(h3.expiresAt);
  await bob.s.finalizeMarket(h3.id);
  await assert.rejects(alice.s.claimRestart(), /not broke/);
  const lost = await alice.s.claimBet(ab.id);
  assert.equal(lost.status, 'lost');
  let pa = await player(alice.uid);
  assert.equal(pa.balance, 0); assert.equal(pa.openStake, 0);
  // align with a bailout "day" boundary (4s in the test rules) so the same-day check is deterministic
  await sleep(TEST_BAILOUT_DAY_MS - (Date.now() % TEST_BAILOUT_DAY_MS) + 150);
  assert.equal(await alice.s.markBrokeIfNeeded(), true);
  assert.equal(await alice.s.markBrokeIfNeeded(), false);
  pa = await player(alice.uid);
  assert.ok(pa.brokeSince);
  await assert.rejects(alice.s.claimRestart(), /rules rejected/, 'same day: denied by the rules');
  assert.equal((await player(alice.uid)).balance, 0);
  await sleep(TEST_BAILOUT_DAY_MS - (Date.now() % TEST_BAILOUT_DAY_MS) + 100);
  await alice.s.claimRestart();
  pa = await player(alice.uid);
  assert.equal(pa.balance, 100); assert.equal(pa.bankruptcies, 1); assert.equal(pa.brokeSince, null);
  assert.ok(pa.penaltyUntil > Date.now() + 2.9 * DAY_MS && pa.penaltyUntil < Date.now() + 3.1 * DAY_MS);
  await assert.rejects(alice.s.claimRestart(), /not broke/);

  // penalty: a winning bet pays 25% tax on the profit only
  const h4 = houseTimer('t4', { closeInMs: 1500 });
  await ADMIN.ensureHouseMarkets([h4]);
  const wb = await alice.s.placeBet(h4.id, 'never', 40); // odds 1.5 -> gross 60, profit 20, tax 5
  await waitUntil(h4.expiresAt);
  await bob.s.finalizeMarket(h4.id);
  const won = await alice.s.claimBet(wb.id);
  assert.deepEqual([won.status, won.payout, won.taxed], ['won', 55, 5]);
  pa = await player(alice.uid);
  assert.equal(pa.balance, 100 - 40 + 55); assert.equal(pa.totalWon, 55);
});

it('payout parity: fixed odds with float edge cases, pool remainders and the penalty tax all match the rules to the sonnetous', async () => {
  await openGame();
  const alice = await join('alice');
  const bettors = [await join('bob'), await join('carol'), await join('dave'), await join('erin')];
  const [bob, carol, dave, erin] = bettors;
  const closesAt = Date.now() + 5000;
  const mkFixed = (tpl, odds) => economy.normalizeMarket({
    id: `auto-${todayKey()}-${tpl}`, type: 'auto', templateId: tpl, kind: 'choice', mode: 'fixed', title: `Fixed ${tpl} odds`,
    description: 'Counts if: test.', category: 'Test', emoji: '🎯', createdBy: 'house', createdByName: 'The House',
    openedAt: Date.now(), closesAt, options: [{ id: 'o1', label: 'Yes', odds }, { id: 'o2', label: 'No', odds: 2 }],
  });
  const fixed = [['f1', 1.15, 100], ['f2', 1.8, 77], ['f3', 7.7, 33], ['f4', 19.99, 9]];
  await ADMIN.ensureHouseMarkets(fixed.map(([t, o]) => mkFixed(t, o)));
  const fbets = [];
  for (let i = 0; i < 4; i++) fbets.push(await bettors[i].s.placeBet(`auto-${todayKey()}-${fixed[i][0]}`, 'o1', fixed[i][2]));
  // a pool market with awkward remainders: 33 + 71 on o1, 17 + 101 on o2 (cooldowns: one bet per player)
  await alice.s.createMarket(economy.buildCustomMarket({
    id: 'pool1', player: { uid: alice.uid, username: 'alice' }, now: Date.now(), title: 'Pool remainder test', description: '',
    kind: 'choice', optionLabels: ['A', 'B'], closesAt,
  }));
  await sleep(economy.BET_COOLDOWN_MS + 50);
  const pbets = [
    await bob.s.placeBet('pool1', 'o1', 33), await carol.s.placeBet('pool1', 'o1', 71),
    await dave.s.placeBet('pool1', 'o2', 17), await erin.s.placeBet('pool1', 'o2', 101),
  ];
  await waitUntil(closesAt);
  const ids = [...fixed.map(([t]) => `auto-${todayKey()}-${t}`), 'pool1'];
  for (const id of ids.slice(0, 4)) await alice.s.reportResult(id, 'o1');
  await alice.s.reportResult('pool1', 'o1');
  await adminPatch('players', carol.uid, { penaltyUntil: Date.now() + DAY_MS }); // 25% tax on carol's profit
  const reportedAt = Math.max(...(await Promise.all(ids.map((i) => market(i)))).map((m) => m.reportedAt));
  await waitUntil(reportedAt + TEST_CHALLENGE_WINDOW_MS);
  for (const id of ids) assert.equal((await erin.s.finalizeMarket(id)).status, 'resolved');
  // fixed: gross = floor(amount*odds + 1e-9), i.e. 100*1.15 -> 115 (not 114), 77*1.8 -> 138, 33*7.7 -> 254, 9*19.99 -> 179;
  // carol is under penalty: tax floor((138-77)*.25) = 15 on her profit only
  const wantFixed = [[115, 0], [123, 15], [254, 0], [179, 0]];
  for (let i = 0; i < 4; i++) {
    const r = await bettors[i].s.claimBet(fbets[i].id);
    assert.deepEqual([r.status, r.payout, r.taxed], ['won', ...wantFixed[i]], `fixed bet ${i}`);
    assert.equal((await bet(fbets[i].id)).payout, wantFixed[i][0]);
  }
  // pool: floor(33*222/104)=70 ; carol floor(71*222/104)=151, taxed floor((151-71)*.25)=20 -> 131
  // (bob/carol/dave/erin already claimed their fixed bets above, one claim per bet)
  const pb = await bob.s.claimBet(pbets[0].id);
  assert.deepEqual([pb.status, pb.payout, pb.taxed], ['won', 70, 0]);
  const pc = await carol.s.claimBet(pbets[1].id);
  assert.deepEqual([pc.status, pc.payout, pc.taxed], ['won', 131, 20]);
  assert.equal((await dave.s.claimBet(pbets[2].id)).status, 'lost');
  assert.equal((await erin.s.claimBet(pbets[3].id)).payout, 0);
});

it('every plain house template can be created under the rules; a custom timer with the default buckets is accepted', async () => {
  await openGame();
  const alice = await join('alice');
  const now = Date.now();
  const list = templates.PLAIN_TEMPLATE_LIST.map((t) => templates.buildAutoMarket(t, todayKey(), now));
  assert.ok(list.length >= 20);
  await ADMIN.ensureHouseMarkets(list);
  const stored = await adminList('markets2');
  assert.deepEqual(stored.map((m) => m.id).sort(), list.map((m) => m.id).sort(), 'the rules accepted every template');
  // ...idempotent, and the stored docs equal what was built (no field dropped)
  await ADMIN.ensureHouseMarkets(list);
  assert.equal((await adminList('markets2')).length, list.length);
  for (const m of list.slice(0, 3)) {
    const { _id, ...doc } = stored.find((x) => x.id === m.id);
    void _id;
    assert.deepEqual(doc, JSON.parse(JSON.stringify(m)));
  }
  // custom timer market with the default buckets (pinned in the rules) + a bet on it
  const t = economy.buildCustomMarket({ id: 'ctimer', player: { uid: alice.uid, username: 'alice' }, now: Date.now(), title: 'When will the pizza arrive?', description: '', kind: 'timer' });
  await alice.s.createMarket(t);
  const b = await alice.s.placeBet('ctimer', 'd1', 10);
  assert.equal(b.odds, 6);
  const stored2 = await market('ctimer');
  assert.equal(stored2.expiresAt, t.closesAt + 8 * DAY_MS);
  assert.equal(stored2.expiryOptionId, 'never');
});

it('subscriptions deliver live lists (newest first); logged-out calls are friendly and housekeeping never throws', async () => {
  await openGame();
  const alice = await join('alice'); const bob = await join('bob');
  const lonely = await client('lonely');
  assert.deepEqual(await first(lonely, 'subscribeMarkets'), [], 'signed out: empty list');
  assert.deepEqual(await first(lonely, 'subscribePlayers'), []);
  assert.deepEqual(await lonely.runHousekeeping(), { finalized: 0, claimed: 0, bonds: 0 });
  await assert.rejects(lonely.placeBet('x', 'o1', 5), /logged in/);
  await assert.rejects(lonely.markBrokeIfNeeded(), /logged in/);
  await assert.rejects(lonely.claimAdmin('x'), /Sign in/);
  const seen = [];
  const off = alice.s.subscribeMarkets((l) => seen.push(l.map((m) => m.id)));
  const betsSeen = [];
  const offB = bob.s.subscribeBets((l) => betsSeen.push(l.map((b) => b.marketId)));
  await alice.s.createMarket(choiceMarket(alice, 'old1', { closeInMs: 60000 }));
  await sleep(30);
  await alice.s.createMarket(choiceMarket(alice, 'new1', { closeInMs: 60000 }));
  await until2(() => seen.some((l) => l.join() === 'new1,old1'));
  await bob.s.placeBet('old1', 'o1', 5);
  await sleep(economy.BET_COOLDOWN_MS + 50);
  await bob.s.placeBet('new1', 'o1', 5);
  await until2(() => betsSeen.some((l) => l.join() === 'new1,old1'));
  const players = await first(bob.s, 'subscribePlayers', (l) => l.length === 3 && l.find((p) => p.username === 'bob').balance === 490);
  assert.equal(players.find((p) => p.username === 'bob').openStake, 10);
  off(); offB();
  // a house market and housekeeping on an idle client: nothing to do, no throw
  assert.deepEqual(await alice.s.runHousekeeping(), { finalized: 0, claimed: 0, bonds: 0 });
  // concurrent housekeeping calls share one run
  const [h1, h2] = await Promise.all([bob.s.runHousekeeping(), bob.s.runHousekeeping()]);
  assert.deepEqual(h1, h2);
});

it('oracle house markets (price / weather / wiki / quake / sports templates) are accepted by the rules too', async () => {
  await openGame();
  const alice = await join('alice');
  const fx = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  const fakeFetch = async (url) => {
    const u = String(url);
    let body;
    if (u.includes('coinbase') && u.includes('ticker')) body = fx('coinbase-ticker-btc.json');
    else if (u.includes('coinbase')) body = fx('coinbase-candles-btc-1h.json');
    else if (u.includes('open-meteo')) body = fx(u.includes('latitude=40') ? 'openmeteo-forecast-nyc.json' : 'openmeteo-forecast-london.json');
    else if (u.includes('wikimedia')) {
      body = { items: Array.from({ length: 30 }, (_, i) => ({ timestamp: `2026${String(9).padStart(2, '0')}${String(i + 1).padStart(2, '0')}00`, views: 1000 + i * 37 })) };
    } else if (u.includes('espn')) body = fx('espn-scoreboard-nba-pre.json');
    else body = {};
    return { ok: true, status: 200, json: async () => body };
  };
  const now = Date.now();
  const list = await templates.buildDailyMarkets(todayKey(), now, {
    fetchers: (await import('../js/oracles.js')).createFetchers({ fetch: fakeFetch }), oracleCount: 12, otherCount: 0, maxOracleAttempts: 40,
  });
  const oracles = list.filter((m) => m.oracle);
  assert.ok(oracles.length >= 2, `built ${oracles.length} oracle markets`);
  await ADMIN.ensureHouseMarkets(list);
  const stored = new Set((await adminList('markets2')).map((m) => m.id));
  for (const m of list) assert.ok(stored.has(m.id), `rules accepted ${m.id} (${m.oracle ? m.oracle.type : 'plain'})`);
});

it('house markets are admin-only: ensureHouseMarkets is a silent no-op for players, works for the admin', async () => {
  const admin = await openGame();
  const alice = await join('alice');
  const h = houseTimer('tadm', { closeInMs: 30000 });
  await alice.s.ensureHouseMarkets([h]); // no throw, no write
  assert.equal((await adminList('markets2')).length, 0);
  await admin.ensureHouseMarkets([h]);
  assert.deepEqual((await adminList('markets2')).map((m) => m.id), [h.id]);
  assert.equal((await alice.s.placeBet(h.id, 'never', 10)).marketId, h.id);
});

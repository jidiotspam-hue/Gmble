// Attack tests for firestore.rules (v2): everything a hostile player could try from the browser console with
// a valid login. Each attack is a raw Firestore write (no store code in the way) that must be DENIED and must
// leave the database byte-for-byte unchanged; every attack family ends with a positive CONTROL (the same
// batch, built correctly, is accepted) so a denial cannot be an accident of the setup.
// SKIPPED unless the Firebase emulators + SDK are available - see the header of tests/rules-helpers.mjs /
// tests/firebase-store.test.mjs for run instructions:
//   FB_SDK_DIR=/tmp/fb node --test --test-force-exit tests/
// Uses the TEST copy of the rules (admin code 'test-admin-code', 12h/24h windows -> 4s, bailout day -> 4s).
import test, { before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseStore } from '../js/store/firebase.js';
import * as economy from '../js/economy.js';
import {
  fbConfig, emulator, loadEnv, pushRules, acquireLock, releaseLock, resetEmulator, adminList, adminGet, sleep,
  sha256hex, REST, adminPatch, TEST_ADMIN_CODE, TEST_CHALLENGE_WINDOW_MS, TEST_VOTE_WINDOW_MS, TEST_BAILOUT_DAY_MS,
} from './rules-helpers.mjs';

const { sdk, skip } = await loadEnv();
const it = (name, fn) => test(name, { skip, timeout: 180000 }, fn);
const F = sdk && sdk.firestore;
const { DAY_MS, HOUR_MS } = economy;
const todayKey = () => economy.utcDayKey(Date.now());

let n = 0;
const stores = [];
const rawApps = [];
before(async () => {
  if (skip) return;
  await acquireLock();
  await pushRules();
  await resetEmulator();
});
after(async () => {
  if (skip) return;
  for (const s of stores) { try { await s.signOut(); } catch { /* ignore */ } await s._dispose(); }
  for (const a of rawApps) { try { await sdk.firestore.terminate(a.db); await sdk.app.deleteApp(a.app); } catch { /* ignore */ } }
  releaseLock();
});

async function client(label) {
  const s = await createFirebaseStore(fbConfig, {
    sdk, emulator, appName: `${label}${++n}`, now: () => Date.now(), decisionNow: () => Date.now() + 26 * HOUR_MS,
  });
  stores.push(s);
  await s.init();
  return s;
}
/** A raw Firestore handle authenticated as `name` (or anonymous when name is null). */
async function rawDb(name, pw = 'secret1') {
  const app = sdk.app.initializeApp(fbConfig, `raw${name || 'anon'}${++n}`);
  const db = F.getFirestore(app);
  F.connectFirestoreEmulator(db, emulator.firestoreHost, emulator.firestorePort);
  const auth = sdk.auth.getAuth(app);
  sdk.auth.connectAuthEmulator(auth, emulator.authUrl, { disableWarnings: true });
  let uid = null;
  if (name) uid = (await sdk.auth.signInWithEmailAndPassword(auth, `${name.toLowerCase()}@users.sonnetous.app`, pw)).user.uid;
  rawApps.push({ app, db });
  return { db, uid, auth };
}
/** Real player (signed up through the store) + a raw handle for attacks. */
async function actor(name) {
  const s = await client(name);
  const p = await s.signUp(name, 'secret1');
  const raw = await rawDb(name);
  return { s, uid: p.uid, name, db: raw.db, auth: raw.auth };
}
const D = (db, path) => F.doc(db, path);
const isDenied = (e) => e && e.code === 'permission-denied';

const COLLS = ['players', 'markets2', 'bets2', 'stakes', 'votes', 'bans', 'handles', 'app'];
async function snapshot() {
  const out = {};
  for (const c of COLLS) out[c] = (await adminList(c)).sort((a, b) => (a._id < b._id ? -1 : 1));
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(canon(out));
}
/** The attack must be denied AND change nothing. */
async function denied(label, fn) {
  const before = await snapshot();
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `ATTACK SUCCEEDED (should be denied): ${label}`);
  assert.ok(isDenied(err), `${label}: expected permission-denied, got ${err && (err.code || err.message)}`);
  assert.equal(await snapshot(), before, `${label}: database changed`);
}
const allowed = async (label, fn) => { try { await fn(); } catch (e) { throw new Error(`CONTROL FAILED (should be allowed): ${label}: ${e.code || ''} ${e.message}`); } };
const readDenied = async (label, fn) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err && isDenied(err), `read should be denied: ${label} (${err && (err.code || err.message)})`);
};

// ---- admin ground truth writes (emulator bypass), used only to fast-forward state that would take days
const player = (a) => adminGet('players', a.uid);
const market = (id) => adminGet('markets2', id);
const waitUntil = async (ms) => { const d = ms - Date.now(); if (d > 0) await sleep(d + 40); };

// ---- market fixtures
function choice(a, id, closeInMs = 600000) {
  const now = Date.now();
  return economy.buildCustomMarket({
    id, player: { uid: a.uid, username: a.name }, now, title: `Attack target ${id}`, description: '', kind: 'choice',
    optionLabels: ['Yes', 'No'], closesAt: now + closeInMs,
  });
}
function houseMarket(tpl, o = {}) {
  const now = Date.now();
  const closeInMs = o.closeInMs ?? 600000;
  const timer = o.kind === 'timer';
  return economy.normalizeMarket({
    id: `auto-${todayKey()}-${tpl}`, type: 'auto', templateId: tpl, kind: o.kind || 'choice', mode: 'fixed', title: `House ${tpl}`,
    description: 'Counts if: test.', category: 'Test', emoji: '🏠', createdBy: 'house', createdByName: 'The House',
    openedAt: now, closesAt: now + closeInMs,
    options: timer
      ? [{ id: 'quick', label: 'Quick', odds: 3, fromDays: 0, toDays: 3000 / DAY_MS }, { id: 'never', label: 'Later', odds: 1.5, fromDays: 3000 / DAY_MS, toDays: null }]
      : [{ id: 'o1', label: 'Yes', odds: 3 }, { id: 'o2', label: 'No', odds: 1.5 }],
  });
}

// ---- raw batch builders (mirror the store's batches; `ov.<doc>` overrides fields, `null` omits that write)
let seq = 0;
async function betBatch(a, mid, opt, amt, ov = {}) {
  const [p, m, st] = await Promise.all([adminGet('players', a.uid), adminGet('markets2', mid), adminGet('stakes', `${mid}_${a.uid}`)]);
  const now = ov.now ?? Date.now();
  const id = ov.id ?? `x${Date.now().toString(36)}${++seq}`;
  const bet = {
    id, marketId: mid, marketTitle: m.title, uid: a.uid, username: a.name, optionId: opt, optionLabel: opt, amount: amt,
    odds: m.mode === 'fixed' ? m.oddsById[opt] : null, placedAt: now, status: 'open', payout: 0, taxed: 0, claimedAt: null, ...ov.bet,
  };
  const pl = {
    balance: p.balance - amt, openStake: p.openStake + amt, totalWagered: p.totalWagered + amt, lastBetAt: now, lastBetId: id, ...ov.player,
  };
  const stake = ov.stake === undefined ? { marketId: mid, uid: a.uid, amount: (st ? st.amount : 0) + amt } : ov.stake;
  const totals = { ...m.optionTotals }; totals[opt] = (totals[opt] || 0) + amt;
  const mk = { optionTotals: totals, totalPool: m.totalPool + amt, betCount: m.betCount + 1, lastBetId: id, ...ov.market };
  const b = F.writeBatch(a.db);
  if (ov.bet !== null) b.set(D(a.db, `bets2/${id}`), bet);
  if (ov.player !== null) b.update(D(a.db, `players/${a.uid}`), pl);
  if (stake !== null) { if (st) b.update(D(a.db, `stakes/${mid}_${a.uid}`), stake); else b.set(D(a.db, `stakes/${mid}_${a.uid}`), stake); }
  if (ov.market !== null) b.update(D(a.db, `markets2/${mid}`), mk);
  return { commit: () => b.commit(), id };
}
async function reportBatch(a, mid, opt, eventAt, ov = {}) {
  const p = await adminGet('players', a.uid);
  const now = Date.now();
  const mk = {
    status: 'reported', reportedBy: a.uid, reportedByName: a.name, reportedOptionId: opt, reportedEventAt: eventAt ?? null,
    reportedAt: now, evidence: null, ...ov.market,
  };
  const pl = { balance: p.balance - economy.BOND, lastBondMarketId: mid, ...ov.player };
  const b = F.writeBatch(a.db);
  if (ov.market !== null) b.update(D(a.db, `markets2/${mid}`), mk);
  if (ov.player !== null) b.update(D(a.db, `players/${a.uid}`), pl);
  return b.commit();
}
async function challengeBatch(a, mid, ov = {}) {
  const p = await adminGet('players', a.uid);
  const mk = { status: 'challenged', challengedBy: a.uid, challengedByName: a.name, challengedAt: Date.now(), ...ov.market };
  const pl = { balance: p.balance - economy.BOND, lastBondMarketId: mid, ...ov.player };
  const b = F.writeBatch(a.db);
  if (ov.market !== null) b.update(D(a.db, `markets2/${mid}`), mk);
  if (ov.player !== null) b.update(D(a.db, `players/${a.uid}`), pl);
  return b.commit();
}
async function voteBatch(a, mid, uphold, ov = {}) {
  const m = await adminGet('markets2', mid);
  const vid = ov.voteId ?? `${mid}_${a.uid}`;
  const vote = { marketId: mid, uid: a.uid, uphold, at: Date.now(), ...ov.vote };
  const mk = uphold
    ? { votesUphold: m.votesUphold + 1, lastVoteId: vid, ...ov.market }
    : { votesOverturn: m.votesOverturn + 1, lastVoteId: vid, ...ov.market };
  const b = F.writeBatch(a.db);
  if (ov.vote !== null) b.set(D(a.db, `votes/${vid}`), vote);
  if (ov.market !== null) b.update(D(a.db, `markets2/${mid}`), mk);
  return b.commit();
}
const finalizeWrite = (a, mid, patch) => F.updateDoc(D(a.db, `markets2/${mid}`), { resolvedAt: Date.now(), ...patch });
async function claimBatch(a, betId, ov = {}) {
  const [bt, p] = await Promise.all([adminGet('bets2', betId), adminGet('players', a.uid)]);
  const m = await adminGet('markets2', bt.marketId);
  const won = bt.optionId === m.resolvedOptionId && m.status === 'resolved';
  const res = economy.betClaim(bt, m, p, Date.now());
  const bp = { status: res.status, payout: res.payout, taxed: res.taxed, claimedAt: Date.now(), ...ov.bet };
  const pl = {
    balance: p.balance + res.payout, openStake: p.openStake - bt.amount,
    totalWon: p.totalWon + (res.status === 'won' ? res.payout : 0), lastClaimId: betId, ...ov.player,
  };
  void won;
  const b = F.writeBatch(a.db);
  if (ov.bet !== null) b.update(D(a.db, `bets2/${betId}`), bp);
  if (ov.player !== null) b.update(D(a.db, `players/${a.uid}`), pl);
  return b.commit();
}
async function bondClaimBatch(a, mid, flag, amount, ov = {}) {
  const p = await adminGet('players', a.uid);
  const b = F.writeBatch(a.db);
  if (ov.market !== null) b.update(D(a.db, `markets2/${mid}`), { [flag]: true, ...ov.market });
  if (ov.player !== null) b.update(D(a.db, `players/${a.uid}`), { balance: p.balance + amount, lastBondMarketId: mid, ...ov.player });
  return b.commit();
}

/** Drives a fresh choice market through: bets -> close -> report -> (optional) unchallenged window -> resolved. */
async function chain(creator, id, bets, { report = 'o1', closeInMs = 2600 } = {}) {
  const m = choice(creator, id, closeInMs);
  await creator.s.createMarket(m);
  const placed = [];
  for (const [who, opt, amt] of bets) placed.push(await who.s.placeBet(id, opt, amt));
  await waitUntil(m.closesAt);
  if (report) await creator.s.reportResult(id, report);
  return { m, placed };
}

// =============================================================================================
let W = null; // the shared world
let oldClaim = null; // a settled, paid-out bet of bob's (from the dispute test), replayed later
async function world() {
  if (W) return W;
  const admin = await client('admin');
  await admin.signUp('Admin', 'secret1').catch(() => {});
  await admin.claimAdmin(TEST_ADMIN_CODE);
  await admin.setMaintenance(false);
  const adminRaw = await rawDb('Admin');
  const w = { admin, adminRaw, adminUid: adminRaw.uid };
  for (const nm of ['alice', 'bob', 'carol', 'dave', 'mallory', 'frank', 'gina']) w[nm] = await actor(nm);
  W = w;
  return w;
}

it('control: the raw batch builders are accepted when correct (so later denials are meaningful)', async () => {
  const w = await world();
  const { bob, alice } = w;
  await alice.s.createMarket(choice(alice, 'ctl'));
  await allowed('raw placeBet', async () => (await betBatch(bob, 'ctl', 'o1', 10)).commit());
  const pb = await player(bob);
  assert.equal(pb.balance, 490); assert.equal(pb.openStake, 10);
  assert.equal((await market('ctl')).betCount, 1);
});

it('identity and balance: nobody edits another player, nobody raises their own balance', async () => {
  const w = await world();
  const { mallory, bob, alice } = w;
  await sleep(economy.BET_COOLDOWN_MS + 100);
  const mp = await player(mallory);
  const bobDoc = () => D(mallory.db, `players/${bob.uid}`);
  const meDoc = () => D(mallory.db, `players/${mallory.uid}`);
  await denied('edit another player balance', () => F.updateDoc(bobDoc(), { balance: 1 }));
  await denied('edit another player anything', () => F.updateDoc(bobDoc(), { username: 'pwned' }));
  await denied('edit another player openStake', () => F.updateDoc(bobDoc(), { openStake: 0 }));
  await denied('overwrite another player', () => F.setDoc(bobDoc(), { ...mp, uid: bob.uid }));
  await denied('raise own balance', () => F.updateDoc(meDoc(), { balance: 1000000 }));
  await denied('raise own balance by 1', () => F.updateDoc(meDoc(), { balance: mp.balance + 1 }));
  await denied('raise totalWon', () => F.updateDoc(meDoc(), { totalWon: 1000 }));
  await denied('fake claim pointer + balance', () => F.updateDoc(meDoc(), { balance: mp.balance + 100, lastClaimId: 'whatever' }));
  await denied('fake bond pointer + balance', () => F.updateDoc(meDoc(), { balance: mp.balance + 40, lastBondMarketId: 'ctl' }));
  await denied('fake bet pointer + balance', () => F.updateDoc(meDoc(), { balance: mp.balance + 40, lastBetId: 'nope', lastBetAt: Date.now() }));
  await denied('self-award via bailout fields', () => F.updateDoc(meDoc(), { balance: 100, bankruptcies: 1, brokeSince: null, penaltyUntil: null }));
  await denied('change username', () => F.updateDoc(meDoc(), { username: 'Bobby' }));
  await denied('change uid', () => F.updateDoc(meDoc(), { uid: 'someoneelse' }));
  await denied('drop the cooldown', () => F.updateDoc(meDoc(), { lastBetAt: 0 }));
  await denied('reset market counter', () => F.updateDoc(meDoc(), { marketsCount: 0, marketsDay: 0 }));
  await denied('extra field', () => F.updateDoc(meDoc(), { admin: true }));
  await denied('delete player', () => F.deleteDoc(meDoc()));

  // bet documents without / with a wrong player update
  const M = 'ctl';
  await denied('bet without player deduction', async () => (await betBatch(mallory, M, 'o1', 50, { player: null })).commit());
  await denied('bet with smaller deduction', async () => (await betBatch(mallory, M, 'o1', 50, { player: { balance: mp.balance - 1 } })).commit());
  await denied('bet: openStake not raised', async () => (await betBatch(mallory, M, 'o1', 50, { player: { openStake: mp.openStake } })).commit());
  await denied('bet: totalWagered not raised', async () => (await betBatch(mallory, M, 'o1', 50, { player: { totalWagered: mp.totalWagered } })).commit());
  await denied('bet without market update', async () => (await betBatch(mallory, M, 'o1', 50, { market: null })).commit());
  await denied('bet without stake doc', async () => (await betBatch(mallory, M, 'o1', 50, { stake: null })).commit());
  await denied('market totals inflated', async () => (await betBatch(mallory, M, 'o1', 50, { market: { totalPool: 999999 } })).commit());
  await denied('market total for the other option', async () => (await betBatch(mallory, M, 'o1', 50, { market: { optionTotals: { o1: 10, o2: 50 } } })).commit());
  await denied('betCount +2', async () => (await betBatch(mallory, M, 'o1', 50, { market: { betCount: 99 } })).commit());
  await denied('player update without bet doc', async () => (await betBatch(mallory, M, 'o1', 50, { bet: null })).commit());
  await denied('market update without bet doc', async () => (await betBatch(mallory, M, 'o1', 50, { bet: null, player: null, stake: null })).commit());
  await denied('bet on behalf of someone else', async () => (await betBatch(mallory, M, 'o1', 50, { bet: { uid: bob.uid, username: 'bob' } })).commit());
  await denied('bet under a fake username', async () => (await betBatch(mallory, M, 'o1', 50, { bet: { username: 'alice' } })).commit());
  await denied('bet doc id mismatch', async () => (await betBatch(mallory, M, 'o1', 50, { bet: { id: 'other' } })).commit());
  await denied('bet born settled', async () => (await betBatch(mallory, M, 'o1', 50, { bet: { status: 'won', payout: 500 } })).commit());
  await denied('bet with payout preset', async () => (await betBatch(mallory, M, 'o1', 50, { bet: { payout: 10 } })).commit());
  await denied('bet on unknown option', async () => (await betBatch(mallory, M, 'oX', 50, { market: { optionTotals: { o1: 10, o2: 0, oX: 50 } } })).commit());
  await denied('bet with odds on a pool market', async () => (await betBatch(mallory, M, 'o1', 50, { bet: { odds: 20 } })).commit());
  await denied('zero bet', async () => (await betBatch(mallory, M, 'o1', 0)).commit());
  await denied('negative bet (mint money)', async () => (await betBatch(mallory, M, 'o1', -100)).commit());
  await denied('fractional bet', async () => (await betBatch(mallory, M, 'o1', 1.5)).commit());
  await denied('bet beyond balance', async () => (await betBatch(mallory, M, 'o1', mp.balance + 1)).commit());
  await denied('backdated placedAt', async () => (await betBatch(mallory, M, 'o1', 50, { now: Date.now() - 120000 })).commit());
  await denied('future placedAt', async () => (await betBatch(mallory, M, 'o1', 50, { now: Date.now() + 20 * 60000 })).commit());
  await denied('bet on a missing market', async () => (await betBatch(mallory, M, 'o1', 50, { bet: { marketId: 'ghost' } })).commit());
  await denied('bet whose stake doc belongs to someone else', async () => (await betBatch(mallory, M, 'o1', 50, { stake: { marketId: M, uid: bob.uid, amount: 50 } })).commit());
  // the same bet, built correctly, is accepted
  await allowed('valid bet', async () => (await betBatch(mallory, M, 'o1', 50)).commit());
  const mp2 = await player(mallory);
  assert.equal(mp2.balance, 450); assert.equal(mp2.openStake, 50);
  // faster than the 2s cooldown
  await denied('second bet inside the cooldown', async () => (await betBatch(mallory, M, 'o2', 10)).commit());
  await sleep(economy.BET_COOLDOWN_MS + 100);
  await allowed('bet after the cooldown', async () => (await betBatch(mallory, M, 'o2', 10)).commit());
  await denied('replay an OLD bet against the market totals (market doc only)', async () => {
    const cur = await market(M);
    const old = (await adminList('bets2')).find((b) => b.marketId === M && b.id !== cur.lastBetId);
    assert.ok(old);
    const totals = { ...cur.optionTotals }; totals[old.optionId] += old.amount;
    return F.updateDoc(D(mallory.db, `markets2/${M}`), { optionTotals: totals, totalPool: cur.totalPool + old.amount, betCount: cur.betCount + 1, lastBetId: old.id });
  });
});

it('betting is closed after closesAt, on reported markets and for banned/unknown states', async () => {
  const w = await world();
  const { alice, mallory, bob } = w;
  const m = choice(alice, 'closing', 2500);
  await alice.s.createMarket(m);
  await sleep(economy.BET_COOLDOWN_MS + 100);
  await waitUntil(m.closesAt);
  await denied('bet after closesAt', async () => (await betBatch(mallory, 'closing', 'o1', 10)).commit());
  await alice.s.reportResult('closing', 'o1');
  await denied('bet on a reported market', async () => (await betBatch(mallory, 'closing', 'o1', 10)).commit());
  // a custom market cannot be re-opened or edited by its creator either
  await denied('creator reopens market', () => F.updateDoc(D(alice.db, 'markets2/closing'), { status: 'open' }));
  await denied('creator moves closesAt', () => F.updateDoc(D(alice.db, 'markets2/closing'), { closesAt: Date.now() + 1e7 }));
  await denied('creator edits title', () => F.updateDoc(D(alice.db, 'markets2/closing'), { title: 'changed' }));
  await denied('creator edits totals', () => F.updateDoc(D(alice.db, 'markets2/closing'), { totalPool: 5 }));
  await denied('creator resolves directly', () => F.updateDoc(D(alice.db, 'markets2/closing'), { status: 'resolved', resolvedOptionId: 'o1', resolvedAt: Date.now() }));
  void bob;
});

it('fixed-odds markets: odds cannot be forged; custom timers are pinned; house markets are validated', async () => {
  const w = await world();
  const { alice, mallory, bob } = w;
  const h = houseMarket('fixed1');
  await denied('a player creating a (valid) house market', () => F.setDoc(D(alice.db, `markets2/${h.id}`), h));
  const plTimer = houseMarket('pl1', { kind: 'timer' });
  await denied('a player creating a (valid) house timer', () => F.setDoc(D(alice.db, `markets2/${plTimer.id}`), plTimer));
  await allowed('house market create as admin', () => F.setDoc(D(w.adminRaw.db, `markets2/${h.id}`), h));
  await sleep(economy.BET_COOLDOWN_MS + 100);
  await denied('forged odds (20 instead of 3)', async () => (await betBatch(mallory, h.id, 'o1', 10, { bet: { odds: 20 } })).commit());
  await denied('odds below 1.01', async () => (await betBatch(mallory, h.id, 'o2', 10, { bet: { odds: 1 } })).commit());
  await denied('null odds on a fixed market', async () => (await betBatch(mallory, h.id, 'o1', 10, { bet: { odds: null } })).commit());
  await allowed('fixed bet with the real odds', async () => (await betBatch(mallory, h.id, 'o1', 10)).commit());

  // house market creation rules
  const bad = (over) => ({ ...houseMarket(over.tpl || 'zz'), ...over });
  const create = (who, m) => F.setDoc(D(who.db, `markets2/${m.id}`), m);
  const adm = { db: w.adminRaw.db }; // the structural house-market checks are attempted AS ADMIN, so they are what denies them
  await denied('house market with someone else as creator', () => create(adm, bad({ tpl: 'a1', createdBy: bob.uid, type: 'custom' })));
  await denied('house market for tomorrow', () => create(adm, bad({ tpl: 'a2', id: `auto-${economy.utcDayKey(Date.now() + 2 * DAY_MS)}-a2` })));
  await denied('house market id without date', () => create(adm, bad({ tpl: 'a3', id: 'auto-x-a3' })));
  await denied('house market id does not match template', () => create(adm, bad({ tpl: 'a4', templateId: 'other' })));
  await denied('house market pre-loaded with a pool', () => create(adm, bad({ tpl: 'a5', totalPool: 5000, optionTotals: { o1: 5000, o2: 0 } })));
  await denied('house market already reported', () => create(adm, bad({ tpl: 'a6', status: 'reported', reportedBy: bob.uid })));
  await denied('house market with extra field', () => create(adm, bad({ tpl: 'a7', sneaky: true })));
  await denied('house market that closes in the past', () => create(adm, bad({ tpl: 'a8', closesAt: Date.now() - 1000 })));
  await denied('house market with odds map missing an option', () => create(adm, bad({ tpl: 'a9', oddsById: { o1: 3 } })));
  await denied('house timer whose expiry is not closesAt+bucket start', () => create(adm, { ...houseMarket('a10', { kind: 'timer' }), expiresAt: Date.now() + 5 }));
  await denied('house market overwrite (id exists)', () => create(adm, { ...h, title: 'hijacked' }));
  await denied('custom market squatting an auto id', async () => {
    const c = choice(bob, `auto-${todayKey()}-squat`);
    await F.setDoc(D(bob.db, `markets2/${c.id}`), c);
  });
  // custom market rules (with/without the player counter bump)
  const c1 = choice(bob, 'custom-a');
  await denied('custom market without the daily counter bump', () => create(bob, c1));
  await denied('custom market as someone else', async () => {
    const b = F.writeBatch(mallory.db);
    b.set(D(mallory.db, 'markets2/custom-b'), choice(bob, 'custom-b'));
    b.update(D(mallory.db, `players/${mallory.uid}`), { marketsDay: economy.utcDayNumber(Date.now()), marketsCount: 1 });
    await b.commit();
  });
  await denied('custom timer with forged odds', async () => {
    const t = economy.buildCustomMarket({ id: 'custom-t', player: { uid: mallory.uid, username: 'mallory' }, now: Date.now(), title: 'Timer forge', description: '', kind: 'timer' });
    t.oddsById = { ...t.oddsById, never: 20 };
    const b = F.writeBatch(mallory.db);
    b.set(D(mallory.db, 'markets2/custom-t'), t);
    b.update(D(mallory.db, `players/${mallory.uid}`), { marketsDay: economy.utcDayNumber(Date.now()), marketsCount: 1 });
    await b.commit();
  });
  await denied('custom timer with a short expiry', async () => {
    const t = economy.buildCustomMarket({ id: 'custom-t2', player: { uid: mallory.uid, username: 'mallory' }, now: Date.now(), title: 'Timer expiry', description: '', kind: 'timer' });
    t.expiresAt = t.closesAt + 1000;
    const b = F.writeBatch(mallory.db);
    b.set(D(mallory.db, 'markets2/custom-t2'), t);
    b.update(D(mallory.db, `players/${mallory.uid}`), { marketsDay: economy.utcDayNumber(Date.now()), marketsCount: 1 });
    await b.commit();
  });
  await denied('custom fixed-odds choice market (only pools allowed)', async () => {
    const t = choice(mallory, 'custom-f');
    t.mode = 'fixed'; t.oddsById = { o1: 20, o2: 20 };
    const b = F.writeBatch(mallory.db);
    b.set(D(mallory.db, 'markets2/custom-f'), t);
    b.update(D(mallory.db, `players/${mallory.uid}`), { marketsDay: economy.utcDayNumber(Date.now()), marketsCount: 1 });
    await b.commit();
  });
  await denied('custom market with pre-filled pool', async () => {
    const t = choice(mallory, 'custom-p');
    t.totalPool = 100; t.optionTotals = { o1: 100, o2: 0 };
    const b = F.writeBatch(mallory.db);
    b.set(D(mallory.db, 'markets2/custom-p'), t);
    b.update(D(mallory.db, `players/${mallory.uid}`), { marketsDay: economy.utcDayNumber(Date.now()), marketsCount: 1 });
    await b.commit();
  });
  await adminPatch('players', bob.uid, { marketsDay: economy.utcDayNumber(Date.now()), marketsCount: 5 });
  await denied('sixth custom market of the day', async () => {
    const day = economy.utcDayNumber(Date.now());
    const b = F.writeBatch(bob.db);
    b.set(D(bob.db, 'markets2/custom-6'), choice(bob, 'custom-6'));
    b.update(D(bob.db, `players/${bob.uid}`), { marketsDay: day, marketsCount: 6 });
    await b.commit();
  });
  await denied('reset the counter to dodge the cap', async () => {
    const b = F.writeBatch(bob.db);
    b.set(D(bob.db, 'markets2/custom-6'), choice(bob, 'custom-6'));
    b.update(D(bob.db, `players/${bob.uid}`), { marketsDay: economy.utcDayNumber(Date.now()), marketsCount: 1 });
    await b.commit();
  });
  await adminPatch('players', bob.uid, { marketsDay: 0, marketsCount: 0 });
  await allowed('valid custom market', async () => {
    const b = F.writeBatch(bob.db);
    b.set(D(bob.db, 'markets2/custom-ok'), choice(bob, 'custom-ok'));
    b.update(D(bob.db, `players/${bob.uid}`), { marketsDay: economy.utcDayNumber(Date.now()), marketsCount: 1 });
    await b.commit();
  });
});

it('sign-up: players start at exactly 500 and own a unique handle', async () => {
  const w = await world();
  const { alice } = w;
  // raw Auth accounts without a player doc
  const raw = async (name) => {
    const app = sdk.app.initializeApp(fbConfig, `su${name}${++n}`);
    const auth = sdk.auth.getAuth(app);
    sdk.auth.connectAuthEmulator(auth, emulator.authUrl, { disableWarnings: true });
    const cred = await sdk.auth.createUserWithEmailAndPassword(auth, `${name}@users.sonnetous.app`, 'secret1');
    const db = F.getFirestore(app);
    F.connectFirestoreEmulator(db, emulator.firestoreHost, emulator.firestorePort);
    rawApps.push({ app, db });
    return { db, uid: cred.user.uid };
  };
  const base = (uid, username, over = {}) => ({
    uid, username, balance: 500, openStake: 0, createdAt: Date.now(), bankruptcies: 0, brokeSince: null, penaltyUntil: null,
    totalWagered: 0, totalWon: 0, lastBetAt: 0, marketsDay: 0, marketsCount: 0, lastClaimId: null, lastBondMarketId: null, ...over,
  });
  const signup = (u, username, player, handle = username.toLowerCase(), handleUid = u.uid) => {
    const b = F.writeBatch(u.db);
    b.set(D(u.db, `handles/${handle}`), { uid: handleUid });
    b.set(D(u.db, `players/${u.uid}`), player);
    return b.commit();
  };
  const u1 = await raw('newbie1');
  await denied('sign up with 5000', () => signup(u1, 'newbie1', base(u1.uid, 'newbie1', { balance: 5000 })));
  await denied('sign up with 501', () => signup(u1, 'newbie1', base(u1.uid, 'newbie1', { balance: 501 })));
  await denied('sign up with a penalty', () => signup(u1, 'newbie1', base(u1.uid, 'newbie1', { penaltyUntil: 1 })));
  await denied('sign up with wins', () => signup(u1, 'newbie1', base(u1.uid, 'newbie1', { totalWon: 5 })));
  await denied('sign up with open stake', () => signup(u1, 'newbie1', base(u1.uid, 'newbie1', { openStake: 5 })));
  await denied('sign up with extra field', () => signup(u1, 'newbie1', { ...base(u1.uid, 'newbie1'), isAdmin: true }));
  await denied('sign up with a bad username', () => signup(u1, 'x!', base(u1.uid, 'x!'), 'x!'));
  await denied('sign up as someone else uid', () => signup(u1, 'newbie1', base(alice.uid, 'newbie1')));
  await denied('sign up stealing alice handle', () => signup(u1, 'newbie1', base(u1.uid, 'alice'), 'alice'));
  await denied('sign up with a handle for another uid', () => signup(u1, 'newbie1', base(u1.uid, 'newbie1'), 'newbie1', alice.uid));
  await denied('sign up with a handle that does not match the name', () => signup(u1, 'newbie1', base(u1.uid, 'newbie1'), 'somethingelse'));
  await denied('player without a handle', () => F.setDoc(D(u1.db, `players/${u1.uid}`), base(u1.uid, 'newbie1')));
  await denied('handle without a player', () => F.setDoc(D(u1.db, 'handles/newbie1'), { uid: u1.uid }));
  await denied('handle for an unrelated name', () => F.setDoc(D(u1.db, 'handles/reserved'), { uid: u1.uid }));
  await denied('createdAt in the far past', () => signup(u1, 'newbie1', base(u1.uid, 'newbie1', { createdAt: 5 })));
  await allowed('valid sign-up', () => signup(u1, 'Newbie1', base(u1.uid, 'Newbie1')));
  await denied('second player doc for the same account', async () => {
    const b = F.writeBatch(u1.db);
    b.set(D(u1.db, 'handles/another'), { uid: u1.uid });
    b.set(D(u1.db, `players/${u1.uid}`), base(u1.uid, 'another'));
    await b.commit();
  });
  await denied('change a handle', () => F.setDoc(D(u1.db, 'handles/newbie1'), { uid: alice.uid }));
});

it('report / challenge / vote / finalize: creator-only, bond, windows, wrong results', async () => {
  const w = await world();
  const { alice, bob, carol, dave, mallory, frank, gina } = w;
  // ---- market R: bob and carol bet, alice creates. Everything below targets it.
  await sleep(economy.BET_COOLDOWN_MS + 100);
  const m = choice(alice, 'R', 3000);
  await alice.s.createMarket(m);
  const bb = await bob.s.placeBet('R', 'o1', 100);
  const cb = await carol.s.placeBet('R', 'o2', 100);
  // reporting before the market closed (reportableAt = closesAt)
  await denied('early report', () => reportBatch(alice, 'R', 'o1', null));
  await waitUntil(m.closesAt);
  await denied('report by a non-creator on a custom market', () => reportBatch(mallory, 'R', 'o1', null));
  await denied('report by the creator without paying the bond', () => reportBatch(alice, 'R', 'o1', null, { player: null }));
  await denied('report paying too little', async () => { const p = await player(alice); return reportBatch(alice, 'R', 'o1', null, { player: { balance: p.balance - 1 } }); });
  await denied('report claiming the bond of another market', () => reportBatch(alice, 'R', 'o1', null, { player: { lastBondMarketId: 'ctl' } }));
  await denied('report pretending to be someone else', () => reportBatch(alice, 'R', 'o1', null, { market: { reportedBy: bob.uid, reportedByName: 'bob' } }));
  await denied('report with an unknown option', () => reportBatch(alice, 'R', 'oX', null));
  await denied('report with a timer eventAt on a choice market', () => reportBatch(alice, 'R', 'o1', Date.now() - 1000));
  await denied('report with 301 chars of evidence', () => reportBatch(alice, 'R', 'o1', null, { market: { evidence: 'x'.repeat(301) } }));
  await denied('report that also edits closesAt', () => reportBatch(alice, 'R', 'o1', null, { market: { closesAt: 5 } }));
  await denied('report that also pays out', async () => { const p = await player(alice); return reportBatch(alice, 'R', 'o1', null, { player: { balance: p.balance + 500 } }); });
  await denied('report skipping straight to resolved', () => reportBatch(alice, 'R', 'o1', null, { market: { status: 'resolved' } }));
  await allowed('valid report', () => reportBatch(alice, 'R', 'o1', null));
  const rep = await market('R');
  await denied('report twice', () => reportBatch(alice, 'R', 'o2', null));

  // ---- challenge: own report, without bond, wrong shape
  await denied('challenge own report', () => challengeBatch(alice, 'R'));
  await denied('challenge without paying', () => challengeBatch(frank, 'R', { player: null }));
  await denied('challenge paying too little', async () => { const p = await player(frank); return challengeBatch(frank, 'R', { player: { balance: p.balance - 5 } }); });
  await denied('challenge as someone else', () => challengeBatch(frank, 'R', { market: { challengedBy: bob.uid } }));
  await denied('challenge that rewrites the report', () => challengeBatch(frank, 'R', { market: { reportedOptionId: 'o2' } }));
  await denied('early finalize (report window open)', () => finalizeWrite(gina, 'R', { status: 'resolved', resolvedOptionId: 'o1', eventAt: null }));
  await allowed('valid challenge', () => challengeBatch(frank, 'R'));
  const ch = await market('R');
  await denied('challenge twice', () => challengeBatch(gina, 'R'));

  // ---- votes
  await denied('bettor votes (has a stake doc)', () => voteBatch(bob, 'R', true));
  await denied('other bettor votes', () => voteBatch(carol, 'R', false));
  await denied('reporter votes', () => voteBatch(alice, 'R', true));
  await denied('challenger votes', () => voteBatch(frank, 'R', false));
  await denied('vote without touching the counter', () => voteBatch(gina, 'R', true, { market: null }));
  await denied('counter bump without a vote doc', () => voteBatch(gina, 'R', true, { vote: null }));
  await denied('vote counted twice', () => voteBatch(gina, 'R', true, { market: { votesUphold: 2 } }));
  await denied('vote counted on the other side', () => voteBatch(gina, 'R', true, { market: { votesUphold: 0, votesOverturn: 1 } }));
  await denied('vote as someone else', () => voteBatch(gina, 'R', true, { vote: { uid: dave.uid }, voteId: `R_${dave.uid}` }));
  await denied('vote with a wrong id', () => voteBatch(gina, 'R', true, { voteId: 'R_wrong' }));
  await denied('vote with a stake-like id of a bettor', () => voteBatch(gina, 'R', true, { voteId: `R_${bob.uid}`, vote: { uid: gina.uid } }));
  await denied('vote that also flips the status', () => voteBatch(gina, 'R', true, { market: { status: 'resolved' } }));
  await denied('vote on a market that is not disputed', () => voteBatch(gina, 'ctl', true));
  await allowed('valid vote', () => voteBatch(gina, 'R', true));
  await allowed('valid second vote (another voter)', () => voteBatch(mallory, 'R', true));
  await denied('replay an OLD vote against the counters (market doc only)', async () => {
    const cur = await market('R');
    assert.notEqual(cur.lastVoteId, `R_${gina.uid}`);
    return F.updateDoc(D(gina.db, 'markets2/R'), { votesUphold: cur.votesUphold + 1, lastVoteId: `R_${gina.uid}` });
  });
  await denied('vote twice', () => voteBatch(gina, 'R', true, { market: { votesUphold: 3 } }));
  await denied('vote twice (fresh counter)', async () => {
    const cur = await market('R');
    const b = F.writeBatch(gina.db);
    b.set(D(gina.db, `votes/R_${gina.uid}`), { marketId: 'R', uid: gina.uid, uphold: false, at: Date.now() });
    b.update(D(gina.db, 'markets2/R'), { votesOverturn: cur.votesOverturn + 1, lastVoteId: `R_${gina.uid}` });
    await b.commit();
  });
  await denied('rewrite an existing vote', () => F.updateDoc(D(gina.db, `votes/R_${gina.uid}`), { uphold: false }));
  await denied('delete a vote', () => F.deleteDoc(D(gina.db, `votes/R_${gina.uid}`)));
  await denied('finalize during the vote window', () => finalizeWrite(gina, 'R', { status: 'resolved', resolvedOptionId: 'o1', eventAt: null }));
  await denied('early void during the vote window', () => finalizeWrite(gina, 'R', { status: 'void', resolvedOptionId: null, eventAt: null }));

  // ---- window over
  await waitUntil(ch.challengedAt + TEST_VOTE_WINDOW_MS);
  await denied('vote after the window', () => voteBatch(dave, 'R', false));
  await denied('finalize to the wrong option (uphold => reported option)', () => finalizeWrite(dave, 'R', { status: 'resolved', resolvedOptionId: 'o2', eventAt: null }));
  await denied('finalize as void although upheld', () => finalizeWrite(dave, 'R', { status: 'void', resolvedOptionId: null, eventAt: null }));
  await denied('finalize with an event time', () => finalizeWrite(dave, 'R', { status: 'resolved', resolvedOptionId: 'o1', eventAt: 12345 }));
  await denied('finalize and reopen betting', () => finalizeWrite(dave, 'R', { status: 'resolved', resolvedOptionId: 'o1', eventAt: null, closesAt: Date.now() + 1e7 }));
  await denied('finalize with a forged timestamp', () => F.updateDoc(D(dave.db, 'markets2/R'), { status: 'resolved', resolvedOptionId: 'o1', resolvedAt: 5 }));
  await denied('finalize wiping the votes', () => finalizeWrite(dave, 'R', { status: 'resolved', resolvedOptionId: 'o1', eventAt: null, votesOverturn: 9 }));
  await allowed('valid finalize', () => finalizeWrite(dave, 'R', { status: 'resolved', resolvedOptionId: 'o1', eventAt: null }));
  await denied('finalize again to something else', () => finalizeWrite(dave, 'R', { status: 'void', resolvedOptionId: null, eventAt: null }));
  await denied('challenge after the market is final', () => challengeBatch(dave, 'R'));
  void rep; void cb;

  // ---- claims on R: bob (o1, winner) and carol (o2, loser)
  const winnerBet = bb.id; const loserBet = cb.id;
  await denied('claim with inflated payout', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { bet: { payout: 201 }, player: { balance: p.balance + 201 } }); });
  await denied('claim credited more than the bet payout', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { player: { balance: p.balance + 1000 } }); });
  await denied('claim without crediting', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { player: { balance: p.balance } }); });
  await denied('claim without the bet flip', () => claimBatch(bob, winnerBet, { bet: null }));
  await denied('bet flip without the player update', () => claimBatch(bob, winnerBet, { player: null }));
  await denied('claim leaving openStake locked-in', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { player: { openStake: p.openStake } }); });
  await denied('claim over-decrementing openStake (negative stake)', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { player: { openStake: p.openStake - 101 } }); });
  await denied('claim zeroing all open stake', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { player: { openStake: 0 } }); });
  await denied('claim with inflated totalWon', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { player: { totalWon: p.totalWon + 999 } }); });
  await denied('claim someone else bet', () => claimBatch(mallory, winnerBet));
  await denied('claim losing bet as won', async () => {
    const p = await player(carol);
    return claimBatch(carol, loserBet, { bet: { status: 'won', payout: 200, taxed: 0 }, player: { balance: p.balance + 200, totalWon: p.totalWon + 200 } });
  });
  await denied('claim losing bet with a payout but status lost', async () => {
    const p = await player(carol);
    return claimBatch(carol, loserBet, { bet: { status: 'lost', payout: 100 }, player: { balance: p.balance + 100 } });
  });
  await denied('claim losing bet as void (refund)', async () => {
    const p = await player(carol);
    return claimBatch(carol, loserBet, { bet: { status: 'void', payout: 100 }, player: { balance: p.balance + 100 } });
  });
  await denied('claim winning bet as void with tax dodge', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { bet: { status: 'void', payout: 100 }, player: { balance: p.balance + 100 } }); });
  // penalty tax: a player under penalty cannot skip the 25% on the profit
  await adminPatch('players', bob.uid, { penaltyUntil: Date.now() + DAY_MS });
  await denied('tax evasion (penalty active)', async () => {
    const p = await player(bob);
    return claimBatch(bob, winnerBet, { bet: { taxed: 0, payout: 200 }, player: { balance: p.balance + 200, totalWon: p.totalWon + 200 } });
  });
  await denied('wrong tax amount', async () => {
    const p = await player(bob);
    return claimBatch(bob, winnerBet, { bet: { taxed: 10, payout: 190 }, player: { balance: p.balance + 190, totalWon: p.totalWon + 190 } });
  });
  await allowed('valid winning claim (taxed 25% of the profit while the penalty is active)', () => claimBatch(bob, winnerBet));
  const taxed = await adminGet('bets2', winnerBet);
  assert.deepEqual([taxed.status, taxed.taxed, taxed.payout], ['won', 25, 175]);
  await adminPatch('players', bob.uid, { penaltyUntil: null });
  await allowed('valid losing claim', () => claimBatch(carol, loserBet));
  oldClaim = winnerBet;
  await denied('claim the same bet twice', async () => { const p = await player(bob); return claimBatch(bob, winnerBet, { bet: { status: 'won', payout: 200 }, player: { balance: p.balance + 200, openStake: p.openStake - 100, totalWon: p.totalWon + 200 } }); });
  await denied('replay the exact claim', async () => {
    const bt = await adminGet('bets2', winnerBet); const p = await player(bob);
    const b = F.writeBatch(bob.db);
    b.update(D(bob.db, `bets2/${winnerBet}`), { status: 'won', payout: bt.payout, taxed: 0, claimedAt: Date.now() });
    b.update(D(bob.db, `players/${bob.uid}`), { balance: p.balance + bt.payout, openStake: p.openStake - 100, totalWon: p.totalWon + bt.payout, lastClaimId: winnerBet });
    await b.commit();
  });
  await denied('player-only replay of a claim (exact numbers of the settled bet)', async () => {
    const p = await player(bob); const bt = await adminGet('bets2', winnerBet);
    return F.updateDoc(D(bob.db, `players/${bob.uid}`), { balance: p.balance + bt.payout, openStake: p.openStake - bt.amount, totalWon: p.totalWon + bt.payout, lastClaimId: winnerBet });
  });
  await denied('bet-only replay of a claim (no player update)', async () => {
    const bt = await adminGet('bets2', winnerBet);
    return F.updateDoc(D(bob.db, `bets2/${winnerBet}`), { status: 'won', payout: bt.payout, taxed: bt.taxed, claimedAt: Date.now() });
  });
  await denied('edit a settled bet', () => F.updateDoc(D(bob.db, `bets2/${winnerBet}`), { payout: 9999 }));
  await denied('reopen a settled bet', () => F.updateDoc(D(bob.db, `bets2/${winnerBet}`), { status: 'open' }));

  // ---- bonds on R (challenged, upheld 1-0): reporter 40, challenger 0
  await denied('claim the bond before... (wrong role: challenger claims reporter flag)', () => bondClaimBatch(frank, 'R', 'reporterBondPaid', 40));
  await denied('reporter claims too much', () => bondClaimBatch(alice, 'R', 'reporterBondPaid', 41));
  await denied('reporter claims too little (and keeps the flag)', () => bondClaimBatch(alice, 'R', 'reporterBondPaid', 20));
  await denied('reporter claims without the flag', () => bondClaimBatch(alice, 'R', 'reporterBondPaid', 40, { market: null }));
  await denied('flag without payout still pays nothing but reporter is owed', () => bondClaimBatch(alice, 'R', 'reporterBondPaid', 40, { player: null }));
  await denied('challenger claims 40 although overruled', () => bondClaimBatch(frank, 'R', 'challengerBondPaid', 40));
  await denied('outsider claims a bond', () => bondClaimBatch(mallory, 'R', 'reporterBondPaid', 40));
  await denied('both flags at once', async () => { const p = await player(alice); const b = F.writeBatch(alice.db); b.update(D(alice.db, 'markets2/R'), { reporterBondPaid: true, challengerBondPaid: true }); b.update(D(alice.db, `players/${alice.uid}`), { balance: p.balance + 40, lastBondMarketId: 'R' }); await b.commit(); });
  await allowed('valid reporter bond claim', () => bondClaimBatch(alice, 'R', 'reporterBondPaid', 40));
  await denied('bond claimed twice', () => bondClaimBatch(alice, 'R', 'reporterBondPaid', 40, { market: { reporterBondPaid: true } }));
  await denied('bond balance replay', async () => { const p = await player(alice); return F.updateDoc(D(alice.db, `players/${alice.uid}`), { balance: p.balance + 40, lastBondMarketId: 'R' }); });
  await allowed('loser bond claim (0, flag only)', () => bondClaimBatch(frank, 'R', 'challengerBondPaid', 0, { player: null }));
  await denied('loser bond claim again', () => bondClaimBatch(frank, 'R', 'challengerBondPaid', 0, { player: null }));
  const ma = await player(alice);
  assert.equal(ma.balance, 500, 'alice paid two bonds (closing, R) and got 40 back');
});

it('unchallenged report: early / late finalize, wrong result, timer expiry, creator void, challenge after the window', async () => {
  const w = await world();
  const { alice, bob, carol, dave, mallory, frank } = w;
  await sleep(economy.BET_COOLDOWN_MS + 100);
  const { m, placed } = await chain(alice, 'U', [[bob, 'o1', 60], [carol, 'o2', 40]], { report: 'o2' });
  void m;
  await denied('early finalize (unchallenged)', () => finalizeWrite(dave, 'U', { status: 'resolved', resolvedOptionId: 'o2', eventAt: null }));
  await denied('early void', () => finalizeWrite(dave, 'U', { status: 'void', resolvedOptionId: null, eventAt: null }));
  await denied('creator voids a market that has bets', () => finalizeWrite(alice, 'U', { status: 'void', resolvedOptionId: null, eventAt: null }));
  const rep = await market('U');
  await waitUntil(rep.reportedAt + TEST_CHALLENGE_WINDOW_MS);
  await denied('challenge after the window', () => challengeBatch(frank, 'U'));
  await denied('finalize to the option nobody reported', () => finalizeWrite(dave, 'U', { status: 'resolved', resolvedOptionId: 'o1', eventAt: null }));
  await denied('finalize a non-existing option', () => finalizeWrite(dave, 'U', { status: 'resolved', resolvedOptionId: 'oZ', eventAt: null }));
  await denied('finalize void although unchallenged', () => finalizeWrite(dave, 'U', { status: 'void', resolvedOptionId: null, eventAt: null }));
  await allowed('valid finalize after 12h (test: 4s)', () => finalizeWrite(dave, 'U', { status: 'resolved', resolvedOptionId: 'o2', eventAt: null }));
  // payout for the winner is floor(40*100/40)=100; nobody can take more or claim the loser's bet
  const winner = placed[1]; const loser = placed[0];
  await denied('loser claims as winner', async () => { const p = await player(bob); return claimBatch(bob, loser.id, { bet: { status: 'won', payout: 100 }, player: { balance: p.balance + 100, totalWon: p.totalWon + 100 } }); });
  await denied('winner claims more than the pool share', async () => { const p = await player(carol); return claimBatch(carol, winner.id, { bet: { payout: 101 }, player: { balance: p.balance + 101, totalWon: p.totalWon + 101 } }); });
  await allowed('winner valid claim', () => claimBatch(carol, winner.id));
  await allowed('loser valid claim', () => claimBatch(bob, loser.id));
  // replay an OLD, already-paid claim (bob's pointer moved on, so lastClaimId changes again): must not pay twice
  await denied('replay of an old paid claim (player doc only)', async () => {
    const p = await player(bob); const bt = await adminGet('bets2', oldClaim);
    assert.ok(bt.payout > 0 && bt.status === 'won');
    return F.updateDoc(D(bob.db, `players/${bob.uid}`), { balance: p.balance + bt.payout, openStake: p.openStake - bt.amount, totalWon: p.totalWon + bt.payout, lastClaimId: oldClaim });
  });
  await denied('replay of an old paid claim with a bet touch', async () => {
    const p = await player(bob); const bt = await adminGet('bets2', oldClaim);
    const b = F.writeBatch(bob.db);
    b.update(D(bob.db, `bets2/${oldClaim}`), { claimedAt: Date.now() });
    b.update(D(bob.db, `players/${bob.uid}`), { balance: p.balance + bt.payout, openStake: p.openStake - bt.amount, totalWon: p.totalWon + bt.payout, lastClaimId: oldClaim });
    await b.commit();
  });
  // reporter bond: unchallenged => 20 back
  await denied('unchallenged reporter claims the double bond', () => bondClaimBatch(alice, 'U', 'reporterBondPaid', 40));
  await denied('someone else claims the reporter bond', () => bondClaimBatch(mallory, 'U', 'reporterBondPaid', 20));
  await allowed('valid bond claim', () => bondClaimBatch(alice, 'U', 'reporterBondPaid', 20));

  // creator can void an empty market only while it is open
  await sleep(economy.BET_COOLDOWN_MS + 100);
  await alice.s.createMarket(choice(alice, 'V'));
  await denied('non-creator voids', () => finalizeWrite(mallory, 'V', { status: 'void', resolvedOptionId: null, eventAt: null }));
  await denied('creator resolves an open market directly', () => finalizeWrite(alice, 'V', { status: 'resolved', resolvedOptionId: 'o1', eventAt: null }));
  await allowed('creator voids an empty market', () => finalizeWrite(alice, 'V', { status: 'void', resolvedOptionId: null, eventAt: null }));
});

it('timers: reports carry only an eventAt in [openedAt, now]; expiry and per-bet windows are rule-enforced', async () => {
  const w = await world();
  const { alice, bob, carol, mallory } = w;
  await sleep(economy.BET_COOLDOWN_MS + 100);
  const t = houseMarket('tim1', { kind: 'timer', closeInMs: 2000 });
  t.expiresAt = t.closesAt + 3000;
  await allowed('create timer (admin)', () => F.setDoc(D(w.adminRaw.db, `markets2/${t.id}`), t));
  const tb = await bob.s.placeBet(t.id, 'quick', 100);
  await waitUntil(t.openedAt + 300);
  const now = Date.now();
  await denied('timer report in the future', () => reportBatch(carol, t.id, null, now + 60000));
  await denied('timer report before the market opened', () => reportBatch(carol, t.id, null, t.openedAt - 1));
  await denied('timer report with an option id', () => reportBatch(carol, t.id, 'quick', now - 100));
  await denied('timer report without an eventAt', () => reportBatch(carol, t.id, null, null));
  await denied('timer report with a float-string eventAt', () => reportBatch(carol, t.id, null, 'yesterday'));
  await denied('early timer expiry', () => finalizeWrite(mallory, t.id, { status: 'resolved', resolvedOptionId: 'never', eventAt: null }));
  await allowed('valid timer report (anyone, house market)', () => reportBatch(carol, t.id, null, now - 50));
  const rep = await market(t.id);
  await waitUntil(rep.reportedAt + TEST_CHALLENGE_WINDOW_MS);
  await denied('timer finalize with a different eventAt', () => finalizeWrite(mallory, t.id, { status: 'resolved', resolvedOptionId: null, eventAt: now - 5000 }));
  await denied('timer finalize to an option', () => finalizeWrite(mallory, t.id, { status: 'resolved', resolvedOptionId: 'never', eventAt: now - 50 }));
  await allowed('valid timer finalize', () => finalizeWrite(mallory, t.id, { status: 'resolved', resolvedOptionId: null, eventAt: now - 50 }));
  // event before the bet => bob's bet was placed before the event here (event = now-50 > placedAt? placedAt<event) => window check
  const bt = await adminGet('bets2', tb.id);
  const off = (now - 50) - bt.placedAt;
  const res = economy.betClaim(bt, await market(t.id), await player(bob), Date.now());
  assert.equal(res.status, off >= 0 && off < 3000 ? 'won' : off < 0 ? 'void' : 'lost');
  await denied('claim timer bet with the wrong verdict', async () => {
    const p = await player(bob);
    const wrong = res.status === 'won' ? { status: 'lost', payout: 0 } : { status: 'won', payout: 300 };
    return claimBatch(bob, tb.id, { bet: wrong, player: { balance: p.balance + wrong.payout, totalWon: p.totalWon + (wrong.status === 'won' ? 300 : 0) } });
  });
  await allowed('claim timer bet', () => claimBatch(bob, tb.id));
});

it('bankruptcy: bailout needs balance<1, no open stake, the next UTC day; penalty is fixed', async () => {
  const w = await world();
  const { dave } = w;
  const meDoc = () => D(dave.db, `players/${dave.uid}`);
  await denied('markBroke while rich', () => F.updateDoc(meDoc(), { brokeSince: Date.now() }));
  await denied('bailout while rich', () => F.updateDoc(meDoc(), { balance: 100, bankruptcies: 1, brokeSince: null, penaltyUntil: Date.now() + 3 * DAY_MS }));
  await adminPatch('players', dave.uid, { balance: 0, openStake: 0 }); // fast-forward: dave has nothing left
  await denied('bailout before markBroke', () => F.updateDoc(meDoc(), { balance: 100, bankruptcies: 1, brokeSince: null, penaltyUntil: Date.now() + 3 * DAY_MS }));
  await denied('markBroke with a backdated timestamp', () => F.updateDoc(meDoc(), { brokeSince: Date.now() - DAY_MS }));
  await denied('markBroke that also pays', () => F.updateDoc(meDoc(), { brokeSince: Date.now(), balance: 50 }));
  // align with a bailout "day" boundary (4s in the test rules) so the same-day check is deterministic
  await sleep(TEST_BAILOUT_DAY_MS - (Date.now() % TEST_BAILOUT_DAY_MS) + 30);
  await allowed('markBroke', () => F.updateDoc(meDoc(), { brokeSince: Date.now() }));
  const later = Date.now();
  const restart = (over = {}) => F.updateDoc(meDoc(), { balance: 100, bankruptcies: 1, brokeSince: null, penaltyUntil: Date.now() + 3 * DAY_MS, ...over });
  await denied('bailout the same day', () => restart());
  await denied('markBroke twice', () => F.updateDoc(meDoc(), { brokeSince: Date.now() }));
  // once the day rolled over the only remaining defects are in the numbers
  await sleep(TEST_BAILOUT_DAY_MS - (Date.now() % TEST_BAILOUT_DAY_MS) + 100);
  assert.ok(Date.now() > later);
  await denied('bailout of 1000', () => restart({ balance: 1000 }));
  await denied('bailout without the penalty', () => restart({ penaltyUntil: null }));
  await denied('bailout with a 1s penalty', () => restart({ penaltyUntil: Date.now() + 1000 }));
  await denied('bailout not counting the bankruptcy', () => restart({ bankruptcies: 0 }));
  await denied('bailout keeping brokeSince', () => restart({ brokeSince: later }));
  await denied('bailout with an open stake', async () => {
    await adminPatch('players', dave.uid, { openStake: 10 });
    try { await restart(); } finally { await adminPatch('players', dave.uid, { openStake: 0 }); }
  });
  await allowed('valid bailout on the next day', () => restart());
  const pd = await player(dave);
  assert.equal(pd.balance, 100); assert.equal(pd.bankruptcies, 1);
  await denied('second bailout', () => restart({ bankruptcies: 2 }));
});

it('maintenance: non-admins are locked out of every read and write; the admin is not', async () => {
  const w = await world();
  const { admin, carol, bob, adminRaw } = w;
  await carol.s.createMarket(choice(carol, 'mm')); // empty, so its creator could void it
  // a fresh Auth account that could otherwise sign up
  const app = sdk.app.initializeApp(fbConfig, `mt${++n}`);
  const auth = sdk.auth.getAuth(app); sdk.auth.connectAuthEmulator(auth, emulator.authUrl, { disableWarnings: true });
  const cred = await sdk.auth.createUserWithEmailAndPassword(auth, 'latecomer@users.sonnetous.app', 'secret1');
  const ldb = F.getFirestore(app); F.connectFirestoreEmulator(ldb, emulator.firestoreHost, emulator.firestorePort); rawApps.push({ app, db: ldb });
  const signupLate = () => {
    const b = F.writeBatch(ldb);
    b.set(D(ldb, 'handles/latecomer'), { uid: cred.user.uid });
    b.set(D(ldb, `players/${cred.user.uid}`), { uid: cred.user.uid, username: 'latecomer', balance: 500, openStake: 0, createdAt: Date.now(), bankruptcies: 0, brokeSince: null, penaltyUntil: null, totalWagered: 0, totalWon: 0, lastBetAt: 0, marketsDay: 0, marketsCount: 0, lastClaimId: null, lastBondMarketId: null });
    return b.commit();
  };
  const newMarket = async () => {
    const today = economy.utcDayNumber(Date.now());
    const cur = await adminGet('players', bob.uid);
    const b = F.writeBatch(bob.db);
    b.set(D(bob.db, 'markets2/maint'), choice(bob, 'maint'));
    b.update(D(bob.db, `players/${bob.uid}`), { marketsDay: today, marketsCount: cur.marketsDay === today ? cur.marketsCount + 1 : 1 });
    return b.commit();
  };
  const voidIt = () => F.updateDoc(D(carol.db, 'markets2/mm'), { status: 'void', resolvedAt: Date.now(), resolvedOptionId: null, eventAt: null });
  await sleep(economy.BET_COOLDOWN_MS + 100);
  const anyBet = () => betBatch(bob, 'ctl', 'o1', 5).then((b) => b.commit());

  await admin.setMaintenance(true);
  await denied('bet during maintenance', anyBet);
  await denied('create market during maintenance', newMarket);
  await denied('creator voids during maintenance', voidIt);
  await denied('sign up during maintenance', signupLate);
  await readDenied('read players during maintenance', () => F.getDocs(F.collection(bob.db, 'players')));
  await readDenied('read a player during maintenance', () => F.getDoc(D(bob.db, `players/${bob.uid}`)));
  await readDenied('read markets during maintenance', () => F.getDocs(F.collection(bob.db, 'markets2')));
  await readDenied('read bets during maintenance', () => F.getDocs(F.collection(bob.db, 'bets2')));
  await readDenied('read stakes during maintenance', () => F.getDocs(F.collection(bob.db, 'stakes')));
  await readDenied('read votes during maintenance', () => F.getDocs(F.collection(bob.db, 'votes')));
  await readDenied('read handles during maintenance', () => F.getDocs(F.collection(bob.db, 'handles')));
  await F.getDoc(D(bob.db, 'app/config')); // the config stays public
  // nobody but the admin flips the switch, and only these two fields
  await denied('non-admin turns maintenance off', () => F.updateDoc(D(bob.db, 'app/config'), { maintenance: false, updatedAt: Date.now() }));
  await denied('non-admin makes himself admin', () => F.updateDoc(D(bob.db, 'app/config'), { adminUid: bob.uid }));
  await denied('admin re-assigns adminUid', () => F.updateDoc(D(adminRaw.db, 'app/config'), { adminUid: bob.uid }));
  await denied('admin adds a field to config', () => F.updateDoc(D(adminRaw.db, 'app/config'), { claimCode: 'x' }));
  await denied('admin sets maintenance to a string', () => F.updateDoc(D(adminRaw.db, 'app/config'), { maintenance: 'false', updatedAt: Date.now() }));
  await denied('delete the config', () => F.deleteDoc(D(adminRaw.db, 'app/config')));
  // the admin is not locked out of the game itself while it is closed
  await allowed('admin reads players during maintenance', () => F.getDocs(F.collection(adminRaw.db, 'players')));
  await allowed('admin plays during maintenance', async () => (await betBatch({ uid: adminRaw.uid, name: 'Admin', db: adminRaw.db }, 'ctl', 'o1', 5)).commit());
  await allowed('admin reopens', () => F.updateDoc(D(adminRaw.db, 'app/config'), { maintenance: false, updatedAt: Date.now() }));
  // the very same writes are fine once the game is open again (so the denials above were about maintenance)
  await allowed('bet works again', anyBet);
  await allowed('create market works again', newMarket);
  await allowed('creator void works again', voidIt);
  await allowed('sign-up works again', signupLate);
});

it('bans: a banned user can neither read nor write; only the admin bans and unbans', async () => {
  const w = await world();
  const { admin, adminRaw, alice, mallory, bob } = w;
  const ban = (by, uid, over = {}) => F.setDoc(D(by.db, `bans/${uid}`), { uid, username: 'x', by: by.uid, at: Date.now(), reason: 'r', ...over });
  await denied('non-admin bans', () => ban(mallory, bob.uid));
  await denied('non-admin bans himself', () => ban(mallory, mallory.uid));
  await denied('admin bans the admin', () => ban({ db: adminRaw.db, uid: adminRaw.uid }, adminRaw.uid));
  await denied('admin ban with a forged issuer', () => ban({ db: adminRaw.db, uid: adminRaw.uid }, bob.uid, { by: bob.uid }));
  await denied('admin ban with mismatched uid', () => ban({ db: adminRaw.db, uid: adminRaw.uid }, bob.uid, { uid: alice.uid }));
  await sleep(economy.BET_COOLDOWN_MS + 100);
  const tryBet = () => betBatch(mallory, 'ctl', 'o1', 5).then((b) => b.commit());
  await allowed('ban as admin', () => ban({ db: adminRaw.db, uid: adminRaw.uid }, mallory.uid));
  await denied('banned user bets', tryBet);
  await denied('banned user edits own player', () => F.updateDoc(D(mallory.db, `players/${mallory.uid}`), { brokeSince: Date.now() }));
  await readDenied('banned user reads players', () => F.getDocs(F.collection(mallory.db, 'players')));
  await readDenied('banned user reads markets', () => F.getDocs(F.collection(mallory.db, 'markets2')));
  await readDenied('banned user reads bets', () => F.getDocs(F.collection(mallory.db, 'bets2')));
  await readDenied('banned user reads own player', () => F.getDoc(D(mallory.db, `players/${mallory.uid}`)));
  const mine = await F.getDoc(D(mallory.db, `bans/${mallory.uid}`));
  assert.ok(mine.exists(), 'banned user can read their own ban');
  await readDenied('banned user reads someone elses ban', () => F.getDoc(D(mallory.db, `bans/${bob.uid}`)));
  await readDenied('non-admin lists bans', () => F.getDocs(F.collection(bob.db, 'bans')));
  await denied('banned user deletes own ban', () => F.deleteDoc(D(mallory.db, `bans/${mallory.uid}`)));
  await denied('other user deletes a ban', () => F.deleteDoc(D(bob.db, `bans/${mallory.uid}`)));
  await denied('ban document rewritten', () => F.updateDoc(D(adminRaw.db, `bans/${mallory.uid}`), { reason: 'changed' }));
  await denied('ban document rewritten by the banned user', () => F.updateDoc(D(mallory.db, `bans/${mallory.uid}`), { reason: 'oops' }));
  await allowed('admin lists bans', () => F.getDocs(F.collection(adminRaw.db, 'bans')));
  await allowed('admin unbans', () => F.deleteDoc(D(adminRaw.db, `bans/${mallory.uid}`)));
  await allowed('unbanned user bets again', tryBet);
  void admin;
});

it('admin claim: wrong code, an existing config, wrong shape, and unauthenticated access', async () => {
  // a separate, empty world: nothing claimed yet
  await resetEmulator();
  W = null;
  const anon = await rawDb(null);
  const app = sdk.app.initializeApp(fbConfig, `adm${++n}`);
  const auth = sdk.auth.getAuth(app); sdk.auth.connectAuthEmulator(auth, emulator.authUrl, { disableWarnings: true });
  const cred = await sdk.auth.createUserWithEmailAndPassword(auth, 'wannabe@users.sonnetous.app', 'secret1');
  const db = F.getFirestore(app); F.connectFirestoreEmulator(db, emulator.firestoreHost, emulator.firestorePort); rawApps.push({ app, db });
  const uid = cred.user.uid;
  const claim = (code, cfg = {}, who = { db, uid }) => {
    const b = F.writeBatch(who.db);
    b.set(D(who.db, 'app/claim'), { code });
    b.set(D(who.db, 'app/config'), { adminUid: who.uid, maintenance: true, updatedAt: Date.now(), ...cfg });
    return b.commit();
  };
  // closed game: nothing is readable except the config
  await readDenied('anonymous reads players', () => F.getDocs(F.collection(anon.db, 'players')));
  await readDenied('signed-in reads players in a closed game', () => F.getDocs(F.collection(db, 'players')));
  await readDenied('read the claim doc', () => F.getDoc(D(db, 'app/claim')));
  await F.getDoc(D(anon.db, 'app/config'));
  await denied('anonymous claims admin', () => claim(TEST_ADMIN_CODE, {}, { db: anon.db, uid: null }));
  await denied('wrong code', () => claim('wrong-code'));
  await denied('empty code', () => claim(''));
  await denied('the old hash as a code', () => claim(sha256hex(TEST_ADMIN_CODE)));
  await denied('right code but maintenance=false', () => claim(TEST_ADMIN_CODE, { maintenance: false }));
  await denied('right code but adminUid = someone else', () => claim(TEST_ADMIN_CODE, { adminUid: 'someone-else' }));
  await denied('right code but a stowaway field in config', () => claim(TEST_ADMIN_CODE, { claimCode: TEST_ADMIN_CODE }));
  await denied('config without the claim doc', () => F.setDoc(D(db, 'app/config'), { adminUid: uid, maintenance: true, updatedAt: Date.now() }));
  await allowed('anyone may park junk in the write-only claim doc while unclaimed', () => F.setDoc(D(db, 'app/claim'), { code: 'junk' }));
  await denied('config after a junk claim', () => F.setDoc(D(db, 'app/config'), { adminUid: uid, maintenance: true, updatedAt: Date.now() }));
  await allowed('right code claims the admin seat', () => claim(TEST_ADMIN_CODE));
  const cfg = await adminGet('app', 'config');
  assert.equal(cfg.adminUid, uid);
  // ...and never again
  const other = sdk.app.initializeApp(fbConfig, `adm${++n}`);
  const oa = sdk.auth.getAuth(other); sdk.auth.connectAuthEmulator(oa, emulator.authUrl, { disableWarnings: true });
  const oc = await sdk.auth.createUserWithEmailAndPassword(oa, 'usurper@users.sonnetous.app', 'secret1');
  const odb = F.getFirestore(other); F.connectFirestoreEmulator(odb, emulator.firestoreHost, emulator.firestorePort); rawApps.push({ app: other, db: odb });
  await denied('second claim with the right code', () => claim(TEST_ADMIN_CODE, {}, { db: odb, uid: oc.user.uid }));
  await denied('overwrite config with the right code', () => F.setDoc(D(odb, 'app/config'), { adminUid: oc.user.uid, maintenance: false, updatedAt: Date.now() }));
  await denied('re-write the claim doc', () => F.setDoc(D(odb, 'app/claim'), { code: 'x' }));
  await denied('usurper deletes the claim doc', () => F.deleteDoc(D(odb, 'app/claim')));
  await allowed('admin wipes the claim doc', () => F.deleteDoc(D(db, 'app/claim')));
  await readDenied('read the claim doc as admin', () => F.getDoc(D(db, 'app/claim')));
});

it('nothing can be deleted, old v1 collections are closed, unauthenticated users see nothing', async () => {
  await resetEmulator();
  W = null;
  const w = await world();
  const { alice, bob, admin, adminRaw } = w;
  await alice.s.createMarket(choice(alice, 'del'));
  const b1 = await bob.s.placeBet('del', 'o1', 10);
  const del = (who, path) => F.deleteDoc(D(who.db, path));
  for (const [who, path] of [
    [alice, `players/${alice.uid}`], [bob, `players/${bob.uid}`], [adminRaw, `players/${bob.uid}`], [alice, 'markets2/del'], [adminRaw, 'markets2/del'],
    [bob, `bets2/${b1.id}`], [adminRaw, `bets2/${b1.id}`], [bob, `stakes/del_${bob.uid}`], [adminRaw, `stakes/del_${bob.uid}`],
    [alice, 'handles/alice'], [adminRaw, 'handles/alice'], [alice, 'app/config'], [adminRaw, 'app/config'], [bob, 'votes/del_x'],
  ]) await denied(`delete ${path}`, () => del(who, path));
  await denied('stake shrink', () => F.updateDoc(D(bob.db, `stakes/del_${bob.uid}`), { amount: 1 }));
  await denied('stake of someone else', () => F.updateDoc(D(alice.db, `stakes/del_${bob.uid}`), { amount: 5000 }));
  // v1 collections and anything unknown are closed
  for (const c of ['users', 'usernames', 'markets', 'bets', 'misc']) {
    await readDenied(`read v1 ${c}`, () => F.getDocs(F.collection(bob.db, c)));
    await denied(`write v1 ${c}`, () => F.setDoc(D(bob.db, `${c}/x`), { balance: 1e9 }));
  }
  // unauthenticated
  const anon = await rawDb(null);
  for (const c of ['players', 'markets2', 'bets2', 'stakes', 'votes', 'handles', 'bans']) await readDenied(`anon reads ${c}`, () => F.getDocs(F.collection(anon.db, c)));
  await readDenied('anon reads a player', () => F.getDoc(D(anon.db, `players/${bob.uid}`)));
  await denied('anon writes a player', () => F.updateDoc(D(anon.db, `players/${bob.uid}`), { balance: 1e9 }));
  await denied('anon creates a market', () => F.setDoc(D(anon.db, 'markets2/anon'), choice(bob, 'anon')));
  await allowed('anon reads the config', () => F.getDoc(D(anon.db, 'app/config')));
  await denied('anon writes the config', () => F.updateDoc(D(anon.db, 'app/config'), { maintenance: true }));
  // REST without a token
  const r = await fetch(`${REST}/players`);
  assert.equal(r.status, 403, 'REST list without a token');
  const r2 = await fetch(`${REST}/players/${bob.uid}?updateMask.fieldPaths=balance`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { balance: { integerValue: '99999' } } }) });
  assert.equal(r2.status, 403, 'REST write without a token');
  assert.equal((await player(bob)).balance, 490);
  void admin;
});

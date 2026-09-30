// localStorage backend for Sonnetous v2 (dev / offline / test backend). Implements the Store API v2 from
// SPEC-v2.md and enforces the same checks firestore.rules does, in JS. Runs in browsers and in Node
// (given options.storage or a globalThis.localStorage shim).
import * as economy from '../economy.js';
import { ADMIN_CODE_SHA256 } from '../admin-hash.js';

const DB_KEY = 'sonnetous:v2';
const SESSION_KEY = 'sonnetous:v2:session';

export const MAINTENANCE_MESSAGE = 'Sonnetous is down for maintenance';
export const BANNED_MESSAGE = "You've been banned";

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

function defaultStorage() {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch { /* access can throw (blocked site data) */ }
  return memoryStorage();
}

function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function randomHex(bytes = 16) {
  const c = globalThis.crypto;
  const arr = new Uint8Array(bytes);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(arr);
  else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback for insecure contexts without crypto.subtle (cyrb53). Passwords only — never matches the admin hash.
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'x' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * options: { now?: () => ms, storage?: {getItem,setItem,removeItem}, adminHash?: hex sha256 of the admin code }
 */
export function createLocalStore(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const storage = options.storage || defaultStorage();
  const adminHash = String(options.adminHash || ADMIN_CODE_SHA256).toLowerCase();

  // ---------- persistence ----------
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

  function load() {
    let db = null;
    try {
      const raw = storage.getItem(DB_KEY);
      if (raw) db = JSON.parse(raw);
    } catch { db = null; }
    db = obj(db);
    db.config = db.config && typeof db.config === 'object' ? db.config : null;
    for (const k of ['auth', 'handles', 'players', 'markets', 'bets', 'stakes', 'votes', 'bans']) db[k] = obj(db[k]);
    return db;
  }

  function save(db) {
    try {
      storage.setItem(DB_KEY, JSON.stringify(db));
    } catch (e) {
      throw new Error('Could not save to local storage: ' + (e && e.message ? e.message : e));
    }
    notifyAll();
  }

  function getSessionUid() {
    try { return storage.getItem(SESSION_KEY) || null; } catch { return null; }
  }
  function setSessionUid(uid) {
    try {
      if (uid) storage.setItem(SESSION_KEY, uid);
      else storage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
  }

  // ---------- access gate (mirrors firestore.rules) ----------
  const isAdmin = (db, uid) => !!(db.config && uid && db.config.adminUid === uid);
  const appOpen = (db, uid) => !!db.config && (db.config.maintenance === false || isAdmin(db, uid));
  const isBanned = (db, uid) => !!(uid && db.bans[uid]);
  const canRead = (db, uid) => !!uid && appOpen(db, uid) && !isBanned(db, uid);

  const authRecordFor = (db, uid) => Object.values(db.auth).find((a) => a.uid === uid) || null;

  /** Creates handle + player for an account that has none yet (sign-up / repair path). Caller checked the gate. */
  function ensurePlayer(db, uid) {
    if (db.players[uid]) return db.players[uid];
    const rec = authRecordFor(db, uid);
    if (!rec) throw new Error('You need to be logged in.');
    db.handles[rec.username.toLowerCase()] = { uid };
    db.players[uid] = economy.newPlayer(uid, rec.username, nowFn());
    return db.players[uid];
  }

  /** Session + ban + maintenance checks. Returns the uid. */
  function guard(db) {
    const uid = getSessionUid();
    if (!uid || !authRecordFor(db, uid)) throw new Error('You need to be logged in.');
    if (isBanned(db, uid)) throw new Error(BANNED_MESSAGE);
    if (!appOpen(db, uid)) throw new Error(MAINTENANCE_MESSAGE);
    return uid;
  }

  /** guard() + the caller's (possibly repaired) player doc, mutable inside `db`. */
  function actor(db) {
    const uid = guard(db);
    return { uid, player: ensurePlayer(db, uid) };
  }

  function requireAdmin(db) {
    const uid = getSessionUid();
    if (!uid || !authRecordFor(db, uid)) throw new Error('You need to be logged in.');
    if (!isAdmin(db, uid)) throw new Error('Only the admin can do that.');
    return uid;
  }

  // ---------- notifications ----------
  const sortedMarkets = (db) =>
    Object.values(db.markets).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  const sortedBets = (db) =>
    Object.values(db.bets).sort((a, b) => (b.placedAt || 0) - (a.placedAt || 0));

  const views = {
    auth(db) {
      const uid = getSessionUid();
      return canRead(db, uid) && db.players[uid] ? db.players[uid] : null;
    },
    session(db) {
      const uid = getSessionUid();
      const rec = uid && authRecordFor(db, uid);
      return rec ? { uid, username: rec.username } : null;
    },
    config(db) {
      const c = db.config;
      return { exists: !!c, maintenance: c ? c.maintenance !== false : true, adminUid: c ? c.adminUid || null : null };
    },
    myBan(db) {
      const uid = getSessionUid();
      return (uid && db.bans[uid]) || null;
    },
    players(db) {
      return canRead(db, getSessionUid()) ? Object.values(db.players) : [];
    },
    markets(db) {
      return canRead(db, getSessionUid()) ? sortedMarkets(db) : [];
    },
    bets(db) {
      return canRead(db, getSessionUid()) ? sortedBets(db) : [];
    },
    myVotes(db) {
      const uid = getSessionUid();
      if (!canRead(db, uid)) return [];
      return Object.values(db.votes).filter((v) => v.uid === uid).map((v) => v.marketId);
    },
    bans(db) {
      const uid = getSessionUid();
      return isAdmin(db, uid) ? Object.values(db.bans) : [];
    },
  };

  const listeners = new Set();

  function safeCall(fn, arg) {
    try { fn(arg); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
  }

  function notifyAll() {
    if (!listeners.size) return;
    const db = load();
    for (const entry of [...listeners]) {
      const data = views[entry.view](db);
      const json = JSON.stringify(data);
      if (json !== entry.last) {
        entry.last = json;
        safeCall(entry.cb, clone(data));
      }
    }
  }

  function subscribe(view, cb) {
    const entry = { view, cb, last: null };
    listeners.add(entry);
    const data = views[view](load());
    entry.last = JSON.stringify(data);
    safeCall(cb, clone(data));
    return () => { listeners.delete(entry); };
  }

  // Multi-tab sync (browser only).
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e) => {
      if (e.storageArea && e.storageArea !== storage) return;
      if (e.key === null || e.key === DB_KEY || e.key === SESSION_KEY) notifyAll();
    });
  }

  // ---------- helpers ----------
  const fail = (msg) => { throw new Error(msg); };

  /** Applies finalizeOutcome to a market inside `db`. Returns true if the market changed. */
  function applyFinalize(db, market, t) {
    const out = economy.finalizeOutcome(clone(market), t);
    if (!out) return false;
    Object.assign(market, { status: out.status, resolvedOptionId: out.resolvedOptionId, eventAt: out.eventAt, resolvedAt: t });
    return true;
  }

  function applyBetClaim(db, bet, player, t) {
    const market = db.markets[bet.marketId];
    const res = economy.betClaim(clone(bet), clone(market), clone(player), t);
    Object.assign(bet, { status: res.status, payout: res.payout, taxed: res.taxed, claimedAt: t });
    player.balance += res.payout;
    player.openStake -= bet.amount;
    player.totalWon += res.status === 'won' ? res.payout : 0;
    player.lastClaimId = bet.id;
    return res;
  }

  function applyBondClaim(db, market, uid, player) {
    const owed = economy.bondClaims(clone(market));
    let amount;
    if (market.reportedBy === uid) {
      if (market.reporterBondPaid) fail('Your bond has already been paid out.');
      amount = owed.reporter;
      market.reporterBondPaid = true;
    } else if (market.challengedBy === uid) {
      if (market.challengerBondPaid) fail('Your bond has already been paid out.');
      amount = owed.challenger;
      market.challengerBondPaid = true;
    } else {
      fail("You didn't put up a bond on this market.");
    }
    player.balance += amount;
    return amount;
  }

  // ---------- store ----------
  const store = {
    async init() {
      return { mode: 'local' };
    },

    // --- auth ---
    onAuthChange(cb) { return subscribe('auth', cb); },
    /** Extra (not in the Firebase API): the signed-in account even when it has no readable player (maintenance / ban). */
    onSessionChange(cb) { return subscribe('session', cb); },

    async signUp(username, password) {
      username = String(username ?? '').trim();
      password = String(password ?? '');
      const bad = economy.validateUsername(username);
      if (bad) throw new Error(bad);
      if (password.length < 6) throw new Error('Password must be at least 6 characters.');
      const lower = username.toLowerCase();
      const salt = randomHex(16);
      const hash = await sha256Hex(salt + ':' + password);
      const db = load(); // re-read after the await
      if (db.auth[lower]) throw new Error('That username is already taken.');
      const uid = uuid();
      db.auth[lower] = { uid, username, salt, hash };
      setSessionUid(uid);
      // The account exists either way (like a Firebase Auth user); the player doc needs the gate to be open.
      if (!appOpen(db, uid)) {
        save(db);
        throw new Error(MAINTENANCE_MESSAGE);
      }
      const player = ensurePlayer(db, uid);
      save(db);
      return clone(player);
    },

    async signIn(username, password) {
      username = String(username ?? '').trim();
      password = String(password ?? '');
      const lower = username.toLowerCase();
      const rec = load().auth[lower];
      const bad = new Error('Invalid username or password.');
      if (!rec) throw bad;
      const hash = await sha256Hex(rec.salt + ':' + password);
      if (hash !== rec.hash) throw bad;
      const db = load();
      setSessionUid(rec.uid);
      if (isBanned(db, rec.uid)) { notifyAll(); throw new Error(BANNED_MESSAGE); }
      if (!appOpen(db, rec.uid)) { notifyAll(); throw new Error(MAINTENANCE_MESSAGE); }
      const player = ensurePlayer(db, rec.uid); // repair path for accounts created during maintenance
      save(db);
      return clone(player);
    },

    async signOut() {
      setSessionUid(null);
      notifyAll();
    },

    // --- subscriptions ---
    subscribeConfig(cb) { return subscribe('config', cb); },
    subscribeMyBan(cb) { return subscribe('myBan', cb); },
    subscribePlayers(cb) { return subscribe('players', cb); },
    subscribeMarkets(cb) { return subscribe('markets', cb); },
    subscribeBets(cb) { return subscribe('bets', cb); },
    subscribeMyVotes(cb) { return subscribe('myVotes', cb); },
    subscribeBans(cb) { return subscribe('bans', cb); },

    // --- markets ---
    async ensureHouseMarkets(markets) {
      const db = load();
      const now = nowFn();
      const { player } = actor(db);
      let changed = false;
      for (const raw of markets || []) {
        if (!raw || !raw.id || db.markets[raw.id]) continue;
        const m = economy.normalizeMarket(clone(raw));
        if (m.createdBy !== 'house' || m.type !== 'auto') continue;
        if (economy.validateCreateMarket(player, m, now)) continue;
        db.markets[m.id] = m;
        changed = true;
      }
      // actor() may have repaired the player doc, so always persist when something changed.
      if (changed) save(db);
    },

    async createMarket(market) {
      const db = load();
      const now = nowFn();
      const { uid, player } = actor(db);
      if (!market || typeof market !== 'object') throw new Error('Invalid market.');
      const m = economy.normalizeMarket(clone(market));
      if (!m.id) m.id = 'custom-' + uuid();
      if (db.markets[m.id]) throw new Error('A market with that id already exists.');
      if (m.createdBy === 'house' || m.type === 'auto') throw new Error('Only the house can create daily markets.');
      const err = economy.validateCreateMarket(clone(player), m, now);
      if (err) throw new Error(err);
      if (m.type === 'custom' && m.createdBy === uid) Object.assign(player, economy.marketCreationPatch(clone(player), now));
      db.markets[m.id] = m;
      save(db);
      return m.id;
    },

    async placeBet(marketId, optionId, amount) {
      const db = load();
      const now = nowFn();
      const { uid, player } = actor(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      amount = Number(amount);
      const err = economy.validateBet(clone(player), clone(market), optionId, amount, now);
      if (err) throw new Error(err);
      const bet = economy.buildBet({
        id: 'bet-' + uuid(), market: clone(market), player: clone(player), optionId, amount, now,
      });
      Object.assign(market, economy.applyBetToMarket(clone(market), optionId, amount, bet.id));
      player.balance -= amount;
      player.openStake += amount;
      player.totalWagered += amount;
      player.lastBetAt = now;
      const sk = `${marketId}_${uid}`;
      const stake = db.stakes[sk] || (db.stakes[sk] = { marketId, uid, amount: 0 });
      stake.amount += amount;
      db.bets[bet.id] = bet;
      save(db);
      return clone(bet);
    },

    async reportResult(marketId, optionId, eventAt = null, evidence = null) {
      const db = load();
      const now = nowFn();
      const { uid, player } = actor(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      if (evidence != null) {
        if (typeof evidence !== 'string' || evidence.length > economy.MAX_EVIDENCE_LENGTH) {
          throw new Error(`Evidence must be a link of at most ${economy.MAX_EVIDENCE_LENGTH} characters.`);
        }
      }
      const isTimer = market.kind === 'timer';
      const evt = isTimer && eventAt != null ? Number(eventAt) : null;
      const err = economy.validateReport(clone(player), clone(market), optionId, evt, now);
      if (err) throw new Error(err);
      Object.assign(market, {
        status: 'reported',
        reportedBy: uid,
        reportedByName: player.username,
        reportedOptionId: isTimer ? null : optionId,
        reportedEventAt: isTimer ? evt : null,
        reportedAt: now,
        evidence: evidence || null,
      });
      player.balance -= economy.BOND;
      player.lastBondMarketId = marketId;
      save(db);
    },

    async challengeReport(marketId) {
      const db = load();
      const now = nowFn();
      const { uid, player } = actor(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      const err = economy.validateChallenge(clone(player), clone(market), now);
      if (err) throw new Error(err);
      Object.assign(market, {
        status: 'challenged', challengedBy: uid, challengedByName: player.username, challengedAt: now,
      });
      player.balance -= economy.BOND;
      player.lastBondMarketId = marketId;
      save(db);
    },

    async voteOnDispute(marketId, uphold) {
      const db = load();
      const now = nowFn();
      const { uid, player } = actor(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      const key = `${marketId}_${uid}`;
      const err = economy.validateVote(
        clone(player), clone(market), { hasStake: !!db.stakes[key], hasVoted: !!db.votes[key] }, now,
      );
      if (err) throw new Error(err);
      const up = !!uphold;
      db.votes[key] = { marketId, uid, uphold: up, at: now };
      if (up) market.votesUphold += 1; else market.votesOverturn += 1;
      market.lastVoteId = key;
      save(db);
    },

    async finalizeMarket(marketId) {
      const db = load();
      const now = nowFn();
      actor(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      if (market.status === 'resolved' || market.status === 'void') return clone(market); // idempotent
      if (!applyFinalize(db, market, now)) throw new Error("This market can't be finalized yet.");
      save(db);
      return clone(market);
    },

    async voidMarket(marketId) {
      const db = load();
      const now = nowFn();
      const { uid } = actor(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      if (market.type !== 'custom' || market.createdBy !== uid) throw new Error('Only the creator can void this market.');
      if (market.status !== 'open') throw new Error('This market can no longer be voided.');
      if (market.betCount !== 0) throw new Error("Bets have been placed, so this market can't be voided.");
      Object.assign(market, { status: 'void', resolvedOptionId: null, resolvedAt: now, eventAt: null });
      save(db);
    },

    // --- claims ---
    async claimBet(betId) {
      const db = load();
      const now = nowFn();
      const { uid, player } = actor(db);
      const bet = db.bets[betId];
      if (!bet) throw new Error('Bet not found.');
      if (bet.uid !== uid) throw new Error("That's not your bet.");
      if (bet.status !== 'open') throw new Error('This bet has already been claimed.');
      const market = db.markets[bet.marketId];
      if (!market || (market.status !== 'resolved' && market.status !== 'void')) {
        throw new Error('This market has not been settled yet.');
      }
      applyBetClaim(db, bet, player, now);
      save(db);
      return clone(bet);
    },

    async claimBond(marketId) {
      const db = load();
      const { uid, player } = actor(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      if (market.status !== 'resolved' && market.status !== 'void') throw new Error('This market has not been settled yet.');
      const amount = applyBondClaim(db, market, uid, player);
      save(db);
      return amount;
    },

    async markBrokeIfNeeded() {
      const db = load();
      const { player } = actor(db);
      if (player.brokeSince == null && economy.isBroke(player)) {
        player.brokeSince = nowFn();
        save(db);
      }
    },

    async claimRestart() {
      const db = load();
      const now = nowFn();
      const { player } = actor(db);
      if (!economy.canClaimRestart(clone(player), now)) {
        if (!economy.isBroke(player)) throw new Error("You're not broke.");
        if (player.brokeSince == null) throw new Error("You haven't been marked as broke yet — try again in a moment.");
        throw new Error('Come back after midnight UTC to claim your bailout.');
      }
      Object.assign(player, economy.restartPatch(clone(player), now));
      save(db);
    },

    /** Finalizes what it can, claims my settled bets and bonds, marks me broke. Never throws. */
    async runHousekeeping() {
      const result = { finalized: 0, claimed: 0, bonds: 0 };
      try {
        const db = load();
        const now = nowFn();
        const uid = getSessionUid();
        if (!canRead(db, uid) || !authRecordFor(db, uid)) return result;
        const attempt = async (fn) => { try { return await fn(); } catch { return undefined; } };
        for (const m of Object.values(db.markets)) {
          if (economy.finalizeOutcome(clone(m), now) && await attempt(() => store.finalizeMarket(m.id))) result.finalized++;
        }
        const fresh = load();
        for (const b of Object.values(fresh.bets)) {
          if (b.uid !== uid || b.status !== 'open') continue;
          const m = fresh.markets[b.marketId];
          if (m && (m.status === 'resolved' || m.status === 'void') && await attempt(() => store.claimBet(b.id))) result.claimed++;
        }
        for (const m of Object.values(load().markets)) {
          if (m.status !== 'resolved' && m.status !== 'void') continue;
          const owed = economy.bondClaims(clone(m));
          const mine = (m.reportedBy === uid && !m.reporterBondPaid && owed.reporter > 0)
            || (m.challengedBy === uid && !m.challengerBondPaid && owed.challenger > 0);
          if (mine && await attempt(() => store.claimBond(m.id)) !== undefined) result.bonds++;
        }
        await attempt(() => store.markBrokeIfNeeded());
      } catch { /* housekeeping never throws */ }
      return result;
    },

    // --- admin ---
    async claimAdmin(code) {
      const hash = await sha256Hex(String(code ?? ''));
      const db = load();
      const uid = getSessionUid();
      if (!uid || !authRecordFor(db, uid)) throw new Error('Sign in (or sign up) first, then enter the admin code.');
      if (db.config) throw new Error('Admin has already been claimed.');
      if (hash !== adminHash) throw new Error("That's not the admin code.");
      db.config = { adminUid: uid, maintenance: true, updatedAt: nowFn() };
      ensurePlayer(db, uid); // the admin may play even in maintenance
      save(db);
    },

    async setMaintenance(on) {
      const db = load();
      requireAdmin(db);
      db.config.maintenance = !!on;
      db.config.updatedAt = nowFn();
      save(db);
    },

    async banPlayer(uid, reason = '') {
      const db = load();
      const me = requireAdmin(db);
      if (uid === db.config.adminUid) throw new Error("You can't ban the admin.");
      const p = db.players[uid];
      const rec = authRecordFor(db, uid);
      if (!p && !rec) throw new Error('Player not found.');
      db.bans[uid] = {
        uid, username: p ? p.username : rec.username, by: me, at: nowFn(), reason: String(reason ?? '').slice(0, 200),
      };
      save(db);
    },

    async unbanPlayer(uid) {
      const db = load();
      requireAdmin(db);
      if (db.bans[uid]) {
        delete db.bans[uid];
        save(db);
      }
    },
  };

  return store;
}

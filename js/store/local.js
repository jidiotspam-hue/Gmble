// localStorage backend for Sonnetous. Implements the store API from SPEC.md.
// Runs in browsers and in Node (given a globalThis.localStorage shim or options.storage).
import * as economy from '../economy.js';

const DB_KEY = 'sonnetous:v1';
const SESSION_KEY = 'sonnetous:session';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

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
  // Fallback for insecure contexts without crypto.subtle (cyrb53). Local mode only.
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

export function createLocalStore(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const storage = options.storage || defaultStorage();

  const listeners = { users: new Set(), markets: new Set(), bets: new Set(), auth: new Set() };

  // ---------- persistence ----------
  function load() {
    let db = null;
    try {
      const raw = storage.getItem(DB_KEY);
      if (raw) db = JSON.parse(raw);
    } catch { db = null; }
    if (!db || typeof db !== 'object') db = {};
    db.users = db.users && typeof db.users === 'object' ? db.users : {};
    db.auth = db.auth && typeof db.auth === 'object' ? db.auth : {};
    db.markets = db.markets && typeof db.markets === 'object' ? db.markets : {};
    db.bets = Array.isArray(db.bets) ? db.bets : [];
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

  function currentUserFrom(db) {
    const uid = getSessionUid();
    return uid && db.users[uid] ? db.users[uid] : null;
  }

  function requireUser(db) {
    const u = currentUserFrom(db);
    if (!u) throw new Error('You need to be logged in.');
    return u;
  }

  // ---------- notifications ----------
  const sortedMarkets = (db) =>
    Object.values(db.markets).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  const sortedBets = (db) =>
    [...db.bets].sort((a, b) => (b.placedAt || 0) - (a.placedAt || 0));

  function safeCall(fn, arg) {
    try { fn(arg); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
  }

  function notifyAll() {
    const db = load();
    if (listeners.users.size) {
      const users = Object.values(db.users);
      for (const cb of [...listeners.users]) safeCall(cb, clone(users));
    }
    if (listeners.markets.size) {
      const ms = sortedMarkets(db);
      for (const cb of [...listeners.markets]) safeCall(cb, clone(ms));
    }
    if (listeners.bets.size) {
      const bs = sortedBets(db);
      for (const cb of [...listeners.bets]) safeCall(cb, clone(bs));
    }
    if (listeners.auth.size) {
      const u = currentUserFrom(db);
      const json = JSON.stringify(u || null);
      for (const entry of [...listeners.auth]) {
        if (entry.last !== json) {
          entry.last = json;
          safeCall(entry.cb, u ? clone(u) : null);
        }
      }
    }
  }

  // Multi-tab sync (browser only).
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e) => {
      if (e.storageArea && e.storageArea !== storage) return;
      if (e.key === null || e.key === DB_KEY || e.key === SESSION_KEY) notifyAll();
    });
  }

  function subscribeSimple(set, getData, cb) {
    set.add(cb);
    safeCall(cb, clone(getData(load())));
    return () => { set.delete(cb); };
  }

  // ---------- helpers ----------
  function applySettlement(db, res) {
    const market = db.markets[res.marketId];
    Object.assign(market, res.result.marketPatch);
    for (const bet of db.bets) {
      const p = res.result.betPatches[bet.id];
      if (p) Object.assign(bet, p);
    }
    for (const [uid, delta] of Object.entries(res.result.userDeltas || {})) {
      const u = db.users[uid];
      if (!u) continue;
      for (const [k, v] of Object.entries(delta)) u[k] = (u[k] || 0) + v;
    }
  }

  function settleInDb(db, market, winningOptionId, eventAt, resolvedBy) {
    const t = nowFn();
    const bets = clone(db.bets.filter((b) => b.marketId === market.id));
    const result = economy.settleMarket(
      clone(market), bets, winningOptionId, clone(db.users), t, resolvedBy, eventAt ?? null,
    );
    applySettlement(db, { marketId: market.id, result });
  }

  function voidInDb(db, market, resolvedBy) {
    const t = nowFn();
    const bets = clone(db.bets.filter((b) => b.marketId === market.id));
    const result = economy.voidMarket(clone(market), bets, t, resolvedBy);
    applySettlement(db, { marketId: market.id, result });
  }

  // ---------- store ----------
  const store = {
    async init() {
      return { mode: 'local' };
    },

    onAuthChange(cb) {
      const entry = { cb, last: null };
      listeners.auth.add(entry);
      const u = currentUserFrom(load());
      entry.last = JSON.stringify(u || null);
      safeCall(cb, u ? clone(u) : null);
      return () => { listeners.auth.delete(entry); };
    },

    async signUp(username, password) {
      username = String(username ?? '').trim();
      password = String(password ?? '');
      if (!USERNAME_RE.test(username)) {
        throw new Error('Username must be 3–20 characters: letters, numbers and underscores only.');
      }
      if (password.length < 6) throw new Error('Password must be at least 6 characters.');
      const lower = username.toLowerCase();
      const salt = randomHex(16);
      const hash = await sha256Hex(salt + ':' + password);
      // Re-read after the await so we act on fresh data.
      const db = load();
      if (db.auth[lower]) throw new Error('That username is already taken.');
      const uid = uuid();
      db.auth[lower] = { uid, salt, hash };
      db.users[uid] = economy.newUser(uid, username, nowFn());
      setSessionUid(uid);
      save(db);
      return clone(db.users[uid]);
    },

    async signIn(username, password) {
      username = String(username ?? '').trim();
      password = String(password ?? '');
      const lower = username.toLowerCase();
      const db = load();
      const rec = db.auth[lower];
      const bad = new Error('Invalid username or password.');
      if (!rec) throw bad;
      const hash = await sha256Hex(rec.salt + ':' + password);
      if (hash !== rec.hash) throw bad;
      const user = load().users[rec.uid];
      if (!user) throw bad;
      setSessionUid(rec.uid);
      notifyAll();
      return clone(user);
    },

    async signOut() {
      setSessionUid(null);
      notifyAll();
    },

    subscribeUsers(cb) {
      return subscribeSimple(listeners.users, (db) => Object.values(db.users), cb);
    },
    subscribeMarkets(cb) {
      return subscribeSimple(listeners.markets, sortedMarkets, cb);
    },
    subscribeBets(cb) {
      return subscribeSimple(listeners.bets, sortedBets, cb);
    },

    async ensureMarkets(markets) {
      const db = load();
      let changed = false;
      for (const m of markets || []) {
        if (!m || !m.id || db.markets[m.id]) continue;
        db.markets[m.id] = clone(m);
        changed = true;
      }
      if (changed) save(db);
    },

    async createMarket(market) {
      const db = load();
      const user = requireUser(db);
      if (!market || typeof market !== 'object') throw new Error('Invalid market.');
      const m = clone(market);
      if (!m.id) m.id = 'custom-' + uuid();
      if (db.markets[m.id]) throw new Error('A market with that id already exists.');
      if (m.createdBy !== user.uid) throw new Error('You can only create markets as yourself.');
      db.markets[m.id] = m;
      save(db);
      return m.id;
    },

    async placeBet(marketId, optionId, amount) {
      const db = load();
      const user = requireUser(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      amount = Number(amount);
      const t = nowFn();
      const err = economy.validateBet(clone(user), clone(market), optionId, amount, t);
      if (err) throw new Error(err);
      const bet = economy.buildBet({
        id: 'bet-' + uuid(), market: clone(market), user: clone(user), optionId, amount, now: t,
      });
      const patch = economy.applyBetToMarket(clone(market), optionId, amount);
      Object.assign(market, patch);
      user.balance -= amount;
      user.totalWagered = (user.totalWagered || 0) + amount;
      db.bets.push(bet);
      save(db);
      return clone(bet);
    },

    async resolveMarket(marketId, optionId, eventAt = null) {
      const db = load();
      const user = requireUser(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      if (market.status !== 'open') throw new Error('This market has already been settled.');
      if (market.type === 'custom' && market.createdBy !== user.uid) {
        throw new Error('Only the creator can resolve this market.');
      }
      const t = nowFn();
      let winner = optionId ?? null;
      let evt = null;
      if (market.kind === 'timer' && eventAt !== null && eventAt !== undefined) {
        evt = Number(eventAt);
        if (!Number.isFinite(evt)) throw new Error('Invalid event time.');
        if (evt > t) throw new Error("The event can't be in the future.");
        winner = economy.timerBucketFor(clone(market), evt);
      }
      if (winner === null || !market.options.some((o) => o.id === winner)) {
        throw new Error('Pick a valid winning option.');
      }
      settleInDb(db, market, winner, evt, user.username);
      save(db);
    },

    async autoResolveExpired() {
      const db = load();
      const t = nowFn();
      let changed = false;
      for (const market of Object.values(db.markets)) {
        if (market.status !== 'open' || market.kind !== 'timer') continue;
        const winner = economy.timerAutoResolution(clone(market), t);
        if (!winner) continue;
        settleInDb(db, market, winner, null, 'auto');
        changed = true;
      }
      if (changed) save(db);
    },

    async voidMarket(marketId) {
      const db = load();
      const user = requireUser(db);
      const market = db.markets[marketId];
      if (!market) throw new Error('Market not found.');
      if (market.createdBy !== user.uid) throw new Error('Only the creator can void this market.');
      if (market.status !== 'open') throw new Error('This market has already been settled.');
      voidInDb(db, market, user.username);
      save(db);
    },

    async markBrokeIfNeeded() {
      const db = load();
      const user = currentUserFrom(db);
      if (!user || user.brokeSince) return;
      const bets = db.bets.filter((b) => b.uid === user.uid);
      if (economy.isBroke(clone(user), clone(bets))) {
        user.brokeSince = economy.dayKey(nowFn());
        save(db);
      }
    },

    async claimRestart() {
      const db = load();
      const user = requireUser(db);
      const bets = clone(db.bets.filter((b) => b.uid === user.uid));
      const t = nowFn();
      if (!economy.canClaimRestart(clone(user), bets, t)) {
        if (!economy.isBroke(clone(user), bets)) throw new Error("You're not broke.");
        throw new Error('Come back tomorrow to claim your bailout.');
      }
      Object.assign(user, economy.restartPatch(clone(user), t));
      save(db);
    },
  };

  return store;
}

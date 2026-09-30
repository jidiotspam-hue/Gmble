// Firebase (Auth + Firestore) backend for Sonnetous v2. Implements the Store API v2 from SPEC-v2.md.
// The Firebase modular SDK is loaded lazily from the gstatic CDN.
//
// Security lives in firestore.rules, NOT here: every operation below is ONE Firestore transaction whose
// writes have exactly the shape the rules cross-check with getAfter() (see the table at the end of
// firestore.rules). The client-side checks (economy.validate*) only exist to give friendly messages.
// All times are epoch-ms numbers.
import * as economy from '../economy.js';

const FB_VERSION = '10.12.2';
const FB_BASE = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_DOMAIN = 'users.sonnetous.app';

export const MAINTENANCE_MESSAGE = 'Sonnetous is down for maintenance';
export const BANNED_MESSAGE = "You've been banned";
const NOT_LOGGED_IN = 'You need to be logged in.';
const DENIED_MESSAGE = 'The game rules rejected that action. Someone may have acted first — refresh and try again.';

// Exactly the keys firestore.rules allows on a market document (anything else would be rejected).
const MARKET_KEYS = [
  'id', 'type', 'templateId', 'kind', 'mode', 'title', 'description', 'category', 'emoji', 'createdBy', 'createdByName',
  'openedAt', 'closesAt', 'options', 'optionIds', 'oddsById', 'bucketsById', 'expiresAt', 'expiryOptionId', 'reportableAt',
  'oracle', 'optionTotals', 'totalPool', 'betCount', 'lastBetId', 'status', 'reportedBy', 'reportedByName',
  'reportedOptionId', 'reportedEventAt', 'reportedAt', 'evidence', 'challengedBy', 'challengedByName', 'challengedAt',
  'votesUphold', 'votesOverturn', 'lastVoteId', 'resolvedOptionId', 'resolvedAt', 'eventAt', 'reporterBondPaid',
  'challengerBondPaid',
];
const HOUSE_BATCH = 5; // house markets per transaction (keeps the rules' access-call budget far away)

// Plain-JSON deep clone. Also strips `undefined` values, which Firestore rejects.
const clean = (x) => JSON.parse(JSON.stringify(x));
const isFinal = (m) => !!m && (m.status === 'resolved' || m.status === 'void');
const safeCall = (fn, arg) => { try { fn(arg); } catch (e) { if (typeof console !== 'undefined') console.error(e); } };

const codeOf = (e) => {
  const raw = e && typeof e.code === 'string' ? e.code : '';
  return raw.startsWith('firestore/') ? raw.slice('firestore/'.length) : raw;
};
const isPermissionDenied = (e) => codeOf(e) === 'permission-denied';

class GameClosedError extends Error {}

function toUserError(e) {
  if (!e) return new Error('Something went wrong.');
  const raw = typeof e.code === 'string' ? e.code : '';
  const code = codeOf(e);
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-email':
    case 'auth/missing-password':
      return new Error('Invalid username or password.');
    case 'auth/email-already-in-use':
      return new Error('That username is already taken.');
    case 'auth/weak-password':
      return new Error('Password must be at least 6 characters.');
    case 'auth/too-many-requests':
      return new Error('Too many attempts. Wait a bit and try again.');
    case 'auth/user-disabled':
      return new Error('This account has been disabled.');
    case 'auth/network-request-failed':
    case 'unavailable':
    case 'deadline-exceeded':
      return new Error('Network problem. Check your connection and try again.');
    case 'permission-denied':
      return new Error(DENIED_MESSAGE);
    case 'unauthenticated':
      return new Error(NOT_LOGGED_IN);
    case 'aborted':
    case 'failed-precondition':
    case 'resource-exhausted':
      return new Error('The game is busy right now. Please try again.');
    case 'auth/operation-not-allowed':
    case 'auth/admin-restricted-operation':
      return new Error('Email/password sign-in is not enabled in this Firebase project.');
    case 'auth/configuration-not-found':
      return new Error('Authentication has not been set up in this Firebase project yet (Build > Authentication > Get started).');
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid':
      return new Error('The Firebase API key in js/config.js is not valid.');
    default:
      break;
  }
  // Errors we threw ourselves already carry a user-facing message.
  if (e instanceof Error && !raw) return e;
  if (raw.startsWith('auth/')) return new Error(`Sign-in problem (${raw.slice(5)}). Please try again.`);
  if (raw) return new Error(`Database problem (${raw}). Please try again.`);
  return new Error(String((e && e.message) || e));
}

/**
 * Creates the Firestore + Auth backed store.
 *
 * `opts` is an optional test seam; production callers pass only `config`:
 *   sdk         { app, auth, firestore }  SDK modules to use instead of the gstatic CDN imports
 *   emulator    { authUrl, firestoreHost, firestorePort }  connect to the local emulators
 *   appName     name for initializeApp (lets one process host several independent clients)
 *   now         () => ms clock used for every timestamp that is written (defaults to Date.now).
 *               Firestore rules compare these with server time (+-5 min), so it must be close to real time.
 *   decisionNow () => ms clock used ONLY for client-side "is this window over yet" decisions
 *               (finalize eligibility, bailout day). Defaults to `now`. Lets tests use shortened windows.
 */
export async function createFirebaseStore(config, opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const decisionNow = typeof opts.decisionNow === 'function' ? opts.decisionNow : nowFn;
  const [appMod, authMod, fsMod] = opts.sdk
    ? [opts.sdk.app, opts.sdk.auth, opts.sdk.firestore]
    : await Promise.all([
      import(FB_BASE + 'firebase-app.js'),
      import(FB_BASE + 'firebase-auth.js'),
      import(FB_BASE + 'firebase-firestore.js'),
    ]);
  const { initializeApp, deleteApp } = appMod;
  const {
    getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
    signOut: fbSignOut, updateProfile, deleteUser, connectAuthEmulator,
  } = authMod;
  const {
    getFirestore, doc, collection, query, where, orderBy, onSnapshot, getDoc, getDocs, setDoc, deleteDoc,
    updateDoc, writeBatch, runTransaction, connectFirestoreEmulator, terminate,
  } = fsMod;

  const app = opts.appName ? initializeApp(config, opts.appName) : initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (opts.emulator) {
    connectAuthEmulator(auth, opts.emulator.authUrl, { disableWarnings: true });
    connectFirestoreEmulator(db, opts.emulator.firestoreHost, opts.emulator.firestorePort);
  }
  // Web SDK default is 5 attempts; a busy market (many simultaneous bets) can need more.
  const inTx = (fn) => runTransaction(db, fn, { maxAttempts: 12 });

  const emailFor = (lower) => `${lower}@${EMAIL_DOMAIN}`;
  const configRef = doc(db, 'app', 'config');
  const claimRef = doc(db, 'app', 'claim');
  const banRef = (uid) => doc(db, 'bans', uid);
  const handleRef = (lower) => doc(db, 'handles', lower);
  const playerRef = (uid) => doc(db, 'players', uid);
  const marketRef = (id) => doc(db, 'markets2', id);
  const betRef = (id) => doc(db, 'bets2', id);
  const stakeRef = (marketId, uid) => doc(db, 'stakes', `${marketId}_${uid}`);
  const voteRef = (marketId, uid) => doc(db, 'votes', `${marketId}_${uid}`);

  let signingUp = false;
  let disposed = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    if (t && typeof t.unref === 'function') t.unref();
    timers.add(t);
    return t;
  };

  async function whenAuthReady() {
    if (typeof auth.authStateReady === 'function') await auth.authStateReady();
  }

  async function requireUid() {
    await whenAuthReady();
    const u = auth.currentUser;
    if (!u) throw new Error(NOT_LOGGED_IN);
    return u.uid;
  }

  // Username for an authenticated account: displayName, or (if updateProfile failed during
  // sign-up) the lowercased name embedded in the synthetic email.
  function profileNameFor(fbUser) {
    if (fbUser.displayName && USERNAME_RE.test(fbUser.displayName)) return fbUser.displayName;
    const local = String(fbUser.email || '').split('@')[0];
    return USERNAME_RE.test(local) ? local : null;
  }

  // ------------------------------------------------------------------ gate watcher
  // One shared listener on app/config (public) and one on bans/{me}. Everything gate-dependent (auth
  // profile stream, list subscriptions, action pre-checks) is derived from it.
  const gate = { authReady: false, config: undefined, ban: undefined, banUid: null };
  const bus = new Set();
  const fire = () => { for (const f of [...bus]) safeCall(f); };
  const onBus = (f) => { bus.add(f); return () => bus.delete(f); };
  const sessionCbs = new Set();
  let watchStarted = false;
  let unsubConfig = null;
  let unsubBan = null;
  let unsubAuthWatch = null;

  const sessionNow = () => {
    const u = auth.currentUser;
    return u ? { uid: u.uid, username: profileNameFor(u) || '' } : null;
  };
  function emitSessions() {
    if (!gate.authReady) return;
    const s = sessionNow();
    const key = JSON.stringify(s);
    for (const e of [...sessionCbs]) {
      if (e.last !== key) { e.last = key; safeCall(e.cb, s ? { ...s } : null); }
    }
  }

  function startWatch() {
    if (watchStarted || disposed) return;
    watchStarted = true;
    unsubConfig = onSnapshot(configRef, (snap) => {
      const d = snap.exists() ? snap.data() : null;
      gate.config = d
        ? { exists: true, maintenance: d.maintenance !== false, adminUid: d.adminUid || null }
        : { exists: false, maintenance: true, adminUid: null };
      fire();
    }, () => { /* config is public; errors here are network problems, the state just stays as it was */ });
    unsubAuthWatch = onAuthStateChanged(auth, (user) => {
      if (unsubBan) { unsubBan(); unsubBan = null; }
      gate.authReady = true;
      gate.ban = undefined;
      gate.banUid = user ? user.uid : null;
      if (user) {
        const uid = user.uid;
        unsubBan = onSnapshot(banRef(uid), (snap) => {
          if (auth.currentUser && auth.currentUser.uid !== uid) return;
          gate.ban = snap.exists() ? clean(snap.data()) : null;
          fire();
        }, () => { gate.ban = null; fire(); });
      }
      emitSessions();
      fire();
    });
  }

  /** 'unknown' | 'signedout' | 'banned' | 'closed' | 'open' */
  function gateState() {
    if (!gate.authReady) return 'unknown';
    const u = auth.currentUser;
    if (!u) return 'signedout';
    if (gate.config === undefined || gate.banUid !== u.uid || gate.ban === undefined) return 'unknown';
    if (gate.ban) return 'banned';
    if (!gate.config.exists) return 'closed';
    if (gate.config.maintenance && gate.config.adminUid !== u.uid) return 'closed';
    return 'open';
  }

  function waitFor(pred, ms) {
    return new Promise((resolve) => {
      if (pred()) { resolve(true); return; }
      let done = false;
      const finish = (v) => { if (done) return; done = true; off(); clearTimeout(t); resolve(v); };
      const off = onBus(() => { if (pred()) finish(true); });
      const t = setTimeout(() => finish(pred()), ms);
      if (t && typeof t.unref === 'function') t.unref();
    });
  }

  async function ensureGate() {
    startWatch();
    await whenAuthReady();
    if (gateState() === 'unknown') await waitFor(() => gateState() !== 'unknown', 4000);
    return gateState();
  }

  /** Throws the friendly maintenance / ban / login error, else returns the uid. Rules stay the real gate. */
  async function requireOpen() {
    const uid = await requireUid();
    const g = await ensureGate();
    if (g === 'banned') throw new GameClosedError(BANNED_MESSAGE);
    if (g === 'closed') throw new GameClosedError(MAINTENANCE_MESSAGE);
    return uid;
  }

  // After a permission-denied: find out WHY. Maintenance / ban are precise messages, everything else is
  // "the rules said no" (a race, or an action that was not allowed).
  async function explainDenied(e) {
    try {
      const u = auth.currentUser;
      if (u) {
        const [cfg, ban] = await Promise.all([getDoc(configRef), getDoc(banRef(u.uid))]);
        if (ban.exists()) return new GameClosedError(BANNED_MESSAGE);
        const c = cfg.exists() ? cfg.data() : null;
        if (!c || (c.maintenance !== false && c.adminUid !== u.uid)) return new GameClosedError(MAINTENANCE_MESSAGE);
      }
    } catch { /* fall through */ }
    return toUserError(e);
  }

  // When two clients race the loser's commit is evaluated by the rules against the winner's result and
  // comes back as permission-denied rather than a retryable conflict. Run the operation once more: it
  // re-reads fresh data, so the user gets the real reason ("already settled", ...). A genuine rules
  // failure fails again and is reported.
  async function retryOnceIfDenied(fn) {
    try {
      return await fn();
    } catch (e) {
      if (!isPermissionDenied(e)) throw e;
      return fn();
    }
  }

  /** Runs one transaction body with retries and friendly errors. */
  async function txRun(fn) {
    try {
      return await retryOnceIfDenied(() => inTx(fn));
    } catch (e) {
      if (isPermissionDenied(e)) throw await explainDenied(e);
      throw toUserError(e);
    }
  }

  // ------------------------------------------------------------------ profile creation (signUp / repair)
  // Idempotently create handles/{lower} + players/{uid} in one transaction.
  async function claimProfile(uid, username) {
    const lower = username.toLowerCase();
    return txRun(async (tx) => {
      const [pSnap, hSnap] = await Promise.all([tx.get(playerRef(uid)), tx.get(handleRef(lower))]);
      if (pSnap.exists()) return { ...pSnap.data(), uid };
      if (hSnap.exists() && hSnap.data().uid !== uid) throw new Error('That username is already taken.');
      const player = clean(economy.newPlayer(uid, username, nowFn()));
      if (!hSnap.exists()) tx.set(handleRef(lower), { uid });
      tx.set(playerRef(uid), player);
      return { ...player, uid };
    });
  }

  // ------------------------------------------------------------------ list subscriptions
  // Delivers [] while the game is closed to you (maintenance / ban / signed out) and (re)attaches the
  // Firestore listener whenever the gate opens: Firestore cancels a listener after permission-denied.
  function gatedSubscribe(build, map, cb, { adminOnly = false } = {}) {
    startWatch();
    let unsub = null;
    let alive = true;
    let emptySent = false;
    let retry = null;
    const stop = () => { if (unsub) { unsub(); unsub = null; } };
    const sendEmpty = () => { if (!emptySent) { emptySent = true; safeCall(cb, []); } };
    const evaluate = () => {
      if (!alive) return;
      const g = gateState();
      if (g === 'unknown') return;
      const u = auth.currentUser;
      const allowed = g === 'open' && (!adminOnly || (gate.config && gate.config.adminUid === u.uid));
      if (!allowed) { stop(); sendEmpty(); return; }
      if (unsub) return;
      unsub = onSnapshot(build(u.uid), (snap) => {
        emptySent = false;
        safeCall(cb, map(snap));
      }, (err) => {
        stop();
        if (alive && auth.currentUser) console.warn('Listener error', err && err.code);
        sendEmpty();
        if (retry) clearTimeout(retry);
        retry = later(evaluate, 5000);
      });
    };
    const off = onBus(evaluate);
    evaluate();
    return () => { alive = false; off(); stop(); if (retry) clearTimeout(retry); };
  }

  // ------------------------------------------------------------------ transaction helpers
  const need = (snap, what) => {
    if (!snap.exists()) throw new Error(`${what} not found.`);
    return snap.data();
  };
  const marketWrite = (m) => {
    const out = {};
    for (const k of MARKET_KEYS) if (m[k] !== undefined) out[k] = m[k];
    return clean(out);
  };

  async function fetchMarkets(statuses) {
    const snap = await getDocs(query(collection(db, 'markets2'), where('status', 'in', statuses)));
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  }

  // ------------------------------------------------------------------ the store
  let housekeeping = null;

  const store = {
    async init() {
      startWatch();
      await whenAuthReady();
      return { mode: 'firebase' };
    },

    // ---------------------------------------------------------------- auth
    /** cb(Player|null): a Player only while the game is open to you (config exists, not in maintenance unless admin, not banned). */
    onAuthChange(cb) {
      startWatch();
      let alive = true;
      let unsubProfile = null;
      let profileUid = null;
      let lastKey;
      let repairing = null;
      let retry = null;
      const emit = (v) => {
        const key = JSON.stringify(v);
        if (key === lastKey) return;
        lastKey = key;
        safeCall(cb, v);
      };
      const stopProfile = () => { if (unsubProfile) { unsubProfile(); unsubProfile = null; profileUid = null; } };
      const repair = (u) => {
        if (repairing === u.uid) return;
        const name = profileNameFor(u);
        if (!name) {
          console.error('Account has no usable username');
          emit(null);
          fbSignOut(auth).catch(() => {});
          return;
        }
        repairing = u.uid;
        claimProfile(u.uid, name).then(() => { repairing = null; }, (err) => {
          repairing = null;
          if (!(err instanceof GameClosedError)) console.error('Could not create profile', err);
          emit(null);
        });
      };
      const evaluate = () => {
        if (!alive) return;
        const g = gateState();
        if (g === 'unknown') return;
        if (g !== 'open') { stopProfile(); emit(null); return; }
        const u = auth.currentUser;
        if (unsubProfile && profileUid === u.uid) return;
        stopProfile();
        profileUid = u.uid;
        unsubProfile = onSnapshot(playerRef(u.uid), (snap) => {
          if (snap.exists()) { repairing = null; emit({ ...snap.data(), uid: snap.id }); return; }
          // Profile doc missing. During sign-up it is about to be created (stay silent, the UI must not see
          // a transient null); otherwise this is the repair path for an Auth account without a player.
          if (!signingUp) repair(u);
        }, (err) => {
          stopProfile();
          if (auth.currentUser) console.warn('Profile listener error', err && err.code);
          emit(null);
          if (retry) clearTimeout(retry);
          retry = later(evaluate, 5000);
        });
      };
      const off = onBus(evaluate);
      evaluate();
      return () => { alive = false; off(); stopProfile(); if (retry) clearTimeout(retry); };
    },

    /** cb({uid, username}|null): the signed-in Auth account regardless of gate state (maintenance / ban). */
    onSessionChange(cb) {
      startWatch();
      const entry = { cb, last: undefined };
      sessionCbs.add(entry);
      whenAuthReady().then(() => {
        if (!sessionCbs.has(entry) || !gate.authReady) return;
        const s = sessionNow();
        const key = JSON.stringify(s);
        if (entry.last !== key) { entry.last = key; safeCall(cb, s ? { ...s } : null); }
      });
      return () => { sessionCbs.delete(entry); };
    },

    async signUp(username, password) {
      try {
        username = String(username ?? '').trim();
        password = String(password ?? '');
        const bad = economy.validateUsername(username);
        if (bad) throw new Error(bad);
        if (password.length < 6) throw new Error('Password must be at least 6 characters.');
        const lower = username.toLowerCase();
        startWatch();
        signingUp = true;
        let cred;
        try {
          cred = await createUserWithEmailAndPassword(auth, emailFor(lower), password);
        } catch (e) {
          signingUp = false;
          throw e;
        }
        try {
          try { await updateProfile(cred.user, { displayName: username }); } catch { /* non-fatal */ }
          emitSessions();
          // The account exists either way (like a Firebase Auth user); the player doc needs the gate to be open.
          await requireOpen();
          const player = await claimProfile(cred.user.uid, username);
          signingUp = false;
          return player;
        } catch (e) {
          if (e instanceof GameClosedError) {
            // Keep the session (the person can wait, or claim the admin seat); the player is created once the game opens.
            signingUp = false;
            fire();
            throw e;
          }
          // Roll back the auth account so the username can be retried.
          try { await deleteUser(cred.user); } catch { /* ignore */ }
          try { await fbSignOut(auth); } catch { /* ignore */ }
          signingUp = false;
          throw e;
        }
      } catch (e) {
        throw toUserError(e);
      }
    },

    async signIn(username, password) {
      try {
        username = String(username ?? '').trim();
        password = String(password ?? '');
        if (!USERNAME_RE.test(username)) throw new Error('Invalid username or password.');
        startWatch();
        const cred = await signInWithEmailAndPassword(auth, emailFor(username.toLowerCase()), password);
        const uid = cred.user.uid;
        emitSessions();
        await requireOpen(); // banned / maintenance: the session stays, the person just cannot play
        const snap = await getDoc(playerRef(uid));
        if (snap.exists()) return { ...snap.data(), uid };
        return await claimProfile(uid, profileNameFor(cred.user) || username);
      } catch (e) {
        throw toUserError(e);
      }
    },

    async signOut() {
      try { await fbSignOut(auth); } catch (e) { throw toUserError(e); }
    },

    // ---------------------------------------------------------------- subscriptions
    subscribeConfig(cb) {
      startWatch();
      let last;
      const evaluate = () => {
        if (gate.config === undefined) return;
        const key = JSON.stringify(gate.config);
        if (key === last) return;
        last = key;
        safeCall(cb, { ...gate.config });
      };
      const off = onBus(evaluate);
      evaluate();
      return off;
    },

    subscribeMyBan(cb) {
      startWatch();
      let last;
      const evaluate = () => {
        if (!gate.authReady) return;
        let v;
        if (!auth.currentUser) v = null;
        else if (gate.ban === undefined || gate.banUid !== auth.currentUser.uid) return;
        else v = gate.ban;
        const key = JSON.stringify(v);
        if (key === last) return;
        last = key;
        safeCall(cb, v ? { ...v } : null);
      };
      const off = onBus(evaluate);
      evaluate();
      return off;
    },

    subscribePlayers(cb) {
      return gatedSubscribe(
        () => collection(db, 'players'),
        (snap) => snap.docs.map((d) => ({ ...d.data(), uid: d.id })),
        cb,
      );
    },

    subscribeMarkets(cb) {
      return gatedSubscribe(
        () => query(collection(db, 'markets2'), orderBy('openedAt', 'desc')),
        (snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id })),
        cb,
      );
    },

    subscribeBets(cb) {
      return gatedSubscribe(
        () => query(collection(db, 'bets2'), orderBy('placedAt', 'desc')),
        (snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id })),
        cb,
      );
    },

    subscribeMyVotes(cb) {
      return gatedSubscribe(
        (uid) => query(collection(db, 'votes'), where('uid', '==', uid)),
        (snap) => snap.docs.map((d) => d.data().marketId),
        cb,
      );
    },

    subscribeBans(cb) {
      return gatedSubscribe(
        () => collection(db, 'bans'),
        (snap) => snap.docs.map((d) => ({ ...d.data(), uid: d.id })),
        cb,
        { adminOnly: true },
      );
    },

    // ---------------------------------------------------------------- markets
    /**
     * Creates the given daily house markets that do not exist yet. Invalid ones are skipped silently.
     * ADMIN ONLY (the rules enforce it): a no-op for every other user.
     */
    async ensureHouseMarkets(markets) {
      try {
        const uid = await requireOpen();
        if (!gate.config || gate.config.adminUid !== uid) return;
        const now = nowFn();
        const list = [];
        const seen = new Set();
        for (const raw of markets || []) {
          if (!raw || typeof raw !== 'object' || !raw.id || seen.has(raw.id)) continue;
          let m;
          try { m = economy.normalizeMarket(clean(raw)); } catch { continue; }
          if (m.createdBy !== 'house' || m.type !== 'auto') continue;
          if (economy.validateCreateMarket({ uid }, m, now)) continue;
          seen.add(m.id);
          list.push(marketWrite(m));
        }
        const writeChunk = (chunk) => txRun(async (tx) => {
          const snaps = await Promise.all(chunk.map((m) => tx.get(marketRef(m.id))));
          chunk.forEach((m, i) => { if (!snaps[i].exists()) tx.set(marketRef(m.id), m); });
        });
        for (let i = 0; i < list.length; i += HOUSE_BATCH) {
          const chunk = list.slice(i, i + HOUSE_BATCH);
          try {
            await writeChunk(chunk);
          } catch (e) {
            if (e instanceof GameClosedError) throw e;
            // One rejected market must not block the others: retry one by one, skipping the ones the rules refuse.
            for (const m of chunk) {
              try { await writeChunk([m]); } catch (e2) { if (e2 instanceof GameClosedError) throw e2; }
            }
          }
        }
      } catch (e) {
        throw toUserError(e);
      }
    },

    async createMarket(market) {
      try {
        const uid = await requireOpen();
        if (!market || typeof market !== 'object') throw new Error('Invalid market.');
        const m = economy.normalizeMarket(clean(market));
        if (m.createdBy === 'house' || m.type === 'auto') throw new Error('Only the house can create daily markets.');
        if (!m.id) m.id = 'custom-' + doc(collection(db, 'markets2')).id;
        return await txRun(async (tx) => {
          const [pSnap, mSnap] = await Promise.all([tx.get(playerRef(uid)), tx.get(marketRef(m.id))]);
          const player = { ...need(pSnap, 'Your profile'), uid };
          if (mSnap.exists()) throw new Error('A market with that id already exists.');
          const now = nowFn();
          const err = economy.validateCreateMarket(player, m, now);
          if (err) throw new Error(err);
          tx.set(marketRef(m.id), marketWrite(m));
          tx.update(playerRef(uid), clean(economy.marketCreationPatch(player, now)));
          return m.id;
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async placeBet(marketId, optionId, amount) {
      try {
        const uid = await requireOpen();
        amount = Number(amount);
        const betId = doc(collection(db, 'bets2')).id;
        return await txRun(async (tx) => {
          const [pSnap, mSnap, sSnap] = await Promise.all([
            tx.get(playerRef(uid)), tx.get(marketRef(marketId)), tx.get(stakeRef(marketId, uid)),
          ]);
          const player = { ...need(pSnap, 'Your profile'), uid };
          const market = { ...need(mSnap, 'Market'), id: marketId };
          const now = nowFn();
          const err = economy.validateBet(player, market, optionId, amount, now);
          if (err) throw new Error(err);
          const bet = clean(economy.buildBet({ id: betId, market, player, optionId, amount, now }));
          tx.set(betRef(betId), bet);
          tx.update(playerRef(uid), {
            balance: player.balance - amount,
            openStake: (player.openStake || 0) + amount,
            totalWagered: (player.totalWagered || 0) + amount,
            lastBetAt: now,
            lastBetId: betId,
          });
          if (sSnap.exists()) tx.update(stakeRef(marketId, uid), { amount: (sSnap.data().amount || 0) + amount });
          else tx.set(stakeRef(marketId, uid), { marketId, uid, amount });
          tx.update(marketRef(marketId), clean(economy.applyBetToMarket(market, optionId, amount, betId)));
          return bet;
        });
      } catch (e) {
        const err = toUserError(e);
        // bets are timestamped by the device and the rules only accept a clock within about half a minute
        if (err.message === DENIED_MESSAGE) throw new Error(`${DENIED_MESSAGE} (If this keeps happening, check that your device clock is correct.)`);
        throw err;
      }
    },

    async reportResult(marketId, optionId, eventAt = null, evidence = null) {
      try {
        const uid = await requireOpen();
        if (evidence != null && (typeof evidence !== 'string' || evidence.length > economy.MAX_EVIDENCE_LENGTH)) {
          throw new Error(`Evidence must be a link of at most ${economy.MAX_EVIDENCE_LENGTH} characters.`);
        }
        await txRun(async (tx) => {
          const [pSnap, mSnap] = await Promise.all([tx.get(playerRef(uid)), tx.get(marketRef(marketId))]);
          const player = { ...need(pSnap, 'Your profile'), uid };
          const market = { ...need(mSnap, 'Market'), id: marketId };
          const isTimer = market.kind === 'timer';
          const evt = isTimer && eventAt != null ? Number(eventAt) : null;
          const now = nowFn();
          const err = economy.validateReport(player, market, optionId, evt, now);
          if (err) throw new Error(err);
          tx.update(marketRef(marketId), clean({
            status: 'reported',
            reportedBy: uid,
            reportedByName: player.username,
            reportedOptionId: isTimer ? null : optionId, // timers report only WHEN it happened
            reportedEventAt: isTimer ? evt : null,
            reportedAt: now,
            evidence: evidence || null,
          }));
          tx.update(playerRef(uid), { balance: player.balance - economy.BOND, lastBondMarketId: marketId });
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async challengeReport(marketId) {
      try {
        const uid = await requireOpen();
        await txRun(async (tx) => {
          const [pSnap, mSnap] = await Promise.all([tx.get(playerRef(uid)), tx.get(marketRef(marketId))]);
          const player = { ...need(pSnap, 'Your profile'), uid };
          const market = { ...need(mSnap, 'Market'), id: marketId };
          const now = nowFn();
          const err = economy.validateChallenge(player, market, now);
          if (err) throw new Error(err);
          tx.update(marketRef(marketId), clean({
            status: 'challenged', challengedBy: uid, challengedByName: player.username, challengedAt: now,
          }));
          tx.update(playerRef(uid), { balance: player.balance - economy.BOND, lastBondMarketId: marketId });
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async voteOnDispute(marketId, uphold) {
      try {
        const uid = await requireOpen();
        await txRun(async (tx) => {
          const [pSnap, mSnap, sSnap, vSnap] = await Promise.all([
            tx.get(playerRef(uid)), tx.get(marketRef(marketId)), tx.get(stakeRef(marketId, uid)), tx.get(voteRef(marketId, uid)),
          ]);
          const player = { ...need(pSnap, 'Your profile'), uid };
          const market = { ...need(mSnap, 'Market'), id: marketId };
          const now = nowFn();
          const err = economy.validateVote(player, market, { hasStake: sSnap.exists(), hasVoted: vSnap.exists() }, now);
          if (err) throw new Error(err);
          const up = !!uphold;
          const voteId = `${marketId}_${uid}`;
          tx.set(voteRef(marketId, uid), { marketId, uid, uphold: up, at: now });
          tx.update(marketRef(marketId), up
            ? { votesUphold: (market.votesUphold || 0) + 1, lastVoteId: voteId }
            : { votesOverturn: (market.votesOverturn || 0) + 1, lastVoteId: voteId });
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    /** Anyone may call it. No-op on an already final market; throws when nothing can be finalized yet. Returns the market. */
    async finalizeMarket(marketId) {
      try {
        await requireOpen();
        return await txRun(async (tx) => {
          const mSnap = await tx.get(marketRef(marketId));
          const market = { ...need(mSnap, 'Market'), id: marketId };
          if (isFinal(market)) return market;
          const out = economy.finalizeOutcome(market, decisionNow());
          if (!out) throw new Error("This market can't be finalized yet.");
          const patch = clean({
            status: out.status, resolvedOptionId: out.resolvedOptionId ?? null, resolvedAt: nowFn(), eventAt: out.eventAt ?? null,
          });
          tx.update(marketRef(marketId), patch);
          return { ...market, ...patch };
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async voidMarket(marketId) {
      try {
        const uid = await requireOpen();
        await txRun(async (tx) => {
          const market = { ...need(await tx.get(marketRef(marketId)), 'Market'), id: marketId };
          if (market.type !== 'custom' || market.createdBy !== uid) throw new Error('Only the creator can void this market.');
          if (market.status !== 'open') throw new Error('This market can no longer be voided.');
          if (market.betCount !== 0) throw new Error("Bets have been placed, so this market can't be voided.");
          tx.update(marketRef(marketId), { status: 'void', resolvedOptionId: null, resolvedAt: nowFn(), eventAt: null });
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    // ---------------------------------------------------------------- claims
    async claimBet(betId) {
      try {
        const uid = await requireOpen();
        return await txRun(async (tx) => {
          const bSnap = await tx.get(betRef(betId));
          const bet = { ...need(bSnap, 'Bet'), id: betId };
          if (bet.uid !== uid) throw new Error("That's not your bet.");
          if (bet.status !== 'open') throw new Error('This bet has already been claimed.');
          const [mSnap, pSnap] = await Promise.all([tx.get(marketRef(bet.marketId)), tx.get(playerRef(uid))]);
          const market = mSnap.exists() ? { ...mSnap.data(), id: bet.marketId } : null;
          if (!isFinal(market)) throw new Error('This market has not been settled yet.');
          const player = { ...need(pSnap, 'Your profile'), uid };
          const now = nowFn();
          const res = economy.betClaim(bet, market, player, now);
          const patch = { status: res.status, payout: res.payout, taxed: res.taxed, claimedAt: now };
          tx.update(betRef(betId), patch);
          tx.update(playerRef(uid), {
            balance: player.balance + res.payout,
            openStake: (player.openStake || 0) - bet.amount,
            totalWon: (player.totalWon || 0) + (res.status === 'won' ? res.payout : 0),
            lastClaimId: betId,
          });
          return { ...bet, ...patch };
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    /** Returns the amount paid out (0 for the loser of a dispute; the paid flag is still set). */
    async claimBond(marketId) {
      try {
        const uid = await requireOpen();
        return await txRun(async (tx) => {
          const [mSnap, pSnap] = await Promise.all([tx.get(marketRef(marketId)), tx.get(playerRef(uid))]);
          const market = { ...need(mSnap, 'Market'), id: marketId };
          if (!isFinal(market)) throw new Error('This market has not been settled yet.');
          const player = { ...need(pSnap, 'Your profile'), uid };
          const owed = economy.bondClaims(market);
          let amount;
          let flag;
          if (market.reportedBy === uid) {
            if (market.reporterBondPaid) throw new Error('Your bond has already been paid out.');
            amount = owed.reporter;
            flag = 'reporterBondPaid';
          } else if (market.challengedBy === uid) {
            if (market.challengerBondPaid) throw new Error('Your bond has already been paid out.');
            amount = owed.challenger;
            flag = 'challengerBondPaid';
          } else {
            throw new Error("You didn't put up a bond on this market.");
          }
          tx.update(marketRef(marketId), { [flag]: true });
          if (amount > 0) tx.update(playerRef(uid), { balance: player.balance + amount, lastBondMarketId: marketId });
          return amount;
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async markBrokeIfNeeded() {
      try {
        const uid = await requireOpen();
        return await txRun(async (tx) => {
          const player = { ...need(await tx.get(playerRef(uid)), 'Your profile'), uid };
          if (player.brokeSince != null || !economy.isBroke(player)) return false;
          tx.update(playerRef(uid), { brokeSince: nowFn() });
          return true;
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async claimRestart() {
      try {
        const uid = await requireOpen();
        await txRun(async (tx) => {
          const player = { ...need(await tx.get(playerRef(uid)), 'Your profile'), uid };
          if (!economy.canClaimRestart(player, decisionNow())) {
            if (!economy.isBroke(player)) throw new Error("You're not broke.");
            if (player.brokeSince == null) throw new Error("You haven't been marked as broke yet — try again in a moment.");
            throw new Error('Come back after midnight UTC to claim your bailout.');
          }
          const p = economy.restartPatch(player, nowFn());
          tx.update(playerRef(uid), clean({
            balance: p.balance, bankruptcies: p.bankruptcies, brokeSince: p.brokeSince, penaltyUntil: p.penaltyUntil,
          }));
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    /** Finalizes what it can, claims my settled bets and bonds, marks me broke. Never throws. */
    runHousekeeping() {
      if (housekeeping) return housekeeping;
      housekeeping = (async () => {
        const result = { finalized: 0, claimed: 0, bonds: 0 };
        try {
          await whenAuthReady();
          const u = auth.currentUser;
          if (!u || (await ensureGate()) !== 'open') return result;
          const uid = u.uid;
          const attempt = async (fn) => { try { return await fn(); } catch { return undefined; } };

          // 1. finalize whatever the clock says is finalizable
          const live = (await attempt(() => fetchMarkets(['open', 'reported', 'challenged']))) || [];
          const t = decisionNow();
          for (const m of live) {
            if (economy.finalizeOutcome(m, t) && await attempt(() => store.finalizeMarket(m.id))) result.finalized++;
          }

          // 2. claim my open bets on final markets
          const betsSnap = await attempt(() => getDocs(query(collection(db, 'bets2'), where('uid', '==', uid), where('status', '==', 'open'))));
          const marketCache = new Map();
          const marketOf = async (id) => {
            if (!marketCache.has(id)) {
              const s = await attempt(() => getDoc(marketRef(id)));
              marketCache.set(id, s && s.exists() ? { ...s.data(), id } : null);
            }
            return marketCache.get(id);
          };
          for (const d of (betsSnap ? betsSnap.docs : [])) {
            const m = await marketOf(d.data().marketId);
            if (isFinal(m) && await attempt(() => store.claimBet(d.id))) result.claimed++;
          }

          // 3. claim bonds I am owed
          const mine = new Map();
          for (const field of ['reportedBy', 'challengedBy']) {
            const s = await attempt(() => getDocs(query(collection(db, 'markets2'), where(field, '==', uid))));
            for (const d of (s ? s.docs : [])) mine.set(d.id, { ...d.data(), id: d.id });
          }
          for (const m of mine.values()) {
            if (!isFinal(m)) continue;
            const owed = economy.bondClaims(m);
            const due = (m.reportedBy === uid && !m.reporterBondPaid && owed.reporter > 0)
              || (m.challengedBy === uid && !m.challengerBondPaid && owed.challenger > 0);
            if (due && await attempt(() => store.claimBond(m.id)) !== undefined) result.bonds++;
          }

          // 4. bankruptcy flag
          await attempt(() => store.markBrokeIfNeeded());
        } catch { /* housekeeping never throws */ }
        return result;
      })().finally(() => { housekeeping = null; });
      return housekeeping;
    },

    // ---------------------------------------------------------------- admin
    async claimAdmin(code) {
      try {
        code = String(code ?? '');
        await whenAuthReady();
        const u = auth.currentUser;
        if (!u) throw new Error('Sign in (or sign up) first, then enter the admin code.');
        const uid = u.uid;
        if ((await getDoc(configRef)).exists()) throw new Error('Admin has already been claimed.');
        // The code goes to the write-only app/claim doc (never into the public config); the rules hash it.
        const batch = writeBatch(db);
        batch.set(claimRef, { code });
        batch.set(configRef, { adminUid: uid, maintenance: true, updatedAt: nowFn() });
        try {
          await batch.commit();
        } catch (e) {
          if (isPermissionDenied(e)) {
            if ((await getDoc(configRef)).exists()) throw new Error('Admin has already been claimed.');
            throw new Error("That's not the admin code.");
          }
          throw e;
        }
        // Housekeeping after the fact: wipe the plaintext code, and make sure the admin can play right away.
        try { await deleteDoc(claimRef); } catch { /* the doc is unreadable for everyone anyway */ }
        try {
          const name = profileNameFor(u);
          if (name) await claimProfile(uid, name);
        } catch (err) {
          console.warn('Admin profile will be created on next sign-in', err);
        }
      } catch (e) {
        throw toUserError(e);
      }
    },

    async setMaintenance(on) {
      try {
        const uid = await requireUid();
        const snap = await getDoc(configRef);
        if (!snap.exists() || snap.data().adminUid !== uid) throw new Error('Only the admin can do that.');
        await updateDoc(configRef, { maintenance: !!on, updatedAt: nowFn() });
      } catch (e) {
        if (isPermissionDenied(e)) throw new Error('Only the admin can do that.');
        throw toUserError(e);
      }
    },

    async banPlayer(targetUid, reason = '') {
      try {
        const uid = await requireUid();
        const cfg = await getDoc(configRef);
        if (!cfg.exists() || cfg.data().adminUid !== uid) throw new Error('Only the admin can do that.');
        if (targetUid === cfg.data().adminUid) throw new Error("You can't ban the admin.");
        const p = await getDoc(playerRef(targetUid));
        if (!p.exists()) throw new Error('Player not found.');
        await setDoc(banRef(targetUid), {
          uid: targetUid, username: p.data().username, by: uid, at: nowFn(), reason: String(reason ?? '').slice(0, 200),
        });
      } catch (e) {
        if (isPermissionDenied(e)) throw new Error('Only the admin can do that.');
        throw toUserError(e);
      }
    },

    async unbanPlayer(targetUid) {
      try {
        const uid = await requireUid();
        const cfg = await getDoc(configRef);
        if (!cfg.exists() || cfg.data().adminUid !== uid) throw new Error('Only the admin can do that.');
        await deleteDoc(banRef(targetUid));
      } catch (e) {
        if (isPermissionDenied(e)) throw new Error('Only the admin can do that.');
        throw toUserError(e);
      }
    },

    /** Test helper: stop every listener and shut the SDK instance down. Not part of the Store API. */
    async _dispose() {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      bus.clear();
      sessionCbs.clear();
      if (unsubConfig) unsubConfig();
      if (unsubBan) unsubBan();
      if (unsubAuthWatch) unsubAuthWatch();
      try { if (terminate) await terminate(db); } catch { /* ignore */ }
      try { if (deleteApp) await deleteApp(app); } catch { /* ignore */ }
    },
  };

  return store;
}

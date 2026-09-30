// Firebase (Auth + Firestore) backend for Sonnetous. Implements the store API from SPEC.md.
// Firebase modular SDK is loaded lazily from the gstatic CDN.
import * as economy from '../economy.js';

const FB_VERSION = '10.12.2';
const FB_BASE = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_DOMAIN = 'users.sonnetous.app';
const MAX_SETTLE_ATTEMPTS = 4;

// Plain-JSON deep clone. Also strips `undefined` values, which Firestore rejects.
const clean = (x) => JSON.parse(JSON.stringify(x));

class StaleBetsError extends Error {}

const isPermissionDenied = (e) => !!e && (e.code === 'permission-denied' || e.code === 'firestore/permission-denied');

// When two clients race (e.g. both resolve the same market) the loser's commit is evaluated by the
// rules against the winner's result and comes back as permission-denied rather than a retryable
// conflict. Run the operation once more: it re-reads fresh data, so the user gets the real reason
// ("already settled", "betting closed", ...). A genuine rules failure fails again and is reported.
async function retryOnceIfDenied(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isPermissionDenied(e)) throw e;
    return fn();
  }
}

function toUserError(e) {
  if (!e) return new Error('Something went wrong.');
  // Firebase SDK errors carry `code` ('auth/...' or a Firestore code such as 'permission-denied').
  const raw = typeof e.code === 'string' ? e.code : '';
  const code = raw.startsWith('firestore/') ? raw.slice('firestore/'.length) : raw;
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
      return new Error('Permission denied by the database. Make sure firestore.rules is published and you are logged in.');
    case 'unauthenticated':
      return new Error('You need to be logged in.');
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
 *   sdk      { app, auth, firestore }  SDK modules to use instead of the gstatic CDN imports
 *   emulator { authUrl, firestoreHost, firestorePort }  connect to the local emulators
 *   appName  name for initializeApp (lets one process host several independent clients)
 *   now      () => ms clock (defaults to Date.now)
 */
export async function createFirebaseStore(config, opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const [appMod, authMod, fsMod] = opts.sdk
    ? [opts.sdk.app, opts.sdk.auth, opts.sdk.firestore]
    : await Promise.all([
      import(FB_BASE + 'firebase-app.js'),
      import(FB_BASE + 'firebase-auth.js'),
      import(FB_BASE + 'firebase-firestore.js'),
    ]);
  const { initializeApp } = appMod;
  const {
    getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
    signOut: fbSignOut, updateProfile, deleteUser, connectAuthEmulator,
  } = authMod;
  const {
    getFirestore, doc, collection, query, where, orderBy, onSnapshot, getDoc, getDocs,
    runTransaction, connectFirestoreEmulator,
  } = fsMod;

  const app = opts.appName ? initializeApp(config, opts.appName) : initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (opts.emulator) {
    connectAuthEmulator(auth, opts.emulator.authUrl, { disableWarnings: true });
    connectFirestoreEmulator(db, opts.emulator.firestoreHost, opts.emulator.firestorePort);
  }
  // Web SDK default is 5 attempts; a busy market (many simultaneous bets) can need more.
  const txOpts = { maxAttempts: 12 };
  const inTx = (fn) => runTransaction(db, fn, txOpts);

  const emailFor = (lower) => `${lower}@${EMAIL_DOMAIN}`;
  const userRef = (uid) => doc(db, 'users', uid);
  const marketRef = (id) => doc(db, 'markets', id);
  const betRef = (id) => doc(db, 'bets', id);
  const usernameRef = (lower) => doc(db, 'usernames', lower);

  let signingUp = false;

  async function whenAuthReady() {
    if (typeof auth.authStateReady === 'function') await auth.authStateReady();
  }

  async function requireUid() {
    await whenAuthReady();
    const u = auth.currentUser;
    if (!u) throw new Error('You need to be logged in.');
    return u.uid;
  }

  // Idempotently create users/{uid} + usernames/{lower}. Used by signUp and to repair
  // an account whose profile doc is missing (e.g. sign-up was interrupted).
  async function claimProfile(uid, username) {
    const lower = username.toLowerCase();
    return inTx(async (tx) => {
      const uRef = userRef(uid);
      const nRef = usernameRef(lower);
      const [uSnap, nSnap] = await Promise.all([tx.get(uRef), tx.get(nRef)]);
      if (uSnap.exists()) return uSnap.data();
      if (nSnap.exists() && nSnap.data().uid !== uid) {
        throw new Error('That username is already taken.');
      }
      const user = clean(economy.newUser(uid, username, nowFn()));
      if (!nSnap.exists()) tx.set(nRef, { uid });
      tx.set(uRef, user);
      return user;
    });
  }

  // Fetch bet docs (ids + data) for a market, outside any transaction.
  async function fetchMarketBetIds(marketId) {
    const snap = await getDocs(query(collection(db, 'bets'), where('marketId', '==', marketId)));
    return snap.docs.map((d) => d.id);
  }

  // Core settlement flow shared by resolve / void / auto-resolve.
  // decide(market, actor) runs inside the transaction on fresh data and returns either
  //   { skip: true }                                            -> do nothing (market no longer open)
  //   { action: 'settle', optionId, eventAt, resolvedBy }
  //   { action: 'void', resolvedBy }
  // It may throw an Error with a user-facing message.
  // actorUid may be null (auto-resolve with no logged-in user).
  function settleFlow(marketId, actorUid, decide) {
    return retryOnceIfDenied(() => settleAttempts(marketId, actorUid, decide));
  }

  async function settleAttempts(marketId, actorUid, decide) {
    for (let attempt = 0; attempt < MAX_SETTLE_ATTEMPTS; attempt++) {
      const betIds = await fetchMarketBetIds(marketId);
      try {
        return await inTx(async (tx) => {
          const mRef = marketRef(marketId);
          // ---- all reads first ----
          const reads = [tx.get(mRef), ...betIds.map((id) => tx.get(betRef(id)))];
          if (actorUid) reads.push(tx.get(userRef(actorUid)));
          const snaps = await Promise.all(reads);
          const mSnap = snaps[0];
          if (!mSnap.exists()) throw new Error('Market not found.');
          const market = mSnap.data();
          const betSnaps = snaps.slice(1, 1 + betIds.length);
          const actor = actorUid ? (snaps[snaps.length - 1].exists() ? snaps[snaps.length - 1].data() : null) : null;

          const now = nowFn();
          const decision = decide(market, actor, now);
          if (decision.skip) return;

          const bets = betSnaps.filter((s) => s.exists()).map((s) => ({ ...s.data(), id: s.id }));
          // A bet placed after our query bumped betCount (bet + market are written atomically), so
          // fewer bets than betCount means our query was stale: retry with a fresh one.
          if (typeof market.betCount === 'number' && bets.length < market.betCount) {
            throw new StaleBetsError('bets changed');
          }

          const uids = [...new Set(bets.map((b) => b.uid))];
          const userSnaps = await Promise.all(uids.map((uid) => tx.get(userRef(uid))));
          const usersById = {};
          const existing = new Set();
          uids.forEach((uid, i) => {
            const s = userSnaps[i];
            if (s.exists()) {
              usersById[uid] = s.data();
              existing.add(uid);
            } else {
              usersById[uid] = { uid, username: '?', balance: 0, penaltyUntil: null, totalWon: 0 };
            }
          });

          // ---- compute (pure) ----
          const result = decision.action === 'void'
            ? economy.voidMarket(market, bets, now, decision.resolvedBy)
            : economy.settleMarket(
              market, bets, decision.optionId, usersById, now, decision.resolvedBy, decision.eventAt ?? null,
            );

          // ---- writes ----
          tx.update(mRef, clean(result.marketPatch));
          for (const [betId, patch] of Object.entries(result.betPatches || {})) {
            tx.update(betRef(betId), clean(patch));
          }
          for (const [uid, delta] of Object.entries(result.userDeltas || {})) {
            if (!existing.has(uid)) continue;
            const cur = usersById[uid];
            const patch = {};
            for (const [k, v] of Object.entries(delta)) patch[k] = (cur[k] || 0) + v;
            tx.update(userRef(uid), patch);
          }
        });
      } catch (e) {
        if (e instanceof StaleBetsError && attempt < MAX_SETTLE_ATTEMPTS - 1) continue;
        if (e instanceof StaleBetsError) {
          throw new Error('Bets were still coming in. Please try again.');
        }
        throw e;
      }
    }
  }

  async function fetchUserBets(uid) {
    const snap = await getDocs(query(collection(db, 'bets'), where('uid', '==', uid)));
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  }

  // Snapshot-listener error handler. After sign-out Firestore may report permission-denied to
  // listeners that have not been unsubscribed yet; that is expected, so stay quiet then.
  const listenError = (label) => (err) => {
    if (!auth.currentUser) return;
    console.error(`${label} listener error`, err);
  };

  // Username for an authenticated account: displayName, or (if updateProfile failed during
  // sign-up) the lowercased name embedded in the synthetic email.
  function profileNameFor(fbUser) {
    if (fbUser.displayName && USERNAME_RE.test(fbUser.displayName)) return fbUser.displayName;
    const local = String(fbUser.email || '').split('@')[0];
    return USERNAME_RE.test(local) ? local : null;
  }

  const store = {
    async init() {
      await whenAuthReady();
      return { mode: 'firebase' };
    },

    onAuthChange(cb) {
      let unsubProfile = null;
      let repairingFor = null;
      const stopProfile = () => { if (unsubProfile) { unsubProfile(); unsubProfile = null; } };
      // Used when we are authenticated but cannot get a usable profile: signing out makes the
      // Auth listener report null, which takes the UI back to the login screen (no dead spinner).
      const giveUp = (why, err) => {
        console.error(why, err);
        fbSignOut(auth).catch(() => {});
      };
      const unsubAuth = onAuthStateChanged(auth, (fbUser) => {
        stopProfile();
        repairingFor = null;
        if (!fbUser) { cb(null); return; }
        let delivered = false;
        const uid = fbUser.uid;
        unsubProfile = onSnapshot(
          userRef(uid),
          (snap) => {
            if (snap.exists()) {
              delivered = true;
              cb({ ...snap.data(), uid: snap.id });
              return;
            }
            // Profile doc missing. During sign-up it's about to be created (stay silent, the UI
            // must not see a transient null); otherwise try to repair it.
            if (signingUp || repairingFor === uid) return;
            const name = profileNameFor(fbUser);
            if (!name) { giveUp('Account has no usable username', null); return; }
            repairingFor = uid;
            claimProfile(uid, name).catch((err) => giveUp('Could not create profile', err));
          },
          (err) => {
            // Errors while signing out (permission-denied on a dying session) are expected.
            if (!auth.currentUser || auth.currentUser.uid !== uid) return;
            if (!delivered) giveUp('Profile listener error', err);
            else console.error('Profile listener error', err);
          },
        );
      });
      return () => { unsubAuth(); stopProfile(); };
    },

    async signUp(username, password) {
      try {
        username = String(username ?? '').trim();
        password = String(password ?? '');
        if (!USERNAME_RE.test(username)) {
          throw new Error('Username must be 3–20 characters: letters, numbers and underscores only.');
        }
        if (password.length < 6) throw new Error('Password must be at least 6 characters.');
        const lower = username.toLowerCase();
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
          const user = await claimProfile(cred.user.uid, username);
          signingUp = false;
          return { ...user, uid: cred.user.uid };
        } catch (e) {
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
        const lower = username.toLowerCase();
        const cred = await signInWithEmailAndPassword(auth, emailFor(lower), password);
        const uid = cred.user.uid;
        const snap = await getDoc(userRef(uid));
        if (snap.exists()) return { ...snap.data(), uid };
        const name = profileNameFor(cred.user) || username;
        const user = await claimProfile(uid, name);
        return { ...user, uid };
      } catch (e) {
        throw toUserError(e);
      }
    },

    async signOut() {
      try { await fbSignOut(auth); } catch (e) { throw toUserError(e); }
    },

    subscribeUsers(cb) {
      return onSnapshot(
        collection(db, 'users'),
        (snap) => cb(snap.docs.map((d) => ({ ...d.data(), uid: d.id }))),
        listenError('users'),
      );
    },

    subscribeMarkets(cb) {
      return onSnapshot(
        query(collection(db, 'markets'), orderBy('openedAt', 'desc')),
        (snap) => cb(snap.docs.map((d) => ({ ...d.data(), id: d.id }))),
        listenError('markets'),
      );
    },

    subscribeBets(cb) {
      return onSnapshot(
        query(collection(db, 'bets'), orderBy('placedAt', 'desc')),
        (snap) => cb(snap.docs.map((d) => ({ ...d.data(), id: d.id }))),
        listenError('bets'),
      );
    },

    async ensureMarkets(markets) {
      try {
        await requireUid();
        const list = (markets || []).filter((m) => m && m.id);
        if (!list.length) return;
        await retryOnceIfDenied(() => inTx(async (tx) => {
          const snaps = await Promise.all(list.map((m) => tx.get(marketRef(m.id))));
          list.forEach((m, i) => {
            if (!snaps[i].exists()) tx.set(marketRef(m.id), clean(m));
          });
        }));
      } catch (e) {
        throw toUserError(e);
      }
    },

    async createMarket(market) {
      try {
        const uid = await requireUid();
        if (!market || typeof market !== 'object') throw new Error('Invalid market.');
        const m = clean(market);
        if (!m.id) m.id = 'custom-' + doc(collection(db, 'markets')).id;
        if (m.createdBy !== uid) throw new Error('You can only create markets as yourself.');
        await retryOnceIfDenied(() => inTx(async (tx) => {
          const snap = await tx.get(marketRef(m.id));
          if (snap.exists()) throw new Error('A market with that id already exists.');
          tx.set(marketRef(m.id), m);
        }));
        return m.id;
      } catch (e) {
        throw toUserError(e);
      }
    },

    async placeBet(marketId, optionId, amount) {
      try {
        const uid = await requireUid();
        amount = Number(amount);
        const newBetId = doc(collection(db, 'bets')).id;
        return await retryOnceIfDenied(() => inTx(async (tx) => {
          const mRef = marketRef(marketId);
          const uRef = userRef(uid);
          const [mSnap, uSnap] = await Promise.all([tx.get(mRef), tx.get(uRef)]);
          if (!mSnap.exists()) throw new Error('Market not found.');
          if (!uSnap.exists()) throw new Error('Your profile was not found.');
          const market = mSnap.data();
          const user = uSnap.data();
          const now = nowFn();
          const err = economy.validateBet(user, market, optionId, amount, now);
          if (err) throw new Error(err);
          const bet = clean(economy.buildBet({ id: newBetId, market, user, optionId, amount, now }));
          const patch = economy.applyBetToMarket(market, optionId, amount);
          tx.set(betRef(newBetId), bet);
          tx.update(mRef, clean(patch));
          tx.update(uRef, {
            balance: user.balance - amount,
            totalWagered: (user.totalWagered || 0) + amount,
          });
          return bet;
        }));
      } catch (e) {
        throw toUserError(e);
      }
    },

    async resolveMarket(marketId, optionId, eventAt = null) {
      try {
        const uid = await requireUid();
        await settleFlow(marketId, uid, (market, actor, now) => {
          if (!actor) throw new Error('Your profile was not found.');
          if (market.status !== 'open') throw new Error('This market has already been settled.');
          if (market.type === 'custom' && market.createdBy !== uid) {
            throw new Error('Only the creator can resolve this market.');
          }
          let winner = optionId ?? null;
          let evt = null;
          if (market.kind === 'timer' && eventAt !== null && eventAt !== undefined) {
            evt = Number(eventAt);
            if (!Number.isFinite(evt)) throw new Error('Invalid event time.');
            if (evt > now) throw new Error("The event can't be in the future.");
            winner = economy.timerBucketFor(market, evt);
          }
          if (winner === null || !(market.options || []).some((o) => o.id === winner)) {
            throw new Error('Pick a valid winning option.');
          }
          return { action: 'settle', optionId: winner, eventAt: evt, resolvedBy: actor.username };
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async autoResolveExpired() {
      try {
        await whenAuthReady();
        if (!auth.currentUser) return;
        const snap = await getDocs(query(collection(db, 'markets'), where('status', '==', 'open')));
        const now = nowFn();
        const due = snap.docs
          .map((d) => ({ ...d.data(), id: d.id }))
          .filter((m) => m.kind === 'timer' && economy.timerAutoResolution(m, now));
        for (const m of due) {
          try {
            await settleFlow(m.id, null, (market, _actor, t) => {
              if (market.status !== 'open' || market.kind !== 'timer') return { skip: true };
              const winner = economy.timerAutoResolution(market, t);
              if (!winner) return { skip: true };
              return { action: 'settle', optionId: winner, eventAt: null, resolvedBy: 'auto' };
            });
          } catch (e) {
            console.warn('Auto-resolve failed for', m.id, e);
          }
        }
      } catch (e) {
        throw toUserError(e);
      }
    },

    async voidMarket(marketId) {
      try {
        const uid = await requireUid();
        await settleFlow(marketId, uid, (market, actor) => {
          if (!actor) throw new Error('Your profile was not found.');
          if (market.createdBy !== uid) throw new Error('Only the creator can void this market.');
          if (market.status !== 'open') throw new Error('This market has already been settled.');
          return { action: 'void', resolvedBy: actor.username };
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async markBrokeIfNeeded() {
      try {
        await whenAuthReady();
        const fbUser = auth.currentUser;
        if (!fbUser) return;
        const uid = fbUser.uid;
        const uSnap = await getDoc(userRef(uid));
        if (!uSnap.exists() || uSnap.data().brokeSince || !(uSnap.data().balance < 1)) return;
        const bets = await fetchUserBets(uid);
        await inTx(async (tx) => {
          const snap = await tx.get(userRef(uid));
          if (!snap.exists()) return;
          const user = snap.data();
          if (user.brokeSince) return;
          if (economy.isBroke(user, bets)) {
            tx.update(userRef(uid), { brokeSince: economy.dayKey(nowFn()) });
          }
        });
      } catch (e) {
        throw toUserError(e);
      }
    },

    async claimRestart() {
      try {
        const uid = await requireUid();
        const bets = await fetchUserBets(uid);
        await inTx(async (tx) => {
          const snap = await tx.get(userRef(uid));
          if (!snap.exists()) throw new Error('Your profile was not found.');
          const user = snap.data();
          const now = nowFn();
          if (!economy.canClaimRestart(user, bets, now)) {
            if (!economy.isBroke(user, bets)) throw new Error("You're not broke.");
            throw new Error('Come back tomorrow to claim your bailout.');
          }
          tx.update(userRef(uid), clean(economy.restartPatch(user, now)));
        });
      } catch (e) {
        throw toUserError(e);
      }
    },
  };

  return store;
}

// Sonnetous UI entry point. Every module is dynamically imported inside boot() so a load failure ends up
// on a readable error screen instead of a blank page.
//
// Screens: boot → gate (maintenance / banned) | auth | app.  Gate decisions use store.subscribeConfig
// (works signed out), store.onSessionChange (the signed-in account, whatever the gate says),
// store.subscribeMyBan and store.onAuthChange (the Player, only when the game is open to us).
import {
  $, esc, errMsg, toast, startTicker, openDialog, closeDialog, confirmDialog, confetti, bump, money,
  avatarHtml, countdown, withBusy,
} from './ui/util.js';

const state = {
  mode: 'local',
  config: null,          // { exists, maintenance, adminUid } once known
  session: undefined,    // undefined = unknown, null = signed out, { uid, username }
  player: null,          // Player (only while the game is open to us)
  ban: null,
  banLoaded: false,
  players: [],
  markets: [],
  bets: [],
  myVotes: new Set(),
  bans: [],
  loaded: { players: false, markets: false, bets: false },
  tab: 'markets',
  oracle: new Map(),     // marketId -> { status, result, error, fetchedAt, reportTried, challengeTried, mismatch }
};

let E, T, O, store, gateUi, marketsUi, viewsUi, modelUi;
let views = {};
let sheet = null;
let screen = 'boot';
let authMode = 'signin';

// ------------------------------------------------------------------ boot
boot();

async function boot() {
  try {
    const [economy, templates, storeMod, util, model, marketsMod, viewsMod, gateMod] = await Promise.all([
      import('./economy.js'),
      import('./templates.js'),
      import('./store/index.js'),
      import('./ui/util.js'),
      import('./ui/model.js'),
      import('./ui/markets.js'),
      import('./ui/views.js'),
      import('./ui/gate.js'),
    ]);
    void util;
    // Oracles are an enhancement: if the module is missing or broken, the rest still works.
    O = await import('./oracles.js').catch((e) => { console.warn('oracles unavailable:', e && e.message); return null; });
    E = economy;
    T = templates;
    modelUi = model;
    marketsUi = marketsMod;
    viewsUi = viewsMod;
    gateUi = gateMod;
    modelUi.initModel(E, T);

    store = typeof storeMod.getStore === 'function' ? await storeMod.getStore() : storeMod.store;
    if (!store) throw new Error('No storage backend was returned by js/store/index.js');
    const info = await store.init();
    state.mode = (info && info.mode) || 'local';

    const ctx = makeCtx();
    views = {
      markets: marketsUi.createMarketsView($('panel-markets'), ctx),
      create: viewsUi.createCreateView($('panel-create'), ctx),
      mybets: viewsUi.createMyBetsView($('panel-mybets'), ctx),
      leaderboard: viewsUi.createLeaderboardView($('panel-leaderboard'), ctx),
      activity: viewsUi.createActivityView($('panel-activity'), ctx),
      admin: viewsUi.createAdminView($('panel-admin'), ctx),
    };
    sheet = marketsUi.createSheet($('sheet'), ctx);
    wireShell(ctx);
    startTicker(scheduleRender);

    $('auth-local').hidden = state.mode !== 'local';
    $('pill-local').hidden = state.mode !== 'local';
    $('hero-cards').innerHTML = marketsUi.heroCardsHtml();

    store.subscribeConfig((cfg) => {
      state.config = {
        exists: !!(cfg && cfg.exists),
        maintenance: cfg ? cfg.maintenance !== false : true,
        adminUid: (cfg && cfg.adminUid) || null,
      };
      scheduleRender();
    });
    if (typeof store.onSessionChange === 'function') {
      store.onSessionChange((s) => onSession(s && s.uid ? { uid: s.uid, username: s.username || '' } : null));
    }
    store.onAuthChange((p) => {
      state.player = p || null;
      if (typeof store.onSessionChange !== 'function') {
        // older store without session info: the player is all we know
        onSession(p ? { uid: p.uid, username: p.username } : null);
      }
      scheduleRender();
    });
  } catch (err) {
    showFatal(err);
  }
}

function showFatal(err) {
  console.error(err);
  for (const id of ['boot', 'auth', 'app', 'gate']) $(id).hidden = true;
  $('fatal').hidden = false;
  $('fatal-msg').textContent = err && err.message ? String(err.message) : String(err);
}

window.addEventListener('unhandledrejection', (e) => {
  console.warn('unhandled rejection:', e.reason);
  toast(errMsg(e.reason), 'error');
  e.preventDefault();
});

// ------------------------------------------------------------------ context shared with views
function makeCtx() {
  return {
    state,
    get E() { return E; },
    get T() { return T; },
    get O() { return O; },
    get store() { return store; },
    now: () => Date.now(),
    me: () => state.player,
    isAdmin: () => isAdmin(),
    rerender: scheduleRender,
    setTab,
    openMarket: (id, opener) => sheet && sheet.open(id, opener),
    derived,
    oracleInfo: (id) => state.oracle.get(id) || null,
    challengeFromOracle: (m, btn) => challengeMarket(m, btn),
    celebrateBet,
  };
}

let derivedCache = null;
let derivedKey = null;
/** Indexes rebuilt only when the underlying arrays change. */
function derived() {
  const key = [state.markets, state.bets, state.players, state.player, state.myVotes];
  if (derivedCache && derivedKey && key.every((v, i) => v === derivedKey[i])) return derivedCache;
  const me = state.player;
  const marketsById = new Map(state.markets.map((m) => [m.id, m]));
  const betsByMarket = new Map();
  const myBets = [];
  const myBetsByMarket = new Map();
  for (const b of state.bets) {
    if (!betsByMarket.has(b.marketId)) betsByMarket.set(b.marketId, []);
    betsByMarket.get(b.marketId).push(b);
    if (me && b.uid === me.uid) {
      myBets.push(b);
      if (!myBetsByMarket.has(b.marketId)) myBetsByMarket.set(b.marketId, []);
      myBetsByMarket.get(b.marketId).push(b);
    }
  }
  const playersById = new Map(state.players.map((p) => [p.uid, p]));
  derivedKey = key;
  derivedCache = { marketsById, betsByMarket, myBets, myBetsByMarket, playersById, myVotes: state.myVotes };
  return derivedCache;
}

function isAdmin() {
  const s = state.session;
  return !!(s && state.config && state.config.adminUid && state.config.adminUid === s.uid);
}

// ------------------------------------------------------------------ shell wiring
function wireShell(ctx) {
  $('btn-reload').addEventListener('click', () => location.reload());
  document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
  $('brand-home').addEventListener('click', (e) => { e.preventDefault(); setTab('markets'); });

  // auth
  document.querySelectorAll('[data-auth-mode]').forEach((btn) => btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode)));
  $('auth-form').addEventListener('submit', onAuthSubmit);

  // how it works (any [data-open-how], including ones rendered later)
  document.addEventListener('click', (e) => {
    const how = e.target.closest('[data-open-how]');
    if (how) { e.preventDefault(); openHow(how); }
  });

  // profile menu
  $('btn-profile').addEventListener('click', (e) => openProfile(e.currentTarget));
  $('h-wallet').addEventListener('click', (e) => openProfile(e.currentTarget));

  // bailout (banner is re-rendered, so delegate)
  $('banner').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action=claim-restart]');
    if (!btn) return;
    try {
      await withBusy(btn, () => store.claimRestart());
      toast(`Bailout claimed: ${money(E.RESTART_BALANCE)}. The house always wins, eventually. 💀`, 'success', '🪙');
      bump($('h-wallet'));
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  });

  // gate screen (maintenance / banned / repair) is rendered by ui/gate.js, which calls back here
  gateUi.wireGate($('gate'), {
    get store() { return store; },
    state,
    rerender: scheduleRender,
    isMaintenanceError,
  });
  void ctx;
}

function isMaintenanceError(err) {
  return /maintenance/i.test(errMsg(err));
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('[data-auth-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.authMode === mode)));
  const form = $('auth-form');
  form.elements.password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('auth-submit').textContent = mode === 'signup' ? 'Create account · get §500' : 'Log in';
  $('auth-hint').hidden = mode !== 'signup';
  $('auth-error').hidden = true;
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  const errEl = $('auth-error');
  const submit = $('auth-submit');
  errEl.hidden = true;
  if (!username || !password) {
    errEl.textContent = 'Enter a username and password.';
    errEl.hidden = false;
    return;
  }
  try {
    await withBusy(submit, () => (authMode === 'signup' ? store.signUp(username, password) : store.signIn(username, password)));
    form.reset();
    if (authMode === 'signup') toast(`Welcome, ${username}! Here's ${money(E.STARTING_BALANCE)}. Don't spend it all at once.`, 'success', '🎰');
  } catch (err) {
    if (isMaintenanceError(err)) { form.reset(); scheduleRender(); return; } // the gate screen explains it
    errEl.textContent = errMsg(err);
    errEl.hidden = false;
  }
}

function openHow(opener) {
  const dlg = $('how');
  dlg.innerHTML = viewsUi.howHtml(E);
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  openDialog(dlg, opener);
}

function openProfile(opener) {
  const dlg = $('profile');
  const p = state.player;
  if (!p) return;
  const now = Date.now();
  const skulls = Number(p.bankruptcies) || 0;
  dlg.innerHTML = `
    <div class="modal-body">
      <button type="button" class="icon-btn modal-close" data-close aria-label="Close">✕</button>
      <div class="row" style="gap:12px">
        ${avatarHtml(p.username, 'avatar-lg')}
        <div class="grow"><h2 id="profile-title" class="ellipsis">${esc(p.username)}</h2>
          <div class="tiny muted">${isAdmin() ? '🛡️ Admin · ' : ''}${state.mode === 'local' ? 'Local mode' : 'Online'}</div></div>
      </div>
      <dl class="kv">
        <div><dt>Balance</dt><dd class="gold">${esc(money(p.balance))}</dd></div>
        <div><dt>In play</dt><dd>${esc(money(p.openStake || 0))}</dd></div>
        <div><dt>Net worth</dt><dd>${esc(money(E.netWorth(p)))}</dd></div>
        <div><dt>Bankruptcies</dt><dd>${skulls ? '💀'.repeat(Math.min(skulls, 5)) + (skulls > 5 ? `×${skulls}` : '') : 'None'}</dd></div>
      </dl>
      ${E.penaltyActive(p, now) ? `<div class="notice notice-loss"><span class="n-ico" aria-hidden="true">🧾</span><span><b>Bankruptcy tax active.</b> ${Math.round(E.PENALTY_TAX * 100)}% of the profit on winning bets is confiscated for another ${countdown(p.penaltyUntil, '0s')}.</span></div>` : ''}
      <div class="menu-list">
        ${isAdmin() ? '<button type="button" class="btn btn-outline" data-go="admin">🛡️ Admin panel</button>' : ''}
        <button type="button" class="btn btn-outline" data-go="mybets">🎟️ My bets & P&amp;L</button>
        <button type="button" class="btn btn-outline" data-how>📖 How it works</button>
        <button type="button" class="btn btn-danger" data-logout>Log out</button>
      </div>
    </div>`;
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { dlg.close(); setTab(b.dataset.go); }));
  dlg.querySelector('[data-how]').addEventListener('click', () => { dlg.close(); openHow($('btn-profile')); });
  dlg.querySelector('[data-logout]').addEventListener('click', async () => {
    dlg.close();
    try { await store.signOut(); } catch (err) { toast(errMsg(err), 'error'); }
  });
  openDialog(dlg, opener);
}

// ------------------------------------------------------------------ tabs
function setTab(tab) {
  if (tab === 'admin' && !isAdmin()) tab = 'markets';
  if (!views[tab]) tab = 'markets';
  const changed = state.tab !== tab;
  state.tab = tab;
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    if (btn.dataset.tab === tab) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  if (views[tab] && views[tab].onShow) views[tab].onShow();
  scheduleRender();
  if (changed) window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------ session lifecycle
let sessionUid = null;
let banUnsub = null;
let dataUnsubs = [];
let dataFor = null;       // uid the data subscriptions belong to
let bansUnsub = null;
let hkTimer = null;
let oracleTimer = null;
let playerWaitUntil = 0;

function onSession(s) {
  state.session = s;
  const uid = s ? s.uid : null;
  if (uid !== sessionUid) {
    // never carry one account's toasts (e.g. the admin's "X has been banned") into another session
    if (sessionUid !== null || uid === null) $('toasts').replaceChildren();
    sessionUid = uid;
    if (banUnsub) { try { banUnsub(); } catch { /* ignore */ } banUnsub = null; }
    state.ban = null;
    state.banLoaded = !uid;
    if (uid && typeof store.subscribeMyBan === 'function') {
      banUnsub = store.subscribeMyBan((ban) => { state.ban = ban || null; state.banLoaded = true; scheduleRender(); });
    }
    playerWaitUntil = uid ? Date.now() + 4000 : 0;
  }
  scheduleRender();
}

function decideScreen() {
  const cfg = state.config;
  const s = state.session;
  if (!cfg || s === undefined) return 'boot';
  const admin = isAdmin();
  if (s && state.ban && !admin) return 'banned';
  const closed = !cfg.exists || cfg.maintenance;
  if (closed && !admin) return 'maintenance';
  if (!s) return 'auth';
  if (!state.player) {
    if (Date.now() < playerWaitUntil) { setTimeout(scheduleRender, 500); return 'boot'; }
    return 'repair';
  }
  return 'app';
}

function showScreen(next) {
  const prev = screen;
  screen = next;
  $('boot').hidden = next !== 'boot';
  $('gate').hidden = !['maintenance', 'banned', 'repair'].includes(next);
  $('auth').hidden = next !== 'auth';
  $('app').hidden = next !== 'app';
  if (next !== 'app') closeDialog($('sheet'));
  if (prev !== next && next === 'auth') setAuthMode(authMode);
  if (next === 'app') startData(); else stopData();
}

function startData() {
  const uid = state.player && state.player.uid;
  if (dataFor === uid && dataUnsubs.length) {
    syncAdminSubs();
    return;
  }
  stopData();
  dataFor = uid;
  state.loaded = { players: false, markets: false, bets: false };
  dataUnsubs = [
    store.subscribePlayers((players) => { state.players = players || []; state.loaded.players = true; scheduleRender(); }),
    store.subscribeMarkets((markets) => { onMarkets(markets || []); }),
    store.subscribeBets((bets) => { onBets(bets || []); }),
    store.subscribeMyVotes((ids) => { state.myVotes = new Set(ids || []); scheduleRender(); }),
  ];
  syncAdminSubs();
  setTab(state.tab);
  housekeeping();
  hkTimer = setInterval(housekeeping, 30_000);
  oracleTimer = setInterval(() => { ensureHouse(); oracleSweep(); }, 60_000);
}

function syncAdminSubs() {
  const admin = isAdmin();
  $('nav-admin').hidden = !admin;
  if (admin && !bansUnsub && typeof store.subscribeBans === 'function') {
    bansUnsub = store.subscribeBans((bans) => { state.bans = bans || []; scheduleRender(); });
  } else if (!admin && bansUnsub) {
    try { bansUnsub(); } catch { /* ignore */ }
    bansUnsub = null;
    state.bans = [];
  }
}

function stopData() {
  if (!dataUnsubs.length && !dataFor) return;
  dataUnsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
  dataUnsubs = [];
  if (bansUnsub) { try { bansUnsub(); } catch { /* ignore */ } bansUnsub = null; }
  dataFor = null;
  clearInterval(hkTimer);
  clearInterval(oracleTimer);
  hkTimer = oracleTimer = null;
  state.players = [];
  state.markets = [];
  state.bets = [];
  state.bans = [];
  state.myVotes = new Set();
  state.oracle = new Map();
  state.loaded = { players: false, markets: false, bets: false };
  seenBets = null;
  seenBonds = null;
  ensuredDay = null;
  houseTries = 0;
  Object.values(views).forEach((v) => v.reset && v.reset());
  if (state.tab === 'admin') state.tab = 'markets';
  const b = $('banner');
  b.innerHTML = '';
  b.__html = '';
}

// ------------------------------------------------------------------ data handlers
let seenBets = null;   // betId -> status (my bets) — for win celebrations
let seenBonds = null;  // marketId -> 'r'|'c' flags already paid

function onMarkets(markets) {
  const firstLoad = !state.loaded.markets;
  state.markets = markets;
  state.loaded.markets = true;
  // bond payouts: celebrate when my bond flag flips to paid
  const me = state.player;
  if (me) {
    const paid = new Map();
    for (const m of markets) {
      if (m.reportedBy === me.uid && m.reporterBondPaid) paid.set(`${m.id}:r`, E.bondClaims(m).reporter);
      if (m.challengedBy === me.uid && m.challengerBondPaid) paid.set(`${m.id}:c`, E.bondClaims(m).challenger);
    }
    if (seenBonds) {
      for (const [k, amt] of paid) {
        if (!seenBonds.has(k) && amt > 0) {
          const m = markets.find((x) => x.id === k.split(':')[0]);
          toast(`Bond back: ${money(amt)} from “${m ? m.title : 'a market'}”${amt > E.BOND ? ' — you were right!' : ''}`, 'success', '🧾');
        }
      }
    }
    seenBonds = new Set(paid.keys());
  }
  if (firstLoad) {
    ensureHouse();
    oracleSweep();
  }
  scheduleRender();
}

function onBets(bets) {
  state.bets = bets;
  state.loaded.bets = true;
  const me = state.player;
  if (me) {
    const mine = bets.filter((b) => b.uid === me.uid);
    if (seenBets) {
      let wonTotal = 0;
      const wins = [];
      for (const b of mine) {
        const prev = seenBets.get(b.id);
        if (prev === 'open' && b.status === 'won') { wonTotal += b.payout || 0; wins.push(b); }
        else if (prev === 'open' && b.status === 'void') toast(`Refunded ${money(b.amount)} — “${b.marketTitle}” was voided.`, 'info', '↩️');
        else if (prev === 'open' && b.status === 'lost') toast(`Lost ${money(b.amount)} on “${b.marketTitle}”. The house thanks you.`, 'info', '🥀');
      }
      if (wins.length) {
        const w = wins[0];
        toast(wins.length === 1
          ? `You won ${money(w.payout)} on “${w.marketTitle}”!${w.taxed ? ` (${money(w.taxed)} bankruptcy tax)` : ''}`
          : `You won ${money(wonTotal)} on ${wins.length} bets!`, 'win', '🏆');
        confetti();
        bump($('h-wallet'), 'bump');
      }
    }
    seenBets = new Map(mine.map((b) => [b.id, b.status]));
  }
  scheduleRender();
}

function celebrateBet() {
  bump($('h-wallet'));
}

// ------------------------------------------------------------------ housekeeping + house markets
let hkBusy = false;
async function housekeeping() {
  if (hkBusy || screen !== 'app' || typeof store.runHousekeeping !== 'function') return;
  hkBusy = true;
  try { await store.runHousekeeping(); } catch (e) { console.warn('housekeeping:', e && e.message); } finally { hkBusy = false; }
}

let ensuredDay = null;
let ensuring = false;
let houseTries = 0;
let houseNextTry = 0;
async function ensureHouse() {
  if (screen !== 'app' || !state.loaded.markets || ensuring) return;
  const now = Date.now();
  const key = E.utcDayKey(now);
  if (ensuredDay === key) return;
  if (ensuredDay !== key && houseTries && ensuredDay !== null) houseTries = 0;
  const todays = state.markets.filter((m) => typeof m.id === 'string' && m.id.startsWith(`auto-${key}-`));
  if (todays.length >= 5) { ensuredDay = key; return; }
  if (now < houseNextTry) return;
  ensuring = true;
  try {
    const fetchers = O ? (O.fetchers || O.defaultFetchers || undefined) : undefined;
    let list;
    if (typeof T.buildDailyMarkets === 'function') list = await T.buildDailyMarkets(key, now, fetchers ? { fetchers } : {});
    else list = T.dailyMarkets(key, now);
    const have = new Set(state.markets.map((m) => m.id));
    const missing = (list || []).filter((m) => !have.has(m.id));
    if (missing.length) await store.ensureHouseMarkets(missing);
    houseTries++;
    // a full set (or 3 tries) means we're done for today; otherwise retry later (oracle fetch may have failed)
    if ((list || []).length >= 5 || houseTries >= 3) ensuredDay = key;
    else houseNextTry = now + 5 * 60_000;
  } catch (e) {
    console.warn('house markets:', e && e.message);
    houseTries++;
    houseNextTry = now + 5 * 60_000;
    if (houseTries >= 3) ensuredDay = key;
  } finally {
    ensuring = false;
  }
}

// ------------------------------------------------------------------ oracles
const ORACLE_REFRESH_MS = 55_000;
const ORACLE_ERROR_BACKOFF_MS = 10 * 60_000;
const ORACLE_TIMER_TOLERANCE_MS = 10 * 60_000; // candles are 5-min / 1-h granular
let sweeping = false;

async function oracleSweep() {
  if (!O || sweeping || screen !== 'app' || !state.player) return;
  sweeping = true;
  try {
    const now = Date.now();
    for (const m of state.markets) {
      if (!m.oracle) continue;
      const reportable = m.status === 'open' && now >= (m.reportableAt ?? Infinity);
      if (!reportable && m.status !== 'reported') continue;
      const st = state.oracle.get(m.id) || { status: 'idle' };
      state.oracle.set(m.id, st);
      const needFetch = !(st.result && st.result.status === 'final') && now >= (st.nextAt || 0);
      if (needFetch) {
        st.status = 'loading';
        try {
          const data = await O.fetchOracleData(m.oracle, m);
          st.fetchedAt = Date.now();
          if (data == null) {
            // not available yet, or the request failed (fetchOracleData swallows errors): back off
            st.nulls = (st.nulls || 0) + 1;
            st.nextAt = st.fetchedAt + (st.nulls >= 3 ? ORACLE_ERROR_BACKOFF_MS : ORACLE_REFRESH_MS);
            st.result = { status: 'pending' };
            st.status = 'pending';
            continue;
          }
          st.nulls = 0;
          st.data = data;
          st.result = O.evaluate(m.oracle, data, m) || { status: 'pending' };
          st.nextAt = st.fetchedAt + ORACLE_REFRESH_MS;
          st.error = null;
          st.status = st.result.status;
        } catch (e) {
          st.error = errMsg(e);
          st.nextAt = Date.now() + ORACLE_ERROR_BACKOFF_MS;
          st.status = 'error';
          continue;
        }
      }
      if (st.result && st.result.status === 'final') await actOnOracle(m, st);
    }
  } catch (e) {
    console.warn('oracle sweep:', e && e.message);
  } finally {
    sweeping = false;
    scheduleRender();
  }
}

async function actOnOracle(market, st) {
  const now = Date.now();
  const m = state.markets.find((x) => x.id === market.id) || market;
  const me = state.player;
  if (!me) return;
  const r = st.result;
  const timer = m.kind === 'timer';
  // timers: reports carry only the event time (oracle's optionId is ignored)
  const optionId = timer ? null : r.optionId;
  const eventAt = timer ? (Number.isFinite(r.eventAt) ? r.eventAt : null) : null;
  if (timer && eventAt == null) return;
  const src = O.sourceLabel ? O.sourceLabel(m.oracle) : 'the data source';
  if (m.status === 'open' && now >= m.reportableAt && !st.reportTried) {
    if ((me.balance || 0) < E.BOND) return;
    if (E.validateReport(me, m, optionId, eventAt, now)) return;
    st.reportTried = true;
    try {
      await store.reportResult(m.id, optionId, eventAt, oracleEvidence(m, st.data));
      const what = timer ? `it happened ${new Date(eventAt).toLocaleString()}` : modelUi.optionLabel(m, optionId);
      toast(`Auto-reported “${m.title}”: ${what} (per ${src}). ${money(E.BOND)} bond posted.`, 'success', '🤖');
    } catch (e) {
      console.warn('oracle auto-report:', errMsg(e));
    }
    return;
  }
  if (m.status === 'reported') {
    st.mismatch = timer
      ? !(Number.isFinite(m.reportedEventAt) && Math.abs(m.reportedEventAt - eventAt) <= ORACLE_TIMER_TOLERANCE_MS)
      : m.reportedOptionId !== optionId;
    if (st.mismatch && !st.challengeTried && (me.balance || 0) >= E.BOND && !E.validateChallenge(me, m, now)) {
      st.challengeTried = true;
      try {
        await store.challengeReport(m.id);
        toast(`Auto-challenged “${m.title}” — the report doesn't match ${src} data. ${money(E.BOND)} bond posted.`, 'success', '🤖');
      } catch (e) {
        console.warn('oracle auto-challenge:', errMsg(e));
      }
    }
  }
}

function oracleEvidence(m, data) {
  try {
    if (O && typeof O.evidenceUrl === 'function') {
      const u = O.evidenceUrl(m.oracle, m, data || null);
      if (typeof u === 'string' && u.length <= (E.MAX_EVIDENCE_LENGTH || 300)) return u;
    }
  } catch { /* ignore */ }
  return null;
}

async function challengeMarket(m, btn) {
  const ok = await confirmDialog({
    title: 'Challenge this result?',
    body: `You'll post a ${money(E.BOND)} bond. Players who didn't bet on this market then vote for 24h. If they overturn the report you get ${money(2 * E.BOND)} back; if they uphold it you lose the bond; a tie refunds everyone.`,
    confirmLabel: `Challenge · ${money(E.BOND)} bond`,
    icon: '⚖️',
  });
  if (!ok) return;
  try {
    await withBusy(btn, () => store.challengeReport(m.id));
    toast('Challenge filed. Let the jury decide. ⚖️', 'success', '⚖️');
    bump($('h-wallet'));
  } catch (err) {
    toast(errMsg(err), 'error');
  }
}

// ------------------------------------------------------------------ rendering
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    try { render(); } catch (err) { console.error(err); }
  }, 0);
}

function render() {
  const next = decideScreen();
  if (next !== screen || next === 'app') showScreen(next);
  if (next === 'maintenance' || next === 'banned' || next === 'repair') {
    gateUi.renderGate($('gate'), next, { state, E, isAdmin: isAdmin() });
    return;
  }
  if (next !== 'app') return;
  renderHeader();
  renderBanner();
  const view = views[state.tab];
  if (view) view.render();
  if (sheet) sheet.render();
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

let lastBalance = null;
function renderHeader() {
  const p = state.player;
  const now = Date.now();
  setText($('h-user'), p.username);
  const av = $('h-avatar');
  if (av.dataset.name !== p.username) {
    av.dataset.name = p.username;
    const tmp = document.createElement('div');
    tmp.innerHTML = avatarHtml(p.username);
    av.style.cssText = tmp.firstElementChild.style.cssText;
    av.textContent = tmp.firstElementChild.textContent;
  }
  setText($('h-balance'), money(p.balance));
  if (lastBalance !== null && p.balance !== lastBalance) bump($('h-wallet'));
  lastBalance = p.balance;
  setText($('h-networth'), money(E.netWorth(p)));
  const skulls = Number(p.bankruptcies) || 0;
  const sk = $('h-skulls');
  sk.hidden = skulls < 1;
  setText(sk, `💀${skulls > 1 ? `×${skulls}` : ''}`);
  sk.title = `${skulls} bankruptc${skulls === 1 ? 'y' : 'ies'}`;
  const pen = $('h-penalty');
  if (E.penaltyActive(p, now)) {
    if (pen.dataset.until !== String(p.penaltyUntil) || pen.hidden) {
      pen.dataset.until = String(p.penaltyUntil);
      pen.innerHTML = `🧾 Tax · ${countdown(p.penaltyUntil, '0s')}`;
      pen.title = `Bankruptcy tax: ${Math.round(E.PENALTY_TAX * 100)}% of your winning-bet profit is confiscated until this runs out.`;
    }
    pen.hidden = false;
  } else {
    pen.hidden = true;
    pen.dataset.until = '';
  }
  const maint = state.config && (state.config.maintenance || !state.config.exists);
  $('pill-maint').hidden = !(isAdmin() && maint);
  $('nav-admin').hidden = !isAdmin();
}

function renderBanner() {
  const p = state.player;
  const slot = $('banner');
  const now = Date.now();
  let html = '';
  if (E.isBroke(p)) {
    const claimable = E.canClaimRestart(p, now);
    const at = typeof E.restartAvailableAt === 'function' ? E.restartAvailableAt(p) : null;
    const penalty = `${Math.round(E.PENALTY_TAX * 100)}% winnings tax for ${E.PENALTY_DAYS} days + a 💀 on the leaderboard`;
    html = `<div class="broke-banner" role="region" aria-label="You're broke">
      <div class="skull" aria-hidden="true">${claimable ? '🪙' : '💀'}</div>
      <div>
        <h2>${claimable ? 'Bailout ready' : "You're broke"}</h2>
        <p>${claimable
          ? `The house will spot you ${esc(money(E.RESTART_BALANCE))}. Penalty: ${esc(penalty)}.`
          : at ? `A ${esc(money(E.RESTART_BALANCE))} bailout unlocks at midnight UTC — in ${countdown(at, 'moments')}. Penalty: ${esc(penalty)}.`
            : `Come back tomorrow for a ${esc(money(E.RESTART_BALANCE))} bailout. Penalty: ${esc(penalty)}.`}</p>
      </div>
      ${claimable ? `<button type="button" class="btn btn-primary btn-lg" data-action="claim-restart">Claim ${esc(money(E.RESTART_BALANCE))} bailout</button>` : ''}
    </div>`;
  }
  if (slot.__html !== html) {
    slot.innerHTML = html;
    slot.__html = html;
  }
}


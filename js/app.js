// Sonnetous UI entry point. Everything (rules, templates, store, views) is dynamically imported
// inside boot() so that any load failure ends up on a readable error screen instead of a blank page.
import { esc, fmtDuration, errMsg, toast, startTicker } from './ui/util.js';

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  users: [],
  markets: [],
  bets: [],
  tab: 'markets',
  filter: 'open',
  mode: 'local',
};
const loaded = { users: false, markets: false, bets: false };

let E;            // economy module
let T;            // templates module
let store;        // active store backend
let uiMarkets;    // ui/markets.js
let views = {};   // tab id -> { render, onShow?, reset? }
let authMode = 'signin';

// ------------------------------------------------------------------ boot
boot();

async function boot() {
  try {
    const [economy, templates, storeMod, marketsUi, viewsUi] = await Promise.all([
      import('./economy.js'),
      import('./templates.js'),
      import('./store/index.js'),
      import('./ui/markets.js'),
      import('./ui/views.js'),
    ]);
    E = economy;
    T = templates;
    uiMarkets = marketsUi;
    store = typeof storeMod.getStore === 'function' ? await storeMod.getStore() : storeMod.store;
    if (!store) throw new Error('No storage backend was returned by js/store/index.js');
    const info = await store.init();
    state.mode = (info && info.mode) || 'local';

    const ctx = {
      state, loaded,
      getStore: () => store,
      rerender: scheduleRender,
      setTab,
    };
    views = {
      markets: marketsUi.createMarketsView($('panel-markets'), ctx),
      create: viewsUi.createCreateView($('panel-create'), ctx),
      mybets: viewsUi.createMyBetsView($('panel-mybets'), ctx),
      leaderboard: viewsUi.createLeaderboardView($('panel-leaderboard'), ctx),
      activity: viewsUi.createActivityView($('panel-activity'), ctx),
    };
    wireShell();
    startTicker(scheduleRender);
    $('auth-local').hidden = state.mode !== 'local';
    $('local-pill').hidden = state.mode !== 'local';
    store.onAuthChange(onUser);
  } catch (err) {
    showFatal(err);
  }
}

function showFatal(err) {
  console.error(err);
  $('boot').hidden = true;
  $('auth').hidden = true;
  $('app').hidden = true;
  $('fatal').hidden = false;
  $('fatal-msg').textContent = (err && (err.stack || err.message)) ? `${err.message || err}` : String(err);
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(errMsg(e.reason), 'error');
});

// ------------------------------------------------------------------ shell wiring
function wireShell() {
  // tabs
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  // auth
  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode));
  });
  $('auth-form').addEventListener('submit', onAuthSubmit);

  // logout
  $('btn-logout').addEventListener('click', async () => {
    try { await store.signOut(); } catch (e) { toast(errMsg(e), 'error'); }
  });

  // how it works
  const dlg = $('how');
  document.querySelectorAll('[data-open-how]').forEach((b) => b.addEventListener('click', () => {
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }));
  document.querySelectorAll('[data-close-how]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  // bailout button (banner is re-rendered, so delegate)
  $('banner').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action=claim]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await store.claimRestart();
      toast(`Bailout claimed: ${E.formatSonnetous(E.RESTART_BALANCE)}. Try not to do that again. 💀`, 'success');
    } catch (err) {
      toast(errMsg(err), 'error');
      btn.disabled = false;
    }
  });
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('[data-auth-mode]').forEach((b) => {
    const on = b.dataset.authMode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const form = $('auth-form');
  form.elements.password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
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
  submit.disabled = true;
  try {
    if (authMode === 'signup') await store.signUp(username, password);
    else await store.signIn(username, password);
    form.reset();
  } catch (err) {
    errEl.textContent = errMsg(err);
    errEl.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

// ------------------------------------------------------------------ tabs
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  if (views[tab] && views[tab].onShow) views[tab].onShow();
  scheduleRender();
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------ session lifecycle
let unsubs = [];
let autoTimer = null;
let lastEnsuredDay = null;
let brokeRequested = false;

function onUser(user) {
  $('boot').hidden = true;
  if (!user) {
    endSession();
    state.user = null;
    $('app').hidden = true;
    $('auth').hidden = false;
    setAuthMode('signin');
    return;
  }
  // the session can be swapped from another tab (shared localStorage): drop the previous user's state
  if (state.user && state.user.uid !== user.uid) endSession();
  state.user = user;
  $('auth').hidden = true;
  $('app').hidden = false;
  if (!unsubs.length) startSession();
  scheduleRender();
}

function startSession() {
  loaded.users = loaded.markets = loaded.bets = false;
  unsubs = [
    store.subscribeUsers((users) => { state.users = users; loaded.users = true; scheduleRender(); }),
    store.subscribeMarkets((markets) => { state.markets = markets; loaded.markets = true; scheduleRender(); }),
    store.subscribeBets((bets) => { state.bets = bets; loaded.bets = true; scheduleRender(); }),
  ];
  setTab(state.tab);
  ensureDaily().then(() => store.autoResolveExpired()).catch((e) => toast(errMsg(e), 'error'));
  autoTimer = setInterval(() => {
    ensureDaily().catch(() => {});
    store.autoResolveExpired().catch(() => {});
  }, 60000);
}

async function ensureDaily() {
  const now = Date.now();
  const key = E.utcDayKey(now);
  if (lastEnsuredDay === key) return;
  await store.ensureMarkets(T.dailyMarkets(key, now));
  lastEnsuredDay = key;
}

function endSession() {
  unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
  unsubs = [];
  clearInterval(autoTimer);
  autoTimer = null;
  lastEnsuredDay = null;
  brokeRequested = false;
  state.users = [];
  state.markets = [];
  state.bets = [];
  state.filter = 'open';
  loaded.users = loaded.markets = loaded.bets = false;
  if (uiMarkets) uiMarkets.resetMarketDrafts();
  if (views.create && views.create.reset) views.create.reset();
  $('banner').innerHTML = '';
  $('banner').dataset.sig = '';
  state.tab = 'markets';
  setTab('markets');
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
  if (!state.user) return;
  renderHeader();
  renderBanner();
  checkBroke();
  const view = views[state.tab];
  if (view) view.render();
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function renderHeader() {
  const { user, bets } = state;
  const now = Date.now();
  const fmt = E.formatSonnetous;
  setText($('h-user'), user.username);
  setText($('h-balance'), fmt(user.balance));
  setText($('h-networth'), fmt(E.netWorth(user, bets)));
  const skulls = Number(user.bankruptcies) || 0;
  $('h-skulls-wrap').hidden = skulls < 1;
  setText($('h-skulls'), `💀×${skulls}`);
  const pen = $('h-penalty');
  if (E.penaltyActive(user, now)) {
    const left = Number(user.penaltyUntil);
    if (pen.dataset.until !== String(left) || pen.hidden) {
      pen.dataset.until = String(left);
      pen.innerHTML = `🧾 ${Math.round(E.PENALTY_TAX * 100)}% winnings tax · <b data-countdown="${left}" data-done="0s">${fmtDuration(left - now)}</b> left`;
      pen.title = 'Bankruptcy tax: part of your winning-bet profit is confiscated until this expires.';
    }
    pen.hidden = false;
  } else {
    pen.hidden = true;
    pen.dataset.until = '';
  }
}

function renderBanner() {
  const { user, bets } = state;
  const slot = $('banner');
  const now = Date.now();
  if (!loaded.bets || !E.isBroke(user, bets)) {
    if (slot.innerHTML) slot.innerHTML = '';
    slot.dataset.sig = '';
    return;
  }
  const claimable = E.canClaimRestart(user, bets, now);
  const amount = esc(E.formatSonnetous(E.RESTART_BALANCE));
  const penalty = `penalty: ${Math.round(E.PENALTY_TAX * 100)}% winnings tax for ${E.PENALTY_DAYS} days + 💀`;
  const html = claimable
    ? `<div class="banner banner-broke" role="alert">
         <div><b>You're broke.</b> A bailout is ready (${esc(penalty)}).</div>
         <button type="button" class="btn primary big" data-action="claim">Claim ${amount} bailout</button>
       </div>`
    : `<div class="banner banner-broke" role="alert">
         <div><b>You're broke.</b> Come back tomorrow for a ${amount} bailout (${esc(penalty)})</div>
       </div>`;
  if (slot.dataset.sig !== html) {
    slot.innerHTML = html;
    slot.dataset.sig = html;
  }
}

function checkBroke() {
  const { user, bets } = state;
  if (!loaded.bets) return;
  if (!E.isBroke(user, bets) || user.brokeSince) {
    brokeRequested = false;
    return;
  }
  if (brokeRequested) return; // guard against loops if the store doesn't update the user
  brokeRequested = true;
  store.markBrokeIfNeeded().catch((e) => toast(errMsg(e), 'error'));
}

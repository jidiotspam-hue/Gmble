// Gate screens shown instead of the app: maintenance (with the admin login / claim flow), banned, and
// "repair" (signed-in account without a player doc yet — e.g. created during maintenance).
import { esc, errMsg, patch, trackDirty, withBusy, toast, fmtDateTime } from './util.js';

let ctx = null;
let adminOpen = false;
let gateAuthMode = 'signin';

export function wireGate(el, context) {
  ctx = context;
  trackDirty(el);
  el.addEventListener('toggle', (e) => {
    if (e.target && e.target.id === 'gate-admin') adminOpen = e.target.open;
  }, true);
  el.addEventListener('click', async (e) => {
    const modeBtn = e.target.closest('[data-gate-mode]');
    if (modeBtn) {
      gateAuthMode = modeBtn.dataset.gateMode;
      ctx.rerender();
      return;
    }
    const out = e.target.closest('[data-gate-logout]');
    if (out) {
      try { await withBusy(out, () => ctx.store.signOut()); } catch (err) { toast(errMsg(err), 'error'); }
    }
  });
  el.addEventListener('submit', async (e) => {
    const form = e.target;
    e.preventDefault();
    const errEl = form.querySelector('.form-error');
    const btn = form.querySelector('[type=submit]');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
    if (errEl) errEl.hidden = true;
    if (form.id === 'gate-login' || form.id === 'gate-repair') {
      const username = (form.elements.username.value || '').trim();
      const password = form.elements.password.value || '';
      if (!username || !password) { showErr('Enter a username and password.'); return; }
      const signup = form.id === 'gate-login' && gateAuthMode === 'signup';
      try {
        await withBusy(btn, () => (signup ? ctx.store.signUp(username, password) : ctx.store.signIn(username, password)));
        form.reset();
      } catch (err) {
        if (ctx.isMaintenanceError(err)) { form.reset(); adminOpen = true; ctx.rerender(); return; } // signed in; still closed
        showErr(errMsg(err));
      }
    } else if (form.id === 'gate-claim') {
      const code = form.elements.code.value;
      if (!code) { showErr('Enter the admin code.'); return; }
      try {
        await withBusy(btn, () => ctx.store.claimAdmin(code));
        form.reset();
        toast("You're the admin now. The game is still in maintenance — open the Admin tab to let everyone in.", 'success', '🛡️');
      } catch (err) {
        showErr(errMsg(err));
      }
    }
  });
}

export function renderGate(el, kind, { state, isAdmin }) {
  const s = state.session;
  const cfg = state.config || { exists: false, maintenance: true };
  let html = '';
  if (kind === 'banned') html = bannedHtml(state.ban, s);
  else if (kind === 'repair') html = repairHtml(s);
  else html = maintenanceHtml(s, cfg, isAdmin);
  patch(el, html);
  const d = el.querySelector('#gate-admin');
  if (d && d.open !== adminOpen) d.open = adminOpen;
}

const lockup = `<div class="brand-lockup" style="margin-bottom:20px"><svg class="logo" aria-hidden="true"><use href="#logo"/></svg><span class="wordmark">Sonnetous</span></div>`;

function maintenanceHtml(s, cfg, isAdmin) {
  const who = s ? `<div class="notice notice-info" style="margin-top:20px">
      <span class="n-ico" aria-hidden="true">👤</span>
      <span class="grow">Signed in as <b>${esc(s.username || 'you')}</b>. You'll get in as soon as the doors open.</span>
    </div>` : '';
  let admin;
  if (!s) {
    admin = `
      <div class="seg" role="group" aria-label="Log in or sign up">
        <button type="button" data-gate-mode="signin" aria-pressed="${gateAuthMode === 'signin'}">Sign in</button>
        <button type="button" data-gate-mode="signup" aria-pressed="${gateAuthMode === 'signup'}">Create account</button>
      </div>
      <form id="gate-login" class="stack" novalidate>
        <div class="field"><label for="gate-user">Username</label>
          <input id="gate-user" class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20"></div>
        <div class="field"><label for="gate-pass">Password</label>
          <input id="gate-pass" class="input" name="password" type="password" autocomplete="${gateAuthMode === 'signup' ? 'new-password' : 'current-password'}"></div>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary btn-block">${gateAuthMode === 'signup' ? 'Create account' : 'Sign in'}</button>
      </form>
      ${!cfg.exists ? '<p class="field-hint">No admin yet. Sign in (or create an account), then claim admin with the secret code.</p>' : ''}`;
  } else if (!cfg.exists) {
    admin = `
      <form id="gate-claim" class="stack" novalidate>
        <div class="field"><label for="gate-code">Claim admin with code</label>
          <input id="gate-code" class="input" name="code" type="password" autocomplete="off" spellcheck="false" placeholder="Secret admin code"></div>
        <p class="field-hint">The first person with the code becomes the admin of this Sonnetous. The game stays in maintenance until you open it.</p>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary btn-block">🛡️ Claim admin</button>
      </form>`;
  } else {
    admin = `<p class="small dim">${isAdmin ? '' : `<b>${esc(s.username || 'This account')}</b> isn't the admin account. `}Log out and sign in as the admin to manage the game.</p>`;
  }
  return `
    <div class="screen-card fade-in">
      ${lockup}
      <div class="screen-ico" aria-hidden="true">🚧</div>
      <h1>The casino is closed</h1>
      <p class="lede">${cfg.exists
        ? 'Sonnetous is down for maintenance. The house is counting its money — check back soon.'
        : "Sonnetous hasn't opened yet. The admin still has to unlock the doors."}</p>
      ${who}
      <details class="disclosure" id="gate-admin">
        <summary><span aria-hidden="true">🛡️</span> Admin login</summary>
        <div class="disclosure-body">${admin}</div>
      </details>
      ${s ? '<div class="screen-actions"><button type="button" class="btn btn-ghost" data-gate-logout>Log out</button></div>' : ''}
    </div>`;
}

function bannedHtml(ban, s) {
  const reason = ban && ban.reason ? String(ban.reason) : '';
  return `
    <div class="screen-card fade-in" role="alert">
      ${lockup}
      <div class="screen-ico" aria-hidden="true">🚫</div>
      <h1>You've been banned</h1>
      <p class="lede">The admin has shown <b>${esc((s && s.username) || 'you')}</b> the door.</p>
      <div class="notice notice-loss" style="margin-top:20px">
        <span class="n-ico" aria-hidden="true">📝</span>
        <span><b>Reason:</b> <span id="ban-reason">${reason ? esc(reason) : 'No reason given.'}</span>${ban && ban.at ? `<br><span class="tiny">Since ${esc(fmtDateTime(ban.at))}</span>` : ''}</span>
      </div>
      <p class="small muted" style="margin-top:16px">Think this is a mistake? Grovel to the admin in the group chat.</p>
      <div class="screen-actions"><button type="button" class="btn btn-outline" data-gate-logout>Log out</button></div>
    </div>`;
}

function repairHtml(s) {
  return `
    <div class="screen-card fade-in">
      ${lockup}
      <div class="screen-ico" aria-hidden="true">🎟️</div>
      <h1>The doors are open!</h1>
      <p class="lede">Log in once more to pick up your ${'§'}500 starting stack.</p>
      <form id="gate-repair" class="stack" style="margin-top:20px" novalidate>
        <div class="field"><label for="rep-user">Username</label>
          <input id="rep-user" class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" value="${esc((s && s.username) || '')}"></div>
        <div class="field"><label for="rep-pass">Password</label>
          <input id="rep-pass" class="input" name="password" type="password" autocomplete="current-password"></div>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary btn-lg btn-block">Log in</button>
      </form>
      <div class="screen-actions"><button type="button" class="btn btn-ghost" data-gate-logout>Use a different account</button></div>
    </div>`;
}

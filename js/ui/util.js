// Small DOM / format helpers shared by every UI module. No game rules in here.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape any text before it goes into an HTML string. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

export const $ = (id) => document.getElementById(id);

export function errMsg(e) {
  if (!e) return 'Something went wrong';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

/** §1,234 — same format as economy.formatSonnetous (kept here so UI helpers have no rules import). */
export function money(n) {
  const v = Math.trunc(Number(n) || 0);
  return `${v < 0 ? '-' : ''}§${Math.abs(v).toLocaleString('en-US')}`;
}
export function signedMoney(n) {
  const v = Math.trunc(Number(n) || 0);
  return v > 0 ? `+${money(v)}` : money(v);
}

export function fmtOdds(odds) {
  return odds == null || !Number.isFinite(Number(odds)) ? '—' : `×${Number(odds).toFixed(2)}`;
}
export function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  const v = p * 100;
  if (v > 0 && v < 1) return '<1%';
  if (v < 100 && v > 99) return '>99%';
  return `${Math.round(v)}%`;
}

/** 93784000 -> "1d 2h", 3725000 -> "1h 02m", 125000 -> "2m 05s", 4000 -> "4s" */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

export function relTime(ms, now = Date.now()) {
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function fmtDateTime(ms) {
  if (!Number.isFinite(Number(ms))) return '—';
  try {
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(ms).toString();
  }
}
export function fmtDay(ms, now = Date.now()) {
  const d = new Date(ms);
  const t = new Date(now);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, t)) return 'Today';
  const y = new Date(now - 86_400_000);
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

/** epoch ms -> value for <input type="datetime-local"> (local time). */
export function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** <input type="datetime-local"> value -> epoch ms (NaN when empty/invalid). */
export function fromLocalInput(value) {
  return value ? new Date(value).getTime() : NaN;
}

export function parseAmount(value) {
  const s = String(value ?? '').replace(/[,\s§]/g, '');
  if (!s) return NaN;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
}

export function isHttpUrl(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Small stable hash -> index. */
export function hashIdx(str, mod) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return Math.abs(h) % mod;
}
const AV_COLORS = ['#8ea6ff', '#c29bff', '#f5c451', '#4fd1e0', '#ff8fc7', '#ffa05c', '#3ddc97', '#ff6b6b'];
export function avatarHtml(name, cls = '') {
  const n = String(name || '?');
  const initial = [...n][0] || '?';
  return `<span class="avatar ${cls}" style="--av:${AV_COLORS[hashIdx(n.toLowerCase(), AV_COLORS.length)]}" aria-hidden="true">${esc(initial)}</span>`;
}

// ---------------------------------------------------------------- patching (input-preserving re-render)
/**
 * Replace el's content with `html` only when it changed. Values of form controls (matched by
 * name / data-key / id), the focused control and its caret survive the swap, so live updates
 * never eat what someone is typing.
 */
export function sigOf(html) {
  return String(html).replace(/(data-(?:countdown|ago)="[^"]*"[^>]*>)[^<]*/g, '$1');
}
export function patch(el, html) {
  if (!el) return false;
  const sig = sigOf(html);
  if (el.__html === sig) return false;
  const keyOf = (c) => c.getAttribute('data-key') || c.id || (c.name ? `${c.name}::${c.type === 'radio' ? c.value : ''}` : null);
  const saved = new Map();
  let focusKey = null;
  let sel = null;
  const active = document.activeElement;
  for (const c of el.querySelectorAll('input, textarea, select')) {
    const k = keyOf(c);
    if (!k || c.dataset.nokeep != null) continue;
    saved.set(k, c.type === 'radio' || c.type === 'checkbox' ? { checked: c.checked } : { value: c.value, dirty: c.dataset.dirty === '1' });
    if (c === active) {
      focusKey = k;
      try { sel = [c.selectionStart, c.selectionEnd]; } catch { sel = null; }
    }
  }
  let focusSel = null;
  if (!focusKey && active && el.contains(active)) {
    // a button had focus: remember it by data attributes so keyboard users don't get dumped
    focusSel = active.getAttribute('data-focus-key');
  }
  el.innerHTML = html;
  el.__html = sig;
  for (const c of el.querySelectorAll('input, textarea, select')) {
    const k = keyOf(c);
    if (!k || !saved.has(k)) continue;
    const s = saved.get(k);
    if ('checked' in s) {
      if (c.dataset.keepChecked != null) c.checked = s.checked;
    } else if (s.dirty) {
      c.value = s.value;
      c.dataset.dirty = '1';
    }
    if (k === focusKey) {
      c.focus({ preventScroll: true });
      if (sel && sel[0] != null) { try { c.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ } }
    }
  }
  if (focusSel) {
    const b = el.querySelector(`[data-focus-key="${CSS.escape(focusSel)}"]`);
    if (b) b.focus({ preventScroll: true });
  }
  return true;
}
/** Mark text inputs as "dirty" once the user types, so patch() keeps their value instead of the re-rendered default. */
export function trackDirty(root) {
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) t.dataset.dirty = '1';
  });
}

// ---------------------------------------------------------------- busy buttons
export async function withBusy(btn, fn) {
  if (btn) { btn.classList.add('is-busy'); btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try {
    return await fn();
  } finally {
    if (btn && btn.isConnected) { btn.classList.remove('is-busy'); btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
}

// ---------------------------------------------------------------- toasts
const TOAST_ICONS = { success: '✅', error: '⛔', info: 'ℹ️', win: '🏆', warn: '⚠️' };
export function toast(message, type = 'info', icon) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const ico = document.createElement('span');
  ico.className = 't-ico';
  ico.setAttribute('aria-hidden', 'true');
  ico.textContent = icon || TOAST_ICONS[type] || TOAST_ICONS.info;
  const txt = document.createElement('span');
  txt.textContent = message;
  el.append(ico, txt);
  host.appendChild(el);
  while (host.children.length > 4) host.firstChild.remove();
  const ttl = type === 'error' ? 6500 : type === 'win' ? 6000 : 3800;
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, ttl);
}

// ---------------------------------------------------------------- motion helpers
export const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export function confetti(count = 70) {
  if (reducedMotion()) return;
  const host = document.createElement('div');
  host.className = 'confetti';
  host.setAttribute('aria-hidden', 'true');
  const colors = ['#f5c451', '#ffdf8a', '#3ddc97', '#8ea6ff', '#ff8fc7', '#c29bff'];
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 240}px`);
    p.style.setProperty('--rot', `${(Math.random() - 0.5) * 1440}deg`);
    p.style.setProperty('--d', `${1.3 + Math.random() * 1.2}s`);
    p.style.setProperty('--delay', `${Math.random() * 0.35}s`);
    if (i % 3 === 0) { p.style.width = '10px'; p.style.height = '10px'; p.style.borderRadius = '50%'; }
    host.appendChild(p);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 3200);
}

export function bump(el, cls = 'bump') {
  if (!el || reducedMotion()) return;
  el.classList.remove(cls);
  void el.offsetWidth; // restart animation
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 700);
}

// ---------------------------------------------------------------- dialogs
/** Open a native modal <dialog>; restores focus to the opener on close. Esc closes (native). */
export function openDialog(dlg, opener = document.activeElement) {
  if (!dlg) return;
  dlg.__opener = opener;
  if (!dlg.open) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  if (!dlg.__wired) {
    dlg.__wired = true;
    dlg.addEventListener('close', () => {
      const o = dlg.__opener;
      dlg.__opener = null;
      if (o && o.isConnected && typeof o.focus === 'function') o.focus({ preventScroll: true });
    });
    // click on the backdrop closes
    dlg.addEventListener('mousedown', (e) => { dlg.__downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && dlg.__downOnBackdrop && dlg.dataset.sticky == null) dlg.close('backdrop');
    });
    // keep Tab inside (native modal already makes the rest inert; this also wraps focus)
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...dlg.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
}
export function closeDialog(dlg) {
  if (dlg && dlg.open) dlg.close();
}

/**
 * Styled confirm / prompt in the shared #modal dialog.
 * confirmDialog({ title, body, confirmLabel, danger }) -> Promise<boolean>
 * promptDialog({ title, body, label, placeholder, confirmLabel, danger, required, maxLength }) -> Promise<string|null>
 */
export function confirmDialog(opts) {
  return modalAsk({ ...opts, input: false }).then((v) => v !== null);
}
export function promptDialog(opts) {
  return modalAsk({ ...opts, input: true });
}
function modalAsk({ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, input = false,
  label = '', placeholder = '', required = false, maxLength = 200, icon = '' }) {
  const dlg = document.getElementById('modal');
  const opener = document.activeElement;
  return new Promise((resolve) => {
    dlg.innerHTML = `
      <form method="dialog" class="modal-body" novalidate>
        ${icon ? `<div class="screen-ico" style="font-size:36px;margin:0" aria-hidden="true">${esc(icon)}</div>` : ''}
        <h2 id="modal-title">${esc(title)}</h2>
        ${body ? `<p class="m-text">${esc(body)}</p>` : ''}
        ${input ? `<div class="field"><label for="modal-input">${esc(label)}</label>
          <input id="modal-input" class="input" type="text" maxlength="${Number(maxLength) || 200}" placeholder="${esc(placeholder)}" autocomplete="off">
          <p class="form-error" id="modal-err" hidden></p></div>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-m="cancel">${esc(cancelLabel)}</button>
          <button type="submit" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-m="ok">${esc(confirmLabel)}</button>
        </div>
      </form>`;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onClose = () => finish(null);
    dlg.addEventListener('close', onClose);
    dlg.querySelector('[data-m=cancel]').addEventListener('click', () => finish(null));
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (input) {
        const v = dlg.querySelector('#modal-input').value.trim();
        if (required && !v) {
          const er = dlg.querySelector('#modal-err');
          er.textContent = 'Please fill this in.';
          er.hidden = false;
          dlg.querySelector('#modal-input').setAttribute('aria-invalid', 'true');
          return;
        }
        finish(v);
      } else finish('');
    });
    openDialog(dlg, opener);
    const focusEl = input ? dlg.querySelector('#modal-input') : dlg.querySelector('[data-m=ok]');
    if (focusEl) focusEl.focus();
  });
}

// ---------------------------------------------------------------- ticker
/**
 * Once a second: update text of [data-countdown="<ts>"] and [data-ago="<ts>"] elements only.
 * `onExpire` fires when a countdown crosses zero so views can re-render.
 */
export function startTicker(onExpire) {
  const tick = () => {
    const now = Date.now();
    let expired = false;
    for (const el of document.querySelectorAll('[data-countdown]')) {
      const left = Number(el.dataset.countdown) - now;
      if (left > 0) {
        const text = fmtDuration(left);
        if (el.textContent !== text) el.textContent = text;
      } else {
        const text = el.dataset.done || 'now';
        if (el.textContent !== text) el.textContent = text;
        if (!el.dataset.expired) { el.dataset.expired = '1'; expired = true; }
      }
    }
    for (const el of document.querySelectorAll('[data-ago]')) {
      const text = relTime(Number(el.dataset.ago), now);
      if (el.textContent !== text) el.textContent = text;
    }
    if (expired) onExpire();
  };
  return setInterval(tick, 1000);
}
/** Countdown span that the ticker keeps fresh. */
export function countdown(ts, done = 'now') {
  return `<span class="num" data-countdown="${Number(ts)}" data-done="${esc(done)}">${esc(fmtDuration(Number(ts) - Date.now()))}</span>`;
}
export function ago(ts) {
  return `<time class="num" datetime="${esc(new Date(Number(ts) || 0).toISOString())}" data-ago="${Number(ts)}">${esc(relTime(Number(ts)))}</time>`;
}

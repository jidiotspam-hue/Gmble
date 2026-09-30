// Small DOM/format helpers shared by all UI modules.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape any user-provided text before putting it into an HTML string. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

export function errMsg(e) {
  return (e && e.message) ? e.message : String(e || 'Something went wrong');
}

export function fmtOdds(odds) {
  return odds == null || !Number.isFinite(odds) ? '—' : `×${Number(odds).toFixed(2)}`;
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
  try {
    return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toString();
  }
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
  const n = Number(String(value ?? '').trim());
  return Number.isInteger(n) ? n : NaN;
}

// ---------------------------------------------------------------- toasts
export function toast(message, type = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  while (host.children.length > 4) host.firstChild.remove();
  const ttl = type === 'error' ? 6000 : 3500;
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, ttl);
}

// ---------------------------------------------------------------- ticker
/**
 * Once a second: update text of [data-countdown="<ts>"] and [data-ago="<ts>"] elements only.
 * `onExpire` fires (once per element) when a countdown crosses zero so views can re-render.
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

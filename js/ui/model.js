// View-model helpers: derived facts about markets that several views need (probabilities, colours,
// status chips, featured / tampered flags). Pure-ish: reads economy + templates, never the store.
import { esc, countdown, fmtPct, fmtOdds, fmtDateTime } from './util.js';

let E = null;
let T = null;
export function initModel(economy, templates) {
  E = economy;
  T = templates;
}

// ---------------------------------------------------------------- colours
const PALETTE = ['var(--o1)', 'var(--o2)', 'var(--o3)', 'var(--o4)', 'var(--o5)', 'var(--o6)'];
export function optionColor(market, option, idx) {
  const label = String(option && option.label || '').trim().toLowerCase();
  const opts = market.options || [];
  const yesNo = opts.length === 2;
  if (yesNo && /^(yes|yep|yeah)\b/.test(label)) return 'var(--o-yes)';
  if (yesNo && /^(no|nope|nah)\b/.test(label)) return 'var(--o-no)';
  return PALETTE[idx % PALETTE.length];
}

// ---------------------------------------------------------------- probabilities
/** id -> probability (0..1) or null when there is no signal yet (empty pool). */
export function outcomeProbs(market) {
  const opts = market.options || [];
  const out = {};
  if (market.mode === 'pool') {
    const pool = market.totalPool || 0;
    for (const o of opts) out[o.id] = pool > 0 ? ((market.optionTotals || {})[o.id] || 0) / pool : null;
    return out;
  }
  const inv = opts.map((o) => {
    const odds = E.displayOdds(market, o.id);
    return odds && odds > 0 ? 1 / odds : 0;
  });
  const sum = inv.reduce((a, b) => a + b, 0);
  opts.forEach((o, i) => { out[o.id] = sum > 0 ? inv[i] / sum : null; });
  return out;
}

export function optionLabel(market, optionId) {
  const o = (market.options || []).find((x) => x.id === optionId);
  return o ? o.label : (optionId || '—');
}

/** Human result of a final market ("Yes", "Happened Oct 3, 4:12 PM", "Didn't happen — 24+ hours"). */
export function resultLabel(m, { short = false } = {}) {
  if (m.status === 'void') return 'Void';
  if (m.kind === 'timer') {
    if (Number.isFinite(m.eventAt)) return short ? 'It happened' : `It happened ${fmtDateTime(m.eventAt)}`;
    if (m.resolvedOptionId) return short ? 'Time ran out' : `Time ran out — “${optionLabel(m, m.resolvedOptionId)}” wins`;
  }
  return optionLabel(m, m.resolvedOptionId);
}
/** What a pending report says. */
export function reportLabel(m) {
  if (m.kind === 'timer') return Number.isFinite(m.reportedEventAt) ? `It happened ${fmtDateTime(m.reportedEventAt)}` : 'It happened';
  return optionLabel(m, m.reportedOptionId);
}
/**
 * How one of my bets would settle if the market resolved with `eventAt` (timer) — via economy.betClaim.
 * Returns { status: 'won'|'lost'|'void', payout } or null.
 */
export function timerVerdict(bet, m, eventAt) {
  try {
    const fake = { ...m, status: 'resolved', resolvedOptionId: null, eventAt };
    return E.betClaim(bet, fake, null, Date.now());
  } catch {
    return null;
  }
}
/** Same for a choice market with a given winning option. */
export function choiceVerdict(bet, m, optionId) {
  try {
    const fake = { ...m, status: 'resolved', resolvedOptionId: optionId, eventAt: null };
    if (m.mode === 'pool' && !((m.optionTotals || {})[optionId] > 0)) return { status: 'void', payout: bet.amount };
    return E.betClaim(bet, fake, null, Date.now());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- flags
export function isHouse(m) {
  return m.createdBy === 'house' || m.type === 'auto';
}
export function isToday(m, now) {
  return isHouse(m) && typeof m.id === 'string' && m.id.startsWith(`auto-${E.utcDayKey(now)}-`);
}
export function isFeatured(m) {
  const ids = (T && T.FEATURED_TEMPLATE_IDS) || ['trump-constitution'];
  return isHouse(m) && ids.includes(m.templateId);
}

const tamperCache = new Map(); // id -> { sig, reason }
/** Returns a short reason when a house market doesn't match its deterministic template, else null. */
export function tamperReason(m) {
  if (!isHouse(m)) return null;
  const sig = JSON.stringify([m.title, m.options, m.oddsById, m.bucketsById, m.openedAt, m.closesAt, m.kind, m.mode, m.oracle && m.oracle.type, m.createdBy, m.type]);
  const hit = tamperCache.get(m.id);
  if (hit && hit.sig === sig) return hit.reason;
  let reason = null;
  try {
    if (T && typeof T.checkHouseMarket === 'function') {
      reason = T.checkHouseMarket(m) || null;
    } else if (T && typeof T.expectedHouseMarket === 'function' && typeof E.houseMarketMismatch === 'function') {
      const expected = T.expectedHouseMarket(m);
      if (expected && typeof expected.then === 'function') {
        // async variant: resolve later, treat as clean meanwhile
        expected.then((exp) => {
          const r = exp ? E.houseMarketMismatch(m, exp) : 'No house template matches this market';
          tamperCache.set(m.id, { sig, reason: r });
        }).catch(() => {});
        reason = null;
      } else {
        reason = expected ? E.houseMarketMismatch(m, expected) : 'No house template matches this market';
      }
    }
  } catch (e) {
    reason = null; // never block betting because our own check crashed
  }
  tamperCache.set(m.id, { sig, reason });
  return reason;
}

// ---------------------------------------------------------------- status
export const CLOSING_SOON_MS = 2 * 3_600_000;

export function statusInfo(m, now, { long = false } = {}) {
  const phase = E.marketPhase(m, now);
  switch (phase) {
    case 'open': {
      const soon = m.closesAt - now < CLOSING_SOON_MS;
      return { phase, cls: soon ? 'status-soon' : 'status-open', html: `${long ? 'Betting closes in ' : 'Closes in '}${countdown(m.closesAt, 'closed')}` };
    }
    case 'closed':
      return { phase, cls: 'status-closed', html: 'Needs result' };
    case 'reported':
      return { phase, cls: 'status-reported', html: long
        ? `Reported · final in ${countdown(m.reportedAt + E.CHALLENGE_WINDOW_MS)}`
        : `Reported · ${countdown(m.reportedAt + E.CHALLENGE_WINDOW_MS)}` };
    case 'challenged':
      return { phase, cls: 'status-challenged', html: long
        ? `Disputed · vote ends in ${countdown(m.challengedAt + E.VOTE_WINDOW_MS)}`
        : `Disputed · ${countdown(m.challengedAt + E.VOTE_WINDOW_MS)}` };
    case 'resolved':
      return { phase, cls: 'status-resolved', html: `<span class="ellipsis">Resolved · ${esc(resultLabel(m, { short: true }))}</span>` };
    case 'void':
      return { phase, cls: 'status-void', html: 'Void · refunded' };
    default:
      return { phase, cls: '', html: esc(phase) };
  }
}
export function statusChip(m, now, opts) {
  const s = statusInfo(m, now, opts);
  return `<span class="status ${s.cls}">${s.html}</span>`;
}

// ---------------------------------------------------------------- outcome rows (cards, sheet)
export function outcomeRows(m, { max = 4, highlight = true } = {}) {
  const opts = m.options || [];
  const probs = outcomeProbs(m);
  const winId = m.status === 'resolved' ? m.resolvedOptionId : null;
  const shown = opts.slice(0, opts.length > max ? max - 1 : max);
  const rows = shown.map((o) => {
    const idx = opts.indexOf(o);
    const p = probs[o.id];
    const pct = p == null ? 0 : Math.max(0, Math.min(100, p * 100));
    const odds = E.displayOdds(m, o.id);
    const cls = [
      highlight && winId && winId === o.id ? 'is-winner' : '',
      highlight && winId && winId !== o.id ? 'is-dim' : '',
      highlight && (m.status === 'reported' || m.status === 'challenged') && m.kind !== 'timer' && m.reportedOptionId === o.id ? 'is-reported' : '',
    ].join(' ');
    return `<li class="out ${cls}" style="--c:${optionColor(m, o, idx)};--p:${pct.toFixed(1)}%">
      <span class="o-label">${esc(o.label)}</span>
      <span class="o-pct">${p == null ? '—' : esc(fmtPct(p))}</span>
      <span class="o-odds">${esc(fmtOdds(odds))}</span>
    </li>`;
  }).join('');
  const more = opts.length - shown.length;
  return `<ul class="outs" aria-label="Outcomes">${rows}</ul>${more > 0 ? `<div class="outs-more">+${more} more option${more > 1 ? 's' : ''}</div>` : ''}`;
}

/** Who may report this market (UI-level; economy.validateReport is the real check). */
export function reportRole(m, player) {
  if (!player) return 'none';
  if (m.type === 'custom') return m.createdBy === player.uid ? 'creator' : 'none';
  return 'anyone';
}

// Markets tab: filter chips + keyed market cards.
// Cards are rebuilt only when their signature changes, and never while one of their
// inputs has focus (so typing amounts / picking winners isn't interrupted by live updates).
// Draft input values live in `drafts`, so a rebuild never loses what the user typed.
import * as E from '../economy.js';
import { esc, fmtDuration, fmtOdds, fmtDateTime, errMsg, parseAmount, fromLocalInput, toLocalInput, toast } from './util.js';

const fmt = (n) => E.formatSonnetous(n);
const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'awaiting', label: 'Awaiting result' },
  { id: 'settled', label: 'Settled' },
];

const drafts = new Map(); // marketId -> { optionId, amount, eventAt, winner, detailsOpen }
function draft(id) {
  let d = drafts.get(id);
  if (!d) {
    d = { optionId: null, amount: '', eventAt: '', winner: '', detailsOpen: false };
    drafts.set(id, d);
  }
  return d;
}

export function resetMarketDrafts() {
  drafts.clear();
}

function bucketOf(phase) {
  return phase === 'open' ? 'open' : phase === 'awaiting' ? 'awaiting' : 'settled';
}

export function createMarketsView(panel, ctx) {
  panel.innerHTML = `
    <div class="filters" role="group" aria-label="Filter markets"></div>
    <p class="empty" hidden></p>
    <div class="market-list"></div>`;
  const filtersEl = panel.querySelector('.filters');
  const emptyEl = panel.querySelector('.empty');
  const listEl = panel.querySelector('.market-list');
  const cards = new Map(); // marketId -> { el, sig }

  filtersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    ctx.state.filter = btn.dataset.filter;
    ctx.rerender();
  });
  // when a focused card loses focus, catch up on any updates we skipped
  listEl.addEventListener('focusout', () => setTimeout(ctx.rerender, 0));

  function render() {
    const { state } = ctx;
    const now = Date.now();
    const byMarket = new Map();
    for (const b of state.bets) {
      if (!byMarket.has(b.marketId)) byMarket.set(b.marketId, []);
      byMarket.get(b.marketId).push(b);
    }

    const counts = { open: 0, awaiting: 0, settled: 0 };
    const phases = new Map();
    for (const m of state.markets) {
      const p = E.marketPhase(m, now);
      phases.set(m.id, p);
      counts[bucketOf(p)]++;
    }

    filtersEl.innerHTML = FILTERS.map((f) => `
      <button type="button" class="chip-filter${state.filter === f.id ? ' active' : ''}" data-filter="${f.id}"
        aria-pressed="${state.filter === f.id}">${esc(f.label)} <span class="count">${counts[f.id]}</span></button>`).join('');

    const list = state.markets.filter((m) => bucketOf(phases.get(m.id)) === state.filter);
    if (state.filter === 'open') list.sort((a, b) => a.closesAt - b.closesAt);
    else if (state.filter === 'awaiting') list.sort((a, b) => a.closesAt - b.closesAt);
    else list.sort((a, b) => (b.resolvedAt || b.openedAt) - (a.resolvedAt || a.openedAt));

    if (!ctx.loaded.markets) {
      emptyEl.hidden = false;
      emptyEl.textContent = 'Loading markets…';
    } else if (!list.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = {
        open: 'No open markets right now. Create one on the Create tab!',
        awaiting: 'Nothing is waiting for a result.',
        settled: 'No settled markets yet.',
      }[state.filter];
    } else {
      emptyEl.hidden = true;
    }

    const keep = new Set(list.map((m) => m.id));
    for (const [id, entry] of cards) {
      if (!keep.has(id)) { entry.el.remove(); cards.delete(id); }
    }

    const wanted = [];
    for (const m of list) {
      const phase = phases.get(m.id);
      const mBets = byMarket.get(m.id) || [];
      const sig = JSON.stringify([
        m, phase, state.user.uid, state.user.balance,
        mBets.map((b) => [b.id, b.status, b.payout, b.taxed]),
        E.utcDayKey(now),
      ]);
      let entry = cards.get(m.id);
      if (!entry) {
        entry = { el: document.createElement('article'), sig: null };
        entry.el.dataset.id = m.id;
        attachCardHandlers(entry.el, ctx);
        cards.set(m.id, entry);
      }
      const ae = document.activeElement;
      const busy = ae && entry.el.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
      if (entry.sig !== sig && !busy) {
        fillCard(entry.el, m, phase, mBets, ctx, now);
        entry.sig = sig;
      }
      wanted.push(entry.el);
    }
    wanted.forEach((el, i) => {
      if (listEl.children[i] !== el) listEl.insertBefore(el, listEl.children[i] || null);
    });
  }

  return { render };
}

// ------------------------------------------------------------------ card HTML
function fillCard(el, m, phase, mBets, ctx, now) {
  const { user } = ctx.state;
  const today = m.type === 'auto' && String(m.id).startsWith(`auto-${E.utcDayKey(now)}-`);
  el.className = `card market phase-${phase}${today ? ' today' : ''}`;
  el.innerHTML = cardHTML(m, phase, mBets, user, today, now);
  const det = el.querySelector('details.bettors');
  if (det) det.addEventListener('toggle', () => { draft(m.id).detailsOpen = det.open; });
  updateBetUI(el, m, ctx);
}

function cardHTML(m, phase, mBets, user, today, now) {
  const d = draft(m.id);
  const canBet = phase === 'open';
  const mine = mBets.filter((b) => b.uid === user.uid);
  const stake = {};
  for (const b of mine) stake[b.optionId] = (stake[b.optionId] || 0) + b.amount;

  const isCreator = m.type === 'custom' && m.createdBy === user.uid;
  const live = phase === 'open' || phase === 'awaiting';
  const canResolve = live && (m.type === 'auto' || isCreator);
  const canVoid = live && isCreator;
  const broke = user.balance < 1;

  const source = m.type === 'auto'
    ? '<span class="badge badge-house">🏠 House</span>'
    : `<span class="badge badge-custom">by ${esc(m.createdByName)}</span>`;

  let status;
  if (phase === 'open') {
    status = `<span class="status status-open">⏳ Closes in <b data-countdown="${Number(m.closesAt)}" data-done="0s">${esc(fmtDuration(m.closesAt - now))}</b></span>`;
  } else if (phase === 'awaiting') {
    status = '<span class="status status-await">⌛ Awaiting result</span>';
  } else if (phase === 'resolved') {
    const win = m.options.find((o) => o.id === m.resolvedOptionId);
    const by = m.resolvedBy === 'auto' ? 'auto-settled' : `settled by ${esc(m.resolvedBy || '?')}`;
    status = `<span class="status status-done">🏆 ${esc(win ? win.label : 'Settled')}</span>`
      + (m.kind === 'timer' && m.eventAt ? `<span class="status-sub">Happened ${esc(fmtDateTime(m.eventAt))}</span>` : '')
      + `<span class="status-sub">${by}</span>`;
  } else {
    status = '<span class="status status-void">↩ Void — everyone refunded</span>';
  }

  const options = m.options.map((o) => {
    const odds = E.displayOdds(m, o.id);
    const total = (m.optionTotals && m.optionTotals[o.id]) || 0;
    const winner = phase === 'resolved' && o.id === m.resolvedOptionId;
    const selected = canBet && d.optionId === o.id;
    const meta = `<span class="opt-meta">Pool ${esc(fmt(total))}${stake[o.id] ? ` · <span class="mine">Your stake ${esc(fmt(stake[o.id]))}</span>` : ''}</span>`;
    const inner = `<span class="opt-label">${winner ? '🏆 ' : ''}${esc(o.label)}</span>`
      + `<span class="opt-odds">${esc(fmtOdds(odds))}</span>${meta}`;
    const cls = `opt${selected ? ' selected' : ''}${winner ? ' winner' : ''}${phase === 'resolved' && !winner ? ' loser' : ''}`;
    return canBet
      ? `<button type="button" class="${cls}" data-action="pick" data-opt="${esc(o.id)}" role="radio" aria-checked="${selected}">${inner}</button>`
      : `<div class="${cls}">${inner}</div>`;
  }).join('');

  let result = '';
  if ((phase === 'resolved' || phase === 'void') && mine.length) {
    const staked = mine.reduce((s, b) => s + b.amount, 0);
    const paid = mine.reduce((s, b) => s + (b.payout || 0), 0);
    const net = paid - staked;
    result = `<p class="my-result ${net > 0 ? 'win' : net < 0 ? 'loss' : ''}">Your result: ${net > 0 ? '+' : net < 0 ? '−' : ''}${esc(fmt(Math.abs(net)))} on ${esc(fmt(staked))} staked</p>`;
  }

  let betUI = '';
  if (canBet) {
    betUI = `
      <div class="bet">
        ${broke ? '<p class="note">You\'re out of sonnetous — nothing to bet with.</p>' : ''}
        <div class="bet-row">
          <label class="amount"><span class="sr-only">Bet amount</span><span class="sym">§</span>
            <input type="number" inputmode="numeric" min="1" step="1" placeholder="Amount" data-role="amount"
              value="${esc(d.amount)}" ${broke ? 'disabled' : ''}></label>
          <div class="chips" role="group" aria-label="Quick amounts">
            <button type="button" class="chip" data-action="chip" data-chip="10" ${broke ? 'disabled' : ''}>10</button>
            <button type="button" class="chip" data-action="chip" data-chip="50" ${broke ? 'disabled' : ''}>50</button>
            <button type="button" class="chip" data-action="chip" data-chip="100" ${broke ? 'disabled' : ''}>100</button>
            <button type="button" class="chip" data-action="chip" data-chip="half" ${broke ? 'disabled' : ''}>½</button>
            <button type="button" class="chip chip-allin" data-action="chip" data-chip="all" ${broke ? 'disabled' : ''}>All-in</button>
          </div>
        </div>
        <p class="preview" data-role="preview" aria-live="polite"></p>
        <button type="button" class="btn primary" data-action="bet" disabled>Place bet</button>
      </div>`;
  } else if (phase === 'awaiting') {
    betUI = '<p class="note">Betting is closed. Waiting for someone to report the result.</p>';
  }

  let resolveUI = '';
  if (canResolve || canVoid) {
    let body = '';
    if (canResolve && m.kind === 'timer') {
      body = `
        <label class="field-inline">When did it happen?
          <input type="datetime-local" data-role="eventAt" value="${esc(d.eventAt || toLocalInput(now))}">
        </label>
        <button type="button" class="btn success" data-action="resolve-timer">It happened!</button>`;
    } else if (canResolve) {
      body = `
        <label class="field-inline">Winning option
          <select data-role="winner">
            <option value="">Choose winner…</option>
            ${m.options.map((o) => `<option value="${esc(o.id)}"${d.winner === o.id ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="btn success" data-action="resolve-choice">Declare winner</button>`;
    }
    if (canVoid) body += '<button type="button" class="btn danger" data-action="void">Void &amp; refund</button>';
    resolveUI = `
      <div class="resolve">
        <h4>${m.type === 'auto' ? 'Report the result (anyone can)' : 'Resolve (creator only)'}</h4>
        <div class="resolve-row">${body}</div>
      </div>`;
  }

  const bettors = [...mBets].sort((a, b) => b.placedAt - a.placedAt);
  const bettorRows = bettors.map((b) => {
    const res = b.status === 'won' ? `<span class="win">+${esc(fmt(b.payout - b.amount))}</span>`
      : b.status === 'lost' ? '<span class="loss">lost</span>'
        : b.status === 'void' ? '<span class="muted">refunded</span>' : '';
    return `<li class="${b.uid === user.uid ? 'me' : ''}"><span class="who">${esc(b.username)}</span>
      <span class="what">${esc(b.optionLabel)}</span><span class="amt">${esc(fmt(b.amount))}</span>${res}</li>`;
  }).join('');
  const bettorsUI = `
    <details class="bettors"${d.detailsOpen ? ' open' : ''}>
      <summary>Bettors (${bettors.length})</summary>
      ${bettors.length ? `<ul>${bettorRows}</ul>` : '<p class="muted small">No bets yet. Be the first degenerate.</p>'}
    </details>`;

  return `
    ${today ? '<div class="ribbon">🔥 Today\'s House Market</div>' : ''}
    <header class="card-head">
      <span class="emoji" aria-hidden="true">${esc(m.emoji || '🎲')}</span>
      <div class="titles">
        <h3>${esc(m.title)}</h3>
        <div class="badges">
          <span class="badge badge-kind">${m.kind === 'timer' ? '⏱ Timer' : '☑ Choice'}</span>
          <span class="badge badge-mode">${m.mode === 'fixed' ? 'Fixed odds' : 'Pool'}</span>
          ${source}
          ${m.category ? `<span class="badge badge-cat">${esc(m.category)}</span>` : ''}
        </div>
      </div>
    </header>
    ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
    <div class="statusline">${status}</div>
    <div class="options" role="radiogroup" aria-label="Options">${options}</div>
    <p class="pool-line">Total pool <b>${esc(fmt(m.totalPool || 0))}</b> · ${Number(m.betCount) || 0} bet${m.betCount === 1 ? '' : 's'}</p>
    ${result}
    ${betUI}
    ${resolveUI}
    ${bettorsUI}`;
}

// ------------------------------------------------------------------ interaction
function marketById(ctx, id) {
  return ctx.state.markets.find((x) => x.id === id);
}

function updateBetUI(el, m, ctx) {
  const preview = el.querySelector('[data-role=preview]');
  const btn = el.querySelector('[data-action=bet]');
  if (!preview || !btn) return;
  const { user } = ctx.state;
  const d = draft(m.id);
  const opt = m.options.find((o) => o.id === d.optionId);
  const amount = parseAmount(d.amount);
  let err = null;
  let html;
  if (user.balance < 1) {
    err = 'broke';
    html = 'You have nothing left to bet.';
  } else if (!opt) {
    err = 'no option';
    html = 'Pick an option to bet on.';
  } else if (!Number.isInteger(amount) || amount < 1) {
    err = 'no amount';
    html = String(d.amount ?? '').trim() === ''
      ? `How much on <b>${esc(opt.label)}</b>?`
      : 'Enter a whole-number amount.';
  } else {
    err = E.validateBet(user, m, opt.id, amount, Date.now());
    html = err
      ? `<span class="loss">${esc(err)}</span>`
      : `Bet <b>${esc(fmt(amount))}</b> on <b>${esc(opt.label)}</b> → win up to <b class="gold">${esc(fmt(E.potentialPayout(m, opt.id, amount)))}</b>`;
  }
  preview.innerHTML = html;
  btn.disabled = !!err || btn.dataset.busy === '1';
}

function attachCardHandlers(el, ctx) {
  const marketOf = () => marketById(ctx, el.dataset.id);

  el.addEventListener('input', (e) => {
    const m = marketOf();
    if (!m) return;
    const role = e.target.dataset && e.target.dataset.role;
    const d = draft(m.id);
    if (role === 'amount') { d.amount = e.target.value; updateBetUI(el, m, ctx); }
    else if (role === 'eventAt') d.eventAt = e.target.value;
    else if (role === 'winner') d.winner = e.target.value;
  });
  el.addEventListener('change', (e) => {
    const m = marketOf();
    if (!m) return;
    const role = e.target.dataset && e.target.dataset.role;
    const d = draft(m.id);
    if (role === 'eventAt') d.eventAt = e.target.value;
    else if (role === 'winner') d.winner = e.target.value;
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !el.contains(btn)) return;
    const m = marketOf();
    if (!m) return;
    const store = ctx.getStore();
    const { user } = ctx.state;
    const d = draft(m.id);
    const action = btn.dataset.action;

    if (action === 'pick') {
      d.optionId = btn.dataset.opt;
      el.querySelectorAll('[data-action=pick]').forEach((b) => {
        const on = b.dataset.opt === d.optionId;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
      });
      updateBetUI(el, m, ctx);
      return;
    }

    if (action === 'chip') {
      const c = btn.dataset.chip;
      const bal = Math.floor(user.balance);
      let amt = c === 'half' ? Math.max(1, Math.floor(bal / 2)) : c === 'all' ? bal : Math.min(Number(c), bal);
      if (amt < 1) return;
      d.amount = String(amt);
      const input = el.querySelector('[data-role=amount]');
      if (input) input.value = d.amount;
      updateBetUI(el, m, ctx);
      return;
    }

    try {
      if (action === 'bet') {
        const amount = parseAmount(d.amount);
        btn.dataset.busy = '1';
        btn.disabled = true;
        const optionLabel = (m.options.find((o) => o.id === d.optionId) || {}).label || '';
        try {
          await store.placeBet(m.id, d.optionId, amount);
          d.amount = '';
          toast(`Bet placed: ${fmt(amount)} on “${optionLabel}”. Good luck!`, 'success');
        } finally {
          btn.dataset.busy = '0';
        }
        const fresh = marketOf();
        const input = el.querySelector('[data-role=amount]');
        if (input) input.value = d.amount;
        if (fresh) updateBetUI(el, fresh, ctx);
        ctx.rerender();
      } else if (action === 'resolve-timer') {
        const input = el.querySelector('[data-role=eventAt]');
        const now = Date.now();
        // untouched input means "right now" (the field's default is only minute-accurate)
        const eventAt = d.eventAt ? fromLocalInput(input ? input.value : d.eventAt) : now;
        if (!Number.isFinite(eventAt)) throw new Error('Pick a valid date and time.');
        if (eventAt > now + 120000) throw new Error("The event can't be in the future.");
        if (eventAt < m.openedAt) throw new Error('The event happened before this market opened — it can\'t be counted.');
        if (!confirm(`Report that this happened ${d.eventAt ? 'at ' + fmtDateTime(eventAt) : 'just now'}? Bets will be settled immediately.`)) return;
        await store.resolveMarket(m.id, null, eventAt);
        toast('Market settled. Payouts sent!', 'success');
      } else if (action === 'resolve-choice') {
        const sel = el.querySelector('[data-role=winner]');
        const winner = (sel && sel.value) || d.winner;
        if (!winner) throw new Error('Choose the winning option first.');
        const label = (m.options.find((o) => o.id === winner) || {}).label || winner;
        if (!confirm(`Declare “${label}” the winner? Bets will be settled immediately.`)) return;
        await store.resolveMarket(m.id, winner);
        toast('Market settled. Payouts sent!', 'success');
      } else if (action === 'void') {
        if (!confirm('Void this market and refund every bet?')) return;
        await store.voidMarket(m.id);
        toast('Market voided. Everyone was refunded.', 'success');
      }
    } catch (err) {
      toast(errMsg(err), 'error');
      const fresh = marketOf();
      if (fresh) updateBetUI(el, fresh, ctx);
    }
  });
}

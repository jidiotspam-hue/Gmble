// Markets tab (featured strip, filters, search, card grid) and the market detail sheet
// (bet slip, report / challenge / vote lifecycle, rules, bettors).
import {
  esc, errMsg, money, signedMoney, fmtOdds, fmtPct, fmtDateTime, toLocalInput, fromLocalInput, parseAmount,
  isHttpUrl, patch, sigOf, trackDirty, withBusy, toast, openDialog, confirmDialog, countdown, ago, avatarHtml, bump,
} from './util.js';
import {
  optionColor, outcomeProbs, optionLabel, isHouse, isToday, isFeatured, tamperReason, statusChip,
  outcomeRows, reportRole, resultLabel, reportLabel, timerVerdict,
} from './model.js';

const FILTERS = [
  { id: 'open', label: 'Open', icon: '🟢' },
  { id: 'closing', label: 'Closing soon', icon: '⏳' },
  { id: 'needs', label: 'Needs result', icon: '📝' },
  { id: 'disputed', label: 'Disputed', icon: '⚖️' },
  { id: 'settled', label: 'Settled', icon: '🏁' },
];
const CLOSING_WINDOW_MS = 24 * 3_600_000;

function matchesFilter(E, m, f, now) {
  const phase = E.marketPhase(m, now);
  switch (f) {
    case 'open': return phase === 'open';
    case 'closing': return phase === 'open' && m.closesAt - now < CLOSING_WINDOW_MS;
    case 'needs': return phase === 'closed';
    case 'disputed': return phase === 'reported' || phase === 'challenged';
    case 'settled': return phase === 'resolved' || phase === 'void';
    default: return true;
  }
}

function sortFor(f, list) {
  const by = (fn) => list.slice().sort(fn);
  switch (f) {
    case 'closing': return by((a, b) => a.closesAt - b.closesAt);
    case 'needs': return by((a, b) => b.closesAt - a.closesAt);
    case 'disputed': return by((a, b) => (b.status === 'challenged') - (a.status === 'challenged') || (b.reportedAt || 0) - (a.reportedAt || 0));
    case 'settled': return by((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
    default: return list;
  }
}

// ===================================================================== card
export function cardHtml(ctx, m, now, { featured = false } = {}) {
  const { E } = ctx;
  const d = ctx.derived();
  const mine = (d.myBetsByMarket.get(m.id) || []).filter((b) => b.status === 'open');
  const myStake = mine.reduce((a, b) => a + b.amount, 0);
  const tampered = tamperReason(m);
  const flags = [];
  if (isFeatured(m)) flags.push('<span class="badge badge-gold">★ Featured</span>');
  else if (isToday(m, now)) flags.push('<span class="badge badge-gold">🏠 Today</span>');
  if (m.oracle) flags.push('<span class="badge badge-info">🤖 Auto-checked</span>');
  if (tampered) flags.push('<span class="badge badge-loss" title="' + esc(tampered) + '">⚠ Tampered</span>');
  if (myStake) {
    const labels = [...new Set(mine.map((b) => b.optionLabel))];
    flags.push(`<span class="badge badge-violet mine-tag"><span>You: ${esc(money(myStake))} on ${esc(labels.join(', '))}</span></span>`);
  }
  const meta = [esc(m.category || (isHouse(m) ? 'House' : 'Custom')),
    isHouse(m) ? 'House' : `by ${esc(m.createdByName || 'someone')}`,
    m.kind === 'timer' ? '⏱ Timer' : ''].filter(Boolean);
  const cls = ['mcard', featured || isFeatured(m) || isToday(m, now) ? 'is-featured' : '', tampered ? 'is-tampered' : ''].join(' ');
  return `<article class="${cls}" data-id="${esc(m.id)}">
    <div class="mcard-top">
      <div class="emoji-tile" aria-hidden="true">${esc(m.emoji || '🎲')}</div>
      <div class="grow">
        <div class="mcard-meta">${meta.map((x) => `<span>${x}</span>`).join('<span class="sep" aria-hidden="true">•</span>')}</div>
        <h3 class="mcard-title"><a class="mcard-link" href="#market" data-open="${esc(m.id)}">${esc(m.title)}</a></h3>
      </div>
    </div>
    ${flags.length ? `<div class="mcard-flags">${flags.join('')}</div>` : ''}
    ${outcomeRows(m, { max: 4 })}
    <div class="mcard-foot">
      <div class="mcard-stats">
        <span class="pool"><b>${esc(money(m.totalPool || 0))}</b> ${m.mode === 'pool' ? 'pool' : 'staked'}</span>
        <span><b>${Number(m.betCount) || 0}</b> bet${m.betCount === 1 ? '' : 's'}</span>
      </div>
      ${statusChip(m, now)}
    </div>
  </article>`;
}

/** Keyed list reconciliation: only changed cards are replaced; unchanged DOM (and focus) is kept. */
function reconcile(container, items) {
  const existing = new Map();
  for (const el of [...container.children]) if (el.dataset.id) existing.set(el.dataset.id, el);
  const want = new Set(items.map((i) => i.key));
  for (const [k, el] of existing) if (!want.has(k)) el.remove();
  let prev = null;
  for (const { key, html } of items) {
    let el = existing.get(key);
    const sig = sigOf(html);
    if (!el || el.__html !== sig) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild;
      fresh.__html = sig;
      const hadFocus = el && el.contains(document.activeElement);
      if (el) el.replaceWith(fresh);
      else container.appendChild(fresh);
      el = fresh;
      if (hadFocus) { const l = el.querySelector('.mcard-link'); if (l) l.focus({ preventScroll: true }); }
    }
    const expectedPrev = prev ? prev.nextElementSibling : container.firstElementChild;
    if (expectedPrev !== el) {
      if (prev) prev.after(el); else container.prepend(el);
    }
    prev = el;
  }
}

// ===================================================================== markets view
export function createMarketsView(panel, ctx) {
  const ui = { filter: 'open', category: 'all', search: '' };
  panel.innerHTML = `
    <div class="page-head">
      <div><h1>Markets</h1><p>Pick a side. Put your sonnetous where your mouth is.</p></div>
      <button type="button" class="btn btn-primary desk-only" data-go-create><span class="ico" aria-hidden="true">✨</span> New market</button>
    </div>
    <div class="toolbar">
      <div class="toolbar-row">
        <label class="search"><span class="sr-only">Search markets</span>
          <input class="input" type="search" data-key="search" placeholder="Search markets, people, categories…" autocomplete="off" enterkeyhint="search">
        </label>
      </div>
      <div class="scroller" role="group" aria-label="Filter markets" data-sec="filters"></div>
      <div class="scroller" role="group" aria-label="Categories" data-sec="cats"></div>
    </div>
    <div data-sec="featured"></div>
    <div data-sec="list"></div>`;
  const sec = (n) => panel.querySelector(`[data-sec="${n}"]`);
  const searchInput = panel.querySelector('[data-key=search]');

  panel.querySelector('[data-go-create]').addEventListener('click', () => ctx.setTab('create'));
  searchInput.addEventListener('input', () => { ui.search = searchInput.value; ctx.rerender(); });
  panel.addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { ui.filter = f.dataset.filter; ui.category = 'all'; ctx.rerender(); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { ui.category = c.dataset.cat; ctx.rerender(); return; }
    const open = e.target.closest('[data-open]');
    if (open) { e.preventDefault(); ctx.openMarket(open.dataset.open, open); return; }
    const card = e.target.closest('article.mcard');
    if (card && !e.target.closest('a, button')) ctx.openMarket(card.dataset.id, card.querySelector('.mcard-link'));
    const clr = e.target.closest('[data-clear]');
    if (clr) { ui.search = ''; searchInput.value = ''; ui.category = 'all'; ctx.rerender(); }
  });

  function render() {
    const { E, state } = ctx;
    const now = ctx.now();
    const all = state.markets;

    // filters with counts
    const counts = Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((m) => matchesFilter(E, m, f.id, now)).length]));
    const me = ctx.me();
    const d = ctx.derived();
    const voteable = all.filter((m) => m.status === 'challenged'
      && !E.validateVote(me, m, { hasStake: d.myBetsByMarket.has(m.id), hasVoted: d.myVotes.has(m.id) }, now)).length;
    patch(sec('filters'), FILTERS.map((f) => `<button type="button" class="chip" data-filter="${f.id}" aria-pressed="${ui.filter === f.id}">
      ${esc(f.label)} <span class="count${f.id === 'disputed' && voteable ? ' hot' : ''}">${counts[f.id]}</span></button>`).join(''));

    let list = all.filter((m) => matchesFilter(E, m, ui.filter, now));
    const cats = [...new Set(list.map((m) => m.category || 'Other'))].sort();
    patch(sec('cats'), cats.length > 1
      ? [`<button type="button" class="chip cat-chip" data-cat="all" aria-pressed="${ui.category === 'all'}">All</button>`,
        ...cats.map((c) => `<button type="button" class="chip cat-chip" data-cat="${esc(c)}" aria-pressed="${ui.category === c}">${esc(c)}</button>`)].join('')
      : '');
    if (ui.category !== 'all') list = list.filter((m) => (m.category || 'Other') === ui.category);
    const q = ui.search.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => [m.title, m.description, m.category, m.createdByName, ...(m.options || []).map((o) => o.label)]
        .some((s) => String(s || '').toLowerCase().includes(q)));
    }
    list = sortFor(ui.filter, list);

    // featured strip: today's house markets, only on the unfiltered Open view
    const showFeatured = ui.filter === 'open' && ui.category === 'all' && !q;
    const featured = showFeatured
      ? list.filter((m) => isToday(m, now)).sort((a, b) => isFeatured(b) - isFeatured(a))
      : [];
    const featuredIds = new Set(featured.map((m) => m.id));
    const featEl = sec('featured');
    if (featured.length) {
      if (!featEl.querySelector('.featured-grid')) {
        featEl.innerHTML = `<section class="featured" aria-labelledby="feat-h">
          <div class="featured-head"><h2 id="feat-h"><span aria-hidden="true">🎰</span> Today's house markets</h2>
          <span class="sub">Fresh every day at midnight UTC · anyone can report the result</span></div>
          <div class="featured-grid"></div></section>`;
      }
      reconcile(featEl.querySelector('.featured-grid'), featured.map((m) => ({ key: m.id, html: cardHtml(ctx, m, now, { featured: true }) })));
    } else if (featEl.innerHTML) featEl.innerHTML = '';

    const rest = list.filter((m) => !featuredIds.has(m.id));
    const listEl = sec('list');
    if (!state.loaded.markets) {
      patch(listEl, `<div class="grid" aria-busy="true" aria-label="Loading markets">${Array.from({ length: 6 }, () => `
        <div class="skel-card"><div class="row"><div class="skel" style="width:44px;height:44px;border-radius:12px"></div>
        <div class="grow stack" style="gap:8px"><div class="skel skel-line" style="width:40%"></div><div class="skel skel-line" style="width:90%"></div></div></div>
        <div class="skel" style="height:34px"></div><div class="skel" style="height:34px"></div><div class="skel skel-line" style="width:60%;margin-top:8px"></div></div>`).join('')}</div>`);
      return;
    }
    if (!rest.length) {
      if (featured.length) { patch(listEl, ''); return; }
      patch(listEl, emptyHtml(ui, q, all.length));
      return;
    }
    if (!listEl.querySelector(':scope > .grid[data-cards]')) {
      listEl.innerHTML = `${featured.length ? '<h2 class="section-title">All open markets</h2>' : ''}<div class="grid" data-cards></div>`;
      listEl.__html = null;
    }
    const h = listEl.querySelector('.section-title');
    if (featured.length && !h) listEl.insertAdjacentHTML('afterbegin', '<h2 class="section-title">All open markets</h2>');
    if (!featured.length && h) h.remove();
    reconcile(listEl.querySelector('.grid[data-cards]'), rest.map((m) => ({ key: m.id, html: cardHtml(ctx, m, now) })));
  }

  function emptyHtml(ui2, q, total) {
    if (q || ui2.category !== 'all') {
      return `<div class="empty"><div class="empty-ico" aria-hidden="true">🔎</div><h3>No matches</h3>
        <p>Nothing here matches “${esc(q || ui2.category)}”.</p><button type="button" class="btn btn-outline" data-clear>Clear search</button></div>`;
    }
    const copy = {
      open: ['🎲', 'No open markets', total ? 'Everything is closed. Start something — anything.' : 'The house is setting up today’s markets… or be first and create one.'],
      closing: ['⏳', 'Nothing closing soon', 'No open market closes within 24 hours.'],
      needs: ['📝', 'No results needed', 'When betting closes on a market, it shows up here until someone reports what happened.'],
      disputed: ['⚖️', 'No disputes', 'Reported results you can challenge, and disputes you can vote on, show up here.'],
      settled: ['🏁', 'Nothing settled yet', 'Finished markets and their payouts will land here.'],
    }[ui2.filter];
    return `<div class="empty"><div class="empty-ico" aria-hidden="true">${copy[0]}</div><h3>${esc(copy[1])}</h3><p>${esc(copy[2])}</p>
      ${ui2.filter === 'open' ? '<button type="button" class="btn btn-primary" data-go-create2>✨ Create a market</button>' : ''}</div>`;
  }
  panel.addEventListener('click', (e) => { if (e.target.closest('[data-go-create2]')) ctx.setTab('create'); });

  return {
    render,
    reset() { ui.filter = 'open'; ui.category = 'all'; ui.search = ''; searchInput.value = ''; },
    setFilter(f) { ui.filter = f; },
  };
}

// ===================================================================== detail sheet
export function createSheet(dlg, ctx) {
  const head = dlg.querySelector('#sheet-head');
  const body = dlg.querySelector('#sheet-body');
  let currentId = null;
  let skeletonFor = null;
  const drafts = new Map(); // marketId -> { opt }
  let slipTimer = null;
  trackDirty(body);

  dlg.addEventListener('close', () => { currentId = null; skeletonFor = null; });
  head.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });

  const market = () => (currentId ? ctx.derived().marketsById.get(currentId) : null);
  const draft = () => {
    if (!drafts.has(currentId)) drafts.set(currentId, { opt: null });
    return drafts.get(currentId);
  };

  function open(id, opener) {
    currentId = id;
    skeletonFor = null;
    head.__html = null;
    body.innerHTML = '';
    render();
    openDialog(dlg, opener);
    body.scrollTop = 0;
    const close = head.querySelector('[data-close]');
    if (close) close.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- events
  body.addEventListener('click', async (e) => {
    const m = market();
    if (!m) return;
    const pick = e.target.closest('[data-pick]');
    if (pick && !pick.disabled) {
      draft().opt = pick.dataset.pick;
      for (const p of body.querySelectorAll('[data-pick]')) p.setAttribute('aria-checked', String(p.dataset.pick === draft().opt));
      updateSlip();
      const amt = body.querySelector('[data-key=amount]');
      if (amt && !amt.value) amt.focus({ preventScroll: true });
      return;
    }
    const q = e.target.closest('[data-quick]');
    if (q) {
      const me = ctx.me();
      const amt = body.querySelector('[data-key=amount]');
      const cur = parseAmount(amt.value) || 0;
      const bal = Math.max(0, me.balance || 0);
      let v;
      switch (q.dataset.quick) {
        case 'half': v = Math.floor(bal / 2); break;
        case 'all': v = bal; break;
        default: v = Math.min(bal, (q.dataset.add ? cur : 0) + Number(q.dataset.quick));
      }
      amt.value = v > 0 ? String(v) : '';
      amt.dataset.dirty = '1';
      updateSlip();
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act || act.disabled) return;
    const kind = act.dataset.act;
    if (kind === 'bet') await placeBet(m, act);
    else if (kind === 'report') await report(m, act);
    else if (kind === 'challenge') await ctx.challengeFromOracle(m, act);
    else if (kind === 'vote-up' || kind === 'vote-down') await vote(m, kind === 'vote-up', act);
    else if (kind === 'finalize') await simple(act, () => ctx.store.finalizeMarket(m.id), 'Market finalized. Payouts are being claimed.');
    else if (kind === 'void') {
      const ok = await confirmDialog({ title: 'Void this market?', body: 'Nobody has bet yet, so nothing is refunded. The market closes for good.', confirmLabel: 'Void market', danger: true, icon: '🗑️' });
      if (ok) await simple(act, () => ctx.store.voidMarket(m.id), 'Market voided.');
    }
  });
  body.addEventListener('input', (e) => {
    if (e.target.matches('[data-key=amount]')) updateSlip();
    if (e.target.closest('[data-report]')) updateReport();
  });
  body.addEventListener('change', (e) => {
    if (e.target.closest('[data-report]')) updateReport();
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-key=amount]')) {
      e.preventDefault();
      const b = body.querySelector('[data-act=bet]');
      if (b && !b.disabled) b.click();
    }
  });

  async function simple(btn, fn, okMsg) {
    try {
      await withBusy(btn, fn);
      toast(okMsg, 'success');
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  // ---------------------------------------------------------------- bet slip
  function slipState() {
    const m = market();
    const me = ctx.me();
    const { E } = ctx;
    const now = ctx.now();
    const amtEl = body.querySelector('[data-key=amount]');
    const raw = amtEl ? amtEl.value : '';
    const amount = parseAmount(raw);
    const opt = draft().opt;
    let err = null;
    if (!opt) err = 'Pick an outcome above';
    else if (!raw.trim()) err = 'Enter how much to bet';
    else err = E.validateBet(me, m, opt, amount, now);
    return { m, me, E, now, amount, opt, err, raw };
  }

  function updateSlip() {
    const slip = body.querySelector('[data-slip]');
    if (!slip) return;
    const { m, me, E, now, amount, opt, err } = slipState();
    const cta = slip.querySelector('[data-act=bet]');
    const hint = slip.querySelector('[data-hint]');
    const pv = slip.querySelector('[data-preview]');
    const valid = Number.isInteger(amount) && amount > 0 && opt;
    const label = opt ? optionLabel(m, opt) : '';
    if (valid) {
      const gross = E.potentialPayout(m, opt, amount);
      let tax = 0;
      if (E.penaltyActive(me, now) && gross > amount) tax = Math.floor((gross - amount) * E.PENALTY_TAX);
      const payout = gross - tax;
      pv.classList.remove('is-empty');
      pv.innerHTML = `
        <div class="pv-row"><span>If <b>${esc(label)}</b> wins, you get</span></div>
        <div class="pv-row"><span class="pv-big">${esc(money(payout))}</span><span class="pv-profit">profit ${esc(signedMoney(payout - amount))}</span></div>
        ${tax ? `<div class="pv-note">Includes ${esc(money(tax))} bankruptcy tax (${Math.round(E.PENALTY_TAX * 100)}% of profit).</div>` : ''}
        ${m.mode === 'pool' ? '<div class="pv-note">Pool estimate — the final payout moves as others bet.</div>' : `<div class="pv-note">Odds ${esc(fmtOdds(E.displayOdds(m, opt)))} locked in when you bet.</div>`}`;
    } else {
      pv.classList.add('is-empty');
      pv.innerHTML = `<div class="pv-row"><span>Potential win</span></div><div class="pv-row"><span class="pv-big">§—</span><span class="muted small">pick an outcome & amount</span></div>`;
    }
    if (!cta.classList.contains('is-done')) {
      cta.disabled = !!err;
      cta.innerHTML = valid
        ? `Bet <span class="cta-amt">${esc(money(amount))}</span> on ${esc(label.length > 24 ? label.slice(0, 23) + '…' : label)}`
        : 'Place bet';
    }
    const showErr = err && !(err === 'Pick an outcome above' || err === 'Enter how much to bet');
    hint.textContent = err || (m.mode === 'pool' ? `Pool market · ${money(me.balance)} available` : `${money(me.balance)} available`);
    hint.className = `hint-line${showErr ? ' is-error' : ''}`;
    for (const b of slip.querySelectorAll('[data-quick]')) b.disabled = (me.balance || 0) < 1;
    // re-check once a bet cooldown runs out
    clearTimeout(slipTimer);
    const cool = (me.lastBetAt || 0) + (E.BET_COOLDOWN_MS || 0) - now;
    if (err && /slow down/i.test(err) && cool > 0) slipTimer = setTimeout(updateSlip, cool + 50);
  }

  async function placeBet(m, btn) {
    const { amount, opt, err, E } = slipState();
    if (err) { updateSlip(); return; }
    const label = optionLabel(m, opt);
    try {
      await withBusy(btn, () => ctx.store.placeBet(m.id, opt, amount));
      toast(`Bet placed: ${money(amount)} on ${label}`, 'success', '🎟️');
      ctx.celebrateBet();
      const amt = body.querySelector('[data-key=amount]');
      if (amt) { amt.value = ''; amt.dataset.dirty = '1'; }
      btn.classList.add('is-done');
      btn.innerHTML = '✓ Bet placed!';
      setTimeout(() => { btn.classList.remove('is-done'); updateSlip(); }, 1600);
      const cardEl = document.querySelector(`article.mcard[data-id="${CSS.escape(m.id)}"]`);
      if (cardEl) bump(cardEl, 'is-flash');
      void E;
    } catch (e2) {
      toast(errMsg(e2), 'error');
      updateSlip();
    }
  }

  // ---------------------------------------------------------------- report
  function reportState() {
    const m = market();
    const me = ctx.me();
    const { E } = ctx;
    const now = ctx.now();
    const form = body.querySelector('[data-report]');
    if (!form) return null;
    let optionId = null;
    let eventAt = null;
    if (m.kind === 'timer') {
      // timer reports carry only the event time; every bet is judged from its own placedAt
      eventAt = fromLocalInput(form.querySelector('[data-key=evt]').value);
      if (Number.isFinite(eventAt)) {
        // datetime-local has minute precision; clamp into [openedAt, now] so "just now" works
        if (eventAt < m.openedAt && m.openedAt - eventAt < 60_000) eventAt = m.openedAt;
        if (eventAt > now && eventAt - now < 60_000) eventAt = now;
      }
    } else {
      const r = form.querySelector('input[name=winner]:checked');
      optionId = r ? r.value : null;
    }
    const evidence = (form.querySelector('[data-key=evidence]').value || '').trim();
    let err = null;
    if (m.kind === 'timer' && !Number.isFinite(eventAt)) err = 'Say when it happened';
    else if (m.kind !== 'timer' && !optionId) err = 'Pick the winning outcome';
    else err = E.validateReport(me, m, m.kind === 'timer' ? null : optionId, m.kind === 'timer' ? eventAt : null, now);
    if (!err) {
      if (!evidence && !m.oracle) err = 'Add an evidence link (news article, post, screenshot URL)';
      else if (evidence && !isHttpUrl(evidence)) err = 'Evidence must be a link starting with https://';
      else if (evidence.length > (E.MAX_EVIDENCE_LENGTH || 300)) err = `Evidence link is too long (max ${E.MAX_EVIDENCE_LENGTH || 300} characters)`;
    }
    return { m, me, E, now, optionId, eventAt, evidence, err };
  }

  function updateReport() {
    const st = reportState();
    if (!st) return;
    const form = body.querySelector('[data-report]');
    const derivedEl = form.querySelector('[data-derived]');
    if (derivedEl) {
      derivedEl.innerHTML = Number.isFinite(st.eventAt)
        ? myVerdictsHtml(ctx, st.m, st.eventAt, 'If that time stands')
        : '<span class="muted">Pick when it happened.</span>';
    }
    const hint = form.querySelector('[data-hint]');
    hint.textContent = st.err || (st.m.kind === 'timer'
      ? `Ready — reporting it happened ${fmtDateTime(st.eventAt)}.` : `Ready — reporting “${optionLabel(st.m, st.optionId)}”.`);
    hint.className = `hint-line ${st.err ? 'is-error' : 'is-ok'}`;
    form.querySelector('[data-act=report]').disabled = !!st.err;
  }

  async function report(m, btn) {
    const st = reportState();
    if (!st || st.err) { updateReport(); return; }
    try {
      const timer = m.kind === 'timer';
      await withBusy(btn, () => ctx.store.reportResult(m.id, timer ? null : st.optionId, timer ? st.eventAt : null, st.evidence || null));
      toast(`Result reported: ${timer ? `it happened ${fmtDateTime(st.eventAt)}` : optionLabel(m, st.optionId)}. ${money(st.E.BOND)} bond posted — it comes back if nobody successfully challenges.`, 'success', '📣');
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  async function vote(m, uphold, btn) {
    try {
      await withBusy(btn, () => ctx.store.voteOnDispute(m.id, uphold));
      toast(uphold ? 'Vote cast: uphold the report. 👍' : 'Vote cast: overturn the report. 👎', 'success', '🗳️');
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!currentId) return;
    const m = market();
    if (!m) {
      patch(head, `<div class="grow"><h2 id="sheet-title">Market not found</h2></div>
        <button type="button" class="icon-btn close" data-close aria-label="Close">✕</button>`);
      patch(body, '<div class="empty"><div class="empty-ico">🕳️</div><h3>This market vanished</h3><p>It may still be loading.</p></div>');
      skeletonFor = null;
      return;
    }
    const { E, O } = ctx;
    const now = ctx.now();
    const me = ctx.me();
    const phase = E.marketPhase(m, now);
    const tampered = tamperReason(m);

    // head
    const badges = [statusChip(m, now, { long: true })];
    if (isFeatured(m)) badges.push('<span class="badge badge-gold">★ Featured</span>');
    else if (isToday(m, now)) badges.push('<span class="badge badge-gold">🏠 Today’s house market</span>');
    if (m.oracle) badges.push(`<span class="badge badge-info" title="${esc(oracleDesc(O, m))}"><span>🤖 Auto-checked · ${esc(oracleDesc(O, m))}</span></span>`);
    if (tampered) badges.push(`<span class="badge badge-loss" title="${esc(tampered)}">⚠ Tampered</span>`);
    patch(head, `
      <div class="emoji-tile lg" aria-hidden="true">${esc(m.emoji || '🎲')}</div>
      <div class="grow">
        <div class="mcard-meta"><span>${esc(m.category || 'Market')}</span><span class="sep" aria-hidden="true">•</span>
          <span>${isHouse(m) ? 'House market' : `Created by ${esc(m.createdByName || 'someone')}`}</span>
          <span class="sep" aria-hidden="true">•</span><span>${m.mode === 'pool' ? 'Pool' : 'Fixed odds'}</span></div>
        <h2 id="sheet-title">${esc(m.title)}</h2>
        <div class="sheet-sub">${badges.join('')}</div>
      </div>
      <button type="button" class="icon-btn close" data-close aria-label="Close">✕</button>`);

    // body skeleton (stable per market) — sections patched independently
    if (skeletonFor !== m.id) {
      body.innerHTML = ['alert', 'tamper', 'phase', 'slip', 'early', 'outcomes', 'position', 'rules', 'bettors', 'danger']
        .map((s) => `<section data-sec="${s}"></section>`).join('');
      skeletonFor = m.id;
    }
    const sec = (n) => body.querySelector(`[data-sec="${n}"]`);
    const d = ctx.derived();
    const allBets = d.betsByMarket.get(m.id) || [];
    const myBets = d.myBetsByMarket.get(m.id) || [];

    patch(sec('alert'), oracleAlertHtml(ctx, m, now));
    patch(sec('tamper'), tampered ? `<div class="notice notice-loss"><span class="n-ico" aria-hidden="true">⚠</span>
      <span><b>This house market doesn't match its template</b> (${esc(tampered)}). Betting is disabled — someone may have tampered with it.</span></div>` : '');
    patch(sec('phase'), phaseHtml(ctx, m, now, phase, me, myBets));

    const canBet = phase === 'open' && !tampered;
    patch(sec('slip'), canBet ? slipHtml(ctx, m, now, draft().opt) : '');
    patch(sec('early'), phase === 'open' && m.kind === 'timer' && reportRole(m, me) !== 'none' && now >= (m.reportableAt ?? Infinity) && !m.oracle
      ? `<details class="disclosure" style="margin:0"><summary><span aria-hidden="true">📣</span> It already happened? Report it</summary>
          <div class="disclosure-body">${reportFormHtml(ctx, m, now)}</div></details>` : '');
    patch(sec('outcomes'), !canBet ? `<h3 class="section-title">Outcomes</h3>${outcomeRows(m, { max: 99 })}` : '');
    patch(sec('position'), positionHtml(ctx, m, myBets, now));
    patch(sec('rules'), rulesHtml(ctx, m));
    patch(sec('bettors'), bettorsHtml(ctx, m, allBets, me));
    patch(sec('danger'), m.type === 'custom' && me && m.createdBy === me.uid && m.status === 'open' && !(m.betCount > 0)
      ? `<div class="row between wrap" style="gap:12px;padding-top:4px"><span class="small muted">No bets yet, so you can still take this market down.</span>
          <button type="button" class="btn btn-danger btn-sm" data-act="void">🗑️ Void (no bets yet)</button></div>` : '');

    if (canBet) updateSlip();
    if (body.querySelector('[data-report]')) updateReport();
  }

  return { open, render, close: () => dlg.close(), get currentId() { return currentId; } };
}

function oracleDesc(O, m) {
  try {
    if (O && typeof O.describeOracle === 'function') {
      return String(O.describeOracle(m.oracle, m) || '').replace(/^\s*auto-checked\s*[:·-]\s*/i, '');
    }
  } catch { /* fall through */ }
  return (m.oracle && (m.oracle.label || m.oracle.source)) || 'data feed';
}
function oracleSource(O, m) {
  try {
    if (O && typeof O.sourceLabel === 'function') return String(O.sourceLabel(m.oracle) || '');
  } catch { /* fall through */ }
  return (m.oracle && m.oracle.source) || 'the data source';
}

// ---------------------------------------------------------------- sheet sections
function slipHtml(ctx, m, now, selected) {
  const { E } = ctx;
  const me = ctx.me();
  const probs = outcomeProbs(m);
  const opts = m.options || [];
  const picks = opts.map((o, i) => {
    const p = probs[o.id];
    const odds = E.displayOdds(m, o.id);
    const staked = (m.optionTotals || {})[o.id] || 0;
    return `<button type="button" class="pick" role="radio" aria-checked="${selected === o.id}" data-pick="${esc(o.id)}" data-focus-key="pick-${esc(o.id)}"
        style="--c:${optionColor(m, o, i)};--p:${p == null ? 0 : (p * 100).toFixed(1)}%">
      <span class="p-label">${esc(o.label)}</span><span class="p-pct">${p == null ? '—' : esc(fmtPct(p))}</span>
      <span class="p-sub">${m.mode === 'pool' ? `${esc(money(staked))} in` : (m.kind === 'timer' ? 'from your bet' : 'fixed odds')}</span>
      <span class="p-odds">${esc(fmtOdds(odds))}</span>
      <span class="p-check" aria-hidden="true">✓</span>
    </button>`;
  }).join('');
  return `<div class="slip" data-slip>
    <div class="slip-title"><h3>Place a bet</h3><span class="small muted">${statusChipText(m, now)}</span></div>
    <div class="pick-grid${opts.length === 2 ? ' two' : ''}" role="radiogroup" aria-label="Pick an outcome">${picks}</div>
    ${m.kind === 'timer' ? '<p class="notice notice-info" style="margin:0"><span class="n-ico" aria-hidden="true">⏱</span><span><b>Clock starts when you bet</b> — if it already happened, you get refunded.</span></p>' : ''}
    <div class="amount-row">
      <label class="field-label" for="slip-amount">Amount</label>
      <div class="input-affix"><span class="affix" aria-hidden="true">§</span>
        <input id="slip-amount" class="input" data-key="amount" inputmode="numeric" autocomplete="off" placeholder="0" aria-describedby="slip-hint"></div>
      <div class="quick" role="group" aria-label="Quick amounts">
        <button type="button" data-quick="10">10</button><button type="button" data-quick="50">50</button><button type="button" data-quick="100">100</button>
        <button type="button" data-quick="half">½</button><button type="button" data-quick="all" class="allin">All-in</button>
      </div>
    </div>
    <div class="preview is-empty" data-preview aria-live="polite"></div>
    <button type="button" class="btn btn-primary cta" data-act="bet" data-focus-key="bet" disabled>Place bet</button>
    <p class="hint-line" id="slip-hint" data-hint>${esc(money(me.balance))} available</p>
  </div>`;
}
function statusChipText(m, now) {
  return `closes in ${countdown(m.closesAt, 'now')}`;
}

function reportFormHtml(ctx, m, now) {
  const { E } = ctx;
  const opts = m.options || [];
  const evidenceRequired = !m.oracle;
  const field = m.kind === 'timer'
    ? `<div class="field"><label for="rep-evt">When did it happen?</label>
        <input id="rep-evt" class="input" type="datetime-local" data-key="evt" value="${esc(toLocalInput(now))}" min="${esc(toLocalInput(m.openedAt))}" max="${esc(toLocalInput(now))}">
        <span class="field-hint">Just the time — every bet is judged from the moment it was placed.</span>
        <div class="derived" data-derived></div></div>`
    : `<fieldset class="field"><legend>Which outcome won?</legend>
        <div class="winner-grid">${opts.map((o, i) => `<label class="radio-card" style="--c:${optionColor(m, o, i)}">
          <input type="radio" name="winner" value="${esc(o.id)}" data-keep-checked><span>${esc(o.label)}</span></label>`).join('')}</div></fieldset>`;
  return `<div class="report-form" data-report>
    ${field}
    <div class="field"><label for="rep-evidence">Evidence link${evidenceRequired ? '' : ' <span class="muted">(optional)</span>'}</label>
      <input id="rep-evidence" class="input" type="url" data-key="evidence" inputmode="url" placeholder="https://news.example.com/it-happened" maxlength="${E.MAX_EVIDENCE_LENGTH || 300}" autocomplete="off">
      <span class="field-hint">A news article, post or screenshot that proves it. Everyone can see it.</span></div>
    <div class="bond-note"><span class="coin" aria-hidden="true">§</span><span><b>${esc(money(E.BOND))} bond</b>, refunded unless successfully challenged.</span></div>
    <button type="button" class="btn btn-primary btn-lg btn-block" data-act="report" data-focus-key="report" disabled>📣 Report result · ${esc(money(E.BOND))} bond</button>
    <p class="hint-line" data-hint></p>
  </div>`;
}

function evidenceHtml(m) {
  if (!m.evidence) return '<span class="muted small">No evidence link provided.</span>';
  if (!isHttpUrl(m.evidence)) return `<span class="small dim">Evidence: ${esc(m.evidence)}</span>`;
  let shown = m.evidence;
  try { const u = new URL(m.evidence); shown = u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : ''); } catch { /* keep */ }
  if (shown.length > 60) shown = shown.slice(0, 57) + '…';
  return `<a class="evidence-link" href="${esc(m.evidence)}" target="_blank" rel="noopener noreferrer nofollow">🔗 ${esc(shown)}</a>`;
}

function reportedWhat(m) {
  return `<b class="res">${esc(reportLabel(m))}</b>`;
}

/** For my open bets on a timer/choice market: what happens to each if this result stands. */
function myVerdictsHtml(ctx, m, eventAt, lead = 'If this stands') {
  const me = ctx.me();
  const mine = ((ctx.derived().myBetsByMarket.get(m.id)) || []).filter((b) => b.status === 'open');
  if (!me || !mine.length) return `<span class="muted small">${m.kind === 'timer' ? 'Each bet is judged from the moment it was placed; bets placed after it happened are refunded.' : ''}</span>`;
  const items = mine.map((b) => {
    const v = m.kind === 'timer' ? timerVerdict(b, m, eventAt) : null;
    if (!v) return '';
    const txt = v.status === 'won' ? `<b class="win">wins ${esc(money(v.payout))}</b>`
      : v.status === 'void' ? '<b>refunded</b> <span class="muted">(you bet after it happened)</span>' : '<b class="loss">loses</b>';
    return `<li>${esc(money(b.amount))} on “${esc(b.optionLabel)}” → ${txt}</li>`;
  }).join('');
  return `<div class="small"><span aria-hidden="true">🎯</span> ${esc(lead)}, your bets:<ul class="verdicts">${items}</ul></div>`;
}

function finalizeBtn(ctx, m, now) {
  return ctx.E.finalizeOutcome(m, now)
    ? '<button type="button" class="btn btn-outline btn-sm" data-act="finalize">🏁 Finalize now</button>' : '';
}

function phaseHtml(ctx, m, now, phase, me, myBets) {
  const { E } = ctx;
  const d = ctx.derived();
  if (phase === 'open') return '';
  if (phase === 'closed') {
    const role = reportRole(m, me);
    const early = now < (m.reportableAt ?? 0);
    let inner;
    if (m.oracle) {
      const o = ctx.oracleInfo(m.id);
      inner = `<p class="small dim">This market is checked automatically against ${esc(oracleSource(ctx.O, m))}. ${early
        ? `Data becomes checkable in ${countdown(m.reportableAt, 'a moment')}.`
        : o && o.status === 'error' ? 'The data source is unreachable right now — you can report it yourself.'
          : 'The first player whose app sees final data reports it (and posts the bond).'}</p>
        ${role !== 'none' && !early ? `<details class="disclosure" style="margin:0"><summary>Report manually</summary><div class="disclosure-body">${reportFormHtml(ctx, m, now)}</div></details>` : ''}`;
    } else if (early) {
      inner = `<p class="small dim">Results can be reported in ${countdown(m.reportableAt, 'a moment')}.</p>`;
    } else if (role === 'none') {
      inner = `<p class="small dim">Only <b>${esc(m.createdByName || 'the creator')}</b> can report the result of their market.</p>`;
    } else {
      inner = reportFormHtml(ctx, m, now);
    }
    const exp = m.kind === 'timer' && m.expiresAt
      ? `<p class="small muted">No report by ${esc(fmtDateTime(m.expiresAt))}? It settles as “${esc(optionLabel(m, m.expiryOptionId))}” automatically.</p>` : '';
    return `<div class="phase tone-warn">
      <div class="phase-head"><div class="ph-ico" aria-hidden="true">⏳</div><div class="grow"><h3>Betting closed — what happened?</h3>
        <p>${role === 'anyone' ? 'Anyone can report the result of a house market.' : role === 'creator' ? 'You created this market, so you report the result.' : 'Waiting for the result.'}</p></div>
        ${finalizeBtn(ctx, m, now)}</div>
      ${inner}${exp}
    </div>`;
  }
  if (phase === 'reported') {
    const err = E.validateChallenge(me, m, now);
    const oracleFlag = ctx.oracleInfo(m.id);
    const mismatch = oracleFlag && oracleFlag.mismatch;
    return `<div class="phase tone-info">
      <div class="phase-head"><div class="ph-ico" aria-hidden="true">📣</div><div class="grow"><h3>Result reported</h3>
        <p>by <b>${esc(m.reportedByName || 'someone')}</b> · ${ago(m.reportedAt)}</p></div>${finalizeBtn(ctx, m, now)}</div>
      <div class="result-line">Reported: ${reportedWhat(m)}</div>
      ${m.kind === 'timer' && Number.isFinite(m.reportedEventAt) ? `<div class="derived">${myVerdictsHtml(ctx, m, m.reportedEventAt)}</div>` : ''}
      <div>${evidenceHtml(m)}</div>
      <p class="small dim">Becomes final in <b class="countdown-big">${countdown(m.reportedAt + E.CHALLENGE_WINDOW_MS, 'moments')}</b> unless someone challenges it.</p>
      ${err ? `<p class="hint-line">${esc(err)}</p>` : `
        <div class="bond-note"><span class="coin" aria-hidden="true">§</span><span>Think it's wrong? Challenging costs a <b>${esc(money(E.BOND))} bond</b> — you get ${esc(money(2 * E.BOND))} back if the jury overturns it.</span></div>
        <button type="button" class="btn ${mismatch ? 'btn-danger-solid' : 'btn-outline'} btn-block" data-act="challenge" data-focus-key="challenge">⚖️ Challenge · ${esc(money(E.BOND))} bond</button>`}
    </div>`;
  }
  if (phase === 'challenged') {
    const hasStake = d.myBetsByMarket.has(m.id);
    const hasVoted = d.myVotes.has(m.id);
    const err = E.validateVote(me, m, { hasStake, hasVoted }, now);
    const up = m.votesUphold || 0;
    const ov = m.votesOverturn || 0;
    const tot = up + ov;
    return `<div class="phase tone-loss">
      <div class="phase-head"><div class="ph-ico" aria-hidden="true">⚖️</div><div class="grow"><h3>Result disputed — the jury is out</h3>
        <p><b>${esc(m.reportedByName || 'someone')}</b> reported · <b>${esc(m.challengedByName || 'someone')}</b> challenged ${ago(m.challengedAt)}</p></div>${finalizeBtn(ctx, m, now)}</div>
      <div class="result-line">Reported: ${reportedWhat(m)}</div>
      <div>${evidenceHtml(m)}</div>
      <div class="tally" aria-label="Votes: ${up} uphold, ${ov} overturn">
        <div class="tally-legend"><span class="win">👍 Uphold · ${up}</span><span class="loss">${ov} · Overturn 👎</span></div>
        <div class="tally-bar${tot ? '' : ' is-empty'}"><span class="up" style="flex-grow:${tot ? up : 1}"></span><span class="ov" style="flex-grow:${tot ? ov : 1}"></span></div>
        ${tot ? '' : '<p class="tiny muted" style="margin:0">No votes yet.</p>'}
      </div>
      <p class="small dim">Voting ends in <b class="countdown-big">${countdown(m.challengedAt + E.VOTE_WINDOW_MS, 'moments')}</b>. More uphold votes → the report stands. Overturn or tie → the market is void and every bet is refunded.</p>
      ${err ? `<p class="hint-line">${esc(err)}</p>` : `
        <div class="vote-row">
          <button type="button" class="btn vote-btn vote-up" data-act="vote-up" data-focus-key="vote-up">👍 Uphold<small>${m.kind === 'timer' ? 'the reported time stands' : `“${esc(optionLabel(m, m.reportedOptionId))}” stands`}</small></button>
          <button type="button" class="btn vote-btn vote-ov" data-act="vote-down" data-focus-key="vote-down">👎 Overturn<small>void the market</small></button>
        </div>
        <p class="tiny muted">Only players with no bet on this market (and not the reporter or challenger) can vote. One vote each.</p>`}
    </div>`;
  }
  // resolved / void
  const settledMine = myBets.filter((b) => b.status !== 'open');
  const pendingMine = myBets.filter((b) => b.status === 'open');
  const paid = settledMine.reduce((a, b) => a + (b.payout || 0), 0);
  const staked = myBets.reduce((a, b) => a + b.amount, 0);
  const pnl = paid - settledMine.reduce((a, b) => a + b.amount, 0);
  const bonds = E.bondClaims(m);
  const bondLines = [];
  if (me && m.reportedBy === me.uid) bondLines.push(`Your reporter bond: ${bonds.reporter > E.BOND ? `<b class="win">won ${esc(money(bonds.reporter))}</b>` : bonds.reporter ? `<b>refunded ${esc(money(bonds.reporter))}</b>` : '<b class="loss">lost</b>'}${m.reporterBondPaid ? '' : ' <span class="muted">(claiming…)</span>'}`);
  if (me && m.challengedBy === me.uid) bondLines.push(`Your challenger bond: ${bonds.challenger > E.BOND ? `<b class="win">won ${esc(money(bonds.challenger))}</b>` : bonds.challenger ? `<b>refunded ${esc(money(bonds.challenger))}</b>` : '<b class="loss">lost</b>'}${m.challengerBondPaid ? '' : ' <span class="muted">(claiming…)</span>'}`);
  const why = m.status === 'void'
    ? (m.challengedBy ? (m.votesOverturn > m.votesUphold ? `The jury overturned the report ${m.votesOverturn}–${m.votesUphold}.` : `The jury was split ${m.votesUphold}–${m.votesOverturn}.`)
      : m.reportedBy ? 'Nobody backed the winning outcome, so the pool was refunded.' : 'The market was voided.')
    : (m.challengedBy ? `Upheld by the jury ${m.votesUphold}–${m.votesOverturn}.` : m.reportedBy ? `Reported by ${esc(m.reportedByName || 'someone')}, unchallenged.` : 'Settled automatically when time ran out.');
  return `<div class="phase ${m.status === 'void' ? 'tone-muted' : 'tone-win'}">
    <div class="phase-head"><div class="ph-ico" aria-hidden="true">${m.status === 'void' ? '↩️' : '🏁'}</div><div class="grow">
      <h3>${m.status === 'void' ? 'Voided — every bet refunded' : `Resolved: ${esc(resultLabel(m))}`}</h3>
      <p>${why}${m.resolvedAt ? ` · ${ago(m.resolvedAt)}` : ''}</p></div></div>
    ${m.kind === 'timer' && m.eventAt ? '<p class="small dim">Each bet was judged from the moment it was placed.</p>' : ''}
    ${m.evidence ? `<div>${evidenceHtml(m)}</div>` : ''}
    ${myBets.length ? `<div class="result-line">Your result:
      ${pendingMine.length ? `<b>claiming ${pendingMine.length} bet${pendingMine.length > 1 ? 's' : ''}…</b>` : `<b class="res ${pnl > 0 ? 'win' : pnl < 0 ? 'loss' : ''}">${esc(signedMoney(pnl))}</b>
      <span class="small muted">paid ${esc(money(paid))} on ${esc(money(staked))} staked</span>`}</div>` : ''}
    ${bondLines.map((l) => `<p class="small">${l}</p>`).join('')}
  </div>`;
}

function oracleAlertHtml(ctx, m, now) {
  if (!m.oracle || m.status !== 'reported') return '';
  const st = ctx.oracleInfo(m.id);
  if (!st || !st.mismatch || !st.result || st.result.status !== 'final') return '';
  const src = oracleSource(ctx.O, m);
  const err = ctx.E.validateChallenge(ctx.me(), m, now);
  const says = m.kind === 'timer'
    ? (Number.isFinite(st.result.eventAt) ? `it happened ${fmtDateTime(st.result.eventAt)}` : 'no event yet')
    : optionLabel(m, st.result.optionId);
  return `<div class="oracle-alert" role="alert">
    <h3><span aria-hidden="true">🚨</span> Report doesn't match ${esc(src)} data</h3>
    <p>Reported: <b>${esc(reportLabel(m))}</b> · ${esc(src)} says: <b>${esc(says)}</b></p>
    ${err ? '' : `<button type="button" class="btn btn-danger-solid btn-block" data-act="challenge">⚖️ Challenge now · ${esc(money(ctx.E.BOND))} bond</button>`}
  </div>`;
}

function positionHtml(ctx, m, myBets, now) {
  const open = myBets.filter((b) => b.status === 'open');
  if (!open.length || m.status === 'resolved' || m.status === 'void') return '';
  const { E } = ctx;
  const byOpt = new Map();
  for (const b of open) byOpt.set(b.optionId, (byOpt.get(b.optionId) || 0) + b.amount);
  const lines = [...byOpt].map(([opt, amt]) => {
    const bets = open.filter((b) => b.optionId === opt);
    let win;
    if (m.mode === 'pool') {
      const tot = (m.optionTotals || {})[opt] || 0;
      win = tot > 0 ? Math.floor((amt * (m.totalPool || 0)) / tot) : amt;
    } else win = bets.reduce((a, b) => a + Math.floor(b.amount * (b.odds || E.displayOdds(m, opt) || 1) + 1e-9), 0);
    return `<span><b>${esc(money(amt))}</b> on <b>${esc(optionLabel(m, opt))}</b> → pays <b class="win">${esc(money(win))}</b>${m.mode === 'pool' ? ' (est.)' : ''}</span>`;
  });
  void now;
  return `<div class="position"><span aria-hidden="true">🎟️</span><span class="grow">Your position: ${lines.join(' · ')}</span></div>`;
}

function rulesHtml(ctx, m) {
  const { E } = ctx;
  const rows = [
    ['Market', `${isHouse(m) ? 'House' : 'Custom'} · ${m.kind === 'timer' ? 'Timer (“how long till…”)' : 'Choice'} · ${m.mode === 'pool' ? 'Pool (parimutuel)' : 'Fixed odds'}`],
    ['Opened', fmtDateTime(m.openedAt)],
    ['Betting closes', fmtDateTime(m.closesAt)],
  ];
  if (m.reportableAt && m.reportableAt !== m.openedAt && m.reportableAt !== m.closesAt) rows.push(['Result checkable from', fmtDateTime(m.reportableAt)]);
  if (m.kind === 'timer' && m.expiresAt) rows.push(['Auto-settles', `${fmtDateTime(m.expiresAt)} → “${optionLabel(m, m.expiryOptionId)}”`]);
  if (m.oracle) rows.push(['Checked against', oracleSource(ctx.O, m)]);
  rows.push(['Who reports', isHouse(m) ? 'Anyone (posts a §' + E.BOND + ' bond)' : `${m.createdByName || 'The creator'} (posts a §${E.BOND} bond)`]);
  const buckets = m.kind === 'timer'
    ? `<div class="small dim">⏱ Buckets are measured from the moment <b>each bet</b> is placed. Bet after it already happened and you're refunded. The sooner the bucket, the juicier the odds.</div>` : '';
  return `<h3 class="section-title">Rules & resolution</h3>
    <div class="rules-card">
      ${m.description ? `<p class="rules">${esc(m.description)}</p>` : '<p class="rules muted">No extra rules — the title says it all.</p>'}
      ${m.oracle ? `<div class="oracle-line"><span aria-hidden="true">🤖</span><span><b>Auto-checked</b> · ${esc(oracleDesc(ctx.O, m))}</span></div>` : ''}
      ${buckets}
      <div class="rules-meta">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div>
    </div>`;
}

function bettorsHtml(ctx, m, bets, me) {
  if (!bets.length) {
    return `<h3 class="section-title">Bettors</h3><p class="small muted">No bets yet. ${m.status === 'open' ? 'Be the first — early birds get the best pool odds.' : ''}</p>`;
  }
  const rows = bets.slice(0, 60).map((b) => {
    const st = b.status === 'won' ? `<small class="win">won ${esc(money(b.payout))}</small>`
      : b.status === 'lost' ? '<small class="loss">lost</small>'
        : b.status === 'void' ? '<small>refunded</small>'
          : `<small>${b.odds ? esc(fmtOdds(b.odds)) : 'pool'}</small>`;
    return `<li class="${me && b.uid === me.uid ? 'me' : ''}">${avatarHtml(b.username, 'avatar-sm')}
      <div class="grow" style="min-width:0"><div class="who">${esc(b.username)}</div><div class="on">on ${esc(b.optionLabel || optionLabel(m, b.optionId))} · ${ago(b.placedAt)}</div></div>
      <div class="amt">${esc(money(b.amount))}${st}</div></li>`;
  }).join('');
  return `<h3 class="section-title">Bettors <span class="muted">(${bets.length})</span></h3><ul class="bettors">${rows}</ul>`;
}

// ===================================================================== auth hero (decorative)
export function heroCardsHtml() {
  const card = (emoji, cat, title, rows, status, pool) => `<article class="mcard is-featured">
    <div class="mcard-top"><div class="emoji-tile">${emoji}</div><div class="grow"><div class="mcard-meta"><span>${cat}</span><span class="sep">•</span><span>House</span></div>
    <h3 class="mcard-title">${title}</h3></div></div>
    <ul class="outs">${rows.map(([l, p, o, c]) => `<li class="out" style="--c:${c};--p:${p}%"><span class="o-label">${l}</span><span class="o-pct">${p}%</span><span class="o-odds">×${o}</span></li>`).join('')}</ul>
    <div class="mcard-foot"><div class="mcard-stats"><span class="pool"><b>${pool}</b> staked</span></div><span class="status status-open">${status}</span></div></article>`;
  return card('🏛️', 'Politics', 'Will a federal court block a Trump order on constitutional grounds this week?',
    [['Within 1 day', 9, '6.00', 'var(--o1)'], ['1–4 days', 18, '3.00', 'var(--o2)'], ['4–8 days', 31, '1.80', 'var(--o3)']], 'Closes in 9h 12m', '§2,140')
    + card('₿', 'Crypto', 'Bitcoin above $120k at Friday’s close?',
      [['Yes', 38, '2.40', 'var(--o-yes)'], ['No', 62, '1.50', 'var(--o-no)']], 'Closes in 2d 4h', '§860');
}

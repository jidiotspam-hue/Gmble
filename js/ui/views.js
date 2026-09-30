// Create, My Bets, Leaderboard, Activity and Admin tabs + the "How it works" dialog content.
import {
  esc, errMsg, money, signedMoney, fmtOdds, fmtDateTime, fmtDay, toLocalInput, fromLocalInput, patch, trackDirty,
  withBusy, toast, confirmDialog, promptDialog, countdown, ago, avatarHtml,
} from './util.js';
import { optionColor, optionLabel, isHouse, statusChip, resultLabel, reportLabel } from './model.js';
import { cardHtml } from './markets.js';

const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;

function newId() {
  const c = globalThis.crypto;
  const rnd = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
  return `c-${Date.now().toString(36)}-${rnd}`;
}

// ===================================================================== Create
export function createCreateView(panel, ctx) {
  const draft = { kind: 'choice', labels: ['Yes', 'No'] };
  panel.innerHTML = `
    <div class="page-head"><div><h1>Create a market</h1>
      <p>Ask the group anything. You report the result — honestly, or the jury will know.</p></div></div>
    <div class="create-layout">
      <form class="card create-form" novalidate aria-label="New market">
        <fieldset class="field">
          <legend>What kind of market?</legend>
          <div class="kind-pick">
            <label class="kind-card"><input type="radio" name="kind" value="choice" checked>
              <span class="k-ico" aria-hidden="true">🎲</span><span class="k-title">Choice</span>
              <span class="k-sub">Pick the winner from 2–6 options. Pool betting — odds move with the money.</span></label>
            <label class="kind-card"><input type="radio" name="kind" value="timer">
              <span class="k-ico" aria-hidden="true">⏳</span><span class="k-title">Timer</span>
              <span class="k-sub">“How long till…?” Bet on a time bucket at fixed odds.</span></label>
          </div>
        </fieldset>
        <div class="field">
          <label for="c-title">Question</label>
          <input id="c-title" class="input" name="title" maxlength="140" autocomplete="off" placeholder="Will Dave actually ship his side project this month?">
          <span class="field-hint" data-count>0 / 140</span>
        </div>
        <div class="field">
          <label for="c-desc">Resolution rules <span class="muted">(recommended)</span></label>
          <textarea id="c-desc" class="textarea" name="description" maxlength="600" rows="3" placeholder="Counts if: Dave posts a public link that works. Doesn't count: “it works on my machine”."></textarea>
        </div>
        <div class="field" data-choice-only>
          <span class="field-label">Options <span class="muted">(2–6)</span></span>
          <div class="opt-inputs" data-opts></div>
          <button type="button" class="btn btn-ghost btn-sm" data-add-opt style="justify-self:start">＋ Add option</button>
        </div>
        <div class="field" data-timer-only hidden>
          <span class="field-label">Time buckets <span class="muted">(fixed, measured from now)</span></span>
          <div data-buckets></div>
        </div>
        <div class="field">
          <label for="c-close">Betting closes</label>
          <input id="c-close" class="input" type="datetime-local" name="closesAt">
          <div class="row wrap" role="group" aria-label="Quick close times">
            <button type="button" class="chip cat-chip" data-close-in="3600000">in 1 hour</button>
            <button type="button" class="chip cat-chip" data-close-in="43200000">in 12 hours</button>
            <button type="button" class="chip cat-chip" data-close-in="86400000">tomorrow</button>
            <button type="button" class="chip cat-chip" data-close-in="604800000">in a week</button>
          </div>
        </div>
        <div class="quota" data-quota></div>
        <p class="hint-line" data-hint aria-live="polite"></p>
        <button type="submit" class="btn btn-primary btn-lg btn-block" data-submit>✨ Create market</button>
      </form>
      <aside class="create-aside" aria-label="Preview and tips">
        <h2 class="section-title">Live preview</h2>
        <div class="preview-card-wrap" data-preview inert></div>
        <div class="card explain">
          <h3><span aria-hidden="true">🎲</span> Choice = pool betting</h3>
          <p>Everyone's stakes go into one pot; winners split the <b>whole</b> pot in proportion to their stake. Long shots pay big. If nobody backed the winner, everyone is refunded.</p>
        </div>
        <div class="card explain">
          <h3><span aria-hidden="true">⏳</span> Timer = fixed odds</h3>
          <p>Bettors pick a bucket — within 1 day (×6), 1–4 days (×3), 4–8 days (×1.8) or 8+ days (×1.3) — <b>counted from the moment they bet</b>. Odds lock when you bet. When it happens you report the time; bets placed after it happened are refunded. No report in time settles as “8+”.</p>
        </div>
        <div class="card explain">
          <h3><span aria-hidden="true">📣</span> You're the reporter</h3>
          <ul><li>Only you can report the result, with an evidence link and a §20 bond.</li>
            <li>Anyone can challenge within 12h; players who didn't bet then vote.</li>
            <li>Changed your mind? You can void it until the first bet lands.</li></ul>
        </div>
      </aside>
    </div>`;

  const form = panel.querySelector('form');
  const optsEl = panel.querySelector('[data-opts]');
  const closeInput = form.elements.closesAt;
  let closeTouched = false;
  trackDirty(panel);

  function renderOptions() {
    const m = { options: draft.labels.map((l, i) => ({ id: `o${i + 1}`, label: l })) };
    optsEl.innerHTML = draft.labels.map((l, i) => `
      <div class="opt-input">
        <span class="dot" style="background:${optionColor(m, m.options[i], i)}" aria-hidden="true"></span>
        <input class="input" data-opt="${i}" maxlength="60" autocomplete="off" aria-label="Option ${i + 1}" placeholder="Option ${i + 1}" value="${esc(l)}">
        <button type="button" class="icon-btn" data-rm-opt="${i}" aria-label="Remove option ${i + 1}" ${draft.labels.length <= MIN_OPTIONS ? 'disabled' : ''}>✕</button>
      </div>`).join('');
    panel.querySelector('[data-add-opt]').disabled = draft.labels.length >= MAX_OPTIONS;
  }

  function setKind(kind) {
    draft.kind = kind;
    panel.querySelector('[data-choice-only]').hidden = kind !== 'choice';
    panel.querySelector('[data-timer-only]').hidden = kind !== 'timer';
    if (!closeTouched) closeInput.value = toLocalInput(Date.now() + (kind === 'timer' ? 12 : 24) * 3_600_000);
    update();
  }

  function buildDraft() {
    const { E } = ctx;
    const me = ctx.me();
    const now = ctx.now();
    const closesAt = fromLocalInput(closeInput.value);
    let market = null;
    let err = null;
    try {
      market = E.buildCustomMarket({
        id: 'preview', player: me, now,
        title: form.elements.title.value, description: form.elements.description.value,
        kind: draft.kind, optionLabels: draft.labels, closesAt: Number.isFinite(closesAt) ? closesAt : (draft.kind === 'timer' ? null : NaN),
      });
      err = E.validateCreateMarket(me, market, now);
    } catch (e) {
      err = errMsg(e);
    }
    return { market, err };
  }

  function update() {
    const { E } = ctx;
    const me = ctx.me();
    if (!me) return;
    const now = ctx.now();
    const t = form.elements.title.value;
    panel.querySelector('[data-count]').textContent = `${t.length} / 140`;
    const { market, err } = buildDraft();
    const hint = panel.querySelector('[data-hint]');
    const pristine = !t.trim();
    hint.textContent = pristine ? 'Start with a question.' : err || 'Looks good. Ship it.';
    hint.className = `hint-line ${pristine ? '' : err ? 'is-error' : 'is-ok'}`;
    panel.querySelector('[data-submit]').disabled = !!err;
    // quota
    const today = E.utcDayNumber(now);
    const used = me.marketsDay === today ? (me.marketsCount || 0) : 0;
    const max = E.MAX_MARKETS_PER_DAY;
    panel.querySelector('[data-quota]').innerHTML = `<span class="quota-dots" aria-hidden="true">${Array.from({ length: max }, (_, i) => `<i class="${i < used ? 'used' : ''}"></i>`).join('')}</span>
      <span>${Math.max(0, max - used)} of ${max} markets left today (resets at midnight UTC)</span>`;
    // buckets preview
    if (draft.kind === 'timer') {
      patch(panel.querySelector('[data-buckets]'), `<ul class="outs">${E.DEFAULT_TIMER_BUCKETS.map((b, i) => `<li class="out" style="--c:${optionColor({ options: E.DEFAULT_TIMER_BUCKETS }, b, i)};--p:0%">
        <span class="o-label">${esc(b.label)}</span><span class="o-odds">${esc(fmtOdds(b.odds))}</span></li>`).join('')}</ul>`);
    }
    // preview card
    const pm = market || (() => {
      try {
        return E.normalizeMarket({
          id: 'preview', type: 'custom', kind: draft.kind, mode: draft.kind === 'timer' ? 'fixed' : 'pool',
          title: t.trim() || 'Your question goes here', description: '', category: 'Custom', emoji: draft.kind === 'timer' ? '⏳' : '🎲',
          createdBy: me.uid, createdByName: me.username, openedAt: now, closesAt: now + 86_400_000,
          options: draft.kind === 'timer' ? E.DEFAULT_TIMER_BUCKETS.map((o) => ({ ...o }))
            : draft.labels.map((l, i) => ({ id: `o${i + 1}`, label: l || `Option ${i + 1}`, odds: null })),
        });
      } catch { return null; }
    })();
    if (pm) {
      const show = { ...pm, title: pm.title || 'Your question goes here' };
      patch(panel.querySelector('[data-preview]'), cardHtml(ctx, show, now).replace('href="#market"', 'tabindex="-1"'));
    }
  }

  form.addEventListener('change', (e) => {
    if (e.target.name === 'kind') setKind(e.target.value);
    if (e.target === closeInput) { closeTouched = true; update(); }
  });
  form.addEventListener('input', (e) => {
    const i = e.target.dataset.opt;
    if (i != null) draft.labels[Number(i)] = e.target.value;
    if (e.target === closeInput) closeTouched = true;
    update();
  });
  form.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-opt]');
    if (rm) {
      draft.labels.splice(Number(rm.dataset.rmOpt), 1);
      renderOptions();
      update();
      return;
    }
    if (e.target.closest('[data-add-opt]') && draft.labels.length < MAX_OPTIONS) {
      draft.labels.push('');
      renderOptions();
      update();
      const inputs = optsEl.querySelectorAll('[data-opt]');
      inputs[inputs.length - 1].focus();
      return;
    }
    const q = e.target.closest('[data-close-in]');
    if (q) {
      closeInput.value = toLocalInput(Date.now() + Number(q.dataset.closeIn));
      closeTouched = true;
      update();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[data-submit]');
    const { market, err } = buildDraft();
    if (err || !market) { update(); toast(err || 'Check the form', 'error'); return; }
    const id = newId();
    const real = { ...market, id };
    try {
      await withBusy(btn, () => ctx.store.createMarket(real));
      toast(`Market created: “${real.title}”`, 'success', '✨');
      reset();
      ctx.setTab('markets');
      ctx.openMarket(id);
    } catch (e2) {
      toast(errMsg(e2), 'error');
    }
  });

  function reset() {
    form.reset();
    draft.kind = 'choice';
    draft.labels = ['Yes', 'No'];
    closeTouched = false;
    renderOptions();
    setKind('choice');
  }

  renderOptions();
  setKind('choice');
  return {
    render: update,
    reset,
    onShow() { if (!closeTouched) closeInput.value = toLocalInput(Date.now() + (draft.kind === 'timer' ? 12 : 24) * 3_600_000); },
  };
}

// ===================================================================== My bets
export function createMyBetsView(panel, ctx) {
  panel.innerHTML = `<div class="page-head"><div><h1>My bets</h1><p>Your open positions, bonds and the damage so far.</p></div></div>
    <div data-sec="stats"></div><div data-sec="lists"></div>`;
  panel.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) { ctx.openMarket(o.dataset.open, o); return; }
    if (e.target.closest('[data-go-markets]')) ctx.setTab('markets');
  });
  const sec = (n) => panel.querySelector(`[data-sec="${n}"]`);

  function render() {
    const { E, state } = ctx;
    const me = ctx.me();
    const now = ctx.now();
    const d = ctx.derived();
    const mine = d.myBets;
    const open = mine.filter((b) => b.status === 'open');
    const settled = mine.filter((b) => b.status !== 'open').sort((a, b) => (b.claimedAt || b.placedAt) - (a.claimedAt || a.placedAt));
    const pnl = settled.reduce((a, b) => a + (b.payout || 0) - b.amount, 0);
    const wins = settled.filter((b) => b.status === 'won').length;
    const decided = settled.filter((b) => b.status === 'won' || b.status === 'lost').length;
    const bondMarkets = state.markets.filter((m) => m.reportedBy === me.uid || m.challengedBy === me.uid);
    const bondsHeld = bondMarkets.filter((m) => m.status === 'reported' || m.status === 'challenged').length * E.BOND;

    patch(sec('stats'), `<div class="stats-grid">
      <div class="card stat-card hl"><span class="lbl">Net worth</span><span class="val gold">${esc(money(E.netWorth(me)))}</span><span class="sub">${esc(money(me.balance))} cash + ${esc(money(me.openStake || 0))} in play</span></div>
      <div class="card stat-card"><span class="lbl">Open bets</span><span class="val">${open.length}</span><span class="sub">${esc(money(open.reduce((a, b) => a + b.amount, 0)))} at stake${bondsHeld ? ` · ${esc(money(bondsHeld))} in bonds` : ''}</span></div>
      <div class="card stat-card"><span class="lbl">Realized P&amp;L</span><span class="val ${pnl > 0 ? 'win' : pnl < 0 ? 'loss' : ''}">${esc(signedMoney(pnl))}</span><span class="sub">on ${settled.length} settled bet${settled.length === 1 ? '' : 's'}</span></div>
      <div class="card stat-card"><span class="lbl">Win rate</span><span class="val">${decided ? Math.round((wins / decided) * 100) + '%' : '—'}</span><span class="sub">${wins} won · ${decided - wins} lost · ${esc(money(me.totalWagered || 0))} wagered</span></div>
    </div>`);

    if (!state.loaded.bets) {
      patch(sec('lists'), `<div class="card" style="padding:16px;display:grid;gap:10px">${'<div class="skel" style="height:48px"></div>'.repeat(4)}</div>`);
      return;
    }
    if (!mine.length && !bondMarkets.length) {
      patch(sec('lists'), `<div class="empty"><div class="empty-ico" aria-hidden="true">🎟️</div><h3>No bets yet</h3>
        <p>Your ${esc(money(me.balance))} is sitting there doing nothing. Tragic.</p>
        <button type="button" class="btn btn-primary" data-go-markets>Browse markets</button></div>`);
      return;
    }
    const mk = (id) => d.marketsById.get(id);
    const openRows = open.map((b) => {
      const m = mk(b.marketId);
      let toWin = null;
      if (m) {
        if (m.mode === 'pool') { const tot = (m.optionTotals || {})[b.optionId] || 0; toWin = tot ? Math.floor((b.amount * (m.totalPool || 0)) / tot) : b.amount; }
        else toWin = Math.floor(b.amount * (b.odds || 1) + 1e-9);
      }
      return `<button type="button" class="lrow" data-open="${esc(b.marketId)}">
        <span class="emoji-tile" aria-hidden="true">${esc((m && m.emoji) || '🎲')}</span>
        <span style="min-width:0"><span class="l-title" style="display:block">${esc(b.marketTitle)}</span>
          <span class="l-sub">${esc(money(b.amount))} on <b class="dim">${esc(b.optionLabel)}</b> · ${b.odds ? esc(fmtOdds(b.odds)) : 'pool'} ${m ? statusChip(m, now) : ''}</span></span>
        <span class="l-amt">${toWin != null ? esc(money(toWin)) : '—'}<small>${m && m.mode === 'pool' ? 'est. win' : 'to win'}</small></span>
      </button>`;
    }).join('');
    const bondRows = bondMarkets.map((m) => {
      const role = m.reportedBy === me.uid ? 'reporter' : 'challenger';
      const owed = E.bondClaims(m)[role];
      const final = m.status === 'resolved' || m.status === 'void';
      const paid = role === 'reporter' ? m.reporterBondPaid : m.challengerBondPaid;
      const st = !final ? '<span class="badge badge-info">Held</span>'
        : owed > E.BOND ? `<span class="badge badge-win">Won ${esc(money(owed))}</span>`
          : owed === E.BOND ? '<span class="badge">Refunded</span>' : '<span class="badge badge-loss">Lost</span>';
      return `<button type="button" class="lrow" data-open="${esc(m.id)}">
        <span class="emoji-tile" aria-hidden="true">${role === 'reporter' ? '📣' : '⚖️'}</span>
        <span style="min-width:0"><span class="l-title" style="display:block">${esc(m.title)}</span>
          <span class="l-sub">You ${role === 'reporter' ? 'reported' : 'challenged'} · ${st}${final && !paid && owed ? ' <span class="muted">claiming…</span>' : ''}</span></span>
        <span class="l-amt">${esc(money(E.BOND))}<small>bond</small></span></button>`;
    }).join('');
    const histRows = settled.slice(0, 80).map((b) => {
      const m = mk(b.marketId);
      const net = (b.payout || 0) - b.amount;
      const badge = b.status === 'won' ? `<span class="badge badge-win">Won</span>` : b.status === 'lost' ? '<span class="badge badge-loss">Lost</span>' : '<span class="badge">Refunded</span>';
      return `<button type="button" class="lrow" data-open="${esc(b.marketId)}">
        <span class="emoji-tile" aria-hidden="true">${esc((m && m.emoji) || '🎲')}</span>
        <span style="min-width:0"><span class="l-title" style="display:block">${esc(b.marketTitle)}</span>
          <span class="l-sub">${badge} ${esc(money(b.amount))} on ${esc(b.optionLabel)}${b.taxed ? ` · <span class="loss">${esc(money(b.taxed))} tax</span>` : ''} · ${b.claimedAt ? ago(b.claimedAt) : ''}</span></span>
        <span class="l-amt ${net > 0 ? 'win' : net < 0 ? 'loss' : ''}">${esc(signedMoney(net))}<small>paid ${esc(money(b.payout || 0))}</small></span></button>`;
    }).join('');
    patch(sec('lists'), `
      <section class="block"><h2 class="section-title">Open bets <span class="muted">(${open.length})</span></h2>
        ${open.length ? `<div class="card list-card">${openRows}</div>` : '<p class="small muted">Nothing riding right now.</p>'}</section>
      ${bondMarkets.length ? `<section class="block"><h2 class="section-title">Bonds <span class="muted">(${bondMarkets.length})</span></h2><div class="card list-card">${bondRows}</div></section>` : ''}
      <section class="block"><h2 class="section-title">History <span class="muted">(${settled.length})</span></h2>
        ${settled.length ? `<div class="card list-card">${histRows}</div>` : '<p class="small muted">Settled bets land here once a market resolves.</p>'}</section>`);
  }
  return { render };
}

// ===================================================================== Leaderboard
export function createLeaderboardView(panel, ctx) {
  panel.innerHTML = `<div class="page-head"><div><h1>Leaderboard</h1><p>Ranked by net worth — cash plus money riding on open bets.</p></div></div><div data-sec="lb"></div>`;
  function render() {
    const { E, state } = ctx;
    const me = ctx.me();
    if (!state.loaded.players) {
      patch(panel.querySelector('[data-sec=lb]'), `<div class="card" style="padding:16px;display:grid;gap:10px">${'<div class="skel" style="height:44px"></div>'.repeat(5)}</div>`);
      return;
    }
    const rows = state.players.slice().sort((a, b) => E.netWorth(b) - E.netWorth(a) || a.username.localeCompare(b.username));
    if (!rows.length) {
      patch(panel.querySelector('[data-sec=lb]'), '<div class="empty"><div class="empty-ico">🏆</div><h3>No players yet</h3><p>Invite your friends. Misery loves company.</p></div>');
      return;
    }
    const skulls = (p) => (p.bankruptcies ? `<span title="${p.bankruptcies} bankruptc${p.bankruptcies === 1 ? 'y' : 'ies'}">💀${p.bankruptcies > 1 ? `×${p.bankruptcies}` : ''}</span>` : '');
    const medals = ['🥇', '🥈', '🥉'];
    const podium = rows.length >= 3 ? `<div class="podium">${rows.slice(0, 3).map((p, i) => `
      <div class="pod p${i + 1}${p.uid === me.uid ? ' is-me' : ''}"><span class="medal" aria-hidden="true">${medals[i]}</span>${avatarHtml(p.username, 'avatar-lg')}
        <span class="name">${esc(p.username)} ${skulls(p)}</span><span class="nw">${esc(money(E.netWorth(p)))}</span></div>`).join('')}</div>` : '';
    const list = rows.map((p, i) => `
      <div class="lrow lb-row${p.uid === me.uid ? ' is-me' : ''}">
        <span class="rank">${i < 3 ? medals[i] : i + 1}</span>
        ${avatarHtml(p.username)}
        <span style="min-width:0"><span class="l-title name" style="display:block">${esc(p.username)} ${skulls(p)} ${p.uid === me.uid ? '<span class="you">you</span>' : ''}</span>
          <span class="l-sub">${esc(money(p.balance))} cash · ${esc(money(p.openStake || 0))} in play${E.penaltyActive(p, ctx.now()) ? ' · <span class="loss">🧾 taxed</span>' : ''}</span></span>
        <span class="l-amt gold">${esc(money(E.netWorth(p)))}<small>net worth</small></span>
      </div>`).join('');
    patch(panel.querySelector('[data-sec=lb]'), `${podium}<div class="card list-card" role="list" aria-label="All players">${list}</div>`);
  }
  return { render };
}

// ===================================================================== Activity
export function createActivityView(panel, ctx) {
  const ui = { kind: 'all' };
  const KINDS = [['all', 'All'], ['bets', 'Bets'], ['markets', 'Markets'], ['disputes', 'Reports & disputes'], ['payouts', 'Payouts']];
  panel.innerHTML = `<div class="page-head"><div><h1>Activity</h1><p>Who bet what, who won, who got called out.</p></div></div>
    <div class="scroller" role="group" aria-label="Filter activity" data-sec="kinds" style="margin-bottom:8px"></div>
    <div data-sec="feed"></div>`;
  panel.addEventListener('click', (e) => {
    const k = e.target.closest('[data-kind]');
    if (k) { ui.kind = k.dataset.kind; ctx.rerender(); return; }
    const o = e.target.closest('[data-open]');
    if (o) ctx.openMarket(o.dataset.open, o);
  });

  function events() {
    const { state } = ctx;
    const ev = [];
    const mref = (id, title) => `<button type="button" class="mref" data-open="${esc(id)}">${esc(title)}</button>`;
    const b = (s) => `<b>${esc(s)}</b>`;
    for (const m of state.markets) {
      const r = mref(m.id, m.title);
      if (m.openedAt) {
        ev.push({ at: m.openedAt, kind: 'markets', ico: isHouse(m) ? '🏠' : '✨', tone: isHouse(m) ? 'gold' : '',
          html: isHouse(m) ? `The House opened ${r}` : `${b(m.createdByName || 'Someone')} created ${r}` });
      }
      if (m.reportedAt) {
        ev.push({ at: m.reportedAt, kind: 'disputes', ico: '📣', tone: 'info',
          html: `${b(m.reportedByName || 'Someone')} reported ${b(m.kind === 'timer' ? reportLabel(m).replace(/^It /, 'it ') : optionLabel(m, m.reportedOptionId))} on ${r}` });
      }
      if (m.challengedAt) {
        ev.push({ at: m.challengedAt, kind: 'disputes', ico: '⚖️', tone: 'loss',
          html: `${b(m.challengedByName || 'Someone')} challenged the result of ${r} · jury: ${m.votesUphold || 0} uphold, ${m.votesOverturn || 0} overturn` });
      }
      if (m.resolvedAt && (m.status === 'resolved' || m.status === 'void')) {
        ev.push({ at: m.resolvedAt, kind: 'payouts', ico: m.status === 'void' ? '↩️' : '🏁', tone: m.status === 'void' ? '' : 'win',
          html: m.status === 'void' ? `${r} was voided — stakes refunded` : `${r} resolved: ${b(resultLabel(m))}` });
      }
    }
    for (const bet of state.bets) {
      ev.push({ at: bet.placedAt, kind: 'bets', ico: '🎟️', tone: '',
        html: `${b(bet.username)} bet ${b(money(bet.amount))} on ${b(bet.optionLabel)} in ${mref(bet.marketId, bet.marketTitle)}` });
      if (bet.status === 'won' && bet.claimedAt) {
        ev.push({ at: bet.claimedAt, kind: 'payouts', ico: '🏆', tone: 'win',
          html: `${b(bet.username)} won ${b(money(bet.payout))} on ${mref(bet.marketId, bet.marketTitle)}${bet.taxed ? ` <span class="muted">(${esc(money(bet.taxed))} taxed)</span>` : ''}` });
      }
    }
    for (const p of state.players) {
      if (p.createdAt) ev.push({ at: p.createdAt, kind: 'markets', ico: '👋', tone: '', html: `${b(p.username)} joined the table` });
    }
    return ev.filter((e) => Number.isFinite(e.at)).sort((a, z) => z.at - a.at);
  }

  function render() {
    const { state } = ctx;
    patch(panel.querySelector('[data-sec=kinds]'), KINDS.map(([k, l]) => `<button type="button" class="chip cat-chip" data-kind="${k}" aria-pressed="${ui.kind === k}">${esc(l)}</button>`).join(''));
    const feedEl = panel.querySelector('[data-sec=feed]');
    if (!state.loaded.markets || !state.loaded.bets) {
      patch(feedEl, `<div style="display:grid;gap:12px">${'<div class="skel" style="height:44px"></div>'.repeat(6)}</div>`);
      return;
    }
    const now = ctx.now();
    const list = events().filter((e) => ui.kind === 'all' || e.kind === ui.kind).slice(0, 150);
    if (!list.length) {
      patch(feedEl, '<div class="empty"><div class="empty-ico">📣</div><h3>Quiet in here</h3><p>Place a bet and start some drama.</p></div>');
      return;
    }
    let day = null;
    const parts = [];
    for (const e of list) {
      const dl = fmtDay(e.at, now);
      if (dl !== day) { day = dl; parts.push(`<li class="feed-day" role="presentation">${esc(dl)}</li>`); }
      parts.push(`<li class="feed-item"><span class="f-ico ${e.tone}" aria-hidden="true">${e.ico}</span><span class="f-text">${e.html}</span><span class="f-time">${ago(e.at)}</span></li>`);
    }
    patch(feedEl, `<ul class="feed">${parts.join('')}</ul>`);
  }
  return { render };
}

// ===================================================================== Admin
export function createAdminView(panel, ctx) {
  panel.innerHTML = `<div class="page-head"><div><h1>Admin</h1><p>You run this casino. Use your powers wisely (or don't).</p></div></div>
    <div data-sec="maint"></div>
    <div class="admin-grid" style="margin-top:20px"><section data-sec="players"></section><section data-sec="bans"></section></div>`;
  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-admin]');
    if (!t) return;
    const { state } = ctx;
    const action = t.dataset.admin;
    if (action === 'maint') {
      const on = !(state.config && state.config.maintenance);
      const ok = await confirmDialog(on
        ? { title: 'Turn maintenance ON?', body: 'Everyone except you gets the “casino is closed” screen until you turn it off. Nobody loses anything.', confirmLabel: 'Close the casino', danger: true, icon: '🚧' }
        : { title: 'Open the casino?', body: 'Maintenance goes off and every player can log in and bet again.', confirmLabel: 'Open the doors', icon: '🎰' });
      if (!ok) return;
      try {
        await withBusy(t, () => ctx.store.setMaintenance(on));
        toast(on ? 'Maintenance is ON — the casino is closed.' : 'Maintenance is OFF — the casino is open!', 'success', on ? '🚧' : '🎰');
      } catch (err) { toast(errMsg(err), 'error'); }
    } else if (action === 'ban') {
      const name = t.dataset.name || 'this player';
      const reason = await promptDialog({
        title: `Ban ${name}?`, body: 'They’ll see a “you’ve been banned” screen with your reason until you unban them. Their money stays put.',
        label: 'Reason (shown to them)', placeholder: 'e.g. Reporting fake results', confirmLabel: 'Ban player', danger: true, required: true, maxLength: 200, icon: '🚫',
      });
      if (reason == null) return;
      try {
        await withBusy(t, () => ctx.store.banPlayer(t.dataset.uid, reason));
        toast(`${name} has been banned.`, 'success', '🚫');
      } catch (err) { toast(errMsg(err), 'error'); }
    } else if (action === 'unban') {
      const name = t.dataset.name || 'this player';
      const ok = await confirmDialog({ title: `Unban ${name}?`, body: 'They can log in and play again right away.', confirmLabel: 'Unban', icon: '🕊️' });
      if (!ok) return;
      try {
        await withBusy(t, () => ctx.store.unbanPlayer(t.dataset.uid));
        toast(`${name} is back in the game.`, 'success', '🕊️');
      } catch (err) { toast(errMsg(err), 'error'); }
    }
  });

  function render() {
    if (!ctx.isAdmin()) return;
    const { E, state } = ctx;
    const cfg = state.config || {};
    const on = !!cfg.maintenance;
    patch(panel.querySelector('[data-sec=maint]'), `<div class="card maint-card${on ? ' is-on' : ''}">
      <div class="emoji-tile" aria-hidden="true">${on ? '🚧' : '🎰'}</div>
      <div class="grow"><h2 id="maint-h">Maintenance mode is ${on ? 'ON' : 'OFF'}</h2>
        <p>${on ? 'Only you can see the game. Everyone else gets the “closed” screen.' : 'The casino is open to every player.'}</p></div>
      <button type="button" class="switch" role="switch" aria-checked="${on}" aria-labelledby="maint-h" data-admin="maint" data-focus-key="maint"></button>
    </div>`);
    const bans = new Map((state.bans || []).map((b) => [b.uid, b]));
    const players = state.players.slice().sort((a, b) => E.netWorth(b) - E.netWorth(a));
    const me = ctx.me();
    const known = new Set(players.map((p) => p.uid));
    const rows = players.map((p) => {
      const banned = bans.has(p.uid);
      const isAdm = p.uid === cfg.adminUid;
      return `<tr class="${banned ? 'is-banned' : ''}">
        <td class="c-who"><div class="who">${avatarHtml(p.username, 'avatar-sm')}<span>${esc(p.username)}</span>
          ${isAdm ? '<span class="badge badge-gold">Admin</span>' : ''}${banned ? '<span class="badge badge-loss">Banned</span>' : ''}${p.uid === (me && me.uid) && !isAdm ? '<span class="badge">You</span>' : ''}</div></td>
        <td class="c-stats">${esc(money(E.netWorth(p)))} net · ${esc(money(p.balance))} cash${p.bankruptcies ? ` · 💀${p.bankruptcies}` : ''}</td>
        <td class="num c-hide">${esc(money(E.netWorth(p)))}</td>
        <td class="num c-hide">${esc(money(p.balance))}</td>
        <td class="num c-hide">${p.bankruptcies ? `💀${p.bankruptcies}` : '—'}</td>
        <td class="c-hide">${p.createdAt ? ago(p.createdAt) : '—'}</td>
        <td class="c-act num">${isAdm ? '' : banned
          ? `<button type="button" class="btn btn-outline btn-sm" data-admin="unban" data-uid="${esc(p.uid)}" data-name="${esc(p.username)}" data-focus-key="unban-${esc(p.uid)}">Unban</button>`
          : `<button type="button" class="btn btn-danger btn-sm" data-admin="ban" data-uid="${esc(p.uid)}" data-name="${esc(p.username)}" data-focus-key="ban-${esc(p.uid)}">Ban</button>`}</td>
      </tr>`;
    }).join('');
    patch(panel.querySelector('[data-sec=players]'), `<h2 class="section-title">Players <span class="muted">(${players.length})</span></h2>
      <div class="card list-card">${players.length ? `<table class="ptable"><thead><tr><th>Player</th><th class="c-stats">Stats</th><th class="num">Net worth</th><th class="num">Cash</th><th class="num">💀</th><th>Joined</th><th class="num"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="small muted" style="padding:16px">No players yet — the admin account gets its player as soon as the data loads.</p>'}</div>`);
    const banList = [...bans.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
    patch(panel.querySelector('[data-sec=bans]'), `<h2 class="section-title">Bans <span class="muted">(${banList.length})</span></h2>
      <div class="card list-card">${banList.length ? banList.map((b) => `<div class="ban-item">
        <div class="row between"><div class="row">${avatarHtml(b.username || '?', 'avatar-sm')}<b class="ellipsis">${esc(b.username || b.uid)}</b>${known.has(b.uid) ? '' : ' <span class="badge">no player</span>'}</div>
          <button type="button" class="btn btn-outline btn-sm" data-admin="unban" data-uid="${esc(b.uid)}" data-name="${esc(b.username || 'player')}" data-focus-key="unban2-${esc(b.uid)}">Unban</button></div>
        <div class="reason">“${esc(b.reason || 'No reason given')}”</div>
        <div class="tiny muted">${b.at ? `Banned ${esc(fmtDateTime(b.at))}` : ''}</div></div>`).join('')
        : '<p class="small muted" style="padding:16px">Nobody is banned. A peaceful casino.</p>'}</div>`);
  }
  return { render };
}

// ===================================================================== How it works
export function howHtml(E) {
  const bond = money(E.BOND);
  const items = [
    ['🎁', `<b>Start with ${money(E.STARTING_BALANCE)} sonnetous.</b> Play money, whole numbers only, minimum bet ${money(E.MIN_BET)}. One bet every 2 seconds.`],
    ['📈', '<b>Fixed odds vs. pool.</b> Fixed: odds like ×3.00 lock when you bet; payout = stake × odds (includes your stake). Pool: all stakes go in one pot and winners split it pro-rata — the % shown is where the money is. If nobody backed the winner, everyone is refunded.'],
    ['⏳', '<b>Timer markets</b> ask “how long till…?”. Pick a time bucket — the clock starts <b>when you bet</b>, so “within 1 day” means within a day of your bet. Whoever reports it gives the time it happened, and every bet is judged against its own start. Bet after it already happened? Refunded. Nobody reports before the longest bucket runs out → the open-ended bucket wins.'],
    ['🎲', `<b>Create your own</b> choice (2–6 options, pool) or timer markets — up to ${E.MAX_MARKETS_PER_DAY} a day. You report the result; you can void it until the first bet.`],
    ['📣', `<b>Reporting a result costs a ${bond} bond.</b> House markets: anyone can report. Your own markets: only you. Add an evidence link. The bond comes back unless someone successfully challenges.`],
    ['⚖️', `<b>Disputes.</b> For 12h after a report anyone can challenge it (another ${bond} bond). Then players with no bet on that market vote for 24h. Uphold wins → report stands, reporter gets ${money(2 * E.BOND)}. Overturn wins → market void (all refunded), challenger gets ${money(2 * E.BOND)}. Tie → void, both bonds back.`],
    ['🤖', '<b>Auto-checked markets</b> settle from public data (prices, earthquakes, weather, Wikipedia pageviews). Your app reports them automatically, and challenges any report that disagrees with the data.'],
    ['🏠', '<b>Daily house markets.</b> A fresh set every day at midnight UTC, identical for everyone. If one ever doesn’t match its template it gets a ⚠ tampered badge and betting is disabled.'],
    ['💀', `<b>Going broke.</b> Under ${money(1)} and nothing riding? After the next UTC midnight you can claim a ${money(E.RESTART_BALANCE)} bailout — at the price of a 💀 on the leaderboard and a ${Math.round(E.PENALTY_TAX * 100)}% tax on winnings for ${E.PENALTY_DAYS} days.`],
    ['🏆', '<b>Net worth</b> = cash + money riding on open bets. The leaderboard ranks by it. Payouts are claimed automatically by your app.'],
  ];
  return `<div class="modal-body">
    <button type="button" class="icon-btn modal-close" data-close aria-label="Close">✕</button>
    <h2 id="how-title">How Sonnetous works</h2>
    <p class="m-text">Bet on anything. Lose everything. Try again tomorrow.</p>
    <ul class="how-list">${items.map(([i, t]) => `<li><span class="h-ico" aria-hidden="true">${i}</span><span>${t}</span></li>`).join('')}</ul>
    <div class="modal-actions"><button type="button" class="btn btn-primary" data-close>Got it — let me bet</button></div>
  </div>`;
}

void countdown;

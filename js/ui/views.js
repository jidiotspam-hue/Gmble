// Create, My Bets, Leaderboard and Activity tabs.
import * as E from '../economy.js';
import { esc, fmtDuration, fmtOdds, errMsg, relTime, toLocalInput, fromLocalInput, toast } from './util.js';

const fmt = (n) => E.formatSonnetous(n);
const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;

// ===================================================================== Create
export function createCreateView(panel, ctx) {
  panel.innerHTML = `
    <form class="panel-card create-form" novalidate>
      <h2>Create a market</h2>
      <label class="field">Title
        <input type="text" name="title" maxlength="140" required placeholder="Will Dave finish his side project this year?" autocomplete="off">
      </label>
      <label class="field">Description <span class="muted small">(optional — how does it resolve?)</span>
        <textarea name="description" rows="3" maxlength="500" placeholder="Resolution rules, edge cases, sources…"></textarea>
      </label>
      <fieldset class="field kind-field">
        <legend>Type</legend>
        <label class="radio"><input type="radio" name="kind" value="choice" checked> <span>Choice <small>(pool betting)</small></span></label>
        <label class="radio"><input type="radio" name="kind" value="timer"> <span>Timer <small>“How long till…”</small></span></label>
      </fieldset>
      <div class="choice-only field">
        <div class="field-label">Options <span class="muted small">(2–6)</span></div>
        <div class="opt-inputs"></div>
        <button type="button" class="btn ghost" data-role="add-option">+ Add option</button>
      </div>
      <label class="field">Betting closes at
        <input type="datetime-local" name="closesAt" required>
      </label>
      <button type="submit" class="btn primary big">Create market</button>
    </form>
    <aside class="panel-card explainer">
      <h3>Pool vs. Timer — how odds work</h3>
      <p><b>Choice (pool):</b> everyone's bets go into one pot. Winners split the <em>whole</em> pot in proportion to their stake. The fewer people back an option, the higher its odds — they move live as bets come in. If nobody backed the winner, everyone is refunded.</p>
      <p><b>Timer (fixed odds):</b> “How long till X?” — bettors pick a time bucket (within 1 day ×6, 1–4 days ×3, 4–8 days ×1.8, 8+ days ×1.3). Odds are locked when you bet. When it happens, you report it with the time; the matching bucket wins. If it hasn't happened after 8 days it settles as “8+ days”.</p>
      <p>As the creator, only you can settle or void your market. Be honest — your friends know where you live.</p>
    </aside>`;

  const form = panel.querySelector('form');
  const optsEl = panel.querySelector('.opt-inputs');
  const addBtn = panel.querySelector('[data-role=add-option]');
  const choiceOnly = panel.querySelector('.choice-only');
  const closesInput = form.elements.closesAt;
  let closesTouched = false;

  function setDefaultClose() {
    closesInput.value = toLocalInput(Date.now() + E.DAY_MS);
  }

  function optionRow(value = '') {
    const row = document.createElement('div');
    row.className = 'opt-input';
    row.innerHTML = `<input type="text" maxlength="60" autocomplete="off" data-role="label">
      <button type="button" class="icon-btn" data-role="remove-option" aria-label="Remove option">✕</button>`;
    row.querySelector('input').value = value;
    return row;
  }
  function refreshOptions() {
    const rows = [...optsEl.children];
    rows.forEach((r, i) => {
      r.querySelector('input').placeholder = `Option ${i + 1}`;
      r.querySelector('button').hidden = rows.length <= MIN_OPTIONS;
    });
    addBtn.disabled = rows.length >= MAX_OPTIONS;
  }
  function resetOptions() {
    optsEl.replaceChildren(optionRow(), optionRow());
    refreshOptions();
  }
  function refreshKind() {
    choiceOnly.hidden = form.elements.kind.value !== 'choice';
  }

  addBtn.addEventListener('click', () => {
    if (optsEl.children.length >= MAX_OPTIONS) return;
    const row = optionRow();
    optsEl.appendChild(row);
    refreshOptions();
    row.querySelector('input').focus();
  });
  optsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role=remove-option]');
    if (!btn || optsEl.children.length <= MIN_OPTIONS) return;
    btn.closest('.opt-input').remove();
    refreshOptions();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'kind') refreshKind();
    if (e.target === closesInput) closesTouched = true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = form.querySelector('[type=submit]');
    const kind = form.elements.kind.value;
    try {
      const closesAt = fromLocalInput(closesInput.value);
      if (!Number.isFinite(closesAt)) throw new Error('Pick when betting closes.');
      const market = E.buildCustomMarket({
        id: (crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`),
        user: ctx.state.user,
        now: Date.now(),
        title: form.elements.title.value.trim(),
        description: form.elements.description.value.trim(),
        kind,
        optionLabels: kind === 'choice'
          ? [...optsEl.querySelectorAll('[data-role=label]')].map((i) => i.value.trim())
          : [],
        closesAt,
      });
      submit.disabled = true;
      await ctx.getStore().createMarket(market);
      toast('Market created. Let the wagering begin!', 'success');
      reset();
      ctx.state.filter = 'open';
      ctx.setTab('markets');
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      submit.disabled = false;
    }
  });

  function reset() {
    form.reset();
    closesTouched = false;
    setDefaultClose();
    resetOptions();
    refreshKind();
  }
  reset();

  return {
    render() {},
    reset,
    onShow() { if (!closesTouched) setDefaultClose(); },
  };
}

// ===================================================================== My Bets
function potentialFor(bet, market) {
  if (bet.odds != null) return Math.floor(bet.amount * bet.odds);
  if (!market) return bet.amount;
  const optTotal = (market.optionTotals && market.optionTotals[bet.optionId]) || 0;
  return optTotal > 0 ? Math.floor((bet.amount * market.totalPool) / optTotal) : bet.amount;
}

export function createMyBetsView(panel, ctx) {
  function render() {
    const { user, bets, markets } = ctx.state;
    const now = Date.now();
    const marketMap = new Map(markets.map((m) => [m.id, m]));
    const mine = bets.filter((b) => b.uid === user.uid).sort((a, b) => b.placedAt - a.placedAt);
    const open = mine.filter((b) => b.status === 'open');
    const history = mine.filter((b) => b.status !== 'open');
    const staked = open.reduce((s, b) => s + b.amount, 0);
    const net = history.reduce((s, b) => (b.status === 'void' ? s : s + (b.payout - b.amount)), 0);
    const taxTotal = history.reduce((s, b) => s + (b.taxed || 0), 0);

    const tile = (label, value, cls = '') => `<div class="tile"><span class="tile-label">${esc(label)}</span><span class="tile-value ${cls}">${value}</span></div>`;
    const summary = `
      <div class="tiles">
        ${tile('Open bets', `${open.length} <small>(${esc(fmt(staked))})</small>`)}
        ${tile('Total wagered', esc(fmt(user.totalWagered || 0)), 'gold')}
        ${tile('Total won', esc(fmt(user.totalWon || 0)), 'win')}
        ${tile('Net result', `${net > 0 ? '+' : net < 0 ? '−' : ''}${esc(fmt(Math.abs(net)))}`, net > 0 ? 'win' : net < 0 ? 'loss' : '')}
      </div>
      ${taxTotal ? `<p class="muted small">Bankruptcy tax paid so far: ${esc(fmt(taxTotal))}</p>` : ''}`;

    const openRows = open.map((b) => {
      const m = marketMap.get(b.marketId);
      const phase = m ? E.marketPhase(m, now) : 'open';
      const when = m && phase === 'open'
        ? `Closes in <b data-countdown="${Number(m.closesAt)}" data-done="0s">${esc(fmtDuration(m.closesAt - now))}</b>`
        : 'Awaiting result';
      return `<li class="bet-item">
        <div class="bet-main"><b>${esc(b.marketTitle)}</b>
          <span class="muted">${esc(b.optionLabel)}${b.odds != null ? ` · ${esc(fmtOdds(b.odds))}` : ' · pool'}</span></div>
        <div class="bet-side"><span>${esc(fmt(b.amount))}</span>
          <span class="win small">win ${b.odds != null ? '' : '~'}${esc(fmt(potentialFor(b, m)))}</span>
          <span class="muted small">${when}</span></div>
      </li>`;
    }).join('');

    const histRows = history.map((b) => {
      const label = b.status === 'won' ? 'Won' : b.status === 'lost' ? 'Lost' : 'Void';
      const amountText = b.status === 'won' ? `+${esc(fmt(b.payout - b.amount))}`
        : b.status === 'lost' ? `−${esc(fmt(b.amount))}` : 'refunded';
      return `<li class="bet-item ${esc(b.status)}">
        <div class="bet-main"><b>${esc(b.marketTitle)}</b>
          <span class="muted">${esc(b.optionLabel)} · staked ${esc(fmt(b.amount))}${b.odds != null ? ` @ ${esc(fmtOdds(b.odds))}` : ''}</span></div>
        <div class="bet-side"><span class="pill pill-${esc(b.status)}">${label}</span>
          <span class="${b.status === 'won' ? 'win' : b.status === 'lost' ? 'loss' : 'muted'}">${amountText}</span>
          ${b.status === 'won' ? `<span class="muted small">payout ${esc(fmt(b.payout))}</span>` : ''}
          ${b.taxed ? `<span class="loss small">🧾 tax −${esc(fmt(b.taxed))}</span>` : ''}
          <span class="muted small" data-ago="${Number(b.placedAt)}">${esc(relTime(b.placedAt, now))}</span></div>
      </li>`;
    }).join('');

    panel.innerHTML = `
      <h2 class="sr-only">My bets</h2>
      ${summary}
      <section class="panel-card"><h3>Open bets</h3>
        ${open.length ? `<ul class="bet-list">${openRows}</ul>` : '<p class="muted">No open bets. Go lose some money on the Markets tab.</p>'}
      </section>
      <section class="panel-card"><h3>History</h3>
        ${history.length ? `<ul class="bet-list">${histRows}</ul>` : '<p class="muted">Nothing settled yet.</p>'}
      </section>`;
  }
  return { render };
}

// ===================================================================== Leaderboard
export function createLeaderboardView(panel, ctx) {
  function render() {
    const { users, bets, user } = ctx.state;
    const now = Date.now();
    const rows = users
      .map((u) => ({ u, nw: E.netWorth(u, bets) }))
      .sort((a, b) => b.nw - a.nw || a.u.username.localeCompare(b.u.username));
    const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1));
    panel.innerHTML = `
      <section class="panel-card">
        <h2>Leaderboard</h2>
        <p class="muted small">Ranked by net worth (balance + stakes in open bets).</p>
        ${rows.length ? `<table class="board">
          <thead><tr><th class="rank">#</th><th>Player</th><th class="num">Net worth</th><th class="num">Balance</th><th></th></tr></thead>
          <tbody>${rows.map(({ u, nw }, i) => `
            <tr class="${u.uid === user.uid ? 'me' : ''}">
              <td class="rank">${medal(i)}</td>
              <td class="name">${esc(u.username)}${u.uid === user.uid ? ' <span class="you">you</span>' : ''}</td>
              <td class="num gold">${esc(fmt(nw))}</td>
              <td class="num">${esc(fmt(u.balance))}</td>
              <td class="flags">${u.bankruptcies ? `<span title="Bankruptcies">💀×${Number(u.bankruptcies)}</span>` : ''}${E.penaltyActive(u, now) ? ' <span class="badge badge-penalty" title="Bankruptcy tax active">🧾 tax</span>' : ''}</td>
            </tr>`).join('')}
          </tbody></table>` : '<p class="muted">No players yet.</p>'}
      </section>`;
  }
  return { render };
}

// ===================================================================== Activity
const BIG_WIN_PROFIT = 200;

export function createActivityView(panel, ctx) {
  function render() {
    const { bets, markets } = ctx.state;
    const now = Date.now();
    const marketMap = new Map(markets.map((m) => [m.id, m]));
    const events = [];

    for (const b of bets) {
      events.push({
        t: b.placedAt, icon: '🎲',
        html: `<b>${esc(b.username)}</b> bet <b class="gold">${esc(fmt(b.amount))}</b> on “${esc(b.optionLabel)}” <span class="muted">— ${esc(b.marketTitle)}</span>`,
      });
      if (b.status === 'won' && b.payout - b.amount >= BIG_WIN_PROFIT) {
        const m = marketMap.get(b.marketId);
        events.push({
          t: (m && m.resolvedAt) || b.placedAt, icon: '💰',
          html: `<b>${esc(b.username)}</b> won <b class="win">${esc(fmt(b.payout))}</b> <span class="muted">(+${esc(fmt(b.payout - b.amount))}) on ${esc(b.marketTitle)}</span>`,
        });
      }
    }
    for (const m of markets) {
      events.push({
        t: m.openedAt, icon: m.type === 'auto' ? '🏠' : '🆕',
        html: `<b>${esc(m.createdByName)}</b> ${m.type === 'auto' ? 'opened' : 'created'} “${esc(m.title)}”`,
      });
      if (m.status === 'resolved') {
        const win = m.options.find((o) => o.id === m.resolvedOptionId);
        events.push({
          t: m.resolvedAt || m.openedAt, icon: '🏁',
          html: `“${esc(m.title)}” settled: <b class="win">${esc(win ? win.label : '?')}</b> <span class="muted">(${m.resolvedBy === 'auto' ? 'auto' : 'by ' + esc(m.resolvedBy || '?')})</span>`,
        });
      } else if (m.status === 'void') {
        events.push({
          t: m.resolvedAt || m.openedAt, icon: '↩️',
          html: `“${esc(m.title)}” was voided <span class="muted">— all bets refunded</span>`,
        });
      }
    }
    events.sort((a, b) => b.t - a.t);
    const feed = events.slice(0, 100);
    panel.innerHTML = `
      <section class="panel-card">
        <h2>Activity</h2>
        ${feed.length ? `<ul class="feed">${feed.map((ev) => `
          <li><span class="feed-icon" aria-hidden="true">${ev.icon}</span>
            <span class="feed-text">${ev.html}</span>
            <span class="feed-time muted small" data-ago="${Number(ev.t)}">${esc(relTime(ev.t, now))}</span></li>`).join('')}</ul>`
          : '<p class="muted">Nothing has happened yet. Suspicious.</p>'}
      </section>`;
  }
  return { render };
}

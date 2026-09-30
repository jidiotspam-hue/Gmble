// Sonnetous economy v2: PURE game rules. No DOM, no storage. Importable from Node.
// Nothing here mutates its inputs; functions return new objects / patches / error strings.
// The payout math (betClaim, bondClaims) is mirrored by firestore.rules — keep them in lock-step.

export const CURRENCY = Object.freeze({ name: 'sonnetous', symbol: '§' });
export const STARTING_BALANCE = 500;
export const RESTART_BALANCE = 100;
export const MIN_BET = 1;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const PENALTY_DAYS = 3;
export const PENALTY_TAX = 0.25;
export const DEFAULT_TIMER_CLOSE_HOURS = 12;

export const BOND = 20;
export const CHALLENGE_WINDOW_MS = 12 * HOUR_MS;
export const VOTE_WINDOW_MS = 24 * HOUR_MS;
export const BET_COOLDOWN_MS = 2000;
export const MAX_MARKETS_PER_DAY = 5;
export const MIN_FIXED_ODDS = 1.01;
export const MAX_FIXED_ODDS = 20;
export const CLOCK_SKEW_MS = 300000;
export const MAX_EVIDENCE_LENGTH = 300;

export const DEFAULT_TIMER_BUCKETS = Object.freeze([
  Object.freeze({ id: 'd1', label: 'Within 1 day', odds: 6, fromDays: 0, toDays: 1 }),
  Object.freeze({ id: 'd4', label: '1–4 days', odds: 3, fromDays: 1, toDays: 4 }),
  Object.freeze({ id: 'd8', label: '4–8 days', odds: 1.8, fromDays: 4, toDays: 8 }),
  Object.freeze({ id: 'never', label: '8+ days', odds: 1.3, fromDays: 8, toDays: null }),
]);

// ---------------------------------------------------------------- helpers

const pad = (n) => String(n).padStart(2, '0');
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isInt = (n) => typeof n === 'number' && Number.isInteger(n);
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const zeroTotals = (options) => Object.fromEntries(options.map((o) => [o.id, 0]));

/** Local-time calendar day key YYYY-MM-DD. */
export function dayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** UTC calendar day key YYYY-MM-DD. */
export function utcDayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole UTC days since the epoch. */
export function utcDayNumber(ms) {
  return Math.floor(ms / DAY_MS);
}

/** 1234 -> '§1,234'; -5 -> '-§5'. Fractions are rounded. */
export function formatSonnetous(n) {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('en-US');
  return `${v < 0 ? '-' : ''}${CURRENCY.symbol}${s}`;
}

/** null when the username is acceptable, else a friendly message. */
export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return 'Username must be 3–20 characters: letters, numbers and underscores only.';
  }
  return null;
}

export function newPlayer(uid, username, now) {
  return {
    uid,
    username,
    balance: STARTING_BALANCE,
    openStake: 0,
    createdAt: now,
    bankruptcies: 0,
    brokeSince: null,
    penaltyUntil: null,
    totalWagered: 0,
    totalWon: 0,
    lastBetAt: 0,
    marketsDay: 0,
    marketsCount: 0,
    lastClaimId: null,
    lastBondMarketId: null,
  };
}

/** @deprecated v1 name; returns a v2 Player. */
export const newUser = newPlayer;

const optionIdsOf = (market) =>
  Array.isArray(market.optionIds) ? market.optionIds : (market.options || []).map((o) => o.id);

// ---------------------------------------------------------------- market normalisation

/**
 * Fills every derived / defaulted v2 field of a market (never mutates the input, never overwrites a
 * field that is already present). Used by buildCustomMarket and templates.buildAutoMarket.
 */
export function normalizeMarket(m) {
  const out = { ...m };
  delete out.resolvedBy; // v1 field, not part of the v2 shape
  out.options = (m.options || []).map((o) => ({ ...o }));
  const options = out.options;
  if (!has(out, 'type')) out.type = out.createdBy === 'house' ? 'auto' : 'custom';
  if (!has(out, 'templateId')) out.templateId = null;
  if (!has(out, 'description')) out.description = '';
  if (!has(out, 'mode')) {
    out.mode = out.kind === 'timer' || (options.length && options.every((o) => isNum(o.odds))) ? 'fixed' : 'pool';
  }
  if (!has(out, 'status')) out.status = 'open';
  if (!has(out, 'oracle')) out.oracle = null;

  out.optionIds = Array.isArray(m.optionIds) ? [...m.optionIds] : options.map((o) => o.id);
  if (has(m, 'oddsById')) out.oddsById = m.oddsById === null ? null : { ...m.oddsById };
  else out.oddsById = out.mode === 'fixed' ? Object.fromEntries(options.map((o) => [o.id, o.odds])) : null;

  if (out.kind === 'timer') {
    if (has(m, 'bucketsById')) out.bucketsById = m.bucketsById === null ? null : { ...m.bucketsById };
    else {
      out.bucketsById = Object.fromEntries(options.map((o) => [o.id, {
        fromMs: Math.round((isNum(o.fromDays) ? o.fromDays : 0) * DAY_MS),
        toMs: o.toDays == null ? null : Math.round(o.toDays * DAY_MS),
      }]));
    }
    const buckets = out.bucketsById || {};
    if (!has(m, 'expiresAt')) {
      const finite = Object.values(buckets).map((b) => b.toMs).filter((t) => t != null);
      const hasOpenEnded = Object.values(buckets).some((b) => b.toMs == null);
      out.expiresAt = hasOpenEnded && finite.length && isNum(out.openedAt) ? out.openedAt + Math.max(...finite) : null;
    }
    if (!has(m, 'expiryOptionId')) {
      const open = Object.entries(buckets).find(([, b]) => b.toMs == null);
      out.expiryOptionId = open ? open[0] : null;
    }
    if (!has(m, 'reportableAt')) out.reportableAt = out.openedAt;
  } else {
    if (!has(m, 'bucketsById')) out.bucketsById = null;
    if (!has(m, 'expiresAt')) out.expiresAt = null;
    if (!has(m, 'expiryOptionId')) out.expiryOptionId = null;
    if (!has(m, 'reportableAt')) {
      out.reportableAt = out.oracle && out.oracle.params && isNum(out.oracle.params.at)
        ? out.oracle.params.at : out.closesAt;
    }
  }

  out.optionTotals = has(m, 'optionTotals') ? { ...m.optionTotals } : zeroTotals(options);
  const defaults = {
    totalPool: 0, betCount: 0, lastBetId: null,
    reportedBy: null, reportedByName: null, reportedOptionId: null, reportedEventAt: null, reportedAt: null,
    evidence: null,
    challengedBy: null, challengedByName: null, challengedAt: null,
    votesUphold: 0, votesOverturn: 0, lastVoteId: null,
    resolvedOptionId: null, resolvedAt: null, eventAt: null,
    reporterBondPaid: false, challengerBondPaid: false,
  };
  for (const [k, v] of Object.entries(defaults)) if (!has(m, k)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------- market state

export function isBettingOpen(market, now) {
  return !!market && market.status === 'open' && now < market.closesAt;
}

/** 'closed' = still 'open' in the database but betting time is over (awaiting a report / expiry). */
export function marketPhase(market, now) {
  if (market.status === 'open') return now >= market.closesAt ? 'closed' : 'open';
  return market.status;
}

const isFinal = (market) => market.status === 'resolved' || market.status === 'void';

// ---------------------------------------------------------------- betting

export function validateBet(player, market, optionId, amount, now) {
  if (!player) return 'Log in to place a bet';
  if (!market) return 'Market not found';
  if (market.status === 'resolved') return 'This market has already been resolved';
  if (market.status === 'void') return 'This market was voided';
  if (market.status === 'reported' || market.status === 'challenged') return 'Betting is closed — a result has been reported';
  if (market.status !== 'open') return 'This market is not open';
  if (!(now < market.closesAt)) return 'Betting is closed for this market';
  if (!optionIdsOf(market).includes(optionId)) return 'Unknown option';
  if (!isInt(amount)) return 'Bet must be a whole number of sonnetous';
  if (amount < MIN_BET) return `Minimum bet is ${formatSonnetous(MIN_BET)}`;
  if (amount > player.balance) return 'Not enough sonnetous';
  if (now < (player.lastBetAt || 0) + BET_COOLDOWN_MS) return 'Slow down — one bet every 2 seconds';
  return null;
}

export function potentialPayout(market, optionId, amount) {
  if (!isNum(amount) || amount <= 0) return 0;
  const option = (market.options || []).find((o) => o.id === optionId);
  if (market.mode === 'pool') {
    const totals = market.optionTotals || {};
    const optTotal = totals[optionId] || 0;
    const pool = market.totalPool || 0;
    return Math.floor((amount * (pool + amount)) / (optTotal + amount));
  }
  const odds = market.oddsById && isNum(market.oddsById[optionId]) ? market.oddsById[optionId] : option && option.odds;
  if (!isNum(odds)) return 0;
  // epsilon guards against float error such as 100 * 1.15 = 114.99999999999999
  return Math.floor(amount * odds + 1e-9);
}

export function displayOdds(market, optionId) {
  if (market.mode === 'pool') {
    const optTotal = (market.optionTotals || {})[optionId] || 0;
    if (optTotal <= 0) return null;
    return (market.totalPool || 0) / optTotal;
  }
  const option = (market.options || []).find((o) => o.id === optionId);
  const odds = market.oddsById && isNum(market.oddsById[optionId]) ? market.oddsById[optionId] : option && option.odds;
  return isNum(odds) ? odds : null;
}

export function buildBet({ id, market, player, user, optionId, amount, now }) {
  const p = player || user;
  const option = (market.options || []).find((o) => o.id === optionId);
  let odds = null;
  if (market.mode === 'fixed') {
    const o = market.oddsById && isNum(market.oddsById[optionId]) ? market.oddsById[optionId] : option && option.odds;
    odds = isNum(o) ? o : null;
  }
  return {
    id,
    marketId: market.id,
    marketTitle: market.title,
    uid: p.uid,
    username: p.username,
    optionId,
    optionLabel: option ? option.label : optionId,
    amount,
    odds,
    placedAt: now,
    status: 'open',
    payout: 0,
    taxed: 0,
    claimedAt: null,
  };
}

/** Patch { optionTotals, totalPool, betCount, lastBetId? } for a new bet; does not mutate the market. */
export function applyBetToMarket(market, optionId, amount, betId) {
  const optionTotals = { ...(market.optionTotals || {}) };
  optionTotals[optionId] = (optionTotals[optionId] || 0) + amount;
  const patch = {
    optionTotals,
    totalPool: (market.totalPool || 0) + amount,
    betCount: (market.betCount || 0) + 1,
  };
  if (betId !== undefined) patch.lastBetId = betId;
  return patch;
}

// ---------------------------------------------------------------- market creation

/** Player patch to apply when the player creates a custom market. */
export function marketCreationPatch(player, now) {
  const today = utcDayNumber(now);
  return {
    marketsDay: today,
    marketsCount: (player.marketsDay === today ? player.marketsCount || 0 : 0) + 1,
  };
}

export function validateCreateMarket(player, market, now) {
  if (!player) return 'Log in to create a market';
  if (!market) return 'Invalid market';
  const house = market.createdBy === 'house' || market.type === 'auto';
  if (house) {
    if (market.createdBy !== 'house' || market.type !== 'auto') return 'Invalid market';
    if (!/^auto-\d{4}-\d{2}-\d{2}-.+/.test(String(market.id || ''))) return 'Invalid house market id';
  } else {
    if (market.createdBy !== player.uid) return 'You can only create markets as yourself';
    if (player.marketsDay === utcDayNumber(now) && (player.marketsCount || 0) >= MAX_MARKETS_PER_DAY) {
      return `You can only create ${MAX_MARKETS_PER_DAY} markets per day`;
    }
  }
  const title = String(market.title ?? '');
  if (title.trim().length < 3) return 'Title must be at least 3 characters';
  if (title.length > 140) return 'Title must be at most 140 characters';
  if (market.kind !== 'timer' && market.kind !== 'choice') return 'Market kind must be "choice" or "timer"';
  const options = market.options || [];
  if (options.length < 2 || options.length > 6) return 'A market needs 2–6 options';
  if (new Set(options.map((o) => o.id)).size !== options.length) return 'Option ids must be unique';
  if (market.status !== 'open') return 'New markets must be open';
  if (!isNum(market.openedAt) || Math.abs(market.openedAt - now) > CLOCK_SKEW_MS) {
    return 'Your clock looks off — check your device time';
  }
  if (!isNum(market.closesAt) || !(market.closesAt > now)) return 'Closing time must be in the future';
  if (market.kind === 'choice' && !house && market.mode !== 'pool') return 'Custom choice markets are pool markets';
  if (market.kind === 'timer' && market.mode !== 'fixed') return 'Timer markets use fixed odds';
  if (market.mode === 'fixed') {
    for (const o of options) {
      const odds = market.oddsById ? market.oddsById[o.id] : o.odds;
      if (!isNum(odds) || odds < MIN_FIXED_ODDS || odds > MAX_FIXED_ODDS) {
        return `Odds must be between ${MIN_FIXED_ODDS} and ${MAX_FIXED_ODDS}`;
      }
    }
  } else if (market.mode !== 'pool') {
    return 'Invalid market mode';
  }
  if ((market.totalPool || 0) !== 0 || (market.betCount || 0) !== 0
    || Object.values(market.optionTotals || {}).some((v) => v !== 0)) {
    return 'New markets must start with an empty pool';
  }
  return null;
}

// ---------------------------------------------------------------- timers

function bucketContains(o, days) {
  const from = isNum(o.fromDays) ? o.fromDays : 0;
  const to = o.toDays == null ? Infinity : o.toDays;
  return days >= from && days < to;
}

/** Option id of the bucket containing (eventAt - openedAt). Before openedAt -> first bucket. */
export function timerBucketFor(market, eventAt) {
  const options = market.options || [];
  const days = (eventAt - market.openedAt) / DAY_MS;
  if (!(days > 0)) return options[0].id;
  const hit = options.find((o) => bucketContains(o, days));
  return (hit || options[options.length - 1]).id;
}

/** Open-ended bucket id when an open timer market has outlasted its longest finite bucket, else null. */
export function timerAutoResolution(market, now) {
  if (!market || market.kind !== 'timer' || market.status !== 'open') return null;
  if (isNum(market.expiresAt) && market.expiryOptionId) return now >= market.expiresAt ? market.expiryOptionId : null;
  const options = market.options || [];
  const openEnded = options.find((o) => o.toDays == null);
  if (!openEnded) return null;
  const finite = options.filter((o) => o.toDays != null).map((o) => o.toDays);
  const maxFinite = finite.length ? Math.max(...finite) : 0;
  return now >= market.openedAt + maxFinite * DAY_MS ? openEnded.id : null;
}

// ---------------------------------------------------------------- report / challenge / vote

export function validateReport(player, market, optionId, eventAt, now) {
  if (!player) return 'Log in to report a result';
  if (!market) return 'Market not found';
  if (market.status === 'reported' || market.status === 'challenged') return 'A result has already been reported';
  if (market.status === 'resolved') return 'This market has already been resolved';
  if (market.status === 'void') return 'This market was voided';
  if (market.status !== 'open') return 'This market is not open';
  if (market.type === 'custom' && market.createdBy !== player.uid) return 'Only the creator can report this market';
  if (!isNum(market.reportableAt) || now < market.reportableAt) return "It's too early to report a result for this market";
  if (!optionIdsOf(market).includes(optionId)) return 'Unknown option';
  if (market.kind === 'timer') {
    if (!isNum(eventAt)) return 'Say when it happened';
    if (eventAt < market.openedAt) return "The event can't be before the market opened";
    if (eventAt > now) return "The event can't be in the future";
    const b = market.bucketsById && market.bucketsById[optionId];
    const off = eventAt - market.openedAt;
    if (!b || off < b.fromMs || (b.toMs != null && off >= b.toMs)) return "That time doesn't fit the chosen option";
  }
  if (player.balance < BOND) return `Not enough sonnetous for the ${formatSonnetous(BOND)} bond`;
  return null;
}

export function validateChallenge(player, market, now) {
  if (!player) return 'Log in to challenge a result';
  if (!market) return 'Market not found';
  if (market.status === 'challenged') return 'This report has already been challenged';
  if (market.status !== 'reported') return 'There is no reported result to challenge';
  if (!(now < market.reportedAt + CHALLENGE_WINDOW_MS)) return 'The challenge window has closed';
  if (market.reportedBy === player.uid) return "You can't challenge your own report";
  if (player.balance < BOND) return `Not enough sonnetous for the ${formatSonnetous(BOND)} bond`;
  return null;
}

export function validateVote(player, market, { hasStake = false, hasVoted = false } = {}, now) {
  if (!player) return 'Log in to vote';
  if (!market) return 'Market not found';
  if (market.status !== 'challenged') return 'This market is not under dispute';
  if (!(now < market.challengedAt + VOTE_WINDOW_MS)) return 'The voting window has closed';
  if (hasStake) return "You bet on this market, so you can't vote";
  if (player.uid === market.reportedBy || player.uid === market.challengedBy) {
    return "You're part of this dispute, so you can't vote";
  }
  if (hasVoted) return "You've already voted";
  return null;
}

// ---------------------------------------------------------------- finalisation & claims

/**
 * What finalize would do to this market right now (null = nothing yet). Pure; anyone may apply it.
 * Void outcomes carry resolvedOptionId null / eventAt null.
 */
export function finalizeOutcome(market, now) {
  if (!market) return null;
  const VOID = { status: 'void', resolvedOptionId: null, eventAt: null };
  const reportedResult = () => {
    if (market.mode === 'pool' && !((market.optionTotals || {})[market.reportedOptionId] > 0)) return VOID;
    return {
      status: 'resolved',
      resolvedOptionId: market.reportedOptionId,
      eventAt: isNum(market.reportedEventAt) ? market.reportedEventAt : null,
    };
  };
  if (market.status === 'open') {
    if (market.kind === 'timer' && isNum(market.expiresAt) && market.expiryOptionId && now >= market.expiresAt) {
      return { status: 'resolved', resolvedOptionId: market.expiryOptionId, eventAt: null };
    }
    return null;
  }
  if (market.status === 'reported') {
    return now >= market.reportedAt + CHALLENGE_WINDOW_MS ? reportedResult() : null;
  }
  if (market.status === 'challenged') {
    if (!(now >= market.challengedAt + VOTE_WINDOW_MS)) return null;
    return (market.votesUphold || 0) > (market.votesOverturn || 0) ? reportedResult() : VOID;
  }
  return null;
}

export function penaltyActive(player, now) {
  return isNum(player.penaltyUntil) && player.penaltyUntil > now;
}

/**
 * Settlement of one bet against a final market.
 * fixed gross = floor(amount*odds + 1e-9); pool gross = floor(amount*totalPool/optionTotals[winner]);
 * tax = floor((gross-amount)*0.25) only when the player's penalty is active and gross > amount. Void refunds the stake.
 */
export function betClaim(bet, market, player, now) {
  if (!market || !isFinal(market)) throw new Error('This market has not been settled yet');
  if (market.status === 'void') return { status: 'void', payout: bet.amount, taxed: 0 };
  if (bet.optionId !== market.resolvedOptionId) return { status: 'lost', payout: 0, taxed: 0 };
  let gross;
  if (market.mode === 'pool') {
    const winTotal = (market.optionTotals || {})[market.resolvedOptionId] || 0;
    const num = bet.amount * (market.totalPool || 0);
    gross = winTotal > 0 ? (num - (num % winTotal)) / winTotal : bet.amount;
  } else {
    let odds = bet.odds;
    if (!isNum(odds)) odds = market.oddsById ? market.oddsById[bet.optionId] : null;
    gross = Math.floor(bet.amount * (isNum(odds) ? odds : 1) + 1e-9);
  }
  let taxed = 0;
  if (player && penaltyActive(player, now) && gross > bet.amount) {
    taxed = Math.floor((gross - bet.amount) * PENALTY_TAX);
  }
  return { status: 'won', payout: gross - taxed, taxed };
}

/** What each bond holder is owed once the market is final (0/0 before that or when there is no bond). */
export function bondClaims(market) {
  const none = { reporter: 0, challenger: 0 };
  if (!market || !isFinal(market) || !market.reportedBy) return none;
  if (!market.challengedBy) return { reporter: BOND, challenger: 0 };
  const up = market.votesUphold || 0;
  const down = market.votesOverturn || 0;
  if (up > down) return { reporter: 2 * BOND, challenger: 0 };
  if (down > up) return { reporter: 0, challenger: 2 * BOND };
  return { reporter: BOND, challenger: BOND };
}

// ---------------------------------------------------------------- wealth / bankruptcy

export function netWorth(player) {
  return (player.balance || 0) + (player.openStake || 0);
}

export function isBroke(player) {
  return player.balance < MIN_BET && (player.openStake || 0) === 0;
}

/** Earliest instant a bailout can be claimed: the UTC midnight after brokeSince. */
export function restartAvailableAt(player) {
  return isNum(player.brokeSince) ? (Math.floor(player.brokeSince / DAY_MS) + 1) * DAY_MS : null;
}

export function canClaimRestart(player, now) {
  const at = restartAvailableAt(player);
  return isBroke(player) && at !== null && now >= at;
}

export function restartPatch(player, now) {
  return {
    balance: RESTART_BALANCE,
    bankruptcies: (player.bankruptcies || 0) + 1,
    brokeSince: null,
    penaltyUntil: now + PENALTY_DAYS * DAY_MS,
  };
}

// ---------------------------------------------------------------- custom markets

export function buildCustomMarket({ id, player, user, now, title, description, kind, optionLabels, closesAt }) {
  const p = player || user;
  const t = String(title ?? '').trim();
  if (t.length < 3) throw new Error('Title must be at least 3 characters');
  if (t.length > 140) throw new Error('Title must be at most 140 characters');
  if (kind !== 'choice' && kind !== 'timer') throw new Error('Market kind must be "choice" or "timer"');

  let options;
  let mode;
  let close;
  if (kind === 'choice') {
    const labels = (Array.isArray(optionLabels) ? optionLabels : [])
      .map((l) => String(l ?? '').trim())
      .filter((l) => l.length > 0);
    if (labels.length < 2) throw new Error('Add at least 2 options');
    if (labels.length > 6) throw new Error('At most 6 options allowed');
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
      throw new Error('Options must be unique');
    }
    options = labels.map((label, i) => ({ id: `o${i + 1}`, label, odds: null }));
    mode = 'pool';
    if (!isNum(closesAt)) throw new Error('Pick a closing time');
    close = closesAt;
  } else {
    options = DEFAULT_TIMER_BUCKETS.map((o) => ({ ...o }));
    mode = 'fixed';
    close = closesAt == null ? now + DEFAULT_TIMER_CLOSE_HOURS * HOUR_MS : closesAt;
    if (!isNum(close)) throw new Error('Pick a valid closing time');
  }
  if (!(close > now)) throw new Error('Closing time must be in the future');

  return normalizeMarket({
    id,
    type: 'custom',
    templateId: null,
    kind,
    mode,
    title: t,
    description: String(description ?? '').trim(),
    category: 'Custom',
    emoji: kind === 'timer' ? '⏳' : '🎲',
    createdBy: p.uid,
    createdByName: p.username,
    openedAt: now,
    closesAt: close,
    options,
  });
}

// ---------------------------------------------------------------- house market audit

/**
 * Compares a stored house market with the deterministic template-built one. Returns a description of the
 * first difference, or null when they match. openedAt/closesAt may differ (different builder clocks), so
 * only the betting-window LENGTH is compared. For oracle markets the title / labels / params embed a
 * baseline computed at creation, so only structure (kind, mode, option ids, odds, buckets, oracle type) is compared.
 */
export function houseMarketMismatch(market, expected) {
  if (!market || !expected) return 'Market missing';
  const oracle = !!(expected.oracle || market.oracle);
  if (market.createdBy !== 'house') return 'Not created by the house';
  if (market.type !== 'auto') return 'Wrong market type';
  if (market.kind !== expected.kind) return 'Kind differs from the template';
  if (market.mode !== expected.mode) return 'Mode differs from the template';
  if (!oracle && market.title !== expected.title) return 'Title differs from the template';
  if (oracle && (!market.oracle || !expected.oracle || market.oracle.type !== expected.oracle.type)) {
    return 'Oracle differs from the template';
  }
  const a = (market.options || []).map((o) => o.id).join('|');
  const b = (expected.options || []).map((o) => o.id).join('|');
  if (a !== b) return 'Options differ from the template';
  for (const o of expected.options || []) {
    const mine = (market.options || []).find((x) => x.id === o.id);
    if (!oracle && mine.label !== o.label) return 'Option labels differ from the template';
    const mo = market.oddsById ? market.oddsById[o.id] : mine.odds;
    const eo = expected.oddsById ? expected.oddsById[o.id] : o.odds;
    if ((mo ?? null) !== (eo ?? null)) return 'Odds differ from the template';
  }
  if (JSON.stringify(market.bucketsById ?? null) !== JSON.stringify(expected.bucketsById ?? null)) {
    return 'Time buckets differ from the template';
  }
  if (market.closesAt - market.openedAt !== expected.closesAt - expected.openedAt) {
    return 'Betting window differs from the template';
  }
  return null;
}

// ---------------------------------------------------------------- PRNG

/** Seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash (unsigned). */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

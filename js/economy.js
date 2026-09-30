// Sonnetous economy: PURE game rules. No DOM, no storage. Importable from Node.
// Nothing here mutates its inputs; functions return new objects / patches.

export const CURRENCY = Object.freeze({ name: 'sonnetous', symbol: '§' });
export const STARTING_BALANCE = 500;
export const RESTART_BALANCE = 100;
export const MIN_BET = 1;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const PENALTY_DAYS = 3;
export const PENALTY_TAX = 0.25;
export const DEFAULT_TIMER_CLOSE_HOURS = 12;

export const DEFAULT_TIMER_BUCKETS = Object.freeze([
  Object.freeze({ id: 'd1', label: 'Within 1 day', odds: 6, fromDays: 0, toDays: 1 }),
  Object.freeze({ id: 'd4', label: '1–4 days', odds: 3, fromDays: 1, toDays: 4 }),
  Object.freeze({ id: 'd8', label: '4–8 days', odds: 1.8, fromDays: 4, toDays: 8 }),
  Object.freeze({ id: 'never', label: '8+ days', odds: 1.3, fromDays: 8, toDays: null }),
]);

// ---------------------------------------------------------------- helpers

const pad = (n) => String(n).padStart(2, '0');
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
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

/** 1234 -> '§1,234'; -5 -> '-§5'. Fractions are rounded. */
export function formatSonnetous(n) {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('en-US');
  return `${v < 0 ? '-' : ''}${CURRENCY.symbol}${s}`;
}

export function newUser(uid, username, now) {
  return {
    uid,
    username,
    balance: STARTING_BALANCE,
    createdAt: now,
    bankruptcies: 0,
    brokeSince: null,
    penaltyUntil: null,
    totalWagered: 0,
    totalWon: 0,
  };
}

// ---------------------------------------------------------------- market state

export function isBettingOpen(market, now) {
  return !!market && market.status === 'open' && now < market.closesAt;
}

export function marketPhase(market, now) {
  if (market.status === 'resolved') return 'resolved';
  if (market.status === 'void') return 'void';
  return now >= market.closesAt ? 'awaiting' : 'open';
}

// ---------------------------------------------------------------- betting

export function validateBet(user, market, optionId, amount, now) {
  if (!user) return 'Log in to place a bet';
  if (!market) return 'Market not found';
  if (market.status === 'resolved') return 'This market has already been resolved';
  if (market.status === 'void') return 'This market was voided';
  if (market.status !== 'open') return 'This market is not open';
  if (!(now < market.closesAt)) return 'Betting is closed for this market';
  const option = (market.options || []).find((o) => o.id === optionId);
  if (!option) return 'Unknown option';
  if (typeof amount !== 'number' || !Number.isInteger(amount)) return 'Bet must be a whole number of sonnetous';
  if (amount < MIN_BET) return `Minimum bet is ${formatSonnetous(MIN_BET)}`;
  if (amount > user.balance) return 'Not enough sonnetous';
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
  if (!option || !isNum(option.odds)) return 0;
  // epsilon guards against float error such as 100 * 1.15 = 114.99999999999999
  return Math.floor(amount * option.odds + 1e-9);
}

export function displayOdds(market, optionId) {
  if (market.mode === 'pool') {
    const optTotal = (market.optionTotals || {})[optionId] || 0;
    if (optTotal <= 0) return null;
    return (market.totalPool || 0) / optTotal;
  }
  const option = (market.options || []).find((o) => o.id === optionId);
  return option && isNum(option.odds) ? option.odds : null;
}

export function buildBet({ id, market, user, optionId, amount, now }) {
  const option = (market.options || []).find((o) => o.id === optionId);
  return {
    id,
    marketId: market.id,
    marketTitle: market.title,
    uid: user.uid,
    username: user.username,
    optionId,
    optionLabel: option ? option.label : optionId,
    amount,
    odds: market.mode === 'fixed' && option && isNum(option.odds) ? option.odds : null,
    placedAt: now,
    status: 'open',
    payout: 0,
    taxed: 0,
  };
}

/** Returns a patch { optionTotals, totalPool, betCount } without mutating the market. */
export function applyBetToMarket(market, optionId, amount) {
  const optionTotals = { ...(market.optionTotals || {}) };
  optionTotals[optionId] = (optionTotals[optionId] || 0) + amount;
  return {
    optionTotals,
    totalPool: (market.totalPool || 0) + amount,
    betCount: (market.betCount || 0) + 1,
  };
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
  const options = market.options || [];
  const openEnded = options.find((o) => o.toDays == null);
  if (!openEnded) return null;
  const finite = options.filter((o) => o.toDays != null).map((o) => o.toDays);
  const maxFinite = finite.length ? Math.max(...finite) : 0;
  return now >= market.openedAt + maxFinite * DAY_MS ? openEnded.id : null;
}

// ---------------------------------------------------------------- settlement

function openBetsOf(market, bets) {
  return (bets || []).filter((b) => b && b.marketId === market.id && b.status === 'open');
}

/** Everyone refunded, status 'void'. */
export function voidMarket(market, bets, now, resolvedBy) {
  const betPatches = {};
  const userDeltas = {};
  for (const b of openBetsOf(market, bets)) {
    betPatches[b.id] = { status: 'void', payout: b.amount, taxed: 0 };
    const d = (userDeltas[b.uid] ||= { balance: 0, totalWon: 0 });
    d.balance += b.amount;
  }
  return {
    marketPatch: { status: 'void', resolvedOptionId: null, resolvedAt: now, resolvedBy },
    betPatches,
    userDeltas,
  };
}

export function settleMarket(market, bets, winningOptionId, usersById, now, resolvedBy, eventAt = null) {
  if (!(market.options || []).some((o) => o.id === winningOptionId)) {
    throw new Error('Unknown winning option');
  }
  const open = openBetsOf(market, bets);
  const poolTotal = open.reduce((s, b) => s + b.amount, 0);
  const winTotal = open.filter((b) => b.optionId === winningOptionId).reduce((s, b) => s + b.amount, 0);

  if (market.mode === 'pool' && winTotal === 0) {
    return voidMarket(market, bets, now, resolvedBy);
  }

  const betPatches = {};
  const userDeltas = {};
  for (const b of open) {
    if (b.optionId !== winningOptionId) {
      betPatches[b.id] = { status: 'lost', payout: 0, taxed: 0 };
      continue;
    }
    let payout;
    if (market.mode === 'pool') {
      payout = Math.floor((b.amount * poolTotal) / winTotal);
    } else {
      payout = Math.floor(b.amount * (isNum(b.odds) ? b.odds : 1) + 1e-9);
    }
    let taxed = 0;
    const u = usersById && usersById[b.uid];
    if (u && isNum(u.penaltyUntil) && u.penaltyUntil > now && payout > b.amount) {
      taxed = Math.floor((payout - b.amount) * PENALTY_TAX);
      payout -= taxed;
    }
    betPatches[b.id] = { status: 'won', payout, taxed };
    if (payout > 0) {
      const d = (userDeltas[b.uid] ||= { balance: 0, totalWon: 0 });
      d.balance += payout;
      d.totalWon += payout;
    }
  }
  return {
    marketPatch: { status: 'resolved', resolvedOptionId: winningOptionId, resolvedAt: now, resolvedBy, eventAt },
    betPatches,
    userDeltas,
  };
}

// ---------------------------------------------------------------- wealth / bankruptcy

export function netWorth(user, bets) {
  const staked = (bets || [])
    .filter((b) => b && b.uid === user.uid && b.status === 'open')
    .reduce((s, b) => s + b.amount, 0);
  return user.balance + staked;
}

export function isBroke(user, bets) {
  if (user.balance >= MIN_BET) return false;
  return !(bets || []).some((b) => b && b.uid === user.uid && b.status === 'open');
}

export function canClaimRestart(user, bets, now) {
  return isBroke(user, bets) && !!user.brokeSince && user.brokeSince < dayKey(now);
}

export function restartPatch(user, now) {
  return {
    balance: RESTART_BALANCE,
    bankruptcies: (user.bankruptcies || 0) + 1,
    brokeSince: null,
    penaltyUntil: now + PENALTY_DAYS * DAY_MS,
  };
}

export function penaltyActive(user, now) {
  return isNum(user.penaltyUntil) && user.penaltyUntil > now;
}

// ---------------------------------------------------------------- custom markets

export function buildCustomMarket({ id, user, now, title, description, kind, optionLabels, closesAt }) {
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

  return {
    id,
    type: 'custom',
    templateId: null,
    kind,
    mode,
    title: t,
    description: String(description ?? '').trim(),
    category: 'Custom',
    emoji: kind === 'timer' ? '⏳' : '🎲',
    createdBy: user.uid,
    createdByName: user.username,
    openedAt: now,
    closesAt: close,
    options,
    optionTotals: zeroTotals(options),
    totalPool: 0,
    betCount: 0,
    status: 'open',
    resolvedOptionId: null,
    resolvedAt: null,
    resolvedBy: null,
    eventAt: null,
  };
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

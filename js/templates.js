// Sonnetous house-market templates. PURE: no DOM, no storage. Importable from Node.
//
// Two families:
//  * plain templates   – crisp "Counts if: …" criteria, a human reports the result with an evidence link.
//  * oracle templates  – data-checkable (see js/oracles.js). Their numbers (thresholds, odds, dates) come from a
//                        baseline fetched when the market is built, and are stored in market.oracle.params so
//                        expectedHouseMarket() can rebuild — and audit — the market later without the network.
import {
  DEFAULT_TIMER_CLOSE_HOURS, DAY_MS, HOUR_MS, mulberry32, hashString, normalizeMarket, houseMarketMismatch,
} from './economy.js';
import { makeOracle, createFetchers, sportsProbabilities, normCdf, fmtUsd, fmtDay, fmtDayLong, fmtUtc } from './oracles.js';

// ================================================================= odds helpers

const EDGE = 0.06; // house edge on oracle / rate-priced markets
export const MIN_ODDS = 1.05;
export const MAX_ODDS = 20;

const floor05 = (x) => Math.floor(x * 20 + 1e-9) / 20;
const clampOdds = (x) => Math.min(MAX_ODDS, Math.max(MIN_ODDS, floor05(x)));
/** Fair probability -> fixed odds with a house edge (rounded DOWN to 0.05, always within bounds). */
export const oddsFor = (p) => clampOdds((1 - EDGE) / Math.min(0.94, Math.max(0.03, p)));

const twoWay = (pYes) => {
  const p = Math.min(0.94, Math.max(0.06, pYes));
  return { yes: oddsFor(p), no: oddsFor(1 - p) };
};

const hoursLabel = (h) => {
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = h / 24;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`;
};
const unitNum = (h, unitHours) => {
  const v = h / unitHours;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

/**
 * Timer buckets from finite-bucket probabilities. `edgesH` are the bucket boundaries in HOURS (multiples of
 * 24 above 24h), `probs` the chance the event lands in each finite bucket; the open-ended tail gets the rest.
 * Odds = fair odds less a house edge, forced strictly decreasing (sooner = higher odds).
 */
export function probBuckets(edgesH, probs) {
  const tail = Math.max(0.02, 1 - probs.reduce((s, p) => s + p, 0));
  const all = [...probs, tail];
  const raw = all.map((p) => clampOdds((1 - EDGE) / p));
  for (let i = 1; i < raw.length; i++) raw[i] = Math.max(MIN_ODDS, Math.min(raw[i], floor05(raw[i - 1] * 0.9)));
  const out = [];
  let prev = 0;
  edgesH.forEach((to, i) => {
    const unitH = to <= 24 ? 1 : 24;
    const unit = to <= 24 ? (to === 1 ? 'hour' : 'hours') : 'days';
    const label = i === 0
      ? `Within ${hoursLabel(to)}`
      : `${unitNum(prev, unitH)}–${unitNum(to, unitH)} ${unit}`;
    out.push({ id: to <= 24 ? `h${to}` : `d${to / 24}`, label, odds: raw[i], fromDays: prev / 24, toDays: to / 24 });
    prev = to;
  });
  const lastUnit = prev <= 24 ? 1 : 24;
  out.push({ id: 'never', label: `${unitNum(prev, lastUnit)}+ ${prev <= 24 ? 'hours' : 'days'}`, odds: raw[raw.length - 1], fromDays: prev / 24, toDays: null });
  return out;
}

/** Poisson buckets: events arrive at `lambdaPerDay`; edges in hours. */
export function rateBuckets(lambdaPerDay, edgesH) {
  const F = (h) => 1 - Math.exp((-lambdaPerDay * h) / 24);
  const probs = edgesH.map((h, i) => F(h) - (i ? F(edgesH[i - 1]) : 0));
  return probBuckets(edgesH, probs);
}

// ================================================================= date / time helpers

const addDays = (dateStr, n) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayStart = (dateStr) => Date.parse(`${dateStr}T00:00:00Z`);
const utcDateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Next UTC midnight that is at least `minAheadMs` after `ms`. */
export function nextUtcMidnight(ms, minAheadMs = 0) {
  let t = (Math.floor(ms / DAY_MS) + 1) * DAY_MS;
  while (t - ms < minAheadMs) t += DAY_MS;
  return t;
}

function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
/** 'YYYY-MM-DD' calendar date in an IANA timezone. */
export function localDateStr(ms, tz) {
  const o = tzParts(ms, tz);
  return `${o.year}-${o.month}-${o.day}`;
}
const tzOffset = (ms, tz) => {
  const o = tzParts(ms, tz);
  return Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour) % 24, Number(o.minute), Number(o.second)) - Math.floor(ms / 1000) * 1000;
};
/** UTC ms of local 00:00 on `dateStr` in `tz`. */
export function localMidnight(dateStr, tz) {
  const guess = dayStart(dateStr);
  const c = guess - tzOffset(guess, tz);
  return guess - tzOffset(c, tz);
}

const pickOne = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];
const round = (x, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ================================================================= plain (human-reported) templates

const timer = (id, category, emoji, title, blurb, counts, evidence, buckets, closeHours = DEFAULT_TIMER_CLOSE_HOURS) => ({
  id, kind: 'timer', category, emoji, title,
  description: `${blurb} Counts if: ${counts} Evidence link required: ${evidence}.`,
  buckets, closeHours,
});
const choice = (id, category, emoji, title, blurb, counts, evidence, options, closeHours = 3) => ({
  id, kind: 'choice', category, emoji, title,
  description: `${blurb} Counts if: ${counts} Evidence link required: ${evidence}.`,
  options, closeHours,
});
const opt = (id, label, odds) => ({ id, label, odds });

const PLAIN_TEMPLATES = [
  // ---------------------------------------------------------------- Politics
  timer('trump-constitution', 'Politics', '🏛️',
    'How long till a court says a Trump action is unconstitutional?',
    'The judiciary and the executive branch, once again in the same room.',
    'a US federal court (district, appeals or Supreme Court) issues a written ruling, dated after this market opens, that holds a Trump administration action, order or policy unconstitutional, or blocks it (TRO, injunction or stay) on constitutional grounds. Rulings on statutes or procedure alone do not count.',
    'the ruling itself (CourtListener or the court\'s site) or Reuters/AP/NYT/WaPo coverage of it',
    rateBuckets(0.6, [3, 12, 24]), 6),
  timer('politics-scotus-emergency', 'Politics', '⚖️',
    'How long till SCOTUS rules on a Trump administration emergency application?',
    'The "shadow docket" refuses to go quiet.',
    'the US Supreme Court issues an order (grant, denial, stay or administrative stay) on an emergency application in a case where the federal government is a party, dated after this market opens.',
    'the order on supremecourt.gov or SCOTUSblog coverage of it',
    rateBuckets(0.15, [24, 72, 168])),
  timer('politics-rigged-2026', 'Politics', '🗳️',
    'How long till a 2026 Senate or governor candidate says the midterms are "rigged"?',
    'Midterm season, the sequel nobody asked for.',
    'a candidate on the November 3, 2026 general-election ballot for US Senate or governor is quoted on video or in a major outlet saying the 2026 election is, or will be, "rigged" or "stolen". Jokes and "rigged" about the media, sports or primaries do not count.',
    'a video clip or a Reuters/AP/NYT/WaPo/CNN/Fox article with the quote',
    rateBuckets(0.3, [12, 24, 72])),
  timer('politics-executive-order', 'Politics', '🖋️',
    'How long till the White House posts a new executive order?',
    'The pen is mightier than the sword, and apparently faster than the Senate.',
    'an Executive Order signed after this market opens appears on whitehouse.gov/presidential-actions or the Federal Register. Memoranda, proclamations and fact sheets do not count.',
    'the whitehouse.gov or federalregister.gov page for the order',
    rateBuckets(0.5, [6, 24, 48])),
  timer('politics-clarify', 'Politics', '🎤',
    'How long till a G20 leader\'s office "clarifies" what the leader just said?',
    '"What the president meant to say was…"',
    'the office or official spokesperson of a G20 head of state or government publicly says a remark by that leader was misinterpreted, taken out of context or needs clarification, within 24 hours of the remark.',
    'links to both the original remark and the clarification',
    rateBuckets(0.3, [12, 24, 72])),

  // ---------------------------------------------------------------- Tech / AI
  timer('ai-model-release', 'Tech/AI', '🧠',
    'How long till a big lab releases a newly named AI model?',
    'OpenAI, Google, Anthropic, xAI, Meta and DeepSeek are all running the same treadmill.',
    'OpenAI, Google/DeepMind, Anthropic, xAI, Meta or DeepSeek makes a newly named or newly versioned model generally available (app or API), dated after this market opens. Teasers, previews for waitlists and point-release patches do not count.',
    'the lab\'s blog post, release notes or docs page',
    rateBuckets(0.5, [3, 12, 24])),
  timer('tech-major-outage', 'Tech/AI', '☁️',
    'How long till AWS, Azure, Google Cloud or Cloudflare has a major outage?',
    'Half the internet, briefly reminded it lives in someone else\'s building.',
    'the official status page or post-incident report of AWS, Microsoft Azure, Google Cloud or Cloudflare describes a multi-service or multi-region outage or "major"/"service disruption" incident that begins after this market opens.',
    'the status-page incident or the provider\'s post-incident write-up',
    rateBuckets(0.1, [24, 72, 168])),
  timer('tech-layoffs', 'Tech/AI', '📉',
    'How long till a tech company confirms 1,000+ layoffs?',
    '"Streamlining", "efficiency" and "difficult decisions" bingo.',
    'a technology company (software, hardware, internet, semiconductors or telecom) publicly confirms layoffs of at least 1,000 employees in one announcement, dated after this market opens. Filings, company memos or major-outlet reports all count.',
    'the filing, memo or a Reuters/Bloomberg/AP article',
    rateBuckets(0.25, [24, 72, 168])),
  timer('ai-lawyer-hallucination', 'Tech/AI', '👩‍⚖️',
    'How long till a judge sanctions a lawyer for citing cases an AI invented?',
    'Bluebook format: perfect. Existence: optional.',
    'a court publicly sanctions, fines or formally rebukes (in a written order) a lawyer or party for citing fabricated cases or quotations produced by generative AI, with the order dated after this market opens.',
    'the court order or news coverage quoting it',
    rateBuckets(0.3, [12, 24, 72])),

  // ---------------------------------------------------------------- Sports
  timer('sports-pl-manager', 'Sports', '👔',
    'How long till a Premier League manager leaves their job?',
    'Twenty clubs, twenty ways to say "mutual consent".',
    'a Premier League club officially announces that its first-team head coach/manager has been sacked, resigned or left by mutual consent, announcement dated after this market opens. Caretaker or interim managers moving on do not count.',
    'the club\'s statement or a BBC Sport/Sky Sports article',
    rateBuckets(0.035, [168, 336, 672])),
  timer('sports-hat-trick', 'Sports', '🎩',
    'How long till someone scores a hat-trick in Europe\'s top five leagues?',
    'Premier League, La Liga, Serie A, Bundesliga, Ligue 1. Ball under the shirt is optional.',
    'one player scores three or more goals in a single league match in the Premier League, La Liga, Serie A, Bundesliga or Ligue 1, with kick-off after this market opens (own goals and shoot-outs do not count).',
    'the match report or the league\'s official match page',
    rateBuckets(0.25, [24, 72, 168])),
  timer('sports-red-card', 'Sports', '🟥',
    'How long till a Premier League match has a red card?',
    'Someone, somewhere, will lose their temper and their evening.',
    'a Premier League match played after this market opens has at least one straight red or second-yellow red card shown to a player or manager on the pitch or touchline (VAR-rescinded cards do not count).',
    'the match report on premierleague.com, BBC Sport or Sky Sports',
    rateBuckets(0.3, [24, 72, 168])),
  timer('sports-world-record', 'Sports', '🏅',
    'How long till a senior world record falls in athletics or swimming?',
    'Stopwatches at the ready.',
    'World Athletics or World Aquatics lists (or a major outlet reports) a new senior outdoor/long-course world record in an individual or relay event, set after this market opens. Ratification may come later; a credible report of the mark counts.',
    'the World Athletics/World Aquatics record page or a major-outlet report',
    rateBuckets(0.055, [72, 240, 672])),

  // ---------------------------------------------------------------- Crypto
  timer('crypto-hack', 'Crypto', '🕳️',
    'How long till a crypto hack or exploit of $50M+ is reported?',
    'The "code is law" crowd, meeting law.',
    'a single hack, exploit or theft of crypto worth at least $50 million USD at the time of theft (protocol, bridge, exchange or wallet) is reported, with the incident occurring after this market opens.',
    'a Rekt/DeFiLlama hacks page entry or coverage from CoinDesk, The Block or Reuters',
    rateBuckets(0.035, [168, 336, 672])),

  // ---------------------------------------------------------------- Culture
  timer('culture-billboard', 'Culture', '🎵',
    'How long till a new song takes #1 on the Billboard Hot 100?',
    'The Hot 100 crown changes hands more often than you think, and less often than you want.',
    'a Billboard Hot 100 chart published after this market opens lists a different #1 song than the chart that was current when it opened. The event time is the chart\'s publication time.',
    'the billboard.com chart page(s), current and new',
    probBuckets([168, 336, 504], [0.3, 0.24, 0.17])),

  // ---------------------------------------------------------------- Weird news / science
  timer('weird-florida-man', 'Weird news', '🐊',
    'How long till a major outlet runs a "Florida man" headline?',
    'A national treasure that keeps on giving.',
    'a headline (article title) on AP, Reuters, BBC, CNN, NBC News or Fox News contains the words "Florida man", published after this market opens.',
    'the article link (the headline must be visible)',
    rateBuckets(0.7, [3, 12, 24]), 6),
  timer('science-launch-failure', 'Science', '🚀',
    'How long till an orbital launch fails to reach orbit?',
    'Rocket science is, in fact, hard.',
    'an orbital launch attempt by any operator anywhere ends in failure (vehicle lost, or payload not delivered to a usable orbit), with the launch after this market opens. Suborbital tests and successful launches with a partial anomaly do not count.',
    'the entry in Wikipedia\'s "2026 in spaceflight" or a Spaceflight Now/NASASpaceflight report',
    rateBuckets(0.02, [168, 336, 672])),
  timer('science-hurricane-named', 'Science', '🌀',
    'How long till the NHC names a new Atlantic storm?',
    'Peak season is behind us, but the ocean has not read the calendar.',
    'the US National Hurricane Center issues an advisory that names a new Atlantic tropical or subtropical storm (the next name on the 2026 list), with the first naming advisory after this market opens.',
    'the NHC advisory or nhc.noaa.gov storm page',
    rateBuckets(0.06, [120, 288, 504])),
  timer('weird-fda-recall', 'Weird news', '🥫',
    'How long till the FDA posts a new food recall notice?',
    'Check the pantry. Or don\'t.',
    'a food or beverage recall notice appears on the FDA\'s "Recalls, Market Withdrawals & Safety Alerts" page (fda.gov) with a posting date after this market opens.',
    'the fda.gov recall notice',
    rateBuckets(0.6, [6, 24, 48])),

  // ---------------------------------------------------------------- Friend group (settled from the game itself)
  timer('friends-bankrupt', 'Friend Group', '💀',
    'How long till one of us goes bankrupt?',
    'Someone is about to learn what "all-in" means.',
    'the Players list shows a player with a balance under §1 and no open stakes (the bankruptcy state the game itself recognises).',
    'a screenshot of the Players list',
    rateBuckets(0.05, [72, 168, 336])),
  timer('friends-whale', 'Friend Group', '🐋',
    'How long till someone is worth §1,000?',
    'Twice the starting money. Modesty is not a factor.',
    'the leaderboard shows any player whose balance plus open stakes is at least §1,000.',
    'a screenshot of the leaderboard',
    rateBuckets(0.1, [24, 72, 168])),
  timer('friends-challenge', 'Friend Group', '🚩',
    'How long till someone challenges a reported result?',
    'Trust, but put §20 on it.',
    'any market in the app moves to the "Challenged" state (the challenger has paid the §20 bond), with the challenge after this market opens.',
    'a screenshot of the challenged market',
    rateBuckets(0.15, [24, 72, 168])),
  timer('friends-plans', 'Friend Group', '📅',
    'How long till we actually lock in the plans we keep talking about?',
    '"We should totally do that." — everyone, since spring.',
    'a message in the group chat names a specific date, time and place, and at least two other members reply that they are in.',
    'a screenshot of the message and replies',
    rateBuckets(0.08, [72, 168, 336])),
  timer('friends-omw', 'Friend Group', '🛏️',
    'How long till someone says "omw" while still in bed?',
    'Location: horizontal.',
    'a member posts "omw"/"on my way" in the group chat and another member posts a photo, location share or a witness statement within 15 minutes showing they had not left home.',
    'a screenshot of the "omw" and the proof',
    rateBuckets(1, [2, 6, 12]), 6),

  // ---------------------------------------------------------------- Markets (choice)
  choice('markets-sp500-direction', 'Markets', '📊',
    'Will the S&P 500 close higher on its next session?',
    'Stocks only go up, said the people who were paid to say it.',
    'the S&P 500\'s official close for the first regular US session that opens after betting closes is higher than the previous session\'s close.',
    'a Google Finance/Yahoo Finance/WSJ page or chart showing both closes',
    [opt('up', 'Higher close', 1.85), opt('down', 'Flat or lower', 2.05)]),
  choice('markets-sp500-big-move', 'Markets', '🎢',
    'Will the S&P 500 move 1% or more on its next session?',
    'Calm markets are just volatility taking a nap.',
    'the S&P 500\'s close-to-close change for the first regular US session that opens after betting closes is at least 1.0% up or down.',
    'a Google Finance/Yahoo Finance/WSJ page or chart showing both closes',
    [opt('big', 'Moves 1%+ either way', 3.3), opt('calm', 'Moves less than 1%', 1.3)]),
  choice('markets-nasdaq-vs-dow', 'Markets', '⚔️',
    'Nasdaq-100 or Dow: who does better on the next session?',
    'Tech bros versus dinosaurs.',
    'for the first regular US session that opens after betting closes, the Nasdaq-100\'s close-to-close percentage change is greater than the Dow Jones Industrial Average\'s.',
    'a Google Finance/Yahoo Finance/WSJ page showing both percentage changes',
    [opt('nasdaq', 'Nasdaq-100 does better', 1.85), opt('dow', 'Dow does better (or ties)', 2)]),
];

// ================================================================= oracle templates

const VOL_H = { 'BTC-USD': 0.005, 'ETH-USD': 0.007, 'SOL-USD': 0.01 }; // hourly stdev of returns (rough)

function niceStep(spot) {
  const target = spot * 0.004;
  const mag = 10 ** Math.floor(Math.log10(target));
  for (const m of [5, 2, 1]) if (m * mag <= target) return m * mag;
  return mag;
}
const roundTo = (x, step) => Number((Math.round(x / step) * step).toFixed(6));

const oracleT = (o) => o;

/** "Will {coin} close above $X at midnight UTC?" */
function priceAboveTemplate({ id, symbol, coin, emoji }) {
  const HORIZON = 6 * HOUR_MS;
  const atOf = (openedAt) => nextUtcMidnight(openedAt, HORIZON);
  return {
    id, kind: 'choice', category: 'Crypto', emoji, closeHours: null,
    title: `Will ${coin} close above a price at midnight UTC?`,
    description: `Settles automatically from Coinbase ${symbol} data: ${coin} must close strictly above a threshold set from the live price when this market opens.`,
    oracle: oracleT({
      type: 'price_above',
      async baseline({ now, fetchers, rand }) {
        const spot = round(await fetchers.spot(symbol), 2);
        if (!(spot > 0)) return null;
        const hours = (atOf(now) - now) / HOUR_MS;
        const sigma = VOL_H[symbol] * Math.sqrt(hours);
        const z = pickOne(rand, [-0.5, -0.25, 0, 0.25, 0.5]);
        const threshold = roundTo(spot * Math.exp(z * sigma), niceStep(spot));
        return { symbol, coin, spot, threshold, at: atOf(now) };
      },
      validate(p, { openedAt }) {
        if (p.symbol !== symbol || !(p.spot > 0) || !(p.threshold > 0)) return 'bad price params';
        const sigma = VOL_H[symbol] * Math.sqrt((atOf(openedAt) - openedAt) / HOUR_MS);
        if (Math.abs(Math.log(p.threshold / p.spot)) > 1.5 * sigma + niceStep(p.spot) / p.spot) return 'threshold too far from spot';
        return null;
      },
      render(p, { openedAt }) {
        const at = atOf(openedAt);
        const sigma = VOL_H[symbol] * Math.sqrt((at - openedAt) / HOUR_MS);
        const pYes = 1 - normCdf(Math.log(p.threshold / p.spot) / sigma);
        const o = twoWay(pYes);
        const K = fmtUsd(p.threshold);
        return {
          title: `Will ${coin} close above ${K} at 00:00 UTC on ${fmtDay(at)}?`,
          description: `Settles automatically from Coinbase Exchange: the last 1-minute ${symbol} candle before ${fmtUtc(at)} must close strictly above ${K}. Live price when this market opened: ${fmtUsd(p.spot)}. Odds are priced from how far the threshold sits from the live price.`,
          options: [opt('yes', `Above ${K}`, o.yes), opt('no', `${K} or below`, o.no)],
          closesAt: at - 30 * 60_000,
          params: { symbol, coin, spot: p.spot, threshold: p.threshold, at },
        };
      },
    }),
  };
}

const MOVE_CLOSE_HOURS = 6;

/** "How long till {coin} moves ±pct% from $base?" */
function priceMoveTemplate({ id, symbol, coin, emoji, pct, buckets }) {
  return {
    id, kind: 'timer', category: 'Crypto', emoji, closeHours: MOVE_CLOSE_HOURS,
    title: `How long till ${coin} moves ±${pct}% from its current price?`,
    description: `Settles automatically from Coinbase ${symbol} candles: the first time the price touches ${pct}% above or below the price when this market opens.`,
    buckets,
    oracle: oracleT({
      type: 'price_move',
      async baseline({ fetchers }) {
        const base = round(await fetchers.spot(symbol), symbol === 'SOL-USD' ? 2 : 0);
        return base > 0 ? { symbol, coin, base, pct } : null;
      },
      validate(p) {
        return p.symbol === symbol && p.pct === pct && p.base > 0 ? null : 'bad move params';
      },
      render(p) {
        const up = round(p.base * (1 + pct / 100), 2);
        const down = round(p.base * (1 - pct / 100), 2);
        return {
          title: `How long till ${coin} moves ±${pct}% from ${fmtUsd(p.base)}?`,
          description: `Settles automatically from Coinbase Exchange ${symbol} candles: counts at the first 5-minute (later hourly) candle after this market opens whose high reaches ${fmtUsd(up)} or whose low reaches ${fmtUsd(down)} (±${pct}% of ${fmtUsd(p.base)}, the price when this market opened).`,
          options: buckets.map((b) => ({ ...b })),
          closeHours: MOVE_CLOSE_HOURS,
          params: { symbol, coin, base: p.base, pct },
        };
      },
    }),
  };
}

/** "How long till an M{minMag}+ earthquake anywhere?" */
function quakeTemplate({ id, minMag, emoji, buckets, closeHours = 6 }) {
  return {
    id, kind: 'timer', category: 'Science', emoji, closeHours,
    title: `How long till an M${minMag.toFixed(1)}+ earthquake anywhere?`,
    description: `Settles automatically from the USGS earthquake catalog: the first M${minMag.toFixed(1)}+ event after this market opens.`,
    buckets,
    oracle: oracleT({
      type: 'quake',
      needsNetwork: false, // nothing to fetch when building, so it still works while the data sources are down
      async baseline() { return { minMag }; },
      validate(p) { return p.minMag === minMag ? null : 'bad quake params'; },
      render() {
        return {
          title: `How long till an M${minMag.toFixed(1)}+ earthquake anywhere?`,
          description: `Settles automatically from the USGS earthquake catalog (earthquake.usgs.gov): counts at the origin time of the first event of magnitude ${minMag.toFixed(1)} or greater anywhere on Earth after this market opens. Magnitudes as listed by USGS.`,
          options: buckets.map((b) => ({ ...b })),
          closeHours,
          params: { minMag },
        };
      },
    }),
  };
}

const CITIES = {
  london: { city: 'London', lat: 51.5072, lon: -0.1276, tz: 'Europe/London', wet: 0.4 },
  nyc: { city: 'New York', lat: 40.7128, lon: -74.006, tz: 'America/New_York', wet: 0.3 },
  seattle: { city: 'Seattle', lat: 47.6062, lon: -122.3321, tz: 'America/Los_Angeles', wet: 0.4 },
  tokyo: { city: 'Tokyo', lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo', wet: 0.3 },
  sydney: { city: 'Sydney', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney', wet: 0.3 },
  mumbai: { city: 'Mumbai', lat: 19.076, lon: 72.8777, tz: 'Asia/Kolkata', wet: 0.25 },
  paris: { city: 'Paris', lat: 48.8566, lon: 2.3522, tz: 'Europe/Paris' },
  chicago: { city: 'Chicago', lat: 41.8781, lon: -87.6298, tz: 'America/Chicago' },
};

/** Common weather timing: `date` (city-local) plus derived betting close and settle time. */
const weatherTimes = (p, openedAt) => {
  const start = localMidnight(p.date, p.tz);
  return {
    closesAt: Math.min(openedAt + 6 * HOUR_MS, start - 15 * 60_000),
    at: localMidnight(addDays(p.date, 1), p.tz) + 3 * HOUR_MS,
  };
};
const weatherDate = (now, tz) => {
  let date = addDays(localDateStr(now, tz), 1);
  if (localMidnight(date, tz) - now < 6.5 * HOUR_MS) date = addDays(date, 1); // keep a real betting window
  return date;
};
const weatherValid = (p, c, openedAt) => {
  if (p.city !== c.city || p.tz !== c.tz || p.lat !== c.lat || p.lon !== c.lon) return 'bad city';
  if (!validDate(p.date) || !(localMidnight(p.date, c.tz) - openedAt >= 6 * HOUR_MS)) return 'bad date';
  if (!(p.pYes >= 0.05 && p.pYes <= 0.95)) return 'bad probability';
  return null;
};

/** "Will it rain in {city} tomorrow?" (≥ 1 mm) */
function rainTemplate({ id, key, emoji }) {
  const c = CITIES[key];
  return {
    id, kind: 'choice', category: 'Weather', emoji, closeHours: null,
    title: `Will it rain in ${c.city} tomorrow?`,
    description: `Settles automatically from Open-Meteo: 1 mm or more of precipitation on the ${c.city} calendar day counts as rain.`,
    oracle: oracleT({
      type: 'weather',
      async baseline({ now, fetchers }) {
        const date = weatherDate(now, c.tz);
        const f = await fetchers.forecast({ lat: c.lat, lon: c.lon, tz: c.tz, date });
        let pf;
        if (typeof f.precipProb === 'number') pf = (f.precipProb / 100) * 0.85;
        else if (typeof f.precipSum === 'number') pf = f.precipSum >= 1 ? 0.75 : f.precipSum >= 0.2 ? 0.4 : 0.15;
        else return null;
        const pYes = Math.min(0.92, Math.max(0.08, 0.7 * pf + 0.3 * c.wet));
        return { ...c, metric: 'precip', threshold: 1, date, pYes: round(pYes, 3), at: 0 };
      },
      validate(p, { openedAt }) { return p.metric === 'precip' && p.threshold === 1 ? weatherValid(p, c, openedAt) : 'bad rain params'; },
      render(p, { openedAt }) {
        const t = weatherTimes(p, openedAt);
        const o = twoWay(p.pYes);
        return {
          title: `Will it rain in ${c.city} on ${fmtDayLong(p.date)}?`,
          description: `Settles automatically from Open-Meteo: 1 mm or more of total precipitation on ${c.city}'s local calendar day of ${fmtDayLong(p.date)} counts as rain. Odds blend today's forecast with the local climate.`,
          options: [opt('yes', 'Rain (1 mm or more)', o.yes), opt('no', 'Dry (under 1 mm)', o.no)],
          closesAt: t.closesAt,
          params: { city: c.city, lat: c.lat, lon: c.lon, tz: c.tz, metric: 'precip', threshold: 1, date: p.date, pYes: p.pYes, at: t.at },
        };
      },
    }),
  };
}

/** "Will {city} hit {T}°C?" — threshold chosen from the forecast. */
function tempTemplate({ id, key, emoji }) {
  const c = CITIES[key];
  return {
    id, kind: 'choice', category: 'Weather', emoji, closeHours: null,
    title: `Will ${c.city} hit a temperature threshold tomorrow?`,
    description: `Settles automatically from Open-Meteo: the ${c.city} daily high temperature must reach a threshold set from the forecast.`,
    oracle: oracleT({
      type: 'weather',
      async baseline({ now, fetchers, rand }) {
        const date = weatherDate(now, c.tz);
        const f = await fetchers.forecast({ lat: c.lat, lon: c.lon, tz: c.tz, date });
        if (typeof f.tmax !== 'number') return null;
        const threshold = Math.round(f.tmax) + pickOne(rand, [-2, 0, 2]);
        const pYes = 1 - normCdf((threshold - 0.25 - f.tmax) / 1.8);
        return { ...c, metric: 'tmax', threshold, date, forecast: round(f.tmax, 1), pYes: round(Math.min(0.92, Math.max(0.08, pYes)), 3), at: 0 };
      },
      validate(p, { openedAt }) {
        return p.metric === 'tmax' && Number.isInteger(p.threshold) && Math.abs(p.threshold - p.forecast) <= 4 ? weatherValid(p, c, openedAt) : 'bad temperature params';
      },
      render(p, { openedAt }) {
        const t = weatherTimes(p, openedAt);
        const o = twoWay(p.pYes);
        return {
          title: `Will ${c.city} hit ${p.threshold}°C on ${fmtDayLong(p.date)}?`,
          description: `Settles automatically from Open-Meteo: ${c.city}'s daily high temperature (2 m) on its local calendar day of ${fmtDayLong(p.date)} must be ${p.threshold}°C or higher. Forecast when this market opened: ${p.forecast}°C.`,
          options: [opt('yes', `${p.threshold}°C or higher`, o.yes), opt('no', `Below ${p.threshold}°C`, o.no)],
          closesAt: t.closesAt,
          params: { city: c.city, lat: c.lat, lon: c.lon, tz: c.tz, metric: 'tmax', threshold: p.threshold, forecast: p.forecast, date: p.date, pYes: p.pYes, at: t.at },
        };
      },
    }),
  };
}

const WIKI_NOISE = 0.35; // stdev of log(viewsA/viewsB) day to day

/** "Who gets more English Wikipedia views on {date}: A or B?" */
function wikiTemplate({ id, emoji, a, b }) {
  const timesOf = (date, openedAt) => {
    const start = dayStart(date);
    return { closesAt: Math.min(openedAt + 12 * HOUR_MS, start), at: start + DAY_MS + 6 * HOUR_MS };
  };
  return {
    id, kind: 'choice', category: 'Wikipedia', emoji, closeHours: null,
    title: `Wikipedia views: ${a.label} or ${b.label}?`,
    description: `Settles automatically from Wikimedia pageview data: whichever English Wikipedia article gets more views on the day.`,
    oracle: oracleT({
      type: 'wiki_battle',
      async baseline({ dateKey, now, fetchers }) {
        const from = addDays(dateKey, -7);
        const to = addDays(dateKey, -1);
        const [va, vb] = await Promise.all([
          fetchers.wikiViews({ project: 'en.wikipedia', article: a.article, from, to }),
          fetchers.wikiViews({ project: 'en.wikipedia', article: b.article, from, to }),
        ]);
        if (va.length < 3 || vb.length < 3) return null;
        const ma = median(va);
        const mb = median(vb);
        if (!(ma >= 5000 && mb >= 5000)) return null; // wrong title / redirect => tiny numbers
        const pA = normCdf(Math.log(ma / mb) / WIKI_NOISE);
        if (pA < 0.12 || pA > 0.88) return null; // lopsided battles are boring
        let date = addDays(dateKey, 1);
        if (dayStart(date) - now < 2 * HOUR_MS) date = addDays(date, 1);
        return { project: 'en.wikipedia', date, a: { ...a }, b: { ...b }, viewsA: Math.round(ma), viewsB: Math.round(mb), pA: round(pA, 3), at: 0 };
      },
      validate(p, { openedAt }) {
        if (p.a?.article !== a.article || p.b?.article !== b.article || p.project !== 'en.wikipedia') return 'bad wiki params';
        if (!validDate(p.date) || !(dayStart(p.date) - openedAt >= HOUR_MS)) return 'bad date';
        if (!(p.pA >= 0.1 && p.pA <= 0.9)) return 'bad probability';
        return null;
      },
      render(p, { openedAt }) {
        const t = timesOf(p.date, openedAt);
        const oa = oddsFor(p.pA);
        const ob = oddsFor(1 - p.pA);
        return {
          title: `Wikipedia views on ${fmtDayLong(p.date)} (UTC): ${a.label} or ${b.label}?`,
          description: `Settles automatically from Wikimedia: the English Wikipedia article ("${a.article.replace(/_/g, ' ')}" vs "${b.article.replace(/_/g, ' ')}") with more all-access, user-agent daily views on the UTC day of ${fmtDayLong(p.date)} wins. Recent typical daily views: ${p.viewsA.toLocaleString('en-US')} vs ${p.viewsB.toLocaleString('en-US')}.`,
          options: [opt('a', `${a.label} gets more`, oa), opt('b', `${b.label} gets more`, ob)],
          closesAt: t.closesAt,
          params: { project: 'en.wikipedia', date: p.date, a: { ...a }, b: { ...b }, viewsA: p.viewsA, viewsB: p.viewsB, pA: p.pA, at: t.at },
        };
      },
    }),
  };
}

const SPORTS_LEAGUES = [
  { id: 'sports-nfl', sport: 'football', league: 'nfl', key: 'nfl', label: 'NFL', emoji: '🏈' },
  { id: 'sports-nba', sport: 'basketball', league: 'nba', key: 'nba', label: 'NBA', emoji: '🏀' },
  { id: 'sports-mlb', sport: 'baseball', league: 'mlb', key: 'mlb', label: 'MLB', emoji: '⚾' },
  { id: 'sports-nhl', sport: 'hockey', league: 'nhl', key: 'nhl', label: 'NHL', emoji: '🏒' },
  { id: 'sports-wnba', sport: 'basketball', league: 'wnba', key: 'wnba', label: 'WNBA', emoji: '🏀' },
  { id: 'sports-epl', sport: 'soccer', league: 'eng.1', key: 'epl', label: 'Premier League', emoji: '⚽', draw: true },
  { id: 'sports-laliga', sport: 'soccer', league: 'esp.1', key: 'laliga', label: 'La Liga', emoji: '⚽', draw: true },
  { id: 'sports-bundesliga', sport: 'soccer', league: 'ger.1', key: 'bundesliga', label: 'Bundesliga', emoji: '⚽', draw: true },
  { id: 'sports-seriea', sport: 'soccer', league: 'ita.1', key: 'seriea', label: 'Serie A', emoji: '⚽', draw: true },
  { id: 'sports-ucl', sport: 'soccer', league: 'uefa.champions', key: 'ucl', label: 'Champions League', emoji: '🏆', draw: true },
  { id: 'sports-mls', sport: 'soccer', league: 'usa.1', key: 'mls', label: 'MLS', emoji: '⚽', draw: true },
];

/** "Who wins: X vs Y?" built from that day's ESPN schedule. */
function sportsTemplate(cfg) {
  const draw = !!cfg.draw;
  const timesOf = (startAt) => ({ closesAt: startAt - 5 * 60_000, at: startAt + 100 * 60_000 });
  const validParams = (p, openedAt) => {
    if (p.sport !== cfg.sport || p.league !== cfg.league || !!p.draw !== draw) return 'bad sports params';
    if (!/^\d{8}$/.test(String(p.date)) || !p.eventId || !(p.startAt - openedAt >= 30 * 60_000) || p.startAt - openedAt > 36 * HOUR_MS) return 'bad game time';
    const sum = p.pHome + p.pAway + (draw ? p.pDraw : 0);
    if (!(Math.abs(sum - 1) < 0.02) || !(p.pHome > 0.05 && p.pAway > 0.05)) return 'bad probabilities';
    return null;
  };
  return {
    id: cfg.id, kind: 'choice', category: 'Sports', emoji: cfg.emoji, closeHours: null,
    title: `${cfg.label}: who wins the next game?`,
    description: `Settles automatically from ESPN's final score for a ${cfg.label} game picked from the day's schedule. Odds come from the pre-game betting line when ESPN lists one.`,
    oracle: oracleT({
      type: 'sports',
      async baseline({ now, fetchers, rand }) {
        const dates = [...new Set([utcDateOf(now - 6 * HOUR_MS), utcDateOf(now + 18 * HOUR_MS)])].map((d) => d.replace(/-/g, ''));
        const games = [];
        let anyOk = false;
        for (const d of dates) {
          try {
            const events = await fetchers.scoreboard(cfg.sport, cfg.league, d);
            anyOk = true;
            for (const e of events) {
              if (e.state !== 'pre' || !Number.isFinite(e.startAt)) continue;
              if (e.startAt < now + 45 * 60_000 || e.startAt > now + 30 * HOUR_MS) continue;
              const pr = sportsProbabilities(e, { sport: cfg.key === 'epl' || draw ? 'soccer' : cfg.key, draw });
              if (!pr) continue;
              games.push({ e, pr, date: d });
            }
          } catch { /* try the next date */ }
        }
        if (!anyOk || !games.length) return null;
        games.sort((x, y) => x.e.startAt - y.e.startAt || (x.e.id < y.e.id ? -1 : 1));
        const g = pickOne(rand, games);
        return {
          sport: cfg.sport, league: cfg.league, label: cfg.label, eventId: g.e.id, date: g.date, startAt: g.e.startAt, draw,
          homeName: g.e.home.name, awayName: g.e.away.name, homeAbbr: g.e.home.abbr, awayAbbr: g.e.away.abbr,
          pHome: round(g.pr.home, 3), pDraw: draw ? round(g.pr.draw, 3) : 0, pAway: round(g.pr.away, 3), at: 0,
        };
      },
      validate: (p, { openedAt }) => validParams(p, openedAt),
      render(p, { openedAt }) {
        const t = timesOf(p.startAt);
        const when = fmtUtc(p.startAt);
        const options = [opt('home', `${p.homeName} win`, oddsFor(p.pHome))];
        if (draw) options.push(opt('draw', 'Draw', oddsFor(p.pDraw)));
        options.push(opt('away', `${p.awayName} win`, oddsFor(p.pAway)));
        return {
          title: draw ? `Who wins: ${p.homeName} vs ${p.awayName}?` : `Who wins: ${p.awayName} at ${p.homeName}?`,
          description: `${cfg.label}, ${when}. Settles automatically from ESPN's final score${draw ? ' (level after full time and any extra time = draw; penalty shoot-outs are ignored)' : ''}. If the game is postponed, nobody can settle it automatically — the group will have to sort it out.`,
          options,
          closesAt: t.closesAt,
          params: {
            sport: cfg.sport, league: cfg.league, label: cfg.label, eventId: p.eventId, date: p.date, startAt: p.startAt, draw,
            homeName: p.homeName, awayName: p.awayName, homeAbbr: p.homeAbbr, awayAbbr: p.awayAbbr,
            pHome: p.pHome, pDraw: draw ? p.pDraw : 0, pAway: p.pAway, at: t.at,
          },
        };
      },
    }),
  };
}

// Bucket sets for oracle timers (probabilities are rough climatology / volatility estimates).
const QUAKE60 = rateBuckets(0.38, [3, 12, 24]);
const QUAKE65 = rateBuckets(0.12, [24, 72, 168]);
const QUAKE70 = rateBuckets(0.04, [72, 168, 336]);
const MOVE_BTC5 = probBuckets([24, 72, 168], [0.05, 0.22, 0.31]);
const MOVE_BTC10 = probBuckets([72, 168, 336], [0.05, 0.15, 0.25]);
const MOVE_ETH10 = probBuckets([72, 168, 336], [0.09, 0.21, 0.28]);
const MOVE_SOL10 = probBuckets([24, 72, 168], [0.05, 0.16, 0.3]);

const WIKI_PAIRS = [
  ['wiki-swift-musk', '🎤', { article: 'Taylor_Swift', label: 'Taylor Swift' }, { article: 'Elon_Musk', label: 'Elon Musk' }],
  ['wiki-messi-ronaldo', '⚽', { article: 'Lionel_Messi', label: 'Messi' }, { article: 'Cristiano_Ronaldo', label: 'Ronaldo' }],
  ['wiki-batman-superman', '🦇', { article: 'Batman', label: 'Batman' }, { article: 'Superman', label: 'Superman' }],
  ['wiki-cat-dog', '🐈', { article: 'Cat', label: 'Cat' }, { article: 'Dog', label: 'Dog' }],
  ['wiki-bitcoin-ethereum', '🪙', { article: 'Bitcoin', label: 'Bitcoin' }, { article: 'Ethereum', label: 'Ethereum' }],
  ['wiki-pizza-burger', '🍕', { article: 'Pizza', label: 'Pizza' }, { article: 'Hamburger', label: 'Hamburger' }],
  ['wiki-python-javascript', '💻', { article: 'Python_(programming_language)', label: 'Python' }, { article: 'JavaScript', label: 'JavaScript' }],
  ['wiki-madrid-barca', '🏟️', { article: 'Real_Madrid_CF', label: 'Real Madrid' }, { article: 'FC_Barcelona', label: 'Barcelona' }],
];

const ORACLE_TEMPLATES = [
  priceAboveTemplate({ id: 'oracle-btc-above', symbol: 'BTC-USD', coin: 'Bitcoin', emoji: '₿' }),
  priceAboveTemplate({ id: 'oracle-eth-above', symbol: 'ETH-USD', coin: 'Ethereum', emoji: '⟠' }),
  priceAboveTemplate({ id: 'oracle-sol-above', symbol: 'SOL-USD', coin: 'Solana', emoji: '◎' }),
  priceMoveTemplate({ id: 'oracle-btc-move-5', symbol: 'BTC-USD', coin: 'Bitcoin', emoji: '📈', pct: 5, buckets: MOVE_BTC5 }),
  priceMoveTemplate({ id: 'oracle-btc-move-10', symbol: 'BTC-USD', coin: 'Bitcoin', emoji: '🎢', pct: 10, buckets: MOVE_BTC10 }),
  priceMoveTemplate({ id: 'oracle-eth-move-10', symbol: 'ETH-USD', coin: 'Ethereum', emoji: '🌊', pct: 10, buckets: MOVE_ETH10 }),
  priceMoveTemplate({ id: 'oracle-sol-move-10', symbol: 'SOL-USD', coin: 'Solana', emoji: '☀️', pct: 10, buckets: MOVE_SOL10 }),
  quakeTemplate({ id: 'oracle-quake-60', minMag: 6, emoji: '🌍', buckets: QUAKE60 }),
  quakeTemplate({ id: 'oracle-quake-65', minMag: 6.5, emoji: '🌋', buckets: QUAKE65, closeHours: 6 }),
  quakeTemplate({ id: 'oracle-quake-70', minMag: 7, emoji: '💥', buckets: QUAKE70, closeHours: 6 }),
  rainTemplate({ id: 'oracle-rain-london', key: 'london', emoji: '☔' }),
  rainTemplate({ id: 'oracle-rain-nyc', key: 'nyc', emoji: '🗽' }),
  rainTemplate({ id: 'oracle-rain-seattle', key: 'seattle', emoji: '🌧️' }),
  rainTemplate({ id: 'oracle-rain-tokyo', key: 'tokyo', emoji: '🌂' }),
  rainTemplate({ id: 'oracle-rain-sydney', key: 'sydney', emoji: '🦘' }),
  rainTemplate({ id: 'oracle-rain-mumbai', key: 'mumbai', emoji: '🌦️' }),
  tempTemplate({ id: 'oracle-temp-nyc', key: 'nyc', emoji: '🌡️' }),
  tempTemplate({ id: 'oracle-temp-paris', key: 'paris', emoji: '🥐' }),
  tempTemplate({ id: 'oracle-temp-chicago', key: 'chicago', emoji: '🌬️' }),
  ...WIKI_PAIRS.map(([id, emoji, a, b]) => wikiTemplate({ id, emoji, a, b })),
  ...SPORTS_LEAGUES.map(sportsTemplate),
];

export const TEMPLATES = [...PLAIN_TEMPLATES, ...ORACLE_TEMPLATES];
/** Templates settled by a human report + evidence link. */
export const PLAIN_TEMPLATE_LIST = PLAIN_TEMPLATES;
/** Templates settled by js/oracles.js data. */
export const ORACLE_TEMPLATE_LIST = ORACLE_TEMPLATES;

/** Templates that run every single day, on top of the random daily picks. */
export const FEATURED_TEMPLATE_IDS = ['trump-constitution'];

export const findTemplate = (id) => TEMPLATES.find((t) => t.id === id) || null;

// ================================================================= building markets

function seededShuffle(list, seedStr) {
  const rand = mulberry32(hashString(seedStr));
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

/** Deterministic pick of `count` distinct PLAIN (human-settled) templates for a date key (seeded Fisher–Yates). */
export function pickDailyTemplates(dateKey, count = 4) {
  return seededShuffle(PLAIN_TEMPLATES, `sonnetous:${dateKey}`).slice(0, Math.max(0, Math.min(count, PLAIN_TEMPLATES.length)));
}

/**
 * Build a fresh open house market from a template. Id is idempotent per (dateKey, template).
 * Oracle templates need the `params` produced by their baseline (or read back from a stored market).
 */
export function buildAutoMarket(template, dateKey, now, params = null) {
  const isTimer = template.kind === 'timer';
  const base = {
    id: `auto-${dateKey}-${template.id}`,
    type: 'auto',
    templateId: template.id,
    kind: template.kind,
    mode: 'fixed',
    category: template.category,
    emoji: template.emoji,
    createdBy: 'house',
    createdByName: 'The House',
    openedAt: now,
  };
  if (template.oracle) {
    if (!params) throw new Error(`Oracle template ${template.id} needs baseline params`);
    const r = template.oracle.render(params, { dateKey, openedAt: now });
    return normalizeMarket({
      ...base,
      title: r.title,
      description: r.description,
      closesAt: r.closesAt ?? now + (r.closeHours ?? template.closeHours ?? DEFAULT_TIMER_CLOSE_HOURS) * HOUR_MS,
      options: r.options.map((o) => ({ ...o })),
      oracle: makeOracle(template.oracle.type, r.params),
    });
  }
  const options = (isTimer ? template.buckets : template.options).map((o) => ({ ...o }));
  const closeHours = template.closeHours ?? (isTimer ? DEFAULT_TIMER_CLOSE_HOURS : 24);
  return normalizeMarket({
    ...base,
    title: template.title,
    description: template.description,
    closesAt: now + closeHours * HOUR_MS,
    options,
  });
}

/** Featured templates first, then `count` random (non-featured) plain picks. Sync, no oracles (tests / back-compat). */
export function dailyMarkets(dateKey, now, count = 4) {
  const featured = FEATURED_TEMPLATE_IDS.map(findTemplate).filter(Boolean);
  const random = pickDailyTemplates(dateKey, count + featured.length)
    .filter((t) => !FEATURED_TEMPLATE_IDS.includes(t.id))
    .slice(0, count);
  return [...featured, ...random].map((t) => buildAutoMarket(t, dateKey, now));
}

/**
 * The day's house markets: featured + `oracleCount` oracle markets + `otherCount` other plain markets.
 * An oracle template whose baseline fetch fails (or yields nothing usable) is skipped and replaced by another
 * oracle template when possible. Deterministic for a dateKey given the same fetched data.
 * @param {{ fetchers?: object, oracleCount?: number, otherCount?: number, maxOracleAttempts?: number }} opts
 */
export async function buildDailyMarkets(dateKey, now, opts = {}) {
  const { fetchers = createFetchers(), oracleCount = 2, otherCount = 2, maxOracleAttempts = 8 } = opts;
  const featured = FEATURED_TEMPLATE_IDS.map(findTemplate).filter(Boolean);

  const tryOracle = async (t) => {
    try {
      const rand = mulberry32(hashString(`sonnetous:${dateKey}:${t.id}`));
      const params = await t.oracle.baseline({ dateKey, now, fetchers, rand });
      if (!params) return null;
      const err = t.oracle.validate(params, { openedAt: now });
      if (err) return null;
      return buildAutoMarket(t, dateKey, now, params);
    } catch {
      return null;
    }
  };

  const order = seededShuffle(ORACLE_TEMPLATES, `sonnetous:oracle:${dateKey}`);
  const oracleMarkets = [];
  const usedTypes = new Set();
  const deferred = [];
  let attempts = 0;
  for (const t of order) {
    if (oracleMarkets.length >= oracleCount) break;
    if (t.oracle.needsNetwork !== false && attempts >= maxOracleAttempts) continue;
    if (usedTypes.has(t.oracle.type)) { deferred.push(t); continue; }
    if (t.oracle.needsNetwork !== false) attempts++;
    const m = await tryOracle(t);
    if (m) { oracleMarkets.push(m); usedTypes.add(t.oracle.type); }
  }
  for (const t of deferred) {
    if (oracleMarkets.length >= oracleCount) break;
    if (t.oracle.needsNetwork !== false && attempts >= maxOracleAttempts) continue;
    if (t.oracle.needsNetwork !== false) attempts++;
    const m = await tryOracle(t);
    if (m) oracleMarkets.push(m);
  }

  const others = pickDailyTemplates(dateKey, otherCount + featured.length)
    .filter((t) => !FEATURED_TEMPLATE_IDS.includes(t.id))
    .slice(0, otherCount);
  return [
    ...featured.map((t) => buildAutoMarket(t, dateKey, now)),
    ...oracleMarkets,
    ...others.map((t) => buildAutoMarket(t, dateKey, now)),
  ];
}

// ================================================================= auditing stored house markets

const ID_RE = /^auto-(\d{4}-\d{2}-\d{2})-(.+)$/;

/**
 * Rebuilds what a house market should look like from its templateId (and, for oracle markets, its stored
 * oracle params, which are sanity-checked). Returns null for unknown templates / invalid params / non-house markets.
 */
export function expectedHouseMarket(market) {
  try {
    if (!market || market.createdBy !== 'house') return null;
    const t = findTemplate(market.templateId);
    const m = ID_RE.exec(String(market.id));
    if (!t || !m || m[2] !== t.id || !Number.isFinite(market.openedAt)) return null;
    if (!t.oracle) return buildAutoMarket(t, m[1], market.openedAt);
    const params = market.oracle && market.oracle.params;
    if (!params || market.oracle.type !== t.oracle.type) return null;
    if (t.oracle.validate(params, { openedAt: market.openedAt })) return null;
    return buildAutoMarket(t, m[1], market.openedAt, params);
  } catch {
    return null;
  }
}

const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** null when a house market matches its template, else a short reason the UI can show next to a warning badge. */
export function checkHouseMarket(market) {
  const expected = expectedHouseMarket(market);
  if (!expected) return 'Unknown template or invalid parameters';
  const problem = typeof houseMarketMismatch === 'function' ? houseMarketMismatch(market, expected) : null;
  if (problem) return problem;
  if (market.title !== expected.title) return 'Title differs from the template';
  if (market.closesAt !== expected.closesAt) return 'Closing time differs from the template';
  if (market.reportableAt !== expected.reportableAt) return 'Reportable time differs from the template';
  if (market.expiresAt !== expected.expiresAt || market.expiryOptionId !== expected.expiryOptionId) return 'Expiry differs from the template';
  for (const o of expected.options) {
    const mine = (market.options || []).find((x) => x.id === o.id);
    if (!mine || mine.label !== o.label) return 'Option labels differ from the template';
  }
  if (expected.oracle && stable(market.oracle.params) !== stable(expected.oracle.params)) return 'Oracle parameters differ from the template';
  return null;
}

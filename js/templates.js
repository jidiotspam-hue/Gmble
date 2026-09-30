// Sonnetous auto-market templates. PURE: no DOM, no storage. Importable from Node.
import { DEFAULT_TIMER_BUCKETS, DEFAULT_TIMER_CLOSE_HOURS, HOUR_MS, mulberry32, hashString } from './economy.js';

const b = (id, label, fromDays, toDays, odds) => ({ id, label, odds, fromDays, toDays });

// Bucket presets (sooner / rarer = higher odds; last bucket is open-ended).
// Auto-resolution kicks in after the largest finite toDays.
const FAST = [ // hours-scale
  b('h1', 'Within 1 hour', 0, 1 / 24, 12),
  b('h6', '1–6 hours', 1 / 24, 0.25, 4),
  b('d1', '6–24 hours', 0.25, 1, 2.2),
  b('never', '1+ day', 1, null, 1.4),
];
const QUICK = [
  b('h6', 'Within 6 hours', 0, 0.25, 7),
  b('d1', '6 hours–1 day', 0.25, 1, 3.2),
  b('d3', '1–3 days', 1, 3, 1.8),
  b('never', '3+ days', 3, null, 1.3),
];
const SHORT = [
  b('d2', 'Within 2 days', 0, 2, 5),
  b('d7', '2–7 days', 2, 7, 2.4),
  b('d14', '1–2 weeks', 7, 14, 1.7),
  b('never', '2+ weeks', 14, null, 1.3),
];
const SLOW = [
  b('w1', 'Within 1 week', 0, 7, 6),
  b('w3', '1–3 weeks', 7, 21, 3),
  b('w6', '3–6 weeks', 21, 42, 1.8),
  b('never', '6+ weeks', 42, null, 1.3),
];

const RESOLVE = 'Hit "It happened!" when the group agrees it did (and pick the time it happened).';

const timer = (id, category, emoji, title, description, extra = {}) => ({
  id, kind: 'timer', category, emoji, title, description: `${description} ${RESOLVE}`, ...extra,
});
const choice = (id, category, emoji, title, description, options, closeHours = 24) => ({
  id, kind: 'choice', category, emoji, title, description, options, closeHours,
});

export const TEMPLATES = [
  // ---------------------------------------------------------------- Politics
  timer('trump-constitution', 'Politics', '🏛️',
    'How long till Trump violates the constitution again?',
    'Any credible headline containing the phrase "legal experts say" counts.'),
  timer('politics-gaffe', 'Politics', '🎤',
    'How long till a world leader says something their staff must "clarify"?',
    'The clarification must arrive within 24 hours of the original remark.', { buckets: QUICK }),
  timer('politics-deleted-tweet', 'Politics', '🗑️',
    'How long till a politician deletes a post and pretends it never happened?',
    'Screenshots are the only currency that matters here.', { buckets: FAST, closeHours: 1 }),
  timer('politics-shutdown', 'Politics', '🏗️',
    'How long till a government threatens a shutdown over something petty?',
    'Bonus sonnetous in spirit if it involves a spreadsheet.', { buckets: SHORT }),
  timer('politics-rigged', 'Politics', '🗳️',
    'How long till someone calls an election "rigged" before the votes are counted?',
    'Any election, anywhere, any level. The bar is on the floor.', { buckets: QUICK }),
  timer('politics-summit-photo', 'Politics', '🤝',
    'How long till a summit ends with a photo op and zero actual agreements?',
    'A firm handshake and a "productive conversation" is the bare minimum.', { buckets: SHORT }),

  // ---------------------------------------------------------------- Tech / AI
  timer('ai-agi-claim', 'Tech/AI', '🤖',
    'How long till a tech CEO says AGI is "just around the corner" again?',
    'Podcast appearances, keynotes and cryptic tweets all count.', { buckets: QUICK }),
  timer('ai-new-model', 'Tech/AI', '🧠',
    'How long till a "state of the art" AI model gets announced?',
    'Every benchmark number must be suspiciously higher than last week\'s.', { buckets: QUICK }),
  timer('tech-outage', 'Tech/AI', '☁️',
    'How long till a major cloud outage takes half the internet down?',
    'Status page saying "investigating" counts as the starting gun.', { buckets: SHORT }),
  timer('ai-lawyer-hallucination', 'Tech/AI', '⚖️',
    'How long till a lawyer gets caught citing a case an AI made up?',
    'The court must be visibly unimpressed.', { buckets: SLOW, closeHours: 24 }),
  timer('tech-layoffs', 'Tech/AI', '📉',
    'How long till a tech giant announces layoffs and record profits in the same week?',
    '"Streamlining" and "efficiency" are the magic words.', { buckets: SHORT }),
  timer('ai-chatbot-unhinged', 'Tech/AI', '💬',
    'How long till a chatbot goes viral for saying something completely unhinged?',
    'Screenshot needs at least a thousand likes and a raised eyebrow.', { buckets: QUICK }),
  timer('tech-nobody-asked', 'Tech/AI', '📱',
    'How long till a big tech company launches a feature nobody asked for?',
    'The launch video must include the word "reimagined".'),

  // ---------------------------------------------------------------- Celebrities
  timer('celeb-breakup', 'Celebrities', '💔',
    'How long till a celebrity couple announces they are "consciously uncoupling"?',
    'The joint statement must ask for privacy at this difficult time.', { buckets: SHORT }),
  timer('celeb-notes-apology', 'Celebrities', '📝',
    'How long till a celebrity posts a Notes-app apology screenshot?',
    'Extra credit if it is somehow not an apology.', { buckets: QUICK }),
  timer('celeb-billionaire-tweet', 'Celebrities', '🚀',
    'How long till a billionaire tweets something that moves a stock?',
    'The share price must visibly wobble within the hour.', { buckets: QUICK }),
  timer('celeb-tequila', 'Celebrities', '🥃',
    'How long till a celebrity launches their own tequila brand?',
    'Vodka, gin and "wellness elixirs" are strictly not accepted.', { buckets: SLOW, closeHours: 24 }),
  timer('celeb-ticket-crash', 'Celebrities', '🎫',
    'How long till concert ticket sales crash a website?',
    'A queue of 100,000+ people and a "please wait" screen count.', { buckets: SHORT }),

  // ---------------------------------------------------------------- Sports
  timer('sports-transfer-fee', 'Sports', '💸',
    'How long till a football club pays an absurd transfer fee?',
    'Absurd is defined as "your accountant would faint".', { buckets: SHORT }),
  timer('sports-manager-sacked', 'Sports', '👔',
    'How long till a football manager is sacked "by mutual consent"?',
    'Any top-flight manager, anywhere on Earth.', { buckets: QUICK }),
  timer('sports-var-delay', 'Sports', '📺',
    'How long till VAR takes over three minutes to draw a single line?',
    'Timing is done by the loudest person in the group chat.', { buckets: FAST, closeHours: 1 }),
  timer('sports-blame-equipment', 'Sports', '🎾',
    'How long till an athlete blames the equipment after a loss?',
    'Rackets, boots, and the ball itself are all fair game.', { buckets: QUICK }),

  // ---------------------------------------------------------------- Crypto
  timer('crypto-rugpull', 'Crypto', '🧵',
    'How long till a hyped token turns out to be a rug pull?',
    'Developers vanishing and a deleted Discord count as proof.', { buckets: QUICK }),
  timer('crypto-so-back', 'Crypto', '📈',
    'How long till someone posts "we\'re so back" about crypto?',
    'It must be posted unironically. Or at least ambiguously.', { buckets: FAST, closeHours: 1 }),
  timer('crypto-pause-withdrawals', 'Crypto', '🔒',
    'How long till a crypto exchange "temporarily pauses withdrawals"?',
    'Temporary is doing a lot of heavy lifting in that sentence.', { buckets: SHORT }),
  timer('crypto-dog-coin', 'Crypto', '🐕',
    'How long till a dog-themed coin gains 1000% for no reason?',
    'Extra sonnetous of respect if it is a frog instead.', { buckets: SHORT }),

  // ---------------------------------------------------------------- Weird news
  timer('weird-florida-man', 'Weird news', '🐊',
    'How long till a Florida Man headline goes global?',
    'It must involve an animal, a vehicle, or both.', { buckets: QUICK }),
  timer('weird-airplane', 'Weird news', '✈️',
    'How long till a passenger goes viral for something unhinged at 30,000 feet?',
    'Cabin crew looking exhausted in the background is a must.', { buckets: QUICK }),
  timer('weird-zoo-escape', 'Weird news', '🦘',
    'How long till an animal escapes its enclosure and wins the internet?',
    'Capture footage with a panicked human is required.', { buckets: SHORT }),
  timer('weird-ufo', 'Weird news', '🛸',
    'How long till someone says "this time the UFO footage is real"?',
    'Grainy footage. Dramatic music. Zero aliens.', { buckets: SHORT }),

  // ---------------------------------------------------------------- The Friend Group
  timer('friends-bankrupt', 'Friend Group', '💀',
    'How long till one of us goes bankrupt?',
    'Broke means zero sonnetous and no open bets. Thoughts and prayers welcome.'),
  timer('friends-omw', 'Friend Group', '🛏️',
    'How long till someone in the group chat says "omw" while still in bed?',
    'A second person must call it out with evidence.', { buckets: QUICK }),
  timer('friends-plans', 'Friend Group', '📅',
    'How long till we actually lock in the plans we keep talking about?',
    'A date, a time, and a place. "Sometime soon" is not a plan.', { buckets: SLOW, closeHours: 24 }),
  timer('friends-pointless-fight', 'Friend Group', '🥊',
    'How long till the group chat argues passionately about something pointless?',
    'Pineapple on pizza, cereal-vs-soup, whether a hot dog is a sandwich.', { buckets: FAST, closeHours: 1 }),
  timer('friends-brag', 'Friend Group', '🏆',
    'How long till someone brags about their winnings and immediately loses them?',
    'Both the brag and the loss must be visible in Activity.', { buckets: QUICK }),

  // ---------------------------------------------------------------- Choice markets (fixed odds)
  choice('choice-rain-hangout', 'Friend Group', '🌧️',
    'Will it rain on our next hangout?',
    'Decided by whoever checks the sky first. Umbrella bearers do not get a vote.',
    [
      { id: 'rain', label: 'Rain', odds: 2.4 },
      { id: 'dry', label: 'Dry', odds: 1.6 },
    ], 48),
  choice('choice-first-bankrupt', 'Friend Group', '☠️',
    'Who goes bankrupt first?',
    'The group votes on which archetype fits the first person to hit zero.',
    [
      { id: 'allin', label: 'The "all-in every time" guy', odds: 1.9 },
      { id: 'careful', label: 'The one who "is being careful"', odds: 3.6 },
      { id: 'pundit', label: 'The one who tells everyone else how to bet', odds: 4.2 },
      { id: 'nobody', label: 'Nobody, we are all geniuses', odds: 7 },
    ], 72),
  choice('choice-btc-week', 'Crypto', '₿',
    'Bitcoin by the end of the week: up, down or flat?',
    'Flat means within 1% of the price when this market opened.',
    [
      { id: 'up', label: 'Up more than 1%', odds: 2.4 },
      { id: 'down', label: 'Down more than 1%', odds: 2.6 },
      { id: 'flat', label: 'Flat (within 1%)', odds: 4.5 },
    ], 48),
  choice('choice-news-cycle', 'Weird news', '📰',
    'What dominates tomorrow\'s news cycle?',
    'Judged by the top three headlines on whichever site the group loathes most.',
    [
      { id: 'politics', label: 'A politician scandal', odds: 1.8 },
      { id: 'celeb', label: 'Celebrity drama', odds: 2.8 },
      { id: 'tech', label: 'A tech or AI announcement', odds: 3.4 },
      { id: 'good', label: 'Actual good news', odds: 9 },
    ], 24),
  choice('choice-underdog', 'Sports', '⚽',
    'Will the underdog win this weekend\'s big game?',
    'Pick the biggest match on TV. The bookies say the favorite is the favorite for a reason.',
    [
      { id: 'fav', label: 'Favorite wins', odds: 1.6 },
      { id: 'draw', label: 'Draw', odds: 4.2 },
      { id: 'underdog', label: 'Underdog wins', odds: 4.8 },
    ], 48),
  choice('choice-ai-headline', 'Tech/AI', '🗞️',
    'What will the next AI hype headline say?',
    'First big AI headline of the day wins.',
    [
      { id: 'changes', label: '"Changes everything"', odds: 1.7 },
      { id: 'dangerous', label: '"Is dangerously good"', odds: 3 },
      { id: 'jobs', label: '"Will replace your job by Friday"', odds: 4 },
      { id: 'trenchcoat', label: '"Was secretly a person in a trench coat"', odds: 14 },
    ], 24),
  choice('choice-pineapple', 'Friend Group', '🍍',
    'Does pineapple belong on pizza? (Group vote)',
    'Majority of the group chat decides. Abstainers count as no.',
    [
      { id: 'yes', label: 'Yes, and it is delicious', odds: 2.3 },
      { id: 'no', label: 'No, it is a crime', odds: 1.7 },
    ], 24),
  choice('choice-dinner', 'Friend Group', '🍽️',
    'Where does the group end up eating next time?',
    'Wherever you actually end up, not where you said you would.',
    [
      { id: 'pizza', label: 'Pizza (obviously)', odds: 2 },
      { id: 'tacos', label: 'Tacos', odds: 3.4 },
      { id: 'cereal', label: 'Nobody decides, cereal at home', odds: 4.8 },
      { id: 'fancy', label: 'Fancy place, someone cries at the bill', odds: 8 },
    ], 48),
];

/** Deterministic pick of `count` distinct templates for a date key (seeded Fisher–Yates shuffle). */
export function pickDailyTemplates(dateKey, count = 4) {
  const rand = mulberry32(hashString(`sonnetous:${dateKey}`));
  const pool = [...TEMPLATES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}

/** Build a fresh open house market from a template. Id is idempotent per (dateKey, template). */
export function buildAutoMarket(template, dateKey, now) {
  const isTimer = template.kind === 'timer';
  const source = isTimer ? template.buckets || DEFAULT_TIMER_BUCKETS : template.options;
  const options = source.map((o) => ({ ...o }));
  const closeHours = template.closeHours ?? (isTimer ? DEFAULT_TIMER_CLOSE_HOURS : 24);
  return {
    id: `auto-${dateKey}-${template.id}`,
    type: 'auto',
    templateId: template.id,
    kind: template.kind,
    mode: 'fixed',
    title: template.title,
    description: template.description,
    category: template.category,
    emoji: template.emoji,
    createdBy: 'house',
    createdByName: 'The House',
    openedAt: now,
    closesAt: now + closeHours * HOUR_MS,
    options,
    optionTotals: Object.fromEntries(options.map((o) => [o.id, 0])),
    totalPool: 0,
    betCount: 0,
    status: 'open',
    resolvedOptionId: null,
    resolvedAt: null,
    resolvedBy: null,
    eventAt: null,
  };
}

/** Templates that run every single day, on top of the random daily picks. */
export const FEATURED_TEMPLATE_IDS = ['trump-constitution'];

/** Featured templates first, then `count` random (non-featured) picks for the day. */
export function dailyMarkets(dateKey, now, count = 4) {
  const featured = FEATURED_TEMPLATE_IDS.map((id) => TEMPLATES.find((t) => t.id === id)).filter(Boolean);
  const random = pickDailyTemplates(dateKey, count + featured.length)
    .filter((t) => !FEATURED_TEMPLATE_IDS.includes(t.id))
    .slice(0, count);
  return [...featured, ...random].map((t) => buildAutoMarket(t, dateKey, now));
}

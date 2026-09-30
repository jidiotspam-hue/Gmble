# Sonnetous — build spec (source of truth for all modules)

A static web app (hosted on GitHub Pages, **no build step**, vanilla ES modules, no npm deps at runtime)
where a small group of friends bet a fake currency called **sonnetous** (symbol `§`) on anything.

## File layout
```
index.html              # single page, loads js/app.js as type=module
css/styles.css
js/config.js            # FIREBASE_CONFIG (null => local mode)  [already written]
js/economy.js           # PURE game rules. No DOM, no storage. Importable from Node.
js/templates.js         # PURE auto-generated market templates + daily generator. Importable from Node.
js/store/index.js       # picks backend: firebase if FIREBASE_CONFIG else local; exports `store`
js/store/local.js       # localStorage backend
js/store/firebase.js    # Firestore + Firebase Auth backend (loaded from gstatic CDN)
js/app.js (+ js/ui/*.js) # UI
tests/*.test.mjs        # `node --test` must pass (Node 20+, no deps)
firestore.rules, README.md, .github/workflows/pages.yml
```

## Game rules
- New account starts with **500** sonnetous. All amounts are **integers** (floor payouts).
- Min bet 1. You can't bet more than your balance.
- **Net worth** = balance + stakes of your open bets (bets with status `open`).
- **Broke** = balance < 1 AND no open bets. When a user is observed broke and `brokeSince` is null,
  set `brokeSince = dayKey(now)` (local calendar day `YYYY-MM-DD`).
- **Restart**: if broke and `brokeSince < dayKey(now)` (i.e. from the next calendar day), user may claim
  **100** sonnetous. Penalty: `bankruptcies += 1` (shown as 💀×N on leaderboard) and a **bankruptcy tax**:
  for 3 days (`penaltyUntil = now + 3*DAY_MS`) 25% of the *profit* of every winning bet is confiscated.
- Two market modes:
  - `fixed`: each option has fixed decimal `odds` (payout = floor(stake * odds), includes stake). Odds are
    locked onto the bet at placement.
  - `pool` (parimutuel): winners split the whole pool pro-rata: payout = floor(stake * totalPool / winningOptionTotal).
    If nobody bet on the winning option, the market is voided (everyone refunded).
- Two market kinds:
  - `timer` ("How long till X?"): options are time buckets measured from `openedAt`. Default buckets
    (lower = rarer = higher ROI):
    `d1` "Within 1 day" [0,1) odds 6 · `d4` "1–4 days" [1,4) odds 3 · `d8` "4–8 days" [4,8) odds 1.8 · `never` "8+ days" [8,∞) odds 1.3.
    Always `mode: 'fixed'`. Betting closes at `closesAt` (default openedAt + 12h).
    Resolution: someone reports "It happened!" with an `eventAt` timestamp -> winner is the bucket containing
    `(eventAt - openedAt)`. If nobody reports and `now >= openedAt + maxFiniteToDays*DAY_MS`, it auto-resolves to the
    open-ended bucket (any client may trigger this).
  - `choice`: arbitrary options (2–6). Auto (house) choice markets are `fixed` with template odds; user-created
    choice markets are `pool`.
- Who resolves: `auto` markets -> any logged-in user. `custom` markets -> only the creator (creator may also void).
- Auto markets: each calendar day (**UTC** date key so friends in different time zones get the same set),
  4 templates are picked deterministically (seeded PRNG on the date key) from `TEMPLATES`. Market id is
  `auto-${dateKey}-${templateId}` so creation is idempotent: first client to call `store.ensureMarkets` creates them,
  and `openedAt` = that client's `now`.

## Data shapes (plain JSON; timestamps are epoch **ms** numbers)
```js
User   = { uid, username, balance, createdAt, bankruptcies, brokeSince: 'YYYY-MM-DD'|null, penaltyUntil: ms|null,
           totalWagered, totalWon }
Option = { id, label, odds: number|null, fromDays?: number, toDays?: number|null }   // fromDays/toDays for timer only
Market = { id, type: 'auto'|'custom', templateId: string|null, kind: 'timer'|'choice', mode: 'fixed'|'pool',
           title, description, category, emoji,
           createdBy: uid|'house', createdByName,
           openedAt, closesAt,
           options: Option[], optionTotals: { [optionId]: number }, totalPool, betCount,
           status: 'open'|'resolved'|'void', resolvedOptionId: string|null, resolvedAt: ms|null,
           resolvedBy: string|null /* username or 'auto' */, eventAt: ms|null }
Bet    = { id, marketId, marketTitle, uid, username, optionId, optionLabel, amount, odds: number|null,
           placedAt, status: 'open'|'won'|'lost'|'void', payout: number /* 0 until settled; refund amount if void */,
           taxed: number /* sonnetous confiscated by bankruptcy tax, 0 default */ }
```
A market with `status==='open'` but `now >= closesAt` is "awaiting resolution" (no more bets).

## js/economy.js — exact exports
```js
export const CURRENCY = { name: 'sonnetous', symbol: '§' };
export const STARTING_BALANCE = 500, RESTART_BALANCE = 100, MIN_BET = 1;
export const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;
export const PENALTY_DAYS = 3, PENALTY_TAX = 0.25;
export const DEFAULT_TIMER_CLOSE_HOURS = 12;
export const DEFAULT_TIMER_BUCKETS; // array of Option as described above

export function dayKey(ms = Date.now()): string            // local-time YYYY-MM-DD
export function utcDayKey(ms = Date.now()): string         // UTC YYYY-MM-DD
export function formatSonnetous(n): string                 // '§1,234'
export function newUser(uid, username, now): User
export function isBettingOpen(market, now): boolean
export function marketPhase(market, now): 'open'|'awaiting'|'resolved'|'void'
export function validateBet(user, market, optionId, amount, now): string|null   // human-readable error or null
export function potentialPayout(market, optionId, amount): number               // fixed: floor(amount*odds); pool: floor(amount*(totalPool+amount)/(optionTotal+amount))
export function displayOdds(market, optionId): number|null                      // fixed: odds; pool: totalPool/optionTotal or null when optionTotal==0
export function buildBet({ id, market, user, optionId, amount, now }): Bet       // odds locked for fixed, null for pool
export function applyBetToMarket(market, optionId, amount): { optionTotals, totalPool, betCount }   // returns patch, does not mutate
export function timerBucketFor(market, eventAt): string                          // optionId
export function timerAutoResolution(market, now): string|null                    // optionId of open-ended bucket if expired, else null
export function settleMarket(market, bets, winningOptionId, usersById, now, resolvedBy, eventAt = null)
   // bets = all bets of that market (only status 'open' ones are touched).
   // returns { marketPatch, betPatches: { [betId]: {status, payout, taxed} }, userDeltas: { [uid]: { balance: +n, totalWon: +n } } }
   // pool mode with zero stake on winner => behaves like voidMarket (marketPatch.status 'void').
   // bankruptcy tax: if usersById[uid].penaltyUntil > now, taxed = floor((payout - amount) * PENALTY_TAX) when payout > amount; payout -= taxed.
export function voidMarket(market, bets, now, resolvedBy)   // same return shape, everyone refunded, status 'void'
export function netWorth(user, bets): number               // bets = any list; only this user's open bets count
export function isBroke(user, bets): boolean
export function canClaimRestart(user, bets, now): boolean
export function restartPatch(user, now): Partial<User>     // { balance: 100, bankruptcies: n+1, brokeSince: null, penaltyUntil: now+3d }
export function penaltyActive(user, now): boolean
export function buildCustomMarket({ id, user, now, title, description, kind, optionLabels, closesAt }): Market
   // kind 'choice' => pool mode, options from labels (ids 'o1','o2',...), odds null.
   // kind 'timer'  => fixed mode, DEFAULT_TIMER_BUCKETS, closesAt default openedAt+12h if not given.
   // Validates (throws Error with readable message): title 3–140 chars, 2–6 unique non-empty labels for choice, closesAt > now.
export function mulberry32(seed): () => number             // seeded PRNG
export function hashString(str): number                   // 32-bit hash for seeding
```

## js/templates.js — exact exports
```js
export const TEMPLATES = [ /* >= 30 templates */ {
  id: 'trump-constitution', kind: 'timer', category: 'Politics', emoji: '🏛️',
  title: 'How long till Trump violates the constitution again?',
  description: '...', buckets?: Option[] /* optional override of DEFAULT_TIMER_BUCKETS */, closeHours?: number
}, { id, kind: 'choice', category, emoji, title, description, options: [{id,label,odds}], closeHours } ];
export function pickDailyTemplates(dateKey, count = 4): Template[]   // deterministic, no duplicates
export function buildAutoMarket(template, dateKey, now): Market       // id `auto-${dateKey}-${template.id}`, type 'auto', createdBy 'house', createdByName 'The House'
export function dailyMarkets(dateKey, now, count = 4): Market[]
```
Template mix: mostly `timer` "How long till …?" markets (politics, tech/AI, celebrities, sports, crypto, the friend group
itself e.g. "How long till one of us goes bankrupt?") plus some `choice` ones with fixed odds. Funny, satirical, fine to
be spicy about public figures, nothing hateful. Choice odds should reflect likelihood (unlikely option = higher odds).

## js/store API — both backends export an object with exactly these async methods
```js
init(): Promise<{ mode: 'local'|'firebase' }>
onAuthChange(cb): () => void          // cb(User|null) — called immediately with current state, and on every change incl. profile updates
signUp(username, password): Promise<User>   // username 3–20 chars [a-zA-Z0-9_], case-insensitive unique; password >= 6
signIn(username, password): Promise<User>
signOut(): Promise<void>
subscribeUsers(cb): () => void        // cb(User[])
subscribeMarkets(cb): () => void      // cb(Market[]) sorted newest openedAt first
subscribeBets(cb): () => void         // cb(Bet[])  all bets, newest first
ensureMarkets(markets: Market[]): Promise<void>        // create only those whose id doesn't exist
createMarket(market: Market): Promise<string>          // market built by economy.buildCustomMarket
placeBet(marketId, optionId, amount): Promise<Bet>     // atomic: re-validate with economy.validateBet on fresh data, debit, update market totals, write bet, totalWagered += amount
resolveMarket(marketId, optionId, eventAt = null): Promise<void>  // atomic; permission per rules above; resolvedBy = current username or 'auto' when called via autoResolve
autoResolveExpired(): Promise<void>   // for every open timer market where timerAutoResolution != null, settle with resolvedBy 'auto'
voidMarket(marketId): Promise<void>   // creator only
markBrokeIfNeeded(): Promise<void>    // sets current user's brokeSince if isBroke and brokeSince null
claimRestart(): Promise<void>         // throws if !canClaimRestart
```
Errors are thrown as `Error` with user-facing messages. Settlement must be idempotent-safe (re-check `status==='open'` inside the transaction).
Local backend: single localStorage key `sonnetous:v1` (JSON {users, auth:{[usernameLower]:{uid,salt,hash}}, markets, bets}), session in
`sonnetous:session`; passwords SHA-256 (crypto.subtle) with salt; notify subscribers synchronously-after-write and on `storage` events (multi-tab).
Must work in Node tests given a `globalThis.localStorage` shim (guard `window` usage).
Firebase backend: modular SDK v10.12.2 from `https://www.gstatic.com/firebasejs/10.12.2/firebase-{app,auth,firestore}.js`.
Auth via email/password using synthetic email `${usernameLower}@users.sonnetous.app`; username uniqueness via `usernames/{lower}` doc
claimed in a transaction. Collections: `users`, `usernames`, `markets`, `bets`. Use onSnapshot for subscriptions and runTransaction for
money movement (read market + involved user docs + bet docs by ref inside the transaction; query bet ids beforehand).

## UI requirements
Dark, casino-y but clean, mobile-friendly (works at 375px). Screens:
- Auth: login/sign-up (username+password). Banner when in local mode: "Local mode — data lives in this browser only. Add a Firebase config to play with friends online." (Local mode still supports multiple accounts on one device.)
- Header: balance, net worth, 💀 bankruptcies, penalty badge with time left if active, username, logout.
- Tabs: **Markets** (filter Open / Awaiting result / Settled; daily house markets highlighted), **Create** (custom market form: title, description, kind choice/timer, option labels, close date-time), **My Bets**, **Leaderboard** (rank by net worth; show 💀×N), **Activity** (feed derived from bets & markets: who bet what, who won, resolutions).
- Market card: emoji, title, category, type badge (House/Custom by X), countdown to close, options with odds + live "bet X → win Y" calculator, amount input with quick chips (10, 50, 100, ½, All-in), place bet. Pool totals. Resolution controls: timer => "It happened!" + datetime input (default now); choice => pick winner; creator => Void. Show settled outcome.
- Broke state: full-width banner — if broke today: "You're broke. Come back tomorrow for a §100 bailout (penalty: 25% winnings tax for 3 days + 💀)"; if claimable: big "Claim §100 bailout" button.
- On load after login: `ensureMarkets(dailyMarkets(utcDayKey(now), now))`, `autoResolveExpired()`, and call `markBrokeIfNeeded()` whenever user/bets update. Re-render countdowns every second (cheaply).
- Toasts for errors/successes. Escape all user-provided text (XSS-safe; never innerHTML unescaped user input).

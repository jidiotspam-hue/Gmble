# Sonnetous v2 — rules-enforced economy, disputes, oracles, admin (supersedes conflicting parts of SPEC.md)

Constraint: static site on GitHub Pages + Firebase **Spark (free) plan** — no Cloud Functions, no server.
All protection must therefore be enforced by **firestore.rules** (which Firebase evaluates server-side).
Clients propose writes as **batched writes/transactions**; the rules accept a write only if the money math is exactly right.
Principle: **every player can only write their own player doc**. Nobody ever writes another player's balance.
Settlement is therefore **claim-based**: once a market is final, each player claims their own bets/bonds.

## Collections (fresh namespace — old v1 collections users/usernames/markets/bets are ignored)
| path | doc |
|---|---|
| `app/config` | `{ adminUid, maintenance: bool, claimCode, updatedAt }` |
| `bans/{uid}` | `{ uid, username, by, at, reason }` (delete = unban) |
| `handles/{usernameLower}` | `{ uid }` immutable |
| `players/{uid}` | Player |
| `markets2/{id}` | Market |
| `bets2/{betId}` | Bet |
| `stakes/{marketId}_{uid}` | `{ marketId, uid, amount }` running total staked by uid on market |
| `votes/{marketId}_{uid}` | `{ marketId, uid, uphold: bool, at }` |

All timestamps are **epoch-ms numbers**. Where rules must trust a client timestamp they require
`abs(ts - request.time.toMillis()) <= 300000` (5-min skew tolerance). Deadlines are always checked against `request.time`.

## Constants (js/economy.js)
STARTING_BALANCE 500 · RESTART_BALANCE 100 · PENALTY_DAYS 3 · PENALTY_TAX 0.25 · BOND 20 ·
CHALLENGE_WINDOW_MS 12h · VOTE_WINDOW_MS 24h · BET_COOLDOWN_MS 2000 · MAX_MARKETS_PER_DAY 5 ·
MAX_FIXED_ODDS 20 (min 1.01) · CLOCK_SKEW_MS 300000.

## Shapes
```
Player = { uid, username, balance, openStake, createdAt, bankruptcies, brokeSince: ms|null, penaltyUntil: ms|null,
           totalWagered, totalWon, lastBetAt: ms (0 initially), marketsDay: int (UTC day number), marketsCount: int,
           lastClaimId: string|null, lastBondMarketId: string|null }
Market = { id, type:'auto'|'custom', templateId|null, kind:'timer'|'choice', mode:'fixed'|'pool',
  title, description, category, emoji, createdBy: uid|'house', createdByName, openedAt, closesAt,
  options: [{id,label,odds|null,fromDays?,toDays?}],
  optionIds: [ids],                       // for rules membership checks
  oddsById: {id: odds} | null,            // fixed mode only
  bucketsById: {id: {fromMs, toMs|null}} | null,   // timer only, ms offsets from openedAt
  expiresAt: ms|null, expiryOptionId: string|null, // timer: openedAt + max finite toMs, open-ended bucket id
  reportableAt: ms,                       // earliest time a result may be reported (timer: openedAt; choice: closesAt or oracle.at)
  oracle: null | { type, params, source, label },  // data-checkable markets (see Oracles)
  optionTotals: {id: n}, totalPool, betCount, lastBetId: string|null,
  status: 'open'|'reported'|'challenged'|'resolved'|'void',
  reportedBy, reportedByName, reportedOptionId, reportedEventAt, reportedAt, evidence,   // null until reported
  challengedBy, challengedByName, challengedAt,                                          // null until challenged
  votesUphold: 0, votesOverturn: 0, lastVoteId: null,
  resolvedOptionId, resolvedAt, eventAt,
  reporterBondPaid: false, challengerBondPaid: false }
Bet = { id, marketId, marketTitle, uid, username, optionId, optionLabel, amount, odds|null, placedAt,
        status: 'open'|'won'|'lost'|'void', payout: 0, taxed: 0, claimedAt: null }
```

## Access gate (every read/write of game data)
`appOpen()` = `exists(app/config) && (config.maintenance == false || isAdmin())`; `notBanned()` = `!exists(bans/{auth.uid})`.
- If `app/config` does not exist the game is **closed (maintenance)** for everyone — only the admin claim works.
- `app/config` is readable by anyone (even signed out) so the client can show the maintenance screen.
- `bans/{uid}` readable by that uid and by admin; list readable by admin.
- players/handles/markets2/bets2/stakes/votes: read requires signedIn && appOpen && notBanned; all writes additionally require the same.
- **Nothing may be deleted** except `bans/{uid}` by admin.

## Admin
- **Claim**: create `app/config` only if it doesn't exist, with `adminUid == auth.uid`, `maintenance == true`; the code is written to a write-only `app/claim` doc in the same batch (never to
  the public config) and checked as `hashing.sha256(request.resource.data.claimCode).toHexString().lower() == '327ed216b034673656912e0eb7aa10b4b953933a1fd04ff136589337b9072bb1'`.
  (Verify `hashing.sha256` works in the emulator; the code itself is NEVER written to the repo — tests use a test-only hash
  by templating the rules file or a separate test rules file generated from the real one with the hash swapped.)
- **Update config**: admin only; may change `maintenance`, `updatedAt` only.
- **Ban/unban**: admin creates/deletes `bans/{uid}`; cannot ban adminUid.
- Admin bypasses maintenance but not the money rules.

## Operations — each is ONE atomic batch/transaction; rules cross-check docs with getAfter()
1. **signUp / repair**: create `handles/{lower}` {uid} + `players/{uid}` (balance 500, openStake 0, all counters 0/null, lastBetAt 0).
   Username rules: 3–20 chars `[A-Za-z0-9_]`. Existing Firebase Auth accounts without a player doc get one created on sign-in (repair path, username from auth displayName or synthetic email).
2. **placeBet(marketId, optionId, amount)**: create `bets2/{betId}` + update `players/{me}` (balance −amount, openStake +amount,
   totalWagered +amount, lastBetAt = now, rules: request.time ≥ old lastBetAt + 2s) + set `stakes/{m}_{me}` (amount += amount)
   + update `markets2/{m}` (optionTotals[opt] += amount, totalPool += amount, betCount += 1, lastBetId = betId).
   Market must be status open, request.time < closesAt, opt ∈ optionIds, amount int 1..balance, bet.odds == oddsById[opt] (fixed) or null (pool).
3. **createMarket** (custom): create `markets2/{id}` with createdBy == me, status open, zero totals; player marketsDay/marketsCount
   updated (≤ 5 per UTC day). Choice ⇒ pool mode; timer ⇒ fixed default buckets. Odds within [1.01, 20].
   **Auto (house) markets**: only the ADMIN may create id `auto-{utcDateKey}-{templateId}` with createdBy 'house', odds within bounds
   (non-admin `ensureHouseMarkets` is a no-op, so the day's house markets appear once the admin opens the app). (Clients compare house markets to the deterministic template and show a ⚠ badge if they don't match.)
4. **reportResult(marketId, optionId, eventAt, evidence)**: market open → reported. Custom markets: only creator may report.
   House markets: anyone. Requires request.time ≥ reportableAt. Timer: eventAt ∈ [openedAt, request.time] and
   `bucketsById[optionId]` contains `eventAt − openedAt`. Reporter pays BOND (player balance −20, lastBondMarketId = m) in same batch.
   evidence: optional URL string ≤ 300 chars (required in UI for non-oracle house markets).
5. **challenge(marketId)**: reported → challenged, request.time < reportedAt + 12h, challenger ≠ reporter, pays BOND.
6. **vote(marketId, uphold)**: create `votes/{m}_{me}` + market votesUphold/votesOverturn += 1, lastVoteId. Only while challenged and
   request.time < challengedAt + 24h; voter must have **no stake doc** on that market and not be reporter/challenger.
7. **finalize(marketId)** (anyone, idempotent):
   - open timer with request.time ≥ expiresAt → resolved, resolvedOptionId = expiryOptionId.
   - reported and request.time ≥ reportedAt + 12h → resolved with reportedOptionId (pool mode with optionTotals[reported] == 0 ⇒ void).
   - challenged and request.time ≥ challengedAt + 24h → votesUphold > votesOverturn ⇒ resolved with reportedOptionId (same pool rule); else ⇒ void.
   - custom creator may **void** an open market only while betCount == 0.
8. **claimBet(betId)** (owner only): bet open → won/lost/void on a resolved/void market; payout per economy.betClaim; player balance += payout,
   openStake −= amount, totalWon += (won ? payout : 0), lastClaimId = betId. Losing bets are claimed too (payout 0) so openStake returns to 0.
9. **claimBond(marketId)** (reporter or challenger): once market is resolved/void; sets reporterBondPaid/challengerBondPaid = true and pays:
   unchallenged+resolved → reporter 20 · challenged & uphold>overturn → reporter 40, challenger 0 ·
   challenged & overturn>uphold → challenger 40, reporter 0 · challenged & tie/no votes → both 20 back.
   (A market voided by pool-zero after an unchallenged report still returns the reporter's 20.)
10. **markBroke**: set brokeSince = now when balance < 1 && openStake == 0 && brokeSince == null.
11. **claimRestart**: balance < 1, openStake == 0, brokeSince != null, request.time ≥ (floor(brokeSince/DAY)+1)*DAY (next UTC midnight) →
    balance 100, bankruptcies +1, brokeSince null, penaltyUntil = now + 3d (±skew).

**Payout** (economy.betClaim and rules must agree exactly): fixed gross = floor(amount*odds + 1e-9); pool gross = floor(amount*totalPool/optionTotals[winner]);
if player.penaltyUntil > now and gross > amount: taxed = floor((gross−amount)*0.25). payout = gross − taxed. Void ⇒ payout = amount, taxed 0.

Clients **auto-run** (throttled, errors swallowed): finalize on finalizable markets they see, claimBet on own open bets of final markets,
claimBond, markBroke, and ensure today's house markets exist.

## Oracles (js/oracles.js) — data-checkable markets
`market.oracle = { type, params, source, label }`. Pure evaluator + browser fetchers of CORS-friendly, keyless, *historical* APIs so any client
can verify later with the same answer:
- `price_above` (choice yes/no): Coinbase Exchange candles `api.exchange.coinbase.com/products/{symbol}/candles` close at params.at.
- `price_move` (timer): first hourly candle since openedAt whose high/low crosses base×(1±pct) → eventAt.
- `quake` (timer): USGS FDSN `earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=..&starttime=..&orderby=time-asc` → first event time.
- `weather` (choice): Open-Meteo archive/forecast daily precipitation_sum or temperature_2m_max for a city/date.
- `wiki_battle` (choice): Wikimedia REST per-article daily pageviews, A vs B on a date.
`evaluate(oracle, data, market) → { status:'pending' } | { status:'final', optionId, eventAt|null }`.
Client behaviour: when an oracle market is reportable and the data is final → auto-**report** (if balance ≥ BOND).
When an oracle market is **reported** with a result that disagrees with the client's own evaluation → show a red
"Report doesn't match {source} data" banner and a one-click **Challenge** (auto-challenge if balance ≥ BOND).

## House market quality (js/templates.js)
Specific, checkable, current (it's autumn 2026), funny. Every non-oracle template has explicit resolution criteria in the description
("Counts if: …"). Daily set = featured 'trump-constitution' (reworded with crisp criteria: a federal court rules a Trump administration
action unconstitutional / blocks it on constitutional grounds; evidence link required) + 2 oracle markets + 2 other templates.
Oracle templates compute baselines at creation (e.g., BTC threshold = current price rounded to a sensible step) via an async
`buildDailyMarkets(dateKey, now, fetchers)` that skips an oracle template if its fetch fails.

## js/economy.js v2 — exports (owner: economy agent; everyone else codes against this)
Keep: CURRENCY, STARTING_BALANCE, RESTART_BALANCE, MIN_BET, DAY_MS, HOUR_MS, PENALTY_DAYS, PENALTY_TAX, DEFAULT_TIMER_CLOSE_HOURS,
DEFAULT_TIMER_BUCKETS, dayKey, utcDayKey, formatSonnetous, isBettingOpen, potentialPayout, displayOdds, timerBucketFor, penaltyActive,
mulberry32, hashString. Add/replace:
```js
export const BOND = 20, CHALLENGE_WINDOW_MS = 12*HOUR_MS, VOTE_WINDOW_MS = 24*HOUR_MS, BET_COOLDOWN_MS = 2000,
  MAX_MARKETS_PER_DAY = 5, MIN_FIXED_ODDS = 1.01, MAX_FIXED_ODDS = 20, CLOCK_SKEW_MS = 300000;
export function utcDayNumber(ms): number                          // Math.floor(ms / DAY_MS)
export function newPlayer(uid, username, now): Player
export function normalizeMarket(m): Market   // fills optionIds, oddsById, bucketsById, expiresAt, expiryOptionId, reportableAt (if absent),
                                             // optionTotals zeros, totalPool 0, betCount 0, lastBetId null, all report/challenge/vote/result
                                             // fields null/0/false, status 'open'. Used by buildCustomMarket and templates.buildAutoMarket.
export function marketPhase(market, now): 'open'|'closed'|'reported'|'challenged'|'resolved'|'void'   // 'closed' = open but now>=closesAt
export function validateBet(player, market, optionId, amount, now): string|null   // + cooldown via player.lastBetAt
export function buildBet({ id, market, player, optionId, amount, now }): Bet
export function validateCreateMarket(player, market, now): string|null           // daily cap, odds bounds
export function validateReport(player, market, optionId, eventAt, now): string|null
export function validateChallenge(player, market, now): string|null
export function validateVote(player, market, { hasStake, hasVoted }, now): string|null
export function finalizeOutcome(market, now): null | { status: 'resolved'|'void', resolvedOptionId: string|null, eventAt: number|null }
export function betClaim(bet, market, player, now): { status: 'won'|'lost'|'void', payout, taxed }
export function bondClaims(market): { reporter: number, challenger: number }
export function isBroke(player): boolean                  // balance < 1 && openStake === 0
export function canClaimRestart(player, now): boolean
export function restartPatch(player, now): Partial<Player>
export function netWorth(player): number                 // balance + openStake
export function buildCustomMarket({ id, player, now, title, description, kind, optionLabels, closesAt }): Market
export function houseMarketMismatch(market, expected): string|null   // compares options/odds/buckets/title vs template-built market
```

## Store API v2 — both js/store/local.js and js/store/firebase.js (async unless noted; throw Error with friendly message)
```js
init(): Promise<{ mode }>
onAuthChange(cb): unsub                 // cb(Player|null); fires on profile changes
signUp(username, password), signIn(username, password), signOut()
subscribeConfig(cb): unsub              // cb({ exists: bool, maintenance: bool, adminUid: string|null }) — works signed out
subscribeMyBan(cb): unsub               // cb(Ban|null)
subscribePlayers(cb), subscribeMarkets(cb) /* newest openedAt first */, subscribeBets(cb) /* newest first */
subscribeMyVotes(cb): unsub             // cb(string[] marketIds I voted on)
subscribeBans(cb): unsub                // admin only; cb(Ban[])
ensureHouseMarkets(markets: Market[])   // create missing ids only
createMarket(market), placeBet(marketId, optionId, amount) -> Bet
reportResult(marketId, optionId, eventAt|null, evidence|null), challengeReport(marketId), voteOnDispute(marketId, uphold: bool)
finalizeMarket(marketId), voidMarket(marketId)
claimBet(betId), claimBond(marketId), markBrokeIfNeeded(), claimRestart()
runHousekeeping(): Promise<{ finalized, claimed, bonds }>   // finalize finalizable visible markets, claim my final bets + bonds, markBroke; never throws
claimAdmin(code), setMaintenance(on: bool), banPlayer(uid, reason), unbanPlayer(uid)
```
Local store: same semantics enforced in JS (it's the dev/test backend); admin code hash for local mode = sha256 of the code, same constant
exported from js/admin-hash.js (`export const ADMIN_CODE_SHA256 = '<hash>'`), so the real code works in both modes.

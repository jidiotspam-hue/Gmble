# 🎰 Sonnetous

**Bet on anything. Lose everything. Try again tomorrow.**

A tiny betting app for you and your friends, hosted free on GitHub Pages. The currency is
**sonnetous** (`§`). No real money, just bragging rights.

## Rules
- New accounts start with **§500**. Bets are whole sonnetous; one bet every 2 seconds max.
- **House markets**: a fresh set every UTC day (created when the admin opens the app). "How long till a court says a
  Trump action is unconstitutional?" runs every day, plus data-settled markets (crypto prices, earthquakes, weather,
  Wikipedia battles, sports) and a couple of news/friend-group ones with explicit "Counts if" criteria.
- **Custom markets**: up to 5 per day. Choice markets are pool bets (winners split the pot); timer markets use the
  standard buckets (within 1 day ×6 · 1–4 days ×3 · 4–8 days ×1.8 · 8+ days ×1.3).
- **Timer bets start their clock when you bet.** If the thing already happened before your bet, you're refunded.
- **Results are reported, not trusted**: reporting costs a §20 bond. Anyone can challenge within 12h (also §20); then
  players who didn't bet on that market vote for 24h. Losers of a dispute forfeit their bond to the winner; no votes
  or a tie voids the market (everyone refunded). Data-settled markets are auto-reported by the app, and every
  player's app re-checks the data and auto-challenges a wrong report.
- **Going broke**: at §0 with no open bets you can claim a **§100 bailout from the next UTC day**. Penalty: a 💀 on the
  leaderboard forever and a **25% tax on winnings' profit for 3 days**.
- **Admin**: one account claims admin with a secret code (only its hash is in the repo). The admin panel can turn
  **maintenance** on (blocks everyone but the admin) and **ban/unban** players. All of this, and every balance change,
  is enforced by `firestore.rules` on Firebase's servers — players can only ever write their own account, and every
  payout must match a real bet, bond or bailout.

## Play online with friends (5-minute Firebase setup)
Out of the box the app runs in **local mode**: everything is stored in your browser, so friends can only share
one device. To play from different devices you need a free Firebase project:

1. Go to <https://console.firebase.google.com> → **Add project** (Analytics not needed).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**
   (You sign up with a username. The app creates a fake email for it behind the scenes.)
3. **Build → Firestore Database → Create database** (production mode, any region).
   Open the **Rules** tab, paste the contents of [`firestore.rules`](firestore.rules), and **Publish**.
4. **Project settings (⚙️) → Your apps → Web (`</>`)** → register an app → copy the `firebaseConfig` object.
5. Paste it into [`js/config.js`](js/config.js) as `FIREBASE_CONFIG` and push to `main`.
6. **Authentication → Settings → Authorized domains** → add `<your-username>.github.io`.

The Firebase web config is not a secret. It's meant to be public. Access is controlled by the rules and auth.
The rules assume **everyone who signs up is a trusted friend**: settlement runs in the browser, so a
determined player could edit balances from the dev console. Don't use it with strangers.

## Deploy to GitHub Pages
1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/pages.yml` runs the tests, then deploys.
3. The app will be at `https://<your-username>.github.io/<repo>/`.

## Develop
No build step and no dependencies.
```sh
python3 -m http.server 8000   # then open http://localhost:8000
node --test                   # run the unit tests (Node 20+)
node tests/e2e/smoke.mjs      # browser smoke test (needs the server above on :8123 and the `playwright` npm package; BASE_URL/SHOTS_DIR optional)
```
- `js/economy.js`: all game rules (pure functions)
- `js/templates.js`: the auto-generated house markets. Add your own templates here!
- `js/store/`: local (localStorage) and Firebase backends with the same API
- `js/app.js`, `js/ui/`: the UI
- `SPEC.md`: the design spec

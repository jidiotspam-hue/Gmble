# 🎰 Sonnetous

**Bet on anything. Lose everything. Try again tomorrow.**

A tiny betting app for you and your friends, hosted free on GitHub Pages. The currency is
**sonnetous** (`§`). No real money, just bragging rights.

## Rules
- New accounts start with **§500**.
- Bet on **house markets** (4 new ones auto-generated every day, e.g. *"How long till Trump violates the
  constitution again?"*) or **create your own** market about anything.
- **Timer markets** ("How long till…?") have time buckets. The sooner the bucket, the higher the payout:
  | Bucket | Pays |
  |---|---|
  | Within 1 day | ×6 |
  | 1–4 days | ×3 |
  | 4–8 days | ×1.8 |
  | 8+ days | ×1.3 |

  Anyone can hit **"It happened!"** with the time it happened, and the matching bucket wins. If nobody reports it
  within 8 days, "8+ days" wins automatically.
- **Choice markets** you create are **pool bets**: the winners split the whole pot in proportion to their stake.
  The creator resolves (or voids and refunds) their own market.
- **Going broke**: if you hit §0 with no open bets, you can claim a **§100 bailout the next day**. The penalty is a
  💀 on the leaderboard forever and a **25% tax on your winnings' profit for 3 days**.

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
node --test tests/            # run the unit tests (Node 20+)
```
- `js/economy.js`: all game rules (pure functions)
- `js/templates.js`: the auto-generated house markets. Add your own templates here!
- `js/store/`: local (localStorage) and Firebase backends with the same API
- `js/app.js`, `js/ui/`: the UI
- `SPEC.md`: the design spec

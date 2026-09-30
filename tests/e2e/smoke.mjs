// End-to-end smoke test for Sonnetous (local mode). Drives the real app in headless Chromium.
//
//   python3 -m http.server 8123 &          # serve the repo root
//   node tests/e2e/smoke.mjs               # BASE_URL=http://localhost:8123 by default
//
// Needs the `playwright` npm package (resolved normally, else from PLAYWRIGHT_MODULE or the
// shared scratch install). Not picked up by `node --test` (file is not named *.test.mjs).
// Time travel: a page init script wraps Date so that "now" = real now + localStorage['qa:offset'].
// Exits 1 on the first failure (screenshot of the failing page is saved in SHOTS_DIR).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.BASE_URL || 'http://localhost:8123';
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'sonnetous-e2e');
fs.mkdirSync(SHOTS, { recursive: true });

// Always run in local mode, even when js/config.js has a real Firebase config,
// so the smoke test never writes to the live database.
async function forceLocalMode(context) {
  await context.route('**/js/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const FIREBASE_CONFIG = null;\n' }));
}

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/tmp/claude-0/ui-scratch/node_modules/playwright/index.mjs',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return await import(c.startsWith('/') ? pathToFileURL(c).href : c);
    } catch { /* try next */ }
  }
  throw new Error('Cannot find the playwright package. Set PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs');
}
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default.chromium;

// ------------------------------------------------------------------ tiny harness
const problems = [];      // console errors / page errors / alerts
const DAY = 86_400_000;
let offset = 0;           // simulated time offset (ms) shared by every page in the context
let step = 0;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}
function log(msg) { console.log(`[${String(++step).padStart(2, '0')}] ${msg}`); }
const fmtN = (n) => `${n < 0 ? '-' : ''}§${Math.abs(n).toLocaleString('en-US')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INIT = () => {
  const RealDate = Date;
  const off = () => { try { return Number(localStorage.getItem('qa:offset')) || 0; } catch { return 0; } };
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + off()); else super(...a); }
    static now() { return RealDate.now() + off(); }
  }
  globalThis.Date = FakeDate;
};

async function newPage(ctx, name = 'page') {
  const page = await ctx.newPage();
  page.qaName = name;
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error [${name}]: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror [${name}]: ${e.message}`));
  page.on('dialog', async (d) => {
    if (d.type() === 'confirm') await d.accept();
    else { problems.push(`unexpected ${d.type()} dialog [${name}]: ${d.message()}`); await d.dismiss(); }
  });
  return page;
}

async function goto(page) {
  await page.goto(BASE + '/index.html');
  await page.waitForFunction(() => document.getElementById('boot').hidden);
  assert(await page.locator('#fatal').isHidden(), 'fatal error screen shown');
}

async function setOffset(page, ms) {
  offset = ms;
  await page.evaluate((v) => localStorage.setItem('qa:offset', String(v)), ms);
}

async function shot(page, name, fullPage = false) {
  await page.screenshot({ path: path.join(SHOTS, name), fullPage });
}

// ------------------------------------------------------------------ app helpers
async function authAs(page, mode, user, pass) {
  await page.locator('#auth').waitFor({ state: 'visible' });
  await page.click(`[data-auth-mode=${mode}]`);
  await page.fill('#auth-form [name=username]', user);
  await page.fill('#auth-form [name=password]', pass);
  await page.click('#auth-submit');
}
async function signUp(page, user, pass = 'secret123') {
  await authAs(page, 'signup', user, pass);
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction((u) => document.getElementById('h-user').textContent === u, user);
}
async function login(page, user, pass = 'secret123') {
  await authAs(page, 'signin', user, pass);
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction((u) => document.getElementById('h-user').textContent === u, user);
}
async function logout(page) {
  await page.click('#btn-logout');
  await page.locator('#auth').waitFor({ state: 'visible' });
}
const balance = async (page) =>
  parseInt((await page.textContent('#h-balance')).replace(/[^\d-]/g, ''), 10);
async function waitBalance(page, n) {
  await page.waitForFunction((t) => document.getElementById('h-balance').textContent === t, fmtN(n), { timeout: 5000 })
    .catch(async () => { throw new Error(`ASSERT: balance expected ${fmtN(n)}, got ${await page.textContent('#h-balance')}`); });
}
async function tab(page, id) {
  await page.click(`[data-tab=${id}]`);
  await page.locator(`#panel-${id}`).waitFor({ state: 'visible' });
  await sleep(120); // views render on a 0ms timeout after the tab switch
}
async function filter(page, id) {
  await tab(page, 'markets');
  await page.click(`[data-filter=${id}]`);
  await page.waitForFunction((f) => document.querySelector(`[data-filter=${f}]`).classList.contains('active'), id);
}
const card = (page, title) => page.locator('#panel-markets article.market').filter({ has: page.locator(`h3:text-is(${JSON.stringify(title)})`) });
const TRUMP = 'How long till Trump violates the constitution again?';

async function bet(page, c, optionLabel, amount) {
  await c.locator('.opt', { hasText: optionLabel }).first().click();
  await c.locator('[data-role=amount]').fill(String(amount));
  const btn = c.locator('[data-action=bet]');
  await btn.waitFor();
  await page.waitForFunction((el) => !el.disabled, await btn.elementHandle());
  await btn.click();
  await page.locator('.toast-success', { hasText: 'Bet placed' }).last().waitFor();
}

async function createChoice(page, title, labels, description = '') {
  await tab(page, 'create');
  await page.fill('#panel-create [name=title]', title);
  if (description) await page.fill('#panel-create [name=description]', description);
  await page.check('#panel-create [name=kind][value=choice]');
  while ((await page.locator('#panel-create [data-role=label]').count()) < labels.length) {
    await page.click('[data-role=add-option]');
  }
  const inputs = page.locator('#panel-create [data-role=label]');
  for (let i = 0; i < labels.length; i++) await inputs.nth(i).fill(labels[i]);
  await page.click('#panel-create [type=submit]');
  await page.locator('.toast-success', { hasText: 'Market created' }).last().waitFor();
  await page.locator('#panel-markets').waitFor({ state: 'visible' });
}

async function noHScroll(page, label) {
  for (const t of ['markets', 'create', 'mybets', 'leaderboard', 'activity']) {
    await tab(page, t);
    const over = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    assert(over <= 0, `horizontal scroll (${over}px) on ${t} tab [${label}]`);
    // content must also stay inside its own card (clipped overflow does not show up in scrollWidth)
    const spill = await page.evaluate((id) => {
      const out = [];
      for (const card of document.querySelectorAll(`#panel-${id} .panel-card`)) {
        const r = card.getBoundingClientRect();
        for (const el of card.querySelectorAll('table, td, th, li, .badge')) {
          const b = el.getBoundingClientRect();
          if (b.width && b.right > r.right + 1) out.push(el.tagName + ':' + el.textContent.trim().slice(0, 20));
        }
      }
      return out;
    }, t);
    assert(spill.length === 0, `content spills out of its card on ${t} tab [${label}]: ${spill.slice(0, 3).join(' | ')}`);
  }
  await tab(page, 'markets');
}

function noProblems(where) {
  assert(problems.length === 0, `errors before/at ${where}:\n  ` + problems.join('\n  '));
}

// ------------------------------------------------------------------ run
const browser = await chromium.launch();
let current = null;
try {
  // ============================================================ mobile run
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: false });
  await forceLocalMode(ctx);
  await ctx.addInitScript(INIT);
  const page = await newPage(ctx, 'main');
  current = page;
  await goto(page);
  await page.locator('#auth').waitFor({ state: 'visible' });
  assert((await page.textContent('#auth-local')).includes('Local mode'), 'local-mode banner missing');

  // ---- 1. accounts
  log('sign up alice / duplicate / wrong password / bob');
  await signUp(page, 'alice');
  assert((await balance(page)) === 500, 'alice starts with 500');
  await logout(page);
  await authAs(page, 'signup', 'ALICE', 'secret123');
  await page.locator('#auth-error').waitFor({ state: 'visible' });
  assert((await page.textContent('#auth-error')).includes('already taken'), 'duplicate username (case-insens.) should be rejected');
  await authAs(page, 'signup', '<img src=x onerror=alert(1)>', 'secret123');
  assert(await page.locator('#auth-error').isVisible(), 'XSS-looking username should be rejected');
  await authAs(page, 'signin', 'alice', 'wrongpass');
  await page.waitForFunction(() => /Invalid username or password/.test(document.getElementById('auth-error').textContent));
  assert(await page.locator('#app').isHidden(), 'wrong password must not log in');
  await authAs(page, 'signup', 'bob', 'secret123');
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('h-user').textContent === 'bob');
  await logout(page);
  await login(page, 'alice');

  // ---- 2. house markets
  log('daily house markets incl. Trump');
  await filter(page, 'open');
  await card(page, TRUMP).waitFor();
  const houseCount = await page.locator('#panel-markets article.market.today').count();
  assert(houseCount === 5, `expected 5 house markets for today (1 featured + 4), got ${houseCount}`);
  await shot(page, 'markets-375.png');

  // ---- 3. custom pool market
  log('custom choice market: bets, permissions, payout');
  await createChoice(page, 'Who wins the chess game?', ['Alice', 'Bob'], 'Best of one.');
  const chess = card(page, 'Who wins the chess game?');
  await chess.waitFor();
  assert(await chess.locator('.resolve').count() === 1, 'creator sees resolve controls');
  await bet(page, chess, 'Alice', 100);
  await waitBalance(page, 400);
  await logout(page);
  await login(page, 'bob');
  await filter(page, 'open');
  const bchess = card(page, 'Who wins the chess game?');
  await bchess.waitFor();
  assert(await bchess.locator('.resolve').count() === 0, 'bob must NOT see resolve controls on alice\'s market');
  assert(await bchess.locator('[data-action=void]').count() === 0, 'bob must NOT see void');
  assert(await card(page, TRUMP).locator('.resolve').count() === 1, 'anyone can resolve house markets');
  await bet(page, bchess, 'Bob', 300);
  await waitBalance(page, 200);
  await logout(page);
  await login(page, 'alice');
  await filter(page, 'open');
  const achess = card(page, 'Who wins the chess game?');
  await achess.locator('select[data-role=winner]').selectOption({ label: 'Alice' });
  await achess.locator('[data-action=resolve-choice]').click();
  await page.locator('.toast-success', { hasText: 'Market settled' }).last().waitFor();
  await waitBalance(page, 800); // 400 + floor(100 * 400 / 100)
  await filter(page, 'settled');
  const settled = card(page, 'Who wins the chess game?');
  await settled.waitFor();
  assert((await settled.textContent()).includes('+§300'), 'settled card shows alice net +§300');
  await shot(page, 'settled-375.png');
  await tab(page, 'leaderboard');
  const lb = await page.textContent('#panel-leaderboard');
  assert(lb.includes('§800') && lb.includes('§200'), 'leaderboard shows 800 / 200');
  const names = await page.locator('#panel-leaderboard tbody tr .name').allTextContents();
  assert(names[0].startsWith('alice'), 'alice ranks first');

  // ---- 4. void & refund
  log('void & refund');
  await createChoice(page, 'Will it rain on Friday?', ['Yes', 'No']);
  await bet(page, card(page, 'Will it rain on Friday?'), 'Yes', 150);
  await waitBalance(page, 650);
  await logout(page);
  await login(page, 'bob');
  await filter(page, 'open');
  await bet(page, card(page, 'Will it rain on Friday?'), 'No', 50);
  await waitBalance(page, 150);
  await logout(page);
  await login(page, 'alice');
  await filter(page, 'open');
  await card(page, 'Will it rain on Friday?').locator('[data-action=void]').click();
  await page.locator('.toast-success', { hasText: 'voided' }).last().waitFor();
  await waitBalance(page, 800);
  await tab(page, 'mybets');
  assert((await page.textContent('#panel-mybets')).includes('refunded'), 'my bets shows refunded');
  await logout(page);
  await login(page, 'bob');
  await waitBalance(page, 200);
  await logout(page);
  await login(page, 'alice');

  // ---- 8. XSS (before it grows more history)
  log('XSS: title / option / description rendered as text');
  const XSS = '<img src=x onerror=alert(1)>';
  await createChoice(page, XSS, [XSS, '<b>bold</b>'], `desc ${XSS}`);
  const xc = card(page, XSS);
  await xc.waitFor();
  assert((await xc.locator('.opt').first().textContent()).includes(XSS), 'option label shown as literal text');
  assert(await page.locator('#panel-markets img[src=x]').count() === 0, 'no injected <img>');
  assert(await page.locator('#panel-markets b', { hasText: 'bold' }).count() === 0, 'no injected <b>');
  await bet(page, xc, XSS, 5);
  for (const t of ['mybets', 'activity', 'leaderboard']) {
    await tab(page, t);
    assert(await page.locator('img[src=x]').count() === 0, `no injected <img> on ${t}`);
  }
  assert((await page.textContent('#panel-activity')).includes(XSS), 'activity shows literal XSS text');
  await sleep(300);
  await waitBalance(page, 795);
  await xc.waitFor().catch(() => {});
  await filter(page, 'open');
  await card(page, XSS).locator('[data-action=void]').click();
  await page.locator('.toast-success', { hasText: 'voided' }).last().waitFor();
  await waitBalance(page, 800);
  noProblems('step 8');

  log('long unbroken strings do not cause horizontal scroll');
  const LONG = 'W'.repeat(140);
  const LOPT = 'M'.repeat(60);
  await createChoice(page, LONG, [LOPT, LOPT.slice(1) + 'X'], 'D'.repeat(300));
  await bet(page, card(page, LONG), LOPT, 5);
  await noHScroll(page, 'long strings 375');
  await filter(page, 'open');
  await card(page, LONG).locator('[data-action=void]').click();
  await page.locator('.toast-success', { hasText: 'voided' }).last().waitFor();
  await waitBalance(page, 800);

  // ---- 9. multi-tab: typing is not wiped by another tab's bet
  log('second tab places a bet while first tab is typing');
  await createChoice(page, 'Typing test market', ['One', 'Two']);
  await createChoice(page, 'Other market', ['Left', 'Right']);
  await filter(page, 'open');
  const page2 = await newPage(ctx, 'tab2');
  await goto(page2);
  await page2.locator('#app').waitFor({ state: 'visible' });
  await filter(page2, 'open');
  const tc = card(page, 'Typing test market');
  await tc.locator('.opt', { hasText: 'One' }).click();
  const inp = tc.locator('[data-role=amount]');
  await inp.click();
  await inp.pressSequentially('1');
  await bet(page2, card(page2, 'Other market'), 'Left', 25); // page2 storage write -> page1 storage event
  await waitBalance(page, 775);
  await sleep(500);
  await inp.pressSequentially('2');
  assert((await inp.inputValue()) === '12', `typed amount was wiped, got "${await inp.inputValue()}"`);
  assert(await inp.evaluate((el) => el === document.activeElement), 'amount input lost focus');
  await page.click('#app .brand'); // blur -> catch-up render must keep the draft
  await sleep(500);
  assert((await card(page, 'Typing test market').locator('[data-role=amount]').inputValue()) === '12', 'draft lost after blur re-render');
  // negative / fractional / over-balance amounts are rejected in the UI
  const tin = card(page, 'Typing test market').locator('[data-role=amount]');
  for (const bad of ['-5', '1.5', '999999', '0']) {
    await tin.fill(bad);
    assert(await card(page, 'Typing test market').locator('[data-action=bet]').isDisabled(), `place bet must be disabled for "${bad}"`);
  }
  await page2.close();
  // void the helper markets so the balance is back to 800
  await filter(page, 'open');
  for (const t of ['Typing test market', 'Other market']) {
    await card(page, t).locator('[data-action=void]').click();
    await page.locator('.toast-success', { hasText: 'voided' }).last().waitFor();
  }
  await waitBalance(page, 800);
  noProblems('step 9');

  // ---- 5. timer market
  log('timer market: bet, then "It happened!" two days later');
  await filter(page, 'open');
  await bet(page, card(page, TRUMP), 'Within 1 day', 50);
  await waitBalance(page, 750);
  await logout(page);
  await login(page, 'bob');
  await filter(page, 'open');
  await bet(page, card(page, TRUMP), '1–4 days', 100);
  await waitBalance(page, 100);
  await logout(page);
  await login(page, 'alice');
  await setOffset(page, 2 * DAY);
  await goto(page);
  await filter(page, 'awaiting');
  const tr = card(page, TRUMP);
  await tr.waitFor();
  assert((await tr.textContent()).includes('Awaiting result'), 'Trump day-0 market awaits result');
  await tr.locator('[data-action=resolve-timer]').click();
  await page.locator('.toast-success', { hasText: 'Market settled' }).last().waitFor();
  await waitBalance(page, 750); // alice lost her 50 on "Within 1 day"
  await filter(page, 'settled');
  const trs = card(page, TRUMP).first();
  assert((await trs.textContent()).includes('1–4 days'), 'winning bucket is 1–4 days');
  await logout(page);
  await login(page, 'bob');
  await waitBalance(page, 400); // 100 + floor(100 * 3)
  await logout(page);

  // ---- 6. bankruptcy
  log('bankruptcy: all-in loss, broke banner, next day bailout, penalty tax');
  await signUp(page, 'dave');
  await filter(page, 'open');
  const x = card(page, TRUMP);
  await x.waitFor();
  await bet(page, x, '8+ days', 500);
  await waitBalance(page, 0);
  await card(page, TRUMP).locator('[data-action=resolve-timer]').click();
  await page.locator('.toast-success', { hasText: 'Market settled' }).last().waitFor();
  await page.locator('#banner .banner-broke').waitFor();
  const bannerTxt = await page.textContent('#banner');
  assert(/Come back tomorrow/.test(bannerTxt), 'broke banner says come back tomorrow');
  assert(await page.locator('[data-action=claim]').count() === 0, 'no claim button on the day you went broke');
  await shot(page, 'broke-375.png');
  await setOffset(page, 3 * DAY);
  await goto(page);
  await page.locator('[data-action=claim]').waitFor();
  assert(/Claim §100 bailout/.test(await page.textContent('[data-action=claim]')), 'claim button label');
  await shot(page, 'bailout-375.png');
  await page.click('[data-action=claim]');
  await waitBalance(page, 100);
  assert((await page.textContent('#h-skulls')) === '💀×1', 'header shows 💀×1');
  await page.waitForFunction(() => !document.getElementById('h-penalty').hidden);
  const pen = await page.textContent('#h-penalty');
  assert(/left/.test(pen) && /(2d 2\dh|3d 0h)/.test(pen), `penalty badge with time left, got "${pen}"`);
  assert(await page.locator('#banner .banner-broke').count() === 0, 'broke banner gone after claim');
  await tab(page, 'leaderboard');
  const daveRow = page.locator('#panel-leaderboard tbody tr', { hasText: 'dave' });
  assert((await daveRow.textContent()).includes('💀×1'), 'leaderboard shows 💀×1 for dave');
  await shot(page, 'leaderboard-375.png');
  await noHScroll(page, 'dave with skull + tax badge 375');
  await filter(page, 'open');
  const y = card(page, TRUMP);
  await bet(page, y, 'Within 1 day', 100);
  await waitBalance(page, 0);
  await card(page, TRUMP).locator('[data-action=resolve-timer]').click();
  await page.locator('.toast-success', { hasText: 'Market settled' }).last().waitFor();
  await waitBalance(page, 475); // profit 500 - 25% tax (125) + stake 100
  await tab(page, 'mybets');
  const mb = await page.textContent('#panel-mybets');
  assert(/tax\s*[−-]§125/.test(mb), 'My Bets shows the §125 tax');
  assert(/Bankruptcy tax paid so far: §125/.test(mb), 'My Bets tax total');
  await shot(page, 'mybets-tax-375.png');
  await logout(page);
  await login(page, 'alice');

  // ---- 7. auto-resolve
  log('auto-resolve to the open-ended bucket after 8 days');
  await tab(page, 'create');
  await page.fill('#panel-create [name=title]', 'How long till Bob pays me back?');
  await page.check('#panel-create [name=kind][value=timer]');
  await page.click('#panel-create [type=submit]');
  await page.locator('.toast-success', { hasText: 'Market created' }).last().waitFor();
  await filter(page, 'open');
  const z = card(page, 'How long till Bob pays me back?');
  await bet(page, z, '8+ days', 100);
  await waitBalance(page, 650);
  const aliceBefore = 650;
  await setOffset(page, 3 * DAY + 9 * DAY);
  await goto(page);
  await filter(page, 'settled');
  const zs = card(page, 'How long till Bob pays me back?');
  await zs.waitFor();
  assert((await zs.textContent()).includes('auto-settled'), 'resolved by auto');
  assert(await zs.locator('.opt.winner', { hasText: '8+ days' }).count() === 1, '8+ days bucket wins');
  await waitBalance(page, aliceBefore + 130);

  // ---- 10. countdown ticks & closesAt passing
  log('countdown ticks; market moves to Awaiting when closesAt passes');
  await tab(page, 'create');
  await page.fill('#panel-create [name=title]', 'Closing very soon');
  const inOneMinute = await page.evaluate(() => {
    const d = new Date(Date.now() + 100_000); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  await page.fill('#panel-create [name=closesAt]', inOneMinute);
  const labels = page.locator('#panel-create [data-role=label]');
  await labels.nth(0).fill('Yes');
  await labels.nth(1).fill('No');
  await page.click('#panel-create [type=submit]');
  await page.locator('.toast-success', { hasText: 'Market created' }).last().waitFor();
  await filter(page, 'open');
  const cs = card(page, 'Closing very soon');
  const cd = cs.locator('[data-countdown]').first();
  const t1 = await cd.textContent();
  await sleep(2200);
  const t2 = await cd.textContent();
  assert(t1 !== t2, `countdown should tick (${t1} -> ${t2})`);
  const openBefore = parseInt(await page.locator('[data-filter=open] .count').textContent(), 10);
  await setOffset(page, 3 * DAY + 9 * DAY + 5 * 60_000);
  await page.waitForFunction(() => !document.querySelector('#panel-markets article h3')
    || ![...document.querySelectorAll('#panel-markets article h3')].some((h) => h.textContent === 'Closing very soon'),
  null, { timeout: 5000 });
  const openAfter = parseInt(await page.locator('[data-filter=open] .count').textContent(), 10);
  assert(openAfter === openBefore - 1, 'open count dropped by one');
  await filter(page, 'awaiting');
  assert((await card(page, 'Closing very soon').textContent()).includes('Awaiting result'), 'market now awaiting');
  assert(await card(page, 'Closing very soon').locator('[data-action=bet]').count() === 0, 'no betting on closed market');

  // ---- 9b. layout + errors
  log('no horizontal scroll at 375px, no console errors');
  await noHScroll(page, 'alice 375');
  noProblems('end of mobile run');

  // ---- stale state after user switch
  log('no stale drafts / create form after switching user');
  await tab(page, 'create');
  await page.fill('#panel-create [name=title]', 'half-typed draft');
  await logout(page);
  await login(page, 'bob');
  await tab(page, 'create');
  assert((await page.inputValue('#panel-create [name=title]')) === '', 'create form must be reset for the next user');
  await filter(page, 'open');
  assert((await page.locator('#panel-markets article').first().locator('[data-role=amount]').inputValue()) === '', 'no stale bet draft');

  // another tab switching the (shared) session must not leak this tab's drafts
  log('session switched from another tab');
  await logout(page);
  await login(page, 'alice');
  await filter(page, 'open');
  const dc = page.locator('#panel-markets article.market').first();
  await dc.locator('.opt').first().click();
  await dc.locator('[data-role=amount]').fill('7');
  const p3 = await newPage(ctx, 'tab3');
  await goto(p3);
  await logout(p3);
  await page.locator('#auth').waitFor({ state: 'visible' });
  await login(p3, 'bob');
  await page.waitForFunction(() => document.getElementById('h-user').textContent === 'bob');
  await filter(page, 'open');
  assert((await page.locator('#panel-markets article.market').first().locator('[data-role=amount]').inputValue()) === '', 'draft leaked to another user after session switch');
  assert(await page.locator('#panel-markets article.market .opt.selected').count() === 0, 'option selection leaked to another user');
  await p3.close();
  noProblems('session switch');
  await ctx.close();

  // ============================================================ desktop run
  log('desktop viewport sanity');
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await forceLocalMode(dctx);
  await dctx.addInitScript(INIT);
  const dp = await newPage(dctx, 'desktop');
  current = dp;
  await goto(dp);
  await signUp(dp, 'carol');
  await filter(dp, 'open');
  await card(dp, TRUMP).waitFor();
  await bet(dp, card(dp, TRUMP), '1–4 days', 40);
  await waitBalance(dp, 460);
  await noHScroll(dp, 'carol 1280');
  await shot(dp, 'markets-desktop.png');
  noProblems('desktop run');
  await dctx.close();

  console.log(`\nSMOKE OK — screenshots in ${SHOTS}`);
} catch (err) {
  console.error('\nSMOKE FAILED:', err.message);
  if (problems.length) console.error('Collected problems:\n  ' + problems.join('\n  '));
  if (current) { try { await shot(current, 'FAIL.png', true); console.error('Failure screenshot:', path.join(SHOTS, 'FAIL.png')); } catch { /* ignore */ } }
  process.exitCode = 1;
} finally {
  await browser.close();
}

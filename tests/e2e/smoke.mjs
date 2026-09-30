// End-to-end smoke test for Sonnetous v2 (local mode). Drives the real app in headless Chromium.
//
//   python3 -m http.server 8123 &          # serve the repo root
//   node tests/e2e/smoke.mjs               # BASE_URL=http://localhost:8123 by default
//
// Needs the `playwright` npm package (resolved normally, else from PLAYWRIGHT_MODULE or the shared scratch
// install). Not picked up by `node --test` (file is not named *.test.mjs).
//   SHOTS_DIR=/path   where screenshots go (default: $TMPDIR/sonnetous-e2e)
//   FONT_DIR=/path    optional local copy of the Google Fonts CSS + woff2 files (fonts.css + <path with / → _>)
// Time travel: a page init script wraps Date so that "now" = real now + localStorage['qa:offset'].
// External data APIs are stubbed: only the USGS quake feed returns data (controlled by the test), everything else
// answers `{}` so oracle templates that need a baseline are skipped and the daily set is deterministic.
// Exits 1 on the first failure (screenshot of the failing page is saved in SHOTS_DIR).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BASE = process.env.BASE_URL || 'http://localhost:8123';
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'sonnetous-e2e');
const FONT_DIR = process.env.FONT_DIR || '';
fs.mkdirSync(SHOTS, { recursive: true });

const ADMIN_CODE = 'smoke-test-admin-code';
const ADMIN_HASH = crypto.createHash('sha256').update(ADMIN_CODE).digest('hex');

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
const HOUR = 3_600_000;
const MIN = 60_000;
let offset = 0;
let step = 0;
const quake = { mag: null, time: null }; // USGS fixture: one event of `mag` at `time` (ms) when set

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

async function setupRoutes(context) {
  // Always local mode (never touch the live database) + a test-only admin code hash.
  await context.route('**/js/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'export const FIREBASE_CONFIG = null;\n' }));
  await context.route('**/js/admin-hash.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: `export const ADMIN_CODE_SHA256 = '${ADMIN_HASH}';\n` }));
  await context.route((url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1', (route) => {
    const url = new URL(route.request().url());
    const cors = { 'access-control-allow-origin': '*' };
    if (url.hostname === 'fonts.googleapis.com') {
      const css = FONT_DIR && fs.existsSync(path.join(FONT_DIR, 'fonts.css')) ? fs.readFileSync(path.join(FONT_DIR, 'fonts.css'), 'utf8') : '';
      return route.fulfill({ contentType: 'text/css', body: css, headers: cors });
    }
    if (url.hostname === 'fonts.gstatic.com') {
      const f = path.join(FONT_DIR, url.pathname.replace(/^\//, '').replace(/\//g, '_'));
      if (FONT_DIR && fs.existsSync(f)) return route.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(f), headers: cors });
      return route.fulfill({ status: 200, contentType: 'font/woff2', body: '', headers: cors });
    }
    if (url.hostname === 'earthquake.usgs.gov') {
      const minMag = Number(url.searchParams.get('minmagnitude'));
      const features = quake.time != null && minMag <= quake.mag
        ? [{ properties: { mag: quake.mag, time: quake.time, type: 'earthquake', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/smoke1' } }]
        : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features }), headers: cors });
    }
    return route.fulfill({ contentType: 'application/json', body: '{}', headers: cors });
  });
}

async function newPage(ctx, name = 'page') {
  const page = await ctx.newPage();
  page.qaName = name;
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error [${name}]: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror [${name}]: ${e.message}`));
  page.on('dialog', async (d) => {
    problems.push(`unexpected native ${d.type()} dialog [${name}]: ${d.message()}`);
    await d.dismiss();
  });
  return page;
}

async function goto(page) {
  await page.goto(BASE + '/index.html');
  await page.waitForFunction(() => document.getElementById('boot').hidden);
  assert(await page.locator('#fatal').isHidden(), 'fatal error screen shown: ' + (await page.textContent('#fatal-msg').catch(() => '')));
}

async function setOffset(page, ms) {
  offset = ms;
  await page.evaluate((v) => localStorage.setItem('qa:offset', String(v)), ms);
}
const fakeNow = () => Date.now() + offset;

async function shot(page, name, fullPage = false) {
  await sleep(250); // let entry animations settle
  await page.screenshot({ path: path.join(SHOTS, name), fullPage });
}

// ------------------------------------------------------------------ app helpers
const visible = (page, sel) => page.locator(sel).waitFor({ state: 'visible' });

async function authAs(page, mode, user, pass) {
  await visible(page, '#auth');
  await page.click(`[data-auth-mode=${mode}]`);
  await page.fill('#auth-username', user);
  await page.fill('#auth-password', pass);
  await page.click('#auth-submit');
}
async function waitUser(page, user) {
  await visible(page, '#app');
  await page.waitForFunction((u) => document.getElementById('h-user').textContent === u, user);
}
async function signUp(page, user, pass = 'secret123') {
  await authAs(page, 'signup', user, pass);
  await waitUser(page, user);
}
async function login(page, user, pass = 'secret123') {
  await authAs(page, 'signin', user, pass);
  await waitUser(page, user);
}
async function logout(page) {
  await closeSheet(page);
  await page.click('#btn-profile');
  await page.click('#profile [data-logout]');
  await page.locator('#app').waitFor({ state: 'hidden' });
}
async function gateLogin(page, mode, user, pass = 'secret123') {
  await visible(page, '#gate');
  const d = page.locator('#gate-admin');
  if (!(await d.evaluate((el) => el.open))) await page.click('#gate-admin summary');
  await page.click(`[data-gate-mode=${mode}]`);
  await page.fill('#gate-user', user);
  await page.fill('#gate-pass', pass);
  await page.click('#gate-login [type=submit]');
}
const balance = async (page) => parseInt((await page.textContent('#h-balance')).replace(/[^\d-]/g, ''), 10);
async function waitBalance(page, n) {
  await page.waitForFunction((t) => document.getElementById('h-balance').textContent === t, fmtN(n), { timeout: 6000 })
    .catch(async () => { throw new Error(`ASSERT: balance expected ${fmtN(n)}, got ${await page.textContent('#h-balance')}`); });
}
async function tab(page, id) {
  await closeSheet(page);
  const isDesktop = (page.viewportSize() || {}).width >= 900;
  await page.click(`${isDesktop ? '.topnav' : '.tabbar'} [data-tab=${id}]`);
  await visible(page, `#panel-${id}`);
  await sleep(120);
}
async function filter(page, id) {
  await tab(page, 'markets');
  await page.click(`[data-filter=${id}]`);
  await page.waitForFunction((f) => document.querySelector(`[data-filter=${f}]`).getAttribute('aria-pressed') === 'true', id);
  await sleep(80);
}
const card = (page, title) => page.locator('#panel-markets article.mcard').filter({ has: page.locator('.mcard-link').getByText(title, { exact: true }) });
async function openMarket(page, title) {
  await card(page, title).first().locator('.mcard-link').click();
  await visible(page, '#sheet[open] #sheet-title');
  await page.waitForFunction((t) => document.getElementById('sheet-title').textContent === t, title);
  await sleep(150);
  const over = await page.evaluate(() => {
    const b = document.getElementById('sheet-body');
    return b.scrollWidth - b.clientWidth;
  });
  assert(over <= 0, `market sheet "${title}" overflows horizontally by ${over}px`);
}
async function closeSheet(page) {
  if (await page.locator('#sheet[open]').count()) {
    await page.keyboard.press('Escape'); // keyboard-operable dialog
    await page.locator('#sheet[open]').waitFor({ state: 'detached' }).catch(() => {});
    await page.waitForFunction(() => !document.getElementById('sheet').open);
  }
}
const sheet = (page) => page.locator('#sheet');
async function toastWait(page, text, type = 'success') {
  await page.locator(`.toast-${type}`, { hasText: text }).last().waitFor({ timeout: 8000 });
}
async function placeBet(page, optionLabel, amount) {
  const s = sheet(page);
  await s.locator('[data-pick]', { hasText: optionLabel }).first().click();
  await s.locator('[data-key=amount]').fill(String(amount));
  const btn = s.locator('[data-act=bet]');
  await page.waitForFunction(() => { const b = document.querySelector('#sheet [data-act=bet]'); return b && !b.disabled; });
  assert((await s.locator('[data-preview]').textContent()).includes('profit'), 'bet slip shows the win/profit preview');
  await btn.click();
  await toastWait(page, 'Bet placed');
  await sleep(2100); // bet cooldown
}
async function confirmModal(page) {
  await visible(page, '#modal[open] [data-m=ok]');
  await page.click('#modal [data-m=ok]');
  await page.locator('#modal[open]').waitFor({ state: 'detached' }).catch(() => {});
}
async function createChoice(page, title, labels, description = '', closeIn = '3600000') {
  await tab(page, 'create');
  await page.check('#panel-create [name=kind][value=choice]', { force: true });
  await page.fill('#c-title', title);
  if (description) await page.fill('#c-desc', description);
  while ((await page.locator('#panel-create [data-opt]').count()) < labels.length) await page.click('[data-add-opt]');
  const inputs = page.locator('#panel-create [data-opt]');
  for (let i = 0; i < labels.length; i++) await inputs.nth(i).fill(labels[i]);
  await page.click(`[data-close-in="${closeIn}"]`);
  await page.click('#panel-create [data-submit]');
  await toastWait(page, 'Market created');
  await visible(page, '#sheet[open]');
  await closeSheet(page);
}

async function noHScroll(page, label) {
  const tabs = ['markets', 'create', 'mybets', 'leaderboard', 'activity'];
  if (await page.locator('#nav-admin:not([hidden])').count()) tabs.push('admin');
  for (const t of tabs) {
    if (t === 'admin') {
      await closeSheet(page);
      await page.click('#btn-profile');
      await page.click('#profile [data-go=admin]');
      await visible(page, '#panel-admin');
      await sleep(120);
    } else await tab(page, t);
    const over = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    assert(over <= 0, `horizontal scroll (${over}px) on ${t} tab [${label}]`);
    const spill = await page.evaluate((id) => {
      const out = [];
      const vw = window.innerWidth;
      for (const el of document.querySelectorAll(`#panel-${id} *`)) {
        const b = el.getBoundingClientRect();
        if (!b.width || el.closest('.scroller')) continue;
        if (b.right > vw + 1 || b.left < -1) out.push(`${el.tagName}.${el.className}`.slice(0, 50));
      }
      return out;
    }, t);
    assert(spill.length === 0, `content outside the viewport on ${t} tab [${label}]: ${spill.slice(0, 3).join(' | ')}`);
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
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: false });
  await setupRoutes(ctx);
  await ctx.addInitScript(INIT);
  const page = await newPage(ctx, 'main');
  current = page;
  await goto(page);

  // ---- 1. maintenance: nobody gets in before the admin claims
  log('fresh install shows the maintenance screen to visitors');
  await visible(page, '#gate');
  assert((await page.textContent('#gate')).includes('closed'), 'maintenance copy');
  assert(await page.locator('#auth').isHidden(), 'no login screen while closed');
  await shot(page, 'maintenance-375.png');
  await page.setViewportSize({ width: 1280, height: 860 });
  await shot(page, 'maintenance-1280.png');
  await page.setViewportSize({ width: 375, height: 812 });

  log('a normal user who signs up during maintenance still sees the maintenance screen');
  await gateLogin(page, 'signup', 'carol');
  await page.waitForFunction(() => /Signed in as/.test(document.getElementById('gate').textContent));
  assert((await page.textContent('#gate')).includes('carol'), 'shows who is signed in');
  assert(await page.locator('#app').isHidden(), 'carol must not get into the app');
  await page.click('[data-gate-logout]');
  await page.waitForFunction(() => !/Signed in as/.test(document.getElementById('gate').textContent));

  // ---- 2. admin claim
  log('admin signs up, wrong code rejected, right code claims admin');
  await gateLogin(page, 'signup', 'boss');
  await visible(page, '#gate-code');
  await page.fill('#gate-code', 'nope');
  await page.click('#gate-claim [type=submit]');
  await page.locator('#gate-claim .form-error').waitFor({ state: 'visible' });
  await page.fill('#gate-code', ADMIN_CODE);
  await page.click('#gate-claim [type=submit]');
  await waitUser(page, 'boss');
  await visible(page, '#pill-maint');
  await toastWait(page, "You're the admin");

  log('admin turns maintenance off');
  await page.click('#pill-maint [data-tab=admin]');
  await visible(page, '#panel-admin');
  await page.click('[data-admin=maint]');
  await confirmModal(page);
  await page.locator('#pill-maint').waitFor({ state: 'hidden' });
  assert((await page.getAttribute('[data-admin=maint]', 'aria-checked')) === 'false', 'switch shows maintenance off');
  await logout(page);

  // ---- 3. players
  log('alice + bob sign up; carol (created during maintenance) logs in and gets her stack');
  await visible(page, '#auth');
  await signUp(page, 'alice');
  assert((await balance(page)) === 500, 'alice starts with 500');
  await logout(page);
  await authAs(page, 'signup', 'ALICE', 'secret123');
  await page.waitForFunction(() => /taken/i.test(document.getElementById('auth-error').textContent));
  await authAs(page, 'signup', '<img src=x onerror=alert(1)>', 'secret123');
  await page.locator('#auth-error').waitFor({ state: 'visible' });
  await signUp(page, 'bob');
  await logout(page);
  await login(page, 'carol');
  await waitBalance(page, 500);
  await logout(page);

  // ---- 4. house markets + oracle markets
  await login(page, 'alice');
  log('daily house markets: featured Trump market + oracle markets');
  await filter(page, 'open');
  await page.locator('#panel-markets .featured article.mcard').first().waitFor();
  const houseCount = await page.locator('#panel-markets .featured article.mcard').count();
  assert(houseCount >= 3, `expected today's house markets in the featured strip, got ${houseCount}`);
  assert(await page.locator('#panel-markets .featured .badge', { hasText: 'Featured' }).count() === 1, 'one featured market');
  const oracleCards = page.locator('#panel-markets article.mcard', { has: page.locator('.badge', { hasText: 'Auto-checked' }) });
  const oracleCount = await oracleCards.count();
  assert(oracleCount >= 1, 'at least one auto-checked (oracle) market');
  assert(await page.locator('#panel-markets .badge', { hasText: 'Tampered' }).count() === 0, 'no tampered badges on genuine house markets');
  await shot(page, 'markets-375.png');
  await shot(page, 'markets-375-full.png', true);

  // tamper detection: edit a house market in storage -> ⚠ badge + betting disabled
  log('tampered house market shows ⚠ and disables betting');
  const tamperedTitle = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('sonnetous:v2'));
    const m = Object.values(db.markets).find((x) => x.createdBy === 'house' && !x.oracle && x.templateId !== 'trump-constitution');
    const k = Object.keys(m.oddsById)[0];
    m.oddsById[k] = 19.5;
    m.options.find((o) => o.id === k).odds = 19.5;
    localStorage.setItem('sonnetous:v2', JSON.stringify(db));
    return m.title;
  });
  await goto(page);
  await waitUser(page, 'alice');
  await card(page, tamperedTitle).locator('.badge', { hasText: 'Tampered' }).waitFor();
  await openMarket(page, tamperedTitle);
  assert(await sheet(page).locator('[data-slip]').count() === 0, 'no bet slip on a tampered market');
  assert((await sheet(page).textContent()).includes("doesn't match its template"), 'tamper notice');
  await closeSheet(page);

  // oracle market: alice bets on the quickest bucket, then USGS reports a quake -> auto-report
  log('oracle (quake) market: bet, data arrives, client auto-reports');
  const quakeMarket = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('sonnetous:v2'));
    const ms = Object.values(db.markets).filter((x) => x.oracle && x.oracle.type === 'quake' && x.status === 'open')
      .sort((a, b) => a.oracle.params.minMag - b.oracle.params.minMag);
    return ms[0] ? { id: ms[0].id, title: ms[0].title, minMag: ms[0].oracle.params.minMag, openedAt: ms[0].openedAt, first: ms[0].options[0].label } : null;
  });
  assert(quakeMarket, 'a quake oracle market exists (only keyless oracle templates can build under the stubbed APIs)');
  await openMarket(page, quakeMarket.title);
  assert((await sheet(page).locator('#sheet-head').textContent()).includes('Auto-checked'), 'oracle badge in the sheet header');
  assert((await sheet(page).textContent()).includes('Clock starts when you bet'), 'timer copy in the bet slip');
  await placeBet(page, quakeMarket.first, 40);
  await waitBalance(page, 460);
  await shot(page, 'oracle-market-375.png');
  await closeSheet(page);
  await setOffset(page, 30 * MIN);
  quake.mag = quakeMarket.minMag + 0.3;
  quake.time = fakeNow() - 2 * MIN;
  await goto(page); // sweep runs on load
  await waitUser(page, 'alice');
  await toastWait(page, 'Auto-reported');
  await waitBalance(page, 440); // 460 - 20 bond
  // USGS "revises" the origin time -> the report no longer matches the data
  quake.time = quakeMarket.openedAt + MIN;
  await goto(page);
  await waitUser(page, 'alice');
  await filter(page, 'disputed');
  await openMarket(page, quakeMarket.title);
  await sheet(page).locator('.oracle-alert').waitFor();
  assert((await sheet(page).locator('.oracle-alert').textContent()).includes("Report doesn't match USGS data"), 'mismatch banner');
  await shot(page, 'oracle-mismatch-375.png');
  await closeSheet(page);
  await logout(page);
  await login(page, 'bob');
  await toastWait(page, 'Auto-challenged');
  await waitBalance(page, 480); // bond
  await logout(page);

  // ---- 5. custom pool market lifecycle: bet → report w/ evidence → challenge → jury vote → finalize → claims
  await login(page, 'alice');
  log('alice creates a pool market; alice and bob bet');
  const CHESS = 'Who wins Friday’s chess grudge match?';
  await createChoice(page, CHESS, ['Alice', 'Bob'], 'Counts if: the game is finished over the board. Resignation counts as a loss.');
  await filter(page, 'open');
  await openMarket(page, CHESS);
  assert(await sheet(page).locator('[data-act=void]').count() === 1, 'creator can void before any bet');
  await placeBet(page, 'Alice', 100);
  await waitBalance(page, 340);
  assert(await sheet(page).locator('[data-act=void]').count() === 0, 'void disappears after the first bet');
  await logout(page);
  await login(page, 'bob');
  await filter(page, 'open');
  await openMarket(page, CHESS);
  await placeBet(page, 'Bob', 300);
  await waitBalance(page, 180);
  await page.setViewportSize({ width: 375, height: 812 });
  await shot(page, 'sheet-betslip-375.png');
  assert(await sheet(page).locator('[data-report]').count() === 0, 'bob cannot report alice’s market');
  await closeSheet(page);
  await logout(page);

  log('betting closes; alice reports with evidence (bond)');
  await login(page, 'alice');
  await setOffset(page, 30 * MIN + 2 * HOUR);
  await filter(page, 'needs');
  await openMarket(page, CHESS);
  const rep = sheet(page).locator('[data-report]');
  await rep.locator('.radio-card', { hasText: 'Alice' }).click();
  assert(await rep.locator('[data-act=report]').isDisabled(), 'evidence link is required for non-oracle markets');
  assert((await rep.locator('[data-hint]').textContent()).toLowerCase().includes('evidence'), 'inline evidence hint');
  await rep.locator('[data-key=evidence]').fill('https://example.com/chess-result?x="<b>"');
  await rep.locator('[data-act=report]').click();
  await toastWait(page, 'Result reported');
  await waitBalance(page, 320);
  await logout(page);

  log('bob sees the report and challenges it');
  await login(page, 'bob');
  await filter(page, 'disputed');
  await openMarket(page, CHESS);
  const ev = sheet(page).locator('a.evidence-link');
  assert((await ev.getAttribute('rel')).includes('noopener'), 'evidence link has rel=noopener');
  await shot(page, 'reported-challenge-375.png');
  await sheet(page).locator('[data-act=challenge]').first().click();
  await confirmModal(page);
  await toastWait(page, 'Challenge filed');
  await waitBalance(page, 160);
  assert((await sheet(page).locator('[data-sec=phase]').textContent()).includes("You bet on this market") || (await sheet(page).locator('[data-sec=phase]').textContent()).includes("part of this dispute"), 'bob cannot vote');
  await logout(page);

  log('carol (no bet) votes to uphold');
  await login(page, 'carol');
  await filter(page, 'disputed');
  await openMarket(page, CHESS);
  await sheet(page).locator('[data-act=vote-up]').waitFor();
  await shot(page, 'disputed-voting-375.png');
  await sheet(page).locator('[data-act=vote-up]').click();
  await toastWait(page, 'Vote cast');
  await page.waitForFunction(() => /already voted/.test(document.querySelector('#sheet [data-sec=phase]').textContent));
  assert((await sheet(page).locator('.tally-legend').textContent()).includes('Uphold · 1'), 'tally updated');
  await closeSheet(page);
  await logout(page);

  log('24h later: finalize + automatic claims (alice wins the pool + challenger bond)');
  await login(page, 'alice');
  await setOffset(page, 30 * MIN + 2 * HOUR + 25 * HOUR);
  await goto(page); // housekeeping on login
  await waitUser(page, 'alice');
  // 320 + pool 400 + bond 40 (+ quake bet/bond settle depending on jury: quake market was challenged with no votes -> void)
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('sonnetous:v2'));
    return Object.values(db.markets).filter((m) => m.title === 'Who wins Friday’s chess grudge match?').every((m) => m.status === 'resolved');
  }, null, { timeout: 8000 });
  await toastWait(page, 'You won', 'win');
  // chess: +400 pool, +40 bond; quake: void (no votes) -> +40 stake refund, +20 bond refund
  await waitBalance(page, 320 + 400 + 40 + 40 + 20);
  await filter(page, 'settled');
  await openMarket(page, CHESS);
  assert((await sheet(page).locator('[data-sec=phase]').textContent()).includes('Resolved: Alice'), 'outcome shown');
  assert((await sheet(page).locator('[data-sec=phase]').textContent()).includes('+§300'), 'your result shown');
  await closeSheet(page);
  await tab(page, 'mybets');
  assert((await page.textContent('#panel-mybets')).includes('Won'), 'my bets history shows the win');
  await logout(page);
  await login(page, 'bob');
  await goto(page);
  await waitUser(page, 'bob');
  await waitBalance(page, 160 + 20); // lost chess stake + bond; quake challenge tie -> bond back
  await logout(page);

  // ---- 6. XSS
  log('XSS: title / option / description render as text');
  await login(page, 'alice');
  const XSS = '<img src=x onerror=alert(1)>';
  await createChoice(page, XSS, ['<script>alert(2)</script>', 'fine'], '<b onmouseover=alert(3)>desc</b>', '86400000');
  await filter(page, 'open');
  const xc = card(page, XSS);
  await xc.waitFor();
  assert(await xc.locator('img').count() === 0, 'no <img> injected into the card');
  assert((await xc.textContent()).includes('<script>alert(2)</script>'), 'option label shown literally');
  await openMarket(page, XSS);
  assert(await sheet(page).locator('img, script, b[onmouseover]').count() === 0, 'nothing injected into the sheet');
  assert((await sheet(page).textContent()).includes('<b onmouseover=alert(3)>desc</b>'), 'description shown literally');
  await closeSheet(page);
  await tab(page, 'activity');
  assert(await page.locator('#panel-activity img').count() === 0, 'activity feed escapes titles');

  // ---- 7. inputs survive live re-renders
  log('typed bet amount survives a live update from another tab');
  await filter(page, 'open');
  await openMarket(page, XSS);
  await sheet(page).locator('[data-pick]').first().click();
  await sheet(page).locator('[data-key=amount]').fill('77');
  await page.evaluate(() => { // another tab places a bet -> storage event -> re-render
    const db = JSON.parse(localStorage.getItem('sonnetous:v2'));
    const m = Object.values(db.markets).find((x) => x.title.startsWith('<img'));
    m.totalPool += 5; m.optionTotals.o2 = (m.optionTotals.o2 || 0) + 5; m.betCount += 1;
    localStorage.setItem('sonnetous:v2', JSON.stringify(db));
    window.dispatchEvent(new StorageEvent('storage', { key: 'sonnetous:v2' }));
  });
  await sleep(300);
  assert((await sheet(page).locator('[data-key=amount]').inputValue()) === '77', 'amount preserved across re-render');
  await closeSheet(page);

  // ---- 8. leaderboard
  log('leaderboard ranks by net worth and highlights you');
  await tab(page, 'leaderboard');
  const lb = page.locator('#panel-leaderboard .lb-row');
  assert((await lb.first().textContent()).includes('alice'), 'alice ranks first');
  assert(await page.locator('#panel-leaderboard .lb-row.is-me').count() === 1, 'you are highlighted');
  await shot(page, 'leaderboard-375.png', true);

  log('no horizontal overflow at 375px');
  await noHScroll(page, 'alice 375');
  await filter(page, 'settled');
  await openMarket(page, CHESS);
  const sheetOver = await page.evaluate(() => {
    const p = document.querySelector('#sheet .sheet-panel');
    return p.scrollWidth - p.clientWidth;
  });
  assert(sheetOver <= 0, `sheet overflows horizontally by ${sheetOver}px`);
  await closeSheet(page);
  await logout(page);

  // ---- 9. ban / unban
  log('admin bans carol -> banned screen with reason -> unban');
  await login(page, 'boss');
  await page.click('#btn-profile');
  await page.click('#profile [data-go=admin]');
  await visible(page, '#panel-admin');
  await page.locator('[data-admin=ban][data-name=carol]').click();
  await visible(page, '#modal-input');
  await page.click('#modal [data-m=ok]'); // empty reason -> inline error
  await visible(page, '#modal-err');
  await page.fill('#modal-input', 'Voting <i>twice</i>');
  await page.click('#modal [data-m=ok]');
  await toastWait(page, 'has been banned');
  await page.locator('#panel-admin .ban-item', { hasText: 'carol' }).waitFor();
  await shot(page, 'admin-375.png', true);
  await noHScroll(page, 'admin 375');
  await logout(page);
  await authAs(page, 'signin', 'carol', 'secret123');
  await visible(page, '#gate');
  await page.waitForFunction(() => /banned/.test(document.getElementById('gate').textContent));
  assert((await page.textContent('#ban-reason')) === 'Voting <i>twice</i>', 'ban reason rendered as text');
  assert(await page.locator('#gate i').count() === 0, 'ban reason not injected');
  await shot(page, 'banned-375.png');
  await page.click('[data-gate-logout]');
  await login(page, 'boss');
  await page.click('#btn-profile');
  await page.click('#profile [data-go=admin]');
  await page.locator('#panel-admin .ban-item [data-admin=unban]').first().click();
  await confirmModal(page);
  await toastWait(page, 'back in the game');
  await logout(page);
  await login(page, 'carol');
  await logout(page);

  // ---- 10. desktop
  log('desktop layout screenshots (1280px)');
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, 'alice');
  await filter(page, 'open');
  await shot(page, 'markets-1280.png');
  await openMarket(page, XSS);
  await sheet(page).locator('[data-pick]').first().click();
  await sheet(page).locator('[data-key=amount]').fill('50');
  await shot(page, 'sheet-betslip-1280.png');
  await closeSheet(page);
  await tab(page, 'leaderboard');
  await shot(page, 'leaderboard-1280.png');
  await tab(page, 'mybets');
  await shot(page, 'mybets-1280.png');
  await tab(page, 'activity');
  await shot(page, 'activity-1280.png');
  await tab(page, 'create');
  await page.fill('#c-title', 'Will the group chat survive another election?');
  await shot(page, 'create-1280.png');
  await page.fill('#c-title', '');
  await logout(page);
  await login(page, 'boss');
  await tab(page, 'admin');
  await shot(page, 'admin-1280.png');
  await logout(page);
  await visible(page, '#auth');
  await shot(page, 'auth-1280.png');

  noProblems('the end');
  console.log(`\nSMOKE OK — screenshots in ${SHOTS}`);
} catch (err) {
  console.error('\nSMOKE FAILED:', err.message);
  if (problems.length) console.error('problems:\n  ' + problems.join('\n  '));
  if (current) await current.screenshot({ path: path.join(SHOTS, 'FAILED.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}

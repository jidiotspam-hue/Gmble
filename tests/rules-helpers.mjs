// Shared harness for the Firebase emulator tests (tests/rules-attacks.test.mjs, tests/firebase-store.test.mjs).
// Not a test file itself. Everything here is TEST-ONLY: the real admin code is never used or known.
//
// Run instructions (needs Java 11+ and Node 20+; nothing is installed into the repo):
//   mkdir /tmp/fb && cd /tmp/fb && npm init -y && npm i firebase@10.12.2 firebase-tools
//   cat > firebase.json   # {"firestore":{"rules":"<repo>/firestore.rules"},
//                         #  "emulators":{"auth":{"port":9099},"firestore":{"port":8080},"ui":{"enabled":false}}}
//   npx firebase emulators:start --only auth,firestore --project demo-sonnetous &
//   FB_SDK_DIR=/tmp/fb node --test --test-force-exit tests/
// The tests push a TEST copy of firestore.rules into the running emulator (admin hash = sha256('test-admin-code'),
// 12h/24h windows shortened to 4s, bailout day shortened to 4s), so the emulator can be started with any rules.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROJECT = 'demo-sonnetous';
export const EMU_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
export const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const [FS_H, FS_P] = EMU_HOST.split(':');
export const emulator = { authUrl: `http://${AUTH_HOST}`, firestoreHost: FS_H, firestorePort: Number(FS_P) };
export const fbConfig = { apiKey: 'fake', projectId: PROJECT, authDomain: 'x' };
export const REST = `http://${EMU_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

export const TEST_ADMIN_CODE = 'test-admin-code';
export const TEST_CHALLENGE_WINDOW_MS = 4000;
export const TEST_VOTE_WINDOW_MS = 4000;
export const TEST_BAILOUT_DAY_MS = 4000;
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULES_PATH = path.join(here, '..', 'firestore.rules');

/** Copy of firestore.rules with the admin hash and the long windows swapped for test values. */
export function testRulesSource() {
  let src = fs.readFileSync(process.env.RULES_FILE || RULES_PATH, 'utf8'); // RULES_FILE: debugging aid
  const sub = (name, literal) => {
    const re = new RegExp(`(function ${name}\\(\\) \\{ return )[^;]+(; \\})`);
    if (!re.test(src)) throw new Error(`firestore.rules has no tunable ${name}()`);
    src = src.replace(re, `$1${literal}$2`);
  };
  sub('ADMIN_CODE_SHA256', `'${sha256hex(TEST_ADMIN_CODE)}'`);
  sub('CHALLENGE_WINDOW_MS', String(TEST_CHALLENGE_WINDOW_MS));
  sub('VOTE_WINDOW_MS', String(TEST_VOTE_WINDOW_MS));
  sub('BAILOUT_DAY_MS', String(TEST_BAILOUT_DAY_MS));
  return src;
}

export async function pushRules(content = testRulesSource()) {
  const r = await fetch(`http://${EMU_HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Could not load rules into the emulator: ' + text.slice(0, 2000));
  let body = {};
  try { body = JSON.parse(text); } catch { /* empty body */ }
  const errors = (body.issues || []).filter((i) => i.severity === 'ERROR');
  if (errors.length) throw new Error('firestore.rules has errors: ' + JSON.stringify(errors));
  return (body.issues || []).filter((i) => i.severity !== 'ERROR');
}

/** { sdk, skip } - skip is a string reason when the SDK / emulator is not available. */
export async function loadEnv() {
  let sdk = null;
  let skip = false;
  try {
    if (!process.env.FB_SDK_DIR) throw new Error('set FB_SDK_DIR to a directory with node_modules/firebase@10.12.2');
    const req = createRequire(path.join(process.env.FB_SDK_DIR, 'noop.js'));
    sdk = { app: req('firebase/app'), auth: req('firebase/auth'), firestore: req('firebase/firestore') };
    const ping = await fetch(`http://${EMU_HOST}/`, { signal: AbortSignal.timeout(1500) });
    if (!ping.ok) throw new Error('Firestore emulator not reachable');
    await fetch(`http://${AUTH_HOST}/`, { signal: AbortSignal.timeout(1500) });
  } catch (err) {
    skip = 'Firebase emulator tests skipped: ' + (err && err.message);
    sdk = null;
  }
  return { sdk, skip };
}

// The test files share one emulator and node --test runs files in parallel: serialise them with a lock dir.
const LOCK = path.join(os.tmpdir(), 'sonnetous-emulator-tests.lock');
export async function acquireLock() {
  const end = Date.now() + 15 * 60 * 1000;
  for (;;) {
    try { fs.mkdirSync(LOCK); return; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10 * 60 * 1000) fs.rmSync(LOCK, { recursive: true }); } catch { /* raced */ }
      if (Date.now() > end) throw new Error('timed out waiting for the emulator test lock');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
export function releaseLock() { try { fs.rmSync(LOCK, { recursive: true }); } catch { /* already gone */ } }

export async function resetEmulator() {
  await fetch(`http://${EMU_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

// ---- ground truth via REST with the emulator's admin bypass ("Authorization: Bearer owner" skips rules)
function dec(v) {
  if ('nullValue' in v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  throw new Error('unknown ' + JSON.stringify(v));
}
export async function adminList(coll) {
  const out = [];
  let tok = '';
  do {
    const r = await fetch(`${REST}/${coll}?pageSize=300${tok ? '&pageToken=' + tok : ''}`, { headers: { Authorization: 'Bearer owner' } });
    const j = await r.json();
    for (const d of j.documents || []) out.push({ _id: d.name.split('/').pop(), ...dec({ mapValue: { fields: d.fields } }) });
    tok = j.nextPageToken || '';
  } while (tok);
  return out;
}
export async function adminGet(coll, id) {
  const r = await fetch(`${REST}/${coll}/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer owner' } });
  if (r.status === 404) return null;
  const j = await r.json();
  return { _id: id, ...dec({ mapValue: { fields: j.fields || {} } }) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (Date.now() > end) throw e; }
    if (Date.now() > end) throw new Error('until timed out');
    await sleep(50);
  }
}

// ---- fast-forward state that would take days (emulator admin bypass); only for scalar fields
function enc(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  throw new Error('enc ' + typeof v);
}
export async function adminPatch(coll, id, fields) {
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&');
  const r = await fetch(`${REST}/${coll}/${id}?${mask}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) }),
  });
  if (!r.ok) throw new Error('adminPatch failed ' + (await r.text()));
}

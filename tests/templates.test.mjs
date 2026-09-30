import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, pickDailyTemplates, buildAutoMarket, dailyMarkets } from '../js/templates.js';
import { DEFAULT_TIMER_BUCKETS, HOUR_MS, timerAutoResolution, timerBucketFor, DAY_MS, isBettingOpen, validateBet, newUser } from '../js/economy.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const KEY = '2026-06-15';

describe('TEMPLATES', () => {
  test('at least 30, unique ids, required fields', () => {
    assert.ok(TEMPLATES.length >= 30);
    const ids = TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of TEMPLATES) {
      assert.match(t.id, /^[a-z0-9-]+$/, t.id);
      assert.ok(['timer', 'choice'].includes(t.kind), t.id);
      for (const f of ['category', 'emoji', 'title', 'description']) {
        assert.equal(typeof t[f], 'string', `${t.id}.${f}`);
        assert.ok(t[f].trim().length > 0, `${t.id}.${f}`);
      }
      assert.ok(t.title.length >= 3 && t.title.length <= 140, t.id);
      if (t.closeHours !== undefined) assert.ok(t.closeHours > 0, t.id);
    }
  });

  test('mostly timers, ~8 choices, required categories covered', () => {
    const timers = TEMPLATES.filter((t) => t.kind === 'timer');
    const choices = TEMPLATES.filter((t) => t.kind === 'choice');
    assert.ok(timers.length > choices.length * 2);
    assert.ok(choices.length >= 8);
    const cats = new Set(TEMPLATES.map((t) => t.category));
    for (const c of ['Politics', 'Tech/AI', 'Celebrities', 'Sports', 'Crypto', 'Weird news']) {
      assert.ok(cats.has(c), `missing category ${c}`);
    }
    assert.ok([...cats].some((c) => /friend/i.test(c)));
  });

  test('trump-constitution template', () => {
    const t = TEMPLATES.find((x) => x.id === 'trump-constitution');
    assert.ok(t);
    assert.equal(t.title, 'How long till Trump violates the constitution again?');
    assert.equal(t.kind, 'timer');
    assert.equal(t.category, 'Politics');
  });

  test('friend group bankruptcy template exists', () => {
    assert.ok(TEMPLATES.some((t) => t.title === 'How long till one of us goes bankrupt?'));
  });

  test('timer titles start with "How long till"', () => {
    for (const t of TEMPLATES.filter((x) => x.kind === 'timer')) {
      assert.match(t.title, /^How long till .+\?$/, t.id);
    }
  });

  test('timer buckets: continuous, first from 0, last open-ended, rarer pays more', () => {
    for (const t of TEMPLATES.filter((x) => x.kind === 'timer')) {
      const b = t.buckets ?? DEFAULT_TIMER_BUCKETS;
      assert.ok(b.length >= 2, t.id);
      assert.equal(new Set(b.map((o) => o.id)).size, b.length, `${t.id} unique bucket ids`);
      assert.equal(b[0].fromDays, 0, t.id);
      assert.equal(b[b.length - 1].toDays, null, t.id);
      for (let i = 0; i < b.length; i++) {
        assert.equal(typeof b[i].label, 'string', t.id);
        assert.ok(b[i].odds > 1, `${t.id} odds > 1`);
        if (i > 0) {
          assert.equal(b[i].fromDays, b[i - 1].toDays, `${t.id} bucket ${i} contiguous`);
          assert.ok(b[i].odds < b[i - 1].odds, `${t.id} odds must fall as buckets get later`);
        }
        if (i < b.length - 1) assert.ok(b[i].toDays > b[i].fromDays, `${t.id} bucket ${i} non-empty`);
      }
    }
  });

  test('choice options: 2-6, unique ids, odds > 1, less likely option pays more', () => {
    for (const t of TEMPLATES.filter((x) => x.kind === 'choice')) {
      assert.ok(t.options.length >= 2 && t.options.length <= 6, t.id);
      assert.equal(new Set(t.options.map((o) => o.id)).size, t.options.length, t.id);
      for (const o of t.options) {
        assert.equal(typeof o.label, 'string', t.id);
        assert.ok(typeof o.odds === 'number' && o.odds > 1, `${t.id}/${o.id} odds > 1`);
      }
      assert.ok(t.closeHours > 0, t.id);
      // implied probabilities should sum to at least 1 (house never loses on paper)
      const implied = t.options.reduce((s, o) => s + 1 / o.odds, 0);
      assert.ok(implied >= 0.999, `${t.id} implied ${implied.toFixed(3)}`);
      // not all odds identical: something must be favoured
      assert.ok(new Set(t.options.map((o) => o.odds)).size > 1, t.id);
    }
  });
});

describe('pickDailyTemplates', () => {
  test('deterministic', () => {
    assert.deepEqual(pickDailyTemplates(KEY).map((t) => t.id), pickDailyTemplates(KEY).map((t) => t.id));
  });
  test('default count 4, no duplicates, all real templates', () => {
    for (let d = 1; d <= 60; d++) {
      const key = `2026-07-${String(d).padStart(2, '0')}`;
      const picks = pickDailyTemplates(key);
      assert.equal(picks.length, 4);
      assert.equal(new Set(picks.map((t) => t.id)).size, 4, key);
      for (const p of picks) assert.ok(TEMPLATES.includes(p));
    }
  });
  test('different days differ (mostly) and count is honoured / capped', () => {
    const sets = new Set();
    for (let d = 1; d <= 20; d++) sets.add(pickDailyTemplates(`2026-08-${String(d).padStart(2, '0')}`).map((t) => t.id).join(','));
    assert.ok(sets.size >= 15);
    assert.equal(pickDailyTemplates(KEY, 7).length, 7);
    assert.equal(pickDailyTemplates(KEY, 1).length, 1);
    assert.equal(pickDailyTemplates(KEY, 9999).length, TEMPLATES.length);
    assert.equal(new Set(pickDailyTemplates(KEY, 9999).map((t) => t.id)).size, TEMPLATES.length);
  });
  test('does not mutate TEMPLATES order', () => {
    const before = TEMPLATES.map((t) => t.id).join();
    pickDailyTemplates(KEY, 10);
    assert.equal(TEMPLATES.map((t) => t.id).join(), before);
  });
  test('over many days every template eventually shows up', () => {
    const seen = new Set();
    for (let d = 0; d < 400; d++) {
      for (const t of pickDailyTemplates(`day-${d}`)) seen.add(t.id);
    }
    assert.equal(seen.size, TEMPLATES.length);
  });
});

describe('buildAutoMarket / dailyMarkets', () => {
  test('timer market shape', () => {
    const t = TEMPLATES.find((x) => x.id === 'trump-constitution');
    const m = buildAutoMarket(t, KEY, NOW);
    assert.equal(m.id, 'auto-2026-06-15-trump-constitution');
    assert.equal(m.type, 'auto');
    assert.equal(m.templateId, 'trump-constitution');
    assert.equal(m.kind, 'timer');
    assert.equal(m.mode, 'fixed');
    assert.equal(m.createdBy, 'house');
    assert.equal(m.createdByName, 'The House');
    assert.equal(m.openedAt, NOW);
    assert.equal(m.closesAt, NOW + 12 * HOUR_MS);
    assert.equal(m.status, 'open');
    assert.deepEqual(m.options, DEFAULT_TIMER_BUCKETS);
    assert.deepEqual(m.optionTotals, { d1: 0, d4: 0, d8: 0, never: 0 });
    assert.equal(m.totalPool, 0);
    assert.equal(m.betCount, 0);
    assert.equal(m.resolvedOptionId, null);
    assert.equal(m.resolvedAt, null);
    assert.equal(m.resolvedBy, null);
    assert.equal(m.eventAt, null);
    assert.equal(m.title, t.title);
    assert.equal(m.category, 'Politics');
  });

  test('every template builds a bettable, resolvable market without sharing state', () => {
    for (const t of TEMPLATES) {
      const m = buildAutoMarket(t, KEY, NOW);
      assert.equal(m.id, `auto-${KEY}-${t.id}`);
      assert.equal(m.mode, 'fixed');
      assert.equal(isBettingOpen(m, NOW), true, t.id);
      assert.equal(isBettingOpen(m, m.closesAt), false, t.id);
      assert.equal(validateBet(newUser('u', 'n', NOW), m, m.options[0].id, 10, NOW), null, t.id);
      assert.deepEqual(Object.keys(m.optionTotals), m.options.map((o) => o.id), t.id);
      if (t.kind === 'timer') {
        assert.equal(timerBucketFor(m, NOW), m.options[0].id, t.id);
        const last = m.options[m.options.length - 1];
        const maxFinite = Math.max(...m.options.filter((o) => o.toDays != null).map((o) => o.toDays));
        assert.equal(timerAutoResolution(m, NOW + maxFinite * DAY_MS), last.id, t.id);
        assert.equal(timerAutoResolution(m, NOW), null, t.id);
        m.options[0].odds = 999;
      } else {
        m.options[0].odds = 999;
      }
      const again = buildAutoMarket(t, KEY, NOW);
      assert.notEqual(again.options[0].odds, 999, `${t.id} options must be copies`);
    }
  });

  test('closeHours override honoured', () => {
    const t = TEMPLATES.find((x) => x.closeHours && x.closeHours !== 12);
    const m = buildAutoMarket(t, KEY, NOW);
    assert.equal(m.closesAt, NOW + t.closeHours * HOUR_MS);
  });

  test('dailyMarkets ids', () => {
    const ms = dailyMarkets(KEY, NOW);
    assert.equal(ms.length, 4);
    const expected = pickDailyTemplates(KEY).map((t) => `auto-${KEY}-${t.id}`);
    assert.deepEqual(ms.map((m) => m.id), expected);
    assert.equal(new Set(ms.map((m) => m.id)).size, 4);
    assert.ok(ms.every((m) => m.openedAt === NOW));
    assert.equal(dailyMarkets(KEY, NOW, 6).length, 6);
    // idempotent ids regardless of `now`
    assert.deepEqual(dailyMarkets(KEY, NOW + 5000).map((m) => m.id), expected);
  });
});

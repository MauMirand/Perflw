'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/exam-model');

const q = (type, difficulty = 2, payload = {}) => ({ type, difficulty, payload });
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('loads under require and as a browser global; defaults are frozen and versioned', () => {
  assert.equal(m.DEFAULT_EXAM_CONFIG.version, 1);
  assert.ok(Object.isFrozen(m.DEFAULT_EXAM_CONFIG) && Object.isFrozen(m.DEFAULT_EXAM_CONFIG.baseSeconds));
  const vm = require('node:vm');
  const sandbox = { module: undefined }; sandbox.globalThis = sandbox;
  vm.runInNewContext(require('node:fs').readFileSync(require.resolve('../src/exam-model'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.PerflwExamModel.passMark, 'function');
});

test('time limit: the spec example, 50 single-choice items at difficulty 2, is 50 minutes', () => {
  assert.equal(m.examTimeLimit(many(50, () => q('choice'))), 50 * 60);
});

test('time limit: base times per type, difficulty factor, rounding up to 5 minutes', () => {
  assert.equal(m.itemSeconds(q('truefalse')), 45);
  assert.equal(m.itemSeconds(q('truefalse', 2, { requireJustification: true })), 135);
  assert.equal(m.itemSeconds(q('matching', 2, { pairs: [[1, 1], [2, 2], [3, 3]] })), 90);
  assert.equal(m.itemSeconds(q('explain')), 180);
  assert.equal(m.itemSeconds(q('essay', 2, { maxWords: 500 })), 600);
  // 3 choice at difficulty 1: 3 × 60 × 0.8 = 144 s → rounds up to 5 minutes.
  assert.equal(m.examTimeLimit(many(3, () => q('choice', 1))), 300);
  // difficulty 3: 10 × 60 × 1.3 = 780 s → 15 minutes.
  assert.equal(m.examTimeLimit(many(10, () => q('choice', 3))), 900);
  assert.equal(m.examTimeLimit([]), 300, 'never below one step');
});

test('time options (D16): ×1.5, ×2 and untimed; anything else is refused', () => {
  const items = many(50, () => q('choice'));
  assert.equal(m.examTimeLimit(items, { multiplier: 1.5 }), 4500);
  assert.equal(m.examTimeLimit(items, { multiplier: 2 }), 6000);
  assert.equal(m.examTimeLimit(items, { multiplier: 0 }), null);
  assert.throws(() => m.examTimeLimit(items, { multiplier: 3 }), /Choose a time option/);
});

test('pass mark: difficulty 1, 2, 3 give 75%, 82.5%, 90%; a mixed exam rounds to 0.5%', () => {
  assert.equal(m.passMark(many(4, () => q('choice', 1))), 0.75);
  assert.equal(m.passMark(many(4, () => q('choice', 2))), 0.825);
  assert.equal(m.passMark(many(4, () => q('choice', 3))), 0.9);
  // d̄ = 1.25 → 75% + 7.5% × 0.25 = 76.875% → rounds to 77%.
  assert.equal(m.passMark([q('choice', 1), q('choice', 1), q('choice', 1), q('choice', 2)]), 0.77);
  assert.equal(m.meanDifficulty([]), 2);
});

test('item count 50–100 is enforced unless it is a test final (D15)', () => {
  assert.throws(() => m.examConfigFor(many(49, () => q('choice'))), /50–100 questions \(this one would have 49\)/);
  assert.throws(() => m.examConfigFor(many(101, () => q('choice'))), /50–100/);
  const real = m.examConfigFor(many(50, () => q('choice')));
  assert.deepEqual(real, { examConfigVersion: 1, test: false, meanDifficulty: 2, passMark: 0.825, timeMultiplier: 1, timeLimitSeconds: 3000 });
  const small = m.examConfigFor(many(4, () => q('choice')), { test: true, multiplier: 0 });
  assert.equal(small.test, true); assert.equal(small.timeLimitSeconds, null);
});

test('result: passed at the pass mark, failed just below, time used from the attempt', () => {
  const attempt = { config: { passMark: 0.825, timeLimitSeconds: 3000 }, startedAt: '2026-11-24T10:00:00.000Z', submittedAt: '2026-11-24T10:41:40.000Z' };
  assert.deepEqual(m.examResult(attempt, 33, 40), { score: 33, max: 40, percent: 82.5, passMark: 0.825, passMarkPercent: 82.5, passed: true, timeUsedSeconds: 2500, timeLimitSeconds: 3000, test: false });
  assert.equal(m.examResult(attempt, 32, 40).passed, false);
  assert.equal(m.examResult({ config: {}, startedAt: null, submittedAt: null }, 1, 2).passed, null, 'no pass mark stored');
  assert.equal(m.examResult(attempt, 0, 0).percent, 0);
});

test('clock helpers take now as an argument: seconds left, and expiry after the grace period', () => {
  const attempt = { config: { timeLimitSeconds: 600 }, startedAt: '2026-11-24T10:00:00.000Z' };
  const at = s => Date.parse('2026-11-24T10:00:00.000Z') + s * 1000;
  assert.equal(m.secondsLeft(attempt, at(0)), 600);
  assert.equal(m.secondsLeft(attempt, at(540.4)), 60);
  assert.equal(m.secondsLeft(attempt, at(700)), 0);
  assert.equal(m.secondsLeft({ config: { timeLimitSeconds: null }, startedAt: attempt.startedAt }, at(10)), null, 'untimed');
  assert.equal(m.expired(attempt, at(602)), false, 'inside the 5 s grace');
  assert.equal(m.expired(attempt, at(606)), true);
  assert.equal(m.expired({ config: { timeLimitSeconds: null }, startedAt: attempt.startedAt }, at(99999)), false);
});

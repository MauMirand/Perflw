const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../src/mastery-model');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T09:00:00Z');
const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≉ ${expected}`);

// One graded answer; deterministic, final, diagnostic unless overridden.
const ans = (dimension, s, extra = {}) => ({
  dimension, kind: 'diagnostic', score: s, max: 1, gradeStatus: 'final', grader: 'auto', ...extra,
});
const many = (n, dimension, s, extra) => Array.from({ length: n }, () => ans(dimension, s, extra));
const level = (items, config) => M.topicLevel({ items }, config).level;
const withCfg = patch => Object.freeze({ ...M.DEFAULT_MASTERY_CONFIG, ...patch });

test('loads under require and as a browser global; defaults are frozen and versioned', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'mastery-model.js'), 'utf8');
  const sandbox = {}; sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  assert.equal(typeof sandbox.PerflwMasteryModel.topicLevel, 'function');
  for (const name of ['validateMasteryConfig', 'itemWeight', 'dimensionScores', 'topicLevel', 'improvement']) {
    assert.equal(typeof M[name], 'function', name);
  }
  const cfg = M.DEFAULT_MASTERY_CONFIG;
  assert.equal(cfg.version, 1);
  assert.ok(Object.isFrozen(cfg) && Object.isFrozen(cfg.kindWeight) && Object.isFrozen(cfg.mastered));
  assert.deepEqual({ ...cfg.kindWeight }, { diagnostic: 1, final: 1, retention: 1, practice: 0.5 });
  assert.deepEqual({ ...cfg.graderWeight }, { auto: 1, ai_accepted: 1, manual: 1, ai: 0.75, self: 0.75 });
  assert.deepEqual(M.validateMasteryConfig(cfg), { ok: true, value: cfg, errors: [] });
});

test('itemWeight: kind, grader, guess and recency factors', () => {
  const w = item => M.itemWeight(item).weight;
  assert.equal(w(ans('recall', 1)), 1);
  for (const kind of ['diagnostic', 'final', 'retention']) assert.equal(w(ans('recall', 1, { kind })), 1, kind);
  assert.equal(w(ans('recall', 1, { kind: 'practice' })), 0.5);
  for (const grader of ['auto', 'ai_accepted', 'manual']) assert.equal(w(ans('recall', 1, { grader })), 1, grader);
  assert.equal(w(ans('recall', 1, { grader: 'ai', gradeStatus: 'provisional', aiConfidence: 'high' })), 0.75);
  assert.equal(w(ans('recall', 1, { grader: 'self' })), 0.75);
  // guess weight: confidence 1 and correct only
  assert.equal(w(ans('recall', 1, { confidence: 1 })), 0.5);
  assert.equal(w(ans('recall', 0, { confidence: 1 })), 1);
  assert.equal(w(ans('recall', 0.5, { confidence: 1 })), 1, 'partial credit is not "correct"');
  assert.equal(w(ans('recall', 0.5, { confidence: 1, correct: true })), 0.5, 'explicit correct wins');
  assert.equal(w(ans('recall', 1, { confidence: 2 })), 1);
  assert.equal(w(ans('recall', 1, { confidence: 3 })), 1);
  // recency: half-life 30 days
  near(w(ans('recall', 1, { ageDays: 0 })), 1);
  near(w(ans('recall', 1, { ageDays: 30 })), 0.5);
  near(w(ans('recall', 1, { ageDays: 60 })), 0.25);
  near(w(ans('recall', 1, { answeredAt: new Date(T0).toISOString(), now: T0 + 15 * DAY })), Math.SQRT1_2);
  near(w(ans('recall', 1, { answeredAt: T0 + DAY, now: T0 })), 1); // future answers are not boosted
  assert.equal(w(ans('recall', 1, { answeredAt: T0 })), 1, 'no now → recency 1');
  // all factors multiply
  near(w(ans('recall', 1, { kind: 'practice', grader: 'self', confidence: 1, ageDays: 30 })), 0.5 * 0.75 * 0.5 * 0.5);
  const r = M.itemWeight(ans('recall', 1, { kind: 'practice', ageDays: 30 }));
  assert.equal(r.counted, true);
  assert.equal(r.configVersion, 1);
  assert.deepEqual(r.factors, { kind: 0.5, grader: 1, guess: 1, recency: 0.5 });
});

test('exclusions: pending, abandoned, low-confidence provisional AI, invalid rows', () => {
  const reason = item => M.itemWeight(item).reason;
  assert.equal(reason(ans('recall', 1, { gradeStatus: 'pending' })), 'not graded');
  assert.equal(reason(ans('recall', 1, { abandoned: true })), 'abandoned');
  assert.equal(reason(ans('recall', 1, { grader: 'ai', gradeStatus: 'provisional', aiConfidence: 'low' })), 'low-confidence AI grade');
  assert.equal(reason(ans('recall', 1, { grader: 'ai', gradeStatus: 'provisional', aiConfidence: 'medium' })), null);
  assert.equal(reason(ans('recall', 1, { grader: 'ai_accepted', aiConfidence: 'low' })), null, 'accepted → counts');
  assert.equal(reason(ans('memory', 1)), 'unknown dimension');
  assert.equal(reason(ans('recall', 1, { kind: 'quiz' })), 'unknown assessment kind');
  assert.equal(reason(ans('recall', 2)), 'invalid score');
  assert.equal(reason(ans('recall', 1, { max: 0 })), 'invalid score');
  assert.equal(reason(null), 'not an answer');
  const excluded = M.itemWeight(ans('recall', 1, { gradeStatus: 'pending' }));
  assert.deepEqual({ weight: excluded.weight, counted: excluded.counted }, { weight: 0, counted: false });

  const low = ans('recall', 0, { grader: 'ai', gradeStatus: 'provisional', aiConfidence: 'low' });
  const ds = M.dimensionScores({ items: [ans('recall', 1), ans('recall', 1), low] });
  assert.equal(ds.dimensions.recall.score, 1);
  assert.equal(ds.dimensions.recall.items, 2);
  assert.deepEqual(ds.excluded, [{ index: 2, reason: 'low-confidence AI grade' }]);
  // a custom config may count them
  const keep = withCfg({ excludeLowConfidenceAi: false });
  near(M.dimensionScores({ items: [ans('recall', 1), ans('recall', 1), low] }, keep).dimensions.recall.score, 2 / 2.75);
});

test('worked example (spec §5.4): Ionic bonds recall = 0.78', () => {
  const items = [
    ans('recall', 1, { max: 2 }),                                                          // diagnostic 1/2
    ans('recall', 1, { kind: 'practice' }),                                                // practice 1/1
    ans('recall', 3, { max: 3, kind: 'final', grader: 'ai', gradeStatus: 'provisional', aiConfidence: 'high' }),
  ].map(item => ({ ...item, ageDays: 2 })); // "recency ≈ 1 within days"
  const plain = items.map(({ ageDays, ...rest }) => rest);
  near(M.dimensionScores({ items: plain }).dimensions.recall.score, 1.75 / 2.25);
  const d = M.dimensionScores({ items }).dimensions.recall.score;
  assert.ok(Math.abs(d - 0.78) <= 0.005, `worked example ${d}`);
});

test('dimensionScores: a dimension needs ≥ 2 items; array evidence accepted; D11 scope not filtered', () => {
  const r = M.dimensionScores([ans('recall', 1), ans('understanding', 1), ans('understanding', 0)]);
  assert.equal(r.configVersion, 1);
  assert.equal(r.items, 3);
  assert.deepEqual(r.dimensions.recall, { score: null, items: 1, weight: 1 });
  assert.equal(r.dimensions.understanding.score, 0.5);
  assert.equal(r.dimensions.application.score, null);
  // the caller scopes to one journey: rows tagged with other journeys/topics are not filtered here
  const scoped = M.dimensionScores([ans('recall', 1, { journeyId: 'j1' }), ans('recall', 0, { journeyId: 'j2' })]);
  assert.equal(scoped.dimensions.recall.score, 0.5);
  assert.throws(() => M.dimensionScores({}), /list of answers/);
  assert.throws(() => M.topicLevel(null), /list of answers/);
});

test('level boundary: Not assessed below 3 counted items', () => {
  assert.equal(level([]), 'not_assessed');
  assert.equal(level(many(2, 'recognition', 1)), 'not_assessed');
  assert.equal(level([...many(2, 'recognition', 1), ans('recall', 1, { gradeStatus: 'pending' })]), 'not_assessed');
  assert.equal(level(many(3, 'recognition', 1)), 'emerging');
  assert.equal(level(many(4, 'recognition', 0)), 'emerging');
});

test('level boundary: Developing (Recognition ≥ 0.6 and Recall or Understanding ≥ 0.4)', () => {
  const set = (rec, other, dim = 'recall') => [...many(2, 'recognition', rec), ...many(2, dim, other)];
  assert.equal(level(set(0.59, 0.4)), 'emerging');
  assert.equal(level(set(0.6, 0.4)), 'developing');
  assert.equal(level(set(0.61, 0.4)), 'developing');
  assert.equal(level(set(0.6, 0.39)), 'emerging');
  assert.equal(level(set(0.6, 0.41)), 'developing');
  assert.equal(level(set(0.6, 0.39, 'understanding')), 'emerging');
  assert.equal(level(set(0.6, 0.4, 'understanding')), 'developing');
  assert.equal(level(set(0.6, 0.4, 'application')), 'emerging', 'application does not stand in for recall');
  // recall with one item = no evidence
  assert.equal(level([...many(2, 'recognition', 1), ans('recall', 1), ans('application', 1)]), 'emerging');
});

test('level boundary: Proficient (Recall ≥ 0.7, Understanding ≥ 0.6, ≥ 6 items)', () => {
  const set = (recall, under) => [...many(2, 'recognition', 1), ...many(2, 'recall', recall), ...many(2, 'understanding', under)];
  assert.equal(level(set(0.69, 0.6)), 'developing');
  assert.equal(level(set(0.7, 0.6)), 'proficient');
  assert.equal(level(set(0.71, 0.6)), 'proficient');
  assert.equal(level(set(0.7, 0.59)), 'developing');
  assert.equal(level(set(0.7, 0.61)), 'proficient');
  // item count: 5 counted → not Proficient, 6 → Proficient
  const five = [ans('recognition', 1), ...many(2, 'recall', 1), ...many(2, 'understanding', 1)];
  assert.equal(level(five), 'emerging');
  assert.equal(level([...five, ans('application', 0)]), 'proficient');
});

// Proficient base + finals + a retention check; every knob for Mastered is a parameter.
function masteredCase({ finalPoints = 40, retentionRecall = 1, retentionAfterDays = 7, provisional = false } = {}) {
  const at = days => T0 + days * DAY;
  return {
    now: at(20),
    items: [
      ...many(2, 'recognition', 1, { answeredAt: at(0) }),
      ...many(2, 'understanding', 1, { answeredAt: at(0) }),
      ...many(2, 'recall', 1, { answeredAt: at(0) }),
      // final: two recall items worth 50 points each → topic final score = 2·finalPoints / 100
      ...many(2, 'recall', finalPoints, { kind: 'final', max: 50, answeredAt: at(1) }),
      ...(provisional ? [ans('understanding', 1, { kind: 'final', grader: 'ai', gradeStatus: 'provisional', aiConfidence: 'high', answeredAt: at(1) })] : []),
      ...many(2, 'recall', retentionRecall, { kind: 'retention', answeredAt: at(1 + retentionAfterDays) }),
    ],
  };
}

test('level boundary: Mastered (final ≥ 0.8, retention ≥ 7 days with Recall ≥ 0.7, all grades final)', () => {
  const lv = opts => M.topicLevel(masteredCase(opts));
  const ok = lv();
  assert.equal(ok.level, 'mastered');
  assert.equal(ok.finalScore, 0.8);
  assert.equal(ok.retention.recall.score, 1);
  assert.equal(ok.retention.lastPractisedAt, T0 + DAY);
  // final topic score
  assert.equal(lv({ finalPoints: 39.5 }).level, 'proficient');
  assert.equal(lv({ finalPoints: 39.5 }).finalScore, 0.79);
  assert.equal(lv({ finalPoints: 40.5 }).level, 'mastered');
  // retention gap: 6.99 days is too soon, 7 and 7.01 count
  assert.equal(lv({ retentionAfterDays: 6.99 }).level, 'proficient');
  assert.equal(lv({ retentionAfterDays: 6.99 }).retention.recall.score, null);
  assert.equal(lv({ retentionAfterDays: 7.01 }).level, 'mastered');
  // retention recall
  assert.equal(lv({ retentionRecall: 0.69 }).level, 'proficient');
  assert.equal(lv({ retentionRecall: 0.7 }).level, 'mastered');
  assert.equal(lv({ retentionRecall: 0.71 }).level, 'mastered');
  // a provisional open answer blocks Mastered until it is final
  const prov = lv({ provisional: true });
  assert.equal(prov.allFinal, false);
  assert.equal(prov.level, 'proficient');
  // no retention check at all
  const c = masteredCase(); c.items = c.items.filter(i => i.kind !== 'retention');
  assert.equal(M.topicLevel(c).level, 'proficient');
  // an explicit lastPractisedAt (e.g. a later study session) moves the 7-day window
  assert.equal(M.topicLevel({ ...masteredCase(), lastPractisedAt: T0 + 3 * DAY }).level, 'proficient');
});

test('cap rule: recognition-only evidence never goes above Developing', () => {
  const r = M.topicLevel({ items: many(20, 'recognition', 1) });
  assert.equal(r.recognitionOnly, true);
  assert.ok(M.LEVELS.indexOf(r.level) <= M.LEVELS.indexOf('developing'), r.level);
  // even with finals and retention answered, as long as only recognition has evidence
  const items = [...many(10, 'recognition', 1, { kind: 'final' }), ...many(4, 'recognition', 1, { kind: 'retention' })];
  assert.ok(M.LEVELS.indexOf(level(items)) <= M.LEVELS.indexOf('developing'));
  assert.equal(M.topicLevel({ items: [...many(2, 'recognition', 1), ...many(2, 'recall', 1)] }).recognitionOnly, false);
});

test('improvement: final D minus diagnostic D, only when both sides have ≥ 2 items', () => {
  const items = [
    ...many(2, 'recall', 0.5), ...many(2, 'recall', 1, { kind: 'final' }),
    ...many(2, 'understanding', 0.25), ans('understanding', 1, { kind: 'final' }),
    ...many(3, 'recognition', 1, { kind: 'practice' }),
  ];
  const r = M.improvement({ items });
  assert.equal(r.configVersion, 1);
  assert.deepEqual(r.dimensions.recall, { diagnostic: 0.5, final: 1, delta: 0.5 });
  assert.deepEqual(r.dimensions.understanding, { diagnostic: null, final: null, delta: null });
  assert.deepEqual(r.dimensions.recognition, { diagnostic: null, final: null, delta: null }, 'practice is neither side');
});

test('results carry configVersion; a custom config changes the outcome', () => {
  const worked = [
    ans('recall', 1, { max: 2 }), ans('recall', 1, { kind: 'practice' }),
    ans('recall', 3, { max: 3, kind: 'final', grader: 'ai', gradeStatus: 'provisional', aiConfidence: 'high' }),
  ];
  const custom = withCfg({ version: 'tuned-2026-12', kindWeight: Object.freeze({ ...M.DEFAULT_MASTERY_CONFIG.kindWeight, practice: 1 }) });
  const r = M.dimensionScores({ items: worked }, custom);
  assert.equal(r.configVersion, 'tuned-2026-12');
  near(r.dimensions.recall.score, 2.25 / 2.75);
  assert.equal(M.topicLevel({ items: worked }, custom).configVersion, 'tuned-2026-12');
  assert.equal(M.improvement({ items: worked }, custom).configVersion, 'tuned-2026-12');
  assert.equal(M.itemWeight(worked[1], custom).weight, 1);

  const devSet = [...many(2, 'recognition', 0.55), ...many(2, 'recall', 0.5)];
  assert.equal(level(devSet), 'emerging');
  assert.equal(level(devSet, withCfg({ developing: { recognition: 0.5, recallOrUnderstanding: 0.4 } })), 'developing');
  assert.equal(level(many(2, 'recognition', 1)), 'not_assessed');
  assert.equal(level(many(2, 'recognition', 1), withCfg({ minAssessedItems: 2, minDimensionItems: 2 })), 'emerging');
  // half-life 60: a 30-day-old answer keeps 2^-0.5 of its weight
  near(M.itemWeight(ans('recall', 1, { ageDays: 30 }), withCfg({ recencyHalfLifeDays: 60 })).weight, Math.SQRT1_2);
  // a mutable custom config also works (re-validated on each call)
  const mutable = { ...M.DEFAULT_MASTERY_CONFIG, version: 2 };
  assert.equal(M.dimensionScores([], mutable).configVersion, 2);
});

test('validateMasteryConfig rejects out-of-range and inconsistent settings', () => {
  const D = M.DEFAULT_MASTERY_CONFIG;
  const errs = patch => M.validateMasteryConfig({ ...D, ...patch }).errors;
  const has = (patch, re) => assert.ok(errs(patch).some(e => re.test(e)), `${JSON.stringify(patch)} → ${errs(patch)}`);
  assert.deepEqual(M.validateMasteryConfig('x').errors, ['config: must be an object.']);
  has({ proficient: { recall: 0.3, understanding: 0.6, minItems: 6 } }, /^proficient\.recall: must not be below developing/);
  has({ proficient: { recall: 0.7, understanding: 0.3, minItems: 6 } }, /^proficient\.understanding: must not be below/);
  has({ mastered: { finalScore: 0.8, retentionDays: 7, retentionRecall: 0.5 } }, /^mastered\.retentionRecall: must not be below proficient/);
  has({ proficient: { recall: 0.7, understanding: 0.6, minItems: 2 } }, /^proficient\.minItems: must not be below minAssessedItems/);
  has({ minDimensionItems: 5 }, /^minDimensionItems: must not be above/);
  has({ developing: { recognition: 1.2, recallOrUnderstanding: 0.4 } }, /^developing\.recognition: must be a number from 0 to 1/);
  has({ developing: { recognition: -0.1, recallOrUnderstanding: 0.4 } }, /^developing\.recognition:/);
  has({ developing: { recognition: '0.6', recallOrUnderstanding: 0.4 } }, /^developing\.recognition:/);
  has({ developing: { recognition: 0.6 } }, /^developing\.recallOrUnderstanding:/);
  has({ developing: { recognition: 0.6, recallOrUnderstanding: 0.4, extra: 1 } }, /^developing\.extra: is not a known setting/);
  has({ kindWeight: { ...D.kindWeight, practice: 2 } }, /^kindWeight\.practice:/);
  has({ kindWeight: { diagnostic: 0, final: 0, retention: 0, practice: 0 } }, /^kindWeight: needs at least one/);
  has({ graderWeight: { ...D.graderWeight, self: NaN } }, /^graderWeight\.self:/);
  has({ guess: { confidence: 4, weight: 0.5 } }, /^guess\.confidence:/);
  has({ recencyHalfLifeDays: 0 }, /^recencyHalfLifeDays:/);
  has({ minAssessedItems: 0 }, /^minAssessedItems:/);
  has({ mastered: { finalScore: 0.8, retentionDays: -1, retentionRecall: 0.7 } }, /^mastered\.retentionDays:/);
  has({ excludeLowConfidenceAi: 'yes' }, /^excludeLowConfidenceAi:/);
  has({ recognitionOnlyCap: 'not_assessed' }, /^recognitionOnlyCap:/);
  has({ version: 0 }, /^version:/);
  has({ version: '' }, /^version:/);
  has({ thresholds: {} }, /^thresholds: is not a known setting/);
  has({ proficient: undefined }, /^proficient: is required/);
  // edge values that are allowed
  assert.equal(M.validateMasteryConfig({ ...D, version: 'v2', developing: { recognition: 0, recallOrUnderstanding: 0 } }).ok, true);
  // every function refuses an invalid config with a plain message
  const bad = { ...D, recencyHalfLifeDays: -1 };
  for (const fn of [M.dimensionScores, M.topicLevel, M.improvement]) {
    assert.throws(() => fn({ items: [] }, bad), /Invalid mastery config — recencyHalfLifeDays:/);
  }
  assert.throws(() => M.itemWeight(ans('recall', 1), bad), /Invalid mastery config/);
});

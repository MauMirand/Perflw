'use strict';
/* Mastery model — evidence-based topic mastery. Pure logic: no DOM, no Electron, no database, no clock, no AI.
   Loaded by the main process and the tests (require) and, later, by the renderer (script tag →
   window.PerflwMasteryModel). Spec: docs/LEARNING_SYSTEM_SPEC.md §5.1, §5.4 (incl. D11), §4.4; D4, D14.

   One-cycle scope (D11): the caller passes the answers of ONE topic in ONE journey (cycle). This module never
   filters by journey, subject or topic; it trusts the caller's scope.

   Evidence item (one graded answer, shaped like an `assessment_answers` row joined with its item and assessment):
     { dimension: 'recognition'|'recall'|'understanding'|'application',
       kind: 'diagnostic'|'practice'|'final'|'retention',
       score: number, max: number > 0,
       gradeStatus: 'pending'|'provisional'|'final',
       grader: 'auto'|'ai'|'ai_accepted'|'self'|'manual',
       aiConfidence?: 'low'|'medium'|'high',      the AI grader's confidence (§4.4)
       confidence?: 1|2|3,                        the student's own confidence (guess weight)
       correct?: boolean,                         default: score === max
       answeredAt?: ms number or ISO string,      with `now`, gives the age for recency
       ageDays?: number,                          wins over answeredAt/now when given
       abandoned?: boolean }                      true when its assessment was abandoned
   Without an age (no ageDays, or no answeredAt/now), recency is 1. `now` is never read from the clock: the caller
   passes it, so results are reproducible.

   Every function takes `(evidence, config = DEFAULT_MASTERY_CONFIG)`. A custom config must be complete and pass
   `validateMasteryConfig`; otherwise the function throws a plain-language Error. Every result carries
   `configVersion` so a stored report stays explainable after the defaults change (D4). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwMasteryModel = factory();
})(globalThis, function () {

const DIMENSIONS = Object.freeze(['recognition', 'recall', 'understanding', 'application']);
const KINDS = Object.freeze(['diagnostic', 'practice', 'final', 'retention']);
const GRADERS = Object.freeze(['auto', 'ai', 'ai_accepted', 'self', 'manual']);
const COUNTED_STATUSES = Object.freeze(['provisional', 'final']);
const LEVELS = Object.freeze(['not_assessed', 'emerging', 'developing', 'proficient', 'mastered']);
const DAY_MS = 24 * 60 * 60 * 1000;

const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

/* Spec §5.4 values (D4: initial defaults, tuned only by a reviewed code change with updated boundary tests). */
const DEFAULT_MASTERY_CONFIG = deepFreeze({
  version: 1,
  kindWeight: { diagnostic: 1.0, final: 1.0, retention: 1.0, practice: 0.5 },
  graderWeight: { auto: 1.0, ai_accepted: 1.0, manual: 1.0, ai: 0.75, self: 0.75 },
  guess: { confidence: 1, weight: 0.5 },          // a correct answer given with confidence 1 counts half
  recencyHalfLifeDays: 30,                         // recency = 0.5 ^ (ageDays / 30)
  excludeLowConfidenceAi: true,                    // provisional AI grades with confidence 'low' do not count
  minDimensionItems: 2,                            // a dimension with fewer items has "no evidence"
  minAssessedItems: 3,                             // fewer counted items on the topic → Not assessed
  developing: { recognition: 0.6, recallOrUnderstanding: 0.4 },
  proficient: { recall: 0.7, understanding: 0.6, minItems: 6 },
  mastered: { finalScore: 0.8, retentionDays: 7, retentionRecall: 0.7 },
  recognitionOnlyCap: 'developing',                // recognition-only evidence never goes above this level
});

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// ───────── config validation
const SHAPE = {
  kindWeight: KINDS, graderWeight: GRADERS, guess: ['confidence', 'weight'],
  developing: ['recognition', 'recallOrUnderstanding'], proficient: ['recall', 'understanding', 'minItems'],
  mastered: ['finalScore', 'retentionDays', 'retentionRecall'],
};
const TOP_KEYS = ['version', ...Object.keys(SHAPE), 'recencyHalfLifeDays', 'excludeLowConfidenceAi',
  'minDimensionItems', 'minAssessedItems', 'recognitionOnlyCap'];

/* → { ok, value, errors[] }. `value` is the config itself when ok, else null. Errors read
   "<field path>: <plain-language problem>.", as in assessment-model.js. */
function validateMasteryConfig(config) {
  const errors = [];
  const fail = (field, message) => { errors.push(`${field}: ${message}`); };
  if (!isObj(config)) return { ok: false, value: null, errors: ['config: must be an object.'] };

  for (const k of Object.keys(config)) if (!TOP_KEYS.includes(k)) fail(k, 'is not a known setting.');
  for (const [group, keys] of Object.entries(SHAPE)) {
    if (!isObj(config[group])) { fail(group, 'is required and must be an object.'); continue; }
    for (const k of Object.keys(config[group])) if (!keys.includes(k)) fail(`${group}.${k}`, 'is not a known setting.');
  }
  const get = path => path.split('.').reduce((o, k) => (isObj(o) ? o[k] : undefined), config);
  const share = path => {
    const v = get(path);
    if (!isNum(v) || v < 0 || v > 1) { fail(path, 'must be a number from 0 to 1.'); return null; }
    return v;
  };
  const whole = (path, min, max = 1000) => {
    const v = get(path);
    if (!Number.isInteger(v) || v < min || v > max) { fail(path, `must be a whole number from ${min} to ${max}.`); return null; }
    return v;
  };

  const version = config.version;
  if (!((Number.isInteger(version) && version >= 1) || (typeof version === 'string' && version.trim() && version.length <= 50))) {
    fail('version', 'is required: a whole number ≥ 1 or text of 1–50 characters.');
  }
  if (isObj(config.kindWeight)) {
    const w = KINDS.map(k => share(`kindWeight.${k}`));
    if (w.every(v => v === 0)) fail('kindWeight', 'needs at least one weight above 0.');
  }
  if (isObj(config.graderWeight)) GRADERS.forEach(k => share(`graderWeight.${k}`));
  if (isObj(config.guess)) { whole('guess.confidence', 1, 3); share('guess.weight'); }
  const half = config.recencyHalfLifeDays;
  if (!isNum(half) || half <= 0 || half > 3650) fail('recencyHalfLifeDays', 'must be a number above 0 and at most 3650.');
  if (typeof config.excludeLowConfidenceAi !== 'boolean') fail('excludeLowConfidenceAi', 'must be true or false.');
  const minDim = whole('minDimensionItems', 1, 100);
  const minAssessed = whole('minAssessedItems', 1, 1000);
  if (!LEVELS.includes(config.recognitionOnlyCap) || config.recognitionOnlyCap === 'not_assessed') {
    fail('recognitionOnlyCap', `must be one of ${LEVELS.slice(1).join(', ')}.`);
  }

  const dev = isObj(config.developing) ? [share('developing.recognition'), share('developing.recallOrUnderstanding')] : [null, null];
  const pro = isObj(config.proficient)
    ? [share('proficient.recall'), share('proficient.understanding'), whole('proficient.minItems', 1, 1000)] : [null, null, null];
  const mas = isObj(config.mastered)
    ? [share('mastered.finalScore'), (() => {
      const v = config.mastered.retentionDays;
      if (!isNum(v) || v < 0 || v > 365) { fail('mastered.retentionDays', 'must be a number from 0 to 365.'); return null; }
      return v;
    })(), share('mastered.retentionRecall')] : [null, null, null];

  // Consistency: a higher level must never be easier to reach than the one below it.
  const [, devRU] = dev; const [proRecall, proUnder, proItems] = pro; const [, , masRecall] = mas;
  if (devRU !== null && proRecall !== null && proRecall < devRU) fail('proficient.recall', 'must not be below developing.recallOrUnderstanding (Proficient would be easier than Developing).');
  if (devRU !== null && proUnder !== null && proUnder < devRU) fail('proficient.understanding', 'must not be below developing.recallOrUnderstanding (Proficient would be easier than Developing).');
  if (proRecall !== null && masRecall !== null && masRecall < proRecall) fail('mastered.retentionRecall', 'must not be below proficient.recall (Mastered would be easier than Proficient).');
  if (minAssessed !== null && proItems !== null && proItems < minAssessed) fail('proficient.minItems', 'must not be below minAssessedItems.');
  if (minDim !== null && minAssessed !== null && minDim > minAssessed) fail('minDimensionItems', 'must not be above minAssessedItems.');

  return errors.length ? { ok: false, value: null, errors } : { ok: true, value: config, errors: [] };
}

const valid = new WeakSet([DEFAULT_MASTERY_CONFIG]);
function useConfig(config) {
  if (config === undefined) return DEFAULT_MASTERY_CONFIG;
  if (isObj(config) && valid.has(config)) return config;
  const r = validateMasteryConfig(config);
  if (!r.ok) throw new Error(`Invalid mastery config — ${r.errors.join(' ')}`);
  if (Object.isFrozen(config)) valid.add(config); // a mutable config is re-checked on every call
  return config;
}

// ───────── evidence
function toMs(v) {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim()) { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

/* Why an answer is left out of mastery, or null when it counts (§5.4: graded, non-abandoned, low-confidence
   provisional AI grades excluded until accepted). */
function exclusion(item, cfg) {
  if (!isObj(item)) return 'not an answer';
  if (!DIMENSIONS.includes(item.dimension)) return 'unknown dimension';
  if (!KINDS.includes(item.kind)) return 'unknown assessment kind';
  if (item.abandoned === true) return 'abandoned';
  if (!COUNTED_STATUSES.includes(item.gradeStatus)) return 'not graded';
  if (!GRADERS.includes(item.grader)) return 'unknown grader';
  if (!isNum(item.max) || item.max <= 0 || !isNum(item.score) || item.score < 0 || item.score > item.max) return 'invalid score';
  if (cfg.excludeLowConfidenceAi && item.grader === 'ai' && item.gradeStatus === 'provisional' && item.aiConfidence === 'low') {
    return 'low-confidence AI grade';
  }
  return null;
}

function ageDays(item, now) {
  if (isNum(item.ageDays)) return Math.max(0, item.ageDays);
  const at = toMs(item.answeredAt); const n = toMs(now);
  return at === null || n === null ? null : Math.max(0, (n - at) / DAY_MS);
}

/* Weight of one counted answer; `now` comes from the evidence object (or the answer itself). */
function weigh(item, now, cfg) {
  const s = item.score / item.max;
  const correct = typeof item.correct === 'boolean' ? item.correct : s >= 1;
  const age = ageDays(item, now);
  const factors = {
    kind: cfg.kindWeight[item.kind],
    grader: cfg.graderWeight[item.grader],
    guess: item.confidence === cfg.guess.confidence && correct ? cfg.guess.weight : 1,
    recency: age === null ? 1 : Math.pow(0.5, age / cfg.recencyHalfLifeDays),
  };
  return { s, weight: factors.kind * factors.grader * factors.guess * factors.recency, factors, ageDays: age };
}

/* `evidence` = { items: [answer], now? } or a plain array of answers. */
function itemsOf(evidence) {
  if (Array.isArray(evidence)) return { items: evidence, now: undefined };
  if (isObj(evidence) && Array.isArray(evidence.items)) return { items: evidence.items, now: evidence.now };
  throw new Error('Mastery evidence must be a list of answers or { items: [...] }.');
}

function counted(items, now, cfg) {
  const out = []; const excluded = [];
  items.forEach((item, index) => {
    const reason = exclusion(item, cfg);
    if (reason) excluded.push({ index, reason });
    else out.push({ item, ...weigh(item, now, cfg) });
  });
  return { rows: out, excluded };
}

/* D = Σ(w·s) / Σw over rows with ≥ minDimensionItems; otherwise score null ("no evidence"). */
function dimension(rows, cfg) {
  const sumW = rows.reduce((t, r) => t + r.weight, 0);
  const enough = rows.length >= cfg.minDimensionItems && sumW > 0;
  return { score: enough ? rows.reduce((t, r) => t + r.weight * r.s, 0) / sumW : null, items: rows.length, weight: sumW };
}
function byDimension(rows, cfg) {
  const out = {};
  for (const d of DIMENSIONS) out[d] = dimension(rows.filter(r => r.item.dimension === d), cfg);
  return out;
}

// ───────── public API

/* One answer → { counted, reason, weight, factors: { kind, grader, guess, recency }, ageDays, configVersion }.
   `evidence` is the answer; it may carry `now`. An excluded answer has weight 0 and a reason. */
function itemWeight(evidence, config = DEFAULT_MASTERY_CONFIG) {
  const cfg = useConfig(config);
  const reason = exclusion(evidence, cfg);
  if (reason) return { counted: false, reason, weight: 0, factors: null, ageDays: null, configVersion: cfg.version };
  const { weight, factors, ageDays: age } = weigh(evidence, evidence.now, cfg);
  return { counted: true, reason: null, weight, factors, ageDays: age, configVersion: cfg.version };
}

/* Answers of one topic in one cycle → { configVersion, items, excluded: [{ index, reason }],
   dimensions: { recognition|recall|understanding|application: { score: 0…1 | null, items, weight } } }. */
function dimensionScores(evidence, config = DEFAULT_MASTERY_CONFIG) {
  const cfg = useConfig(config);
  const { items, now } = itemsOf(evidence);
  const { rows, excluded } = counted(items, now, cfg);
  return { configVersion: cfg.version, items: rows.length, excluded, dimensions: byDimension(rows, cfg) };
}

/* Retention (§5.1): recall/understanding answers in a `retention` assessment taken ≥ retentionDays after the
   topic was last practised (latest non-retention answer, or `evidence.lastPractisedAt` when given). */
function retentionCheck(rows, lastPractisedAt, cfg) {
  const last = toMs(lastPractisedAt) ?? rows.filter(r => r.item.kind !== 'retention')
    .map(r => toMs(r.item.answeredAt)).filter(t => t !== null).reduce((a, b) => Math.max(a, b), -Infinity);
  if (!Number.isFinite(last)) return { recall: dimension([], cfg), understanding: dimension([], cfg), lastPractisedAt: null };
  const late = rows.filter(r => {
    if (r.item.kind !== 'retention') return false;
    const at = toMs(r.item.answeredAt);
    return at !== null && at - last >= cfg.mastered.retentionDays * DAY_MS;
  });
  return {
    recall: dimension(late.filter(r => r.item.dimension === 'recall'), cfg),
    understanding: dimension(late.filter(r => r.item.dimension === 'understanding'), cfg),
    lastPractisedAt: last,
  };
}

const atLeast = (d, t) => d.score !== null && d.score >= t;

/* Answers of one topic in one cycle → { level, configVersion, items, excluded, dimensions, finalScore,
   retention, recognitionOnly, allFinal }. `evidence` = { items, now?, lastPractisedAt? }.
   Levels (§5.4): not_assessed < emerging < developing < proficient < mastered. */
function topicLevel(evidence, config = DEFAULT_MASTERY_CONFIG) {
  const cfg = useConfig(config);
  const { items, now } = itemsOf(evidence);
  const { rows, excluded } = counted(items, now, cfg);
  const dims = byDimension(rows, cfg);
  const finals = rows.filter(r => r.item.kind === 'final');
  const finalMax = finals.reduce((t, r) => t + r.item.max, 0);
  // D14: the topic's share of its final-exam points, unweighted (separate from the exam pass mark).
  const finalScore = finalMax > 0 ? finals.reduce((t, r) => t + r.item.score, 0) / finalMax : null;
  const retention = retentionCheck(rows, isObj(evidence) ? evidence.lastPractisedAt : undefined, cfg);
  const recognitionOnly = rows.length > 0 && dims.recall.score === null && dims.understanding.score === null
    && dims.application.score === null;
  const allFinal = rows.every(r => r.item.gradeStatus === 'final');

  let level = 'not_assessed';
  if (rows.length >= cfg.minAssessedItems) {
    level = 'emerging';
    const { developing: dv, proficient: pf, mastered: ms } = cfg;
    if (atLeast(dims.recognition, dv.recognition)
      && (atLeast(dims.recall, dv.recallOrUnderstanding) || atLeast(dims.understanding, dv.recallOrUnderstanding))) {
      level = 'developing';
    }
    if (atLeast(dims.recall, pf.recall) && atLeast(dims.understanding, pf.understanding) && rows.length >= pf.minItems) {
      level = 'proficient';
      if (finalScore !== null && finalScore >= ms.finalScore && atLeast(retention.recall, ms.retentionRecall) && allFinal) {
        level = 'mastered';
      }
    }
    if (recognitionOnly && LEVELS.indexOf(level) > LEVELS.indexOf(cfg.recognitionOnlyCap)) level = cfg.recognitionOnlyCap;
  }
  return {
    level, configVersion: cfg.version, items: rows.length, excluded, dimensions: dims, finalScore, retention,
    recognitionOnly, allFinal,
  };
}

/* §5.4 rule 6: per dimension, final-exam D minus diagnostic D; null unless both sides have ≥ minDimensionItems.
   → { configVersion, dimensions: { <dim>: { diagnostic, final, delta } } } (all three null when not shown). */
function improvement(evidence, config = DEFAULT_MASTERY_CONFIG) {
  const cfg = useConfig(config);
  const { items, now } = itemsOf(evidence);
  const { rows } = counted(items, now, cfg);
  const pre = byDimension(rows.filter(r => r.item.kind === 'diagnostic'), cfg);
  const post = byDimension(rows.filter(r => r.item.kind === 'final'), cfg);
  const dimensions = {};
  for (const d of DIMENSIONS) {
    const shown = pre[d].score !== null && post[d].score !== null;
    dimensions[d] = shown
      ? { diagnostic: pre[d].score, final: post[d].score, delta: post[d].score - pre[d].score }
      : { diagnostic: null, final: null, delta: null };
  }
  return { configVersion: cfg.version, dimensions };
}

return {
  DIMENSIONS, KINDS, GRADERS, LEVELS, DEFAULT_MASTERY_CONFIG,
  validateMasteryConfig, itemWeight, dimensionScores, topicLevel, improvement,
};
});

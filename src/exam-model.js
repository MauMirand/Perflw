'use strict';
/* Final-exam rules (spec §4.9, D10, D15, D16): item count, time limit, pass mark, result. Pure logic: no I/O, no clock, no
   DOM. Loaded by the main process and the tests (require) and by the renderer (window.PerflwExamModel).
   Every number lives in the frozen, versioned DEFAULT_EXAM_CONFIG, so a stored result stays explainable after a change. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwExamModel = factory();
})(globalThis, function () {

const DEFAULT_EXAM_CONFIG = Object.freeze({
  version: 1,
  items: Object.freeze({ min: 50, max: 100 }),           // D10: the student picks 50–100 (a small test final is allowed, D15)
  baseSeconds: Object.freeze({ choice: 60, truefalse: 45, matchingPerPair: 30, explain: 180, essayPer50Words: 60 }),
  justificationSeconds: 90,                              // added to a true/false that asks for a justification
  difficultyFactor: Object.freeze({ 1: 0.8, 2: 1.0, 3: 1.3 }),
  roundMinutes: 5,                                       // the limit is rounded up to 5 minutes
  passMark: Object.freeze({ base: 0.75, perDifficultyStep: 0.075, rounding: 0.005 }),
  multipliers: Object.freeze([1, 1.5, 2, 0]),            // D16: ×1, ×1.5, ×2, or 0 = untimed (WCAG 2.2.1)
  warningsSeconds: Object.freeze([300, 60]),             // announced politely at 5 and 1 minute left
  graceSeconds: 5,                                       // saves this long after the deadline are still accepted
});

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const DIFFICULTIES = [1, 2, 3];

/* Seconds one question is worth in the time limit, before the difficulty factor. */
function itemSeconds(question, config = DEFAULT_EXAM_CONFIG) {
  const base = config.baseSeconds;
  const p = (question && question.payload) || {};
  switch (question && question.type) {
    case 'choice': return base.choice;
    case 'truefalse': return base.truefalse + (p.requireJustification ? config.justificationSeconds : 0);
    case 'matching': return base.matchingPerPair * Math.max(1, (p.pairs || []).length);
    case 'explain': return base.explain;
    case 'essay': return base.essayPer50Words * Math.max(1, Math.ceil((isNum(p.maxWords) ? p.maxWords : 500) / 50));
    default: return base.choice;
  }
}

/* Mean `difficulty` (1–3) of the exam's items: d̄. Items without a valid difficulty count as 2. */
function meanDifficulty(questions) {
  if (!Array.isArray(questions) || !questions.length) return 2;
  const sum = questions.reduce((t, q) => t + (DIFFICULTIES.includes(q && q.difficulty) ? q.difficulty : 2), 0);
  return sum / questions.length;
}

/* Time limit in seconds: Σ base time × difficulty factor, rounded up to 5 minutes, times the student's multiplier
   (D16). multiplier 0 = untimed → null. */
function examTimeLimit(questions, { multiplier = 1, config = DEFAULT_EXAM_CONFIG } = {}) {
  if (multiplier === 0) return null;
  if (!config.multipliers.includes(multiplier)) throw new Error('Choose a time option: normal, ×1.5, ×2 or untimed.');
  const total = (questions || []).reduce((t, q) => {
    const factor = config.difficultyFactor[DIFFICULTIES.includes(q && q.difficulty) ? q.difficulty : 2];
    return t + itemSeconds(q, config) * factor;
  }, 0);
  const step = config.roundMinutes * 60;
  const rounded = Math.max(step, Math.ceil(total / step) * step);
  return Math.round(rounded * multiplier);
}

/* Pass mark as a share 0…1: 75% + 7.5% × (d̄ − 1), rounded to the nearest 0.5%. d̄ 1 → 0.75, 2 → 0.825, 3 → 0.9. */
function passMark(questions, config = DEFAULT_EXAM_CONFIG) {
  const { base, perDifficultyStep, rounding } = config.passMark;
  const raw = base + perDifficultyStep * (meanDifficulty(questions) - 1);
  return Math.round(Math.round(raw / rounding) * rounding * 1000) / 1000;
}

/* What the attempt stores in its `config` when it is created. */
function examConfigFor(questions, { multiplier = 1, test = false, config = DEFAULT_EXAM_CONFIG } = {}) {
  const count = (questions || []).length;
  if (!test && (count < config.items.min || count > config.items.max)) {
    throw new Error(`A final exam has ${config.items.min}–${config.items.max} questions (this one would have ${count}). Choose a test final for a smaller practice run.`);
  }
  const limit = examTimeLimit(questions, { multiplier, config });
  return {
    examConfigVersion: config.version, test: Boolean(test), meanDifficulty: Math.round(meanDifficulty(questions) * 1000) / 1000,
    passMark: passMark(questions, config), timeMultiplier: multiplier, timeLimitSeconds: limit,
  };
}

/* Pass/fail of a submitted exam. `attempt` = { config, startedAt, submittedAt }, `score`/`max` in points. */
function examResult({ config, startedAt, submittedAt }, score, max) {
  const share = max > 0 ? score / max : 0;
  const mark = isNum(config && config.passMark) ? config.passMark : null;
  const used = startedAt && submittedAt ? Math.max(0, Math.round((Date.parse(submittedAt) - Date.parse(startedAt)) / 1000)) : null;
  return {
    score, max, percent: Math.round(share * 1000) / 10, passMark: mark, passMarkPercent: mark === null ? null : Math.round(mark * 1000) / 10,
    passed: mark === null ? null : share >= mark - 1e-9, timeUsedSeconds: used, timeLimitSeconds: config ? config.timeLimitSeconds ?? null : null,
    test: Boolean(config && config.test),
  };
}

/* Seconds left, or null when untimed. `now` is passed in (never read here). */
function secondsLeft({ config, startedAt }, now) {
  if (!config || !isNum(config.timeLimitSeconds) || !startedAt) return null;
  return Math.max(0, Math.ceil(config.timeLimitSeconds - (now - Date.parse(startedAt)) / 1000));
}
/* True once the deadline plus the grace period has passed. */
function expired(attempt, now, grace = DEFAULT_EXAM_CONFIG.graceSeconds) {
  const left = secondsLeft(attempt, now - grace * 1000);
  return left === 0;
}

return { DEFAULT_EXAM_CONFIG, itemSeconds, meanDifficulty, examTimeLimit, passMark, examConfigFor, examResult, secondsLeft, expired };
});

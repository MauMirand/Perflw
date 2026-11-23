'use strict';
/* Assessment model — question shapes, validation, grading, item selection. Pure logic: no DOM, no Electron, no
   database, no AI. Loaded by the main process and the tests (require) and, later, by the renderer (script tag →
   window.PerflwAssessmentModel). Spec: docs/LEARNING_SYSTEM_SPEC.md §4.2–4.7; ADR-005, ADR-007.

   Five question types: choice, truefalse, matching (graded here, deterministically) and essay, explain (open
   answers: `grade` returns status 'pending'; the score comes later from rubric verdicts via `scoreFromCriteria`,
   computed by code, never taken from a model as a number).

   Ids inside a payload (option, left/right item, rubric criterion) are normalized to strings so answers sent over
   IPC compare reliably. Question-level ids (id, subjectId, topicId, fileId, docId) keep their type. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwAssessmentModel = factory();
})(globalThis, function () {

const TYPES = Object.freeze(['choice', 'truefalse', 'matching', 'essay', 'explain']);
const OPEN_TYPES = Object.freeze(['essay', 'explain']);
const DIMENSIONS = Object.freeze(['recognition', 'recall', 'understanding', 'application']);
const KINDS = Object.freeze(['diagnostic', 'practice', 'final', 'retention']);
const ORIGINS = Object.freeze(['manual', 'template', 'generated']);
const STATUSES = Object.freeze(['active', 'retired']);
const REVIEWS = Object.freeze(['approved', 'unreviewed', 'rejected']);
const VERDICTS = Object.freeze({ met: 1, partly: 0.5, missing: 0 });
const LIMITS = Object.freeze({
  id: 100, prompt: 2000, explanation: 2000, statement: 2000, points: Object.freeze({ min: 1, max: 20 }),
  sources: 5, quote: 300, section: 200, options: Object.freeze({ min: 2, max: 8 }), itemText: 500,
  left: Object.freeze({ min: 2, max: 10 }), right: 12, rubric: Object.freeze({ essay: 8, explain: 5 }),
  criterion: 500, keywords: 20, keyword: 100, words: 5000, modelAnswer: 5000, provenance: 200,
  responseText: 20000, timeMs: 24 * 60 * 60 * 1000,
});
const DEFAULT_WORDS = Object.freeze({ essay: Object.freeze({ min: 0, max: 500 }), explain: 120 });
const JUSTIFICATION_ID = 'justification';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const round2 = n => Math.round(n * 100) / 100;
const key = v => (v == null ? null : String(v));

// ───────── validation helpers (each pushes "field: plain-language problem.")
function checker() {
  const errors = [];
  return { errors, fail: (field, message) => { errors.push(`${field}: ${message}`); } };
}

/* A record id: a non-empty string (≤ 100 chars, trimmed) or a non-negative safe integer. */
function cleanId(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string') { const s = v.trim(); if (s && s.length <= LIMITS.id) return s; }
  return undefined;
}
function requireId(c, field, v) {
  const id = cleanId(v);
  if (id === undefined) c.fail(field, `is required: text of 1–${LIMITS.id} characters or a whole number.`);
  return id;
}
function text(c, field, v, min, max, fallback = '') {
  if (v == null) v = fallback;
  if (typeof v !== 'string') { c.fail(field, 'must be text.'); return ''; }
  const s = v.trim();
  if (s.length < min) c.fail(field, min === 1 ? 'is required.' : `must be at least ${min} characters.`);
  else if (s.length > max) c.fail(field, `must be at most ${max} characters (it has ${s.length}).`);
  return s;
}
function oneOf(c, field, v, list, fallback) {
  if (v == null && fallback !== undefined) return fallback;
  if (!list.includes(v)) c.fail(field, `must be one of: ${list.join(', ')}.`);
  return v;
}
function bool(c, field, v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'boolean') c.fail(field, 'must be true or false.');
  return v === true;
}
function int(c, field, v, min, max, fallback) {
  if (v == null) return fallback;
  if (!Number.isInteger(v) || v < min || v > max) c.fail(field, `must be a whole number from ${min} to ${max}.`);
  return v;
}
function list(c, field, v, min, max) {
  if (v == null) v = [];
  if (!Array.isArray(v)) { c.fail(field, 'must be a list.'); return []; }
  if (v.length < min || v.length > max) {
    c.fail(field, min === max ? `must have ${min} items (it has ${v.length}).` : `must have ${min}–${max} items (it has ${v.length}).`);
  }
  return v;
}
/* Payload-local id → string. */
function itemId(c, field, v) {
  const id = cleanId(v);
  if (id === undefined) { c.fail(field, `is required: text of 1–${LIMITS.id} characters or a whole number.`); return ''; }
  return String(id);
}
function uniqueIds(c, field, rows) {
  const seen = new Set();
  rows.forEach((row, i) => {
    if (!row.id) return;
    if (seen.has(row.id)) c.fail(`${field}[${i}].id`, `"${row.id}" is used more than once; ids must be unique.`);
    seen.add(row.id);
  });
  return seen;
}
/* [{ id, text }] items (options, matching sides). */
function textItems(c, field, v, min, max) {
  const rows = list(c, field, v, min, max).map((raw, i) => {
    const at = `${field}[${i}]`;
    if (!isObj(raw)) { c.fail(at, 'must be an object with id and text.'); return { id: '', text: '' }; }
    return { id: itemId(c, `${at}.id`, raw.id), text: text(c, `${at}.text`, raw.text, 1, LIMITS.itemText) };
  });
  return { rows, ids: uniqueIds(c, field, rows) };
}
/* A list of ids that must all exist in `known`, without repeats. */
function idRefs(c, field, v, known, what) {
  if (!Array.isArray(v)) { c.fail(field, 'must be a list of ids.'); return []; }
  const out = [];
  v.forEach((raw, i) => {
    const id = cleanId(raw);
    if (id === undefined) { c.fail(`${field}[${i}]`, 'must be an id.'); return; }
    const s = String(id);
    if (!known.has(s)) c.fail(`${field}[${i}]`, `"${s}" is not one of the ${what}.`);
    else if (out.includes(s)) c.fail(`${field}[${i}]`, `"${s}" is listed more than once.`);
    else out.push(s);
  });
  return out;
}

// ───────── payloads per type
function choicePayload(c, p) {
  const options = textItems(c, 'payload.options', p.options, LIMITS.options.min, LIMITS.options.max);
  const multiple = bool(c, 'payload.multiple', p.multiple, false);
  const correct = idRefs(c, 'payload.correct', p.correct, options.ids, 'options');
  if (Array.isArray(p.correct) && correct.length === 0 && p.correct.length === 0) c.fail('payload.correct', 'must name at least one correct option.');
  if (!multiple && correct.length > 1) c.fail('payload.correct', 'a single-answer question needs exactly one correct option (set multiple to true for more).');
  return { options: options.rows, correct, multiple };
}

function trueFalsePayload(c, p) {
  const statement = text(c, 'payload.statement', p.statement, 1, LIMITS.statement);
  if (typeof p.correct !== 'boolean') c.fail('payload.correct', 'must be true or false.');
  const requireJustification = bool(c, 'payload.requireJustification', p.requireJustification, false);
  return { statement, correct: p.correct === true, requireJustification };
}

function matchingPayload(c, p) {
  const left = textItems(c, 'payload.left', p.left, LIMITS.left.min, LIMITS.left.max);
  const rightMin = Math.max(left.rows.length, LIMITS.left.min);
  const right = textItems(c, 'payload.right', p.right, rightMin, LIMITS.right);
  const pairs = [];
  const usedLeft = new Set(); const usedRight = new Set();
  if (p.pairs == null) c.fail('payload.pairs', 'must be a list of [leftId, rightId] pairs.');
  list(c, 'payload.pairs', p.pairs, 0, LIMITS.left.max).forEach((raw, i) => {
    const at = `payload.pairs[${i}]`;
    if (!Array.isArray(raw) || raw.length !== 2) { c.fail(at, 'must be a pair [leftId, rightId].'); return; }
    const l = key(cleanId(raw[0])); const r = key(cleanId(raw[1]));
    if (l == null || !left.ids.has(l)) { c.fail(at, `the left id "${raw[0]}" is not one of payload.left.`); return; }
    if (r == null || !right.ids.has(r)) { c.fail(at, `the right id "${raw[1]}" is not one of payload.right.`); return; }
    if (usedLeft.has(l)) { c.fail(at, `the left item "${l}" is paired more than once.`); return; }
    if (usedRight.has(r)) { c.fail(at, `the right item "${r}" is paired more than once.`); return; }
    usedLeft.add(l); usedRight.add(r); pairs.push([l, r]);
  });
  const unpaired = left.rows.filter(row => row.id && !usedLeft.has(row.id)).map(row => row.id);
  if (Array.isArray(p.pairs) && unpaired.length) c.fail('payload.pairs', `every left item needs a pair; missing: ${unpaired.join(', ')}.`);
  return { left: left.rows, right: right.rows, pairs };
}

function rubric(c, v, max) {
  const rows = list(c, 'payload.rubric', v, 1, max).map((raw, i) => {
    const at = `payload.rubric[${i}]`;
    if (!isObj(raw)) { c.fail(at, 'must be an object with id, criterion and points.'); return { id: '', criterion: '', points: 1 }; }
    const row = {
      id: itemId(c, `${at}.id`, raw.id),
      criterion: text(c, `${at}.criterion`, raw.criterion, 1, LIMITS.criterion),
      points: raw.points == null ? 1 : raw.points,
    };
    if (typeof row.points !== 'number' || !Number.isFinite(row.points) || row.points < LIMITS.points.min || row.points > LIMITS.points.max) {
      c.fail(`${at}.points`, `must be a number from ${LIMITS.points.min} to ${LIMITS.points.max}.`);
    }
    if (raw.keywords != null) {
      row.keywords = list(c, `${at}.keywords`, raw.keywords, 0, LIMITS.keywords)
        .map((k, j) => text(c, `${at}.keywords[${j}]`, k, 1, LIMITS.keyword));
    }
    return row;
  });
  uniqueIds(c, 'payload.rubric', rows);
  return rows;
}

function modelAnswer(c, out, v) {
  if (v == null) return out;
  out.modelAnswer = text(c, 'payload.modelAnswer', v, 0, LIMITS.modelAnswer);
  return out;
}

function essayPayload(c, p) {
  const minWords = int(c, 'payload.minWords', p.minWords, 0, LIMITS.words, DEFAULT_WORDS.essay.min);
  const maxWords = int(c, 'payload.maxWords', p.maxWords, 1, LIMITS.words, DEFAULT_WORDS.essay.max);
  if (Number.isInteger(minWords) && Number.isInteger(maxWords) && minWords > maxWords) c.fail('payload.maxWords', 'must be at least payload.minWords.');
  return modelAnswer(c, { minWords, maxWords, rubric: rubric(c, p.rubric, LIMITS.rubric.essay) }, p.modelAnswer);
}

function explainPayload(c, p) {
  const maxWords = int(c, 'payload.maxWords', p.maxWords, 1, LIMITS.words, DEFAULT_WORDS.explain);
  return modelAnswer(c, { maxWords, rubric: rubric(c, p.rubric, LIMITS.rubric.explain) }, p.modelAnswer);
}

const PAYLOADS = { choice: choicePayload, truefalse: trueFalsePayload, matching: matchingPayload, essay: essayPayload, explain: explainPayload };

/* Default points per type: choice 1; true/false 1 (2 with a justification part); matching 1 per pair;
   essay/explain = the rubric total. */
function defaultPoints(type, payload) {
  if (type === 'truefalse') return payload.requireJustification ? 2 : 1;
  if (type === 'matching') return payload.pairs.length || 1;
  if (OPEN_TYPES.includes(type)) return payload.rubric.reduce((sum, row) => sum + (Number(row.points) || 0), 0) || 1;
  return 1;
}

function sources(c, v) {
  return list(c, 'source', v, 0, LIMITS.sources).map((raw, i) => {
    const at = `source[${i}]`;
    if (!isObj(raw)) { c.fail(at, 'must be an object.'); return null; }
    const ref = (field, value) => {
      if (value == null || value === '') return null;
      const id = cleanId(value);
      if (id === undefined) c.fail(`${at}.${field}`, 'must be an id or empty.');
      return id === undefined ? null : id;
    };
    const page = raw.page == null ? null : raw.page;
    if (page !== null && (!Number.isInteger(page) || page < 1)) c.fail(`${at}.page`, 'must be a page number (1 or more) or empty.');
    return {
      fileId: ref('fileId', raw.fileId),
      docId: ref('docId', raw.docId),
      section: text(c, `${at}.section`, raw.section, 0, LIMITS.section),
      page,
      quote: text(c, `${at}.quote`, raw.quote, 0, LIMITS.quote),
    };
  });
}

function provenance(c, v) {
  if (!isObj(v)) { c.fail('provenance', 'is required for AI-generated questions (provider, model, generatedAt).'); return null; }
  const out = {
    provider: text(c, 'provenance.provider', v.provider, 1, LIMITS.provenance),
    model: text(c, 'provenance.model', v.model, 1, LIMITS.provenance),
    agentId: text(c, 'provenance.agentId', v.agentId, 0, LIMITS.provenance),
    promptVersion: text(c, 'provenance.promptVersion', v.promptVersion, 0, LIMITS.provenance),
    generatedAt: text(c, 'provenance.generatedAt', v.generatedAt, 1, LIMITS.provenance),
  };
  if (out.generatedAt && Number.isNaN(Date.parse(out.generatedAt))) c.fail('provenance.generatedAt', 'must be a date and time (ISO 8601).');
  return out;
}

/* The only gate for manual, template and AI questions. Returns the normalized question (unknown fields dropped)
   when ok; value is null when there are errors. */
function validateQuestion(q) {
  if (!isObj(q)) return { ok: false, value: null, errors: ['question: must be an object.'] };
  const c = checker();
  const value = {
    id: requireId(c, 'id', q.id),
    subjectId: requireId(c, 'subjectId', q.subjectId),
    topicId: q.topicId == null ? null : requireId(c, 'topicId', q.topicId),
    type: oneOf(c, 'type', q.type, TYPES),
    prompt: text(c, 'prompt', q.prompt, 1, LIMITS.prompt),
    dimension: oneOf(c, 'dimension', q.dimension, DIMENSIONS),
    difficulty: oneOf(c, 'difficulty', q.difficulty, [1, 2, 3]),
    explanation: text(c, 'explanation', q.explanation, 0, LIMITS.explanation),
    points: 0,
    source: sources(c, q.source),
    origin: oneOf(c, 'origin', q.origin, ORIGINS, 'manual'),
    provenance: null,
    status: oneOf(c, 'status', q.status, STATUSES, 'active'),
    review: null,
    payload: null,
  };
  if (value.origin === 'generated') value.provenance = provenance(c, q.provenance);
  // D3: generated questions start unreviewed; manual and template questions are approved unless stated.
  value.review = oneOf(c, 'review', q.review, REVIEWS, value.origin === 'generated' ? 'unreviewed' : 'approved');
  if (TYPES.includes(value.type)) {
    if (!isObj(q.payload)) c.fail('payload', `must be an object with the ${value.type} fields.`);
    else value.payload = PAYLOADS[value.type](c, q.payload);
  }
  if (value.payload) {
    const points = q.points == null ? defaultPoints(value.type, value.payload) : q.points;
    if (typeof points !== 'number' || !Number.isFinite(points) || points < LIMITS.points.min || points > LIMITS.points.max) {
      c.fail('points', `must be a number from ${LIMITS.points.min} to ${LIMITS.points.max}` + (q.points == null ? ` (the default from the rubric is ${points}; set points or lower the rubric).` : '.'));
    }
    value.points = points;
  }
  return c.errors.length ? { ok: false, value: null, errors: c.errors } : { ok: true, value, errors: [] };
}

// ───────── responses
const capText = v => (typeof v === 'string' ? v.slice(0, LIMITS.responseText) : undefined);

/* Keeps only the fields that belong to the question's type, drops ids the question doesn't have, caps text at
   20,000 characters. Shape: { questionId, choice?, value?, justification?, pairs?, text?, dontKnow?, confidence?, timeMs }. */
function normalizeResponse(question, raw) {
  const r = isObj(raw) ? raw : {};
  const p = (question && question.payload) || {};
  const out = { questionId: question ? question.id : null };
  switch (question && question.type) {
    case 'choice': {
      const known = new Set((p.options || []).map(o => String(o.id)));
      const picks = Array.isArray(r.choice) ? r.choice : r.choice == null ? [] : [r.choice];
      out.choice = [...new Set(picks.map(v => key(v)).filter(v => v != null && known.has(v)))];
      break;
    }
    case 'truefalse':
      if (typeof r.value === 'boolean') out.value = r.value;
      if (p.requireJustification && typeof r.justification === 'string') out.justification = capText(r.justification);
      break;
    case 'matching': {
      const left = new Set((p.left || []).map(o => String(o.id)));
      const right = new Set((p.right || []).map(o => String(o.id)));
      const seen = new Set();
      out.pairs = [];
      for (const pair of Array.isArray(r.pairs) ? r.pairs.slice(0, LIMITS.left.max * 2) : []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const l = key(pair[0]); const rt = key(pair[1]);
        if (!left.has(l) || !right.has(rt) || seen.has(l)) continue;
        seen.add(l); out.pairs.push([l, rt]);
      }
      break;
    }
    case 'essay':
    case 'explain':
      if (typeof r.text === 'string') out.text = capText(r.text);
      break;
    default:
  }
  if (r.dontKnow === true) out.dontKnow = true;
  if ([1, 2, 3].includes(r.confidence)) out.confidence = r.confidence;
  out.timeMs = Number.isFinite(r.timeMs) && r.timeMs > 0 ? Math.min(Math.round(r.timeMs), LIMITS.timeMs) : 0;
  return out;
}

function isEmpty(question, r) {
  switch (question.type) {
    case 'choice': return !r.choice.length;
    case 'truefalse': return typeof r.value !== 'boolean';
    case 'matching': return !r.pairs.length;
    default: return !(r.text && r.text.trim());
  }
}

// ───────── grading
/* Deterministic grading (spec §4.3). Open answers return status 'pending' for the grader queue. A true/false with a
   justification grades the true/false half now and returns status 'pending' with `pendingPoints` for the
   justification half (graded later with `scoreFromCriteria`). */
function grade(question, response) {
  const r = normalizeResponse(question, response);
  const max = question.points;
  if (r.dontKnow) return { score: 0, max, status: 'graded', category: 'not_known' };
  if (isEmpty(question, r)) return { score: 0, max, status: 'graded', category: 'not_answered' };
  const p = question.payload;
  switch (question.type) {
    case 'choice': {
      if (!p.multiple) return { score: r.choice.length === 1 && r.choice[0] === String(p.correct[0]) ? max : 0, max, status: 'graded' };
      const correct = new Set(p.correct.map(String));
      const right = r.choice.filter(id => correct.has(id)).length;
      const wrong = r.choice.length - right;
      return { score: round2(max * Math.max(0, (right - wrong) / correct.size)), max, status: 'graded' };
    }
    case 'truefalse': {
      const part = p.requireJustification ? round2(max / 2) : max;
      const score = r.value === p.correct ? part : 0;
      if (!p.requireJustification || !(r.justification && r.justification.trim())) return { score, max, status: 'graded' };
      return { score, max, status: 'pending', pendingPoints: round2(max - part) };
    }
    case 'matching': {
      const answer = new Map(p.pairs.map(([l, rt]) => [String(l), String(rt)]));
      const hits = r.pairs.filter(([l, rt]) => answer.get(l) === rt).length;
      return { score: round2(max * hits / p.pairs.length), max, status: 'graded' };
    }
    default:
      return { score: 0, max, status: 'pending' };
  }
}

/* The rubric an open answer is graded on: essay/explain → payload.rubric; true/false with a justification → one
   criterion worth the justification half; otherwise []. */
function rubricOf(question) {
  const p = (question && question.payload) || {};
  if (OPEN_TYPES.includes(question && question.type)) return p.rubric || [];
  if (question && question.type === 'truefalse' && p.requireJustification) {
    return [{ id: JUSTIFICATION_ID, criterion: 'The justification supports the answer correctly.', points: round2(question.points / 2) }];
  }
  return [];
}

/* Score from rubric verdicts (met = full, partly = half, missing = 0), scaled to the rubric's share of the
   question's points (essay/explain: all of it; true/false: the justification half). `verdicts` is
   [{ id, verdict }] or { [criterionId]: verdict }. A criterion without a valid verdict counts as missing; unknown
   ids are ignored. The caller validates AI output before calling this (spec §4.4). */
function scoreFromCriteria(question, verdicts) {
  const rows = rubricOf(question);
  if (!rows.length) return 0;
  const byId = new Map();
  if (Array.isArray(verdicts)) for (const v of verdicts) { if (isObj(v)) byId.set(key(v.id), v.verdict); }
  else if (isObj(verdicts)) for (const [id, v] of Object.entries(verdicts)) byId.set(id, v);
  const total = rows.reduce((sum, row) => sum + row.points, 0);
  const earned = rows.reduce((sum, row) => {
    const v = byId.get(String(row.id));
    return sum + row.points * (Object.prototype.hasOwnProperty.call(VERDICTS, v) ? VERDICTS[v] : 0);
  }, 0);
  const share = question.type === 'truefalse' ? question.points - round2(question.points / 2) : question.points;
  return total ? round2(share * earned / total) : 0;
}

// ───────── seeded order
function seedNumber(seed) {
  const s = String(seed == null ? '' : seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function random(seed) { // mulberry32
  let a = seedNumber(seed);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A new array in a seeded order: the same items and seed always give the same order. The input is not changed. */
function shuffle(items, seed) {
  const out = Array.isArray(items) ? items.slice() : [];
  const next = random(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ───────── item selection (spec §4.7)
/* Interleave a topic's items across dimensions. A diagnostic starts each topic with a recall-or-higher item when
   one exists, so recognition-only evidence cannot dominate. */
function spread(items, kind) {
  const groups = new Map();
  for (const q of items) { if (!groups.has(q.dimension)) groups.set(q.dimension, []); groups.get(q.dimension).push(q); }
  const order = [...groups.keys()];
  if (kind === 'diagnostic' && order[0] === 'recognition' && order.length > 1) order.push(order.shift());
  const out = [];
  for (let round = 0; out.length < items.length; round++) {
    for (const dim of order) { const g = groups.get(dim); if (round < g.length) out.push(g[round]); }
  }
  return out;
}

/* Picks `count` questions, deterministic for a given seed:
   - eligible: status active; not in `exclude`; type in `types` and dimension in `dimensions` when given;
     topicId in `topics` when given; review 'approved' for diagnostic/final/retention, not 'rejected' for practice
     (D3; an unknown or missing kind is treated as strict);
   - `due` question ids (practice: due mistakes) come first;
   - round-robin over topics (the `topics` order, else first appearance): every topic gets one item per round
     before any topic gets a second; topics in `weakTopics` get a second item each round (×2 weight);
   - within a topic, items are spread across dimensions. */
function selectItems(options = {}) {
  const {
    questions = [], topics, count, types, dimensions, exclude = [], weakTopics = [], due = [], seed = 0, kind,
  } = options;
  const strict = kind !== 'practice';
  const excluded = new Set((exclude || []).map(key));
  const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;
  const dimSet = Array.isArray(dimensions) && dimensions.length ? new Set(dimensions) : null;
  const topicKeys = Array.isArray(topics) ? [...new Set(topics.map(key))] : null;
  const topicSet = topicKeys ? new Set(topicKeys) : null;
  const eligible = (Array.isArray(questions) ? questions : []).filter(q => isObj(q)
    && (q.status == null || q.status === 'active')
    && (strict ? q.review === 'approved' : q.review !== 'rejected')
    && !excluded.has(key(q.id))
    && (!typeSet || typeSet.has(q.type))
    && (!dimSet || dimSet.has(q.dimension))
    && (!topicSet || topicSet.has(key(q.topicId))));

  const target = count == null ? Infinity : Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const out = [];
  const taken = new Set();
  const byId = new Map(eligible.map(q => [key(q.id), q]));
  for (const id of Array.isArray(due) ? due : []) {
    const q = byId.get(key(id));
    if (q && !taken.has(q) && out.length < target) { taken.add(q); out.push(q); }
  }

  const buckets = new Map((topicKeys || []).map(k => [k, []]));
  for (const q of shuffle(eligible, seed)) {
    if (taken.has(q)) continue;
    const k = key(q.topicId);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(q);
  }
  if (!topicKeys) { // first appearance in the caller's list, not in the shuffled one
    const firstSeen = [...new Set(eligible.map(q => key(q.topicId)))];
    for (const k of firstSeen) { const items = buckets.get(k); if (items) { buckets.delete(k); buckets.set(k, items); } }
  }
  const weak = new Set((weakTopics || []).map(key));
  const queues = [...buckets.entries()].map(([k, items]) => ({ weak: weak.has(k), items: spread(items, kind) }));
  while (out.length < target) {
    let took = false;
    for (const pass of [false, true]) {
      for (const q of queues) {
        if (out.length >= target) break;
        if (pass && !q.weak) continue;
        if (q.items.length) { out.push(q.items.shift()); took = true; }
      }
    }
    if (!took) break;
  }
  return out;
}

// ───────── student view (ADR-005: no answer keys in the renderer for an in-progress diagnostic/final)
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const STUDENT_FIELDS = ['id', 'subjectId', 'topicId', 'type', 'prompt', 'dimension', 'difficulty', 'points', 'origin', 'status', 'review'];

/* Whitelist copy of one question: no correct, pairs, modelAnswer, rubric keywords, explanation or source quotes
   (each can give the answer away before submit). */
function studentQuestion(q) {
  if (!isObj(q)) return q;
  const out = {};
  for (const field of STUDENT_FIELDS) if (q[field] !== undefined) out[field] = clone(q[field]);
  const p = isObj(q.payload) ? q.payload : {};
  const items = rows => (Array.isArray(rows) ? rows.map(row => ({ id: row && row.id, text: row && row.text })) : []);
  const criteria = rows => (Array.isArray(rows) ? rows.map(row => ({ id: row && row.id, criterion: row && row.criterion, points: row && row.points })) : []);
  switch (q.type) {
    case 'choice': out.payload = { options: items(p.options), multiple: p.multiple === true }; break;
    case 'truefalse': out.payload = { statement: p.statement, requireJustification: p.requireJustification === true }; break;
    case 'matching': out.payload = { left: items(p.left), right: items(p.right) }; break;
    case 'essay': out.payload = { minWords: p.minWords, maxWords: p.maxWords, rubric: criteria(p.rubric) }; break;
    case 'explain': out.payload = { maxWords: p.maxWords, rubric: criteria(p.rubric) }; break;
    default: out.payload = {};
  }
  return out;
}

/* Accepts one question, a list of questions, or a snapshot object with a `questions` list (its other fields are
   copied as-is). Returns a new value; the input is not changed. */
function stripAnswerKey(snapshot) {
  if (Array.isArray(snapshot)) return snapshot.map(studentQuestion);
  if (!isObj(snapshot)) return snapshot;
  if (Array.isArray(snapshot.questions)) {
    const { questions, ...rest } = snapshot;
    return { ...clone(rest), questions: questions.map(studentQuestion) };
  }
  return studentQuestion(snapshot);
}

return {
  TYPES, OPEN_TYPES, DIMENSIONS, KINDS, ORIGINS, STATUSES, REVIEWS, VERDICTS, LIMITS,
  validateQuestion, normalizeResponse, grade, rubricOf, scoreFromCriteria, selectItems, stripAnswerKey, shuffle,
};
});

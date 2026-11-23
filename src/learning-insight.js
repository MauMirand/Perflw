'use strict';
/* Learning insight — mistake categories, weak-topic ranking, review scheduling and targeted notes. Pure logic: no
   DOM, no Electron, no database, no AI. Loaded by the main process and the tests (require) and, later, by the
   renderer (script tag → window.PerflwLearningInsight). Spec: docs/LEARNING_SYSTEM_SPEC.md §5.2, §5.3, §4.3.

   It does not compute mastery: where a rule needs a topic level (§5.4, mastery-model.js), the caller passes it in.
   Categories are always assigned by code, so the analysis works offline and is reproducible (§5.2). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwLearningInsight = factory();
})(globalThis, function () {

/* §5.2 categories, in precedence order. `guess` is the only category of a correct answer; the others mark a
   mistake. A correct answer that is not a guess has no category (null). */
const CATEGORIES = Object.freeze([
  'not_known', 'misconception', 'guess', 'confusion', 'partial', 'recognition_only', 'forgotten', 'incorrect',
]);
const CATEGORY_LABELS = Object.freeze({
  not_known: 'Did not know',
  misconception: 'Confident but wrong (misconception)',
  guess: 'Correct, but a guess',
  confusion: 'Mixed up with a related answer',
  partial: 'Partly correct',
  recognition_only: 'Recognised the idea but could not recall or explain it',
  forgotten: 'Known before, forgotten later',
  incorrect: 'Incorrect',
});
/* Levels that make a topic weak after the latest diagnostic (§5.3). Labels as in §5.4, normalized to snake_case. */
const WEAK_LEVELS = Object.freeze(['not_assessed', 'emerging', 'developing']);
/* Leitner boxes 1–5 (§5.3, LS-004): days until the question is due again after landing in box N. */
const REVIEW_OFFSETS = Object.freeze([1, 3, 7, 14, 30]);
const MAX_BOX = REVIEW_OFFSETS.length;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const key = v => (v == null ? null : String(v));
const list = v => (Array.isArray(v) ? v : []);
const round4 = n => Math.round(n * 10000) / 10000;
const sameText = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();

// ───────── categorize

function isBlank(response) {
  if (!isObj(response)) return true;
  if (Array.isArray(response.choice) && response.choice.length) return false;
  if (Array.isArray(response.pairs) && response.pairs.length) return false;
  if (typeof response.value === 'boolean') return false;
  return !(typeof response.text === 'string' && response.text.trim());
}

/* A choice answer that picked an option whose text is the correct answer of another question in the same topic. */
function choiceConfusion(question, response, siblings) {
  const p = question.payload || {};
  const correct = new Set(list(p.correct).map(String));
  const optionText = new Map(list(p.options).map(o => [String(o && o.id), sameText(o && o.text)]));
  const picked = list(response.choice).map(String).filter(id => !correct.has(id)).map(id => optionText.get(id));
  if (!picked.some(Boolean)) return false;
  const others = new Set();
  for (const s of siblings) {
    if (!isObj(s) || s.type !== 'choice' || key(s.id) === key(question.id) || key(s.topicId) !== key(question.topicId)) continue;
    const sp = s.payload || {};
    const texts = new Map(list(sp.options).map(o => [String(o && o.id), sameText(o && o.text)]));
    for (const id of list(sp.correct)) if (texts.get(String(id))) others.add(texts.get(String(id)));
  }
  return picked.some(t => t && others.has(t));
}

/* A matching answer that swapped two pairs: left A got B's right item while left B got A's. */
function matchingSwap(question, response) {
  const answer = new Map(list((question.payload || {}).pairs).map(([l, r]) => [String(l), String(r)]));
  const given = new Map(list(response.pairs).map(([l, r]) => [String(l), String(r)]));
  for (const [l, r] of given) {
    if (answer.get(l) === r) continue;
    for (const [l2, r2] of answer) if (l2 !== l && r2 === r && given.get(l2) === answer.get(l)) return true;
  }
  return false;
}

function isCorrect(result) { return result.max > 0 && result.score >= result.max; }

/* answer:  { question, response, result } — question as validated by assessment-model.js, response as normalized,
            result = grade() output { score, max, status, category? } (or the final score of an open answer).
   context: { kind,      assessment kind of this answer ('retention' enables `forgotten`)
              answers,   the other answers of the same assessment, same shape (for `recognition_only`)
              siblings,  other questions of the same topic (for `confusion`)
              earlier }  earlier results [{ questionId?, topicId, kind, correct }]; an entry with a questionId
                         matches that question only, one without matches the whole topic (for `forgotten`)
   Returns a category from CATEGORIES, null for a correct non-guess answer, or null while the result is pending.
   Precedence follows the §5.2 table order: not_known › misconception › confusion › partial › recognition_only ›
   forgotten › incorrect. */
function categorize(answer, context = {}) {
  if (!isObj(answer) || !isObj(answer.question) || !isObj(answer.result)) {
    throw new TypeError('categorize: answer needs question and result objects.');
  }
  const ctx = isObj(context) ? context : {};
  const { question, result } = answer;
  const response = isObj(answer.response) ? answer.response : {};
  if (result.status === 'pending') return null;
  if (response.dontKnow === true || result.category === 'not_known' || result.category === 'not_answered' || isBlank(response)) {
    return 'not_known';
  }
  const confidence = response.confidence;
  if (isCorrect(result)) return confidence === 1 ? 'guess' : null;
  if (result.score <= 0 && confidence === 3) return 'misconception';
  if (question.type === 'choice' && choiceConfusion(question, response, list(ctx.siblings))) return 'confusion';
  if (question.type === 'matching' && matchingSwap(question, response)) return 'confusion';
  const open = question.type === 'essay' || question.type === 'explain' || question.type === 'matching'
    || (question.type === 'truefalse' && (question.payload || {}).requireJustification === true);
  if (open && result.score > 0) return 'partial';
  if ((question.dimension === 'recall' || question.dimension === 'understanding') && list(ctx.answers).some(a =>
    isObj(a) && isObj(a.question) && isObj(a.result) && a.question.dimension === 'recognition'
    && key(a.question.topicId) === key(question.topicId) && key(a.question.id) !== key(question.id) && isCorrect(a.result))) {
    return 'recognition_only';
  }
  if (ctx.kind === 'retention' && list(ctx.earlier).some(e => isObj(e) && e.correct === true
    && (e.kind === 'final' || e.kind === 'practice')
    && (e.questionId != null ? key(e.questionId) === key(question.id) : key(e.topicId) === key(question.topicId)))) {
    return 'forgotten';
  }
  return 'incorrect';
}

// ───────── weak topics

function levelKey(level) {
  if (level == null || level === '') return 'not_assessed';
  return String(level).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/* results: { topics: [{ id, position?, level? }], answers: [{ topicId, category, pending? }] }
     topics  — the subject's topics in order; `position` defaults to the index; `level` is the topic's level after
               the latest diagnostic (from mastery-model.js; missing = Not assessed).
     answers — one row per graded answer; `category` from categorize() (null = correct). Pending rows and rows of
               unknown topics are ignored.
   Weak = level Not assessed / Emerging / Developing, or any misconception (§5.3). Score =
   (misconceptions × 2 + wrong + not_known) / items, where wrong = every other mistake category (guess is correct).
   Returns the weak topics, highest score first, ties by topic position, then id. */
function rankWeakTopics(results) {
  const input = isObj(results) ? results : {};
  const rows = new Map();
  list(input.topics).forEach((t, i) => {
    if (!isObj(t) || t.id == null || rows.has(key(t.id))) return;
    const position = Number.isFinite(t.position) ? t.position : i;
    rows.set(key(t.id), { topicId: t.id, position, level: levelKey(t.level), items: 0, misconceptions: 0, wrong: 0, notKnown: 0 });
  });
  for (const a of list(input.answers)) {
    if (!isObj(a) || a.pending === true) continue;
    const row = rows.get(key(a.topicId));
    if (!row) continue;
    row.items += 1;
    if (a.category === 'misconception') row.misconceptions += 1;
    else if (a.category === 'not_known') row.notKnown += 1;
    else if (a.category != null && a.category !== 'guess') row.wrong += 1;
  }
  const weak = [];
  for (const row of rows.values()) {
    const reasons = [];
    if (WEAK_LEVELS.includes(row.level)) reasons.push('level');
    if (row.misconceptions > 0) reasons.push('misconception');
    if (!reasons.length) continue;
    const score = row.items ? round4((row.misconceptions * 2 + row.wrong + row.notKnown) / row.items) : 0;
    weak.push({ ...row, score, reasons });
  }
  return weak.sort((a, b) => b.score - a.score || a.position - b.position
    || String(a.topicId).localeCompare(String(b.topicId)));
}

// ───────── review scheduling (Leitner)

function parseDay(today) {
  if (today instanceof Date && !Number.isNaN(today.getTime())) {
    return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  }
  const m = typeof today === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    if (d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]) return t;
  }
  throw new TypeError('nextReview: today must be a valid Date or a "YYYY-MM-DD" date.');
}

/* nextReview(box, correct, today) or nextReview({ box, correct, today }).
   box: current box 1–5 (missing = 1, new review rows start in box 1; out of range is clamped).
   Correct moves up one box (box 5 stays 5); wrong resets to box 1. today: local Date or "YYYY-MM-DD".
   Returns { box, dueOn: "YYYY-MM-DD", days } with the due offset of the new box (1/3/7/14/30 days). */
function nextReview(box, correct, today) {
  if (isObj(box)) ({ box, correct, today } = box);
  const n = Number.isFinite(Number(box)) && box !== null && box !== '' ? Math.trunc(Number(box)) : 1;
  const current = Math.min(MAX_BOX, Math.max(1, n));
  const next = correct === true ? Math.min(MAX_BOX, current + 1) : 1;
  const days = REVIEW_OFFSETS[next - 1];
  const dueOn = new Date(parseDay(today) + days * 86400000).toISOString().slice(0, 10);
  return { box: next, dueOn, days };
}

// ───────── targeted notes

/* Escapes text so Markdown shows it literally: inline markers everywhere, block markers at the start. Whitespace
   (newlines included) collapses to single spaces, so user text can never open a heading, list, quote or fence. */
function escapeMarkdown(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s
    .replace(/[\\`*_[\]<>|~&#]/g, ch => `\\${ch}`)
    .replace(/^([>+=-])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');
}

function paragraphs(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(escapeMarkdown).filter(Boolean);
}

function sourceLine(src) {
  const where = [];
  if (src.section) where.push(escapeMarkdown(src.section));
  if (src.page != null && src.page !== '') where.push(`page ${escapeMarkdown(src.page)}`);
  return where.length ? `> — ${where.join(', ')}` : '';
}

/* targetedNote({ topic, analysisSection, missed }) → Markdown string (deterministic, no AI).
   topic: { title } or a title string. analysisSection: { title?, description?, keyPoints?: [] } or null.
   missed: [{ prompt, answer?, correctAnswer?, category?, explanation?, source?: [{ quote, section?, page? }] }],
   with `answer`/`correctAnswer` already turned into text by the caller. Every piece of text is escaped. */
function targetedNote({ topic, analysisSection, missed } = {}) {
  const title = escapeMarkdown(isObj(topic) ? topic.title : topic) || 'Untitled topic';
  const out = [`# Targeted note: ${title}`, '', '## What this topic covers', ''];
  const section = isObj(analysisSection) ? analysisSection : null;
  const sectionTitle = section && escapeMarkdown(section.title);
  const description = section ? paragraphs(section.description) : [];
  const points = section ? list(section.keyPoints).map(escapeMarkdown).filter(Boolean) : [];
  if (sectionTitle) out.push(`### ${sectionTitle}`, '');
  for (const p of description) out.push(p, '');
  if (points.length) out.push('### Key points', '', ...points.map(p => `- ${p}`), '');
  if (!description.length && !points.length) out.push('_No analysis is available for this topic yet._', '');

  out.push('## Your mistakes', '');
  const rows = list(missed).filter(isObj);
  if (!rows.length) out.push('_No missed questions for this topic._', '');
  rows.forEach((m, i) => {
    out.push(`### ${i + 1}. ${escapeMarkdown(m.prompt) || 'Question'}`, '');
    out.push(`- **You answered:** ${escapeMarkdown(m.answer) || '_no answer_'}`);
    if (escapeMarkdown(m.correctAnswer)) out.push(`- **Correct answer:** ${escapeMarkdown(m.correctAnswer)}`);
    if (CATEGORY_LABELS[m.category]) out.push(`- **Mistake:** ${CATEGORY_LABELS[m.category]}`);
    if (escapeMarkdown(m.explanation)) out.push(`- **Why:** ${escapeMarkdown(m.explanation)}`);
    out.push('');
    for (const src of list(m.source).filter(s => isObj(s) && escapeMarkdown(s.quote))) {
      out.push('**The source says:**', '', `> ${escapeMarkdown(src.quote)}`);
      const line = sourceLine(src);
      if (line) out.push('>', line);
      out.push('');
    }
  });
  return `${out.join('\n').trimEnd()}\n`;
}

return {
  CATEGORIES, CATEGORY_LABELS, WEAK_LEVELS, REVIEW_OFFSETS,
  categorize, rankWeakTopics, nextReview, targetedNote, escapeMarkdown,
};
});

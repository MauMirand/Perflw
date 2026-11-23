'use strict';
/* IPC handlers for the Learning System: journeys, questions, assessments, mastery (LS-007, ADR-005).

   Thin on purpose: every handler checks the signed-in user, keeps only the keys it knows from ONE object argument, and calls
   the store (`workspace.learningStore()`), which owns all SQL and the ownership checks. No Electron import, so the module loads
   in tests with a fake `handle`.

   Answer keys never reach the renderer while an assessment is open: `studentAssessment` strips them and shuffles the options
   with the assessment seed (HO-019 §4.6). After submit the full snapshot is returned. */
const { randomBytes } = require('node:crypto');
const model = require('./assessment-model');
const mastery = require('./mastery-model');

const fail = message => { throw new Error(message); };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/* One object argument; unknown keys dropped. `keys` lists the keys this channel accepts. */
function pick(arg, keys, channel) {
  if (!isObj(arg)) fail(`${channel} needs one object argument.`);
  const out = {};
  for (const k of keys) if (arg[k] !== undefined) out[k] = arg[k];
  return out;
}
function needText(value, field, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field} is required (text of 1–${max} characters).`);
  return value;
}

const OPEN = ['draft', 'in_progress'];

/* The renderer's view of an assessment. While it is open: no answer key, no scores, shuffled options. */
function studentAssessment(assessment) {
  if (!assessment || !OPEN.includes(assessment.status)) return assessment;
  const seed = String((assessment.config && assessment.config.seed) || assessment.id);
  const { seed: _seed, ...config } = assessment.config || {};
  const items = assessment.items.map(item => {
    const snapshot = model.stripAnswerKey(item.snapshot);
    const payload = snapshot.payload || {};
    if (snapshot.type === 'choice') payload.options = model.shuffle(payload.options || [], `${seed}:${item.id}`);
    if (snapshot.type === 'matching') payload.right = model.shuffle(payload.right || [], `${seed}:${item.id}`);
    const a = item.answer;
    return {
      id: item.id, position: item.position, topicId: item.topicId, dimension: item.dimension, maxScore: item.maxScore,
      question: snapshot,
      answer: a ? { response: a.response, confidence: a.confidence, dontKnow: a.dontKnow, savedAt: a.savedAt } : null,
    };
  });
  return { ...assessment, config, items };
}

function registerLearningIpc({ handle, requireUser, workspace, now = () => Date.now() }) {
  const store = () => workspace.learningStore();
  const on = (channel, keys, work) => handle(channel, arg => {
    const user = requireUser();
    return work(user.id, pick(arg, keys, channel));
  });

  // ───────── journeys
  on('journey:list', ['subjectId'], (u, a) => store().listJourneys(u, a));
  on('journey:create', ['subjectId', 'title', 'topicIds', 'targetDate', 'parentId'], (u, a) => store().createJourney(u, a));
  on('journey:get', ['journeyId'], (u, a) => store().getJourney(u, a));
  on('journey:update', ['journeyId', 'stage', 'title', 'topicIds', 'targetDate', 'status'], (u, a) => store().updateJourney(u, a));

  // ───────── questions
  on('questions:list', ['subjectId', 'topicId', 'status', 'review'], (u, a) => store().listQuestions(u, a));
  on('questions:save', ['question'], (u, a) => store().saveQuestion(u, a));
  on('questions:retire', ['questionId'], (u, a) => store().retireQuestion(u, a));
  on('questions:delete', ['questionId'], (u, a) => store().deleteQuestion(u, a));

  // ───────── assessments
  on('assessment:create', ['subjectId', 'journeyId', 'kind', 'title', 'config'], (u, a) => {
    needText(a.subjectId, 'Subject');
    const kind = a.kind;
    if (!model.KINDS.includes(kind)) fail(`Kind must be one of: ${model.KINDS.join(', ')}.`);
    const c = isObj(a.config) ? a.config : {};
    const s = store();
    let topics = Array.isArray(c.topicIds) && c.topicIds.length ? c.topicIds : undefined;
    if (a.journeyId != null) topics = s.getJourney(u, { journeyId: a.journeyId }).topicIds;
    // A final never repeats a question of this journey's diagnostics (spec §4.1, parallel items).
    let exclude = [];
    if (kind === 'final' && a.journeyId != null) {
      for (const d of s.listAssessments(u, { subjectId: a.subjectId, journeyId: a.journeyId, kind: 'diagnostic' })) {
        exclude = exclude.concat(s.getAssessment(u, { assessmentId: d.id }).items.map(i => i.questionId).filter(Boolean));
      }
    }
    const seed = typeof c.seed === 'string' && c.seed ? c.seed.slice(0, 60) : randomBytes(8).toString('hex');
    const pool = s.listQuestions(u, { subjectId: a.subjectId, status: 'active' });
    const base = { questions: pool, topics, types: c.types, dimensions: c.dimensions, exclude, seed, kind };
    const available = model.selectItems(base).length;
    if (!available) fail('No questions are available yet. Add questions in the Question bank.');
    const requested = Number.isInteger(c.count) && c.count > 0 ? Math.min(c.count, 100) : available;
    const chosen = model.selectItems({ ...base, count: requested });
    const created = s.createAssessment(u, {
      subjectId: a.subjectId, journeyId: a.journeyId, kind, title: a.title,
      config: { count: requested, types: c.types, dimensions: c.dimensions, topicIds: topics, seed },
      questionIds: chosen.map(q => q.id),
    });
    return { assessment: studentAssessment(created), requested, available };
  });
  on('assessment:start', ['assessmentId'], (u, a) => studentAssessment(store().startAssessment(u, a)));
  on('assessment:list', ['subjectId', 'journeyId', 'kind', 'status'], (u, a) => store().listAssessments(u, a));
  on('assessment:get', ['assessmentId'], (u, a) => studentAssessment(store().getAssessment(u, a)));
  on('assessment:saveAnswer', ['itemId', 'response'], (u, a) => ({ savedAt: store().saveAnswer(u, a).savedAt }));
  on('assessment:submit', ['assessmentId'], (u, a) => store().submitAssessment(u, a));
  on('assessment:abandon', ['assessmentId'], (u, a) => studentAssessment(store().abandonAssessment(u, a)));
  on('assessment:grade', ['itemId', 'verdicts', 'grader'], (u, a) => {
    const grader = a.grader == null ? 'self' : a.grader;
    if (!['self', 'manual'].includes(grader)) fail('Grader must be self or manual.');
    return store().gradeOpenAnswer(u, { itemId: a.itemId, verdicts: a.verdicts, grader });
  });
  on('assessment:results', ['assessmentId'], (u, a) => {
    const assessment = store().getAssessment(u, a);
    if (!['submitted', 'graded'].includes(assessment.status)) fail('Submit the assessment to see results.');
    return assessment;
  });

  // ───────── mastery (one cycle only, D11)
  function topicLevels(u, journey) {
    const s = store();
    const rows = s.journeyEvidence(u, { journeyId: journey.id });
    const latestFinal = rows.filter(r => r.kind === 'final').reduce((m, r) => Math.max(m, r.attempt || 1), 0);
    const titles = new Map();
    try { for (const t of workspace.listTopics(u, journey.subjectId).rows) titles.set(String(t.id), t.title); } catch { /* titles are optional */ }
    return journey.topicIds.map(topicId => {
      const items = rows
        .filter(r => String(r.topicId) === String(topicId) && !(r.kind === 'final' && (r.attempt || 1) !== latestFinal))
        .map(r => ({ dimension: r.dimension, kind: r.kind, score: r.score, max: r.max, gradeStatus: r.gradeStatus, grader: r.grader,
          confidence: r.confidence || undefined, answeredAt: r.answeredAt, abandoned: r.assessmentStatus === 'abandoned' }))
        .filter(r => r.score !== null && r.score !== undefined);
      const result = mastery.topicLevel({ items, now: now() });
      return { topicId, title: titles.get(String(topicId)) || '', level: result.level, items: result.items, dimensions: result.dimensions, finalScore: result.finalScore };
    });
  }
  on('mastery:journey', ['journeyId'], (u, a) => {
    const journey = store().getJourney(u, a);
    return { journeyId: journey.id, cycle: journey.cycle, topics: topicLevels(u, journey) };
  });
  on('mastery:subject', ['subjectId'], (u, a) => {
    const journeys = store().listJourneys(u, a).filter(j => j.status !== 'archived');
    if (!journeys.length) return [];
    const journey = journeys[journeys.length - 1];
    return topicLevels(u, journey).map(t => ({ ...t, journeyId: journey.id, cycle: journey.cycle }));
  });
}

module.exports = { registerLearningIpc, studentAssessment };

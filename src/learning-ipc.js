'use strict';
/* IPC handlers for the Learning System: journeys, questions, assessments, exams, mastery (LS-007, LS-023, LS-034, ADR-005).

   Thin on purpose: every handler checks the signed-in user, keeps only the keys it knows from ONE object argument, and calls
   the store (`workspace.learningStore()`), which owns all SQL and the ownership checks. No Electron import, so the module loads
   in tests with a fake `handle`.

   Answer keys never reach the renderer while an assessment is open: `studentAssessment` strips them and shuffles the options
   with the assessment seed (HO-019 §4.6). After submit the full snapshot is returned. Timed finals are enforced here: a save
   after the deadline (plus the grace period) submits what was saved instead (spec §4.9). */
const { randomBytes } = require('node:crypto');
const model = require('./assessment-model');
const mastery = require('./mastery-model');
const exam = require('./exam-model');

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
function studentAssessment(assessment, secondsLeft = null) {
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
  return { ...assessment, config, items, secondsLeft };
}

const totals = assessment => assessment.items.reduce((t, i) => ({
  score: t.score + ((i.answer && i.answer.score) || 0), max: t.max + i.maxScore,
  pending: t.pending + (i.answer && i.answer.gradeStatus === 'pending' ? 1 : 0),
}), { score: 0, max: 0, pending: 0 });

function registerLearningIpc({ handle, requireUser, workspace, now = () => Date.now() }) {
  const store = () => workspace.learningStore();
  const on = (channel, keys, work) => handle(channel, arg => {
    const user = requireUser();
    return work(user.id, pick(arg, keys, channel));
  });
  const topicTitles = (u, subjectId) => {
    const titles = new Map();
    try { for (const t of workspace.listTopics(u, subjectId).rows) titles.set(String(t.id), t.title); } catch { /* titles are optional */ }
    return titles;
  };

  /* A timed assessment past its deadline is submitted with what was saved. Returns the (possibly submitted) assessment. */
  function enforceDeadline(u, assessment) {
    if (assessment.status !== 'in_progress' || !assessment.config || assessment.config.timeLimitSeconds == null) return assessment;
    if (!exam.expired({ config: assessment.config, startedAt: assessment.startedAt }, now())) return assessment;
    return store().submitAssessment(u, { assessmentId: assessment.id });
  }
  const left = assessment => exam.secondsLeft({ config: assessment.config, startedAt: assessment.startedAt }, now());
  const present = assessment => studentAssessment(assessment, assessment.status === 'in_progress' ? left(assessment) : null);

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

  // ───────── choosing the questions of an assessment (shared by create and the exam preview)
  function select(u, a) {
    needText(a.subjectId, 'Subject');
    const kind = a.kind;
    if (!model.KINDS.includes(kind)) fail(`Kind must be one of: ${model.KINDS.join(', ')}.`);
    const c = isObj(a.config) ? a.config : {};
    const s = store();
    let topics = Array.isArray(c.topicIds) && c.topicIds.length ? c.topicIds : undefined;
    if (a.journeyId != null) topics = s.getJourney(u, { journeyId: a.journeyId }).topicIds;
    // A final never repeats a question of this journey's diagnostics (spec §4.1, parallel items); a retake prefers questions
    // no earlier final used.
    const used = kindFilter => {
      let ids = [];
      if (a.journeyId == null) return ids;
      for (const x of s.listAssessments(u, { subjectId: a.subjectId, journeyId: a.journeyId, kind: kindFilter })) {
        if (x.status === 'abandoned') continue;
        ids = ids.concat(s.getAssessment(u, { assessmentId: x.id }).items.map(i => i.questionId).filter(Boolean));
      }
      return ids;
    };
    const exclude = kind === 'final' ? used('diagnostic') : [];
    const seed = typeof c.seed === 'string' && c.seed ? c.seed.slice(0, 60) : randomBytes(8).toString('hex');
    const pool = s.listQuestions(u, { subjectId: a.subjectId, status: 'active' });
    const base = { questions: pool, topics, types: c.types, dimensions: c.dimensions, seed, kind };
    const fresh = kind === 'final' && a.retakeOf != null ? exclude.concat(used('final')) : exclude;
    const available = model.selectItems({ ...base, exclude }).length;
    if (!available) fail('No questions are available yet. Add questions in the Question bank.');
    const requested = Number.isInteger(c.count) && c.count > 0 ? Math.min(c.count, 100) : available;
    let chosen = model.selectItems({ ...base, exclude: fresh, count: requested });
    if (chosen.length < requested && fresh !== exclude) chosen = model.selectItems({ ...base, exclude, count: requested }); // not enough new ones: reuse
    return { kind, c, topics, seed, requested, available, chosen };
  }
  const examOptions = c => ({ multiplier: c.timeMultiplier == null ? 1 : c.timeMultiplier, test: c.test === true });

  // ───────── assessments
  on('assessment:create', ['subjectId', 'journeyId', 'kind', 'title', 'config', 'retakeOf'], (u, a) => {
    const picked = select(u, a);
    const { kind, c, topics, seed, requested, available, chosen } = picked;
    let config = { count: requested, types: c.types, dimensions: c.dimensions, topicIds: topics, seed };
    if (kind === 'final') {
      if (a.retakeOf != null) {
        const previous = store().getAssessment(u, { assessmentId: a.retakeOf });
        if (!['submitted', 'graded'].includes(previous.status) || previous.kind !== 'final') fail('Assessment not found.');
        const result = exam.examResult(previous, totals(previous).score, totals(previous).max);
        if (result.passed !== false) fail('A retake is only for a final exam that was not passed.');
      }
      config = { ...config, ...exam.examConfigFor(chosen, examOptions(c)) };
    }
    const created = store().createAssessment(u, {
      subjectId: a.subjectId, journeyId: a.journeyId, kind, title: a.title, config, retakeOf: a.retakeOf, questionIds: chosen.map(q => q.id),
    });
    return { assessment: present(created), requested, available };
  });
  /* What a final would be, before it is created: how many questions are free, its time limit and pass mark. */
  on('exam:preview', ['subjectId', 'journeyId', 'config', 'retakeOf'], (u, a) => {
    const { c, requested, available, chosen } = select(u, { ...a, kind: 'final' });
    const test = c.test === true;
    const out = { requested, available, count: chosen.length, test, min: exam.DEFAULT_EXAM_CONFIG.items.min, max: exam.DEFAULT_EXAM_CONFIG.items.max };
    try { Object.assign(out, exam.examConfigFor(chosen, examOptions(c)), { ok: true }); } catch (error) { out.ok = false; out.problem = error.message; }
    return out;
  });
  on('assessment:start', ['assessmentId'], (u, a) => present(store().startAssessment(u, a)));
  on('assessment:list', ['subjectId', 'journeyId', 'kind', 'status'], (u, a) => store().listAssessments(u, a));
  on('assessment:get', ['assessmentId'], (u, a) => present(enforceDeadline(u, store().getAssessment(u, a))));
  on('assessment:saveAnswer', ['itemId', 'response'], (u, a) => {
    const owner = store().assessmentOfItem(u, { itemId: a.itemId });
    if (owner.status === 'in_progress' && enforceDeadline(u, owner) !== owner) fail('Time is up. Your saved answers were submitted.');
    return { savedAt: store().saveAnswer(u, a).savedAt };
  });
  on('assessment:submit', ['assessmentId'], (u, a) => store().submitAssessment(u, a));
  on('assessment:abandon', ['assessmentId'], (u, a) => present(store().abandonAssessment(u, a)));
  on('assessment:grade', ['itemId', 'verdicts', 'grader'], (u, a) => {
    const grader = a.grader == null ? 'self' : a.grader;
    if (!['self', 'manual'].includes(grader)) fail('Grader must be self or manual.');
    return store().gradeOpenAnswer(u, { itemId: a.itemId, verdicts: a.verdicts, grader });
  });
  /* Practice feedback (spec §4.5): grade one saved answer now and reveal its key. Nothing is stored here, and the key of
     the other questions stays hidden. */
  on('assessment:check', ['assessmentId', 'itemId'], (u, a) => {
    const assessment = store().getAssessment(u, { assessmentId: a.assessmentId });
    if (assessment.kind !== 'practice' || assessment.status !== 'in_progress') fail('Feedback after each question is only available in a practice set that is in progress.');
    const item = assessment.items.find(i => String(i.id) === String(a.itemId));
    if (!item) fail('Item not found.');
    const response = (item.answer && item.answer.response) || {};
    const g = model.grade(item.snapshot, { ...response, questionId: item.snapshot.id });
    const p = item.snapshot.payload || {};
    return {
      itemId: item.id, score: g.score, max: g.max, status: g.status, category: g.category || null,
      explanation: item.snapshot.explanation || '', source: item.snapshot.source || [],
      key: item.snapshot.type === 'choice' ? { correct: p.correct } : item.snapshot.type === 'truefalse' ? { correct: p.correct }
        : item.snapshot.type === 'matching' ? { pairs: p.pairs } : { modelAnswer: p.modelAnswer || '', rubric: p.rubric || [] },
    };
  });
  on('assessment:results', ['assessmentId'], (u, a) => {
    const assessment = store().getAssessment(u, a);
    if (!['submitted', 'graded'].includes(assessment.status)) fail('Submit the assessment to see results.');
    const t = totals(assessment);
    const out = { ...assessment, totals: t };
    if (assessment.kind === 'final') out.exam = { ...exam.examResult(assessment, t.score, t.max), provisional: t.pending > 0 };
    return out;
  });

  // ───────── exam attempts, side by side (spec §4.9 comparison)
  on('exam:attempts', ['subjectId', 'journeyId'], (u, a) => {
    const s = store(); const titles = topicTitles(u, a.subjectId);
    return s.listAssessments(u, { subjectId: a.subjectId, journeyId: a.journeyId, kind: 'final' })
      .filter(x => ['submitted', 'graded'].includes(x.status))
      .map(x => {
        const full = s.getAssessment(u, { assessmentId: x.id }); const t = totals(full);
        const byTopic = new Map();
        for (const i of full.items) {
          const row = byTopic.get(String(i.topicId)) || { score: 0, max: 0 };
          row.score += (i.answer && i.answer.score) || 0; row.max += i.maxScore; byTopic.set(String(i.topicId), row);
        }
        return {
          id: x.id, attempt: x.attempt, retakeOf: x.retakeOf, status: x.status, submittedAt: x.submittedAt,
          result: { ...exam.examResult(full, t.score, t.max), provisional: t.pending > 0 },
          topics: [...byTopic].map(([topicId, r]) => ({ topicId, title: titles.get(topicId) || '', percent: r.max ? Math.round((r.score / r.max) * 1000) / 10 : null })),
        };
      });
  });

  // ───────── mastery (one cycle only, D11)
  const evidenceItems = (rows, topicId, onlyKinds) => rows
    .filter(r => String(r.topicId) === String(topicId) && (!onlyKinds || onlyKinds.includes(r.kind)))
    .map(r => ({ dimension: r.dimension, kind: r.kind, score: r.score, max: r.max, gradeStatus: r.gradeStatus, grader: r.grader,
      confidence: r.confidence || undefined, answeredAt: r.answeredAt, abandoned: r.assessmentStatus === 'abandoned' }))
    .filter(r => r.score !== null && r.score !== undefined);
  const latestFinalOnly = rows => {
    const latest = rows.filter(r => r.kind === 'final').reduce((m, r) => Math.max(m, r.attempt || 1), 0);
    return rows.filter(r => !(r.kind === 'final' && (r.attempt || 1) !== latest));
  };
  function topicLevels(u, journey) {
    const rows = latestFinalOnly(store().journeyEvidence(u, { journeyId: journey.id }));
    const titles = topicTitles(u, journey.subjectId);
    return journey.topicIds.map(topicId => {
      const result = mastery.topicLevel({ items: evidenceItems(rows, topicId), now: now() });
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
  /* Pre-test vs final per topic and dimension (spec §3.7, §5.4 rule 6). `pre` = diagnostic answers only; `post` = the whole
     cycle with the latest final attempt. `provisional` while a counted open answer is not final. */
  on('mastery:report', ['journeyId'], (u, a) => {
    const journey = store().getJourney(u, a);
    const rows = latestFinalOnly(store().journeyEvidence(u, { journeyId: journey.id }));
    const titles = topicTitles(u, journey.subjectId);
    const at = now();
    const topics = journey.topicIds.map(topicId => {
      const pre = mastery.topicLevel({ items: evidenceItems(rows, topicId, ['diagnostic']), now: at });
      const post = mastery.topicLevel({ items: evidenceItems(rows, topicId), now: at });
      return {
        topicId, title: titles.get(String(topicId)) || '', pre: { level: pre.level, items: pre.items }, post: { level: post.level, items: post.items },
        improvement: mastery.improvement({ items: evidenceItems(rows, topicId), now: at }).dimensions,
      };
    });
    return { journeyId: journey.id, cycle: journey.cycle, topics, provisional: rows.some(r => r.gradeStatus === 'provisional') };
  });
}

module.exports = { registerLearningIpc, studentAssessment };

'use strict';
/* Learning store (LS-006): all SQL for the Learning System tables of migration 2 (src/learning-schema.js).
   Main process only. Spec: docs/LEARNING_SYSTEM_SPEC.md §4.6, §5.4 (D11), §6.2, §6.3; ADR-004, ADR-005, ADR-007.

   Every method takes (userId, { … }) and returns plain objects. Ownership is checked on every id the caller passes,
   including ids nested in the arguments, with `SELECT … WHERE id=? AND user_id=?`. A missing row and another
   account's row give the same "… not found." message, so ids cannot be probed.

   Rules live in the pure model (src/assessment-model.js): question validation, response normalization, grading.
   This module only stores. JSON columns are parsed defensively: an unreadable value becomes its default.
   No IPC, no file I/O, no AI. Note bodies are written elsewhere; this store keeps only the `body_file` name. */
const { randomUUID } = require('node:crypto');
const model = require('./assessment-model');
const { JOURNEY_STAGES } = require('./learning-schema');

const fail = message => { throw new Error(message); };
const now = () => new Date().toISOString();
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

const LIMITS = Object.freeze({
  payload: 32 * 1024, response: 32 * 1024, source: 8 * 1024, config: 32 * 1024, provenance: 8 * 1024,
  title: 180, summary: 2000, bodyFile: 200, section: 200, questionIds: 200, visited: 1000,
});
const JOURNEY_STATUSES = ['active', 'completed', 'archived'];
const SESSION_KINDS = ['main', 'supplementary', 'review'];
const MATERIAL_KINDS = ['targeted_note', 'side_note', 'side_note_ai', 'supplementary'];
const MANUAL_GRADERS = ['self', 'manual'];
const SNAPSHOT_FIELDS = ['id', 'subjectId', 'topicId', 'type', 'prompt', 'dimension', 'difficulty', 'explanation',
  'points', 'source', 'origin', 'provenance', 'status', 'review', 'payload'];

function parse(text, fallback) {
  if (typeof text !== 'string') return fallback;
  try {
    const value = JSON.parse(text);
    if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback;
    if (isObj(fallback)) return isObj(value) ? value : fallback;
    return value;
  } catch { return fallback; }
}
const args = value => (isObj(value) ? value : {});
const idText = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
function oneOf(value, list, label) {
  if (!list.includes(value)) fail(`${label} must be one of: ${list.join(', ')}.`);
  return value;
}
function cleanText(value, label, max, { fallback = '', min = 0 } = {}) {
  if (value == null) value = fallback;
  if (typeof value !== 'string') fail(`${label} must be text.`);
  const s = value.trim();
  if (s.length < min || s.length > max) fail(min ? `${label} must be 1–${max} characters.` : `${label} must be at most ${max} characters.`);
  return s;
}
function cleanDate(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`Enter a valid ${label}.`);
  return new Date(value).toISOString();
}
function capped(value, max, label) {
  if (bytes(value) > max) fail(`${label} is too large (at most ${Math.round(max / 1024)} KB).`);
  return JSON.stringify(value);
}

// ───────── row → plain object
const journeyOut = (row, topicIds) => ({
  id: row.id, subjectId: row.subject_id, title: row.title, stage: row.stage, status: row.status, cycle: row.cycle,
  parentId: row.parent_journey_id, targetDate: row.target_date, completedAt: row.completed_at,
  topicIds, createdAt: row.created_at, updatedAt: row.updated_at,
});
const questionOut = row => ({
  id: row.id, subjectId: row.subject_id, topicId: row.topic_id, type: row.type, prompt: row.prompt,
  dimension: row.dimension, difficulty: row.difficulty, explanation: row.explanation, points: row.points,
  source: parse(row.source, []), origin: row.origin, provenance: parse(row.provenance, null), status: row.status,
  review: row.review, payload: parse(row.payload, {}), reviewedAt: row.reviewed_at, used: row.used === 1, createdAt: row.created_at, updatedAt: row.updated_at,
});
const snapshotOf = question => Object.fromEntries(SNAPSHOT_FIELDS.map(field => [field, question[field]]));
const assessmentOut = row => ({
  id: row.id, subjectId: row.subject_id, journeyId: row.journey_id, kind: row.kind, title: row.title,
  config: parse(row.config, {}), status: row.status, attempt: row.attempt, retakeOf: row.retake_of,
  startedAt: row.started_at, submittedAt: row.submitted_at, gradedAt: row.graded_at, createdAt: row.created_at, updatedAt: row.updated_at,
});
const answerOut = row => (row ? {
  id: row.id, itemId: row.item_id, response: parse(row.response, {}), confidence: row.confidence, dontKnow: row.dont_know === 1,
  savedAt: row.saved_at, score: row.score, gradeStatus: row.grade_status, grader: row.grader, criteria: parse(row.criteria, null),
  feedback: parse(row.feedback, null), mistakeCategory: row.mistake_category, gradedAt: row.graded_at, attempt: row.attempt,
} : null);
const itemOut = (row, answer) => ({
  id: row.id, assessmentId: row.assessment_id, questionId: row.question_id, position: row.position, topicId: row.topic_id,
  dimension: row.dimension, maxScore: row.max_score, snapshot: parse(row.question_snapshot, {}), answer: answerOut(answer),
});
const sessionOut = row => ({
  id: row.id, subjectId: row.subject_id, journeyId: row.journey_id, topicId: row.topic_id, kind: row.kind,
  startedAt: row.started_at, endedAt: row.ended_at, focusEntryId: row.focus_entry_id, summary: row.summary,
  visited: visitedOf(row.visited), createdAt: row.created_at, updatedAt: row.updated_at,
});
function visitedOf(text) {
  const v = parse(text, {});
  return { sections: Array.isArray(v.sections) ? v.sections : [], materials: Array.isArray(v.materials) ? v.materials : [] };
}
const materialOut = row => ({
  id: row.id, subjectId: row.subject_id, journeyId: row.journey_id, topicId: row.topic_id, sessionId: row.session_id,
  kind: row.kind, parentMaterialId: row.parent_material_id, title: row.title, bodyFile: row.body_file,
  source: parse(row.source, []), origin: row.origin, provenance: parse(row.provenance, null), createdAt: row.created_at, updatedAt: row.updated_at,
});

function createLearningStore(db) {
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  function insert(table, values) {
    const columns = Object.keys(values);
    run(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...Object.values(values));
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = work(); db.exec('COMMIT'); return out; }
    catch (error) { try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
  }

  // ───────── ownership: one row of `table` owned by userId, else "<label> not found."
  function owned(table, label, userId, id) {
    const key = idText(id);
    const row = key && one(`SELECT * FROM ${table} WHERE id=? AND user_id=?`, key, userId);
    if (!row) fail(`${label} not found.`);
    return row;
  }
  const subjectOf = (userId, id) => owned('subjects', 'Subject', userId, id);
  function topicIn(userId, subjectId, id) {
    const row = owned('subject_topics', 'Topic', userId, id);
    if (row.subject_id !== subjectId) fail('Topic not found.');
    return row;
  }
  function journeyIn(userId, subjectId, id) {
    const row = owned('learning_journeys', 'Journey', userId, id);
    if (row.subject_id !== subjectId) fail('Journey not found.');
    return row;
  }
  const optional = (value, check) => (value == null || value === '' ? null : check(value).id);

  // ───────── journeys
  function journeyTopics(journeyId) {
    return all(`SELECT jt.topic_id FROM journey_topics jt JOIN subject_topics t ON t.id=jt.topic_id
      WHERE jt.journey_id=? ORDER BY t.position, t.id`, journeyId).map(r => r.topic_id);
  }
  function cleanTopicIds(userId, subjectId, topicIds) {
    if (!Array.isArray(topicIds)) fail('Topics must be a list.');
    const out = [];
    for (const id of topicIds) { const row = topicIn(userId, subjectId, id); if (!out.includes(row.id)) out.push(row.id); }
    return out;
  }
  function setJourneyTopics(userId, journeyId, topicIds, stamp) {
    run('DELETE FROM journey_topics WHERE journey_id=?', journeyId);
    for (const topicId of topicIds) insert('journey_topics', { journey_id: journeyId, topic_id: topicId, user_id: userId, created_at: stamp, updated_at: stamp });
  }
  function createJourney(userId, input) {
    const { subjectId, title, topicIds, targetDate, parentId } = args(input);
    const subject = subjectOf(userId, subjectId);
    const parent = parentId == null || parentId === '' ? null : journeyIn(userId, subject.id, parentId);
    const cycle = parent ? parent.cycle + 1 : 1;
    const topics = topicIds == null
      ? all("SELECT id FROM subject_topics WHERE user_id=? AND subject_id=? AND kind='topic' ORDER BY position, id", userId, subject.id).map(r => r.id)
      : cleanTopicIds(userId, subject.id, topicIds);
    const row = {
      id: randomUUID(), user_id: userId, subject_id: subject.id, title: cleanText(title, 'Journey title', LIMITS.title, { fallback: `Cycle ${cycle}`, min: 1 }),
      stage: 'material', status: 'active', cycle, parent_journey_id: parent ? parent.id : null,
      target_date: cleanDate(targetDate, 'target date'), created_at: now(),
    };
    row.updated_at = row.created_at;
    transaction(() => { insert('learning_journeys', row); setJourneyTopics(userId, row.id, topics, row.created_at); });
    return getJourney(userId, { journeyId: row.id });
  }
  function getJourney(userId, input) {
    const row = owned('learning_journeys', 'Journey', userId, args(input).journeyId);
    return journeyOut(row, journeyTopics(row.id));
  }
  function listJourneys(userId, input) {
    const subject = subjectOf(userId, args(input).subjectId);
    return all('SELECT * FROM learning_journeys WHERE user_id=? AND subject_id=? ORDER BY cycle, created_at, id', userId, subject.id)
      .map(row => journeyOut(row, journeyTopics(row.id)));
  }
  function updateJourney(userId, input) {
    const a = args(input);
    const row = owned('learning_journeys', 'Journey', userId, a.journeyId);
    const next = { ...row };
    if (a.stage !== undefined) next.stage = oneOf(a.stage, JOURNEY_STAGES, 'Stage');
    if (a.title !== undefined) next.title = cleanText(a.title, 'Journey title', LIMITS.title, { min: 1 });
    if (a.targetDate !== undefined) next.target_date = cleanDate(a.targetDate, 'target date');
    if (a.status !== undefined) {
      next.status = oneOf(a.status, JOURNEY_STATUSES, 'Status');
      if (next.status === 'completed' && row.status !== 'completed') next.completed_at = now();
      if (next.status !== 'completed') next.completed_at = null;
    }
    const topics = a.topicIds === undefined ? null : cleanTopicIds(userId, row.subject_id, a.topicIds);
    const stamp = now();
    transaction(() => {
      run('UPDATE learning_journeys SET stage=?,title=?,target_date=?,status=?,completed_at=?,updated_at=? WHERE id=? AND user_id=?',
        next.stage, next.title, next.target_date, next.status, next.completed_at, stamp, row.id, userId);
      if (topics) setJourneyTopics(userId, row.id, topics, stamp);
    });
    return getJourney(userId, { journeyId: row.id });
  }

  // ───────── questions
  function saveQuestion(userId, input) {
    const raw = args(input).question;
    if (!isObj(raw)) fail('question: must be an object.');
    const checked = model.validateQuestion({ ...raw, id: raw.id == null || raw.id === '' ? randomUUID() : raw.id });
    if (!checked.ok) fail(checked.errors.join(' '));
    const q = checked.value;
    const id = String(q.id);
    const existing = one('SELECT * FROM question_items WHERE id=?', id);
    if (existing && existing.user_id !== userId) fail('Question not found.');
    const subject = subjectOf(userId, String(q.subjectId));
    if (existing && existing.subject_id !== subject.id) fail('A question cannot move to another subject.');
    const topicId = q.topicId == null ? null : topicIn(userId, subject.id, String(q.topicId)).id;
    const payload = capped(q.payload, LIMITS.payload, 'The question payload');
    const source = capped(q.source, LIMITS.source, 'The question source');
    const provenance = q.provenance == null ? null : capped(q.provenance, LIMITS.provenance, 'The question provenance');
    const stamp = now();
    const reviewedAt = existing && existing.review === q.review ? existing.reviewed_at : q.review === 'unreviewed' ? null : stamp;
    const values = {
      subject_id: subject.id, topic_id: topicId, type: q.type, dimension: q.dimension, difficulty: q.difficulty, points: q.points,
      prompt: q.prompt, payload, explanation: q.explanation, source, origin: q.origin, provenance, status: q.status,
      review: q.review, reviewed_at: reviewedAt, updated_at: stamp,
    };
    if (existing) {
      // Only question_items changes; assessment_items.question_snapshot is never written here.
      const columns = Object.keys(values);
      run(`UPDATE question_items SET ${columns.map(c => `${c}=?`).join(',')} WHERE id=? AND user_id=?`, ...Object.values(values), id, userId);
    } else {
      insert('question_items', { id, user_id: userId, ...values, created_at: stamp });
    }
    return getQuestion(userId, { questionId: id });
  }
  // `used`: an assessment item references the question (it can then be retired, not deleted).
  const USED = 'EXISTS(SELECT 1 FROM assessment_items i WHERE i.question_id=q.id) AS used';
  function getQuestion(userId, input) {
    const row = owned('question_items', 'Question', userId, args(input).questionId);
    return questionOut(one(`SELECT q.*, ${USED} FROM question_items q WHERE q.id=?`, row.id));
  }
  function listQuestions(userId, input) {
    const { subjectId, topicId, status, review } = args(input);
    const subject = subjectOf(userId, subjectId);
    let sql = `SELECT q.*, ${USED} FROM question_items q WHERE q.user_id=? AND q.subject_id=?`;
    const params = [userId, subject.id];
    if (topicId != null) { sql += ' AND q.topic_id=?'; params.push(topicIn(userId, subject.id, topicId).id); }
    if (status != null) { sql += ' AND q.status=?'; params.push(oneOf(status, model.STATUSES, 'Status')); }
    if (review != null) { sql += ' AND q.review=?'; params.push(oneOf(review, model.REVIEWS, 'Review')); }
    return all(`${sql} ORDER BY q.created_at, q.id`, ...params).map(questionOut);
  }
  function retireQuestion(userId, input) {
    const row = owned('question_items', 'Question', userId, args(input).questionId);
    run("UPDATE question_items SET status='retired',updated_at=? WHERE id=? AND user_id=?", now(), row.id, userId);
    return getQuestion(userId, { questionId: row.id });
  }
  /* Only an unused question can be deleted; a used one is retired instead, so past assessments keep their link. */
  function deleteQuestion(userId, input) {
    const row = owned('question_items', 'Question', userId, args(input).questionId);
    if (one('SELECT 1 FROM assessment_items WHERE question_id=? LIMIT 1', row.id)) fail('This question was used in an assessment. Retire it instead.');
    run('DELETE FROM question_items WHERE id=? AND user_id=?', row.id, userId);
    return { id: row.id, deleted: true };
  }
  function setReview(userId, input) {
    const a = args(input);
    const row = owned('question_items', 'Question', userId, a.questionId);
    const review = oneOf(a.review, ['approved', 'rejected'], 'Review');
    const stamp = now();
    run('UPDATE question_items SET review=?,reviewed_at=?,updated_at=? WHERE id=? AND user_id=?', review, stamp, stamp, row.id, userId);
    return getQuestion(userId, { questionId: row.id });
  }

  // ───────── assessments
  function assessmentRow(userId, id) { return owned('assessments', 'Assessment', userId, id); }
  function itemRow(userId, id) { return owned('assessment_items', 'Item', userId, id); }
  function createAssessment(userId, input) {
    const a = args(input);
    const subject = subjectOf(userId, a.subjectId);
    const journeyId = optional(a.journeyId, id => journeyIn(userId, subject.id, id));
    const kind = oneOf(a.kind, model.KINDS, 'Kind');
    const title = cleanText(a.title, 'Assessment title', LIMITS.title);
    if (a.config != null && !isObj(a.config)) fail('Config must be an object.');
    const config = capped(a.config || {}, LIMITS.config, 'The assessment config');
    if (!Array.isArray(a.questionIds) || !a.questionIds.length) fail('Choose at least one question.');
    if (a.questionIds.length > LIMITS.questionIds) fail(`An assessment can have at most ${LIMITS.questionIds} questions.`);
    let retakeOf = null; let attempt = 1;
    if (a.retakeOf != null || a.attempt != null) {
      if (kind !== 'final') fail('Only a final exam can be a retake.');
      if (a.retakeOf != null) {
        const previous = assessmentRow(userId, a.retakeOf);
        if (previous.subject_id !== subject.id || previous.kind !== 'final') fail('Assessment not found.');
        retakeOf = previous.id; attempt = previous.attempt + 1;
      }
      if (a.attempt != null) {
        if (!Number.isInteger(a.attempt) || a.attempt < 1) fail('Attempt must be a whole number of 1 or more.');
        attempt = a.attempt;
      }
    }
    const strict = kind !== 'practice'; // D3, the selectItems rule
    const seen = new Set();
    const questions = a.questionIds.map(id => {
      const row = owned('question_items', 'Question', userId, id);
      if (row.subject_id !== subject.id) fail('Question not found.');
      if (seen.has(row.id)) fail('A question is listed more than once.');
      seen.add(row.id);
      if (row.status !== 'active') fail('A retired question cannot be used in a new assessment.');
      if (strict ? row.review !== 'approved' : row.review === 'rejected') {
        fail(strict ? `Only reviewed (approved) questions can be used in a ${kind} assessment.` : 'A rejected question cannot be used.');
      }
      return questionOut(row);
    });
    const stamp = now();
    const assessmentId = randomUUID();
    transaction(() => {
      insert('assessments', {
        id: assessmentId, user_id: userId, subject_id: subject.id, journey_id: journeyId, kind, title, config, status: 'draft',
        attempt, retake_of: retakeOf, created_at: stamp, updated_at: stamp,
      });
      questions.forEach((q, position) => insert('assessment_items', {
        id: randomUUID(), user_id: userId, assessment_id: assessmentId, question_id: q.id, position, topic_id: q.topicId,
        dimension: q.dimension, max_score: q.points, question_snapshot: JSON.stringify(snapshotOf(q)), created_at: stamp, updated_at: stamp,
      }));
    });
    return getAssessment(userId, { assessmentId });
  }
  /* Unstripped: snapshots include answer keys. LS-007 strips them before anything reaches the renderer. */
  function getAssessment(userId, input) {
    const row = assessmentRow(userId, args(input).assessmentId);
    const answers = new Map(all(`SELECT n.* FROM assessment_answers n JOIN assessment_items i ON i.id=n.item_id
      WHERE i.assessment_id=? AND n.user_id=?`, row.id, userId).map(n => [n.item_id, n]));
    const items = all('SELECT * FROM assessment_items WHERE assessment_id=? AND user_id=? ORDER BY position', row.id, userId)
      .map(item => itemOut(item, answers.get(item.id)));
    return { ...assessmentOut(row), items };
  }
  /* The assessment (without items) an item belongs to: lets a handler check the deadline before it saves one answer. */
  function assessmentOfItem(userId, input) {
    return assessmentOut(assessmentRow(userId, itemRow(userId, args(input).itemId).assessment_id));
  }
  function listAssessments(userId, input) {
    const { subjectId, journeyId, kind, status } = args(input);
    const subject = subjectOf(userId, subjectId);
    let sql = 'SELECT * FROM assessments WHERE user_id=? AND subject_id=?';
    const params = [userId, subject.id];
    if (journeyId != null) { sql += ' AND journey_id=?'; params.push(journeyIn(userId, subject.id, journeyId).id); }
    if (kind != null) { sql += ' AND kind=?'; params.push(oneOf(kind, model.KINDS, 'Kind')); }
    if (status != null) { sql += ' AND status=?'; params.push(oneOf(status, ['draft', 'in_progress', 'submitted', 'graded', 'abandoned'], 'Status')); }
    return all(`${sql} ORDER BY created_at, id`, ...params).map(assessmentOut);
  }
  function move(userId, input, from, to, extra = '') {
    const row = assessmentRow(userId, args(input).assessmentId);
    if (!from.includes(row.status)) fail(`This assessment is ${row.status.replace('_', ' ')}, so it cannot be ${to === 'in_progress' ? 'started' : to}.`);
    const stamp = now();
    run(`UPDATE assessments SET status=?,${extra}updated_at=? WHERE id=? AND user_id=?`, to, ...(extra ? [stamp] : []), stamp, row.id, userId);
    return getAssessment(userId, { assessmentId: row.id });
  }
  const startAssessment = (userId, input) => move(userId, input, ['draft'], 'in_progress', 'started_at=?,');
  const abandonAssessment = (userId, input) => move(userId, input, ['draft', 'in_progress'], 'abandoned');

  // ───────── answers
  function saveAnswer(userId, input) {
    const a = args(input);
    const item = itemRow(userId, a.itemId);
    const assessment = assessmentRow(userId, item.assessment_id);
    if (assessment.status !== 'in_progress') fail('Answers can only be saved while the assessment is in progress.');
    const response = model.normalizeResponse(parse(item.question_snapshot, {}), a.response);
    const text = capped(response, LIMITS.response, 'The answer');
    const stamp = now();
    run(`INSERT INTO assessment_answers (id,user_id,item_id,response,confidence,dont_know,saved_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET response=excluded.response, confidence=excluded.confidence,
      dont_know=excluded.dont_know, saved_at=excluded.saved_at, updated_at=excluded.updated_at`,
    randomUUID(), userId, item.id, text, response.confidence || null, response.dontKnow ? 1 : 0, stamp, stamp, stamp);
    return answerOut(one('SELECT * FROM assessment_answers WHERE item_id=? AND user_id=?', item.id, userId));
  }
  /* Practice retry (spec §4.5): a second try at a deterministic question, scored x0.5. Only attempt 2 is allowed, once. */
  function setAnswerAttempt(userId, input) {
    const item = itemRow(userId, args(input).itemId);
    const assessment = assessmentRow(userId, item.assessment_id);
    if (assessment.kind !== 'practice' || assessment.status !== 'in_progress') fail('A second try is only for a practice set in progress.');
    const answer = one('SELECT * FROM assessment_answers WHERE item_id=? AND user_id=?', item.id, userId);
    if (!answer) fail('Answer the question first.');
    if (answer.attempt >= 2) fail('You already used your second try on this question.');
    run('UPDATE assessment_answers SET attempt=2,updated_at=? WHERE id=?', now(), answer.id);
    return answerOut(one('SELECT * FROM assessment_answers WHERE id=?', answer.id));
  }
  function finishIfGraded(userId, assessmentId, stamp) {
    const pending = one("SELECT count(*) AS n FROM assessment_answers n JOIN assessment_items i ON i.id=n.item_id WHERE i.assessment_id=? AND n.grade_status='pending'", assessmentId).n;
    if (!pending) run("UPDATE assessments SET status='graded',graded_at=?,updated_at=? WHERE id=? AND user_id=?", stamp, stamp, assessmentId, userId);
  }
  function submitAssessment(userId, input) {
    const row = assessmentRow(userId, args(input).assessmentId);
    if (row.status !== 'in_progress') fail(`This assessment is ${row.status.replace('_', ' ')}, so it cannot be submitted.`);
    const stamp = now();
    transaction(() => {
      for (const item of all('SELECT * FROM assessment_items WHERE assessment_id=? AND user_id=? ORDER BY position', row.id, userId)) {
        const question = parse(item.question_snapshot, {});
        let answer = one('SELECT * FROM assessment_answers WHERE item_id=?', item.id);
        if (!answer) {
          insert('assessment_answers', { id: randomUUID(), user_id: userId, item_id: item.id, response: JSON.stringify(model.normalizeResponse(question, {})), saved_at: stamp, created_at: stamp, updated_at: stamp });
          answer = one('SELECT * FROM assessment_answers WHERE item_id=?', item.id);
        }
        const g = model.grade(question, parse(answer.response, {}));
        if (g.status === 'graded') {
          const category = ['not_known', 'not_answered'].includes(g.category) ? g.category : null;
          const score = answer.attempt === 2 ? Math.round(g.score * 50) / 100 : g.score; // a second try counts half (spec §4.5)
          run("UPDATE assessment_answers SET score=?,grade_status='final',grader='auto',mistake_category=?,graded_at=?,updated_at=? WHERE id=?", score, category, stamp, stamp, answer.id);
        } else {
          // Open answer (score null) or true/false with a justification (the deterministic half is kept).
          run("UPDATE assessment_answers SET score=?,grade_status='pending',grader=NULL,mistake_category=NULL,graded_at=NULL,updated_at=? WHERE id=?",
            question.type === 'truefalse' ? g.score : null, stamp, answer.id);
        }
      }
      run("UPDATE assessments SET status='submitted',submitted_at=?,updated_at=? WHERE id=? AND user_id=?", stamp, stamp, row.id, userId);
      finishIfGraded(userId, row.id, stamp);
    });
    return getAssessment(userId, { assessmentId: row.id });
  }
  /* The true/false half that was graded at submit. A provisional AI grade replaced the score with the total, so it is kept in feedback. */
  const deterministicHalf = answer => { const f = parse(answer.feedback, {}); return typeof f.deterministicHalf === 'number' ? f.deterministicHalf : (answer.grade_status === 'pending' ? answer.score || 0 : 0); };
  /* AI grade (ADR-007): per-criterion verdicts from the model; the SCORE IS COMPUTED HERE. Provisional until the student accepts or
     adjusts it. Low-confidence provisional grades are left out of mastery by the mastery model until accepted. */
  function setAiGrade(userId, input) {
    const a = args(input);
    const item = itemRow(userId, a.itemId); const assessment = assessmentRow(userId, item.assessment_id);
    if (assessment.status !== 'submitted' && assessment.status !== 'graded') fail('Open answers can only be graded after the assessment is submitted.');
    const answer = one('SELECT * FROM assessment_answers WHERE item_id=? AND user_id=?', item.id, userId);
    if (!answer || !['pending', 'provisional'].includes(answer.grade_status)) fail('This answer is not waiting for a grade.');
    const question = parse(item.question_snapshot, {});
    const rubric = model.rubricOf(question);
    if (!rubric.length || !Array.isArray(a.verdicts)) fail('This answer has no rubric to grade.');
    const given = new Map(a.verdicts.filter(isObj).map(v => [String(v.id), v]));
    const criteria = rubric.map(row => { const v = given.get(String(row.id)); return { id: String(row.id), verdict: v && Object.prototype.hasOwnProperty.call(model.VERDICTS, v.verdict) ? v.verdict : 'missing' }; });
    const half = deterministicHalf(answer);
    const part = model.scoreFromCriteria(question, criteria);
    const score = Math.round(((question.type === 'truefalse' ? half : 0) + part) * 100) / 100;
    const confidence = ['low', 'medium', 'high'].includes(a.confidence) ? a.confidence : 'low';
    const feedback = JSON.stringify({ confidence, provenance: isObj(a.provenance) ? a.provenance : null, reasons: Object.fromEntries([...given].map(([id, v]) => [id, String(v.reason || '').slice(0, 300)])), deterministicHalf: half });
    const stamp = now();
    transaction(() => {
      run("UPDATE assessment_answers SET score=?,grade_status='provisional',grader='ai',criteria=?,feedback=?,graded_at=?,updated_at=? WHERE id=?", score, JSON.stringify(criteria), feedback, stamp, stamp, answer.id);
      finishIfGraded(userId, assessment.id, stamp);
    });
    return answerOut(one('SELECT * FROM assessment_answers WHERE id=?', answer.id));
  }
  function acceptAiGrade(userId, input) {
    const item = itemRow(userId, args(input).itemId);
    const answer = one('SELECT * FROM assessment_answers WHERE item_id=? AND user_id=?', item.id, userId);
    if (!answer || answer.grade_status !== 'provisional' || answer.grader !== 'ai') fail('There is no AI grade to accept on this answer.');
    run("UPDATE assessment_answers SET grade_status='final',grader='ai_accepted',updated_at=? WHERE id=?", now(), answer.id);
    return answerOut(one('SELECT * FROM assessment_answers WHERE id=?', answer.id));
  }
  function gradeOpenAnswer(userId, input) {
    const a = args(input);
    const item = itemRow(userId, a.itemId);
    const assessment = assessmentRow(userId, item.assessment_id);
    const grader = oneOf(a.grader, MANUAL_GRADERS, 'Grader');
    if (!['submitted', 'graded'].includes(assessment.status)) fail('Open answers can only be graded after the assessment is submitted.');
    const answer = one('SELECT * FROM assessment_answers WHERE item_id=? AND user_id=?', item.id, userId);
    // Once everything is graded only a provisional AI grade can still be adjusted.
    if (assessment.status === 'graded' && !(answer && answer.grade_status === 'provisional')) fail('Open answers can only be graded after the assessment is submitted.');
    if (!answer || !['pending', 'provisional'].includes(answer.grade_status)) fail('This answer is not waiting for a grade.');
    const question = parse(item.question_snapshot, {});
    const rubric = model.rubricOf(question);
    if (!rubric.length) fail('This answer has no rubric to grade.');
    if (!Array.isArray(a.verdicts) && !isObj(a.verdicts)) fail('Verdicts must be a list of { id, verdict }.');
    const given = new Map(Array.isArray(a.verdicts)
      ? a.verdicts.filter(isObj).map(v => [String(v.id), v.verdict]) : Object.entries(a.verdicts));
    const criteria = rubric.map(row => {
      const verdict = given.get(String(row.id));
      return { id: String(row.id), verdict: Object.prototype.hasOwnProperty.call(model.VERDICTS, verdict) ? verdict : 'missing' };
    });
    const part = model.scoreFromCriteria(question, criteria);
    const score = Math.round(((question.type === 'truefalse' ? deterministicHalf(answer) : 0) + part) * 100) / 100;
    const stamp = now();
    // Adjusting an AI grade keeps what the AI said, for audit (spec §4.4).
    const feedback = answer.grade_status === 'provisional' ? JSON.stringify({ ...parse(answer.feedback, {}), original: parse(answer.criteria, null), adjustedAt: stamp }) : answer.feedback;
    transaction(() => {
      run("UPDATE assessment_answers SET score=?,grade_status='final',grader=?,criteria=?,feedback=?,graded_at=?,updated_at=? WHERE id=?",
        score, grader, JSON.stringify(criteria), feedback, stamp, stamp, answer.id);
      finishIfGraded(userId, assessment.id, stamp);
    });
    return answerOut(one('SELECT * FROM assessment_answers WHERE id=?', answer.id));
  }

  // ───────── sessions and materials
  function startSession(userId, input) {
    const a = args(input);
    const subject = subjectOf(userId, a.subjectId);
    const stamp = now();
    const row = {
      id: randomUUID(), user_id: userId, subject_id: subject.id, journey_id: optional(a.journeyId, id => journeyIn(userId, subject.id, id)),
      topic_id: optional(a.topicId, id => topicIn(userId, subject.id, id)), kind: oneOf(a.kind, SESSION_KINDS, 'Session kind'),
      started_at: stamp, created_at: stamp, updated_at: stamp,
    };
    insert('learning_sessions', row);
    return sessionOut(one('SELECT * FROM learning_sessions WHERE id=?', row.id));
  }
  function runningSession(userId, id) {
    const row = owned('learning_sessions', 'Session', userId, id);
    if (row.ended_at) fail('This study session has already ended.');
    return row;
  }
  function endSession(userId, input) {
    const a = args(input);
    const row = runningSession(userId, a.sessionId);
    const summary = cleanText(a.summary, 'Summary', LIMITS.summary);
    const stamp = a.endedAt ? cleanDate(a.endedAt, 'end time') : now();
    let focusEntryId = null;
    if (a.focusEntryId != null && a.focusEntryId !== '') focusEntryId = owned('focus_entries', 'Time entry', userId, a.focusEntryId).id;
    run('UPDATE learning_sessions SET ended_at=?,summary=?,focus_entry_id=?,updated_at=? WHERE id=? AND user_id=?', stamp, summary, focusEntryId, stamp, row.id, userId);
    return sessionOut(one('SELECT * FROM learning_sessions WHERE id=?', row.id));
  }
  const sessionRow = (userId, id) => owned('learning_sessions', 'Session', userId, id);
  const getSession = (userId, input) => sessionOut(sessionRow(userId, args(input).sessionId));
  /* The account's open (not ended) study session, if any. */
  function activeSession(userId) {
    const row = one('SELECT * FROM learning_sessions WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', userId);
    return row ? sessionOut(row) : null;
  }
  /* Last activity = updated_at: every note, visit and heartbeat refreshes it. */
  function touchSession(userId, input) {
    const row = runningSession(userId, args(input).sessionId);
    run('UPDATE learning_sessions SET updated_at=? WHERE id=? AND user_id=?', now(), row.id, userId);
    return sessionOut(one('SELECT * FROM learning_sessions WHERE id=?', row.id));
  }
  /* A session that was just created and never used (its timer could not start). Refused once it has notes or has ended. */
  function discardSession(userId, input) {
    const row = runningSession(userId, args(input).sessionId);
    if (one('SELECT 1 FROM learning_materials WHERE session_id=? LIMIT 1', row.id)) fail('This session already has notes.');
    run('DELETE FROM learning_sessions WHERE id=? AND user_id=?', row.id, userId);
    return { id: row.id, deleted: true };
  }
  /* Study sessions of a subject, optionally only one kind and only those that started at or after `since` (ISO time). */
  function listSessions(userId, input) {
    const a = args(input); const subject = subjectOf(userId, a.subjectId);
    let sql = 'SELECT * FROM learning_sessions WHERE user_id=? AND subject_id=?'; const params = [userId, subject.id];
    if (a.kind != null) { sql += ' AND kind=?'; params.push(oneOf(a.kind, SESSION_KINDS, 'Session kind')); }
    const since = cleanDate(a.since, 'start time'); if (since) { sql += ' AND started_at>=?'; params.push(since); }
    return all(`${sql} ORDER BY started_at, id`, ...params).map(sessionOut);
  }
  function sessionMaterials(userId, input) {
    const a = args(input); const row = sessionRow(userId, a.sessionId);
    let sql = 'SELECT * FROM learning_materials WHERE user_id=? AND session_id=?'; const params = [userId, row.id];
    if (a.kind != null) { sql += ' AND kind=?'; params.push(oneOf(a.kind, MATERIAL_KINDS, 'Material kind')); }
    return all(`${sql} ORDER BY created_at, id`, ...params).map(materialOut);
  }
  // ───────── review queue (Leitner boxes, spec §5.3): one row per account and question
  function recordReview(userId, input) {
    const a = args(input);
    const question = owned('question_items', 'Question', userId, a.questionId);
    if (!Number.isInteger(a.box) || a.box < 1 || a.box > 5) fail('Box must be a whole number from 1 to 5.');
    const dueOn = cleanDate(a.dueOn, 'due date');
    if (!dueOn) fail('Enter a valid due date.');
    const stamp = now();
    run(`INSERT INTO question_review (user_id,question_id,box,due_on,last_result,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(user_id,question_id) DO UPDATE SET box=excluded.box,due_on=excluded.due_on,last_result=excluded.last_result,updated_at=excluded.updated_at`,
    userId, question.id, a.box, dueOn.slice(0, 10), a.lastResult === 'correct' ? 'correct' : 'wrong', stamp, stamp);
    return reviewOut(one('SELECT * FROM question_review WHERE user_id=? AND question_id=?', userId, question.id));
  }
  const reviewOut = row => ({ questionId: row.question_id, box: row.box, dueOn: row.due_on, lastResult: row.last_result });
  function getReview(userId, input) {
    const row = one('SELECT * FROM question_review WHERE user_id=? AND question_id=?', userId, owned('question_items', 'Question', userId, args(input).questionId).id);
    return row ? reviewOut(row) : null;
  }
  /* Active questions of a subject whose review is due on or before `today` (YYYY-MM-DD), oldest first. */
  function dueReviews(userId, input) {
    const a = args(input); const subject = subjectOf(userId, a.subjectId);
    const day = cleanDate(a.today, 'date');
    if (!day) fail('Enter a valid date.');
    return all(`SELECT r.* FROM question_review r JOIN question_items q ON q.id=r.question_id
      WHERE r.user_id=? AND q.subject_id=? AND q.status='active' AND r.due_on<=? ORDER BY r.due_on, r.question_id`, userId, subject.id, day.slice(0, 10)).map(reviewOut);
  }
  // ───────── scheduled learning (ADR-008): a calendar event plus a link row, created in ONE transaction
  const SCHEDULE_KINDS = ['session', 'practice', 'retention', 'final'];
  const scheduleOut = row => ({ id: row.id, eventId: row.event_id, journeyId: row.journey_id, kind: row.kind, topicIds: parse(row.topic_ids, []), title: row.title, startsAt: row.starts_at, endsAt: row.ends_at });
  /* `makeEvent()` creates the calendar event on this same connection and returns its id. If the link cannot be written, the event
     is rolled back with it, so a half-scheduled session never exists. */
  function createSchedule(userId, input) {
    const a = args(input);
    const journey = owned('learning_journeys', 'Journey', userId, a.journeyId);
    const kind = oneOf(a.kind, SCHEDULE_KINDS, 'Schedule kind');
    const topicIds = a.topicIds == null ? [] : cleanTopicIds(userId, journey.subject_id, a.topicIds);
    if (typeof a.makeEvent !== 'function') fail('The event could not be created.');
    const linkId = randomUUID();
    transaction(() => {
      const eventId = a.makeEvent();
      const stamp = now();
      insert('learning_schedule', { id: linkId, user_id: userId, event_id: eventId, journey_id: journey.id, kind, topic_ids: JSON.stringify(topicIds), created_at: stamp, updated_at: stamp });
    });
    return listScheduleRows(userId, 'ls.id=?', linkId)[0];
  }
  function listScheduleRows(userId, where, ...params) {
    return all(`SELECT ls.*, e.title, e.starts_at, e.ends_at FROM learning_schedule ls JOIN events e ON e.id=ls.event_id WHERE ls.user_id=? AND ${where} ORDER BY e.starts_at, ls.id`, userId, ...params).map(scheduleOut);
  }
  function listSchedule(userId, input) {
    const subject = subjectOf(userId, args(input).subjectId);
    return all(`SELECT ls.*, e.title, e.starts_at, e.ends_at FROM learning_schedule ls JOIN events e ON e.id=ls.event_id JOIN learning_journeys j ON j.id=ls.journey_id
      WHERE ls.user_id=? AND j.subject_id=? ORDER BY e.starts_at, ls.id`, userId, subject.id).map(scheduleOut);
  }
  function getSchedule(userId, input) {
    const row = owned('learning_schedule', 'Scheduled session', userId, args(input).scheduleId);
    return listScheduleRows(userId, 'ls.id=?', row.id)[0];
  }
  /* Editing a scheduled item: `updateEvent()` changes the calendar event on this same connection; the link's kind changes with it,
     in ONE transaction, so the calendar and the learning link never disagree. */
  function updateSchedule(userId, input) {
    const a = args(input);
    const row = owned('learning_schedule', 'Scheduled session', userId, a.scheduleId);
    const kind = oneOf(a.kind, SCHEDULE_KINDS, 'Schedule kind');
    if (typeof a.updateEvent !== 'function') fail('The event could not be changed.');
    transaction(() => {
      a.updateEvent(row.event_id);
      run('UPDATE learning_schedule SET kind=?, updated_at=? WHERE id=? AND user_id=?', kind, now(), row.id, userId);
    });
    return listScheduleRows(userId, 'ls.id=?', row.id)[0];
  }
  /* Study time of a subject: the sum of the focus entries its learning sessions saved (ADR-006, D2). */
  function studySeconds(userId, input) {
    const subject = subjectOf(userId, args(input).subjectId);
    return one('SELECT COALESCE(SUM(f.duration_seconds),0) AS s FROM learning_sessions ls JOIN focus_entries f ON f.id=ls.focus_entry_id WHERE ls.user_id=? AND ls.subject_id=?', userId, subject.id).s;
  }
  /* System use only (quit and crash recovery in main.js): every open session of every account. Not an IPC channel. */
  function listOpenSessions() {
    return all('SELECT id, user_id, started_at, updated_at, subject_id FROM learning_sessions WHERE ended_at IS NULL')
      .map(r => ({ id: r.id, userId: r.user_id, startedAt: r.started_at, updatedAt: r.updated_at, subjectId: r.subject_id }));
  }
  function markVisited(userId, input) {
    const a = args(input);
    const row = runningSession(userId, a.sessionId);
    const visited = visitedOf(row.visited);
    const sectionKeys = new Set(visited.sections.map(s => `${s && s.fileId}\u0000${s && s.section}`));
    for (const raw of a.sections == null ? [] : Array.isArray(a.sections) ? a.sections : fail('Sections must be a list.')) {
      if (!isObj(raw)) fail('Each section must be { fileId, section }.');
      const file = owned('subject_files', 'File', userId, raw.fileId);
      if (file.subject_id !== row.subject_id) fail('File not found.');
      const section = cleanText(raw.section, 'Section', LIMITS.section);
      const k = `${file.id}\u0000${section}`;
      if (!sectionKeys.has(k)) { sectionKeys.add(k); visited.sections.push({ fileId: file.id, section }); }
    }
    for (const id of a.materials == null ? [] : Array.isArray(a.materials) ? a.materials : fail('Materials must be a list.')) {
      const material = owned('learning_materials', 'Material', userId, id);
      if (material.subject_id !== row.subject_id) fail('Material not found.');
      if (!visited.materials.includes(material.id)) visited.materials.push(material.id);
    }
    if (visited.sections.length + visited.materials.length > LIMITS.visited) fail('This session has too many visited entries.');
    run('UPDATE learning_sessions SET visited=?,updated_at=? WHERE id=? AND user_id=?', JSON.stringify(visited), now(), row.id, userId);
    return sessionOut(one('SELECT * FROM learning_sessions WHERE id=?', row.id));
  }
  function addMaterial(userId, input) {
    const a = args(input);
    const subject = subjectOf(userId, a.subjectId);
    const kind = oneOf(a.kind, MATERIAL_KINDS, 'Material kind');
    let parent = null;
    if (a.parentMaterialId != null && a.parentMaterialId !== '') {
      parent = owned('learning_materials', 'Material', userId, a.parentMaterialId);
      if (parent.subject_id !== subject.id) fail('Material not found.');
    }
    if (kind === 'side_note_ai' && !parent) fail('An AI side note needs the side note it belongs to.');
    let sessionId = null;
    if (a.sessionId != null && a.sessionId !== '') {
      const session = owned('learning_sessions', 'Session', userId, a.sessionId);
      if (session.subject_id !== subject.id) fail('Session not found.');
      sessionId = session.id;
    }
    const bodyFile = a.bodyFile == null || a.bodyFile === '' ? null : cleanText(a.bodyFile, 'Body file', LIMITS.bodyFile, { min: 1 });
    if (bodyFile && (/[\\/:\0]/.test(bodyFile) || bodyFile.startsWith('.'))) fail('Body file must be a plain file name.');
    if (a.source != null && !Array.isArray(a.source)) fail('Source must be a list.');
    if (a.provenance != null && !isObj(a.provenance)) fail('Provenance must be an object.');
    const stamp = now();
    const row = {
      id: randomUUID(), user_id: userId, subject_id: subject.id, journey_id: optional(a.journeyId, id => journeyIn(userId, subject.id, id)),
      topic_id: optional(a.topicId, id => topicIn(userId, subject.id, id)), session_id: sessionId, kind, parent_material_id: parent ? parent.id : null,
      title: cleanText(a.title, 'Material title', LIMITS.title), body_file: bodyFile,
      source: capped(a.source || [], LIMITS.source, 'The material source'),
      origin: a.origin == null ? 'manual' : oneOf(a.origin, model.ORIGINS, 'Origin'),
      provenance: a.provenance == null ? null : capped(a.provenance, LIMITS.provenance, 'The material provenance'), // ADR-007: kept as given
      created_at: stamp, updated_at: stamp,
    };
    insert('learning_materials', row);
    return getMaterial(userId, { materialId: row.id });
  }
  function getMaterial(userId, input) {
    return materialOut(owned('learning_materials', 'Material', userId, args(input).materialId));
  }
  function listMaterials(userId, input) {
    const { journeyId, topicId, kind } = args(input);
    const journey = owned('learning_journeys', 'Journey', userId, journeyId);
    let sql = 'SELECT * FROM learning_materials WHERE user_id=? AND journey_id=?';
    const params = [userId, journey.id];
    if (topicId != null) { sql += ' AND topic_id=?'; params.push(topicIn(userId, journey.subject_id, topicId).id); }
    if (kind != null) { sql += ' AND kind=?'; params.push(oneOf(kind, MATERIAL_KINDS, 'Material kind')); }
    return all(`${sql} ORDER BY created_at, id`, ...params).map(materialOut);
  }

  // ───────── evidence for mastery (D11: one cycle = one journey; earlier cycles stay stored, never returned here)
  /* Answers of submitted or graded assessments of this journey. Unsubmitted (draft, in progress) and abandoned
     attempts are not evidence (spec §5.4). Pending answers come back with score null. */
  function journeyEvidence(userId, input) {
    const journey = owned('learning_journeys', 'Journey', userId, args(input).journeyId);
    return all(`SELECT a.id AS assessment_id, a.kind, a.attempt, i.question_id, i.topic_id, i.dimension, i.max_score,
        n.score, n.grade_status, n.grader, n.confidence, n.dont_know, n.mistake_category, n.saved_at, n.feedback
      FROM assessment_answers n
      JOIN assessment_items i ON i.id=n.item_id
      JOIN assessments a ON a.id=i.assessment_id
      WHERE a.journey_id=? AND a.user_id=? AND n.user_id=? AND a.status IN ('submitted','graded')
      ORDER BY a.created_at, a.id, i.position`, journey.id, userId, userId).map(r => ({
      assessmentId: r.assessment_id, kind: r.kind, attempt: r.attempt, questionId: r.question_id, topicId: r.topic_id,
      dimension: r.dimension, score: r.grade_status === 'pending' ? null : r.score, max: r.max_score, gradeStatus: r.grade_status,
      grader: r.grader, confidence: r.confidence, dontKnow: r.dont_know === 1, mistakeCategory: r.mistake_category, answeredAt: r.saved_at,
      ...(r.grader === 'ai' ? { aiConfidence: parse(r.feedback, {}).confidence || 'low' } : {}),
    }));
  }

  return {
    createJourney, getJourney, listJourneys, updateJourney,
    saveQuestion, getQuestion, listQuestions, retireQuestion, deleteQuestion, setReview,
    createAssessment, startAssessment, getAssessment, assessmentOfItem, listAssessments, abandonAssessment,
    saveAnswer, setAnswerAttempt, submitAssessment, gradeOpenAnswer, setAiGrade, acceptAiGrade,
    startSession, endSession, markVisited, addMaterial, getMaterial, listMaterials,
    getSession, listSessions, activeSession, touchSession, discardSession, sessionMaterials, listOpenSessions,
    recordReview, getReview, dueReviews, studySeconds, createSchedule, listSchedule, getSchedule, updateSchedule,
    journeyEvidence,
  };
}

module.exports = { createLearningStore, LIMITS };

'use strict';
/* LS-006: the learning store (src/learning-store.js). In-memory v2 databases as the app opens them, plus one
   workspace on disk for the subject-delete cascade. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createWorkspace, WORKSPACE_MIGRATIONS } = require('../src/workspace');
const { createLearningStore } = require('../src/learning-store');
const { LEARNING_TABLES } = require('../src/learning-schema');
const model = require('../src/assessment-model');

const T = '2026-11-23T10:00:00.000Z';
const stamps = { created_at: T, updated_at: T };
function insert(db, table, values) {
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values));
}
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

/* Users u (subjects s1, s2) and v (subject sv). Topics t1, t2 in s1; t3 in s2; tv in sv; a milestone m1 in s1. */
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of WORKSPACE_MIGRATIONS) migration.up(db);
  for (const [id, user] of [['s1', 'u'], ['s2', 'u'], ['sv', 'v']]) insert(db, 'subjects', { id, user_id: user, profile: 'study', name: id, ...stamps });
  const topics = [['t1', 'u', 's1', 'topic', 0], ['t2', 'u', 's1', 'topic', 1], ['m1', 'u', 's1', 'milestone', 2], ['t3', 'u', 's2', 'topic', 0], ['tv', 'v', 'sv', 'topic', 0]];
  for (const [id, user, subject, kind, position] of topics) insert(db, 'subject_topics', { id, user_id: user, subject_id: subject, kind, title: id, position, ...stamps });
  insert(db, 'subject_files', { id: 'f1', user_id: 'u', subject_id: 's1', name: 'a.pdf', stored_name: 'a', type: 'pdf', size: 1, created_at: T });
  return { db, store: createLearningStore(db) };
}

const choice = (extra = {}) => ({
  subjectId: 's1', topicId: 't1', type: 'choice', prompt: 'Pick B', dimension: 'recognition', difficulty: 2,
  payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['b'] }, ...extra,
});
const explain = (extra = {}) => ({
  subjectId: 's1', topicId: 't2', type: 'explain', prompt: 'Explain', dimension: 'understanding', difficulty: 2,
  payload: { rubric: [{ id: 'c1', criterion: 'Names it', points: 2 }, { id: 'c2', criterion: 'Says why', points: 2 }] }, ...extra,
});
const generated = (extra = {}) => choice({ origin: 'generated', provenance: { provider: 'p', model: 'm', generatedAt: T }, ...extra });

function started(store, questionIds, extra = {}) {
  const a = store.createAssessment('u', { subjectId: 's1', kind: 'practice', config: {}, questionIds, ...extra });
  return store.startAssessment('u', { assessmentId: a.id });
}

test('journeys: defaults, cycles, topics, stage and status', () => {
  const { store } = setup();
  const j1 = store.createJourney('u', { subjectId: 's1' });
  assert.equal(j1.title, 'Cycle 1');
  assert.equal(j1.cycle, 1);
  assert.equal(j1.stage, 'material');
  assert.deepEqual(j1.topicIds, ['t1', 't2'], 'default = every topic (not milestones) of the subject');
  const j2 = store.createJourney('u', { subjectId: 's1', parentId: j1.id, topicIds: ['t2'], targetDate: '2026-12-24' });
  assert.equal(j2.cycle, 2);
  assert.equal(j2.title, 'Cycle 2');
  assert.equal(j2.parentId, j1.id);
  assert.deepEqual(j2.topicIds, ['t2']);
  assert.deepEqual(store.listJourneys('u', { subjectId: 's1' }).map(j => j.id), [j1.id, j2.id]);
  assert.throws(() => store.createJourney('u', { subjectId: 's2', parentId: j1.id }), /Journey not found/);
  assert.throws(() => store.createJourney('u', { subjectId: 's1', topicIds: ['t3'] }), /Topic not found/);

  const moved = store.updateJourney('u', { journeyId: j1.id, stage: 'pretest', topicIds: ['t1'], status: 'completed' });
  assert.equal(moved.stage, 'pretest');
  assert.deepEqual(moved.topicIds, ['t1']);
  assert.ok(moved.completedAt);
  assert.throws(() => store.updateJourney('u', { journeyId: j1.id, stage: 'next_cycle' }), /Stage must be one of/);
  assert.throws(() => store.updateJourney('u', { journeyId: j1.id, topicIds: ['t3'] }), /Topic not found/);
  assert.equal(store.updateJourney('u', { journeyId: j1.id, status: 'active' }).completedAt, null);
});

test('questions: save, validate, caps, list, retire, review', () => {
  const { store } = setup();
  const q = store.saveQuestion('u', { question: choice() });
  assert.match(q.id, /^[0-9a-f-]{36}$/);
  assert.equal(q.review, 'approved');
  assert.equal(q.points, 1);
  assert.deepEqual(q.payload.correct, ['b']);

  const bad = () => store.saveQuestion('u', { question: choice({ prompt: '', payload: { options: [{ id: 'a', text: 'A' }], correct: [] } }) });
  assert.throws(bad, error => /prompt: is required\./.test(error.message) && /payload\.options: must have 2–8 items/.test(error.message));
  assert.throws(() => store.saveQuestion('u', { question: choice({ topicId: 't3' }) }), /Topic not found/);

  // Within every field limit of validateQuestion, but over 32 KB as UTF-8 (each emoji is 2 characters, 4 bytes).
  const wide = n => '\u{1F600}'.repeat(n / 2);
  const options = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, text: 'x'.repeat(500) }));
  const rubric = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, criterion: wide(500), keywords: Array.from({ length: 20 }, () => wide(100)) }));
  assert.throws(() => store.saveQuestion('u', { question: { ...explain({ type: 'essay' }), points: 8, payload: { rubric } } }), /payload is too large/);
  assert.ok(store.saveQuestion('u', { question: choice({ payload: { options, correct: ['o1'] } }) }));

  const g = store.saveQuestion('u', { question: generated() });
  assert.equal(g.review, 'unreviewed');
  assert.equal(g.reviewedAt, null);
  assert.deepEqual(store.listQuestions('u', { subjectId: 's1', review: 'unreviewed' }).map(x => x.id), [g.id]);
  assert.throws(() => store.setReview('u', { questionId: g.id, review: 'unreviewed' }), /Review must be one of: approved, rejected/);
  const approved = store.setReview('u', { questionId: g.id, review: 'approved' });
  assert.equal(approved.review, 'approved');
  assert.ok(approved.reviewedAt);
  assert.equal(store.retireQuestion('u', { questionId: q.id }).status, 'retired');
  assert.deepEqual(store.listQuestions('u', { subjectId: 's1', status: 'retired' }).map(x => x.id), [q.id]);
  assert.equal(store.listQuestions('u', { subjectId: 's1', topicId: 't2' }).length, 0);
  assert.throws(() => store.saveQuestion('u', { question: { ...choice(), id: q.id, subjectId: 's2', topicId: null } }), /cannot move to another subject/);
});

test('editing or retiring a question leaves an existing snapshot byte-identical', () => {
  const { db, store } = setup();
  const q = store.saveQuestion('u', { question: choice() });
  const a = store.createAssessment('u', { subjectId: 's1', kind: 'final', config: {}, questionIds: [q.id] });
  const snapshot = () => db.prepare('SELECT question_snapshot FROM assessment_items WHERE assessment_id=?').get(a.id).question_snapshot;
  const before = snapshot();
  assert.deepEqual(JSON.parse(before).payload.correct, ['b']);
  store.saveQuestion('u', { question: { ...choice({ prompt: 'Changed', payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['a'] } }), id: q.id } });
  store.retireQuestion('u', { questionId: q.id });
  assert.equal(snapshot(), before);
  assert.equal(store.getQuestion('u', { questionId: q.id }).prompt, 'Changed');
});

test('createAssessment: order, snapshot fields, D3 rule, retakes and full rollback', () => {
  const { db, store } = setup();
  const q1 = store.saveQuestion('u', { question: choice() });
  const q2 = store.saveQuestion('u', { question: explain() });
  const draft = store.saveQuestion('u', { question: generated() });
  const a = store.createAssessment('u', { subjectId: 's1', kind: 'diagnostic', title: 'Pre', config: { seed: 1 }, questionIds: [q2.id, q1.id] });
  assert.equal(a.status, 'draft');
  assert.deepEqual(a.items.map(i => [i.position, i.questionId, i.topicId, i.dimension, i.maxScore]), [[0, q2.id, 't2', 'understanding', 4], [1, q1.id, 't1', 'recognition', 1]]);
  assert.deepEqual(a.items[1].snapshot.payload.correct, ['b'], 'unstripped');
  assert.deepEqual(a.config, { seed: 1 });

  for (const kind of ['diagnostic', 'final', 'retention']) {
    assert.throws(() => store.createAssessment('u', { subjectId: 's1', kind, config: {}, questionIds: [draft.id] }), /Only reviewed/);
  }
  assert.equal(store.createAssessment('u', { subjectId: 's1', kind: 'practice', config: {}, questionIds: [draft.id] }).items.length, 1);
  store.setReview('u', { questionId: draft.id, review: 'rejected' });
  assert.throws(() => store.createAssessment('u', { subjectId: 's1', kind: 'practice', config: {}, questionIds: [draft.id] }), /rejected/);

  const before = [count(db, 'assessments'), count(db, 'assessment_items')];
  assert.throws(() => store.createAssessment('u', { subjectId: 's1', kind: 'final', config: {}, questionIds: [q1.id, 'nope'] }), /Question not found/);
  // A failure inside the transaction (CHECK on max_score) also leaves nothing behind.
  db.exec('PRAGMA ignore_check_constraints = ON');
  db.prepare("UPDATE question_items SET points=0 WHERE id=?").run(q2.id);
  db.exec('PRAGMA ignore_check_constraints = OFF');
  assert.throws(() => store.createAssessment('u', { subjectId: 's1', kind: 'final', config: {}, questionIds: [q1.id, q2.id] }));
  assert.deepEqual([count(db, 'assessments'), count(db, 'assessment_items')], before);
  assert.equal(db.isTransaction, false);

  const f1 = store.createAssessment('u', { subjectId: 's1', kind: 'final', config: {}, questionIds: [q1.id] });
  const f2 = store.createAssessment('u', { subjectId: 's1', kind: 'final', config: {}, questionIds: [q1.id], retakeOf: f1.id });
  assert.deepEqual([f2.attempt, f2.retakeOf], [2, f1.id]);
  assert.throws(() => store.createAssessment('u', { subjectId: 's1', kind: 'practice', config: {}, questionIds: [q1.id], retakeOf: f1.id }), /Only a final/);
});

test('used flag and deleteQuestion: only unused questions can be deleted', () => {
  const { db, store } = setup();
  const usedQ = store.saveQuestion('u', { question: choice() });
  const free = store.saveQuestion('u', { question: choice({ prompt: 'Unused' }) });
  assert.equal(usedQ.used, false);
  store.createAssessment('u', { subjectId: 's1', kind: 'practice', config: {}, questionIds: [usedQ.id] });
  assert.deepEqual(store.listQuestions('u', { subjectId: 's1' }).map(q => [q.id, q.used]), [[usedQ.id, true], [free.id, false]]);
  assert.equal(store.getQuestion('u', { questionId: usedQ.id }).used, true);
  assert.equal(store.retireQuestion('u', { questionId: usedQ.id }).used, true);

  assert.throws(() => store.deleteQuestion('u', { questionId: usedQ.id }), { message: 'This question was used in an assessment. Retire it instead.' });
  assert.ok(store.getQuestion('u', { questionId: usedQ.id }), 'still there');
  assert.throws(() => store.deleteQuestion('v', { questionId: free.id }), { message: 'Question not found.' });
  assert.throws(() => store.deleteQuestion('u', { questionId: 'missing' }), { message: 'Question not found.' });
  assert.deepEqual(store.deleteQuestion('u', { questionId: free.id }), { id: free.id, deleted: true });
  assert.equal(count(db, 'question_items'), 1);
  assert.throws(() => store.getQuestion('u', { questionId: free.id }), /Question not found/);
});

test('lifecycle: start only from draft; abandon; list filters', () => {
  const { store } = setup();
  const q = store.saveQuestion('u', { question: choice() });
  const a = store.createAssessment('u', { subjectId: 's1', kind: 'practice', config: {}, questionIds: [q.id] });
  const s = store.startAssessment('u', { assessmentId: a.id });
  assert.equal(s.status, 'in_progress');
  assert.ok(s.startedAt);
  assert.throws(() => store.startAssessment('u', { assessmentId: a.id }), /cannot be started/);
  assert.equal(store.abandonAssessment('u', { assessmentId: a.id }).status, 'abandoned');
  assert.throws(() => store.abandonAssessment('u', { assessmentId: a.id }), /cannot be abandoned/);
  assert.deepEqual(store.listAssessments('u', { subjectId: 's1', status: 'abandoned' }).map(x => x.id), [a.id]);
  assert.equal(store.listAssessments('u', { subjectId: 's1', kind: 'final' }).length, 0);
});

test('saveAnswer: upserts while in progress, rejected for every other status, size cap', () => {
  const { store } = setup();
  const q = store.saveQuestion('u', { question: choice() });
  const e = store.saveQuestion('u', { question: explain() });
  const a = started(store, [q.id, e.id]);
  const [item, open] = a.items;
  const first = store.saveAnswer('u', { itemId: item.id, response: { choice: 'a', confidence: 2, junk: 1 } });
  assert.deepEqual(first.response.choice, ['a']);
  assert.equal(first.confidence, 2);
  const second = store.saveAnswer('u', { itemId: item.id, response: { choice: ['b', 'zzz'], dontKnow: true } });
  assert.equal(second.id, first.id, 'one row per item');
  assert.deepEqual([second.response.choice, second.dontKnow, second.confidence], [['b'], true, null]);
  assert.throws(() => store.saveAnswer('u', { itemId: open.id, response: { text: '\u{1F600}'.repeat(20000) } }), /answer is too large/);

  const draft = store.createAssessment('u', { subjectId: 's1', kind: 'practice', config: {}, questionIds: [q.id] });
  assert.throws(() => store.saveAnswer('u', { itemId: draft.items[0].id, response: {} }), /only be saved while the assessment is in progress/);
  const abandoned = started(store, [q.id]);
  store.abandonAssessment('u', { assessmentId: abandoned.id });
  assert.throws(() => store.saveAnswer('u', { itemId: abandoned.items[0].id, response: {} }), /in progress/);
  const graded = started(store, [q.id]);
  assert.equal(store.submitAssessment('u', { assessmentId: graded.id }).status, 'graded');
  assert.throws(() => store.saveAnswer('u', { itemId: graded.items[0].id, response: {} }), /in progress/);
  const submitted = started(store, [e.id]);
  assert.equal(store.submitAssessment('u', { assessmentId: submitted.id }).status, 'graded', 'empty open answer is graded not_answered');
  const pending = started(store, [e.id]);
  store.saveAnswer('u', { itemId: pending.items[0].id, response: { text: 'Because.' } });
  assert.equal(store.submitAssessment('u', { assessmentId: pending.id }).status, 'submitted');
  assert.throws(() => store.saveAnswer('u', { itemId: pending.items[0].id, response: {} }), /in progress/);
});

test('submitAssessment grades with grade(); open answers wait for gradeOpenAnswer', () => {
  const { store } = setup();
  const qs = [
    store.saveQuestion('u', { question: choice() }),
    store.saveQuestion('u', { question: choice({ prompt: 'Multi', payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], correct: ['a', 'b'], multiple: true }, points: 4 }) }),
    store.saveQuestion('u', { question: choice({ prompt: 'Skipped' }) }),
    store.saveQuestion('u', { question: choice({ prompt: 'No idea' }) }),
  ];
  const a = started(store, qs.map(q => q.id));
  const responses = [{ choice: 'b' }, { choice: ['a', 'c'] }, null, { dontKnow: true }];
  responses.forEach((r, i) => { if (r) store.saveAnswer('u', { itemId: a.items[i].id, response: r }); });
  const done = store.submitAssessment('u', { assessmentId: a.id });
  assert.equal(done.status, 'graded');
  assert.ok(done.submittedAt && done.gradedAt);
  done.items.forEach((item, i) => {
    const expected = model.grade(item.snapshot, responses[i] || {});
    assert.equal(item.answer.score, expected.score, `item ${i}`);
    assert.deepEqual([item.answer.gradeStatus, item.answer.grader], ['final', 'auto']);
  });
  assert.deepEqual(done.items.map(i => i.answer.mistakeCategory), [null, null, 'not_answered', 'not_known']);
  assert.throws(() => store.submitAssessment('u', { assessmentId: a.id }), /cannot be submitted/);

  const e = store.saveQuestion('u', { question: explain() });
  const tf = store.saveQuestion('u', { question: { subjectId: 's1', topicId: 't1', type: 'truefalse', prompt: 'True?', dimension: 'understanding', difficulty: 1, payload: { statement: 'Sky is blue', correct: true, requireJustification: true } } });
  const mixed = started(store, [qs[0].id, e.id, tf.id]);
  store.saveAnswer('u', { itemId: mixed.items[0].id, response: { choice: 'b' } });
  store.saveAnswer('u', { itemId: mixed.items[1].id, response: { text: 'An answer' } });
  store.saveAnswer('u', { itemId: mixed.items[2].id, response: { value: true, justification: 'Scattering' } });
  const sub = store.submitAssessment('u', { assessmentId: mixed.id });
  assert.equal(sub.status, 'submitted');
  assert.deepEqual(sub.items.map(i => [i.answer.gradeStatus, i.answer.score]), [['final', 1], ['pending', null], ['pending', 1]]);

  assert.throws(() => store.gradeOpenAnswer('u', { itemId: mixed.items[1].id, verdicts: [], grader: 'ai' }), /Grader must be one of: self, manual/);
  assert.throws(() => store.gradeOpenAnswer('u', { itemId: mixed.items[0].id, verdicts: [], grader: 'self' }), /not waiting/);
  const open = store.gradeOpenAnswer('u', { itemId: mixed.items[1].id, verdicts: [{ id: 'c1', verdict: 'met' }, { id: 'c2', verdict: 'partly' }], grader: 'self' });
  assert.deepEqual([open.score, open.gradeStatus, open.grader], [model.scoreFromCriteria(mixed.items[1].snapshot, [{ id: 'c1', verdict: 'met' }, { id: 'c2', verdict: 'partly' }]), 'final', 'self']);
  assert.deepEqual(open.criteria, [{ id: 'c1', verdict: 'met' }, { id: 'c2', verdict: 'partly' }]);
  assert.equal(store.getAssessment('u', { assessmentId: mixed.id }).status, 'submitted');
  const tfGraded = store.gradeOpenAnswer('u', { itemId: mixed.items[2].id, verdicts: { justification: 'met' }, grader: 'manual' });
  assert.equal(tfGraded.score, 2, 'deterministic half + justification half');
  const final = store.getAssessment('u', { assessmentId: mixed.id });
  assert.equal(final.status, 'graded');
  assert.ok(final.gradedAt);
  assert.throws(() => store.gradeOpenAnswer('u', { itemId: mixed.items[1].id, verdicts: [], grader: 'self' }), /after the assessment is submitted/);
});

test('D11: journeyEvidence returns only the journey\'s own cycle; earlier cycles stay stored', () => {
  const { db, store } = setup();
  const q = store.saveQuestion('u', { question: choice() });
  const e = store.saveQuestion('u', { question: explain() });
  const j1 = store.createJourney('u', { subjectId: 's1' });
  const a1 = started(store, [q.id, e.id], { journeyId: j1.id });
  store.saveAnswer('u', { itemId: a1.items[0].id, response: { choice: 'b', confidence: 3 } });
  store.saveAnswer('u', { itemId: a1.items[1].id, response: { text: 'x' } });
  store.submitAssessment('u', { assessmentId: a1.id });
  started(store, [q.id], { journeyId: j1.id }); // in progress: not evidence

  const ev1 = store.journeyEvidence('u', { journeyId: j1.id });
  assert.deepEqual(ev1, [
    { assessmentId: a1.id, kind: 'practice', attempt: 1, questionId: q.id, topicId: 't1', dimension: 'recognition', score: 1, max: 1, gradeStatus: 'final', grader: 'auto', confidence: 3, dontKnow: false, mistakeCategory: null, answeredAt: ev1[0].answeredAt },
    { assessmentId: a1.id, kind: 'practice', attempt: 1, questionId: e.id, topicId: 't2', dimension: 'understanding', score: null, max: 4, gradeStatus: 'pending', grader: null, confidence: null, dontKnow: false, mistakeCategory: null, answeredAt: ev1[1].answeredAt },
  ]);

  const answersBefore = count(db, 'assessment_answers');
  const j2 = store.createJourney('u', { subjectId: 's1', parentId: j1.id });
  assert.deepEqual(store.journeyEvidence('u', { journeyId: j2.id }), []);
  const a2 = started(store, [q.id], { journeyId: j2.id });
  store.saveAnswer('u', { itemId: a2.items[0].id, response: { choice: 'a' } });
  store.submitAssessment('u', { assessmentId: a2.id });
  const ev2 = store.journeyEvidence('u', { journeyId: j2.id });
  assert.deepEqual(ev2.map(r => [r.assessmentId, r.score]), [[a2.id, 0]]);
  assert.equal(count(db, 'assessment_answers'), answersBefore + 1, 'cycle 1 answers still stored');
  assert.equal(store.journeyEvidence('u', { journeyId: j1.id }).length, 2);
});

test('sessions and materials', () => {
  const { store } = setup();
  const j = store.createJourney('u', { subjectId: 's1' });
  const s = store.startSession('u', { subjectId: 's1', journeyId: j.id, topicId: 't1', kind: 'review' });
  assert.deepEqual(s.visited, { sections: [], materials: [] });
  const note = store.addMaterial('u', { subjectId: 's1', journeyId: j.id, topicId: 't1', sessionId: s.id, kind: 'side_note', title: 'Mine', bodyFile: 'n1.md' });
  assert.deepEqual([note.origin, note.bodyFile, note.source], ['manual', 'n1.md', []]);
  assert.throws(() => store.addMaterial('u', { subjectId: 's1', kind: 'side_note_ai' }), /needs the side note/);
  const ai = store.addMaterial('u', { subjectId: 's1', journeyId: j.id, kind: 'side_note_ai', parentMaterialId: note.id, origin: 'generated', provenance: { provider: 'p', model: 'm', extra: [1] } });
  assert.deepEqual(ai.provenance, { provider: 'p', model: 'm', extra: [1] }, 'ADR-007: kept as given');
  assert.throws(() => store.addMaterial('u', { subjectId: 's1', kind: 'side_note', bodyFile: '../x.md' }), /plain file name/);

  store.markVisited('u', { sessionId: s.id, sections: [{ fileId: 'f1', section: 'Intro' }], materials: [note.id] });
  const v = store.markVisited('u', { sessionId: s.id, sections: [{ fileId: 'f1', section: 'Intro' }, { fileId: 'f1', section: 'Two' }], materials: [note.id, ai.id] });
  assert.deepEqual(v.visited, { sections: [{ fileId: 'f1', section: 'Intro' }, { fileId: 'f1', section: 'Two' }], materials: [note.id, ai.id] });
  const ended = store.endSession('u', { sessionId: s.id, summary: 'Done' });
  assert.ok(ended.endedAt);
  assert.equal(ended.summary, 'Done');
  assert.throws(() => store.markVisited('u', { sessionId: s.id, materials: [note.id] }), /already ended/);
  assert.throws(() => store.endSession('u', { sessionId: s.id }), /already ended/);

  assert.deepEqual(store.listMaterials('u', { journeyId: j.id }).map(m => m.id), [note.id, ai.id]);
  assert.deepEqual(store.listMaterials('u', { journeyId: j.id, kind: 'side_note_ai' }).map(m => m.id), [ai.id]);
  assert.deepEqual(store.listMaterials('u', { journeyId: j.id, topicId: 't1' }).map(m => m.id), [note.id]);
  assert.equal(store.getMaterial('u', { materialId: ai.id }).parentMaterialId, note.id);
});

test('unreadable JSON columns fall back to defaults instead of throwing', () => {
  const { db, store } = setup();
  const q = store.saveQuestion('u', { question: choice() });
  const s = store.startSession('u', { subjectId: 's1', kind: 'main' });
  db.exec('PRAGMA ignore_check_constraints = ON');
  db.prepare("UPDATE question_items SET source='[oops', provenance='{' WHERE id=?").run(q.id);
  db.prepare("UPDATE learning_sessions SET visited='[1,2]' WHERE id=?").run(s.id);
  db.exec('PRAGMA ignore_check_constraints = OFF');
  const read = store.getQuestion('u', { questionId: q.id });
  assert.deepEqual([read.source, read.provenance], [[], null]);
  assert.deepEqual(store.markVisited('u', { sessionId: s.id }).visited, { sections: [], materials: [] });
});

test('cross-account: a second user gets "not found" from every method that takes an id', () => {
  const { store } = setup();
  const j = store.createJourney('u', { subjectId: 's1' });
  const q = store.saveQuestion('u', { question: choice() });
  const e = store.saveQuestion('u', { question: explain() });
  const a = started(store, [q.id, e.id], { journeyId: j.id });
  const s = store.startSession('u', { subjectId: 's1', kind: 'main' });
  const m = store.addMaterial('u', { subjectId: 's1', journeyId: j.id, kind: 'side_note' });
  const graded = started(store, [e.id]);
  store.saveAnswer('u', { itemId: graded.items[0].id, response: { text: 'x' } });
  store.submitAssessment('u', { assessmentId: graded.id });
  // v's own valid-looking context
  const vj = store.createJourney('v', { subjectId: 'sv' });
  const vq = store.saveQuestion('v', { question: choice({ subjectId: 'sv', topicId: 'tv' }) });
  const vs = store.startSession('v', { subjectId: 'sv', kind: 'main' });
  const vm = store.addMaterial('v', { subjectId: 'sv', kind: 'side_note' });

  const calls = {
    'createJourney subject': [() => store.createJourney('v', { subjectId: 's1' }), /Subject not found/],
    'createJourney topicIds': [() => store.createJourney('v', { subjectId: 'sv', topicIds: ['t1'] }), /Topic not found/],
    'createJourney parentId': [() => store.createJourney('v', { subjectId: 'sv', parentId: j.id }), /Journey not found/],
    getJourney: [() => store.getJourney('v', { journeyId: j.id }), /Journey not found/],
    listJourneys: [() => store.listJourneys('v', { subjectId: 's1' }), /Subject not found/],
    updateJourney: [() => store.updateJourney('v', { journeyId: j.id, title: 'x' }), /Journey not found/],
    'updateJourney topicIds': [() => store.updateJourney('v', { journeyId: vj.id, topicIds: ['t1'] }), /Topic not found/],
    'saveQuestion id': [() => store.saveQuestion('v', { question: { ...choice({ subjectId: 'sv', topicId: 'tv' }), id: q.id } }), /Question not found/],
    'saveQuestion subject': [() => store.saveQuestion('v', { question: choice() }), /Subject not found/],
    'saveQuestion topic': [() => store.saveQuestion('v', { question: choice({ subjectId: 'sv' }) }), /Topic not found/],
    getQuestion: [() => store.getQuestion('v', { questionId: q.id }), /Question not found/],
    listQuestions: [() => store.listQuestions('v', { subjectId: 's1' }), /Subject not found/],
    'listQuestions topic': [() => store.listQuestions('v', { subjectId: 'sv', topicId: 't1' }), /Topic not found/],
    retireQuestion: [() => store.retireQuestion('v', { questionId: q.id }), /Question not found/],
    deleteQuestion: [() => store.deleteQuestion('v', { questionId: q.id }), /Question not found/],
    setReview: [() => store.setReview('v', { questionId: q.id, review: 'approved' }), /Question not found/],
    'createAssessment subject': [() => store.createAssessment('v', { subjectId: 's1', kind: 'practice', config: {}, questionIds: [vq.id] }), /Subject not found/],
    'createAssessment questionIds': [() => store.createAssessment('v', { subjectId: 'sv', kind: 'practice', config: {}, questionIds: [vq.id, q.id] }), /Question not found/],
    'createAssessment journeyId': [() => store.createAssessment('v', { subjectId: 'sv', journeyId: j.id, kind: 'practice', config: {}, questionIds: [vq.id] }), /Journey not found/],
    'createAssessment retakeOf': [() => store.createAssessment('v', { subjectId: 'sv', kind: 'final', config: {}, questionIds: [vq.id], retakeOf: a.id }), /Assessment not found/],
    startAssessment: [() => store.startAssessment('v', { assessmentId: a.id }), /Assessment not found/],
    getAssessment: [() => store.getAssessment('v', { assessmentId: a.id }), /Assessment not found/],
    listAssessments: [() => store.listAssessments('v', { subjectId: 's1' }), /Subject not found/],
    'listAssessments journey': [() => store.listAssessments('v', { subjectId: 'sv', journeyId: j.id }), /Journey not found/],
    abandonAssessment: [() => store.abandonAssessment('v', { assessmentId: a.id }), /Assessment not found/],
    saveAnswer: [() => store.saveAnswer('v', { itemId: a.items[0].id, response: {} }), /Item not found/],
    submitAssessment: [() => store.submitAssessment('v', { assessmentId: a.id }), /Assessment not found/],
    gradeOpenAnswer: [() => store.gradeOpenAnswer('v', { itemId: graded.items[0].id, verdicts: [], grader: 'self' }), /Item not found/],
    'startSession subject': [() => store.startSession('v', { subjectId: 's1', kind: 'main' }), /Subject not found/],
    'startSession journey': [() => store.startSession('v', { subjectId: 'sv', journeyId: j.id, kind: 'main' }), /Journey not found/],
    'startSession topic': [() => store.startSession('v', { subjectId: 'sv', topicId: 't1', kind: 'main' }), /Topic not found/],
    endSession: [() => store.endSession('v', { sessionId: s.id }), /Session not found/],
    markVisited: [() => store.markVisited('v', { sessionId: s.id }), /Session not found/],
    'markVisited materials': [() => store.markVisited('v', { sessionId: vs.id, materials: [m.id] }), /Material not found/],
    'markVisited sections': [() => store.markVisited('v', { sessionId: vs.id, sections: [{ fileId: 'f1', section: 'x' }] }), /File not found/],
    'addMaterial subject': [() => store.addMaterial('v', { subjectId: 's1', kind: 'side_note' }), /Subject not found/],
    'addMaterial journey': [() => store.addMaterial('v', { subjectId: 'sv', journeyId: j.id, kind: 'side_note' }), /Journey not found/],
    'addMaterial topic': [() => store.addMaterial('v', { subjectId: 'sv', topicId: 't1', kind: 'side_note' }), /Topic not found/],
    'addMaterial session': [() => store.addMaterial('v', { subjectId: 'sv', sessionId: s.id, kind: 'side_note' }), /Session not found/],
    'addMaterial parent': [() => store.addMaterial('v', { subjectId: 'sv', kind: 'side_note_ai', parentMaterialId: m.id }), /Material not found/],
    getMaterial: [() => store.getMaterial('v', { materialId: m.id }), /Material not found/],
    listMaterials: [() => store.listMaterials('v', { journeyId: j.id }), /Journey not found/],
    'listMaterials topic': [() => store.listMaterials('v', { journeyId: vj.id, topicId: 't1' }), /Topic not found/],
    journeyEvidence: [() => store.journeyEvidence('v', { journeyId: j.id }), /Journey not found/],
  };
  for (const [name, [call, message]] of Object.entries(calls)) assert.throws(call, message, name);
  assert.ok(vm.id);

  // Same account, other subject: journeyId of another subject is not found either.
  assert.throws(() => store.createAssessment('u', { subjectId: 's2', journeyId: j.id, kind: 'practice', config: {}, questionIds: [q.id] }), /Journey not found/);
  assert.throws(() => store.createAssessment('u', { subjectId: 's2', kind: 'practice', config: {}, questionIds: [q.id] }), /Question not found/);
  // Missing and foreign ids give the same message.
  assert.throws(() => store.getJourney('u', { journeyId: 'missing' }), { message: 'Journey not found.' });
  assert.throws(() => store.getJourney('v', { journeyId: j.id }), { message: 'Journey not found.' });
  assert.throws(() => store.getJourney('u', {}), { message: 'Journey not found.' });
  // Nothing of u changed.
  assert.equal(store.getJourney('u', { journeyId: j.id }).title, 'Cycle 1');
  assert.equal(store.getQuestion('u', { questionId: q.id }).review, 'approved');
});

test('deleting a subject through the workspace leaves no learning rows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-ls006-'));
  const workspace = createWorkspace(root);
  t.after(() => { try { workspace.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const subject = workspace.createSubject('u', 'study', { name: 'Biology' });
  const topicId = workspace.addTopic('u', subject.id, { title: 'Cells' }).added[0];
  const keep = workspace.createSubject('u', 'study', { name: 'Chemistry' });
  const store = workspace.learningStore();
  for (const subjectId of [subject.id, keep.id]) {
    const j = store.createJourney('u', { subjectId });
    const q = store.saveQuestion('u', { question: choice({ subjectId, topicId: subjectId === subject.id ? topicId : null }) });
    const a = started(store, [q.id], { subjectId, journeyId: j.id });
    store.saveAnswer('u', { itemId: a.items[0].id, response: { choice: 'b' } });
    const s = store.startSession('u', { subjectId, journeyId: j.id, kind: 'main' });
    const note = store.addMaterial('u', { subjectId, journeyId: j.id, sessionId: s.id, kind: 'side_note' });
    store.addMaterial('u', { subjectId, kind: 'side_note_ai', parentMaterialId: note.id });
  }
  workspace.deleteSubject('u', subject.id);
  const db = new DatabaseSync(path.join(root, 'workspace.sqlite'), { readOnly: true });
  try {
    const withSubject = ['learning_journeys', 'question_items', 'assessments', 'learning_sessions', 'learning_materials'];
    for (const table of withSubject) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE subject_id=?`).get(subject.id).n, 0, table);
    for (const table of LEARNING_TABLES.filter(name => !withSubject.includes(name))) assert.ok(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n <= 1, table);
    // Item and answer rows: only the kept subject's remain.
    assert.equal(db.prepare('SELECT count(*) AS n FROM assessment_items').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM assessment_answers').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM journey_topics').get().n, 0, 'kept subject has no topics');
    assert.equal(db.prepare('SELECT count(*) AS n FROM learning_materials').get().n, 2);
  } finally { db.close(); }
});

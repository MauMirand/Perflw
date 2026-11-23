'use strict';
/* LS-007: IPC handlers for journeys, questions, assessments and mastery (src/learning-ipc.js), driven through a fake
   `handle` over a real in-memory workspace schema. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { WORKSPACE_MIGRATIONS } = require('../src/workspace');
const { createLearningStore } = require('../src/learning-store');
const { registerLearningIpc, studentAssessment } = require('../src/learning-ipc');

const T = '2026-11-23T10:00:00.000Z';
const stamps = { created_at: T, updated_at: T };
function insert(db, table, values) {
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values));
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of WORKSPACE_MIGRATIONS) migration.up(db);
  for (const [id, user] of [['s1', 'u'], ['sv', 'v']]) insert(db, 'subjects', { id, user_id: user, profile: 'study', name: id, ...stamps });
  for (const [id, user, subject, position] of [['t1', 'u', 's1', 0], ['t2', 'u', 's1', 1], ['tv', 'v', 'sv', 0]]) {
    insert(db, 'subject_topics', { id, user_id: user, subject_id: subject, kind: 'topic', title: `Topic ${id}`, position, ...stamps });
  }
  const store = createLearningStore(db);
  const workspace = { learningStore: () => store, listTopics: (userId, subjectId) => ({
    rows: db.prepare('SELECT id, title FROM subject_topics WHERE user_id=? AND subject_id=?').all(userId, subjectId) }) };
  const handlers = new Map();
  let user = { id: 'u' };
  let userChecks = 0;
  registerLearningIpc({
    handle: (channel, action) => handlers.set(channel, action),
    requireUser: () => { userChecks += 1; if (!user) throw new Error('Your session has expired. Log in again.'); return user; },
    workspace, now: () => Date.parse('2026-11-24T10:00:00.000Z'),
  });
  return {
    call: (channel, arg) => handlers.get(channel)(arg),
    handlers, as: next => { user = next; }, checks: () => userChecks, store,
  };
}

const choiceQ = (n, topicId = 't1', extra = {}) => ({
  subjectId: 's1', topicId, type: 'choice', prompt: `Pick B ${n}`, dimension: 'recognition', difficulty: 2,
  explanation: 'B is right because of reasons.', source: [{ quote: 'the source says B' }],
  payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }], correct: ['b'] }, ...extra,
});
const explainQ = (n, topicId = 't2') => ({
  subjectId: 's1', topicId, type: 'explain', prompt: `Explain ${n}`, dimension: 'recall', difficulty: 2,
  payload: { rubric: [{ id: 'c1', criterion: 'Names it', points: 1, keywords: ['secret-key'] }, { id: 'c2', criterion: 'Says why', points: 1 }], modelAnswer: 'secret model answer' },
});
const matchQ = (n) => ({
  subjectId: 's1', topicId: 't1', type: 'matching', prompt: `Match ${n}`, dimension: 'recognition', difficulty: 2,
  payload: { left: [{ id: 'l1', text: 'one' }, { id: 'l2', text: 'two' }], right: [{ id: 'r1', text: 'uno' }, { id: 'r2', text: 'dos' }, { id: 'r3', text: 'tres' }], pairs: [['l1', 'r1'], ['l2', 'r2']] },
});
const tfQ = (n) => ({
  subjectId: 's1', topicId: 't2', type: 'truefalse', prompt: `TF ${n}`, dimension: 'recognition', difficulty: 1,
  payload: { statement: 'Water is wet', correct: true, requireJustification: false },
});

function seed(t) {
  for (let i = 1; i <= 3; i++) { t.call('questions:save', { question: choiceQ(i) }); t.call('questions:save', { question: choiceQ(i, 't2') }); }
  t.call('questions:save', { question: explainQ(1) }); t.call('questions:save', { question: explainQ(2, 't1') });
  t.call('questions:save', { question: matchQ(1) }); t.call('questions:save', { question: tfQ(1) });
}
const KEY_FIELDS = ['correct', 'pairs', 'modelAnswer', 'keywords', 'explanation', 'provenance', 'quote'];
function keysDeep(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach(v => keysDeep(v, found));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
}

test('every channel is registered and every preload learningData channel exists as a handler', () => {
  const t = setup();
  const registered = [...t.handlers.keys()].sort();
  assert.deepEqual(registered, [
    'assessment:abandon', 'assessment:create', 'assessment:get', 'assessment:grade', 'assessment:list', 'assessment:results',
    'assessment:saveAnswer', 'assessment:start', 'assessment:submit', 'journey:create', 'journey:get', 'journey:list', 'journey:update',
    'mastery:journey', 'mastery:subject', 'questions:delete', 'questions:list', 'questions:retire', 'questions:save',
  ]);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const used = [...preload.matchAll(/call\('((?:journey|questions|assessment|mastery):[A-Za-z]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(used, registered, 'preload and handlers list the same channels');
});

test('every handler checks the signed-in user first and rejects a non-object argument', () => {
  const t = setup();
  for (const channel of t.handlers.keys()) {
    const before = t.checks();
    assert.throws(() => t.call(channel, 'text'), /one object argument/, channel);
    assert.equal(t.checks(), before + 1, `${channel} called requireUser`);
  }
  t.as(null);
  for (const channel of t.handlers.keys()) assert.throws(() => t.call(channel, {}), /session has expired/, channel);
});

test('a student view of an open assessment carries no answer key, in any question type', () => {
  const t = setup(); seed(t);
  const made = t.call('assessment:create', { subjectId: 's1', kind: 'diagnostic', config: { count: 20, seed: 'x' } });
  const types = new Set(made.assessment.items.map(i => i.question.type));
  assert.deepEqual([...types].sort(), ['choice', 'explain', 'matching', 'truefalse']);
  const keys = keysDeep(made.assessment.items.map(i => i.question));
  for (const field of KEY_FIELDS) assert.ok(!keys.has(field), `${field} must not be sent`);
  assert.ok(!('seed' in made.assessment.config), 'the seed stays in main');
  const started = t.call('assessment:start', { assessmentId: made.assessment.id });
  assert.ok(!keysDeep(started.items.map(i => i.question)).has('correct'));
  assert.ok(!keysDeep(t.call('assessment:get', { assessmentId: made.assessment.id }).items.map(i => i.question)).has('modelAnswer'));
});

test('options are shuffled with the seed: stable for one assessment, different across assessments', () => {
  const t = setup(); seed(t);
  const make = seedText => t.call('assessment:create', { subjectId: 's1', kind: 'practice', config: { count: 1, types: ['choice'], seed: seedText } }).assessment;
  const a = make('seed-a');
  const order = x => x.items[0].question.payload.options.map(o => o.id).join('');
  assert.equal(order(t.call('assessment:get', { assessmentId: a.id })), order(t.call('assessment:get', { assessmentId: a.id })));
  const orders = new Set(Array.from({ length: 8 }, (_, i) => order(make(`seed-${i}`))));
  assert.ok(orders.size > 1, 'different seeds give different orders');
});

test('create reports requested and available, builds what exists, and refuses an empty bank', () => {
  const t = setup();
  assert.throws(() => t.call('assessment:create', { subjectId: 's1', kind: 'diagnostic', config: {} }), /No questions are available yet/);
  t.call('questions:save', { question: choiceQ(1) }); t.call('questions:save', { question: choiceQ(2) });
  const made = t.call('assessment:create', { subjectId: 's1', kind: 'diagnostic', config: { count: 8 } });
  assert.equal(made.requested, 8); assert.equal(made.available, 2); assert.equal(made.assessment.items.length, 2);
});

test('a full pre-test: answer, submit, self-grade, results; results are refused before submit', () => {
  const t = setup(); seed(t);
  const { assessment } = t.call('assessment:create', { subjectId: 's1', kind: 'diagnostic', config: { count: 20 } });
  assert.throws(() => t.call('assessment:results', { assessmentId: assessment.id }), /Submit the assessment/);
  assert.throws(() => t.call('assessment:saveAnswer', { itemId: assessment.items[0].id, response: { choice: ['b'] } }), /in progress/);
  t.call('assessment:start', { assessmentId: assessment.id });
  const first = assessment.items.find(i => i.question.type === 'choice');
  const saved = t.call('assessment:saveAnswer', { itemId: first.id, response: { choice: ['b'], confidence: 3 } });
  assert.deepEqual(Object.keys(saved), ['savedAt']);
  for (const item of assessment.items) if (item.question.type === 'explain') t.call('assessment:saveAnswer', { itemId: item.id, response: { text: 'Because of ionic attraction.' } });
  const submitted = t.call('assessment:submit', { assessmentId: assessment.id });
  assert.equal(submitted.status, 'submitted', 'written answers wait for a grade');
  const open = submitted.items.filter(i => i.snapshot.type === 'explain');
  assert.ok(open.length >= 1);
  for (const item of open) t.call('assessment:grade', { itemId: item.id, verdicts: { c1: 'met', c2: 'partly' } });
  const results = t.call('assessment:results', { assessmentId: assessment.id });
  assert.equal(results.status, 'graded');
  const correct = results.items.find(i => i.id === first.id);
  assert.equal(correct.answer.score, correct.maxScore);
  assert.ok(keysDeep(results.items.map(i => i.snapshot)).has('correct'), 'after submit the full snapshot is returned');
  assert.equal(studentAssessment(results), results, 'a submitted assessment is returned whole');
});

test('a final never reuses a question from the journey diagnostics', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const diag = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'diagnostic', config: { count: 4 } }).assessment;
  const used = new Set(t.store.getAssessment('u', { assessmentId: diag.id }).items.map(i => i.questionId));
  const final = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: { count: 20 } });
  const reused = t.store.getAssessment('u', { assessmentId: final.assessment.id }).items.filter(i => used.has(i.questionId));
  assert.equal(reused.length, 0);
  assert.equal(final.available + used.size, 10, 'all 10 questions: 4 used by the diagnostic, the rest left for the final');
});

test('another account gets "not found" through every id-taking channel', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const { assessment } = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'diagnostic', config: { count: 3 } });
  const question = t.call('questions:list', { subjectId: 's1' })[0];
  t.as({ id: 'v' });
  const attempts = [
    ['journey:get', { journeyId: journey.id }], ['journey:update', { journeyId: journey.id, title: 'x' }],
    ['journey:list', { subjectId: 's1' }], ['questions:list', { subjectId: 's1' }], ['questions:retire', { questionId: question.id }],
    ['questions:delete', { questionId: question.id }], ['assessment:get', { assessmentId: assessment.id }],
    ['assessment:start', { assessmentId: assessment.id }], ['assessment:submit', { assessmentId: assessment.id }],
    ['assessment:saveAnswer', { itemId: assessment.items[0].id, response: {} }], ['assessment:grade', { itemId: assessment.items[0].id, verdicts: {} }],
    ['assessment:results', { assessmentId: assessment.id }], ['mastery:journey', { journeyId: journey.id }],
  ];
  for (const [channel, arg] of attempts) assert.throws(() => t.call(channel, arg), /not found/i, channel);
});

test('mastery:journey reports a level per topic from graded evidence, one cycle only', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const { assessment } = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'diagnostic', config: { count: 20 } });
  t.call('assessment:start', { assessmentId: assessment.id });
  for (const item of assessment.items) if (item.question.type === 'choice') t.call('assessment:saveAnswer', { itemId: item.id, response: { choice: ['b'] } });
  t.call('assessment:submit', { assessmentId: assessment.id });
  const report = t.call('mastery:journey', { journeyId: journey.id });
  assert.equal(report.cycle, 1);
  assert.deepEqual(report.topics.map(x => x.topicId).sort(), ['t1', 't2']);
  assert.ok(report.topics.every(x => typeof x.level === 'string' && x.title.startsWith('Topic ')));
  const next = t.call('journey:create', { subjectId: 's1', parentId: journey.id });
  assert.equal(next.cycle, 2);
  assert.ok(t.call('mastery:journey', { journeyId: next.id }).topics.every(x => x.items === 0 && x.level === 'not_assessed'), 'the new cycle starts at zero');
  assert.equal(t.call('mastery:subject', { subjectId: 's1' })[0].cycle, 2);
});

test('input errors are plain language and never carry database words', () => {
  const t = setup();
  const bad = [['journey:get', {}], ['assessment:create', { subjectId: 's1', kind: 'nonsense' }], ['assessment:grade', { itemId: 'x', verdicts: {}, grader: 'ai' }],
    ['questions:save', { question: { subjectId: 's1' } }], ['journey:create', { subjectId: 's1', topicIds: ['nope'] }]];
  for (const [channel, arg] of bad) {
    let message = '';
    try { t.call(channel, arg); } catch (error) { message = error.message; }
    assert.ok(message, `${channel} rejected`);
    assert.ok(!/SQLITE|EACCES|ENOENT|EPERM/i.test(message), `${channel}: ${message}`);
  }
});

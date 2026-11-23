'use strict';
/* LS-007: IPC handlers for journeys, questions, assessments and mastery (src/learning-ipc.js), driven through a fake
   `handle` over a real in-memory workspace schema. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
  insert(db, 'subject_files', { id: 'f1', user_id: 'u', subject_id: 's1', name: 'a.pdf', stored_name: 'a', type: 'pdf', size: 1, created_at: T });
  db.prepare("UPDATE subject_topics SET file_id='f1' WHERE id IN ('t1','t2')").run();
  const store = createLearningStore(db);
  const events = [];
  const workspace = { learningStore: () => store,
    getSubject: (userId, id) => ({ name: id === 's1' ? 'Biology' : 'Other' }),
    createEvent: (userId, title, startsAt, endsAt) => { const id = `e${events.length + 1}`; db.prepare('INSERT INTO events (id,user_id,title,starts_at,ends_at) VALUES (?,?,?,?,?)').run(id, userId, title, startsAt, endsAt); events.push(id); return id; },
    deleteEvent: (userId, id) => { db.prepare('DELETE FROM events WHERE id=? AND user_id=?').run(id, userId); }, listTopics: (userId, subjectId) => ({
    rows: db.prepare('SELECT id, title, kind, file_id AS fileId FROM subject_topics WHERE user_id=? AND subject_id=?').all(userId, subjectId) }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-ipc-'));
  const handlers = new Map();
  const clock = { now: Date.now() }; // the store stamps real time, so the fake clock starts there
  let user = { id: 'u' };
  let userChecks = 0;
  registerLearningIpc({
    handle: (channel, action) => handlers.set(channel, action),
    requireUser: () => { userChecks += 1; if (!user) throw new Error('Your session has expired. Log in again.'); return user; },
    workspace, dataDir: dir, analysisOf: (userId, fileId) => ({ status: 'ready', sections: [{ number: '1', title: 'Topic t1', page: 1, description: 'About t1.', keyPoints: ['Point one.', 'Point two.'] }, { number: '2', title: 'Topic t2', page: 2, description: 'About t2.', keyPoints: ['Point three.', 'Point four.'] }] }), now: () => clock.now,
  });
  return {
    call: (channel, arg) => handlers.get(channel)(arg),
    handlers, as: next => { user = next; }, checks: () => userChecks, store, clock, dir, rawDb: db,
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
    'assessment:abandon', 'assessment:analysis', 'assessment:check', 'assessment:create', 'assessment:get', 'assessment:grade', 'assessment:list', 'assessment:results', 'assessment:retakeStatus', 'assessment:retry', 'journey:evaluation', 'learning:history', 'retention:status',
    'assessment:saveAnswer', 'assessment:start', 'assessment:submit', 'exam:attempts', 'exam:preview', 'journey:create', 'journey:get', 'journey:list', 'journey:update',
    'mastery:journey', 'mastery:report', 'mastery:subject', 'notes:list', 'notes:targeted', 'questions:delete', 'questions:list', 'questions:retire', 'questions:save', 'questions:templates', 'review:due', 'schedule:cancel', 'schedule:create', 'schedule:list',
  ].sort());
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const used = [...preload.matchAll(/call\('((?:journey|questions|assessment|mastery|exam|notes|review|retention|schedule):[A-Za-z]+|learning:history)'/g)].map(m => m[1]).sort();
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
  const final = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: { count: 20, test: true } });
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

// ───────── exams (spec §4.9)
function answerAll(t, assessment, choose = 'b') {
  for (const item of assessment.items) {
    const type = item.question.type;
    const response = type === 'choice' ? { choice: [choose] } : type === 'truefalse' ? { value: true } : type === 'explain' ? { text: 'An answer.' } : {};
    t.call('assessment:saveAnswer', { itemId: item.id, response });
  }
}
const finalConfig = extra => ({ test: true, count: 20, timeMultiplier: 1, ...extra });
function gradeOpen(t, assessmentId, verdicts) {
  for (const item of t.store.getAssessment('u', { assessmentId }).items) {
    if (item.snapshot.type === 'explain' && item.answer.gradeStatus === 'pending') t.call('assessment:grade', { itemId: item.id, verdicts });
  }
}

test('a real final needs 50–100 questions; a test final does not; the preview says what it would be', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const preview = t.call('exam:preview', { subjectId: 's1', journeyId: journey.id, config: { count: 6, test: false } });
  assert.equal(preview.ok, false); assert.match(preview.problem, /50–100 questions/);
  const test6 = t.call('exam:preview', { subjectId: 's1', journeyId: journey.id, config: finalConfig({ count: 6 }) });
  assert.equal(test6.ok, true); assert.equal(test6.count, 6); assert.equal(test6.test, true);
  assert.ok(test6.timeLimitSeconds >= 300 && test6.timeLimitSeconds % 300 === 0, 'limit is a multiple of 5 minutes');
  assert.ok(test6.passMark >= 0.75 && test6.passMark <= 0.9);
  assert.throws(() => t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: { count: 6 } }), /50–100 questions/);
  const untimed = t.call('exam:preview', { subjectId: 's1', journeyId: journey.id, config: finalConfig({ count: 6, timeMultiplier: 0 }) });
  assert.equal(untimed.timeLimitSeconds, null);
});

test('a timed final: the config stores limit and pass mark, seconds left count down, a late save submits what was saved', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const made = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: finalConfig({ count: 6 }) }).assessment;
  assert.ok(made.config.timeLimitSeconds >= 300 && made.config.passMark > 0 && made.config.test === true);
  assert.ok(!('seed' in made.config));
  const limit = made.config.timeLimitSeconds;
  const started = t.call('assessment:start', { assessmentId: made.id });
  assert.ok([limit, limit + 1].includes(started.secondsLeft), 'the full limit at the start (clock jitter of one second)');
  t.clock.now = Date.parse(started.startedAt);
  t.clock.now += 100 * 1000;
  assert.equal(t.call('assessment:get', { assessmentId: made.id }).secondsLeft, limit - 100);
  const first = started.items[0];
  t.call('assessment:saveAnswer', { itemId: first.id, response: first.question.type === 'choice' ? { choice: ['b'] } : { text: 'in time' } });
  t.clock.now += (limit + 10) * 1000; // past the deadline and the grace period
  assert.throws(() => t.call('assessment:saveAnswer', { itemId: first.id, response: { text: 'too late' } }), /Time is up/);
  const after = t.call('assessment:get', { assessmentId: made.id });
  assert.ok(['submitted', 'graded'].includes(after.status), `submitted by the deadline, not ${after.status}`);
});

test('an untimed final never expires; results carry the verdict; a failed attempt can be retaken', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const made = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: finalConfig({ count: 8, timeMultiplier: 0 }) }).assessment;
  assert.equal(made.config.timeLimitSeconds, null);
  t.call('assessment:start', { assessmentId: made.id });
  t.clock.now += 99 * 3600 * 1000;
  answerAll(t, made, 'a'); // wrong on purpose: option a is never the right one
  t.call('assessment:submit', { assessmentId: made.id });
  gradeOpen(t, made.id, { c1: 'missing', c2: 'missing' });
  const results = t.call('assessment:results', { assessmentId: made.id });
  assert.equal(results.exam.passed, false);
  assert.equal(results.exam.test, true);
  assert.equal(results.exam.passMarkPercent, Math.round(made.config.passMark * 1000) / 10);
  const retakeArgs = { subjectId: 's1', journeyId: journey.id, kind: 'final', retakeOf: made.id, config: finalConfig({ count: 6, timeMultiplier: 0 }) };
  assert.throws(() => t.call('assessment:create', retakeArgs), /Review first/);
  const gate = t.call('assessment:retakeStatus', { assessmentId: made.id });
  assert.equal(gate.failed, true); assert.equal(gate.ready, false); assert.ok(gate.topics.length >= 1 && gate.topics.every(x => x.missingSections.length === 1));
  // A review session opens every section of the failing topics (D13), then the retake is allowed.
  const review = t.store.startSession('u', { subjectId: 's1', journeyId: journey.id, kind: 'review' });
  t.store.markVisited('u', { sessionId: review.id, sections: gate.topics.map(x => ({ fileId: 'f1', section: x.missingSections[0] })) });
  assert.equal(t.call('assessment:retakeStatus', { assessmentId: made.id }).ready, true);
  const retake = t.call('assessment:create', retakeArgs);
  assert.equal(retake.assessment.attempt, 2); assert.equal(retake.assessment.retakeOf, made.id);
  const attempts = t.call('exam:attempts', { subjectId: 's1', journeyId: journey.id });
  assert.equal(attempts.length, 1, 'only submitted attempts are compared');
  assert.equal(attempts[0].attempt, 1); assert.equal(attempts[0].result.passed, false);
  assert.ok(attempts[0].topics.every(x => x.title.startsWith('Topic ')));
});

test('a passed final cannot be retaken', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const made = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: finalConfig({ count: 4, types: ['choice'], timeMultiplier: 0 }) }).assessment;
  t.call('assessment:start', { assessmentId: made.id });
  answerAll(t, made, 'b');
  t.call('assessment:submit', { assessmentId: made.id });
  assert.equal(t.call('assessment:results', { assessmentId: made.id }).exam.passed, true);
  assert.throws(() => t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', retakeOf: made.id, config: finalConfig({ count: 2, types: ['choice'] }) }), /only for a final exam that was not passed/);
});

test('practice feedback: check reveals only that question key and only in an in-progress practice set', () => {
  const t = setup(); seed(t);
  const { assessment } = t.call('assessment:create', { subjectId: 's1', kind: 'practice', config: { count: 3, types: ['choice'] } });
  t.call('assessment:start', { assessmentId: assessment.id });
  const [one, two] = assessment.items;
  t.call('assessment:saveAnswer', { itemId: one.id, response: { choice: ['b'] } });
  const right = t.call('assessment:check', { assessmentId: assessment.id, itemId: one.id });
  assert.equal(right.score, right.max); assert.deepEqual(right.key.correct, ['b']); assert.match(right.explanation, /reasons/);
  t.call('assessment:saveAnswer', { itemId: two.id, response: { choice: ['a'] } });
  assert.equal(t.call('assessment:check', { assessmentId: assessment.id, itemId: two.id }).score, 0);
  const diag = t.call('assessment:create', { subjectId: 's1', kind: 'diagnostic', config: { count: 2 } }).assessment;
  t.call('assessment:start', { assessmentId: diag.id });
  assert.throws(() => t.call('assessment:check', { assessmentId: diag.id, itemId: diag.items[0].id }), /only available in a practice set/);
  t.as({ id: 'v' });
  assert.throws(() => t.call('assessment:check', { assessmentId: assessment.id, itemId: one.id }), /not found/i);
});

test('mastery:report compares the pre-test with the whole cycle per topic', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const run = (kind, config) => {
    const made = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind, config }).assessment;
    t.call('assessment:start', { assessmentId: made.id }); answerAll(t, made, 'b'); t.call('assessment:submit', { assessmentId: made.id });
    gradeOpen(t, made.id, { c1: 'met', c2: 'met' });
  };
  run('diagnostic', { count: 4, types: ['choice'] });
  run('final', finalConfig({ count: 4, types: ['choice'], timeMultiplier: 0 }));
  const report = t.call('mastery:report', { journeyId: journey.id });
  assert.equal(report.cycle, 1);
  const a = report.topics.find(x => x.topicId === 't1');
  assert.ok(a.pre.items >= 1 && a.post.items >= a.pre.items, 'post includes the pre-test answers plus the final');
  assert.deepEqual(Object.keys(a.improvement).sort(), ['application', 'recall', 'recognition', 'understanding']);
  assert.equal(report.provisional, false);
});

// ───────── diagnosis, targeted notes, review queue (spec §5.2, §5.3)
function runDiagnostic(t, journey, answer, count = 20) {
  const made = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'diagnostic', config: { count } }).assessment;
  t.call('assessment:start', { assessmentId: made.id });
  made.items.forEach((item, i) => t.call('assessment:saveAnswer', { itemId: item.id, response: answer(item, i) }));
  t.call('assessment:submit', { assessmentId: made.id });
  gradeOpen(t, made.id, { c1: 'missing', c2: 'missing' });
  return made;
}
const wrongChoice = (item, i) => (item.question.type === 'choice' ? { choice: ['a'], confidence: 3 } : item.question.type === 'truefalse' ? { value: false } : item.question.type === 'explain' ? { text: 'unsure' } : { dontKnow: true });

test('analysis names mistake categories, groups them by topic and ranks the weak topics', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const made = runDiagnostic(t, journey, wrongChoice);
  const analysis = t.call('assessment:analysis', { assessmentId: made.id });
  assert.ok(analysis.byCategory.misconception >= 1, 'confident and wrong is a misconception');
  assert.ok(analysis.byCategory.not_known >= 1, 'a dont-know is not_known');
  assert.ok(analysis.weak.length >= 1 && analysis.weak[0].title.startsWith('Topic '));
  assert.ok(analysis.weak.every((w, i, all) => i === 0 || all[i - 1].score >= w.score), 'ranked, highest score first');
  assert.ok(analysis.items.every(i => i.label === '' || typeof i.label === 'string'));
  assert.ok(analysis.topics.every(x => typeof x.mistakes === 'number'));
  assert.throws(() => t.call('assessment:analysis', { assessmentId: t.call('assessment:create', { subjectId: 's1', kind: 'practice', config: { count: 2 } }).assessment.id }), /Submit the assessment/);
  t.as({ id: 'v' });
  assert.throws(() => t.call('assessment:analysis', { assessmentId: made.id }), /not found/i);
});

test('targeted notes: one Markdown file per weak topic, from the student\'s own mistakes, no AI', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  assert.throws(() => t.call('notes:targeted', { journeyId: journey.id }), /Take a pre-test first/);
  runDiagnostic(t, journey, wrongChoice);
  const notes = t.call('notes:targeted', { journeyId: journey.id });
  assert.ok(notes.length >= 1 && notes.every(n => n.kind === 'targeted_note' && n.text.startsWith('# Targeted note: Topic ')));
  assert.ok(notes.every(n => /\*\*You answered:\*\*/.test(n.text)), 'it quotes what the student answered');
  const file = path.join(t.dir, 'learning-files', 'u', 'journeys', journey.id, notes[0].bodyFile);
  assert.equal(fs.readFileSync(file, 'utf8'), notes[0].text, 'the file is what is returned');
  assert.equal(t.call('notes:list', { journeyId: journey.id, kind: 'targeted_note' }).length, notes.length);
  t.as({ id: 'v' });
  assert.throws(() => t.call('notes:targeted', { journeyId: journey.id }), /not found/i);
  assert.throws(() => t.call('notes:list', { journeyId: journey.id }), /not found/i);
});

test('review queue: a mistake enters box 1, practice moves it, due mistakes come first in the next practice set', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  runDiagnostic(t, journey, wrongChoice); // mistakes are queued even outside practice
  assert.equal(t.call('review:due', { subjectId: 's1' }).count, 0, 'due tomorrow, not today');
  t.clock.now += 2 * 86400000;
  const due = t.call('review:due', { subjectId: 's1' });
  assert.ok(due.count >= 1);
  assert.ok(due.items.every(r => r.box === 1 && r.lastResult === 'wrong'));
  const practice = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'practice', config: { count: 3 } }).assessment;
  assert.ok(due.items.slice(0, 3).every(r => practice.items.some(i => i.question.id === r.questionId)), 'due mistakes are in the set');
  t.call('assessment:start', { assessmentId: practice.id });
  for (const item of practice.items) {
    const right = due.items.some(r => r.questionId === item.question.id);
    t.call('assessment:saveAnswer', { itemId: item.id, response: item.question.type === 'choice' ? { choice: [right ? 'b' : 'a'] } : item.question.type === 'truefalse' ? { value: true } : { text: 'x' } });
  }
  t.call('assessment:submit', { assessmentId: practice.id });
  gradeOpen(t, practice.id, { c1: 'met', c2: 'met' });
  const moved = t.store.getReview('u', { questionId: due.items[0].questionId });
  assert.ok(moved.box >= 1 && moved.lastResult === 'correct' ? moved.box === 2 : true, 'a correct practice answer climbs a box');
  t.as({ id: 'v' });
  assert.throws(() => t.call('review:due', { subjectId: 's1' }), /not found/i);
});

test('practice these: exactly the listed questions', () => {
  const t = setup(); seed(t);
  const questions = t.call('questions:list', { subjectId: 's1' });
  const only = [questions[0].id, questions[2].id];
  const made = t.call('assessment:create', { subjectId: 's1', kind: 'practice', config: { only } }).assessment;
  assert.deepEqual(made.items.map(i => i.question.id).sort(), only.sort());
});

test('template drafts come from analysed files, are not stored, and are hidden once accepted', () => {
  const t = setup();
  const first = t.call('questions:templates', { subjectId: 's1' });
  assert.ok(first.drafts.length >= 4 && first.analysed === 1 && first.files === 1);
  assert.equal(t.call('questions:list', { subjectId: 's1' }).length, 0, 'drafts are not stored');
  assert.ok(first.drafts.every(d => d.origin === 'template' && d.source[0].fileId === 'f1'));
  const saved = t.call('questions:save', { question: first.drafts[0] });
  assert.equal(saved.origin, 'template');
  assert.equal(t.call('questions:templates', { subjectId: 's1' }).drafts.length, first.drafts.length - 1, 'an accepted draft is not offered again');
  t.as({ id: 'v' });
  assert.throws(() => t.call('questions:templates', { subjectId: 's1' }), /not found/i);
});

test('the retake gate also needs every targeted note opened, and only review sessions after the attempt count', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  runDiagnostic(t, journey, wrongChoice, 4);
  const notes = t.call('notes:targeted', { journeyId: journey.id });
  const made = t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: finalConfig({ count: 6, timeMultiplier: 0 }) }).assessment;
  t.call('assessment:start', { assessmentId: made.id }); answerAll(t, made, 'a'); t.call('assessment:submit', { assessmentId: made.id });
  gradeOpen(t, made.id, { c1: 'missing', c2: 'missing' });
  const gate = t.call('assessment:retakeStatus', { assessmentId: made.id });
  const failing = gate.topics.filter(x => x.missingNotes.length);
  assert.ok(failing.length >= 1, 'a topic with a targeted note must have it opened');
  const review = t.store.startSession('u', { subjectId: 's1', journeyId: journey.id, kind: 'review' });
  t.store.markVisited('u', { sessionId: review.id, sections: gate.topics.flatMap(x => x.missingSections.map(section => ({ fileId: 'f1', section }))) });
  assert.equal(t.call('assessment:retakeStatus', { assessmentId: made.id }).ready, false, 'sections alone are not enough');
  t.store.markVisited('u', { sessionId: review.id, materials: notes.map(n => n.id) });
  assert.equal(t.call('assessment:retakeStatus', { assessmentId: made.id }).ready, true);
  t.as({ id: 'v' });
  assert.throws(() => t.call('assessment:retakeStatus', { assessmentId: made.id }), /not found/i);
});

// ───────── final learning, history, retention (D9, spec §3.7, §5.1)
test('a real final needs final learning first: a review session ended after the pre-test; the evaluation moves the stage', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  runDiagnostic(t, journey, wrongChoice, 4);
  const evaluation = t.call('journey:evaluation', { journeyId: journey.id });
  assert.equal(evaluation.cycle, 1); assert.ok(evaluation.weak.length >= 1); assert.equal(evaluation.ready, false);
  assert.equal(t.call('journey:get', { journeyId: journey.id }).stage, 'final_learning');
  // A real final is refused before final learning (the 50–100 rule would also refuse it, so check the gate through a direct call order):
  const gateError = () => { try { t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: { count: 50 } }); return ''; } catch (error) { return error.message; } };
  assert.match(gateError(), /Final learning first/);
  const review = t.store.startSession('u', { subjectId: 's1', journeyId: journey.id, kind: 'review' });
  assert.match(gateError(), /Final learning first/, 'a running session is not enough');
  t.store.endSession('u', { sessionId: review.id });
  assert.match(gateError(), /50–100 questions/, 'the gate is open; the exam size rule speaks next');
  assert.equal(t.call('journey:evaluation', { journeyId: journey.id }).ready, true);
  t.as({ id: 'v' });
  assert.throws(() => t.call('journey:evaluation', { journeyId: journey.id }), /not found/i);
});

test('history lists every assessment with score and the levels right after it; abandoned ones are excluded; cycles sit side by side', () => {
  const t = setup(); seed(t);
  const one = t.call('journey:create', { subjectId: 's1' });
  runDiagnostic(t, one, wrongChoice, 4);
  const dropped = t.call('assessment:create', { subjectId: 's1', journeyId: one.id, kind: 'practice', config: { count: 2 } }).assessment;
  t.call('assessment:start', { assessmentId: dropped.id }); t.call('assessment:abandon', { assessmentId: dropped.id });
  const two = t.call('journey:create', { subjectId: 's1', parentId: one.id });
  const history = t.call('learning:history', { subjectId: 's1' });
  assert.deepEqual(history.map(h => h.cycle), [1, 2]);
  const first = history[0].assessments;
  assert.equal(first.length, 2);
  assert.equal(first[0].kind, 'diagnostic'); assert.ok(first[0].score !== null && first[0].percent !== null && first[0].levels.length === 2 && !first[0].excluded);
  assert.equal(first[1].excluded, true); assert.equal(first[1].score, null);
  assert.equal(history[1].id, two.id); assert.deepEqual(history[1].assessments, []);
  t.as({ id: 'v' });
  assert.throws(() => t.call('learning:history', { subjectId: 's1' }), /not found/i);
});

test('retention: opens 7 days after a real final; recall and understanding items on Proficient topics only', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  assert.equal(t.call('retention:status', { journeyId: journey.id }).eligible, false);
  assert.throws(() => t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'retention', config: { count: 3 } }), /Take a final exam first/);
  // A test final does not open the retention check; seven days after a real one would. Simulate a real final row directly.
  const pool = t.store.listQuestions('u', { subjectId: 's1' }).map(q => q.id);
  const made = t.store.createAssessment('u', { subjectId: 's1', journeyId: journey.id, kind: 'final', config: { test: false, passMark: 0.8, timeLimitSeconds: null }, questionIds: pool.slice(0, 2) });
  t.store.startAssessment('u', { assessmentId: made.id });
  t.store.submitAssessment('u', { assessmentId: made.id });
  const before = t.call('retention:status', { journeyId: journey.id });
  assert.equal(before.eligible, false); assert.match(before.reason, /opens 7 days after the final/);
  t.clock.now += 8 * 86400000;
  assert.equal(t.call('retention:status', { journeyId: journey.id }).eligible, true);
  assert.throws(() => t.call('assessment:create', { subjectId: 's1', journeyId: journey.id, kind: 'retention', config: { count: 3 } }), /No topic is Proficient yet/);
});

test('practice retry: one second try on a wrong deterministic answer, scored half; never twice, never for written answers', () => {
  const t = setup(); seed(t);
  const choice = t.call('questions:list', { subjectId: 's1' }).find(q => q.type === 'choice');
  const { assessment } = t.call('assessment:create', { subjectId: 's1', kind: 'practice', config: { only: [choice.id] } });
  t.call('assessment:start', { assessmentId: assessment.id });
  const item = assessment.items[0];
  assert.throws(() => t.call('assessment:retry', { assessmentId: assessment.id, itemId: item.id }), /Answer the question first|only for a wrong answer/);
  t.call('assessment:saveAnswer', { itemId: item.id, response: { choice: ['a'] } });
  const first = t.call('assessment:check', { assessmentId: assessment.id, itemId: item.id });
  assert.equal(first.score, 0); assert.equal(first.retryable, true); assert.equal(first.attempt, 1);
  assert.equal(t.call('assessment:retry', { assessmentId: assessment.id, itemId: item.id }).attempt, 2);
  assert.throws(() => t.call('assessment:retry', { assessmentId: assessment.id, itemId: item.id }), /already used your second try/);
  t.call('assessment:saveAnswer', { itemId: item.id, response: { choice: ['b'] } });
  const second = t.call('assessment:check', { assessmentId: assessment.id, itemId: item.id });
  assert.equal(second.attempt, 2); assert.equal(second.score, second.max / 2, 'a right answer on the second try counts half'); assert.equal(second.retryable, false);
  t.call('assessment:submit', { assessmentId: assessment.id });
  const stored = t.call('assessment:results', { assessmentId: assessment.id }).items[0].answer;
  assert.equal(stored.score, stored.attempt === 2 ? 0.5 : stored.score); assert.equal(stored.score, 0.5);
  // written answers and other kinds have no second try
  const open = t.call('questions:list', { subjectId: 's1' }).find(q => q.type === 'explain');
  const p2 = t.call('assessment:create', { subjectId: 's1', kind: 'practice', config: { only: [open.id] } }).assessment;
  t.call('assessment:start', { assessmentId: p2.id });
  t.call('assessment:saveAnswer', { itemId: p2.items[0].id, response: { text: 'x' } });
  assert.throws(() => t.call('assessment:retry', { assessmentId: p2.id, itemId: p2.items[0].id }), /only for choice, true\/false and matching/);
  const diag = t.call('assessment:create', { subjectId: 's1', kind: 'diagnostic', config: { count: 1, types: ['choice'] } }).assessment;
  t.call('assessment:start', { assessmentId: diag.id });
  t.call('assessment:saveAnswer', { itemId: diag.items[0].id, response: { choice: ['a'] } });
  assert.throws(() => t.call('assessment:retry', { assessmentId: diag.id, itemId: diag.items[0].id }), /only for a practice set/);
  t.as({ id: 'v' });
  assert.throws(() => t.call('assessment:retry', { assessmentId: assessment.id, itemId: item.id }), /not found/i);
});

test('scheduling: the calendar event and its link are created together, rolled back together, and cancelling removes both', () => {
  const t = setup(); seed(t);
  const journey = t.call('journey:create', { subjectId: 's1' });
  const at = new Date(t.clock.now + 3600e3).toISOString(); const end = new Date(t.clock.now + 7200e3).toISOString();
  const made = t.call('schedule:create', { journeyId: journey.id, kind: 'practice', startsAt: at, endsAt: end, topicIds: ['t1'] });
  assert.equal(made.kind, 'practice'); assert.deepEqual(made.topicIds, ['t1']); assert.match(made.title, /^Practice: Biology/);
  const rows = db => db.prepare('SELECT count(*) AS n FROM events').get().n;
  assert.equal(t.call('schedule:list', { subjectId: 's1' }).length, 1);
  // a bad topic id: nothing is left behind, not even the event
  const eventsBefore = t.store.constructor && t.rawDb.prepare('SELECT count(*) AS n FROM events').get().n;
  assert.throws(() => t.call('schedule:create', { journeyId: journey.id, kind: 'final', startsAt: at, endsAt: end, topicIds: ['tv'] }), /not found/i);
  assert.equal(t.rawDb.prepare('SELECT count(*) AS n FROM events').get().n, eventsBefore, 'the event was rolled back with the failed link');
  assert.throws(() => t.call('schedule:create', { journeyId: journey.id, kind: 'party', startsAt: at, endsAt: end }), /Kind must be one of/);
  t.as({ id: 'v' });
  assert.throws(() => t.call('schedule:list', { subjectId: 's1' }), /not found/i);
  assert.throws(() => t.call('schedule:cancel', { scheduleId: made.id }), /not found/i);
  t.as({ id: 'u' });
  t.call('schedule:cancel', { scheduleId: made.id });
  assert.equal(t.call('schedule:list', { subjectId: 's1' }).length, 0);
  assert.equal(t.rawDb.prepare('SELECT count(*) AS n FROM events').get().n, eventsBefore - 1, 'the event is gone');
  assert.equal(t.rawDb.prepare('SELECT count(*) AS n FROM learning_schedule').get().n, 0, 'and so is the link (cascade)');
});

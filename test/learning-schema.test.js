'use strict';
/* LS-005: workspace migration 2, the Learning System tables (src/learning-schema.js, ADR-004, spec §6.2). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { userVersion, listBackups } = require('../src/db-migrate');
const { createWorkspace, WORKSPACE_MIGRATIONS } = require('../src/workspace');
const { learningSchemaV2, JOURNEY_STAGES, LEARNING_TABLES } = require('../src/learning-schema');
const { dumpSchema } = require('./fixtures/schema/generate');

const FIXTURES = path.join(__dirname, 'fixtures', 'schema');
const fixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const NO_SECRETS = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
const V1 = WORKSPACE_MIGRATIONS.slice(0, 1);
const T = '2026-11-23T10:00:00.000Z';

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-ls005-'));
  const handles = [];
  t.after(() => { for (const h of handles.reverse()) try { h.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const track = handle => (handles.push(handle), handle);
  return { root, file: path.join(root, 'workspace.sqlite'), open: (options = {}) => track(new DatabaseSync(path.join(root, 'workspace.sqlite'), options)), track };
}
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

// An in-memory database at v2, with foreign keys on, as the app opens it.
function memoryV2() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of WORKSPACE_MIGRATIONS) migration.up(db);
  return db;
}
function insert(db, table, values) {
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values));
}
const stamps = { created_at: T, updated_at: T };

// One row in every learning table, hanging off subject s1 and topic t1.
function seedLearning(db) {
  insert(db, 'subjects', { id: 's1', user_id: 'u', profile: 'study', name: 'Biology', ...stamps });
  insert(db, 'subject_topics', { id: 't1', user_id: 'u', subject_id: 's1', title: 'Cells', ...stamps });
  insert(db, 'events', { id: 'e1', user_id: 'u', title: 'Study', starts_at: T });
  insert(db, 'focus_entries', { id: 'f1', user_id: 'u', started_at: T, ended_at: T, duration_seconds: 60 });
  insert(db, 'learning_journeys', { id: 'j1', user_id: 'u', subject_id: 's1', title: 'Cycle 1', ...stamps });
  insert(db, 'journey_topics', { journey_id: 'j1', topic_id: 't1', user_id: 'u', ...stamps });
  insert(db, 'question_items', { id: 'q1', user_id: 'u', subject_id: 's1', topic_id: 't1', type: 'choice', dimension: 'recognition', points: 1, prompt: 'Which?', payload: '{}', origin: 'manual', review: 'approved', ...stamps });
  insert(db, 'assessments', { id: 'a1', user_id: 'u', subject_id: 's1', journey_id: 'j1', kind: 'final', ...stamps });
  insert(db, 'assessments', { id: 'a2', user_id: 'u', subject_id: 's1', journey_id: 'j1', kind: 'final', attempt: 2, retake_of: 'a1', ...stamps });
  insert(db, 'assessment_items', { id: 'i1', user_id: 'u', assessment_id: 'a1', question_id: 'q1', position: 0, topic_id: 't1', dimension: 'recognition', max_score: 1, question_snapshot: '{}', ...stamps });
  insert(db, 'assessment_answers', { id: 'n1', user_id: 'u', item_id: 'i1', saved_at: T, ...stamps });
  insert(db, 'learning_sessions', { id: 'ls1', user_id: 'u', subject_id: 's1', journey_id: 'j1', topic_id: 't1', kind: 'main', started_at: T, focus_entry_id: 'f1', ...stamps });
  insert(db, 'learning_materials', { id: 'm1', user_id: 'u', subject_id: 's1', journey_id: 'j1', topic_id: 't1', session_id: 'ls1', kind: 'side_note', ...stamps });
  insert(db, 'learning_materials', { id: 'm2', user_id: 'u', subject_id: 's1', journey_id: 'j1', kind: 'side_note_ai', parent_material_id: 'm1', origin: 'generated', ...stamps });
  insert(db, 'learning_schedule', { id: 'c1', user_id: 'u', event_id: 'e1', journey_id: 'j1', kind: 'session', ...stamps });
  insert(db, 'question_review', { user_id: 'u', question_id: 'q1', due_on: '2026-11-30', ...stamps });
}

test('JOURNEY_STAGES: the 13 frozen keys of spec §2.2 stages 3–15, in order', () => {
  assert.deepEqual([...JOURNEY_STAGES], ['material', 'pretest_setup', 'pretest', 'diagnostic', 'targeted_notes', 'main_learning',
    'practice', 'mistake_analysis', 'supplementary', 'final_learning', 'final_exam', 'report', 'retention']);
  assert.ok(Object.isFrozen(JOURNEY_STAGES));
  assert.equal(WORKSPACE_MIGRATIONS.length, 2);
  assert.equal(WORKSPACE_MIGRATIONS[1].up, learningSchemaV2);
});

test('fresh install reaches user_version 2, equals the v2 fixture, and every v1 object is unchanged', t => {
  const box = sandbox(t);
  const workspace = box.track(createWorkspace(box.root));
  workspace.connectionStore(NO_SECRETS);
  workspace.close();
  const got = dumpSchema(box.file);
  assert.deepEqual(got, fixture('workspace-v2.json'));
  const db = box.open({ readOnly: true });
  assert.equal(userVersion(db), 2);
  assert.deepEqual(listBackups(box.file), [], 'a new, empty database is not backed up');

  const v1 = fixture('workspace-v1.json');
  const v1Names = new Set(v1.objects.map(o => `${o.type}:${o.name}`));
  assert.deepEqual(got.objects.filter(o => v1Names.has(`${o.type}:${o.name}`)), v1.objects, 'v1 objects: same SQL');
  for (const table of Object.keys(v1.columns)) assert.deepEqual(got.columns[table], v1.columns[table], `${table}: same columns`);
  const added = got.objects.filter(o => !v1Names.has(`${o.type}:${o.name}`));
  assert.deepEqual(added.filter(o => o.type === 'table').map(o => o.name).sort(), [...LEARNING_TABLES].sort());
  assert.ok(added.every(o => LEARNING_TABLES.includes(o.tbl_name)), 'every new index belongs to a new table');
  // Migration 2 contains only CREATE TABLE / CREATE INDEX statements.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'learning-schema.js'), 'utf8');
  assert.doesNotMatch(source, /\b(ALTER|DROP|INSERT|UPDATE|DELETE\s+FROM)\b/);
});

test('upgrade from v1 with rows in subjects, topics, files, events, focus entries: rows identical, backup, clean FKs, second start no-op', t => {
  const box = sandbox(t);
  box.track(createWorkspace(box.root, { migrations: V1 })).close();
  const raw = box.open();
  assert.equal(userVersion(raw), 1);
  insert(raw, 'subjects', { id: 's1', user_id: 'u', profile: 'study', name: 'Biology', mastery: 40, minutes: 90, ...stamps });
  insert(raw, 'subject_files', { id: 'sf1', user_id: 'u', subject_id: 's1', name: 'cells.pdf', stored_name: 'sf1.pdf', type: 'application/pdf', size: 10, text: 'Membrane', created_at: T, preview_name: 'p.pdf' });
  insert(raw, 'subject_topics', { id: 't1', user_id: 'u', subject_id: 's1', title: 'Cells', file_id: 'sf1', page: 3, ...stamps });
  insert(raw, 'events', { id: 'e1', user_id: 'u', title: 'Lab', starts_at: T, ends_at: T, notes: 'bring coat' });
  insert(raw, 'focus_entries', { id: 'f1', user_id: 'u', started_at: T, ended_at: T, duration_seconds: 1500, skill: 'bio' });
  const v1Tables = tables(raw);
  const before = Object.fromEntries(v1Tables.map(name => [name, rows(raw, name)]));
  raw.close();

  box.track(createWorkspace(box.root)).close();
  const db = box.open({ readOnly: true });
  assert.equal(userVersion(db), 2);
  for (const name of v1Tables) assert.deepEqual(rows(db, name), before[name], `${name}: rows identical`);
  assert.deepEqual(tables(db), [...v1Tables, ...LEARNING_TABLES].sort());
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const backups = listBackups(box.file);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].from, 1);
  assert.match(path.basename(backups[0].file), /^workspace\.sqlite\.bak-v1-/);
  const copy = box.track(new DatabaseSync(backups[0].file, { readOnly: true }));
  assert.equal(userVersion(copy), 1);
  assert.ok(!tables(copy).includes('learning_journeys'), 'the backup is the v1 database');
  copy.close();
  const bytes = fs.readFileSync(box.file);
  db.close();

  box.track(createWorkspace(box.root)).close();
  assert.equal(listBackups(box.file).length, 1, 'second start makes no backup');
  assert.ok(fs.readFileSync(box.file).equals(bytes), 'second start leaves the file byte-identical');
});

test('injected failure inside migration 2: stays v1, no new table, backup exists and passes integrity_check', t => {
  const box = sandbox(t);
  const first = box.track(createWorkspace(box.root, { migrations: V1 }));
  first.createPlannerItem('u', { kind: 'whim', text: 'Keep me' });
  first.close();
  const failing = [...V1, { version: 2, up: db => { learningSchemaV2(db); throw new Error('simulated LS-005 failure'); } }];
  assert.throws(() => createWorkspace(box.root, { migrations: failing }), /step 2 of 2\)\. That step was undone.*simulated LS-005 failure/s);

  const db = box.open({ readOnly: true });
  assert.equal(userVersion(db), 1);
  for (const name of LEARNING_TABLES) assert.ok(!tables(db).includes(name), `${name} was not left behind`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'learning_%' OR name LIKE 'question_%' OR name LIKE 'assessment%'").get().n, 0);
  db.close();
  const backups = listBackups(box.file);
  assert.equal(backups.length, 1);
  const copy = box.track(new DatabaseSync(backups[0].file, { readOnly: true }));
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(rows(copy, 'planner_items').map(r => r.text), ['Keep me']);
  copy.close();

  // The next normal start applies migration 2 to the same file.
  box.track(createWorkspace(box.root)).close();
  const after = box.open({ readOnly: true });
  assert.equal(userVersion(after), 2);
});

test('cascade: deleting a subject removes journeys, questions, assessments, items, answers, sessions, materials, schedule links, review boxes', t => {
  const db = memoryV2();
  t.after(() => db.close());
  seedLearning(db);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  for (const name of LEARNING_TABLES) assert.ok(count(db, name) > 0, `${name} seeded`);
  db.prepare("DELETE FROM subjects WHERE id='s1'").run();
  for (const name of LEARNING_TABLES) assert.equal(count(db, name), 0, `${name} emptied`);
  assert.equal(count(db, 'events'), 1, 'the calendar event itself is kept');
  assert.equal(count(db, 'focus_entries'), 1, 'the focus entry itself is kept');
});

test('deleting a topic sets topic_id NULL on questions, items, sessions, materials and drops it from journey scopes', t => {
  const db = memoryV2();
  t.after(() => db.close());
  seedLearning(db);
  db.prepare("DELETE FROM subject_topics WHERE id='t1'").run();
  for (const name of ['question_items', 'assessment_items', 'learning_sessions', 'learning_materials'])
    assert.ok(db.prepare(`SELECT topic_id FROM ${name}`).all().every(r => r.topic_id === null), `${name}.topic_id NULL`);
  assert.equal(count(db, 'question_items'), 1);
  assert.equal(count(db, 'assessment_items'), 1);
  assert.equal(count(db, 'journey_topics'), 0);
});

test('other deletes: event removes its schedule link; question keeps items; parent side note removes its AI note; retake link cleared', t => {
  const db = memoryV2();
  t.after(() => db.close());
  seedLearning(db);
  db.prepare("DELETE FROM events WHERE id='e1'").run();
  assert.equal(count(db, 'learning_schedule'), 0);
  db.prepare("DELETE FROM focus_entries WHERE id='f1'").run();
  assert.equal(db.prepare("SELECT focus_entry_id FROM learning_sessions").get().focus_entry_id, null);
  db.prepare("DELETE FROM question_items WHERE id='q1'").run();
  assert.equal(db.prepare("SELECT question_id FROM assessment_items WHERE id='i1'").get().question_id, null);
  assert.equal(count(db, 'question_review'), 0);
  db.prepare("DELETE FROM learning_materials WHERE id='m1'").run();
  assert.equal(count(db, 'learning_materials'), 0);
  db.prepare("DELETE FROM assessments WHERE id='a1'").run();
  assert.equal(db.prepare("SELECT retake_of FROM assessments WHERE id='a2'").get().retake_of, null);
  assert.equal(count(db, 'assessment_answers'), 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('defaults: attempt 1, visited JSON shape, stage material, review unreviewed, grade_status pending', t => {
  const db = memoryV2();
  t.after(() => db.close());
  seedLearning(db);
  assert.equal(db.prepare("SELECT attempt FROM assessments WHERE id='a1'").get().attempt, 1);
  assert.deepEqual(JSON.parse(db.prepare('SELECT visited FROM learning_sessions').get().visited), { sections: [], materials: [] });
  const journey = db.prepare("SELECT stage, status, cycle FROM learning_journeys").get();
  assert.deepEqual({ ...journey }, { stage: 'material', status: 'active', cycle: 1 });
  const answer = db.prepare('SELECT grade_status, dont_know, score FROM assessment_answers').get();
  assert.deepEqual({ ...answer }, { grade_status: 'pending', dont_know: 0, score: null });
});

test('CHECK constraints reject unknown stage, kind, type, review, grade_status (and other enums)', t => {
  const db = memoryV2();
  t.after(() => db.close());
  seedLearning(db);
  const rejects = (sql, label) => assert.throws(() => db.exec(sql), /CHECK constraint failed/, label);
  for (const stage of JOURNEY_STAGES) db.exec(`UPDATE learning_journeys SET stage='${stage}'`);
  rejects("UPDATE learning_journeys SET stage='next_cycle'", 'stage');
  rejects("UPDATE learning_journeys SET stage='subject'", 'stage before a journey');
  rejects("UPDATE learning_journeys SET status='paused'", 'journey status');
  rejects("UPDATE assessments SET kind='quiz'", 'assessment kind');
  rejects("UPDATE assessments SET status='open'", 'assessment status');
  rejects("UPDATE assessments SET attempt=0", 'attempt');
  rejects("UPDATE learning_sessions SET kind='cram'", 'session kind');
  rejects("UPDATE learning_materials SET kind='highlight'", 'material kind');
  rejects("UPDATE learning_materials SET parent_material_id=NULL WHERE id='m2'", 'side_note_ai needs a parent');
  rejects("UPDATE learning_schedule SET kind='exam'", 'schedule kind');
  rejects("UPDATE question_items SET type='fill'", 'question type');
  rejects("UPDATE question_items SET dimension='retention'", 'question dimension');
  rejects("UPDATE question_items SET review='pending'", 'review');
  rejects("UPDATE question_items SET status='draft'", 'question status');
  rejects("UPDATE question_items SET origin='ai'", 'origin');
  rejects("UPDATE question_items SET difficulty=4", 'difficulty');
  rejects("UPDATE question_items SET payload='not json'", 'payload JSON');
  rejects("UPDATE assessment_answers SET grade_status='done'", 'grade_status');
  rejects("UPDATE assessment_answers SET grader='teacher'", 'grader');
  rejects("UPDATE assessment_answers SET confidence=5", 'confidence');
  rejects("UPDATE learning_sessions SET visited='[oops'", 'visited JSON');
  rejects("UPDATE question_review SET box=6", 'box');
  assert.throws(() => insert(db, 'assessment_items', { id: 'i2', user_id: 'u', assessment_id: 'a1', position: 0, dimension: 'recall', max_score: 1, question_snapshot: '{}', ...stamps }), /UNIQUE constraint failed/, 'position unique per assessment');
  assert.throws(() => insert(db, 'assessment_answers', { id: 'n2', user_id: 'u', item_id: 'i1', saved_at: T, ...stamps }), /UNIQUE constraint failed/, 'one answer per item');
  assert.throws(() => insert(db, 'learning_journeys', { id: 'j9', user_id: 'u', subject_id: 'missing', title: 'x', ...stamps }), /FOREIGN KEY constraint failed/);
});

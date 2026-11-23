'use strict';
/* PF-006: versioned, transactional schema migrations with a backup (src/db-migrate.js, ADR-002). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { migrate, backupDatabase, pruneBackups, listBackups, userVersion } = require('../src/db-migrate');
const { createWorkspace, WORKSPACE_MIGRATIONS } = require('../src/workspace');
const { createAuth, ACCOUNT_MIGRATIONS } = require('../src/auth');
const { dumpSchema } = require('./fixtures/schema/generate');
// PF-006 tests pin the workspace to migration 1 so they keep testing the v1 upgrade path; migration 2 (LS-005) has its own tests.
const V1 = WORKSPACE_MIGRATIONS.slice(0, 1);

const FIXTURES = path.join(__dirname, 'fixtures', 'schema');
const expected = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}-v1.json`), 'utf8'));
const NO_SECRETS = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' };
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Temp folder removed after the test; every database opened through `open` is closed first (Windows locks open files).
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-pf006-'));
  const handles = [];
  t.after(() => { for (const h of handles.reverse()) try { h.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const track = handle => (handles.push(handle), handle);
  return { root, file: name => path.join(root, name), open: (file, options = {}) => track(new DatabaseSync(file, options)), track };
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const columnsByName = list => Object.fromEntries(list.map(col => [col.name, col]));

function seedFixture(box, sqlFile) {
  const db = box.open(box.file('workspace.sqlite'));
  db.exec(fs.readFileSync(path.join(FIXTURES, sqlFile), 'utf8'));
  assert.equal(userVersion(db), 0);
  const before = Object.fromEntries(tables(db).map(name => [name, rows(db, name)]));
  db.close();
  return before;
}

test('VACUUM INTO under node:sqlite writes a consistent, openable copy with the same rows and user_version', t => {
  const box = sandbox(t);
  const db = box.open(box.file('live.sqlite'));
  db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES ('a'),('b'),('c'); PRAGMA user_version = 4");
  const copy = backupDatabase(db, box.file('live.sqlite'), { now: new Date('2026-11-23T04:30:00.123Z') });
  assert.equal(path.basename(copy), 'live.sqlite.bak-v4-20261123T043000123Z');
  assert.ok(!fs.existsSync(`${copy}.tmp`), 'no temporary file is left behind');
  const restored = box.open(copy, { readOnly: true });
  assert.deepEqual(rows(restored, 'notes'), rows(db, 'notes'));
  assert.equal(userVersion(restored), 4);
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  // Same timestamp twice: the second copy gets a sequence suffix instead of failing or overwriting.
  const second = backupDatabase(db, box.file('live.sqlite'), { now: new Date('2026-11-23T04:30:00.123Z') });
  assert.equal(path.basename(second), 'live.sqlite.bak-v4-20261123T043000123Z-1');
});

test('fresh install: both databases reach user_version 1 with exactly the schema main created, and no backup', t => {
  const box = sandbox(t);
  const auth = box.track(createAuth(box.root));
  const workspace = box.track(createWorkspace(box.root, { migrations: V1 }));
  workspace.connectionStore(NO_SECRETS);
  workspace.close(); auth.close();
  for (const name of ['workspace', 'accounts']) {
    const file = box.file(`${name}.sqlite`);
    assert.deepEqual(dumpSchema(file), expected(name), `${name}: sqlite_master SQL and columns equal the fixture from main`);
    const db = box.open(file, { readOnly: true });
    assert.equal(userVersion(db), 1, `${name} is at version 1`);
    db.close();
    assert.deepEqual(listBackups(file), [], `${name}: a new, empty database is not backed up`);
  }
});

for (const [fixture, check] of [
  ['workspace-pre-learning-kind.sql', db => {
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='planner_items'").get().sql, /'learning'/);
    // Pre-existing behavior kept: a project without updated_at gets its created_at.
    assert.equal(db.prepare("SELECT updated_at FROM projects WHERE id='p1'").get().updated_at, '2025-01-05T08:00:00.000Z');
  }],
  ['workspace-pre-preview-name.sql', db => {
    assert.deepEqual(rows(db, 'subject_files').map(r => [r.preview_name, r.preview_status]), [[null, 'none']]);
  }],
  ['workspace-preview-name-only.sql', db => {
    assert.deepEqual(rows(db, 'subject_files').map(r => [r.preview_name, r.preview_status]), [['sf1.preview.pdf', 'none'], [null, 'none']]);
  }]
]) {
  test(`old install (${fixture}) upgrades to v1 with every row kept, both preview columns, and a backup`, t => {
    const box = sandbox(t);
    const before = seedFixture(box, fixture);
    const workspace = box.track(createWorkspace(box.root, { migrations: V1 }));
    workspace.connectionStore(NO_SECRETS);
    workspace.close();

    const db = box.open(box.file('workspace.sqlite'), { readOnly: true });
    assert.equal(userVersion(db), 1);
    for (const [table, oldRows] of Object.entries(before)) {
      const now = rows(db, table);
      assert.equal(now.length, oldRows.length, `${table}: row count kept`);
      oldRows.forEach((old, i) => {
        for (const [column, value] of Object.entries(old))
          if (!(table === 'projects' && column === 'updated_at')) assert.deepEqual(now[i][column], value, `${table}.${column} row ${i} kept`);
      });
    }
    const subjectFileColumns = db.prepare('PRAGMA table_info(subject_files)').all().map(c => c.name);
    assert.ok(subjectFileColumns.includes('preview_name') && subjectFileColumns.includes('preview_status'));
    // Same tables, indexes and column definitions as a fresh v1 install (ALTER-added columns may sit in another order).
    const want = expected('workspace'), got = dumpSchema(box.file('workspace.sqlite'));
    assert.deepEqual(got.objects.map(o => `${o.type}:${o.name}`), want.objects.map(o => `${o.type}:${o.name}`));
    for (const table of Object.keys(want.columns))
      assert.deepEqual(columnsByName(got.columns[table]), columnsByName(want.columns[table]), `${table}: columns equal v1`);
    check(db);
    db.close();

    const backups = listBackups(box.file('workspace.sqlite'));
    assert.equal(backups.length, 1);
    assert.equal(backups[0].from, 0);
    const copy = box.open(backups[0].file, { readOnly: true });
    assert.equal(userVersion(copy), 0, 'the backup is the database as it was before the upgrade');
    for (const [table, oldRows] of Object.entries(before)) assert.deepEqual(rows(copy, table), oldRows, `backup ${table} equals the old rows`);

    // The upgraded database works through the app API (learning planner goals need the rebuilt CHECK).
    const reopened = box.track(createWorkspace(box.root, { migrations: V1 }));
    assert.equal(reopened.createPlannerItem('user-a', { kind: 'learning', text: 'Read chapter 2' }).kind, 'learning');
  });
}

test('an error part-way through migration 1 rolls back the planner_items rebuild and leaves the old install intact', t => {
  const box = sandbox(t);
  const before = seedFixture(box, 'workspace-pre-learning-kind.sql');
  const failing = [{ version: 1, up: db => { WORKSPACE_MIGRATIONS[0].up(db); throw new Error('simulated failure after the rebuild'); } }];
  assert.throws(() => createWorkspace(box.root, { migrations: failing }), error => {
    assert.match(error.message, /could not update its workspace data \(step 1 of 1\)\. That step was undone/);
    assert.match(error.message, /simulated failure after the rebuild/);
    return true;
  });
  const db = box.open(box.file('workspace.sqlite'), { readOnly: true });
  assert.equal(userVersion(db), 0);
  assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name='planner_items'").get().sql, /'learning'/);
  assert.deepEqual(tables(db), Object.keys(before).sort(), 'no table was added or left behind (planner_items_old)');
  for (const [table, oldRows] of Object.entries(before)) assert.deepEqual(rows(db, table), oldRows);
  db.close();
  // The next normal start upgrades the same file.
  box.track(createWorkspace(box.root, { migrations: V1 })).close();
  const after = box.open(box.file('workspace.sqlite'), { readOnly: true });
  assert.equal(userVersion(after), 1);
});

test('injected failure in a migration 2: database stays at v1, no open transaction, usable, backup exists and opens', t => {
  const box = sandbox(t);
  const first = box.track(createWorkspace(box.root, { migrations: V1 }));
  first.createPlannerItem('user-a', { kind: 'whim', text: 'Keep me' });
  first.close();
  const broken = [...V1, { version: 2, up: db => {
    db.exec("CREATE TABLE should_vanish(id TEXT); INSERT INTO planner_items(id,user_id,kind,text,created_at,updated_at) VALUES ('x','user-a','plan','ghost','t','t')");
    throw new Error('simulated migration 2 failure');
  } }];
  assert.throws(() => createWorkspace(box.root, { migrations: broken }), /could not update its workspace data \(step 2 of 2\)\. That step was undone.*A copy from before the update is at .*workspace\.sqlite\.bak-v1-/s);

  const backups = listBackups(box.file('workspace.sqlite'));
  assert.equal(backups.length, 1);
  assert.equal(backups[0].from, 1);
  const copy = box.open(backups[0].file, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(rows(copy, 'planner_items').map(r => r.text), ['Keep me']);
  copy.close();

  const again = box.track(createWorkspace(box.root, { migrations: V1 }));
  assert.deepEqual(again.listPlannerItems('user-a', 'whim').map(i => i.text), ['Keep me']);
  assert.deepEqual(again.listPlannerItems('user-a', 'plan'), [], 'the failed step left no row');
  again.close();
  const db = box.open(box.file('workspace.sqlite'));
  assert.equal(userVersion(db), 1);
  assert.ok(!tables(db).includes('should_vanish'));
});

test('runner: a failed step leaves no open transaction and the same connection stays usable', t => {
  const box = sandbox(t);
  const db = box.open(':memory:');
  const steps = [
    { version: 1, up: d => d.exec('CREATE TABLE a(x)') },
    { version: 2, up: d => { d.exec('INSERT INTO a VALUES (1)'); d.exec('THIS IS NOT SQL'); } }
  ];
  assert.throws(() => migrate(db, { name: 'test', migrations: steps }), /could not update its test data \(step 2 of 2\)/);
  assert.equal(db.isTransaction, false);
  assert.equal(userVersion(db), 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM a').get().n, 0);
  db.exec('INSERT INTO a VALUES (2)'); // usable after the failure
  assert.deepEqual(migrate(db, { name: 'test', migrations: steps.slice(0, 1) }), { from: 1, to: 1, backup: null });
});

test('running startup twice is a no-op: no backup, no schema or byte change', t => {
  const box = sandbox(t);
  seedFixture(box, 'workspace-preview-name-only.sql');
  box.track(createWorkspace(box.root)).close();
  box.track(createAuth(box.root)).close();
  const files = ['workspace.sqlite', 'accounts.sqlite'].map(box.file);
  const backupsBefore = files.map(f => listBackups(f).map(b => b.file));
  assert.deepEqual(backupsBefore.map(list => list.length), [1, 0], 'old workspace backed up once; new accounts file not');
  const hashes = files.map(sha);
  const schemas = files.map(dumpSchema);
  box.track(createWorkspace(box.root)).close();
  box.track(createAuth(box.root)).close();
  assert.deepEqual(files.map(f => listBackups(f).map(b => b.file)), backupsBefore);
  assert.deepEqual(files.map(dumpSchema), schemas);
  assert.deepEqual(files.map(sha), hashes, 'database files are byte-identical after the second start');
});

test('backups are pruned to the newest 3; unrelated files and the live database are never touched', t => {
  const box = sandbox(t);
  const live = box.file('workspace.sqlite');
  const db = box.open(live);
  db.exec('CREATE TABLE a(x); INSERT INTO a VALUES (1)');
  const old = ['20250101T000000000Z', '20250201T000000000Z', '20250301T000000000Z', '20250401T000000000Z']
    .map(at => { const f = `${live}.bak-v0-${at}`; fs.writeFileSync(f, 'old copy'); return f; });
  const unrelated = [`${live}.bak-notes.txt`, `${live}-journal-keep`, box.file('other.sqlite.bak-v0-20240101T000000000Z')];
  unrelated.forEach(f => fs.writeFileSync(f, 'keep'));

  const result = migrate(db, { name: 'workspace', migrations: [{ version: 1, up: d => d.exec('CREATE TABLE b(y)') }], backup: live, now: () => new Date('2026-11-23T05:00:00.000Z') });
  assert.equal(path.basename(result.backup), 'workspace.sqlite.bak-v0-20261123T050000000Z');
  assert.deepEqual(listBackups(live).map(b => path.basename(b.file)),
    ['workspace.sqlite.bak-v0-20261123T050000000Z', 'workspace.sqlite.bak-v0-20250401T000000000Z', 'workspace.sqlite.bak-v0-20250301T000000000Z']);
  assert.ok(!fs.existsSync(old[0]) && !fs.existsSync(old[1]), 'the two oldest copies were removed');
  unrelated.forEach(f => assert.ok(fs.existsSync(f), `${path.basename(f)} untouched`));
  assert.ok(fs.existsSync(live));
  assert.equal(db.prepare('SELECT count(*) AS n FROM a').get().n, 1);
  assert.deepEqual(pruneBackups(live, 3), [], 'nothing more to prune');
});

test('a backup that cannot be written stops the upgrade before any change', t => {
  const box = sandbox(t);
  const db = box.open(box.file('workspace.sqlite'));
  db.exec('CREATE TABLE a(x)');
  const missingDir = path.join(box.root, 'missing', 'workspace.sqlite');
  assert.throws(() => migrate(db, { name: 'workspace', migrations: [{ version: 1, up: d => d.exec('CREATE TABLE b(y)') }], backup: missingDir }),
    /could not make a safety copy of its workspace data before updating it, so nothing was changed/);
  assert.equal(userVersion(db), 0);
  assert.deepEqual(tables(db), ['a']);
  assert.equal(db.isTransaction, false);
});

test('accounts.sqlite uses the same runner: legacy file upgrades to v1 with a backup, rows kept', t => {
  const box = sandbox(t);
  const raw = box.open(box.file('accounts.sqlite'));
  raw.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      display_name TEXT, bio TEXT, image_name TEXT, profile_completed INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users(id,email,password_hash,display_name) VALUES ('u1','old@example.com','unused','Old');`);
  raw.close();
  box.track(createAuth(box.root)).close();
  const db = box.open(box.file('accounts.sqlite'), { readOnly: true });
  assert.equal(userVersion(db), 1);
  const user = db.prepare("SELECT * FROM users WHERE id='u1'").get();
  assert.equal(user.email, 'old@example.com');
  assert.equal(user.cover_theme, 'aurora');
  assert.ok(tables(db).includes('sessions'));
  const want = expected('accounts'), got = dumpSchema(box.file('accounts.sqlite'));
  for (const table of Object.keys(want.columns)) assert.deepEqual(columnsByName(got.columns[table]), columnsByName(want.columns[table]));
  assert.equal(listBackups(box.file('accounts.sqlite')).length, 1);
  assert.equal(ACCOUNT_MIGRATIONS.length, 1);
});

test('runner input checks and a database from a newer app version', t => {
  const box = sandbox(t);
  const db = box.open(':memory:');
  assert.throws(() => migrate(db, { migrations: [] }), /must not be empty/);
  assert.throws(() => migrate(db, { migrations: [{ version: 2, up() {} }] }), /Migration 1 must be/);
  assert.throws(() => migrate(db, { migrations: [{ version: 1 }] }), /Migration 1 must be/);
  db.exec('CREATE TABLE future(x); PRAGMA user_version = 7');
  let ran = false;
  assert.deepEqual(migrate(db, { migrations: [{ version: 1, up: () => { ran = true; } }] }), { from: 7, to: 7, backup: null });
  assert.equal(ran, false, 'nothing runs against a newer schema');
  assert.equal(userVersion(db), 7);
});

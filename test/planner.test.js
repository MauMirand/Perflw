const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../src/workspace');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-planner-'));
  const workspace = createWorkspace(root);
  t.after(() => { workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return workspace;
}

test('plans are dated, optionally timed, completable, editable and account scoped', t => {
  const store = fixture(t);
  const plan = store.createPlannerItem('user-a', { kind: 'plan', text: '  Gym  ', day: '2026-11-16', time: '07:30' });
  assert.equal(plan.text, 'Gym');
  assert.equal(plan.time, '07:30');
  assert.equal(plan.doneOn, null);
  store.createPlannerItem('user-a', { kind: 'plan', text: 'Read', day: '2026-11-16' });
  assert.equal(store.listPlannerItems('user-a', 'plan').length, 2);
  assert.equal(store.listPlannerItems('user-b', 'plan').length, 0);
  const done = store.updatePlannerItem('user-a', plan.id, { doneOn: '2026-11-16', text: 'Gym session', time: '' });
  assert.equal(done.doneOn, '2026-11-16');
  assert.equal(done.text, 'Gym session');
  assert.equal(done.time, null);
  assert.throws(() => store.updatePlannerItem('user-b', plan.id, { text: 'x' }), /not found/);
  assert.throws(() => store.createPlannerItem('user-a', { kind: 'plan', text: 'No day' }), /valid date/);
  assert.throws(() => store.createPlannerItem('user-a', { kind: 'plan', text: 'Bad', day: '2026-11-16', time: '25:00' }), /valid time/);
  assert.throws(() => store.createPlannerItem('user-a', { kind: 'nope', text: 'x' }), /Unknown/);
  assert.throws(() => store.createPlannerItem('user-a', { kind: 'whim', text: '   ' }), /Text/);
  store.deletePlannerItem('user-a', plan.id);
  assert.equal(store.listPlannerItems('user-a', 'plan').length, 1);
  assert.throws(() => store.deletePlannerItem('user-a', plan.id), /not found/);
});

test('whims, routine steps and activities are stored separately; routine keeps order', t => {
  const store = fixture(t);
  store.createPlannerItem('user-a', { kind: 'whim', text: 'Idea' });
  const first = store.createPlannerItem('user-a', { kind: 'routine', text: 'Stretch' });
  const second = store.createPlannerItem('user-a', { kind: 'routine', text: 'Journal' });
  assert.ok(second.position > first.position);
  const activity = store.createPlannerItem('user-a', { kind: 'activity', text: 'Walked', at: '2026-11-15T10:00:00.000Z' });
  assert.equal(activity.createdAt, '2026-11-15T10:00:00.000Z');
  assert.deepEqual(store.listPlannerItems('user-a', 'routine').map(item => item.text), ['Stretch', 'Journal']);
  assert.equal(store.listPlannerItems('user-a').length, 4);
  const ticked = store.updatePlannerItem('user-a', first.id, { doneOn: '2026-11-16' });
  assert.equal(ticked.doneOn, '2026-11-16');
  assert.equal(store.updatePlannerItem('user-a', first.id, { doneOn: null }).doneOn, null);
});

test('chat messages belong to a conversation and are removed with it', t => {
  const store = fixture(t);
  const chat = store.createChat('user-a', 'Weekly review');
  const message = store.addChatMessage('user-a', chat, '  Hello  ');
  assert.equal(message.content, 'Hello');
  assert.equal(store.listChatMessages('user-a', chat).length, 1);
  assert.throws(() => store.listChatMessages('user-b', chat), /not found/);
  assert.throws(() => store.addChatMessage('user-b', chat, 'Hi'), /not found/);
  store.archiveChat('user-a', chat, true);
  assert.throws(() => store.addChatMessage('user-a', chat, 'Hi'), /not found/);
  store.archiveChat('user-a', chat, false);
  store.deleteChat('user-a', chat);
  assert.equal(store.listChats('user-a').length, 0);
});

test('learning goals are stored per user and can be completed', t => {
  const store = fixture(t);
  const goal = store.createPlannerItem('user-a', { kind: 'learning', text: 'Learn watercolor' });
  assert.equal(goal.kind, 'learning');
  const done = store.updatePlannerItem('user-a', goal.id, { doneOn: '2026-11-17' });
  assert.equal(done.doneOn, '2026-11-17');
  assert.deepEqual(store.listPlannerItems('user-a', 'learning').map(i => i.text), ['Learn watercolor']);
  assert.equal(store.listPlannerItems('user-b', 'learning').length, 0);
});

test('existing databases are upgraded to accept learning goals without losing items', t => {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-migrate-'));
  let second = null;
  // One hook: close the reopened database before removing its folder (Windows cannot delete an open file).
  t.after(() => { if (second) second.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const first = createWorkspace(root);
  first.createPlannerItem('user-a', { kind: 'whim', text: 'Keep me' });
  first.close();
  const file = fs.readdirSync(root).find(name => name.endsWith('.db') || name.endsWith('.sqlite'));
  if (!file) return;
  const raw = new DatabaseSync(path.join(root, file));
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE name='planner_items'").get().sql;
  raw.exec('ALTER TABLE planner_items RENAME TO planner_items_new');
  raw.exec(sql.replace(", 'learning'", '').replace(",'learning'", '').replace('planner_items_new', 'planner_items'));
  raw.exec('INSERT INTO planner_items SELECT * FROM planner_items_new; DROP TABLE planner_items_new');
  raw.close();
  second = createWorkspace(root);
  const goal = second.createPlannerItem('user-a', { kind: 'learning', text: 'Spanish' });
  assert.equal(goal.kind, 'learning');
  assert.deepEqual(second.listPlannerItems('user-a', 'whim').map(i => i.text), ['Keep me']);
});

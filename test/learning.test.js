const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../src/workspace');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-learning-'));
  const workspace = createWorkspace(root);
  t.after(() => { workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return workspace;
}

test('subjects are created with defaults, kept per profile and per account, in creation order', t => {
  const store = fixture(t);
  const math = store.createSubject('user-a', 'study', { name: '  Calculus  ' });
  assert.equal(math.name, 'Calculus');
  assert.equal(math.type, 'major');
  assert.equal(math.mastery, 0);
  assert.equal(math.minutes, 0);
  assert.equal(math.description, '');
  assert.equal(math.imageName, null);
  store.createSubject('user-a', 'study', { name: 'Physics', type: 'minor', mastery: 40, minutes: 95, description: 'Mechanics' });
  store.createSubject('user-a', 'personal', { name: 'Guitar' });
  assert.deepEqual(store.listSubjects('user-a', 'study').map(s => s.name), ['Calculus', 'Physics']);
  assert.deepEqual(store.listSubjects('user-a', 'personal').map(s => s.name), ['Guitar']);
  assert.equal(store.listSubjects('user-b', 'study').length, 0);
});

test('subjects can be edited partially and deleted only by their owner', t => {
  const store = fixture(t);
  const s = store.createSubject('user-a', 'study', { name: 'Chemistry', description: 'Organic' });
  const edited = store.updateSubject('user-a', s.id, { mastery: 75, type: 'minor', minutes: 130 });
  assert.equal(edited.name, 'Chemistry');
  assert.equal(edited.description, 'Organic');
  assert.equal(edited.mastery, 75);
  assert.equal(edited.type, 'minor');
  assert.equal(edited.minutes, 130);
  assert.equal(store.updateSubject('user-a', s.id, { imageName: null }).imageName, null);
  assert.throws(() => store.updateSubject('user-b', s.id, { name: 'Taken' }), /not found/);
  assert.throws(() => store.deleteSubject('user-b', s.id), /not found/);
  store.deleteSubject('user-a', s.id);
  assert.equal(store.listSubjects('user-a', 'study').length, 0);
  assert.throws(() => store.deleteSubject('user-a', s.id), /not found/);
});

test('subject input is validated', t => {
  const store = fixture(t);
  assert.throws(() => store.createSubject('user-a', 'work', { name: 'X' }), /study or personal/);
  assert.throws(() => store.listSubjects('user-a', 'other'), /study or personal/);
  assert.throws(() => store.createSubject('user-a', 'study', { name: '   ' }), /Subject name/);
  assert.throws(() => store.createSubject('user-a', 'study', { name: 'x'.repeat(121) }), /Subject name/);
  assert.throws(() => store.createSubject('user-a', 'study', { name: 'X', type: 'elective' }), /Major or Minor/);
  assert.throws(() => store.createSubject('user-a', 'study', { name: 'X', mastery: 101 }), /Mastery/);
  assert.throws(() => store.createSubject('user-a', 'study', { name: 'X', mastery: 12.5 }), /Mastery/);
  assert.throws(() => store.createSubject('user-a', 'study', { name: 'X', minutes: -1 }), /Time spent/);
  assert.throws(() => store.createSubject('user-a', 'study', { name: 'X', description: 'd'.repeat(2001) }), /Description/);
  assert.throws(() => store.createSubject('user-a', 'study', null), /object/);
});

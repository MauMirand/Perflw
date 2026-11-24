'use strict';
/* LS-012: study sessions (src/learning-session-ipc.js) over a real workspace on disk: timer link, one timer at a time, quit and
   crash recovery at the last activity, the student's own side notes, the D13 visited record, account isolation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../src/workspace');
const { registerStudySessionIpc, closeOpenSessions } = require('../src/learning-session-ipc');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup(t, wrap = w => w, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-study-'));
  const workspace = createWorkspace(dir);
  t.after(() => { workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const subject = workspace.createSubject('u', 'study', { name: 'Biology' });
  const topic = workspace.addTopic('u', subject.id, { title: 'Cells' }).added[0];
  const other = workspace.createSubject('v', 'study', { name: 'Chemistry' });
  const handlers = new Map(); let user = { id: 'u' };
  const wrapped = wrap(workspace);
  registerStudySessionIpc({ handle: (c, a) => handlers.set(c, a), requireUser: () => { if (!user) throw new Error('Your session has expired. Log in again.'); return user; }, workspace: wrapped, dataDir: dir, ...extra });
  return { workspace, subject, topic, other, dir, call: (c, a) => handlers.get(c)(a), as: next => { user = next; }, handlers };
}
const focusEntries = (workspace, user = 'u') => workspace.listFocus(user);

test('every study channel exists in the preload bridge and the other way round', t => {
  const s = setup(t);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const used = [...preload.matchAll(/call\('(study:[A-Za-z]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual([...s.handlers.keys()].sort(), used);
});

test('start runs the account timer; a second start, or a manual timer, is refused and changes nothing', t => {
  const s = setup(t);
  const started = s.call('study:start', { subjectId: s.subject.id, topicId: s.topic, kind: 'main' });
  assert.equal(started.session.kind, 'main');
  assert.match(s.workspace.activeTimer('u').description, /^Study: Cells$/);
  assert.throws(() => s.call('study:start', { subjectId: s.subject.id, kind: 'main' }), /timer is already running/);
  const t2 = setup(t);
  t2.workspace.startTimer('u', 'Manual work');
  assert.throws(() => t2.call('study:start', { subjectId: t2.subject.id, kind: 'main' }), /Stop it first, then start the study session/);
  assert.equal(t2.workspace.learningStore().activeSession('u'), null, 'no session was created');
  assert.equal(t2.workspace.activeTimer('u').description, 'Manual work', 'the manual timer is untouched');
});

test('a failed timer start leaves no orphan session', t => {
  const s = setup(t, w => ({ ...w, startTimer: () => { throw new Error('timer broke'); } }));
  assert.throws(() => s.call('study:start', { subjectId: s.subject.id, kind: 'main' }), /timer broke/);
  assert.equal(s.workspace.learningStore().activeSession('u'), null);
});

test('end saves exactly one focus entry with source learning, linked to the session, and clears the timer', async t => {
  const s = setup(t);
  const { session } = s.call('study:start', { subjectId: s.subject.id, topicId: s.topic, kind: 'main' });
  await sleep(1100);
  const ended = s.call('study:end', { sessionId: session.id, summary: 'Chapter one' });
  assert.ok(ended.durationSeconds >= 1);
  assert.deepEqual(ended.topics, ['Cells']);
  const entries = focusEntries(s.workspace);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'learning');
  assert.equal(ended.session.focusEntryId, entries[0].id);
  assert.equal(s.workspace.activeTimer('u'), null, 'no ghost timer');
  assert.throws(() => s.call('study:end', { sessionId: session.id }), /already ended/);
});

test('a timer stopped elsewhere: the session closes at its last activity, without a time entry, with a message', async t => {
  const s = setup(t);
  const { session } = s.call('study:start', { subjectId: s.subject.id, kind: 'main' });
  await sleep(1100);
  s.workspace.stopTimer('u'); // the student stopped it in the timer view
  const ended = s.call('study:end', { sessionId: session.id });
  assert.match(ended.message, /already stopped/);
  assert.equal(ended.session.focusEntryId, null);
  assert.equal(focusEntries(s.workspace).filter(e => e.source === 'learning').length, 0);
  assert.ok(Date.parse(ended.session.endedAt) <= Date.now());
});

test('quit and crash recovery close an open session at its last activity; an unrelated timer survives', async t => {
  const s = setup(t);
  const { session } = s.call('study:start', { subjectId: s.subject.id, kind: 'main' });
  await sleep(1200);
  const touched = s.call('study:touch', { sessionId: session.id }); assert.ok(touched.ok);
  const last = s.workspace.learningStore().getSession('u', { sessionId: session.id }).updatedAt;
  await sleep(300);
  assert.equal(closeOpenSessions({ workspace: s.workspace }), 1);
  const closed = s.workspace.learningStore().getSession('u', { sessionId: session.id });
  assert.equal(closed.endedAt, new Date(last).toISOString(), 'closed at the last activity, not at quit time');
  const entry = focusEntries(s.workspace)[0];
  assert.equal(entry.source, 'learning'); assert.equal(closed.focusEntryId, entry.id);
  assert.ok(entry.duration_seconds >= 1 && entry.duration_seconds <= 3, `about the active time, not later (${entry.duration_seconds}s)`);
  assert.equal(closeOpenSessions({ workspace: s.workspace }), 0, 'nothing left to close');
  s.workspace.startTimer('u', 'Manual later'); // not a session timer
  assert.equal(closeOpenSessions({ workspace: s.workspace }), 0);
  assert.equal(s.workspace.activeTimer('u').description, 'Manual later');
});

test('side notes are the student\'s own text: file equals text, listed apart, a missing file reads as empty', t => {
  const s = setup(t);
  const { session } = s.call('study:start', { subjectId: s.subject.id, topicId: s.topic, kind: 'main' });
  const text = 'Mitochondria make ATP.\n\nRemember: *not* the nucleus.';
  const note = s.call('study:sideNote', { sessionId: session.id, text, page: 3 });
  assert.equal(note.kind, 'side_note'); assert.equal(note.text, text);
  const file = path.join(s.dir, 'learning-files', 'u', 'side-notes', s.subject.id, note.bodyFile);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the body is byte for byte what the student typed');
  assert.deepEqual(s.call('study:notes', { sessionId: session.id }).map(n => n.text), [text]);
  fs.unlinkSync(file);
  assert.deepEqual(s.call('study:notes', { sessionId: session.id }).map(n => n.text), [''], 'a missing file is an empty body, not an error');
  assert.throws(() => s.call('study:sideNote', { sessionId: session.id, text: '   ' }), /Write something/);
  assert.throws(() => s.call('study:sideNote', { sessionId: session.id, text: 'x'.repeat(20001) }), /at most 20000/);
  assert.throws(() => s.call('study:sideNote', { sessionId: session.id, text: 'x', page: 0 }), /whole number/);
});

test('visits are recorded once each (D13) and survive the end of the session', t => {
  const s = setup(t);
  const { session } = s.call('study:start', { subjectId: s.subject.id, topicId: s.topic, kind: 'review' });
  const note = s.call('study:sideNote', { sessionId: session.id, text: 'A note' });
  s.call('study:visit', { sessionId: session.id, materials: [note.id] });
  const again = s.call('study:visit', { sessionId: session.id, materials: [note.id, note.id] });
  assert.deepEqual(again.materials, [note.id]);
  s.call('study:end', { sessionId: session.id });
  assert.deepEqual(s.workspace.learningStore().getSession('u', { sessionId: session.id }).visited.materials, [note.id]);
});

test('another account gets "not found" on every session id, and an expired login rejects every channel', t => {
  const s = setup(t);
  const { session } = s.call('study:start', { subjectId: s.subject.id, kind: 'main' });
  s.as({ id: 'v' });
  for (const [channel, arg] of [['study:touch', {}], ['study:visit', {}], ['study:sideNote', { text: 'hi' }], ['study:notes', {}], ['study:end', {}]]) {
    assert.throws(() => s.call(channel, { sessionId: session.id, ...arg }), /not found/i, channel);
  }
  assert.throws(() => s.call('study:start', { subjectId: s.subject.id, kind: 'main' }), /not found/i, 'a subject of another account');
  assert.equal(s.call('study:active', {}), null, 'v has no open session');
  s.as(null);
  for (const channel of s.handlers.keys()) assert.throws(() => s.call(channel, {}), /session has expired/, channel);
});

test('study:active reports the open session with elapsed time', async t => {
  const s = setup(t);
  assert.equal(s.call('study:active', {}), null);
  const { session } = s.call('study:start', { subjectId: s.subject.id, topicId: s.topic, kind: 'main' });
  await sleep(1100);
  const active = s.call('study:active', {});
  assert.equal(active.session.id, session.id); assert.ok(active.elapsedSeconds >= 1); assert.equal(active.topicTitle, 'Cells');
});

test('stopTimerAt keeps the manual timer behavior: stopTimer still needs one tracked second', t => {
  const s = setup(t);
  s.workspace.startTimer('u', 'Quick');
  assert.throws(() => s.workspace.stopTimer('u'), /at least one second/);
  assert.equal(s.workspace.stopTimerAt('u', { endedAt: new Date().toISOString() }), null, 'with an explicit end time a tiny timer is simply removed');
  assert.equal(s.workspace.activeTimer('u'), null);
});

test('Check my note (D8): the suggestion is its own record linked to the note; the note stays byte for byte; no AI means a clear message', async t => {
  const coach = { checkNote: async (u, { noteText, sections }) => ({ text: `GAPS:\n- Missing something about "${noteText.slice(0, 5)}"`, provenance: { provider: 'ollama-local', model: 'm', agentId: 'a', promptVersion: 'coach-1', generatedAt: '2026-11-24T10:00:00.000Z' } }) };
  const s = setup(t, w => w, { coach, sectionsFor: () => ({ sections: [{ title: 'Cells', description: 'd', keyPoints: ['k'] }] }) });
  const { session } = s.call('study:start', { subjectId: s.subject.id, topicId: s.topic, kind: 'main' });
  const text = 'Mitochondria make ATP.';
  const note = s.call('study:sideNote', { sessionId: session.id, text });
  const noteFile = path.join(s.dir, 'learning-files', 'u', 'side-notes', s.subject.id, note.bodyFile);
  const before = fs.readFileSync(noteFile, 'utf8');
  const help = await s.call('study:checkNote', { materialId: note.id });
  assert.equal(help.kind, 'side_note_ai'); assert.equal(help.parentMaterialId, note.id); assert.equal(help.label, 'AI · suggestion'); assert.equal(help.provenance.model, 'm');
  assert.equal(fs.readFileSync(noteFile, 'utf8'), before, 'the note body is byte-identical after the run');
  const listed = s.call('study:notes', { sessionId: session.id });
  assert.equal(listed.length, 1, 'the suggestion is not listed as a note of its own'); assert.equal(listed[0].aiHelp.length, 1); assert.match(listed[0].aiHelp[0].text, /^GAPS:/);
  await assert.rejects(async () => s.call('study:checkNote', { materialId: help.id }), /Only a side note can be checked/);
  s.as({ id: 'v' });
  await assert.rejects(async () => s.call('study:checkNote', { materialId: note.id }), /not found/i);
  const none = setup(t);
  const sn = none.call('study:start', { subjectId: none.subject.id, kind: 'main' });
  const n2 = none.call('study:sideNote', { sessionId: sn.session.id, text: 'x' });
  await assert.rejects(async () => none.call('study:checkNote', { materialId: n2.id }), /AI is not available/);
});

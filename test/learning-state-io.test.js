/* PF-004 finding: the Learning workflow's state.json writes and reads have no answer to a file that another
   process holds open for a moment (on Windows: a virus scanner or the search indexer). Probed on Windows 11:
   while any other handle is open on the target, fs.renameSync onto it throws EPERM; while an exclusive handle is
   open, fs.readFileSync throws EBUSY.

   These tests reproduced what that did to the workflow (PF-004, then marked `todo`) and now guard the fix in
   src/safe-file.js (PF-007, ADR-003): held files are retried, a read that still fails throws instead of
   returning "empty", and a status that cannot be saved is kept in memory. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../src/workspace');
const { createEcosystem } = require('../src/automation/ecosystem');
const { createLearningWorkflow } = require('../src/learning-workflow');

const USER = 'user-a';
const secrets = { available: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
// No local model: the AI overview is skipped quickly, so only the file analysis matters here.
const adapter = { listModels: async () => [], chat: async () => { throw new Error('no model'); } };
const providers = { adapterFor: () => adapter, contextWindow: async () => ({ tokens: 32768, source: 'test' }), supportsTools: async () => false, testConnection: async () => ({ ok: false, message: 'no model', models: [] }) };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-stateio-'));
  const workspace = createWorkspace(root);
  const ecosystem = createEcosystem({ root, workspace, secrets, providers });
  const flow = createLearningWorkflow({ root, workspace, ecosystem });
  const subject = workspace.createSubject(USER, 'study', { name: 'Biology', type: 'major' });
  t.after(async () => { await flow.close(); workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Same steps as main.js importTopicFile, without waiting for the analysis.
  function add(name, text) {
    const storedName = `${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}.md`;
    fs.mkdirSync(path.join(root, 'learning-files', USER), { recursive: true });
    fs.writeFileSync(path.join(root, 'learning-files', USER, storedName), text);
    return workspace.importTopics(USER, subject.id, { name, storedName, type: 'md', size: text.length, text: '' }, [{ title: name, level: 0 }]).fileId;
  }
  return { root, flow, add };
}
async function idle(flow) { for (let i = 0; i < 400 && !flow.idle(); i++) await new Promise(r => setTimeout(r, 15)); assert.ok(flow.idle(), 'workflow finished'); }
/* Makes `method` throw `code` for state.json while `on()` is true, as a scanner holding the file would. */
function holdStateJson(t, method, code, on, name = 'state.json') {
  const original = fs[method];
  fs[method] = function (...args) {
    if (on() && String(args[method === 'renameSync' ? 1 : 0]).endsWith(name)) throw Object.assign(new Error(`${code}: ${name} is in use`), { code });
    return original.apply(this, args);
  };
  t.after(() => { fs[method] = original; });
}

test('a file whose analysis could not be saved does not stay "Analyzing…" forever', async t => {
  const { flow, add } = setup(t);
  const fileId = add('Week 1 notes.md', '# Functions\nNotes\n## Domain and range\n');
  let held = false;
  holdStateJson(t, 'renameSync', 'EPERM', () => held);
  flow.queueFile(USER, fileId);           // saves "pending" (the file is free), then reads the file in the worker
  held = true;                            // the scanner opens state.json while the analysis runs
  await idle(flow);
  held = false;                           // and lets go
  // Before PF-007: both the "ready" save and the "failed" save threw, so state.json still says pending and the side
  // panel shows "Analyzing this file…" with no further event. Expected: ready (save retried) or failed (shown).
  assert.notEqual(flow.fileAnalysis(USER, fileId).status, 'pending');
});

test('a busy state.json is not read as an empty subject (saved documents are kept)', async t => {
  const { flow, add } = setup(t);
  const first = add('Week 1 notes.md', '# Functions\nNotes\n## Domain and range\n');
  flow.queueFile(USER, first); await idle(flow);
  assert.equal(flow.fileAnalysis(USER, first).status, 'ready');
  let reads = 0;
  holdStateJson(t, 'readFileSync', 'EBUSY', () => reads++ === 0); // the next read of state.json finds it busy, once
  const second = add('Week 2 notes.md', '# Graphs\nNotes\n## Slope\n');
  flow.queueFile(USER, second); await idle(flow);
  // Before PF-007: readJson turns EBUSY into "no state", so the next save writes a state without the first document.
  assert.equal(flow.fileAnalysis(USER, first).status, 'ready', 'the first document survives');
});

test('a busy preferences file is not read as "no preferences" (saving a new one keeps the old ones)', async t => {
  const { root, flow } = setup(t);
  flow.saveLearned(USER, { kind: 'preference', text: 'Use short sentences' });
  const file = path.join(root, 'learning-files', USER, 'intel', 'preferences.json');
  const before = fs.readFileSync(file, 'utf8');
  let held = true;
  holdStateJson(t, 'readFileSync', 'EBUSY', () => held, 'preferences.json');
  // Before PF-007: the busy read gave [], and this save replaced every earlier preference with the new one.
  assert.throws(() => flow.saveLearned(USER, { kind: 'preference', text: 'Give one example' }), /another program is using it/);
  held = false;
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the preferences file was not rewritten');
  assert.deepEqual(flow.preferences(USER).map(p => p.text), ['Use short sentences']);
});

test('a busy agent registry is not read as empty (no duplicate Learning agents, ids kept)', async t => {
  const { root, flow } = setup(t);
  const first = await flow.ensureAgents(USER);
  const file = path.join(root, 'learning-files', USER, 'intel', 'agents.json');
  const before = fs.readFileSync(file, 'utf8');
  let held = true;
  holdStateJson(t, 'readFileSync', 'EBUSY', () => held, 'agents.json');
  // Before PF-007: the busy read gave {}, so new agents were created and the registry was overwritten with their ids.
  await assert.rejects(flow.ensureAgents(USER), /another program is using it/);
  held = false;
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the registry was not rewritten');
  assert.deepEqual(await flow.ensureAgents(USER), first, 'the same agents are used afterwards');
});

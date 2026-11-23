/* PF-004 finding: the Learning workflow's state.json writes and reads have no answer to a file that another
   process holds open for a moment (on Windows: a virus scanner or the search indexer). Probed on Windows 11:
   while any other handle is open on the target, fs.renameSync onto it throws EPERM; while an exclusive handle is
   open, fs.readFileSync throws EBUSY.

   These tests reproduce what that does to the workflow. They are marked `todo` because the fix belongs to PF-007
   (one atomic-write helper, ADR-003), which is not approved yet: a todo test runs and reports, but does not fail
   `npm test`. When PF-007 lands, remove `todo` and they must pass. */
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
  return { flow, add };
}
async function idle(flow) { for (let i = 0; i < 400 && !flow.idle(); i++) await new Promise(r => setTimeout(r, 15)); assert.ok(flow.idle(), 'workflow finished'); }
/* Makes `method` throw `code` for state.json while `on()` is true, as a scanner holding the file would. */
function holdStateJson(t, method, code, on) {
  const original = fs[method];
  fs[method] = function (...args) {
    if (on() && String(args[method === 'renameSync' ? 1 : 0]).endsWith('state.json')) throw Object.assign(new Error(`${code}: state.json is in use`), { code });
    return original.apply(this, args);
  };
  t.after(() => { fs[method] = original; });
}

test('a file whose analysis could not be saved does not stay "Analyzing…" forever', { todo: 'PF-007 / ADR-003' }, async t => {
  const { flow, add } = setup(t);
  const fileId = add('Week 1 notes.md', '# Functions\nNotes\n## Domain and range\n');
  let held = false;
  holdStateJson(t, 'renameSync', 'EPERM', () => held);
  flow.queueFile(USER, fileId);           // saves "pending" (the file is free), then reads the file in the worker
  held = true;                            // the scanner opens state.json while the analysis runs
  await idle(flow);
  held = false;                           // and lets go
  // Today: both the "ready" save and the "failed" save threw, so state.json still says pending and the side
  // panel shows "Analyzing this file…" with no further event. Expected: ready (save retried) or failed (shown).
  assert.notEqual(flow.fileAnalysis(USER, fileId).status, 'pending');
});

test('a busy state.json is not read as an empty subject (saved documents are kept)', { todo: 'PF-007 / ADR-003' }, async t => {
  const { flow, add } = setup(t);
  const first = add('Week 1 notes.md', '# Functions\nNotes\n## Domain and range\n');
  flow.queueFile(USER, first); await idle(flow);
  assert.equal(flow.fileAnalysis(USER, first).status, 'ready');
  let reads = 0;
  holdStateJson(t, 'readFileSync', 'EBUSY', () => reads++ === 0); // the next read of state.json finds it busy, once
  const second = add('Week 2 notes.md', '# Graphs\nNotes\n## Slope\n');
  flow.queueFile(USER, second); await idle(flow);
  // Today: readJson turns EBUSY into "no state", so the next save writes a state without the first document.
  assert.equal(flow.fileAnalysis(USER, first).status, 'ready', 'the first document survives');
});

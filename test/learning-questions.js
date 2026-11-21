'use strict';
/* Learning Ask diagnostic: the questions a basic student types, asked of the real Learning workflow and local
   Ollama model (the model the app picks, or PERFLW_BENCH_MODEL). Each question has the kind of reply it should get;
   the script prints every reply and a pass/fail table, and saves a JSON report under
   test/fixtures/learning-bench/results/. Not part of npm test: it needs Ollama and takes a few minutes.

     node test/learning-questions.js            all questions
     node test/learning-questions.js --only 3,7 some of them (1-based) */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = path.join(__dirname, 'fixtures', 'learning-bench');
const FILES = ['Supply and Demand.md', 'The Industrial Revolution.md', 'Chemical Bonding.md'];
const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(process.argv[i + 1].split(',').map(Number)) : null; })();

/* expect: answer (grounded answer with sources) · chat (casual reply) · learn (offer to save a fact or preference)
           · notfound (the not-in-file warning) · any (anything but an error).
   must: words the reply should contain (any one of each |-group), checked case-insensitively. */
const Q = [
  { q: 'hi', expect: 'chat' },
  { q: 'thank you!', expect: 'chat' },
  { q: 'Summarize this file', expect: 'answer', must: ['demand', 'supply'] },
  { q: 'what is this file about?', expect: 'answer', must: ['demand|supply|market'] },
  { q: 'What are the main topics?', expect: 'answer', must: ['demand', 'supply'] },
  { q: 'What is demand?', expect: 'answer', must: ['willing', 'able|buy'] },
  { q: 'define the law of supply', expect: 'answer', must: ['price', 'quantity supplied|supply'] },
  { q: 'wat is the law of demnd', expect: 'answer', must: ['price', 'fall|falls|decrease|lower'] },
  { q: 'what does section 1.2 talk about?', expect: 'answer', must: ['shift|curve'] },
  { q: 'explain page 1', expect: 'answer', must: ['demand|supply'] },
  { q: 'give me an example', expect: 'answer', followUp: true },
  { q: 'explain that more simply', expect: 'answer', followUp: true },
  { q: 'What is the difference between demand and quantity demanded?', expect: 'answer', must: ['demand'] },
  { q: 'list the things that shift the demand curve', expect: 'answer', must: ['income', 'taste|expectation|related'] },
  { q: 'What causes a surplus?', expect: 'answer', must: ['surplus'] },
  { q: 'When did the Industrial Revolution start?', expect: 'answer', must: ['17|18|britain|century'] },
  { q: 'what is an ionic bond', expect: 'answer', must: ['electron', 'ion'] },
  { q: 'Who is the president of the United States?', expect: 'notfound' },
  { q: 'how do I bake bread?', expect: 'notfound' },
  { q: 'My prof said the quiz on supply is next Friday', expect: 'learn' },
  { q: 'Please keep your answers short', expect: 'learn' },
  { q: 'i dont get it', expect: 'any' },
  { q: 'help', expect: 'any' },
  { q: '?', expect: 'any' },
  { q: 'quiz me on this file', expect: 'answer', must: ['?'] },
  { q: 'give me 3 practice questions about demand', expect: 'answer', must: ['?'] },
  { q: 'explain demand like I am 5', expect: 'answer', must: ['buy|want'] },
  { q: 'ano ang demand?', expect: 'answer', must: ['demand'] },
  { q: 'whats this about?', expect: 'answer', about: { quote: 'For a normal good, higher income increases demand; for an inferior good, higher income decreases it.', page: null }, must: ['income'] },
  { q: 'is this important for the exam?', expect: 'any', about: { quote: 'Substitutes, such as tea and coffee, move together: if coffee becomes more expensive, demand for tea rises.', page: null } }
];

function check(item, r) {
  const status = r.status === 'answered' ? (r.kind === 'chat' ? 'chat' : r.kind === 'learn' ? 'learn' : 'answer') : r.status === 'not-found' ? 'notfound' : r.status;
  const text = String(r.answer || r.warning || r.error || '');
  const problems = [];
  if (item.expect !== 'any' && status !== item.expect) problems.push(`got ${status}, wanted ${item.expect}`);
  if (status === 'error' || status === 'cancelled') problems.push(status);
  if (item.must && status === item.expect) for (const group of item.must) if (!group.split('|').some(w => text.toLowerCase().includes(w.toLowerCase()))) problems.push(`missing "${group}"`);
  if (/\bANSWER:|NOTES:|NOT_IN_FILE/.test(text)) problems.push('format labels shown to the student');
  if (status === 'answer' && !(r.sources || []).length) problems.push('answer without sources');
  return { status, text, problems };
}

(async () => {
  const { createWorkspace } = require('../src/workspace');
  const { createEcosystem } = require('../src/automation/ecosystem');
  const { createLearningWorkflow } = require('../src/learning-workflow');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-questions-'));
  const secrets = { available: () => true, encrypt: t => Buffer.from(t), decrypt: b => b.toString() };
  const workspace = createWorkspace(root);
  const ecosystem = createEcosystem({ root, workspace, secrets });
  const flow = createLearningWorkflow({ root, workspace, ecosystem });
  const user = 'diag'; const subject = workspace.createSubject(user, 'study', { name: 'Economics', type: 'major' });
  const report = { at: new Date().toISOString(), model: null, rows: [] };
  try {
    const ids = await flow.ensureAgents(user);
    if (process.env.PERFLW_BENCH_MODEL) for (const id of [ids.analyzer, ids.assistant]) ecosystem.updateAgentConfig(user, id, { provider: { connectionId: 'ollama-local', model: process.env.PERFLW_BENCH_MODEL } });
    let current = null;
    for (const name of FILES) {
      const bytes = fs.readFileSync(path.join(DIR, name));
      const stored = `${Buffer.from(name).toString('hex').padEnd(32, '0').slice(0, 32)}.md`;
      fs.mkdirSync(path.join(root, 'learning-files', user), { recursive: true });
      fs.writeFileSync(path.join(root, 'learning-files', user, stored), bytes);
      const { fileId } = workspace.importTopics(user, subject.id, { name, storedName: stored, type: 'md', size: bytes.length, text: '' }, [{ title: name, level: 0 }]);
      flow.queueFile(user, fileId);
      if (!current) current = fileId;
    }
    const t0 = Date.now();
    while (!flow.idle()) await new Promise(r => setTimeout(r, 250));
    console.log(`Files analyzed in ${Math.round((Date.now() - t0) / 1000)} s`);
    const history = [];
    for (const [i, item] of Q.entries()) {
      if (only && !only.has(i + 1)) continue;
      const requestId = `q${i + 1}`;
      const started = Date.now();
      let r;
      try { r = await flow.ask(user, { subjectId: subject.id, fileId: current, question: item.q, requestId, history: item.followUp ? history.slice() : history.slice(), about: item.about || null }); }
      catch (error) { r = { status: 'error', error: error.message }; }
      if (r.status === 'answered' && r.kind !== 'chat' && r.kind !== 'learn') history.push(requestId);
      if (r.agent && !report.model) report.model = r.agent.model;
      const seconds = (Date.now() - started) / 1000;
      const c = check(item, r);
      report.rows.push({ n: i + 1, q: item.q, expect: item.expect, ...c, runs: r.runs, mode: r.mode, sources: (r.sources || []).map(s => s.heading), seconds });
      console.log(`\n${String(i + 1).padStart(2)}. ${item.q}${item.about ? '  [marked area]' : ''}\n    → ${c.status} (${seconds.toFixed(1)} s${r.runs === 2 ? ', 2 runs' : ''}${r.mode ? `, ${r.mode}` : ''})${c.problems.length ? `  ✗ ${c.problems.join('; ')}` : '  ✓'}\n    ${c.text.replace(/\s+/g, ' ').slice(0, 260)}`);
    }
  } finally { flow.close(); workspace.close(); fs.rmSync(root, { recursive: true, force: true }); }
  const failed = report.rows.filter(r => r.problems.length);
  console.log(`\nModel: ${report.model || 'none'} · ${report.rows.length - failed.length}/${report.rows.length} as expected · median ${median(report.rows.map(r => r.seconds)).toFixed(1)} s per question`);
  for (const r of failed) console.log(`  ✗ ${r.n}. ${r.q} — ${r.problems.join('; ')}`);
  const out = path.join(DIR, 'results'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `questions-${report.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
  process.exit(0);
})();
function median(list) { const s = list.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }

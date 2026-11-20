'use strict';
/* Learning key point benchmark.

   npm run bench:learning            rule-based key points (no AI): how close the notes panel gets to the reference
   npm run bench:learning -- --ai    also the Learning Document Analyzer's AI overview, with the local Ollama model
                                     (or PERFLW_BENCH_MODEL=<model name>)

   The reference (test/fixtures/learning-bench/reference.json) was written by Claude Opus 5.5 as the target a strong
   model should reach; it is not Claude Sonnet output. Scores:
     must recall   share of the reference's must-know sentences shown (as a section description or key point)
     precision     share of shown sentences that are in the reference (must or ok)
     noise         share of shown sentences that are filler the reference marks as never to choose
     ideas         (AI) share of the document's key ideas the overview and key points cover
     grounded      (AI) share of AI key points whose words come from the file
   Results are printed and saved to test/fixtures/learning-bench/results/. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const intel = require('../src/learning-intel');

const DIR = path.join(__dirname, 'fixtures', 'learning-bench');
const reference = JSON.parse(fs.readFileSync(path.join(DIR, 'reference.json'), 'utf8'));
const norm = text => String(text || '').toLowerCase().replace(/…$/, '').replace(/[^a-z0-9%°+-]+/g, ' ').trim();
const same = (a, b) => { const x = norm(a); const y = norm(b); if (!x || !y) return false; return x === y || (x.length > 50 && y.startsWith(x.slice(0, Math.max(50, x.length - 4)))) || (y.length > 50 && x.startsWith(y.slice(0, Math.max(50, y.length - 4)))); };
const pct = n => `${Math.round(n * 100)}%`;

async function rules() {
  const rows = []; const total = { must: 0, mustHit: 0, shown: 0, good: 0, noise: 0 };
  for (const [name, gold] of Object.entries(reference.files)) {
    const bytes = fs.readFileSync(path.join(DIR, name));
    const a = intel.analyze(await intel.extractBlocks(bytes, 'md'), { fileName: name, fileType: 'md' });
    for (const [number, g] of Object.entries(gold.sections)) {
      const s = a.sections.find(x => x.number === number);
      if (!s) { rows.push({ file: name, number, missing: true }); total.must += g.must.length; continue; }
      const shown = [s.description, ...s.keyPoints].filter(Boolean);
      const mustHit = g.must.filter(m => shown.some(x => same(x, m))).length;
      const good = shown.filter(x => [...g.must, ...g.ok].some(m => same(x, m))).length;
      const noise = shown.filter(x => g.noise.some(m => same(x, m))).length;
      rows.push({ file: name, number, title: s.title, must: g.must.length, mustHit, shown: shown.length, good, noise, missed: g.must.filter(m => !shown.some(x => same(x, m))), noisy: shown.filter(x => g.noise.some(m => same(x, m))) });
      total.must += g.must.length; total.mustHit += mustHit; total.shown += shown.length; total.good += good; total.noise += noise;
    }
  }
  return { rows, recall: total.mustHit / total.must, precision: total.good / Math.max(1, total.shown), noise: total.noise / Math.max(1, total.shown), shown: total.shown };
}

async function ai() {
  const { createWorkspace } = require('../src/workspace');
  const { createEcosystem } = require('../src/automation/ecosystem');
  const { createLearningWorkflow } = require('../src/learning-workflow');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-bench-'));
  const secrets = { available: () => true, encrypt: t => Buffer.from(t), decrypt: b => b.toString() };
  const workspace = createWorkspace(root);
  const ecosystem = createEcosystem({ root, workspace, secrets });
  const flow = createLearningWorkflow({ root, workspace, ecosystem });
  const user = 'bench'; const subject = workspace.createSubject(user, 'study', { name: 'Bench', type: 'major' });
  if (process.env.PERFLW_BENCH_MODEL) { const ids = await flow.ensureAgents(user); ecosystem.updateAgentConfig(user, ids.analyzer, { provider: { connectionId: 'ollama-local', model: process.env.PERFLW_BENCH_MODEL } }); }
  const out = [];
  try {
    for (const [name, gold] of Object.entries(reference.files)) {
      const bytes = fs.readFileSync(path.join(DIR, name));
      const stored = `${Buffer.from(name).toString('hex').padEnd(32, '0').slice(0, 32)}.md`;
      fs.mkdirSync(path.join(root, 'learning-files', user), { recursive: true });
      fs.writeFileSync(path.join(root, 'learning-files', user, stored), bytes);
      const { fileId } = workspace.importTopics(user, subject.id, { name, storedName: stored, type: 'md', size: bytes.length, text: '' }, [{ title: name, level: 0 }]);
      const started = Date.now();
      flow.queueFile(user, fileId);
      while (!flow.idle()) await new Promise(r => setTimeout(r, 250));
      const a = flow.fileAnalysis(user, fileId);
      const e = a.enrichment;
      if (!e) { out.push({ file: name, error: a.enrichError || a.enrichStatus }); continue; }
      const said = `${e.overview}\n${e.keyPoints.join('\n')}`.toLowerCase();
      const covered = gold.ideas.filter(idea => idea.terms.every(term => term.split('|').some(alt => said.includes(alt.toLowerCase()))));
      const source = new Set(intel.terms(bytes.toString('utf8')));
      const grounded = e.keyPoints.filter(p => { const t = intel.terms(p.replace(/\[[^\]]*\]/g, '')); return t.length && t.filter(x => source.has(x)).length / t.length >= 0.7; });
      const numbers = new Set(a.sections.map(s => s.number).filter(Boolean));
      const cites = [...e.keyPoints.join(' ').matchAll(/\[(\d+(?:\.\d+)?)\]/g)].map(m => m[1]);
      out.push({ file: name, model: e.model, seconds: Math.round((Date.now() - started) / 1000), ideas: covered.length / gold.ideas.length, missedIdeas: gold.ideas.filter(i => !covered.includes(i)).map(i => i.idea), grounded: grounded.length / Math.max(1, e.keyPoints.length), points: e.keyPoints.length, formatOk: Boolean(e.overview) && e.keyPoints.length >= 3 && e.keyPoints.length <= 8, citesValid: cites.length ? cites.filter(c => numbers.has(c)).length / cites.length : null, overview: e.overview, keyPoints: e.keyPoints });
    }
  } finally { workspace.close(); fs.rmSync(root, { recursive: true, force: true }); }
  return out;
}

(async () => {
  const r = await rules();
  console.log('Rule-based key points (notes panel, no AI)');
  for (const row of r.rows) {
    if (row.missing) { console.log(`  ${row.file} ${row.number}: section not found`); continue; }
    console.log(`  ${row.file.padEnd(28)} ${row.number.padEnd(4)} must ${row.mustHit}/${row.must}  shown ${row.shown}  good ${row.good}  noise ${row.noise}`);
    for (const m of row.missed) console.log(`      missed: ${m.slice(0, 110)}`);
    for (const n of row.noisy) console.log(`      noise:  ${n.slice(0, 110)}`);
  }
  console.log(`  TOTAL must recall ${pct(r.recall)} · precision ${pct(r.precision)} · noise ${pct(r.noise)} · ${r.shown} shown`);
  const result = { at: new Date().toISOString(), reference: 'Claude Opus 5.5 reference set (not Sonnet output)', rules: { recall: r.recall, precision: r.precision, noise: r.noise, shown: r.shown } };
  if (process.argv.includes('--ai')) {
    const runs = await ai();
    console.log('\nAI overview (Learning Document Analyzer)');
    for (const x of runs) {
      if (x.error) { console.log(`  ${x.file}: ${x.error}`); continue; }
      console.log(`  ${x.file.padEnd(28)} ${x.model} ${x.seconds}s  ideas ${pct(x.ideas)}  grounded ${pct(x.grounded)}  points ${x.points}  format ${x.formatOk ? 'ok' : 'BAD'}  cites ${x.citesValid == null ? '—' : pct(x.citesValid)}`);
      for (const m of x.missedIdeas) console.log(`      missed idea: ${m}`);
    }
    const ok = runs.filter(x => !x.error);
    if (ok.length) console.log(`  MEAN ideas ${pct(ok.reduce((n, x) => n + x.ideas, 0) / ok.length)} · grounded ${pct(ok.reduce((n, x) => n + x.grounded, 0) / ok.length)}`);
    result.ai = runs;
  }
  const dir = path.join(DIR, 'results'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.at.slice(0, 19).replace(/[:T]/g, '-')}${process.argv.includes('--ai') ? '-ai' : ''}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
})().catch(error => { console.error(error); process.exit(1); });

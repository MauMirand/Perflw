'use strict';
/* Question-generator benchmark (owner request 2026-11-27): Perflw's Learning Question Writer (the app's own pipeline and checks,
   on the local Ollama model it picks) against Claude Sonnet doing the same task through the `claude` CLI, scored by a blind judge.

   Usage: node test/qgen-bench.js <outDir> [--model qwen2.5:3b] [--label round1] [--only perflw|sonnet]
   Needs: Ollama on 127.0.0.1:11434 with the model; the `claude` CLI signed in. The sample texts (test/fixtures/qgen-corpus.js) go to
   Anthropic for the Sonnet reference and the judge; nothing else does. Sonnet's questions and every verdict are cached in <outDir>.

   Score per question (0–1): 0 when the judge finds the answer key wrong or the question a duplicate; otherwise the mean of
   grounded, clarity, depth (and distractors for choice), each 1–5, divided by 5. A system's topic score is the sum over the first
   `count` usable questions divided by `count`, so rejected or missing questions count as 0. Overall = mean of topics × 100. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const coach = require('../src/learning-coach');
const { AGENTS, SKILLS } = require('../src/learning-agents');
const corpus = require('./fixtures/qgen-corpus');

const args = process.argv.slice(2);
const out = path.resolve(args[0] || 'qgen-bench-out');
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const MODEL = opt('model', 'qwen2.5:3b'); const CHECK_MODEL = opt('check-model', ''); const LABEL = opt('label', 'run'); const ONLY = opt('only', '');
const COUNT = 5; const TYPES = ['choice', 'truefalse', 'explain']; const DIMS = ['recognition', 'recall', 'understanding'];
fs.mkdirSync(out, { recursive: true });

const writer = AGENTS.writer;
const skillBody = String(SKILLS['learning-question-writing'].file).replace(/^---[\s\S]*?---\s*/, '');
const SYSTEM = `${writer.identity}\n${writer.instructions}\n${skillBody}`;

// ───────── runners
async function ollama(prompt, { temperature = 0.4, system = SYSTEM, json = false, maxTokens, model = MODEL, format, think } = {}) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, ...(format ? { format } : json ? { format: 'json' } : {}), ...(typeof think === 'boolean' ? { think } : {}), options: { temperature, num_ctx: 4096, ...(maxTokens ? { num_predict: maxTokens } : {}) }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }) });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).message.content;
}
function claude(prompt, { system = SYSTEM } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', 'sonnet', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--system-prompt', system], { shell: false, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timed out')); }, 300000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`)); });
    child.stdin.end(prompt);
  });
}
const hash = v => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
const cache = (name, make) => { const f = path.join(out, name); if (fs.existsSync(f)) return Promise.resolve(JSON.parse(fs.readFileSync(f, 'utf8'))); return make().then(v => { fs.writeFileSync(f, JSON.stringify(v, null, 2)); return v; }); };

// ───────── generation
async function generate(system, topic) {
  const excerpts = coach.excerptsOf(topic.sections);
  const ctx = { subjectId: 'bench', topicId: topic.id, provenance: { provider: system, model: system === 'sonnet' ? 'sonnet' : MODEL, agentId: 'bench', promptVersion: coach.PROMPT_VERSION || 'bench', generatedAt: new Date().toISOString() } };
  const run = system === 'sonnet' ? prompt => claude(prompt) : (prompt, o) => ollama(prompt, o);
  const started = Date.now();
  const check = system !== 'sonnet' && CHECK_MODEL ? (prompt, o) => ollama(prompt, { ...o, model: CHECK_MODEL }) : undefined;
  const r = await coach.writeQuestions(run, { topicTitle: topic.title, excerpts, types: TYPES, dimensions: DIMS, count: COUNT, ctx, check });
  return { questions: r.questions, rejected: r.rejected, calls: r.calls, ms: Date.now() - started };
}

// ───────── blind judge (Sonnet). The judge sees the source and the questions only, never which system wrote them.
const JUDGE_SYSTEM = 'You are a strict examiner who reviews study questions against their source text. You reply with JSON only.';
function describe(q, i) {
  const p = q.payload || {};
  let body = '';
  if (q.type === 'choice') body = `Options: ${(p.options || []).map(o => `(${o.id}) ${o.text}`).join(' ')}\nKey: ${(p.correct || []).join(', ')}`;
  else if (q.type === 'truefalse') body = `Statement: ${p.statement}\nKey: ${p.correct ? 'true' : 'false'}`;
  else body = `Rubric: ${(p.rubric || []).map(c => c.criterion).join(' | ')}`;
  return `Q${i + 1} [${q.type}, ${q.dimension}] ${q.prompt}\n${body}\nExplanation: ${q.explanation || '—'}`;
}
function judgePrompt(topic, questions) {
  const src = coach.excerptsOf(topic.sections).map(e => `[${e.ref}] ${e.title}: ${e.text}`).join('\n');
  return `Review these study questions written from the SOURCE below. Judge each on its own merits.

SOURCE
${src}

QUESTIONS
${questions.map(describe).join('\n\n')}

For every question give:
- key_correct: true if the answer key (or for explain, the rubric) is correct and fully supported by the SOURCE; false otherwise
- grounded 1-5: tests something the SOURCE actually states (5) vs. invented or outside it (1)
- clarity 1-5: unambiguous, one defensible answer, well worded
- distractors 1-5 for choice questions only (plausible but clearly wrong options, no giveaways); null for other types
- depth 1-5: tests understanding or application (5) vs. copying a phrase (1)
- duplicate_of: the number of an earlier question it essentially repeats, or null
Reply with ONE JSON object only: {"scores":[{"q":1,"key_correct":true,"grounded":5,"clarity":5,"distractors":null,"depth":3,"duplicate_of":null,"note":"short reason"}]}`;
}
async function judge(topic, questions) {
  if (!questions.length) return [];
  const key = `judge-${topic.id}-${hash(questions.map(q => [q.type, q.prompt, q.payload]))}.json`;
  return cache(key, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const json = coach.extractJson(await claude(judgePrompt(topic, questions), { system: JUDGE_SYSTEM }));
      if (json && Array.isArray(json.scores)) return json.scores;
    }
    throw new Error(`judge gave no JSON for ${topic.id}`);
  });
}
function score(scores, questions) {
  const per = questions.slice(0, COUNT).map((q, i) => {
    const s = scores.find(x => Number(x.q) === i + 1) || {};
    if (!s.key_correct || s.duplicate_of) return { q: i + 1, score: 0, note: s.note || (s.duplicate_of ? 'duplicate' : 'key wrong') };
    const parts = [s.grounded, s.clarity, s.depth, q.type === 'choice' ? s.distractors : null].filter(v => Number.isFinite(Number(v)) && v !== null).map(Number);
    return { q: i + 1, score: parts.reduce((a, b) => a + b, 0) / parts.length / 5, note: s.note || '' };
  });
  return { per, topic: per.reduce((a, x) => a + x.score, 0) / COUNT };
}

(async () => {
  const systems = ONLY ? [ONLY] : ['sonnet', 'perflw'];
  const report = { label: LABEL, model: MODEL, at: new Date().toISOString(), systems: {} };
  for (const system of systems) {
    const topics = [];
    const gens = [];
    for (const topic of corpus) gens.push(system === 'sonnet' ? await cache(`ref-${topic.id}.json`, () => generate('sonnet', topic)) : await generate('perflw', topic)); // the GPU runs one at a time
    const judged = await Promise.all(corpus.map((topic, i) => judge(topic, gens[i].questions.slice(0, COUNT)))); // the judge runs in parallel
    corpus.forEach((topic, i) => {
      const gen = gens[i]; const sc = score(judged[i], gen.questions);
      const types = gen.questions.reduce((m, q) => ({ ...m, [q.type]: (m[q.type] || 0) + 1 }), {});
      topics.push({ topic: topic.id, usable: gen.questions.length, rejected: gen.rejected.length, reasons: gen.rejected.map(r => r.reason).slice(0, 3), types, ms: gen.ms, calls: gen.calls, score: Math.round(sc.topic * 1000) / 10, per: sc.per });
      console.log(`${system.padEnd(7)} ${topic.id.padEnd(15)} usable ${gen.questions.length}/${COUNT} rejected ${gen.rejected.length} score ${(sc.topic * 100).toFixed(1)} (${Math.round(gen.ms / 1000)} s)`);
      if (system === 'perflw') fs.writeFileSync(path.join(out, `${LABEL}-perflw-${topic.id}.json`), JSON.stringify({ gen, scores: sc }, null, 2));
    });
    const overall = topics.reduce((a, t) => a + t.score, 0) / topics.length;
    report.systems[system] = { overall: Math.round(overall * 10) / 10, usableRate: Math.round((topics.reduce((a, t) => a + Math.min(t.usable, COUNT), 0) / (COUNT * topics.length)) * 100), avgSeconds: Math.round(topics.reduce((a, t) => a + t.ms, 0) / topics.length / 1000), topics };
  }
  if (report.systems.sonnet && report.systems.perflw) report.ratio = Math.round((report.systems.perflw.overall / report.systems.sonnet.overall) * 1000) / 10;
  fs.writeFileSync(path.join(out, `${LABEL}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ label: LABEL, sonnet: report.systems.sonnet && report.systems.sonnet.overall, perflw: report.systems.perflw && report.systems.perflw.overall, ratioPercent: report.ratio, usable: report.systems.perflw && report.systems.perflw.usableRate }));
})().catch(error => { console.error(`FAIL: ${error.message}`); process.exit(1); });

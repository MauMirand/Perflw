'use strict';
/* Picture benchmark: how well the Learning Image Reader turns pictures into text and the notes into something a
   student can use. It runs the app's own pipeline (picture loader → OCR model → structure → notes analysis →
   question lookup) on generated infographics with exact answer keys (test/fixtures/picture-bench/scenes.js).

   npm run bench:pictures                        glm-ocr:q8_0 (default)
   npm run bench:pictures -- --model <name>      another local Ollama OCR / vision model
   npm run bench:pictures -- --real              also the private set in test/fixtures/picture-bench/real/
   npm run bench:pictures -- --rescore           score the last run's OCR text again (no model calls): for changes
                                                 to structure, notes or lookup only
                                                 (<name>.png + <name>.json answer keys; ignored by git)

   Scores (0–100%):
     text      lines of the answer key found in the reading (edit distance ≤ 10% of the line)
     numbers   numbers read exactly
     headings  panel headings found as headings (recall); share of headings that are real ones (precision)
     rows      table rows read with every cell in order
     facts     the answer key's key facts present in the notes' descriptions and key points
     slide     the same, for the picture placed on a PowerPoint slide (its facts must reach that slide's key points)
     lookup    questions whose answer words are in the top 3 excerpts the Ask panel would use
   Results are printed and saved to test/fixtures/picture-bench/results/ (ignored by git). */
const fs = require('node:fs');
const path = require('node:path');
const intel = require('../src/learning-intel');
const pictures = require('../src/learning-images');
const { ollamaOcr } = require('../src/learning-workflow');
const { scenes } = require('./fixtures/picture-bench/scenes');

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const MODEL = arg('--model') || 'glm-ocr:q8_0';
const SIDE = Number(arg('--side')) || undefined; // picture size sent to the model (long side, px)
const THREADS = Number(arg('--threads')) || null; // CPU threads Ollama may use for the OCR model
const DIR = path.join(__dirname, 'fixtures', 'picture-bench');
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9%+.]+/g, ' ').replace(/\s+/g, ' ').trim();
const pct = n => (n == null ? '  —' : `${String(Math.round(n * 100)).padStart(3)}%`);

/* Smallest edit distance between `needle` and any part of `hay` (Sellers), as a 0–1 match ratio. */
function matchRatio(needle, hay) {
  const a = norm(needle); const b = norm(hay); const n = a.length; if (!n) return 1;
  let prev = Array.from({ length: n + 1 }, (_, i) => i); let best = n;
  for (let j = 1; j <= b.length; j++) {
    const cur = [0];
    for (let i = 1; i <= n; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (cur[n] < best) best = cur[n];
    prev = cur;
  }
  return 1 - best / n;
}
const found = (needle, hay, bar = 0.9) => matchRatio(needle, hay) >= bar;
const share = (list, test) => (list.length ? list.filter(test).length / list.length : null);

const SAVED = (() => {
  if (!process.argv.includes('--rescore')) return null;
  const dir = path.join(DIR, 'results'); const last = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().pop();
  return new Map(JSON.parse(fs.readFileSync(path.join(dir, last), 'utf8')).results.filter(r => r.raw).map(r => [r.name, r]));
})();
function notesOf(raw) {
  const reading = intel.ocrReading(raw);
  // As an uploaded picture (its headings are the file's sections) and as a picture on a PowerPoint slide titled
  // only "Slide 4" (its headings stay inside that one section, so only the key points can carry its facts).
  const slideBlocks = intel.applyImages([{ kind: 'h', level: 1, text: 'Slide 4', page: 4 }], [{ key: 'p', at: 1, page: 4 }], new Map([['p', reading]]));
  return {
    reading,
    analysis: intel.analyze({ blocks: intel.imageBlocks(reading, { asHeadings: true }), pages: 1 }, { fileName: 'picture.png', fileType: 'png' }),
    slide: intel.analyze({ blocks: slideBlocks, pages: 4 }, { fileName: 'deck.pptx', fileType: 'pptx' })
  };
}
async function readScene(png, model, name) {
  if (SAVED) { const r = SAVED.get(name); if (!r) throw new Error('not in the last run'); return { raw: r.raw, seconds: r.seconds, ...notesOf(r.raw) }; }
  const ocr = ollamaOcr(THREADS ? { threads: THREADS } : {});
  const image = await pictures.loader(png, 'png', SIDE ? { maxSide: SIDE } : {}).load({ bytes: png, mime: 'image/png' });
  const t0 = Date.now();
  const raw = await ocr(model, image);
  const seconds = (Date.now() - t0) / 1000;
  return { raw, seconds, ...notesOf(raw) };
}

/* Machine load while the benchmark runs: CPU (all cores) and GPU use, VRAM and GPU temperature, sampled every 500 ms. */
function monitor() {
  const os = require('node:os'); const { spawn } = require('node:child_process');
  const cpu = []; const gpu = [];
  const times = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
  let last = times();
  const timer = setInterval(() => { const now = times(); const busy = 1 - (now.idle - last.idle) / Math.max(1, now.total - last.total); cpu.push(busy); last = now; }, 500);
  let smi = null;
  try {
    smi = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,temperature.gpu,power.draw', '--format=csv,noheader,nounits', '-lms', '500'], { stdio: ['ignore', 'pipe', 'ignore'] });
    smi.stdout.on('data', d => { for (const line of String(d).trim().split('\n')) { const [u, m, t, p] = line.split(',').map(v => Number(String(v).trim())); if (Number.isFinite(u)) gpu.push({ u, m: Number.isFinite(m) ? m : 0, t: Number.isFinite(t) ? t : 0, p }); } });
    smi.on('error', () => {});
  } catch { smi = null; }
  return () => {
    clearInterval(timer); if (smi) smi.kill();
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return { cpuMean: mean(cpu), cpuPeak: cpu.length ? Math.max(...cpu) : null, gpuMean: mean(gpu.map(x => x.u)) , vramPeak: gpu.length ? Math.max(...gpu.map(x => x.m)) : null, tempPeak: gpu.length ? Math.max(...gpu.map(x => x.t)) : null, powerMean: mean(gpu.map(x => x.p).filter(Number.isFinite)) };
  };
}

function score(truth, { raw, reading, analysis, slide }) {
  const text = [reading.title, reading.text].join('\n');
  const headingsSeen = [...analysis.sections.filter(s => s.number && norm(s.title) !== norm(reading.title)).map(s => s.title),
    ...analysis.sections.flatMap(s => (s.picture || []).filter(l => /^#{2,3} /.test(l)).map(l => l.replace(/^#+ /, '')))];
  const known = [truth.title, ...truth.headings, ...truth.labels];
  const notes = analysis.sections.flatMap(s => [s.description, ...s.keyPoints]).join('\n');
  const doc = { id: 'd', title: analysis.title, sources: ['picture.png'], chunks: analysis.chunks };
  const lookup = q => {
    let hits = intel.search(q.q, [doc], { mode: 'strict' }).hits;
    if (!hits.length) hits = intel.search(q.q, [doc], { mode: 'broad' }).hits;
    const top = hits.slice(0, 3).map(h => `${h.heading} ${h.text}`).join(' ').toLowerCase();
    return q.answer.every(a => top.includes(a.toLowerCase()));
  };
  return {
    text: share(truth.lines, l => found(l, text)),
    numbers: share(truth.numbers, n => new RegExp(`(^|[^0-9.])${n.replace(/[.+%]/g, m => `\\${m}`)}($|[^0-9])`).test(raw)),
    headings: share(truth.headings, h => headingsSeen.some(s => found(h, s, 0.85))),
    precision: headingsSeen.length ? share(headingsSeen, s => known.some(h => found(h, s, 0.85) || found(s, h, 0.85))) : null,
    rows: share(truth.rows, cells => raw.split('\n').some(line => cells.every(c => norm(line).includes(norm(c))) && new RegExp(cells.map(c => norm(c).replace(/[.+%]/g, m => `\\${m}`)).join('.*')).test(norm(line)))),
    facts: share(truth.facts, f => found(f, notes, 0.85)),
    slide: share(truth.facts, f => found(f, slide.sections.flatMap(x => [x.description, ...x.keyPoints]).join(' '), 0.85)),
    lookup: share(truth.questions, lookup)
  };
}

(async () => {
  const set = scenes();
  if (process.argv.includes('--real')) {
    const real = path.join(DIR, 'real');
    if (fs.existsSync(real)) for (const f of fs.readdirSync(real).filter(n => n.endsWith('.json'))) {
      const png = fs.readFileSync(path.join(real, f.replace(/\.json$/, '.png')));
      set.push({ name: `real:${f.replace(/\.json$/, '')}`, png, truth: { headings: [], labels: [], lines: [], numbers: [], rows: [], facts: [], questions: [], ...JSON.parse(fs.readFileSync(path.join(real, f), 'utf8')) } });
    }
  }
  const keys = ['text', 'numbers', 'headings', 'precision', 'rows', 'facts', 'slide', 'lookup'];
  console.log(`Picture benchmark · ${MODEL}${SAVED ? ' · rescored from the last run' : ''}`);
  console.log(`  ${'scene'.padEnd(22)}${keys.map(k => k.padStart(10)).join('')}      time`);
  const results = []; const stop = SAVED ? null : monitor(); const started = Date.now();
  // Read every picture first (load is measured only here), then score.
  const runs = [];
  for (const s of set) { try { runs.push({ s, run: await readScene(s.png, MODEL, s.name) }); } catch (error) { runs.push({ s, error }); } }
  const load = stop ? stop() : null; const wall = (Date.now() - started) / 1000;
  for (const { s, run, error } of runs) {
    if (error) { console.log(`  ${s.name.padEnd(22)} failed: ${error.message}`); results.push({ name: s.name, error: error.message }); continue; }
    const sc = score(s.truth, run);
    results.push({ name: s.name, seconds: run.seconds, ...sc, raw: run.raw, picture: run.analysis.sections.map(x => ({ number: x.number, title: x.title, keyPoints: x.keyPoints, picture: x.picture })) });
    console.log(`  ${s.name.padEnd(22)}${keys.map(k => pct(sc[k]).padStart(10)).join('')}  ${run.seconds.toFixed(1).padStart(6)}s`);
  }
  const ok = results.filter(r => !r.error);
  const mean = k => { const v = ok.map(r => r[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  console.log(`  ${'MEAN'.padEnd(22)}${keys.map(k => pct(mean(k)).padStart(10)).join('')}  ${(ok.reduce((a, r) => a + r.seconds, 0) / Math.max(1, ok.length)).toFixed(1).padStart(6)}s`);
  if (load) console.log(`  load: ${wall.toFixed(0)} s total · CPU ${pct(load.cpuMean)} mean, ${pct(load.cpuPeak)} peak · GPU ${pct(load.gpuMean / 100)} mean · VRAM ${load.vramPeak} MB peak · ${load.tempPeak} °C peak · ${load.powerMean ? load.powerMean.toFixed(1) : '—'} W mean`);
  const out = path.join(DIR, 'results'); fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${MODEL.replace(/[^a-z0-9.]+/gi, '_')}${SAVED ? '-rescore' : ''}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ model: MODEL, side: SIDE || pictures.LIMITS.maxSide, at: new Date().toISOString(), wall, load, mean: Object.fromEntries(keys.map(k => [k, mean(k)])), results }, null, 2)}\n`);
  console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
})().catch(error => { console.error(error); process.exit(1); });

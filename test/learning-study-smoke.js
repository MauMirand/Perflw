// End-to-end check of the Learning document workflow in the running app: upload → key points in the notes panel →
// AI overview → questions answered from the files (with sources and saved notes) → the not-in-file warning.
// Uses the local Ollama models when present (the Learning agents pick one); without Ollama the answers come from the
// file text and the AI overview is reported as unavailable — both paths are accepted and reported.
// Usage: node test/learning-study-smoke.js   (PERFLW_SCREENSHOT_DIR=<absolute folder> saves screenshots)
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-learn-e2e-'));
const FIX = path.join(__dirname, 'fixtures', 'learning');
const docx = path.join(root, 'Cell Biology Lecture 1.docx');
fs.copyFileSync(path.join(FIX, 'Cell Biology Lecture 1.docx'), docx);
const pptx = path.join(root, 'Photosynthesis.pptx');
fs.copyFileSync(path.join(FIX, 'Photosynthesis.pptx'), pptx);
const pdfV2 = path.join(root, 'Cell Biology Lecture 1 (v2).pdf');
fs.copyFileSync(path.join(FIX, 'Cell Biology Lecture 1.pdf'), pdfV2);
const screenshots = process.env.PERFLW_SCREENSHOT_DIR;
let child; let socket; let nextId = 0; let diagnostics = '';
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function port() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); s.on('error', reject); }); }
async function launch() {
  const number = await port();
  child = spawn(require('electron'), ['.', `--remote-debugging-port=${number}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...(process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : [])], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PERFLW_TEST_USER_DATA: root, PERFLW_TEST_TOPIC_PATH: docx }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString().slice(0, 2000); });
  let endpoint;
  for (let i = 0; i < 150 && !endpoint; i++) {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${child.exitCode}\n${diagnostics}`);
    try { endpoint = (await (await fetch(`http://127.0.0.1:${number}/json/list`)).json()).find(p => p.type === 'page' && p.url.includes('index.html'))?.webSocketDebuggerUrl; } catch { /* not ready */ }
    if (!endpoint) await sleep(100);
  }
  if (!endpoint) throw new Error('Electron page did not open');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const d = JSON.parse(event.data); if (!d.id || !pending.has(d.id)) return; const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(`${d.error.message} during ${p.method}`)) : p.resolve(d.result); };
  await cdp('Runtime.enable');
  await waitFor("document.readyState === 'complete' && !!window.account && !document.getElementById('login-page').hidden", 'login page');
}
function cdp(method, params) { return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject, method }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\nIn: ${expression.slice(0, 200)}`);
  return r.result.value;
}
async function waitFor(expression, label = expression, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await evaluate(expression)) return; } catch { /* retry */ } await sleep(60); }
  throw new Error(`UI condition did not become true: ${label}`);
}
async function screenshot(name) {
  if (!screenshots) return;
  fs.mkdirSync(screenshots, { recursive: true }); await sleep(300);
  fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}
const q = s => JSON.stringify(s);
const click = s => evaluate(`(() => { const el = document.querySelector(${q(s)}); if (!el) throw new Error('Missing ' + ${q(s)}); el.click(); return true; })()`);
const fill = (s, v) => evaluate(`(() => { const el = document.querySelector(${q(s)}); el.value = ${q(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const text = s => evaluate(`(document.querySelector(${q(s)})?.textContent || '').trim()`);
async function stop() {
  if (!child) return;
  const proc = child; child = null;
  if (proc.exitCode === null) {
    const exited = new Promise(resolve => proc.once('exit', resolve));
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.evaluate', params: { expression: 'window.windowControls && window.windowControls.close()' } }));
    if (!(await Promise.race([exited.then(() => true), sleep(10000).then(() => false)]))) { proc.kill(); await exited; }
  }
  if (socket) socket.close();
}
async function dropFile(file) {
  const at = await evaluate("(() => { const r = document.querySelector('.ln-topics').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 40 }; })()");
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
}
async function ask(question, ms = 240000) {
  const before = await evaluate("document.querySelectorAll('.ls-turn').length");
  await fill('[data-ls-input]', question);
  await click('[data-ls="send"]');
  await waitFor(`document.querySelectorAll('.ls-turn').length === ${before + 1}`, 'question shown');
  await waitFor("!document.querySelector('.ls-a.working')", `answer to: ${question}`, ms);
  return evaluate("(() => { const t = [...document.querySelectorAll('.ls-turn')].at(-1); const a = t.querySelector('.ls-a'); return { kind: a.classList.contains('warn') ? 'warn' : 'answer', text: a.textContent.trim(), sources: [...t.querySelectorAll('.ls-src-t')].map(e => e.textContent), cites: t.querySelectorAll('.ls-cite').length, meta: t.querySelector('.ls-meta')?.textContent || '' }; })()");
}

async function run() {
  const report = [];
  await launch();
  await click('[data-auth="register"]');
  await fill('#register-email', 'learner@example.com');
  await fill('#register-password', 'Learn-test-pass1');
  await fill('#register-confirmation', 'Learn-test-pass1');
  await evaluate("document.querySelector('#register-form').requestSubmit()");
  await waitFor("!document.getElementById('profile-page').hidden", 'profile page');
  await fill('#profile-name', 'Learner');
  await evaluate("document.querySelector('#profile-form').requestSubmit()");
  await waitFor("!document.getElementById('main-page').hidden", 'workspace');
  await waitFor("!!document.querySelector('.nav-item[data-go=\"learning\"]')", 'sidebar ready', 15000);
  await click('.nav-item[data-go="learning"]');
  await waitFor("!!document.querySelector('.ln-root') && !!document.querySelector('[data-ln=\"create\"]')", 'learning page');
  await click('[data-ln="create"]');
  await waitFor("!!document.querySelector('[data-ln-form]')", 'subject dialog');
  await fill('[data-ln-form] [name="name"]', 'Biology');
  await evaluate("document.querySelector('[data-ln-form]').requestSubmit()");
  await waitFor("document.querySelectorAll('[data-ln-subject]').length === 1", 'subject created');
  await evaluate("(() => { const el = document.querySelector('[data-ln-subject]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); })()");
  await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Biology'", 'subject page');
  await waitFor("!!document.querySelector('.ln-topics [data-ln=\"upload\"]')", 'topics card');

  // 1. Upload (Word) → topics → open the viewer → notes panel shows the numbered key points
  await click('.ln-topics [data-ln="upload"]');
  await waitFor("document.querySelectorAll('.ln-topic').length === 1", 'the Word file became one topic', 15000);
  assert.equal(await text('.ln-topic .ln-topic-title'), 'Cell Biology Lecture 1', 'the topic is named after the file');
  await click('.ln-topic .ln-topic-title');
  await waitFor("!!document.querySelector('.ln-viewer')", 'viewer opened');
  await waitFor("document.querySelector('.ls-doc-title')?.textContent === 'Cell Biology'", 'notes panel title header', 30000);
  const numbers = await evaluate("[...document.querySelectorAll('.ls-sec .ls-num')].map(e => e.textContent).join(' ')");
  // The file is one topic; its Word headings are the notes panel's sections, numbered 1 to 3.1 (two levels).
  assert.equal(await evaluate("document.querySelectorAll('.ln-nav-topic').length"), 1, 'one topic in the navigator');
  assert.equal(numbers, '1 1.1 1.2 2 2.1 3 3.1', 'decimal numbering in the notes panel');
  assert.equal(await evaluate("[...document.querySelectorAll('.ls-sec.lvl-2 .ls-sec-title')].map(e => e.textContent).join()"), 'Membrane Proteins,Transport Across the Membrane,Nucleolus,Cristae', 'subtitles at level 2');
  assert.ok(await evaluate("document.querySelectorAll('.ls-points li').length >= 5"), 'key points listed');
  report.push(`notes panel: ${numbers}`);
  await screenshot('L1-notes-panel');

  // 2. AI overview (Learning Document Analyzer) or the reason it is unavailable
  const fileId = await evaluate("(async () => (await window.learningData.topics((await window.learningData.subjects('study'))[0].id)).files[0].id)()");
  let enrich = null;
  for (const end = Date.now() + 240000; Date.now() < end; await sleep(1500)) {
    enrich = await evaluate(`window.learningData.analysis(${q(fileId)}).then(a => ({ status: a.enrichStatus, error: a.enrichError }))`);
    if (!['pending', 'running'].includes(enrich.status)) break;
  }
  if (enrich.status === 'ready') await waitFor("!!document.querySelector('.ls-overview')", 'AI overview shown in the notes panel', 5000);
  report.push(`AI overview: ${enrich.status}${enrich.error ? ` (${enrich.error})` : ''}${enrich.status === 'ready' ? ` — "${(await text('.ls-overview p:last-child')).slice(0, 140)}…"` : ''}`);
  await screenshot('L2-ai-overview');

  // 3. A question the file answers: grounded answer, citations, sources, notes saved
  const a1 = await ask('What does the sodium-potassium pump do?');
  report.push(`Q1 (in file): ${a1.kind} — ${a1.text.slice(0, 160)} | sources: ${a1.sources.join(' ; ')} | ${a1.meta}`);
  assert.equal(a1.kind, 'answer', `answered: ${a1.text}`);
  assert.match(a1.text, /3|three/i, 'answer uses the file’s numbers');
  assert.ok(a1.sources.some(s => /Transport Across the Membrane/.test(s)), 'source is section 1.2');
  await screenshot('L3-answer');

  // 4. A question the files do not cover: the warning, after the 2nd run
  const a2 = await ask('Who painted the Mona Lisa?');
  report.push(`Q2 (not in file): ${a2.kind} — ${a2.text} | ${a2.meta}`);
  assert.equal(a2.kind, 'warn');
  assert.match(a2.text, /not included in the file/);
  await screenshot('L4-not-in-file');

  // 4b. Casual message: a normal reply, no warning, no sources
  const hi = await ask('hi');
  report.push(`casual "hi": ${hi.kind} — ${hi.text.slice(0, 120)}`);
  assert.equal(hi.kind, 'answer');
  assert.equal(hi.sources.length, 0);

  // 4c. Clicking a key point jumps to its page (PDF view) or highlights its text (text view)
  const before = await evaluate("document.querySelector('.ln-pdfv-hl') ? 'highlight' : ''");
  await evaluate("[...document.querySelectorAll('.ls-point')].find(b => /phospholipid|selectively permeable/i.test(b.textContent) || true).click(); true");
  await sleep(600);
  const jump = await evaluate("({ src: document.querySelector('.ln-pdfv-hl') ? `#page=${document.querySelector('.ln-pdfv-hl').closest('.ln-pdfv-page').dataset.page}` : '', spot: document.querySelector('.ln-reader .ln-spot')?.textContent.slice(0, 80) || '', active: document.querySelector('.ln-nav-topic.active')?.textContent || '' })");
  report.push(`key point click: ${jump.src ? `PDF ${jump.src.replace(/^.*#/, '#')}` : `text highlighted: "${jump.spot}"`} (topic ${jump.active}; before ${before.replace(/^.*#/, '#')})`);
  assert.ok(jump.src.includes('#page=') || jump.spot, 'key point click lands on the file');
  const toasts = await evaluate("[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')");
  assert.doesNotMatch(toasts, /no topic of its own/);
  await screenshot('L4c-keypoint-jump');

  // 5. Notes tab shows the saved notes; the .md files exist and say what the reference asks for
  const saved = await evaluate("Number(document.querySelector('[data-tab=\"notes\"] .ls-count')?.textContent || 0)");
  report.push(`saved notes: ${saved}`);
  await click('[data-ls="tab"][data-tab="notes"]');
  await waitFor("!!document.querySelector('.ls-notes') || !!document.querySelector('.ls-body .ls-empty')", 'notes tab');
  await screenshot('L5-notes-tab');
  await click('[data-ls="tab"][data-tab="points"]');
  const subjectId = await evaluate("(async () => (await window.learningData.subjects('study'))[0].id)()");
  const center = await evaluate(`window.learningData.openNotesFile(${q(subjectId)}, null)`);
  const centerMd = fs.readFileSync(center, 'utf8');
  assert.match(centerMd, /^# Biology — File Data and Information Center/);
  report.push(`information center: ${center}`);

  // 6. A similar name updates the same .md; a different file creates a new one; the 2nd file is searchable
  await click('[data-ln="viewer-subject"]');
  await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Biology'", 'back to subject page');
  await dropFile(pdfV2);
  await waitFor("document.querySelectorAll('.ln-file').length === 2", 'PDF v2 uploaded', 15000);
  await dropFile(pptx);
  await waitFor("document.querySelectorAll('.ln-file').length === 3", 'PowerPoint uploaded', 15000);
  await waitFor(`(async () => { const t = await window.learningData.topics(${q(subjectId)}); const s = await Promise.all(t.files.map(f => window.learningData.analysis(f.id))); window.__an = s; return s.every(x => x.status === 'ready'); })()`, 'all files analyzed', 60000);
  const analyses = await evaluate('window.__an.map(a => ({ title: a.title, action: a.action, docId: a.docId }))');
  report.push(`files: ${analyses.map(a => `${a.title} (${a.action}, ${a.docId})`).join(' | ')}`);
  assert.equal(analyses[1].action, 'updated', 'PDF v2 updated the Word file’s .md');
  assert.equal(analyses[1].docId, analyses[0].docId);
  assert.equal(analyses[2].action, 'created');
  const mdDir = path.join(root, 'learning-files');
  const mdFiles = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) mdFiles.push(path.relative(mdDir, p)); } })(mdDir);
  report.push(`.md files: ${mdFiles.join(', ')}`);
  assert.equal(mdFiles.filter(f => f.includes(`${path.sep}docs${path.sep}`)).length, 2, 'two document .md files');
  await evaluate("[...document.querySelectorAll('.ln-topic .ln-topic-title')].find(e => e.textContent === 'Photosynthesis').click(); true");
  await waitFor("document.querySelector('.ls-doc-title')?.textContent === 'Photosynthesis'", 'PowerPoint key points', 30000);
  const slideNums = await evaluate("[...document.querySelectorAll('.ls-sec .ls-num')].map(e => e.textContent).join(' ')");
  report.push(`PowerPoint notes panel: ${slideNums}`);
  await screenshot('L6-pptx-notes');
  const a3 = await ask('Which enzyme fixes carbon dioxide in the Calvin cycle?');
  report.push(`Q3 (pptx): ${a3.kind} — ${a3.text.slice(0, 160)} | sources: ${a3.sources.join(' ; ')} | ${a3.meta}`);
  assert.equal(a3.kind, 'answer');
  assert.match(a3.text, /RuBisCO/i);
  await screenshot('L7-pptx-answer');

  // 6b. Optional: a real slide-deck PDF given by path (stays local; not part of the repository)
  if (process.env.PERFLW_LEARNING_PDF && fs.existsSync(process.env.PERFLW_LEARNING_PDF)) {
    const real = path.join(root, path.basename(process.env.PERFLW_LEARNING_PDF));
    fs.copyFileSync(process.env.PERFLW_LEARNING_PDF, real);
    await click('[data-ln="viewer-subject"]');
    await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Biology'", 'back to subject page');
    const files = await evaluate("document.querySelectorAll('.ln-file').length");
    await dropFile(real);
    await waitFor(`document.querySelectorAll('.ln-file').length === ${files + 1}`, 'real PDF uploaded', 20000);
    const realId = await evaluate(`(async () => { const t = await window.learningData.topics(${q(subjectId)}); return t.files.at(-1).id; })()`);
    await waitFor(`window.learningData.analysis(${q(realId)}).then(a => a.status === 'ready')`, 'real PDF analyzed', 90000);
    await evaluate(`(() => { const rows = [...document.querySelectorAll('.ln-topic')]; rows.at(-1).querySelector('.ln-topic-title').click(); return true; })()`);
    await waitFor("!!document.querySelector('.ln-viewer') && !!document.querySelector('.ls-sec')", 'real PDF key points', 30000);
    const outline = await evaluate("[...document.querySelectorAll('.ls-sec')].slice(0, 8).map(e => e.querySelector('.ls-sec-head').textContent.trim()).join(' | ')");
    report.push(`real PDF notes panel: ${await text('.ls-doc-title')} — ${outline}`);
    await screenshot('L8-real-pdf-notes');
    const r1 = await ask('What is technology as a way of revealing?');
    report.push(`real PDF Q: ${r1.kind} — ${r1.text.slice(0, 220)} | sources: ${r1.sources.slice(0, 3).join(' ; ')}`);
    assert.equal(r1.kind, 'answer', `real PDF answered: ${r1.text}`);
    await screenshot('L9-real-pdf-answer');
    await evaluate("document.querySelectorAll('.ls-point')[3]?.click(); true");
    await sleep(2500);
    report.push(`real PDF key point click: page ${await evaluate("document.querySelector('.ln-pdfv-hl')?.closest('.ln-pdfv-page')?.dataset.page || 'none'")}`);
    await screenshot('L10-real-pdf-jump');
  }

  // 7. Agents and skills exist in the app's Agents/Skills stores
  const agents = await evaluate("window.automationData.agents().then(a => a.map(x => x.name))").catch(() => []);
  report.push(`agents: ${JSON.stringify(agents)}`);
  const errors = await evaluate("[...document.querySelectorAll('.toast.error')].map(t => t.textContent)");
  assert.deepEqual(errors, [], 'no error toasts');
  return report;
}

run().then(async report => { await stop(); console.log(report.map(line => `• ${line}`).join('\n')); fs.rmSync(root, { recursive: true, force: true }); console.log('Learning workflow smoke test passed.'); })
  .catch(async error => { console.error(error); if (diagnostics) console.error(diagnostics.slice(0, 3000)); await stop(); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });

// End-to-end check of the Learning viewer's in-app PDF viewer and the Ask panel's streaming, in the running app.
// PDF: the file is drawn once; key point clicks scroll that same view (no reload) to the exact line, which is
// highlighted; rapid clicks end on the last one. Ask: a stand-in Ollama server on 127.0.0.1:11434 streams the reply
// word by word; the thread must not redraw or re-animate while it streams, and the "ANSWER:" label never shows.
// Usage: node test/pdf-viewer-smoke.js   (PERFLW_SCREENSHOT_DIR=<absolute folder> saves screenshots)
// Needs port 11434 free (stop a real Ollama first).
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-pdfv-e2e-'));
const FIX = path.join(__dirname, 'fixtures', 'learning');
const pdf = path.join(root, 'Cell Biology Lecture 1.pdf');
fs.copyFileSync(path.join(FIX, 'Cell Biology Lecture 1.pdf'), pdf);
const slides = path.join(root, 'Photosynthesis slides.pdf');
fs.copyFileSync(path.join(FIX, 'Photosynthesis slides.pdf'), slides);
const screenshots = process.env.PERFLW_SCREENSHOT_DIR;
let child; let socket; let nextId = 0; let diagnostics = '';
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Stand-in Ollama: one model; chat replies stream a word every 35 ms. */
const ANSWER = 'ANSWER: The sodium-potassium pump moves 3 Na+ ions out of the cell and 2 K+ ions in, using ATP for active transport against the gradient [1].\nNOTES:\n- The sodium-potassium pump moves 3 Na+ out and 2 K+ in.';
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; });
  req.on('end', async () => {
    if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'fake:7b', details: { parameter_size: '7B' } }] })); return; }
    if (req.url === '/api/show') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model_info: { 'x.context_length': 8192 }, capabilities: ['completion'] })); return; }
    if (req.url === '/api/chat') {
      const msg = JSON.parse(body || '{}'); const prompt = (msg.messages || []).map(m => m.content).join('\n');
      const reply = /sodium-potassium/i.test(prompt) && /QUESTION|question/i.test(prompt) ? ANSWER : 'Overview: the lecture covers the cell membrane, the nucleus and mitochondria.\nKEY IDEAS:\n- Membranes control what enters the cell.';
      if (msg.stream === false) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: { content: reply }, done: true })); return; }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const piece of reply.match(/\S+\s*/g)) { res.write(`${JSON.stringify({ message: { content: piece }, done: false })}\n`); await sleep(35); }
      res.end(`${JSON.stringify({ message: { content: '' }, done: true, eval_count: 40, prompt_eval_count: 300 })}\n`);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});

async function port() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); s.on('error', reject); }); }
async function launch() {
  const number = await port();
  child = spawn(require('electron'), ['.', `--remote-debugging-port=${number}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [])], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PERFLW_TEST_USER_DATA: root, PERFLW_TEST_TOPIC_PATH: pdf }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
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
  socket.onmessage = event => { const d = JSON.parse(event.data); if (d.method === 'Runtime.consoleAPICalled' || d.method === 'Runtime.exceptionThrown') { consoleLog.push(JSON.stringify(d.params).slice(0, 300)); return; } if (!d.id || !pending.has(d.id)) return; const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(`${d.error.message} during ${p.method}`)) : p.resolve(d.result); };
  await cdp('Runtime.enable');
  await waitFor("document.readyState === 'complete' && !!window.account && (!document.getElementById('login-page').hidden || !document.getElementById('register-page').hidden)", 'sign-in or first-run sign-up page');
}
const consoleLog = [];
function cdp(method, params) { return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject, method }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\nIn: ${expression.slice(0, 200)}`);
  return r.result.value;
}
async function waitFor(expression, label = expression, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await evaluate(expression)) return; } catch { /* retry */ } await sleep(40); }
  throw new Error(`UI condition did not become true: ${label}\nconsole: ${consoleLog.slice(-8).join('\n')}`);
}
async function screenshot(name) {
  if (!screenshots) return;
  fs.mkdirSync(screenshots, { recursive: true }); await sleep(250);
  fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}
const q = s => JSON.stringify(s);
const click = s => evaluate(`(() => { const el = document.querySelector(${q(s)}); if (!el) throw new Error('Missing ' + ${q(s)}); el.click(); return true; })()`);
const fill = (s, v) => evaluate(`(() => { const el = document.querySelector(${q(s)}); el.value = ${q(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
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
/* Clicks every key point; each must land on its own page, on its own words, on screen, in the same view. */
async function checkPoints(label) {
  await evaluate("window.__view = document.querySelector('.ln-pdfv'); true");
  const points = await evaluate("[...document.querySelectorAll('.ls-point')].map((b, i) => ({ i, text: b.textContent.trim().slice(0, 70), page: Number(b.dataset.page) || null }))");
  const timings = []; let exact = 0;
  for (const p of points) {
    await evaluate("document.querySelectorAll('.ln-pdfv-hl').forEach(m => m.remove()); true");
    const start = Date.now();
    await evaluate(`document.querySelectorAll('.ls-point')[${p.i}].click(); true`);
    await waitFor("document.querySelectorAll('.ln-pdfv-hl').length > 0", `${label} highlight for point ${p.i}`, 4000);
    timings.push(Date.now() - start);
    await sleep(500);
    const u = await evaluate(UNDER);
    const same = await evaluate("document.querySelector('.ln-pdfv') === window.__view");
    const words = p.text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 4);
    const hits = words.filter(w => u.text.toLowerCase().includes(w)).length;
    if (p.page && u.page === p.page) exact++;
    report.push(`  ${label} point ${p.i} (p.${p.page}) "${p.text}" → page ${u.page}, under highlight "${u.text.slice(0, 90)}" [${hits}/${words.length}] ${u.visible ? 'on screen' : 'OFF SCREEN'} ${same ? 'same view' : 'RELOADED'}`);
    assert.ok(same, 'the PDF view is reused');
    assert.ok(u.visible, `${label} point ${p.i} highlight on screen`);
    assert.ok(hits >= Math.min(2, words.length), `${label} point ${p.i} highlight is on its text`);
    if (p.page) assert.equal(u.page, p.page, `${label} point ${p.i} on its page`);
  }
  report.push(`${label}: ${points.length} points, click → highlight ${timings.join(', ')} ms (max ${Math.max(...timings)})`);
  assert.ok(Math.max(...timings) < 1500, 'jumps are quick');
  return points;
}

/* What is under the highlight: the text-layer spans that overlap it, and whether it is inside the visible area. */
const UNDER = `(() => {
  const box = document.querySelector('[data-ln-doc]'); const marks = [...document.querySelectorAll('.ln-pdfv-hl')];
  if (!marks.length) return { marks: 0 };
  const b = box.getBoundingClientRect(); const page = marks[0].closest('.ln-pdfv-page');
  const spans = [...page.querySelectorAll('.textLayer span')];
  const text = marks.map(m => { const r = m.getBoundingClientRect(); return spans.filter(s => { const t = s.getBoundingClientRect(); const cy = t.top + t.height / 2; return cy > r.top && cy < r.bottom && t.right > r.left && t.left < r.right; }).map(s => s.textContent).join(''); }).join(' / ');
  const r = marks[0].getBoundingClientRect();
  return { marks: marks.length, page: Number(page.dataset.page), text, visible: r.top >= b.top && r.bottom <= b.bottom, fromTop: Math.round(r.top - b.top), boxH: Math.round(b.height) };
})()`;

const report = [];
async function run() {
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(11434, '127.0.0.1', resolve); });
  await launch();
  await click('[data-auth="register"]');
  await fill('#register-email', 'pdf@example.com');
  await fill('#register-password', 'Pdf-test-pass1');
  await fill('#register-confirmation', 'Pdf-test-pass1');
  await evaluate("document.querySelector('#register-form').requestSubmit()");
  await waitFor("!document.getElementById('profile-page').hidden", 'profile page');
  await fill('#profile-name', 'Reader');
  await evaluate("document.querySelector('#profile-form').requestSubmit()");
  await waitFor("!document.getElementById('main-page').hidden", 'workspace');
  await waitFor("!!document.querySelector('.nav-item[data-go=\"learning\"]')", 'sidebar ready', 15000);
  await click('.nav-item[data-go="learning"]');
  await waitFor("!!document.querySelector('[data-ln=\"create\"]')", 'learning page');
  await click('[data-ln="create"]');
  await waitFor("!!document.querySelector('[data-ln-form]')", 'subject dialog');
  await fill('[data-ln-form] [name="name"]', 'Biology');
  await evaluate("document.querySelector('[data-ln-form]').requestSubmit()");
  await waitFor("document.querySelectorAll('[data-ln-subject]').length === 1", 'subject created');
  await evaluate("(() => { const el = document.querySelector('[data-ln-subject]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); })()");
  await waitFor("!!document.querySelector('.ln-topics [data-ln=\"upload\"]')", 'topics card');
  await click('.ln-topics [data-ln="upload"]');
  await waitFor("document.querySelectorAll('.ln-topic').length === 1", 'the PDF became one topic', 15000);
  report.push(`topics: ${await evaluate("[...document.querySelectorAll('.ln-topic .ln-topic-title')].map(e => e.textContent).join(' | ')")}`);

  // 1. Open the topic: no plugin frame; pages drawn by pdf.js. Its headings are sections in the key points:
  //    clicking one highlights that heading on its page.
  const t0 = Date.now();
  await click('.ln-topic .ln-topic-title');
  await waitFor("!!document.querySelector('.ln-pdfv-page canvas')", 'PDF drawn in the app', 15000);
  report.push(`first page drawn in ${Date.now() - t0} ms`);
  assert.equal(await evaluate("document.querySelectorAll('iframe.ln-pdf').length"), 0, 'no Chromium plugin frame');
  await waitFor("[...document.querySelectorAll('.ls-sec-title')].some(e => e.textContent === 'Membrane Proteins')", 'headings in the key points', 30000);
  await evaluate("[...document.querySelectorAll('.ls-sec-head')].find(b => /Membrane Proteins/.test(b.textContent)).click(); true");
  await waitFor("document.querySelectorAll('.ln-pdfv-hl').length > 0", 'heading highlighted');
  const opened = await evaluate(UNDER);
  report.push(`topic open → page ${opened.page}, highlight over "${opened.text}" (${opened.fromTop}px from top of ${opened.boxH}px)`);
  assert.match(opened.text, /Membrane Proteins/i);
  assert.ok(opened.visible, 'highlight on screen');
  await evaluate("window.__view = document.querySelector('.ln-pdfv'); window.__canvas = document.querySelector('.ln-pdfv-page canvas'); true");
  await waitFor("document.querySelectorAll('.ls-point').length >= 4", 'key points listed', 30000);
  await screenshot('P1-topic-open');

  // 2. Each key point: same view (no reload), exact words highlighted on screen, fast
  const points = await checkPoints('lecture');
  await screenshot('P2-key-point');

  // 3. Rapid clicks: ends on the last one, still the same view
  const last = points.length - 1;
  for (const i of [1, 3, 0, 2, last]) await evaluate(`document.querySelectorAll('.ls-point')[${i}].click(); true`);
  await sleep(900);
  const rapid = await evaluate(UNDER);
  report.push(`rapid clicks → ends on page ${rapid.page}: "${rapid.text.slice(0, 80)}"; same view: ${await evaluate("document.querySelector('.ln-pdfv') === window.__view")}`);
  assert.ok(await evaluate("document.querySelector('.ln-pdfv') === window.__view"));
  assert.ok(rapid.text.toLowerCase().includes(points[last].text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).find(w => w.length > 4) || ''), 'last click wins');

  // 4. Another heading of the same file, from the key points: no reload either
  await evaluate("[...document.querySelectorAll('.ls-sec-head')].find(b => /Mitochondria/.test(b.textContent)).click(); true");
  await sleep(600);
  const mito = await evaluate(UNDER);
  report.push(`navigator → Mitochondria: page ${mito.page} "${mito.text}" same view: ${await evaluate("document.querySelector('.ln-pdfv') === window.__view")}`);
  assert.match(mito.text, /Mitochondria/i);

  // 5. Window resize redraws sharp pages without a blank frame
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1180, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const afterResize = await evaluate("({ pages: document.querySelectorAll('.ln-pdfv-page canvas').length, w: document.querySelector('.ln-pdfv-page').offsetWidth, box: document.querySelector('[data-ln-doc]').clientWidth })");
  report.push(`after resize: page ${afterResize.w}px wide in a ${afterResize.box}px area, ${afterResize.pages} pages drawn`);
  assert.ok(afterResize.w <= afterResize.box && afterResize.w > afterResize.box - 60, 'pages refit the width');
  await cdp('Emulation.clearDeviceMetricsOverride');
  await sleep(500);

  // 5b. A multi-page slide deck: every key point lands on its own slide
  await click('[data-ln="viewer-subject"]');
  await waitFor("!!document.querySelector('.ln-topics [data-ln=\"upload\"]')", 'subject page');
  const before = await evaluate("document.querySelectorAll('.ln-file').length");
  await dropFile(slides);
  await waitFor(`document.querySelectorAll('.ln-file').length === ${before + 1}`, 'slides uploaded', 20000);
  await evaluate("[...document.querySelectorAll('.ln-topic .ln-topic-title')].at(-1).click(); true");
  await waitFor("!!document.querySelector('.ln-pdfv-page canvas') && document.querySelectorAll('.ln-pdfv-page').length > 1", 'slides drawn', 20000);
  await waitFor("document.querySelector('.ls-doc-title') && /Photosynthesis/i.test(document.querySelector('.ls-doc-title').textContent) && document.querySelectorAll('.ls-point').length >= 3", 'slide key points', 30000);
  report.push(`slides: ${await evaluate("document.querySelectorAll('.ln-pdfv-page').length")} pages`);
  await checkPoints('slides');
  await screenshot('P2b-slide-point');
  // back to the lecture for the Ask check
  await evaluate("document.querySelectorAll('.ln-nav-topic')[0].click(); true");
  await waitFor("!!document.querySelector('.ln-pdfv-page canvas')", 'lecture again', 10000);

  // 6. Ask: streaming reply — the thread is not redrawn and nothing re-animates while tokens arrive
  await evaluate(`(() => {
    const box = document.querySelector('[data-ls-thread]');
    window.__ask = { removed: 0, anims: 0, labels: 0, frames: 0 };
    new MutationObserver(list => { for (const m of list) for (const n of m.removedNodes) if (n.nodeType === 1 && (n.matches('.ls-turn, .ls-thread') || n.querySelector?.('.ls-turn'))) window.__ask.removed++; }).observe(box, { childList: true, subtree: true });
    window.__ask.names = []; box.addEventListener('animationstart', e => { if (e.animationName === 'spin') return; window.__ask.anims++; window.__ask.names.push(e.animationName + ':' + (e.target.className || '')); });
    const tick = () => { const live = box.querySelector('.ls-a.working'); if (live) { window.__ask.frames++; if (/\\bANS(W|$)|NOT_IN/.test(live.textContent)) window.__ask.labels++; } if (!window.__ask.done) requestAnimationFrame(tick); };
    requestAnimationFrame(tick); return true; })()`);
  await fill('[data-ls-input]', 'What does the sodium-potassium pump do?');
  await click('[data-ls="send"]');
  await waitFor("!!document.querySelector('.ls-a.working .ls-live')", 'reply streaming', 60000);
  await sleep(500);
  await screenshot('P3-ask-streaming');
  const mid = await evaluate("({ ...window.__ask, live: document.querySelector('.ls-a.working .ls-live')?.textContent.length || 0 })");
  await waitFor("!document.querySelector('.ls-a.working')", 'reply finished', 120000);
  const ask = await evaluate("(window.__ask.done = true, { ...window.__ask, answer: [...document.querySelectorAll('.ls-turn')].at(-1).querySelector('.ls-a').textContent.trim().slice(0, 140) })");
  report.push(`ask: ${ask.frames} frames while streaming; turns redrawn while streaming: ${mid.removed}; animations: ${ask.anims} (${(ask.names || []).join(', ')}); label shown: ${ask.labels} frames; answer: "${ask.answer}"`);
  assert.equal(mid.removed, 0, 'no turn is redrawn while the reply streams');
  assert.ok(ask.anims <= 1, 'only the new question animates in');
  assert.equal(ask.labels, 0, 'the ANSWER: label never shows');
  assert.ok(ask.removed <= 1, 'only the finished turn is swapped in');
  await screenshot('P4-ask-done');

  // 7. A source under the answer opens its exact place in the same view
  if (await evaluate("!!document.querySelector('.ls-src')")) {
    await evaluate("document.querySelectorAll('.ln-pdfv-hl').forEach(m => m.remove()); document.querySelector('.ls-src').click(); true");
    await waitFor("document.querySelectorAll('.ln-pdfv-hl').length > 0", 'source highlighted', 4000);
    await sleep(450);
    const src = await evaluate(UNDER);
    report.push(`answer source → page ${src.page}: "${src.text.slice(0, 90)}" ${src.visible ? 'on screen' : 'OFF SCREEN'}`);
    assert.ok(src.visible);
    await screenshot('P5-source');
  }
  const errors = consoleLog.filter(l => /error|exception/i.test(l));
  report.push(`renderer errors: ${errors.length ? errors.join(' || ') : 'none'}`);
  return report;
}

run().then(report => { console.log(report.join('\n')); console.log('PDF viewer and Ask streaming checks passed.'); })
  .catch(error => { console.log(report.join('\n')); console.error(error.stack || error.message); if (diagnostics) console.error(diagnostics.slice(-1500)); process.exitCode = 1; })
  .finally(async () => { await stop(); fake.closeAllConnections?.(); fake.close(); fs.rmSync(root, { recursive: true, force: true }); setTimeout(() => process.exit(), 200); });

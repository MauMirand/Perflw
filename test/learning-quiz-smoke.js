'use strict';
/* Electron check for the practice quiz slice: write three questions in the UI, take the pre-test, self-grade, see results.
   Throwaway data folder (PERFLW_TEST_USER_DATA), never the real one. Usage: node test/learning-quiz-smoke.js [screenshotDir]
   Same CDP approach as test/electron-smoke.js. Do not run it beside another Electron smoke run (load makes both flaky). */
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const appDir = path.resolve(process.env.PERFLW_ELECTRON_APP_DIR || path.join(__dirname, '..'));
const out = process.argv[2] ? path.resolve(process.argv[2]) : null;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-quiz-'));
const exe = require(path.join(appDir, 'node_modules', 'electron'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket, nextId = 0; const pending = new Map(); let stderr = '';
const cdp = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\nIn: ${expression.slice(0, 160)}`);
  return r.result.value;
}
async function waitFor(expression, label, timeout = 20000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { last = await evaluate(expression); if (last) return last; } catch (error) { last = error.message; } await sleep(80); }
  throw new Error(`Timed out: ${label} (last: ${String(last).slice(0, 200)})`);
}
const q = s => JSON.stringify(s);
const click = s => evaluate(`(() => { const el = document.querySelector(${q(s)}); if (!el) throw new Error('Missing ' + ${q(s)}); el.click(); return true; })()`);
const fill = (s, v) => evaluate(`(() => { const el = document.querySelector(${q(s)}); if (!el) throw new Error('Missing ' + ${q(s)}); el.value = ${q(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const check = s => evaluate(`(() => { const el = document.querySelector(${q(s)}); if (!el) throw new Error('Missing ' + ${q(s)}); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const submit = s => evaluate(`document.querySelector(${q(s)}).requestSubmit()`);
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function shoot(name) {
  if (!out) return;
  fs.mkdirSync(out, { recursive: true });
  for (const [width, height] of [[1280, 900], [400, 900]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(400);
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, `${name}-${width}.png`), Buffer.from(data, 'base64'));
  }
  await cdp('Emulation.clearDeviceMetricsOverride', {}); await sleep(200);
}
const step = label => console.log(`PASS ${label}`);

async function addQuestion(fields) {
  await click('[data-qz="add"], [data-qz-form="add"] ~ * [data-qz="add"]').catch(() => {});
  await waitFor("!!document.querySelector('[data-qz-form=\"add\"]')", 'question form');
  await fill('[data-qz-form="add"] [name="type"]', fields.type);
  await waitFor(`document.querySelector('[data-qz-form="add"] [name="type"]').value === ${q(fields.type)}`, 'type switched');
  await fill('[data-qz-form="add"] [name="prompt"]', fields.prompt);
  for (const [name, value] of Object.entries(fields.values || {})) await fill(`[data-qz-form="add"] [name="${name}"]`, value);
  if (fields.correct != null) await check(`[data-qz-form="add"] input[name="correct"][value="${fields.correct}"]`);
  if (fields.tf != null) await check(`[data-qz-form="add"] input[name="tf"][value="${fields.tf}"]`);
  await submit('[data-qz-form="add"]');
  await waitFor(`document.querySelector('.qz-error') == null && (window.__qzCount = (document.querySelector('.qz') || {}).textContent) && /question saved|in your bank/i.test(document.body.textContent)`, 'saved');
}

async function main() {
  const port = await freePort();
  child = spawn(exe, ['.', `--remote-debugging-port=${port}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
    cwd: appDir, env: { ...process.env, PERFLW_TEST_USER_DATA: root }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.stderr.on('data', c => { stderr += c.toString(); });
  let endpoint;
  for (let i = 0; i < 150 && !endpoint; i++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page' && p.url.includes('index.html'))?.webSocketDebuggerUrl; } catch { /* not ready */ }
    if (!endpoint) await sleep(100);
  }
  assert.ok(endpoint, 'Electron page did not open');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = e => { const d = JSON.parse(e.data); const p = d.id && pending.get(d.id); if (!p) return; pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); };
  await cdp('Runtime.enable');
  await waitFor("document.readyState === 'complete' && !document.getElementById('login-page').hidden", 'login page');
  await click('[data-auth="register"]');
  await fill('#register-email', 'quiz@example.com'); await fill('#register-password', 'Quiz-pass-123'); await fill('#register-confirmation', 'Quiz-pass-123');
  await submit('#register-form');
  await waitFor("!document.getElementById('profile-page').hidden", 'profile page');
  await fill('#profile-name', 'Quiz Student'); await submit('#profile-form');
  await waitFor("!document.getElementById('main-page').hidden", 'main page');
  step('account created');

  await waitFor("!!document.querySelector('.nav-item[data-go=\"learning\"]')", 'learning nav');
  await click('.nav-item[data-go="learning"]');
  await waitFor("document.querySelector('.ln-head h1')?.textContent === 'Learning'", 'learning page');
  await click('[data-ln="create"]');
  await waitFor("!!document.querySelector('[data-ln-form]')", 'subject dialog');
  await fill('[data-ln-form] [name="name"]', 'Chemistry');
  await submit('[data-ln-form]');
  await waitFor("document.querySelectorAll('[data-ln-subject]').length === 1", 'subject created');
  const subjectId = await evaluate("document.querySelector('[data-ln-subject]').dataset.lnSubject");
  await evaluate(`window.learningData.addTopic(${q(subjectId)}, { title: 'Ionic bonds' })`);
  await evaluate("(() => { const el = document.querySelector('[data-ln-subject]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); return true; })()");
  await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Chemistry' && !!document.querySelector('.qz')", 'subject page with the quiz block');
  await waitFor("/0 questions in your bank/.test(document.querySelector('.qz').textContent)", 'empty bank message');
  assert.ok(await evaluate("document.querySelector('[data-qz=\"start\"]').disabled"), 'Start is disabled with no questions');
  step('quiz block on the subject page, empty bank');
  await shoot('quiz-1-home');

  // An invalid question shows the validator's text and keeps what was typed.
  await click('[data-qz="add"]'); await waitFor("!!document.querySelector('[data-qz-form=\"add\"]')", 'form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'Which bond is ionic?');
  await submit('[data-qz-form="add"]');
  await waitFor("!!document.querySelector('.qz-error') && /options|correct/i.test(document.querySelector('.qz-error').textContent)", 'validation error');
  assert.equal(await evaluate("document.querySelector('[data-qz-form=\"add\"] [name=\"prompt\"]').value"), 'Which bond is ionic?', 'typed text kept');
  step('invalid question rejected with a plain message, input kept');

  await fill('[data-qz-form="add"] [name="opt0"]', 'Covalent'); await fill('[data-qz-form="add"] [name="opt1"]', 'NaCl');
  await check('[data-qz-form="add"] input[name="correct"][value="1"]');
  await submit('[data-qz-form="add"]');
  await waitFor("document.querySelector('.qz-error') == null && /1 question in your bank/.test(document.querySelector('.qz').textContent) || (document.querySelector('.qz-form') && /1 question/.test(document.querySelector('.qz').textContent))", 'first question saved');
  await fill('[data-qz-form="add"] [name="type"]', 'truefalse');
  await waitFor("!!document.querySelector('[data-qz-form=\"add\"] [name=\"statement\"]')", 'true/false form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'True or false?');
  await fill('[data-qz-form="add"] [name="statement"]', 'Salt is held by electrostatic attraction.');
  await check('[data-qz-form="add"] input[name="tf"][value="true"]');
  await submit('[data-qz-form="add"]');
  await waitFor("/2 questions in your bank/.test(document.querySelector('.qz').textContent) || /2 question/.test(document.querySelector('.qz').textContent)", 'second question saved');
  await fill('[data-qz-form="add"] [name="type"]', 'explain');
  await waitFor("!!document.querySelector('[data-qz-form=\"add\"] [name=\"crit0\"]')", 'explain form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'Why does NaCl have a high melting point?');
  await fill('[data-qz-form="add"] [name="crit0"]', 'Mentions ions'); await fill('[data-qz-form="add"] [name="crit1"]', 'Mentions strong attraction');
  await submit('[data-qz-form="add"]');
  await waitFor("/3 questions in your bank/.test(document.querySelector('.qz').textContent) || /3 question/.test(document.querySelector('.qz').textContent)", 'third question saved');
  step('three questions written in the UI');
  await shoot('quiz-2-bank');

  await click('[data-qz="home"]');
  await waitFor("!!document.querySelector('[data-qz=\"start\"]') && !document.querySelector('[data-qz=\"start\"]').disabled", 'start enabled');
  await click('[data-qz="start"]');
  await waitFor("!!document.querySelector('.qz-card')", 'quiz opened');
  const asked = await evaluate("document.querySelector('.qz-head').textContent");
  assert.match(asked, /Question 1 of 3/);
  step('pre-test started: 3 questions');
  await shoot('quiz-3-question');

  // The renderer never holds the answer key while the quiz is open.
  const leaked = await evaluate(`window.learningData.assessmentList({ subjectId: ${q(subjectId)} }).then(async list => JSON.stringify(await window.learningData.assessmentGet({ assessmentId: list[0].id })))`);
  for (const key of ['"correct"', '"modelAnswer"', '"explanation"', '"keywords"']) assert.ok(!leaked.includes(key), `no ${key} in an open assessment`);
  step('no answer key in an open assessment');

  for (let i = 0; i < 3; i++) {
    const type = await evaluate("document.querySelector('.qz-meta').textContent");
    if (/Multiple/.test(type)) await evaluate("(() => { const inputs = [...document.querySelectorAll('input[name=\"choice\"]')]; const el = inputs.find(i => i.nextElementSibling.textContent === 'NaCl'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()");
    else if (/True/.test(type)) await check('input[name="tf"][value="true"]');
    else await fill('textarea[name="text"]', 'Ions attract strongly, so it takes a lot of heat to separate them.');
    await check('input[name="confidence"][value="2"]');
    if (i < 2) { await click('[data-qz="next"]'); await waitFor(`/Question ${i + 2} of 3/.test(document.querySelector('.qz-head').textContent)`, 'next question'); }
  }
  await click('[data-qz="submit"]');
  await waitFor("!!document.querySelector('[data-qz-form=\"grade\"]')", 'self-grade screen');
  step('submitted; written answer waits for a self-grade');
  await shoot('quiz-4-selfgrade');
  await evaluate("document.querySelectorAll('[data-qz-form=\"grade\"] input[type=\"checkbox\"]').forEach((c, i) => { c.checked = i === 0; })");
  await submit('[data-qz-form="grade"]');
  await waitFor("!!document.querySelector('.qz-score')", 'results');
  const score = await evaluate("document.querySelector('.qz-score').textContent");
  assert.match(score, /^2\.5 of 3 points$|^\d+(\.\d+)? of 3 points$/, score);
  assert.ok(await evaluate("document.querySelectorAll('.qz-rev').length === 3"), 'three reviewed answers');
  assert.ok(await evaluate("/Not assessed/.test(document.querySelector('.qz-table').textContent)"), 'thin evidence reads Not assessed');
  step(`results: ${score}; topic level reads Not assessed with 3 items`);
  await shoot('quiz-5-results');

  assert.equal(await evaluate("window.learningData.journeyList({ subjectId: " + q(subjectId) + " }).then(j => j[0].stage)"), 'pretest', 'journey moved to the pre-test stage');
  assert.ok(!/Unhandled|TypeError|ReferenceError/.test(stderr), `no errors on stderr: ${stderr.slice(0, 300)}`);
  step('journey stage and stderr clean');
}

main().then(() => 0, error => { console.error(`FAIL: ${error.message}`); return 1; }).then(async code => {
  try { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.evaluate', params: { expression: 'window.windowControls && window.windowControls.close()' } })); } catch { /* closing */ }
  await Promise.race([new Promise(r => child?.once('exit', r)), sleep(15000)]);
  if (child && child.exitCode === null) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(code);
});

'use strict';
/* Electron check for quizzes and exams on the subject page: write questions in the UI, take a pre-test, practice with feedback,
   a timed test final with pass mark and attempts table, and the pre-vs-final report.
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
const head = () => evaluate("document.querySelector('.qz-head').textContent");
const total = async () => Number(((await head()).match(/of (\d+)/) || [])[1]);

/* Answer the open question the way a student would: NaCl for the choice, true, and a sentence for written answers. */
async function answerCurrent() {
  const type = await evaluate("document.querySelector('.qz-meta').textContent");
  if (/Multiple/.test(type)) await evaluate("(() => { const inputs = [...document.querySelectorAll('input[name=\"choice\"]')]; const el = inputs.find(i => i.nextElementSibling.textContent.includes('NaCl')) || inputs[0]; el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()");
  else if (/True/.test(type)) await check('input[name="tf"][value="true"]');
  else if (/Matching/.test(type)) await evaluate("(() => { const want = { NaCl: 'Ionic', H2O: 'Covalent' }; document.querySelectorAll('select[name^=\"match:\"]').forEach(s => { const label = s.previousElementSibling.textContent; const o = [...s.options].find(x => x.textContent === want[label]); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } }); })()");
  else await fill('textarea[name="text"]', 'Ions attract strongly, so it takes a lot of heat.');
}
async function answerAll() {
  const n = await total();
  for (let i = 0; i < n; i++) {
    await answerCurrent();
    if (i < n - 1) { await click('[data-qz="next"]'); await waitFor(`/Question ${i + 2} of ${n}/.test(document.querySelector('.qz-head').textContent)`, 'next question'); }
  }
  return n;
}
/* Submit; if written answers exist, self-grade them (tick `ticks` boxes per answer). */
async function submitAndGrade(ticks) {
  await click('[data-qz="submit"]');
  await waitFor("!!document.querySelector('[data-qz-form=\"grade\"], .qz-score')", 'grade screen or results');
  if (await evaluate("!!document.querySelector('[data-qz-form=\"grade\"]')")) {
    await evaluate(`document.querySelectorAll('[data-qz-form="grade"] fieldset').forEach(f => f.querySelectorAll('input[type="checkbox"]').forEach((c, i) => { c.checked = i < ${ticks}; }))`);
    await submit('[data-qz-form="grade"]');
    await waitFor("!!document.querySelector('.qz-score')", 'results');
    return true;
  }
  return false;
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
  for (const action of ['start', 'practice', 'exam']) assert.ok(await evaluate(`document.querySelector('[data-qz="${action}"]').disabled`), `${action} is disabled with no questions`);
  step('quiz block on the subject page, empty bank');
  await shoot('quiz-1-home');

  // An invalid question shows the validator's text and keeps what was typed.
  await click('[data-qz="add"]'); await waitFor("!!document.querySelector('[data-qz-form=\"add\"]')", 'form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'Which bond is ionic?');
  await submit('[data-qz-form="add"]');
  await waitFor("!!document.querySelector('.qz-error') && /options|correct/i.test(document.querySelector('.qz-error').textContent)", 'validation error');
  assert.equal(await evaluate("document.querySelector('[data-qz-form=\"add\"] [name=\"prompt\"]').value"), 'Which bond is ionic?', 'typed text kept');
  step('invalid question rejected with a plain message, input kept');

  const saved = n => waitFor(`window.learningData.questionsList({ subjectId: ${q(subjectId)} }).then(l => l.length === ${n})`, `question ${n} saved`);
  await fill('[data-qz-form="add"] [name="opt0"]', 'Covalent'); await fill('[data-qz-form="add"] [name="opt1"]', 'NaCl');
  await check('[data-qz-form="add"] input[name="correct"][value="1"]');
  await submit('[data-qz-form="add"]'); await saved(1);
  await fill('[data-qz-form="add"] [name="type"]', 'truefalse');
  await waitFor("!!document.querySelector('[data-qz-form=\"add\"] [name=\"statement\"]')", 'true/false form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'True or false?');
  await fill('[data-qz-form="add"] [name="statement"]', 'Salt is held by electrostatic attraction.');
  await check('[data-qz-form="add"] input[name="tf"][value="true"]');
  await submit('[data-qz-form="add"]'); await saved(2);
  await fill('[data-qz-form="add"] [name="type"]', 'matching');
  await waitFor("!!document.querySelector('[data-qz-form=\"add\"] [name=\"left0\"]')", 'matching form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'Match each compound to its bond.');
  await fill('[data-qz-form="add"] [name="left0"]', 'NaCl'); await fill('[data-qz-form="add"] [name="right0"]', 'Ionic');
  await fill('[data-qz-form="add"] [name="left1"]', 'H2O'); await fill('[data-qz-form="add"] [name="right1"]', 'Covalent');
  await submit('[data-qz-form="add"]'); await saved(3);
  await fill('[data-qz-form="add"] [name="type"]', 'explain');
  await waitFor("!!document.querySelector('[data-qz-form=\"add\"] [name=\"crit0\"]')", 'explain form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'Why does NaCl have a high melting point?');
  await fill('[data-qz-form="add"] [name="crit0"]', 'Mentions ions'); await fill('[data-qz-form="add"] [name="crit1"]', 'Mentions strong attraction');
  await submit('[data-qz-form="add"]'); await saved(4);
  await fill('[data-qz-form="add"] [name="type"]', 'essay');
  await waitFor("!!document.querySelector('[data-qz-form=\"add\"] [name=\"maxWords\"]')", 'essay form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'Discuss ionic and covalent bonding.');
  await fill('[data-qz-form="add"] [name="crit0"]', 'Defines both'); await fill('[data-qz-form="add"] [name="crit1"]', 'Compares properties');
  await fill('[data-qz-form="add"] [name="minWords"]', '5'); await fill('[data-qz-form="add"] [name="maxWords"]', '200');
  await submit('[data-qz-form="add"]'); await saved(5);
  step('five questions written in the UI: choice, true/false, matching, explain, essay');
  // More choice questions through the API, so the pre-test, practice set and a final can each draw different ones.
  const topicId = await evaluate(`window.learningData.topics(${q(subjectId)}).then(t => t.rows[0].id)`);
  for (let i = 1; i <= 8; i++) {
    await evaluate(`window.learningData.questionsSave({ question: { subjectId: ${q(subjectId)}, topicId: ${q(topicId)}, type: 'choice', prompt: 'Which one is NaCl-like ${i}?', dimension: 'recognition', difficulty: ${1 + (i % 3)}, explanation: 'Because of ionic bonds.', payload: { options: [{ id: 'a', text: 'Covalent' }, { id: 'b', text: 'NaCl' }], correct: ['b'] } } })`);
  }
  await shoot('quiz-2-bank');

  await click('[data-qz="home"]');
  await waitFor("!!document.querySelector('[data-qz=\"start\"]') && !document.querySelector('[data-qz=\"start\"]').disabled", 'start enabled');
  await click('[data-qz="start"]');
  await waitFor("!!document.querySelector('.qz-card')", 'quiz opened');
  const n = await total();
  assert.ok(n >= 2, `pre-test has ${n} questions`);
  assert.match(await head(), /Pre-test · Question 1 of/);
  step(`pre-test started: ${n} questions`);
  await shoot('quiz-3-question');

  // The renderer never holds the answer key while the quiz is open.
  const leaked = await evaluate(`window.learningData.assessmentList({ subjectId: ${q(subjectId)} }).then(async list => JSON.stringify((await window.learningData.assessmentGet({ assessmentId: list[0].id })).items.map(i => i.question)))`);
  for (const key of ['"correct"', '"modelAnswer"', '"explanation"', '"keywords"', '"pairs"']) assert.ok(!leaked.includes(key), `no ${key} in an open assessment's questions`);
  step('no answer key in an open assessment');

  await answerAll();
  const graded = await submitAndGrade(1);
  const score = await evaluate("document.querySelector('.qz-score').textContent");
  assert.match(score, /^Pre-test: \d+(\.\d+)? of \d+ points$/, score);
  assert.ok(await evaluate("document.querySelectorAll('.qz-rev').length === " + n), 'every question is reviewed');
  assert.ok(await evaluate("/Not assessed|Emerging|Developing|Proficient|Mastered/.test(document.querySelector('.qz-table').textContent)"), 'a level per topic');
  step(`results: ${score}${graded ? ' (self-graded)' : ''}`);
  await shoot('quiz-5-results');
  assert.equal(await evaluate(`window.learningData.journeyList({ subjectId: ${q(subjectId)} }).then(j => j[0].stage)`), 'pretest', 'journey moved to the pre-test stage');

  // Practice: feedback after Check, key shown only for that question.
  await click('[data-qz="home"]');
  await waitFor("!!document.querySelector('[data-qz=\"practice\"]') && !document.querySelector('[data-qz=\"practice\"]').disabled", 'practice enabled');
  await click('[data-qz="practice"]');
  await waitFor("!!document.querySelector('.qz-card') && /Practice/.test(document.querySelector('.qz-head').textContent)", 'practice opened');
  await answerCurrent();
  await click('[data-qz="check"]');
  await waitFor("!!document.querySelector('.qz-feedback')", 'feedback after Check');
  assert.ok(await evaluate("[...document.querySelectorAll('.qz-card input, .qz-card textarea, .qz-card select')].every(el => el.disabled)"), 'a checked answer is locked');
  step('practice: feedback after Check, answer locked');
  await shoot('quiz-6-practice');
  await click('[data-qz="leave"]');

  // Final exam: a real one needs 50–100 questions; a test final does not; time options; pass mark; attempts table.
  await waitFor("!!document.querySelector('[data-qz=\"exam\"]') && !document.querySelector('[data-qz=\"exam\"]').disabled", 'exam enabled');
  await click('[data-qz="exam"]');
  await waitFor("!!document.querySelector('[data-qz-form=\"exam\"]') && /50–100 questions/.test((document.querySelector('.qz-error') || {}).textContent || '')", 'a real final needs 50–100 questions');
  assert.ok(await evaluate("document.querySelector('[data-qz-form=\"exam\"] button[type=\"submit\"]').disabled"), 'Start is disabled while the setup is invalid');
  await check('[data-qz-form="exam"] input[name="test"]');
  await fill('[data-qz-form="exam"] [name="count"]', '4');
  await waitFor("/pass mark \\d/.test((document.querySelector('[data-qz-form=\"exam\"]') || {}).textContent || '') && !document.querySelector('[data-qz-form=\"exam\"] button[type=\"submit\"]').disabled", 'test final preview with limit and pass mark');
  const preview = await evaluate("document.querySelector('[data-qz-form=\"exam\"] [role=\"status\"]').textContent");
  assert.match(preview, /time limit \d+ min/);
  step(`exam setup: ${preview.replace(/\s+/g, ' ')}`);
  await shoot('quiz-7-exam-setup');
  await submit('[data-qz-form="exam"]');
  await waitFor("!!document.querySelector('.qz-card') && /Final exam/.test(document.querySelector('.qz-head').textContent)", 'final opened');
  const first = await waitFor("(document.querySelector('[data-qz-timer]') || {}).textContent", 'timer shown');
  assert.match(first, /^\d+:\d\d$/);
  await sleep(2200);
  const later = await evaluate("document.querySelector('[data-qz-timer]').textContent");
  assert.notEqual(first, later, 'the clock runs');
  step(`timed final: clock ${first} → ${later}`);
  await shoot('quiz-8-exam');
  await answerAll();
  await submitAndGrade(2);
  await waitFor("!!document.querySelector('.qz-pass, .qz-fail')", 'exam verdict');
  const verdict = await evaluate("document.querySelector('.qz-pass, .qz-fail').textContent");
  assert.match(verdict, /Passed|Not passed/);
  assert.ok(await evaluate("/pass mark \\d/.test(document.querySelector('.qz').textContent)"), 'pass mark shown');
  assert.ok(await evaluate("/side by side/.test(document.body.textContent)"), 'attempts table shown');
  step(`exam result: ${verdict}`);
  await shoot('quiz-9-exam-results');
  assert.equal(await evaluate(`window.learningData.journeyList({ subjectId: ${q(subjectId)} }).then(j => j[0].stage)`), 'final_exam', 'journey moved to the final stage');

  // Report: pre-test vs now.
  await click('[data-qz="report"]');
  await waitFor("!!document.querySelector('.qz-table caption') && /Pre-test vs now/.test(document.querySelector('.qz-table caption').textContent)", 'report');
  step('report: pre-test vs now by topic');
  await shoot('quiz-10-report');
  assert.ok(!/Unhandled|TypeError|ReferenceError/.test(stderr), `no errors on stderr: ${stderr.slice(0, 300)}`);
  step('stderr clean');
}

main().then(() => 0, error => { console.error(`FAIL: ${error.message}`); return 1; }).then(async code => {
  try { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.evaluate', params: { expression: 'window.windowControls && window.windowControls.close()' } })); } catch { /* closing */ }
  await Promise.race([new Promise(r => child?.once('exit', r)), sleep(15000)]);
  if (child && child.exitCode === null) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(code);
});

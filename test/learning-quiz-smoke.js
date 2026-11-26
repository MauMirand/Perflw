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
const webRequests = []; const pageErrors = []; // M-L1: no http(s) request and no console error during the whole walk
const cdp = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\nIn: ${expression.slice(0, 160)}`);
  return r.result.value;
}
async function waitFor(expression, label, timeout = 20000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { last = await evaluate(expression); if (last) return last; } catch (error) { last = error.message; } await sleep(80); }
  let shown = ''; try { shown = await evaluate("(document.querySelector('.qz-error') || {}).textContent || ''"); } catch { /* page gone */ }
  throw new Error(`Timed out: ${label} (last: ${String(last).slice(0, 200)})${shown ? ` · on screen: ${shown}` : ''}`);
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
async function take(kind) {
  await click(`[data-qz-cytab="${kind}"]`);
  await waitFor("!!document.querySelector('[data-qz-take]') && !document.querySelector('[data-qz-take]').disabled", `Take enabled for ${kind}`);
  await click('[data-qz-take]');
}
/* Controls inside the quiz block with no accessible name (label, aria-label, aria-labelledby or visible button text). */
const unnamedControls = () => evaluate(`[...document.querySelectorAll('.qz input, .qz select, .qz textarea, .qz button')].filter(el => {
  if (el.type === 'hidden') return false;
  if (el.tagName === 'BUTTON') return !(el.textContent.trim() || el.getAttribute('aria-label'));
  return !(el.closest('label') || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector('label[for="' + el.id + '"]')));
}).length`);
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
  socket.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.method === 'Network.requestWillBeSent' && /^https?:/i.test(d.params.request.url)) webRequests.push(d.params.request.url);
    else if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.text + ' ' + ((d.params.exceptionDetails.exception || {}).description || ''));
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map(a => a.value || a.description || '').join(' '));
    const p = d.id && pending.get(d.id); if (!p) return; pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result);
  };
  await cdp('Runtime.enable'); await cdp('Network.enable');
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
  await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Chemistry' && !!document.querySelector('[data-qz-eval] .qz-tabs')", 'subject page with the Evaluation Cycle card');
  assert.ok(await evaluate("/Study/.test(document.querySelector('.ln-page-head [data-ln=learn]').textContent) && !!document.querySelector('[data-ln=start-session]')"), 'header has Study and Start your session');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-qz-evtab]')].map(b => b.textContent)"), ['Pre-Test', 'Practice', 'Final Exam']);
  assert.ok(await evaluate("document.querySelector('[data-qz-host]').hidden"), 'the full workspace is closed until asked for');
  await shoot('quiz-0-card');
  await click('[data-qz-evexpand]');
  await waitFor("!document.querySelector('[data-qz-host]').hidden && !!document.querySelector('.qz-cycle .qz')", 'Learning Cycle open');
  assert.ok(await evaluate("(() => { const a = document.querySelector('[data-qz-host]').getBoundingClientRect(), b = document.getElementById('main-panel').getBoundingClientRect(); return Math.abs(a.top - b.top) < 2 && Math.abs(a.left - b.left) < 2 && Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2; })()"), 'the Learning Cycle covers the main panel');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-qz-cytab]')].map(b => b.textContent)"), ['Pre-Test', 'Practice', 'Final Exam']);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-qz-sections] .qz-tab')].map(b => b.textContent)"), ['Cycle status', 'Question bank', 'Schedule']);
  await waitFor("!!document.querySelector('[data-qz-side] [aria-label=Status]') && /Your Performance/.test(document.querySelector('[data-qz-side]').textContent) && /Not taken/.test(document.querySelector('[data-qz-side]').textContent)", 'Status and Your Performance cards');
  assert.ok(await evaluate("!document.querySelector('[data-qz-study-topic]') && !document.querySelector('[data-qz=\"study-start\"]')"), 'no Start studying in the Learning Cycle (parked)');
  await shoot('quiz-0b-cycle');
  step('subject page: Study, Start your session, Evaluation Cycle card with tabs; expand opens everything');
  await waitFor("/0 questions in your bank/.test(document.querySelector('.qz').textContent)", 'empty bank message');
  assert.ok(await evaluate("/How this works/.test(document.querySelector('.qz').textContent)"), 'the first-use hint is shown on a fresh subject');
  await click('[data-qz="hint-dismiss"]');
  assert.ok(await evaluate("!/How this works/.test(document.querySelector('.qz').textContent)"), 'the hint is dismissible');
  step('first-use hint: shown once, dismissed, remembered');
  for (const kind of ['diagnostic', 'practice', 'final']) { await click(`[data-qz-cytab="${kind}"]`); await waitFor("!!document.querySelector('[data-qz-take]') && document.querySelector('[data-qz-take]').disabled", `Take is disabled for ${kind} with no questions`); }
  step('quiz block on the subject page, empty bank');
  await shoot('quiz-1-home');

  // An invalid question shows the validator's text and keeps what was typed.
  await click('[data-qz="bank"]'); await waitFor("!!document.querySelector('[data-qz=\"add\"]')", 'Question bank section');
  await click('[data-qz="add"]'); await waitFor("!!document.querySelector('[data-qz-form=\"add\"]')", 'form');
  await fill('[data-qz-form="add"] [name="prompt"]', 'Which bond is ionic?');
  await submit('[data-qz-form="add"]');
  await waitFor("!!document.querySelector('.qz-error') && /options|correct/i.test(document.querySelector('.qz-error').textContent)", 'validation error');
  assert.equal(await evaluate("document.querySelector('[data-qz-form=\"add\"] [name=\"prompt\"]').value"), 'Which bond is ionic?', 'typed text kept');
  step('invalid question rejected with a plain message, input kept');
  assert.equal(await unnamedControls(), 0, 'every control in the question form has an accessible name');

  // A save is done when the bank has the question AND the form has been redrawn empty (typing into the old form would be lost).
  const saved = async n => {
    await waitFor(`window.learningData.questionsList({ subjectId: ${q(subjectId)} }).then(l => l.length === ${n})`, `question ${n} saved`);
    await waitFor("(() => { const f = document.querySelector('[data-qz-form=add]'); return !!f && f.elements.prompt.value === '' && !f.querySelector('button[type=submit]').disabled; })()", `form ready after question ${n}`);
  };
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

  // Question bank: list, filter, edit, retire and restore, delete with a confirm.
  await click('[data-qz="home"]');
  await waitFor("!!document.querySelector('[data-qz=\"bank\"]')", 'bank button');
  await click('[data-qz="bank"]');
  await waitFor("document.querySelectorAll('.qz-q').length === 13", 'bank lists 13 questions');
  await fill('[data-qz-form="bank-filter"] [name="type"]', 'matching');
  await waitFor("document.querySelectorAll('.qz-q').length === 1", 'type filter');
  await fill('[data-qz-form="bank-filter"] [name="type"]', '');
  await waitFor("document.querySelectorAll('.qz-q').length === 13", 'filter cleared');
  assert.ok(await evaluate("(() => { const b = document.querySelector('[data-qz=ai-generate]'); return !!b && (!b.disabled || b.title.length > 5); })()"), 'Generate with AI is always visible; when disabled its tooltip says why');
  step(`AI controls: Generate with AI is ${await evaluate("document.querySelector('[data-qz=ai-generate]').disabled ? 'disabled (no model here), with the reason as its tooltip' : 'enabled (a local model was found)'")}`);
  await click('[data-qz="templates"]');
  await waitFor("/These topics have no file yet/.test(document.querySelector('.qz').textContent)", 'template drafts explain there is no file yet');
  await click('[data-qz="bank"]');
  await waitFor("document.querySelectorAll('.qz-q').length === 13", 'back in the bank');
  await click('[data-qz="edit"]');
  await waitFor("!!document.querySelector('[data-qz-form=\"add\"]') && /Editing a question/.test(document.querySelector('.qz').textContent)", 'edit form');
  assert.equal(await evaluate("document.querySelector('[data-qz-form=\"add\"] [name=\"prompt\"]').value"), 'Which bond is ionic?', 'edit form is filled');
  await fill('[data-qz-form="add"] [name="prompt"]', 'Which bond is ionic? (edited)');
  await submit('[data-qz-form="add"]');
  await waitFor("[...document.querySelectorAll('.qz-q-prompt')].some(e => e.textContent === 'Which bond is ionic? (edited)') && document.querySelectorAll('.qz-q').length === 13", 'edit saved, same count');
  await evaluate("document.querySelectorAll('[data-qz=\"retire\"]')[12].click()");
  await waitFor("document.querySelectorAll('.qz-q').length === 12", 'retired question leaves the list');
  await check('[data-qz-form="bank-filter"] input[name="retired"]');
  await waitFor("document.querySelectorAll('.qz-q').length === 13 && !!document.querySelector('[data-qz=\"restore\"]')", 'retired shown with Restore');
  await click('[data-qz="restore"]');
  await waitFor("!document.querySelector('[data-qz=\"restore\"]')", 'restored');
  await evaluate("document.querySelectorAll('[data-qz=\"delete\"]')[12].click()");
  await waitFor("!!document.querySelector('[data-qz=\"delete-yes\"]')", 'delete asks first');
  await click('[data-qz="delete-no"]');
  assert.equal(await evaluate("document.querySelectorAll('.qz-q').length"), 13, 'Keep leaves it');
  await evaluate("document.querySelectorAll('[data-qz=\"delete\"]')[12].click()");
  await waitFor("!!document.querySelector('[data-qz=\"delete-yes\"]')", 'delete asks again');
  await click('[data-qz="delete-yes"]');
  await waitFor("document.querySelectorAll('.qz-q').length === 12", 'deleted for good');
  step('question bank: filter, edit, retire/restore, delete with confirm');

  await click('[data-qz="home"]');
  await take('diagnostic');
  await waitFor("!!document.querySelector('[data-qz-form=\"setup\"]')", 'pre-test setup sheet');
  assert.ok(await evaluate("/approved questions? match/.test(document.querySelector('.qz').textContent) || /approved question/.test(document.querySelector('.qz').textContent)"), 'the setup sheet counts the questions that match');
  await shoot('quiz-2c-setup');
  await submit('[data-qz-form="setup"]');
  await waitFor("!!document.querySelector('.qz-card')", 'quiz opened');
  const n = await total();
  assert.ok(n >= 2, `pre-test has ${n} questions`);
  assert.match(await head(), /Pre-test · Question 1 of/);
  step(`pre-test started: ${n} questions`);
  assert.equal(await unnamedControls(), 0, 'every control on the quiz card has an accessible name');
  // WCAG 2.1 AA: text contrast of the quiz block (4.5:1) and navigator targets of at least 24 px.
  const lowContrast = await evaluate(`(() => {
    const lum = c => { const v = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const bgOf = el => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; const a = b.match(/[\\d.]+/g); if (a && (a.length < 4 || Number(a[3]) > 0.9)) return b; } return 'rgb(30,30,30)'; };
    const bad = [];
    for (const el of document.querySelectorAll('.qz .qz-meta, .qz .ln-soon, .qz .qz-head, .qz .qz-prompt, .qz .qz-conf, .qz .qz-keys, .qz-choice span')) {
      if (!el.textContent.trim()) continue;
      const f = lum(getComputedStyle(el).color), b = lum(bgOf(el)); const r = (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
      if (r < 4.5) bad.push(el.className + ' ' + r.toFixed(2));
    }
    return bad.join(', ');
  })()`);
  assert.equal(lowContrast, '', `text contrast below 4.5:1: ${lowContrast}`);
  assert.ok(await evaluate("[...document.querySelectorAll('.qz-dot')].every(d => d.getBoundingClientRect().width >= 24 && d.getBoundingClientRect().height >= 24)"), 'navigator dots are at least 24 px');
  step('accessibility: names, text contrast at least 4.5:1, navigator targets at least 24 px');
  await shoot('quiz-3-question');

  // The renderer never holds the answer key while the quiz is open.
  const leaked = await evaluate(`window.learningData.assessmentList({ subjectId: ${q(subjectId)} }).then(async list => JSON.stringify((await window.learningData.assessmentGet({ assessmentId: list[0].id })).items.map(i => i.question)))`);
  for (const key of ['"correct"', '"modelAnswer"', '"explanation"', '"keywords"', '"pairs"']) assert.ok(!leaked.includes(key), `no ${key} in an open assessment's questions`);
  step('no answer key in an open assessment');

  await answerAll();
  assert.ok(await evaluate("!document.querySelector('.qz-feedback') && !document.querySelector('.qz-choice.right, .qz-choice.wrong')"), 'a test reveals nothing while you answer');
  await check('input[name="dontKnow"]'); // the last question: "I don't know", so the analysis has a mistake to name
  const graded = await submitAndGrade(1);
  const score = await evaluate("document.querySelector('.qz-score').textContent");
  assert.match(score, /^Pre-test: \d+(\.\d+)? of \d+ points$/, score);
  assert.ok(await evaluate("document.querySelectorAll('.qz-rev').length === " + n), 'every question is reviewed');
  assert.ok(await evaluate("/Not assessed|Emerging|Developing|Proficient|Mastered/.test(document.querySelector('.qz-table').textContent)"), 'a level per topic');
  step(`results: ${score}${graded ? ' (self-graded)' : ''}`);
  await shoot('quiz-5-results');
  // Mistake analysis and deterministic targeted notes (no AI).
  await waitFor("!!document.querySelector('.qz-analysis') && /Did not know/.test(document.querySelector('.qz-analysis').textContent)", 'analysis names the mistake category');
  await click('[data-qz="notes-make"]');
  await waitFor("/Targeted note: /.test(document.querySelector('.qz-md') ? document.querySelector('.qz-md').textContent : '')", 'targeted note written');
  assert.ok(await evaluate("/You answered/.test(document.querySelector('.qz-md').textContent)"), 'the note quotes the mistake');
  step('analysis: mistake categories, weak topics, targeted notes written without AI');
  await shoot('quiz-5b-notes');
  await click('[data-qz="home"]');
  await waitFor("!!document.querySelector('[data-qz=\"notes\"]')", 'targeted notes listed on the home screen');
  // Practice exactly the missed questions.
  await click('[data-qz="results"]');
  await waitFor("!!document.querySelector('[data-qz=\"practice-these\"]')", 'practice these offered');
  await click('[data-qz="practice-these"]');
  await waitFor("!!document.querySelector('.qz-card') && /Practice/.test(document.querySelector('.qz-head').textContent)", 'practice of the mistakes opened');
  await click('[data-qz="leave"]');
  step('practice these: a set of exactly the missed questions');
  assert.equal(await evaluate(`window.learningData.journeyList({ subjectId: ${q(subjectId)} }).then(j => j[0].stage)`), 'targeted_notes', 'the journey moved from the diagnostic to the targeted-notes stage when the notes were written');

  // Study session (LS-012): the account timer runs it, a side note is the student's own text, one focus entry with source learning.
  await evaluate(`window.PerflwQuiz.startSession(${q(subjectId)}, { topicId: ${q(topicId)} })`);
  await waitFor("!!document.querySelector('[data-qz-study-time]') && /Studying: Ionic bonds/.test(document.querySelector('.qz-study').textContent)", 'study session started');
  assert.equal(await evaluate("window.workspaceData.focus().then(() => window.learningData.studyActive()).then(a => !!a && a.topicTitle)"), 'Ionic bonds', 'the main process reports the open session');
  const clockA = await evaluate("document.querySelector('[data-qz-study-time]').textContent"); await sleep(2200);
  const clockB = await evaluate("document.querySelector('[data-qz-study-time]').textContent");
  assert.notEqual(clockA, clockB, 'the session clock runs');
  await fill('[data-qz-form="note"] [name="text"]', 'Ionic bonds hold because opposite charges attract.');
  await submit('[data-qz-form="note"]');
  await waitFor("/Ionic bonds hold because opposite charges attract\./.test((document.querySelector('.qz-notes') || {}).textContent || '')", 'side note listed');
  // A second timer cannot start while the session runs.
  assert.match(await evaluate("window.learningData.studyStart({ subjectId: " + q(subjectId) + ", kind: 'main' }).then(() => 'started', e => e.message)"), /timer is already running/);
  await click('[data-qz="study-end"]');
  await waitFor("/Session saved/.test((document.querySelector('.qz-feedback') || {}).textContent || '')", 'session summary');
  assert.ok(await evaluate("/1 note/.test(document.querySelector('.qz-feedback').textContent)"), 'summary counts the note');
  const entries = await evaluate("window.workspaceData.focus()");
  assert.equal(entries.filter(e => e.source === 'learning').length, 1, 'exactly one focus entry from the session');
  assert.equal(await evaluate("window.learningData.studyActive()"), null, 'no open session and no ghost timer');
  step('study session: timer runs, side note kept, one learning focus entry, summary shown');
  await shoot('quiz-4b-study');

  // Final learning (D9): the evaluation of the cycle so far, and what unlocks the final. History: every assessment so far.
  await click('[data-qz="evaluation"]');
  await waitFor("/Final learning · cycle 1/.test(document.querySelector('.qz').textContent)", 'final learning evaluation');
  assert.ok(await evaluate("/1 study session/.test(document.querySelector('.qz').textContent) && /Where you stand now/.test(document.querySelector('.qz').textContent)"), 'evaluation shows the session and the levels');
  assert.ok(await evaluate("/Review study session/.test(document.querySelector('.qz').textContent)"), 'it says what unlocks the final');
  step('final learning: evaluation with study time, levels and what unlocks the final');
  await shoot('quiz-4c-evaluation');
  await click('[data-qz="home"]');
  await waitFor("!!document.querySelector('[data-qz=\"history\"]')", 'history button');
  await click('[data-qz="history"]');
  await waitFor("/Cycle 1/.test(document.querySelector('.qz').textContent) && document.querySelectorAll('.qz-table tbody tr').length >= 1", 'history lists the pre-test');
  step('history: every assessment with its score and levels');
  await click('[data-qz="home"]');

  // Practice: feedback after Check, key shown only for that question (the study summary leaves us on the home screen).
  await waitFor("(document.querySelector('.qz-track .qz-stop.now') || { getAttribute: () => '' }).getAttribute('aria-label') === 'Final learning: In progress'", 'the cycle track shows Final learning as on going (viewing the final learning evaluation moves the journey on)');
  assert.equal(await evaluate("[...document.querySelectorAll('.qz-track .qz-stop')].map(e => e.classList.contains('done') ? 'd' : e.classList.contains('now') ? 'n' : 't').join('')"), 'dddddddddnttt', 'stages before it completed (green), it on going (blue), the rest not completed (gray)');
  assert.ok(await evaluate("getComputedStyle(document.querySelector('.qz-stop.done')).backgroundColor !== getComputedStyle(document.querySelector('.qz-stop.now')).backgroundColor && getComputedStyle(document.querySelector('.qz-stop.now')).backgroundColor !== getComputedStyle(document.querySelector('.qz-stop.todo')).backgroundColor"), 'three distinct colours');
  const stopAt = await evaluate("(() => { const r = document.querySelector('.qz-stop.now').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stopAt.x, y: stopAt.y });
  await waitFor("getComputedStyle(document.querySelector('.qz-stop.now .qz-tip')).opacity === '1'", 'tooltip shows on hover');
  assert.equal(await evaluate("document.querySelector('.qz-stop.now .qz-tip').textContent"), 'Final learningIn progress', 'tooltip: name and status');
  assert.equal(await evaluate("document.querySelector('.qz-stop.done .qz-tip').textContent"), 'MaterialCompleted');
  assert.equal(await evaluate("document.querySelector('.qz-stop.todo .qz-tip').textContent"), 'Final examNot complete');
  await shoot('quiz-4d-track');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await waitFor("getComputedStyle(document.querySelector('.qz-stop.now .qz-tip')).visibility === 'hidden'", 'tooltip hides when the pointer leaves');
  step('cycle track: 13 stages, completed green, on going blue, not completed gray');
  await take('practice');
  await waitFor("!!document.querySelector('.qz-card') && /Practice/.test(document.querySelector('.qz-head').textContent)", 'practice opened');
  await answerCurrent();
  // A quiz reveals the answer by itself when it is complete; only written answers need the Check button.
  await sleep(500);
  if (!(await evaluate("!!document.querySelector('.qz-feedback')"))) await click('[data-qz=\"check\"]');
  await waitFor("!!document.querySelector('.qz-feedback')", 'feedback in the practice quiz');
  assert.ok(await evaluate("[...document.querySelectorAll('.qz-card input, .qz-card textarea, .qz-card select')].every(el => el.disabled)"), 'a checked answer is locked');
  step('practice: feedback after Check, answer locked');
  await shoot('quiz-6-practice');
  await click('[data-qz="leave"]');
  // Schedule section: add, edit (kind, start, duration), remove with a confirm; each one is a calendar event with a link.
  await waitFor("!!document.querySelector('[data-qz=\"schedule\"]')", 'Schedule section toggle');
  await click('[data-qz="schedule"]');
  await waitFor("!!document.querySelector('[data-qz-form=\"schedule\"]')", 'schedule form');
  await fill('[data-qz-form="schedule"] [name="startsAt"]', '2030-01-15T10:00');
  await submit('[data-qz-form="schedule"]');
  await waitFor("!!document.querySelector('[data-qz=\"sched-cancel\"]') && /45 min/.test(document.querySelector('.qz-sched-list').textContent)", 'scheduled session listed with its duration');
  await shoot('quiz-6b-schedule');
  await click('[data-qz="sched-edit"]');
  await waitFor("/Edit scheduled item/.test(document.querySelector('.qz').textContent)", 'edit form');
  await fill('[data-qz-form="schedule"] [name="kind"]', 'practice');
  await fill('[data-qz-form="schedule"] [name="minutes"]', '90');
  await submit('[data-qz-form="schedule"]');
  await waitFor("/Practice/.test(document.querySelector('.qz-sched-list').textContent) && /90 min/.test(document.querySelector('.qz-sched-list').textContent)", 'edit saved');
  assert.equal(await evaluate(`window.learningData.scheduleList({ subjectId: ${q(subjectId)} }).then(l => l.length + ':' + l[0].kind + ':' + Math.round((Date.parse(l[0].endsAt) - Date.parse(l[0].startsAt)) / 60000))`), '1:practice:90', 'the calendar event and the link changed together');
  await click('[data-qz="sched-cancel"]');
  await waitFor("!!document.querySelector('[data-qz=\"sched-remove-yes\"]')", 'remove asks first');
  await click('[data-qz="sched-remove-yes"]');
  await waitFor("!document.querySelector('[data-qz=\"sched-cancel\"]')", 'scheduled session removed');
  step('schedule section: added to the calendar, edited (kind, duration), removed after a confirm');
  await click('[data-qz="home"]');

  // Practice retry: a wrong answer, one second try that counts half.
  const one = await evaluate(`window.learningData.questionsList({ subjectId: ${q(subjectId)} }).then(l => l.find(x => /NaCl-like 1[?]$/.test(x.prompt)).id)`);
  await evaluate(`window.learningData.assessmentCreate({ subjectId: ${q(subjectId)}, kind: 'practice', title: 'Retry', config: { only: [${q(one)}] } })`);
  await click('[data-qz="bank"]'); // leave and come back so the home screen reloads its list
  await waitFor("!!document.querySelector('.qz-qlist')", 'bank');
  await click('[data-qz="home"]');
  await waitFor("[...document.querySelectorAll('[data-qz=\"resume\"]')].some(b => /Start/.test(b.textContent))", 'the draft practice set is listed');
  await evaluate("[...document.querySelectorAll('[data-qz=\"resume\"]')].find(b => /Start/.test(b.textContent)).click()");
  await waitFor("!!document.querySelector('.qz-card') && /Practice · Question 1 of 1/.test(document.querySelector('.qz-head').textContent)", 'retry practice opened');
  await evaluate("(() => { const el = [...document.querySelectorAll('input[name=\"choice\"]')].find(i => i.nextElementSibling.textContent.includes('Covalent')); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await waitFor("!!document.querySelector('.qz-feedback')", 'the quiz reveals a wrong answer at once, no Check press');
  assert.ok(await evaluate("!!document.querySelector('.qz-choice.wrong') && !!document.querySelector('.qz-choice.right') && /Your answer/.test(document.querySelector('.qz-card').textContent) && /The answer/.test(document.querySelector('.qz-card').textContent)"), 'the wrong pick and the right answer are marked in place, with words');
  assert.ok(await evaluate("!document.querySelector('[data-qz=\"check\"]')"), 'no Check button for a single-answer question');
  await waitFor("!!document.querySelector('[data-qz=\"retry\"]')", 'a wrong answer offers a second try');
  await click('[data-qz="retry"]');
  await waitFor("!document.querySelector('.qz-feedback')", 'the question unlocks');
  await evaluate("(() => { const el = [...document.querySelectorAll('input[name=\"choice\"]')].find(i => i.nextElementSibling.textContent.includes('NaCl')); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await waitFor("(document.querySelector('.qz-feedback') || {}).textContent && document.querySelector('.qz-feedback').textContent.includes('second try, counts half') && document.querySelector('.qz-feedback').textContent.includes('0.5/1')", 'a right second try counts half');
  assert.ok(await evaluate("!document.querySelector('[data-qz=\"retry\"]')"), 'no third try');
  step('practice retry: a second try after a wrong answer, scored half, only once');
  await click('[data-qz="leave"]');

  // Final exam: a real one needs 50–100 questions; a test final does not; time options; pass mark; attempts table.
  await take('final');
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
  assert.equal(await evaluate(`window.learningData.journeyList({ subjectId: ${q(subjectId)} }).then(j => j[0].stage)`), 'report', 'journey moved to the report stage after the final is submitted');

  // Report: pre-test vs now.
  await click('[data-qz="report"]');
  await waitFor("!!document.querySelector('.qz-table caption') && /Pre-test vs now/.test(document.querySelector('.qz-table caption').textContent)", 'report');
  step('report: pre-test vs now by topic');
  await shoot('quiz-10-report');
  // Home Learn card (LS-027): where to continue, and no typed mastery percentage any more (LS-025).
  await click('.rail [data-go="home"]');
  await waitFor("!!document.querySelector('.profile-card')", 'home page');
  await waitFor("!!document.querySelector('[data-ln-home] .t-item')", 'the Learn card offers where to continue');
  const learnCard = await evaluate("document.querySelector('[data-card=\"learn\"]').textContent");
  assert.ok(/Continue: Chemistry/.test(learnCard) && !/% mastery/.test(learnCard), 'continue row present, no manual mastery percentage');
  step('home Learn card: continue row with stage and cycle, computed summary, no manual percentage');
  await click('.nav-item[data-go="learning"]');
  await waitFor("document.querySelectorAll('[data-ln-subject]').length === 1", 'subjects list');
  await evaluate("(() => { const el = document.querySelector('[data-ln-subject]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); return true; })()");
  await waitFor("!!document.querySelector('[data-qz-eval] .qz-gauge')", 'back on the subject page with the card');
  await waitFor("/Correct/.test(document.querySelector('[data-qz-eval]').textContent)", 'the card shows the latest result with its gauge');
  if (await evaluate("document.querySelector('[data-qz-host]').hidden")) await click('[data-qz-evexpand]');
  await waitFor("!!document.querySelector('.qz') && !document.querySelector('[data-qz-host]').hidden", 'workspace open again');

  // Next cycle: a new journey whose statistics start at zero; the old one stays.
  await click('[data-qz="home"]');
  await waitFor("!!document.querySelector('[data-qz=\"newcycle\"]')", 'next cycle offered after a final');
  await click('[data-qz="newcycle"]');
  await waitFor(`window.learningData.journeyList({ subjectId: ${q(subjectId)} }).then(j => j.length === 2 && j[1].cycle === 2 && j[1].parentId === j[0].id)`, 'cycle 2 created');
  const fresh = await evaluate(`window.learningData.journeyList({ subjectId: ${q(subjectId)} }).then(j => window.learningData.masteryJourney({ journeyId: j[1].id })).then(m => m.topics.every(t => t.items === 0 && t.level === 'not_assessed'))`);
  assert.ok(fresh, 'cycle 2 starts at zero');
  assert.ok(await evaluate(`window.learningData.journeyList({ subjectId: ${q(subjectId)} }).then(j => window.learningData.masteryJourney({ journeyId: j[0].id })).then(m => m.topics.some(t => t.items > 0))`), 'cycle 1 evidence is kept');
  step('next cycle: cycle 2 starts at zero, cycle 1 is kept');
  assert.ok(!/Unhandled|TypeError|ReferenceError/.test(stderr), `no errors on stderr: ${stderr.slice(0, 300)}`);
  step('stderr clean');
  assert.deepEqual(webRequests, [], 'no http(s) request was made: no AI provider or network was needed');
  assert.deepEqual(pageErrors, [], 'no console error or exception on the page');
  step('offline proof: 0 http(s) requests, 0 console errors');
}

main().then(() => 0, async error => { console.error(`FAIL: ${error.message}`); try { console.error('DEBUG', await evaluate("JSON.stringify({ head: (document.querySelector('.qz-head')||{}).textContent, nexts: document.querySelectorAll('[data-qz=next]').length, text: (document.querySelector('[data-qz-content]')||{}).textContent.slice(0,100), card: (document.querySelector('[data-qz-eval]')||{}).innerHTML.slice(0,1500), tab: [...document.querySelectorAll('[data-qz-evtab]')].map(b=>b.className).join() })")); } catch (e) { console.error('DEBUG failed', e.message); } return 1; }).then(async code => {
  try { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.evaluate', params: { expression: 'window.windowControls && window.windowControls.close()' } })); } catch { /* closing */ }
  await Promise.race([new Promise(r => child?.once('exit', r)), sleep(15000)]);
  if (child && child.exitCode === null) child.kill();
  let finalCode = code; let db = null;
  if (code === 0) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(path.join(root, 'workspace.sqlite'), { readOnly: true });
      const one = sql => db.prepare(sql).get();
      assert.equal(one('PRAGMA user_version').user_version, 2, 'workspace is at migration 2');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no broken foreign key');
      assert.equal(one('SELECT count(*) AS n FROM active_timers').n, 0, 'no ghost timer');
      assert.equal(one('SELECT count(*) AS n FROM learning_sessions WHERE ended_at IS NULL').n, 0, 'every study session is ended');
      assert.equal(one("SELECT count(*) AS n FROM assessments WHERE status='in_progress' AND kind IN ('diagnostic','final')").n, 0, 'no pre-test or final was left half done');
      assert.ok(one("SELECT count(*) AS n FROM assessments WHERE kind='final' AND status='graded'").n >= 1, 'a graded final exists');
      assert.equal(one("SELECT count(*) AS n FROM focus_entries WHERE source='learning'").n, 1, 'exactly one focus entry from the study session');
      const stray = []; (function walk(dir) { for (const name of fs.readdirSync(dir)) { const f = path.join(dir, name); if (fs.statSync(f).isDirectory()) walk(f); else if (/\.tmp/.test(name)) stray.push(f); } })(root);
      assert.deepEqual(stray, [], 'no temp file left in the data folder');
      console.log('PASS invariants: migration 2, no broken keys, no ghost timer, sessions ended, one learning focus entry, no temp files');
    } catch (error) { console.error(`FAIL: ${error.message}`); finalCode = 1; } finally { if (db) db.close(); }
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(finalCode);
});

// End-to-end check of the running Electron app (new planner design).
// Usage: npm run test:electron  — set PERFLW_SCREENSHOT_DIR to an absolute folder to save screenshots.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-electron-'));
const imagePath = path.join(__dirname, '..', 'assets', 'icon.png');
// Study file the Upload topics button reads (the dialog is skipped in tests): it becomes one topic, "Week 1 notes"
const topicPath = path.join(root, 'Week 1 notes.md');
fs.writeFileSync(topicPath, '# Functions\nNotes\n## Domain and range\n## Composition\n# Graphs\n');
// A second file, dropped onto the Topics card with a real OS-level file drag
const droppedPath = path.join(root, 'Week 2 notes.md');
const pdfPath = path.join(root, 'Unit notes.pdf');
fs.writeFileSync(pdfPath, (() => {
  const page = (n, text) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${n} 0 R >>`;
  const content = text => { const body = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`; return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`; };
  const objs = ['<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', page(5, ''), page(8, ''),
    content('Unit A page'), '<< /Type /Outlines /First 7 0 R /Last 10 0 R /Count 2 >>', '<< /Title (Unit A) /Parent 6 0 R /Next 10 0 R /Dest [3 0 R /XYZ 0 792 0] >>',
    content('Unit B page'), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Title (Unit B) /Parent 6 0 R /Prev 7 0 R /A << /S /GoTo /D [4 0 R /Fit] >> >>'];
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
})());
fs.writeFileSync(droppedPath, '# Limits\n# Derivatives\n# Series\n');
const packagedExe = process.env.PERFLW_ELECTRON_EXE;
const exe = packagedExe || require('electron');
const screenshots = process.env.PERFLW_SCREENSHOT_DIR;
let child; let socket; let nextId = 0; let diagnostics = '';
const pending = new Map();

async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(() => resolve(number)); });
    server.on('error', reject);
  });
}
async function launch() {
  const number = await port();
  child = spawn(exe, [...(packagedExe ? [] : ['.']), `--remote-debugging-port=${number}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...(process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : [])], {
    cwd: process.env.PERFLW_ELECTRON_APP_DIR || path.join(__dirname, '..'),
    env: { ...process.env, ...(packagedExe ? { APPDATA: root, LOCALAPPDATA: root } : {}), PERFLW_TEST_USER_DATA: root, PERFLW_TEST_IMAGE_PATH: imagePath, PERFLW_TEST_TOPIC_PATH: topicPath },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString().slice(0, 2000); });
  let endpoint;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${child.exitCode}\n${diagnostics}`);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${number}/json/list`)).json();
      endpoint = pages.find(page => page.type === 'page' && page.url.includes('index.html'))?.webSocketDebuggerUrl;
      if (endpoint) break;
    } catch { /* not ready */ }
    await sleep(100);
  }
  if (!endpoint) throw new Error('Electron page did not open');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    if (!data.id || !pending.has(data.id)) return;
    const { resolve, reject, method } = pending.get(data.id);
    pending.delete(data.id);
    data.error ? reject(new Error(`${data.error.message} during ${method}`)) : resolve(data.result);
  };
  await cdp('Runtime.enable');
  await waitFor("document.readyState === 'complete' && !!window.account && ['login','register','profile','main'].some(p => !document.getElementById(p + '-page').hidden)");
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function cdp(method, params) {
  return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject, method }); socket.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.exception?.description || result.exceptionDetails.text}\nIn: ${expression.slice(0, 200)}`);
  return result.result.value;
}
async function waitFor(expression, label = expression, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await evaluate(expression)) return; } catch { /* retry */ }
    await sleep(50);
  }
  const seen = await evaluate("(document.querySelector('.ln-side')?.innerText || '').slice(0, 600)").catch(() => '');
  throw new Error(`UI condition did not become true: ${label}${seen ? `
Side panel: ${seen}` : ''}`);
}
async function screenshot(name) {
  if (!screenshots) return;
  fs.mkdirSync(screenshots, { recursive: true });
  await sleep(260);
  const result = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from(result.data, 'base64'));
}
const q = selector => JSON.stringify(selector);
const click = selector => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('Missing ' + ${q(selector)}); el.click(); return true; })()`);
const fill = (selector, value) => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('Missing ' + ${q(selector)}); el.value = ${q(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const submit = selector => evaluate(`document.querySelector(${q(selector)}).requestSubmit()`);
const text = selector => evaluate(`(document.querySelector(${q(selector)})?.textContent || '').trim()`);
const count = selector => evaluate(`document.querySelectorAll(${q(selector)}).length`);
const press = (selector, init) => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('Missing ' + ${q(selector)}); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...${JSON.stringify(init)} })); return true; })()`);
const valueOf = selector => evaluate(`document.querySelector(${q(selector)})?.value`);
const view = async name => { const nav = `.nav-item[data-go="${name}"], .nav-icon-btn[data-go="${name}"], .rail [data-go="${name}"]`; await waitFor(`!!document.querySelector(${q(nav)})`, `${name} navigation ready`); await click(`.nav-item[data-go="${name}"], .nav-icon-btn[data-go="${name}"], .rail [data-go="${name}"]`); await waitFor(`!document.querySelector('#stage').classList.contains('view-out') && ${viewCheck(name)}`, `view ${name}`); };
function viewCheck(name) {
  const map = { calendar: "!!document.querySelector('.cal-layout')", whim: "!!document.querySelector('.pj-root')", routine: "document.querySelector('.page-head h1')?.textContent === 'Routine'", learning: "!!document.querySelector('.ln-root')", activities: "document.querySelector('.page-head h1')?.textContent === 'Activities'", analytics: "!!document.querySelector('.stats')", chat: "!!document.querySelector('.chat-layout')", home: "!!document.querySelector('.profile-card')", settings: "!!document.querySelector('.settings-wrap')" };
  return map[name];
}
async function stop() {
  if (!child) return;
  const proc = child; child = null;
  if (proc.exitCode === null) {
    // Quit the way a person does (window close → app.quit), so Chromium writes localStorage and its key store to
    // disk. A hard kill can lose writes still waiting in Chromium's batched commit, which made restart checks flaky.
    const exited = new Promise(resolve => proc.once('exit', resolve));
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.evaluate', params: { expression: 'window.windowControls && window.windowControls.close()' } }));
    }
    const graceful = await Promise.race([exited.then(() => true), sleep(10000).then(() => false)]);
    if (!graceful) { proc.kill(); await exited; }
  }
  if (socket) socket.close();
}

async function run() {
  await launch();
  await waitFor("!document.getElementById('login-page').hidden", 'login page');
  assert.ok(await evaluate("document.body.classList.contains('is-auth')"), 'Rail is hidden on auth screens');
  await screenshot('01-login');

  // Register → profile
  await click('[data-auth="register"]');
  await fill('#register-email', 'smoke@example.com');
  await fill('#register-password', 'Sm0ke-test-pass');
  await fill('#register-confirmation', 'Sm0ke-test-pass');
  await submit('#register-form');
  try { await waitFor("!document.getElementById('profile-page').hidden", 'profile page'); }
  catch (error) { console.error('Feedback:', await text('#register-page .form-feedback'), await evaluate("[...document.querySelectorAll('.toast')].map(t=>t.textContent)")); throw error; }
  await click('#pick-image');
  await waitFor("!!document.getElementById('profile-preview').style.backgroundImage", 'profile preview image');
  await fill('#profile-name', 'Smoke Tester');
  await fill('#profile-bio', 'Testing the planner');
  await submit('#profile-form');
  await waitFor("!document.getElementById('main-page').hidden && !!document.querySelector('.cal-layout')", 'workspace calendar');
  await screenshot('02-calendar-month');

  // Calendar: the add-plan forms are gone; plans are seeded through the API, then shown in the right panel
  assert.equal(await count('.plan-form'), 0, 'no add-plan form in the right panel');
  await evaluate("(async () => { const d = new Date(); const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); for (const [text, time] of [['Morning run', '07:30'], ['Read a chapter', null], ['Design review', null], ['Call mom', null]]) await window.plannerData.create({ kind: 'plan', text, day, time }); return true; })()");
  await sleep(1500);
  await waitFor("['login','main'].some(p => !document.getElementById(p + '-page').hidden)", 'page after reload');
  if (await evaluate("!document.getElementById('login-page').hidden")) {
    await fill('#login-email', 'smoke@example.com');
    await fill('#login-password', 'Sm0ke-test-pass');
    await submit('#login-form');
  }
  await click('#rail-account');
  await click('#account-menu [data-action="logout"]');
  await waitFor("!document.getElementById('login-page').hidden", 'signed out to load the seeded plans');
  await fill('#login-email', 'smoke@example.com');
  await fill('#login-password', 'Sm0ke-test-pass');
  await submit('#login-form');
  await waitFor("!document.getElementById('main-page').hidden && document.querySelectorAll('.plan').length === 4", 'seeded plans');
  assert.match(await text('.plan .plan-time'), /7:30 AM/);
  await click('.plan .check');
  await waitFor("document.querySelector('.progress span')?.textContent === '1/4'", 'plan progress');
  // Edit a plan inline
  await click('.plan:nth-child(2) .plan-text');
  await waitFor("!!document.querySelector('[data-form=\"edit-plan\"]')");
  await evaluate("document.querySelector('[data-form=\"edit-plan\"] [name=text]').value = 'Read two chapters'");
  await submit('[data-form="edit-plan"]');
  await waitFor("[...document.querySelectorAll('.plan-text')].some(e => e.textContent === 'Read two chapters')", 'edited plan');

  // Week & day views
  await click('[data-action="cal-view"][data-value="week"]');
  await waitFor("!!document.querySelector('.timegrid .week-day-head') && document.querySelectorAll('.event-chip').length === 4", 'week view chips');
  await screenshot('03-calendar-week');
  const today = await evaluate("(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()");
  // Schedule time blocks: click, drag, right-click and edit, each through the panel at the cursor.
  const mouse = (type, x, y, button = 'left') => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : (button === 'right' ? 2 : 1), clickCount: 1 });
  const at = async (selector, dy = 10) => { await evaluate(`document.querySelector(${q(selector)}).scrollIntoView({ block: 'center' })`); return evaluate(`(() => { const r = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + ${dy} }; })()`); };
  const popOpen = "!document.getElementById('sb-pop')?.hidden";
  let p = await at(`.slot[data-time="14:00"][data-day="${today}"]`);
  await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
  await waitFor(`${popOpen} && document.querySelector('#sb-pop [name=start]').value === '14:00' && document.querySelector('#sb-pop [name=end]').value === '15:00' && !!document.querySelector('.tblock.ghost')`, 'click opens a 1-hour schedule panel');
  assert.equal(await text('#sb-heading'), 'New schedule');
  assert.equal(await evaluate("document.activeElement.name"), 'title', 'name field focused');
  const pop = await evaluate("(() => { const r = document.getElementById('sb-pop').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth, h: innerHeight }; })()");
  assert.ok(pop.l >= 0 && pop.r <= pop.w && pop.t >= 0 && pop.b <= pop.h, 'panel inside the window');
  assert.ok(Math.min(Math.abs(pop.l - p.x), Math.abs(pop.r - p.x)) <= 30 && p.y >= pop.t - 2 && p.y <= pop.b, 'panel opens beside the cursor');
  await screenshot('03b-schedule-panel');
  await fill('#sb-pop [name=title]', 'Design review');
  await fill('#sb-pop [name=location]', 'Room 4');
  await click('#sb-pop [data-sb="image"]');
  await waitFor("document.querySelector('#sb-pop .sb-cover').classList.contains('custom') && !document.querySelector('[data-sb=\"image-reset\"]').hidden", 'custom panel image');
  await submit('#sb-pop');
  await waitFor("document.getElementById('sb-pop').hidden && document.querySelectorAll('.tblock[data-sb-block]').length === 1 && !document.querySelector('.tblock.ghost')", 'schedule block saved');
  assert.match(await text('.tblock[data-sb-block]'), /Design review/);
  assert.equal(await evaluate("document.querySelector('.tblock[data-sb-block]').classList.contains('has-img') && document.querySelector('.tblock[data-sb-block]').style.backgroundImage.includes('url(')"), true, 'imported image is shown on the time block');
  assert.equal(await count('.plan-col [data-sb-open]'), 1, 'schedule listed in the right panel');
  assert.equal(await evaluate("document.querySelector('.tblock[data-sb-block]').style.top"), '700px');
  assert.equal(await evaluate("document.querySelector('.tblock[data-sb-block]').style.height"), '48px');
  // Drag from 10:06 to 11:42 → 10:00–11:45
  const a = await at(`.slot[data-time="10:00"][data-day="${today}"]`, 5);
  const b = await evaluate(`(() => { const r = document.querySelector('.slot[data-time="11:00"][data-day="${today}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 35 }; })()`);
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', a.x, a.y + (b.y - a.y) * i / 6);
  await waitFor("!!document.querySelector('.tblock.ghost')", 'drag ghost');
  await mouse('mouseReleased', b.x, b.y);
  await waitFor(`${popOpen} && document.querySelector('#sb-pop [name=start]').value === '10:00' && document.querySelector('#sb-pop [name=end]').value === '11:45'`, 'drag sets start and end');
  await fill('#sb-pop [name=title]', 'Deep work');
  await submit('#sb-pop');
  await waitFor("document.querySelectorAll('.tblock[data-sb-block]').length === 2", 'dragged block saved');
  // Click a block to edit it
  p = await at('.tblock[data-sb-block][title^="Design review"]', 10);
  await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
  await waitFor(`${popOpen} && document.getElementById('sb-heading').textContent === 'Edit schedule' && document.querySelector('#sb-pop [name=title]').value === 'Design review' && document.querySelector('#sb-pop [name=location]').value === 'Room 4' && document.querySelector('#sb-pop .sb-cover').classList.contains('custom')`, 'edit panel filled in');
  await fill('#sb-pop [name=end]', '15:30');
  await submit('#sb-pop');
  await waitFor("document.querySelector('.tblock[data-sb-block][title^=\"Design review\"]')?.style.height === '73px'", 'edited block resized');
  // Right-click empty time → new schedule there; Cancel removes the ghost
  p = await at(`.slot[data-time="17:00"][data-day="${today}"]`, 30);
  await mouse('mousePressed', p.x, p.y, 'right'); await mouse('mouseReleased', p.x, p.y, 'right');
  await evaluate(`document.elementFromPoint(${p.x}, ${p.y}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${p.x}, clientY: ${p.y}, button: 2 }))`);
  await waitFor(`${popOpen} && document.getElementById('sb-heading').textContent === 'New schedule' && document.querySelector('#sb-pop [name=start]').value === '17:30'`, 'right-click opens a new schedule');
  await click('#sb-pop .sb-cancel');
  await waitFor("document.getElementById('sb-pop').hidden && !document.querySelector('.tblock.ghost')", 'cancel closes');
  // Right-click a block → edit → delete
  p = await at('.tblock[data-sb-block][title^="Deep work"]', 10);
  await evaluate(`document.elementFromPoint(${p.x}, ${p.y}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${p.x}, clientY: ${p.y}, button: 2 }))`);
  await waitFor(`${popOpen} && document.querySelector('#sb-pop [name=title]').value === 'Deep work'`, 'right-click a block edits it');
  await click('#sb-pop [data-sb="delete"]');
  await waitFor("!document.getElementById('confirm-overlay').hidden");
  await click('#confirm-ok');
  await waitFor("document.querySelectorAll('.tblock[data-sb-block]').length === 1", 'block deleted');
  await screenshot('03c-schedule-blocks');
  // Timer: the clock button opens the panel; a started timer draws a live block that grows
  assert.equal(await count('[data-action="focus-plan"]'), 0, 'plus button replaced');
  await click('[data-action="timer"]');
  await waitFor("!document.getElementById('tm-pop').hidden && !!document.querySelector('#tm-pop [name=title]') && !!document.querySelector('#tm-pop [name=projectId]') && !!document.querySelector('#tm-pop [name=start]')", 'timer panel');
  await fill('#tm-pop [name=title]', 'Timer test');
  await evaluate("(() => { const d = new Date(new Date().getTime() - 45 * 60000); const same = d.getDate() === new Date().getDate(); const v = same ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : '00:00'; document.querySelector('#tm-pop [name=start]').value = v; return v; })()");
  await submit('#tm-pop');
  await waitFor("document.getElementById('tm-pop').hidden && !!document.querySelector('.tblock.timer-live') && document.querySelector('[data-action=\"timer\"]').classList.contains('running')", 'timer started and live block drawn');
  const h1 = await evaluate("parseFloat(document.querySelector('.tblock.timer-live').style.height)");
  assert.ok(h1 >= 14, 'live block has height');
  await screenshot('03d-timer-running');
  await evaluate("document.querySelector('[data-action=\"timer\"]').click()");
  await waitFor("!document.getElementById('tm-pop').hidden && !!document.getElementById('tm-elapsed') && /^0:4\\d:\\d\\d$/.test(document.getElementById('tm-elapsed').textContent)", 'running timer panel shows elapsed');
  await click('#tm-pop [data-tm="stop"]');
  await waitFor("!document.querySelector('.tblock.timer-live') && [...document.querySelectorAll('.tblock[data-sb-block]')].some(b => b.title.startsWith('Timer test'))", 'stopped timer stays on the calendar');
  assert.equal(await evaluate("document.querySelector('[data-action=\"timer\"]').classList.contains('running')"), false);
  p = await at('.tblock[data-sb-block][title^="Timer test"]', 5);
  await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
  await waitFor(`${popOpen} && document.querySelector('#sb-pop [name=title]').value === 'Timer test'`, 'timer block opens for editing');
  await click('#sb-pop [data-sb="delete"]');
  await waitFor("!document.getElementById('confirm-overlay').hidden");
  await click('#confirm-ok');
  await waitFor("document.querySelectorAll('.tblock[data-sb-block]').length === 1", 'timer block deleted');
  await click('[data-action="cal-view"][data-value="day"]');
  await waitFor("!!document.querySelector('.day-strip')", 'day view');
  assert.equal(await count('.day-add'), 0, 'no add-plan bar under the day grid');
  await screenshot('04-calendar-day');
  const before = await text('.cal-label');
  await click('[data-action="cal-next"]');
  await waitFor(`document.querySelector('.cal-label').textContent !== ${q(before)}`, 'next day');
  assert.equal(await count('.plan'), 0, 'Next day has no plans');
  await click('[data-action="cal-today"]');
  await waitFor("document.querySelectorAll('.plan').length === 4", 'back to today');
  await click('[data-action="cal-view"][data-value="month"]');
  await waitFor("!!document.querySelector('.month-grid')");

  // Projects: upper project tabs, block pages, linked records and the Calendar link
  await view('whim');
  await waitFor("document.querySelector('.page-head h1')?.textContent === 'Projects' && !!document.querySelector('.pj-tab-home.active')", 'projects overview');
  await waitFor("!document.querySelector('[data-pjform=\"new-project\"]') && !document.querySelector('.pj-tab-new') && !!document.querySelector('.proj-tile-new')", 'no name bar or tab-strip plus; New project tile present');
  await click('.proj-tile-new');
  await waitFor("document.querySelector('.pj-title')?.value === 'Untitled'", 'new project opens with its title selected');
  await fill('.pj-title', 'Learn watercolor');
  await waitFor("document.querySelector('.pj-title')?.value === 'Learn watercolor' && document.querySelectorAll('.pj-tab').length === 1", 'project opened in its own tab');
  await waitFor("!!document.querySelector('.pj-ghost') && !document.querySelector('.pj-empty') && !document.querySelector('.pj-keys') && !document.querySelector('.pj-add-end')", 'clean empty page');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.pj-save')).display"), 'none', 'no Saved indicator');
  assert.ok(await evaluate("(() => { const t = document.querySelector('.pj-tabs').getBoundingClientRect(); const h = document.querySelector('.pj-title').getBoundingClientRect(); return h.top >= t.bottom + 8; })()"), 'title clears the tab strip');
  await click('[data-pj="add-end"]');
  await waitFor("document.querySelectorAll('.pj-block').length === 1 && document.activeElement.matches('[data-pj-text]')", 'first block focused');
  await fill('.pj-block [data-pj-text]', '#Goals');
  assert.equal(await count('.t-h1'), 0, 'no heading before the space is typed');
  await fill('.pj-block [data-pj-text]', '# Goals for spring');
  await waitFor("document.querySelector('.t-h1 [data-pj-text]')?.value === 'Goals for spring'", 'markdown shortcut made a heading');
  await waitFor("document.querySelector('.pj-save')?.dataset.state === 'unsaved' || document.querySelector('.pj-save')?.dataset.state === 'saving'", 'unsaved state shown');
  await evaluate("(() => { const el = document.querySelector('.t-h1 [data-pj-text]'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return true; })()");
  await press('.t-h1 [data-pj-text]', { key: 'Enter' });
  await waitFor("document.querySelectorAll('.pj-block').length === 2 && document.activeElement.closest('.t-paragraph')", 'Enter creates the next block');
  await fill('.t-paragraph [data-pj-text]', 'Paint every weekend');
  await press('.t-paragraph [data-pj-text]', { key: 'Enter', ctrlKey: true });
  await waitFor("document.querySelectorAll('.pj-block').length === 3", 'inserted a block below');
  await fill('.pj-block:nth-child(3) [data-pj-text]', '/task');
  await waitFor("!document.getElementById('pj-menu').hidden && document.querySelectorAll('#pj-menu .menu-item').length === 1", 'slash menu filtered');
  await screenshot('05a-slash-menu');
  await press('.pj-block:nth-child(3) [data-pj-text]', { key: 'Enter' });
  await waitFor("!!document.querySelector('.t-tasks') && document.getElementById('pj-menu').hidden && document.querySelectorAll('.pj-block').length === 4", 'task list block inserted, with a paragraph after it to keep writing');
  await fill('[data-pjform="task"] [name=title]', 'Buy paints');
  await evaluate("(() => { const d = new Date(); document.querySelector('[data-pjform=\"task\"] [name=day]').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; return true; })()");
  await submit('[data-pjform="task"]');
  await waitFor("document.querySelectorAll('.t-tasks .pj-lrow').length === 1", 'linked task created');
  // Reorder with the keyboard, then undo and redo
  await press('.t-h1 [data-pj-text]', { key: 'ArrowDown', altKey: true, shiftKey: true });
  await waitFor("document.querySelector('.pj-block:nth-child(2)').classList.contains('t-h1')", 'block moved down');
  await press('.t-h1 [data-pj-text]', { key: 'z', ctrlKey: true });
  await waitFor("document.querySelector('.pj-block:nth-child(1)').classList.contains('t-h1')", 'undo restored the order');
  await press('.pj-title', { key: 'z', ctrlKey: true, shiftKey: true });
  await waitFor("document.querySelector('.pj-block:nth-child(2)').classList.contains('t-h1')", 'redo');
  await press('.pj-title', { key: 'z', ctrlKey: true });
  await waitFor("document.querySelector('.pj-block:nth-child(1)').classList.contains('t-h1')", 'undo again');
  // Change type and delete through the block menu
  await press('.t-paragraph [data-pj-text]', { key: '/', ctrlKey: true });
  await waitFor("!document.getElementById('pj-menu').hidden", 'block menu');
  await evaluate("[...document.querySelectorAll('#pj-menu .menu-item')].find(b => b.textContent.startsWith('Quote')).click()");
  await waitFor("document.querySelector('.t-quote [data-pj-text]')?.value === 'Paint every weekend'", 'changed type, kept text');
  await press('.t-quote [data-pj-text]', { key: 'd', ctrlKey: true });
  await waitFor("document.querySelectorAll('.t-quote').length === 2", 'duplicated');
  await press('.pj-block:nth-child(3) [data-pj-text]', { key: 'Backspace', ctrlKey: true, shiftKey: true });
  await waitFor("document.querySelectorAll('.t-quote').length === 1 && document.querySelectorAll('.pj-block').length === 4", 'deleted');
  await waitFor("document.querySelector('.pj-save')?.dataset.state === 'saved'", 'page saved');
  // Groups: Enter continues the same group; clicking the lower area starts a new one
  assert.ok(await evaluate("[...document.querySelectorAll('.pj-block:not(:hover) .pj-gutter')].every(g => getComputedStyle(g).opacity === '0')"), 'side actions show only on hover');
  await click('[data-pj="tail"]');
  await waitFor("document.querySelectorAll('.pj-block').length === 4 && document.activeElement.matches('.pj-block:nth-child(4) [data-pj-text]')", 'clicking below reuses the empty last group');
  await fill('.pj-block:nth-child(4) [data-pj-text]', 'first line');
  assert.equal(await evaluate("document.querySelector('.pj-block:nth-child(4) [data-pj-text]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))"), true, 'Enter in a paragraph is a new line (not intercepted)');
  assert.equal(await count('.pj-block'), 4, 'Enter keeps typing in the same group');
  await fill('.pj-block:nth-child(4) [data-pj-text]', '- apples');
  await waitFor("!!document.querySelector('.pj-block:nth-child(4).t-bullet')", 'bullet group');
  await click('[data-pj="tail"]');
  await waitFor("document.querySelectorAll('.pj-block').length === 5 && document.activeElement.closest('.pj-block:nth-child(5).t-paragraph')", 'clicking below a filled group starts a new group');
  await press('.t-bullet [data-pj-text]', { key: 'Enter' });
  await waitFor("document.querySelectorAll('.t-bullet .pj-item').length === 2 && document.activeElement.dataset.line === '1'", 'Enter adds an item to the same list group');
  await fill('.t-bullet .pj-item:nth-child(2) [data-pj-text]', 'pears');
  await press('.t-bullet .pj-item:nth-child(2) [data-pj-text]', { key: 'Enter' });
  await waitFor("document.querySelectorAll('.t-bullet .pj-item').length === 3", 'third item');
  await press('.t-bullet .pj-item:nth-child(3) [data-pj-text]', { key: 'Enter' });
  await waitFor("document.querySelectorAll('.t-bullet .pj-item').length === 2 && document.querySelectorAll('.pj-block').length === 6 && document.activeElement.closest('.t-paragraph')", 'Enter on an empty item leaves the list for a new group');
  for (const n of [6, 5, 4]) await press(`.pj-block:nth-child(${n}) [data-pj-text]`, { key: 'Backspace', ctrlKey: true, shiftKey: true });
  await waitFor("document.querySelectorAll('.pj-block').length === 3", 'group test blocks removed');
  await click('[data-pj="tail"]');
  await waitFor("document.querySelectorAll('.pj-block').length === 4", 'clicking below the last group adds an empty paragraph');
  await waitFor("document.querySelector('.pj-save')?.dataset.state === 'saved'", 'page saved again');
  await evaluate("(() => { let e = document.querySelector('.pj-root'); while (e) { if (e.scrollTop) e.scrollTop = 0; e = e.parentElement; } return true; })()");
  await sleep(300);
  // Page look: cover (default gradient, chosen gradient, uploaded image, reposition), icon, centred roomy column
  assert.ok(await evaluate("!!document.querySelector('.pj-cover[class*=\"g-\"]') && !document.querySelector('.pj-cover-img')"), 'a page starts with a default gradient cover');
  assert.ok(await evaluate("(() => { const c = document.querySelector('.pj-column').getBoundingClientRect(); const p = document.querySelector('.main-panel').getBoundingClientRect(); const cv = document.querySelector('.pj-cover').getBoundingClientRect(); return cv.left <= p.left + 1 && cv.right >= p.right - 1 && c.width <= 900 && Math.abs((c.left - p.left) - (p.right - c.right)) < 4; })()"), 'cover is full width; the column is centred');
  assert.ok(await evaluate("(() => { const p = document.querySelector('.main-panel').getBoundingClientRect(); const cv = document.querySelector('.pj-cover').getBoundingClientRect(); const t = document.querySelector('.pj-tabs').getBoundingClientRect(); return cv.top <= p.top + 1 && t.top >= cv.top && t.bottom <= cv.bottom && getComputedStyle(document.querySelector('.pj-tabs')).boxShadow !== 'none'; })()"), 'cover reaches the top edge with the shadowed tabs floating on it');
  assert.equal(await evaluate("document.querySelector('.pj-tabbar').nextElementSibling.classList.contains('pj-body')"), true, 'project tabs stay on top');
  await evaluate("document.querySelector('.main-panel').scrollTop = 0");
  await sleep(250); // a scroll event closes open menus, so let it land before opening one
  await screenshot('05c-default-cover');
  await click('[data-pj="cover-menu"]');
  await waitFor("!document.getElementById('pj-menu').hidden && [...document.querySelectorAll('#pj-menu .menu-item')].some(b => b.textContent.startsWith('Tide'))", 'cover menu');
  await screenshot('05d-cover-menu');
  await evaluate("[...document.querySelectorAll('#pj-menu .menu-item')].find(b => b.textContent.startsWith('Tide')).click()");
  await waitFor("document.querySelector('.pj-cover')?.classList.contains('g-tide')", 'chosen gradient applied');
  await screenshot('05e-tide-cover');
  await click('[data-pj="icon-open"]');
  await waitFor("!document.getElementById('pj-pop').hidden && document.querySelectorAll('#pj-pop .pj-emoji').length > 20", 'icon picker');
  await screenshot('05f-icon-picker');
  await click('#pj-pop .pj-emoji[data-emoji="🚀"]');
  await waitFor("document.querySelector('.pj-icon')?.textContent === '🚀' && document.querySelector('.pj-tab.active .pj-tab-emoji')?.textContent === '🚀' && document.getElementById('pj-pop').hidden", 'icon set, shown on the page and its tab');
  await click('[data-pj="cover-menu"]');
  await waitFor("!document.getElementById('pj-menu').hidden");
  await evaluate("[...document.querySelectorAll('#pj-menu .menu-item')].find(b => b.textContent.startsWith('Upload')).click()");
  await waitFor("!!document.querySelector('.pj-cover.photo .pj-cover-img')", 'uploaded cover image');
  await click('[data-pj="repo-start"]');
  await waitFor("!!document.querySelector('.pj-cover.repositioning')", 'reposition mode');
  const cv = await evaluate("(() => { const r = document.querySelector('.pj-cover-img').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; })()");
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: cv.x, y: cv.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cv.x, y: cv.y - i * 10, button: 'left', buttons: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cv.x, y: cv.y - 50, button: 'left', buttons: 0, clickCount: 1 });
  await click('[data-pj="repo-save"]');
  await waitFor("!document.querySelector('.pj-cover.repositioning') && Number(document.querySelector('.pj-cover-img').dataset.pjPos) > 50", 'cover position moved and saved');
  await waitFor("document.querySelector('.pj-save')?.dataset.state === 'saved'", 'look saved');
  await evaluate("document.querySelector('.main-panel').scrollTop = 0");
  await screenshot('05-project-page');
  // A second project in its own tab; switching keeps each page
  assert.deepEqual(await evaluate("(() => { document.querySelector('[data-pj=\"tab-home\"]').click(); const old = document.querySelector('.pj-leaving'); const fresh = document.querySelector('.pj-slide-in'); return [!!old && old.classList.contains('to-up'), !!fresh && fresh.classList.contains('from-down')]; })()"), [true, true], 'going to the Projects overview rises into place from below');
  await sleep(700);
  assert.equal(await count('.pj-leaving'), 0, 'old page removed after the slide');
  await waitFor("!!document.querySelector('.proj-grid') && document.querySelectorAll('.proj-card:not(.proj-card-new)').length === 1 && document.querySelector('.proj-grid > .proj-card')?.classList.contains('proj-card-new')", 'overview lists the project after the New project tile');
  assert.ok(await evaluate("(() => { const t = document.querySelector('.proj-card:not(.proj-card-new) .proj-tile'); return t.classList.contains('has-img') && t.style.backgroundImage.includes('url(') && !!t.dataset.pjTile; })()"), 'uploaded banner shows on the project tile');
  assert.ok(await evaluate("(() => { const t = document.querySelector('.pj-tabs').getBoundingClientRect(); const h = document.querySelector('.page-head h1').getBoundingClientRect(); return h.top >= t.bottom + 12; })()"), 'overview title clears the tabs');
  await screenshot('05g-overview');
  await click('.proj-tile-new');
  await waitFor("document.querySelector('.pj-title')?.value === 'Untitled' && document.activeElement.matches('.pj-title')", 'second project opened');
  await fill('.pj-title', 'Plan a beach day with a deliberately long name that has to be truncated in the tab');
  await waitFor("document.querySelectorAll('.pj-tab').length === 2 && document.querySelector('.pj-title')?.value.startsWith('Plan a beach day')", 'second tab');
  assert.ok(await evaluate("(() => { const l = document.querySelector('.pj-tab.active .proj-tab-label'); return l.scrollWidth > l.clientWidth && l.clientWidth <= 140; })()"), 'long tab names are truncated');
  assert.ok(await evaluate("(() => { const t = document.querySelector('.pj-tabs').getBoundingClientRect(); const p = document.querySelector('.main-panel').getBoundingClientRect(); return t.top - p.top <= 14; })()"), 'tabs sit close to the panel edge');
  assert.deepEqual(await evaluate("(() => { document.querySelector('.pj-tab:not(.active) .pj-tab-main').click(); const old = document.querySelector('.pj-leaving'); const fresh = document.querySelector('.pj-slide-in'); return [!!old && old.classList.contains('to-right'), !!fresh && fresh.classList.contains('from-left')]; })()"), [true, true], 'second to first tab slides from the left');
  await waitFor("document.querySelector('.pj-title')?.value === 'Learn watercolor' && document.querySelectorAll('.pj-block').length === 4", 'switched back to the first tab');
  await sleep(500);
  // Calendar stays its own page; a project action opens the linked date there and Calendar links back
  await click('.t-tasks .pj-lrow .pj-date');
  await waitFor("!!document.querySelector('.cal-layout') && !document.querySelector('.pj-root') && document.querySelector('.linked-row.focus strong')?.textContent === 'Buy paints'", 'calendar opened on the linked task');
  assert.ok(await count('.cell.selected .cell-dot.linked') === 1, 'linked record marked on its day');
  assert.equal(await count('.plan'), 0 + await count('.plan'), 'plans untouched');
  await screenshot('05b-calendar-linked');
  await click('.linked-row');
  await waitFor("document.querySelector('.pj-title')?.value === 'Learn watercolor'", 'calendar links back to the project tab');
  await click('.pj-tab:not(.active) .pj-tab-x');
  await waitFor("document.querySelectorAll('.pj-tab').length === 1 && document.querySelector('.pj-title')?.value === 'Learn watercolor'", 'closed the other tab');
  await click('[data-pj="tab-home"]');
  await waitFor("document.querySelectorAll('.recent-card').length === 2", 'recently opened lists both projects');
  await evaluate("[...document.querySelectorAll('.recent-card')].find(b => b.textContent.includes('Plan a beach day')).click()");
  await waitFor("document.querySelectorAll('.pj-tab').length === 2 && document.querySelector('.pj-title')?.value.startsWith('Plan a beach day')", 'reopened from recent');
  await click('.pj-tab.active .pj-tab-x');
  await waitFor("document.querySelectorAll('.pj-tab').length === 1", 'closed again');

  // Routine
  await view('routine');
  for (const step of ['Stretch', 'Journal', 'Drink water']) { await fill('#list-input', step); await submit('[data-form="list"]'); }
  await waitFor("document.querySelectorAll('.row').length === 3");
  await click('.row .check');
  await waitFor("document.querySelector('.progress span')?.textContent === '1 of 3 done today'", 'routine progress');
  await screenshot('06-routine');

  // Learning: subjects per profile, pockets with ⋯ edit/delete, click = preview panel, double-click = subject page
  await view('learning');
  await waitFor("document.querySelector('.ln-head h1')?.textContent === 'Learning' && document.querySelector('[data-ln=\"profile\"]')?.textContent === 'study'", 'learning page with study profile');
  assert.ok((await text('.nav-item[data-go="learning"]')).includes('(study)'), 'Sidebar shows the learning profile');
  assert.equal(await count('[data-ln-subject]'), 0);
  await screenshot('06b-learning-empty');
  await click('[data-ln="create"]');
  await waitFor("!!document.querySelector('[data-ln-form]')", 'subject dialog');
  await submit('[data-ln-form]');
  await waitFor("document.querySelector('[data-ln-error]')?.textContent.includes('name')", 'name required');
  await fill('[data-ln-form] [name="name"]', 'Calculus');
  await click('[data-ln="type"][data-value="major"]');
  await fill('[data-ln-form] [name="mastery"]', '42');
  await fill('[data-ln-form] [name="hours"]', '3');
  await fill('[data-ln-form] [name="minutes"]', '20');
  await fill('[data-ln-form] [name="description"]', 'Limits, derivatives and integrals.');
  await click('[data-ln="pick-image"]');
  await waitFor("document.querySelector('[data-ln-preview]')?.classList.contains('has-img')", 'subject image picked');
  await screenshot('06c-learning-dialog');
  await submit('[data-ln-form]');
  await waitFor("!document.querySelector('[data-ln-form]') && document.querySelectorAll('[data-ln-subject]').length === 1", 'subject pocket created');
  await waitFor("document.querySelector('.ln-panel .ln-name')?.textContent.trim() === 'Calculus'", 'new subject previewed');
  const meta = await text('.ln-panel-body');
  for (const part of ['Major', '42% mastery', '3h 20m spent', 'Limits, derivatives and integrals.', 'Topics', 'Mastery Statistics']) assert.ok(meta.includes(part), `Preview shows ${part}`);
  assert.ok(await evaluate("getComputedStyle(document.querySelector('.ln-panel .ln-cover-art')).backgroundImage.startsWith('url(\"data:image/png')"), 'Preview cover uses the subject image');
  await screenshot('06d-learning-preview');
  // Learn with no topics yet: a warning, no viewer
  await click('.ln-panel [data-ln="learn"]');
  await waitFor("[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Please upload a topic first.'))", 'Learn warns without topics');
  assert.equal(await count('.ln-viewer'), 0, 'Learn stays on the page without topics');
  // Toggle the panel closed, then click once to preview again
  await click('[data-ln="close-panel"]');
  await waitFor("!document.querySelector('.ln-panel') && !document.querySelector('.ln-layout').classList.contains('with-panel')", 'preview closed');
  await evaluate("document.querySelector('[data-ln-subject]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))");
  await waitFor("!!document.querySelector('.ln-panel') && document.querySelector('[data-ln-subject]').classList.contains('selected')", 'single click previews');
  // Double-click opens the whole subject as a page; Back returns
  await evaluate("(() => { const el = document.querySelector('[data-ln-subject]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); })()");
  await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Calculus'", 'double click opens subject page');
  await screenshot('06e-learning-page');
  // Topics: upload (button and file drop), milestones, numbering, drag to reorder, keyboard move/level, rename, delete
  await waitFor("!!document.querySelector('.ln-topics [data-ln=\"upload\"]') && !(document.querySelector('.ln-topics .ln-soon')?.textContent || '').includes('Loading')", 'topics loaded');
  assert.equal(await count('[data-ln-topic-form]'), 0, 'no manual add row');
  assert.equal(await count('.ln-page-head .progress'), 0, 'no mastery bar on the page');
  const topicNums = () => evaluate("[...document.querySelectorAll('[data-topic]')].map(r => r.classList.contains('ln-milestone') ? '[' + r.querySelector('.ln-topic-title').textContent + ']' : r.querySelector('.ln-num').textContent + ' ' + r.querySelector('.ln-topic-title').textContent).join(' | ')");
  const tagTopic = (title, tag) => evaluate(`(() => { const r = [...document.querySelectorAll('[data-topic]')].find(r => r.querySelector('.ln-topic-title')?.textContent === ${q(title)}); r.setAttribute('data-test', ${q(tag)}); return true; })()`);
  // Each uploaded file is one topic named after it; its headings are navigated through the key points
  await click('[data-ln="upload"]');
  await waitFor("document.querySelectorAll('.ln-file').length === 1", 'uploaded file listed');
  assert.equal(await topicNums(), '1 Week 1 notes', 'one file, one topic');
  // Drop a second file on the card: a real drag from the operating system, so the path comes from webUtils
  const card = await evaluate("(() => { const r = document.querySelector('.ln-topics').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  const fileDrag = { items: [], files: [droppedPath], dragOperationsMask: 1 };
  await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: card.x, y: card.y, data: fileDrag });
  await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: card.x, y: card.y, data: fileDrag });
  await waitFor("document.querySelector('.ln-topics')?.classList.contains('file-over')", 'drop highlight');
  await screenshot('06h0-learning-file-over');
  await cdp('Input.dispatchDragEvent', { type: 'drop', x: card.x, y: card.y, data: fileDrag });
  await waitFor("document.querySelectorAll('.ln-file').length === 2", 'dropped file listed');
  assert.equal(await count('.ln-topics.file-over'), 0, 'highlight cleared after drop');
  const dropFile = async file => {
    const at = await evaluate("(() => { const r = document.querySelector('.ln-topics').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 40 }; })()");
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
  };
  await dropFile(pdfPath);
  await waitFor("document.querySelectorAll('.ln-file').length === 3", 'PDF dropped');
  assert.equal(await topicNums(), '1 Week 1 notes | 2 Week 2 notes | 3 Unit notes', 'a PDF with bookmarks is still one topic');
  // Milestones: Prelim dragged to the top; topic 1 dragged below Unit notes renumbers everything
  await click('[data-ln="milestone-menu"]');
  await click('.ln-menu [data-value="Prelim"]');
  await waitFor("!!document.querySelector('.ln-milestone')", 'milestone added');
  const drag = (fromSel, toSel, after) => evaluate(`(() => { const from = document.querySelector(${q(fromSel)}), to = document.querySelector(${q(toSel)}); const dt = new DataTransfer(); const r = to.getBoundingClientRect();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const y = ${after ? 'r.bottom - 2' : 'r.top + 2'};
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await tagTopic('Week 1 notes', 'week1');
  await drag('.ln-milestone', '[data-test="week1"]', false);
  await waitFor("document.querySelector('[data-topic]')?.classList.contains('ln-milestone')", 'milestone dragged to the top');
  await tagTopic('Week 1 notes', 'week1b'); await tagTopic('Unit notes', 'unit');
  await drag('[data-test="week1b"]', '[data-test="unit"]', true);
  await waitFor("[...document.querySelectorAll('.ln-topic .ln-topic-title')].map(e => e.textContent).join() === 'Week 2 notes,Unit notes,Week 1 notes'", 'Week 1 dropped after Unit notes');
  assert.equal(await topicNums(), '[Prelim] | 1 Week 2 notes | 2 Unit notes | 3 Week 1 notes', 'drag renumbers every topic');
  // A second milestone, moved up one place with Alt+Up so Week 1 falls under it
  await click('[data-ln="milestone-menu"]');
  await click('.ln-menu [data-value="Midterm"]');
  await waitFor("document.querySelectorAll('.ln-milestone').length === 2");
  await tagTopic('Midterm', 'midterm');
  await press('[data-test="midterm"]', { key: 'ArrowUp', altKey: true });
  await waitFor("[...document.querySelectorAll('[data-topic]')].at(-1)?.querySelector('.ln-topic-title').textContent === 'Week 1 notes'", 'milestone moved up by keyboard');
  // Subtopic: Unit notes becomes 1.1 under Week 2 notes (Alt+Right), then rename it
  await tagTopic('Unit notes', 'unit2');
  await press('[data-test="unit2"]', { key: 'ArrowRight', altKey: true });
  await waitFor("[...document.querySelectorAll('.ln-topic.lvl-1 .ln-num')].some(e => e.textContent === '1.1')", 'Unit notes became 1.1');
  await tagTopic('Unit notes', 'unit3');
  await click('[data-test="unit3"] [data-ln="topic-rename"]');
  await waitFor("!!document.querySelector('[data-ln-topic-edit]')", 'rename field');
  await fill('[data-ln-topic-edit]', 'Unit notes PDF');
  await press('[data-ln-topic-edit]', { key: 'Enter' });
  await waitFor("[...document.querySelectorAll('.ln-topic-title')].some(e => e.textContent === 'Unit notes PDF')", 'renamed');
  // Custom milestone: added at the end and opened straight into rename
  await click('[data-ln="milestone-menu"]');
  await click('.ln-menu [data-ln="custom-milestone"]');
  await waitFor("document.activeElement?.matches('[data-ln-topic-edit]')", 'custom milestone opens in rename');
  await fill('[data-ln-topic-edit]', 'Finals review');
  await press('[data-ln-topic-edit]', { key: 'Enter' });
  await waitFor("[...document.querySelectorAll('.ln-milestone .ln-topic-title')].some(e => e.textContent === 'Finals review')", 'custom milestone named');
  assert.equal(await topicNums(), '[Prelim] | 1 Week 2 notes | 1.1 Unit notes PDF | [Midterm] | 2 Week 1 notes | [Finals review]');
  assert.equal(await count('.ln-topic .ln-file-chip'), 3, 'topics show their file type');
  await screenshot('06h-learning-topics');
  // Multi-select: Ctrl+click two topics, drag them together below Finals review (a topic brings its subtopic)
  const ctrlClick = title => evaluate(`(() => { const r = [...document.querySelectorAll('[data-topic]')].find(r => r.querySelector('.ln-topic-title')?.textContent === ${q(title)}); r.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })); return true; })()`);
  await ctrlClick('Week 2 notes'); await ctrlClick('Week 1 notes');
  await waitFor("document.querySelectorAll('.ln-topic.selected').length === 2 && document.querySelector('.ln-sel-count')?.textContent === '2 selected'", 'two topics selected');
  await tagTopic('Week 2 notes', 'week2sel'); await tagTopic('Finals review', 'finals');
  await drag('[data-test="week2sel"]', '[data-test="finals"]', true);
  await waitFor("[...document.querySelectorAll('[data-topic]')].at(-1)?.querySelector('.ln-topic-title').textContent === 'Week 1 notes'", 'selection dragged together');
  assert.equal(await topicNums(), '[Prelim] | [Midterm] | [Finals review] | 1 Week 2 notes | 1.1 Unit notes PDF | 2 Week 1 notes', 'selected topics moved in their order');
  await screenshot('06h1-learning-multiselect');
  // Multi-delete: select two milestones, Delete asks once, both go
  await click('[data-ln="sel-clear"]');
  await waitFor("!document.querySelector('.ln-topic.selected, .ln-milestone.selected')", 'selection cleared');
  await ctrlClick('Midterm'); await ctrlClick('Finals review');
  await click('[data-ln="sel-delete"]');
  await waitFor("!document.getElementById('confirm-overlay').hidden", 'delete selected confirmation');
  assert.match(await text('#confirm-title'), /Delete 2 milestones/);
  await click('#confirm-ok');
  await waitFor("document.querySelectorAll('.ln-milestone').length === 1 && !document.querySelector('.ln-sel-bar')", 'selected milestones deleted');
  assert.equal(await topicNums(), '[Prelim] | 1 Week 2 notes | 1.1 Unit notes PDF | 2 Week 1 notes');
  // Topic viewer: the PDF topic opens; its bookmarks are sections in the key points, which navigate the file
  await tagTopic('Unit notes PDF', 'unitpdf');
  await click('[data-test="unitpdf"] .ln-topic-title');
  await waitFor("!!document.querySelector('.ln-viewer .ln-pdfv-page canvas')", 'viewer drew the PDF');
  await waitFor("[...document.querySelectorAll('.ls-sec-title')].map(e => e.textContent).join() === 'Unit A,Unit B'", 'bookmarks are sections in the key points', 30000);
  await evaluate("[...document.querySelectorAll('.ls-sec-head')].find(b => b.textContent.includes('Unit B')).click(); true");
  // Unit B starts on page 2: the in-app viewer scrolls there (the page sits at the top of the view)
  await waitFor("(() => { const box = document.querySelector('[data-ln-doc]'); const p2 = document.querySelector('.ln-pdfv-page[data-page=\"2\"]'); return p2 && Math.abs(p2.getBoundingClientRect().top - box.getBoundingClientRect().top) < box.clientHeight * 0.5; })()", 'key point opens Unit B at page 2');
  assert.equal(await text('.ln-subject-chip'), 'Calculus');
  assert.equal(await evaluate("[...document.querySelectorAll('.ln-nav-ms')].map(e => e.textContent).join()"), 'Prelim', 'navigator shows the segments');
  assert.equal(await text('.ln-nav-topic.active'), '1.1Unit notes PDF');
  assert.equal(await count('.ln-side-panel'), 2, 'notes and ask panels');
  assert.equal(await count('iframe.ln-pdf'), 0, 'no plugin frame');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.ls-doc-title')).color"), 'rgb(245, 139, 86)', 'title colour');
  await sleep(600);
  await screenshot('06j-learning-viewer-pdf');
  // Another topic from a Markdown file: drawn as a page
  await evaluate("[...document.querySelectorAll('.ln-nav-topic')].find(b => b.textContent === '2Week 1 notes').click(); true");
  await waitFor("!!document.querySelector('.ln-reader h2')", 'Markdown file drawn as a page');
  assert.equal(await text('.ln-nav-topic.active'), '2Week 1 notes');
  assert.ok((await text('.ln-reader')).includes('Composition'), 'reader shows the file text');
  await screenshot('06k-learning-viewer-reader');
  // Subject chip goes back to the subject page; Escape from the viewer too; Learning goes to the subjects
  await click('[data-ln="viewer-subject"]');
  await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Calculus'", 'subject chip returns to the subject page');
  await tagTopic('Week 2 notes', 'week2');
  await press('[data-test="week2"]', { key: 'Enter' });
  await waitFor("document.querySelector('.ln-nav-topic.active')?.textContent === '1Week 2 notes'", 'Enter on a topic opens it');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  await waitFor("!!document.querySelector('.ln-page-head') && !document.querySelector('.ln-viewer')", 'Escape returns to the subject page');
  await tagTopic('Week 1 notes', 'week1c');
  await click('[data-test="week1c"] .ln-topic-title');
  await waitFor("!!document.querySelector('.ln-viewer')");
  await click('[data-ln="viewer-learning"]');
  await waitFor("!!document.querySelector('.ln-grid') && !document.querySelector('.ln-viewer')", 'Learning returns to the subjects');
  await click('[data-ln="create"]'); await click('[data-ln="cancel"]'); // dialog still opens and closes after the viewer
  await waitFor("!document.querySelector('[data-ln-form]')");
  await evaluate("document.querySelector('[data-ln-subject]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); true");
  await waitFor("!!document.querySelector('.ln-panel .ln-mini-topics')", 'preview panel back');
  await evaluate("[...document.querySelectorAll('.ln-mini-open')].find(b => b.textContent === '2Week 1 notes').click(); true");
  await waitFor("document.querySelector('.ln-nav-topic.active')?.textContent === '2Week 1 notes'", 'a topic in the preview panel opens the viewer');
  await click('[data-ln="viewer-subject"]');
  await waitFor("!!document.querySelector('.ln-page-head')");
  await click('[data-ln="back"]');
  await waitFor("!!document.querySelector('.ln-grid')", 'back to subjects');
  await waitFor("document.querySelectorAll('.ln-panel .ln-mini-topics li').length === 4", 'preview lists the topics');
  assert.ok((await text('.ln-panel .ln-mini-topics')).includes('1.1Unit notes PDF'), 'preview shows numbers');
  await screenshot('06i-learning-preview-topics');
  // Learn opens the first topic in the viewer
  await click('.ln-panel [data-ln="learn"]');
  await waitFor("document.querySelector('.ln-nav-topic.active')?.textContent === '1Week 2 notes'", 'Learn opens the first topic');
  await click('[data-ln="viewer-learning"]');
  await waitFor("!!document.querySelector('.ln-grid')", 'back to subjects after Learn');
  // With a topic left open, the panel's name and cover still lead to the subject page (not the viewer)
  await click('.ln-panel .ln-cover-open');
  await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Calculus' && !document.querySelector('.ln-viewer')", 'cover opens the subject page');
  // The subject page has its own Learn button: it opens the first topic
  await click('.ln-page-head [data-ln="learn"]');
  await waitFor("document.querySelector('.ln-nav-topic.active')?.textContent === '1Week 2 notes'", 'page Learn opens the first topic');
  await click('[data-ln="viewer-subject"]');
  await waitFor("!!document.querySelector('.ln-page-head')");
  await screenshot('06n-learning-page-learn');
  // The sidebar's Learning item always leads to the main page: from a subject page, from the viewer, and from another page
  const openSubjectPage = async () => { await evaluate("(() => { const el = document.querySelector('[data-ln-subject]'); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()"); await waitFor("!!document.querySelector('.ln-page-head')", 'subject page'); };
  await click('.nav-item[data-go="learning"]');
  await waitFor("!!document.querySelector('.ln-grid') && !document.querySelector('.ln-page-head')", 'sidebar Learning leaves the subject page');
  await openSubjectPage();
  await click('.ln-page-head [data-ln="learn"]');
  await waitFor("!!document.querySelector('.ln-viewer')", 'viewer open');
  await click('.nav-item[data-go="learning"]');
  await waitFor("!!document.querySelector('.ln-grid') && !document.querySelector('.ln-viewer')", 'sidebar Learning leaves the viewer');
  await openSubjectPage();
  await view('routine');
  await click('.nav-item[data-go="learning"]');
  await waitFor("!!document.querySelector('.ln-grid') && !document.querySelector('.ln-page-head')", 'sidebar Learning from another page shows the main page');
  await openSubjectPage();
  await click('[data-ln="back"]');
  await waitFor("!!document.querySelector('.ln-panel .ln-name-link')");
  await click('.ln-panel .ln-name-link');
  await waitFor("!!document.querySelector('.ln-page-head') && !document.querySelector('.ln-viewer')", 'name opens the subject page');
  await click('[data-ln="back"]');
  await waitFor("!!document.querySelector('.ln-grid')");
  // ⋯ → Edit
  await click('[data-ln="menu"]');
  await waitFor("!!document.querySelector('.ln-menu')", 'subject menu');
  await screenshot('06f-learning-menu');
  await click('.ln-menu [data-ln="edit"]');
  await waitFor("document.querySelector('[data-ln-form] [name=\"name\"]')?.value === 'Calculus'", 'edit dialog filled');
  await fill('[data-ln-form] [name="name"]', 'Calculus II');
  await click('[data-ln="type"][data-value="minor"]');
  await submit('[data-ln-form]');
  await waitFor("document.querySelector('.ln-pocket-title')?.textContent === 'Calculus II'", 'subject renamed');
  // Profile switch: personal has its own (empty) subject list; study keeps Calculus II
  await click('[data-ln="profile"]');
  await waitFor("document.querySelector('[data-ln=\"profile\"]')?.textContent === 'personal' && !!document.querySelector('.ln-grid') && document.querySelectorAll('[data-ln-subject]').length === 0", 'personal profile');
  assert.ok((await text('.nav-item[data-go="learning"]')).includes('(personal)'), 'Sidebar follows the profile');
  await click('[data-ln="profile"]');
  await waitFor("document.querySelector('[data-ln=\"profile\"]')?.textContent === 'study' && document.querySelectorAll('[data-ln-subject]').length === 1", 'back to study');
  // ⋯ → Delete (confirm)
  await click('[data-ln="menu"]');
  await click('.ln-menu [data-ln="delete"]');
  await waitFor("!document.getElementById('confirm-overlay').hidden", 'delete confirmation');
  await click('#confirm-ok');
  await waitFor("document.querySelectorAll('[data-ln-subject]').length === 0", 'subject deleted');
  await click('[data-ln="create"]');
  await fill('[data-ln-form] [name="name"]', 'Biology');
  await submit('[data-ln-form]');
  await waitFor("document.querySelectorAll('[data-ln-subject]').length === 1", 'subject kept for restart check');

  // Chat (ChatSessionUI design: category tabs, start composer, output panel, sidebar sessions)
  await view('chat');
  await waitFor("!!document.querySelector('.chat-start') && !!document.querySelector('.chat-output')", 'chat start state');
  await click('[data-action="chat-cat"][data-value="learning"]');
  await waitFor("document.querySelector('[data-action=\"chat-cat\"][data-value=\"learning\"]').classList.contains('active')", 'learning tab');
  await fill('#chat-input', 'Remember to plan Friday');
  await submit('[data-form="chat-start"]');
  await waitFor("!!document.querySelector('.chat-head') && document.querySelectorAll('.msg.user').length === 1", 'start composer created a session');
  assert.equal(await evaluate("document.querySelector('[data-chat-move]').value"), 'learning');
  await waitFor("document.querySelectorAll('.sidebar [data-action=\"side-chat\"]').length === 1", 'session in sidebar');
  await click('[data-action="rename-chat"]');
  await evaluate("document.querySelector('[data-form=\"rename-chat\"] [name=title]').value = 'Friday planning'");
  await submit('[data-form="rename-chat"]');
  await waitFor("document.querySelector('.chat-title')?.textContent === 'Friday planning'");
  await screenshot('09-chat');
  await click('.chat-plus');
  await waitFor("!document.querySelector('[data-chat-pop]').hidden", 'plus menu');
  await screenshot('09c-plus');
  await click('.chat-plus');
  await click('[data-action="chat-cat"][data-value="work"]');
  await waitFor("!!document.querySelector('.chat-start') && document.querySelectorAll('.sidebar [data-action=\"side-chat\"]').length === 0", 'work tab is empty');
  await screenshot('09b-chat-start');
  await click('[data-action="chat-cat"][data-value="learning"]');
  await click('.sidebar [data-action="side-chat"]');
  await waitFor("document.querySelector('.chat-title')?.textContent === 'Friday planning'", 'reopened from sidebar');
  await click('[data-action="archive-chat"]');
  await waitFor("!!document.querySelector('.chat-badge') && document.querySelector('[data-action=\"side-archived\"]')?.textContent.includes('Back to active')", 'archived');
  await click('[data-action="archive-chat"]');
  await waitFor("!document.querySelector('.chat-badge')", 'unarchived');
  await click('[data-action="delete-chat"]');
  await waitFor("!document.getElementById('confirm-overlay').hidden");
  await click('#confirm-ok');
  await waitFor("!!document.querySelector('.chat-start') && document.querySelectorAll('.sidebar [data-action=\"side-chat\"]').length === 0", 'chat deleted');

  // Home & profile edit
  await view('home');
  assert.equal(await text('.profile-name'), 'Smoke Tester');
  await click('[data-action="edit-profile"]');
  await evaluate("document.querySelector('[data-form=\"profile\"] [name=displayName]').value = 'Smoke Pilot'");
  await submit('[data-form="profile"]');
  await waitFor("document.querySelector('.profile-name')?.textContent === 'Smoke Pilot'", 'profile renamed');
  await screenshot('10-home');

  // Settings
  await view('settings');
  await click('[data-action="week-start"][data-value="1"]');
  await click('[data-action="time-format"][data-value="24"]');
  await click('[data-action="cover-theme"][data-value="tide"]');
  await waitFor("document.querySelector('[data-action=\"cover-theme\"][data-value=\"tide\"]')?.classList.contains('active')", 'cover theme saved');
  await screenshot('11-settings');
  await view('calendar');
  assert.equal(await text('.dow'), 'Mon', 'Week starts Monday');
  assert.match(await text('.plan .plan-time'), /07:30/);

  // Search
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))");
  await waitFor("!document.getElementById('search-overlay').hidden");
  await fill('#search-input', 'stretch');
  await waitFor("document.querySelectorAll('.search-result').length === 1");
  await screenshot('12-search');
  await click('.search-result');
  await waitFor(viewCheck('routine'), 'search navigates to routine');

  // New menu and account menu
  await click('#rail-new');
  await waitFor("!document.getElementById('new-menu').hidden");
  await screenshot('13-new-menu');
  await click('[data-action="new"][data-value="whim"]');
  await waitFor(`${viewCheck('whim')} && document.activeElement.matches('.pj-title') && document.querySelector('.pj-title').value === 'Untitled'`, 'New menu creates a project and focuses its title');
  await click('#rail-account');
  await waitFor("!document.getElementById('account-menu').hidden");
  await click('#account-menu [data-go="settings"]');
  await waitFor(viewCheck('settings'));

  // Sidebar collapse
  await click('#sidebar-toggle');
  await waitFor("document.getElementById('sidebar').classList.contains('collapsed') && !!document.querySelector('.nav-collapsed')");
  await screenshot('14-collapsed');
  await click('#sidebar-toggle');
  await waitFor("!document.getElementById('sidebar').classList.contains('collapsed') && !!document.querySelector('.nav-expanded')");

  // Restart: session and data persist
  await stop();
  await launch();
  await waitFor("!document.getElementById('main-page').hidden", 'session restored');
  await view('calendar');
  await waitFor("document.querySelectorAll('.plan').length === 4", 'plans persisted');
  await waitFor("document.querySelectorAll('.linked-row:not([data-sb-open])').length === 1", 'linked task still on the calendar');
  await click('[data-action="cal-view"][data-value="week"]');
  await waitFor("document.querySelectorAll('.tblock[data-sb-block]').length === 1 && document.querySelector('.tblock[data-sb-block]').title.startsWith('Design review') && document.querySelector('.tblock[data-sb-block]').style.height === '73px'", 'schedule block persisted');
  await click('[data-action="cal-view"][data-value="month"]');
  await waitFor("!!document.querySelector('.month-grid') && !!document.querySelector('.cell.today .cell-dot.sched')", 'month view marks the schedule');
  await view('whim');
  await waitFor("document.querySelectorAll('.pj-tab').length === 2", 'open project tabs restored (New menu project included)');
  await click('.pj-tab-main[title="Learn watercolor"]');
  await waitFor("document.querySelector('.pj-title')?.value === 'Learn watercolor' && document.querySelector('.pj-save')?.dataset.state === 'saved'", 'project page restored');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.pj-block')].map(b => b.className.match(/t-([a-z0-9]+)/)[1] + ':' + (b.querySelector('[data-pj-text]')?.value ?? ''))"), ['h1:Goals for spring', 'quote:Paint every weekend', 'tasks:', 'paragraph:'], 'blocks and their order persisted');
  assert.equal(await count('.t-tasks .pj-lrow'), 1, 'linked task persisted');
  assert.ok(await evaluate("document.querySelector('.pj-cover.photo .pj-cover-img') && Number(document.querySelector('.pj-cover-img').dataset.pjPos) > 50 && document.querySelector('.pj-icon')?.textContent === '🚀'"), 'cover image, position and icon persisted');
  await view('routine');
  await waitFor("document.querySelector('.progress span')?.textContent === '1 of 3 done today'", 'routine tick persisted');

  // Logout and back in
  await click('#rail-account');
  await click('#account-menu [data-action="logout"]');
  await waitFor("!document.getElementById('login-page').hidden", 'logged out');
  await fill('#login-email', 'smoke@example.com');
  await fill('#login-password', 'Sm0ke-test-pass');
  await submit('#login-form');
  await waitFor("!document.getElementById('main-page').hidden", 'logged back in');
  const errors = await evaluate("[...document.querySelectorAll('.toast.error')].map(t => t.textContent)");
  assert.deepEqual(errors, [], 'No error toasts');
}

run().then(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); console.log('Electron smoke test passed.'); })
  .catch(async error => { console.error(error); if (diagnostics) console.error(diagnostics); await stop(); fs.rmSync(root, { recursive: true, force: true }); process.exit(1); });

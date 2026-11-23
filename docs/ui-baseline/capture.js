'use strict';
/* D12/S7 UI baseline: screenshots of the current Learning pages (subject grid, subject page, topic viewer with side
   panel) at 1280 px and 400 px wide. Uses a throwaway data folder (PERFLW_TEST_USER_DATA under the OS temp folder),
   never the real one.
   Usage (from an app folder that has node_modules): node docs/ui-baseline/capture.js [outDir]
   PERFLW_ELECTRON_APP_DIR may point to another checkout. Same CDP approach as test/electron-smoke.js. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const appDir = path.resolve(process.env.PERFLW_ELECTRON_APP_DIR || path.join(__dirname, '..', '..'));
const out = path.resolve(process.argv[2] || __dirname);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-baseline-'));
const imagePath = path.join(appDir, 'assets', 'icon.png');
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
const exe = require(path.join(appDir, 'node_modules', 'electron'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket, nextId = 0; const pending = new Map();
const cdp = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\nIn: ${expression.slice(0, 160)}`);
  return r.result.value;
}
async function waitFor(expression, label, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { if (await evaluate(expression)) return; } catch {} await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const q = s => JSON.stringify(s);
const click = s => evaluate(`(() => { const el = document.querySelector(${q(s)}); if (!el) throw new Error('Missing ' + ${q(s)}); el.click(); return true; })()`);
const fill = (s, v) => evaluate(`(() => { const el = document.querySelector(${q(s)}); el.value = ${q(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const submit = s => evaluate(`document.querySelector(${q(s)}).requestSubmit()`);
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const settle = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');

async function shoot(name) {
  for (const [width, height] of [[1280, 800], [400, 800]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.getAnimations().forEach(a => a.finish()); true').catch(() => {});
    await sleep(500); await settle();
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, `${name}-${width}.png`), Buffer.from(data, 'base64'));
    console.log(`saved ${name}-${width}.png`);
  }
  await cdp('Emulation.clearDeviceMetricsOverride', {}); await sleep(300);
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const port = await freePort();
  child = spawn(exe, ['.', `--remote-debugging-port=${port}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'], {
    cwd: appDir, env: { ...process.env, PERFLW_TEST_USER_DATA: root, PERFLW_TEST_IMAGE_PATH: imagePath, PERFLW_TEST_TOPIC_PATH: pdfPath },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let endpoint;
  for (let i = 0; i < 150 && !endpoint; i++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page' && p.url.includes('index.html'))?.webSocketDebuggerUrl; } catch {}
    if (!endpoint) await sleep(100);
  }
  if (!endpoint) throw new Error('Electron page did not open');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = e => { const d = JSON.parse(e.data); const p = d.id && pending.get(d.id); if (!p) return; pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); };
  await cdp('Runtime.enable');
  await waitFor("document.readyState === 'complete' && !document.getElementById('login-page').hidden", 'login page');
  // Account and profile (throwaway)
  await click('[data-auth="register"]');
  await fill('#register-email', 'baseline@example.com');
  await fill('#register-password', 'Base-line-pass1');
  await fill('#register-confirmation', 'Base-line-pass1');
  await submit('#register-form');
  await waitFor("!document.getElementById('profile-page').hidden", 'profile page');
  await click('#pick-image');
  await waitFor("!!document.getElementById('profile-preview').style.backgroundImage", 'profile image');
  await fill('#profile-name', 'Baseline Student');
  await submit('#profile-form');
  await waitFor("!document.getElementById('main-page').hidden", 'main page');
  // Learning: one subject with an image and a description
  const nav = '.nav-item[data-go="learning"], .nav-icon-btn[data-go="learning"], .rail [data-go="learning"]';
  await waitFor(`!!document.querySelector(${q(nav)})`, 'learning navigation ready');
  await click(nav);
  await waitFor("document.querySelector('.ln-head h1')?.textContent === 'Learning'", 'learning page');
  await click('[data-ln="create"]');
  await waitFor("!!document.querySelector('[data-ln-form]')", 'subject dialog');
  await fill('[data-ln-form] [name="name"]', 'Calculus');
  await click('[data-ln="type"][data-value="major"]');
  await fill('[data-ln-form] [name="description"]', 'Limits, derivatives and integrals.');
  await click('[data-ln="pick-image"]');
  await waitFor("document.querySelector('[data-ln-preview]')?.classList.contains('has-img')", 'subject image');
  await submit('[data-ln-form]');
  await waitFor("document.querySelectorAll('[data-ln-subject]').length === 1 && !!document.querySelector('.ln-panel')", 'subject created');
  await shoot('01-subject-grid-preview');
  await click('[data-ln="close-panel"]');
  await waitFor("!document.querySelector('.ln-panel')", 'panel closed');
  await shoot('02-subject-grid');
  // Subject page with one PDF topic
  await evaluate("(() => { const el = document.querySelector('[data-ln-subject]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); return true; })()");
  await waitFor("document.querySelector('.ln-page-head h1')?.textContent === 'Calculus'", 'subject page');
  await waitFor("!!document.querySelector('.ln-topics [data-ln=\"upload\"]')", 'topics card');
  await click('[data-ln="upload"]');
  await waitFor("document.querySelectorAll('.ln-file').length === 1 && document.querySelectorAll('[data-topic]').length >= 1", 'PDF topic listed');
  await shoot('03-subject-page');
  // Topic viewer with the side panel (key points)
  await click('[data-topic] .ln-topic-title');
  await waitFor("!!document.querySelector('.ln-viewer .ln-pdfv-page canvas')", 'viewer drew the PDF');
  await waitFor("document.querySelectorAll('.ls-sec-title').length >= 2", 'key points sections', 45000);
  await shoot('04-topic-viewer-side-panel');
}

main().then(() => 0, error => { console.error(error.message); return 1; }).then(async code => {
  try { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++nextId, method: 'Runtime.evaluate', params: { expression: 'window.windowControls && window.windowControls.close()' } })); } catch {}
  await Promise.race([new Promise(r => child?.once('exit', r)), sleep(15000)]);
  if (child && child.exitCode === null) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(code);
});

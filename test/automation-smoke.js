// End-to-end check of Agentic Automation in the running Electron app, using the real local Ollama runtime.
// Usage: node test/automation-smoke.js   — needs Ollama running with at least one local model.
// Optional: PERFLW_TEST_MODEL=<model name>, PERFLW_SCREENSHOT_DIR=<absolute folder>.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-automation-e2e-'));
const mdPath = path.join(root, 'house-style.md');
fs.writeFileSync(mdPath, '# House style\n\n- Keep it to three short lines.\n- Use **plain** words.\n\n1. No title.\n');
const screenshots = process.env.PERFLW_SCREENSHOT_DIR;
let child; let socket; let nextId = 0; let diagnostics = '';
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(() => resolve(number)); });
    server.on('error', reject);
  });
}
async function launch() {
  const number = await port();
  child = spawn(require('electron'), ['.', `--remote-debugging-port=${number}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PERFLW_TEST_USER_DATA: root, PERFLW_TEST_MD_PATH: mdPath },
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
function cdp(method, params) {
  return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject, method }); socket.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.exception?.description || result.exceptionDetails.text}\nIn: ${expression.slice(0, 200)}`);
  return result.result.value;
}
async function waitFor(expression, label = expression, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await evaluate(expression)) return; } catch { /* retry */ }
    await sleep(50);
  }
  const toasts = await evaluate("[...document.querySelectorAll('.toast')].map(t => t.textContent)").catch(() => []);
  throw new Error(`UI condition did not become true: ${label}${toasts.length ? `\nToasts: ${toasts.join(' | ')}` : ''}`);
}
async function screenshot(name) {
  if (!screenshots) return;
  fs.mkdirSync(screenshots, { recursive: true });
  await sleep(300);
  const result = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from(result.data, 'base64'));
}
const q = selector => JSON.stringify(selector);
const click = selector => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('Missing ' + ${q(selector)}); el.click(); return true; })()`);
const fill = (selector, value) => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('Missing ' + ${q(selector)}); el.value = ${q(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const choose = (selector, value) => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('Missing ' + ${q(selector)}); el.value = ${q(value)}; if (el.value !== ${q(value)}) throw new Error('No option ' + ${q(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const submit = selector => evaluate(`document.querySelector(${q(selector)}).requestSubmit()`);
const text = selector => evaluate(`(document.querySelector(${q(selector)})?.textContent || '').trim()`);
const count = selector => evaluate(`document.querySelectorAll(${q(selector)}).length`);
const settled = () => waitFor("!document.querySelector('.af-world')?.classList.contains('glide')", 'canvas settled');
const center = async selector => { await settled(); return centerNow(selector); };
const centerNow = selector => evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) throw new Error('Missing ' + ${q(selector)}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const mouse = (type, point, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
// A real pointer drag (press, move in steps, release), as a person would do it.
async function drag(from, to) {
  await mouse('mouseMoved', from, { buttons: 0, button: 'none' });
  await mouse('mousePressed', from);
  for (let step = 1; step <= 8; step++) await mouse('mouseMoved', { x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8 });
  await mouse('mouseReleased', to);
  await sleep(60);
}
const nodeIdByType = (type, index = 0) => evaluate(`document.querySelectorAll('.af-node.type-${type}')[${index}]?.dataset.node`);
const nodePositions = () => evaluate("[...document.querySelectorAll('.af-node')].map(n => [n.dataset.node, n.style.left, n.style.top]).sort().join(';')");
const go = async (name, check) => { await click(`.nav-item[data-go="${name}"], .nav-icon-btn[data-go="${name}"]`); await waitFor(`!document.querySelector('#stage').classList.contains('view-out') && ${check}`, `view ${name}`); };
async function stop() {
  if (!child) return;
  const proc = child; child = null;
  if (socket) socket.close();
  if (proc.exitCode === null) { proc.kill(); await new Promise(resolve => proc.once('exit', resolve)); }
}
/* A local OpenAI-compatible endpoint, so the custom-provider path runs for real without external credentials. */
async function fakeEndpoint() {
  const requests = [];
  const server = require('node:http').createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: body ? JSON.parse(body) : null });
      if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'fake-model' }] })); return; }
      response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FAKE-ENDPOINT-' } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'REPLY' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => { server.closeAllConnections(); server.close(); } };
}
async function pickModel() {
  let tags;
  try { tags = await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) })).json(); }
  catch { throw new Error('PRECONDITION: Ollama is not running on 127.0.0.1:11434, so the real execution path cannot be checked.'); }
  const local = (tags.models || []).filter(model => !model.remote_host && !/cloud$/i.test(model.name)).sort((a, b) => a.size - b.size);
  const wanted = process.env.PERFLW_TEST_MODEL;
  const model = wanted ? local.find(item => item.name === wanted) : local[0];
  if (!model) throw new Error('PRECONDITION: no local Ollama model is installed (or PERFLW_TEST_MODEL was not found).');
  return model.name;
}

async function run() {
  const model = await pickModel();
  console.log(`Using local model: ${model}`);
  await launch();
  await waitFor("!document.getElementById('login-page').hidden", 'login page');
  await click('[data-auth="register"]');
  await fill('#register-email', 'flow@example.com');
  await fill('#register-password', 'Fl0w-test-pass');
  await fill('#register-confirmation', 'Fl0w-test-pass');
  await submit('#register-form');
  await waitFor("!document.getElementById('profile-page').hidden", 'profile page');
  await fill('#profile-name', 'Flow Tester');
  await submit('#profile-form');
  await waitFor("!document.getElementById('main-page').hidden && !!document.querySelector('.cal-layout')", 'workspace');

  // ── Agents page: real model list from Ollama, create two agents
  await go('agents', "document.querySelector('.page-head h1')?.textContent === 'Agents'");
  await waitFor("/Ollama is running/.test(document.querySelector('.af-runtime')?.textContent || '')", 'Ollama status line');
  // Agents are created with a provider + model, then their instructions are written in instructions.md (Files tab).
  async function createAgent(name, description, instructions, expected) {
    await click('[data-eco="new-agent"]');
    await waitFor("!!document.querySelector('[data-eco-form=\"new-agent\"]')");
    await waitFor(`[...document.querySelectorAll('[data-eco-form="new-agent"] datalist option')].some(o => o.value === ${q(model)})`, 'installed Ollama model is offered', 15000);
    await fill('[data-eco-form="new-agent"] [name=name]', name);
    if (description) await fill('[data-eco-form="new-agent"] [name=description]', description);
    await fill('[data-eco-form="new-agent"] [name=model]', model);
    await submit('[data-eco-form="new-agent"]');
    await waitFor(`document.querySelectorAll('.chat-item').length === ${expected} && document.querySelector('.eco-pane .chat-title')?.textContent === ${q(name)}`, `${name} created`);
    await click('[data-eco="agent-tab"][data-value="files"]');
    await waitFor("document.querySelector('.eco-editor-name')?.textContent === 'instructions.md'", 'instructions.md open');
    await fill('[data-eco-input="agent-file"]', instructions);
    await waitFor("document.querySelector('.eco-editor .eco-save-state')?.textContent === 'Unsaved changes'", 'unsaved state shown');
    await click('.eco-editor [data-eco="save-file"]');
    await waitFor("document.querySelector('.eco-editor .eco-save-state')?.textContent === 'Saved'", `${name} instructions saved`);
  }
  await createAgent('Haiku Writer', 'Writes one haiku', 'You write one short haiku about the topic you are given. Reply with the haiku only.', 1);
  assert.match(await text('.chat-item.active .chat-item-meta'), new RegExp(`Ollama \\(local\\) · ${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await createAgent('Critic', '', 'You are given a haiku. Reply with one short sentence saying what it is about.', 2);
  await screenshot('01-agents');

  // ── Workflow: create and rename
  await go('automation', "!!document.querySelector('[data-af-root=\"editor\"] [data-af=\"new-workflow\"]')");
  await click('[data-af="new-workflow"]');
  await waitFor("!!document.querySelector('[data-af-form=\"rename\"]')", 'rename form after create');
  await fill('[data-af-form="rename"] [name=title]', 'Haiku pipeline');
  await fill('[data-af-form="rename"] [name=description]', 'Writes a haiku, then explains it');
  await submit('[data-af-form="rename"]');
  await waitFor("document.querySelector('.af-head h1')?.textContent === 'Haiku pipeline'", 'workflow renamed');
  assert.equal(await count('.af-node'), 2, 'new workflow starts with Input and Output');
  const inputId = await nodeIdByType('input'); const outputId = await nodeIdByType('output');

  // ── Add an agent node and pick an existing agent
  await click('[data-af="add-agent"]');
  await waitFor("document.querySelectorAll('.af-node').length === 3 && !document.querySelector('.af-inspector').hidden", 'agent node + inspector');
  const writerNode = await nodeIdByType('agent');
  assert.equal(await count('#af-agent-select option'), 3, 'agent picker lists the two existing agents');
  await evaluate(`(() => { const s = document.querySelector('#af-agent-select'); s.value = [...s.options].find(o => o.textContent === 'Haiku Writer').value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('[data-node="${writerNode}"] .af-node-title')?.textContent === 'Haiku Writer'`, 'node shows agent identity');
  assert.equal(await text(`[data-node="${writerNode}"] .af-node-sub`), model);
  assert.match(await text('.af-agent-card'), /Writes one haiku/);

  // ── Markdown node: import a .md file, preview it
  await click('[data-af="add-markdown"]');
  await waitFor("document.querySelectorAll('.af-node').length === 4 && !!document.querySelector('[data-af=\"import-md\"]')");
  const mdNode = await nodeIdByType('markdown');
  await click('[data-af="import-md"]');
  await waitFor("document.querySelector('.af-file-name')?.textContent.trim() === 'house-style.md'", 'attached filename shown');
  assert.match(await evaluate("document.querySelector('[data-field=\"content\"]').value"), /Keep it to three short lines/);
  await click('[data-af="md-mode"][data-value="preview"]');
  await waitFor("document.querySelectorAll('.af-md-preview li').length === 3 && !!document.querySelector('.af-md-preview strong')", 'markdown preview rendered');
  await click('[data-af="md-mode"][data-value="edit"]');
  await waitFor("!!document.querySelector('[data-field=\"content\"]')");
  assert.equal(await text(`[data-node="${mdNode}"] .af-node-title`), 'house-style.md');

  // ── Connect: Markdown → agent from the inspector (keyboard-accessible path)
  await choose('[data-af-change="connect-to"]', writerNode);
  await waitFor("document.querySelectorAll('.af-edge-group').length === 1 && !!document.querySelector('.af-edge-group.context')", 'markdown connection');

  // ── Connect with real pointer drags: Input → agent, agent → Output (settings panel closed, canvas fitted)
  await click('[data-af="deselect"]');
  await waitFor("!document.querySelector('.af-world').classList.contains('glide')", 'canvas settled');
  await click('[data-af="fit"]');
  await sleep(120);
  if (process.env.PERFLW_DEBUG) {
    const a = await center(`[data-node="${inputId}"] .af-port.out`); const b = await center(`[data-node="${writerNode}"] .af-node-title`);
    console.log('from', a, 'to', b, await evaluate(`(() => { const d = p => { const e = document.elementFromPoint(p.x, p.y); return e ? e.tagName + '.' + e.className : null; }; window.__ev = []; for (const t of ['pointerdown','pointermove','pointerup','pointercancel','mousedown']) document.addEventListener(t, e => window.__ev.push(t + ':' + (e.target.className || e.target.tagName) + ':' + e.pointerId + ':' + e.button), true); return JSON.stringify({ a: d(${JSON.stringify(a)}), b: d(${JSON.stringify(b)}), win: [innerWidth, innerHeight], canvas: document.querySelector('.af-canvas').getBoundingClientRect().toJSON(), nodes: [...document.querySelectorAll('.af-node')].map(n => [n.className, n.style.left, n.style.top]), tr: document.querySelector('.af-world').style.transform }); })()`));
  }
  await drag(await center(`[data-node="${inputId}"] .af-port.out`), await center(`[data-node="${writerNode}"] .af-node-title`));
  if (process.env.PERFLW_DEBUG) console.log('events', await evaluate('JSON.stringify(window.__ev)'), 'toasts', await evaluate("[...document.querySelectorAll('.toast')].map(t => t.textContent).join('|')"));
  await waitFor("document.querySelectorAll('.af-edge-group').length === 2", 'input → agent drag connection');
  await drag(await center(`[data-node="${writerNode}"] .af-port.out`), await center(`[data-node="${outputId}"] .af-node-title`));
  await waitFor("document.querySelectorAll('.af-edge-group').length === 3", 'agent → output drag connection');

  // ── Invalid connection is refused with a reason
  await drag(await center(`[data-node="${writerNode}"] .af-port.out`), await center(`[data-node="${inputId}"] .af-node-title`));
  await waitFor("[...document.querySelectorAll('.toast.error')].some(t => /do not accept incoming/.test(t.textContent))", 'invalid connection explained');
  assert.equal(await count('.af-edge-group'), 3);

  // ── Move a node by dragging; undo / redo
  await sleep(4300); // let the error toast leave so it cannot sit over the canvas
  const before = await nodePositions();
  const grab = await center(`[data-node="${mdNode}"] .af-node-kind`);
  await drag(grab, { x: grab.x - 60, y: grab.y + 70 });
  const moved = await nodePositions();
  assert.notEqual(moved, before, 'dragging moves the node');
  await click('[data-af="undo"]');
  assert.equal(await nodePositions(), before, 'undo restores the position');
  await click('[data-af="redo"]');
  assert.equal(await nodePositions(), moved, 'redo reapplies the move');

  // ── Zoom controls, keyboard delete + undo
  await click('[data-af="zoom-reset"]');
  assert.equal(await text('.af-zoom-label'), '100%');
  await click('[data-af="zoom-in"]');
  assert.equal(await text('.af-zoom-label'), '125%');
  await click('[data-af="zoom-out"]');
  assert.equal(await text('.af-zoom-label'), '100%');
  await evaluate(`(() => { const n = document.querySelector('[data-node="${mdNode}"]'); n.focus(); n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); })()`);
  await waitFor("document.querySelectorAll('.af-node').length === 3 && document.querySelectorAll('.af-edge-group').length === 2", 'Delete removes node and its connection');
  await click('[data-af="undo"]');
  await waitFor("document.querySelectorAll('.af-node').length === 4 && document.querySelectorAll('.af-edge-group').length === 3", 'undo restores node and connection');

  // ── Save
  await click('[data-af="save"]');
  await waitFor("document.querySelector('.af-status-save')?.textContent === 'Saved'", 'saved');
  await screenshot('02-workflow-built');

  // ── Run through the test chat with the real model
  await fill('#af-input', 'the sea at dawn');
  await submit('[data-af-form="prompt"]');
  await waitFor("!!document.querySelector('.af-node.is-running') || !!document.querySelector('.af-final')", 'a node is highlighted while it runs', 60000);
  await screenshot('03-running');
  await waitFor("!!document.querySelector('.af-final') || !!document.querySelector('.af-run.is-failed')", 'run finished', 240000);
  assert.equal(await count('.af-run.is-failed'), 0, `run failed: ${await text('.af-run-error')}`);
  const finalText = await text('.af-final .af-md, .af-final .af-json');
  assert.ok(finalText.length > 5, 'final output is shown');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.af-step .af-step-name')].map(n => n.textContent)"), ['Input', 'Haiku Writer', 'Output']);
  assert.equal(await count('.af-step.is-done'), 3);
  assert.equal(await count('.af-node.is-done'), 3, 'executed nodes show a completed status');
  assert.ok((await text('.af-step-preview')).length > 5, 'agent response preview is shown');
  assert.match(await text('.af-logs pre'), /Calling Haiku Writer \(.+\) with 1 instruction block\./, 'log shows the Markdown was applied');
  assert.match(await text('.af-status-run'), /^Completed in/);
  assert.match(await text(`[data-node="${outputId}"] .af-node-sub`), /\S/);
  assert.match(await text('.af-chat .msg.user'), /the sea at dawn/);
  console.log(`Final output from ${model}:\n${finalText}\n`);
  await screenshot('04-completed');

  // ── Add a second agent downstream: Writer → Critic → Output (order comes from connections)
  await click('[data-af="add-agent"]');
  await waitFor("document.querySelectorAll('.af-node').length === 5");
  const criticNode = await evaluate(`[...document.querySelectorAll('.af-node.type-agent')].map(n => n.dataset.node).find(id => id !== ${q(writerNode)})`);
  await evaluate(`(() => { const s = document.querySelector('#af-agent-select'); s.value = [...s.options].find(o => o.textContent === 'Critic').value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await choose('[data-af-change="connect-to"]', outputId);
  await evaluate(`document.querySelector('[data-node="${writerNode}"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))`);
  await evaluate("document.querySelector('.af-canvas').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }))");
  await waitFor("!!document.querySelector('[data-af-change=\"connect-to\"]')", 'writer selected');
  await evaluate(`document.querySelector('[data-af="remove-edge"][aria-label="Remove connection to Output"]').click()`);
  await choose('[data-af-change="connect-to"]', criticNode);
  await waitFor("document.querySelectorAll('.af-edge-group').length === 4", 'writer → critic → output wired');
  await fill('#af-input', 'a quiet library');
  await submit('[data-af-form="prompt"]');
  await waitFor("document.querySelectorAll('.af-final').length === 2 || !!document.querySelector('.af-run.is-failed')", 'two-agent run finished', 300000);
  assert.equal(await count('.af-run.is-failed'), 0, `two-agent run failed: ${await text('.af-run-error')}`);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.af-run-wrap:last-of-type .af-step-name')].map(n => n.textContent)"), ['Input', 'Haiku Writer', 'Critic', 'Output']);
  console.log(`Two-agent output:\n${await evaluate("[...document.querySelectorAll('.af-final')].at(-1).querySelector('.af-md, .af-json').textContent.trim()")}\n`);
  await screenshot('05-two-agents');

  // ── Cancel an active run
  await fill('#af-input', 'Write a very long epic poem of at least nine hundred words about every ocean on Earth.');
  await submit('[data-af-form="prompt"]');
  await waitFor("!!document.querySelector('.af-node.type-agent.is-running')", 'agent running before cancel', 60000);
  assert.equal(await text('[data-af="run"]'), 'Stop');
  await click('[data-af="run"]');
  await waitFor("[...document.querySelectorAll('.af-run')].at(-1).classList.contains('is-cancelled')", 'run cancelled', 20000);
  assert.equal(await text('.af-status-run'), 'Stopped');
  assert.equal(await text('[data-af="run"]'), 'Run');

  // ── A node without an agent stops the run with a clear message
  await evaluate(`document.querySelector('[data-node="${criticNode}"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))`);
  await evaluate("document.querySelector('.af-canvas').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }))");
  await waitFor("!!document.querySelector('#af-agent-select')");
  await choose('#af-agent-select', '');
  await fill('#af-input', 'anything');
  await submit('[data-af-form="prompt"]');
  await waitFor("[...document.querySelectorAll('.af-run')].at(-1).classList.contains('is-failed')", 'run failed for missing agent', 15000);
  assert.match(await evaluate("[...document.querySelectorAll('.af-run-error')].at(-1).textContent"), /Choose an agent/);
  assert.ok(await evaluate(`document.querySelector('[data-node="${criticNode}"]').classList.contains('is-error')`), 'the unconfigured node is marked');
  await evaluate(`(() => { const s = document.querySelector('#af-agent-select'); s.value = [...s.options].find(o => o.textContent === 'Critic').value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await screenshot('06-error-and-cancel');
  await click('[data-af="save"]');
  await waitFor("document.querySelector('.af-status-save')?.textContent === 'Saved'", 'saved before leaving the editor');

  // ── Agent Ecosystem: a skill is created, assigned to an agent, and loaded at run time (progressive loading)
  await go('skills', "document.querySelector('.page-head h1')?.textContent === 'Skills'");
  await click('[data-eco="new-skill"]');
  await fill('[data-eco-form="new-skill"] [name=name]', 'Haiku form');
  await fill('[data-eco-form="new-skill"] [name=description]', 'Write haiku poems with a seasonal word');
  await submit('[data-eco-form="new-skill"]');
  await waitFor("document.querySelector('.eco-editor-name')?.textContent === 'SKILL.md'", 'skill created with SKILL.md open');
  await fill('[data-eco-input="skill-file"]', '---\nname: Haiku form\ndescription: Write haiku poems with a seasonal word\nenabled: true\nactivation: auto\ntriggers: haiku, poem\noutcome: A haiku followed by a last line that starts with SEASON:\n---\nWrite the haiku in three lines and include one seasonal word.\nThen add one final line in exactly this form: SEASON: <the season the haiku is about>');
  await click('.eco-editor [data-eco="save-file"]');
  await waitFor("document.querySelector('.eco-editor .eco-save-state')?.textContent === 'Saved'", 'SKILL.md saved');
  assert.match(await text('.eco-skill-meta'), /triggers: haiku, poem/);
  const unused = await text('.chat-item.active .chat-item-meta');
  assert.match(unused, /Enabled · not assigned/);
  await go('agents', "document.querySelector('.page-head h1')?.textContent === 'Agents'");
  await evaluate("[...document.querySelectorAll('[data-eco=\"open-agent\"]')].find(b => b.textContent.includes('Haiku Writer')).click()");
  await waitFor("!!document.querySelector('[data-eco-form=\"agent-settings\"]')", 'agent overview');
  await evaluate("(() => { const box = [...document.querySelectorAll('input[name=\"skill\"]')].find(i => i.closest('label').textContent.includes('Haiku form')); box.click(); })()");
  await waitFor("!document.querySelector('[data-eco-form=\"agent-settings\"] [type=submit]').disabled", 'settings marked unsaved');
  await submit('[data-eco-form="agent-settings"]');
  await waitFor("document.querySelector('[data-eco-form=\"agent-settings\"] .eco-save-state')?.textContent === 'All changes saved'", 'skill assignment saved');
  // LLM APIs: the built-in Ollama connection tests OK; a bad custom endpoint fails with a clear message (no crash).
  await click('[data-eco="providers"]');
  await waitFor("document.querySelector('.eco-pane .chat-title')?.textContent === 'LLM APIs'");
  await click('[data-eco="test-provider"]');
  await waitFor("/Connected to Ollama/.test(document.querySelector('.eco-section .af-note')?.textContent || '')", 'Ollama connection test', 15000);
  await click('[data-eco="new-provider"]');
  await choose('[data-eco-form="provider"] [name=type]', 'openai-compatible');
  await fill('[data-eco-form="provider"] [name=baseUrl]', 'http://127.0.0.1:9/v1');
  await click('[data-eco="test-provider"]');
  await waitFor("document.querySelector('.eco-section .af-note.error')?.textContent.length > 10", 'failed test explained', 15000);
  console.log(`Bad endpoint test message: ${await text('.eco-section .af-note.error')}`);
  await screenshot('07-llm-apis');
  await go('automation', "document.querySelector('.af-head h1')?.textContent === 'Haiku pipeline'");
  await fill('#af-input', 'write a haiku about autumn rain');
  await submit('[data-af-form="prompt"]');
  await waitFor("[...document.querySelectorAll('.af-run')].at(-1).matches('.is-completed, .is-failed')", 'skill run finished', 300000);
  assert.equal(await evaluate("[...document.querySelectorAll('.af-run')].at(-1).classList.contains('is-failed')"), false, `skill run failed: ${await text('.af-run-error')}`);
  const diag = await evaluate("[...document.querySelectorAll('.af-run')].at(-1).querySelector('[data-step] .af-diag')?.textContent || ''");
  const writerDiag = await evaluate("(() => { const step = [...[...document.querySelectorAll('.af-run')].at(-1).querySelectorAll('.af-step')].find(s => s.querySelector('.af-step-name').textContent === 'Haiku Writer'); return step?.querySelector('.af-diag')?.textContent || ''; })()");
  assert.ok(diag.length > 0, 'diagnostics are shown for agent steps');
  assert.match(writerDiag, /Haiku Writer · Ollama \(local\)/, 'diagnostics name the agent and provider');
  assert.match(writerDiag, /Haiku form — loaded/, 'the assigned, relevant skill was loaded');
  assert.match(writerDiag, /Estimated context: ~\d/, 'estimated context usage is shown');
  assert.match(writerDiag, /Provider-reported: \d+ in/, 'Ollama-reported token usage is shown separately');
  assert.match(writerDiag, /Tools: none/, 'no tools are claimed when no permission is granted');
  console.log(`Writer step diagnostics:\n${writerDiag.replace(/\s+/g, ' ').slice(0, 600)}\n`);
  // The skill must change what the agent actually produces, not just appear in its context.
  const stepText = name => evaluate(`(() => { const step = [...[...document.querySelectorAll('.af-run')].at(-1).querySelectorAll('.af-step')].find(s => s.querySelector('.af-step-name').textContent === ${q(name)}); return step?.querySelector('.af-step-preview')?.textContent || ''; })()`);
  const withSkill = await stepText('Haiku Writer');
  console.log(`Writer output with the skill:\n${withSkill}\n`);
  assert.match(withSkill, /SEASON:/i, 'the writer followed the skill (its earlier outputs had no SEASON line)');
  assert.doesNotMatch(finalText, /SEASON:/i, 'before the skill was assigned there was no SEASON line');
  const criticDiag = await evaluate("(() => { const step = [...[...document.querySelectorAll('.af-run')].at(-1).querySelectorAll('.af-step')].find(s => s.querySelector('.af-step-name').textContent === 'Critic'); return step?.querySelector('.af-diag')?.textContent || ''; })()");
  assert.match(criticDiag, /Workflow position/, 'the downstream agent is told where it sits in the workflow');

  // ── A custom OpenAI-compatible provider, added through the UI with an API key, runs a real workflow step
  const fake = await fakeEndpoint();
  const secret = 'sk-e2e-secret-0123456789abcdef';
  await go('agents', "document.querySelector('.page-head h1')?.textContent === 'Agents'");
  await click('[data-eco="providers"]');
  await waitFor("document.querySelector('.eco-pane .chat-title')?.textContent === 'LLM APIs'");
  await click('[data-eco="new-provider"]');
  await choose('[data-eco-form="provider"] [name=type]', 'openai-compatible');
  await fill('[data-eco-form="provider"] [name=label]', 'Test endpoint');
  await fill('[data-eco-form="provider"] [name=baseUrl]', fake.baseUrl);
  await fill('[data-eco-form="provider"] [name=apiKey]', secret);
  await fill('[data-eco-form="provider"] [name=model]', 'fake-model');
  await click('[data-eco="test-provider"]');
  await waitFor("/Connected to Custom/.test(document.querySelector('.eco-section .af-note')?.textContent || '')", 'custom endpoint test', 15000);
  assert.equal(await evaluate("document.querySelector('[data-eco-form=\"provider\"] [name=apiKey]').value"), secret, 'the typed key survives the test so it can be saved');
  await submit('[data-eco-form="provider"]');
  await waitFor("[...document.querySelectorAll('.eco-provider')].some(b => /Test endpoint/.test(b.textContent) && /key saved/.test(b.textContent))", 'provider saved with a key');
  assert.equal(await evaluate("document.querySelector('[data-eco-form=\"provider\"] [name=apiKey]').value"), '', 'the saved key is never shown again');
  await evaluate("[...document.querySelectorAll('[data-eco=\"open-agent\"]')].find(b => b.textContent.includes('Critic')).click()");
  await waitFor("document.querySelector('.eco-pane .chat-title')?.textContent === 'Critic' && !!document.querySelector('[data-eco-form=\"agent-settings\"]')", 'critic overview');
  const connectionId = await evaluate("[...document.querySelector('[data-eco-form=\"agent-settings\"] [name=connectionId]').options].find(o => o.textContent.includes('Test endpoint')).value");
  await choose('[data-eco-form="agent-settings"] [name=connectionId]', connectionId);
  await waitFor("/Prompts are sent to this online service/.test(document.querySelector('[data-eco-form=\"agent-settings\"]').textContent)", 'provider capabilities shown');
  await fill('[data-eco-form="agent-settings"] [name=model]', 'fake-model');
  await submit('[data-eco-form="agent-settings"]');
  await waitFor("document.querySelector('[data-eco-form=\"agent-settings\"] .eco-save-state')?.textContent === 'All changes saved'", 'critic provider saved');
  assert.match(await text('.chat-item.active .chat-item-meta'), /Test endpoint · fake-model/);
  await go('automation', "document.querySelector('.af-head h1')?.textContent === 'Haiku pipeline'");
  await fill('#af-input', 'write a haiku about winter snow');
  await submit('[data-af-form="prompt"]');
  await waitFor("[...document.querySelectorAll('.af-run')].at(-1).matches('.is-completed, .is-failed')", 'mixed-provider run finished', 300000);
  assert.equal(await evaluate("[...document.querySelectorAll('.af-run')].at(-1).classList.contains('is-failed')"), false, `mixed-provider run failed: ${await evaluate("[...document.querySelectorAll('.af-run-error')].at(-1)?.textContent || ''")}`);
  assert.equal(await evaluate("[...document.querySelectorAll('.af-final')].at(-1).querySelector('.af-md, .af-json').textContent.trim()"), 'FAKE-ENDPOINT-REPLY', 'the final output came from the custom provider');
  const sent = fake.requests.find(item => item.url === '/v1/chat/completions');
  assert.equal(sent.authorization, `Bearer ${secret}`, 'the decrypted key reached the provider');
  assert.equal(sent.body.model, 'fake-model');
  assert.match(sent.body.messages[0].content, /You are given a haiku\./, 'the agent’s saved instructions were sent');
  assert.match(sent.body.messages[0].content, /Your input comes from: Haiku Writer\./);
  assert.match(await stepText('Critic'), /FAKE-ENDPOINT-REPLY/);
  for (const file of fs.readdirSync(root, { recursive: true })) {
    const full = path.join(root, String(file));
    if (fs.statSync(full).isFile() && /workspace\.sqlite|agent-ecosystem/.test(full)) assert.equal(fs.readFileSync(full).includes(secret), false, `the API key is not stored in plain text in ${file}`);
  }
  fake.close();
  await screenshot('09-custom-provider');
  await screenshot('08-skill-run');

  // ── Persistence across an app restart
  await click('[data-af="save"]');
  await waitFor("document.querySelector('.af-status-save')?.textContent === 'Saved'", 'saved before restart');
  const savedPositions = await nodePositions();
  await stop();
  await launch();
  await waitFor("document.querySelector('.af-head h1')?.textContent === 'Haiku pipeline' && document.querySelectorAll('.af-node').length === 5", 'workflow reopened after restart', 15000);
  assert.equal(await count('.af-edge-group'), 4, 'connections persisted');
  assert.equal(await nodePositions(), savedPositions, 'node positions persisted');
  assert.equal(await text(`[data-node="${writerNode}"] .af-node-title`), 'Haiku Writer');
  assert.equal(await text(`[data-node="${mdNode}"] .af-node-title`), 'house-style.md');
  assert.match(await text('.af-head .subtitle'), /Writes a haiku, then explains it/);
  await go('agents', "document.querySelector('.page-head h1')?.textContent === 'Agents'");
  await evaluate("[...document.querySelectorAll('[data-eco=\"open-agent\"]')].find(b => b.textContent.includes('Haiku Writer')).click()");
  await waitFor("!!document.querySelector('[data-eco-form=\"agent-settings\"]')", 'agent overview after restart');
  assert.ok(await evaluate("[...document.querySelectorAll('input[name=\"skill\"]')].find(i => i.closest('label').textContent.includes('Haiku form')).checked"), 'skill assignment persisted');
  await click('[data-eco="agent-tab"][data-value="files"]');
  await waitFor("/write one short haiku/.test(document.querySelector('[data-eco-input=\"agent-file\"]')?.value || '')", 'instructions.md persisted');
  await go('automation', "document.querySelector('.af-head h1')?.textContent === 'Haiku pipeline'");

  // ── Duplicate, switch, delete
  await click('[data-af="workflows-menu"]');
  await click('#af-menu [data-af="duplicate-workflow"]');
  await waitFor("document.querySelector('.af-head h1')?.textContent === 'Haiku pipeline copy' && document.querySelectorAll('.af-node').length === 5 && document.querySelectorAll('.af-edge-group').length === 4", 'duplicate opened with the same graph');
  await click('[data-af="workflows-menu"]');
  assert.equal(await count('#af-menu [data-af="open-workflow"]'), 2);
  await click('#af-menu [data-af="delete-workflow"]');
  await waitFor("!document.getElementById('confirm-overlay').hidden");
  await click('#confirm-ok');
  await waitFor("document.querySelector('.af-head h1')?.textContent === 'Haiku pipeline'", 'back on the original after deleting the copy');

  // ── Existing pages still work
  await go('calendar', "!!document.querySelector('.cal-layout')");
  await go('automation', "document.querySelector('.af-head h1')?.textContent === 'Haiku pipeline'");
  assert.equal(await count('.af-node'), 5, 'editor state survives leaving and returning');
}

run().then(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); console.log('Automation end-to-end test passed.'); })
  .catch(async error => { console.error(error); if (diagnostics) console.error(diagnostics); await stop(); fs.rmSync(root, { recursive: true, force: true }); process.exit(/^PRECONDITION/.test(error.message) ? 2 : 1); });

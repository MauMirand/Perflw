const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createWorkspace } = require('../src/workspace');
const { cleanGraph, connectionProblem, planWorkflow, runWorkflow, applyTemplate, emptyGraph } = require('../src/automation/engine');
const { createOllamaRuntime } = require('../src/automation/ollama');

const node = (id, type, config = {}, x = 0, y = 0) => ({ id, type, x, y, title: '', config });
const edge = (from, to) => ({ id: `${from}-${to}`, from, to });
const agents = [
  { id: 'agent-a', name: 'Researcher', model: 'test-model', instructions: 'You research.' },
  { id: 'agent-b', name: 'Writer', model: 'test-model', instructions: 'You write.' }
];
// Test double for the injected runtime: records each call and echoes what it was given.
function recorder() {
  const calls = [];
  const runAgent = async ({ agent, system, prompt, onDelta }) => { calls.push({ agent: agent.name, system, prompt }); onDelta('partial'); return `${agent.name}(${prompt})`; };
  return { calls, runAgent };
}
function collect() { const events = []; return { events, emit: event => events.push(event) }; }

test('execution order follows connections, not node positions or creation order', async () => {
  // Writer is created first and placed far left; it still runs after Researcher because of the edges.
  const graph = {
    nodes: [node('out', 'output', {}, -900, 0), node('w', 'agent', { agentId: 'agent-b' }, -500, 0), node('r', 'agent', { agentId: 'agent-a' }, 900, 0), node('in', 'input', {}, 400, 0)],
    edges: [edge('r', 'w'), edge('w', 'out'), edge('in', 'r')]
  };
  const { calls, runAgent } = recorder(); const { events, emit } = collect();
  const result = await runWorkflow({ graph, prompt: 'hello', agents, runAgent, emit });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.map(call => call.agent), ['Researcher', 'Writer']);
  assert.equal(result.output, 'Writer(Researcher(hello))');
  assert.deepEqual(events.filter(e => e.type === 'node-start').map(e => e.nodeId), ['in', 'r', 'w', 'out']);
  assert.ok(events.some(e => e.type === 'node-delta' && e.nodeId === 'r'));
  assert.equal(events.at(-1).type, 'run-done');
});

test('only nodes reachable from Input run; Markdown feeds the agent it is connected to', async () => {
  const graph = {
    nodes: [node('in', 'input'), node('a', 'agent', { agentId: 'agent-a', instructions: 'Node note.' }), node('out', 'output'),
      node('md', 'markdown', { content: '# Style\nBe brief.', filename: 'style.md' }), node('orphan', 'agent', { agentId: 'agent-b' }), node('loose', 'markdown', { content: 'unused' })],
    edges: [edge('in', 'a'), edge('a', 'out'), edge('md', 'a'), edge('loose', 'orphan')]
  };
  const { calls, runAgent } = recorder(); const { events, emit } = collect();
  const result = await runWorkflow({ graph, prompt: 'topic', agents, runAgent, emit });
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, 'You research.\n\n# Style\nBe brief.\n\nNode note.');
  assert.equal(calls[0].prompt, 'topic');
  assert.deepEqual(events.filter(e => e.type === 'node-skipped').map(e => e.nodeId).sort(), ['loose', 'orphan']);
});

test('input mapping templates and multiple upstream connections', async () => {
  assert.equal(applyTemplate('Summarise: {{input}} (asked: {{ prompt }})', { input: 'data', prompt: 'q' }), 'Summarise: data (asked: q)');
  assert.equal(applyTemplate('Translate to French.', { input: 'data', prompt: 'q' }), 'Translate to French.\n\ndata');
  assert.equal(applyTemplate('', { input: 'data', prompt: 'q' }), 'data');
  const graph = {
    nodes: [node('in', 'input'), node('a', 'agent', { agentId: 'agent-a' }), node('b', 'agent', { agentId: 'agent-b', inputTemplate: 'Merge:\n{{input}}' }), node('out', 'output')],
    edges: [edge('in', 'a'), edge('in', 'b'), edge('a', 'b'), edge('b', 'out')]
  };
  const { calls, runAgent } = recorder();
  const result = await runWorkflow({ graph, prompt: 'p', agents, runAgent });
  assert.equal(result.status, 'completed');
  assert.equal(calls[1].prompt, 'Merge:\n### Input\np\n\n### Researcher\nResearcher(p)');
});

test('invalid workflows are reported before anything runs', async () => {
  const { calls, runAgent } = recorder();
  const run = graph => runWorkflow({ graph, prompt: 'p', agents, runAgent });
  let result = await run({ nodes: [node('out', 'output')], edges: [] });
  assert.match(result.error, /Add an Input node/);
  result = await run({ nodes: [node('in', 'input'), node('a', 'agent', { agentId: 'agent-a' })], edges: [edge('in', 'a')] });
  assert.match(result.error, /Output node/);
  result = await run({ nodes: [node('in', 'input'), node('a', 'agent'), node('out', 'output')], edges: [edge('in', 'a'), edge('a', 'out')] });
  assert.match(result.error, /Choose an agent/);
  result = await run({ nodes: [node('in', 'input'), node('a', 'agent', { agentId: 'gone' }), node('out', 'output')], edges: [edge('in', 'a'), edge('a', 'out')] });
  assert.match(result.error, /no longer exists/);
  result = await run({ nodes: [node('in', 'input'), node('a', 'agent', { agentId: 'agent-a' }), node('md', 'markdown', { content: '  ' }), node('out', 'output')], edges: [edge('in', 'a'), edge('a', 'out'), edge('md', 'a')] });
  assert.match(result.error, /no instructions yet/);
  result = await runWorkflow({ graph: emptyGraph(), prompt: '   ', agents, runAgent });
  assert.match(result.error, /Write a message/);
  assert.equal(result.status, 'failed');
  assert.equal(calls.length, 0);
});

test('connection rules: loops, duplicates, ports and unknown types are rejected', () => {
  const graph = { nodes: [node('in', 'input'), node('a', 'agent'), node('b', 'agent'), node('md', 'markdown'), node('out', 'output')], edges: [edge('in', 'a'), edge('a', 'b')] };
  assert.equal(connectionProblem(graph, 'b', 'out'), null);
  assert.match(connectionProblem(graph, 'b', 'a'), /loop/);
  assert.match(connectionProblem(graph, 'a', 'a'), /itself/);
  assert.match(connectionProblem(graph, 'in', 'a'), /already connected/);
  assert.match(connectionProblem(graph, 'out', 'a'), /no output/);
  assert.match(connectionProblem(graph, 'a', 'in'), /do not accept/);
  assert.match(connectionProblem(graph, 'a', 'md'), /do not accept/);
  assert.match(connectionProblem(graph, 'a', 'nope'), /does not exist/);
  assert.throws(() => cleanGraph({ nodes: [node('a', 'agent'), node('b', 'agent')], edges: [edge('a', 'b'), edge('b', 'a')] }), /loop/);
  assert.throws(() => cleanGraph({ nodes: [node('x', 'constructor')], edges: [] }), /not supported/);
  assert.throws(() => cleanGraph({ nodes: [node('in', 'input'), node('in2', 'input')], edges: [] }), /only 1 Input/);
  assert.throws(() => cleanGraph({ nodes: [node('a', 'agent'), node('a', 'agent')], edges: [] }), /unique/);
  assert.throws(() => cleanGraph({ nodes: [{ id: 'a', type: 'agent', x: 'left', y: 0 }], edges: [] }), /position/);
  assert.throws(() => cleanGraph({ nodes: [node('bad id!', 'agent')], edges: [] }), /Invalid workflow node/);
  // A plan built from a hand-made cyclic graph (bypassing cleanGraph) still refuses to run.
  const cyclic = { nodes: [node('in', 'input'), node('a', 'agent'), node('b', 'agent')], edges: [edge('in', 'a'), edge('a', 'b'), edge('b', 'a')] };
  assert.match(planWorkflow(cyclic).issues[0].message, /loop/);
  const cleaned = cleanGraph({ nodes: [{ id: 'a', type: 'agent', x: 10.6, y: 5, config: { agentId: 'x', extra: 'dropped', instructions: 5 } }], edges: [], view: { zoom: 9 } });
  assert.deepEqual(cleaned.nodes[0], { id: 'a', type: 'agent', x: 11, y: 5, title: '', config: { agentId: 'x', instructions: '', inputTemplate: '{{input}}' } });
  assert.equal(cleaned.view.zoom, 2);
});

test('a failing agent stops the run with a meaningful error; cancel stops it mid-step', async () => {
  const graph = { nodes: [node('in', 'input'), node('a', 'agent', { agentId: 'agent-a' }), node('b', 'agent', { agentId: 'agent-b' }), node('out', 'output')], edges: [edge('in', 'a'), edge('a', 'b'), edge('b', 'out')] };
  const { events, emit } = collect(); let ran = 0;
  const failing = await runWorkflow({ graph, prompt: 'p', agents, emit, runAgent: async () => { ran++; throw new Error('Model crashed.'); } });
  assert.equal(failing.status, 'failed');
  assert.equal(failing.error, 'Researcher: Model crashed.');
  assert.equal(ran, 1);
  assert.ok(events.some(e => e.type === 'node-error' && e.nodeId === 'a'));
  assert.ok(!events.some(e => e.type === 'node-start' && e.nodeId === 'b'));

  const empty = await runWorkflow({ graph, prompt: 'p', agents, runAgent: async () => '   ' });
  assert.match(empty.error, /empty response/);

  const controller = new AbortController(); const cancelEvents = collect(); let calls = 0;
  const cancelled = await runWorkflow({ graph, prompt: 'p', agents, signal: controller.signal, emit: cancelEvents.emit,
    runAgent: ({ signal }) => new Promise((resolve, reject) => { calls++; signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); setTimeout(() => controller.abort(), 10); }) });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(cancelEvents.events.at(-1).type, 'run-cancelled');
  assert.ok(!cancelEvents.events.some(e => e.type === 'run-done'));
});

test('agents and workflows persist per account with their graph intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-automation-'));
  let store = createWorkspace(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = store.saveAgent('user-a', { name: '  Researcher ', description: 'Finds facts', instructions: 'Be exact.', model: 'qwen2.5:1.5b' });
  assert.equal(agent.name, 'Researcher');
  assert.equal(store.saveAgent('user-a', { ...agent, name: 'Analyst' }).name, 'Analyst');
  assert.equal(store.listAgents('user-a').length, 1);
  assert.equal(store.listAgents('user-b').length, 0);
  assert.throws(() => store.saveAgent('user-b', { ...agent, name: 'Stolen' }), /not found/);
  assert.throws(() => store.deleteAgent('user-b', agent.id), /not found/);
  assert.throws(() => store.saveAgent('user-a', { name: '', model: 'm' }), /Agent name/);
  assert.throws(() => store.saveAgent('user-a', { name: 'x', model: 'bad model name' }), /Choose a model/);

  const created = store.createWorkflow('user-a', {});
  assert.equal(created.title, 'Untitled workflow');
  assert.deepEqual(created.graph.nodes.map(n => n.type), ['input', 'output']);
  const graph = {
    nodes: [node('in', 'input', {}, 40, 60), node('a', 'agent', { agentId: agent.id, instructions: 'Extra', inputTemplate: 'Q: {{input}}' }, 320, 80), node('md', 'markdown', { content: '# Rules', filename: 'rules.md' }, 300, 300), node('out', 'output', {}, 640, 60)],
    edges: [edge('in', 'a'), edge('md', 'a'), edge('a', 'out')], view: { x: -20, y: 14, zoom: 1.25 }
  };
  store.updateWorkflow('user-a', created.id, { title: 'Research flow', description: 'Looks things up', graph });
  assert.throws(() => store.updateWorkflow('user-b', created.id, { title: 'x' }), /not found/);
  assert.throws(() => store.updateWorkflow('user-a', created.id, { graph: { nodes: [node('a', 'agent'), node('b', 'agent')], edges: [edge('a', 'b'), edge('b', 'a')] } }), /loop/);
  const copy = store.duplicateWorkflow('user-a', created.id);
  assert.equal(copy.title, 'Research flow copy');
  assert.notEqual(copy.id, created.id);

  store.close(); store = createWorkspace(root); // reopen: positions, connections and configuration survive
  const reopened = store.getWorkflow('user-a', created.id);
  assert.equal(reopened.title, 'Research flow');
  assert.equal(reopened.description, 'Looks things up');
  assert.deepEqual(reopened.graph.nodes.map(n => [n.id, n.x, n.y]), [['in', 40, 60], ['a', 320, 80], ['md', 300, 300], ['out', 640, 60]]);
  assert.deepEqual(reopened.graph.edges.map(e => [e.from, e.to]), [['in', 'a'], ['md', 'a'], ['a', 'out']]);
  assert.deepEqual(reopened.graph.nodes[1].config, { agentId: agent.id, instructions: 'Extra', inputTemplate: 'Q: {{input}}' });
  assert.deepEqual(reopened.graph.nodes[2].config, { content: '# Rules', filename: 'rules.md' });
  assert.deepEqual(reopened.graph.view, { x: -20, y: 14, zoom: 1.25 });
  assert.equal(store.listWorkflows('user-a').length, 2);
  assert.equal(store.listWorkflows('user-b').length, 0);
  store.deleteWorkflow('user-a', copy.id);
  assert.throws(() => store.getWorkflow('user-a', copy.id), /not found/);
  store.deleteAgent('user-a', agent.id);
  assert.equal(store.listAgents('user-a').length, 0);
});

test('Ollama adapter: streams a response, lists models, and reports clear errors', async t => {
  // A local HTTP server speaking Ollama's wire format, so the adapter's real fetch/stream code runs.
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'b-model', details: { parameter_size: '7B' } }, { name: 'a-model:cloud', remote_host: 'https://example.invalid' }] })); return; }
      const payload = JSON.parse(body); requests.push(payload);
      if (payload.model === 'missing') { response.statusCode = 404; response.end(JSON.stringify({ error: 'model "missing" not found' })); return; }
      if (payload.model === 'slow') { response.write(`${JSON.stringify({ message: { content: 'start' } })}\n`); return; } // never finishes
      response.write(`${JSON.stringify({ message: { content: 'Hel' } })}\n${JSON.stringify({ message: { content: 'lo' } }).slice(0, 12)}`);
      setTimeout(() => response.end(`${JSON.stringify({ message: { content: 'lo' } }).slice(12)}\n${JSON.stringify({ message: { content: '' }, done: true })}\n`), 15);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const runtime = createOllamaRuntime({ base: `http://127.0.0.1:${server.address().port}` });

  const listed = await runtime.listModels();
  assert.deepEqual(listed, { available: true, error: null, models: [{ name: 'a-model:cloud', size: '', bytes: 0, cloud: true }, { name: 'b-model', size: '7B', bytes: 0, cloud: false }] });

  const deltas = [];
  const text = await runtime.runAgent({ agent: { name: 'A', model: 'ok' }, system: 'sys', prompt: 'hi', onDelta: piece => deltas.push(piece) });
  assert.equal(text, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.deepEqual(requests[0].messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(requests[0].stream, true);

  await assert.rejects(runtime.runAgent({ agent: { name: 'A', model: 'missing' }, system: '', prompt: 'hi' }), /not installed in Ollama/);
  const controller = new AbortController();
  const pending = runtime.runAgent({ agent: { name: 'A', model: 'slow' }, system: '', prompt: 'hi', signal: controller.signal, onDelta: () => controller.abort() });
  await assert.rejects(pending, error => error.name === 'AbortError');

  const offline = createOllamaRuntime({ base: 'http://127.0.0.1:1' });
  assert.deepEqual(await offline.listModels(), { available: false, models: [], error: 'Ollama is not running on this computer. Start Ollama and try again.' });
  await assert.rejects(offline.runAgent({ agent: { name: 'A', model: 'ok' }, system: '', prompt: 'hi' }), /Ollama is not running/);
});

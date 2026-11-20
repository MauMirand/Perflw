const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { createWorkspace } = require('../src/workspace');
const { createEcosystem } = require('../src/automation/ecosystem');
const { createProviders, redact } = require('../src/automation/providers');
const { runWorkflow } = require('../src/automation/engine');
const { assembleContext } = require('../src/automation/context');
const { createToolbox } = require('../src/automation/tools');

const USER = 'user-a';
// Test codec standing in for safeStorage: reversible, but never stores the plain key bytes.
const secrets = { available: () => true, encrypt: text => Buffer.from(`v1:${Buffer.from(text).toString('base64').split('').reverse().join('')}`), decrypt: bytes => Buffer.from(bytes.toString().slice(3).split('').reverse().join(''), 'base64').toString() };

/* Local OpenAI-compatible server. `script` decides each reply from the request body. */
async function fakeOpenAi(t, script) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = body ? JSON.parse(body) : null;
      requests.push({ url: request.url, headers: request.headers, body: payload });
      if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'local-model' }, { id: 'other-model' }] })); return; }
      const reply = script(payload, requests);
      if (reply.status) { response.statusCode = reply.status; response.end(JSON.stringify(reply.body)); return; }
      if (payload.stream) {
        response.setHeader('content-type', 'text/event-stream');
        for (const piece of reply.text.match(/.{1,5}/gs) || []) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        response.end('data: [DONE]\n\n'); return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: reply.text || '', tool_calls: reply.toolCalls } }], usage: { prompt_tokens: 50, completion_tokens: 7 } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-eco-'));
  const workspace = createWorkspace(root);
  const eco = createEcosystem({ root, workspace, secrets, ...options });
  t.after(() => { workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, eco };
}
async function customAgent(eco, baseUrl, extra = {}) {
  const connection = eco.saveConnection(USER, { type: 'openai-compatible', label: 'Local test', baseUrl, model: 'local-model', apiKey: 'sk-testsecret-1234567890abcd', ...extra });
  const agent = eco.createAgent(USER, { name: 'Researcher', description: 'Finds facts', connectionId: connection.id, model: 'local-model' });
  return { connection, agent };
}
const run = (eco, agent, prompt, extra = {}) => eco.runAgent(USER, { agent, prompt, ...extra }, extra.hooks || {});

test('existing agents migrate into editable packages without losing data, and edits reach the runtime', async t => {
  const { workspace, eco, root } = setup(t);
  const legacy = workspace.saveAgent(USER, { name: 'Legacy', description: 'Old agent', instructions: 'Answer in French.', model: 'qwen2.5:1.5b' });
  const [listed] = eco.listAgents(USER);
  assert.equal(listed.id, legacy.id);
  assert.equal(listed.provider.id, 'ollama-local');
  assert.equal(listed.model, 'qwen2.5:1.5b');
  const detail = eco.getAgent(USER, legacy.id);
  assert.equal(detail.files['instructions.md'], 'Answer in French.');
  assert.deepEqual(Object.keys(detail.files).sort(), ['capabilities.md', 'configuration.json', 'context.md', 'identity.md', 'instructions.md']);
  assert.ok(detail.tree.some(item => item.path === 'resources' && item.kind === 'dir'));
  assert.equal(workspace.getAgent(USER, legacy.id).instructions, 'Answer in French.', 'registry row left intact');

  // Edit through the file API: the legacy column mirrors it and an earlier version is kept.
  eco.writeAgentFile(USER, legacy.id, 'instructions.md', 'Answer in Spanish.');
  assert.equal(workspace.getAgent(USER, legacy.id).instructions, 'Answer in Spanish.');
  const history = fs.readdirSync(path.join(root, 'agent-ecosystem', USER, 'agents', legacy.id, '.history'));
  assert.ok(history.some(name => name.startsWith('instructions.md.')));

  // Validation: bad JSON and bad values are refused with useful messages; disallowed paths are refused.
  assert.throws(() => eco.writeAgentFile(USER, legacy.id, 'configuration.json', '{ nope'), /not valid JSON/);
  assert.throws(() => eco.writeAgentFile(USER, legacy.id, 'configuration.json', JSON.stringify({ provider: { connectionId: 'ollama-local', model: '' } })), /provider\.model/);
  assert.throws(() => eco.writeAgentFile(USER, legacy.id, '../escape.md', 'x'), /not allowed|Agents can contain/);
  assert.throws(() => eco.writeAgentFile(USER, legacy.id, 'resources/../../escape.md', 'x'), /not allowed/);
  assert.throws(() => eco.writeAgentFile(USER, legacy.id, 'resources/tool.exe', 'x'), /Agents can contain/);
  assert.throws(() => eco.getAgent('user-b', legacy.id), /not found/);
});

test('runtime loads current identity, instructions, context and provider; credentials stay encrypted and redacted', async t => {
  const server = await fakeOpenAi(t, payload => ({ text: `seen ${payload.messages.length} messages` }));
  const { eco, root } = setup(t);
  const { connection, agent } = await customAgent(eco, server.baseUrl);
  eco.writeAgentFile(USER, agent.id, 'identity.md', 'You are a careful researcher.');
  eco.writeAgentFile(USER, agent.id, 'instructions.md', 'Always cite sources.');
  eco.writeAgentFile(USER, agent.id, 'context.md', 'The team is based in Cebu.');
  const deltas = [];
  const text = await run(eco, agent, 'Summarize the news', { onDelta: piece => deltas.push(piece) });
  assert.equal(text, 'seen 2 messages');
  assert.ok(deltas.length > 1, 'streamed in pieces');
  const sent = server.requests.find(item => item.url === '/v1/chat/completions');
  const system = sent.body.messages[0].content;
  assert.match(system, /careful researcher/); assert.match(system, /Always cite sources/); assert.match(system, /based in Cebu/);
  assert.match(system, /follow this order/);
  assert.equal(sent.headers.authorization, 'Bearer sk-testsecret-1234567890abcd');
  assert.equal(sent.body.model, 'local-model');

  // Edit → next run uses the new text (no stale snapshot).
  eco.writeAgentFile(USER, agent.id, 'instructions.md', 'Never cite sources.');
  await run(eco, agent, 'Again');
  assert.match(server.requests.at(-1).body.messages[0].content, /Never cite sources/);

  // The key is never returned, never stored in plain text, never in agent files or exports.
  const listed = eco.listConnections(USER).find(item => item.id === connection.id);
  assert.equal(listed.hasKey, true); assert.equal(JSON.stringify(listed).includes('testsecret'), false);
  const db = new DatabaseSync(path.join(root, 'workspace.sqlite'));
  const raw = db.prepare('SELECT secret FROM provider_connections').get().secret; db.close();
  assert.equal(Buffer.from(raw).toString().includes('sk-testsecret'), false);
  const exportDir = path.join(root, 'export-agent');
  eco.exportAgent(USER, agent.id, exportDir);
  const exported = fs.readdirSync(exportDir).map(name => (fs.statSync(path.join(exportDir, name)).isFile() ? fs.readFileSync(path.join(exportDir, name), 'utf8') : '')).join('\n');
  assert.equal(exported.includes('testsecret'), false);
  assert.match(exported, /Never cite sources/);

  // Import creates a new agent from the export.
  const imported = eco.importAgent(USER, exportDir);
  assert.equal(imported.agent.name, 'Researcher');
  assert.notEqual(imported.agent.id, agent.id);
  assert.equal(imported.agent.files['instructions.md'], 'Never cite sources.');

  assert.equal(redact('failed for sk-testsecret-1234567890abcd and Bearer abc.def', 'sk-testsecret-1234567890abcd'), 'failed for [redacted] and Bearer [redacted]');
});

test('provider failures are reported clearly without crashing or leaking the key', async t => {
  const server = await fakeOpenAi(t, () => ({ status: 401, body: { error: { message: 'Incorrect API key provided: sk-testsecret-1234567890abcd' } } }));
  const { eco } = setup(t);
  const { connection, agent } = await customAgent(eco, server.baseUrl);
  await assert.rejects(run(eco, agent, 'hi'), error => /rejected the API key/.test(error.message) && !error.message.includes('testsecret'));
  // Connection test: valid list, missing model, unreachable endpoint, missing key.
  const ok = await eco.testConnection(USER, { id: connection.id });
  assert.equal(ok.ok, true); assert.deepEqual(ok.models, ['local-model', 'other-model']);
  const unknownModel = await eco.testConnection(USER, { id: connection.id, model: 'ghost' });
  assert.match(unknownModel.message, /not in its model list/);
  const down = await eco.testConnection(USER, { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' });
  assert.equal(down.ok, false); assert.match(down.message, /refused|reached/);
  const noKey = await eco.testConnection(USER, { type: 'openai', apiKey: '' });
  assert.equal(noKey.ok, false); assert.match(noKey.message, /needs an API key/);
  assert.throws(() => eco.saveConnection(USER, { type: 'anthropic', apiKey: '' }), /needs an API key/);
  assert.throws(() => eco.saveConnection(USER, { type: 'openai-compatible', baseUrl: 'http://example.com/v1' }), /Use https/);
  assert.throws(() => eco.removeConnection(USER, connection.id), /used by Researcher/);
  assert.throws(() => eco.removeConnection(USER, 'ollama-local'), /built in/);
  // Removing the provider of an agent is blocked; a manually broken config gives an actionable run error.
  eco.writeAgentFile(USER, agent.id, 'configuration.json', JSON.stringify({ provider: { connectionId: 'deleted-conn', model: 'x' } }));
  await assert.rejects(run(eco, agent, 'hi'), /provider connection .* was removed/);
});

test('skills: progressive loading, references on demand, disabled skills skipped, shared across agents', async t => {
  const server = await fakeOpenAi(t, () => ({ text: 'ok' }));
  const { eco } = setup(t);
  const { agent } = await customAgent(eco, server.baseUrl);
  const second = eco.createAgent(USER, { name: 'Writer', connectionId: 'ollama-local', model: 'qwen2.5:1.5b' });
  const summarize = eco.createSkill(USER, { name: 'Article summary', description: 'Summarize news articles into three bullet points' });
  eco.writeSkillFile(USER, summarize.id, 'SKILL.md', '---\nname: Article summary\ndescription: Summarize news articles into three bullet points\nenabled: true\nactivation: auto\ntriggers: summarize, summary, article\n---\nUse exactly three bullets. SUMMARY-BODY');
  eco.writeSkillFile(USER, summarize.id, 'references/style-guide.md', 'Bullets start with a verb. STYLE-REF');
  eco.writeSkillFile(USER, summarize.id, 'references/legal-notes.md', 'Unrelated licensing text. LEGAL-REF');
  const tax = eco.createSkill(USER, { name: 'Tax filing', description: 'Prepare quarterly tax filings and VAT returns' });
  eco.writeSkillFile(USER, tax.id, 'SKILL.md', '---\nname: Tax filing\ndescription: Prepare quarterly tax filings and VAT returns\n---\nTAX-BODY');
  const always = eco.createSkill(USER, { name: 'House tone', description: 'Company writing tone' });
  eco.writeSkillFile(USER, always.id, 'SKILL.md', '---\nname: House tone\ndescription: Company writing tone\nactivation: always\n---\nTONE-BODY');
  assert.throws(() => eco.writeSkillFile(USER, tax.id, 'SKILL.md', 'no front matter'), /front matter/);

  eco.updateAgentConfig(USER, agent.id, { skills: [summarize.id, tax.id, always.id] });
  eco.updateAgentConfig(USER, second.id, { skills: [summarize.id] });
  assert.deepEqual(eco.getSkill(USER, summarize.id).usedBy.map(item => item.name).sort(), ['Researcher', 'Writer']);
  assert.throws(() => eco.updateAgentConfig(USER, agent.id, { skills: ['ghost'] }), /does not exist/);

  let diagnostics = null;
  await run(eco, agent, 'Please summarize this article in our style', { onDiagnostics: value => { diagnostics = value; } });
  let system = server.requests.at(-1).body.messages[0].content;
  assert.match(system, /SUMMARY-BODY/); assert.match(system, /TONE-BODY/);
  assert.match(system, /STYLE-REF/, 'reference whose name matches the task is loaded');
  assert.doesNotMatch(system, /LEGAL-REF/, 'unrelated reference is not loaded');
  assert.doesNotMatch(system, /TAX-BODY/, 'irrelevant skill body is not loaded');
  assert.match(system, /Tax filing: Prepare quarterly tax filings/, 'irrelevant skill still listed by description');
  const status = Object.fromEntries(diagnostics.skills.map(item => [item.name, item.status]));
  assert.deepEqual(status, { 'Article summary': 'selected', 'Tax filing': 'catalog', 'House tone': 'selected' });
  assert.ok(diagnostics.estimatedTokens > 0 && diagnostics.items.some(item => item.source === 'identity.md'));

  // Disabled skills are not loaded; per-node override replaces the agent's skill list.
  eco.setSkillEnabled(USER, summarize.id, false);
  await run(eco, agent, 'Please summarize this article', { onDiagnostics: value => { diagnostics = value; } });
  system = server.requests.at(-1).body.messages[0].content;
  assert.doesNotMatch(system, /SUMMARY-BODY/);
  assert.equal(diagnostics.skills.find(item => item.id === summarize.id).status, 'disabled');
  eco.setSkillEnabled(USER, summarize.id, true);
  await run(eco, agent, 'Prepare the VAT filing', { skills: [tax.id], onDiagnostics: value => { diagnostics = value; } });
  system = server.requests.at(-1).body.messages[0].content;
  assert.match(system, /TAX-BODY/); assert.doesNotMatch(system, /TONE-BODY/);
  assert.equal(diagnostics.skillSource, 'node override');

  // Duplicate, export/import, delete (unassigns from agents).
  const copy = eco.duplicateSkill(USER, summarize.id);
  assert.equal(copy.name, 'Article summary copy');
  const dir = path.join(os.tmpdir(), `perflw-skill-export-${Date.now()}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  eco.exportSkill(USER, summarize.id, dir);
  assert.ok(fs.existsSync(path.join(dir, 'references', 'style-guide.md')));
  const imported = eco.importSkill(USER, dir);
  assert.notEqual(imported.skill.id, summarize.id);
  eco.deleteSkill(USER, summarize.id);
  assert.equal(eco.getAgent(USER, second.id).config.skills.includes(summarize.id), false);
});

test('permissions are enforced at execution time; approvals gate high-impact actions; tool use is logged', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-access-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'SECRET-PLAN: launch on Friday');
  const outside = path.join(os.tmpdir(), `perflw-outside-${Date.now()}.txt`); fs.writeFileSync(outside, 'outside'); t.after(() => fs.rmSync(outside, { force: true }));
  // The model asks for tools in turn; the final answer echoes the last tool result it received.
  const server = await fakeOpenAi(t, payload => {
    const last = payload.messages.at(-1);
    if (payload.stream) return { text: 'streamed without tools' };
    if (last.role === 'tool') return { text: `final: ${last.content}` };
    const wanted = JSON.parse(payload.messages.at(-1).content.match(/CALL (.*)$/)[1]);
    return { toolCalls: [{ id: 'c1', type: 'function', function: { name: wanted.name, arguments: JSON.stringify(wanted.args) } }] };
  });
  const { eco } = setup(t);
  const { agent } = await customAgent(eco, server.baseUrl, { supportsTools: true });
  const ask = (name, args) => `CALL ${JSON.stringify({ name, args })}`;
  const logs = [];

  // Safe defaults: nothing granted → no tools offered; a forged call is denied by the execution-time gate.
  let text = await run(eco, agent, ask('read_file', { path: path.join(folder, 'notes.txt') }));
  assert.equal(server.requests.at(-1).body.tools, undefined); assert.equal(text, 'streamed without tools');
  const box = createToolbox({ agentName: 'R', config: eco.getAgent(USER, agent.id).config, providerTools: true, skills: { assigned: [] }, workflow: null, userId: USER, requestApproval: async () => true, log: entry => logs.push(entry) });
  assert.deepEqual(box.definitions, []);
  assert.match((await box.execute({ name: 'read_file', arguments: { path: path.join(folder, 'notes.txt') } })).content, /not available to you/);
  assert.equal(logs[0].outcome, 'denied');

  eco.updateAgentConfig(USER, agent.id, { permissions: { fileRead: true, fileWrite: true }, fileAccess: { folders: [folder] } });
  text = await run(eco, agent, ask('read_file', { path: path.join(folder, 'notes.txt') }));
  assert.match(text, /SECRET-PLAN/);
  assert.deepEqual(server.requests.at(-2).body.tools.map(tool => tool.function.name).sort(), ['list_files', 'read_file', 'write_file']);
  text = await run(eco, agent, ask('read_file', { path: outside }));
  assert.match(text, /outside the folders/);

  // Writes need approval: declined → no file; allowed → file written.
  const target = path.join(folder, 'out.txt'); const approvals = [];
  text = await run(eco, agent, ask('write_file', { path: target, content: 'hello' }), { hooks: { requestApproval: async request => { approvals.push(request.title); return false; } } });
  assert.match(text, /declined/); assert.equal(fs.existsSync(target), false); assert.equal(approvals.length, 1);
  text = await run(eco, agent, ask('write_file', { path: target, content: 'hello' }), { hooks: { requestApproval: async () => true } });
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');

  // Revoking the permission takes effect on the next run, even if the model still asks for the tool.
  eco.updateAgentConfig(USER, agent.id, { permissions: { fileRead: false, fileWrite: false } });
  text = await run(eco, agent, ask('read_file', { path: path.join(folder, 'notes.txt') }));
  assert.equal(text, 'streamed without tools', 'no file tools offered after revoking');

  // Skill scripts: need skillScripts + codeExecution + assignment + approval; skills cannot elevate.
  const skill = eco.createSkill(USER, { name: 'Counter', description: 'Counts words in text' });
  eco.writeSkillFile(USER, skill.id, 'scripts/count.js', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('words:'+s.trim().split(/\\s+/).length));");
  eco.updateAgentConfig(USER, agent.id, { skills: [skill.id], permissions: { skillScripts: true } });
  await assert.rejects(eco.runSkillScript(USER, { agentId: agent.id, skillId: skill.id, script: 'scripts/count.js', input: 'a b c' }, { requestApproval: async () => true }), /not allowed to run skill scripts/);
  text = await run(eco, agent, ask('run_skill_script', { skill: skill.id, script: 'scripts/count.js', input: 'a b c' }));
  assert.equal(text, 'streamed without tools', 'without codeExecution the script tool is not offered');
  eco.updateAgentConfig(USER, agent.id, { permissions: { codeExecution: true } });
  await assert.rejects(eco.runSkillScript(USER, { agentId: agent.id, skillId: skill.id, script: 'scripts/count.js', input: 'a b c' }, { requestApproval: async () => false }), /declined/);
  const manual = await eco.runSkillScript(USER, { agentId: agent.id, skillId: skill.id, script: 'scripts/count.js', input: 'a b c' }, { requestApproval: async () => true });
  assert.equal(manual.ok, true); assert.match(manual.output, /words:3/);
  text = await run(eco, agent, ask('run_skill_script', { skill: skill.id, script: 'scripts/count.js', input: 'one two' }), { hooks: { requestApproval: async () => true } });
  assert.match(text, /words:2/);
});

test('context budgeting: overflow is a clear error; low-priority context is trimmed first', async t => {
  const server = await fakeOpenAi(t, () => ({ text: 'ok' }));
  const { eco } = setup(t);
  const { agent } = await customAgent(eco, server.baseUrl, { contextWindow: 2000 });
  eco.updateAgentConfig(USER, agent.id, { context: { responseReserveTokens: 500 } });
  eco.writeAgentFile(USER, agent.id, 'context.md', 'background '.repeat(2000));
  let diagnostics;
  await run(eco, agent, 'short task', { onDiagnostics: value => { diagnostics = value; } });
  const contextItem = diagnostics.items.find(item => item.source === 'context.md');
  assert.equal(contextItem.status, 'truncated');
  assert.ok(diagnostics.estimatedTokens <= diagnostics.available);
  await assert.rejects(run(eco, agent, 'x'.repeat(8000)), error => error.name === 'ContextOverflowError' && /larger context window/.test(error.message));

  // Pure assembler: duplicates are included once.
  const assembled = assembleContext({
    agent: { name: 'A', identity: 'Same text.', instructions: 'Same text.', capabilities: '', context: '', resources: [] }, task: 'hi', skills: [],
    loadSkillBody: () => '', loadReference: () => '', workflowInstructions: [{ name: 'md', content: 'Same text.' }], nodeInstructions: '', tools: [],
    budget: { contextWindow: 4000, contextSource: 'test', responseReserve: 500, maxSkills: 3 }
  });
  assert.equal(assembled.system.match(/Same text\./g).length, 1);
  assert.equal(assembled.diagnostics.items.filter(item => item.status === 'duplicate').length, 2);
});

test('workflow Agent nodes use the saved agent, provider, skills, Markdown and upstream output; older workflows still run', async t => {
  const server = await fakeOpenAi(t, payload => ({ text: `[${payload.messages.at(-1).content}]` }));
  const { eco, workspace } = setup(t);
  const { agent } = await customAgent(eco, server.baseUrl);
  const writer = eco.createAgent(USER, { name: 'Writer', connectionId: eco.listConnections(USER)[1].id, model: 'other-model' });
  const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, title: '', config });
  const graph = {
    nodes: [node('in', 'input'), node('r', 'agent', { agentId: agent.id }), node('md', 'markdown', { content: 'WORKFLOW-RULE: be brief' }), node('w', 'agent', { agentId: writer.id, inputTemplate: 'Polish: {{input}}' }), node('out', 'output')],
    edges: [{ from: 'in', to: 'r' }, { from: 'r', to: 'w' }, { from: 'md', to: 'w' }, { from: 'w', to: 'out' }]
  };
  // Saved through the existing store (graph JSON unchanged) and run with the ecosystem runtime.
  const saved = workspace.createWorkflow(USER, { title: 'Flow', graph });
  assert.equal('skills' in saved.graph.nodes[1].config, false, 'no new field is added to existing agent nodes');
  const events = [];
  const result = await runWorkflow({ graph: saved.graph, prompt: 'topic', agents: eco.listAgents(USER), runAgent: args => eco.runAgent(USER, args, {}), emit: event => events.push(event) });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.output, '[Polish: [topic]]');
  const writerCall = server.requests.filter(item => item.url === '/v1/chat/completions').at(-1);
  assert.equal(writerCall.body.model, 'other-model');
  assert.match(writerCall.body.messages[0].content, /WORKFLOW-RULE/);
  const diag = events.filter(event => event.type === 'node-diagnostics' && event.nodeId === 'w').at(-1).diagnostics;
  assert.equal(diag.agent.name, 'Writer'); assert.equal(diag.model, 'other-model'); assert.equal(diag.provider.label, 'Local test');
  assert.ok(diag.items.some(item => item.section === 'Workflow instructions' && item.status === 'included'));
  assert.equal(diag.usage, null, 'this OpenAI-compatible stream reports no usage; only the estimate is shown');

  // A deleted agent fails that node gracefully.
  eco.deleteAgent(USER, writer.id);
  const failed = await runWorkflow({ graph: saved.graph, prompt: 'topic', agents: eco.listAgents(USER), runAgent: args => eco.runAgent(USER, args, {}) });
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /no longer exists/);
});

test('local Ollama keeps working through the built-in connection', async t => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }] })); return; }
      if (request.url === '/api/show') { response.end(JSON.stringify({ model_info: { 'qwen2.context_length': 32768 }, capabilities: ['completion'] })); return; }
      const payload = JSON.parse(body); seen.push(payload);
      response.end(`${JSON.stringify({ message: { content: 'Hola' } })}\n${JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 30, eval_count: 2 })}\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { eco, workspace } = setup(t, { ollamaBase: `http://127.0.0.1:${server.address().port}` });
  const legacy = workspace.saveAgent(USER, { name: 'Legacy', instructions: 'Answer in Spanish.', model: 'qwen2.5:1.5b' });
  let diagnostics;
  const text = await eco.runAgent(USER, { agent: eco.listAgents(USER)[0], prompt: 'Hello', onDiagnostics: value => { diagnostics = value; } });
  assert.equal(text, 'Hola');
  assert.equal(seen[0].model, 'qwen2.5:1.5b'); assert.equal(seen[0].stream, true);
  assert.match(seen[0].messages[0].content, /Answer in Spanish/);
  assert.equal(seen[0].options, undefined, 'no num_ctx override unless the agent sets a budget');
  assert.deepEqual(diagnostics.usage, { inputTokens: 30, outputTokens: 2, cachedTokens: 0, source: 'provider-reported' });
  assert.equal(legacy.model, 'qwen2.5:1.5b');
  const models = await eco.listModels(USER, 'ollama-local');
  assert.deepEqual(models.models.map(model => model.id), ['qwen2.5:1.5b']);
});

test('Anthropic and Gemini adapters speak their wire formats (stream, tools, usage, errors)', async () => {
  const calls = [];
  const sse = events => new Response(events.map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, headers: init.headers, body });
    if (url.endsWith('/v1/models?limit=100')) return Response.json({ data: [{ id: 'claude-opus-5-5', max_input_tokens: 1000000 }] });
    if (url.includes('api.anthropic.com/v1/messages') && body.stream) return sse([['message_start', { type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 4 } } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }]]);
    if (url.includes('api.anthropic.com/v1/messages')) return Response.json({ content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: '/x' } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 6 } });
    if (url.includes('streamGenerateContent')) return sse([[null, { candidates: [{ content: { parts: [{ text: 'Gem' }] } }] }], [null, { candidates: [{ content: { parts: [{ text: 'ini' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } }]]);
    if (url.includes(':generateContent')) return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: 'fetch_url', args: { url: 'https://example.com' } } }] } }] });
    if (url.includes('generativelanguage') && url.includes('/models?')) return new Response(JSON.stringify({ error: { message: 'API key not valid. key=AIzaSyDUMMYDUMMYDUMMY123' } }), { status: 403 });
    throw new Error(`unexpected ${url}`);
  };
  const providers = createProviders({ fetchImpl });
  const anthropic = providers.adapterFor('anthropic');
  const connection = { type: 'anthropic', label: 'Anthropic' };
  const deltas = [];
  const streamed = await anthropic.chat({ connection, apiKey: 'sk-ant-key', model: 'claude-opus-5-5', system: 'S'.repeat(10), messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096, cache: true, onDelta: piece => deltas.push(piece) });
  assert.equal(streamed.text, 'Hi there'); assert.deepEqual(deltas, ['Hi ', 'there']);
  assert.deepEqual(streamed.usage, { inputTokens: 15, outputTokens: 3, cachedTokens: 4 });
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-key'); assert.equal(calls[0].headers['anthropic-version'], '2026-10-21');
  assert.deepEqual(calls[0].body.system, [{ type: 'text', text: 'S'.repeat(10), cache_control: { type: 'ephemeral' } }]);
  const tooled = await anthropic.chat({ connection, apiKey: 'k', model: 'm', system: '', maxTokens: 100, tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: {} }] }, { role: 'tool', toolCallId: 'a', content: 'r1' }, { role: 'user', content: 'more' }] });
  assert.deepEqual(tooled.toolCalls, [{ id: 'tu1', name: 'read_file', arguments: { path: '/x' } }]);
  const sent = calls.at(-1).body;
  assert.deepEqual(sent.messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(sent.messages[2].content.map(block => block.type), ['tool_result', 'text']);
  assert.equal(sent.tools[0].input_schema.type, 'object');
  assert.deepEqual(await providers.contextWindow({ type: 'anthropic' }, 'claude-opus-5-5', { apiKey: 'k' }), { tokens: 1000000, source: 'provider model list' });

  const gemini = providers.adapterFor('gemini');
  const g = await gemini.chat({ connection: { type: 'gemini' }, apiKey: 'g-key', model: 'gemini-x', system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(g.text, 'Gemini'); assert.deepEqual(g.usage, { inputTokens: 9, outputTokens: 2, cachedTokens: null });
  assert.equal(calls.at(-1).headers['x-goog-api-key'], 'g-key'); assert.match(calls.at(-1).url, /models\/gemini-x:streamGenerateContent\?alt=sse/);
  const gt = await gemini.chat({ connection: { type: 'gemini' }, apiKey: 'g', model: 'gemini-x', system: '', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'fetch_url', description: 'd', parameters: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } }] });
  assert.equal(gt.toolCalls[0].name, 'fetch_url');
  assert.equal('additionalProperties' in calls.at(-1).body.tools[0].functionDeclarations[0].parameters, false);
  const test = await providers.testConnection({ type: 'gemini', label: 'Gemini' }, 'AIzaSyDUMMYDUMMYDUMMY123');
  assert.equal(test.ok, false); assert.match(test.message, /rejected the API key/); assert.equal(test.message.includes('AIzaSyDUMMY'), false);
});

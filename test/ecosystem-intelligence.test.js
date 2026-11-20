// Agent/skill intelligence, delegation, recovery and workflow coordination (see src/automation/ecosystem.js).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createWorkspace } = require('../src/workspace');
const { createEcosystem } = require('../src/automation/ecosystem');
const { createProviders } = require('../src/automation/providers');
const { runWorkflow } = require('../src/automation/engine');
const { selectSkills, similar } = require('../src/automation/context');

const USER = 'user-a';
const secrets = { available: () => true, encrypt: text => Buffer.from(`v1:${Buffer.from(text).toString('base64')}`), decrypt: bytes => Buffer.from(bytes.toString().slice(3), 'base64').toString() };

/* OpenAI-compatible fake. script(payload, count) → { text } | { toolCalls } | { status, body } | { empty: true }. */
async function fakeOpenAi(t, script) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'local-model' }] })); return; }
      const payload = JSON.parse(body); requests.push(payload);
      const reply = script(payload, requests.length);
      if (reply.status) { response.statusCode = reply.status; response.end(JSON.stringify(reply.body || { error: { message: 'boom' } })); return; }
      if (payload.stream) {
        response.setHeader('content-type', 'text/event-stream');
        if (reply.text) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`);
        response.end('data: [DONE]\n\n'); return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: reply.text || '', tool_calls: reply.toolCalls } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
function setup(t, server, { tools = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-intel-'));
  const workspace = createWorkspace(root);
  const eco = createEcosystem({ root, workspace, secrets });
  t.after(() => { workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const connection = eco.saveConnection(USER, { type: 'openai-compatible', label: 'Local', baseUrl: server.baseUrl, model: 'local-model', supportsTools: tools });
  const make = (name, description = '') => eco.createAgent(USER, { name, description, connectionId: connection.id, model: 'local-model' });
  return { eco, workspace, make };
}
const skillFile = (name, description, extra, body) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`;
const systemOf = payload => payload.messages[0].content;
const call = (name, args) => ({ toolCalls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('skill matching: word families match, generic words do not, triggers outrank descriptions', () => {
  assert.equal(similar('summarize', 'summary'), true);
  assert.equal(similar('translation', 'translate'), true);
  assert.equal(similar('report', 'reply'), false);
  const skill = (id, name, description, triggers = []) => ({ id, name, description, triggers, enabled: true, valid: true, problems: [], activation: 'auto' });
  const candidates = [
    skill('sum', 'Summaries', 'Condense long documents for the team', ['summarize']),
    skill('tr', 'Translation', 'Translate documents for the team into Spanish'),
    skill('inv', 'Invoices', 'Prepare invoice documents for the team')
  ];
  const pick = objective => Object.fromEntries(selectSkills(objective, candidates, 3).map(item => [item.id, item.status]));
  assert.deepEqual(pick('Give me a summary of this memo'), { sum: 'selected', tr: 'catalog', inv: 'catalog' });
  assert.deepEqual(pick('Translate the memo'), { sum: 'catalog', tr: 'selected', inv: 'catalog' });
  // "documents" and "team" appear in every description: on their own they select nothing.
  assert.deepEqual(pick('Share these documents with the team'), { sum: 'catalog', tr: 'catalog', inv: 'catalog' });
  // The cap keeps the best-scoring skills.
  const capped = selectSkills('summarize and translate this invoice', candidates, 1);
  assert.equal(capped.filter(item => item.status === 'selected').length, 1);
  assert.equal(capped.find(item => item.status === 'selected').id, 'sum', 'a trigger match outranks description matches');
});

test('a downstream step selects skills from the workflow objective, and knows its place in the workflow', async t => {
  const server = await fakeOpenAi(t, payload => ({ text: payload.messages.at(-1).content.startsWith('Old pond') ? 'reviewed' : 'Old pond, a frog leaps in' }));
  const { eco, make } = setup(t, server);
  const writer = make('Poet'); const critic = make('Critic');
  const skill = eco.createSkill(USER, { name: 'Haiku review', description: 'Check a haiku for the 5-7-5 form' });
  eco.writeSkillFile(USER, skill.id, 'SKILL.md', skillFile('Haiku review', 'Check a haiku for the 5-7-5 form', 'outcome: A verdict line starting with PASS or FAIL\ntriggers: haiku\n', 'Count syllables per line. HAIKU-METHOD'));
  eco.updateAgentConfig(USER, critic.id, { skills: [skill.id] });
  const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, title: '', config });
  const graph = { nodes: [node('in', 'input'), node('p', 'agent', { agentId: writer.id }), node('c', 'agent', { agentId: critic.id }), node('out', 'output')], edges: [{ from: 'in', to: 'p' }, { from: 'p', to: 'c' }, { from: 'c', to: 'out' }] };
  const events = [];
  const result = await runWorkflow({ graph, prompt: 'Write a haiku about a pond', agents: eco.listAgents(USER), runAgent: args => eco.runAgent(USER, args, {}), emit: event => events.push(event) });
  assert.equal(result.status, 'completed', result.error);
  // The critic's input is the poem itself (no word "haiku" in it); the skill is still chosen from the original request.
  const criticCall = server.requests.at(-1);
  assert.equal(criticCall.messages.at(-1).content, 'Old pond, a frog leaps in');
  const system = systemOf(criticCall);
  assert.match(system, /## Skill 1: Haiku review\nPurpose: Check a haiku for the 5-7-5 form\nIntended outcome: A verdict line starting with PASS or FAIL\nMethod:\nCount syllables per line\. HAIKU-METHOD/);
  assert.match(system, /You are the step “Critic” in a multi-step workflow\./);
  assert.match(system, /Original request that started the workflow: Write a haiku about a pond/);
  assert.match(system, /Your input comes from: Poet\./); assert.match(system, /Your output goes to: Output\./);
  // The first step's input is the request itself, so it is not repeated there.
  assert.doesNotMatch(systemOf(server.requests[0]), /Original request that started/);
  const diag = events.filter(event => event.type === 'node-diagnostics' && event.nodeId === 'c').at(-1).diagnostics;
  assert.equal(diag.skills[0].status, 'selected');
});

test('skills: numbered conflict order, cited references for models without tools, broken links flagged', async t => {
  const server = await fakeOpenAi(t, () => ({ text: 'ok' }));
  const { eco, make } = setup(t, server);
  const agent = make('Writer');
  const a = eco.createSkill(USER, { name: 'Formal tone', description: 'Write customer emails in a formal tone' });
  eco.writeSkillFile(USER, a.id, 'references/phrases.md', 'Approved closings. PHRASES-REF');
  eco.writeSkillFile(USER, a.id, 'references/history.md', 'Old style notes. HISTORY-REF');
  eco.writeSkillFile(USER, a.id, 'SKILL.md', skillFile('Formal tone', 'Write customer emails in a formal tone', '', 'Use the closings in references/phrases.md. See also references/missing.md. FORMAL-BODY'));
  const b = eco.createSkill(USER, { name: 'Friendly tone', description: 'Write customer emails in a friendly tone' });
  eco.writeSkillFile(USER, b.id, 'SKILL.md', skillFile('Friendly tone', 'Write customer emails in a friendly tone', '', 'FRIENDLY-BODY'));
  eco.updateAgentConfig(USER, agent.id, { skills: [b.id, a.id] });
  assert.deepEqual(eco.getSkill(USER, a.id).warnings, ['SKILL.md mentions references/missing.md, but that file is not in the skill.']);
  assert.equal(eco.getSkill(USER, a.id).valid, true, 'a broken link is a warning, not a reason to stop loading the skill');

  await eco.runAgent(USER, { agent: eco.listAgents(USER)[0], prompt: 'Write an email to a customer about a late delivery' });
  const system = systemOf(server.requests.at(-1));
  assert.ok(system.indexOf('## Skill 1: Friendly tone') < system.indexOf('## Skill 2: Formal tone'), 'skills are numbered in assignment order');
  assert.match(system, /an earlier-numbered skill before a later one/);
  assert.match(system, /PHRASES-REF/, 'a reference the skill cites is loaded when the model cannot fetch it');
  assert.doesNotMatch(system, /HISTORY-REF/, 'an uncited, unrelated reference stays out');
});

test('a tool-capable model loads a catalog skill on demand; identical tool calls are not executed twice', async t => {
  const server = await fakeOpenAi(t, (payload, count) => {
    const last = payload.messages.at(-1);
    if (payload.stream) return { text: 'no tools' };
    if (count === 1) return call('load_skill', { skill: 'tax-filing' });
    if (count === 2) return call('load_skill', { skill: 'tax-filing' }); // a looping model repeats itself
    return { text: `done after: ${last.content.slice(0, 60)}` };
  });
  const { eco, make } = setup(t, server, { tools: true });
  const agent = make('Clerk');
  const tax = eco.createSkill(USER, { name: 'Tax filing', description: 'Prepare quarterly VAT returns' });
  eco.writeSkillFile(USER, tax.id, 'SKILL.md', skillFile('Tax filing', 'Prepare quarterly VAT returns', '', 'TAX-METHOD'));
  eco.updateAgentConfig(USER, agent.id, { skills: [tax.id] });
  let diagnostics; const logs = [];
  const text = await eco.runAgent(USER, { agent: eco.listAgents(USER)[0], prompt: 'Help me with the paperwork for March', onDiagnostics: value => { diagnostics = value; }, log: line => logs.push(line) });
  assert.match(text, /^done after: You already made this exact call/);
  const first = server.requests[0];
  assert.doesNotMatch(systemOf(first), /TAX-METHOD/, 'not relevant by keywords, so only the description is sent');
  assert.match(systemOf(first), /tax-filing — Tax filing: Prepare quarterly VAT returns/);
  assert.deepEqual(first.tools.map(tool => tool.function.name), ['load_skill']);
  assert.match(server.requests[1].messages.at(-1).content, /## Skill 1: Tax filing\nPurpose: Prepare quarterly VAT returns\nMethod:\nTAX-METHOD/);
  assert.deepEqual(diagnostics.loadedOnDemand, ['Tax filing']);
  assert.deepEqual(diagnostics.toolCalls.map(entry => entry.outcome), ['ok', 'reused']);
});

test('delegation: only to configured agents, the delegate keeps its own role, no nesting, bounded count', async t => {
  const server = await fakeOpenAi(t, payload => {
    const system = systemOf(payload); const last = payload.messages.at(-1);
    if (/Identity — Translator/.test(system)) return { text: `ES(${last.content})` };
    if (last.role === 'tool') return { text: `Lead got: ${last.content}` };
    if (payload.stream) return { text: 'lead alone' };
    return call('ask_agent', JSON.parse(last.content));
  });
  const { eco, make } = setup(t, server, { tools: true });
  const lead = make('Lead'); const translator = make('Translator', 'Translates text into Spanish'); const outsider = make('Outsider');
  eco.writeAgentFile(USER, translator.id, 'instructions.md', 'Translate into Spanish only.');
  assert.throws(() => eco.updateAgentConfig(USER, lead.id, { delegates: [lead.id] }), /other existing agents/);
  const row = id => eco.listAgents(USER).find(agent => agent.id === id);

  // Not configured → no delegation tool at all.
  assert.equal(await eco.runAgent(USER, { agent: row(lead.id), prompt: JSON.stringify({ agent: 'Translator', task: 'hello' }) }), 'lead alone');
  eco.updateAgentConfig(USER, lead.id, { delegates: [translator.id] });
  eco.updateAgentConfig(USER, translator.id, { delegates: [outsider.id] });
  let diagnostics; const logs = [];
  const text = await eco.runAgent(USER, { agent: row(lead.id), prompt: JSON.stringify({ agent: 'Translator', task: 'good morning' }), onDiagnostics: value => { diagnostics = value; }, log: line => logs.push(line) });
  assert.equal(text, 'Lead got: ES(good morning)');
  const delegateCall = server.requests.find(payload => /Identity — Translator/.test(systemOf(payload)));
  assert.match(systemOf(delegateCall), /Translate into Spanish only\./, 'the delegate runs with its own instructions');
  assert.equal(delegateCall.tools, undefined, 'a delegated agent cannot delegate further');
  assert.match(server.requests.find(payload => payload.tools).tools[0].function.description, /Translator \(Translates text into Spanish\)/);
  assert.deepEqual(diagnostics.delegations.map(item => item.agent), ['Translator']);
  assert.ok(logs.some(line => /Lead asks Translator: good morning/.test(line)));
  // An agent that is not on the list is refused, and the lead is told who it may ask.
  const refused = await eco.runAgent(USER, { agent: row(lead.id), prompt: JSON.stringify({ agent: 'Outsider', task: 'x' }) });
  assert.match(refused, /You can only ask: Translator/);
});

test('recovery: one retry for transient failures and empty replies; no retry for bad keys; identical steps reuse a result', async t => {
  let mode = 'server-error';
  const server = await fakeOpenAi(t, (payload, count) => {
    if (mode === 'server-error') return count === 1 ? { status: 503 } : { text: 'recovered' };
    if (mode === 'empty') { mode = 'ok'; return { text: '' }; }
    if (mode === 'auth') return { status: 401 };
    return { text: `answer ${count}` };
  });
  const { eco, make } = setup(t, server);
  const agent = make('Helper'); const row = () => eco.listAgents(USER)[0];
  const logs = []; let diagnostics;
  assert.equal(await eco.runAgent(USER, { agent: row(), prompt: 'hi', log: line => logs.push(line), onDiagnostics: value => { diagnostics = value; } }), 'recovered');
  assert.equal(server.requests.length, 2); assert.equal(diagnostics.retried, true);
  assert.ok(logs.some(line => /Retrying once/.test(line)));
  mode = 'empty';
  assert.match(await eco.runAgent(USER, { agent: row(), prompt: 'hi', log: line => logs.push(line) }), /^answer/);
  assert.ok(logs.some(line => /empty reply; asking once more/.test(line)));
  mode = 'auth'; const before = server.requests.length;
  await assert.rejects(eco.runAgent(USER, { agent: row(), prompt: 'hi' }), /rejected the API key/);
  assert.equal(server.requests.length, before + 1, 'authentication failures are not retried');

  // Same agent, same context, same input twice in one run → one model call. A different input → a new call.
  mode = 'ok'; const cache = new Map(); const start = server.requests.length;
  const first = await eco.runAgent(USER, { agent: row(), prompt: 'same input' }, { cache });
  const second = await eco.runAgent(USER, { agent: row(), prompt: 'same input', onDiagnostics: value => { diagnostics = value; } }, { cache });
  assert.equal(second, first); assert.equal(server.requests.length, start + 1); assert.equal(diagnostics.reused, true);
  await eco.runAgent(USER, { agent: row(), prompt: 'other input' }, { cache });
  assert.equal(server.requests.length, start + 2);
  // Editing the agent changes its context, so the old result is not reused.
  eco.writeAgentFile(USER, agent.id, 'instructions.md', 'Be brief.');
  await eco.runAgent(USER, { agent: row(), prompt: 'same input' }, { cache });
  assert.equal(server.requests.length, start + 3);
});

test('workflow: same-named steps keep separate outputs; tool loops resend provider-native content', async t => {
  // Engine: two nodes with one title must both be readable by a later step.
  const seen = [];
  const node = (id, type, config = {}, title = '') => ({ id, type, x: 0, y: 0, title, config });
  const graph = { nodes: [node('in', 'input'), node('a', 'agent', { agentId: 'x' }, 'Draft'), node('b', 'agent', { agentId: 'x' }, 'Draft'), node('c', 'agent', { agentId: 'x' }, 'Merge'), node('out', 'output')],
    edges: [{ from: 'in', to: 'a' }, { from: 'in', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'c', to: 'out' }] };
  const result = await runWorkflow({ graph, prompt: 'go', agents: [{ id: 'x', name: 'X', model: 'm', instructions: '' }], runAgent: async args => { seen.push(args.workflow); return `out-${seen.length}`; } });
  assert.equal(result.status, 'completed');
  const merge = seen[2];
  assert.deepEqual([...merge.outputs.keys()], ['Input', 'Draft', 'Draft (2)']);
  assert.deepEqual(merge.upstream, ['Draft', 'Draft']); assert.deepEqual(merge.downstream, ['Output']); assert.equal(merge.step, 'Merge');

  // Anthropic: the assistant turn that asked for a tool goes back with its thinking block untouched.
  const bodies = [];
  const providers = createProviders({ fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); } });
  const native = [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }];
  await providers.adapterFor('anthropic').chat({ connection: { type: 'anthropic' }, apiKey: 'k', model: 'm', system: '', maxTokens: 100, tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }], native }, { role: 'tool', toolCallId: 't1', content: 'data' }] });
  assert.deepEqual(bodies[0].messages[1].content, native);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createWorkspace } = require('../src/workspace');
const { createEcosystem } = require('../src/automation/ecosystem');
const { createChatEngine, analyzeIntent, parseCommand, selectHistory, cleanPlan, extractJson } = require('../src/automation/chat');

const USER = 'user-a';
const KEY = 'sk-testsecret-1234567890abcd';
const secrets = { available: () => true, encrypt: text => Buffer.from(`v1:${Buffer.from(text).toString('base64').split('').reverse().join('')}`), decrypt: bytes => Buffer.from(bytes.toString().slice(3).split('').reverse().join(''), 'base64').toString() };

/* Local OpenAI-compatible server. `script(body, requests)` decides each reply: { text } | { toolCalls } | { status, body } | { hang: true }. */
async function fakeOpenAi(t, script, models = ['local-model', 'other-model']) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = body ? JSON.parse(body) : null;
      if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: models.map(id => ({ id })) })); return; }
      requests.push({ url: request.url, headers: request.headers, body: payload });
      const reply = script(payload, requests);
      if (reply.status) { response.statusCode = reply.status; response.end(JSON.stringify(reply.body || { error: { message: 'failure' } })); return; }
      if (payload.stream) {
        response.setHeader('content-type', 'text/event-stream');
        const pieces = reply.text.match(/.{1,5}/gs) || [];
        if (reply.hang) { response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[0] } }] })}\n\n`); return; } // never finishes
        for (const piece of pieces) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
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
const open = new Map();
function setup(t, root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-chat-'))) {
  const workspace = createWorkspace(root);
  const eco = createEcosystem({ root, workspace, secrets });
  const chat = createChatEngine({ workspace, ecosystem: eco });
  let closed = false;
  open.set(root, (open.get(root) || 0) + 1);
  // Several workspaces may share one folder (restart tests): it is removed when the last one closes.
  const close = () => { if (closed) return; closed = true; workspace.close(); open.set(root, open.get(root) - 1); };
  t.after(() => { close(); if (!open.get(root)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, workspace, eco, chat, close };
}
const connect = (eco, baseUrl, extra = {}) => eco.saveConnection(USER, { type: 'openai-compatible', label: 'Local test', baseUrl, model: 'local-model', apiKey: KEY, ...extra });
function session(workspace, connection, model = 'local-model', extra = {}) {
  const id = workspace.createChat(USER, 'New conversation');
  if (connection) workspace.updateChatSettings(USER, id, { provider: { connectionId: connection.id, model }, ...extra });
  return id;
}
async function turn(chat, chatId, content, options = {}) {
  const events = [];
  const result = await chat.runTurn(USER, chatId, content, { emit: event => events.push(event), ...options });
  return { result, events };
}
const systemOf = request => request.body.messages.find(message => message.role === 'system')?.content || '';
const skillFile = (name, description, body, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`;

test('requests are read without a model call: commands, intent and plans', () => {
  assert.deepEqual(parseCommand('/skill research find sources'), { name: 'skill', args: 'research find sources' });
  assert.equal(parseCommand('/etc/hosts is a file'), null);
  assert.equal(parseCommand('what does /skill do?'), null);

  assert.equal(analyzeIntent('What is the capital of France?').complexity, 'simple');
  assert.equal(analyzeIntent('hi').kind, 'smalltalk');
  assert.equal(analyzeIntent('Thanks, and now make it shorter', { hasHistory: true }).followUp, true);
  const complex = analyzeIntent('Research three project management tools, compare their pricing and features, then recommend one and draft a rollout plan for a team of ten.');
  assert.equal(complex.complexity, 'complex');
  assert.ok(complex.signals.length >= 2);
  assert.equal(analyzeIntent('Plot the monthly totals as a chart').wantsVisual, true);

  assert.deepEqual(extractJson('Sure:\n```json\n{"steps":[{"a":"}"}]}\n```'), { steps: [{ a: '}' }] });
  assert.equal(extractJson('no json here'), null);
  // A step may only depend on earlier steps, so a plan can never contain a cycle.
  const plan = cleanPlan({ steps: [{ title: 'A', instruction: 'do a', dependsOn: [2] }, { title: 'B', instruction: 'do b', dependsOn: [1, 2, 9], agent: 'researcher' }] }, ['Researcher']);
  assert.deepEqual(plan.map(step => step.dependsOn), [[], [1]]);
  assert.equal(plan[1].agent, 'Researcher');
  assert.equal(cleanPlan({ steps: [{ title: 'only', instruction: 'x' }] }), null);
  assert.equal(cleanPlan({ steps: 'nope' }), null);
});

test('history selection keeps recent turns, brings back relevant older ones and never sends notices', () => {
  const messages = [
    { role: 'user', content: 'My invoice numbering scheme starts with INV and the fiscal year.' },
    { role: 'assistant', content: 'Understood: invoice numbers look like INV-2026-001.' },
    ...Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Unrelated filler about gardening number ${index}. `.repeat(20) })),
    { role: 'system', content: 'Skill activated.' },
    { role: 'user', content: 'What about tulips?' },
    { role: 'assistant', content: 'Tulips bloom in spring.' }
  ];
  const picked = selectHistory(messages, { budget: 400, objective: 'Remind me how the invoice numbering scheme works' });
  assert.ok(picked.messages.length >= 2 && picked.messages.length < 10);
  assert.equal(picked.messages[0].role, 'user');
  assert.ok(picked.messages.every(message => message.role !== 'system' && message.content !== 'Skill activated.'));
  assert.ok(picked.tokens <= 400);
  assert.ok(picked.excerpts.some(item => /INV/.test(item.text)), 'the relevant early exchange comes back as an excerpt');
  assert.ok(picked.excerpts.every(item => !/gardening number 3\b/.test(item.text)));
});

test('switching the model inside a conversation changes the real backend and keeps the history', async t => {
  const alpha = await fakeOpenAi(t, () => ({ text: 'Answer from alpha.' }));
  const beta = await fakeOpenAi(t, () => ({ text: 'Answer from beta.' }), ['beta-large']);
  const { workspace, eco, chat } = setup(t);
  const first = connect(eco, alpha.baseUrl);
  const second = connect(eco, beta.baseUrl, { label: 'Second provider', model: 'beta-large' });
  const id = session(workspace, first);

  const one = await turn(chat, id, 'Remember the code word is heron.');
  assert.equal(one.result.status, 'completed');
  assert.equal(alpha.requests.length, 1);
  assert.equal(alpha.requests[0].body.model, 'local-model');
  assert.equal(one.events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Answer from alpha.');

  workspace.updateChatSettings(USER, id, { provider: { connectionId: second.id, model: 'beta-large' } });
  const two = await turn(chat, id, 'What is the code word?');
  assert.equal(two.result.status, 'completed');
  assert.equal(alpha.requests.length, 1, 'the first provider is not called again');
  assert.equal(beta.requests.length, 1);
  assert.equal(beta.requests[0].body.model, 'beta-large');
  const sent = beta.requests[0].body.messages.filter(message => message.role !== 'system');
  assert.deepEqual(sent.map(message => message.content), ['Remember the code word is heron.', 'Answer from alpha.', 'What is the code word?']);

  const stored = workspace.listChatMessages(USER, id);
  assert.deepEqual(stored.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(stored[1].meta.model, 'local-model');
  assert.equal(stored[3].meta.model, 'beta-large');
  assert.equal(stored[3].meta.provider.label, 'Second provider');
  assert.ok(!JSON.stringify(stored).includes(KEY), 'no credential reaches stored messages');
  assert.ok(!JSON.stringify([...one.events, ...two.events]).includes(KEY), 'no credential reaches the interface');
  assert.equal(workspace.getChat(USER, id).title, 'Remember the code word is heron.', 'a new conversation is titled from its first message');

  // /model resolves against the providers' real model lists.
  const viaCommand = await turn(chat, id, '/model other-model');
  assert.equal(viaCommand.result.status, 'command');
  assert.deepEqual(workspace.getChatSettings(USER, id).provider, { connectionId: first.id, model: 'other-model' });
  const unknown = await turn(chat, id, '/model does-not-exist');
  assert.match(workspace.listChatMessages(USER, id).at(-1).content, /No available model matches/);
  assert.equal(unknown.result.status, 'command');
  assert.equal(alpha.requests.length + beta.requests.length, 2, 'commands do not call a model');
});

test('each conversation keeps its own settings, and they survive a restart', async t => {
  const server = await fakeOpenAi(t, () => ({ text: 'ok' }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-chat-'));
  const first = setup(t, root);
  const connection = connect(first.eco, server.baseUrl);
  const a = session(first.workspace, connection, 'local-model', { instructions: 'Answer in French.', prefs: { verify: false, orchestration: 'direct' } });
  const b = session(first.workspace, connection, 'other-model');
  first.workspace.updateChatSettings(USER, a, { skills: ['research'], context: 'Project Falcon.' });
  assert.deepEqual(first.workspace.getChatSettings(USER, b).skills, []);
  assert.equal(first.workspace.getChatSettings(USER, b).instructions, '');
  assert.equal(first.workspace.getChatSettings(USER, b).prefs.verify, true);
  assert.throws(() => first.workspace.updateChatSettings('user-b', a, { instructions: 'x' }), /not found/);
  assert.throws(() => first.workspace.updateChatSettings(USER, a, { prefs: { verify: 'maybe' } }), /Invalid preference/);
  assert.throws(() => first.workspace.updateChatSettings(USER, a, { provider: { connectionId: connection.id, model: '' } }), /model/);

  // A new conversation starts from saved defaults only when the person saved some; never from the last session.
  const plain = first.workspace.createChat(USER, 'New conversation');
  assert.equal(first.workspace.applyChatDefaults(USER, plain).provider, null);
  first.workspace.setChatDefaults(USER, first.workspace.getChatSettings(USER, a));
  const seeded = first.workspace.createChat(USER, 'New conversation');
  const defaults = first.workspace.applyChatDefaults(USER, seeded);
  assert.equal(defaults.instructions, 'Answer in French.');
  assert.equal(defaults.context, '', 'session-specific context is not copied into defaults');
  first.close();

  const second = setup(t, root);
  const restored = second.workspace.getChatSettings(USER, a);
  assert.equal(restored.provider.model, 'local-model');
  assert.equal(restored.instructions, 'Answer in French.');
  assert.deepEqual(restored.skills, ['research']);
  assert.equal(restored.prefs.orchestration, 'direct');
  assert.equal(second.workspace.getChatSettings(USER, b).provider.model, 'other-model');
  await turn(second.chat, a, 'Bonjour?');
  assert.match(systemOf(server.requests.at(-1)), /# Session instructions\nAnswer in French\./);
  assert.match(systemOf(server.requests.at(-1)), /# Session context\nProject Falcon\./);
  await turn(second.chat, b, 'Hello?');
  assert.doesNotMatch(systemOf(server.requests.at(-1)), /Answer in French|Project Falcon/);
});

test('skills invoked from chat are real registered skills and change what the model is told to do', async t => {
  const server = await fakeOpenAi(t, () => ({ text: 'done' }));
  const { workspace, eco, chat } = setup(t);
  const connection = connect(eco, server.baseUrl);
  const research = eco.createSkill(USER, { name: 'Research', description: 'Find and cite reliable sources for a question' });
  eco.writeSkillFile(USER, research.id, 'SKILL.md', skillFile('Research', 'Find and cite reliable sources for a question', 'List every source with a date. RESEARCH-BODY', 'outcome: Every claim has a source\ntriggers: research, sources, cite\n'));
  const coding = eco.createSkill(USER, { name: 'Coding', description: 'Write and review program code' });
  eco.writeSkillFile(USER, coding.id, 'SKILL.md', skillFile('Coding', 'Write and review program code', 'Always include tests. CODING-BODY', 'triggers: code, function, bug\n'));
  const off = eco.createSkill(USER, { name: 'Legacy', description: 'Old disabled procedure' });
  eco.writeSkillFile(USER, off.id, 'SKILL.md', skillFile('Legacy', 'Old disabled procedure', 'LEGACY-BODY', 'enabled: false\n'));
  const id = session(workspace, connection, 'local-model', { prefs: { skillDiscovery: false } });

  await turn(chat, id, 'Tell me about herons.');
  assert.doesNotMatch(systemOf(server.requests[0]), /RESEARCH-BODY|CODING-BODY/);

  // Activation by command: resolved against the registry, no model call, persisted in the session.
  const activated = await turn(chat, id, '/skill research');
  assert.equal(activated.result.status, 'command');
  assert.equal(server.requests.length, 1);
  assert.deepEqual(workspace.getChatSettings(USER, id).skills, [research.id]);
  assert.ok(activated.events.some(event => event.type === 'settings' && event.session.skills[0].name === 'Research'));
  assert.match(workspace.listChatMessages(USER, id).at(-1).content, /Research\*\* is now active/);

  await turn(chat, id, 'Tell me about herons.');
  const withSkill = systemOf(server.requests[1]);
  assert.match(withSkill, /## Skill 1: Research\nPurpose: Find and cite reliable sources for a question\nIntended outcome: Every claim has a source\nMethod:\nList every source with a date\. RESEARCH-BODY/);
  const reply = workspace.listChatMessages(USER, id).at(-1);
  assert.deepEqual(reply.meta.skills.map(skill => [skill.name, skill.source, skill.status]), [['Research', 'session', 'loaded']]);

  // Several skills together, and a message sent in the same line as the command.
  const combined = await turn(chat, id, '/skill coding write a function that adds two numbers');
  assert.equal(combined.result.status, 'completed');
  const both = server.requests[2];
  assert.match(systemOf(both), /## Skill 1: Research[\s\S]*## Skill 2: Coding[\s\S]*CODING-BODY/);
  assert.equal(both.body.messages.at(-1).content, 'write a function that adds two numbers');

  // Unknown, disabled and removed skills.
  await turn(chat, id, '/skill astrology');
  assert.match(workspace.listChatMessages(USER, id).at(-1).content, /No skill matches “astrology”/);
  await turn(chat, id, '/skill legacy');
  assert.match(workspace.listChatMessages(USER, id).at(-1).content, /Legacy\*\* is disabled/);
  assert.deepEqual(workspace.getChatSettings(USER, id).skills, [research.id, coding.id]);
  await turn(chat, id, '/skill off research');
  assert.deepEqual(workspace.getChatSettings(USER, id).skills, [coding.id]);
  await turn(chat, id, 'Tell me about herons.');
  assert.doesNotMatch(systemOf(server.requests.at(-1)), /RESEARCH-BODY/);
  assert.match(systemOf(server.requests.at(-1)), /CODING-BODY/);
  assert.equal(server.requests.length, 4, 'only real messages reached the model');

  const listing = await turn(chat, id, '/skills');
  assert.equal(listing.result.status, 'command');
  assert.match(workspace.listChatMessages(USER, id).at(-1).content, /Active here: Coding\.[\s\S]*Legacy\*\* \(`legacy`\) — disabled[\s\S]*\*\*Research\*\* \(`research`\)/);
});

test('skill discovery loads a matching skill when it is on, and only suggests it when it is off', async t => {
  const server = await fakeOpenAi(t, () => ({ text: 'done' }));
  const { workspace, eco, chat } = setup(t);
  const connection = connect(eco, server.baseUrl);
  const summary = eco.createSkill(USER, { name: 'Article summary', description: 'Summarize news articles into three bullet points' });
  eco.writeSkillFile(USER, summary.id, 'SKILL.md', skillFile('Article summary', 'Summarize news articles into three bullet points', 'Use exactly three bullets. SUMMARY-BODY', 'triggers: summarize, summary, article\n'));
  const tax = eco.createSkill(USER, { name: 'Tax filing', description: 'Prepare quarterly tax filings and VAT returns' });
  eco.writeSkillFile(USER, tax.id, 'SKILL.md', skillFile('Tax filing', 'Prepare quarterly tax filings and VAT returns', 'TAX-BODY'));

  const auto = session(workspace, connection);
  await turn(chat, auto, 'Please summarize this article about river pollution for me.');
  assert.match(systemOf(server.requests[0]), /SUMMARY-BODY/);
  assert.doesNotMatch(systemOf(server.requests[0]), /TAX-BODY/, 'unrelated skills are not loaded');
  assert.deepEqual(workspace.listChatMessages(USER, auto).at(-1).meta.skills.map(skill => [skill.name, skill.source]), [['Article summary', 'auto']]);
  assert.deepEqual(workspace.getChatSettings(USER, auto).skills, [], 'a discovered skill is used for the turn, not pinned to the session');

  await turn(chat, auto, 'hello');
  assert.doesNotMatch(systemOf(server.requests[1]), /SUMMARY-BODY/, 'small talk loads no skills');

  const manual = session(workspace, connection, 'local-model', { prefs: { skillDiscovery: false } });
  await turn(chat, manual, 'Please summarize this article about river pollution for me.');
  const system = systemOf(server.requests[2]);
  assert.doesNotMatch(system, /SUMMARY-BODY/);
  assert.match(system, /Skills in the person’s library that are not active here: article-summary/);
  const meta = workspace.listChatMessages(USER, manual).at(-1).meta;
  assert.deepEqual(meta.suggestedSkills.map(skill => skill.id), [summary.id]);
  assert.deepEqual(meta.skills, []);
});

test('a workflow attached to a conversation runs with the chat context and answers inside it', async t => {
  const server = await fakeOpenAi(t, body => ({ text: /You are Reviewer/.test(body.messages[0].content) ? 'Reviewed: looks right.' : 'Draft: plan for Friday.' }));
  const { workspace, eco, chat } = setup(t);
  const connection = connect(eco, server.baseUrl);
  const writer = eco.createAgent(USER, { name: 'Writer', description: 'Drafts text', connectionId: connection.id, model: 'local-model' });
  const reviewer = eco.createAgent(USER, { name: 'Reviewer', description: 'Reviews drafts', connectionId: connection.id, model: 'local-model' });
  const graph = {
    nodes: [
      { id: 'input', type: 'input', x: 0, y: 0, title: '', config: {} },
      { id: 'w', type: 'agent', x: 1, y: 0, title: '', config: { agentId: writer.id } },
      { id: 'r', type: 'agent', x: 2, y: 0, title: '', config: { agentId: reviewer.id } },
      { id: 'output', type: 'output', x: 3, y: 0, title: '', config: {} }
    ],
    edges: [{ from: 'input', to: 'w' }, { from: 'w', to: 'r' }, { from: 'r', to: 'output' }]
  };
  const flow = workspace.createWorkflow(USER, { title: 'Draft and review', description: 'Writes then reviews', graph });
  const other = workspace.createWorkflow(USER, { title: 'Second flow', graph: { ...graph, edges: [{ from: 'input', to: 'w' }, { from: 'w', to: 'output' }] } });
  const id = session(workspace, connection);

  await turn(chat, id, 'We always meet on Fridays at nine.');
  const attached = await turn(chat, id, '/workflow draft');
  assert.equal(attached.result.status, 'command');
  assert.equal(workspace.getChatSettings(USER, id).workflowId, flow.id);
  assert.equal(chat.describe(USER, id).workflow.title, 'Draft and review');

  const before = server.requests.length;
  const run = await turn(chat, id, 'Write the plan for our next meeting.');
  assert.equal(run.result.status, 'completed');
  const [writerCall, reviewerCall] = server.requests.slice(before);
  assert.match(writerCall.body.messages[0].content, /# Conversation context[\s\S]*User: We always meet on Fridays at nine\./, 'the first step receives the chat history');
  assert.equal(writerCall.body.messages.at(-1).content, 'Write the plan for our next meeting.');
  assert.doesNotMatch(reviewerCall.body.messages[0].content, /# Conversation context/, 'later steps get the upstream output, not the whole chat');
  assert.match(reviewerCall.body.messages.at(-1).content, /Draft: plan for Friday\./);
  const answer = workspace.listChatMessages(USER, id).at(-1);
  assert.equal(answer.role, 'assistant');
  assert.equal(answer.content, 'Reviewed: looks right.');
  assert.equal(answer.meta.mode, 'workflow');
  assert.equal(answer.meta.workflow.status, 'completed');
  assert.deepEqual(answer.meta.workflow.steps.map(step => [step.name, step.status, step.agent]), [['Writer', 'done', 'Writer'], ['Reviewer', 'done', 'Reviewer']]);
  assert.ok(run.events.some(event => event.type === 'workflow' && event.workflow.steps.some(step => step.status === 'running')), 'step status is reported while it runs');

  // Switching and removing the workflow keeps the history and the other settings.
  workspace.updateChatSettings(USER, id, { workflowId: other.id });
  await turn(chat, id, 'And a shorter one.');
  assert.equal(workspace.listChatMessages(USER, id).at(-1).meta.workflow.title, 'Second flow');
  await turn(chat, id, '/workflow off');
  assert.equal(workspace.getChatSettings(USER, id).workflowId, null);
  assert.equal(workspace.getChatSettings(USER, id).provider.model, 'local-model');
  const direct = server.requests.length;
  await turn(chat, id, 'Thanks. What did we decide?');
  const plain = server.requests[direct];
  assert.ok(plain.body.messages.some(message => message.content === 'Reviewed: looks right.'), 'workflow output is part of the conversation history');
  assert.equal(workspace.listChatMessages(USER, id).at(-1).meta.mode, 'chat');

  // A deleted workflow is reported, not silently replaced by a model reply.
  workspace.updateChatSettings(USER, id, { workflowId: other.id });
  workspace.deleteWorkflow(USER, other.id);
  const count = server.requests.length;
  const broken = await turn(chat, id, 'Run it again.');
  assert.equal(broken.result.status, 'failed');
  assert.equal(server.requests.length, count);
  const notice = workspace.listChatMessages(USER, id).at(-1);
  assert.equal(notice.role, 'system');
  assert.match(notice.content, /workflow attached to this conversation was deleted/);
  assert.equal(notice.meta.setup, true);

  // A failing step is shown with the step that failed.
  workspace.updateChatSettings(USER, id, { workflowId: flow.id });
  eco.deleteAgent(USER, reviewer.id);
  const failed = await turn(chat, id, 'Once more.');
  assert.equal(failed.result.status, 'failed');
  assert.match(workspace.listChatMessages(USER, id).at(-1).content, /no longer exists/);
});

test('simple questions take one model call; complex requests are planned, executed step by step and checked', async t => {
  const calls = [];
  const server = await fakeOpenAi(t, body => {
    const system = body.messages[0].content; const user = body.messages.at(-1).content;
    if (/break a request into the few steps/.test(system)) { calls.push('plan'); return { text: 'Here is the plan:\n{"steps":[{"title":"Gather options","instruction":"List three tools","agent":null,"dependsOn":[]},{"title":"Compare","instruction":"Compare pricing","agent":null,"dependsOn":[1]}]}' }; }
    if (/You check whether an answer/.test(system)) { calls.push('check'); return { text: '{"complete": true, "issues": []}' }; }
    if (/Your step \(1 of 2\)/.test(user)) { calls.push('step1'); return { text: 'Tools: Alpha, Beta, Gamma.' }; }
    if (/Your step \(2 of 2\)/.test(user)) { calls.push('step2'); return { text: 'Alpha is cheapest.' }; }
    if (/# Work already done for this request/.test(system)) { calls.push('answer'); return { text: 'Recommendation: Alpha.' }; }
    calls.push('direct'); return { text: 'Paris.' };
  });
  const { workspace, eco, chat } = setup(t);
  const id = session(workspace, connect(eco, server.baseUrl));

  await turn(chat, id, 'What is the capital of France?');
  assert.deepEqual(calls, ['direct'], 'no planning, checking or extra calls for a simple question');
  assert.equal(workspace.listChatMessages(USER, id).at(-1).meta.mode, 'chat');
  assert.equal(workspace.listChatMessages(USER, id).at(-1).meta.plan, undefined);

  calls.length = 0;
  const complex = await turn(chat, id, 'Research three project management tools, compare their pricing and features, then recommend one and draft a rollout plan for a team of ten.');
  assert.equal(complex.result.status, 'completed');
  assert.deepEqual(calls, ['plan', 'step1', 'step2', 'answer', 'check']);
  const step2 = server.requests.find(request => /Your step \(2 of 2\)/.test(request.body.messages.at(-1).content));
  assert.match(step2.body.messages.at(-1).content, /### Result of step 1: Gather options\nTools: Alpha, Beta, Gamma\./, 'a step receives the results it depends on');
  const answerCall = server.requests.find(request => /# Work already done/.test(request.body.messages[0].content));
  assert.match(answerCall.body.messages[0].content, /### Gather options\nTools: Alpha, Beta, Gamma\.[\s\S]*### Compare\nAlpha is cheapest\./);
  const stored = workspace.listChatMessages(USER, id).at(-1);
  assert.equal(stored.content, 'Recommendation: Alpha.');
  assert.equal(stored.meta.mode, 'planned');
  assert.deepEqual(stored.meta.plan.steps.map(step => [step.title, step.status]), [['Gather options', 'done'], ['Compare', 'done']]);
  assert.equal(stored.meta.verification.status, 'passed');
  assert.deepEqual(complex.events.filter(event => event.type === 'step').map(event => `${event.step.number}:${event.step.status}`), ['1:running', '1:done', '2:running', '2:done']);
  assert.equal(complex.events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Recommendation: Alpha.', 'only the final answer is streamed as the reply');

  // Orchestration set to direct: the same request is answered in one call.
  calls.length = 0;
  workspace.updateChatSettings(USER, id, { prefs: { orchestration: 'direct' } });
  await turn(chat, id, 'Research three project management tools, compare their pricing and features, then recommend one and draft a rollout plan for a team of ten.');
  assert.deepEqual(calls, ['direct']);
  // …and /plan forces a plan for one message.
  calls.length = 0;
  await turn(chat, id, '/plan pick a tool');
  assert.deepEqual(calls, ['plan', 'step1', 'step2', 'answer', 'check']);
});

test('verification repairs an incomplete result once, reports what it found and never loops', async t => {
  let checks = 0; let answers = 0;
  const server = await fakeOpenAi(t, body => {
    const system = body.messages[0].content; const user = body.messages.at(-1).content;
    if (/break a request into the few steps/.test(system)) return { text: '{"steps":[{"title":"One","instruction":"a"},{"title":"Two","instruction":"b"}]}' };
    if (/You check whether an answer/.test(system)) { checks++; return { text: '{"complete": false, "issues": ["The rollout plan is missing."]}' }; }
    if (/Your step/.test(user)) return { text: 'step result' };
    if (/A first answer was checked and found incomplete/.test(system)) { answers++; return { text: 'Full answer with rollout plan.' }; }
    answers++; return { text: 'Answer without rollout plan.' };
  });
  const { workspace, eco, chat } = setup(t);
  const id = session(workspace, connect(eco, server.baseUrl));
  const run = await turn(chat, id, '/plan recommend a tool and draft a rollout plan');
  assert.equal(run.result.status, 'completed');
  assert.equal(checks, 1, 'the revised answer is not checked again');
  assert.equal(answers, 2);
  const stored = workspace.listChatMessages(USER, id).at(-1);
  assert.equal(stored.content, 'Full answer with rollout plan.');
  assert.equal(stored.meta.verification.status, 'revised');
  assert.deepEqual(stored.meta.verification.issues, ['The rollout plan is missing.']);
  const resets = run.events.filter(event => event.type === 'reset-text').length;
  assert.ok(resets >= 1, 'the interface is told to replace the first answer');
  const after = run.events.slice(run.events.findLastIndex(event => event.type === 'reset-text')).filter(event => event.type === 'delta').map(event => event.text).join('');
  assert.equal(after, 'Full answer with rollout plan.');
});

test('an unusable plan or a failed step does not sink the task', async t => {
  let mode = 'badplan';
  const server = await fakeOpenAi(t, body => {
    const system = body.messages[0].content; const user = body.messages.at(-1).content;
    if (/break a request into the few steps/.test(system)) return mode === 'badplan' ? { text: 'I think we should just do it.' } : { text: '{"steps":[{"title":"Fetch","instruction":"a","agent":"Researcher"},{"title":"Depends","instruction":"b","dependsOn":[1]},{"title":"Independent","instruction":"c","dependsOn":[]}]}' };
    if (/You check whether an answer/.test(system)) return { text: 'not json' };
    if (/You are Researcher/.test(system)) return { status: 500 };
    if (/Your step \(1 of 3\)/.test(user)) return { status: 400, body: { error: { message: 'bad step' } } };
    if (/Your step/.test(user)) return { text: 'independent result' };
    return { text: /# Work already done/.test(system) ? 'Partial answer.' : 'Direct answer.' };
  });
  const { workspace, eco, chat } = setup(t);
  const connection = connect(eco, server.baseUrl);
  eco.createAgent(USER, { name: 'Researcher', description: 'Finds facts', connectionId: connection.id, model: 'local-model' });
  const id = session(workspace, connection, 'local-model', { prefs: { delegation: true } });

  await turn(chat, id, '/plan do the thing');
  let stored = workspace.listChatMessages(USER, id).at(-1);
  assert.equal(stored.content, 'Direct answer.');
  assert.equal(stored.meta.mode, 'chat');
  assert.match(stored.meta.notes.join(' '), /answered directly/);

  mode = 'plan';
  const run = await turn(chat, id, '/plan do the thing');
  assert.equal(run.result.status, 'completed');
  stored = workspace.listChatMessages(USER, id).at(-1);
  assert.equal(stored.content, 'Partial answer.');
  const steps = stored.meta.plan.steps;
  assert.equal(steps[0].status, 'failed');
  assert.match(steps[0].note, /Researcher failed .*session model took over/, 'the session model takes over a failed specialist once');
  assert.equal(steps[1].status, 'skipped', 'a step that needs a failed step is skipped, not run on nothing');
  assert.equal(steps[2].status, 'done', 'independent steps still run');
  const answerCall = server.requests.findLast(request => /# Work already done/.test(request.body.messages[0].content));
  assert.match(answerCall.body.messages[0].content, /These parts did not finish, so say clearly what is missing: Fetch/);
  assert.equal(stored.meta.verification.status, 'unavailable', 'an unusable verdict is reported as unchecked, not as passed');
});

test('provider failures become a clear notice, answering again does not duplicate the message, and stopping keeps partial text', async t => {
  let mode = 'down';
  const server = await fakeOpenAi(t, () => (mode === 'down' ? { status: 500 } : mode === 'missing' ? { status: 404, body: { error: { message: 'model not found' } } } : mode === 'hang' ? { text: 'Partial text that never ends', hang: true } : { text: 'Recovered.' }));
  const { workspace, eco, chat } = setup(t);
  const id = session(workspace, connect(eco, server.baseUrl));

  const failed = await turn(chat, id, 'Hello there, are you up?');
  assert.equal(failed.result.status, 'failed');
  assert.equal(server.requests.length, 2, 'one bounded retry, then stop');
  let messages = workspace.listChatMessages(USER, id);
  assert.deepEqual(messages.map(message => message.role), ['user', 'system']);
  assert.match(messages[1].content, /server error/);
  assert.equal(messages[1].meta.kind, 'error');
  assert.equal(messages[1].meta.retryable, true);
  assert.ok(!JSON.stringify(messages).includes(KEY));

  mode = 'ok';
  const again = await turn(chat, id, null, { regenerate: true });
  assert.equal(again.result.status, 'completed');
  messages = workspace.listChatMessages(USER, id);
  assert.deepEqual(messages.map(message => [message.role, message.content]), [['user', 'Hello there, are you up?'], ['assistant', 'Recovered.']]);
  assert.deepEqual(server.requests.at(-1).body.messages.filter(message => message.role !== 'system').map(message => message.content), ['Hello there, are you up?']);

  mode = 'missing';
  await turn(chat, id, 'Next question please?');
  assert.match(workspace.listChatMessages(USER, id).at(-1).content, /does not offer the model “local-model”/);

  // No model chosen, and a removed provider: setup notices, no request.
  const empty = workspace.createChat(USER, 'New conversation');
  const count = server.requests.length;
  await turn(chat, empty, 'Hi');
  assert.match(workspace.listChatMessages(USER, empty).at(-1).content, /Choose a model for this conversation/);
  assert.equal(workspace.listChatMessages(USER, empty).at(-1).meta.retryable, false);
  assert.equal(server.requests.length, count);

  // Stop: the text already shown is kept and marked incomplete.
  mode = 'hang';
  const controller = new AbortController();
  const events = [];
  const pending = chat.runTurn(USER, id, 'Tell me a long story.', { signal: controller.signal, emit: event => { events.push(event); if (event.type === 'delta') controller.abort(); } });
  await assert.rejects(() => chat.runTurn(USER, id, 'second message'), /still working/);
  const stopped = await pending;
  assert.equal(stopped.status, 'cancelled');
  const tail = workspace.listChatMessages(USER, id).slice(-2);
  assert.equal(tail[0].role, 'assistant');
  assert.equal(tail[0].meta.partial, true);
  assert.ok(tail[0].content.length > 0);
  assert.equal(tail[1].content, 'Stopped.');
  assert.equal(chat.isActive(id), false);
});

test('memory is saved only on request and shared across conversations; conversation text is not', async t => {
  const server = await fakeOpenAi(t, () => ({ text: 'ok' }));
  const { workspace, eco, chat } = setup(t);
  const connection = connect(eco, server.baseUrl);
  const a = session(workspace, connection); const b = session(workspace, connection);

  await turn(chat, a, 'My dog is called Biscuit.');
  await turn(chat, b, 'What is my dog called?');
  const withoutMemory = server.requests.at(-1);
  assert.ok(!JSON.stringify(withoutMemory.body).includes('Biscuit'), 'one conversation never leaks into another');
  assert.deepEqual(workspace.listMemory(USER), []);

  const saved = await turn(chat, a, '/remember My dog is called Biscuit');
  assert.equal(saved.result.status, 'command');
  assert.equal(workspace.listMemory(USER).length, 1);
  assert.deepEqual(workspace.listMemory('user-b'), []);
  await turn(chat, b, 'What is my dog called?');
  assert.match(systemOf(server.requests.at(-1)), /# Saved memory\n- My dog is called Biscuit/);
  workspace.deleteMemory(USER, workspace.listMemory(USER)[0].id);
  await turn(chat, b, 'And now?');
  assert.doesNotMatch(systemOf(server.requests.at(-1)), /# Saved memory/);
});

test('tools and delegation follow the session agent’s permissions and what the model supports', async t => {
  const server = await fakeOpenAi(t, (body, requests) => {
    if (/You are Researcher/.test(body.messages[0].content)) return { text: 'Herons are wading birds.' };
    if (body.tools && !body.messages.some(message => message.role === 'tool')) return { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ask_agent', arguments: JSON.stringify({ agent: 'Researcher', task: 'What is a heron?' }) } }] };
    return { text: `Final after ${requests.length} calls.` };
  });
  const { workspace, eco, chat } = setup(t);
  const plain = connect(eco, server.baseUrl);
  const capable = connect(eco, server.baseUrl, { label: 'Tool endpoint', supportsTools: true });
  eco.createAgent(USER, { name: 'Researcher', description: 'Finds facts', connectionId: plain.id, model: 'local-model' });

  // Delegation off: no tools, streaming reply.
  const off = session(workspace, capable);
  await turn(chat, off, 'What is a heron?');
  assert.equal(server.requests[0].body.tools, undefined);
  assert.equal(server.requests[0].body.stream, true);

  // Delegation on, but the model cannot call tools: said plainly, nothing promised.
  const unable = session(workspace, plain, 'local-model', { prefs: { delegation: true } });
  await turn(chat, unable, 'What is a heron?');
  const note = workspace.listChatMessages(USER, unable).at(-1).meta;
  assert.equal(server.requests.at(-1).body.tools, undefined);
  assert.match(note.notes.join(' '), /does not accept tool calls, so ask_agent was not offered/);
  assert.match(systemOf(server.requests.at(-1)), /You have no tools in this conversation/);

  // Delegation on with a capable model: the specialist is asked and its answer is used.
  const on = session(workspace, capable, 'local-model', { prefs: { delegation: true } });
  const before = server.requests.length;
  const run = await turn(chat, on, 'What is a heron?');
  assert.equal(run.result.status, 'completed');
  const [first, delegate, last] = server.requests.slice(before);
  assert.deepEqual(first.body.tools.map(tool => tool.function.name), ['ask_agent']);
  assert.match(delegate.body.messages[0].content, /You are Researcher/);
  assert.equal(last.body.messages.at(-1).role, 'tool');
  assert.equal(last.body.messages.at(-1).content, 'Herons are wading birds.');
  const meta = workspace.listChatMessages(USER, on).at(-1).meta;
  assert.deepEqual(meta.delegations.map(item => item.agent), ['Researcher']);
  assert.deepEqual(meta.toolCalls.map(call => [call.tool, call.outcome]), [['ask_agent', 'ok']]);
  assert.ok(run.events.some(event => event.type === 'tool'));
  assert.equal(server.requests.slice(before).filter(request => /You are Researcher/.test(request.body.messages[0].content)).every(request => request.body.tools === undefined), true, 'a delegated agent cannot delegate again');

  // An agent chosen for the session brings its identity, while the session keeps its own model.
  const persona = eco.createAgent(USER, { name: 'Coach', description: 'Motivates', connectionId: plain.id, model: 'other-model' });
  eco.writeAgentFile(USER, persona.id, 'instructions.md', 'End every reply with COACH-RULE.');
  const withAgent = session(workspace, capable, 'local-model', { agentId: persona.id });
  await turn(chat, withAgent, 'Hello coach, can you help?');
  assert.match(systemOf(server.requests.at(-1)), /# Identity — Coach\nYou are Coach\.[\s\S]*COACH-RULE/);
  assert.equal(server.requests.at(-1).body.model, 'local-model', 'the session’s explicit model is not replaced by the agent’s');
  assert.equal(workspace.listChatMessages(USER, withAgent).at(-1).meta.agent.name, 'Coach');
  // With no model chosen in the session, the agent's own model is used and reported as inherited.
  const inherit = workspace.createChat(USER, 'New conversation');
  workspace.updateChatSettings(USER, inherit, { agentId: persona.id });
  assert.equal(chat.describe(USER, inherit).provider.inherited, true);
  await turn(chat, inherit, 'Hello coach, can you help?');
  assert.equal(server.requests.at(-1).body.model, 'other-model');
});

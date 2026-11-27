'use strict';
/* Agent Ecosystem service (main process). Joins the existing pieces:
     • workspace store  — agent registry rows (id, name, description) and workflows, unchanged
     • packages         — editable agent files and skill packages on disk
     • connections      — provider connections with encrypted keys
     • providers        — provider adapters (Ollama, OpenAI, Anthropic, Gemini, OpenAI-compatible)
     • context / tools  — context assembly, budgeting, permissions and tool execution
   runAgent() is what the workflow engine calls for an Agent node: it reads the agent's current saved files
   on every call, so edits apply to the next run without a separate snapshot of the agent in the workflow. */
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createProviders, PROVIDER_TYPES, redact } = require('./providers');
const { createAgentPackages, createSkillPackages, PERMISSIONS, AGENT_FILES, defaultConfig } = require('./packages');
const { assembleContext, selectSkills, skillSection, compactMessages, estimateTokens, ContextOverflowError } = require('./context');
const { createToolbox, runScriptProcess } = require('./tools');
const { OLLAMA_ID } = require('./connections');

const fail = message => { throw new Error(message); };
const MAX_TOOL_ROUNDS = 8;
const MODEL_CACHE_MS = 10 * 60 * 1000;

function createEcosystem({ root, workspace, secrets, fetchImpl = fetch, providers = null, ollamaBase = null, nodePath = process.execPath }) {
  const base = path.join(root, 'agent-ecosystem');
  const agents = createAgentPackages(base);
  const skills = createSkillPackages(base);
  const connections = workspace.connectionStore(secrets);
  const provider = providers || createProviders({ fetchImpl, ollamaBase });
  const windowCache = new Map();

  // ───────────────────────── agents
  function connectionSummary(userId, connectionId) {
    const connection = connections.get(userId, connectionId);
    return connection ? { id: connection.id, label: connection.label, type: connection.type, local: PROVIDER_TYPES[connection.type].local } : { id: connectionId, label: 'Missing provider', type: null, missing: true };
  }
  function summary(userId, row) {
    agents.ensure(userId, row); // migrates agents created before packages existed
    const { config, problems } = agents.readConfig(userId, row.id);
    return { ...row, model: config.provider.model || row.model, provider: connectionSummary(userId, config.provider.connectionId), skills: config.skills, problems: problems.length };
  }
  function listAgents(userId) { return workspace.listAgents(userId).map(row => summary(userId, row)); }
  function getAgent(userId, agentId) {
    const row = workspace.getAgent(userId, agentId);
    agents.ensure(userId, row);
    const pack = agents.read(userId, agentId);
    const files = Object.fromEntries(Object.keys(AGENT_FILES).map(name => [name, agents.readFile(userId, agentId, name)]));
    const known = new Set(skills.list(userId).map(skill => skill.id));
    const problems = [...pack.problems];
    for (const id of pack.config.skills) if (!known.has(id)) problems.push({ file: 'configuration.json', message: `Assigned skill “${id}” does not exist.` });
    const others = new Set(workspace.listAgents(userId).map(item => item.id));
    for (const id of pack.config.delegates) if (!others.has(id)) problems.push({ file: 'configuration.json', message: 'A delegate agent no longer exists. Save the settings to remove it.' });
    if (!connections.get(userId, pack.config.provider.connectionId)) problems.push({ file: 'configuration.json', message: 'The selected provider connection no longer exists. Choose another provider.' });
    return { ...summary(userId, row), tree: pack.tree, config: pack.config, files, problems };
  }
  function createAgent(userId, { name, description = '', connectionId = OLLAMA_ID, model } = {}) {
    if (!connections.get(userId, connectionId)) fail('Choose a provider for this agent.');
    const row = workspace.saveAgent(userId, { name, description, instructions: '', model });
    const config = defaultConfig(row.model); config.provider.connectionId = connectionId;
    try { agents.create(userId, row.id, { config, identity: `You are ${row.name}.${row.description ? ` ${row.description}` : ''}\n` }); }
    catch (error) { workspace.deleteAgent(userId, row.id); throw error; }
    return getAgent(userId, row.id);
  }
  function updateAgentMeta(userId, agentId, { name, description }) {
    const row = workspace.getAgent(userId, agentId);
    workspace.saveAgent(userId, { id: agentId, name: name ?? row.name, description: description ?? row.description, instructions: row.instructions, model: row.model });
    return getAgent(userId, agentId);
  }
  function mirror(userId, agentId) {
    const { config } = agents.readConfig(userId, agentId);
    workspace.mirrorAgent(userId, agentId, { instructions: agents.readFile(userId, agentId, 'instructions.md'), model: config.provider.model });
  }
  function writeAgentFile(userId, agentId, rel, content) {
    workspace.getAgent(userId, agentId);
    agents.writeFile(userId, agentId, rel, content);
    if (rel === 'instructions.md' || rel === 'configuration.json') mirror(userId, agentId);
    return getAgent(userId, agentId);
  }
  /* Structured edits from the Overview form; validated, then written to configuration.json. */
  function updateAgentConfig(userId, agentId, patch = {}) {
    workspace.getAgent(userId, agentId);
    const known = new Set(skills.list(userId).map(skill => skill.id));
    agents.updateConfig(userId, agentId, config => {
      if (patch.provider) {
        if (!connections.get(userId, patch.provider.connectionId)) fail('That provider connection does not exist.');
        if (typeof patch.provider.model !== 'string' || !patch.provider.model.trim()) fail('Choose or type a model name.');
        config.provider = { connectionId: patch.provider.connectionId, model: patch.provider.model.trim() };
      }
      if (patch.skills) {
        if (!Array.isArray(patch.skills)) fail('Invalid skills.');
        for (const id of patch.skills) if (!known.has(id)) fail(`Skill “${id}” does not exist.`);
        config.skills = [...new Set(patch.skills)];
      }
      if (patch.delegates) {
        const rows = new Set(workspace.listAgents(userId).map(row => row.id));
        if (!Array.isArray(patch.delegates) || patch.delegates.some(id => !rows.has(id) || id === agentId)) fail('Choose other existing agents to delegate to.');
        config.delegates = [...new Set(patch.delegates)];
      }
      if (patch.permissions) for (const [key, value] of Object.entries(patch.permissions)) {
        if (!Object.hasOwn(PERMISSIONS, key) || typeof value !== 'boolean') fail('Invalid permission.');
        config.permissions[key] = value;
      }
      if (patch.fileAccess) {
        if (!Array.isArray(patch.fileAccess.folders) || patch.fileAccess.folders.some(folder => typeof folder !== 'string' || !path.isAbsolute(folder))) fail('Folders must be absolute paths.');
        config.fileAccess.folders = patch.fileAccess.folders.map(folder => path.resolve(folder));
      }
      if (patch.context) config.context = { ...config.context, ...patch.context };
      return config;
    });
    mirror(userId, agentId);
    return getAgent(userId, agentId);
  }
  function deleteAgentFile(userId, agentId, rel) { workspace.getAgent(userId, agentId); agents.deleteFile(userId, agentId, rel); return getAgent(userId, agentId); }
  function duplicateAgent(userId, agentId) {
    const source = workspace.getAgent(userId, agentId);
    agents.ensure(userId, source);
    const copy = workspace.saveAgent(userId, { name: `${source.name} copy`.slice(0, 80), description: source.description, instructions: source.instructions, model: source.model });
    agents.duplicate(userId, agentId, copy.id);
    return getAgent(userId, copy.id);
  }
  function deleteAgent(userId, agentId) {
    workspace.getAgent(userId, agentId);
    workspace.deleteAgent(userId, agentId);
    agents.remove(userId, agentId); // moved to .trash, not erased
  }
  function exportAgent(userId, agentId, targetDir) {
    const row = workspace.getAgent(userId, agentId); agents.ensure(userId, row);
    agents.exportTo(userId, agentId, targetDir, { name: row.name, description: row.description });
    return { folder: targetDir };
  }
  function importAgent(userId, sourceDir) {
    const info = agents.inspectImport(sourceDir);
    const known = connections.get(userId, info.config.provider.connectionId);
    const model = info.config.provider.model || 'unset';
    const row = workspace.saveAgent(userId, { name: info.name, description: info.description, instructions: '', model: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model) ? model : 'unset' });
    try { agents.importFrom(userId, row.id, sourceDir); }
    catch (error) { workspace.deleteAgent(userId, row.id); throw error; }
    const notes = [];
    if (!known) { agents.updateConfig(userId, row.id, config => { config.provider.connectionId = OLLAMA_ID; return config; }); notes.push('Its provider connection does not exist here, so it was set to local Ollama. Choose a provider and model before running it.'); }
    const missing = info.config.skills.filter(id => !skills.exists(userId, id));
    if (missing.length) notes.push(`Assigned skills not found here: ${missing.join(', ')}.`);
    mirror(userId, row.id);
    return { agent: getAgent(userId, row.id), notes };
  }

  // ───────────────────────── skills
  function usage(userId) {
    const map = new Map();
    for (const row of workspace.listAgents(userId)) {
      agents.ensure(userId, row);
      for (const id of agents.readConfig(userId, row.id).config.skills) { if (!map.has(id)) map.set(id, []); map.get(id).push({ id: row.id, name: row.name }); }
    }
    return map;
  }
  function listSkills(userId) { const used = usage(userId); return skills.list(userId).map(skill => ({ ...skill, usedBy: used.get(skill.id) || [] })); }
  function getSkill(userId, skillId) { return { ...skills.read(userId, skillId), usedBy: usage(userId).get(skillId) || [] }; }
  function deleteSkill(userId, skillId) {
    skills.remove(userId, skillId);
    for (const user of usage(userId).get(skillId) || []) agents.updateConfig(userId, user.id, config => { config.skills = config.skills.filter(id => id !== skillId); return config; });
  }
  /* Manual script run from the Skills page, on behalf of an agent: the agent's permissions decide. */
  async function runSkillScript(userId, { agentId, skillId, script, input = '' }, { requestApproval, log = () => {} }) {
    const row = workspace.getAgent(userId, agentId);
    const pack = agents.load(userId, agentId);
    if (!pack) fail('Agent not found.');
    const deny = reason => { log({ tool: 'run_skill_script', outcome: 'denied', detail: `${skillId}/${script} — ${reason}` }); fail(reason); };
    if (!pack.config.permissions.skillScripts || !pack.config.permissions.codeExecution) deny(`${row.name} is not allowed to run skill scripts. Grant “Run skill scripts” and “Code execution” in its permissions first.`);
    if (!pack.config.skills.includes(skillId)) deny(`This skill is not assigned to ${row.name}.`);
    const meta = skills.meta(userId, skillId);
    if (!meta.enabled) deny('This skill is disabled.');
    const { file, dir } = skills.scriptPath(userId, skillId, script);
    if (!await requestApproval({ title: 'Run this skill script?', detail: `${meta.name}: ${script}\nAs agent: ${row.name}\nRuns on this computer for up to 30 seconds.`, risk: 'high', agent: row.name })) deny('Run declined.');
    const result = await runScriptProcess({ file, dir, input, nodePath });
    log({ tool: 'run_skill_script', outcome: result.ok ? 'ok' : 'failed', detail: `${skillId}/${script}` });
    return result;
  }

  // ───────────────────────── providers
  function listConnections(userId) {
    const used = new Map();
    for (const row of workspace.listAgents(userId)) { agents.ensure(userId, row); const id = agents.readConfig(userId, row.id).config.provider.connectionId; used.set(id, [...(used.get(id) || []), row.name]); }
    return connections.list(userId).map(connection => ({ ...connection, usedBy: used.get(connection.id) || [], capabilities: PROVIDER_TYPES[connection.type] }));
  }
  function saveConnection(userId, changes) { const saved = connections.save(userId, changes); windowCache.clear(); return saved; }
  function removeConnection(userId, connectionId) {
    const users = listConnections(userId).find(item => item.id === connectionId)?.usedBy || [];
    if (users.length) fail(`This provider is used by ${users.join(', ')}. Choose another provider for ${users.length === 1 ? 'that agent' : 'those agents'} first.`);
    connections.remove(userId, connectionId);
  }
  /* Tests a saved connection, or an unsaved draft (draft.apiKey omitted → the saved key is used). */
  async function testConnection(userId, draft) {
    let connection; let apiKey = null;
    if (draft.id) {
      const resolved = connections.resolve(userId, draft.id);
      if (!resolved) fail('Provider not found.');
      connection = { ...resolved.connection, ...(draft.baseUrl !== undefined && resolved.connection.type === 'openai-compatible' ? { baseUrl: draft.baseUrl } : {}), ...(draft.model !== undefined ? { model: draft.model } : {}) };
      apiKey = typeof draft.apiKey === 'string' && draft.apiKey.trim() ? draft.apiKey.trim() : resolved.apiKey;
    } else {
      if (!Object.hasOwn(PROVIDER_TYPES, draft.type)) fail('Choose a provider type.');
      connection = { type: draft.type, label: draft.label || PROVIDER_TYPES[draft.type].label, baseUrl: draft.baseUrl || '', model: draft.model || '' };
      apiKey = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : null;
    }
    const result = await provider.testConnection(connection, apiKey);
    return { ok: result.ok, message: result.message, models: (result.models || []).map(model => model.id) };
  }
  async function listModels(userId, connectionId) {
    const resolved = connections.resolve(userId, connectionId);
    if (!resolved) fail('Provider not found.');
    try {
      const models = await provider.adapterFor(resolved.connection.type).listModels({ connection: resolved.connection, apiKey: resolved.apiKey });
      return { available: true, models, error: null };
    } catch (error) { return { available: false, models: [], error: redact(error.message, resolved.apiKey) }; }
  }

  // ───────────────────────── runtime
  async function contextWindowFor(userId, connection, model, apiKey) {
    const key = `${userId}:${connection.id}:${model}`; const hit = windowCache.get(key);
    if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.value;
    const value = connection.type === 'ollama' && !(Number(connection.contextWindow) > 0)
      ? { tokens: PROVIDER_TYPES.ollama.defaultContext, source: 'Ollama default context (num_ctx)' }
      : await provider.contextWindow(connection, model, { apiKey });
    windowCache.set(key, { at: Date.now(), value });
    return value;
  }
  /* One model request with a single bounded recovery attempt:
       • transient provider failures (rate limit, server error, network, timeout) are retried once after a short
         wait, but only if no text was streamed yet (so nothing is shown twice);
       • an empty reply with no tool call is asked for once more.
     Authentication, invalid-request and context-length errors are never retried. */
  async function callModel(adapter, request, { log, signal, name }) {
    for (let attempt = 1; ; attempt++) {
      let emitted = false;
      try {
        const result = await adapter.chat({ ...request, onDelta: piece => { emitted = true; request.onDelta(piece); } });
        if (!result.text.trim() && !result.toolCalls.length && attempt === 1) { log(`${name} returned an empty reply; asking once more.`); continue; }
        return { ...result, retried: attempt > 1 };
      } catch (error) {
        if (error.name === 'AbortError' || signal?.aborted) throw error;
        if (attempt === 1 && !emitted && ['rate_limit', 'server', 'network', 'timeout'].includes(error.kind)) {
          log(`${error.message} Retrying once.`);
          await new Promise(resolve => setTimeout(resolve, error.kind === 'rate_limit' ? 4000 : 1200));
          if (signal?.aborted) { const cancelled = new Error('Run cancelled.'); cancelled.name = 'AbortError'; throw cancelled; }
          continue;
        }
        throw error;
      }
    }
  }

  /* The model ↔ tool conversation shared by agent steps and chat turns. Mutates `messages` and the
     `state` counters (rounds, retried, truncated) so callers can report progress even when it throws. */
  async function toolLoop({ adapter, request, messages, tools, toolbox, signal, onDelta = () => {}, log = () => {}, name, state = {}, systemTokens, available, maxRounds = MAX_TOOL_ROUNDS, onTruncated = () => {}, overflow }) {
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reported: false };
    let text = '';
    for (let round = 1; round <= maxRounds + 1; round++) {
      const offer = round <= maxRounds ? tools : [];
      const result = await callModel(adapter, { ...request, messages, tools: offer, signal, onDelta }, { log, signal, name });
      state.rounds = round; state.retried = state.retried || result.retried;
      if (result.usage) {
        usage.reported = true;
        usage.inputTokens += result.usage.inputTokens || 0; usage.outputTokens += result.usage.outputTokens || 0; usage.cachedTokens += result.usage.cachedTokens || 0;
      }
      text = result.text;
      if (result.truncated && !result.toolCalls.length) { state.truncated = true; onTruncated(); }
      if (!result.toolCalls.length) break;
      if (round > maxRounds) break;
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls, native: result.native });
      for (const call of result.toolCalls) {
        if (signal?.aborted) { const error = new Error('Run cancelled.'); error.name = 'AbortError'; throw error; }
        const outcome = await toolbox.execute(call);
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: outcome.content, isError: !outcome.ok, keep: Boolean(outcome.keep) });
      }
      if (result.text) onDelta('\n');
      const compaction = compactMessages(messages, systemTokens, available);
      if (compaction.compacted) log(`Shortened ${compaction.compacted} older tool result${compaction.compacted === 1 ? '' : 's'} to stay within the context budget.`);
      if (!compaction.fits) throw overflow(compaction);
    }
    return { text, usage: usage.reported ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, source: 'provider-reported' } : null };
  }

  /* Resolves a provider connection + model into everything needed to call it, with messages a person can act on.
     Used by chat sessions, where the model is chosen per conversation instead of per agent. */
  async function resolveModel(userId, connectionId, model) {
    const resolved = connections.resolve(userId, connectionId);
    if (!resolved) fail('The provider selected for this conversation no longer exists. Choose another model.');
    const { connection, apiKey } = resolved; const type = PROVIDER_TYPES[connection.type];
    if (!model) fail('Choose a model for this conversation.');
    if (type.needsKey && !apiKey) fail(`${connection.label} has no API key. Add one in the provider settings (Agents → LLM APIs).`);
    const window = await contextWindowFor(userId, connection, model, apiKey);
    return { connection, apiKey, type, model, window, adapter: provider.adapterFor(connection.type), supportsTools: await provider.supportsTools(connection, model) };
  }

  /* Runs one Agent node. args (from engine.js): { agent, prompt, system (legacy, unused), signal, onDelta,
     workflowInstructions, nodeInstructions, skills (override ids or null),
     workflow: { prompt, outputs, step, upstream, downstream }, log, onDiagnostics }.
     hooks: { requestApproval, cache } supplied by the IPC layer (cache: Map shared by one workflow run).
     depth > 0 means this call is a delegated sub-task: it cannot delegate further. */
  async function runAgent(userId, args, hooks = {}, depth = 0) {
    const { agent, signal, onDelta = () => {}, log = () => {}, onDiagnostics = () => {} } = args;
    const pack = agents.load(userId, agent.id);
    if (!pack) fail(`The files for ${agent.name} are missing. Open the agent on the Agents page to recreate them.`);
    const { config } = pack;
    if (!config.provider.model) fail(`Choose a model for ${agent.name} on the Agents page.`);
    const resolved = connections.resolve(userId, config.provider.connectionId);
    if (!resolved) fail(`The provider connection for ${agent.name} was removed. Choose another provider on the Agents page.`);
    const { connection, apiKey } = resolved; const type = PROVIDER_TYPES[connection.type];
    if (type.needsKey && !apiKey) fail(`${connection.label} has no API key. Add one in the provider settings (Agents → LLM APIs).`);
    const model = config.provider.model;

    // The objective a step serves: the request that started the run, the step's own instructions, and its input.
    const objective = [args.workflow?.prompt, args.nodeInstructions, args.prompt].filter(Boolean).join('\n');
    const skillIds = Array.isArray(args.skills) ? args.skills : config.skills;
    const skillMeta = skillIds.map(id => (skills.exists(userId, id) ? skills.meta(userId, id) : { id, missing: true }));
    const preselected = new Set(selectSkills(objective, skillMeta, config.context.maxSkills).filter(item => item.status === 'selected').map(item => item.id));
    const window = await contextWindowFor(userId, connection, model, apiKey);
    // On Ollama the agent's own context budget is sent as num_ctx, so it is the window (Ollama's 4,096 default applies
    // only when the agent sets none). Elsewhere the provider's window is the ceiling.
    const contextWindow = connection.type === 'ollama' && config.context.maxContextTokens
      ? config.context.maxContextTokens
      : Math.min(window.tokens, config.context.maxContextTokens || Infinity);
    const responseReserve = config.context.responseReserveTokens || (connection.type === 'ollama' ? 1024 : 4096);

    // Delegation targets: configured, still existing, not this agent; never from inside a delegated task.
    const roster = depth === 0 && config.delegates.length ? workspace.listAgents(userId).filter(row => row.id !== agent.id && config.delegates.includes(row.id)) : [];
    const toolLog = []; const loadedOnDemand = []; const delegations = [];
    const toolbox = createToolbox({
      agentName: agent.name, config, userId, signal, fetchImpl, providerTools: true,
      skills: { assigned: skillMeta.filter(skill => !skill.missing), catalog: skillMeta.filter(skill => !skill.missing && !preselected.has(skill.id)) },
      loadSkill: meta => {
        const body = skills.loadBody(userId, meta.id);
        loadedOnDemand.push(meta.name);
        return `${skillSection(preselected.size + loadedOnDemand.length, meta, body)}${meta.references.length ? `\nReferences (read with read_skill_reference when needed): ${meta.references.join(', ')}` : ''}\nFollow this skill for the parts of the task it covers.`;
      },
      delegates: roster.map(row => ({ id: row.id, name: row.name, description: row.description })),
      delegate: async (target, task) => {
        const row = roster.find(item => item.id === target.id);
        log(`${agent.name} asks ${row.name}: ${task.length > 140 ? `${task.slice(0, 140)}…` : task}`);
        const started = Date.now();
        const answer = await runAgent(userId, { agent: row, prompt: task, signal, log: message => log(`[${row.name}] ${message}`), workflow: null }, hooks, depth + 1);
        delegations.push({ agent: row.name, task: task.slice(0, 200), durationMs: Date.now() - started });
        if (!answer.trim()) fail(`${row.name} returned an empty answer.`);
        return answer;
      },
      workflow: args.workflow || null,
      skillStore: skills,
      requestApproval: async request => (hooks.requestApproval ? Boolean(await hooks.requestApproval(request)) : false),
      log: entry => { toolLog.push({ ...entry, at: new Date().toISOString() }); log(`Tool ${entry.tool}: ${entry.outcome}${entry.detail ? ` — ${entry.detail}` : ''}`); }
    });
    let tools = toolbox.definitions; const notes = [...toolbox.notes];
    if (tools.length && !(await provider.supportsTools(connection, model))) {
      notes.push(`Tools are not offered: ${connection.label} / ${model} does not support tool calls${connection.type === 'openai-compatible' ? ' (enable tool support in the provider settings if the endpoint has it)' : ''}.`);
      if (config.delegates.length) notes.push('Delegation is unavailable for the same reason.');
      tools = [];
    }
    const position = args.workflow && args.workflow.step ? { step: args.workflow.step, request: args.workflow.prompt, upstream: args.workflow.upstream || [], downstream: args.workflow.downstream || [] } : null;
    const assembled = assembleContext({
      agent: { name: agent.name, identity: pack.identity, instructions: pack.instructions, capabilities: pack.capabilities, context: pack.context, resources: pack.resources },
      task: args.prompt, objective, skills: skillMeta, position,
      loadSkillBody: id => skills.loadBody(userId, id), loadReference: (id, rel) => skills.readFile(userId, id, rel),
      workflowInstructions: args.workflowInstructions || [], nodeInstructions: args.nodeInstructions || '',
      conversation: args.workflow?.conversation || '',
      tools, toolNote: notes.filter(note => /^Folders/.test(note)).join('\n'),
      budget: { contextWindow, contextSource: config.context.maxContextTokens && config.context.maxContextTokens < window.tokens ? 'agent setting' : window.source, responseReserve, maxSkills: config.context.maxSkills }
    });
    const systemTokens = estimateTokens(assembled.system);
    const cache = type.caching === 'explicit' && systemTokens >= 1024;
    const diagnostics = {
      agent: { id: agent.id, name: agent.name }, provider: { id: connection.id, label: connection.label, type: connection.type }, model,
      skillSource: Array.isArray(args.skills) ? 'node override' : 'agent', ...assembled.diagnostics,
      tools: tools.map(tool => tool.name), notes: notes.filter(note => !/^Folders/.test(note)),
      caching: cache ? 'Prompt caching requested for the system prompt (Anthropic).' : type.caching === 'automatic' ? 'Provider-managed automatic caching may apply (OpenAI).' : 'Not used for this provider.',
      usage: null, toolCalls: toolLog, rounds: 0, loadedOnDemand, delegations, retried: false, reused: false, truncated: false
    };

    // The same agent given the same instructions and input twice in one run gets its first answer back.
    // Only for steps without tools: tool steps can have side effects and must run.
    const runCache = hooks.cache instanceof Map && !tools.length ? hooks.cache : null;
    const cacheKey = runCache ? createHash('sha256').update(JSON.stringify([agent.id, connection.id, model, assembled.system, assembled.user])).digest('hex') : null;
    if (runCache && runCache.has(cacheKey)) {
      const reused = runCache.get(cacheKey);
      diagnostics.reused = true; onDiagnostics(diagnostics);
      log(`${agent.name} was already given exactly this context and input in this run; reusing that result instead of calling the model again.`);
      onDelta(reused);
      return reused;
    }
    onDiagnostics(diagnostics);
    log(`Context for ${agent.name}: ~${assembled.diagnostics.estimatedTokens.toLocaleString('en-US')} of ${assembled.diagnostics.available.toLocaleString('en-US')} tokens (estimate); skills loaded: ${assembled.diagnostics.skills.filter(item => item.status === 'selected').map(item => item.name).join(', ') || 'none'}.`);

    const adapter = provider.adapterFor(connection.type);
    // Images for a vision model ride on the request message (Learning Image Reader); never more than 6, each checked.
    const images = Array.isArray(args.images) ? args.images.filter(image => image && /^image\/(png|jpeg|webp)$/.test(image.mime) && typeof image.data === 'string' && image.data.length < 14000000).slice(0, 6) : [];
    const messages = [{ role: 'user', content: assembled.user, ...(images.length ? { images } : {}) }];
    const { text, usage } = await toolLoop({
      adapter, messages, tools, toolbox, signal, onDelta, log, name: agent.name, state: diagnostics, systemTokens, available: contextWindow - responseReserve,
      request: {
        connection, apiKey, model, system: assembled.system, cache, agentName: agent.name,
        maxTokens: Number.isInteger(args.maxTokens) && args.maxTokens > 0 && connection.type !== 'ollama' ? args.maxTokens : connection.type === 'anthropic' || config.context.responseReserveTokens ? responseReserve : null,
        // A caller may cap one reply (the Learning question writer asks for short JSON): Ollama's num_predict.
        numPredict: Number.isInteger(args.maxTokens) && args.maxTokens > 0 ? args.maxTokens : null,
        // Ollama only: a JSON schema for the reply, and thinking off for short structured jobs (the Learning question writer).
        format: connection.type === 'ollama' && args.format && typeof args.format === 'object' ? args.format : null,
        think: connection.type === 'ollama' && typeof args.think === 'boolean' ? args.think : null,
        numCtx: connection.type === 'ollama' && config.context.maxContextTokens ? contextWindow : null,
        // Optional sampling temperature for this request (the Learning workflow asks for low values: facts, not flair).
        temperature: typeof args.temperature === 'number' && args.temperature >= 0 && args.temperature <= 2 ? args.temperature : null
      },
      onTruncated: () => log(`${agent.name}’s reply reached the output limit and may be cut off. Raise “Reserved for reply” in the agent’s context budget.`),
      overflow: compaction => new ContextOverflowError(`The tool results for ${agent.name} no longer fit in the model’s context window (~${compaction.estimatedTokens.toLocaleString('en-US')} tokens, estimate). Ask for a narrower task or use a model with a larger window.`, diagnostics)
    });
    diagnostics.usage = usage;
    onDiagnostics(diagnostics);
    if (runCache && text.trim()) runCache.set(cacheKey, text);
    return text;
  }

  return {
    paths: { base }, permissions: PERMISSIONS, agentFiles: AGENT_FILES, providerTypes: PROVIDER_TYPES,
    listAgents, getAgent, createAgent, updateAgentMeta, writeAgentFile, updateAgentConfig, deleteAgentFile, duplicateAgent, deleteAgent, exportAgent, importAgent,
    readAgentFile: (userId, agentId, rel) => { workspace.getAgent(userId, agentId); return agents.readFile(userId, agentId, rel); },
    listSkills, getSkill, deleteSkill, runSkillScript,
    createSkill: (userId, input) => skills.create(userId, input),
    readSkillFile: (userId, skillId, rel) => skills.readFile(userId, skillId, rel),
    writeSkillFile: (userId, skillId, rel, content) => { skills.writeFile(userId, skillId, rel, content); return getSkill(userId, skillId); },
    deleteSkillFile: (userId, skillId, rel) => { skills.deleteFile(userId, skillId, rel); return getSkill(userId, skillId); },
    setSkillEnabled: (userId, skillId, enabled) => { skills.setEnabled(userId, skillId, Boolean(enabled)); return getSkill(userId, skillId); },
    duplicateSkill: (userId, skillId) => skills.duplicate(userId, skillId),
    exportSkill: (userId, skillId, dir) => skills.exportTo(userId, skillId, dir),
    importSkill: (userId, dir) => skills.importFrom(userId, dir),
    listConnections, saveConnection, removeConnection, testConnection, listModels,
    runAgent,
    // For the chat engine (automation/chat.js): the same stores, provider layer and tool loop agents use.
    internals: { agents, skills, connections, provider, fetchImpl, resolveModel, toolLoop, callModel }
  };
}

module.exports = { createEcosystem };

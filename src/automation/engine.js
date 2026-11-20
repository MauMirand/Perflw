'use strict';
/* Agentic Automation — workflow graph validation and execution.
   Pure logic: no Electron, no database, no network. The agent runtime is injected (`runAgent`),
   so the engine never produces a model response itself.
   Loaded by the main process (require) and by the renderer (script tag → window.PerflwEngine), so the
   editor and the engine share one node registry and one set of connection rules. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwEngine = factory();
})(globalThis, function () {

const LIMITS = Object.freeze({ nodes: 120, edges: 400, markdown: 200000, text: 8000, title: 120, prompt: 8000 });

const fail = message => { throw new Error(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, max, fallback = '') => (typeof value === 'string' ? value.slice(0, max) : fallback);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* Node type registry. Add a type here (ports, config cleaner, execute) to extend the editor and engine;
   `kind: 'context'` nodes supply instructions to the nodes they connect to instead of running in sequence. */
const NODE_TYPES = {
  input: {
    label: 'Input', hasInput: false, hasOutput: true, max: 1,
    cleanConfig: () => ({}),
    execute: ctx => ctx.prompt
  },
  agent: {
    label: 'AI Agent', hasInput: true, hasOutput: true,
    cleanConfig: config => ({
      agentId: typeof config.agentId === 'string' && ID_RE.test(config.agentId) ? config.agentId : null,
      instructions: str(config.instructions, LIMITS.text),
      inputTemplate: str(config.inputTemplate, LIMITS.text, '{{input}}') || '{{input}}',
      // Optional per-node skill override. Absent (older workflows) = use the agent's own skills.
      ...(Array.isArray(config.skills) ? { skills: [...new Set(config.skills.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)))].slice(0, 20) } : {})
    }),
    execute: async ctx => {
      const agent = ctx.agents.get(ctx.node.config.agentId);
      if (!agent) fail('The selected agent no longer exists. Choose another agent for this node.');
      // `system` keeps the original flat prompt for simple runtimes; the agent ecosystem runtime uses the
      // structured fields instead (workflowInstructions, nodeInstructions, skills, workflow) to assemble context.
      const system = [agent.instructions, ...ctx.context.map(item => item.content), ctx.node.config.instructions]
        .map(part => (part || '').trim()).filter(Boolean).join('\n\n');
      const user = applyTemplate(ctx.node.config.inputTemplate, { input: ctx.input, prompt: ctx.prompt, history: ctx.conversation || '' });
      if (!user.trim()) fail('This agent received no input. Connect it to the Input node or another agent.');
      ctx.log(`Calling ${agent.name} (${agent.model})${ctx.context.length ? ` with ${ctx.context.length} instruction block${ctx.context.length === 1 ? '' : 's'}` : ''}.`);
      const output = await ctx.runAgent({
        agent, system, prompt: user, signal: ctx.signal, onDelta: ctx.onDelta,
        workflowInstructions: ctx.context, nodeInstructions: ctx.node.config.instructions,
        skills: Array.isArray(ctx.node.config.skills) ? ctx.node.config.skills : null,
        workflow: ctx.workflow, log: ctx.log, onDiagnostics: ctx.onDiagnostics
      });
      if (typeof output !== 'string' || !output.trim()) fail(`${agent.name} returned an empty response.`);
      return output;
    }
  },
  markdown: {
    label: 'Markdown', hasInput: false, hasOutput: true, kind: 'context',
    cleanConfig: config => ({ content: str(config.content, LIMITS.markdown), filename: str(config.filename, 255) }),
    execute: ctx => ctx.node.config.content
  },
  output: {
    label: 'Output', hasInput: true, hasOutput: false,
    cleanConfig: () => ({}),
    execute: ctx => ctx.input
  }
};

function applyTemplate(template, values) {
  const source = typeof template === 'string' && template.trim() ? template : '{{input}}';
  const filled = source.replace(/\{\{\s*(input|prompt|history)\s*\}\}/g, (_match, key) => values[key] ?? '');
  // A template without {{input}} still receives the upstream data, so nothing connected is silently dropped.
  return /\{\{\s*input\s*\}\}/.test(source) ? filled : [filled.trim(), values.input].filter(Boolean).join('\n\n');
}

/* Structural cleaning for storage and execution. Throws on malformed graphs; returns a fresh, bounded copy. */
function cleanGraph(graph) {
  if (!isObject(graph)) fail('Invalid workflow.');
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : fail('Invalid workflow nodes.');
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : fail('Invalid workflow connections.');
  if (rawNodes.length > LIMITS.nodes) fail(`A workflow can have up to ${LIMITS.nodes} nodes.`);
  if (rawEdges.length > LIMITS.edges) fail(`A workflow can have up to ${LIMITS.edges} connections.`);
  const nodes = []; const byId = new Map(); const counts = {};
  for (const raw of rawNodes) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) fail('Invalid workflow node.');
    if (typeof raw.type !== 'string' || !Object.hasOwn(NODE_TYPES, raw.type)) fail('This workflow uses a node type that is not supported.');
    const type = NODE_TYPES[raw.type];
    if (byId.has(raw.id)) fail('Workflow nodes must be unique.');
    counts[raw.type] = (counts[raw.type] || 0) + 1;
    if (type.max && counts[raw.type] > type.max) fail(`A workflow can have only ${type.max} ${type.label} node.`);
    const x = Number(raw.x); const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail('Invalid node position.');
    const node = {
      id: raw.id, type: raw.type,
      x: Math.round(Math.max(-100000, Math.min(100000, x))), y: Math.round(Math.max(-100000, Math.min(100000, y))),
      title: str(raw.title, LIMITS.title).trim(),
      config: type.cleanConfig(isObject(raw.config) ? raw.config : {})
    };
    nodes.push(node); byId.set(node.id, node);
  }
  const edges = []; const edgeIds = new Set();
  for (const raw of rawEdges) {
    if (!isObject(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string') fail('Invalid workflow connection.');
    const problem = connectionProblem({ nodes, edges }, raw.from, raw.to);
    if (problem) fail(problem);
    let edgeId = typeof raw.id === 'string' && ID_RE.test(raw.id) && !edgeIds.has(raw.id) ? raw.id : null;
    for (let n = edges.length; !edgeId; n++) if (!edgeIds.has(`e${n}`)) edgeId = `e${n}`;
    edgeIds.add(edgeId);
    edges.push({ id: edgeId, from: raw.from, to: raw.to });
  }
  const view = isObject(graph.view) ? graph.view : {};
  const zoom = Number(view.zoom);
  return {
    nodes, edges,
    view: {
      x: Number.isFinite(Number(view.x)) ? Math.round(Number(view.x)) : 0,
      y: Number.isFinite(Number(view.y)) ? Math.round(Number(view.y)) : 0,
      zoom: Number.isFinite(zoom) ? Math.max(0.3, Math.min(2, Math.round(zoom * 100) / 100)) : 1
    }
  };
}

/* Why a connection from → to is not allowed, or null when it is. Shared by the editor and the engine. */
function connectionProblem(graph, from, to) {
  const source = graph.nodes.find(node => node.id === from);
  const target = graph.nodes.find(node => node.id === to);
  if (!source || !target) return 'That connection points to a node that does not exist.';
  if (from === to) return 'A node cannot connect to itself.';
  if (!NODE_TYPES[source.type].hasOutput) return `${NODE_TYPES[source.type].label} nodes have no output to connect from.`;
  if (!NODE_TYPES[target.type].hasInput) return `${NODE_TYPES[target.type].label} nodes do not accept incoming connections.`;
  if (graph.edges.some(edge => edge.from === from && edge.to === to)) return 'Those nodes are already connected.';
  if (reaches(graph, to, from)) return 'That connection would create a loop.';
  return null;
}
function reaches(graph, start, goal) {
  const stack = [start]; const visited = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === goal) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of graph.edges) if (edge.from === current) stack.push(edge.to);
  }
  return false;
}

/* Execution plan from connections only — node positions are never consulted.
   Returns { order, context, skipped, issues }. `issues` non-empty means the workflow cannot run. */
function planWorkflow(graph, agents = new Map()) {
  const issues = []; const issue = (message, nodeId = null) => issues.push({ message, nodeId });
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const name = node => node.title || NODE_TYPES[node.type].label;
  const start = graph.nodes.find(node => node.type === 'input');
  if (!start) { issue('Add an Input node so the workflow has a starting point.'); return { order: [], context: new Map(), skipped: [], issues }; }

  // Loop check over the whole graph (cleanGraph already rejects loops; this guards direct callers).
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) indegree.set(edge.to, indegree.get(edge.to) + 1);
  const queue = graph.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id); let sorted = 0;
  while (queue.length) {
    const id = queue.shift(); sorted++;
    for (const edge of graph.edges) if (edge.from === id) { indegree.set(edge.to, indegree.get(edge.to) - 1); if (indegree.get(edge.to) === 0) queue.push(edge.to); }
  }
  if (sorted !== graph.nodes.length) { issue('This workflow contains a loop. Remove the circular connection.'); return { order: [], context: new Map(), skipped: [], issues }; }

  // Only nodes reachable from Input execute.
  const reachable = new Set(); const stack = [start.id];
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of graph.edges) if (edge.from === id) stack.push(edge.to);
  }
  // Context (Markdown) nodes feed the reachable nodes they connect to.
  const context = new Map(); const usedContext = new Set();
  for (const edge of graph.edges) {
    const source = nodes.get(edge.from);
    if (!reachable.has(edge.to) || NODE_TYPES[source.type].kind !== 'context') continue;
    if (!context.has(edge.to)) context.set(edge.to, []);
    context.get(edge.to).push(source.id); usedContext.add(source.id);
  }
  // Topological order of the reachable nodes; ties resolve by creation order, never by position.
  const remaining = new Map();
  for (const id of reachable) remaining.set(id, graph.edges.filter(edge => edge.to === id && reachable.has(edge.from)).length);
  const order = []; const ready = graph.nodes.filter(node => reachable.has(node.id) && remaining.get(node.id) === 0).map(node => node.id);
  while (ready.length) {
    const id = ready.shift(); order.push(id);
    for (const edge of graph.edges) {
      if (edge.from !== id || !reachable.has(edge.to)) continue;
      remaining.set(edge.to, remaining.get(edge.to) - 1);
      if (remaining.get(edge.to) === 0) ready.push(edge.to);
    }
  }
  const skipped = graph.nodes.filter(node => !reachable.has(node.id) && !usedContext.has(node.id)).map(node => node.id);

  if (!order.some(id => nodes.get(id).type === 'output')) issue('Connect the workflow to an Output node so there is a final result.');
  for (const id of order) {
    const node = nodes.get(id);
    if (node.type === 'agent') {
      if (!node.config.agentId) issue(`Choose an agent for “${name(node)}”.`, id);
      else if (!agents.has(node.config.agentId)) issue(`The agent selected for “${name(node)}” no longer exists.`, id);
    }
    if (node.type === 'output' && !graph.edges.some(edge => edge.to === id && reachable.has(edge.from))) issue(`“${name(node)}” has nothing connected to it.`, id);
  }
  for (const id of usedContext) if (!nodes.get(id).config.content.trim()) issue(`“${name(nodes.get(id))}” has no instructions yet.`, id);
  return { order, context, skipped, issues };
}

function abortError() { const error = new Error('Run cancelled.'); error.name = 'AbortError'; return error; }
const preview = (text, max = 600) => (text.length > max ? `${text.slice(0, max)}…` : text);
function joinInputs(parts) {
  if (parts.length === 1) return parts[0].text;
  return parts.map(part => `### ${part.name}\n${part.text}`).join('\n\n');
}

/* Runs a workflow sequentially along its connections.
   emit(event) receives: run-start, node-start, node-delta, node-done, node-error, node-skipped, log, run-done, run-error, run-cancelled.
   Resolves to { status: 'completed' | 'failed' | 'cancelled', output, error, durationMs }. Never rejects for run failures.
   `conversation` (optional text) is the chat context a session passes in: agent steps fed directly by the Input
   node receive it as background, and any step can place it with {{history}} in its input mapping. */
async function runWorkflow({ graph, prompt, agents, runAgent, signal, emit = () => {}, conversation = '' }) {
  const started = Date.now();
  const finish = (status, extra = {}) => ({ status, output: null, error: null, durationMs: Date.now() - started, ...extra });
  const log = (message, nodeId = null, level = 'info') => emit({ type: 'log', level, message, nodeId, at: new Date().toISOString() });
  let clean;
  try {
    if (typeof prompt !== 'string' || !prompt.trim()) fail('Write a message to run the workflow.');
    if (prompt.length > LIMITS.prompt) fail(`Messages can be up to ${LIMITS.prompt} characters.`);
    clean = cleanGraph(graph);
  } catch (error) { emit({ type: 'run-error', message: error.message, nodeId: null }); return finish('failed', { error: error.message }); }

  const agentMap = agents instanceof Map ? agents : new Map((agents || []).map(agent => [agent.id, agent]));
  const plan = planWorkflow(clean, agentMap);
  if (plan.issues.length) {
    const message = plan.issues.map(item => item.message).join(' ');
    for (const item of plan.issues) log(item.message, item.nodeId, 'error');
    emit({ type: 'run-error', message, nodeId: plan.issues[0].nodeId, issues: plan.issues });
    return finish('failed', { error: message });
  }
  const nodes = new Map(clean.nodes.map(node => [node.id, node]));
  const name = node => node.title || (node.type === 'agent' && agentMap.get(node.config.agentId)?.name) || NODE_TYPES[node.type].label;
  const outputs = new Map(); const finals = [];
  const background = typeof conversation === 'string' ? conversation.slice(0, 60000) : '';
  emit({ type: 'run-start', order: plan.order, skipped: plan.skipped, steps: plan.order.map(id => ({ id, name: name(nodes.get(id)), nodeType: nodes.get(id).type })) });
  for (const id of plan.skipped) emit({ type: 'node-skipped', nodeId: id });
  if (plan.skipped.length) log(`${plan.skipped.length} node${plan.skipped.length === 1 ? ' is' : 's are'} not connected to the Input and will not run.`, null, 'warn');
  log(`Running ${plan.order.length} step${plan.order.length === 1 ? '' : 's'}.`);

  for (const id of plan.order) {
    const node = nodes.get(id); const type = NODE_TYPES[node.type]; const nodeStarted = Date.now();
    if (signal?.aborted) { log('Run cancelled.', null, 'warn'); emit({ type: 'run-cancelled' }); return finish('cancelled'); }
    emit({ type: 'node-start', nodeId: id, name: name(node), nodeType: node.type });
    try {
      const upstream = clean.edges.filter(edge => edge.to === id && outputs.has(edge.from) && NODE_TYPES[nodes.get(edge.from).type].kind !== 'context')
        .map(edge => ({ name: name(nodes.get(edge.from)), text: outputs.get(edge.from) }));
      const context = (plan.context.get(id) || []).map(contextId => {
        const source = nodes.get(contextId);
        return { name: name(source), content: NODE_TYPES[source.type].execute({ node: source }) };
      });
      // Context connected to a non-agent node (e.g. Markdown → Output) is passed through as data.
      const data = node.type === 'agent' ? upstream : [...upstream, ...context.map(item => ({ name: item.name, text: item.content }))];
      // Finished steps by name, for agents allowed to read earlier outputs (workflow interaction permission).
      // Two steps can share a display name, so later duplicates get a numeric suffix instead of overwriting.
      const finished = new Map();
      for (const [nodeId, text] of outputs) {
        const base = name(nodes.get(nodeId)); let key = base;
        for (let n = 2; finished.has(key); n++) key = `${base} (${n})`;
        finished.set(key, text);
      }
      const downstream = clean.edges.filter(edge => edge.from === id && plan.order.includes(edge.to)).map(edge => name(nodes.get(edge.to)));
      const fedByInput = clean.edges.some(edge => edge.to === id && nodes.get(edge.from).type === 'input');
      const output = await type.execute({
        node, prompt, input: data.length ? joinInputs(data) : '', context, agents: agentMap, runAgent, signal, conversation: background,
        workflow: { prompt, outputs: finished, step: name(node), upstream: upstream.map(item => item.name), downstream, conversation: fedByInput ? background : '' },
        log: message => log(message, id),
        onDelta: text => { if (typeof text === 'string' && text) emit({ type: 'node-delta', nodeId: id, text }); },
        onDiagnostics: diagnostics => emit({ type: 'node-diagnostics', nodeId: id, diagnostics })
      });
      if (signal?.aborted) throw abortError();
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      outputs.set(id, text);
      if (node.type === 'output') finals.push({ name: name(node), text });
      emit({ type: 'node-done', nodeId: id, name: name(node), nodeType: node.type, output: text, preview: preview(text), durationMs: Date.now() - nodeStarted });
      log(`${name(node)} finished in ${((Date.now() - nodeStarted) / 1000).toFixed(1)}s.`, id);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') {
        emit({ type: 'node-cancelled', nodeId: id });
        log('Run cancelled.', id, 'warn'); emit({ type: 'run-cancelled' });
        return finish('cancelled');
      }
      const message = error.message || 'This step failed.';
      emit({ type: 'node-error', nodeId: id, name: name(node), message });
      log(`${name(node)} failed: ${message}`, id, 'error');
      emit({ type: 'run-error', message: `${name(node)}: ${message}`, nodeId: id });
      return finish('failed', { error: `${name(node)}: ${message}` });
    }
  }
  const output = finals.length === 1 ? finals[0].text : joinInputs(finals);
  const result = finish('completed', { output });
  log(`Workflow completed in ${(result.durationMs / 1000).toFixed(1)}s.`);
  emit({ type: 'run-done', output, durationMs: result.durationMs });
  return result;
}

function emptyGraph() {
  return {
    nodes: [
      { id: 'input', type: 'input', x: 40, y: 150, title: '', config: {} },
      { id: 'output', type: 'output', x: 640, y: 150, title: '', config: {} }
    ],
    edges: [], view: { x: 0, y: 0, zoom: 1 }
  };
}

return { NODE_TYPES, LIMITS, cleanGraph, connectionProblem, planWorkflow, runWorkflow, applyTemplate, emptyGraph };
});

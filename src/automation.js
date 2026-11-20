'use strict';
/* Agentic Automation — workflow editor (canvas, inspector, test chat) and the Agents page.
   Mounted by renderer.js through window.PerflwAutomation. Node types, connection rules and run
   planning come from automation/engine.js (window.PerflwEngine), shared with the main process. */
(() => {
  const E = window.PerflwEngine;
  const api = window.automationData;
  let H = null;            // helpers handed over by renderer.js (esc, icon, toast, confirmDialog, go, stamp)
  let root = null;         // current page root inside #stage
  let canvas = null; let world = null; let gesture = null;
  const NODE_W = 232; const LAST_KEY = 'perflw-af-last';
  const sizes = new Map(); // node id → rendered height (for port/edge geometry)

  const PATHS = {
    flow: '<rect x="2.5" y="3" width="5.5" height="5" rx="1.3"/><rect x="12" y="12" width="5.5" height="5" rx="1.3"/><path d="M8 5.5h4.7a2 2 0 0 1 2 2V12"/>',
    agent: '<rect x="4" y="7" width="12" height="9.5" rx="2.6"/><path d="M10 7V4.4M7.6 11.2v1.3M12.4 11.2v1.3"/><circle cx="10" cy="3.4" r="1"/>',
    markdown: '<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="M12 2.5V6h3.5M7.5 10h5M7.5 13h3.5"/>',
    input: '<path d="M3 10h9M9 6.5l3.5 3.5L9 13.5"/><path d="M12 4h3.5A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5H12"/>',
    output: '<path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3h-.5A1.5 1.5 0 0 1 3 12.5z"/><path d="m7.5 9 2 2 3.5-3.5"/>',
    play: '<path d="M6.5 4.5v11l9-5.5z"/>',
    stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/>',
    redo: '<path d="m13 5 4 4-4 4"/><path d="M17 9H8a5 5 0 0 0 0 10h2"/>',
    zoomIn: '<circle cx="8.5" cy="8.5" r="5"/><line x1="13" y1="13" x2="17.5" y2="17.5"/><line x1="6.5" y1="8.5" x2="10.5" y2="8.5"/><line x1="8.5" y1="6.5" x2="8.5" y2="10.5"/>',
    zoomOut: '<circle cx="8.5" cy="8.5" r="5"/><line x1="13" y1="13" x2="17.5" y2="17.5"/><line x1="6.5" y1="8.5" x2="10.5" y2="8.5"/>',
    fit: '<path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13"/>',
    save: '<path d="M4.5 3h9L17 6.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11A1.5 1.5 0 0 1 4.5 3z"/><path d="M6.5 3v4h6V3M6.5 17v-5h7v5"/>',
    copy: '<rect x="7" y="7" width="10" height="10" rx="1.8"/><path d="M13 7V4.8A1.8 1.8 0 0 0 11.2 3H4.8A1.8 1.8 0 0 0 3 4.8v6.4A1.8 1.8 0 0 0 4.8 13H7"/>',
    check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
    alert: '<circle cx="10" cy="10" r="7"/><path d="M10 6.5v4.2M10 13.4v.1"/>',
    down: '<polyline points="5,8 10,13 15,8"/>',
    panel: '<rect x="3" y="3.5" width="14" height="13" rx="2"/><line x1="12.2" y1="3.5" x2="12.2" y2="16.5"/>',
    upload: '<path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13v2.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V13"/>',
    duplicate: '<rect x="3" y="3" width="10" height="10" rx="1.8"/><path d="M7 15.2A1.8 1.8 0 0 0 8.8 17h6.4a1.8 1.8 0 0 0 1.8-1.8V8.8A1.8 1.8 0 0 0 15.2 7"/>'
  };
  const ic = (name, extra = '') => PATHS[name]
    ? `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${PATHS[name]}</svg>`
    : H.icon(name, extra);
  const esc = value => H.esc(value);

  // Editor presentation for each node type. Unknown (future) types fall back to a generic card.
  const TYPE_UI = {
    input: { icon: 'input', about: 'Receives the message you send from the Test panel and passes it to every connected node.' },
    agent: { icon: 'agent', about: '' },
    markdown: { icon: 'markdown', about: '' },
    output: { icon: 'output', about: 'Collects what reaches it and shows it as the final result of the workflow.' }
  };
  const typeUi = type => TYPE_UI[type] || { icon: 'flow', about: '' };
  const typeLabel = type => (E.NODE_TYPES[type] ? E.NODE_TYPES[type].label : 'Block');

  // ───────────────────────── state
  const fresh = () => ({
    loaded: false, loading: null, agents: [], models: { available: false, models: [], error: null, checked: false },
    workflows: [], current: null, graph: null, selection: null,
    history: [], future: [], historyKey: null,
    dirty: false, saving: false, saveTimer: null, renaming: false,
    run: null, nodeStatus: {}, chat: {}, testOpen: true, mdPreview: false,
    agentSel: null, skills: []
  });
  let A = fresh();

  const agentById = id => A.agents.find(agent => agent.id === id) || null;
  const nodeById = id => (A.graph ? A.graph.nodes.find(node => node.id === id) || null : null);
  function nodeName(node) {
    if (node.title) return node.title;
    if (node.type === 'agent') { const agent = agentById(node.config.agentId); return agent ? agent.name : 'AI Agent'; }
    if (node.type === 'markdown') return node.config.filename || 'Instructions';
    return typeLabel(node.type);
  }
  const uid = prefix => `${prefix}${Math.random().toString(36).slice(2, 10)}`;
  const snapshot = () => JSON.stringify({ nodes: A.graph.nodes, edges: A.graph.edges });
  const graphPayload = () => ({ nodes: A.graph.nodes, edges: A.graph.edges, view: A.graph.view });
  const entries = () => (A.current ? (A.chat[A.current.id] = A.chat[A.current.id] || []) : []);
  const connected = () => Boolean(root && root.isConnected);
  const q = (selector, scope = root) => (scope ? scope.querySelector(selector) : null);
  async function guard(task) {
    try { return await task(); }
    catch (error) { H.toast(error.message || 'Something went wrong.', { error: true }); throw error; }
  }

  // ───────────────────────── loading
  function load() {
    if (A.loading) return A.loading;
    const state = A;
    A.loading = (async () => {
      // Skills feed the Agent node's optional per-step override; a failure there must not block the editor.
      const [agents, workflows, skills] = await Promise.all([api.agents(), api.workflows(), api.skills().catch(() => [])]);
      if (state !== A) return;
      A.agents = agents; A.workflows = workflows; A.skills = skills; A.loaded = true;
      if (!A.current && workflows.length) {
        let last = null;
        try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
        const pick = workflows.find(item => item.id === last) || workflows[0];
        await openWorkflow(pick.id, { paint: false });
      }
    })().finally(() => { if (state === A) A.loading = null; });
    return A.loading;
  }
  async function openWorkflow(id, { paint = true } = {}) {
    if (A.run) { H.toast('Stop the running workflow before switching.', { error: true }); return; }
    if (A.current && A.dirty) await saveNow();
    const workflow = await guard(() => api.workflow(id));
    A.current = { id: workflow.id, title: workflow.title, description: workflow.description };
    A.graph = workflow.graph; A.selection = null; A.history = []; A.future = []; A.historyKey = null;
    A.dirty = false; A.renaming = false; A.nodeStatus = {}; A.mdPreview = false;
    try { localStorage.setItem(LAST_KEY, workflow.id); } catch { /* ignore */ }
    if (paint && connected()) paintEditor();
  }

  // ───────────────────────── saving
  function scheduleSave() {
    clearTimeout(A.saveTimer);
    A.saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, 1200);
  }
  async function saveNow() {
    clearTimeout(A.saveTimer); A.saveTimer = null;
    if (!A.current || !A.graph || A.saving) return;
    const state = A; const id = A.current.id; const before = snapshot() + JSON.stringify(A.graph.view);
    A.saving = true; paintStatus();
    try {
      const saved = await api.updateWorkflow(id, { title: A.current.title, description: A.current.description, graph: graphPayload() });
      if (state !== A) return;
      const item = A.workflows.find(workflow => workflow.id === id);
      if (item) { item.title = saved.title; item.description = saved.description; item.updatedAt = saved.updatedAt; }
      if (A.current && A.current.id === id && before === snapshot() + JSON.stringify(A.graph.view)) A.dirty = false;
    } catch (error) {
      if (state === A) H.toast(`Could not save the workflow: ${error.message}`, { error: true });
      throw error;
    } finally {
      if (state === A) { A.saving = false; paintStatus(); if (A.dirty && A.current && A.current.id === id) scheduleSave(); }
    }
  }
  function changed({ quiet = false } = {}) {
    A.dirty = true;
    scheduleSave();
    if (!quiet) paintStatus();
  }

  // ───────────────────────── history
  function pushHistory(key = null) {
    if (key && key === A.historyKey) return;
    A.history.push(snapshot());
    if (A.history.length > 100) A.history.shift();
    A.future = []; A.historyKey = key;
  }
  function restore(serialised) {
    const state = JSON.parse(serialised);
    A.graph.nodes = state.nodes; A.graph.edges = state.edges; A.historyKey = null;
    if (A.selection) {
      const list = A.selection.kind === 'node' ? A.graph.nodes : A.graph.edges;
      if (!list.some(item => item.id === A.selection.id)) A.selection = null;
    }
    changed(); paintCanvas(); paintInspector();
  }
  function undo() { if (!A.history.length || A.run) return; A.future.push(snapshot()); restore(A.history.pop()); }
  function redo() { if (!A.future.length || A.run) return; A.history.push(snapshot()); restore(A.future.pop()); }

  // ───────────────────────── graph edits
  function viewCenter() {
    const rect = canvas ? canvas.getBoundingClientRect() : { width: 800, height: 500 };
    const view = A.graph.view;
    return { x: (rect.width / 2 - view.x) / view.zoom, y: (rect.height / 2 - view.y) / view.zoom };
  }
  function addNode(type, config = {}) {
    if (!A.graph || A.run) return;
    const definition = E.NODE_TYPES[type];
    if (!definition) return;
    if (definition.max && A.graph.nodes.filter(node => node.type === type).length >= definition.max) { H.toast(`A workflow can have only ${definition.max} ${definition.label} node.`, { error: true }); return; }
    if (A.graph.nodes.length >= E.LIMITS.nodes) { H.toast(`A workflow can have up to ${E.LIMITS.nodes} nodes.`, { error: true }); return; }
    const center = viewCenter();
    const x = Math.round(center.x - NODE_W / 2); let y = Math.round(center.y - 40);
    // Start at the middle of the view and step down until the new card does not cover an existing one.
    const covers = () => A.graph.nodes.some(node => x < node.x + NODE_W + 12 && x + NODE_W + 12 > node.x && y < node.y + (sizes.get(node.id) || 80) + 12 && y + 92 > node.y);
    for (let tries = 0; tries < 24 && covers(); tries++) y += 36;
    pushHistory();
    const node = { id: uid('n'), type, x, y, title: '', config: definition.cleanConfig(config) };
    A.graph.nodes.push(node);
    A.selection = { kind: 'node', id: node.id };
    changed(); paintCanvas(); paintInspector(); revealSelected();
    const element = q(`[data-node="${node.id}"]`); if (element) element.focus({ preventScroll: true });
  }
  function addAgentNode() {
    addNode('agent', A.agents.length === 1 ? { agentId: A.agents[0].id } : {});
  }
  function duplicateNode(id) {
    const node = nodeById(id);
    if (!node || A.run) return;
    const definition = E.NODE_TYPES[node.type];
    if (definition.max && A.graph.nodes.filter(item => item.type === node.type).length >= definition.max) { H.toast(`A workflow can have only ${definition.max} ${definition.label} node.`, { error: true }); return; }
    pushHistory();
    const copy = { id: uid('n'), type: node.type, x: node.x + 32, y: node.y + 32, title: node.title, config: JSON.parse(JSON.stringify(node.config)) };
    A.graph.nodes.push(copy);
    A.selection = { kind: 'node', id: copy.id };
    changed(); paintCanvas(); paintInspector();
  }
  function deleteSelection() {
    if (!A.selection || A.run) return;
    pushHistory();
    if (A.selection.kind === 'node') {
      const id = A.selection.id;
      A.graph.nodes = A.graph.nodes.filter(node => node.id !== id);
      A.graph.edges = A.graph.edges.filter(edge => edge.from !== id && edge.to !== id);
      delete A.nodeStatus[id]; sizes.delete(id);
    } else A.graph.edges = A.graph.edges.filter(edge => edge.id !== A.selection.id);
    A.selection = null;
    changed(); paintCanvas(); paintInspector();
    if (canvas) canvas.focus();
  }
  function connect(from, to) {
    if (A.run) return false;
    const problem = E.connectionProblem(A.graph, from, to);
    if (problem) { H.toast(problem, { error: true }); return false; }
    if (A.graph.edges.length >= E.LIMITS.edges) { H.toast(`A workflow can have up to ${E.LIMITS.edges} connections.`, { error: true }); return false; }
    pushHistory();
    A.graph.edges.push({ id: uid('e'), from, to });
    changed(); paintEdges(); paintInspector();
    return true;
  }
  function removeEdge(id) {
    if (A.run) return;
    pushHistory();
    A.graph.edges = A.graph.edges.filter(edge => edge.id !== id);
    if (A.selection && A.selection.kind === 'edge' && A.selection.id === id) A.selection = null;
    changed(); paintEdges(); paintInspector();
  }
  function select(selection) {
    const same = (A.selection && selection && A.selection.kind === selection.kind && A.selection.id === selection.id) || (!A.selection && !selection);
    A.selection = selection; A.historyKey = null;
    if (same) return;
    A.mdPreview = false;
    for (const element of root.querySelectorAll('.af-node')) element.classList.toggle('selected', Boolean(selection && selection.kind === 'node' && element.dataset.node === selection.id));
    for (const element of root.querySelectorAll('[data-edge]')) element.classList.toggle('selected', Boolean(selection && selection.kind === 'edge' && element.dataset.edge === selection.id));
    paintInspector();
  }

  // ───────────────────────── view (pan / zoom)
  function applyView({ save = true } = {}) {
    if (!world) return;
    const view = A.graph.view;
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const grid = 22 * view.zoom;
    canvas.style.backgroundSize = `${grid}px ${grid}px`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
    const label = q('.af-zoom-label'); if (label) label.textContent = `${Math.round(view.zoom * 100)}%`;
    if (save) changed({ quiet: true });
  }
  function zoomAt(clientX, clientY, zoom) {
    const view = A.graph.view; const rect = canvas.getBoundingClientRect();
    const next = Math.max(0.3, Math.min(2, zoom));
    const px = clientX - rect.left; const py = clientY - rect.top;
    const wx = (px - view.x) / view.zoom; const wy = (py - view.y) / view.zoom;
    view.zoom = Math.round(next * 100) / 100;
    view.x = Math.round(px - wx * view.zoom); view.y = Math.round(py - wy * view.zoom);
    applyView();
  }
  function zoomStep(direction) {
    const rect = canvas.getBoundingClientRect();
    const steps = [0.3, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2]; const current = A.graph.view.zoom;
    const next = direction > 0 ? steps.find(step => step > current + 0.001) : [...steps].reverse().find(step => step < current - 0.001);
    if (next) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, next);
  }
  /* Slide the view just enough that the selected node is not hidden behind the settings panel. */
  function revealSelected() {
    const panel = q('.af-inspector'); const node = A.selection && A.selection.kind === 'node' ? nodeById(A.selection.id) : null;
    if (!panel || panel.hidden || !node || !canvas) return;
    const view = A.graph.view; const box = canvas.getBoundingClientRect();
    const left = node.x * view.zoom + view.x; const right = left + NODE_W * view.zoom;
    const limit = box.width - panel.offsetWidth - 12 - 18;
    if (right <= limit) return;
    const shift = Math.max(limit - right, 16 - left);
    if (shift >= 0) return;
    world.classList.add('glide'); canvas.classList.add('glide');
    view.x = Math.round(view.x + shift); applyView();
    setTimeout(() => { if (world) world.classList.remove('glide'); if (canvas) canvas.classList.remove('glide'); }, 240);
  }
  function fitView() {
    if (!A.graph.nodes.length) { A.graph.view = { x: 0, y: 0, zoom: 1 }; applyView(); return; }
    const rect = canvas.getBoundingClientRect(); const pad = 56;
    const minX = Math.min(...A.graph.nodes.map(node => node.x)); const minY = Math.min(...A.graph.nodes.map(node => node.y));
    const maxX = Math.max(...A.graph.nodes.map(node => node.x + NODE_W)); const maxY = Math.max(...A.graph.nodes.map(node => node.y + (sizes.get(node.id) || 80)));
    const zoom = Math.max(0.3, Math.min(1, (rect.width - pad * 2) / Math.max(1, maxX - minX), (rect.height - pad * 2) / Math.max(1, maxY - minY)));
    A.graph.view = { zoom: Math.round(zoom * 100) / 100, x: Math.round((rect.width - (maxX - minX) * zoom) / 2 - minX * zoom), y: Math.round((rect.height - (maxY - minY) * zoom) / 2 - minY * zoom) };
    applyView();
  }

  // ───────────────────────── canvas painting
  function nodeHtml(node) {
    const ui = typeUi(node.type); const status = A.nodeStatus[node.id] || {};
    const selected = A.selection && A.selection.kind === 'node' && A.selection.id === node.id;
    const definition = E.NODE_TYPES[node.type] || {};
    let title = nodeName(node); let sub = ''; let problem = false;
    if (node.type === 'input') sub = 'Your test message starts here';
    else if (node.type === 'agent') {
      const agent = agentById(node.config.agentId);
      if (agent) sub = agent.model;
      else if (node.config.agentId) { sub = 'This agent was deleted'; problem = true; if (!node.title) title = 'Missing agent'; }
      else { sub = 'Choose an agent'; if (!node.title) title = 'AI Agent'; }
    } else if (node.type === 'markdown') {
      const first = node.config.content.split('\n').map(line => line.replace(/^[#>\-*\s]+/, '').trim()).find(Boolean);
      sub = first || 'No instructions yet';
    } else if (node.type === 'output') sub = status.output ? status.output.trim().slice(0, 120) : 'Final result';
    const badge = status.state === 'running' ? '<span class="af-node-state" title="Running"><span class="af-spin" aria-hidden="true"></span><span class="sr-only">Running</span></span>'
      : status.state === 'done' ? `<span class="af-node-state done" title="Completed">${ic('check')}<span class="sr-only">Completed</span></span>`
      : status.state === 'error' ? `<span class="af-node-state error" title="${esc(status.error || 'Failed')}">${ic('alert')}<span class="sr-only">Failed</span></span>`
      : status.state === 'skipped' ? '<span class="af-node-state text" title="Not connected to the Input">Not run</span>'
      : status.state === 'cancelled' ? '<span class="af-node-state text">Stopped</span>' : '';
    return `<div class="af-node type-${esc(node.type)}${selected ? ' selected' : ''}${status.state ? ` is-${status.state}` : ''}${problem ? ' has-problem' : ''}" data-node="${esc(node.id)}" tabindex="0" role="group" aria-label="${esc(typeLabel(node.type))}: ${esc(title)}">
      ${definition.hasInput ? '<span class="af-port in" data-port="in" title="Drag to connect"></span>' : ''}
      <div class="af-node-head"><span class="af-node-icon">${ic(ui.icon)}</span><span class="af-node-kind">${esc(typeLabel(node.type))}</span>${badge}</div>
      <div class="af-node-title">${esc(title)}</div>
      <div class="af-node-sub">${esc(sub)}</div>
      ${definition.hasOutput ? '<span class="af-port out" data-port="out" title="Drag to connect"></span>' : ''}
    </div>`;
  }
  function placeNode(element, node) {
    element.style.left = `${node.x}px`; element.style.top = `${node.y}px`;
    sizes.set(node.id, element.offsetHeight || 80);
  }
  function paintCanvas() {
    const layer = q('.af-nodes');
    if (!layer || !A.graph) return;
    layer.innerHTML = A.graph.nodes.map(nodeHtml).join('');
    for (const node of A.graph.nodes) placeNode(q(`[data-node="${node.id}"]`, layer), node);
    paintEdges();
    const empty = q('.af-canvas-hint'); if (empty) empty.hidden = A.graph.nodes.length > 0;
  }
  function updateNode(id) {
    const node = nodeById(id); const element = q(`.af-nodes [data-node="${id}"]`);
    if (!node || !element) return;
    const focused = document.activeElement === element;
    element.outerHTML = nodeHtml(node);
    const next = q(`.af-nodes [data-node="${id}"]`);
    placeNode(next, node);
    if (focused) next.focus();
    paintEdges();
  }
  function port(node, side) { return { x: node.x + (side === 'out' ? NODE_W : 0), y: node.y + (sizes.get(node.id) || 80) / 2 }; }
  function curve(a, b) {
    const reach = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x} ${a.y} C${a.x + reach} ${a.y} ${b.x - reach} ${b.y} ${b.x} ${b.y}`;
  }
  function paintEdges() {
    const svg = q('.af-edges');
    if (!svg || !A.graph) return;
    svg.innerHTML = A.graph.edges.map(edge => {
      const from = nodeById(edge.from); const to = nodeById(edge.to);
      if (!from || !to) return '';
      const d = curve(port(from, 'out'), port(to, 'in'));
      const selected = A.selection && A.selection.kind === 'edge' && A.selection.id === edge.id;
      const context = E.NODE_TYPES[from.type] && E.NODE_TYPES[from.type].kind === 'context';
      const target = (A.nodeStatus[to.id] || {}).state; const source = (A.nodeStatus[from.id] || {}).state;
      const flow = target === 'running' ? ' flow' : (source === 'done' && target === 'done') || (context && target === 'done') ? ' used' : '';
      return `<g data-edge="${esc(edge.id)}" class="af-edge-group${selected ? ' selected' : ''}${context ? ' context' : ''}${flow}"><path class="af-edge-hit" d="${d}"/><path class="af-edge" d="${d}"/></g>`;
    }).join('') + '<path class="af-edge temp" hidden d=""/>';
  }

  // ───────────────────────── canvas interaction
  function toWorld(event) {
    const rect = canvas.getBoundingClientRect(); const view = A.graph.view;
    return { x: (event.clientX - rect.left - view.x) / view.zoom, y: (event.clientY - rect.top - view.y) / view.zoom };
  }
  function onPointerDown(event) {
    if (!A.graph || (event.button !== 0 && event.button !== 1)) return;
    if (event.target.closest('.af-inspector, .af-canvas-hint button')) return;
    const portEl = event.target.closest('.af-port'); const nodeEl = event.target.closest('.af-node'); const edgeEl = event.target.closest('[data-edge]');
    if (event.button === 0 && portEl && nodeEl) {
      if (A.run) return;
      const id = nodeEl.dataset.node; const side = portEl.dataset.port;
      gesture = { kind: 'connect', id, side, pointer: event.pointerId };
      for (const element of root.querySelectorAll('.af-node')) {
        const other = element.dataset.node;
        const ok = other !== id && !E.connectionProblem(A.graph, side === 'out' ? id : other, side === 'out' ? other : id);
        element.classList.toggle('can-drop', ok); element.classList.toggle('no-drop', !ok && other !== id);
      }
      canvas.classList.add('is-connecting');
    } else if (event.button === 0 && nodeEl) {
      const node = nodeById(nodeEl.dataset.node);
      select({ kind: 'node', id: node.id });
      gesture = { kind: 'drag', id: node.id, startX: event.clientX, startY: event.clientY, origX: node.x, origY: node.y, moved: false, pointer: event.pointerId };
    } else if (event.button === 0 && edgeEl) {
      select({ kind: 'edge', id: edgeEl.dataset.edge });
      return;
    } else {
      if (event.button === 0) select(null);
      gesture = { kind: 'pan', startX: event.clientX, startY: event.clientY, origX: A.graph.view.x, origY: A.graph.view.y, pointer: event.pointerId };
      canvas.classList.add('is-panning');
      if (event.button === 1) event.preventDefault();
    }
    try { canvas.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }
  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const zoom = A.graph.view.zoom;
    if (gesture.kind === 'pan') {
      A.graph.view.x = Math.round(gesture.origX + event.clientX - gesture.startX);
      A.graph.view.y = Math.round(gesture.origY + event.clientY - gesture.startY);
      applyView({ save: false });
    } else if (gesture.kind === 'drag') {
      const dx = event.clientX - gesture.startX; const dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) < 3) return;
      if (A.run) return;
      if (!gesture.moved) { gesture.moved = true; pushHistory(); }
      const node = nodeById(gesture.id); if (!node) return;
      node.x = Math.round(gesture.origX + dx / zoom); node.y = Math.round(gesture.origY + dy / zoom);
      const element = q(`.af-nodes [data-node="${node.id}"]`);
      if (element) { element.style.left = `${node.x}px`; element.style.top = `${node.y}px`; }
      paintEdges();
    } else if (gesture.kind === 'connect') {
      const node = nodeById(gesture.id); const temp = q('.af-edge.temp');
      if (!node || !temp) return;
      const point = toWorld(event); const anchor = port(node, gesture.side);
      temp.setAttribute('d', gesture.side === 'out' ? curve(anchor, point) : curve(point, anchor));
      temp.removeAttribute('hidden');
    }
  }
  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const done = gesture; gesture = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    canvas.classList.remove('is-panning', 'is-connecting');
    if (done.kind === 'pan') { if (A.graph.view.x !== done.origX || A.graph.view.y !== done.origY) changed({ quiet: true }); }
    else if (done.kind === 'drag') { if (done.moved) changed(); else revealSelected(); }
    else if (done.kind === 'connect') {
      for (const element of root.querySelectorAll('.af-node')) element.classList.remove('can-drop', 'no-drop');
      const temp = q('.af-edge.temp'); if (temp) temp.setAttribute('hidden', '');
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit && hit.closest ? hit.closest('.af-node') : null;
      if (target && target.dataset.node !== done.id && event.type !== 'pointercancel')
        connect(done.side === 'out' ? done.id : target.dataset.node, done.side === 'out' ? target.dataset.node : done.id);
    }
  }
  function onCanvasKey(event) {
    if (event.target.closest('.af-inspector') || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const selection = A.selection;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection) { event.preventDefault(); deleteSelection(); return; }
    if (event.key === 'Escape' && selection) { event.stopPropagation(); select(null); canvas.focus(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selection && selection.kind === 'node') { event.preventDefault(); duplicateNode(selection.id); return; }
    const focusedNode = event.target.closest('.af-node');
    if ((event.key === 'Enter' || event.key === ' ') && focusedNode) {
      event.preventDefault(); select({ kind: 'node', id: focusedNode.dataset.node });
      const field = q('.af-inspector [data-field], .af-inspector select'); if (field) field.focus();
      revealSelected();
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[event.key] && selection && selection.kind === 'node' && !A.run) {
      event.preventDefault();
      const node = nodeById(selection.id); const step = event.shiftKey ? 40 : 10;
      pushHistory(`move:${node.id}`);
      node.x += arrows[event.key][0] * step; node.y += arrows[event.key][1] * step;
      const element = q(`.af-nodes [data-node="${node.id}"]`);
      if (element) { element.style.left = `${node.x}px`; element.style.top = `${node.y}px`; }
      paintEdges(); changed();
    }
  }

  // ───────────────────────── markdown (safe subset → HTML; everything is escaped first)
  function inlineMd(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 <span class="af-md-url">($2)</span>');
  }
  function mdToHtml(source) {
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n'); const out = []; let i = 0;
    const isSpecial = line => /^(#{1,6}\s|```|\s*[-*+]\s+|\s*\d+[.)]\s+|>\s?)/.test(line) || !line.trim();
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const code = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++; out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) { out.push(`<p class="af-md-h af-md-h${Math.min(3, heading[1].length)}">${inlineMd(heading[2])}</p>`); i++; continue; }
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(`<li>${inlineMd(lines[i++].replace(/^\s*[-*+]\s+/, ''))}</li>`);
        out.push(`<ul>${items.join('')}</ul>`); continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(`<li>${inlineMd(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        out.push(`<ol>${items.join('')}</ol>`); continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(inlineMd(lines[i++].replace(/^>\s?/, '')));
        out.push(`<blockquote>${quote.join('<br>')}</blockquote>`); continue;
      }
      if (!line.trim()) { i++; continue; }
      const paragraph = [];
      while (i < lines.length && !isSpecial(lines[i])) paragraph.push(inlineMd(lines[i++]));
      out.push(`<p>${paragraph.join('<br>')}</p>`);
    }
    return out.join('');
  }
  /* Final results: structured (JSON) output is pretty-printed; everything else is rendered as readable text. */
  function resultHtml(text) {
    const trimmed = String(text || '').trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    if (/^[[{]/.test(candidate)) {
      try { return `<pre class="af-json"><code>${esc(JSON.stringify(JSON.parse(candidate), null, 2))}</code></pre>`; } catch { /* not JSON */ }
    }
    return `<div class="af-md">${mdToHtml(trimmed)}</div>`;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); H.toast('Copied.'); }
    catch {
      const area = document.createElement('textarea'); area.value = text; area.className = 'sr-only';
      document.body.append(area); area.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { /* unavailable */ }
      area.remove(); H.toast(ok ? 'Copied.' : 'Could not copy.', { error: !ok });
    }
  }

  // ───────────────────────── inspector
  function connectionsHtml(node) {
    const definition = E.NODE_TYPES[node.type];
    const incoming = A.graph.edges.filter(edge => edge.to === node.id); const outgoing = A.graph.edges.filter(edge => edge.from === node.id);
    const row = (edge, otherId) => { const other = nodeById(otherId); return `<li><span>${esc(other ? nodeName(other) : 'Unknown')}</span><button class="icon-btn sm" type="button" data-af="remove-edge" data-id="${esc(edge.id)}" aria-label="Remove connection to ${esc(other ? nodeName(other) : 'node')}" title="Remove">${ic('x')}</button></li>`; };
    const targets = definition.hasOutput ? A.graph.nodes.filter(other => other.id !== node.id && !E.connectionProblem(A.graph, node.id, other.id)) : [];
    let html = '';
    if (definition.hasInput) html += `<div class="af-field"><span class="af-label">Receives from</span>${incoming.length ? `<ul class="af-links">${incoming.map(edge => row(edge, edge.from)).join('')}</ul>` : '<p class="af-help">Nothing connected yet.</p>'}</div>`;
    if (definition.hasOutput) html += `<div class="af-field"><span class="af-label">Sends to</span>${outgoing.length ? `<ul class="af-links">${outgoing.map(edge => row(edge, edge.to)).join('')}</ul>` : '<p class="af-help">Nothing connected yet.</p>'}
      ${targets.length ? `<select class="field af-select" data-af-change="connect-to" aria-label="Connect to another node"><option value="">Connect to…</option>${targets.map(other => `<option value="${esc(other.id)}">${esc(nodeName(other))} · ${esc(typeLabel(other.type))}</option>`).join('')}</select>` : ''}</div>`;
    return html;
  }
  function inspectorHtml() {
    const selection = A.selection;
    if (!selection) return '';
    if (selection.kind === 'edge') {
      const edge = A.graph.edges.find(item => item.id === selection.id);
      if (!edge) return '';
      const from = nodeById(edge.from); const to = nodeById(edge.to);
      return `<div class="af-insp-head"><span class="af-insp-title">Connection</span><button class="icon-btn sm" type="button" data-af="deselect" aria-label="Close" title="Close">${ic('x')}</button></div>
        <div class="af-insp-body"><p class="af-help">${esc(nodeName(from))} → ${esc(nodeName(to))}</p>
        <button class="btn btn-sm btn-ghost" type="button" data-af="delete-selection">${ic('trash')}Remove connection</button></div>`;
    }
    const node = nodeById(selection.id);
    if (!node) return '';
    const ui = typeUi(node.type); let body = '';
    const nameField = `<label class="af-field"><span class="af-label">Name</span><input class="field" data-field="title" maxlength="${E.LIMITS.title}" value="${esc(node.title)}" placeholder="${esc(nodeName({ ...node, title: '' }))}"></label>`;
    if (node.type === 'agent') {
      const agent = agentById(node.config.agentId); const missing = node.config.agentId && !agent;
      const options = `<option value="">Choose an agent…</option>${missing ? `<option value="${esc(node.config.agentId)}" selected>Deleted agent</option>` : ''}${A.agents.map(item => `<option value="${esc(item.id)}"${item.id === node.config.agentId ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}`;
      const skillName = id => (A.skills.find(skill => skill.id === id) || { name: `${id} (missing)` }).name;
      const custom = Array.isArray(node.config.skills);
      const skillPicker = agent ? `<div class="af-field"><span class="af-label">Skills for this step</span>
          <div class="toggle-track" role="group" aria-label="Skill source"><button class="toggle-pill${custom ? '' : ' active'}" type="button" data-af="skill-mode" data-value="agent" aria-pressed="${!custom}">Agent’s skills</button><button class="toggle-pill${custom ? ' active' : ''}" type="button" data-af="skill-mode" data-value="custom" aria-pressed="${custom}">Choose</button></div>
          ${custom ? (A.skills.length ? `<div class="af-skill-list">${A.skills.map(skill => `<label class="eco-check"><input type="checkbox" data-af-change="node-skill" value="${esc(skill.id)}"${node.config.skills.includes(skill.id) ? ' checked' : ''}><span>${esc(skill.name)}${skill.enabled ? '' : ' <span class="eco-tag">Disabled</span>'}</span></label>`).join('')}</div>` : '<p class="af-help">No skills exist yet.</p>')
            : `<p class="af-help">${(agent.skills || []).length ? (agent.skills || []).map(id => esc(skillName(id))).join(', ') : 'This agent has no skills assigned.'}</p>`}</div>` : '';
      const info = agent ? `<div class="af-agent-card"><div class="af-agent-row"><span class="avatar af-agent-avatar">${esc(agent.name.trim().slice(0, 2).toUpperCase())}</span><span class="af-agent-meta"><strong>${esc(agent.name)}</strong><span>${esc(agent.provider ? `${agent.provider.label} · ${agent.model}` : agent.model)}</span></span></div>
          ${agent.description ? `<p class="af-help">${esc(agent.description)}</p>` : ''}
          ${agent.instructions ? `<details class="af-details"><summary>Agent instructions</summary><p>${esc(agent.instructions)}</p></details>` : '<p class="af-help">This agent has no base instructions.</p>'}
          ${agent.problems ? '<p class="af-note error">This agent’s configuration needs attention.</p>' : ''}
          <button class="link-btn af-link" type="button" data-af="open-agent-files" data-id="${esc(agent.id)}">Edit agent files</button></div>${skillPicker}`
        : missing ? '<p class="af-note error" role="alert">The agent this node used was deleted. Choose another one.</p>'
        : A.agents.length ? '' : '<p class="af-note">You have no agents yet. Create one on the Agents page, then pick it here.</p>';
      body = `<div class="af-field"><label class="af-label" for="af-agent-select">Agent</label><select class="field af-select" id="af-agent-select" data-af-change="agent">${options}</select>
          <button class="link-btn af-link" type="button" data-af="manage-agents">Manage agents</button></div>
        ${info}${nameField}
        <label class="af-field"><span class="af-label">Additional instructions</span><textarea class="field field-area" data-field="instructions" rows="3" maxlength="${E.LIMITS.text}" placeholder="Extra guidance for this step only">${esc(node.config.instructions)}</textarea></label>
        <label class="af-field"><span class="af-label">Input mapping</span><textarea class="field field-area af-mono" data-field="inputTemplate" rows="3" maxlength="${E.LIMITS.text}">${esc(node.config.inputTemplate)}</textarea>
          <span class="af-help"><code>{{input}}</code> is what connected nodes send. <code>{{prompt}}</code> is your original message.</span></label>`;
    } else if (node.type === 'markdown') {
      const file = node.config.filename;
      body = `${nameField}
        <div class="af-field"><div class="af-row"><span class="af-label">Instructions</span>
          <div class="toggle-track" role="group" aria-label="Markdown view"><button class="toggle-pill${A.mdPreview ? '' : ' active'}" type="button" data-af="md-mode" data-value="edit" aria-pressed="${!A.mdPreview}">Edit</button><button class="toggle-pill${A.mdPreview ? ' active' : ''}" type="button" data-af="md-mode" data-value="preview" aria-pressed="${A.mdPreview}">Preview</button></div></div>
          ${A.mdPreview ? `<div class="af-md af-md-preview">${node.config.content.trim() ? mdToHtml(node.config.content) : '<p class="af-help">Nothing to preview yet.</p>'}</div>`
            : `<textarea class="field field-area af-mono af-md-editor" data-field="content" rows="9" maxlength="${E.LIMITS.markdown}" placeholder="# Instructions&#10;Write Markdown here, or import a .md file." aria-label="Markdown instructions">${esc(node.config.content)}</textarea>`}</div>
        <div class="af-file">${file ? `<span class="af-file-name" title="${esc(file)}">${ic('markdown')}<span>${esc(file)}</span></span>` : '<span class="af-help">No file attached</span>'}
          <button class="btn btn-sm btn-ghost" type="button" data-af="import-md">${ic('upload')}${file ? 'Replace' : 'Import .md'}</button></div>
        <p class="af-help">Connected agents receive this as part of their instructions.</p>`;
    } else if (node.type === 'output') {
      const status = A.nodeStatus[node.id] || {};
      body = `${nameField}<p class="af-help">${esc(ui.about)}</p>
        ${status.output ? `<div class="af-field"><div class="af-row"><span class="af-label">Last result</span><button class="icon-btn sm" type="button" data-af="copy-output" data-id="${esc(node.id)}" aria-label="Copy result" title="Copy">${ic('copy')}</button></div><div class="af-result">${resultHtml(status.output)}</div></div>` : ''}`;
    } else body = `${nameField}${ui.about ? `<p class="af-help">${esc(ui.about)}</p>` : ''}`;
    const status = A.nodeStatus[node.id];
    const failure = status && status.state === 'error' && status.error ? `<p class="af-note error" role="alert">${esc(status.error)}</p>` : '';
    return `<div class="af-insp-head"><span class="af-node-icon type-${esc(node.type)}">${ic(ui.icon)}</span><span class="af-insp-title">${esc(typeLabel(node.type))}</span>
        <button class="icon-btn sm" type="button" data-af="duplicate-node" aria-label="Duplicate node" title="Duplicate (Ctrl+D)">${ic('duplicate')}</button>
        <button class="icon-btn sm" type="button" data-af="delete-selection" aria-label="Delete node" title="Delete (Del)">${ic('trash')}</button>
        <button class="icon-btn sm" type="button" data-af="deselect" aria-label="Close" title="Close">${ic('x')}</button></div>
      <div class="af-insp-body">${failure}${body}${connectionsHtml(node)}</div>`;
  }
  function paintInspector({ keepFocus = false } = {}) {
    const panel = q('.af-inspector');
    if (!panel) return;
    const active = keepFocus && document.activeElement && panel.contains(document.activeElement) ? document.activeElement : null;
    const key = active ? (active.id ? `#${active.id}` : active.dataset.af ? `[data-af="${active.dataset.af}"]${active.dataset.value ? `[data-value="${active.dataset.value}"]` : ''}` : null) : null;
    const scroll = panel.scrollTop;
    const html = A.graph ? inspectorHtml() : '';
    panel.innerHTML = html; panel.hidden = !html; panel.scrollTop = scroll;
    if (key) { const next = q(key, panel); if (next) next.focus(); }
  }
  function onInspectorInput(event) {
    const field = event.target.dataset.field;
    const node = A.selection && A.selection.kind === 'node' ? nodeById(A.selection.id) : null;
    if (!field || !node || A.run) return;
    pushHistory(`field:${node.id}:${field}`);
    if (field === 'title') node.title = event.target.value.slice(0, E.LIMITS.title);
    else node.config[field] = event.target.value;
    clearProblem(node.id);
    changed(); updateNode(node.id);
  }
  // Editing a node's settings clears the failure mark left on it by the previous run.
  function clearProblem(id) { if (A.nodeStatus[id] && A.nodeStatus[id].state === 'error') delete A.nodeStatus[id]; }
  async function importMarkdown() {
    const node = A.selection && A.selection.kind === 'node' ? nodeById(A.selection.id) : null;
    if (!node || node.type !== 'markdown' || A.run) return;
    let picked;
    try { picked = await guard(() => api.importMarkdown()); } catch { return; }
    if (!picked || !nodeById(node.id)) return;
    pushHistory();
    node.config.content = picked.content; node.config.filename = picked.filename;
    clearProblem(node.id);
    changed(); updateNode(node.id); paintInspector();
    H.toast(`Imported ${picked.filename}.`);
  }

  // ───────────────────────── test chat
  const seconds = ms => `${(ms / 1000).toFixed(1)}s`;
  function stepHtml(step) {
    const mark = step.state === 'running' ? '<span class="af-spin" aria-hidden="true"></span>' : step.state === 'done' ? ic('check') : step.state === 'error' ? ic('alert') : '';
    const meta = step.state === 'running' ? 'Running' : step.state === 'done' ? seconds(step.durationMs || 0) : step.state === 'error' ? 'Failed' : 'Stopped';
    const showText = step.type === 'agent' && step.text;
    return `<li class="af-step is-${step.state}" data-step="${esc(step.nodeId)}"><div class="af-step-line"><span class="af-step-mark">${mark}</span><span class="af-step-name">${esc(step.name)}</span><span class="af-step-meta">${meta}</span></div>
      ${showText ? `<button class="af-step-preview${step.open ? ' open' : ''}" type="button" data-af="toggle-step" data-id="${esc(step.nodeId)}" aria-expanded="${Boolean(step.open)}" title="${step.open ? 'Collapse' : 'Expand'}">${esc(step.text)}</button>` : ''}
      ${step.error ? `<p class="af-step-error">${esc(step.error)}</p>` : ''}${step.diag ? diagHtml(step.diag) : ''}</li>`;
  }
  /* Which agent, provider/model, skills and context a step used. Token counts are estimates unless marked provider-reported. */
  function diagHtml(d) {
    const statusLabel = { selected: 'loaded', catalog: 'description only', disabled: 'disabled', missing: 'missing', invalid: 'invalid', omitted: 'omitted (budget)', error: 'error' };
    const skills = d.skills.length ? d.skills.map(skill => `<li><strong>${esc(skill.name)}</strong> — ${esc(statusLabel[skill.status] || skill.status)}: ${esc(skill.reason)}${(skill.references || []).length ? ` <span class="af-help">(${skill.references.map(ref => `${esc(ref.path)}: ${ref.status}`).join(', ')})</span>` : ''}</li>`).join('') : '<li>No skills.</li>';
    const items = d.items.map(item => `<li><span class="af-diag-state is-${esc(item.status)}">${esc(item.status)}</span> ${esc(item.section)} · ${esc(item.source)}${item.tokens ? ` · ~${item.tokens.toLocaleString()}` : ''}${item.reason ? ` <span class="af-help">${esc(item.reason)}</span>` : ''}</li>`).join('');
    const usage = d.usage ? `Provider-reported: ${d.usage.inputTokens?.toLocaleString() ?? '?'} in / ${d.usage.outputTokens?.toLocaleString() ?? '?'} out${d.usage.cachedTokens ? ` (${d.usage.cachedTokens.toLocaleString()} cached)` : ''}.` : 'The provider did not report token usage for this step.';
    return `<details class="af-details af-diag"><summary>Context and provider</summary><div class="af-diag-body">
      <p><strong>${esc(d.agent.name)}</strong> · ${esc(d.provider.label)} · ${esc(d.model)}${d.skillSource === 'node override' ? ' · skills chosen on this step' : ''}</p>
      <p>Estimated context: ~${d.estimatedTokens.toLocaleString()} of ${d.available.toLocaleString()} tokens (window ${d.contextWindow.toLocaleString()} from ${esc(d.contextSource)}, ${d.responseReserve.toLocaleString()} reserved for the reply). ${esc(usage)}</p>
      <p>Tools: ${d.tools.length ? esc(d.tools.join(', ')) : 'none'}. Caching: ${esc(d.caching)}${d.rounds > 1 ? ` · ${d.rounds} model rounds` : ''}</p>
      ${d.reused ? '<p>Reused the result of an identical earlier step in this run; the model was not called again.</p>' : ''}${d.retried ? '<p>One request was retried after a temporary provider problem or an empty reply.</p>' : ''}${d.truncated ? '<p class="af-step-error">The reply reached the output limit and may be cut off.</p>' : ''}
      ${(d.loadedOnDemand || []).length ? `<p>Skills the model loaded itself: ${d.loadedOnDemand.map(esc).join(', ')}</p>` : ''}${(d.delegations || []).length ? `<p>Delegated to: ${d.delegations.map(item => `${esc(item.agent)} (${(item.durationMs / 1000).toFixed(1)}s)`).join(', ')}</p>` : ''}
      ${d.notes.length ? `<p class="af-help">${d.notes.map(esc).join('<br>')}</p>` : ''}
      <p class="af-label">Skills</p><ul>${skills}</ul>
      <p class="af-label">Context parts</p><ul>${items}</ul>
      ${d.toolCalls.length ? `<p class="af-label">Tool actions</p><ul>${d.toolCalls.map(call => `<li>${esc(call.tool)}: ${esc(call.outcome)}${call.detail ? ` — ${esc(call.detail)}` : ''}</li>`).join('')}</ul>` : ''}
    </div></details>`;
  }
  function runHtml(entry) {
    const head = entry.status === 'running' ? '<span class="af-spin" aria-hidden="true"></span>Running workflow…'
      : entry.status === 'completed' ? `${ic('check')}Completed in ${seconds(entry.durationMs)}`
      : entry.status === 'cancelled' ? 'Stopped' : `${ic('alert')}Run failed`;
    const logs = entry.logs.map(line => `<span class="af-log ${esc(line.level)}">${esc(new Date(line.at).toLocaleTimeString([], { hour12: false }))}  ${esc(line.message)}</span>`).join('\n');
    return `<div class="af-run is-${entry.status}" data-run="${esc(entry.id)}">
      <div class="af-run-head">${head}</div>
      ${entry.steps.length ? `<ol class="af-steps">${entry.steps.map(stepHtml).join('')}</ol>` : ''}
      ${entry.error ? `<p class="af-run-error" role="alert">${esc(entry.error)}</p>` : ''}
      ${entry.logs.length ? `<details class="af-details af-logs"${entry.logsOpen ? ' open' : ''}><summary>Logs (${entry.logs.length})</summary><pre>${logs}</pre></details>` : ''}
    </div>${entry.status === 'completed' && entry.output !== null ? `<div class="af-final" data-final="${esc(entry.id)}"><div class="af-final-head"><span>Final output</span><button class="icon-btn sm" type="button" data-af="copy-final" data-id="${esc(entry.id)}" aria-label="Copy final output" title="Copy">${ic('copy')}</button></div>${resultHtml(entry.output)}</div>` : ''}`;
  }
  function entryHtml(entry) {
    if (entry.kind === 'user') return `<div class="msg user">${esc(entry.text)}<span class="msg-time">${esc(H.stamp(entry.at))}</span></div>`;
    return `<div class="af-run-wrap" data-run-wrap="${esc(entry.id)}">${runHtml(entry)}</div>`;
  }
  function paintChat({ stick = true } = {}) {
    const list = q('.af-chat');
    if (!list) return;
    const items = entries();
    list.innerHTML = items.length ? items.map(entryHtml).join('')
      : `<div class="chat-empty af-chat-empty">${ic('flow')}<p>Send a message to run this workflow from its Input node to its Output.</p></div>`;
    if (stick) list.scrollTop = list.scrollHeight;
    const clear = q('[data-af="clear-chat"]'); if (clear) clear.disabled = !items.length || Boolean(A.run);
  }
  function paintRun(entry) {
    const list = q('.af-chat'); const wrap = q(`[data-run-wrap="${entry.id}"]`);
    if (!list || !wrap) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    wrap.innerHTML = runHtml(entry);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  function setNodeStatus(id, status) {
    A.nodeStatus[id] = { ...(A.nodeStatus[id] || {}), ...status };
    if (connected() && A.run && A.current && A.run.workflowId === A.current.id) updateNode(id);
  }
  function onRunEvent(event) {
    const run = A.run;
    if (!run || !event || event.runId !== run.id) return;
    const entry = run.entry; const step = event.nodeId ? entry.steps.find(item => item.nodeId === event.nodeId) : null;
    switch (event.type) {
      case 'run-start': break;
      case 'node-skipped': setNodeStatus(event.nodeId, { state: 'skipped' }); return;
      case 'node-start':
        entry.steps.push({ nodeId: event.nodeId, name: event.name, type: event.nodeType, state: 'running', text: '', error: null, durationMs: 0, open: false });
        run.current = event.name; setNodeStatus(event.nodeId, { state: 'running', error: null });
        break;
      case 'node-delta': {
        if (!step) return;
        step.text += event.text;
        const preview = q(`[data-run-wrap="${entry.id}"] [data-step="${event.nodeId}"] .af-step-preview`);
        if (preview) { preview.textContent = step.text; if (!step.open) preview.scrollTop = preview.scrollHeight; return; }
        break;
      }
      case 'node-done':
        if (step) { step.state = 'done'; step.text = event.output; step.durationMs = event.durationMs; }
        setNodeStatus(event.nodeId, { state: 'done', output: event.output });
        break;
      case 'node-error':
        if (step) { step.state = 'error'; step.error = event.message; }
        setNodeStatus(event.nodeId, { state: 'error', error: event.message });
        break;
      case 'node-cancelled':
        if (step) step.state = 'cancelled';
        setNodeStatus(event.nodeId, { state: 'cancelled' });
        break;
      case 'node-diagnostics': if (step) step.diag = event.diagnostics; break;
      case 'log': entry.logs.push({ at: event.at, level: event.level, message: event.message }); break;
      case 'run-error':
        entry.error = event.message;
        for (const issue of event.issues || []) if (issue.nodeId) setNodeStatus(issue.nodeId, { state: 'error', error: issue.message });
        break;
      case 'run-done': case 'run-cancelled': break;
      default: break;
    }
    if (event.type === 'run-done' || event.type === 'run-error' || event.type === 'run-cancelled') { run.terminal = true; if (run.onTerminal) run.onTerminal(); }
    if (connected()) { paintRun(entry); paintStatus(); }
  }
  async function startRun(prompt) {
    if (A.run || !A.current || !A.graph) return;
    const state = A; const id = uid('run') + uid('');
    const entry = { kind: 'run', id, status: 'running', steps: [], logs: [], error: null, output: null, durationMs: 0, logsOpen: false };
    entries().push({ kind: 'user', text: prompt, at: new Date().toISOString() }, entry);
    A.nodeStatus = {}; A.run = { id, entry, workflowId: A.current.id, current: '' }; A.historyKey = null;
    if (connected()) { paintCanvas(); paintInspector(); paintChat(); paintStatus(); }
    try {
      const run = A.run;
      const result = await api.run(id, graphPayload(), prompt);
      // Step events travel separately from this reply and can land just after it; wait for the closing event.
      if (!run.terminal) await new Promise(resolve => { run.onTerminal = resolve; setTimeout(resolve, 1500); });
      entry.status = result.status; entry.output = result.output; entry.durationMs = result.durationMs;
      if (result.error) entry.error = result.error;
    } catch (error) { entry.status = 'failed'; entry.error = error.message || 'The workflow could not be started.'; }
    if (state !== A) return;
    for (const item of entry.steps) if (item.state === 'running') item.state = entry.status === 'cancelled' ? 'cancelled' : 'error';
    for (const status of Object.values(A.nodeStatus)) if (status.state === 'running') status.state = 'cancelled';
    if (entry.status === 'failed' && entry.logs.some(line => line.level === 'error')) entry.logsOpen = false;
    A.run = null;
    if (connected() && root.dataset.afRoot === 'editor') { paintCanvas(); paintInspector(); paintChat(); paintStatus(); }
  }
  function cancelRun() { if (A.run) api.cancel(A.run.id).catch(() => {}); }
  function submitPrompt() {
    const input = q('#af-input');
    if (A.run) { cancelRun(); return; }
    if (!A.testOpen) { A.testOpen = true; paintEditor(); }
    const field = q('#af-input') || input;
    const prompt = field ? field.value.trim() : '';
    if (!prompt) { if (field) field.focus(); H.toast('Write a test message, then run the workflow.'); return; }
    field.value = '';
    startRun(prompt);
  }

  // ───────────────────────── toolbar / status
  function paintStatus() {
    if (!connected() || root.dataset.afRoot !== 'editor' || !A.current) return;
    const running = Boolean(A.run);
    const last = [...entries()].reverse().find(entry => entry.kind === 'run');
    const status = q('.af-status');
    if (status) {
      const runText = running ? `<span class="af-spin" aria-hidden="true"></span>Running${A.run.current ? ` · ${esc(A.run.current)}` : ''}`
        : last && last.status === 'completed' ? `Completed in ${seconds(last.durationMs)}` : last && last.status === 'failed' ? 'Last run failed' : last && last.status === 'cancelled' ? 'Stopped' : 'Ready';
      const saveText = A.saving ? 'Saving…' : A.dirty ? 'Unsaved changes' : 'Saved';
      status.innerHTML = `<span class="af-status-run${last && last.status === 'failed' && !running ? ' error' : ''}">${runText}</span><span class="af-status-save">${saveText}</span>`;
    }
    const set = (selector, disabled) => { const element = q(selector); if (element) element.disabled = disabled; };
    set('[data-af="undo"]', !A.history.length || running); set('[data-af="redo"]', !A.future.length || running);
    set('[data-af="save"]', A.saving || !A.dirty);
    for (const selector of ['[data-af="add-block"]', '[data-af="add-agent"]', '[data-af="add-markdown"]']) set(selector, running);
    const run = q('[data-af="run"]');
    if (run) { run.innerHTML = running ? `${ic('stop')}Stop` : `${ic('play')}Run`; run.classList.toggle('btn-danger', running); run.setAttribute('aria-label', running ? 'Stop workflow' : 'Run workflow'); }
    const send = q('.af-composer [type=submit]');
    if (send) { send.innerHTML = running ? ic('stop') : ic('send'); send.setAttribute('aria-label', running ? 'Stop workflow' : 'Send and run workflow'); send.title = running ? 'Stop' : 'Send and run'; }
    const clear = q('[data-af="clear-chat"]'); if (clear) clear.disabled = !entries().length || running;
    canvas && canvas.classList.toggle('is-running', running);
  }

  // ───────────────────────── editor page
  function headHtml() {
    const workflow = A.current;
    if (A.renaming) return `<form class="page-head af-head af-rename" data-af-form="rename">
        <div class="af-rename-fields"><input class="field" name="title" maxlength="${E.LIMITS.title}" value="${esc(workflow.title)}" aria-label="Workflow title" required data-autofocus>
        <input class="field" name="description" maxlength="300" value="${esc(workflow.description)}" placeholder="Description (optional)" aria-label="Workflow description"></div>
        <div class="af-head-actions"><button class="btn btn-sm" type="submit">Save</button><button class="btn btn-sm btn-ghost" type="button" data-af="cancel-rename">Cancel</button></div></form>`;
    return `<header class="page-head af-head">
        <div class="af-title-wrap"><span class="af-eyebrow">Agentic Automation</span>
          <div class="af-title-row"><h1 tabindex="-1">${esc(workflow.title)}</h1><button class="icon-btn" type="button" data-af="rename" aria-label="Rename workflow" title="Rename">${ic('edit')}</button></div>
          <p class="subtitle">${esc(workflow.description || 'Build a pipeline from your agents and Markdown instructions, then test it on the right.')}</p></div>
        <div class="af-head-actions"><button class="btn btn-sm btn-ghost" type="button" data-af="workflows-menu" aria-haspopup="menu" aria-expanded="false">Workflows${ic('down')}</button></div>
      </header>`;
  }
  function editorHtml() {
    if (!A.current) return `<header class="page-head"><div><h1 tabindex="-1">Agentic Automation</h1><p class="subtitle">Connect your agents and Markdown instructions into workflows you can run and test.</p></div></header>
      <div class="chat-empty af-blank">${ic('flow', 'width="28" height="28"')}<h2 class="section-title">No workflows yet</h2><p>Create one to start connecting blocks on the canvas.</p><button class="btn" type="button" data-af="new-workflow">${ic('plus')}New workflow</button></div>`;
    return `${headHtml()}
      <div class="af-toolbar" role="toolbar" aria-label="Workflow tools">
        <button class="btn btn-sm btn-ghost" type="button" data-af="add-block" aria-haspopup="menu" aria-expanded="false">${ic('plus')}Block</button>
        <button class="btn btn-sm btn-ghost" type="button" data-af="add-agent">${ic('agent')}Agent</button>
        <button class="btn btn-sm btn-ghost" type="button" data-af="add-markdown">${ic('markdown')}Markdown</button>
        <span class="af-sep" aria-hidden="true"></span>
        <button class="icon-btn" type="button" data-af="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${ic('undo')}</button>
        <button class="icon-btn" type="button" data-af="redo" aria-label="Redo" title="Redo (Ctrl+Y)">${ic('redo')}</button>
        <span class="af-sep" aria-hidden="true"></span>
        <button class="icon-btn" type="button" data-af="zoom-out" aria-label="Zoom out" title="Zoom out">${ic('zoomOut')}</button>
        <button class="af-zoom-label" type="button" data-af="zoom-reset" title="Reset zoom" aria-label="Reset zoom">100%</button>
        <button class="icon-btn" type="button" data-af="zoom-in" aria-label="Zoom in" title="Zoom in">${ic('zoomIn')}</button>
        <button class="icon-btn" type="button" data-af="fit" aria-label="Fit workflow to view" title="Fit to view">${ic('fit')}</button>
        <span class="af-spacer"></span>
        <span class="af-status" role="status" aria-live="polite"></span>
        <button class="icon-btn${A.testOpen ? ' active' : ''}" type="button" data-af="toggle-test" aria-label="${A.testOpen ? 'Hide' : 'Show'} test panel" aria-pressed="${A.testOpen}" title="${A.testOpen ? 'Hide' : 'Show'} test panel">${ic('panel')}</button>
        <button class="btn btn-sm btn-ghost" type="button" data-af="save" title="Save (Ctrl+S)">${ic('save')}Save</button>
        <button class="btn btn-sm" type="button" data-af="run" aria-label="Run workflow">${ic('play')}Run</button>
      </div>
      <div class="af-body${A.testOpen ? '' : ' no-test'}">
        <div class="af-canvas" tabindex="0" aria-label="Workflow canvas. Tab to a node, arrow keys move it, Delete removes it.">
          <div class="af-world"><svg class="af-edges" aria-hidden="true"></svg><div class="af-nodes"></div></div>
          <p class="af-canvas-hint" hidden>This workflow is empty. Add an Input block to begin.</p>
          <aside class="af-inspector" aria-label="Node settings" hidden></aside>
        </div>
        ${A.testOpen ? `<aside class="af-test" aria-label="Test workflow">
          <div class="af-test-head"><span class="section-title">Test</span><button class="icon-btn sm" type="button" data-af="clear-chat" aria-label="Clear test conversation" title="Clear">${ic('trash')}</button></div>
          <div class="af-chat" aria-live="polite"></div>
          <form class="af-composer" data-af-form="prompt"><textarea class="field field-area" id="af-input" rows="1" maxlength="${E.LIMITS.prompt}" placeholder="Message the workflow…" aria-label="Test message"></textarea><button class="icon-btn solid" type="submit" aria-label="Send and run workflow" title="Send and run">${ic('send')}</button></form>
        </aside>` : ''}
      </div>`;
  }
  function paintEditor() {
    if (!connected() || root.dataset.afRoot !== 'editor') return;
    const draft = q('#af-input') ? q('#af-input').value : '';
    root.innerHTML = editorHtml();
    canvas = q('.af-canvas'); world = q('.af-world'); gesture = null;
    if (canvas) {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('keydown', onCanvasKey);
      canvas.addEventListener('dblclick', event => { if (event.target.closest('.af-node')) { const field = q('.af-inspector [data-field], .af-inspector select'); if (field) field.focus(); } });
      canvas.addEventListener('wheel', event => {
        if (event.target.closest('.af-inspector')) return;
        event.preventDefault();
        zoomAt(event.clientX, event.clientY, A.graph.view.zoom * Math.exp(-event.deltaY * 0.0015));
      }, { passive: false });
      const inspector = q('.af-inspector');
      inspector.addEventListener('input', onInspectorInput);
      inspector.addEventListener('focusout', () => { A.historyKey = null; });
      applyView({ save: false }); paintCanvas(); paintInspector(); paintChat();
      // A workflow that has never been panned or zoomed opens fitted, so no block starts off-screen.
      const view = A.graph.view; const box = canvas.getBoundingClientRect();
      if (view.x === 0 && view.y === 0 && view.zoom === 1 && box.width && A.graph.nodes.some(node => node.x < 0 || node.y < 0 || node.x + NODE_W > box.width || node.y + (sizes.get(node.id) || 80) > box.height)) { fitView(); A.dirty = false; clearTimeout(A.saveTimer); }
      if (draft && q('#af-input')) q('#af-input').value = draft;
    }
    paintStatus();
    const focus = q('[data-autofocus]'); if (focus) { focus.focus(); if (focus.select) focus.select(); }
  }

  // ───────────────────────── menus
  function closeMenu() {
    const menu = document.getElementById('af-menu');
    if (menu && !menu.hidden) { menu.hidden = true; for (const button of document.querySelectorAll('[data-af][aria-haspopup]')) button.setAttribute('aria-expanded', 'false'); }
  }
  function openMenu(anchor, html) {
    const menu = document.getElementById('af-menu');
    const wasOpen = !menu.hidden && menu.dataset.anchor === anchor.dataset.af;
    H.closeLayers(); closeMenu();
    if (wasOpen) return;
    menu.innerHTML = html; menu.dataset.anchor = anchor.dataset.af; menu.hidden = false;
    const rect = anchor.getBoundingClientRect(); const width = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('.menu-item:not(:disabled)'); if (first) first.focus();
  }
  function workflowsMenu(anchor) {
    const list = A.workflows.map(workflow => `<button class="menu-item af-menu-wf" type="button" role="menuitem" data-af="open-workflow" data-id="${esc(workflow.id)}"${A.current && workflow.id === A.current.id ? ' aria-current="true"' : ''}><span class="af-menu-title">${esc(workflow.title)}</span>${A.current && workflow.id === A.current.id ? ic('check') : ''}</button>`).join('');
    openMenu(anchor, `<div class="af-menu-list">${list}</div><div class="af-menu-divider" aria-hidden="true"></div>
      <button class="menu-item" type="button" role="menuitem" data-af="new-workflow">${ic('plus')}New workflow</button>
      <button class="menu-item" type="button" role="menuitem" data-af="duplicate-workflow">${ic('duplicate')}Duplicate</button>
      <button class="menu-item" type="button" role="menuitem" data-af="rename">${ic('edit')}Rename</button>
      <button class="menu-item danger" type="button" role="menuitem" data-af="delete-workflow">${ic('trash')}Delete</button>`);
  }
  function blockMenu(anchor) {
    // Every registered node type without its own toolbar button appears here, so new types need no editor change.
    const types = Object.keys(E.NODE_TYPES).filter(type => type !== 'agent' && type !== 'markdown');
    openMenu(anchor, types.map(type => {
      const definition = E.NODE_TYPES[type];
      const full = definition.max && A.graph.nodes.filter(node => node.type === type).length >= definition.max;
      return `<button class="menu-item" type="button" role="menuitem" data-af="add-node" data-value="${esc(type)}"${full ? ' disabled' : ''}>${ic(typeUi(type).icon)}${esc(definition.label)}${full ? '<kbd>Added</kbd>' : ''}</button>`;
    }).join(''));
  }

  // ───────────────────────── workflow actions
  async function newWorkflow() {
    if (A.run) { H.toast('Stop the running workflow first.', { error: true }); return; }
    if (A.current && A.dirty) await saveNow().catch(() => {});
    const created = await guard(() => api.createWorkflow({ title: 'Untitled workflow' }));
    A.workflows.unshift({ id: created.id, title: created.title, description: created.description, createdAt: created.createdAt, updatedAt: created.updatedAt });
    await openWorkflow(created.id, { paint: false });
    A.renaming = true;
    if (connected()) paintEditor();
  }
  async function duplicateWorkflow() {
    if (!A.current || A.run) return;
    if (A.dirty) await saveNow().catch(() => {});
    const copy = await guard(() => api.duplicateWorkflow(A.current.id));
    A.workflows.unshift({ id: copy.id, title: copy.title, description: copy.description, createdAt: copy.createdAt, updatedAt: copy.updatedAt });
    await openWorkflow(copy.id);
    H.toast('Workflow duplicated.');
  }
  async function deleteWorkflow() {
    if (!A.current) return;
    if (A.run) { H.toast('Stop the running workflow first.', { error: true }); return; }
    const workflow = A.current;
    if (!await H.confirmDialog({ title: 'Delete this workflow?', text: `“${workflow.title}” and its blocks will be permanently deleted.` })) return;
    clearTimeout(A.saveTimer);
    await guard(() => api.deleteWorkflow(workflow.id));
    A.workflows = A.workflows.filter(item => item.id !== workflow.id);
    delete A.chat[workflow.id];
    A.current = null; A.graph = null; A.selection = null; A.dirty = false;
    if (A.workflows.length) await openWorkflow(A.workflows[0].id); else if (connected()) paintEditor();
    H.toast('Workflow deleted.');
  }
  async function renameWorkflow(form) {
    const fields = form.elements; const title = fields.title.value.trim(); const description = fields.description.value.trim();
    if (!title) { fields.title.focus(); return; }
    A.current.title = title.slice(0, E.LIMITS.title); A.current.description = description.slice(0, 300);
    A.renaming = false; A.dirty = true;
    paintEditor();
    await saveNow().catch(() => {});
  }

  async function onAction(button, event) {
    const action = button.dataset.af; const id = button.dataset.id;
    if (button.closest('#af-menu') && action !== 'open-workflow') closeMenu();
    switch (action) {
      case 'workflows-menu': workflowsMenu(button); break;
      case 'add-block': blockMenu(button); break;
      case 'add-node': addNode(button.dataset.value); break;
      case 'add-agent': addAgentNode(); break;
      case 'add-markdown': addNode('markdown'); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'zoom-in': zoomStep(1); break;
      case 'zoom-out': zoomStep(-1); break;
      case 'zoom-reset': { const rect = canvas.getBoundingClientRect(); zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1); break; }
      case 'fit': fitView(); break;
      case 'save': await saveNow().then(() => { if (!A.dirty) H.toast('Workflow saved.'); }).catch(() => {}); break;
      case 'run': submitPrompt(); break;
      case 'toggle-test': A.testOpen = !A.testOpen; paintEditor(); break;
      case 'clear-chat': if (!A.run && A.current) { A.chat[A.current.id] = []; paintChat(); paintStatus(); } break;
      case 'rename': if (A.current && !A.run) { A.renaming = true; paintEditor(); } break;
      case 'cancel-rename': A.renaming = false; paintEditor(); break;
      case 'new-workflow': await newWorkflow().catch(() => {}); break;
      case 'duplicate-workflow': await duplicateWorkflow().catch(() => {}); break;
      case 'delete-workflow': await deleteWorkflow().catch(() => {}); break;
      case 'open-workflow': closeMenu(); if (!A.current || id !== A.current.id) await openWorkflow(id).catch(() => {}); break;
      case 'deselect': select(null); if (canvas) canvas.focus(); break;
      case 'delete-selection': deleteSelection(); break;
      case 'duplicate-node': if (A.selection) duplicateNode(A.selection.id); break;
      case 'remove-edge': removeEdge(id); break;
      case 'manage-agents': H.go('agents'); break;
      case 'md-mode': A.mdPreview = button.dataset.value === 'preview'; paintInspector({ keepFocus: true }); break;
      case 'import-md': await importMarkdown(); break;
      case 'copy-output': { const status = A.nodeStatus[id]; if (status && status.output) copyText(status.output); break; }
      case 'copy-final': { const entry = entries().find(item => item.id === id); if (entry && entry.output) copyText(entry.output); break; }
      case 'toggle-step': {
        const wrap = button.closest('[data-run]'); const entry = wrap ? entries().find(item => item.id === wrap.dataset.run) : null;
        const step = entry ? entry.steps.find(item => item.nodeId === id) : null;
        if (step) { step.open = !step.open; button.classList.toggle('open', step.open); button.setAttribute('aria-expanded', String(step.open)); }
        break;
      }
      case 'open-agent-files': if (eco && id) { eco.openAgent(id); H.go('agents'); } break;
      case 'skill-mode': {
        const node = A.selection && A.selection.kind === 'node' ? nodeById(A.selection.id) : null;
        if (!node || node.type !== 'agent' || A.run) break;
        pushHistory();
        if (button.dataset.value === 'custom') node.config.skills = [...((agentById(node.config.agentId) || {}).skills || [])];
        else delete node.config.skills; // back to the agent's own skills; older workflows have no field at all
        changed(); paintInspector({ keepFocus: true });
        break;
      }
      case 'open-automation': H.go('automation'); break;
      default: break;
    }
    void event;
  }
  function onChange(event) {
    const kind = event.target.dataset.afChange;
    const node = A.selection && A.selection.kind === 'node' ? nodeById(A.selection.id) : null;
    if (!kind || !node || A.run) return;
    if (kind === 'agent') {
      pushHistory();
      node.config.agentId = event.target.value || null;
      clearProblem(node.id);
      changed(); updateNode(node.id); paintInspector({ keepFocus: true });
    } else if (kind === 'node-skill' && Array.isArray(node.config.skills)) {
      pushHistory();
      const id = event.target.value;
      node.config.skills = event.target.checked ? [...new Set([...node.config.skills, id])] : node.config.skills.filter(item => item !== id);
      changed();
    } else if (kind === 'connect-to' && event.target.value) {
      connect(node.id, event.target.value);
    }
  }

  // ───────────────────────── agents & skills pages (src/ecosystem-ui.js)
  // The Agents, LLM APIs and Skills screens live in ecosystem-ui.js; they share A.agents / A.skills with the editor.
  let eco = null;

  // ───────────────────────── mounting
  function bindRoot() {
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-af]');
      if (button && !button.disabled) onAction(button, event);
    });
    root.addEventListener('change', onChange);
    root.addEventListener('submit', event => {
      const form = event.target.closest('[data-af-form]');
      if (!form) return;
      event.preventDefault();
      if (form.dataset.afForm === 'prompt') submitPrompt();
      else if (form.dataset.afForm === 'rename') renameWorkflow(form);
    });
    root.addEventListener('toggle', event => {
      const details = event.target; const wrap = details.closest && details.closest('[data-run]');
      if (!wrap || !details.classList.contains('af-logs')) return;
      const entry = entries().find(item => item.id === wrap.dataset.run); if (entry) entry.logsOpen = details.open;
    }, true);
    root.addEventListener('keydown', event => {
      if (event.target.id === 'af-input' && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!A.run) submitPrompt(); }
    });
  }
  function mount(stage, kind) {
    root = stage.querySelector('[data-af-root]');
    if (!root) return;
    canvas = null; world = null; gesture = null;
    bindRoot();
    const paint = () => paintEditor();
    if (A.loaded) { paint(); return; }
    load().then(() => { if (connected() && root.dataset.afRoot === kind) paint(); })
      .catch(error => { if (connected()) root.innerHTML = `<div class="chat-empty af-blank"><p>${esc(error.message || 'Automation could not be loaded.')}</p></div>`; });
  }
  const shell = kind => `<div class="af-page" data-af-root="${kind}"><div class="chat-empty af-blank"><span class="spinner" aria-hidden="true"></span><p>Loading…</p></div></div>`;

  function init(helpers) {
    H = helpers;
    if (!E || !api) return;
    eco = window.PerflwEcosystemUI ? window.PerflwEcosystemUI.create({
      H, ic, esc, api,
      getAgents: () => A.agents, setAgents: list => { A.agents = list; },
      getSkills: () => A.skills, setSkills: list => { A.skills = list; }
    }) : null;
    api.onEvent(onRunEvent);
    const menu = document.getElementById('af-menu');
    menu.addEventListener('click', event => { const button = event.target.closest('[data-af]'); if (button && !button.disabled) onAction(button, event); });
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')]; const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
    });
    document.addEventListener('click', event => { if (!event.target.closest('#af-menu') && !event.target.closest('[data-af][aria-haspopup]')) closeMenu(); });
    document.addEventListener('keydown', event => {
      const menu = document.getElementById('af-menu');
      if (event.key === 'Escape' && !menu.hidden) { const anchor = document.querySelector(`[data-af="${menu.dataset.anchor}"]`); closeMenu(); if (anchor) anchor.focus(); return; }
      if (!connected() || root.dataset.afRoot !== 'editor' || !A.current || !document.getElementById('confirm-overlay').hidden || !document.getElementById('search-overlay').hidden) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      const mod = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase();
      if (event.key === 'Escape' && A.renaming) { A.renaming = false; paintEditor(); return; }
      if (event.key === 'Escape' && event.target.closest && event.target.closest('.af-inspector') && A.selection) {
        const id = A.selection.kind === 'node' ? A.selection.id : null;
        select(null);
        const back = id ? q(`.af-nodes [data-node="${id}"]`) : canvas; if (back) back.focus();
        return;
      }
      if (mod && key === 's') { event.preventDefault(); saveNow().then(() => { if (!A.dirty) H.toast('Workflow saved.'); }).catch(() => {}); return; }
      if (typing) return; // let fields keep their own undo
      if (mod && key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
      else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) { event.preventDefault(); redo(); }
    });
    window.addEventListener('resize', closeMenu);
  }
  function reset() {
    if (A.run) api.cancel(A.run.id).catch(() => {});
    clearTimeout(A.saveTimer);
    closeMenu(); sizes.clear();
    if (eco) eco.reset();
    A = fresh();
  }

  window.PerflwAutomation = {
    init, reset, closeMenu,
    flush: () => (A.dirty ? saveNow().catch(() => {}) : Promise.resolve()),
    search: () => ({ workflows: A.workflows, agents: A.agents, skills: A.skills }),
    openWorkflow: id => openWorkflow(id).catch(() => {}),
    openAgent: id => { if (eco) eco.openAgent(id); },
    openSkill: id => { if (eco) eco.openSkill(id); },
    hasUnsaved: () => Boolean(eco && eco.hasUnsaved()),
    discardUnsaved: () => { if (eco) eco.discard(); },
    views: {
      automation: { render: () => shell('editor'), mount: stage => mount(stage, 'editor') },
      // eco is created in init(); these wrappers keep the view table valid before then.
      agents: { render: () => (eco ? eco.views.agents.render() : shell('agents')), mount: stage => { if (eco) eco.views.agents.mount(stage); } },
      skills: { render: () => (eco ? eco.views.skills.render() : shell('skills')), mount: stage => { if (eco) eco.views.skills.mount(stage); } }
    }
  };
})();

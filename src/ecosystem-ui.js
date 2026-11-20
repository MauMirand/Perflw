'use strict';
/* Agent Ecosystem screens: Agents (overview + file editor), LLM APIs (provider connections) and Skills.
   Created by automation.js, which owns the shared agent list and the workflow editor.
   Every control calls the main process through window.automationData; nothing here is display-only.
   API keys are typed into a password field and sent once to be encrypted; they are never read back. */
(() => {
  function createEcosystemUI({ H, ic, esc, api, getAgents, setAgents, getSkills, setSkills }) {
    let root = null; let kind = null;
    const S = {
      meta: null, providers: [], loaded: false, ollama: null,
      // agents
      mode: 'agents', agentSel: null, agent: null, tab: 'overview', settings: null, settingsDirty: false, models: {},
      file: null, draft: null, saved: null, newFile: false,
      // providers
      providerSel: null, providerType: 'openai', providerTest: null, testing: false,
      // skills
      skillSel: null, skill: null, skillFile: null, skillDraft: null, skillSaved: null, skillNewFile: false, scriptOut: null, running: false
    };
    const q = selector => (root ? root.querySelector(selector) : null);
    const connected = () => Boolean(root && root.isConnected);
    async function guard(task) {
      try { return await task(); } catch (error) { H.toast(error.message || 'Something went wrong.', { error: true }); throw error; }
    }
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const providerById = id => S.providers.find(item => item.id === id) || null;
    const fileDirty = () => S.draft !== null && S.draft !== S.saved;
    const skillDirty = () => S.skillDraft !== null && S.skillDraft !== S.skillSaved;
    async function confirmDiscard() {
      if (!fileDirty() && !skillDirty() && !S.settingsDirty) return true;
      const ok = await H.confirmDialog({ title: 'Discard unsaved changes?', text: 'Your edits have not been saved.' });
      if (ok) { S.draft = null; S.saved = null; S.skillDraft = null; S.skillSaved = null; S.settingsDirty = false; }
      return ok;
    }

    async function loadShared() {
      const [meta, providers, skills, agents] = await Promise.all([S.meta ? S.meta : api.meta(), api.providers(), api.skills(), api.agents()]);
      S.meta = meta; S.providers = providers; setSkills(skills); setAgents(agents); S.loaded = true;
    }
    /* Local Ollama status (kept from the original Agents page). */
    async function refreshOllama() {
      try { S.ollama = await api.models(); } catch (error) { S.ollama = { available: false, models: [], error: error.message }; }
      if (connected() && kind === 'agents') paintKeepingForm();
    }
    function ollamaHtml() {
      const status = S.ollama;
      if (!status) return '<p class="af-runtime">Checking Ollama…</p>';
      return status.available ? `<p class="af-runtime">Ollama is running on this computer · ${plural(status.models.length, 'model')} installed</p>`
        : `<p class="af-runtime error" role="alert">${esc(status.error || 'Ollama is not available.')} <button class="link-btn" type="button" data-eco="retry-ollama">Try again</button></p>`;
    }
    async function refreshAgents() { setAgents(await api.agents()); }
    async function refreshSkills() { setSkills(await api.skills()); }

    // ───────────────────────── shared file editor
    /* tree: [{ path, kind, size }]; opts: { selected, draft, dirty, deletable(path), newFolders, newOpen, scope } */
    function filesHtml(tree, opts) {
      const items = tree.map(item => {
        const depth = item.path.split('/').length - 1; const label = item.path.split('/').pop();
        if (item.kind === 'dir') return `<li class="eco-tree-dir" style="--depth:${depth}">${esc(label)}/</li>`;
        return `<li style="--depth:${depth}"><button class="eco-tree-file${item.path === opts.selected ? ' active' : ''}" type="button" data-eco="open-file" data-scope="${opts.scope}" data-path="${esc(item.path)}" aria-current="${item.path === opts.selected}">${esc(label)}</button></li>`;
      }).join('');
      const editor = opts.selected
        ? `<div class="eco-editor-head"><span class="eco-editor-name">${esc(opts.selected)}</span><span class="eco-save-state${opts.dirty ? ' dirty' : ''}" role="status">${opts.dirty ? 'Unsaved changes' : 'Saved'}</span>
            ${opts.deletable(opts.selected) ? `<button class="icon-btn sm" type="button" data-eco="delete-file" data-scope="${opts.scope}" aria-label="Delete ${esc(opts.selected)}" title="Delete file">${ic('trash')}</button>` : ''}
            <button class="btn btn-sm btn-ghost" type="button" data-eco="revert-file" data-scope="${opts.scope}"${opts.dirty ? '' : ' disabled'}>Revert</button>
            <button class="btn btn-sm" type="button" data-eco="save-file" data-scope="${opts.scope}"${opts.dirty ? '' : ' disabled'}>Save</button></div>
          ${opts.help ? `<p class="af-help">${esc(opts.help)}</p>` : ''}
          <textarea class="field field-area af-mono eco-editor" data-eco-input="${opts.scope}-file" spellcheck="false" aria-label="Contents of ${esc(opts.selected)}">${esc(opts.draft ?? '')}</textarea>`
        : '<div class="chat-empty eco-editor-empty"><p>Choose a file to view or edit it.</p></div>';
      const newForm = opts.newOpen ? `<form class="eco-new-file" data-eco-form="${opts.scope}-new-file">
          <select class="field af-select" name="folder" aria-label="Folder">${opts.newFolders.map(folder => `<option value="${esc(folder)}">${esc(folder)}/</option>`).join('')}</select>
          <input class="field" name="name" maxlength="80" placeholder="notes.md" aria-label="File name" required data-autofocus>
          <button class="btn btn-sm" type="submit">Create</button><button class="btn btn-sm btn-ghost" type="button" data-eco="cancel-new-file" data-scope="${opts.scope}">Cancel</button></form>` : '';
      return `<div class="eco-files"><div class="eco-tree"><ul>${items}</ul>
          ${opts.newFolders.length ? `<button class="link-btn af-link" type="button" data-eco="new-file" data-scope="${opts.scope}">${ic('plus')}New file</button>` : ''}${newForm}</div>
        <div class="eco-editor">${editor}</div></div>`;
    }

    // ───────────────────────── agents page
    function providerLabel(agent) { return agent.provider ? `${agent.provider.missing ? 'Missing provider' : agent.provider.label} · ${agent.model}` : agent.model; }
    function agentsHtml() {
      const agents = getAgents();
      const list = agents.length ? agents.map(agent => `<button class="chat-item${S.mode === 'agents' && agent.id === S.agentSel ? ' active' : ''}" type="button" data-eco="open-agent" data-id="${esc(agent.id)}" aria-current="${agent.id === S.agentSel}">
          <span class="chat-item-title">${esc(agent.name)}${agent.problems ? ' <span class="eco-dot" title="Needs attention" aria-label="Needs attention"></span>' : ''}</span><span class="chat-item-meta">${esc(providerLabel(agent))}</span></button>`).join('')
        : '<p class="empty">No agents yet.</p>';
      let pane;
      if (S.mode === 'providers') pane = providersHtml();
      else if (S.agentSel === 'new') pane = newAgentHtml();
      else if (S.agent) pane = agentHtml();
      else pane = `<div class="chat-pane"><div class="chat-empty">${ic('agent', 'width="28" height="28"')}<h2 class="section-title">${agents.length ? 'Choose an agent' : 'Create your first agent'}</h2>
          <p>Each agent has its own editable files, provider and model, skills and permissions. Use agents as blocks in a workflow.</p>${ollamaHtml()}
          <button class="btn" type="button" data-eco="new-agent">${ic('plus')}New agent</button></div></div>`;
      return `<header class="page-head"><div><h1 tabindex="-1">Agents</h1><p class="subtitle">Editable agents with their own files, model, skills and permissions.</p></div>
          <div class="eco-head-actions"><button class="btn btn-ghost" type="button" data-eco="import-agent">${ic('upload')}Import</button>
          <button class="btn btn-ghost${S.mode === 'providers' ? ' active' : ''}" type="button" data-eco="providers" aria-pressed="${S.mode === 'providers'}">LLM APIs</button>
          <button class="btn" type="button" data-eco="new-agent">${ic('plus')}New agent</button></div></header>
        <div class="chat-layout"><aside class="chat-list" aria-label="Agents">${list}</aside>${pane}</div>`;
    }
    function providerOptions(selected) {
      return S.providers.map(item => `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.label)}${item.capabilities && !item.capabilities.local ? ' (cloud)' : ''}</option>`).join('');
    }
    function modelField(connectionId, model, name = 'model') {
      const state = S.models[connectionId];
      const listId = `eco-models-${esc(connectionId)}`;
      const status = !state ? '<button class="link-btn af-link" type="button" data-eco="load-models" data-id="' + esc(connectionId) + '">Load available models</button>'
        : state.loading ? '<span class="af-help">Loading models…</span>'
        : state.error ? `<span class="af-help eco-error">${esc(state.error)} You can still type a model name.</span> <button class="link-btn af-link" type="button" data-eco="load-models" data-id="${esc(connectionId)}">Retry</button>`
        : `<span class="af-help">${plural(state.models.length, 'model')} found. Pick one or type a name.</span>`;
      return `<input class="field" name="${name}" list="${listId}" maxlength="160" value="${esc(model || '')}" placeholder="Model name, e.g. qwen2.5:1.5b" required autocomplete="off">
        <datalist id="${listId}">${(state?.models || []).map(item => `<option value="${esc(item.id)}">${item.contextWindow ? `${item.contextWindow.toLocaleString('en-US')} tokens` : ''}</option>`).join('')}</datalist>${status}`;
    }
    function newAgentHtml() {
      const connectionId = S.newConnection || 'ollama-local';
      return `<form class="chat-pane af-agent-form" data-eco-form="new-agent"><div class="chat-head"><span class="chat-title">New agent</span></div>
        <div class="af-agent-fields">${ollamaHtml()}
          <label class="af-field"><span class="af-label">Name</span><input class="field" name="name" maxlength="80" placeholder="e.g. Researcher" required data-autofocus></label>
          <label class="af-field"><span class="af-label">Description <span class="optional">optional</span></span><input class="field" name="description" maxlength="300" placeholder="What this agent is for"></label>
          <label class="af-field"><span class="af-label">Provider</span><select class="field af-select" name="connectionId" data-eco-change="new-provider">${providerOptions(connectionId)}</select>
            <span class="af-help">Add OpenAI, Anthropic, Gemini or a custom endpoint under <button class="link-btn af-link" type="button" data-eco="providers">LLM APIs</button>.</span></label>
          <div class="af-field"><span class="af-label">Model</span>${modelField(connectionId, '')}</div>
          <p class="af-help">New agents start with no tool permissions and no skills. You can edit everything after creating it.</p>
          <div class="af-agent-actions"><button class="btn btn-sm" type="submit">Create agent</button><button class="btn btn-sm btn-ghost" type="button" data-eco="cancel-new">Cancel</button></div>
        </div></form>`;
    }
    function agentHtml() {
      const agent = S.agent;
      const tabs = [['overview', 'Overview'], ['files', 'Files']].map(([value, label]) => `<button class="toggle-pill${S.tab === value ? ' active' : ''}" type="button" data-eco="agent-tab" data-value="${value}" aria-pressed="${S.tab === value}">${label}</button>`).join('');
      return `<div class="chat-pane eco-pane"><div class="chat-head"><span class="chat-title">${esc(agent.name)}</span>
          <div class="toggle-track" role="group" aria-label="Agent view">${tabs}</div>
          <button class="icon-btn" type="button" data-eco="duplicate-agent" aria-label="Duplicate agent" title="Duplicate">${ic('duplicate')}</button>
          <button class="icon-btn" type="button" data-eco="export-agent" aria-label="Export agent" title="Export to a folder">${ic('save')}</button>
          <button class="icon-btn" type="button" data-eco="delete-agent" aria-label="Delete agent" title="Delete">${ic('trash')}</button></div>
        ${S.tab === 'files' ? `<div class="eco-pane-body">${filesHtml(agent.tree, { scope: 'agent', selected: S.file, draft: S.draft, dirty: fileDirty(), deletable: rel => rel.startsWith('resources/'), newFolders: ['resources'], newOpen: S.newFile, help: S.meta.agentFiles[S.file] || (S.file && S.file.startsWith('resources/') ? 'Resource files are loaded only when they match the task.' : '') })}</div>` : overviewHtml()}</div>`;
    }
    function overviewHtml() {
      const agent = S.agent; const settings = S.settings; const provider = providerById(settings.connectionId);
      const problems = agent.problems.length ? `<div class="af-note error" role="alert"><strong>Needs attention</strong><ul class="eco-problems">${agent.problems.map(item => `<li>${esc(item.file)}: ${esc(item.message)}</li>`).join('')}</ul></div>` : '';
      const caps = provider?.capabilities;
      const capLine = caps ? `<span class="af-help">${caps.local ? 'Runs on this computer.' : 'Prompts are sent to this online service.'} Tools: ${caps.tools === true ? 'supported' : caps.tools === 'model' ? 'depends on the model' : provider.supportsTools ? 'enabled for this endpoint' : 'not enabled'}. Streaming: yes.</span>` : '<span class="af-help eco-error">This provider no longer exists. Choose another one.</span>';
      const skills = getSkills();
      const skillRows = skills.length ? skills.map(skill => `<label class="eco-check"><input type="checkbox" name="skill" value="${esc(skill.id)}"${settings.skills.includes(skill.id) ? ' checked' : ''}>
          <span><strong>${esc(skill.name)}</strong>${skill.enabled ? '' : ' <span class="eco-tag">Disabled</span>'}${skill.valid ? '' : ' <span class="eco-tag warn">Invalid</span>'}<span class="af-help">${esc(skill.description)}</span></span></label>`).join('')
        : '<p class="af-help">No skills yet. Create reusable skills on the Skills page.</p>';
      const others = getAgents().filter(other => other.id !== agent.id);
      const delegateRows = others.length ? others.map(other => `<label class="eco-check"><input type="checkbox" name="delegate" value="${esc(other.id)}"${settings.delegates.includes(other.id) ? ' checked' : ''}><span><strong>${esc(other.name)}</strong>${other.description ? `<span class="af-help">${esc(other.description)}</span>` : '<span class="af-help">Add a description so this agent knows when to ask it.</span>'}</span></label>`).join('') : '<p class="af-help">Create another agent to delegate to.</p>';
      const missingSkills = settings.skills.filter(id => !skills.some(skill => skill.id === id));
      const perms = Object.entries(S.meta.permissions).map(([key, info]) => `<label class="eco-check"><input type="checkbox" name="perm" value="${key}"${settings.permissions[key] ? ' checked' : ''}>
          <span><strong>${esc(info.label)}</strong>${info.risk === 'high' ? ' <span class="eco-tag warn">High impact</span>' : ''}<span class="af-help">${esc(info.help)}</span></span></label>`).join('');
      const folders = settings.folders.length ? `<ul class="af-links">${settings.folders.map((folder, index) => `<li><span title="${esc(folder)}">${esc(folder)}</span><button class="icon-btn sm" type="button" data-eco="remove-folder" data-index="${index}" aria-label="Remove ${esc(folder)}" title="Remove">${ic('x')}</button></li>`).join('')}</ul>` : '<p class="af-help">No folders. File tools stay unavailable until you add one.</p>';
      const num = (name, value, placeholder, min, max) => `<input class="field" type="number" name="${name}" min="${min}" max="${max}" step="1" value="${value ?? ''}" placeholder="${placeholder}">`;
      return `<div class="eco-pane-body"><div class="af-agent-fields eco-overview">${problems}
        <form class="eco-section" data-eco-form="agent-meta"><h3 class="eco-h">Details</h3>
          <label class="af-field"><span class="af-label">Name</span><input class="field" name="name" maxlength="80" value="${esc(agent.name)}" required></label>
          <label class="af-field"><span class="af-label">Description <span class="optional">optional</span></span><input class="field" name="description" maxlength="300" value="${esc(agent.description)}"></label>
          <div class="af-agent-actions"><button class="btn btn-sm btn-ghost" type="submit">Save details</button></div></form>
        <form class="eco-section" data-eco-form="agent-settings">
          <h3 class="eco-h">Provider and model</h3>
          <label class="af-field"><span class="af-label">Provider</span><select class="field af-select" name="connectionId" data-eco-change="agent-provider">${providerOptions(settings.connectionId)}${provider ? '' : `<option value="${esc(settings.connectionId)}" selected>Missing provider</option>`}</select>${capLine}</label>
          <div class="af-field"><span class="af-label">Model</span>${modelField(settings.connectionId, settings.model)}</div>
          <h3 class="eco-h">Skills <button class="link-btn af-link" type="button" data-eco="go-skills">Manage skills</button></h3>
          <p class="af-help">Only descriptions are sent until a skill is relevant to the task; then its instructions load.</p>
          <div class="eco-checks">${skillRows}</div>
          ${missingSkills.length ? `<p class="af-note error">Missing skills will be removed when you save: ${missingSkills.map(esc).join(', ')}</p>` : ''}
          <h3 class="eco-h">Delegation</h3><p class="af-help">Agents this one may hand a sub-task to while it works (up to 3 times per step). The other agent answers with its own instructions, skills and permissions. Needs a model that supports tools.</p>
          <div class="eco-checks">${delegateRows}</div>
          <h3 class="eco-h">Permissions</h3><p class="af-help">Checked at run time. Skills cannot add permissions. New agents start with everything off.</p>
          <div class="eco-checks">${perms}</div>
          <h3 class="eco-h">File access</h3>${folders}<button class="btn btn-sm btn-ghost eco-self-start" type="button" data-eco="add-folder">${ic('plus')}Add folder</button>
          <h3 class="eco-h">Context budget</h3>
          <div class="eco-grid">
            <label class="af-field"><span class="af-label">Max context tokens</span>${num('maxContextTokens', settings.context.maxContextTokens, 'Model limit', 1024, 10000000)}</label>
            <label class="af-field"><span class="af-label">Reserved for reply</span>${num('responseReserveTokens', settings.context.responseReserveTokens, 'Auto', 128, 200000)}</label>
            <label class="af-field"><span class="af-label">Skills per step</span>${num('maxSkills', settings.context.maxSkills, '3', 0, 10)}</label></div>
          <p class="af-help">Leave blank to use the model’s limit. Lower-priority context is trimmed first when the budget is tight.</p>
          <div class="af-agent-actions eco-sticky"><button class="btn btn-sm" type="submit"${S.settingsDirty ? '' : ' disabled'}>Save settings</button>
            <span class="eco-save-state${S.settingsDirty ? ' dirty' : ''}" role="status">${S.settingsDirty ? 'Unsaved changes' : 'All changes saved'}</span></div>
        </form></div></div>`;
    }
    function settingsFrom(agent) {
      return { connectionId: agent.config.provider.connectionId, model: agent.config.provider.model, skills: [...agent.config.skills], delegates: [...(agent.config.delegates || [])], permissions: { ...agent.config.permissions }, folders: [...agent.config.fileAccess.folders], context: { ...agent.config.context } };
    }
    async function openAgent(id, { keepTab = false } = {}) {
      if (!await confirmDiscard()) return;
      S.mode = 'agents'; S.agentSel = id; S.newFile = false;
      const agent = await guard(() => api.agent(id));
      S.agent = agent; S.settings = settingsFrom(agent); S.settingsDirty = false;
      if (!keepTab) S.tab = 'overview';
      if (!S.file || !agent.tree.some(item => item.path === S.file)) S.file = 'instructions.md';
      S.saved = agent.files[S.file] ?? await guard(() => api.readAgentFile(id, S.file)); S.draft = S.saved;
      paint();
      if (!S.models[S.settings.connectionId]) loadModels(S.settings.connectionId);
    }
    async function loadModels(connectionId) {
      if (!connectionId || !providerById(connectionId)) return;
      S.models[connectionId] = { loading: true, models: [] }; paintKeepingForm();
      try {
        const result = await api.providerModels(connectionId);
        S.models[connectionId] = { loading: false, models: result.models, error: result.available ? null : result.error };
      } catch (error) { S.models[connectionId] = { loading: false, models: [], error: error.message }; }
      paintKeepingForm();
    }
    /* Repaint without losing what is typed into the overview form. */
    function paintKeepingForm() {
      if (!connected()) return;
      const form = q('[data-eco-form="agent-settings"]'); if (form) captureSettings(form);
      const fresh = q('[data-eco-form="new-agent"]'); const draft = fresh ? Object.fromEntries(new FormData(fresh)) : null;
      paint();
      const next = q('[data-eco-form="new-agent"]');
      if (draft && next) for (const [name, value] of Object.entries(draft)) if (next.elements[name]) next.elements[name].value = value;
    }
    function captureSettings(form) {
      const fields = form.elements; const settings = S.settings;
      settings.connectionId = fields.connectionId.value; settings.model = fields.model.value.trim();
      settings.skills = [...form.querySelectorAll('input[name="skill"]:checked')].map(input => input.value);
      settings.delegates = [...form.querySelectorAll('input[name="delegate"]:checked')].map(input => input.value);
      for (const input of form.querySelectorAll('input[name="perm"]')) settings.permissions[input.value] = input.checked;
      const int = name => (fields[name].value.trim() === '' ? null : Number(fields[name].value));
      settings.context = { maxContextTokens: int('maxContextTokens'), responseReserveTokens: int('responseReserveTokens'), maxSkills: int('maxSkills') ?? 3 };
    }
    async function saveSettings(form) {
      captureSettings(form);
      const settings = S.settings; const known = new Set(getSkills().map(skill => skill.id));
      if (!settings.model) { form.elements.model.focus(); H.toast('Choose or type a model name.', { error: true }); return; }
      const patch = { provider: { connectionId: settings.connectionId, model: settings.model }, skills: settings.skills.filter(id => known.has(id)), delegates: settings.delegates.filter(id => getAgents().some(other => other.id === id && id !== S.agent.id)), permissions: settings.permissions, fileAccess: { folders: settings.folders }, context: settings.context };
      const agent = await guard(() => api.updateAgentConfig(S.agent.id, patch)).catch(() => null);
      if (!agent) return;
      S.agent = agent; S.settings = settingsFrom(agent); S.settingsDirty = false;
      if (S.file === 'configuration.json') { S.saved = agent.files['configuration.json']; S.draft = S.saved; }
      await refreshAgents(); await refreshSkills(); paint(); H.toast('Agent settings saved.');
    }
    async function saveAgentFile() {
      const content = S.draft;
      const agent = await guard(() => api.writeAgentFile(S.agent.id, S.file, content)).catch(() => null);
      if (!agent) return;
      S.agent = agent; S.saved = content; S.settings = settingsFrom(agent); S.settingsDirty = false;
      await refreshAgents(); paint(); H.toast(`${S.file} saved.`);
    }

    // ───────────────────────── providers (LLM APIs)
    function providersHtml() {
      const rows = S.providers.map(item => `<li><button class="eco-provider${item.id === S.providerSel ? ' active' : ''}" type="button" data-eco="open-provider" data-id="${esc(item.id)}">
          <span><strong>${esc(item.label)}</strong><span class="af-help">${esc(S.meta.providerTypes[item.type].label)}${item.builtIn ? ' · built in' : item.hasKey ? ' · key saved' : ''}${item.usedBy.length ? ` · used by ${esc(item.usedBy.join(', '))}` : ''}</span></span></button></li>`).join('');
      const selected = S.providerSel === 'new' ? null : providerById(S.providerSel);
      let form = '';
      if (S.providerSel === 'new' || (selected && !selected.builtIn)) {
        const type = selected ? selected.type : S.providerType; const info = S.meta.providerTypes[type];
        const types = Object.entries(S.meta.providerTypes).filter(([key]) => key !== 'ollama').map(([key, value]) => `<option value="${key}"${key === type ? ' selected' : ''}>${esc(value.label)}</option>`).join('');
        const test = S.providerTest ? `<p class="af-note${S.providerTest.ok ? '' : ' error'}" role="status">${esc(S.providerTest.message)}</p>` : '';
        const models = S.providerTest?.models?.length ? `<datalist id="eco-provider-models">${S.providerTest.models.map(model => `<option value="${esc(model)}"></option>`).join('')}</datalist>` : '';
        form = `<form class="eco-section" data-eco-form="provider" data-id="${esc(selected ? selected.id : '')}"><h3 class="eco-h">${selected ? `Edit ${esc(selected.label)}` : 'Add LLM API'}</h3>
          <label class="af-field"><span class="af-label">Provider</span><select class="field af-select" name="type" data-eco-change="provider-type"${selected ? ' disabled' : ''}>${types}</select></label>
          <label class="af-field"><span class="af-label">Name</span><input class="field" name="label" maxlength="60" value="${esc(selected ? selected.label : info.label)}"></label>
          ${type === 'openai-compatible' ? `<label class="af-field"><span class="af-label">Base URL</span><input class="field" name="baseUrl" value="${esc(selected ? selected.baseUrl : '')}" placeholder="http://localhost:1234/v1" required><span class="af-help">https:// for remote servers; http:// only for localhost.</span></label>` : `<p class="af-help">Endpoint: ${esc(info.fixedBase)}</p>`}
          <label class="af-field"><span class="af-label">API key${info.needsKey ? '' : ' <span class="optional">optional</span>'}</span><input class="field" type="password" name="apiKey" autocomplete="off" spellcheck="false" placeholder="${selected && selected.hasKey ? 'Saved — leave blank to keep it' : 'Paste the key'}">
            <span class="af-help">Encrypted with your system’s credential protection. It is never shown again, exported or logged.</span>
            ${selected && selected.hasKey && !info.needsKey ? '<label class="eco-inline"><input type="checkbox" name="clearKey"> Remove the saved key</label>' : ''}</label>
          <label class="af-field"><span class="af-label">Default model <span class="optional">optional</span></span><input class="field" name="model" list="eco-provider-models" value="${esc(selected ? selected.model : '')}" placeholder="Type a model name or test to list models">${models}</label>
          <label class="af-field"><span class="af-label">Context window <span class="optional">optional</span></span><input class="field" type="number" name="contextWindow" min="512" step="1" value="${selected && selected.contextWindow ? selected.contextWindow : ''}" placeholder="Use the provider-reported limit"></label>
          ${type === 'openai-compatible' ? `<label class="eco-inline"><input type="checkbox" name="supportsTools"${selected && selected.supportsTools ? ' checked' : ''}> This endpoint supports tool (function) calls</label>` : ''}
          ${test}
          <div class="af-agent-actions"><button class="btn btn-sm btn-ghost" type="button" data-eco="test-provider"${S.testing ? ' disabled' : ''}>${S.testing ? 'Testing…' : 'Test connection'}</button>
            <button class="btn btn-sm" type="submit">${selected ? 'Save' : 'Add provider'}</button>
            ${selected ? `<button class="btn btn-sm btn-ghost" type="button" data-eco="remove-provider" data-id="${esc(selected.id)}">${ic('trash')}Remove</button>` : ''}</div></form>`;
      } else if (selected && selected.builtIn) {
        const test = S.providerTest ? `<p class="af-note${S.providerTest.ok ? '' : ' error'}" role="status">${esc(S.providerTest.message)}</p>` : '';
        form = `<div class="eco-section"><h3 class="eco-h">${esc(selected.label)}</h3><p class="af-help">Built in. Runs models installed in Ollama on this computer (${esc(selected.baseUrl)}). No key needed.</p>${test}
          <div class="af-agent-actions"><button class="btn btn-sm btn-ghost" type="button" data-eco="test-provider"${S.testing ? ' disabled' : ''}>${S.testing ? 'Testing…' : 'Test connection'}</button></div></div>`;
      }
      return `<div class="chat-pane eco-pane"><div class="chat-head"><span class="chat-title">LLM APIs</span><button class="btn btn-sm" type="button" data-eco="new-provider">${ic('plus')}Add LLM API</button></div>
        <div class="eco-pane-body"><div class="af-agent-fields"><p class="af-help">Connections agents can use. Choose a provider and model for each agent in its Overview.</p>
        <ul class="eco-provider-list">${rows}</ul>${form}</div></div></div>`;
    }
    function providerPayload(form) {
      const fields = form.elements; const id = form.dataset.id || undefined;
      const payload = { id, label: fields.label.value, model: fields.model.value.trim(), contextWindow: fields.contextWindow.value.trim() === '' ? null : Number(fields.contextWindow.value) };
      if (!id) payload.type = fields.type.value;
      if (fields.baseUrl) payload.baseUrl = fields.baseUrl.value.trim();
      if (fields.supportsTools) payload.supportsTools = fields.supportsTools.checked;
      if (fields.apiKey.value.trim()) payload.apiKey = fields.apiKey.value.trim();
      else if (fields.clearKey && fields.clearKey.checked) payload.apiKey = '';
      return payload;
    }
    async function testProvider() {
      const form = q('[data-eco-form="provider"]');
      const draft = form ? providerPayload(form) : { id: S.providerSel };
      S.testing = true; S.providerTest = null; paintProviders(form);
      try { S.providerTest = await api.testProvider(draft); } catch (error) { S.providerTest = { ok: false, message: error.message }; }
      S.testing = false; paintProviders(form);
    }
    /* Repaint the provider form, keeping typed values (the key field included, so a test can be followed by Save). */
    function paintProviders(form) {
      const values = form ? [...form.elements].filter(el => el.name).map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value]) : null;
      paint();
      const next = q('[data-eco-form="provider"]');
      if (values && next) for (const [name, value] of values) { const el = next.elements[name]; if (!el) continue; if (el.type === 'checkbox') el.checked = value; else el.value = value; }
    }
    async function saveProvider(form) {
      const saved = await guard(() => api.saveProvider(providerPayload(form))).catch(() => null);
      if (!saved) return;
      S.providers = await api.providers(); S.providerSel = saved.id; S.providerTest = null; delete S.models[saved.id];
      paint(); H.toast('Provider saved.');
    }

    // ───────────────────────── skills page
    function skillsHtml() {
      const skills = getSkills();
      const list = skills.length ? skills.map(skill => `<button class="chat-item${skill.id === S.skillSel ? ' active' : ''}" type="button" data-eco="open-skill" data-id="${esc(skill.id)}" aria-current="${skill.id === S.skillSel}">
          <span class="chat-item-title">${esc(skill.name)}${skill.valid ? '' : ' <span class="eco-dot" title="Invalid" aria-label="Invalid"></span>'}</span>
          <span class="chat-item-meta">${skill.enabled ? 'Enabled' : 'Disabled'} · ${skill.usedBy.length ? `used by ${plural(skill.usedBy.length, 'agent')}` : 'not assigned'}</span></button>`).join('')
        : '<p class="empty">No skills yet.</p>';
      let pane;
      if (S.skillSel === 'new') pane = `<form class="chat-pane af-agent-form" data-eco-form="new-skill"><div class="chat-head"><span class="chat-title">New skill</span></div><div class="af-agent-fields">
          <label class="af-field"><span class="af-label">Name</span><input class="field" name="name" maxlength="80" placeholder="e.g. Article summary" required data-autofocus></label>
          <label class="af-field"><span class="af-label">When to use it</span><textarea class="field field-area" name="description" rows="3" maxlength="500" required placeholder="Summarize news articles into three bullet points"></textarea>
            <span class="af-help">Agents see this description first and load the full instructions only when a task matches it.</span></label>
          <div class="af-agent-actions"><button class="btn btn-sm" type="submit">Create skill</button><button class="btn btn-sm btn-ghost" type="button" data-eco="cancel-new-skill">Cancel</button></div></div></form>`;
      else if (S.skill) pane = skillHtml();
      else pane = `<div class="chat-pane"><div class="chat-empty">${ic('skill', 'width="28" height="28"')}<h2 class="section-title">${skills.length ? 'Choose a skill' : 'Create your first skill'}</h2>
          <p>Skills are reusable instruction packages (SKILL.md, references, scripts) that you can assign to several agents.</p>
          <button class="btn" type="button" data-eco="new-skill">${ic('plus')}New skill</button></div></div>`;
      return `<header class="page-head"><div><h1 tabindex="-1">Skills</h1><p class="subtitle">Reusable capabilities you can share between agents.</p></div>
          <div class="eco-head-actions"><button class="btn btn-ghost" type="button" data-eco="import-skill">${ic('upload')}Import</button><button class="btn" type="button" data-eco="new-skill">${ic('plus')}New skill</button></div></header>
        <div class="chat-layout"><aside class="chat-list" aria-label="Skills">${list}</aside>${pane}</div>`;
    }
    function skillHtml() {
      const skill = S.skill; const agents = getAgents();
      const runners = agents.filter(agent => skill.usedBy.some(user => user.id === agent.id));
      const scripts = skill.scripts.length ? `<form class="eco-section" data-eco-form="run-script"><h3 class="eco-h">Run a script</h3>
          <p class="af-help">Runs on this computer as one of the agents using this skill. The agent needs “Run skill scripts” and “Code execution”, and you approve each run.</p>
          <div class="eco-grid"><label class="af-field"><span class="af-label">Script</span><select class="field af-select" name="script">${skill.scripts.map(script => `<option value="${esc(script)}">${esc(script)}</option>`).join('')}</select></label>
          <label class="af-field"><span class="af-label">As agent</span><select class="field af-select" name="agentId" required>${runners.length ? runners.map(agent => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join('') : '<option value="">Assign this skill to an agent first</option>'}</select></label></div>
          <label class="af-field"><span class="af-label">Input <span class="optional">optional</span></span><textarea class="field field-area af-mono" name="input" rows="2"></textarea></label>
          <div class="af-agent-actions"><button class="btn btn-sm" type="submit"${runners.length && !S.running ? '' : ' disabled'}>${S.running ? 'Running…' : 'Run script'}</button></div>
          ${S.scriptOut ? `<pre class="af-json eco-output${S.scriptOut.ok ? '' : ' error'}">${esc(S.scriptOut.output || '(no output)')}</pre>` : ''}</form>` : '';
      return `<div class="chat-pane eco-pane"><div class="chat-head"><span class="chat-title">${esc(skill.name)}</span>
          <button class="toggle-pill eco-switch${skill.enabled ? ' active' : ''}" type="button" data-eco="toggle-skill" aria-pressed="${skill.enabled}">${skill.enabled ? 'Enabled' : 'Disabled'}</button>
          <button class="icon-btn" type="button" data-eco="duplicate-skill" aria-label="Duplicate skill" title="Duplicate">${ic('duplicate')}</button>
          <button class="icon-btn" type="button" data-eco="export-skill" aria-label="Export skill" title="Export to a folder">${ic('save')}</button>
          <button class="icon-btn" type="button" data-eco="delete-skill" aria-label="Delete skill" title="Delete">${ic('trash')}</button></div>
        <div class="eco-pane-body"><div class="eco-skill-meta">
          ${skill.problems.length ? `<div class="af-note error" role="alert"><strong>SKILL.md needs attention</strong><ul class="eco-problems">${skill.problems.map(problem => `<li>${esc(problem)}</li>`).join('')}</ul></div>` : ''}
          ${(skill.warnings || []).length ? `<div class="af-note" role="status"><strong>Check these links</strong><ul class="eco-problems">${skill.warnings.map(warning => `<li>${esc(warning)}</li>`).join('')}</ul></div>` : ''}
          <p class="af-help">${esc(skill.description)}</p>
          ${skill.outcome ? `<p class="af-help">Intended outcome: ${esc(skill.outcome)}</p>` : ''}
          <p class="af-help">Activation: <strong>${skill.activation === 'always' ? 'always loaded' : 'when relevant'}</strong>${skill.triggers.length ? ` · triggers: ${esc(skill.triggers.join(', '))}` : ''} · ${plural(skill.references.length, 'reference')} · ${plural(skill.scripts.length, 'script')}</p>
          <p class="af-help">Used by: ${skill.usedBy.length ? skill.usedBy.map(user => `<button class="link-btn af-link eco-chip" type="button" data-eco="go-agent" data-id="${esc(user.id)}">${esc(user.name)}</button>`).join(' ') : 'no agents yet (assign it in an agent’s Overview)'}</p></div>
          ${filesHtml(skill.tree, { scope: 'skill', selected: S.skillFile, draft: S.skillDraft, dirty: skillDirty(), deletable: rel => rel !== 'SKILL.md', newFolders: ['references', 'scripts', 'resources'], newOpen: S.skillNewFile, help: S.skillFile === 'SKILL.md' ? 'Front matter: name, description, enabled (true/false), activation (auto/always), triggers (comma-separated keywords), outcome (what a correct result looks like).' : S.skillFile && S.skillFile.startsWith('scripts/') ? 'Scripts never run automatically. .js and .py are supported.' : '' })}
          ${scripts}</div></div>`;
    }
    async function openSkill(id) {
      if (!await confirmDiscard()) return;
      S.skillSel = id; S.scriptOut = null; S.skillNewFile = false;
      S.skill = await guard(() => api.skill(id));
      if (!S.skillFile || !S.skill.tree.some(item => item.path === S.skillFile)) S.skillFile = 'SKILL.md';
      S.skillSaved = await guard(() => api.readSkillFile(id, S.skillFile)); S.skillDraft = S.skillSaved;
      paint();
    }

    // ───────────────────────── painting and events
    function paint() {
      if (!connected()) return;
      const scroll = q('.eco-pane-body')?.scrollTop || 0;
      root.innerHTML = kind === 'skills' ? skillsHtml() : agentsHtml();
      const body = q('.eco-pane-body'); if (body) body.scrollTop = scroll;
      const focus = q('[data-autofocus]'); if (focus) focus.focus();
    }
    async function onClick(button) {
      const action = button.dataset.eco; const id = button.dataset.id; const scope = button.dataset.scope;
      switch (action) {
        case 'new-agent': if (await confirmDiscard()) { S.mode = 'agents'; S.agentSel = 'new'; S.agent = null; paint(); if (!S.models['ollama-local']) loadModels('ollama-local'); } break;
        case 'cancel-new': S.agentSel = null; paint(); break;
        case 'open-agent': await openAgent(id).catch(() => {}); break;
        case 'agent-tab': { const form = q('[data-eco-form="agent-settings"]'); if (form) captureSettings(form); S.tab = button.dataset.value; paint(); break; }
        case 'providers': if (await confirmDiscard()) { S.mode = S.mode === 'providers' ? 'agents' : 'providers'; S.providerSel = S.providerSel || 'ollama-local'; S.providerTest = null; S.providers = await api.providers(); paint(); } break;
        case 'new-provider': S.providerSel = 'new'; S.providerTest = null; paint(); break;
        case 'open-provider': S.providerSel = id; S.providerTest = null; paint(); break;
        case 'test-provider': await testProvider(); break;
        case 'remove-provider': {
          const item = providerById(id);
          if (!item || !await H.confirmDialog({ title: 'Remove this provider?', text: `“${item.label}” and its saved key will be removed.` })) break;
          await guard(() => api.removeProvider(id)).then(async () => { S.providers = await api.providers(); S.providerSel = null; paint(); H.toast('Provider removed.'); }).catch(() => {});
          break;
        }
        case 'load-models': await loadModels(id); break;
        case 'retry-ollama': button.disabled = true; await refreshOllama(); delete S.models['ollama-local']; loadModels('ollama-local'); break;
        case 'duplicate-agent': { const copy = await guard(() => api.duplicateAgent(S.agent.id)).catch(() => null); if (copy) { await refreshAgents(); await openAgent(copy.id); H.toast('Agent duplicated.'); } break; }
        case 'export-agent': { const done = await guard(() => api.exportAgent(S.agent.id)).catch(() => null); if (done) H.toast(`Exported to ${done.folder}. API keys are never included.`); break; }
        case 'import-agent': {
          const result = await guard(() => api.importAgent()).catch(() => null);
          if (result) { await refreshAgents(); await openAgent(result.agent.id); H.toast(['Agent imported.', ...result.notes].join(' ')); }
          break;
        }
        case 'delete-agent': {
          const agent = S.agent;
          if (!await H.confirmDialog({ title: 'Delete this agent?', text: `“${agent.name}” will be removed. Its files are kept in the app’s trash folder. Workflow blocks that use it will need another agent.` })) break;
          await guard(() => api.deleteAgent(agent.id)).catch(() => null);
          S.agent = null; S.agentSel = null; S.draft = null; S.saved = null; S.settingsDirty = false; await refreshAgents(); await refreshSkills(); paint(); H.toast('Agent deleted.');
          break;
        }
        case 'add-folder': { const form = q('[data-eco-form="agent-settings"]'); if (form) captureSettings(form); const folder = await guard(() => api.pickFolder()).catch(() => null); if (folder && !S.settings.folders.includes(folder)) { S.settings.folders.push(folder); S.settingsDirty = true; } paint(); break; }
        case 'remove-folder': { const form = q('[data-eco-form="agent-settings"]'); if (form) captureSettings(form); S.settings.folders.splice(Number(button.dataset.index), 1); S.settingsDirty = true; paint(); break; }
        case 'go-skills': if (await confirmDiscard()) H.go('skills'); break;
        case 'go-agent': if (await confirmDiscard()) { S.agentSel = id; S.mode = 'agents'; H.go('agents'); } break;
        case 'open-file': {
          const dirty = scope === 'agent' ? fileDirty() : skillDirty();
          if (dirty && !await H.confirmDialog({ title: 'Discard unsaved changes?', text: 'Your edits to this file have not been saved.' })) break;
          if (scope === 'agent') { S.file = button.dataset.path; S.saved = await guard(() => api.readAgentFile(S.agent.id, S.file)).catch(() => ''); S.draft = S.saved; }
          else { S.skillFile = button.dataset.path; S.skillSaved = await guard(() => api.readSkillFile(S.skill.id, S.skillFile)).catch(() => ''); S.skillDraft = S.skillSaved; }
          paint(); break;
        }
        case 'save-file': if (scope === 'agent') await saveAgentFile(); else await saveSkillFile(); break;
        case 'revert-file': if (scope === 'agent') S.draft = S.saved; else S.skillDraft = S.skillSaved; paint(); break;
        case 'new-file': if (scope === 'agent') S.newFile = true; else S.skillNewFile = true; paint(); break;
        case 'cancel-new-file': if (scope === 'agent') S.newFile = false; else S.skillNewFile = false; paint(); break;
        case 'delete-file': {
          const rel = scope === 'agent' ? S.file : S.skillFile;
          if (!await H.confirmDialog({ title: 'Delete this file?', text: `${rel} will be removed. A copy is kept in the package history.` })) break;
          if (scope === 'agent') { const agent = await guard(() => api.deleteAgentFile(S.agent.id, rel)).catch(() => null); if (agent) { S.agent = agent; S.file = 'instructions.md'; S.saved = agent.files['instructions.md']; S.draft = S.saved; } }
          else { const skill = await guard(() => api.deleteSkillFile(S.skill.id, rel)).catch(() => null); if (skill) { S.skill = skill; S.skillFile = 'SKILL.md'; S.skillSaved = await api.readSkillFile(skill.id, 'SKILL.md'); S.skillDraft = S.skillSaved; } }
          paint(); break;
        }
        case 'new-skill': if (await confirmDiscard()) { S.skillSel = 'new'; S.skill = null; paint(); } break;
        case 'cancel-new-skill': S.skillSel = null; paint(); break;
        case 'open-skill': await openSkill(id).catch(() => {}); break;
        case 'toggle-skill': { const skill = await guard(() => api.setSkillEnabled(S.skill.id, !S.skill.enabled)).catch(() => null); if (skill) { S.skill = skill; if (S.skillFile === 'SKILL.md') { S.skillSaved = await api.readSkillFile(skill.id, 'SKILL.md'); S.skillDraft = S.skillSaved; } await refreshSkills(); paint(); H.toast(skill.enabled ? 'Skill enabled.' : 'Skill disabled. Agents will not load it.'); } break; }
        case 'duplicate-skill': { const copy = await guard(() => api.duplicateSkill(S.skill.id)).catch(() => null); if (copy) { await refreshSkills(); await openSkill(copy.id); H.toast('Skill duplicated.'); } break; }
        case 'export-skill': { const done = await guard(() => api.exportSkill(S.skill.id)).catch(() => null); if (done) H.toast(`Exported to ${done.folder}.`); break; }
        case 'import-skill': { const result = await guard(() => api.importSkill()).catch(() => null); if (result) { await refreshSkills(); await openSkill(result.skill.id); H.toast(result.skipped.length ? `Skill imported. Skipped ${plural(result.skipped.length, 'file')} that skills cannot contain.` : 'Skill imported.'); } break; }
        case 'delete-skill': {
          const skill = S.skill;
          if (!await H.confirmDialog({ title: 'Delete this skill?', text: skill.usedBy.length ? `“${skill.name}” is used by ${skill.usedBy.map(user => user.name).join(', ')}. It will be unassigned from them. Its files are kept in the app’s trash folder.` : `“${skill.name}” will be removed. Its files are kept in the app’s trash folder.` })) break;
          await guard(() => api.deleteSkill(skill.id)).catch(() => null);
          S.skill = null; S.skillSel = null; S.skillDraft = null; S.skillSaved = null; await refreshSkills(); await refreshAgents(); paint(); H.toast('Skill deleted.');
          break;
        }
        default: break;
      }
    }
    async function saveSkillFile() {
      const content = S.skillDraft;
      const skill = await guard(() => api.writeSkillFile(S.skill.id, S.skillFile, content)).catch(() => null);
      if (!skill) return;
      S.skill = skill; S.skillSaved = content; await refreshSkills(); paint(); H.toast(`${S.skillFile} saved.`);
    }
    async function onSubmit(form) {
      const type = form.dataset.ecoForm; const fields = form.elements;
      if (type === 'new-agent') {
        const payload = { name: fields.name.value, description: fields.description.value, connectionId: fields.connectionId.value, model: fields.model.value.trim() };
        if (!payload.model) { fields.model.focus(); H.toast('Choose or type a model name.', { error: true }); return; }
        const agent = await guard(() => api.saveAgent(payload)).catch(() => null);
        if (agent) { await refreshAgents(); await openAgent(agent.id); H.toast('Agent created.'); }
      } else if (type === 'agent-meta') {
        const agent = await guard(() => api.saveAgent({ id: S.agent.id, name: fields.name.value, description: fields.description.value })).catch(() => null);
        if (agent) { S.agent = { ...agent }; S.settings = settingsFrom(agent); S.settingsDirty = false; await refreshAgents(); paint(); H.toast('Details saved.'); }
      } else if (type === 'agent-settings') await saveSettings(form);
      else if (type === 'provider') await saveProvider(form);
      else if (type === 'agent-new-file' || type === 'skill-new-file') {
        const rel = `${fields.folder.value}/${fields.name.value.trim()}`;
        if (type === 'agent-new-file') {
          const agent = await guard(() => api.writeAgentFile(S.agent.id, rel, '')).catch(() => null);
          if (agent) { S.agent = agent; S.newFile = false; S.file = rel; S.saved = ''; S.draft = ''; paint(); }
        } else {
          const skill = await guard(() => api.writeSkillFile(S.skill.id, rel, '')).catch(() => null);
          if (skill) { S.skill = skill; S.skillNewFile = false; S.skillFile = rel; S.skillSaved = ''; S.skillDraft = ''; await refreshSkills(); paint(); }
        }
      } else if (type === 'new-skill') {
        const skill = await guard(() => api.createSkill({ name: fields.name.value, description: fields.description.value })).catch(() => null);
        if (skill) { await refreshSkills(); await openSkill(skill.id); H.toast('Skill created. Write its instructions in SKILL.md.'); }
      } else if (type === 'run-script') {
        if (!fields.agentId.value) return;
        S.running = true; S.scriptOut = null; paint();
        try { S.scriptOut = await api.runSkillScript({ agentId: fields.agentId.value, skillId: S.skill.id, script: fields.script.value, input: fields.input.value }); }
        catch (error) { S.scriptOut = { ok: false, output: error.message }; }
        S.running = false; paint();
      }
    }
    function onInput(event) {
      const target = event.target;
      if (target.dataset.ecoInput === 'agent-file') { const wasDirty = fileDirty(); S.draft = target.value; if (wasDirty !== fileDirty()) updateFileState(); return; }
      if (target.dataset.ecoInput === 'skill-file') { const wasDirty = skillDirty(); S.skillDraft = target.value; if (wasDirty !== skillDirty()) updateFileState(); return; }
      if (target.closest('[data-eco-form="agent-settings"]') && !S.settingsDirty) { S.settingsDirty = true; const save = q('[data-eco-form="agent-settings"] [type=submit]'); if (save) save.disabled = false; const state = q('[data-eco-form="agent-settings"] .eco-save-state'); if (state) { state.textContent = 'Unsaved changes'; state.classList.add('dirty'); } }
    }
    function updateFileState() {
      const dirty = kind === 'skills' ? skillDirty() : fileDirty();
      const state = q('.eco-editor .eco-save-state'); if (state) { state.textContent = dirty ? 'Unsaved changes' : 'Saved'; state.classList.toggle('dirty', dirty); }
      for (const selector of ['[data-eco="save-file"]', '[data-eco="revert-file"]']) { const button = q(`.eco-editor ${selector}`); if (button) button.disabled = !dirty; }
    }
    function onChange(event) {
      const change = event.target.dataset.ecoChange;
      if (change === 'agent-provider') { S.settingsDirty = true; const form = q('[data-eco-form="agent-settings"]'); captureSettings(form); paint(); if (!S.models[S.settings.connectionId]) loadModels(S.settings.connectionId); }
      else if (change === 'new-provider') { S.newConnection = event.target.value; paintKeepingForm(); if (!S.models[S.newConnection]) loadModels(S.newConnection); }
      else if (change === 'provider-type') { S.providerType = event.target.value; S.providerTest = null; paint(); }
      else if (event.target.closest('[data-eco-form="agent-settings"]')) onInput(event);
    }
    function bind() {
      root.addEventListener('click', event => { const button = event.target.closest('[data-eco]'); if (button && !button.disabled) onClick(button, event); });
      root.addEventListener('submit', event => { const form = event.target.closest('[data-eco-form]'); if (!form) return; event.preventDefault(); onSubmit(form); });
      root.addEventListener('input', onInput);
      root.addEventListener('change', onChange);
      root.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && event.target.dataset.ecoInput) { event.preventDefault(); if (event.target.dataset.ecoInput === 'agent-file' && fileDirty()) saveAgentFile(); if (event.target.dataset.ecoInput === 'skill-file' && skillDirty()) saveSkillFile(); }
      });
    }
    function mount(stage, which) {
      root = stage.querySelector('[data-eco-root]'); kind = which;
      if (!root) return;
      bind();
      const show = async () => {
        if (kind === 'agents' && S.agentSel && S.agentSel !== 'new' && (!S.agent || S.agent.id !== S.agentSel)) { S.draft = null; S.saved = null; await openAgent(S.agentSel, { keepTab: true }).catch(() => paint()); return; }
        if (kind === 'skills' && S.skillSel && S.skillSel !== 'new' && (!S.skill || S.skill.id !== S.skillSel)) { S.skillDraft = null; S.skillSaved = null; await openSkill(S.skillSel).catch(() => paint()); return; }
        paint();
      };
      if (kind === 'agents') refreshOllama();
      loadShared().then(show).catch(error => { if (connected()) root.innerHTML = `<div class="chat-empty af-blank"><p>${esc(error.message || 'This page could not be loaded.')}</p></div>`; });
    }
    return {
      views: {
        agents: { render: () => '<div class="af-page" data-eco-root="agents"><div class="chat-empty af-blank"><span class="spinner" aria-hidden="true"></span><p>Loading…</p></div></div>', mount: stage => mount(stage, 'agents') },
        skills: { render: () => '<div class="af-page" data-eco-root="skills"><div class="chat-empty af-blank"><span class="spinner" aria-hidden="true"></span><p>Loading…</p></div></div>', mount: stage => mount(stage, 'skills') }
      },
      openAgent: id => { S.agentSel = id; S.mode = 'agents'; S.agent = null; },
      openSkill: id => { S.skillSel = id; S.skill = null; },
      hasUnsaved: () => fileDirty() || skillDirty() || S.settingsDirty,
      // Drops edits after the person confirmed leaving; the next visit reloads saved values.
      discard: () => { S.draft = S.saved; S.skillDraft = S.skillSaved; if (S.settingsDirty) { S.settingsDirty = false; S.agent = null; } },
      reset: () => { Object.assign(S, { meta: null, providers: [], loaded: false, mode: 'agents', agentSel: null, agent: null, settings: null, settingsDirty: false, models: {}, file: null, draft: null, saved: null, skillSel: null, skill: null, skillFile: null, skillDraft: null, skillSaved: null, scriptOut: null }); }
    };
  }
  window.PerflwEcosystemUI = { create: createEcosystemUI };
})();

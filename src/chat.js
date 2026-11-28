'use strict';
/* Chat sessions — the conversation pane: messages with rich rendering, live progress while a turn runs,
   and the per-conversation controls (model, workflow, skills, session settings).
   Mounted by renderer.js through window.PerflwChat. All execution happens in the main process
   (automation/chat.js); this file shows its state and sends the person's choices back. */
(function () {
  const R = window.PerflwRender;
  const AG = window.PerflwAgentUI; // Thinking block, task checklist, task bar (shared with the study chat)
  const api = window.chatData || null;
  const auto = window.automationData || null;
  let H = null; // helpers from renderer.js: esc, icon, toast, confirmDialog, go, stamp, state(), repaintLists()

  const fresh = () => ({
    sessions: new Map(),   // chatId → what the session points at (from the main process)
    resources: null,       // providers, agents, workflows, skills, memory, commands
    live: new Map(),       // chatId → progress of the turn that is running
    rendered: new Map(),   // messageId → { html, blocks }
    models: new Map(),     // providerId → { loading, models, error }
    pop: null, popProvider: null, query: '', suggest: null, saveTimers: new Map()
  });
  let C = fresh();

  const esc = value => R.esc(value);
  const ICON = {
    check: '<polyline points="4.5,10.5 8.5,14.5 15.5,6"/>', alert: '<path d="M10 3.5 17.5 16h-15z"/><path d="M10 8.5v3.5M10 14.2v.3"/>',
    down: '<polyline points="5.5,8 10,12.5 14.5,8"/>', stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.8" fill="currentColor" stroke="none"/>',
    model: '<rect x="4" y="4" width="12" height="12" rx="2.5"/><path d="M8 8h4v4H8zM10 2v2M10 16v2M2 10h2M16 10h2"/>', minus: '<line x1="5" y1="10" x2="15" y2="10"/>'
  };
  const ic = name => (ICON[name] ? `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>` : H.icon(name));
  const call = async (task, quiet = false) => { try { return await task(); } catch (error) { if (!quiet) H.toast(error.message || 'Something went wrong.', { error: true }); throw error; } };
  const seconds = ms => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
  const count = value => Number(value || 0).toLocaleString('en-US');
  const activeId = () => { const S = H.state(); return S.view === 'chat' ? S.activeChat : null; };
  const messagesOf = chatId => { const S = H.state(); return S.messages[chatId] || (S.messages[chatId] = []); };
  const q = selector => document.querySelector(selector);

  // ───────────────────────── messages
  function stepsHtml(steps, kind) {
    if (!steps || !steps.length) return '';
    return `<ol class="af-steps cs-steps">${steps.map(step => {
      const state = step.status === 'done' ? 'done' : step.status === 'failed' ? 'error' : step.status;
      const mark = step.status === 'running' ? '<span class="af-spin" aria-hidden="true"></span>' : step.status === 'done' ? ic('check') : step.status === 'failed' ? ic('alert') : step.status === 'skipped' || step.status === 'cancelled' ? ic('minus') : '';
      const who = kind === 'workflow' ? [step.agent, step.model].filter(Boolean).join(' · ') : step.owner && step.owner !== 'model' ? step.owner : '';
      const meta = [who, step.status === 'skipped' ? 'skipped' : step.status === 'cancelled' ? 'stopped' : '', step.durationMs ? seconds(step.durationMs) : ''].filter(Boolean).join(' · ');
      return `<li class="af-step is-${esc(state)}"><div class="af-step-line"><span class="af-step-mark">${mark}</span><span class="af-step-name">${esc(kind === 'workflow' ? step.name : step.title)}</span><span class="af-step-meta">${esc(meta)}</span></div>${step.skills && step.skills.length ? `<div class="cs-step-note">Skills: ${esc(step.skills.join(', '))}</div>` : ''}${step.note ? `<div class="cs-step-note">${esc(step.note)}</div>` : ''}${step.preview ? `<button class="af-step-preview" type="button" data-chat="toggle-preview" aria-expanded="false" title="Show more">${esc(step.preview)}</button>` : ''}${step.error ? `<div class="af-step-error">${esc(step.error)}</div>` : ''}</li>`;
    }).join('')}</ol>`;
  }
  const VERIFY = { passed: 'Checked', revised: 'Checked · revised once', issues: 'Checked · gaps remain', unavailable: 'Not checked', off: '' };
  function detailsHtml(meta) {
    const rows = []; const row = (label, value) => { if (value) rows.push(`<div class="cs-row"><span class="cs-key">${esc(label)}</span><div class="cs-val">${value}</div></div>`); };
    if (meta.model) row('Model', `${esc(meta.model)} on ${esc(meta.provider ? meta.provider.label : '')}${meta.agent ? ` · as ${esc(meta.agent.name)}` : ''}`);
    if (meta.workflow) row('Workflow', `${esc(meta.workflow.title)}${meta.workflow.once ? ' (run once for this message)' : ''} · ${esc(meta.workflow.status)}${meta.workflow.durationMs ? ` in ${seconds(meta.workflow.durationMs)}` : ''}${meta.workflow.historyMessages ? ` · ${meta.workflow.historyMessages} earlier message${meta.workflow.historyMessages === 1 ? '' : 's'} passed in` : ''}${stepsHtml(meta.workflow.steps, 'workflow')}`);
    if (meta.plan) row('Plan', stepsHtml(meta.plan.steps, 'plan'));
    if (meta.verification && meta.verification.status !== 'off') row('Result check', `${esc(meta.verification.detail)}${meta.verification.issues && meta.verification.issues.length ? `<ul class="cs-list">${meta.verification.issues.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}`);
    if (meta.skills && meta.skills.length) row('Skills', `<ul class="cs-list">${meta.skills.map(skill => `<li><strong>${esc(skill.name)}</strong> — ${esc(skill.status === 'loaded' ? (skill.source === 'auto' ? 'loaded automatically' : skill.source === 'agent' ? 'loaded from the agent' : 'active in this conversation') : skill.status)}. ${esc(skill.reason || '')}</li>`).join('')}</ul>`);
    if (meta.toolCalls && meta.toolCalls.length) row('Tools', `<ul class="cs-list">${meta.toolCalls.map(item => `<li>${esc(item.tool)} — ${esc(item.outcome)}${item.detail ? `: ${esc(item.detail)}` : ''}</li>`).join('')}</ul>`);
    if (meta.delegations && meta.delegations.length) row('Agents asked', `<ul class="cs-list">${meta.delegations.map(item => `<li>${esc(item.agent)} (${seconds(item.durationMs)}): ${esc(item.task)}</li>`).join('')}</ul>`);
    if (meta.context) {
      const c = meta.context; const h = c.history;
      row('Context', `About ${count(c.estimatedTokens)} of ${count(c.available)} tokens used (estimate); window ${count(c.contextWindow)} (${esc(c.contextSource)}).<br>History: ${h.included} earlier message${h.included === 1 ? '' : 's'} sent${h.omitted ? `, ${h.omitted} older left out` : ''}${h.excerpts ? `, ${h.excerpts} relevant older one${h.excerpts === 1 ? '' : 's'} brought back as excerpts` : ''}.${c.parts.some(part => part.status === 'omitted' || part.status === 'truncated') ? `<br>Shortened or left out to fit: ${esc(c.parts.filter(part => part.status === 'omitted' || part.status === 'truncated').map(part => `${part.section} (${part.status})`).join(', '))}.` : ''}`);
    }
    if (meta.usage) row('Tokens', `${count(meta.usage.inputTokens)} in · ${count(meta.usage.outputTokens)} out${meta.usage.cachedTokens ? ` · ${count(meta.usage.cachedTokens)} cached` : ''} (reported by the provider)`);
    if (meta.durationMs) row('Time', seconds(meta.durationMs));
    if (meta.notes && meta.notes.length) row('Notes', `<ul class="cs-list">${meta.notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul>`);
    return rows.join('');
  }
  function footHtml(message) {
    const meta = message.meta || {}; const tags = [];
    if (meta.mode === 'workflow' && meta.workflow) tags.push(`Workflow: ${meta.workflow.title}`);
    else if (meta.model) tags.push(meta.agent ? `${meta.agent.name} · ${meta.model}` : meta.model);
    for (const skill of (meta.skills || []).filter(item => item.status === 'loaded' || item.status === 'truncated')) tags.push(`Skill: ${skill.name}${skill.source === 'auto' ? ' (auto)' : ''}`);
    if (meta.mode === 'planned') tags.push(`Planned${meta.verification && VERIFY[meta.verification.status] ? ` · ${VERIFY[meta.verification.status].toLowerCase()}` : ''}`);
    if (meta.toolCalls && meta.toolCalls.length) tags.push(`${meta.toolCalls.length} tool call${meta.toolCalls.length === 1 ? '' : 's'}`);
    if (meta.partial) tags.push(meta.cancelled ? 'Stopped early' : 'Incomplete');
    if (meta.truncated) tags.push('Reached the length limit');
    const offers = [];
    for (const skill of meta.suggestedSkills || []) offers.push(`<button class="cs-offer" type="button" data-chat="use-skill" data-id="${esc(skill.id)}" title="${esc(skill.reason || '')}">Use skill: ${esc(skill.name)}</button>`);
    if (meta.suggestedWorkflow) offers.push(`<button class="cs-offer" type="button" data-chat="run-workflow" data-id="${esc(meta.suggestedWorkflow.id)}" title="Answer this message again by running the workflow">Run with workflow: ${esc(meta.suggestedWorkflow.title)}</button>`);
    if (meta.truncated) offers.push('<button class="cs-offer" type="button" data-chat="continue">Continue</button>');
    const details = detailsHtml(meta);
    return `<div class="msg-foot"><span class="msg-tags">${tags.map(tag => `<span class="msg-tag">${esc(tag)}</span>`).join('')}</span><span class="msg-acts"><button class="msg-act" type="button" data-chat="copy-msg" data-id="${esc(message.id)}">Copy</button>${details ? `<button class="msg-act" type="button" data-chat="toggle-details" aria-expanded="false">Details</button>` : ''}</span></div>${offers.length ? `<div class="cs-offers">${offers.join('')}</div>` : ''}${details ? `<div class="cs-details" hidden>${details}</div>` : ''}`;
  }
  function visualsOn(chatId) { const session = C.sessions.get(chatId); return !session || session.settings.prefs.visuals !== false; }
  function bodyOf(message, chatId) {
    const key = `${message.id}:${visualsOn(chatId) ? 1 : 0}`;
    if (!C.rendered.has(key)) C.rendered.set(key, R.markdown(message.content, { visuals: visualsOn(chatId) }));
    return C.rendered.get(key);
  }
  function messageNode(message, chatId) {
    const el = document.createElement('div'); el.dataset.msg = message.id;
    const meta = message.meta || {};
    if (message.role === 'user') {
      el.className = 'msg user';
      el.innerHTML = `${esc(message.content)}<span class="msg-time">${esc(H.stamp(message.createdAt))}</span>`;
    } else if (message.role === 'system') {
      const error = meta.kind === 'error';
      el.className = `msg-note${error ? ' is-error' : ''}${meta.kind === 'command' ? ' is-command' : ''}`;
      if (error) el.setAttribute('role', 'alert');
      const rendered = bodyOf(message, chatId);
      el.innerHTML = `<div class="md">${rendered.html}</div>${meta.workflow ? `<div class="cs-details">${detailsHtml({ workflow: meta.workflow })}</div>` : ''}${error ? `<div class="cs-offers">${meta.retryable ? '<button class="cs-offer" type="button" data-chat="retry">Try again</button>' : ''}${meta.setup ? '<button class="cs-offer" type="button" data-chat="pop" data-pop="model">Choose a model</button>' : ''}</div>` : ''}`;
    } else {
      el.className = 'msg assistant';
      const rendered = bodyOf(message, chatId);
      // A planned or workflow reply keeps its steps behind a folded "Worked for 12s" line.
      const steps = meta.workflow ? meta.workflow.steps : meta.plan ? meta.plan.steps : [];
      const worked = steps && steps.length ? AG.thinking({ running: false, steps, elapsedMs: meta.durationMs || (meta.workflow && meta.workflow.durationMs) || null, failed: Boolean(meta.partial && meta.cancelled) }) : '';
      el.innerHTML = `${worked}<div class="md">${rendered.html}</div>${footHtml(message)}`;
      el.querySelector('.md').__blocks = rendered.blocks;
    }
    return el;
  }
  function hydrateNode(el, latest) {
    const body = el.querySelector('.md');
    if (body && body.__blocks) R.hydrate(body, body.__blocks, { interactive: latest, onOption: text => send(text) });
  }
  const liveSteps = live => (live.workflow ? live.workflow.steps : live.plan || []);
  function liveHtml(live) {
    return `<div role="status">${AG.thinking({ running: true, label: live.status, steps: liveSteps(live), hooks: true })}</div><div class="md" data-live-text></div>`;
  }
  /* Brings the message list in line with state, touching only what changed so running visuals keep their state. */
  function syncMessages({ scroll = 'keep' } = {}) {
    const chatId = activeId(); const box = q('[data-chat-messages]');
    if (!chatId || !box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    const list = messagesOf(chatId); const wanted = new Set(list.map(message => message.id));
    const empty = box.querySelector('.chat-empty'); const live = C.live.get(chatId);
    for (const el of [...box.querySelectorAll(':scope > [data-msg]')]) if (!wanted.has(el.dataset.msg)) el.remove();
    const existing = new Map([...box.querySelectorAll(':scope > [data-msg]')].map(el => [el.dataset.msg, el]));
    let liveEl = box.querySelector(':scope > [data-live]');
    const lastAssistant = [...list].reverse().find(message => message.role !== 'system');
    for (const message of list) {
      if (existing.has(message.id)) continue;
      const el = messageNode(message, chatId);
      if (liveEl) box.insertBefore(el, liveEl); else box.append(el);
      hydrateNode(el, !live && lastAssistant && lastAssistant.id === message.id && message.role === 'assistant');
    }
    // Choices offered in older replies are a record, not a control.
    const lastId = !live && lastAssistant && lastAssistant.role === 'assistant' ? lastAssistant.id : null;
    box.querySelectorAll('.opt-btn').forEach(button => { const owner = button.closest('[data-msg]'); if (!owner || owner.dataset.msg !== lastId) button.disabled = true; });
    if (live) {
      if (!liveEl) { liveEl = document.createElement('div'); liveEl.className = 'msg assistant is-live'; liveEl.dataset.live = '1'; liveEl.innerHTML = liveHtml(live); box.append(liveEl); }
      paintLive(chatId, true);
    } else if (liveEl) liveEl.remove();
    if (!live) { const bar = q('[data-chat-taskbar]'); if (bar && bar.innerHTML) bar.innerHTML = ''; }
    if (empty && (list.length || live)) empty.remove();
    if (!list.length && !live && !box.querySelector('.chat-empty')) box.innerHTML = '<div class="chat-empty"><p>No messages yet. Write the first one below.</p></div>';
    if (scroll === 'bottom' || (scroll === 'keep' && nearBottom)) box.scrollTop = box.scrollHeight;
    paintOutput(chatId);
  }
  let liveFrame = 0;
  function paintLive(chatId, full = false) {
    const live = C.live.get(chatId); const box = q('[data-chat-messages]');
    const el = box && box.querySelector(':scope > [data-live]');
    if (!live || !el || chatId !== activeId()) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    const now = el.querySelector('[data-ag-now]'); if (now && now.textContent !== live.status) now.textContent = live.status;
    if (full || live.stepsDirty || live.outStatus !== live.status) { live.outStatus = live.status; paintOutput(chatId); }
    const steps = liveSteps(live); const think = el.querySelector('.ag-think');
    // A plain reply folds the block away once text arrives (once, so the student may open it again); a plan stays open.
    if (think && live.text && !steps.length && !live.folded) { think.open = false; live.folded = true; }
    if (full || live.stepsDirty) {
      el.querySelector('[data-ag-steps]').innerHTML = AG.checklist(steps); el.querySelector('[data-ag-count]').textContent = AG.progress(steps);
      const bar = q('[data-chat-taskbar]'); if (bar) bar.innerHTML = AG.taskBar(steps);
      live.stepsDirty = false;
    }
    if (full || live.textDirty) { el.querySelector('[data-live-text]').innerHTML = live.text ? R.markdown(live.text, { streaming: true, visuals: visualsOn(chatId) }).html : ''; live.textDirty = false; }
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  const scheduleLive = chatId => { if (liveFrame) return; liveFrame = requestAnimationFrame(() => { liveFrame = 0; paintLive(chatId); }); };

  // ───────────────────────── output panel: what the session runs on and what the last turn did
  function outputHtml(chatId) {
    const session = sessionOf(chatId); const live = C.live.get(chatId);
    const list = messagesOf(chatId);
    const last = [...list].reverse().find(message => message.role === 'assistant');
    const setup = session ? (() => {
      const p = session.provider; const wf = session.workflow;
      const item = (label, value, pop) => `<button class="out-row" type="button" data-chat="pop" data-pop="${pop}"${live ? ' disabled' : ''}><span class="out-key">${esc(label)}</span><span class="out-val">${esc(value)}</span></button>`;
      return `<div class="out-sec"><div class="out-label">Session</div>
        ${item('Model', !p ? 'Not chosen' : p.missing ? 'Provider removed' : `${p.model}${p.label ? ` · ${p.label}` : ''}`, 'model')}
        ${item('Workflow', wf ? wf.title : 'None', 'workflow')}
        ${item('Skills', session.skills.length ? session.skills.map(skill => skill.name).join(', ') : 'None', 'skills')}
        ${item('Agent', session.agent ? session.agent.name : 'None', 'settings')}
        <div class="out-stat"><span>${list.filter(message => message.role === 'user').length}</span> sent · <span>${list.filter(message => message.role === 'assistant').length}</span> replies</div></div>`;
    })() : '<div class="out-sec"><p class="out-empty">Loading session…</p></div>';
    if (live) {
      const steps = live.workflow ? stepsHtml(live.workflow.steps, 'workflow') : live.plan ? stepsHtml(live.plan, 'plan') : '';
      return `<div class="out-sec"><div class="out-label">Running</div><div class="cs-status" role="status"><span class="af-spin" aria-hidden="true"></span><span>${esc(live.status)}</span></div>${steps}</div>${setup}`;
    }
    if (!last) return `${setup}<div class="out-sec"><div class="out-label">Last run</div><p class="out-empty">After the first reply, its workflow steps, tools, agents, tokens and timing show up here.</p></div>`;
    const details = detailsHtml(last.meta || {});
    return `<div class="out-sec"><div class="out-label">Last run <span class="out-time">${esc(H.stamp(last.createdAt))}</span></div>
        <div class="cs-details out-details">${details || '<p class="out-empty">Answered directly by the model.</p>'}</div>
        <div class="cs-offers"><button class="cs-offer" type="button" data-chat="copy-msg" data-id="${esc(last.id)}">Copy reply</button><button class="cs-offer" type="button" data-chat="retry">Regenerate</button></div></div>${setup}`;
  }
  function paintOutput(chatId) {
    const el = q('[data-chat-output]');
    if (el && chatId && chatId === activeId()) el.innerHTML = outputHtml(chatId);
  }

  // ───────────────────────── the conversation pane (called by renderer.js)
  function sessionOf(chatId) { return C.sessions.get(chatId) || null; }
  function barHtml(chatId) {
    const session = sessionOf(chatId);
    if (!session) return '<div class="chat-bar"><span class="chat-bar-note">Loading session…</span></div>';
    const p = session.provider; const busy = C.live.has(chatId);
    const modelText = !p ? 'Model Switch' : p.missing ? 'Provider removed' : p.model;
    const modelWarn = !p || p.missing || p.keyMissing;
    const wf = session.workflow; const skills = session.skills;
    const chip = (pop, label, text, warn, iconName, title) => `<button class="chat-chip${warn ? ' is-warn' : ''}${C.pop === pop ? ' is-open' : ''}" type="button" data-chat="pop" data-pop="${pop}" aria-haspopup="dialog" aria-expanded="${C.pop === pop}" title="${esc(title)}"${busy ? ' disabled' : ''}>${ic(iconName)}<span class="chat-chip-text"><span class="sr-only">${esc(label)}: </span>${esc(text)}</span>${ic('down')}</button>`;
    const active = skills.length ? `<div class="chat-skills" aria-label="Active skills">${skills.map(skill => `<span class="chat-skill${skill.missing || skill.enabled === false || skill.valid === false ? ' is-warn' : ''}" title="${esc(skill.missing ? 'This skill no longer exists.' : skill.enabled === false ? 'Disabled on the Skills page, so it is not loaded.' : skill.valid === false ? 'This skill has a problem and is not loaded.' : skill.description || '')}">${esc(skill.name)}<button class="chat-skill-x" type="button" data-chat="remove-skill" data-id="${esc(skill.id)}" aria-label="Remove skill ${esc(skill.name)}"${busy ? ' disabled' : ''}>${ic('x')}</button></span>`).join('')}</div>` : '';
    const sendBtn = busy
      ? `<button class="icon-btn solid chat-send" type="button" data-chat="stop" aria-label="Stop" title="Stop">${ic('stop')}</button>`
      : `<button class="icon-btn solid chat-send" type="submit" aria-label="Send message" title="Send (Enter)">${ic('send')}</button>`;
    return `<div class="chat-bar">
        <button class="chat-plus${C.pop === 'add' ? ' is-open' : ''}" type="button" data-chat="pop" data-pop="add" aria-haspopup="dialog" aria-expanded="${C.pop === 'add'}" aria-label="Add skills, commands or session settings" title="Skills, commands and session settings"${busy ? ' disabled' : ''}>${ic('plus')}</button>
        ${skills.length ? chip('skills', 'Skills', `Skills · ${skills.length}`, false, 'skill', `Active: ${skills.map(skill => skill.name).join(', ')}`) : ''}
        <span class="chat-bar-space"></span>
        ${chip('workflow', 'Workflow', wf ? wf.title : 'Set Workflow', Boolean(wf && wf.missing), 'flow', wf ? (wf.missing ? 'This workflow was deleted. Choose another or remove it.' : `Every message runs through ${wf.title}`) : 'Run every message through one of your workflows')}
        ${chip('model', 'Model', modelText, modelWarn, 'model', !p ? 'Choose the model for this conversation' : p.missing ? 'The provider was removed. Choose another model.' : `${p.model} · ${p.label}${p.inherited ? ' (from the agent)' : ''}${p.keyMissing ? ' — no API key saved' : ''}`)}
        ${sendBtn}
      </div>${active}`;
  }
  function composerHtml(chatId) {
    return `<div class="chat-foot" data-chat-foot>
      <div class="chat-pop" data-chat-pop role="dialog" hidden></div>
      <div class="chat-suggest" data-chat-suggest role="listbox" aria-label="Commands" hidden></div>
      <div class="ag-taskbar-host" data-chat-taskbar></div>
      <form class="chat-composer chat-card" data-form="chat"><textarea class="field field-area chat-card-input" id="chat-input" name="content" rows="2" maxlength="8000" placeholder="Make impactful sessions with our chat" aria-label="Message" aria-describedby="chat-hint"></textarea>
        <div data-chat-bar-host>${barHtml(chatId)}</div></form>
      <span class="sr-only" id="chat-hint">Enter sends, Shift+Enter adds a line, / opens commands.</span>
    </div>`;
  }
  function pane({ chat, archived }) {
    return `<div class="chat-messages" aria-live="polite" data-chat-messages><div class="chat-empty"><p>No messages yet. Write the first one below.</p></div></div>
      ${archived ? '<p class="chat-note">This conversation is archived. Unarchive it to keep writing.</p>' : composerHtml(chat.id)}`;
  }
  function mount() {
    const chatId = activeId();
    if (!chatId || !q('[data-chat-messages]')) return;
    syncMessages({ scroll: 'bottom' });
    if (C.pop) paintPop();
    if (!C.sessions.has(chatId)) open(chatId);
  }
  function repaintFoot(chatId, { keepPop = true } = {}) {
    if (chatId !== activeId()) return;
    const host = q('[data-chat-bar-host]'); if (host) host.innerHTML = barHtml(chatId);
    paintOutput(chatId);
    if (keepPop && C.pop) paintPop(); else closePop();
  }
  async function loadResources(force = false) {
    if (C.resources && !force) return C.resources;
    C.resources = await call(() => api.resources(), true).catch(() => C.resources || { providers: [], agents: [], workflows: [], skills: [], memory: [], hasDefaults: false, commands: {} });
    return C.resources;
  }
  async function open(chatId) {
    if (!api) return;
    try {
      const [session] = await Promise.all([api.session(chatId), loadResources()]);
      C.sessions.set(chatId, session);
      C.rendered.clear();
      repaintFoot(chatId);
    } catch { /* the conversation may have been deleted meanwhile */ }
  }

  // ───────────────────────── popovers: model, workflow, skills, settings
  function closePop({ focus = false } = {}) {
    const was = C.pop; C.pop = null; C.query = '';
    const el = q('[data-chat-pop]'); if (el) { el.hidden = true; el.innerHTML = ''; }
    document.querySelectorAll('[data-chat="pop"]').forEach(button => { button.setAttribute('aria-expanded', 'false'); button.classList.remove('is-open'); });
    if (focus && was) { const trigger = q(`[data-chat="pop"][data-pop="${was}"]`); if (trigger) trigger.focus(); }
  }
  async function openPop(name) {
    if (C.pop === name) { closePop({ focus: true }); return; }
    C.pop = name; C.query = '';
    closeSuggest();
    const chatId = activeId(); const session = sessionOf(chatId);
    if (name === 'model') { C.popProvider = session && session.provider && !session.provider.missing ? session.provider.connectionId : null; }
    await loadResources(true);
    if (C.pop !== name) return;
    if (name === 'model') { if (!C.popProvider && C.resources.providers.length) C.popProvider = C.resources.providers[0].id; loadModels(C.popProvider); }
    paintPop({ focus: true });
    document.querySelectorAll('[data-chat="pop"]').forEach(button => { const on = button.dataset.pop === name; button.setAttribute('aria-expanded', String(on)); button.classList.toggle('is-open', on); });
  }
  function loadModels(providerId, force = false) {
    if (!providerId || !auto || (C.models.has(providerId) && !force)) return;
    C.models.set(providerId, { loading: true, models: [], error: null });
    auto.providerModels(providerId).then(result => C.models.set(providerId, { loading: false, models: result.models || [], error: result.available ? null : result.error || 'This provider did not answer.' }))
      .catch(error => C.models.set(providerId, { loading: false, models: [], error: error.message }))
      .then(() => { if (C.pop === 'model' && C.popProvider === providerId) paintList(); });
  }
  const switchHtml = (key, on, label, hint) => `<div class="pop-switch-row"><div><div class="pop-switch-label" id="sw-${key}">${esc(label)}</div><div class="pop-hint">${esc(hint)}</div></div><button class="chat-switch" type="button" role="switch" aria-checked="${on}" aria-labelledby="sw-${key}" data-chat="pref" data-key="${key}"><span></span></button></div>`;
  function listHtml() {
    const chatId = activeId(); const session = sessionOf(chatId); const query = C.query.trim().toLowerCase();
    if (!session || !C.resources) return '';
    if (C.pop === 'model') {
      const provider = C.resources.providers.find(item => item.id === C.popProvider);
      if (!provider) return '<p class="pop-empty">Add a provider under Agents → LLM APIs.</p>';
      const entry = C.models.get(provider.id) || { loading: true, models: [] };
      const current = session.provider && session.provider.connectionId === provider.id && !session.provider.inherited ? session.provider.model : null;
      const names = entry.models.map(model => model.id);
      if (provider.model && !names.includes(provider.model)) names.unshift(provider.model);
      if (current && !names.includes(current)) names.unshift(current);
      const shown = names.filter(name => !query || name.toLowerCase().includes(query)).slice(0, 80);
      const typed = C.query.trim();
      const rows = shown.map(name => { const info = entry.models.find(model => model.id === name); return `<button class="pop-row" type="button" role="option" aria-selected="${name === current}" data-chat="pick-model" data-id="${esc(name)}"><span class="pop-row-main">${esc(name)}</span><span class="pop-row-meta">${info && info.contextWindow ? `${count(info.contextWindow)} tokens` : ''}</span>${name === current ? ic('check') : ''}</button>`; }).join('');
      const custom = typed && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/.test(typed) && !names.includes(typed) ? `<button class="pop-row" type="button" role="option" aria-selected="false" data-chat="pick-model" data-id="${esc(typed)}"><span class="pop-row-main">Use “${esc(typed)}”</span><span class="pop-row-meta">typed name</span></button>` : '';
      const state = entry.loading ? '<p class="pop-empty"><span class="af-spin" aria-hidden="true"></span> Loading models…</p>' : entry.error ? `<p class="pop-empty is-error">${esc(entry.error)}</p>` : !rows && !custom ? `<p class="pop-empty">${names.length ? 'No model matches.' : 'This provider lists no models. Type a model name above.'}</p>` : '';
      const note = provider.needsKey && !provider.hasKey ? 'No API key is saved for this provider. Add one under Agents → LLM APIs.' : `Tool calls: ${provider.tools === true ? 'supported' : provider.tools === 'model' ? 'depends on the model' : provider.tools ? 'enabled' : 'not available'}${provider.local ? ' · runs on this computer' : ''}`;
      return `${rows}${custom}${state}<p class="pop-hint pop-foot">${esc(note)}</p>`;
    }
    if (C.pop === 'workflow') {
      const list = C.resources.workflows.filter(item => !query || item.title.toLowerCase().includes(query));
      const current = session.settings.workflowId;
      return `<button class="pop-row" type="button" role="option" aria-selected="${!current}" data-chat="pick-workflow" data-id=""><span class="pop-row-main">No workflow</span><span class="pop-row-meta">reply with the model</span>${!current ? ic('check') : ''}</button>${list.map(item => `<button class="pop-row" type="button" role="option" aria-selected="${item.id === current}" data-chat="pick-workflow" data-id="${esc(item.id)}"><span class="pop-row-main">${esc(item.title)}</span><span class="pop-row-meta">${esc(item.description || '')}</span>${item.id === current ? ic('check') : ''}</button>`).join('')}${C.resources.workflows.length ? '' : '<p class="pop-empty">You have no workflows yet.</p>'}`;
    }
    if (C.pop === 'skills') {
      const activeIds = new Set(session.settings.skills);
      const list = C.resources.skills.filter(item => !query || `${item.name} ${item.id} ${item.description} ${(item.triggers || []).join(' ')}`.toLowerCase().includes(query));
      return list.length ? list.map(item => { const usable = item.enabled && item.valid; const on = activeIds.has(item.id); return `<button class="pop-row pop-row-tall" type="button" role="option" aria-selected="${on}" data-chat="toggle-skill" data-id="${esc(item.id)}"${usable || on ? '' : ' disabled'}><span class="pop-row-main">${esc(item.name)}${usable ? '' : `<span class="eco-tag">${item.enabled ? 'needs fixing' : 'disabled'}</span>`}</span><span class="pop-row-meta">${esc(item.description || 'No description.')}</span>${on ? ic('check') : ''}</button>`; }).join('')
        : `<p class="pop-empty">${C.resources.skills.length ? 'No skill matches.' : 'Your skill library is empty.'}</p>`;
    }
    return '';
  }
  function paintList() { const el = q('[data-pop-list]'); if (el) el.innerHTML = listHtml(); }
  function paintPop({ focus = false } = {}) {
    const el = q('[data-chat-pop]'); const chatId = activeId(); const session = sessionOf(chatId);
    if (!el || !session || !C.resources || !C.pop) return;
    const keep = document.activeElement && el.contains(document.activeElement) ? (document.activeElement.dataset.key || document.activeElement.dataset.popFocus || null) : null;
    const search = (label, placeholder) => `<input class="field pop-search" type="search" data-chat-query data-pop-focus="query" value="${esc(C.query)}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}" autocomplete="off" spellcheck="false">`;
    const link = (view, text) => `<button class="link-btn pop-link" type="button" data-chat="go" data-view="${view}">${esc(text)}</button>`;
    let html = '';
    if (C.pop === 'model') {
      html = `<div class="pop-head"><span>Model for this conversation</span>${link('agents', 'Providers')}</div>
        <div class="pop-tabs" role="tablist" aria-label="Provider">${C.resources.providers.map(item => `<button class="toggle-pill${item.id === C.popProvider ? ' active' : ''}" type="button" role="tab" aria-selected="${item.id === C.popProvider}" data-chat="pop-provider" data-id="${esc(item.id)}">${esc(item.label)}</button>`).join('')}</div>
        ${search('Search or type a model name', 'Search or type a model name')}<div class="pop-list" data-pop-list role="listbox" aria-label="Models">${listHtml()}</div>`;
      el.setAttribute('aria-label', 'Choose a model');
    } else if (C.pop === 'workflow') {
      html = `<div class="pop-head"><span>Workflow for this conversation</span>${link('automation', 'Edit workflows')}</div>
        ${C.resources.workflows.length > 6 ? search('Search workflows', 'Search workflows') : ''}<div class="pop-list" data-pop-list role="listbox" aria-label="Workflows">${listHtml()}</div>
        <p class="pop-hint pop-foot">With a workflow attached, each message runs through it and the recent conversation is passed in as context.</p>`;
      el.setAttribute('aria-label', 'Choose a workflow');
    } else if (C.pop === 'add') {
      const row = (attrs, main, meta) => `<button class="pop-row pop-row-tall" type="button" role="option" ${attrs}><span class="pop-row-main">${esc(main)}</span><span class="pop-row-meta">${esc(meta)}</span></button>`;
      html = `<div class="pop-head"><span>Add to this conversation</span></div>
        <div class="pop-list" role="listbox" aria-label="Add">
          ${row('data-chat="pop" data-pop="skills"', 'Skills', session.skills.length ? `${session.skills.length} active · turn skills on or off` : 'Give the assistant extra abilities')}
          ${row('data-chat="insert-command"', 'Commands', 'Type / for model, skill, workflow and memory commands')}
          ${row('data-chat="pop" data-pop="settings"', 'Session settings', 'Agent, instructions, context and saved memory')}
          ${row('data-chat="go" data-view="automation"', 'Build a workflow', 'Open the workflow editor')}
        </div>`;
      el.setAttribute('aria-label', 'Add to this conversation');
    } else if (C.pop === 'skills') {
      html = `<div class="pop-head"><span>Skills in this conversation</span>${link('skills', 'Manage skills')}</div>
        ${search('Search skills', 'Search skills')}<div class="pop-list" data-pop-list role="listbox" aria-multiselectable="true" aria-label="Skills">${listHtml()}</div>
        ${switchHtml('skillDiscovery', session.settings.prefs.skillDiscovery, 'Load relevant skills automatically', 'Off: matching skills are only suggested under the reply.')}`;
      el.setAttribute('aria-label', 'Choose skills');
    } else {
      const prefs = session.settings.prefs; const memory = C.resources.memory;
      html = `<div class="pop-head"><span>Session settings</span><span class="pop-saved" data-pop-saved aria-live="polite"></span></div>
        <div class="pop-scroll">
          <label class="pop-label" for="cs-agent">Agent</label>
          <select class="field af-select" id="cs-agent" data-chat-setting="agentId" data-key="agentId"><option value="">None — the model answers as itself</option>${C.resources.agents.map(item => `<option value="${esc(item.id)}"${item.id === session.settings.agentId ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}${session.agent && session.agent.missing ? '<option value="" selected>Deleted agent — choose another</option>' : ''}</select>
          <p class="pop-hint">An agent brings its identity, instructions, skills and permitted tools. The model chosen below the message box stays in charge.</p>
          <label class="pop-label" for="cs-instructions">Session instructions</label>
          <textarea class="field field-area" id="cs-instructions" rows="3" maxlength="8000" data-chat-setting="instructions" data-key="instructions" placeholder="How the assistant should behave in this conversation">${esc(session.settings.instructions)}</textarea>
          <label class="pop-label" for="cs-context">Session context</label>
          <textarea class="field field-area" id="cs-context" rows="3" maxlength="20000" data-chat-setting="context" data-key="context" placeholder="Background the assistant should know here: project notes, facts, links">${esc(session.settings.context)}</textarea>
          <div class="pop-label">Execution</div>
          ${switchHtml('orchestration', prefs.orchestration === 'auto', 'Plan complex requests', 'Breaks larger tasks into steps. Simple questions are always answered directly.')}
          ${switchHtml('verify', prefs.verify, 'Check planned results', 'Compares the answer with the request and repairs it once if something is missing.')}
          ${switchHtml('delegation', prefs.delegation, 'Ask specialist agents', 'Lets this conversation hand sub-tasks to your agents. Needs a model that supports tool calls.')}
          ${switchHtml('visuals', prefs.visuals, 'Charts, diagrams and visuals', 'Generated visuals run isolated, without network, file or app access.')}
          <div class="pop-label">Saved memory <span class="pop-hint">shared by all conversations</span></div>
          ${memory.length ? `<ul class="pop-memory">${memory.map(note => `<li><span>${esc(note.text)}</span><button class="icon-btn sm" type="button" data-chat="forget" data-id="${esc(note.id)}" aria-label="Remove memory note">${ic('x')}</button></li>`).join('')}</ul>` : '<p class="pop-hint">Nothing saved. Notes are added only when you add them here or with /remember.</p>'}
          <form class="pop-inline" data-form="chat-memory"><input class="field" name="note" maxlength="600" placeholder="Add a note to remember" aria-label="Add a memory note" data-key="memory-note"><button class="btn btn-sm btn-ghost" type="submit">Add</button></form>
          <div class="pop-label">New conversations</div>
          <div class="pop-inline"><button class="btn btn-sm btn-ghost" type="button" data-chat="save-defaults" data-key="save-defaults">Start new conversations with these settings</button>${C.resources.hasDefaults ? '<button class="link-btn" type="button" data-chat="clear-defaults" data-key="clear-defaults">Clear saved defaults</button>' : ''}</div>
          <p class="pop-hint">${C.resources.hasDefaults ? 'New conversations start from your saved defaults.' : 'New conversations start empty until you save defaults.'} Session context and the attached workflow are never copied.</p>
        </div>`;
      el.setAttribute('aria-label', 'Session settings');
    }
    el.className = `chat-pop is-${C.pop}`; el.innerHTML = html; el.hidden = false;
    const target = keep ? el.querySelector(`[data-key="${keep}"], [data-pop-focus="${keep}"]`) : null;
    if (target) target.focus();
    else if (focus) { const first = el.querySelector('[data-chat-query], select, [role="option"], button'); if (first) first.focus(); }
  }
  async function updateSettings(patch, { repaint = true } = {}) {
    const chatId = activeId(); if (!chatId) return null;
    const session = await call(() => api.updateSettings(chatId, patch));
    C.sessions.set(chatId, session);
    if ('prefs' in patch && patch.prefs.visuals !== undefined) { C.rendered.clear(); H.rerender(); return session; }
    if (repaint) repaintFoot(chatId);
    return session;
  }
  function flashSaved(text = 'Saved') { const el = q('[data-pop-saved]'); if (!el) return; el.textContent = text; clearTimeout(flashSaved.timer); flashSaved.timer = setTimeout(() => { if (el.isConnected) el.textContent = ''; }, 1600); }
  function saveText(field) {
    const key = field.dataset.chatSetting; const chatId = activeId(); const session = sessionOf(chatId);
    if (!session || session.settings[key] === field.value) return;
    api.updateSettings(chatId, { [key]: field.value }).then(next => { C.sessions.set(chatId, next); flashSaved(); }).catch(error => H.toast(error.message, { error: true }));
  }

  // ───────────────────────── slash-command suggestions
  function closeSuggest() { C.suggest = null; const el = q('[data-chat-suggest]'); if (el) { el.hidden = true; el.innerHTML = ''; } const input = q('#chat-input'); if (input) input.removeAttribute('aria-activedescendant'); }
  function paintSuggest(input) {
    const el = q('[data-chat-suggest]'); const value = input.value;
    if (!el || !C.resources || !value.startsWith('/') || value.includes('\n')) { closeSuggest(); return; }
    let items = [];
    const skill = /^\/skill\s+(?!off\b)(\S*)$/i.exec(value);
    if (skill) items = C.resources.skills.filter(item => item.enabled && item.valid && (`${item.id} ${item.name}`.toLowerCase().includes(skill[1].toLowerCase()))).slice(0, 7).map(item => ({ insert: `/skill ${item.id} `, label: `/skill ${item.id}`, hint: item.description || item.name }));
    else if (/^\/[a-z]*$/i.test(value)) items = Object.entries(C.resources.commands).filter(([name]) => `/${name}`.startsWith(value.toLowerCase())).map(([name, text]) => ({ insert: `/${name} `, label: `/${name}`, hint: text.split(' — ')[1] || '' }));
    if (!items.length) { closeSuggest(); return; }
    const index = C.suggest ? Math.min(C.suggest.index, items.length - 1) : 0;
    C.suggest = { items, index };
    el.innerHTML = items.map((item, i) => `<button class="pop-row${i === index ? ' is-active' : ''}" type="button" role="option" id="cs-sg-${i}" aria-selected="${i === index}" data-chat="suggest" data-index="${i}" tabindex="-1"><span class="pop-row-main">${esc(item.label)}</span><span class="pop-row-meta">${esc(item.hint)}</span></button>`).join('') + '<p class="pop-hint pop-foot">Tab to complete · Enter to send</p>';
    el.hidden = false; input.setAttribute('aria-activedescendant', `cs-sg-${index}`);
  }
  function acceptSuggest(index) {
    const input = q('#chat-input'); if (!input || !C.suggest) return;
    const item = C.suggest.items[index]; if (!item) return;
    input.value = item.insert; input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    C.suggest = null; paintSuggest(input);
  }
  function grow(input) { input.style.height = 'auto'; input.style.height = `${Math.min(160, Math.max(40, input.scrollHeight + 2))}px`; }

  // ───────────────────────── sending and live events
  function startLive(chatId, status) { C.live.set(chatId, { status, text: '', plan: null, workflow: null, textDirty: true, stepsDirty: true }); }
  async function run(chatId, content, options) {
    if (!api || C.live.has(chatId)) return;
    closePop(); closeSuggest();
    startLive(chatId, 'Thinking…');
    repaintFoot(chatId, { keepPop: false }); syncMessages({ scroll: 'bottom' });
    try { await api.send(chatId, content, options || null); }
    catch (error) { H.toast(error.message || 'The message could not be sent.', { error: true }); }
    finally {
      // The main process normally ends the turn with an event; this covers a refused or failed call.
      if (C.live.has(chatId)) { C.live.delete(chatId); repaintFoot(chatId); syncMessages(); }
      H.repaintLists();
    }
  }
  function send(text) { const chatId = activeId(); if (!chatId || !String(text || '').trim()) return; run(chatId, String(text).trim()); }
  function submit(form) {
    const input = form.querySelector('#chat-input'); const chatId = activeId();
    const content = input.value.trim();
    if (!content || !chatId) return;
    if (C.live.has(chatId)) { H.toast('Still working on the previous message. Stop it first.'); return; }
    input.value = ''; grow(input);
    run(chatId, content);
  }
  function onEvent(event) {
    const chatId = event.chatId; const S = H.state(); const visible = chatId === activeId();
    const live = C.live.get(chatId) || (['turn-start', 'status', 'delta', 'plan', 'workflow'].includes(event.type) ? (startLive(chatId, 'Thinking…'), C.live.get(chatId)) : null);
    switch (event.type) {
      case 'message': if (S.messages[chatId]) { S.messages[chatId].push(event.message); if (visible) syncMessages({ scroll: event.message.role === 'user' ? 'bottom' : 'keep' }); } break;
      case 'messages-removed': if (S.messages[chatId]) { const index = S.messages[chatId].findIndex(message => message.id === event.after); if (index >= 0) S.messages[chatId].length = index + 1; if (visible) syncMessages(); } break;
      case 'settings': C.sessions.set(chatId, event.session); loadResources(true).then(() => repaintFoot(chatId)); break;
      case 'title': H.repaintLists(); break;
      case 'turn-start': live.status = event.mode === 'workflow' ? 'Starting the workflow…' : `Asking ${event.model}…`; if (visible) paintLive(chatId); break;
      case 'status': live.status = event.text; if (visible) paintLive(chatId); break;
      case 'delta': live.text += event.text; live.textDirty = true; if (!live.plan && !live.workflow) live.status = 'Writing…'; if (visible) scheduleLive(chatId); break;
      case 'reset-text': if (live) { live.text = ''; live.textDirty = true; if (visible) scheduleLive(chatId); } break;
      case 'plan': live.plan = event.steps; live.stepsDirty = true; live.status = 'Working through the plan…'; if (visible) paintLive(chatId); break;
      case 'step': if (live && live.plan) { const index = live.plan.findIndex(step => step.id === event.step.id); if (index >= 0) live.plan[index] = event.step; live.stepsDirty = true; if (event.step.status === 'running') live.status = `Step ${event.step.number} of ${live.plan.length}: ${event.step.title}`; if (visible) paintLive(chatId); } break;
      case 'workflow': live.workflow = event.workflow; live.stepsDirty = true; { const current = event.workflow.steps.find(step => step.status === 'running'); if (current) live.status = `${event.workflow.title}: ${current.name}`; } if (visible) paintLive(chatId); break;
      case 'tool': if (live) { live.status = `Tool ${event.entry.tool}: ${event.entry.outcome}`; if (visible) paintLive(chatId); } break;
      case 'turn-end': C.live.delete(chatId); if (visible) { repaintFoot(chatId); syncMessages(); } break;
      default: break;
    }
  }

  // ───────────────────────── interaction
  async function onAction(button, event) {
    const action = button.dataset.chat; const chatId = activeId(); const id = button.dataset.id;
    if (!chatId && action !== 'link') return;
    switch (action) {
      case 'pop': openPop(button.dataset.pop); break;
      case 'pop-provider': C.popProvider = id; C.query = ''; loadModels(id); paintPop(); { const tab = q(`[data-chat="pop-provider"][data-id="${CSS.escape(id)}"]`); if (tab) tab.focus(); } break;
      case 'pick-model': await updateSettings({ provider: { connectionId: C.popProvider, model: id } }, { repaint: false }).then(() => { closePop(); repaintFoot(chatId, { keepPop: false }); const trigger = q('[data-chat="pop"][data-pop="model"]'); if (trigger) trigger.focus(); H.toast(`This conversation now uses ${id}.`); }).catch(() => {}); break;
      case 'pick-workflow': await updateSettings({ workflowId: id || null }, { repaint: false }).then(() => { closePop(); repaintFoot(chatId, { keepPop: false }); const trigger = q('[data-chat="pop"][data-pop="workflow"]'); if (trigger) trigger.focus(); }).catch(() => {}); break;
      case 'toggle-skill': {
        const current = sessionOf(chatId).settings.skills; const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
        await updateSettings({ skills: next }, { repaint: false }).then(() => { const host = q('[data-chat-bar-host]'); if (host) host.innerHTML = barHtml(chatId); paintList(); const row = q(`[data-chat="toggle-skill"][data-id="${CSS.escape(id)}"]`); if (row) row.focus(); }).catch(() => {});
        break;
      }
      case 'remove-skill': await updateSettings({ skills: sessionOf(chatId).settings.skills.filter(item => item !== id) }).catch(() => {}); break;
      case 'use-skill': await updateSettings({ skills: [...new Set([...sessionOf(chatId).settings.skills, id])] }).then(() => { button.disabled = true; H.toast('Skill activated for this conversation.'); }).catch(() => {}); break;
      case 'pref': {
        const key = button.dataset.key; const on = button.getAttribute('aria-checked') !== 'true';
        await updateSettings({ prefs: { [key]: key === 'orchestration' ? (on ? 'auto' : 'direct') : on } }).then(() => { const again = q(`[data-chat="pref"][data-key="${key}"]`); if (again) again.focus(); }).catch(() => {});
        break;
      }
      case 'forget': await call(() => api.deleteMemory(id)).then(() => loadResources(true)).then(() => paintPop()).catch(() => {}); break;
      case 'save-defaults': await call(() => api.setDefaults(chatId)).then(() => loadResources(true)).then(() => { paintPop(); flashSaved('Saved as the starting point for new conversations'); }).catch(() => {}); break;
      case 'clear-defaults': await call(() => api.setDefaults(null)).then(() => loadResources(true)).then(() => { paintPop(); flashSaved('Defaults cleared'); }).catch(() => {}); break;
      case 'go': closePop(); H.go(button.dataset.view); break;
      case 'stop': button.disabled = true; api.cancel(chatId).catch(() => {}); break;
      case 'retry': run(chatId, null, { regenerate: true }); break;
      case 'run-workflow': run(chatId, null, { regenerate: true, workflowOnce: id }); break;
      case 'continue': send('Continue from where you stopped.'); break;
      case 'suggest': acceptSuggest(Number(button.dataset.index)); break;
      case 'insert-command': { closePop(); const input = q('#chat-input'); if (input) { input.value = '/'; input.focus(); grow(input); paintSuggest(input); } break; }
      case 'copy-msg': { const message = messagesOf(chatId).find(item => item.id === id); if (message) copy(message.content, button); break; }
      case 'toggle-details': { const panel = button.closest('[data-msg]').querySelector('.cs-details'); panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); button.textContent = panel.hidden ? 'Details' : 'Hide details'; break; }
      case 'toggle-preview': { const open = button.classList.toggle('open'); button.setAttribute('aria-expanded', String(open)); break; }
      default: break;
    }
    void event;
  }
  function copy(text, button) {
    const done = () => { const label = button.textContent; button.textContent = 'Copied'; setTimeout(() => { if (button.isConnected) button.textContent = label; }, 1400); };
    api.copyText(text).then(done).catch(() => H.toast('Could not copy to the clipboard.', { error: true }));
  }
  function init(helpers) {
    H = helpers;
    if (!api || !R) return;
    api.onEvent(onEvent);
    document.addEventListener('click', event => {
      const target = event.target;
      const link = target.closest('.md-link');
      if (link) { event.preventDefault(); api.openExternal(link.dataset.href).catch(error => H.toast(error.message, { error: true })); return; }
      const copyCode = target.closest('[data-copy-code]');
      if (copyCode) { const code = copyCode.closest('.md-pre').querySelector('code'); copy(code.textContent, copyCode); return; }
      const expand = target.closest('[data-expand-code]');
      if (expand) { const box = expand.closest('.md-pre'); const collapsed = box.classList.toggle('is-collapsed'); expand.textContent = collapsed ? `Show all ${expand.dataset.lines} lines` : 'Show less'; return; }
      const button = target.closest('[data-chat]');
      if (button && !button.disabled) { onAction(button, event); return; }
      if (C.pop && !target.closest('[data-chat-pop]')) closePop();
      if (C.suggest && !target.closest('[data-chat-suggest]') && target.id !== 'chat-input') closeSuggest();
    });
    document.addEventListener('input', event => {
      const target = event.target;
      if (target.id === 'chat-input') { grow(target); paintSuggest(target); }
      else if (target.matches('[data-chat-query]')) { C.query = target.value; paintList(); }
      else if (target.matches('textarea[data-chat-setting]')) { clearTimeout(C.saveTimers.get(target.dataset.chatSetting)); C.saveTimers.set(target.dataset.chatSetting, setTimeout(() => { if (target.isConnected) saveText(target); }, 700)); }
    });
    document.addEventListener('change', event => {
      const target = event.target;
      if (target.matches('select[data-chat-setting="agentId"]')) updateSettings({ agentId: target.value || null }).then(() => flashSaved()).catch(() => {});
      else if (target.matches('textarea[data-chat-setting]')) { clearTimeout(C.saveTimers.get(target.dataset.chatSetting)); saveText(target); }
    });
    document.addEventListener('submit', event => {
      const form = event.target.closest('[data-form="chat-memory"]');
      if (!form) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const note = String(new FormData(form).get('note') || '').trim(); if (!note) return;
      call(() => api.addMemory(note)).then(() => loadResources(true)).then(() => { paintPop(); const input = q('[data-key="memory-note"]'); if (input) input.focus(); flashSaved('Saved to memory'); }).catch(() => {});
    }, true);
    // Registered before renderer.js binds its own keys, so the composer's suggestion list and the popovers get first say.
    document.addEventListener('keydown', event => {
      const target = event.target;
      if (target.id === 'chat-input' && C.suggest) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const n = C.suggest.items.length; C.suggest.index = (C.suggest.index + (event.key === 'ArrowDown' ? 1 : n - 1)) % n; paintSuggest(target); return; }
        if (event.key === 'Tab') { event.preventDefault(); acceptSuggest(C.suggest.index); return; }
        if (event.key === 'Escape') { event.stopImmediatePropagation(); closeSuggest(); return; }
      }
      if (event.key === 'Escape' && C.pop) { event.stopImmediatePropagation(); closePop({ focus: true }); return; }
      const pop = target.closest && target.closest('[data-chat-pop]');
      if (pop && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        const rows = [...pop.querySelectorAll('[role="option"]:not(:disabled)')]; if (!rows.length) return;
        const index = rows.indexOf(document.activeElement);
        if (index < 0 && !target.matches('[data-chat-query]')) return;
        event.preventDefault();
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
        if (next < 0) { const search = pop.querySelector('[data-chat-query]'); if (search) search.focus(); else rows[rows.length - 1].focus(); }
        else rows[Math.min(next, rows.length - 1)].focus();
      }
      if (pop && event.key === 'Enter' && target.matches('[data-chat-query]')) { event.preventDefault(); const first = pop.querySelector('[role="option"]:not(:disabled)'); if (first) first.click(); }
    }, true);
  }
  function reset() { for (const timer of C.saveTimers.values()) clearTimeout(timer); C = fresh(); }
  function forget(chatId) { C.sessions.delete(chatId); C.live.delete(chatId); }

  window.PerflwChat = { init, reset, forget, pane, mount, open, submit, send, openPop, outputHtml, isBusy: chatId => C.live.has(chatId), ready: () => Boolean(api && R) };
})();

'use strict';
/* Projects — the upper tab strip over open project pages, and the block editor inside each page.
   Rules (blocks, edit operations, undo, tab state, Calendar entries) live in project-model.js; this file is the DOM side.
   Storage goes through window.workspaceData (preload → main → workspace.js), scoped to the signed-in account.
   Calendar stays its own page: linked records are opened there with helpers.openCalendar(day, recordId). */
(function () {
  const M = window.PerflwProjectModel;
  const api = window.workspaceData;
  if (!M || !api) return;
  let H = null;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const STATUSES = [['planned', 'Planned'], ['active', 'Active'], ['on-hold', 'On hold'], ['completed', 'Completed']];
  const LINKED = ['schedule', 'tasks', 'milestones', 'related'];
  const SAVE_DELAY = 900;
  const GRADIENTS = [['aurora', 'Aurora'], ['dusk', 'Dusk'], ['tide', 'Tide'], ['ember', 'Ember'], ['slate', 'Slate']];
  const EMOJI = ['😀', '😎', '🚀', '💡', '📌', '📚', '🎯', '🛠️', '🧠', '🌱', '🔥', '⭐', '🎨', '🏠', '💼', '🧪', '📈', '✈️', '🎵', '🍀', '🌍', '🧩', '📝', '✅', '🗓️', '💬', '🔒', '❤️', '🏃', '☕'];
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ICONS = {
    grip: '<g fill="currentColor" stroke="none"><circle cx="7.5" cy="5" r="1.2"/><circle cx="12.5" cy="5" r="1.2"/><circle cx="7.5" cy="10" r="1.2"/><circle cx="12.5" cy="10" r="1.2"/><circle cx="7.5" cy="15" r="1.2"/><circle cx="12.5" cy="15" r="1.2"/></g>',
    link: '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-3 3a3 3 0 0 0 4.2 4.2l1-1"/>',
    image: '<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="m4 15 4-4 3 3 2-2 3 3"/>',
    flag: '<path d="M5 17V3.5M5 4h9l-1.8 3L14 10H5"/>',
    twist: '<polyline points="8,5 13,10 8,15"/>',
    smile: '<circle cx="10" cy="10" r="7"/><path d="M7 11.8c.8 1.1 1.8 1.7 3 1.7s2.2-.6 3-1.7"/><circle cx="7.6" cy="8.4" r=".6" fill="currentColor"/><circle cx="12.4" cy="8.4" r=".6" fill="currentColor"/>',
    folderplus: '<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v6.7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M10 9.2v4M8 11.2h4"/>'
  };
  const ic = name => (ICONS[name] ? `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>` : H.icon(name));
  const today = () => M.localDay(new Date());
  function dayLabel(day) {
    const [y, m, d] = String(day).split('-').map(Number);
    return `${MON[m - 1]} ${d}${y !== new Date().getFullYear() ? `, ${y}` : ''}`;
  }

  // ───────────────────────── state
  const P = { user: null, status: 'idle', error: '', list: [], tabs: M.emptyTabs(), pages: new Map(), linked: { tasks: [], events: [], milestones: [] }, entries: [], byDay: new Map(), menu: null, drag: null, pendingFocus: null, pop: false, repo: null };
  const tabsKey = () => `perflw-project-tabs:${P.user}`;
  function readTabs() { try { return M.cleanTabs(JSON.parse(localStorage.getItem(tabsKey()) || 'null')); } catch { return M.emptyTabs(); } }
  function setTabs(next) { P.tabs = next; try { localStorage.setItem(tabsKey(), JSON.stringify(next)); } catch { /* tabs simply start closed next time */ } }
  const projectOf = id => P.list.find(p => p.id === id) || null;
  const activePage = () => (P.tabs.active ? P.pages.get(P.tabs.active) || null : null);
  const inView = () => H.view() === 'whim' && !!$('.pj-root');
  function nameOf(id) {
    const page = P.pages.get(id);
    if (page && page.status === 'ready') return page.name.trim() || 'Untitled';
    const project = projectOf(id);
    return project ? project.name : 'Project';
  }
  function rebuildEntries() {
    P.entries = M.calendarEntries({ projects: P.list, ...P.linked });
    P.byDay = new Map();
    for (const entry of P.entries) { if (!P.byDay.has(entry.day)) P.byDay.set(entry.day, []); P.byDay.get(entry.day).push(entry); }
  }
  function resetState() {
    for (const page of P.pages.values()) clearTimeout(page.timer);
    Object.assign(P, { status: 'idle', error: '', list: [], tabs: M.emptyTabs(), pages: new Map(), linked: { tasks: [], events: [], milestones: [] }, entries: [], byDay: new Map(), menu: null, drag: null, pendingFocus: null, pop: false, repo: null });
    const menu = $('#pj-menu'); if (menu) menu.hidden = true;
    const pop = $('#pj-pop'); if (pop) pop.hidden = true;
  }
  async function load(userId) {
    if (P.user !== userId) { resetState(); P.user = userId; P.tabs = readTabs(); }
    P.status = 'loading';
    try {
      const [list, tasks, events, milestones] = await Promise.all([api.projects(false), api.tasks(), api.events(), api.milestones()]);
      P.list = list; P.linked = { tasks, events, milestones }; P.status = 'ready'; P.error = '';
      setTabs(M.pruneTabs(P.tabs, list.map(p => p.id)));
    } catch (error) { P.status = 'error'; P.error = error.message || 'Projects could not be loaded.'; }
    rebuildEntries();
  }
  async function reloadLists() {
    try {
      const [list, tasks, events, milestones] = await Promise.all([api.projects(false), api.tasks(), api.events(), api.milestones()]);
      P.list = list; P.linked = { tasks, events, milestones };
      rebuildEntries();
    } catch { /* the lists keep their last known state */ }
  }

  // ───────────────────────── page state, history and saving
  function snapshot(page) { return JSON.stringify({ name: page.name, description: page.description, pstatus: page.pstatus, targetDate: page.targetDate, blocks: page.blocks }); }
  function ensurePage(id) {
    let page = P.pages.get(id);
    if (page) return page;
    page = { id, status: 'loading', error: '', name: '', description: '', pstatus: 'active', targetDate: '', cover: null, coverPos: 50, coverImage: null, icon: '', blocks: [], tasks: [], milestones: [], events: [], images: {},
      dirty: false, rev: 0, pending: null, saveError: '', timer: null, history: M.createHistory(), snap: '', burst: null };
    P.pages.set(id, page);
    loadPage(page);
    return page;
  }
  async function loadPage(page) {
    try {
      const data = await api.projectPage(page.id);
      page.name = data.project.name; page.description = data.project.description || '';
      page.pstatus = STATUSES.some(([key]) => key === data.project.status) ? data.project.status : 'active';
      page.targetDate = data.project.target_date ? M.localDay(data.project.target_date) || '' : '';
      page.cover = data.project.cover || null; page.icon = data.project.icon || '';
      page.coverPos = Number.isFinite(data.project.cover_pos) ? data.project.cover_pos : 50;
      page.coverImage = data.project.cover_image || null;
      for (const block of data.blocks) if (block.image && block.data && block.data.imageName) page.images[block.data.imageName] = block.image;
      page.blocks = M.cleanBlocks(data.blocks);
      page.tasks = data.tasks; page.milestones = data.milestones; page.events = data.events;
      page.snap = snapshot(page); page.status = 'ready';
    } catch (error) { page.status = 'error'; page.error = error.message || 'This project could not be opened.'; }
    if (P.pages.get(page.id) === page && P.tabs.active === page.id && inView()) paint();
  }
  /* Every edit goes through here. `key` groups a run of typing into one undo step; null marks a structural change. */
  function change(page, key, apply) {
    const at = Date.now();
    const sameBurst = key && page.burst && page.burst.key === key && at - page.burst.at < 1200;
    if (!sameBurst) page.history.record(page.snap);
    apply();
    page.snap = snapshot(page);
    page.burst = key ? { key, at } : null;
    touch(page);
  }
  function touch(page) {
    page.dirty = true; page.rev++; page.saveError = '';
    clearTimeout(page.timer);
    page.timer = setTimeout(() => save(page), SAVE_DELAY);
    paintSave(page);
  }
  function save(page) {
    clearTimeout(page.timer); page.timer = null;
    if (!page.pending) page.pending = runSave(page).finally(() => { page.pending = null; paintSave(page); });
    return page.pending;
  }
  async function runSave(page) {
    while (page.status === 'ready' && page.dirty) {
      const rev = page.rev;
      const project = { name: page.name.trim().slice(0, M.LIMITS.name) || 'Untitled', description: page.description.slice(0, M.LIMITS.description), status: page.pstatus, targetDate: page.targetDate ? M.toStamp(page.targetDate) : null, cover: page.cover, coverPos: page.coverPos, icon: page.icon };
      paintSave(page, true);
      try {
        const result = await api.saveProjectPage(page.id, { project, blocks: page.blocks.map(b => ({ id: b.id, type: b.type, text: b.text, data: b.data })) });
        page.saveError = '';
        if (page.rev === rev) page.dirty = false;
        const entry = projectOf(page.id);
        if (entry) { Object.assign(entry, { name: project.name, description: project.description, status: project.status, target_date: project.targetDate, icon: page.icon, cover: page.cover, cover_pos: page.coverPos, cover_image: page.coverImage, updated_at: result.updatedAt }); rebuildEntries(); }
        // The deadline feeds Calendar and "Next up"; forms inside other linked blocks are left untouched.
        if (page.metaChanged) { page.metaChanged = false; paintLinked(page, ['related']); }
      } catch (error) { page.saveError = error.message || 'The page could not be saved.'; break; }
    }
    return !page.dirty;
  }
  /* True when nothing unsaved is left: either the save went through or the user chose to discard. */
  async function settle(page) {
    if (!page || page.status !== 'ready') return true;
    if (page.dirty || page.pending) await save(page);
    if (!page.dirty) return true;
    return H.confirmDialog({ title: 'Discard unsaved changes?', text: `“${nameOf(page.id)}” has edits that could not be saved${page.saveError ? ` (${page.saveError})` : ''}. Closing it now discards them.`, ok: 'Discard' });
  }
  async function settleAll() {
    for (const page of [...P.pages.values()]) if (!(await settle(page))) return false;
    return true;
  }
  function flush() { closeMenu(); for (const page of P.pages.values()) if (page.dirty && !page.pending) save(page); }
  function restore(page, snap) {
    const state = JSON.parse(snap);
    Object.assign(page, { name: state.name, description: state.description, pstatus: state.pstatus, targetDate: state.targetDate, blocks: M.cleanBlocks(state.blocks), snap, burst: null });
    touch(page);
    const focus = captureFocus();
    paint();
    restoreFocus(focus);
  }
  function undo(page) { const snap = page.history.undo(page.snap); if (snap) restore(page, snap); }
  function redo(page) { const snap = page.history.redo(page.snap); if (snap) restore(page, snap); }

  // ───────────────────────── tabs
  /* Tab switch: the old page fades out sideways while the new one slides in from the side the tab sits on. */
  const tabOrder = id => (id ? P.tabs.open.indexOf(id) + 1 : 0);
  function slidePaint() {
    const from = P.shown; const to = P.tabs.active;
    const oldBody = $('.pj-body');
    const motion = oldBody && from !== undefined && from !== to && !document.body.classList.contains('motion-off') && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const ghost = motion ? oldBody.cloneNode(true) : null; const top = motion ? oldBody.offsetTop : 0;
    const dir = tabOrder(to) >= tabOrder(from) ? 1 : -1;
    const vertical = from === null || to === null; // the Projects overview rises into place; project-to-project slides sideways
    paint();
    if (!ghost) return;
    const root = $('.pj-root'); const body = $('.pj-body'); if (!root || !body) return;
    const scroller = root.closest('.main-panel'); if (scroller) scroller.scrollTop = 0;
    ghost.classList.add('pj-leaving', vertical ? 'to-up' : dir > 0 ? 'to-left' : 'to-right'); ghost.style.top = `${top}px`; ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
    root.append(ghost);
    body.classList.add('pj-slide-in', vertical ? 'from-down' : dir > 0 ? 'from-right' : 'from-left');
    const done = () => { ghost.remove(); body.classList.remove('pj-slide-in', 'from-right', 'from-left', 'from-down'); };
    ghost.addEventListener('animationend', done, { once: true }); setTimeout(done, 600);
  }
  function show() { if (inView()) slidePaint(); else if (H.view() === 'whim') H.rerender(); else H.go('whim'); }
  function open(id, { focusTitle = false } = {}) {
    if (!projectOf(id)) { H.toast('That project is no longer available.', { error: true }); return; }
    flush();
    setTabs(M.openTab(P.tabs, id));
    P.pendingFocus = focusTitle ? 'title' : null;
    show();
  }
  function activate(id) {
    flush();
    if (P.tabs.active !== id) setTabs(M.activateTab(P.tabs, id));
    show();
  }
  async function closeTab(id) {
    if (!(await settle(P.pages.get(id)))) return;
    const page = P.pages.get(id);
    if (page) { clearTimeout(page.timer); P.pages.delete(id); }
    setTabs(M.closeTab(P.tabs, id));
    if (inView()) { paint(); const tab = $('.pj-tabs [aria-selected="true"]'); if (tab) tab.focus(); }
  }
  async function createProject(name, focusTitle) {
    try {
      const id = await H.api(() => api.createProject(name, {}));
      await reloadLists();
      open(id, { focusTitle });
    } catch { /* toast shown */ }
  }
  async function deleteProject(id) {
    const name = nameOf(id);
    if (!(await H.confirmDialog({ title: 'Delete this project?', text: `“${name}” and its page will be permanently deleted. Linked tasks, milestones and schedules are kept without a project.` }))) return;
    try {
      const page = P.pages.get(id);
      if (page) { clearTimeout(page.timer); page.dirty = false; P.pages.delete(id); }
      await H.api(() => api.deleteProject(id));
      setTabs(M.pruneTabs(M.closeTab(P.tabs, id), P.list.filter(p => p.id !== id).map(p => p.id)));
      await reloadLists();
      if (inView()) paint();
      H.toast('Project deleted.');
    } catch { /* toast shown */ }
  }

  // ───────────────────────── rendering
  function tabIcon(id) {
    const page = P.pages.get(id);
    const icon = page && page.status === 'ready' ? page.icon : (projectOf(id) || {}).icon;
    return icon ? `<span class="pj-tab-emoji" aria-hidden="true">${esc(icon)}</span>` : H.icon('page');
  }
  function tabsHtml() {
    const tab = id => {
      const name = nameOf(id); const active = P.tabs.active === id; const page = P.pages.get(id);
      return `<div class="proj-tab pj-tab${active ? ' active' : ''}${page && page.dirty ? ' dirty' : ''}" data-tab="${esc(id)}">
        <button class="pj-tab-main" type="button" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" data-pj="tab" data-id="${esc(id)}" title="${esc(name)}">${tabIcon(id)}<span class="proj-tab-label">${esc(name)}</span><span class="pj-tab-dot" aria-hidden="true"></span></button>
        <button class="pj-tab-x" type="button" data-pj="tab-close" data-id="${esc(id)}" aria-label="Close ${esc(name)}">${H.icon('x')}</button>
      </div>`;
    };
    const home = P.tabs.active === null;
    return `<div class="proj-tabs pj-tabs" role="tablist" aria-label="Open projects">
      <button class="proj-tab pj-tab-home${home ? ' active' : ''}" type="button" role="tab" aria-selected="${home}" tabindex="${home ? 0 : -1}" data-pj="tab-home">${H.icon('folder')}<span>Projects</span></button>
      ${P.tabs.open.map(tab).join('')}
    </div>`;
  }
  function entryRow(entry, withProject) {
    const kind = { schedule: 'Schedule', task: 'Task', milestone: 'Milestone', deadline: 'Deadline' }[entry.kind];
    return `<div class="up-row pj-up${entry.done ? ' done' : ''}">
      <button class="pj-date" type="button" data-pj="open-cal" data-day="${entry.day}" data-ref="${esc(entry.id)}" title="Open in Calendar">${H.icon('calendar')}${esc(dayLabel(entry.day))}${entry.time ? ` · ${esc(H.fmtTime(entry.time))}` : ''}</button>
      <span class="up-text">${esc(entry.title)}</span>
      <span class="pj-kind">${kind}</span>
      ${withProject ? `<button class="link-btn pj-up-project" type="button" data-pj="open" data-id="${esc(entry.projectId)}">${esc(entry.project)}</button>` : ''}
    </div>`;
  }
  /* A project's uploaded banner (or chosen gradient) is also the look of its tile on the overview. */
  function tileLook(p) {
    const c = p.cover;
    if (c && c !== 'none' && !c.startsWith('g:') && p.cover_image) return ' has-img';
    if (c && c.startsWith('g:') && GRADIENTS.some(([key]) => key === c.slice(2))) return ` has-g g-${c.slice(2)}`;
    return '';
  }
  function overviewHtml() {
    let body;
    if (P.status === 'loading' || P.status === 'idle') body = '<div class="pj-state" role="status"><span class="spinner" aria-hidden="true"></span><p>Loading projects…</p></div>';
    else if (P.status === 'error') body = `<div class="pj-state error" role="alert"><p>${esc(P.error)}</p><button class="btn btn-sm btn-ghost" type="button" data-pj="reload">Try again</button></div>`;
    else body = `<div class="proj-grid"><div class="proj-card proj-card-new">
        <button class="proj-tile proj-tile-new" type="button" data-pj="new-project" aria-label="New project" title="New project">${ic('folderplus')}</button>
        <span class="proj-name">New project</span>
      </div>${P.list.map(p => `<div class="proj-card" data-id="${esc(p.id)}">
        <button class="proj-tile${tileLook(p)}" type="button" data-pj="open" data-pj-tile="${esc(p.id)}" data-id="${esc(p.id)}" aria-label="Open ${esc(p.name)}">${H.icon('folder')}</button>
        <button class="icon-btn proj-x" type="button" data-pj="delete-project" data-id="${esc(p.id)}" aria-label="Delete project ${esc(p.name)}">${H.icon('x')}</button>
        <span class="proj-name" title="${esc(p.name)}">${esc(p.name)}</span>
      </div>`).join('')}</div>`;
    const recent = P.tabs.recent.map(projectOf).filter(Boolean).slice(0, 4);
    const recentHtml = recent.length ? `<section class="proj-section" aria-label="Recently opened"><h2 class="proj-h">Recently opened</h2><div class="recent-grid">${recent.map(p => `<button class="recent-card" type="button" data-pj="open" data-id="${esc(p.id)}"><span class="recent-ic">${H.icon('folder')}</span><span class="recent-text"><strong>${esc(p.name)}</strong><small>${P.tabs.open.includes(p.id) ? 'Open in a tab' : `Edited ${esc(H.stamp(p.updated_at || p.created_at))}`}</small></span></button>`).join('')}</div></section>` : '';
    const start = today();
    const upcoming = P.entries.filter(e => e.day >= start && !e.done).slice(0, 6);
    const upcomingHtml = `<section class="proj-section up-card" aria-label="Upcoming"><h2 class="proj-h">Upcoming</h2>${upcoming.length ? upcoming.map(e => entryRow(e, true)).join('')
      : '<div class="up-empty"><p>Deadlines, milestones, tasks and schedules from your project pages show up here and in Calendar.</p><button class="btn btn-ghost btn-sm" type="button" data-go="calendar">Open Calendar</button></div>'}</section>`;
    return `${H.pageHead('Projects', 'Keep every idea and project in one place.')}
      <div class="list-wrap proj-wrap">
        ${body}${recentHtml}${upcomingHtml}
      </div>`;
  }
  // The HTML parser drops one newline right after <textarea>, so every value is written with a leading one.
  const area = (attrs, value) => `<textarea rows="1" ${attrs}>\n${esc(value)}</textarea>`;
  const textArea = (block, placeholder, extra = '', attrs = '', value = block.text) => area(`class="pj-text${extra ? ` ${extra}` : ''}" data-pj-text ${attrs} maxlength="${M.LIMITS.text}" placeholder="${esc(placeholder)}" aria-label="${esc((M.TYPE[block.type] || {}).label || 'Block')}"`, value);
  function linkedHtml(page, block) {
    const row = (kind, record, day, time, done) => `<div class="pj-lrow${done ? ' done' : ''}" data-ref="${esc(record.id)}">
      ${kind === 'schedule' ? `<span class="pj-lrow-ic">${H.icon('calendar')}</span>` : `<input type="checkbox" class="check" data-pj-done="${kind}" data-id="${esc(record.id)}" aria-label="Mark “${esc(record.title)}” done" ${done ? 'checked' : ''}>`}
      <span class="pj-lrow-text">${esc(record.title)}</span>
      ${day ? `<button class="pj-date" type="button" data-pj="open-cal" data-day="${day}" data-ref="${esc(record.id)}" title="Open in Calendar">${H.icon('calendar')}${esc(dayLabel(day))}${time ? ` · ${esc(H.fmtTime(time))}` : ''}</button>` : ''}
      <button class="icon-btn sm" type="button" data-pj="del-linked" data-kind="${kind}" data-id="${esc(record.id)}" aria-label="Delete “${esc(record.title)}”">${H.icon('x')}</button>
    </div>`;
    const card = (label, iconHtml, meta, rows, empty, form) => `<section class="pj-card pj-linked" aria-label="${label}">
      <header class="pj-linked-head"><span class="pj-linked-title">${iconHtml}${label}</span><span class="pj-linked-meta">${esc(meta)}</span></header>
      ${rows || `<p class="empty">${empty}</p>`}
      ${form}
    </section>`;
    if (block.type === 'tasks') {
      const done = page.tasks.filter(t => t.completed_at).length;
      return card('Tasks', H.icon('routine'), page.tasks.length ? `${done} of ${page.tasks.length} done` : '',
        page.tasks.map(t => row('task', t, t.due_at ? M.localDay(t.due_at) : null, null, !!t.completed_at)).join(''), 'No tasks linked to this project yet.',
        `<form class="pj-linked-form" data-pjform="task"><input class="field" name="title" maxlength="180" placeholder="Add a task…" aria-label="New task" autocomplete="off"><input class="field field-date" type="date" name="day" aria-label="Due date (optional)"><button class="btn btn-sm" type="submit">Add</button></form>`);
    }
    if (block.type === 'milestones') {
      const done = page.milestones.filter(m => m.completed_at).length;
      return card('Milestones', ic('flag'), page.milestones.length ? `${done} of ${page.milestones.length} reached` : '',
        page.milestones.map(m => row('milestone', m, M.localDay(m.due_at), null, !!m.completed_at)).join(''), 'No milestones yet.',
        `<form class="pj-linked-form" data-pjform="milestone"><input class="field" name="title" maxlength="180" placeholder="Add a milestone…" aria-label="New milestone" autocomplete="off"><input class="field field-date" type="date" name="day" aria-label="Milestone date" required><button class="btn btn-sm" type="submit">Add</button></form>`);
    }
    if (block.type === 'schedule') {
      return card('Schedule', H.icon('calendar'), page.events.length ? `${page.events.length} on the calendar` : '',
        page.events.map(e => row('schedule', e, M.localDay(e.starts_at), M.localTime(e.starts_at), false)).join(''), 'Nothing scheduled for this project yet.',
        `<form class="pj-linked-form" data-pjform="schedule"><input class="field" name="title" maxlength="180" placeholder="Add a schedule…" aria-label="New schedule" autocomplete="off"><input class="field field-date" type="date" name="day" aria-label="Date" required><input class="field field-time" type="time" name="time" value="09:00" aria-label="Start time" required><button class="btn btn-sm" type="submit">Add</button></form>`);
    }
    const tasksDone = page.tasks.filter(t => t.completed_at).length;
    const milestonesDone = page.milestones.filter(m => m.completed_at).length;
    const start = today();
    const next = P.entries.find(e => e.projectId === page.id && e.day >= start && !e.done);
    const total = page.tasks.length + page.milestones.length;
    const pct = total ? Math.round((tasksDone + milestonesDone) / total * 100) : 0;
    const stat = (label, value) => `<div class="pj-stat"><span>${label}</span>${value}</div>`;
    return `<section class="pj-card pj-related" aria-label="Project data">
      ${stat('Status', `<strong>${esc((STATUSES.find(([key]) => key === page.pstatus) || STATUSES[1])[1])}</strong>`)}
      ${stat('Deadline', page.targetDate ? `<button class="pj-date" type="button" data-pj="open-cal" data-day="${page.targetDate}" data-ref="deadline:${esc(page.id)}" title="Open in Calendar">${H.icon('calendar')}${esc(dayLabel(page.targetDate))}</button>` : '<strong class="muted">Not set</strong>')}
      ${stat('Tasks', `<strong>${tasksDone}/${page.tasks.length}</strong>`)}
      ${stat('Milestones', `<strong>${milestonesDone}/${page.milestones.length}</strong>`)}
      ${stat('Next up', next ? `<button class="pj-date" type="button" data-pj="open-cal" data-day="${next.day}" data-ref="${esc(next.id)}" title="Open in Calendar">${H.icon('calendar')}${esc(dayLabel(next.day))} · ${esc(next.title)}</button>` : '<strong class="muted">Nothing scheduled</strong>')}
      <div class="progress pj-progress" aria-label="${pct}% of tasks and milestones done"><div class="progress-track"><div class="progress-fill" data-pj-w="${pct}"></div></div><span>${pct}%</span></div>
    </section>`;
  }
  function contentHtml(page, block, numbers) {
    const data = block.data || {};
    switch (block.type) {
      case 'paragraph': return textArea(block, "Type '/' for blocks");
      case 'h1': return textArea(block, 'Heading 1');
      case 'h2': return textArea(block, 'Heading 2');
      case 'h3': return textArea(block, 'Heading 3');
      case 'bullet': case 'numbered': case 'todo': {
        const checks = M.checksOf(block); const start = numbers[block.id] || 1;
        return `<div class="pj-items">${M.linesOf(block).map((line, i) => {
          const lead = block.type === 'bullet' ? '<span class="pj-mark" aria-hidden="true">•</span>'
            : block.type === 'numbered' ? `<span class="pj-mark num" aria-hidden="true">${start + i}.</span>`
            : `<input type="checkbox" class="check pj-check" data-pj-check data-line="${i}" aria-label="Done" ${checks[i] ? 'checked' : ''}>`;
          return `<div class="pj-item${block.type === 'todo' && checks[i] ? ' checked' : ''}" data-item="${i}">${lead}${textArea(block, block.type === 'todo' ? 'To-do' : 'List item', '', `data-line="${i}"`, line)}</div>`;
        }).join('')}</div>`;
      }
      case 'toggle': return `<button class="pj-twist${data.open ? ' open' : ''}" type="button" data-pj="toggle-open" aria-expanded="${!!data.open}" aria-label="${data.open ? 'Collapse' : 'Expand'} details">${ic('twist')}</button>
        <div class="pj-stack">${textArea(block, 'Toggle')}${data.open ? area(`class="pj-sub" data-pj-data="body" maxlength="${M.LIMITS.text}" placeholder="Details shown when open…" aria-label="Toggle details"`, data.body || '') : ''}</div>`;
      case 'quote': return textArea(block, 'Quote');
      case 'callout': return `<button class="pj-callout-icon" type="button" data-pj="callout-icon" aria-label="Change icon" title="Change icon">${esc(data.icon || M.CALLOUT_ICONS[0])}</button>${textArea(block, 'Callout')}`;
      case 'divider': return '<hr class="pj-rule">';
      case 'code': return area(`class="pj-text pj-code" data-pj-text maxlength="${M.LIMITS.text}" placeholder="Code" aria-label="Code" spellcheck="false" autocapitalize="off"`, block.text);
      case 'bookmark': return `<div class="pj-card pj-bm"><span class="pj-bm-ic">${ic('link')}</span>
        <div class="pj-stack">${textArea(block, 'Link title')}<input class="pj-url" type="url" data-pj-data="url" value="${esc(data.url || '')}" maxlength="2000" placeholder="https://…" aria-label="Link address" spellcheck="false"></div>
        <button class="btn btn-sm btn-ghost" type="button" data-pj="open-link" ${/^https?:\/\/\S+$/i.test(data.url || '') ? '' : 'disabled'}>Open</button></div>`;
      case 'image': {
        const src = data.imageName ? page.images[data.imageName] : null;
        if (!src) return `<button class="pj-card pj-pick" type="button" data-pj="pick-image">${ic('image')}<span>${data.imageName ? 'Image unavailable — choose another' : 'Choose an image'}</span></button>`;
        return `<figure class="pj-figure"><img src="${esc(src)}" alt="${esc(block.text || 'Project image')}">${textArea(block, 'Add a caption…', 'pj-caption')}</figure>`;
      }
      case 'table': {
        const rows = Array.isArray(data.rows) && data.rows.length ? data.rows : [['']];
        return `<div class="pj-table-wrap"><table class="pj-table"><tbody>${rows.map((cells, r) => `<tr${r === 0 ? ' class="head"' : ''}>${(Array.isArray(cells) ? cells : ['']).map((cell, c) => `<td>${area(`data-pj-cell data-r="${r}" data-c="${c}" maxlength="2000" aria-label="Row ${r + 1}, column ${c + 1}"`, cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
          <div class="pj-table-tools">${[['row+', '+ Row'], ['col+', '+ Column'], ['row-', '− Row'], ['col-', '− Column']].map(([op, label]) => `<button class="pj-chip" type="button" data-pj="table-op" data-op="${op}">${label}</button>`).join('')}</div>`;
      }
      case 'schedule': case 'tasks': case 'milestones': case 'related': return linkedHtml(page, block);
      default: return `<div class="pj-card pj-unknown">This block type (“${esc(block.type)}”) is not supported in this version. It is kept as it is.</div>`;
    }
  }
  function blockHtml(page, block, numbers) {
    const known = !!M.TYPE[block.type];
    const hasText = known && M.isText(block.type) && !(block.type === 'image' && !(block.data.imageName && page.images[block.data.imageName]));
    return `<div class="pj-block t-${known ? block.type : 'unknown'}" role="listitem" data-block="${esc(block.id)}"${hasText ? '' : ' tabindex="-1"'}>
      <div class="pj-gutter">
        <button class="pj-grip" type="button" tabindex="-1" data-pj="block-add" aria-label="Insert a block below" title="Insert below">${H.icon('plus')}</button>
        <button class="pj-grip pj-handle" type="button" tabindex="-1" draggable="true" data-pj="block-menu" aria-haspopup="menu" aria-label="Block actions. Drag to move" title="Drag to move · click for actions">${ic('grip')}</button>
      </div>
      <div class="pj-content">${contentHtml(page, block, numbers)}</div>
    </div>`;
  }
  function blocksHtml(page) {
    if (!page.blocks.length) return '<button class="pj-ghost" type="button" data-pj="add-end">Type \'/\' for blocks</button>';
    const numbers = M.numbering(page.blocks);
    return page.blocks.map(block => blockHtml(page, block, numbers)).join('');
  }
  function pageHtml(page) {
    if (page.status === 'loading') return '<div class="pj-state" role="status"><span class="spinner" aria-hidden="true"></span><p>Opening project…</p></div>';
    if (page.status === 'error') return `<div class="pj-state error" role="alert"><p>${esc(page.error)}</p><div class="pj-state-actions"><button class="btn btn-sm" type="button" data-pj="retry-page">Try again</button><button class="btn btn-sm btn-ghost" type="button" data-pj="tab-close" data-id="${esc(page.id)}">Close tab</button></div></div>`;
    const cover = coverOf(page);
    const chips = [];
    if (!page.icon) chips.push(`<button class="pj-add-chip" type="button" data-pj="icon-open">${ic('smile')}Add icon</button>`);
    if (!cover) chips.push(`<button class="pj-add-chip" type="button" data-pj="cover-add">${ic('image')}Add cover</button>`);
    return `<article class="pj-page${cover ? '' : ' no-cover'}" data-page="${esc(page.id)}">
      ${coverHtml(page, cover)}
      <div class="pj-column">
        <header class="pj-head">
          ${page.icon ? `<button class="pj-icon" type="button" data-pj="icon-open" aria-haspopup="dialog" aria-label="Change page icon" title="Change icon">${esc(page.icon)}</button>` : ''}
          ${chips.length ? `<div class="pj-add-row">${chips.join('')}</div>` : ''}
          ${area(`class="pj-title" data-pj-title maxlength="${M.LIMITS.name}" placeholder="Untitled" aria-label="Project title"`, page.name)}
          <div class="pj-props">
            <div class="pj-prop-row"><span class="pj-prop-label">Status</span><label class="pj-prop"><select data-pj-prop="pstatus" aria-label="Status">${STATUSES.map(([key, label]) => `<option value="${key}"${page.pstatus === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div>
            <div class="pj-prop-row"><span class="pj-prop-label">Deadline</span><label class="pj-prop"><input type="date" data-pj-prop="targetDate" value="${esc(page.targetDate)}" aria-label="Deadline"></label><span class="pj-deadline">${deadlineHtml(page)}</span></div>
            <span class="pj-save" role="status" aria-live="polite"></span>
          </div>
          ${area(`class="pj-desc" data-pj-desc maxlength="${M.LIMITS.description}" placeholder="Add a description…" aria-label="Project description"`, page.description)}
        </header>
        <div class="pj-blocks" role="list" aria-label="Page content">${blocksHtml(page)}</div>
        <div class="pj-tail" data-pj="tail" aria-hidden="true"></div>
      </div>
    </article>`;
  }
  function defaultGradient(id) { let n = 0; for (const ch of String(id)) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return GRADIENTS[n % GRADIENTS.length][0]; }
  /* null cover = a built-in gradient picked from the page id; 'none' = no cover; 'g:<name>' = a chosen gradient; otherwise an uploaded image. */
  function coverOf(page) {
    if (page.cover === 'none') return null;
    if (page.cover && page.cover.startsWith('g:') && GRADIENTS.some(([key]) => key === page.cover.slice(2))) return { kind: 'gradient', name: page.cover.slice(2) };
    if (page.cover && !page.cover.startsWith('g:') && page.coverImage) return { kind: 'image', src: page.coverImage };
    return { kind: 'gradient', name: defaultGradient(page.id) };
  }
  function coverHtml(page, cover) {
    if (!cover) return '';
    const repo = P.repo && P.repo.id === page.id;
    const tools = repo
      ? '<span class="pj-cover-hint">Drag the image to reposition</span><button class="pj-cover-btn" type="button" data-pj="repo-save">Save position</button><button class="pj-cover-btn ghost" type="button" data-pj="repo-cancel">Cancel</button>'
      : `<button class="pj-cover-btn" type="button" data-pj="cover-menu" aria-haspopup="menu">Change cover</button>${cover.kind === 'image' ? '<button class="pj-cover-btn" type="button" data-pj="repo-start">Reposition</button>' : ''}`;
    const art = cover.kind === 'image' ? `<img class="pj-cover-img" src="${esc(cover.src)}" alt="" draggable="false" data-pj-pos="${clampN(Number(page.coverPos) || 0, 0, 100)}">` : '';
    return `<div class="pj-cover ${cover.kind === 'image' ? 'photo' : `g-${esc(cover.name)}`}${repo ? ' repositioning' : ''}" role="img" aria-label="Page cover">${art}<div class="pj-cover-tools">${tools}</div></div>`;
  }
  const deadlineHtml = page => (page.targetDate ? `<button class="pj-date" type="button" data-pj="open-cal" data-day="${page.targetDate}" data-ref="deadline:${esc(page.id)}">${H.icon('calendar')}Open in Calendar</button>` : '');
  function innerHtml() {
    const id = P.tabs.active;
    return `<div class="pj-tabbar">${tabsHtml()}</div><div class="pj-body">${id ? pageHtml(ensurePage(id)) : overviewHtml()}</div>`;
  }
  function render() { return `<div class="pj-root">${innerHtml()}</div>`; }
  function fit(el) { if (!el.scrollHeight) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  function dress(root) {
    $$('textarea', root).forEach(fit);
    $$('[data-pj-w]', root).forEach(el => { el.style.width = `${el.dataset.pjW}%`; });
    $$('[data-pj-pos]', root).forEach(el => { el.style.objectPosition = `50% ${el.dataset.pjPos}%`; });
    $$('.proj-tile.has-img[data-pj-tile]', root).forEach(el => {
      const p = projectOf(el.dataset.pjTile); if (!p || !p.cover_image) return;
      el.style.backgroundImage = `url("${p.cover_image}")`; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = `50% ${Number(p.cover_pos) || 50}%`;
    });
  }
  function mount() {
    const root = $('.pj-root'); if (!root) return;
    dress(root);
    const page = activePage();
    if (page) paintSave(page);
    const active = $('.pj-tabs .active', root); if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (P.pendingFocus === 'title') { const title = $('[data-pj-title]', root); if (title) { title.focus(); title.select(); P.pendingFocus = null; } }
  }
  function paint() { const root = $('.pj-root'); if (!root) return; closeMenu(); closePop(); root.innerHTML = innerHtml(); P.shown = P.tabs.active; mount(); }
  function paintBlocks(page) { const box = $('.pj-blocks'); if (!box || P.tabs.active !== page.id) return; box.innerHTML = blocksHtml(page); dress(box); }
  function paintBlock(page, id) {
    const el = blockEl(id); const block = page.blocks.find(b => b.id === id);
    if (!el || !block) return;
    el.outerHTML = blockHtml(page, block, M.numbering(page.blocks));
    dress(blockEl(id));
  }
  function paintLinked(page, types = LINKED) {
    if (P.tabs.active !== page.id || !inView()) return;
    const focus = captureFocus();
    for (const block of page.blocks) if (types.includes(block.type)) paintBlock(page, block.id);
    const deadline = $('.pj-deadline'); if (deadline) deadline.innerHTML = deadlineHtml(page);
    restoreFocus(focus);
  }
  function paintSave(page, saving = false) {
    const tab = $(`.pj-tab[data-tab="${CSS.escape(page.id)}"]`);
    if (tab) tab.classList.toggle('dirty', page.dirty);
    if (P.tabs.active !== page.id) return;
    const el = $('.pj-save'); if (!el) return;
    const state = saving || (page.pending && !page.saveError) ? 'saving' : page.saveError ? 'error' : page.dirty ? 'unsaved' : 'saved';
    if (el.dataset.state === state) return;
    el.dataset.state = state;
    el.title = state === 'error' ? page.saveError : '';
    el.innerHTML = state === 'saving' ? 'Saving…' : state === 'unsaved' ? 'Unsaved changes' : state === 'saved' ? 'Saved'
      : 'Not saved <button class="link-btn" type="button" data-pj="save-now">Retry</button>';
  }
  const blockEl = id => $(`.pj-blocks [data-block="${CSS.escape(id)}"]`);
  function focusBlock(id, offset = null, atEnd = false, line = null) {
    const el = id ? blockEl(id) : null; if (!el) return;
    const fields = $$('[data-pj-text]', el);
    const field = line != null ? (fields[line] || fields[fields.length - 1]) : (atEnd ? fields[fields.length - 1] : fields[0]);
    if (field) { field.focus(); const at = offset == null ? (atEnd ? field.value.length : 0) : Math.min(offset, field.value.length); field.setSelectionRange(at, at); }
    else el.focus();
    el.scrollIntoView({ block: 'nearest' });
  }
  function captureFocus() {
    const a = document.activeElement;
    if (!a || !a.closest || !a.closest('.pj-root')) return null;
    let sel = null; try { sel = typeof a.selectionStart === 'number' ? a.selectionStart : null; } catch { /* not a text field */ }
    if (a.matches('[data-pj-title]')) return { q: '[data-pj-title]', sel };
    if (a.matches('[data-pj-desc]')) return { q: '[data-pj-desc]', sel };
    if (a.matches('[data-pj-prop]')) return { q: `[data-pj-prop="${a.dataset.pjProp}"]` };
    const block = a.closest('[data-block]'); if (!block) return null;
    const base = `.pj-blocks [data-block="${CSS.escape(block.dataset.block)}"]`;
    if (a === block) return { q: base };
    if (a.matches('[data-pj-text]')) return { q: `${base} [data-pj-text]${a.dataset.line != null ? `[data-line="${a.dataset.line}"]` : ''}`, sel };
    if (a.matches('[data-pj-cell]')) return { q: `${base} [data-pj-cell][data-r="${a.dataset.r}"][data-c="${a.dataset.c}"]`, sel };
    if (a.dataset.pjData) return { q: `${base} [data-pj-data="${a.dataset.pjData}"]`, sel };
    if (a.name) return { q: `${base} [name="${a.name}"]`, sel };
    return { q: base };
  }
  function restoreFocus(focus) {
    if (!focus) return;
    const el = $(focus.q); if (!el) return;
    el.focus();
    if (focus.sel != null && el.setSelectionRange) { try { el.setSelectionRange(focus.sel, focus.sel); } catch { /* not a text field */ } }
  }

  // ───────────────────────── page look: cover, icon
  function setLook(page, patch) {
    Object.assign(page, patch);
    const entry = projectOf(page.id); if (entry) entry.icon = page.icon;
    touch(page);
    closePop();
    paint();
  }
  async function pickCover(page) {
    try {
      const picked = await H.api(() => window.account.pickImage());
      if (!picked) return;
      page.images[picked.imageName] = picked.image;
      setLook(page, { cover: picked.imageName, coverImage: picked.image, coverPos: 50 });
    } catch { /* toast shown */ }
  }
  function openCoverMenu(page, anchor) {
    const cover = coverOf(page);
    const items = [{ label: 'Upload an image…', section: 'Cover', run: () => pickCover(page) }];
    if (cover && cover.kind === 'image') items.push({ label: 'Reposition', section: 'Cover', run: () => startRepo(page) });
    items.push({ label: 'Remove cover', section: 'Cover', danger: true, run: () => setLook(page, { cover: 'none', coverImage: null }) });
    for (const [key, label] of GRADIENTS) items.push({ label, section: 'Gradients', run: () => setLook(page, { cover: `g:${key}`, coverImage: null }) });
    openMenu({ mode: 'block', blockId: null, label: 'Cover options', items }, anchor);
  }
  function popEl() {
    let el = $('#pj-pop');
    if (!el) { el = document.createElement('div'); el.id = 'pj-pop'; el.className = 'pj-pop'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Choose a page icon'); el.hidden = true; document.body.append(el); }
    return el;
  }
  function closePop(refocus = false) {
    if (!P.pop) return;
    P.pop = false;
    const el = $('#pj-pop'); if (el) el.hidden = true;
    if (refocus) { const t = $('[data-pj="icon-open"]'); if (t) t.focus(); }
  }
  function openIconPop(page, anchor) {
    closeMenu();
    const el = popEl();
    el.innerHTML = `<div class="pj-pop-head"><strong>Page icon</strong>${page.icon ? '<button class="pj-pop-clear" type="button" data-pj="icon-clear">Remove</button>' : ''}</div>
      <div class="pj-emoji-grid">${EMOJI.map(e => `<button class="pj-emoji" type="button" data-pj="icon-pick" data-emoji="${esc(e)}" aria-label="Use ${esc(e)}">${esc(e)}</button>`).join('')}</div>`;
    el.hidden = false; P.pop = true;
    const rect = anchor.getBoundingClientRect();
    el.style.left = `${clampN(rect.left, 10, window.innerWidth - el.offsetWidth - 10)}px`;
    el.style.top = `${clampN(rect.bottom + 8, 10, window.innerHeight - el.offsetHeight - 10)}px`;
    const first = $('.pj-emoji', el); if (first) first.focus();
  }
  function startRepo(page) { P.repo = { id: page.id, y: Number(page.coverPos) || 0, drag: null }; paint(); }
  function endRepo(save) {
    const repo = P.repo; if (!repo) return;
    P.repo = null;
    const page = P.pages.get(repo.id);
    if (save && page && Math.round(repo.y) !== page.coverPos) { page.coverPos = Math.round(repo.y); touch(page); }
    if (inView()) paint();
  }
  function repoDown(event) {
    const img = P.repo && event.target.closest && event.target.closest('.pj-cover.repositioning .pj-cover-img'); if (!img) return;
    const box = img.parentElement; const w = box.clientWidth, h = box.clientHeight;
    const nw = img.naturalWidth || w, nh = img.naturalHeight || h;
    const overflow = Math.max(1, nh * Math.max(w / nw, h / nh) - h);
    P.repo.drag = { startY: event.clientY, y: P.repo.y, overflow, img };
    event.preventDefault();
    if (img.setPointerCapture) { try { img.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ } }
  }
  function repoMove(event) {
    const d = P.repo && P.repo.drag; if (!d) return;
    P.repo.y = clampN(d.y - (event.clientY - d.startY) / d.overflow * 100, 0, 100);
    d.img.style.objectPosition = `50% ${P.repo.y}%`;
  }
  function repoUp() { if (P.repo) P.repo.drag = null; }

  // ───────────────────────── block editing
  const indexOf = (page, id) => page.blocks.findIndex(b => b.id === id);
  function structural(page, blocks, focusId, offset = null, atEnd = false, line = null) {
    change(page, null, () => { page.blocks = blocks; });
    paintBlocks(page);
    focusBlock(focusId, offset, atEnd, line);
  }
  function insertAfter(page, index, type = 'paragraph', text = '') {
    const block = M.createBlock(type, text);
    structural(page, M.insertAt(page.blocks, index + 1, block), block.id, text.length);
    return block;
  }
  function removeBlock(page, index) {
    const neighbour = page.blocks[index - 1] || page.blocks[index + 1];
    structural(page, M.removeAt(page.blocks, index), neighbour ? neighbour.id : null, null, true);
    if (!neighbour) { const title = $('[data-pj-title]'); if (title) title.focus(); }
  }
  function moveBlock(page, index, to) {
    const id = page.blocks[index].id;
    const next = M.move(page.blocks, index, to);
    if (next === page.blocks) return;
    const focus = captureFocus();
    change(page, null, () => { page.blocks = next; });
    paintBlocks(page);
    if (focus) restoreFocus(focus); else focusBlock(id);
  }
  function setType(page, index, type, text) {
    let blocks = M.changeType(page.blocks, index, type);
    if (text !== undefined) { blocks = blocks.slice(); blocks[index] = { ...blocks[index], text }; }
    let focusId = blocks[index].id;
    // A block with nothing to type in gets a paragraph after it, so writing can continue.
    if (!M.isText(type) && index === blocks.length - 1) { const after = M.createBlock('paragraph'); blocks = M.insertAt(blocks, index + 1, after); focusId = after.id; }
    else if (!M.isText(type)) focusId = blocks[index + 1].id;
    structural(page, blocks, focusId, null, true);
  }

  // ───────────────────────── menus (slash insert and block actions)
  function menuEl() {
    let el = $('#pj-menu');
    if (!el) { el = document.createElement('div'); el.id = 'pj-menu'; el.className = 'menu pj-menu'; el.setAttribute('role', 'menu'); el.tabIndex = -1; el.hidden = true; document.body.append(el); }
    return el;
  }
  function closeMenu(refocus = false) {
    const menu = P.menu; if (!menu) return;
    P.menu = null;
    const el = $('#pj-menu'); if (el) el.hidden = true;
    if (refocus) focusBlock(menu.blockId, null, true);
  }
  function paintMenu() {
    const menu = P.menu; const el = menuEl();
    let last = null;
    el.setAttribute('aria-label', menu.label || (menu.mode === 'slash' ? 'Insert block' : 'Block actions'));
    el.innerHTML = menu.items.length ? menu.items.map((item, i) => {
      const head = item.section && item.section !== last ? `<div class="pj-menu-label">${esc(item.section)}</div>` : '';
      last = item.section || last;
      return `${head}<button class="menu-item${i === menu.index ? ' active' : ''}${item.danger ? ' danger' : ''}" type="button" role="menuitem" tabindex="-1" data-menu="${i}"><span>${esc(item.label)}</span>${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</button>`;
    }).join('') : '<p class="pj-menu-empty">No matching blocks</p>';
    const active = $('.menu-item.active', el); if (active) active.scrollIntoView({ block: 'nearest' });
  }
  function placeMenu(el, anchor) {
    const rect = anchor.getBoundingClientRect();
    const height = Math.min(el.offsetHeight, 320);
    const below = rect.bottom + 6 + height <= window.innerHeight - 8;
    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${below ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)}px`;
  }
  function openMenu(menu, anchor) {
    P.menu = { index: 0, ...menu, anchor };
    const el = menuEl();
    paintMenu();
    el.hidden = false;
    placeMenu(el, anchor);
    if (menu.mode === 'block') el.focus();
  }
  /* A scroll moves the menu with its block instead of closing it: focusing a new block or typing near the bottom
     scrolls the page by itself, and that scroll event arrives a frame after the menu opened. The menu closes only
     when its block has left the visible part of the page. */
  function followMenu(event) {
    const menu = P.menu; if (!menu || event.target.id === 'pj-menu') return;
    const anchor = menu.anchor; const el = $('#pj-menu');
    const box = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
    const view = ($('.main-panel') || document.documentElement).getBoundingClientRect();
    if (!el || !box || box.bottom < view.top || box.top > view.bottom) { closeMenu(); return; }
    placeMenu(el, anchor);
  }
  function typeItems(page, id, query, section) {
    return M.searchTypes(query).map(t => ({ label: t.label, hint: t.hint, section, run: () => { const index = indexOf(page, id); if (index >= 0) setType(page, index, t.type, section ? undefined : ''); } }));
  }
  function openSlash(page, id, field) {
    const items = typeItems(page, id, field.value.slice(1), null);
    if (P.menu && P.menu.mode === 'slash' && P.menu.blockId === id) { P.menu.items = items; P.menu.index = 0; P.menu.anchor = field; paintMenu(); return; }
    openMenu({ mode: 'slash', blockId: id, items }, field);
  }
  function openBlockMenu(page, id, anchor) {
    const at = () => indexOf(page, id);
    openMenu({ mode: 'block', blockId: id, items: [
      { label: 'Duplicate', hint: 'Ctrl+D', run: () => { const i = at(); const blocks = M.duplicate(page.blocks, i); structural(page, blocks, blocks[i + 1].id, null, true); } },
      { label: 'Move up', hint: 'Alt+Shift+↑', run: () => { moveBlock(page, at(), at() - 1); focusBlock(id, null, true); } },
      { label: 'Move down', hint: 'Alt+Shift+↓', run: () => { moveBlock(page, at(), at() + 1); focusBlock(id, null, true); } },
      { label: 'Delete', danger: true, run: () => removeBlock(page, at()) },
      ...typeItems(page, id, '', 'Turn into')
    ] }, anchor);
  }
  function chooseMenu(index) {
    const menu = P.menu; if (!menu) return;
    const item = menu.items[index];
    closeMenu();
    if (item) item.run();
  }
  function menuKey(event) {
    const menu = P.menu;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(menu.mode === 'block'); return true; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.items.length) { menu.index = (menu.index + (event.key === 'ArrowDown' ? 1 : -1) + menu.items.length) % menu.items.length; paintMenu(); }
      return true;
    }
    if (event.key === 'Enter' || (event.key === 'Tab' && menu.mode === 'slash')) {
      event.preventDefault();
      if (menu.items.length) chooseMenu(menu.index); else closeMenu();
      return true;
    }
    if (menu.mode === 'block') { if (event.key === 'Tab') closeMenu(true); event.preventDefault(); return true; }
    return false;
  }

  // ───────────────────────── linked records (tasks, milestones, schedules) — stored once, shown here and in Calendar
  async function refreshLinked(page) {
    const data = await api.projectData(page.id);
    page.tasks = data.tasks; page.milestones = data.milestones; page.events = data.events;
    const others = list => list.filter(record => record.project_id !== page.id);
    P.linked = { tasks: [...others(P.linked.tasks), ...data.tasks], events: [...others(P.linked.events), ...data.events], milestones: [...others(P.linked.milestones), ...data.milestones] };
    rebuildEntries();
    paintLinked(page);
  }
  async function submitLinked(page, form) {
    const kind = form.dataset.pjform;
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    const day = String(data.get('day') || '');
    if (!title) { form.elements.title.focus(); return; }
    if (kind !== 'task' && !day) { form.elements.day.focus(); return; }
    const blockId = form.closest('[data-block]').dataset.block;
    try {
      if (kind === 'task') await H.api(() => api.createTask(title, day ? M.toStamp(day) : null, page.id));
      else if (kind === 'milestone') await H.api(() => api.createMilestone(title, M.toStamp(day), page.id));
      else {
        const start = M.toStamp(day, String(data.get('time') || '09:00'));
        await H.api(() => api.createEvent(title, start, new Date(Date.parse(start) + 3600000).toISOString(), page.id));
      }
      await refreshLinked(page);
      const input = $(`.pj-blocks [data-block="${CSS.escape(blockId)}"] [name="title"]`); if (input) input.focus();
    } catch { /* toast shown */ }
  }
  async function deleteLinked(page, kind, id) {
    const label = { task: 'task', milestone: 'milestone', schedule: 'schedule' }[kind];
    if (!(await H.confirmDialog({ title: `Delete this ${label}?`, text: `It is removed from this project and from Calendar.` }))) return;
    try {
      if (kind === 'task') await H.api(() => api.deleteTask(id, 'delete-task-schedules'));
      else if (kind === 'milestone') await H.api(() => api.deleteMilestone(id));
      else await H.api(() => api.deleteEvent(id));
      await refreshLinked(page);
    } catch { /* toast shown */ }
  }

  // ───────────────────────── events
  async function onClick(event) {
    const item = event.target.closest('#pj-menu [data-menu]');
    if (item) { event.preventDefault(); chooseMenu(Number(item.dataset.menu)); return; }
    if (P.menu && !event.target.closest('#pj-menu')) closeMenu();
    if (P.pop && !event.target.closest('#pj-pop') && !event.target.closest('[data-pj="icon-open"]')) closePop();
    const lowerEdge = event.target.closest && event.target.closest('.pj-block');
    if (lowerEdge && event.target === lowerEdge && event.clientY > lowerEdge.getBoundingClientRect().bottom - 14) {
      const pg = activePage(); const at = pg ? indexOf(pg, lowerEdge.dataset.block) : -1;
      if (pg && at >= 0) { insertAfter(pg, at); return; }
    }
    const el = event.target.closest('[data-pj]');
    if (!el || !(el.closest('.pj-root') || el.closest('#pj-pop'))) return;
    const page = activePage();
    const holder = el.closest('[data-block]');
    const id = holder ? holder.dataset.block : null;
    const index = page && id ? indexOf(page, id) : -1;
    const block = index >= 0 ? page.blocks[index] : null;
    switch (el.dataset.pj) {
      case 'cover-menu': if (page) openCoverMenu(page, el); break;
      case 'cover-add': if (page) setLook(page, { cover: null }); break;
      case 'repo-start': if (page) startRepo(page); break;
      case 'repo-save': endRepo(true); break;
      case 'repo-cancel': endRepo(false); break;
      case 'icon-open': if (page) { if (P.pop) closePop(); else openIconPop(page, el); } break;
      case 'icon-pick': if (page) setLook(page, { icon: el.dataset.emoji || '' }); break;
      case 'icon-clear': if (page) setLook(page, { icon: '' }); break;
      case 'tab-home': activate(null); break;
      case 'tab': activate(el.dataset.id); break;
      case 'tab-close': await closeTab(el.dataset.id); break;
      case 'new-project': await createProject('Untitled', true); break;
      case 'open': open(el.dataset.id); break;
      case 'delete-project': await deleteProject(el.dataset.id); break;
      case 'reload': await load(P.user); paint(); break;
      case 'retry-page': P.pages.delete(P.tabs.active); paint(); break;
      case 'save-now': if (page) save(page); break;
      case 'open-cal': flush(); H.openCalendar(el.dataset.day, el.dataset.ref); break;
      case 'open-link': if (block && window.chatData) H.api(() => window.chatData.openExternal(block.data.url)).catch(() => {}); break;
      case 'add-end': if (page) insertAfter(page, page.blocks.length - 1); break;
      case 'tail': if (page) {
        const last = page.blocks[page.blocks.length - 1];
        if (last && last.type === 'paragraph' && !last.text) focusBlock(last.id, 0);
        else insertAfter(page, page.blocks.length - 1);
        break;
      }
      case 'block-add': if (block) { const created = insertAfter(page, index, 'paragraph', '/'); const field = $('[data-pj-text]', blockEl(created.id)); if (field) openSlash(page, created.id, field); } break;
      case 'block-menu': if (block) openBlockMenu(page, id, el); break;
      case 'toggle-open': if (block) { change(page, null, () => { block.data = { ...block.data, open: !block.data.open }; }); paintBlock(page, id); focusBlock(id, null, true); } break;
      case 'callout-icon': if (block) {
        const icons = M.CALLOUT_ICONS; const next = icons[(icons.indexOf(block.data.icon) + 1) % icons.length];
        change(page, null, () => { block.data = { ...block.data, icon: next }; });
        el.textContent = next;
        break;
      }
      case 'pick-image': if (block) {
        try {
          const picked = await H.api(() => window.account.pickImage());
          if (!picked) break;
          page.images[picked.imageName] = picked.image;
          change(page, null, () => { block.data = { ...block.data, imageName: picked.imageName }; });
          paintBlock(page, id); focusBlock(id);
        } catch { /* toast shown */ }
        break;
      }
      case 'table-op': if (block) {
        const rows = (Array.isArray(block.data.rows) && block.data.rows.length ? block.data.rows : [['']]).map(r => r.slice());
        const cols = rows[0].length; const op = el.dataset.op;
        if (op === 'row+' && rows.length < 40) rows.push(Array(cols).fill(''));
        else if (op === 'col+' && cols < 8) rows.forEach(r => r.push(''));
        else if (op === 'row-' && rows.length > 1) rows.pop();
        else if (op === 'col-' && cols > 1) rows.forEach(r => r.pop());
        else break;
        change(page, null, () => { block.data = { ...block.data, rows }; });
        paintBlock(page, id);
        const again = $(`[data-pj="table-op"][data-op="${CSS.escape(op)}"]`, blockEl(id)); if (again) again.focus();
        break;
      }
      case 'del-linked': if (page) await deleteLinked(page, el.dataset.kind, el.dataset.id); break;
      default: break;
    }
  }
  function onInput(event) {
    const t = event.target;
    if (!t.closest || !t.closest('.pj-root')) return;
    const page = activePage(); if (!page || page.status !== 'ready') return;
    if (t.matches('[data-pj-title]')) {
      if (t.value.includes('\n')) t.value = t.value.replace(/\n+/g, ' ');
      change(page, 'title', () => { page.name = t.value; });
      fit(t);
      const label = $(`.pj-tab[data-tab="${CSS.escape(page.id)}"] .proj-tab-label`); if (label) label.textContent = nameOf(page.id);
      return;
    }
    if (t.matches('[data-pj-desc]')) { change(page, 'desc', () => { page.description = t.value; }); fit(t); return; }
    const holder = t.closest('[data-block]'); if (!holder) return;
    const id = holder.dataset.block; const index = indexOf(page, id); if (index < 0) return;
    const block = page.blocks[index];
    if (t.matches('[data-pj-text]') && t.dataset.line != null) {
      change(page, `${id}:text`, () => { block.text = $$('[data-pj-text]', holder).map(f => f.value.replace(/\n/g, ' ')).join('\n'); });
      fit(t);
      return;
    }
    if (t.matches('[data-pj-text]')) {
      change(page, `${id}:text`, () => { block.text = t.value; });
      fit(t);
      const typed = !event.inputType || event.inputType.startsWith('insert');
      const hit = typed && block.type === 'paragraph' ? M.shortcut(t.value) : null;
      if (hit) { closeMenu(); setType(page, index, hit.type, hit.text); if (M.isText(hit.type)) focusBlock(id, 0); return; }
      if (block.type !== 'code' && /^\/[^\s/]*$/.test(t.value)) openSlash(page, id, t);
      else if (P.menu && P.menu.mode === 'slash') closeMenu();
      return;
    }
    if (t.matches('[data-pj-cell]')) {
      const r = Number(t.dataset.r), c = Number(t.dataset.c);
      change(page, `${id}:cell:${r}:${c}`, () => { const rows = block.data.rows.map(row => row.slice()); rows[r][c] = t.value; block.data = { ...block.data, rows }; });
      $$('textarea', t.closest('tr')).forEach(fit);
      return;
    }
    if (t.dataset.pjData) {
      const key = t.dataset.pjData;
      change(page, `${id}:${key}`, () => { block.data = { ...block.data, [key]: t.value }; });
      if (t.tagName === 'TEXTAREA') fit(t);
      if (key === 'url') { const button = $('[data-pj="open-link"]', holder); if (button) button.disabled = !/^https?:\/\/\S+$/i.test(t.value); }
    }
  }
  async function onChange(event) {
    const t = event.target;
    if (!t.closest || !t.closest('.pj-root')) return;
    const page = activePage(); if (!page || page.status !== 'ready') return;
    if (t.matches('[data-pj-prop]')) {
      const key = t.dataset.pjProp;
      change(page, null, () => { page[key] = t.value; });
      page.metaChanged = true;
      paintLinked(page, ['related']);
      return;
    }
    if (t.matches('[data-pj-check]')) {
      const holder = t.closest('[data-block]'); const block = page.blocks[indexOf(page, holder.dataset.block)];
      if (!block) return;
      const line = Number(t.dataset.line) || 0;
      const checks = M.checksOf(block); checks[line] = t.checked;
      change(page, null, () => { block.data = { ...block.data, checks, checked: !!checks[0] }; });
      const item = t.closest('.pj-item'); if (item) item.classList.toggle('checked', t.checked);
      return;
    }
    if (t.matches('[data-pj-done]')) {
      try { await H.api(() => api.setCompleted(t.dataset.pjDone, t.dataset.id, t.checked)); await refreshLinked(page); }
      catch { t.checked = !t.checked; }
    }
  }
  function onSubmit(event) {
    const form = event.target.closest && event.target.closest('[data-pjform]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.pjform === 'new-project') {
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) { form.elements.name.focus(); return; }
      createProject(name, false);
      return;
    }
    const page = activePage();
    if (page && page.status === 'ready') submitLinked(page, form);
  }
  function edgeMove(event, page, index, field, direction) {
    const before = field.selectionStart;
    if (field.selectionEnd !== before) return;
    const fields = field.dataset.line != null ? $$('[data-pj-text]', field.closest('[data-block]')) : [];
    const sibling = fields[fields.indexOf(field) + direction] || null;
    const leave = () => {
      if (sibling) { sibling.focus(); const at = direction < 0 ? sibling.value.length : 0; sibling.setSelectionRange(at, at); return; }
      const target = page.blocks[index + direction];
      if (target) focusBlock(target.id, null, direction < 0);
      else if (direction < 0) { const title = $('[data-pj-title]'); if (title) { title.focus(); title.setSelectionRange(title.value.length, title.value.length); } }
    };
    if (direction < 0 ? before === 0 : before === field.value.length) { event.preventDefault(); leave(); return; }
    // Still on the first or last visual line when the caret did not move.
    requestAnimationFrame(() => { if (document.activeElement === field && field.selectionStart === before && field.selectionEnd === before) leave(); });
  }
  function onKey(event) {
    if (P.menu && menuKey(event)) return;
    if (event.key === 'Escape' && P.pop) { event.preventDefault(); event.stopPropagation(); closePop(true); return; }
    if (event.key === 'Escape' && P.repo) { event.preventDefault(); event.stopPropagation(); endRepo(false); return; }
    const t = event.target;
    if (!t.closest || !t.closest('.pj-root')) return;
    const key = event.key; const mod = event.ctrlKey || event.metaKey;
    if (t.closest('.pj-tabs') && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const tabs = $$('.pj-tabs [role="tab"]'); const at = tabs.indexOf(t.closest('[role="tab"]'));
      if (at >= 0) { event.preventDefault(); tabs[(at + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].focus(); }
      return;
    }
    if (t.closest('.pj-tabs') && key === 'Delete' && t.dataset.pj === 'tab') { event.preventDefault(); closeTab(t.dataset.id); return; }
    const page = activePage(); if (!page || page.status !== 'ready') return;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (mod && !event.altKey && lower === 's') { event.preventDefault(); save(page); return; }
    const native = t.closest('[data-pjform]') || t.matches('input:not([type="checkbox"]), select');
    if (!native && mod && !event.altKey && lower === 'z') { event.preventDefault(); if (event.shiftKey) redo(page); else undo(page); return; }
    if (!native && mod && !event.altKey && lower === 'y') { event.preventDefault(); redo(page); return; }
    if (t.matches('[data-pj-title]') || t.matches('[data-pj-desc]')) {
      const last = t.matches('[data-pj-desc]');
      if ((key === 'Enter' && !event.shiftKey && !event.isComposing && !last) || (key === 'ArrowDown' && t.selectionStart === t.value.length && t.selectionEnd === t.value.length)) {
        event.preventDefault();
        if (!last) { const desc = $('[data-pj-desc]'); if (key === 'ArrowDown' && desc) { desc.focus(); return; } }
        if (!page.blocks.length) insertAfter(page, -1); else focusBlock(page.blocks[0].id);
      } else if (last && key === 'ArrowUp' && t.selectionStart === 0 && t.selectionEnd === 0) { event.preventDefault(); const title = $('[data-pj-title]'); if (title) title.focus(); }
      return;
    }
    const holder = t.closest('[data-block]'); if (!holder) return;
    const id = holder.dataset.block; const index = indexOf(page, id); if (index < 0) return;
    const block = page.blocks[index];
    if (event.altKey && event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) { event.preventDefault(); moveBlock(page, index, index + (key === 'ArrowDown' ? 1 : -1)); return; }
    if (mod && lower === 'd' && !native) { event.preventDefault(); const blocks = M.duplicate(page.blocks, index); structural(page, blocks, blocks[index + 1].id, null, true); return; }
    if (mod && key === '/') { event.preventDefault(); openBlockMenu(page, id, $('.pj-handle', holder) || holder); return; }
    if (mod && key === 'Enter' && !native) { event.preventDefault(); insertAfter(page, index); return; }
    if (mod && event.shiftKey && key === 'Backspace' && !native) { event.preventDefault(); removeBlock(page, index); return; }
    if (t === holder) {
      if (key === 'ArrowUp' || key === 'ArrowDown') { event.preventDefault(); const target = page.blocks[index + (key === 'ArrowDown' ? 1 : -1)]; if (target) focusBlock(target.id, null, key === 'ArrowUp'); }
      else if (key === 'Backspace' || key === 'Delete') { event.preventDefault(); removeBlock(page, index); }
      else if (key === 'Enter') { event.preventDefault(); insertAfter(page, index); }
      return;
    }
    if (!t.matches('[data-pj-text]') || event.isComposing) return;
    const start = t.selectionStart, end = t.selectionEnd;
    if (key === 'Enter' && !event.shiftKey && !mod) {
      // Text, quotes and callouts keep typing in the same group: Enter is a new line. Lists add an item to their group.
      if (['code', 'paragraph', 'quote', 'callout'].includes(block.type)) return;
      event.preventDefault();
      if (t.dataset.line != null) {
        const result = M.listEnter(page.blocks, index, Number(t.dataset.line), start, end);
        structural(page, result.blocks, result.focus, result.offset, false, result.line);
        return;
      }
      if (block.type === 'image' || block.type === 'bookmark') { insertAfter(page, index); return; }
      const result = M.split(page.blocks, index, start, end);
      structural(page, result.blocks, result.focus, result.offset);
    } else if (key === 'Backspace' && start === 0 && end === 0 && !mod && t.dataset.line != null) {
      event.preventDefault();
      const result = M.listBack(page.blocks, index, Number(t.dataset.line));
      if (result.blocks === page.blocks) { focusBlock(result.focus, result.offset); return; }
      structural(page, result.blocks, result.focus, result.offset, false, result.line);
    } else if (key === 'Backspace' && start === 0 && end === 0 && !mod) {
      const result = M.mergeBack(page.blocks, index);
      if (result.blocks === page.blocks && result.focus === id) return;
      event.preventDefault();
      if (result.blocks === page.blocks) focusBlock(result.focus, result.offset);
      else structural(page, result.blocks, result.focus, result.offset);
    } else if (key === 'ArrowUp' && !event.shiftKey && !mod && !event.altKey) edgeMove(event, page, index, t, -1);
    else if (key === 'ArrowDown' && !event.shiftKey && !mod && !event.altKey) edgeMove(event, page, index, t, 1);
    else if (key === 'Tab' && !event.shiftKey && block.type === 'code') { event.preventDefault(); t.setRangeText('  ', start, end, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  function clearDrop() { $$('.pj-block.drop-before, .pj-block.drop-after, .pj-block.dragging').forEach(el => el.classList.remove('drop-before', 'drop-after', 'dragging')); }
  function bindDrag() {
    document.addEventListener('dragstart', event => {
      const handle = event.target.closest && event.target.closest('.pj-handle'); if (!handle) return;
      const holder = handle.closest('[data-block]');
      closeMenu();
      P.drag = holder.dataset.block;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', '');
      event.dataTransfer.setDragImage(holder, 12, 12);
      holder.classList.add('dragging');
    });
    document.addEventListener('dragover', event => {
      if (!P.drag) return;
      const holder = event.target.closest && event.target.closest('.pj-blocks [data-block]'); if (!holder) return;
      event.preventDefault();
      const rect = holder.getBoundingClientRect(); const after = event.clientY > rect.top + rect.height / 2;
      $$('.pj-block.drop-before, .pj-block.drop-after').forEach(el => { if (el !== holder) el.classList.remove('drop-before', 'drop-after'); });
      holder.classList.toggle('drop-before', !after); holder.classList.toggle('drop-after', after);
    });
    document.addEventListener('drop', event => {
      if (!P.drag) return;
      const holder = event.target.closest && event.target.closest('.pj-blocks [data-block]');
      const page = activePage(); const dragged = P.drag; P.drag = null;
      if (holder && page) {
        event.preventDefault();
        const from = indexOf(page, dragged); let to = indexOf(page, holder.dataset.block);
        if (holder.classList.contains('drop-after')) to++;
        if (from < to) to--;
        clearDrop();
        if (from >= 0 && to >= 0 && from !== to) { change(page, null, () => { page.blocks = M.move(page.blocks, from, to); }); paintBlocks(page); focusBlock(dragged, null, true); }
      } else clearDrop();
    });
    document.addEventListener('dragend', () => { P.drag = null; clearDrop(); });
  }

  function init(helpers) {
    document.addEventListener('scroll', event => {
      const scroller = event.target; const bar = $('.pj-tabbar');
      if (bar && scroller && scroller.nodeType === 1 && scroller.contains(bar)) bar.classList.toggle('scrolled', scroller.scrollTop > 24);
    }, true);
    H = helpers;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', repoDown);
    document.addEventListener('pointermove', repoMove);
    document.addEventListener('pointerup', repoUp);
    document.addEventListener('scroll', followMenu, true);
    bindDrag();
    let resize = 0;
    window.addEventListener('resize', () => { cancelAnimationFrame(resize); resize = requestAnimationFrame(() => { const root = $('.pj-root'); if (root) { closeMenu(); $$('textarea', root).forEach(fit); } }); });
    window.addEventListener('beforeunload', flush);
  }

  window.PerflwProjects = {
    ready: () => true,
    init, load, render, mount, flush, settleAll, open, activate,
    create: () => createProject('Untitled', true),
    showHome: () => { flush(); if (P.tabs.active !== null) setTabs(M.activateTab(P.tabs, null)); },
    reset: () => { resetState(); P.user = null; },
    list: () => P.list,
    entriesFor: day => P.byDay.get(day) || [],
    hasUnsaved: () => [...P.pages.values()].some(page => page.dirty)
  };
})();

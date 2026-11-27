'use strict';
/* Calendar time blocks — schedules (the `events` table) drawn at their real length in the Days and Weeks grids.
   Click an empty time for a 1-hour block, drag for any length (15-minute snap), right-click empty time to set a
   schedule there, click or right-click a block to edit it. Each opens the schedule panel at the cursor.
   Storage goes through window.workspaceData (createEvent / updateEvent / deleteEvent), scoped to the signed-in account. */
(function () {
  const api = window.workspaceData;
  const account = window.account;
  if (!api) return;
  const HOUR = 50;           // px per hour row; kept in step with .tg-hours .time-row in schedule-blocks.css
  const SNAP = 15;           // minutes
  const DAY_MIN = 24 * 60;
  let H = null;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = min => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
  const toMin = value => { const [h, m] = String(value || '0:0').split(':').map(Number); return h * 60 + m; };
  const stampOf = (day, min) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 0, min).toISOString(); };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const SVG = body => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const IC = {
    folder: SVG('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v6.7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/>'),
    list: SVG('<path d="M7 5.5h10M7 10h10M7 14.5h10"/><circle cx="3.6" cy="5.5" r=".6" fill="currentColor"/><circle cx="3.6" cy="10" r=".6" fill="currentColor"/><circle cx="3.6" cy="14.5" r=".6" fill="currentColor"/>'),
    image: SVG('<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="m4 15 4-4 3 3 2-2 3 3"/>'),
    reset: SVG('<path d="M4 10a6 6 0 1 0 1.8-4.3"/><path d="M4 3.5v3h3"/>'),
    trash: SVG('<path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/>'),
    x: SVG('<path d="M5 5l10 10M15 5 5 15"/>')
  };

  // ───────────────────────── data
  const D = { events: [], tasks: [] };
  async function load() {
    try {
      const [events, tasks] = await Promise.all([api.events(), api.tasks().catch(() => [])]);
      D.events = events; D.tasks = tasks;
      await loadTimer();
    } catch (error) { D.events = []; if (H) H.toast(error.message || 'Schedules could not be loaded.', { error: true }); }
  }
  function reset() { D.events = []; D.tasks = []; T.timer = null; closePanel(); closeTimer(); }
  const startOf = e => new Date(e.starts_at);
  const dayOf = e => iso(startOf(e));
  function spanOf(e) {
    const s = startOf(e);
    const start = s.getHours() * 60 + s.getMinutes();
    let end = e.ends_at ? start + Math.round((Date.parse(e.ends_at) - s.getTime()) / 60000) : start + 30;
    end = clamp(end, start + 15, DAY_MIN);
    return { start, end };
  }
  /* The running timer shows up as a live block that grows with the clock (one piece per day it spans). */
  const T = { timer: null, ticks: 0 };
  const LIVE = '__timer';
  async function loadTimer() { try { T.timer = (await api.activeTimer()) || null; } catch { T.timer = null; } }
  function liveOn(day) {
    const t = T.timer; if (!t) return null;
    const from = new Date(t.started_at); const to = new Date();
    const a = iso(from); const b = iso(to);
    if (day < a || day > b) return null;
    const start = day === a ? from.getHours() * 60 + from.getMinutes() : 0;
    const end = day === b ? to.getHours() * 60 + to.getMinutes() + to.getSeconds() / 60 : DAY_MIN;
    return { id: LIVE, title: t.description, project_id: t.project_id, starts_at: stampOf(day, start), ends_at: stampOf(day, Math.max(end, start + 1)), live: true };
  }
  const eventsOn = day => { const list = D.events.filter(e => dayOf(e) === day); const live = liveOn(day); return live ? [...list, live] : list; };
  const whenOf = e => { const { start, end } = spanOf(e); return `${H.fmtTime(hhmm(start))} – ${H.fmtTime(hhmm(end % DAY_MIN))}`; };
  const eventsFor = day => D.events.filter(e => dayOf(e) === day).sort((a, b) => spanOf(a).start - spanOf(b).start).map(e => ({ id: e.id, title: e.title, project_id: e.project_id, when: whenOf(e) }));

  /* Overlapping blocks share the column side by side: each cluster of overlaps gets as many lanes as it needs. */
  function layout(day) {
    const items = eventsOn(day).map(e => ({ e, ...spanOf(e) })).sort((a, b) => a.start - b.start || b.end - a.end);
    let cluster = []; let clusterEnd = -1;
    const finish = () => { const lanes = Math.max(1, ...cluster.map(i => i.lane + 1)); cluster.forEach(i => { i.lanes = lanes; }); cluster = []; };
    for (const item of items) {
      if (item.start >= clusterEnd && cluster.length) finish();
      const used = cluster.filter(i => i.end > item.start).map(i => i.lane);
      let lane = 0; while (used.includes(lane)) lane++;
      item.lane = lane; cluster.push(item); clusterEnd = Math.max(clusterEnd, item.end);
    }
    if (cluster.length) finish();
    return items;
  }
  function blocksHtml(day) {
    const focus = H && H.calFocus ? H.calFocus() : null;
    return layout(day).map(({ e, start, end, lane, lanes }) => {
      const short = end - start < 45;
      const when = e.live ? `${H.fmtTime(hhmm(start))} – now` : `${H.fmtTime(hhmm(start))} – ${H.fmtTime(hhmm(end % DAY_MIN))}`;
      return `<div class="tblock theme-${esc(e.theme || 'light-blue')}${e.project_id ? ' linked' : ''}${e.live ? ' timer-live' : ''}${short ? ' short' : ''}${focus === e.id ? ' focus' : ''}" role="button" tabindex="0"
        data-sb-block="${esc(e.id)}" data-top="${start / 60 * HOUR}" data-height="${(end - start) / 60 * HOUR}" data-lane="${lane}" data-lanes="${lanes}"
        title="${esc(`${e.title} · ${when}${e.location ? ` · ${e.location}` : ''}`)}" aria-label="${esc(`${e.title}, ${when}. ${e.live ? 'Running timer. Click to open.' : 'Click to edit.'}`)}">
        <strong>${esc(e.title)}</strong><small>${esc(when)}${e.location && !short ? ` · ${esc(e.location)}` : ''}</small>
      </div>`;
    }).join('');
  }
  /* The overlay that sits over the hour rows, one column per day. */
  const layerHtml = days => `<div class="tg-layer" aria-label="Schedules">${days.map(day => `<div class="tg-col" data-sb-day="${day}">${blocksHtml(day)}</div>`).join('')}</div>`;
  function place(el) {
    const lanes = Number(el.dataset.lanes) || 1; const lane = Number(el.dataset.lane) || 0;
    el.style.top = `${el.dataset.top}px`;
    el.style.height = `${Math.max(14, Number(el.dataset.height) - 2)}px`;
    el.style.left = `calc(${lane / lanes * 100}% + 2px)`;
    el.style.width = `calc(${100 / lanes}% - 4px)`;
    const e = el.dataset.sbBlock ? D.events.find(ev => ev.id === el.dataset.sbBlock) : null;
    if (e && e.image) { el.classList.add('has-img'); el.style.backgroundImage = `linear-gradient(90deg, rgba(18, 18, 19, .8), rgba(18, 18, 19, .42)), url("${e.image}")`; }
  }
  function mount(root = document) {
    $$('.tblock[data-top]', root).forEach(place);
    if (P.ghost && P.open) showGhost(P.ghost.day, P.ghost.start, P.ghost.end);
  }
  const unlinkedCount = day => D.events.filter(e => dayOf(e) === day && !e.project_id).length;

  // ───────────────────────── creating by click / drag on the grid
  const P = { drag: null, open: null, ghost: null, dirty: false, imageName: null, image: null };
  function minuteAt(layer, clientY) { return clamp((clientY - layer.getBoundingClientRect().top) / HOUR * 60, 0, DAY_MIN - 1); }
  function colAt(hours, day) { return $(`.tg-col[data-sb-day="${CSS.escape(day)}"]`, hours); }
  function showGhost(day, start, end) {
    clearGhost(false);
    const hours = $('.tg-hours'); const col = hours && colAt(hours, day); if (!col) return;
    const el = document.createElement('div');
    el.className = 'tblock ghost';
    el.dataset.top = String(start / 60 * HOUR); el.dataset.height = String((end - start) / 60 * HOUR);
    el.innerHTML = `<strong>${esc(P.open && P.open.title ? P.open.title : 'New schedule')}</strong><small>${esc(`${H.fmtTime(hhmm(start))} – ${H.fmtTime(hhmm(end % DAY_MIN))}`)}</small>`;
    col.append(el); place(el);
  }
  function clearGhost(forget = true) { $$('.tblock.ghost').forEach(el => el.remove()); if (forget) P.ghost = null; }
  const snapDown = m => Math.floor(m / SNAP) * SNAP;
  const snapUp = m => Math.ceil(m / SNAP) * SNAP;

  function onPointerDown(event) {
    if (TP.open && !event.target.closest('#tm-pop, [data-action="timer"], .tblock.timer-live')) closeTimer();
    if (P.open && !event.target.closest('#sb-pop')) {
      // A panel with edits stays open until it is saved or cancelled; an untouched one closes.
      if (P.dirty) { nudge(); if (event.target.closest('.tg-hours')) event.preventDefault(); return; }
      closePanel();
    }
    if (event.button !== 0) return;
    const slot = event.target.closest('.tg-hours .slot');
    if (!slot || event.target.closest('.event-chip, .tblock')) return;
    const hours = slot.closest('.tg-hours'); const layer = $('.tg-layer', hours);
    const at = minuteAt(layer, event.clientY);
    P.drag = { hours, layer, day: slot.dataset.day, anchor: at, now: at, x: event.clientX, y: event.clientY, moved: false };
    event.preventDefault();
  }
  function dragRange(d = P.drag) { return { start: snapDown(Math.min(d.anchor, d.now)), end: Math.max(snapUp(Math.max(d.anchor, d.now)), snapDown(Math.min(d.anchor, d.now)) + SNAP) }; }
  function onPointerMove(event) {
    const d = P.drag; if (!d) return;
    if (!d.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 5) return;
    d.moved = true;
    d.now = minuteAt(d.layer, event.clientY);
    const { start, end } = dragRange();
    P.ghost = { day: d.day, start, end }; showGhost(d.day, start, end);
    // Keep dragging past the visible hours by scrolling the grid.
    const scroller = d.hours.closest('.timegrid-scroll');
    if (scroller) { const r = scroller.getBoundingClientRect(); if (event.clientY > r.bottom - 24) scroller.scrollTop += 12; else if (event.clientY < r.top + 24) scroller.scrollTop -= 12; }
  }
  function onPointerUp(event) {
    const d = P.drag; if (!d) return;
    P.drag = null;
    let range;
    if (d.moved) range = dragRange(d);
    else { const start = snapDown(d.anchor); range = { start, end: Math.min(DAY_MIN, start + 60) }; }
    openNew({ day: d.day, ...range }, event.clientX, event.clientY);
  }
  function onContextMenu(event) {
    if (!event.target.closest('.cal-body')) return;
    if (P.open && P.dirty) { event.preventDefault(); return; }
    if (TP.open) closeTimer();
    const block = event.target.closest('.tblock[data-sb-block]');
    if (block) { event.preventDefault(); openEdit(block.dataset.sbBlock, event.clientX, event.clientY); return; }
    const chip = event.target.closest('.event-chip[data-action="chip"]');
    const slot = event.target.closest('.tg-hours .slot');
    if (chip && H.planById) {
      const plan = H.planById(chip.dataset.id);
      if (plan) {
        event.preventDefault();
        const start = plan.time ? toMin(plan.time) : 9 * 60;
        openNew({ day: plan.day, start, end: Math.min(DAY_MIN, start + 60), title: plan.text }, event.clientX, event.clientY);
        return;
      }
    }
    if (slot) {
      event.preventDefault();
      const start = snapDown(minuteAt($('.tg-layer', slot.closest('.tg-hours')), event.clientY));
      openNew({ day: slot.dataset.day, start, end: Math.min(DAY_MIN, start + 60) }, event.clientX, event.clientY);
      return;
    }
    const dayEl = event.target.closest('[data-day]');
    if (dayEl && /^\d{4}-\d{2}-\d{2}$/.test(dayEl.dataset.day)) {
      event.preventDefault();
      openNew({ day: dayEl.dataset.day, start: 9 * 60, end: 10 * 60 }, event.clientX, event.clientY);
    }
  }
  function onClick(event) {
    const row = event.target.closest('[data-sb-open]');
    if (row) { const r = row.getBoundingClientRect(); openEdit(row.dataset.sbOpen, r.left - 20, r.top); return; }
    const block = event.target.closest('.cal-body .tblock[data-sb-block]');
    if (block && !(P.open && P.dirty)) { event.preventDefault(); openEdit(block.dataset.sbBlock, event.clientX, event.clientY); }
  }
  function onKey(event) {
    if (TP.open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeTimer(true); return; }
    if (P.open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePanel(true); return; }
    const t = event.target;
    if (!(event.key === 'Enter' || event.key === ' ') || !t.closest) return;
    const block = t.closest('.tblock[data-sb-block]');
    if (block && t === block) { event.preventDefault(); const r = block.getBoundingClientRect(); openEdit(block.dataset.sbBlock, r.right, r.top); return; }
    // Keyboard on an hour slot: a 1-hour schedule at that hour.
    if (t.matches && t.matches('.tg-hours .slot') && t === event.target) {
      event.preventDefault();
      const r = t.getBoundingClientRect(); const start = toMin(t.dataset.time);
      openNew({ day: t.dataset.day, start, end: Math.min(DAY_MIN, start + 60) }, r.left + r.width / 2, r.top);
    }
  }

  // ───────────────────────── the panel
  function popEl() {
    let el = $('#sb-pop');
    if (!el) { el = document.createElement('form'); el.id = 'sb-pop'; el.className = 'sb-pop'; el.setAttribute('role', 'dialog'); el.noValidate = true; el.hidden = true; document.body.append(el); }
    return el;
  }
  function openNew(range, x, y) {
    P.ghost = { day: range.day, start: range.start, end: range.end };
    openPanel({ id: null, title: range.title || '', day: range.day, start: range.start, end: range.end, projectId: '', taskId: '', eventType: 'Event', location: '', notes: '', imageName: null, image: null }, x, y);
  }
  function openEdit(id, x, y) {
    if (id === LIVE) { openTimer(x, y); return; }
    const e = D.events.find(ev => ev.id === id); if (!e) return;
    clearGhost();
    const { start, end } = spanOf(e);
    openPanel({ id, title: e.title, day: dayOf(e), start, end, projectId: e.project_id || '', taskId: e.task_id || '', eventType: e.event_type || 'Event', location: e.location || '', notes: e.notes || '', imageName: e.image_name || null, image: e.image || null }, x, y);
  }
  function optionsHtml(list, current, none) {
    return `<option value="">${none}</option>${list.map(o => `<option value="${esc(o.id)}"${o.id === current ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}`;
  }
  function panelHtml(s) {
    const projects = (H.projects ? H.projects() : []).map(p => ({ id: p.id, label: p.name }));
    const tasks = D.tasks.filter(t => !t.completed_at || t.id === s.taskId).map(t => ({ id: t.id, label: t.title }));
    return `<header class="sb-cover">
        <strong class="sb-heading" id="sb-heading">${s.id ? 'Edit schedule' : 'New schedule'}</strong>
        <div class="sb-cover-tools">
          <button class="sb-tool" type="button" data-sb="image" title="Change background image" aria-label="Change background image">${IC.image}</button>
          <button class="sb-tool" type="button" data-sb="image-reset" title="Use the default image" aria-label="Use the default image"${s.imageName ? '' : ' hidden'}>${IC.reset}</button>
          <button class="sb-tool" type="button" data-sb="close" title="Close" aria-label="Close">${IC.x}</button>
        </div>
      </header>
      <div class="sb-body">
        <input class="sb-field sb-name" name="title" maxlength="180" placeholder="Name of the schedule" aria-label="Name of the schedule" autocomplete="off" value="${esc(s.title)}">
        <div class="sb-row">
          <label class="sb-pick${s.projectId ? ' set' : ''}" title="Project">${IC.folder}<select name="projectId" aria-label="Project">${optionsHtml(projects, s.projectId, 'No project')}</select></label>
          <label class="sb-pick${s.taskId ? ' set' : ''}" title="Linked task">${IC.list}<select name="taskId" aria-label="Linked task">${optionsHtml(tasks, s.taskId, 'No task')}</select></label>
          <input class="sb-field sb-date" type="date" name="day" value="${esc(s.day)}" aria-label="Date" required>
          <input class="sb-field sb-loc" name="location" maxlength="180" placeholder="Add a location" aria-label="Location" autocomplete="off" value="${esc(s.location)}">
        </div>
        <textarea class="sb-field sb-notes" name="notes" maxlength="2000" rows="3" placeholder="Add useful details" aria-label="Details">${esc(s.notes)}</textarea>
        <select class="sb-field sb-type" name="eventType" aria-label="Schedule type">${['Event', 'Task schedule'].map(t => `<option${t === s.eventType ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <div class="sb-foot">
          <input class="sb-field sb-time" type="time" name="start" step="300" value="${hhmm(s.start)}" aria-label="Start time" required>
          <span class="sb-arrow" aria-hidden="true">→</span>
          <input class="sb-field sb-time" type="time" name="end" step="300" value="${hhmm(s.end % DAY_MIN)}" aria-label="End time" required>
          <span class="sb-gap"></span>
          ${s.id ? `<button class="sb-del" type="button" data-sb="delete" title="Delete schedule" aria-label="Delete schedule">${IC.trash}</button>` : ''}
          <button class="sb-cancel" type="button" data-sb="close">Cancel</button>
          <button class="sb-save" type="submit">Save schedule</button>
        </div>
        <p class="sb-error" role="alert" hidden></p>
      </div>`;
  }
  function paintCover() {
    const cover = $('#sb-pop .sb-cover'); if (!cover) return;
    cover.classList.toggle('custom', !!P.image);
    cover.style.backgroundImage = P.image ? `url("${P.image}")` : '';
    const resetBtn = $('[data-sb="image-reset"]', cover); if (resetBtn) resetBtn.hidden = !P.imageName;
  }
  function openPanel(state, x, y) {
    const el = popEl();
    P.open = state; P.dirty = false; P.imageName = state.imageName; P.image = state.image;
    el.setAttribute('aria-labelledby', 'sb-heading');
    el.innerHTML = panelHtml(state);
    el.hidden = false;
    paintCover();
    if (P.ghost) showGhost(P.ghost.day, P.ghost.start, P.ghost.end);
    // Next to the cursor, kept inside the window.
    const w = el.offsetWidth, h = el.offsetHeight, gap = 14;
    let left = x + gap; if (left + w > window.innerWidth - 10) left = x - w - gap;
    left = clamp(left, 10, window.innerWidth - w - 10);
    const top = clamp(y - 40, 10, window.innerHeight - h - 10);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    el.classList.remove('sb-in'); void el.offsetWidth; el.classList.add('sb-in');
    const name = $('[name="title"]', el); name.focus(); if (state.title) name.select();
  }
  function closePanel(refocus = false) {
    const el = $('#sb-pop');
    const wasOpen = !!P.open;
    P.open = null; P.dirty = false;
    clearGhost();
    if (el) el.hidden = true;
    if (refocus && wasOpen) { const grid = $('.timegrid-scroll'); if (grid) grid.focus({ preventScroll: true }); }
  }
  function nudge() { const el = $('#sb-pop'); if (!el) return; el.classList.remove('sb-nudge'); void el.offsetWidth; el.classList.add('sb-nudge'); showError('Save or cancel this schedule first.'); }
  function showError(text) { const p = $('#sb-pop .sb-error'); if (!p) return; p.textContent = text; p.hidden = !text; }
  function readForm() {
    const el = $('#sb-pop'); const f = new FormData(el);
    const title = String(f.get('title') || '').trim();
    const day = String(f.get('day') || '');
    const start = toMin(f.get('start')); let end = toMin(f.get('end'));
    if (end === 0 && start > 0) end = DAY_MIN; // ending at midnight
    return { title, day, start, end, projectId: String(f.get('projectId') || '') || null, taskId: String(f.get('taskId') || '') || null,
      eventType: String(f.get('eventType') || 'Event'), location: String(f.get('location') || '').trim(), notes: String(f.get('notes') || '').trim() };
  }
  async function submit(event) {
    if (event.target.id !== 'sb-pop') return;
    event.preventDefault();
    const state = P.open; if (!state) return;
    const v = readForm();
    if (!v.title) { showError('Give the schedule a name.'); $('#sb-pop [name="title"]').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.day)) { showError('Choose a date.'); $('#sb-pop [name="day"]').focus(); return; }
    if (v.end <= v.start) { showError('The end time must be after the start time.'); $('#sb-pop [name="end"]').focus(); return; }
    const startsAt = stampOf(v.day, v.start); const endsAt = stampOf(v.day, v.end);
    const save = $('#sb-pop .sb-save'); save.disabled = true;
    try {
      if (state.id) await H.api(() => api.updateEvent(state.id, { title: v.title, startsAt, endsAt, projectId: v.projectId, taskId: v.taskId, eventType: v.eventType, location: v.location, notes: v.notes, imageName: P.imageName }));
      else await H.api(() => api.createEvent(v.title, startsAt, endsAt, v.projectId, v.taskId, 'light-blue', v.eventType, v.location, v.notes, P.imageName));
      closePanel();
      await load();
      await H.changed(v.day);
      H.toast(state.id ? 'Schedule updated.' : 'Schedule saved.');
    } catch (error) { if (save.isConnected) save.disabled = false; showError(error.message || 'The schedule could not be saved.'); }
  }
  async function remove() {
    const state = P.open; if (!state || !state.id) return;
    const title = state.title;
    closePanel();
    if (!(await H.confirmDialog({ title: 'Delete this schedule?', text: `“${title}” is removed from Calendar${D.events.find(e => e.id === state.id && e.project_id) ? ' and its project' : ''}.` }))) return;
    try { await H.api(() => api.deleteEvent(state.id)); await load(); await H.changed(state.day); H.toast('Schedule deleted.'); } catch { /* toast shown */ }
  }
  async function onPanelClick(event) {
    const btn = event.target.closest('#sb-pop [data-sb]'); if (!btn) return;
    switch (btn.dataset.sb) {
      case 'close': closePanel(true); break;
      case 'delete': await remove(); break;
      case 'image': {
        if (!account || !account.pickImage) break;
        try { const picked = await H.api(() => account.pickImage()); if (picked) { P.imageName = picked.imageName; P.image = picked.image; P.dirty = true; paintCover(); } } catch { /* toast shown */ }
        break;
      }
      case 'image-reset': P.imageName = null; P.image = null; P.dirty = true; paintCover(); break;
      default: break;
    }
  }
  function onPanelInput(event) {
    const t = event.target; if (!t.closest || !t.closest('#sb-pop')) return;
    P.dirty = true; showError('');
    if (t.name === 'projectId' || t.name === 'taskId') t.closest('.sb-pick').classList.toggle('set', !!t.value);
    if (t.name === 'taskId' && t.value) {
      // A linked task brings its project with it.
      const task = D.tasks.find(x => x.id === t.value); const project = $('#sb-pop [name="projectId"]');
      if (task && task.project_id && project && [...project.options].some(o => o.value === task.project_id)) { project.value = task.project_id; project.closest('.sb-pick').classList.add('set'); }
    }
    if (t.name === 'title' && P.open) { P.open.title = t.value; const g = $('.tblock.ghost strong'); if (g) g.textContent = t.value || 'New schedule'; }
    if ((t.name === 'start' || t.name === 'end' || t.name === 'day') && P.ghost) {
      const v = readForm();
      if (v.end > v.start && /^\d{4}-\d{2}-\d{2}$/.test(v.day)) { P.ghost = { day: v.day, start: v.start, end: v.end }; showGhost(v.day, v.start, v.end); }
    }
  }

  // ───────────────────────── the timer panel (clock button, top right of the calendar)
  const TP = { open: false, busy: false };
  const nowHHMM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const elapsedText = () => {
    if (!T.timer) return '0:00:00';
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(T.timer.started_at)) / 1000));
    return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };
  function tmEl() {
    let el = $('#tm-pop');
    if (!el) { el = document.createElement('form'); el.id = 'tm-pop'; el.className = 'sb-pop tm-pop'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Timer'); el.noValidate = true; el.hidden = true; document.body.append(el); }
    return el;
  }
  function timerHtml() {
    const projects = (H.projects ? H.projects() : []).map(p => ({ id: p.id, label: p.name }));
    const t = T.timer;
    const head = `<header class="sb-cover tm-cover"><strong class="sb-heading">${t ? 'Timer running' : 'Start a timer'}</strong><div class="sb-cover-tools"><button class="sb-tool" type="button" data-tm="close" title="Close" aria-label="Close">${IC.x}</button></div></header>`;
    if (t) {
      const project = (H.projects ? H.projects() : []).find(p => p.id === t.project_id);
      return `${head}<div class="sb-body">
        <div class="tm-clock" id="tm-elapsed" aria-live="off">${elapsedText()}</div>
        <div class="tm-name">${esc(t.description)}</div>
        <p class="tm-meta">${project ? `${esc(project.name)} · ` : ''}Started ${esc(H.fmtTime(hhmm(new Date(t.started_at).getHours() * 60 + new Date(t.started_at).getMinutes())))}</p>
        <div class="sb-foot"><span class="sb-gap"></span><button class="sb-cancel" type="button" data-tm="close">Hide</button><button class="sb-save tm-stop" type="button" data-tm="stop">Stop timer</button></div>
        <p class="sb-error" role="alert" hidden></p></div>`;
    }
    return `${head}<div class="sb-body">
        <input class="sb-field sb-name" name="title" maxlength="180" placeholder="Timer block name" aria-label="Timer block name" autocomplete="off">
        <div class="sb-row">
          <label class="sb-pick tm-project" title="Project tag">${IC.folder}<select name="projectId" aria-label="Project tag">${optionsHtml(projects, '', 'No project')}</select></label>
          <span class="tm-project-label" id="tm-project-label">No project tag</span>
        </div>
        <div class="sb-foot">
          <label class="tm-start-label" for="tm-start">Starts at</label>
          <input class="sb-field sb-time" id="tm-start" type="time" name="start" value="${nowHHMM()}" aria-label="Starting time" required>
          <span class="sb-gap"></span>
          <button class="sb-cancel" type="button" data-tm="close">Cancel</button>
          <button class="sb-save" type="submit">Start</button>
        </div>
        <p class="sb-error" role="alert" hidden></p></div>`;
  }
  function openTimer(x, y) {
    if (P.open) closePanel();
    const el = tmEl();
    el.innerHTML = timerHtml(); el.hidden = false; TP.open = true;
    const w = el.offsetWidth, h = el.offsetHeight;
    const anchor = $('[data-action="timer"]');
    if (typeof x !== 'number' || typeof y !== 'number') { const r = anchor ? anchor.getBoundingClientRect() : { right: window.innerWidth - 20, bottom: 50 }; x = r.right; y = r.bottom + 10; el.style.left = `${clamp(x - w, 10, window.innerWidth - w - 10)}px`; el.style.top = `${clamp(y, 10, window.innerHeight - h - 10)}px`; }
    else { el.style.left = `${clamp(x + 14, 10, window.innerWidth - w - 10)}px`; el.style.top = `${clamp(y - 40, 10, window.innerHeight - h - 10)}px`; }
    el.classList.remove('sb-in'); void el.offsetWidth; el.classList.add('sb-in');
    const name = $('[name="title"]', el); if (name) name.focus();
    paintTimerBtn();
  }
  function closeTimer(refocus = false) {
    const el = $('#tm-pop'); TP.open = false; if (el) el.hidden = true;
    if (refocus) { const b = $('[data-action="timer"]'); if (b) b.focus({ preventScroll: true }); }
  }
  function toggleTimer() { if (TP.open) closeTimer(); else openTimer(); }
  function paintTimerBtn() { const b = $('[data-action="timer"]'); if (b) b.classList.toggle('running', !!T.timer); }
  function tmError(text) { const p = $('#tm-pop .sb-error'); if (p) { p.textContent = text; p.hidden = !text; } }
  async function startTimerFromPanel(event) {
    if (event.target.id !== 'tm-pop') return;
    event.preventDefault();
    if (TP.busy || T.timer) return;
    const f = new FormData(event.target);
    const title = String(f.get('title') || '').trim();
    if (!title) { tmError('Give the timer a name.'); $('#tm-pop [name="title"]').focus(); return; }
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(f.get('start') || ''));
    if (!m) { tmError('Choose a starting time.'); return; }
    const startMin = Number(m[1]) * 60 + Number(m[2]);
    const today = iso(new Date());
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    if (startMin > nowMin) { tmError('The starting time cannot be later than now.'); return; }
    TP.busy = true;
    try {
      await H.api(() => api.startTimer(title, String(f.get('projectId') || '') || null, null, '', '', stampOf(today, startMin)));
      await loadTimer();
      closeTimer();
      H.toast('Timer started.');
      refreshLive(true);
    } catch (error) { tmError(error.message || 'The timer could not be started.'); }
    finally { TP.busy = false; }
  }
  async function stopTimerFromPanel() {
    const t = T.timer; if (!t || TP.busy) return;
    TP.busy = true;
    try {
      await H.api(() => api.stopTimer());
      const end = Math.max(Date.now(), Date.parse(t.started_at) + 60000);
      try { await api.createEvent(t.description, t.started_at, new Date(end).toISOString(), t.project_id || null, null, 'light-blue', 'Event', '', '', null); } catch { /* the focus entry is saved even if the block is not */ }
      T.timer = null;
      closeTimer();
      await load();
      await H.changed(iso(new Date(t.started_at)));
      H.toast('Timer stopped and saved to the calendar.');
    } catch (error) { tmError(error.message || 'The timer could not be stopped.'); }
    finally { TP.busy = false; }
  }
  function onTimerClick(event) {
    const btn = event.target.closest('#tm-pop [data-tm]'); if (!btn) return;
    if (btn.dataset.tm === 'close') closeTimer(true);
    else if (btn.dataset.tm === 'stop') stopTimerFromPanel();
  }
  function onTimerInput(event) {
    const t = event.target; if (!t.closest || !t.closest('#tm-pop')) return;
    tmError('');
    if (t.name === 'projectId') { const label = $('#tm-project-label'); const opt = t.options[t.selectedIndex]; if (label) label.textContent = t.value ? opt.textContent : 'No project tag'; t.closest('.sb-pick').classList.toggle('set', !!t.value); }
  }
  /* Redraw the live block (and the clock) as time passes. */
  function refreshLive(force = false) {
    paintTimerBtn();
    const el = $('#tm-elapsed'); if (el) el.textContent = elapsedText();
    if (!T.timer) { if ($('.tblock.timer-live')) $$('.tg-col').forEach(col => { col.innerHTML = blocksHtml(col.dataset.sbDay); }), mount(); return; }
    if (!force && T.ticks % 15) return;
    if (!$('.tg-hours')) return;
    $$('.tg-col').forEach(col => { col.innerHTML = blocksHtml(col.dataset.sbDay); });
    mount();
  }
  function tick() { T.ticks++; refreshLive(false); }
  function create(day) {
    const d = day || iso(new Date());
    const start = Math.min(DAY_MIN - 60, Math.ceil((new Date().getHours() * 60 + new Date().getMinutes()) / 60) * 60);
    openNew({ day: d, start, end: start + 60 }, Math.max(10, window.innerWidth / 2 - 280), 120);
  }

  function init(helpers) {
    H = helpers;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('click', onClick);
    document.addEventListener('click', onPanelClick);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('input', onPanelInput);
    document.addEventListener('change', onPanelInput);
    document.addEventListener('submit', submit);
    document.addEventListener('submit', startTimerFromPanel);
    document.addEventListener('click', onTimerClick);
    document.addEventListener('input', onTimerInput);
    document.addEventListener('change', onTimerInput);
    setInterval(tick, 1000);
    document.addEventListener('keydown', event => {
      if (P.open && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target.closest && event.target.closest('#sb-pop')) { event.preventDefault(); popEl().requestSubmit(); }
    });
    window.addEventListener('resize', () => { if (P.open) closePanel(); if (TP.open) closeTimer(); });
  }

  window.PerflwSchedules = { init, load, reset, layerHtml, mount, unlinkedCount, eventsFor, create, toggleTimer, timerRunning: () => !!T.timer, close: closePanel, isOpen: () => !!P.open, events: () => D.events, dayOf };
})();

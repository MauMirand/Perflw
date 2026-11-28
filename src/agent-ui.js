'use strict';
/* Agent activity UI shared by the study chat and personal chat (owner reference 2026-11-28): a collapsible "Thinking…" block whose
   body is a task checklist (done = struck through with a check, current = spinner, pending = empty circle, "N/M done"), a compact
   "Worked for 12s" line once the reply is finished, and a "N/M tasks done" bar above the composer while a plan runs.
   Pure string builders; escape-first. Loaded by the renderer (window.PerflwAgentUI) and by unit tests (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwAgentUI = factory();
})(globalThis, function () {
  const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const svg = path => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const ICON = {
    done: svg('<path d="M3.5 8.5l3 3 6-7"/>'), failed: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'), skipped: svg('<path d="M4 8h8"/>'),
    pending: '<span class="ag-dot" aria-hidden="true"></span>', running: '<span class="ag-spin" aria-hidden="true"></span>',
    chevron: svg('<path d="M6 4l4 4-4 4"/>'), list: svg('<path d="M5.5 4.5h7M5.5 8h7M5.5 11.5h7M3 4.5h.01M3 8h.01M3 11.5h.01"/>'),
  };
  const WORD = { done: 'done', running: 'in progress', pending: 'not started', failed: 'failed', skipped: 'skipped' };
  /* Any step shape → { title, status } with status done | running | pending | failed | skipped. */
  function normalize(steps) {
    return (Array.isArray(steps) ? steps : []).filter(Boolean).map(s => {
      const raw = String(s.status || 'pending').toLowerCase();
      const status = raw === 'done' || raw === 'complete' || raw === 'completed' || raw === 'ok' ? 'done' : raw === 'running' || raw === 'active' || raw === 'working' ? 'running'
        : raw === 'failed' || raw === 'error' ? 'failed' : raw === 'skipped' || raw === 'cancelled' || raw === 'stopped' ? 'skipped' : 'pending';
      return { title: String(s.title || s.name || s.label || 'Step'), status, note: s.note || '' };
    });
  }
  const doneCount = list => list.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const progress = steps => { const list = normalize(steps); return list.length ? `${doneCount(list)}/${list.length} done` : ''; };
  function checklist(steps) {
    const list = normalize(steps); if (!list.length) return '';
    return `<ol class="ag-tasks">${list.map(s => `<li class="ag-task is-${s.status}"><span class="ag-task-mark">${ICON[s.status]}</span><span class="ag-task-title">${esc(s.title)}</span><span class="sr-only">, ${WORD[s.status]}</span></li>`).join('')}</ol>`;
  }
  const seconds = ms => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.max(1, Math.round(ms / 1000))}s`);
  /* running: the live block (open, shimmering "Thinking…", the current activity as a line); finished: "Worked for 12s" (collapsed).
     `hooks` adds data- attributes so a caller can update parts in place while tokens stream. */
  function thinking({ running = false, label = '', steps = [], elapsedMs = null, open = running, failed = false, hooks = false } = {}) {
    const list = normalize(steps); const count = list.length ? `${doneCount(list)}/${list.length} done` : '';
    const title = running ? 'Thinking…' : failed ? 'Stopped' : elapsedMs != null ? `Worked for ${seconds(elapsedMs)}` : 'Worked';
    const h = name => (hooks ? ` data-ag-${name}` : '');
    return `<details class="ag-think${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}"${open ? ' open' : ''}>
      <summary><span class="ag-think-mark">${running ? ICON.running : failed ? ICON.failed : ICON.done}</span><span class="ag-think-title"${h('title')}>${esc(title)}</span><span class="ag-count"${h('count')}>${esc(count)}</span><span class="ag-chev">${ICON.chevron}</span></summary>
      <div class="ag-think-body">${running ? `<p class="ag-now"${h('now')}>${esc(label)}</p>` : ''}<div${h('steps')}>${checklist(list)}</div></div>
    </details>`;
  }
  function taskBar(steps) {
    const list = normalize(steps); if (!list.length) return '';
    return `<div class="ag-taskbar" role="status">${ICON.list}<span>${doneCount(list)}/${list.length} tasks done</span>${list.some(s => s.status === 'running') ? `<span class="ag-taskbar-now">${esc(list.find(s => s.status === 'running').title)}</span>` : ''}</div>`;
  }
  /* A step log built from stage labels (the study chat streams stages, not a plan): each new label finishes the previous one. */
  function pushStage(steps, label) {
    const list = Array.isArray(steps) ? steps : [];
    const last = list[list.length - 1];
    if (last && last.title === label) return list;
    if (last && last.status === 'running') last.status = 'done';
    list.push({ title: String(label || 'Working'), status: 'running' });
    return list;
  }
  function finishStages(steps, ok = true) {
    const list = Array.isArray(steps) ? steps : [];
    for (const s of list) if (s.status === 'running') s.status = ok ? 'done' : 'failed';
    return list;
  }
  return { normalize, progress, checklist, thinking, taskBar, pushStage, finishStages, seconds };
});

'use strict';
/* Learning — subjects kept per learning profile (study / personal).
   Page: title with the profile switch, a Subjects grid of pockets (+ to create, ⋯ to edit or delete).
   Click a pocket once: the right-hand preview panel opens. Double-click (or Enter on a previewed pocket): the
   subject opens as a full page. Topics, study sessions and quizzes are not built yet; their areas are placeholders.
   Storage goes through window.learningData (preload → main → workspace.js), scoped to the signed-in account. */
(function () {
  const api = window.learningData;
  if (!api) return;
  const PROFILE_KEY = 'perflw.learning.profile';
  const SIDE_KEY = 'perflw.learning.sidePanel'; // 'closed' when the AI side panel of the topic viewer is collapsed
  const PROFILES = { study: 'study', personal: 'personal' };
  const TYPES = [['major', 'Major'], ['minor', 'Minor']];
  let H = null;
  const L = { status: 'idle', error: '', profile: 'study', subjects: [], preview: null, panel: false, page: null, closing: false, viewer: null };
  const TM = window.PerflwTopicModel;
  if (!TM) return;
  const T = new Map();   // subjectId → { rows, files } | { error } — topic lists loaded so far
  const TS = { editing: null, uploading: false, fileOver: false, fresh: new Set(), drag: null, sel: new Set(), anchor: null };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  try { if (localStorage.getItem(PROFILE_KEY) === 'personal') L.profile = 'personal'; } catch { /* storage unavailable */ }
  let sideOpen = true;
  try { sideOpen = localStorage.getItem(SIDE_KEY) !== 'closed'; } catch { /* the panel simply starts open */ }
  const PANEL_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M12.5 4v12"/></svg>';

  const subject = id => L.subjects.find(s => s.id === id) || null;
  const typeLabel = type => (type === 'minor' ? 'Minor' : 'Major');
  function spent(minutes) {
    if (!minutes) return 'No time spent yet';
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return `${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m ? `${m}m` : ''} spent`;
  }
  // A steady colour for subjects without an image, picked from the name.
  function tone(name) { let n = 0; for (const c of String(name)) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n % 6; }
  const initial = name => esc((String(name).trim()[0] || '?').toUpperCase());
  function art(s, cls) {
    return s.image
      ? `<span class="${cls} ln-art has-img" data-ln-img="${esc(s.image)}" aria-hidden="true"></span>`
      : `<span class="${cls} ln-art ln-tone-${tone(s.name)}" aria-hidden="true"><b>${initial(s.name)}</b></span>`;
  }

  // ───────── data
  async function load() {
    L.status = 'loading';
    try { L.subjects = await api.subjects(L.profile); L.status = 'ready'; L.error = ''; }
    catch (error) { L.status = 'error'; L.error = error.message || 'Subjects could not be loaded.'; }
    if (L.preview && !subject(L.preview)) { L.preview = null; L.panel = false; }
    if (L.page && !subject(L.page)) L.page = null;
  }
  function reset() {
    closeMenu(); closeDialog({ instant: true }); T.clear(); if (window.PerflwAnnotate) window.PerflwAnnotate.reset();
    Object.assign(TS, { editing: null, uploading: false, fileOver: false, drag: null, anchor: null }); TS.fresh.clear(); TS.sel.clear();
    Object.assign(L, { status: 'idle', error: '', subjects: [], preview: null, panel: false, page: null, viewer: null }); FP.clear(); if (PDFV) PDFV.reset();
    if (window.PerflwLearningStudy) window.PerflwLearningStudy.reset();
  }
  const visible = () => H && H.view() === 'learning' && $('.ln-root');
  function paint() {
    const root = visible(); if (!root) return;
    root.outerHTML = render();
    mount();
  }

  // ───────── rendering
  function pocket(s) {
    const selected = L.panel && L.preview === s.id;
    return `<div class="ln-pocket ln-subject${selected ? ' selected' : ''}${L.fresh === s.id ? ' ln-pocket-new' : ''}" role="button" tabindex="0" data-ln-subject="${esc(s.id)}"
        aria-label="${esc(s.name)}. Click to preview, double-click to open" aria-pressed="${selected}" title="Click to preview · Double-click to open">
      ${art(s, 'ln-thumb')}
      <span class="ln-pocket-title">${esc(s.name)}</span>
      <button class="ln-more" type="button" data-ln="menu" data-id="${esc(s.id)}" aria-label="Options for ${esc(s.name)}" aria-haspopup="menu" title="Edit or delete">${dots}</button>
    </div>`;
  }
  const dots = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15.5" cy="10" r="1.6"/></svg>';
  // ───────── topics: rendering (order, levels and numbers come from topic-model.js)
  const UPLOAD = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3.5M6 7.5l4-4 4 4M4 13.5v2.5h12v-2.5"/></svg>';
  const PENCIL = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 3.5a1.5 1.5 0 0 1 2 2L6 15l-3 .8.8-3L13.5 3.5z"/></svg>';
  const GRIP = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.5" cy="5" r="1.3"/><circle cx="12.5" cy="5" r="1.3"/><circle cx="7.5" cy="10" r="1.3"/><circle cx="12.5" cy="10" r="1.3"/><circle cx="7.5" cy="15" r="1.3"/><circle cx="12.5" cy="15" r="1.3"/></svg>';
  const INDENT = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M9 10h7M9 15h7M4 9l2.5 2.5L4 14"/></svg>';
  const OUTDENT = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M9 10h7M9 15h7M6.5 9 4 11.5 6.5 14"/></svg>';
  const topicsOf = id => T.get(id) || null;
  const fileOf = (data, row) => (row.fileId ? data.files.find(f => f.id === row.fileId) : null);
  function topicRow(data, row, nums, counts) {
    const editing = TS.editing === row.id;
    const fresh = TS.fresh.has(row.id) ? ' ln-new' : '';
    const on = TS.sel.has(row.id); const carried = !on && TS.carried && TS.carried.has(row.id); // a subtopic moving with its selected topic
    const title = editing
      ? `<input class="field ln-topic-edit" data-ln-topic-edit="${esc(row.id)}" maxlength="${TM.LIMITS.title}" value="${esc(row.title)}" aria-label="Rename ${row.kind === 'milestone' ? 'milestone' : 'topic'}">`
      : row.kind === 'milestone'
        ? `<span class="ln-topic-title" data-ln="topic-rename" data-id="${esc(row.id)}" title="Rename">${esc(row.title)}</span>`
        : `<span class="ln-topic-title" data-ln="topic-open" data-id="${esc(row.id)}" title="Open">${esc(row.title)}</span>`;
    const actions = `<span class="ln-row-actions">
        ${row.kind === 'topic' ? `<button class="icon-btn sm" type="button" data-ln="topic-rename" data-id="${esc(row.id)}" aria-label="Rename ${esc(row.title)}" title="Rename (F2)">${PENCIL}</button>` : ''}
        ${row.kind === 'topic' ? `<button class="icon-btn sm" type="button" data-ln="topic-level" data-id="${esc(row.id)}" aria-label="${row.level ? 'Make it a topic' : 'Make it a subtopic'}" title="${row.level ? 'Make topic (Alt+←)' : 'Make subtopic (Alt+→)'}">${row.level ? OUTDENT : INDENT}</button>` : ''}
        <button class="icon-btn sm" type="button" data-ln="topic-delete" data-id="${esc(row.id)}" aria-label="Delete ${esc(row.title)}" title="Delete">${H.icon('x')}</button>
      </span>`;
    if (row.kind === 'milestone') {
      const n = counts.get(row.id) || 0;
      return `<li class="ln-milestone${fresh}${on ? ' selected' : ''}" draggable="${!editing}" tabindex="0" data-topic="${esc(row.id)}" aria-label="Milestone ${esc(row.title)}, ${n} topic${n === 1 ? '' : 's'}${on ? ', selected' : ''}. Alt+arrows move it.">
        <span class="ln-grip" aria-hidden="true">${GRIP}</span>${title}<span class="ln-ms-count">${n} topic${n === 1 ? '' : 's'}</span>${actions}</li>`;
    }
    const file = fileOf(data, row);
    const num = nums.get(row.id);
    return `<li class="ln-topic lvl-${row.level}${fresh}${on ? ' selected' : carried ? ' carried' : ''}" draggable="${!editing}" tabindex="0" data-topic="${esc(row.id)}" aria-label="${num} ${esc(row.title)}${on ? ', selected' : ''}. Enter opens it, Space or Ctrl+click selects, F2 renames, Alt+arrows move it, Alt+left/right change its level.">
      <span class="ln-grip" aria-hidden="true">${GRIP}</span><span class="ln-num">${num}</span>${title}
      ${file ? `<span class="ln-file-chip" title="From ${esc(file.name)}">${esc(file.type.toUpperCase())}</span>` : ''}${actions}</li>`;
  }
  function topicsSection(s) {
    const data = topicsOf(s.id);
    let list;
    if (!data) list = '<p class="ln-soon">Loading topics…</p>';
    else if (data.error) list = `<p class="ln-soon">${esc(data.error)} <button class="link-btn" type="button" data-ln="topics-retry" data-id="${esc(s.id)}">Try again</button></p>`;
    else {
      const nums = TM.numbers(data.rows), counts = TM.segmentCounts(data.rows);
      TS.carried = TS.sel.size && L.page === s.id ? new Set(TM.blocksOf(data.rows, [...TS.sel])) : null;
      list = data.rows.length
        ? `<ol class="ln-topic-list" data-ln-list="${esc(s.id)}">${data.rows.map(row => topicRow(data, row, nums, counts)).join('')}</ol>`
        : `<p class="ln-soon ln-topics-empty">No topics yet. Upload or drop a PDF, Word, PowerPoint or image file here: each file becomes one topic, and its headings and pictures show in the key points.</p>`;
    }
    const files = data && data.files && data.files.length
      ? `<div class="ln-files" aria-label="Uploaded files">${data.files.map(f => `<span class="ln-file" title="${esc(f.name)} · ${f.topics} topic${f.topics === 1 ? '' : 's'}"><b>${esc(f.type.toUpperCase())}</b>${esc(f.name)}</span>`).join('')}</div>` : '';
    return `<section class="ln-block ln-topics${TS.fileOver ? ' file-over' : ''}" data-ln-topics="${esc(s.id)}" aria-labelledby="ln-topics-page">
      <div class="ln-topics-head">
        <h3 class="ln-block-title" id="ln-topics-page">Topics</h3>
        ${TS.sel.size && L.page === s.id ? `<span class="ln-topics-actions ln-sel-bar" role="toolbar" aria-label="Selected topics">
          <span class="ln-sel-count" aria-live="polite">${TS.sel.size} selected</span>
          <button class="btn btn-sm btn-ghost" type="button" data-ln="sel-clear" title="Clear selection (Esc)">Clear</button>
          <button class="btn btn-sm btn-danger" type="button" data-ln="sel-delete" data-id="${esc(s.id)}" title="Delete selected (Delete)">Delete</button>
        </span>` : `<span class="ln-topics-actions">
          <button class="btn btn-sm btn-ghost" type="button" data-ln="milestone-menu" data-id="${esc(s.id)}" aria-haspopup="menu">Milestone</button>
          <button class="btn btn-sm ln-upload" type="button" data-ln="upload" data-id="${esc(s.id)}"${TS.uploading ? ' disabled' : ''}>${UPLOAD}${TS.uploading ? 'Reading file…' : 'Upload topics'}</button>
        </span>`}
      </div>
      ${list}
      ${files}
      <div class="ln-drop-hint" aria-hidden="true">${UPLOAD}<span>Drop to add topics</span></div>
    </section>`;
  }
  /* Compact, read-only list for the preview panel. */
  function topicsPreview(s) {
    const data = topicsOf(s.id);
    let body;
    if (!data) body = '<p class="ln-soon">Loading topics…</p>';
    else if (data.error || !data.rows.length) body = `<p class="ln-soon">${data.error ? esc(data.error) : 'No topics yet. Open the subject to add or upload them.'}</p>`;
    else {
      const nums = TM.numbers(data.rows); const shown = data.rows.slice(0, 12);
      body = `<ol class="ln-mini-topics">${shown.map(r => r.kind === 'milestone'
        ? `<li class="ln-mini-ms">${esc(r.title)}</li>`
        : `<li class="lvl-${r.level}"><button class="ln-mini-open" type="button" data-ln="topic-open" data-id="${esc(r.id)}" data-subject="${esc(s.id)}" title="Open"><span class="ln-num">${nums.get(r.id)}</span><span class="ln-mini-title">${esc(r.title)}</span></button></li>`).join('')}</ol>
        ${data.rows.length > shown.length ? `<button class="link-btn ln-more-topics" type="button" data-ln="open-page" data-id="${esc(s.id)}">+${data.rows.length - shown.length} more</button>` : ''}`;
    }
    return `<section class="ln-block" aria-labelledby="ln-topics-panel"><h3 class="ln-block-title" id="ln-topics-panel">Topics</h3>${body}</section>`;
  }
  function placeholders(big = false) {
    return `<section class="ln-block" aria-labelledby="ln-stats-${big ? 'page' : 'panel'}">
        <h3 class="ln-block-title" id="ln-stats-${big ? 'page' : 'panel'}">Mastery Statistics</h3>
        <p class="ln-soon">Charts arrive with topics and study sessions.</p>
        <div class="ln-skel-charts" aria-hidden="true">
          <svg class="ln-skel-pie" viewBox="0 0 120 120"><circle cx="60" cy="60" r="44"/><path d="M60 16 A44 44 0 0 1 102 47 L60 60 Z"/><path d="M60 60 L102 47 A44 44 0 0 1 72 102 Z"/></svg>
          <svg class="ln-skel-bars" viewBox="0 0 140 90"><path d="M8 4 V84 H136"/><rect x="18" y="64" width="12" height="18"/><rect x="36" y="58" width="12" height="24"/><rect x="54" y="50" width="12" height="32"/><rect x="72" y="42" width="12" height="40"/><rect x="90" y="32" width="12" height="50"/><rect x="108" y="18" width="12" height="64"/></svg>
        </div>
      </section>`;
  }
  /* Preview panel info: name with its type label and the Learn button on one row, time spent under it, then the description. */
  function panelInfo(s) {
    return `<div class="ln-name-row">
        <div class="ln-name-group">
          <h2 class="ln-name"><button class="ln-name-link" type="button" data-ln="open-page" data-id="${esc(s.id)}" title="Open subject page">${esc(s.name)}</button></h2>
          <span class="ln-type ln-type-sm" title="Subject type">${typeLabel(s.type)}</span>
        </div>
        <button class="ln-learn" type="button" data-ln="learn" data-id="${esc(s.id)}">Learn</button>
      </div>
      <p class="ln-spent">${esc(spent(s.minutes))} · ${s.mastery}% mastery</p>
      <p class="ln-desc ln-panel-desc${s.description ? '' : ' empty-desc'}">${s.description ? esc(s.description) : 'No description yet.'}</p>`;
  }
  function panel() {
    const s = L.panel ? subject(L.preview) : null;
    if (!s) return '';
    return `<aside class="ln-panel${L.closing ? ' closing' : ''}" aria-label="Subject preview: ${esc(s.name)}">
      <div class="ln-cover"><button class="ln-cover-open" type="button" data-ln="open-page" data-id="${esc(s.id)}" aria-label="Open the ${esc(s.name)} subject page" title="Open subject page">${art(s, 'ln-cover-art')}</button>
        <button class="ln-panel-toggle" type="button" data-ln="close-panel" aria-label="Close preview" title="Close preview">${H.icon('panel')}</button>
      </div>
      <div class="ln-panel-body">
        ${panelInfo(s)}
        <hr class="ln-rule">
        ${topicsPreview(s)}
        ${placeholders(false)}
      </div>
    </aside>`;
  }
  function listView() {
    let body;
    if (L.status === 'loading' || L.status === 'idle') body = '<p class="empty">Loading subjects…</p>';
    else if (L.status === 'error') body = `<p class="empty">${esc(L.error)} <button class="link-btn" type="button" data-ln="retry">Try again</button></p>`;
    else body = `<div class="ln-grid" role="list">
        <button class="ln-pocket ln-add" type="button" data-ln="create" aria-label="Create subject" title="Create subject">${H.icon('plus')}</button>
        ${L.subjects.map(pocket).join('')}
      </div>
      ${L.subjects.length ? '' : '<p class="ln-hint">No subjects in this profile yet. Use + to create one.</p>'}`;
    return `<div class="ln-root ln-layout${L.panel && subject(L.preview) ? ' with-panel' : ''}">
      <div class="ln-main">
        <header class="ln-head">
          <h1 tabindex="-1">Learning</h1>
          <button class="ln-profile" type="button" data-ln="profile" aria-label="Learning profile: ${L.profile}. Switch to ${L.profile === 'study' ? 'personal' : 'study'}" title="Switch to ${L.profile === 'study' ? 'personal' : 'study'}">${PROFILES[L.profile]}</button>
        </header>
        <section class="ln-section" aria-labelledby="ln-subjects-title">
          <h2 class="ln-section-title" id="ln-subjects-title">Subjects</h2>
          ${body}
        </section>
      </div>
      ${panel()}
    </div>`;
  }
  function pageView(s) {
    return `<div class="ln-root ln-page">
      <div class="ln-page-bar">
        <button class="btn btn-sm btn-ghost" type="button" data-ln="back">${H.icon('left')}Learning</button>
        <span class="ln-crumb">${esc(PROFILES[L.profile])}</span>
        <span class="ln-page-actions">
          <button class="icon-btn" type="button" data-ln="edit" data-id="${esc(s.id)}" aria-label="Edit subject" title="Edit">${H.icon('edit')}</button>
          <button class="icon-btn" type="button" data-ln="delete" data-id="${esc(s.id)}" aria-label="Delete subject" title="Delete">${H.icon('trash')}</button>
        </span>
      </div>
      <div class="ln-page-cover">${art(s, 'ln-cover-art')}</div>
      <header class="ln-page-head">
        <div class="ln-page-title-line">
          <div class="ln-title-row">
            <h1 tabindex="-1">${esc(s.name)}</h1>
            <span class="ln-type" title="Subject type">${typeLabel(s.type)}</span>
          </div>
          <button class="ln-learn ln-learn-lg" type="button" data-ln="learn" data-id="${esc(s.id)}">Learn</button>
        </div>
        <p class="ln-desc${s.description ? '' : ' empty-desc'}">${s.description ? esc(s.description) : 'No description yet.'}</p>
        <p class="ln-page-stats">${s.mastery}% mastery · ${esc(spent(s.minutes))}</p>
      </header>
      <div class="ln-page-grid">${topicsSection(s)}${placeholders(true)}</div>
      <div data-qz-host></div>
    </div>`;
  }
  function render() {
    const v = L.viewer ? subject(L.viewer.subjectId) : null;
    if (v) return viewerView(v);
    const s = L.page ? subject(L.page) : null;
    return s ? pageView(s) : listView();
  }
  function mount() {
    const root = $('.ln-root'); if (!root) return;
    $$('[data-ln-img]', root).forEach(el => { el.style.backgroundImage = `url("${el.dataset.lnImg}")`; });
    $$('[data-ln-w]', root).forEach(el => { el.style.width = `${el.dataset.lnW}%`; });
    const quiz = $('[data-qz-host]', root); const quizSubject = quiz && L.page ? subject(L.page) : null;
    if (quiz && quizSubject && window.PerflwQuiz) window.PerflwQuiz.mount(quiz, quizSubject);
    if (L.focus) { const el = $(L.focus, root); if (el) el.focus(); L.focus = null; }
    if (L.viewer) { const box = $('[data-ln-doc]', root); if (box && PDFV) paintDoc(box); else annotate(); syncStudy(); }
  }

  // ───────── topic viewer: top bar (Learning · subject), topic navigator, the file itself, and two side panels
  /* PDFs (and the PDF copy Office makes of Word/PowerPoint files) open in Chromium's PDF viewer at the topic's page.
     Markdown/text files, and Word/PowerPoint files without a copy, are drawn here from their kept text. */
  const PDFV = window.PerflwPdfViewer || null; // in-app PDF viewer (learning-pdf.js)
  const ANN = window.PerflwAnnotate || null;   // study marks on the open file (learning-annotate.js)
  /* The study toolbar follows the file shown in the pane (none while a file is loading or has no page to mark). */
  function annotate() {
    const wrap = $('[data-ln-doc-wrap]'); if (!ANN || !wrap || !L.viewer) return;
    const t = currentTopic(); ANN.show(wrap, t && t.fileId ? t.fileId : null);
  }
  const FP = new Map(); // fileId → { url, text, preview, type, name } | { error } — what the main process said to show
  const norm = text => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  function viewerRows() { const d = topicsOf(L.viewer.subjectId); return d && d.rows ? d : null; }
  function currentTopic() { const d = viewerRows(); return d ? d.rows.find(r => r.id === L.viewer.topicId) || null : null; }
  function navHtml() {
    const d = viewerRows();
    if (!d) return '<p class="ln-soon ln-nav-note">Loading topics…</p>';
    if (!d.rows.length) return '<p class="ln-soon ln-nav-note">No topics yet.</p>';
    const nums = TM.numbers(d.rows);
    let html = ''; let open = false;
    const start = title => { html += `${open ? '</div>' : ''}<div class="ln-nav-seg">${title != null ? `<div class="ln-nav-ms">${esc(title)}</div>` : ''}`; open = true; };
    if (d.rows[0].kind !== 'milestone') start(null);
    for (const r of d.rows) {
      if (r.kind === 'milestone') { start(r.title); continue; }
      const active = r.id === L.viewer.topicId;
      html += `<button class="ln-nav-topic lvl-${r.level}${active ? ' active' : ''}" type="button" data-ln="viewer-topic" data-id="${esc(r.id)}"${active ? ' aria-current="true"' : ''} title="${esc(r.title)}"><span class="ln-num">${nums.get(r.id)}</span><span class="ln-nav-title">${esc(r.title)}</span></button>`;
    }
    return `${html}${open ? '</div>' : ''}`;
  }
  function inlineMd(text) {
    return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }
  /* Markdown files, and the kept text of Word/PowerPoint files, as a page. Lines that are a topic title become headings. */
  function readerHtml(info, titles) {
    const lines = String(info.text || '').split(/\r?\n/);
    const out = []; let list = null; let fence = null; let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of lines) {
      if (fence !== null) { if (/^\s*(```|~~~)/.test(raw)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(raw); continue; }
      const line = raw.trimEnd();
      if (/^\s*(```|~~~)/.test(line)) { flushPara(); closeList(); fence = []; continue; }
      if (!line.trim()) { flushPara(); closeList(); continue; }
      const h = info.type === 'md' && line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
      if (h) { flushPara(); closeList(); out.push(`<h${h[1].length} data-anchor>${inlineMd(h[2])}</h${h[1].length}>`); continue; }
      if (titles.has(norm(line))) { flushPara(); closeList(); out.push(`<h2 data-anchor>${inlineMd(line.trim())}</h2>`); continue; }
      const bullet = line.match(/^\s*[-*•]\s+(.+)$/), numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        flushPara(); const kind = bullet ? 'ul' : 'ol';
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inlineMd((bullet || numbered)[1])}</li>`); continue;
      }
      if (info.type !== 'md') { closeList(); out.push(`<p>${inlineMd(line)}</p>`); continue; }
      closeList(); para.push(line.trim());
    }
    if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
    flushPara(); closeList();
    return out.join('') || '<p class="ln-soon">This file has no readable text.</p>';
  }
  function docHtml() {
    const t = currentTopic();
    if (!viewerRows()) return '<div class="ln-doc-state"><span class="spinner" aria-hidden="true"></span><p>Loading…</p></div>';
    if (!t) return '<div class="ln-doc-state"><p>Choose a topic on the left.</p></div>';
    if (!t.fileId) return '<div class="ln-doc-state"><p>This topic has no file.</p></div>';
    const info = FP.get(t.fileId);
    if (!info) return '<div class="ln-doc-state"><span class="spinner" aria-hidden="true"></span><p>Opening the file…</p></div>';
    if (info.error) return `<div class="ln-doc-state"><p>${esc(info.error)}</p><button class="btn btn-sm btn-ghost" type="button" data-ln="viewer-reload">Try again</button></div>`;
    if (info.url) return PDFV ? '<div class="ln-doc-state"><span class="spinner" aria-hidden="true"></span><p>Opening the file…</p></div>'
      : `<iframe class="ln-pdf" src="${esc(info.url)}#page=${shownPage(t)}&toolbar=0&navpanes=0&view=FitH" title="${esc(info.name)}"></iframe>`;
    if (info.image) return `<figure class="ln-image-view"><img src="${esc(info.image)}" alt="${esc(info.name)}"></figure>`;
    const office = info.type === 'docx' ? 'Word' : info.type === 'pptx' ? 'PowerPoint' : '';
    if (office && info.preview === 'pending') return `<div class="ln-doc-state"><span class="spinner" aria-hidden="true"></span><p>Making an exact copy with Microsoft ${office}…</p><small>This takes a few seconds the first time.</small></div>`;
    const d = viewerRows();
    const titles = new Set(d.rows.filter(r => r.fileId === t.fileId).map(r => norm(r.title)));
    const notice = office ? `<div class="ln-doc-notice">Showing the text only: Microsoft ${office} could not make an exact copy of this file. <button class="link-btn" type="button" data-ln="viewer-retry" data-id="${esc(t.fileId)}">Try again</button></div>` : '';
    return `${notice}<article class="ln-reader">${readerHtml(info, titles)}</article>`;
  }
  function viewerView(s) {
    return `<div class="ln-root ln-viewer">
      <div class="ln-viewer-bar">
        <button class="ln-crumb-btn" type="button" data-ln="viewer-learning">${H.icon('left')}Learning</button>
        <button class="ln-subject-chip" type="button" data-ln="viewer-subject" title="Back to the subject page">${art(s, 'ln-chip-art')}<span>${esc(s.name)}</span></button>
        <button class="ln-side-open" type="button" data-ln="side-toggle" aria-label="${sideOpen ? 'Hide' : 'Show'} key points and chat" title="${sideOpen ? 'Hide' : 'Show'} key points and chat" aria-expanded="${sideOpen}">${PANEL_ICON}</button>
      </div>
      <div class="ln-viewer-body${sideOpen ? '' : ' side-off'}">
        <nav class="ln-nav" aria-label="Topics">${navHtml()}</nav>
        <div class="ln-doc-wrap" data-ln-doc-wrap><div class="ln-doc" data-ln-doc>${docHtml()}</div></div>
        <aside class="ln-side" aria-label="Key points and chat"${sideOpen ? '' : ' inert'}>${Study ? Study.html(studyContext()) : ''}</aside>
      </div>
    </div>`;
  }
  /* The AI side panel collapses to the right from one fixed button at the end of the viewer bar, which never moves
     while the panel is used. Only classes change, so the file, the thread and a streaming reply stay as they are. */
  function toggleSide(force = null) {
    const body = $('.ln-viewer-body'); if (!body) return;
    const next = force === null ? !sideOpen : Boolean(force);
    if (next === sideOpen) return;
    sideOpen = next;
    try { localStorage.setItem(SIDE_KEY, sideOpen ? 'open' : 'closed'); } catch { /* remembered for this session only */ }
    const side = $('.ln-side', body); const button = $('.ln-side-open');
    if (!sideOpen && side && side.contains(document.activeElement) && button) button.focus({ preventScroll: true });
    body.classList.toggle('side-off', !sideOpen);
    if (side) side.inert = !sideOpen;
    if (button) {
      const label = `${sideOpen ? 'Hide' : 'Show'} key points and chat`;
      button.setAttribute('aria-expanded', String(sideOpen)); button.setAttribute('aria-label', label); button.title = label;
    }
  }
  /* The notes and Ask panels (learning-study.js) follow the open topic. */
  const Study = window.PerflwLearningStudy || null;
  function studyContext() {
    const t = L.viewer ? currentTopic() : null;
    // The topic list's numbers for this file's topics (by title), so the notes panel numbers match the navigator.
    const d = t ? viewerRows() : null; const nums = d ? TM.numbers(d.rows) : null;
    const topicNumbers = d ? d.rows.filter(r => r.kind === 'topic' && r.fileId === t.fileId).map(r => [norm(r.title), nums.get(r.id)]) : [];
    return { subjectId: L.viewer.subjectId, fileId: t ? t.fileId : null, topicTitle: t ? t.title : '', topicPage: t ? (jumpedTo(t) || t.page) : null, jumped: Boolean(t && jumpedTo(t)), topicNumbers, openTopic: openTopicMatch, toast: (text, options) => H.toast(text, options) };
  }
  function syncStudy() { if (Study && L.viewer && $('.ln-viewer')) Study.sync(studyContext()); }
  /* A section or source in the study panels: the topic with that title (the open file first), else the open file's
     topic at or before that page. */
  function openTopicMatch(match) {
    const d = L.viewer && viewerRows(); if (!d || !match) return;
    const t = currentTopic();
    const fileId = match.fileId || (t && t.fileId) || null;
    const topics = d.rows.filter(r => r.kind === 'topic' && (!fileId || r.fileId === fileId));
    if (!topics.length) { H.toast('That file is no longer in this subject.', { error: true }); return; }
    const key = norm(match.title);
    const page = Number.isInteger(match.page) && match.page > 0 ? match.page : null;
    // The topic with that title in that file; else the file's topic at or before that page; else the file's first topic.
    const hit = topics.find(r => norm(r.title) === key)
      || (page ? topics.filter(r => Number.isInteger(r.page) && r.page <= page).sort((a, b) => b.page - a.page)[0] : null)
      || (t && t.fileId === fileId ? t : topics[0]);
    L.viewer.jump = { fileId, page, text: String(match.text || match.title || '') };
    if (hit.id !== L.viewer.topicId) openViewer(L.viewer.subjectId, hit.id, true);
    else { paintViewer('doc'); syncStudy(); }
  }
  /* Where the open file is shown at the moment: the topic's page, or the page a notes/source click asked for. */
  const jumpedTo = t => { const j = L.viewer && L.viewer.jump; return j && j.fileId === t.fileId && j.page ? j.page : null; };
  function shownPage(t) {
    const j = L.viewer && L.viewer.jump;
    if (j && j.fileId === t.fileId && j.page) return j.page;
    return Number.isInteger(t.page) && t.page > 0 ? t.page : 1;
  }
  /* Text pages: the block that holds the clicked key point (or source text) is scrolled to and highlighted. */
  function findText(reader, text) {
    const want = norm(text).slice(0, 80); if (!want) return null;
    const words = want.split(' ').filter(w => w.length > 3).slice(0, 8);
    let best = null; let bestScore = 0;
    for (const el of $$('p, li, h1, h2, h3, td, pre', reader)) {
      const has = norm(el.textContent);
      if (has.includes(want.slice(0, 40))) return el;
      const score = words.filter(w => has.includes(w)).length;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return bestScore >= Math.max(2, Math.ceil(words.length * 0.6)) ? best : null;
  }
  /* After the document paints: scroll a text page to the topic's heading. */
  function settleDoc() {
    const box = $('[data-ln-doc]'); const t = currentTopic(); if (!box || !t) return;
    const reader = $('.ln-reader', box); if (!reader) return;
    const j = L.viewer.jump;
    const spot = j && j.fileId === t.fileId && j.text ? findText(reader, j.text) : null;
    if (spot) {
      spot.scrollIntoView({ block: 'center' });
      $$('.ln-spot', reader).forEach(el => el.classList.remove('ln-spot'));
      spot.classList.add('ln-spot');
      return;
    }
    const hit = $$('[data-anchor]', reader).find(h => norm(h.textContent) === norm(t.title));
    if (hit) hit.scrollIntoView({ block: 'start' }); else box.scrollTop = 0;
  }
  function paintViewer(part = 'all') {
    if (!L.viewer || !visible() || !$('.ln-viewer')) return;
    if (part === 'all' || part === 'nav') { const nav = $('.ln-nav'); if (nav) { const top = nav.scrollTop; nav.innerHTML = navHtml(); nav.scrollTop = top; } }
    if (part === 'all' || part === 'doc') { const box = $('[data-ln-doc]'); if (box) paintDoc(box); }
  }
  /* The open file: a PDF goes to the in-app viewer, which keeps the document and only scrolls when the same file is
     shown again; anything else is drawn as HTML. */
  function paintDoc(box) {
    const t = currentTopic(); const info = t && t.fileId ? FP.get(t.fileId) : null;
    if (PDFV && info && info.url && !info.error) {
      const j = L.viewer.jump; const jumped = j && j.fileId === t.fileId;
      // A notes/source click lands on its exact text; a topic click on the topic's heading on its page.
      PDFV.show(box, t.fileId, { page: shownPage(t), text: jumped && j.text ? j.text : t.title });
      annotate();
      return;
    }
    if (PDFV) PDFV.release(box);
    box.innerHTML = docHtml(); settleDoc(); annotate();
  }
  async function loadFile(fileId, force = false) {
    if (!fileId || (!force && FP.has(fileId) && !FP.get(fileId).error)) return;
    if (force) FP.delete(fileId);
    try { FP.set(fileId, await api.filePreview(fileId)); }
    catch (error) { FP.set(fileId, { error: error.message || 'The file could not be opened.' }); }
    const t = L.viewer && currentTopic();
    if (t && t.fileId === fileId) paintViewer('doc');
  }
  async function openViewer(subjectId, topicId, keepJump = false) {
    if (!subject(subjectId)) return;
    closeMenu();
    const before = L.viewer && L.viewer.subjectId === subjectId ? currentTopic() : null;
    const jump = keepJump && L.viewer ? L.viewer.jump || null : null;
    L.viewer = { subjectId, topicId, jump }; L.page = subjectId; L.preview = subjectId;
    if ($('.ln-viewer')) {
      paintViewer('nav');
      const t = currentTopic();
      const info = t && t.fileId ? FP.get(t.fileId) : null;
      // Same text page: scroll to the heading. A PDF already open in the viewer just scrolls to the topic's page.
      if (before && t && before.fileId === t.fileId && info && !info.url && $('.ln-reader')) settleDoc();
      else paintViewer('doc');
      syncStudy();
    } else paint();
    await ensureTopics(subjectId);
    const t = currentTopic();
    if (t && t.fileId) loadFile(t.fileId);
    syncStudy();
  }
  /* Learn: open the subject's first topic in the viewer, or warn when nothing has been uploaded yet. */
  async function learn(subjectId, button) {
    if (button) button.disabled = true;
    try {
      await ensureTopics(subjectId);
      const d = topicsOf(subjectId);
      if (!d || d.error) { H.toast((d && d.error) || 'Topics could not be loaded.', { error: true }); return; }
      const first = d.rows.find(r => r.kind === 'topic');
      if (!first) { H.toast('Please upload a topic first.', { error: true }); return; }
      openViewer(subjectId, first.id);
    } finally { if (button && button.isConnected) button.disabled = false; }
  }
  function closeViewer(to) {
    const id = L.viewer ? L.viewer.subjectId : null;
    L.viewer = null;
    if (to === 'subject' && id && subject(id)) { L.page = id; L.focus = '.ln-page-head h1'; paint(); ensureTopics(id); }
    else { L.page = null; L.focus = id ? `[data-ln-subject="${CSS.escape(id)}"]` : null; paint(); }
  }

  // ───────── topics: data and actions
  async function ensureTopics(subjectId, force = false) {
    if (!force && T.has(subjectId) && !T.get(subjectId).error) return;
    try { T.set(subjectId, await api.topics(subjectId)); }
    catch (error) { T.set(subjectId, { error: error.message || 'Topics could not be loaded.' }); }
    paintTopics(subjectId);
  }
  /* Repaints only the topic areas that show this subject (page section and/or preview panel). */
  function paintTopics(subjectId) {
    const s = subject(subjectId); if (!s || !visible()) return;
    pruneSelection(subjectId);
    const section = $(`.ln-topics[data-ln-topics="${CSS.escape(subjectId)}"]`);
    if (section && L.page === subjectId) {
      const holder = document.createElement('div'); holder.innerHTML = topicsSection(s);
      section.replaceWith(holder.firstElementChild);
    }
    if (L.panel && L.preview === subjectId && !L.closing) syncPanel(false);
    if (L.viewer && L.viewer.subjectId === subjectId) { paintViewer('nav'); syncStudy(); }
    if (TS.focus) { const el = $(TS.focus); if (el) { el.focus(); if (el.select && TS.focus.includes('edit')) el.select(); } TS.focus = null; }
    if (TS.fresh.size) { const ids = [...TS.fresh]; setTimeout(() => { ids.forEach(id => TS.fresh.delete(id)); $$('.ln-new').forEach(el => el.classList.remove('ln-new')); }, 900); }
  }
  const rowSel = id => `[data-topic="${CSS.escape(id)}"]`;
  function setTopics(subjectId, data, focus) {
    T.set(subjectId, { rows: data.rows, files: data.files });
    if (focus) TS.focus = focus;
    paintTopics(subjectId);
  }
  function pruneSelection(subjectId) { const d = topicsOf(subjectId); if (!d || !d.rows) return; const live = new Set(d.rows.map(r => r.id)); for (const id of [...TS.sel]) if (!live.has(id)) TS.sel.delete(id); }
  async function topicCall(subjectId, work, focus) {
    try { const data = await work(); setTopics(subjectId, data, typeof focus === 'function' ? focus(data) : focus); return data; }
    catch (error) { H.toast(error.message || 'Topics could not be saved.', { error: true }); await ensureTopics(subjectId, true); return null; }
  }
  /* Topics come from files; this adds milestones. A custom milestone opens straight into rename. */
  async function addMilestone(subjectId, title, rename = false) {
    const data = await topicCall(subjectId, () => api.addTopic(subjectId, { kind: 'milestone', title }), data => {
      (data.added || []).forEach(id => TS.fresh.add(id));
      return data.added && data.added[0] ? rowSel(data.added[0]) : null;
    });
    if (rename && data && data.added && data.added[0]) startRename(data.added[0]);
  }
  /* Optimistic reorder / level change: show the new order at once, then save the whole order. */
  async function commitOrder(subjectId, rows, focusId) {
    const data = topicsOf(subjectId); if (!data || !data.rows) return;
    if (rows === data.rows || rows.map(r => `${r.id}:${r.level}`).join() === data.rows.map(r => `${r.id}:${r.level}`).join()) return;
    setTopics(subjectId, { rows, files: data.files }, focusId ? rowSel(focusId) : null);
    await topicCall(subjectId, () => api.saveTopicOrder(subjectId, rows.map(r => ({ id: r.id, level: r.level }))), focusId ? rowSel(focusId) : null);
  }
  function moveTopic(subjectId, id, beforeId) { const d = topicsOf(subjectId); if (d && d.rows) commitOrder(subjectId, TM.moveBefore(d.rows, id, beforeId), id); }
  function stepTopic(subjectId, id, dir) { const d = topicsOf(subjectId); if (d && d.rows) commitOrder(subjectId, TM.step(d.rows, id, dir), id); }
  function levelTopic(subjectId, id, level) {
    const d = topicsOf(subjectId); if (!d || !d.rows) return;
    const row = d.rows.find(r => r.id === id); if (!row || row.kind !== 'topic') return;
    if (level === undefined) level = row.level ? 0 : 1;
    const next = TM.setLevel(d.rows, id, level);
    if (level === 1 && next === d.rows) { H.toast(TM.blockOf(d.rows, id).length > 1 ? 'A topic with subtopics cannot become a subtopic.' : 'A subtopic needs a topic above it.'); return; }
    if (level === 1 && next.find(r => r.id === id).level === 0) { H.toast('A subtopic needs a topic above it.'); return; }
    commitOrder(subjectId, next, id);
  }
  async function deleteTopic(subjectId, id) {
    const d = topicsOf(subjectId); if (!d || !d.rows) return;
    const ids = TM.blockOf(d.rows, id); const row = d.rows.find(r => r.id === id); if (!row) return;
    if (ids.length > 1) {
      const n = TM.numbers(d.rows).get(id);
      const ok = await H.confirmDialog({ title: 'Delete topic?', text: `Topic ${n} “${row.title}” and its ${ids.length - 1} subtopic${ids.length === 2 ? '' : 's'} will be deleted. This cannot be undone.` });
      if (!ok) return;
    }
    const index = d.rows.findIndex(r => r.id === id);
    const neighbour = d.rows.slice(index + ids.length).find(Boolean) || d.rows.slice(0, index).pop();
    await topicCall(subjectId, () => api.deleteTopics(subjectId, ids), neighbour ? rowSel(neighbour.id) : `[data-ln-topics="${CSS.escape(subjectId)}"] [data-ln="upload"]`);
  }
  /* Multi-select on the subject page: Ctrl/Cmd+click toggles a row, Shift+click selects a range, a click on a row's
     free space selects only it. Space toggles the focused row, Shift+↑/↓ extends, Ctrl+A selects all, Esc clears. */
  function selectRow(subjectId, id, { toggle = false, range = false } = {}) {
    const d = topicsOf(subjectId); if (!d || !d.rows) return;
    if (range && TS.anchor && d.rows.some(r => r.id === TS.anchor)) {
      const ids = d.rows.map(r => r.id); const a = ids.indexOf(TS.anchor); const b = ids.indexOf(id);
      if (!toggle) TS.sel.clear();
      ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => TS.sel.add(x));
    } else if (toggle) { if (TS.sel.has(id)) TS.sel.delete(id); else TS.sel.add(id); TS.anchor = id; }
    else { TS.sel.clear(); TS.sel.add(id); TS.anchor = id; }
    TS.focus = rowSel(id); paintTopics(subjectId);
  }
  function clearSelection(subjectId, focusId) {
    if (!TS.sel.size) return false;
    TS.sel.clear(); TS.anchor = null; if (focusId) TS.focus = rowSel(focusId); paintTopics(subjectId);
    return true;
  }
  async function deleteSelected(subjectId) {
    const d = topicsOf(subjectId); if (!d || !d.rows || !TS.sel.size) return;
    const ids = TM.blocksOf(d.rows, [...TS.sel]);
    const topics = d.rows.filter(r => ids.includes(r.id) && r.kind === 'topic').length; const milestones = ids.length - topics;
    const parts = [topics ? `${topics} topic${topics === 1 ? '' : 's'}` : '', milestones ? `${milestones} milestone${milestones === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    if (ids.length > 1) {
      const ok = await H.confirmDialog({ title: `Delete ${parts}?`, text: `The selected ${parts} will be deleted, with any subtopics under them. A file goes too once none of its topics are left. This cannot be undone.` });
      if (!ok) return;
    }
    const last = d.rows.findIndex(r => r.id === ids[ids.length - 1]);
    const neighbour = d.rows.slice(last + 1).find(r => !ids.includes(r.id)) || d.rows.slice(0, last).reverse().find(r => !ids.includes(r.id));
    TS.sel.clear(); TS.anchor = null;
    await topicCall(subjectId, () => api.deleteTopics(subjectId, ids), neighbour ? rowSel(neighbour.id) : `[data-ln-topics="${CSS.escape(subjectId)}"] [data-ln="upload"]`);
  }
  function startRename(id) {
    TS.editing = id; TS.focus = `[data-ln-topic-edit="${CSS.escape(id)}"]`;
    paintTopics(L.page);
  }
  async function finishRename(input, save) {
    const id = input.dataset.lnTopicEdit; if (TS.editing !== id) return;
    TS.editing = null;
    const d = topicsOf(L.page); const row = d && d.rows && d.rows.find(r => r.id === id);
    const title = input.value.trim();
    if (!save || !row || !title || title === row.title) { TS.focus = rowSel(id); paintTopics(L.page); return; }
    row.title = TM.cleanTitle(title); // shown at once; the saved list replaces it
    await topicCall(L.page, () => api.renameTopic(id, title), rowSel(id));
  }
  /* Upload topics: with no files, the button opens the file picker; dropped files are read one after another. */
  async function upload(subjectId, files = null) {
    if (TS.uploading) return;
    TS.uploading = true; paintTopics(subjectId);
    let firstAdded = null;
    try {
      for (const job of files ? [...files] : [null]) {
        try {
          const result = job ? await api.importDroppedTopics(subjectId, job) : await api.uploadTopics(subjectId);
          if (!result) continue;
          result.added.forEach(id => TS.fresh.add(id));
          if (!firstAdded && result.added.length) firstAdded = result.added[0];
          const file = result.files.find(f => f.id === result.fileId);
          const name = file ? file.name : 'the file';
          T.set(subjectId, { rows: result.rows, files: result.files });
          H.toast(`Added ${name} as one topic. Its headings are in the key points.${result.note ? ` ${result.note}` : ''}`, { timeout: 6000 });
        } catch (error) { H.toast(`${job && job.name ? `${job.name}: ` : ''}${error.message || 'The file could not be added.'}`, { error: true }); }
      }
    } finally {
      TS.uploading = false; TS.focus = firstAdded ? rowSel(firstAdded) : null;
      paintTopics(subjectId);
    }
  }
  function openMilestoneMenu(anchor, subjectId) {
    const d = topicsOf(subjectId); const used = new Set(d && d.rows ? d.rows.filter(r => r.kind === 'milestone').map(r => r.title.toLowerCase()) : []);
    openMenu(anchor, subjectId, TM.MILESTONES.map(name => `<button class="menu-item" type="button" role="menuitem" data-ln="add-milestone" data-id="${esc(subjectId)}" data-value="${esc(name)}">${esc(name)}${used.has(name.toLowerCase()) ? '<small>added</small>' : ''}</button>`).join('')
      + `<button class="menu-item" type="button" role="menuitem" data-ln="custom-milestone" data-id="${esc(subjectId)}">Custom name…</button>`);
  }

  // drag and drop (rows are <li draggable>; a topic carries its subtopics)
  function dropTarget(event) {
    const list = event.target.closest && event.target.closest('[data-ln-list]'); if (!list || !TS.drag) return null;
    const subjectId = list.dataset.lnList; const d = topicsOf(subjectId); if (!d || !d.rows) return null;
    const rowEl = event.target.closest('[data-topic]');
    if (!rowEl) return { list, subjectId, beforeId: null, el: null, after: true };
    const rect = rowEl.getBoundingClientRect(); const after = event.clientY > rect.top + rect.height / 2;
    const id = rowEl.dataset.topic; let beforeId = id;
    if (after) {
      const moving = d.rows.find(r => r.id === TS.drag.id);
      const target = d.rows.find(r => r.id === id);
      const skipChildren = moving && !(moving.kind === 'topic' && moving.level === 1) && target.kind === 'topic' && target.level === 0;
      const block = skipChildren ? TM.blockOf(d.rows, id) : [id];
      const next = d.rows[d.rows.findIndex(r => r.id === block[block.length - 1]) + 1];
      beforeId = next ? next.id : null;
    }
    return { list, subjectId, beforeId, el: rowEl, after };
  }
  function clearDrop() { $$('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after')); }
  function onDragStart(event) {
    const row = event.target.closest && event.target.closest('[data-topic]');
    if (!row || !row.closest('[data-ln-list]')) return;
    const subjectId = row.closest('[data-ln-list]').dataset.lnList;
    const many = TS.sel.has(row.dataset.topic) && TS.sel.size > 1;
    TS.drag = { id: row.dataset.topic, subjectId, ids: many ? [...TS.sel] : null };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.dataset.topic);
    const d = topicsOf(subjectId);
    for (const id of many ? TM.blocksOf(d.rows, TS.drag.ids) : TM.blockOf(d.rows, row.dataset.topic)) { const el = $(rowSel(id)); if (el) el.classList.add('dragging'); }
  }
  // Files dragged in from outside the app: drop anywhere on the Topics card to upload them.
  const hasFiles = event => !TS.drag && visible() && event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  const fileCard = event => (event.target.closest ? event.target.closest('.ln-topics') : null);
  function setFileOver(card) {
    TS.fileOver = Boolean(card);
    $$('.ln-topics.file-over').forEach(el => { if (el !== card) el.classList.remove('file-over'); });
    if (card) card.classList.add('file-over');
  }
  function onFileDragOver(event) {
    const card = fileCard(event);
    event.preventDefault(); // never let a file drop navigate the window
    event.dataTransfer.dropEffect = card && !TS.uploading ? 'copy' : 'none';
    setFileOver(card && !TS.uploading ? card : null);
  }
  function onDragLeave(event) {
    if (!TS.fileOver) return;
    const card = fileCard(event);
    if (card && !card.contains(event.relatedTarget)) setFileOver(null);
  }
  function onDragOver(event) {
    if (hasFiles(event)) { onFileDragOver(event); return; }
    const target = dropTarget(event); if (!target || target.subjectId !== TS.drag.subjectId) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    clearDrop();
    if (target.el) target.el.classList.add(target.after ? 'drop-after' : 'drop-before');
    else { const last = target.list.lastElementChild; if (last) last.classList.add('drop-after'); }
  }
  function onDrop(event) {
    if (hasFiles(event)) {
      event.preventDefault();
      const card = fileCard(event); setFileOver(null);
      if (card && !TS.uploading && event.dataTransfer.files.length) upload(card.dataset.lnTopics, event.dataTransfer.files);
      return;
    }
    const target = dropTarget(event); if (!target || target.subjectId !== TS.drag.subjectId) return;
    event.preventDefault(); clearDrop();
    const { id, ids } = TS.drag; TS.drag = null;
    if (ids) { const d = topicsOf(target.subjectId); if (d && d.rows) commitOrder(target.subjectId, TM.moveManyBefore(d.rows, ids, target.beforeId), id); }
    else moveTopic(target.subjectId, id, target.beforeId);
  }
  function onDragEnd() { TS.drag = null; clearDrop(); $$('.dragging').forEach(el => el.classList.remove('dragging')); }

  // ───────── navigation between list, preview and page
  /* Preview changes only the panel and the pockets' selected state, never the grid itself, so the second click
     of a double-click lands on the same pocket element and the dblclick event still fires. */
  function syncPanel(animate) {
    const root = $('.ln-layout'); if (!root) return;
    $$('[data-ln-subject]', root).forEach(card => {
      const on = L.panel && card.dataset.lnSubject === L.preview;
      card.classList.toggle('selected', on); card.setAttribute('aria-pressed', String(on));
    });
    const old = $('.ln-panel', root);
    const html = panel();
    root.classList.toggle('with-panel', Boolean(html));
    if (!html) { if (old) old.remove(); return; }
    const holder = document.createElement('div'); holder.innerHTML = html;
    const aside = holder.firstElementChild;
    if (old) old.replaceWith(aside); else root.append(aside);
    $$('[data-ln-img]', aside).forEach(el => { el.style.backgroundImage = `url("${el.dataset.lnImg}")`; });
    if (animate && !old && !H.reduceMotion()) aside.classList.add('opening');
  }
  let closeTimer = null;
  function preview(id) {
    clearTimeout(closeTimer);
    if (L.preview === id && L.panel && !L.closing) return;
    L.preview = id; L.panel = true; L.closing = false;
    syncPanel(true);
    ensureTopics(id);
  }
  function closePanel() {
    const aside = $('.ln-panel');
    const finish = () => {
      L.panel = false; L.closing = false; syncPanel(false);
      const card = L.preview && $(`[data-ln-subject="${CSS.escape(L.preview)}"]`); if (card) card.focus();
    };
    if (!aside || H.reduceMotion()) { finish(); return; }
    L.closing = true;
    aside.classList.remove('opening'); aside.classList.add('closing');
    closeTimer = setTimeout(finish, 170);
  }
  function openPage(id) {
    if (!subject(id)) return;
    closeMenu();
    L.page = id; L.preview = id; L.viewer = null; L.focus = '.ln-page-head h1'; // the subject page, never a topic left open earlier
    TS.editing = null; TS.sel.clear(); TS.anchor = null;
    paint();
    ensureTopics(id);
  }
  function back() {
    const id = L.page; L.page = null; L.focus = id ? `[data-ln-subject="${CSS.escape(id)}"]` : null;
    paint();
  }
  async function switchProfile() {
    L.profile = L.profile === 'study' ? 'personal' : 'study';
    try { localStorage.setItem(PROFILE_KEY, L.profile); } catch { /* ignore */ }
    L.preview = null; L.panel = false; L.page = null; L.viewer = null; L.focus = '[data-ln="profile"]';
    L.status = 'loading'; paint(); if (H.refreshNav) H.refreshNav();
    await load(); paint();
  }

  // ───────── ⋯ menu
  let menu = null;
  function closeMenu() {
    if (!menu) return;
    const { el, anchor } = menu; menu = null; el.remove();
    if (anchor && anchor.isConnected) anchor.setAttribute('aria-expanded', 'false');
  }
  function openMenu(anchor, id, html = null) {
    if (menu && menu.id === id && menu.anchor === anchor) { closeMenu(); return; }
    closeMenu();
    const el = document.createElement('div');
    el.className = 'menu ln-menu'; el.setAttribute('role', 'menu');
    el.innerHTML = html || `<button class="menu-item" type="button" role="menuitem" data-ln="edit" data-id="${esc(id)}">${H.icon('edit')}Edit</button>
      <button class="menu-item danger" type="button" role="menuitem" data-ln="delete" data-id="${esc(id)}">${H.icon('trash')}Delete</button>`;
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - el.offsetWidth - 8, r.left);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 6)}px`;
    anchor.setAttribute('aria-expanded', 'true');
    menu = { el, anchor, id };
    $('.menu-item', el).focus();
  }

  // ───────── create / edit dialog
  let dialog = null;
  /* Closing plays the panel back toward where it came from; instant (a reset, a new dialog) removes it at once.
     A timer, not animationend, removes it, so reduced motion (no animation at all) still cleans up. */
  const DIALOG_OUT_MS = 170;
  function closeDialog({ instant = false } = {}) {
    if (!dialog) return;
    const { el, previous } = dialog; dialog = null;
    if (instant || !el.isConnected) el.remove();
    else {
      // A closing panel is no longer the dialog: it drops its form hook and ids so a new panel never collides with it.
      el.classList.add('closing');
      el.querySelectorAll('[data-ln-form], [id]').forEach(node => { node.removeAttribute('data-ln-form'); node.removeAttribute('id'); });
      el.querySelectorAll('[data-ln]').forEach(node => node.removeAttribute('data-ln'));
      setTimeout(() => el.remove(), DIALOG_OUT_MS);
    }
    if (previous && previous.isConnected) previous.focus({ preventScroll: true });
  }
  function hoursOf(minutes) { return Math.floor((minutes || 0) / 60); }
  function openDialog(id = null) {
    closeMenu(); closeDialog({ instant: true });
    const s = id ? subject(id) : null;
    const draft = { imageName: s ? s.imageName : null, image: s ? s.image : null, type: s ? s.type : 'major' };
    const el = document.createElement('div');
    el.className = 'overlay ln-overlay';
    // New subject: image, name, type and description. Mastery and time spent start at 0 and are edited later.
    el.innerHTML = `<form class="confirm-box ln-dialog" role="dialog" aria-modal="true" aria-labelledby="ln-dialog-title" data-ln-form novalidate>
      <h2 id="ln-dialog-title" class="ln-dialog-title">${s ? 'Edit Subject' : 'New Subject'}</h2>
      <div class="ln-dialog-head">
        <div class="ln-image-slot">
          <button class="ln-image-pick" type="button" data-ln="pick-image" data-ln-preview aria-label="Choose image" title="Choose image"></button>
          <button class="ln-image-clear" type="button" data-ln="clear-image" aria-label="Remove image" title="Remove image">${H.icon('x')}</button>
        </div>
        <div class="ln-dialog-fields">
          <label class="ln-field"><span>Subject name</span><input class="field" name="name" maxlength="120" required autocomplete="off" value="${esc(s ? s.name : '')}"></label>
          <div class="ln-field"><span id="ln-type-label">Subject type</span>
            <div class="toggle-track ln-type-track" role="radiogroup" aria-labelledby="ln-type-label"><span class="ln-type-thumb" aria-hidden="true"></span>${TYPES.map(([v, label]) => `<button class="toggle-pill" type="button" role="radio" data-ln="type" data-value="${v}">${label}</button>`).join('')}</div>
          </div>
        </div>
      </div>
      ${s ? `<div class="ln-field-row">
        <label class="ln-field"><span>Mastery %</span><input class="field" name="mastery" type="number" min="0" max="100" step="1" inputmode="numeric" value="${s.mastery}"></label>
        <div class="ln-field"><span id="ln-time-label">Time spent</span>
          <span class="ln-time" role="group" aria-labelledby="ln-time-label">
            <input class="field" name="hours" type="number" min="0" step="1" inputmode="numeric" aria-label="Hours" value="${hoursOf(s.minutes)}"><small>h</small>
            <input class="field" name="minutes" type="number" min="0" max="59" step="1" inputmode="numeric" aria-label="Minutes" value="${s.minutes % 60}"><small>m</small>
          </span>
        </div>
      </div>` : ''}
      <label class="ln-field"><span>Description</span><textarea class="field field-area" name="description" rows="4" maxlength="2000">${esc(s ? s.description : '')}</textarea></label>
      <p class="ln-error" role="alert" data-ln-error></p>
      <div class="confirm-actions"><button class="btn btn-ghost" type="button" data-ln="cancel">Cancel</button><button class="btn" type="submit">${s ? 'Save' : 'Create'}</button></div>
    </form>`;
    const previous = document.activeElement;
    document.body.append(el);
    const form = $('form', el);
    // The panel grows out of what opened it (the + pocket, or the subject being edited) and returns there on close.
    const from = (id ? $(`[data-ln-subject="${CSS.escape(id)}"]`) : $('[data-ln="create"]')) || previous;
    if (from && from.isConnected && from !== document.body) {
      const r = from.getBoundingClientRect();
      form.style.transformOrigin = `${Math.round(r.left + r.width / 2 - form.offsetLeft)}px ${Math.round(r.top + r.height / 2 - form.offsetTop)}px`;
    }
    [...form.children].forEach((child, i) => child.style.setProperty('--i', i));
    dialog = { el, id, draft, previous, busy: false };
    paintDraft();
    requestAnimationFrame(() => { if (dialog && dialog.el === el) el.classList.add('ready'); }); // thumb slides only after the first paint
    $('input[name="name"]', el).focus({ preventScroll: true });
  }
  /* Restarts a one-shot CSS animation class on an element. */
  function replay(node, cls) { if (!node) return; node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); }
  function paintDraft() {
    if (!dialog) return;
    const { el, draft } = dialog;
    const box = $('[data-ln-preview]', el);
    box.classList.toggle('has-img', !!draft.image);
    box.style.backgroundImage = draft.image ? `url("${draft.image}")` : '';
    box.innerHTML = `<span class="ln-image-icon">${H.icon(draft.image ? 'edit' : 'plus')}</span>`;
    box.setAttribute('aria-label', draft.image ? 'Change image' : 'Choose image'); box.title = box.getAttribute('aria-label');
    // A new or removed image pops in place; the first paint does not.
    if ('shown' in dialog && dialog.shown !== (draft.image || null)) replay(box, 'swap');
    dialog.shown = draft.image || null;
    $('.ln-image-slot', el).classList.toggle('has-img', !!draft.image);
    $('[data-ln="clear-image"]', el).hidden = !draft.image;
    let active = null;
    $$('[data-ln="type"]', el).forEach(b => { const on = b.dataset.value === draft.type; if (on) active = b; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    // One thumb slides between Major and Minor instead of two backgrounds swapping.
    const thumb = $('.ln-type-thumb', el);
    if (thumb && active) { thumb.style.width = `${active.offsetWidth}px`; thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`; }
  }
  function whole(value, label, max) {
    const text = String(value).trim();
    if (!/^\d+$/.test(text) || Number(text) > max) throw new Error(`${label} must be a whole number from 0 to ${max}.`);
    return Number(text);
  }
  async function submitDialog() {
    if (!dialog || dialog.busy) return;
    const { el, id, draft } = dialog;
    const form = $('form', el);
    const error = $('[data-ln-error]', el);
    let payload;
    try {
      const name = form.name.value.trim();
      if (!name) { form.name.focus(); replay(form.name, 'invalid'); throw new Error('Give the subject a name.'); }
      // Mastery and time spent are on the edit panel only; a new subject starts at 0.
      const minutes = form.hours ? whole(form.hours.value || '0', 'Hours', 16000) * 60 + whole(form.minutes.value || '0', 'Minutes', 59) : 0;
      payload = { name, type: draft.type, mastery: form.mastery ? whole(form.mastery.value || '0', 'Mastery', 100) : 0, minutes, description: form.description.value, imageName: draft.imageName };
    } catch (problem) { error.textContent = problem.message; replay(error, 'shake'); return; }
    dialog.busy = true; error.textContent = '';
    const submit = $('button[type="submit"]', el); submit.disabled = true;
    try {
      const saved = id ? await api.updateSubject(id, payload) : await api.createSubject(L.profile, payload);
      if (id) L.subjects = L.subjects.map(s => (s.id === id ? saved : s)); else L.subjects.push(saved);
      closeDialog();
      if (!id) { L.preview = saved.id; L.panel = true; L.fresh = saved.id; L.focus = `[data-ln-subject="${CSS.escape(saved.id)}"]`; }
      paint();
      L.fresh = null; // the new pocket pops in once, not on every repaint
      H.toast(id ? 'Subject saved.' : 'Subject created.');
    } catch (problem) {
      if (dialog) { dialog.busy = false; submit.disabled = false; error.textContent = problem.message || 'The subject could not be saved.'; replay(error, 'shake'); }
    }
  }
  async function pickImage() {
    if (!dialog) return;
    try {
      const picked = await api.pickImage();
      if (picked && dialog) { dialog.draft.imageName = picked.imageName; dialog.draft.image = picked.image; paintDraft(); }
    } catch (problem) { if (dialog) $('[data-ln-error]', dialog.el).textContent = problem.message || 'That image could not be used.'; }
  }
  async function remove(id) {
    closeMenu();
    const s = subject(id); if (!s) return;
    const ok = await H.confirmDialog({ title: 'Delete subject?', text: `“${s.name}” and its details will be deleted. This cannot be undone.` });
    if (!ok) return;
    try {
      await api.deleteSubject(id);
      L.subjects = L.subjects.filter(x => x.id !== id);
      T.delete(id);
      if (window.PerflwLearningStudy) window.PerflwLearningStudy.forget(id);
      if (L.viewer && L.viewer.subjectId === id) L.viewer = null;
      if (L.preview === id) { L.preview = null; L.panel = false; }
      if (L.page === id) L.page = null;
      paint();
      H.toast('Subject deleted.');
    } catch (problem) { H.toast(problem.message || 'The subject could not be deleted.', { error: true }); }
  }

  // ───────── events (bound once on the document, like the other modules)
  function onClick(event) {
    if (menu && !event.target.closest('.ln-menu') && !event.target.closest('[data-ln="menu"]')) closeMenu();
    if (dialog && event.target === dialog.el) { closeDialog(); return; }
    // Topic rows on the subject page: Ctrl/Cmd/Shift+click selects instead of opening; a click on free space selects.
    const rowEl = L.page && event.target.closest ? event.target.closest('[data-ln-list] [data-topic]') : null;
    if (rowEl && !event.target.closest('.ln-row-actions, input')) {
      const multi = event.ctrlKey || event.metaKey; const range = event.shiftKey;
      if (multi || range || !event.target.closest('[data-ln]')) { event.preventDefault(); selectRow(L.page, rowEl.dataset.topic, { toggle: multi, range }); return; }
    }
    if (L.page && TS.sel.size && !event.target.closest('[data-ln-list], .ln-sel-bar, .overlay, .menu')) clearSelection(L.page);
    const control = event.target.closest('[data-ln]');
    if (control) {
      const id = control.dataset.id;
      switch (control.dataset.ln) {
        case 'sel-clear': clearSelection(L.page); return;
        case 'sel-delete': deleteSelected(id); return;
        case 'create': openDialog(); return;
        case 'menu': event.stopPropagation(); openMenu(control, id); return;
        case 'upload': upload(id); return;
        case 'milestone-menu': openMilestoneMenu(control, id); return;
        case 'add-milestone': closeMenu(); addMilestone(id, control.dataset.value); return;
        case 'custom-milestone': closeMenu(); addMilestone(id, 'New milestone', true); return;
        case 'topic-rename': if (!TS.editing) startRename(id); return;
        case 'topic-open': openViewer(control.dataset.subject || L.page, id); return;
        case 'learn': learn(id, control); return;
        case 'viewer-topic': L.viewer.jump = null; openViewer(L.viewer.subjectId, id); return;
        case 'viewer-learning': closeViewer('list'); return;
        case 'side-toggle': toggleSide(); return;
        case 'viewer-subject': closeViewer('subject'); return;
        case 'viewer-reload': { const t = currentTopic(); if (t && t.fileId) { FP.delete(t.fileId); if (PDFV) PDFV.forget(t.fileId); paintViewer('doc'); loadFile(t.fileId, true); } return; }
        case 'viewer-retry': FP.set(id, { ...(FP.get(id) || {}), preview: 'pending', url: null }); paintViewer('doc'); api.retryPreview(id).catch(() => loadFile(id, true)); return;
        case 'topic-level': levelTopic(L.page, id); return;
        case 'topic-delete': deleteTopic(L.page, id); return;
        case 'topics-retry': ensureTopics(id, true); return;
        case 'edit': openDialog(id); return;
        case 'delete': remove(id); return;
        case 'close-panel': closePanel(); return;
        case 'open-page': openPage(id); return;
        case 'back': back(); return;
        case 'profile': switchProfile(); return;
        case 'retry': load().then(paint); return;
        case 'cancel': closeDialog(); return;
        case 'pick-image': pickImage(); return;
        case 'clear-image': if (dialog) { dialog.draft.imageName = null; dialog.draft.image = null; paintDraft(); } return;
        case 'type': if (dialog) { dialog.draft.type = control.dataset.value; paintDraft(); } return;
        default: return;
      }
    }
    const card = event.target.closest('[data-ln-subject]');
    if (card && event.detail <= 1) preview(card.dataset.lnSubject);
  }
  function onDblClick(event) {
    const card = event.target.closest('[data-ln-subject]');
    if (card && !event.target.closest('[data-ln="menu"]')) openPage(card.dataset.lnSubject);
  }
  function onKey(event) {
    if (dialog) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog(); return; }
      if (event.key === 'Tab') {
        const items = $$('button:not([disabled]):not([hidden]), input, textarea', dialog.el).filter(x => x.tabIndex !== -1);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target.dataset && event.target.dataset.ln === 'type') {
        event.preventDefault();
        dialog.draft.type = dialog.draft.type === 'major' ? 'minor' : 'major'; paintDraft();
        $(`[data-ln="type"][data-value="${dialog.draft.type}"]`, dialog.el).focus();
      }
      return;
    }
    if (menu) {
      const items = $$('.menu-item', menu.el); const at = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); const a = menu.anchor; closeMenu(); if (a && a.isConnected) a.focus(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); items[(at + 1) % items.length].focus(); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); return; }
      return;
    }
    if (!visible()) return;
    // Rename field: Enter saves, Escape cancels
    if (event.target.dataset && event.target.dataset.lnTopicEdit) {
      if (event.key === 'Enter') { event.preventDefault(); finishRename(event.target, true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishRename(event.target, false); }
      return;
    }
    // Focused topic row: Alt+↑/↓ move, Alt+→/← subtopic/topic, Enter or F2 rename, Delete removes
    const topicEl = event.target.matches && event.target.matches('[data-topic]') ? event.target : null;
    if (topicEl && L.page) {
      const id = topicEl.dataset.topic;
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); stepTopic(L.page, id, event.key === 'ArrowUp' ? -1 : 1); return; }
      if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) { event.preventDefault(); levelTopic(L.page, id, event.key === 'ArrowRight' ? 1 : 0); return; }
      if (event.key === 'F2') { event.preventDefault(); startRename(id); return; }
      if (event.key === 'Enter') { event.preventDefault(); if (topicEl.classList.contains('ln-milestone')) startRename(id); else openViewer(L.page, id); return; }
      if (event.key === 'Delete') { event.preventDefault(); if (TS.sel.size && (TS.sel.has(id) || TS.sel.size > 1)) deleteSelected(L.page); else deleteTopic(L.page, id); return; }
      if (event.key === ' ' && !event.altKey) { event.preventDefault(); selectRow(L.page, id, { toggle: true }); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault(); const d = topicsOf(L.page); if (d && d.rows) { d.rows.forEach(r => TS.sel.add(r.id)); TS.focus = rowSel(id); paintTopics(L.page); } return;
      }
      if (event.key === 'Escape' && TS.sel.size) { event.preventDefault(); event.stopPropagation(); clearSelection(L.page, id); return; }
      if (event.shiftKey && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const rows = $$('[data-topic]', topicEl.parentElement); const next = rows[rows.indexOf(topicEl) + (event.key === 'ArrowUp' ? -1 : 1)];
        if (next) { event.preventDefault(); if (!TS.anchor) TS.anchor = id; selectRow(L.page, next.dataset.topic, { range: true }); }
        return;
      }
      if (!event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const rows = $$('[data-topic]', topicEl.parentElement); const i = rows.indexOf(topicEl);
        const next = rows[i + (event.key === 'ArrowUp' ? -1 : 1)]; if (next) { event.preventDefault(); next.focus(); }
        return;
      }
    }
    const card = event.target.closest && event.target.closest('[data-ln-subject]');
    if (card && event.target === card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      const id = card.dataset.lnSubject;
      if (event.key === 'Enter' && L.panel && L.preview === id) openPage(id); else preview(id);
      return;
    }
    if (event.key === 'Escape' && event.target.matches && event.target.matches('[data-ls-input]')) return; // the Ask field blurs first
    if (event.key === 'Escape' && !document.querySelector('.overlay:not([hidden]):not(.ln-overlay)')) {
      if (L.viewer) { event.preventDefault(); closeViewer('subject'); }
      else if (L.page && TS.sel.size) { event.preventDefault(); clearSelection(L.page); }
      else if (L.page) { event.preventDefault(); back(); }
      else if (L.panel) { event.preventDefault(); closePanel(); }
    }
  }
  function onInput(event) {
    if (dialog && dialog.el.contains(event.target)) { $('[data-ln-error]', dialog.el).textContent = ''; event.target.classList.remove('invalid'); }
  }
  function onSubmit(event) {
    if (!event.target.matches('[data-ln-form]')) return;
    event.preventDefault(); submitDialog();
  }
  function onFocusOut(event) {
    if (event.target.dataset && event.target.dataset.lnTopicEdit && TS.editing === event.target.dataset.lnTopicEdit) finishRename(event.target, true);
  }

  function init(helpers) {
    H = helpers;
    if (window.PerflwQuiz) window.PerflwQuiz.init(helpers);
    document.addEventListener('click', onClick);
    document.addEventListener('dblclick', onDblClick);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('input', onInput);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', onDragEnd);
    document.addEventListener('dragleave', onDragLeave);
    // Office finished (or failed) a PDF copy: show it if that file is open.
    // Word's copy also brings each topic's page, so the open subject's topics reload first.
    if (api.onPreviewChanged) api.onPreviewChanged(async fileId => {
      const open = L.viewer ? L.viewer.subjectId : L.page;
      if (open && T.has(open)) await ensureTopics(open, true);
      if (PDFV) PDFV.forget(fileId);
      if (FP.has(fileId)) loadFile(fileId, true);
    });
    window.addEventListener('resize', closeMenu);
  }

  /* Sidebar / rail / search click on Learning: always the main page (subjects), never a subject page or topic
     left open. Already on Learning: repaint in place. From another view: the state is reset and go() renders it. */
  function home() {
    closeMenu(); closeDialog({ instant: true });
    if (!L.page && !L.viewer) return;
    L.page = null; L.viewer = null; TS.editing = null;
    if (visible()) paint();
  }

  window.PerflwLearning = {
    init, load, reset, render, mount, home,
    profile: () => L.profile,
    list: () => L.subjects.slice(),
    open: id => { if (subject(id)) { L.page = id; L.preview = id; } },
    openSide: () => toggleSide(true),
    toast: (text, error = false) => H.toast(text, error ? { error: true } : undefined),
    create: () => openDialog()
  };
})();

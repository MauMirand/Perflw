'use strict';
/* Learning topic viewer — the two study panels on the right (renderer).

   Notes panel: the open file's title and its key points numbered 1, 1.1, 1.2 … from the Learning document
   workflow's pre-analysis, the AI overview when the Learning Document Analyzer has written one, and a Notes tab with
   the notes saved from answers. The section of the open topic is highlighted.
   Ask panel: questions to the Learning Subject Assistant. Answers come only from the subject's File Data and
   Information Center; each answer lists its sources, a second broader run happens automatically, and a question the
   files do not cover gets the warning instead of an invented answer.

   learning.js owns the viewer and calls: html(ctx) when it renders, sync(ctx) when the topic changes.
   ctx = { subjectId, fileId, topicTitle, topicPage, topicNumbers, openTopic({ title, page, fileId, text }), toast }. Data goes through window.learningData. */
(function () {
  const api = window.learningData;
  if (!api || !api.analysis) return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const norm = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const SVG = {
    file: '<path d="M6 2.5h5.5L15 6v11.5H6z"/><path d="M11.5 2.5V6H15"/><path d="M8.5 10h4M8.5 13h4"/>',
    send: '<path d="M10 15.5V4.5M5.5 9 10 4.5 14.5 9"/>',
    stop: '<rect x="6" y="6" width="8" height="8" rx="1.5"/>',
    close: '<path d="m6 6 8 8M14 6l-8 8"/>',
    warn: '<path d="M10 3.5 17 16H3z"/><path d="M10 8.5v3.5M10 14.2v.1"/>',
    image: '<rect x="3.5" y="4.5" width="13" height="11" rx="2"/><circle cx="8" cy="8.5" r="1.3"/><path d="m4 14 4-3.5 3 2.5 2.5-2 3 3"/>',
    check: '<path d="m5 10.5 3.2 3.2L15 7"/>',
    spark: '<path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.2 5.2l2 2M12.8 12.8l2 2M5.2 14.8l2-2M12.8 7.2l2-2"/>'
  };
  const icon = name => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name]}</svg>`;

  const A = new Map();   // fileId → analysis | { status: 'pending' | 'failed' } | { error }
  const N = new Map();   // subjectId → saved notes
  const C = new Map();   // subjectId → [{ id, question, status, answer, sources, notes, warning, stage, live, runs, mode, notice, agent }]
  const S = { ctx: null, tab: 'points', busy: null, draft: new Map(), prefs: null };

  // ───────── data
  async function loadAnalysis(fileId, force = false) {
    if (!fileId || (!force && A.has(fileId) && A.get(fileId).status === 'ready')) return;
    try { A.set(fileId, await api.analysis(fileId)); } catch (error) { A.set(fileId, { status: 'error', error: error.message || 'The key points could not be loaded.' }); }
    if (S.ctx && S.ctx.fileId === fileId) paintNotes();
  }
  async function loadPrefs() {
    try { S.prefs = await api.preferences(); } catch { S.prefs = []; }
    if (S.ctx && S.tab === 'notes') paintNotesBody();
  }
  async function loadNotes(subjectId) {
    try { N.set(subjectId, await api.notes(subjectId)); } catch { N.set(subjectId, []); }
    if (S.ctx && S.ctx.subjectId === subjectId) { paintTabs(); if (S.tab === 'notes') paintNotesBody(); }
  }

  // ───────── notes panel
  function currentSection(a) {
    const ctx = S.ctx; if (!ctx || !a.sections) return null;
    const title = norm(ctx.topicTitle);
    const jumped = Boolean(ctx.jumped);
    return (!jumped && a.sections.find(s => s.number && norm(s.title) === title))
      || (ctx.topicPage ? [...a.sections].reverse().find(s => s.number && s.page && s.page <= ctx.topicPage) : null) || null;
  }
  /* Section numbers as the topic navigator shows them: a section whose title is a topic takes that topic's number;
     a deeper section keeps its place under the nearest numbered parent (2.1 → 2.1.1). Otherwise the file's own. */
  function displayNumbers(a) {
    const map = new Map(((S.ctx && S.ctx.topicNumbers) || []).map(([title, n]) => [norm(title), n])); const out = new Map(); const used = new Set();
    for (const s of a.sections) {
      if (!s.number) continue;
      const own = map.get(norm(s.title));
      if (own && !used.has(own)) { out.set(s.number, String(own)); used.add(own); continue; }
      const parts = s.number.split('.');
      let shown = null;
      for (let i = parts.length - 1; i > 0 && !shown; i--) { const parent = out.get(parts.slice(0, i).join('.')); if (parent && parent !== parts.slice(0, i).join('.')) shown = `${parent}.${parts.slice(i).join('.')}`; }
      out.set(s.number, shown || s.number);
    }
    return out;
  }
  /* Everything read from a section's pictures. Open when the picture is all the section has. */
  function pictureHtml(s) {
    if (!s.picture || !s.picture.length) return '';
    const open = !s.description && !s.keyPoints.length;
    const lines = s.picture.map(line => line.startsWith('### ') ? `<li class="ls-pic-h3">${esc(line.slice(4))}</li>` : line.startsWith('## ') ? `<li class="ls-pic-h">${esc(line.slice(3))}</li>` : line.startsWith('- ') ? `<li class="ls-pic-li">${esc(line.slice(2))}</li>` : `<li class="ls-pic-p">${esc(line)}</li>`).join('');
    return `<details class="ls-pic"${open ? ' open' : ''}><summary>${icon('image')}From the picture<span class="ls-pic-n">${s.picture.length}</span></summary><ul>${lines}</ul></details>`;
  }
  function pointsHtml(a) {
    if (!a) return '<div class="ls-state"><span class="spinner" aria-hidden="true"></span><p>Loading key points…</p></div>';
    if (a.status === 'pending') return '<div class="ls-state" data-ls-state="pending"><span class="spinner" aria-hidden="true"></span><p>Analyzing this file…</p><small>Converting it and gathering its key points.</small></div>';
    if (a.status === 'failed' || a.status === 'error') return `<div class="ls-state"><p>${esc(a.error || 'This file could not be analyzed.')}</p><button class="btn btn-sm btn-ghost" type="button" data-ls="reanalyze">Try again</button></div>`;
    const active = currentSection(a);
    const head = `<header class="ls-doc-head"><h3 class="ls-doc-title" title="${esc(a.title)}">${esc(a.title)}</h3><p class="ls-doc-meta">${esc(a.sources[a.sources.length - 1] || '')}${a.sources.length > 1 ? ` · ${a.sources.length} versions` : ''}${a.structure === 'ai' ? ' · headings found by AI' : ''}${a.images && a.images.read ? ` · ${a.images.read} picture${a.images.read === 1 ? '' : 's'} read` : ''}</p>${a.images && a.images.error && a.images.total > a.images.read ? `<p class="ls-doc-warn">${esc(`${a.images.total - a.images.read} picture${a.images.total - a.images.read === 1 ? '' : 's'} not read. ${a.images.error}`)}</p>` : ''}</header>`;
    let overview = '';
    if (a.enrichment && a.enrichment.overview) overview = `<section class="ls-overview" aria-label="AI overview"><p class="ls-label">${icon('spark')}AI overview</p><p>${esc(a.enrichment.overview)}</p></section>`;
    else if (a.images && a.images.reading) overview = `<p class="ls-overview-wait"><span class="spinner" aria-hidden="true"></span>Reading pictures ${Math.min(a.images.reading.done + 1, a.images.reading.total)} of ${a.images.reading.total}…</p>`;
    else if (a.structuring) overview = '<p class="ls-overview-wait"><span class="spinner" aria-hidden="true"></span>Finding the headings in this file…</p>';
    else if (a.enrichStatus === 'running' || a.enrichStatus === 'pending') overview = '<p class="ls-overview-wait"><span class="spinner" aria-hidden="true"></span>Writing the AI overview…</p>';
    // Little or no text: the headings (bookmarks, slide titles) still navigate the file; only a file with none says so.
    if (a.empty && !a.sections.some(s => s.number)) return `${head}${overview}<p class="ls-empty">${a.images && (a.images.reading || a.images.total > a.images.read) ? 'The text of this file is in its pictures.' : 'No readable text was found in this file.'}</p>`;
    const shown = displayNumbers(a);
    const rows = a.sections.filter(s => s.number || s.description || s.keyPoints.length).map(s => {
      const on = active && s.number === active.number;
      const points = s.keyPoints.map(p => `<li><button class="ls-point" type="button" data-ls="point" data-title="${esc(s.title)}" data-page="${s.page || ''}" data-text="${esc(p)}" title="Show this in the file">${esc(p)}</button></li>`).join('');
      return `<li class="ls-sec lvl-${Math.max(1, s.level)}${on ? ' current' : ''}"${on ? ' aria-current="true"' : ''} data-ls-sec="${esc(s.number)}">
        <button class="ls-sec-head" type="button" data-ls="section" data-title="${esc(s.title)}" data-page="${s.page || ''}" data-text="${esc(s.description || s.title)}" title="Show this part of the file">${s.number ? `<span class="ls-num">${esc(shown.get(s.number) || s.number)}</span>` : ''}<span class="ls-sec-title">${esc(s.title)}</span></button>
        ${s.description ? `<p class="ls-desc">${esc(s.description)}</p>` : ''}${points ? `<ul class="ls-points">${points}</ul>` : ''}${pictureHtml(s)}</li>`;
    }).join('');
    return `${head}${overview}<ol class="ls-secs">${rows}</ol>`;
  }
  function notesListHtml() {
    const ctx = S.ctx; const notes = ctx ? N.get(ctx.subjectId) : null;
    if (!notes) return '<div class="ls-state"><span class="spinner" aria-hidden="true"></span></div>';
    const prefs = S.prefs || [];
    const prefsHtml = prefs.length ? `<section class="ls-prefs" aria-label="Answer preferences"><p class="ls-label">Answer preferences · all subjects</p><ul class="ls-notes">${prefs.map(p => `<li class="ls-note pref"><p>${esc(p.text)}</p><button class="ls-icon-btn ls-note-del" type="button" data-ls="pref-delete" data-id="${esc(p.id)}" aria-label="Delete preference" title="Delete preference">${icon('close')}</button></li>`).join('')}</ul></section>` : '';
    if (!notes.length) return `${prefsHtml}<p class="ls-empty">Notes from your answers appear here. Ask a question below to start.</p>`;
    return `${prefsHtml}<ul class="ls-notes">${notes.map(n => `<li class="ls-note${n.origin === 'user' ? ' mine' : ''}"><p>${esc(n.text)}</p><small>${esc(n.origin === 'user' ? 'From you' : (n.sources || []).join(', ') || 'From an answer')}</small><button class="ls-icon-btn ls-note-del" type="button" data-ls="note-delete" data-id="${esc(n.id)}" aria-label="Delete note" title="Delete note">${icon('close')}</button></li>`).join('')}</ul>`;
  }
  function tabsHtml() {
    const count = S.ctx && N.get(S.ctx.subjectId) ? N.get(S.ctx.subjectId).length : 0;
    const a = S.ctx && S.ctx.fileId ? A.get(S.ctx.fileId) : null;
    return `<div class="ls-tabs" role="tablist" aria-label="Notes panel">
        <button class="ls-tab${S.tab === 'points' ? ' on' : ''}" type="button" role="tab" aria-selected="${S.tab === 'points'}" data-ls="tab" data-tab="points">Key points</button>
        <button class="ls-tab${S.tab === 'notes' ? ' on' : ''}" type="button" role="tab" aria-selected="${S.tab === 'notes'}" data-ls="tab" data-tab="notes">Notes${count ? ` <span class="ls-count">${count}</span>` : ''}</button>
      </div>
      <button class="ls-icon-btn" type="button" data-ls="open-md" data-doc="${esc(S.tab === 'points' && a && a.docId ? a.docId : '')}" title="${S.tab === 'points' && a && a.docId ? 'Open this file’s notes (.md)' : 'Open the subject information center (.md)'}" aria-label="Open notes file">${icon('file')}</button>`;
  }
  function paintTabs() { const bar = $('[data-ls-tabs]'); if (bar) bar.innerHTML = tabsHtml(); }
  function paintNotesBody() {
    const body = $('[data-ls-notes-body]'); if (!body || !S.ctx) return;
    const top = body.scrollTop;
    body.innerHTML = S.tab === 'notes' ? notesListHtml() : S.ctx.fileId ? pointsHtml(A.get(S.ctx.fileId)) : '<p class="ls-empty">This topic has no file.</p>';
    body.scrollTop = top;
  }
  function paintNotes() { paintTabs(); paintNotesBody(); revealCurrent(); }
  function revealCurrent() {
    const body = $('[data-ls-notes-body]'); const row = body && $('.ls-sec.current', body);
    if (row) { const b = body.getBoundingClientRect(); const r = row.getBoundingClientRect(); if (r.top < b.top || r.top > b.bottom - 40) body.scrollTop += r.top - b.top - 8; }
  }

  // ───────── ask panel
  const convo = () => (S.ctx ? C.get(S.ctx.subjectId) || [] : []);
  function liveAnswer(raw) {
    const text = String(raw || '');
    if (/^\s*NOT_IN_FILE/.test(text)) return '';
    // While the first characters stream in, "ANS…" or "NOT_…" is the start of the reply's label, not the answer.
    const head = text.trimStart().toUpperCase();
    if (head.length < 12 && ('ANSWER:'.startsWith(head) || 'NOT_IN_FILE'.startsWith(head))) return '';
    const start = text.search(/ANSWER:/i);
    const body = start >= 0 ? text.slice(start + 7) : /^\s*(ANSWER|NOT)/i.test(text) ? '' : text;
    return body.split(/\n\s*NOTES?:/i)[0].trim();
  }
  function cite(text, sources) {
    const labels = new Set((sources || []).map(s => s.label));
    return esc(text).replace(/\n/g, '<br>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d{1,2})\]/g, (all, n) => (labels.has(Number(n)) ? `<button class="ls-cite" type="button" data-ls="cite" data-n="${n}" title="Show source ${n}">${n}</button>` : ''));
  }
  function turnHtml(turn) {
    const q = `<p class="ls-q">${esc(turn.question)}</p>`;
    if (turn.fresh) { delete turn.fresh; return turnHtml(turn).replace('class="ls-turn"', 'class="ls-turn is-new"'); }
    if (turn.status === 'working') {
      const live = liveAnswer(turn.live);
      return `<li class="ls-turn" data-turn="${esc(turn.id)}">${q}<div class="ls-a working">${live ? `<p class="ls-live">${esc(live)}</p>` : ''}<p class="ls-stage"><span class="spinner" aria-hidden="true"></span><span class="ls-stage-label">${esc(turn.stage || 'Starting')}…</span></p></div></li>`;
    }
    if (turn.status === 'not-found' || turn.status === 'error' || turn.status === 'cancelled') {
      return `<li class="ls-turn" data-turn="${esc(turn.id)}">${q}<div class="ls-a ${turn.status === 'cancelled' ? 'muted' : 'warn'}" role="${turn.status === 'cancelled' ? 'status' : 'alert'}">${turn.status === 'cancelled' ? '' : icon('warn')}<p>${esc(turn.warning || turn.error || 'Stopped.')}</p></div>${turn.status === 'not-found' && turn.runs === 2 ? '<p class="ls-meta">Checked twice: the open file, then every file of this subject.</p>' : ''}</li>`;
    }
    if (turn.kind === 'learn' && turn.suggestion) {
      const label = turn.suggestion.kind === 'preference' ? 'Save preference' : 'Save to notes';
      const action = turn.saved ? `<p class="ls-saved">${icon('check')}${turn.suggestion.kind === 'preference' ? 'Preference saved' : 'Saved to your notes'}</p>`
        : `<div class="ls-actions"><button class="ls-chip primary" type="button" data-ls="learn-save" data-turn="${esc(turn.id)}">${label}</button></div>`;
      return `<li class="ls-turn" data-turn="${esc(turn.id)}">${q}<div class="ls-a"><p>${esc(turn.answer)}</p><blockquote class="ls-learn">${esc(turn.suggestion.text)}</blockquote>${action}</div></li>`;
    }
    const sources = (turn.sources || []).map(s => `<li><button class="ls-src" type="button" data-ls="source" data-turn="${esc(turn.id)}" data-n="${s.label}" title="Open this part of the file"><span class="ls-src-n">${s.label}</span><span class="ls-src-t">${esc(s.docTitle)} › ${esc(String(s.heading || '').replace(/^\d+(\.\d+)*\s+/, ''))}${s.page ? ` · ${/\.pptx$/i.test(s.fileName) ? 'slide' : 'p.'} ${s.page}` : ''}</span></button></li>`).join('');
    const meta = turn.kind === 'chat' ? '' : [turn.followUp ? 'Follow-up' : '', turn.runs === 2 ? 'Found on the 2nd run' : '', turn.notes && turn.notes.length ? `<button class="link-btn" type="button" data-ls="tab" data-tab="notes">${turn.notes.length} note${turn.notes.length === 1 ? '' : 's'} saved</button>` : '', turn.agent ? esc(turn.agent.model) : ''].filter(Boolean).join(' · ');
    // Only the latest answer offers "Explain more" and "Simpler": they ask a follow-up about it.
    const latest = turn.kind !== 'chat' && turn.id === lastAnswered();
    const more = latest && !S.busy ? `<div class="ls-actions"><button class="ls-chip" type="button" data-ls="suggest" data-q="Explain that in more detail">Explain more</button><button class="ls-chip" type="button" data-ls="suggest" data-q="Explain that more simply">Simpler</button></div>` : '';
    return `<li class="ls-turn" data-turn="${esc(turn.id)}">${q}<div class="ls-a">${turn.notice ? `<p class="ls-notice">${esc(turn.notice)} Showing the matching text from your files.</p>` : ''}<p>${cite(turn.answer, turn.sources)}</p>${sources ? `<ol class="ls-srcs" aria-label="Sources">${sources}</ol>` : ''}</div>${meta ? `<p class="ls-meta">${meta}</p>` : ''}${more}</li>`;
  }
  function lastAnswered() { const list = convo().filter(t => t.status === 'answered' && t.kind !== 'chat' && t.kind !== 'learn'); return list.length ? list[list.length - 1].id : null; }
  function threadHtml() {
    const turns = convo();
    if (!turns.length) return `<div class="ls-ask-empty"><p>Ask about this subject’s files. Answers use only what is in them.</p><div class="ls-actions center"><button class="ls-chip" type="button" data-ls="suggest" data-q="Summarize this file">Summarize this file</button>${S.ctx && S.ctx.topicTitle ? `<button class="ls-chip" type="button" data-ls="suggest" data-q="${esc(`Explain ${S.ctx.topicTitle} simply`)}">Explain this topic simply</button>` : ''}</div><p class="ls-hint">You can also tell me things that are not in the file, like “my prof said …” or “keep answers short”.</p></div>`;
    return `<ol class="ls-thread">${turns.map(turnHtml).join('')}</ol>`;
  }
  function paintThread(scroll = true) {
    const box = $('[data-ls-thread]'); if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = threadHtml();
    if (scroll || atBottom) box.scrollTop = box.scrollHeight;
  }
  function paintComposer() {
    const btn = $('[data-ls="send"]'); const field = $('[data-ls-input]'); if (!btn || !field) return;
    const working = Boolean(S.busy);
    btn.innerHTML = icon(working ? 'stop' : 'send');
    btn.setAttribute('aria-label', working ? 'Stop' : 'Ask'); btn.title = working ? 'Stop' : 'Ask (Enter)';
    btn.classList.toggle('stop', working);
    btn.disabled = !working && !field.value.trim();
  }
  function grow(field) { field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, 96)}px`; }

  async function ask(question) {
    const ctx = S.ctx; const q = String(question || '').trim();
    if (!ctx || !q || S.busy) return;
    const turn = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, question: q, status: 'working', stage: 'Searching the information center', live: '', fresh: true };
    // The answered turns on screen are what the assistant may remember for a follow-up question.
    const history = (C.get(ctx.subjectId) || []).filter(t => t.status === 'answered' && t.kind !== 'chat').map(t => t.id);
    if (!C.has(ctx.subjectId)) C.set(ctx.subjectId, []);
    C.get(ctx.subjectId).push(turn);
    S.busy = { requestId: turn.id, subjectId: ctx.subjectId };
    S.draft.set(ctx.subjectId, '');
    const field = $('[data-ls-input]'); if (field) { field.value = ''; grow(field); }
    const list = $('[data-ls-thread] .ls-thread');
    if (list) { list.insertAdjacentHTML('beforeend', turnHtml(turn)); const box = $('[data-ls-thread]'); box.scrollTop = box.scrollHeight; } else paintThread();
    paintComposer();
    try {
      const result = await api.ask(ctx.subjectId, ctx.fileId || null, q, turn.id, history);
      Object.assign(turn, result, { live: '' });
      if (result.status === 'answered' && result.notes && result.notes.length) {
        const list = N.get(ctx.subjectId) || [];
        N.set(ctx.subjectId, [...result.notes, ...list]);
        if (S.ctx && S.ctx.subjectId === ctx.subjectId) { paintTabs(); if (S.tab === 'notes') paintNotesBody(); flashTab(); }
      }
    } catch (error) {
      Object.assign(turn, { status: 'error', error: error.message || 'The question could not be answered.' });
    } finally {
      S.busy = null;
      if (S.ctx && S.ctx.subjectId === ctx.subjectId) { if (!replaceTurn(turn)) paintThread(false); paintComposer(); const f = $('[data-ls-input]'); if (f && document.activeElement === document.body) f.focus(); }
    }
  }
  function flashTab() {
    const tab = $('[data-tab="notes"].ls-tab'); if (!tab || S.tab === 'notes') return;
    tab.classList.remove('flash'); void tab.offsetWidth; tab.classList.add('flash');
  }
  function stop() { if (S.busy) api.cancelAsk(S.busy.requestId).catch(() => {}); }
  function openSource(source) {
    if (!S.ctx || !source || typeof S.ctx.openTopic !== 'function') return;
    if (source.docId === 'your-notes') { S.tab = 'notes'; if (!N.has(S.ctx.subjectId)) loadNotes(S.ctx.subjectId); paintNotes(); return; }
    S.ctx.openTopic({ title: String(source.heading || '').replace(/^\d+(\.\d+)*\s+/, ''), page: source.page || null, fileId: source.fileId || null, text: String(source.text || '').replace(/^- /, '').split('\n')[0] });
  }

  // ───────── events (delegated; only inside the study panels)
  function onClick(event) {
    const control = event.target.closest('[data-ls]');
    if (!control || !control.closest('.ln-side')) return;
    const ctx = S.ctx; if (!ctx) return;
    switch (control.dataset.ls) {
      case 'tab': S.tab = control.dataset.tab === 'notes' ? 'notes' : 'points'; if (S.tab === 'notes' && !N.has(ctx.subjectId)) loadNotes(ctx.subjectId); if (S.tab === 'notes' && !S.prefs) loadPrefs(); paintNotes(); return;
      case 'reanalyze': if (ctx.fileId) { A.set(ctx.fileId, { status: 'pending' }); paintNotes(); api.reanalyze(ctx.fileId).catch(error => { A.set(ctx.fileId, { status: 'error', error: error.message }); paintNotes(); }); } return;
      case 'open-md': api.openNotesFile(ctx.subjectId, control.dataset.doc || null).catch(error => ctx.toast && ctx.toast(error.message || 'The notes file could not be opened.', { error: true })); return;
      case 'section': case 'point': if (typeof ctx.openTopic === 'function') ctx.openTopic({ title: control.dataset.title, page: Number(control.dataset.page) || null, fileId: ctx.fileId, text: control.dataset.text }); return;
      case 'note-delete': {
        const id = control.dataset.id;
        N.set(ctx.subjectId, (N.get(ctx.subjectId) || []).filter(n => n.id !== id)); paintNotes();
        api.deleteNote(ctx.subjectId, id).then(list => { N.set(ctx.subjectId, list); paintNotes(); }).catch(() => loadNotes(ctx.subjectId));
        return;
      }
      case 'suggest': ask(control.dataset.q); return;
      case 'learn-save': {
        const turn = convo().find(t => t.id === control.dataset.turn); if (!turn || !turn.suggestion || turn.saved) return;
        control.disabled = true;
        api.saveLearned(ctx.subjectId, turn.suggestion).then(result => {
          turn.saved = true;
          if (result.kind === 'preference') S.prefs = result.preferences; else N.set(ctx.subjectId, result.notes);
          if (!replaceTurn(turn)) paintThread(false);
          paintTabs(); if (S.tab === 'notes') paintNotesBody(); else flashTab();
        }).catch(error => { control.disabled = false; ctx.toast && ctx.toast(error.message || 'That could not be saved.', { error: true }); });
        return;
      }
      case 'pref-delete': {
        const id = control.dataset.id;
        S.prefs = (S.prefs || []).filter(p => p.id !== id); paintNotesBody();
        api.deletePreference(id).then(list => { S.prefs = list; paintNotesBody(); }).catch(() => loadPrefs());
        return;
      }
      case 'send': if (S.busy) stop(); else { const f = $('[data-ls-input]'); ask(f && f.value); } return;
      case 'cite': case 'source': {
        const turnEl = control.closest('[data-turn]'); const turn = convo().find(t => t.id === (control.dataset.turn || (turnEl && turnEl.dataset.turn)));
        const source = turn && (turn.sources || []).find(s => s.label === Number(control.dataset.n));
        openSource(source); return;
      }
      default: return;
    }
  }
  function onKey(event) {
    if (!event.target.matches || !event.target.matches('[data-ls-input]')) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!S.busy) ask(event.target.value); }
    else if (event.key === 'Escape') { event.stopPropagation(); event.target.blur(); }
  }
  function onInput(event) {
    if (!event.target.matches || !event.target.matches('[data-ls-input]')) return;
    if (S.ctx) S.draft.set(S.ctx.subjectId, event.target.value);
    grow(event.target); paintComposer();
  }
  function onIntel(event) {
    if (!event || !event.fileId) return;
    const known = A.get(event.fileId);
    if (event.status === 'pending' && known && known.status !== 'ready') { A.set(event.fileId, { status: 'pending' }); if (S.ctx && S.ctx.fileId === event.fileId) paintNotes(); return; }
    if (S.ctx && S.ctx.fileId === event.fileId) loadAnalysis(event.fileId, true); else A.delete(event.fileId);
  }
  /* The finished turn takes the place of its working row; the rest of the thread is left alone (no flash). Keeps
     the reader at the bottom only if they were there. */
  function replaceTurn(turn) {
    const el = $(`[data-turn="${CSS.escape(turn.id)}"]`); const box = $('[data-ls-thread]'); if (!el || !box) return false;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const holder = document.createElement('div'); holder.innerHTML = turnHtml(turn);
    el.replaceWith(holder.firstElementChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
    return true;
  }
  /* Streaming: the working row keeps its elements; only the live text and the stage label change, at most once per
     frame, so nothing re-animates or blinks while tokens arrive. */
  let frame = 0;
  function paintLive(turn) {
    const el = $(`[data-turn="${CSS.escape(turn.id)}"]`); const box = $('[data-ls-thread]');
    const answer = el && $('.ls-a.working', el); if (!answer) return;
    const atBottom = box && box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const live = liveAnswer(turn.live);
    let text = $('.ls-live', answer);
    if (live) {
      if (!text) { text = document.createElement('p'); text.className = 'ls-live'; answer.prepend(text); }
      if (text.textContent !== live) text.textContent = live;
    } else if (text) text.remove();
    const stage = $('.ls-stage-label', answer); const label = `${turn.stage || 'Starting'}…`;
    if (stage && stage.textContent !== label) stage.textContent = label;
    if (box && atBottom) box.scrollTop = box.scrollHeight;
  }
  function onAsk(event) {
    if (!S.busy || event.requestId !== S.busy.requestId) return;
    const turn = (C.get(S.busy.subjectId) || []).find(t => t.id === event.requestId); if (!turn || turn.status !== 'working') return;
    if (event.type === 'stage') turn.stage = event.label;
    if (event.type === 'delta') turn.live = event.text;
    if (event.type === 'stage' && event.stage === 'retry') turn.live = '';
    if (!S.ctx || S.ctx.subjectId !== S.busy.subjectId || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; if (turn.status === 'working') paintLive(turn); });
  }

  // ───────── called by learning.js
  function html(ctx) {
    S.ctx = ctx;
    const draft = S.draft.get(ctx.subjectId) || '';
    return `<section class="ln-side-panel ln-side-notes" aria-label="Notes">
        <div class="ls-bar" data-ls-tabs>${tabsHtml()}</div>
        <div class="ls-body" data-ls-notes-body>${S.tab === 'notes' ? notesListHtml() : ctx.fileId ? pointsHtml(A.get(ctx.fileId)) : '<p class="ls-empty">This topic has no file.</p>'}</div>
      </section>
      <section class="ln-side-panel ln-side-ask" aria-label="Ask">
        <div class="ls-thread-box" data-ls-thread aria-live="polite">${threadHtml()}</div>
        <div class="ls-compose">
          <textarea class="ls-input" data-ls-input rows="1" maxlength="2000" placeholder="Ask about this subject’s files" aria-label="Ask a question about this subject’s files">${esc(draft)}</textarea>
          <button class="ls-send${S.busy ? ' stop' : ''}" type="button" data-ls="send" aria-label="${S.busy ? 'Stop' : 'Ask'}" title="${S.busy ? 'Stop' : 'Ask (Enter)'}"${!S.busy && !draft.trim() ? ' disabled' : ''}>${icon(S.busy ? 'stop' : 'send')}</button>
        </div>
      </section>`;
  }
  /* After the viewer painted the panels, or when the open topic changed. */
  function sync(ctx) {
    const subjectChanged = !S.ctx || S.ctx.subjectId !== ctx.subjectId;
    S.ctx = ctx;
    if (!$('.ln-side-notes')) return;
    if (subjectChanged) paintThread();
    if (ctx.fileId) loadAnalysis(ctx.fileId);
    if (!N.has(ctx.subjectId)) loadNotes(ctx.subjectId);
    paintNotes();
    const box = $('[data-ls-thread]'); if (box) box.scrollTop = box.scrollHeight;
    const field = $('[data-ls-input]'); if (field) grow(field);
  }
  function reset() { A.clear(); N.clear(); C.clear(); S.draft.clear(); S.ctx = null; S.tab = 'points'; if (S.busy) stop(); S.busy = null; }
  function forget(subjectId) { N.delete(subjectId); C.delete(subjectId); S.draft.delete(subjectId); }

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('input', onInput);
  if (api.onIntelEvent) api.onIntelEvent(onIntel);
  if (api.onAskEvent) api.onAskEvent(onAsk);
  window.PerflwLearningStudy = { html, sync, reset, forget, fileChanged: fileId => { A.delete(fileId); } };
})();

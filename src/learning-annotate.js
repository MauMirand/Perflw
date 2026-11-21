'use strict';
/* Learning topic viewer — study marks on the open file (renderer).

   A small toolbar at the lower left of the file: Select (V), Note (N), Pen (P: pen, highlighter, eraser and colours)
   and Comment (C). Marks sit on a layer over each PDF page (or over a text page) and are stored per file as
   fractions of the page, so they stay in place at any width. A comment is drawn as a box around an area; its text can
   be kept as a note to self or sent to Chat as a question about the text inside the box.

   learning.js calls PerflwAnnotate.show(wrap, fileId) whenever the file pane is painted, and PerflwAnnotate.reset()
   on sign-out. Marks are read and saved through window.learningData.annotations / saveAnnotations. */
(function () {
  const api = window.learningData;
  if (!api || !api.annotations) return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const NS = 'http://www.w3.org/2000/svg';

  const SVG = {
    cursor: '<path d="M5 3.5 15.5 9l-4.6 1.4L9 15z"/>',
    note: '<path d="M4.5 4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5l-5 5H5.5a1 1 0 0 1-1-1z"/><path d="M15.5 11h-4a1 1 0 0 0-1 1v4"/>',
    pen: '<path d="M13.5 3.5 16.5 6.5 7 16H4v-3z"/><path d="m11.5 5.5 3 3"/>',
    highlighter: '<path d="m12.5 3.5 4 4-6.5 6.5h-4v-4z"/><path d="M6 14 3.5 16.5h5"/>',
    eraser: '<path d="m8 16 8.5-8.5-4-4L4 12l4 4z"/><path d="M8 16h8.5M6.2 9.8l4 4"/>',
    comment: '<path d="M10 3.5c3.9 0 6.5 2.5 6.5 5.7s-2.6 5.7-6.5 5.7c-.9 0-1.7-.1-2.5-.4L4 16l.8-3.2c-.8-1-1.3-2.2-1.3-3.6 0-3.2 2.6-5.7 6.5-5.7z"/>',
    commentFill: '<path fill="currentColor" stroke-width="1.4" d="M10 3.2c4.1 0 6.9 2.6 6.9 6s-2.8 6-6.9 6c-.9 0-1.8-.1-2.6-.4L3.6 16.6l.9-3.5c-.9-1.1-1.4-2.4-1.4-3.9 0-3.4 2.8-6 6.9-6z"/><path stroke="#6242B7" stroke-width="1.8" d="M7 8.5h6M7 11h4"/>',
    trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 10h6.6L14 6"/>',
    send: '<path d="M10 15.5V4.5M5.5 9 10 4.5 14.5 9"/>',
    check: '<path d="m5 10.5 3.2 3.2L15 7"/>'
  };
  const icon = (name, width = 1.6) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name]}</svg>`;
  const COLORS = { pen: ['#1F2937', '#2563EB', '#DC2626', '#16A34A'], highlighter: ['#F5C542', '#7DD3FC', '#86EFAC', '#F9A8D4'] };
  const NOTE_COLOR = '#FDE68A';

  const S = {
    wrap: null, fileId: null, data: null, loading: null,
    tool: 'cursor', pen: 'pen', color: { pen: COLORS.pen[0], highlighter: COLORS.highlighter[0] },
    undo: [], saveTimer: 0, pop: null, drag: null, observer: null, skipClick: false
  };

  // ───────── data
  async function load(fileId) {
    const token = S.loading = uid();
    let data;
    try { data = await api.annotations(fileId); } catch { data = null; }
    if (S.loading !== token || S.fileId !== fileId) return;
    S.data = data || { notes: [], strokes: [], comments: [] };
    paintAll();
  }
  const MAX_SAVE = 3.8 * 1024 * 1024; // the main process refuses more than 4 MB per file
  function send(fileId, data) {
    if (JSON.stringify(data).length > MAX_SAVE) {
      if (!S.tooBig) { S.tooBig = true; toast('This file has too many marks to save. Erase some drawings; new marks are not saved until then.', true); }
      return Promise.resolve(false);
    }
    S.tooBig = false;
    return api.saveAnnotations(fileId, data).then(() => true, error => { toast(error.message || 'Your marks could not be saved.', true); return false; });
  }
  function save() {
    clearTimeout(S.saveTimer);
    const fileId = S.fileId; const data = S.data; if (!fileId || !data) return;
    S.saveTimer = setTimeout(() => { S.saveTimer = 0; send(fileId, data); }, 350);
  }
  /* Writes now (sign-out, another file, closing the window): an open note or comment keeps what was typed first. */
  function flush() {
    if (S.pop) closePop();
    if (!S.saveTimer || !S.fileId || !S.data) return Promise.resolve(true);
    clearTimeout(S.saveTimer); S.saveTimer = 0;
    return send(S.fileId, S.data);
  }
  function toast(text, error = false) { if (window.PerflwLearning && window.PerflwLearning.toast) window.PerflwLearning.toast(text, error); }

  // ───────── layers: one per PDF page (data-page = n) or one over a text page (page 0)
  function anchors() {
    if (!S.wrap) return [];
    const box = $('[data-ln-doc]', S.wrap); if (!box) return [];
    const pages = $$('.ln-pdfv-page', box);
    if (pages.length) return pages.map(el => ({ el, page: Number(el.dataset.page) || 1 }));
    const reader = $('.ln-reader', box);
    return reader ? [{ el: reader, page: 0 }] : [];
  }
  function layerFor(el, page) {
    let layer = $(':scope > .ann-layer', el);
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'ann-layer'; layer.dataset.page = String(page);
      layer.innerHTML = `<svg class="ann-ink" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"></svg><div class="ann-items"></div>`;
      el.appendChild(layer);
      paintLayer(layer, page);
    }
    return layer;
  }
  function ensureLayers() { for (const { el, page } of anchors()) layerFor(el, page); syncBar(); }
  function paintAll() { for (const { el, page } of anchors()) paintLayer(layerFor(el, page), page); syncBar(); }
  function pathOf(points) { return points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(''); }
  function strokeEl(st) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', pathOf(st.points));
    path.setAttribute('class', `ann-stroke ${st.tool}`);
    path.setAttribute('stroke', st.color);
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.dataset.stroke = st.id;
    return path;
  }
  function paintLayer(layer, page) {
    if (!S.data) return;
    const ink = $('.ann-ink', layer); const items = $('.ann-items', layer);
    ink.replaceChildren(...S.data.strokes.filter(st => st.page === page).map(strokeEl));
    items.innerHTML = [
      ...S.data.comments.filter(c => c.page === page).map(commentHtml),
      ...S.data.notes.filter(n => n.page === page).map(noteHtml)
    ].join('');
    $$('[data-pos]', items).forEach(el => { const [x, y, w, h] = el.dataset.pos.split(',').map(Number); el.style.left = `${x * 100}%`; el.style.top = `${y * 100}%`; if (w) el.style.width = `${w * 100}%`; if (h) el.style.height = `${h * 100}%`; });
    $$('[data-bg]', items).forEach(el => { el.style.background = el.dataset.bg; });
  }
  function noteHtml(n) {
    return `<div class="ann-note" data-note="${esc(n.id)}" data-pos="${n.x},${n.y}" data-bg="${esc(n.color)}">
      <span class="ann-note-grip" data-ann-grip="${esc(n.id)}" title="Drag to move" aria-hidden="true"><i></i><i></i><i></i></span>
      <button class="ann-note-body" type="button" data-ann="note-open" data-id="${esc(n.id)}" title="Edit note · arrow keys move it" aria-label="Note: ${esc(n.text || 'empty')}. Enter to edit, arrow keys to move.">${n.text ? esc(n.text) : '<span class="ann-note-empty">Empty note</span>'}</button>
    </div>`;
  }
  function commentHtml(c) {
    return `<div class="ann-comment${c.asked ? ' asked' : ''}" data-comment="${esc(c.id)}" data-pos="${c.x},${c.y},${c.w},${c.h}">
      <button class="ann-comment-badge" type="button" data-ann="comment-open" data-id="${esc(c.id)}" title="${esc(c.text || 'Comment')}" aria-label="Open comment">${icon('commentFill')}</button>
    </div>`;
  }

  // ───────── toolbar
  function barHtml() {
    const t = (tool, label, key) => `<button class="ann-tool" type="button" data-ann-tool="${tool}" aria-pressed="${S.tool === tool}" title="${label} (${key})" aria-label="${label}">${icon(tool === 'pen' ? (S.pen === 'pen' ? 'pen' : S.pen) : tool, tool === 'comment' ? 2 : 1.6)}</button>`;
    const kinds = ['pen', 'highlighter', 'eraser'].map(k => `<button class="ann-sub${S.pen === k ? ' on' : ''}" type="button" data-ann-pen="${k}" title="${k[0].toUpperCase() + k.slice(1)}" aria-label="${k}" aria-pressed="${S.pen === k}">${icon(k)}</button>`).join('');
    const colors = S.pen === 'eraser' ? '' : `<span class="ann-sep" aria-hidden="true"></span>${COLORS[S.pen].map(c => `<button class="ann-swatch${S.color[S.pen] === c ? ' on' : ''}" type="button" data-ann-color="${c}" data-bg="${c}" aria-label="Colour ${c}" aria-pressed="${S.color[S.pen] === c}"></button>`).join('')}`;
    return `${t('cursor', 'Select', 'V')}<span class="ann-sep" aria-hidden="true"></span>${t('note', 'Add note', 'N')}${t('pen', 'Pen and highlighter', 'P')}
      <span class="ann-pens${S.tool === 'pen' ? ' open' : ''}" role="group" aria-label="Pen options"${S.tool === 'pen' ? '' : ' inert'}><span class="ann-pens-in">${kinds}${colors}</span></span>
      <span class="ann-sep" aria-hidden="true"></span>${t('comment', 'Comment on an area', 'C')}`;
  }
  function paintBar() {
    const bar = S.wrap && $('.ann-bar', S.wrap); if (!bar) return;
    bar.innerHTML = barHtml();
    $$('[data-bg]', bar).forEach(el => { el.style.background = el.dataset.bg; });
  }
  function syncBar() {
    if (!S.wrap) return;
    const usable = anchors().length > 0;
    const bar = $('.ann-bar', S.wrap);
    if (bar) bar.classList.toggle('off', !usable);
    S.wrap.dataset.annMode = usable ? S.tool : 'cursor';
    S.wrap.dataset.annStroke = S.pen;
  }
  function setTool(tool) {
    if (!['cursor', 'note', 'pen', 'comment'].includes(tool)) return;
    closePop();
    S.tool = tool;
    paintBar(); syncBar();
    const sel = window.getSelection(); if (tool !== 'cursor' && sel) sel.removeAllRanges();
  }

  // ───────── drawing, notes and comment boxes (pointer events on the layer)
  function pointIn(layer, event) {
    const r = layer.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (event.clientY - r.top) / r.height))];
  }
  function onPointerDown(event) {
    S.skipClick = false;
    if (event.button !== 0) return;
    // A note moves by its grip with any tool.
    const grip = event.target.closest && event.target.closest('[data-ann-grip]');
    if (grip && S.wrap && S.wrap.contains(grip) && S.data) {
      const host = grip.closest('.ann-note'); const layer = host.closest('.ann-layer');
      const n = S.data.notes.find(x => x.id === grip.dataset.annGrip); if (!n) return;
      if (S.pop && S.pop.el !== host) closePop();
      event.preventDefault();
      const p = pointIn(layer, event);
      S.drag = { kind: 'note', layer, n, host, dx: p[0] - n.x, dy: p[1] - n.y, moved: false };
      host.classList.add('dragging');
      capture(layer, event);
      return;
    }
    const layer = event.target.closest && event.target.closest('.ann-layer');
    if (!layer || !S.wrap || !S.wrap.contains(layer) || !S.data || S.tool === 'cursor') return;
    if (event.target.closest('.ann-note, .ann-comment-badge')) return; // their own clicks
    const page = Number(layer.dataset.page) || 0;
    const start = pointIn(layer, event);
    if (S.tool === 'pen' && S.pen === 'eraser') { event.preventDefault(); eraseAt(event); S.drag = { kind: 'erase', layer }; capture(layer, event); return; }
    if (S.tool === 'pen') {
      event.preventDefault();
      const st = { id: uid(), page, tool: S.pen, color: S.color[S.pen], points: [start] };
      const el = strokeEl(st); el.classList.add('live'); $('.ann-ink', layer).appendChild(el);
      S.drag = { kind: 'stroke', layer, st, el };
      capture(layer, event);
      return;
    }
    if (S.tool === 'note') {
      event.preventDefault();
      const n = { id: uid(), page, x: Math.min(start[0], 0.86), y: Math.min(start[1], 0.94), text: '', color: NOTE_COLOR };
      S.data.notes.push(n); S.undo.push({ kind: 'notes', id: n.id });
      paintLayer(layer, page); save();
      S.skipClick = true;
      openNote(n.id, true);
      return;
    }
    if (S.tool === 'comment') {
      event.preventDefault();
      const box = document.createElement('div'); box.className = 'ann-select';
      $('.ann-items', layer).appendChild(box);
      S.drag = { kind: 'select', layer, page, start, box };
      placeBox(box, start, start);
      capture(layer, event);
    }
  }
  function capture(el, event) { try { el.setPointerCapture(event.pointerId); } catch { /* a pointer that is already gone */ } }
  function placeBox(el, a, b) {
    el.style.left = `${Math.min(a[0], b[0]) * 100}%`; el.style.top = `${Math.min(a[1], b[1]) * 100}%`;
    el.style.width = `${Math.abs(a[0] - b[0]) * 100}%`; el.style.height = `${Math.abs(a[1] - b[1]) * 100}%`;
  }
  function onPointerMove(event) {
    const d = S.drag; if (!d) return;
    if (d.kind === 'erase') { eraseAt(event); return; }
    const p = pointIn(d.layer, event);
    if (d.kind === 'note') {
      const maxX = Math.max(0, 1 - d.host.offsetWidth / d.layer.clientWidth); const maxY = Math.max(0, 1 - d.host.offsetHeight / d.layer.clientHeight);
      d.n.x = Math.min(maxX, Math.max(0, p[0] - d.dx)); d.n.y = Math.min(maxY, Math.max(0, p[1] - d.dy)); d.moved = true;
      d.host.style.left = `${d.n.x * 100}%`; d.host.style.top = `${d.n.y * 100}%`;
      return;
    }
    if (d.kind === 'stroke') {
      const last = d.st.points[d.st.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.0015) return;
      d.st.points.push(p); d.el.setAttribute('d', pathOf(d.st.points));
    } else if (d.kind === 'select') { d.end = p; placeBox(d.box, d.start, p); }
  }
  function onPointerUp() {
    const d = S.drag; if (!d) return; S.drag = null;
    if (d.kind === 'note') {
      d.host.classList.remove('dragging');
      if (d.moved) { d.n.x = Math.round(d.n.x * 10000) / 10000; d.n.y = Math.round(d.n.y * 10000) / 10000; S.skipClick = true; save(); }
      return;
    }
    if (d.kind === 'stroke') {
      d.el.classList.remove('live');
      if (d.st.points.length < 2) { d.el.remove(); return; }
      d.st.points = d.st.points.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
      S.data.strokes.push(d.st); S.undo.push({ kind: 'strokes', id: d.st.id }); save();
    } else if (d.kind === 'select') {
      const a = d.start; const b = d.end || a;
      const rect = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
      const tooSmall = rect.w * d.layer.clientWidth < 12 || rect.h * d.layer.clientHeight < 12;
      if (tooSmall) { d.box.remove(); return; }
      d.box.classList.add('pending');
      const quote = textIn(d.layer, d.box);
      S.skipClick = true;
      openComposer({ layer: d.layer, page: d.page, rect, quote, box: d.box });
    }
  }
  function eraseAt(event) {
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const path = hit && hit.closest && hit.closest('[data-stroke]');
    if (!path || !S.data) return;
    const id = path.dataset.stroke;
    const gone = S.data.strokes.find(st => st.id === id);
    S.data.strokes = S.data.strokes.filter(st => st.id !== id);
    if (gone) S.undo.push({ kind: 'restore', stroke: gone });
    path.remove(); save();
  }
  /* The text inside a comment box: PDF text-layer spans, or the paragraphs of a text page, that overlap it. */
  function textIn(layer, box) {
    const r = box.getBoundingClientRect();
    const hit = el => { const b = el.getBoundingClientRect(); return b.width && b.height && b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom; };
    const host = layer.parentElement;
    const parts = host.classList.contains('ln-pdfv-page')
      ? $$('.textLayer span', host).filter(s => !s.classList.contains('markedContent') && hit(s)).map(s => s.textContent)
      : $$('h1, h2, h3, h4, p, li, td, th, pre', host).filter(el => !el.closest('.ann-layer') && hit(el) && !$('p, li', el)).map(el => el.textContent);
    // Bullet glyphs of slides (❑ ■ • …) carry no meaning for a question; one item per line keeps the list readable.
    return parts.join(' ').replace(/[\u2022\u25A0-\u25FF\u2750-\u275F\uF0A7\uF071\uF06E\uF0FC]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  }

  // ───────── pop-overs: note editor, new comment, open comment
  function closePop(keepEmpty = false) {
    const pop = S.pop; if (!pop) return; S.pop = null;
    const hadFocus = pop.el.contains(document.activeElement);
    if (pop.onClose) pop.onClose(pop.el, keepEmpty);
    if (hadFocus && pop.returnTo && S.wrap) requestAnimationFrame(() => { const back = S.wrap && $(pop.returnTo, S.wrap); if (back) back.focus({ preventScroll: true }); });
    if (pop.inline) return; // a note edited in place is redrawn by its page
    pop.el.classList.add('closing');
    setTimeout(() => pop.el.remove(), 140);
  }
  /* A comment pop-over sits under (or above) its box, inside the file pane, and follows the box as the file scrolls;
     it fades out while the box is scrolled out of sight. */
  function placePop(pop) {
    if (!pop || pop.inline || !pop.anchor || !S.wrap) return;
    const el = pop.el; const w = S.wrap.getBoundingClientRect(); const a = pop.anchor.getBoundingClientRect();
    const box = $('[data-ln-doc]', S.wrap); const view = box ? box.getBoundingClientRect() : w;
    const h = el.offsetHeight; const width = el.offsetWidth;
    const left = Math.min(Math.max(8, a.left - w.left), w.width - width - 8);
    let top = a.bottom - w.top + 8;
    if (top + h > w.height - 64) top = a.top - w.top - h - 8;
    top = Math.min(Math.max(8, top), Math.max(8, w.height - h - 64));
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    el.classList.toggle('away', a.bottom < view.top || a.top > view.bottom);
  }
  function openPop(anchorEl, html, opts = {}) {
    closePop();
    const el = document.createElement('div');
    el.className = `ann-pop ${opts.cls || ''}`; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', opts.label || 'Mark');
    el.innerHTML = html;
    S.wrap.appendChild(el);
    S.pop = { el, anchor: anchorEl, onClose: opts.onClose || null };
    placePop(S.pop);
    const field = $('textarea', el); if (field) { field.focus({ preventScroll: true }); field.setSelectionRange(field.value.length, field.value.length); }
    return el;
  }
  /* A note is written on the note itself: it grows into a small editor where it is, then folds back. */
  function openNote(id, fresh = false) {
    const n = S.data && S.data.notes.find(x => x.id === id); if (!n) return;
    const host = $(`[data-note="${CSS.escape(id)}"]`, S.wrap); if (!host) return;
    closePop();
    host.classList.add('editing');
    const body = $('.ann-note-body', host);
    const editor = document.createElement('div'); editor.className = 'ann-note-editor';
    editor.innerHTML = `<textarea class="ann-note-text" rows="4" maxlength="4000" placeholder="Write a note…" aria-label="Note">${esc(n.text)}</textarea>
      <div class="ann-note-foot"><button class="ann-icon" type="button" data-ann="note-delete" data-id="${esc(id)}" title="Delete note" aria-label="Delete note">${icon('trash')}</button><span class="ann-hint">${fresh ? 'Esc or Done' : ''}</span><button class="ann-btn sm" type="button" data-ann="pop-close">Done</button></div>`;
    if (body) body.replaceWith(editor); else host.appendChild(editor);
    // Near the right or bottom edge of the page the open note shifts inward so the editor stays on the page.
    const page = host.parentElement;
    if (host.offsetLeft + host.offsetWidth > page.clientWidth - 6) host.style.left = `${Math.max(0, page.clientWidth - host.offsetWidth - 6)}px`;
    if (host.offsetTop + host.offsetHeight > page.clientHeight - 6) host.style.top = `${Math.max(0, page.clientHeight - host.offsetHeight - 6)}px`;
    S.pop = { el: host, inline: true, returnTo: `[data-ann="note-open"][data-id="${CSS.escape(id)}"]`, onClose: el => {
      const field = $('.ann-note-text', el); const text = field ? field.value.trim() : n.text;
      if (!text) S.data.notes = S.data.notes.filter(x => x.id !== id); else n.text = text;
      repaintPage(n.page); save();
    } };
    const field = $('.ann-note-text', editor); field.focus({ preventScroll: true }); field.setSelectionRange(field.value.length, field.value.length);
  }
  function openComposer({ layer, page, rect, quote, box }) {
    const where = page ? `page ${page}` : '';
    const pending = { layer, page, rect, quote, box, where };
    openPop(box, `${quote ? `<blockquote class="ann-quote">${esc(quote.length > 240 ? `${quote.slice(0, 240)}…` : quote)}</blockquote>` : `<p class="ann-hint block">No text in this area${where ? ` · ${where}` : ''}. The question is sent with the page number.</p>`}
      <textarea class="ann-text" rows="3" maxlength="1000" placeholder="Comment, or ask the AI about this area…" aria-label="Comment"></textarea>
      <div class="ann-pop-actions"><button class="ann-btn ghost" type="button" data-ann="comment-save">Comment</button><button class="ann-btn primary" type="button" data-ann="comment-ask">${icon('send')}Ask AI</button></div>`,
    { cls: 'ann-pop-comment', label: 'Comment on this area', onClose: () => { if (pending.box.isConnected && !pending.kept) pending.box.remove(); } });
    S.pop.pending = pending;
  }
  function keepComment(asked) {
    const pend = S.pop && S.pop.pending; if (!pend) return null;
    const field = $('.ann-text', S.pop.el); const text = field ? field.value.trim() : '';
    if (asked && !text) { field.focus(); field.classList.add('need'); return null; }
    const c = { id: uid(), page: pend.page, ...pend.rect, text, quote: pend.quote, asked: false, at: new Date().toISOString() };
    S.data.comments.push(c); S.undo.push({ kind: 'comments', id: c.id });
    pend.kept = true; pend.box.remove();
    return { c, pend };
  }
  function askComment(c, where) {
    const Study = window.PerflwLearningStudy;
    if (!Study || !Study.askAbout) { toast('Chat is not available.', true); return false; }
    if (window.PerflwLearning && window.PerflwLearning.openSide) window.PerflwLearning.openSide();
    const question = c.quote ? c.text : `${c.text}${where ? ` (${where})` : ''}`;
    if (!Study.askAbout(question, { quote: c.quote, where, page: c.page || null })) { toast('Wait for the current answer to finish, then ask again.', true); return false; }
    c.asked = true; save();
    return true;
  }
  function openComment(id) {
    const c = S.data && S.data.comments.find(x => x.id === id); if (!c) return;
    const host = $(`[data-comment="${CSS.escape(id)}"]`, S.wrap); if (!host) return;
    host.classList.add('focus');
    const where = c.page ? `page ${c.page}` : '';
    openPop(host, `${c.quote ? `<blockquote class="ann-quote">${esc(c.quote.length > 240 ? `${c.quote.slice(0, 240)}…` : c.quote)}</blockquote>` : ''}
      <textarea class="ann-text" rows="3" maxlength="1000" placeholder="Comment" aria-label="Comment">${esc(c.text)}</textarea>
      <div class="ann-pop-actions"><button class="ann-icon" type="button" data-ann="comment-delete" data-id="${esc(id)}" title="Delete comment" aria-label="Delete comment">${icon('trash')}</button>${c.asked ? `<span class="ann-hint">${icon('check')}Asked in Chat</span>` : '<span class="ann-hint"></span>'}<button class="ann-btn primary" type="button" data-ann="comment-reask" data-id="${esc(id)}">${icon('send')}${c.asked ? 'Ask again' : 'Ask AI'}</button></div>`,
    { cls: 'ann-pop-comment', label: 'Comment', onClose: el => {
      host.classList.remove('focus');
      const field = $('.ann-text', el);
      if (field && S.data.comments.includes(c)) { c.text = field.value.trim(); save(); }
      if (field) host.querySelector('.ann-comment-badge').title = c.text || 'Comment';
    } });
    S.pop.comment = { c, where }; S.pop.returnTo = `[data-ann="comment-open"][data-id="${CSS.escape(id)}"]`;
  }
  function repaintPage(page) { for (const a of anchors()) if (a.page === page) paintLayer(layerFor(a.el, a.page), page); }

  function onClick(event) {
    if (!S.wrap || !S.wrap.isConnected) return;
    const toolBtn = event.target.closest('[data-ann-tool]');
    if (toolBtn && S.wrap.contains(toolBtn)) { setTool(toolBtn.dataset.annTool === S.tool && S.tool !== 'cursor' ? 'cursor' : toolBtn.dataset.annTool); return; }
    const penBtn = event.target.closest('[data-ann-pen]');
    if (penBtn && S.wrap.contains(penBtn)) { S.pen = penBtn.dataset.annPen; paintBar(); syncBar(); return; }
    const colorBtn = event.target.closest('[data-ann-color]');
    if (colorBtn && S.wrap.contains(colorBtn)) { S.color[S.pen] = colorBtn.dataset.annColor; paintBar(); return; }
    const control = event.target.closest('[data-ann]');
    if (control && S.wrap.contains(control)) {
      const id = control.dataset.id;
      switch (control.dataset.ann) {
        case 'note-open': openNote(id); return;
        case 'comment-open': openComment(id); return;
        case 'pop-close': closePop(); return;
        case 'note-delete': {
          const n = S.data.notes.find(x => x.id === id); S.data.notes = S.data.notes.filter(x => x.id !== id);
          if (S.pop) S.pop.onClose = null; closePop(); if (n) repaintPage(n.page); save(); return;
        }
        case 'comment-delete': {
          const c = S.data.comments.find(x => x.id === id); S.data.comments = S.data.comments.filter(x => x.id !== id);
          if (S.pop) S.pop.onClose = null; closePop(); if (c) repaintPage(c.page); save(); return;
        }
        case 'comment-save': { const kept = keepComment(false); if (!kept) return; closePop(); repaintPage(kept.c.page); save(); setTool('cursor'); return; }
        case 'comment-ask': {
          const kept = keepComment(true); if (!kept) return;
          closePop(); repaintPage(kept.c.page); save();
          askComment(kept.c, kept.pend.where); repaintPage(kept.c.page); setTool('cursor');
          return;
        }
        case 'comment-reask': {
          const info = S.pop && S.pop.comment; if (!info) return;
          const field = $('.ann-text', S.pop.el); const text = field.value.trim();
          if (!text) { field.focus(); field.classList.add('need'); return; }
          info.c.text = text; closePop();
          askComment(info.c, info.where); repaintPage(info.c.page);
          return;
        }
        default: return;
      }
    }
    // A click outside an open pop-over closes it (a note keeps what was typed).
    if (S.skipClick) { S.skipClick = false; return; }
    if (S.pop && !event.target.closest('.ann-pop') && !event.target.closest('.ann-note.editing') && !event.target.closest('.ann-note, .ann-comment-badge')) closePop();
  }
  function onKey(event) {
    if (!S.wrap || !S.wrap.isConnected) return;
    if (document.querySelector('.overlay:not([hidden])')) return; // another dialog is open: its keys
    // A focused note moves with the arrow keys (Shift: further).
    const noteBtn = event.target.closest && event.target.closest('.ann-note-body');
    if (noteBtn && /^Arrow/.test(event.key) && S.data) {
      const n = S.data.notes.find(x => x.id === noteBtn.dataset.id); if (!n) return;
      event.preventDefault();
      const step = event.shiftKey ? 0.05 : 0.01;
      if (event.key === 'ArrowLeft') n.x = Math.max(0, n.x - step); if (event.key === 'ArrowRight') n.x = Math.min(0.86, n.x + step);
      if (event.key === 'ArrowUp') n.y = Math.max(0, n.y - step); if (event.key === 'ArrowDown') n.y = Math.min(0.96, n.y + step);
      const host = noteBtn.closest('.ann-note'); host.style.left = `${n.x * 100}%`; host.style.top = `${n.y * 100}%`;
      save(); return;
    }
    if (event.key === 'Escape' && S.pop) { event.preventDefault(); event.stopPropagation(); closePop(); return; }
    if (event.key === 'Escape' && S.tool !== 'cursor') { event.preventDefault(); event.stopPropagation(); setTool('cursor'); return; }
    const typing = event.target.closest && event.target.closest('input, textarea, [contenteditable="true"]');
    if (typing || event.altKey || event.metaKey) return;
    if (event.ctrlKey && (event.key === 'z' || event.key === 'Z') && S.undo.length && S.tool !== 'cursor') {
      event.preventDefault();
      const last = S.undo.pop();
      if (last.kind === 'restore') S.data.strokes.push(last.stroke); else S.data[last.kind] = S.data[last.kind].filter(x => x.id !== last.id);
      paintAll(); save();
      return;
    }
    if (event.ctrlKey || !anchors().length) return;
    const map = { v: 'cursor', n: 'note', p: 'pen', c: 'comment' };
    const tool = map[event.key.toLowerCase()];
    if (tool && !document.querySelector('.overlay:not([hidden]), .menu:not([hidden])')) { event.preventDefault(); setTool(tool); }
  }

  // ───────── called by learning.js
  function show(wrap, fileId) {
    if (!wrap) return;
    if (S.wrap !== wrap) {
      if (S.observer) S.observer.disconnect();
      S.wrap = wrap;
      let bar = $('.ann-bar', wrap);
      if (!bar) { bar = document.createElement('div'); bar.className = 'ann-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Study tools'); wrap.appendChild(bar); }
      paintBar();
      // PDF pages and text pages are created after this call (lazily, or when the file opens): add their layers then.
      S.observer = new MutationObserver(() => { if (S.data) ensureLayers(); else syncBar(); });
      const box = $('[data-ln-doc]', wrap); if (box) S.observer.observe(box, { childList: true, subtree: true });
    }
    if (S.fileId !== (fileId || null)) {
      flush();
      S.fileId = fileId || null; S.data = null; S.undo = [];
      if (S.fileId) load(S.fileId);
    } else if (S.data) ensureLayers();
    syncBar();
  }
  function reset() { flush(); if (S.observer) S.observer.disconnect(); Object.assign(S, { wrap: null, fileId: null, data: null, loading: null, tool: 'cursor', undo: [], drag: null, observer: null }); }

  document.addEventListener('scroll', event => { if (S.pop && !S.pop.inline && S.wrap && S.wrap.contains(event.target)) placePop(S.pop); }, true);
  window.addEventListener('resize', () => { if (S.pop) placePop(S.pop); });
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('beforeunload', () => { flush(); });
  // A note's text is kept as it is typed, so nothing is lost when the window closes with the note open.
  document.addEventListener('input', event => {
    const field = event.target.closest && event.target.closest('.ann-note-text'); if (!field || !S.data) return;
    const host = field.closest('[data-note]'); const n = host && S.data.notes.find(x => x.id === host.dataset.note);
    if (n && field.value.trim()) { n.text = field.value.trim(); save(); }
  });
  window.PerflwAnnotate = Object.freeze({ show, reset, flush, tool: () => S.tool, data: () => S.data });
})();

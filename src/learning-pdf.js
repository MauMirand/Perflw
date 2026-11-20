'use strict';
/* Learning topic viewer — the in-app PDF viewer (renderer).
   Replaces Chromium's PDF plugin frame, which reloads the whole document for every page change and cannot point at a
   spot on a page. Here each PDF is read once (window.learningData.fileBytes → pdf.js), its pages are drawn lazily as
   they scroll into view, and a jump scrolls the same view to the page — and, when the key point's text is found on
   that page, to that line, which is highlighted. learning.js calls:
     PerflwPdfViewer.show(box, fileId, { page, text })  — mounts the file in box, or jumps when it is already shown
     PerflwPdfViewer.release(box)                       — before box gets other content
     PerflwPdfViewer.forget(fileId)                      — the file was replaced or deleted */
(function () {
  const api = window.learningData;
  if (!api || !api.fileBytes) return;

  const PAD = 18;          // space around the pages, CSS px
  const GAP = 14;          // between pages
  const MAX_DOCS = 3;      // parsed documents kept for quick switching
  const norm = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const reduceMotion = () => document.body.classList.contains('motion-off') || (!document.body.classList.contains('motion-on') && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let lib = null;
  async function pdfjs() {
    if (!lib) {
      lib = await import('../node_modules/pdfjs-dist/build/pdf.min.mjs');
      lib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', document.baseURI).href;
    }
    return lib;
  }

  /* fileId → Promise<{ doc, sizes: [{ w, h }] (scale 1), text: Map(pageNumber → Promise<index>) }> */
  const docs = new Map();
  function openDoc(fileId) {
    if (docs.has(fileId)) { const p = docs.get(fileId); docs.delete(fileId); docs.set(fileId, p); return p; }
    const promise = (async () => {
      const [pdf, bytes] = await Promise.all([pdfjs(), api.fileBytes(fileId)]);
      const doc = await pdf.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: false, useSystemFonts: true }).promise;
      const sizes = [];
      for (let n = 1; n <= doc.numPages; n++) { const v = (await doc.getPage(n)).getViewport({ scale: 1 }); sizes.push({ w: v.width, h: v.height }); }
      return { doc, sizes, text: new Map() };
    })();
    promise.catch(() => docs.delete(fileId));
    docs.set(fileId, promise);
    while (docs.size > MAX_DOCS) {
      const [oldest, p] = docs.entries().next().value;
      if ([...views.values()].some(v => v.fileId === oldest)) break;
      docs.delete(oldest); p.then(d => d.doc.destroy()).catch(() => {});
    }
    return promise;
  }

  /* A page's text as one normalized string, with the text item behind every character, for finding a key point. */
  function pageIndex(entry, n) {
    if (!entry.text.has(n)) {
      entry.text.set(n, entry.doc.getPage(n).then(page => page.getTextContent()).then(content => {
        let str = ''; const owner = []; const start = []; const len = []; const items = content.items.filter(i => typeof i.str === 'string');
        items.forEach((item, i) => {
          const t = norm(item.str); len[i] = t.length; if (!t) return;
          if (str) { str += ' '; owner.push(i); }
          start[i] = str.length; str += t; for (let k = 0; k < t.length; k++) owner.push(i);
        });
        return { str, owner, start, len, items };
      }));
    }
    return entry.text.get(n);
  }
  /* Item range [from, to] on the page that holds the text, or null. Exact prefix first, then the best run of its words. */
  function findOn(index, text) {
    const want = norm(text); if (!want || !index.str) return null;
    for (const len of [80, 48, 28]) {
      const probe = want.slice(0, len).replace(/\s\S*$/, (m) => (want.length > len ? '' : m)).trim();
      if (probe.length < 12 && want.length >= 12) continue;
      const at = index.str.indexOf(probe);
      if (at >= 0) {
        const end = Math.min(at + (want.length > len ? want.length : probe.length), index.str.length) - 1;
        const tail = index.str.slice(at, end + 1) === want.slice(0, end + 1 - at) ? end : at + probe.length - 1;
        const from = index.owner[at]; const to = index.owner[tail];
        return { from, to, score: 1, head: (at - index.start[from]) / (index.len[from] || 1), tail: (tail + 1 - index.start[to]) / (index.len[to] || 1) };
      }
    }
    const words = [...new Set(want.split(' ').filter(w => w.length > 3))].slice(0, 10);
    if (words.length < 2) return null;
    let best = null;
    const n = index.items.length;
    for (let i = 0; i < n; i++) {
      let hay = ''; let j = i;
      for (; j < n && j < i + 8 && hay.length < want.length * 1.6 + 20; j++) hay += ` ${norm(index.items[j].str)}`;
      const score = words.filter(w => hay.includes(w)).length / words.length;
      if (score > (best ? best.score : 0)) best = { from: i, to: j - 1, score };
    }
    return best && best.score >= 0.6 ? best : null;
  }

  /* box → view state */
  const views = new Map();

  function show(box, fileId, target = {}) {
    let view = views.get(box);
    if (view && view.fileId === fileId && box.contains(view.root)) { jump(view, target); return; }
    if (view) release(box);
    view = { box, fileId, root: null, pages: [], entry: null, scale: 1, width: 0, observer: null, resize: null, renders: new Map(), token: 0, jumpTicket: 0, pending: target, highlight: null };
    views.set(box, view);
    box.classList.add('ln-doc-pdf');
    box.innerHTML = '<div class="ln-doc-state"><span class="spinner" aria-hidden="true"></span><p>Opening the file…</p></div>';
    openDoc(fileId).then(entry => {
      if (views.get(box) !== view) return;
      view.entry = entry;
      build(view);
      const t = view.pending; view.pending = null;
      jump(view, t || {}, true);
    }).catch(error => {
      if (views.get(box) !== view) return;
      box.innerHTML = `<div class="ln-doc-state"><p>${String(error && error.message || 'The file could not be opened.').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</p><button class="btn btn-sm btn-ghost" type="button" data-ln="viewer-reload">Try again</button></div>`;
    });
  }

  function fitScale(view) {
    const w = Math.max(200, view.box.clientWidth - PAD * 2);
    const widest = Math.max(...view.entry.sizes.map(s => s.w));
    return Math.min(4, w / widest);
  }
  function build(view) {
    const { box, entry } = view;
    view.scale = fitScale(view); view.width = box.clientWidth;
    const root = document.createElement('div');
    root.className = 'ln-pdfv';
    root.setAttribute('role', 'document');
    view.pages = entry.sizes.map((size, i) => {
      const el = document.createElement('div');
      el.className = 'ln-pdfv-page'; el.dataset.page = String(i + 1);
      el.setAttribute('aria-label', `Page ${i + 1}`);
      root.appendChild(el);
      return el;
    });
    box.innerHTML = ''; box.appendChild(root);
    view.root = root;
    layout(view);
    view.observer = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) draw(view, Number(e.target.dataset.page));
    }, { root: box, rootMargin: '900px 0px' });
    view.pages.forEach(el => view.observer.observe(el));
    let timer = null;
    view.resize = new ResizeObserver(() => {
      if (Math.abs(box.clientWidth - view.width) < 2) return;
      clearTimeout(timer); timer = setTimeout(() => rescale(view), 120);
    });
    view.resize.observe(box);
  }
  function layout(view) {
    view.pages.forEach((el, i) => {
      const s = view.entry.sizes[i];
      el.style.width = `${Math.floor(s.w * view.scale)}px`;
      el.style.height = `${Math.floor(s.h * view.scale)}px`;
      el.style.setProperty('--scale-factor', String(view.scale));
      el.style.setProperty('--total-scale-factor', String(view.scale));
    });
    view.root.style.padding = `${PAD}px`; view.root.style.gap = `${GAP}px`;
  }
  /* Width changed: keep the same spot of the same page at the top while the pages resize. */
  function rescale(view) {
    if (!view.root || !view.box.contains(view.root)) return;
    const { box } = view;
    const at = pageAt(view, box.scrollTop);
    const el = view.pages[at - 1]; const frac = el ? (box.scrollTop - el.offsetTop) / el.offsetHeight : 0;
    view.scale = fitScale(view); view.width = box.clientWidth; view.token++;
    view.renders.forEach(task => { try { task.cancel(); } catch { /* done */ } }); view.renders.clear();
    view.pages.forEach(p => { p.dataset.drawn = ''; });
    layout(view);
    if (el) box.scrollTop = el.offsetTop + frac * el.offsetHeight;
    view.pages.forEach((p, i) => { const r = p.getBoundingClientRect(); const b = box.getBoundingClientRect(); if (r.bottom > b.top - 900 && r.top < b.bottom + 900) draw(view, i + 1); });
    if (view.highlight) paintHighlight(view, view.highlight);
  }
  function pageAt(view, y) {
    let n = 1; for (const el of view.pages) { if (el.offsetTop - GAP <= y) n = Number(el.dataset.page); else break; } return n;
  }

  async function draw(view, n) {
    const el = view.pages[n - 1]; if (!el || el.dataset.drawn === String(view.token)) return;
    const token = view.token; el.dataset.drawn = String(token);
    try {
      const pdf = await pdfjs();
      const page = await view.entry.doc.getPage(n);
      if (token !== view.token || !view.box.contains(el)) return;
      const viewport = page.getViewport({ scale: view.scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
      canvas.className = 'ln-pdfv-canvas';
      const task = page.render({ canvas, canvasContext: canvas.getContext('2d', { alpha: false }), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
      view.renders.set(n, task);
      await task.promise;
      view.renders.delete(n);
      if (token !== view.token || !view.box.contains(el)) return;
      // Swap in one step so a redrawn page never shows blank.
      const text = document.createElement('div'); text.className = 'textLayer';
      el.querySelectorAll('.ln-pdfv-canvas, .textLayer').forEach(old => old.remove());
      el.prepend(canvas); canvas.after(text);
      const layer = new pdf.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      layer.render().catch(() => {});
    } catch (error) {
      if (error && error.name === 'RenderingCancelledException') return;
      el.dataset.drawn = '';
    }
  }

  /* Jump: the same view scrolls (no reload). With text, the line that holds it is found on that page (else the
     pages around it, else anywhere in the file), centred a third from the top and highlighted. */
  async function jump(view, target, first = false) {
    if (!view.entry) { view.pending = target; return; }
    const ticket = ++view.jumpTicket;
    const want = Number.isInteger(target.page) && target.page > 0 ? Math.min(target.page, view.pages.length) : null;
    let page = want || 1; let hit = null;
    if (target.text) {
      const order = want ? [want, want + 1, want - 1, want + 2, want - 2] : [];
      for (let n = 1; n <= view.pages.length; n++) if (!order.includes(n)) order.push(n);
      for (const n of order.filter(n => n >= 1 && n <= view.pages.length)) {
        const found = findOn(await pageIndex(view.entry, n), target.text);
        if (view.jumpTicket !== ticket) return;
        if (found) { page = n; hit = { page: n, ...found }; break; }
        if (!want && n > 40) break; // without a page, stop searching very long files after 40 pages
      }
    }
    if (view.jumpTicket !== ticket || !view.box.contains(view.root)) return;
    const el = view.pages[page - 1]; if (!el) return;
    let y = el.offsetTop - PAD + 2;
    if (hit) {
      const rect = await itemRect(view, hit);
      if (view.jumpTicket !== ticket) return;
      if (rect) y = el.offsetTop + rect.top - view.box.clientHeight * 0.3;
    }
    y = Math.max(0, Math.min(y, view.box.scrollHeight - view.box.clientHeight));
    const far = Math.abs(view.box.scrollTop - y) > view.box.clientHeight * 2.5;
    view.box.scrollTo({ top: y, behavior: first || far || reduceMotion() ? 'auto' : 'smooth' });
    draw(view, page);
    view.highlight = hit;
    paintHighlight(view, hit);
  }
  async function itemRect(view, hit) {
    const idx = await pageIndex(view.entry, hit.page);
    const page = await view.entry.doc.getPage(hit.page);
    const vp = page.getViewport({ scale: view.scale });
    const boxes = [];
    for (let i = hit.from; i <= hit.to; i++) {
      const item = idx.items[i]; if (!item || !item.str.trim()) continue;
      const tx = lib.Util.transform(vp.transform, item.transform);
      const h = Math.hypot(tx[2], tx[3]) || 10;
      const w = (item.width || 0) * view.scale;
      const a = i === hit.from && hit.head ? Math.max(0, Math.min(1, hit.head)) : 0;
      const z = i === hit.to && hit.tail ? Math.max(a, Math.min(1, hit.tail)) : 1;
      boxes.push({ left: tx[4] + w * a, top: tx[5] - h, width: Math.max(w * (z - a), 4), height: h * 1.18 });
    }
    if (!boxes.length) return null;
    // Group into lines so the highlight follows the text, not one large box.
    const lines = [];
    boxes.sort((a, b) => a.top - b.top || a.left - b.left).forEach(b => {
      const line = lines.find(l => Math.abs(l.top - b.top) < b.height * 0.5);
      if (line) { const r = Math.max(line.left + line.width, b.left + b.width); line.left = Math.min(line.left, b.left); line.width = r - line.left; line.height = Math.max(line.height, b.height); }
      else lines.push({ ...b });
    });
    hit.lines = lines;
    return { top: lines[0].top };
  }
  function paintHighlight(view, hit) {
    view.root.querySelectorAll('.ln-pdfv-hl').forEach(el => el.remove());
    if (!hit || !hit.lines) return;
    const el = view.pages[hit.page - 1]; if (!el) return;
    const ratio = view.scale / (hit.scale || view.scale);
    hit.scale = view.scale;
    hit.lines.forEach(l => {
      if (ratio !== 1) { l.left *= ratio; l.top *= ratio; l.width *= ratio; l.height *= ratio; }
      const mark = document.createElement('div'); mark.className = 'ln-pdfv-hl';
      Object.assign(mark.style, { left: `${l.left - 3}px`, top: `${l.top - 2}px`, width: `${l.width + 6}px`, height: `${l.height + 4}px` });
      el.appendChild(mark);
    });
  }

  function release(box) {
    const view = views.get(box); if (!view) return;
    views.delete(box);
    view.jumpTicket = (view.jumpTicket || 0) + 1; view.token++;
    if (view.observer) view.observer.disconnect();
    if (view.resize) view.resize.disconnect();
    view.renders.forEach(task => { try { task.cancel(); } catch { /* done */ } });
    box.classList.remove('ln-doc-pdf');
  }
  function current(box) { const v = views.get(box); return v && box.contains(v.root || box.firstChild) ? v.fileId : null; }
  function forget(fileId) {
    const p = docs.get(fileId); if (!p) return;
    docs.delete(fileId); p.then(d => d.doc.destroy()).catch(() => {});
  }
  function reset() { [...views.keys()].forEach(release); [...docs.keys()].forEach(forget); }

  window.PerflwPdfViewer = Object.freeze({ show, release, current, forget, reset });
})();

'use strict';
/* Learning document intelligence (main process, no Electron). The pure steps of the Learning document workflow:

     1. extractBlocks  — the uploaded file as typed blocks: title, heading (level 1–3), paragraph, list item,
                         each with its page/slide when known. Word styles, PowerPoint titles/bullet levels,
                         PDF font sizes + bookmarks, Markdown #, and plain-text heading patterns.
     2. analyze        — sections numbered 1, 1.1, 1.1.1; per section a description and ranked key points;
                         document main points and keywords; retrieval chunks for questions.
     3. fileMarkdown / subjectMarkdown — the per-file .md and the subject's information center .md.
     4. similarDoc     — which existing file .md a new upload updates (same document, another version).
     5. search         — the information center lookup used by the Ask panel: run 1 strict, run 2 broad.

   Everything here is deterministic, so the notes panel works without any AI model; agents add an overview and
   answer questions on top of it (learning-workflow.js). */
const { readZip } = require('./learning-import');

const LIMITS = Object.freeze({ blocks: 6000, sectionPoints: 4, listPoints: 8, mainPoints: 6, keywords: 10, chunk: 1400, chunks: 600, heading: 160 });
const MAX_LEVEL = 2; // numbered levels: topic 1, subtopic 1.1 (the same as the topic list)
/* A heading's own typed numbering ("1.2 Transport", "3. Cells", "4) Energy") is dropped: the app numbers sections itself.
   A bare leading number without a dot ("7 Habits", "2020 Results") is part of the title and stays. */
const headingText = text => clean(text).replace(/^(\d{1,2}(\.\d{1,2})+\.?|\d{1,2}[.)])\s+(?=\S)/, '') || clean(text);

// ───────── text helpers
const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
function entities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
    const c = code.toLowerCase();
    if (c[0] === '#') { const n = c[1] === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10); return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[c];
  });
}
const tags = (xml, name) => xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>|<${name}/>`, 'g')) || [];
const runs = (xml, name) => entities((xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g')) || [])
  .map(t => t.replace(/<[^>]+>/g, '')).join(''));

const STOP = new Set(('a an and are as at be been being but by can could did do does doing for from had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours also may might must shall about above after again against all am any because before below between both down during each few further many much per via within without upon onto ' +
  'one two use used using get got make made like well even still yet thus therefore however etc eg ie vs ' +
  'explain describe define tell give list show discuss according file document lecture slide slides page pages topic topics question answer please ' +
  'difference differences different differ compare comparison contrast versus vs between similarity similarities relationship relate related ' +
  // chat spellings, and Filipino (Tagalog) question and function words: the topic words around them are what count
  'wat wht whats wats pls plz u ur abt bout ' +
  'ano ang ng sa mga ba si ni kay na at ay para paano bakit ito iyan yan yun yung kung saan kailan sino alin mo ko ka po naman lang din rin nang ano-ano ibig sabihin kahulugan').split(' '));
/* Light suffix stripping so "proteins"/"protein" and "transported"/"transport" meet. */
function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && /(sses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 6 && w.endsWith('ly')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
function words(text) { return (String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9][a-z0-9+'-]*/g) || []).map(w => w.replace(/'s$|'$/g, '')); }
const terms = text => words(text).filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
function sentences(text) {
  const out = [];
  const parts = String(text).replace(/\s+/g, ' ').match(/[^.!?]+(?:[.!?]+(?=\s+[A-Z0-9"“(]|\s*$)|$)/g) || [];
  for (const raw of parts) { const s = raw.trim(); if (s) out.push(s); }
  // Abbreviation splits ("e.g. The") rejoin when the piece is tiny.
  return out.reduce((acc, s) => { if (acc.length && (acc[acc.length - 1].length < 18 || /\b(e\.g|i\.e|etc|vs|fig|no)\.$/i.test(acc[acc.length - 1]))) acc[acc.length - 1] += ` ${s}`; else acc.push(s); return acc; }, []);
}
const firstSentence = text => { const s = sentences(text)[0] || ''; return s.length > 240 ? `${s.slice(0, 237).trimEnd()}…` : s; };

// ───────── 1. extraction
/* Word paragraph styles: what each style id means for structure. A heading is recognised by
     1. the built-in style ids (Title, Heading1 … Heading9), which Word keeps in English in every language,
     2. the English style names ("heading 1", "title"),
     3. the outline level set on the style, or inherited through basedOn (Word's own rule for custom headings).
   Paragraph-level outline levels win over the style's. Outline level 9 is body text. */
function docxStyles(xml) {
  const raw = new Map();
  for (const style of tags(xml || '', 'w:style')) {
    if (!/w:type="paragraph"/.test(style) && /w:type="/.test(style)) continue;
    const id = (style.match(/w:styleId="([^"]+)"/) || [])[1]; if (!id) continue;
    const name = ((style.match(/<w:name w:val="([^"]+)"/) || [])[1] || '').toLowerCase();
    const outline = (style.match(/<w:outlineLvl w:val="(\d)"/) || [])[1];
    const basedOn = (style.match(/<w:basedOn w:val="([^"]+)"/) || [])[1] || null;
    const list = /<w:numPr>/.test(style) || /list/.test(name);
    raw.set(id, { id, name, outline: outline != null ? Number(outline) : null, basedOn, list });
  }
  const own = s => {
    if (/^title$/i.test(s.id) || s.name === 'title') return 'title';
    if (/^subtitle$/i.test(s.id) || s.name === 'subtitle') return 'subtitle';
    const n = Number((s.id.match(/^heading([1-9])$/i) || s.name.match(/^heading ?([1-9])$/) || [])[1] || 0);
    if (n) return n;
    if (s.outline != null && s.outline < 9) return s.outline + 1;
    return null;
  };
  const resolved = new Map();
  for (const s of raw.values()) {
    let at = s; let kind = null; let list = s.list; const seen = new Set();
    while (at && !seen.has(at.id) && kind == null) { seen.add(at.id); kind = own(at); list = list || at.list; at = at.basedOn ? raw.get(at.basedOn) : null; }
    resolved.set(s.id, { kind, list });
  }
  return resolved;
}
/* Text of one paragraph: tabs and line breaks become spaces; bold, underlined or highlighted runs are kept as emphasis. */
function docxParagraph(p) {
  let text = ''; const strong = [];
  for (const run of tags(p, 'w:r')) {
    const piece = entities((run.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g) || [])
      .map(t => (/^<w:(tab|br|cr)\/>$/.test(t) ? ' ' : t.replace(/<[^>]+>/g, ''))).join(''));
    text += piece;
    const props = (run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    const on = tag => new RegExp(`<w:${tag}(?:\\s+w:val="(?!0|false|none)[^"]*")?\\s*/>`).test(props);
    if (clean(piece).length >= 3 && (on('b') || on('u') || /<w:highlight /.test(props))) strong.push(clean(piece));
  }
  // Hyperlinks and fields keep their runs inside other elements; fall back to every w:t when runs gave nothing.
  if (!clean(text)) text = runs(p, 'w:t');
  return { text: clean(text), strong };
}
function docxBlocks(buffer) {
  const zip = readZip(buffer);
  const doc = zip.text('word/document.xml'); if (!doc) throw new Error('missing document');
  const styles = docxStyles(zip.text('word/styles.xml'));
  const rels = relations(zip.text('word/_rels/document.xml.rels'), 'word/');
  const blocks = []; const images = [];
  for (const p of tags(doc, 'w:p')) {
    const { text, strong } = docxParagraph(p);
    for (const id of p.match(/r:embed="([^"]+)"/g) || []) { const target = rels.get(id.slice(9, -1)); if (target) images.push({ at: blocks.length + (text ? 1 : 0), target }); }
    if (!text) continue;
    const id = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
    const style = (id && styles.get(id)) || { kind: id ? (/^heading([1-9])$/i.test(id) ? Number(id.slice(7)) : /^title$/i.test(id) ? 'title' : null) : null, list: false };
    const own = (p.match(/<w:pPr>[\s\S]*?<w:outlineLvl w:val="(\d)"[\s\S]*?<\/w:pPr>/) || [])[1];
    const kind = own != null ? (Number(own) < 9 ? Number(own) + 1 : null) : style.kind;
    const extra = strong.length && strong.join(' ').length < text.length ? { strong } : {};
    if (kind === 'title') blocks.push({ kind: 'title', text });
    else if (kind === 'subtitle') blocks.push({ kind: 'p', text });
    else if (typeof kind === 'number') blocks.push({ kind: 'h', level: kind, text });
    else if (/<w:numPr>/.test(p) || style.list) blocks.push({ kind: 'li', text, depth: Number((p.match(/<w:ilvl w:val="(\d)"/) || [])[1] || 0), ...extra });
    else blocks.push({ kind: 'p', text, ...extra });
  }
  return { blocks, pages: null, images };
}

function pptxBlocks(buffer) {
  const zip = readZip(buffer);
  const pres = zip.text('ppt/presentation.xml'); if (!pres) throw new Error('missing presentation');
  const rels = new Map();
  for (const rel of (zip.text('ppt/_rels/presentation.xml.rels') || '').match(/<Relationship [^>]+>/g) || []) {
    const id = (rel.match(/Id="([^"]+)"/) || [])[1], target = (rel.match(/Target="([^"]+)"/) || [])[1];
    if (id && target) rels.set(id, target.replace(/^\/?(ppt\/)?/, 'ppt/'));
  }
  const order = [];
  for (const s of pres.match(/<p:sldId [^>]+>/g) || []) {
    const sid = (s.match(/\bid="(\d+)"/) || [])[1], rid = (s.match(/r:id="([^"]+)"/) || [])[1];
    if (rid && rels.has(rid)) order.push({ sid, file: rels.get(rid) });
  }
  const sectionOf = new Map(); const sectionNames = [];
  for (const section of tags(pres, 'p14:section')) {
    const name = clean(entities((section.match(/name="([^"]*)"/) || [])[1] || ''));
    sectionNames.push(name);
    for (const t of section.match(/<p14:sldId id="(\d+)"/g) || []) sectionOf.set(t.match(/id="(\d+)"/)[1], name);
  }
  const useSections = sectionNames.length > 1 || (sectionNames.length === 1 && sectionNames[0] && !/^default section$/i.test(sectionNames[0]));
  const blocks = []; let lastSection = null; const images = [];
  order.forEach(({ sid, file }, index) => {
    const page = index + 1;
    const xml = zip.text(file) || '';
    const slideRels = relations(zip.text(file.replace(/([^/]+)$/, '_rels/$1.rels')), file.replace(/[^/]+$/, ''));
    let title = ''; let isCover = false; const body = [];
    for (const sp of tags(xml, 'p:sp')) {
      const ph = (sp.match(/<p:ph[^>]*>/) || [''])[0];
      const type = (ph.match(/type="([^"]+)"/) || [])[1] || '';
      if (/^(title|ctrTitle)$/.test(type) && !title) { title = clean(runs(sp, 'a:t')); isCover = type === 'ctrTitle'; continue; }
      if (/^(dt|ftr|sldNum)$/.test(type)) continue;
      for (const para of tags(sp, 'a:p')) {
        const text = clean(runs(para, 'a:t')); if (!text) continue;
        const lvl = Number((para.match(/<a:pPr[^>]*\blvl="(\d)"/) || [])[1] || 0);
        body.push({ text, lvl, subtitle: type === 'subTitle' });
      }
    }
    // Tables on slides: each row as one line.
    for (const tr of tags(xml, 'a:tr')) { const cells = tags(tr, 'a:tc').map(tc => clean(runs(tc, 'a:t'))).filter(Boolean); if (cells.length) body.push({ text: cells.join(' | '), lvl: 0 }); }
    if (useSections) {
      const name = sectionOf.get(sid) || '';
      if (name && name !== lastSection) { blocks.push({ kind: 'h', level: 1, text: name, page }); lastSection = name; }
    }
    if (isCover && index === 0 && !blocks.some(b => b.kind === 'title')) blocks.push({ kind: 'title', text: title, page });
    else if (title) blocks.push({ kind: 'h', level: useSections ? 2 : 1, text: title, page });
    else if (body.length) blocks.push({ kind: 'h', level: useSections ? 2 : 1, text: `Slide ${page}`, page });
    for (const item of body) blocks.push(item.subtitle ? { kind: 'p', text: item.text, page } : { kind: 'li', text: item.text, depth: item.lvl, page });
    for (const id of xml.match(/r:embed="([^"]+)"/g) || []) { const target = slideRels.get(id.slice(9, -1)); if (target) images.push({ at: blocks.length, target, page }); }
  });
  return { blocks, pages: order.length, images };
}

let pdfjsModule = null;
async function loadPdfjs() {
  if (!pdfjsModule) pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsModule;
}
/* PDF: text lines with their font size. Headings come from the PDF's bookmarks when a line matches one, otherwise
   from font size (sizes clearly above the body size, largest first). Repeated page headers/footers are dropped. */
async function pdfBlocks(buffer) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  const doc = await task.promise;
  try {
    // Bookmarks are the author's own structure. When a PDF has them they decide its topics and sections: a line that
    // matches one becomes that heading, a bookmark with no matching line is placed at its destination, and headings
    // found only by font size stay inside their section as sub-headings.
    const marks = new Map(); const bookmarks = [];
    try {
      const where = async dest => {
        try {
          const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
          if (!Array.isArray(d)) return { page: null, top: null };
          const index = Number.isInteger(d[0]) ? d[0] : await doc.getPageIndex(d[0]);
          return { page: index + 1, top: d[1] && d[1].name === 'XYZ' && typeof d[3] === 'number' ? d[3] : null };
        } catch { return { page: null, top: null }; }
      };
      const walk = async (items, depth) => {
        for (const item of items || []) {
          const title = clean(item.title);
          if (depth < 3 && title) { const key = normKey(title); if (!marks.has(key)) marks.set(key, depth + 1); bookmarks.push({ key, title, level: depth + 1, ...(await where(item.dest)) }); }
          if (bookmarks.length < 600) await walk(item.items, depth + 1);
        }
      };
      await walk(await doc.getOutline(), 0);
    } catch { /* no outline */ }
    // PowerPoint's own PDF export adds one "Slide N: …" bookmark per slide: not an outline, so the deck rules apply.
    if (bookmarks.length && bookmarks.every(b => /^slide\s*\d+\b/i.test(b.title))) { bookmarks.length = 0; marks.clear(); }
    const bookmarked = bookmarks.length > 0;
    const lines = []; const viewports = []; const imagePages = [];
    const PICTURE_OPS = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintJpegXObject, pdfjs.OPS.paintImageXObjectRepeat].filter(n => typeof n === 'number'));
    const pageCount = Math.min(doc.numPages, 1500);
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent({ includeMarkedContent: false });
      // How much of the page its pictures cover (each picture is the unit square under the current transform), and
      // how much real text the page has: a logo in a corner is not worth reading, a full-page slide picture is.
      try {
        const ops = await page.getOperatorList(); const O = pdfjs.OPS;
        let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; let area = 0;
        const mul = (m, k) => [m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1], m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3], m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]];
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          if (fn === O.save) stack.push(ctm); else if (fn === O.restore) ctm = stack.pop() || ctm;
          else if (fn === O.transform) ctm = mul(ctm, ops.argsArray[i]);
          else if (PICTURE_OPS.has(fn)) area += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
        }
        if (area > 0) {
          const textChars = content.items.reduce((sum, it) => sum + (typeof it.str === 'string' ? it.str.trim().length : 0), 0);
          const box = page.getViewport({ scale: 1 }); // the page size
          imagePages.push({ page: n, cover: Math.min(1, area / Math.max(1, box.width * box.height)), textChars });
        }
      } catch { /* no picture check */ }
      const viewport = page.getViewport({ scale: 1 });
      let current = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const size = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 10) / 10 || item.height || 0;
        const x = item.transform[4]; const y = item.transform[5];
        const font = content.styles[item.fontName] || {};
        if (current && Math.abs(current.y - y) <= Math.max(2, size * 0.35)) {
          const gap = x - current.endX;
          current.text += (gap > size * 0.15 && !/\s$/.test(current.text) && !/^\s/.test(item.str) ? ' ' : '') + item.str;
          current.endX = x + (item.width || 0);
          if (item.str.trim()) { current.size = Math.max(current.size, size); current.chars += item.str.length; }
        } else {
          if (current) lines.push(current);
          current = { page: n, y, x, endX: x + (item.width || 0), size, text: item.str, chars: item.str.length, bold: /bold|black|heavy/i.test(`${item.fontName} ${font.fontFamily || ''}`), height: viewport.height };
        }
        if (item.hasEOL && current) { lines.push(current); current = null; }
      }
      if (current) lines.push(current);
      viewports.push({ width: viewport.width, height: viewport.height });
      page.cleanup();
    }
    for (const line of lines) line.text = clean(line.text);
    const kept = lines.filter(line => line.text);
    // Running headers/footers: a short line repeated on many pages (anywhere on the page: slide decks put their
    // running title mid-height). Kept on page 1, where it is usually the real title. Bare page numbers go too.
    const repKey = text => text.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, ' ').trim();
    if (pageCount >= 3) {
      const pagesOf = new Map();
      for (const line of kept) { if (line.text.length > 90) continue; const key = repKey(line.text); if (!pagesOf.has(key)) pagesOf.set(key, new Set()); pagesOf.get(key).add(line.page); }
      const repeated = new Set([...pagesOf].filter(([key, pages]) => key && pages.size >= Math.max(3, Math.ceil(pageCount * 0.4))).map(([key]) => key));
      for (let i = kept.length - 1; i >= 0; i--) {
        const line = kept[i];
        if ((line.page !== 1 && line.text.length <= 90 && repeated.has(repKey(line.text))) || /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(line.text)) kept.splice(i, 1);
      }
    } else for (let i = kept.length - 1; i >= 0; i--) if (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(kept[i].text)) kept.splice(i, 1);
    // Bookmarks with no matching line are placed on their page, above the first line below their destination.
    for (const mark of bookmarks) {
      if (kept.some(line => normKey(line.text) === mark.key)) continue;
      const page = mark.page && mark.page <= pageCount ? mark.page : 1;
      let at = kept.findIndex(line => line.page > page || (line.page === page && mark.top != null && line.y < mark.top - 1));
      if (at < 0 && mark.top == null) at = kept.findIndex(line => line.page >= page);
      const spot = at < 0 ? kept.length : at;
      kept.splice(spot, 0, { page, y: mark.top == null ? Infinity : mark.top, x: 0, endX: 0, size: 0, text: mark.title, chars: mark.title.length, bold: false, bookmark: mark.level });
    }
    // Slide decks (landscape pages, little text per page) are structured like presentations: one title per slide.
    const landscape = viewports.filter(v => v.width > v.height).length > viewports.length / 2;
    const deck = !bookmarked && landscape && kept.reduce((n, line) => n + line.text.length, 0) / Math.max(1, pageCount) < 1200;
    // Body size = the size carrying the most characters.
    const weight = new Map();
    for (const line of kept) weight.set(line.size, (weight.get(line.size) || 0) + line.text.length);
    const body = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
    const total = kept.reduce((n, line) => n + line.text.length, 0) || 1;
    const big = [...weight].filter(([size, chars]) => size >= body * 1.12 && chars / total < 0.25).map(([size]) => size).sort((a, b) => b - a);
    const levelOf = size => { const i = big.findIndex(s => Math.abs(s - size) < 0.6); return i < 0 ? 0 : Math.min(i + 1, 3); };
    const blocks = []; let para = null; let titleTaken = false;
    const flush = () => { if (para) { blocks.push(para); para = null; } };
    kept.forEach((line, index) => {
      const key = normKey(line.text);
      const markLevel = line.bookmark || marks.get(key);
      const fontLevel = !line.bookmark && line.text.length <= LIMITS.heading && !/[,;]$/.test(line.text) ? levelOf(line.size) : 0;
      // With bookmarks, a heading found only by its font is a sub-heading inside the bookmarked section.
      const sizeLevel = fontLevel;
      const boldHeading = !sizeLevel && line.bold && line.size >= body - 0.2 && line.text.length <= 90 && !/[.,;:]$/.test(line.text) && /^[A-Z0-9]/.test(line.text) && !line.text.includes('  ');
      if (bookmarked && !markLevel && (sizeLevel || boldHeading)) { flush(); blocks.push({ kind: 'sub', text: line.text, page: line.page }); return; }
      if (markLevel || sizeLevel || boldHeading) {
        flush();
        const previous = blocks[blocks.length - 1];
        // A heading wrapped over two lines arrives as two lines of the same size.
        if (previous && previous.kind !== 'p' && previous.kind !== 'li' && previous.page === line.page && previous._size === line.size && !markLevel && kept[index - 1] && levelOf(kept[index - 1].size) === sizeLevel && sizeLevel) { previous.text = `${previous.text} ${line.text}`; return; }
        if (!titleTaken && line.page === 1 && fontLevel === 1 && !markLevel && big.length >= 2 && blocks.every(b => b.kind !== 'h')) { blocks.push({ kind: 'title', text: line.text, page: line.page, _size: line.size }); titleTaken = true; return; }
        blocks.push({ kind: 'h', level: markLevel || sizeLevel || 3, text: line.text, page: line.page, _size: line.size });
        return;
      }
      const bullet = line.text.match(/^([•●▪■◦\-–*]|\d{1,2}[.)]|[a-z][.)])\s+(.+)$/);
      if (bullet) { flush(); blocks.push({ kind: 'li', text: bullet[2], page: line.page, depth: 0 }); return; }
      const prev = kept[index - 1];
      const continues = para && prev && prev.page === line.page && Math.abs(prev.size - line.size) < 0.6 && Math.abs(prev.y - line.y) < line.size * 2.2;
      const lastLi = blocks[blocks.length - 1];
      if (!para && lastLi && lastLi.kind === 'li' && prev && prev.page === line.page && Math.abs(prev.y - line.y) < line.size * 1.8 && line.x > prev.x + 2) { lastLi.text += ` ${line.text}`; return; }
      if (continues) { para.text = /[A-Za-z]-$/.test(para.text) ? `${para.text}${line.text}` : `${para.text} ${line.text}`; para.lines.push(line.text); }
      else { flush(); para = { kind: 'p', text: line.text, page: line.page, lines: [line.text] }; }
    });
    flush();
    if (deck) deckLevels(blocks);
    splitNumberedItems(blocks);
    for (const block of blocks) delete block._size;
    // A page's picture is read as a whole page and its text goes after that page's own text.
    const images = imagePages.map(({ page, cover, textChars }) => ({ page, cover, textChars, at: blocks.reduce((n, b, i) => ((b.page || 0) <= page ? i + 1 : n), 0) }));
    return { blocks, pages: doc.numPages, images };
  } finally { await doc.destroy().catch(() => {}); }
}
/* Deck PDFs: on each page the largest heading is the slide title (level 1), other headings level 2. Page 1's largest
   line is the document title; its other headings are cover text. */
function deckLevels(blocks) {
  const pages = new Map();
  for (const b of blocks) if (b.kind === 'h' || b.kind === 'title') { if (!pages.has(b.page)) pages.set(b.page, []); pages.get(b.page).push(b); }
  const sentence = h => h.text.length > 90 || /[.:;,]$/.test(h.text);
  const asText = h => { h.kind = 'p'; delete h.level; };
  let hasTitle = false;
  for (const [page, heads] of pages) {
    const usable = heads.filter(h => !sentence(h));
    for (const h of heads) if (sentence(h)) asText(h);
    if (!usable.length) continue;
    const top = Math.max(...usable.map(h => h._size || 0));
    let main = usable.find(h => (h._size || 0) >= top - 0.6);
    // A big decorative word ("technē") does not take the slide title from a real multi-word title.
    if (main.text.split(/\s+/).length <= 2) { const words = h => h.text.split(/\s+/).length; const worded = usable.find(h => h !== main && words(h) > words(main) && (h._size || 0) >= top * 0.4); if (worded) main = worded; }
    for (const h of usable) {
      if (page === 1 && !hasTitle && h === main) { h.kind = 'title'; delete h.level; continue; }
      if (page === 1) { asText(h); continue; }
      h.kind = 'h'; h.level = h === main ? 1 : 2;
    }
    if (page === 1) hasTitle = true;
  }
}
/* "01 Explain … 02 Distinguish …" run together on a slide: one list item each. */
function splitNumberedItems(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== 'p' || !/^0?\d{1,2}[.)]?\s+\S/.test(b.text)) continue;
    const parts = b.text.split(/\s+(?=0\d[.)]?\s+[A-Z])/).map(t => t.replace(/^0?\d{1,2}[.)]?\s+/, '').trim()).filter(Boolean);
    blocks.splice(i, 1, ...parts.map(text => ({ kind: 'li', text, page: b.page, depth: 0 })));
  }
}
const normKey = text => clean(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function markdownBlocks(buffer) {
  const blocks = []; let para = []; let fence = false;
  const flush = () => { if (para.length) { blocks.push({ kind: 'p', text: clean(para.join(' ')) }); para = []; } };
  for (const raw of buffer.toString('utf8').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { flush(); fence = !fence; continue; }
    if (fence) { if (raw.trim()) para.push(raw.trim()); continue; }
    const h = raw.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) { flush(); blocks.push(h[1].length === 1 && !blocks.length ? { kind: 'title', text: clean(h[2]) } : { kind: 'h', level: Math.min(h[1].length, 3), text: clean(h[2]) }); continue; }
    const li = raw.match(/^(\s*)([-*+•]|\d+[.)])\s+(.+)$/);
    if (li) { flush(); blocks.push({ kind: 'li', text: clean(li[3].replace(/\*\*|__/g, '')), depth: Math.min(2, Math.floor(li[1].length / 2)) }); continue; }
    if (!raw.trim()) { flush(); continue; }
    para.push(raw.trim().replace(/\*\*|__/g, ''));
  }
  flush();
  // A single top-level heading is the document title; several are headings.
  const titles = blocks.filter(b => b.kind === 'title');
  if (titles.length && blocks.filter(b => b.kind === 'h' && b.level === 1).length === 0) {
    // "# Doc" then "## A", "## B": keep # as title, promote ## to level 1.
    for (const b of blocks) if (b.kind === 'h') b.level = Math.max(1, b.level - 1);
  } else for (const b of titles) { b.kind = 'h'; b.level = 1; } // several "#": each one is a topic, the first too
  return { blocks, pages: null };
}

/* Plain text: blank-line paragraphs; a short line that looks like a heading ("1.2 Transport", "MITOCHONDRIA",
   "Cell Membrane" followed by text) becomes one, numbered lines give their own level. */
function textBlocks(buffer) {
  const lines = buffer.toString('utf8').split(/\r?\n/);
  const blocks = []; let para = [];
  const flush = () => { if (para.length) { blocks.push({ kind: 'p', text: clean(para.join(' ')), lines: para.map(clean) }); para = []; } };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { flush(); return; }
    const numbered = line.match(/^(\d+(?:\.\d+){0,2})\.?\s+([A-Z].{1,100})$/);
    const next = (lines[i + 1] || '').trim(); const prev = (lines[i - 1] || '').trim();
    const shortTitle = line.length <= 80 && !/[.,;:!?]$/.test(line) && !prev && (next || i === 0) && (/^[A-Z0-9][^a-z]*$/.test(line) || /^([A-Z][\w'-]*\s?){1,8}$/.test(line));
    if (numbered && !/[.;]$/.test(numbered[2])) { flush(); blocks.push({ kind: 'h', level: Math.min(numbered[1].split('.').length, 3), text: numbered[2] }); return; }
    if (shortTitle) { flush(); blocks.push(!blocks.length ? { kind: 'title', text: line } : { kind: 'h', level: 1, text: line }); return; }
    const li = line.match(/^([-*•]|\d+[.)])\s+(.+)$/);
    if (li) { flush(); blocks.push({ kind: 'li', text: li[2], depth: 0 }); return; }
    para.push(line);
  });
  flush();
  return { blocks, pages: null };
}

const IMAGE_FILE = /^(png|jpe?g|webp)$/;
/* Package relationships: rId → entry path inside the zip ("../media/image3.png" from ppt/slides/ → ppt/media/image3.png). */
function relations(xml, dir) {
  const out = new Map();
  for (const rel of String(xml || '').match(/<Relationship [^>]+>/g) || []) {
    const id = (rel.match(/Id="([^"]+)"/) || [])[1]; const target = (rel.match(/Target="([^"]+)"/) || [])[1];
    if (!id || !target || /TargetMode="External"/.test(rel)) continue;
    const parts = (target.startsWith('/') ? target.slice(1) : dir + target).split('/'); const path = [];
    for (const part of parts) { if (part === '..') path.pop(); else if (part && part !== '.') path.push(part); }
    out.set(id, path.join('/'));
  }
  return out;
}

/* ───────── pictures read by the Learning Image Reader, turned back into blocks
   The reading is Markdown-like text: "# heading", "## heading", "- point", paragraphs. Inside a file with its own
   headings, a picture's headings are sub-headings of the section it sits in; in a file that is only pictures
   (an image upload, a scanned or infographic PDF), they are the file's headings. */
function imageBlocks(reading, { page = null, asHeadings = false } = {}) {
  if (!reading || reading.none) return [];
  const out = [];
  const heading = (text, level) => out.push(asHeadings ? { kind: 'h', level, text, page, image: true } : { kind: 'sub', text, page, image: true, depth: level });
  if (reading.title) heading(clean(reading.title), 1);
  let para = [];
  const flush = () => { if (para.length) { out.push({ kind: 'p', text: clean(para.join(' ')), page, image: true }); para = []; } };
  for (const raw of String(reading.text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    // A picture's own step numbers ("1 Identify the Work", "Step 2:") are dropped: the app numbers sections itself.
    if (h) { flush(); const text = clean(h[2].replace(/\*\*/g, '')).replace(/^(step\s*)?\d{1,2}[.):]?\s+(?=[A-Za-z])/i, '') || clean(h[2]); if (!reading.title || normKey(text) !== normKey(reading.title)) heading(text, Math.max(1, Math.min(h[1].length - 1 + (reading.title ? 1 : 0), 3))); continue; }
    const li = line.match(/^([-*•]|\d+[.)])\s+(.+)$/);
    if (li) { flush(); out.push({ kind: 'li', text: clean(li[2].replace(/\*\*/g, '')), depth: 0, page, image: true }); continue; }
    para.push(line.replace(/\*\*/g, ''));
  }
  flush();
  if (reading.summary) out.push({ kind: 'p', text: clean(reading.summary), page, image: true });
  return out.filter(b => b.text);
}
/* Plain text from an OCR model (glm-ocr, PaddleOCR-VL, LightOnOCR …) → { title, text, summary } in the reading format.
   OCR models return the words in reading order without structure; the structure comes back from their shape:
     a short line mostly in capitals                  → a panel heading   ("ANALYZE ORGANIZATIONAL GOALS")
     a short line ending in ":"                        → a label inside it ("Key Business Goals:", "Example:")
     a bullet (• ● ▪ - *)                              → a list item
     a lone step number before a heading               → dropped (the app numbers sections itself)
     any other line                                    → its own line (sentences, table rows such as "CSR (voice) 80 100 +20")
   Markdown or HTML tables some OCR models write are turned into "cell | cell" rows. */
/* An acronym in a line written in capitals: no vowel (CSR, HR, BPO), a digit (Q1), or a common one. "THE", "SET" and
   "GAPS" are words, not acronyms. */
const KNOWN_ACRONYMS = new Set(['AI', 'IT', 'UK', 'US', 'EU', 'UN', 'GDP', 'CEO', 'CFO', 'BPO', 'ATP', 'DNA', 'RNA', 'KPI', 'ROI', 'HR', 'CSR', 'USA', 'OK', 'IOT', 'API', 'SME', 'NGO']);
const isAcronym = w => { const letters = w.replace(/[^A-Za-z]/g, ''); return letters.length > 0 && letters.length <= 5 && letters === letters.toUpperCase() && (KNOWN_ACRONYMS.has(letters) || /\d/.test(w) || !/[AEIOU]/.test(letters)); };
function titleCase(text) {
  return text.split(/\s+/).map((w, i) => (isAcronym(w) ? w : i && /^(AND|OR|OF|THE|TO|IN|ON|FOR|A|AN|AT|BY|WITH|VS\.?|FROM|INTO)$/.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
}
/* OCR reads a chart column by column: "42 58 73 91" then "2021 2022 2023 2024". A run of value-only lines next to a
   run of the same number of short labels is paired back into "label: value" lines. */
function pairChartColumns(lines) {
  const isValue = l => /^[+\-]?[\d.,]+%?$/.test(l);
  const isLabel = l => l && !isValue(l) && l.split(' ').length <= 3 && l.length <= 24 && !/[.!?]$/.test(l) || /^(19|20)\d\d$/.test(l);
  const runAt = (i, test) => { const out = []; let j = i; while (j < lines.length && lines[j] && test(lines[j])) out.push(j++); return out; };
  const skipBlank = j => { while (j < lines.length && !lines[j]) j++; return j; };
  const out = lines.slice(); const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i) || !lines[i] || !isValue(lines[i]) || /^(19|20)\d\d$/.test(lines[i])) continue;
    const values = runAt(i, l => isValue(l) && !/^(19|20)\d\d$/.test(l)); if (values.length < 2) continue;
    const after = skipBlank(values[values.length - 1] + 1); const labels = runAt(after, isLabel);
    if (labels.length !== values.length) continue;
    values.forEach((v, k) => { out[labels[k]] = `${lines[labels[k]]}: ${lines[v]}`; drop.add(v); });
    i = labels[labels.length - 1];
  }
  return out.filter((_, i) => !drop.has(i));
}
/* Box labels inside a panel: kept as labels ("### Example"), never as panel headings. */
const LABEL = /^(examples?|for example|e\.g\.|key (points?|findings|ideas|terms|takeaways?|business goals)|notes?|considerations|results?|summary|tips?|remember|reminder|definition|in this example|other gaps identified|in short|why it matters|did you know)\b/i;
function ocrReading(raw) {
  let text = String(raw || '').replace(/\r/g, '');
  // HTML tables → rows
  text = text.replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' | ').replace(/<tr[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const lines = pairChartColumns(text.split('\n').map(l => l.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim())
    .filter(l => !/^\|?\s*:?-{3,}/.test(l))); // markdown table rules
  const words = l => l.split(' ').filter(Boolean);
  const capsShare = l => { const letters = l.replace(/[^A-Za-z]/g, ''); return letters.length ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0; };
  const isBullet = l => /^[•●▪◦■\-–*✓✔]\s*\S/.test(l);
  const isStep = l => /^\d{1,2}[.)]?$/.test(l);
  const isCaps = l => l.length <= 70 && words(l).length <= 9 && !/[.,;]$/.test(l) && capsShare(l) >= 0.75 && /[A-Z]{3}/.test(l);
  // Title Case: short, no closing punctuation, and its long words start with a capital ("Choose the Right Person").
  const isTitleCase = l => {
    const w = words(l); if (!w.length || w.length > 7 || l.length > 60 || /[.,;!?]$/.test(l) || !/^[A-Z0-9]/.test(l) || !/[A-Za-z]{3}/.test(l)) return false;
    const long = w.filter(x => x.replace(/[^A-Za-z]/g, '').length > 3);
    return !long.length || long.filter(x => /^[A-Z0-9("']/.test(x)).length / long.length >= 0.75;
  };
  const numeric = l => { const w = words(l); return w.length ? w.filter(x => /^[+\-]?[\d.,]+%?$/.test(x)).length / w.length : 0; };
  // A table row or chart labels: mostly numbers, two numbers or more, or a label ending in a bare number ("Team Leader 10").
  const isRow = l => numeric(l) >= 0.25 || (l.match(/(^|\s)[+\-]?\d[\d.,]*%?(?=\s|$)/g) || []).length >= 2 || /\s[+\-]?\d[\d.,]*%?$/.test(l);
  // A sentence has lowercase words ("Position Current Required Net Increase" is a table header, not one).
  const isSentence = l => !isRow(l) && (/[.!?]$/.test(l) || (words(l).length >= 5 && words(l).some(x => /^[a-z]{3,}/.test(x))));
  const next = i => { for (let j = i + 1; j < lines.length; j++) if (lines[j]) return { line: lines[j], at: j }; return null; };
  const prev = i => { for (let j = i - 1; j >= 0; j--) if (lines[j]) return lines[j]; return ''; };
  // What each line is: a panel heading, a box label, a bullet, a step number, or text.
  const kind = lines.map((l, i) => {
    if (!l) return 'blank';
    if (isBullet(l)) return 'bullet';
    if (isStep(l)) { const n = next(i); return n && (isCaps(n.line) || isTitleCase(n.line)) ? 'step' : 'text'; }
    const bare = l.replace(/:$/, '');
    if (LABEL.test(bare) && words(bare).length <= 5) return 'label';
    if (/:$/.test(l) && l.length <= 60 && words(l).length <= 7) return 'label';
    if (isRow(l) || !/[A-Za-z]{3}/.test(l)) return 'text';
    if (isCaps(l)) return 'heading';
    // A Title Case line is a heading when text or a list follows it and it does not continue a sentence.
    const n = next(i); const before = prev(i);
    if (isTitleCase(l) && n && !isRow(n.line) && (isSentence(n.line) || isBullet(n.line) || LABEL.test(n.line.replace(/:$/, ''))) && (!before || /[.!?:)"]$/.test(before) || isStep(before) || isCaps(before) || isTitleCase(before) || isBullet(before) || lines[i - 1] === '')) return 'heading';
    return 'text';
  });
  // The first line is the picture's title, unless it is the first of several panels of the same kind
  // ("DEMAND" / "SUPPLY" / "EQUILIBRIUM": each heading followed by one line, with no title above them).
  let title = '';
  const firstAt = kind.findIndex(k => k !== 'blank');
  if (firstAt >= 0 && (kind[firstAt] === 'heading' || (kind[firstAt] === 'text' && isTitleCase(lines[firstAt])))) {
    const heads = kind.map((k, i) => (k === 'heading' ? i : -1)).filter(i => i > firstAt);
    const bodyBetween = (from, to) => kind.slice(from + 1, to).filter(k => k === 'text' || k === 'bullet').length;
    const stepsUsed = kind.includes('step');
    const panels = heads.length >= 2 && !stepsUsed && bodyBetween(firstAt, heads[0]) === 1 && bodyBetween(heads[0], heads[1]) === 1 && isCaps(lines[firstAt]) === isCaps(lines[heads[0]]);
    if (!panels) { title = titleCase(lines[firstAt].replace(/:$/, '')); kind[firstAt] = 'title'; }
  }
  const out = [];
  lines.forEach((line, i) => {
    switch (kind[i]) {
      case 'blank': case 'step': case 'title': return;
      case 'bullet': out.push(`- ${line.replace(/^[•●▪◦■\-–*✓✔]\s*/, '')}`); return;
      case 'label': out.push(`### ${line.replace(/:$/, '')}`); return;
      case 'heading': out.push(`## ${isCaps(line) ? titleCase(line.replace(/:$/, '')) : line.replace(/:$/, '')}`); return;
      default:
        if (line.startsWith('|')) { out.push(`- ${line.replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(' | ')}`); return; }
        out.push(line, '');
    }
  });
  return { title, text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), summary: '' };
}

/* Inserts each picture's blocks where the picture sits (positions from extractBlocks). */
function applyImages(blocks, images, readings, { asHeadings = false } = {}) {
  const out = blocks.slice();
  const placed = images.map((img, i) => ({ img, i })).filter(({ img }) => readings.has(img.key)).sort((a, b) => b.img.at - a.img.at || b.i - a.i);
  for (const { img } of placed) {
    const at = Math.min(img.at, out.length); const reading = readings.get(img.key);
    // A slide with no title of its own ("Slide 7") takes the title of its picture.
    let named = false;
    if (reading && reading.title && img.page) {
      for (let i = at - 1; i >= 0; i--) {
        const b = out[i]; if (b.page !== img.page) break;
        if (b.kind === 'h') { if (/^slide \d+$/i.test(b.text)) { out[i] = { ...b, text: reading.title }; named = true; } break; }
      }
    }
    let added = imageBlocks(named ? { ...reading, title: '' } : reading, { page: img.page || null, asHeadings });
    if (img.page) {
      const own = new Set(out.filter(b => b.page === img.page && !b.image).flatMap(b => (b.lines && b.lines.length ? b.lines : [b.text])).map(normKey).filter(k => k.length >= 12));
      if (own.size) added = added.filter(b => b.kind === 'h' || b.kind === 'sub' || !own.has(normKey(b.text)));
    }
    out.splice(at, 0, ...added);
  }
  return out;
}

/* ───────── AI structure, for files whose headings look like body text (no heading styles, one font size).
   The file is shown to the Learning Document Analyzer as numbered source lines; it names the heading lines and their
   level. The headings are kept as text, so they apply again whenever the file is read. */
const STRUCTURE = Object.freeze({ windowChars: 9000, windows: 4, lineChars: 200, minChars: 500 });
function needsStructure(analysis) {
  return !analysis.empty && analysis.characters >= STRUCTURE.minChars && analysis.sections.filter(s => s.number).length < 2;
}
/* The source lines in order, numbered from 1, in windows of about 9,000 characters for the model. */
function structureWindows(blocks) {
  const lines = [];
  for (const b of blocks) if (b.kind !== 'title') for (const text of b.lines && b.lines.length ? b.lines : [b.text]) { const t = clean(text); if (t) lines.push(t); }
  const windows = []; let current = []; let size = 0;
  lines.forEach((text, i) => {
    const row = `[${i + 1}] ${text.slice(0, STRUCTURE.lineChars)}`;
    if (size + row.length > STRUCTURE.windowChars && current.length) { windows.push(current.join('\n')); current = []; size = 0; }
    current.push(row); size += row.length + 1;
  });
  if (current.length) windows.push(current.join('\n'));
  return { lines, windows: windows.slice(0, STRUCTURE.windows) };
}
/* "1 | 12" lines from the model → headings [{ text, level }]. Only real, short lines; never most of the file. */
function parseStructure(reply, lines) {
  const out = []; const seen = new Set();
  for (const m of String(reply || '').matchAll(/^\s*(?:H|level\s*)?([12])\s*[|:]\s*\[?(\d{1,5})\]?\s*$/gim)) {
    const n = Number(m[2]); const text = lines[n - 1];
    if (!text || seen.has(n) || text.length > LIMITS.heading || /[.,;:]$/.test(text) && text.split(/\s+/).length > 6) continue;
    seen.add(n); out.push({ n, text, level: Number(m[1]) });
  }
  out.sort((a, b) => a.n - b.n);
  if (out.length > Math.max(3, lines.length * 0.4)) return [];
  if (out.length && !out.some(h => h.level === 1)) for (const h of out) h.level = 1;
  return out.map(({ text, level }) => ({ text, level }));
}
/* Marks the named lines as headings, splitting a paragraph where a heading line sits inside it. */
function applyStructure(blocks, headings) {
  if (!headings || !headings.length) return blocks;
  const queue = headings.map(h => ({ ...h, key: normKey(h.text) })); let next = 0;
  const out = [];
  for (const b of blocks) {
    const lines = b.lines && b.lines.length ? b.lines : [b.text];
    if (b.kind === 'title' || b.kind === 'h' || next >= queue.length || !lines.some(l => normKey(l) === queue[next].key)) { out.push(b); continue; }
    let rest = [];
    const flushRest = () => { if (rest.length) { out.push({ ...b, kind: b.kind === 'li' ? 'li' : 'p', text: clean(rest.join(' ')), lines: rest }); rest = []; } };
    for (const line of lines) {
      if (next < queue.length && normKey(line) === queue[next].key) { flushRest(); out.push({ kind: 'h', level: queue[next].level, text: clean(line), page: b.page }); next++; }
      else rest.push(line);
    }
    flushRest();
  }
  return out;
}

async function extractBlocks(buffer, type) {
  if (IMAGE_FILE.test(type)) return { blocks: [], pages: 1, images: [{ at: 0, page: 1, whole: true }] };
  const result = type === 'docx' ? docxBlocks(buffer) : type === 'pptx' ? pptxBlocks(buffer) : type === 'pdf' ? await pdfBlocks(buffer)
    : type === 'md' ? markdownBlocks(buffer) : textBlocks(buffer);
  const kept = []; const shift = [];
  result.blocks.forEach(b => { shift.push(kept.length); if (b.text && kept.length < LIMITS.blocks) kept.push({ ...b, text: b.text.slice(0, 4000) }); });
  shift.push(kept.length);
  const images = (result.images || []).map(img => ({ ...img, at: shift[Math.min(img.at, shift.length - 1)] }));
  return { blocks: kept, pages: result.pages, images };
}

// ───────── 2. analysis
/* Key point signals. Each is a reason a student would be examined on a sentence; the weights were calibrated on the
   Learning benchmark (test/learning-bench.js). */
// Definitions in their many forms: "X is defined as", "X refers to", "X is the process by which", "X equals …".
const DEFINITION = new RegExp([
  String.raw`\b(is|are|was|were) (defined|known|described|referred to|termed|called|named) (as|to)?\b`,
  String.raw`\b(is|are) called\b`, String.raw`\bwhich is called\b`, String.raw`\b(refers?|refer) to\b`, String.raw`\bmeans?\b`, String.raw`\bstands? for\b`,
  String.raw`\b(is|are) (a|an|the) (process|term|name|study|measure|ability|tendency|amount|quantity|rate|type|kind|form|set|state|branch|principle|law|rule|theory|idea|growth|shift|change|movement|attraction|bond|pair|force)\b`,
  String.raw`\b(is|are) (a|an|the)\b`, String.raw`\bconsists? of\b`, String.raw`\b(is|are) (made|composed) (up )?of\b`, String.raw`\bdescribes?\b`,
  String.raw`\bmeasures?\b`, String.raw`\bequals?\b`, String.raw`\b(is|are) characteri[sz]ed by\b`, String.raw`\bin other words\b`, String.raw`\bthat is,`, String.raw`\bi\.e\.`
].join('|'), 'i');
// Importance said out loud.
const EMPHASIS = /\b(important|importantly|key|main|must|always|never|essential|crucial|vital|note that|significant|critical|primary|fundamental|central|major|chief|principal|in particular|above all)\b/i;
// Importance the sentence carries without saying it: cause and effect, rules and conditions, comparisons, processes.
const CAUSAL = /\b(because|therefore|thus|hence|so that|as a result|results? in|leads? to|caus(e|es|ed|ing)|due to|explains?|allows?|enables?|prevents?|produces?|creates?|forms?|drives?|increases?|decreases?|raises?|reduces?|depends? on|determines?|requires?|responsible for|is needed|are needed)\b/i;
const RULE = /^(when|if|whenever|as|unless|once|below|above|without|with)\b[^,]{3,120},|\b(other things equal|ceteris paribus|is proportional to|grows? (stronger|weaker)|(more|less|greater|smaller|higher|lower|stronger|weaker|shorter|longer|faster|slower) than)\b/i;
// Facts that look like exam material: dates, quantities with units, named laws and acts.
const FACTUAL = /\b(1[0-9]{3}|20[0-9]{2})\b|\d+(\.\d+)?\s?(%|°\s?[cf]?|percent|kg|g|mg|km|m|cm|mm|ml|l|s|ms|hours?|days?|years?|people|ions?|electrons?)\b|[A-Z][a-z]+ (Act|Law|Theory|Treaty|Revolution|Rule|Principle|Effect|Cycle|Scale)\b/;
// Talk about the lesson, the reader or the writer, opinions and anecdotes: never a key point.
const META = /^(in this (part|section|lecture|chapter|unit|topic)|let(’|')?s\b|let us\b|now\b|next\b|first,? we|we (will|shall|now|can|are going)|you (will|should|need|can|may)|remember to|don(’|')?t forget|read this|see (also|below|above)|note:)|\b(we will (see|look|return|discuss)|we'll|you('ll| will) need|this lecture|this course|the seminar|in class|exam answers?|check your notes|students (often|usually|tend|find)|many students|read (it|this) twice|(a|very) (fascinating|interesting) (story|topic)|deserves a|my (grandfather|grandmother|father|mother|teacher|own)|historians (still )?debate|for exactly this reason|it is worth (noting|mentioning))\b/i;
const PERSON = /\b(I|me|my|we|our|us|you|your)\b/;

function scoreSentence(text, ctx) {
  const len = text.length;
  if (len < 20 || len > 320) return ctx.listItem && len >= 6 && len < 20 ? 0.5 : -1;
  if (META.test(text)) return -4;
  let score = 0;
  if (DEFINITION.test(text)) score += 2.5;
  if (EMPHASIS.test(text)) score += 1;
  if (CAUSAL.test(text)) score += 1.2;
  if (RULE.test(text)) score += 1.2;
  if (FACTUAL.test(text)) score += 0.9; else if (/\d/.test(text)) score += 0.4;
  if (ctx.listItem) score += 1.5;
  if (ctx.strong && ctx.strong.some(b => text.includes(b))) score += 1.5; // bold, underlined or highlighted in Word
  const own = terms(text);
  // Heading words count with their word family: "metallic" and "metal", "urbanization" and "urban".
  const near = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
  const overlap = ctx.headingTerms.filter(h => own.some(t => near(t, h))).length;
  score += Math.min(overlap, 2) * 0.9;
  // Words that carry the whole file (its keywords) mark central statements.
  score += Math.min(own.filter(t => ctx.keywords.has(t)).length, 3) * 0.3;
  if (PERSON.test(text)) score -= 1.5;
  if (len > 220) score -= 0.8;
  if (/^(this|these|it|they|that|such|those)\b/i.test(text) && !overlap && !CAUSAL.test(text)) score -= 0.8;
  if (/\?$/.test(text)) score -= 1;
  return score;
}

/* Builds numbered sections from blocks. Levels are normalized so the top-most heading level used is 1. */
function buildSections(input, fileName) {
  let blocks = input;
  let title = (blocks.find(b => b.kind === 'title') || {}).text || '';
  // No marked title: a short first line with no closing punctuation, before any heading, is the title.
  const first = blocks[0];
  if (!title && first && first.kind === 'p' && first.text.length <= 90 && !/[.,;:!?]$/.test(first.text) && blocks.some(b => b.kind === 'h')) { title = first.text; blocks = blocks.slice(1); }
  // Two numbered levels, the same as the topic list: the top heading level used is 1 (topic), the next is 2
  // (subtopic: 1.1, 1.2 …). Deeper headings stay inside their subtopic as sub-headings, not numbered sections.
  const levels = [...new Set(blocks.filter(b => b.kind === 'h').map(b => b.level))].sort((a, b) => a - b);
  const rank = new Map(levels.map((level, i) => [level, i + 1]));
  const sections = []; const counters = [0, 0]; let prevLevel = 0;
  let current = { number: '', level: 0, title: 'Overview', page: blocks[0]?.page || null, body: [] };
  const push = () => { if (current.level > 0 || current.body.length) sections.push(current); };
  for (const block of blocks) {
    if (block.kind === 'title') continue;
    if (block.kind === 'h' && (rank.get(block.level) || 1) > MAX_LEVEL) { current.body.push({ kind: 'sub', text: headingText(block.text), page: block.page, ...(block.image ? { image: true, depth: 3 } : {}) }); continue; }
    if (block.kind === 'h') {
      push();
      // Never deeper than one level below the previous heading (no 1.1 straight after a title).
      const level = Math.min(rank.get(block.level) || 1, prevLevel + 1); prevLevel = level;
      counters[level - 1]++; for (let i = level; i < MAX_LEVEL; i++) counters[i] = 0;
      // A level-2 heading before any level-1 heading still gets a parent number (1.1 under an implied 1).
      for (let i = 0; i < level - 1; i++) if (!counters[i]) counters[i] = 1;
      current = { number: counters.slice(0, level).join('.'), level, title: headingText(block.text).slice(0, LIMITS.heading), page: block.page || null, body: [] };
    } else current.body.push(block);
  }
  push();
  if (!sections.length) sections.push({ number: '', level: 0, title: title || fileName, page: null, body: [] });
  return { title, sections };
}


/* The section's description: its first sentence, unless that is talk about the lesson ("In this part we look at …")
   or a bare lead-in; then the first sentence that says something. */
function describe(section) {
  const first = section.body.find(b => b.kind === 'p'); if (!first || section.body[0] !== first) return { text: '', from: null };
  const list = sentences(first.text);
  for (let i = 0; i < Math.min(list.length, 3); i++) {
    const s = list[i];
    if (META.test(s) || PERSON.test(s) || s.length < 25) continue;
    return { text: s.length > 240 ? `${s.slice(0, 237).trimEnd()}…` : s, from: i };
  }
  return { text: '', from: null };
}
/* A picture with panels (steps, columns, boxes) inside one section: each panel gives one point, its heading with its
   first statement ("Assign Tasks: Determine who will perform each task …"), in the picture's order. Box labels such as
   "Example" are not panels. Returns [] when the section has fewer than two panels. */
function panelPoints(section) {
  const out = []; let panel = null;
  // Panels are the picture's top heading level here; deeper ones are box labels inside a panel.
  const top = Math.min(...section.body.filter(b => b.kind === 'sub' && b.image).map(b => b.depth || 2));
  for (const b of section.body) {
    if (b.kind === 'sub' && b.image && (b.depth || 2) === top) { panel = { title: b.text, text: '' }; out.push(panel); continue; }
    if (b.kind === 'sub') continue;
    if (panel && !panel.text && b.image && (b.kind === 'p' || b.kind === 'li')) panel.text = sentences(b.text)[0] || b.text;
  }
  const points = out.filter(x => x.text).map(x => { const t = `${x.title}: ${x.text}`; return t.length > 300 ? `${t.slice(0, 297).trimEnd()}…` : t; });
  return points.length >= 2 ? points : [];
}
function keyPointsOf(section, max, ctx, skip) {
  const headingTerms = terms(section.title);
  for (const block of section.body) if (block.kind === 'sub') headingTerms.push(...terms(block.text));
  const candidates = [];
  section.body.forEach((block, bi) => {
    if (block.kind === 'sub') return; // a sub-heading names its part; it is not itself a point
    const base = { headingTerms, keywords: ctx.keywords, strong: block.strong };
    if (block.kind === 'li') candidates.push({ text: block.text, score: scoreSentence(block.text, { ...base, listItem: true }) + 0.5, order: bi * 100 });
    // The sentence used as the section's description is shown separately.
    else sentences(block.text).forEach((s, si) => { if (!(bi === 0 && si === skip)) candidates.push({ text: s, score: scoreSentence(s, base), order: bi * 100 + si }); });
  });
  // Short sections keep every real statement; longer ones only the strong ones.
  const bar = candidates.filter(c => c.score > -1).length <= 3 ? 0 : 1.6;
  const seen = new Set(); const picked = [];
  for (const c of candidates.filter(c => c.score >= bar).sort((a, b) => b.score - a.score || a.order - b.order)) {
    const key = terms(c.text).slice(0, 8).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key); picked.push(c);
    if (picked.length >= max) break;
  }
  return picked.sort((a, b) => a.order - b.order).map(c => (c.text.length > 300 ? `${c.text.slice(0, 297).trimEnd()}…` : c.text));
}

function keywordsOf(sections, max) { // raw sections: body is a list of blocks
  const counts = new Map(); const display = new Map();
  for (const s of sections) {
    if (s.level) for (const w of words(`${s.title} ${s.title}`)) if (w.length > 3 && !STOP.has(w) && !/^\d/.test(w)) { const k = stem(w); counts.set(k, (counts.get(k) || 0) + 2); if (!display.has(k)) display.set(k, w); }
    for (const b of s.body) for (const w of words(b.text)) if (w.length > 3 && !STOP.has(w) && !/^\d/.test(w)) { const k = stem(w); counts.set(k, (counts.get(k) || 0) + 1); if (!display.has(k)) display.set(k, w); }
  }
  return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => display.get(k));
}

/* The full analysis kept for a file: what the notes panel shows, what the .md says, and the chunks questions search. */
function analyze({ blocks, pages }, { fileName, fileType }) {
  const { title, sections: raw } = buildSections(blocks, fileName);
  const docTitle = title || (raw[0] && raw[0].level === 1 && raw.filter(s => s.level === 1).length === 1 ? raw[0].title : '') || fileName.replace(/\.[^.]+$/, '');
  const totalChars = blocks.reduce((n, b) => n + b.text.length, 0);
  const ctx = { keywords: new Set(keywordsOf(raw, 20).map(stem)) };
  const sections = raw.map(section => {
    const text = section.body.map(b => b.text).join(' ');
    const items = section.body.filter(b => b.kind === 'li').length;
    const max = Math.max(text.length > 1500 ? LIMITS.sectionPoints : text.length > 300 ? 3 : 2, Math.min(items, LIMITS.listPoints));
    const description = describe(section);
    return {
      number: section.number, level: section.level, title: section.title, page: section.page,
      subs: section.body.filter(b => b.kind === 'sub' && !b.image).map(b => b.text).slice(0, 12),
      // Everything read from the section's pictures, in order: shown whole in the notes, not only the key points.
      picture: section.body.filter(b => b.image).map(b => (b.kind === 'sub' ? `${(b.depth || 2) >= 3 ? '###' : '##'} ${b.text}` : b.kind === 'li' ? `- ${b.text}` : b.text)).slice(0, 120),
      description: description.text,
      keyPoints: (() => {
        const panels = panelPoints(section).slice(0, LIMITS.listPoints);
        if (!panels.length) return keyPointsOf(section, max, ctx, description.from);
        // Panels first, then the strongest other points while there is room (never repeating a panel's statement).
        const rest = keyPointsOf(section, max, ctx, description.from).filter(p => !panels.some(x => x.includes(p.replace(/…$/, '').slice(0, 60))));
        return [...panels, ...rest].slice(0, Math.max(max, panels.length));
      })(),
      body: section.body.map(b => (b.kind === 'li' ? `- ${b.text}` : b.kind === 'sub' ? `${b.text}:` : b.text)).join('\n')
    };
  });
  // Main points: the strongest key point of each top-level part, in order.
  const main = [];
  for (const s of sections) {
    if (main.length >= LIMITS.mainPoints) break;
    if (s.level > 1) continue;
    const point = s.description || s.keyPoints[0];
    if (point) main.push(s.level === 1 ? `${s.title}: ${point}` : point);
  }
  const chunks = []; let parent = '';
  for (const s of sections) {
    if (s.level <= 1) parent = s.title;
    const context = s.level > 1 ? parent : '';
    const path = s.number ? `${s.number} ${s.title}` : s.title;
    const body = s.body || '';
    if (!body.trim()) { if (s.level) chunks.push({ number: s.number, heading: path, context, page: s.page, text: s.title }); continue; }
    let start = 0;
    while (start < body.length && chunks.length < LIMITS.chunks) {
      let end = Math.min(body.length, start + LIMITS.chunk);
      if (end < body.length) { const cut = body.lastIndexOf('. ', end); if (cut > start + LIMITS.chunk * 0.5) end = cut + 1; }
      chunks.push({ number: s.number, heading: path, context, page: s.page, text: body.slice(start, end).trim() });
      if (end >= body.length) break;
      start = Math.max(end - 150, start + 1);
    }
  }
  return {
    version: 1, title: docTitle, fileName, fileType, pages: pages || null, characters: totalChars,
    mainPoints: main, keywords: keywordsOf(raw, LIMITS.keywords),
    sections: sections.map(({ body, ...rest }) => rest), chunks,
    empty: totalChars < 40
  };
}

// ───────── 3. markdown
const mdEsc = text => String(text).replace(/\r?\n/g, ' ').replace(/([\\`*_[\]])/g, '\\$1');
const pageNote = (fileType, page) => (page ? ` _(${fileType === 'pptx' ? 'slide' : 'p.'} ${page})_` : '');
/* The file's notes, in the file's own order: a contents list, the overview, then each topic (## 1) and subtopic
   (### 1.1) with its description, key points, sub-headings and the notes saved for it. Notes saved for no particular
   section close the file. Readable as plain text and by agents. */
function fileMarkdown(analysis, { sources = [], subjectMdPath = '', analyzedAt = new Date().toISOString(), enrichment = null, notes = [] } = {}) {
  const a = analysis; const out = [];
  const unit = a.fileType === 'pptx' ? 'slides' : 'pages';
  out.push(`# ${mdEsc(a.title)}`, '');
  out.push(`> **Source:** ${sources.map(mdEsc).join(', ') || mdEsc(a.fileName)} · ${a.fileType.toUpperCase()}${a.pages ? ` · ${a.pages} ${unit}` : ''}  `);
  out.push(`> **Analyzed:** ${analyzedAt}  `);
  if (subjectMdPath) out.push(`> **Subject information center:** ${subjectMdPath}`);
  out.push('');
  if (a.empty) out.push('_No readable text was found in this file (it may be scanned images)._', '');
  const numbered = a.sections.filter(s => s.number);
  if (numbered.length) {
    out.push('## Contents', '');
    for (const s of numbered) out.push(`${s.level > 1 ? '   ' : ''}${s.level > 1 ? '-' : `${s.number}.`} ${s.level > 1 ? `${s.number} ` : ''}${mdEsc(s.title)}${pageNote(a.fileType, s.page)}`);
    out.push('');
  }
  out.push('## Overview', '');
  if (enrichment && enrichment.overview) {
    out.push(enrichment.overview, '');
    if (enrichment.keyPoints && enrichment.keyPoints.length) { out.push('**Key ideas**', ''); for (const p of enrichment.keyPoints) out.push(`- ${p}`); out.push(''); }
  }
  if (a.mainPoints.length) { out.push('**Main points**', ''); for (const p of a.mainPoints) out.push(`- ${mdEsc(p)}`); out.push(''); }
  if (a.keywords.length) out.push(`**Key terms:** ${a.keywords.map(mdEsc).join(' · ')}`, '');
  const bySection = new Map(); const loose = [];
  for (const n of notes) { const at = (n.numbers || []).find(num => numbered.some(s => s.number === num)); if (at) { if (!bySection.has(at)) bySection.set(at, []); bySection.get(at).push(n); } else loose.push(n); }
  const noteLine = n => `> **${n.origin === 'user' ? 'Your note' : 'Note'}:** ${mdEsc(n.text)}`;
  for (const s of a.sections) {
    const empty = !s.number && !s.description && !s.keyPoints.length;
    if (empty) continue;
    out.push('---', '', `${s.level > 1 ? '###' : '##'} ${s.number ? `${s.number} ` : ''}${mdEsc(s.title)}${pageNote(a.fileType, s.page)}`, '');
    if (s.description) out.push(mdEsc(s.description), '');
    for (const p of s.keyPoints) out.push(`- ${mdEsc(p)}`);
    if (s.keyPoints.length) out.push('');
    if (s.subs && s.subs.length) out.push(`_Also covers: ${s.subs.map(mdEsc).join(' · ')}_`, '');
    if (s.picture && s.picture.length) {
      out.push(`**From the picture${s.page ? ` (${a.fileType === 'pptx' ? 'slide' : 'page'} ${s.page})` : ''}:**`, '');
      for (const line of s.picture) out.push(line.startsWith('### ') ? `  - _${mdEsc(line.slice(4))}:_` : line.startsWith('## ') ? `- **${mdEsc(line.slice(3))}**` : line.startsWith('- ') ? `    - ${mdEsc(line.slice(2))}` : `  - ${mdEsc(line)}`);
      out.push('');
    }
    for (const n of bySection.get(s.number) || []) out.push(noteLine(n), '');
  }
  if (loose.length) { out.push('---', '', '## Notes from your questions', ''); for (const n of loose) out.push(noteLine(n), ''); }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function subjectMarkdown({ subjectName, docs, notes = [], updatedAt = new Date().toISOString() }) {
  const out = [`# ${mdEsc(subjectName)} — File Data and Information Center`, '', `> Updated: ${updatedAt}  `, `> Documents: ${docs.length}`, ''];
  if (!docs.length) out.push('_No files analyzed yet. Upload topics on the subject page._', '');
  else {
    out.push('| # | Document | Source file(s) | Sections | Notes file |', '|---|---|---|---|---|');
    docs.forEach((d, i) => out.push(`| ${i + 1} | ${mdEsc(d.title)} | ${d.sources.map(mdEsc).join(', ')} | ${d.sectionCount} | ${d.mdFile} |`));
    out.push('');
    docs.forEach((d, i) => {
      out.push(`## ${i + 1}. ${mdEsc(d.title)}`, '', `- Notes file: ${d.mdPath}`, `- Source: ${d.sources.map(mdEsc).join(', ')}`);
      if (d.keywords.length) out.push(`- Keywords: ${d.keywords.join(', ')}`);
      out.push('');
      if (d.mainPoints.length) { for (const p of d.mainPoints) out.push(`- ${mdEsc(p)}`); out.push(''); }
      if (d.outline.length) { for (const s of d.outline) out.push(`${'  '.repeat(s.level - 1)}- ${s.number} ${mdEsc(s.title)}`); out.push(''); }
    });
  }
  if (notes.length) {
    out.push('## Saved notes', '');
    for (const n of notes) out.push(`- ${mdEsc(n.text)}${n.sources && n.sources.length ? ` _(from ${n.sources.join(', ')})_` : ''}`);
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ───────── 4. similar names
/* "Lecture 3 - Cells (v2).pdf", "lecture_3_cells_final.docx" → "lecture 3 cells". */
function baseName(fileName) {
  return String(fileName).toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/[_\-.]+/g, ' ').replace(/\((\d+|copy)\)/g, ' ')
    .replace(/\b(v|ver|version|rev)\s?\d+\b/g, ' ').replace(/\b(final|draft|copy|updated|new|latest|revised)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function bigrams(text) { const s = ` ${text} `; const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; }
function dice(a, b) {
  if (!a || !b) return 0; if (a === b) return 1;
  const x = bigrams(a); const y = bigrams(b); let both = 0; let total = 0;
  for (const [g, n] of x) { total += n; if (y.has(g)) both += Math.min(n, y.get(g)); }
  for (const n of y.values()) total += n;
  return (2 * both) / total;
}
/* The existing doc a new upload belongs to, or null. Numbers must agree ("Lecture 3" never updates "Lecture 4"). */
function similarDoc(fileName, docs, threshold = 0.86) {
  const name = baseName(fileName); if (!name) return null;
  const nums = name.match(/\d+/g) || [];
  let best = null;
  for (const doc of docs) {
    for (const source of doc.sources || [doc.fileName]) {
      const other = baseName(source);
      const otherNums = other.match(/\d+/g) || [];
      if (nums.join(',') !== otherNums.join(',')) continue;
      const score = dice(name, other);
      if (score >= threshold && (!best || score > best.score)) best = { doc, score };
    }
  }
  return best ? best.doc : null;
}

// ───────── 5. information center lookup
/* BM25 over chunks (heading text counts double). strict: run 1, needs at least half of the question's terms;
   broad: run 2, prefix matching and a lower bar, more results, the neighbouring chunk of each hit. */
function search(question, docs, { mode = 'strict', preferDocId = null, limit } = {}) {
  const qTerms = [...new Set(terms(question))];
  if (!qTerms.length) return { hits: [], terms: [] };
  const broad = mode === 'broad';
  const all = [];
  for (const doc of docs) doc.chunks.forEach((chunk, index) => all.push({ doc, chunk, index, tokens: [...terms(chunk.heading), ...terms(chunk.heading), ...terms(chunk.context || ''), ...terms(chunk.text)] }));
  if (!all.length) return { hits: [], terms: qTerms };
  const avg = all.reduce((n, c) => n + c.tokens.length, 0) / all.length || 1;
  const matches = (token, term) => token === term || (broad && term.length >= 4 && token.length >= 4 && (token.startsWith(term.slice(0, Math.max(4, term.length - 2))) || term.startsWith(token.slice(0, Math.max(4, token.length - 2))) || (term.length >= 5 && oneEdit(token, term))));
  const df = new Map();
  for (const term of qTerms) df.set(term, all.filter(c => c.tokens.some(t => matches(t, term))).length);
  const scored = all.map(c => {
    let score = 0; let covered = 0;
    for (const term of qTerms) {
      const tf = c.tokens.filter(t => matches(t, term)).length;
      if (!tf) continue;
      covered++;
      const idf = Math.log(1 + (all.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * c.tokens.length / avg));
    }
    if (preferDocId && c.doc.id === preferDocId) score *= 1.25;
    return { ...c, score, coverage: covered / qTerms.length };
  });
  const need = broad ? (qTerms.length <= 2 ? 0.5 : 0.3) : (qTerms.length === 1 ? 1 : qTerms.length <= 3 ? 0.6 : 0.5);
  const ranked = scored.filter(c => c.score > 0 && c.coverage >= need).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { hits: [], terms: qTerms };
  const top = ranked[0].score;
  const max = limit || (broad ? 8 : 5);
  let picked = ranked.filter(c => c.score >= top * (broad ? 0.2 : 0.35)).slice(0, max);
  if (broad) {
    const extra = [];
    for (const hit of picked.slice(0, 3)) {
      const next = all.find(c => c.doc === hit.doc && c.index === hit.index + 1);
      if (next && !picked.includes(next) && !extra.includes(next) && next.chunk.number === hit.chunk.number) extra.push({ ...next, score: hit.score * 0.5, coverage: 0 });
    }
    picked = [...picked, ...extra].slice(0, max + 2);
  }
  return { hits: picked.map(c => ({ docId: c.doc.id, docTitle: c.doc.title, fileName: c.doc.sources ? c.doc.sources[c.doc.sources.length - 1] : c.doc.fileName, number: c.chunk.number, heading: c.chunk.heading, page: c.chunk.page, text: c.chunk.text, score: Math.round(c.score * 100) / 100, coverage: Math.round(c.coverage * 100) / 100 })), terms: qTerms };
}

/* True when a and b differ by one inserted, deleted or changed letter (a typo). */
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
/* "Quiz me", "practice questions", "test me": practice questions written from the file. */
const QUIZ_RE = /\b(quiz(zes)?( me)?|practice (questions?|test|quiz|problems?|exam)|test me|review questions?|exam questions?|flash ?cards?|mock (test|exam)|reviewer)\b/i;
const isQuizRequest = question => QUIZ_RE.test(question);
/* Questions about the whole file ("summarize", "main points") are answered from the analysis, not a term search. */
const OVERVIEW_RE = /\b(summar(y|ies|ise|ize)|overview|main (idea|point|topic|part)s?|key (point|idea|takeaway|topic)s?|what('?s| is| are) (this|the|these) (file|document|lecture|presentation|reading|chapter|module|notes?|slides?)( all)? about|what (does|do) (this|the) (file|document|lecture|module|chapter) (cover|discuss|talk about)|what topics|outline|gist|tl;?dr)\b/i;
const isOverviewQuestion = question => OVERVIEW_RE.test(question);

/* Casual messages ("hi", "thanks!", "who are you?") get a normal reply instead of a file lookup. A greeting followed by
   a real question ("hi, what is ATP?") is a question. */
const SMALL_TALK = /^(hi+|hello+|hey+|hiya|yo|sup|good (morning|afternoon|evening|night)|morning|thanks?( (a lot|so much))?|thank you( (so|very) much)?|ty|thx|ok(ay)?|k|cool|nice|great|awesome|perfect|got it|bye|goodbye|see (you|ya)|how are you( doing)?|how('s| is) it going|what'?s up|who are you|what are you|what can you do|what do you do|help|test(ing)?|lol|haha+)\b/i;
function isSmallTalk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return false;
  const m = t.match(SMALL_TALK);
  if (!m) return false;
  const rest = t.slice(m[0].length).replace(/^[\s,!.?:;-]+/, '').replace(/\b(there|again|so much|a lot|assistant|bot|buddy|friend|you)\b/gi, ' ');
  return terms(rest).length === 0;
}

/* Follow-up questions lean on the previous turn: "What is it made of?", "and the second one?", "explain that simpler".
   A question is a follow-up when it has no subject words of its own, or only a few together with a reference word
   (it, that, the second …) or a continuation opener (and, what about, why, explain more …). The words that only point
   back are not counted as subject words. */
const REFERS = /\b(it|its|that|this|these|those|they|them|their|former|latter|first|second|third|fourth|last|previous|above|same|one|ones)\b/i;
const CONTINUES = /^\s*(and|but|so|also|then|what about|how about|why|how come|more|simpler|elaborate|example|for example|give (me )?(an? )?(another )?(example|examples)|tell me more|in simpler terms|explain (it|that|this|more|again|further|simpler|simply)|(can|could) you (explain|simplify|elaborate|give)|i (still )?(do ?n[o']?t|dont|did ?n[o']?t|didnt) (get|understand)|i'?m (confused|lost)|huh|what do you mean)\b/i;
const POINTERS = new Set(['first', 'second', 'third', 'fourth', 'last', 'previous', 'above', 'same', 'former', 'latter', 'example', 'simpler', 'simply', 'elaborate', 'further', 'again', 'term', 'mean'].map(stem));
function isFollowUp(question) {
  const q = String(question || '').trim();
  if (!q || q.length > 300) return false;
  const own = terms(q).filter(t => !POINTERS.has(t));
  if (!own.length) return true;
  return own.length <= 3 && (REFERS.test(q) || CONTINUES.test(q));
}

/* The student teaching the assistant, instead of asking: a fact that is not in the files ("my prof said the exam covers
   only chapter 2", "remember: Krebs cycle = citric acid cycle") or a preference for how answers should be
   ("keep answers short", "explain in Filipino"). Returns { kind, text } with the cue words removed, or null.
   Requests ("explain osmosis", "what is …") are never treated as teaching. */
const ASKING = /^\s*(what|why|how|when|where|who|whom|which|whose|is|are|was|were|do|does|did|can|could|would|should|will|shall|may|explain|describe|define|list|give|tell|show|compare|contrast|summari[sz]e|simplify|elaborate|quiz|test me|help)\b/i;
const PREFERENCE = /^\s*(please\s+)?((always|from now on|in the future)\b.*\b(answer|explain|reply|write|use|keep|give)\b|(keep|make) (your |the )?(answers?|replies|explanations?|it) (short|shorter|brief|briefer|simple|simpler|detailed|longer)|answer (me )?(in|with|using)\b|explain (things |it )?(like|as if)\b|use (bullet points?|bullets|simple words|plain words|examples|tagalog|filipino|english)\b|i (prefer|like|want) (short|shorter|brief|simple|detailed|long|bullet|answers|explanations|examples)|i('m| am) a (visual|beginner|slow)\b|i learn (best|better) (with|by|when))/i;
const FACT_CUE = /^\s*(remember( that|:)?|note( that|:)|fyi:?|for (your )?info(rmation)?:?|just so you know,?|keep in mind( that)?|for the exam,?|actually,?|correction:?)\s*|\b(my|our) (prof|professor|teacher|instructor|lecturer|tutor)( said| says| told (us|me)| mentioned)( that)?\b|\b(in (class|lecture|our class) (we|the prof|the teacher)|the (exam|quiz|test) (will|covers|is on|includes))\b/i;
function learningIntent(message) {
  const q = clean(message);
  if (!q || q.length > 500 || /\?\s*$/.test(q)) return null;
  if (PREFERENCE.test(q)) return { kind: 'preference', text: q.replace(/^\s*please\s+/i, '').slice(0, 200) };
  if (ASKING.test(q)) return null;
  const cue = q.match(FACT_CUE);
  if (!cue) return null;
  const text = clean(q.replace(/^\s*(remember( that|:)?|note( that|:)|fyi:?|for (your )?info(rmation)?:?|just so you know,?|keep in mind( that)?|correction:?)\s*/i, ''));
  if (terms(text).length < 3) return null;
  return { kind: 'fact', text: text.charAt(0).toUpperCase() + text.slice(1, 400) };
}
/* How an answer should be written: more detail, or simpler. */
const SIMPLER = /\b(simpl(er|ify|y put)|more simply|plain(er)? (words|english|language|terms)|easier (words|way|to understand)|in simple (terms|words)|like i'?m (5|five|a (kid|child|beginner))|eli5|for a beginner|dumb (it )?down)\b/i;
const DEEPER = /\b(elaborate|more detail(ed|s)?|in detail|in depth|explain (it |that |this )?more|tell me more|expand( on)?|go deeper|deeper|more about|step by step|fully explain|explain fully)\b/i;
const answerStyle = question => (SIMPLER.test(question) ? 'simpler' : DEEPER.test(question) ? 'deeper' : null);

/* Word files have no pages; the PDF copy Office makes does. Each heading takes the page of the same text in that PDF
   (searched in order), and the blocks after it inherit it. */
function assignPages(blocks, pdfBlocks) {
  const marks = pdfBlocks.filter(b => b.page).map(b => ({ key: normKey(b.text), page: b.page }));
  let from = 0; let page = 1;
  for (const block of blocks) {
    if (block.kind === 'h' || block.kind === 'title') {
      const key = normKey(block.text);
      const at = marks.findIndex((m, i) => i >= from && key && (m.key === key || (key.length > 12 && m.key.startsWith(key))));
      if (at >= 0) { page = marks[at].page; from = at + 1; }
    }
    block.page = page;
  }
  return blocks;
}

/* Without an AI model: the sentences from the hits that share the most terms with the question. */
function extractiveAnswer(question, hits, max = 3) {
  const qTerms = new Set(terms(question));
  const picked = [];
  for (const hit of hits) for (const s of sentences(hit.text.replace(/^- /gm, ''))) {
    const own = new Set(terms(s)); let n = 0; for (const t of qTerms) if (own.has(t)) n++;
    if (n) picked.push({ s, n, hit });
  }
  picked.sort((a, b) => b.n - a.n);
  const seen = new Set(); const out = [];
  for (const p of picked) { if (seen.has(p.s)) continue; seen.add(p.s); out.push(p); if (out.length >= max) break; }
  return out;
}

module.exports = { isQuizRequest, oneEdit, ocrReading, imageBlocks, applyImages, learningIntent, answerStyle, needsStructure, structureWindows, parseStructure, applyStructure, STRUCTURE, isSmallTalk, isFollowUp, assignPages, extractBlocks, analyze, fileMarkdown, subjectMarkdown, similarDoc, baseName, search, isOverviewQuestion, extractiveAnswer, sentences, terms, LIMITS };

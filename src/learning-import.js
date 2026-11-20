'use strict';
/* Topic import (main process). Reads an uploaded study file and returns its structure as topics:
     { outline: [{ title, level }], text, note }
   level 0 = topic (1, 2, 3), level 1 = subtopic (2.1, 2.2). `text` is the readable text kept for agents.
   No dependencies: DOCX and PPTX are zip archives of XML (read with node:zlib); PDFs give their outline
   (bookmarks). When a file has no usable structure, the caller adds it as one topic named after the file.

   Sources of structure:
     .docx  Title / Heading 1 → topic, Heading 2 → subtopic (style names read from word/styles.xml)
     .pptx  sections → topics with their slide titles as subtopics; without sections, slide titles → topics
     .pdf   bookmarks: top level → topic, second level → subtopic. Text is not extracted from PDFs yet.
     .md    # → topic, ## → subtopic;  .txt has no structure */
const zlib = require('node:zlib');

const MAX_FILE = 25 * 1024 * 1024;        // upload limit
const MAX_UNZIPPED = 80 * 1024 * 1024;    // total inflated bytes read from one archive (zip-bomb guard)
const MAX_ITEMS = 300;
const MAX_TEXT = 2 * 1024 * 1024;
const TYPES = Object.freeze(['pdf', 'docx', 'pptx', 'md', 'txt', 'png', 'jpg', 'jpeg', 'webp']);
const IMAGE_TYPES = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);

const clean = value => String(value).replace(/\s+/g, ' ').trim();
function entities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
    const c = code.toLowerCase();
    if (c[0] === '#') { const n = c[1] === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10); return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[c];
  });
}

// ───────── zip (stored and deflate entries; no zip64, no encryption)
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buffer.readUInt16LE(at + 10), flags = buffer.readUInt16LE(at + 8);
    const compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { method, flags, compressed, size, local });
    at += 46 + nameLength + extra + comment;
  }
  let used = 0;
  function raw(name) {
    const e = entries.get(name); if (!e) return null;
    if (e.flags & 1) throw new Error('encrypted archive');
    if (buffer.readUInt32LE(e.local) !== 0x04034b50) throw new Error('broken zip entry');
    const start = e.local + 30 + buffer.readUInt16LE(e.local + 26) + buffer.readUInt16LE(e.local + 28);
    const packed = buffer.subarray(start, start + e.compressed);
    if (used + e.size > MAX_UNZIPPED) throw new Error('archive too large');
    const data = e.method === 0 ? packed : e.method === 8 ? zlib.inflateRawSync(packed, { maxOutputLength: MAX_UNZIPPED - used }) : null;
    if (!data) throw new Error('unsupported compression');
    used += data.length;
    return data;
  }
  return {
    names: () => [...entries.keys()],
    has: name => entries.has(name),
    bytes: name => raw(name), // pictures in Word and PowerPoint files
    text(name) {
      const e = entries.get(name); if (!e) return null;
      if (e.flags & 1) throw new Error('encrypted archive');
      if (buffer.readUInt32LE(e.local) !== 0x04034b50) throw new Error('broken zip entry');
      const start = e.local + 30 + buffer.readUInt16LE(e.local + 26) + buffer.readUInt16LE(e.local + 28);
      const raw = buffer.subarray(start, start + e.compressed);
      if (used + e.size > MAX_UNZIPPED) throw new Error('archive too large');
      let data;
      if (e.method === 0) data = raw;
      else if (e.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED - used });
      else throw new Error('unsupported compression');
      used += data.length;
      return data.toString('utf8');
    }
  };
}
const tags = (xml, name) => xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>|<${name}/>`, 'g')) || [];
const runs = (xml, name) => entities((xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g')) || [])
  .map(t => t.replace(/<[^>]+>/g, '')).join(''));

// ───────── DOCX
function docx(buffer) {
  const zip = readZip(buffer);
  const doc = zip.text('word/document.xml'); if (!doc) throw new Error('missing document');
  const styles = new Map();
  for (const style of tags(zip.text('word/styles.xml') || '', 'w:style')) {
    const id = (style.match(/w:styleId="([^"]+)"/) || [])[1];
    const name = (style.match(/<w:name w:val="([^"]+)"/) || [])[1];
    if (id && name) styles.set(id, name.toLowerCase());
  }
  const outline = []; const lines = [];
  for (const p of tags(doc, 'w:p')) {
    const text = clean(runs(p, 'w:t'));
    if (!text) continue;
    lines.push(text);
    const id = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
    const name = id ? (styles.get(id) || id.toLowerCase()) : '';
    const heading = name === 'title' ? 1 : Number((name.match(/^heading ?(\d)$/) || [])[1] || 0);
    if (heading === 1) outline.push({ title: text, level: 0 });
    else if (heading === 2) outline.push({ title: text, level: 1 });
  }
  return { outline, text: lines.join('\n') };
}

// ───────── PPTX
function pptx(buffer) {
  const zip = readZip(buffer);
  const pres = zip.text('ppt/presentation.xml'); if (!pres) throw new Error('missing presentation');
  const rels = new Map();
  for (const rel of (zip.text('ppt/_rels/presentation.xml.rels') || '').match(/<Relationship [^>]+>/g) || []) {
    const id = (rel.match(/Id="([^"]+)"/) || [])[1], target = (rel.match(/Target="([^"]+)"/) || [])[1];
    if (id && target) rels.set(id, target.replace(/^\/?(ppt\/)?/, 'ppt/'));
  }
  const slideIds = []; // presentation order
  for (const s of pres.match(/<p:sldId [^>]+>/g) || []) {
    const sid = (s.match(/\bid="(\d+)"/) || [])[1], rid = (s.match(/r:id="([^"]+)"/) || [])[1];
    if (rid && rels.has(rid)) slideIds.push({ sid, file: rels.get(rid) });
  }
  const slides = slideIds.map(({ sid, file }) => {
    const xml = zip.text(file) || '';
    let title = '';
    for (const sp of tags(xml, 'p:sp')) if (/<p:ph[^>]*type="(title|ctrTitle)"/.test(sp)) { title = clean(runs(sp, 'a:t')); break; }
    return { sid, title, text: tags(xml, 'a:p').map(p => clean(runs(p, 'a:t'))).filter(Boolean).join('\n') };
  });
  const sections = [];
  for (const section of tags(pres, 'p14:section')) {
    const name = entities((section.match(/name="([^"]*)"/) || [])[1] || '');
    const ids = (section.match(/<p14:sldId id="(\d+)"/g) || []).map(t => t.match(/id="(\d+)"/)[1]);
    sections.push({ name: clean(name), ids });
  }
  const outline = [];
  // page = slide number in presentation order (also the page number of the PDF copy Office makes)
  const add = (title, level, page) => { const last = outline[outline.length - 1]; if (title && !(last && last.title === title && last.level === level)) outline.push(page ? { title, level, page } : { title, level }); };
  const slideNo = id => slides.findIndex(s => s.sid === id) + 1;
  if (sections.length > 1 || (sections.length === 1 && sections[0].name && !/^default section$/i.test(sections[0].name))) {
    for (const section of sections) {
      add(section.name || 'Section', 0, section.ids.map(slideNo).find(n => n > 0));
      for (const id of section.ids) { const slide = slides.find(s => s.sid === id); if (slide && slide.title) add(slide.title, 1, slideNo(id)); }
    }
  } else slides.forEach((slide, i) => add(slide.title, 0, i + 1));
  return { outline, text: slides.map((s, i) => `Slide ${i + 1}${s.title ? `: ${s.title}` : ''}\n${s.text}`).join('\n\n') };
}

// ───────── PDF outline (bookmarks), including outlines kept in compressed object streams
function pdfString(raw) {
  let bytes;
  if (raw[0] === '<') bytes = Buffer.from(raw.slice(1, -1).replace(/[^0-9a-f]/gi, '').padEnd(2, '0'), 'hex');
  else {
    const out = []; const s = raw.slice(1, -1);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\') { out.push(c.charCodeAt(0) & 0xff); continue; }
      const n = s[++i];
      if (n === undefined) break;
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (n in map) out.push(map[n]);
      else if (/[0-7]/.test(n)) { let oct = n; while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i]; out.push(parseInt(oct, 8) & 0xff); }
      else if (n === '\r') { if (s[i + 1] === '\n') i++; }
      else if (n !== '\n') out.push(n.charCodeAt(0) & 0xff);
    }
    bytes = Buffer.from(out);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let b = Buffer.from(bytes.subarray(2)); if (b.length % 2) b = b.subarray(0, b.length - 1);
    return clean(Buffer.from(b).swap16().toString('utf16le'));
  }
  return clean(bytes.toString('latin1'));
}
function readString(body, key) {
  const m = new RegExp(`/${key}\\s*[(<]`).exec(body); if (!m) return null;
  const i = m.index + m[0].length - 1;
  if (body[i] === '<') { const end = body.indexOf('>', i); return end < 0 ? null : body.slice(i, end + 1); }
  let depth = 0;
  for (let j = i; j < body.length; j++) {
    if (body[j] === '\\') { j++; continue; }
    if (body[j] === '(') depth++;
    else if (body[j] === ')' && --depth === 0) return body.slice(i, j + 1);
  }
  return null;
}
const ref = (body, key) => { const m = body.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`)); return m ? Number(m[1]) : null; };
function pdf(buffer) {
  const src = buffer.toString('latin1');
  if (!src.startsWith('%PDF')) throw new Error('not a PDF');
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(src)) throw new Error('encrypted PDF');
  const objects = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g; let m;
  const streams = [];
  while ((m = re.exec(src))) {
    const end = src.indexOf('endobj', re.lastIndex); if (end < 0) break;
    const body = src.slice(re.lastIndex, end);
    objects.set(Number(m[1]), body);
    if (/\/Type\s*\/ObjStm/.test(body)) streams.push(body);
    re.lastIndex = end;
  }
  let inflated = 0;
  for (const body of streams) {
    const s = body.search(/stream\r?\n/); const e = body.lastIndexOf('endstream'); if (s < 0 || e < 0) continue;
    const start = s + body.slice(s).match(/stream\r?\n/)[0].length;
    let data = Buffer.from(body.slice(start, e), 'latin1');
    if (/\/FlateDecode/.test(body.slice(0, s))) { try { data = zlib.inflateSync(data, { maxOutputLength: MAX_UNZIPPED }); } catch { continue; } }
    else if (/\/Filter/.test(body.slice(0, s))) continue;
    if ((inflated += data.length) > MAX_UNZIPPED) break;
    const text = data.toString('latin1');
    const first = Number((body.match(/\/First\s+(\d+)/) || [])[1]), n = Number((body.match(/\/N\s+(\d+)/) || [])[1]);
    if (!Number.isFinite(first) || !Number.isFinite(n)) continue;
    const head = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n && 2 * k + 1 < head.length; k++) {
      const from = first + head[2 * k + 1], to = k + 1 < n && 2 * k + 3 < head.length ? first + head[2 * k + 3] : text.length;
      if (!objects.has(head[2 * k])) objects.set(head[2 * k], text.slice(from, to));
    }
  }
  const catalog = [...objects.values()].find(body => /\/Type\s*\/Catalog/.test(body));
  const root = catalog ? ref(catalog, 'Outlines') : null;
  const pages = catalog ? pageOrder(objects, ref(catalog, 'Pages')) : [];
  const resolve = destResolver(objects, catalog || '', pages);
  const outline = [];
  const seen = new Set();
  function walk(id, level) {
    while (id != null && !seen.has(id) && outline.length < MAX_ITEMS) {
      seen.add(id);
      const body = objects.get(id); if (!body) return;
      const raw = readString(body, 'Title');
      const title = raw ? pdfString(raw) : '';
      if (title && level <= 1) { const page = resolve(body); outline.push(page ? { title, level, page } : { title, level }); }
      if (level < 1) walk(ref(body, 'First'), level + 1);
      id = ref(body, 'Next');
    }
  }
  if (root != null && objects.has(root)) walk(ref(objects.get(root), 'First'), 0);
  return { outline, text: '', pages: pages.length, note: outline.length ? '' : 'This PDF has no bookmarks to split by.' };
}
/* Page objects in reading order (the /Pages tree, depth first). */
function pageOrder(objects, rootId) {
  const out = []; const seen = new Set();
  (function visit(id) {
    if (id == null || seen.has(id) || out.length > 100000) return;
    seen.add(id);
    const body = objects.get(id); if (!body) return;
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const kids = (body.match(/\/Kids\s*\[([^\]]*)\]/) || [])[1] || '';
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) visit(Number(k[1]));
    } else out.push(id);
  })(rootId);
  return out;
}
/* Bookmark → 1-based page number: direct /Dest arrays, /A GoTo actions, and named destinations
   (the /Dests dictionary or the /Names → /Dests name tree). Returns null when it cannot tell. */
function destResolver(objects, catalog, pages) {
  const pageOf = text => {
    const m = /^\s*\[\s*(\d+)\s+\d+\s+R/.exec(text || '');
    const index = m ? pages.indexOf(Number(m[1])) : -1;
    return index >= 0 ? index + 1 : null;
  };
  const deref = text => { const m = /^\s*(\d+)\s+\d+\s+R/.exec(text); return m ? objects.get(Number(m[1])) || '' : text; };
  // A destination value: an array, or a dictionary holding /D [array]
  const fromValue = text => { const v = deref(text); return pageOf(v) || pageOf((v.match(/\/D\s*(\[[^\]]*\])/) || [])[1]); };
  let names = null;
  function named(name) {
    if (!names) {
      names = new Map();
      const dests = ref(catalog, 'Dests');
      if (dests != null) for (const m of (objects.get(dests) || '').matchAll(/\/([^\s/\[\]<>()]+)\s*(\[[^\]]*\]|\d+\s+\d+\s+R|<<[\s\S]*?>>)/g)) names.set(m[1], m[2]);
      const inline = (catalog.match(/\/Names\s*<<([\s\S]*?)>>/) || [])[1];
      const namesDict = inline != null ? inline : objects.get(ref(catalog, 'Names')) || '';
      const seen = new Set();
      (function tree(id) {
        if (id == null || seen.has(id) || names.size > 50000) return;
        seen.add(id);
        const body = objects.get(id) || '';
        const list = (body.match(/\/Names\s*\[([\s\S]*)\]/) || [])[1];
        if (list) for (const m of list.matchAll(/(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>)\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/g)) names.set(pdfString(m[1]), m[2]);
        const kids = (body.match(/\/Kids\s*\[([^\]]*)\]/) || [])[1] || '';
        for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) tree(Number(k[1]));
      })(ref(namesDict, 'Dests'));
    }
    return names.has(name) ? fromValue(names.get(name)) : null;
  }
  function fromKey(body, key) {
    let m = new RegExp(`/${key}\\s*(\\[[^\\]]*\\])`).exec(body); if (m) return pageOf(m[1]);
    m = new RegExp(`/${key}\\s+(\\d+\\s+\\d+\\s+R)`).exec(body); if (m) return fromValue(m[1]);
    const raw = readString(body, key); if (raw) return named(pdfString(raw));
    m = new RegExp(`/${key}\\s*/([^\\s/\\[\\]<>()]+)`).exec(body); if (m) return named(m[1]);
    return null;
  }
  return body => {
    try {
      const direct = fromKey(body, 'Dest'); if (direct) return direct;
      const inline = (body.match(/\/A\s*<<([\s\S]*?)>>/) || [])[1];
      const action = inline != null ? inline : objects.get(ref(body, 'A')) || '';
      return action ? fromKey(action, 'D') : null;
    } catch { return null; }
  };
}

// ───────── Markdown / text
function markdown(buffer) {
  const text = buffer.toString('utf8');
  const outline = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (h) outline.push({ title: clean(h[2]), level: h[1].length - 1 });
  }
  return { outline, text };
}

function typeOf(fileName) {
  const ext = String(fileName).toLowerCase().split('.').pop();
  return TYPES.includes(ext) ? ext : null;
}
/* Never throws for a broken file: it returns an empty outline and a note, so the file is still kept as one topic.
   Topics come from the same reader as the notes panel (learning-intel: Word heading styles and outline levels,
   PowerPoint sections and slide titles, PDF bookmarks and font sizes, Markdown #), so a topic's number in the list and
   its section number in the notes are always the same. Numbered sections at level 1 become topics, level 2 subtopics. */
async function parseFile(buffer, fileName) {
  const type = typeOf(fileName);
  if (!type) throw new Error('Choose a PDF, Word (.docx), PowerPoint (.pptx), Markdown or text file.');
  if (buffer.length > MAX_FILE) throw new Error('Files must be 25 MB or smaller.');
  let result;
  try {
    const intel = require('./learning-intel'); // loaded here: learning-intel itself uses readZip from this module
    const analysis = intel.analyze(await intel.extractBlocks(buffer, type), { fileName, fileType: type });
    const text = type === 'docx' ? docx(buffer).text : type === 'pptx' ? pptx(buffer).text : type === 'pdf' ? '' : buffer.toString('utf8');
    result = { outline: analysis.sections.filter(s => s.number).map(s => ({ title: s.title, level: s.level - 1, page: s.page })), text };
  } catch (error) {
    // A PDF the text reader cannot open may still have readable bookmarks.
    if (type === 'pdf') { const outline = pdfBookmarks(buffer); if (outline.length) return finish(type, { outline, text: '' }); }
    return { type, outline: [], text: '', note: `The file could not be read (${error.message}).` };
  }
  if (type === 'pdf' && !result.outline.length) { const outline = pdfBookmarks(buffer); if (outline.length) result.outline = outline; }
  return finish(type, result);
}
function finish(type, result) {
  const outline = result.outline.map(item => {
    const clean = { title: item.title.slice(0, 200), level: item.level ? 1 : 0 };
    if (Number.isInteger(item.page) && item.page > 0) clean.page = item.page;
    return clean;
  }).filter(item => item.title).slice(0, MAX_ITEMS);
  return { type, outline, text: (result.text || '').slice(0, MAX_TEXT), note: result.note || (outline.length ? '' : type === 'pdf' ? 'This PDF has no bookmarks or headings to split by.' : 'No headings were found to split by.') };
}

/* An upload becomes one topic named after its file; its headings are navigated through the notes panel's key points.
   This keeps only the readable text for agents (Word, PowerPoint, Markdown, text). Never throws for a broken file. */
function readText(buffer, fileName) {
  const type = typeOf(fileName);
  if (!type) throw new Error('Choose a PDF, Word (.docx), PowerPoint (.pptx), Markdown, text or image (PNG, JPG, WebP) file.');
  if (buffer.length > MAX_FILE) throw new Error('Files must be 25 MB or smaller.');
  if (IMAGE_TYPES.includes(type)) return { type, text: '', note: '' }; // its text comes from the Image Reader
  try {
    const text = type === 'docx' ? docx(buffer).text : type === 'pptx' ? pptx(buffer).text : type === 'pdf' ? '' : buffer.toString('utf8');
    return { type, text: text.slice(0, MAX_TEXT), note: '' };
  } catch (error) { return { type, text: '', note: `The file could not be read (${error.message}).` }; }
}

/* Bookmarks of a PDF with their pages: Word writes one per heading in the PDF copy Office makes, which gives each
   Word topic its page. */
function pdfBookmarks(buffer) { try { return pdf(buffer).outline; } catch { return []; } }

module.exports = { parseFile, readText, pdfBookmarks, typeOf, TYPES, IMAGE_TYPES, MAX_FILE, readZip };

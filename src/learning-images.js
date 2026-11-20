'use strict';
/* Pictures in study files, for the Learning Image Reader (main process).

   collect(bytes, type, extracted)  → the pictures worth reading, in reading order, each with a stable key:
       Word / PowerPoint  the media a paragraph or slide shows (word/media, ppt/media), PNG / JPEG / WebP only;
                          icons, bullets and logos are skipped (smaller than 160 px, or repeated on many slides)
       PDF                every page that draws a picture, rendered as a whole page (infographics, scanned pages)
       PNG / JPG / WebP   the uploaded image itself
   load(entry)                      → { mime, data: <base64> } for the vision model, read only when needed

   Keys are content hashes (page renders: the file's hash + page), so a reading is cached once and reused for the
   same picture in any file, version or re-read. */
const { createHash } = require('node:crypto');
const { readZip } = require('./learning-import');

const LIMITS = Object.freeze({ perFile: 40, minSide: 160, maxBytes: 12 * 1024 * 1024, renderWidth: 1280, maxSide: 1280 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 40);

/* Format and size from the file header (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X). */
function imageInfo(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]; const length = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + length;
    }
    return { mime: 'image/jpeg', width: 0, height: 0 };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { mime: 'image/webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
    if (kind === 'VP8 ') return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return { mime: 'image/webp', width: 0, height: 0 };
  }
  return null;
}
const bigEnough = info => info && (!info.width || (Math.max(info.width, info.height) >= LIMITS.minSide && Math.min(info.width, info.height) >= 60));

function collect(bytes, type, extracted) {
  const refs = (extracted && extracted.images) || [];
  if (!refs.length) return [];
  if (/^(png|jpe?g|webp)$/.test(type)) {
    const info = imageInfo(bytes);
    return info ? [{ key: sha(bytes), at: 0, page: 1, whole: true, mime: info.mime, bytes }] : [];
  }
  if (type === 'pdf') {
    const fileKey = sha(bytes);
    return refs.slice(0, LIMITS.perFile).map(ref => ({ key: `${fileKey}-p${ref.page}`, at: ref.at, page: ref.page, pdfPage: ref.page }));
  }
  // Word / PowerPoint: media entries; a picture on most slides (a logo, a template background) is decoration.
  const zip = readZip(bytes);
  const seen = new Map(); const out = [];
  for (const ref of refs) {
    let data; try { data = zip.bytes(ref.target); } catch { data = null; }
    if (!data || data.length > LIMITS.maxBytes) continue;
    const info = imageInfo(data); if (!bigEnough(info)) continue;
    const key = sha(data);
    seen.set(key, (seen.get(key) || 0) + 1);
    if (seen.get(key) > 1) continue;
    out.push({ key, at: ref.at, page: ref.page || null, mime: info.mime, bytes: data, target: ref.target });
  }
  const pages = (extracted.pages || 0);
  const repeated = new Set([...seen].filter(([, n]) => n >= 3 && (!pages || n >= pages * 0.4)).map(([key]) => key));
  return out.filter(img => !repeated.has(img.key)).slice(0, LIMITS.perFile);
}

/* A picture larger than 1,280 px on its long side is scaled down for the vision model: small text stays readable
   and it costs far fewer image tokens. Smaller pictures are sent as they are. */
async function shrink(entry) {
  const info = imageInfo(entry.bytes);
  const side = info ? Math.max(info.width, info.height) : 0;
  if (!side || side <= LIMITS.maxSide) return { mime: entry.mime, data: Buffer.from(entry.bytes).toString('base64') };
  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(entry.bytes));
    const scale = LIMITS.maxSide / side;
    const canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { mime: 'image/png', data: canvas.toBuffer('image/png').toString('base64') };
  } catch { return { mime: entry.mime, data: Buffer.from(entry.bytes).toString('base64') }; }
}

/* Loader for one file's pictures; PDF pages are drawn with pdf.js on @napi-rs/canvas, one document per loader. */
function loader(bytes, type) {
  let pdf = null;
  async function load(entry) {
    if (entry.bytes) return shrink(entry);
    if (type !== 'pdf') return null;
    if (!pdf) {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
    }
    const { createCanvas } = require('@napi-rs/canvas');
    const page = await pdf.getPage(entry.pdfPage);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, LIMITS.renderWidth / Math.max(1, base.width)) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    page.cleanup();
    return { mime: 'image/png', data: canvas.toBuffer('image/png').toString('base64') };
  }
  async function close() { if (pdf) await pdf.destroy().catch(() => {}); pdf = null; }
  return { load, close };
}

module.exports = { collect, loader, imageInfo, LIMITS };

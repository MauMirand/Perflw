'use strict';
/* The Learning workflow's file reader. Every heavy read (PDF parsing, pictures, page renders) runs in one worker
   thread (learning-reader-worker.js), one request at a time, so the window never freezes. The worker starts on
   first use and stops after a minute without work, returning its memory (pdf.js, canvas). If a worker cannot
   start, the same operations run in this process instead, so files are still read.

   Operations (createOps, used by the worker and by the in-process fallback):
     read     { file, type, preview? } → { blocks, pages, images }   images: positions and keys, no bytes
     picture  { file, type, entry }    → { mime, data }              base64 for the vision / OCR model
     release  { file }                 → true                        closes a PDF kept open for its pictures */
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const IDLE_MS = 60000;

function createOps() {
  const intel = require('./learning-intel');
  const pictures = require('./learning-images');
  const { readZip } = require('./learning-import');
  const open = new Map(); // a PDF stays open while its pages are rendered one by one
  return {
    async read({ file, type, preview }) {
      const bytes = fs.readFileSync(file);
      const extracted = await intel.extractBlocks(bytes, type);
      if (type === 'docx' && preview) {
        try { intel.assignPages(extracted.blocks, (await intel.extractBlocks(fs.readFileSync(preview), 'pdf')).blocks); } catch { /* pages stay unknown */ }
      }
      let images = [];
      try { images = pictures.collect(bytes, type, extracted).map(({ bytes: _bytes, ...entry }) => entry); } catch { images = []; }
      return { blocks: extracted.blocks, pages: extracted.pages, images };
    },
    async picture({ file, type, entry }) {
      if (type === 'pdf') {
        if (!open.has(file)) open.set(file, pictures.loader(fs.readFileSync(file), type));
        return open.get(file).load(entry);
      }
      const bytes = fs.readFileSync(file);
      const data = entry.whole ? bytes : entry.target ? readZip(bytes).bytes(entry.target) : null;
      if (!data) throw new Error('The picture could not be found in the file.');
      const loader = pictures.loader(data, type);
      try { return await loader.load({ ...entry, bytes: data }); } finally { await loader.close(); }
    },
    async release({ file }) {
      const loader = open.get(file); open.delete(file);
      if (loader) await loader.close();
      return true;
    }
  };
}

function createFileReader({ inline = false } = {}) {
  let worker = null; let seq = 0; let idle = null; let local = null;
  const waiting = new Map();
  const here = () => (local || (local = createOps()));

  function start() {
    worker = new Worker(path.join(__dirname, 'learning-reader-worker.js'));
    worker.unref(); // never keeps the app alive
    worker.on('message', ({ id, ok, value, error }) => {
      const job = waiting.get(id); if (!job) return;
      waiting.delete(id);
      if (ok) job.resolve(value); else job.reject(new Error(error));
      if (!waiting.size) armIdle();
    });
    const fail = error => {
      for (const job of waiting.values()) job.reject(error instanceof Error ? error : new Error('The file reader stopped.'));
      waiting.clear(); worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', code => { if (waiting.size) fail(new Error(`The file reader stopped (${code}).`)); worker = null; });
  }
  function armIdle() {
    clearTimeout(idle);
    idle = setTimeout(() => { if (worker && !waiting.size) { const w = worker; worker = null; w.terminate().catch(() => {}); } }, IDLE_MS);
    if (idle.unref) idle.unref();
  }
  function call(op, args) {
    if (inline) return here()[op](args);
    clearTimeout(idle);
    try { if (!worker) start(); } catch { inline = true; return here()[op](args); }
    return new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); worker.postMessage({ id, op, args }); });
  }
  return {
    read: args => call('read', args),
    picture: args => call('picture', args),
    release: file => call('release', { file }),
    close: async () => { clearTimeout(idle); if (worker) { const w = worker; worker = null; await w.terminate().catch(() => {}); } }
  };
}

module.exports = { createFileReader, createOps };

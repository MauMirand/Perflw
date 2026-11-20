'use strict';
/* The Learning document workflow (main process).

   Upload ─► direct conversion ─► pre-analysis ─► file .md (update a similar one, or create) ─► subject information
   center .md ─► notes panel                                         (analyzeFile, queued one file at a time)
   AI overview by the Learning Document Analyzer agent, added to the .md and the notes panel   (enrich, after that)

   Question in the Ask panel ─► information center lookup ─► Learning Subject Assistant agent
     data found     ─► answer with sources + notes saved to the notes panel
     no data        ─► 2nd run (broad lookup across every file) ─► still nothing ─► warning: not in the file

   Storage, per account: learning-files/<account>/intel/<subjectId>/
     state.json            documents, which uploaded files belong to each, analysis status, saved notes
     docs/<docId>.json     the full analysis (sections, key points, retrieval chunks)
     docs/<docId>.md       the file's notes (readable by people and agents)
     SUBJECT.md            File Data and Information Center: every document of the subject and its outline
   Pure analysis lives in learning-intel.js; agents and skills in learning-agents.js. */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const intel = require('./learning-intel');
const { createLearningAgents } = require('./learning-agents');
const { createFileReader } = require('./learning-files');

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_ID = /^[a-z0-9-]{1,60}$/;
const MAX_NOTES = 300;
const ENRICH_TIMEOUT = 180000;
const STRUCTURE_TIMEOUT = 300000;
const IMAGE_TIMEOUT = 600000; // one picture: a vision model that does not fit the GPU can take minutes
const ASK_TIMEOUT = 240000;
const ANALYSIS_VERSION = 2; // 2: pictures are read; files analyzed with an older version are read again
const NOT_FOUND_MESSAGE = 'Your question regarding the file is not included in the file.';

/* ocr(model, image, signal) → plain text: the local OCR model, called directly (no instructions: OCR models take a task
   prompt only). Injected by tests; the default talks to local Ollama. */
function ollamaOcr() {
  const runtime = require('./automation/ollama').createOllamaRuntime();
  return async (model, image, signal) => (await runtime.chat({ model, name: 'Learning Image Reader', messages: [{ role: 'user', content: 'Text Recognition:', images: [image.data] }], options: { num_ctx: 8192, temperature: 0 }, keepAlive: '45s', signal })).text;
}

function createLearningWorkflow({ root, workspace, ecosystem, emit = () => {}, ocr = ollamaOcr(), files = createFileReader() }) {
  const stored = (userId, name) => path.join(base(userId), name);
  // Reads a study file in the worker thread: blocks, pages and where its pictures sit.
  const readFile = (userId, file, withPreview = true) => files.read({ file: stored(userId, file.storedName), type: file.type, preview: withPreview && file.type === 'docx' && file.preview === 'ready' && file.previewName ? stored(userId, file.previewName) : null });
  const agents = createLearningAgents({ ecosystem, root });
  const base = userId => { if (!ID.test(userId)) throw new Error('Invalid account.'); return path.join(root, 'learning-files', userId); };
  const subjectDir = (userId, subjectId) => { if (!ID.test(subjectId)) throw new Error('Subject not found.'); return path.join(base(userId), 'intel', subjectId); };
  const docFile = (userId, subjectId, docId, ext) => { if (!DOC_ID.test(docId)) throw new Error('Document not found.'); return path.join(subjectDir(userId, subjectId), 'docs', `${docId}.${ext}`); };
  const subjectMdPath = (userId, subjectId) => path.join(subjectDir(userId, subjectId), 'SUBJECT.md');

  function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
  // state.json is read, changed and written with no await in between, so queued work never interleaves a write.
  const loadState = (userId, subjectId) => {
    const state = readJson(path.join(subjectDir(userId, subjectId), 'state.json'), null) || {};
    return { version: 1, docs: Array.isArray(state.docs) ? state.docs : [], files: state.files && typeof state.files === 'object' ? state.files : {}, notes: Array.isArray(state.notes) ? state.notes : [] };
  };
  const saveState = (userId, subjectId, state) => write(path.join(subjectDir(userId, subjectId), 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const loadDoc = (userId, subjectId, docId) => readJson(docFile(userId, subjectId, docId, 'json'), null);

  function slugFor(state, title) {
    const stem = String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'document';
    let id = stem; let n = 2;
    while (state.docs.some(d => d.id === id)) id = `${stem.slice(0, 44)}-${n++}`;
    return id;
  }
  function subjectName(userId, subjectId) {
    for (const profile of ['study', 'personal']) { const hit = workspace.listSubjects(userId, profile).find(s => s.id === subjectId); if (hit) return hit.name; }
    return 'Subject';
  }
  function writeDocMarkdown(userId, subjectId, doc, analysis, notes = loadState(userId, subjectId).notes) {
    const own = notes.filter(n => (n.docIds || []).includes(doc.id)).slice().reverse(); // oldest first, in reading order
    write(docFile(userId, subjectId, doc.id, 'md'), intel.fileMarkdown(analysis, { sources: doc.sources, subjectMdPath: subjectMdPath(userId, subjectId), analyzedAt: doc.updatedAt, enrichment: doc.enrichment, notes: own }));
  }
  /* Notes changed: every document they belong to gets its .md written again, then the information center. */
  function notesChanged(userId, subjectId, state, docIds) {
    for (const docId of new Set(docIds)) {
      const doc = state.docs.find(d => d.id === docId); const analysis = doc && loadDoc(userId, subjectId, docId);
      if (doc && analysis) writeDocMarkdown(userId, subjectId, doc, analysis, state.notes);
    }
    rebuildSubject(userId, subjectId, state);
  }
  function rebuildSubject(userId, subjectId, state) {
    const docs = state.docs.map(doc => {
      const analysis = loadDoc(userId, subjectId, doc.id) || { title: doc.title, mainPoints: [], keywords: [], sections: [] };
      return {
        title: analysis.title, sources: doc.sources, mdFile: `docs/${doc.id}.md`, mdPath: docFile(userId, subjectId, doc.id, 'md'),
        sectionCount: analysis.sections.filter(s => s.number).length, keywords: analysis.keywords, mainPoints: analysis.mainPoints,
        outline: analysis.sections.filter(s => s.number).map(s => ({ number: s.number, level: s.level, title: s.title }))
      };
    });
    write(subjectMdPath(userId, subjectId), intel.subjectMarkdown({ subjectName: subjectName(userId, subjectId), docs, notes: state.notes }));
  }

  // ───────── upload → conversion → pre-analysis → .md (queued)
  const queue = []; let busy = false;
  const enrichQueue = []; let enriching = false;
  const structuring = new Set(); // docIds whose headings the Analyzer is reading now (shown in the notes panel)
  const imaging = new Map();     // docId → { done, total } while the Image Reader reads its pictures
  function queueFile(userId, fileId) {
    let file; try { file = workspace.topicFile(userId, fileId); } catch { return; }
    const state = loadState(userId, file.subjectId);
    if (!queue.some(job => job.fileId === fileId)) {
      state.files[fileId] = { ...(state.files[fileId] || {}), status: 'pending', error: '', name: file.name };
      saveState(userId, file.subjectId, state);
      queue.push({ userId, fileId });
      emit({ type: 'analysis', subjectId: file.subjectId, fileId, status: 'pending' });
    }
    run();
  }
  async function run() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const { userId, fileId } = queue.shift();
        let file; try { file = workspace.topicFile(userId, fileId); } catch { continue; } // deleted meanwhile
        let status = 'ready'; let error = '';
        try { await analyzeFile(userId, file); }
        catch (failure) {
          status = 'failed'; error = `The file could not be analyzed (${failure.message}).`;
          try { const state = loadState(userId, file.subjectId); state.files[fileId] = { ...(state.files[fileId] || {}), status, error }; saveState(userId, file.subjectId, state); } catch { /* subject removed */ }
        }
        emit({ type: 'analysis', subjectId: file.subjectId, fileId, status, error });
      }
    } finally { busy = false; }
  }
  // ───────── pictures: readings cached per picture (content hash), shared by every file and version
  const imageCacheFile = (userId, key) => path.join(base(userId), 'intel', 'image-cache', `${key}.json`);
  const cachedReading = (userId, key) => readJson(imageCacheFile(userId, key), null);
  function pictureReadings(userId, images) {
    const readings = new Map();
    for (const img of images) { const r = cachedReading(userId, img.key); if (r) readings.set(img.key, r); }
    return readings;
  }

  async function analyzeFile(userId, file, { queue = true } = {}) {
    const extracted = await readFile(userId, file);                                                  // direct conversion
    // Pictures already read go where they sit; a file that is only pictures takes its headings from them.
    const images = extracted.images || [];
    const readings = pictureReadings(userId, images);
    const imageOnly = extracted.blocks.length === 0;
    if (readings.size) extracted.blocks = intel.applyImages(extracted.blocks, images, readings, { asHeadings: imageOnly });
    // Headings the Analyzer found earlier for this file (no heading styles in it) apply again on every read.
    const earlier = loadState(userId, file.subjectId).docs.find(d => d.fileIds.includes(file.id));
    if (earlier && earlier.aiHeadings) extracted.blocks = intel.applyStructure(extracted.blocks, earlier.aiHeadings);
    const analysis = intel.analyze(extracted, { fileName: file.name, fileType: file.type });           // pre-analysis
    let still; try { still = workspace.topicFile(userId, file.id); } catch { still = null; }
    if (!still) return;
    const state = loadState(userId, file.subjectId);
    // Which .md this file writes: the one it already has, one with a similar name (update), or a new one (create).
    let doc = state.docs.find(d => d.fileIds.includes(file.id))
      || intel.similarDoc(file.name, state.docs.map(d => ({ ...d, fileName: d.sources[d.sources.length - 1] })));
    const action = doc ? (doc.fileIds.includes(file.id) ? 'reanalyzed' : 'updated') : 'created';
    if (doc) doc = state.docs.find(d => d.id === doc.id);
    else { doc = { id: slugFor(state, intel.baseName(file.name) || analysis.title), fileIds: [], sources: [], createdAt: new Date().toISOString() }; state.docs.push(doc); }
    doc.fileIds = [...doc.fileIds.filter(id => id !== file.id), file.id];
    doc.sources = [...doc.sources.filter(name => name !== file.name), file.name];
    // Same text as last time (e.g. read again once Office made the PDF copy, for pages): keep the AI overview.
    const textHash = createHash('sha256').update(analysis.chunks.map(c => c.text).join('\n')).digest('hex');
    const unchanged = Boolean(doc.textHash === textHash && doc.enrichStatus === 'ready' && doc.enrichment);
    doc.title = analysis.title; doc.updatedAt = new Date().toISOString(); doc.latestFileId = file.id; doc.textHash = textHash;
    const failed = new Set(doc.imagesFailed || []);
    const imagesDue = images.some(img => !readings.has(img.key) && !failed.has(img.key));
    doc.images = { total: images.length, read: readings.size };
    if (!unchanged) { doc.enrichment = null; doc.enrichStatus = 'pending'; doc.enrichError = ''; }
    write(docFile(userId, file.subjectId, doc.id, 'json'), JSON.stringify(analysis));
    writeDocMarkdown(userId, file.subjectId, doc, analysis);
    state.files[file.id] = { status: 'ready', error: '', name: file.name, docId: doc.id, action, version: ANALYSIS_VERSION };
    saveState(userId, file.subjectId, state);
    rebuildSubject(userId, file.subjectId, state);
    if (!queue) return { analysis, doc };
    const structureDue = intel.needsStructure(analysis) && !doc.structureStatus;
    if (unchanged && !structureDue && !imagesDue) return { analysis, doc };
    if (!analysis.empty || imagesDue) { enrichQueue.push({ userId, subjectId: file.subjectId, docId: doc.id }); runEnrich(); }
    else { doc.enrichStatus = 'skipped'; saveState(userId, file.subjectId, state); }
    return { analysis, doc };
  }

  /* The Image Reader reads the file's pictures that have no reading yet, one at a time, and caches each reading.
     Returns true when at least one new reading was saved. */
  async function readPictures(userId, subjectId, docId, notify) {
    const doc = loadState(userId, subjectId).docs.find(d => d.id === docId); if (!doc) return false;
    let file; try { file = workspace.topicFile(userId, doc.latestFileId); } catch { return false; }
    let images; try { images = (await readFile(userId, file, false)).images || []; } catch { return false; }
    const failed = new Set(doc.imagesFailed || []);
    const todo = images.filter(img => !cachedReading(userId, img.key) && !failed.has(img.key));
    if (!todo.length) return false;
    const reader = await agents.ready(userId, 'reader');
    if (reader.missing) { setEnrich(userId, subjectId, docId, { imagesError: reader.missing }); notify('images-unavailable'); return false; }
    const progress = { done: 0, total: todo.length }; imaging.set(docId, progress); notify('images');
    let saved = 0; const newlyFailed = [];
    try {
      for (const img of todo) {
        // A question in the Ask panel goes first: the next picture waits until it is answered (one model at a time).
        for (let waited = 0; asks.size && waited < ASK_TIMEOUT; waited += 500) await new Promise(r => setTimeout(r, 500));
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT);
        try {
          const picture = await files.picture({ file: stored(userId, file.storedName), type: file.type, entry: img });
          if (!picture) throw new Error('The picture could not be read.');
          const where = img.whole ? 'the whole file' : img.page ? `${file.type === 'pptx' ? 'slide' : 'page'} ${img.page}` : 'inside the text';
          const prompt = `Picture from the study file "${file.name}" (${where}). Read it in the exact format of the Learning image reading skill.`;
          const reading = reader.ocr
            ? intel.ocrReading(await ocr(reader.model, picture, controller.signal))
            : parseReading(await ecosystem.runAgent(userId, { agent: { id: reader.id, name: reader.name }, prompt, images: [picture], signal: controller.signal, workflow: null }));
          if (!reading.none && !reading.title && !reading.text) reading.none = true;
          write(imageCacheFile(userId, img.key), `${JSON.stringify({ ...reading, model: reader.model, at: new Date().toISOString() })}\n`);
          saved++;
          // Its text shows in the notes at once, not after every picture of the file.
          try { const now = workspace.topicFile(userId, file.id); await analyzeFile(userId, now, { queue: false }); } catch { /* file removed */ }
        } catch { newlyFailed.push(img.key); }
        finally { clearTimeout(timer); progress.done++; notify('images'); }
      }
    } finally { imaging.delete(docId); await files.release(stored(userId, file.storedName)).catch(() => {}); }
    setEnrich(userId, subjectId, docId, { imagesFailed: [...failed, ...newlyFailed].slice(-200), imagesError: newlyFailed.length && !saved ? `${reader.name} could not read the pictures with ${reader.model}.` : '' });
    return saved > 0;
  }
  /* Image Reader output → { title, text, summary } or { none: true }. */
  function parseReading(raw) {
    const body = String(raw || '').replace(/\r/g, '').trim();
    if (/^NO_CONTENT\b/i.test(body) || (/NO_CONTENT/.test(body) && body.length < 60)) return { none: true };
    const title = ((body.match(/^\s*TITLE:\s*(.*)$/im) || [])[1] || '').trim();
    const summary = ((body.match(/^\s*SUMMARY:\s*([\s\S]*)$/im) || [])[1] || '').trim().split('\n')[0];
    let text = (body.match(/TEXT:\s*([\s\S]*?)(?:\n\s*SUMMARY:|$)/i) || [])[1];
    if (text == null) text = body.replace(/^\s*TITLE:.*$/im, '').replace(/^\s*SUMMARY:[\s\S]*$/im, '');
    return { title: /^none$/i.test(title) ? '' : title.slice(0, 200), text: text.trim().slice(0, 12000), summary: summary.slice(0, 400) };
  }

  // ───────── AI overview by the Learning Document Analyzer
  async function runEnrich() {
    if (enriching) return;
    enriching = true;
    try {
      while (enrichQueue.length) {
        const job = enrichQueue.shift();
        if (enrichQueue.some(other => other.subjectId === job.subjectId && other.docId === job.docId)) continue; // a newer upload replaces it
        await enrich(job).catch(() => {});
      }
    } finally { enriching = false; }
  }
  function setEnrich(userId, subjectId, docId, patch) {
    const state = loadState(userId, subjectId); const doc = state.docs.find(d => d.id === docId); if (!doc) return null;
    Object.assign(doc, patch); saveState(userId, subjectId, state);
    return { state, doc };
  }
  async function enrich({ userId, subjectId, docId }) {
    let analysis = loadDoc(userId, subjectId, docId); if (!analysis) return;
    const notify = status => { const state = loadState(userId, subjectId); const doc = state.docs.find(d => d.id === docId); if (doc) for (const fileId of doc.fileIds) emit({ type: 'analysis', subjectId, fileId, status: 'ready', enrich: status }); };
    // Pictures first: their text joins the notes, the structure and the overview.
    if (await readPictures(userId, subjectId, docId, notify)) {
      const doc = loadState(userId, subjectId).docs.find(d => d.id === docId);
      let file = null; try { file = doc && workspace.topicFile(userId, doc.latestFileId); } catch { file = null; }
      if (file) { const again = await analyzeFile(userId, file, { queue: false }); if (again && again.analysis) analysis = again.analysis; }
      notify('images-done');
    }
    if (analysis.empty) { setEnrich(userId, subjectId, docId, { enrichStatus: 'skipped' }); notify('skipped'); return; }
    const agent = await agents.ready(userId, 'analyzer');
    if (agent.missing) { setEnrich(userId, subjectId, docId, { enrichStatus: 'unavailable', enrichError: agent.missing }); notify('unavailable'); return; }
    // No headings found by style or font: the Analyzer reads the lines and names them first.
    const current = loadState(userId, subjectId).docs.find(d => d.id === docId);
    if (current && !current.structureStatus && intel.needsStructure(analysis)) {
      structuring.add(docId); notify('structuring');
      try { analysis = (await structure(userId, subjectId, docId, agent)) || analysis; } finally { structuring.delete(docId); }
      const after = loadState(userId, subjectId).docs.find(d => d.id === docId);
      if (after && after.enrichStatus === 'ready' && after.enrichment && after.structureStatus !== 'done') { notify('ready'); return; } // nothing changed: keep the overview
    }
    setEnrich(userId, subjectId, docId, { enrichStatus: 'running', enrichError: '' }); notify('running');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ENRICH_TIMEOUT);
    try {
      const text = await ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt: enrichPrompt(analysis), signal: controller.signal, workflow: null });
      const parsed = parseEnrichment(text);
      if (!parsed.overview) throw new Error('The analyzer did not return an overview.');
      const saved = setEnrich(userId, subjectId, docId, { enrichment: { ...parsed, model: agent.model, at: new Date().toISOString() }, enrichStatus: 'ready', enrichError: '' });
      if (saved) { writeDocMarkdown(userId, subjectId, saved.doc, analysis); rebuildSubject(userId, subjectId, saved.state); }
      notify('ready');
    } catch (error) {
      setEnrich(userId, subjectId, docId, { enrichStatus: 'failed', enrichError: controller.signal.aborted ? 'The AI overview took too long and was stopped.' : error.message });
      notify('failed');
    } finally { clearTimeout(timer); }
  }
  /* AI structure: the Analyzer names the heading lines of a file with no heading styles. Saved on the document as
     text, so every later read applies them again. The file stays one topic; its headings show in the key points. */
  async function structure(userId, subjectId, docId, agent) {
    const state = loadState(userId, subjectId); const doc = state.docs.find(d => d.id === docId); if (!doc) return null;
    let file; try { file = workspace.topicFile(userId, doc.latestFileId); } catch { return null; }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), STRUCTURE_TIMEOUT);
    try {
      const extracted = await readFile(userId, file, false);
      const { lines, windows } = intel.structureWindows(extracted.blocks);
      const headings = [];
      for (const [i, window] of windows.entries()) {
        const prompt = `Task: find the heading lines of this study file. Follow the Learning document structure skill and its output format exactly; this request does not use the OVERVIEW / KEY POINTS format.\nStudy file: ${file.name}${windows.length > 1 ? ` (part ${i + 1} of ${windows.length})` : ''}\n\nSource lines:\n${window}\n\nReply with "<level> | <line number>" lines, or NONE.`;
        const text = await ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt, signal: controller.signal, workflow: null, skills: ['learning-document-structure'] });
        headings.push(...intel.parseStructure(text, lines));
      }
      if (headings.filter(h => h.level === 1).length < 2 && headings.length < 3) { setEnrich(userId, subjectId, docId, { structureStatus: 'none' }); return null; }
      if (file.type === 'docx' && file.preview === 'ready' && file.previewName) {
        try { const paged = await readFile(userId, file); extracted.blocks.forEach((b, i) => { if (paged.blocks[i]) b.page = paged.blocks[i].page; }); } catch { /* pages stay unknown */ }
      }
      const analysis = intel.analyze({ ...extracted, blocks: intel.applyStructure(extracted.blocks, headings) }, { fileName: file.name, fileType: file.type });
      // The text hash follows the structured reading, so reading the file again keeps the overview written next.
      const textHash = createHash('sha256').update(analysis.chunks.map(c => c.text).join('\n')).digest('hex');
      const saved = setEnrich(userId, subjectId, docId, { aiHeadings: headings, structureStatus: 'done', textHash, updatedAt: new Date().toISOString() });
      if (!saved) return null;
      write(docFile(userId, subjectId, docId, 'json'), JSON.stringify(analysis));
      writeDocMarkdown(userId, subjectId, saved.doc, analysis, saved.state.notes);
      rebuildSubject(userId, subjectId, saved.state);
      return analysis;
    } catch {
      setEnrich(userId, subjectId, docId, { structureStatus: controller.signal.aborted ? 'timeout' : 'failed' });
      return null;
    } finally { clearTimeout(timer); }
  }
  /* The Analyzer reads the outline and each section's own text (not only the rule-based key points, which can miss
     what matters), within about 12,000 characters: long sections are shortened evenly so every section is seen. */
  function enrichPrompt(a) {
    const sections = a.sections.filter(s => s.number || s.description || s.keyPoints.length);
    const textOf = s => a.chunks.filter(c => c.number === s.number && (s.number || c.heading === s.title)).map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
    const outline = sections.filter(s => s.number).map(s => `${s.level > 1 ? '  ' : ''}${s.number} ${s.title}`).join('\n');
    const head = `Study file: ${a.title} (${a.fileName})\n\nOutline:\n${outline || '(no headings)'}\n\nSections:\n`;
    const budget = Math.max(3000, 12000 - head.length);
    const bodies = sections.map(s => textOf(s) || [s.description, ...s.keyPoints].filter(Boolean).join(' '));
    const total = bodies.reduce((n, t) => n + t.length, 0) || 1;
    const share = text => (total <= budget ? text : text.slice(0, Math.max(300, Math.floor(budget * text.length / total))));
    const parts = sections.map((s, i) => `[${s.number || '-'}] ${s.title}\n${share(bodies[i])}`);
    return `${head}${parts.join('\n\n')}\n\nWrite the OVERVIEW and KEY POINTS for this file in the exact format of the Learning key points skill. Cover every main section.`;
  }
  function parseEnrichment(text) {
    const body = String(text || '').replace(/\r/g, '');
    const overview = ((body.match(/OVERVIEW:\s*([\s\S]*?)(?:\n\s*KEY POINTS:|$)/i) || [])[1] || '').trim().replace(/\n+/g, ' ').slice(0, 1200);
    const list = ((body.match(/KEY POINTS:\s*([\s\S]*)$/i) || [])[1] || '');
    const keyPoints = list.split('\n').map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(line => line.length > 3).slice(0, 8).map(line => line.slice(0, 300));
    return { overview, keyPoints };
  }

  // ───────── reads for the notes panel
  function fileAnalysis(userId, fileId) {
    const file = workspace.topicFile(userId, fileId);
    const state = loadState(userId, file.subjectId);
    const entry = state.files[file.id];
    if (!entry) { queueFile(userId, file.id); return { status: 'pending', fileId: file.id }; }   // uploaded before this workflow existed
    if (entry.status !== 'ready') return { status: entry.status, error: entry.error || '', fileId: file.id };
    const doc = state.docs.find(d => d.id === entry.docId);
    const analysis = doc && loadDoc(userId, file.subjectId, doc.id);
    if (!doc || !analysis) { queueFile(userId, file.id); return { status: 'pending', fileId: file.id }; }
    if ((entry.version || 1) < ANALYSIS_VERSION && !queue.some(job => job.fileId === file.id)) queueFile(userId, file.id); // shown now, refreshed when read again
    return {
      status: 'ready', fileId: file.id, docId: doc.id, title: analysis.title, fileType: analysis.fileType, pages: analysis.pages, empty: analysis.empty,
      sources: doc.sources, latest: doc.latestFileId === file.id, action: entry.action,
      mainPoints: analysis.mainPoints, keywords: analysis.keywords,
      sections: analysis.sections.map(s => ({ number: s.number, level: s.level, title: s.title, page: s.page, description: s.description, keyPoints: s.keyPoints, picture: s.picture || [] })),
      enrichment: doc.enrichment || null, enrichStatus: doc.enrichStatus || 'none', enrichError: doc.enrichError || '',
      structuring: structuring.has(doc.id), structure: doc.structureStatus === 'done' ? 'ai' : 'file',
      images: { total: (doc.images && doc.images.total) || 0, read: (doc.images && doc.images.read) || 0, reading: imaging.get(doc.id) || null, error: doc.imagesError || '' },
      mdPath: docFile(userId, file.subjectId, doc.id, 'md'), subjectMdPath: subjectMdPath(userId, file.subjectId)
    };
  }
  function reanalyze(userId, fileId) { queueFile(userId, fileId); return true; }
  function notes(userId, subjectId) { workspace.listTopics(userId, subjectId); return loadState(userId, subjectId).notes; }
  function deleteNote(userId, subjectId, noteId) {
    workspace.listTopics(userId, subjectId);
    const state = loadState(userId, subjectId);
    const gone = state.notes.find(n => n.id === noteId);
    state.notes = state.notes.filter(n => n.id !== noteId);
    saveState(userId, subjectId, state); notesChanged(userId, subjectId, state, gone ? gone.docIds || [] : []);
    return state.notes;
  }
  function infoCenterPath(userId, subjectId, docId = null) {
    workspace.listTopics(userId, subjectId);
    const file = docId ? docFile(userId, subjectId, docId, 'md') : subjectMdPath(userId, subjectId);
    if (!fs.existsSync(file)) { const state = loadState(userId, subjectId); rebuildSubject(userId, subjectId, state); }
    return fs.existsSync(file) ? file : null;
  }

  // ───────── cleanup when files or subjects go away
  function filesRemoved(userId, subjectId, fileIds) {
    if (!fileIds.length) return;
    let state; try { state = loadState(userId, subjectId); } catch { return; }
    for (const fileId of fileIds) delete state.files[fileId];
    for (const doc of [...state.docs]) {
      const keep = doc.fileIds.filter(id => !fileIds.includes(id));
      if (keep.length === doc.fileIds.length) continue;
      if (!keep.length) {
        state.docs = state.docs.filter(d => d.id !== doc.id);
        for (const ext of ['json', 'md']) fs.rmSync(docFile(userId, subjectId, doc.id, ext), { force: true });
      } else {
        doc.fileIds = keep;
        const names = keep.map(id => { try { return workspace.topicFile(userId, id).name; } catch { return null; } }).filter(Boolean);
        doc.sources = doc.sources.filter(name => names.includes(name));
        if (!keep.includes(doc.latestFileId)) { doc.latestFileId = keep[keep.length - 1]; queueFile(userId, doc.latestFileId); }
      }
    }
    saveState(userId, subjectId, state);
    try { workspace.listTopics(userId, subjectId); rebuildSubject(userId, subjectId, state); } catch { /* subject gone */ }
  }
  function subjectRemoved(userId, subjectId) { memory.delete(memoryKey(userId, subjectId)); fs.rmSync(subjectDir(userId, subjectId), { recursive: true, force: true }); }

  // ───────── questions (Ask panel)
  function excerptBlock(hits) {
    return hits.map((hit, i) => `[${i + 1}] ${hit.docTitle} › ${hit.heading}${hit.page ? ` (${hit.fileName.toLowerCase().endsWith('.pptx') ? 'slide' : 'page'} ${hit.page})` : ''}\n${hit.text}`).join('\n\n');
  }
  function overviewHits(analysis, doc) {
    const hits = [{ docId: doc.id, docTitle: analysis.title, fileName: doc.sources[doc.sources.length - 1], number: '', heading: 'Main points and outline', page: null,
      text: [...analysis.mainPoints.map(p => `- ${p}`), '', ...analysis.sections.filter(s => s.number).map(s => `${s.number} ${s.title}${s.description ? `: ${s.description}` : ''}`)].join('\n') }];
    for (const s of analysis.sections.filter(s => s.level === 1).slice(0, 6)) hits.push({ docId: doc.id, docTitle: analysis.title, fileName: doc.sources[doc.sources.length - 1], number: s.number, heading: `${s.number} ${s.title}`, page: s.page, text: [s.description, ...s.keyPoints.map(p => `- ${p}`)].filter(Boolean).join('\n') });
    return hits;
  }
  /* "page 7", "slide 7": the sections on that page (or the section that page belongs to), from the open file first. */
  function pageHits(page, docs) {
    for (const d of docs) {
      if (!d.analysis) continue;
      const numbered = d.analysis.sections.filter(s => s.page);
      let on = numbered.filter(s => s.page === page);
      if (!on.length) { const before = numbered.filter(s => s.page < page); if (before.length) on = [before[before.length - 1]]; }
      if (!on.length) continue;
      const keys = new Set(on.map(s => `${s.number}|${s.title}`));
      const fileName = d.sources[d.sources.length - 1];
      const hits = d.analysis.chunks.filter(c => [...keys].some(k => k === `${c.number}|${c.heading.replace(/^\d+(\.\d+)*\s+/, '')}`))
        .slice(0, 8).map(c => ({ docId: d.id, docTitle: d.title, fileName, number: c.number, heading: c.heading, page: c.page, text: c.text }));
      if (hits.length) return hits;
    }
    return [];
  }
  function parseAnswer(text) {
    const body = String(text || '').replace(/\r/g, '').trim();
    const answer = ((body.match(/ANSWER:\s*([\s\S]*?)(?:\n\s*NOTES?:|$)/i) || [])[1] || '').trim();
    const notFound = /NOT_IN_FILE/.test(body) && answer.replace(/NOT_IN_FILE/g, '').trim().length < 40;
    if (notFound) return { notFound: true };
    const noteText = ((body.match(/\n\s*NOTES?:\s*([\s\S]*)$/i) || [])[1] || '');
    const notes = noteText.split('\n').map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(line => line.length > 8 && !/NOT_IN_FILE/.test(line)).slice(0, 3);
    // A model that ignores the format still gives a usable answer; the labels it cites stay checkable.
    return { notFound: false, answer: (answer || body.replace(/NOTES?:[\s\S]*$/i, '').trim()).slice(0, 6000), notes };
  }
  /* Keeps only citations to labels that exist; returns the sources actually cited (or all, if none were). */
  function sourcesOf(answer, hits) {
    const cited = new Set([...String(answer).matchAll(/\[(\d{1,2})\]/g)].map(m => Number(m[1])).filter(n => n >= 1 && n <= hits.length));
    const list = (cited.size ? [...cited].sort((a, b) => a - b) : hits.map((_, i) => i + 1)).map(n => ({ label: n, ...pick(hits[n - 1]) }));
    return { clean: String(answer).replace(/\[(\d{1,3})\]/g, (all, n) => (Number(n) >= 1 && Number(n) <= hits.length ? all : '')), list };
  }
  const pick = hit => ({ docId: hit.docId, fileId: hit.fileId || null, docTitle: hit.docTitle, fileName: hit.fileName, number: hit.number, heading: hit.heading, page: hit.page, text: String(hit.text || '').slice(0, 300) });

  // ───────── what the student teaches: facts (saved as notes "From you") and answer preferences (per account)
  const USER_DOC = 'your-notes';
  const MAX_PREFERENCES = 12;
  const STYLE_NOTE = {
    simpler: 'Style: explain it more simply: plain words, short sentences, one idea at a time. Do not add facts that are not in the excerpts.',
    deeper: 'Style: explain it in more detail: the steps, the how and the why, as far as the excerpts allow. Do not add facts that are not in the excerpts.'
  };
  const prefsFile = userId => path.join(base(userId), 'intel', 'preferences.json');
  function preferences(userId) { const list = readJson(prefsFile(userId), []); return Array.isArray(list) ? list.filter(p => p && typeof p.text === 'string') : []; }
  function preferenceBlock(list) { return list.length ? `The student's preferences for how you answer (style only, never a source of facts):\n${list.map(t => `- ${t}`).join('\n')}\n\n` : ''; }
  function deletePreference(userId, id) { const list = preferences(userId).filter(p => p.id !== id); write(prefsFile(userId), `${JSON.stringify(list, null, 2)}\n`); return list; }
  /* Saves what the student confirmed: a preference for every subject, or a fact as a note of this subject. */
  function saveLearned(userId, { subjectId, kind, text, docId = null }) {
    const plain = String(text || '').replace(/\s+/g, ' ').trim();
    if (plain.length < 3) throw new Error('There is nothing to save.');
    if (kind === 'preference') {
      const list = preferences(userId);
      if (!list.some(p => p.text.toLowerCase() === plain.toLowerCase())) list.push({ id: randomBytes(8).toString('hex'), text: plain.slice(0, 200), createdAt: new Date().toISOString() });
      const kept = list.slice(-MAX_PREFERENCES);
      write(prefsFile(userId), `${JSON.stringify(kept, null, 2)}\n`);
      return { kind, preferences: kept };
    }
    if (kind !== 'fact') throw new Error('Unknown kind of note.');
    workspace.listTopics(userId, subjectId);
    const state = loadState(userId, subjectId);
    const doc = docId && state.docs.find(d => d.id === docId);
    if (!state.notes.some(n => n.text.toLowerCase() === plain.toLowerCase())) {
      state.notes.unshift({ id: randomBytes(8).toString('hex'), text: plain.slice(0, 400), origin: 'user', sources: ['From you'], docIds: doc ? [doc.id] : [], numbers: [], createdAt: new Date().toISOString() });
      state.notes = state.notes.slice(0, MAX_NOTES);
      saveState(userId, subjectId, state); notesChanged(userId, subjectId, state, doc ? [doc.id] : []);
    }
    return { kind, notes: state.notes };
  }

  const asks = new Map(); // requestId → AbortController
  /* Conversation memory for follow-up questions, per account and subject, kept only while the app runs. The Ask panel
     sends the ids of the answered turns it still shows, so the assistant remembers exactly what the student sees. */
  const memory = new Map(); // `${userId}|${subjectId}` → [{ id, question, answer, hits, docId }]
  const MEMORY_TURNS = 10; const PROMPT_TURNS = 3;
  const memoryKey = (userId, subjectId) => `${userId}|${subjectId}`;
  function priorTurns(userId, subjectId, history) {
    const ids = new Set((Array.isArray(history) ? history : []).filter(id => typeof id === 'string' && ID.test(id)).slice(-50));
    return (memory.get(memoryKey(userId, subjectId)) || []).filter(turn => ids.has(turn.id)).slice(-PROMPT_TURNS);
  }
  function remember(userId, subjectId, turn) {
    const key = memoryKey(userId, subjectId);
    memory.set(key, [...(memory.get(key) || []).filter(t => t.id !== turn.id), turn].slice(-MEMORY_TURNS));
  }
  function conversationBlock(prior) {
    if (!prior.length) return '';
    const lines = prior.map((turn, i) => `Q${i + 1}: ${turn.question}\nA${i + 1}: ${turn.answer}`);
    return `Earlier in this conversation (context only: use it to understand what the new question refers to; every fact must still come from the excerpts below):\n${lines.join('\n')}\n\n`;
  }
  async function ask(userId, { subjectId, fileId = null, question, requestId, history = [] }, onEvent = () => {}) {
    workspace.listTopics(userId, subjectId);
    const q = String(question || '').trim();
    if (!q) throw new Error('Write a question first.');
    if (q.length > 2000) throw new Error('Questions can be up to 2,000 characters.');
    const stage = (stage, label) => onEvent({ type: 'stage', stage, label });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT);
    if (requestId) asks.set(requestId, controller);
    try {
      const state = loadState(userId, subjectId);
      const docs = state.docs.map(d => { const a = loadDoc(userId, subjectId, d.id); return a ? { id: d.id, title: a.title, sources: d.sources, chunks: a.chunks, analysis: a, doc: d } : null; }).filter(Boolean);
      const pendingFiles = Object.values(state.files).filter(f => f.status === 'pending').length;
      const current = fileId ? docs.find(d => d.doc.fileIds.includes(fileId)) || null : null;

      // The student teaches instead of asking: a fact or a preference. Nothing is saved until they confirm the chip.
      const teach = intel.learningIntent(q);
      if (teach) {
        const answer = teach.kind === 'preference'
          ? 'Got it. Save this as a preference and I will answer that way from now on, in every subject.'
          : 'Got it. This is not in your files, so I will only use it once you save it to your notes. Saved notes are marked “From you” in my answers.';
        return { status: 'answered', kind: 'learn', answer, suggestion: { kind: teach.kind, text: teach.text, docId: current ? current.id : null }, sources: [], notes: [], runs: 0, question: q, mode: 'learn' };
      }
      if (!docs.length) return { status: 'not-found', warning: pendingFiles ? 'The files are still being analyzed. Ask again in a moment.' : 'No analyzed files in this subject yet. Upload a file on the subject page first.', runs: 0 };
      // Facts the student saved ("From you") are searched like a file of their own, after the real files.
      const taught = state.notes.filter(n => n.origin === 'user');
      if (taught.length) docs.push({ id: USER_DOC, title: 'Your notes', sources: ['From you'], chunks: taught.map(n => ({ number: '', heading: 'From you', page: null, text: n.text })), analysis: null, doc: { id: USER_DOC, fileIds: [], latestFileId: null } });
      const files = docs.filter(d => d.id !== USER_DOC);
      const prefs = preferences(userId).map(p => p.text);
      const style = intel.answerStyle(q);

      // Casual message: a normal, short reply. No lookup, no sources, no notes.
      if (intel.isSmallTalk(q)) return await chat(userId, q, subjectId, files, stage, onEvent, controller.signal);

      // A follow-up ("what is it made of?", "and the second one?") is read together with the previous question.
      const prior = priorTurns(userId, subjectId, history);
      const previous = prior[prior.length - 1] || null;
      const followUp = Boolean(previous) && !intel.isOverviewQuestion(q) && intel.isFollowUp(q);
      const query = followUp ? `${q} ${previous.question}` : q;
      const prefer = current ? current.id : followUp ? previous.docId : null;

      // Agent instruction input → File Data and Information Center
      stage('search', followUp ? 'Searching with your previous question' : 'Searching the information center');
      let hits; let runs = 1;
      const pageRef = q.match(/\b(page|slide|pg|p)\.?\s*#?\s*(\d{1,4})\b/i);
      if (pageRef) hits = pageHits(Number(pageRef[2]), current ? [current, ...files.filter(d => d !== current)] : files);
      // "What is page 7 about": that page's own sections and pictures are the excerpts.
      const pageNo = pageRef && hits && hits.length ? Number(pageRef[2]) : null;
      const pageWord = pageRef && pageRef[1].toLowerCase() === 'slide' ? 'slide' : 'page';
      if (pageNo) { /* hits are the page */ }
      else if (intel.isOverviewQuestion(q)) hits = overviewHits((current || files[0]).analysis, (current || files[0]).doc);
      else {
        hits = intel.search(query, docs, { mode: 'strict', preferDocId: prefer }).hits;
        if (!hits.length && followUp) hits = intel.search(q, docs, { mode: 'strict', preferDocId: prefer }).hits;
        // "Explain that simpler", "give an example": nothing new to search for, so the previous excerpts are reused.
        if (!hits.length && followUp) hits = previous.hits.filter(hit => docs.some(d => d.id === hit.docId));
      }
      const fileOf = new Map(docs.map(d => [d.id, d.doc.latestFileId]));
      hits = hits.map(h => ({ ...h, fileId: fileOf.get(h.docId) || null }));
      const agent = await agents.ready(userId, 'assistant');
      let modelError = '';

      const attempt = async (list, label) => {
        if (!list.length) return { notFound: true };
        if (agent.missing || modelError) {   // no model, or it could not be reached: answer from the file's own sentences
          const picked = pageNo ? list.slice(0, 3).flatMap(hit => intel.sentences(hit.text).slice(0, 1).map(s => ({ s, hit }))) : intel.extractiveAnswer(query, list);
          if (!picked.length) return { notFound: true };
          const used = [...new Set(picked.map(p => p.hit))];
          return { answer: picked.map(p => `${p.s} [${used.indexOf(p.hit) + 1}]`).join(' '), notes: picked.slice(0, 2).map(p => p.s), hits: used, extractive: true };
        }
        stage('answer', label);
        const prompt = `${preferenceBlock(prefs)}${conversationBlock(prior)}Question: ${q}\n${style ? `${STYLE_NOTE[style]}\n` : ''}${current ? `The student is reading: ${current.title} (${current.sources[current.sources.length - 1]})\n` : ''}${pageNo ? `The question is about ${pageWord} ${pageNo}. The excerpts below are everything on that ${pageWord}: explain what it covers from them. Do not reply NOT_IN_FILE only because the excerpts do not repeat the number.\n` : ''}\nExcerpts from the File Data and Information Center:\n\n${excerptBlock(list)}\n\nAnswer in the exact format of the Learning grounded answers skill. If the excerpts do not contain the answer, reply with exactly NOT_IN_FILE.`;
        let raw = ''; let text;
        try { text = await ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt, signal: controller.signal, workflow: null, onDelta: piece => { raw += piece; onEvent({ type: 'delta', text: raw }); } }); }
        catch (error) {
          if (controller.signal.aborted || error.name === 'AbortError') throw error;
          modelError = `${agent.name} could not reach its AI model (${String(error.message || 'error').split('\n')[0].slice(0, 160)}).`;
          onEvent({ type: 'delta', text: '' });
          return attempt(list, label);
        }
        const parsed = parseAnswer(text);
        return parsed.notFound ? { notFound: true } : { ...parsed, hits: list };
      };

      let result = await attempt(hits, 'Writing the answer');
      if (result.notFound) {
        // 2nd run: broad lookup across every file of the subject
        runs = 2;
        stage('retry', 'Not found yet. Searching all files more broadly');
        const broad = intel.search(query, docs, { mode: 'broad', preferDocId: prefer }).hits.map(h => ({ ...h, fileId: fileOf.get(h.docId) || null }));
        const seen = new Set(hits.map(h => `${h.docId}|${h.heading}|${h.text.slice(0, 40)}`));
        const fresh = broad.filter(h => !seen.has(`${h.docId}|${h.heading}|${h.text.slice(0, 40)}`));
        result = fresh.length ? await attempt(broad, 'Checking the wider results') : { notFound: true };
      }
      if (result.notFound) {
        stage('warn', NOT_FOUND_MESSAGE);
        return { status: 'not-found', warning: NOT_FOUND_MESSAGE, runs, question: q };
      }
      const { clean, list } = sourcesOf(result.answer, result.hits);
      // Agent instruction output → notes panel
      const latest = loadState(userId, subjectId);
      const known = new Set(latest.notes.map(n => n.text.toLowerCase()));
      const added = [];
      for (const text of result.notes || []) {
        const plain = text.replace(/\s*\[(\d{1,2})\]/g, '').trim();
        if (!plain || known.has(plain.toLowerCase())) continue;
        const labels = [...text.matchAll(/\[(\d{1,2})\]/g)].map(m => Number(m[1])).filter(n => n >= 1 && n <= result.hits.length);
        const from = (labels.length ? labels : [1]).map(n => result.hits[n - 1]).filter(Boolean);
        const note = { id: randomBytes(8).toString('hex'), text: plain.slice(0, 400), question: q.slice(0, 300), origin: 'answer', sources: [...new Set(from.map(h => (h.number ? `${h.docTitle} ${h.number}` : h.docTitle)))], docIds: [...new Set(from.map(h => h.docId))], numbers: [...new Set(from.map(h => h.number).filter(Boolean))], createdAt: new Date().toISOString() };
        latest.notes.unshift(note); known.add(plain.toLowerCase()); added.push(note);
      }
      latest.notes = latest.notes.slice(0, MAX_NOTES);
      if (added.length) { saveState(userId, subjectId, latest); notesChanged(userId, subjectId, latest, added.flatMap(n => n.docIds)); }
      if (requestId) remember(userId, subjectId, { id: requestId, question: q.slice(0, 500), answer: clean.replace(/\s*\[\d{1,2}\]/g, '').trim().slice(0, 600), hits: result.hits, docId: (result.hits[0] || {}).docId || null });
      return {
        status: 'answered', answer: clean, sources: list, notes: added, runs, question: q, followUp,
        mode: result.extractive ? 'extractive' : 'agent', notice: result.extractive ? (agent.missing || modelError) : '', agent: result.extractive ? null : { name: agent.name, model: agent.model }
      };
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return { status: 'cancelled', warning: 'Stopped.' };
      throw error;
    } finally { clearTimeout(timer); if (requestId) asks.delete(requestId); }
  }
  async function chat(userId, q, subjectId, docs, stage, onEvent, signal) {
    const name = subjectName(userId, subjectId);
    const canned = /\b(thank|thx|ty)/i.test(q) ? 'You’re welcome! Ask me anything about your files.'
      : /\b(bye|goodbye|see)\b/i.test(q) ? 'Goodbye! Good luck with your studies.'
      : /\b(who|what are|what can|what do|help)\b/i.test(q) ? `I’m your study assistant for ${name}. Ask me about the files you uploaded here; I answer from them and save the key notes.`
      : `Hi! I’m here to help with ${name}. Ask me anything about your uploaded files.`;
    const reply = (answer, agent) => ({ status: 'answered', kind: 'chat', answer, sources: [], notes: [], runs: 0, question: q, mode: 'chat', agent });
    const agent = await agents.ready(userId, 'assistant');
    if (agent.missing) return reply(canned, null);
    stage('answer', 'Replying');
    const files = docs.map(d => d.title).slice(0, 8).join('; ') || 'none yet';
    const prompt = `${preferenceBlock(preferences(userId).map(p => p.text))}This is a casual message from the student, not a question about the files: "${q}"\nSubject: ${name}. Files: ${files}.\nReply naturally and briefly (1-2 friendly sentences), like a helpful study partner. You may offer to explain these files. Do not teach content here and do not mention excerpts.\nFormat: ANSWER: followed by your reply.`;
    let raw = '';
    try {
      const text = await ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt, signal, workflow: null, onDelta: piece => { raw += piece; onEvent({ type: 'delta', text: raw }); } });
      const parsed = parseAnswer(text);
      const answer = !parsed.notFound && parsed.answer ? parsed.answer.replace(/\[(\d{1,2})\]/g, '').trim() : canned;
      return reply((answer || canned).slice(0, 1200), { name: agent.name, model: agent.model });
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') throw error;
      return reply(canned, null);
    }
  }
  function cancelAsk(requestId) { const c = asks.get(requestId); if (c) c.abort(); return Boolean(c); }

  return { close: () => files.close(), saveLearned, preferences, deletePreference, queueFile, fileAnalysis, reanalyze, notes, deleteNote, infoCenterPath, filesRemoved, subjectRemoved, ask, cancelAsk, ensureAgents: userId => agents.ensure(userId), idle: () => !busy && !queue.length && !enriching && !enrichQueue.length, parseAnswer, NOT_FOUND_MESSAGE };
}

module.exports = { createLearningWorkflow };

'use strict';
/* Study sessions (LS-012, ADR-008, D8, D13): a timed session inside Learning that uses the account's one timer, keeps the
   student's own side notes, and records what was opened (`visited`) for the retake gate.

   - start: the account's single timer runs the session. If another timer is running the start is refused and nothing changes.
   - end: the timer is stopped once and saved as ONE focus entry with source 'learning', linked to the session.
   - quit or crash: an open session is closed at its LAST ACTIVITY time (no ghost hours); a timer that is not this session's
     is never touched.
   - side notes are the student's text only (D8), kept as Markdown files under learning-files/<account>/ and listed as
     learning_materials of kind side_note.
   No Electron import: main.js passes `handle`, `requireUser`, `workspace` and the data folder. */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeFileAtomic } = require('./safe-file');

const fail = message => { throw new Error(message); };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_NOTE = 20000;
const MATCH_MS = 5000; // a timer belongs to a session when it started within this many ms of the session

function pick(arg, keys, channel) {
  if (!isObj(arg)) fail(`${channel} needs one object argument.`);
  const out = {};
  for (const k of keys) if (arg[k] !== undefined) out[k] = arg[k];
  return out;
}
const elapsedOf = (timer, at) => timer.elapsed_seconds + (timer.segment_started_at ? Math.max(0, Math.floor((at - Date.parse(timer.segment_started_at)) / 1000)) : 0);
const ownsTimer = (timer, session) => Boolean(timer) && String(timer.description).startsWith('Study:') && Math.abs(Date.parse(timer.started_at) - Date.parse(session.startedAt)) <= MATCH_MS;

/* The folder of a session's note files, relative to the account's learning-files folder. */
const notesFolder = session => (session.journeyId ? path.join('journeys', session.journeyId) : path.join('side-notes', session.subjectId));

/* Close every open session at its last activity time. Called on quit and once at startup (a crash leaves sessions open). */
function closeOpenSessions({ workspace, now = () => Date.now() }) {
  const store = workspace.learningStore();
  let closed = 0;
  for (const open of store.listOpenSessions()) {
    try {
      const endedAt = open.updatedAt && Date.parse(open.updatedAt) <= now() ? open.updatedAt : new Date(now()).toISOString();
      const timer = workspace.activeTimer(open.userId);
      let entryId = null;
      if (ownsTimer(timer, open)) entryId = workspace.stopTimerAt(open.userId, { endedAt, source: 'learning' });
      store.endSession(open.userId, { sessionId: open.id, endedAt, focusEntryId: entryId });
      closed += 1;
    } catch { /* one broken session must not stop the others from closing */ }
  }
  return closed;
}

function registerStudySessionIpc({ handle, requireUser, workspace, dataDir, coach = null, sectionsFor = null, now = () => Date.now() }) {
  const store = () => workspace.learningStore();
  const on = (channel, keys, work) => handle(channel, arg => {
    const user = requireUser();
    return work(user.id, pick(arg, keys, channel));
  });
  const topicTitle = (u, subjectId, topicId) => {
    try { const t = workspace.listTopics(u, subjectId).rows.find(r => String(r.id) === String(topicId)); return t ? t.title : ''; } catch { return ''; }
  };

  on('study:start', ['subjectId', 'journeyId', 'topicId', 'kind'], (u, a) => {
    if (workspace.activeTimer(u)) fail('A timer is already running. Stop it first, then start the study session.');
    if (store().activeSession(u)) fail('A study session is already open. End it first.');
    const session = store().startSession(u, a); // checks the subject, journey and topic belong to this account
    try {
      const subject = workspace.getSubject(u, a.subjectId);
      const topic = a.topicId ? topicTitle(u, a.subjectId, a.topicId) : '';
      workspace.startTimer(u, `Study: ${topic || subject.name}`.slice(0, 180));
    } catch (error) { store().discardSession(u, { sessionId: session.id }); throw error; } // no orphan session
    if (a.journeyId && a.kind === 'main') {
      const journey = store().getJourney(u, { journeyId: a.journeyId });
      if (['material', 'pretest_setup', 'pretest', 'diagnostic', 'targeted_notes'].includes(journey.stage)) store().updateJourney(u, { journeyId: a.journeyId, stage: 'main_learning' });
    }
    return { session, elapsedSeconds: 0 };
  });

  on('study:active', [], u => {
    const session = store().activeSession(u);
    if (!session) return null;
    const timer = workspace.activeTimer(u);
    return { session, elapsedSeconds: ownsTimer(timer, session) ? elapsedOf(timer, now()) : null, topicTitle: session.topicId ? topicTitle(u, session.subjectId, session.topicId) : '' };
  });

  on('study:touch', ['sessionId'], (u, a) => { store().touchSession(u, a); return { ok: true }; });
  on('study:visit', ['sessionId', 'sections', 'materials'], (u, a) => store().markVisited(u, a).visited);

  on('study:sideNote', ['sessionId', 'text', 'page'], (u, a) => {
    if (typeof a.text !== 'string' || !a.text.trim()) fail('Write something in the note first.');
    if (a.text.length > MAX_NOTE) fail(`A note can have at most ${MAX_NOTE} characters.`);
    if (a.page != null && (!Number.isInteger(a.page) || a.page < 1)) fail('The page must be a whole number of 1 or more.');
    const session = store().getSession(u, { sessionId: a.sessionId });
    if (session.endedAt) fail('This study session has already ended.');
    const noteId = randomUUID(); const bodyFile = `${noteId}.md`;
    const folder = path.join(dataDir, 'learning-files', String(u), notesFolder(session));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, bodyFile);
    writeFileAtomic(file, a.text, { mode: 0o600 }); // the body is only the student's text (D8)
    try {
      const material = store().addMaterial(u, {
        subjectId: session.subjectId, journeyId: session.journeyId, topicId: session.topicId, sessionId: session.id, kind: 'side_note',
        title: a.text.trim().replace(/\s+/g, ' ').slice(0, 60), bodyFile, origin: 'manual', source: a.page ? [{ page: a.page }] : [],
      });
      store().touchSession(u, { sessionId: session.id });
      return { ...material, text: a.text };
    } catch (error) { try { fs.unlinkSync(file); } catch { /* nothing to remove */ } throw error; }
  });

  on('study:notes', ['sessionId'], (u, a) => {
    const session = store().getSession(u, { sessionId: a.sessionId });
    const read = m => { try { return fs.readFileSync(path.join(dataDir, 'learning-files', String(u), notesFolder(session), m.bodyFile), 'utf8'); } catch { return ''; } /* a missing file reads as empty */ };
    const ai = store().sessionMaterials(u, { sessionId: session.id, kind: 'side_note_ai' });
    return store().sessionMaterials(u, { sessionId: session.id, kind: 'side_note' }).map(m => ({ ...m, text: read(m), aiHelp: ai.filter(x => x.parentMaterialId === m.id).map(x => ({ id: x.id, text: read(x), provenance: x.provenance, label: 'AI · suggestion' })) }));
  });

  /* "Check my note" (D8): the AI reads the note and its pages and answers with suggestions. They are stored as their OWN record
     (a side_note_ai linked to the note, with provenance); the student's note is never touched. */
  on('study:checkNote', ['materialId'], async (u, a) => {
    if (!coach || !sectionsFor) fail('AI is not available in this build.');
    const note = store().getMaterial(u, { materialId: a.materialId });
    if (note.kind !== 'side_note') fail('Only a side note can be checked.');
    const session = note.sessionId ? store().getSession(u, { sessionId: note.sessionId }) : null;
    const folder = path.join(dataDir, 'learning-files', String(u), session ? notesFolder(session) : (note.journeyId ? path.join('journeys', note.journeyId) : path.join('side-notes', note.subjectId)));
    let text = ''; try { text = fs.readFileSync(path.join(folder, note.bodyFile), 'utf8'); } catch { fail('The note could not be read.'); }
    const help = await coach.checkNote(u, { noteText: text, sections: sectionsFor(u, note.subjectId, note.topicId).sections });
    const bodyFile = `${randomUUID()}.md`; const file = path.join(folder, bodyFile);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, help.text, { mode: 0o600 });
    try {
      const made = store().addMaterial(u, { subjectId: note.subjectId, journeyId: note.journeyId, topicId: note.topicId, sessionId: note.sessionId, kind: 'side_note_ai', parentMaterialId: note.id, title: 'AI · suggestion', bodyFile, origin: 'generated', provenance: help.provenance });
      return { ...made, text: help.text, label: 'AI · suggestion' };
    } catch (error) { try { fs.unlinkSync(file); } catch { /* nothing to remove */ } throw error; }
  });
  on('study:end', ['sessionId', 'summary'], (u, a) => {
    const session = store().getSession(u, { sessionId: a.sessionId });
    if (session.endedAt) fail('This study session has already ended.');
    const timer = workspace.activeTimer(u);
    const at = now();
    let entryId = null; let seconds = null; let message = '';
    if (ownsTimer(timer, session)) {
      seconds = elapsedOf(timer, at);
      entryId = workspace.stopTimerAt(u, { endedAt: new Date(at).toISOString(), source: 'learning' });
    } else message = 'The timer was already stopped, so this session was saved without a time entry.';
    const endedAt = entryId || ownsTimer(timer, session) ? new Date(at).toISOString() : session.updatedAt;
    const ended = store().endSession(u, { sessionId: session.id, summary: a.summary, endedAt, focusEntryId: entryId });
    const notes = store().sessionMaterials(u, { sessionId: session.id, kind: 'side_note' }).length;
    return { session: ended, durationSeconds: seconds, topics: session.topicId ? [topicTitle(u, session.subjectId, session.topicId)].filter(Boolean) : [], notes, message };
  });
}

module.exports = { registerStudySessionIpc, closeOpenSessions };

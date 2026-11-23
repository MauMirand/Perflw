'use strict';
/* Chat session storage: per-conversation execution settings, message metadata, and user-approved memory.
   Shares the workspace database; every query is filtered by user_id.

   Separation kept here on purpose:
     • chat_messages            — the conversation itself (temporary context of one session)
     • chat_sessions.settings   — how that one session executes (model, workflow, skills, instructions, preferences)
     • chat_memory              — notes the person explicitly saved; the only thing carried across sessions
     • chat_defaults            — settings the person explicitly chose as the starting point for new sessions
   Nothing moves from a conversation into memory or defaults unless the person asks for it. */
const { randomUUID } = require('node:crypto');

const fail = message => { throw new Error(message); };
const now = () => new Date().toISOString();
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;
const LIMITS = Object.freeze({ user: 8000, assistant: 400000, instructions: 8000, context: 20000, skills: 12, memory: 100, memoryText: 600, meta: 600000 });

const PREFS = Object.freeze({
  orchestration: ['auto', 'direct'],   // auto: plan multi-step work when the request is complex; direct: always one reply
  skillDiscovery: [true, false],       // load relevant library skills automatically (off: only suggest them)
  delegation: [false, true],           // let the session hand sub-tasks to specialised agents
  verify: [true, false],               // check planned results against the request before reporting
  visuals: [true, false]               // allow charts, diagrams and sandboxed visual blocks
});
function defaultSettings() {
  return { provider: null, agentId: null, workflowId: null, skills: [], instructions: '', context: '', prefs: Object.fromEntries(Object.entries(PREFS).map(([key, values]) => [key, values[0]])) };
}

/* Structural validation only. Whether the referenced connection, agent, workflow or skill still exists is
   checked when a turn runs, so a deleted resource gives a clear message instead of a broken session. */
function cleanSettings(raw, base = defaultSettings()) {
  const out = { ...base, prefs: { ...base.prefs }, skills: [...base.skills] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (raw.provider !== undefined) {
    if (raw.provider === null) out.provider = null;
    else {
      const { connectionId, model } = raw.provider || {};
      if (typeof connectionId !== 'string' || !ID_RE.test(connectionId)) fail('Choose a provider.');
      if (typeof model !== 'string' || !MODEL_RE.test(model.trim())) fail('Choose or type a model name.');
      out.provider = { connectionId, model: model.trim() };
    }
  }
  for (const key of ['agentId', 'workflowId']) {
    if (raw[key] === undefined) continue;
    if (raw[key] !== null && (typeof raw[key] !== 'string' || !ID_RE.test(raw[key]))) fail(key === 'agentId' ? 'Invalid agent.' : 'Invalid workflow.');
    out[key] = raw[key];
  }
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills) || raw.skills.some(id => typeof id !== 'string' || !SKILL_RE.test(id))) fail('Invalid skills.');
    const unique = [...new Set(raw.skills)];
    if (unique.length > LIMITS.skills) fail(`A conversation can have up to ${LIMITS.skills} active skills.`);
    out.skills = unique;
  }
  for (const [key, max, label] of [['instructions', LIMITS.instructions, 'Session instructions'], ['context', LIMITS.context, 'Session context']]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].length > max) fail(`${label} can be up to ${max.toLocaleString('en-US')} characters.`);
    out[key] = raw[key];
  }
  if (raw.prefs !== undefined) {
    if (!raw.prefs || typeof raw.prefs !== 'object') fail('Invalid preferences.');
    for (const [key, value] of Object.entries(raw.prefs)) {
      if (!Object.hasOwn(PREFS, key) || !PREFS[key].includes(value)) fail('Invalid preference.');
      out.prefs[key] = value;
    }
  }
  return out;
}
/* Stored JSON is never trusted blindly: a damaged value falls back to defaults field by field. */
function readSettings(json) {
  let raw = null; try { raw = JSON.parse(json || '{}'); } catch { raw = null; }
  const out = defaultSettings();
  if (!raw || typeof raw !== 'object') return out;
  for (const key of ['provider', 'agentId', 'workflowId', 'skills', 'instructions', 'context']) {
    try { Object.assign(out, { [key]: cleanSettings({ [key]: raw[key] })[key] }); } catch { /* keep default */ }
  }
  if (raw.prefs && typeof raw.prefs === 'object') for (const key of Object.keys(PREFS)) if (PREFS[key].includes(raw.prefs[key])) out.prefs[key] = raw.prefs[key];
  return out;
}

/* Schema for session settings, message metadata and memory. Called by workspace migration 1 (src/workspace.js). */
function createSessionSchema(db) {
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  if (!columns('chat_sessions').has('settings_json')) db.exec("ALTER TABLE chat_sessions ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns('chat_messages').has('meta_json')) db.exec('ALTER TABLE chat_messages ADD COLUMN meta_json TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS chat_memory (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_memory_user ON chat_memory(user_id, created_at);
    CREATE TABLE IF NOT EXISTS chat_defaults (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
}

function createSessionStore(db) {
  const session = (userId, chatId, { writable = false } = {}) => {
    const row = db.prepare('SELECT * FROM chat_sessions WHERE id=? AND user_id=?').get(chatId, userId);
    if (!row || (writable && row.archived_at)) fail('Conversation not found.');
    return row;
  };
  const publicMessage = row => {
    let meta = null; if (row.meta_json) { try { meta = JSON.parse(row.meta_json); } catch { meta = null; } }
    return { id: row.id, role: row.role, content: row.content, createdAt: row.created_at, meta };
  };

  function getChat(userId, chatId) {
    const row = session(userId, chatId);
    return { id: row.id, title: row.title, archived: Boolean(row.archived_at), createdAt: row.created_at, updatedAt: row.updated_at, settings: readSettings(row.settings_json) };
  }
  function getChatSettings(userId, chatId) { return readSettings(session(userId, chatId).settings_json); }
  function updateChatSettings(userId, chatId, patch) {
    const row = session(userId, chatId, { writable: true });
    const next = cleanSettings(patch, readSettings(row.settings_json));
    db.prepare('UPDATE chat_sessions SET settings_json=? WHERE id=? AND user_id=?').run(JSON.stringify(next), chatId, userId);
    return next;
  }
  /* New conversations start from the defaults the person saved, never from whichever session was used last. */
  function getChatDefaults(userId) {
    const row = db.prepare('SELECT settings_json FROM chat_defaults WHERE user_id=?').get(userId);
    return row ? readSettings(row.settings_json) : null;
  }
  function setChatDefaults(userId, settings) {
    if (settings === null) { db.prepare('DELETE FROM chat_defaults WHERE user_id=?').run(userId); return null; }
    // Session-specific context and the attached workflow describe one conversation, so they are not copied.
    const clean = { ...cleanSettings(settings), context: '', workflowId: null };
    db.prepare('INSERT INTO chat_defaults (user_id,settings_json,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at').run(userId, JSON.stringify(clean), now());
    return clean;
  }
  function applyChatDefaults(userId, chatId) {
    const defaults = getChatDefaults(userId);
    if (defaults) db.prepare('UPDATE chat_sessions SET settings_json=? WHERE id=? AND user_id=?').run(JSON.stringify(defaults), chatId, userId);
    return defaults || defaultSettings();
  }

  function listChatMessages(userId, chatId) {
    session(userId, chatId);
    return db.prepare('SELECT id,role,content,created_at,meta_json FROM chat_messages WHERE user_id=? AND chat_id=? ORDER BY created_at, rowid').all(userId, chatId).map(publicMessage);
  }
  function addChatMessage(userId, chatId, content, role = 'user', meta = null) {
    session(userId, chatId, { writable: true });
    if (!['user', 'assistant', 'system'].includes(role)) fail('Invalid message role.');
    const max = role === 'user' ? LIMITS.user : LIMITS.assistant;
    if (typeof content !== 'string' || !content.trim()) fail('Message is required.');
    if (content.trim().length > max) fail(`Message must be ${max.toLocaleString('en-US')} characters or fewer.`);
    let metaJson = null;
    if (meta && typeof meta === 'object') { metaJson = JSON.stringify(meta); if (metaJson.length > LIMITS.meta) metaJson = JSON.stringify({ note: 'Execution details were too large to keep.' }); }
    const messageId = randomUUID(); const timestamp = now();
    db.prepare('INSERT INTO chat_messages (id,user_id,chat_id,role,content,created_at,meta_json) VALUES (?,?,?,?,?,?,?)').run(messageId, userId, chatId, role, content.trim(), timestamp, metaJson);
    db.prepare('UPDATE chat_sessions SET updated_at=? WHERE id=? AND user_id=?').run(timestamp, chatId, userId);
    return publicMessage({ id: messageId, role, content: content.trim(), created_at: timestamp, meta_json: metaJson });
  }
  function deleteChatMessages(userId, chatId, messageIds) {
    session(userId, chatId, { writable: true });
    const remove = db.prepare('DELETE FROM chat_messages WHERE id=? AND chat_id=? AND user_id=?');
    for (const messageId of messageIds) remove.run(messageId, chatId, userId);
  }

  function listMemory(userId) {
    return db.prepare('SELECT id,text,created_at FROM chat_memory WHERE user_id=? ORDER BY created_at, rowid').all(userId).map(row => ({ id: row.id, text: row.text, createdAt: row.created_at }));
  }
  function addMemory(userId, value) {
    if (typeof value !== 'string' || !value.trim()) fail('Write what should be remembered.');
    if (value.trim().length > LIMITS.memoryText) fail(`A memory note can be up to ${LIMITS.memoryText} characters.`);
    if (db.prepare('SELECT COUNT(*) AS total FROM chat_memory WHERE user_id=?').get(userId).total >= LIMITS.memory) fail(`You can keep up to ${LIMITS.memory} memory notes. Remove one first.`);
    const memoryId = randomUUID(); const timestamp = now();
    db.prepare('INSERT INTO chat_memory (id,user_id,text,created_at) VALUES (?,?,?,?)').run(memoryId, userId, value.trim(), timestamp);
    return { id: memoryId, text: value.trim(), createdAt: timestamp };
  }
  function deleteMemory(userId, memoryId) {
    if (!db.prepare('DELETE FROM chat_memory WHERE id=? AND user_id=?').run(memoryId, userId).changes) fail('Memory note not found.');
  }

  return { getChat, getChatSettings, updateChatSettings, getChatDefaults, setChatDefaults, applyChatDefaults, listChatMessages, addChatMessage, deleteChatMessages, listMemory, addMemory, deleteMemory };
}

module.exports = { createSessionStore, createSessionSchema, cleanSettings, defaultSettings, CHAT_PREFS: PREFS, CHAT_LIMITS: LIMITS };

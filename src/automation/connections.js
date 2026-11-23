'use strict';
/* Provider connections ("Add LLM API"), account-scoped, in the workspace database.
   API keys are encrypted with the injected `secrets` codec (Electron safeStorage → Windows DPAPI /
   macOS Keychain / libsecret) and stored only as ciphertext. They are never returned by list(),
   never written to agent or skill files, and never included in exports.
   The local Ollama connection is built in (id 'ollama-local') so existing agents keep working unchanged. */
const { randomUUID } = require('node:crypto');
const { PROVIDER_TYPES } = require('./providers');

const OLLAMA_ID = 'ollama-local';
const fail = message => { throw new Error(message); };
const now = () => new Date().toISOString();

/* Schema for provider connections. Called by workspace migration 1 (src/workspace.js), not by the store. */
function createConnectionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', context_window INTEGER,
      supports_tools INTEGER NOT NULL DEFAULT 0, secret BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_connections_user ON provider_connections(user_id, label);`);
}

function createConnectionStore(db, secrets) {

  const builtIn = () => ({ id: OLLAMA_ID, type: 'ollama', label: PROVIDER_TYPES.ollama.label, baseUrl: PROVIDER_TYPES.ollama.fixedBase, model: '', contextWindow: null, supportsTools: false, hasKey: false, builtIn: true });
  const publicRow = row => ({ id: row.id, type: row.type, label: row.label, baseUrl: row.base_url || PROVIDER_TYPES[row.type]?.fixedBase || '', model: row.model, contextWindow: row.context_window || null, supportsTools: Boolean(row.supports_tools), hasKey: Boolean(row.secret && row.secret.length), builtIn: false, updatedAt: row.updated_at });

  function list(userId) {
    return [builtIn(), ...db.prepare('SELECT * FROM provider_connections WHERE user_id=? ORDER BY label COLLATE NOCASE').all(userId).map(publicRow)];
  }
  function get(userId, id) {
    if (id === OLLAMA_ID) return builtIn();
    const row = db.prepare('SELECT * FROM provider_connections WHERE id=? AND user_id=?').get(id, userId);
    return row ? publicRow(row) : null;
  }
  /* Main-process only: the connection plus its decrypted key. */
  function resolve(userId, id) {
    if (id === OLLAMA_ID) return { connection: builtIn(), apiKey: null };
    const row = db.prepare('SELECT * FROM provider_connections WHERE id=? AND user_id=?').get(id, userId);
    if (!row) return null;
    let apiKey = null;
    if (row.secret && row.secret.length) {
      try { apiKey = secrets.decrypt(Buffer.from(row.secret)); }
      catch { fail(`The saved API key for “${row.label}” could not be unlocked on this computer. Enter it again in the provider settings.`); }
    }
    return { connection: publicRow(row), apiKey };
  }
  function validBaseUrl(value) {
    let url;
    try { url = new URL(value); } catch { fail('Enter a valid base URL, for example http://localhost:1234/v1.'); }
    if (!/^https?:$/.test(url.protocol)) fail('The base URL must start with http:// or https://.');
    if (url.username || url.password) fail('Do not put credentials in the base URL. Use the API key field.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('Use https:// for remote endpoints. Plain http:// is allowed only for this computer (localhost).');
    return url.href.replace(/\/+$/, '');
  }
  /* changes.apiKey: undefined keeps the saved key, '' removes it, a string replaces it. */
  function save(userId, changes = {}) {
    if (!changes || typeof changes !== 'object') fail('Invalid provider.');
    if (changes.id === OLLAMA_ID) fail('The local Ollama connection is built in and needs no settings.');
    const existing = changes.id ? db.prepare('SELECT * FROM provider_connections WHERE id=? AND user_id=?').get(changes.id, userId) : null;
    if (changes.id && !existing) fail('Provider not found.');
    const type = existing ? existing.type : changes.type;
    if (!Object.hasOwn(PROVIDER_TYPES, type) || type === 'ollama') fail('Choose a provider type.');
    const label = typeof changes.label === 'string' && changes.label.trim() ? changes.label.trim().slice(0, 60) : (existing ? existing.label : PROVIDER_TYPES[type].label);
    const baseUrl = type === 'openai-compatible' ? validBaseUrl(changes.baseUrl ?? existing?.base_url ?? '') : '';
    const model = changes.model === undefined ? (existing?.model || '') : String(changes.model || '').trim();
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/.test(model)) fail('The model name contains characters that are not allowed.');
    const rawWindow = changes.contextWindow === undefined ? existing?.context_window : changes.contextWindow;
    const contextWindow = rawWindow === null || rawWindow === '' || rawWindow === undefined ? null : Math.round(Number(rawWindow));
    if (contextWindow !== null && (!Number.isFinite(contextWindow) || contextWindow < 512 || contextWindow > 10000000)) fail('Context window must be between 512 and 10,000,000 tokens.');
    const supportsTools = changes.supportsTools === undefined ? Boolean(existing?.supports_tools) : Boolean(changes.supportsTools);
    let secret = existing?.secret ?? null;
    if (typeof changes.apiKey === 'string') {
      const key = changes.apiKey.trim();
      if (!key) secret = null;
      else {
        if (key.length > 400 || /\s/.test(key)) fail('That API key does not look valid.');
        if (!secrets.available()) fail('Secure credential storage is not available on this computer, so the API key cannot be saved.');
        secret = secrets.encrypt(key);
      }
    }
    if (PROVIDER_TYPES[type].needsKey && !secret) fail(`${PROVIDER_TYPES[type].label} needs an API key.`);
    const timestamp = now();
    if (existing) {
      db.prepare('UPDATE provider_connections SET label=?,base_url=?,model=?,context_window=?,supports_tools=?,secret=?,updated_at=? WHERE id=? AND user_id=?')
        .run(label, baseUrl, model, contextWindow, supportsTools ? 1 : 0, secret, timestamp, existing.id, userId);
      return get(userId, existing.id);
    }
    if (db.prepare('SELECT COUNT(*) AS total FROM provider_connections WHERE user_id=?').get(userId).total >= 50) fail('You can keep up to 50 provider connections.');
    const id = randomUUID();
    db.prepare('INSERT INTO provider_connections (id,user_id,type,label,base_url,model,context_window,supports_tools,secret,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, type, label, baseUrl, model, contextWindow, supportsTools ? 1 : 0, secret, timestamp, timestamp);
    return get(userId, id);
  }
  function remove(userId, id) {
    if (id === OLLAMA_ID) fail('The local Ollama connection is built in and cannot be removed.');
    const result = db.prepare('DELETE FROM provider_connections WHERE id=? AND user_id=?').run(id, userId);
    if (!result.changes) fail('Provider not found.');
  }
  return { list, get, resolve, save, remove };
}

module.exports = { createConnectionStore, createConnectionSchema, OLLAMA_ID };

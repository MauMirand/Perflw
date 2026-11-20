'use strict';
/* Editable file packages for agents and skills, stored per account under
   <userData>/agent-ecosystem/<userId>/{agents,skills}/<id>/.

   Agents keep their registry row (id, name, description) in the existing `agents` table; the package
   holds what the runtime loads: identity.md, instructions.md, capabilities.md, context.md,
   configuration.json and resources/. Existing agents are migrated into a package the first time they are
   listed (their saved instructions and Ollama model are carried over; the database row is left in place).

   Skills are self-contained: SKILL.md (front matter + instructions), references/, scripts/, resources/.

   Safety: every path is validated against an allow-list and resolved inside its package; overwritten and
   deleted files are kept in .history/ (last 10 versions); deleted packages move to .trash/ instead of
   being erased. Nothing here ever stores credentials. */
const fs = require('node:fs');
const path = require('node:path');

const fail = message => { throw new Error(message); };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}';
const TEXT_EXT = /\.(md|markdown|txt|json|csv|tsv|yaml|yml|xml|html|htm)$/i;
const SCRIPT_EXT = /\.(js|mjs|cjs|py)$/i;
const LIMITS = Object.freeze({ file: 512 * 1024, files: 200, total: 20 * 1024 * 1024, history: 10 });

const PERMISSIONS = Object.freeze({
  fileRead: { label: 'Read files', help: 'Read text files inside the folders listed in this agent’s file access.', risk: 'medium' },
  documents: { label: 'Process documents', help: 'Extract text from documents (.docx, .html, .csv, .json) inside allowed folders.', risk: 'medium' },
  fileWrite: { label: 'Write files', help: 'Create or overwrite files inside allowed folders. Every write asks for your approval.', risk: 'high' },
  web: { label: 'Web access', help: 'Fetch public web pages (GET only, no local network addresses).', risk: 'medium' },
  externalApi: { label: 'External API calls', help: 'Send HTTPS requests to external APIs. Anything other than GET asks for your approval.', risk: 'high' },
  workflow: { label: 'Workflow interaction', help: 'Read the original message and outputs of earlier steps in the same workflow run.', risk: 'low' },
  codeExecution: { label: 'Code execution', help: 'Required, together with skill scripts, before any script can run.', risk: 'high' },
  skillScripts: { label: 'Run skill scripts', help: 'Run scripts packaged in assigned skills. Every run asks for your approval.', risk: 'high' }
});

const AGENT_FILES = Object.freeze({
  'identity.md': 'Who the agent is: its role, perspective and tone.',
  'instructions.md': 'How the agent works: rules, steps and output format.',
  'capabilities.md': 'What the agent is good at. Tool access is controlled by permissions, not by this text.',
  'context.md': 'Standing background knowledge sent with every request (keep it short).',
  'configuration.json': 'Provider, model, skills, permissions and context budget.'
});

function defaultConfig(model = '') {
  return {
    schemaVersion: 1,
    provider: { connectionId: 'ollama-local', model },
    skills: [],
    delegates: [],
    permissions: Object.fromEntries(Object.keys(PERMISSIONS).map(key => [key, false])),
    fileAccess: { folders: [] },
    context: { maxContextTokens: null, responseReserveTokens: null, maxSkills: 3 }
  };
}

/* Validates configuration.json. Returns { config, problems }: config is always usable (safe defaults fill
   gaps); problems lists what the person should fix. Unknown permission names are reported, never granted. */
function validateConfig(raw) {
  const problems = []; const problem = message => problems.push({ file: 'configuration.json', message });
  const config = defaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problem('The file must contain a JSON object.'); return { config, problems }; }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) problem(`Unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}; expected 1.`);
  const provider = raw.provider && typeof raw.provider === 'object' ? raw.provider : {};
  if (typeof provider.connectionId === 'string' && ID_RE.test(provider.connectionId)) config.provider.connectionId = provider.connectionId;
  else problem('provider.connectionId is missing or invalid. Choose a provider for this agent.');
  if (typeof provider.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/.test(provider.model)) config.provider.model = provider.model;
  else problem('provider.model is missing or invalid. Choose a model for this agent.');
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) problem('skills must be a list of skill ids.');
    else config.skills = [...new Set(raw.skills.filter(id => {
      const ok = typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
      if (!ok) problem(`Ignored invalid skill id ${JSON.stringify(id)}.`);
      return ok;
    }))].slice(0, 50);
  }
  // Agents this agent may hand a sub-task to (ask_agent). Empty = no delegation.
  if (raw.delegates !== undefined) {
    if (!Array.isArray(raw.delegates)) problem('delegates must be a list of agent ids.');
    else config.delegates = [...new Set(raw.delegates.filter(id => {
      const ok = typeof id === 'string' && ID_RE.test(id);
      if (!ok) problem(`Ignored invalid delegate id ${JSON.stringify(id)}.`);
      return ok;
    }))].slice(0, 10);
  }
  if (raw.permissions !== undefined) {
    if (!raw.permissions || typeof raw.permissions !== 'object') problem('permissions must be an object of true/false values.');
    else for (const [key, value] of Object.entries(raw.permissions)) {
      if (!Object.hasOwn(PERMISSIONS, key)) { problem(`Unknown permission “${key}” was ignored.`); continue; }
      if (typeof value !== 'boolean') { problem(`permissions.${key} must be true or false; treated as false.`); continue; }
      config.permissions[key] = value;
    }
  }
  const folders = raw.fileAccess?.folders;
  if (folders !== undefined) {
    if (!Array.isArray(folders)) problem('fileAccess.folders must be a list of absolute folder paths.');
    else config.fileAccess.folders = folders.filter(folder => {
      const ok = typeof folder === 'string' && path.isAbsolute(folder) && folder.length < 400;
      if (!ok) problem(`Ignored folder ${JSON.stringify(folder)}: use an absolute path.`);
      return ok;
    }).map(folder => path.resolve(folder)).slice(0, 20);
  }
  const context = raw.context && typeof raw.context === 'object' ? raw.context : {};
  const intIn = (value, min, max, key, fallback) => {
    if (value === undefined || value === null) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) { problem(`context.${key} must be a whole number from ${min} to ${max}.`); return fallback; }
    return number;
  };
  config.context.maxContextTokens = intIn(context.maxContextTokens, 1024, 10000000, 'maxContextTokens', null);
  config.context.responseReserveTokens = intIn(context.responseReserveTokens, 128, 200000, 'responseReserveTokens', null); // null = provider default
  config.context.maxSkills = intIn(context.maxSkills, 0, 10, 'maxSkills', 3);
  return { config, problems };
}

// ───────────────────────── shared file helpers
function within(dir, target) { const rel = path.relative(dir, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }
function resolveIn(dir, rel) {
  if (typeof rel !== 'string' || rel.includes('\\') || !new RegExp(`^${SEGMENT}(/${SEGMENT}){0,2}$`).test(rel) || rel.split('/').some(part => part === '.' || part === '..' || part.startsWith('.')))
    fail('That file name is not allowed. Use letters, numbers, spaces, dots, dashes or underscores.');
  const full = path.resolve(dir, rel);
  if (!within(dir, full)) fail('That file is outside the package.');
  return full;
}
function readText(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) fail('Not a file.');
  if (stat.size > LIMITS.file) fail('This file is larger than 512 KB and cannot be opened here.');
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (text.includes('\u0000')) fail('This is not a text file.');
  return text;
}
function checkText(content) {
  if (typeof content !== 'string') fail('File content must be text.');
  if (Buffer.byteLength(content) > LIMITS.file) fail('Files can be up to 512 KB.');
  if (content.includes('\u0000')) fail('File content must be text.');
}
function keepHistory(dir, rel) {
  const file = path.join(dir, rel);
  if (!fs.existsSync(file)) return;
  const history = path.join(dir, '.history');
  fs.mkdirSync(history, { recursive: true });
  const stem = rel.replace(/\//g, '__');
  fs.copyFileSync(file, path.join(history, `${stem}.${Date.now()}`));
  const versions = fs.readdirSync(history).filter(name => name.startsWith(`${stem}.`)).sort();
  for (const old of versions.slice(0, Math.max(0, versions.length - LIMITS.history))) fs.rmSync(path.join(history, old), { force: true });
}
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
}
/* File tree (no dot-folders): files first, then folders, each alphabetical. */
function tree(dir) {
  const out = [];
  const walk = (current, prefix, depth) => {
    if (depth > 3) return;
    const entries = fs.readdirSync(current, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.'))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? 1 : -1));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { out.push({ path: rel, kind: 'dir' }); walk(path.join(current, entry.name), rel, depth + 1); }
      else if (entry.isFile()) out.push({ path: rel, kind: 'file', size: fs.statSync(path.join(current, entry.name)).size });
    }
  };
  if (fs.existsSync(dir)) walk(dir, '', 0);
  return out;
}
/* Copies a package folder with limits; skips dot-folders, links and oversized files. */
function copyPackage(source, target, { allow = () => true } = {}) {
  let count = 0; let total = 0; const skipped = [];
  const walk = (from, to, rel, depth) => {
    if (depth > 3) return;
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childFrom = path.join(from, entry.name); const childTo = path.join(to, entry.name);
      if (entry.isSymbolicLink()) { skipped.push(childRel); continue; }
      if (entry.isDirectory()) { walk(childFrom, childTo, childRel, depth + 1); continue; }
      if (!entry.isFile() || !allow(childRel)) { skipped.push(childRel); continue; }
      const size = fs.statSync(childFrom).size;
      if (size > LIMITS.file) { skipped.push(childRel); continue; }
      if (++count > LIMITS.files || (total += size) > LIMITS.total) fail('That package is too large (up to 200 files and 20 MB).');
      fs.copyFileSync(childFrom, childTo);
    }
  };
  walk(source, target, '', 0);
  return { files: count, skipped };
}
function trashDir(root, dir, name) {
  if (!fs.existsSync(dir)) return;
  const trash = path.join(root, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(dir, path.join(trash, `${name}-${Date.now()}`));
}

// ───────────────────────── agents
const agentAllowed = rel => Object.hasOwn(AGENT_FILES, rel) || (/^resources\//.test(rel) && TEXT_EXT.test(rel));

function createAgentPackages(baseDir) {
  const userRoot = userId => { if (!ID_RE.test(userId)) fail('Invalid account.'); return path.join(baseDir, userId, 'agents'); };
  const dirFor = (userId, agentId) => { if (!ID_RE.test(agentId)) fail('Agent not found.'); return path.join(userRoot(userId), agentId); };

  function scaffold(dir, { identity = '', instructions = '', capabilities = '', context = '', config = defaultConfig() } = {}) {
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
    const files = {
      'identity.md': identity, 'instructions.md': instructions, 'capabilities.md': capabilities, 'context.md': context,
      'configuration.json': `${JSON.stringify(config, null, 2)}\n`
    };
    for (const [name, content] of Object.entries(files)) if (!fs.existsSync(path.join(dir, name))) writeAtomic(path.join(dir, name), content);
  }
  /* Creates the package for a registry row if it does not exist yet (migration of pre-package agents). */
  function ensure(userId, row) {
    const dir = dirFor(userId, row.id);
    if (fs.existsSync(path.join(dir, 'configuration.json'))) return false;
    scaffold(dir, { instructions: row.instructions || '', config: defaultConfig(row.model || '') });
    return true;
  }
  function create(userId, agentId, init) { const dir = dirFor(userId, agentId); if (fs.existsSync(dir)) fail('Agent package already exists.'); scaffold(dir, init); }
  function readConfig(dir) {
    const file = path.join(dir, 'configuration.json');
    if (!fs.existsSync(file)) return { ...validateConfig(null), problems: [{ file: 'configuration.json', message: 'configuration.json is missing.' }] };
    let raw;
    try { raw = JSON.parse(readText(file)); }
    catch (error) { return { config: defaultConfig(), problems: [{ file: 'configuration.json', message: `configuration.json is not valid JSON: ${error.message}` }] }; }
    return validateConfig(raw);
  }
  function read(userId, agentId) {
    const dir = dirFor(userId, agentId);
    if (!fs.existsSync(dir)) fail('Agent not found.');
    const { config, problems } = readConfig(dir);
    for (const name of Object.keys(AGENT_FILES)) if (!fs.existsSync(path.join(dir, name))) problems.push({ file: name, message: `${name} is missing. Saving it again recreates it.` });
    return { tree: tree(dir), config, problems };
  }
  function readFile(userId, agentId, rel) {
    const dir = dirFor(userId, agentId);
    const file = resolveIn(dir, rel);
    if (!fs.existsSync(file)) return Object.hasOwn(AGENT_FILES, rel) ? '' : fail('File not found.');
    return readText(file);
  }
  function writeFile(userId, agentId, rel, content) {
    const dir = dirFor(userId, agentId);
    if (!fs.existsSync(dir)) fail('Agent not found.');
    if (!agentAllowed(rel)) fail('Agents can contain identity.md, instructions.md, capabilities.md, context.md, configuration.json and text files in resources/ (.md, .txt, .json, .csv, .yaml, .xml, .html).');
    checkText(content);
    if (rel === 'configuration.json') {
      let parsed;
      try { parsed = JSON.parse(content); } catch (error) { fail(`configuration.json is not valid JSON: ${error.message}`); }
      const { problems } = validateConfig(parsed);
      const blocking = problems.filter(item => !/^Ignored|ignored|treated as false/.test(item.message));
      if (blocking.length) fail(blocking.map(item => item.message).join(' '));
    }
    const file = resolveIn(dir, rel);
    keepHistory(dir, rel);
    writeAtomic(file, content);
    return read(userId, agentId);
  }
  function updateConfig(userId, agentId, mutate) {
    const dir = dirFor(userId, agentId);
    const { config } = readConfig(dir);
    const next = mutate(structuredClone(config)) || config;
    return writeFile(userId, agentId, 'configuration.json', `${JSON.stringify(next, null, 2)}\n`);
  }
  function deleteFile(userId, agentId, rel) {
    const dir = dirFor(userId, agentId);
    if (!/^resources\//.test(rel)) fail('Only resource files can be deleted. Clear the text of a core file instead.');
    const file = resolveIn(dir, rel);
    if (!fs.existsSync(file)) fail('File not found.');
    keepHistory(dir, rel);
    fs.rmSync(file);
    return read(userId, agentId);
  }
  /* Everything the runtime needs, read fresh from disk on every run. */
  function load(userId, agentId) {
    const dir = dirFor(userId, agentId);
    if (!fs.existsSync(dir)) return null;
    const text = name => { try { return fs.existsSync(path.join(dir, name)) ? readText(path.join(dir, name)) : ''; } catch { return ''; } };
    const { config, problems } = readConfig(dir);
    const resources = tree(path.join(dir, 'resources')).filter(item => item.kind === 'file' && TEXT_EXT.test(item.path) && item.size <= LIMITS.file)
      .map(item => ({ name: `resources/${item.path}`, size: item.size, read: () => text(`resources/${item.path}`) }));
    return { identity: text('identity.md'), instructions: text('instructions.md'), capabilities: text('capabilities.md'), context: text('context.md'), config, problems, resources };
  }
  function duplicate(userId, sourceId, targetId) {
    const source = dirFor(userId, sourceId); const target = dirFor(userId, targetId);
    if (!fs.existsSync(source)) fail('Agent not found.');
    copyPackage(source, target, { allow: agentAllowed });
  }
  function remove(userId, agentId) { trashDir(userRoot(userId), dirFor(userId, agentId), agentId); }
  /* Export writes a portable folder: agent.json (name, description) + the package files. No secrets exist in
     packages; the provider connection is referenced by id only and must be chosen again on another computer. */
  function exportTo(userId, agentId, targetDir, meta) {
    const dir = dirFor(userId, agentId);
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) fail('Choose an empty folder for the export.');
    copyPackage(dir, targetDir, { allow: agentAllowed });
    fs.writeFileSync(path.join(targetDir, 'agent.json'), `${JSON.stringify({ format: 'perflw-agent', version: 1, name: meta.name, description: meta.description }, null, 2)}\n`);
  }
  /* Reads an exported folder and validates it; returns metadata for the registry row. */
  function inspectImport(sourceDir) {
    if (!fs.existsSync(path.join(sourceDir, 'configuration.json'))) fail('That folder is not an exported agent (configuration.json is missing).');
    let meta = {};
    try { meta = JSON.parse(readText(path.join(sourceDir, 'agent.json'))); } catch { meta = {}; }
    let parsed;
    try { parsed = JSON.parse(readText(path.join(sourceDir, 'configuration.json'))); } catch (error) { fail(`The agent’s configuration.json is not valid JSON: ${error.message}`); }
    const { config, problems } = validateConfig(parsed);
    return { name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim().slice(0, 80) : path.basename(sourceDir).slice(0, 80), description: typeof meta.description === 'string' ? meta.description.slice(0, 300) : '', config, problems };
  }
  function importFrom(userId, agentId, sourceDir) {
    const target = dirFor(userId, agentId);
    const result = copyPackage(sourceDir, target, { allow: agentAllowed });
    scaffold(target); // fill any missing core files
    return result;
  }
  return { dirFor, ensure, create, read, readFile, writeFile, updateConfig, deleteFile, load, duplicate, remove, exportTo, inspectImport, importFrom, readConfig: (userId, agentId) => readConfig(dirFor(userId, agentId)) };
}

// ───────────────────────── skills
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const skillAllowed = rel => rel === 'SKILL.md' || (/^references\//.test(rel) && TEXT_EXT.test(rel)) || (/^resources\//.test(rel) && TEXT_EXT.test(rel)) || (/^scripts\//.test(rel) && (SCRIPT_EXT.test(rel) || TEXT_EXT.test(rel)));
const slug = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';

/* SKILL.md front matter: simple `key: value` lines between --- markers. */
function parseSkill(text) {
  const problems = []; const meta = {};
  let body = text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) problems.push('SKILL.md must start with a front matter block (--- name, description ---).');
  else {
    body = text.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (!pair) { problems.push(`Front matter line not understood: “${line.trim().slice(0, 60)}”.`); continue; }
      meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const name = (meta.name || '').slice(0, 80);
  const description = (meta.description || '').slice(0, 500);
  if (!name) problems.push('Front matter needs a name.');
  if (!description) problems.push('Front matter needs a description: it is what agents use to decide when the skill is relevant.');
  const enabled = meta.enabled === undefined ? true : meta.enabled === 'true' ? true : meta.enabled === 'false' ? false : (problems.push('enabled must be true or false.'), false);
  const activation = meta.activation === undefined || meta.activation === '' ? 'auto' : ['auto', 'always'].includes(meta.activation) ? meta.activation : (problems.push('activation must be auto or always.'), 'auto');
  const triggers = (meta.triggers || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean).slice(0, 30);
  if (!body.trim()) problems.push('SKILL.md has no instructions after the front matter.');
  // Optional `outcome:` states what a correct result looks like; agents check their answer against it.
  const outcome = (meta.outcome || '').slice(0, 300);
  // Package files the instructions point at, e.g. references/style-guide.md or scripts/run.js.
  const cited = [...new Set((body.match(/\b(?:references|scripts|resources)\/[A-Za-z0-9][A-Za-z0-9 ._-]*\.[A-Za-z0-9]+/g) || []).map(item => item.trim()))];
  return { name, description, outcome, enabled, activation, triggers, body: body.trim(), cited, problems };
}
function setFrontMatter(text, key, value) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) fail('SKILL.md has no front matter to update.');
  const lines = match[1].split(/\r?\n/); const index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index >= 0) lines[index] = `${key}: ${value}`; else lines.push(`${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---${text.slice(match[0].length)}`;
}

function createSkillPackages(baseDir) {
  const userRoot = userId => { if (!ID_RE.test(userId)) fail('Invalid account.'); return path.join(baseDir, userId, 'skills'); };
  const dirFor = (userId, skillId) => { if (!SKILL_ID.test(skillId)) fail('Skill not found.'); return path.join(userRoot(userId), skillId); };
  const exists = (userId, skillId) => SKILL_ID.test(skillId) && fs.existsSync(path.join(dirFor(userId, skillId), 'SKILL.md'));
  function uniqueId(userId, base) {
    let id = slug(base); let n = 2;
    while (fs.existsSync(dirFor(userId, id))) id = `${slug(base).slice(0, 44)}-${n++}`;
    return id;
  }
  /* SKILL.md is re-parsed only when the file changes (same modification time and size → cached parse). */
  const parsedCache = new Map();
  function parsedSkill(userId, skillId) {
    const file = path.join(dirFor(userId, skillId), 'SKILL.md'); const key = `${userId}/${skillId}`;
    try {
      const stat = fs.statSync(file); const hit = parsedCache.get(key);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed;
      const parsed = parseSkill(readText(file));
      parsedCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
      return parsed;
    } catch (error) { parsedCache.delete(key); return { name: skillId, description: '', outcome: '', enabled: false, activation: 'auto', triggers: [], body: '', cited: [], problems: [error.message] }; }
  }
  function meta(userId, skillId) {
    const dir = dirFor(userId, skillId);
    const parsed = parsedSkill(userId, skillId);
    const files = tree(dir).filter(item => item.kind === 'file');
    const paths = new Set(files.map(item => item.path));
    // A path the instructions cite but the package lacks would send an agent looking for a file that is not there.
    const warnings = parsed.cited.filter(item => !paths.has(item)).map(item => `SKILL.md mentions ${item}, but that file is not in the skill.`);
    return {
      id: skillId, name: parsed.name || skillId, description: parsed.description, outcome: parsed.outcome, enabled: parsed.enabled, activation: parsed.activation, triggers: parsed.triggers,
      problems: parsed.problems, warnings, valid: parsed.problems.length === 0,
      citedReferences: parsed.cited.filter(item => item.startsWith('references/') && paths.has(item)),
      references: files.filter(item => item.path.startsWith('references/')).map(item => item.path),
      scripts: files.filter(item => item.path.startsWith('scripts/') && SCRIPT_EXT.test(item.path)).map(item => item.path),
      resources: files.filter(item => item.path.startsWith('resources/')).map(item => item.path)
    };
  }
  function list(userId) {
    const root = userRoot(userId);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && SKILL_ID.test(entry.name) && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
      .map(entry => meta(userId, entry.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  function read(userId, skillId) {
    if (!exists(userId, skillId)) fail('Skill not found.');
    return { ...meta(userId, skillId), tree: tree(dirFor(userId, skillId)) };
  }
  function create(userId, { name, description } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) fail('Skill name must be 1–80 characters.');
    if (typeof description !== 'string' || !description.trim() || description.length > 500) fail('Describe when the skill should be used (1–500 characters).');
    if (list(userId).length >= 300) fail('You can keep up to 300 skills.');
    const id = uniqueId(userId, name);
    const dir = dirFor(userId, id);
    for (const folder of ['references', 'scripts', 'resources']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
    const clean = value => value.replace(/[\r\n]+/g, ' ').trim();
    writeAtomic(path.join(dir, 'SKILL.md'), `---\nname: ${clean(name)}\ndescription: ${clean(description)}\nenabled: true\nactivation: auto\ntriggers:\n---\n\n# ${clean(name)}\n\nWrite the step-by-step instructions an agent should follow when this skill is relevant.\n`);
    return read(userId, id);
  }
  function readFile(userId, skillId, rel) {
    if (!exists(userId, skillId)) fail('Skill not found.');
    const file = resolveIn(dirFor(userId, skillId), rel);
    if (!fs.existsSync(file)) fail('File not found.');
    return readText(file);
  }
  function writeFile(userId, skillId, rel, content) {
    if (!exists(userId, skillId)) fail('Skill not found.');
    if (!skillAllowed(rel)) fail('Skills can contain SKILL.md, text files in references/ and resources/, and .js/.py scripts (or notes) in scripts/.');
    checkText(content);
    if (rel === 'SKILL.md') {
      const parsed = parseSkill(content);
      const blocking = parsed.problems.filter(message => /front matter|name|description/i.test(message));
      if (blocking.length) fail(blocking.join(' '));
    }
    const dir = dirFor(userId, skillId);
    keepHistory(dir, rel);
    writeAtomic(resolveIn(dir, rel), content);
    parsedCache.delete(`${userId}/${skillId}`);
    return read(userId, skillId);
  }
  function deleteFile(userId, skillId, rel) {
    if (rel === 'SKILL.md') fail('SKILL.md is required. Delete the whole skill instead.');
    const dir = dirFor(userId, skillId); const file = resolveIn(dir, rel);
    if (!fs.existsSync(file)) fail('File not found.');
    keepHistory(dir, rel); fs.rmSync(file);
    return read(userId, skillId);
  }
  function setEnabled(userId, skillId, enabled) {
    const text = readFile(userId, skillId, 'SKILL.md');
    return writeFile(userId, skillId, 'SKILL.md', setFrontMatter(text, 'enabled', enabled ? 'true' : 'false'));
  }
  function duplicate(userId, skillId) {
    const source = read(userId, skillId);
    const id = uniqueId(userId, `${source.name} copy`);
    copyPackage(dirFor(userId, skillId), dirFor(userId, id), { allow: skillAllowed });
    const text = readText(path.join(dirFor(userId, id), 'SKILL.md'));
    writeAtomic(path.join(dirFor(userId, id), 'SKILL.md'), setFrontMatter(text, 'name', `${source.name} copy`.slice(0, 80)));
    return read(userId, id);
  }
  function remove(userId, skillId) { if (!exists(userId, skillId)) fail('Skill not found.'); trashDir(userRoot(userId), dirFor(userId, skillId), skillId); }
  function exportTo(userId, skillId, targetDir) {
    if (!exists(userId, skillId)) fail('Skill not found.');
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) fail('Choose an empty folder for the export.');
    return copyPackage(dirFor(userId, skillId), targetDir, { allow: skillAllowed });
  }
  function importFrom(userId, sourceDir) {
    const file = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(file)) fail('That folder is not a skill package (SKILL.md is missing).');
    const parsed = parseSkill(readText(file));
    if (!parsed.name || !parsed.description) fail(`The skill cannot be imported: ${parsed.problems.join(' ')}`);
    const id = uniqueId(userId, parsed.name);
    const result = copyPackage(sourceDir, dirFor(userId, id), { allow: skillAllowed });
    return { skill: read(userId, id), skipped: result.skipped };
  }
  /* Runtime loaders used by progressive context assembly. */
  function loadBody(userId, skillId) { if (!exists(userId, skillId)) fail('Skill not found.'); return parsedSkill(userId, skillId).body; }
  function scriptPath(userId, skillId, rel) {
    if (!exists(userId, skillId)) fail('Skill not found.');
    if (!/^scripts\//.test(rel) || !SCRIPT_EXT.test(rel)) fail('Only .js and .py files in scripts/ can be run.');
    const dir = dirFor(userId, skillId); const file = resolveIn(dir, rel);
    if (!fs.existsSync(file)) fail('Script not found.');
    return { file, dir };
  }
  return { list, read, create, readFile, writeFile, deleteFile, setEnabled, duplicate, remove, exportTo, importFrom, exists, meta, loadBody, scriptPath };
}

module.exports = { createAgentPackages, createSkillPackages, validateConfig, defaultConfig, parseSkill, PERMISSIONS, AGENT_FILES, TEXT_EXT, LIMITS };

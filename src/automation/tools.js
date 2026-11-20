'use strict';
/* Agent tools and the permission gate.
   A tool is offered to a model only when (a) the agent's configuration grants its permission and
   (b) the provider/model accepts tool definitions. Every call is checked again at execution time
   (permissions are never trusted from the model or the UI), high-impact calls ask for approval through the
   injected `requestApproval`, and every call — allowed, denied or failed — is recorded through `log`.
   Skills cannot raise permissions: skill scripts run only when the agent itself holds both
   `skillScripts` and `codeExecution`. */
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');

const MAX_RESULT = 20000;
const clip = (text, max = MAX_RESULT) => (text.length > max ? `${text.slice(0, max)}\n[…truncated at ${max} characters]` : text);
const fail = message => { throw new Error(message); };

// ───────────────────────── path and network guards
function insideFolders(target, folders) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('Give an absolute file path.');
  const resolved = path.resolve(target);
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { try { real = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch { /* new file in a missing folder */ } }
  for (const folder of folders) {
    let base = folder; try { base = fs.realpathSync(folder); } catch { continue; }
    const rel = path.relative(base, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return real;
  }
  fail('That path is outside the folders this agent may access.');
}
function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:') && privateAddress(lower.slice(7));
}
async function publicUrl(raw, { httpsOnly = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { fail('That is not a valid URL.'); }
  if (!(url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:'))) fail(httpsOnly ? 'API calls must use https://.' : 'Only http:// and https:// URLs can be fetched.');
  if (url.username || url.password) fail('URLs with embedded credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => fail(`The address ${host} could not be found.`))).map(item => item.address);
  if (!addresses.length || addresses.some(privateAddress)) fail('Requests to this computer or the local network are not allowed.');
  return url;
}
function htmlToText(html) {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
/* Minimal .docx reader: finds word/document.xml in the ZIP central directory and inflates it. */
function docxText(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) fail('This .docx file is damaged.');
  const count = buffer.readUInt16LE(eocd + 10); let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && offset < buffer.length; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10); const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28); const extra = buffer.readUInt16LE(offset + 30); const comment = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42); const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === 'word/document.xml') {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      const xml = (method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 20 * 1024 * 1024 }) : data).toString('utf8');
      return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    }
    offset += 46 + nameLength + extra + comment;
  }
  fail('This .docx file has no document text.');
}

// ───────────────────────── skill scripts
/* Runs a skill script with a minimal environment (no app secrets), a time limit and capped output.
   .js runs on the app's own Node runtime; .py needs Python on PATH. */
function runScriptProcess({ file, dir, input = '', signal, nodePath = process.execPath }) {
  const env = { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '', ELECTRON_RUN_AS_NODE: '1' };
  const isPython = /\.py$/i.test(file);
  const command = isPython ? (process.platform === 'win32' ? 'python' : 'python3') : nodePath;
  return new Promise(resolve => {
    const child = execFile(command, [file], { cwd: dir, env, timeout: 30000, maxBuffer: 256 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT' && isPython) resolve({ ok: false, output: 'Python is not installed or not on PATH, so this .py script cannot run.' });
      else if (error && error.killed) resolve({ ok: false, output: `The script was stopped after 30 seconds.\n${clip(String(stderr || ''), 2000)}` });
      else if (error) resolve({ ok: false, output: `The script failed (${error.code ?? 'error'}).\n${clip(String(stderr || stdout || error.message), 4000)}` });
      else resolve({ ok: true, output: clip(String(stdout || '')) + (stderr ? `\n[stderr]\n${clip(String(stderr), 2000)}` : '') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(String(input || '').slice(0, 100000));
  });
}

/* Builds the tool set for one agent step.
   ctx: { agentName, config, providerTools (bool), skills: { selected: [ids], assigned: [meta] }, workflow: { prompt, outputs: Map<name,text> } | null,
          skillStore: { readFile, scriptPath }, userId, requestApproval({ title, detail, risk }), log({ tool, outcome, detail }), fetchImpl, signal } */
function createToolbox(ctx) {
  const { config } = ctx; const granted = key => config.permissions[key] === true;
  const folders = config.fileAccess.folders;
  const notes = [];
  const definitions = [];
  const handlers = new Map();
  const define = (tool, permission, handler) => { definitions.push({ ...tool, permission }); handlers.set(tool.name, { permission, handler }); };
  const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
  const approve = async (title, detail, risk = 'high') => {
    const allowed = await ctx.requestApproval({ title, detail, risk, agent: ctx.agentName });
    if (!allowed) fail('The person declined this action.');
  };

  // Skills listed by description only can be loaded by the model when the task turns out to need them.
  const loadable = (ctx.skills.catalog || []).filter(skill => skill.enabled && skill.valid);
  const keepResults = new Set(['load_skill']); // loaded instructions must survive context compaction
  if (loadable.length && ctx.loadSkill) define({ name: 'load_skill', description: `Load the full instructions of one of your other skills when the task needs it. Ids: ${loadable.map(skill => skill.id).join(', ')}`, parameters: obj({ skill: { type: 'string', description: 'Skill id' } }, ['skill']) }, null, async ({ skill }) => {
    const meta = loadable.find(item => item.id === skill);
    if (!meta) fail(`“${skill}” is not one of your unloaded skills (${loadable.map(item => item.id).join(', ')}).`);
    return ctx.loadSkill(meta);
  });
  // Delegation: only to agents named in this agent's configuration, a few times per step, never nested.
  const delegates = ctx.delegates || []; let delegations = 0;
  if (delegates.length && ctx.delegate) define({ name: 'ask_agent', description: `Hand a self-contained sub-task to a specialist agent and get its answer. Use it only for work outside your own role; do the rest yourself. Agents: ${delegates.map(agent => `${agent.name}${agent.description ? ` (${agent.description})` : ''}`).join('; ')}`, parameters: obj({ agent: { type: 'string', description: 'Agent name' }, task: { type: 'string', description: 'Complete instructions and all input the agent needs' } }, ['agent', 'task']) }, null, async ({ agent, task }) => {
    const target = delegates.find(item => item.name.toLowerCase() === String(agent || '').trim().toLowerCase()) || delegates.find(item => item.id === agent);
    if (!target) fail(`You can only ask: ${delegates.map(item => item.name).join(', ')}.`);
    if (typeof task !== 'string' || !task.trim()) fail('Give the agent a task.');
    if (++delegations > 3) fail('Delegation limit reached for this step (3). Finish with what you have.');
    return clip(await ctx.delegate(target, task.trim()));
  });

  const assignedWithRefs = ctx.skills.assigned.filter(skill => skill.enabled && skill.valid && skill.references.length);
  if (assignedWithRefs.length) define({ name: 'read_skill_reference', description: `Read a reference file from one of your skills. Available: ${assignedWithRefs.map(skill => skill.references.map(ref => `${skill.id}/${ref}`).join(', ')).join('; ')}`, parameters: obj({ skill: { type: 'string' }, path: { type: 'string', description: 'For example references/guide.md' } }, ['skill', 'path']) }, null, async ({ skill, path: rel }) => {
    const meta = assignedWithRefs.find(item => item.id === skill);
    if (!meta || !meta.references.includes(rel)) fail('That reference is not part of a skill assigned to you.');
    return clip(ctx.skillStore.readFile(ctx.userId, skill, rel));
  });

  if (granted('fileRead') || granted('documents') || granted('fileWrite')) {
    if (!folders.length) notes.push('File permissions are granted but no folders are listed in configuration.json (fileAccess.folders), so file tools are unavailable.');
    else notes.push(`Folders you may access: ${folders.join('; ')}`);
  }
  if (granted('fileRead') && folders.length) {
    define({ name: 'list_files', description: 'List files in an allowed folder.', parameters: obj({ folder: { type: 'string', description: 'Absolute folder path' } }, ['folder']) }, 'fileRead', async ({ folder }) => {
      const dir = insideFolders(folder, folders);
      return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 300).map(entry => `${entry.isDirectory() ? '[dir] ' : ''}${entry.name}`).join('\n') || '(empty folder)';
    });
    define({ name: 'read_file', description: 'Read a UTF-8 text file in an allowed folder (up to 512 KB).', parameters: obj({ path: { type: 'string', description: 'Absolute file path' } }, ['path']) }, 'fileRead', async ({ path: target }) => {
      const file = insideFolders(target, folders); const stat = fs.statSync(file);
      if (!stat.isFile()) fail('Not a file.'); if (stat.size > 512 * 1024) fail('The file is larger than 512 KB.');
      const text = fs.readFileSync(file, 'utf8'); if (text.includes('\u0000')) fail('This is a binary file. Use extract_document for documents.');
      return clip(text);
    });
  }
  if (granted('documents') && folders.length) define({ name: 'extract_document', description: 'Extract readable text from a .docx, .html, .csv, .json, .xml, .md or .txt file in an allowed folder.', parameters: obj({ path: { type: 'string', description: 'Absolute file path' } }, ['path']) }, 'documents', async ({ path: target }) => {
    const file = insideFolders(target, folders); const stat = fs.statSync(file);
    if (stat.size > 10 * 1024 * 1024) fail('Documents can be up to 10 MB.');
    const ext = path.extname(file).toLowerCase(); const bytes = fs.readFileSync(file);
    if (ext === '.docx') return clip(docxText(bytes));
    if (ext === '.html' || ext === '.htm') return clip(htmlToText(bytes.toString('utf8')));
    if (['.csv', '.json', '.xml', '.md', '.txt', '.tsv', '.yaml', '.yml'].includes(ext)) return clip(bytes.toString('utf8'));
    fail(`Documents of type ${ext || 'unknown'} are not supported (supported: .docx, .html, .csv, .json, .xml, .md, .txt).`);
  });
  if (granted('fileWrite') && folders.length) define({ name: 'write_file', description: 'Create or overwrite a text file in an allowed folder. The person must approve each write.', parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) }, 'fileWrite', async ({ path: target, content }) => {
    if (typeof content !== 'string' || content.length > 1024 * 1024) fail('Content must be text up to 1 MB.');
    const file = insideFolders(target, folders); const exists = fs.existsSync(file);
    await approve(exists ? 'Allow the agent to overwrite a file?' : 'Allow the agent to create a file?', `${file}\n${content.length.toLocaleString('en-US')} characters${exists ? ' — the current file will be replaced.' : ''}`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    return `${exists ? 'Overwrote' : 'Created'} ${file}.`;
  });
  if (granted('web')) define({ name: 'fetch_url', description: 'Fetch a public web page (GET) and return its text.', parameters: obj({ url: { type: 'string' } }, ['url']) }, 'web', async ({ url }) => {
    let target = await publicUrl(url);
    for (let hop = 0; hop < 4; hop++) {
      const response = await ctx.fetchImpl(target.href, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(ctx.signal ? [ctx.signal] : [])]), headers: { 'user-agent': 'PerflwIntelligence-Agent/0.1' } });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { target = await publicUrl(new URL(response.headers.get('location'), target).href); continue; }
      if (!response.ok) fail(`The page answered with status ${response.status}.`);
      const type = response.headers.get('content-type') || '';
      if (!/text|json|xml|html/i.test(type)) fail(`The page is not text (${type || 'unknown type'}).`);
      const text = (await response.text()).slice(0, 2 * 1024 * 1024);
      return clip(/html/i.test(type) ? htmlToText(text) : text);
    }
    fail('Too many redirects.');
  });
  if (granted('externalApi')) define({ name: 'call_api', description: 'Send an HTTPS request to an external API. Non-GET requests need the person’s approval. Do not include secrets you were not given.', parameters: obj({ url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, body: { type: 'string', description: 'Request body (JSON text), optional' } }, ['url', 'method']) }, 'externalApi', async ({ url, method = 'GET', body }) => {
    const target = await publicUrl(url, { httpsOnly: true });
    const verb = String(method).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) fail('Unsupported method.');
    if (verb !== 'GET') await approve(`Allow a ${verb} request to an external API?`, `${verb} ${target.href}${body ? `\n${String(body).slice(0, 400)}` : ''}`);
    const response = await ctx.fetchImpl(target.href, { method: verb, redirect: 'error', headers: { 'content-type': 'application/json' }, body: verb === 'GET' ? undefined : String(body || ''), signal: AbortSignal.any([AbortSignal.timeout(20000), ...(ctx.signal ? [ctx.signal] : [])]) });
    return clip(`Status ${response.status}\n${(await response.text()).slice(0, 200000)}`);
  });
  if (granted('workflow') && ctx.workflow) {
    define({ name: 'get_workflow_input', description: 'Return the original message that started this workflow run.', parameters: obj({}, []) }, 'workflow', async () => ctx.workflow.prompt);
    define({ name: 'read_step_output', description: `Read the output of an earlier step in this run. Finished steps: ${[...ctx.workflow.outputs.keys()].join(', ') || 'none yet'}.`, parameters: obj({ step: { type: 'string' } }, ['step']) }, 'workflow', async ({ step }) => {
      if (!ctx.workflow.outputs.has(step)) fail(`No finished step named “${step}”.`);
      return clip(ctx.workflow.outputs.get(step));
    });
  }
  const scriptSkills = ctx.skills.assigned.filter(skill => skill.enabled && skill.valid && skill.scripts.length);
  if (scriptSkills.length && (!granted('skillScripts') || !granted('codeExecution'))) notes.push('Skill scripts exist but cannot run: the agent needs both “Run skill scripts” and “Code execution” permissions.');
  if (granted('skillScripts') && granted('codeExecution') && scriptSkills.length)
    define({ name: 'run_skill_script', description: `Run a script from one of your skills. The person must approve each run. Available: ${scriptSkills.map(skill => skill.scripts.map(script => `${skill.id}/${script}`).join(', ')).join('; ')}`, parameters: obj({ skill: { type: 'string' }, script: { type: 'string', description: 'For example scripts/run.js' }, input: { type: 'string', description: 'Text passed on standard input' } }, ['skill', 'script']) }, 'skillScripts', async ({ skill, script, input }) => {
      if (!granted('codeExecution')) fail('This agent is not allowed to execute code.');
      const meta = scriptSkills.find(item => item.id === skill);
      if (!meta || !meta.scripts.includes(script)) fail('That script is not part of an enabled skill assigned to you.');
      const { file, dir } = ctx.skillStore.scriptPath(ctx.userId, skill, script);
      await approve('Allow the agent to run a skill script?', `${skill}/${script}\nRuns on this computer for up to 30 seconds.`);
      const result = await runScriptProcess({ file, dir, input, signal: ctx.signal });
      if (!result.ok) fail(result.output);
      return result.output || '(no output)';
    });

  if (!ctx.providerTools && definitions.length) {
    notes.push(`Tools were not offered because this provider/model does not accept tool calls (${definitions.map(item => item.name).join(', ')} unavailable).`);
    definitions.length = 0; handlers.clear();
  }

  const done = new Map();
  /* Executes one model-requested call. Never throws: failures become tool results the model can read. */
  async function execute(call) {
    const entry = handlers.get(call.name);
    const started = Date.now();
    if (!entry) { ctx.log({ tool: call.name, outcome: 'denied', detail: 'Tool not available to this agent.' }); return { ok: false, content: `Error: the tool “${call.name}” is not available to you.` }; }
    // Execution-time permission check against the configuration loaded for this step.
    if (entry.permission && !granted(entry.permission)) { ctx.log({ tool: call.name, outcome: 'denied', detail: `Permission ${entry.permission} not granted.` }); return { ok: false, content: 'Error: permission denied.' }; }
    if (call.arguments && call.arguments.__invalid !== undefined) { ctx.log({ tool: call.name, outcome: 'failed', detail: 'Invalid arguments.' }); return { ok: false, content: 'Error: the tool arguments were not valid JSON.' }; }
    // An identical call that already succeeded in this step is answered from its earlier result: no second
    // file write, script run, delegation or fetch, and a looping model gets told to move on.
    const key = `${call.name}:${JSON.stringify(call.arguments || {})}`;
    if (done.has(key)) { ctx.log({ tool: call.name, outcome: 'reused', detail: `${summarize(call)} — identical call already made in this step` }); return { ok: true, content: `You already made this exact call in this step. Its result was:\n${done.get(key)}\nDo not call it again; continue with the task.`, keep: keepResults.has(call.name) }; }
    try {
      const content = String(await entry.handler(call.arguments || {}));
      done.set(key, content);
      ctx.log({ tool: call.name, outcome: 'ok', detail: summarize(call), durationMs: Date.now() - started });
      return { ok: true, content, keep: keepResults.has(call.name) };
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const declined = /declined/.test(error.message);
      ctx.log({ tool: call.name, outcome: declined ? 'declined' : 'failed', detail: `${summarize(call)} — ${error.message}`, durationMs: Date.now() - started });
      return { ok: false, content: `Error: ${error.message}` };
    }
  }
  return { definitions: definitions.map(({ permission, ...tool }) => tool), granted: definitions.map(item => item.name), notes, execute };
}
function summarize(call) {
  const args = call.arguments || {};
  const value = args.path || args.url || args.folder || (args.skill ? `${args.skill}${args.script ? `/${args.script}` : ''}` : '') || args.step || args.agent || '';
  return `${call.name}${value ? ` ${String(value).slice(0, 160)}` : ''}`;
}

module.exports = { createToolbox, runScriptProcess, docxText, htmlToText, privateAddress, insideFolders };

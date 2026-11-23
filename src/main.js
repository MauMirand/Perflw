const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, nativeImage, protocol, session, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createAuth } = require('./auth');
const { createWorkspace } = require('./workspace');
const { startupMessage } = require('./startup-error');
const { registerLearningIpc } = require('./learning-ipc');
const { registerStudySessionIpc, closeOpenSessions } = require('./learning-session-ipc');
const learningImport = require('./learning-import');
const { runWorkflow, LIMITS: AUTOMATION_LIMITS } = require('./automation/engine');
const { createOllamaRuntime } = require('./automation/ollama');
const { createEcosystem } = require('./automation/ecosystem');
const { createChatEngine } = require('./automation/chat');
const { createLearningWorkflow } = require('./learning-workflow');
const { writeFileAtomic, readJsonFile } = require('./safe-file');

// Local Ollama model listing for the Agents page; agent execution goes through the ecosystem's provider layer.
const agentRuntime = createOllamaRuntime();
let ecosystem;
let chatEngine;
let learningFlow;
let activeRun = null;

/* Generated visuals from chat replies render in an <iframe sandbox="allow-scripts"> that loads this page from
   its own scheme. The page has its own Content-Security-Policy (no network, no frames, no forms), an opaque
   origin (no storage, no cookies), no preload script and therefore no access to the app's IPC bridge.
   The chat view hands it the generated HTML with postMessage; nothing flows back except a height report. */
const SANDBOX_SCHEME = 'perflw-sandbox';
const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
const SANDBOX_PAGE = '<!doctype html><meta charset="utf-8"><script>(function(){var done=false;addEventListener("message",function(e){if(done||e.source!==parent||!e.data||e.data.type!=="render"||typeof e.data.html!=="string")return;done=true;document.open();document.write(e.data.html);document.close();});parent.postMessage({type:"ready"},"*");})();</script>';
/* Study files open in Chromium's built-in PDF viewer inside the Learning viewer, served from perflw-doc://file/<fileId>.
   Only the signed-in account's files are served: an uploaded PDF, or the PDF copy Office made of a Word/PowerPoint file. */
const DOC_SCHEME = 'perflw-doc';
protocol.registerSchemesAsPrivileged([
  { scheme: SANDBOX_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: DOC_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

let window;
let auth;
let workspace;
let token = null;
let sessionFile;
if (!app.isPackaged && process.env.PERFLW_TEST_USER_DATA)
  app.setPath('userData', path.resolve(process.env.PERFLW_TEST_USER_DATA));
else migrateLegacyUserData();

/* The app was called Impct Intelligence before it became Perflw; its data lived in %APPDATA%\impct-intelligence.
   On the first start without Perflw data, that folder is copied over (caches excluded) and the original is left
   untouched. Local State travels with it, so safeStorage (DPAPI) can still decrypt the session and API keys. */
function migrateLegacyUserData() {
  const target = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'impct-intelligence');
  const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', 'blob_storage']);
  try {
    if (path.resolve(target).toLowerCase() === path.resolve(legacy).toLowerCase()) return;
    if (fs.existsSync(path.join(target, 'accounts.sqlite')) || !fs.existsSync(path.join(legacy, 'accounts.sqlite'))) return;
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(legacy)) {
      if (skip.has(entry)) continue;
      fs.cpSync(path.join(legacy, entry), path.join(target, entry), { recursive: true, force: false, errorOnExist: false });
    }
  } catch (error) { console.error('Earlier Impct Intelligence data could not be copied:', error.message); }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let secondInstanceReceived = false;

function focusMainWindow() {
  if (!window || window.isDestroyed()) {
    if (app.isReady()) createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  secondInstanceReceived = true;
  if (app.isReady()) focusMainWindow();
});


function currentUser() { return token ? auth.session(token) : null; }
function requireUser() {
  const user = currentUser();
  if (!user) throw new Error('Your session has expired. Log in again.');
  return user;
}
function assertSender(event) {
  if (!window || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.sender.getURL() !== pathToFileURL(path.join(__dirname, 'index.html')).href)
    throw new Error('Unauthorized request.');
}
function persistToken() {
  if (!token) {
    try { fs.unlinkSync(sessionFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure session storage is unavailable.');
  writeFileAtomic(sessionFile, safeStorage.encryptString(token)); // temp + rename, 0o600, retried while held
}
function restoreToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const candidate = safeStorage.decryptString(fs.readFileSync(sessionFile));
    if (auth.session(candidate)) token = candidate;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Stored session could not be restored:', error.message);
  }
}
function profileImage(user, imageName = user.imageName) {
  if (!imageName) return null;
  const imagePath = path.join(app.getPath('userData'), 'profiles', user.id, imageName);
  try {
    const bytes = fs.readFileSync(imagePath);
    if (bytes.length > 5 * 1024 * 1024) return null;
    const mime = imageName.endsWith('.png') ? 'image/png' :
      imageName.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch { return null; }
}
function state() {
  const user = currentUser();
  return user ? { user: { ...user, image: profileImage(user), coverImage: profileImage(user, user.coverImageName) } } : { user: null };
}
function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg';
  throw new Error('Choose a PNG, JPG, or WebP image.');
}
/* The PDF of a topic file for the signed-in account: the uploaded PDF, or the PDF copy Office made of a Word/PowerPoint file. */
function topicPdfBytes(user, fileId) {
  const file = workspace.topicFile(user.id, fileId);
  const name = file.type === 'pdf' ? file.storedName : file.preview === 'ready' ? file.previewName : null;
  if (!name || !/^[a-f0-9]{32}\.pdf$/.test(name)) return null;
  return fs.readFileSync(path.join(app.getPath('userData'), 'learning-files', user.id, name));
}
/* Study marks from the renderer: only known fields, numbers kept to 0–1 (or a sane range), text and counts capped. */
function cleanAnnotations(data) {
  const unit = v => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : 0);
  const id = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : Math.random().toString(36).slice(2, 12));
  const page = v => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : 0);
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const color = v => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#F5C542');
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  const d = data && typeof data === 'object' ? data : {};
  return {
    notes: list(d.notes, 500).map(n => ({ id: id(n && n.id), page: page(n && n.page), x: unit(n && n.x), y: unit(n && n.y), text: text(n && n.text, 4000), color: color(n && n.color) })),
    strokes: list(d.strokes, 3000).map(st => ({ id: id(st && st.id), page: page(st && st.page), tool: st && st.tool === 'highlighter' ? 'highlighter' : 'pen', color: color(st && st.color),
      points: list(st && st.points, 4000).filter(pt => Array.isArray(pt) && pt.length === 2).map(pt => [Math.round(unit(pt[0]) * 10000) / 10000, Math.round(unit(pt[1]) * 10000) / 10000]) })).filter(st => st.points.length > 1),
    comments: list(d.comments, 500).map(c => ({ id: id(c && c.id), page: page(c && c.page), x: unit(c && c.x), y: unit(c && c.y), w: unit(c && c.w), h: unit(c && c.h), text: text(c && c.text, 4000), quote: text(c && c.quote, 4000), asked: Boolean(c && c.asked), at: text(c && c.at, 40) }))
  };
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event);
    try { return { ok: true, value: await action(...args) }; }
    catch (error) {
      const message = error.message;
      if (message && !/SQLITE|EACCES|ENOENT|EPERM/i.test(message)) return { ok: false, error: message };
      console.error(channel, error);
      return { ok: false, error: 'The request could not be completed.' };
    }
  });
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 927, minWidth: 960, minHeight: 620,
    title: 'Perflw',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    backgroundColor: '#131313',
    frame: false,
    show: false, // shown on ready-to-show, so the window never appears blank while the interface loads
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      plugins: true // Chromium's PDF viewer (the only plugin Electron ships), used by the Learning viewer
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  // No frame may navigate anywhere except to the sandbox page itself (a generated visual cannot leave its frame)
  // or to a study file in the Learning viewer.
  window.webContents.on('will-frame-navigate', event => { if (!event.url.startsWith(`${SANDBOX_SCHEME}://frame/`) && !event.url.startsWith(`${DOC_SCHEME}://file/`)) event.preventDefault(); });
  const sendMaximized = () => { if (!window.isDestroyed()) window.webContents.send('window:maximized', window.isMaximized()); };
  window.on('maximize', sendMaximized);
  window.on('unmaximize', sendMaximized);
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  window.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  // Test-only: Linux CI machines have no keyring, so allow basic encryption for isolated test data.
  if (!app.isPackaged && process.env.PERFLW_TEST_USER_DATA && process.platform === 'linux' && typeof safeStorage.setUsePlainTextEncryption === 'function')
    safeStorage.setUsePlainTextEncryption(true);
  protocol.handle(SANDBOX_SCHEME, () => new Response(SANDBOX_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': SANDBOX_CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }));
  // The interface never needs the network (model calls are made by the main process), so every web request
  // from page content is refused. This is what keeps generated visuals from sending anything out.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_details, callback) => callback({ cancel: true }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const root = app.getPath('userData');
  protocol.handle(DOC_SCHEME, request => {
    try {
      const user = currentUser(); if (!user) return new Response('', { status: 403 });
      const bytes = topicPdfBytes(user, decodeURIComponent(new URL(request.url).pathname.replace(/^\//, '')));
      if (!bytes) return new Response('', { status: 404 });
      return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch { return new Response('', { status: 404 }); }
  });
  // If a database cannot be opened, backed up or migrated (PF-021), say so in plain language and quit. Nothing is deleted or moved.
  try {
    auth = createAuth(root);
    workspace = createWorkspace(root);
  } catch (error) {
    if (workspace) workspace.close();
    if (auth) auth.close();
    const { title, message } = startupMessage(error, { dataDir: root });
    // Test mode: a modal box would block an automated run, so print the message instead.
    if (!app.isPackaged && process.env.PERFLW_TEST_USER_DATA) console.error(`${title}: ${message}`);
    else dialog.showErrorBox(title, message);
    app.exit(1);
    return;
  }
  // API keys are encrypted with the OS credential protection behind safeStorage (DPAPI on Windows).
  ecosystem = createEcosystem({
    root, workspace,
    secrets: { available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes) }
  });
  chatEngine = createChatEngine({ workspace, ecosystem });
  // Learning document workflow: analysis of uploaded files, notes panel, information center and the Ask panel.
  learningFlow = createLearningWorkflow({ root, workspace, ecosystem, emit: event => { if (window && !window.isDestroyed()) window.webContents.send('learning:intelEvent', event); } });
  sessionFile = path.join(root, 'session.bin');
  restoreToken();
  handle('auth:state', () => state());
  handle('auth:register', (email, password, confirmation) => {
    const result = auth.register(email, password, confirmation);
    token = result.token;
    persistToken();
    return state();
  });
  handle('auth:login', (email, password) => {
    const result = auth.login(email, password);
    token = result.token;
    persistToken();
    return state();
  });
  handle('auth:pickImage', async () => {
    const user = requireUser();
    let file;
    if (!app.isPackaged && process.env.PERFLW_TEST_IMAGE_PATH) file = process.env.PERFLW_TEST_IMAGE_PATH;
    else {
      const chosen = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      });
      if (chosen.canceled || chosen.filePaths.length !== 1) return null;
      file = chosen.filePaths[0];
    }
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('Image must be 5 MB or smaller.');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Image must be 5 MB or smaller.');
    const extension = imageExtension(bytes);
    const decoded = nativeImage.createFromBuffer(bytes);
    const size = decoded.getSize();
    if (decoded.isEmpty() || size.width > 4096 || size.height > 4096)
      throw new Error('Choose a valid image no larger than 4096 × 4096 pixels.');
    const directory = path.join(root, 'profiles', user.id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const imageName = `${randomBytes(16).toString('hex')}.${extension}`;
    fs.writeFileSync(path.join(directory, imageName), bytes, { mode: 0o600, flag: 'wx' });
    return { imageName, image: `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${bytes.toString('base64')}` };
  });
  handle('auth:saveProfile', (displayName, bio, imageName, coverImageName = null, coverTheme = 'aurora', coverPosition = 'center 52%') => {
    const user = requireUser();
    for (const [name, label] of [[imageName, 'profile'], [coverImageName, 'cover']]) {
      if (name !== null && (typeof name !== 'string' || !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(name) ||
          !fs.existsSync(path.join(root, 'profiles', user.id, name))))
        throw new Error(`Invalid ${label} image.`);
    }
    auth.saveProfile(token, displayName, bio, imageName, coverImageName, coverTheme, coverPosition);
    return state();
  });
  handle('auth:logout', () => {
    if (activeRun) activeRun.controller.abort();
    chatEngine.cancelAll();
    auth.logout(token);
    token = null;
    persistToken();
    return state();
  });
  handle('workspace:projects', includeArchived => { const user=requireUser(); workspace.adoptLegacyProjects(user.id); return workspace.listProjects(user.id,includeArchived).map(p=>p.cover&&p.cover!=='none'&&!String(p.cover).startsWith('g:')?{...p,cover_image:profileImage(user,p.cover)}:p); });
  // Project pages: image blocks store only a file name; the picture itself is resolved for the signed-in account here.
  handle('workspace:projectPage', projectId => {
    const user=requireUser(); const page=workspace.getProjectPage(user.id,projectId);
    page.blocks=page.blocks.map(block=>block.type==='image'&&block.data.imageName?{...block,image:profileImage(user,block.data.imageName)}:block);
    const cover=page.project.cover; if (cover&&cover!=='none'&&!cover.startsWith('g:')) page.project.cover_image=profileImage(user,cover);
    return page;
  });
  handle('workspace:saveProjectPage', (projectId,page) => {
    const user=requireUser();
    for (const block of (page&&Array.isArray(page.blocks)?page.blocks:[])) if (block&&block.type==='image'&&block.data&&block.data.imageName!=null) validateScheduleImage(user,block.data.imageName);
    const cover=page&&page.project&&page.project.cover; if (cover!=null&&cover!=='none'&&!/^g:/.test(String(cover))) validateScheduleImage(user,cover);
    return workspace.saveProjectPage(user.id,projectId,page);
  });
  handle('workspace:deleteMilestone', id => workspace.deleteMilestone(requireUser().id,id));
  handle('workspace:projectData', projectId => workspace.listProjectData(requireUser().id,projectId));
  handle('workspace:createProject', (name,details) => workspace.createProject(requireUser().id,name,details));
  handle('workspace:deleteProject', id => workspace.deleteProject(requireUser().id,id));
  handle('workspace:tasks', () => {const user=requireUser();return workspace.listTasks(user.id).map(task=>({...task,image:task.image_name?profileImage(user,task.image_name):null}));});
  handle('workspace:createTask', (title,dueAt,projectId,goalId,priority,icon,theme,notes,skill,imageName,skills,schedule) => {const user=requireUser();return workspace.createTask(user.id,title,dueAt,projectId,goalId,priority,icon,theme,notes,skill,validateScheduleImage(user,imageName),skills,schedule);});
  handle('workspace:deleteTask', (id,eventPolicy) => workspace.deleteTask(requireUser().id,id,eventPolicy));
  handle('workspace:complete', (entity,id,completed) => workspace.setCompleted(requireUser().id,entity,id,completed));
  function validateScheduleImage(user, name) {
    if (name == null) return null;
    if (typeof name !== 'string' || !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(name) || !fs.existsSync(path.join(root, 'profiles', user.id, name))) throw new Error('Invalid schedule image.');
    return name;
  }
  // Learning subjects. Images come from auth:pickImage (the account's own image folder) and go back as data URLs.
  const withSubjectImage = (user, subject) => ({ ...subject, image: subject.imageName ? profileImage(user, subject.imageName) : null });
  const subjectDetails = (user, details) => {
    if (details && typeof details === 'object' && details.imageName !== undefined) return { ...details, imageName: validateScheduleImage(user, details.imageName) };
    return details;
  };
  handle('learning:subjects', profile => { const user=requireUser(); return workspace.listSubjects(user.id,profile).map(subject=>withSubjectImage(user,subject)); });
  handle('learning:createSubject', (profile,details) => { const user=requireUser(); return withSubjectImage(user,workspace.createSubject(user.id,profile,subjectDetails(user,details))); });
  handle('learning:updateSubject', (id,details) => { const user=requireUser(); return withSubjectImage(user,workspace.updateSubject(user.id,id,subjectDetails(user,details))); });
  // Uploaded topic files live under userData/learning-files/<account>/ with random names; the database keeps the original name.
  const learningFiles = user => path.join(root, 'learning-files', user.id);
  const removeLearningFiles = (user, names) => { for (const name of names || []) if (/^[a-f0-9]{32}\.[a-z]{2,4}$/.test(name)) fs.rm(path.join(learningFiles(user), name), { force: true }, () => {}); };
  // Study marks on a file (sticky notes, pen and highlighter strokes, area comments): one JSON per file, removed with it.
  const annotationFile = (user, fileId) => path.join(learningFiles(user), 'annotations', `${fileId}.json`);
  const removeAnnotations = (user, fileIds) => { for (const id of fileIds || []) if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) fs.rm(annotationFile(user, id), { force: true }, () => {}); };
  handle('learning:deleteSubject', id => {
    const user=requireUser();
    let fileIds = []; try { fileIds = workspace.listTopics(user.id, id).files.map(f => f.id); } catch { /* subject already gone */ }
    let journeyIds = []; try { journeyIds = workspace.learningStore().listJourneys(user.id, { subjectId: id }).map(j => j.id); } catch { /* subject already gone */ }
    removeLearningFiles(user, workspace.deleteSubject(user.id,id)); removeAnnotations(user, fileIds); learningFlow.subjectRemoved(user.id, id);
    for (const folder of [...journeyIds.map(j => path.join('journeys', j)), path.join('side-notes', String(id))]) { try { fs.rmSync(path.join(root, 'learning-files', user.id, folder), { recursive: true, force: true }); } catch { /* best effort */ } }
  });
  registerLearningIpc({ handle, requireUser, workspace });
  registerStudySessionIpc({ handle, requireUser, workspace, dataDir: root });
  try { closeOpenSessions({ workspace }); } catch (error) { console.error('study sessions', error.message); } // a crash can leave a session open: close it at its last activity
  handle('learning:topics', subjectId => workspace.listTopics(requireUser().id, subjectId));
  handle('learning:addTopic', (subjectId, details) => workspace.addTopic(requireUser().id, subjectId, details));
  handle('learning:renameTopic', (topicId, title) => workspace.renameTopic(requireUser().id, topicId, title));
  handle('learning:saveTopicOrder', (subjectId, order) => workspace.saveTopicOrder(requireUser().id, subjectId, order));
  handle('learning:deleteTopics', (subjectId, ids) => {
    const user = requireUser(); const before = workspace.listTopics(user.id, subjectId).files.map(f => f.id);
    const result = workspace.deleteTopics(user.id, subjectId, ids);
    removeLearningFiles(user, result.removedFiles); delete result.removedFiles;
    const left = new Set(result.files.map(f => f.id));
    const gone = before.filter(id => !left.has(id));
    learningFlow.filesRemoved(user.id, subjectId, gone); removeAnnotations(user, gone);
    return result;
  });
  handle('learning:uploadTopics', async subjectId => {
    const user = requireUser();
    workspace.listTopics(user.id, subjectId); // fails early for a subject outside this account
    let file;
    if (!app.isPackaged && process.env.PERFLW_TEST_TOPIC_PATH) file = process.env.PERFLW_TEST_TOPIC_PATH;
    else {
      const chosen = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [
        { name: 'Study files', extensions: learningImport.TYPES }, { name: 'All files', extensions: ['*'] }] });
      if (chosen.canceled || chosen.filePaths.length !== 1) return null;
      file = chosen.filePaths[0];
    }
    return importTopicFile(user, subjectId, file);
  });
  /* A file dropped on the Topics card. The renderer only names the path (from webUtils.getPathForFile); the same
     checks as the picker apply: a regular file with a study-file extension, 25 MB at most. */
  handle('learning:importDroppedTopics', (subjectId, file) => {
    const user = requireUser();
    workspace.listTopics(user.id, subjectId);
    if (typeof file !== 'string' || !file || !path.isAbsolute(file)) throw new Error('That file could not be read. Drop a file from your computer.');
    return importTopicFile(user, subjectId, file);
  });
  async function importTopicFile(user, subjectId, file) {
    const name = path.basename(file);
    const type = learningImport.typeOf(name);
    if (!type) throw new Error('Choose a PDF, Word (.docx), PowerPoint (.pptx), Markdown or text file.');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('Choose a file, not a folder.');
    if (stat.size > learningImport.MAX_FILE) throw new Error('Files must be 25 MB or smaller.');
    const bytes = fs.readFileSync(file);
    const parsed = learningImport.readText(bytes, name); // one topic per file; its headings live in the key points
    const directory = learningFiles(user);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const storedName = `${randomBytes(16).toString('hex')}.${type}`;
    fs.writeFileSync(path.join(directory, storedName), bytes, { mode: 0o600, flag: 'wx' });
    try {
      const result = workspace.importTopics(user.id, subjectId, { name, storedName, type, size: bytes.length, text: parsed.text }, []);
      const out = { ...result, note: parsed.note, split: false };
      if (type === 'docx' || type === 'pptx') queuePreview(user, result.fileId);
      learningFlow.queueFile(user.id, result.fileId); // conversion → pre-analysis → notes .md → information center
      return out;
    } catch (error) { removeLearningFiles(user, [storedName]); throw error; }
  }

  /* Exact view of Word / PowerPoint files: Office saves a PDF copy in the background (one file at a time), which the
     viewer then shows with Chromium's PDF viewer. The original file is opened read-only and never changed. Without
     Office, or if it fails, the file is marked 'failed' and the viewer falls back to the kept text. */
  const OFFICE_SCRIPT = String.raw`param([string]$Kind, [string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
if ($Kind -eq 'docx') {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false; $app.DisplayAlerts = 0
  try {
    $m = [System.Reflection.Missing]::Value; $nopw = 'perflw-no-password'
    $doc = $app.Documents.Open($In, $false, $true, $false, $nopw, $nopw, $false, $nopw, $nopw, 0, $m, $false, $false, 0, $true)
    try { $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false) } finally { $doc.Close(0) }
  } finally { if ($app.Documents.Count -eq 0) { $app.Quit() } }
} elseif ($Kind -eq 'pptx') {
  $app = New-Object -ComObject PowerPoint.Application
  try {
    $pres = $app.Presentations.Open($In, -1, 0, 0)
    try { $pres.SaveAs($Out, 32) } finally { $pres.Close() }
  } finally { if ($app.Presentations.Count -eq 0) { $app.Quit() } }
} else { exit 2 }`;
  const previewQueue = []; let previewBusy = false;
  function queuePreview(user, fileId) {
    if (process.platform !== 'win32') { workspace.setFilePreview(user.id, fileId, 'failed'); return; }
    workspace.setFilePreview(user.id, fileId, 'pending');
    previewQueue.push({ user, fileId });
    runPreviews();
  }
  function previewChanged(fileId) { if (window && !window.isDestroyed()) window.webContents.send('learning:previewChanged', fileId); }
  async function runPreviews() {
    if (previewBusy) return;
    previewBusy = true;
    try {
      while (previewQueue.length) {
        const { user, fileId } = previewQueue.shift();
        let file; try { file = workspace.topicFile(user.id, fileId); } catch { continue; } // deleted meanwhile
        const dir = learningFiles(user);
        const previewName = `${file.storedName.slice(0, 32)}.pdf`;
        const temp = path.join(dir, `${previewName.slice(0, 32)}.tmp.pdf`); // PowerPoint only saves a PDF whose name ends in .pdf
        try {
          const script = path.join(app.getPath('temp'), 'perflw-office-to-pdf.ps1');
          fs.writeFileSync(script, OFFICE_SCRIPT, 'utf8');
          await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, file.type, path.join(dir, file.storedName), temp],
            { windowsHide: true, timeout: 180000 }, (error, _out, stderr) => (error ? reject(new Error(String(stderr || error.message).trim().split('\n')[0])) : resolve())));
          if (!fs.existsSync(temp)) throw new Error('Office did not write a PDF.');
          let still; try { still = workspace.topicFile(user.id, fileId); } catch { still = null; }
          if (!still) { fs.rm(temp, { force: true }, () => {}); continue; }
          fs.renameSync(temp, path.join(dir, previewName));
          workspace.setFilePreview(user.id, fileId, 'ready', previewName);
          if (file.type === 'docx') learningFlow.queueFile(user.id, fileId); // read again with the copy's pages for the notes panel
        } catch (error) {
          fs.rm(temp, { force: true }, () => {});
          try { workspace.setFilePreview(user.id, fileId, 'failed'); } catch { /* deleted */ }
          console.error('Office preview failed:', error.message);
        }
        previewChanged(fileId);
      }
    } finally { previewBusy = false; }
  }
  /* The viewer asks what to show for a file. Word/PowerPoint files uploaded before this existed get their copy now. */
  handle('learning:filePreview', fileId => {
    const user = requireUser();
    const file = workspace.topicFile(user.id, fileId);
    if ((file.type === 'docx' || file.type === 'pptx') && file.preview === 'none') { queuePreview(user, file.id); file.preview = 'pending'; }
    const pdf = file.type === 'pdf' || file.preview === 'ready';
    // An uploaded picture is shown as itself (the page CSP allows data: images); its text comes from the Image Reader.
    if (learningImport.IMAGE_TYPES.includes(file.type) && /^[a-f0-9]{32}\.(png|jpg|jpeg|webp)$/.test(file.storedName)) {
      const bytes = fs.readFileSync(path.join(learningFiles(user), file.storedName));
      const mime = file.type === 'png' ? 'image/png' : file.type === 'webp' ? 'image/webp' : 'image/jpeg';
      return { id: file.id, name: file.name, type: file.type, preview: 'none', url: null, text: '', image: `data:${mime};base64,${bytes.toString('base64')}` };
    }
    return { id: file.id, name: file.name, type: file.type, preview: file.preview, url: pdf ? `${DOC_SCHEME}://file/${encodeURIComponent(file.id)}` : null, text: pdf ? '' : file.text };
  });
  /* The in-app PDF viewer (learning-pdf.js) reads the PDF's bytes once per file and draws it with pdf.js. */
  handle('learning:fileBytes', fileId => {
    const bytes = topicPdfBytes(requireUser(), fileId);
    if (!bytes) throw new Error('This file has no PDF to show.');
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  });
  /* Study marks (learning-annotate.js). Positions are fractions of the page (0–1), so they survive any zoom. */
  handle('learning:annotations', fileId => {
    const user = requireUser(); workspace.topicFile(user.id, fileId); // the file must belong to this account
    // Missing or damaged: no marks yet. Held by another program: an error, never "no marks" (the next save would erase them).
    try { return cleanAnnotations(readJsonFile(annotationFile(user, fileId), {})); }
    catch (error) { if (error.code && /^(EPERM|EBUSY|EACCES)$/.test(error.code)) throw error; return { notes: [], strokes: [], comments: [] }; }
  });
  handle('learning:saveAnnotations', (fileId, data) => {
    const user = requireUser(); workspace.topicFile(user.id, fileId);
    const clean = cleanAnnotations(data);
    const text = JSON.stringify(clean);
    if (text.length > 4 * 1024 * 1024) throw new Error('This file has too many marks to save. Remove some drawings first.');
    const file = annotationFile(user, fileId);
    writeFileAtomic(file, text); // own temp name, file mode 0o600, retried while the file is held
    return clean;
  });
  /* Learning document workflow: notes panel data, saved notes, the information center files, and questions. */
  handle('learning:analysis', fileId => learningFlow.fileAnalysis(requireUser().id, fileId));
  handle('learning:reanalyze', fileId => { const user = requireUser(); workspace.topicFile(user.id, fileId); return learningFlow.reanalyze(user.id, fileId); });
  handle('learning:notes', subjectId => learningFlow.notes(requireUser().id, subjectId));
  handle('learning:deleteNote', (subjectId, noteId) => learningFlow.deleteNote(requireUser().id, subjectId, noteId));
  handle('learning:openNotesFile', async (subjectId, docId) => {
    const file = learningFlow.infoCenterPath(requireUser().id, subjectId, typeof docId === 'string' && docId ? docId : null);
    if (!file) throw new Error('That notes file does not exist yet.');
    if (!app.isPackaged && process.env.PERFLW_TEST_USER_DATA) return file; // tests check the path without opening an editor
    const problem = await shell.openPath(file); if (problem) throw new Error(problem);
    return file;
  });
  handle('learning:ask', (subjectId, fileId, question, requestId, history, about) => {
    const user = requireUser();
    const id = typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(requestId) ? requestId : null;
    // Ids of the answered turns the Ask panel still shows; the workflow uses only turns it answered itself.
    const shown = Array.isArray(history) ? history.filter(item => typeof item === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item)).slice(-50) : [];
    // A question about an area marked on the page carries that area's text (and page) separately from the question.
    const marked = about && typeof about === 'object' && typeof about.quote === 'string' && about.quote.trim()
      ? { quote: about.quote.slice(0, 1500), page: Number.isInteger(about.page) && about.page > 0 && about.page < 100000 ? about.page : null } : null;
    return learningFlow.ask(user.id, { subjectId, fileId: typeof fileId === 'string' ? fileId : null, question, requestId: id, history: shown, about: marked },
      event => { if (window && !window.isDestroyed()) window.webContents.send('learning:askEvent', { requestId: id, ...event }); });
  });
  handle('learning:cancelAsk', requestId => learningFlow.cancelAsk(String(requestId || '')));
  // What the student taught the assistant and confirmed: a fact (a note of this subject) or an answer preference.
  handle('learning:saveLearned', (subjectId, item) => {
    const user = requireUser(); const value = item && typeof item === 'object' ? item : {};
    const docId = typeof value.docId === 'string' && /^[a-z0-9-]{1,60}$/.test(value.docId) ? value.docId : null;
    return learningFlow.saveLearned(user.id, { subjectId, kind: value.kind === 'preference' ? 'preference' : 'fact', text: String(value.text || '').slice(0, 500), docId });
  });
  handle('learning:preferences', () => learningFlow.preferences(requireUser().id));
  handle('learning:deletePreference', id => learningFlow.deletePreference(requireUser().id, String(id || '')));
  handle('learning:retryPreview', fileId => {
    const user = requireUser(); const file = workspace.topicFile(user.id, fileId);
    if (file.type === 'docx' || file.type === 'pptx') queuePreview(user, file.id);
    return true;
  });
  handle('workspace:events', () => { const user=requireUser(); return workspace.listEvents(user.id).map(event=>({...event,image:event.image_name?profileImage(user,event.image_name):null})); });
  handle('workspace:createEvent', (title,startsAt,endsAt,projectId,taskId,theme,eventType,location,notes,imageName) => {const user=requireUser();return workspace.createEvent(user.id,title,startsAt,endsAt,projectId,taskId,theme,eventType,location,notes,validateScheduleImage(user,imageName));});
  handle('workspace:updateEvent', (id,event) => {const user=requireUser();if(event.imageName!==undefined)event.imageName=validateScheduleImage(user,event.imageName);return workspace.updateEvent(user.id,id,event);});
  handle('workspace:deleteEvent', id => workspace.deleteEvent(requireUser().id,id));
  handle('workspace:milestones', () => workspace.listMilestones(requireUser().id));
  handle('workspace:createMilestone', (title,dueAt,projectId) => workspace.createMilestone(requireUser().id,title,dueAt,projectId));
  handle('workspace:focus', () => workspace.listFocus(requireUser().id));
  handle('workspace:activeTimer', () => workspace.activeTimer(requireUser().id));
  handle('workspace:startTimer', (description,projectId,taskId,note,skill,startedAt) => workspace.startTimer(requireUser().id,description,projectId,taskId,note,skill,startedAt));
  handle('workspace:stopTimer', () => workspace.stopTimer(requireUser().id));
  handle('window:minimize', () => { window.minimize(); });
  handle('window:toggleMaximize', () => { if (window.isMaximized()) window.unmaximize(); else window.maximize(); return window.isMaximized(); });
  handle('window:isMaximized', () => window.isMaximized());
  handle('window:close', () => { window.close(); });
  handle('app:version', () => app.getVersion());
  handle('planner:items', kind => workspace.listPlannerItems(requireUser().id, kind));
  handle('planner:create', item => workspace.createPlannerItem(requireUser().id, item));
  handle('planner:update', (id, changes) => workspace.updatePlannerItem(requireUser().id, id, changes));
  handle('planner:delete', id => workspace.deletePlannerItem(requireUser().id, id));
  handle('workspace:chatMessages', chatId => workspace.listChatMessages(requireUser().id, chatId));
  handle('workspace:addChatMessage', (chatId, content) => workspace.addChatMessage(requireUser().id, chatId, content, 'user'));
  handle('workspace:chats', includeArchived => workspace.listChats(requireUser().id,includeArchived));
  handle('workspace:createChat', (title, category) => { const user = requireUser(); const chatId = workspace.createChat(user.id, title, category); workspace.applyChatDefaults(user.id, chatId); return chatId; });
  handle('workspace:renameChat', (id,title) => workspace.renameChat(requireUser().id,id,title));
  handle('workspace:archiveChat', (id,archived) => workspace.archiveChat(requireUser().id,id,archived));
  handle('workspace:setChatCategory', (id,category) => workspace.setChatCategory(requireUser().id,id,category));
  handle('workspace:deleteChat', id => workspace.deleteChat(requireUser().id,id));

  // ── Agentic Automation
  /* Approval for high-impact agent actions is a native dialog owned by the main process, so a page cannot
     approve on the person's behalf. Test builds may preset the answer (never in packaged builds). */
  async function requestApproval({ title, detail, agent }) {
    if (!app.isPackaged && process.env.PERFLW_TEST_APPROVAL) return process.env.PERFLW_TEST_APPROVAL === 'allow';
    if (!window || window.isDestroyed()) return false;
    const { response } = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0, noLink: true, title: 'Agent approval', message: title, detail: `${agent ? `Agent: ${agent}\n` : ''}${detail}` });
    return response === 1;
  }
  async function pickFolder({ title, envVar, create = false }) {
    if (!app.isPackaged && process.env[envVar]) return process.env[envVar];
    const chosen = await dialog.showOpenDialog(window, { title, properties: ['openDirectory', ...(create ? ['createDirectory', 'promptToCreate'] : [])] });
    return chosen.canceled || chosen.filePaths.length !== 1 ? null : chosen.filePaths[0];
  }
  const actionLog = (scope, entry) => console.log(`[agent-tools] ${scope} ${entry.tool} ${entry.outcome}${entry.detail ? ` ${entry.detail}` : ''}`);
  handle('automation:agents', () => ecosystem.listAgents(requireUser().id));
  handle('automation:saveAgent', agent => { const user = requireUser(); return agent && agent.id ? ecosystem.updateAgentMeta(user.id, agent.id, agent) : ecosystem.createAgent(user.id, agent || {}); });
  handle('automation:deleteAgent', id => ecosystem.deleteAgent(requireUser().id, id));
  handle('automation:models', () => { requireUser(); return agentRuntime.listModels(); });
  handle('agents:get', id => ecosystem.getAgent(requireUser().id, id));
  handle('agents:readFile', (id, rel) => ecosystem.readAgentFile(requireUser().id, id, rel));
  handle('agents:writeFile', (id, rel, content) => ecosystem.writeAgentFile(requireUser().id, id, rel, content));
  handle('agents:deleteFile', (id, rel) => ecosystem.deleteAgentFile(requireUser().id, id, rel));
  handle('agents:updateConfig', (id, patch) => ecosystem.updateAgentConfig(requireUser().id, id, patch));
  handle('agents:duplicate', id => ecosystem.duplicateAgent(requireUser().id, id));
  handle('agents:export', async id => { const user = requireUser(); const dir = await pickFolder({ title: 'Choose an empty folder for the agent export', envVar: 'PERFLW_TEST_EXPORT_DIR', create: true }); return dir ? ecosystem.exportAgent(user.id, id, dir) : null; });
  handle('agents:import', async () => { const user = requireUser(); const dir = await pickFolder({ title: 'Choose an exported agent folder', envVar: 'PERFLW_TEST_IMPORT_DIR' }); return dir ? ecosystem.importAgent(user.id, dir) : null; });
  handle('agents:pickFolder', async () => { requireUser(); return pickFolder({ title: 'Choose a folder this agent may access', envVar: 'PERFLW_TEST_ACCESS_DIR' }); });
  handle('skills:list', () => ecosystem.listSkills(requireUser().id));
  handle('skills:get', id => ecosystem.getSkill(requireUser().id, id));
  handle('skills:create', input => ecosystem.createSkill(requireUser().id, input));
  handle('skills:readFile', (id, rel) => ecosystem.readSkillFile(requireUser().id, id, rel));
  handle('skills:writeFile', (id, rel, content) => ecosystem.writeSkillFile(requireUser().id, id, rel, content));
  handle('skills:deleteFile', (id, rel) => ecosystem.deleteSkillFile(requireUser().id, id, rel));
  handle('skills:setEnabled', (id, enabled) => ecosystem.setSkillEnabled(requireUser().id, id, enabled));
  handle('skills:duplicate', id => ecosystem.duplicateSkill(requireUser().id, id));
  handle('skills:delete', id => ecosystem.deleteSkill(requireUser().id, id));
  handle('skills:export', async id => { const user = requireUser(); const dir = await pickFolder({ title: 'Choose an empty folder for the skill export', envVar: 'PERFLW_TEST_EXPORT_DIR', create: true }); return dir ? (ecosystem.exportSkill(user.id, id, dir), { folder: dir }) : null; });
  handle('skills:import', async () => { const user = requireUser(); const dir = await pickFolder({ title: 'Choose a skill folder (containing SKILL.md)', envVar: 'PERFLW_TEST_IMPORT_DIR' }); return dir ? ecosystem.importSkill(user.id, dir) : null; });
  handle('skills:runScript', request => { const user = requireUser(); return ecosystem.runSkillScript(user.id, request || {}, { requestApproval, log: entry => actionLog('skills-page', entry) }); });
  handle('providers:list', () => ecosystem.listConnections(requireUser().id));
  handle('providers:save', changes => ecosystem.saveConnection(requireUser().id, changes));
  handle('providers:remove', id => ecosystem.removeConnection(requireUser().id, id));
  handle('providers:test', draft => ecosystem.testConnection(requireUser().id, draft || {}));
  handle('providers:models', id => ecosystem.listModels(requireUser().id, id));
  handle('ecosystem:meta', () => { requireUser(); return { permissions: ecosystem.permissions, agentFiles: ecosystem.agentFiles, providerTypes: ecosystem.providerTypes }; });
  handle('automation:workflows', () => workspace.listWorkflows(requireUser().id));
  handle('automation:workflow', id => workspace.getWorkflow(requireUser().id, id));
  handle('automation:createWorkflow', workflow => workspace.createWorkflow(requireUser().id, workflow));
  handle('automation:updateWorkflow', (id, changes) => workspace.updateWorkflow(requireUser().id, id, changes));
  handle('automation:duplicateWorkflow', id => workspace.duplicateWorkflow(requireUser().id, id));
  handle('automation:deleteWorkflow', id => workspace.deleteWorkflow(requireUser().id, id));
  handle('automation:importMarkdown', async () => {
    requireUser();
    let file;
    if (!app.isPackaged && process.env.PERFLW_TEST_MD_PATH) file = process.env.PERFLW_TEST_MD_PATH;
    else {
      const chosen = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
      if (chosen.canceled || chosen.filePaths.length !== 1) return null;
      file = chosen.filePaths[0];
    }
    if (!/\.(md|markdown)$/i.test(file)) throw new Error('Choose a Markdown (.md) file.');
    if (fs.statSync(file).size > AUTOMATION_LIMITS.markdown) throw new Error('Markdown files must be 200 KB or smaller.');
    const content = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    if (content.includes('\u0000')) throw new Error('That file is not a text Markdown file.');
    if (content.length > AUTOMATION_LIMITS.markdown) throw new Error('Markdown files must be 200 KB or smaller.');
    return { filename: path.basename(file).slice(0, 255), content };
  });
  handle('automation:run', async (runId, graph, prompt) => {
    const user = requireUser();
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(runId)) throw new Error('Invalid run.');
    if (activeRun) throw new Error('A workflow is already running. Stop it before starting another.');
    const controller = new AbortController();
    activeRun = { id: runId, controller };
    // Streamed text is batched so a fast model cannot flood the renderer with one message per token.
    const target = window.webContents; const deltas = new Map(); let timer = null;
    const send = event => { if (!target.isDestroyed()) target.send('automation:event', { runId, ...event }); };
    const flush = () => { clearTimeout(timer); timer = null; for (const [nodeId, text] of deltas) send({ type: 'node-delta', nodeId, text }); deltas.clear(); };
    const emit = event => {
      if (event.type === 'node-delta') { deltas.set(event.nodeId, (deltas.get(event.nodeId) || '') + event.text); if (!timer) timer = setTimeout(flush, 70); return; }
      flush(); send(event);
    };
    try {
      // Agent nodes resolve the agent's saved files, provider, skills and permissions at execution time.
      // cache lets an agent that is given identical context and input twice in this run reuse its first answer.
      const cache = new Map();
      const runAgent = args => ecosystem.runAgent(user.id, args, { requestApproval, cache });
      return await runWorkflow({ graph, prompt, agents: ecosystem.listAgents(user.id), runAgent, signal: controller.signal, emit });
    } finally { flush(); activeRun = null; }
  });
  handle('automation:cancel', runId => {
    requireUser();
    if (!activeRun || activeRun.id !== runId) return false;
    activeRun.controller.abort();
    return true;
  });
  // ── Chat sessions: per-conversation settings and the orchestration engine
  const chatKey = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error('Conversation not found.'); return value; };
  handle('chat:session', chatId => chatEngine.describe(requireUser().id, chatKey(chatId)));
  handle('chat:updateSettings', (chatId, patch) => { const user = requireUser(); workspace.updateChatSettings(user.id, chatKey(chatId), patch); return chatEngine.describe(user.id, chatId); });
  handle('chat:resources', () => {
    const user = requireUser();
    return {
      // Connections are the public rows: labels, types and capability flags. Keys never leave the main process.
      providers: ecosystem.listConnections(user.id).map(item => ({ id: item.id, label: item.label, type: item.type, model: item.model, hasKey: item.hasKey, needsKey: item.capabilities.needsKey, local: item.capabilities.local, tools: item.type === 'openai-compatible' ? item.supportsTools : item.capabilities.tools, contextWindow: item.contextWindow || null })),
      agents: ecosystem.listAgents(user.id).map(item => ({ id: item.id, name: item.name, description: item.description, model: item.model, provider: item.provider ? item.provider.label : '' })),
      workflows: workspace.listWorkflows(user.id),
      skills: ecosystem.listSkills(user.id).map(item => ({ id: item.id, name: item.name, description: item.description, enabled: item.enabled, valid: item.valid, triggers: item.triggers })),
      memory: workspace.listMemory(user.id), hasDefaults: Boolean(workspace.getChatDefaults(user.id)), commands: chatEngine.commands
    };
  });
  handle('chat:setDefaults', chatId => { const user = requireUser(); return workspace.setChatDefaults(user.id, chatId === null ? null : workspace.getChatSettings(user.id, chatKey(chatId))); });
  handle('chat:addMemory', text => workspace.addMemory(requireUser().id, text));
  handle('chat:deleteMemory', id => workspace.deleteMemory(requireUser().id, id));
  handle('chat:send', async (chatId, content, options) => {
    const user = requireUser(); chatKey(chatId);
    const opts = options && typeof options === 'object' ? options : {};
    const target = window.webContents; let pending = ''; let timer = null;
    const send = event => { if (!target.isDestroyed()) target.send('chat:event', { chatId, ...event }); };
    // Streamed text is batched so a fast model cannot flood the interface with one message per token.
    const flush = () => { clearTimeout(timer); timer = null; if (pending) { send({ type: 'delta', text: pending }); pending = ''; } };
    const emit = event => {
      if (event.type === 'delta') { pending += event.text; if (!timer) timer = setTimeout(flush, 60); return; }
      flush(); send(event);
    };
    try {
      return await chatEngine.runTurn(user.id, chatId, opts.regenerate ? null : content, {
        emit, requestApproval, regenerate: Boolean(opts.regenerate),
        workflowOnce: typeof opts.workflowOnce === 'string' ? chatKey(opts.workflowOnce) : null
      });
    } finally { flush(); }
  });
  handle('chat:cancel', chatId => { requireUser(); return chatEngine.cancel(chatKey(chatId)); });
  handle('app:copyText', text => { requireUser(); if (typeof text !== 'string' || text.length > 2000000) throw new Error('That text cannot be copied.'); clipboard.writeText(text); return true; });
  /* Links in replies open in the default browser, after a native confirmation that shows the full address. */
  handle('app:openExternal', async url => {
    requireUser();
    let parsed; try { parsed = new URL(String(url)); } catch { throw new Error('That link is not valid.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only web links can be opened.');
    if (!app.isPackaged && process.env.PERFLW_TEST_USER_DATA) return false;
    const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, noLink: true, title: 'Open link', message: 'Open this link in your browser?', detail: parsed.href.slice(0, 400) });
    if (response !== 1) return false;
    await shell.openExternal(parsed.href);
    return true;
  });
  createWindow();
  if (secondInstanceReceived) focusMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { if (workspace) closeOpenSessions({ workspace }); } catch { /* quitting anyway */ } if (activeRun) activeRun.controller.abort(); if (chatEngine) chatEngine.cancelAll(); if (learningFlow) learningFlow.close(); if (workspace) workspace.close(); if (auth) auth.close(); });

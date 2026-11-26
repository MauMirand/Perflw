const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createAutomationStore, createAutomationSchema } = require('./automation/store');
const { createConnectionStore, createConnectionSchema } = require('./automation/connections');
const { createLearningStore } = require('./learning-store');
const { createSessionStore, createSessionSchema } = require('./automation/sessions');
const { migrate } = require('./db-migrate');

const fail = message => { throw new Error(message); };
const now = () => new Date().toISOString();

/* Migration 1 = the schema as it was before versioning (PF-006). It is the former startup bootstrap, unchanged in
   effect and idempotent, so a new file and every older install (with any subset of the old columns) end at the same
   version-1 shape. It runs inside the migration runner's transaction. */
function workspaceSchemaV1(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      created_at TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      target_date TEXT, color TEXT NOT NULL DEFAULT '#8b5cf6', archived_at TEXT, updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS documents_user_order ON documents(user_id,position,created_at,id);
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL, due_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL, title TEXT NOT NULL,
      due_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', skill TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT,
      theme TEXT NOT NULL DEFAULT 'light-blue',
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL, due_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
      category TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      currency TEXT NOT NULL CHECK(length(currency) = 3), occurred_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS finance_accounts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('cash','bank','ewallet','other')),
      currency TEXT NOT NULL DEFAULT 'PHP' CHECK(currency='PHP'), opening_balance_minor INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finance_categories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
      archived_at TEXT, created_at TEXT NOT NULL, UNIQUE(user_id,name,kind)
    );
    CREATE TABLE IF NOT EXISTS finance_transactions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer')),
      date TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), description TEXT NOT NULL,
      category_id TEXT REFERENCES finance_categories(id) ON DELETE SET NULL,
      account_id TEXT REFERENCES finance_accounts(id) ON DELETE RESTRICT,
      source_account_id TEXT REFERENCES finance_accounts(id) ON DELETE RESTRICT,
      destination_account_id TEXT REFERENCES finance_accounts(id) ON DELETE RESTRICT,
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK((kind='transfer' AND account_id IS NULL AND source_account_id IS NOT NULL AND destination_account_id IS NOT NULL AND source_account_id<>destination_account_id AND category_id IS NULL)
        OR (kind IN ('income','expense') AND account_id IS NOT NULL AND source_account_id IS NULL AND destination_account_id IS NULL))
    );
    CREATE TABLE IF NOT EXISTS focus_entries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, description TEXT NOT NULL DEFAULT 'Focus session',
      note TEXT NOT NULL DEFAULT '', skill TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
      started_at TEXT NOT NULL, ended_at TEXT NOT NULL, duration_seconds INTEGER NOT NULL CHECK(duration_seconds > 0)
    );
    CREATE TABLE IF NOT EXISTS active_timers (
      user_id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, description TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', skill TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, segment_started_at TEXT, elapsed_seconds INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
      archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_user_due ON tasks(user_id, due_at);
    CREATE INDEX IF NOT EXISTS events_user_start ON events(user_id, starts_at);
    CREATE INDEX IF NOT EXISTS ledger_user_date ON ledger_entries(user_id, occurred_at);
    CREATE INDEX IF NOT EXISTS finance_accounts_owner ON finance_accounts(user_id, archived_at);
    CREATE INDEX IF NOT EXISTS finance_categories_owner ON finance_categories(user_id, kind, archived_at);
    CREATE INDEX IF NOT EXISTS finance_transactions_owner_date ON finance_transactions(user_id, date, kind);
    CREATE INDEX IF NOT EXISTS finance_transactions_category ON finance_transactions(user_id, category_id, date);
    CREATE INDEX IF NOT EXISTS finance_transactions_account ON finance_transactions(user_id, account_id, date);
    CREATE INDEX IF NOT EXISTS finance_transactions_transfer ON finance_transactions(user_id, source_account_id, destination_account_id, date);
    CREATE INDEX IF NOT EXISTS focus_user_date ON focus_entries(user_id, started_at);
    CREATE INDEX IF NOT EXISTS chats_user_updated ON chat_sessions(user_id, updated_at);`);

  const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map(column => column.name));
  for (const [name, definition] of [['description',"TEXT NOT NULL DEFAULT ''"],['notes',"TEXT NOT NULL DEFAULT ''"],['status',"TEXT NOT NULL DEFAULT 'active'"],['target_date','TEXT'],['color',"TEXT NOT NULL DEFAULT '#8b5cf6'"],['archived_at','TEXT'],['updated_at',"TEXT NOT NULL DEFAULT ''"],['cover','TEXT'],['cover_pos','INTEGER NOT NULL DEFAULT 50'],['icon',"TEXT NOT NULL DEFAULT ''"]])
    if (!projectColumns.has(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
  db.exec("UPDATE projects SET updated_at=created_at WHERE updated_at=''");

  const focusColumns = new Set(db.prepare('PRAGMA table_info(focus_entries)').all().map(column => column.name));
  for (const [name, definition] of [['task_id','TEXT REFERENCES tasks(id) ON DELETE SET NULL'],['description',"TEXT NOT NULL DEFAULT 'Focus session'"],['note',"TEXT NOT NULL DEFAULT ''"],['skill',"TEXT NOT NULL DEFAULT ''"],['source',"TEXT NOT NULL DEFAULT 'manual'"]])
    if (!focusColumns.has(name)) db.exec(`ALTER TABLE focus_entries ADD COLUMN ${name} ${definition}`);

  const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
  if (!taskColumns.has('priority')) db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
  if (!taskColumns.has('image_name')) db.exec('ALTER TABLE tasks ADD COLUMN image_name TEXT');
  if (!taskColumns.has('skills_json')) db.exec("ALTER TABLE tasks ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'");
  for (const [name, definition] of [['icon',"TEXT NOT NULL DEFAULT '☑'"],['theme',"TEXT NOT NULL DEFAULT 'blue'"],['notes',"TEXT NOT NULL DEFAULT ''"],['skill',"TEXT NOT NULL DEFAULT ''"]])
    if (!taskColumns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  const timerColumns = new Set(db.prepare('PRAGMA table_info(active_timers)').all().map(column => column.name));
  if (!timerColumns.has('skill')) db.exec("ALTER TABLE active_timers ADD COLUMN skill TEXT NOT NULL DEFAULT ''");
  const eventColumns = new Set(db.prepare('PRAGMA table_info(events)').all().map(column => column.name));
  if (!eventColumns.has('theme')) db.exec("ALTER TABLE events ADD COLUMN theme TEXT NOT NULL DEFAULT 'light-blue'");
  if (!eventColumns.has('task_id')) db.exec('ALTER TABLE events ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL');
  if (!eventColumns.has('image_name')) db.exec('ALTER TABLE events ADD COLUMN image_name TEXT');
  for (const [name, definition] of [['event_type', "TEXT NOT NULL DEFAULT 'Schedule'"], ['location', "TEXT NOT NULL DEFAULT ''"], ['notes', "TEXT NOT NULL DEFAULT ''"]])
    if (!eventColumns.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
  db.exec('CREATE INDEX IF NOT EXISTS events_user_task ON events(user_id, task_id)');
  db.exec(`CREATE INDEX IF NOT EXISTS tasks_user_project_due ON tasks(user_id,project_id,due_at IS NULL,due_at);
    CREATE INDEX IF NOT EXISTS milestones_user_project_due ON milestones(user_id,project_id,due_at);
    CREATE INDEX IF NOT EXISTS events_user_project_start ON events(user_id,project_id,starts_at);
    CREATE INDEX IF NOT EXISTS focus_user_project_start ON focus_entries(user_id,project_id,started_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS planner_items (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('plan','whim','routine','activity','learning')),
      text TEXT NOT NULL, day TEXT, time TEXT, done_on TEXT, position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS planner_items_user_kind ON planner_items(user_id, kind, day);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(user_id, chat_id, created_at);`);
  // Existing databases: widen the kind CHECK so 'learning' items can be stored. The rebuild runs inside the
  // migration's transaction, so a failure part-way rolls back to the old table instead of leaving a transaction open.
  const plannerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='planner_items'").get() || {}).sql || '';
  if (plannerSql && !plannerSql.includes("'learning'")) {
    db.exec(`ALTER TABLE planner_items RENAME TO planner_items_old;
      CREATE TABLE planner_items (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('plan','whim','routine','activity','learning')),
        text TEXT NOT NULL, day TEXT, time TEXT, done_on TEXT, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO planner_items SELECT id,user_id,kind,text,day,time,done_on,position,created_at,updated_at FROM planner_items_old;
      DROP TABLE planner_items_old;
      CREATE INDEX IF NOT EXISTS planner_items_user_kind ON planner_items(user_id, kind, day);`);
  }
  // Chat categories (Work / Learning / Personal) for the chat page tabs.
  if (!db.prepare("PRAGMA table_info(chat_sessions)").all().some(col => col.name === 'category'))
    db.exec("ALTER TABLE chat_sessions ADD COLUMN category TEXT NOT NULL DEFAULT 'work'");
  // Project pages: one row per block, ordered by position. Linked records (tasks, schedules, milestones) stay in their own tables.
  db.exec(`CREATE TABLE IF NOT EXISTS project_blocks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_blocks_page ON project_blocks(user_id, project_id, position);`);
  // Learning subjects, kept per learning profile (study / personal). Topics, sessions and quizzes come later.
  db.exec(`CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, profile TEXT NOT NULL CHECK (profile IN ('study','personal')),
      name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'major' CHECK (type IN ('major','minor')),
      mastery INTEGER NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 100), minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),
      description TEXT NOT NULL DEFAULT '', image_name TEXT, position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subjects_user_profile ON subjects(user_id, profile, position);
    CREATE TABLE IF NOT EXISTS subject_files (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, stored_name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subject_topics (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('topic','milestone')), level INTEGER NOT NULL DEFAULT 0 CHECK (level IN (0,1)),
      title TEXT NOT NULL, file_id TEXT REFERENCES subject_files(id) ON DELETE SET NULL, position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subject_topics_order ON subject_topics(user_id, subject_id, position);`);
  // Viewer support: a topic's page in its file's PDF view; a file's PDF copy made by Office (Word/PowerPoint uploads).
  if (!db.prepare('PRAGMA table_info(subject_topics)').all().some(col => col.name === 'page'))
    db.exec('ALTER TABLE subject_topics ADD COLUMN page INTEGER');
  // Each column is checked on its own: an install can have preview_name without preview_status.
  const fileColumns = new Set(db.prepare('PRAGMA table_info(subject_files)').all().map(col => col.name));
  if (!fileColumns.has('preview_name')) db.exec('ALTER TABLE subject_files ADD COLUMN preview_name TEXT');
  if (!fileColumns.has('preview_status')) db.exec("ALTER TABLE subject_files ADD COLUMN preview_status TEXT NOT NULL DEFAULT 'none'");
  // Tables owned by the automation modules share this database (same order as their former constructors ran).
  createAutomationSchema(db);
  createSessionSchema(db);
  createConnectionSchema(db);
}

const WORKSPACE_MIGRATIONS = Object.freeze([{ version: 1, up: workspaceSchemaV1 }, { version: 2, up: require('./learning-schema').learningSchemaV2 }]);

function createWorkspace(root, { migrations = WORKSPACE_MIGRATIONS } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'workspace.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON'); // per connection; a no-op inside a transaction, so set before migrating
    migrate(db, { name: 'workspace', migrations, backup: file });
  } catch (error) { db.close(); throw error; }
  const topicModel = require('./topic-model');
  const automation = createAutomationStore(db);
  const sessions = createSessionStore(db);

  function text(value, label, max = 180) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} must be 1–${max} characters.`);
    return value.trim();
  }
  function date(value, label, optional = false) {
    if (optional && (value === null || value === undefined || value === '')) return null;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`Enter a valid ${label}.`);
    return new Date(value).toISOString();
  }
  function id() { return randomUUID(); }
  function insert(table, columns, values) {
    const placeholders = columns.map(() => '?').join(',');
    return db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`).run(...values);
  }
  function ownedProject(userId, projectId) {
    if (projectId == null) return null;
    const project = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
    if (!project) fail('Choose a project in this account.');
    return project.id;
  }
  function createProject(userId, name, details = {}) {
    const projectId = id();
    const timestamp=now();
    insert('projects', ['id','user_id','name','description','notes','status','target_date','color','created_at','updated_at'],
      [projectId,userId,text(name,'Project name'),projectDescription(details.description),projectDescription(details.notes),projectStatus(details.status||'active'),date(details.targetDate,'target date',true),projectColor(details.color),timestamp,timestamp]);
    return projectId;
  }
  function projectDescription(value='') { if(typeof value!=='string'||value.length>2000)fail('Description must be 2,000 characters or fewer.'); return value.trim(); }
  function projectStatus(value) { if(!['planned','active','on-hold','completed','archived'].includes(value))fail('Choose a valid project status.'); return value; }
  function projectColor(value='#8b5cf6') { if(typeof value!=='string'||!/^#[0-9a-fA-F]{6}$/.test(value))fail('Choose a valid project color.'); return value.toLowerCase(); }
  function updateProject(userId, projectId, details) {
    const status=projectStatus(details.status),timestamp=now();
    const result=db.prepare("UPDATE projects SET name=?,description=?,notes=?,status=?,target_date=?,color=?,archived_at=CASE WHEN ?='archived' THEN COALESCE(archived_at,?) ELSE NULL END,updated_at=? WHERE id=? AND user_id=?")
      .run(text(details.name,'Project name'),projectDescription(details.description),projectDescription(details.notes),status,date(details.targetDate,'target date',true),projectColor(details.color),status,timestamp,timestamp,projectId,userId);
    if(!result.changes)fail('Project not found.');
  }
  function archiveProject(userId, projectId, archived=true) {
    const stamp=archived?now():null;
    const result=db.prepare("UPDATE projects SET status=?,archived_at=?,updated_at=? WHERE id=? AND user_id=?")
      .run(archived?'archived':'active',stamp,now(),projectId,userId);
    if(!result.changes)fail('Project not found.');
  }
  function deleteProject(userId, projectId) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const project=ownedProject(userId,projectId);
      db.prepare('UPDATE tasks SET project_id=NULL WHERE user_id=? AND project_id=?').run(userId,project);
      db.prepare('UPDATE goals SET project_id=NULL WHERE user_id=? AND project_id=?').run(userId,project);
      db.prepare('UPDATE events SET project_id=NULL WHERE user_id=? AND project_id=?').run(userId,project);
      db.prepare('UPDATE milestones SET project_id=NULL WHERE user_id=? AND project_id=?').run(userId,project);
      db.prepare('UPDATE focus_entries SET project_id=NULL WHERE user_id=? AND project_id=?').run(userId,project);
      db.prepare('UPDATE active_timers SET project_id=NULL WHERE user_id=? AND project_id=?').run(userId,project);
      db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(project,userId);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  // ── project pages
  const BLOCK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const BLOCK_TYPE_RE = /^[a-z][a-z0-9-]{0,39}$/;
  function pageBlocks(list) {
    if (!Array.isArray(list) || list.length > 2000) fail('A page can hold up to 2,000 blocks.');
    const seen = new Set();
    return list.map(block => {
      if (!block || typeof block !== 'object') fail('Invalid block.');
      if (typeof block.id !== 'string' || !BLOCK_ID_RE.test(block.id) || seen.has(block.id)) fail('Invalid block id.');
      seen.add(block.id);
      if (typeof block.type !== 'string' || !BLOCK_TYPE_RE.test(block.type)) fail('Invalid block type.');
      const body = block.text == null ? '' : block.text;
      if (typeof body !== 'string' || body.length > 20000) fail('A block can hold up to 20,000 characters.');
      const data = block.data == null ? {} : block.data;
      if (typeof data !== 'object' || Array.isArray(data)) fail('Invalid block data.');
      const json = JSON.stringify(data);
      if (json.length > 100000) fail('A block holds too much data.');
      return { id: block.id, type: block.type, text: body, data: json };
    });
  }
  function getProjectPage(userId, projectId) {
    const project = db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(projectId, userId);
    if (!project) fail('Project not found.');
    const blocks = db.prepare('SELECT id,type,text,data FROM project_blocks WHERE user_id=? AND project_id=? ORDER BY position,created_at,id').all(userId, projectId)
      .map(row => { let data = {}; try { data = JSON.parse(row.data) || {}; } catch { /* keep the block, drop unreadable data */ } return { id: row.id, type: row.type, text: row.text, data }; });
    return { project, blocks, ...listProjectData(userId, projectId) };
  }
  /* Saves title, metadata and the whole ordered block list in one transaction, so a page is never half-written. */
  function saveProjectPage(userId, projectId, page) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) fail('Invalid page.');
    const blocks = pageBlocks(page.blocks);
    const meta = page.project;
    if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) fail('Invalid project details.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(projectId, userId);
      if (!current) fail('Project not found.');
      const pick = (key, fallback) => (meta && meta[key] !== undefined ? meta[key] : fallback);
      updateProject(userId, projectId, { name: pick('name', current.name), description: pick('description', current.description), notes: current.notes,
        status: pick('status', current.status), targetDate: pick('targetDate', current.target_date), color: pick('color', current.color) });
      // Page look: cover (null = the default gradient, 'none', a built-in gradient 'g:<name>' or a stored image file), vertical cover position, icon.
      if (meta && (meta.cover !== undefined || meta.coverPos !== undefined || meta.icon !== undefined)) {
        const cover = meta.cover === undefined ? current.cover : meta.cover;
        if (cover !== null && !(typeof cover === 'string' && (cover === 'none' || /^g:(aurora|dusk|tide|ember|slate)$/.test(cover) || /^[a-f0-9]{32}\.(png|jpg|webp)$/.test(cover)))) fail('Choose a valid cover.');
        const pos = meta.coverPos === undefined ? current.cover_pos : meta.coverPos;
        if (typeof pos !== 'number' || !Number.isFinite(pos)) fail('Invalid cover position.');
        const icon = meta.icon === undefined ? current.icon : meta.icon;
        if (typeof icon !== 'string' || icon.length > 16 || /[\u0000-\u001f\u007f<>]/.test(icon)) fail('Invalid page icon.');
        db.prepare('UPDATE projects SET cover=?,cover_pos=?,icon=? WHERE id=? AND user_id=?').run(cover, Math.max(0, Math.min(100, Math.round(pos))), icon.trim(), projectId, userId);
      }
      const created = new Map(db.prepare('SELECT id,created_at FROM project_blocks WHERE user_id=? AND project_id=?').all(userId, projectId).map(row => [row.id, row.created_at]));
      db.prepare('DELETE FROM project_blocks WHERE user_id=? AND project_id=?').run(userId, projectId);
      const taken = db.prepare('SELECT 1 FROM project_blocks WHERE id=?');
      const timestamp = now();
      blocks.forEach((block, position) => {
        if (taken.get(block.id)) fail('A block on this page belongs to another page.');
        insert('project_blocks', ['id','user_id','project_id','type','text','data','position','created_at','updated_at'],
          [block.id, userId, projectId, block.type, block.text, block.data, position, created.get(block.id) || timestamp, timestamp]);
      });
      db.exec('COMMIT');
      return { updatedAt: timestamp, blocks: blocks.length };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  /* Projects used to be plain planner notes (kind 'whim'). Each one becomes a real project with the same id, name and date. */
  function adoptLegacyProjects(userId) {
    const notes = db.prepare("SELECT * FROM planner_items WHERE user_id=? AND kind='whim' ORDER BY created_at").all(userId);
    if (!notes.length) return 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const note of notes) {
        if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(note.id))
          insert('projects', ['id','user_id','name','description','created_at','updated_at'],
            [note.id, userId, note.text.slice(0, 180), note.text.length > 180 ? note.text : '', note.created_at, note.updated_at || note.created_at]);
        db.prepare('DELETE FROM planner_items WHERE id=? AND user_id=?').run(note.id, userId);
      }
      db.exec('COMMIT');
      return notes.length;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function deleteMilestone(userId, milestoneId) {
    const result = db.prepare('DELETE FROM milestones WHERE id=? AND user_id=?').run(milestoneId, userId);
    if (!result.changes) fail('Milestone not found.');
  }
  // ── Learning subjects
  const SUBJECT_PROFILES = ['study', 'personal'];
  const SUBJECT_TYPES = ['major', 'minor'];
  function subjectRow(row) {
    return { id: row.id, profile: row.profile, name: row.name, type: row.type, mastery: row.mastery, minutes: row.minutes,
      description: row.description, imageName: row.image_name, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function subjectProfile(value) {
    if (!SUBJECT_PROFILES.includes(value)) fail('Choose the study or personal profile.');
    return value;
  }
  function subjectFields(details, current = null) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) fail('Subject details must be an object.');
    const pick = (key, fallback) => (details[key] === undefined ? fallback : details[key]);
    const name = text(pick('name', current && current.name), 'Subject name', 120);
    const type = pick('type', current ? current.type : 'major');
    if (!SUBJECT_TYPES.includes(type)) fail('Subject type must be Major or Minor.');
    const mastery = pick('mastery', current ? current.mastery : 0);
    if (!Number.isInteger(mastery) || mastery < 0 || mastery > 100) fail('Mastery must be a whole number from 0 to 100.');
    const minutes = pick('minutes', current ? current.minutes : 0);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1000000) fail('Time spent must be a whole number of minutes.');
    const description = pick('description', current ? current.description : '');
    if (typeof description !== 'string' || description.length > 2000) fail('Description must be 2000 characters or fewer.');
    const imageName = pick('imageName', current ? current.image_name : null);
    if (imageName !== null && typeof imageName !== 'string') fail('Choose a valid subject image.');
    return { name, type, mastery, minutes, description: description.trim(), imageName };
  }
  function listSubjects(userId, profile) {
    return db.prepare('SELECT * FROM subjects WHERE user_id=? AND profile=? ORDER BY position,created_at,id').all(userId, subjectProfile(profile)).map(subjectRow);
  }
  function getSubject(userId, subjectId) {
    const row = db.prepare('SELECT * FROM subjects WHERE id=? AND user_id=?').get(subjectId, userId);
    if (!row) fail('Subject not found.');
    return subjectRow(row);
  }
  function createSubject(userId, profile, details) {
    const subjectId = id(), timestamp = now(), clean = subjectFields(details);
    const kind = subjectProfile(profile);
    const position = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM subjects WHERE user_id=? AND profile=?').get(userId, kind).next;
    insert('subjects', ['id','user_id','profile','name','type','mastery','minutes','description','image_name','position','created_at','updated_at'],
      [subjectId, userId, kind, clean.name, clean.type, clean.mastery, clean.minutes, clean.description, clean.imageName, position, timestamp, timestamp]);
    return getSubject(userId, subjectId);
  }
  function updateSubject(userId, subjectId, details) {
    const current = db.prepare('SELECT * FROM subjects WHERE id=? AND user_id=?').get(subjectId, userId);
    if (!current) fail('Subject not found.');
    const clean = subjectFields(details, current);
    db.prepare('UPDATE subjects SET name=?,type=?,mastery=?,minutes=?,description=?,image_name=?,updated_at=? WHERE id=? AND user_id=?')
      .run(clean.name, clean.type, clean.mastery, clean.minutes, clean.description, clean.imageName, now(), subjectId, userId);
    return getSubject(userId, subjectId);
  }
  /* Returns the stored names of the subject's uploaded files so the caller can remove them from disk. */
  function deleteSubject(userId, subjectId) {
    const stored = db.prepare('SELECT stored_name,preview_name FROM subject_files WHERE subject_id=? AND user_id=?').all(subjectId, userId)
      .flatMap(r => [r.stored_name, r.preview_name].filter(Boolean));
    const result = db.prepare('DELETE FROM subjects WHERE id=? AND user_id=?').run(subjectId, userId);
    if (!result.changes) fail('Subject not found.');
    return stored;
  }

  // ── Subject topics (order, levels and numbering rules live in topic-model.js)
  function ownedSubject(userId, subjectId) {
    if (!db.prepare('SELECT 1 FROM subjects WHERE id=? AND user_id=?').get(subjectId, userId)) fail('Subject not found.');
  }
  function topicTitle(value, label = 'Topic title') {
    const title = topicModel.cleanTitle(typeof value === 'string' ? value : '');
    if (!title) fail(`${label} must be 1–${topicModel.LIMITS.title} characters.`);
    return title;
  }
  function topicRows(userId, subjectId) {
    return db.prepare('SELECT id,kind,level,title,file_id,page FROM subject_topics WHERE user_id=? AND subject_id=? ORDER BY position,created_at,id')
      .all(userId, subjectId).map(r => ({ id: r.id, kind: r.kind, level: r.level, title: r.title, fileId: r.file_id, page: r.page }));
  }
  function writeOrder(userId, rows) {
    const update = db.prepare('UPDATE subject_topics SET position=?,level=?,updated_at=? WHERE id=? AND user_id=?');
    const stamp = now();
    topicModel.normalize(rows).forEach((row, position) => update.run(position, row.level, stamp, row.id, userId));
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = work(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function listTopics(userId, subjectId) {
    ownedSubject(userId, subjectId);
    const rows = topicRows(userId, subjectId);
    const files = db.prepare('SELECT id,name,type,size,created_at,preview_status FROM subject_files WHERE user_id=? AND subject_id=? ORDER BY created_at,id').all(userId, subjectId)
      .map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size, createdAt: f.created_at, preview: f.preview_status, topics: rows.filter(r => r.fileId === f.id).length }));
    return { rows, files };
  }
  function insertTopics(userId, subjectId, items, fileId = null) {
    const existing = topicRows(userId, subjectId);
    if (existing.length + items.length > topicModel.LIMITS.rows) fail(`A subject can hold up to ${topicModel.LIMITS.rows} topics and milestones.`);
    const stamp = now(); const ids = [];
    for (const item of items) {
      const topicId = id(); ids.push(topicId);
      insert('subject_topics', ['id','user_id','subject_id','kind','level','title','file_id','page','position','created_at','updated_at'],
        [topicId, userId, subjectId, item.kind, item.level, item.title, fileId, Number.isInteger(item.page) && item.page > 0 ? item.page : null, existing.length + ids.length, stamp, stamp]);
    }
    writeOrder(userId, topicRows(userId, subjectId));
    return ids;
  }
  function addTopic(userId, subjectId, details) {
    ownedSubject(userId, subjectId);
    if (!details || typeof details !== 'object') fail('Topic details must be an object.');
    const kind = details.kind === 'milestone' ? 'milestone' : 'topic';
    const item = { kind, title: topicTitle(details.title, kind === 'milestone' ? 'Milestone name' : 'Topic title'), level: kind === 'topic' && details.level === 1 ? 1 : 0 };
    const [topicId] = transaction(() => insertTopics(userId, subjectId, [item]));
    return { ...listTopics(userId, subjectId), added: [topicId] };
  }
  /* An uploaded file: one file row plus its outline as topics. With no outline, the file becomes one topic named after it. */
  function importTopics(userId, subjectId, file, outline) {
    ownedSubject(userId, subjectId);
    if (!file || typeof file.name !== 'string' || typeof file.storedName !== 'string') fail('Invalid file.');
    const name = topicTitle(file.name, 'File name');
    const items = (Array.isArray(outline) && outline.length ? outline : [{ title: name.replace(/\.[^.]+$/, '') || name, level: 0 }])
      .map(item => ({ kind: 'topic', level: item.level === 1 ? 1 : 0, title: topicTitle(item.title), page: item.page }));
    const fileId = id();
    const added = transaction(() => {
      insert('subject_files', ['id','user_id','subject_id','name','stored_name','type','size','text','created_at'],
        [fileId, userId, subjectId, name, file.storedName, String(file.type || ''), Number(file.size) || 0, String(file.text || ''), now()]);
      return insertTopics(userId, subjectId, items, fileId);
    });
    return { ...listTopics(userId, subjectId), added, fileId };
  }
  function renameTopic(userId, topicId, title) {
    const row = db.prepare('SELECT kind,subject_id FROM subject_topics WHERE id=? AND user_id=?').get(topicId, userId);
    if (!row) fail('Topic not found.');
    db.prepare('UPDATE subject_topics SET title=?,updated_at=? WHERE id=? AND user_id=?').run(topicTitle(title, row.kind === 'milestone' ? 'Milestone name' : 'Topic title'), now(), topicId, userId);
    return listTopics(userId, row.subject_id);
  }
  /* The whole list in its new order, each with its level: [{ id, level }]. Must name every row exactly once. */
  function saveTopicOrder(userId, subjectId, order) {
    ownedSubject(userId, subjectId);
    const rows = topicRows(userId, subjectId);
    if (!Array.isArray(order) || order.length !== rows.length || new Set(order.map(o => o && o.id)).size !== rows.length || order.some(o => !rows.some(r => r.id === o.id)))
      fail('Topic order must include every topic in this subject.');
    const byId = new Map(rows.map(r => [r.id, r]));
    transaction(() => writeOrder(userId, order.map(o => ({ ...byId.get(o.id), level: o.level === 1 ? 1 : 0 }))));
    return listTopics(userId, subjectId);
  }
  /* Deletes rows; files left with no topics are deleted too and their stored names returned for removal from disk. */
  function deleteTopics(userId, subjectId, ids) {
    ownedSubject(userId, subjectId);
    if (!Array.isArray(ids) || !ids.length || ids.some(x => typeof x !== 'string')) fail('Choose topics to delete.');
    const removed = transaction(() => {
      const del = db.prepare('DELETE FROM subject_topics WHERE id=? AND user_id=? AND subject_id=?');
      for (const topicId of ids) if (!del.run(topicId, userId, subjectId).changes) fail('Topic not found.');
      const orphans = db.prepare('SELECT id,stored_name,preview_name FROM subject_files f WHERE user_id=? AND subject_id=? AND NOT EXISTS (SELECT 1 FROM subject_topics t WHERE t.file_id=f.id)').all(userId, subjectId);
      const drop = db.prepare('DELETE FROM subject_files WHERE id=? AND user_id=?');
      for (const f of orphans) drop.run(f.id, userId);
      writeOrder(userId, topicRows(userId, subjectId));
      return orphans.flatMap(f => [f.stored_name, f.preview_name].filter(Boolean));
    });
    return { ...listTopics(userId, subjectId), removedFiles: removed };
  }
  /* What the viewer needs to show a file: its stored names, type, preview state and kept text. */
  function topicFile(userId, fileId) {
    const row = db.prepare('SELECT id,subject_id,name,type,stored_name,preview_name,preview_status,text FROM subject_files WHERE id=? AND user_id=?').get(fileId, userId);
    if (!row) fail('File not found.');
    return { id: row.id, subjectId: row.subject_id, name: row.name, type: row.type, storedName: row.stored_name, previewName: row.preview_name, preview: row.preview_status, text: row.text };
  }
  /* preview: 'none' | 'pending' | 'ready' | 'failed'. previewName is the PDF copy on disk once ready. */
  function setFilePreview(userId, fileId, preview, previewName = null) {
    if (!['none', 'pending', 'ready', 'failed'].includes(preview)) fail('Invalid preview state.');
    db.prepare('UPDATE subject_files SET preview_status=?,preview_name=? WHERE id=? AND user_id=?').run(preview, previewName, fileId, userId);
  }
  /* After Office makes the PDF copy of a Word file: give each of the file's topics the page of the PDF bookmark
     with the same title, matching in order so repeated titles go to successive bookmarks. */
  function setTopicPagesFromOutline(userId, fileId, outline) {
    const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const marks = (Array.isArray(outline) ? outline : []).filter(o => Number.isInteger(o.page)).map(o => ({ key: norm(o.title), page: o.page, used: false }));
    const topics = db.prepare("SELECT id,title FROM subject_topics WHERE file_id=? AND user_id=? AND kind='topic' ORDER BY created_at,rowid").all(fileId, userId);
    const update = db.prepare('UPDATE subject_topics SET page=? WHERE id=? AND user_id=?');
    let matched = 0;
    transaction(() => {
      for (const t of topics) {
        const hit = marks.find(m => !m.used && m.key === norm(t.title));
        if (hit) { hit.used = true; update.run(hit.page, t.id, userId); matched++; }
      }
    });
    return matched;
  }
  /* The readable text kept from an uploaded file (for agents). */
  function topicFileText(userId, fileId) {
    const row = db.prepare('SELECT name,type,text FROM subject_files WHERE id=? AND user_id=?').get(fileId, userId);
    if (!row) fail('File not found.');
    return row;
  }
  function createGoal(userId, title, dueAt, projectId = null) {
    const goalId = id();
    insert('goals', ['id','user_id','project_id','title','due_at','created_at'],
      [goalId,userId,ownedProject(userId,projectId),text(title,'Goal title'),date(dueAt,'date',true),now()]);
    return goalId;
  }
  function taskTheme(value = 'blue') {
    if (!['blue','gold','red','green','violet'].includes(value)) fail('Choose a valid task theme.');
    return value;
  }
  function taskIcon(value = '☑') {
    if (!['☑','✦','⌂','♡','↗'].includes(value)) fail('Choose a valid task icon.');
    return value;
  }
  function optionalText(value, label, max = 2000) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || value.length > max) fail(`${label} must be at most ${max} characters.`);
    return value.trim();
  }
  function createTask(userId, title, dueAt, projectId = null, goalId = null, priority = 'normal', icon = '☑', theme = 'blue', notes = '', skill = '', imageName = null, skills = undefined, schedule = null) {
    let linkedProject=ownedProject(userId,projectId);
    if (goalId != null) {
      const goal=db.prepare('SELECT id,project_id FROM goals WHERE id = ? AND user_id = ?').get(goalId,userId);
      if (!goal) fail('Choose a goal in this account.');
      if (linkedProject && goal.project_id && linkedProject!==goal.project_id) fail('Task and goal must belong to the same project.');
      if (!linkedProject) linkedProject=goal.project_id;
    }
    const taskId = id();
    db.exec('BEGIN IMMEDIATE');
    try {
      insert('tasks', ['id','user_id','project_id','goal_id','title','due_at','created_at','priority','icon','theme','notes','skill','image_name','skills_json'],
        [taskId,userId,linkedProject,goalId,text(title,'Task title'),date(dueAt,'date',true),now(),taskPriority(priority),taskIcon(icon),taskTheme(theme),optionalText(notes,'Task notes'),optionalText(skill,'Skill',80),imageName,taskSkills(skills,skill)]);
      if (schedule) {
        if (!schedule.startsAt || !schedule.endsAt) fail('Choose both a start and end time for the schedule.');
        createEvent(userId,title,schedule.startsAt,schedule.endsAt,linkedProject,taskId,'light-blue','Task schedule');
      }
      db.exec('COMMIT');
      return taskId;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function taskSkills(skills, fallback = '') {
    if (skills === undefined) skills = fallback ? [fallback] : [];
    if (!Array.isArray(skills) || skills.length > 30) fail('Choose up to 30 skills.');
    return JSON.stringify([...new Set(skills.map(value => optionalText(value,'Skill',80)).filter(Boolean))]);
  }
  function taskPriority(value) {
    if (!['low','normal','high'].includes(value)) fail('Choose a valid task priority.');
    return value;
  }
  function eventTheme(value = 'light-blue') {
    if (!['light-blue','gold','maroon-red'].includes(value)) fail('Choose a valid schedule theme.');
    return value;
  }
  function scheduleType(value = 'Event') {
    if (!['Event','Task schedule'].includes(value)) fail('Choose Event or Task schedule.');
    return value;
  }
  function createEvent(userId, title, startsAt, endsAt, projectId = null, taskId = null, theme = 'light-blue', type = 'Event', location = '', notes = '', imageName = null) {
    const start = date(startsAt,'start date');
    const end = date(endsAt,'end date',true);
    if (end && end <= start) fail('Event end must be after its start.');
    const project = projectForTask(userId,projectId,taskId);
    const eventId = id();
    insert('events', ['id','user_id','project_id','title','starts_at','ends_at','task_id','theme','event_type','location','notes','image_name'],
      [eventId,userId,project,text(title,'Schedule name'),start,end,ownedTask(userId,taskId,project),eventTheme(theme),scheduleType(type),optionalText(location,'Location',180),optionalText(notes,'Schedule notes'),imageName]);
    return eventId;
  }
  function updateTask(userId, taskId, { title, dueAt, priority, projectId, goalId, icon, theme, notes, skill, imageName, skills, schedule }) {
    const current=db.prepare('SELECT title,project_id,goal_id,icon,theme,notes,skill,image_name,skills_json FROM tasks WHERE id=? AND user_id=?').get(taskId,userId);
    if(!current)fail('Task not found.');
    let nextProject=projectId===undefined?current.project_id:ownedProject(userId,projectId);
    const nextGoalId=goalId===undefined?current.goal_id:goalId;
    const goal=nextGoalId?db.prepare('SELECT project_id FROM goals WHERE id=? AND user_id=?').get(nextGoalId,userId):null;
    if(nextGoalId&&!goal)fail('Choose a goal in this account.');
    if(goal?.project_id){if(nextProject&&goal.project_id!==nextProject)fail('Task and goal must belong to the same project.');if(!nextProject)nextProject=goal.project_id;}
    db.exec('BEGIN IMMEDIATE');
    try {
      const nextSkill=optionalText(skill ?? current.skill,'Skill',80);
      const result = db.prepare('UPDATE tasks SET title=?,due_at=?,priority=?,project_id=?,goal_id=?,icon=?,theme=?,notes=?,skill=?,image_name=?,skills_json=? WHERE id=? AND user_id=?')
        .run(text(title,'Task title'),date(dueAt,'date',true),taskPriority(priority),nextProject,nextGoalId,taskIcon(icon ?? current.icon),taskTheme(theme ?? current.theme),optionalText(notes ?? current.notes,'Task notes'),nextSkill,imageName===undefined?current.image_name:imageName,skills===undefined?current.skills_json:taskSkills(skills),taskId,userId);
      if (!result.changes) fail('Task not found.');
      db.prepare("UPDATE events SET title=? WHERE user_id=? AND task_id=? AND event_type='Task schedule' AND title=?").run(text(title,'Task title'),userId,taskId,current.title);
      db.prepare('UPDATE events SET project_id=? WHERE user_id=? AND task_id=?').run(nextProject,userId,taskId);
      if (schedule !== undefined) {
        if (!schedule || typeof schedule !== 'object') fail('Invalid schedule.');
        if (schedule.id && !db.prepare("SELECT id FROM events WHERE id=? AND user_id=? AND task_id=? AND event_type='Task schedule'").get(schedule.id,userId,taskId)) fail('Task schedule not found.');
        if (!schedule.startsAt && !schedule.endsAt) {
          if (schedule.id) db.prepare('DELETE FROM events WHERE id=? AND user_id=? AND task_id=?').run(schedule.id,userId,taskId);
        } else {
          if (!schedule.startsAt || !schedule.endsAt) fail('Choose both a start and end time for the schedule.');
          const start=date(schedule.startsAt,'start date'),end=date(schedule.endsAt,'end date');
          if (end <= start) fail('Event end must be after its start.');
          if (schedule.id) db.prepare('UPDATE events SET starts_at=?,ends_at=? WHERE id=? AND user_id=? AND task_id=?').run(start,end,schedule.id,userId,taskId);
          else createEvent(userId,title,start,end,nextProject,taskId,'light-blue','Task schedule');
        }
      }
      db.prepare('UPDATE active_timers SET project_id=? WHERE user_id=? AND task_id=?').run(nextProject,userId,taskId);
      db.prepare('UPDATE active_timers SET skill=? WHERE user_id=? AND task_id=?').run(nextSkill,userId,taskId);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  function deleteTask(userId, taskId, eventPolicy) {
    if (!['keep-events','delete-events','delete-task-schedules'].includes(eventPolicy)) fail('Choose what to do with scheduled events.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const task = db.prepare('SELECT id FROM tasks WHERE id=? AND user_id=?').get(taskId,userId);
      if (!task) fail('Task not found.');
      if (eventPolicy === 'delete-events') db.prepare('DELETE FROM events WHERE user_id=? AND task_id=?').run(userId,taskId);
      else {
        if (eventPolicy === 'delete-task-schedules') db.prepare("DELETE FROM events WHERE user_id=? AND task_id=? AND event_type='Task schedule'").run(userId,taskId);
        db.prepare('UPDATE events SET task_id=NULL WHERE user_id=? AND task_id=?').run(userId,taskId);
      }
      const result = db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(taskId,userId);
      if (!result.changes) fail('Task not found.');
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  function updateEvent(userId, eventId, { title, startsAt, endsAt, projectId = null, taskId, theme, eventType, location, notes, imageName }) {
    const start=date(startsAt,'start date');
    const end=date(endsAt,'end date',true);
    if (end && end <= start) fail('Event end must be after its start.');
    const existing=db.prepare('SELECT task_id,theme,event_type,location,notes,image_name FROM events WHERE id=? AND user_id=?').get(eventId,userId);
    if (!existing) fail('Event not found.');
    const nextTask=taskId===undefined?existing.task_id:taskId;
    const project=projectForTask(userId,projectId,nextTask);
    const task=ownedTask(userId,nextTask,project);
    const result=db.prepare('UPDATE events SET title=?,starts_at=?,ends_at=?,project_id=?,task_id=?,theme=?,event_type=?,location=?,notes=?,image_name=? WHERE id=? AND user_id=?')
      .run(text(title,'Schedule name'),start,end,project,task,theme===undefined?existing.theme:eventTheme(theme),eventType===undefined?existing.event_type:scheduleType(eventType),location===undefined?existing.location:optionalText(location,'Location',180),notes===undefined?existing.notes:optionalText(notes,'Schedule notes'),imageName===undefined?existing.image_name:imageName,eventId,userId);
    if (!result.changes) fail('Event not found.');
  }
  function deleteEvent(userId,eventId) {
    const result=db.prepare('DELETE FROM events WHERE id=? AND user_id=?').run(eventId,userId);
    if (!result.changes) fail('Event not found.');
  }
  function createMilestone(userId, title, dueAt, projectId = null) {
    const milestoneId = id();
    insert('milestones', ['id','user_id','project_id','title','due_at'],
      [milestoneId,userId,ownedProject(userId,projectId),text(title,'Milestone title'),date(dueAt,'date')]);
    return milestoneId;
  }
  function ownedTask(userId, taskId, projectId = null) {
    if (taskId == null) return null;
    const task = db.prepare('SELECT id,project_id FROM tasks WHERE id=? AND user_id=?').get(taskId,userId);
    if (!task) fail('Choose a task in this account.');
    if (projectId && task.project_id && projectId !== task.project_id) fail('Task and project must match.');
    return task.id;
  }
  function projectForTask(userId, projectId, taskId) {
    const project=ownedProject(userId,projectId);
    if(taskId==null) return project;
    const task=db.prepare('SELECT project_id FROM tasks WHERE id=? AND user_id=?').get(taskId,userId);
    if(!task) fail('Choose a task in this account.');
    if(project&&task.project_id&&project!==task.project_id) fail('Task and project must match.');
    return project||task.project_id||null;
  }
  function linkedSkill(userId,taskId,skill='') {
    const task=taskId?db.prepare('SELECT skill FROM tasks WHERE id=? AND user_id=?').get(taskId,userId):null;
    if(taskId&&!task) fail('Choose a task in this account.');
    return optionalText(skill||task?.skill||'','Skill',80);
  }
  function saveFocusEntry(userId, { startedAt, endedAt, durationSeconds, projectId = null, taskId = null, description = 'Focus session', note = '', skill = '', source = 'manual' }) {
    const start = date(startedAt,'start date');
    const end = date(endedAt,'end date');
    const seconds = durationSeconds ?? Math.floor((Date.parse(end) - Date.parse(start)) / 1000);
    if (!Number.isSafeInteger(seconds) || seconds < 1) fail('Focus time must be longer than zero.');
    if (Date.parse(end) > Date.now()) fail('Focus time cannot end in the future.');
    const entryId = id();
    const project = projectForTask(userId,projectId,taskId);
    insert('focus_entries', ['id','user_id','project_id','task_id','description','note','skill','source','started_at','ended_at','duration_seconds'],
      [entryId,userId,project,ownedTask(userId,taskId,project),text(description,'Description'),typeof note === 'string' ? note.trim().slice(0,500) : '',linkedSkill(userId,taskId,skill),source,start,end,seconds]);
    return entryId;
  }
  function createFocusEntry(userId, startedAt, endedAt, projectId = null, description = 'Focus session', taskId = null, note = '') {
    const start=date(startedAt,'start date');
    const active=activeTimer(userId);
    if (active && new Date(start).toDateString()===new Date().toDateString()) fail('Stop and save today’s timer before logging manual time.');
    return saveFocusEntry(userId,{startedAt:start,endedAt,projectId,description,taskId,note,source:'manual'});
  }
  function createManualFocusEntry(userId, description, day, durationMinutes, projectId = null, taskId = null, note = '', startTime = '00:00', skill = '') {
    if (!Number.isSafeInteger(durationMinutes) || durationMinutes<1 || durationMinutes>1440) fail('Duration must be between 1 and 1,440 minutes.');
    const dateValue=date(day,'date');
    const active=activeTimer(userId);
    if (active && new Date(dateValue).toDateString()===new Date().toDateString()) fail('Stop and save today’s timer before logging manual time.');
    if(typeof startTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime))fail('Enter a valid start time.');
    const parts=new Date(dateValue);const start=new Date(parts.getFullYear(),parts.getMonth(),parts.getDate(),Number(startTime.slice(0,2)),Number(startTime.slice(3,5)));
    const end=new Date(start.getTime()+durationMinutes*60000);
    if(end.getTime()>Date.now())fail('Focus time cannot end in the future.');
    return saveFocusEntry(userId,{startedAt:start.toISOString(),endedAt:end.toISOString(),projectId,description,taskId,note,skill,source:'manual'});
  }
  function editFocusEntry(userId, entryId, description, note, projectId, taskId, skill, startedAt, endedAt) {
    const project=projectForTask(userId,projectId,taskId);
    const task=ownedTask(userId,taskId,project);
    const current=db.prepare('SELECT started_at,ended_at FROM focus_entries WHERE id=? AND user_id=?').get(entryId,userId);if(!current)fail('Focus entry not found.');
    const start=date(startedAt??current.started_at,'start date'),end=date(endedAt??current.ended_at,'end date');
    if(Date.parse(end)<=Date.parse(start))fail('End time must be after start time.');if(Date.parse(end)>Date.now())fail('Focus time cannot end in the future.');
    const result=db.prepare('UPDATE focus_entries SET description=?,note=?,project_id=?,task_id=?,skill=?,started_at=?,ended_at=?,duration_seconds=? WHERE id=? AND user_id=?')
      .run(text(description,'Description'),typeof note==='string'?note.trim().slice(0,500):'',project,task,linkedSkill(userId,task,skill),start,end,Math.floor((Date.parse(end)-Date.parse(start))/1000),entryId,userId);
    if (!result.changes) fail('Focus entry not found.');
  }
  function activeTimer(userId) { return db.prepare('SELECT * FROM active_timers WHERE user_id=?').get(userId)||null; }
  function startTimer(userId, description, projectId = null, taskId = null, note = '', skill = '', startedAt = null) {
    if (activeTimer(userId)) fail('Stop the active timer before starting another.');
    const project=projectForTask(userId,projectId,taskId);
    let started=now();
    if (startedAt!==null&&startedAt!==undefined&&startedAt!=='') {
      const at=typeof startedAt==='string'?Date.parse(startedAt):NaN;
      if (!Number.isFinite(at)) fail('Start time is not valid.');
      if (at>Date.now()+60000) fail('The start time cannot be in the future.');
      if (at<Date.now()-7*86400000) fail('The start time is too far in the past.');
      started=new Date(Math.min(at,Date.now())).toISOString();
    }
    insert('active_timers',['user_id','project_id','task_id','description','note','skill','started_at','segment_started_at'],
      [userId,project,ownedTask(userId,taskId,project),text(description,'Description'),typeof note==='string'?note.trim().slice(0,500):'',linkedSkill(userId,taskId,skill),started,started]);
    return activeTimer(userId);
  }
  function pauseTimer(userId) {
    const timer=activeTimer(userId); if (!timer) fail('There is no active timer.');
    if (timer.segment_started_at) {
      const elapsed=timer.elapsed_seconds+Math.max(0,Math.floor((Date.now()-Date.parse(timer.segment_started_at))/1000));
      db.prepare('UPDATE active_timers SET elapsed_seconds=?,segment_started_at=NULL,paused=1 WHERE user_id=?').run(elapsed,userId);
    }
    return activeTimer(userId);
  }
  function resumeTimer(userId) {
    const timer=activeTimer(userId); if (!timer) fail('There is no active timer.');
    if (!timer.segment_started_at) db.prepare('UPDATE active_timers SET segment_started_at=?,paused=0 WHERE user_id=?').run(now(),userId);
    return activeTimer(userId);
  }
  /* Stops the account's timer and saves it as one focus entry. `endedAt` (default now) lets a learning session close at its last
     activity time; `source` tells the calendar where the time came from. With an explicit `endedAt` and under one second tracked,
     the timer is just removed. */
  function stopTimerAt(userId, { endedAt = null, source = 'timer' } = {}) {
    const timer=activeTimer(userId); if (!timer) fail('There is no active timer.');
    const stamp=endedAt ? Math.min(Date.parse(endedAt), Date.now()) : Date.now();
    if (!Number.isFinite(stamp)) fail('The end time is not valid.');
    const ended=new Date(stamp).toISOString();
    const seconds=timer.elapsed_seconds+(timer.segment_started_at?Math.max(0,Math.floor((stamp-Date.parse(timer.segment_started_at))/1000)):0);
    if (seconds<1) {
      if (endedAt) { db.prepare('DELETE FROM active_timers WHERE user_id=?').run(userId); return null; }
      fail('Track at least one second before saving.');
    }
    const entryId=saveFocusEntry(userId,{startedAt:timer.started_at,endedAt:ended,durationSeconds:seconds,projectId:timer.project_id,taskId:timer.task_id,description:timer.description,note:timer.note,skill:timer.skill,source});
    db.prepare('DELETE FROM active_timers WHERE user_id=?').run(userId);
    return entryId;
  }
  function stopTimer(userId) { return stopTimerAt(userId); }
  function switchTimer(userId, description, projectId = null, taskId = null, note = '', skill = '') {
    const project=projectForTask(userId,projectId,taskId);
    const task=ownedTask(userId,taskId,project);
    const title=text(description,'Description');
    db.exec('BEGIN IMMEDIATE');
    try {
      stopTimer(userId);
      const started=now();
      insert('active_timers',['user_id','project_id','task_id','description','note','skill','started_at','segment_started_at'],
        [userId,project,task,title,typeof note==='string'?note.trim().slice(0,500):'',linkedSkill(userId,taskId,skill),started,started]);
      db.exec('COMMIT');
      return activeTimer(userId);
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  function listProjects(userId, includeArchived=false) {
    return db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.user_id=p.user_id AND t.project_id=p.id AND t.completed_at IS NULL) AS open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.user_id=p.user_id AND t.project_id=p.id AND t.completed_at IS NOT NULL) AS completed_tasks,
      (SELECT COUNT(*) FROM milestones m WHERE m.user_id=p.user_id AND m.project_id=p.id AND m.completed_at IS NULL) AS open_milestones,
      (SELECT COUNT(*) FROM milestones m WHERE m.user_id=p.user_id AND m.project_id=p.id AND m.completed_at IS NOT NULL) AS completed_milestones,
      (SELECT COALESCE(SUM(f.duration_seconds),0) FROM focus_entries f WHERE f.user_id=p.user_id AND f.project_id=p.id) AS tracked_seconds
      FROM projects p WHERE p.user_id=? ${includeArchived?'':'AND p.archived_at IS NULL'} ORDER BY p.updated_at DESC,p.created_at DESC`).all(userId);
  }
  function listProjectData(userId, projectId) {
    return {
      tasks: db.prepare('SELECT * FROM tasks WHERE user_id=? AND project_id=? ORDER BY due_at IS NULL,due_at').all(userId,projectId),
      milestones: db.prepare('SELECT * FROM milestones WHERE user_id=? AND project_id=? ORDER BY due_at').all(userId,projectId),
      events: db.prepare(`SELECT e.*,t.title AS linked_task_title FROM events e LEFT JOIN tasks t ON t.id=e.task_id AND t.user_id=e.user_id WHERE e.user_id=? AND e.project_id=? ORDER BY e.starts_at`).all(userId,projectId),
      focus: db.prepare('SELECT * FROM focus_entries WHERE user_id=? AND project_id=? ORDER BY started_at DESC').all(userId,projectId)
    };
  }
  function listProjectTaskCandidates(userId, projectId, query = '') {
    const needle=typeof query==='string'?query.trim().slice(0,180):'';
    return db.prepare(`SELECT id,title,due_at,priority FROM tasks
      WHERE user_id=? AND (project_id IS NULL OR project_id<>?)
      AND (?='' OR lower(title) LIKE '%'||lower(?)||'%')
      ORDER BY due_at IS NULL,due_at,created_at DESC LIMIT 50`).all(userId,projectId,needle,needle);
  }
  function listTasks(userId) { return db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY due_at IS NULL,due_at').all(userId); }
  function listEvents(userId) { return db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY starts_at').all(userId); }
  function listFocus(userId) { return db.prepare('SELECT * FROM focus_entries WHERE user_id=? ORDER BY started_at DESC').all(userId); }
  function listMilestones(userId) { return db.prepare('SELECT * FROM milestones WHERE user_id=? ORDER BY due_at').all(userId); }
  function setCompleted(userId, entity, recordId, completed) {
    const tables = { task:'tasks', goal:'goals', milestone:'milestones' };
    const table = tables[entity];
    if (!table) fail('Unsupported record type.');
    const result = db.prepare(`UPDATE ${table} SET completed_at=? WHERE id=? AND user_id=?`)
      .run(completed ? now() : null,recordId,userId);
    if (!result.changes) fail('Record not found.');
  }
  const PLANNER_KINDS = ['plan','whim','routine','activity','learning'];
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  function plannerDay(value, label = 'date', optional = true) {
    if (optional && (value === null || value === undefined || value === '')) return null;
    if (typeof value !== 'string' || !DAY_RE.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) fail(`Enter a valid ${label}.`);
    return value;
  }
  function plannerTime(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !TIME_RE.test(value)) fail('Enter a valid time.');
    return value;
  }
  function publicItem(row) {
    return { id: row.id, kind: row.kind, text: row.text, day: row.day, time: row.time, doneOn: row.done_on,
      position: row.position, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function listPlannerItems(userId, kind) {
    if (kind !== undefined && kind !== null && !PLANNER_KINDS.includes(kind)) fail('Unknown item type.');
    const rows = kind ? db.prepare('SELECT * FROM planner_items WHERE user_id=? AND kind=? ORDER BY position, created_at').all(userId, kind)
      : db.prepare('SELECT * FROM planner_items WHERE user_id=? ORDER BY position, created_at').all(userId);
    return rows.map(publicItem);
  }
  function createPlannerItem(userId, item = {}) {
    if (!item || typeof item !== 'object') fail('Invalid item.');
    const kind = item.kind;
    if (!PLANNER_KINDS.includes(kind)) fail('Unknown item type.');
    const body = text(item.text, 'Text', 500);
    const day = plannerDay(item.day, 'date', kind !== 'plan');
    const time = kind === 'plan' ? plannerTime(item.time) : null;
    const timestamp = now();
    const createdAt = kind === 'activity' && item.at ? date(item.at, 'time') : timestamp;
    const position = kind === 'routine' ? (db.prepare("SELECT COALESCE(MAX(position),0)+1 AS next FROM planner_items WHERE user_id=? AND kind='routine'").get(userId).next) : 0;
    const itemId = id();
    insert('planner_items', ['id','user_id','kind','text','day','time','done_on','position','created_at','updated_at'],
      [itemId, userId, kind, body, day, time, null, position, createdAt, timestamp]);
    return publicItem(db.prepare('SELECT * FROM planner_items WHERE id=?').get(itemId));
  }
  function updatePlannerItem(userId, itemId, changes = {}) {
    const row = db.prepare('SELECT * FROM planner_items WHERE id=? AND user_id=?').get(itemId, userId);
    if (!row) fail('Item not found.');
    if (!changes || typeof changes !== 'object') fail('Invalid changes.');
    const next = { text: row.text, day: row.day, time: row.time, done_on: row.done_on };
    if (changes.text !== undefined) next.text = text(changes.text, 'Text', 500);
    if (changes.day !== undefined) next.day = plannerDay(changes.day, 'date', row.kind !== 'plan');
    if (changes.time !== undefined) next.time = row.kind === 'plan' ? plannerTime(changes.time) : null;
    if (changes.doneOn !== undefined) next.done_on = plannerDay(changes.doneOn, 'completion date');
    db.prepare('UPDATE planner_items SET text=?,day=?,time=?,done_on=?,updated_at=? WHERE id=? AND user_id=?')
      .run(next.text, next.day, next.time, next.done_on, now(), itemId, userId);
    return publicItem(db.prepare('SELECT * FROM planner_items WHERE id=?').get(itemId));
  }
  function deletePlannerItem(userId, itemId) {
    const result = db.prepare('DELETE FROM planner_items WHERE id=? AND user_id=?').run(itemId, userId);
    if (!result.changes) fail('Item not found.');
  }
  function listChats(userId, includeArchived = false) {
    return db.prepare(`SELECT id,title,category,archived_at,created_at,updated_at FROM chat_sessions WHERE user_id=? ${includeArchived ? 'AND archived_at IS NOT NULL' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC`).all(userId);
  }
  const CHAT_CATEGORIES = ['work','learning','personal'];
  function chatCategory(value) {
    if (value === undefined || value === null || value === '') return 'work';
    if (!CHAT_CATEGORIES.includes(value)) fail('Unknown conversation category.');
    return value;
  }
  function createChat(userId, title = 'New conversation', category) {
    const chatId = id(); const timestamp = now();
    insert('chat_sessions',['id','user_id','title','category','created_at','updated_at'],[chatId,userId,text(title,'Conversation title'),chatCategory(category),timestamp,timestamp]);
    return chatId;
  }
  function setChatCategory(userId, chatId, category) {
    const result = db.prepare('UPDATE chat_sessions SET category=? WHERE id=? AND user_id=?').run(chatCategory(category),chatId,userId);
    if (!result.changes) fail('Conversation not found.');
  }
  function renameChat(userId, chatId, title) {
    const result = db.prepare('UPDATE chat_sessions SET title=?,updated_at=? WHERE id=? AND user_id=? AND archived_at IS NULL')
      .run(text(title,'Conversation title'),now(),chatId,userId);
    if (!result.changes) fail('Conversation not found.');
  }
  function archiveChat(userId, chatId, archived) {
    const result = db.prepare('UPDATE chat_sessions SET archived_at=?,updated_at=? WHERE id=? AND user_id=?')
      .run(archived ? now() : null,now(),chatId,userId);
    if (!result.changes) fail('Conversation not found.');
  }
  function deleteChat(userId, chatId) {
    const result = db.prepare('DELETE FROM chat_sessions WHERE id=? AND user_id=?').run(chatId,userId);
    if (!result.changes) fail('Conversation not found.');
  }
  return { setChatCategory,createProject,updateProject,archiveProject,deleteProject,getProjectPage,saveProjectPage,adoptLegacyProjects,deleteMilestone,createGoal,createTask,updateTask,deleteTask,createEvent,updateEvent,deleteEvent,createMilestone,createFocusEntry,createManualFocusEntry,editFocusEntry,activeTimer,startTimer,pauseTimer,resumeTimer,stopTimer,stopTimerAt,switchTimer,
    listProjects,listProjectData,listProjectTaskCandidates,listTasks,listEvents,listFocus,listMilestones,
    setCompleted,listChats,createChat,renameChat,archiveChat,deleteChat,
    listPlannerItems,createPlannerItem,updatePlannerItem,deletePlannerItem,
    listSubjects,getSubject,createSubject,updateSubject,deleteSubject,
    listTopics,addTopic,importTopics,renameTopic,saveTopicOrder,deleteTopics,topicFileText,topicFile,setFilePreview,setTopicPagesFromOutline,
    ...automation,
    // Chat session settings, message metadata and user-approved memory (automation/sessions.js).
    ...sessions,
    // Provider connections share this database; the caller supplies the secret codec (safeStorage in the app).
    connectionStore: secrets => createConnectionStore(db, secrets),
    learningStore: () => createLearningStore(db),
    close:()=>db.close() };
}

module.exports = { createWorkspace, WORKSPACE_MIGRATIONS };

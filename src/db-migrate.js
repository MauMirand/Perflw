'use strict';
/* Versioned, transactional schema migrations (PF-006, ADR-002).

   A database's schema version is `PRAGMA user_version` (0 for a new file and for every install made before PF-006).
   `migrations` is an ordered list of `{ version, up(db) }` with versions 1, 2, 3, … Each pending migration runs
   inside its own `BEGIN IMMEDIATE … COMMIT` together with the `user_version` update, so a migration is applied
   completely or not at all. On any error the runner rolls back and throws a plain-language error.

   Before the first pending migration on a database that already holds tables, the runner writes a consistent copy
   next to it with `VACUUM INTO` (`<file>.bak-v<from>-<timestamp>`) and keeps only the newest `keep` copies. It never
   writes, moves or deletes the live database file itself. */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const KEEP_BACKUPS = 3;
const stamp = date => date.toISOString().replace(/[-:.]/g, ''); // 20261123T043000123Z: sortable, valid on Windows
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const backupPattern = base => new RegExp(`^${escapeRegExp(base)}\\.bak-v(\\d+)-(\\d{8}T\\d{9}Z)(?:-(\\d+))?$`);

function userVersion(db) { return Number(db.prepare('PRAGMA user_version').get().user_version) || 0; }
function hasTables(db) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()); }

function checkMigrations(migrations) {
  if (!Array.isArray(migrations) || !migrations.length) throw new Error('Migration list must not be empty.');
  migrations.forEach((migration, index) => {
    if (!migration || migration.version !== index + 1 || typeof migration.up !== 'function')
      throw new Error(`Migration ${index + 1} must be { version: ${index + 1}, up(db) }.`);
  });
}

/* Backups of `file` that this runner wrote, newest first. Only names matching the exact backup pattern count. */
function listBackups(file) {
  const dir = path.dirname(file), pattern = backupPattern(path.basename(file));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map(name => ({ name, match: pattern.exec(name) })).filter(entry => entry.match)
    .map(({ name, match }) => ({ file: path.join(dir, name), from: Number(match[1]), at: match[2], seq: Number(match[3] || 0) }))
    .sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1));
}

function pruneBackups(file, keep = KEEP_BACKUPS) {
  const removed = [];
  for (const old of listBackups(file).slice(keep)) {
    try { fs.unlinkSync(old.file); removed.push(old.file); } catch { /* an old copy that cannot be removed now is retried next time */ }
  }
  return removed;
}

/* Writes a consistent copy of the open database next to `file`. The copy is made under a temporary name, checked,
   then renamed, so a half-written copy never carries a backup name. Returns the backup path. */
function backupDatabase(db, file, { from = userVersion(db), now = new Date() } = {}) {
  const base = `${file}.bak-v${from}-${stamp(now)}`;
  let target = base;
  for (let seq = 1; fs.existsSync(target); seq++) target = `${base}-${seq}`;
  const temp = `${target}.tmp`;
  try {
    fs.rmSync(temp, { force: true });
    db.prepare('VACUUM INTO ?').run(temp);
    const copy = new DatabaseSync(temp, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA quick_check').get();
      if (Object.values(check)[0] !== 'ok') throw new Error(`the copy failed its integrity check (${Object.values(check)[0]})`);
    } finally { copy.close(); }
    fs.renameSync(temp, target);
    return target;
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

/* Applies every pending migration. `name` labels the database in messages ("workspace", "accounts"). `backup` is the
   live database file path, or null/false to skip the backup (in-memory databases, tests). Returns
   { from, to, backup } where `backup` is the copy made in this call, or null. */
function migrate(db, { name = 'database', migrations, backup = null, keep = KEEP_BACKUPS, now = () => new Date() } = {}) {
  checkMigrations(migrations);
  const latest = migrations.length;
  const from = userVersion(db);
  // A newer app version already upgraded this file. Leave it as it is: later migrations only add (ADR-004).
  if (from >= latest) return { from, to: from, backup: null };

  let copy = null;
  if (backup && hasTables(db)) {
    try { copy = backupDatabase(db, backup, { from, now: now() }); }
    catch (error) {
      throw new Error(`Perflw could not make a safety copy of its ${name} data before updating it, so nothing was changed. Check that the disk has free space, then restart Perflw. (${error.message})`, { cause: error });
    }
    pruneBackups(backup, keep);
  }

  for (const migration of migrations.slice(from)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read inside the write lock: another process may have applied this step after the first read.
      if (userVersion(db) < migration.version) {
        migration.up(db);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back */ }
      const kept = copy ? ` A copy from before the update is at ${copy}.` : '';
      throw new Error(`Perflw could not update its ${name} data (step ${migration.version} of ${latest}). That step was undone, so your data is as it was before it.${kept} (${error.message})`, { cause: error });
    }
  }
  return { from, to: userVersion(db), backup: copy };
}

module.exports = { migrate, backupDatabase, pruneBackups, listBackups, userVersion, KEEP_BACKUPS };

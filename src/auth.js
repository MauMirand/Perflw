const { DatabaseSync } = require('node:sqlite');
const { randomBytes, scryptSync, timingSafeEqual, createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { migrate } = require('./db-migrate');

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const hashToken = token => createHash('sha256').update(token).digest('hex');
const fail = message => { throw new Error(message); };

/* Migration 1 = the accounts schema as it was before versioning (PF-006): the former startup bootstrap, idempotent,
   run inside the migration runner's transaction. */
function accountsSchemaV1(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      display_name TEXT, bio TEXT, image_name TEXT,
      cover_image_name TEXT,
      cover_theme TEXT NOT NULL DEFAULT 'aurora' CHECK(cover_theme IN ('aurora','dusk','tide','ember')),
      cover_position TEXT NOT NULL DEFAULT 'center 52%' CHECK(cover_position IN ('center 20%','center 52%','center 85%')),
      profile_completed INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );`);

  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  const profileMigrations = [
    ['cover_image_name', 'TEXT'],
    ['cover_theme', "TEXT NOT NULL DEFAULT 'aurora' CHECK(cover_theme IN ('aurora','dusk','tide','ember'))"],
    ['cover_position', "TEXT NOT NULL DEFAULT 'center 52%' CHECK(cover_position IN ('center 20%','center 52%','center 85%'))"]
  ];
  for (const [name, definition] of profileMigrations) {
    if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
}

const ACCOUNT_MIGRATIONS = Object.freeze([{ version: 1, up: accountsSchemaV1 }]);

function createAuth(root, { migrations = ACCOUNT_MIGRATIONS } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'accounts.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON'); // per connection; a no-op inside a transaction, so set before migrating
    migrate(db, { name: 'accounts', migrations, backup: file });
  } catch (error) { db.close(); throw error; }

  function publicUser(row) {
    return { id: row.id, email: row.email, displayName: row.display_name || '',
      bio: row.bio || '', imageName: row.image_name || null,
      coverImageName: row.cover_image_name || null,
      coverTheme: row.cover_theme || 'aurora', coverPosition: row.cover_position || 'center 52%',
      profileCompleted: Boolean(row.profile_completed) };
  }
  function validateEmail(value) {
    if (typeof value !== 'string') fail('Enter a valid email address.');
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.');
    return email;
  }
  function validatePassword(value) {
    if (typeof value !== 'string' || value.length < 12 || value.length > 128 ||
        !/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
      fail('Use 12–128 characters with uppercase, lowercase, and a number.');
    }
  }
  function makeSession(userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hashToken(token), userId, Date.now() + SESSION_MS);
    return token;
  }
  function session(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), Date.now());
    return row ? publicUser(row) : null;
  }
  function register(emailInput, password, confirmation) {
    const email = validateEmail(emailInput);
    validatePassword(password);
    if (password !== confirmation) fail('Passwords do not match.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail('This email is already registered.');
    const id = randomBytes(16).toString('hex');
    const salt = randomBytes(16).toString('hex');
    const encoded = scryptSync(password, Buffer.from(salt, 'hex'), 64, SCRYPT).toString('hex');
    try {
      db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
        .run(id, email, `scrypt:${salt}:${encoded}`);
    } catch (error) {
      if (String(error).includes('UNIQUE')) fail('This email is already registered.');
      throw error;
    }
    const token = makeSession(id);
    return { token, user: session(token) };
  }
  function login(emailInput, password) {
    const email = validateEmail(emailInput);
    if (typeof password !== 'string' || password.length > 128) fail('Invalid email or password.');
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) fail('Invalid email or password.');
    if (row.locked_until > Date.now()) fail('Too many attempts. Try again in 15 minutes.');
    const [, salt, encoded] = row.password_hash.split(':');
    const actual = scryptSync(password, Buffer.from(salt, 'hex'), 64, SCRYPT);
    const expected = Buffer.from(encoded, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      const attempts = row.failed_attempts + 1;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
        .run(attempts >= 5 ? 0 : attempts, attempts >= 5 ? Date.now() + 15 * 60 * 1000 : 0, row.id);
      fail('Invalid email or password.');
    }
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(row.id);
    const token = makeSession(row.id);
    return { token, user: session(token) };
  }
  function saveProfile(token, displayName, bio, imageName, coverImageName = null, coverTheme = 'aurora', coverPosition = 'center 52%') {
    const user = session(token);
    if (!user) fail('Your session has expired. Log in again.');
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 80)
      fail('Display name must be 1–80 characters.');
    if (typeof bio !== 'string' || bio.length > 500) fail('Bio must be 500 characters or less.');
    if (imageName !== null && (typeof imageName !== 'string' || !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(imageName)))
      fail('Invalid profile image.');
    if (coverImageName !== null && (typeof coverImageName !== 'string' || !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(coverImageName)))
      fail('Invalid cover image.');
    if (!['aurora','dusk','tide','ember'].includes(coverTheme)) fail('Choose a valid cover style.');
    if (!['center 20%','center 52%','center 85%'].includes(coverPosition)) fail('Choose a valid cover position.');
    db.prepare(`UPDATE users SET display_name = ?, bio = ?, image_name = ?, cover_image_name = ?, cover_theme = ?, cover_position = ?, profile_completed = 1
      WHERE id = ?`).run(displayName.trim(), bio.trim(), imageName, coverImageName, coverTheme, coverPosition, user.id);
    return session(token);
  }
  function logout(token) {
    if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  return { register, login, session, saveProfile, logout, close: () => db.close() };
}

module.exports = { createAuth, ACCOUNT_MIGRATIONS };

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuth } = require('../src/auth');

test('registration, onboarding, session restart, account separation, and revocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-auth-'));
  let auth = createAuth(root);
  try {
    assert.equal(auth.session('not-a-token'), null);
    const first = auth.register(' First@Example.com ', 'StrongPassword123', 'StrongPassword123');
    assert.equal(first.user.profileCompleted, false);
    assert.throws(() => auth.register('first@example.com', 'StrongPassword123', 'StrongPassword123'), /already registered/);
    assert.throws(() => auth.login('first@example.com', 'incorrect'), /Invalid email or password/);
    assert.throws(() => auth.saveProfile('invalid', 'Name', '', null), /session has expired/);
    auth.close();
    auth = createAuth(root);
    assert.equal(auth.session(first.token).profileCompleted, false);
    const firstProfile = auth.saveProfile(first.token, 'First User', 'First bio', null, `${'a'.repeat(32)}.png`, 'ember', 'center 85%');
    assert.equal(firstProfile.profileCompleted, true);
    assert.equal(firstProfile.coverTheme, 'ember');
    assert.equal(firstProfile.coverPosition, 'center 85%');
    assert.equal(firstProfile.coverImageName, `${'a'.repeat(32)}.png`);
    const second = auth.register('second@example.com', 'AnotherPassword123', 'AnotherPassword123');
    auth.saveProfile(second.token, 'Second User', 'Second bio', null);
    assert.equal(auth.session(first.token).displayName, 'First User');
    assert.equal(auth.session(second.token).displayName, 'Second User');
    assert.equal(auth.session(second.token).coverTheme, 'aurora');
    assert.equal(auth.session(second.token).coverImageName, null);
    assert.throws(() => auth.saveProfile(first.token, 'First User', 'First bio', null, null, 'external-url'), /valid cover style/);
    assert.throws(() => auth.saveProfile(first.token, 'First User', 'First bio', null, null, 'aurora', 'left'), /valid cover position/);
    auth.close();
    auth = createAuth(root);
    assert.equal(auth.session(first.token).profileCompleted, true);
    assert.equal(auth.session(first.token).coverTheme, 'ember');
    assert.equal(auth.session(first.token).coverPosition, 'center 85%');
    const login = auth.login('FIRST@example.com', 'StrongPassword123');
    assert.equal(login.user.bio, 'First bio');
    auth.logout(login.token);
    assert.equal(auth.session(login.token), null);
    assert.equal(auth.session(first.token).displayName, 'First User');
  } finally {
    auth.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy account databases migrate profile banner fields with safe defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-auth-legacy-'));
  const database = new DatabaseSync(path.join(root, 'accounts.sqlite'));
  let auth;
  try {
    database.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      display_name TEXT, bio TEXT, image_name TEXT,
      profile_completed INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users(id,email,password_hash,display_name,bio,profile_completed)
    VALUES('legacy-user','legacy@example.com','unused','Legacy User','Legacy profile',1);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);`);
    database.close();
    auth = createAuth(root);
    const migrated = new DatabaseSync(path.join(root, 'accounts.sqlite'));
    try {
      const user = migrated.prepare('SELECT cover_image_name,cover_theme,cover_position FROM users WHERE id=?').get('legacy-user');
      assert.equal(user.cover_image_name, null);
      assert.equal(user.cover_theme, 'aurora');
      assert.equal(user.cover_position, 'center 52%');
    } finally { migrated.close(); }
  } finally {
    auth?.close();
    try { database.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('input rules and repeated login failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-auth-'));
  const auth = createAuth(root);
  try {
    assert.throws(() => auth.register('bad', 'StrongPassword123', 'StrongPassword123'), /valid email/);
    assert.throws(() => auth.register('a@example.com', 'weak', 'weak'), /12–128/);
    assert.throws(() => auth.register('a@example.com', 'StrongPassword123', 'different'), /do not match/);
    auth.register('a@example.com', 'StrongPassword123', 'StrongPassword123');
    for (let i = 0; i < 5; i++) assert.throws(() => auth.login('a@example.com', 'wrong'), /Invalid/);
    assert.throws(() => auth.login('a@example.com', 'StrongPassword123'), /Too many attempts/);
  } finally {
    auth.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

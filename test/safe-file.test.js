const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic, readJsonFile, RETRY_MS } = require('../src/safe-file');

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-safefile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/* Makes fs[method] throw `code` for `target` the first `times` calls (Infinity: until restored), as a program
   holding the file would. The second argument of renameSync is the target; for the others it is the first. */
function hold(t, method, target, code, times) {
  const original = fs[method]; let left = times; const calls = { count: 0 };
  fs[method] = function (...args) {
    const file = String(method === 'renameSync' && args[1] === target ? args[1] : args[0]);
    if (file === target) { calls.count++; if (left > 0) { left--; throw Object.assign(new Error(`${code}: held`), { code }); } }
    return original.apply(this, args);
  };
  t.after(() => { fs[method] = original; });
  return calls;
}
const temps = dir => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));

test('writeFileAtomic writes the whole file, creates the folder, and leaves no temp file', t => {
  const dir = folder(t); const file = path.join(dir, 'a', 'b', 'state.json');
  writeFileAtomic(file, '{"x":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"x":1}\n');
  writeFileAtomic(file, '{"x":2}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"x":2}\n', 'replaces an existing file');
  assert.deepEqual(temps(path.dirname(file)), []);
});

test('writeFileAtomic gives the file mode 0o600 where the platform reports it', t => {
  const dir = folder(t); const file = path.join(dir, 'secret.json');
  writeFileAtomic(file, '{}');
  if (process.platform === 'win32') { t.diagnostic('Windows does not report POSIX modes; skipped'); return; }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a held target is retried and then written', t => {
  const dir = folder(t); const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'old');
  const calls = hold(t, 'renameSync', file, 'EPERM', 2);
  writeFileAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(calls.count, 3, 'two refusals, then success');
  assert.deepEqual(temps(dir), []);
});

test('a target held past the retries throws a plain error, keeps the old file and removes the temp file', t => {
  const dir = folder(t); const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'old');
  hold(t, 'renameSync', file, 'EBUSY', Infinity);
  const started = Date.now();
  assert.throws(() => writeFileAtomic(file, 'new'), error => error.code === 'EBUSY' && /another program is using it/.test(error.message) && !/EBUSY/.test(error.message));
  assert.ok(Date.now() - started >= RETRY_MS - 20, 'waited for the retries');
  assert.ok(Date.now() - started < RETRY_MS + 1500, 'bounded wait');
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(temps(dir), []);
});

test('other write errors are thrown at once, without retrying', t => {
  const dir = folder(t); const file = path.join(dir, 'state.json');
  const calls = hold(t, 'renameSync', file, 'EXDEV', Infinity);
  assert.throws(() => writeFileAtomic(file, 'x'), { code: 'EXDEV' });
  assert.equal(calls.count, 1);
  assert.deepEqual(temps(dir), []);
});

test('readJsonFile: a missing file gives the fallback', t => {
  const dir = folder(t);
  assert.deepEqual(readJsonFile(path.join(dir, 'none.json'), { empty: true }), { empty: true });
});

test('readJsonFile: a briefly held file is retried and read', t => {
  const dir = folder(t); const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"docs":[1]}');
  hold(t, 'readFileSync', file, 'EBUSY', 1);
  assert.deepEqual(readJsonFile(file, {}), { docs: [1] });
});

test('readJsonFile: a file still held throws and never returns the fallback', t => {
  const dir = folder(t); const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"docs":[1]}');
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const original = fs.readFileSync;
    fs.readFileSync = function (...args) { if (String(args[0]) === file) throw Object.assign(new Error(code), { code }); return original.apply(this, args); };
    try { assert.throws(() => readJsonFile(file, { empty: true }), error => error.code === code && /another program is using it/.test(error.message), code); }
    finally { fs.readFileSync = original; }
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{"docs":[1]}', 'the file is untouched');
});

test('readJsonFile: invalid JSON is moved aside (kept) and gives the fallback', t => {
  const dir = folder(t); const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"docs": [1, 2');
  assert.deepEqual(readJsonFile(file, { fresh: true }), { fresh: true });
  assert.equal(fs.existsSync(file), false, 'the damaged file is no longer in the way');
  const aside = fs.readdirSync(dir).filter(name => name.startsWith('state.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"docs": [1, 2', 'its content is kept for recovery');
});

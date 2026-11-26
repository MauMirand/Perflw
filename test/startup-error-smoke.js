'use strict';
/* PF-021 Electron check: a workspace database that cannot be opened must give one plain message on stderr and exit
   code 1, create no window, and leave the file byte-identical. Test mode (PERFLW_TEST_USER_DATA) prints instead of
   showing a modal box, so this runs unattended. Usage: node test/startup-error-smoke.js */
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appDir = path.resolve(process.env.PERFLW_ELECTRON_APP_DIR || path.join(__dirname, '..'));
const exe = require(path.join(appDir, 'node_modules', 'electron'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-startup-'));
const garbage = Buffer.from('This is not a SQLite database. '.repeat(40));
const file = path.join(root, 'workspace.sqlite');
fs.writeFileSync(file, garbage);

const child = spawn(exe, ['.', ...(process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : [])], {
  cwd: appDir, env: { ...process.env, PERFLW_TEST_USER_DATA: root }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
const timer = setTimeout(() => child.kill(), 60000);

child.on('exit', code => {
  clearTimeout(timer);
  let failure = null;
  try {
    assert.equal(code, 1, `exit code (stderr: ${stderr.slice(0, 500)})`);
    assert.ok(stderr.includes('Perflw could not start: Perflw could not open its data'), 'plain message on stderr');
    assert.ok(stderr.includes('Nothing was changed or deleted.'), 'says nothing was changed');
    assert.ok(stderr.includes(root), 'names the data folder');
    assert.ok(Buffer.compare(fs.readFileSync(file), garbage) === 0, 'the damaged file is byte-identical');
    const left = fs.readdirSync(root).filter(name => name !== 'workspace.sqlite' && !name.startsWith('accounts.sqlite'));
    assert.deepEqual(left.filter(name => /\.(bak|tmp)/.test(name)), [], 'no backup or temp file was made for the damaged file');
  } catch (error) { failure = error; }
  fs.rmSync(root, { recursive: true, force: true });
  if (failure) { console.error(`FAIL: ${failure.message}`); process.exit(1); }
  console.log('Startup error check passed.');
});

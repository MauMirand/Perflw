'use strict';
/* Safe reads and writes for the user-data files in %APPDATA%\Perflw (ADR-003, PF-007).

   On Windows another program (antivirus, the search indexer, a backup tool) can hold a file open for a moment.
   While it does, renaming onto the file throws EPERM and an exclusive hold makes reading it throw EBUSY. Without
   care that loses data: a read error taken as "no file yet" lets the next save overwrite everything in it.

     writeFileAtomic(file, data, { mode })  temp file in the same folder, then rename onto the target. A held file
                                            is retried for up to ~0.5 s; then the temp file is removed and a
                                            plain-language error is thrown. The target is never half-written.
     readJsonFile(file, fallback)           a missing file gives `fallback`. A held file is retried, then THROWS
                                            (never `fallback`), so a read-modify-write stops before it writes.
                                            Invalid JSON is moved aside to <name>.corrupt-<time> and gives
                                            `fallback`, so the next save cannot destroy what was there.

   Both are synchronous on purpose: callers read, change and write with no await in between, so queued work never
   interleaves a write. The retry waits with Atomics.wait, which blocks only in the rare held-file case. */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DELAYS_MS = [10, 20, 40, 80, 150, 200]; // 500 ms in total before giving up
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* Runs `op`; while it fails because the file is held, waits and tries again. Other errors are thrown at once. */
function retryBusy(op) {
  for (let attempt = 0; ; attempt++) {
    try { return op(); }
    catch (error) {
      if (!BUSY.has(error && error.code) || attempt >= DELAYS_MS.length) throw error;
      pause(DELAYS_MS[attempt]);
    }
  }
}
function inUse(action, file, cause) {
  const error = new Error(`${action} ${path.basename(file)} because another program is using it. Try again in a moment.`);
  error.code = cause.code; error.cause = cause;
  return error;
}

function writeFileAtomic(file, data, { mode = 0o600, dirMode = 0o700 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: dirMode });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, data, { mode, flag: 'wx' });
  try { retryBusy(() => fs.renameSync(temp, file)); }
  catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort: the temp file is never read */ }
    if (BUSY.has(error.code)) throw inUse('Could not save', file, error);
    throw error;
  }
}

function readJsonFile(file, fallback) {
  let text;
  try { text = retryBusy(() => fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (BUSY.has(error.code)) throw inUse('Could not read', file, error);
    throw error;
  }
  try { return JSON.parse(text); }
  catch {
    // Kept for recovery; the caller starts from `fallback` without overwriting the damaged file.
    retryBusy(() => fs.renameSync(file, `${file}.corrupt-${Date.now()}`));
    return fallback;
  }
}

module.exports = { writeFileAtomic, readJsonFile, BUSY_CODES: [...BUSY], RETRY_MS: DELAYS_MS.reduce((a, b) => a + b, 0) };

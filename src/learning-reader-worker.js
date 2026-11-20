'use strict';
/* Worker thread for the Learning workflow: reads study files and their pictures away from the main process.
   pdf.js in Node runs its parser on the calling thread and only yields through promise jobs, so reading a large PDF
   on the main process froze the whole window (10 s for a 16 MB PDF). Here it only occupies this worker.
   Messages: { id, op, args } → { id, ok, value } | { id, ok: false, error }; the operations are in learning-files.js. */
const { parentPort } = require('node:worker_threads');
const { createOps } = require('./learning-files');

const ops = createOps();
parentPort.on('message', async ({ id, op, args }) => {
  try { parentPort.postMessage({ id, ok: true, value: await ops[op](args) }); }
  catch (error) { parentPort.postMessage({ id, ok: false, error: String((error && error.message) || error) }); }
});

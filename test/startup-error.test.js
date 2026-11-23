'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startupMessage, TITLE } = require('../src/startup-error');

const DIR = 'C:\\Users\\Student\\AppData\\Roaming\\Perflw';

test('a migration-runner error is kept as it is, with the data folder added', () => {
  const runner = 'Perflw could not update its workspace data (step 2 of 2). That step was undone, so your data is as it was before it. (disk I/O error)';
  const { title, message } = startupMessage(new Error(runner), { dataDir: DIR });
  assert.equal(title, TITLE);
  assert.ok(message.startsWith(runner), 'the runner text comes first and unchanged');
  assert.ok(message.includes(DIR));
  assert.ok(!message.includes('did not start'), 'no second wrapper around a message that already explains itself');
});

test('the safety-copy error from the runner is also kept as it is', () => {
  const runner = 'Perflw could not make a safety copy of its accounts data before updating it, so nothing was changed. Check that the disk has free space, then restart Perflw. (ENOSPC)';
  const { message } = startupMessage(new Error(runner), { dataDir: DIR });
  assert.ok(message.startsWith(runner));
});

test('a foreign error is wrapped: what happened, that nothing was changed, where the data is, how to restore', () => {
  const { title, message } = startupMessage(new Error('file is not a database'), { dataDir: DIR });
  assert.equal(title, TITLE);
  assert.ok(message.startsWith('Perflw could not open its data, so it did not start.'));
  assert.ok(message.includes('Nothing was changed or deleted.'));
  assert.ok(message.includes(DIR));
  assert.ok(message.includes('.bak-'), 'names the backup copies');
  assert.ok(message.includes('(file is not a database)'), 'keeps the technical reason at the end');
});

test('odd inputs still give a usable message', () => {
  for (const error of [undefined, null, {}, new Error(''), 'text', { message: 42 }]) {
    const { title, message } = startupMessage(error);
    assert.equal(title, TITLE);
    assert.ok(message.length > 40);
    assert.ok(message.includes('An unknown error occurred.'));
    assert.ok(!message.includes('Your data folder'), 'no folder line without a folder');
  }
});

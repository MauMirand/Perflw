'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const HL = require('../src/home-layout.js');

const all = l => [...l.main, ...l.side].sort();

test('normalize returns the default for missing or malformed values', () => {
  for (const raw of [null, undefined, 42, 'plan', [], true]) {
    assert.deepEqual(HL.normalize(raw), { main: ['plan', 'learn', 'create', 'automate'], side: ['todo', 'routine'] });
  }
});

test('normalize drops unknown ids, keeps the first of repeats and returns missing cards to their default column', () => {
  const l = HL.normalize({ main: ['create', 'bogus', 7, 'create', 'todo'], side: ['plan', 'todo', null], extra: ['learn'] });
  assert.deepEqual(l, { main: ['create', 'todo', 'learn', 'automate'], side: ['plan', 'routine'] });
  assert.deepEqual(all(l), [...HL.CARDS].sort(), 'every card exactly once');
  assert.deepEqual(all(HL.normalize({ main: 'nope', side: {} })), [...HL.CARDS].sort());
});

test('move reorders within a column and across columns without mutating its input', () => {
  const start = HL.normalize(null);
  const up = HL.move(start, 'learn', 'main', 0);
  assert.deepEqual(up.main, ['learn', 'plan', 'create', 'automate']);
  assert.deepEqual(start.main, ['plan', 'learn', 'create', 'automate'], 'input unchanged');
  const across = HL.move(start, 'todo', 'main', 99);
  assert.deepEqual(across, { main: ['plan', 'learn', 'create', 'automate', 'todo'], side: ['routine'] });
  const back = HL.move(across, 'plan', 'side', -5);
  assert.deepEqual(back.side, ['plan', 'routine']);
  assert.deepEqual(HL.move(start, 'bogus', 'main', 0), start, 'unknown card ignored');
  assert.deepEqual(HL.move(start, 'plan', 'nowhere', 0), start, 'unknown column ignored');
});

test('isDefault', () => {
  assert.equal(HL.isDefault(null), true);
  assert.equal(HL.isDefault(HL.normalize(null)), true);
  assert.equal(HL.isDefault(HL.move(null, 'learn', 'main', 0)), false);
  assert.equal(HL.isDefault(HL.move(HL.move(null, 'learn', 'main', 0), 'learn', 'main', 1)), true);
});

test('spans: wide cards and unpaired cards take the full row', () => {
  assert.deepEqual([...HL.spans(['plan', 'learn', 'create', 'automate'])].sort(), ['automate', 'plan']);
  assert.deepEqual([...HL.spans(['learn', 'plan', 'create', 'automate'])].sort(), ['automate', 'create', 'learn', 'plan']);
  assert.deepEqual([...HL.spans(['learn', 'create', 'plan'])], ['plan']);
  assert.deepEqual([...HL.spans(['learn', 'create', 'todo'])], ['todo']);
  assert.deepEqual([...HL.spans([])], []);
});

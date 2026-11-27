// Fixes from the 2026-11-27 student walkthrough: key points keep their subject, AI question checks, first-run sign-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const intel = require('../src/learning-intel');
const { sanityProblem, whyProblem } = require('../src/learning-coach');
const { createAuth } = require('../src/auth');

const NOTES = '# Cells\nCells are the basic unit of life.\n## Organelles\nThe nucleus stores DNA and controls cell activity. Mitochondria make ATP through cellular respiration. They are called the powerhouse of the cell. Ribosomes build proteins. They can be free in the cytoplasm or attached to the rough ER. The Golgi apparatus modifies, sorts and packages proteins.\n';

test('key points: a pronoun sentence keeps the sentence it refers to, and plain facts fill the section', async () => {
  const blocks = await intel.extractBlocks(Buffer.from(NOTES), 'md');
  const section = intel.analyze(blocks, { fileName: 'notes.md', fileType: 'md' }).sections.find(s => s.title === 'Organelles');
  assert.ok(section.keyPoints.includes('Mitochondria make ATP through cellular respiration. They are called the powerhouse of the cell.'));
  assert.ok(!section.keyPoints.some(p => /^They\b/.test(p)), 'no point starts with a dangling pronoun');
  assert.ok(section.keyPoints.some(p => p.startsWith('Ribosomes build proteins.')), 'plain facts are kept');
  assert.ok(section.keyPoints.length >= 2);
});

test('question checks: clipped true/false statements and cause-less "what happens" stems are rejected', () => {
  assert.match(sanityProblem({ type: 'truefalse', prompt: 'True or false?', payload: { statement: 'Prok: cells have a nucleus and organelles.', correct: false } }), /whole sentence/);
  assert.match(sanityProblem({ type: 'truefalse', prompt: 'True or false?', payload: { statement: 'Cells.', correct: true } }), /whole sentence/);
  assert.equal(sanityProblem({ type: 'truefalse', prompt: 'True or false?', payload: { statement: 'Prokaryotic cells have a nucleus.', correct: false } }), null);
  const plain = { title: 'The Cell', text: 'All living things are made of one or more cells.' };
  assert.match(whyProblem({ type: 'explain', prompt: 'What happens when all living things are made of one or more cells?' }, plain), /cause or effect/);
  assert.equal(whyProblem({ type: 'explain', prompt: 'What happens when water enters?' }, { title: 'x', text: 'Water enters, which causes the cell to swell.' }), null);
});

test('first run: hasAccounts is false until an account exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-ux-'));
  const auth = createAuth(root);
  try {
    assert.equal(auth.hasAccounts(), false);
    auth.register('new@example.com', 'StrongPassword123', 'StrongPassword123');
    assert.equal(auth.hasAccounts(), true);
  } finally { auth.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

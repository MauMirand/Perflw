'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { templateQuestions, sectionsOf } = require('../src/question-templates');
const model = require('../src/assessment-model');

const files = {
  f1: { sections: [
    { number: '1', title: 'Ionic bonds', page: 2, description: 'Atoms swap electrons and stick together.', keyPoints: ['Ions form when electrons transfer.', 'Opposite charges attract strongly.', 'Lattices melt at high temperatures.'] },
    { number: '1.1', title: 'Lattices', page: 3, description: 'A regular 3D pattern of ions.', keyPoints: ['Each ion touches several opposite ions.'] },
    { number: '2', title: 'Covalent bonds', page: 5, description: 'Atoms share electron pairs.', keyPoints: ['Pairs are shared.', 'Molecules form.'] },
    { number: '3', title: 'Metals', page: 7, description: 'A sea of free electrons.', keyPoints: [] },
  ] },
};
const topics = [{ id: 't1', title: 'Ionic bonds', fileId: 'f1' }, { id: 't2', title: 'Whole file', fileId: 'f1' }];

test('every template draft passes validateQuestion and cites its source', () => {
  const drafts = templateQuestions({ subjectId: 's1', topics, files });
  assert.ok(drafts.length >= 6);
  for (const d of drafts) {
    const r = model.validateQuestion(d);
    assert.ok(r.ok, `${d.id}: ${r.errors.join(' | ')}`);
    assert.equal(r.value.origin, 'template');
    assert.ok(d.source.length >= 1 && d.source[0].fileId === 'f1' && d.source[0].quote, `${d.id} cites a section and a quote`);
  }
});

test('explain: one per section with 2+ key points, rubric = the key points; true/false: first two key points, as written, true', () => {
  const drafts = templateQuestions({ subjectId: 's1', topics: [topics[0]], files });
  const explain = drafts.filter(d => d.type === 'explain');
  assert.deepEqual(explain.map(d => d.prompt), ['Explain Ionic bonds in your own words.'], 'the sub-section Lattices has 1 key point, so none');
  assert.deepEqual(explain[0].payload.rubric.map(r => r.criterion), files.f1.sections[0].keyPoints);
  const tf = drafts.filter(d => d.type === 'truefalse');
  assert.deepEqual(tf.map(d => d.payload.statement), ['Ions form when electrons transfer.', 'Opposite charges attract strongly.', 'Each ion touches several opposite ions.']);
  assert.ok(tf.every(d => d.payload.correct === true), 'no invented false statements');
});

test('matching needs 3+ described sections; a topic owns its section and the ones below it', () => {
  assert.equal(templateQuestions({ subjectId: 's1', topics: [topics[0]], files }).filter(d => d.type === 'matching').length, 0, 'Ionic bonds + Lattices = 2 sections');
  const all = templateQuestions({ subjectId: 's1', topics: [topics[1]], files });
  const match = all.find(d => d.type === 'matching');
  assert.ok(match); assert.equal(match.payload.left.length, 4); assert.equal(match.payload.pairs.length, 4);
  assert.deepEqual(sectionsOf(topics[0], files.f1).map(s => s.number), ['1', '1.1']);
  assert.equal(sectionsOf(topics[1], files.f1).length, 4);
});

test('deterministic, and safe with missing files, empty analysis and odd input', () => {
  const a = JSON.stringify(templateQuestions({ subjectId: 's1', topics, files }));
  assert.equal(a, JSON.stringify(templateQuestions({ subjectId: 's1', topics, files })));
  assert.deepEqual(templateQuestions({ subjectId: 's1', topics: [{ id: 'x', title: 'X', fileId: 'nope' }], files }), []);
  assert.deepEqual(templateQuestions({ subjectId: 's1', topics: [{ id: 'x', title: 'X', fileId: 'f1' }], files: { f1: { sections: [] } } }), []);
  assert.deepEqual(templateQuestions({}), []);
  assert.deepEqual(templateQuestions({ subjectId: 's1', topics: [null, { id: 1 }], files }), []);
});

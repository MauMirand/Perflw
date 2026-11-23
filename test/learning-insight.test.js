'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../src/assessment-model');
const L = require('../src/learning-insight');

// ───────── fixtures: validated questions and graded answers, as LS-010/LS-011 will produce them
function q(raw) {
  const r = A.validateQuestion({ subjectId: 's1', topicId: 't1', prompt: 'Q?', dimension: 'recognition', difficulty: 2, ...raw });
  assert.ok(r.ok, r.errors.join(' '));
  return r.value;
}
const opts = texts => texts.map((text, i) => ({ id: String.fromCharCode(97 + i), text }));
const choice = (id, texts, correct, extra = {}) => q({ id, type: 'choice', payload: { options: opts(texts), correct }, ...extra });
const qCapital = choice('q-cap', ['Paris', 'Lyon', 'Nice'], ['a']);
const qRiver = choice('q-river', ['Seine', 'Lyon', 'Loire'], ['b'], { prompt: 'Which city is on the Rhône?' });
const qMatch = q({
  id: 'q-match', type: 'matching',
  payload: { left: opts(['H2O', 'NaCl', 'CO2']), right: [{ id: 'x', text: 'water' }, { id: 'y', text: 'salt' }, { id: 'z', text: 'carbon dioxide' }],
    pairs: [['a', 'x'], ['b', 'y'], ['c', 'z']] },
});
const qExplain = q({ id: 'q-exp', type: 'explain', dimension: 'recall', points: 2,
  payload: { rubric: [{ id: 'c1', criterion: 'Defines it', points: 1 }, { id: 'c2', criterion: 'Gives an example', points: 1 }] } });
const qTf = q({ id: 'q-tf', type: 'truefalse', dimension: 'recall', payload: { statement: 'Ice floats.', correct: true } });

function answer(question, response, result) {
  const r = A.normalizeResponse(question, { questionId: question.id, ...response });
  return { question, response: r, result: result || A.grade(question, r) };
}

// ───────── loading
test('loads with require and as a browser global (window.PerflwLearningInsight)', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'learning-insight.js'), 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  for (const name of ['categorize', 'rankWeakTopics', 'nextReview', 'targetedNote', 'escapeMarkdown']) {
    assert.equal(typeof sandbox.PerflwLearningInsight[name], 'function', name);
    assert.equal(typeof L[name], 'function', name);
  }
  assert.ok(!/require\(/.test(code), 'no imports (pure, must not load mastery-model.js)');
  assert.deepEqual([...L.REVIEW_OFFSETS], [1, 3, 7, 14, 30]);
});

// ───────── categorize: one test per §5.2 category
test('not_known: "I don\'t know", blank text and grade\'s not_answered', () => {
  assert.equal(L.categorize(answer(qCapital, { dontKnow: true })), 'not_known');
  assert.equal(L.categorize(answer(qExplain, { text: '   ' })), 'not_known');
  assert.equal(L.categorize(answer(qCapital, {})), 'not_known');
  const blank = answer(qCapital, {});
  assert.equal(blank.result.category, 'not_answered');
});

test('misconception: wrong with confidence 3', () => {
  assert.equal(L.categorize(answer(qCapital, { choice: ['b'], confidence: 3 })), 'misconception');
  assert.equal(L.categorize(answer(qTf, { value: false, confidence: 3 })), 'misconception');
});

test('guess: correct with confidence 1; correct otherwise has no category', () => {
  assert.equal(L.categorize(answer(qCapital, { choice: ['a'], confidence: 1 })), 'guess');
  assert.equal(L.categorize(answer(qCapital, { choice: ['a'], confidence: 2 })), null);
  assert.equal(L.categorize(answer(qCapital, { choice: ['a'], confidence: 3 })), null);
  assert.equal(L.categorize(answer(qCapital, { choice: ['a'] })), null);
});

test('confusion (choice): picked the correct answer of another question in the same topic', () => {
  const a = answer(qCapital, { choice: ['b'], confidence: 2 }); // "Lyon" = qRiver's answer
  assert.equal(L.categorize(a, { siblings: [qCapital, qRiver] }), 'confusion');
  assert.equal(L.categorize(a, { siblings: [] }), 'incorrect');
  const otherTopic = { ...qRiver, topicId: 't2' };
  assert.equal(L.categorize(a, { siblings: [otherTopic] }), 'incorrect', 'sibling in another topic does not count');
  const c = answer(qCapital, { choice: ['c'] }); // "Nice" is nobody's answer
  assert.equal(L.categorize(c, { siblings: [qRiver] }), 'incorrect');
});

test('confusion (matching): swapped pairs', () => {
  const swapped = answer(qMatch, { pairs: [['a', 'y'], ['b', 'x'], ['c', 'z']] });
  assert.ok(swapped.result.score > 0 && swapped.result.score < swapped.result.max);
  assert.equal(L.categorize(swapped), 'confusion');
});

test('partial: open answer or matching with 0 < score < max', () => {
  const partialMatch = answer(qMatch, { pairs: [['a', 'x'], ['b', 'z']] });
  assert.equal(L.categorize(partialMatch), 'partial');
  const open = answer(qExplain, { text: 'It is a thing.' }, { score: 1, max: 2, status: 'graded' });
  assert.equal(L.categorize(open), 'partial');
  const zero = answer(qExplain, { text: 'No idea really.' }, { score: 0, max: 2, status: 'graded' });
  assert.equal(L.categorize(zero), 'incorrect');
});

test('recognition_only: recognition correct, recall/understanding wrong in the same assessment', () => {
  const recog = answer(qCapital, { choice: ['a'] });
  const recall = answer(qTf, { value: false });
  assert.equal(L.categorize(recall, { answers: [recog, recall] }), 'recognition_only');
  const wrongRecog = answer(qCapital, { choice: ['c'] });
  assert.equal(L.categorize(recall, { answers: [wrongRecog] }), 'incorrect');
  const recogOtherTopic = { ...recog, question: { ...qCapital, topicId: 't2' } };
  assert.equal(L.categorize(recall, { answers: [recogOtherTopic] }), 'incorrect');
  // a wrong recognition item itself is never recognition_only
  assert.equal(L.categorize(answer(qCapital, { choice: ['c'] }), { answers: [recog] }), 'incorrect');
});

test('forgotten: correct in final/practice, wrong in a later retention check', () => {
  const a = answer(qTf, { value: false });
  assert.equal(L.categorize(a, { kind: 'retention', earlier: [{ topicId: 't1', kind: 'final', correct: true }] }), 'forgotten');
  assert.equal(L.categorize(a, { kind: 'retention', earlier: [{ questionId: 'q-tf', topicId: 't1', kind: 'practice', correct: true }] }), 'forgotten');
  assert.equal(L.categorize(a, { kind: 'retention', earlier: [{ questionId: 'other', topicId: 't1', kind: 'final', correct: true }] }), 'incorrect');
  assert.equal(L.categorize(a, { kind: 'retention', earlier: [{ topicId: 't1', kind: 'diagnostic', correct: true }] }), 'incorrect');
  assert.equal(L.categorize(a, { kind: 'retention', earlier: [{ topicId: 't1', kind: 'final', correct: false }] }), 'incorrect');
  assert.equal(L.categorize(a, { kind: 'practice', earlier: [{ topicId: 't1', kind: 'final', correct: true }] }), 'incorrect');
});

test('incorrect: any other wrong answer; pending results are not categorized', () => {
  assert.equal(L.categorize(answer(qCapital, { choice: ['c'], confidence: 2 })), 'incorrect');
  assert.equal(L.categorize(answer(qExplain, { text: 'An answer.' })), null, 'pending open answer');
  assert.throws(() => L.categorize(null), TypeError);
  assert.throws(() => L.categorize({ question: qCapital }), TypeError);
});

test('precedence follows the §5.2 table order', () => {
  const retention = { kind: 'retention', earlier: [{ topicId: 't1', kind: 'final', correct: true }] };
  // dontKnow beats misconception (confidence 3 alongside "I don't know")
  assert.equal(L.categorize(answer(qCapital, { dontKnow: true, confidence: 3 })), 'not_known');
  // dontKnow beats forgotten
  assert.equal(L.categorize(answer(qTf, { dontKnow: true }), retention), 'not_known');
  // misconception beats confusion
  const confusedSure = answer(qCapital, { choice: ['b'], confidence: 3 });
  assert.equal(L.categorize(confusedSure, { siblings: [qRiver] }), 'misconception');
  // confusion beats partial (swapped matching with partial score)
  assert.equal(L.categorize(answer(qMatch, { pairs: [['a', 'y'], ['b', 'x'], ['c', 'z']], confidence: 3 })), 'confusion');
  // partial beats recognition_only
  const recog = answer(qCapital, { choice: ['a'] });
  const partialRecall = answer(qExplain, { text: 'Half.' }, { score: 1, max: 2, status: 'graded' });
  assert.equal(L.categorize(partialRecall, { answers: [recog] }), 'partial');
  // a partial answer given with confidence 3 stays partial (misconception needs a score of 0)
  const surePartial = answer(qExplain, { text: 'Half.', confidence: 3 }, { score: 1, max: 2, status: 'graded' });
  assert.equal(L.categorize(surePartial), 'partial');
  // recognition_only beats forgotten
  assert.equal(L.categorize(answer(qTf, { value: false }), { ...retention, answers: [recog] }), 'recognition_only');
  assert.deepEqual([...L.CATEGORIES], ['not_known', 'misconception', 'guess', 'confusion', 'partial', 'recognition_only', 'forgotten', 'incorrect']);
});

// ───────── rankWeakTopics
test('rankWeakTopics: weak by level or misconception, scored by §5.3 formula', () => {
  const topics = [
    { id: 't1', level: 'Proficient' },
    { id: 't2', level: 'Developing' },
    { id: 't3', level: 'Mastered' },
    { id: 't4', level: 'Emerging' },
    { id: 't5' }, // not assessed
  ];
  const answers = [
    { topicId: 't1', category: 'misconception' }, { topicId: 't1', category: null }, { topicId: 't1', category: null }, { topicId: 't1', category: null },
    { topicId: 't2', category: 'incorrect' }, { topicId: 't2', category: 'not_known' }, { topicId: 't2', category: 'guess' }, { topicId: 't2', category: 'partial' },
    { topicId: 't3', category: 'incorrect' },
    { topicId: 't4', category: 'misconception' }, { topicId: 't4', category: 'confusion' },
    { topicId: 't4', category: 'incorrect', pending: true },
    { topicId: 'tX', category: 'incorrect' },
  ];
  const ranked = L.rankWeakTopics({ topics, answers });
  assert.deepEqual(ranked.map(r => r.topicId), ['t4', 't2', 't1', 't5']);
  const by = Object.fromEntries(ranked.map(r => [r.topicId, r]));
  assert.equal(by.t4.score, 1.5); // (1×2 + 1 + 0) / 2
  assert.equal(by.t2.score, 0.75); // (0 + 2 + 1) / 4  (guess counts as correct)
  assert.equal(by.t1.score, 0.5); // (1×2 + 0 + 0) / 4
  assert.equal(by.t5.score, 0);
  assert.deepEqual(by.t1.reasons, ['misconception']);
  assert.deepEqual(by.t4.reasons, ['level', 'misconception']);
  assert.deepEqual(by.t5.reasons, ['level']);
  assert.equal(by.t5.level, 'not_assessed');
  assert.deepEqual({ items: by.t2.items, wrong: by.t2.wrong, notKnown: by.t2.notKnown, misconceptions: by.t2.misconceptions },
    { items: 4, wrong: 2, notKnown: 1, misconceptions: 0 });
});

test('rankWeakTopics: ties broken by topic position', () => {
  const answers = ['a', 'b', 'c'].map(topicId => ({ topicId, category: 'incorrect' }));
  const inOrder = L.rankWeakTopics({ topics: [{ id: 'c', level: 'emerging' }, { id: 'a', level: 'emerging' }, { id: 'b', level: 'emerging' }], answers });
  assert.deepEqual(inOrder.map(r => r.topicId), ['c', 'a', 'b']);
  const explicit = L.rankWeakTopics({ topics: [{ id: 'c', position: 3, level: 'Not assessed' }, { id: 'a', position: 1, level: 'not-assessed' }, { id: 'b', position: 2, level: 'Developing' }], answers });
  assert.deepEqual(explicit.map(r => r.topicId), ['a', 'b', 'c']);
  assert.deepEqual(L.rankWeakTopics({}), []);
  assert.deepEqual(L.rankWeakTopics(null), []);
});

// ───────── nextReview
test('nextReview: Leitner boxes 1→5 with due offsets 1/3/7/14/30 days', () => {
  assert.deepEqual(L.nextReview(1, false, '2026-11-23'), { box: 1, dueOn: '2026-11-24', days: 1 });
  assert.deepEqual(L.nextReview(1, true, '2026-11-23'), { box: 2, dueOn: '2026-11-26', days: 3 });
  assert.deepEqual(L.nextReview(2, true, '2026-11-23'), { box: 3, dueOn: '2026-11-30', days: 7 });
  assert.deepEqual(L.nextReview(3, true, '2026-11-23'), { box: 4, dueOn: '2026-12-07', days: 14 });
  assert.deepEqual(L.nextReview(4, true, '2026-11-23'), { box: 5, dueOn: '2026-12-23', days: 30 });
  assert.deepEqual(L.nextReview(5, true, '2026-11-23'), { box: 5, dueOn: '2026-12-23', days: 30 }, 'box 5 stays 5');
});

test('nextReview: wrong resets to box 1 from any box; inputs', () => {
  for (const box of [1, 2, 3, 4, 5]) assert.deepEqual(L.nextReview(box, false, '2026-12-31'), { box: 1, dueOn: '2027-01-01', days: 1 });
  assert.deepEqual(L.nextReview({ box: 2, correct: true, today: '2028-02-27' }), { box: 3, dueOn: '2028-03-05', days: 7 }, 'object form, leap year');
  assert.equal(L.nextReview(null, true, '2026-11-23').box, 2, 'missing box = 1');
  assert.equal(L.nextReview(9, true, '2026-11-23').box, 5, 'clamped');
  assert.equal(L.nextReview(0, false, '2026-11-23').box, 1);
  assert.equal(L.nextReview(2, 'yes', '2026-11-23').box, 1, 'only true counts as correct');
  assert.equal(L.nextReview(1, true, new Date(2026, 2, 28, 23, 30)).dueOn, '2026-03-31', 'local Date, across a DST change');
  assert.throws(() => L.nextReview(1, true, '2026-02-30'), TypeError);
  assert.throws(() => L.nextReview(1, true, 'tomorrow'), TypeError);
  assert.throws(() => L.nextReview(1, true), TypeError);
});

// ───────── targetedNote
test('targetedNote: snapshot', () => {
  const md = L.targetedNote({
    topic: { title: 'Cell biology' },
    analysisSection: {
      title: 'Membranes',
      description: 'The cell membrane controls what enters and leaves.\n\nIt is made of a lipid bilayer.',
      keyPoints: ['Selectively permeable', 'Phospholipids have a hydrophilic head'],
    },
    missed: [
      {
        prompt: 'What is the membrane made of?', answer: 'Protein only', correctAnswer: 'A lipid bilayer',
        category: 'misconception', explanation: 'Proteins are embedded in the bilayer.',
        source: [{ quote: 'The membrane is a phospholipid bilayer.', section: 'Membranes', page: 12 }],
      },
      { prompt: 'Define osmosis.', answer: '', category: 'not_known', source: [] },
    ],
  });
  assert.equal(md, [
    '# Targeted note: Cell biology',
    '',
    '## What this topic covers',
    '',
    '### Membranes',
    '',
    'The cell membrane controls what enters and leaves.',
    '',
    'It is made of a lipid bilayer.',
    '',
    '### Key points',
    '',
    '- Selectively permeable',
    '- Phospholipids have a hydrophilic head',
    '',
    '## Your mistakes',
    '',
    '### 1. What is the membrane made of?',
    '',
    '- **You answered:** Protein only',
    '- **Correct answer:** A lipid bilayer',
    '- **Mistake:** Confident but wrong (misconception)',
    '- **Why:** Proteins are embedded in the bilayer.',
    '',
    '**The source says:**',
    '',
    '> The membrane is a phospholipid bilayer.',
    '>',
    '> — Membranes, page 12',
    '',
    '### 2. Define osmosis.',
    '',
    '- **You answered:** _no answer_',
    '- **Mistake:** Did not know',
    '',
  ].join('\n'));
});

test('targetedNote: escapes Markdown control characters in user text', () => {
  const md = L.targetedNote({
    topic: '# Evil *topic*',
    analysisSection: { description: '> quoted\n- list\n```js\nalert(1)\n```', keyPoints: ['1. one', '[link](http://x)', '<script>x</script>'] },
    missed: [{ prompt: '## Heading\nnew line', answer: '**bold** _it_ `code` | pipe ~~strike~~ & amp', source: [{ quote: '> nested\n# heading', section: '[s]', page: '3' }] }],
  });
  assert.ok(md.startsWith('# Targeted note: \\# Evil \\*topic\\*\n'));
  assert.ok(md.includes('\n\\> quoted - list \\`\\`\\`js alert(1) \\`\\`\\`\n'), 'description stays one escaped paragraph');
  assert.ok(md.includes('\n- 1\\. one\n'));
  assert.ok(md.includes('\n- \\[link\\](http://x)\n'));
  assert.ok(md.includes('\n- \\<script\\>x\\</script\\>\n'));
  assert.ok(md.includes('\n### 1. \\#\\# Heading new line\n'));
  assert.ok(md.includes('**You answered:** \\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\| pipe \\~\\~strike\\~\\~ \\& amp\n'));
  assert.ok(md.includes('\n> \\> nested \\# heading\n>\n> — \\[s\\], page 3\n'));
  // no user line may start a block construct
  for (const line of md.split('\n')) assert.ok(!/^(```|<script)/.test(line), line);
  assert.equal(L.escapeMarkdown('+ plus'), '\\+ plus');
  assert.equal(L.escapeMarkdown('12) item'), '12\\) item');
  assert.equal(L.escapeMarkdown(null), '');
});

test('targetedNote: no analysis and no mistakes still gives a valid note', () => {
  assert.equal(L.targetedNote({ topic: { title: '' } }), [
    '# Targeted note: Untitled topic', '', '## What this topic covers', '',
    '_No analysis is available for this topic yet._', '', '## Your mistakes', '', '_No missed questions for this topic._', '',
  ].join('\n'));
  assert.equal(L.targetedNote(), L.targetedNote({}));
});

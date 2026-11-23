const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../src/assessment-model');

// ───────── fixtures (raw questions, as an author or AI would send them)
const base = (type, payload, extra = {}) => ({
  id: `q-${type}`, subjectId: 's1', topicId: 't1', type, prompt: `A ${type} question?`,
  dimension: 'recall', difficulty: 2, explanation: 'Because the notes say so.', payload, ...extra,
});
const raw = {
  choice: () => base('choice', { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], correct: ['b'] }),
  multi: () => base('choice', {
    options: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, text: id.toUpperCase() })), correct: ['a', 'b', 'c'], multiple: true,
  }, { id: 'q-multi', points: 3 }),
  truefalse: () => base('truefalse', { statement: 'Water boils at 100 °C at sea level.', correct: true }),
  justified: () => base('truefalse', { statement: 'The sky is green.', correct: false, requireJustification: true }, { id: 'q-just' }),
  matching: () => base('matching', {
    left: [{ id: 'l1', text: 'H2O' }, { id: 'l2', text: 'NaCl' }, { id: 'l3', text: 'CO2' }, { id: 'l4', text: 'O2' }],
    right: [{ id: 'r1', text: 'water' }, { id: 'r2', text: 'salt' }, { id: 'r3', text: 'carbon dioxide' }, { id: 'r4', text: 'oxygen' }, { id: 'r5', text: 'helium' }],
    pairs: [['l1', 'r1'], ['l2', 'r2'], ['l3', 'r3'], ['l4', 'r4']],
  }),
  essay: () => base('essay', {
    minWords: 50, maxWords: 300, modelAnswer: 'A model essay.',
    rubric: [{ id: 'c1', criterion: 'Defines osmosis', points: 2, keywords: ['membrane', 'water'] }, { id: 'c2', criterion: 'Gives an example', points: 2 }],
  }),
  explain: () => base('explain', { rubric: [{ id: 'k1', criterion: 'Names the cause' }], modelAnswer: 'Because of X.' }),
};
const valid = name => { const r = A.validateQuestion(raw[name]()); assert.ok(r.ok, r.errors.join('\n')); return r.value; };
const errorsOf = q => A.validateQuestion(q).errors;
const hasError = (q, field) => {
  const errors = errorsOf(q);
  assert.ok(errors.some(e => e.startsWith(`${field}:`)), `expected an error on ${field}, got: ${JSON.stringify(errors)}`);
};

// ───────── loading
test('loads with require and as a browser global (window.PerflwAssessmentModel)', async () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'assessment-model.js'), 'utf8');
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  assert.equal(typeof sandbox.PerflwAssessmentModel.validateQuestion, 'function');
  for (const name of ['validateQuestion', 'normalizeResponse', 'grade', 'scoreFromCriteria', 'selectItems', 'stripAnswerKey', 'shuffle']) {
    assert.equal(typeof A[name], 'function', name);
  }
});

// ───────── validateQuestion: common fields
test('a valid question of each type passes and is normalized with defaults', async () => {
  for (const name of Object.keys(raw)) valid(name);
  const q = valid('choice');
  assert.deepEqual(
    { origin: q.origin, status: q.status, review: q.review, points: q.points, provenance: q.provenance, source: q.source, multiple: q.payload.multiple },
    { origin: 'manual', status: 'active', review: 'approved', points: 1, provenance: null, source: [], multiple: false },
  );
  assert.equal(valid('justified').points, 2, 'true/false with justification defaults to 2 points');
  assert.equal(valid('matching').points, 4, 'matching defaults to 1 point per pair');
  assert.equal(valid('essay').points, 4, 'essay defaults to the rubric total');
  assert.equal(valid('explain').payload.maxWords, 120, 'explain maxWords defaults to 120');
  assert.equal(valid('explain').payload.rubric[0].points, 1, 'criterion points default to 1');
});

test('unknown fields are dropped and strings are trimmed', async () => {
  const q = raw.choice();
  q.secret = 'x'; q.payload.extra = 1; q.payload.options[0].hint = 'y'; q.prompt = '  Which one?  ';
  const v = A.validateQuestion(q).value;
  assert.equal(v.secret, undefined);
  assert.equal(v.payload.extra, undefined);
  assert.deepEqual(v.payload.options[0], { id: 'a', text: 'A' });
  assert.equal(v.prompt, 'Which one?');
});

test('common fields are checked with plain-language errors that name the field', async () => {
  assert.deepEqual(A.validateQuestion(null), { ok: false, value: null, errors: ['question: must be an object.'] });
  hasError({ ...raw.choice(), id: '' }, 'id');
  hasError({ ...raw.choice(), subjectId: undefined }, 'subjectId');
  hasError({ ...raw.choice(), type: 'poll' }, 'type');
  hasError({ ...raw.choice(), prompt: '   ' }, 'prompt');
  hasError({ ...raw.choice(), prompt: 'x'.repeat(2001) }, 'prompt');
  hasError({ ...raw.choice(), dimension: 'memory' }, 'dimension');
  hasError({ ...raw.choice(), difficulty: 4 }, 'difficulty');
  hasError({ ...raw.choice(), explanation: 'x'.repeat(2001) }, 'explanation');
  hasError({ ...raw.choice(), points: 0 }, 'points');
  hasError({ ...raw.choice(), points: 21 }, 'points');
  hasError({ ...raw.choice(), origin: 'copied' }, 'origin');
  hasError({ ...raw.choice(), status: 'draft' }, 'status');
  hasError({ ...raw.choice(), review: 'maybe' }, 'review');
  hasError({ ...raw.choice(), payload: null }, 'payload');
  const message = errorsOf({ ...raw.choice(), prompt: 'x'.repeat(2001) })[0];
  assert.match(message, /^prompt: must be at most 2000 characters \(it has 2001\)\.$/);
  assert.equal(A.validateQuestion({ ...raw.choice(), topicId: null }).ok, true, 'topicId may be null (subject-wide)');
  assert.equal(A.validateQuestion({ ...raw.choice(), id: 42, subjectId: 7 }).value.id, 42, 'integer ids are kept');
  assert.equal(A.validateQuestion({ ...raw.choice(), prompt: 'x'.repeat(2001) }).value, null, 'no value when invalid');
});

test('source refs: 0–5, quote ≤ 300 characters, page a positive number', async () => {
  const ref = { fileId: 'f1', docId: null, section: 'Intro', page: 3, quote: 'A quote.' };
  assert.deepEqual(A.validateQuestion({ ...raw.choice(), source: [ref] }).value.source, [ref]);
  hasError({ ...raw.choice(), source: Array(6).fill(ref) }, 'source');
  hasError({ ...raw.choice(), source: [{ ...ref, quote: 'q'.repeat(301) }] }, 'source[0].quote');
  hasError({ ...raw.choice(), source: [{ ...ref, page: 0 }] }, 'source[0].page');
  hasError({ ...raw.choice(), source: ['f1'] }, 'source[0]');
});

test('generated questions need provenance and start unreviewed (D3); manual and template start approved', async () => {
  hasError({ ...raw.choice(), origin: 'generated' }, 'provenance');
  hasError({ ...raw.choice(), origin: 'generated', provenance: { provider: 'ollama', generatedAt: '2026-11-23T10:00:00Z' } }, 'provenance.model');
  hasError({ ...raw.choice(), origin: 'generated', provenance: { provider: 'ollama', model: 'm', generatedAt: 'yesterday' } }, 'provenance.generatedAt');
  const provenance = { provider: 'ollama', model: 'llama3', agentId: 'learning-question-writer', promptVersion: '1', generatedAt: '2026-11-23T10:00:00Z' };
  const gen = A.validateQuestion({ ...raw.choice(), origin: 'generated', provenance });
  assert.ok(gen.ok, gen.errors.join('\n'));
  assert.equal(gen.value.review, 'unreviewed');
  assert.deepEqual(gen.value.provenance, provenance);
  assert.equal(A.validateQuestion({ ...raw.choice(), origin: 'template' }).value.review, 'approved');
  assert.equal(A.validateQuestion({ ...raw.choice(), origin: 'generated', provenance, review: 'approved' }).value.review, 'approved', 'a person can approve');
  assert.equal(A.validateQuestion({ ...raw.choice(), provenance }).value.provenance, null, 'provenance only kept for generated');
});

// ───────── validateQuestion: payloads
test('choice: 2–8 options, unique ids, correct refers to options, single needs exactly one', async () => {
  const p = raw.choice().payload;
  hasError(base('choice', { ...p, options: [{ id: 'a', text: 'A' }] }), 'payload.options');
  hasError(base('choice', { ...p, options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, text: 'x' })), correct: ['o1'] }), 'payload.options');
  hasError(base('choice', { ...p, options: [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }], correct: ['a'] }), 'payload.options[1].id');
  hasError(base('choice', { ...p, options: [{ id: 'a', text: '' }, { id: 'b', text: 'B' }] }), 'payload.options[0].text');
  hasError(base('choice', { ...p, correct: ['z'] }), 'payload.correct[0]');
  hasError(base('choice', { ...p, correct: [] }), 'payload.correct');
  hasError(base('choice', { ...p, correct: ['a', 'b'] }), 'payload.correct');
  hasError(base('choice', { ...p, correct: ['b', 'b'], multiple: true }), 'payload.correct[1]');
  hasError(base('choice', { ...p, multiple: 'yes' }), 'payload.multiple');
  assert.match(errorsOf(base('choice', { ...p, correct: ['z'] }))[0], /"z" is not one of the options/);
});

test('truefalse: statement required, correct must be a boolean', async () => {
  hasError(base('truefalse', { statement: '', correct: true }), 'payload.statement');
  hasError(base('truefalse', { statement: 'S', correct: 'true' }), 'payload.correct');
  hasError(base('truefalse', { statement: 'S', correct: true, requireJustification: 1 }), 'payload.requireJustification');
});

test('matching: 2–10 left, right ≥ left and ≤ 12, one-to-one pairs over existing ids, every left paired', async () => {
  const p = raw.matching().payload;
  hasError(base('matching', { ...p, left: [p.left[0]], pairs: [['l1', 'r1']] }), 'payload.left');
  hasError(base('matching', { ...p, right: p.right.slice(0, 3) }), 'payload.right');
  hasError(base('matching', { ...p, right: Array.from({ length: 13 }, (_, i) => ({ id: `r${i + 1}`, text: 'x' })) }), 'payload.right');
  hasError(base('matching', { ...p, pairs: [['l1', 'r1'], ['l2', 'r2'], ['l3', 'r3'], ['l4', 'r9']] }), 'payload.pairs[3]');
  hasError(base('matching', { ...p, pairs: [['l1', 'r1'], ['l2', 'r1'], ['l3', 'r3'], ['l4', 'r4']] }), 'payload.pairs[1]');
  hasError(base('matching', { ...p, pairs: [['l1', 'r1'], ['l1', 'r2'], ['l3', 'r3'], ['l4', 'r4']] }), 'payload.pairs[1]');
  hasError(base('matching', { ...p, pairs: [['l1', 'r1'], ['l2', 'r2'], ['l3', 'r3']] }), 'payload.pairs');
  hasError(base('matching', { ...p, pairs: undefined }), 'payload.pairs');
  hasError(base('matching', { ...p, pairs: [['l1']] }), 'payload.pairs[0]');
});

test('essay and explain: rubric counts, criterion points, word limits, unique criterion ids', async () => {
  const e = raw.essay().payload;
  const crit = i => ({ id: `c${i}`, criterion: `C${i}` });
  hasError(base('essay', { ...e, rubric: [] }), 'payload.rubric');
  hasError(base('essay', { ...e, rubric: Array.from({ length: 9 }, (_, i) => crit(i)) }), 'payload.rubric');
  hasError(base('explain', { rubric: Array.from({ length: 6 }, (_, i) => crit(i)) }), 'payload.rubric');
  assert.ok(A.validateQuestion(base('explain', { rubric: Array.from({ length: 5 }, (_, i) => crit(i)) })).ok);
  hasError(base('essay', { ...e, rubric: [crit(1), crit(1)] }), 'payload.rubric[1].id');
  hasError(base('essay', { ...e, rubric: [{ id: 'c1', criterion: 'C', points: 0 }] }), 'payload.rubric[0].points');
  hasError(base('essay', { ...e, rubric: [{ id: 'c1', criterion: '' }] }), 'payload.rubric[0].criterion');
  hasError(base('essay', { ...e, minWords: 400, maxWords: 300 }), 'payload.maxWords');
  hasError(base('essay', { ...e, minWords: -1 }), 'payload.minWords');
  hasError(base('explain', { rubric: [crit(1)], maxWords: 0 }), 'payload.maxWords');
  hasError(base('essay', { ...e, rubric: [{ id: 'c1', criterion: 'C', keywords: [''] }] }), 'payload.rubric[0].keywords[0]');
  // a rubric over 20 points needs explicit points
  const big = Array.from({ length: 3 }, (_, i) => ({ ...crit(i), points: 8 }));
  hasError(base('essay', { ...e, rubric: big }), 'points');
  assert.ok(A.validateQuestion(base('essay', { ...e, rubric: big }, { points: 20 })).ok);
});

// ───────── normalizeResponse
test('normalizeResponse keeps only fields of the type, drops unknown ids and caps text at 20,000 characters', async () => {
  const choice = valid('choice');
  assert.deepEqual(A.normalizeResponse(choice, { choice: ['b', 'z', 'b'], text: 'no', confidence: 3, timeMs: 1500.4 }),
    { questionId: 'q-choice', choice: ['b'], confidence: 3, timeMs: 1500 });
  assert.deepEqual(A.normalizeResponse(choice, null), { questionId: 'q-choice', choice: [], timeMs: 0 });
  assert.deepEqual(A.normalizeResponse(choice, { choice: 'a', confidence: 9, timeMs: -5 }).choice, ['a'], 'a single id is accepted');
  assert.equal(A.normalizeResponse(choice, { confidence: 9 }).confidence, undefined);
  assert.equal(A.normalizeResponse(choice, { timeMs: 1e12 }).timeMs, A.LIMITS.timeMs);
  const essay = valid('essay');
  assert.equal(A.normalizeResponse(essay, { text: 'x'.repeat(25000) }).text.length, 20000);
  const just = valid('justified');
  assert.equal(A.normalizeResponse(just, { value: false, justification: 'j'.repeat(20001) }).justification.length, 20000);
  assert.equal(A.normalizeResponse(valid('truefalse'), { value: true, justification: 'j' }).justification, undefined, 'no justification unless required');
  const matching = valid('matching');
  assert.deepEqual(A.normalizeResponse(matching, { pairs: [['l1', 'r1'], ['l1', 'r2'], ['l9', 'r1'], ['l2'], ['l2', 'r2']] }).pairs,
    [['l1', 'r1'], ['l2', 'r2']], 'first pair per left item wins; invalid pairs dropped');
  assert.equal(A.normalizeResponse(choice, { dontKnow: true }).dontKnow, true);
});

// ───────── grade
test('choice single: selected === correct', async () => {
  const q = valid('choice');
  assert.deepEqual(A.grade(q, { choice: ['b'] }), { score: 1, max: 1, status: 'graded' });
  assert.deepEqual(A.grade(q, { choice: ['a'] }), { score: 0, max: 1, status: 'graded' });
  assert.equal(A.grade(q, { choice: ['a', 'b'] }).score, 0, 'two picks on a single-answer question are wrong');
});

test('choice multiple: partial credit (correct − wrong) / correct count, floored at 0', async () => {
  const q = valid('multi'); // correct a,b,c of a–e; 3 points
  assert.equal(A.grade(q, { choice: ['a', 'b', 'c'] }).score, 3);
  assert.equal(A.grade(q, { choice: ['a', 'b'] }).score, 2);
  assert.equal(A.grade(q, { choice: ['a', 'b', 'd'] }).score, 1);
  assert.equal(A.grade(q, { choice: ['a', 'd', 'e'] }).score, 0, 'floored at 0, not −1');
  assert.equal(A.grade(q, { choice: ['d', 'e'] }).score, 0);
  const third = A.validateQuestion({ ...raw.multi(), points: 1 }).value;
  assert.equal(A.grade(third, { choice: ['a'] }).score, 0.33, 'rounded to 2 decimals');
});

test('truefalse: value === correct; a required justification is half the points and goes pending', async () => {
  const q = valid('truefalse');
  assert.deepEqual(A.grade(q, { value: true }), { score: 1, max: 1, status: 'graded' });
  assert.deepEqual(A.grade(q, { value: false }), { score: 0, max: 1, status: 'graded' });
  const j = valid('justified'); // correct false, 2 points
  assert.deepEqual(A.grade(j, { value: false, justification: 'Because it is blue.' }), { score: 1, max: 2, status: 'pending', pendingPoints: 1 });
  assert.deepEqual(A.grade(j, { value: true, justification: 'Because.' }), { score: 0, max: 2, status: 'pending', pendingPoints: 1 });
  assert.deepEqual(A.grade(j, { value: false, justification: '  ' }), { score: 1, max: 2, status: 'graded' }, 'blank justification earns 0 for that half');
});

test('matching: each correct pair = points / pairs, with partial credit', async () => {
  const q = valid('matching'); // 4 pairs, 4 points
  assert.equal(A.grade(q, { pairs: [['l1', 'r1'], ['l2', 'r2'], ['l3', 'r3'], ['l4', 'r4']] }).score, 4);
  assert.equal(A.grade(q, { pairs: [['l1', 'r1'], ['l2', 'r3'], ['l3', 'r2'], ['l4', 'r5']] }).score, 1);
  assert.equal(A.grade(q, { pairs: [['l1', 'r1'], ['l2', 'r2']] }).score, 2);
  const six = A.validateQuestion({ ...raw.matching(), points: 6 }).value;
  assert.equal(A.grade(six, { pairs: [['l1', 'r1']] }).score, 1.5);
  assert.equal(A.grade(q, { pairs: [['l1', 'r2']] }).status, 'graded');
});

test('essay and explain return pending', async () => {
  assert.deepEqual(A.grade(valid('essay'), { text: 'My essay.' }), { score: 0, max: 4, status: 'pending' });
  assert.deepEqual(A.grade(valid('explain'), { text: 'Because.' }), { score: 0, max: 1, status: 'pending' });
});

test('dontKnow → not_known and empty → not_answered, for every type', async () => {
  const empties = { choice: { choice: [] }, multi: {}, truefalse: { value: 'yes' }, justified: {}, matching: { pairs: [] }, essay: { text: '   ' }, explain: null };
  for (const name of Object.keys(raw)) {
    const q = valid(name);
    assert.deepEqual(A.grade(q, { dontKnow: true, choice: ['b'], value: true, text: 'x' }), { score: 0, max: q.points, status: 'graded', category: 'not_known' }, name);
    assert.deepEqual(A.grade(q, empties[name]), { score: 0, max: q.points, status: 'graded', category: 'not_answered' }, name);
  }
});

// ───────── scoreFromCriteria
test('scoreFromCriteria: met = full, partly = half, missing = 0, scaled to the question points', async () => {
  const q = valid('essay'); // c1 2 pts, c2 2 pts
  assert.equal(A.scoreFromCriteria(q, [{ id: 'c1', verdict: 'met' }, { id: 'c2', verdict: 'met' }]), 4);
  assert.equal(A.scoreFromCriteria(q, [{ id: 'c1', verdict: 'met' }, { id: 'c2', verdict: 'partly' }]), 3);
  assert.equal(A.scoreFromCriteria(q, [{ id: 'c1', verdict: 'partly' }, { id: 'c2', verdict: 'missing' }]), 1);
  assert.equal(A.scoreFromCriteria(q, { c1: 'met', c2: 'missing' }), 2, 'map form');
  assert.equal(A.scoreFromCriteria(q, [{ id: 'c1', verdict: 'excellent' }, { id: 'zz', verdict: 'met' }]), 0, 'invalid verdicts and unknown ids score nothing');
  assert.equal(A.scoreFromCriteria(q, null), 0);
  const scaled = A.validateQuestion({ ...raw.essay(), points: 10 }).value;
  assert.equal(A.scoreFromCriteria(scaled, { c1: 'met', c2: 'partly' }), 7.5);
  const j = valid('justified');
  assert.deepEqual(A.rubricOf(j).map(r => [r.id, r.points]), [['justification', 1]]);
  assert.equal(A.scoreFromCriteria(j, { justification: 'partly' }), 0.5, 'true/false justification is the other half');
  assert.equal(A.scoreFromCriteria(valid('choice'), { x: 'met' }), 0, 'no rubric → 0');
});

// ───────── shuffle and selectItems
test('shuffle is seeded, stable and does not change its input', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const copy = items.slice();
  const a = A.shuffle(items, 'seed-1');
  assert.deepEqual(A.shuffle(items, 'seed-1'), a);
  assert.notDeepEqual(A.shuffle(items, 'seed-2'), a);
  assert.deepEqual(items, copy);
  assert.deepEqual([...a].sort((x, y) => x - y), copy);
  assert.deepEqual(A.shuffle(null, 1), []);
});

const bank = () => {
  const out = [];
  const dims = ['recognition', 'recall', 'understanding', 'application'];
  for (const topic of ['t1', 't2', 't3']) {
    for (let i = 0; i < 8; i++) {
      out.push({ ...valid('choice'), id: `${topic}-${i}`, topicId: topic, dimension: dims[i % 4] });
    }
  }
  return out;
};
const topicsOf = items => items.map(q => q.topicId);

test('selectItems is deterministic for a seed and covers every topic before repeating one', async () => {
  const questions = bank();
  const pick = seed => A.selectItems({ questions, count: 7, seed, kind: 'final' }).map(q => q.id);
  assert.deepEqual(pick(11), pick(11));
  assert.notDeepEqual(pick(11), pick(12));
  const items = A.selectItems({ questions, count: 7, seed: 3, kind: 'final' });
  assert.equal(items.length, 7);
  assert.deepEqual(topicsOf(items), ['t1', 't2', 't3', 't1', 't2', 't3', 't1']);
  assert.equal(new Set(items.map(q => q.id)).size, 7, 'no repeats');
  assert.deepEqual(topicsOf(A.selectItems({ questions, topics: ['t3', 't1'], count: 4, seed: 3, kind: 'final' })), ['t3', 't1', 't3', 't1'], 'topics filter and order');
  assert.equal(A.selectItems({ questions, seed: 1, kind: 'final' }).length, 24, 'no count → every eligible item');
  assert.equal(A.selectItems({ questions, count: 100, seed: 1, kind: 'final' }).length, 24, 'never more than eligible');
});

test('selectItems spreads dimensions within a topic; a diagnostic starts each topic with recall or higher', async () => {
  const questions = bank();
  for (let seed = 0; seed < 25; seed++) {
    const items = A.selectItems({ questions, topics: ['t1'], count: 4, seed, kind: 'diagnostic' });
    assert.equal(new Set(items.map(q => q.dimension)).size, 4, `four dimensions in four items (seed ${seed})`);
    assert.notEqual(items[0].dimension, 'recognition', `seed ${seed}`);
  }
});

test('selectItems honors exclude, types, dimensions and status', async () => {
  const questions = bank();
  questions[0].status = 'retired';
  const excluded = ['t1-1', 't1-2'];
  const items = A.selectItems({ questions, topics: ['t1'], exclude: excluded, seed: 5, kind: 'final' });
  assert.equal(items.length, 5);
  assert.ok(!items.some(q => excluded.includes(q.id) || q.id === 't1-0'));
  assert.ok(A.selectItems({ questions, dimensions: ['recall'], seed: 1, kind: 'final' }).every(q => q.dimension === 'recall'));
  const mixed = [...questions, { ...valid('essay'), id: 'e1', topicId: 't1' }];
  assert.deepEqual(A.selectItems({ questions: mixed, types: ['essay'], seed: 1, kind: 'final' }).map(q => q.id), ['e1']);
});

test('D3: diagnostic, final and retention use only approved items; practice excludes only rejected', async () => {
  const questions = [
    { ...valid('choice'), id: 'ok', review: 'approved' },
    { ...valid('choice'), id: 'new', review: 'unreviewed' },
    { ...valid('choice'), id: 'no', review: 'rejected' },
  ];
  for (const kind of ['diagnostic', 'final', 'retention', undefined]) {
    assert.deepEqual(A.selectItems({ questions, seed: 1, kind }).map(q => q.id), ['ok'], String(kind));
  }
  assert.deepEqual(A.selectItems({ questions, seed: 1, kind: 'practice' }).map(q => q.id).sort(), ['new', 'ok']);
});

test('practice: due mistakes come first and weak topics get twice the items', async () => {
  const questions = bank();
  const items = A.selectItems({ questions, count: 8, weakTopics: ['t2'], due: ['t3-5', 'zz'], seed: 9, kind: 'practice' });
  assert.equal(items[0].id, 't3-5');
  assert.deepEqual(topicsOf(items).slice(1), ['t1', 't2', 't3', 't2', 't1', 't2', 't3']);
  assert.equal(topicsOf(items).filter(t => t === 't2').length, 3);
});

// ───────── stripAnswerKey (ADR-005)
const KEY_FIELDS = ['correct', 'pairs', 'modelAnswer', 'keywords', 'explanation', 'quote'];
function keyFieldsIn(value, at = '$', found = []) {
  if (Array.isArray(value)) value.forEach((v, i) => keyFieldsIn(v, `${at}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (KEY_FIELDS.includes(k)) found.push(`${at}.${k}`);
      keyFieldsIn(v, `${at}.${k}`, found);
    }
  }
  return found;
}

test('stripAnswerKey: the student view of an in-progress diagnostic or final has no answer key (deep check)', async () => {
  const questions = Object.keys(raw).map(name => ({ ...valid(name), source: [{ fileId: 'f', docId: null, section: 'S', page: 1, quote: 'answer text' }] }));
  assert.ok(keyFieldsIn(questions).length > 0, 'the fixture does contain keys');
  const before = JSON.stringify(questions);
  for (const kind of ['diagnostic', 'final']) {
    const snapshot = { id: 'as1', kind, status: 'in_progress', questions };
    const view = A.stripAnswerKey(snapshot);
    assert.deepEqual(keyFieldsIn(view), [], kind);
    assert.equal(view.kind, kind);
    assert.equal(view.questions.length, questions.length);
  }
  assert.equal(JSON.stringify(questions), before, 'input unchanged');
  assert.deepEqual(keyFieldsIn(A.stripAnswerKey(questions)), [], 'array form');
  assert.deepEqual(keyFieldsIn(A.stripAnswerKey(questions[4])), [], 'single question form');
});

test('stripAnswerKey keeps what the student needs to answer', async () => {
  const [choice, , just, matching, essay] = A.stripAnswerKey(['choice', 'multi', 'justified', 'matching', 'essay'].map(valid));
  assert.deepEqual(choice.payload, { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], multiple: false });
  assert.deepEqual(just.payload, { statement: 'The sky is green.', requireJustification: true });
  assert.equal(matching.payload.right.length, 5);
  assert.deepEqual(essay.payload.rubric, [{ id: 'c1', criterion: 'Defines osmosis', points: 2 }, { id: 'c2', criterion: 'Gives an example', points: 2 }]);
  assert.equal(essay.prompt, 'A essay question?');
  assert.equal(essay.points, 4);
  assert.equal(essay.provenance, undefined);
  // unknown payload fields can't leak (whitelist)
  const leaky = { ...valid('choice'), payload: { ...valid('choice').payload, answer: 'b' } };
  assert.equal(A.stripAnswerKey(leaky).payload.answer, undefined);
  // the copy is independent of the bank question
  choice.payload.options[0].text = 'changed';
  assert.equal(valid('choice').payload.options[0].text, 'A');
});

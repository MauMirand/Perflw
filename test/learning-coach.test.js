'use strict';
/* LS-017/LS-018: the AI jobs with a fake runAgent: valid output is kept, everything doubtful is rejected, the score is code's. */
const test = require('node:test');
const assert = require('node:assert/strict');
const coach = require('../src/learning-coach');
const model = require('../src/assessment-model');

const sections = [
  { number: '1', title: 'Ionic bonds', description: 'Atoms swap electrons and stick together.', keyPoints: ['Ions form when electrons transfer.', 'Opposite charges attract strongly.'] },
  { number: '2', title: 'Covalent bonds', description: 'Atoms share electron pairs.', keyPoints: ['Shared pairs hold atoms together.'] },
];
const excerpts = coach.excerptsOf(sections);
const provenance = { provider: 'ollama-local', model: 'qwen2.5:7b', agentId: 'agent-1', promptVersion: coach.PROMPT_VERSION, generatedAt: '2026-11-24T10:00:00.000Z' };
const ctx = { subjectId: 's1', topicId: 't1', excerpts, provenance };
const good = {
  type: 'truefalse', prompt: 'True or false: ions form by electron transfer?', dimension: 'recognition', difficulty: 1, explanation: 'Because electrons move between atoms.',
  payload: { statement: 'Ions form when electrons transfer.', correct: true, requireJustification: false },
  source: { section: '1', quote: 'Ions form when electrons transfer.' },
};

test('a valid question with a real quote is kept as an unreviewed, attributed draft', () => {
  const { questions, rejected } = coach.parseQuestions(JSON.stringify({ questions: [good] }), ctx);
  assert.equal(rejected.length, 0); assert.equal(questions.length, 1);
  const q = questions[0];
  assert.equal(q.origin, 'generated'); assert.equal(q.review, 'unreviewed', 'D3: a person approves it before pre-tests and finals');
  assert.deepEqual(q.provenance.model, 'qwen2.5:7b'); assert.equal(q.source[0].section, '1');
});

test('JSON in a fence or surrounded by words is accepted; anything else is rejected without a guess', () => {
  const wrapped = `Here you go:\n\`\`\`json\n${JSON.stringify({ questions: [good] })}\n\`\`\`\nHope that helps.`;
  assert.equal(coach.parseQuestions(wrapped, ctx).questions.length, 1);
  for (const text of ['not json at all', '', '{"questions":"nope"}', '[1,2,3]', undefined]) {
    const r = coach.parseQuestions(text, ctx);
    assert.equal(r.questions.length, 0, String(text)); assert.match(r.rejected[0].reason, /usable JSON/);
  }
});

test('a missing, short or invented citation is rejected', () => {
  const cases = {
    'no source': { ...good, source: undefined },
    'empty quote': { ...good, source: { section: '1', quote: '' } },
    'short quote': { ...good, source: { section: '1', quote: 'ions' } },
    'invented quote': { ...good, source: { section: '1', quote: 'Electrons are made of tiny pink elephants.' } },
  };
  for (const [name, bad] of Object.entries(cases)) {
    const r = coach.parseQuestions(JSON.stringify({ questions: [bad] }), ctx);
    assert.equal(r.questions.length, 0, name); assert.match(r.rejected[0].reason, /quote|citation/i, name);
  }
});

test('a question that fails validateQuestion is rejected with the validator reason; the good ones around it survive', () => {
  const broken = { ...good, payload: { statement: 'Ions form when electrons transfer.', correct: 'yes' } };
  const r = coach.parseQuestions(JSON.stringify({ questions: [good, broken, { ...good, difficulty: 9 }, good] }), ctx);
  assert.equal(r.questions.length, 2); assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.every(x => /payload|difficulty/.test(x.reason)));
});

test('generateQuestions: success, nothing to write from, AI unavailable, and an aborted run', async () => {
  const calls = [];
  const ecosystem = { getAgent: () => ({ config: { provider: { connectionId: 'ollama-local' } } }), runAgent: async (userId, args) => { calls.push(args); return /^Answer this question/.test(args.prompt) ? JSON.stringify({ answer: good.payload.correct }) : JSON.stringify({ questions: [good] }); } };
  const agents = { ready: async () => ({ id: 'agent-1', name: 'Writer', model: 'qwen2.5:7b' }) };
  const c = coach.createLearningCoach({ ecosystem, agents, now: () => Date.parse('2026-11-24T10:00:00Z') });
  const out = await c.generateQuestions('u', { subjectId: 's1', topic: { id: 't1', title: 'Ionic bonds' }, sections, types: ['truefalse'], dimensions: ['recognition'], count: 3 });
  assert.equal(out.questions.length, 1); assert.equal(out.provenance.provider, 'ollama-local');
  assert.match(calls[0].prompt, /Write ONE truefalse question[\s\S]*\[1\] Ionic bonds/); assert.equal(calls[0].temperature, 0.5);
  assert.ok(calls.some(c => /^Answer this question/.test(c.prompt) && c.temperature === 0), 'each draft is answered blind and kept only when the key holds');
  await assert.rejects(() => c.generateQuestions('u', { subjectId: 's1', topic: { id: 't1', title: 'X' }, sections: [], types: ['choice'], dimensions: ['recall'], count: 1 }), /no analysed text/);
  const off = coach.createLearningCoach({ ecosystem, agents: { ready: async () => ({ missing: 'No AI model is available.' }) } });
  await assert.rejects(() => off.generateQuestions('u', { subjectId: 's1', topic: { id: 't', title: 'T' }, sections, types: ['choice'], dimensions: ['recall'], count: 1 }), /No AI model is available\. You can still write your own questions/);
  assert.deepEqual(await off.status('u'), { available: false, reason: 'No AI model is available.' });
  assert.equal((await c.status('u')).available, true);
  const aborting = coach.createLearningCoach({ ecosystem: { ...ecosystem, runAgent: async () => { throw new Error('This request was stopped.'); } }, agents });
  await assert.rejects(() => aborting.generateQuestions('u', { subjectId: 's1', topic: { id: 't1', title: 'T' }, sections, types: ['choice'], dimensions: ['recall'], count: 1 }), /stopped/);
});

// ───────── grading
const explain = { id: 'q1', type: 'explain', prompt: 'Why is NaCl hard to melt?', points: 2, payload: { rubric: [{ id: 'c1', criterion: 'Mentions ions', points: 1 }, { id: 'c2', criterion: 'Mentions strong attraction', points: 1 }], modelAnswer: 'Strong ionic attraction.' } };

test('grading: per-criterion verdicts are kept, unknown ids dropped, absent ids count as missing, confidence defaults to low', () => {
  const ok = coach.parseVerdicts(JSON.stringify({ criteria: [{ id: 'c1', verdict: 'met', reason: 'Names ions.' }, { id: 'zzz', verdict: 'met' }], confidence: 'high', score: 99 }), explain);
  assert.equal(ok.ok, true); assert.equal(ok.confidence, 'high');
  assert.deepEqual(ok.verdicts.map(v => [v.id, v.verdict]), [['c1', 'met'], ['c2', 'missing']]);
  assert.equal(coach.parseVerdicts(JSON.stringify({ criteria: [{ id: 'c1', verdict: 'met' }] }), explain).confidence, 'low');
});

test('grading: a model-supplied number is ignored, the score comes from scoreFromCriteria', () => {
  const parsed = coach.parseVerdicts(JSON.stringify({ criteria: [{ id: 'c1', verdict: 'met' }, { id: 'c2', verdict: 'partly' }], score: 2, total: 2, confidence: 'medium' }), explain);
  assert.equal(model.scoreFromCriteria(explain, parsed.verdicts), 1.5, '1 + 0.5 of 2 points, not the 2 the model claimed');
});

test('grading: unusable output keeps the answer pending (no guessed score)', () => {
  for (const text of ['no json', '{"criteria":[]}', '{"criteria":[{"id":"c1","verdict":"great"}]}', '{"criteria":"x"}']) assert.equal(coach.parseVerdicts(text, explain).ok, false, text);
});

test('gradeOpenAnswer: prompt carries the rubric but not a score request; failures say what happens next', async () => {
  let prompt = '';
  const agents = { ready: async () => ({ id: 'g', name: 'Grader', model: 'm' }) };
  const ecosystem = { getAgent: () => ({ config: { provider: { connectionId: 'ollama-local' } } }), runAgent: async (u, args) => { prompt = args.prompt; return JSON.stringify({ criteria: [{ id: 'c1', verdict: 'met' }, { id: 'c2', verdict: 'met' }], confidence: 'high' }); } };
  const c = coach.createLearningCoach({ ecosystem, agents });
  const out = await c.gradeOpenAnswer('u', { question: explain, answerText: 'Ions attract strongly.', sections });
  assert.equal(out.ok, true); assert.match(prompt, /c1: Mentions ions/); assert.match(prompt, /Do not give a score/); assert.equal(out.provenance.model, 'm');
  await assert.rejects(() => c.gradeOpenAnswer('u', { question: explain, answerText: '   ', sections }), /no answer to grade/);
  await assert.rejects(() => c.gradeOpenAnswer('u', { question: { ...explain, payload: {} }, answerText: 'x', sections }), /no rubric/);
  const bad = coach.createLearningCoach({ ecosystem: { ...ecosystem, runAgent: async () => 'rubbish' }, agents });
  await assert.rejects(() => bad.gradeOpenAnswer('u', { question: explain, answerText: 'x', sections }), /stays waiting; you can grade it yourself/);
});

// ───────── side-note help (D8) and note explanations
test('cleanProse drops empty and NOT_IN_FILE replies and caps the length', () => {
  assert.equal(coach.cleanProse('', 100), null); assert.equal(coach.cleanProse('NOT_IN_FILE', 100), null); assert.equal(coach.cleanProse('  not_in_file.  ', 100), null);
  assert.equal(coach.cleanProse('GAPS:\n- one', 100), 'GAPS:\n- one');
  assert.ok(coach.cleanProse('x'.repeat(500), 100).length <= 100);
});

test('checkNote: reads the note against the excerpts, never rewrites it, and refuses when the file does not relate', async () => {
  let prompt = '';
  const agents = { ready: async (u, role) => { assert.equal(role, 'assistant'); return { id: 'as', name: 'Assistant', model: 'm' }; } };
  const make = reply => coach.createLearningCoach({ ecosystem: { getAgent: () => ({ config: { provider: { connectionId: 'ollama-local' } } }), runAgent: async (u, args) => { prompt = args.prompt; return reply; } }, agents });
  const out = await make('GAPS:\n- Lattices are missing.\nUNCLEAR:\n- none').checkNote('u', { noteText: 'Ions attract.', sections });
  assert.match(out.text, /^GAPS:/); assert.equal(out.provenance.model, 'm');
  assert.match(prompt, /Do NOT rewrite the note/); assert.match(prompt, /NOTE: Ions attract\./);
  await assert.rejects(() => make('NOT_IN_FILE').checkNote('u', { noteText: 'Cats.', sections }), /Nothing in your file relates/);
  await assert.rejects(() => make('x').checkNote('u', { noteText: '  ', sections }), /note is empty/);
  await assert.rejects(() => make('x').checkNote('u', { noteText: 'Ions.', sections: [] }), /no analysed text/);
});

test('explainMistakes: grounded explanation, or null when the file does not cover it', async () => {
  const agents = { ready: async () => ({ id: 'as', name: 'A', model: 'm' }) };
  const make = reply => coach.createLearningCoach({ ecosystem: { getAgent: () => ({ config: { provider: { connectionId: 'x' } } }), runAgent: async () => reply }, agents });
  assert.match((await make('Ions attract [1].').explainMistakes('u', { topicTitle: 'Ionic', missed: ['Why?'], sections })).text, /Ions attract/);
  assert.equal(await make('NOT_IN_FILE').explainMistakes('u', { topicTitle: 'Ionic', missed: ['Why?'], sections }), null);
  assert.equal(await make('x').explainMistakes('u', { topicTitle: 'Ionic', missed: [], sections }), null);
  assert.equal(await make('x').explainMistakes('u', { topicTitle: 'Ionic', missed: ['Why?'], sections: [] }), null);
});

test('writeQuestions: every uncovered fact once (up to the cap), facts already in the bank skipped, nothing left = exhausted', async () => {
  const excerpts = coach.excerptsOf([{ number: '1', title: 'Bonds', description: 'Ionic bonds form by electron transfer between atoms.', keyPoints: ['Covalent bonds share a pair of electrons.', 'Metallic bonds hold ions in a sea of electrons.'] }]);
  const ctx = { subjectId: 's1', topicId: 't1', provenance: { provider: 'test', model: 'm', agentId: 'a', promptVersion: 'p', generatedAt: '2026-11-27T00:00:00.000Z' } };
  const run = async prompt => {
    if (/^Answer this question/.test(prompt)) return '{"answer":true}';
    const fact = (/Ask about THIS fact of the excerpt: "([^"]+)"/.exec(prompt) || [])[1];
    return JSON.stringify({ statement: fact, correct: true, dimension: 'recall', difficulty: 1 });
  };
  const all = await coach.writeQuestions(run, { topicTitle: 'Bonds', excerpts, types: ['truefalse'], dimensions: ['recall'], count: 25, ctx });
  assert.equal(all.questions.length, 3, 'one question per fact, no more, even with a cap of 25');
  assert.equal(new Set(all.questions.map(q => q.payload.statement)).size, 3);
  const rest = await coach.writeQuestions(run, { topicTitle: 'Bonds', excerpts, types: ['truefalse'], dimensions: ['recall'], count: 25, ctx, exclude: ['Covalent bonds share a pair of electrons.'] });
  assert.equal(rest.questions.length, 2, 'a fact the bank already covers is skipped');
  const none = await coach.writeQuestions(run, { topicTitle: 'Bonds', excerpts, types: ['truefalse'], dimensions: ['recall'], count: 25, ctx, exclude: all.questions.map(q => q.source[0].quote) });
  assert.equal(none.questions.length, 0); assert.equal(none.exhausted, true);
});

test('writeQuestions: a question that points at "Slide 19" or "the text" is rejected; generic excerpt titles are hidden from the model', async () => {
  const excerpts = coach.excerptsOf([{ number: '19', title: 'Slide 19', description: 'Managers satisfice when information is incomplete.', keyPoints: [] }]);
  assert.equal(excerpts[0].title, 'Key points');
  const ctx = { subjectId: 's1', topicId: 't1', provenance: { provider: 'test', model: 'm', agentId: 'a', promptVersion: 'p', generatedAt: '2026-11-27T00:00:00.000Z' } };
  const prompts = [];
  const run = async prompt => { prompts.push(prompt); return /^Answer this question/.test(prompt) ? '{"answer":true}' : JSON.stringify({ statement: 'According to the text, managers satisfice when information is incomplete.', correct: true }); };
  const out = await coach.writeQuestions(run, { topicTitle: 'Decisions', excerpts, types: ['truefalse'], dimensions: ['recall'], count: 5, ctx });
  assert.equal(out.questions.length, 0);
  assert.ok(out.rejected.every(r => /instead of standing on its own/.test(r.reason)));
  assert.ok(!/Slide 19/.test(prompts[0]) && /never mention a slide, page/.test(prompts[0]));
});

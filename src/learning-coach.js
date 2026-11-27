'use strict';
/* Learning coach: the two AI jobs of the Learning System, both optional (ADR-007, spec §4.4, §4.8.3, §6.4).

     generateQuestions  a "Learning Question Writer" turns a topic's analysed sections into draft questions.
     gradeOpenAnswer    a "Learning Answer Grader" rates each rubric criterion of a written answer.

   The model is never trusted: question JSON must pass `validateQuestion` and cite a quote that really occurs in the text it was
   given; a grade is only per-criterion verdicts and the SCORE IS COMPUTED BY CODE (`scoreFromCriteria`), a number from the model is
   ignored. Anything unusable is rejected, never guessed. Output is stamped with provider, model, prompt version and time (§6.4).
   `runAgent` is injected, so this module is tested with a fake one and needs no network. */
const model = require('./assessment-model');

const PROMPT_VERSION = 'coach-12';
const fail = message => { throw new Error(message); };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = text => String(text == null ? '' : text).toLowerCase().replace(/[\s ]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
const clip = (text, max) => { const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; };

/* JSON out of a model reply: a bare object, or one inside a ``` fence or surrounded by words. null when there is none. */
function repairJson(t) {
  let x = String(t).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1');
  const opens = (x.match(/{/g) || []).length - (x.match(/}/g) || []).length; const arr = (x.match(/\[/g) || []).length - (x.match(/]/g) || []).length;
  if (opens > 0 || arr > 0) x = x.replace(/,\s*$/, '') + ']'.repeat(Math.max(0, arr)) + '}'.repeat(Math.max(0, opens));
  return x;
}
function extractJson(text) {
  const raw = String(text == null ? '' : text).trim();
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw); if (fenced) candidates.push(fenced[1].trim());
  const first = raw.indexOf('{'); const last = raw.lastIndexOf('}'); if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) { try { const v = JSON.parse(c); if (isObj(v)) return v; } catch { /* try the next */ } }
  for (const c of candidates) { try { const v = JSON.parse(repairJson(c)); if (isObj(v)) return v; } catch { /* try the next */ } }
  return null;
}

// ───────── question generation (spec §4.8.3)
/* The text the writer sees, as numbered excerpts: the quotes in its answer must come from here. */
function excerptsOf(sections) {
  return (sections || []).filter(s => s && s.title).map(s => ({
    ref: String(s.number || s.title), title: s.title,
    text: [s.description, ...(Array.isArray(s.keyPoints) ? s.keyPoints : [])].filter(Boolean).map(t => clip(t, 600)).join(' '),
  })).filter(e => e.text);
}
/* → { questions: [validated drafts], rejected: [{ index, reason }] }. `ctx` = { subjectId, topicId, excerpts, provenance }. */
function parseQuestions(text, ctx) {
  const json = extractJson(text);
  if (!json || !Array.isArray(json.questions)) return { questions: [], rejected: [{ index: -1, reason: 'The model did not return usable JSON.' }] };
  const corpus = ctx.excerpts.map(e => ({ ref: e.ref, text: norm(`${e.title} ${e.text}`) }));
  const questions = []; const rejected = [];
  json.questions.forEach((raw, index) => {
    const src = isObj(raw) && isObj(raw.source) ? raw.source : null;
    const quote = src && typeof src.quote === 'string' ? norm(src.quote) : '';
    if (!quote || quote.length < 12) { rejected.push({ index, reason: 'It cites no usable quote from the text.' }); return; }
    const where = corpus.find(c => c.text.includes(quote));
    if (!where) { rejected.push({ index, reason: 'Its quote is not in the text it was given (an invented citation).' }); return; }
    const draft = {
      id: `ai-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`, subjectId: ctx.subjectId, topicId: ctx.topicId, type: raw.type, prompt: raw.prompt,
      dimension: raw.dimension, difficulty: raw.difficulty, explanation: raw.explanation == null ? '' : raw.explanation, payload: raw.payload,
      origin: 'generated', review: 'unreviewed', provenance: ctx.provenance,
      source: [{ fileId: ctx.fileId == null ? undefined : ctx.fileId, section: clip(`${where.ref}`, 200), quote: clip(String(src.quote), 300) }],
    };
    const checked = model.validateQuestion(draft);
    if (!checked.ok) { rejected.push({ index, reason: checked.errors[0] }); return; }
    questions.push(checked.value);
  });
  return { questions, rejected };
}

/* ───────── question-writing pipeline v2 (benchmark loop, 2026-11-27), shared by the app and test/qgen-bench.js.
   A small local model (3B on a 4 GB GPU) writes far better when each request is ONE question from ONE excerpt with an exact example
   of the JSON, its loose output is tidied before validation, and a second short request checks the answer key against the excerpt.
   `run(prompt, { temperature })` returns the model's reply text. → { questions, rejected, calls }. */
const SKILL_HINT = {
  recognition: 'the student picks or recognises the right fact',
  recall: 'the student states a fact from memory',
  understanding: 'the student explains why or how, or tells two ideas apart',
  application: 'the student uses the idea in a new, concrete case',
};
/* Reply schemas (Ollama structured outputs): the model can only produce this shape, so no reply is lost to broken JSON. */
const STR = { type: 'string' }; const DIM = { type: 'string', enum: ['recognition', 'recall', 'understanding', 'application'] }; const DIFF = { type: 'integer', enum: [1, 2, 3] };
const SCHEMA = {
  choice: { type: 'object', properties: { prompt: STR, dimension: DIM, difficulty: DIFF, options: { type: 'array', items: STR, minItems: 4, maxItems: 4 }, correct: { type: 'string', enum: ['a', 'b', 'c', 'd'] } }, required: ['prompt', 'options', 'correct'] },
  truefalse: { type: 'object', properties: { statement: STR, correct: { type: 'boolean' }, dimension: DIM, difficulty: DIFF }, required: ['statement', 'correct'] },
  explain: { type: 'object', properties: { prompt: STR, dimension: DIM, difficulty: DIFF, rubric: { type: 'array', items: STR, minItems: 2, maxItems: 3 } }, required: ['prompt', 'rubric'] },
  solveChoice: { type: 'object', properties: { answer: { type: 'string', enum: ['a', 'b', 'c', 'd', 'e', 'f'] } }, required: ['answer'] },
  solveTf: { type: 'object', properties: { answer: { type: 'boolean' } }, required: ['answer'] },
};
const EXAMPLE = { // about bees, on purpose: an example from another subject cannot be copied into a real question
  choice: '{"prompt":"Which task does a worker bee do that a drone does not?","dimension":"recognition","difficulty":2,"options":["Mate with the queen","Collect nectar and pollen","Lay eggs in the comb","Leave the hive only in winter"],"correct":"b"}',
  truefalse: '{"statement":"A colony usually has several queens laying eggs at the same time.","correct":false,"dimension":"recall","difficulty":1}',
  explain: '{"prompt":"Explain how bees keep the hive warm in winter.","dimension":"understanding","difficulty":2,"rubric":["Says the bees cluster together","Says they shiver their flight muscles to make heat"]}',
};
const TYPE_RULES = {
  choice: 'Exactly 4 options with ids a, b, c, d. Exactly ONE option is correct according to the excerpt. Each of the other three must be FALSE according to the excerpt (it contradicts what the excerpt says); never use another true fact from the excerpt as a wrong option. The right option must not repeat the question. Put it in a random position. No "all of the above".',
  truefalse: 'The statement is ONE short sentence with ONE fact. Make it FALSE about half the time by swapping that fact for a wrong one (a direction, a name, a number, an effect); do not just add "not". Otherwise TRUE, reworded. "correct" must match. Set "prompt" to "True or false?".',
  explain: 'Ask the student to explain one idea of the excerpt. The rubric has 2 or 3 criteria, each one fact the excerpt states, 1 point each.',
};
const CAUSAL = /\b(because|so that|so|since|therefore|creates?|causes?|leads? to|lets?|pushes|raises|makes)\b/i;
function stemHint(dimension, excerpt) {
  if (dimension === 'application') return '"A ..." describing a short new situation, then ask what happens or which idea applies';
  if (dimension === 'understanding') return CAUSAL.test(excerpt.text) ? '"Why", "How" or "What happens when"' : '"What happens when", "How does" or "Which statement best describes"';
  if (dimension === 'recall') return '"What", "Which" or "Name"';
  return '"Which", "What" or "According to the text"';
}
function buildOneQuestionPrompt({ topicTitle, excerpt, type, dimension, difficulty, avoid, fact }) {
  return `Write ONE ${type} question about "${topicTitle}" for a student, using ONLY this excerpt:

[${excerpt.ref}] ${excerpt.title}: ${excerpt.text}

${fact ? `Ask about THIS fact of the excerpt: "${fact}"\n` : ''}Skill (dimension): ${dimension} — ${SKILL_HINT[dimension] || ''}. Difficulty: ${difficulty} (1 easy, 2 medium, 3 hard).
Rules: ${TYPE_RULES[type]}
Ask only what the excerpt states. Start the question with ${stemHint(dimension, excerpt)}. Ask "why" only if the excerpt itself gives the reason.
Test the meaning, not a copied phrase: reword it in your own words. Never add a fact that the excerpt does not state.
${avoid.length ? `Do not repeat these questions: ${avoid.map(x => `"${clip(x, 90)}"`).join('; ')}\n` : ''}
Reply with ONE short JSON object in exactly this shape and nothing else, no explanation (this example is about another text):
${EXAMPLE[type]}`;
}
/* The check: the model ANSWERS the question blind from the excerpt (a small model answers far more reliably than it judges); the draft is
   kept only when that answer matches its key. */
function buildSolvePrompt({ excerpt, q }) {
  const p = q.payload || {};
  const ask = q.type === 'choice' ? `QUESTION: ${q.prompt}\n${(p.options || []).map(o => `(${o.id}) ${o.text}`).join('\n')}\nReply with ONE JSON object only: {"answer":"<the letter of the one correct option>"}`
    : `STATEMENT: ${p.statement}\nReply with ONE JSON object only: {"answer":true} if the source says the statement is true, {"answer":false} if the source contradicts it.`;
  return `Answer this question using ONLY the source.

SOURCE [${excerpt.ref}] ${excerpt.title}: ${excerpt.text}

${ask}`;
}
const tokens = text => norm(text).split(' ').filter(w => w.length > 2);
function overlap(a, b) { const A = tokens(a); if (!A.length) return 0; const B = new Set(tokens(b)); return A.filter(w => B.has(w)).length / A.length; }
const sentences = text => String(text || '').split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(x => x.length >= 12);
/* Tidy a small model's loose JSON into the shape validateQuestion expects; anything that cannot be tidied is left for it to reject. */
function tidy(raw, { type, dimension, difficulty, excerpt, fact }) {
  if (!isObj(raw)) return raw;
  const q = { ...raw };
  if (isObj(q.question) && !q.prompt) Object.assign(q, q.question);
  q.type = type;
  const d = Number(q.difficulty); q.difficulty = [1, 2, 3].includes(d) ? d : { easy: 1, medium: 2, hard: 3 }[String(q.difficulty).toLowerCase()] || difficulty;
  q.dimension = model.DIMENSIONS.includes(String(q.dimension).toLowerCase()) ? String(q.dimension).toLowerCase() : dimension;
  q.explanation = typeof q.explanation === 'string' ? q.explanation : '';
  const p = isObj(q.payload) ? { ...q.payload } : {};
  if (type === 'choice') {
    let options = Array.isArray(p.options) ? p.options : Array.isArray(q.options) ? q.options : [];
    options = options.map((o, i) => (isObj(o) ? { id: String(o.id || 'abcdef'[i]).toLowerCase(), text: String(o.text == null ? '' : o.text) } : { id: 'abcdef'[i], text: String(o) }))
      .map(o => ({ ...o, text: o.text.replace(/^\(?[a-f][).:]\s+/i, '').trim() }));
    let correct = p.correct != null ? p.correct : q.correct != null ? q.correct : q.answer;
    correct = (Array.isArray(correct) ? correct : [correct]).map(c => {
      if (typeof c === 'number') return options[c] && options[c].id;
      const t = String(c == null ? '' : c).trim(); const id = t.toLowerCase().replace(/[^a-f]/g, '');
      if (t.length <= 3 && options.some(o => o.id === id)) return id;
      const hit = options.find(o => norm(o.text) === norm(t)); return hit && hit.id;
    }).filter(Boolean);
    q.payload = { options, correct: [...new Set(correct)], multiple: false };
  } else if (type === 'truefalse') {
    const statement = p.statement || q.statement || q.prompt;
    let c = p.correct != null ? p.correct : q.correct != null ? q.correct : q.answer;
    if (typeof c === 'string') c = /^(true|t|yes)$/i.test(c.trim()) ? true : /^(false|f|no)$/i.test(c.trim()) ? false : c;
    q.payload = { statement, correct: c, requireJustification: false };
    q.prompt = 'True or false?';
  } else if (type === 'explain') {
    const rubric = (Array.isArray(p.rubric) ? p.rubric : Array.isArray(q.rubric) ? q.rubric : []).slice(0, 4)
      .map((r, i) => (isObj(r) ? { id: `c${i + 1}`, criterion: String(r.criterion || r.text || ''), points: 1 } : { id: `c${i + 1}`, criterion: String(r), points: 1 }));
    q.payload = { maxWords: Number(p.maxWords) > 0 ? Math.min(400, Number(p.maxWords)) : 120, rubric };
  }
  // The quote: kept when it is really in the excerpt; otherwise the excerpt sentence it overlaps most (a real sentence, never invented).
  const src = isObj(q.source) ? q.source : {};
  const ex = `${excerpt.title} ${excerpt.text}`;
  let quote = typeof src.quote === 'string' ? src.quote : '';
  if (!(norm(quote).length >= 12 && norm(ex).includes(norm(quote)))) {
    const basis = [quote, q.payload && (q.payload.statement || ((q.payload.options || []).find(o => (q.payload.correct || []).includes(o.id)) || {}).text), q.explanation].filter(Boolean).join(' ');
    const best = sentences(excerpt.text).map(x => ({ x, o: overlap(basis, x) })).sort((a, b) => b.o - a.o)[0];
    quote = best && best.o >= 0.25 ? best.x : (fact || (best && best.o > 0.1 ? best.x : ''));
  }
  q.source = { section: excerpt.ref, quote };
  return q;
}
/* Cheap code checks a small model often fails: duplicate or blank options, the key copied into the stem, a giveaway longest option. */
function sanityProblem(q) {
  const p = q.payload || {};
  if (q.type === 'choice') {
    const texts = (p.options || []).map(o => norm(o.text));
    if (texts.length < 3 || texts.some(t => !t) || new Set(texts).size !== texts.length) return 'Its options are missing, blank or repeated.';
  }
  if (q.type === 'truefalse' && typeof p.correct !== 'boolean') return 'It does not say whether the statement is true or false.';
  if (q.type === 'explain' && (p.rubric || []).filter(r => norm(r.criterion)).length < 2) return 'Its rubric has fewer than 2 criteria.';
  if (q.type === 'choice') {
    const key = ((p.options || []).find(o => (p.correct || []).includes(o.id)) || {}).text || '';
    if (key && overlap(key, q.prompt) > 0.7) return 'Its right answer only repeats the question.';
  }
  return null;
}
/* A "why" question needs a reason stated in the excerpt; otherwise the key is a guess or a restatement. */
function whyProblem(q, excerpt) {
  const stem = q.type === 'truefalse' ? '' : String(q.prompt || '');
  return /^\s*(why|explain why|what causes|what is the reason|for what reason)\b/i.test(stem) && !CAUSAL.test(excerpt.text) ? 'It asks why, but the excerpt gives no reason.' : null;
}
function factsOf(excerpts) {
  const lists = excerpts.map(e => sentences(e.text).map(fact => ({ excerpt: e, fact })));
  const out = []; for (let i = 0; out.length < 200 && lists.some(l => l[i]); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}
function planSlots({ excerpts, types, dimensions, count }) {
  const facts = factsOf(excerpts);
  const order = ['choice', 'truefalse', 'choice', 'explain', 'truefalse', 'choice', 'explain'].filter(t => types.includes(t));
  const typeList = order.length ? order : types;
  const dimFor = (t, i) => (t === 'explain' ? ['understanding', 'recall'] : t === 'choice' ? (i % 2 ? ['application', 'recognition'] : ['recognition', 'understanding']) : ['recall', 'recognition']).find(d => dimensions.includes(d)) || dimensions[0];
  return Array.from({ length: count * 2 + 4 }, (_, i) => {
    const type = typeList[i % typeList.length];
    const f = facts.length ? facts[i % facts.length] : { excerpt: excerpts[i % excerpts.length], fact: '' };
    return { type, dimension: dimFor(type, i), difficulty: [2, 1, 2, 3, 2][i % 5], excerpt: f.excerpt, fact: f.fact };
  });
}
async function writeQuestions(run, { topicTitle, excerpts, types, dimensions, count, ctx, check }) {
  const verify = check || run; // the blind answer check can use a faster model (owner: faster generation, 2026-11-27)
  const questions = []; const rejected = []; let calls = 0; const usedFacts = new Set();
  for (const slot of planSlots({ excerpts, types, dimensions, count })) {
    if (questions.length >= count) break;
    const index = calls;
    calls++;
    let text;
    try { text = await run(buildOneQuestionPrompt({ topicTitle, ...slot, avoid: questions.map(x => x.prompt === 'True or false?' ? x.payload.statement : x.prompt) }), { temperature: 0.5, maxTokens: 320, format: SCHEMA[slot.type], think: false }); }
    catch (error) { throw error; } // a stopped or failed model ends the request, as before
    let raw = extractJson(text);
    if (!raw) { calls++; raw = extractJson(await run(`Your last reply was not valid JSON. Reply again with ONLY the JSON object for this request:\n\n${clip(text, 3000)}`, { temperature: 0, maxTokens: 320, format: SCHEMA[slot.type], think: false })); }
    if (!raw) { rejected.push({ index, reason: 'The model did not return usable JSON.' }); continue; }
    const q = tidy(raw.questions && Array.isArray(raw.questions) ? raw.questions[0] : raw, slot);
    const problem = sanityProblem(q) || whyProblem(q, slot.excerpt);
    if (problem) { rejected.push({ index, reason: problem }); continue; }
    const parsed = parseQuestions(JSON.stringify({ questions: [q] }), { ...ctx, excerpts });
    if (!parsed.questions.length) { rejected.push({ index, reason: (parsed.rejected[0] || {}).reason || 'Rejected.' }); continue; }
    const draft = parsed.questions[0];
    const key = draft.prompt === 'True or false?' ? draft.payload.statement : draft.prompt;
    if (questions.some(x => overlap(key, x.prompt === 'True or false?' ? x.payload.statement : x.prompt) > 0.8)) { rejected.push({ index, reason: 'It repeats an earlier question.' }); continue; }
    if (draft.type === 'explain') {
      // Rubric = the excerpt sentences that ANSWER the question: ranked by the model's points and the question, skipping the sentence
      // the question only restates (a circular point), at most 3, each a stated fact.
      const pool = sentences(slot.excerpt.text); const premise = pool.filter(x => overlap(x, draft.prompt) > 0.6);
      const crit = (draft.payload.rubric || []).map(r => r.criterion).join(' ');
      const picked = pool.filter(x => !premise.includes(x)).map(x => ({ x, o: overlap(crit, x) * 2 + overlap(draft.prompt, x) })).filter(y => y.o >= 0.35).sort((a, b) => b.o - a.o).slice(0, 3).map(y => y.x);
      draft.payload.rubric = picked.map((x, i) => ({ id: `c${i + 1}`, criterion: clip(`States that ${x.charAt(0).toLowerCase()}${x.slice(1).replace(/\.$/, '')}`, 300), points: 1 }));
      if (draft.payload.rubric.length < 2) { rejected.push({ index, reason: 'Its rubric does not match two facts of the excerpt.' }); continue; }
      const ex = `${slot.excerpt.title} ${slot.excerpt.text}`;
      if (!(draft.payload.rubric || []).every(r => overlap(r.criterion, ex) >= 0.55)) { rejected.push({ index, reason: 'A rubric point is not in the excerpt.' }); continue; }
      if ((draft.payload.rubric || []).some(r => overlap(r.criterion, draft.prompt) > 0.75)) { rejected.push({ index, reason: 'A rubric point only repeats the question.' }); continue; }
    } else {
      calls++;
      const got = extractJson(await verify(buildSolvePrompt({ excerpt: slot.excerpt, q: draft }), { temperature: 0, maxTokens: 24, format: draft.type === 'choice' ? SCHEMA.solveChoice : SCHEMA.solveTf, think: false }));
      const answer = got && got.answer;
      const agrees = draft.type === 'choice' ? String(answer || '').trim().toLowerCase().replace(/[^a-f]/g, '') === String(draft.payload.correct[0])
        : (typeof answer === 'boolean' ? answer : /^true$/i.test(String(answer)) ? true : /^false$/i.test(String(answer)) ? false : null) === draft.payload.correct;
      if (!agrees) { rejected.push({ index, reason: 'Answered blind from the excerpt, the key did not hold.' }); continue; }
    }
    // The proof is the excerpt sentence that best matches the question and its key (the model's own quote can point at the wrong one).
    const pd = draft.payload || {};
    const keyText = draft.type === 'choice' ? ((pd.options || []).find(o => (pd.correct || []).includes(o.id)) || {}).text || ''
      : draft.type === 'truefalse' ? pd.statement : (pd.rubric || []).map(r => r.criterion).join(' ');
    const probe = `${draft.prompt === 'True or false?' ? '' : draft.prompt} ${keyText}`;
    const ranked = sentences(slot.excerpt.text).map(x => ({ x, o: overlap(probe, x) + overlap(keyText, x) })).sort((a, b) => b.o - a.o);
    const proof = (draft.source && draft.source[0] && draft.source[0].quote) || '';
    const sentence = (slot.fact && overlap(probe, slot.fact) >= 0.2 ? slot.fact : null) || (ranked[0] && ranked[0].o > 0.3 ? ranked[0].x : null) || sentences(slot.excerpt.text).find(x => norm(x).includes(norm(proof))) || proof;
    if (sentence && draft.source && draft.source[0]) draft.source[0].quote = clip(sentence, 300);
    if (sentence && usedFacts.has(norm(sentence))) { rejected.push({ index, reason: 'It tests the same fact as an earlier question.' }); continue; }
    if (sentence) usedFacts.add(norm(sentence));
    if (sentence) draft.explanation = clip(`The text says: "${sentence}"`, 600);
    questions.push(draft);
  }
  return { questions, rejected, calls };
}

// ───────── answer grading (spec §4.4)
function buildGradingPrompt({ question, answerText, excerpts }) {
  const rubric = model.rubricOf(question);
  const source = (excerpts || []).map(e => `[${e.ref}] ${e.title}: ${e.text}`).join('\n');
  return `Grade a student's written answer, criterion by criterion. Do not give a score.

QUESTION: ${question.prompt}
${(question.payload && question.payload.modelAnswer) ? `MODEL ANSWER: ${question.payload.modelAnswer}\n` : ''}RUBRIC (id: criterion):
${rubric.map(r => `${r.id}: ${r.criterion}`).join('\n')}
${source ? `SOURCE EXCERPTS:\n${source}\n` : ''}STUDENT ANSWER: ${answerText}

Reply with ONE JSON object and nothing else: {"criteria":[{"id":"<rubric id>","verdict":"met|partly|missing","reason":"<one short sentence>"}],"confidence":"low|medium|high"}
Use "met" only when the answer clearly covers the criterion, "partly" when it half does, otherwise "missing".`;
}
/* → { ok, verdicts: [{ id, verdict, reason }], confidence } | { ok: false, reason }. Unknown ids are dropped; a missing id is `missing`
   only if the model rated at least one; any other shape is rejected so the answer stays pending (never a guessed score). */
function parseVerdicts(text, question) {
  const rubric = model.rubricOf(question);
  const json = extractJson(text);
  if (!json || !Array.isArray(json.criteria)) return { ok: false, reason: 'The model did not return usable JSON.' };
  const given = new Map();
  for (const c of json.criteria) if (isObj(c) && c.id != null && Object.prototype.hasOwnProperty.call(model.VERDICTS, c.verdict)) given.set(String(c.id), { verdict: c.verdict, reason: clip(c.reason, 300) });
  if (!given.size) return { ok: false, reason: 'The model rated none of the criteria.' };
  const confidence = ['low', 'medium', 'high'].includes(json.confidence) ? json.confidence : 'low'; // unstated confidence counts as low
  return { ok: true, confidence, verdicts: rubric.map(r => ({ id: String(r.id), ...(given.get(String(r.id)) || { verdict: 'missing', reason: 'Not rated by the model.' }) })) };
}

// ───────── side-note help (D8, LS-032) and explanations in targeted notes (LS-019): plain text, grounded in the file's excerpts
const NOT_IN_FILE = 'NOT_IN_FILE';
function buildNoteHelpPrompt({ noteText, excerpts }) {
  const source = excerpts.map(e => `[${e.ref}] ${e.title}: ${e.text}`).join('\n');
  return `A student wrote this note while studying. Review it against the excerpts of their own file. Do NOT rewrite the note.

Reply in plain text with exactly these parts, each a short list of "- " bullets, using only facts from the excerpts:
GAPS: important points from the excerpts the note leaves out
UNCLEAR: statements in the note that are vague or wrong according to the excerpts
EXPLANATION: at most 120 words explaining the idea the note is about
If the excerpts do not relate to the note, reply only ${NOT_IN_FILE}.

NOTE: ${String(noteText).slice(0, 6000)}

EXCERPTS
${source}`;
}
function buildExplainPrompt({ topicTitle, missed, excerpts }) {
  const source = excerpts.map(e => `[${e.ref}] ${e.title}: ${e.text}`).join('\n');
  return `A student missed these questions about "${topicTitle}":
${missed.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Explain, in at most 150 words and using ONLY the excerpts below, what the student should understand to answer them. Put the section number in brackets after each claim, like [1.2]. If the excerpts do not cover it, reply only ${NOT_IN_FILE}.

EXCERPTS
${source}`;
}
/* → the cleaned text, or null when the model refused or said nothing. */
function cleanProse(text, max) {
  const t = String(text == null ? '' : text).replace(/\r/g, '').trim();
  if (!t || new RegExp(`^${NOT_IN_FILE}\\b`, 'i').test(t)) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function createLearningCoach({ ecosystem, agents, now = () => Date.now() }) {
  async function ready(userId, role) {
    const agent = await agents.ready(userId, role);
    if (agent.missing) fail(`${agent.missing} You can still write your own questions and grade your own answers.`);
    return agent;
  }
  /* { available, reason } for the buttons: AI buttons stay visible but disabled with the reason (spec §3.6). */
  async function status(userId) {
    try { const writer = await agents.ready(userId, 'writer'); return writer.missing ? { available: false, reason: writer.missing } : { available: true, reason: '', model: writer.model }; }
    catch (error) { return { available: false, reason: error.message }; }
  }
  async function provenanceFor(userId, role, agent) {
    let provider = 'unknown';
    try { provider = ecosystem.getAgent(userId, agent.id).config.provider.connectionId || 'unknown'; } catch { /* keep unknown */ }
    return { provider, model: agent.model || 'unknown', agentId: agent.id, promptVersion: PROMPT_VERSION, generatedAt: new Date(now()).toISOString() };
  }

  async function generateQuestions(userId, { subjectId, topic, fileId, sections, types, dimensions, count, signal }) {
    const excerpts = excerptsOf(sections);
    if (!excerpts.length) fail('This topic has no analysed text to write questions from. Write your own, or wait until its file is analysed.');
    const agent = await ready(userId, 'writer');
    const provenance = await provenanceFor(userId, 'writer', agent);
    const run = (prompt, { temperature = 0.4, maxTokens, format, think } = {}) => ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt, signal, workflow: null, temperature, maxTokens, format, think });
    const { questions, rejected } = await writeQuestions(run, { topicTitle: topic.title, excerpts, types, dimensions, count, ctx: { subjectId, topicId: topic.id, fileId, provenance } });
    return { questions, rejected, provenance };
  }

  async function gradeOpenAnswer(userId, { question, answerText, sections, signal }) {
    if (!model.rubricOf(question).length) fail('This question has no rubric to grade.');
    if (!String(answerText || '').trim()) fail('There is no answer to grade.');
    const agent = await ready(userId, 'grader');
    const provenance = await provenanceFor(userId, 'grader', agent);
    const prompt = buildGradingPrompt({ question, answerText: String(answerText).slice(0, 8000), excerpts: excerptsOf(sections).slice(0, 12) });
    const text = await ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt, signal, workflow: null, temperature: 0 });
    const parsed = parseVerdicts(text, question);
    if (!parsed.ok) fail(`${parsed.reason} The answer stays waiting; you can grade it yourself.`);
    return { ...parsed, provenance };
  }
  /* Reads the note and its file's excerpts and returns suggestions. It never edits the note (D8): the caller stores the result as
     its own record. */
  async function checkNote(userId, { noteText, sections, signal }) {
    if (!String(noteText || '').trim()) fail('The note is empty.');
    const excerpts = excerptsOf(sections).slice(0, 12);
    if (!excerpts.length) fail('There is no analysed text for this topic to check the note against.');
    const agent = await ready(userId, 'assistant');
    const provenance = await provenanceFor(userId, 'assistant', agent);
    const text = await ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt: buildNoteHelpPrompt({ noteText, excerpts }), signal, workflow: null, temperature: 0.2 });
    const clean = cleanProse(text, 3000);
    if (!clean) fail('Nothing in your file relates to this note, so there is nothing to suggest.');
    return { text: clean, provenance };
  }
  /* A short explanation for a targeted note, from the excerpts only; null when the file does not cover it. */
  async function explainMistakes(userId, { topicTitle, missed, sections, signal }) {
    const excerpts = excerptsOf(sections).slice(0, 12);
    if (!excerpts.length || !missed.length) return null;
    const agent = await ready(userId, 'assistant');
    const provenance = await provenanceFor(userId, 'assistant', agent);
    const text = await ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt: buildExplainPrompt({ topicTitle, missed: missed.slice(0, 8), excerpts }), signal, workflow: null, temperature: 0.2 });
    const clean = cleanProse(text, 1500);
    return clean ? { text: clean, provenance } : null;
  }
  return { status, generateQuestions, gradeOpenAnswer, checkNote, explainMistakes };
}

module.exports = { writeQuestions, createLearningCoach, cleanProse, buildNoteHelpPrompt, buildExplainPrompt, extractJson, excerptsOf, parseQuestions, buildGradingPrompt, parseVerdicts, PROMPT_VERSION };

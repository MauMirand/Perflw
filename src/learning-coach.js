'use strict';
/* Learning coach: the two AI jobs of the Learning System, both optional (ADR-007, spec §4.4, §4.8.3, §6.4).

     generateQuestions  a "Learning Question Writer" turns a topic's analysed sections into draft questions.
     gradeOpenAnswer    a "Learning Answer Grader" rates each rubric criterion of a written answer.

   The model is never trusted: question JSON must pass `validateQuestion` and cite a quote that really occurs in the text it was
   given; a grade is only per-criterion verdicts and the SCORE IS COMPUTED BY CODE (`scoreFromCriteria`), a number from the model is
   ignored. Anything unusable is rejected, never guessed. Output is stamped with provider, model, prompt version and time (§6.4).
   `runAgent` is injected, so this module is tested with a fake one and needs no network. */
const model = require('./assessment-model');

const PROMPT_VERSION = 'coach-1';
const fail = message => { throw new Error(message); };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = text => String(text == null ? '' : text).toLowerCase().replace(/[\s ]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
const clip = (text, max) => { const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; };

/* JSON out of a model reply: a bare object, or one inside a ``` fence or surrounded by words. null when there is none. */
function extractJson(text) {
  const raw = String(text == null ? '' : text).trim();
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw); if (fenced) candidates.push(fenced[1].trim());
  const first = raw.indexOf('{'); const last = raw.lastIndexOf('}'); if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) { try { const v = JSON.parse(c); if (isObj(v)) return v; } catch { /* try the next */ } }
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
function buildQuestionPrompt({ topicTitle, excerpts, types, dimensions, count }) {
  const lines = excerpts.map(e => `[${e.ref}] ${e.title}: ${e.text}`).join('\n');
  return `Write ${count} study questions about the topic "${topicTitle}", using ONLY the excerpts below.

Allowed types: ${types.join(', ')}. Allowed skills (dimension): ${dimensions.join(', ')}. difficulty is 1 (easy), 2 or 3 (hard).
Reply with ONE JSON object and nothing else: {"questions":[ ... ]}. Each question:
- "type", "prompt", "dimension", "difficulty", "explanation" (why the answer is right, from the excerpts)
- "payload": choice {"options":[{"id":"a","text":""},...2-6],"correct":["a"],"multiple":false}; truefalse {"statement":"","correct":true,"requireJustification":false};
  explain {"maxWords":120,"rubric":[{"id":"c1","criterion":"","points":1},...]}
- "source": {"section":"<the [number] of the excerpt>","quote":"<words copied exactly from that excerpt>"}
Never invent a fact. A question without a real quote from an excerpt is rejected.

EXCERPTS
${lines}`;
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
    const prompt = buildQuestionPrompt({ topicTitle: topic.title, excerpts, types, dimensions, count });
    const text = await ecosystem.runAgent(userId, { agent: { id: agent.id, name: agent.name }, prompt, signal, workflow: null, temperature: 0.4 });
    const result = parseQuestions(text, { subjectId, topicId: topic.id, fileId, excerpts, provenance });
    return { ...result, provenance };
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

module.exports = { createLearningCoach, cleanProse, buildNoteHelpPrompt, buildExplainPrompt, extractJson, excerptsOf, buildQuestionPrompt, parseQuestions, buildGradingPrompt, parseVerdicts, PROMPT_VERSION };

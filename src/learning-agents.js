'use strict';
/* The agents and skills the Learning document workflow uses. They are ordinary, editable agent packages and skills
   (Agents and Skills pages); this module creates them once per account and finds them again by id.

     Learning Document Analyzer  — after a file is analyzed, writes a short overview and the key ideas for the
                                   notes panel and the file's .md (skill: learning-key-points).
     Learning Subject Assistant  — answers questions in the topic viewer from the subject's information center
                                   excerpts only, or says NOT_IN_FILE (skill: learning-grounded-answers).

   If a person deletes one, it is created again the next time the workflow needs it. Edits to their files are kept. */
const path = require('node:path');
const { writeFileAtomic, readJsonFile } = require('./safe-file');

const QUESTION_WRITING = `---
name: Learning question writing
description: Write study questions from the excerpts of a student's own file, each with a real quote as its source, as strict JSON.
version: 1
enabled: true
activation: always
triggers: question, quiz, test, exam, write questions
outcome: One JSON object {"questions":[...]} whose questions use only facts and quotes from the given excerpts.
---

# Learning question writing

Use this when you are given a topic and numbered excerpts [1], [2] … of the student's file and asked for questions.

## Steps
1. Read every excerpt. A question may only test something the excerpts state.
2. Pick the requested types and skills (dimension). recognition = pick the right answer; recall = state it; understanding = explain why or how; application = use it in a new case.
3. For every question copy a short quote (at least 12 characters) EXACTLY from one excerpt into "source.quote", and put that excerpt's number in "source.section".
4. choice: 3-5 options, one clearly right, the others plausible but wrong. truefalse: the statement must be true or false by the excerpt. explain: a rubric of 2-4 criteria, 1 point each, each a fact from the excerpt.
5. Never invent a fact, number, name or example. If the excerpts are too thin, return fewer questions.

## Output format (exactly)
One JSON object and nothing else: {"questions":[{"type","prompt","dimension","difficulty","explanation","payload","source":{"section","quote"}}]}
`;
const ANSWER_GRADING = `---
name: Learning answer grading
description: Rate a student's written answer against a rubric, one verdict per criterion, as strict JSON. Never give a score.
version: 1
enabled: true
activation: always
triggers: grade, mark, rubric, answer
outcome: One JSON object {"criteria":[{"id","verdict","reason"}],"confidence"} with a verdict for every rubric criterion.
---

# Learning answer grading

Use this when you receive a question, its rubric and a student's answer.

## Steps
1. Read the rubric criteria. Judge each one on its own.
2. met = the answer clearly covers it; partly = it half does or is vague; missing = it does not.
3. Judge only what the student wrote, not what they might know. Do not reward length.
4. Give a one-sentence reason a student can learn from.
5. confidence: high when the answer is clear-cut, low when it is ambiguous or off-topic.
6. Do NOT output a score or total. The app computes it.

## Output format (exactly)
One JSON object and nothing else: {"criteria":[{"id":"c1","verdict":"met","reason":"..."}],"confidence":"medium"}
`;

const SKILLS = {
  'learning-key-points': {
    name: 'Learning key points',
    file: `---
name: Learning key points
description: Turn an analyzed study file (outline, sections and their text) into a short overview and the key ideas a student must remember.
version: 3
enabled: true
activation: always
triggers: study file, lecture, key points, overview, notes
outcome: An OVERVIEW block of 2-4 sentences and a KEY POINTS list of 4-8 bullets that covers every main section, every statement taken from the given file content.
---

# Learning key points

Use this when you receive an analyzed study file: its title, the numbered outline (1, 1.1, 1.2 …) and the text of each section.

## Steps
1. Read the outline first: the numbered headings are the structure of the file. Then read every section's text.
2. Write the overview: 2-4 plain sentences saying what the file teaches and how its main parts connect.
3. Write the key points in the file's order. Give every main section (1, 2, 3 …) at least one point; add a point for a subsection (1.1, 2.1 …) when it holds a rule, cause, number or result a student is examined on.
4. A good key point is a definition, a rule ("when X rises, Y falls"), a cause and its effect, a process, or a fact with its number or date. Leave out examples, anecdotes and remarks about the lesson.
5. Keep the file's own words for terms, names and numbers. Never add a fact, term, example or number that is not in the given text.
6. Put the section number in brackets after each point, e.g. "… by facilitated diffusion [1.1]". Use only numbers from the outline.

## Output format (exactly)
OVERVIEW:
<2-4 sentences>
KEY POINTS:
- <point> [<section number>]
- <point> [<section number>]

See references/format-examples.md for a worked example.
`,
    references: {
      'references/format-examples.md': `# Example

Input outline: 1 The Cell Membrane, 1.1 Membrane Proteins, 2 The Nucleus …

OVERVIEW:
The lecture describes the main parts of a eukaryotic cell and what each does. It moves from the membrane that controls what enters the cell, to the nucleus that holds DNA, to the mitochondria that make ATP.
KEY POINTS:
- The cell membrane is a selectively permeable phospholipid bilayer [1]
- Channel proteins let ions pass by facilitated diffusion [1.1]
- The nucleus is the control center because it contains DNA [2]
`
    }
  },
  // The AI question and grading helpers are made on first use (only when the student asks for them), not with the core agents.
  'learning-question-writing': { name: 'Learning question writing', file: QUESTION_WRITING, references: {}, optional: true },
  'learning-answer-grading': { name: 'Learning answer grading', file: ANSWER_GRADING, references: {}, optional: true },
  'learning-image-reading': {
    name: 'Learning image reading',
    file: `---
name: Learning image reading
description: Read a picture from a study file (slide, infographic, diagram, table, scanned page) and write down everything it teaches as structured text for the student's notes.
version: 2
enabled: true
activation: always
triggers: image, picture, slide, infographic, diagram, chart, table, scan
outcome: TITLE, TEXT (Markdown-like, in reading order) and a one-sentence SUMMARY, or exactly NO_CONTENT for a decorative picture.
---

# Learning image reading

You receive one picture from a student's study file, with the file name and where it sits (slide or page).

## Steps
1. Look at the whole picture first: is it a slide, an infographic, a diagram, a chart, a table, a photo or a scanned page?
2. If it teaches nothing (a photo, a logo, decoration, a background), reply with exactly NO_CONTENT.
3. Copy every word of readable text exactly as written: titles, labels, numbered steps, definitions, examples, captions. Do not correct, translate or shorten it.
4. Keep the reading order and the structure: the main title, then each panel, column or step in order (left to right, top to bottom). A numbered step keeps its number.
5. Use "## " for the heading of each panel, step or column, "- " for list items, and plain lines for sentences.
6. Tables: write the header row, then one line per row, cells separated by " | ", every number exactly as shown (for example "- CSR (voice) | 80 | 100 | +20"). Keep a table under the heading of the panel it sits in.
7. Diagrams, flows and charts: say in one plain line what they show (for example "Arrows lead from Select the Task to Monitor and Provide Support."). Charts: name the axes and the values you can read.
8. Boxes such as Example, Key findings, Considerations or Result keep their label as a "## " heading, with their content under it.
9. Pictures of people or icons that only decorate a panel are not described.
10. Never invent text you cannot read. If a part is unreadable, write [unreadable].

## Output format (exactly)
TITLE: <the picture's main title, or NONE>
TEXT:
<the content, structured as above>
SUMMARY: <one sentence: what the picture teaches>

or

NO_CONTENT
`,
    references: {}
  },
  'learning-document-structure': {
    name: 'Learning document structure',
    file: `---
name: Learning document structure
description: Find the heading lines of a study file whose headings have no special style or font, so it can be split into numbered topics (1, 2 …) and subtopics (1.1, 1.2 …).
version: 1
enabled: true
activation: always
triggers: structure, headings, outline, topics
outcome: One line per heading, "<level> | <line number>", with level 1 for a topic and 2 for a subtopic, or exactly NONE.
---

# Learning document structure

The request lists the file's source lines, each with its number: [1], [2] … Some of those lines are headings that name the part that follows.

## Steps
1. Read every line first, to see how the file is organized.
2. A heading is a short line (usually under 12 words, often without a final period) that names a part of the file: "Cell Membrane", "Chapter 2 Energy", "Causes of the war".
3. Body sentences, list items, captions, page numbers and running headers are never headings.
4. Level 1 = the main parts. Level 2 = a part inside a main part. Never use more than these 2 levels.
5. Keep the file's order. Use only line numbers that were given. Never rewrite or invent a heading.
6. If the file has no headings at all, reply with exactly NONE.

## Output format (exactly)
1 | 3
2 | 5
2 | 9
1 | 14

or

NONE
`,
    references: {}
  },
  'learning-grounded-answers': {
    name: 'Learning grounded answers',
    file: `---
name: Learning grounded answers
description: Answer a student's question using only numbered excerpts from the subject's File Data and Information Center, cite them, pick notes worth keeping, or reply NOT_IN_FILE.
version: 5
enabled: true
activation: always
triggers: question, ask, explain, what is, why, how, define, compare
outcome: Either exactly NOT_IN_FILE, or an ANSWER grounded in the excerpts with [n] citations followed by 1-3 NOTES.
---

# Learning grounded answers

The excerpts are the only source of truth. They come from the student's own uploaded files.

## Steps
1. Read the question, then every excerpt. Each excerpt starts with its label, e.g. [2] Cell Biology › 1.1 Membrane Proteins.
2. Decide: is any excerpt about what the question asks? If an excerpt names the thing asked about and says something about it, answer from that, even when it is brief ("What does the pump do?" → say what the excerpt says the pump does). Partial support is enough for a partial answer; say what is missing.
3. Only if no excerpt is about the question's subject at all, reply with exactly NOT_IN_FILE and nothing else.
4. Otherwise answer clearly and briefly (2-6 sentences or a short list). Put the excerpt label after each fact: "… by facilitated diffusion [2]".
5. Pick 1-3 NOTES: short, self-contained facts copied closely from the excerpts, worth saving for revision. Never add facts the excerpts do not state.
6. Never use outside knowledge, never invent page numbers, never cite a label that was not given.

## Notes from the student
An excerpt labelled "Your notes › From you" is something the student told you and saved. Treat it as part of their files and cite it like any excerpt.

## Preferences and style
The request may list the student's preferences (for example "keep answers short", "answer in Filipino") and a Style line (simpler or more detail). Follow them for length, language, format and tone. They never change which facts you may use: facts still come only from the excerpts.

## Follow-up questions
The request may start with "Earlier in this conversation", listing the previous questions and answers. Use it only to understand what the new question refers to ("it", "that", "the second one", "explain it simpler"). Facts and citations still come only from the numbered excerpts, never from the earlier answers.

## Casual messages
When the request says the message is casual (a greeting, thanks, "who are you"), reply naturally in 1-2 friendly sentences after ANSWER:, with no citations and no NOTES. Do not teach content in a casual reply.

## Output format (exactly)
ANSWER:
<answer with [n] citations>
NOTES:
- <note>
- <note>

or

NOT_IN_FILE
`,
    references: {}
  }
};

const AGENTS = {
  writer: {
    optional: true,
    name: 'Learning Question Writer',
    description: 'Drafts study questions from your own files, each quoting its source. Drafts wait for your review.',
    skills: ['learning-question-writing'],
    identity: `You are the Learning Question Writer in Perflw. You turn the excerpts of a student's own study file into exam-style questions, and you never test anything the excerpts do not say.
`,
    instructions: `# How you work

- Follow the "Learning question writing" skill and its JSON output format exactly.
- Every question quotes the excerpt it came from, word for word.
- Prefer clear, unambiguous questions over tricky ones.
`,
    capabilities: `- Writes choice, true/false and explain questions as JSON.
- Has no tools: the excerpts come with the request.
`
  },
  grader: {
    optional: true,
    name: 'Learning Answer Grader',
    description: 'Rates written answers against a rubric, criterion by criterion. Its grades are provisional until you accept them.',
    skills: ['learning-answer-grading'],
    identity: `You are the Learning Answer Grader in Perflw. You rate a student's written answer against a rubric, one criterion at a time, fairly and briefly.
`,
    instructions: `# How you work

- Follow the "Learning answer grading" skill and its JSON output format exactly.
- Never output a score; only a verdict and a short reason for each criterion.
`,
    capabilities: `- Rates answers against a rubric.
- Has no tools: the question, rubric and answer come with the request.
`
  },
  reader: {
    name: 'Learning Image Reader',
    description: 'Reads the pictures in study files (slides, infographics, diagrams, scanned pages) so their content reaches the notes and answers.',
    skills: ['learning-image-reading'],
    vision: true,
    identity: `You are the Learning Image Reader in Perflw. You look at one picture from a student's study file at a time and write down, exactly and in order, everything it teaches. You never guess at text you cannot read.
`,
    instructions: `# How you work

- Follow the "Learning image reading" skill and its output format exactly: TITLE:, TEXT:, SUMMARY:, or NO_CONTENT.
- Copy text word for word. Keep numbered steps, panel headings and examples in their order.
- Describe a diagram or chart only by what it shows, in one plain line.
- Never add facts that are not in the picture.
`,
    capabilities: `- Reads text, steps, tables, diagrams and charts in pictures (needs a vision model).
- Has no tools: the picture comes with the request.
`
  },
  analyzer: {
    name: 'Learning Document Analyzer',
    description: 'Writes the overview and key ideas for each study file uploaded on the Learning page.',
    skills: ['learning-key-points'],
    identity: `You are the Learning Document Analyzer in Perflw. You read a study file that has already been converted and structured (title, numbered outline, section key points) and you write what a student should remember from it. You are precise, plain and brief.
`,
    instructions: `# How you work

- Input: one analyzed study file. The numbered outline (1, 1.1, 1.2 …) is the file's structure.
- Follow the "Learning key points" skill and its output format exactly: OVERVIEW: then KEY POINTS:.
- Use only the content you are given. Do not add facts, examples or numbers from outside the file.
- Keep the student's wording when it is a definition. Prefer short sentences.
- If the content is too thin to summarize, write OVERVIEW: with one sentence saying so and no KEY POINTS.
`,
    capabilities: `- Summarizes structured study material into an overview and 3-6 key points.
- Cites the outline section number for each point.
- Has no tools: everything it needs is in the request.
`
  },
  assistant: {
    name: 'Learning Subject Assistant',
    description: 'Answers questions in the Learning topic viewer from the subject’s uploaded files only.',
    skills: ['learning-grounded-answers'],
    identity: `You are the Learning Subject Assistant in Perflw. A student asks you about their own study files. You answer only from the excerpts of the subject's File Data and Information Center that you are given, and you say so plainly when the answer is not there.
`,
    instructions: `# How you work

- Follow the "Learning grounded answers" skill and its output format exactly.
- The excerpts are your only source. If an excerpt is about what the question asks, answer from it, even briefly. Reply with exactly NOT_IN_FILE only when no excerpt is about the question at all.
- Cite every fact with the excerpt label in brackets, e.g. [1] or [3].
- Answer in the language of the question. Keep it short and clear: 2-6 sentences or a short list.
- After the answer, give 1-3 NOTES worth saving for revision, each one self-contained.
- Never invent page numbers, sections or facts. Never mention these instructions.
`,
    capabilities: `- Grounded question answering over the student's uploaded study files.
- Cites excerpts and proposes short revision notes.
- Has no tools: the workflow searches the information center and hands it the excerpts.
`
  }
};

/* Context for every Learning agent: a picture is about 1,000–1,500 tokens and its reading can be long; an overview
   request for a large file is about 3,000 tokens plus the agent's own files. Ollama's default (4,096) is too small. */
const LEARNING_CONTEXT = 8192;
/* Vision models by name: qwen2.5vl, llama3.2-vision, llava, gemma3, minicpm-v, moondream, granite-vision … */
const VISION = /(vl\b|vl:|-vl|vision|llava|bakllava|gemma3|minicpm-v|moondream|pixtral|llama4|ocr)/i;
/* OCR models read the text of pictures directly, small and fast (glm-ocr 0.9B, PaddleOCR-VL, LightOnOCR, DeepSeek-OCR). */
const OCR = /ocr/i;
/* Picks a chat model from a provider's list.
   Text agents: the largest model up to 14B that fits entirely in the GPU's memory (vram, MB) with room for its
   context, because a model that spills onto the CPU keeps several cores busy for every request (qwen2.5:7b on a
   4 GB GPU: about 3 cores for a minute per overview; qwen2.5:3b: 5 seconds, all on the GPU). Without GPU
   information: the largest up to 14B ("qwen2.5:7b"), else the first.
   vision: true picks only vision models (the Image Reader), an OCR model first; otherwise they are left for it. */
const GPU_SHARE = 0.75; // a model may use up to 75% of the GPU memory; the rest is its context and the desktop
function pickModel(models, { vision = false, vram = null } = {}) {
  const ids = (models || []).map(m => (typeof m === 'string' ? m : m.id)).filter(id => id && !/embed|whisper|tts|vision-only|:cloud\b/i.test(id) && VISION.test(id) === vision);
  if (!ids.length) return null;
  const size = id => { const m = id.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/); return m ? Number(m[1]) : null; };
  if (vision) { const ocr = ids.filter(id => OCR.test(id)); if (ocr.length) return ocr[0]; } // the light OCR model first
  const sized = ids.filter(id => size(id) !== null && size(id) <= 14).sort((a, b) => size(b) - size(a));
  if (!vision && vram) {
    const bytesOf = id => { const m = (models || []).find(x => (typeof x === 'string' ? x : x.id) === id); return m && typeof m === 'object' ? Number(m.bytes) || 0 : 0; };
    const fits = sized.filter(id => bytesOf(id) && bytesOf(id) <= vram * 1024 * 1024 * GPU_SHARE);
    if (fits.length) return fits[0];
  }
  return sized[0] || ids[0];
}

function createLearningAgents({ ecosystem, root }) {
  const registryFile = userId => path.join(root, 'learning-files', userId, 'intel', 'agents.json');
  // A held registry throws (it is never read as empty, so the agent ids in it are not overwritten).
  function readRegistry(userId) { const value = readJsonFile(registryFile(userId), {}); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function writeRegistry(userId, value) { writeFileAtomic(registryFile(userId), `${JSON.stringify(value, null, 2)}\n`); }

  function ensureSkills(userId, wanted = []) {
    const existing = new Set(ecosystem.listSkills(userId).map(s => s.id));
    const version = text => Number((String(text).match(/^version:\s*(\d+)/m) || [])[1] || 1);
    for (const [id, def] of Object.entries(SKILLS)) {
      if (def.optional && !wanted.includes(id) && !existing.has(id)) continue;
      if (existing.has(id)) {
        // A newer built-in version replaces an older one (the previous file stays in the skill's .history).
        let current = ''; try { current = ecosystem.readSkillFile(userId, id, 'SKILL.md'); } catch { current = ''; }
        if (current && version(current) < version(def.file)) ecosystem.writeSkillFile(userId, id, 'SKILL.md', def.file);
        continue;
      }
      const created = ecosystem.createSkill(userId, { name: def.name, description: def.file.match(/description: (.+)/)[1] });
      if (created.id !== id) { ecosystem.deleteSkill(userId, created.id); throw new Error(`The skill id ${id} is taken. Rename that skill on the Skills page.`); }
      ecosystem.writeSkillFile(userId, id, 'SKILL.md', def.file);
      for (const [rel, content] of Object.entries(def.references)) ecosystem.writeSkillFile(userId, id, rel, content);
    }
  }

  // GPU memory (MB) from nvidia-smi, asked once; null when there is no NVIDIA GPU or the tool is missing.
  let vramMb;
  async function gpuMemory() {
    if (vramMb !== undefined) return vramMb;
    vramMb = await new Promise(resolve => {
      try {
        require('node:child_process').execFile('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true },
          (error, out) => resolve(error ? null : Math.max(0, ...String(out).split('\n').map(Number).filter(Number.isFinite)) || null));
      } catch { resolve(null); }
    });
    return vramMb;
  }
  let modelCache = null;
  async function chooseModel(userId, vision = false) {
    if (!modelCache || Date.now() - modelCache.at > 60000) {
      let models = null;
      try { const listed = await ecosystem.listModels(userId, 'ollama-local'); if (listed.available) models = listed.models; } catch { models = null; }
      modelCache = { at: Date.now(), models };
    }
    return modelCache.models ? pickModel(modelCache.models, { vision, vram: vision ? null : await gpuMemory() }) : null;
  }

  /* Returns { analyzer, assistant, reader } agent ids, creating whatever is missing. */
  async function ensure(userId, roles = []) {
    ensureSkills(userId, roles.flatMap(role => (AGENTS[role] && AGENTS[role].skills) || []));
    const registry = readRegistry(userId);
    const present = new Set(ecosystem.listAgents(userId).map(a => a.id));
    let changed = false;
    for (const [role, def] of Object.entries(AGENTS)) {
      if (def.optional && !roles.includes(role)) continue;
      if (registry[role] && present.has(registry[role])) continue;
      const model = (await chooseModel(userId, Boolean(def.vision))) || 'unset';
      const agent = ecosystem.createAgent(userId, { name: def.name, description: def.description, connectionId: 'ollama-local', model });
      ecosystem.writeAgentFile(userId, agent.id, 'identity.md', def.identity);
      ecosystem.writeAgentFile(userId, agent.id, 'instructions.md', def.instructions);
      ecosystem.writeAgentFile(userId, agent.id, 'capabilities.md', def.capabilities);
      ecosystem.updateAgentConfig(userId, agent.id, { skills: def.skills, context: { maxSkills: 2, maxContextTokens: LEARNING_CONTEXT } });
      registry[role] = agent.id; changed = true;
    }
    if (changed) writeRegistry(userId, registry);
    return { analyzer: registry.analyzer, assistant: registry.assistant, reader: registry.reader, writer: registry.writer, grader: registry.grader };
  }

  /* The agent for a role when it can run now: { id, name, model } or { missing: reason }. A Learning agent
     still on the placeholder model gets a local model as soon as one is available. */
  async function ready(userId, role) {
    const ids = await ensure(userId, [role]);
    const agent = ecosystem.getAgent(userId, ids[role]);
    let model = agent.config.provider.model;
    const vision = Boolean(AGENTS[role] && AGENTS[role].vision);
    if (!model || model === 'unset') {
      if (agent.config.provider.connectionId !== 'ollama-local') return { missing: `Choose a model for ${agent.name} on the Agents page.`, id: agent.id, name: agent.name };
      modelCache = null;
      model = await chooseModel(userId, vision);
      if (!model) return { missing: vision ? `No vision model is available for ${agent.name}. Run "ollama pull qwen2.5vl:7b", or choose a provider that reads images on the Agents page.` : `No AI model is available for ${agent.name}. Start Ollama with a model, or choose a provider on the Agents page.`, id: agent.id, name: agent.name };
      ecosystem.updateAgentConfig(userId, agent.id, { provider: { connectionId: 'ollama-local', model } });
      { const registry = readRegistry(userId); writeRegistry(userId, { ...registry, models: { ...(registry.models || {}), [role]: model } }); }
    }
    if (!agent.config.context.maxContextTokens) ecosystem.updateAgentConfig(userId, agent.id, { context: { ...agent.config.context, maxContextTokens: LEARNING_CONTEXT } });
    // A Learning agent on a model the app chose itself moves to a better fit when one is installed: the Reader to an
    // OCR model, the text agents to the largest model that runs entirely on the GPU. A model the person picked on the
    // Agents page is kept.
    if (model && model !== 'unset' && agent.config.provider.connectionId === 'ollama-local' && !(vision && OCR.test(model))) {
      const registry = readRegistry(userId);
      const auto = !registry.models || !registry.models[role] || registry.models[role] === model;
      if (auto) {
        modelCache = null;
        const better = await chooseModel(userId, vision);
        if (better && better !== model && (!vision || OCR.test(better))) {
          ecosystem.updateAgentConfig(userId, agent.id, { provider: { connectionId: 'ollama-local', model: better } });
          writeRegistry(userId, { ...registry, models: { ...(registry.models || {}), [role]: better } });
          model = better;
        } else if (!registry.models || !registry.models[role]) writeRegistry(userId, { ...registry, models: { ...(registry.models || {}), [role]: model } });
      }
    }
    const blocking = agent.problems.filter(p => /provider connection|no longer exists/i.test(p.message));
    if (blocking.length) return { missing: blocking[0].message, id: agent.id, name: agent.name };
    return { id: agent.id, name: agent.name, model, ocr: OCR.test(model) && agent.config.provider.connectionId === 'ollama-local' };
  }

  return { ensure, ready, readRegistry };
}

module.exports = { createLearningAgents, pickModel, VISION, OCR, AGENTS, SKILLS };

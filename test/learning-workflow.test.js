const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../src/workspace');
const { createEcosystem } = require('../src/automation/ecosystem');
const { createLearningWorkflow } = require('../src/learning-workflow');
const intel = require('../src/learning-intel');
const { pickModel } = require('../src/learning-agents');

const USER = 'user-a';
const FIXTURES = path.join(__dirname, 'fixtures', 'learning');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name));
const secrets = { available: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };

/* Provider stand-in: `reply(prompt, system)` decides each model answer; `models` is what the local provider lists. */
function fakeProviders({ reply = (_prompt, system) => (/Learning key points/.test(system) ? 'OVERVIEW:\nHow plants make sugar.\nKEY POINTS:\n- Light reactions make ATP [1]' : 'ANSWER:\nok [1]\nNOTES:\n- note'), models = [{ id: 'qwen2.5:1.5b' }, { id: 'qwen2.5:7b' }] } = {}) {
  const calls = [];
  const adapter = {
    listModels: async () => models,
    chat: async ({ messages, system, onDelta }) => {
      const prompt = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
      calls.push({ prompt, system, images: messages.flatMap(m => m.images || []) });
      const text = reply(prompt, system, calls.length);
      if (text instanceof Error) throw text;
      onDelta(text);
      return { text, toolCalls: [], usage: null };
    }
  };
  return { calls, providers: { adapterFor: () => adapter, contextWindow: async () => ({ tokens: 32768, source: 'test' }), supportsTools: async () => false, testConnection: async () => ({ ok: true, message: 'ok', models }) } };
}
function setup(t, providerOptions, workflowOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-learn-'));
  const workspace = createWorkspace(root);
  const fake = fakeProviders(providerOptions);
  const ecosystem = createEcosystem({ root, workspace, secrets, providers: fake.providers });
  const events = [];
  const flow = createLearningWorkflow({ root, workspace, ecosystem, emit: event => events.push(event), ...workflowOptions });
  const subject = workspace.createSubject(USER, 'study', { name: 'Biology', type: 'major' });
  t.after(() => { workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  /* Same steps as main.js importTopicFile: keep the bytes, add the topics, queue the workflow. */
  async function upload(name, as = name) {
    const type = name.split('.').pop();
    const storedName = `${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}.${type}`;
    fs.mkdirSync(path.join(root, 'learning-files', USER), { recursive: true });
    fs.writeFileSync(path.join(root, 'learning-files', USER, storedName), fixture(name));
    const result = workspace.importTopics(USER, subject.id, { name: as, storedName, type, size: 1, text: '' }, [{ title: as, level: 0 }]);
    flow.queueFile(USER, result.fileId);
    await idle(flow);
    return result.fileId;
  }
  return { root, workspace, ecosystem, flow, subject, events, upload, calls: fake.calls };
}
async function idle(flow) { for (let i = 0; i < 400 && !flow.idle(); i++) await new Promise(r => setTimeout(r, 15)); assert.ok(flow.idle(), 'workflow finished'); }

test('Word, PDF and PowerPoint files convert into numbered sections with key points', async () => {
  for (const [name, expectTitle, expectSections] of [
    ['Cell Biology Lecture 1.docx', 'Cell Biology', ['1 The Cell Membrane', '1.1 Membrane Proteins', '1.2 Transport Across the Membrane', '2 The Nucleus', '2.1 Nucleolus', '3 Mitochondria', '3.1 Cristae']],
    ['Cell Biology Lecture 1.pdf', 'Cell Biology', ['1 The Cell Membrane', '1.1 Membrane Proteins', '1.2 Transport Across the Membrane', '2 The Nucleus', '2.1 Nucleolus', '3 Mitochondria', '3.1 Cristae']],
    ['Photosynthesis.pptx', 'Photosynthesis', ['1 Light-dependent Reactions', '2 Calvin Cycle', '3 Limiting Factors']]
  ]) {
    const type = name.split('.').pop();
    const analysis = intel.analyze(await intel.extractBlocks(fixture(name), type), { fileName: name, fileType: type });
    assert.equal(analysis.title, expectTitle, name);
    assert.deepEqual(analysis.sections.filter(s => s.number).map(s => `${s.number} ${s.title}`), expectSections, name);
    for (const s of analysis.sections.filter(s => s.number)) assert.ok(s.description || s.keyPoints.length, `${name} ${s.number} has content`);
    assert.ok(analysis.mainPoints.length >= 3, `${name} main points`);
    assert.ok(!analysis.keywords.includes('undefined'));
    assert.ok(analysis.chunks.length >= expectSections.length, `${name} chunks`);
  }
  const pdf = intel.analyze(await intel.extractBlocks(fixture('Cell Biology Lecture 1.pdf'), 'pdf'), { fileName: 'x.pdf', fileType: 'pdf' });
  assert.match(pdf.sections.find(s => s.number === '1.2').keyPoints.join(' '), /sodium-potassium pump/, 'line-break hyphen kept');
  const slides = intel.analyze(await intel.extractBlocks(fixture('Photosynthesis.pptx'), 'pptx'), { fileName: 'p.pptx', fileType: 'pptx' });
  assert.deepEqual(slides.sections.find(s => s.number === '2').keyPoints.length, 3, 'every bullet of a short slide is a key point');
  assert.equal(slides.sections.find(s => s.number === '2').page, 3, 'slide number kept');
});

test('markdown and plain text structure, similar names, and lookup rules', async () => {
  const md = intel.analyze(await intel.extractBlocks(Buffer.from('# Chemistry\n\n## Atoms\nAn atom is the smallest unit of matter.\n\n### Electrons\n- Electrons have a negative charge.\n\n## Bonds\nCovalent bonds share electrons.'), 'md'), { fileName: 'c.md', fileType: 'md' });
  assert.equal(md.title, 'Chemistry');
  assert.deepEqual(md.sections.filter(s => s.number).map(s => s.number), ['1', '1.1', '2']);
  const txt = intel.analyze(await intel.extractBlocks(Buffer.from('HISTORY NOTES\n\n1 The Renaissance\nThe Renaissance began in Italy.\n\n1.1 Art\nArtists studied anatomy.\n'), 'txt'), { fileName: 't.txt', fileType: 'txt' });
  assert.deepEqual(txt.sections.filter(s => s.number).map(s => `${s.number} ${s.title}`), ['1 The Renaissance', '1.1 Art']);

  const docs = [{ id: 'a', sources: ['Lecture 3 - Cells.pdf'] }, { id: 'b', sources: ['Lecture 4 - Cells.pdf'] }];
  assert.equal(intel.similarDoc('lecture_3_cells_v2.docx', docs)?.id, 'a');
  assert.equal(intel.similarDoc('Lecture 3 - Cells (final).pdf', docs)?.id, 'a');
  assert.equal(intel.similarDoc('Lecture 5 - Cells.pdf', docs), null, 'different numbers never match');
  assert.equal(intel.similarDoc('Genetics overview.pdf', docs), null);

  assert.ok(intel.isOverviewQuestion('Can you summarize this file?'));
  assert.ok(!intel.isOverviewQuestion('What is ATP?'));
  assert.equal(pickModel([{ id: 'nomic-embed-text' }, { id: 'qwen2.5:1.5b' }, { id: 'qwen2.5:7b' }, { id: 'llama3:70b' }]), 'qwen2.5:7b');
});

test('upload creates the file .md and the information center; a similar name updates it; another file creates a new one', async t => {
  const { flow, subject, root, upload, workspace } = setup(t);
  const first = await upload('Cell Biology Lecture 1.docx');
  const a = flow.fileAnalysis(USER, first);
  assert.equal(a.status, 'ready');
  assert.equal(a.title, 'Cell Biology');
  assert.equal(a.action, 'created');
  assert.ok(a.sections.some(s => s.number === '1.1' && s.title === 'Membrane Proteins'));
  const md = fs.readFileSync(a.mdPath, 'utf8');
  assert.match(md, /^# Cell Biology/);
  assert.match(md, /- 1\.1 Membrane Proteins/);
  assert.ok(md.includes(`**Subject information center:** ${a.subjectMdPath}`), 'file .md points at the subject .md');
  assert.ok(a.mdPath.startsWith(path.join(root, 'learning-files', USER, 'intel', subject.id)));

  const second = await upload('Cell Biology Lecture 1.pdf', 'Cell Biology Lecture 1 (v2).pdf');
  const b = flow.fileAnalysis(USER, second);
  assert.equal(b.action, 'updated', 'similar name updates the existing .md');
  assert.equal(b.docId, a.docId);
  assert.deepEqual(b.sources, ['Cell Biology Lecture 1.docx', 'Cell Biology Lecture 1 (v2).pdf']);
  assert.equal(fs.readdirSync(path.dirname(a.mdPath)).filter(n => n.endsWith('.md')).length, 1);

  const third = await upload('Photosynthesis.pptx');
  const c = flow.fileAnalysis(USER, third);
  assert.equal(c.action, 'created');
  assert.notEqual(c.docId, a.docId);
  const center = fs.readFileSync(c.subjectMdPath, 'utf8');
  assert.match(center, /^# Biology — File Data and Information Center/);
  assert.match(center, /\| 1 \| Cell Biology \|/);
  assert.match(center, /\| 2 \| Photosynthesis \|/);
  assert.match(center, /- 2 Calvin Cycle/);

  // The AI overview from the Learning Document Analyzer lands in the .md and the panel data.
  assert.equal(c.enrichStatus, 'ready');
  assert.ok(c.enrichment.overview.length > 0);
  assert.match(fs.readFileSync(c.mdPath, 'utf8'), /## Overview\n\nHow plants make sugar\./);

  // Deleting every topic of a file removes its .md and its row in the information center.
  const ids = workspace.listTopics(USER, subject.id).rows.filter(r => r.fileId === third).map(r => r.id);
  workspace.deleteTopics(USER, subject.id, ids);
  flow.filesRemoved(USER, subject.id, [third]);
  assert.ok(!fs.existsSync(c.mdPath));
  assert.doesNotMatch(fs.readFileSync(c.subjectMdPath, 'utf8'), /Photosynthesis/);
});

test('the Learning agents and skills are created once, editable, and used by the workflow', async t => {
  const { flow, ecosystem, upload, calls } = setup(t);
  await upload('Photosynthesis.pptx');
  const ids = await flow.ensureAgents(USER);
  const agents = ecosystem.listAgents(USER);
  assert.deepEqual(agents.map(a => a.name).sort(), ['Learning Document Analyzer', 'Learning Image Reader', 'Learning Subject Assistant']);
  assert.equal(ecosystem.getAgent(USER, ids.assistant).config.provider.model, 'qwen2.5:7b');
  assert.deepEqual(ecosystem.getAgent(USER, ids.assistant).config.skills, ['learning-grounded-answers']);
  assert.deepEqual(ecosystem.listSkills(USER).map(s => s.id).sort(), ['learning-document-structure', 'learning-grounded-answers', 'learning-image-reading', 'learning-key-points']);
  assert.ok(ecosystem.listSkills(USER).every(s => s.valid && s.enabled && s.activation === 'always'));
  await flow.ensureAgents(USER);
  assert.equal(ecosystem.listAgents(USER).length, 3, 'not created twice');
  assert.match(calls[0].system, /Learning key points/, 'the analyzer ran with its skill loaded');
  // Deleted by the person → created again when needed.
  ecosystem.deleteAgent(USER, ids.assistant);
  const again = await flow.ensureAgents(USER);
  assert.notEqual(again.assistant, ids.assistant);
  assert.equal(ecosystem.listAgents(USER).length, 3);
});

test('questions: grounded answer with sources and saved notes; 2nd run; not in the file; no model', async t => {
  const replies = [];
  const { flow, subject, upload, calls } = setup(t, {
    reply: (prompt, system) => {
      if (/Learning key points/.test(system)) return 'OVERVIEW:\nA file.\nKEY POINTS:\n- point [1]';
      return replies.shift() || 'NOT_IN_FILE';
    }
  });
  const fileId = await upload('Cell Biology Lecture 1.pdf');

  replies.push('ANSWER:\nThe sodium-potassium pump moves 3 Na+ ions out and 2 K+ ions in, using ATP [1]. Unknown [9].\nNOTES:\n- Active transport needs ATP to move substances against their gradient [1]');
  const events = [];
  const answered = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What does the sodium-potassium pump do?' }, e => events.push(e));
  assert.equal(answered.status, 'answered');
  assert.equal(answered.runs, 1);
  assert.match(answered.answer, /3 Na\+ ions out/);
  assert.doesNotMatch(answered.answer, /\[9\]/, 'citations to labels that were not given are removed');
  assert.equal(answered.sources[0].heading, '1.2 Transport Across the Membrane');
  assert.equal(answered.notes.length, 1);
  assert.deepEqual(flow.notes(USER, subject.id).map(n => n.text), ['Active transport needs ATP to move substances against their gradient']);
  assert.match(fs.readFileSync(flow.infoCenterPath(USER, subject.id), 'utf8'), /## Saved notes\n\n- Active transport needs ATP/);
  assert.ok(events.some(e => e.type === 'stage' && e.stage === 'search'));
  const last = calls[calls.length - 1].prompt;
  assert.match(last, /\[1\] Cell Biology › 1\.2 Transport Across the Membrane \(page 1\)/);

  // Model says NOT_IN_FILE on run 1 → 2nd, broad run → answered.
  replies.push('NOT_IN_FILE', 'ANSWER:\nCristae increase the surface area for ATP production [1].\nNOTES:\n- Cristae are folds of the inner membrane [1]');
  const retried = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'Why are the inner membrane folds important for producing energy?' });
  assert.equal(retried.status, 'answered');
  assert.equal(retried.runs, 2);

  // Nothing in the files: no model call at all, the warning from the workflow.
  const before = calls.length;
  const missing = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'Who won the 1998 football world cup?' });
  assert.equal(missing.status, 'not-found');
  assert.equal(missing.warning, 'Your question regarding the file is not included in the file.');
  assert.equal(calls.length, before, 'no model call when the information center has nothing');

  // Model refuses twice → warning after the 2nd run.
  replies.push('NOT_IN_FILE', 'NOT_IN_FILE');
  const refused = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What does the nucleolus do with ribosomes and membranes?' });
  assert.equal(refused.status, 'not-found');
  assert.equal(refused.runs, 2);

  // Overview questions use the analysis itself.
  replies.push('ANSWER:\nThe lecture covers the membrane, nucleus and mitochondria [1].\nNOTES:\n- Three parts of the cell [1]');
  const overview = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'Summarize this file' });
  assert.equal(overview.status, 'answered');
  assert.match(calls[calls.length - 1].prompt, /Main points and outline/);

  flow.deleteNote(USER, subject.id, flow.notes(USER, subject.id)[0].id);
  assert.equal(flow.notes(USER, subject.id).length, 2);
});

test('without any AI model the notes panel still works and answers come from the file text', async t => {
  const { flow, subject, upload } = setup(t, { models: [] });
  const fileId = await upload('Cell Biology Lecture 1.docx');
  const a = flow.fileAnalysis(USER, fileId);
  assert.equal(a.status, 'ready');
  assert.equal(a.enrichStatus, 'unavailable');
  assert.match(a.enrichError, /No AI model is available/);
  const answer = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What is the nucleolus?' });
  assert.equal(answer.status, 'answered');
  assert.equal(answer.mode, 'extractive');
  assert.match(answer.answer, /nucleolus is a dense region/);
  assert.match(answer.notice, /No AI model/);
  const none = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What is photosynthesis?' });
  assert.equal(none.status, 'not-found');
});

test('model output parsing tolerates loose formats', async t => {
  const { flow } = setup(t);
  assert.deepEqual(flow.parseAnswer('NOT_IN_FILE'), { notFound: true });
  assert.deepEqual(flow.parseAnswer('  ANSWER: NOT_IN_FILE '), { notFound: true });
  const loose = flow.parseAnswer('The membrane is selectively permeable [1].');
  assert.equal(loose.notFound, false);
  assert.equal(loose.answer, 'The membrane is selectively permeable [1].');
  assert.deepEqual(flow.parseAnswer('ANSWER:\nYes [1]\nNOTES:\n1. A useful note here\n2) Another useful note').notes, ['A useful note here', 'Another useful note']);
});

test('slide-deck PDFs: one section per slide, running headers dropped, slide pages kept', async () => {
  const deck = intel.analyze(await intel.extractBlocks(fixture('Photosynthesis slides.pdf'), 'pdf'), { fileName: 'Photosynthesis slides.pdf', fileType: 'pdf' });
  assert.equal(deck.title, 'Photosynthesis');
  assert.deepEqual(deck.sections.filter(s => s.number).map(s => `${s.number} ${s.title} p${s.page}`), ['1 Light-dependent Reactions p2', '2 Calvin Cycle p3', '3 Limiting Factors p4']);
  assert.ok(!deck.chunks.some(c => /Plant Biology Unit/.test(c.text) && c.number), 'running header not repeated in slide sections');
  const hits = intel.search('Which enzyme fixes carbon dioxide?', [{ id: 'd', title: deck.title, sources: ['p.pdf'], chunks: deck.chunks }]).hits;
  assert.equal(hits[0].heading, '2 Calvin Cycle');
});

test('casual messages get a normal reply; a model that cannot be reached falls back to the file text', async t => {
  let down = false;
  const { flow, subject, upload, calls } = setup(t, {
    reply: (prompt, system) => {
      if (/Learning key points/.test(system)) return 'OVERVIEW:\nCells.\nKEY POINTS:\n- Membranes [1]';
      if (down) return Object.assign(new Error('Ollama is not running. Start Ollama and try again.'), { kind: 'network' });
      if (/casual message/.test(prompt)) return 'ANSWER:\nHey! Ready to go through your cell biology notes?';
      return 'ANSWER:\nThe nucleolus makes ribosomal RNA [1].\nNOTES:\n- The nucleolus assembles ribosomes [1]';
    }
  });
  const fileId = await upload('Cell Biology Lecture 1.docx');
  assert.ok(intel.isSmallTalk('hello!') && intel.isSmallTalk('thanks so much') && !intel.isSmallTalk('hi, what is ATP?') && !intel.isSmallTalk('tech'));
  const hi = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'hi' });
  assert.equal(hi.status, 'answered');
  assert.equal(hi.kind, 'chat');
  assert.match(hi.answer, /Ready to go through/);
  assert.deepEqual(hi.sources, []);
  assert.equal(flow.notes(USER, subject.id).length, 0, 'casual replies save no notes');
  assert.match(calls[calls.length - 1].prompt, /casual message/);

  const grounded = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What does the nucleolus do?' });
  assert.equal(grounded.sources[0].fileId, fileId, 'sources name their file for the viewer jump');
  assert.ok(grounded.sources[0].text.length > 10);

  down = true;
  const fallback = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What does the nucleolus do?' });
  assert.equal(fallback.status, 'answered');
  assert.equal(fallback.mode, 'extractive');
  assert.match(fallback.notice, /could not reach its AI model/);
  assert.match(fallback.answer, /nucleolus is a dense region/);
  const casualDown = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'thanks!' });
  assert.equal(casualDown.kind, 'chat');
  assert.match(casualDown.answer, /welcome/);
  const missing = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'Explain the French revolution causes' });
  assert.equal(missing.status, 'not-found', 'topic questions outside the files still warn');
});

test('follow-up questions: the previous turn shown in the Ask panel gives the question its meaning', async t => {
  const { flow, subject, upload, calls } = setup(t, {
    reply: (prompt, system) => {
      if (/Learning key points/.test(system)) return 'OVERVIEW:\nCells.\nKEY POINTS:\n- Membranes [1]';
      return /Excerpts/.test(prompt) && /\[1\]/.test(prompt) ? 'ANSWER:\nIt uses ATP to move 3 Na+ out and 2 K+ in [1].\nNOTES:\n- The pump uses ATP [1]' : 'NOT_IN_FILE';
    }
  });
  const fileId = await upload('Cell Biology Lecture 1.pdf');
  assert.ok(intel.isFollowUp('What is it made of?') && intel.isFollowUp('and the second one?') && intel.isFollowUp('explain that simpler'));
  assert.ok(!intel.isFollowUp('What does the nucleolus do?') && !intel.isFollowUp('Which enzyme fixes carbon dioxide?'));

  const first = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What does the sodium-potassium pump do?', requestId: 'r1', history: [] });
  assert.equal(first.status, 'answered');
  assert.equal(first.followUp, false);
  assert.doesNotMatch(calls[calls.length - 1].prompt, /Earlier in this conversation/);

  // "it" means the pump: the search uses the previous question and the prompt carries the earlier turn.
  const second = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What does it need to work?', requestId: 'r2', history: ['r1'] });
  assert.equal(second.status, 'answered');
  assert.equal(second.followUp, true);
  const prompt = calls[calls.length - 1].prompt;
  assert.match(prompt, /Earlier in this conversation[\s\S]*Q1: What does the sodium-potassium pump do\?\nA1: It uses ATP to move 3 Na\+ out and 2 K\+ in\./);
  assert.match(prompt, /Question: What does it need to work\?/);
  assert.match(prompt, /1\.2 Transport Across the Membrane/);

  // Nothing new to search for: the previous excerpts are reused.
  const simpler = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'explain that simpler', requestId: 'r3', history: ['r1', 'r2'] });
  assert.equal(simpler.status, 'answered');
  assert.equal(simpler.followUp, true);
  assert.match(calls[calls.length - 1].prompt, /Q1: What does the sodium-potassium pump do\?[\s\S]*Q2: What does it need to work\?/);

  // A thread the panel no longer shows is not remembered, and unknown ids are ignored.
  const before = calls.length;
  const alone = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'explain that simpler', requestId: 'r4', history: ['nope', 42] });
  assert.equal(alone.status, 'not-found');
  assert.equal(calls.length, before, 'no earlier turn, nothing to search: no model call');
});

test('a file with no heading styles: the Analyzer finds its headings for the notes; the file stays one topic', async t => {
  const { flow, subject, root, workspace, calls } = setup(t, {
    reply: (prompt, system) => {
      if (/Task: find the heading lines/.test(prompt)) {
        assert.match(system, /Learning document structure/, 'the structure skill is loaded for this request');
        const line = text => (prompt.match(new RegExp(String.raw`\[(\d+)\] ${text}`)) || [])[1];
        return `1 | ${line('Cell biology basics')}\n2 | ${line('Proteins in the membrane')}\n1 | ${line('How the nucleus works')}`;
      }
      if (/Learning key points/.test(system)) return 'OVERVIEW:\nCells and their parts.\nKEY POINTS:\n- The membrane controls entry [1]';
      return 'NOT_IN_FILE';
    }
  });
  const text = [
    'Cell biology basics',
    'The cell membrane controls what enters and leaves the cell. It is made of a phospholipid bilayer with proteins.',
    'The membrane is selectively permeable, which means only some substances can cross it freely.',
    'Proteins in the membrane',
    'Channel proteins let ions cross by facilitated diffusion. Carrier proteins change shape to move larger molecules.',
    'How the nucleus works',
    'The nucleus holds the DNA of the cell and is known as the control center. The nucleolus inside it makes ribosomes.',
    'The nuclear envelope is a double membrane with pores that let RNA leave the nucleus.'
  ].join('\n');
  const stored = `${'b'.repeat(32)}.txt`;
  fs.mkdirSync(path.join(root, 'learning-files', USER), { recursive: true });
  fs.writeFileSync(path.join(root, 'learning-files', USER, stored), text);
  const { fileId } = workspace.importTopics(USER, subject.id, { name: 'cells.txt', storedName: stored, type: 'txt', size: text.length, text }, []);
  assert.deepEqual(workspace.listTopics(USER, subject.id).rows.map(r => r.title), ['cells'], 'one placeholder topic on upload');
  flow.queueFile(USER, fileId); await idle(flow);

  const a = flow.fileAnalysis(USER, fileId);
  assert.equal(a.structure, 'ai');
  assert.deepEqual(a.sections.filter(s => s.number).map(s => `${s.number} ${s.title}`), ['1 Cell biology basics', '1.1 Proteins in the membrane', '2 How the nucleus works']);
  assert.match(a.enrichment.overview, /Cells and their parts/, 'the overview is written after the structure');
  assert.deepEqual(workspace.listTopics(USER, subject.id).rows.map(r => r.title), ['cells'], 'the file stays one topic; its headings are in the key points');
  assert.match(fs.readFileSync(a.mdPath, 'utf8'), /## 1 Cell biology basics[\s\S]*### 1\.1 Proteins in the membrane[\s\S]*## 2 How the nucleus works/);

  // Read again (e.g. re-analyze): the AI headings apply again without another model call.
  const before = calls.length;
  flow.reanalyze(USER, fileId); await idle(flow);
  assert.equal(calls.length, before);
  assert.equal(flow.fileAnalysis(USER, fileId).sections.filter(s => s.number).length, 3);
});

test('teaching the assistant: a fact or a preference is suggested, saved only when confirmed, then used in answers', async t => {
  const { flow, subject, upload, calls } = setup(t, {
    reply: (prompt, system) => {
      if (/Learning key points/.test(system)) return 'OVERVIEW:\nCells.\nKEY POINTS:\n- Membranes [1]';
      return /Excerpts/.test(prompt) ? 'ANSWER:\nThe exam covers chapters 1 and 2 [1].\nNOTES:\n- Exam: chapters 1 and 2 [1]' : 'NOT_IN_FILE';
    }
  });
  const fileId = await upload('Cell Biology Lecture 1.pdf');
  const before = calls.length;

  const fact = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'My prof said the final exam covers only chapters 1 and 2 of the membrane unit' });
  assert.equal(fact.kind, 'learn');
  assert.deepEqual({ kind: fact.suggestion.kind, text: fact.suggestion.text }, { kind: 'fact', text: 'My prof said the final exam covers only chapters 1 and 2 of the membrane unit' });
  assert.equal(calls.length, before, 'no model call for a teaching message');
  assert.equal(flow.notes(USER, subject.id).length, 0, 'nothing is saved before the student confirms');

  const pref = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'Please keep answers short' });
  assert.equal(pref.suggestion.kind, 'preference');
  assert.equal((await flow.ask(USER, { subjectId: subject.id, fileId, question: 'Explain the nucleus' })).kind, undefined, 'requests are never teaching');

  flow.saveLearned(USER, { subjectId: subject.id, ...fact.suggestion });
  flow.saveLearned(USER, { subjectId: subject.id, ...pref.suggestion });
  const saved = flow.notes(USER, subject.id).find(n => n.origin === 'user');
  assert.equal(saved.sources[0], 'From you');
  assert.deepEqual(flow.preferences(USER).map(p => p.text), ['keep answers short']);
  assert.match(fs.readFileSync(flow.fileAnalysis(USER, fileId).mdPath, 'utf8'), /\*\*Your note:\*\* My prof said the final exam covers only chapters 1 and 2/);

  // The saved fact is searchable as "Your notes", and the preference reaches the prompt.
  const answer = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'Which chapters does the final exam cover?' });
  assert.equal(answer.status, 'answered');
  const prompt = calls[calls.length - 1].prompt;
  assert.match(prompt, /preferences for how you answer[\s\S]*- keep answers short/);
  assert.match(prompt, /Your notes › From you/);
  assert.ok(answer.sources.some(s => s.docId === 'your-notes'));

  // Simpler / more detail add a style line to the request.
  await flow.ask(USER, { subjectId: subject.id, fileId, question: 'Explain the sodium-potassium pump more simply' });
  assert.match(calls[calls.length - 1].prompt, /Style: explain it more simply/);
  flow.deletePreference(USER, flow.preferences(USER)[0].id);
  assert.equal(flow.preferences(USER).length, 0);
});

test('pictures: an image upload is read by the Image Reader with a vision model, cached, and becomes the notes', async t => {
  const { flow, subject, root, workspace, calls } = setup(t, {
    models: [{ id: 'qwen2.5:7b' }, { id: 'qwen2.5vl:7b' }],
    reply: (prompt, system) => {
      if (/Picture from the study file/.test(prompt)) {
        assert.match(system, /Learning image reading/, 'the image reading skill is loaded');
        return 'TITLE: The Organizing Process\nTEXT:\n## 1 Identify the Work\nDetermine what activities or tasks must be performed to achieve the organizational goals.\n## 2 Divide the Work\nBreak down the main activities into smaller, more specific tasks or jobs.\nSUMMARY: Organizing moves from identifying the work to coordinating activities.';
      }
      if (/Learning key points/.test(system)) return 'OVERVIEW:\nThe steps of organizing.\nKEY POINTS:\n- Identify the work [1.1]';
      return 'NOT_IN_FILE';
    }
  });
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(640, 360); const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#000'; g.font = '32px sans-serif'; g.fillText('The Organizing Process', 40, 80);
  const png = canvas.toBuffer('image/png');
  const stored = `${'c'.repeat(32)}.png`;
  fs.mkdirSync(path.join(root, 'learning-files', USER), { recursive: true });
  fs.writeFileSync(path.join(root, 'learning-files', USER, stored), png);
  const { fileId } = workspace.importTopics(USER, subject.id, { name: 'organizing.png', storedName: stored, type: 'png', size: png.length, text: '' }, []);
  flow.queueFile(USER, fileId); await idle(flow);

  const reads = calls.filter(c => /Picture from the study file/.test(c.prompt));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].images.length, 1); assert.equal(reads[0].images[0].mime, 'image/png');
  const a = flow.fileAnalysis(USER, fileId);
  assert.deepEqual(a.images, { total: 1, read: 1, reading: null, error: '' });
  assert.equal(a.title, 'The Organizing Process');
  assert.deepEqual(a.sections.filter(s => s.number).map(s => `${s.number} ${s.title}`), ['1 The Organizing Process', '1.1 Identify the Work', '1.2 Divide the Work'], 'the picture headings, without their own step numbers');
  assert.match(a.sections.find(s => s.number === '1.1').description, /Determine what activities/);
  assert.match(a.enrichment.overview, /steps of organizing/, 'the overview is written from the picture text');
  assert.match(fs.readFileSync(a.mdPath, 'utf8'), /### 1\.1 Identify the Work/);
  assert.deepEqual(a.sections.find(s => s.number === '1.1').picture, ['Determine what activities or tasks must be performed to achieve the organizational goals.'], 'the full picture text is kept per section');
  assert.match(fs.readFileSync(a.mdPath, 'utf8'), /\*\*From the picture[^*]*:\*\*\n\n\s*- Determine what activities/);
  assert.ok((await flow.ensureAgents(USER)).reader, 'the Learning Image Reader exists');

  // Read again: the cached reading is used, no new model call; questions find the picture text.
  flow.reanalyze(USER, fileId); await idle(flow);
  assert.equal(calls.filter(c => /Picture from the study file/.test(c.prompt)).length, 1, 'cached');
  await flow.ask(USER, { subjectId: subject.id, fileId, question: 'What does dividing the work mean?' });
  assert.match(calls[calls.length - 1].prompt, /Break down the main activities/);
});

test('pictures without a vision model: the notes say which pictures were not read and why', async t => {
  const { flow, subject, root, workspace } = setup(t, { models: [{ id: 'qwen2.5:7b' }] });
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(400, 300); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 300);
  const png = c.toBuffer('image/png');
  const stored = `${'d'.repeat(32)}.png`;
  fs.mkdirSync(path.join(root, 'learning-files', USER), { recursive: true });
  fs.writeFileSync(path.join(root, 'learning-files', USER, stored), png);
  const { fileId } = workspace.importTopics(USER, subject.id, { name: 'scan.png', storedName: stored, type: 'png', size: png.length, text: '' }, []);
  flow.queueFile(USER, fileId); await idle(flow);
  const a = flow.fileAnalysis(USER, fileId);
  assert.equal(a.images.read, 0); assert.equal(a.images.total, 1);
  assert.match(a.images.error, /No vision model is available for Learning Image Reader\. Run "ollama pull qwen2\.5vl:7b"/);
});

test('questions about a page or slide use that page; files analyzed before picture support are read again', async t => {
  const { flow, subject, upload, calls, root } = setup(t, {
    reply: (prompt, system) => (/Learning key points/.test(system) ? 'OVERVIEW:\nCells.\nKEY POINTS:\n- Membranes [1]' : /Excerpts/.test(prompt) ? 'ANSWER:\nPage 2 covers the nucleus [1].' : 'NOT_IN_FILE')
  });
  const fileId = await upload('Cell Biology Lecture 1.pdf');
  const a = flow.fileAnalysis(USER, fileId);
  const onPage = a.sections.filter(s => s.page === 1 && s.number).map(s => s.title);
  assert.ok(onPage.length, 'the sample has sections on page 1');
  const answer = await flow.ask(USER, { subjectId: subject.id, fileId, question: 'what is page 1 all about' });
  assert.equal(answer.status, 'answered');
  const prompt = calls[calls.length - 1].prompt;
  assert.ok(onPage.slice(0, 5).every(title => prompt.includes(title)), 'the sections of that page are the excerpts');
  assert.ok(answer.sources.every(s => s.page === 1), 'sources are on that page');

  // An entry written by the previous analysis version is read again when the notes panel asks for it.
  const statePath = path.join(root, 'learning-files', USER, 'intel', subject.id, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); delete state.files[fileId].version; fs.writeFileSync(statePath, JSON.stringify(state));
  assert.equal(flow.fileAnalysis(USER, fileId).status, 'ready', 'still shown while it is read again');
  await idle(flow);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).files[fileId].version, 2);
});

test('OCR models read pictures directly: plain text becomes panels, labels, bullets and table rows', async t => {
  const OCR_TEXT = 'WORKFORCE PLANNING EXAMPLE\nDetermining the right people, with the right skills, in the right number, at the right time.\n\n1\nANALYZE ORGANIZATIONAL GOALS\nExample:\nA BPO company in Cebu plans to expand its operations and increase its client accounts by 30% next year.\n\nKey Business Goals:\n• Increase client accounts by 30%\n• Improve customer satisfaction to 95%\n\n3\nFORECAST FUTURE WORKFORCE NEEDS\nProjected Workforce Needs\nPosition Current Required Net Increase\nCSR (voice) 80 100 +20\nTotal 123 215 +92';
  const seen = [];
  const { flow, subject, root, workspace, calls } = setup(t, {
    models: [{ id: 'qwen2.5:7b' }, { id: 'qwen2.5vl:7b' }, { id: 'glm-ocr:q8_0' }],
    reply: (prompt, system) => (/Learning key points/.test(system) ? 'OVERVIEW:\nWorkforce planning.\nKEY POINTS:\n- Goals [1]' : /Excerpts/.test(prompt) ? 'ANSWER:\n100 CSR (voice) are required [1].' : 'NOT_IN_FILE')
  }, { ocr: async (model, image) => { seen.push({ model, mime: image.mime }); return OCR_TEXT; } });
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(900, 600); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 600);
  const png = c.toBuffer('image/png');
  const stored = `${'e'.repeat(32)}.png`;
  fs.mkdirSync(path.join(root, 'learning-files', USER), { recursive: true });
  fs.writeFileSync(path.join(root, 'learning-files', USER, stored), png);
  const { fileId } = workspace.importTopics(USER, subject.id, { name: 'workforce.png', storedName: stored, type: 'png', size: png.length, text: '' }, []);
  flow.queueFile(USER, fileId); await idle(flow);

  assert.deepEqual(seen, [{ model: 'glm-ocr:q8_0', mime: 'image/png' }], 'the OCR model reads the picture, once');
  assert.equal(calls.filter(c => /Picture from the study file/.test(c.prompt)).length, 0, 'no general vision model call');
  const a = flow.fileAnalysis(USER, fileId);
  assert.equal(a.title, 'Workforce Planning Example');
  assert.deepEqual(a.sections.filter(s => s.number).map(s => `${s.number} ${s.title}`), ['1 Workforce Planning Example', '1.1 Analyze Organizational Goals', '1.2 Forecast Future Workforce Needs'], 'capital headings are panels; step numbers dropped');
  const goals = a.sections.find(s => s.number === '1.1');
  assert.ok(goals.picture.includes('### Key Business Goals') && goals.picture.includes('- Increase client accounts by 30%'), 'labels and bullets kept');
  assert.ok(a.sections.find(s => s.number === '1.2').picture.includes('CSR (voice) 80 100 +20'), 'table rows kept with their numbers');
  await flow.ask(USER, { subjectId: subject.id, fileId, question: 'How many CSR voice employees are required?' });
  assert.match(calls[calls.length - 1].prompt, /CSR \(voice\) 80 100 \+20/);
});

test('a Reader the app put on a general vision model moves to an OCR model once one is installed', async t => {
  const models = [{ id: 'qwen2.5:7b' }, { id: 'qwen2.5vl:7b' }];
  const used = [];
  const { flow, ecosystem, subject, root, workspace } = setup(t, { models }, { ocr: async model => { used.push(model); return 'TITLE LINE HERE\nSome text of the picture.'; } });
  const ids = await flow.ensureAgents(USER);
  assert.equal(ecosystem.getAgent(USER, ids.reader).config.provider.model, 'qwen2.5vl:7b', 'no OCR model yet');
  models.push({ id: 'glm-ocr:q8_0' });
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(500, 400); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 500, 400);
  const stored = `${'f'.repeat(32)}.png`;
  fs.mkdirSync(path.join(root, 'learning-files', USER), { recursive: true });
  fs.writeFileSync(path.join(root, 'learning-files', USER, stored), c.toBuffer('image/png'));
  const { fileId } = workspace.importTopics(USER, subject.id, { name: 'p.png', storedName: stored, type: 'png', size: 1, text: '' }, []);
  flow.queueFile(USER, fileId); await idle(flow);
  assert.equal(ecosystem.getAgent(USER, ids.reader).config.provider.model, 'glm-ocr:q8_0', 'moved to the OCR model');
  assert.deepEqual(used, ['glm-ocr:q8_0']);
  // A model the person chose is kept.
  ecosystem.updateAgentConfig(USER, ids.reader, { provider: { connectionId: 'ollama-local', model: 'qwen2.5vl:7b' } });
  const again = await (require('../src/learning-agents').createLearningAgents({ ecosystem, root })).ready(USER, 'reader');
  assert.equal(again.model, 'qwen2.5vl:7b');
});

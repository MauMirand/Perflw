'use strict';
/* LS-030: one subject with 1,000 questions and 200 assessments. Targets (median of 5): `mastery:subject` under 100 ms and a quiz
   start (create + start) under 200 ms. Usage: node test/learning-quiz-bench.js   (exit 1 when a target is missed)
   If a target is missed, add indexes only through a NEW migration (G1), never by editing migration 2. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../src/workspace');
const { registerLearningIpc } = require('../src/learning-ipc');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-bench-'));
const workspace = createWorkspace(dir);
const handlers = new Map();
registerLearningIpc({ handle: (c, a) => handlers.set(c, a), requireUser: () => ({ id: 'u' }), workspace, dataDir: dir });
const call = (c, a) => handlers.get(c)(a);
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const time = fn => { const t = process.hrtime.bigint(); const out = fn(); return { ms: Number(process.hrtime.bigint() - t) / 1e6, out }; };

const subject = workspace.createSubject('u', 'study', { name: 'Bench' });
const topics = Array.from({ length: 20 }, (_, i) => workspace.addTopic('u', subject.id, { title: `Topic ${i}` }).added[0]);
console.log('seeding 1,000 questions…');
for (let i = 0; i < 1000; i++) {
  call('questions:save', { question: { subjectId: subject.id, topicId: topics[i % topics.length], type: 'choice', prompt: `Question ${i}`, dimension: i % 3 ? 'recognition' : 'recall', difficulty: 1 + (i % 3), payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['b'] } } });
}
const journey = call('journey:create', { subjectId: subject.id });
console.log('seeding 200 assessments…');
for (let i = 0; i < 200; i++) {
  const made = call('assessment:create', { subjectId: subject.id, journeyId: journey.id, kind: i % 10 === 0 ? 'diagnostic' : 'practice', config: { count: 5 } }).assessment;
  call('assessment:start', { assessmentId: made.id });
  for (const item of made.items) call('assessment:saveAnswer', { itemId: item.id, response: { choice: [i % 2 ? 'b' : 'a'], confidence: 2 } });
  call('assessment:submit', { assessmentId: made.id });
}
const masteryTimes = []; const startTimes = [];
for (let i = 0; i < 5; i++) {
  masteryTimes.push(time(() => call('mastery:subject', { subjectId: subject.id })).ms);
  startTimes.push(time(() => { const made = call('assessment:create', { subjectId: subject.id, kind: 'practice', config: { count: 10 } }).assessment; return call('assessment:start', { assessmentId: made.id }); }).ms);
}
const mastery = median(masteryTimes); const start = median(startTimes);
console.log(`mastery:subject  median ${mastery.toFixed(1)} ms (target < 100)  samples ${masteryTimes.map(x => x.toFixed(0)).join(', ')}`);
console.log(`quiz start       median ${start.toFixed(1)} ms (target < 200)  samples ${startTimes.map(x => x.toFixed(0)).join(', ')}`);
workspace.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
if (mastery >= 100 || start >= 200) { console.error('FAIL: a performance target was missed'); process.exit(1); }
console.log('PASS: both targets met');

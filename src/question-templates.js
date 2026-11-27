'use strict';
/* Template questions (spec §4.8.2, LS-015): drafts built deterministically from a file's analysis, no AI. Pure: no I/O.

   Input: `topics` = [{ id, title, fileId }], `files` = { [fileId]: { sections: [{ number, title, description, keyPoints[], page }] } }.
   Output: draft questions shaped for `validateQuestion` (origin 'template'), each citing the section it came from. They are
   not stored until the student accepts one; the student may edit it first.

   - explain: one per section that has at least 2 key points; the key points are the rubric (1 point each).
   - true/false: the first 2 key points of a section, as written, are TRUE. No false variants are invented (error-prone).
   - matching: from sections of one file that have a description: left = titles, right = descriptions (3–6 pairs). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwQuestionTemplates = factory();
})(globalThis, function () {

const clip = (text, max) => { const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; };
const norm = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const list = v => (Array.isArray(v) ? v : []);

/* The sections that belong to a topic: the section with the topic's title and everything below it (number prefix), else
   every section of its file (a one-topic file). */
function sectionsOf(topic, file) {
  const all = list(file && file.sections);
  const own = all.find(s => norm(s.title) === norm(topic.title));
  if (!own || !own.number) return all;
  const prefix = `${own.number}.`;
  return all.filter(s => s === own || String(s.number || '').startsWith(prefix));
}

function source(fileId, section, quote) {
  const ref = { fileId, section: clip(`${section.number ? `${section.number} ` : ''}${section.title}`, 200), quote: clip(quote, 300) };
  if (Number.isInteger(section.page) && section.page >= 1) ref.page = section.page;
  return ref;
}

/* "Slide 19", "Page 3", "Section 2.1", "Untitled": a title that names a place in the file, not an idea (owner, 2026-11-27). */
const GENERIC = /^\s*((slide|page|section|part|chapter|sheet|figure|item)\s*#?\s*[\d.]+[a-z]?|untitled( \w+)?|[\d.]+)\s*$/i;
const isGeneric = title => GENERIC.test(String(title || ''));
/* The idea a section is about: its title, or for a generic title the opening of its description (or first key point). */
function ideaOf(section) {
  if (!isGeneric(section.title)) return section.title;
  const text = String(section.description || list(section.keyPoints)[0] || '').replace(/^(this|the) (slide|page|section) (shows|explains|describes|covers|is about|discusses)\s*/i, '');
  const first = text.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
  return clip(first, 90);
}
function templateQuestions({ subjectId, topics, files }) {
  const out = [];
  for (const topic of list(topics)) {
    if (!topic || topic.id == null || !topic.fileId) continue;
    const file = files && files[topic.fileId]; if (!file) continue;
    const sections = sectionsOf(topic, file).filter(s => s && s.title);
    const base = { subjectId, topicId: topic.id, origin: 'template', review: 'approved' };
    for (const s of sections) {
      const points = list(s.keyPoints).map(p => clip(p, 500)).filter(Boolean);
      if (points.length >= 2) {
        out.push({ ...base, id: `tpl-explain-${topic.id}-${s.number || s.title}`, type: 'explain', prompt: clip(isGeneric(s.title) ? `Explain in your own words: ${ideaOf(s)}.` : `Explain ${s.title} in your own words.`, 2000), dimension: 'understanding', difficulty: 2,
          explanation: clip(s.description, 2000), source: [source(topic.fileId, s, points[0])],
          payload: { maxWords: 120, rubric: points.slice(0, 5).map((p, i) => ({ id: `c${i}`, criterion: p, points: 1 })) } });
      }
      points.slice(0, 2).forEach((p, i) => out.push({ ...base, id: `tpl-tf-${topic.id}-${s.number || s.title}-${i}`, type: 'truefalse', prompt: 'True or false?', dimension: 'recognition', difficulty: 1,
        explanation: clip(s.description, 2000), source: [source(topic.fileId, s, p)], payload: { statement: p, correct: true, requireJustification: false } }));
    }
    const described = sections.filter(s => clip(s.description, 200) && !isGeneric(s.title)).slice(0, 6); // "Slide 3 ↔ …" teaches nothing
    if (described.length >= 3) {
      out.push({ ...base, id: `tpl-match-${topic.id}`, type: 'matching', prompt: clip(`Match each part of ${topic.title} to its description.`, 2000), dimension: 'recognition', difficulty: 2,
        explanation: '', source: described.slice(0, 5).map(s => source(topic.fileId, s, s.description)),
        payload: { left: described.map((s, i) => ({ id: `l${i}`, text: clip(s.title, 500) })), right: described.map((s, i) => ({ id: `r${i}`, text: clip(s.description, 200) })), pairs: described.map((_, i) => [`l${i}`, `r${i}`]) } });
    }
  }
  return out;
}

return { templateQuestions, sectionsOf, isGeneric, ideaOf };
});

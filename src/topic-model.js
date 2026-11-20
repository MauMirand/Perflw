'use strict';
/* Subject topics — order, levels and numbering. Pure logic: no DOM, no Electron, no database.
   Loaded by the renderer (script tag → window.PerflwTopicModel), by workspace.js and by the tests (require).

   A subject's topic list is one ordered array of rows:
     { id, kind: 'topic', level: 0 | 1, title }   level 0 = topic (1, 2, 3), level 1 = subtopic (2.1, 2.2)
     { id, kind: 'milestone', title }               a group divider such as Prelim, Midterm, Prefi, Finals
   Numbers are never stored: they come from the order, so moving topic 1 to place 5 renumbers everything.
   Numbering is continuous across milestones (Prelim 1–4, Midterm continues at 5). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwTopicModel = factory();
})(globalThis, function () {

const MILESTONES = Object.freeze(['Prelim', 'Midterm', 'Prefi', 'Finals']);
const LIMITS = Object.freeze({ title: 200, rows: 1000 });

const isTopic = row => row && row.kind === 'topic';

/* A subtopic needs a topic above it in the same milestone segment; otherwise it becomes a topic. */
function normalize(rows) {
  let parent = false;
  return rows.map(row => {
    if (!isTopic(row)) { parent = false; return { ...row, level: 0 }; }
    const level = row.level === 1 && parent ? 1 : 0;
    parent = true;
    return level === row.level ? row : { ...row, level };
  });
}

/* id → "1", "2", "2.1" … Milestones have no number. */
function numbers(rows) {
  const out = new Map();
  let main = 0, sub = 0;
  for (const row of normalize(rows)) {
    if (!isTopic(row)) continue;
    if (row.level === 0) { main += 1; sub = 0; out.set(row.id, String(main)); }
    else { sub += 1; out.set(row.id, `${main}.${sub}`); }
  }
  return out;
}

/* The rows that move together: a topic carries its subtopics; a subtopic or milestone moves alone. */
function blockOf(rows, id) {
  const start = rows.findIndex(row => row.id === id);
  if (start < 0) return [];
  const ids = [rows[start].id];
  if (isTopic(rows[start]) && rows[start].level === 0) {
    for (let i = start + 1; i < rows.length && isTopic(rows[i]) && rows[i].level === 1; i++) ids.push(rows[i].id);
  }
  return ids;
}

/* Move a row (and its block) so it lands before the row `beforeId` (null = to the end). */
function moveBefore(rows, id, beforeId) {
  const block = blockOf(rows, id);
  if (!block.length || block.includes(beforeId)) return rows;
  const moving = rows.filter(row => block.includes(row.id));
  const rest = rows.filter(row => !block.includes(row.id));
  const at = beforeId == null ? rest.length : rest.findIndex(row => row.id === beforeId);
  if (at < 0) return rows;
  return normalize([...rest.slice(0, at), ...moving, ...rest.slice(at)]);
}

/* Several selected rows, each with its block (a topic brings its subtopics), in list order without repeats. */
function blocksOf(rows, ids) {
  const set = new Set();
  for (const id of ids) for (const member of blockOf(rows, id)) set.add(member);
  return rows.filter(row => set.has(row.id)).map(row => row.id);
}

/* Move several selected rows (and their blocks) together, in their list order, so they land before `beforeId`
   (null = to the end). Dropping onto one of the moving rows places them before the next row that stays. */
function moveManyBefore(rows, ids, beforeId) {
  const moving = new Set(blocksOf(rows, ids));
  if (!moving.size) return rows;
  let target = beforeId;
  if (target != null && moving.has(target)) {
    const from = rows.findIndex(row => row.id === target);
    const next = rows.slice(from).find(row => !moving.has(row.id));
    target = next ? next.id : null;
  }
  const rest = rows.filter(row => !moving.has(row.id));
  const at = target == null ? rest.length : rest.findIndex(row => row.id === target);
  if (at < 0) return rows;
  return normalize([...rest.slice(0, at), ...rows.filter(row => moving.has(row.id)), ...rest.slice(at)]);
}

/* One step up or down (keyboard): the block jumps over the neighbouring block. */
function step(rows, id, direction) {
  const block = blockOf(rows, id);
  if (!block.length) return rows;
  const first = rows.findIndex(row => row.id === block[0]);
  const last = first + block.length - 1;
  if (direction < 0) {
    if (first === 0) return rows;
    let target = first - 1;
    if (block.length > 1 || rows[first].level === 0) while (target > 0 && isTopic(rows[target]) && rows[target].level === 1) target -= 1;
    return moveBefore(rows, id, rows[target].id);
  }
  if (last === rows.length - 1) return rows;
  const after = blockOf(rows, rows[last + 1].id);
  const next = rows.findIndex(row => row.id === after[after.length - 1]) + 1;
  return moveBefore(rows, id, next < rows.length ? rows[next].id : null);
}

/* Toggle topic ⇄ subtopic. A topic with subtopics cannot become a subtopic (its children would have no parent). */
function setLevel(rows, id, level) {
  const index = rows.findIndex(row => row.id === id);
  if (index < 0 || !isTopic(rows[index])) return rows;
  if (level === 1 && blockOf(rows, id).length > 1) return rows;
  return normalize(rows.map(row => (row.id === id ? { ...row, level } : row)));
}

/* Topics per milestone segment, for the milestone dividers ("4 topics"). Key null = before the first milestone. */
function segmentCounts(rows) {
  const out = new Map(); let current = null; out.set(null, 0);
  for (const row of rows) {
    if (!isTopic(row)) { current = row.id; out.set(current, 0); }
    else if (row.level === 0) out.set(current, out.get(current) + 1);
  }
  return out;
}

function cleanTitle(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);
}

return { MILESTONES, LIMITS, normalize, numbers, blockOf, blocksOf, moveBefore, moveManyBefore, step, setLevel, segmentCounts, cleanTitle };
});

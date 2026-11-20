'use strict';
/* Project pages — block model, edit operations, undo history, open-tab state and Calendar linking.
   Pure logic: no DOM, no Electron, no database. Loaded by the renderer (script tag → window.PerflwProjectModel)
   and by the tests (require), so the editor and the tests share one set of rules.
   A new block type is one entry in BLOCK_TYPES plus one renderer in projects.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwProjectModel = factory();
})(globalThis, function () {

// text: the block has an editable text line. next: the type Enter continues with (default: paragraph).
const BLOCK_TYPES = Object.freeze([
  { type: 'paragraph', label: 'Text', hint: 'Plain paragraph', keys: 'text paragraph plain', text: true },
  { type: 'h1', label: 'Heading 1', hint: 'Large section heading', keys: 'heading h1 title #', text: true },
  { type: 'h2', label: 'Heading 2', hint: 'Medium section heading', keys: 'heading h2 subtitle ##', text: true },
  { type: 'h3', label: 'Heading 3', hint: 'Small section heading', keys: 'heading h3 ###', text: true },
  { type: 'bullet', label: 'Bulleted list', hint: 'Simple bullet point', keys: 'bullet list unordered -', text: true, next: 'bullet' },
  { type: 'numbered', label: 'Numbered list', hint: 'List with numbers', keys: 'numbered list ordered 1.', text: true, next: 'numbered' },
  { type: 'todo', label: 'To-do list', hint: 'Checkbox item', keys: 'todo to-do checkbox check []', text: true, next: 'todo' },
  { type: 'toggle', label: 'Toggle', hint: 'Collapsible details', keys: 'toggle collapse details', text: true },
  { type: 'quote', label: 'Quote', hint: 'Quoted text', keys: 'quote citation >', text: true },
  { type: 'callout', label: 'Callout', hint: 'Highlighted note', keys: 'callout note info tip', text: true },
  { type: 'divider', label: 'Divider', hint: 'Horizontal line', keys: 'divider line separator ---' },
  { type: 'code', label: 'Code', hint: 'Monospaced code block', keys: 'code snippet ```', text: true },
  { type: 'bookmark', label: 'Link', hint: 'Web link with a title', keys: 'link bookmark url web', text: true },
  { type: 'image', label: 'Image', hint: 'Picture from this computer', keys: 'image picture photo', text: true },
  { type: 'table', label: 'Table', hint: 'Simple rows and columns', keys: 'table grid rows columns' },
  { type: 'schedule', label: 'Schedule', hint: 'Calendar schedules for this project', keys: 'schedule calendar event date' },
  { type: 'tasks', label: 'Task list', hint: 'Tasks linked to this project', keys: 'tasks task list work' },
  { type: 'milestones', label: 'Milestones', hint: 'Milestones linked to this project', keys: 'milestone milestones goal' },
  { type: 'related', label: 'Project data', hint: 'Status, deadline and progress', keys: 'related project data summary progress deadline' }
]);
const TYPE = Object.freeze(Object.fromEntries(BLOCK_TYPES.map(t => [t.type, t])));
const LIMITS = Object.freeze({ blocks: 2000, text: 20000, data: 100000, name: 180, description: 2000, tabs: 12, recent: 8, history: 100 });
const CALLOUT_ICONS = Object.freeze(['💡', '⚠️', '✅', '📌', '❓']);

function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
}
function defaultData(type) {
  switch (type) {
    case 'todo': return { checked: false };
    case 'toggle': return { open: true, body: '' };
    case 'callout': return { icon: CALLOUT_ICONS[0] };
    case 'bookmark': return { url: '' };
    case 'image': return { imageName: null };
    case 'table': return { rows: [['', '', ''], ['', '', '']] };
    default: return {};
  }
}
const isText = type => !!(TYPE[type] && TYPE[type].text);
function createBlock(type = 'paragraph', text = '', data) {
  return { id: newId(), type, text: String(text || ''), data: { ...defaultData(type), ...(data || {}) } };
}
/* Accepts whatever was stored; unknown types are kept as they are so a later version can render them. */
function cleanBlocks(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') continue;
    const id = typeof raw.id === 'string' && raw.id && !seen.has(raw.id) ? raw.id : newId();
    seen.add(id);
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {};
    out.push({ id, type: raw.type, text: typeof raw.text === 'string' ? raw.text : '', data: { ...defaultData(raw.type), ...data } });
  }
  return out;
}

// ── edit operations: each returns a new array and never mutates its input
function insertAt(blocks, index, block) {
  const at = Math.max(0, Math.min(blocks.length, index));
  return [...blocks.slice(0, at), block, ...blocks.slice(at)];
}
function removeAt(blocks, index) { return blocks.filter((_, i) => i !== index); }
function move(blocks, from, to) {
  if (from < 0 || from >= blocks.length) return blocks;
  const target = Math.max(0, Math.min(blocks.length - 1, to));
  if (target === from) return blocks;
  const next = blocks.slice();
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}
function changeType(blocks, index, type) {
  const block = blocks[index];
  if (!block || block.type === type) return blocks;
  const data = defaultData(type);
  if (type === 'bookmark' && /^https?:\/\/\S+$/i.test(block.text.trim())) data.url = block.text.trim();
  const next = blocks.slice();
  next[index] = { ...block, type, data };
  return next;
}
function duplicate(blocks, index) {
  const block = blocks[index];
  if (!block) return blocks;
  return insertAt(blocks, index + 1, { ...block, id: newId(), data: JSON.parse(JSON.stringify(block.data)) });
}
/* Enter. An empty list item leaves the list; otherwise the text is split at the caret. */
function split(blocks, index, start, end = start) {
  const block = blocks[index];
  if (!block) return { blocks, focus: null, offset: 0 };
  const meta = TYPE[block.type] || {};
  if (meta.next && !block.text) return { blocks: changeType(blocks, index, 'paragraph'), focus: block.id, offset: 0 };
  const head = block.text.slice(0, start);
  const tail = block.text.slice(end);
  const created = createBlock(meta.next || 'paragraph', tail);
  const next = blocks.slice();
  next[index] = { ...block, text: head };
  return { blocks: insertAt(next, index + 1, created), focus: created.id, offset: 0 };
}
/* Backspace at the start of a block: formatting is removed first, then the text joins the block above. */
function mergeBack(blocks, index) {
  const block = blocks[index];
  if (!block) return { blocks, focus: null, offset: 0 };
  if (block.type === 'image' || block.type === 'bookmark') return { blocks, focus: block.id, offset: 0 };
  if (block.type !== 'paragraph' && isText(block.type)) return { blocks: changeType(blocks, index, 'paragraph'), focus: block.id, offset: 0 };
  if (index === 0) {
    if (!block.text && blocks.length > 1) return { blocks: removeAt(blocks, 0), focus: blocks[1].id, offset: 0 };
    return { blocks, focus: block.id, offset: 0 };
  }
  const previous = blocks[index - 1];
  const joinable = isText(previous.type) && !['image', 'bookmark'].includes(previous.type);
  if (joinable) {
    const next = blocks.slice();
    next[index - 1] = { ...previous, text: previous.text + block.text };
    return { blocks: removeAt(next, index), focus: previous.id, offset: previous.text.length };
  }
  if (!block.text) return { blocks: removeAt(blocks, index), focus: previous.id, offset: previous.text.length };
  return { blocks, focus: previous.id, offset: previous.text.length };
}
/* Markdown-style shortcuts typed at the start of a paragraph. Returns { type, text } or null. */
function shortcut(text) {
  if (text === '---') return { type: 'divider', text: '' };
  if (text === '```') return { type: 'code', text: '' };
  const match = /^(#{1,3}|-|\*|1\.|\[\s?\]|>|")\s/.exec(text);
  if (!match) return null;
  const mark = match[1];
  const type = mark === '#' ? 'h1' : mark === '##' ? 'h2' : mark === '###' ? 'h3' : mark === '-' || mark === '*' ? 'bullet'
    : mark === '1.' ? 'numbered' : mark === '>' || mark === '"' ? 'quote' : 'todo';
  return { type, text: text.slice(match[0].length) };
}
function searchTypes(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return BLOCK_TYPES.slice();
  return BLOCK_TYPES.filter(t => t.label.toLowerCase().includes(q) || t.keys.includes(q));
}
/* A list block is a group: each line of its text is one item (bullet, number or checkbox). */
const isList = type => type === 'bullet' || type === 'numbered' || type === 'todo';
const linesOf = block => String((block && block.text) || '').split('\n');
function checksOf(block) {
  const n = linesOf(block).length; const c = block.data && block.data.checks;
  return Array.from({ length: n }, (_, i) => Array.isArray(c) ? !!c[i] : (i === 0 && !!(block.data && block.data.checked)));
}
const withChecks = (block, checks) => (block.type === 'todo' ? { ...block.data, checks, checked: !!checks[0] } : block.data);
/* Enter inside a list group: a new item in the same group. Enter on an empty last item leaves the group
   (a plain paragraph below, which is a new group). */
function listEnter(blocks, index, line, start, end = start) {
  const block = blocks[index];
  if (!block || !isList(block.type)) return { blocks, focus: null, line: 0, offset: 0 };
  const lines = linesOf(block); const checks = checksOf(block);
  const at = Math.max(0, Math.min(lines.length - 1, line));
  if (!lines[at] && at === lines.length - 1) {
    if (lines.length === 1) return { blocks: changeType(blocks, index, 'paragraph'), focus: block.id, line: 0, offset: 0 };
    const next = blocks.slice();
    next[index] = { ...block, text: lines.slice(0, -1).join('\n'), data: withChecks(block, checks.slice(0, -1)) };
    const after = createBlock('paragraph');
    return { blocks: insertAt(next, index + 1, after), focus: after.id, line: 0, offset: 0 };
  }
  lines.splice(at, 1, lines[at].slice(0, start), lines[at].slice(end));
  checks.splice(at + 1, 0, false);
  const next = blocks.slice();
  next[index] = { ...block, text: lines.join('\n'), data: withChecks(block, checks) };
  return { blocks: next, focus: block.id, line: at + 1, offset: 0 };
}
/* Backspace at the start of a list item: joins the item above; the first item leaves the list. */
function listBack(blocks, index, line) {
  const block = blocks[index];
  if (!block || !isList(block.type)) return { blocks, focus: null, line: 0, offset: 0 };
  const lines = linesOf(block); const checks = checksOf(block);
  if (line > 0) {
    const offset = lines[line - 1].length;
    lines.splice(line - 1, 2, lines[line - 1] + lines[line]); checks.splice(line, 1);
    const next = blocks.slice(); next[index] = { ...block, text: lines.join('\n'), data: withChecks(block, checks) };
    return { blocks: next, focus: block.id, line: line - 1, offset };
  }
  if (lines.length === 1) return mergeBack(blocks, index);
  const first = createBlock('paragraph', lines[0]);
  const next = blocks.slice(); next[index] = { ...block, text: lines.slice(1).join('\n'), data: withChecks(block, checks.slice(1)) };
  return { blocks: insertAt(next, index, first), focus: first.id, line: 0, offset: 0 };
}
/* Number shown by the first item of each numbered group, continuing through consecutive numbered groups. */
function numbering(blocks) {
  const numbers = {};
  let n = 0;
  for (const block of blocks) { if (block.type === 'numbered') { numbers[block.id] = n + 1; n += linesOf(block).length; } else n = 0; }
  return numbers;
}

// ── undo / redo over whole-page snapshots (strings)
function createHistory(limit = LIMITS.history) {
  const past = []; const future = [];
  return {
    record(snapshot) { if (past[past.length - 1] === snapshot) return; past.push(snapshot); if (past.length > limit) past.shift(); future.length = 0; },
    undo(current) { if (!past.length) return null; future.push(current); return past.pop(); },
    redo(current) { if (!future.length) return null; past.push(current); return future.pop(); },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() { past.length = 0; future.length = 0; }
  };
}

// ── open project tabs: { open: [ids], active: id | null (null = the Projects overview), recent: [ids] }
const emptyTabs = () => ({ open: [], active: null, recent: [] });
function cleanTabs(raw) {
  const ids = list => [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && id))];
  const open = ids(raw && raw.open).slice(0, LIMITS.tabs);
  const active = raw && typeof raw.active === 'string' && open.includes(raw.active) ? raw.active : null;
  return { open, active, recent: ids(raw && raw.recent).slice(0, LIMITS.recent) };
}
function openTab(tabs, id) {
  let open = tabs.open.includes(id) ? tabs.open : [...tabs.open, id];
  // Over the limit: the oldest tab that is not the one being opened makes room.
  while (open.length > LIMITS.tabs) open = open.filter((x, i) => i !== open.findIndex(y => y !== id));
  return { open, active: id, recent: [id, ...tabs.recent.filter(x => x !== id)].slice(0, LIMITS.recent) };
}
function closeTab(tabs, id) {
  const index = tabs.open.indexOf(id);
  if (index < 0) return tabs;
  const open = tabs.open.filter(x => x !== id);
  const active = tabs.active === id ? (open[index] || open[index - 1] || null) : tabs.active;
  return { open, active, recent: tabs.recent };
}
function activateTab(tabs, id) {
  if (id !== null && !tabs.open.includes(id)) return tabs;
  return { ...tabs, active: id, recent: id ? [id, ...tabs.recent.filter(x => x !== id)].slice(0, LIMITS.recent) : tabs.recent };
}
/* Drops tabs whose project no longer exists (deleted, archived, or another account). */
function pruneTabs(tabs, validIds) {
  const valid = new Set(validIds);
  const open = tabs.open.filter(id => valid.has(id));
  return { open, active: open.includes(tabs.active) ? tabs.active : null, recent: tabs.recent.filter(id => valid.has(id)) };
}
/* Recently used projects that are not open right now, most recent first. */
const reopenable = tabs => tabs.recent.filter(id => !tabs.open.includes(id));

// ── Calendar linking: one record, shown in both places, matched by project / task / event ids
const pad = n => String(n).padStart(2, '0');
function localDay(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
}
function localTime(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null;
}
/* Local date (+ optional HH:MM) → ISO timestamp, the format the workspace stores. */
function toStamp(day, time) {
  const [y, m, d] = String(day).split('-').map(Number);
  const [hh, mm] = time ? String(time).split(':').map(Number) : [0, 0];
  const date = new Date(y, m - 1, d, hh || 0, mm || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
/* Every project-linked record as a Calendar entry. Records without a live project are left out. */
function calendarEntries({ projects = [], tasks = [], events = [], milestones = [] } = {}) {
  const names = new Map(projects.filter(p => !p.archived_at).map(p => [p.id, p.name]));
  const out = [];
  const push = (kind, id, projectId, title, stamp, timed, done) => {
    const day = stamp ? localDay(stamp) : null;
    if (!day || !names.has(projectId)) return;
    out.push({ kind, id, projectId, project: names.get(projectId), title, day, time: timed ? localTime(stamp) : null, done: !!done });
  };
  for (const p of projects) if (!p.archived_at && p.target_date) push('deadline', `deadline:${p.id}`, p.id, `${p.name} deadline`, p.target_date, false, p.status === 'completed');
  for (const e of events) push('schedule', e.id, e.project_id, e.title, e.starts_at, true, false);
  for (const t of tasks) if (t.due_at) push('task', t.id, t.project_id, t.title, t.due_at, false, t.completed_at);
  for (const m of milestones) push('milestone', m.id, m.project_id, m.title, m.due_at, false, m.completed_at);
  return out.sort((a, b) => (a.day + (a.time || '')).localeCompare(b.day + (b.time || '')));
}

return { BLOCK_TYPES, TYPE, LIMITS, CALLOUT_ICONS, newId, defaultData, isText, createBlock, cleanBlocks,
  insertAt, removeAt, move, changeType, duplicate, split, mergeBack, isList, linesOf, checksOf, listEnter, listBack, shortcut, searchTypes, numbering,
  createHistory, emptyTabs, cleanTabs, openTab, closeTab, activateTab, pruneTabs, reopenable,
  localDay, localTime, toStamp, calendarEntries };
});

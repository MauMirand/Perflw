// Project pages: block persistence, project-tab behaviour and Calendar / Project linking.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../src/workspace');
const M = require('../src/project-model');

// Opens a workspace in a fresh folder. Stores are closed before the folder is removed (Windows keeps open files locked).
function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-projects-'));
  const stores = [];
  t.after(() => { for (const store of stores) { try { store.close(); } catch { /* already closed */ } } fs.rmSync(root, { recursive: true, force: true }); });
  return { root, open: () => { const store = createWorkspace(root); stores.push(store); return store; } };
}
const fixture = t => tempRoot(t).open();
const block = (type, text = '', data) => M.createBlock(type, text, data);

// ── block persistence
test('a page keeps its title, metadata, block content and block order across a restart', t => {
  const home = tempRoot(t);
  let store = home.open();
  const id = store.createProject('user-a', 'Launch');
  const blocks = [block('h1', 'Plan'), block('paragraph', 'First line\nsecond line'), block('todo', 'Ship it', { checked: true }),
    block('table', '', { rows: [['Owner', 'Due'], ['Mau', 'Friday']] }), block('tasks'), block('code', 'const a = 1;')];
  store.saveProjectPage('user-a', id, { project: { name: 'Launch v2', description: 'Spring release', status: 'on-hold', targetDate: '2026-12-01T00:00:00.000Z' }, blocks });
  store.close();

  store = home.open();
  const page = store.getProjectPage('user-a', id);
  assert.equal(page.project.name, 'Launch v2');
  assert.equal(page.project.description, 'Spring release');
  assert.equal(page.project.status, 'on-hold');
  assert.equal(page.project.target_date, '2026-12-01T00:00:00.000Z');
  assert.deepEqual(page.blocks, blocks.map(b => ({ id: b.id, type: b.type, text: b.text, data: b.data })));
});

test('a page keeps its cover, cover position and icon; invalid looks are rejected and roll the save back', t => {
  const home = tempRoot(t);
  let store = home.open();
  const id = store.createProject('user-a', 'Looks');
  assert.equal(store.getProjectPage('user-a', id).project.cover, null, 'a new page uses the default cover');
  assert.equal(store.getProjectPage('user-a', id).project.cover_pos, 50);
  assert.equal(store.getProjectPage('user-a', id).project.icon, '');
  const file = 'a'.repeat(32) + '.png';
  store.saveProjectPage('user-a', id, { project: { cover: file, coverPos: 23.6, icon: '🚀' }, blocks: [] });
  store.saveProjectPage('user-a', id, { project: { name: 'Looks 2' }, blocks: [] }); // untouched when not sent
  store.close();
  store = home.open();
  let project = store.getProjectPage('user-a', id).project;
  assert.deepEqual([project.cover, project.cover_pos, project.icon, project.name], [file, 24, '🚀', 'Looks 2']);
  store.saveProjectPage('user-a', id, { project: { cover: 'g:tide', icon: '' }, blocks: [] });
  store.saveProjectPage('user-a', id, { project: { cover: 'none', coverPos: 400 }, blocks: [] });
  project = store.getProjectPage('user-a', id).project;
  assert.deepEqual([project.cover, project.cover_pos, project.icon], ['none', 100, '']);
  for (const bad of [{ cover: 'g:unknown' }, { cover: '../../x.png' }, { cover: 5 }, { coverPos: 'top' }, { icon: 'x'.repeat(17) }, { icon: '<b>' }])
    assert.throws(() => store.saveProjectPage('user-a', id, { project: { name: 'Should not stick', ...bad }, blocks: [block('paragraph', 'nope')] }), /cover|icon/i, JSON.stringify(bad));
  project = store.getProjectPage('user-a', id).project;
  assert.equal(project.name, 'Looks 2', 'a rejected look rolls back the whole save');
  assert.deepEqual(store.getProjectPage('user-a', id).blocks, []);
});

test('saving again reorders, edits, adds and removes blocks without leaving old rows behind', t => {
  const store = fixture(t);
  const id = store.createProject('user-a', 'Notes');
  const [a, b, c] = [block('paragraph', 'A'), block('paragraph', 'B'), block('paragraph', 'C')];
  store.saveProjectPage('user-a', id, { blocks: [a, b, c] });
  const d = block('quote', 'D');
  store.saveProjectPage('user-a', id, { blocks: [c, { ...a, text: 'A edited', type: 'h2' }, d] });
  const page = store.getProjectPage('user-a', id);
  assert.deepEqual(page.blocks.map(x => [x.id, x.type, x.text]), [[c.id, 'paragraph', 'C'], [a.id, 'h2', 'A edited'], [d.id, 'quote', 'D']]);
  assert.equal(page.project.name, 'Notes', 'metadata is untouched when only blocks are sent');
  store.saveProjectPage('user-a', id, { blocks: [] });
  assert.deepEqual(store.getProjectPage('user-a', id).blocks, []);
});

test('pages are account-scoped and invalid pages are rejected as a whole', t => {
  const store = fixture(t);
  const mine = store.createProject('user-a', 'Mine');
  const theirs = store.createProject('user-b', 'Theirs');
  const kept = block('paragraph', 'kept');
  store.saveProjectPage('user-a', mine, { blocks: [kept] });
  assert.throws(() => store.getProjectPage('user-b', mine), /Project not found/);
  assert.throws(() => store.saveProjectPage('user-b', mine, { blocks: [] }), /Project not found/);
  // A block id that already lives on another account's page cannot be claimed.
  assert.throws(() => store.saveProjectPage('user-b', theirs, { blocks: [{ ...kept }] }), /another page/);
  // One bad block rolls the whole save back.
  assert.throws(() => store.saveProjectPage('user-a', mine, { project: { name: 'Renamed' }, blocks: [block('paragraph', 'new'), { id: 'x', type: 'paragraph' }] }), /Invalid block id/);
  assert.throws(() => store.saveProjectPage('user-a', mine, { blocks: [{ ...block('paragraph'), type: 'Not A Type' }] }), /Invalid block type/);
  assert.throws(() => store.saveProjectPage('user-a', mine, { project: { name: '' }, blocks: [block('paragraph', 'new')] }), /Project name/);
  const page = store.getProjectPage('user-a', mine);
  assert.equal(page.project.name, 'Mine');
  assert.deepEqual(page.blocks.map(x => x.text), ['kept']);
  assert.deepEqual(store.getProjectPage('user-b', theirs).blocks, []);
});

test('deleting a project removes its page; block types from a newer version are stored untouched', t => {
  const store = fixture(t);
  const id = store.createProject('user-a', 'Temp');
  const future = { id: M.newId(), type: 'kanban-board', text: '', data: { lanes: ['todo', 'done'] } };
  store.saveProjectPage('user-a', id, { blocks: [future] });
  assert.deepEqual(store.getProjectPage('user-a', id).blocks, [future]);
  assert.deepEqual(M.cleanBlocks([future])[0].data, { lanes: ['todo', 'done'] }, 'the editor keeps unknown blocks as they are');
  store.deleteProject('user-a', id);
  const again = store.createProject('user-a', 'Temp 2');
  store.saveProjectPage('user-a', again, { blocks: [future] }); // the id is free again: the old rows went with the project
  assert.equal(store.getProjectPage('user-a', again).blocks.length, 1);
});

test('older text-only projects become real projects once, keeping id, name and date', t => {
  const store = fixture(t);
  const note = store.createPlannerItem('user-a', { kind: 'whim', text: 'Learn watercolor' });
  store.createPlannerItem('user-b', { kind: 'whim', text: 'Not mine' });
  assert.equal(store.adoptLegacyProjects('user-a'), 1);
  assert.equal(store.adoptLegacyProjects('user-a'), 0);
  const projects = store.listProjects('user-a');
  assert.deepEqual(projects.map(p => [p.id, p.name, p.created_at]), [[note.id, 'Learn watercolor', note.createdAt]]);
  assert.deepEqual(store.listPlannerItems('user-a', 'whim'), []);
  assert.equal(store.listPlannerItems('user-b', 'whim').length, 1);
});

// ── block model
test('editing operations: insert, split, merge, retype, move, duplicate and numbering', () => {
  let blocks = [block('paragraph', 'Hello world')];
  let result = M.split(blocks, 0, 5);
  assert.deepEqual(result.blocks.map(b => b.text), ['Hello', ' world']);
  assert.equal(result.focus, result.blocks[1].id);
  result = M.mergeBack(result.blocks, 1);
  assert.deepEqual(result.blocks.map(b => b.text), ['Hello world']);
  assert.equal(result.offset, 5);

  blocks = [block('bullet', 'one'), block('bullet', '')];
  assert.equal(M.split(blocks, 0, 3).blocks[1].type, 'bullet', 'Enter continues a list');
  assert.equal(M.split(blocks, 1, 0).blocks[1].type, 'paragraph', 'Enter on an empty item leaves the list');
  assert.equal(M.mergeBack(blocks, 0).blocks[0].type, 'paragraph', 'Backspace at the start removes the formatting first');
  assert.equal(M.mergeBack([block('paragraph', '')], 0).blocks.length, 1, 'the only block is never removed by Backspace');
  const afterDivider = M.mergeBack([block('divider'), block('paragraph', '')], 1);
  assert.deepEqual(afterDivider.blocks.map(b => b.type), ['divider']);

  blocks = [block('paragraph', 'https://example.com'), block('numbered', 'a'), block('numbered', 'b'), block('paragraph', 'x'), block('numbered', 'c')];
  assert.equal(M.changeType(blocks, 0, 'bookmark')[0].data.url, 'https://example.com');
  assert.deepEqual(Object.values(M.numbering(blocks)), [1, 2, 1]);
  assert.deepEqual(M.move(blocks, 4, 0).map(b => b.text), ['c', 'https://example.com', 'a', 'b', 'x']);
  assert.equal(M.move(blocks, 0, -3), blocks, 'moving past the edge changes nothing');
  const copied = M.duplicate(blocks, 1);
  assert.equal(copied.length, 6);
  assert.equal(copied[2].text, 'a');
  assert.notEqual(copied[2].id, copied[1].id);
  assert.equal(M.removeAt(blocks, 0).length, 4);
  assert.equal(blocks.length, 5, 'operations never mutate their input');
});

test('every required block type is registered, searchable and has typing shortcuts', () => {
  const required = ['paragraph', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle', 'quote', 'callout', 'divider', 'code', 'bookmark', 'image', 'table', 'schedule', 'related', 'tasks', 'milestones'];
  assert.deepEqual(required.filter(type => !M.TYPE[type]), []);
  assert.deepEqual(M.searchTypes('head').map(t => t.type), ['h1', 'h2', 'h3']);
  assert.equal(M.searchTypes('').length, M.BLOCK_TYPES.length);
  assert.deepEqual(M.searchTypes('zzz'), []);
  assert.deepEqual(M.shortcut('## Title'), { type: 'h2', text: 'Title' });
  assert.deepEqual(M.shortcut('[] '), { type: 'todo', text: '' });
  assert.deepEqual(M.shortcut('---'), { type: 'divider', text: '' });
  assert.equal(M.shortcut('#hashtag'), null);
});

test('undo and redo walk back and forward through page snapshots', () => {
  const history = M.createHistory(3);
  assert.equal(history.undo('now'), null);
  for (const snap of ['s1', 's2', 's3', 's4']) history.record(snap);
  assert.equal(history.undo('s5'), 's4');
  assert.equal(history.undo('s4'), 's3');
  assert.equal(history.redo('s3'), 's4');
  assert.equal(history.redo('s4'), 's5');
  assert.equal(history.redo('s5'), null);
  assert.equal(history.undo('s5'), 's4');
  history.record('fork');
  assert.equal(history.canRedo(), false, 'a new edit drops the redo branch');
});

// ── project tabs
test('project tabs: open several, switch, close, reopen from recent, and survive deleted projects', () => {
  let tabs = M.emptyTabs();
  tabs = M.openTab(tabs, 'a'); tabs = M.openTab(tabs, 'b'); tabs = M.openTab(tabs, 'c');
  assert.deepEqual(tabs, { open: ['a', 'b', 'c'], active: 'c', recent: ['c', 'b', 'a'] });
  tabs = M.openTab(tabs, 'a');
  assert.deepEqual(tabs.open, ['a', 'b', 'c'], 'opening an open project switches to its tab instead of duplicating it');
  assert.equal(tabs.active, 'a');
  tabs = M.activateTab(tabs, 'b');
  assert.equal(tabs.active, 'b');
  assert.equal(M.activateTab(tabs, 'missing'), tabs);
  tabs = M.closeTab(tabs, 'b');
  assert.deepEqual([tabs.open, tabs.active], [['a', 'c'], 'c'], 'closing the active tab activates its neighbour');
  tabs = M.closeTab(tabs, 'a');
  assert.equal(tabs.active, 'c', 'closing a background tab keeps the active one');
  assert.deepEqual(M.reopenable(tabs), ['b', 'a'], 'closed projects stay reachable, most recent first');
  tabs = M.closeTab(tabs, 'c');
  assert.equal(tabs.active, null, 'with no tabs left the Projects overview is shown');
  tabs = M.activateTab(M.openTab(tabs, 'b'), null);
  assert.deepEqual([tabs.open, tabs.active], [['b'], null], 'the overview is a tab of its own');
  assert.deepEqual(M.pruneTabs({ open: ['a', 'b'], active: 'a', recent: ['a', 'b', 'c'] }, ['b']), { open: ['b'], active: null, recent: ['b'] });
  assert.deepEqual(M.cleanTabs({ open: ['a', 'a', 7, ''], active: 'zzz', recent: 'nope' }), { open: ['a'], active: null, recent: [] });
  assert.deepEqual(M.cleanTabs(null), M.emptyTabs());
  let many = M.emptyTabs();
  for (let i = 0; i < M.LIMITS.tabs + 3; i++) many = M.openTab(many, `p${i}`);
  assert.equal(many.open.length, M.LIMITS.tabs);
  assert.equal(many.active, `p${M.LIMITS.tabs + 2}`);
});

// ── Calendar / Project linking
test('tasks, milestones, schedules and the deadline link to a project by id and appear once in Calendar', t => {
  const store = fixture(t);
  const id = store.createProject('user-a', 'Launch', { targetDate: M.toStamp('2026-12-20') });
  const other = store.createProject('user-b', 'Other account');
  const task = store.createTask('user-a', 'Write copy', M.toStamp('2026-12-03'), id);
  const loose = store.createTask('user-a', 'No project', M.toStamp('2026-12-03'));
  const milestone = store.createMilestone('user-a', 'Beta', M.toStamp('2026-12-10'), id);
  const start = M.toStamp('2026-12-05', '14:30');
  const event = store.createEvent('user-a', 'Kickoff', start, new Date(Date.parse(start) + 3600000).toISOString(), id);
  store.createEvent('user-b', 'Elsewhere', start, null, other);
  assert.throws(() => store.createTask('user-a', 'Cross-account', null, other), /project in this account/);

  const page = store.getProjectPage('user-a', id);
  assert.deepEqual([page.tasks.map(x => x.id), page.milestones.map(x => x.id), page.events.map(x => x.id)], [[task], [milestone], [event]]);

  const entries = M.calendarEntries({ projects: store.listProjects('user-a'), tasks: store.listTasks('user-a'), events: store.listEvents('user-a'), milestones: store.listMilestones('user-a') });
  assert.deepEqual(entries.map(e => [e.kind, e.id, e.projectId, e.day, e.time]), [
    ['task', task, id, '2026-12-03', null],
    ['schedule', event, id, '2026-12-05', '14:30'],
    ['milestone', milestone, id, '2026-12-10', null],
    ['deadline', `deadline:${id}`, id, '2026-12-20', null]
  ]);
  assert.ok(!entries.some(e => e.id === loose), 'records without a project are not project entries');
  assert.equal(new Set(entries.map(e => e.id)).size, entries.length, 'no record is listed twice');

  // Completing or deleting the record changes the one shared row.
  store.setCompleted('user-a', 'task', task, true);
  store.deleteMilestone('user-a', milestone);
  assert.throws(() => store.deleteMilestone('user-b', milestone), /Milestone not found/);
  const after = M.calendarEntries({ projects: store.listProjects('user-a'), tasks: store.listTasks('user-a'), events: store.listEvents('user-a'), milestones: store.listMilestones('user-a') });
  assert.deepEqual(after.map(e => [e.kind, e.done]), [['task', true], ['schedule', false], ['deadline', false]]);
  assert.equal(store.getProjectPage('user-a', id).milestones.length, 0);

  // Deleting the project keeps the records but they stop being project entries.
  store.deleteProject('user-a', id);
  assert.equal(store.listTasks('user-a').length, 2);
  assert.deepEqual(M.calendarEntries({ projects: store.listProjects('user-a'), tasks: store.listTasks('user-a'), events: store.listEvents('user-a'), milestones: store.listMilestones('user-a') }), []);
});

test('dates round-trip between a calendar day and a stored timestamp', () => {
  assert.equal(M.localDay(M.toStamp('2026-02-28')), '2026-02-28');
  assert.equal(M.localTime(M.toStamp('2026-02-28', '09:05')), '09:05');
  assert.equal(M.localDay('not a date'), null);
  assert.equal(M.toStamp('nope'), null);
});

test('list groups: Enter adds an item to the same block, an empty last item leaves it, Backspace joins', () => {
  const list = M.createBlock('todo', 'one');
  let blocks = [list];
  let r = M.listEnter(blocks, 0, 0, 3);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].text, 'one\n');
  assert.deepEqual(M.checksOf(r.blocks[0]), [false, false]);
  assert.equal(r.line, 1);
  blocks = r.blocks.slice(); blocks[0] = { ...blocks[0], text: 'one\ntwo', data: { ...blocks[0].data, checks: [true, false], checked: true } };
  r = M.listEnter(blocks, 0, 0, 1); // split in the middle of "one"
  assert.equal(r.blocks[0].text, 'o\nne\ntwo');
  assert.deepEqual(M.checksOf(r.blocks[0]), [true, false, false]);
  blocks = [{ ...list, text: 'a\nb\n', data: { checks: [false, true, false], checked: false } }];
  r = M.listEnter(blocks, 0, 2, 0); // empty last item: leave the group
  assert.equal(r.blocks.length, 2);
  assert.equal(r.blocks[0].text, 'a\nb');
  assert.equal(r.blocks[1].type, 'paragraph');
  assert.equal(r.focus, r.blocks[1].id);
  const back = M.listBack([{ ...list, text: 'a\nb', data: { checks: [true, false], checked: true } }], 0, 1);
  assert.equal(back.blocks[0].text, 'ab');
  assert.equal(back.line, 0);
  assert.equal(back.offset, 1);
  const first = M.listBack([{ ...list, type: 'bullet', text: 'a\nb', data: {} }], 0, 0);
  assert.equal(first.blocks.length, 2);
  assert.equal(first.blocks[0].type, 'paragraph');
  assert.equal(first.blocks[1].text, 'b');
});

test('numbered groups count their items and continue through the next numbered group', () => {
  const a = M.createBlock('numbered', 'x\ny'); const b = M.createBlock('numbered', 'z'); const c = M.createBlock('paragraph', 'p'); const d = M.createBlock('numbered', 'q');
  const n = M.numbering([a, b, c, d]);
  assert.deepEqual([n[a.id], n[b.id], n[d.id]], [1, 3, 1]);
});

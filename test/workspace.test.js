const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createWorkspace } = require('../src/workspace');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'perflw-workspace-'));
  const workspace = createWorkspace(root);
  t.after(() => { workspace.close(); fs.rmSync(root,{recursive:true,force:true}); });
  return workspace;
}

test('task background can be changed, preserved by other edits, and removed', t => {
  const store=fixture(t);
  const task=store.createTask('user-a','Background task',null,null,null,'normal','☑','blue','','','first.png');
  assert.equal(store.listTasks('user-a')[0].image_name,'first.png');
  store.updateTask('user-a',task,{title:'Background task',dueAt:null,priority:'normal',imageName:'second.png'});
  store.updateTask('user-a',task,{title:'Renamed',dueAt:null,priority:'normal'});
  assert.equal(store.listTasks('user-a')[0].image_name,'second.png');
  assert.throws(()=>store.updateTask('user-b',task,{title:'Other',dueAt:null,priority:'normal',imageName:null}),/not found/);
  store.updateTask('user-a',task,{title:'Renamed',dueAt:null,priority:'normal',imageName:null});
  assert.equal(store.listTasks('user-a')[0].image_name,null);
});

test('tasks preserve multiple related skills through unrelated edits', t => {
  const store=fixture(t);
  const id=store.createTask('user-a','Practice',null,null,null,'normal','☑','blue','','Drawing',null,['Drawing','Design']);
  assert.deepEqual(JSON.parse(store.listTasks('user-a')[0].skills_json),['Drawing','Design']);
  store.updateTask('user-a',id,{title:'Practice',dueAt:null,priority:'high'});
  assert.deepEqual(JSON.parse(store.listTasks('user-a')[0].skills_json),['Drawing','Design']);
  store.updateTask('user-a',id,{title:'Practice',dueAt:null,priority:'high',skill:'Design',skills:['Design']});
  assert.deepEqual(JSON.parse(store.listTasks('user-a')[0].skills_json),['Design']);
  assert.equal(store.listTasks('user-a')[0].skill,'Design');
});

test('workspace records stay account-scoped and analytics use saved entries', t => {
  const store = fixture(t);
  const today = new Date();
  const later = new Date(today.getTime() + 86400000).toISOString();
  const start = new Date(today.getTime() - 3600000).toISOString();
  const end = today.toISOString();
  const project = store.createProject('user-a','Launch');
  const goal = store.createGoal('user-a','Publish first version',later,project);
  store.createTask('user-a','Review draft',later,project,goal);
  store.createEvent('user-a','Planning session',later,null,project);
  assert.throws(()=>store.createEvent('user-a','Invalid zero-length event',later,later),/after its start/);
  store.createMilestone('user-a','First release',later,project);
  store.createFocusEntry('user-a',start,end,project);

  assert.equal(store.listProjects('user-a').length,1);
  assert.equal(store.listTasks('user-b').length,0);
  assert.throws(() => store.createTask('user-b','Cross-account task',later,project),/this account/);
});

test('project metadata, derived progress, archive, and delete preserve linked history', t => {
  const store=fixture(t);
  const project=store.createProject('user-a','Website refresh',{description:'Update the site',notes:'Brand references',status:'planned',targetDate:'2026-12-01',color:'#3366cc'});
  const open=store.createTask('user-a','Draft pages',null,project);
  const done=store.createTask('user-a','Audit current site',null,project);
  store.setCompleted('user-a','task',done,true);
  const start=new Date(Date.now()-3600000).toISOString(),end=new Date().toISOString();
  const session=store.createFocusEntry('user-a',start,end,project,'Design review',open);
  const otherProject=store.createProject('user-a','Other project');
  const event=store.createEvent('user-a','Design session',new Date(Date.now()+3600000).toISOString(),null,project,open);
  store.startTimer('user-a','Design task',project,open);
  let listed=store.listProjects('user-a');
  const current=listed.find(item=>item.id===project);
  assert.equal(current.description,'Update the site');
  assert.equal(current.notes,'Brand references');
  assert.equal(current.status,'planned');
  assert.equal(current.open_tasks,1);
  assert.equal(current.completed_tasks,1);
  assert.equal(current.tracked_seconds,3600);
  assert.equal(store.listProjects('user-b').length,0);
  store.updateTask('user-a',open,{title:'Draft pages',dueAt:null,priority:'normal',projectId:otherProject});
  assert.equal(store.listEvents('user-a').find(row=>row.id===event).project_id,otherProject);
  assert.equal(store.activeTimer('user-a').project_id,otherProject);
  store.updateTask('user-a',open,{title:'Draft pages',dueAt:null,priority:'normal',projectId:project});
  store.deleteProject('user-a',otherProject);
  store.archiveProject('user-a',project);
  assert.equal(store.listProjects('user-a').length,0);
  assert.equal(store.listProjects('user-a',true).find(item=>item.id===project).archived_at!==null,true);
  store.archiveProject('user-a',project,false);
  store.updateProject('user-a',project,{name:'Website refresh',description:'Revised scope',status:'active',targetDate:null,color:'#8b5cf6'});
  assert.equal(store.listProjects('user-a').find(item=>item.id===project).description,'Revised scope');
  store.deleteProject('user-a',project);
  assert.equal(store.listProjects('user-a').length,0);
  assert.equal(store.listTasks('user-a').length,2);
  assert.ok(store.listTasks('user-a').every(task=>task.project_id===null));
  assert.equal(store.listFocus('user-a').find(entry=>entry.id===session).project_id,null);
  assert.equal(store.listEvents('user-a').find(row=>row.id===event).project_id,null);
  assert.equal(store.activeTimer('user-a').project_id,null);
});

test('project workspace reads stay scoped and list progress comes from SQLite summaries', t => {
  const store=fixture(t);
  const project=store.createProject('user-a','Focused project');
  const other=store.createProject('user-a','Other project');
  const task=store.createTask('user-a','Scoped task',null,project);
  const completeTask=store.createTask('user-a','Done task',null,project);
  store.setCompleted('user-a','task',completeTask,true);
  const milestone=store.createMilestone('user-a','Scoped milestone',new Date(Date.now()+86400000).toISOString(),project);
  store.createEvent('user-a','Scoped event',new Date(Date.now()+3600000).toISOString(),null,project,task);
  store.createFocusEntry('user-a',new Date(Date.now()-3600000).toISOString(),new Date().toISOString(),project,'Scoped focus',task);
  store.createTask('user-a','Other task',null,other);
  const privateProject=store.createProject('user-b','Private project');
  store.createTask('user-b','Private task',null,privateProject);

  const summary=store.listProjects('user-a').find(row=>row.id===project);
  assert.equal(summary.open_tasks,1);
  assert.equal(summary.completed_tasks,1);
  assert.equal(summary.open_milestones,1);
  assert.equal(summary.completed_milestones,0);
  const data=store.listProjectData('user-a',project);
  assert.deepEqual(data.tasks.map(row=>row.id).sort(),[task,completeTask].sort());
  assert.deepEqual(data.milestones.map(row=>row.id),[milestone]);
  assert.equal(data.events[0].title,'Scoped event');
  assert.equal(data.events[0].linked_task_title,'Scoped task');
  assert.equal(data.focus[0].description,'Scoped focus');
  assert.deepEqual(store.listProjectTaskCandidates('user-a',project,'Other').map(row=>row.title),['Other task']);
  assert.deepEqual(store.listProjectTaskCandidates('user-b',project,'Other'),[]);
  assert.deepEqual(store.listProjectData('user-b',project),{tasks:[],milestones:[],events:[],focus:[]});
});

test('chat lifecycle reports only stored state', t => {
  const store = fixture(t);
  const id = store.createChat('user-a');
  store.renameChat('user-a',id,'Research notes');
  assert.equal(store.listChats('user-a')[0].title,'Research notes');
  store.archiveChat('user-a',id,true);
  assert.equal(store.listChats('user-a').length,0);
  assert.equal(store.listChats('user-a',true).length,1);
  store.deleteChat('user-a',id);
  assert.equal(store.listChats('user-a',true).length,0);
  assert.equal(store.listChats('user-b',true).length,0);
});

test('tasks inherit their goal project and focus records cannot be future-dated', t => {
  const store=fixture(t);
  const first=store.createProject('user-a','First project');
  const second=store.createProject('user-a','Second project');
  const goal=store.createGoal('user-a','Complete scope',null,first);
  store.createTask('user-a','Linked task',null,null,goal);
  assert.equal(store.listTasks('user-a')[0].project_id,first);
  assert.throws(()=>store.createTask('user-a','Mismatched task',null,second,goal),/same project/);
  const future=new Date(Date.now()+60000).toISOString();
  const later=new Date(Date.now()+120000).toISOString();
  assert.throws(()=>store.createFocusEntry('user-a',future,later,first),/cannot end in the future/);
});

test('time tracker stores manual entries and persists, pauses, and saves account timers', async t => {
  const store=fixture(t);
  const project=store.createProject('user-a','Product');
  const task=store.createTask('user-a','Draft launch plan',null,project);
  const yesterday=new Date(); yesterday.setDate(yesterday.getDate()-1); yesterday.setHours(0,0,0,0);
  const manual=store.createManualFocusEntry('user-a','Write project brief',yesterday.toISOString(),35,project,task,'First pass');
  assert.equal(store.listFocus('user-a')[0].id,manual);
  assert.equal(store.listFocus('user-a')[0].duration_seconds,2100);
  assert.equal(store.listFocus('user-a')[0].description,'Write project brief');
  assert.equal(store.listFocus('user-a')[0].note,'First pass');
  store.editFocusEntry('user-a',manual,'Revise project brief','Reviewed',project,task);
  assert.equal(store.listFocus('user-a')[0].description,'Revise project brief');

  const timer=store.startTimer('user-a','Review roadmap',project,task,'Timer note');
  assert.equal(store.activeTimer('user-a').description,'Review roadmap');
  assert.equal(store.activeTimer('user-b'),null);
  const localToday=new Date(); localToday.setHours(0,0,0,0);
  assert.throws(()=>store.createManualFocusEntry('user-a','Overlap',localToday.toISOString(),20),/Stop and save today/);
  store.pauseTimer('user-a');
  assert.equal(store.activeTimer('user-a').paused,1);
  await new Promise(resolve=>setTimeout(resolve,1050));
  store.resumeTimer('user-a');
  await new Promise(resolve=>setTimeout(resolve,1050));
  const saved=store.stopTimer('user-a');
  assert.equal(store.activeTimer('user-a'),null);
  const timerEntry=store.listFocus('user-a').find(entry=>entry.id===saved);
  assert.equal(timerEntry.source,'timer');
  assert.equal(timerEntry.description,'Review roadmap');
  assert.equal(timerEntry.task_id,task);
  assert.ok(timerEntry.duration_seconds>=1 && timerEntry.duration_seconds<=2);
  assert.equal(timerEntry.note,'Timer note');
  store.startTimer('user-a','First task',project,task);
  await new Promise(resolve=>setTimeout(resolve,1050));
  const next=store.switchTimer('user-a','Second task',project,task);
  assert.equal(next.description,'Second task');
  assert.ok(store.listFocus('user-a').some(entry=>entry.description==='First task' && entry.source==='timer'));
  await new Promise(resolve=>setTimeout(resolve,1050));
  store.stopTimer('user-a');
  assert.equal(store.activeTimer('user-a'),null);
});

test('a timer can start at an earlier time but not in the future', t => {
  const store=fixture(t);
  const earlier=new Date(Date.now()-30*60000).toISOString();
  const timer=store.startTimer('user-a','Backdated',null,null,'','',earlier);
  assert.equal(timer.started_at,earlier);
  store.stopTimer('user-a');
  assert.ok(store.listFocus('user-a')[0].duration_seconds>=1799);
  assert.throws(()=>store.startTimer('user-a','Future',null,null,'','',new Date(Date.now()+3600000).toISOString()),/future/);
  assert.throws(()=>store.startTimer('user-a','Bad',null,null,'','','nonsense'),/not valid/);
  assert.equal(store.activeTimer('user-a'),null);
});

test('tasks and actual time entries retain skill links and actual start times', t => {
  const store=fixture(t);
  const project=store.createProject('user-a','Practice project');
  const task=store.createTask('user-a','Write a component',null,project,null,'normal','☑','blue','','React');
  assert.equal(store.listTasks('user-a').find(row=>row.id===task).skill,'React');
  const timer=store.startTimer('user-a','Write a component',null,task,'Timer note');
  assert.equal(timer.project_id,project,'a task should supply its linked project when the caller omits it');
  assert.equal(timer.skill,'React','a timer started from a task should inherit that task skill');
  assert.throws(()=>store.updateTask('user-b',task,{title:'Other account',skill:'Python'}),/not found/);
  const localYesterday=new Date();localYesterday.setDate(localYesterday.getDate()-1);localYesterday.setHours(0,0,0,0);
  const manual=store.createManualFocusEntry('user-a','Manual React work',localYesterday.toISOString().slice(0,10),45,project,task,'Saved note','09:20','Writing');
  const manualRow=store.listFocus('user-a').find(row=>row.id===manual);
  assert.equal(manualRow.skill,'Writing');
  assert.equal(new Date(manualRow.started_at).getHours(),9);
  assert.equal(new Date(manualRow.started_at).getMinutes(),20);
  assert.equal(new Date(manualRow.ended_at)-new Date(manualRow.started_at),45*60*1000);
  store.editFocusEntry('user-a',manual,'Revised session','Revised note',project,task,'Editing',new Date(localYesterday.getTime()+10*3600000).toISOString(),new Date(localYesterday.getTime()+11*3600000).toISOString());
  const edited=store.listFocus('user-a').find(row=>row.id===manual);
  assert.equal(edited.skill,'Editing');
  assert.equal(edited.duration_seconds,3600);
  assert.equal(edited.description,'Revised session');
  assert.throws(()=>store.createManualFocusEntry('user-b','Future work',new Date(Date.now()+3*86400000).toISOString().slice(0,10),30,null,null,'','23:59'),/future/);
});

test('time tracker migration preserves existing focus records', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'perflw-workspace-migration-'));
  const legacy=new DatabaseSync(path.join(root,'workspace.sqlite'));
  legacy.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE focus_entries(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT REFERENCES projects(id),
      started_at TEXT NOT NULL,ended_at TEXT NOT NULL,duration_seconds INTEGER NOT NULL CHECK(duration_seconds>0));`);
  legacy.prepare('INSERT INTO focus_entries VALUES(?,?,?,?,?,?)').run('legacy-entry','user-a',null,'2026-10-19T01:00:00.000Z','2026-10-19T01:30:00.000Z',1800);
  legacy.close();
  const store=createWorkspace(root);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const entry=store.listFocus('user-a')[0];
  assert.equal(entry.id,'legacy-entry');
  assert.equal(entry.description,'Focus session');
  assert.equal(entry.source,'manual');
});

test('planner scheduling, event independence, focus links, deletion policy, isolation, and restart', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'perflw-planner-'));
  let store=createWorkspace(root);
  const project=store.createProject('user-a','Planner project');
  const task=store.createTask('user-a','Prepare review',new Date(Date.now()+86400000).toISOString(),project,null,'high');
  assert.equal(store.listEvents('user-a').length,0,'task capture must not create a Calendar event');
  assert.equal(store.listTasks('user-a')[0].priority,'high');
  const starts=new Date(Date.now()+3600000).toISOString();
  const event=store.createEvent('user-a','Review session',starts,null,project,task,'gold','Event','','','0123456789abcdef0123456789abcdef.png');
  assert.equal(store.listEvents('user-a')[0].task_id,task);
  assert.equal(store.listEvents('user-a')[0].theme,'gold');
  assert.equal(store.listEvents('user-a')[0].image_name,'0123456789abcdef0123456789abcdef.png');
  assert.throws(()=>store.createEvent('user-a','Invalid theme',starts,null,project,task,'violet'),/schedule theme/);
  assert.throws(()=>store.createEvent('user-b','Cross-account link',starts,null,null,task),/this account/);
  assert.throws(()=>store.createEvent('user-a','Invalid link',starts,null,null,'missing-task'),/this account/);
  const moved=new Date(Date.now()+7200000).toISOString();
  store.updateEvent('user-a',event,{title:'Moved review',startsAt:moved,endsAt:null,projectId:project});
  store.updateTask('user-a',task,{title:'Prepare review',dueAt:new Date(Date.now()+172800000).toISOString(),priority:'low'});
  assert.equal(store.listEvents('user-a')[0].starts_at,new Date(moved).toISOString(),'deadline edits must not move scheduled events');
  assert.equal(store.listEvents('user-a')[0].theme,'gold','event updates that omit a theme must retain it');
  const goal=store.createGoal('user-a','Complete review',null,project);
  store.updateTask('user-a',task,{title:'Prepare review',dueAt:new Date(Date.now()+172800000).toISOString(),priority:'low',goalId:goal,icon:'✦',theme:'violet',notes:'Updated from Planner'});
  const editedTask=store.listTasks('user-a').find(row=>row.id===task);
  assert.equal(editedTask.goal_id,goal,'Planner task edits should persist the linked goal');
  assert.equal(editedTask.icon,'✦');
  assert.equal(editedTask.theme,'violet');
  assert.equal(editedTask.notes,'Updated from Planner');
  assert.throws(()=>store.updateTask('user-a',task,{title:'Prepare review',dueAt:editedTask.due_at,priority:'low',goalId:'missing-goal'}),/goal/i);
  store.updateEvent('user-a',event,{title:'Moved review',startsAt:moved,endsAt:null,projectId:project,theme:'maroon-red'});
  assert.equal(store.listEvents('user-a')[0].theme,'maroon-red');
  store.updateEvent('user-a',event,{title:'Moved review',startsAt:moved,endsAt:null,projectId:project,taskId:null});
  assert.equal(store.listEvents('user-a')[0].task_id,null,'schedule edits should allow clearing a linked task');
  store.updateEvent('user-a',event,{title:'Moved review',startsAt:moved,endsAt:null,projectId:project,taskId:task});
  assert.equal(store.listEvents('user-a')[0].task_id,task,'schedule edits should preserve the selected task link');
  assert.throws(()=>store.updateEvent('user-a',event,{title:'Moved review',startsAt:moved,endsAt:null,projectId:project,theme:'violet'}),/schedule theme/);
  store.setCompleted('user-a','task',task,true);
  assert.equal(store.listEvents('user-a').length,1,'completion must preserve scheduled events');
  assert.throws(()=>store.updateTask('user-b',task,{title:'Overwrite',dueAt:null,priority:'high'}),/not found/);
  store.startTimer('user-a','Work on review',project,task);
  assert.equal(store.activeTimer('user-a').task_id,task);
  store.close();
  store=createWorkspace(root);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(store.listEvents('user-a')[0].task_id,task,'task/event link must persist across restart');
  assert.equal(store.listEvents('user-a')[0].theme,'maroon-red','schedule theme must persist across restart');
  assert.equal(store.listEvents('user-a')[0].image_name,'0123456789abcdef0123456789abcdef.png','schedule image must survive edits and restart');
  assert.equal(store.activeTimer('user-a').task_id,task,'active focus association must persist across restart');
  store.deleteEvent('user-a',event);
  assert.equal(store.listTasks('user-a').length,1,'deleting an event must preserve its task');
  const event2=store.createEvent('user-a','Review follow-up',starts,null,project,task);
  store.deleteTask('user-a',task,'keep-events');
  assert.equal(store.listEvents('user-a').find(row=>row.id===event2).task_id,null,'keep-events policy must explicitly unlink the event');
  assert.equal(store.listFocus('user-a').length,0);
  assert.equal(store.activeTimer('user-a').task_id,null,'foreign-key behavior must not leave a dangling active timer link');
  const task2=store.createTask('user-a','Second review',null,project);
  const event3=store.createEvent('user-a','Second session',starts,null,project,task2);
  store.deleteTask('user-a',task2,'delete-events');
  assert.equal(store.listEvents('user-a').some(row=>row.id===event3),false,'delete-events policy must remove linked events atomically');
  assert.equal(store.listTasks('user-b').length,0);
  assert.equal(store.listEvents('user-b').length,0);
});

test('scheduled task creation links a calendar event and rolls back invalid ranges', t => {
  const store=fixture(t);
  const start='2026-11-01T01:00:00.000Z', end='2026-11-01T02:00:00.000Z';
  const task=store.createTask('user-a','Scheduled work',null,null,null,'normal','☑','blue','','',null,[],{startsAt:start,endsAt:end});
  const event=store.listEvents('user-a')[0];
  assert.equal(event.task_id,task);
  assert.equal(event.starts_at,start);
  assert.equal(event.ends_at,end);
  assert.equal(event.event_type,'Task schedule');
  assert.throws(()=>store.createTask('user-a','Invalid',null,null,null,'normal','☑','blue','','',null,[],{startsAt:end,endsAt:start}),/after its start/);
  assert.equal(store.listTasks('user-a').length,1);
  assert.equal(store.listEvents('user-a').length,1);
});


test('task changes sync matching schedules and deletion removes task schedules only', t => {
  const store=fixture(t);
  const start='2026-11-01T01:00:00.000Z', end='2026-11-01T02:00:00.000Z';
  const task=store.createTask('user-a','Draft',null,null,null,'normal','☑','blue','','',null,[],{startsAt:start,endsAt:end});
  const custom=store.createEvent('user-a','Custom session',start,end,null,task,'light-blue','Task schedule');
  const event=store.createEvent('user-a','Meeting',start,end,null,task,'light-blue','Event');
  store.updateTask('user-a',task,{title:'Revised',dueAt:null,priority:'normal'});
  const events=store.listEvents('user-a');
  assert.equal(events.find(row=>row.id!==custom && row.id!==event).title,'Revised');
  assert.equal(events.find(row=>row.id===custom).title,'Custom session');
  store.deleteTask('user-a',task,'delete-task-schedules');
  assert.equal(store.listTasks('user-a').length,0);
  assert.deepEqual(store.listEvents('user-a').map(row=>[row.id,row.task_id]),[[event,null]]);
});


test('editing a task updates its selected schedule atomically', t => {
  const store=fixture(t);
  const start='2026-11-01T01:00:00.000Z', end='2026-11-01T02:00:00.000Z';
  const task=store.createTask('user-a','Task',null,null,null,'normal','☑','blue','','',null,[],{startsAt:start,endsAt:end});
  const event=store.listEvents('user-a')[0];
  const later='2026-11-01T03:00:00.000Z';
  store.updateTask('user-a',task,{title:'Task',dueAt:null,priority:'normal',schedule:{id:event.id,startsAt:end,endsAt:later}});
  assert.equal(store.listEvents('user-a')[0].starts_at,end);
  assert.throws(()=>store.updateTask('user-a',task,{title:'Invalid change',dueAt:null,priority:'normal',schedule:{id:event.id,startsAt:later,endsAt:end}}),/after its start/);
  assert.equal(store.listTasks('user-a')[0].title,'Task');
  assert.equal(store.listEvents('user-a')[0].starts_at,end);
  store.updateTask('user-a',task,{title:'Task',dueAt:null,priority:'normal',schedule:{id:event.id,startsAt:null,endsAt:null}});
  assert.equal(store.listEvents('user-a').length,0);
});


const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* Interface preferences saved before the rename to Perflw used "impct" key prefixes. Copy them once, before
   any page script reads them; existing Perflw keys win. */
try {
  const store = window.localStorage;
  for (const key of Object.keys(store)) {
    if (!key.startsWith('impct')) continue;
    const renamed = `perflw${key.slice(5)}`;
    if (store.getItem(renamed) === null) store.setItem(renamed, store.getItem(key));
    store.removeItem(key);
  }
} catch { /* storage unavailable: preferences start from defaults */ }

function call(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then(result => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
}
contextBridge.exposeInMainWorld('account', Object.freeze({
  state: () => call('auth:state'),
  register: (email, password, confirmation) => call('auth:register', email, password, confirmation),
  login: (email, password) => call('auth:login', email, password),
  pickImage: () => call('auth:pickImage'),
  saveProfile: (name, bio, imageName, coverImageName = null, coverTheme = 'aurora', coverPosition = 'center 52%') =>
    call('auth:saveProfile', name, bio, imageName, coverImageName, coverTheme, coverPosition),
  logout: () => call('auth:logout')
}));
contextBridge.exposeInMainWorld('windowControls', Object.freeze({
  minimize: () => call('window:minimize'),
  toggleMaximize: () => call('window:toggleMaximize'),
  isMaximized: () => call('window:isMaximized'),
  close: () => call('window:close'),
  version: () => call('app:version'),
  onMaximizeChange: listener => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, value) => listener(Boolean(value));
    ipcRenderer.on('window:maximized', wrapped);
    return () => ipcRenderer.removeListener('window:maximized', wrapped);
  }
}));
contextBridge.exposeInMainWorld('plannerData', Object.freeze({
  items: kind => call('planner:items', kind),
  create: item => call('planner:create', item),
  update: (id, changes) => call('planner:update', id, changes),
  remove: id => call('planner:delete', id)
}));
contextBridge.exposeInMainWorld('workspaceData', Object.freeze({
  chatMessages: chatId => call('workspace:chatMessages', chatId),
  addChatMessage: (chatId, content) => call('workspace:addChatMessage', chatId, content),
  projects: includeArchived => call('workspace:projects',includeArchived),
  projectData: projectId => call('workspace:projectData',projectId),
  projectPage: projectId => call('workspace:projectPage',projectId),
  saveProjectPage: (projectId,page) => call('workspace:saveProjectPage',projectId,page),
  deleteMilestone: id => call('workspace:deleteMilestone',id),
  createProject: (name,details) => call('workspace:createProject',name,details),
  deleteProject: id => call('workspace:deleteProject',id),
  tasks: () => call('workspace:tasks'),
  createTask: (title,dueAt,projectId,goalId,priority,icon,theme,notes,skill,imageName,skills,schedule) => call('workspace:createTask',title,dueAt,projectId,goalId,priority,icon,theme,notes,skill,imageName,skills,schedule),
  deleteTask: (id,eventPolicy) => call('workspace:deleteTask',id,eventPolicy),
  setCompleted: (entity,id,completed) => call('workspace:complete',entity,id,completed),
  events: () => call('workspace:events'),
  createEvent: (title,startsAt,endsAt,projectId,taskId,theme,eventType,location,notes,imageName) => call('workspace:createEvent',title,startsAt,endsAt,projectId,taskId,theme,eventType,location,notes,imageName),
  updateEvent: (id,event) => call('workspace:updateEvent',id,event),
  deleteEvent: id => call('workspace:deleteEvent',id),
  milestones: () => call('workspace:milestones'),
  createMilestone: (title,dueAt,projectId) => call('workspace:createMilestone',title,dueAt,projectId),
  focus: () => call('workspace:focus'),
  activeTimer: () => call('workspace:activeTimer'),
  startTimer: (description,projectId,taskId,note,skill,startedAt) => call('workspace:startTimer',description,projectId,taskId,note,skill,startedAt),
  stopTimer: () => call('workspace:stopTimer'),
  chats: includeArchived => call('workspace:chats',includeArchived),
  createChat: (title, category) => call('workspace:createChat',title,category || null),
  setChatCategory: (id,category) => call('workspace:setChatCategory',id,category),
  renameChat: (id,title) => call('workspace:renameChat',id,title),
  archiveChat: (id,archived) => call('workspace:archiveChat',id,archived),
  deleteChat: id => call('workspace:deleteChat',id)
}));
contextBridge.exposeInMainWorld('learningData', Object.freeze({
  subjects: profile => call('learning:subjects', profile),
  createSubject: (profile, details) => call('learning:createSubject', profile, details),
  updateSubject: (id, details) => call('learning:updateSubject', id, details),
  deleteSubject: id => call('learning:deleteSubject', id),
  // Journeys, question bank, assessments and mastery (LS-007): one object argument each.
  journeyList: arg => call('journey:list', arg),
  journeyCreate: arg => call('journey:create', arg),
  journeyGet: arg => call('journey:get', arg),
  journeyUpdate: arg => call('journey:update', arg),
  questionsList: arg => call('questions:list', arg),
  questionsSave: arg => call('questions:save', arg),
  questionsRetire: arg => call('questions:retire', arg),
  questionsDelete: arg => call('questions:delete', arg),
  questionsTemplates: arg => call('questions:templates', arg),
  aiStatus: arg => call('ai:status', arg || {}),
  questionsGenerate: arg => call('questions:generate', arg),
  questionsReview: arg => call('questions:review', arg),
  assessmentAiGrade: arg => call('assessment:aiGrade', arg),
  assessmentAcceptGrade: arg => call('assessment:acceptGrade', arg),
  assessmentCreate: arg => call('assessment:create', arg),
  assessmentStart: arg => call('assessment:start', arg),
  assessmentList: arg => call('assessment:list', arg),
  assessmentGet: arg => call('assessment:get', arg),
  assessmentSaveAnswer: arg => call('assessment:saveAnswer', arg),
  assessmentSubmit: arg => call('assessment:submit', arg),
  assessmentAbandon: arg => call('assessment:abandon', arg),
  assessmentGrade: arg => call('assessment:grade', arg),
  assessmentResults: arg => call('assessment:results', arg),
  masterySubject: arg => call('mastery:subject', arg),
  masteryJourney: arg => call('mastery:journey', arg),
  masteryReport: arg => call('mastery:report', arg),
  reviewDue: arg => call('review:due', arg),
  assessmentAnalysis: arg => call('assessment:analysis', arg),
  notesTargeted: arg => call('notes:targeted', arg),
  notesList: arg => call('notes:list', arg),
  studyStart: arg => call('study:start', arg),
  studyActive: arg => call('study:active', arg || {}),
  studyTouch: arg => call('study:touch', arg),
  studyVisit: arg => call('study:visit', arg),
  studySideNote: arg => call('study:sideNote', arg),
  studyNotes: arg => call('study:notes', arg),
  studyEnd: arg => call('study:end', arg),
  assessmentCheck: arg => call('assessment:check', arg),
  assessmentRetry: arg => call('assessment:retry', arg),
  assessmentRetakeStatus: arg => call('assessment:retakeStatus', arg),
  journeyEvaluation: arg => call('journey:evaluation', arg),
  learningHistory: arg => call('learning:history', arg),
  retentionStatus: arg => call('retention:status', arg),
  scheduleCreate: arg => call('schedule:create', arg),
  scheduleList: arg => call('schedule:list', arg),
  scheduleCancel: arg => call('schedule:cancel', arg),
  examPreview: arg => call('exam:preview', arg),
  examAttempts: arg => call('exam:attempts', arg),
  topics: subjectId => call('learning:topics', subjectId),
  addTopic: (subjectId, details) => call('learning:addTopic', subjectId, details),
  renameTopic: (topicId, title) => call('learning:renameTopic', topicId, title),
  saveTopicOrder: (subjectId, order) => call('learning:saveTopicOrder', subjectId, order),
  deleteTopics: (subjectId, ids) => call('learning:deleteTopics', subjectId, ids),
  uploadTopics: subjectId => call('learning:uploadTopics', subjectId),
  // A file dropped on the Topics card: only its path on disk goes to the main process, which reads it.
  importDroppedTopics: (subjectId, file) => call('learning:importDroppedTopics', subjectId, webUtils.getPathForFile(file)),
  // Topic viewer: what to show for a file (PDF URL, or kept text), and a notice when Office finishes a PDF copy.
  filePreview: fileId => call('learning:filePreview', fileId),
  retryPreview: fileId => call('learning:retryPreview', fileId),
  fileBytes: fileId => call('learning:fileBytes', fileId),
  annotations: fileId => call('learning:annotations', fileId),
  saveAnnotations: (fileId, data) => call('learning:saveAnnotations', fileId, data),
  onPreviewChanged: listener => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, fileId) => listener(String(fileId));
    ipcRenderer.on('learning:previewChanged', wrapped);
    return () => ipcRenderer.removeListener('learning:previewChanged', wrapped);
  },
  // Learning document workflow: key points for the notes panel, saved notes, the .md files, and the Ask panel.
  analysis: fileId => call('learning:analysis', fileId),
  reanalyze: fileId => call('learning:reanalyze', fileId),
  notes: subjectId => call('learning:notes', subjectId),
  deleteNote: (subjectId, noteId) => call('learning:deleteNote', subjectId, noteId),
  openNotesFile: (subjectId, docId) => call('learning:openNotesFile', subjectId, docId || null),
  ask: (subjectId, fileId, question, requestId, history = [], about = null) => call('learning:ask', subjectId, fileId, question, requestId, history, about),
  cancelAsk: requestId => call('learning:cancelAsk', requestId),
  saveLearned: (subjectId, item) => call('learning:saveLearned', subjectId, item),
  preferences: () => call('learning:preferences'),
  deletePreference: id => call('learning:deletePreference', id),
  onIntelEvent: listener => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, data) => listener(data && typeof data === 'object' ? { ...data } : {});
    ipcRenderer.on('learning:intelEvent', wrapped);
    return () => ipcRenderer.removeListener('learning:intelEvent', wrapped);
  },
  onAskEvent: listener => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, data) => listener(data && typeof data === 'object' ? { ...data } : {});
    ipcRenderer.on('learning:askEvent', wrapped);
    return () => ipcRenderer.removeListener('learning:askEvent', wrapped);
  },
  pickImage: () => call('auth:pickImage')
}));
contextBridge.exposeInMainWorld('automationData', Object.freeze({
  agents: () => call('automation:agents'),
  saveAgent: agent => call('automation:saveAgent', agent),
  deleteAgent: id => call('automation:deleteAgent', id),
  models: () => call('automation:models'),
  workflows: () => call('automation:workflows'),
  workflow: id => call('automation:workflow', id),
  createWorkflow: workflow => call('automation:createWorkflow', workflow),
  updateWorkflow: (id, changes) => call('automation:updateWorkflow', id, changes),
  duplicateWorkflow: id => call('automation:duplicateWorkflow', id),
  deleteWorkflow: id => call('automation:deleteWorkflow', id),
  importMarkdown: () => call('automation:importMarkdown'),
  run: (runId, graph, prompt) => call('automation:run', runId, graph, prompt),
  cancel: runId => call('automation:cancel', runId),
  // Agent Ecosystem: editable agent files, skills and provider connections (API keys go in, never come back out).
  meta: () => call('ecosystem:meta'),
  agent: id => call('agents:get', id),
  readAgentFile: (id, file) => call('agents:readFile', id, file),
  writeAgentFile: (id, file, content) => call('agents:writeFile', id, file, content),
  deleteAgentFile: (id, file) => call('agents:deleteFile', id, file),
  updateAgentConfig: (id, patch) => call('agents:updateConfig', id, patch),
  duplicateAgent: id => call('agents:duplicate', id),
  exportAgent: id => call('agents:export', id),
  importAgent: () => call('agents:import'),
  pickFolder: () => call('agents:pickFolder'),
  skills: () => call('skills:list'),
  skill: id => call('skills:get', id),
  createSkill: input => call('skills:create', input),
  readSkillFile: (id, file) => call('skills:readFile', id, file),
  writeSkillFile: (id, file, content) => call('skills:writeFile', id, file, content),
  deleteSkillFile: (id, file) => call('skills:deleteFile', id, file),
  setSkillEnabled: (id, enabled) => call('skills:setEnabled', id, enabled),
  duplicateSkill: id => call('skills:duplicate', id),
  deleteSkill: id => call('skills:delete', id),
  exportSkill: id => call('skills:export', id),
  importSkill: () => call('skills:import'),
  runSkillScript: request => call('skills:runScript', request),
  providers: () => call('providers:list'),
  saveProvider: changes => call('providers:save', changes),
  removeProvider: id => call('providers:remove', id),
  testProvider: draft => call('providers:test', draft),
  providerModels: id => call('providers:models', id),
  onEvent: listener => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('automation:event', wrapped);
    return () => ipcRenderer.removeListener('automation:event', wrapped);
  }
}));
/* Chat sessions: settings per conversation, the orchestration engine and its live events. */
contextBridge.exposeInMainWorld('chatData', Object.freeze({
  session: chatId => call('chat:session', chatId),
  updateSettings: (chatId, patch) => call('chat:updateSettings', chatId, patch),
  resources: () => call('chat:resources'),
  setDefaults: chatId => call('chat:setDefaults', chatId),
  addMemory: text => call('chat:addMemory', text),
  deleteMemory: id => call('chat:deleteMemory', id),
  send: (chatId, content, options) => call('chat:send', chatId, content, options || null),
  cancel: chatId => call('chat:cancel', chatId),
  openExternal: url => call('app:openExternal', url),
  copyText: text => call('app:copyText', text),
  onEvent: listener => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('chat:event', wrapped);
    return () => ipcRenderer.removeListener('chat:event', wrapped);
  }
}));


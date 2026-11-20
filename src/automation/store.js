'use strict';
/* Agentic Automation — account-scoped storage for personal agents and workflows.
   Shares the workspace database; every query is filtered by user_id. */
const { randomUUID } = require('node:crypto');
const { cleanGraph, emptyGraph, LIMITS } = require('./engine');

const fail = message => { throw new Error(message); };
const now = () => new Date().toISOString();

function createAutomationStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agents_user_name ON agents(user_id, name);
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      graph_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflows_user_updated ON workflows(user_id, updated_at);`);

  function required(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} must be 1–${max} characters.`);
    return value.trim();
  }
  function optional(value, label, max) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > max) fail(`${label} must be ${max.toLocaleString('en-US')} characters or fewer.`);
    return value.trim();
  }
  const model = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value)) fail('Choose a model for this agent.');
    return value;
  };

  // ── Agents
  const publicAgent = row => ({ id: row.id, name: row.name, description: row.description, instructions: row.instructions, model: row.model, createdAt: row.created_at, updatedAt: row.updated_at });
  function listAgents(userId) {
    return db.prepare('SELECT * FROM agents WHERE user_id=? ORDER BY name COLLATE NOCASE, created_at').all(userId).map(publicAgent);
  }
  function getAgent(userId, agentId) {
    const row = db.prepare('SELECT * FROM agents WHERE id=? AND user_id=?').get(agentId, userId);
    if (!row) fail('Agent not found.');
    return publicAgent(row);
  }
  function saveAgent(userId, agent = {}) {
    if (!agent || typeof agent !== 'object') fail('Invalid agent.');
    const values = [required(agent.name, 'Agent name', 80), optional(agent.description, 'Description', 300), optional(agent.instructions, 'Instructions', 20000), model(agent.model)];
    const timestamp = now();
    if (agent.id) {
      const result = db.prepare('UPDATE agents SET name=?,description=?,instructions=?,model=?,updated_at=? WHERE id=? AND user_id=?').run(...values, timestamp, agent.id, userId);
      if (!result.changes) fail('Agent not found.');
      return getAgent(userId, agent.id);
    }
    if (db.prepare('SELECT COUNT(*) AS total FROM agents WHERE user_id=?').get(userId).total >= 200) fail('You can keep up to 200 agents.');
    const agentId = randomUUID();
    db.prepare('INSERT INTO agents (id,user_id,name,description,instructions,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(agentId, userId, ...values, timestamp, timestamp);
    return getAgent(userId, agentId);
  }
  /* Keeps the legacy instructions/model columns in step with the agent's package files (which are the
     source of truth at runtime), so older readers of this table still see current values. */
  function mirrorAgent(userId, agentId, { instructions, model: modelName }) {
    const row = db.prepare('SELECT * FROM agents WHERE id=? AND user_id=?').get(agentId, userId);
    if (!row) fail('Agent not found.');
    const nextInstructions = typeof instructions === 'string' ? instructions.slice(0, 20000) : row.instructions;
    const nextModel = typeof modelName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(modelName) ? modelName : row.model;
    if (nextInstructions === row.instructions && nextModel === row.model) return;
    db.prepare('UPDATE agents SET instructions=?,model=?,updated_at=? WHERE id=? AND user_id=?').run(nextInstructions, nextModel, now(), agentId, userId);
  }
  function deleteAgent(userId, agentId) {
    const result = db.prepare('DELETE FROM agents WHERE id=? AND user_id=?').run(agentId, userId);
    if (!result.changes) fail('Agent not found.');
  }

  // ── Workflows
  const summary = row => ({ id: row.id, title: row.title, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at });
  function listWorkflows(userId) {
    return db.prepare('SELECT id,title,description,created_at,updated_at FROM workflows WHERE user_id=? ORDER BY updated_at DESC, rowid DESC').all(userId).map(summary);
  }
  function getWorkflow(userId, workflowId) {
    const row = db.prepare('SELECT * FROM workflows WHERE id=? AND user_id=?').get(workflowId, userId);
    if (!row) fail('Workflow not found.');
    let graph;
    try { graph = cleanGraph(JSON.parse(row.graph_json)); } catch { graph = emptyGraph(); }
    return { ...summary(row), graph };
  }
  function createWorkflow(userId, workflow = {}) {
    if (!workflow || typeof workflow !== 'object') fail('Invalid workflow.');
    if (db.prepare('SELECT COUNT(*) AS total FROM workflows WHERE user_id=?').get(userId).total >= 200) fail('You can keep up to 200 workflows.');
    const workflowId = randomUUID(); const timestamp = now();
    const graph = cleanGraph(workflow.graph === undefined ? emptyGraph() : workflow.graph);
    db.prepare('INSERT INTO workflows (id,user_id,title,description,graph_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(workflowId, userId, required(workflow.title === undefined ? 'Untitled workflow' : workflow.title, 'Workflow title', LIMITS.title), optional(workflow.description, 'Description', 300), JSON.stringify(graph), timestamp, timestamp);
    return getWorkflow(userId, workflowId);
  }
  function updateWorkflow(userId, workflowId, changes = {}) {
    if (!changes || typeof changes !== 'object') fail('Invalid changes.');
    const row = db.prepare('SELECT * FROM workflows WHERE id=? AND user_id=?').get(workflowId, userId);
    if (!row) fail('Workflow not found.');
    const title = changes.title === undefined ? row.title : required(changes.title, 'Workflow title', LIMITS.title);
    const description = changes.description === undefined ? row.description : optional(changes.description, 'Description', 300);
    const graphJson = changes.graph === undefined ? row.graph_json : JSON.stringify(cleanGraph(changes.graph));
    db.prepare('UPDATE workflows SET title=?,description=?,graph_json=?,updated_at=? WHERE id=? AND user_id=?').run(title, description, graphJson, now(), workflowId, userId);
    return getWorkflow(userId, workflowId);
  }
  function duplicateWorkflow(userId, workflowId) {
    const source = getWorkflow(userId, workflowId);
    return createWorkflow(userId, { title: `${source.title} copy`.slice(0, LIMITS.title), description: source.description, graph: source.graph });
  }
  function deleteWorkflow(userId, workflowId) {
    const result = db.prepare('DELETE FROM workflows WHERE id=? AND user_id=?').run(workflowId, userId);
    if (!result.changes) fail('Workflow not found.');
  }

  return { listAgents, getAgent, saveAgent, mirrorAgent, deleteAgent, listWorkflows, getWorkflow, createWorkflow, updateWorkflow, duplicateWorkflow, deleteWorkflow };
}

module.exports = { createAutomationStore };

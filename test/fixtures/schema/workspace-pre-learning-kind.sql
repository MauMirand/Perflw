-- PF-006 old-install fixture 1: an early install, before planner_items accepted 'learning'.
-- Many tables lack columns that later startups added; user_version is 0 (no schema version before PF-006).
CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE goals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL, due_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL, title TEXT NOT NULL,
  due_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT
);
CREATE TABLE focus_entries (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL, duration_seconds INTEGER NOT NULL CHECK(duration_seconds > 0)
);
CREATE TABLE active_timers (
  user_id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, description TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL, segment_started_at TEXT, elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
  archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE planner_items (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('plan','whim','routine','activity')),
  text TEXT NOT NULL, day TEXT, time TEXT, done_on TEXT, position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX planner_items_user_kind ON planner_items(user_id, kind, day);

INSERT INTO projects VALUES ('p1', 'user-a', 'Thesis', '2025-01-05T08:00:00.000Z');
INSERT INTO goals VALUES ('g1', 'user-a', 'p1', 'Draft chapter 1', '2025-02-01', NULL, '2025-01-05T08:01:00.000Z');
INSERT INTO tasks VALUES ('t1', 'user-a', 'p1', 'g1', 'Outline', '2025-01-20', NULL, '2025-01-05T08:02:00.000Z');
INSERT INTO tasks VALUES ('t2', 'user-a', NULL, NULL, 'Buy notebook', NULL, '2025-01-06T09:00:00.000Z', '2025-01-05T08:03:00.000Z');
INSERT INTO events VALUES ('e1', 'user-a', 'p1', 'Advisor meeting', '2025-01-10T09:00:00.000Z', '2025-01-10T10:00:00.000Z');
INSERT INTO focus_entries VALUES ('f1', 'user-a', 'p1', '2025-01-07T08:00:00.000Z', '2025-01-07T08:25:00.000Z', 1500);
INSERT INTO active_timers VALUES ('user-a', 'p1', 't1', 'Reading', '', '2025-01-08T08:00:00.000Z', '2025-01-08T08:00:00.000Z', 0, 0);
INSERT INTO chat_sessions VALUES ('c1', 'user-a', 'Study help', NULL, '2025-01-05T10:00:00.000Z', '2025-01-05T10:05:00.000Z');
INSERT INTO chat_messages VALUES ('m1', 'user-a', 'c1', 'user', 'Hello', '2025-01-05T10:00:00.000Z');
INSERT INTO chat_messages VALUES ('m2', 'user-a', 'c1', 'assistant', 'Hi there', '2025-01-05T10:00:01.000Z');
INSERT INTO planner_items VALUES ('pl1', 'user-a', 'whim', 'Keep me', NULL, NULL, NULL, 0, '2025-01-05T11:00:00.000Z', '2025-01-05T11:00:00.000Z');
INSERT INTO planner_items VALUES ('pl2', 'user-a', 'routine', 'Morning run', '2025-01-06', '07:00', NULL, 1, '2025-01-05T11:01:00.000Z', '2025-01-05T11:01:00.000Z');

-- PF-006 old-install fixture 2: Learning subjects exist, but subject_files has neither preview_name nor
-- preview_status and subject_topics has no page column. planner_items already accepts 'learning'. user_version 0.
CREATE TABLE planner_items (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('plan','whim','routine','activity','learning')),
  text TEXT NOT NULL, day TEXT, time TEXT, done_on TEXT, position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE subjects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, profile TEXT NOT NULL CHECK (profile IN ('study','personal')),
  name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'major' CHECK (type IN ('major','minor')),
  mastery INTEGER NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 100), minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  description TEXT NOT NULL DEFAULT '', image_name TEXT, position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE subject_files (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, stored_name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE subject_topics (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('topic','milestone')), level INTEGER NOT NULL DEFAULT 0 CHECK (level IN (0,1)),
  title TEXT NOT NULL, file_id TEXT REFERENCES subject_files(id) ON DELETE SET NULL, position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

INSERT INTO planner_items VALUES ('pl1', 'user-a', 'learning', 'Spanish', NULL, NULL, NULL, 0, '2025-03-01T08:00:00.000Z', '2025-03-01T08:00:00.000Z');
INSERT INTO subjects VALUES ('s1', 'user-a', 'study', 'Biology', 'major', 40, 90, 'Cells', NULL, 0, '2025-03-01T09:00:00.000Z', '2025-03-01T09:00:00.000Z');
INSERT INTO subject_files VALUES ('sf1', 'user-a', 's1', 'cells.pdf', 'sf1.pdf', 'application/pdf', 2048, 'Cell membrane text', '2025-03-01T09:05:00.000Z');
INSERT INTO subject_topics VALUES ('st1', 'user-a', 's1', 'topic', 0, 'Cell membrane', 'sf1', 0, '2025-03-01T09:06:00.000Z', '2025-03-01T09:06:00.000Z');
INSERT INTO subject_topics VALUES ('st2', 'user-a', 's1', 'milestone', 1, 'Midterm', NULL, 1, '2025-03-01T09:07:00.000Z', '2025-03-01T09:07:00.000Z');

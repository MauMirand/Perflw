-- PF-006 old-install fixture 3: subject_files has preview_name but not preview_status (the state the old single
-- guard on preview_name could never repair). subject_topics already has page. user_version 0.
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
  created_at TEXT NOT NULL, preview_name TEXT
);
CREATE TABLE subject_topics (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('topic','milestone')), level INTEGER NOT NULL DEFAULT 0 CHECK (level IN (0,1)),
  title TEXT NOT NULL, file_id TEXT REFERENCES subject_files(id) ON DELETE SET NULL, position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, page INTEGER
);

INSERT INTO subjects VALUES ('s1', 'user-a', 'personal', 'Guitar', 'minor', 10, 30, '', NULL, 0, '2025-04-01T09:00:00.000Z', '2025-04-01T09:00:00.000Z');
INSERT INTO subject_files VALUES ('sf1', 'user-a', 's1', 'chords.docx', 'sf1.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 4096, 'Chord chart', '2025-04-01T09:05:00.000Z', 'sf1.preview.pdf');
INSERT INTO subject_files VALUES ('sf2', 'user-a', 's1', 'scales.txt', 'sf2.txt', 'text/plain', 100, 'C major', '2025-04-01T09:06:00.000Z', NULL);
INSERT INTO subject_topics VALUES ('st1', 'user-a', 's1', 'topic', 0, 'Open chords', 'sf1', 0, '2025-04-01T09:07:00.000Z', '2025-04-01T09:07:00.000Z', 3);

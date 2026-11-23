'use strict';
/* Workspace migration 2: the Learning System tables (LS-005, ADR-004, spec §6.2).

   Purely additive: CREATE TABLE and CREATE INDEX only. No existing (version-1) table, index or column is changed.
   It runs inside the migration runner's transaction (src/db-migrate.js), so it is applied completely or not at all.
   Plain CREATE (no IF NOT EXISTS) on purpose: a name clash is a bug and must fail the step, not be skipped.

   Conventions (same as version 1): ids are TEXT (randomUUID), timestamps are ISO-8601 TEXT, booleans are 0/1
   INTEGERs, JSON columns are TEXT. JSON is validated by the pure modules before writing (spec §6.2 notes); the
   json_valid CHECKs here are only a last guard against a non-JSON string. Every table carries user_id; ownership
   is checked in the store, not by these constraints.

   Deletes (spec §6.2 notes): deleting a subject cascades to everything learning-related; deleting a topic sets
   topic_id NULL on questions, assessment items, sessions and materials (history kept) and removes it from
   journey scopes. Indexes on foreign-key child columns keep those cascades from scanning whole tables. */

// Journey stages = spec §2.2 stages 3–15, in order. Stages 0–2 are pages before a journey exists and 16
// (next cycle) creates a new journey, so neither is a stored stage.
const JOURNEY_STAGES = Object.freeze([
  'material', 'pretest_setup', 'pretest', 'diagnostic', 'targeted_notes', 'main_learning', 'practice',
  'mistake_analysis', 'supplementary', 'final_learning', 'final_exam', 'report', 'retention'
]);

const list = values => values.map(value => `'${value}'`).join(',');
const json = column => `CHECK(json_valid(${column}))`;
const stamps = 'created_at TEXT NOT NULL, updated_at TEXT NOT NULL';

function learningSchemaV2(db) {
  db.exec(`
    CREATE TABLE learning_journeys (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'material' CHECK(stage IN (${list(JOURNEY_STAGES)})),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','archived')),
      cycle INTEGER NOT NULL DEFAULT 1 CHECK(cycle >= 1),
      parent_journey_id TEXT REFERENCES learning_journeys(id) ON DELETE SET NULL,
      target_date TEXT, completed_at TEXT, ${stamps}
    );
    CREATE INDEX learning_journeys_subject ON learning_journeys(user_id, subject_id);
    CREATE INDEX learning_journeys_parent ON learning_journeys(parent_journey_id);

    CREATE TABLE journey_topics (
      journey_id TEXT NOT NULL REFERENCES learning_journeys(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES subject_topics(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, ${stamps},
      PRIMARY KEY (journey_id, topic_id)
    );
    CREATE INDEX journey_topics_topic ON journey_topics(topic_id);

    CREATE TABLE question_items (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      topic_id TEXT REFERENCES subject_topics(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK(type IN ('choice','truefalse','matching','essay','explain')),
      dimension TEXT NOT NULL CHECK(dimension IN ('recognition','recall','understanding','application')),
      difficulty INTEGER NOT NULL DEFAULT 2 CHECK(difficulty IN (1,2,3)),
      points REAL NOT NULL CHECK(points > 0),
      prompt TEXT NOT NULL,
      payload TEXT NOT NULL ${json('payload')},
      explanation TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '[]' ${json('source')},
      origin TEXT NOT NULL CHECK(origin IN ('manual','template','generated')),
      provenance TEXT CHECK(provenance IS NULL OR json_valid(provenance)),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
      review TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review IN ('approved','unreviewed','rejected')),
      reviewed_at TEXT, ${stamps}
    );
    CREATE INDEX question_items_subject ON question_items(user_id, subject_id);
    CREATE INDEX question_items_topic ON question_items(topic_id);

    CREATE TABLE assessments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      journey_id TEXT REFERENCES learning_journeys(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('diagnostic','practice','final','retention')),
      title TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}' ${json('config')},
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_progress','submitted','graded','abandoned')),
      attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
      retake_of TEXT REFERENCES assessments(id) ON DELETE SET NULL,
      started_at TEXT, submitted_at TEXT, graded_at TEXT, ${stamps}
    );
    CREATE INDEX assessments_subject ON assessments(user_id, subject_id);
    CREATE INDEX assessments_journey ON assessments(journey_id);
    CREATE INDEX assessments_retake ON assessments(retake_of);

    CREATE TABLE assessment_items (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      question_id TEXT REFERENCES question_items(id) ON DELETE SET NULL,
      position INTEGER NOT NULL CHECK(position >= 0),
      topic_id TEXT REFERENCES subject_topics(id) ON DELETE SET NULL,
      dimension TEXT NOT NULL CHECK(dimension IN ('recognition','recall','understanding','application')),
      max_score REAL NOT NULL CHECK(max_score > 0),
      question_snapshot TEXT NOT NULL ${json('question_snapshot')},
      ${stamps},
      UNIQUE (assessment_id, position)
    );
    CREATE INDEX assessment_items_topic ON assessment_items(user_id, topic_id);
    CREATE INDEX assessment_items_question ON assessment_items(question_id);
    CREATE INDEX assessment_items_topic_fk ON assessment_items(topic_id);

    CREATE TABLE assessment_answers (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      item_id TEXT NOT NULL UNIQUE REFERENCES assessment_items(id) ON DELETE CASCADE,
      response TEXT NOT NULL DEFAULT '{}' ${json('response')},
      confidence INTEGER CHECK(confidence IS NULL OR confidence IN (1,2,3)),
      dont_know INTEGER NOT NULL DEFAULT 0 CHECK(dont_know IN (0,1)),
      saved_at TEXT NOT NULL,
      score REAL CHECK(score IS NULL OR score >= 0),
      grade_status TEXT NOT NULL DEFAULT 'pending' CHECK(grade_status IN ('pending','provisional','final')),
      grader TEXT CHECK(grader IS NULL OR grader IN ('auto','ai','ai_accepted','self','manual')),
      criteria TEXT CHECK(criteria IS NULL OR json_valid(criteria)),
      feedback TEXT CHECK(feedback IS NULL OR json_valid(feedback)),
      mistake_category TEXT,
      graded_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
      ${stamps}
    );

    CREATE TABLE learning_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      journey_id TEXT REFERENCES learning_journeys(id) ON DELETE SET NULL,
      topic_id TEXT REFERENCES subject_topics(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('main','supplementary','review')),
      started_at TEXT NOT NULL, ended_at TEXT,
      focus_entry_id TEXT REFERENCES focus_entries(id) ON DELETE SET NULL,
      summary TEXT NOT NULL DEFAULT '',
      visited TEXT NOT NULL DEFAULT '{"sections":[],"materials":[]}' ${json('visited')},
      ${stamps}
    );
    CREATE INDEX learning_sessions_subject ON learning_sessions(user_id, subject_id);
    CREATE INDEX learning_sessions_journey ON learning_sessions(journey_id);
    CREATE INDEX learning_sessions_topic ON learning_sessions(topic_id);
    CREATE INDEX learning_sessions_focus ON learning_sessions(focus_entry_id);

    CREATE TABLE learning_materials (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      journey_id TEXT REFERENCES learning_journeys(id) ON DELETE SET NULL,
      topic_id TEXT REFERENCES subject_topics(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES learning_sessions(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('targeted_note','side_note','side_note_ai','supplementary')),
      parent_material_id TEXT REFERENCES learning_materials(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      body_file TEXT,
      source TEXT NOT NULL DEFAULT '[]' ${json('source')},
      origin TEXT NOT NULL DEFAULT 'manual',
      provenance TEXT CHECK(provenance IS NULL OR json_valid(provenance)),
      ${stamps},
      CHECK(kind <> 'side_note_ai' OR parent_material_id IS NOT NULL)
    );
    CREATE INDEX learning_materials_subject ON learning_materials(user_id, subject_id);
    CREATE INDEX learning_materials_journey ON learning_materials(journey_id);
    CREATE INDEX learning_materials_topic ON learning_materials(topic_id);
    CREATE INDEX learning_materials_session ON learning_materials(session_id);
    CREATE INDEX learning_materials_parent ON learning_materials(parent_material_id);

    CREATE TABLE learning_schedule (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
      journey_id TEXT NOT NULL REFERENCES learning_journeys(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('session','practice','retention','final')),
      topic_ids TEXT NOT NULL DEFAULT '[]' ${json('topic_ids')},
      ${stamps}
    );
    CREATE INDEX learning_schedule_journey ON learning_schedule(journey_id);

    CREATE TABLE question_review (
      user_id TEXT NOT NULL,
      question_id TEXT NOT NULL REFERENCES question_items(id) ON DELETE CASCADE,
      box INTEGER NOT NULL DEFAULT 1 CHECK(box BETWEEN 1 AND 5),
      due_on TEXT NOT NULL,
      last_result TEXT,
      ${stamps},
      PRIMARY KEY (user_id, question_id)
    );
    CREATE INDEX question_review_due ON question_review(user_id, due_on);
    CREATE INDEX question_review_question ON question_review(question_id);
  `);
}

const LEARNING_TABLES = Object.freeze([
  'learning_journeys', 'journey_topics', 'question_items', 'assessments', 'assessment_items',
  'assessment_answers', 'learning_sessions', 'learning_materials', 'learning_schedule', 'question_review'
]);

module.exports = { learningSchemaV2, JOURNEY_STAGES, LEARNING_TABLES };

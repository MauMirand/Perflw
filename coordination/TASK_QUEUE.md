# Perflow — Task Queue

**Last Updated:** 2026-11-23  
**Task Manager:** Claude A  
**Implementation Agent:** Claude B

---

## 1. Task Status Definitions

| Status | Meaning |
|---|---|
| BACKLOG | Identified but not scheduled |
| READY | Requirements defined and ready for assignment |
| ASSIGNED | Ownership established |
| IN PROGRESS | Implementation underway |
| BLOCKED | Cannot proceed without intervention |
| REVIEW | Awaiting technical review |
| REVISION | Changes requested by reviewer |
| APPROVED | Review completed successfully |
| INTEGRATED | Merged into the main development branch |
| CANCELLED | No longer required |

Only use INTEGRATED when the changes have actually been merged.

---

## 2. Priority Definitions

| Priority | Meaning |
|---|---|
| P0 — Critical | Prevents development or compromises essential functionality |
| P1 — High | Important to the current milestone |
| P2 — Medium | Valuable improvement |
| P3 — Low | Optional enhancement |

---

## 3. Active Tasks

| ID | Task | Priority | Owner | Status |
|---|---|---|---|---|
| PF-001 | Inspect and document existing architecture | P1 | Claude A | REVIEW (owner): `ARCHITECTURE_DECISIONS.md` §3 |
| PF-002 | Audit existing application functionality | P1 | Claude A | REVIEW (owner): `PROJECT_STATUS.md` §2 |
| PF-003 | Identify technical debt and risks | P2 | Claude A | REVIEW (owner): `PROJECT_STATUS.md` §5–6 |

---

## 4. Backlog

Recommended order from the 2026-11-23 audit (Claude A). The owner sets the final priority. Risk IDs (R#)
refer to `PROJECT_STATUS.md` §6.

| ID | Task | Priority | Status | Depends on | Notes |
|---|---|---|---|---|---|
| PF-004 | Fix the failing Electron E2E smoke test (Learning PDF stage) | P0 | **INTEGRATED** (`dfd1fbd`, 2026-11-23) | — | R2. Commits `3b8f738`, `f2006fa` on `fix/PF-004-smoke-pdf`. Independently re-verified: `npm test` 126 pass/0 fail/2 todo; smoke 3/3. Follow-ups: PF-007, PF-020. |
| PF-005 | Upgrade Electron off EOL 38.x to a supported major | P0 | BACKLOG | PF-004; ADR-001 approval | R1, R5 |
| PF-006 | Versioned, transactional schema migrations with a backup | P1 | **INTEGRATED** (`350520c`, 2026-11-23; pushed with `61e5c14`): `84741f0`, APPROVED in HO-013 | ADR-002 ✔ (D1); PF-004 INTEGRATED; PF-007 APPROVED + merged | R3; **gate G1 for all learning tables**. Touches `workspace.js`/`auth.js`; no other DB work in parallel. Full spec below. |
| PF-007 | Safe user-data file I/O on Windows (atomic write with retry; reads that never turn "busy" into "empty") | **P0** (raised 2026-11-23) | **INTEGRATED** (`5664f56`, 2026-11-23; `--no-ff`, not pushed): `8475dcb` + `b545f18`, APPROVED in HO-010 | ADR-003 ✔ ACCEPTED; PF-004 INTEGRATED | R4 + data loss reproduced in PF-004. Full spec below. No file overlap with PF-006 |
| PF-020 | Replace fixed waits in smoke steps with condition waits; root-cause the Home card-drag flake (`electron-smoke.js:1031` after PF-004, ~1 in 11 runs), the side-panel collapse flake (`:620`) and the sidebar group collapse flake (`:949`, after `sleep(250)`) | **P1, before LS-008** | **ASSIGNED** (lane 1, 2026-11-23; submission HO-014). Full brief: "TASK: PF-020" | PF-004 INTEGRATED | From HO-004 §8.2 and HO-008: Claude A saw 2 fixed-wait failures in 6 runs on the PF-007 branch. Gate G2 needs a trustworthy smoke run |
| PF-021 | Startup: show a plain-language dialog when the workspace or accounts database cannot be backed up or migrated, then quit (today `createWorkspace`/`createAuth` throw uncaught in `main.js:217-218`) | **P1, required before the first release (packaged build)** | READY (queued; starts when a lane is free). Full brief: "TASK: PF-021" | PF-006 INTEGRATED ✔ | From HO-012 §7.2, decided in HO-013. `src/main.js` only; test by injecting a failing migration list |
| PF-008 | `npm run verify` and Windows CI (GitHub Actions) | P1 | BACKLOG | PF-004; owner OK for Actions | R6 |
| PF-009 | Owner decision: build expense tracking or remove the unused finance and ledger tables | P1 | BACKLOG | owner | R9; needs a decision, not code |
| PF-010 | IPC contract test (channels in `preload.js` ↔ `handle()` in `main.js`) | P2 | BACKLOG | — | Cheap guard for about 120 channels |
| PF-011 | Unit tests for main-side stores (`automation/store`, `packages`, `connections`, `sessions`) | P2 | BACKLOG | — | R8; first confirm which are already covered indirectly |
| PF-012 | Split `renderer.js` (120 KB) by feature, no behavior change | P2 | BACKLOG | PF-004, PF-008 | R7; the other large files follow the same pattern later |
| PF-013 | Owner decision: product name Perflow vs Perflw | P2 | BACKLOG | owner | Affects the package, data folder and repo; a rename needs a data migration |
| PF-014 | Dependency and security audit (`npm audit`, licenses, Office conversion script review) | P2 | BACKLOG | — | Items listed as "not yet investigated" in the audit |
| PF-015 | Map the core student workflows to existing features (Milestone 3 input) | P2 | BACKLOG | — | Claude A and the owner; decides what to build next |
| PF-016 | IPC hardening: `learning:cancelAsk` lacks `requireUser()` (`src/main.js:507`); `workspace:updateEvent` reads `event.imageName` before a type check (`:523`); `learning:importDroppedTopics` path handling | P2 | BACKLOG | — | From Claude B HO-002 §4.4; `:507` verified by Claude A |
| PF-017 | Raw error text reaches the UI unless it matches `/SQLITE\|EACCES\|ENOENT\|EPERM/` (`src/main.js:166`) | P2 | BACKLOG | — | From Claude B HO-002 §4.5; verified. New learning handlers must not rely on it (LS standard S6) |
| PF-018 | Reduced-motion: some media queries ignore the in-app motion setting (`styles.css:550`, `learning.css:301,452,596`) | P3 | BACKLOG | — | From Claude B HO-002 §4.7; `renderer.js:66-70` verified; CSS lines not yet checked by Claude A |
| PF-019 | Owner decision: Analytics and Activities views are not reachable from navigation (`renderer.js:1457`) | P2 | BACKLOG | owner | From Claude B HO-002 §5; blocks LS-028 |

Parallel-safe now: PF-004 alone (Claude B). After that, PF-007 and PF-010 do not overlap.

### TASK: PF-007 — Safe user-data file I/O on Windows

**Status:** INTEGRATED (`5664f56`, 2026-11-23); APPROVED in HO-010  
**Priority:** P0  
**Assigned To:** Claude B  
**Created By:** Claude A  
**Created:** 2026-11-23

#### Objective
No user data in `%APPDATA%\Perflw` is silently lost or left stuck when Windows briefly holds a file
(antivirus, search indexer, backup tools).

#### Context
PF-004 found and reproduced (todo tests in `test/learning-state-io.test.js`, re-run by Claude A 3× — both reproduce
every time): a held `state.json` makes `renameSync` throw `EPERM` and `readFileSync` throw `EBUSY`. `readJson`
(`src/learning-workflow.js:59`) returns "empty" on any error, and the next save overwrites the subject's state
(saved notes and document entries). Same pattern: preferences (`learning-workflow.js:499-510`), agent registry
(`src/learning-agents.js:279-374`, written in place at `:283`). Other writers: `src/automation/packages.js:150`,
`src/main.js:104` (session token), `src/main.js:481` (annotations, no mode).

#### Requirements
- New `src/safe-file.js` with `writeFileAtomic` and `readJsonFile` exactly as ADR-003 amendment items 1–2.
- Use them in: `learning-workflow.js` (`write`, `readJson` and every read-modify-write), `learning-agents.js`
  registry, `automation/packages.js` atomic writer, `main.js:481` annotations. `main.js:104` only if the change is
  trivial; otherwise report it.
- Read-modify-write callers do not write after a failed read (amendment item 3).
- The workflow keeps an unsaved analysis status in memory and emits it (item 4), so the panel never stays on
  "Analyzing this file…".
- Remove `todo` from both tests in `test/learning-state-io.test.js`; they must pass.

#### Relevant Files
New `src/safe-file.js`, `test/safe-file.test.js`. Changed: `src/learning-workflow.js`, `src/learning-agents.js`,
`src/automation/packages.js`, `src/main.js` (I/O lines only), `test/learning-state-io.test.js`.

#### Dependencies
PF-004 APPROVED; ADR-003 approval.

#### Restrictions
- No schema change, no new dependency, no change to file formats or locations.
- Do not touch `workspace.js`/`auth.js` (PF-006 owns them).

#### Acceptance Criteria
- [x] `safe-file` unit tests: retry then success; retry exhausted → throws and leaves no `.tmp`; `ENOENT` →
      fallback; busy read → throws, never fallback; invalid JSON → `.corrupt-*` file kept and fallback returned;
      written file mode is `0o600` where the platform reports it.
- [x] Both `learning-state-io` tests pass without `todo`.
- [x] New tests for preferences and the agent registry: a busy read does not wipe the file.
- [x] `npm test` exit 0 with 0 todo (141/141); `npm run test:electron` exit 0 (Claude A 3/3 at `b545f18`, HO-010).
- [x] Committed on `fix/PF-007-safe-file-io` (`8475dcb`, `b545f18`); HANDOFF_LOG entry (HO-007).

#### Review
**Reviewed By:** Claude A  
**Decision:** APPROVED WITH MINOR CHANGES (HO-008) → revision **APPROVED** (HO-010, 2026-11-23). Integrated in
`main` as `5664f56` (merge tree identical to `b545f18`; `npm test` on `main` 141/141 per the orchestrator session).

---

### TASK: PF-020 — Make the Electron smoke test trustworthy (condition waits, flake root causes)

**Status:** ASSIGNED (lane 1, 2026-11-23) · **Priority:** P1 (gate G2 for every LS renderer task) · **Assigned To:**
Claude B (new session) · **Submission:** HO-014 · **Created By:** Claude A

#### Objective
`npm run test:electron` passes reliably, so a failure means a real regression (gate G2).

#### Context (evidence)
- PF-004 review and HO-008/HO-010: across 9 runs on PF-007 code, 7 passed; failures were fixed-wait steps:
  "Plan group hides Calendar, the date card and Routine only" (sidebar group measured after `sleep(250)`, was
  `:949`) and the "collapsed column takes no width" side-panel step (measured after `sleep(450)`, was `:620`).
  Claude B saw a Home card-drag flake (was `:1031`, about 1 in 11 runs). Line numbers are from `main` at PF-004 and
  may have moved: find the steps by their assertion text.
- HO-010 and HO-013 runs: 3/3 and 3/3 passed, so the flakes are rare; one green run proves nothing.

#### Requirements
1. Add one helper in the smoke file, e.g. `waitFor(check, { timeout, interval, label })`, that polls a renderer
   condition and fails with the label and the last observed value.
2. Replace every fixed `sleep(...)` that precedes an assertion on layout, animation or async state with `waitFor`
   on the asserted condition. A `sleep` that only paces input (e.g. a drag sequence) may stay, with a comment.
3. For each of the 3 named flakes: state the root cause (what the step measured too early, or what raced), with the
   evidence (logged values, timings).
4. Motion: where a step waits for a CSS transition, wait for `transitionend`, or for the final computed value, not
   for a duration.

#### Restrictions
- Change `test/electron-smoke.js` only. If a root cause is in `src/` (e.g. a real race in the app), **report it in
  HO-014 with evidence and do not fix it**; Claude A turns it into a task.
- Do not weaken an assertion to make it pass (no larger tolerances, no removed checks) without stating why in HO-014.
- No new dependency. Run `npm ci` in the worktree first (CLAUDE.md §6).

#### Acceptance Criteria
- [ ] No fixed `sleep` before an assertion remains (list any kept, with the reason).
- [ ] **10 consecutive** `npm run test:electron` runs exit 0, each exit code saved right after the command; total
      time reported (before vs after, to show the condition waits did not slow the suite much).
- [ ] `npm test` exit 0 (count reported).
- [ ] Root cause stated for each named flake, or "not reproduced in N runs" with what was tried.
- [ ] Committed on the session's branch (ref and base in HO-014); HANDOFF entry HO-014.

---

### TASK: LS-005 — Migration 2: Learning System tables

**Status:** **ASSIGNED** (lane 3, 2026-11-23; G1 open: PF-006 integrated). Session started on `claude/nifty-haslett-6c96fe`; then REVIEW · **Priority:** P1 · **Assigned To:** Claude B (lane 3) ·
**Submission:** HO-018 · **Created By:** Claude A

#### Objective
Create the Learning System tables as workspace migration 2 through PF-006's runner, without changing any existing
table.

#### Context
PF-006 (`src/db-migrate.js`, `WORKSPACE_MIGRATIONS` in `src/workspace.js`) runs each migration in a transaction
after a backup. Spec §6.2 lists the tables, columns and indexes, including the owner-decision additions:
`assessments.attempt`, `assessments.retake_of` (D10), `learning_materials.parent_material_id` + kind `side_note_ai`
(D8), `learning_sessions.visited` (D13). ADR-004 (accepted): additive only.

#### Requirements
- New file `src/learning-schema.js` exporting `learningSchemaV2(db)`: `CREATE TABLE` and `CREATE INDEX` only, for
  the 10 tables of spec §6.2 (`learning_journeys`, `journey_topics`, `question_items`, `assessments`,
  `assessment_items`, `assessment_answers`, `learning_sessions`, `learning_materials`, `learning_schedule`,
  `question_review`) with their FKs, CHECKs and the listed indexes. Every table: `id TEXT PRIMARY KEY` (except the
  composite-key tables), `user_id TEXT NOT NULL`, `created_at`, `updated_at`.
- `src/workspace.js`: append `{ version: 2, up: learningSchemaV2 }` to `WORKSPACE_MIGRATIONS`; no other change.
- `learning_journeys.stage` CHECK uses exactly these keys (spec §2.2 stages 3–15):
  `material, pretest_setup, pretest, diagnostic, targeted_notes, main_learning, practice, mistake_analysis,
  supplementary, final_learning, final_exam, report, retention`. Export them as a frozen `JOURNEY_STAGES`.
- FKs reference existing tables by their current names (`subjects`, `subject_topics`, `events`, `focus_entries`);
  verify each name and key column in `workspace.js` before writing the DDL.
- Extend `test/fixtures/schema/generate.js` use: commit a `workspace-v2.json` fixture generated from the new code.

#### Restrictions
- No `ALTER`, `DROP` or rebuild of any existing table. No store, IPC or UI code (LS-006/LS-007).
- Files: `src/learning-schema.js` (new), `src/workspace.js` (migration list line only), `test/learning-schema.test.js`
  (new), `test/fixtures/schema/workspace-v2.json` (new). Report anything else first.

#### Acceptance Criteria
- [ ] Fresh install reaches `user_version` 2; schema equals the v2 fixture; v1 objects unchanged vs `workspace-v1.json`.
- [ ] Upgrade from a v1 database with rows in every existing learning-related table (`subjects`, `subject_topics`,
      `subject_files`, `events`, `focus_entries`): rows byte-identical, new tables present, one `bak-v1-*` backup.
- [ ] Injected failure inside migration 2 → stays v1, no new table, backup exists and passes `integrity_check`.
- [ ] Second start is a no-op. `PRAGMA foreign_key_check` is empty after upgrade.
- [ ] FK cascade: deleting a subject removes its journeys, questions, assessments, items, answers, sessions,
      materials; deleting a topic sets `topic_id` NULL on questions/items (spec §6.2 notes).
- [ ] CHECK tests: an unknown `stage`, `kind`, `type`, `review` or `grade_status` is rejected.
- [ ] `npm test` exit 0; `npm run test:electron` exit 0 (startup path changed); HANDOFF entry HO-018.

---

### TASK: PF-021 — Startup: a clear message when the databases cannot be opened, backed up or migrated

**Status:** READY (queued 2026-11-23; starts when a lane is free) · **Priority:** P1, **required before the first
release (packaged build)** · **Assigned To:** Claude B · **Submission:** next reserved number at release ·
**Created By:** Claude A

#### Objective
If `createAuth` or `createWorkspace` fails at startup (backup failed, a migration failed and was rolled back, the file
is not a database), the student sees one plain-language message and the app quits cleanly. Today the error is thrown
inside `app.whenReady().then(...)` (`src/main.js:217-218`) and nothing catches it *[inferred from code: an unhandled
rejection, so the app likely stays running with no window; confirm this first and record what actually happens]*.

#### Requirements
- Wrap the database start (`createAuth`, `createWorkspace`) in `main.js`. On error: no window is created; show
  `dialog.showErrorBox(title, message)` with the error's plain-language message (PF-006's runner messages already
  are), then `app.exit(1)`. Do not delete, move or rewrite any file.
- Messages that are not from the runner (e.g. "file is not a database") get a plain wrapper: what happened, that
  nothing was changed, where the data folder is, and that the newest `*.bak-*` copy can be restored (no automatic
  restore).
- Test mode (`!app.isPackaged && PERFLW_TEST_USER_DATA`): print the same message to stderr instead of the modal
  dialog (a modal blocks automated runs), then exit 1.
- Keep the message builder pure and unit-tested (new small module, e.g. `src/startup-error.js`).

#### Restrictions
`src/main.js` (startup block only), new `src/startup-error.js`, new tests. No change to `db-migrate.js`,
`workspace.js` or `auth.js`.

#### Acceptance Criteria
- [ ] Unit tests for the message builder: runner error kept as is; foreign error wrapped; data path included.
- [ ] Electron check: `PERFLW_TEST_USER_DATA` pointing at a temp folder whose `workspace.sqlite` holds garbage bytes →
      process exits with code 1, stderr has the message, the garbage file is byte-identical afterwards, no window.
- [ ] Rendered check (packaged-like run without test mode): screenshot of the dialog.
- [ ] `npm test` exit 0; `npm run test:electron` exit 0 (normal startup unchanged).

---

### TASK: PF-006 — Versioned, transactional schema migrations with a backup

**Status:** INTEGRATED (`350520c`, 2026-11-23); APPROVED in HO-013  
**Priority:** P1 (gate G1 for the Learning System)  
**Assigned To:** Claude B  
**Created By:** Claude A  
**Created:** 2026-11-23

#### Objective
Every future schema change runs as a numbered migration inside a transaction, with a backup taken first, so a
failed upgrade can never leave a half-migrated database.

#### Context
ADR-002 approved in principle by the owner (D1, 2026-11-23). Today `createWorkspace` (`src/workspace.js:12-190`) and
`src/auth.js:13-36` evolve the schema with `CREATE TABLE IF NOT EXISTS` and `PRAGMA table_info` checks. Known
defects: the `planner_items` rebuild (`workspace.js:140-154`) runs `BEGIN;…COMMIT;` in one `exec`, so a failure
leaves the transaction open; `workspace.js:190` adds two columns in one `exec` guarded only by `preview_name`
(Claude B HO-002 §4.2). `createAutomationStore(db)` and `createSessionStore(db)` (`workspace.js:192-193`) also
create tables on the same database; inspect them and include them.

#### Requirements
- A small runner (new file, e.g. `src/db-migrate.js`): `migrate(db, { name, migrations, backup })` where
  `migrations` is an ordered list of `{ version, up(db) }`. It reads `PRAGMA user_version`, and for each pending
  migration runs `BEGIN IMMEDIATE`, `up`, sets `user_version`, `COMMIT`; on any error `ROLLBACK` and rethrow with
  a plain-language message.
- **Version 1 = today's schema exactly**: the existing bootstrap code becomes migration 1, unchanged in effect and
  idempotent, so existing installs (with any subset of the old columns) reach v1 without data change. Fix the two
  defects above inside it (rebuild in the runner's transaction; each `ALTER` guarded separately).
- **Backup** before the first pending migration when the DB already has user tables: a consistent copy next to the
  DB (`workspace.sqlite.bak-v<from>-<timestamp>`), e.g. via `VACUUM INTO` (verify it works under `node:sqlite` in a
  test before relying on it); keep the newest 3 backups; never delete the live file.
- Same runner for `accounts.sqlite` (`auth.js`), with its own migration list.
- No learning tables in this task. Migration 2 belongs to LS-005.

#### Relevant Files
`src/workspace.js`, `src/auth.js`, `src/automation/store.js`, `src/automation/sessions.js` (read; change only if their
DDL must move into migration 1), new `src/db-migrate.js`, new `test/db-migrate.test.js`, fixtures under
`test/fixtures/`.

#### Dependencies
PF-004 INTEGRATED (`dfd1fbd`), PF-007 APPROVED and merged (branch PF-006 from that `main`), ADR-002 ✔ (in principle, D1).
Assignment: HO-009.

#### Restrictions
- No change to any table's shape beyond the two defect fixes. No new dependency. No change to app behavior visible
  to users.
- Do not run in parallel with any other task touching `workspace.js` or `auth.js`.

#### Acceptance Criteria
- [x] Fresh install → `user_version` 1 for both DBs; schema identical to today's (compare `sqlite_master` SQL with a
      fixture generated from `main` before the change).
- [x] Old-install fixtures (at least: before `planner_items` included `'learning'`; before `subject_files.preview_name`;
      with `preview_name` but without `preview_status`) → reach v1 with all rows preserved and both columns present.
- [x] Injected failure in a test migration 2 → DB stays at v1, no open transaction, backup file exists and opens.
- [x] Running startup twice is a no-op (no backup, no changes).
- [x] Backups pruned to the newest 3.
- [x] `npm test` exit 0 (126 + new); `npm run test:electron` exit 0 (S5-style capture).
- [x] Committed on `refactor/PF-006-migrations`; HANDOFF_LOG entry; `docs/ARCHITECTURE.md` §2 updated.

#### Deliverables
Summary, files, test outputs with exit codes, commit hash, the list of tables/columns in v1, known limits.

#### Review
**Reviewed By:** Claude A  
**Decision:** **APPROVED** (HO-013, 2026-11-23), `84741f0` on `claude/pf-006-migrations-3b8b79` (generated branch name accepted). Integrated as `350520c` (src/test identical to `84741f0`; `npm test` 154/154 on the merge per the orchestrator).

---

### Learning System (LS) — spec `docs/LEARNING_SYSTEM_SPEC.md`

**Owner decisions 2026-11-23:** D1–D5 approved in principle (see spec §9). ADR-004, ADR-005 and ADR-008
ACCEPTED (2026-11-23). Open product questions on the learning loop: HO-011 (they do not block LS-002 to LS-004).

**Branch names:** desktop sessions may create their own branch name (e.g. `claude/<name>-<id>`). That is
acceptable; the HANDOFF entry must state the exact ref and the base commit.

**Assignment rule (owner, 2026-11-23, revised the same day):** ~~one task at a time~~ → **up to 3 Claude B sessions
in parallel** (owner: "we need it built and working asap"; chose "Yes, up to 3 parallel"), each in its own worktree,
on tasks with **no file overlap**. Every task is still reviewed by Claude A before it merges, tests must pass, and
G1/G2 stay in force. A task starts only when the tasks it depends on are APPROVED (G3 below).

Lanes (2026-11-23):
1. PF-020 (smoke flakes; G2 for every renderer task). Files: `test/electron-smoke.js` only.
2. LS-002, then LS-003 and LS-004 in parallel (separate new files; G3 for LS-002 waived by the owner: pure module,
   no PF-006 file).
3. LS-005 after PF-006 is merged, then LS-006, then LS-007.
Overlap check before each release: no two running tasks list the same file, except `coordination/HANDOFF_LOG.md`
(see HO numbers) and `package.json` (none of the current tasks may change it).

**HO numbers in parallel work:** Claude A reserves the submission entry's number at release, so parallel sessions
never pick the same one: HO-014 PF-020, HO-015 LS-002, HO-016 LS-003, HO-017 LS-004, HO-018 LS-005. Claude A's own
entries take the next unreserved number. Each session appends only its own entry at the end of section 4;
merge conflicts in `HANDOFF_LOG.md` are resolved by keeping both sides in number order.

**Gates that must stay intact:**
- **G1 — Migration gate (D1):** no learning table, column or index is created before PF-006 is APPROVED and
  merged. LS-005 is the only task that creates learning tables.
- **G2 — UI regression gate:** no LS task that changes the renderer merges before PF-004 is APPROVED and merged.
- **G3 — Review gate (revised for parallel lanes):** every task is reviewed by Claude A against its acceptance
  criteria before it merges and before any task that **depends on it** starts. Earlier wording, kept for the record:
  every task is reviewed by Claude A against its acceptance criteria before the next is
  assigned; only the owner merges.

**Standard acceptance (applies to every LS task in addition to its own criteria):**
- S1 `npm test` exits 0, captured as `npm test > log 2>&1; echo EXIT=$?`; test count reported.
- S2 No new dependency; no edit outside the task's listed files without reporting it in the handoff.
- S3 New functions and IPC channels take one object argument (ADR-005); new modules ≤ ~600 lines.
- S4 Diff inspected; committed on `feature/LS-0xx-<name>` from `main`; HANDOFF_LOG entry with commit hash, test
  output and known limits.
- S5 (renderer tasks only) G2 satisfied; `npm run test:electron` exits 0 with the task's new smoke step; screenshots
  at 1280 px and 400 px width; keyboard-only path works; motion respects `reduceMotion()` (`renderer.js:66`).
- S6 (main-process handlers only) `requireUser()` and ownership checks on every id; errors are plain-language
  (they reach the UI unchanged unless they match `main.js:166`'s filter).
- S7 (renderer tasks only, owner decision D12) **UI parity**: the new screen reuses existing tokens, components,
  layouts and motion from `styles.css`/`learning.css` (no new visual language or token set; any new CSS rule is
  named in the handoff). Screenshots at 1280 px and 400 px placed **side by side with the existing Learning pages**
  (subject page and topic viewer) in the handoff; Claude A compares them in review.

**Owner decisions D6–D17 (2026-11-23)** are in spec §9 and §9.1 (no open follow-ups; ADR-007 ACCEPTED). They change LS-005, LS-006,
LS-008, LS-012, LS-013, LS-022 to LS-024 and add LS-031 to LS-033. LS-002 to LS-004 are unchanged.

#### Phase 1 — Engine core (pure modules, no schema, no UI)

**LS-001 · Owner approval of spec and decisions** — Owner · Depends: — · Status: **DONE** (2026-11-23). D1–D5
APPROVED in principle; ADR-004/005/008 ACCEPTED by the owner (relayed by the desktop orchestrator session).
Open product questions on the owner's learning-loop diagram are tracked in HO-011; they refine the spec but do not
block LS-002.
- [x] D1–D5 recorded in spec §9 and ADRs.
- [x] Owner confirms ADR-004, ADR-005, ADR-008.

**LS-002 · `src/assessment-model.js`** — P1 · Depends: LS-001 (ADR-005 confirmed). Full spec below.

**LS-003 · `src/mastery-model.js`** — P1 · Depends: LS-002 (APPROVED). Submission HO-016.
- Brief: pure module, same dual-load pattern as `topic-model.js`/`assessment-model.js`; new files
  `src/mastery-model.js`, `test/mastery-model.test.js` only; reads spec §5.1, §5.4 (incl. the D11 one-cycle scope:
  the caller passes one journey's evidence, the module never filters by journey itself) and §4.4 grader weights.
  No I/O, no DOM, no dependency. Standard acceptance S1–S4. Branch from `main` after LS-002 is merged.
- [ ] Exports `DEFAULT_MASTERY_CONFIG` (frozen, with `version`) and pure functions `itemWeight`, `dimensionScores`,
      `topicLevel`, `improvement`, each taking `(evidence, config = DEFAULT_MASTERY_CONFIG)` (D4: configurable).
- [ ] `validateMasteryConfig(config)` rejects out-of-range or inconsistent thresholds (e.g. Proficient < Developing).
- [ ] Tests at each threshold boundary in spec §5.4 (just below / at / above); recognition-only cap; low-confidence
      AI exclusion; guess weight; recency half-life; worked example = 0.78 ± 0.005; a custom config changes the
      outcome as expected.
- [ ] Results include `configVersion`.

**LS-004 · `src/learning-insight.js`** — P1 · Depends: LS-002 (APPROVED). Submission HO-017. Runs **in parallel
with LS-003** (the earlier "not alongside" was the one-task rule; the files do not overlap).
- Brief: pure module, same pattern; new files `src/learning-insight.js`, `test/learning-insight.test.js` only;
  reads spec §5.2, §5.3 and §4.3 categories. It must not import `mastery-model.js` (LS-003 runs at the same time);
  where a rule needs a topic level, take it as an input. No I/O, no DOM, no dependency. S1–S4.
- [ ] `categorize(answer, context)` implements every rule in spec §5.2, one test per category plus precedence
      (e.g. dontKnow beats misconception).
- [ ] `rankWeakTopics(results)` per spec §5.3, tie-break by topic position; tested.
- [ ] `nextReview(box, correct, today)` Leitner 1→5 with due offsets 1/3/7/14/30 days, wrong → box 1; tested.
- [ ] `targetedNote({ topic, analysisSection, missed })` returns Markdown with the section description, key points,
      cited excerpts and mistakes; output escapes Markdown control characters from user text; snapshot test.

#### Milestone M-L1 — Offline walking skeleton (D5)

**LS-005 · Migration 2: learning tables** — P1 · Depends: PF-006 (APPROVED + merged, G1), LS-001 (ADR-004 ✔). Full
brief: "TASK: LS-005". Submission HO-018.
- [ ] Adds exactly the tables and indexes in spec §6.2 as migration 2 through PF-006's runner; no `ALTER`/`DROP` of
      any existing table.
- [ ] Upgrade test: a v1 fixture DB with rows in every existing learning table → migrate → new tables exist, old
      rows byte-identical, `user_version` = 2; a second run is a no-op; a fresh install reaches v2.
- [ ] Failure test: an injected error inside migration 2 rolls back to v1 and leaves the backup file in place.
- [ ] FK cascade test: deleting a subject removes its journeys, questions, assessments, answers.
- [ ] Includes the D8/D10 columns from spec §6.2: `assessments.attempt`, `assessments.retake_of`,
      `learning_materials.parent_material_id`, kind `side_note_ai`, `learning_sessions.visited` (D13) (all inside
      migration 2, still additive).

**LS-006 · `src/learning-store.js`** — P1 · Depends: LS-005, LS-002 (both APPROVED).
- [ ] CRUD for journeys (+topics), questions, assessments, items (with immutable `question_snapshot`), answers,
      sessions, materials; all SQL in this file.
- [ ] Every function takes `(userId, {…})` and checks ownership down to the subject; cross-account access test
      returns "not found" for every entity.
- [ ] Writing an answer to a `submitted`/`graded` assessment is rejected (test).
- [ ] Editing or retiring a question does not change an existing snapshot (test).
- [ ] Questions are validated with `validateQuestion` before insert; JSON size caps from spec §6.2 enforced (test).
- [ ] Mastery evidence query is scoped to one journey (D11 soft reset, spec §5.4): answers of an earlier cycle are
      not returned for the current cycle, and nothing is deleted when a new cycle starts (test).

**LS-007 · IPC + preload for journeys, questions, assessments, mastery** — P1 · Depends: LS-006 (APPROVED).
- [ ] Channels from spec §6.3 for those four areas only, each through `handle()` with `requireUser()`; one object
      argument; new preload bridge `learningData` methods (no new bridge object).
- [ ] Contract test: every new preload method has a matching `handle()` channel and vice versa.
- [ ] Test: `assessment:get` for an in-progress diagnostic/final returns no `correct`, `pairs`, `modelAnswer` or
      rubric keywords anywhere in the payload (deep scan).
- [ ] Test: renderer input with wrong types or oversize strings is rejected with a plain-language error.

**LS-008 · Journey hub in the subject page (`src/learning-journey.js`)** — P1 · Depends: LS-007 (APPROVED), G2.
- [ ] Replaces the subject page placeholder blocks (`learning.js:156-160`) with: create journey (title, topic scope,
      optional target date), stage stepper, next-action card, journey list; `learning.js` change limited to mounting.
- [ ] Reuses renderer helpers (`esc`, `toast`, `confirmDialog`, `announce`) through `init(H)`; no new copies.
- [ ] Empty states from spec §3.6 for "no topics" and "no source text".
- [ ] Stepper unlocks stages one at a time (D7): done / current / locked; a locked stage is visible but not
      startable; notes, files and Ask stay available at every stage.
- [ ] Smoke step: create a journey on the fixture subject and see stage "Pre-test" (S5).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-009 · Question bank (`src/learning-bank.js`)** — P1 · Depends: LS-007 (APPROVED), G2. Not in parallel with LS-008.
- [ ] List per subject filtered by topic/type/review state; editor for choice, true/false, matching, explain.
- [ ] Field errors come from `validateQuestion` and are shown next to the field.
- [ ] Retire instead of delete when a question has been used in an assessment.
- [ ] Smoke step: create one question of each of the four types (S5).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-010 · Quiz panel (`src/learning-quiz.js`, `learning-quiz.css`)** — P1 · Depends: LS-008, LS-009 (APPROVED).
- [ ] Diagnostic/final mode for choice, true/false, matching, explain per spec §3.3–3.5; "I don't know"; confidence.
- [ ] Autosave (600 ms debounce) with "Saved"/"Not saved — Retry"; cannot submit while a save is pending/failed.
- [ ] Leave and resume restores answers and position; submit shows unanswered count first.
- [ ] Explain answers self-graded with the rubric checklist after submit (no AI in M-L1).
- [ ] Keyboard handlers attached to the quiz root, not `document` capture (avoids the conflicts in Claude B HO-002 §4.6).
- [ ] Smoke step: 4-question pre-test, leave mid-way, resume, submit, self-grade (S5).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-011 · Results page** — P1 · Depends: LS-003, LS-004, LS-010 (APPROVED).
- [ ] Score line, topic table with level chips and evidence counts, dimension bars with item counts, review answers.
- [ ] A fixture assessment's displayed values equal `mastery-model`/`learning-insight` outputs (unit test of the view
      model + smoke screenshot).
- [ ] "Not assessed" shown instead of a number when evidence is insufficient.
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-012 · Study session (`src/learning-session.js`)** — P1 · Depends: LS-007 (APPROVED), ADR-008 confirmed, G2.
- [ ] `study:start`/`study:end`/`study:sideNote` handlers; start uses the existing active timer with
      `source:'learning'`; end saves one focus entry via `saveFocusEntry` and links it.
- [ ] Refuses to start when another timer runs (plain message offering to stop it).
- [ ] App quit with a running session closes it at the last activity time (test with injected clock).
- [ ] Side notes stored as `learning_materials` kind `side_note`; the body is only the student's text (D8); they
      are listed separately from targeted notes and from PDF annotations.
- [ ] The session records `visited` (sections opened in the viewer, materials opened) for the D13 retake check
      (test: opening a section and a note while a session runs appends both, once each).
- [ ] Smoke step: start session, add side note, end; calendar/timer shows the entry (S5).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**M-L1 exit** (Claude A review, not a task): one smoke run walks journey → pre-test → results → session → final
(same quiz mode, different items) → results, with no AI provider configured.

#### Phase 2 — Quiz completeness

**LS-013 · Practice mode (the Quest concept, D6)** — P2 · Depends: LS-011 (APPROVED).
- [ ] Student-facing label stays **"Practice"** (D17); "Quest" is not shown in the UI; code keeps kind `practice`.
- [ ] Check → immediate feedback with explanation and source link; one retry for deterministic types scored ×0.5.
- [ ] Practice answers recorded as kind `practice` (weight 0.5 in mastery; test).
- [ ] Smoke step: answer wrong, see feedback, retry.
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-014 · Essay type, full keyboard map, accessibility, narrow layout** — P2 · Depends: LS-013 (APPROVED).
- [ ] Essay editor with word range and rubric self-grade.
- [ ] All shortcuts in spec §3.3 work and never fire while typing in a text field (test).
- [ ] `design:accessibility-review` run on the quiz; every High finding fixed or justified.
- [ ] Matching usable without drag at 400 px (screenshot).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

#### Phase 3 — Diagnosis, notes and AI

**LS-015 · Template questions** — P2 · Depends: LS-002 (APPROVED), LS-009 (APPROVED).
- [ ] `templateQuestions(analysis, topics)` (pure) per spec §4.8.2; every output passes `validateQuestion` and cites
      its section; deterministic for fixture files (snapshot).
- [ ] Bank shows templates as drafts the student can accept/edit; origin `template`.

**LS-016 · Diagnostic report + deterministic targeted notes** — P2 · Depends: LS-004, LS-011, PF-007 (APPROVED; notes are files written with `writeFileAtomic`).
- [ ] Weak topics ranked on the results page; "Generate targeted notes" writes one Markdown material per weak topic
      (atomic write) and opens it in the viewer's Notes view.
- [ ] Works with no provider configured (smoke step with AI disabled).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-017 · Question Writer agent and generation job** — P2 · Depends: LS-015 (APPROVED), ADR-007 ✔ (ACCEPTED 2026-11-23).
- [ ] Agent + skill created via the `learning-agents.js` pattern; `learning-coach.js` job via `ecosystem.runAgent`,
      cancellable, one at a time.
- [ ] Output rejected unless it passes `validateQuestion` and cites a source chunk present in the prompt (unit tests
      with a fake `runAgent`: invalid JSON, missing citation, invented citation, valid).
- [ ] Provenance stored on every saved question.
- [ ] **D3:** generated questions saved with `review:'unreviewed'`; usable in practice; `selectItems` excludes them
      from diagnostic/final until a person approves them (test); bank shows a review queue with Approve / Edit /
      Reject.
- [ ] AI-unavailable state shows the `runAgent` error and the offline alternatives (spec §3.6).

**LS-018 · AI answer grading (provisional)** — P2 · Depends: LS-017 (APPROVED).
- [ ] Grader returns per-criterion verdicts; score computed by `scoreFromCriteria` (test that a model-supplied number
      is ignored).
- [ ] Status `provisional`; Accept → `final` (`ai_accepted`); Adjust → `final` (`manual`), original verdict kept.
- [ ] Low-confidence grades excluded from mastery until accepted (test through `mastery-model`).
- [ ] Failure leaves the answer `pending` with "Grade later" and self-grade offered.

**LS-019 · AI explanation in targeted notes** — P3 · Depends: LS-016, LS-017 (APPROVED).
- [ ] Explanation constrained to the note's cited excerpts; labelled with the model; omitted cleanly with AI off.
- [ ] Unit test with fake `runAgent` covering success, NOT_IN_FILE-style refusal, and error.

**LS-032 · Side-note AI help (D8)** — P3 · Depends: LS-012, LS-017 (APPROVED); ADR-007 ✔ (ACCEPTED 2026-11-23).
- [ ] "Check my note" runs a `learning-coach.js` job via `ecosystem.runAgent`; output = suggestions (gaps, unclear
      points, short explanation) grounded on the note and its cited pages.
- [ ] Stored as a `side_note_ai` material linked by `parent_material_id`, with provenance; **never** written into
      the student's note (test: note body byte-identical after a run).
- [ ] Labelled "AI · suggestion"; AI-off state hides the button and leaves side notes fully usable. Unit tests with
      a fake `runAgent` (success, invalid output, error).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

#### Phase 4 — Practice journey

**LS-020 · Review queue (Leitner)** — P2 · Depends: LS-004, LS-013 (APPROVED).
- [ ] Practice results update `question_review`; "N reviews due" per subject; due offsets per LS-004 (test).

**LS-021 · Mistake analysis view + supplementary loop** — P2 · Depends: LS-016, LS-020 (APPROVED).
- [ ] Mistakes grouped by category and topic; "Practice these" starts a practice set of exactly those items;
      supplementary session/notes for still-weak topics. Smoke step.
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-022 · Journey history** — P3 · Depends: LS-011 (APPROVED).
- [ ] Per journey and per topic: every assessment with date, kind, score and level at that time; abandoned
      assessments shown but marked excluded. View-model unit test with a 3-assessment fixture.
- [ ] Earlier cycles of the same topics shown as history next to the current cycle (D11); a 2-cycle fixture test.
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

#### Phase 5 — Final exam and mastery

**LS-023 · Final exam with parallel items (D10)** — P2 · Depends: LS-010, LS-017, LS-033 (APPROVED).
- [ ] Final selection excludes every item used in the journey's diagnostics and unreviewed AI items (test).
- [ ] When too few items exist, the setup sheet says how many are missing per topic and offers bank/template/AI.
- [ ] Item count 50–100 chosen by the student (validated; spec §4.9). Enforced from this task on (D15).
- [ ] Pure `DEFAULT_EXAM_CONFIG` (frozen, versioned) + `examTimeLimit(items, config)` and `passMark(items, config)`
      per spec §4.9, with boundary tests (d̄ = 1 / 2 / 3 → 75 / 82.5 / 90%; the 50-item example → 50 min).
- [ ] Timer with 5- and 1-minute warnings; time-out submits saved answers (test with an injected clock).
- [ ] Result shows passed / not passed against the stored pass mark.
- [ ] Retake: a new attempt (`attempt` + 1, `retake_of`) is allowed only when `assessment:retakeStatus` reports the
      review complete (D13: every section of each failed topic's files opened in a `review` session after the
      failed attempt, plus its targeted notes, read from `learning_sessions.visited`); earlier attempts are never
      changed (test, incl. one missing section → retake refused, with the missing items listed).
- [ ] Before starting: time ×1, ×1.5, ×2 or untimed (D16); stored in `config`; the attempt is labelled in results.
- [ ] Unlocks only after Final learning (LS-033) is done (D9).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-024 · Mastery report, retention check, next cycle** — P2 · Depends: LS-003, LS-023 (APPROVED).
- [ ] Pre vs final per topic and dimension with evidence counts; improvement only when both sides have ≥ 2 items.
- [ ] Report is marked "provisional" while any counted open answer is not `final`.
- [ ] Retention check can be scheduled ≥ 7 days after the final; selection per spec §4.1 (test).
- [ ] Every final attempt compared side by side: score, pass mark, time used, per-topic and per-dimension change (D10).
- [ ] "Next cycle" is optional (D11): declining leaves the journey completed with its stats unchanged; accepting
      creates a journey with `parent_journey_id`, topics pre-filled with those below Mastered and freely editable,
      and the new cycle's stats start at 0 while the old cycle stays in history (test: no rows deleted).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-025 · Replace manual subject mastery/time (D2)** — P2 · Depends: LS-024 (APPROVED).
- [ ] Edit panel no longer edits mastery % or time; columns untouched (no migration).
- [ ] Subject card/page show the computed summary ("n of m topics Proficient+", study time from learning focus
      entries).
- [ ] The old manual value stays visible read-only as "Earlier self-estimate (entered manually)" until the subject
      has evidence, and is never used in calculations (test).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-033 · Final learning evaluation (D9)** — P2 · Depends: LS-003, LS-004, LS-011, LS-012 (APPROVED).
- [ ] `journey:evaluation {journeyId}` returns the spec §5.6 report for the current cycle, computed (no new table);
      view-model unit test on a fixture journey; values equal `mastery-model`/`learning-insight` outputs.
- [ ] Stage 12 is required: the final exam unlocks after the evaluation was viewed and a `review` session ended.
- [ ] Topics below Developing are flagged, not blocked. Smoke step (S5).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

#### Phase 6 — Integration

**LS-026 · Calendar scheduling** — P2 · Depends: LS-024 (APPROVED), ADR-008 confirmed.
- [ ] `schedule:create` creates the event and link in one transaction (rollback test); clicking the event offers
      Start; deleting the event deletes only the link. Smoke step.
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-027 · Home Learn card** — P3 · Depends: LS-020, LS-026 (APPROVED).
- [ ] Shows continue-journey, reviews due, next scheduled check; each row navigates correctly (smoke).
- [ ] Verify first whether any UI writes `planner_items` kind `learning`; report before using it.
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-028 · Analytics Learning section** — P3 · Depends: LS-012, LS-024 (APPROVED); **owner decision PF-019**
(Analytics is not reachable from navigation today, Claude B HO-002 §5).
- [ ] Study time by subject, assessments taken, topics by level; numbers equal store queries on a fixture.
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

#### Phase 7 — Hardening

**LS-029 · Onboarding and state audit** — P2 · Depends: M-L1 exit, LS-018 (APPROVED).
- [ ] Every state in spec §3.6 reachable and screenshotted; first-use hint on the journey hub (dismissible,
      remembered per account).
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**LS-030 · Performance** — P3 · Depends: M-L1 exit.
- [ ] Bench with 1,000 questions and 200 assessments in one subject: `mastery:subject` < 100 ms, quiz start
      < 200 ms (median of 5); add indexes only through a new migration (G1).

#### Later — Quest game layer

**LS-031 · Quest game layer (D6 c)** — P3 · Depends: M-L1 exit, LS-013 (APPROVED); **owner design first** (what
is rewarded, whether it affects mastery: proposed *never*). Inside the existing visual style (D12). BACKLOG.
- [ ] S7 UI parity (D12): existing styles.css/learning.css patterns; screenshots at 1280/400 px side by side with the current Learning pages.

**Critical path:** PF-004 → PF-007 (P0 data integrity, 2026-11-23) → PF-006 → LS-002 → LS-005 → LS-006 → LS-007 → LS-008 → LS-009 → LS-010 → (LS-003,
LS-004) → LS-011 → LS-012 → M-L1 exit. LS-003/LS-004 may be assigned any time after LS-002 when Claude B would
otherwise wait for a review.

### TASK: LS-002 — Assessment model (pure module)

**Status:** **ASSIGNED** (lane 2, 2026-11-23; G3 waived by the owner: pure module, no PF-006 file). Submission HO-015. Branch from
the `main` that exists at release time  
**Priority:** P1  
**Assigned To:** Claude B  
**Created By:** Claude A  
**Created:** 2026-11-23

#### Objective
A pure, dependency-free `src/assessment-model.js` that defines the five question types and grades the
deterministic ones, so every later learning task builds on one tested contract.

#### Context
No assessment code exists (`src/learning.js:5`). Spec §4.2–4.7 defines the data shapes and rules. The module must
run in main (CommonJS `module.exports`) and in the renderer (attach to `window.PerflwAssessmentModel` when
`module` is undefined), the same pattern `topic-model.js` uses — check that file and follow it.

#### Requirements
- `validateQuestion(q) → { ok, value, errors[] }`: normalizes and validates common fields and each type's payload
  exactly as spec §4.2 (lengths, counts, enums, ids unique, `correct`/`pairs` refer to existing ids, `provenance`
  required when `origin:'generated'`). Unknown fields dropped. Errors are plain-language and name the field.
- `normalizeResponse(question, raw) → response` with size caps (text ≤ 20,000 chars).
- `grade(question, response) → { score, max, status, criteria?, category? }` for choice (single/multiple with partial
  credit), truefalse (justification part → `pending`), matching; `essay`/`explain` → `status:'pending'`;
  `dontKnow` → `not_known`, empty → `not_answered`.
- `scoreFromCriteria(question, verdicts) → score` (met = full, partly = half, missing = 0).
- `selectItems({ questions, topics, count, types, dimensions, exclude, weakTopics, seed }) → questions[]`
  deterministic for a given seed, per spec §4.7.
- `stripAnswerKey(snapshot)` removes `correct`, `pairs`, `modelAnswer`, rubric keywords.
- `shuffle(items, seed)` seeded and stable.

#### Relevant Files
New: `src/assessment-model.js`, `test/assessment-model.test.js`. Read only: `src/topic-model.js`,
`test/topics.test.js` (conventions), `package.json` (test script glob).

#### Dependencies
LS-001 (D1–D5 approved ✔; ADR-005 ACCEPTED ✔, 2026-11-23).

#### D3 requirement
Questions carry `review: 'approved' | 'unreviewed' | 'rejected'`. Manual and accepted template questions are
`approved`; `origin:'generated'` questions default to `unreviewed`. `selectItems` must exclude `unreviewed` and
`rejected` items when `kind` is `diagnostic`, `final` or `retention`, and exclude only `rejected` for `practice`.
Test both.

#### Restrictions
- No I/O, no DOM, no Electron, no new dependencies.
- Do not edit any existing file except `package.json` if the test glob needs it (report it if so).
- Do not add the module to `index.html` yet (LS-010 does).

#### Acceptance Criteria
- [ ] All functions above exported, with the shapes in spec §4.2.
- [ ] Tests cover: each type valid/invalid; multiple-choice partial credit incl. floor at 0; matching partial;
      dontKnow and empty; seeded selection is deterministic and covers every topic before repeating; exclusion
      honored; `stripAnswerKey` leaves no key field (deep check).
- [ ] `npm test` passes (the base commit's count, 141 at `5664f56` plus whatever PF-006 adds, + new), exit code
      captured as `npm test > log 2>&1; echo EXIT=$?` (nothing between the command and `$?`).
- [ ] Committed on `feature/LS-002-assessment-model` (or the session's generated branch, stated in the handoff);
      HANDOFF_LOG entry with results, using the next free HO number.
- [ ] No `npm run test:electron` needed (no renderer change); if run, report the result.

#### Deliverables
Summary, files, test output with exit code, commit hash, any spec ambiguities found (report, don't decide).

#### Review
**Reviewed By:**  
**Decision:** **APPROVED** (HO-019, 2026-11-23), `1ab06db` on `claude/ls-002-assessment-model-9f8216` (code `613ee4d`). `npm test` 167/167 (EXIT=0).

### TASK: PF-004 — Fix the failing Electron E2E smoke test

**Status:** READY  
**Priority:** P0  
**Assigned To:** Claude B (on owner approval)  
**Created By:** Claude A  
**Created:** 2026-11-23

#### Objective
`npm run test:electron` passes reliably, restoring the UI regression safety net.

#### Context
At `a54858c`/`e9cc8ae` it failed on 2 out of 2 runs, in the same stage but at different steps.
`test/electron-smoke.js:582` timed out ("bookmarks are sections in the key points") with the side panel still on
"Analyzing this file… Converting it and gathering its key points."; `:581` timed out ("viewer drew the PDF").
`a54858c` changed `electron-smoke.js` by +169 lines, so compare its behavior at `0154895` too.

#### Requirements
- Find the root cause before fixing (`systematic-debugging`). Decide whether it is a hang, a race, an error that
  is never surfaced, or slow but correct work.
- Fix the cause. Raise a timeout only with evidence that the work is correct but slow.
- If the product code is at fault, add a unit test that reproduces it.

#### Relevant Files
`test/electron-smoke.js`, `src/learning-pdf.js`, `src/learning-workflow.js`, `src/learning-study.js`,
`src/learning-intel.js`, `src/main.js` (`learning:*` handlers).

#### Dependencies
None.

#### Restrictions
- Avoid unrelated modifications; don't change other smoke steps.
- No new dependencies.
- Do not change architectural foundations without approval.

#### Acceptance Criteria
- [ ] Root cause stated with evidence in `HANDOFF_LOG.md`.
- [ ] `npm run test:electron` exits 0 on 3 consecutive runs, captured as `cmd > log 2>&1; echo EXIT=$?` (never
      piped to `tail`/`head`, which hides the exit code).
- [ ] `npm test` still passes (126+ tests).
- [ ] Changes committed on `fix/PF-004-smoke-pdf`, branched from `main`.
- [ ] Documentation updated if necessary.

#### Deliverables
- Implementation summary and root cause.
- Modified files.
- Test results with exit codes.
- Git commit hash.
- Known limitations.

#### Review
**Reviewed By:**  
**Decision:** Pending

---

## 5. Task Assignment Template

Use this structure whenever Claude A delegates a task.

### TASK: PF-XXX — Task Name

**Status:** READY  
**Priority:** P1  
**Assigned To:** Claude B  
**Created By:** Claude A  
**Created:** YYYY-MM-DD

#### Objective
Describe the intended result.

#### Context
Explain why the task is necessary.

#### Requirements
- Requirement 1
- Requirement 2
- Requirement 3

#### Relevant Files
List known files and modules.

#### Dependencies
List prerequisite tasks or systems.

#### Restrictions
- Avoid unrelated modifications.
- Preserve existing conventions.
- Do not change architectural foundations without approval.

#### Acceptance Criteria
- [ ] Requirement satisfied.
- [ ] Implementation behaves as expected.
- [ ] Relevant tests pass.
- [ ] Changes committed.
- [ ] Documentation updated if necessary.

#### Deliverables
- Implementation summary.
- Modified files.
- Test results.
- Git commit hash.
- Known limitations.

#### Review
**Reviewed By:**  
**Decision:** Pending

---

## 6. Task History

Move completed or cancelled tasks into this section rather than deleting them.

| ID | Task | Final Status | Commit | Date |
|---|---|---|---|---|
| PF-004 | Fix the failing Electron E2E smoke test | INTEGRATED (reviewed HO-006) | `3b8f738`, `f2006fa`; merge `dfd1fbd` | 2026-11-23 |

---

## 7. Assignment Rules

1. Claude A is responsible for task definition and prioritization.
2. Claude B implements assigned tasks.
3. Every substantial implementation must have a task ID.
4. Avoid assigning overlapping modifications to both agents.
5. Tasks must have clear acceptance criteria.
6. Blocked tasks must explain the reason for the blockage.
7. Review must happen before integration.
8. Only the project owner or authorized integration process approves main-branch merges.

---

## 8. Parallel Development Rules

Tasks can run simultaneously only when their scopes are sufficiently independent.

Before parallel assignment, verify:
- File ownership does not overlap.
- Dependencies are available.
- Shared interfaces are defined.
- Database or schema changes are coordinated.
- Integration requirements are understood.

When conflicts are unavoidable, sequence the tasks rather than risking simultaneous changes.

---

## 9. Task Queue Maintenance

Claude A must:
- Keep assignments current.
- Remove duplicate backlog entries.
- Identify dependencies.
- Prioritize tasks based on product value.
- Report blocked work.
- Update task statuses after verified progress.

Claude B must not mark its own task INTEGRATED.

Only mark tasks APPROVED after review and INTEGRATED after actual merging.

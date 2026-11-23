# Perflow — Architecture Decision Records

**Last Updated:** 2026-11-23

---

## 1. Purpose

This document records important architectural and technical decisions made throughout Perflow's development.

Its purpose is to:
- Maintain technical consistency.
- Preserve the reasoning behind decisions.
- Prevent contradictory implementations.
- Help future developers understand the system.
- Track changes in architectural direction.

---

## 2. Decision Status

| Status | Meaning |
|---|---|
| PROPOSED | Suggested but not approved |
| ACCEPTED | Approved for implementation |
| REJECTED | Considered and declined |
| DEPRECATED | Previously accepted but no longer recommended |
| SUPERSEDED | Replaced by a newer decision |

Only accepted decisions should be treated as established architectural rules.

---

## 3. Existing Architecture Baseline

**Status:** Assessed 2026-11-23 by Claude A at commit `e9cc8ae`. This table records **what the code does
today**, not approved decisions. Each row is verified in the source.

| Category | Current Decision |
|---|---|
| Programming language | JavaScript (CommonJS, no TypeScript), HTML, CSS. Node 22. |
| Application framework | Electron 38.8.6 (desktop, Windows x64). **EOL since 2026-03-10** (see ADR-001, proposed). |
| UI architecture | No UI framework. One `src/index.html` loads plain renderer scripts (`renderer.js`, `projects.js`, `learning*.js`, `chat*.js`, `automation.js`, `schedule-blocks.js`, …) that render HTML strings into views. A frameless window with an icon rail, a collapsible sidebar and a main panel. 4 stylesheets. |
| Process model & security | Renderer `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`; strict CSP; navigation and window-open blocked. `src/preload.js` exposes one API object over `contextBridge`. About 120 IPC channels named `area:verb`, all registered through `handle()` in `src/main.js`, which checks the sender and returns `{ok, value}` / `{ok:false, error}`. Handlers re-derive the user and check ownership. |
| Data persistence | `node:sqlite` (`DatabaseSync`, experimental in Node 22): `accounts.sqlite` (users, sessions) and `workspace.sqlite` (about 25 tables: planner, projects, tasks, events, milestones, goals, learning, focus, chat, automation; finance tables unused). Files (uploads, notes `.md`, annotations, agent and skill packages) under `%APPDATA%\Perflw`. Secrets via Electron `safeStorage`. Schema evolves through `CREATE TABLE IF NOT EXISTS` and column-existence checks, with no version number. |
| State management | Main process: SQLite is the source of truth. Renderer: an in-memory state object in `renderer.js`, refreshed through IPC, with UI preferences in `localStorage` (`perflw*` keys). No state library. |
| Application structure | `src/` flat, with main-side modules (`main`, `auth`, `workspace`, `learning-workflow/-intel/-images/-agents/-import`, `automation/*`) and renderer modules side by side; pure domain modules (`project-model`, `topic-model`, `home-layout`, `chat-render`) shared and unit-tested. |
| Build system | None for code (no bundler or transpiler). Packaging: `scripts/build.js` with `@electron/packager` 18.4.4 → `dist/Perflw-win32-x64`, trimming unused runtime files and pdf.js builds. |
| Testing framework | `node --test` unit tests (13 files, 126 tests); a custom Electron E2E smoke test over DevTools (`test/electron-smoke.js`); feature smokes and quality benchmarks. No CI, no linter. |
| Distribution method | Unpacked folder plus a desktop shortcut (`scripts/setup-windows.ps1`). No installer, auto-update or code signing found. |
| AI integration | Local Ollama by default (chat model plus an OCR model for images); optional OpenAI, Anthropic, Gemini or OpenAI-compatible providers using the user's own key. |
| Dependencies | Runtime: `pdfjs-dist` 5.4.296 (pinned). Dev: `electron` ^38.3.0, `@electron/packager` ^18.3.6. |

Do not invent or prematurely standardize technologies.

---

## 4. Product Architecture Principles

The following are guiding principles rather than fixed technology decisions.

### Modularity
Keep unrelated responsibilities separated into understandable modules.

### Maintainability
Prefer clear implementations over unnecessarily abstract systems.

### Data Integrity
Protect user data and prevent accidental loss or corruption.

### Local-First Consideration
Prioritize a dependable local experience where consistent with the existing product direction.

### User Experience
Technical architecture should support responsive, intuitive, and predictable interactions.

### Extensibility
Allow future features without requiring unnecessary rewrites.

---

## 5. Architecture Decision Record Template

Create a new record for every significant technical decision.

### ADR-XXX — Decision Title

**Date:** YYYY-MM-DD  
**Status:** PROPOSED  
**Author:** Claude A / Claude B / Project Owner  
**Reviewed By:**  
**Related Tasks:** PF-XXX

#### 1. Context

What problem or requirement prompted this decision?

#### 2. Problem

What needs to be resolved?

#### 3. Options Considered

**Option A**
- Advantages:
- Disadvantages:

**Option B**
- Advantages:
- Disadvantages:

**Option C**
- Advantages:
- Disadvantages:

#### 4. Decision

What approach was selected?

#### 5. Reasoning

Why was this option selected over the alternatives?

#### 6. Consequences

Positive consequences:
- 

Trade-offs:
- 

Potential risks:
- 

#### 7. Implementation Requirements

- [ ] Required changes identified.
- [ ] Relevant agents informed.
- [ ] Implementation completed.
- [ ] Tests completed.
- [ ] Documentation updated.

#### 8. Approval

**Project Owner Approval:** Pending  
**Final Status:** PROPOSED

---

## 6. Approved Decisions

Accepted in principle by the project owner on 2026-11-23 (full text stays in §7 under each ADR):

| ADR | Decision | Owner decision |
|---|---|---|
| ADR-002 | Versioned, transactional migrations with backup; mandatory gate before Learning System tables | D1 |
| ADR-003 (amended) | Safe user-data file I/O: atomic write with bounded retry; busy reads throw, never "empty"; corrupt JSON moved aside | Owner in chat, 2026-11-23 (fully ACCEPTED) |
| ADR-006 | Evidence-based mastery replaces manual mastery %; historical values preserved; thresholds configurable initial defaults | D2, D4 |
| ADR-007 | AI is optional; AI output provisional, validated (code-computed scores) and attributed; AI questions in practice at once, human review before pre-tests/finals | D3; remainder owner 2026-11-23 (ACCEPTED; relayed) |
| — (roadmap) | First Learning milestone = offline walking skeleton (M-L1) | D5 |
| ADR-004 | Learning data in SQLite as additive migration 2; note bodies stay Markdown | Owner, 2026-11-23 (ACCEPTED; relayed by the desktop orchestrator session) |
| ADR-005 | Learning module boundaries (pure models, one store, coach, thin handlers); one-object IPC arguments | Owner, 2026-11-23 (ACCEPTED; relayed) |
| ADR-008 | Study sessions are focus entries; scheduled learning = calendar events + `learning_schedule` link | Owner, 2026-11-23 (ACCEPTED; relayed) |

Still PROPOSED: ADR-001.

---

## 7. Proposed Decisions

Record decisions currently being evaluated.

Do not implement major proposed changes until they are approved.

### ADR-001 — Upgrade Electron off the end-of-life 38.x line

**Date:** 2026-11-23  
**Status:** PROPOSED  
**Author:** Claude A  
**Reviewed By:**  
**Related Tasks:** PF-005

- **Context**: the installed Electron is 38.8.6, the last 38.x release (2026-03-10), which is now end-of-support
  (Electron schedule; the v38.8.6 notes carry an end-of-support warning). Electron supports the latest 3 majors.
  The app opens untrusted PDFs, Office files and AI output in Chromium.
- **Options**: (A) move to the newest supported major; (B) move to the oldest supported major, with fewer changes
  but a shorter support window; (C) stay on 38, which is not acceptable for a product handling untrusted
  content.
- **Recommendation**: A, after PF-004 restores the E2E net. Check `node:sqlite` API changes in the newer
  bundled Node, the pdf.js worker loading, `@electron/packager` compatibility, and the custom protocol schemes.
- **Risks**: `node:sqlite` behavior changes; the Chromium rendering changes the smoke screenshots.
- **Approval**: Project Owner: Pending.

### ADR-002 — Versioned, transactional schema migrations

**Date:** 2026-11-23  
**Status:** PROPOSED  
**Author:** Claude A  
**Related Tasks:** PF-006

- **Context**: `src/workspace.js` and `src/auth.js` evolve the schema through column-existence checks, with no
  version and no backup. One table rebuild (`planner_items`, `src/workspace.js:139-153`) runs as a single
  `exec('BEGIN;…COMMIT;')`, so an error mid-way leaves the transaction open.
- **Options**: (A) `PRAGMA user_version` plus an ordered migration list, each migration in
  `BEGIN IMMEDIATE…COMMIT` with `ROLLBACK`, and a DB file copy before the first pending migration; (B) keep the
  ad hoc checks and only wrap the rebuild in try/rollback; (C) adopt a migration library, which would be a new
  dependency.
- **Recommendation**: A, with no new dependency. Version 1 equals today's schema and is idempotent, so
  existing installs pass through unchanged.
- **Note (2026-11-23, HO-013):** a database with a newer `user_version` than the app knows is opened as is. This is safe
  only while every migration is additive (ADR-004). A future migration that is not purely additive must also make
  older app versions refuse the file (e.g. a minimum-version marker checked before migrating).
- **Approval**: Project Owner: **ACCEPTED in principle 2026-11-23** (decision D1). Mandatory gate before any
  Learning System table (gate G1). Implementation: PF-006.

### ADR-003 — One atomic-write helper for user-data files

**Date:** 2026-11-23  
**Status:** PROPOSED  
**Author:** Claude A  
**Related Tasks:** PF-007

- **Context**: writers differ. Some write a temp file and rename it, with `0o600`; `agents.json` is written in
  place (`src/learning-agents.js:283`); annotations skip the file mode (`src/main.js:481`).
- **Recommendation**: a single `writeFileAtomic(file, data, { mode = 0o600 })` (temp file in the same folder,
  then rename), used for every user-data write.
- **Amendment 2026-11-23 (after PF-004)**: Claude B reproduced on Windows that `renameSync` onto a file another
  process holds open throws `EPERM`, and `readFileSync` under an exclusive handle throws `EBUSY`
  (`test/learning-state-io.test.js`, independently re-run by Claude A: both reproduce). Worse than a failed write:
  `readJson` (`src/learning-workflow.js:59`) turns **any** read error into "empty", and the next save overwrites the
  file. The same read-swallow-then-write pattern exists for learning preferences (`learning-workflow.js:499-510`)
  and the learning-agent registry (`src/learning-agents.js:279-374`, which also writes in place). The decision is
  therefore widened to **two** helpers in one module (e.g. `src/safe-file.js`):
  1. `writeFileAtomic(file, data, { mode = 0o600 })`: temp file in the same folder → `renameSync`; on
     `EPERM`/`EBUSY`/`EACCES` retry with bounded backoff (total wait ≤ ~500 ms, synchronous, because the callers
     rely on no `await` between read and write); on final failure delete the temp file and throw a plain-language
     error.
  2. `readJsonFile(file, fallback)`: `ENOENT` → fallback; `EBUSY`/`EPERM`/`EACCES` → same bounded retry, then
     **throw** (never return the fallback); invalid JSON → move the file aside to `<name>.corrupt-<timestamp>` and
     return the fallback, so nothing is silently overwritten.
  3. Callers doing read-modify-write must not write when the read threw.
  4. When a status cannot be persisted (the workflow's "failed" save), the status is still kept in memory and
     emitted, so the UI never waits forever.
- **Trade-off**: a synchronous retry can block the main process for up to ~0.5 s in the rare held-file case;
  accepted over making the state code async.
- **Approval**: Project Owner: **ACCEPTED** (as amended), approved by the project owner in chat on 2026-11-23.
  Implementation: PF-007.

### ADR-004 — Learning System data lives in SQLite (additive migration 2), note bodies stay Markdown

**Date:** 2026-11-23 · **Status:** ACCEPTED (owner, 2026-11-23) · **Author:** Claude A · **Related:** LS-005, LS-006, spec §6

- **Context**: no assessment, journey or session data exists. Learning today mixes SQLite (subjects, topics,
  files) and JSON/Markdown files (analysis, saved notes in `intel/<subjectId>/state.json`).
- **Options**: (A) new SQLite tables for journeys, questions, assessments, items, answers, sessions, materials,
  schedule links, review boxes; Markdown files only for note bodies; (B) extend the per-subject JSON files;
  (C) one generic JSON "learning_records" table.
- **Decision (proposed)**: A. Mastery needs queries across topics, kinds and time, with foreign keys and cascades;
  JSON files cannot do that safely, and a generic table loses constraints.
- **Constraints**: purely additive (`CREATE TABLE`/`INDEX` only, no change to existing tables) as **migration 2**
  of PF-006/ADR-002; upgrade test from a v1 fixture. Fallback only if ADR-002 is rejected: `IF NOT EXISTS` for these
  additive tables. No mastery table: mastery is computed (ADR-006).
- **Note (2026-11-23, within the accepted scope):** owner decisions D8/D10 add `assessments.attempt`,
  `assessments.retake_of` and `learning_materials.parent_material_id` + kind `side_note_ai` to migration 2; D13 adds
  `learning_sessions.visited`. Still
  `CREATE TABLE` only; no existing table changes. Spec §6.2.
- **Approval**: Project Owner: ACCEPTED 2026-11-23 (owner decision relayed by the desktop orchestrator session).

### ADR-005 — Learning module boundaries and object-argument IPC

**Date:** 2026-11-23 · **Status:** ACCEPTED (owner, 2026-11-23) · **Author:** Claude A · **Related:** LS-002–LS-007, spec §6.1, §6.3

- **Context**: existing channels use long positional arguments (`workspace:createTask` 12, `createEvent` 10;
  `src/preload.js:60,64`); renderer files are already large (R7).
- **Decision (proposed)**: rules in pure modules (`assessment-model`, `mastery-model`, `learning-insight`, same
  dual-load pattern as `topic-model.js`); all SQL in one `learning-store.js`; AI jobs in `learning-coach.js` via
  `ecosystem.runAgent`; thin handlers in `main.js`; new renderer modules per screen. Every new channel takes **one
  object argument**. Answer keys are never sent to the renderer for an in-progress diagnostic/final.
- **Trade-off**: new channels differ in style from old ones; old ones are not rewritten (CLAUDE.md §7).
- **Approval**: Project Owner: ACCEPTED 2026-11-23 (owner decision relayed by the desktop orchestrator session).

### ADR-006 — Evidence-based mastery replaces the manual subject mastery %

**Date:** 2026-11-23 · **Status:** PROPOSED · **Author:** Claude A · **Related:** LS-003, LS-025, spec §5

- **Context**: `subjects.mastery` and `subjects.minutes` are typed by the student (`src/learning.js:830-834`) and
  shown as "N% mastery". The brief forbids mastery without assessment evidence.
- **Decision (proposed)**: topic-level levels (Not assessed / Emerging / Developing / Proficient / Mastered)
  computed by a pure function from graded answers with documented weights and thresholds (spec §5.4);
  recognition-only evidence capped at Developing; Mastered needs a final exam and a delayed retention check. Subject
  summary = "n of m topics Proficient+", never an averaged %. Time = sum of learning focus entries.
- **Migration**: columns and values kept (no destructive change); the old value is shown read-only as a labelled
  self-estimate and never used in calculations (spec §5.5); edit fields removed in LS-025.
- **Configurability (D4)**: all weights and thresholds in one versioned `DEFAULT_MASTERY_CONFIG`; functions accept
  an override; results record `configVersion`; values are initial defaults to validate through use.
- **Approval**: Project Owner: **ACCEPTED in principle 2026-11-23** (decisions D2 and D4).

### ADR-007 — AI is optional; AI output is provisional, validated and attributed

**Date:** 2026-11-23 · **Status:** ACCEPTED (owner, 2026-11-23) · **Author:** Claude A · **Related:** LS-015–LS-019, LS-032, spec §4.4, §6.4, §6.6

- **Decision (proposed)**: every stage works without a model (manual + template questions, deterministic grading,
  rubric self-grading, deterministic targeted notes). AI questions must pass `validateQuestion` and cite a source
  chunk from their input; AI grades return per-criterion verdicts as JSON and **code computes the score**; grades
  are `provisional` until the student accepts or adjusts them; low-confidence grades don't count toward mastery.
  Every AI artifact stores provider, model, agent, prompt version and time, and shows an "AI" chip.
- **D3 (accepted)**: generated questions are usable immediately in practice; they need human review
  (`review:'approved'`) before appearing in pre-tests, final exams or retention checks.
- **Approval**: Project Owner: **D3 ACCEPTED in principle 2026-11-23**; D5 (offline walking skeleton first) accepted
  and consistent with this ADR. The rest of the ADR (validation, code-computed scores, provenance): **ACCEPTED
  2026-11-23** (owner chose "Accept" in the desktop orchestrator session's question dialog).

### ADR-008 — Study sessions are focus entries; scheduled learning is calendar events plus a link table

**Date:** 2026-11-23 · **Status:** ACCEPTED (owner, 2026-11-23) · **Author:** Claude A · **Related:** LS-012, LS-026, spec §7

- **Context**: `focus_entries`/`active_timers` and `events` already exist and are shown in the calendar and timer.
- **Decision (proposed)**: a study session runs the existing timer with `source:'learning'` and links its
  `focus_entry_id`; scheduled sessions/checks are ordinary `events` rows plus a `learning_schedule` link
  (`event_id` FK CASCADE). Existing tables are not altered. Avoids a parallel time-tracking or calendar system.
- **Approval**: Project Owner: ACCEPTED 2026-11-23 (owner decision relayed by the desktop orchestrator session).

---

## 8. Deprecated and Superseded Decisions

Preserve historical decisions here.

For every superseded decision, reference the newer ADR.

---

## 9. Decision Authority

### Claude A
- Evaluates architectural alternatives.
- Identifies technical trade-offs.
- Proposes decisions.
- Maintains architectural consistency.

### Claude B
- Provides implementation feedback.
- Identifies technical limitations.
- Suggests alternatives when necessary.

### Project Owner
- Approves major architectural changes.
- Decides between competing product and technical priorities.
- Has final authority over architectural direction.

---

## 10. Change Management

Before changing an established architectural decision:

1. Identify the existing ADR.
2. Explain why it should change.
3. Evaluate alternatives.
4. Identify migration requirements.
5. Assess compatibility risks.
6. Obtain necessary approval.
7. Create a new ADR.
8. Update affected documentation.

Never silently replace an established architectural decision.

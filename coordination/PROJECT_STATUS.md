# Perflow — Project Status

**Last Updated:** 2026-11-23  
**Project Status:** Existing product, baseline audited  
**Project Owner:** Human Project Owner  
**Lead Architect:** Claude A  
**Implementation Developer:** Claude B

Audit basis: commit `e9cc8ae` (local `main`; app code unchanged since `a54858c`). Evidence levels: **code** =
read in the source; **test** = command run locally with its exit code captured; **web** = primary source
online.

---

## 1. Project Overview

Perflow is a student-focused productivity application intended to centralize academic and everyday organization.

### Product Direction

- Primary audience: Students.
- Product ambition: Independent software product.
- Current development priority: Learning, building, and validating the product.
- Development approach: Iterative feature development.

### Core Product Goals

- Simplify daily student organization.
- Centralize important responsibilities.
- Reduce friction when planning and managing tasks.
- Provide a consistent and enjoyable user experience.

### What exists today (verified, code)

An offline-first **Windows desktop app** (Electron), about 19k lines of JavaScript and CSS, already well past
prototype stage. In the code, package, README, data folder and GitHub repo it is named **"Perflw"**
(formerly "Impct Intelligence"); see Discrepancies.

---

## 2. Current Development Status

| Area | Status | Notes (evidence) |
|---|---|---|
| Project foundation | Established | Electron 38.8.6, Node 22, plain CommonJS, no framework or bundler; `npm start/test/build` work (code, test) |
| Application architecture | Established, sound | Sandboxed renderer, `contextBridge` preload, about 120 IPC channels through one guarded `handle()` (code) |
| UI/UX system | Implemented | Frameless window, icon rail, collapsible sidebar, 9 core views plus Automation views; about 527 `aria-*` attributes, 62 `:focus-visible` rules, `prefers-reduced-motion` honored (code) |
| Planner / Calendar | Implemented | Days, Weeks and Months views; plans; time-block schedules with drag; project tasks appear on the calendar (code, smoke test) |
| Task management | Implemented | Projects block editor, tasks, milestones, goals (backend only), Routine (resets daily), Activities (code) |
| Learning | **Built:** document workflow, Ask, notes. **Not built:** assessment, weakness analysis, mastery, journey, final exam | Built (code; `test:learning` smoke PASS on `main` 2026-11-23): subjects, topics, file import (PDF/DOCX/PPTX/MD/TXT), in-app PDF viewer, annotations, document analysis pipeline, image reading through Ollama, grounded Ask (Q&A), saved notes. Not built: pre-test/quizzes, mistake and weakness analysis, computed mastery, journeys, study sessions, final exam: placeholders (`learning.js:5,156-160`). Mastery is **only a manual %** the student types (`learning.js:830`). PF-007 (safe file I/O for learning state) integrated (`5664f56`). Spec: `docs/LEARNING_SYSTEM_SPEC.md` (ADR-004/005/008 accepted; owner diagram questions open, HO-011) |
| Focus timer | Implemented | Start and stop from the schedule panel; `focus_entries` and `active_timers` (code) |
| Chat and AI automation | Implemented | Chat sessions, agents, skills, workflows; Ollama by default, optional OpenAI/Anthropic/Gemini (code) |
| Analytics | Basic | One view of routine and plan counts for the month (code) |
| Expense tracking | **Not implemented (schema only)** | `finance_*` and `ledger_entries` tables exist, with zero reads or writes, no IPC and no UI (code) |
| Data persistence | Implemented, has risks | SQLite (`node:sqlite`) in two DBs plus files under `%APPDATA%\Perflw`; ad hoc migrations (code) |
| Testing | Partial: E2E passing, **flaky** | `main` `5664f56`: `npm test` 141/141 (orchestrator session); tree identical to `b545f18`, where Claude A measured: `npm test` 141/141, `test:electron` 3/3 PASS (HO-010); 7 of 9 runs pass across HO-008/010 (fixed waits, PF-020) (test) |
| Documentation | Good for users, mixed for devs | Detailed README; 6 design and concept docs in `docs/`, some concept-only (code) |
| Multi-agent workflow | In progress | Coordination files committed in `e9cc8ae`; Claude B's identity not yet confirmed |

---

## 3. Current Milestones

### Milestone 1 — Development Foundation

Status: In Progress

Objectives:
- Establish development conventions. — done in `CLAUDE.md`
- Configure Claude A and Claude B. — Claude A active; Claude B not confirmed
- Establish isolated Git worktrees. — done (Claude A: `.claude/worktrees/perflow-manager`)
- Create shared coordination documents. — done (`e9cc8ae`)
- Verify the Git workflow. — pending the first Claude B task cycle

### Milestone 2 — Architecture Understanding

Status: Complete, pending owner review (audit of 2026-11-23, this document)

Objectives:
- Inspect the complete repository.
- Identify the existing technology stack.
- Document application architecture.
- Understand current data models.
- Identify technical risks.

### Milestone 3 — Core Product Development

Status: Pending

Objectives:
- Identify the most important student workflows.
- Prioritize core features.
- Improve the existing product foundation.
- Implement and validate essential features.

### Milestone 4 — Product Validation

Status: Pending

Objectives:
- Test actual student workflows.
- Identify usability problems.
- Collect feedback.
- Prioritize improvements.

### Milestone 5 — Release Preparation

Status: Pending

Objectives:
- Review application stability.
- Verify data integrity.
- Address security concerns.
- Prepare distribution and onboarding.

---

## 4. Active Development

| Task ID | Task | Owner | Status |
|---|---|---|---|
| PF-001–003 | Baseline audit (architecture, features, risks) | Claude A | REVIEW (by owner) |
| PF-004 | Fix the failing E2E smoke test | Claude B | INTEGRATED (`dfd1fbd`) |
| PF-007 | Safe user-data file I/O (P0) | Claude B | INTEGRATED (`5664f56`, approved HO-010) |
| PF-006 | Versioned migrations (gate G1) | Claude B | INTEGRATED (`350520c`, pushed); G1 open. Follow-up PF-021 queued (before first release) |
| LS-005 | Migration 2: learning tables | Claude B (lane 3) | ASSIGNED 2026-11-23 (HO-018, branch `claude/nifty-haslett-6c96fe`); then REVIEW |
| PF-020 | Smoke-test flakes (gate G2) | Claude B (lane 1) | ASSIGNED 2026-11-23 |
| LS-002 | Assessment model (pure) | Claude B (lane 2) | APPROVED (HO-019, `1ab06db`); awaiting merge by the orchestrator. LS-003 (HO-016) and LS-004 (HO-017) may start after it |
| LS-001 | Learning System spec | Claude A | DONE: D1–D5 approved; ADR-004/005/008 ACCEPTED (2026-11-23); owner decisions D6–D17 recorded (HO-011) |

Update this section whenever a task becomes active.

---

## 5. Current Blockers

### B-1 · End-to-end smoke test fails
- **Description**: `npm run test:electron` exits 1 on 2/2 runs. Run 1 timed out at
  `test/electron-smoke.js:582` ("bookmarks are sections in the key points") with the panel still on
  "Analyzing this file…"; run 2 timed out at `:581` ("viewer drew the PDF"). It is the same stage (Learning PDF
  viewer and analysis) but a different step each time.
- **Impact**: there is no working UI regression net, so a refactor or the Electron upgrade can't be verified.
- **Responsible agent**: Claude B (PF-004).
- **Root causes (PF-004, HO-004/HO-006)**: `:581` = the worktree had no `node_modules` (renderer loads pdf.js by
  URL); `:582` = held `state.json` on Windows (mechanism reproduced; fix is PF-007).
- **Resolution status**: **Resolved** — PF-004 integrated in `dfd1fbd` (2026-11-23). Residual flakes tracked in
  PF-020.

### B-2 · Claude B not confirmed
- **Description**: it isn't known which session is Claude B. Another interactive session exists, and a second
  worktree, `claude/caveman-mode-ac59fd`, exists at `a54858c`.
- **Impact**: no task can be assigned.
- **Required action**: the owner names the Claude B session.
- **Update 2026-11-23**: the session in worktree `caveman-mode-ac59fd` identifies itself as Claude B (commit
  `e3412ce`) and is working on PF-004; the owner refers to it as Claude B. Treated as resolved unless the owner says
  otherwise.

### B-3 · Coordination docs not shared with Claude B
- **Description**: the audit, Learning spec, PF-006 and LS task specs are uncommitted in Claude A's worktree.
- **Impact**: Claude B cannot read its next assignments.
- **Required action**: owner approves committing them on `worktree-perflow-manager` and merging (or sharing) them.
- **Update 2026-11-23**: committed on `worktree-perflow-manager` on top of `main` `dfd1fbd` (owner request).
- **Resolution status**: Open until the owner merges `worktree-perflow-manager` into `main`.

---

## 6. Known Technical Risks

Verified (code, test or web evidence). Ranked by impact.

| # | Risk | Evidence | Severity |
|---|---|---|---|
| R1 | **Electron 38 is end-of-life** (since 2026-03-10; about 8 months without Chromium security fixes). The app renders untrusted PDFs, Office files and AI output. | web: Electron schedule and v38.8.6 release notes; installed 38.8.6 | High |
| R2 | **E2E smoke test failing**, so there is no UI regression safety net | test | High |
| R3 | **Schema migrations are ad hoc**: no `user_version`, no backup before altering, and the `planner_items` rebuild runs as one `exec('BEGIN;…COMMIT;')` that leaves the transaction open if a statement fails (`src/workspace.js:139-153`) | code | Medium-High (user data) |
| R4 | **User-data file I/O can silently lose data on Windows**: a held file makes `renameSync` throw `EPERM` and reads throw `EBUSY`; `readJson` (`src/learning-workflow.js:59`) treats that as "empty" and the next save overwrites the subject's `state.json` (saved notes, document entries). Same pattern for preferences and the agent registry; `agents.json` written in place (`src/learning-agents.js:283`); annotations without `mode 0o600` (`src/main.js:481`). Reproduced in PF-004 tests (re-run 3/3 by Claude A). | code, test | **High** (raised 2026-11-23; PF-007 P0) |
| R5 | **`node:sqlite` is experimental** in the bundled Node (a runtime warning is printed); its API can change across Electron upgrades | test output | Medium (relevant to R1) |
| R6 | **No CI, no linter**: every check is manual and the E2E run takes minutes | code | Medium |
| R7 | **Large renderer files**: `renderer.js` 120 KB; `automation.js`, `learning.js`, `projects.js`, `learning-intel.js` 70–77 KB each | code | Medium (maintainability) |
| R8 | **Thin direct unit coverage** of main-side stores (`automation/store`, `packages`, `connections`, `sessions`) and all renderer modules (the E2E smoke covers the renderer, but it is failing) | code | Medium |
| R9 | **Dormant schema**: `documents`, `ledger_entries` and the `finance_*` tables are created on every start but unused | code | Low |
| R10 | **Unpushed work**: local `main` is 2 commits ahead of `origin/main` (`a54858c`, `e9cc8ae`); there is no off-machine backup of that work | git | Medium |

Not yet investigated (do not treat as confirmed): dependency CVEs (`npm audit` not run), performance with
large libraries, packaging and installer, the behavior of the Office PDF-conversion script.

### Strengths (verified, code)
- A strong security baseline: `sandbox`, `contextIsolation`, no `nodeIntegration`, a strict CSP,
  navigation and window-open blocked, every IPC call checks its sender, handlers re-check ownership and clamp
  input, secrets go through `safeStorage`, and generated visuals live in an isolated `perflw-sandbox:` scheme.
- Pure domain modules (`project-model`, `topic-model`, `home-layout`, `chat-render`) with unit tests.
- Minimal dependencies: one runtime dependency (`pdfjs-dist` 5.4.296, pinned).
- Accessibility is already taken seriously (see the UI/UX row).

### Discrepancies (reported, not resolved)
- **Name**: `CLAUDE.md` and the coordination docs say "Perflow"; the code, package, README, `%APPDATA%\Perflw`
  and `github.com/2Pyrox/Perflw` say "Perflw".
- **Expense tracking**: the template lists it as a product area; the code has only unused tables.

---

## 7. Recent Achievements

| Date | Achievement | Reference |
|---|---|---|
| 2026-11-23 | Initial coordination documentation | `e9cc8ae` |
| 2026-11-23 | Baseline repository audit (Milestone 2) | this file; HANDOFF_LOG HO-002 |
| 2026-11-23 | Learning System specification proposed | `docs/LEARNING_SYSTEM_SPEC.md`; HO-003 |

---

## 8. Next Priorities

1. Restore the E2E safety net (PF-004).
2. Decide and plan the Electron upgrade off the EOL release (PF-005 and ADR-001).
3. Protect user data: versioned migrations and atomic writes (PF-006, PF-007).
4. Automate verification (PF-008).
5. Owner product decisions: name, expense tracking, core student workflows (PF-009, PF-013, PF-015).
6. Learning System: spec approved in principle (D1–D5, 2026-11-23). Order, one task at a time: PF-004 ✔ (review) →
   PF-007 ✔ (integrated, `5664f56`) → PF-006 (assigned) → LS-002 → … (critical path in `TASK_QUEUE.md`). Learning tables wait for PF-006 (gate G1). ADR-004/005/008
   accepted 2026-11-23.

---

## 9. Update Rules

- Claude A maintains the overall project status.
- Claude B reports completed work to Claude A.
- The project owner approves major milestone changes.
- Every update must reflect verified project conditions.
- Do not delete historical achievements when updating this document.

**Last verified state:** Baseline audit at `e9cc8ae`, 2026-11-23.

# Perflow — Agent Handoff Log

**Last Updated:** YYYY-MM-DD

---

## 1. Purpose

This document records the transfer of tasks, implementation results, review feedback, and integration outcomes between Claude A and Claude B.

It serves as a persistent communication record across separate Claude Code sessions.

---

## 2. Handoff Workflow

### Stage 1 — Assignment

Claude A creates a task in TASK_QUEUE.md.

Claude A provides:
- Task ID
- Objective
- Context
- Requirements
- Relevant modules
- Restrictions
- Acceptance criteria

### Stage 2 — Acknowledgment

Claude B confirms:
- Understanding of the task.
- Planned implementation.
- Potential dependencies.
- Identified risks or blockers.

### Stage 3 — Implementation

Claude B:
- Implements the requested feature.
- Runs relevant tests.
- Inspects the Git diff.
- Commits completed changes.
- Prepares a completion report.

### Stage 4 — Submission

Claude B submits its results to Claude A.

### Stage 5 — Review

Claude A:
- Inspects the commit.
- Reviews the implementation.
- Checks acceptance criteria.
- Identifies issues.
- Approves or requests revisions.

### Stage 6 — Integration

The project owner or authorized integration process merges approved work.

The final merge reference is recorded.

---

## 3. Handoff Entry Template

### HANDOFF — HO-XXX

**Date:** YYYY-MM-DD  
**Task ID:** PF-XXX  
**From:** Claude A / Claude B  
**To:** Claude A / Claude B  
**Status:** PENDING

#### 1. Assignment / Summary

Describe the purpose of the handoff.

#### 2. Context

Provide the necessary background.

#### 3. Work Completed

List verified implementation changes.

#### 4. Modified Files

- path/to/file

#### 5. Git Information

**Branch:**  
**Commit:**  
**Base Branch:**  

#### 6. Testing

**Tests Executed:**
- 

**Results:**
- 

#### 7. Outstanding Issues

- None / List outstanding issues.

#### 8. Required Next Action

Specify exactly what the receiving agent must do.

#### 9. Review Result

**Reviewer:**  
**Decision:** PENDING

---

## 4. Handoff History

### HO-001 — Initial Coordination Setup

**Date:** YYYY-MM-DD  
**From:** Project Owner  
**To:** Claude A and Claude B  
**Status:** IN PROGRESS

#### Objective

Establish the shared documentation and coordination protocol for Perflow's two-agent development workflow.

#### Deliverables

- CLAUDE.md
- PROJECT_STATUS.md
- TASK_QUEUE.md
- ARCHITECTURE_DECISIONS.md
- HANDOFF_LOG.md

#### Required Next Action

Claude A must inspect the repository and establish an accurate project baseline.

Claude B must review the project instructions and prepare for implementation assignments.

---

### HO-004 — PF-004: Electron smoke test failure in the Learning PDF stage

**Date:** 2026-11-23  
**Task ID:** PF-004 (approved by the project owner in chat, 2026-11-23)  
**From:** Claude B  
**To:** Claude A  
**Status:** SUBMITTED — awaiting review. Both PDF-stage causes are found. `:581` is fixed in the test. `:582` is reproduced and handed to PF-007. The acceptance batch had 3 consecutive passes (section 7). Earlier intermittent failures in two other steps are disclosed in section 8.

> Numbering: HO-002 and HO-003 are Claude A's uncommitted entries in the `perflow-manager` worktree. Claude B's
> familiarization report was also written as "HO-002" (branch `claude/caveman-mode-ac59fd`, commit `e3412ce`);
> renumber it when integrating.

#### 1. Summary

The two recorded failures have **two different causes**.

| Failure | Cause | Evidence level | Action in this task |
|---|---|---|---|
| `:581` "viewer drew the PDF" | Environment: the worktree had no `node_modules` of its own | Reproduced 2/2 | Smoke test now stops at start with the fix |
| `:582` "bookmarks are sections…", panel stuck on "Analyzing this file…" | Product: `state.json` saves and reads in `src/learning-workflow.js` fail when another process holds the file open | Mechanism reproduced in unit tests and an OS probe; not reproduced in the live smoke run | Reproducer tests added as `todo`; fix deferred to PF-007 / ADR-003 |

Neither failure is slow but correct work. PDF analysis took 480 ms in a timed run, and the wait allows 30 s.

#### 2. Root cause — `:581` (environment)

- `src/learning-pdf.js:23` loads pdf.js in the renderer by URL: `import('../node_modules/pdfjs-dist/build/pdf.min.mjs')`. That resolves to `<app dir>/node_modules`.
- The main process uses Node's module lookup instead (`src/learning-intel.js:192`), which walks up parent folders. A git worktree under `.claude/worktrees/` without its own install therefore still starts and analyzes files. It uses the main checkout's `node_modules`, and `npm run` also finds `electron` there. Only the renderer's PDF view fails.
- Claude A's worktree `perflow-manager` has no `node_modules` (checked).
- Reproduced: with this worktree's `node_modules` renamed away, the run failed at "viewer drew the PDF" on 2 out of 2 runs. The side panel had finished its analysis, showing Unit A and Unit B. With `node_modules` present: 5/5 passes. The main checkout: 1/1 pass.
- The product itself is not affected: a packaged build ships `node_modules`, and the viewer already shows its error in `.ln-doc-state` (`src/learning-pdf.js:109-111`).

#### 3. Root cause — `:582` (product data integrity, Windows)

- `write()` (`src/learning-workflow.js:53-58`) writes a temp file, then `fs.renameSync` onto `state.json`, with no retry. `readJson()` (`:59`) returns the fallback for **any** read error, not only for a missing file.
- Windows probe, run in the scratchpad (Node 22, Windows 11). While another process holds `state.json` open:
  - `renameSync` onto it throws `EPERM`. This happens with share modes `Read`, `ReadWrite` and `None`.
  - With an exclusive handle, `readFileSync` also throws `EBUSY`.
  - Inference, not observed on this machine: virus scanners and the search indexer can open freshly written files in `%TEMP%` (where the smoke test's data lives) at exactly these moments.
- How this matches the symptom. `queueFile` saves `pending`. Then the analysis "ready" save throws, and the "failed" save in `run()`'s catch throws too and is swallowed (`:128-129`). `state.json` keeps `pending`. The renderer reloads on the `failed` event, reads `pending`, and shows "Analyzing this file…" with no further event.
- A second, worse effect: an `EBUSY` read makes `loadState` return an empty state, and the next save overwrites the subject's `state.json`. Every document entry and every saved note in that file is lost. Document `.json`/`.md` files stay on disk, and files are re-analyzed when opened.
- Reproduced in `test/learning-state-io.test.js`, 2 tests, both failing as predicted:
  1. A held rename leaves the file `pending` forever.
  2. One busy read makes the first document read back as `pending` (its state entry is gone).
- Not reproduced in the live smoke run: 7 normal runs plus 1 run under CPU load all got past `:582`. It is plausible that a scanner caused Claude A's run 1, but that is not proven.

#### 4. Work Completed

- `test/electron-smoke.js`:
  - New startup precondition: without `<app>/node_modules/pdfjs-dist/build/pdf.min.mjs`, the run exits 1 immediately with `Missing … Run "npm ci" in <dir> first.` It is skipped when `PERFLW_ELECTRON_EXE` (packaged build) is set.
  - `waitFor` failures now also print the viewer's error text (`.ln-viewer .ln-doc-state`), next to the side panel text.
  - No smoke step changed.
- `test/learning-state-io.test.js` (new): the 2 reproducers above, marked `{ todo: 'PF-007 / ADR-003' }`. They run and report, but do not fail `npm test`. Remove `todo` when PF-007 lands.
- No product code changed.
- No smoke assertion, wait condition or timeout value changed. The only diff in `test/electron-smoke.js` is the startup precondition and the extra diagnostic text.

**Environment and dependency setup (this worktree only)**
- Ran `npm ci` once in this worktree. That is a clean install from `package-lock.json`, which deletes any existing `node_modules` first. It exited 0.
- `package.json` and `package-lock.json` are unchanged (`git diff e9cc8ae -- package.json package-lock.json` is empty). No dependency was added or upgraded.
- Every needed package was already declared:
  - `electron` (devDependency `^38.3.0`, locked 38.8.6);
  - `pdfjs-dist` (dependency `5.4.296`, locked 5.4.296);
  - `@napi-rs/canvas` (not in `package.json`; locked 0.1.100 as an optional dependency of `pdfjs-dist`, `^0.1.80`).
- `npm ls --all` reports no missing, extraneous or invalid packages. `require.resolve('electron')` resolves inside this worktree.
- So the `:581` failure is a missing local install in the worktree, not an application defect. Any new worktree must run `npm ci` before `npm run test:electron`.

#### 5. Modified Files

- `test/electron-smoke.js`
- `test/learning-state-io.test.js` (new)
- `coordination/HANDOFF_LOG.md` (this entry)

#### 6. Git Information

**Branch:** `fix/PF-004-smoke-pdf` (from `main` at `e9cc8ae`)  
**Commit:** the commit that adds this entry  
**Base Branch:** `main`

#### 7. Testing

Every command was captured as `cmd > log 2>&1; echo EXIT=$?`.

| Run | Conditions | Result |
|---|---|---|
| `npm run test:electron` ×5 | before the change, local `node_modules` | EXIT=0 ×5 (~59 s each) |
| `npm run test:electron` ×2 | before the change, no local `node_modules` | EXIT=1 ×2, "viewer drew the PDF" |
| `npm run test:electron` ×1 | main checkout | EXIT=0 |
| `npm run test:electron` ×1 | under load (2 × `npm test` in parallel) | EXIT=1 at `:609` "collapsed column takes no width" (see section 8) |
| `npm run test:electron` ×1 | after the change, no local `node_modules` | EXIT=1 at once with the "Missing … npm ci" message |
| `npm run test:electron` ×3 consecutive | after the change | EXIT=0, **EXIT=1**, EXIT=0. Run 2 failed at `:1031` (Home card drag, see section 8), not in the PDF stage |
| `npm test` | after the change | EXIT=0: 128 tests, 126 pass, 0 fail, 2 todo |
| `node --test test/learning-state-io.test.js` | after the change | 2 todo (both reproduce), 0 fail |
| **Acceptance batch** `npm run test:electron`, run until 3 passes in a row (cap 6) | commit `3b8f738`, after `npm ci`, nothing else running | run1 01:29:28Z EXIT=0 (70 s), run2 01:30:31Z EXIT=0 (63 s), run3 01:31:29Z EXIT=0 (58 s): **3 consecutive passes in the first 3 runs** |
| **Acceptance** `npm test` | same, run alone after the batch | 01:33:24Z EXIT=0: 128 tests, 126 pass, 0 fail, 0 cancelled, 2 todo |

Logs are kept in this worktree under `pf004-evidence/`: `summary.log`, `smoke-run1.log`…`smoke-run3.log` and `npm-test.log`. Each smoke log ends with "Electron smoke test passed.". The folder is local and not committed, because `*.log` is git-ignored. Each run was captured as `cmd > log 2>&1; echo EXIT=$?`.

#### 8. Outstanding Issues

1. **The `:582` product defect is not fixed.** The fix touches the write helper, which is PF-007 (ADR-003, still PROPOSED). ADR-003 should add:
   - retry `renameSync` on `EPERM`/`EBUSY`/`EACCES` with a short, bounded backoff;
   - in `readJson`, fall back only on `ENOENT` and invalid JSON, and retry or throw on `EBUSY`/`EPERM`, never "empty";
   - when the failed status can't be saved, the error still reaches the panel (for example from memory).

   Recommended priority: raise PF-007 to P0. Silent loss of saved notes is a data-integrity issue.
2. **Intermittent failures outside the PDF stage remain (a known risk, not fixed).** The acceptance batch had 3 consecutive passes. An earlier 3-run attempt went pass, fail, pass. The PDF stage passed in every run with `node_modules` present: 9 normal runs plus 1 under load. Two other steps depend on fixed waits and fail intermittently. Both are outside PF-004's scope ("don't change other smoke steps"), so they were not changed. Line numbers: `:581`/`:582`/`:609` are from before this commit (now `:592`/`:593`/`:620`); `:1031` is from after it.
   - `test/electron-smoke.js:1031` (Home: a held card drops into the empty side column). The injected script reads `document.querySelector('.t-lifted').getBoundingClientRect()` after fixed `requestAnimationFrame` and `setTimeout(260)` waits. In 1 of 11 normal runs the card was not lifted yet, so it threw `Cannot read properties of null (reading 'getBoundingClientRect')`. The step came in with `a54858c`. Not yet determined: whether the drag code needs more time than the test allows, or the lift is dropped sometimes. That needs the same root-cause pass.
   - `test/electron-smoke.js:609` (Learning side panel collapse). It uses `sleep(450)` before measuring a CSS transition and failed once under CPU load.

   Suggested: extend PF-004, or add a new task, to replace these fixed waits with condition waits. Find the root cause of the `:1031` lift first.
3. The 3 acceptance passes ran with a local Ollama (`qwen2.5:3b`) loaded. The smoke run calls it for AI overviews, but that does not gate the asserted steps.

#### 9. Required Next Action

Claude A:
- review this branch;
- decide whether PF-004 is accepted with `:582` handed to PF-007;
- update ADR-003 with the Windows retry and read rules;
- tell every agent worktree to run `npm ci` before `npm run test:electron`, or add that to `docs/ARCHITECTURE.md`.

#### 10. Review Result

**Reviewer:** Claude A  
**Decision:** PENDING

---

## 5. Review Decision Definitions

### APPROVED
The implementation satisfies requirements and can proceed to integration.

### APPROVED WITH MINOR CHANGES
The implementation is acceptable but requires small corrections.

### REVISION REQUIRED
The implementation does not satisfy one or more acceptance criteria.

### REJECTED
The implementation is unsuitable and requires a different approach.

### BLOCKED
The review cannot proceed due to missing information or dependencies.

---

## 6. Communication Rules

1. Every substantial handoff must reference a Task ID.
2. Do not claim changes exist without checking the repository.
3. Include commit hashes whenever available.
4. Clearly identify uncommitted work.
5. Include test results.
6. Identify unresolved issues.
7. Do not silently discard review feedback.
8. Preserve previous handoff records.
9. Avoid recording sensitive information or credentials.
10. Never treat a proposed action as a completed action.

---

## 7. Session Continuity

At the beginning of a new session, agents should inspect:
- PROJECT_STATUS.md
- TASK_QUEUE.md
- ARCHITECTURE_DECISIONS.md
- Recent entries in HANDOFF_LOG.md

Agents must verify the current Git branch and working directory before continuing previous work.

A handoff entry is a communication record, not proof that another agent has already received or acknowledged it.
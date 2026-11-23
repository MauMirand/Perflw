# Perflow — Agent Handoff Log

**Last Updated:** 2026-11-23

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

### HO-002 — Baseline Repository Audit

**Date:** 2026-11-23  
**Task ID:** PF-001, PF-002, PF-003  
**From:** Claude A  
**To:** Project Owner  
**Status:** PENDING (owner review)

#### 1. Assignment / Summary
A comprehensive read-only audit of the existing repository: stack, architecture, modules, features, data,
UI/UX, dependencies, tests, risks. No application code was changed.

#### 2. Context
Requested by the owner after the coordination setup (HO-001).

#### 3. Work Completed
- `PROJECT_STATUS.md`: verified feature status, blockers B-1 and B-2, and risks R1–R10 with evidence.
- `ARCHITECTURE_DECISIONS.md`: §3 baseline filled from the code; ADR-001 to ADR-003 added as PROPOSED.
  No decisions were marked approved.
- `TASK_QUEUE.md`: PF-004 to PF-015 prioritized; PF-004 fully specified and READY.

#### 4. Modified Files
- coordination/PROJECT_STATUS.md
- coordination/ARCHITECTURE_DECISIONS.md
- coordination/TASK_QUEUE.md
- coordination/HANDOFF_LOG.md
- docs/ARCHITECTURE.md (new: the developer-facing architecture reference)

#### 5. Git Information
**Branch:** `worktree-perflow-manager`  
**Commit:** `ac7f302` (committed 2026-11-23 at the owner's request, rebased onto `main` `dfd1fbd`)  
**Base Branch:** `main` @ `e9cc8ae`

#### 6. Testing
**Tests Executed:**
- `npm test` at `a54858c` (app code identical at `e9cc8ae`)
- `npm run test:electron` at `a54858c`, run twice

**Results:**
- `npm test`: 126/126 pass.
- `npm run test:electron`: EXIT=1 on both runs (see PF-004).

#### 7. Outstanding Issues
- Not investigated: `npm audit`, performance at scale, packaging and installer, the Office conversion script.
- Claude B identity unconfirmed (blocker B-2).

#### 8. Required Next Action
The owner: review the audit, approve the priorities, confirm Claude B, decide on ADR-001 to ADR-003 and on
PF-009 and PF-013, and approve committing these docs.

#### 9. Review Result
**Reviewer:** Project Owner  
**Decision:** PENDING

---

### HO-003 — Learning System architecture and specification

**Date:** 2026-11-23  
**Task ID:** LS-001 (spec), LS-002–LS-030 (planned)  
**From:** Claude A  
**To:** Project Owner (then Claude B)  
**Status:** PENDING (owner review)

#### 1. Assignment / Summary
Owner brief "Perflw Learning System": verify the current state, then produce the product and technical
specification, data model, mastery methodology, integration plan, roadmap and task queue. No application code
changed.

#### 2. Context
The brief cites "Claude B's HO-002 audit". **Correction (same day):** the first version of this entry said no
Claude B entry existed; it does (commit `e3412ce`, see HO-005). Claude A's search had missed that branch.

#### 3. Work Completed
- `docs/LEARNING_SYSTEM_SPEC.md` (new): verified audit (§1), journey + flow diagram (§2), UI/UX and components
  (§3), assessment engine (§4), mistake categories and mastery method with worked example (§5), data model + ER
  diagram + IPC contract + migration strategy (§6), integration (§7), roadmap (§8), owner decisions D1–D5 (§9).
- `ARCHITECTURE_DECISIONS.md`: ADR-004 to ADR-008 added as PROPOSED.
- `TASK_QUEUE.md`: LS-001–LS-030 with dependencies and acceptance; LS-002 fully specified.
- `PROJECT_STATUS.md`: learning status and next priorities updated.

Key findings: no quiz/journey/session/mastery code exists (`src/learning.js:5`, placeholders `:156-160`);
subject mastery % and time are manual inputs (`:830-834`); reusable: topics, deterministic analysis
(`learning-intel.js`), grounded Ask, agent pattern (`learning-agents.js`), `runAgent`, `saveFocusEntry` (object
args), `events`.

#### 4. Modified Files
- docs/LEARNING_SYSTEM_SPEC.md (new)
- coordination/ARCHITECTURE_DECISIONS.md, TASK_QUEUE.md, PROJECT_STATUS.md, HANDOFF_LOG.md

#### 5. Git Information
**Branch:** `worktree-perflow-manager` · **Commit:** `ac7f302` (with the HO-002 docs, rebased onto `main` `dfd1fbd`)

#### 6. Testing
Documentation only; no tests run. Code claims are cited by file and line at `e9cc8ae`.

#### 7. Outstanding Issues
- [assumption] the `learning` planner kind has no UI writer today; verify before LS-027.
- Mastery thresholds are starting values, not validated with students (D4).
- Claude B still unconfirmed (B-2).

#### 8. Required Next Action
Owner: review the spec; decide D1–D5 and ADR-004–008; approve committing the docs. Then Claude A assigns PF-004,
then LS-002, to Claude B.

#### 9. Review Result
**Reviewer:** Project Owner  
**Decision:** APPROVED IN PRINCIPLE (2026-11-23): D1–D5. Conditions: finalize the spec, explicit dependencies and
acceptance for all tasks, keep the migration gate, one task at a time, no database changes yet. Addressed in HO-005.

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
**Decision:** APPROVED — reviewed by Claude A in HO-006; integrated by the project owner in merge `dfd1fbd` (2026-11-23).

---

### HO-005 — Spec finalized; Claude B HO-002 acknowledged; assignment plan

**Date:** 2026-11-23  
**Task ID:** LS-001, PF-004, PF-006, LS-002  
**From:** Claude A  
**To:** Project Owner, Claude B  
**Status:** PENDING (owner: confirm remaining ADRs and approve committing the docs)

#### 1. Summary
Applied the owner's decisions D1–D5 and conditions; acknowledged Claude B's familiarization entry; checked PF-004
status.

#### 2. Work Completed
- `docs/LEARNING_SYSTEM_SPEC.md`: status approved in principle; §1.1 corrected; new §1.5 (Claude B findings →
  design rules); D3 `review` state in the question model and table; D4 configurable versioned thresholds and a
  validation-through-use checkpoint; D2 preservation of historical manual values; delivery rules and decision table
  (§8–9).
- `TASK_QUEUE.md`: gates G1–G3; standard acceptance S1–S6; all 30 LS tasks with explicit dependencies and checkable
  acceptance criteria; PF-006 fully specified; PF-004 marked IN PROGRESS; PF-016–PF-019 added from Claude B's
  findings.
- `ARCHITECTURE_DECISIONS.md`: ADR-002 and ADR-006 accepted in principle; ADR-007 D3 part accepted; §6 table.

#### 3. Claude B HO-002 (commit `e3412ce`, branch `claude/caveman-mode-ac59fd`) — acknowledgment
**Decision:** ACKNOWLEDGED. Verified by Claude A: `main.js:166` error filter, `main.js:507` cancelAsk without
`requireUser()`, `renderer.js:66-70` motion naming, `workspace.js:190` double ALTER, `renderer.js:1457` page list
without Analytics/Activities. Not re-verified: the CSS line numbers in §4.7, the 14 unexposed workspace functions,
the providers idle-timeout (§4.9). Outcomes: §4.2 → PF-006; §4.4 → PF-016; §4.5 → PF-017; §4.7 → PF-018;
§5 → PF-019; §4.1/§4.6 → spec §1.5 and ADR-005. Claude B's note that `learning.js:4-5` calls topics "not built" is
correct (topics exist); quizzes, journeys and study-session records do not.
**Numbering collision:** both entries are HO-002. Proposed: at integration, Claude B's entry becomes **HO-002B**;
the owner or integration process decides.

#### 4. PF-004 review status
Not reviewable yet: branch `fix/PF-004-smoke-pdf` (Claude B's worktree) is at `e9cc8ae` with no commits as of this
entry. Claude A will review on submission against PF-004's criteria (root cause with evidence; 3 consecutive
`test:electron` exit 0; `npm test` green).

#### 5. Assignment plan (one task at a time)
PF-004 (in progress) → review → PF-006 → review → LS-002 → review → next per the critical path. No database change
before PF-006 is approved and merged. *(Superseded by HO-006: PF-007 inserted before PF-006.)*

#### 6. Blocker
These coordination files are uncommitted in Claude A's worktree; **Claude B cannot read the PF-006/LS-002 specs**
until they are committed and merged into `main` (or otherwise shared). Needs owner approval.

#### 7. Review Result
**Reviewer:** Project Owner  
**Decision:** PENDING

---

### HO-006 — Review of PF-004 (Claude B, branch `fix/PF-004-smoke-pdf`) and PF-007 urgency

**Date:** 2026-11-23  
**Task ID:** PF-004, PF-007  
**From:** Claude A  
**To:** Project Owner, Claude B  
**Status:** COMPLETE (review) · PF-004 ready for owner integration

> Numbering: Claude B's PF-004 submission is **HO-004** on its branch. Claude A's uncommitted entries were renumbered
> (spec finalization is now HO-005; this review is HO-006) so the merge does not collide.

#### 1. Scope reviewed
Commits `3b8f738` (test changes) and `f2006fa` (handoff), base `e9cc8ae`. `git diff --stat e9cc8ae
fix/PF-004-smoke-pdf`: `test/electron-smoke.js` +14/−1, `test/learning-state-io.test.js` +76 (new),
`coordination/HANDOFF_LOG.md` +126. No `src/`, `package.json` or `package-lock.json` change.

#### 2. Findings against the review requirements
| # | Requirement | Finding | Evidence |
|---|---|---|---|
| 1 | Complete diff, both commits | Read in full. Matches the commit messages and the handoff. | `git show 3b8f738 f2006fa` |
| 2 | Startup preflight appropriate | **Yes.** It checks the exact file the renderer imports (`src/learning-pdf.js:23` → `../node_modules/pdfjs-dist/build/pdf.min.mjs`), resolves `appDir` the same way the launcher does (`PERFLW_ELECTRON_APP_DIR`, used at `:58`), is skipped for packaged builds (`PERFLW_ELECTRON_EXE`, `:42`), and runs before the temp folder is created. Test-only; product unchanged. Observed: in a copy without `node_modules` it exits 1 at once with the "Run npm ci" message. Minor, non-blocking: it does not also check `pdf.worker.min.mjs` (`:24`). | Claude A run |
| 3 | TODO tests document the Windows issue | **Adequate.** Both fail for exactly the stated reason in 3/3 runs by Claude A (`pending` stays `pending`; the first document reads back `pending` after one busy read). They simulate the OS error by patching `fs` (deterministic; restored in `t.after`; `node --test` isolates files in separate processes). The real-OS probe is described in the header and handoff but not committed; acceptable. Test 1 also fixes a design requirement for PF-007 (an unsaved status must not stay `pending`), now written into ADR-003 item 4. Not covered (added to PF-007): preferences and agent registry. | `node --test test/learning-state-io.test.js` ×3 |
| 4 | No assertions or timeouts weakened | **Confirmed.** The only change inside an existing function is extra diagnostic text in `waitFor`'s error; no wait condition, timeout value or assertion changed; no step removed. | diff |
| 5 | Handoff and test evidence | Handoff is specific and honest: `:581` root cause proven (2/2 reproduced, 5/5 fixed); `:582` mechanism proven, link to the original failure "plausible, not proven"; the intermittent `:1031` and `:609` failures are disclosed rather than hidden. Claude B's `pf004-evidence/summary.log` matches the handoff (3 × EXIT=0, `npm test` EXIT=0). | file read |
| 6 | Unintended changes / regressions | None found. Independent run on an exact export of the branch (`git archive`), with the main checkout's `node_modules` linked (electron 38.8.6, pdfjs-dist 5.4.296 = lockfile): `npm test` EXIT=0 (128 tests: 126 pass, 0 fail, 2 todo); `npm run test:electron` EXIT=0 ×3 consecutive (01:39:45Z, 01:40:41Z, 01:41:39Z). | Claude A run |

**Limits of this review:** not a fresh `npm ci` (linked install of identical versions); 3 smoke runs cannot rule out the
~1-in-11 `:1031` flake; the original `:582` failure is explained by mechanism, not observed again.

**Note on the original failure:** Claude A's audit worktree has no `node_modules`, which explains the `:581` failure
in the audit runs. It does not explain run 1's `:582` timeout (the viewer step had passed); that remains the
held-file hypothesis.

#### 3. Decision
**APPROVED** against PF-004's criteria: root cause stated with evidence (`:581` proven; `:582` mechanism reproduced
and handed to PF-007); 3 consecutive smoke passes (Claude B and Claude A independently); `npm test` green; committed
on the specified branch. Follow-ups, not conditions: PF-020 (fixed-wait flakes), PF-007 (the product defect), and
`docs/ARCHITECTURE.md` §3: "every worktree runs `npm ci` before `npm run test:electron`" (Claude A, with the next
docs commit).

#### 4. Integration (owner)
`fix/PF-004-smoke-pdf` is 2 commits directly on `e9cc8ae` (current `main`), so it merges cleanly. Suggested:
`git merge --no-ff fix/PF-004-smoke-pdf` in the main checkout, then `npm test`. Expected conflict: none in `main`.
Claude A's uncommitted coordination edits will be reconciled on top of the merged `main` before they are committed
(Claude B's HO-004 kept as-is; its Review Result set to APPROVED with a pointer here).

#### 5. PF-007 urgency
- **Severity: high.** Silent loss of user-created content: the subject's `state.json` (document entries and saved
  notes) and, by the same pattern, the learning preferences file and agent registry. The trigger is not exotic on
  Windows: antivirus and the search indexer open newly written files. The loss is silent: no error is shown.
- **Likelihood: unknown, plausible.** Reproduced mechanically; not yet observed in a user's data. One unexplained E2E
  timeout fits it.
- **Fix size: small, contained** (one new module, I/O lines in four files); no schema change; **no file overlap with
  PF-006** (`workspace.js`/`auth.js`).
- **Recommendation:** raise PF-007 to **P0** and run it **next, before PF-006**: it fixes a live data-loss risk in
  the shipped product, whereas PF-006's main risk applies to future schema changes (none happen before LS-005).
  It also turns PF-004's todo tests into real regression tests, and the Learning System's note files (LS-016)
  depend on it. New order: PF-004 ✔ → **PF-007** → PF-006 → LS-002.
- **Needs:** owner approval of ADR-003 (amended with the Windows retry and read rules).

#### 6. Required Next Action
Owner: merge PF-004; approve ADR-003 (amended); confirm ADR-004/005/008; approve committing Claude A's docs.
Claude A then assigns **PF-007** to Claude B. LS-002 does not start until ADR-005 is confirmed and PF-006 is
approved.

---

### HO-007 — PF-007: Safe user-data file I/O on Windows

**Date:** 2026-11-23  
**Task ID:** PF-007  
**From:** Claude B  
**To:** Claude A  
**Status:** SUBMITTED — awaiting review

> Approval: in chat on 2026-11-23 the project owner told Claude B to "merge the fix into main and stop notes from
> vanishing". Claude B took that as approval of PF-004 integration and of ADR-003 (amended) / PF-007. Claude A
> should confirm the ADR-003 status change in `ARCHITECTURE_DECISIONS.md`. Numbering: HO-005/HO-006 are Claude A's
> uncommitted entries, so this entry is HO-007.

#### 1. Summary

Before this change, a user-data file briefly held by another program (antivirus, search indexer, backup) could:
- leave a file stuck on "Analyzing this file…";
- make the app read a subject's `state.json` as empty and overwrite it on the next save, losing document entries and saved notes;
- do the same to learning preferences and the agent registry.

Now:
- writes are retried;
- a read that still fails throws, and is never taken as "empty";
- an unsaved analysis status is kept in memory.

Spec followed: PF-007 and ADR-003 amendment items 1–4, as drafted in Claude A's `perflow-manager` worktree (uncommitted there).

#### 2. Integration done before this task

`fix/PF-004-smoke-pdf` was merged into `main` in the main checkout:
- Command: `git merge --no-ff`, giving merge commit `dfd1fbd`.
- Instruction: the owner's, in chat. Nothing was pushed.
- Check: `npm test` on `main` after the merge exited 0 (128 tests, 126 pass, 2 todo).

#### 3. Work Completed

- **New `src/safe-file.js`:**
  - `writeFileAtomic(file, data, { mode = 0o600, dirMode = 0o700 })`:
    - writes a temp file in the same folder (`wx`, random name), then `renameSync`;
    - retries on `EPERM`/`EBUSY`/`EACCES` with delays 10/20/40/80/150/200 ms (500 ms in total), waiting synchronously with `Atomics.wait`;
    - when the retries run out, deletes the temp file and throws a plain-language error that keeps `error.code`;
    - throws other errors at once.
  - `readJsonFile(file, fallback)`:
    - `ENOENT` returns `fallback`;
    - a held file gets the same retry, then the function throws (never `fallback`);
    - invalid JSON is moved aside to `<file>.corrupt-<ms>` and `fallback` is returned.
- **`src/learning-workflow.js`:**
  - `write`/`readJson` now delegate to the helpers.
  - New in-memory `unsaved` map (fileId → status): set when the pending or failed status can't be written, cleared after a successful save. `fileAnalysis` answers from it first (ADR item 4).
  - Read-modify-write callers now stop when the read throws (item 3): `loadState`, `preferences`/`saveLearned`/`deletePreference`, and the notes paths. They needed no other change.
- **`src/learning-agents.js`:** the registry (`agents.json`) is read with `readJsonFile` (busy → throws, so no duplicate agents and no lost ids). It is written with `writeFileAtomic`, where before it was written in place. `fs` is no longer required.
- **`src/automation/packages.js`:** `writeAtomic` now delegates to `writeFileAtomic`, so it gains the retry. On POSIX, new folders get `0o700`; on Windows nothing changes.
- **`src/main.js`:**
  - Annotations are written with `writeFileAtomic`. Before, a fixed `.tmp` name and no file mode.
  - The session token (`persistToken`) is written with `writeFileAtomic`. This was a trivial swap: same temp-and-rename, `0o600`, plus the retry.
  - `learning:annotations` now reads with `readJsonFile`: a held file throws instead of returning "no marks".
- **`src/learning-annotate.js`:**
  - If marks can't be loaded, saving is switched off for that file (`S.unreadable`) and a toast says so. An empty set never overwrites the saved marks.
  - Why this is in scope: the main-process throw alone was not enough, because the renderer turned any load error into empty data and saved over it 350 ms after the next mark. It is the same defect class as `state.json`, in a file PF-007 already touches.
- **Tests:**
  - New `test/safe-file.test.js`, 9 tests: write, mode, retry then success, retries exhausted (throws, keeps the old file, no `.tmp`, bounded time), other errors not retried, `ENOENT` fallback, short busy read retried, busy read throws for all three codes, invalid JSON moved aside.
  - `test/learning-state-io.test.js`: `todo` removed from both PF-004 reproducers. New tests: preferences (a busy read throws and the file is unchanged) and agent registry (a busy read rejects, the file is unchanged, and the same agent ids come back afterwards).

#### 4. Architecture decisions followed

- ADR-003 (amended), items 1–4.
- PF-007 restrictions: no schema change, no new dependency, no file format or location change, `workspace.js`/`auth.js` untouched.

#### 5. Modified Files

- `src/safe-file.js` (new)
- `src/learning-workflow.js`
- `src/learning-agents.js`
- `src/automation/packages.js`
- `src/main.js` (I/O lines only)
- `src/learning-annotate.js` (load and save guard only)
- `test/safe-file.test.js` (new)
- `test/learning-state-io.test.js`
- `coordination/HANDOFF_LOG.md` (this entry)

#### 6. Git Information

**Branch:** `fix/PF-007-safe-file-io` (from `main` at `dfd1fbd`)  
**Commit:** the commit that adds this entry  
**Base Branch:** `main`

#### 7. Testing

All runs were captured as `cmd > log 2>&1; echo EXIT=$?`. Logs are in `pf007-evidence/` (git-ignored, local).

| Run | Result |
|---|---|
| `node --test test/safe-file.test.js` | 9/9 pass |
| `node --test test/learning-state-io.test.js` | 4/4 pass, 0 todo |
| Same 4 tests against the pre-fix `src/` from `main` (`git archive`) | 4/4 **fail**, so they really guard the fix |
| `npm ci` (clean) | 01:56:17Z EXIT=0 |
| `npm run test:electron`, run until 3 passes in a row (cap 6) | run1 EXIT=0 (67 s), run2 EXIT=0 (68 s), run3 EXIT=0 (64 s) |
| `npm test` | 02:01:18Z EXIT=0: 139 tests, 139 pass, 0 fail, 0 cancelled, 0 todo |

Not tested end to end: a real external program holding a file during the app run. That is covered only by the `fs` stubs and the PF-004 OS probe. The annotation load guard is checked by reading the code and by the smoke run's annotation steps passing; there is no unit test for it, because the renderer modules have no unit harness.

#### 8. Known limitations and remaining risks

1. **Main-thread pause.** A held file can block the main process for up to ~0.5 s per write or read, by design (ADR-003 trade-off). A file held longer still fails, now visibly.
2. **Status kept only in memory.** The status in `unsaved` is lost on restart. Afterwards the file shows its last saved status.
   - *Corrected after HO-008.* The first version said a stored `pending` "is re-queued when opened (existing behavior)". That was wrong: `fileAnalysis` returned it unchanged, so the file stayed on "Analyzing…" forever.
   - Fixed in the revision (section 11): a stored `pending` with no job behind it is now queued again when the panel asks for it.
   - A stored `failed` is still shown as failed until the student re-analyzes it.
3. **A failed read now raises an error in places that used to return empty data.** The notes panel, Ask, preferences and annotations now show "…another program is using it. Try again in a moment." for a file still held after 0.5 s. That is intended, but it is a visible change.
4. **Damaged JSON files are moved aside and kept** as `*.corrupt-*`. Nothing cleans them up yet.
5. **Readers not switched to the helpers (out of scope):** the image cache, doc JSON and preview reads use the workflow's `readJson`, so they are covered. Other `readFileSync` + `JSON.parse` sites in `src/automation/` (package config, skills) were not audited here. Suggest a follow-up grep in PF-014.
6. **Smoke flakes outside this task** (`:620`, `:1031`, PF-020) did not occur in this batch, but they are not fixed.

#### 9. Required Next Action

Claude A:
- review `fix/PF-007-safe-file-io`;
- record ADR-003 as ACCEPTED (owner approval in chat);
- commit Claude A's pending coordination and docs work on top of `main` (now `dfd1fbd`);
- assign the next task (planned: PF-006).

#### 10. Review Result

**Reviewer:** Claude A  
**Decision:** APPROVED WITH MINOR CHANGES (HO-008). Revision below, awaiting delta review.

#### 11. Revision for HO-008 (same branch, new commit, no rebase)

**Change 1: a stored `pending` is re-queued** (`src/learning-workflow.js`)
- New `analyzing`: the file id that `run()` is reading right now. It is set after the job leaves the queue and cleared after the result is emitted, and in `finally`.
- New `idleFile(id)`: true when the file is neither queued nor being read now.
- `fileAnalysis` now calls `queueFile` when:
  - the stored status is `pending` and `idleFile` is true (new);
  - there is no entry (existing behavior, now guarded by `idleFile`);
  - the doc or analysis is missing (existing behavior, now guarded by `idleFile`);
  - the analysis version is old (this check now also skips the file being read).
- `queueFile` itself is unchanged. Explicit re-queues still run for the file being read: Re-analyze, and the Office preview's page refresh. Those carry new content.

**Tests** (`test/learning-state-io.test.js`, 2 new):
- A `pending` left in `state.json` with a fresh workflow instance, as after a restart: the panel shows `pending`, then the file ends `ready`.
- A file being analyzed while the panel asks 5 times: one finished analysis event, then `ready`.

Each test was checked against the bug it targets:
- Test 5 fails on `8475dcb`'s `learning-workflow.js` and passes now.
- Test 6 fails when the `analyzing` check is removed from `idleFile` and passes now.

**Change 2:** section 8 item 2 above is corrected.

**Checks after the revision** (logs in `pf007-evidence/rev1-*`): see the table added below.

| Run | Result |
|---|---|
| `node --test test/learning-state-io.test.js` | 6/6 pass, 0 todo |
| `npm test` (02:37:45Z) | EXIT=0: 141 tests, 141 pass, 0 fail, 0 todo |
| `npm run test:electron`, 1st run (02:34:21Z) | **Failed** at `:949` "Plan group hides Calendar, the date card and Routine only" (sidebar group measured after `sleep(250)`). This is the fixed-wait flake Claude A also saw (PF-020). The revision does not touch the sidebar. |
| `npm run test:electron`, 2nd run (02:35:51Z) | EXIT=0, "Electron smoke test passed." |

**Correction to earlier recorded exit codes.**
- *What went wrong.* Some of Claude B's single-command records used `echo "… $(date …) EXIT=$?"`. The `$(date)` runs first and resets `$?` to 0, so the printed exit code was always 0. That is how the 1st smoke run above was first logged as EXIT=0 despite failing.
- *Records affected:*
  - HO-004's acceptance `npm test` line (01:33:24Z);
  - HO-007's `npm ci` (01:56:17Z) and `npm test` (02:01:18Z) lines.
- *Records not affected.* Every smoke batch saved `e=$?` before `echo`, so those exit codes are real.
- *Evidence for the affected records.* Their logs show the real outcomes:
  - the two `npm test` logs say `# fail 0` (126 and 139 pass), and `node --test` exits non-zero on any failure;
  - the `npm ci` log has 0 `ERR!` lines and ends "added 176 packages".
- *Re-measured.* `npm test` was re-run with `e=$?` captured first (row above). Its exit code is measured, not inferred.

---

### HO-008 — Review of PF-007 (Claude B, branch `fix/PF-007-safe-file-io`, commit `8475dcb`)

**Date:** 2026-11-23  
**Task ID:** PF-007  
**From:** Claude A  
**To:** Claude B, Project Owner  
**Status:** COMPLETE (review) · **APPROVED WITH MINOR CHANGES**

> Numbering: Claude B's submission is HO-007 (on its branch). This review is HO-008.

#### 1. Scope reviewed
Full diff `main..fix/PF-007-safe-file-io` (9 files, +375/−45): `src/safe-file.js` (new), `learning-workflow.js`,
`learning-agents.js`, `learning-annotate.js`, `automation/packages.js`, `main.js`, `test/safe-file.test.js` (new),
`test/learning-state-io.test.js`, HO-007. No schema, dependency, file-format or location change; `workspace.js` and
`auth.js` untouched.

#### 2. Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| `safe-file` behaves as ADR-003 items 1–2 (retry then success; exhausted → throws, no `.tmp`, old file kept; `ENOENT` → fallback; busy read throws for EBUSY/EPERM/EACCES; invalid JSON moved aside; mode `0o600` off Windows) | **Met** | Code read; 9 unit tests read and passing |
| Both PF-004 reproducers pass without `todo` | **Met** | Claude A run |
| Preferences and agent-registry busy reads do not wipe the file | **Met** | 2 new tests; read-modify-write stops on a throwing read (item 3) |
| Tests really guard the fix | **Met** | Claude A ran the 4 `learning-state-io` tests against `main`'s pre-fix `src/`: **4/4 fail**, as HO-007 states |
| `npm test` exit 0, 0 todo | **Met** | Claude A: EXIT=0, 139 tests, 139 pass, 0 todo |
| `npm run test:electron` exit 0 | **Met by Claude B (3/3); not reproduced 3-in-a-row by Claude A** | Claude A, 6 runs on an exact branch export (linked install, lockfile versions): pass, **fail**, pass, pass, **fail**, pass. Failures: `:949` "Plan group hides Calendar…" (sidebar collapse measured after `sleep(250)`) and `:620`-class "collapsed column takes no width" (measured after `sleep(450)`). Neither step involves file I/O or code PF-007 changed; both are fixed-wait steps (PF-020). Not a PF-007 regression by inspection; not proven by an A/B run on `main`. |
| Committed, handoff written | **Met** | `8475dcb`, HO-007 |

Additional checks: no caller broken by readers that now throw: background callers run inside `enrich().catch`
and `run()`'s try. `learning-agents.js` has no remaining `fs` use. The annotation guard is sound: `flush()`
only sends when `save()` armed a timer, and `save()` refuses while `S.unreadable`. The scope extension to
`learning-annotate.js` is justified (same defect class, in a file PF-007 already touched).

#### 3. Required changes (small; re-review of the delta only)
1. **A stored `pending` status is never re-queued.** `fileAnalysis` (`src/learning-workflow.js:382`) returns
   `entry.status` when it is not `ready`, so a file whose final status could not be saved (or an app quit
   mid-analysis) shows "Analyzing this file…" forever after a restart. PF-007's objective is that nothing is
   "left stuck". Fix: when the stored status is `pending` and the file is neither queued nor **currently being
   analyzed** (`run()` has already shifted the active job off `queue`, so track the in-flight file id), call
   `queueFile`. Add a unit test: a `state.json` with a `pending` entry and a fresh workflow instance →
   `fileAnalysis` leads to `ready`; and a test that a file being analyzed is not queued twice.
2. **Correct HO-007 §8 item 2.** It says a stored `pending` "is re-queued when opened (existing behavior)"; the code
   does not do that (see 1). Update the entry after the fix.

#### 4. Non-blocking notes (no change needed in PF-007)
- `restoreToken` (`main.js`) still reads with a swallowed `fs.readFileSync`: a held session file signs the user out
  for that start (no data loss). Leave as is; noted for PF-014.
- `*.corrupt-*` files are never cleaned up (HO-007 §8.4). Acceptable; they are rare and are recovery data.
- Other `readFileSync`+`JSON.parse` sites in `src/automation/` are unaudited (HO-007 §8.5) → PF-014.
- **E2E reliability is lower than recorded:** Claude A saw 2 fixed-wait failures in 6 runs (PF-004 review: 0 in 3;
  Claude B: about 1 in 11). PF-020 gains the `:949` step and should be done before the first LS renderer task (gate G2
  depends on a trustworthy smoke run).

#### 5. Decision
**APPROVED WITH MINOR CHANGES.** Claude B makes changes 1–2 on the same branch as a new commit (no rebase). Claude A
reviews only that delta (unit tests + one smoke run). Then the owner merges. PF-006 is issued only after that
(HO-009).

---

### HO-009 — Assignment: PF-006 (versioned, transactional schema migrations with a backup)

**Date:** 2026-11-23  
**Task ID:** PF-006  
**From:** Claude A  
**To:** Claude B  
**Status:** **HELD**. Issued when PF-007 is APPROVED (after the HO-008 changes) and merged into `main`. One task
at a time. *Update: PF-007 APPROVED in HO-010.* **RELEASED 2026-11-23: PF-007 is integrated in `main` as
`5664f56`. PF-006 is ASSIGNED to Claude B** (a new desktop session in its own worktree, started by the orchestrator
session). Branch `refactor/PF-006-migrations` from `main` at `5664f56`. Brief = this entry + `TASK_QUEUE.md`
"TASK: PF-006". Report back with a HANDOFF entry (next free number at the time; HO-012 if none is added before).

#### 1. Assignment
Implement PF-006 exactly as specified in `coordination/TASK_QUEUE.md` → "TASK: PF-006". ADR-002 is accepted in
principle (owner decision D1). This is **gate G1**: no Learning System table may exist before PF-006 is approved and
merged.

#### 2. Setup
- Branch `refactor/PF-006-migrations` from `main` **after** PF-007 is merged (so the baseline includes
  `safe-file.js`).
- Run `npm ci` in your worktree before `npm run test:electron` (CLAUDE.md §6).

#### 3. Key points (summary; the task spec governs)
- New runner (e.g. `src/db-migrate.js`): `PRAGMA user_version`, ordered `{ version, up(db) }` list, each migration in
  `BEGIN IMMEDIATE … COMMIT`, `ROLLBACK` on error with a plain-language message.
- **Migration 1 = today's schema**, idempotent for every existing install; includes the tables
  `createAutomationStore`/`createSessionStore` create. Fix inside it: the `planner_items` rebuild runs in the
  runner's transaction (`workspace.js:140-154`); the two `subject_files` columns are guarded separately
  (`workspace.js:190`).
- Backup before the first pending migration on an existing DB (e.g. `VACUUM INTO`, proven under `node:sqlite` by a
  test first); keep the newest 3; never touch the live file otherwise.
- Same runner for `accounts.sqlite`.
- **Out of scope:** any learning table (that is LS-005), any other schema change, any new dependency.

#### 4. Acceptance
As listed in the PF-006 task spec: fresh install = today's schema at v1 (compared against a fixture generated from
`main`); three old-install fixtures upgraded with rows preserved; injected failure rolls back and leaves a usable
backup; second start is a no-op; backups pruned to 3; `npm test` and `npm run test:electron` exit 0; commit on
`refactor/PF-006-migrations`; HANDOFF entry; `docs/ARCHITECTURE.md` §2 updated.

#### 5. Restrictions
Do not touch files outside `workspace.js`, `auth.js`, the automation store/session modules (only if their DDL
moves into migration 1), the new runner and its tests/fixtures. Report anything else before changing it. Smoke
flakes at `:620`, `:949`, `:1031` are known (PF-020); report them, do not fix them in PF-006.

---

### HO-010 — Delta re-review of PF-007 (commit `b545f18`, branch `fix/PF-007-safe-file-io`)

**Date:** 2026-11-23  
**Task ID:** PF-007  
**From:** Claude A  
**To:** Claude B, Project Owner (desktop orchestrator session)  
**Status:** COMPLETE (review) · **APPROVED**

> Numbering: Claude B's branch contains HO-001, HO-004 (from `main`) and HO-007 only; no HO-010 exists there. This
> branch has HO-002, 003, 005, 006, 008, 009. HO-010 is free. See §6 for the merge conflict this file will have.

#### 1. Scope reviewed (delta only, per HO-008 §5)
`git diff 8475dcb..b545f18`: `src/learning-workflow.js` (+12/−4), `test/learning-state-io.test.js` (+42/−3),
`coordination/HANDOFF_LOG.md` (HO-007 §8.2 correction, §11 revision). `package.json`/`package-lock.json` unchanged
since `main` `dfd1fbd`.

#### 2. Required changes (HO-008 §3)
| # | Change | Result | Evidence (code read) |
|---|---|---|---|
| 1 | Stored `pending` re-queued when idle; no double queue | **Met** | `fileAnalysis` re-queues when `entry.status === 'pending' && idleFile(id)`. `idleFile` = `analyzing !== id && !queue.some(...)`. `analyzing = fileId` is set right after `queue.shift()` and `topicFile()` with **no `await` between them**, cleared before `emit` and in `finally`. No `await` before the `while` loop either, so a poll can never see the file as "neither queued nor running" while its job is live. The missing-entry, missing-doc and old-`ANALYSIS_VERSION` paths now use the same guard. Explicit re-queues (`reanalyze` `:406`, doc update `:438`) bypass `idleFile` on purpose (new content), as HO-007 §11 states. |
| 2 | HO-007 §8 item 2 corrected | **Met** | The wrong "existing behavior" sentence is replaced and marked *Corrected after HO-008*. |

Tests added: (5) a stored `pending` with a fresh workflow instance (a restart) ends `ready`; (6) 5 polls while
the file is being read → exactly one finished `analysis` event. Both target the defect (Claude B reports 5 fails on
`8475dcb` and 6 fails without the `analyzing` check; not re-run by Claude A, since the code read shows both guards).

#### 3. Checks (Claude A, temporary detached worktree at `b545f18`, `node_modules` linked from the main checkout)
| Check | Time (UTC) | Result |
|---|---|---|
| `node --test test/learning-state-io.test.js test/safe-file.test.js test/learning-workflow.test.js` | 04:32:43Z | **PASS**, EXIT=0, 37/37, 0 todo (tests 5 and 6 listed as `ok`) |
| `npm test` | 04:34:22Z | **PASS**, EXIT=0, 141 tests, 141 pass, 0 fail, 0 todo |
| `npm run test:electron`, run 1 | 04:34:29–04:35:31Z | **PASS**, EXIT=0 |
| `npm run test:electron`, run 2 | 04:35:31–04:36:30Z | **PASS**, EXIT=0 |
| `npm run test:electron`, run 3 | 04:36:30–04:37:27Z | **PASS**, EXIT=0 |
| `git status` in the review worktree after the runs | — | clean |

Exit codes were saved with `e=$?` right after each command (the HO-007 §11 pitfall does not apply).

**Smoke stability:** 3/3 here. Together with HO-008 (6 runs, 2 fixed-wait failures) that makes 7 passes in 9 runs
on this branch's code. 3 in a row does not prove the `:620`/`:949` flakes are gone; PF-020 stays open and stays a
precondition for the first LS renderer task (gate G2).

#### 4. Non-blocking notes
None new. HO-008 §4 notes stand (PF-014, PF-020).

#### 5. Decision
**APPROVED.** PF-007 → APPROVED in `TASK_QUEUE.md`. Integration is the owner's (the desktop orchestrator session
merges `fix/PF-007-safe-file-io` into local `main` with `--no-ff`, per the owner's decision of 2026-11-23). Status
becomes INTEGRATED only after that merge is recorded. HO-009 (PF-006) is released after the merge, not before.

#### 6. Merge note for `worktree-perflow-manager` (docs)
Trial merges with `git merge-tree` (no refs changed): each branch merges cleanly into `main` alone; whichever is
merged **second** conflicts in `coordination/HANDOFF_LOG.md` only (both branches insert entries after HO-001).
The HO numbers do not clash. Resolution: keep both sides and order entries by number
(HO-001 … HO-006, Claude B's HO-007, HO-008 …). Proposal: merge PF-007 first; then Claude A merges `main` into
`worktree-perflow-manager`, resolves this one file, and commits. The owner's later merge of the docs branch is then
conflict-free.

---

### HO-011 — Owner's learning-loop diagram mapped onto `docs/LEARNING_SYSTEM_SPEC.md`

**Date:** 2026-11-23  
**Task ID:** LS-001 (spec)  
**From:** Claude A  
**To:** Project Owner (through the desktop orchestrator session)  
**Status:** **ANSWERED** 2026-11-23 (§3). Folded into the spec as D6–D11, plus D12 (UI). 5 follow-up questions in
spec §9.1, answered 2026-11-23 as D13–D17.

#### 1. Mapping (spec §2.1 flow, §2.2 stages)
| Owner's diagram | Spec | Fit |
|---|---|---|
| Pre Test | Stages 4–5 (setup, pre-test; kind `diagnostic`) | Defined |
| Analyze mistakes / weaknesses | Stage 6 Diagnostic (per topic and dimension, mistake categories, weak topics ranked) | Defined |
| Targeted notes | Stage 7 (one note per weak topic, `learning_materials`) | Defined |
| Side notes | Mentioned only inside stage 8 ("session bar … side notes"); no definition, storage or relation to annotations or saved notes | **Gap** |
| Learn through main file | Stage 8 Main learning (existing viewer + session bar) | Defined |
| "Quest and journey" (data showing whether the student really learns) | **"Quest" does not appear in the spec.** "Journey" is the whole cycle (stages 2–16), not a step. The closest evidence step is stage 9 Practice + stage 10 Mistake analysis | **Gap / naming conflict** |
| Analyze | Stage 10 Mistake analysis | Defined |
| Notes | Stage 11 Supplementary learning (extra notes, back to practice) | Defined |
| Final Learning | Stage 12: optional review (targeted notes + flagged mistakes); one table row only | **Partly defined** |
| Final Exam | Stage 13 + spec §4: kind `final`, parallel items, no feedback until submit, weight 1.0; "Mastered" needs final ≥ 0.8 and a retention check | **Partly defined**: no length, time limit, pass mark for the exam itself, retake or fail path |
| Next cycle → Pre Test | Stage 16 → new journey (stage 2) pre-filled with unmastered topics → a new pre-test | Defined, but differs: see question 6 |
| — (not in the diagram) | Stage 14 Mastery report, stage 15 Retention check (≥ 7 days) | Spec has extra steps |

#### 2. Questions for the owner
1. **Quest:** what is a quest? (a) a targeted practice set that produces graded evidence (the spec's Practice),
   (b) a mission of study tasks per weak topic (read X, write a note, answer N questions), (c) a game layer
   (streaks, XP, rewards), or something else?
2. **Journey:** is "journey" the whole cycle (as in the spec) or a step after main learning?
3. **Side notes:** are they the student's own notes beside the file while reading, AI notes, or both? Are they
   separate from targeted notes and from PDF annotations?
4. **Final Learning:** required or optional? What does it contain beyond targeted notes and flagged mistakes?
5. **Final Exam:** how many questions, time limit or not, the pass mark, whether retakes are allowed, and what
   happens on a fail (back to practice, or the cycle still closes)?
6. **Next cycle:** does it start with a fresh Pre Test, or does the Final Exam result count as the next cycle's
   pre-test? Which topics: only the unmastered ones (spec) or the student's choice?
7. **Spec extras:** keep the Mastery report and the delayed Retention check (≥ 7 days) that are not in the diagram?

#### 3. Owner answers (verbatim, relayed by the desktop orchestrator session, 2026-11-23)
1. Quest: "(a) for now and (c) for something more adventure feeling"
2. Journey: "I think we can make it step by step at the time and progress along the way"
3. Side notes: "I think both would be cool and convenient, but majority of the note must be from use rather than ai,
   the the ai scan those notes and aid/help them in building and fully understanding the note. Yes they are sperate
   from weakness notes and pdf highlights"
4. Final Learning: "required to give total evaluation in statistical evaluation."
5. Final Exam: "user's can make a range with in 50-100, yes provide a solid and valid time depending on how hard the
   questions and how many items there is, passing mark would be 75-90% above depending on how hard it is, retakes are
   allowed if you review the entire study load of that topic, so we can compare the difference in changes and
   advancement in learning"
6. Next cycle: "its optional if user wants to proceed, if no then keep it that way, if yes, reset his statistic
   regarding that topic, it cover anything it should be flexible either ways"
   - Follow-up: asked whether "reset" means a soft reset (new cycle starts at 0, old cycle kept as history), the
     owner answered "yes".
7. Not answered; the spec keeps the Mastery report and the Retention check (D10's attempt comparison relies on the
   report).
- UI (separate question): "could we keep the over all ui design for this similar to what we currently have?" → D12.

#### 4. Result
Spec decisions D6–D12 (spec §9), new §4.9 (final exam rules, proposed formulas), §5.6 (final learning evaluation),
§5.4 scope = one cycle, §6.2 columns `assessments.attempt`/`retake_of`, `learning_materials.parent_material_id` +
kind `side_note_ai`. Tasks changed: LS-005, LS-006, LS-008, LS-012, LS-013, LS-022, LS-023, LS-024; new LS-031
(game layer, backlog), LS-032 (side-note AI help), LS-033 (final learning evaluation); S7 UI parity on 20 renderer
tasks. Unchanged: PF-006, LS-002 to LS-004.

---

### HO-012 — PF-006: Versioned, transactional schema migrations with a backup

**Date:** 2026-11-23  
**Task ID:** PF-006  
**From:** Claude B  
**To:** Claude A  
**Status:** SUBMITTED

#### 1. Understanding (stated before coding)
Replace the ad hoc schema bootstrap of `workspace.sqlite` and `accounts.sqlite` with one runner: version in
`PRAGMA user_version`, ordered `{ version, up(db) }` list, each step in `BEGIN IMMEDIATE … COMMIT`, `ROLLBACK` plus a
plain-language error on failure. Version 1 is today's schema exactly (the bootstrap moved, not changed), idempotent
for every pre-PF-006 install (version 0, any subset of old columns), including the tables the automation, session
and connection stores create. Inside v1 fix the two known defects (rebuild in the runner's transaction; each
`subject_files` column guarded on its own). Back up with `VACUUM INTO` before the first pending step on a file that
has tables, keep the newest 3, never touch the live file otherwise. No learning tables (LS-005), no other schema
change, no new dependency, no user-visible change.

#### 2. Summary of the implementation
- **`src/db-migrate.js` (new, 110 lines)**: `migrate(db, { name, migrations, backup, keep = 3, now })` →
  `{ from, to, backup }`. Validates the list (versions 1..n, `up` is a function). Re-reads `user_version` after
  `BEGIN IMMEDIATE` so a step another process already applied is skipped. On error: `ROLLBACK` if
  `db.isTransaction`, then throws "Perflw could not update its <name> data (step N of M). That step was undone, so
  your data is as it was before it. A copy from before the update is at <path>. (<cause>)" with `cause` set.
  A file whose version is newer than the list is left untouched (returns `from === to`, runs nothing).
- **Backup** (`backupDatabase`): `VACUUM INTO <file>.bak-v<from>-<yyyymmddThhmmssmmmZ>.tmp`, open it read-only,
  `PRAGMA quick_check` must be `ok`, then rename to the final name (a `-1`, `-2` … suffix if the name exists).
  A failed backup throws "Perflw could not make a safety copy of its <name> data before updating it, so nothing was
  changed. …" and no step runs. `pruneBackups` keeps the newest 3 by timestamp; only names matching
  `^<base>\.bak-v\d+-\d{8}T\d{9}Z(-\d+)?$` are considered. The live file is never written by these helpers.
- **`src/workspace.js`**: the bootstrap became `workspaceSchemaV1(db)` = `WORKSPACE_MIGRATIONS[0]`, statement for
  statement the same, with: `PRAGMA foreign_keys = ON` moved before `migrate` (it is a no-op inside a transaction);
  the `planner_items` rebuild without its own `BEGIN;`/`COMMIT;`; `preview_name` and `preview_status` each with
  their own guard; then `createAutomationSchema`, `createSessionSchema`, `createConnectionSchema` in the order the
  app ran them before. `createWorkspace(root, { migrations })` closes the DB and rethrows if migrating fails.
- **`src/auth.js`**: same pattern, `accountsSchemaV1` = `ACCOUNT_MIGRATIONS[0]`.
- **`src/automation/store.js`, `sessions.js`, `connections.js`**: DDL moved out of the store constructors into
  exported `create*Schema(db)` functions called only by workspace migration 1. Store logic unchanged.

**Tables in v1.** workspace (24): active_timers, agents, chat_defaults, chat_memory, chat_messages, chat_sessions,
documents, events, finance_accounts, finance_categories, finance_transactions, focus_entries, goals,
ledger_entries, milestones, planner_items, project_blocks, projects, provider_connections, subject_files,
subject_topics, subjects, tasks, workflows (+ 26 indexes; full SQL and columns in
`test/fixtures/schema/workspace-v1.json`). accounts (2): users, sessions (`accounts-v1.json`).

#### 3. Modified files
- `src/db-migrate.js` (new)
- `src/workspace.js`, `src/auth.js`
- `src/automation/store.js`, `src/automation/sessions.js`, `src/automation/connections.js` (DDL moved into v1)
- `test/db-migrate.test.js` (new, 13 tests)
- `test/fixtures/schema/generate.js` (new; regenerates the v1 fixtures from any `src/` tree)
- `test/fixtures/schema/workspace-v1.json`, `accounts-v1.json` (generated from `main` at `5664f56`, before the change)
- `test/fixtures/schema/workspace-pre-learning-kind.sql`, `workspace-pre-preview-name.sql`,
  `workspace-preview-name-only.sql` (old-install fixtures, readable SQL instead of binary files)
- `test/planner.test.js` (1 line, outside the HO-009 §5 list; reported here): its upgrade test rebuilt an old
  `planner_items` inside a file already stamped `user_version = 1`, so migration 1 no longer ran. Real pre-PF-006
  installs are at version 0; the fixture now sets `PRAGMA user_version = 0`. Assertions unchanged.
- `docs/ARCHITECTURE.md` §2 updated.
- `coordination/HANDOFF_LOG.md` (this entry).

#### 4. Git information
**Branch:** `claude/pf-006-migrations-3b8b79` (the orchestrator's worktree branch; HO-009 named
`refactor/PF-006-migrations`, which was not created)  
**Base:** `5664f56`, then fast-forwarded to `main` at `98f6453` (Claude A docs merge, docs only) before committing  
**Commits:** `6e65b6a` refactor(db) runner + migration 1 · `806aedc` test(db) tests and fixtures ·
`3a27d0e` docs(architecture) §2 · plus the commit adding this entry  
`git diff main...HEAD --check`: clean.

#### 5. Acceptance evidence
| Criterion | Evidence | Result |
|---|---|---|
| `VACUUM INTO` works under `node:sqlite` | test 1 (Node 22.22.2 / SQLite 3.51.2); also checked under Electron's Node 22.22.0 / SQLite 3.50.4 with `ELECTRON_RUN_AS_NODE=1`: copy opens, rows and `user_version` equal, `isTransaction` available, `user_version` rolls back | PASS |
| Fresh install → v1 both DBs, schema identical to `main` | test 2: `dumpSchema` (sqlite_master type/name/tbl_name/sql + `table_info`) deep-equals the fixtures generated from `5664f56`; also `generate.js` on the new `src/` gives byte-identical JSON | PASS |
| 3 old-install fixtures → v1, all rows kept, both preview columns | tests 3–5: every old row and column equal after upgrade; tables, indexes and per-column definitions equal v1; backup `bak-v0-*` holds the old rows; `createPlannerItem(kind:'learning')` works | PASS |
| Failure inside migration 1 rolls back the rebuild | test 6: old `planner_items` CHECK kept, no `planner_items_old`, rows equal, `user_version` 0; next start upgrades | PASS |
| Injected failure in migration 2 → stays v1, no open transaction, backup exists and opens | test 7 (via `createWorkspace`): v1, `should_vanish` absent, ghost row absent, `bak-v1-*` passes `integrity_check`, app reopens; test 8 (runner): `db.isTransaction === false`, same connection usable | PASS |
| Startup twice is a no-op | test 9: no new backup, schema equal, both DB files byte-identical (SHA-256) | PASS |
| Backups pruned to newest 3 | test 10: 4 old + 1 new → newest 3 remain; unrelated look-alike files and the live DB untouched | PASS |
| Same runner for `accounts.sqlite` | test 12 legacy accounts file → v1, rows kept, backup; existing `auth.test.js` legacy test still passes | PASS |
| Backup failure stops the upgrade | test 11: plain message, version 0, no table added, no open transaction | PASS |

#### 6. Testing (exit codes saved with `e=$?` right after each command)
| Command | Time (UTC) | Result |
|---|---|---|
| `node --test test/db-migrate.test.js` | 04:56Z | PASS, 13/13 |
| `npm test` | 04:58:01–04:59:36Z | **PASS**, EXIT=0, 154 tests, 154 pass, 0 fail, 0 cancelled, 0 todo (141 before + 13 new) |
| `npm run test:electron`, run 1 | 04:59:36–05:00:36Z | **PASS**, EXIT=0 |
| `npm run test:electron`, run 2 | 05:00:36–05:01:35Z | **PASS**, EXIT=0 |
| `npm run test:electron`, run 3 | 05:01:35–05:02:33Z | **PASS**, EXIT=0 |

`npm ci` was run first (EXIT=0). The runs used the working tree before the docs-only fast-forward to `98f6453`;
the code under test is byte-identical to the commits. The first `npm test` run (before the `planner.test.js`
fixture fix) had 1 failure, test 86, explained in §3. No PF-020 flake (`:620`, `:949`, `:1031`) occurred in these
3 runs; 3 passes do not prove it is gone.

#### 7. Limitations and open questions
1. `UPDATE projects SET updated_at=created_at WHERE updated_at=''` used to run on every start; now it runs once, in
   migration 1. No current writer inserts an empty `updated_at` (all inserts in `workspace.js` set it), so no
   visible change is expected.
2. A failed backup or migration now throws from `createWorkspace`/`createAuth` at startup. `main.js` does not catch
   it, so the app fails to start with the error instead of opening a half-migrated DB. Showing that message in a
   dialog is not in PF-006 scope; suggest a follow-up task.
3. First start after this change on an existing install writes one `workspace.sqlite.bak-v0-*` and one
   `accounts.sqlite.bak-v0-*` (full copies; disk use equals the DB size each).
4. A DB with a newer `user_version` than the app knows is opened as is (no error). Decision needed from Claude A:
   keep this (additive migrations, ADR-004) or refuse to open.
5. Branch name differs from HO-009 (`refactor/PF-006-migrations`); the orchestrator assigned this worktree branch.

#### 8. Required next action
Claude A: review against "TASK: PF-006" and decide on §7 items 2 and 4.

#### 9. Review result
**Reviewer:** Claude A  
**Decision:** PENDING

---

### HO-013 — Review of PF-006 (Claude B, branch `claude/pf-006-migrations-3b8b79`, tip `84741f0`)

**Date:** 2026-11-23  
**Task ID:** PF-006  
**From:** Claude A  
**To:** Claude B, Project Owner (desktop orchestrator session)  
**Status:** COMPLETE (review) · **APPROVED**

> Numbering: Claude B's submission is HO-012 (on its branch). This review is HO-013.

#### 1. Scope reviewed
`git diff main...claude/pf-006-migrations-3b8b79` (base `98f6453`; 16 files, +2748/−31): new `src/db-migrate.js`;
`src/workspace.js`, `src/auth.js` (bootstrap → migration 1); `src/automation/store.js`, `sessions.js`,
`connections.js` (DDL moved into `create*Schema` functions called by migration 1); `test/db-migrate.test.js`,
schema fixtures and generator; `test/planner.test.js` (1 line); `docs/ARCHITECTURE.md` §2; HO-012.
`package.json`/lockfile unchanged.

#### 2. Code review
- Runner: version check, `VACUUM INTO` backup to a temp name → `quick_check` → rename, prune only names matching the
  exact backup pattern, then per migration `BEGIN IMMEDIATE` → re-read `user_version` under the lock → `up` →
  `user_version` → `COMMIT`; on error `ROLLBACK` when `db.isTransaction` and a plain-language error. Sound.
- **`db.isTransaction` exists in Electron's runtime** (checked by Claude A: `ELECTRON_RUN_AS_NODE`, Node 22.22.0:
  `true` inside `BEGIN`, `false` after `ROLLBACK`). Without it the rollback would be skipped; it is not.
- Both known defects fixed inside migration 1: the `planner_items` rebuild has no own `BEGIN/COMMIT`; the two
  `subject_files` columns are guarded separately.
- Out-of-list files, both reported in HO-012 and justified: `connections.js` (same DDL move as the other automation
  stores) and `planner.test.js` (its old-install simulation must set `user_version = 0`; assertions unchanged).
- `provider_connections` is now created at startup rather than on the first `connectionStore()` call. The app calls
  it at startup anyway (`createEcosystem`), so the resulting schema is the same (fixture check below).
- HO-012 §7.1 verified: every `projects` insert sets `updated_at` (`workspace.js:236`, `:340` with a fallback to
  `created_at`), so running the empty-`updated_at` fix once is safe.

#### 3. Checks (Claude A, temporary detached worktree at `84741f0`, `node_modules` linked from the main checkout)
| Check | Result |
|---|---|
| Fixtures regenerated by Claude A from `main`'s own `src/` (`git archive main src`) vs the committed `workspace-v1.json`/`accounts-v1.json` | **PASS**: byte-identical |
| Branch fresh install vs `main` fresh install (same generator) | **PASS**: byte-identical for both DBs |
| Real upgrade: DBs created **by `main`'s code** with rows (planner incl. `learning`, plan, subject, connections), then opened by the branch | **PASS**: `user_version` 0→1 for both; all rows identical; one `bak-v0-*` per DB holding exactly the pre-upgrade rows; second start no-op (no new backup), no `.tmp` left |
| `node --test test/db-migrate.test.js test/planner.test.js` | **PASS**: 18/18, EXIT=0 |
| `npm test` (05:05:33Z) | **PASS**: EXIT=0, 154 tests, 154 pass, 0 fail, 0 todo |
| `npm run test:electron` ×3 (05:07:08–05:10:08Z) | **PASS, PASS, PASS** (EXIT=0 each) |

The orchestrator session also ran the branch on read-only snapshots of the owner's three data folders (accounts and
workspace v0→v1, rows kept, backups `quick_check` ok, second start no-op). Evidence it reported; not re-run here.

#### 4. Decisions on HO-012 §7
- **§7.2 startup failure:** keep the behavior (refuse to open rather than open a half-migrated DB; data is intact
  and the backup exists). Showing the message is a follow-up: **PF-021** (P1, before any release): catch the error in
  `main.js`, show a plain-language dialog, quit.
- **§7.4 newer `user_version`:** keep "open as is". It is safe while every migration is additive (ADR-004). Rule
  added to ADR-002: a future migration that is not purely additive must also make older app versions refuse the file.
- §7.3 (one backup per DB on first start) and §7.5 (generated branch name) accepted.

#### 5. Decision
**APPROVED.** PF-006 → APPROVED in `TASK_QUEUE.md`. The owner/orchestrator merges with `--no-ff` after `npm test` and
`npm run test:electron` on the merge result. After the merge, G1 is open: LS-005 may start (lane 3).

---

### HO-015 — LS-002: Assessment model (pure module)

**Date:** 2026-11-23  
**Task ID:** LS-002  
**From:** Claude B  
**To:** Claude A  
**Status:** SUBMITTED  
**Branch:** `claude/ls-002-assessment-model-9f8216` (session-generated worktree branch), base `main` at `243765c`  
**Commits:** `613ee4d` (module + tests); this entry in a docs commit on top.

#### 1. Understanding (stated before coding)
A pure, dependency-free `src/assessment-model.js` (no I/O, DOM, Electron, SQL or AI) that loads in Node via
`require` and in the renderer as `window.PerflwAssessmentModel` (same wrapper as `topic-model.js`). It is the one
contract for spec §4.2–4.7: validating and normalizing the five question types, normalizing responses, grading the
deterministic types, scoring open answers from rubric verdicts by code (ADR-007), seeded item selection with the D3
review filter, and a student view with no answer key (ADR-005). Released by the owner without the G3 wait. Not added
to `index.html` (LS-010 does).

#### 2. Files
- New: `src/assessment-model.js`, `test/assessment-model.test.js`. No other file changed (`package.json` glob
  `test/*.test.js` already picks the test up).

#### 3. API
- Constants: `TYPES`, `OPEN_TYPES`, `DIMENSIONS`, `KINDS`, `ORIGINS`, `STATUSES`, `REVIEWS`, `VERDICTS`
  (`met` 1, `partly` 0.5, `missing` 0), `LIMITS`.
- `validateQuestion(q) → { ok, value, errors[] }`. `value` is the normalized question when ok, else `null`. Unknown
  fields dropped; strings trimmed; errors read `"<field path>: <plain-language problem>."` (e.g.
  `payload.pairs[1]: the right item "r1" is paired more than once.`). Defaults: `origin 'manual'`,
  `status 'active'`, `review` = `'unreviewed'` for generated else `'approved'` (D3), `explanation ''`, `source []`,
  `provenance null` unless generated (then required: `provider`, `model`, ISO `generatedAt`; `agentId`,
  `promptVersion` optional). Points default: choice 1, true/false 1 (2 with justification), matching 1 per pair,
  essay/explain = rubric total; must end up 1–20. Payload-local ids (options, left/right, rubric) are normalized to
  strings; question-level ids keep their type (string ≤ 100 chars or non-negative integer).
- `normalizeResponse(question, raw) → { questionId, choice?, value?, justification?, pairs?, text?, dontKnow?,
  confidence?, timeMs }`. Keeps only the type's fields, drops ids the question lacks, first pair per left item wins,
  `text`/`justification` capped at 20,000 chars, `confidence` only 1–3, `timeMs` ≥ 0 capped at 24 h.
- `grade(question, response) → { score, max, status, category? , pendingPoints? }`. `status`: `'graded'` or
  `'pending'`. dontKnow → 0 + `not_known`; empty → 0 + `not_answered` (both `graded`, any type). Choice single exact
  match; multiple `max(0, (right − wrong) / correctCount) × points`; matching `points × hits / pairs`; true/false with
  required justification grades the value half now and returns `pending` with `pendingPoints` (a blank justification
  makes it `graded`, 0 for that half); essay/explain `pending`. Scores rounded to 2 decimals.
- `rubricOf(question) → criteria[]`: the open rubric, or for true/false-with-justification one criterion
  `{ id: 'justification', points: points/2 }`.
- `scoreFromCriteria(question, verdicts) → number`. `verdicts` is `[{ id, verdict }]` (AI output shape) or
  `{ id: verdict }`. Score = rubric share × Σ(criterion points × verdict factor) / Σ criterion points; share = the
  question's points (essay/explain) or the justification half (true/false). Missing/invalid verdict = 0.
- `selectItems({ questions, topics, count, types, dimensions, exclude, weakTopics, due, seed, kind }) → questions[]`.
  Filters: `status` active, not excluded, type/dimension/topic filters when given, D3 review rule (`practice`: not
  `rejected`; anything else, including a missing `kind`: only `approved`). `due` ids first. Round-robin over topics
  (given order, else first appearance): each round gives every topic one item, then weak topics a second (×2).
  Within a topic, a seeded order spread across dimensions; a diagnostic starts each topic with recall-or-higher when
  available. No `count` = all eligible.
- `stripAnswerKey(snapshot)`: a question, a list, or `{ ...fields, questions: [] }`. Whitelist copy; removes
  `correct`, `pairs`, `modelAnswer`, rubric `keywords`, and also `explanation`, `source` and `provenance`. Input
  unchanged.
- `shuffle(items, seed)`: FNV-1a seed hash + mulberry32 Fisher–Yates; new array, same seed → same order.

#### 4. Tests (`test/assessment-model.test.js`, 26)
Dual-load (require + vm browser global); valid question per type with defaults; unknown fields dropped; common-field
errors name the field; source refs; generated provenance + D3 review defaults; choice, true/false, matching,
essay/explain payload invalid cases; normalizeResponse caps and filtering; choice single; multiple partial credit
incl. floor at 0; true/false incl. justification pending; matching partial; essay/explain pending; dontKnow and
empty for every type; scoreFromCriteria (met/partly/missing, scaling, justification half); shuffle seeded/stable;
selectItems deterministic + covers every topic before repeating; dimension spread + diagnostic recall-first;
exclude/types/dimensions/status; D3 for diagnostic/final/retention/missing kind vs practice; practice due-first + weak
×2; stripAnswerKey deep check on in-progress diagnostic and final snapshots (all 5 types); student view keeps what is
needed, whitelist blocks unknown payload fields, copy independent.

#### 5. Results
- `npm test > log 2>&1; echo EXIT=$?` → `EXIT=0`, `# tests 167`, `# pass 167`, `# fail 0` (base `243765c`: 141).
- `npm run test:electron`: not run (no renderer change).

#### 6. Spec ambiguities and limitations (reported, not decided)
1. `id` is required by `validateQuestion`; AI/template questions must get an id before validation (store or coach).
2. Default points per type are not in the spec; chosen as in §3. Open questions whose points differ from the rubric
   total are scaled proportionally.
3. True/false justification: the payload has no rubric, so `rubricOf` synthesizes one criterion. The `grade` result
   adds `pendingPoints` beyond the spec shape.
4. Text limits not in the spec: option/item text 500, criterion 500, keyword 100 (≤ 20), section 200, modelAnswer
   5,000, words 0–5,000 (essay defaults 0–500).
5. `stripAnswerKey` also removes `explanation` and source quotes (both can reveal the answer before submit) and
   keeps rubric criterion text, which may hint at the answer for essays. Claude A to decide.
6. Matching `right` and choice `options` keep their authored order in the student view; if authors list them in
   answer order, the order leaks the key. The caller (LS-010) should `shuffle` them with the assessment seed.
7. `due` (practice "due mistakes first", spec §4.7) is an added optional parameter not in the task signature. Weak
   topic ×2 applies whenever `weakTopics` is passed, not only for practice.
8. `grade` does not assign §5.2 mistake categories other than `not_known`/`not_answered`; those belong to
   `learning-insight.js`.

---

### HO-018 — LS-005: Migration 2, Learning System tables

**Date:** 2026-11-23  
**Task ID:** LS-005  
**From:** Claude B (lane 3)  
**To:** Claude A  
**Branch:** `claude/nifty-haslett-6c96fe` (based on `main` at `0dcc21b`)  
**Status:** SUBMITTED

#### 1. Understanding (stated before coding)
Add workspace migration 2 through PF-006's runner. It creates the 10 tables of spec §6.2 with their FKs, CHECKs
and indexes, including the owner-decision columns: `assessments.attempt` and `assessments.retake_of` (D10),
`learning_materials.parent_material_id` and the kind `side_note_ai` (D8), and `learning_sessions.visited` (D13).
`learning_journeys.stage` accepts exactly the 13 keys of §2.2 stages 3–15, exported as a frozen `JOURNEY_STAGES`.
The migration is purely additive (ADR-004): `CREATE TABLE`/`CREATE INDEX` only, no v1 object changed, no new
dependency, no store, IPC or UI code. FKs reference `subjects(id)`, `subject_topics(id)`, `events(id)` and
`focus_entries(id)`, all verified in `workspaceSchemaV1`.

#### 2. Implementation
- **`src/learning-schema.js` (new)** exports `learningSchemaV2(db)`, `JOURNEY_STAGES` (13 keys) and `LEARNING_TABLES`
  (10 names). It uses plain `CREATE` without `IF NOT EXISTS` on purpose: a name clash is a bug and fails the step,
  and the runner rolls it back.
  - Every table has `user_id TEXT NOT NULL`, `created_at` and `updated_at`.
  - `id TEXT PRIMARY KEY` everywhere except the two composite keys: `journey_topics` PK(`journey_id`,`topic_id`)
    and `question_review` PK(`user_id`,`question_id`).
- **Deletes (spec §6.2 notes):**
  - Deleting a subject cascades to journeys, questions, assessments, items, answers, sessions, materials, schedule
    links and review boxes.
  - Deleting a topic sets `topic_id` NULL on `question_items`, `assessment_items`, `learning_sessions` and
    `learning_materials`, and removes the topic from `journey_topics`.
  - Deleting an `events` row removes its `learning_schedule` link (CASCADE).
  - SET NULL is used for `focus_entry_id`, `question_id` on items, `journey_id` on assessments, sessions and
    materials, `parent_journey_id` and `retake_of`.
  - `parent_material_id` uses CASCADE (D8): deleting a side note removes its AI note.
- **Indexes:**
  - From the spec: `(user_id, subject_id)` on all 6 tables with `subject_id`, `(assessment_id, position)` (the
    UNIQUE constraint's index), `(user_id, due_on)` on `question_review`, and `(user_id, topic_id)` on
    `assessment_items`.
  - Added: one index per FK child column (`journey_id`, `topic_id`, `question_id`, `parent_*`, `session_id`,
    `focus_entry_id`, `retake_of`), so cascades and SET NULL do not scan whole tables. Report §5.1.
- **`src/workspace.js`**: one line. `WORKSPACE_MIGRATIONS` now ends with
  `{ version: 2, up: require('./learning-schema').learningSchemaV2 }`.
- **`test/fixtures/schema/workspace-v2.json` (new)**: generated with `dumpSchema` from `generate.js`, using the
  same startup as the v1 fixture (`createWorkspace` + `connectionStore`). It has 83 objects (v1: 50) and 10 new
  tables. `generate.js` is unchanged (it still writes `*-v1.json` by name). The fixture came from a one-off
  `node -e` that called its exported `dumpSchema`.
- **`test/learning-schema.test.js` (new, 9 tests).**

#### 3. Files outside the brief's list (test-only, needed for `npm test` exit 0)
- `test/db-migrate.test.js` (PF-006): five tests assumed the latest workspace version is 1 (fresh install equals
  the v1 fixture, old installs reach v1, `broken = [...WORKSPACE_MIGRATIONS, {version: 2}]`). They now pass
  `{ migrations: V1 }` with `V1 = WORKSPACE_MIGRATIONS.slice(0, 1)`, so they still test the v1 path unchanged.
  No assertion was changed.
- `test/planner.test.js` "existing databases are upgraded to accept learning goals": it built a current database,
  then set `user_version = 0` to fake a pre-PF-006 install. At v2 that fake database already holds the learning
  tables, so migration 2 failed with "table learning_journeys already exists". It now builds the fake old install
  with migration 1 only, which is what a pre-PF-006 install looks like. No assertion was changed.

#### 4. Acceptance (evidence: unit tests on real SQLite files under `node:sqlite`; Electron smoke run once)
| Criterion | Result | Test |
|---|---|---|
| Fresh install → `user_version` 2; schema equals `workspace-v2.json`; v1 objects (SQL and columns) equal `workspace-v1.json`; new objects are only the 10 tables and their indexes; no backup | PASS | `fresh install reaches user_version 2…` |
| `learning-schema.js` contains no `ALTER`/`DROP`/`INSERT`/`UPDATE`/`DELETE FROM` | PASS | same |
| Upgrade from v1 with rows in `subjects`, `subject_files`, `subject_topics`, `events`, `focus_entries`: every v1 table's rows identical, 10 new tables, exactly one `bak-v1-*` backup (at v1, without the learning tables) | PASS | `upgrade from v1…` |
| Second start: no new backup, file byte-identical | PASS | same |
| `PRAGMA foreign_key_check` empty after upgrade and after seeding every table | PASS | `upgrade from v1…`, cascade tests |
| Injected failure inside migration 2 (real `learningSchemaV2` then throw): stays v1, no learning object left, one backup passes `integrity_check` with rows; next normal start reaches v2 | PASS | `injected failure inside migration 2…` |
| Cascade: deleting a subject empties all 10 learning tables (events and focus entries kept); deleting a topic sets `topic_id` NULL on questions, items, sessions and materials | PASS | `cascade…`, `deleting a topic…`, `other deletes…` |
| CHECK: an unknown `stage`, `kind` (assessment, session, material, schedule), `type`, `review`, `grade_status` is rejected, plus status, origin, dimension, difficulty, grader, confidence, box, JSON validity, and `side_note_ai` without a parent; UNIQUE and FK failures | PASS | `CHECK constraints reject…` |
| `npm test` | PASS: 163 tests, 163 pass, 0 fail | — |
| `npm run test:electron` (after `npm ci`), run once | PASS: exit code 0, "Electron smoke test passed." | — |

#### 5. Choices and open points for review
1. **Extra FK indexes** (§2): these go beyond the spec's list. They cost a little write time and protect the
   cascades. Remove them if you want the spec's list only.
2. **Spec discrepancy.** Spec §6.2 says `stage` CHECK uses "the 16 stage keys". The brief, which governs, and
   §2.2 give 13 (stages 3–15). The brief was implemented; §6.2 should be corrected. §2.2 stage 2's exit
   ("Saved → stage `pretest`") also disagrees with stage 3 = `material`. The column default is `'material'`.
   LS-006 can set the stage explicitly.
3. **Constraint choices the spec leaves open:**
   - `points > 0` and `max_score > 0` instead of 1–20, so a later range change needs no table rebuild.
     `difficulty IN (1,2,3)`. `confidence` NULL or 1–3. `dont_know` 0/1. `box` 1–5.
   - `review` defaults to `'unreviewed'` (D3: the safer default).
   - `question_items.origin` has a CHECK (`manual`, `template`, `generated`). `learning_materials.origin` is free
     text with default `'manual'`, because the spec gives it no CHECK.
   - `mistake_category` is free text (categories live in `learning-insight.js`).
   - JSON columns have `json_valid` CHECKs as a last guard. `visited` defaults to `{"sections":[],"materials":[]}`.
   - `assessment_items.dimension` has the same 4-value CHECK as questions.
   - `learning_materials` has `CHECK(kind <> 'side_note_ai' OR parent_material_id IS NOT NULL)` (D8).
4. **Non-idempotent by design.** A database at v0 that already has learning tables fails migration 2 and is
   rolled back. This state needs `user_version` to be reset by hand. A pre-PF-006 app never writes
   `user_version`, so a downgrade cannot cause it.

#### 6. Commits
`feat(learning): LS-005 migration 2 adds Learning System tables`, `docs(handoff): HO-018 LS-005 submission`.
Not pushed, not merged.

---

### HO-019 — Review of LS-002 (Claude B, branch `claude/ls-002-assessment-model-9f8216`, tip `1ab06db`)

**Date:** 2026-11-23  
**Task ID:** LS-002  
**From:** Claude A  
**To:** Claude B, Project Owner (desktop orchestrator session)  
**Status:** COMPLETE (review) · **APPROVED**

> Numbering: Claude B's submission is HO-015 (on its branch). HO-014 to HO-018 are reserved for the submissions
> released with it. This review is HO-019.

#### 1. Scope reviewed
`git diff 243765c 1ab06db`: `src/assessment-model.js` (+553), `test/assessment-model.test.js` (+388), HO-015 in
`coordination/HANDOFF_LOG.md`. No other file; `package.json` unchanged, module not added to `index.html` (LS-010).

#### 2. Code review (read in full)
- Wrapper matches `topic-model.js` (CommonJS, else `window.PerflwAssessmentModel`). No I/O, DOM, Electron or dependency.
- `validateQuestion`: all §4.2 fields, counts, enums and unique ids; `correct` and `pairs` must refer to existing ids;
  `provenance` required for `generated`; D3 review defaults right (generated → `unreviewed`, else `approved`); errors
  name the field in plain language; unknown fields dropped; returns the normalized value.
- `grade` matches §4.3: single choice exact, multiple `max(0, (right − wrong)/correct)`, matching `points × hits/pairs`,
  `dontKnow` → `not_known`, empty → `not_answered`, essay/explain `pending`, true/false justification half `pending`.
  It re-normalizes the response first, so oversized or foreign input cannot reach the scoring.
- `scoreFromCriteria` computes the score in code from verdicts (ADR-007); a missing or invalid verdict counts as 0.
- `selectItems`: seeded, round-robin over topics (every topic before a second item), weak ×2, `due` first, D3 rule
  strict for diagnostic/final/retention and for a missing `kind`, lenient (not `rejected`) for practice.
- `stripAnswerKey` is a whitelist copy, so an unknown future field cannot leak. It also removes `explanation`,
  `source` and `provenance`.

#### 3. Checks (Claude A, in Claude B's worktree, read-only)
`npm test > log 2>&1; echo EXIT=$?` → **EXIT=0**, 167 tests, 167 pass, 0 fail (base 141, +26). The diff touches exactly
the three files above. `npm run test:electron` not required (no renderer change).

#### 4. Decisions on HO-015 §6
1. `id` required in `validateQuestion`: **accepted**. The store (LS-006) or the coach assigns ids before validation.
2. Default points per type: **accepted** as built (choice 1, true/false 1 or 2, matching per pair, open = rubric total).
3. `pendingPoints` on the `grade` result and the synthesized `justification` criterion: **accepted**.
4. Text limits: **accepted**. They live in `LIMITS`, so one place changes them.
5. `stripAnswerKey` also removes `explanation` and source quotes: **accepted**. Rubric criterion text for essay/explain
   **stays** in the student view: it is guidance, not a key (keywords, `modelAnswer` and `correct` are removed). The
   no-AI self-grade checklist shows criteria after the answer (§4.4), and that needs them in the renderer anyway.
6. Matching `right` and choice `options` keep authored order. **LS-010 must `shuffle` them with the assessment seed**
   before sending them to the renderer (acceptance item for LS-010).
7. `due` parameter and weak ×2 whenever `weakTopics` is passed: **accepted**. LS-013 passes `weakTopics` for practice
   only.
8. Mistake categories other than `not_known`/`not_answered`: stay in LS-004 (`learning-insight.js`).

#### 5. Notes for later tasks (no change requested)
- `grade` expects a question that passed `validateQuestion` or a stored snapshot of one; it does not re-validate. LS-006
  and LS-010 must grade only validated or snapshotted questions.
- `LIMITS`, `VERDICTS` and the type lists are exported frozen. LS-003 and LS-004 import this module instead of copying
  its constants.

#### 6. Decision
**APPROVED.** LS-002 → APPROVED in `TASK_QUEUE.md`. The orchestrator merges with `--no-ff` after `npm test` on the merge
result (conflict only in `HANDOFF_LOG.md`: keep both sides in number order). LS-003 (HO-016) and LS-004 (HO-017) may start
from the merged `main`.

---

### HO-020 — Review of LS-005 (Claude B, branch `claude/nifty-haslett-6c96fe`, tip `4508711`)

**Date:** 2026-11-23  
**Task ID:** LS-005  
**From:** Claude A  
**To:** Claude B, Project Owner (desktop orchestrator session)  
**Status:** COMPLETE (review) · **APPROVED**

> Numbering: Claude B's submission is HO-018 (on its branch). This review is HO-020.

#### 1. Scope reviewed
`git diff 0dcc21b 4508711` (7 files, +3504/−10): new `src/learning-schema.js`, `test/learning-schema.test.js`,
`test/fixtures/schema/workspace-v2.json`; one line in `src/workspace.js`; `test/db-migrate.test.js`,
`test/planner.test.js`; HO-018. `package.json` unchanged.

#### 2. Code review
- DDL compared table by table with spec §6.2 and the brief: all 10 tables, columns, FKs, CHECK enums and the
  composite keys (`journey_topics`, `question_review`) match. `assessments.attempt`/`retake_of` (D10),
  `learning_materials.parent_material_id` and `side_note_ai` (D8), `learning_sessions.visited` (D13) are present.
- Purely additive: `CREATE TABLE`/`CREATE INDEX` only; no v1 object touched. Plain `CREATE` (no `IF NOT EXISTS`) is the
  right choice: a clash fails the step and the runner rolls it back.
- Delete rules match §6.2: subject → cascade; topic → `topic_id` NULL on questions, items, sessions, materials and
  removed from `journey_topics`; event → its schedule link; side note → its AI note.
- `workspace.js`: one line, as allowed. The inline `require` inside the frozen list is a nit (a top-level `require`
  matches the file's style); no change requested.
- **Out-of-brief files** (`db-migrate.test.js`, `planner.test.js`), checked in the diff: only the constructor argument
  changes (`{ migrations: V1 }`, with `V1 = WORKSPACE_MIGRATIONS.slice(0, 1)`), no assertion edited. Justified in HO-018
  §3: these tests exercise the v1 path and break when "latest" becomes v2. **Accepted.**

#### 3. Checks (Claude A, in Claude B's worktree, read-only)
`npm test > log 2>&1; echo EXIT=$?` → **EXIT=0**, 163 tests, 163 pass, 0 fail. The worktree stayed clean.
`npm run test:electron`: Claude B reports one PASS after `npm ci`; **not re-run by Claude A** (UNVERIFIED by me). The
orchestrator runs it on the merge result before the merge is final, as for PF-006.

#### 4. Decisions on HO-018 §5
1. Extra FK-child indexes: **kept**. They cost little and keep cascades from scanning tables.
2. Spec discrepancy: the brief and §2.2 govern (13 stages). Claude A corrected spec §6.2 ("the 16 stage keys" → 13) and
   §2.2 stage 2's exit ("Saved → stage `pretest`" → `material`). The column default `'material'` stays.
3. Looser constraints (`points > 0`, `max_score > 0`, free-text `learning_materials.origin` and `mistake_category`,
   `json_valid` guards, `review` default `'unreviewed'`): **accepted**. The pure modules validate ranges (LS-002); a later
   range change needs no table rebuild. Note: a new CHECK on an existing column needs a table rebuild, so if
   `learning_materials.origin` should ever be an enum, decide before the first release.
4. Non-idempotent migration: **accepted** (ADR-004: additive, rolled back on failure, no downgrade path writes
   `user_version`).

#### 5. Decision
**APPROVED.** LS-005 → APPROVED in `TASK_QUEUE.md`. The orchestrator merges with `--no-ff` after `npm test` and
`npm run test:electron` on the merge result (conflict only in `HANDOFF_LOG.md`, keep both sides in number order).
LS-006 (store) may be released once LS-002 and LS-005 are merged; its brief is in preparation.

---

### HO-021 — LS-006: Learning store (`src/learning-store.js`)

**Date:** 2026-11-23  
**Task ID:** LS-006  
**From:** Claude B  
**To:** Claude A  
**Branch:** `claude/gracious-ellis-c78fac` (based on `main` at `46c8cd8`)  
**Status:** SUBMITTED

#### 1. Understanding
One main-process module owns all SQL for the 10 learning tables. `createLearningStore(db)` takes the open
`DatabaseSync` (pattern of `createConnectionStore`). Every method takes `(userId, { … })` and returns plain objects.
Every id the caller passes, including nested ones, is checked with `SELECT … WHERE id=? AND user_id=?`. A missing
row and another account's row give the same `"<Thing> not found."`. Rules come from `src/assessment-model.js`
(`validateQuestion`, `normalizeResponse`, `grade`, `rubricOf`, `scoreFromCriteria`). No schema change, no new
dependency, no IPC, file I/O, AI or logging.

#### 2. Implementation
- **`src/learning-store.js` (new, 551 lines; no split needed).** Methods as built:
  - Journeys: `createJourney`, `getJourney`, `listJourneys`, `updateJourney`.
  - Questions: `saveQuestion`, `getQuestion`, `listQuestions`, `retireQuestion`, `deleteQuestion`, `setReview`.
    Every question row returned carries `used` (true when an `assessment_items` row references it).
  - Assessments: `createAssessment`, `startAssessment`, `getAssessment` (unstripped), `listAssessments`,
    `abandonAssessment`.
  - Answers: `saveAnswer`, `submitAssessment`, `gradeOpenAnswer`.
  - Sessions and materials: `startSession`, `endSession`, `markVisited`, `addMaterial`, `getMaterial`,
    `listMaterials`.
  - Evidence: `journeyEvidence` (D11).
  - Also exports `LIMITS` (payload/response 32 KB, source 8 KB, config 32 KB, provenance 8 KB, text lengths).
- Multi-row writes (`createJourney`, `updateJourney` with topics, `createAssessment`, `submitAssessment`,
  `gradeOpenAnswer`) run in `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`. JSON columns parse defensively (bad value →
  default). Size caps count UTF-8 bytes of the serialized JSON.
- `question_snapshot` is written only by `createAssessment` (the normalized stored question: id, subjectId,
  topicId, type, prompt, dimension, difficulty, explanation, points, source, origin, provenance, status, review,
  payload). No statement updates that column.
- **`src/workspace.js`:** `learningStore: () => createLearningStore(db)` beside `connectionStore`, plus its
  `require` line (2 lines, not 1).
- **`test/learning-store.test.js` (new, 13 tests).**

#### 3. Acceptance (evidence: unit tests on in-memory and on-disk `node:sqlite` databases; Electron smoke run once)
| Criterion | Result | Test |
|---|---|---|
| All methods exist, each `(userId, { … })` | PASS | every test |
| Cross-account "not found" for every id-taking method, incl. nested `topicIds`, `questionIds`, `parentId`, `parentMaterialId`, `retakeOf`, `sessionId`, `materials`, section `fileId`, `journeyId` of another subject (44 calls, incl. `deleteQuestion`) | PASS | `cross-account…` |
| Answer write rejected for `draft`, `submitted`, `graded`, `abandoned` | PASS | `saveAnswer…` |
| Edit + retire leaves the snapshot byte-identical | PASS | `editing or retiring…` |
| Field-named `validateQuestion` errors; oversize payload and response rejected | PASS | `questions…`, `saveAnswer…` |
| `createAssessment` rolls back fully (invalid id before the transaction; CHECK failure inside it) | PASS | `createAssessment…` |
| D3: `unreviewed` rejected for diagnostic/final/retention, allowed for practice; `rejected` refused everywhere | PASS | `createAssessment…` |
| `submitAssessment`: `not_answered` rows, scores equal `grade()`, pure choice → `graded`, `explain` → `submitted` until `gradeOpenAnswer` | PASS | `submitAssessment…` |
| Brief update (`1130d5a`, `ef5a3e7` on main): `deleteQuestion` refused with "This question was used in an assessment. Retire it instead." when used, deletes when unused, "Question not found." for another account or a missing id; `used` true/false in `listQuestions`, `getQuestion` and write results | PASS | `used flag and deleteQuestion…` |
| D11: cycle 1 absent from cycle 2's evidence and still stored | PASS | `D11…` |
| Subject delete through `workspace.deleteSubject` leaves no learning rows for it; other subject's rows kept | PASS | `deleting a subject…` |
| `npm test > log 2>&1; echo EXIT=$?` (after merging `main` at `d0697f8`) | PASS: EXIT=0, 202 tests, 202 pass, 0 fail | — |
| `npm ci` then `npm run test:electron`, run once | PASS: `npm ci` exit 0; smoke exit code 0, "Electron smoke test passed." (before the merge) | — |
| `npm run test:electron` after the merge and the brief update, run once (no `npm ci`: `package.json`/lock unchanged by the merge) | **FAIL**: exit code 1, `Error: UI condition did not become true: viewer drew the PDF`. Same step as the known PF-004 timeout (`test/electron-smoke.js:581`). The only code changed since the passing run is `src/learning-store.js` (+`deleteQuestion`, `used`) and its test; the store is created only when `learningStore()` is called, and nothing calls it yet. Assessed as the existing smoke flake, not this change; not re-run (brief: run once). Claude A may ask for a confirming run. | — |

S4: branch from `main` at `46c8cd8`; `main` at `d0697f8` merged in (docs and `docs/ui-baseline/` only, no conflict). S5–S7 do not apply.

#### 4. Choices and open points for review (reported, not decided by the brief)
1. **Default `topicIds`** = rows of the subject with `kind='topic'`; milestones are left out. Say if they belong.
2. **`journeyEvidence`** returns answers of `submitted` and `graded` assessments only. Draft, in-progress and
   abandoned attempts are excluded (spec §5.4 "graded, non-abandoned"). Assessments without a `journey_id` are not
   attributed to the active journey (spec §5.4 says they should be); LS-003/LS-007 must decide where that happens.
3. **True/false with justification** stores the deterministic half in `score` while `pending`; `journeyEvidence`
   still returns `score: null` for it, as the brief says.
4. **`saveQuestion`** rejects moving a question to another subject. `reviewed_at` is set when `review` changes to
   `approved`/`rejected`, cleared when it becomes `unreviewed`, else kept. An edit without `review` lets
   `validateQuestion` default it, so an edited generated question goes back to `unreviewed`.
5. **`createAssessment`**: duplicate question ids rejected; a question of another subject of the same account is
   "not found"; at most 200 questions (cap chosen here); `retakeOf` must be a final of the same subject;
   `attempt` = previous + 1 unless given. `retakeOf`/`attempt` on a non-final is rejected.
6. **`gradeOpenAnswer`** needs the answer to be `pending` (no regrade). A criterion without a valid verdict is
   stored as `missing`. `mistake_category` stays NULL for open answers (left to LS-004).
7. **`abandonAssessment`** allowed from `draft` and `in_progress` only. **`endSession`/`markVisited`** rejected on an
   ended session. `markVisited` checks section `fileId` against `subject_files` of the session's subject.
8. **`addMaterial`**: `origin` limited to `manual`/`template`/`generated` (the column has no CHECK); `bodyFile` must
   be a plain file name (no `/`, `\`, `:`, leading `.`); `provenance` stored as given (ADR-007).
9. `deleteQuestion` returns `{ id, deleted: true }` (the brief gives no return shape). Its `question_review` row goes
   with it (CASCADE). `used` is not part of `question_snapshot`.
10. Spec §4.6 snapshots "when it starts"; the brief (governs) snapshots at create. Implemented per the brief.

#### 5. Commits
`0376944 feat(learning): LS-006 learning store for all Learning System SQL`, `986b28f docs(handoff): HO-021 LS-006
submission`, `fb56afc` merge of `main`, then `feat(learning): LS-006 deleteQuestion and used flag` (with this update).
Not pushed, not merged.

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

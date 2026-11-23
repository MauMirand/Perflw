# M-L1 acceptance script — the first full offline learning cycle

**Milestone:** M-L1, "Offline walking skeleton" (decision D5). One automated run walks
**create journey → pre-test → results → study session → final → report** with **no AI provider configured**, and one
verdict says whether the milestone passed.

**Owner of the script:** LS-034 writes `test/learning-ml1-smoke.js` (npm script `test:ml1`). **Owner of the steps:** this
document (Claude A). A step is changed here first, then in the script.

## Pass / fail rule

M-L1 **passes** only when all of these hold on the milestone branch (the merge result of the last M-L1 task, LS-034):

1. `npm run test:ml1` exits 0 **three times in a row** (exit codes recorded right after each command; one green run proves
   nothing, the suite had flakes of about 1 in 11).
2. `npm test` exits 0 and `npm run test:electron` exits 0 on the same commit.
3. Every step below prints `PASS` with its label; any `FAIL` line names the step and the observed value.
4. Claude A has compared the screenshots the run writes with `docs/ui-baseline/` (S7, decision D12) and recorded APPROVED.
5. The run made **zero** network requests to `http(s)` URLs and the app showed no AI controls as active (proof that no provider
   was needed).

Anything else is **not passed**. There is no "mostly passed".

## Setup (step 0)

- Temp data folder through `PERFLW_TEST_USER_DATA` (never the owner's data), removed at the end. Fresh account, as in
  `test/electron-smoke.js`.
- Window 1280 × 800 for the walk; a second pass of the screenshot steps at 400 px wide.
- CDP listeners from the first moment: console errors/exceptions (any → FAIL), `Network.requestWillBeSent` for `http:`/`https:`
  URLs (any → FAIL).
- Assert the provider list is empty (`window.ecosystem`/connections: none configured).
- Pure models are `require`d by the script itself to compute **expected** values (`assessment-model.grade`,
  `scoreFromCriteria`, `mastery-model.topicLevel`, `learning-insight.categorize`). **No expected score or level is hard-coded.**

## Fixture

- One study-profile subject "Chemistry" with the generated two-heading PDF (as `docs/ui-baseline/capture.js`) → two topics,
  **Unit A** and **Unit B**.
- 16 manual questions saved through `learningData.questionsSave` (the bank UI is covered by LS-009's own smoke). Per topic 8:
  **4 recognition** (`choice` ×2, `truefalse`, `matching`) and **4 `explain`** (dimension `recall`, a 2-criterion rubric, 1 point
  per criterion). All `origin:'manual'`, `review:'approved'`. The script keeps the answer key for every prompt.
- Why this fixture is deterministic: `selectItems` takes topics round-robin and, inside a topic, interleaves dimensions
  (a diagnostic starts with recall). A count of 8 therefore yields **per topic 2 recognition + 2 explain** in the diagnostic;
  the final, which excludes the diagnostic's questions, gets the other **2 recognition + 2 explain** per topic. Step 4 and step 14
  assert this split, so a drift in selection or in the fixture fails loudly. Which recognition shape (choice, true/false,
  matching) lands where is not fixed; the script reads the types from the assessment and answers from its key table.
- The student view of the quiz is never given the key; the script answers from its own table.

## Steps

| # | Step | Actions | PASS when |
|---|---|---|---|
| 1 | Bank ready | Seed the 16 questions | `questionsList` returns 16; all `approved`, `active`; `user_version` of `workspace.sqlite` is 2 |
| 2 | Create journey (LS-008) | Subject page → Journey → start, title "Cycle 1", all topics | `journeyGet`: stage `material`, cycle 1, 2 topic ids; stepper shows **Material** current, later stages not startable |
| 3 | Material | Continue | stage `pretest_setup`; stepper shows **Pre-test setup** current |
| 4 | Pre-test setup | Open the sheet, set count to **8** (4 per topic), source = bank, create | one assessment kind `diagnostic`, status `draft`, 8 items; per topic 2 `recognition` + 2 `recall`; question ids all from the bank; `config.seed` stored |
| 5 | Start | "Start pre-test" | status `in_progress`, journey stage `pretest`; quiz panel visible; **no** `correct`/`pairs`/`modelAnswer`/`keywords`/`explanation` key in the renderer's assessment object (deep scan of question snapshots) |
| 6 | Leave and resume | Answer 3 questions, flag 1, leave (✕ → confirm), reopen from the hub | the 3 answers, the flag and the position are restored; the 3 answers equal the database rows |
| 7 | Answer the rest | Answer 4 more: **one recognition item of Unit A wrong with confidence 3**, **one recognition item of Unit B "I don't know"**, the others correct; leave **one Unit B explain item blank** | "N unanswered" prompt appears with N = number of blank items; Go back works |
| 8 | Submit | Answer the blank explain items, press Submit | assessment `submitted`; journey stage `diagnostic`; every choice/true-false/matching score equals `grade(question, response).score`; explain answers `pending`; the "I don't know" answer has `mistakeCategory` `not_known` |
| 9 | Self-grade | Self-grade the 4 explain answers with ticks 1 of 2, 2 of 2, 0 of 2, 2 of 2 (script table) | assessment `graded`; each explain score equals `scoreFromCriteria`; grader `self`, status `final` |
| 10 | Results (LS-011) | Open results | score line equals the expected sum; topic table has both topics, level chips equal `mastery-model.topicLevel` on the same evidence; dimension bars show "n items" and "No evidence" where the model returns `null`; weak-topic list equals `rankWeakTopics`; the wrong-confident answer shows **misconception**, the don't-know answer **did not know**; Review answers has no editable control and shows each correct answer |
| 11 | Mastery block | Back to the subject page | Mastery block level chips equal step 10's |
| 12 | Study session (LS-012) | Open Unit A in the viewer → Start studying → open a section → add side note "Ionic bonds hold because opposite charges attract." → End session | one `learning_sessions` row, `ended_at` set, `focus_entry_id` set; the focus entry has `source:'learning'` and appears in the focus list; `visited.sections` contains the opened section once; side note stored as `learning_materials` kind `side_note`, its file equals the typed text byte for byte; journey stage `main_learning`; summary shows duration, topic and 1 note |
| 13 | No ghost timer | Check the timer | `active_timers` empty |
| 14 | Final setup (LS-034) | Hub → "Set up the final", count 8 | assessment kind `final`, 8 items, per topic 2 `recognition` + 2 `recall`; **no** question id also appears in the diagnostic; all `approved`; journey stage `final_exam` |
| 15 | Final | Start; answer all correctly; self-grade explain items 2 of 2; submit | status `graded`; every score equals `grade()`/`scoreFromCriteria`; no unanswered prompt |
| 16 | Report (LS-034) | Open the report | stage `report`; per topic: pre-test level and final level equal `mastery-model.topicLevel` on the diagnostic rows and on all rows; per-dimension improvement equals `improvement()` and is shown only where both sides have ≥ 2 items; no subject-wide percentage; no "provisional" flag (all open answers `final`) |
| 17 | Invariants | Close the app; open `workspace.sqlite` read-only | `user_version` 2; `PRAGMA foreign_key_check` empty; exactly 2 assessments (`diagnostic`, `final`), both `graded`; one `assessment_answers` row per item (16); one ended session; no `*.tmp` file in the data folder; app exit code 0 |
| 18 | Screens | Write screenshots to the artifacts folder | 1280 px and 400 px: hub (each stage state), quiz (each type), results, session bar and summary, report. File names are listed in the run summary |
| 19 | Offline proof | Read the CDP counters | 0 console errors; 0 `http(s)` requests; provider list still empty |

## Not in M-L1 (so absent from the script)

AI generation, AI grading, AI side-note help; template questions; practice/Quest; targeted notes; mistake-analysis page;
supplementary and final-learning stages (D9 evaluation, LS-033); timed final and the pass mark (LS-023); retention check;
next cycle; journey history. The stepper marks those stages as "later". The final here is the **small test final** allowed by
D15 and has no time limit.

## How the steps map to tasks

| Steps | Delivered by |
|---|---|
| 1–3 | LS-006, LS-007, LS-008 |
| 4–9 | LS-008, LS-009, LS-010 |
| 10–11 | LS-003, LS-004, LS-011 |
| 12–13 | LS-012 |
| 14–16 | LS-034 |
| 17–19, harness | LS-034 |

Each renderer task lists the selectors it adds in its handoff entry; LS-034 builds the script from those lists. If a step cannot
be written from them, LS-034 reports the missing selector instead of adding a hook to a finished screen.

# Perflw Time Tracker concept

**Status:** Product concept and proposed user flow
**Revision:** 1
**Scope:** Product behavior and acceptance criteria; no implementation changes

## 1. Product outcome

The Time Tracker helps a person record where their work time actually went, with as little interruption as possible. It connects actual work to a task or project when useful, remains easy to correct, and treats pauses and missed entries as normal parts of the day.

The timer is an **elapsed-time tracker**, like a stopwatch. It is not a countdown, Pomodoro timer, calendar scheduler, or productivity score. Calendar records planned time; the Time Tracker records actual time. A task can connect the two, but tracking actual work must not silently move or create a Calendar event.

### Primary user job

“I’m starting, changing, pausing, or finishing a piece of work. Help me capture the actual time and its context without making me manage the tracker.”

### Success signals

- A person can start work immediately with a short description, and add task or project details when needed.
- A task started from Planner arrives already linked to its project and skill.
- The active timer survives leaving the screen or restarting the app.
- Paused time is excluded from tracked duration.
- Switching work saves the previous segment and starts the next one as a single deliberate action.
- A stopped or manually entered session can be corrected later.
- History and Analytics use saved actual-time records, not estimates from scheduled Calendar events.

## 2. Product model

### Core records

- **Active timer:** one per account, with a description, optional project/task, optional skill/note, start time, elapsed seconds, and a running or paused segment.
- **Focus entry:** a saved completed session. It records start/end timestamps, actual duration, optional task/project/skill/note, and whether it came from the timer or was entered manually.
- **Task:** optional context for a focus entry. A task can supply its project and skill. The focus record remains valid if the task later changes or is removed.

### Rules users should be able to predict

1. Only one timer can run for an account at once.
2. Starting a second item while a timer runs offers a clear **Switch work** action. It saves the current session and starts the next item.
3. Pause stops the elapsed counter. Resume continues the same session.
4. Stop saves a focus entry. Stopping is distinct from pausing.
5. Manual time is a separate route for work that already happened. It cannot overlap a running timer on the same day.
6. A task can be started from Planner or selected in Time Tracker. If the task has a project or skill, those values are inherited unless the person changes them.
7. Time Tracker records actual work; it does not alter the task deadline or Calendar schedule.
8. Saved history can be edited for honest corrections. Edits validate that the end is after the start and is not in the future.

## 3. Experience principles

### Start first; refine when useful

Keep the primary action visible and fast. Description is the only required context. Project, task, skill, and note should remain optional and should not block a start.

### Show one clear current state

The active session should answer: **What am I tracking? How long has it counted? What can I do now?** Use plain state labels such as “Running” and “Paused”; do not rely on color or an ornamental status dot alone.

### Make context helpful, not compulsory

Task and project links improve later review, but an unlinked session is still useful. Never make the user invent a task to start tracking.

### Treat interruptions without judgment

Make Pause and Resume easy to find. If a user notices an old running timer, show its description and elapsed time and let them resume, pause, stop, or correct it. Avoid scolding or implying that the user has failed.

### Separate actual time from planned time

Use clear language: “Scheduled” belongs to Calendar; “Tracked” belongs to Time Tracker. Shared task links provide context, not a claim that planned and actual time match.

### Preserve trust through correction

History should support editing a mistaken description, task association, skill, note, or time range. Confirm destructive deletion and explain its effect on totals.

## 4. Information structure

The Time Tracker screen should have four calm, predictable areas:

1. **Current session** — the primary area. Shows running/paused state, elapsed duration, description, linked task/project when present, and the actions available now.
2. **Start work** — a short description field and Start action. Context fields are secondary and can be opened as needed.
3. **Add time from earlier** — a separate, initially collapsed manual-entry path with description, date, start time, duration/end time, and optional context.
4. **Recent tracked time** — saved entries with date range filters, duration, description, task/project, skill, and an edit action.

Daily totals by project are a useful supporting summary. They should not compete visually with the current session or become a score.

## 5. End-to-end user flows

### A. Start a timer from Time Tracker

1. Open Time Tracker. If no timer is active, show the short description field and **Start timer** as the primary action.
2. The user enters a description. They may optionally add a task, project, skill, or note.
3. Selecting a task fills its project and skill when available. If the user changes the task, keep its project association consistent.
4. Select **Start timer**.
5. Show the running elapsed time, description, context, and **Pause**, **Stop and save**, and **Switch work** actions.
6. Confirm the state immediately and keep the timer running while the user navigates elsewhere.

**Fast path:** if they only enter a description, they can start without opening optional fields.

### B. Start work from Planner

1. The user selects **Start** on a Planner task.
2. If there is no active timer, open Time Tracker with the task, project, and task skill prefilled and start tracking that task.
3. If a timer is already active, present the existing work and the requested task, then ask the user to choose **Switch work** or **Keep current timer**. Do not silently discard or switch the existing session.
4. On switch, save the previous focus entry and start the selected task’s timer. Show a short confirmation naming the work now being tracked.

### C. Pause and resume around an interruption

1. Select **Pause**. The displayed duration freezes and the session is labeled Paused.
2. Leave the screen or close and reopen the app. The active session remains available in its paused state.
3. Select **Resume** to continue counting the same session, or **Stop and save** to finish it.

No pause duration is added to the saved actual duration.

### D. Switch to another task or work item

1. Select **Switch work** while a timer is active.
2. Enter or select the next description/task and optional context.
3. Review a concise summary: “Save [current item] and start [next item]?”
4. Confirm once. Save the first session and start the next within one transaction.
5. Show the new running timer and confirm the prior item was saved.

If validation or persistence fails, retain the original active timer and show an actionable error. Never leave the user with neither a saved prior entry nor an active timer.

### E. Stop and review a session

1. Select **Stop and save**.
2. Save the focus entry and return the current-session area to its idle state.
3. Confirm “Time entry saved” and make the saved entry visible in recent history.
4. The user can edit its description, context, note, or time range from history.

Stopping a timer does not complete its task. Completing a task does not automatically stop its timer.

### F. Add work from earlier

1. Open **Add time from earlier**.
2. Enter a description, date, start time, and duration (or an equivalent start/end pair).
3. Optionally link a project/task, skill, and note.
4. Validate that the entry ends in the past, has positive duration, is internally consistent, and does not overlap an active timer where the app’s current rule applies.
5. Save and show the entry in history and Analytics.

### G. Recover a forgotten or incorrect timer

1. On returning to the app, show the current running or paused session with its original start and counted duration.
2. Offer **Resume**, **Pause**, **Stop and save**, and **Edit time** where appropriate.
3. If the session is implausibly long, do not silently cap or rewrite it. Explain the recorded span and let the user correct the saved entry after stopping.
4. If the app cannot load the active timer, preserve the stored data and show an error with a retry route; do not display an idle state that suggests no timer exists.

## 6. States and transitions

| State | What the user sees | Main actions | Expected result |
| --- | --- | --- | --- |
| Idle | Start field and recent history | Start timer; Add time from earlier | Start a new active timer or open manual entry |
| Running | Description, linked context, live elapsed duration | Pause; Switch work; Stop and save | Pause counter; save-and-restart; or save completed focus entry |
| Paused | Description, frozen counted duration, paused label | Resume; Switch work; Stop and save | Resume same timer; save-and-restart; or save entry |
| Saving | Disabled duplicate-submit controls and brief progress feedback | Wait | One saved entry; prevent duplicate rows |
| Saved | Confirmation and new history row | Edit entry; Start next | Correct history or start a new session |
| Manual entry | Separate form with date/time/duration | Save; Cancel | Persist one past focus entry or retain form values with error |
| Error | Plain-language issue near the action | Retry; correct values | Preserve active timer/form data and allow recovery |

### Transition rules

- Idle → Running only after a valid start is saved.
- Running → Paused freezes elapsed time and retains the session.
- Paused → Running continues the same session.
- Running/Paused → Running for a different item is a **switch**: save the prior record and create the next active timer atomically.
- Running/Paused → Idle happens only after a completed focus entry is saved.
- Any failed write leaves the last valid state available for retry.

## 7. First-release acceptance criteria

These criteria describe the intended product behavior. The current code already supports many of them; the concept proposes clearer flows and states where noted.

1. **Quick start:** With no active timer, a user can start using only a description; optional context does not block the action.
2. **Task start:** Starting a task from Planner associates the timer with that task and inherits its project/skill when present.
3. **Single active timer:** A second start cannot overwrite the first timer. The UI offers a deliberate switch path.
4. **Pause accuracy:** Paused time does not increase `duration_seconds`, including across app navigation and restart.
5. **Switch integrity:** Switching saves exactly one completed entry for the prior session and leaves exactly one active timer for the next item; a failed switch preserves the prior active session.
6. **Stop integrity:** Stopping a valid session creates one focus entry and clears the active timer. Repeated clicks cannot create duplicates.
7. **Manual time:** Manual entries require valid past time and positive duration, preserve optional context, and appear in history and Analytics.
8. **Correction:** Saved entries can be edited; end-at-or-before-start and future end times are rejected without losing the user’s edits.
9. **Recovery:** Running and paused timers are restored after app restart with the correct task/project association and counted duration.
10. **Separation of records:** Calendar schedule times do not change when a focus entry starts, pauses, stops, or is edited.
11. **Account isolation:** Timer state and history are visible only to the authenticated account.
12. **Accessible operation:** All timer actions work by keyboard; labels identify actions and state in text; focus remains understandable after start, pause, stop, switch, and errors; reduced-motion settings do not affect usability.

## 8. Ideas and recommendations

### Prioritize for the next refinement

1. **Make current-session state unmistakable.** Use one clear primary time display, a running/paused text state, task/project context, and only the actions valid for that state.
2. **Make switch an explicit save-and-start action.** The current system supports switching; a confirmation summary and recoverable error handling will make its consequences easier to understand.
3. **Add a small recovery prompt for unusually old timers.** Present what is recorded and let the user decide; do not auto-stop timers or silently edit time.
4. **Show timer results in recent history immediately.** The saved item should be easy to find and correct without searching another screen.
5. **Protect against duplicate actions.** Disable submit while an operation is pending, keep the active state visible, and make retry behavior safe.

### Consider after observing real use

- **Optional work presets/favorites:** one-click starts for repeated descriptions and project/task combinations. Keep them optional and user-controlled.
- **Keyboard shortcut:** a discoverable shortcut to open Time Tracker or start a previously selected item. Avoid a global start shortcut until focus and duplicate-start behavior are designed.
- **Compact persistent timer indicator:** a restrained app-level indicator while the timer runs on another screen, with a direct route back to the timer. It should not become a distracting notification system.
- **Weekly review:** compare tracked time with tasks and schedules as context, not a target or performance grade.
- **Gentle idle reminder:** consider only if users ask for it. It should be opt-in, dismissible, quiet, and should never pause or change a timer automatically.

### Keep outside the initial concept

- Countdown/Pomodoro cycles, break enforcement, streaks, leaderboards, productivity scoring, automatic time classification, cloud sync, and automatic Calendar scheduling.
- Background monitoring of apps, windows, keyboard activity, or websites.
- Automatic correction or deletion of long sessions.

These additions change the product model or collect more sensitive information. They need a separate user problem and explicit design decision before consideration.

## 9. Current implementation fit and gaps

The current project already has account-scoped persisted timers, one active timer per account, pause/resume, stop-and-save, switch, manual entries, editable history, task/project/skill/note associations, daily project totals, and Planner task starts. Reuse the existing `workspaceData` timer and focus-entry operations and the same `workspace.sqlite` records.

The most valuable product work is therefore interaction clarity and error/recovery behavior rather than a new timer service. Before implementation, inspect current screens and validate which proposed refinements are already present. In particular, the app currently treats the active timer's start/end timestamps separately from its elapsed duration when pauses occur; reports should use the saved duration for actual time, and the UI should avoid implying that paused periods were tracked.

### Evidence and boundaries

- Current Time Tracker behavior and the optional manual-entry path are described in `README.md` and `docs/TIME_TRACKER_UX_RESEARCH.md`.
- Timer persistence, pause/resume, stop, and task association are implemented in `src/workspace.js` and surfaced by `src/renderer.js`.
- Unit and Electron smoke coverage exists in `test/workspace.test.js` and `test/electron-smoke.js`; this concept work did not execute those checks.
- This is a proposed product framework, not a usability study. Validate labels and recovery behavior with observed use before adding reminders, shortcuts, or more automation.

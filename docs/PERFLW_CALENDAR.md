# Perflw Calendar MVP

## Current behavior

Calendar is an account-scoped view of the events already stored by Perflw. It offers day, week, and month views; previous, next, and Today navigation; local date and time display; saved event details; and a quick-create form. Selecting a date or time slot fills in a one-hour start and end interval. The user can adjust the title, times, and optional project before saving.

Calendar reads and writes through the existing `workspaceData.events()` and `workspaceData.createEvent()` bridge methods. The main process checks the current account and the workspace store validates event dates and project ownership. Data stays in the existing `workspace.sqlite` database. Renderer code has no direct database or filesystem access. Calendar event cache and form content are cleared when the account changes.

## File architecture

| File | Responsibility |
| --- | --- |
| `src/calendar/calendar.js` | Calendar view state, local date calculations, month and time grids, slot selection, and event details. |
| `src/calendar/calendar.css` | Calendar-specific layout and responsive styles. |
| `src/index.html` | Calendar navigation entry, view controls, event form, grid mount, and details dialog. |
| `src/renderer.js` | Routes into Calendar, loads saved events and projects, submits event creation through the existing bridge, and clears account-scoped UI state. |
| `src/preload.js` | Existing allowlisted event read and create methods. No new privileged bridge methods were needed. |
| `src/main.js` | Existing authenticated handlers for event reads and creation. |
| `src/workspace.js` | Existing SQLite event schema, date validation, project ownership check, and account-scoped event query. |
| `test/electron-smoke.js` | Calendar navigation, view controls, saved event creation, event details, and rendering checks. |

## Observable MVP checks

- Calendar opens from the sidebar and the Calendar popover.
- Day, week, and month controls update the visible view and announce their selected state.
- Previous, next, and Today update the displayed period.
- Saved events render from the workspace database, and event details show the saved title, time, and project name.
- Selecting a date or time slot prefills the event form.
- Saving creates an event through the account-scoped workspace API; a fresh event query renders it in Calendar.
- Invalid dates and project IDs continue through existing main-process validation and errors are shown to the user.
- Account transitions clear the calendar's cached events and event form.

## Current boundaries

This MVP stores the event fields supported by the current schema: title, start, optional end, and optional project. All-day events, recurrence and exceptions, IANA timezone selection, reminders, event editing and deletion, drag creation, drag move and resize, calendar visibility filters, a current-time line, ICS import/export, undo, and performance measurements remain future work. The current calendar renders event spans in each covered month date and marks events that continue into a time-grid day. Time-grid entries appear at their start hour and show their time in the event details; their visual height does not represent duration, and overlapping entries stack in the same cell.

The view uses the machine's local timezone for date inputs and labels. The stored ISO timestamps are UTC instants. This is sufficient for the current one-off event fields, but does not preserve recurring wall-clock time across daylight-saving changes.

## Verification

Current implementation checks: `npm test` passed all 7 test groups; `npm run test:electron` passed, including Calendar route and period navigation, day/week/month switching, saved event creation, event details, and the existing onboarding and narrow-window flow; `node --check` passed for the calendar, renderer, workspace store, and touched test files. The staged Electron 38.8.6 package included both calendar assets, and its `app.asar` SHA-256 matched the archive installed under `dist`. The previous archive is retained at `dist/calendar-rollback/app.asar-2026-10-20`. The packaged app launched with the `Perflw` window title. Node reports its existing experimental SQLite warning. The smoke test uses a temporary data directory; manually navigating Calendar in the packaged app remains unverified.

## Source blueprint

The original `Perflw_CALENDAR_CODEX_BLUEPRINT.md` remains the product input. This document records the implemented MVP against the repository's actual plain JavaScript Electron renderer, SQLite store, and existing IPC boundary. The original blueprint is not copied into the app or treated as executable code.

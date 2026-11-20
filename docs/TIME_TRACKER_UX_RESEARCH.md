# Time Tracker simplicity research

Reviewed 2026-10-21 while simplifying Perflw's existing Time Tracker.

## What the Toggl flow shows

Toggl's official Timer Mode guide describes starting the timer first, then adding a description and optional project details. It treats timer tracking and manual time entry as separate modes. Its time-entry guide describes several ways to create entries, including replaying an earlier entry. Toggl's Favorites article explains that saved common entries can start with one click.

Sources:

- [Timer Mode](https://support.toggl.com/en-us/article/timer-mode-cv33os/)
- [Creating a Time Entry](https://support.toggl.com/en-us/article/creating-a-time-entry-wg8nug/)
- [Introducing Favorites](https://toggl.com/blog/favorites-feature)

The product material demonstrates the flow and available shortcuts; it is not a beginner usability study. The design inference for Perflw is to put the frequent action first, defer optional choices, and keep backfilled time available as a separate path.

## Change in Perflw

The existing Time Tracker keeps its description and Start timer action in the primary view. Project, task, and note fields are collapsed under “Add project, task, or note.” Past-time entry is collapsed under “Add time from earlier,” with its own optional details disclosure. This is presentation-only: the existing account-scoped records, timer behavior, and IPC remain the source of truth.

The Electron smoke checks that only the description label is visible by default, then opens the optional paths and exercises manual and live timing. It also continues into Planner-to-Calendar scheduling and linked task flow.

## Limits

This verifies the Electron flow and persisted behavior covered by the automated checks. It does not establish beginner usability through observed user sessions, nor does it verify every narrow viewport or screen reader combination.

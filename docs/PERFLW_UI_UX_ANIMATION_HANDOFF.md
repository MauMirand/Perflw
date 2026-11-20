# Perflw — UI/UX and Animation Handoff

**Purpose:** Give a new chat the product and interaction context needed to continue UI work consistently.
**Conversation snapshot:** 2026-10-25.
**Workspace:** the repository root

## Source of truth

Use these sources in this order when making design decisions:

1. The user's current request.
2. The user-provided `PROJECT HANDOFF — PERFLW INTELLIGENCE` Markdown/text handoff. The user explicitly designated it as the project reference.
3. The newest user-provided image for the specific layout or control being changed.
4. The current implementation, for facts about what the app really does today.

Do not use old Perflw layouts or screenshots as fresh design references unless the user asks to revive them. Earlier screenshots in this conversation record specific decisions and corrections; they do not authorize a broad return to an old layout. When an image contains markup, distinguish the user's written request from arrows, circles, or crossed-out examples. Use future images as references for the part the user identifies.

Later, more specific instructions supersede earlier values. Preserve the reason behind a request (alignment, legibility, no flicker) when a later measurement refines it. Do not compound repeated speed-up percentages blindly; compare against the current implementation and keep the requested result smooth and legible.

## Product and visual direction

- Perflw is an existing Windows Electron desktop app that is evolving into a minimal, dark workspace. Keep the restrained charcoal surfaces, slate borders, prominent clover branding, and existing Roboto assets described in the project handoff.
- The user's project direction prioritizes low-friction capture, one clear next action, schedules and focus, and a calm return after interruptions. Keep screens simple and readable; give dense content room to breathe without adding decorative clutter.
- Treat a supplied reference as a concrete layout target for the named area. Do not invent a new visual system or bring in outside design references unless asked.
- Keep real account-backed data and existing app behavior. Do not use screenshot/demo data as product content.
- Make small, coherent changes in the existing Electron architecture. Avoid unrelated redesigns, new dependencies, external services, or mock behavior.

## Sidebar preferences

### Expanded sidebar

- Keep the current feature categories: Planner (Calendar, Planner, Projects), Personal (Finance, Health & Exercise, Analytics), Focus (Time Tracker, Skills), and Chat Sessions.
- Keep all entries visible without a scrollbar at the intended desktop size. The user accepted a modest spacing increase with this constraint.
- Most recent typography refinements: feature text **13 px, regular weight** (this supersedes an earlier 14 px request); category headings **12 px** with a **20 px** heading height.
- The requested feature icon-to-text gap is **13 px** (supersedes 11 px). Vertically center icons on their text.
- A prior baseline request set rows to **30 px**. The later expanded-sidebar refinement asked for **4 px more row separation** and **6 px more between categories**. Recheck the current layout before interpreting those as literal additive CSS dimensions; the goal is a visibly more breathable list while all entries remain visible.
- Keep feature labels and category hierarchy clear. Category label interaction toggles its contents, as described in the project handoff. The former Tasks logo-only feature page is now Skills; task records and task workflows remain in Planner and related features. The Skills page is currently a descriptive shell, not a full skill-management workflow.

### Collapsed sidebar

- Keep each feature icon on the same horizontal alignment line as its expanded-state icon; collapsing should make the icon rail compact while preserving predictable alignment. The toggle, feature icons, and profile should share a visually centered horizontal axis.
- The clover logo stays aligned to the collapsed toggle column and should not jump horizontally between states. The latest explicit logo size request was **50 × 50 px**; it supersedes the earlier “100% bigger” instruction.
- Home and Capture icons were requested at **18 × 18 px**. Capture sits beside Home in the sidebar; the search field belongs in the upper ribbon. The Calendar “Add schedule” control is a separate toolbar button beside the Days/Weeks/Months switch.
- Keep one Chat Sessions icon in the collapsed rail rather than one icon per chat.
- Give separate categories visible vertical breathing room. One prior adjustment moved the feature icons from Calendar through Chat Sessions down **9 px**; check the current reference/state before repeating that offset.
- Show a tooltip for each collapsed feature icon. Anchor it outside the rail, on the content side, above overlapping page content, and label the feature. Do not show this tooltip when the sidebar is expanded. Keep the restrained hover tilt on collapsed icons.
- Wide/collapsed toggling should feel smooth and lightly bouncy, with no jarring jump. The requested sidebar toggle timing was **60% faster** than its then-current animation.

## Calendar layout and behavior

- Calendar supports Days, Weeks, and Months. Use the existing 6 AM–10 PM grid, 52 px time gutter, Roboto, and current account-scoped schedule/event data. Keep time labels outside the cell outlines and vertically centered; the timestamp gutter itself has no border.
- The right upper information panel shows today's date and today's schedules. Each schedule entry includes its schedule name, project name (or a clear no-project state), time, and theme color.
- The only schedule themes requested so far are **light blue**, **gold**, and **maroon red**. A schedule's theme colors its occupied time span in the calendar grid (for example, a red event from 9:00–10:30).
- Provide an “Add schedule” icon button immediately to the left of the calendar view switch, with a tooltip. Keep it distinct from the Capture action.
- In Week and Day views, dragging from a start time to a drop time selects that interval and opens the existing schedule editor with the start and end prefilled. Preserve the existing create/edit behavior and validation that the end is later than the start.
- Keep current schedules visible in their real date/time scope. Avoid unrelated calendar features such as recurrence, reminders, or external calendar sync unless explicitly requested.

## Motion specifications

### General motion rules

- Motion should explain continuity and state change. Favor a clean, single-direction move, opacity, and size changes over unrelated movement or simultaneous effects.
- Prevent flicker: keep the same visual object present while its geometry changes; avoid tearing down and rebuilding visible content mid-transition when an overlay/morph can preserve continuity.
- Keep the requested outer calendar shape and timestamp gutter stationary when a transition calls for it. Clean up animations and temporary overlays if the user changes views before motion ends.
- Respect reduced-motion settings. Keep controls usable during motion and avoid blocking rapid navigation.
- User speed requests have included: Calendar page exit fade-down **80% faster**; general Calendar display switching **60% faster**; Month → Week **80% faster**; profile OUT **60% faster**; sidebar wide/collapsed toggle **60% faster**. These were relative requests made at different points in iteration. Treat the most specific/latest request as the target, inspect the actual duration, and do not multiply all historic percentages together.

### Calendar view transitions

- **Day ↔ Week:** Keep the month/year text at exactly the same position with no animation or layout change. Week → Day expands the selected date column horizontally until it fills the calendar; the date label slides to the center of the header row. Keep the calendar frame and time gutter fixed. Avoid shrinking/collapsing the whole week, flicker, or unrelated movement.
- **Month → Week:** Use the user's requested sequence: clear/fade the month table contents while the calendar outline stays still; morph the calendar surface from month proportions into week proportions; move the month/year heading to its week-view position; fade/slide timestamps in from the left; bring the weekly grid in; then bounce/fade the weekday and date labels into their final header positions. Keep the motion fast, coherent, and free of flicker.
- **Week → Month:** Preserve the established Monday–Sunday ordering and morph the weekly layout into the month grid. Keep date/weekday labels legible throughout.
- The view switch control itself may use a small, quick bounce. Do not let its animation disturb the page layout.

### Sidebar and profile transitions

- Sidebar expand/collapse uses a smooth, restrained bounce. Icons should travel with the rail and preserve their alignment.
- On feature-page navigation, the home banner, bio, and edit control leave; the profile and name move toward the lower-left sidebar position. Returning home reverses this path, then restores banner, name, bio, and edit control.
- Keep the avatar circular and layered above the banner. The project handoff specifies a fast, bouncy profile motion; the latest OUT speed request was 60% faster. In the OUT sequence, profile movement starts halfway through the name/bio/edit motion without extra delay; those elements fade as they move, and the banner fades downward faster. On IN, bring name then bio in from near the profile and fade the banner upward rather than popping it in from a shrunken size.
- Keep page switching responsive while profile motion is running.

## Existing app boundaries and implementation map

- `src/main.js` — Electron main process and IPC handlers.
- `src/preload.js` — restricted renderer bridge.
- `src/renderer.js` — navigation and UI interaction wiring.
- `src/index.html` — app markup.
- `src/styles.css` — global and workspace styling.
- `src/calendar/calendar.js` and `src/calendar/calendar.css` — Calendar rendering, interactions, and local view motion.
- `src/workspace.js` — account-scoped SQLite persistence and migrations.
- `test/electron-smoke.js` — Calendar and Electron smoke coverage.

Preserve account isolation, the restricted preload boundary, and non-destructive SQLite migrations. For an existing Calendar capability, inspect and reuse its current UI/API rather than making a parallel path. Verify current code before assuming an earlier note describes the installed/live app.

## Working and verification preferences

- Execute clear UI/code requests directly. Infer ordinary implementation details and ask only when a real conflict prevents a sound choice.
- Keep progress messages short during longer work. Explain what changed, why, how it was checked, and any remaining verification boundary.
- Define observable success before a nontrivial change. Inspect the rendered flow, relevant interaction states, accessibility, and responsive behavior. For localization/RTL-sensitive layout, check directionality when the feature supports it.
- After each code mutation, run a fresh, focused check. For Calendar work, the main smoke command is `node test/electron-smoke.js --calendar-only`; run `node --check <file>` on edited JavaScript and the relevant workspace test when persistence changes.
- Capture screenshots or browser evidence for motion/layout claims where practical. A source check or smoke test does not prove the packaged Windows app was rebuilt or visually checked; say so when that was not done.
- Final reports must list changed files, exact check outcomes, and what was not verified. Treat repeated Riqor stop-hook messages as verification gates, not new design requests.

## Most recent conversation implementation snapshot

The latest feature request added the Calendar today-information panel, themed schedules, an Add schedule toolbar button, and drag-to-create in Day/Week views. The recorded source checks and workspace tests passed; `node test/electron-smoke.js --calendar-only` passed on retry after a temporary Chromium profile cleanup lock. The packaged desktop app and manual visual review were not verified in that implementation turn. Re-run checks before making claims about the current checkout.

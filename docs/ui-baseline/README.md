# Learning UI baseline (D12 / S7)

Screenshots of the Learning pages as they were on `main` 70f0af1 (before any journey, bank, quiz or results UI), at 1280 px
and 400 px wide. Every renderer task from LS-008 on compares its new screens against these in review (task standard S7).

| File | Page |
|---|---|
| `01-subject-grid-preview-*.png` | Subjects grid with the preview panel open |
| `02-subject-grid-*.png` | Subjects grid |
| `03-subject-page-*.png` | Subject page: header, Topics card, Mastery Statistics placeholder |
| `04-topic-viewer-side-panel-*.png` | Topic viewer (PDF) with the side panel on Key points |

- Made by `capture.js` with a throwaway data folder (`PERFLW_TEST_USER_DATA` under the OS temp folder, removed at the end).
  Never the owner's real data. One fixture subject ("Calculus"), one generated two-page PDF topic.
- Regenerate: from a folder that has `node_modules`, `node docs/ui-baseline/capture.js [outDir]`
  (`PERFLW_ELECTRON_APP_DIR` selects another checkout).
- Limit: the 400 px captures resize the viewport of a window whose real minimum is 960 px (`main.js` `minWidth`), so they show
  how the layout reacts to a narrow viewport, not a size the app window can reach. The sidebar stays open at 400 px.
- A toast ("Added Unit notes.pdf…") is visible in `03-*` and `04-*`; it is part of the capture, not of the page layout.

# Perflw architecture and engineering standards

Owner: Claude A (lead architect). Verified against `e9cc8ae` (app code as of `a54858c`) on 2026-11-23.
Product name in code and package: **Perflw** (formerly Impct Intelligence).

## 1. System shape

Offline-first Electron 38 desktop app, Windows x64, Node 22. No framework, no bundler: plain CommonJS in the
main process and plain scripts in the renderer.

```
Renderer (sandboxed, contextIsolation, CSP 'self')     src/index.html + renderer.js, learning*.js, projects.js, ...
        │  window.perflw.*  (contextBridge)
Preload                                                src/preload.js
        │  ipcRenderer.invoke(channel, ...args)  →  { ok, value } | { ok:false, error }
Main process                                           src/main.js  (handle() wrapper, assertSender)
        ├── auth.js            accounts + sessions      node:sqlite
        ├── workspace.js       planner, projects, learning, focus, chat, finance   node:sqlite
        ├── automation/*       agents, skills, providers, Ollama, chat engine, packages
        └── learning-workflow / -intel / -images / -agents   document pipeline → files under userData
Data: %APPDATA%\Perflw  (SQLite DBs, learning-files/<account>/..., encrypted session + API keys via safeStorage)
Generated visuals: perflw-sandbox: scheme, iframe sandbox="allow-scripts", no-network CSP
```

### Layer rules
- **Domain rules are pure modules** with unit tests: `project-model.js`, `topic-model.js`, `home-layout.js`,
  `chat-render.js`. New business rules go in a pure module first, UI second.
- **Main owns all I/O.** The renderer never touches the file system or network; it calls a channel.
- **Every IPC channel** is registered through `handle()` in `main.js`, which checks the sender and wraps the
  result. Channel names are `area:verb` (`workspace:`, `learning:`, `automation:`, `agents:`, `skills:`,
  `chat:`, `auth:`, `providers:`, `planner:`, `window:`, `app:`). About 120 channels exist today.
- **Every handler re-derives the user** (`requireUser()`) and checks ownership of any id it receives
  (example: `workspace.topicFile(user.id, fileId)` before touching annotation files). Never trust an id from
  the renderer.
- **Inputs from the renderer are normalized in main** (see `cleanAnnotations`): type-check, clamp lengths and
  counts, whitelist enums.

### Security baseline (keep it)
`nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, window-open denied, navigation blocked,
strict CSP in `index.html`, external links only via `shell.openExternal` after URL parsing. Secrets only via
`safeStorage`. A change that weakens any of these needs an explicit architect review.

## 2. Persistence

- SQLite through `node:sqlite` (`DatabaseSync`), `PRAGMA foreign_keys = ON`.
- **Schema evolution is versioned** (PF-006, ADR-002) through `src/db-migrate.js`:
  `migrate(db, { name, migrations, backup })`. The version is `PRAGMA user_version`; `migrations` is an ordered
  list `{ version, up(db) }` numbered 1, 2, 3, …. Each pending migration runs in its own `BEGIN IMMEDIATE … COMMIT`
  together with the `user_version` update; on error it rolls back and throws a plain-language message.
  `PRAGMA foreign_keys = ON` is set per connection before migrating (it is a no-op inside a transaction).
- **Migration lists**: `WORKSPACE_MIGRATIONS` (`src/workspace.js`) and `ACCOUNT_MIGRATIONS` (`src/auth.js`).
  Version 1 of each is the former startup bootstrap, idempotent, so every pre-PF-006 install (version 0, any
  subset of old columns) reaches the same shape. Workspace v1 includes the tables of the automation modules
  (`createAutomationSchema`, `createSessionSchema`, `createConnectionSchema`); their store constructors no
  longer run DDL. A new schema change is a new numbered migration, never an edit of an applied one. Version 2
  is reserved for the Learning System tables (LS-005).
- **Backup**: before the first pending migration on a file that already has tables, a `VACUUM INTO` copy is
  written next to it as `<file>.bak-v<from>-<timestamp>` (written as `.tmp`, checked with `quick_check`, then
  renamed); the newest 3 are kept. A failed backup stops the upgrade before any change. The live file is never
  moved or deleted. A file whose version is newer than the app knows is left untouched.
- Files: write to `<file>.tmp` then `rename` (atomic on the same volume), mode `0o600`. Not every writer does
  this yet (PF-007, ADR-003).

## 3. Testing

| Command | What it proves | Runtime |
|---|---|---|
| `npm test` | 126 unit tests over pure modules and the stores (`node --test`) | ~100 s |
| `npm run test:electron` | Drives the real app through the UI over the DevTools protocol, with screenshots | minutes |
| `npm run test:learning`, `test:pdf`, `test:automation` | Feature smoke runs | varies |
| `bench:*`, `diag:*` | Quality benchmarks, not pass/fail gates | varies |

Do not pipe a test command into `tail`/`head` when you need its result; the pipe hides the exit code. Use
`cmd > log 2>&1; echo EXIT=$?`.

**Every git worktree runs `npm ci` before `npm run test:electron`.** The main process finds a parent folder's
`node_modules`, but the renderer loads pdf.js by URL from `<app>/node_modules` (`src/learning-pdf.js:23`), so a
worktree without its own install fails in the PDF viewer. Since PF-004 the smoke test stops at start with that
instruction.

## 4. Recommended conventions (proposed by Claude A; `CLAUDE.md` §7 is the approved standard)

1. **Correctness first**: a bug fix starts with a failing test that reproduces it.
2. **Pure logic gets unit tests; UI behavior gets a step in `electron-smoke.js`.** A feature is not done
   without both where both apply.
3. **No new runtime dependency** without architect approval (source, version pinned, license, size). Today
   there is exactly one: `pdfjs-dist`.
4. **Data safety**: any schema change is a migration (once PF-006 lands), runs in a transaction, and has a test
   that upgrades an old database. Never drop user data without a backup.
5. **Untrusted input**: renderer arguments, uploaded files, AI output and imported packages are all untrusted.
   Validate in main and size-limit everything.
6. **Small modules**: a new file should stay under ~600 lines. Do not add more to `renderer.js` (120 KB);
   put new features in their own module.
7. **Style**: CommonJS, 2-space indent, single quotes, `const` by default, early returns, comments say *why*.
   User-facing error text is plain language with no internals.

## 5. Multi-agent workflow

Defined in `CLAUDE.md` §5–6 and the files in `coordination/`. Two additions from experience:

- Capture real exit codes (`cmd > log 2>&1; echo EXIT=$?`); a pipe to `tail` reports success on failure.
- Never use a bare `git stash`: the stash stack is shared by every worktree.

# DataTrip

DataTrip is an original, fast, lightweight database IDE built with Rust and Tauri. It features a liquid-glass UI and is designed for people who want a focused tool for querying and editing data without a heavy runtime.

## Installation

Download the installer for your system from the [latest release](https://github.com/sepehr-dh99/data-trip/releases), or from the **Artifacts** section of the newest successful run under [Actions](https://github.com/sepehr-dh99/data-trip/actions) (sign in to GitHub to download artifacts; they come as a `.zip`).

> The installers are not code-signed yet, so macOS and Windows show a warning the first time. The steps below get past it.

### macOS

1. Open `DataTrip_<version>_aarch64.dmg` on Apple Silicon Macs (M1 and later) or `DataTrip_<version>_x64.dmg` on Intel Macs, and drag **DataTrip** into **Applications**. ( › About This Mac shows which one you have.)
2. Remove the download quarantine flag, which macOS uses to block unsigned apps:
   ```bash
   xattr -dr com.apple.quarantine /Applications/DataTrip.app
   ```
   Alternatively, open DataTrip once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
3. Launch DataTrip from Applications or Spotlight.

### Windows 10 / 11

1. Run `DataTrip_<version>_x64-setup.exe` (or the `.msi` for managed installs).
2. If SmartScreen says "Windows protected your PC", click **More info → Run anyway**.

### Linux

**AppImage** (any distribution):
```bash
chmod +x DataTrip_<version>_amd64.AppImage
./DataTrip_<version>_amd64.AppImage
```
On Ubuntu 22.04+ install FUSE 2 first if it does not start: `sudo apt install libfuse2` (Ubuntu 24.04: `libfuse2t64`).

**Debian / Ubuntu package:**
```bash
sudo apt install ./DataTrip_<version>_amd64.deb
```

Passwords are stored in the system keychain (macOS Keychain, Windows Credential Manager, or the Secret Service on Linux, e.g. GNOME Keyring or KWallet).

## Supported databases

- PostgreSQL
- MySQL / MariaDB
- SQLite
- SQL Server (MSSQL)

## Features (v1)

- **Connections** with passwords stored in the OS keychain (never in the connection file).
- **Schema explorer** showing schemas, tables, views, columns and primary keys.
- **SQL editor** with schema-aware autocomplete (CodeMirror 6) and **Format SQL** for the selection or the statement at the cursor (PostgreSQL, MySQL, SQLite and SQL Server dialects).
- **Statement-at-cursor execution**: run the statement under the cursor, or run the whole script.
- **Results grid** that stays responsive on large result sets (virtualized), with in-place editing of rows.
- **Transactions** in auto-commit or manual mode, with commit and rollback.
- **Cancel** for long-running queries.
- **History** of executed statements, searchable per connection, with configurable retention (30 days, 90 days, 1 year or forever) and a one-click clear.
- **Restore consoles on launch**: open tabs come back in their manual order with their text, cursor position, database and attached sources; data sources connect only when a tab is used.
- **Auto-reconnect**: when a connection drops, read-only statements are reconnected and re-run once; other statements show the error with a Reconnect button.
- **Export** of query results to CSV or JSON.
- **Import from DataGrip**: paste copied data-source settings (`#DataSourceSettings#`) or pick a project's `.idea/dataSources.xml`.
- **HashiCorp Vault authentication**: token from `~/.vault-token`, `VAULT_TOKEN` or the keychain; KV v1/v2 and dynamic database credentials.
- **Command palette** (Cmd+K / Ctrl+K): every action with its shortcut, plus your data sources, the tables the explorer has loaded and the open tabs; fuzzy filter, arrow keys, Enter to run.
- **App menu**: a native menu bar on macOS (DataTrip, File, Edit, View, Console, Window, Help; Settings… sits under DataTrip); on Windows and Linux the same menus open from the ☰ button at the left of the tab bar. A toolbar at the bottom of the sidebar opens Settings, Vault profiles, SSH configurations, Query history and Import from DataGrip.
- **Cross-source queries** in any SQL console: refer to a table of any data source in your list as `dataSource.database.table` and DataTrip joins them for you, e.g. `select * from asia32.postgres.users a join stage_mysql.shop.users b on b.email = a.email`. The data source name is its name in the explorer in lowercase with `_` for spaces and other characters ("Stage MySQL" → `stage_mysql`; the explorer tooltip shows it), or the exact name quoted (`"Stage MySQL".shop.users`). PostgreSQL and SQL Server take an optional schema (`asia32.postgres.sales.orders`; default `public` / `dbo`); SQLite also accepts `source.table`. Filters on one table run at the source, the join runs in memory, and a "How it ran" panel shows each pull. Nothing needs to be attached; the older `alias.schema.table` form with attached aliases keeps working. Cmd-click (Ctrl-click) two or more data sources → **New cross-source console** opens a console with a short guide and an example query built from real tables; `source.`, `source.database.` and `source.database.schema.` autocomplete databases, schemas and tables; dragging a table from another data source inserts `source.database.table`.
- **AI assistant in consoles** (Cmd+I / Ctrl+I or **✦ Ask AI**): describe a query in words and the **Codex CLI** you are already signed in to with ChatGPT writes it — no API key. Claude Code, **OpenCode** (any provider you signed in to with `opencode auth login`; model as `provider/model`), an OpenAI-compatible API key (kept in the keychain) or a local Ollama model work too (Settings › AI assistant). Only the schema of the tables your question is about is sent (names and types, never rows unless you turn on sample rows); the SQL appears as a highlighted insertion you **Accept** (Tab), **Reject** (Esc), **Refine…** or **Explain** — nothing runs until you run it. A failed statement gets **✦ Fix with AI**, shown as a diff; with text selected, **Explain selection**. Production data sources (read-only, or "prod" in the name or folder) are blocked by default. The assistant knows all your data sources by their SQL names: ask for something that needs another data source (name it, or a table only it has, or say "across sources") and it writes a cross-source query (`source.database.table`, SQLite outer query) with the schemas of each source, checked locally before you see it. Settings › AI assistant › Model lists each provider's models (`opencode models`, `codex debug models`, Claude Code aliases, the API's `/models`, Ollama) — or type any model id. Install Codex with `npm i -g @openai/codex`, then run `codex login` once.
- **Safeguards**: a console left idle closes its database session after 15 minutes (Settings › Data & history; never during a transaction or a running query) and reconnects silently on the next run; only the 10 most recently used consoles keep a live editor, the others keep their text, undo history and results.
- **Error positions**: when PostgreSQL, MySQL or SQL Server report where a statement failed, the token is underlined in the editor (hover for the message) and the error view offers **Go to error**.
- **Redis Sentinel**: list the sentinels and the master name; DataTrip asks the sentinels where the master (or a healthy replica) is, connects to it with TLS / ACL user / DB index like a standalone server, and follows a failover on reconnect. Sentinels may have their own password (kept in the keychain), SSH tunnels cover the sentinels and the nodes they report, and Test connection shows which sentinel answered, the master, its replicas and the PING time.
- **SQL files**: save a console as a `.sql` file (Cmd+S / Ctrl+S; Save as… Shift+Cmd+S), open one (Cmd+O / Ctrl+O) against a data source and database remembered per file, export the selection as `.sql`, recent files in File ▾ and the command palette, or drag a `.sql` file onto the window to open a copy. A console bound to a file is named after it, shows ● for unsaved changes and offers Reload / Keep mine / Compare when the file changes on disk.
- **Run SQL file** on a data source (right-click it, or File ▾): runs a script of any size statement by statement straight from disk, with progress, failures with line numbers, Stop, and options — stop on the first error, one transaction per N statements, or one transaction for everything. MySQL `DELIMITER` and SQL Server `GO` work.
- **Query parameters**: write `:name`, `?` (MySQL / SQLite / SQL Server) or `$1` (PostgreSQL) and running the statement opens a small form under it — one field per parameter with the column it is compared to, text / number / date, NULL, validation, and values remembered per console. The values used show as chips above the result.
- **Explain plan** (Cmd+Option+E / Ctrl+Alt+E): the plan as a tree in the result area — estimated vs actual rows with misestimate flags, time or cost per step, the slowest step marked, an index hint with **Copy CREATE INDEX**, and the raw plan. ANALYZE (PostgreSQL, MySQL 8.0.18+, and SQL Server's actual plan via SET STATISTICS XML — rows summed over threads, per-operator elapsed time) and BUFFERS (PostgreSQL); writes are analyzed only after you confirm, inside BEGIN … ROLLBACK.
- **Sessions & locks** (right-click a data source): every server session with user, application, state, duration and what it waits for; lock-wait chains highlighted; filters, auto-refresh, and Cancel query / Kill session with a confirmation that shows the exact command (PostgreSQL, MySQL, SQL Server).
- **Snippets**: type `sel`, `selw`, `cnt`, `ins`, `upd`, `del`, `j`, `lj`, `gb`, `ob`… and press Tab; placeholders (`$TABLE`, `$COLUMN`, `$CURSOR`, `$SELECTION`, `$DATE`) become fields with table / column completion. Edit them or add your own in Settings › Snippets.
- **Production data sources**: mark a data source as Production (with a color) in its connection dialog — a PRODUCTION bar in its consoles, a PROD tag in the explorer, and a confirmation before writes showing the statement kind, table, filter and estimated rows; DROP / TRUNCATE ask you to type the data source's name. Grid edits (counts per kind and the exact statements), Redis write commands and key actions (FLUSHDB / FLUSHALL and folder deletes need the typed name) and Kafka produce / create / delete topic / reset offsets are confirmed too. AI is blocked for them.
- **Cell value viewer**: double-click a long, JSON or binary cell (or Shift+Enter, or right-click › Open value) and a panel docks right of the grid, following the selected cell — Text, JSON (formatted, colored, foldable; big numbers kept exact) or Hex (default for binary), wrap, size and line count, Copy. On editable results, Edit checks JSON as you type and **Save to grid** makes it a pending edit you submit like any other.
- **Show DDL** (right-click a table, view, routine, sequence or index, or Cmd+Option+D / Ctrl+Alt+D): a read-only tab with the CREATE statement read from the catalog — columns, constraints, indexes and comments (each toggleable), schema-qualified or not — with Copy and Open in console (PostgreSQL, MySQL, SQL Server, SQLite).
- **Import data** (right-click a table or schema, File menu, Cmd+K): a 5-step wizard for CSV / TSV / JSON array / NDJSON files of any size — detected delimiter, quote, header and encoding with a live preview, column mapping with type checks and one-click fixes (date format, NULL text) or a new table with inferred types, truncate, skip / update on conflict, batch size, commit per batch or all-or-nothing, then progress with inserted / skipped / failed rows and their reasons. Rows go in as batched, parameterized multi-row INSERTs.
- **Table designer** (right-click a schema › New table…, a table › Edit table…): columns (name, type from the engine's list or typed, not null, default, PK, comment; reorder, drop, restore), indexes and foreign keys, with a live preview of the exact CREATE / ALTER statements per engine (SQLite rebuilds the table when ALTER can't). Apply confirms and runs them in one transaction where the engine allows.
- **Help center** (F1, the ? in the sidebar, Help menu, Cmd+K): searchable, offline articles for every feature with examples you can try or copy; a four-step welcome tour on first launch (Help › Welcome tour); "What does this mean?" on errors DataTrip knows (Kafka host names, expired Vault tokens, SSH host keys, Redis and Kafka command errors with the command's syntax…) and small ? hints next to tricky connection-dialog fields.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Run statement at cursor | Cmd+Enter | Ctrl+Enter |
| Run all statements | Cmd+Shift+Enter | Ctrl+Shift+Enter |
| New console | Cmd+N | Ctrl+N |
| Close tab | Cmd+W | Ctrl+W |
| Format SQL | Cmd+Option+L | Ctrl+Alt+L |
| Explain plan | Cmd+Option+E | Ctrl+Alt+E |
| Expand a snippet | Tab | Tab |
| Submit grid edits (result grid focused) | Cmd+S | Ctrl+S |
| Open history | Cmd+Shift+H | Ctrl+Shift+H |
| Command palette | Cmd+K | Ctrl+K |
| Ask AI (in a SQL console) | Cmd+I | Ctrl+I |
| Accept / reject an AI suggestion | Tab / Esc | Tab / Esc |
| Settings | Cmd+, | Ctrl+, |
| Save SQL file / Save as… | Cmd+S / Shift+Cmd+S | Ctrl+S / Ctrl+Shift+S |
| Open SQL file | Cmd+O | Ctrl+O |
| Help | F1 | F1 |
| Show DDL of the selected object | Cmd+Option+D | Ctrl+Alt+D |
| Open the value viewer (result grid focused) | Shift+Enter | Shift+Enter |

## Development

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Node.js](https://nodejs.org/) 22
- Platform dependencies for Tauri 2, as described in the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)

On Ubuntu 22.04 the packages used in CI are:

```
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libdbus-1-dev pkg-config build-essential libssl-dev libgtk-3-dev
```

### Commands

```
npm install          # install frontend dependencies
npm run tauri dev    # run the app with hot reload
npm run tauri build  # build installers for the current platform
node scripts/test-ops.mjs         # parameters, explain parsing, sessions, snippets, production checks
```

## Releases

Releases are built by GitHub Actions (`.github/workflows/release.yml`):

- Pushing a tag such as `vX.Y.Z` builds the app for macOS (Apple Silicon and Intel `.dmg`), Windows (`.msi` and `.exe`) and Linux (`.AppImage` and `.deb`) and attaches them to a **draft** GitHub release.
- Every push to `main` (and every pull request) builds the same installers and uploads them as workflow artifacts, without creating a release.

## Project layout

```
CONTRACT.md              architecture and IPC contract
package.json             frontend scripts and dependencies
index.html, vite.config.ts, tsconfig.json
src/                     frontend (vanilla TypeScript)
  main.ts                bootstraps the app
  types.ts, api.ts       IPC types and typed invoke() wrappers
  sqlsplit.ts            SQL statement splitter
  ui/*.ts                UI components
  styles/glass.css       liquid-glass design system (shell.css, settings.css, nav.css build on it)
src-tauri/
  Cargo.toml, build.rs, tauri.conf.json
  capabilities/          Tauri permission capabilities
  icons/                 application icons (generated by scripts/make_icons.py)
  src/
    lib.rs               app builder, plugins, state, command registration
    app_menu.rs          native macOS menu bar (custom items emit the "menu" event)
    commands.rs          Tauri commands
    model.rs, error.rs   IPC types and error type
    store.rs             connection configs, keychain passwords, history
    ai.rs                AI assistant: provider detection (Codex / Claude Code / OpenCode CLI, API key, Ollama), model catalogs and generation
    session.rs           open sessions, cancel, transaction mode
    sqlfile.rs           SQL files: read / write with change detection, Run SQL file (streaming splitter + runner)
    ddl.rs, ddlgen.rs    Show DDL per driver (catalog queries) and the DDL text assembly (std-only, unit-tested)
    import.rs, importfmt.rs  Import data: preview + streaming batched INSERTs; CSV / JSON parsing, detection, type inference, conversion (std-only, unit-tested)
    export.rs            CSV and JSON export
    db/                  drivers: postgres, mysql, sqlite, mssql
scripts/make_icons.py    regenerates the application icons with Pillow
.github/workflows/       CI and release workflows
```

## Design goals

- **Small installers.** Native system webviews instead of a bundled browser engine.
- **Low memory use.** Results are streamed and virtualized rather than loaded whole.
- **Native look.** Window vibrancy and translucency follow each platform's design language.

## License

DataTrip is released under the [MIT License](LICENSE).

## CI builds

Every push runs a quick check (type-check, web build, `cargo check`, clippy). The installers for macOS,
Windows and Linux are built only for a version tag (`v*`, which also creates a draft release), for a manual
run (GitHub › Actions › release › Run workflow), or for a push whose commit message contains `[build]`.

## In-app updates

DataTrip checks its GitHub releases on launch and once a day, shows a card when a newer version is out,
downloads it in the background and restarts into it (Settings › Updates; Help › Check for updates…).
Downloads are verified with the project's update signing key, so this needs a one-time setup:

1. Generate a key pair (choose a password when asked):
   `npx @tauri-apps/cli signer generate -w ~/.tauri/datatrip.key`
2. In GitHub › Settings › Secrets and variables › Actions add:
   - secret `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/datatrip.key`
   - secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password
   - variable `TAURI_UPDATER_PUBKEY`: the contents of `~/.tauri/datatrip.key.pub`
3. Build a release from a tag as usual, then **publish** the draft release: the updater only sees
   published releases (it reads the `latest.json` file CI attaches to them). Pre-releases are offered
   only to users who turn on "Include pre-releases".

Keep the private key safe: every future update must be signed with the same key. Builds made without these
settings still work, with the updater turned off. On Linux, updates install for the AppImage.

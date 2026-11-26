# DataTrip

DataTrip is an original, fast, lightweight database IDE built with Rust and Tauri. It features a liquid-glass UI and is designed for people who want a focused tool for querying and editing data without a heavy runtime.

## Installation

Download the installer for your system from the [latest release](https://github.com/sepehr-dh99/data-trip/releases), or from the **Artifacts** section of the newest successful run under [Actions](https://github.com/sepehr-dh99/data-trip/actions) (sign in to GitHub to download artifacts; they come as a `.zip`).

> The installers are not code-signed yet, so macOS and Windows show a warning the first time. The steps below get past it.

### macOS (Apple Silicon and Intel)

1. Open `DataTrip_<version>_universal.dmg` and drag **DataTrip** into **Applications**.
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

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Run statement at cursor | Cmd+Enter | Ctrl+Enter |
| Run all statements | Cmd+Shift+Enter | Ctrl+Shift+Enter |
| New console | Cmd+N | Ctrl+N |
| Close tab | Cmd+W | Ctrl+W |
| Format SQL | Cmd+Option+L | Ctrl+Alt+L |
| Submit grid edits | Cmd+S | Ctrl+S |
| Open history | Cmd+Shift+H | Ctrl+Shift+H |

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
```

## Releases

Releases are built by GitHub Actions (`.github/workflows/release.yml`):

- Pushing a tag such as `vX.Y.Z` builds the app for macOS (universal `.dmg`), Windows (`.msi` and `.exe`) and Linux (`.AppImage` and `.deb`) and attaches them to a **draft** GitHub release.
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
  styles/glass.css       liquid-glass design system
src-tauri/
  Cargo.toml, build.rs, tauri.conf.json
  capabilities/          Tauri permission capabilities
  icons/                 application icons (generated by scripts/make_icons.py)
  src/
    lib.rs               app builder, plugins, state, command registration
    commands.rs          Tauri commands
    model.rs, error.rs   IPC types and error type
    store.rs             connection configs, keychain passwords, history
    session.rs           open sessions, cancel, transaction mode
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

# DataTrip — architecture & IPC contract

DataTrip is an original, clean-room, cross-platform database IDE: Tauri 2 (Rust backend) + Vite/TypeScript
frontend with no UI framework, CodeMirror 6 for the SQL editor. Nothing here is derived from any other
product's code or assets. Do NOT copy names, icons, or text from other products.

**Nothing can be compiled in the authoring environment** (no crates.io / npm access). CI on GitHub Actions
is the first compiler. Therefore: use only well-known, stable APIs you are certain of; prefer simple code
over clever code; no macros/APIs you are unsure exist in the pinned major versions.

## Layout

```
package.json  index.html  vite.config.ts  tsconfig.json
src/                    frontend (vanilla TS)
  main.ts               bootstraps app
  types.ts              IPC types (mirror of src-tauri/src/model.rs)   <- CONTRACT, do not change shapes
  api.ts                typed invoke() wrappers                        <- CONTRACT
  sqlsplit.ts           statement splitter (quotes, comments, $$ bodies)
  ui/*.ts               components
  styles/glass.css      liquid-glass design system
src-tauri/
  Cargo.toml  build.rs  tauri.conf.json  capabilities/default.json  icons/
  src/main.rs           calls datatrip_lib::run()
  src/lib.rs            builder, plugins, state, invoke_handler
  src/model.rs          IPC types                                      <- CONTRACT
  src/error.rs          AppError
  src/commands.rs       #[tauri::command] fns (names/args below)       <- CONTRACT
  src/store.rs          connection configs (JSON in app config dir) + passwords (keyring) + history (SQLite in app data dir)
  src/session.rs        open sessions registry, cancel, tx mode
  src/db/mod.rs         `DbConn` enum over drivers + shared helpers (quoting, value conversion)
  src/db/{postgres,mysql,sqlite,mssql}.rs
  src/export.rs         CSV / JSON streaming export
.github/workflows/release.yml
```

## Values on the wire
Cells are `serde_json::Value`:
- NULL -> `null`; bool -> bool; integers that fit i64 -> number; floats -> number (NaN/Inf -> string)
- numeric/decimal, i128/u64 overflow, money -> **string** (exact)
- date/time/timestamp/uuid/json/inet/interval/enum/anything else -> **string** (ISO 8601 for temporal)
- binary -> string `"0x" + lowercase hex`, truncated to 4096 bytes with suffix `"…"` when longer
- Unknown/undecodable type -> string `"<type_name>"` (never fail the whole query because of one column)

## Commands (Rust snake_case names; JS passes args in camelCase)

| command | args | returns |
|---|---|---|
| list_connections | – | ConnectionConfig[] |
| save_connection | config: ConnectionConfig, password: string\|null | ConnectionConfig (id filled if empty). password null = keep existing; "" = clear |
| delete_connection | id: string | null |
| test_connection | config, password: string\|null | ServerInfo |
| open_session | connectionId: string | SessionInfo |
| close_session | sessionId: string | null |
| introspect | sessionId | SchemaNode[] |
| execute | sessionId, sql: string, maxRows: number | QueryResult |
| cancel | sessionId | null |
| set_auto_commit | sessionId, autoCommit: boolean | null |
| commit | sessionId | null |
| rollback | sessionId | null |
| apply_edits | sessionId, edits: RowEdit[] | number (rows affected) |
| list_history | connectionId: string\|null, search: string\|null, limit: number | HistoryEntry[] |
| export_query | sessionId, sql, format: "csv"\|"json", path: string | number (rows written) |

Errors: every command returns `Result<T, AppError>`; AppError serializes as `{ "message": string }`.
The frontend shows `message`.

## Semantics
- A session = one dedicated physical connection (needed for manual transactions) behind a `tokio::sync::Mutex`.
- `execute` runs exactly ONE statement (frontend splits scripts). Fetch rows streaming, stop after `maxRows`,
  set `truncated=true` if more existed. Non-row statements fill `rowsAffected`. Records history (ok or error).
- `cancel` aborts the running execute task (AbortHandle). Postgres: also send a server-side cancel when
  feasible; otherwise mark the session connection broken and transparently reconnect on next use.
- Auto-commit default true. When switched off: issue BEGIN on the session connection before the next
  statement if no tx is open; `commit`/`rollback` end it. `SessionInfo.inTransaction` not tracked by UI beyond toggle.
- `read_only` connections: refuse apply_edits and send read-only session settings where the driver supports it.
- `apply_edits` runs all edits in ONE transaction (savepoint if a manual tx is already open), parameterized,
  identifiers quoted per dialect. Postgres: bind non-null values as text and cast `CAST($n AS <column type>)`
  using `columnTypes`. Others: bind as text/number/bool directly.
- `introspect` returns all non-system schemas with tables/views and their columns + primary keys.
  SQLite: one schema "main". MySQL: databases = schemas (exclude information_schema, mysql, performance_schema, sys).
  MSSQL: schemas of the current database (exclude sys, INFORMATION_SCHEMA, db_* roles, guest).
- History DB: `history(id INTEGER PK, connection_id TEXT, sql TEXT, executed_at TEXT ISO, elapsed_ms INTEGER, rows INTEGER NULL, ok INTEGER, error TEXT NULL)`; keep last 5000.
- Passwords: `keyring` service "DataTrip", user = connection id. Never written to the JSON file.

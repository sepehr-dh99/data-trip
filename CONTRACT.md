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

## v0.2 additions

| command | args | returns |
|---|---|---|
| read_text_file | path: string | string (UTF-8, max 8 MiB) |
| test_vault | config: ConnectionConfig, vaultToken: string\|null | VaultCheck |
| set_vault_token | connectionId, token: string ("" clears) | null |

- `ConnectionConfig.authMethod` = "password" (default) | "vault"; `vault: VaultConfig`.
- Vault: GET `{address}/v1/{secretPath}` with `X-Vault-Token` (+ `X-Vault-Namespace`). KV v2 data at
  `data.data`, KV v1 / dynamic at `data`. Dynamic secrets (response has `lease_id`) are cached per connection
  until 30 s before lease expiry so console tabs share one generated DB user; leases are not revoked on close
  (Vault expires them). The Vault username replaces `ConnectionConfig.username` for that connect.
- DataGrip import (frontend only): parses `#DataSourceSettings#` clipboard blocks and `.idea/dataSources.xml`
  (+ optional `dataSources.local.xml` for user names) into ConnectionConfig. DataGrip `uuid` becomes the
  connection id, so re-importing updates instead of duplicating. Passwords are never imported.

## v0.3 additions — server / database / schema explorer

| command | args | returns |
|---|---|---|
| open_session | connectionId, database: string\|null | SessionInfo (now includes `database`) |
| list_databases | sessionId | DatabaseNode[] |
| list_server_objects | sessionId | ObjectGroup[] |

- `open_session` with a database connects to that database instead of the config's default
  (PG/MSSQL: separate connection to that catalog; MySQL: that default database; SQLite: ignored).
- `introspect` returns only the session's database: PG/MSSQL → its non-system schemas; MySQL → exactly one
  SchemaNode named after the current database; SQLite → "main". It now also fills tables' indexes, foreign keys
  and comments, materialized views (PG, kind "materialized"), and per-schema routines and sequences.
- `list_databases`: PG `pg_database` (not template, datallowconn, CONNECT privilege; size when permitted);
  MySQL `SHOW DATABASES` (system ones flagged); MSSQL `sys.databases` with `HAS_DBACCESS = 1` (system flagged);
  SQLite: `main`. Sorted: current first, then user databases A–Z, then system.
- `list_server_objects`: PG → Roles (login/superuser detail), Tablespaces; MySQL → Users (`mysql.user`, may be
  denied → group with `error`); MSSQL → Logins (`sys.server_principals` S/U/G), Databases are listed separately;
  SQLite → []. A permission error on one group never fails the command.
- Explorer tree (DataGrip-style): Connection → Databases (current expanded) and Server objects → Database →
  Schemas (always shown for PG/MSSQL; MySQL/SQLite skip the schema level) → Tables / Views / Materialized views /
  Routines / Sequences → Table → Columns / Keys / Foreign keys / Indexes. Each console is bound to
  (connection, database).

## v0.4 additions — compact explorer, folders, visibility scope, navigator

- `ConnectionConfig.folder` (string|null) groups data sources into explorer folders.
- `ConnectionConfig.scope` (ExplorerScope|null): `databases` (null = all), `schemas` (db → visible schemas;
  missing = all), `showNew` (databases created later are shown). Stored with the connection; UI-only.
- Explorer default density is compact (22 px rows) with a Comfortable option persisted in local settings.
- The capsule shows a breadcrumb navigator `<data source> › <database> › <schema> › Go to…`; each segment opens
  a searchable switcher (↵ switches the console, ⌘/Ctrl+↵ opens a new console there).

## v0.5 additions — Redis

Driver `"redis"` (default port 6379). Config fields used: host, port, username (ACL user, optional), password
(keychain or Vault), database = DB index as text ("0"–"15", default "0"), sslMode "require" = TLS (rediss),
readOnly.

| command | args | returns |
|---|---|---|
| redis_scan | sessionId, pattern, cursor, count, keyType: string\|null | RedisScanResult |
| redis_get | sessionId, key, limit | RedisValue |
| redis_delete | sessionId, keys: string[] | number |
| redis_set_ttl | sessionId, key, ttl: number\|null | null |

- `open_session(connectionId, database)` with database "3" selects DB 3. SessionInfo.database = "3"; serverVersion
  from INFO server (redis_version / valkey_version); defaultSchema = null.
- `execute(sessionId, text, maxRows)` runs ONE Redis command line (shell-like tokenizing: whitespace separates,
  "…" and '…' quote with \-escapes in double quotes). Reply → QueryResult: simple/bulk string, integer, nil →
  one row, column "value" (integer as number); arrays → one row per element, column "value" (nested arrays /
  maps rendered as JSON text); RESP3 maps / HGETALL-style replies of known commands (HGETALL, CONFIG GET,
  XRANGE…) may use columns "field","value"; errors → AppError with the Redis error text. `rowsAffected` = integer
  reply for write commands (DEL, HSET, …). MULTI/EXEC, SUBSCRIBE/PSUBSCRIBE/MONITOR are refused with a clear message.
  Read-only connections refuse write commands (by command name list). History recorded as for SQL.
- `list_databases`: CONFIG GET databases (fallback 16) + INFO keyspace counts; DatabaseNode name "0".."N-1",
  comment = "<keys> keys", is_current for the session DB; sizeBytes null.
- `list_server_objects`: groups "Server" (version, mode, os, uptime), "Memory" (used/peak/maxmemory/policy),
  "Clients" (connected, blocked), "Persistence" (rdb/aof) from INFO; ACL-denied → group error.
- `introspect` for Redis returns [] (the explorer uses redis_scan instead).
- `export_query` runs the command and exports its QueryResult rows.
- Transactions: set_auto_commit/commit/rollback are no-ops for Redis; the UI hides them.
- Cancel aborts the running command task and reconnects.
- DataGrip import: `jdbc:redis://[user:pass@]host[:port][/db]` (and `jdbc:redis:ssl://`) → redis.

## v0.6 additions — Kafka (rust-rdkafka / librdkafka)

Driver `"kafka"` (default port 9092). `host` = bootstrap servers (comma separated; `port` used only when a server
lacks one). SASL creds = username + password (keychain or Vault). `kafka: KafkaConfig` holds security protocol,
SASL mechanism, CA / client cert paths, skip TLS verify, show internal topics. Kerberos (GSSAPI) is not supported.

| command | args | returns |
|---|---|---|
| kafka_overview | sessionId | KafkaOverview |
| kafka_topic | sessionId, topic | KafkaTopicDetail |
| kafka_consume | sessionId, request: KafkaConsumeRequest | KafkaConsumeResult |
| kafka_produce | sessionId, request: KafkaProduceRequest | KafkaProduceResult |
| kafka_group | sessionId, groupId | KafkaGroupDetail |
| kafka_reset_offsets | sessionId, groupId, topic, to, value | number (partitions reset) |
| kafka_create_topic | sessionId, topic, partitions, replicationFactor | null |
| kafka_delete_topic | sessionId, topic | null |

- Consuming never joins or commits a group: manual partition assignment, `enable.auto.commit=false`, a throwaway
  `group.id` (`datatrip-browser-<uuid>`). "latest" = the newest `limit` messages spread over partitions.
- Produce / reset offsets / create & delete topic are refused on read-only connections. Reset requires the group
  to be Empty.
- `execute` on Kafka runs a small command language (one per line):
  `topics` · `groups` · `brokers` · `describe topic <t>` · `describe group <g>` ·
  `consume <t> [--from-beginning|--latest|--from-timestamp <ISO>|--offset <n>] [--partition <n>] [--limit <n>]
   [--key-contains <s>] [--value-contains <s>]` · `produce <t> [key=<k>] [partition=<n>] [header.<k>=<v>]… value=<v>`
  (values may be quoted) · `create topic <t> [partitions=<n>] [replication=<n>]` · `delete topic <t>`.
- `list_databases` → [] ; `list_server_objects` → groups "Cluster" (id, controller, broker count) and "Brokers";
  `introspect` → []. Transactions are no-ops; cancel aborts the job and reconnects.
- DataGrip import: `jdbc:kafka://…`-style or Kafka data sources → unsupported for now (DataGrip stores Kafka
  connections outside dataSources.xml).

## v0.7 additions — shared Vault profiles, SSH tunnels, SSL files

| command | args | returns |
|---|---|---|
| list_vault_profiles | – | VaultProfile[] |
| save_vault_profile | profile, token: string\|null | VaultProfile |
| delete_vault_profile | id | null (refused while connections use it: error lists their names) |
| vault_token_info | profile, token: string\|null | VaultTokenInfo |
| renew_vault_token | profileId | VaultTokenInfo |
| list_ssh_profiles | – | SshProfile[] |
| save_ssh_profile | profile, secret: string\|null | SshProfile |
| delete_ssh_profile | id | null (refused while used) |
| test_ssh_profile | profile, secret: string\|null | SshCheck |
| trust_ssh_host | host, port, fingerprint | null |

- Profiles are stored in `<config>/vault_profiles.json` and `<config>/ssh_profiles.json`; secrets in the keychain.
- `VaultConfig.profileId`: credentials resolution takes address/namespace/token/TLS from the profile; the
  connection keeps secretPath/usernameKey/passwordKey. Saving a profile invalidates the credential cache of every
  connection using it. A Vault 403 with a profile token yields an AppError whose message starts with
  `VAULT_TOKEN_INVALID:<profileId>:` so the UI can offer "Paste new token".
- `ConnectionConfig.sshProfileId`: before connecting, the backend opens (or reuses) an SSH session for the profile
  (russh, keep-alive) and a local forward 127.0.0.1:<ephemeral> → <db host>:<db port> resolved on the SSH server;
  the driver connects to the local end. One SSH session per profile is shared by all sessions; forwards are
  reference-counted and closed when unused. Host keys: trusted store `<data>/known_hosts.json` (+ read-only
  ~/.ssh/known_hosts); unknown host → AppError `SSH_HOST_UNKNOWN:<host>:<port>:<fingerprint>`; changed key →
  `SSH_HOST_CHANGED:…` (hard failure). Supported: PostgreSQL, MySQL, SQL Server, Redis. Kafka over SSH: refused
  with a clear message (brokers advertise their own addresses).
- SSL: sslMode "verify-ca"/"verify-full" + sslCaPath, sslCertPath, sslKeyPath for PostgreSQL and MySQL.
- DataGrip import: `<ssh-properties><enabled>true</enabled>` → warning "uses an SSH tunnel — choose an SSH
  configuration after import"; `<ssl-config>` (ca-cert, client-cert, client-key, mode) mapped when present.

## v0.8 additions — explorer order + appearance

| command | args | returns |
|---|---|---|
| get_explorer_layout | – | ExplorerLayout |
| save_explorer_layout | layout | null |

- `ConnectionConfig.icon` (built-in icon name) + existing `color` style a data source's badge.
- `ExplorerLayout` (`<config>/explorer_layout.json`): top-level order (`folder:<name>`, `conn:<id>`), per-folder
  connection order, folder color/icon. Items missing from the layout are appended alphabetically; stale entries
  are dropped on the next save. Renaming a folder must rename its keys; ungrouping removes them.

## v0.9 additions — export with preview, options and clipboard

| command | args | returns |
|---|---|---|
| export_query_with | sessionId, sql, options: ExportOptions, path | number (rows) |
| write_text_file | path, content | null |

Exact output (frontend `src/ui/exportFormat.ts` and backend `export.rs` must match byte for byte).
Cell → text: NULL → nullText (default ""); bool → `true`/`false`; number → JSON number text as received;
string → as is. Lines end with lineEnding (default "\n"), including after the last line; an empty result
with header still writes the header line.
- **csv**: fields joined by delimiter (default ","). With quote q (default `"`; "" disables quoting), a field
  is quoted when it contains the delimiter, q, `\r` or `\n`, or starts/ends with a space; inner q is doubled.
  NULL is never quoted. Header = column names (same quoting rule) when includeHeader.
- **tsv**: tab-joined, never quoted; in values `\` → `\\`, tab → `\t`, `\n` → `\n` (backslash n), `\r` → `\r`.
- **json**: includeHeader → `[` + objects `{"col": value, …}` one per line, 2-space indented, separated by
  `,` + lineEnding, closing `]`; otherwise arrays of values. Values: NULL → null, bool/number native (number
  text kept verbatim), string → JSON string. Duplicate column names get suffixes `_2`, `_3`. Empty → `[]`.
- **sql**: one statement per row: `INSERT INTO <tableName> (<cols>) VALUES (<vals>);` — the column list only
  when includeHeader; columns quoted with the dialect's identifier quotes (PG/SQLite `"`, MySQL backtick,
  MSSQL `[]`); strings single-quoted with `'` doubled; NULL → `NULL`; bool → `TRUE`/`FALSE` (MSSQL: 1/0).
- **markdown**: `| a | b |` header + `| --- | --- |` (header required: if includeHeader is false, use
  `col1…colN`), cells with `|` → `\|` and newlines → `<br>`, NULL → nullText.

## v0.10 additions — settings, tabs, run gutter, paging, reconnect, cross-source queries, Vault OIDC

Approved designs (read them, they are the spec for look and behavior): `/home/claude/canvas/project/`
`Settings.dc.html` (I), `ConsoleUX.dc.html` (J), `ResultsGrid.dc.html` (K), `CrossSourceOidc.dc.html` (L).

| command | args | returns |
|---|---|---|
| get_settings | – | object (raw JSON; `{}` when none) |
| save_settings | settings: object | null |
| reconnect_connection | connectionId | ReconnectResult |
| federated_execute | sources: FedSource[], sql, maxRows | FedResult |
| vault_oidc_login | profileId, role: string\|null | VaultTokenInfo |
| vault_oidc_cancel | – | null |

- **Settings**: stored verbatim in `<config>/settings.json` (atomic write). The frontend owns the shape
  (`AppSettings` in `src/ui/settings.ts`), merging defaults for missing keys.
- **reconnect_connection**: for every open session of that connection: invalidate the credential cache, drop the
  physical connection and reconnect now (fresh Vault credentials, fresh SSH forward) keeping the session id. In a
  transaction → that session is skipped and reported. `ReconnectResult { sessions: number, skippedInTx: number,
  elapsedMs: number }`. No open session → `sessions: 0` (frontend then just connects).
- **federated_execute**: `FedSource { alias: string, connectionId: string, database: string|null }`. The SQL
  refers to tables as `alias.schema.table` or `alias.table` (alias case-insensitive, `[A-Za-z_][A-Za-z0-9_]*`).
  For each distinct referenced table the backend pulls rows from that source (a temporary session per source),
  then loads them into an in-memory SQLite database and runs the query there (SQLite dialect for the outer query;
  references are rewritten to quoted table names). Pushdown, only when provably safe: projection to the columns
  referenced as `<tableAlias>.<col>` (none if `*`/unqualified columns appear) and top-level `AND`-ed WHERE
  conjuncts that reference exactly one table alias and contain no subquery; literals kept verbatim. Pull cap per
  table: 200 000 rows (exceeding → error naming the table, suggesting a WHERE filter). Only SELECT/WITH.
  `FedResult { result: QueryResult, plan: FedStep[] }`, `FedStep { alias, connectionId, sourceName, sql,
  rows, elapsedMs }` — one step per pull plus a last step `{alias:"", sourceName:"DataTrip", sql:"join … (in
  memory)"}`. Result is read-only. Supported sources: PostgreSQL, MySQL, SQLite, SQL Server.
- **Vault OIDC**: `VaultTokenSource` gains `"oidc"`; `VaultProfile` gains `oidcMount?: string|null` (default
  "oidc") and `oidcRole?: string|null`. `vault_oidc_login`: POST `<addr>/v1/auth/<mount>/oidc/auth_url`
  `{role, redirect_uri:"http://localhost:8250/oidc/callback", client_nonce}`, opens the returned auth_url in the
  default browser, listens on 127.0.0.1:8250 for `GET /oidc/callback?code&state` (answers a small "You can close
  this tab" page), then GET `<addr>/v1/auth/<mount>/oidc/callback?code&state&client_nonce` → `auth.client_token`,
  stored in the keychain exactly like a pasted token; invalidates the cache of connections using the profile;
  returns `vault_token_info`. Times out after 5 min; `vault_oidc_cancel` aborts a pending login (error
  `OIDC_CANCELLED`). Port busy → error saying so. Renewal: frontend calls `renew_vault_token` when a renewable
  OIDC token has < 1/3 of its TTL left (checked every 5 min while the app is open).
- **Paging** (frontend only): a single SELECT/WITH statement is paged by re-running it wrapped:
  PG/MySQL/SQLite `SELECT * FROM (<sql>) AS _dt_page LIMIT <n+1> OFFSET <m>`; MSSQL
  `SELECT * FROM (<sql>) AS _dt_page ORDER BY (SELECT NULL) OFFSET <m> ROWS FETCH NEXT <n+1> ROWS ONLY`
  (inner trailing `;` removed; inner ORDER BY kept for PG/MySQL/SQLite; MSSQL with inner ORDER BY and no TOP →
  page 1 only, pager disabled with a tooltip). n+1 rows fetched → "more available". Count rows:
  `SELECT COUNT(*) FROM (<sql>) AS _dt_count`. Other statements and Redis/Kafka: no pager.

## v0.11 additions — restore consoles, tab order, auto-reconnect, history retention, Format SQL, source databases

| command | args | returns |
|---|---|---|
| get_workspace | – | object (raw JSON; `{}` when none) |
| save_workspace | workspace: object | null |
| prune_history | days: number (u32) | number (entries deleted; `0` days = keep forever → no-op, returns 0) |
| clear_history | connectionId: string\|null | number (entries deleted; null = all history) |
| count_history | connectionId: string\|null | number (entries; null = all history) |

- **Workspace** (`<config>/workspace.json`, same atomic write and file lock as settings.json; refused unless a JSON
  object). The frontend owns the shape (`src/ui/workspace.ts`): `{ version: 1, tabs: WsTab[], active: number }`,
  `tabs` in **manual order** (the order drag-reordering in the rail / top strip produces), `active` = index or -1.
  `WsTab { kind: "console"|"key"|"topic"|"group", key, name, connId, title, database, console?, keyType? }` —
  `key` is the TabStrip's stable tab key at save time (pinned tabs and custom-group members refer to it; a restored
  tab adopts it, so pins/groups match before the data source is connected), `name` the manual tab name (null =
  automatic), `title` the console title / Redis key / topic / group id, `database` the Redis DB index for key tabs.
  `console: { sql, cursor, database, dbHint, schema, schemaExplicit, table, ownAlias, ownDb, sources: {alias,
  connId, database}[], fedShown }` (`dbHint` = effective database when saved, used for tab names until connected;
  `ownAlias` only when edited; `ownDb` = database of the console's own cross-source source, null = the console's).
- Saving (only while `data.restoreConsoles` is on, and never before the saved workspace was restored): debounced
  1 s after tab open / close / activate / reorder / rename, editor text or cursor changes, database / schema /
  source changes; flushed on `beforeunload`, `pagehide`, window blur and `visibilitychange: hidden`. Turning the
  setting off cancels pending saves and writes an empty workspace. If the connection list can't be loaded at start,
  nothing is restored or saved in that session.
- Restoring (at start, when the setting is on): tabs whose connection no longer exists are skipped, the rest are
  recreated in saved order **without connecting**. Consoles get text, cursor, bindings and attached sources (sources
  of deleted / unsupported connections dropped) and connect their data source (explorer connect, with the usual
  Vault / SSH recovery) on first activation or first run. Redis key / Kafka topic / group tabs are placeholders
  until activated, then replaced in place by the real tab (same key, name and position). The saved active tab is
  activated (so only its data source connects at launch).
- **Auto-reconnect** (frontend; `data.autoReconnect`): a SQL console statement failing with a connection-lost error
  (conservative match: connection closed/reset/lost/aborted, broken pipe, terminating connection, server closed the
  connection, lost connection, server has gone away, unexpected EOF, not connected, pool timed out, connection/IO
  "timed out"; never VAULT_/SSH_/OIDC_ errors) while auto-commit is on → `reconnect_connection` silently and re-run
  once, only for read-only statements (first keyword SELECT / WITH / SHOW / EXPLAIN / DESCRIBE / DESC and no
  data-changing keyword anywhere outside literals/comments: INSERT, UPDATE, DELETE, MERGE, INTO, ANALYZE, SET, …).
  Not retried when the reconnect reports 0 sessions or skipped sessions in a transaction. Otherwise (setting off,
  manual transaction, writing statement, Redis/Kafka, retry failed) the error view shows "Connection lost" with a
  **Reconnect** button (explorer reconnect). A statement inside a manual transaction is never retried.
- **History retention** (`data.historyDays` 30 | 90 | 365 | 0): the frontend calls `prune_history` at start and
  whenever the setting changes. Deletion is by `executed_at < now − days` (RFC 3339 UTC text compares in time
  order); index `idx_history_time (executed_at)`. Settings › Data & history › "Clear history…" asks for
  confirmation (showing `count_history(null)`), calls `clear_history(null)` and refreshes the History panel
  (window event `dt-history-changed`). The 5000-entry cap stays.
- **Format SQL** (action `formatSql`, DataTrip/DataGrip preset ⌥⌘L / Ctrl+Alt+L, VS Code preset ⇧⌥F; frontend only,
  npm `sql-formatter` ^15.4): formats the selection (surrounding whitespace kept) or else the statement at the
  cursor (its terminating `;` stays outside the replaced range) with `{ language: postgresql|mysql|sqlite|transactsql,
  keywordCase: "upper", tabWidth: 2, linesBetweenQueries: 1 }`, as one isolated undo step. Formatter errors → toast
  "Couldn't format: …", text untouched. No-op in Redis / Kafka consoles. Works with focus in the console editor or
  outside any text field.
- **Cross-source source databases**: each Sources chip of a server-type source (PostgreSQL, MySQL, SQL Server) has a
  database picker listing the data source's databases (`list_databases` via the explorer's connection entry; the
  source is connected in the explorer first when needed). Attached sources: null = the connection's default
  database. The console's own source: null = the console's current database. Sent as `FedSource.database` and
  persisted in the workspace.

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
- **federated_execute** (naming superseded by v0.13 — cross-source naming): `FedSource { alias: string, connectionId: string, database: string|null }`. The SQL
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

## v0.12 additions

### Redis Sentinel

Approved design: `/home/claude/canvas/project/RedisSentinel.dc.html`.

| command | args (change) | returns |
|---|---|---|
| save_connection | + sentinelPassword: string\|null | ConnectionConfig. null = keep the stored sentinel password, "" = clear |
| test_connection | + sentinelPassword: string\|null | ServerInfo (+ `details`). null/"" = use the stored one |

- `ConnectionConfig.redis: RedisOptions | null` (null = standalone; all fields `#[serde(default)]`):
  `{ mode: "standalone"|"sentinel", sentinels: string[] ("host:port", default port 26379, tried in order),
  masterName: string, readFrom: "master"|"replica", sentinelUsername: string|null, sentinelAuth: boolean }`.
  In sentinel mode `host`/`port` are ignored (kept so switching back restores them); `username`/password (keychain or
  Vault), `database` (DB index), `sslMode` "require" (TLS) and `readOnly` apply to the resolved node.
- Sentinel password: keychain service "DataTrip", user `<connection id>:sentinel` (never from Vault, never in JSON,
  never sent to the UI; deleted with the connection). Used only when `sentinelAuth`.
- `ServerInfo.details?: string[]` — test report lines, each starting with `"✓ "`, `"✕ "` or `"! "` (note), e.g.
  `✕ 10.0.40.11:26379 — connection refused, trying next`, `✓ 10.0.40.12:26379 answered: master “mymaster” is
  10.0.40.21:6379`, `✓ Replicas: 10.0.40.22:6379, 10.0.40.23:6379 (down)`, `✓ Connected to master · role master ·
  AUTH ok · db 14 · PING 4 ms`. Absent for every other driver / standalone.
- Resolution (backend `db/redis.rs`, on every physical connect, so reconnects follow a failover): for each sentinel in
  order (through its own SSH forward when `sshProfileId` is set; SSH errors abort at once): connect (3 s), `AUTH
  [user] pass` when `sentinelAuth`, `SENTINEL get-master-addr-by-name <master>` (nil → that sentinel doesn't know the
  master → next), `SENTINEL replicas <master>` (fallback `SENTINEL slaves`). First answer wins. readFrom "replica"
  → first replica whose flags lack s_down / o_down / disconnected and whose master-link-status is ok; none → the
  master, with a `!` note. Then connect to that node like standalone (TLS uses the same setting as for the
  sentinels; new SSH forward to the reported address, resolved on the SSH server), `ROLE`: a master that answers
  `slave` → resolve once more, then error. PING latency closes the report. Whole connect capped at 45 s.
- Errors: all sentinels failed → `Couldn't reach any sentinel: a:26379 (connection refused); b:26379 (timed out after
  3 s).`; no sentinel knows the name → `Sentinel doesn't know master '<name>' (asked …). Check the master name.`;
  sentinel AUTH → `Sentinel authentication failed: …` (NOAUTH → "needs a password (turn on “Sentinels need their own
  password”)"); master AUTH → `Authentication failed at the master <addr>: …`; other master errors → `Couldn't connect
  to the master <addr> reported by sentinel <addr>: …`.
- Dialog: Redis gets Mode Standalone | Sentinel; sentinel shows the nodes chip input (Enter / comma / paste a comma- or
  space-separated list, validated, ✕ removes, Backspace on empty input removes the last), Master name (empty =
  "mymaster"), Read from Master | Replica, switch "Sentinels need their own password" → username (optional) +
  password; the auth section is titled "Master authentication"; the SSH summary notes "tunnels the sentinels and the
  master they report". Test connection renders `details` with ✓ / ✕ / ! and colours the chips' dots.
- UI labels: `sentinelLabel(cfg)` in `src/ui/redis.ts` → `"sentinel: <master>"` (explorer tooltip, console result
  pill, import preview) instead of host:port.
- DataGrip import: DataGrip's Redis driver has no Sentinel URL, so `jdbc:redis:sentinel…` stays unsupported (message
  points to Mode: Sentinel).

### Navigation & cross-source UX

Approved designs: `/home/claude/canvas/project/Navigation.dc.html` (M), `CrossSourceUX.dc.html` (O). Frontend only,
except the macOS menu bar (`src-tauri/src/app_menu.rs`); no new commands.

- **Sidebar**: the + next to the explorer filter only adds a connection. A toolbar at the bottom of the sidebar has
  Settings (⌘,), Vault profiles, SSH configurations, Query history (⇧⌘H), Import from DataGrip (tooltips: name +
  shortcut) and a "⌘K" pill (command palette). Density moved to View › Compact explorer / Settings › Appearance.
- **Keymap**: new actions `commandPalette` (default Mod-K, all presets) and `askAi` (Mod-I). Both are matched by a
  window *capture* keydown listener in `App` (so CodeMirror's Mod-I "select parent syntax" never sees them), except
  while an `.overlay` dialog is open.
- **Command palette** (`src/ui/palette.ts`): groups Actions (every command with its current shortcut label),
  Data sources (→ open a console), Open tabs (→ activate), Tables (only metadata the explorer already loaded: each
  connected SQL source's default database + databases whose introspection is ready; capped at 5000; → open data like
  a double-click). Fuzzy subsequence filter (substring and word starts rank first), ↑↓ ↵ Esc.
- **Command ids** (`MenuCommand` in `src/ui/appMenu.ts`, dispatched by `App.runCommand(id)`; the macOS menu uses the
  same ids): about, settings, keyboardShortcuts, helpShortcuts, newConnection, newConsole, newCrossSource,
  importDataGrip, vaultProfiles, sshProfiles, reopenTab, closeTab, undo, redo, cut, copy, paste, selectAll,
  tabsTop, tabsLeft, tabsRight, toggleSidebar, compactExplorer, queryHistory, commandPalette, helpPalette,
  runStatement, runAll, cancel, formatSql, askAi, attachSource, reconnect, nextTab, prevTab, jumpToTab,
  crossSourceGuide.
- **macOS menu bar**: `app_menu::with_app_menu(builder)` (cfg macOS; a no-op elsewhere) sets DataTrip (About, Settings…,
  Keyboard shortcuts…, Hide, Hide others, Show all, Quit), File, Edit (predefined undo / redo / cut / copy / paste /
  select all, which keep their accelerators), View, Console, Window (predefined minimize / zoom + tab items), Help.
  Custom items have **no accelerators** (the webview handles and remaps those shortcuts; an accelerator would
  double-fire) and emit the Tauri event **`menu`** with the item id as payload (`core:default` covers listening).
- **Windows / Linux**: no native menu bar. A ☰ button at the left of the console tab bar opens the same structure
  as a two-level in-app dropdown (menu titles → items, with shortcut hints and check marks). Its Edit items act on
  the element that had focus before the menu opened (`execCommand`; paste via `navigator.clipboard.readText`).
- **Ask AI hook**: `askAi` (shortcut, menu, palette) dispatches `window` CustomEvent **`dt-action`** with
  `detail: { id: "askAi" }`, `cancelable: true`. The AI assistant listens for it and calls `preventDefault()` when it
  handled it; unhandled → toast "Ask AI isn't available in this build".
- **Explorer multi-select**: ⌘-click (Ctrl-click elsewhere) on data-source rows toggles them into a selection (the
  first ⌘-click keeps the previously selected source); a plain click clears it. Right-click inside a selection of ≥ 2:
  "N data sources selected", **New cross-source console (N sources)** (SQL sources only, needs 2), Reconnect all,
  Disconnect all, Clear selection.
- **New cross-source console** (explorer selection, File menu, palette; without a selection a picker of SQL data
  sources asks for ≥ 2, the first picked is the console's own source): a console titled "cross-source" (then
  "cross-source 2"…) with the others attached (alias = slug), the Sources strip open and the guide card. The tab
  shows a badge "N sources" (`TabPane.sourceBadge`; the automatic name then omits the database) while sources are
  attached. `WsConsole.crossSource?: boolean` restores it.
- **Guide card**: three steps + "Insert an example query" over the editor; hidden on the first `beforeinput` (typing,
  paste, delete) or ✕; "How does this work?" in the Sources strip (and Help › Cross-source queries guide) shows it
  again. The example (`exampleQuery` in `src/ui/crossSource.ts`) connects / loads the sources if needed and picks one
  table from each of the first two sources with tables: best join `a.<singular(b)>_id = b.id` (either way), then a
  shared `*_id` column, then shared uuid/email/code/sku/name, then `id`; plain tables and the default schema first.
  No join column → the first table of each with a first-column join and a comment to adjust it. Names are bare when
  lower-case identifiers, else double-quoted.
- **Completion** (v0.13 changes completion, the underline and drag insertion — see below): `<alias>.` completes the source's schemas, `<alias>.<schema>.` its tables (own alias and attached
  aliases, only while the Sources strip is in use); introspection comes from the explorer store and is loaded
  lazily (the source is connected in the explorer if needed).
- **Unattached alias**: in SQL consoles of a cross-source driver, `foo.schema.table` (outside strings / comments, not
  preceded by `.`) where `foo` equals the alias slug of a SQL data source that is neither the console's nor
  attached, and is not a database name of the console's server, gets a wavy underline; hovering shows "foo isn't
  attached to this console" with **Attach <Source> (<driver>) as foo** and **Choose source…** (attaches the picked
  one as foo).
- **Drag a table in**: explorer table / view rows of SQL sources are draggable (`application/x-datatrip-table`, JSON
  `{connId, database, schema, table}`; text/plain = the qualified name). Over a console editor a dashed overlay says
  what the drop does. Same data source → inserts `schema.table` (dialect-qualified; `ownAlias.schema.table` while
  the console runs cross-source). Another SQL source → attaches it (alias = slug, unique; its database = the table's
  database when that isn't the default) unless already attached, and inserts `alias.schema.table` at the drop point.
- `tauri.conf.json`: the main window has `dragDropEnabled: false` (no native file drops are used; on Windows the
  native handler otherwise swallows HTML5 drag and drop inside the webview).

### AI assistant

Approved design: `/home/claude/canvas/project/AiAssist.dc.html` (N). Backend `src-tauri/src/ai.rs` (commands
registered as `ai::…` in `lib.rs`, state `ai::AiState` managed separately from `AppState`); frontend
`src/ui/ai.ts` (context, prod detection, providers), `aiPanel.ts` (prompt box, action bar, Fix with AI),
`aiEditor.ts` (CodeMirror extension), `aiSettings.ts` (Settings › AI assistant), `src/styles/ai.css`.

| command | args | returns |
|---|---|---|
| ai_providers | – | AiProviderStatus[] (codex, claude, openai, ollama — always in that order) |
| ai_generate | request: AiRequest | AiResult |
| ai_cancel | – | null |
| ai_set_api_key | key: string\|null | null (null / "" clears) |

- `AiProviderStatus { id, available, signedIn: bool|null, path: string|null, detail, models: string[] }`.
  Codex/Claude: `available` = the CLI (`codex`, `claude`; Windows `.exe`/`.cmd`/`.bat`) is found on PATH or in
  /opt/homebrew/bin, /usr/local/bin, /usr/bin, ~/.local/bin, ~/.npm-global/bin, ~/.volta/bin, ~/.bun/bin,
  ~/.claude/local, ~/.cargo/bin, ~/.nvm/versions/node/*/bin (newest first), %APPDATA%\npm (GUI apps on macOS get a
  minimal PATH). Codex `signedIn` = `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) exists (no process is
  started); Claude `signedIn` = null. openai: `available` = an API key is stored. ollama: GET
  `http://127.0.0.1:11434/api/tags` (1 s timeout) → `available` + `models`.
- `AiRequest { provider: "codex"|"claude"|"openai"|"ollama", model?, baseUrl?, mode: "write"|"fix"|"explain"|"refine",
  prompt, driver, dialectHint?, schemaContext, currentSql?, error? }` → `AiResult { sql: string|null, explanation:
  string|null, elapsedMs, provider }`. The backend builds ONE prompt (rules: "You write <dialect> SQL for DataTrip …
  exactly one ```sql code block and at most two short sentences …", the schema context, then per mode the request /
  the failed statement + error / the previous SQL + requested change / the SQL to explain), runs the provider and
  parses the first ```sql block (else the first fenced block, else the whole reply) as `sql`, the remaining prose as
  `explanation`. `explain` → `sql` null, `explanation` = the reply without fences. **Generated SQL is never
  executed.** Empty reply / no SQL → error.
  - codex: `codex exec --skip-git-repo-check --sandbox read-only --color never --output-last-message <tmp>/answer.md
    [--model m] -` with the prompt on stdin; reply = that file (stdout as fallback).
  - claude: `claude -p --output-format text [--model m]`, prompt on stdin, reply = stdout.
  - Both: `tokio::process`, no shell, cwd = a fresh empty temp dir (deleted afterwards, also on cancel), PATH = the
    CLI's directory + the extra directories + the inherited PATH (node-based CLIs need `node`), `NO_COLOR=1`,
    Windows CREATE_NO_WINDOW, `kill_on_drop`. Non-zero exit → error with the stderr tail; auth-looking errors say to
    run `codex login` / `claude`. Not found → "Codex CLI not found. Install it with `npm i -g @openai/codex`, then run
    `codex login` …".
  - openai: POST `{baseUrl or https://api.openai.com/v1}/chat/completions` `{model (default gpt-4o-mini), messages:
    [{role:"user", content: prompt}]}` with `Authorization: Bearer <key>`; reply = `choices[0].message.content`.
  - ollama: POST `http://127.0.0.1:11434/api/chat` `{model (default: first installed), messages, stream:false}`;
    reply = `message.content`.
  - Timeout 120 s (error names the provider). One request at a time app-wide: a new `ai_generate` cancels the
    previous one; `ai_cancel` kills the process / drops the HTTP request. Cancelled → error starting `AI_CANCELLED:`
    (the UI drops it silently).
- API key: keychain service `"DataTrip-AI"`, user `"openai-api-key"` (in-memory fallback for this run when no
  keychain works). Never returned to the UI.
- **Settings** `ai: { provider (default "codex"), model ("" = provider default; Codex / Claude / API), baseUrl,
  ollamaModel ("" = first installed), autoTables (true), samples (false), blockProd (true) }`. Settings › AI assistant:
  provider cards with live status (● Signed in / Not signed in / Not found, ● Installed, ● Key set / Not set,
  ● Running / Not running) + "Check again", Model, API key (write-only: Save / Clear) + Base URL for the API, Ollama
  model (+ installed models as chips), and the three toggles.
- **Production data sources**: `readOnly`, or "prod" / "production" as a word of the name or folder
  (`/(^|[^a-z0-9])prod(uction)?([^a-z0-9]|$)/i`, so "Prod PG", "eu-prod", "prod_db", folder "Production", not
  "products"). With `blockProd` on they get no AI at all (Ask AI → info toast naming the setting; no Fix with AI
  button); everything else works normally. Sample rows are never sent for them, whatever `samples` says.
- **Schema context** (frontend, `buildSchemaContext`, from the explorer's cached introspection of the console's
  database, loaded on demand): tables are scored against the words of the request + the SQL / error it is about
  (table name or schema.table = 10, all parts of a multi-word name = 8, else 3 per name part; +1 per non-generic
  column name, max 4; naive singular/plural). With `autoTables`: tables scoring ≥ 2 (max 25) + tables they
  reference and tables referencing them (FKs) up to 25 in full; nothing matched → whole schema when ≤ 25 tables, else
  table names only. Without `autoTables`: whole schema when ≤ 60 tables, else as with it. Full tables are rendered as
  `CREATE TABLE schema.table (col type [NOT NULL], …, PRIMARY KEY (…), FOREIGN KEY (…) REFERENCES …);` (views as
  `CREATE VIEW`, max 80 columns, schema-qualified for PostgreSQL / SQL Server, quoted only when needed), the rest as
  one `-- Other tables (names only): …` line (max 300); total ≤ 60 000 chars. Samples (`samples` on, not prod): `SELECT
  * … LIMIT 20` (MSSQL `TOP 20`) on the console's session for the 3 best tables, appended as comment lines (cells ≤ 40
  chars). These sample queries go through `execute`, so they appear in the query history.
- **UI** (SQL consoles only; Redis / Kafka and cross-source runs get no AI): "✦ Ask AI ⌘I" in the capsule controls
  and the `askAi` action (`dt-action` event, handled by the visible console; no console → toast) open the prompt box
  under the cursor line: input, Generate ↵ (Esc closes), chips "<source> · <database>", "Tables: … (picked from your
  question)" (live), "Schema only · no row data" / "Schema + 20 sample rows", provider chip (→ Settings). With a
  selection it also offers **Explain selection** (mode explain, shown in the box). Running: spinner + Cancel (button
  or Esc) → `ai_cancel`. Errors stay in the box with "AI settings…".
- **Pending insertion** (`aiEditor.ts`): the SQL is inserted after the statement under the cursor (or on the empty
  cursor line; an unterminated previous statement gets a pending `;`) with `addToHistory: false`; its lines are
  purple-tinted with a `+` in the line-number gutter (`gutterLineClass`) and a block widget action bar below:
  "<Provider> · 2.1 s · used N tables", **Accept ⇥** (Tab), **Reject esc** (Esc), **Refine…** (box with the previous
  prompt, mode refine with the pending SQL; the result replaces the pending one), **Explain** (the reply's sentences,
  else a mode explain request; shown under the bar). Accept removes the pending text without history and re-applies
  it as ONE isolated undo step (`isolateHistory "full"`, userEvent `input.ai`), then toasts "Inserted — nothing runs
  until you press ⌘↵". Reject removes it without a trace in the history. Restore-on-launch saves the text without
  pending AI text.
- **Fix with AI**: the error view of a failed SQL statement (not connection-lost, not cross-source) shows "✦ Fix with
  AI" + "Copy error" + the board's hint. It finds the statement in the editor (same normalized text, the one under
  the cursor first; gone → toast), sends mode fix with the statement + error + context, and shows a line diff over
  it: removed lines red / struck out with `−`, added lines green with `+` right after them, same action bar; Accept
  replaces the statement (its `;` stays) as one undo step. An unchanged reply → toast "found nothing to change".

## v0.13 — cross-source naming

Request: "select * from dataSource1.DbName.TableName join dataSource2.DbName.TableName" in any console. No new
commands; `federated_execute` keeps its signature (v0.10) with new naming rules, and `FedStep` gains `database`.

- **References**: `<source>.<database>.<table>`; PostgreSQL / SQL Server also `<source>.<database>.<schema>.<table>`.
  `<source>` is a data source of the connection list written as its **slug** — lower case, every run of characters
  other than ASCII a–z / 0–9 → `_`, trimmed of `_` ("Asia32" → `asia32`, "Stage MySQL" → `stage_mysql`;
  `fedsql::slug` = `sourceSlug` in `src/ui/federation.ts`) — or its **exact name quoted** with `"…"`, `` `…` `` or
  `[…]` (`"Stage MySQL".shop.users`), case-insensitive. Attached aliases (Sources strip) stay extra names. A slug two
  data sources share → error `'x' matches more than one data source (A, B). Quote the exact name, e.g.
  "A".database.table, or rename one of them.` (frontend before running, backend too). A slug that isn't a plain
  identifier (empty, leading digit) can only be written quoted.
- **Parts** (backend `fedsql::plan`): `source.table` → the FedSource's database, unqualified (search_path /
  default schema). `source.x.table`: SQLite → x is the database ("main", the file's name, anything: ignored);
  MySQL → x is the database (= schema; no listing); PostgreSQL / SQL Server → x is a **database** when the server
  lists one of that name (case-insensitive, its exact name is used; schema = `public` / `dbo`), else a **schema** of
  the FedSource's database (the pre-v0.13 `alias.schema.table` form), else error `'x' is neither a database nor a
  schema on <Source>`. `source.db.schema.table` (PG / MSSQL): db must be a listed database (else `'x' is not a
  database on <Source>`). MySQL / SQLite 4 parts and 5+ parts → errors. First part matching no source → `No data
  source named 'x'. Write dataSource.database.table — …`.
- **Source lookup** (`fedsql::lookup_source`, per tier; two different sources on one tier → the ambiguity error):
  quoted first part → exact data source names; then the FedSource aliases; then slugs of the names. The backend
  merges FedSources with the same (connection, database) into one source answering to all their aliases; only the
  first source of a connection answers to its exact name / slug.
- **Database vs schema**: `fedsql::middle_parts(sql, sources)` lists the (source, x) pairs to decide (a dry run of
  the planner); `federation.rs` opens one temporary session per such source on its default database, lists the
  databases (`list_databases`, cached per run) and, only when x isn't one, the schemas (`pg_namespace` /
  `sys.schemas`). `fedsql::plan(sql, sources, classify)` takes the answers as a closure (`Middle::Database(exact)
  | Middle::Schema | Err`), so it stays std-only and unit-tested.
- **Pulls** run per (source, database) pair: one temporary session per pair with `ConnectionConfig.database`
  overridden to that database (the default pair reuses the listing session; a named database equal to the
  connected one counts as the default pair); pairs are pulled concurrently, every session is closed (also on
  errors). Unchanged: 200 000-row cap, projection / WHERE pushdown rules, SQLite in-memory tables named by the full
  reference (`asia32.postgres.users`), one plan step per pull + the join step. Two spellings of one table
  (`lite.users`, `lite_file.main.users`) are pulled once.
- `FedStep { alias (the first part as written), connectionId, sourceName, database: string|null (the database the
  pull ran in; null for the join step), sql (the pull SQL), rows, elapsedMs }`. "How it ran" shows
  `<source> · <database>`.
- **Routing in every SQL console** (PostgreSQL / MySQL / SQLite / SQL Server; frontend, `routeStatement` in
  `src/ui/federation.ts`, node tests `node scripts/test-federation.mjs`): `findTableRefs` finds dotted names in
  table positions (after FROM / JOIN / INTO / UPDATE, a comma of a FROM list; outside strings / comments) and
  `resolveSource` maps a first part: attached alias / the strip's own alias → that source; a database of the
  console's server or a schema of its database (cached explorer lists) → native; quoted → exact data source name;
  else slug. Slug / name references need 3+ parts (SQLite sources: 2+). A statement runs through
  `federated_execute` when a reference names a data source other than the console's own, or (with sources
  attached) an attached alias / the own alias; otherwise on the session as before (MSSQL `db.schema.table`, MySQL
  `db.table` stay native). Each statement of Run all is routed on its own. `fedSourcesFor` sends: attached aliases
  (their database), the strip's own alias, the console's own connection under its slug (database = the console's
  current database), and every other referenced source under its slug (database = its attachment's, else null);
  aliases unique, valid identifiers (a source without one gets `aliasSlug`, written quoted in SQL). Ambiguous slug →
  error result before running. Cross-source errors get no "Fix with AI"; "Load more" re-runs with the same sources.
- **Editor**: completion `source.` → the source's databases (SQLite: also its tables; attached / own alias: also the
  schemas of its database), `source.db.` → tables of the default schema + schemas (PG / MSSQL; MySQL: the
  database's tables; not a database → tables of that schema, older form), `source.db.schema.` → tables;
  introspection loaded lazily (explorer connect, `ensureDb`). Quoted first parts complete too. The "isn't attached"
  underline is gone; references of 3+ parts whose first part is no data source / database / schema get a wavy
  underline "No data source named 'x'." (with "Use a data source as x…", which attaches the picked one under that
  alias); an ambiguous slug is underlined with the ambiguity message. Marks only once the console's source is
  connected.
- **Guide card** step 2: "Write dataSource.database.table — e.g. asia32.postgres.users JOIN stage_mysql.shop.users —
  the data source name is its name in the explorer, in lowercase with _ for spaces (or quote it)" (with the
  console's own source names when known); step 1 says nothing needs attaching. **Example query** and **drag a
  table** insert `tableRef(...)`: `slug.database.table` (PG / MSSQL schema other than public / dbo → 4 parts; SQLite
  `slug.main.table`; a source without a plain slug → its quoted name). Dragging from another data source no longer
  attaches it. The own source's table inserts `schema.table`, or `slug.database.table` when the statement at the
  drop point runs across sources.
- **Explorer**: the tooltip of a SQL data source ends with "Use in SQL as <slug>".

- **OpenCode** (provider id `"opencode"`): `opencode run [--model provider/model] <prompt>` in an empty temp dir,
  with `OPENCODE_CONFIG_CONTENT={"permission":{"edit":"deny","bash":"deny","webfetch":"deny"}}`; prompts over
  24 000 characters are written to `request.md` in that dir and the model is asked to read it (Windows command
  lines are capped at 32 767 chars). Signed in = `$XDG_DATA_HOME/opencode/auth.json` (default
  `~/.local/share/opencode`) exists. Also found in `~/.opencode/bin`.

## v0.14 — in-app updates

| command | args | returns |
|---|---|---|
| update_status | – | UpdateStatus `{configured, currentVersion, platform}` |
| update_check | includePre | UpdateInfo `{version, currentVersion, notes, date, url}` \| null |
| update_download | – | null (emits `update-progress` `{downloaded, total}`) |
| update_install | restart | null (restart = relaunch now; Windows always relaunches) |
| update_open_page | url (must be a github.com/sepehr-dh99/data-trip/ page) | null |

- tauri-plugin-updater. The manifest is the `latest.json` asset of the newest non-draft GitHub release
  (pre-releases only with includePre). The minisign public key is compiled in from the build env
  `DATATRIP_UPDATER_PUBKEY` (CI: repository variable `TAURI_UPDATER_PUBKEY`); without it `configured` is false
  and checks are refused. CI signs update bundles only when the `TAURI_SIGNING_PRIVATE_KEY` secret exists
  (merging `src-tauri/tauri.updater.conf.json` → `bundle.createUpdaterArtifacts`).
- Settings `updates { auto, background, prerelease, skipped }`; the frontend (src/ui/updates.ts) checks 6 s
  after launch and hourly when the last check is older than a day; "Later" skips that version until a newer one.

## v0.15 — SQL files & help

Approved designs: `/home/claude/canvas/project/SqlFiles.dc.html` (R), `HelpCenter.dc.html` (S).
Backend `src-tauri/src/sqlfile.rs` (commands registered as `sqlfile::…`, state `sqlfile::SqlFileRuns`); frontend
`src/ui/sqlFiles.ts`, `src/ui/help.ts`, `src/ui/tour.ts`, content `src/help/articles.ts`, styles
`src/styles/files.css`, `src/styles/help.css`.

| command | args | returns |
|---|---|---|
| sql_file_read | path | TextFile `{text, mtimeMs, size, bom}` (max 8 MiB, else error `FILE_TOO_LARGE: …`; UTF-8 only; BOM removed) |
| sql_file_write | path, text, expectedMtimeMs: number\|null, bom: bool\|null | `{mtimeMs}` |
| file_mtime | path | FileStat `{mtimeMs, size}` \| null (missing) |
| run_sql_file | sessionId, path, options: SqlRunOptions, runId | SqlRunProgress (final) |
| run_sql_file_cancel | runId | null |

- The existing `read_text_file` / `write_text_file` (importers / export, v0.2 / v0.9) are unchanged; the file
  commands above are new names so their callers keep working.
- **sql_file_write**: atomic (temp file + rename, `export::write_text_atomic`), through a symlink to its target,
  the old file's permissions kept, BOM re-added when `bom`. With `expectedMtimeMs` and an existing file whose mtime
  differs (≥ 1 ms) → error `FILE_CHANGED: <name> was changed on disk …` (nothing written). mtimes are ms since the
  epoch.
- **run_sql_file**: SQL drivers only. A blocking thread reads the file line by line (never whole), splits it
  (`sqlfile::Splitter`: '…' / "…" / `…` / [..] quotes, -- and nested /* */ comments, PostgreSQL `$tag$` bodies and
  E'…', MySQL backslash escapes, `#` comments, `/*! … */` kept as content, client `DELIMITER x`; SQL Server lines
  `GO` / `GO n` end a batch, and a file containing GO is split on GO only), counts the statements in a first pass,
  then streams them through a channel. Each statement runs with `Session::execute(sql, 1)` (no history). Options
  `SqlRunOptions { stopOnError, batchTx: number|null (statements per transaction; null/0 = auto-commit), singleTx }`:
  DataTrip sends `begin_sql` / `commit_sql` around batches (or the whole file); a failure inside a transaction rolls
  it back (`rolledBack` += the statements that had succeeded in it; the failure message says so) and singleTx stops.
  If the file contains its own BEGIN / COMMIT (`db::tx_control`), DataTrip commits what it opened and stops wrapping
  (note). MySQL DDL (implicit commit) ends DataTrip's transaction (note in singleTx). `stopOnError` → stops at the
  first failure. Events **`sqlfile-progress`** = `SqlRunProgress { runId, done, total|null, ok, failed, rolledBack,
  bytesDone, bytesTotal, elapsedMs, lastError: {line (1-based, where the statement starts), statement (first 200
  chars, whitespace collapsed), message}|null, finished, cancelled, stopped: string|null (why it ended early),
  note: string|null }`: at most every 120 ms, plus one event per failure (with `lastError`) and a final one
  (`finished`). Cancel: sets the flag and `Session::cancel` (the running statement), an open transaction is rolled
  back, `cancelled: true`.
- **Frontend runs on a dedicated session** (`open_session(connId, database)`, closed afterwards), so the console's
  transaction mode / running statements are not involved.

### SQL files (board R)
- Keymap actions `saveFile` (Mod-S), `saveFileAs` (Mod-Shift-S), `openFile` (Mod-O), `help` (F1) in all presets.
  Menu command ids: `saveFile`, `saveFileAs`, `exportSelection`, `openFile`, `runSqlFile`, `help`, `welcomeTour`
  (macOS menu: File › Open SQL file… / Save / Save as… / Export selection as .sql… / Run SQL file on a data source…,
  Help › DataTrip help / Welcome tour). Mod-S with the result grid focused still submits grid edits (the grid
  handles it first).
- **File ▾** (first button of a console's capsule controls): Save, Save as…, Export selection as .sql… ("Export
  console…" without a selection), Open SQL file…, Run SQL file on a data source… (this console's data source /
  database), Recent files (settings `files.recent`, max 10; also a "Recent files" group in ⌘K).
- **Binding** (`ConsolePane.file: FileBinding`): `bind(path, text, mtimeMs, bom)` sets the tab title to the file
  name (`TabPane.filePath`; `autoName` = the file name, tooltip `<path> — <data source>`), the saved baseline and
  the line-ending style (CRLF kept on save). ● (`dirty`) = editor text ≠ last saved / loaded text (debounced
  120 ms). ⌘S writes back with `expectedMtimeMs`; `FILE_CHANGED` → confirm Overwrite (writes without the check) or
  Cancel (shows the banner). Save as (native save dialog) writes without the check and rebinds. Saving remembers
  the file's target (`files.targets[path] = {connId, database}`, max 200) and adds it to recents. Closing a dirty
  file console asks first.
- **Changed on disk**: on window focus / visibility and tab activation, `file_mtime`; a different mtime → read the
  file; same text → silently adopt; else banner "<name> changed on disk since you opened it." **Reload from
  disk** (one undoable change), **Keep mine** (adopts the disk mtime: the next save overwrites), **Compare** (new
  console "<name> (on disk)", editor read-only via `EditorState.readOnly`, info banner; Save as makes it a normal
  file console). Missing file → banner "was moved or deleted" with Save it again / Save as… / Dismiss.
- **Open** (⌘O, File ▾, menu, palette): native open dialog (filters .sql/.txt, all files) → an open console of that
  path is activated instead → `sql_file_read` (`FILE_TOO_LARGE` → offer Run SQL file) → "Open <name>" picker
  (path · size · statement count; "Run it against": the remembered target, the current console's, the explorer
  selection, then every SQL data source, connected first; a Database select for connected servers with several
  databases; "Remember for this file") → `openConsole(connId, {sql, database, title: name})` + `bind`. A recent file
  with a remembered target opens directly.
- **Drop**: window capture-phase `dragenter/over/leave/drop` for `Files` (the window keeps `dragDropEnabled:false`;
  in-page table drags are untouched): overlay "Drop to open as a new console"; .sql/.txt files ≤ 8 MiB are read
  with `File.text()` and opened (picker without "Remember") as **unbound** consoles named after the file; toast
  "Opened a copy — use Save as to choose where it's saved".
- **Workspace**: `WsConsole.file?: {path, mtimeMs, dirty} | null`. On restore the file is read again: same mtime →
  that text is the baseline; changed → banner (baseline = disk text when the console had unsaved changes).
- **Run SQL file** (explorer data source menu "Run SQL file…", File ▾, File menu, palette): open dialog → data source
  (the console's / the explorer's; from the menu or palette with a console: that console; else the picker) → the
  panel at the bottom of a console of that data source and database (the active one if it matches, else a new
  console "run <name>"): options (Stop on first error; One transaction per [500] statements — default on; Run in a
  single transaction), production / read-only warning, **Run** → progress bar, done / total, ✓ ok, ✕ failed,
  ↺ rolled back, elapsed and time left, failures "✕ line N <statement> — <message>" (max 1000 listed), notes;
  **Stop** → `run_sql_file_cancel`; finished → Run again / Close (+ toast when the console isn't active).

### Help (board S)
- **Help center** (`openHelp(id?)`; F1, the "?" in the sidebar toolbar, Help › DataTrip help, ⌘K "Help"): dialog
  with search (all words must match title / lead / body / keywords; title hits first), the topic list of the
  board (Getting started, Connect to a database, Consoles & running SQL, Results, editing & export, SQL files,
  Cross-source queries, AI assistant, Vault, SSH & OIDC, Kafka & Redis, Keyboard shortcuts, Troubleshooting; a
  topic with several articles lists them under it), and the article view (crumb, title, lead, body, **Try it**
  button — a command id or "open a new console with this SQL" —, **Copy example** for the first code block,
  Related links). Esc closes (first clears the search), F1 toggles, ⌘F focuses search. "Keyboard shortcuts" is
  generated from `ACTIONS` with the current bindings.
- **Content** (`src/help/articles.ts`): Markdown subset rendered to DOM nodes only (no innerHTML): `##`/`###`,
  paragraphs, `- ` lists, `1. ` numbered steps, `> ` tips, ```sql blocks (small highlighter using the
  `--syn-*` colors), `` `code` ``, `**bold**`, `[text](#article-id)`, `{key:actionId}` (current shortcut),
  `{bind:Mod-S}`, `{modkey}`.
- **Help from errors**: `ERROR_HELP` (regex → article id, some only for Vault data sources) + `errorHelpButton(msg,
  {vault})` → "? What does this mean?" opening a compact popover (crumb, title, lead, body, "Open the full
  article ↗", related). Used in the console error view, the connection dialog's Test / Save errors and the Kafka
  topic error view.
- **? hints** (`helpHint(articleId, tip)`): native tooltip with one line; click → the popover with the tip on top.
  Connection dialog: Security protocol, Bootstrap servers (Kafka), SSH tunnel, Vault profile, Sentinel nodes,
  Master name; Vault profiles: OIDC Mount path and Role.
- **Welcome tour** (`src/ui/tour.ts`): 4 steps anchored to the explorer tree, the visible console's gutter (else
  Run / New console), the ⌘K pill and the ? button; spotlight ring + card (Step n of 4, Next / Done, Skip tour; Esc
  skips, ←/→). Shown ~0.9 s after the first launch while `settings.help.tourDone` is false and no dialog is open;
  finishing or skipping sets it. Help › Welcome tour (and the help center's footer link) restarts it.
- Settings additions: `files { recent: string[], targets: Record<path, {connId, database}> }`, `help { tourDone }`.

## v0.15 — AI, safeguards, error positions

| command | args | returns |
|---|---|---|
| ai_models | provider, baseUrl: string\|null, refresh: bool\|null | AiModels `{ models: {id, label?, note?}[], source: string, error?: string }` |

**Cross-source AI requests** (frontend `src/ui/aiCross.ts`, pure; node tests `node scripts/test-ai-context.mjs`;
the single-source helpers moved from `ai.ts` to the pure `src/ui/aiContext.ts`, re-exported by `ai.ts`).
- Every request's `schemaContext` starts with "Data sources you can use …": one line per SQL data source — its SQL
  name (`sourceRef`: slug, or quoted name), driver, and for the console's own source "this console · current
  database X". Names only, no schema. Sources AI is blocked for (production, `blockProd`) are left out.
- `detectCrossSource(text, sources, sqlUses)` over cached explorer metadata only: another source's slug (≥ 3 chars,
  not generic) or quoted exact name in the request; a table (≥ 4 chars) named in the request that only another source
  has (only once the own schema is loaded; tables compared without a plural "s"); a non-system database (≥ 3 chars)
  only another server has; the sources the SQL being refined / fixed already reads from (`routeStatement`). Words
  like "across / between … sources|databases|servers", "cross-source", "federated" make it explicit (then a table
  named in the request picks a source even when the own source has one of that name).
- Cross mode (`AiRequest.crossSource: true`): the involved sources are connected and introspected lazily (explorer
  connect + `ensureDb`, attached database or the default); `buildCrossContext` sends the cross-source rules
  (`source.database.table` / `source.database.schema.table`, slug or quoted exact name, SQLite outer query —
  strftime, `||`, no ILIKE, LIMIT —, alias every table, filters on one table get pushed down, one read-only SELECT)
  with a short example over the involved sources, then each source's tables as `CREATE TABLE
  source.database[.schema].table (…)` (columns quoted the SQLite way). The 25-table budget is split: each source
  gets an equal share of what it wants (v0.12 picking rules per source), leftovers go to sources wanting more; the
  rest of each source is a names-only line. Samples (when allowed) only from the own source. The backend prompt then
  says: write ONE cross-source SELECT following the rules if the request needs other sources, else a normal
  `<dialect>` query.
- Prod sources: a blocked source the request names (or its SQL uses) → the request is refused in the prompt box
  ("“X” is a production data source and “Block AI for production data sources” is on …"); a blocked source matched
  only by a table / database → excluded, with a warn chip "X: AI blocked".
- Chips: "Across: a · b" (tooltip: why each source was picked), "Tables: src.table, …(from each source)".
- Check before showing (`checkCrossSql`, with the console's RouteContext): ambiguous / unknown data source names,
  `source.table` without the database (non-SQLite), tables without a data source in a cross-source query (CTE names
  excepted), non-SQLite syntax in the outer query (ILIKE, `::`, NOW(), DATE_TRUNC, EXTRACT, INTERVAL, GETDATE,
  DATEADD…, TOP, ISNULL, TO_CHAR / DATE_FORMAT, FETCH FIRST), writes, blocked sources, and a query that doesn't read
  from a source the request named. Problems → ONE automatic `refine` request "DataTrip checked this cross-source query
  … found: …. Fix exactly these problems …"; what is still wrong afterwards → info toast after insertion.

**Model catalogs** (`ai_models`, cached 10 min per provider + base URL; `refresh` reloads; failures with no models
aren't cached). Never rejects for provider problems: `error` says what went wrong.
- opencode: `opencode models` (run like the generation CLIs: no shell, AppImage env cleaned, PATH search, empty temp
  dir, 15 s) — every output line that is a single `provider/model` token; banners / warnings skipped.
- codex: `codex debug models` (experimental) — JSON → every object's `slug` / `id` / `model` string (label from
  `display_name`; `visibility: "hide"` skipped), else lines that look like model ids. Not available / empty → the
  top-level `model` of `$CODEX_HOME/config.toml` (default `~/.codex`; note "from config.toml") + suggested models
  (note "suggested"): gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-sol, gpt-6-luna (Codex docs, Nov 2026).
- claude: the aliases sonnet, opus, haiku, opusplan (note "alias") + claude-opus-5-5, claude-haiku-5-5 ("pinned").
- openai: GET `{baseUrl or https://api.openai.com/v1}/models` with the stored key → `data[].id`, sorted.
- ollama: `/api/tags`.
- Settings › AI assistant › Model is a searchable picker: "Default" (= "", provider default), the catalog (OpenCode
  grouped by the provider prefix), a typed value kept as a custom model ("Use “x”"), ↻ reloads, the line under it
  shows "N models · from `opencode models`" or the error. The prompt box's provider chip shows the chosen model
  ("Codex · gpt-6.2-sol", "OpenCode · default model").

**Connection safeguards** (frontend, `console.ts`).
- Settings `data.idleDisconnectMinutes`: 5 | 15 | 30 | 60 | 120 | 0 (never), default 15; Settings › Data & history
  "Disconnect idle consoles after" (select). Every 30 s, a SQL / Redis console (not Kafka) whose session is open,
  with no run / typing / focus-in for that long, not running, auto-commit, no typed BEGIN / START TRANSACTION /
  SAVEPOINT (Redis MULTI) without COMMIT / ROLLBACK (/ EXEC, DISCARD) since, no AI request running and its editor not
  focused in a focused window → `close_session`. The next run (or paging, Load more, edits, count) reopens it via
  `ensureSession` (search_path re-applied). Status text and tab tooltip: "Disconnected after 15 min idle — reconnects
  on next run" (`TabPane.statusHint`).
- Editor hibernation: consoles in most-recently-used order (activation / focus / wake); only the 10 most recent keep
  a CodeMirror `EditorView`. `SqlEditor.hibernate()` keeps the `EditorState` (text, undo history, selection, pending
  AI text, error mark) and a scroll snapshot and destroys the view; `state`, `getText()`, statements, cursor, edits
  (`dispatch` applies to the saved state), undo / redo keep working; anything needing the view (`focus`, `cmView`,
  coordinates) recreates it first (`wake()`, inserted as the container's first child, scroll restored). Not while
  the console is visible or its AI request runs; the AI prompt box is closed first. Result grids are kept as they are.

**Error positions**.
- `AppError` serializes `{ message, position?, line? }` (fields only when known; messages unchanged): PostgreSQL —
  `PgDatabaseError::position()` `Original(n)` → `position` (1-based character of the executed SQL); MySQL — "… near
  '<rest>' at line N" → `line`, and `DbConn::execute` locates `<rest>` from that line on → `position`
  (`near ''` → the statement's end); SQL Server — tiberius `TokenError::line()` → `line`. The frontend `api` keeps
  them on the thrown `Error` (`err.position`, `err.line`).
- Console: a failed statement run from the editor is found in the document (the copy at / nearest the caret); the
  position (code points → UTF-16; the pager's wrapper offset removed) or line maps to the document; the token there
  (word, quoted name / literal, else one character; at the end: the last token) gets a red wavy underline with the
  message on hover (`SqlEditor.setErrorMark`), and the error view gets **Go to error · line L, column C** (caret
  there). Cleared by any edit and on the next run. Cross-source and Redis / Kafka errors get none.

## v0.16 — parameters, explain, sessions, snippets, production safety

Approved designs: `/home/claude/canvas/project/ParamsExplain.dc.html` (U), `OpsSafety.dc.html` (W). Frontend only
except two model fields and two macOS menu items; **no new commands**. Pure logic with node tests
(`node scripts/test-ops.mjs`): `src/ui/params.ts`, `explainPlan.ts`, `sessionsData.ts`, `snippets.ts`, `prodSafety.ts`.
UI: `paramsPopover.ts`, `explainView.ts`, `consoleOps.ts` (console glue), `sessionsPane.ts`, `opsDialogs.ts`,
`opsEditor.ts` (CodeMirror), `snippetSettings.ts`, `prodUi.ts`; styles `src/styles/ops.css`.

### Model
- `ConnectionConfig.production: ProductionOptions | null` (`#[serde(default)]`; mirrored in `types.ts`):
  `{ enabled: bool (default false), color: string|null ("#FF1A3C", "#ff9f0a", "#bf5af2", "#0a84ff", "#30d158"),
  confirmWrites: bool (default true), typeNameForDrop: bool (default true) }`. Stored verbatim, enforced by the
  frontend. The dialog writes null until the switch was ever turned on.
- Settings: `snippets { user: Snippet[], hidden: string[] (built-ins removed), expandKey: "tab"|"enter"|"space",
  inCompletion: bool }`, `Snippet { abbr ([A-Za-z_][A-Za-z0-9_]{0,31}), name, body, dialects: ("postgres"|"mysql"|
  "mssql"|"sqlite")[] }`; `explain { analyze (false), buffers (false) }`.
- Workspace: `WsConsole.params?: { remember, values: Record<key, {kind: "text"|"number"|"date", value, isNull}>,
  at }` (only saved while "Remember values for this console" is on).
- `TabPane.kind` gains `"sessions"` (not restored on launch). Menu command ids: `explain`, `sessions`, `snippets`
  (macOS menu: Console › Explain plan, Console › Sessions & locks). Keymap action `explain` (Mod-Alt-E, all presets).

### Query parameters (board U)
- Detection (`scanParams`, per statement, SQL drivers only; none for Redis / Kafka): `:name` everywhere — not `::`,
  not `:=`, not directly after an identifier character / `]` / `)` / quote (`arr[lo:hi]`); `?` for MySQL, SQLite,
  SQL Server (never PostgreSQL: `?|` JSON operators), SQLite `?NNN` numbered; `$n` for PostgreSQL. Skipped: strings
  (MySQL / `E'…'` backslash escapes), quoted identifiers, `--` / `#` (MySQL) / nested `/* */` comments, `$tag$`
  bodies, and statements starting with PREPARE / CREATE FUNCTION / PROCEDURE / TRIGGER. Keys: `:name`, `$n`, and
  positional `?1…` numbered across one run. Tokens are highlighted in the editor (`cm-sql-param`).
- Inference (`describeParams`, cached explorer schema only): `col op :p`, `:p op col`, `col IN (…, :p`,
  `col BETWEEN :a AND :b`, `SET col = :p`; aliases from FROM / JOIN / UPDATE / INTO → `table.column · type`, kind
  number / date / text from the type.
- Running a statement (or Run all / gutter ▶ / Explain) with parameters opens **Run with parameters** under it
  (fixed-position popover): label + hint, text / number / date, value, NULL toggle, validation (number
  `^[+-]?…$`; date `YYYY-MM-DD[ hh:mm[:ss[.ffffff]]][zone]`; empty number / date → "Enter a value or choose NULL";
  empty text allowed), "Remember values for this console" (+ "last used N min ago"), Cancel Esc, Run ↵ / ⌘↵.
- **Binding = literal substitution in the frontend** (decision: the drivers run statements through the simple
  query protocol — sqlx `raw_sql`, tiberius `simple_query` — and real binds would need typed values per driver,
  PostgreSQL casts to the compared column's type, and would not survive the pager wrapper or cross-source routing
  without backend changes CI can't verify here). `paramLiteral`: NULL → `NULL`; number → validated text, negative in
  parentheses (`x - (-1)`); date → quoted string; text → PostgreSQL `'…'` (`''` doubled) or `E'…'` with `\\` doubled
  when it has a backslash; MySQL `'…'`, or `_utf8mb4 X'<hex>'` when it has a backslash / control character (safe with
  and without NO_BACKSLASH_ESCAPES); SQL Server `N'…'`; SQLite `'…'`; NUL characters refused. Cross-source statements
  are substituted in the SQLite dialect. The substituted text goes through paging, Count rows, Load more, history.
- Result: chips `:id = 1042` above the result + **Edit parameters** (re-runs the original); a NULL compared with
  `=` / `<>` / `!=` adds "A comparison with NULL is never true … write col IS NULL instead". Errors map back to the
  original text (`mapParamError`: position through the substitution edits and the pager wrapper) for the underline;
  the error view and Fix with AI get the original statement.

### Explain (board U)
- `explain` (⌥⌘E / Ctrl+Alt+E in the editor or outside text fields; console capsule **Explain**; Console menu; ⌘K):
  the statement at the cursor (first of a selection; parameters asked first; not for cross-source / Redis / Kafka).
  Statements: PostgreSQL `EXPLAIN (FORMAT JSON[, ANALYZE[, BUFFERS]])`; MySQL `EXPLAIN FORMAT=JSON`, with ANALYZE on
  8.0.18+ (not MariaDB) `EXPLAIN ANALYZE` (text tree); SQLite `EXPLAIN QUERY PLAN` (tree from id / parent); SQL Server
  `SET SHOWPLAN_XML ON` / statement / `SET SHOWPLAN_XML OFF` as separate executes (estimated plan; RelOp PhysicalOp /
  EstimateRows / EstimatedTotalSubtreeCost / Object / Predicate, MissingIndex → hint). DDL is refused.
- ANALYZE of a write (`classifyStatement`) asks first and runs `BEGIN` (MySQL `START TRANSACTION`) … `ROLLBACK`; in a
  manual / typed transaction `SAVEPOINT dt_explain` … `ROLLBACK TO SAVEPOINT dt_explain` + `RELEASE`. The switches
  persist in `settings.explain`; toggling them in the plan header re-explains.
- Plan view (result item "Plan"): ANALYZE banner, header (info: EXPLAIN ANALYZE · execution · planning · time; ANALYZE
  / BUFFERS switches; Tree / Raw; Copy plan), hint line, tree (node + relation / index, detail line; rows est → actual
  with `×N under/over` when ≥ 10×; self time — inclusive `Actual Total Time × loops` minus children — or share of self
  cost; cost; slowest node badge), details of the clicked node. Raw: PostgreSQL text plan rendered from the JSON,
  MySQL JSON / tree text, SQLite tree, SQL Server XML. Hint (`planHint`): the full scan (Seq Scan, MySQL ALL / Table
  scan, SQLite `SCAN t`, SQL Server Table / Clustered Index Scan) with the largest share, when dominant (slowest or
  ≥ 30 %) and large (≥ 10 000 rows scanned; SQLite always), with a column from its filter (else the statement's
  WHERE) → text + `CREATE INDEX idx_<table>_<col> ON <schema.table> (<col>);` (SQL Server: its MissingIndex).

### Sessions & locks (board W)
- Explorer data source menu **Sessions & locks** (SQL sources), Console menu, ⌘K → a tab (`SessionsPane`) per data
  source with its **own session** (`open_session(connId, null)`, closed with the tab). SQLite → "doesn't apply".
- Queries (`sessionQueries`): PostgreSQL `pg_stat_activity` + `array_to_string(pg_blocking_pids(pid), ',')`, duration
  from query_start (active) / xact_start (idle in transaction) / state_change, `pid = pg_backend_pid()` = self,
  non-client backend_type = background. MySQL `information_schema.PROCESSLIST` (Sleep → idle, Query → active, Daemon
  / Binlog → background, `CONNECTION_ID()` = self) + `INNODB_TRX` (sleeping with a transaction → idle in transaction)
  + lock waits from `sys.innodb_lock_waits`, else `performance_schema.data_lock_waits`, else
  `information_schema.INNODB_LOCK_WAITS` (first that works). SQL Server `sys.dm_exec_sessions` + `dm_exec_requests`
  (+ `blocking_session_id`) + `dm_exec_sql_text`, user processes, `@@SPID` = self.
- UI: columns pid · user · application · state (dot, `blocks N` / `this tab` badges) · duration · waiting on · query;
  Active only, Hide idle, search; Auto-refresh 2 / 5 / 10 s (default 5, only while visible); lock chain banner
  (`lockChains`: roots that block and wait for nobody listed, largest first; cycles reported) with Select blocker;
  row details with the full query, Copy query, **Cancel query** / **Kill session** → confirmation with the exact
  command: PostgreSQL `SELECT pg_cancel_backend(pid)` / `pg_terminate_backend(pid)`, MySQL `KILL QUERY pid` /
  `KILL pid`, SQL Server `KILL pid` (no cancel). The tab's own session is disabled; pids must be digits.

### Snippets (board W)
- Built-ins: sel, selw, cnt, ins, upd, del, j, lj, gb, ob, selc, today, lim (PG / MySQL / SQLite), top (SQL Server),
  locks (PostgreSQL). A user snippet with a built-in's abbreviation replaces it (Reset to built-in), hidden
  built-ins are removed (Restore built-in snippets).
- Expansion (SQL consoles): the expand key (Tab default) with completion closed and a word before the caret (line
  start / after whitespace, `(`, `,`, `;`; not in a string, comment or after `.`) equal to an abbreviation for the
  console's dialect; with completion open Tab accepts a selected snippet item (items: label = abbreviation, detail
  `{} name`, info = body). Bodies become CodeMirror `snippet()` templates: `$TABLE` → `${1:table}`, `$COLUMN` →
  `${2:column}` (repeats linked), `$CURSOR` → `${3}`, `$SELECTION` → the text the typed abbreviation replaced, `$DATE`
  → `'YYYY-MM-DD'` (unquoted inside quotes), braces escaped. A first `$TABLE` / `$COLUMN` field (or the caret after
  FROM / JOIN / INTO / UPDATE) opens completion; inside a selected `table` / `column` field it lists the cached tables
  / the statement's columns unfiltered. Settings › **Snippets**: list, editor (abbreviation, description, body,
  placeholder chips, dialects), Expand with Tab / Enter / Space, Show in completion.

### Production safety (board W)
- Connection dialog section **Production data source** (switch, color, Confirm before writes, Type the data source
  name for DROP / TRUNCATE, explorer preview). Marked sources: explorer `PROD` tag in the color, ⌘K detail "· PROD",
  a `PRODUCTION · <name>` bar at the top of their consoles (note: writes ask / DROP & TRUNCATE ask / no confirmation).
- Before running (after parameters): writes among the statements that run natively (`classifyStatement`: INSERT /
  REPLACE / UPSERT, UPDATE, DELETE, MERGE, SELECT … INTO, data-modifying WITH, EXPLAIN ANALYZE of a write, DDL — CREATE
  / ALTER / DROP / TRUNCATE / RENAME / GRANT / REVOKE / COMMENT —, CALL / EXEC / DO / COPY …) need confirmation when
  `confirmWrites`, or when destructive (DROP / TRUNCATE) and `typeNameForDrop`. One write → dialog: data source ·
  database, statement kind, table, filter (UPDATE / DELETE; "(no WHERE clause)" in red), **Affects** filled in later
  from an estimate (PostgreSQL `EXPLAIN (FORMAT JSON)` Plan Rows — ModifyTable's input —, MySQL `EXPLAIN` rows,
  DROP / TRUNCATE `pg_class.reltuples` / `information_schema.TABLES.TABLE_ROWS`; only with an open auto-commit
  session and no typed transaction, 4 s cap), warning (no WHERE / data removed permanently), the statement, and the
  typed name when required. Several → one summary dialog. Cancel → nothing runs. When the production dialog applies,
  Settings › Confirm risky statements is not asked as well (otherwise it still applies).
- AI: `isProdConnection` = marked production first; the name / folder "prod" and read-only heuristic stays as the
  fallback; the refusal names the reason ("is marked as a production data source").
- Not covered by the confirmation: grid edits (apply_edits), Run SQL file (keeps its own production warning) and
  Redis / Kafka consoles. (v0.17: grid edits, Redis and Kafka are covered now — see "v0.17 — gap fixes (safety
  coverage…)".)

## v0.16 — value viewer, DDL, import, table designer

Approved designs: `/home/claude/canvas/project/ValueDdl.dc.html` (T), `ImportDesign.dc.html` (V). Backend
`src-tauri/src/ddl.rs` + `ddlgen.rs` (std-only text assembly, `rustc --edition 2021 --test src/ddlgen.rs`),
`import.rs` + `importfmt.rs` (std-only parsing / conversion / SQL, `rustc --edition 2021 --test src/importfmt.rs`),
state `import::ImportRuns`; one new session job `Job::Params { sql, params }` (`Session::exec_params`, rows affected;
refused on read-only; `DbConn::exec_edit` is now pub). Frontend `src/ui/valueViewer.ts` + `valueFormat.ts` (pure),
`ddlPane.ts`, `designerPane.ts` + `designerSql.ts` (pure), `importWizard.ts`, `sqlHighlight.ts` (pure), glue
`dataTools.ts` / `dataActions.ts`, styles `src/styles/data.css`; node tests `node scripts/test-data-tools.mjs`.

| command | args | returns |
|---|---|---|
| get_ddl | sessionId, request: DdlRequest | string (the CREATE statement(s), ends with "\n") |
| table_extras | sessionId, schema: string\|null, table | TableExtras |
| import_preview | path, format: ImportFormat\|null, checkTypes: (string\|null)[]\|null | ImportPreview |
| import_run | sessionId, path, request: ImportRequest, runId | ImportProgress (final; events `import-progress`) |
| import_cancel | runId | null |

### Cell value viewer (frontend only)
- A panel docked right of the ResultGrid (`.grid.vv-open`, width min(452px, 46%)); follows the selected cell (the
  grid calls `viewer.update()` from `updateBar`). Opens on double-click of a cell that `wantsViewer` (string longer
  than 120 chars or with a line break, json/jsonb column, `{…}`/`[…]` that parses, binary column; other cells keep the
  inline editor), ⇧↵ with the grid focused, or the cell menu **Open value** (⇧↵). Esc closes it.
- Modes Text | JSON | Hex; default Hex for bytea/BLOB/binary/varbinary/image or `0x…` values, JSON for json columns or
  parseable JSON, else Text; a mode picked by hand sticks while the selection stays in that column. JSON uses its own
  parser (numbers kept verbatim), 2-space pretty lines with ▾/▸ fold per container, Fold all (= every container
  under the root) / Unfold all; Wrap (remembered, localStorage `dt.viewer.wrap`); size (UTF-8 bytes) + line count;
  Copy (whole value). Caps: 2 MB of text, 20 000 JSON lines, 64 KB of hex (notes say so); binary cells carry the first
  4 KB (v0.1 wire rule) — noted.
- ✎ Edit (editable results only; not binary, not > 2 MB): CodeMirror `TextEditor` with JSON colors while valid; JSON
  (json column or JSON mode) is validated live (`✕ message · line L, column C`, Save disabled). **Save to grid**
  (⌘↵) → the grid's `setCell(ri, c, parseValue(...))`: a pending edit, Submit / Revert as before. A value that was
  single-line is stored compacted (numbers verbatim), otherwise as typed.

### Show DDL
- `DdlRequest { kind: "table"|"view"|"materialized"|"function"|"procedure"|"sequence"|"index", schema, name, arguments?
  (routine overload, as introspected), table? (indexes), options: { indexes, comments, qualified } }` (options default
  true). Runs catalog queries with `Session::execute` on the explorer session of that database (no history).
- PostgreSQL: CREATE TABLE built from pg_attribute (format_type, NOT NULL, pg_get_expr defaults, identity PG10+,
  generated PG12+, non-default collation), pg_get_constraintdef (p, u, c, x, f), `PARTITION BY` (pg_get_partkeydef),
  UNLOGGED, indexes not backing a constraint via pg_get_indexdef, COMMENT ON TABLE / COLUMN; views
  `CREATE OR REPLACE VIEW … AS` pg_get_viewdef, materialized views (+ indexes); functions / procedures
  pg_get_functiondef (+ COMMENT ON FUNCTION); sequences from pg_sequence (PG10+) + OWNED BY; foreign tables noted.
  Unqualified: DataTrip's own names are bare and `ON schema.` of index defs / the routine header are stripped.
- MySQL: SHOW CREATE TABLE / VIEW / FUNCTION / PROCEDURE (routines wrapped in `DELIMITER ;;`), MariaDB SHOW CREATE
  SEQUENCE; indexes from information_schema.STATISTICS. Indexes off = plain / FULLTEXT / SPATIAL KEY lines dropped;
  comments off = ` COMMENT '…'` clauses removed; qualified = `` `db`. `` inserted before the object name.
- SQL Server: built from sys.columns / identity_columns / default_constraints / computed_columns / key_constraints /
  foreign_keys / check_constraints / indexes (INCLUDE, filter, columnstore; XML / spatial noted) and MS_Description
  (sp_addextendedproperty); views / procedures / functions / triggers OBJECT_DEFINITION (NULL → encrypted or no VIEW
  DEFINITION permission); sequences from sys.sequences; PK / UQ indexes as ALTER TABLE … ADD CONSTRAINT.
- SQLite: sqlite_master.sql of the table / view, its indexes (when on) and triggers; automatic indexes noted.
- UI: explorer menus of tables / views / materialized views, routines, sequences and index rows get **Show DDL**
  (hint = the shortcut); action `showDdl` (default Mod-Alt-D in every preset; acts on the explorer's selected row, else
  the active console's table; not while typing in a text field), command id `showDdl` (File menu, palette). A tab
  `TabPane.kind "ddl"` titled `<name> — DDL` (an open one for the same object is focused and reloaded): header path +
  kind · data source, toggles (Indexes only for tables / materialized views; Comments and Schema-qualified disabled for
  SQLite), Copy, **Open in console** (new console on that database, not run, toast); body = numbered, highlighted
  lines starting with `-- db.schema.name · kind · source (driver)`; footer "Read from the catalog · N lines · HH:MM".
  DDL and designer tabs are not restored on launch (workspace `active` index counts saved tabs only).
  Note: macOS reserves ⌥⌘D for "Hide Dock" — remap in Settings › Keymap if it doesn't reach the app.

### Table designer
- Explorer: schema rows (and MySQL / SQLite database rows) › **New table…**; table rows › **Edit table…**; command ids
  `newTable`, `designTable` (palette / File menu use the explorer selection or the active console). A tab
  `TabPane.kind "design"` ("<table> — Design" / "New table — Design").
- Loaded from the explorer's introspection (columns, PK, indexes, FKs) plus `table_extras`: `TableExtras { comments
  (column → text), defaultConstraints (MSSQL column → constraint name), autoIncrement (identity / AUTO_INCREMENT
  columns; "*" = SQLite AUTOINCREMENT), fkOnDelete (fk → action, NO ACTION omitted), createSql (SQLite), tableComment }`
  (each part best-effort).
- Columns grid: name, type (free text + ▾ per-dialect list `TYPE_LISTS`), Not null, Default (SQL expression; true /
  false → 1 / 0 outside PostgreSQL, now() → SYSUTCDATETIME() / CURRENT_TIMESTAMP), PK (sets Not null), comment;
  ▲▼ reorder, ✕ drop (new rows are removed), ↺ restore; rows marked new / changed / dropped. Indexes (name, columns as
  typed, unique; the PK index is read-only) and Foreign keys (new: name, columns, referenced table + columns, ON DELETE;
  existing: drop / restore only; "Referenced by" from explorer metadata).
- SQL (`designSql`, `src/ui/designerSql.ts`): new table → CREATE TABLE (+ PRIMARY KEY, FK constraints; MSSQL
  `CONSTRAINT PK_<t>`), CREATE INDEX, comments (PG COMMENT ON, MSSQL sp_addextendedproperty, MySQL inline COMMENT,
  SQLite note). Existing: dropped FKs / indexes first, then per column — PG ADD / DROP / RENAME COLUMN, ALTER COLUMN
  TYPE … USING col::type, SET / DROP NOT NULL, SET / DROP DEFAULT, COMMENT ON COLUMN; MySQL ADD COLUMN … AFTER / FIRST,
  RENAME COLUMN (rename only), CHANGE / MODIFY COLUMN with the full definition (AUTO_INCREMENT and COMMENT kept),
  reorder via MODIFY … AFTER; MSSQL ADD … NULL|NOT NULL [CONSTRAINT DF_<t>_<c> DEFAULT …], drop the default constraint
  before DROP COLUMN / a default change, sp_rename for columns / indexes / the table, ALTER COLUMN type NULL|NOT NULL,
  sp_add/update/dropextendedproperty; PK change (DROP CONSTRAINT <pk name> + ADD PRIMARY KEY; MySQL DROP PRIMARY KEY,
  ADD PRIMARY KEY); new / changed indexes (changed = drop + create; renamed only → ALTER INDEX … RENAME / RENAME INDEX /
  sp_rename); new FKs; table rename last. Identifiers quoted only when needed. Reorder on PG / MSSQL → note only.
  SQLite: ADD COLUMN (unless PK or NOT NULL without default), RENAME COLUMN, DROP COLUMN, indexes in place; type / NOT
  NULL / default / PK / order / FK changes → the rebuild: `PRAGMA foreign_keys = OFF; CREATE TABLE <t>_new (…);
  INSERT INTO <t>_new (kept cols) SELECT original names FROM <t>; DROP TABLE <t>; ALTER TABLE <t>_new RENAME TO <t>;`
  recreate indexes, `PRAGMA foreign_keys = ON;` (INTEGER PRIMARY KEY AUTOINCREMENT kept).
- Apply… → confirmation (statements, data source · dialect · production flag; MySQL: "commits each DDL statement on
  its own…") → a dedicated session (`open_session`, closed afterwards) runs `BEGIN` / `BEGIN TRANSACTION`, the
  statements via `execute` (so they are in the history), COMMIT; any error → ROLLBACK, the message and the failing
  statement are shown. MySQL: no transaction, stops at the first error. SQLite PRAGMAs run outside the transaction.
  Then `store.refreshDb` and the design reloads ("✓ Applied N statements in X ms · table reloaded"). Read-only data
  sources: Apply disabled.

### Import data
- `ImportFormat { kind: "csv"|"json"|"ndjson"|null, delimiter, quote ("" = none, null = "), header, encoding:
  "utf8"|"utf16le"|"utf16be"|"latin1"|null, nullText, dateFormat, flatten }` — null = detect. Detection (first 1 MiB):
  BOM / valid UTF-8 / UTF-16 without BOM (zero-byte pattern) / else Latin-1 (Windows-1252, note); kind by extension
  (.csv .tsv .tab .txt .json .ndjson .jsonl) then content (`[` → array, `{` → NDJSON); delimiter among , ; Tab | with
  the most consistent field count over ≤ 40 complete records; header = first row has no empty / duplicate / numeric /
  date values.
- CSV parser (`importfmt::CsvParser`, streaming): quoted fields with doubled quotes, delimiters and line breaks inside
  quotes, CRLF / LF / CR, BOM dropped by the decoder, blank lines skipped, records keep their 1-based start line;
  unterminated quote reported. JSON arrays are split element by element (`JsonArraySplitter`) and parsed with
  serde_json; NDJSON line by line. JSON objects: nested objects → `a.b` columns when flatten (default), arrays / other
  objects → JSON text, null → NULL; columns = union of keys in the sample, in first-seen order.
- NULL rules: empty field (CSV) is NULL; a value equal to nullText is NULL (JSON: only nullText).
- `ImportPreview { format (effective, all set), columns, rows (first 50), lines, sampleRows (≤ 1000), totalRows (exact
  when the whole file fit in 1 MiB) | null, estimatedRows, fileSize, warnings (one column → "delimiter is probably
  wrong", ragged rows, undecodable characters, Latin-1 mojibake → "most likely UTF-8", header off, unterminated quote,
  bad JSON records), encodingNote, inferred: { kind: int|bigint|decimal|bool|date|timestamp|json|text, maxLen,
  precision, scale, nullable }[], checks: (ImportCheck|null)[] }`. `checkTypes[i]` = target type of source column i:
  each sample value is converted; `ImportCheck { value, line, message, bad (count), fix: { label, kind:
  "dateFormat"|"nullText", value } | null }` — fix = the first of `DATE_CANDIDATES` parsing every sample value, or
  "Treat “x” as NULL" when all failing values are the same short text.
- Conversion (`importfmt::convert`, per target type class): int types → i64 (12.0 accepted); numeric / decimal / money
  / float → validated number text (SQLite: number); bool (bool, boolean, bit, tinyint(1)) ← true/false/t/f/yes/no/y/n/
  1/0 → PG 'true'/'false', MSSQL bit, MySQL / SQLite 1/0; date → `YYYY-MM-DD`; timestamp / datetime / datetime2 →
  `YYYY-MM-DD HH:MM:SS[.f]` (zone kept for timestamptz / datetimeoffset and SQLite); values parsed with dateFormat
  (tokens y M d H m s S; Y/D accepted; lower-case `mm` before any hour = month) else ISO (`-` or `/`, `T` or space,
  Z / ±HH[:MM]); char/varchar(n) length checked; other types as text. A row with a failing value is reported (line,
  column, value, message) without reaching the server.
- `ImportRequest { format (the preview's effective one), sourceColumns, target: { schema, table, createSql: string[] (run
  first) }, mapping: { source (index), column, typeName }[], keyColumns, options: { truncate, onConflict:
  fail|skip|update, batchSize (1–100000), transaction: batch|single, stopAfter (failed rows; 0 = never) } }`.
- import_run: refused on read-only and for Redis / Kafka. A blocking thread reads 256 KB chunks and sends batches
  of rows; each batch becomes multi-row INSERTs with bound parameters, rows per statement = min(batch, param limit /
  columns) with limits PG 65 000, MySQL 65 000, SQLite 32 000, MSSQL 2 000 parameters and ≤ 1000 rows. PG placeholders
  `CAST($n AS <column type>)`, MySQL / SQLite `?`, MSSQL `@Pn`. Conflicts: PG / SQLite `ON CONFLICT DO NOTHING` /
  `ON CONFLICT (keys) DO UPDATE SET c = EXCLUDED.c`; MySQL `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE c = VALUES(c)`;
  MSSQL skip = `INSERT … SELECT … FROM (VALUES …) AS s (…) WHERE NOT EXISTS (… key match)`, update = `MERGE … WHEN
  MATCHED THEN UPDATE … WHEN NOT MATCHED THEN INSERT …;`. Update needs the keys mapped (also skip on MSSQL); a table
  without non-key columns updates nothing. Skip counts `rows − affected` as skipped.
- Transactions: **batch** — BEGIN / INSERTs / COMMIT per batch; a failing batch is rolled back and retried row by row
  (each row on its own) to report the failing rows. **single** — BEGIN at the start (TRUNCATE inside it, except MySQL
  where it runs first with a note), a SAVEPOINT `dt_import` per statement (MSSQL SAVE TRANSACTION), failing statements
  rolled back to it and retried row by row with a savepoint each; at the end COMMIT only when nothing failed, else
  ROLLBACK (`rolledBack`, counts reset, note "One transaction (all or nothing) …"). A server that ends the transaction
  stops the run. `stopAfter` failed rows → stopped. TRUNCATE (SQLite `DELETE FROM`) runs before the rows.
- `ImportProgress { runId, rowsRead, inserted (update mode: inserted or updated), skipped, failed, bytesDone,
  bytesTotal, elapsedMs, failures: { n (sequence, dedupe), line, column, value, message, row (mapped source values) }[]
  (new since the previous event; first 1000 kept), finished, cancelled, rolledBack, stopped, note }`, events at most
  every 150 ms plus one per batch with failures and a final one. import_cancel: flag + `Session::cancel`; an open
  transaction is rolled back.
- UI (`importWizard.ts`): explorer table rows › **Import data…** (that table), schema rows (and MySQL / SQLite
  database rows) › Import data… (choose a table or create one), command id `importData` (File menu, palette). Steps
  File (native open dialog: csv tsv txt tab json ndjson jsonl) → Format (file type, delimiter, quote, header,
  flatten, encoding, NULL text, date format; preview re-read on every change; warnings) → Target (existing table:
  name / contains auto-mapping, a menu per source column incl. "skip", the backend checks with one-click fixes; new
  table: name (file name), include / name / type per column with `typeForKind` defaults per dialect and the ▾ type
  list) → Options (truncate with warning, conflict seg only with the key mapped, batch size, transactions, stop after,
  SQL plan text, production note) → Import (production or truncate → confirm first; a dedicated session; progress bar
  by bytes, counts, rows/s and time left, failed rows (first 200 shown), Stop; afterwards Save failed rows as CSV…
  (line + mapped source columns + error), Copy errors, Open <table>). Closing while running continues in the
  background with a toast at the end. The explorer database is refreshed after a created table / inserted rows.
- Not in this version: dropping a file onto the wizard, pasting from the clipboard (the board's "Paste from
  clipboard"), Pause.

## v0.17 — gap fixes (tab restore, file binding, grid hibernation)

Frontend only; no new commands. Pure logic with node tests: `src/ui/hibernate.ts` (`node scripts/test-hibernate.mjs`).

### Restored tabs
- `WsTab.kind` gains `"sessions"` and `"ddl"` (supersedes "not restored on launch" in both v0.16 sections). Table
  designer tabs are still **not** restored (an unsaved design would be stale; reopen with Edit table…); the workspace
  `active` index counts every tab except designers.
- `WsTab.sessions?: WsSessions { activeOnly, hideIdle, query, auto, every: 2|5|10 }` (default 5). Restored
  `SessionsPane(connId, { state, ensure })` opens no session and runs nothing until first shown; then it connects the
  data source (`ensureConn`, usual recovery), loads and starts auto-refresh (failure → message, retried on the next
  show). Filter / interval changes save the workspace (`onChange`). "Reopen closed tab" brings a Sessions tab back with
  its filters too (before v0.17 it wrongly opened a Kafka group tab).
- `WsTab.ddl?: WsDdl { kind: DdlKind, database (real name), schema, name, arguments, table, options: { indexes,
  comments, qualified } }`; a tab without a valid kind / name is skipped. Restored `DdlPane(target, { lazy: true,
  options })` reads the DDL (`get_ddl`, connecting first) when first shown; toggles save the workspace. DDL tabs of
  non-SQL drivers are dropped. DDL tabs are still not on the "Reopen closed tab" stack.
- As before, tabs whose data source no longer exists are dropped silently.

### File binding
- "Reopen closed tab" keeps the console's binding: `FileBinding.memo(): FileMemo { path, saved (baseline text),
  mtimeMs, eol, bom, dirty, pending (undecided changed-on-disk version) } | null` (null for plain / read-only compare
  consoles) is stored on the closed-tab stack; `adopt(memo)` after reopening restores it without reading the file
  (title = file name, ● = dirty, the changed-on-disk banner if one was pending), then runs `checkDisk()`. Save writes
  to the same file with `expectedMtimeMs`, so `FILE_CHANGED` still guards it.
- App restart (v0.15 `WsConsole.file`): unchanged, plus `restore()` keeps `dirty` from the workspace until the file's
  baseline is read (also when it can't be read), so the ● and the close prompt stay.

### Result-grid hibernation
- Consoles in most-recently-used order (the editor hibernation order and count: `LIVE_CONSOLES` = 10). After every
  `touchConsole` (activation / focus / creation) and after a run that ended while the console was hidden,
  `planHibernation(mru, { live: 10, rowBudget: data.hibernateResultRows })` returns per console `keep | hibernate |
  release`: the first 10 and every visible, running (`busy`) or pending-edit console keep; the others hibernate, and
  release when their kept rows (sum over results, released ones count 0) exceed the budget (> 0).
- **Hibernate**: each result grid's `viewState()` (scroll — tracked from scroll events, since a hidden grid reads 0 —,
  anchor / head selection, widths, base widths, client sort column / direction, filter text, pill meta, value viewer
  open) is kept, `ResultGrid.dispose()` (settings listener, ResizeObserver, animation frame, inline editor, value
  viewer, DOM) and an empty slot takes its element's place. The `QueryResult` (`item.last`), paging, filter-bar state,
  parameters and maxRows stay. Shown again (console `focus()` → the active result; result tab activation → that one)
  → `makeGrid` + `applyGrid` (cross-source: read-only `setResult`) + `setPaging` + `setServerSort` + `restoreView`.
  Never while the grid has pending edits (the whole console is skipped).
- **Release**: rows dropped (`item.last.rows = []`, columns kept), the slot becomes an `r-message` "Results released to
  save memory" with "<n> rows · <columns>", the statement and **Run again** → rebuilds an empty grid with the column
  headers and `rerun(item)` (same session via `ensureSession`, the substituted statement = same parameter values; paged
  results reload their page, cross-source ones re-run with their sources), then re-applies widths / sort / filter /
  scroll. The filter bar is hidden while released. Nothing re-runs by itself.

### Settings
- `data.hibernateResultRows`: number, default 100 000, clamped 0–100 000 000, 0 = never release rows. Settings › Data &
  history › "Release hidden results above": 25 000 / 100 000 / 500 000 rows / Never (another stored value is shown as
  an extra option).
- Unchanged and still relevant: `data.restoreConsoles` (restore on launch), `data.idleDisconnectMinutes`; the live
  editor / grid count (10) is a constant, not a setting.

## v0.17 — gap fixes (safety coverage, Redis/Kafka help, MSSQL actual plan)

Frontend plus one backend change (`db/mssql.rs`); **no new commands**. Pure logic with node tests
(`node scripts/test-ops.mjs`): `src/ui/prodSafety.ts` (classifiers, edit statements), `src/ui/explainPlan.ts` (actual
plan), `src/help/articles.ts` (`errorArticleFor`).

### Production confirmation: grid edits, Redis, Kafka
- All use the v0.16 production dialog (`opsConfirm`, production color, typed-name step) and the same rule: asked when
  **Confirm before writes**, or when destructive and **Type the data source name** (then the name is required). When
  the production dialog applies it replaces the plain confirmation of that action (never two prompts); otherwise the
  old flow is unchanged.
- **Grid edits** (`ConsolePane.submitEdits`, before `apply_edits`; `confirmProdEdits`): rows Data source · database,
  Changes ("2 updates, 1 insert, 3 deletes" — `summarizeEdits` / `editCountsText`), Table(s); warning when rows are
  deleted; the SQL block = `editStatements` (the shape of the backend's `build_edit`: quoted identifiers, values written
  as literals for reading — the backend still binds them as parameters), first 8 / ≤ 1600 chars, then `-- +N more`
  (`statementListText`). Cancel → nothing is sent, the changes stay pending. Grid edits never trigger Settings ›
  Confirm risky statements (each targets one row by its key).
- **Redis** (`classifyRedisCommand`, mirrors `db/redis.rs is_write_command`; tokenizer `redisArgs`): reads pass; writes
  (SET…, DEL, UNLINK, EXPIRE*, HSET, LPUSH, INCR*, *STORE, SORT … STORE, CONFIG SET / REWRITE / RESETSTAT, ACL changes,
  SCRIPT / FUNCTION changes, EVAL / FCALL, JSON.*…) are writes; FLUSHDB, FLUSHALL, SWAPDB, SHUTDOWN, SCRIPT / FUNCTION
  FLUSH are destructive. Console runs (`confirmProdCommands`: every non-comment line of the statements; one → Data
  source · dbN, Command, Key / Keys, warning, the command line; several → summary). Explorer / key tab
  (`confirmProdRedisAction`): Set TTL (`EXPIRE key n` / `PERSIST key`, after the TTL prompt), Delete key (`DEL key`,
  replaces the plain confirm), folder › delete the loaded keys (bulk: destructive → typed data source name; note "Only
  keys already loaded…").
- **Kafka** (`classifyKafkaCommand`: `produce`, `create topic` = writes, `delete topic` = destructive; `KafkaAction` +
  `kafkaActionText` for the panes): console lines as above; Produce message dialog (topic, partition, the equivalent
  `produce …` line), Create topic, Reset offsets (group, topic, target, partition count) via `confirmProdKafka`.
  **Delete topic** on production: the production dialog replaces the type-the-topic prompt and always needs a typed name
  — the data source name when "Type the data source name" is on, else the topic name. The Kafka dialogs' Escape handler
  leaves an open production dialog alone.
- `OpsConfirmOptions.typeLabel` (accessible label of the typed field). Connection dialog texts and the PRODUCTION bar
  note mention the new coverage (bar: "FLUSHDB / FLUSHALL ask for the name", "delete topic asks for the name").
- Still not covered: Run SQL file and Import data (their own production warnings).

### Error help for Redis / Kafka
- `ERROR_HELP` entries may carry `drivers` (only those drivers match); `errorArticleFor(msg, {vault, driver})` (pure)
  is used by `helpForError`. New articles (topic Troubleshooting): `trouble-redis-command` (unknown command, wrong
  number of arguments, syntax error, quoting, WRONGTYPE, not an integer / float, MULTI / SUBSCRIBE / SELECT refused,
  read-only), `trouble-redis-server` (READONLY replica, MOVED / ASK / CROSSSLOT / CLUSTERDOWN, OOM, NOPERM, LOADING,
  BUSY, MISCONF, MASTERDOWN, NOSCRIPT), `trouble-kafka-command` (the console language, Usage / Expected name=value /
  numbers / timestamps, read-only), `trouble-kafka-admin` (already exists, unknown topic, replication factor,
  partitions, authorization, policy violation, group must be Empty, message too large). Cross-source entries are
  limited to the SQL drivers; Redis / Kafka errors never lead to SQL articles.
- `errorHelpButton(msg, {vault, driver, command})`: for the command articles the popover's tip line is the command's
  syntax (`REDIS_COMMANDS` / `KAFKA_COMMANDS` signature; unknown Redis command → spelling / module note; unknown Kafka
  command → the command list). Used by the console error view (driver + the failed line for Redis / Kafka consoles),
  the key tab ("Could not read the key"), the Kafka topic and group tabs and the Kafka dialogs' error lines (produce,
  create topic, reset offsets). AI (Fix with AI) stays SQL-only: it isn't offered in Redis / Kafka consoles.

### SQL Server actual plan (ANALYZE)
- `analyzeSupported("mssql") = true`. `explainRequest` for SQL Server: estimated `SET SHOWPLAN_XML ON` / statement /
  `SET SHOWPLAN_XML OFF`; ANALYZE `SET STATISTICS XML ON` / statement / `SET STATISTICS XML OFF` (separate executes,
  OFF always runs). The statement is sent as `/*datatrip:showplan*/ <statement>` (`MSSQL_SHOWPLAN_MARKER`).
- Backend `mssql::stream`: a statement starting with that marker runs in **plan mode** — no `SELECT @@ROWCOUNT`
  appended (this also fixes the estimated plan of INSERT / UPDATE / DELETE / MERGE, whose XML was swallowed by the
  row-count handling), result sets whose first column name contains "showplan" (`Microsoft SQL Server 2005 XML
  Showplan`) are returned as one column `Showplan` with one row per plan, every other result set (the rows of an
  analyzed SELECT) is read and dropped.
- Writes: after the same ANALYZE confirmation as PostgreSQL, inside `BEGIN TRANSACTION` … `ROLLBACK TRANSACTION`; in a
  manual / typed transaction `SAVE TRANSACTION dt_explain` … `ROLLBACK TRANSACTION dt_explain` (no RELEASE;
  `db::tx_control` treats `ROLLBACK TRAN <name>` as a savepoint rollback).
- Parser (`parseMssqlXml(xml, sql, analyze)`): `RunTimeInformation / RunTimeCountersPerThread` of each RelOp → rows =
  Σ ActualRows over threads; executions = Σ ActualExecutions, except a parallel operator every active thread ran at
  most once counts as 1; `actRows` = rows / executions (per execution, like PostgreSQL's per-loop rows), `loops` =
  executions; inclusive `totalMs` = the largest ActualElapsedms of a thread (batch-mode operators report their own time:
  their children's inclusive time is added); `removed` = Σ ActualRowsRead − rows; details line "Actual rows: N,
  executions: N, threads, rows read, CPU, logical reads, batch mode". An operator without counters never ran (0 rows,
  0 executions). `QueryTimeStats ElapsedTime` → execution time, `QueryPlan CompileTime` → planning time (first
  statement). Self time, misestimate flags (×N under / over), slowest node and the index hint then work as for
  PostgreSQL; without ActualElapsedms (before SQL Server 2016 SP1) the share falls back to cost. Plan header: "Actual
  plan (STATISTICS XML)".


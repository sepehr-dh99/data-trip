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

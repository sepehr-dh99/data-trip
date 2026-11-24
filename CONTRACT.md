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

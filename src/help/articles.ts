// Help center content (v0.15, board S). Plain data: short, task-based articles in a small Markdown subset
// rendered by src/ui/help.ts (## / ### headings, paragraphs, "- " lists, "1. " steps, "> " tips, ```sql code,
// `code`, **bold**, [text](#article-id) links). `{key:actionId}` becomes the action's current shortcut, `{bind:Mod-S}`
// a fixed one in the platform's notation, `{modkey}` ⌘ / Ctrl, and a body of `{shortcuts}` the generated list.

export type TopicId = "start" | "connect" | "console" | "results" | "files" | "cross" | "ai" | "vault" | "kafka" | "keys" | "trouble";

export interface HelpTopic {
  id: TopicId;
  name: string;
  glyph: string;
  color: string;
}

export interface HelpTry {
  label: string;
  /** Opens a new console (current data source) with this SQL. */
  sql?: string;
  /** Runs an app command (MenuCommand id). */
  command?: string;
}

export interface HelpArticle {
  id: string;
  topic: TopicId;
  title: string;
  lead: string;
  body: string;
  /** Extra search words. */
  keywords?: string;
  tryIt?: HelpTry;
  related?: string[];
}

export const TOPICS: HelpTopic[] = [
  { id: "start", glyph: "★", color: "#ffd60a", name: "Getting started" },
  { id: "connect", glyph: "◎", color: "#40c8e0", name: "Connect to a database" },
  { id: "console", glyph: "›_", color: "#a6a6ae", name: "Consoles & running SQL" },
  { id: "results", glyph: "▦", color: "#8fb4ff", name: "Results, editing & export" },
  { id: "files", glyph: "▤", color: "#a6a6ae", name: "SQL files" },
  { id: "cross", glyph: "⇄", color: "#ff7088", name: "Cross-source queries" },
  { id: "ai", glyph: "✦", color: "#d9a6ff", name: "AI assistant" },
  { id: "vault", glyph: "⚿", color: "#ffc56b", name: "Vault, SSH & OIDC" },
  { id: "kafka", glyph: "K", color: "#bf5af2", name: "Kafka & Redis" },
  { id: "keys", glyph: "⌘", color: "#a6a6ae", name: "Keyboard shortcuts" },
  { id: "trouble", glyph: "!", color: "#ff8f87", name: "Troubleshooting" },
];

export const ARTICLES: HelpArticle[] = [
  // ------------------------------------------------------------------ getting started
  {
    id: "start",
    topic: "start",
    title: "Getting started",
    lead: "DataTrip is a database IDE: connect, explore, query and edit data on PostgreSQL, MySQL / MariaDB, SQLite, SQL Server, Redis and Kafka.",
    body: `1. Click **+** next to the explorer filter to add a connection (or import yours from DataGrip: File › Import from DataGrip…).
2. Open a console with {key:newConsole} and write SQL; {key:runStatement} runs the statement under the cursor, {key:runAll} runs them all.
3. Double-click a table in the explorer to open its data. Edit cells right in the grid.
4. Press {key:commandPalette} any time to find any action, data source, table or open tab.

Passwords and tokens are kept in your system keychain, never in DataTrip's files. Open tabs come back the next time you start DataTrip (Settings › Data & history).`,
    keywords: "intro welcome first steps overview",
    tryIt: { label: "Add a connection", command: "newConnection" },
    related: ["connect", "consoles", "shortcuts"],
  },

  // ------------------------------------------------------------------ connect
  {
    id: "connect",
    topic: "connect",
    title: "Connect to a database",
    lead: "Every data source is a connection in the explorer. Click + next to the filter, pick the type and fill in where it lives.",
    body: `1. Choose the type: PostgreSQL, MySQL / MariaDB, SQLite, SQL Server, Redis or Kafka.
2. Enter host and port (SQLite: pick the database file; Kafka: the bootstrap servers).
3. Pick how to sign in: a password (stored in the keychain) or **HashiCorp Vault** (see [Vault profiles and tokens](#vault)).
4. Click **Test connection**, then **Save**. The data source connects and its databases appear in the explorer.

## Options worth knowing
- **SSL mode** (PostgreSQL, MySQL): Disable, Prefer, Require, Verify CA, Verify full. For the verify modes, choose the server's CA certificate. See [TLS and certificates](#connect-tls).
- **SSH tunnel**: reach a database behind a bastion. See [SSH tunnels](#ssh).
- **Read-only**: refuses grid edits and sends read-only session settings where the database supports them. Read-only data sources count as production for the AI assistant.
- **Folder**, color and icon keep a long list tidy (right-click › Color & icon…).

> Already use DataGrip? Copy data sources there (they go to the clipboard as #DataSourceSettings#) and paste anywhere in DataTrip outside a text field, or pick a project's .idea/dataSources.xml.`,
    keywords: "connection data source new add host port password database postgres mysql mariadb sqlite sql server mssql import datagrip",
    tryIt: { label: "Add a connection", command: "newConnection" },
    related: ["connect-tls", "ssh", "vault", "trouble-cant-connect"],
  },
  {
    id: "connect-tls",
    topic: "connect",
    title: "TLS and certificates",
    lead: "Encrypt the connection and check that you are talking to the right server.",
    body: `- **PostgreSQL / MySQL**: SSL mode Prefer uses TLS when the server offers it. Require insists on TLS. **Verify CA** also checks the certificate against the CA file you choose; **Verify full** checks the host name too.
- **SQL Server**: TLS is negotiated with the server. Turn on **Trust server certificate** only for servers with self-signed certificates you trust.
- **Redis**: turn on **Use TLS (rediss://)**.
- **Kafka**: the **Security protocol** decides: SSL / SASL_SSL use TLS (choose a CA certificate, and a client certificate for mutual TLS); PLAINTEXT / SASL_PLAINTEXT don't.
- **Vault**: the Vault profile has its own CA certificate setting.

Certificates are PEM files. Skipping verification is marked "Insecure" in the dialog: use a CA certificate instead whenever you can.`,
    keywords: "ssl tls certificate ca pem verify encrypt rediss",
    related: ["connect", "kafka-connect"],
  },
  {
    id: "redis-sentinel",
    topic: "connect",
    title: "Redis Sentinel",
    lead: "With Sentinel, DataTrip asks the sentinels where the master (or a healthy replica) is and connects there — and follows a failover on the next reconnect.",
    body: `1. Choose Redis, then **Mode: Sentinel**.
2. Add the **Sentinel nodes** as host:port (default port 26379). Paste a comma- or space-separated list to add several.
3. Enter the **Master name** (empty = mymaster) — the name the sentinels monitor, from sentinel.conf (\`sentinel monitor <name> …\`).
4. **Read from**: Master, or Replica (a healthy replica; falls back to the master).
5. If the sentinels have their own requirepass, turn on **Sentinels need their own password**. The password under "Master authentication" is for the Redis nodes.

**Test connection** shows which sentinel answered, where the master is, its replicas and the PING time. TLS, the ACL user and the DB index apply to the node DataTrip connects to; an SSH tunnel covers the sentinels and the nodes they report.`,
    keywords: "redis sentinel master name failover replica high availability",
    related: ["connect", "redis"],
  },
  {
    id: "kafka-connect",
    topic: "connect",
    title: "Connect to Kafka",
    lead: "Kafka needs bootstrap servers reachable from your computer and the security settings of the cluster.",
    body: `1. Choose Kafka and enter the **Bootstrap servers**: host:port, comma-separated (e.g. \`broker1:9092,broker2:9092\`).
2. Pick the **Security protocol** the cluster uses: PLAINTEXT, SSL, SASL_PLAINTEXT or SASL_SSL.
3. With SASL, choose the mechanism (PLAIN, SCRAM-SHA-256, SCRAM-SHA-512) and enter the user and password.
4. **Test connection**.

> The bootstrap servers only tell DataTrip where the brokers are: messages are then read from each partition leader at the address it advertises. If topics list but messages never arrive, see [Messages don't arrive](#trouble-kafka-no-messages).

SSH tunnels aren't supported for Kafka (brokers advertise their own addresses).`,
    keywords: "kafka bootstrap servers broker security protocol sasl scram plain ssl",
    related: ["trouble-kafka-host", "trouble-kafka-transport", "kafka"],
  },

  // ------------------------------------------------------------------ consoles
  {
    id: "consoles",
    topic: "console",
    title: "Consoles & running SQL",
    lead: "A console is an editor bound to one data source and database. Run one statement, a selection, or the whole script.",
    body: `- **Run** or {key:runStatement}: the selection, else the statement under the cursor.
- **Run all** or {key:runAll}: every statement, one after another; each result gets its own tab.
- The **▶ in the gutter** runs that statement. Alt / Option-click runs it into a new result tab and keeps the others.
- **Cancel** or {key:cancel} stops a running statement.
- **Format SQL** ({key:formatSql}) formats the selection or the statement at the cursor; one undo step.
- The breadcrumb at the top switches data source, database and schema of the console.

## Transactions
The capsule's transaction button switches between **Auto-commit** (every statement is committed) and **Manual**: DataTrip opens a transaction before the next statement and you **Commit** or **Roll back**. A tab with an open transaction shows a dot.

## Results and paging
A SELECT shows the first page (Settings › Results grid › Page size); **Load more** fetches the next one and **Count rows** runs a COUNT(*). DROP, TRUNCATE and DELETE / UPDATE without WHERE ask first (Settings › Data & history).

## History
Every statement you run is kept per data source: **Query history** ({bind:Mod-Shift-H}) — click to insert, double-click to run. Settings › Data & history sets how long it is kept.

## Many consoles
Open as many consoles as you like: the ones you haven't used lately sleep to save memory and wake up as they were when you come back. Your tabs come back at the next start too. See [Many consoles, memory and restored tabs](#many-consoles).

> Lost the connection (VPN dropped, server restarted)? Read-only statements reconnect and run again by themselves; others show a Reconnect button. See [Connection lost](#trouble-connection-lost).`,
    keywords: "run execute statement cursor gutter cancel transaction commit rollback auto-commit manual history format paging load more count",
    tryIt: { label: "Try it in a new console", sql: "-- Put the cursor on a statement and press Run\nSELECT 1 AS one;\n\nSELECT 2 AS two;\n" },
    related: ["results", "sql-files", "many-consoles", "shortcuts"],
  },
  {
    id: "many-consoles",
    topic: "console",
    title: "Many consoles, memory and restored tabs",
    lead: "DataTrip keeps the 10 consoles you used most recently fully alive. The others sleep — nothing is lost — so memory stays bounded however many tabs are open.",
    body: `## Sleeping consoles
- A console you haven't used among the last 10 releases its editor and its result grid. Its text, undo history, cursor, results and settings stay.
- When you open it again, the editor and the grid come back as they were: scroll position, selected cells, column widths, sort and the filter text.
- A console with pending grid edits (not submitted yet), a running statement or the one on screen never sleeps.

## Released results
A sleeping console that holds more result rows than **Settings › Data & history › Release hidden results above** (100,000 rows by default; **Never** turns this off) also lets go of the rows. Its result then reads **Results released to save memory**, with the row count and the columns it had.
- **Run again** runs that statement once more on the console's session — with the same parameter values — and shows fresh rows.
- Nothing is re-run by itself: a released result stays released until you click Run again or run something new.

## Tabs that come back
With **Settings › Data & history › Restore consoles on launch** on, DataTrip reopens your tabs at the next start, without connecting anything until you look at them:
- Consoles with their text, cursor, database, schema, attached sources and **.sql file**: a console bound to a file is still bound to it (● for unsaved changes; Save writes to the same file and still notices when the file changed on disk).
- **Sessions & locks** tabs with their filters and auto-refresh interval; they connect and start refreshing when shown.
- **Show DDL** tabs with their toggles; the DDL is read from the database again when you first open the tab.
- Redis key and Kafka topic / group tabs.
- Table designer tabs aren't restored (unsaved designs would be stale) — open the table again with Edit table…. Tabs of data sources you deleted are left out.

{key:reopenTab} (**Reopen closed tab**) brings back a console you just closed with its text and its .sql file binding — including unsaved changes — and a Sessions & locks tab with its filters. Results aren't kept.`,
    keywords: "memory performance slow many tabs hibernate sleep released results run again restore launch reopen closed tab workspace restart session file binding",
    related: ["consoles", "sql-files", "sessions-locks", "show-ddl"],
  },

  // ------------------------------------------------------------------ results
  {
    id: "results",
    topic: "results",
    title: "Results, editing & export",
    lead: "Results open in a fast grid. Tables you opened from the explorer (or a simple SELECT of one table) can be edited in place.",
    body: `## Editing
1. Double-click a cell, or select it and press Enter / F2.
2. Change the value. **Set NULL** sets the selected cells to NULL; **Delete** marks rows for deletion. Edited cells are highlighted and the tab shows a dot.
3. **Submit** (or {bind:Mod-S} with the grid focused) runs all edits in one transaction; **Revert** discards them.

Read-only data sources and results of several tables can't be edited.

## Filter and sort
Table consoles have a filter bar: type a WHERE condition and an ORDER BY, or click a column header to sort (Shift-click adds a column).

## Export and copy
- **Export…** (or {bind:Mod-Shift-E} in the grid): CSV, TSV, JSON, SQL INSERT or Markdown, with a preview — to a file (the whole query runs again without the row limit) or to the clipboard.
- Select cells and copy with {bind:Mod-C}; right-click › Copy as CSV, JSON, SQL INSERT or Markdown.`,
    keywords: "grid edit cell update insert delete submit save export csv json tsv markdown copy filter sort where order by null",
    related: ["consoles", "trouble-mssql-paging"],
  },

  // ------------------------------------------------------------------ SQL files
  {
    id: "sql-files",
    topic: "files",
    title: "Save, open and export SQL files",
    lead: "A console can be bound to a .sql file: the tab is named after the file, ● marks unsaved changes and {key:saveFile} writes back to it.",
    body: `- **Save** ({key:saveFile}): a console bound to a file writes back to it; a plain console asks where to save first. (With the result grid focused, {bind:Mod-S} submits grid edits instead.)
- **Save as…** ({key:saveFileAs}) writes to a new file and binds the console to it.
- **Export selection as .sql…** writes the selection (or the whole console) to a file without binding it.
- **Open SQL file…** ({key:openFile}): pick a .sql or .txt file, then the data source and database to run it against. DataTrip remembers that choice per file. **Recent files** are in File ▾ and {key:commandPalette}.
- **Drag a .sql file** onto the window to open a copy in a new console (not bound to the file — Save as chooses where it's saved).

All of this is in **File ▾** in the console's toolbar, the app menu (File) and the command palette.

## Changed on disk
When a file changes outside DataTrip (git pull, another editor), the console shows a banner when you come back: **Reload from disk**, **Keep mine** (the next save overwrites the file), or **Compare** (the disk version opens in a read-only tab). Saving over a file that changed meanwhile asks before overwriting.

Files keep their line endings (LF or CRLF) and byte-order mark. Consoles open files up to 8 MB; run bigger scripts with [Run SQL file](#run-sql-file).`,
    keywords: "file save open export sql txt disk changed reload recent drag drop",
    tryIt: { label: "Open SQL file…", command: "openFile" },
    related: ["run-sql-file", "consoles"],
  },
  {
    id: "run-sql-file",
    topic: "files",
    title: "Run a SQL file on a data source",
    lead: "Run a whole script — seed data, a dump, a migration — without loading it into the editor. Good for files of any size.",
    body: `1. Right-click a data source › **Run SQL file…**, or File ▾ › **Run SQL file on a data source…** in a console.
2. Pick the file. A panel opens at the bottom of a console of that data source.
3. Choose the options and click **Run**:
- **Stop on first error** — otherwise failures are listed and the run goes on.
- **One transaction per N statements** (default 500) — much faster for big inserts; a failure rolls back that batch.
- **Run in a single transaction** — all or nothing: the first error rolls everything back.

The panel shows progress, statements done, failures with their line numbers, and the time left. **Stop** cancels the running statement and rolls back an open transaction.

The file runs on its own connection, so the console's transaction mode doesn't apply. Statements are split like in a console (quotes, comments, PostgreSQL $$ bodies); MySQL \`DELIMITER\` lines and SQL Server \`GO\` batch separators work as in the command-line clients. If the file has its own BEGIN / COMMIT, DataTrip stops adding transactions around it. MySQL commits around CREATE / ALTER / DROP, so those can't be rolled back.`,
    keywords: "run script file seed dump migration import batch transaction big large go delimiter",
    tryIt: { label: "Run SQL file…", command: "runSqlFile" },
    related: ["sql-files", "consoles"],
  },

  // ------------------------------------------------------------------ cross-source
  {
    id: "cross-source",
    topic: "cross",
    title: "Query several data sources at once",
    lead: "Join tables that live on different servers — PostgreSQL with MySQL, prod with stage — in one SELECT. DataTrip fetches the rows it needs from each and joins them on your computer.",
    body: `1. Write the data source name, then the database, then the table: \`asia32.postgres.orders\`. The name is the one in the explorer, in lowercase with _ for spaces and other characters ("Stage MySQL" → \`stage_mysql\`; the explorer tooltip shows it). Or quote the exact name: \`"Stage MySQL".shop.users\`.
2. Use it in FROM and JOIN like any table, from any SQL console. Nothing needs to be attached.
3. Run with {key:runStatement}. **How it ran** shows what each server returned. Results are read-only.

\`\`\`sql
SELECT o.id, o.total, u.email
FROM asia32.postgres.orders o
JOIN stage_mysql.shop.users u ON u.id = o.user_id;
\`\`\`

## Rules
- PostgreSQL and SQL Server also take a schema: \`source.database.schema.table\` (default public / dbo). SQLite: \`source.table\` or \`source.main.table\`.
- Filters on one table (AND-ed WHERE conditions) run at that source; the join runs in memory with SQLite syntax.
- At most 200 000 rows are pulled per table — add a WHERE filter for bigger tables.
- Only SELECT / WITH. PostgreSQL, MySQL, SQLite and SQL Server sources.
- If two data sources have the same lowercase name, quote the exact name or rename one (see [Name matches more than one data source](#trouble-cross-ambiguous)).

Tip: {modkey}-click two data sources in the explorer › **New cross-source console** opens a console with a guide and an example query built from real tables. Dragging a table from another data source inserts its full name.`,
    keywords: "join federated several multiple data sources servers datasource database table cross source alias",
    tryIt: { label: "Try it in a new cross-source console", command: "newCrossSource" },
    related: ["consoles", "trouble-cross-ambiguous"],
  },

  // ------------------------------------------------------------------ AI
  {
    id: "ai-assistant",
    topic: "ai",
    title: "AI assistant",
    lead: "Describe a query in words and an AI model writes the SQL into your console. Nothing runs until you run it.",
    body: `1. In a SQL console press {key:askAi} (or **✦ Ask AI**), type what you want and press Enter.
2. The SQL appears as a highlighted insertion: **Accept** (Tab), **Reject** (Esc), **Refine…** or **Explain**.
3. A failed statement gets **✦ Fix with AI**, shown as a diff. With text selected, **Explain selection**.

## Providers (Settings › AI assistant)
- **Codex CLI** (default): uses your ChatGPT sign-in — install with \`npm i -g @openai/codex\`, then run \`codex login\` once.
- **Claude Code** or **OpenCode** CLIs you are signed in to.
- An **OpenAI-compatible API** key (kept in the keychain) with an optional base URL.
- **Ollama** running locally.

## What is sent
The schema of the tables your question is about — table and column names, types, keys — and the statement / error for Fix and Explain. **No rows**, unless you turn on "Include 20 sample rows" (20 rows of up to 3 tables; these queries appear in your history).

## Production data sources
Data sources that are read-only, or have "prod" / "production" as a word in their name or folder, get no AI at all while "Block AI for production data sources" is on (the default). Sample rows are never sent for them.`,
    keywords: "ai llm codex claude opencode openai ollama chatgpt generate write explain fix privacy prod production",
    related: ["trouble-appimage-ai", "consoles"],
  },

  // ------------------------------------------------------------------ Vault / SSH / OIDC
  {
    id: "vault",
    topic: "vault",
    title: "Vault profiles and tokens",
    lead: "Read database credentials from HashiCorp Vault instead of storing a password. A Vault profile (address + token) can be shared by many data sources.",
    body: `1. Open **Vault profiles** from the sidebar toolbar and add one: the Vault address (empty = VAULT_ADDR), namespace and CA certificate if needed.
2. Pick where the token comes from: **Token file** (\`~/.vault-token\`, what \`vault login\` writes), **Environment** (VAULT_TOKEN of the environment DataTrip was started in), **Keychain** (paste it once), or **OIDC** (sign in with your browser — see [Vault OIDC sign-in](#vault-oidc)).
3. In the connection dialog choose **HashiCorp Vault**, the profile and the secret path (e.g. \`database/creds/readonly\` or a KV path). **Test Vault** shows what was found.

KV v1 and v2 secrets and dynamic database credentials work. Dynamic credentials are shared by the console tabs of a data source until shortly before their lease ends; DataTrip then connects with fresh ones.

The sidebar shows a chip per profile with the time the token has left. Pasting a Vault token (hvs.…) anywhere outside a text field offers to use it for a profile.`,
    keywords: "vault hashicorp token secret kv dynamic credentials lease profile keychain",
    related: ["vault-oidc", "trouble-vault-expired", "trouble-vault-denied"],
  },
  {
    id: "vault-oidc",
    topic: "vault",
    title: "Vault OIDC sign-in",
    lead: "Sign in to Vault with your company login (Okta, Azure AD, Google…) instead of copying tokens.",
    body: `1. In the Vault profile choose token source **OIDC**.
2. **Mount path**: where the OIDC auth method is enabled in Vault (default \`oidc\`; the path in \`vault login -method=oidc -path=…\`).
3. **Role** (optional): the Vault role to sign in with; empty uses the mount's default role.
4. Click **Sign in**: a sign-in window opens; when you finish, the token is stored in the keychain like a pasted one.

The redirect URI \`http://localhost:8250/oidc/callback\` must be in the role's allowed_redirect_uris (the same one the vault CLI uses). DataTrip renews a renewable token while the app is open; when it finally expires, sign in again from the profile's chip.`,
    keywords: "oidc sso okta azure google sign in browser role mount redirect uri",
    related: ["vault", "trouble-vault-expired"],
  },
  {
    id: "ssh",
    topic: "vault",
    title: "SSH tunnels",
    lead: "Reach a database that only a bastion (jump host) can see.",
    body: `1. Open **SSH configurations** from the sidebar toolbar and add the bastion: host, port, user and a private key (with its passphrase) or a password.
2. In the connection dialog open **SSH tunnel**, turn on "Connect through an SSH tunnel" and pick the configuration.
3. Enter the database host and port **as the bastion sees them** (often a private name or IP).

The first time, DataTrip shows the server's key fingerprint and asks you to trust it. One tunnel is shared by all tabs of a data source and reopened on reconnect. Not available for Kafka.`,
    keywords: "ssh tunnel bastion jump host key fingerprint port forward",
    related: ["trouble-ssh-hostkey", "connect"],
  },

  // ------------------------------------------------------------------ Kafka & Redis
  {
    id: "kafka",
    topic: "kafka",
    title: "Working with Kafka",
    lead: "Browse topics, consumer groups and brokers in the explorer; read and produce messages.",
    body: `- Click a topic to open it: partitions, offsets and the latest messages. Filter by partition, offset or time; **Produce message…** sends one (with key and headers).
- Consumer groups show their lag per partition; **Reset offsets** moves a group (it must have no active members).
- A Kafka console runs one command per line, e.g. \`consume orders.v2 --latest --limit 20\`, \`topics\`, \`groups\`, \`describe topic orders.v2\`.

Read-only Kafka data sources can't produce, reset offsets, create or delete topics.`,
    keywords: "kafka topic partition offset consumer group lag produce message broker",
    related: ["kafka-connect", "trouble-kafka-no-messages"],
  },
  {
    id: "redis",
    topic: "kafka",
    title: "Working with Redis",
    lead: "Browse keys as a tree (split on : ), look at values, change TTLs and run commands.",
    body: `- Expand a database (db0, db1…) to scan its keys; the explorer filter then works as the SCAN pattern (case-sensitive). **Load more…** continues the scan.
- Click a key to open it: strings, hashes, lists, sets, sorted sets, streams and JSON have their own views.
- Right-click a key: **Set TTL…**, **Delete…**; a folder: delete all loaded keys under it.
- A Redis console runs one command per line (\`GET user:42\`, \`HGETALL session:1\`); {key:runStatement} runs the line under the cursor.

For high availability setups see [Redis Sentinel](#redis-sentinel).`,
    keywords: "redis key value ttl expire scan pattern hash list set zset stream json command",
    related: ["redis-sentinel"],
  },

  // ------------------------------------------------------------------ shortcuts (generated)
  {
    id: "shortcuts",
    topic: "keys",
    title: "Keyboard shortcuts",
    lead: "Your current shortcuts. Change them, or switch to the DataGrip or VS Code preset, in Settings › Keymap.",
    body: "{shortcuts}",
    keywords: "keyboard shortcut keymap binding hotkey preset datagrip vscode",
    tryIt: { label: "Change shortcuts…", command: "keyboardShortcuts" },
    related: ["consoles"],
  },

  // ------------------------------------------------------------------ troubleshooting
  {
    id: "trouble-kafka-host",
    topic: "trouble",
    title: "“host name not found” for a Kafka broker",
    lead: "The address is a name that only exists inside a cluster (often Kubernetes: *.svc, *.cluster.local, *-headless.<namespace>), so your computer can't look it up — even on VPN.",
    body: `**Fix:** ask your infrastructure team for bootstrap servers reachable over VPN (often IP:port like \`172.25.1.70:9092\`, or an external listener's host name) and use those.

If topics list but messages don't load, the brokers advertise internal names: see [Messages don't arrive](#trouble-kafka-no-messages).`,
    keywords: "kafka host name not found kubernetes internal headless svc dns resolve",
    related: ["kafka-connect", "trouble-kafka-no-messages", "trouble-kafka-transport"],
  },
  {
    id: "trouble-kafka-transport",
    topic: "trouble",
    title: "Kafka: BrokerTransportFailure / can't connect",
    lead: "DataTrip couldn't talk to any bootstrap server. The error says whether the servers can't be reached at all, or accept connections but the handshake fails.",
    body: `- **Can't be reached** (timed out, connection refused): check you're on the right network / VPN and the host:port. Brokers only reachable through an SSH jump host aren't supported.
- **Reachable, but the handshake failed**: the **Security protocol** probably doesn't match the listener — e.g. PLAINTEXT against a TLS port, or SASL settings missing. Try SSL / SASL_SSL, check the SASL mechanism and credentials, and the CA certificate.`,
    keywords: "kafka brokertransportfailure transport failure all brokers down handshake timed out refused",
    related: ["kafka-connect", "connect-tls"],
  },
  {
    id: "trouble-kafka-no-messages",
    topic: "trouble",
    title: "Kafka: topics list, but messages don't arrive",
    lead: "Listing goes through the bootstrap servers, but messages are read from each partition's leader at the address the broker advertises.",
    body: `When those advertised addresses are internal names (Kubernetes services) or unreachable IPs, consuming times out although the partitions hold messages. DataTrip's error names the advertised addresses.

**Fix:** ask for an external listener reachable over VPN (advertised.listeners), or map those names to reachable IPs in your hosts file.`,
    keywords: "kafka no messages arrived advertised listeners leader partition consume timeout",
    related: ["trouble-kafka-host", "kafka"],
  },
  {
    id: "trouble-vault-expired",
    topic: "trouble",
    title: "Vault token expired or invalid",
    lead: "Vault refused the profile's token (permission denied / invalid token): it expired, was revoked, or belongs to another Vault.",
    body: `DataTrip shows an inline prompt to fix it, then retries what failed:
- **Keychain** profiles: paste a fresh token (\`vault login\`, then \`vault print token\`).
- **OIDC** profiles: sign in again.
- **Token file / environment**: run \`vault login\` again (it rewrites ~/.vault-token), or restart DataTrip from a shell with the new VAULT_TOKEN.

The chip in the sidebar shows how long each profile's token has left.`,
    keywords: "vault token expired invalid permission denied 403 revoked login",
    related: ["vault", "vault-oidc"],
  },
  {
    id: "trouble-vault-denied",
    topic: "trouble",
    title: "“permission denied” after the app was idle (Vault)",
    lead: "Dynamic database credentials from Vault have a lease. When it ends, the database user is dropped and the open connection starts failing.",
    body: `DataTrip reconnects with fresh credentials by itself when a lease has run out, or when a Vault data source fails with an authentication / permission error on a connection that has been open a while (not inside a manual transaction). If it still fails:
1. **Reconnect** the data source ({key:reconnect} or right-click › Reconnect).
2. If that fails too, the Vault token itself may have expired: see [Vault token expired](#trouble-vault-expired).
3. Still denied on a fresh connection: the Vault role really lacks that permission — ask whoever manages the role.`,
    keywords: "vault permission denied idle lease expired dynamic credentials password authentication failed role does not exist",
    related: ["vault", "trouble-vault-expired"],
  },
  {
    id: "trouble-ssh-hostkey",
    topic: "trouble",
    title: "SSH host key unknown or changed",
    lead: "DataTrip checks the bastion's key like ssh does, so nobody can sit in the middle.",
    body: `- **Unknown host**: the first connection to a server shows its fingerprint. Compare it with what your admin publishes (\`ssh-keygen -lf\` on the server) and click **Trust**.
- **Host key changed**: the server presents a different key than the one you trusted. That happens when a server is rebuilt — or when someone intercepts the connection. Confirm with the server's admin before trusting the new key.`,
    keywords: "ssh host key fingerprint unknown changed mismatch known hosts trust",
    related: ["ssh"],
  },
  {
    id: "trouble-appimage-ai",
    topic: "trouble",
    title: "AI CLI fails in the Linux AppImage (libffi / library errors)",
    lead: "Older AppImage builds passed their bundled libraries on to programs they start, so node-based CLIs (Codex) failed with errors like “version `LIBFFI_…' not found”.",
    body: `This is fixed: DataTrip now starts the AI CLIs with your system's own libraries. Update to the current version (Help › Check for updates…).

If a CLI still fails, run it once in a terminal (\`codex login\`, \`claude\`) to check it works on its own, then **Check again** in Settings › AI assistant.`,
    keywords: "appimage linux libffi library glibc version not found codex node cli",
    related: ["ai-assistant", "trouble-updates"],
  },
  {
    id: "trouble-updates",
    topic: "trouble",
    title: "“Updates aren't set up for this build”",
    lead: "In-app updates need the project's update signing key compiled in. Builds made without it (e.g. your own build, or a CI run without the key) can't check for updates.",
    body: `Download the newest version from the project's GitHub releases page instead. Builds from the official releases check on launch and once a day (Settings › Updates).`,
    keywords: "update updater not configured signing key release version",
    tryIt: { label: "Check for updates…", command: "checkUpdates" },
    related: ["trouble-appimage-ai"],
  },
  {
    id: "trouble-mssql-paging",
    topic: "trouble",
    title: "SQL Server: only the first page of results",
    lead: "SQL Server can't page a query whose ORDER BY has no TOP inside the wrapper DataTrip uses for paging.",
    body: `For such statements DataTrip shows the first page and turns the pager off (its tooltip says why). To see more:
- raise the page size in Settings › Results grid (or choose "All"), or
- page yourself: \`ORDER BY … OFFSET 500 ROWS FETCH NEXT 500 ROWS ONLY\`.`,
    keywords: "mssql sql server paging page load more order by top offset fetch",
    related: ["results"],
  },
  {
    id: "trouble-cross-ambiguous",
    topic: "trouble",
    title: "“matches more than one data source”",
    lead: "In cross-source queries a data source is written in lowercase with _ for spaces. Two data sources whose names give the same lowercase name (\"Stage DB\" and \"stage-db\" → stage_db) can't be told apart.",
    body: `**Fix:** quote the exact name — \`"Stage DB".shop.users\` — or rename one of them in the explorer.

Also good to know: a name that is no data source, database or schema is underlined in the editor with "No data source named 'x'".`,
    keywords: "cross source ambiguous matches more than one data source slug name quote rename",
    related: ["cross-source"],
  },
  {
    id: "trouble-connection-lost",
    topic: "trouble",
    title: "Connection lost",
    lead: "The network dropped (VPN, sleep), the server restarted or closed an idle connection.",
    body: `With Settings › Data & history › Auto-reconnect on, a read-only statement (SELECT, SHOW, EXPLAIN…) reconnects and runs once more by itself. Statements that change data, and anything inside a manual transaction, are never re-run: the error shows **Reconnect** — click it, then run the statement again. An open manual transaction is lost when the connection drops.`,
    keywords: "connection lost closed reset broken pipe server gone away eof reconnect",
    related: ["consoles", "trouble-cant-connect"],
  },
  {
    id: "trouble-cant-connect",
    topic: "trouble",
    title: "Can't reach the server",
    lead: "Connection refused, timed out or host not found: DataTrip couldn't open a network connection to the database.",
    body: `- Check host and port, and that you're on the VPN / network the server is on.
- Behind a bastion? Use an [SSH tunnel](#ssh) and enter the host as the bastion sees it.
- "Connection refused": the server isn't listening on that port (or a firewall rejects it). "Timed out": a firewall drops the traffic, or the address isn't reachable.
- Docker / Kubernetes: names like \`db\` or \`*.svc.cluster.local\` only exist inside the cluster.`,
    keywords: "connection refused timed out timeout host not found unreachable network vpn firewall",
    related: ["connect", "ssh"],
  },
  {
    id: "trouble-auth",
    topic: "trouble",
    title: "Authentication failed",
    lead: "The server rejected the user name or password.",
    body: `- Re-enter the password in the connection dialog (Edit…) and **Test connection**. Passwords are stored per data source in the keychain.
- MySQL "Access denied for user 'x'@'host'": the user may only be allowed from certain hosts.
- With Vault, the user comes from the secret: **Test Vault** shows which user it returns. After idle time, see [permission denied after idle](#trouble-vault-denied).`,
    keywords: "authentication failed password access denied login failed user wrong credentials",
    related: ["connect", "trouble-vault-denied"],
  },
  // ------------------------------------------------------------------ v0.17: Redis / Kafka errors
  {
    id: "trouble-redis-command",
    topic: "trouble",
    title: "A Redis command failed",
    lead: "Redis rejected the command itself: its name, its arguments, or the type of the key it works on.",
    body: `- **ERR unknown command 'x'**: check the spelling. Commands of modules (JSON.*, FT.*) only exist when the module is loaded on the server. Completion in the console lists the known commands with their arguments.
- **ERR wrong number of arguments** / **syntax error**: compare with the command's syntax (shown above when DataTrip knows it). Arguments are separated by spaces — quote values that contain spaces: \`SET greeting "hello world"\`. In "double quotes" \`\\n\`, \`\\t\`, \`\\"\` and \`\\xHH\` are escapes; 'single quotes' are literal.
- **WRONGTYPE Operation against a key holding the wrong kind of value**: the key exists with another type (e.g. \`GET\` on a hash). \`TYPE key\` tells which; use HGETALL / LRANGE / SMEMBERS / ZRANGE / XRANGE, or open the key from the explorer.
- **value is not an integer or out of range** / **not a valid float**: INCR, EXPIRE, LRANGE… need numbers.
- MULTI / EXEC, SUBSCRIBE / MONITOR and SELECT are not run by the console: each line runs on its own, and the database is picked in the explorer.
- "This connection is read-only": the data source is read-only, so writes are refused. On a **production** data source writes ask first ([Production data sources](#production-safety)).

> Redis consoles run commands, not SQL: one command per line, \`#\` / \`//\` lines are comments, no \`;\` at the end.`,
    keywords: "redis error wrongtype unknown command wrong number of arguments syntax error quotes integer float multi select",
    related: ["redis", "trouble-redis-server"],
  },
  {
    id: "trouble-redis-server",
    topic: "trouble",
    title: "Redis refused the command",
    lead: "The command was fine, but the server can't run it right now or not for you: replica, cluster, memory, permissions.",
    body: `- **READONLY You can't write against a read only replica**: you're connected to a replica. Connect to the primary, or use [Redis Sentinel](#redis-sentinel) so DataTrip finds it.
- **MOVED / ASK / CROSSSLOT / CLUSTERDOWN**: the server is a Redis Cluster node. DataTrip talks to one node: keys of other slots answer MOVED, multi-key commands need keys of one slot (hash tags \`{user:42}:a\`).
- **OOM command not allowed when used memory > 'maxmemory'**: the server is full — delete or expire keys, or raise maxmemory / the eviction policy.
- **NOPERM**: the ACL user may not run this command or touch this key. \`ACL WHOAMI\` shows the user; ask for the permission.
- **LOADING** (server still loading its data), **BUSY** (a script is running), **MISCONF** (snapshots fail, writes are stopped), **MASTERDOWN**: wait, or check the server's logs.
- **NOSCRIPT**: EVALSHA of a script the server doesn't have — run it with EVAL once.`,
    keywords: "redis readonly replica moved ask crossslot cluster oom maxmemory noperm acl loading busy misconf noscript",
    related: ["redis", "redis-sentinel", "trouble-redis-command"],
  },
  {
    id: "trouble-kafka-command",
    topic: "trouble",
    title: "A Kafka console command failed",
    lead: "Kafka consoles run DataTrip's own command language, one command per line — not SQL.",
    body: `- Commands: \`topics\`, \`groups\`, \`brokers\`, \`describe topic <t> [configs]\`, \`describe group <g>\`, \`consume <t> [--from-beginning|--latest|--from-timestamp <ISO>|--offset <n>] [--partition <n>] [--limit <n>] [--key-contains <s>] [--value-contains <s>]\`, \`produce <t> [key=<k>] [partition=<n>] [header.<k>=<v>] value=<v>\`, \`create topic <t> [partitions=<n>] [replication=<n>]\`, \`delete topic <t>\`.
- **Expected name=value**: produce arguments are \`name=value\` pairs; quote a value with spaces: \`value="hello world"\`.
- **must be a number** / **needs a value**: \`--limit\`, \`--offset\`, \`--partition\`, partitions= and replication= take whole numbers; \`--from-timestamp\` takes ISO 8601 (2026-05-01T12:00:00Z) or epoch milliseconds.
- "This connection is read-only": read-only Kafka data sources can't produce, create or delete topics or reset offsets. On a **production** data source these ask first ([Production data sources](#production-safety)).`,
    keywords: "kafka console command usage unknown command produce consume expected name value number timestamp",
    related: ["kafka", "trouble-kafka-admin"],
  },
  {
    id: "trouble-kafka-admin",
    topic: "trouble",
    title: "Kafka refused a topic or group change",
    lead: "The brokers rejected creating, deleting or writing to a topic, or resetting a consumer group.",
    body: `- **Topic already exists** / **Unknown topic or partition** / topic "x" not found: check the name (topic names are case-sensitive); the explorer's topic list may need a refresh.
- **Invalid replication factor**: it can't exceed the number of brokers. **Invalid partitions**: at least 1; a topic's partitions can only grow.
- **… authorization failed**: the user's ACLs don't allow it (Topic: Write / Create / Delete, Group: Read, Cluster: Create). Ask the cluster's admin.
- **Policy violation**: the brokers' create-topic policy rejected the settings, or topic deletion is disabled (\`delete.topic.enable=false\`).
- **must be Empty** (reset offsets): stop the group's consumers first — offsets of a group with active members can't be moved.
- **Message size too large**: the message exceeds the topic's \`max.message.bytes\` / the broker's limit.`,
    keywords: "kafka topic already exists unknown topic replication factor partitions authorization acl policy violation reset offsets empty group message too large",
    related: ["kafka", "trouble-kafka-command"],
  },
  // ------------------------------------------------------------------ v0.16
  {
    id: "query-parameters",
    topic: "console",
    title: "Query parameters",
    lead: "Write :name, ? or $1 in a statement and DataTrip asks for the values when you run it.",
    body: `- \`:name\` works everywhere; \`?\` in MySQL, SQLite and SQL Server; \`$1\`, \`$2\`… in PostgreSQL. Casts (\`::int\`), strings, comments and $$ bodies are left alone. Parameters are highlighted in the editor.
- {key:runStatement} opens **Run with parameters** under the statement: one row per parameter with the column it is compared to (from the cached schema), text / number / date, the value and a **NULL** toggle. Invalid numbers and dates are flagged.
- **Remember values for this console** keeps them for the next run (and across restarts with restore on launch).
- The values used appear as chips above the result; **Edit parameters** runs it again.

> Values are written into the statement as properly quoted literals for the data source's dialect (numbers checked, text escaped, dates quoted), so paging, Count rows and cross-source queries keep working.

> \`col = NULL\` never matches a row — use \`col IS NULL\` to find missing values.

\`\`\`sql
SELECT id, status, total FROM orders
WHERE customer_id = :customer_id AND created_at >= :from_date;
\`\`\``,
    keywords: "bind variables placeholders prepared statement question mark dollar named parameter",
    related: ["consoles", "explain-plan"],
  },
  {
    id: "explain-plan",
    topic: "console",
    title: "Explain plan",
    lead: "See how the database runs a statement: the plan tree with estimated vs actual rows, time per step and an index hint.",
    body: `1. Put the caret in a statement and press {key:explain} (or **Explain** in the console toolbar, Console › Explain plan, ⌘K).
2. The plan replaces the results: each node with its relation / index, rows estimated → actual (×N flags a misestimate), self time or share of cost, and cost. The slowest node is marked; click a node for its details.
3. **ANALYZE** executes the statement for real timings (PostgreSQL, MySQL 8.0.18+, SQL Server); **BUFFERS** adds I/O (PostgreSQL). A write is only analyzed after you confirm, inside BEGIN … ROLLBACK (SQL Server: BEGIN TRANSACTION … ROLLBACK TRANSACTION; in a manual transaction a savepoint).
4. **Raw** shows the text plan; **Copy plan** copies it. A full scan with a filter on a column gets a hint and **Copy CREATE INDEX**.

> PostgreSQL uses EXPLAIN (FORMAT JSON), MySQL EXPLAIN FORMAT=JSON / EXPLAIN ANALYZE, SQLite EXPLAIN QUERY PLAN and SQL Server SHOWPLAN_XML (estimated plan) or, with ANALYZE, SET STATISTICS XML (actual plan).

> SQL Server actual plans: rows are summed over all threads (a parallel operator counts as one execution), the time of an operator is its slowest thread's elapsed time (SQL Server 2016 SP1 and later report it; older servers show actual rows and the cost share instead), and the details list executions, threads, rows read, CPU and logical reads. A missing index suggested by SQL Server wins over DataTrip's own hint.`,
    keywords: "explain analyze query plan slow performance index seq scan cost buffers showplan statistics xml actual execution plan",
    tryIt: { label: "Explain the statement at the cursor", command: "explain" },
    related: ["consoles", "query-parameters"],
  },
  {
    id: "sessions-locks",
    topic: "console",
    title: "Sessions & locks",
    lead: "Right-click a data source → Sessions & locks: every server session, what it runs, how long, and who blocks whom.",
    body: `- Columns: pid, user, application, state, duration, what it waits on and the query. Filter **Active only**, **Hide idle** or search; **Auto-refresh** every 2, 5 or 10 s.
- Lock-wait chains are traced: the banner names the session at the head of the chain (**Select blocker**), blocked sessions are tinted.
- Select a row for the full query, **Copy query**, **Cancel query** or **Kill session**. The confirmation shows the exact command (PostgreSQL \`pg_cancel_backend\` / \`pg_terminate_backend\`, MySQL \`KILL QUERY\` / \`KILL\`, SQL Server \`KILL\`).
- The tab queries through its own session, which can't be cancelled or killed. SQLite has no server sessions.
- The tab comes back at the next start with its filters and refresh interval (it connects when you show it).

> Listing other users' sessions and killing them needs privileges (PostgreSQL pg_signal_backend / superuser, MySQL PROCESS / CONNECTION_ADMIN, SQL Server VIEW SERVER STATE / ALTER ANY CONNECTION).`,
    keywords: "processlist pg_stat_activity blocking locks deadlock kill cancel terminate running queries activity monitor",
    tryIt: { label: "Open Sessions & locks", command: "sessions" },
    related: ["production-safety"],
  },
  {
    id: "snippets",
    topic: "console",
    title: "Snippets",
    lead: "Type an abbreviation like sel and press Tab: it expands into SQL with placeholders to fill in.",
    body: `- Built-ins: \`sel\`, \`selw\`, \`cnt\`, \`ins\`, \`upd\`, \`del\`, \`j\`, \`lj\`, \`gb\`, \`ob\`, \`lim\` / \`top\`, \`locks\` (PostgreSQL)…
- Tab expands when the completion list isn't open; snippets also appear in completion (marked {}), where Tab or ↵ expands the selected one.
- Placeholders: \`$CURSOR\` (where the caret lands), \`$TABLE\` / \`$COLUMN\` (fields completed with table / column names; Tab jumps to the next, Esc leaves), \`$SELECTION\` (text you selected before typing the abbreviation), \`$DATE\` (today).
- Settings › Snippets lists them: edit a built-in (Reset to built-in undoes it), add your own, pick the dialects, the expand key (Tab / Enter / Space) and whether they show in completion.`,
    keywords: "live templates abbreviations expand tab templates placeholders",
    tryIt: { label: "Open Settings › Snippets", command: "snippets" },
    related: ["consoles"],
  },
  {
    id: "production-safety",
    topic: "connect",
    title: "Production data sources",
    lead: "Mark a data source as Production in its connection dialog: a colored bar in its consoles and confirmations before writes.",
    body: `- Connection dialog › **Production data source**: pick a color. The explorer shows a PROD tag, ⌘K results too, and its consoles a thin **PRODUCTION · name** bar.
- **Confirm before writes** (on by default): INSERT, UPDATE, DELETE, MERGE and DDL first show the statement kind, table, WHERE filter and estimated rows (PostgreSQL / MySQL planner estimate). UPDATE / DELETE without WHERE get a warning.
- **Type the data source name for DROP / TRUNCATE** (on by default): an extra step for statements that remove whole tables or all rows.
- Plain SELECTs run as usual. On production sources this confirmation replaces "Confirm risky statements" (you're never asked twice).
- **Grid edits**: **Submit** (or {bind:Mod-S} in the grid) first shows the pending changes — how many updates, inserts and deletes, the table, and the exact statements (values written in; the first 8, then "+N more"). **Cancel** keeps the changes pending.
- **Redis**: write commands in a console (SET, DEL, UNLINK, EXPIRE, HSET, LPUSH, INCR, CONFIG SET…) and the explorer / key tab actions (Set TTL, Delete key) show the command first; reads (GET, HGETALL, SCAN…) run as usual. FLUSHDB, FLUSHALL, SWAPDB, SHUTDOWN and deleting all keys under a folder also ask for the data source name.
- **Kafka**: Produce message, Create topic, Reset offsets and the console's \`produce\` / \`create topic\` ask first; **Delete topic** asks for the data source name (or the topic name when "Type the data source name" is off).
- Not covered: Run SQL file and Import data keep their own production warning.
- AI is blocked for production data sources while "Block AI for production data sources" is on (names containing "prod" and read-only sources still count when nothing is marked).`,
    keywords: "production prod safety confirm writes drop truncate guard color bar dangerous grid edits submit redis flushdb flushall kafka produce delete topic reset offsets",
    related: ["connect", "sessions-locks", "ai-assistant"],
  },

  // ------------------------------------------------------------------ v0.16: value viewer, DDL, import, designer
  {
    id: "value-viewer",
    topic: "results",
    title: "View and edit long values (JSON, text, binary)",
    lead: "Long, multi-line, JSON and binary cells open in a value viewer docked right of the result grid. It follows the selected cell.",
    body: `- Open it with a **double-click** on a long / JSON / binary cell (short values still edit inline), **{bind:Shift-Enter}** with the grid focused, or right-click › **Open value**.
- **Text**, **JSON** (formatted and colored; ▾ / ▸ fold a node, **Fold all** / **Unfold all**) and **Hex** (the default for bytea / BLOB / varbinary). **Wrap** wraps long lines; the size and line count are shown on the right.
- **Copy** copies the whole value. Very large values show their first 2 MB.

## Editing
On an editable result, **✎ Edit** opens the value in an editor. JSON is checked as you type (the error shows its line and column). **Save to grid** ({bind:Mod-Enter}) puts it in the grid as a pending change — **Submit** writes it like any other cell edit, **Revert** drops it.

> Numbers in JSON are kept exactly as written, so big ids don't lose digits. Binary values (shown as 0x…, the first 4 KB) can't be edited here.`,
    keywords: "json viewer cell value long text blob bytea hex binary fold format pretty edit large",
    related: ["results"],
  },
  {
    id: "show-ddl",
    topic: "results",
    title: "Show DDL",
    lead: "Right-click a table, view, materialized view, routine, sequence or index in the explorer › Show DDL ({key:showDdl}) to see its CREATE statement.",
    body: `A read-only tab "name — DDL" shows the statement read from the database catalog, highlighted:
- Tables: columns with types, defaults, NOT NULL and identity, constraints (primary / unique / check / foreign keys), and — toggle **Indexes** — their indexes, plus **Comments**.
- Views and routines show their source; sequences their settings.
- **Schema-qualified** writes \`schema.table\` names.
- **Copy**, or **Open in console** to edit and run a changed version (nothing runs until you do).

{key:showDdl} works on the object selected in the explorer, or on the table of the active console. DDL tabs come back at the next start; the DDL is read again when you open the tab.

> PostgreSQL and SQL Server DDL is assembled from the system catalog; MySQL uses SHOW CREATE …; SQLite shows the statement stored in sqlite_master.`,
    keywords: "ddl create statement definition source script schema export structure show create",
    related: ["table-designer"],
  },
  {
    id: "import-data",
    topic: "results",
    title: "Import data from CSV or JSON",
    lead: "Right-click a table (or a schema) › Import data… — a 5-step wizard streams a CSV, TSV, JSON array or NDJSON file into a table.",
    body: `1. **File**: choose the file (any size: it is read in chunks, never whole).
2. **Format**: the delimiter, quote, header row and encoding are detected — change anything and the preview of the first 50 rows updates. Empty fields are NULL; **Treat as NULL** adds a text such as \`n/a\`. **Date format** (e.g. \`dd/MM/yyyy\`) reads dates that aren't YYYY-MM-DD; they are stored as ISO.
3. **Target**: map each file column to a column of an existing table (matched by name; each column is checked against its type, with one-click fixes such as "Use dd/MM/yyyy"), or **create a new table** with inferred, editable types.
4. **Options**: empty the table first, what to do when the key already exists (fail the row, skip, or update), batch size, and **Commit each batch** or **One transaction** (all or nothing). The SQL that will run is shown.
5. **Import**: progress, inserted / skipped / failed counts and the failed rows with their reason. **Stop** stops (an open transaction is rolled back). Save the failed rows as CSV to fix and import them again.

Rows are written with bound parameters in multi-row INSERTs, kept under each server's parameter limit. A dedicated session is used, so your consoles' transactions aren't touched.

> On MySQL "Skip" uses INSERT IGNORE, which also turns some other row errors into warnings. On SQL Server, Skip / Update need the primary key mapped.`,
    keywords: "import csv tsv json ndjson load upload file bulk insert wizard upsert truncate encoding delimiter",
    tryIt: { label: "Import data…", command: "importData" },
    related: ["table-designer", "run-sql-file"],
  },
  {
    id: "table-designer",
    topic: "results",
    title: "Design a table",
    lead: "Right-click a schema › New table…, or a table › Edit table…: columns, indexes and foreign keys in a grid, with the exact SQL shown as you go.",
    body: `- **Columns**: name, type (▾ lists the engine's types; any type can be typed), Not null, Default (an SQL expression: \`'text'\`, \`0\`, \`now()\`), PK and comment. ▲▼ reorder, ✕ drops, ↺ restores. Rows are marked new, changed or dropped.
- **Indexes** and **Foreign keys** tabs add or drop indexes / constraints.
- The **SQL preview** shows exactly what runs: CREATE TABLE for a new table, ALTER TABLE … for an existing one, in the engine's syntax. SQLite can't change a column's type, NOT NULL, default, key or order in place: DataTrip rebuilds the table (copy → drop → rename).
- **Apply…** asks first, then runs the statements in one transaction (PostgreSQL, SQL Server, SQLite: if one fails, nothing changes). MySQL commits each DDL statement on its own: they run in order and stop at the first error. The explorer refreshes and the design reloads.`,
    keywords: "table designer create alter add column drop rename type index foreign key primary key schema ddl",
    tryIt: { label: "New table…", command: "newTable" },
    related: ["show-ddl", "import-data"],
  },
];

const SQL_DRIVERS = ["postgres", "mysql", "sqlite", "mssql"] as const;

/**
 * Error text → troubleshooting article (first match wins). `vault`: only for data sources using Vault; `drivers`:
 * only for those drivers (Redis / Kafka command errors never lead to SQL articles and vice versa).
 */
export const ERROR_HELP: { re: RegExp; id: string; vaultOnly?: boolean; drivers?: readonly string[] }[] = [
  // v0.17: Redis / Kafka command errors
  { re: /WRONGTYPE|wrong number of arguments|unknown (sub)?command|syntax error|Unbalanced (single )?quotes|closing quote must be followed|is not an integer|out of range|not a valid float|Command name must be valid UTF-8|Transactions \(MULTI|Streaming commands|SELECT is not supported|^Empty command|connection is read-only/i, id: "trouble-redis-command", drivers: ["redis"] },
  { re: /READONLY|\bMOVED \d|\bASK \d|CROSSSLOT|CLUSTERDOWN|TRYAGAIN|\bOOM\b|maxmemory|\bLOADING\b|\bBUSY\b|MASTERDOWN|MISCONF|NOREPLICAS|NOPERM|NOSCRIPT|EXECABORT/, id: "trouble-redis-server", drivers: ["redis"] },
  { re: /Unknown command "|^Usage: |Expected name=value|Unknown (produce|create topic) argument|Unknown consume option|must be a number, got|needs a value|Unbalanced quotes in command|produce needs at least|Cannot parse timestamp|Unknown start position|^Empty command|connection is read-only/i, id: "trouble-kafka-command", drivers: ["kafka"] },
  { re: /already exists|Unknown ?topic ?or ?part|Topic "[^"]*" (not found|has no partition|is not available)|Invalid ?replication ?factor|Invalid ?partitions|Policy ?violation|authorization ?failed|must be Empty|Non ?empty ?group|Message ?size ?too ?large|Record ?too ?large|Consumer group "[^"]*" not found|has partitions 0/i, id: "trouble-kafka-admin", drivers: ["kafka"] },
  { re: /Kubernetes-internal|host name not found/i, id: "trouble-kafka-host" },
  { re: /advertise|No messages arrived within|partition leaders/i, id: "trouble-kafka-no-messages" },
  { re: /BrokerTransportFailure|bootstrap servers can be reached|Kafka handshake failed|Could not connect to Kafka/i, id: "trouble-kafka-transport" },
  { re: /SSH_HOST_|host key (has )?changed|host key is not trusted|not trusted yet/i, id: "trouble-ssh-hostkey" },
  { re: /\bvault\b[^]*?(permission denied|invalid token|expired|403|missing client token)|token (has )?expired/i, id: "trouble-vault-expired" },
  { re: /permission denied|password authentication failed|role .* does not exist|access denied|login failed/i, id: "trouble-vault-denied", vaultOnly: true },
  { re: /LIBFFI|libffi|GLIBC_|version `[^']*' not found/i, id: "trouble-appimage-ai" },
  { re: /Updates aren't set up/i, id: "trouble-updates" },
  { re: /matches more than one data source/i, id: "trouble-cross-ambiguous", drivers: SQL_DRIVERS },
  { re: /No data source named|is neither a database nor a schema|is not a database on/i, id: "cross-source", drivers: SQL_DRIVERS },
  { re: /connection (was )?(closed|reset|lost|aborted)|broken pipe|server closed the connection|lost connection|server has gone away|unexpected eof|terminating connection/i, id: "trouble-connection-lost" },
  { re: /connection refused|timed out|could not translate host|name or service not known|failed to lookup address|no route to host|nodename nor servname|No such host/i, id: "trouble-cant-connect" },
  { re: /password authentication failed|Access denied for user|Login failed for user|authentication failed|WRONGPASS|NOAUTH/i, id: "trouble-auth" },
];

/** The troubleshooting article for an error (pure; `driver` = the data source's driver when known). */
export function errorArticleFor(msg: string, ctx: { vault?: boolean; driver?: string } = {}): string | null {
  for (const m of ERROR_HELP) {
    if (m.vaultOnly && !ctx.vault) continue;
    if (m.drivers && !(ctx.driver && m.drivers.includes(ctx.driver))) continue;
    if (m.re.test(msg)) return m.id;
  }
  return null;
}

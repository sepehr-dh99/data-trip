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

> Lost the connection (VPN dropped, server restarted)? Read-only statements reconnect and run again by themselves; others show a Reconnect button. See [Connection lost](#trouble-connection-lost).`,
    keywords: "run execute statement cursor gutter cancel transaction commit rollback auto-commit manual history format paging load more count",
    tryIt: { label: "Try it in a new console", sql: "-- Put the cursor on a statement and press Run\nSELECT 1 AS one;\n\nSELECT 2 AS two;\n" },
    related: ["results", "sql-files", "shortcuts"],
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
];

/** Error text → troubleshooting article (first match wins). `vault`: the data source uses Vault. */
export const ERROR_HELP: { re: RegExp; id: string; vaultOnly?: boolean }[] = [
  { re: /Kubernetes-internal|host name not found/i, id: "trouble-kafka-host" },
  { re: /advertise|No messages arrived within|partition leaders/i, id: "trouble-kafka-no-messages" },
  { re: /BrokerTransportFailure|bootstrap servers can be reached|Kafka handshake failed|Could not connect to Kafka/i, id: "trouble-kafka-transport" },
  { re: /SSH_HOST_|host key (has )?changed|host key is not trusted|not trusted yet/i, id: "trouble-ssh-hostkey" },
  { re: /\bvault\b[^]*?(permission denied|invalid token|expired|403|missing client token)|token (has )?expired/i, id: "trouble-vault-expired" },
  { re: /permission denied|password authentication failed|role .* does not exist|access denied|login failed/i, id: "trouble-vault-denied", vaultOnly: true },
  { re: /LIBFFI|libffi|GLIBC_|version `[^']*' not found/i, id: "trouble-appimage-ai" },
  { re: /Updates aren't set up/i, id: "trouble-updates" },
  { re: /matches more than one data source/i, id: "trouble-cross-ambiguous" },
  { re: /No data source named|is neither a database nor a schema|is not a database on/i, id: "cross-source" },
  { re: /connection (was )?(closed|reset|lost|aborted)|broken pipe|server closed the connection|lost connection|server has gone away|unexpected eof|terminating connection/i, id: "trouble-connection-lost" },
  { re: /connection refused|timed out|could not translate host|name or service not known|failed to lookup address|no route to host|nodename nor servname|No such host/i, id: "trouble-cant-connect" },
  { re: /password authentication failed|Access denied for user|Login failed for user|authentication failed|WRONGPASS|NOAUTH/i, id: "trouble-auth" },
];

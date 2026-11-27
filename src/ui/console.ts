// A console tab: SQL editor on top, results below (grid / message / error).
// Its run controls (Run / Cancel, Run all, transaction pill) are mounted by the shell into the
// floating capsule while this console is active.
import { api } from "../api";
import type { Driver, FedResult, FedSource, FedStep, QueryResult, RowEdit, SchemaNode, SessionInfo } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { DRIVER_LABELS } from "../types";
import { confirmDialog } from "./confirm";
import { showMenu } from "./menu";
import { SqlEditor } from "./editor";
import { kafkaNames, loadOverview } from "./kafka";
import { ResultGrid } from "./grid";
import type { PagingState } from "./grid";
import { store } from "./state";
import { buildCompletionSchema, buildFilteredSql, connColor, countSql, detectEditContext, nextOrder, orderMarks, pagedSql, pagingFirstPageOnly, parseFilterable, qualifiedName, quoteIdent } from "./sqlutil";
import { getSettings } from "./settings";
import { handleActionError } from "./recovery";
import { FED_DRIVERS, aliasSlug, droppedTable, hasTableDrag, isAlias, refPart, tableDrag, uniqueAlias } from "./federation";
import type { TableDrag } from "./federation";
import { exampleQuery } from "./crossSource";
import type { ExampleSource } from "./crossSource";
import type { FedCompletion, FedHooks, FedMark } from "./editor";
import { shortcutLabel } from "./keymap";
import { canFormat, formatSql as formatSqlText } from "./sqlFormat";
import type { WsConsole } from "./workspace";
import { openExportDialog } from "./exportDialog";
import { FilterBar } from "./filterBar";
import type { FilterState } from "./filterBar";
import { toast } from "./toast";
import type { TabPane } from "./tabs";
import { sentinelLabel } from "./redis";
import { AiAssist } from "./aiPanel";
import { docWithoutPending } from "./aiEditor";

const DEFAULT_MAX_ROWS = 500;
const MOD = /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

export interface StatusInfo {
  rows: number | null;
  elapsedMs: number | null;
  affected: number | null;
  serverVersion: string;
  autoCommit: boolean;
  running: boolean;
  text: string;
}

export interface ConsoleHost {
  onExecuted(connId: string): void;
  onStatus(c: ConsolePane): void;
  onSchemaChanged(connId: string): void;
  /** The console was bound to another database / data source / schema. */
  onDatabase(c: ConsolePane): void;
  /** Connects the data source if needed; resolves true when it is connected. */
  ensureConnected(connId: string): Promise<boolean>;
  /** Text, cursor, bindings or attached sources changed (restore on launch saves the workspace). */
  onWorkspace(): void;
  /** Reconnects the data source like the explorer does (toasts the outcome). */
  reconnect(connId: string): Promise<void>;
}

interface ResultItem {
  tab: HTMLElement;
  view: HTMLElement;
  sql: string;
  maxRows: number;
  grid?: ResultGrid;
  last?: QueryResult;
  /** Set while the result is a simple single-table SELECT (filter bar + server-side sort). */
  filter?: FilterState;
  /** Server-side paging of a single SELECT (null / undefined = not paged). */
  paging?: PagingState | null;
  /** Cross-source result (read-only, not re-runnable through the session). */
  fed?: boolean;
}

/** An extra data source attached to a console for cross-source queries. */
interface FedAttach {
  alias: string;
  connId: string;
  database: string | null;
}

/** Server-type drivers: an attached source can pick which database it reads from. */
const SERVER_DRIVERS: ReadonlySet<Driver> = new Set<Driver>(["postgres", "mysql", "mssql"]);

const MSSQL_PAGE_REASON = "SQL Server can't page a query that has ORDER BY without TOP — only the first page is shown";

/** Strips leading comments so the statement's first keyword can be checked. */
function headOf(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
}

/** Why a statement is risky (UPDATE / DELETE without WHERE, DROP, TRUNCATE), or null. */
function riskOf(sql: string): string | null {
  const t = headOf(sql)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const kw = /^([A-Za-z]+)/.exec(t)?.[1]?.toLowerCase();
  if (kw === "drop") return "DROP";
  if (kw === "truncate") return "TRUNCATE";
  if ((kw === "delete" || kw === "update") && !/\bwhere\b/i.test(t)) return `${kw.toUpperCase()} without WHERE`;
  return null;
}

/** Text with string literals, quoted identifiers and comments blanked out (keyword checks). */
function codeOnly(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, "``")
    .replace(/\[[^\]]*\]/g, "[]")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * A statement that only reads, so re-running it after a reconnect is harmless: SELECT / WITH / SHOW / EXPLAIN /
 * DESCRIBE without any data-changing keyword anywhere (WITH … DELETE, EXPLAIN ANALYZE UPDATE, SELECT … INTO,
 * SELECT … FOR UPDATE are all refused).
 */
export function isReadOnlyStatement(sql: string): boolean {
  const t = codeOnly(headOf(sql)).trim();
  const kw = /^([A-Za-z]+)/.exec(t)?.[1]?.toLowerCase();
  if (!kw || !["select", "with", "show", "explain", "describe", "desc"].includes(kw)) return false;
  return !/\b(insert|update|delete|merge|upsert|replace|into|drop|truncate|alter|create|grant|revoke|call|exec|execute|lock|set|copy|vacuum|analyze|do)\b/i.test(t.slice(kw.length));
}

/** Conservative check for "the connection is gone" errors (worth a reconnect), not SQL errors. */
export function isConnectionLost(message: string): boolean {
  const m = message.toLowerCase();
  // Vault / SSH recovery errors have their own flows.
  if (/^[a-z_]+:/.test(m) && /^(vault_|ssh_|oidc_)/.test(m)) return false;
  return (
    /\bconnection (?:was )?(?:closed|reset|lost|aborted)\b/.test(m) ||
    /\bconnection is closed\b/.test(m) ||
    m.includes("broken pipe") ||
    m.includes("connection reset") ||
    m.includes("terminating connection") ||
    m.includes("server closed the connection") ||
    m.includes("lost connection") ||
    m.includes("server has gone away") ||
    m.includes("unexpected eof") ||
    /\beof\b.*\b(?:connection|socket|stream|reading|read)\b|\b(?:connection|socket|stream|reading|read)\b.*\beof\b/.test(m) ||
    /^\s*(?:io error: )?eof\s*$/.test(m) ||
    /\bnot connected\b/.test(m) ||
    m.includes("pool timed out") ||
    /\b(?:connection|socket|read|write|i\/o|io)\b.*\btimed out\b/.test(m)
  );
}

/** The error's raw message (before humanMsg strips recovery prefixes). */
function rawMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let counter = 0;

export class ConsolePane implements TabPane {
  readonly kind = "console" as const;
  readonly el: HTMLElement;
  /** Run controls shown in the shell's floating capsule while this console is active. */
  readonly controls: HTMLElement;
  readonly id = "console-" + ++counter;
  title: string;
  status: StatusInfo;
  private editor: SqlEditor;
  private session: SessionInfo | null = null;
  private sessionPromise: Promise<SessionInfo> | null = null;
  private running = false;
  private autoCommit = true;
  private items: ResultItem[] = [];
  private activeItem = -1;
  private tabsEl: HTMLElement;
  private bodyEl: HTMLElement;
  private editorWrap: HTMLElement;
  private bar: FilterBar;
  private btnRun: HTMLButtonElement;
  private btnRunAll: HTMLButtonElement;
  private btnStop: HTMLButtonElement;
  private btnTx: HTMLButtonElement;
  /** True once the user picked the schema in the navigator (PostgreSQL then also gets a search_path). */
  private schemaExplicit = false;
  private waitEl: HTMLElement;
  private waitText: HTMLElement;
  private txMenuClosedAt = 0;
  private alive = true;
  private btnFed: HTMLButtonElement;
  /** ✦ Ask AI (board N) and the console's AI assistant. */
  private btnAi: HTMLButtonElement;
  private ai: AiAssist;
  // cross-source queries
  private fedEl: HTMLElement;
  private fed: FedAttach[] = [];
  private fedShown = false;
  private ownAlias = "";
  private ownAliasEdited = false;
  /** Cross-source: database of the console's own source; null = the console's database. */
  private fedOwnDb: string | null = null;
  /** Restored on launch and not connected yet: the data source connects on first activation / run. */
  private needsConnect = false;
  private waking: Promise<boolean> | null = null;
  /** Effective database when the workspace was saved (tab names until the data source is connected). */
  private dbHint: string | null = null;
  /** Opened as a cross-source console ("cross-source" tab with an "N sources" badge). */
  private crossSource = false;
  /** Cross-source guide card (3 steps + "Insert an example query") over the editor; hides once the user types. */
  private guideEl: HTMLElement | null = null;
  /** "Drop to attach …" hint while a table is dragged over the editor. */
  private dropEl: HTMLElement = h("div", { class: "fed-drop", hidden: true, "aria-hidden": "true" });

  constructor(
    public connId: string,
    title: string,
    private host: ConsoleHost,
    initialSql = "",
    /** Database this console is bound to; null = the connection's default. */
    public database: string | null = null,
    /** Schema that completion defaults to (set when opened from a schema node). */
    public schema: string | null = null,
    /** Table / view the console was opened on (tab names), null for a plain console. */
    public table: string | null = null,
  ) {
    this.title = title;
    const entry = store.conns.get(connId);
    const driver = entry?.config.driver ?? "postgres";
    this.status = { rows: null, elapsedMs: null, affected: null, serverVersion: entry?.session?.serverVersion ?? "", autoCommit: true, running: false, text: "Ready" };

    const isMac = /Mac/.test(navigator.userAgent);
    const mod = isMac ? "⌘" : "Ctrl+";
    this.btnRun = h("button", { class: "cap-btn run", type: "button", title: `Run selection or statement at cursor (${mod}Enter)`, onclick: () => void this.runCurrent() }, icon("run", 10), "Run");
    this.btnStop = h("button", { class: "cap-btn stop", type: "button", title: "Cancel running statement", onclick: () => void this.cancel() }, icon("stop", 13), "Cancel");
    this.btnStop.disabled = true;
    this.btnRunAll = h("button", { class: "cap-btn ghost icon-only", type: "button", title: `Run all statements (${mod}Shift+Enter)`, "aria-label": "Run all statements", onclick: () => void this.runAll() }, icon("playAll", 15));
    this.btnTx = h("button", { class: "cap-btn fill tx", type: "button", title: "Transaction mode", "aria-haspopup": "menu", onclick: () => this.openTxMenu() });
    this.btnFed = h(
      "button",
      { class: "cap-btn ghost icon-only fed-btn", type: "button", title: "Sources: query several data sources in this console", "aria-label": "Attach data sources", "aria-pressed": "false", onclick: () => this.onFedButton() },
      icon("layers", 15),
    );
    this.btnAi = h(
      "button",
      { class: "cap-btn ai-ask", type: "button", title: `Ask AI to write SQL (${shortcutLabel("askAi") || "Ask AI"})`, onclick: () => this.askAi() },
      h("span", { class: "ai-spark", "aria-hidden": "true" }, "✦"),
      "Ask AI",
      h("span", { class: "ai-kbd" }, shortcutLabel("askAi")),
    );
    this.controls = h("div", { class: "cap-controls" }, this.btnAi, this.btnRun, this.btnStop, this.btnRunAll, this.btnFed, this.btnTx);
    this.btnTx.hidden = driver === "redis" || driver === "kafka";
    this.syncTxLabel();
    this.waitText = h("span", null, "Running…");
    this.waitEl = h("div", { class: "r-wait", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), this.waitText);

    this.editorWrap = h("div", { class: "c-editor" });
    this.editor = new SqlEditor(this.editorWrap, {
      doc: initialSql,
      driver,
      kafkaNames: () => kafkaNames(this.connId),
      onRun: () => void this.runCurrent(),
      onRunAll: () => void this.runAll(),
      onCursor: () => this.host.onWorkspace(),
      onAskAi: () => this.askAi(),
    });
    this.ai = new AiAssist({
      wrap: this.editorWrap,
      view: () => this.editor.cmView,
      connId: () => this.connId,
      driver: () => this.driver,
      database: () => this.effectiveDatabase,
      defaultSchema: () => this.currentSchemaName(),
      serverVersion: () => this.status.serverVersion,
      schemas: () => this.schemas(),
      ensureSchemas: async () => {
        if (this.needsConnect) await this.wake();
        if (this.database !== null) await store.ensureDb(this.connId, this.database).catch(() => undefined);
      },
      isLineBased: () => this.isLineBased,
      sample: async (sql: string) => {
        const sess = await this.ensureSession();
        return api.execute(sess.sessionId, sql, 20);
      },
      statements: () => this.editor.getAllStatements(),
      focus: () => this.editor.focus(),
      isActive: () => this.alive && this.el.isConnected && this.controls.isConnected && !this.el.classList.contains("hidden"),
    });
    // Gutter ▶: run just that statement (Alt/Option-click: keep the current results, add a result tab).
    this.editor.onRunStatement((r, o) => {
      const list = this.editor.splitText(r.text);
      if (list.length) void this.runList(list, { append: o.newTab });
    });
    this.tabsEl = h("div", { class: "r-tabs", role: "tablist", "aria-label": "Results" });
    this.bodyEl = h("div", { class: "r-body" });
    const splitter = h("div", { class: "c-split", role: "separator", "aria-orientation": "horizontal", "aria-label": "Resize editor", title: "Drag to resize" });
    this.bindSplitter(splitter);
    this.bar = new FilterBar(driver, { onApply: (where, order) => this.applyBar(where, order) });
    const results = h("div", { class: "c-results" }, this.tabsEl, this.bar.el, this.bodyEl);
    this.fedEl = h("div", { class: "fed-strip", role: "group", "aria-label": "Sources", hidden: true });
    this.el = h("div", { class: "console" }, this.fedEl, this.editorWrap, splitter, results);
    this.editorWrap.appendChild(this.dropEl);
    // The guide card goes away as soon as the user types (or pastes / deletes) in the editor.
    this.editorWrap.addEventListener("beforeinput", () => this.hideGuide());
    this.bindTableDrop();
    this.editor.setFedHooks(this.fedHooks());
    this.ownAlias = aliasSlug(entry?.config.name ?? "main");
    this.syncFedUi();
    this.showEmptyResults();
    this.updateSchema();
    this.loadSchema();
    if (driver === "kafka") void loadOverview(connId);
  }

  // ---------------------------------------------------------------- public

  focus(): void {
    this.editor.focus();
  }

  insertSql(sql: string): void {
    this.editor.insertText(sql);
    this.editor.focus();
  }

  setSql(sql: string): void {
    this.editor.setText(sql);
  }

  /** Adds `sql` as its own statement (new line, `;`-separated) at the cursor, or at the end. */
  insertStatement(sql: string, atEnd = false): void {
    this.editor.insertStatement(sql, atEnd);
    this.editor.focus();
  }

  undo(): boolean {
    this.editor.focus();
    return this.editor.undo();
  }

  /** Cross-source consoles: "3 sources" next to the tab name. */
  get sourceBadge(): string | null {
    return this.crossSource && this.fedActive ? `${this.fed.length + 1} sources` : null;
  }

  /** Pending grid edits or an open manual transaction. */
  get dirty(): boolean {
    return (!this.autoCommit && this.session !== null) || this.items.some((i) => i.grid?.hasPending() === true);
  }

  /** The editor's whole text (reopen closed tab). */
  get sqlText(): string {
    return this.editor.getText();
  }

  // ---------------------------------------------------------------- restore on launch

  /** What restore on launch saves for this console. */
  snapshot(): WsConsole {
    return {
      sql: docWithoutPending(this.editor.cmView.state),
      cursor: this.editor.cursor,
      database: this.database,
      dbHint: this.effectiveDatabase,
      schema: this.schema,
      schemaExplicit: this.schemaExplicit,
      table: this.table,
      ownAlias: this.ownAliasEdited ? this.ownAlias : null,
      ownDb: this.fedOwnDb,
      sources: this.fed.map((f) => ({ alias: f.alias, connId: f.connId, database: f.database })),
      fedShown: this.fedShown,
      crossSource: this.crossSource,
    };
  }

  /**
   * Applies the rest of a saved console (the constructor already got text, database, schema and table). The data
   * source is not connected here: `wake()` does that on first activation or run. Sources whose data source no
   * longer exists are dropped.
   */
  restoreState(ws: WsConsole): void {
    this.needsConnect = store.conns.get(this.connId)?.status !== "connected";
    this.dbHint = ws.dbHint;
    this.schemaExplicit = ws.schemaExplicit && this.schema !== null;
    this.editor.setCursor(Math.min(ws.cursor, ws.sql.length));
    if (!this.isLineBased && FED_DRIVERS.has(this.driver)) {
      if (ws.ownAlias && isAlias(ws.ownAlias)) {
        this.ownAlias = ws.ownAlias;
        this.ownAliasEdited = true;
      }
      this.fedOwnDb = ws.ownDb;
      const taken = [this.ownAlias];
      this.fed = [];
      for (const src of ws.sources) {
        const e = store.conns.get(src.connId);
        if (!e || src.connId === this.connId || !FED_DRIVERS.has(e.config.driver) || this.fed.some((f) => f.connId === src.connId)) continue;
        const alias = isAlias(src.alias) ? uniqueAlias(src.alias, taken) : uniqueAlias(aliasSlug(e.config.name), taken);
        taken.push(alias);
        this.fed.push({ alias, connId: src.connId, database: SERVER_DRIVERS.has(e.config.driver) ? src.database : null });
      }
      this.fedShown = ws.fedShown || this.fed.length > 0;
      this.crossSource = ws.crossSource === true;
      this.syncFedUi();
    }
    this.updateSchema();
  }

  /**
   * A restored console connects its data source the first time it is activated or run (explorer connect, with
   * the usual recovery for expired Vault tokens / unknown SSH hosts), then loads completion. True when connected.
   */
  wake(): Promise<boolean> {
    if (!this.needsConnect) return Promise.resolve(true);
    if (this.waking) return this.waking;
    const connId = this.connId;
    this.waking = this.host
      .ensureConnected(connId)
      .catch(() => false)
      .then((ok) => {
        this.waking = null;
        if (!ok || !this.alive || connId !== this.connId) return ok;
        this.needsConnect = false;
        this.status.serverVersion = store.conns.get(connId)?.session?.serverVersion ?? "";
        this.updateSchema();
        this.loadSchema();
        if (this.isKafka) void loadOverview(connId);
        this.syncFedUi();
        this.host.onDatabase(this);
        return true;
      });
    return this.waking;
  }

  // ---------------------------------------------------------------- AI assistant

  /** ⌘I / ✦ Ask AI: the inline prompt box under the cursor line (SQL consoles only). */
  askAi(): void {
    this.ai.open();
  }

  // ---------------------------------------------------------------- format

  /** Format SQL: the selection, else the statement at the cursor (one undo step; the trailing `;` stays). */
  formatSql(): void {
    if (this.isLineBased || !canFormat(this.driver)) return;
    const t = this.editor.formatTarget();
    if (!t) {
      toast("Nothing to format at the cursor", "info");
      return;
    }
    let out: string;
    try {
      out = formatSqlText(t.text, this.driver).trim();
    } catch (e) {
      const msg = errMsg(e).split("\n")[0].trim();
      toast(`Couldn't format: ${msg.length > 140 ? msg.slice(0, 140) + "…" : msg}`, "error");
      return;
    }
    if (out && out !== t.text) this.editor.replaceRange(t.from, t.to, out);
    this.editor.focus();
  }

  /** Cancel shortcut. */
  cancelRun(): void {
    void this.cancel();
  }

  redo(): boolean {
    this.editor.focus();
    return this.editor.redo();
  }

  async runSqlText(sql: string): Promise<void> {
    // Redis / Kafka commands are line-based: a trailing ";" would be part of the last argument.
    await this.runList([this.isLineBased ? sql.trim() : sql.trim().replace(/;\s*$/, "")]);
  }

  /** True while this console is bound to a Redis data source. */
  get isRedis(): boolean {
    return store.conns.get(this.connId)?.config.driver === "redis";
  }

  /** True while this console is bound to a Kafka data source. */
  get isKafka(): boolean {
    return store.conns.get(this.connId)?.config.driver === "kafka";
  }

  /** Redis and Kafka consoles run one command per line. */
  get isLineBased(): boolean {
    return this.isRedis || this.isKafka;
  }

  /** Schemas of this console's (connection, database). */
  private schemas(): SchemaNode[] {
    return store.schemasFor(this.connId, this.database);
  }

  /** Effective database name: the bound one, else the connection's default. */
  get effectiveDatabase(): string | null {
    return this.database ?? store.conns.get(this.connId)?.defaultDb ?? this.dbHint;
  }

  updateSchema(): void {
    const e = store.conns.get(this.connId);
    if (!e) return;
    const def = this.schema ?? store.defaultSchemaFor(this.connId, this.database) ?? this.session?.defaultSchema ?? null;
    this.editor.setSchema(buildCompletionSchema(this.schemas(), def), e.config.driver);
  }

  /** Makes sure the database's introspection is loaded for completion. */
  private loadSchema(): void {
    if (this.database === null) return;
    void store.ensureDb(this.connId, this.database).then(() => this.alive && this.updateSchema());
  }

  /** Rebinds the console to another database: closes its session, the next run opens a new one. */
  async switchDatabase(name: string): Promise<void> {
    const e = store.conns.get(this.connId);
    const target = name === e?.defaultDb ? null : name;
    if (target === this.database) return;
    if (this.running) {
      toast("Wait for the running statement to finish first", "info");
      return;
    }
    if (this.session && !this.autoCommit) {
      const ok = await confirmDialog("Switch database?", "This console has a manual transaction open. Switching databases will roll it back.", "Switch", true);
      if (!ok) return;
    }
    const old = this.session;
    this.session = null;
    this.sessionPromise = null;
    if (old) {
      if (!this.autoCommit) await api.rollback(old.sessionId).catch(() => undefined);
      await api.closeSession(old.sessionId).catch(() => undefined);
    }
    this.autoCommit = true;
    this.database = target;
    this.dbHint = null;
    if (this.fedOwnDb !== null && this.fedOwnDb === (target ?? e?.defaultDb ?? null)) this.fedOwnDb = null;
    this.schema = null;
    this.table = null;
    this.schemaExplicit = false;
    this.syncTxUi();
    this.syncFedUi();
    this.updateSchema();
    this.loadSchema();
    this.host.onDatabase(this);
    toast(`Console now uses ${name}`, "info");
  }

  /** Drops the session (rolling back a manual transaction). Caller has confirmed. */
  private async releaseSession(): Promise<void> {
    const old = this.session;
    this.session = null;
    this.sessionPromise = null;
    if (old) {
      if (!this.autoCommit) await api.rollback(old.sessionId).catch(() => undefined);
      await api.closeSession(old.sessionId).catch(() => undefined);
    }
    this.autoCommit = true;
  }

  /** Rebinds the console to another data source (its default database). */
  async switchConnection(connId: string): Promise<void> {
    if (connId === this.connId) return;
    if (this.running) {
      toast("Wait for the running statement to finish first", "info");
      return;
    }
    if (this.session && !this.autoCommit) {
      const ok = await confirmDialog("Switch data source?", "This console has a manual transaction open. Switching data sources will roll it back.", "Switch", true);
      if (!ok) return;
    }
    if (!(await this.host.ensureConnected(connId))) return;
    await this.releaseSession();
    this.connId = connId;
    this.database = null;
    this.dbHint = null;
    this.fedOwnDb = null;
    this.needsConnect = false;
    this.schema = null;
    this.table = null;
    this.schemaExplicit = false;
    const e = store.conns.get(connId);
    this.fed = this.fed.filter((f) => f.connId !== connId);
    if (!this.ownAliasEdited) this.ownAlias = uniqueAlias(aliasSlug(e?.config.name ?? "main"), this.fed.map((f) => f.alias));
    if (this.isLineBased || !FED_DRIVERS.has(e?.config.driver ?? "postgres")) {
      this.fed = [];
      this.fedShown = false;
    }
    this.syncFedUi();
    this.status.serverVersion = e?.session?.serverVersion ?? "";
    this.syncTxUi();
    this.updateSchema();
    this.showEmptyIfNoResults();
    this.host.onDatabase(this);
    toast(`Console now uses ${e?.config.name ?? "the new data source"}`, "info");
  }

  /** Default schema as the navigator shows it. */
  currentSchemaName(): string | null {
    return this.schema ?? store.defaultSchemaFor(this.connId, this.database) ?? this.session?.defaultSchema ?? null;
  }

  /** Sets the schema used for completion and unqualified names (PostgreSQL: also the session search_path). */
  async setDefaultSchema(name: string): Promise<void> {
    this.schema = name;
    this.schemaExplicit = true;
    this.updateSchema();
    this.host.onDatabase(this);
    if (this.session && !this.running) await this.applySearchPath(this.session);
  }

  private async applySearchPath(s: SessionInfo): Promise<void> {
    const e = store.conns.get(this.connId);
    if (e?.config.driver !== "postgres" || !this.schemaExplicit || !this.schema) return;
    try {
      await api.execute(s.sessionId, `SET search_path TO ${quoteIdent("postgres", this.schema)}, public`, 1);
    } catch (err) {
      toast(`Could not set the schema: ${errMsg(err)}`, "error");
    }
  }

  dropSession(): void {
    // Called after the connection was closed from the explorer.
    const old = this.session;
    if (old) void api.closeSession(old.sessionId).catch(() => undefined);
    this.session = null;
    this.sessionPromise = null;
    this.autoCommit = true;
    this.syncTxUi();
  }

  async dispose(): Promise<void> {
    this.alive = false;
    this.bar.destroy();
    const s = this.session;
    this.session = null;
    this.ai.dispose();
    this.editor.destroy();
    if (s) {
      if (!this.autoCommit) await api.rollback(s.sessionId).catch(() => undefined);
      await api.closeSession(s.sessionId).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- session

  private ensureSession(): Promise<SessionInfo> {
    if (this.session) return Promise.resolve(this.session);
    if (!this.sessionPromise) {
      this.sessionPromise = api.openSession(this.connId, this.database).then(
        async (s) => {
          if (!this.alive) {
            // The tab was closed while the session was opening: don't leak it.
            void api.closeSession(s.sessionId).catch(() => undefined);
            throw new Error("Console was closed");
          }
          this.session = s;
          this.status.serverVersion = s.serverVersion;
          await this.applySearchPath(s);
          if (!this.autoCommit) await api.setAutoCommit(s.sessionId, false);
          this.updateSchema();
          return s;
        },
        (e) => {
          this.sessionPromise = null;
          throw e;
        },
      );
    }
    return this.sessionPromise;
  }

  private async setAuto(auto: boolean): Promise<void> {
    if (this.autoCommit === auto) return;
    try {
      if (this.session || !auto) {
        const s = await this.ensureSession();
        await api.setAutoCommit(s.sessionId, auto);
      }
      this.autoCommit = auto;
      this.syncTxUi();
      toast(auto ? "Auto-commit on" : "Manual transactions: remember to commit or roll back", "info");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  private async endTx(commit: boolean): Promise<void> {
    if (!this.session) return;
    try {
      if (commit) await api.commit(this.session.sessionId);
      else await api.rollback(this.session.sessionId);
      toast(commit ? "Transaction committed" : "Transaction rolled back", "ok");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  private syncTxUi(): void {
    this.syncTxLabel();
    this.status.autoCommit = this.autoCommit;
    this.host.onStatus(this);
  }

  private syncTxLabel(): void {
    this.btnTx.hidden = this.isLineBased;
    this.btnAi.hidden = this.isLineBased;
    clear(this.btnTx);
    this.btnTx.append(this.autoCommit ? "Auto" : "Manual", h("span", { class: "tx-caret", "aria-hidden": "true" }, "▾"));
    this.btnTx.classList.toggle("manual", !this.autoCommit);
    this.btnTx.setAttribute("aria-label", `Transaction mode: ${this.autoCommit ? "auto-commit" : "manual"}`);
  }

  /** Small glass menu under the transaction pill: mode + Commit / Rollback (manual mode only). */
  private openTxMenu(): void {
    // A click on the pill while its menu is open closes the menu (pointerdown) — don't reopen it.
    if (performance.now() - this.txMenuClosedAt < 250) return;
    const r = this.btnTx.getBoundingClientRect();
    const manualIdle = !this.autoCommit && !this.running;
    this.btnTx.classList.add("open");
    showMenu(
      r.left,
      r.bottom + 8,
      [
        { label: "Auto-commit", checked: this.autoCommit, onClick: () => void this.setAuto(true) },
        { label: "Manual", checked: !this.autoCommit, onClick: () => void this.setAuto(false) },
        { sep: true },
        { label: "Commit", icon: "commit", disabled: !manualIdle, onClick: () => void this.endTx(true) },
        { label: "Rollback", icon: "undo", disabled: !manualIdle, onClick: () => void this.endTx(false) },
      ],
      {
        minWidth: 180,
        onClose: () => {
          this.txMenuClosedAt = performance.now();
          this.btnTx.classList.remove("open");
        },
      },
    );
  }

  // ---------------------------------------------------------------- running

  async runCurrent(): Promise<void> {
    const r = this.editor.getSelectionOrStatementAtCursor();
    if (!r) {
      toast("Nothing to run at the cursor", "info");
      return;
    }
    // A selection may hold several statements (possibly cutting through others): split the
    // selected text itself, since the backend executes exactly one statement per call.
    const list = this.editor.splitText(r.text);
    if (list.length === 0) {
      toast("Nothing to run at the cursor", "info");
      return;
    }
    await this.runList(list);
  }

  async runAll(): Promise<void> {
    const all = this.editor.getAllStatements().map((s) => s.text);
    if (all.length === 0) {
      toast("Nothing to run", "info");
      return;
    }
    await this.runList(all);
  }

  private setRunning(on: boolean, text: string): void {
    this.running = on;
    this.status.running = on;
    this.status.text = text;
    this.btnRun.disabled = this.btnRunAll.disabled = on;
    this.btnStop.disabled = !on;
    this.waitText.textContent = text;
    this.el.classList.toggle("running", on);
    this.controls.classList.toggle("running", on);
    this.host.onStatus(this);
  }

  /** Asks before UPDATE / DELETE without WHERE, DROP and TRUNCATE (Settings › Data › Confirm risky statements). */
  private async confirmRisky(stmts: string[]): Promise<boolean> {
    if (this.isLineBased || !getSettings().data.confirmRisky) return true;
    const risky = stmts.map((s) => ({ s, why: riskOf(s) })).filter((x) => x.why !== null);
    if (risky.length === 0) return true;
    const first = risky[0];
    const one = first.s.trim().replace(/\s+/g, " ");
    const name = store.conns.get(this.connId)?.config.name ?? "this data source";
    const text =
      risky.length === 1
        ? `This runs ${first.why} on ${name}:\n${one.length > 160 ? one.slice(0, 160) + "…" : one}`
        : `${risky.length} statements are risky on ${name} (${[...new Set(risky.map((r) => r.why))].join(", ")}).`;
    return confirmDialog("Run risky statement?", text, "Run anyway", true);
  }

  /**
   * Runs the statements one by one. `append`: keep the current results and add the new ones as extra result tabs
   * (gutter ▶ with Alt/Option). With attached sources the statements run as cross-source queries.
   */
  private async runList(stmts: string[], opts: { append?: boolean } = {}): Promise<void> {
    if (this.running || stmts.length === 0) return;
    if (!(await this.confirmRisky(stmts))) return;
    if (this.running) return;
    const fed = this.fedActive;
    const base = opts.append ? this.items.length : 0;
    const total = base + stmts.length;
    this.setRunning(true, fed ? "Running across sources…" : "Connecting…");
    if (opts.append && this.items.length > 0) this.waitEl.remove();
    else this.clearResults();
    this.items.forEach((it) => it.view.classList.add("hidden"));
    this.bodyEl.appendChild(this.waitEl);
    let schemaTouched = false;
    let autoCount: ResultItem | null = null;
    try {
      if (fed) {
        const sources = this.fedSources();
        for (let i = 0; i < stmts.length; i++) {
          const sql = stmts[i];
          this.setRunning(true, stmts.length > 1 ? `Running ${i + 1} of ${stmts.length} across sources…` : "Running across sources…");
          try {
            const fr = await api.federatedExecute(sources, sql, DEFAULT_MAX_ROWS);
            if (!this.alive) return;
            this.addFedResult(sql, fr, base + i + 1, total);
          } catch (e) {
            if (!this.alive) return;
            this.addError(sql, errMsg(e), base + i + 1, total);
            if (!handleActionError(e)) toast(errMsg(e), "error");
            break;
          }
        }
        return;
      }
      // A console restored on launch connects its data source on first use.
      if (this.needsConnect) await this.wake();
      const sess = await this.ensureSession();
      for (let i = 0; i < stmts.length; i++) {
        const sql = stmts[i];
        this.setRunning(true, stmts.length > 1 ? `Running ${i + 1} of ${stmts.length}…` : "Running…");
        /** Runs the statement; returns its result when it should get an automatic row count. */
        const runOne = async (): Promise<ResultItem | null> => {
          const size = stmts.length === 1 ? this.pageSizeFor(sql) : 0;
          if (size > 0) {
            // A single SELECT: run its first page (n + 1 rows tell whether more exist).
            const pg = await this.fetchPage(sess.sessionId, sql, 0, size);
            const firstOnly = pagingFirstPageOnly(this.driver, sql);
            const paging: PagingState = { offset: 0, pageSize: size, hasMore: pg.hasMore, total: null, enabled: !firstOnly, disabledReason: firstOnly ? MSSQL_PAGE_REASON : undefined };
            const item = this.addResult(sql, pg.res, size, base + i + 1, total, paging);
            return item && getSettings().results.countRows && !firstOnly ? item : null;
          }
          const res = await api.execute(sess.sessionId, sql, DEFAULT_MAX_ROWS);
          this.addResult(sql, res, DEFAULT_MAX_ROWS, base + i + 1, total);
          return null;
        };
        try {
          let counted: ResultItem | null;
          try {
            counted = await runOne();
          } catch (e) {
            // Connection dropped (idle timeout, server restart…): reconnect silently and run a read-only
            // statement once more (Settings › Data › Auto-reconnect). Anything else surfaces the error.
            if (!this.alive || !(await this.reconnectForRetry(sql, e))) throw e;
            this.setRunning(true, "Reconnected · running again…");
            counted = await runOne();
          }
          if (counted) autoCount = counted;
          if (!this.isLineBased && /^\s*(create|alter|drop|rename)\b/i.test(sql)) schemaTouched = true;
          if (this.isKafka && /^\s*(create|delete)\s+topic\b/i.test(sql)) void loadOverview(this.connId, true);
        } catch (e) {
          if (!this.alive) return;
          this.addError(sql, errMsg(e), base + i + 1, total, isConnectionLost(rawMsg(e)));
          toast(errMsg(e), "error");
          break;
        }
      }
    } catch (e) {
      this.addError("", `Could not open a session: ${errMsg(e)}`, base + 1, total);
      toast(errMsg(e), "error");
    } finally {
      this.waitEl.remove();
      if (this.items.length > 0 && this.activeItem >= 0) this.activate(this.activeItem);
      this.setRunning(false, this.status.text.startsWith("Running") || this.status.text === "Connecting…" ? "Done" : this.status.text);
      this.host.onExecuted(this.connId);
      if (schemaTouched) this.host.onSchemaChanged(this.connId);
    }
    if (autoCount && this.alive) await this.countRows(autoCount);
  }

  /**
   * After a connection-lost error: when Auto-reconnect is on, the console is not in a manual transaction and the
   * statement only reads, reconnects the data source's sessions silently. True when the statement may run again.
   */
  private async reconnectForRetry(sql: string, err: unknown): Promise<boolean> {
    if (!getSettings().data.autoReconnect || this.isLineBased || !this.autoCommit) return false;
    if (!isConnectionLost(rawMsg(err)) || !isReadOnlyStatement(sql)) return false;
    this.setRunning(true, "Connection lost · reconnecting…");
    try {
      const r = await api.reconnectConnection(this.connId);
      // A session skipped because of an open transaction (typed BEGIN) must not be retried blindly.
      return r.sessions > 0 && r.skippedInTx === 0 && this.alive;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- paging

  /** Rows per page for this statement (0 = not paged: setting "All", not a single SELECT, Redis / Kafka). */
  private pageSizeFor(sql: string): number {
    if (this.isLineBased) return 0;
    const size = getSettings().results.pageSize;
    if (!(size > 0)) return 0;
    return pagedSql(this.driver, sql, size, 0) !== null ? size : 0;
  }

  /** Runs one page of `sql` (pageSize + 1 rows); the extra row only tells that more exist. */
  private async fetchPage(sessionId: string, sql: string, offset: number, size: number): Promise<{ res: QueryResult; hasMore: boolean }> {
    const wrapped = pagedSql(this.driver, sql, size, offset);
    if (!wrapped) throw new Error("This statement can't be paged");
    const res = await api.execute(sessionId, wrapped, size + 1);
    const hasMore = res.rows.length > size || res.truncated;
    if (res.rows.length > size) res.rows = res.rows.slice(0, size);
    res.truncated = false;
    // Edit detection / export look at the statement: report the user's one, not the paging wrapper.
    res.statement = sql;
    return { res, hasMore };
  }

  /** Pager: page `offset` with `size` rows (size 0 = all rows, unwrapped, up to the default row limit). */
  private async loadPage(item: ResultItem, offset: number, size: number, force = false): Promise<void> {
    if (!item.paging || this.running || !item.grid) return;
    if (!force && item.grid.hasPending()) {
      toast("Submit or revert pending changes first", "info");
      return;
    }
    this.setRunning(true, "Loading page…");
    try {
      const sess = await this.ensureSession();
      const prev = item.paging;
      if (size <= 0) {
        item.maxRows = DEFAULT_MAX_ROWS;
        const res = await api.execute(sess.sessionId, item.sql, DEFAULT_MAX_ROWS);
        if (!this.alive) return;
        item.last = res;
        item.paging = { offset: 0, pageSize: 0, hasMore: false, total: prev.total, enabled: true };
        this.applyGrid(item.grid, res, DEFAULT_MAX_ROWS);
        this.setItemLabel(item, res.rows.length, res.truncated);
      } else {
        const pg = await this.fetchPage(sess.sessionId, item.sql, offset, size);
        if (!this.alive) return;
        const firstOnly = pagingFirstPageOnly(this.driver, item.sql);
        item.last = pg.res;
        item.maxRows = size;
        item.paging = { offset, pageSize: size, hasMore: pg.hasMore, total: prev.total, enabled: !firstOnly, disabledReason: firstOnly ? MSSQL_PAGE_REASON : undefined };
        this.applyGrid(item.grid, pg.res, size);
        this.setItemLabel(item, pg.res.rows.length, pg.hasMore);
      }
      if (item.filter) item.grid.setServerSort(orderMarks(item.filter.order, this.driver));
      item.grid.setPaging(item.paging);
      this.status.rows = item.last?.rows.length ?? null;
      this.status.elapsedMs = item.last?.elapsedMs ?? null;
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      if (this.alive) this.setRunning(false, "Done");
    }
  }

  /** "Count rows": SELECT COUNT(*) over the statement; the pager then shows the total. */
  private async countRows(item: ResultItem): Promise<void> {
    const q = countSql(this.driver, item.sql);
    if (!q || !item.paging || this.running) return;
    this.setRunning(true, "Counting rows…");
    try {
      const sess = await this.ensureSession();
      const r = await api.execute(sess.sessionId, q, 1);
      const v = r.rows[0]?.[0];
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && item.paging) {
        item.paging = { ...item.paging, total: n };
        item.grid?.setPaging(item.paging);
      }
    } catch (e) {
      toast(`Could not count rows: ${errMsg(e)}`, "error");
    } finally {
      if (this.alive) this.setRunning(false, "Done");
    }
  }

  private setItemLabel(item: ResultItem, rows: number, more: boolean): void {
    const label = item.tab.querySelector(".r-label");
    if (label) label.textContent = `${(label.textContent ?? "Result").split(" · ")[0]} · ${rows.toLocaleString()}${more ? "+" : ""}`;
  }

  private async cancel(): Promise<void> {
    if (!this.session || !this.running) return;
    try {
      await api.cancel(this.session.sessionId);
      toast("Cancel requested", "info");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  // ---------------------------------------------------------------- results

  private clearResults(): void {
    this.items = [];
    this.activeItem = -1;
    clear(this.tabsEl);
    clear(this.bodyEl);
    this.tabsEl.classList.remove("multi");
    this.bar.hide();
  }

  private showEmptyResults(): void {
    const redis = this.isLineBased;
    const kafka = this.isKafka;
    this.bodyEl.appendChild(
      h(
        "div",
        { class: "r-empty" },
        h("div", { class: "r-empty-title" }, kafka ? "Run a command to see its result here" : redis ? "Run a command to see its reply here" : "Run a statement to see results here"),
        h(
          "div",
          { class: "hint" },
          h("kbd", null, MOD + "↵"),
          redis ? " runs the line under the cursor  ·  " : " runs the statement at the cursor  ·  ",
          h("kbd", null, MOD + "⇧↵"),
          " runs everything",
        ),
      ),
    );
  }

  private showEmptyIfNoResults(): void {
    if (this.items.length > 0) return;
    clear(this.bodyEl);
    this.showEmptyResults();
  }

  private addItem(label: string, sql: string, view: HTMLElement, kind: "rows" | "ok" | "err"): ResultItem {
    const idx = this.items.length;
    const tab = h(
      "button",
      { class: "r-tab " + kind, type: "button", role: "tab", title: sql, onclick: () => this.activate(idx) },
      kind === "err" ? icon("alert", 13) : kind === "rows" ? icon("table", 13) : icon("check", 13),
      h("span", { class: "r-label" }, label),
    );
    const item: ResultItem = { tab, view, sql, maxRows: DEFAULT_MAX_ROWS };
    this.items.push(item);
    this.waitEl.remove();
    this.tabsEl.appendChild(tab);
    // Result tabs only appear once a script produced more than one result.
    this.tabsEl.classList.toggle("multi", this.items.length > 1);
    this.bodyEl.appendChild(view);
    this.activate(idx);
    return item;
  }

  private activate(i: number): void {
    this.activeItem = i;
    this.items.forEach((it, k) => {
      it.tab.classList.toggle("on", k === i);
      it.view.classList.toggle("hidden", k !== i);
      if (k === i) {
        const g = it.grid;
        if (g && it.last) {
          this.status.rows = it.last.rows.length;
          this.status.elapsedMs = it.last.elapsedMs;
          this.status.affected = it.last.rowsAffected;
        }
      }
    });
    this.syncBar();
    this.host.onStatus(this);
  }

  private makeGrid(item: () => ResultItem): ResultGrid {
    const g = new ResultGrid({
      onSubmit: (edits) => this.submitEdits(item(), edits),
      onLoadMore: () => {
        const it = item();
        if (it.grid?.hasPending()) {
          toast("Submit or revert pending changes first", "info");
          return;
        }
        it.maxRows *= 2;
        void this.rerun(it);
      },
      onExport: (fromMenu) => this.exportItem(item(), fromMenu === true),
      onHeaderSort: (col, append) => this.headerSort(item(), col, append),
    });
    g.onPage((offset, size) => void this.loadPage(item(), offset, size));
    g.onCountRows(() => void this.countRows(item()));
    return g;
  }

  private addResult(sql: string, res: QueryResult, maxRows: number, n: number, total: number, paging: PagingState | null = null): ResultItem | null {
    this.status.elapsedMs = res.elapsedMs;
    const isRows = res.columns.length > 0;
    if (!isRows) {
      const aff = res.rowsAffected;
      this.status.rows = null;
      this.status.affected = aff;
      this.status.text = aff !== null ? `${aff.toLocaleString()} row${aff === 1 ? "" : "s"} affected` : "Statement executed";
      const view = h(
        "div",
        { class: "r-message ok" },
        icon("check", 20),
        h("div", { class: "r-message-title" }, aff !== null ? `${aff.toLocaleString()} row${aff === 1 ? "" : "s"} affected` : "Statement executed"),
        h("div", { class: "r-message-sub" }, `${res.elapsedMs} ms`),
        h("pre", { class: "r-sql" }, sql),
      );
      this.addItem(total > 1 ? `Statement ${n}` : "OK", sql, view, "ok");
      return null;
    }
    let ref!: ResultItem;
    const grid = this.makeGrid(() => ref);
    this.applyGrid(grid, res, maxRows);
    ref = this.addItem(total > 1 ? `Result ${n}` : "Result", sql, grid.el, "rows");
    ref.grid = grid;
    ref.last = res;
    ref.maxRows = maxRows;
    ref.paging = paging;
    if (paging) grid.setPaging(paging);
    this.initFilter(ref);
    this.syncBar();
    const label = ref.tab.querySelector(".r-label");
    if (label) label.textContent = `${total > 1 ? `Result ${n}` : "Result"} · ${res.rows.length.toLocaleString()}${res.truncated || paging?.hasMore ? "+" : ""}`;
    this.status.rows = res.rows.length;
    this.status.affected = res.rowsAffected;
    this.status.text = "Done";
    this.host.onStatus(this);
    return ref;
  }

  /** A cross-source result: "How it ran" (one line per pull + the in-memory join) above a read-only grid. */
  private addFedResult(sql: string, fr: FedResult, n: number, total: number): void {
    const res = fr.result;
    this.status.elapsedMs = res.elapsedMs;
    let ref!: ResultItem;
    const grid = this.makeGrid(() => ref);
    grid.setOptions({});
    grid.setResult(res, null, "Cross-source results are read-only", DEFAULT_MAX_ROWS);
    grid.setExportInfo(this.driver, null);
    const pulls = fr.plan.filter((st) => st.alias !== "");
    const ms = fr.plan.reduce((a, st) => a + st.elapsedMs, 0) || res.elapsedMs;
    const pulled = pulls.map((st) => `${st.rows.toLocaleString()} from ${st.sourceName}`);
    const pulledText = pulled.length > 1 ? pulled.slice(0, -1).join(", ") + " and " + pulled[pulled.length - 1] : pulled.join("");
    grid.setMeta([pulledText ? "pulled " + pulledText : "", ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : ms + " ms", "read-only"].filter(Boolean).join(" · "));
    const view = h("div", { class: "fed-view" }, this.planEl(fr.plan), grid.el);
    ref = this.addItem(total > 1 ? `Result ${n}` : "Result", sql, view, "rows");
    ref.grid = grid;
    ref.last = res;
    ref.fed = true;
    ref.maxRows = DEFAULT_MAX_ROWS;
    this.setItemLabel(ref, res.rows.length, res.truncated);
    this.status.rows = res.rows.length;
    this.status.affected = null;
    this.status.text = "Done";
    this.host.onStatus(this);
  }

  private planEl(plan: FedStep[]): HTMLElement {
    const rows = plan.map((st) => {
      const e = st.connectionId ? store.conns.get(st.connectionId) : undefined;
      const color = st.alias === "" || !e ? "var(--text-3)" : connColor(e.config);
      return h(
        "div",
        { class: "fed-step" + (st.alias === "" ? " local" : "") },
        h("span", { class: "fed-dot", style: `--c:${color}`, "aria-hidden": "true" }),
        h("span", { class: "fed-src", title: st.alias ? `${st.sourceName} (${st.alias})` : st.sourceName }, st.sourceName),
        h("span", { class: "fed-sql mono", title: st.sql }, st.sql),
        h("span", { class: "fed-rows" }, `${st.rows.toLocaleString()} row${st.rows === 1 ? "" : "s"}`),
        h("span", { class: "fed-ms" }, `${st.elapsedMs.toLocaleString()} ms`),
      );
    });
    return h("div", { class: "fed-plan", role: "group", "aria-label": "How it ran" }, h("div", { class: "fed-head" }, "How it ran"), rows);
  }

  private applyGrid(grid: ResultGrid, res: QueryResult, maxRows: number): void {
    const e = store.conns.get(this.connId);
    if (e?.config.driver === "redis" || e?.config.driver === "kafka") {
      // Redis replies / Kafka results are plain read-only tables: no edit context, no edit actions.
      grid.setOptions({ hideReadOnlyChip: true, plainMenu: true, fillLast: true });
      grid.setResult(res, null, e.config.driver === "kafka" ? "Kafka results are read-only" : "Redis replies are read-only", maxRows);
      grid.setMeta(`${res.elapsedMs.toLocaleString()} ms${this.serverLabel() ? " · " + this.serverLabel() : ""}`);
      return;
    }
    grid.setOptions({});
    const def = this.session?.defaultSchema ?? e?.session?.defaultSchema ?? null;
    const schemas = this.schemas();
    const det = detectEditContext(res.statement || "", res.columns, schemas, def, e?.config.readOnly === true);
    // Prefer the statement we sent when the backend echoes nothing useful.
    const det2 = det.ctx || !e ? det : detectEditContext(this.lastSql(grid), res.columns, schemas, def, e.config.readOnly === true);
    grid.setResult(res, det2.ctx, det2.reason, maxRows);
    grid.setExportInfo(this.driver, this.exportTable(res.statement || this.lastSql(grid)));
    grid.setMeta(`${res.elapsedMs.toLocaleString()} ms${this.serverLabel() ? " · " + this.serverLabel() : ""}`);
  }

  /** "PostgreSQL 16.2" — shown in the result pill. */
  private serverLabel(): string {
    const e = store.conns.get(this.connId);
    if (!e) return "";
    const name = DRIVER_LABELS[e.config.driver].split(" / ")[0];
    const ver = this.status.serverVersion || e.session?.serverVersion || "";
    const sent = sentinelLabel(e.config);
    return (ver ? `${name} ${ver}` : name) + (sent ? " · " + sent : "");
  }

  private lastSql(grid: ResultGrid): string {
    return this.items.find((i) => i.grid === grid)?.sql ?? "";
  }

  /** `reconnect`: the connection was lost — offer a Reconnect button. */
  private addError(sql: string, msg: string, n: number, total: number, reconnect = false): void {
    this.status.text = "Error";
    this.status.rows = null;
    this.status.affected = null;
    let btn: HTMLButtonElement | null = null;
    if (reconnect) {
      const b = h("button", { class: "btn sm", type: "button", title: "Reconnect this data source, then run the statement again" }, icon("refresh", 13), "Reconnect");
      b.addEventListener("click", () => {
        b.disabled = true;
        void this.host.reconnect(this.connId).finally(() => {
          b.disabled = false;
        });
      });
      btn = b;
    }
    const view = h(
      "div",
      { class: "r-message err", role: "alert" },
      icon("alert", 20),
      h("div", { class: "r-message-title" }, reconnect ? "Connection lost" : this.isLineBased ? "Command failed" : "Statement failed"),
      h("div", { class: "r-error-text" }, msg),
      sql ? h("pre", { class: "r-sql" }, sql) : null,
      btn,
      reconnect || this.fedActive ? null : this.ai.fixActions(sql, msg),
    );
    this.addItem(total > 1 ? `Error · ${n}` : "Error", sql, view, "err");
  }

  // ---------------------------------------------------------------- filter bar

  private get driver(): Driver {
    return store.conns.get(this.connId)?.config.driver ?? "postgres";
  }

  /** Marks the result as filterable when its statement is a simple single-table SELECT. */
  private initFilter(item: ResultItem): void {
    const p = this.isLineBased || item.fed ? null : parseFilterable(item.sql, this.driver);
    if (!p || !item.grid || !item.last) {
      item.filter = undefined;
      item.grid?.setServerSort(null);
      return;
    }
    item.filter = { where: p.where, order: p.order, draftWhere: p.where, draftOrder: p.order, error: null, columns: this.filterColumns(p.schema, p.table, item.last) };
    item.grid.setServerSort(orderMarks(p.order, this.driver));
  }

  /** The table's columns from the cached introspection, else the result's own columns. */
  private filterColumns(schema: string | null, table: string, res: QueryResult): { name: string; type?: string }[] {
    const low = (x: string): string => x.toLowerCase();
    const def = this.currentSchemaName();
    const pool = schema !== null ? this.schemas().filter((s) => low(s.name) === low(schema)) : [...this.schemas()].sort((a, b) => Number(b.name === def) - Number(a.name === def));
    for (const sc of pool) {
      const t = sc.tables.find((x) => x.name === table) ?? sc.tables.find((x) => low(x.name) === low(table));
      if (t) return t.columns.map((c) => ({ name: c.name, type: c.dataType }));
    }
    return res.columns.map((c) => ({ name: c.name, type: c.typeName }));
  }

  /** Shows the filter bar for the active result (or hides it). */
  private syncBar(): void {
    const it = this.items[this.activeItem];
    if (it?.filter) this.bar.show(it.filter, this.driver);
    else this.bar.hide();
  }

  private applyBar(where: string, order: string): void {
    const it = this.items[this.activeItem];
    if (it?.filter) void this.applyFilter(it, where, order, "bar");
  }

  /** Header click on a filterable result: sorts server-side by rewriting ORDER BY. */
  private headerSort(item: ResultItem, column: string, append: boolean): boolean {
    const f = item.filter;
    if (!f) return false;
    if (item.grid?.hasPending()) {
      toast("Submit or revert pending changes first", "info");
      return true;
    }
    if (this.running) return true;
    void this.applyFilter(item, f.where, nextOrder(f.order, column, append, this.driver), "header");
    return true;
  }

  /**
   * Re-runs the result's statement with a new WHERE / ORDER BY. On success the editor text (only
   * that statement) and the grid are updated; on failure the old result stays and the error is
   * shown under the bar.
   */
  private async applyFilter(item: ResultItem, where: string, order: string, from: "bar" | "header"): Promise<void> {
    const f = item.filter;
    const p = parseFilterable(item.sql, this.driver);
    if (!f || !p || this.running) return;
    if (item.grid?.hasPending()) {
      toast("Submit or revert pending changes first", "info");
      return;
    }
    const sql = buildFilteredSql(p, where, order);
    this.setRunning(true, "Filtering…");
    this.bar.setBusy(true);
    try {
      const sess = await this.ensureSession();
      const size = item.paging && item.paging.pageSize > 0 ? this.pageSizeFor(sql) && item.paging.pageSize : 0;
      let res: QueryResult;
      let more = false;
      if (size > 0) {
        const pg = await this.fetchPage(sess.sessionId, sql, 0, size);
        res = pg.res;
        more = pg.hasMore;
      } else res = await api.execute(sess.sessionId, sql, item.maxRows);
      if (!this.alive) return;
      this.editor.replaceStatementText(item.sql, sql);
      const np = parseFilterable(sql, this.driver);
      item.sql = sql;
      item.tab.title = sql;
      item.last = res;
      f.where = np?.where ?? where.trim();
      f.order = np?.order ?? order.trim();
      f.error = null;
      f.draftOrder = f.order;
      if (from === "bar" || f.draftWhere === where) f.draftWhere = f.where;
      if (item.paging) {
        const firstOnly = pagingFirstPageOnly(this.driver, sql);
        item.paging =
          size > 0
            ? { offset: 0, pageSize: size, hasMore: more, total: null, enabled: !firstOnly, disabledReason: firstOnly ? MSSQL_PAGE_REASON : undefined }
            : { ...item.paging, offset: 0, hasMore: false, total: null };
      }
      if (item.grid) {
        this.applyGrid(item.grid, res, size > 0 ? size : item.maxRows);
        item.grid.setServerSort(orderMarks(f.order, this.driver));
        if (item.paging) item.grid.setPaging(item.paging);
      }
      this.setItemLabel(item, res.rows.length, res.truncated || more);
      this.status.rows = res.rows.length;
      this.status.elapsedMs = res.elapsedMs;
    } catch (e) {
      f.error = errMsg(e);
    } finally {
      if (this.alive) {
        this.setRunning(false, "Done");
        this.bar.setBusy(false);
        if (this.items[this.activeItem] === item) this.syncBar();
        this.host.onExecuted(this.connId);
      }
    }
    if (this.alive && f.error === null && item.paging && item.paging.pageSize > 0 && item.paging.enabled && getSettings().results.countRows) await this.countRows(item);
  }

  private async rerun(item: ResultItem): Promise<void> {
    if (item.fed) {
      // "Load more" on a cross-source result: run it again with the larger row limit.
      if (this.running || !item.grid || this.fed.length === 0) return;
      this.setRunning(true, "Reloading across sources…");
      try {
        const fr = await api.federatedExecute(this.fedSources(), item.sql, item.maxRows);
        if (!this.alive) return;
        item.last = fr.result;
        item.grid.setResult(fr.result, null, "Cross-source results are read-only", item.maxRows);
        item.view.querySelector(".fed-plan")?.replaceWith(this.planEl(fr.plan));
        this.setItemLabel(item, fr.result.rows.length, fr.result.truncated);
        this.status.rows = fr.result.rows.length;
      } catch (e) {
        toast(errMsg(e), "error");
      } finally {
        if (this.alive) this.setRunning(false, "Done");
      }
      return;
    }
    if (item.paging && item.paging.pageSize > 0) {
      await this.loadPage(item, item.paging.offset, item.paging.pageSize, true);
      return;
    }
    if (!this.session || this.running) return;
    this.setRunning(true, "Reloading…");
    try {
      const res = await api.execute(this.session.sessionId, item.sql, item.maxRows);
      item.last = res;
      if (item.grid) this.applyGrid(item.grid, res, item.maxRows);
      const label = item.tab.querySelector(".r-label");
      if (label) label.textContent = `${(label.textContent ?? "Result").split(" · ")[0]} · ${res.rows.length.toLocaleString()}${res.truncated ? "+" : ""}`;
      this.status.rows = res.rows.length;
      this.status.elapsedMs = res.elapsedMs;
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      this.setRunning(false, "Done");
    }
  }

  private async submitEdits(item: ResultItem, edits: RowEdit[]): Promise<void> {
    try {
      const s = await this.ensureSession();
      const n = await api.applyEdits(s.sessionId, edits);
      toast(`${n} row${n === 1 ? "" : "s"} updated`, "ok");
    } catch (e) {
      toast(errMsg(e), "error");
      return;
    }
    await this.rerun(item);
  }

  private exportItem(item: ResultItem, fromMenu: boolean): void {
    const grid = item.grid;
    if (!grid) return;
    const snap = grid.exportSnapshot();
    const driver = this.driver;
    let reason = "";
    let sql: string | null = item.sql;
    if (driver === "redis" || driver === "kafka") {
      sql = null;
      reason = "Redis and Kafka results export the loaded rows only";
    } else if (item.fed) {
      sql = null;
      reason = "Cross-source results export the loaded rows only";
    } else if (!/^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*)(select|with|values|table)\b/i.test(item.sql)) {
      sql = null;
      reason = "Only a SELECT result can be re-run for all rows";
    }
    openExportDialog({
      driver,
      columns: snap.columns,
      rows: snap.rows,
      selection: snap.selection,
      tableName: this.exportTable(item.sql),
      sql,
      allDisabledReason: reason,
      getSessionId: async () => (await this.ensureSession()).sessionId,
      preferSelection: fromMenu,
    });
  }

  /** Qualified, dialect-quoted table of a simple single-table SELECT, else null. */
  private exportTable(sql: string): string | null {
    const p = this.isLineBased || this.fedActive ? null : parseFilterable(sql, this.driver);
    return p ? qualifiedName(this.driver, p.schema, p.table) : null;
  }

  // ---------------------------------------------------------------- cross-source queries (Sources strip)

  /** True when runs go through federated_execute: a SQL console with at least one extra source attached. */
  get fedActive(): boolean {
    return this.fed.length > 0 && !this.isLineBased && FED_DRIVERS.has(this.driver);
  }

  /** The console's own data source first (with its alias), then the attached ones. */
  private fedSources(): FedSource[] {
    return [
      { alias: this.ownAlias, connectionId: this.connId, database: this.fedOwnDb ?? this.database },
      ...this.fed.map((f) => ({ alias: f.alias, connectionId: f.connId, database: f.database })),
    ];
  }

  private onFedButton(): void {
    if (!this.fedShown && this.fed.length === 0) {
      this.fedShown = true;
      this.syncFedUi();
      const add = this.fedEl.querySelector<HTMLElement>(".fed-add");
      if (add) this.openAttachMenu(add);
      return;
    }
    if (this.fed.length === 0) {
      this.fedShown = false;
      this.syncFedUi();
      return;
    }
    const add = this.fedEl.querySelector<HTMLElement>(".fed-add");
    if (add) this.openAttachMenu(add);
  }

  /** `alias`: attach the picked source under this alias (the quick fix of an unattached alias). */
  private openAttachMenu(anchor: HTMLElement, alias?: string): void {
    const r = anchor.getBoundingClientRect();
    const used = new Set([this.connId, ...this.fed.map((f) => f.connId)]);
    const cands = store.list().filter((e) => FED_DRIVERS.has(e.config.driver) && !used.has(e.config.id));
    showMenu(
      r.left,
      r.bottom + 6,
      cands.length
        ? cands.map((e) => ({ label: e.config.name, icon: "database", hint: DRIVER_LABELS[e.config.driver].split(" / ")[0], onClick: () => void this.attachSource(e.config.id, alias) }))
        : [{ label: "No other SQL data source to attach", disabled: true }],
      { minWidth: 220 },
    );
  }

  /**
   * Attaches a data source (alias: `alias` when valid, else its name's slug; made unique). Already attached → its
   * alias. Returns null when it can't be attached (the console's own source, not a SQL source).
   */
  attachSource(connId: string, alias?: string, database: string | null = null, quiet = false): string | null {
    const e = store.conns.get(connId);
    if (!e || connId === this.connId || !FED_DRIVERS.has(e.config.driver) || this.isLineBased || !FED_DRIVERS.has(this.driver)) return null;
    const existing = this.fed.find((f) => f.connId === connId);
    if (existing) return existing.alias;
    const a = uniqueAlias(alias && isAlias(alias) ? alias : aliasSlug(e.config.name), [this.ownAlias, ...this.fed.map((f) => f.alias)]);
    this.fed.push({ alias: a, connId, database: SERVER_DRIVERS.has(e.config.driver) ? database : null });
    this.fedShown = true;
    this.syncFedUi();
    // The tab badge counts the sources.
    this.host.onDatabase(this);
    if (!quiet) toast(`Attached ${e.config.name} as ${a} — use ${a}.schema.table in SQL`, "info");
    return a;
  }

  private detachSource(i: number): void {
    this.fed.splice(i, 1);
    this.syncFedUi();
    this.host.onDatabase(this);
  }

  /**
   * Database picker of a Sources chip (server-type sources only). `value` null = the default: the connection's
   * default database for attached sources, the console's own database for the console's source (`fallback`).
   */
  private fedDbPicker(connId: string, value: string | null, fallback: string | null, set: (v: string | null) => void): HTMLElement | null {
    const e = store.conns.get(connId);
    if (!e || !SERVER_DRIVERS.has(e.config.driver)) return null;
    const shown = (): string => value ?? fallback ?? e.defaultDb ?? "default database";
    const btn = h(
      "button",
      { class: "fed-db mono", type: "button", "aria-haspopup": "menu", title: "Database this source reads from", "aria-label": `Database of ${e.config.name}: ${shown()}` },
      h("span", { class: "fed-db-name" }, shown()),
      h("span", { class: "tx-caret", "aria-hidden": "true" }, "▾"),
    );
    btn.addEventListener("click", () => void this.openFedDbMenu(btn, connId, value, fallback, set));
    return btn;
  }

  /** Lists the source's databases (connecting it in the explorer first when needed) and picks one. */
  private async openFedDbMenu(anchor: HTMLElement, connId: string, value: string | null, fallback: string | null, set: (v: string | null) => void): Promise<void> {
    let relabel = false;
    if (store.conns.get(connId)?.status !== "connected") {
      anchor.classList.add("busy");
      const ok = await this.host.ensureConnected(connId).catch(() => false);
      anchor.classList.remove("busy");
      if (!ok || !anchor.isConnected || !this.alive) return;
      relabel = true;
    }
    const e = store.conns.get(connId);
    if (!e) return;
    const def = fallback ?? e.defaultDb;
    const cur = value ?? def;
    const r = anchor.getBoundingClientRect();
    // Now that the default database is known, the chips can show it.
    if (relabel) this.syncFedUi();
    const list = [...e.databases].sort((a, b) => Number(a.isSystem) - Number(b.isSystem));
    showMenu(
      r.left,
      r.bottom + 6,
      list.length
        ? list.map((d) => ({
            label: d.name,
            checked: d.name === cur,
            hint: d.name === def ? "default" : d.isSystem ? "system" : undefined,
            onClick: () => set(d.name === def ? null : d.name),
          }))
        : [{ label: "No databases listed", disabled: true }],
      { minWidth: 200 },
    );
  }

  private fedChip(alias: string, connId: string, onAlias: (v: string) => void, onDetach: (() => void) | null, dbPicker: HTMLElement | null = null): HTMLElement {
    const e = store.conns.get(connId);
    const name = e?.config.name ?? "(removed data source)";
    const color = e ? connColor(e.config) : "var(--text-3)";
    const input = h("input", { class: "fed-alias mono", type: "text", value: alias, spellcheck: false, autocomplete: "off", "aria-label": `Alias of ${name}`, title: "Alias used in SQL: alias.schema.table" });
    input.size = Math.max(3, alias.length);
    input.addEventListener("input", () => (input.size = Math.max(3, input.value.length)));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur();
      } else if (ev.key === "Escape") {
        ev.stopPropagation();
        input.value = alias;
        input.blur();
      }
    });
    input.addEventListener("change", () => {
      const v = input.value.trim();
      if (v === alias) return;
      const others = [this.ownAlias, ...this.fed.map((f) => f.alias)].filter((a) => a !== alias).map((a) => a.toLowerCase());
      if (!isAlias(v)) toast("An alias uses letters, digits and _ and doesn't start with a digit", "info");
      else if (others.includes(v.toLowerCase())) toast(`The alias ${v} is already used in this console`, "info");
      else {
        onAlias(v);
        return;
      }
      input.value = alias;
      input.size = Math.max(3, alias.length);
    });
    return h(
      "span",
      { class: "fed-chip", style: `--c:${color}`, title: `${name}${e ? " — " + DRIVER_LABELS[e.config.driver] : ""}` },
      h("span", { class: "fed-dot", "aria-hidden": "true" }),
      input,
      h("span", { class: "fed-name" }, name),
      dbPicker,
      onDetach ? h("button", { class: "fed-x", type: "button", title: `Detach ${name}`, "aria-label": `Detach ${name}`, onclick: onDetach }, icon("x", 10)) : null,
    );
  }

  private syncFedUi(): void {
    const supported = !this.isLineBased && FED_DRIVERS.has(this.driver);
    this.btnFed.hidden = !supported;
    const on = this.fedActive;
    this.btnFed.classList.toggle("on", on);
    this.btnFed.setAttribute("aria-pressed", String(this.fedShown || on));
    this.btnFed.title = on ? `Sources: ${this.fed.length + 1} data sources — attach another…` : "Sources: query several data sources in this console";
    this.btnRun.title = on ? `Run across ${this.fed.length + 1} data sources (${MOD}Enter)` : `Run selection or statement at cursor (${MOD}Enter)`;
    const show = supported && (this.fedShown || this.fed.length > 0);
    this.fedEl.hidden = !show;
    this.el?.classList.toggle("fed-on", show);
    clear(this.fedEl);
    // Attached sources are part of the restored workspace.
    this.host.onWorkspace();
    this.editor.refreshFedMarks();
    if (!show) return;
    const add = h("button", { class: "fed-add", type: "button", "aria-haspopup": "menu", onclick: (ev: MouseEvent) => this.openAttachMenu(ev.currentTarget as HTMLElement) }, icon("plus", 12), "Attach source");
    this.fedEl.append(
      h("span", { class: "fed-label" }, "Sources"),
      this.fedChip(
        this.ownAlias,
        this.connId,
        (v) => {
          this.ownAlias = v;
          this.ownAliasEdited = true;
          this.syncFedUi();
        },
        null,
        this.fedDbPicker(this.connId, this.fedOwnDb, this.effectiveDatabase, (v) => {
          this.fedOwnDb = v;
          this.syncFedUi();
        }),
      ),
      ...this.fed.map((f, i) =>
        this.fedChip(
          f.alias,
          f.connId,
          (v) => {
            f.alias = v;
            this.syncFedUi();
          },
          () => this.detachSource(i),
          this.fedDbPicker(f.connId, f.database, null, (v) => {
            f.database = v;
            this.syncFedUi();
          }),
        ),
      ),
      add,
      h("span", { class: "fed-hint" }, this.fed.length ? "Query them as alias.schema.table · results are read-only" : "Attach another data source to join across sources"),
      h("button", { class: "fed-how", type: "button", onclick: () => this.showGuide() }, "How does this work?"),
    );
    if (this.fed.length === 0) {
      this.fedEl.append(h("button", { class: "fed-x close", type: "button", title: "Hide sources", "aria-label": "Hide sources", onclick: () => ((this.fedShown = false), this.syncFedUi()) }, icon("x", 11)));
    }
  }

  // ---------------------------------------------------------------- cross-source: guide, completion, quick fix, drops

  /** Turns a fresh console into a cross-source console: attaches `others`, shows the Sources strip and the guide. */
  setupCrossSource(others: string[]): void {
    if (this.isLineBased || !FED_DRIVERS.has(this.driver)) return;
    this.crossSource = true;
    for (const id of others) this.attachSource(id, undefined, null, true);
    this.fedShown = true;
    this.syncFedUi();
    this.host.onDatabase(this);
    if (!this.editor.getText().trim()) this.showGuide();
  }

  /** Console › Attach source…: opens the Sources strip and its attach menu. */
  openAttach(): void {
    if (this.isLineBased || !FED_DRIVERS.has(this.driver)) {
      toast("Cross-source queries work in PostgreSQL, MySQL, SQLite and SQL Server consoles", "info");
      return;
    }
    this.fedShown = true;
    this.syncFedUi();
    const add = this.fedEl.querySelector<HTMLElement>(".fed-add");
    if (add) this.openAttachMenu(add);
  }

  /** The guide card: three steps and "Insert an example query" (also from "How does this work?"). */
  showGuide(): void {
    if (this.isLineBased || !FED_DRIVERS.has(this.driver)) return;
    if (!this.fedShown) {
      this.fedShown = true;
      this.syncFedUi();
    }
    this.hideGuide();
    const aliases = [this.ownAlias, ...this.fed.map((f) => f.alias)];
    const go = h("button", { class: "btn primary fed-guide-go", type: "button" }, "Insert an example query");
    go.addEventListener("click", () => void this.insertExample(go));
    const step = (n: string, title: string, sub: string): HTMLElement =>
      h("div", { class: "fed-gstep" }, h("span", { class: "fed-gstep-n", "aria-hidden": "true" }, n), h("div", { class: "fed-gstep-t" }, title), h("div", { class: "fed-gstep-s" }, sub));
    const run = shortcutLabel("runStatement");
    this.guideEl = h(
      "div",
      { class: "fed-guide", role: "note", "aria-label": "Query across data sources" },
      h(
        "div",
        { class: "fed-guide-head" },
        h("span", null, "Query across data sources"),
        h("button", { class: "fed-x", type: "button", title: "Hide", "aria-label": "Hide the guide", onclick: () => this.hideGuide() }, icon("x", 10)),
      ),
      h(
        "div",
        { class: "fed-gsteps" },
        step("1", "Attach sources", "Each one gets a short alias, shown above. Add more with + Attach source."),
        step("2", "Write alias.schema.table", `e.g. ${aliases[0]}.schema.table JOIN ${aliases[1] ?? "other"}.schema.table`),
        step("3", run ? `Run (${run})` : "Run", "Filters run on each source; the join runs in DataTrip. Results are read-only."),
      ),
      h("div", { class: "fed-guide-foot" }, go, h("span", null, "Uses real tables from your attached sources. Runs as SQLite SQL in DataTrip.")),
    );
    this.editorWrap.appendChild(this.guideEl);
  }

  private hideGuide(): void {
    if (!this.guideEl) return;
    this.guideEl.remove();
    this.guideEl = null;
  }

  /** Connects a source (explorer connect) and loads its database's introspection; true when ready. */
  private async loadSource(connId: string, database: string | null): Promise<boolean> {
    if (!(await this.host.ensureConnected(connId).catch(() => false))) return false;
    if (database !== null && database !== store.conns.get(connId)?.defaultDb) await store.ensureDb(connId, database);
    return true;
  }

  private async insertExample(btn: HTMLButtonElement): Promise<void> {
    if (this.fed.length === 0) {
      toast("Attach a second data source first", "info");
      const add = this.fedEl.querySelector<HTMLElement>(".fed-add");
      if (add) this.openAttachMenu(add);
      return;
    }
    btn.disabled = true;
    btn.textContent = "Loading tables…";
    const ex: ExampleSource[] = [];
    for (const s of this.fedSources()) {
      const ok = await this.loadSource(s.connectionId, s.database);
      if (!this.alive) return;
      if (ok) ex.push({ alias: s.alias, schemas: store.schemasFor(s.connectionId, s.database), defaultSchema: store.defaultSchemaFor(s.connectionId, s.database) });
    }
    btn.disabled = false;
    btn.textContent = "Insert an example query";
    if (!btn.isConnected) return;
    const sql = exampleQuery(ex);
    if (!sql) {
      toast("Couldn't find tables in two of the attached sources", "info");
      return;
    }
    this.hideGuide();
    this.editor.insertStatement(sql, true);
    this.editor.focus();
  }

  private fedHooks(): FedHooks {
    return {
      complete: (path) => this.fedComplete(path),
      marks: (doc) => this.fedMarks(doc),
      tooltip: (m) => this.fedTip(m),
    };
  }

  /** The source behind an alias of this console (own or attached), while the Sources strip is in use. */
  private sourceByAlias(alias: string): { connId: string; database: string | null } | null {
    if (!this.fedShown && this.fed.length === 0) return null;
    const low = alias.toLowerCase();
    if (low === this.ownAlias.toLowerCase()) return { connId: this.connId, database: this.fedOwnDb ?? this.database };
    const f = this.fed.find((x) => x.alias.toLowerCase() === low);
    return f ? { connId: f.connId, database: f.database } : null;
  }

  /** `alias.` → the source's schemas, `alias.schema.` → its tables (introspection loaded lazily). */
  private fedComplete(path: string[]): FedCompletion[] | null | Promise<FedCompletion[] | null> {
    if (this.isLineBased || !FED_DRIVERS.has(this.driver) || path.length < 1 || path.length > 2) return null;
    const src = this.sourceByAlias(path[0]);
    if (!src) return null;
    const list = (): FedCompletion[] | null => {
      const schemas = store.schemasFor(src.connId, src.database);
      if (path.length === 1) {
        const def = store.defaultSchemaFor(src.connId, src.database);
        return schemas.map((s) => ({ label: s.name, apply: refPart(s.name), type: "namespace", detail: s.name === def ? "schema · default" : "schema", boost: s.name === def ? 2 : 0 }));
      }
      const s = schemas.find((x) => x.name.toLowerCase() === path[1].toLowerCase());
      if (!s) return null;
      return s.tables.map((t) => ({ label: t.name, apply: refPart(t.name), type: t.kind === "table" ? "type" : "class", detail: t.kind === "table" ? "table" : t.kind === "view" ? "view" : "materialized view" }));
    };
    const e = store.conns.get(src.connId);
    const ready = e?.status === "connected" && (src.database === null || src.database === e.defaultDb || e.dbs.get(src.database)?.status === "ready");
    if (ready) return list();
    return this.loadSource(src.connId, src.database).then((ok) => (ok && this.alive ? list() : null));
  }

  /**
   * `foo.schema.table` where `foo` is the alias slug of a SQL data source that isn't attached (and not a database of
   * this console's server, so real three-part names stay unmarked): underlined, with a one-click attach.
   */
  private fedMarks(doc: string): FedMark[] {
    if (this.isLineBased || !FED_DRIVERS.has(this.driver)) return [];
    const attached = new Set([this.connId, ...this.fed.map((f) => f.connId)]);
    const bySlug = new Map<string, string>();
    for (const e of store.list()) {
      if (!FED_DRIVERS.has(e.config.driver) || attached.has(e.config.id)) continue;
      const slug = aliasSlug(e.config.name);
      if (!bySlug.has(slug)) bySlug.set(slug, e.config.id);
    }
    if (bySlug.size === 0) return [];
    const aliases = new Set([this.ownAlias, ...this.fed.map((f) => f.alias)].map((a) => a.toLowerCase()));
    const dbNames = new Set((store.conns.get(this.connId)?.databases ?? []).map((d) => d.name.toLowerCase()));
    // Strings and comments blanked out, offsets kept.
    const code = doc.replace(/'(?:[^']|'')*'?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, " "));
    const re = /([A-Za-z_][A-Za-z0-9_]*)\.(?:[A-Za-z_][A-Za-z0-9_]*|"[^"\n]*")\.(?:[A-Za-z_][A-Za-z0-9_]*|"[^"\n]*")/g;
    const out: FedMark[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null && out.length < 200) {
      const prev = m.index > 0 ? code[m.index - 1] : "";
      if (prev && /[\w.$"`\]]/.test(prev)) continue;
      const low = m[1].toLowerCase();
      if (aliases.has(low) || dbNames.has(low) || !bySlug.has(low)) continue;
      out.push({ from: m.index, to: m.index + m[1].length, key: m[1] });
    }
    return out;
  }

  private fedTip(m: FedMark): HTMLElement {
    const low = m.key.toLowerCase();
    const attached = new Set([this.connId, ...this.fed.map((f) => f.connId)]);
    const e = store.list().find((x) => FED_DRIVERS.has(x.config.driver) && !attached.has(x.config.id) && aliasSlug(x.config.name) === low);
    const box = h("div", { class: "fed-tip" }, h("div", null, h("b", { class: "mono" }, m.key), " isn’t attached to this console."));
    if (!e) return box;
    const drv = DRIVER_LABELS[e.config.driver].split(" / ")[0];
    const choose = h("button", { class: "fed-tip-alt", type: "button" }, "Choose source…");
    choose.addEventListener("click", () => this.openAttachMenu(choose, m.key));
    box.appendChild(
      h(
        "div",
        { class: "fed-tip-actions" },
        h("button", { class: "fed-tip-go", type: "button", onclick: () => void this.attachSource(e.config.id, m.key) }, `Attach ${e.config.name} (${drv}) as ${m.key}`),
        choose,
      ),
    );
    return box;
  }

  /** What dropping that table here does: insert `schema.table`, or attach its source and insert `alias.schema.table`. */
  private dropPlan(d: TableDrag): { attach: boolean; alias: string | null; name: string; text: string } | null {
    const e = store.conns.get(d.connId);
    if (!e || this.isLineBased) return null;
    if (d.connId === this.connId) {
      const text = this.fedActive ? `${this.ownAlias}.${refPart(d.schema)}.${refPart(d.table)}` : qualifiedName(this.driver, d.schema, d.table);
      return { attach: false, alias: null, name: e.config.name, text };
    }
    if (!FED_DRIVERS.has(e.config.driver) || !FED_DRIVERS.has(this.driver)) return null;
    const ex = this.fed.find((f) => f.connId === d.connId);
    const alias = ex?.alias ?? uniqueAlias(aliasSlug(e.config.name), [this.ownAlias, ...this.fed.map((f) => f.alias)]);
    return { attach: !ex, alias, name: e.config.name, text: `${alias}.${refPart(d.schema)}.${refPart(d.table)}` };
  }

  private showDropHint(): void {
    const d = tableDrag();
    const plan = d ? this.dropPlan(d) : null;
    clear(this.dropEl);
    if (!plan) {
      this.hideDropHint();
      return;
    }
    this.dropEl.append(
      plan.attach
        ? h(
            "div",
            { class: "fed-drop-card" },
            "Drop to attach ",
            h("b", null, plan.name),
            " as ",
            h("b", { class: "mono" }, plan.alias ?? ""),
            h("br"),
            h("span", { class: "dim" }, "and insert "),
            h("span", { class: "mono hl" }, plan.text),
          )
        : h("div", { class: "fed-drop-card" }, h("span", { class: "dim" }, "Drop to insert "), h("span", { class: "mono hl" }, plan.text)),
    );
    this.dropEl.hidden = false;
    this.editorWrap.classList.add("drop-on");
    this.editorWrap.classList.toggle("drop-attach", plan.attach);
  }

  private hideDropHint(): void {
    this.dropEl.hidden = true;
    this.editorWrap.classList.remove("drop-on", "drop-attach");
  }

  /** Explorer tables dropped on the editor (capture phase: CodeMirror's own drop handling never sees them). */
  private bindTableDrop(): void {
    const wrap = this.editorWrap;
    const ours = (ev: DragEvent): boolean => hasTableDrag(ev) && !this.isLineBased;
    wrap.addEventListener(
      "dragover",
      (ev) => {
        if (!ours(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
        if (this.dropEl.hidden) this.showDropHint();
      },
      true,
    );
    wrap.addEventListener("dragleave", (ev) => {
      if (!ev.relatedTarget || !wrap.contains(ev.relatedTarget as Node)) this.hideDropHint();
    });
    wrap.addEventListener(
      "drop",
      (ev) => {
        if (!ours(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.hideDropHint();
        const d = droppedTable(ev);
        if (!d) return;
        this.dropTable(d, this.editor.posAtCoords(ev.clientX, ev.clientY) ?? this.editor.cursor);
      },
      true,
    );
  }

  private dropTable(d: TableDrag, pos: number): void {
    const plan = this.dropPlan(d);
    if (!plan) return;
    let text = plan.text;
    if (plan.attach) {
      const e = store.conns.get(d.connId);
      const db = e && d.database !== null && d.database !== e.defaultDb ? d.database : null;
      const a = this.attachSource(d.connId, plan.alias ?? undefined, db, true);
      if (!a) return;
      text = `${a}.${refPart(d.schema)}.${refPart(d.table)}`;
      toast(`Attached ${e?.config.name ?? "the data source"} as ${a}`, "info");
    }
    this.hideGuide();
    this.editor.insertAt(pos, text);
  }

  // ---------------------------------------------------------------- layout

  private bindSplitter(sp: HTMLElement): void {
    const saved = Number(localStorage.getItem("dt.editorH"));
    this.editorWrap.style.height = (saved >= 80 ? saved : 236) + "px";
    sp.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.editorWrap.getBoundingClientRect().height;
      const max = this.el.getBoundingClientRect().height - 180;
      const move = (ev: PointerEvent): void => {
        const hgt = Math.max(70, Math.min(max, startH + ev.clientY - startY));
        this.editorWrap.style.height = hgt + "px";
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing-row");
        localStorage.setItem("dt.editorH", String(Math.round(this.editorWrap.getBoundingClientRect().height)));
      };
      document.body.classList.add("resizing-row");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  get isRunning(): boolean {
    return this.running && this.alive;
  }
}

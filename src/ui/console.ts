// A console tab: SQL editor on top, results below (grid / message / error).
// Its run controls (Run / Cancel, Run all, transaction pill) are mounted by the shell into the
// floating capsule while this console is active.
import { isDesktop, preferences } from "../platform";
import { api } from "../api";
import type { Driver, FedResult, FedSource, FedStep, QueryResult, RowEdit, SchemaNode, SessionInfo } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { DRIVER_LABELS } from "../types";
import { confirmDialog } from "./confirm";
import { showMenu } from "./menu";
import { SqlEditor } from "./editor";
import { kafkaNames, loadOverview } from "./kafka";
import { ResultGrid } from "./grid";
import type { GridViewState, PagingState } from "./grid";
import { LIVE_CONSOLES, planHibernation } from "./hibernate";
import type { HibConsole } from "./hibernate";
import { store } from "./state";
import { buildCompletionSchema, buildFilteredSql, connColor, countSql, detectEditContext, nextOrder, orderMarks, pagedSql, pagingFirstPageOnly, parseFilterable, qualifiedName, quoteIdent } from "./sqlutil";
import { getSettings } from "./settings";
import { handleActionError } from "./recovery";
import { FED_DRIVERS, aliasSlug, defaultSchemaOf, droppedTable, fedSourcesFor, findTableRefs, hasTableDrag, isAlias, refPart, resolveSource, routeStatement, sourceRef, tableDrag, tableRef, uniqueAlias } from "./federation";
import type { CatalogSource, Route, RouteContext, TableDrag } from "./federation";
import { statementAt } from "../sqlsplit";
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
import { dbLabel, sentinelLabel } from "./redis";
import { AiAssist } from "./aiPanel";
import { docWithoutPending } from "./aiEditor";
import { FileBinding } from "./sqlFiles";
import { errorHelpButton } from "./help";
import { confirmWrites, paramBar, paramError, prepareParams, runExplain } from "./consoleOps";
import type { ParamRun, PreparedRun } from "./consoleOps";
import { parseRemembered } from "./params";
import type { RememberedParams } from "./params";
import { closeParamsPopover } from "./paramsPopover";
import { confirmProdCommands, confirmProdEdits, prodBar } from "./prodUi";
import { analyzeSupported } from "./explainPlan";
import { renderPlanView } from "./explainView";
import { updateSettings } from "./settings";

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
  /** The sources it ran with ("Load more" runs it again with them). */
  fedSources?: FedSource[];
  /** v0.16: ran with parameters (chips above the result, Edit parameters). */
  params?: ParamRun | null;
  /**
   * v0.17: the grid was released (console hibernated): `slot` stands where its element was, `state` rebuilds the
   * view; `released` = the row count when the rows were dropped too ("Results released to save memory").
   */
  hib?: { state: GridViewState | null; slot: HTMLElement; released: number | null };
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

// ---------------------------------------------------------------- v0.15 safeguards (module-wide)

/** Only this many most recently used consoles keep a live CodeMirror view (and result grids); the others hibernate theirs. */
const LIVE_EDITORS = LIVE_CONSOLES;
/** Consoles, most recently used first. */
const consoleOrder: ConsolePane[] = [];
let idleTimer: number | undefined;

/** Marks a console as just used: it keeps (or gets back) its editor view; the least recently used beyond 10 hibernate. */
function touchConsole(c: ConsolePane): void {
  const i = consoleOrder.indexOf(c);
  if (i >= 0) consoleOrder.splice(i, 1);
  consoleOrder.unshift(c);
  for (const old of consoleOrder.slice(LIVE_EDITORS)) old.hibernateEditor();
  sweepResults();
  if (idleTimer === undefined) idleTimer = window.setInterval(idleSweep, 30_000);
}

/**
 * v0.17: consoles beyond the 10 most recently used release their result grids (rebuilt when shown again); those
 * keeping more rows than `data.hibernateResultRows` drop the rows too. Never visible / running / pending-edit ones.
 */
function sweepResults(): void {
  const plan = planHibernation(
    consoleOrder.map((c) => c.hibInfo()),
    { live: LIVE_EDITORS, rowBudget: getSettings().data.hibernateResultRows },
  );
  const list = [...consoleOrder];
  plan.forEach((a, i) => {
    if (a !== "keep") list[i]?.hibernateResults(a === "release");
  });
}

/** Closes the database session of consoles idle for `data.idleDisconnectMinutes` (0 = never). */
function idleSweep(): void {
  const min = getSettings().data.idleDisconnectMinutes;
  if (!(min > 0)) return;
  for (const c of [...consoleOrder]) c.idleCheck(min * 60_000);
}

/** Code-point offset → UTF-16 index (PostgreSQL error positions count characters). */
function cpIndex(s: string, cp: number): number {
  let i = 0;
  for (let n = 0; n < cp && i < s.length; n++) i += (s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  return i;
}

/** The token at `pos` (word, quoted name / literal, else one character); at the end, the last token before it. */
function tokenRange(doc: string, pos: number, limit: number): { from: number; to: number } {
  let p = Math.max(0, Math.min(pos, doc.length));
  if (p >= limit || p >= doc.length || /\s/.test(doc[p])) {
    // "at end of input" / a position on whitespace: the token before it
    let q = Math.min(p, doc.length) - 1;
    while (q > 0 && /\s/.test(doc[q])) q--;
    if (q < 0) return { from: 0, to: Math.min(1, doc.length) };
    let a = q;
    while (a > 0 && /[\w$#@]/.test(doc[a - 1]) && /[\w$#@]/.test(doc[q])) a--;
    return { from: a, to: q + 1 };
  }
  const c = doc[p];
  if (c === "'" || c === '"' || c === "`" || c === "[") {
    const close = c === "[" ? "]" : c;
    const e = doc.indexOf(close, p + 1);
    if (e > p && e - p < 200) return { from: p, to: e + 1 };
  }
  if (/[\w$#@]/.test(c)) {
    while (p > 0 && /[\w$#@]/.test(doc[p - 1])) p--;
    let e = p;
    while (e < doc.length && /[\w$#@]/.test(doc[e])) e++;
    return { from: p, to: e };
  }
  return { from: p, to: p + 1 };
}

const IDLE_HINT = (min: number): string => `Disconnected after ${min} min idle — reconnects on next run`;

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
  /** v0.15: last run / typing / focus in this console (idle disconnect). */
  private lastUse = Date.now();
  /** v0.15: the session was closed because the console sat idle (tooltip hint until the next run). */
  private idleClosedMin = 0;
  /** v0.15: a typed BEGIN / START TRANSACTION (Redis MULTI) without its COMMIT / ROLLBACK yet: never idle-close. */
  private typedTx = false;
  /** "Drop to attach …" hint while a table is dragged over the editor. */
  private dropEl: HTMLElement = h("div", { class: "fed-drop", hidden: true, "aria-hidden": "true" });
  /** v0.16: Explain (⌥⌘E) in the capsule controls. */
  private btnExplain: HTMLButtonElement;
  /** v0.16: parameter values of this console (persisted with the workspace when "Remember" is on). */
  private paramMemory: RememberedParams | null = null;
  /** v0.16: chips of the active result's parameter values. */
  private paramBarEl: HTMLElement = h("div", { class: "pr-host", hidden: true });
  /** v0.16: PRODUCTION · <name> bar. */
  private prod: { el: HTMLElement; refresh: () => void; dispose: () => void };
  /** SQL files (v0.15): the .sql file this console is bound to, File ▾, changed-on-disk banner. */
  readonly file: FileBinding = new FileBinding({
    view: () => this.editor.cmView,
    renamed: (name) => {
      this.title = name;
      this.host.onDatabase(this);
    },
    dirtyChanged: () => this.host.onStatus(this),
    connId: () => this.connId,
    database: () => this.database,
    title: () => this.title,
    pane: () => this,
  });

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
    this.btnExplain = h(
      "button",
      { class: "cap-btn ghost explain-btn", type: "button", title: `Explain plan (${shortcutLabel("explain") || "⌥⌘E"})`, onclick: () => void this.explain() },
      "Explain",
    );
    this.controls = h("div", { class: "cap-controls" }, this.file.button, this.btnAi, this.btnRun, this.btnStop, this.btnRunAll, this.btnExplain, this.btnFed, this.btnTx);
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
      onCursor: () => {
        this.lastUse = Date.now();
        this.host.onWorkspace();
      },
      onChange: () => this.file.onEdit(),
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
      // v0.15: cross-source requests (aiCross.ts)
      catalog: () => this.catalog(),
      routeCtx: () => this.routeCtx(),
      sourceDatabase: (id: string) => this.fed.find((f) => f.connId === id)?.database ?? null,
      loadSource: (id: string, db: string | null) => this.loadSource(id, db),
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
    const results = h("div", { class: "c-results" }, this.tabsEl, this.bar.el, this.paramBarEl, this.bodyEl);
    this.fedEl = h("div", { class: "fed-strip", role: "group", "aria-label": "Sources", hidden: true });
    this.prod = prodBar(() => this.connId);
    this.el = h("div", { class: "console" }, this.prod.el, this.fedEl, this.file.banner, this.editorWrap, splitter, results);
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
    this.editorWrap.addEventListener("focusin", () => (this.lastUse = Date.now()));
    touchConsole(this);
  }

  // ---------------------------------------------------------------- v0.15 safeguards

  /** Destroys the editor view of a hidden, least recently used console (its text, undo history and results stay). */
  hibernateEditor(): void {
    if (!this.alive || this.editor.hibernated || this.ai.busy) return;
    if (this.el.isConnected && !this.el.classList.contains("hidden")) return;
    this.ai.close();
    this.editor.hibernate();
  }

  // ---------------------------------------------------------------- v0.17 result-grid hibernation

  private get shown(): boolean {
    return this.alive && this.el.isConnected && !this.el.classList.contains("hidden");
  }

  /** What the hibernation planner needs (hibernate.ts). */
  hibInfo(): HibConsole {
    let rows = 0;
    for (const it of this.items) if (it.last && (!it.hib || it.hib.released === null)) rows += it.last.rows.length;
    return { visible: this.shown, busy: this.running, pending: this.items.some((i) => i.grid?.hasPending() === true), rows };
  }

  /** Releases the result grids of this hidden console (rows kept); `release` drops the rows too. */
  hibernateResults(release: boolean): void {
    if (!this.alive || this.running || this.shown) return;
    if (this.items.some((i) => i.grid?.hasPending() === true)) return;
    for (const it of this.items) {
      if (it.grid && it.last) this.sleepItem(it);
      if (release && it.hib && it.hib.released === null && it.last) this.releaseItem(it);
    }
  }

  /** Destroys an item's grid (DOM, listeners) and leaves an empty slot in its place. */
  private sleepItem(it: ResultItem): void {
    const g = it.grid;
    if (!g || !g.el.parentNode) return;
    const state = g.viewState();
    const slot = h("div", { class: "r-hib", "aria-hidden": "true" });
    const isView = it.view === g.el;
    if (isView && g.el.classList.contains("hidden")) slot.classList.add("hidden");
    g.el.replaceWith(slot);
    if (isView) it.view = slot;
    it.grid = undefined;
    it.hib = { state, slot, released: null };
    g.dispose();
  }

  /** Drops a hibernated item's rows (column info and the count stay) and shows "Results released…". */
  private releaseItem(it: ResultItem): void {
    const hib = it.hib;
    const last = it.last;
    if (!hib || !last) return;
    hib.released = last.rows.length;
    it.last = { ...last, rows: [] };
    const slot = hib.slot;
    const hidden = slot.classList.contains("hidden");
    slot.className = "r-message r-released" + (hidden ? " hidden" : "");
    slot.removeAttribute("aria-hidden");
    const cols = last.columns.map((c) => c.name);
    const colText = cols.length > 6 ? `${cols.slice(0, 6).join(", ")}, … (${cols.length} columns)` : cols.join(", ");
    const n = hib.released;
    const btn = h("button", { class: "btn sm", type: "button", title: "Run the statement again on this console's session" }, icon("refresh", 13), "Run again");
    btn.addEventListener("click", () => void this.runAgain(it));
    slot.replaceChildren(
      icon("table", 20),
      h("div", { class: "r-message-title" }, "Results released to save memory"),
      h("div", { class: "r-message-sub" }, `${n.toLocaleString()} row${n === 1 ? "" : "s"}${colText ? " · " + colText : ""}`),
      h("pre", { class: "r-sql" }, it.sql),
      btn,
    );
  }

  /** Rebuilds a hibernated item's grid from the kept result (scroll, selection, widths, sort, filter restored). */
  private wakeItem(it: ResultItem): ResultGrid | null {
    const hib = it.hib;
    const last = it.last;
    if (!hib || !last || !hib.slot.parentNode) return null;
    const grid = this.makeGrid(() => it);
    it.grid = grid;
    if (it.fed) {
      grid.setOptions({});
      grid.setResult(last, null, "Cross-source results are read-only", it.maxRows);
      grid.setExportInfo(this.driver, null);
    } else this.applyGrid(grid, last, it.maxRows);
    if (it.paging) grid.setPaging(it.paging);
    if (it.filter) grid.setServerSort(orderMarks(it.filter.order, this.driver));
    const isView = it.view === hib.slot;
    if (isView && hib.slot.classList.contains("hidden")) grid.el.classList.add("hidden");
    hib.slot.replaceWith(grid.el);
    if (isView) it.view = grid.el;
    it.hib = undefined;
    if (hib.state && hib.released === null) grid.restoreView(hib.state);
    return grid;
  }

  /** "Run again" on released results: the same statement (parameters already substituted) on this console's session. */
  private async runAgain(it: ResultItem): Promise<void> {
    if (this.running || !it.hib) return;
    const state = it.hib.state;
    if (!this.wakeItem(it)) return;
    this.syncBar();
    await this.rerun(it);
    if (this.alive && it.grid && state && it.last && it.last.columns.length === state.widths.length) it.grid.restoreView({ ...state, meta: "" });
  }

  /** The active result of a console that is shown again gets its grid back. */
  private wakeResults(): void {
    const it = this.items[this.activeItem];
    if (it?.hib && it.hib.released === null && this.shown) this.wakeItem(it);
  }

  /**
   * Closes the console's database session after `ms` without a run, typing or focus — never while a statement
   * runs, in a manual transaction (or a typed BEGIN), with the editor focused, or for Kafka. The next run
   * reopens it silently (ensureSession).
   */
  idleCheck(ms: number): void {
    const s = this.session;
    if (!this.alive || !s || this.running || !this.autoCommit || this.typedTx || this.isKafka || this.ai.busy) return;
    if (Date.now() - this.lastUse < ms) return;
    if (document.hasFocus() && this.editorWrap.contains(document.activeElement)) return;
    this.session = null;
    this.sessionPromise = null;
    void api.closeSession(s.sessionId).catch(() => undefined);
    this.idleClosedMin = Math.round(ms / 60_000);
    this.status.text = IDLE_HINT(this.idleClosedMin);
    this.host.onStatus(this);
    // re-renders the tabs, so the tooltip carries the hint
    this.host.onDatabase(this);
  }

  /** "Disconnected after 15 min idle — reconnects on next run" (tab tooltip), or null. */
  get statusHint(): string | null {
    return this.idleClosedMin > 0 && !this.session ? IDLE_HINT(this.idleClosedMin) : null;
  }

  /** Statements typed to open / end a transaction (only blocks the idle disconnect). */
  private trackTx(sql: string): void {
    const t = headOf(sql).toLowerCase();
    if (this.isRedis) {
      if (/^multi\b/.test(t)) this.typedTx = true;
      else if (/^(?:exec|discard)\b/.test(t)) this.typedTx = false;
      return;
    }
    if (/^(?:begin|start\s+transaction|savepoint|set\s+transaction)\b/.test(t)) this.typedTx = true;
    else if (/^(?:commit|end)\b/.test(t) || (/^rollback\b/.test(t) && !/^rollback\s+(?:work\s+)?to\b/.test(t))) this.typedTx = false;
  }

  /** Doc offset where `sql` (a statement that ran) sits in the editor: the copy at / nearest the caret; -1 = gone. */
  private locateStatement(doc: string, sql: string): number {
    if (!sql) return -1;
    const head = this.editor.cursor;
    let best = -1;
    let dist = Infinity;
    for (let i = doc.indexOf(sql), k = 0; i >= 0 && k < 200; i = doc.indexOf(sql, i + 1), k++) {
      const d = head < i ? i - head : head > i + sql.length ? head - i - sql.length : 0;
      if (d < dist) {
        best = i;
        dist = d;
      }
    }
    return best;
  }

  /**
   * The editor range where a failed statement went wrong (v0.15): the error's `position` (1-based character of the
   * executed SQL) or `line`, mapped from what ran (the pager wraps a single SELECT) to the statement in the editor.
   */
  private errorSpot(e: unknown, sql: string, executed: string): { from: number; to: number; where: string } | null {
    const pe = e as { position?: unknown; line?: unknown };
    const pos = typeof pe.position === "number" && pe.position >= 1 ? pe.position : null;
    const line = typeof pe.line === "number" && pe.line >= 1 ? pe.line : null;
    if (pos === null && line === null) return null;
    const doc = this.editor.getText();
    const start = this.locateStatement(doc, sql);
    if (start < 0) return null;
    const trimmed = sql.trimStart();
    const lead = sql.length - trimmed.length;
    const k = executed === sql ? lead : executed.indexOf(trimmed.slice(0, Math.min(trimmed.length, 80)));
    if (k < 0) return null;
    const base = k - lead; // index in `executed` of sql[0]
    const lineCol = (idx: number): string => {
      const before = sql.slice(0, idx);
      const l = doc.slice(0, start).split("\n").length + before.split("\n").length - 1;
      return `line ${l}, column ${idx - before.lastIndexOf("\n")}`;
    };
    if (pos !== null) {
      const idx = cpIndex(executed, pos - 1) - base;
      if (idx < 0 || idx > sql.length) return null;
      const r = tokenRange(doc, start + idx, start + sql.length);
      return { ...r, where: lineCol(Math.min(idx, sql.length)) };
    }
    const n = (line as number) - 1 - (base > 0 ? executed.slice(0, base).split("\n").length - 1 : 0);
    const lines = sql.split("\n");
    if (n < 0 || n >= lines.length) return null;
    const ls = lines.slice(0, n).reduce((a, x) => a + x.length + 1, 0);
    const text = lines[n];
    const a = text.length - text.trimStart().length;
    const b = text.trimEnd().length;
    if (b <= a) return null;
    return { from: start + ls + a, to: start + ls + b, where: `line ${doc.slice(0, start + ls).split("\n").length}` };
  }

  focus(): void {
    touchConsole(this);
    this.wakeResults();
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
    return this.file.dirty || (!this.autoCommit && this.session !== null) || this.items.some((i) => i.grid?.hasPending() === true);
  }

  /** The .sql file this console is bound to (tab name = its file name), null for a plain console. */
  get filePath(): string | null {
    return this.file.path;
  }

  /** The editor's whole text (reopen closed tab). */
  get sqlText(): string {
    return this.editor.getText();
  }

  // ---------------------------------------------------------------- restore on launch

  /** What restore on launch saves for this console. */
  snapshot(): WsConsole {
    return {
      sql: docWithoutPending(this.editor.state),
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
      file: this.file.snapshot(),
      params: this.paramMemory?.remember ? this.paramMemory : null,
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
    if (ws.file) this.file.restore(ws.file);
    this.paramMemory = parseRemembered(ws.params);
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
    touchConsole(this);
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
  async formatSql(): Promise<void> {
    if (this.isLineBased || !canFormat(this.driver)) return;
    const t = this.editor.formatTarget();
    if (!t) {
      toast("Nothing to format at the cursor", "info");
      return;
    }
    let out: string;
    try {
      out = (await formatSqlText(t.text, this.driver)).trim();
    } catch (e) {
      const msg = errMsg(e).split("\n")[0].trim();
      toast(`Couldn't format: ${msg.length > 140 ? msg.slice(0, 140) + "…" : msg}`, "error");
      return;
    }
    const current = this.editor.formatTarget();
    if (current?.from !== t.from || current.to !== t.to || current.text !== t.text) return;
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
    this.typedTx = false;
    this.syncTxUi();
  }

  async dispose(): Promise<void> {
    this.alive = false;
    const at = consoleOrder.indexOf(this);
    if (at >= 0) consoleOrder.splice(at, 1);
    this.bar.destroy();
    const s = this.session;
    this.session = null;
    this.ai.dispose();
    this.prod.dispose();
    closeParamsPopover();
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
          this.typedTx = false;
          this.idleClosedMin = 0;
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
    this.btnExplain.hidden = this.isLineBased;
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
    this.lastUse = Date.now();
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
   * (gutter ▶ with Alt/Option). A statement that refers to other data sources (`source.database.table`, attached
   * aliases) runs as a cross-source query; the others run on the console's session.
   */
  private async runList(stmts: string[], opts: { append?: boolean } = {}): Promise<void> {
    if (this.running || stmts.length === 0) return;
    // v0.16: parameters (:name, ?, $n) → popover → values substituted as literals
    const prepared = await this.prepareRun(stmts, "Run");
    if (!prepared || this.running) return;
    stmts = prepared.stmts;
    if (!(await this.confirmWrites(stmts))) return;
    if (this.running) return;
    // v0.15: the error underline of the previous run goes away
    this.editor.clearErrorMark();
    this.idleClosedMin = 0;
    const routes = stmts.map((sql) => this.routeOf(sql));
    const allFed = routes.every((r) => r.kind !== "native");
    const base = opts.append ? this.items.length : 0;
    const total = base + stmts.length;
    this.setRunning(true, allFed ? "Running across sources…" : "Connecting…");
    if (opts.append && this.items.length > 0) this.waitEl.remove();
    else this.clearResults();
    this.items.forEach((it) => it.view.classList.add("hidden"));
    this.bodyEl.appendChild(this.waitEl);
    let schemaTouched = false;
    let autoCount: ResultItem | null = null;
    let sess: SessionInfo | null = null;
    try {
      for (let i = 0; i < stmts.length; i++) {
        const sql = stmts[i];
        const route = routes[i];
        const label = stmts.length > 1 ? `Running ${i + 1} of ${stmts.length}` : "Running";
        if (route.kind === "error") {
          this.addError(sql, route.message, base + i + 1, total, false, true);
          toast(route.message, "error");
          break;
        }
        if (route.kind === "federated") {
          this.setRunning(true, `${label} across sources…`);
          const sources = this.fedSourcesFor(route);
          try {
            const fr = await api.federatedExecute(sources, sql, DEFAULT_MAX_ROWS);
            if (!this.alive) return;
            this.addFedResult(sql, fr, base + i + 1, total, sources);
            this.tagParams(prepared.info[i]);
          } catch (e) {
            if (!this.alive) return;
            this.addError(prepared.info[i]?.original ?? sql, errMsg(e), base + i + 1, total, false, true);
            if (!handleActionError(e)) toast(errMsg(e), "error");
            break;
          }
          continue;
        }
        if (!sess) {
          try {
            // A console restored on launch connects its data source on first use.
            if (this.needsConnect) await this.wake();
            sess = await this.ensureSession();
          } catch (e) {
            this.addError("", `Could not open a session: ${errMsg(e)}`, base + i + 1, total);
            toast(errMsg(e), "error");
            break;
          }
        }
        const sid = sess.sessionId;
        this.setRunning(true, `${label}…`);
        /** Runs the statement; returns its result when it should get an automatic row count. */
        const runOne = async (): Promise<ResultItem | null> => {
          const size = stmts.length === 1 ? this.pageSizeFor(sql) : 0;
          if (size > 0) {
            // A single SELECT: run its first page (n + 1 rows tell whether more exist).
            const pg = await this.fetchPage(sid, sql, 0, size);
            const firstOnly = pagingFirstPageOnly(this.driver, sql);
            const paging: PagingState = { offset: 0, pageSize: size, hasMore: pg.hasMore, total: null, enabled: !firstOnly, disabledReason: firstOnly ? MSSQL_PAGE_REASON : undefined };
            const item = this.addResult(sql, pg.res, size, base + i + 1, total, paging);
            return item && getSettings().results.countRows && !firstOnly ? item : null;
          }
          const res = await api.execute(sid, sql, DEFAULT_MAX_ROWS);
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
          this.tagParams(prepared.info[i]);
          this.trackTx(sql);
          if (!this.isLineBased && /^\s*(create|alter|drop|rename)\b/i.test(sql)) schemaTouched = true;
          if (this.isKafka && /^\s*(create|delete)\s+topic\b/i.test(sql)) void loadOverview(this.connId, true);
        } catch (e) {
          if (!this.alive) return;
          // v0.15: underline where the statement failed (when the driver reported a position / line)
          const ran = (e as { executed?: unknown }).executed;
          const pr = prepared.info[i];
          const executed = typeof ran === "string" ? ran : sql;
          // parameterized statements: positions are mapped back to the text with its :name / ? / $n tokens
          const spot = this.isLineBased ? null : pr ? this.errorSpot(paramError(e, pr, executed), pr.original, pr.original) : this.errorSpot(e, sql, executed);
          this.addError(pr?.original ?? sql, errMsg(e), base + i + 1, total, isConnectionLost(rawMsg(e)), false, spot);
          toast(errMsg(e), "error");
          break;
        }
      }
    } finally {
      this.waitEl.remove();
      if (this.items.length > 0 && this.activeItem >= 0) this.activate(this.activeItem);
      this.setRunning(false, this.status.text.startsWith("Running") || this.status.text === "Connecting…" ? "Done" : this.status.text);
      this.host.onExecuted(this.connId);
      if (schemaTouched) this.host.onSchemaChanged(this.connId);
      // v0.17: finished while hidden: its new results may need hibernating
      if (this.alive && !this.shown) sweepResults();
    }
    if (autoCount && this.alive) await this.countRows(autoCount);
  }

  /**
   * After a connection-lost error: when Auto-reconnect is on, the console is not in a manual transaction and the
   * statement only reads, reconnects the data source's sessions silently. True when the statement may run again.
   */
  private async reconnectForRetry(sql: string, err: unknown): Promise<boolean> {
    if (!isDesktop() || !getSettings().data.autoReconnect || this.isLineBased || !this.autoCommit) return false;
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
    let res: QueryResult;
    try {
      res = await api.execute(sessionId, wrapped, size + 1);
    } catch (e) {
      // error positions refer to the wrapped statement (v0.15 error underline)
      if (e && typeof e === "object") (e as { executed?: string }).executed = wrapped;
      throw e;
    }
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
    this.syncParamBar();
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
    // v0.17: a hibernated result gets its grid back when it is shown
    const cur = this.items[i];
    if (cur?.hib && cur.hib.released === null && this.shown) this.wakeItem(cur);
    this.items.forEach((it, k) => {
      it.tab.classList.toggle("on", k === i);
      it.view.classList.toggle("hidden", k !== i);
      if (k === i) {
        const g = it.grid;
        if ((g || it.hib) && it.last) {
          this.status.rows = it.hib?.released ?? it.last.rows.length;
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
  private addFedResult(sql: string, fr: FedResult, n: number, total: number, sources: FedSource[]): void {
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
    ref.fedSources = sources;
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
        h(
          "span",
          { class: "fed-src", title: st.alias ? `${st.sourceName}${st.database ? " · " + st.database : ""} (written as ${st.alias})` : st.sourceName },
          st.sourceName,
          st.database ? h("span", { class: "fed-step-db" }, ` · ${st.database}`) : null,
        ),
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
  private addError(sql: string, msg: string, n: number, total: number, reconnect = false, fed = false, spot: { from: number; to: number; where: string } | null = null): void {
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
      spot ? this.goToErrorButton(spot, msg) : null,
      reconnect || fed ? null : this.ai.fixActions(sql, msg),
      // v0.17: the driver picks Redis / Kafka articles (command syntax, not SQL); the failed command adds its syntax
      errorHelpButton(msg, { vault: store.conns.get(this.connId)?.config.authMethod === "vault", driver: this.driver, command: this.isLineBased ? sql : undefined }),
    );
    this.addItem(total > 1 ? `Error · ${n}` : "Error", sql, view, "err");
  }

  /** v0.15: underlines the failing token in the editor and offers "Go to error" (caret there). */
  private goToErrorButton(spot: { from: number; to: number; where: string }, msg: string): HTMLElement {
    this.editor.setErrorMark(spot.from, spot.to, msg);
    const b = h("button", { class: "btn sm r-goto-err", type: "button", title: "Put the caret where the statement failed" }, icon("search", 13), `Go to error · ${spot.where}`);
    b.addEventListener("click", () => {
      const m = this.editor.errorMark;
      // the underline is gone after an edit: the old position may no longer fit
      if (!m) {
        toast("The statement was edited since — run it again to locate the error", "info");
        return;
      }
      this.editor.setErrorMark(m.from, m.to, m.message, true);
      this.editor.focus();
    });
    return b;
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
  /** v0.16: marks the result just added as run with parameters. */
  private tagParams(run: ParamRun | null | undefined): void {
    const it = this.items[this.items.length - 1];
    if (it && run) it.params = run;
    this.syncParamBar();
  }

  /** v0.16: chips of the active result's parameter values (+ Edit parameters, NULL hint). */
  private syncParamBar(): void {
    const it = this.items[this.activeItem];
    const run = it?.params ?? null;
    this.paramBarEl.hidden = !run;
    if (!run) {
      this.paramBarEl.replaceChildren();
      return;
    }
    this.paramBarEl.replaceChildren(paramBar(run, () => void this.runList([run.original])));
  }

  /** v0.16: scans for parameters and asks for their values (null = cancelled). */
  private prepareRun(stmts: string[], action: string): Promise<PreparedRun | null> {
    if (this.isLineBased) return Promise.resolve({ stmts, info: stmts.map(() => null) });
    return prepareParams(
      {
        driver: this.driver,
        view: this.editor.cmView,
        wrap: this.editorWrap,
        schemas: this.schemas(),
        defaultSchema: this.currentSchemaName(),
        memory: this.paramMemory,
        setMemory: (m) => {
          this.paramMemory = m;
          this.host.onWorkspace();
        },
        dialectFor: (sql) => (this.routeOf(sql).kind === "federated" ? "sqlite" : this.driver),
        locate: (sql) => this.locateStatement(this.editor.getText(), sql),
        action,
      },
      stmts,
    );
  }

  /**
   * v0.16: production data sources confirm writes (statement kind, table, filter, estimated rows; DROP / TRUNCATE with
   * the typed name); otherwise the "Confirm risky statements" check — never both.
   */
  private async confirmWrites(stmts: string[]): Promise<boolean> {
    // v0.17: Redis / Kafka write commands on a production source (FLUSHDB / FLUSHALL / delete topic: typed name)
    if (this.isLineBased) {
      const redis = this.isRedis;
      return confirmProdCommands({ config: store.conns.get(this.connId)?.config, where: redis ? dbLabel(this.effectiveDatabase) : null, driver: redis ? "redis" : "kafka", lines: stmts });
    }
    const writes = stmts.filter((s) => this.routeOf(s).kind === "native");
    const prod = await confirmWrites(
      {
        config: store.conns.get(this.connId)?.config,
        driver: this.driver,
        database: this.effectiveDatabase,
        sessionId: async () => {
          if (!this.autoCommit || this.typedTx || !this.session) return null;
          return this.session.sessionId;
        },
      },
      writes,
    );
    if (prod !== null) return prod;
    return this.confirmRisky(stmts);
  }

  // ---------------------------------------------------------------- v0.16 explain

  /** Explain plan (⌥⌘E): the statement at the cursor (or the selection's first) as a plan tree in the result area. */
  async explain(analyzeOverride?: boolean, buffersOverride?: boolean): Promise<void> {
    if (this.running) return;
    if (this.isLineBased) {
      toast("Explain is for SQL consoles", "info");
      return;
    }
    const r = this.editor.getSelectionOrStatementAtCursor();
    const list = r ? this.editor.splitText(r.text) : [];
    if (!list.length) {
      toast("Nothing to explain at the cursor", "info");
      return;
    }
    if (list.length > 1) toast("Explain shows one statement — explaining the first", "info");
    if (this.routeOf(list[0]).kind !== "native") {
      toast("Explain isn't available for cross-source statements", "info");
      return;
    }
    const prepared = await this.prepareRun([list[0]], "Explain");
    if (!prepared || this.running) return;
    const sql = prepared.stmts[0];
    const st = getSettings().explain;
    const analyze = analyzeOverride ?? st.analyze;
    const buffers = buffersOverride ?? st.buffers;
    if (analyzeOverride !== undefined || buffersOverride !== undefined) updateSettings((s) => (s.explain = { analyze, buffers }));
    this.editor.clearErrorMark();
    this.clearResults();
    this.bodyEl.appendChild(this.waitEl);
    this.setRunning(true, analyze ? "Explaining (ANALYZE runs the statement)…" : "Explaining…");
    try {
      if (this.needsConnect) await this.wake();
      const sess = await this.ensureSession();
      const ver = this.status.serverVersion || sess.serverVersion;
      const can = analyzeSupported(this.driver, ver);
      const out = await runExplain(sess.sessionId, this.driver, sql, { analyze: analyze && can, buffers: buffers && analyze && can, serverVersion: ver, manualTx: !this.autoCommit || this.typedTx });
      if (!this.alive) return;
      if (!out) {
        this.waitEl.remove();
        this.showEmptyIfNoResults();
        return;
      }
      const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const view = renderPlanView(out.plan, {
        analyzeSupported: can,
        buffersSupported: this.driver === "postgres",
        analyze: analyze && can,
        buffers: buffers && analyze && can,
        write: out.write,
        kind: out.kind,
        at,
        onToggle: (a, b) => void this.explain(a, b),
      });
      const item = this.addItem("Plan", sql, h("div", { class: "pv-host" }, view), "rows");
      item.params = prepared.info[0];
      this.syncParamBar();
      this.status.text = "Plan";
      this.status.rows = null;
      this.status.elapsedMs = out.plan.executionMs;
      if (analyze && !can) toast(this.driver === "mysql" ? "EXPLAIN ANALYZE needs MySQL 8.0.18 or later — showing the estimated plan" : "This data source has no EXPLAIN ANALYZE — showing the estimated plan", "info");
    } catch (e) {
      if (!this.alive) return;
      const pr = prepared.info[0];
      this.addError(pr?.original ?? list[0], `Explain failed: ${errMsg(e)}`, 1, 1);
      toast(errMsg(e), "error");
    } finally {
      this.waitEl.remove();
      if (this.alive) this.setRunning(false, this.status.text.startsWith("Explain") ? "Done" : this.status.text);
      this.host.onExecuted(this.connId);
    }
  }

  private syncBar(): void {
    const it = this.items[this.activeItem];
    // v0.17: released results have no rows to filter until Run again
    if (it?.filter && !(it.hib && it.hib.released !== null)) this.bar.show(it.filter, this.driver);
    else this.bar.hide();
    this.syncParamBar();
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
      if (this.running || !item.grid || !item.fedSources) return;
      this.setRunning(true, "Reloading across sources…");
      try {
        const fr = await api.federatedExecute(item.fedSources, item.sql, item.maxRows);
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
    if (this.running) return;
    this.setRunning(true, "Reloading…");
    try {
      // the session may have been closed after sitting idle (v0.15): reopen it
      const sess = await this.ensureSession();
      const res = await api.execute(sess.sessionId, item.sql, item.maxRows);
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
    // v0.17: production sources confirm the pending changes first (Cancel keeps them pending in the grid). Grid edits
    // always target one row by its key, so "Confirm risky statements" has nothing to ask here: never two prompts.
    if (!(await confirmProdEdits({ config: store.conns.get(this.connId)?.config, database: this.effectiveDatabase, driver: this.driver, edits }))) return;
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
    const p = this.isLineBased || this.routeOf(sql).kind !== "native" ? null : parseFilterable(sql, this.driver);
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

  /** Every SQL data source of the connection list (they all answer to their name in SQL). */
  private catalog(): CatalogSource[] {
    return store
      .list()
      .filter((e) => FED_DRIVERS.has(e.config.driver))
      .map((e) => ({ connId: e.config.id, name: e.config.name, driver: e.config.driver }));
  }

  /** How this console writes a data source in SQL (`asia32`, or `"Odd name"`). */
  private refOf(connId: string): string {
    const all = this.catalog();
    const src = all.find((c) => c.connId === connId);
    return src ? sourceRef(src, all) : aliasSlug(store.conns.get(connId)?.config.name ?? "src");
  }

  /** Names native to this console's server (its databases, the current database's schemas), lower case. */
  private nativeNames(): Set<string> {
    const e = store.conns.get(this.connId);
    const out = new Set<string>();
    for (const d of e?.databases ?? []) out.add(d.name.toLowerCase());
    for (const s of store.schemasFor(this.connId, this.database)) out.add(s.name.toLowerCase());
    return out;
  }

  private routeCtx(): RouteContext {
    return {
      ownConnId: this.connId,
      sources: this.catalog(),
      attached: this.fed.map((f) => ({ alias: f.alias, connId: f.connId })),
      ownAlias: this.fedShown || this.fed.length > 0 ? this.ownAlias : null,
      nativeNames: this.nativeNames(),
    };
  }

  /** How a statement runs here: on the session, or across sources (CONTRACT.md v0.13). */
  private routeOf(sql: string): Route {
    if (this.isLineBased || !FED_DRIVERS.has(this.driver)) return { kind: "native" };
    return routeStatement(sql, this.routeCtx());
  }

  /** The sources a federated statement runs with: own (slug + strip alias), attached, and every referenced one. */
  private fedSourcesFor(route: Route): FedSource[] {
    const uses = route.kind === "federated" ? route.uses : [];
    const name = store.conns.get(this.connId)?.config.name ?? "main";
    return fedSourcesFor(
      uses,
      { connId: this.connId, name, database: this.fedOwnDb ?? this.database },
      this.fedShown || this.fed.length > 0 ? this.ownAlias : null,
      this.fed,
      this.catalog(),
    );
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
    if (!quiet) toast(`Attached ${e.config.name} as ${a} — use ${a}.database.table in SQL`, "info");
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
    const input = h("input", { class: "fed-alias mono", type: "text", value: alias, spellcheck: false, autocomplete: "off", "aria-label": `Alias of ${name}`, title: `Extra name for ${name} in SQL (alias.database.table); its own name ${this.refOf(connId)} works too` });
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
      h("span", { class: "fed-hint" }, this.fed.length ? "Write source.database.table — any data source works by its name · results are read-only" : "Any data source works by name: source.database.table"),
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
    const refs = [{ ref: this.refOf(this.connId), db: this.effectiveDatabase }, ...this.fed.map((f) => ({ ref: this.refOf(f.connId), db: f.database ?? store.conns.get(f.connId)?.defaultDb ?? null }))];
    const ex =
      refs.length >= 2
        ? `${refs[0].ref}.${refPart(refs[0].db ?? "database")}.users JOIN ${refs[1].ref}.${refPart(refs[1].db ?? "database")}.users`
        : "asia32.postgres.users JOIN stage_mysql.shop.users";
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
        step("1", "Pick any data sources", "Every SQL data source in the explorer can be used by name — nothing to attach. Sources above are optional extra aliases."),
        step(
          "2",
          "Write dataSource.database.table",
          `e.g. ${ex} — the data source name is its name in the explorer, in lowercase with _ for spaces (or quote it)`,
        ),
        step("3", run ? `Run (${run})` : "Run", "Filters run on each source; the join runs in DataTrip. Results are read-only."),
      ),
      h("div", { class: "fed-guide-foot" }, go, h("span", null, "Uses real tables from the sources above. Runs as SQLite SQL in DataTrip.")),
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
    // One entry per data source (the own source and each attached one).
    for (const s of this.fedSources()) {
      if (ex.some((x) => x.ref === this.refOf(s.connectionId))) continue;
      const ok = await this.loadSource(s.connectionId, s.database);
      if (!this.alive) return;
      const e = store.conns.get(s.connectionId);
      if (!ok || !e) continue;
      const database = SERVER_DRIVERS.has(e.config.driver) ? s.database ?? e.defaultDb : null;
      ex.push({
        ref: this.refOf(s.connectionId),
        name: e.config.name,
        driver: e.config.driver,
        database,
        schemas: store.schemasFor(s.connectionId, s.database),
        defaultSchema: store.defaultSchemaFor(s.connectionId, s.database),
      });
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

  /**
   * Completion of `source.` → its databases (SQLite: also its tables; an attached alias: also the schemas of its
   * database, the older form), `source.db.` → the tables of the default schema + the schemas (PG / SQL Server; a
   * schema of the default database instead of a database → its tables), `source.db.schema.` → tables. The source
   * is connected in the explorer and the database introspected lazily.
   */
  private fedComplete(path: { text: string; quoted: boolean }[]): FedCompletion[] | null | Promise<FedCompletion[] | null> {
    if (this.isLineBased || !FED_DRIVERS.has(this.driver) || path.length < 1 || path.length > 3) return null;
    const r = resolveSource(path[0], this.routeCtx());
    if (!r || r.kind !== "source") return null;
    const connId = r.connId;
    const first = store.conns.get(connId);
    if (!first || !FED_DRIVERS.has(first.config.driver)) return null;
    const driver = first.config.driver;
    // Database an alias of the Sources strip reads from (older `alias.schema.table` form).
    const aliasDb =
      r.via === "attached" ? (this.fed.find((f) => f.connId === connId && f.alias.toLowerCase() === path[0].text.toLowerCase())?.database ?? null) : r.via === "ownAlias" || connId === this.connId ? (this.fedOwnDb ?? this.database) : null;
    const dbNamed = (x: string): string | null => store.conns.get(connId)?.databases.find((d) => d.name.toLowerCase() === x.toLowerCase())?.name ?? null;
    /** The database whose introspection the completion needs (null = the connection's default). */
    const needDb = (): string | null => {
      if (driver === "sqlite") return null;
      if (path.length === 1) return aliasDb;
      return dbNamed(path[1].text) ?? aliasDb;
    };
    const tableItems = (schemaName: string | null, db: string | null): FedCompletion[] => {
      const schemas = store.schemasFor(connId, db);
      const pick = schemaName === null ? schemas : schemas.filter((x) => x.name.toLowerCase() === schemaName.toLowerCase());
      return pick.flatMap((sc) =>
        sc.tables.map((t) => ({ label: t.name, apply: refPart(t.name), type: t.kind === "table" ? "type" : "class", detail: t.kind === "table" ? "table" : t.kind === "view" ? "view" : "materialized view" })),
      );
    };
    const schemaItems = (db: string | null): FedCompletion[] => {
      const def = store.defaultSchemaFor(connId, db);
      return store.schemasFor(connId, db).map((x) => ({ label: x.name, apply: refPart(x.name), type: "namespace", detail: x.name === def ? "schema · default" : "schema", boost: x.name === def ? 1 : 0 }));
    };
    const build = (): FedCompletion[] | null => {
      const e = store.conns.get(connId);
      if (!e) return null;
      const defSchema = defaultSchemaOf(driver);
      if (path.length === 1) {
        const dbs = [...e.databases].sort((a, b) => Number(a.isSystem) - Number(b.isSystem));
        const out: FedCompletion[] = dbs.map((d) => ({
          label: d.name,
          apply: refPart(d.name),
          type: "namespace",
          detail: d.name === e.defaultDb ? "database · default" : d.isSystem ? "database · system" : "database",
          boost: d.name === e.defaultDb ? 2 : d.isSystem ? -1 : 1,
        }));
        if (driver === "sqlite") out.push(...tableItems(null, null));
        else if (r.via === "attached" || r.via === "ownAlias") out.push(...schemaItems(aliasDb));
        return out;
      }
      if (driver === "sqlite") return path.length === 2 ? tableItems(null, null) : null;
      const db = dbNamed(path[1].text);
      if (path.length === 2) {
        if (db === null) return tableItems(path[1].text, aliasDb); // source.schema. (older form)
        if (driver === "mysql") return tableItems(null, db);
        return [...tableItems(defSchema, db), ...schemaItems(db)];
      }
      return db === null || driver === "mysql" ? null : tableItems(path[2].text, db);
    };
    const ready = (): boolean => {
      const e = store.conns.get(connId);
      if (e?.status !== "connected") return false;
      const db = needDb();
      return db === null || db === e.defaultDb || e.dbs.get(db)?.status === "ready";
    };
    if (ready()) return build();
    return (async (): Promise<FedCompletion[] | null> => {
      if (!(await this.host.ensureConnected(connId).catch(() => false)) || !this.alive) return null;
      const db = needDb();
      if (db !== null && db !== store.conns.get(connId)?.defaultDb) await store.ensureDb(connId, db);
      return this.alive ? build() : null;
    })();
  }

  /**
   * Table references of 3+ parts whose first part is no data source (slug, quoted name, attached alias), no database
   * and no schema of this console's server: underlined ("No data source named 'x'"). A slug two data sources share
   * is underlined too. Only once the own server's databases are known (no false marks on db.schema.table).
   */
  private fedMarks(doc: string): FedMark[] {
    if (this.isLineBased || !FED_DRIVERS.has(this.driver)) return [];
    if (store.conns.get(this.connId)?.status !== "connected") return [];
    const ctx = this.routeCtx();
    const out: FedMark[] = [];
    for (const ref of findTableRefs(doc)) {
      if (out.length >= 200) break;
      if (ref.parts.length < 3) continue;
      const first = ref.parts[0];
      const r = resolveSource(first, ctx);
      if (r?.kind === "ambiguous") out.push({ from: first.from, to: first.to, key: first.text, message: r.message });
      else if (!r && !ctx.nativeNames.has(first.text.toLowerCase())) out.push({ from: first.from, to: first.to, key: first.text });
    }
    return out;
  }

  private fedTip(m: FedMark): HTMLElement {
    if (m.message) return h("div", { class: "fed-tip" }, h("div", null, m.message));
    const box = h(
      "div",
      { class: "fed-tip" },
      h("div", null, "No data source named ", h("b", { class: "mono" }, `'${m.key}'`), "."),
      h("div", { class: "dim" }, "Write dataSource.database.table — the data source's name in the explorer, in lowercase with _ for spaces (or quote it)."),
    );
    const choose = h("button", { class: "fed-tip-alt", type: "button" }, `Use a data source as ${m.key}…`);
    choose.addEventListener("click", () => this.openAttachMenu(choose, m.key));
    box.appendChild(h("div", { class: "fed-tip-actions" }, choose));
    return box;
  }

  /**
   * What dropping that table at `pos` inserts: `schema.table` for the console's own source (its
   * `source.database.table` while the statement there runs across sources), `source.database.table` for another
   * SQL source (nothing to attach: it resolves by name).
   */
  private dropPlan(d: TableDrag, pos: number): { name: string; text: string; other: boolean } | null {
    const e = store.conns.get(d.connId);
    if (!e || this.isLineBased) return null;
    if (d.connId === this.connId) {
      const stmt = statementAt(this.editor.getText(), pos)?.text ?? "";
      const fedHere = this.fedActive || this.routeOf(stmt).kind === "federated";
      const text = fedHere ? tableRef(this.refOf(this.connId), e.config.driver, d.database ?? this.effectiveDatabase, d.schema, d.table) : qualifiedName(this.driver, d.schema, d.table);
      return { name: e.config.name, text, other: false };
    }
    if (!FED_DRIVERS.has(e.config.driver) || !FED_DRIVERS.has(this.driver)) return null;
    return { name: e.config.name, text: tableRef(this.refOf(d.connId), e.config.driver, d.database ?? e.defaultDb, d.schema, d.table), other: true };
  }

  private showDropHint(): void {
    const d = tableDrag();
    const plan = d ? this.dropPlan(d, this.editor.cursor) : null;
    clear(this.dropEl);
    if (!plan) {
      this.hideDropHint();
      return;
    }
    this.dropEl.append(
      h(
        "div",
        { class: "fed-drop-card" },
        h("span", { class: "dim" }, "Drop to insert "),
        h("span", { class: "mono hl" }, plan.text),
        plan.other ? h("br") : null,
        plan.other ? h("span", { class: "dim" }, `from ${plan.name} · runs across sources`) : null,
      ),
    );
    this.dropEl.hidden = false;
    this.editorWrap.classList.add("drop-on");
    this.editorWrap.classList.toggle("drop-attach", plan.other);
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
    const plan = this.dropPlan(d, pos);
    if (!plan) return;
    this.hideGuide();
    this.editor.insertAt(pos, plan.text);
  }

  // ---------------------------------------------------------------- layout

  private bindSplitter(sp: HTMLElement): void {
    const saved = Number(preferences.getItem("dt.editorH"));
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
        preferences.setItem("dt.editorH", String(Math.round(this.editorWrap.getBoundingClientRect().height)));
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

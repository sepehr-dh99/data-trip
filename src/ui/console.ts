// A console tab: SQL editor on top, results below (grid / message / error).
// Its run controls (Run / Cancel, Run all, transaction pill) are mounted by the shell into the
// floating capsule while this console is active.
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Driver, QueryResult, RowEdit, SchemaNode, SessionInfo } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { DRIVER_LABELS } from "../types";
import { confirmDialog } from "./confirm";
import { showMenu } from "./menu";
import { SqlEditor } from "./editor";
import { kafkaNames, loadOverview } from "./kafka";
import { ResultGrid } from "./grid";
import { store } from "./state";
import { buildCompletionSchema, buildFilteredSql, detectEditContext, nextOrder, orderMarks, parseFilterable, quoteIdent } from "./sqlutil";
import { FilterBar } from "./filterBar";
import type { FilterState } from "./filterBar";
import { toast } from "./toast";
import type { TabPane } from "./tabs";

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

  constructor(
    public connId: string,
    title: string,
    private host: ConsoleHost,
    initialSql = "",
    /** Database this console is bound to; null = the connection's default. */
    public database: string | null = null,
    /** Schema that completion defaults to (set when opened from a schema node). */
    public schema: string | null = null,
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
    this.controls = h("div", { class: "cap-controls" }, this.btnRun, this.btnStop, this.btnRunAll, this.btnTx);
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
    });
    this.tabsEl = h("div", { class: "r-tabs", role: "tablist", "aria-label": "Results" });
    this.bodyEl = h("div", { class: "r-body" });
    const splitter = h("div", { class: "c-split", role: "separator", "aria-orientation": "horizontal", "aria-label": "Resize editor", title: "Drag to resize" });
    this.bindSplitter(splitter);
    this.bar = new FilterBar(driver, { onApply: (where, order) => this.applyBar(where, order) });
    const results = h("div", { class: "c-results" }, this.tabsEl, this.bar.el, this.bodyEl);
    this.el = h("div", { class: "console" }, this.editorWrap, splitter, results);
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
    return this.database ?? store.conns.get(this.connId)?.defaultDb ?? null;
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
    this.schema = null;
    this.schemaExplicit = false;
    this.syncTxUi();
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
    this.schema = null;
    this.schemaExplicit = false;
    const e = store.conns.get(connId);
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

  private async runCurrent(): Promise<void> {
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

  private async runAll(): Promise<void> {
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

  private async runList(stmts: string[]): Promise<void> {
    if (this.running || stmts.length === 0) return;
    this.setRunning(true, "Connecting…");
    this.clearResults();
    this.bodyEl.appendChild(this.waitEl);
    let schemaTouched = false;
    try {
      const sess = await this.ensureSession();
      for (let i = 0; i < stmts.length; i++) {
        const sql = stmts[i];
        this.setRunning(true, stmts.length > 1 ? `Running ${i + 1} of ${stmts.length}…` : "Running…");
        try {
          const res = await api.execute(sess.sessionId, sql, DEFAULT_MAX_ROWS);
          this.addResult(sql, res, DEFAULT_MAX_ROWS, i + 1, stmts.length);
          if (!this.isLineBased && /^\s*(create|alter|drop|rename)\b/i.test(sql)) schemaTouched = true;
          if (this.isKafka && /^\s*(create|delete)\s+topic\b/i.test(sql)) void loadOverview(this.connId, true);
        } catch (e) {
          this.addError(sql, errMsg(e), i + 1, stmts.length);
          toast(errMsg(e), "error");
          break;
        }
      }
    } catch (e) {
      this.addError("", `Could not open a session: ${errMsg(e)}`, 1, 1);
      toast(errMsg(e), "error");
    } finally {
      this.setRunning(false, this.status.text.startsWith("Running") || this.status.text === "Connecting…" ? "Done" : this.status.text);
      this.host.onExecuted(this.connId);
      if (schemaTouched) this.host.onSchemaChanged(this.connId);
    }
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
    return new ResultGrid({
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
      onExport: () => void this.exportItem(item()),
      onHeaderSort: (col, append) => this.headerSort(item(), col, append),
    });
  }

  private addResult(sql: string, res: QueryResult, maxRows: number, n: number, total: number): void {
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
      return;
    }
    let ref!: ResultItem;
    const grid = this.makeGrid(() => ref);
    this.applyGrid(grid, res, maxRows);
    ref = this.addItem(total > 1 ? `Result ${n}` : "Result", sql, grid.el, "rows");
    ref.grid = grid;
    ref.last = res;
    ref.maxRows = maxRows;
    this.initFilter(ref);
    this.syncBar();
    const label = ref.tab.querySelector(".r-label");
    if (label) label.textContent = `${total > 1 ? `Result ${n}` : "Result"} · ${res.rows.length.toLocaleString()}${res.truncated ? "+" : ""}`;
    this.status.rows = res.rows.length;
    this.status.affected = res.rowsAffected;
    this.status.text = "Done";
    this.host.onStatus(this);
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
    grid.setMeta(`${res.elapsedMs.toLocaleString()} ms${this.serverLabel() ? " · " + this.serverLabel() : ""}`);
  }

  /** "PostgreSQL 16.2" — shown in the result pill. */
  private serverLabel(): string {
    const e = store.conns.get(this.connId);
    if (!e) return "";
    const name = DRIVER_LABELS[e.config.driver].split(" / ")[0];
    const ver = this.status.serverVersion || e.session?.serverVersion || "";
    return ver ? `${name} ${ver}` : name;
  }

  private lastSql(grid: ResultGrid): string {
    return this.items.find((i) => i.grid === grid)?.sql ?? "";
  }

  private addError(sql: string, msg: string, n: number, total: number): void {
    this.status.text = "Error";
    this.status.rows = null;
    this.status.affected = null;
    const view = h(
      "div",
      { class: "r-message err", role: "alert" },
      icon("alert", 20),
      h("div", { class: "r-message-title" }, this.isLineBased ? "Command failed" : "Statement failed"),
      h("div", { class: "r-error-text" }, msg),
      sql ? h("pre", { class: "r-sql" }, sql) : null,
    );
    this.addItem(total > 1 ? `Error · ${n}` : "Error", sql, view, "err");
  }

  // ---------------------------------------------------------------- filter bar

  private get driver(): Driver {
    return store.conns.get(this.connId)?.config.driver ?? "postgres";
  }

  /** Marks the result as filterable when its statement is a simple single-table SELECT. */
  private initFilter(item: ResultItem): void {
    const p = this.isLineBased ? null : parseFilterable(item.sql, this.driver);
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
      const res = await api.execute(sess.sessionId, sql, item.maxRows);
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
      if (item.grid) {
        this.applyGrid(item.grid, res, item.maxRows);
        item.grid.setServerSort(orderMarks(f.order, this.driver));
      }
      const label = item.tab.querySelector(".r-label");
      if (label) label.textContent = `${(label.textContent ?? "Result").split(" · ")[0]} · ${res.rows.length.toLocaleString()}${res.truncated ? "+" : ""}`;
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
  }

  private async rerun(item: ResultItem): Promise<void> {
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

  private async exportItem(item: ResultItem): Promise<void> {
    if (!this.session) return;
    try {
      const path = await save({
        title: "Export result",
        defaultPath: "result.csv",
        filters: [
          { name: "CSV", extensions: ["csv"] },
          { name: "JSON", extensions: ["json"] },
        ],
      });
      if (!path) return;
      const fmt = /\.json$/i.test(path) ? "json" : "csv";
      this.status.text = "Exporting…";
      this.host.onStatus(this);
      const n = await api.exportQuery(this.session.sessionId, item.sql, fmt, path);
      toast(`Exported ${n.toLocaleString()} rows to ${path}`, "ok");
    } catch (e) {
      toast(`Export failed: ${errMsg(e)}`, "error");
    } finally {
      this.status.text = "Done";
      this.host.onStatus(this);
    }
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

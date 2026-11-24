// A console tab: SQL editor on top, result sub-tabs (grid / message / error) below.
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { QueryResult, RowEdit, SessionInfo } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { SqlEditor } from "./editor";
import { ResultGrid } from "./grid";
import { store } from "./state";
import { buildCompletionSchema, connColor, detectEditContext } from "./sqlutil";
import { toast } from "./toast";

const DEFAULT_MAX_ROWS = 500;

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
}

interface ResultItem {
  tab: HTMLElement;
  view: HTMLElement;
  sql: string;
  maxRows: number;
  grid?: ResultGrid;
  last?: QueryResult;
}

let counter = 0;

export class ConsolePane {
  readonly el: HTMLElement;
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
  private btnRun: HTMLButtonElement;
  private btnRunAll: HTMLButtonElement;
  private btnStop: HTMLButtonElement;
  private btnCommit: HTMLButtonElement;
  private btnRollback: HTMLButtonElement;
  private segAuto: HTMLButtonElement;
  private segManual: HTMLButtonElement;
  private alive = true;

  constructor(
    readonly connId: string,
    title: string,
    private host: ConsoleHost,
    initialSql = "",
  ) {
    this.title = title;
    const entry = store.conns.get(connId);
    const driver = entry?.config.driver ?? "postgres";
    this.status = { rows: null, elapsedMs: null, affected: null, serverVersion: entry?.session?.serverVersion ?? "", autoCommit: true, running: false, text: "Ready" };

    const mk = (ic: string, label: string, tip: string, fn: () => void, cls = ""): HTMLButtonElement =>
      h("button", { class: "btn " + cls, type: "button", title: tip, onclick: fn }, icon(ic, 15), h("span", null, label));
    const isMac = /Mac/.test(navigator.userAgent);
    const mod = isMac ? "⌘" : "Ctrl+";
    this.btnRun = mk("play", "Run", `Run selection or statement at cursor (${mod}Enter)`, () => void this.runCurrent(), "primary");
    this.btnRunAll = mk("playAll", "Run all", `Run all statements (${mod}Shift+Enter)`, () => void this.runAll());
    this.btnStop = mk("stop", "Cancel", "Cancel running statement", () => void this.cancel(), "danger");
    this.btnStop.disabled = true;
    this.segAuto = h("button", { class: "seg-btn on", type: "button", onclick: () => void this.setAuto(true) }, "Auto");
    this.segManual = h("button", { class: "seg-btn", type: "button", onclick: () => void this.setAuto(false) }, "Manual");
    this.btnCommit = mk("check", "Commit", "Commit transaction", () => void this.endTx(true));
    this.btnRollback = mk("undo", "Rollback", "Roll back transaction", () => void this.endTx(false));
    this.btnCommit.disabled = this.btnRollback.disabled = true;

    const cfg = entry?.config;
    const toolbar = h(
      "div",
      { class: "c-toolbar" },
      this.btnRun,
      this.btnRunAll,
      this.btnStop,
      h("span", { class: "vsep" }),
      h("div", { class: "seg small", role: "radiogroup", "aria-label": "Transaction mode", title: "Transaction mode" }, this.segAuto, this.segManual),
      this.btnCommit,
      this.btnRollback,
      h("div", { class: "spacer" }),
      cfg
        ? h("span", { class: "conn-pill", style: `--c:${connColor(cfg)}` }, h("span", { class: "conn-dot connected", style: `--c:${connColor(cfg)}` }), cfg.name)
        : null,
    );

    this.editorWrap = h("div", { class: "c-editor" });
    this.editor = new SqlEditor(this.editorWrap, {
      doc: initialSql,
      driver,
      onRun: () => void this.runCurrent(),
      onRunAll: () => void this.runAll(),
    });
    this.tabsEl = h("div", { class: "r-tabs", role: "tablist" });
    this.bodyEl = h("div", { class: "r-body" });
    const splitter = h("div", { class: "c-split", role: "separator", "aria-orientation": "horizontal", title: "Drag to resize" });
    this.bindSplitter(splitter);
    const results = h("div", { class: "c-results" }, this.tabsEl, this.bodyEl);
    this.el = h("div", { class: "console" }, toolbar, this.editorWrap, splitter, results);
    this.showEmptyResults();
    this.updateSchema();
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
    await this.runList([sql.trim().replace(/;\s*$/, "")]);
  }

  updateSchema(): void {
    const e = store.conns.get(this.connId);
    if (!e) return;
    const def = e.session?.defaultSchema ?? this.session?.defaultSchema ?? null;
    this.editor.setSchema(buildCompletionSchema(e.schemas, def), e.config.driver);
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
      this.sessionPromise = api.openSession(this.connId).then(
        async (s) => {
          if (!this.alive) {
            // The tab was closed while the session was opening: don't leak it.
            void api.closeSession(s.sessionId).catch(() => undefined);
            throw new Error("Console was closed");
          }
          this.session = s;
          this.status.serverVersion = s.serverVersion;
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
    this.segAuto.classList.toggle("on", this.autoCommit);
    this.segManual.classList.toggle("on", !this.autoCommit);
    this.btnCommit.disabled = this.btnRollback.disabled = this.autoCommit || this.running;
    this.status.autoCommit = this.autoCommit;
    this.host.onStatus(this);
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
    this.btnCommit.disabled = this.btnRollback.disabled = this.autoCommit || on;
    this.el.classList.toggle("running", on);
    this.host.onStatus(this);
  }

  private async runList(stmts: string[]): Promise<void> {
    if (this.running || stmts.length === 0) return;
    this.setRunning(true, "Connecting…");
    this.clearResults();
    let schemaTouched = false;
    try {
      const sess = await this.ensureSession();
      for (let i = 0; i < stmts.length; i++) {
        const sql = stmts[i];
        this.setRunning(true, stmts.length > 1 ? `Running ${i + 1} of ${stmts.length}…` : "Running…");
        try {
          const res = await api.execute(sess.sessionId, sql, DEFAULT_MAX_ROWS);
          this.addResult(sql, res, DEFAULT_MAX_ROWS, i + 1, stmts.length);
          if (/^\s*(create|alter|drop|rename)\b/i.test(sql)) schemaTouched = true;
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
  }

  private showEmptyResults(): void {
    this.bodyEl.appendChild(
      h("div", { class: "r-empty" }, icon("sparkle", 22), h("div", null, "Run a statement to see results here."), h("div", { class: "hint" }, "Ctrl/Cmd+Enter runs the statement at the cursor · Ctrl/Cmd+Shift+Enter runs everything")),
    );
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
    this.tabsEl.appendChild(tab);
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
    const label = ref.tab.querySelector(".r-label");
    if (label) label.textContent = `${total > 1 ? `Result ${n}` : "Result"} · ${res.rows.length.toLocaleString()}${res.truncated ? "+" : ""}`;
    this.status.rows = res.rows.length;
    this.status.affected = res.rowsAffected;
    this.status.text = "Done";
    this.host.onStatus(this);
  }

  private applyGrid(grid: ResultGrid, res: QueryResult, maxRows: number): void {
    const e = store.conns.get(this.connId);
    const def = this.session?.defaultSchema ?? e?.session?.defaultSchema ?? null;
    const det = detectEditContext(res.statement || "", res.columns, e?.schemas ?? [], def, e?.config.readOnly === true);
    // Prefer the statement we sent when the backend echoes nothing useful.
    const det2 = det.ctx || !e ? det : detectEditContext(this.lastSql(grid), res.columns, e.schemas, def, e.config.readOnly === true);
    grid.setResult(res, det2.ctx, det2.reason, maxRows);
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
      h("div", { class: "r-message-title" }, "Statement failed"),
      h("div", { class: "r-error-text" }, msg),
      sql ? h("pre", { class: "r-sql" }, sql) : null,
    );
    this.addItem(total > 1 ? `Error · ${n}` : "Error", sql, view, "err");
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
    this.editorWrap.style.height = (saved >= 80 ? saved : 190) + "px";
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

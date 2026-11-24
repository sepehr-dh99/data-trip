// Application shell: toolbar, explorer, console tabs, history, status bar, shortcuts.
import { api } from "../api";
import { DRIVER_LABELS } from "../types";
import type { ConnectionConfig } from "../types";
import { confirmDialog } from "./confirm";
import { ConsolePane } from "./console";
import type { ConsoleHost } from "./console";
import { openConnectionDialog } from "./connDialog";
import { openImportDialog } from "./importDialog";
import { brandMark, clear, copyText, errMsg, h, icon } from "./dom";
import { Explorer } from "./explorer";
import { HistoryPanel } from "./history";
import { store } from "./state";
import { connColor } from "./sqlutil";
import { toast } from "./toast";

const IS_MAC = /Mac/.test(navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

export class App {
  private tabs: ConsolePane[] = [];
  private active: ConsolePane | null = null;
  private explorer: Explorer;
  private history: HistoryPanel;
  private tabsEl = h("div", { class: "tabs", role: "tablist" });
  private stack = h("div", { class: "stack" });
  private empty = h("div", { class: "empty-state" });
  private statusEl = h("footer", { class: "statusbar glass-panel" });
  private sidebarW = Number(localStorage.getItem("dt.sidebarW")) || 280;
  private selectedConn: string | null = null;
  private counts = new Map<string, number>();
  private prevStatus = new Map<string, string>();
  private btnHistory!: HTMLButtonElement;
  private main!: HTMLElement;
  private sidebarHidden = false;

  constructor(private root: HTMLElement) {
    this.explorer = new Explorer({
      openConsole: (id, o) => void this.openConsole(id, o),
      addConnection: () => this.addConnection(),
      importDataGrip: () => this.importDataGrip(),
      editConnection: (id) => this.editConnection(id),
      deleteConnection: (id) => void this.deleteConnection(id),
      copy: (t) => void copyText(t).then(() => toast("Copied to clipboard", "ok")),
      onSelect: (id) => {
        this.selectedConn = id;
      },
    });
    this.history = new HistoryPanel({
      insert: (sql) => {
        if (!this.active) return toast("Open a console first", "info");
        this.active.insertSql(sql);
      },
      run: (sql) => {
        if (!this.active) return toast("Open a console first", "info");
        // The first click of the double-click already inserted the SQL.
        void this.active.runSqlText(sql);
      },
    });
    this.build();
    store.subscribe(() => this.onStoreChange());
    store.onSchema((id) => this.tabs.filter((t) => t.connId === id).forEach((t) => t.updateSchema()));
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("paste", (e) => this.onPaste(e));
  }

  private importDataGrip(initialText = ""): void {
    if (document.querySelector(".import-dialog")) return;
    openImportDialog((n) => {
      if (n > 0) this.renderTabs();
      this.renderEmpty();
    }, initialText);
  }

  /** Cmd/Ctrl+V outside editable elements with DataGrip settings on the clipboard opens the import dialog. */
  private onPaste(e: ClipboardEvent): void {
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest(".cm-editor"))) return;
    if (document.querySelector(".overlay")) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text.includes("#DataSourceSettings#") || text.includes("<data-source")) {
      e.preventDefault();
      this.importDataGrip(text);
    }
  }

  async start(): Promise<void> {
    try {
      await store.load();
    } catch (e) {
      toast(`Could not load connections: ${errMsg(e)}`, "error");
    }
    this.renderEmpty();
    this.updateStatus();
  }

  // ------------------------------------------------------------------ layout

  private build(): void {
    const drag = { "data-tauri-drag-region": "" };
    this.btnHistory = h("button", { class: "tool-btn", type: "button", title: `Query history (${MOD}Shift+H)`, "aria-label": "Toggle history", onclick: () => this.toggleHistory() }, icon("clock", 16), h("span", null, "History"));
    const toolbar = h(
      "header",
      { class: "toolbar glass-panel", ...drag },
      h("div", { class: "brand", ...drag }, brandMark(22), h("span", { class: "brand-name", ...drag }, "DataTrip")),
      h("button", { class: "tool-btn icon-only", type: "button", title: `Toggle sidebar (${MOD}B)`, "aria-label": "Toggle sidebar", onclick: () => this.toggleSidebar() }, icon("sidebar", 17)),
      h("div", { class: "spacer", ...drag }),
      h("button", { class: "tool-btn", type: "button", title: "New connection", onclick: () => this.addConnection() }, icon("plus", 16), h("span", null, "Connection")),
      h("button", { class: "tool-btn accent", type: "button", title: `New console (${MOD}N)`, onclick: () => void this.newConsole() }, icon("terminal", 16), h("span", null, "New console")),
      this.btnHistory,
    );

    const tabbar = h(
      "div",
      { class: "tabbar" },
      this.tabsEl,
      h("button", { class: "icon-btn tab-add", type: "button", title: `New console (${MOD}N)`, "aria-label": "New console", onclick: () => void this.newConsole() }, icon("plus", 16)),
    );
    const workspace = h("section", { class: "panel workspace", "aria-label": "Workspace" }, tabbar, h("div", { class: "ws-body" }, this.stack, this.empty));

    const resizer = h("div", { class: "resizer", role: "separator", "aria-orientation": "vertical", title: "Drag to resize" });
    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.sidebarW;
      const move = (ev: PointerEvent): void => {
        this.sidebarW = Math.max(200, Math.min(520, startW + ev.clientX - startX));
        this.applySidebar();
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing-col");
        localStorage.setItem("dt.sidebarW", String(this.sidebarW));
      };
      document.body.classList.add("resizing-col");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    this.main = h("main", { class: "main" }, this.explorer.el, resizer, workspace, this.history.el);
    this.applySidebar();
    clear(this.root);
    this.root.append(toolbar, this.main, this.statusEl);
    this.explorer.render();
  }

  private applySidebar(): void {
    this.main.style.setProperty("--sidebar-w", this.sidebarW + "px");
    this.main.classList.toggle("no-sidebar", this.sidebarHidden);
  }

  private toggleSidebar(): void {
    this.sidebarHidden = !this.sidebarHidden;
    this.applySidebar();
  }

  private toggleHistory(): void {
    const open = this.history.toggle();
    this.btnHistory.classList.toggle("on", open);
    this.syncHistoryConn();
  }

  private syncHistoryConn(): void {
    const id = this.active?.connId ?? this.selectedConn;
    const e = id ? store.conns.get(id) : undefined;
    this.history.setConnection(id ?? null, e?.config.name ?? "");
  }

  // ------------------------------------------------------------------ consoles

  private host: ConsoleHost = {
    onExecuted: () => void this.history.refresh(),
    onStatus: (c) => {
      if (c === this.active) this.updateStatus();
    },
    onSchemaChanged: (id) => void store.refresh(id).catch(() => undefined),
  };

  private async newConsole(): Promise<void> {
    const id =
      this.active?.connId ??
      this.selectedConn ??
      store.list().find((e) => e.status === "connected")?.config.id ??
      store.list()[0]?.config.id;
    if (!id) {
      this.addConnection();
      return;
    }
    await this.openConsole(id);
  }

  private async openConsole(connId: string, opts: { sql?: string; run?: boolean; title?: string } = {}): Promise<void> {
    const entry = store.conns.get(connId);
    if (!entry) return;
    if (entry.status !== "connected") {
      try {
        await this.explorer.connect(connId);
      } catch {
        return;
      }
      if (store.conns.get(connId)?.status !== "connected") return;
    }
    const n = (this.counts.get(connId) ?? 0) + 1;
    this.counts.set(connId, n);
    const title = opts.title ?? (n === 1 ? "console" : `console ${n}`);
    const pane = new ConsolePane(connId, title, this.host, opts.sql ?? "");
    this.tabs.push(pane);
    this.stack.appendChild(pane.el);
    this.activate(pane);
    if (opts.run && opts.sql) void pane.runSqlText(opts.sql);
  }

  private activate(pane: ConsolePane | null): void {
    this.active = pane;
    for (const t of this.tabs) t.el.classList.toggle("hidden", t !== pane);
    this.renderTabs();
    this.renderEmpty();
    this.updateStatus();
    if (pane) {
      this.selectedConn = pane.connId;
      pane.focus();
    }
    this.syncHistoryConn();
  }

  private renderTabs(): void {
    clear(this.tabsEl);
    for (const t of this.tabs) {
      const e = store.conns.get(t.connId);
      const color = e ? connColor(e.config) : "var(--accent)";
      const close = h("button", { class: "tab-close", type: "button", title: `Close (${MOD}W)`, "aria-label": "Close tab", onclick: (ev: Event) => (ev.stopPropagation(), void this.closeTab(t)) }, icon("x", 12));
      const tab = h(
        "div",
        { class: "tab" + (t === this.active ? " active" : ""), role: "tab", style: `--c:${color}`, title: `${t.title} — ${e?.config.name ?? ""}`, "aria-selected": String(t === this.active) },
        h("span", { class: "tab-dot" }),
        h("span", { class: "tab-title" }, t.title),
        h("span", { class: "tab-sub" }, e?.config.name ?? ""),
        close,
      );
      tab.addEventListener("click", () => this.activate(t));
      tab.addEventListener("auxclick", (ev) => {
        if (ev.button === 1) void this.closeTab(t);
      });
      this.tabsEl.appendChild(tab);
    }
  }

  private async closeTab(t: ConsolePane): Promise<void> {
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    t.el.remove();
    void t.dispose();
    if (this.active === t) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)] ?? null);
    else this.renderTabs();
    this.renderEmpty();
  }

  // ------------------------------------------------------------------ connections

  private addConnection(): void {
    openConnectionDialog(null, async (saved) => {
      await store.load();
      this.selectedConn = saved.id;
      toast(`Saved “${saved.name}”`, "ok");
      void this.explorer.connect(saved.id).catch(() => undefined);
    });
  }

  private editConnection(id: string): void {
    const e = store.conns.get(id);
    if (!e) return;
    openConnectionDialog(e.config, async (saved: ConnectionConfig) => {
      const wasConnected = e.status === "connected";
      if (wasConnected) await store.disconnect(saved.id);
      await store.load();
      toast(wasConnected ? "Saved. Reconnect to apply changes." : "Saved", "ok");
      this.renderTabs();
    });
  }

  private async deleteConnection(id: string): Promise<void> {
    const e = store.conns.get(id);
    if (!e) return;
    const ok = await confirmDialog("Delete connection?", `“${e.config.name}” and its saved password will be removed. Open consoles for it will be closed.`, "Delete", true);
    if (!ok) return;
    try {
      for (const t of this.tabs.filter((x) => x.connId === id)) await this.closeTab(t);
      await store.disconnect(id);
      await api.deleteConnection(id);
      await store.load();
      if (this.selectedConn === id) this.selectedConn = null;
      this.renderEmpty();
    } catch (err) {
      toast(errMsg(err), "error");
    }
  }

  private onStoreChange(): void {
    for (const e of store.list()) {
      const prev = this.prevStatus.get(e.config.id);
      if (prev === "connected" && e.status !== "connected") {
        this.tabs.filter((t) => t.connId === e.config.id).forEach((t) => t.dropSession());
      }
      this.prevStatus.set(e.config.id, e.status);
    }
    this.renderTabs();
    this.renderEmpty();
    this.updateStatus();
  }

  // ------------------------------------------------------------------ empty state & status

  private renderEmpty(): void {
    const show = this.tabs.length === 0;
    this.empty.classList.toggle("hidden", !show);
    this.stack.classList.toggle("hidden", show);
    if (!show) return;
    clear(this.empty);
    const hasConns = store.list().length > 0;
    this.empty.append(
      h(
        "div",
        { class: "empty-card" },
        h("div", { class: "empty-art" }, brandMark(84)),
        h("h2", null, hasConns ? "Pick a table or open a console" : "Add your first connection"),
        h(
          "p",
          null,
          hasConns
            ? "Double-click a table in the explorer to browse its rows, or start a blank console and write some SQL."
            : "DataTrip works with PostgreSQL, MySQL / MariaDB, SQLite and SQL Server. Credentials stay in your system keychain.",
        ),
        h(
          "div",
          { class: "empty-actions" },
          hasConns
            ? h("button", { class: "btn primary lg", type: "button", onclick: () => void this.newConsole() }, icon("terminal", 16), "New console")
            : h("button", { class: "btn primary lg", type: "button", onclick: () => this.addConnection() }, icon("plus", 16), "Add connection"),
          hasConns ? null : h("button", { class: "btn lg", type: "button", onclick: () => this.importDataGrip() }, icon("download", 16), "Import from DataGrip…"),
        ),
        h(
          "div",
          { class: "kbd-list" },
          h("span", null, h("kbd", null, MOD + "↵"), " run statement"),
          h("span", null, h("kbd", null, MOD + "⇧↵"), " run all"),
          h("span", null, h("kbd", null, MOD + "N"), " new console"),
          h("span", null, h("kbd", null, MOD + "⇧H"), " history"),
        ),
      ),
    );
  }

  private updateStatus(): void {
    clear(this.statusEl);
    const c = this.active;
    const e = c ? store.conns.get(c.connId) : undefined;
    const item = (label: string, value: string, cls = ""): HTMLElement =>
      h("span", { class: "st-item " + cls }, h("span", { class: "st-label" }, label), h("span", { class: "st-value" }, value));
    if (!c || !e) {
      const n = store.list().filter((x) => x.status === "connected").length;
      this.statusEl.append(h("span", { class: "st-item" }, h("span", { class: "st-dot" }), `${n} connected`), h("div", { class: "spacer" }), h("span", { class: "st-item muted" }, "DataTrip"));
      return;
    }
    const s = c.status;
    const nodes: Array<HTMLElement | null> = [
      h("span", { class: "st-item", style: `--c:${connColor(e.config)}` }, h("span", { class: "conn-dot connected", style: `--c:${connColor(e.config)}` }), e.config.name),
      h("span", { class: "st-item muted" }, `${DRIVER_LABELS[e.config.driver]}${s.serverVersion ? " " + s.serverVersion : ""}`),
      h("div", { class: "spacer" }),
      s.rows !== null ? item("Rows", s.rows.toLocaleString()) : null,
      s.affected !== null ? item("Affected", s.affected.toLocaleString()) : null,
      s.elapsedMs !== null ? item("Time", `${s.elapsedMs} ms`) : null,
      h("span", { class: "st-item tx " + (s.autoCommit ? "" : "manual") }, h("span", { class: "st-label" }, "Tx"), h("span", { class: "st-value" }, s.autoCommit ? "Auto" : "Manual")),
      h("span", { class: "st-item state" + (s.running ? " busy" : s.text === "Error" ? " bad" : "") }, h("span", { class: "st-dot" }), s.text),
    ];
    for (const n of nodes) if (n) this.statusEl.appendChild(n);
  }

  // ------------------------------------------------------------------ shortcuts

  private onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "n" && !e.shiftKey) {
      e.preventDefault();
      void this.newConsole();
    } else if (k === "w" && !e.shiftKey) {
      e.preventDefault();
      if (this.active) void this.closeTab(this.active);
    } else if (k === "h" && e.shiftKey) {
      e.preventDefault();
      this.toggleHistory();
    } else if (k === "b" && !e.shiftKey) {
      e.preventDefault();
      this.toggleSidebar();
    }
  }
}

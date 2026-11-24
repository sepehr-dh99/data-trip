// Application shell: ambient backdrop, sidebar card (explorer), content sheet with the floating
// capsule (console tabs + run controls + history), consoles, history drawer, shortcuts.
import { api } from "../api";
import type { ConnectionConfig } from "../types";
import { DRIVER_LABELS } from "../types";
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
  private tabsEl = h("div", { class: "cap-tabs", role: "tablist", "aria-label": "Consoles" });
  private tabEls = new Map<ConsolePane, HTMLElement>();
  private capSep = h("span", { class: "cap-sep", "aria-hidden": "true" });
  private capActions = h("div", { class: "cap-actions" });
  private btnAdd!: HTMLButtonElement;
  private stack = h("div", { class: "stack" });
  private empty = h("div", { class: "empty-state" });
  private sidebarW = Number(localStorage.getItem("dt.sidebarW")) || 244;
  private selectedConn: string | null = null;
  private counts = new Map<string, number>();
  private prevStatus = new Map<string, string>();
  private btnHistory!: HTMLButtonElement;
  private shell!: HTMLElement;
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
      close: () => {
        if (this.history.isOpen()) this.toggleHistory();
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
    this.renderTabs();
  }

  // ------------------------------------------------------------------ layout

  private build(): void {
    // Ambient color: six static, pre-blurred radial blobs behind everything (never animated).
    const ambient = h(
      "div",
      { class: "ambient", "aria-hidden": "true" },
      ["b1", "b2", "b3", "b4", "b5", "b6"].map((b) => h("div", { class: "blob " + b })),
    );

    this.btnAdd = h("button", { class: "cap-icon cap-add", type: "button", title: `New console (${MOD}N)`, "aria-label": "New console", onclick: () => void this.newConsole() }, icon("plus", 15));
    this.btnHistory = h(
      "button",
      { class: "cap-icon", type: "button", title: `Query history (${MOD}Shift+H)`, "aria-label": "Query history", "aria-pressed": "false", onclick: () => this.toggleHistory() },
      icon("clock", 16),
    );
    const capsule = h(
      "div",
      { class: "capsule", role: "toolbar", "aria-label": "Console" },
      h("div", { class: "cap-tabs-wrap" }, this.tabsEl, this.btnAdd),
      this.capSep,
      this.capActions,
      this.btnHistory,
    );
    // Translate vertical wheel into horizontal scrolling for the overflowing tab strip.
    this.tabsEl.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.tabsEl.scrollWidth > this.tabsEl.clientWidth) {
          this.tabsEl.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );

    // macOS: the strip above the content can move the window (there is no native title bar).
    const dragStrip = h("div", { class: "sheet-drag", "aria-hidden": "true", ...(IS_MAC ? { "data-tauri-drag-region": "" } : {}) });
    const sheet = h(
      "section",
      { class: "sheet", "aria-label": "Workspace" },
      // The sheet's glass is a layer of its own, not the container: a backdrop-filter on the container
      // would make it a backdrop root, and the floating pills/drawer inside could no longer blur the
      // rows beneath them (Chromium/WebView2).
      h("div", { class: "sheet-glass", "aria-hidden": "true" }),
      dragStrip,
      h("div", { class: "cap-wrap" }, capsule),
      this.stack,
      this.empty,
      this.history.el,
    );

    const resizer = h("div", { class: "resizer", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize sidebar", title: "Drag to resize" });
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
    this.explorer.el.appendChild(resizer);

    this.shell = h("div", { class: "shell" }, this.explorer.el, sheet);
    this.applySidebar();
    clear(this.root);
    this.root.append(ambient, this.shell);
    this.explorer.render();
  }

  private applySidebar(): void {
    this.shell.style.setProperty("--sidebar-w", this.sidebarW + "px");
    this.shell.classList.toggle("no-sidebar", this.sidebarHidden);
  }

  private toggleSidebar(): void {
    this.sidebarHidden = !this.sidebarHidden;
    this.applySidebar();
  }

  private toggleHistory(): void {
    const open = this.history.toggle();
    this.btnHistory.classList.toggle("on", open);
    this.btnHistory.setAttribute("aria-pressed", String(open));
    this.syncHistoryConn();
    if (!open) this.active?.focus();
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
      this.tabEls.get(c)?.classList.toggle("running", c.isRunning);
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
    clear(this.capActions);
    if (pane) this.capActions.appendChild(pane.controls);
    this.renderTabs();
    this.renderEmpty();
    if (pane) {
      this.selectedConn = pane.connId;
      pane.focus();
    }
    this.syncHistoryConn();
  }

  private renderTabs(): void {
    clear(this.tabsEl);
    this.tabEls.clear();
    for (const t of this.tabs) {
      const e = store.conns.get(t.connId);
      const color = e ? connColor(e.config) : "var(--accent)";
      const isActive = t === this.active;
      const server = e ? `${DRIVER_LABELS[e.config.driver].split(" / ")[0]}${e.session?.serverVersion ? " " + e.session.serverVersion : ""}` : "";
      const close = h(
        "button",
        { class: "tab-close", type: "button", tabindex: "-1", title: `Close (${MOD}W)`, "aria-label": `Close ${t.title}`, onclick: (ev: Event) => (ev.stopPropagation(), void this.closeTab(t)) },
        icon("x", 11),
      );
      const tab = h(
        "div",
        {
          class: "tab" + (isActive ? " active" : "") + (t.isRunning ? " running" : ""),
          role: "tab",
          tabindex: isActive ? "0" : "-1",
          style: `--c:${color}`,
          title: `${t.title} — ${e?.config.name ?? ""}${server ? " (" + server + ")" : ""}`,
          "aria-selected": String(isActive),
        },
        h("span", { class: "tab-dot", "aria-hidden": "true" }),
        h("span", { class: "tab-title" }, t.title),
        close,
      );
      tab.addEventListener("click", () => {
        if (t !== this.active) this.activate(t);
      });
      tab.addEventListener("auxclick", (ev) => {
        if (ev.button === 1) void this.closeTab(t);
      });
      tab.addEventListener("keydown", (ev) => {
        const i = this.tabs.indexOf(t);
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
          ev.preventDefault();
          const next = this.tabs[(i + (ev.key === "ArrowRight" ? 1 : -1) + this.tabs.length) % this.tabs.length];
          this.activate(next);
          this.tabEls.get(next)?.focus();
        } else if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this.activate(t);
        } else if (ev.key === "Delete") {
          ev.preventDefault();
          void this.closeTab(t);
        }
      });
      this.tabEls.set(t, tab);
      this.tabsEl.appendChild(tab);
    }
    const has = this.tabs.length > 0;
    this.capSep.hidden = !this.active;
    this.btnAdd.classList.toggle("labeled", !has);
    clear(this.btnAdd);
    this.btnAdd.append(icon("plus", 15), has ? "" : h("span", null, "New console"));
    // Keep the active tab visible inside the horizontally scrolling strip (without scrollIntoView,
    // which would also scroll the overflow-hidden sheet).
    const at = this.active ? this.tabEls.get(this.active) : undefined;
    if (at) {
      requestAnimationFrame(() => {
        const strip = this.tabsEl;
        const l = at.offsetLeft;
        const r = l + at.offsetWidth;
        if (l < strip.scrollLeft) strip.scrollLeft = l - 4;
        else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth + 4;
      });
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
  }

  // ------------------------------------------------------------------ empty state

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
        h("div", { class: "empty-art" }, brandMark(72)),
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

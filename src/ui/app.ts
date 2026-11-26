// Application shell: ambient backdrop, sidebar card (explorer), content sheet with the floating
// capsule (console tabs + run controls + history), consoles, history drawer, shortcuts.
import { api } from "../api";
import type { ConnectionConfig } from "../types";
import { confirmDialog } from "./confirm";
import { ConsolePane } from "./console";
import type { ConsoleHost } from "./console";
import { openConnectionDialog } from "./connDialog";
import { openImportDialog } from "./importDialog";
import { brandMark, clear, copyText, errMsg, h, icon } from "./dom";
import { Explorer } from "./explorer";
import type { OpenConsoleOpts } from "./explorer";
import { HistoryPanel } from "./history";
import { GroupPane } from "./kafkaGroup";
import { TopicPane } from "./kafkaTopic";
import { KeyPane } from "./keyView";
import type { KeyHost } from "./keyView";
import type { TabPane } from "./tabs";
import { TabStrip } from "./tabRail";
import { matchAction, shortcutLabel } from "./keymap";
import { openSettings } from "./settingsDialog";
import { Navigator } from "./navigator";
import { openScopePicker } from "./scopePicker";
import { store } from "./state";
import { loadLayout, onLookChange } from "./layout";
import { toast } from "./toast";
import { VAULT_TOKEN_RE, vaults } from "./vault";
import { showTokenPastePrompt } from "./vaultChips";

const IS_MAC = /Mac/.test(navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

/** What "Reopen closed tab" needs to bring a tab back. */
interface ClosedTab {
  kind: TabPane["kind"];
  connId: string;
  database: string | null;
  title: string;
  table: string | null;
  schema: string | null;
  sql: string;
  name: string | null;
}
const MAX_CLOSED = 25;

export class App {
  private tabs: TabPane[] = [];
  private active: TabPane | null = null;
  private explorer: Explorer;
  private history: HistoryPanel;
  private strip!: TabStrip;
  private closed: ClosedTab[] = [];
  private dirtySeen = new Map<TabPane, boolean>();
  private capSep = h("span", { class: "cap-sep", "aria-hidden": "true" });
  private capSep2 = h("span", { class: "cap-sep", "aria-hidden": "true" });
  private navigator!: Navigator;
  private capActions = h("div", { class: "cap-actions" });
  private btnAdd!: HTMLButtonElement;
  private stack = h("div", { class: "stack" });
  private empty = h("div", { class: "empty-state" });
  private sidebarW = Number(localStorage.getItem("dt.sidebarW")) || 288;
  private selectedConn: string | null = null;
  private prevStatus = new Map<string, string>();
  private btnHistory!: HTMLButtonElement;
  private shell!: HTMLElement;
  private capsule!: HTMLElement;
  private sheetEl!: HTMLElement;
  private capFitQueued = false;
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
      openKey: (id, db, key, type) => void this.openKey(id, db, key, type),
      keysDeleted: (id, db, keys) => {
        const gone = new Set(keys);
        for (const t of this.tabs) if (t instanceof KeyPane && t.connId === id && t.effectiveDatabase === db && gone.has(t.key)) t.markGone();
      },
      keyTouched: (id, db, key) => {
        for (const t of this.tabs) if (t instanceof KeyPane && t.matches(id, db, key)) void t.load();
      },
      openTopic: (id, topic) => void this.openTopic(id, topic),
      openGroup: (id, group) => void this.openGroup(id, group),
      produceTo: (id, topic) => void this.openTopic(id, topic, true),
      topicDeleted: (id, topic) => {
        for (const t of this.tabs.filter((x) => x instanceof TopicPane && x.matches(id, topic))) void this.closeTab(t);
      },
    });
    this.navigator = new Navigator({
      sheet: () => this.shell.querySelector<HTMLElement>(".sheet") ?? this.root,
      openConsole: (id, o) => void this.openConsole(id, o),
      openKey: (id, db, key, type) => void this.openKey(id, db, key, type),
      openTopic: (id, topic) => void this.openTopic(id, topic),
      openGroup: (id, group) => void this.openGroup(id, group),
      manageScope: (id, r) => openScopePicker(id, { x: r.left, y: r.bottom + 8 }),
    });
    this.history = new HistoryPanel({
      insert: (sql) => {
        const c = this.activeConsole();
        if (!c) return toast("Open a console first", "info");
        c.insertStatement(sql);
      },
      run: (sql) => {
        const c = this.activeConsole();
        if (!c) return toast("Open a console first", "info");
        // The first click of the double-click already inserted the SQL.
        void c.runSqlText(sql);
      },
      close: () => {
        if (this.history.isOpen()) this.toggleHistory();
      },
    });
    this.btnAdd = h("button", { class: "cap-icon cap-add", type: "button", title: `New console (${shortcutLabel("newConsole")})`, "aria-label": "New console", onclick: () => void this.newConsole() }, icon("plus", 15));
    this.strip = new TabStrip(
      {
        tabs: () => this.tabs,
        active: () => this.active,
        activate: (t) => this.activate(t),
        close: (t) => void this.closeTab(t),
        closeMany: (list) => void this.closeMany(list),
        newConsole: () => void this.newConsole(),
        setOrder: (list) => {
          if (list.length === this.tabs.length && list.every((t) => this.tabs.includes(t))) this.tabs = list;
        },
        changed: () => {
          this.navigator.update(this.active);
          this.fitCapsule();
          this.syncCapSeps();
        },
      },
      this.btnAdd,
    );
    this.build();
    store.subscribe(() => this.onStoreChange());
    onLookChange(() => {
      this.renderTabs();
      this.navigator.update(this.active);
    });
    store.onSchema((id) => this.tabs.filter((t) => t.connId === id).forEach((t) => t.updateSchema()));
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("paste", (e) => this.onPaste(e));
  }

  private inEditable(t: EventTarget | null): boolean {
    return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest(".cm-editor") !== null);
  }

  private activeConsole(): ConsolePane | null {
    return this.active instanceof ConsolePane ? this.active : null;
  }

  private importDataGrip(initialText = ""): void {
    if (document.querySelector(".import-dialog")) return;
    openImportDialog((n) => {
      if (n > 0) this.renderTabs();
      this.renderEmpty();
    }, initialText);
  }

  /**
   * Cmd/Ctrl+V outside editable elements: DataGrip settings open the import dialog, a Vault token
   * (hvs./hvb./hvr./s./b.) offers "Use this token for: [Prod] [Stage]".
   */
  private onPaste(e: ClipboardEvent): void {
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest(".cm-editor"))) return;
    if (document.querySelector(".overlay")) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text.includes("#DataSourceSettings#") || text.includes("<data-source")) {
      e.preventDefault();
      this.importDataGrip(text);
    } else if (VAULT_TOKEN_RE.test(text.trim())) {
      e.preventDefault();
      showTokenPastePrompt(text.trim());
    }
  }

  async start(): Promise<void> {
    try {
      await Promise.all([store.load(), loadLayout()]);
    } catch (e) {
      toast(`Could not load connections: ${errMsg(e)}`, "error");
    }
    this.renderEmpty();
    this.renderTabs();
    // Shared Vault profiles: load them, look the tokens up, keep the sidebar chips counting down.
    vaults.start();
    void vaults.load();
  }

  // ------------------------------------------------------------------ layout

  private build(): void {
    // Ambient color: six static, pre-blurred radial blobs behind everything (never animated).
    const ambient = h(
      "div",
      { class: "ambient", "aria-hidden": "true" },
      ["b1", "b2", "b3", "b4", "b5", "b6"].map((b) => h("div", { class: "blob " + b })),
    );

    this.btnHistory = h(
      "button",
      { class: "cap-icon", type: "button", title: `Query history (${MOD}Shift+H)`, "aria-label": "Query history", "aria-pressed": "false", onclick: () => this.toggleHistory() },
      icon("clock", 16),
    );
    const capsule = h(
      "div",
      { class: "capsule", role: "toolbar", "aria-label": "Console" },
      this.strip.topEl,
      this.capSep,
      this.navigator.el,
      this.capSep2,
      this.capActions,
      this.btnHistory,
    );
    this.capsule = capsule;

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

    this.sheetEl = sheet;
    this.strip.mount(sheet);
    new ResizeObserver(() => this.fitCapsule()).observe(sheet);
    this.shell = h("div", { class: "shell" }, this.explorer.el, sheet);
    this.applySidebar();
    clear(this.root);
    this.root.append(ambient, this.shell);
    this.explorer.render();
  }

  /** Single-line capsule when it fits; otherwise breadcrumb on its own second row. */
  private fitCapsule(): void {
    if (this.capFitQueued) return;
    this.capFitQueued = true;
    requestAnimationFrame(() => {
      this.capFitQueued = false;
      this.capsule.classList.remove("stacked");
      const over = this.capsule.scrollWidth > this.capsule.clientWidth + 1;
      this.capsule.classList.toggle("stacked", over);
      this.sheetEl.classList.toggle("cap-stacked", over);
      // Tabs on top: show the ones that fit, the rest go behind "+N more".
      this.strip.fitTop();
    });
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
      this.strip.setRunning(c);
      const d = c.dirty;
      if ((this.dirtySeen.get(c) ?? false) !== d) {
        this.dirtySeen.set(c, d);
        this.renderTabs();
      }
    },
    onSchemaChanged: (id) => void store.refresh(id).catch(() => undefined),
    onDatabase: () => {
      this.renderTabs();
      this.syncHistoryConn();
    },
    ensureConnected: async (id) => {
      if (store.conns.get(id)?.status === "connected") return true;
      try {
        await this.explorer.connect(id);
      } catch {
        return false;
      }
      return store.conns.get(id)?.status === "connected";
    },
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

  private async openConsole(connId: string, opts: OpenConsoleOpts = {}, name: string | null = null): Promise<ConsolePane | null> {
    const entry = store.conns.get(connId);
    if (!entry) return null;
    if (entry.status !== "connected") {
      try {
        // On a recoverable failure (expired Vault token…) the explorer retries the connect after the fix and opens the console then.
        await this.explorer.connect(connId, () => void this.openConsole(connId, opts, name));
      } catch {
        return null;
      }
      if (store.conns.get(connId)?.status !== "connected") return null;
    }
    let title = opts.title;
    if (!title) {
      // "console", "console 2"… — the lowest number not used by an open console of this data source.
      const used = new Set(this.tabs.filter((t) => t.kind === "console" && t.connId === connId).map((t) => t.title));
      let n = 1;
      while (used.has(n === 1 ? "console" : `console ${n}`)) n++;
      title = n === 1 ? "console" : `console ${n}`;
    }
    const pane = new ConsolePane(connId, title, this.host, opts.sql ?? "", opts.database ?? null, opts.schema ?? null, opts.table ?? null);
    this.tabs.push(pane);
    this.stack.appendChild(pane.el);
    if (name) this.strip.setManualName(pane, name);
    this.activate(pane);
    if (opts.explicitSchema && opts.schema) void pane.setDefaultSchema(opts.schema);
    if (opts.run && opts.sql) void pane.runSqlText(opts.sql);
    return pane;
  }

  private keyHost: KeyHost = {
    changed: () => this.renderTabs(),
    keysDeleted: (id, db, keys) => {
      this.explorer.redisKeysRemoved(id, db, keys);
      const gone = new Set(keys);
      for (const t of this.tabs) if (t instanceof KeyPane && t.connId === id && t.effectiveDatabase === db && gone.has(t.key) && !t.isGone) t.markGone();
    },
    ttlChanged: (id, db, key, ttl) => this.explorer.redisTtlChanged(id, db, key, ttl),
  };

  /** Opens (or focuses) the viewer tab of a Redis key. */
  private async openKey(connId: string, db: string, key: string, keyType: string): Promise<void> {
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
    const existing = this.tabs.find((t) => t instanceof KeyPane && t.matches(connId, db, key));
    if (existing) {
      this.activate(existing);
      return;
    }
    const pane = new KeyPane(connId, db, key, this.keyHost, keyType);
    this.tabs.push(pane);
    this.stack.appendChild(pane.el);
    this.activate(pane);
  }

  /** Connects the data source when needed; true when it is connected. */
  private async ensureConn(connId: string): Promise<boolean> {
    const entry = store.conns.get(connId);
    if (!entry) return false;
    if (entry.status !== "connected") {
      try {
        await this.explorer.connect(connId);
      } catch {
        return false;
      }
    }
    return store.conns.get(connId)?.status === "connected";
  }

  /** Opens (or focuses) the tab of a Kafka topic; `produce` also opens the produce dialog. */
  private async openTopic(connId: string, topic: string, produce = false): Promise<void> {
    if (!(await this.ensureConn(connId))) return;
    let pane = this.tabs.find((t): t is TopicPane => t instanceof TopicPane && t.matches(connId, topic));
    if (!pane) {
      pane = new TopicPane(connId, topic);
      this.tabs.push(pane);
      this.stack.appendChild(pane.el);
    }
    this.activate(pane);
    if (produce) pane.produce();
  }

  /** Opens (or focuses) the tab of a Kafka consumer group. */
  private async openGroup(connId: string, groupId: string): Promise<void> {
    if (!(await this.ensureConn(connId))) return;
    let pane = this.tabs.find((t): t is GroupPane => t instanceof GroupPane && t.matches(connId, groupId));
    if (!pane) {
      pane = new GroupPane(connId, groupId);
      this.tabs.push(pane);
      this.stack.appendChild(pane.el);
    }
    this.activate(pane);
  }

  private activate(pane: TabPane | null): void {
    this.active = pane;
    if (pane) this.strip.touch(pane);
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
    this.strip.render();
    const has = this.tabs.length > 0;
    this.navigator.update(this.active);
    this.fitCapsule();
    this.syncCapSeps();
    this.btnAdd.classList.toggle("labeled", !has);
    clear(this.btnAdd);
    this.btnAdd.append(icon("plus", 15), has ? "" : h("span", null, "New console"));
  }

  private syncCapSeps(): void {
    this.capSep.hidden = this.navigator.el.hidden || this.strip.vertical;
    this.capSep2.hidden = !this.active || this.active.controls.childElementCount === 0;
  }

  private async closeTab(t: TabPane): Promise<void> {
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    this.rememberClosed(t);
    // The next tab in display order (rail groups / pinned first) takes over, like the strip shows it.
    const ordered = this.strip.ordered();
    const oi = ordered.indexOf(t);
    const nextActive = ordered[oi + 1] ?? ordered[oi - 1] ?? null;
    this.tabs.splice(i, 1);
    this.strip.forget(t);
    this.dirtySeen.delete(t);
    t.el.remove();
    void t.dispose();
    if (this.active === t) {
      this.activate(nextActive && this.tabs.includes(nextActive) ? nextActive : (this.tabs[Math.min(i, this.tabs.length - 1)] ?? null));
      this.renderEmpty();
      return;
    }
    this.renderTabs();
    this.renderEmpty();
  }

  private async closeMany(list: TabPane[]): Promise<void> {
    for (const t of [...list]) await this.closeTab(t);
  }

  private rememberClosed(t: TabPane): void {
    const c = t instanceof ConsolePane ? t : null;
    this.closed.push({
      kind: t.kind,
      connId: t.connId,
      database: t.kind === "key" ? t.effectiveDatabase : t.database,
      title: t.title,
      table: c?.table ?? null,
      schema: c ? c.schema : null,
      sql: c ? c.sqlText : "",
      name: this.strip.manualName(t),
    });
    if (this.closed.length > MAX_CLOSED) this.closed.shift();
  }

  /** Reopen closed tab: consoles come back with their text (results are not kept). */
  private async reopenTab(): Promise<void> {
    const c = this.closed.pop();
    if (!c) {
      toast("No closed tab to reopen", "info");
      return;
    }
    if (!store.conns.has(c.connId)) return this.reopenTab();
    if (c.kind === "console") {
      await this.openConsole(c.connId, { sql: c.sql, title: c.title, table: c.table ?? undefined, database: c.database, schema: c.schema }, c.name);
      return;
    }
    if (c.kind === "key") await this.openKey(c.connId, c.database ?? store.conns.get(c.connId)?.defaultDb ?? "0", c.title, "");
    else if (c.kind === "topic") await this.openTopic(c.connId, c.title);
    else await this.openGroup(c.connId, c.title);
    if (c.name && this.active) this.strip.setManualName(this.active, c.name);
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
            ? "Double-click a table (or click a Redis key, Kafka topic or group) in the explorer to open it, or start a blank console and write some SQL."
            : "DataTrip works with PostgreSQL, MySQL / MariaDB, SQLite, SQL Server, Redis and Kafka. Credentials stay in your system keychain.",
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
          h("span", null, h("kbd", null, shortcutLabel("runStatement")), " run statement"),
          h("span", null, h("kbd", null, shortcutLabel("runAll")), " run all"),
          h("span", null, h("kbd", null, shortcutLabel("newConsole")), " new console"),
          h("span", null, h("kbd", null, MOD + "⇧H"), " history"),
          h("span", null, h("kbd", null, shortcutLabel("settings")), " settings"),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ shortcuts

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const editable = this.inEditable(e.target);
    const overlay = document.querySelector(".overlay:not(.leaving)") !== null;
    const a = matchAction(e);
    if (!a) {
      // Query history keeps its fixed shortcut.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h" && !overlay) {
        e.preventDefault();
        this.toggleHistory();
      }
      return;
    }
    if (overlay && a !== "settings") return;
    const c = this.activeConsole();
    switch (a) {
      case "undo":
      case "redo":
        // With focus outside any text field (after clicking a result cell or a tab) undo / redo go to the
        // active console's editor instead of doing nothing.
        if (editable || !c) return;
        e.preventDefault();
        if (a === "redo") c.redo();
        else c.undo();
        return;
      case "toggleComment":
      case "find":
      case "formatSql":
        return;
      case "runStatement":
      case "runAll":
        // The editor handles these itself while it has focus; elsewhere (grid, tab strip) they still run.
        if (editable || !c) return;
        e.preventDefault();
        if (a === "runAll") void c.runAll();
        else void c.runCurrent();
        return;
      case "cancel":
        if (!c || !c.isRunning) return;
        e.preventDefault();
        c.cancelRun();
        return;
      case "newConsole":
        e.preventDefault();
        void this.newConsole();
        return;
      case "closeTab":
        e.preventDefault();
        if (this.active) void this.closeTab(this.active);
        return;
      case "reopenTab":
        e.preventDefault();
        void this.reopenTab();
        return;
      case "reconnect": {
        e.preventDefault();
        const id = this.active?.connId ?? this.selectedConn;
        if (id) void this.explorer.reconnect(id);
        else toast("Select a data source to reconnect", "info");
        return;
      }
      case "settings":
        e.preventDefault();
        if (!overlay) openSettings();
        return;
      case "nextTab":
      case "prevTab": {
        const list = this.strip.ordered();
        if (list.length < 2 && this.active) return;
        e.preventDefault();
        const i = this.active ? list.indexOf(this.active) : -1;
        const next = list[(i + (a === "nextTab" ? 1 : -1) + list.length) % list.length];
        if (next) this.activate(next);
        return;
      }
      case "jumpToTab":
        e.preventDefault();
        this.strip.jump();
        return;
      case "toggleSidebar":
        e.preventDefault();
        this.toggleSidebar();
        return;
    }
  }
}

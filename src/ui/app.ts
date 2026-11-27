// Application shell: ambient backdrop, sidebar card (explorer), content sheet with the floating
// capsule (console tabs + run controls + history), consoles, history drawer, shortcuts.
import { api } from "../api";
import type { ConnectionConfig, SchemaNode } from "../types";
import { DRIVER_LABELS } from "../types";
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
import { SessionsPane } from "./sessionsPane";
import { prodOptions } from "./prodSafety";
import { TopicPane } from "./kafkaTopic";
import { KeyPane } from "./keyView";
import type { KeyHost } from "./keyView";
import type { TabPane } from "./tabs";
import { TabStrip, autoName } from "./tabRail";
import { formatBinding, matchAction, shortcutLabel } from "./keymap";
import { IS_MAC as MENU_MAC, listenNativeMenu, showAppMenu } from "./appMenu";
import type { AppMenuEntry, AppMenuSection, MenuCommand } from "./appMenu";
import { isPaletteOpen, openPalette } from "./palette";
import type { PaletteItem } from "./palette";
import { pickCrossSources } from "./crossSource";
import { FED_DRIVERS } from "./federation";
import { closeMenu } from "./menu";
import { qualifiedName } from "./sqlutil";
import { openVaultProfilesDialog } from "./vaultDialog";
import { openSshProfilesDialog } from "./sshDialog";
import { openSettings } from "./settingsDialog";
import { Navigator } from "./navigator";
import { openScopePicker } from "./scopePicker";
import { store } from "./state";
import { loadLayout, onLookChange } from "./layout";
import { toast } from "./toast";
import { VAULT_TOKEN_RE, vaults } from "./vault";
import { showTokenPastePrompt } from "./vaultChips";
import { getSettings, onSettingsChange, updateSettings } from "./settings";
import { RestoredPane, WorkspaceSaver, loadWorkspace } from "./workspace";
import { initSqlFiles, openSqlFile, runSqlFileFlow } from "./sqlFiles";
import { initHelp, isHelpOpen, openHelp } from "./help";
import { maybeStartTour, startTour } from "./tour";
import { checkForUpdates, initUpdates, setBeforeRestart } from "./updates";
import { initDataTools } from "./dataTools";
import { importData, openDesigner, showDdl } from "./dataActions";
import type { Workspace, WsSessions, WsTab } from "./workspace";
import { DdlPane } from "./ddlPane";
import type { FileMemo } from "./sqlFiles";

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
  /** v0.17: the console's .sql file binding (path, baseline, mtime, dirty) — Save keeps writing to that file. */
  file?: FileMemo | null;
  /** v0.17: Sessions & locks filters. */
  sessions?: WsSessions;
}
const MAX_CLOSED = 25;

/** Another tab is already connecting this data source: wait for that connect (up to a minute). */
async function waitWhileConnecting(id: string): Promise<void> {
  for (let i = 0; i < 600 && store.conns.get(id)?.status === "connecting"; i++) {
    await new Promise<void>((r) => window.setTimeout(r, 100));
  }
}

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
  /** Focus before the ☰ menu opened (its Edit commands act on it). */
  private menuFocus: HTMLElement | null = null;
  /** Restore on launch: saves the open tabs (debounced). */
  private saver = new WorkspaceSaver(() => this.collectWorkspace());
  /** False until the saved workspace was restored: nothing is saved before (it would overwrite it). */
  private wsReady = false;
  /** Restored Redis key / Kafka tabs being opened. */
  private materializing = new Set<RestoredPane>();

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
      toggleHistory: () => this.toggleHistory(),
      openPalette: () => this.openCommandPalette(),
      newCrossSource: (ids) => void this.newCrossSource(ids),
      runSqlFile: (id) => void runSqlFileFlow({ connId: id }),
      openSessions: (id) => void this.openSessions(id),
      openHelp: () => openHelp(),
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
          this.saveWorkspaceSoon();
        },
        changed: () => {
          this.navigator.update(this.active);
          this.fitCapsule();
          this.syncCapSeps();
          this.saveWorkspaceSoon();
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
    window.addEventListener("keydown", (e) => this.onKeyCapture(e), true);
    // macOS: the native menu bar (lib.rs) sends the clicked item's id.
    listenNativeMenu((id) => this.runCommand(id));
    // SQL files (v0.15): open / save / run .sql files, dropped files, changed-on-disk checks.
    initSqlFiles({
      openConsole: (connId, o) => this.openConsole(connId, { sql: o.sql, database: o.database ?? null, title: o.title }),
      consoles: () => this.tabs.filter((t): t is ConsolePane => t instanceof ConsolePane),
      activeConsole: () => this.activeConsole(),
      activate: (c) => this.activate(c),
      currentConn: () => this.active?.connId ?? this.selectedConn,
      ensureConnected: (id) => this.ensureConn(id),
    });
    // v0.16: Show DDL, table designer and Import data open tabs / dialogs through this host.
    initDataTools({
      addTab: (pane) => {
        if (pane instanceof DdlPane) pane.onChange = () => this.saveWorkspaceSoon();
        this.tabs.push(pane);
        this.stack.appendChild(pane.el);
        this.activate(pane);
      },
      tabs: () => this.tabs,
      activate: (pane) => this.activate(pane),
      openConsole: (connId, o) => void this.openConsole(connId, { sql: o.sql, database: o.database, schema: o.schema, title: o.title }),
      ensureConnected: (id) => this.ensureConn(id),
      selectedTarget: () => this.explorer.selectedTarget(),
      activeContext: () => {
        const a = this.active;
        if (!a) return null;
        const c = this.activeConsole();
        return { connId: a.connId, database: a.effectiveDatabase, schema: a.currentSchemaName(), table: c?.table ?? null };
      },
    });
    // Help (v0.15): "Try it" buttons of the help center.
    initHelp({
      runCommand: (id) => this.runCommand(id),
      newConsoleWith: (sql) => {
        const id = this.active?.connId ?? this.selectedConn ?? store.list().find((e) => e.status === "connected")?.config.id ?? store.list()[0]?.config.id;
        if (!id) {
          toast("Add a connection first", "info");
          this.addConnection();
          return;
        }
        void this.openConsole(id, { sql });
      },
    });
    window.addEventListener("paste", (e) => this.onPaste(e));
    // In-app updates: the open tabs are saved right before an update restarts the app.
    setBeforeRestart(() => this.saver.flush());
    void initUpdates();
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
    let loaded = true;
    try {
      await Promise.all([store.load(), loadLayout()]);
    } catch (e) {
      loaded = false;
      toast(`Could not load connections: ${errMsg(e)}`, "error");
    }
    this.renderEmpty();
    this.renderTabs();
    // Shared Vault profiles: load them, look the tokens up, keep the sidebar chips counting down.
    vaults.start();
    void vaults.load();
    // Restore consoles on launch (without the connection list every tab would be dropped: then don't restore
    // and don't save either, so the saved workspace survives for the next start).
    if (loaded && getSettings().data.restoreConsoles) await this.restoreWorkspace();
    this.wsReady = loaded;
    // First launch: the welcome tour (once; Help › Welcome tour restarts it).
    maybeStartTour();
    this.pruneHistory();
    let prev = getSettings().data;
    onSettingsChange((st) => {
      const d = st.data;
      if (d.historyDays !== prev.historyDays) this.pruneHistory();
      if (d.restoreConsoles !== prev.restoreConsoles) {
        if (d.restoreConsoles) this.saveWorkspaceSoon();
        else {
          // Off: stop saving and forget what was saved (console text may be sensitive).
          this.saver.cancel();
          if (this.wsReady) void api.saveWorkspace({ version: 1, tabs: [], active: -1 }).catch(() => undefined);
        }
      }
      prev = d;
    });
  }

  // ------------------------------------------------------------------ history retention

  /** Settings › Data › Keep query history for: drops older entries (at start and when the setting changes). */
  private pruneHistory(): void {
    const days = getSettings().data.historyDays;
    if (days <= 0) return;
    void api
      .pruneHistory(days)
      .then((n) => {
        if (n > 0) void this.history.refresh();
      })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------ restore on launch

  private saveWorkspaceSoon(): void {
    if (this.wsReady && getSettings().data.restoreConsoles) this.saver.schedule();
  }

  /** The open tabs in manual order, for workspace.json (null = restore on launch is off). */
  private collectWorkspace(): Workspace | null {
    if (!this.wsReady || !getSettings().data.restoreConsoles) return null;
    const tabs: WsTab[] = [];
    for (const t of this.tabs) {
      const key = this.strip.keyFor(t);
      const name = this.strip.manualName(t);
      if (t instanceof RestoredPane) tabs.push({ ...t.saved, key, name });
      else if (t instanceof ConsolePane) tabs.push({ kind: "console", key, name, connId: t.connId, title: t.title, database: t.database, console: t.snapshot() });
      else if (t instanceof KeyPane) tabs.push({ kind: "key", key, name, connId: t.connId, title: t.key, database: t.effectiveDatabase, keyType: t.keyType });
      else if (t instanceof TopicPane) tabs.push({ kind: "topic", key, name, connId: t.connId, title: t.topic, database: null });
      else if (t instanceof GroupPane) tabs.push({ kind: "group", key, name, connId: t.connId, title: t.groupId, database: null });
      else if (t instanceof SessionsPane) tabs.push({ kind: "sessions", key, name, connId: t.connId, title: t.title, database: null, sessions: t.snapshot() });
      else if (t instanceof DdlPane) tabs.push({ kind: "ddl", key, name, connId: t.connId, title: t.title, database: t.target.database, ddl: t.snapshot() });
    }
    // Every open tab but table designers (v0.17: not restored) has an entry, so indexes match.
    const savedTabs = this.tabs.filter((t) => t.kind !== "design");
    const active = this.active && tabs.length === savedTabs.length ? savedTabs.indexOf(this.active) : -1;
    return { version: 1, tabs, active };
  }

  /**
   * Reopens the saved tabs in their manual order without connecting anything: consoles get their text, cursor,
   * bindings and attached sources and connect on first activation / run; Redis key and Kafka tabs are placeholders
   * until activated. Tabs of data sources that no longer exist are skipped.
   */
  private async restoreWorkspace(): Promise<void> {
    const ws = await loadWorkspace();
    let active: TabPane | null = null;
    for (let i = 0; i < ws.tabs.length; i++) {
      const t = ws.tabs[i];
      if (!store.conns.has(t.connId)) continue;
      let pane: TabPane;
      try {
        pane = this.restoreTab(t);
      } catch {
        continue;
      }
      pane.el.classList.add("hidden");
      this.tabs.push(pane);
      this.stack.appendChild(pane.el);
      if (i === ws.active) active = pane;
    }
    if (this.tabs.length === 0) return;
    this.activate(active ?? this.strip.ordered()[0] ?? this.tabs[0]);
  }

  private restoreTab(t: WsTab): TabPane {
    if (t.kind === "console") {
      const c = t.console;
      const pane = new ConsolePane(t.connId, t.title, this.host, c?.sql ?? "", c?.database ?? null, c?.schema ?? null, c?.table ?? null);
      this.strip.adopt(pane, t.key, t.name);
      if (c) pane.restoreState(c);
      return pane;
    }
    if (t.kind === "sessions") {
      // v0.17: connects and loads when first shown
      const pane = new SessionsPane(t.connId, { state: t.sessions ?? null, ensure: () => this.ensureConn(t.connId) });
      pane.onChange = () => this.saveWorkspaceSoon();
      this.strip.adopt(pane, t.key, t.name);
      return pane;
    }
    if (t.kind === "ddl") {
      // v0.17: the DDL is read again when the tab is first shown
      const d = t.ddl;
      const drv = store.conns.get(t.connId)?.config.driver;
      if (!d || !drv || !FED_DRIVERS.has(drv)) throw new Error("not a SQL data source");
      const pane = new DdlPane({ connId: t.connId, database: d.database, schema: d.schema, name: d.name, kind: d.kind, arguments: d.arguments, table: d.table }, { lazy: true, options: d.options });
      pane.onChange = () => this.saveWorkspaceSoon();
      this.strip.adopt(pane, t.key, t.name);
      return pane;
    }
    if (t.kind !== "key" && t.kind !== "topic" && t.kind !== "group") throw new Error("not restored");
    const pane = new RestoredPane(t.kind, t);
    this.strip.adopt(pane, t.key, t.name);
    return pane;
  }

  /** A restored placeholder for that key / topic / group that was not opened yet. */
  private findRestored(kind: "key" | "topic" | "group", connId: string, title: string, db: string | null = null): RestoredPane | null {
    const p = this.tabs.find((t): t is RestoredPane => t instanceof RestoredPane && t.kind === kind && t.connId === connId && t.title === title && (kind !== "key" || t.database === db));
    return p ?? null;
  }

  /** Opens the real tab behind a restored placeholder (connecting its data source first). */
  private async materialize(p: RestoredPane): Promise<void> {
    if (this.materializing.has(p)) return;
    this.materializing.add(p);
    let ok = false;
    try {
      ok = await this.ensureConn(p.connId);
    } finally {
      this.materializing.delete(p);
    }
    const i = this.tabs.indexOf(p);
    if (i < 0) return;
    if (!ok) {
      p.showError(`Couldn't connect to ${store.conns.get(p.connId)?.config.name ?? "the data source"}. Activate the tab again to retry.`);
      return;
    }
    const s = p.saved;
    let next: TabPane;
    if (p.kind === "key") next = new KeyPane(p.connId, s.database ?? store.conns.get(p.connId)?.defaultDb ?? "0", s.title, this.keyHost, s.keyType ?? "");
    else if (p.kind === "topic") next = new TopicPane(p.connId, s.title);
    else next = new GroupPane(p.connId, s.title);
    this.tabs[i] = next;
    this.strip.replace(p, next);
    p.el.replaceWith(next.el);
    void p.dispose();
    if (this.active === p) this.activate(next);
    else {
      next.el.classList.add("hidden");
      this.renderTabs();
    }
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
      this.appMenuButton(),
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

  /** Windows / Linux: ☰ at the left of the tab bar opens the app menu (macOS has the native menu bar). */
  private appMenuButton(): HTMLElement | null {
    if (MENU_MAC) return null;
    const glyph = h("span", { class: "ico", "aria-hidden": "true" });
    glyph.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
    const btn = h("button", { class: "cap-icon cap-menu", type: "button", title: "Menu", "aria-label": "Menu", "aria-haspopup": "menu" }, glyph);
    btn.addEventListener("pointerdown", () => {
      const a = document.activeElement;
      this.menuFocus = a instanceof HTMLElement && a !== btn ? a : null;
    });
    btn.addEventListener("click", () => showAppMenu(btn, this.menuSections(), (id) => this.runCommand(id)));
    return btn;
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
      this.saveWorkspaceSoon();
    },
    onWorkspace: () => this.saveWorkspaceSoon(),
    reconnect: (id) => this.explorer.reconnect(id),
    ensureConnected: async (id) => {
      await waitWhileConnecting(id);
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
    const existing = this.tabs.find((t) => t instanceof KeyPane && t.matches(connId, db, key)) ?? this.findRestored("key", connId, key, db);
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
    await waitWhileConnecting(connId);
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
    const restored = this.findRestored("topic", connId, topic);
    if (restored && !produce) {
      this.activate(restored);
      return;
    }
    if (restored) await this.materialize(restored);
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
  /** v0.16: opens (or focuses) the Sessions & locks tab of a data source (its own dedicated session). */
  private async openSessions(connId: string, state: WsSessions | null = null): Promise<void> {
    const drv = store.conns.get(connId)?.config.driver;
    if (drv !== "sqlite" && !(await this.ensureConn(connId))) return;
    let pane = this.tabs.find((t): t is SessionsPane => t instanceof SessionsPane && t.matches(connId));
    if (!pane) {
      pane = new SessionsPane(connId, { state });
      pane.onChange = () => this.saveWorkspaceSoon();
      this.tabs.push(pane);
      this.stack.appendChild(pane.el);
    }
    this.activate(pane);
  }

  private async openGroup(connId: string, groupId: string): Promise<void> {
    if (!(await this.ensureConn(connId))) return;
    const restored = this.findRestored("group", connId, groupId);
    if (restored) {
      this.activate(restored);
      return;
    }
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
    // Restored on launch: connect / open on first activation.
    if (pane instanceof RestoredPane) void this.materialize(pane);
    else if (pane instanceof ConsolePane) {
      void pane.wake();
      void pane.file.checkDisk();
    }
    this.saveWorkspaceSoon();
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
    // A console bound to a .sql file with unsaved changes: ask first.
    if (t instanceof ConsolePane && t.file.dirty) {
      const ok = await confirmDialog("Close without saving?", `${t.title} has unsaved changes. Close it anyway? (Cancel, then ${shortcutLabel("saveFile") || "Save"} to keep them.)`, "Close without saving", true);
      if (!ok) return;
    }
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
    this.saveWorkspaceSoon();
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
    // DDL / designer tabs (v0.16) are reopened from the explorer, not by "Reopen closed tab".
    if (t.kind === "ddl" || t.kind === "design") return;
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
      file: c ? c.file.memo() : null,
      sessions: t instanceof SessionsPane ? t.snapshot() : undefined,
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
      const pane = await this.openConsole(c.connId, { sql: c.sql, title: c.title, table: c.table ?? undefined, database: c.database, schema: c.schema }, c.name);
      // v0.17: back on the same .sql file (path, baseline, mtime, unsaved changes), so Save and FILE_CHANGED still work
      if (pane && c.file) pane.file.adopt(c.file);
      return;
    }
    if (c.kind === "sessions") {
      await this.openSessions(c.connId, c.sessions ?? null);
      if (c.name && this.active) this.strip.setManualName(this.active, c.name);
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
          h("span", null, h("kbd", null, shortcutLabel("commandPalette")), " command palette"),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ commands: menu, palette, toolbar

  /**
   * One entry point for every command: native menu items (macOS, Tauri event "menu"), the in-app ☰ menu
   * (Windows / Linux), the command palette and the shortcuts that have no event of their own.
   */
  runCommand(id: string): void {
    const c = this.activeConsole();
    const needConsole = (): ConsolePane | null => {
      if (!c) toast("Open a console first", "info");
      return c;
    };
    switch (id as MenuCommand) {
      case "about":
        toast("DataTrip — a fast, lightweight database IDE", "info");
        return;
      case "settings":
        openSettings();
        return;
      case "keyboardShortcuts":
      case "helpShortcuts":
        openSettings("keymap");
        return;
      case "newConnection":
        this.addConnection();
        return;
      case "newConsole":
        void this.newConsole();
        return;
      case "newCrossSource":
        void this.newCrossSource();
        return;
      case "importDataGrip":
        this.importDataGrip();
        return;
      case "vaultProfiles":
        openVaultProfilesDialog();
        return;
      case "sshProfiles":
        openSshProfilesDialog();
        return;
      case "reopenTab":
        void this.reopenTab();
        return;
      case "closeTab":
        if (this.active) void this.closeTab(this.active);
        return;
      case "undo":
      case "redo":
      case "cut":
      case "copy":
      case "paste":
      case "selectAll":
        this.editCommand(id as "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll");
        return;
      case "find":
        return;
      case "tabsTop":
      case "tabsLeft":
      case "tabsRight": {
        const placement = id === "tabsTop" ? "top" : id === "tabsLeft" ? "left" : "right";
        updateSettings((s) => (s.tabs.placement = placement));
        return;
      }
      case "toggleSidebar":
        this.toggleSidebar();
        return;
      case "compactExplorer":
        this.explorer.toggleCompact();
        return;
      case "queryHistory":
        this.toggleHistory();
        return;
      case "commandPalette":
      case "helpPalette":
        this.openCommandPalette();
        return;
      case "saveFile":
        if (needConsole()) void c?.file.save();
        return;
      case "saveFileAs":
        if (needConsole()) void c?.file.saveAs();
        return;
      case "exportSelection":
        if (needConsole()) void c?.file.exportSelection();
        return;
      case "openFile":
        void openSqlFile();
        return;
      case "runSqlFile":
        if (c && !c.isLineBased) void runSqlFileFlow({ console: c });
        else void runSqlFileFlow({});
        return;
      case "help":
        openHelp();
        return;
      case "showDdl":
        showDdl();
        return;
      case "importData":
        importData();
        return;
      case "newTable":
        openDesigner(null, true);
        return;
      case "designTable":
        openDesigner(null, false);
        return;
      case "welcomeTour":
        startTour();
        return;
      case "checkUpdates":
        void checkForUpdates(true);
        return;
      case "runStatement":
        if (needConsole()) void c?.runCurrent();
        return;
      case "runAll":
        if (needConsole()) void c?.runAll();
        return;
      case "cancel":
        if (c?.isRunning) c.cancelRun();
        return;
      case "formatSql":
        if (needConsole() && c && !c.isLineBased) c.formatSql();
        return;
      case "explain":
        if (needConsole() && c && !c.isLineBased) void c.explain();
        return;
      case "sessions": {
        const cid = this.active?.connId ?? this.selectedConn;
        if (cid) void this.openSessions(cid);
        else toast("Select a data source first", "info");
        return;
      }
      case "snippets":
        openSettings("snippets");
        return;
      case "askAi":
        this.askAi();
        return;
      case "attachSource":
        if (needConsole()) c?.openAttach();
        return;
      case "crossSourceGuide":
        if (c && !c.isLineBased) c.showGuide();
        else void this.newCrossSource();
        return;
      case "reconnect": {
        const cid = this.active?.connId ?? this.selectedConn;
        if (cid) void this.explorer.reconnect(cid);
        else toast("Select a data source to reconnect", "info");
        return;
      }
      case "nextTab":
      case "prevTab":
        this.cycleTab(id === "nextTab" ? 1 : -1);
        return;
      case "jumpToTab":
        this.strip.jump();
        return;
    }
  }

  /**
   * Ask AI: the AI assistant hooks the window event `dt-action` (`detail.id === "askAi"`) and calls
   * preventDefault() when it handled it.
   */
  private askAi(): void {
    const ev = new CustomEvent("dt-action", { detail: { id: "askAi" }, cancelable: true });
    if (window.dispatchEvent(ev)) toast("Ask AI isn't available in this build", "info");
  }

  private cycleTab(d: number): void {
    const list = this.strip.ordered();
    if (list.length === 0) return;
    const i = this.active ? list.indexOf(this.active) : -1;
    const next = list[(i + d + list.length) % list.length];
    if (next) this.activate(next);
  }

  /** Shortcuts that must win over CodeMirror's own bindings (⌘I selects the parent syntax node there). */
  private onKeyCapture(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    const a = matchAction(e);
    if (a !== "commandPalette" && a !== "askAi") return;
    // Dialogs (the keymap recorder in Settings among them) keep their keys.
    if (document.querySelector(".overlay:not(.leaving)")) return;
    e.preventDefault();
    e.stopPropagation();
    this.runCommand(a);
  }

  /** In-app Edit commands (Windows / Linux ☰ menu): act on whatever had focus before the menu opened. */
  private editCommand(cmd: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll"): void {
    const t = this.menuFocus;
    this.menuFocus = null;
    const c = this.activeConsole();
    const inConsole = t !== null && c !== null && c.el.contains(t) && t.closest(".c-editor") !== null;
    if (t?.isConnected) t.focus();
    if (cmd === "undo" || cmd === "redo") {
      if (c && (inConsole || !this.inEditable(t))) {
        if (cmd === "undo") c.undo();
        else c.redo();
      } else document.execCommand(cmd);
      return;
    }
    if (cmd === "paste") {
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) document.execCommand("insertText", false, text);
        })
        .catch(() => toast(`Paste with ${formatBinding("Mod-V")}`, "info"));
      return;
    }
    document.execCommand(cmd);
  }

  private consoleTitle(base: string, connId: string): string {
    const used = new Set(this.tabs.filter((t) => t.kind === "console" && t.connId === connId).map((t) => t.title));
    let n = 1;
    while (used.has(n === 1 ? base : `${base} ${n}`)) n++;
    return n === 1 ? base : `${base} ${n}`;
  }

  /**
   * New cross-source console over `ids` (≥ 2 SQL data sources; the first is the console's own source). Without
   * them, a picker asks (starting with the active data source checked).
   */
  private async newCrossSource(ids?: string[]): Promise<void> {
    let list = ids && ids.length >= 2 ? ids : null;
    if (!list) {
      const cur = this.active?.connId ?? this.selectedConn;
      const pre = ids ?? (cur && FED_DRIVERS.has(store.conns.get(cur)?.config.driver ?? "redis") ? [cur] : []);
      list = await pickCrossSources(pre);
      if (!list || list.length < 2) return;
    }
    const [own, ...others] = list;
    const pane = await this.openConsole(own, { title: this.consoleTitle("cross-source", own) });
    pane?.setupCrossSource(others);
  }

  private openCommandPalette(): void {
    if (isPaletteOpen()) return;
    closeMenu();
    openPalette(this.paletteItems());
  }

  private paletteItems(): PaletteItem[] {
    const out: PaletteItem[] = [];
    const c = this.activeConsole();
    const act = (id: MenuCommand, label: string, ic: string, hint = "", keywords = "", disabled = false): void => {
      out.push({ group: "Actions", label, icon: ic, hint, keywords, disabled, run: () => this.runCommand(id) });
    };
    const k = shortcutLabel;
    const cur = this.active?.connId ?? this.selectedConn;
    const curName = cur ? store.conns.get(cur)?.config.name : undefined;
    act("settings", "Settings", "sliders", k("settings"), "preferences options");
    act("runStatement", "Run statement", "run", k("runStatement"), "execute", !c);
    act("runAll", "Run all", "playAll", k("runAll"), "execute", !c);
    act("cancel", "Cancel query", "stop", k("cancel"), "stop", !c?.isRunning);
    act("askAi", "Ask AI to write a query", "sparkle", k("askAi"), "assistant llm");
    act("newCrossSource", "New cross-source console", "layers", "", "federated join several data sources");
    act("attachSource", "Attach source to this console…", "layers", "", "cross-source federated", !c || c.isLineBased);
    act("crossSourceGuide", "How do cross-source queries work?", "layers", "", "guide help example");
    act("checkUpdates", "Check for updates…", "refresh", "", "update upgrade new version release");
    act("reconnect", curName ? `Reconnect ${curName}` : "Reconnect data source", "refresh", k("reconnect"), "connection", !cur);
    act("formatSql", "Format SQL", "sort", k("formatSql"), "beautify pretty", !c || c.isLineBased);
    act("explain", "Explain plan", "layers", k("explain"), "explain analyze query plan performance index slow", !c || c.isLineBased);
    act("sessions", curName ? `Sessions & locks of ${curName}` : "Sessions & locks", "server", "", "processlist activity blocking kill cancel running queries locks", !cur);
    act("snippets", "Snippets…", "sliders", "", "live templates abbreviation expand settings");
    act("newConsole", "New console", "terminal", k("newConsole"));
    act("newConnection", "New connection…", "plus", "", "data source add");
    act("importDataGrip", "Import from DataGrip…", "download", "", "data sources");
    act("vaultProfiles", "Vault profiles…", "key", "", "token oidc hashicorp");
    act("sshProfiles", "SSH configurations…", "server", "", "tunnel jump host");
    act("queryHistory", "Query history", "clock", formatBinding("Mod-Shift-H"), "recent statements");
    act("reopenTab", "Reopen closed tab", "undo", k("reopenTab"));
    act("closeTab", "Close tab", "x", k("closeTab"), "", !this.active);
    act("nextTab", "Next tab", "chevron", k("nextTab"));
    act("prevTab", "Previous tab", "chevron", k("prevTab"));
    act("jumpToTab", "Jump to tab…", "search", k("jumpToTab"));
    act("toggleSidebar", this.sidebarHidden ? "Show sidebar" : "Hide sidebar", "sidebar", k("toggleSidebar"), "explorer");
    act("compactExplorer", this.explorer.compact ? "Comfortable explorer" : "Compact explorer", "sliders", "", "density");
    const place = getSettings().tabs.placement;
    if (place !== "top") act("tabsTop", "Tabs on top", "sidebar", "", "placement");
    if (place !== "left") act("tabsLeft", "Tabs on the left", "sidebar", "", "placement rail");
    if (place !== "right") act("tabsRight", "Tabs on the right", "sidebar", "", "placement rail");
    act("keyboardShortcuts", "Keyboard shortcuts…", "sliders", "", "keymap bindings");
    act("saveFile", "Save SQL file", "download", k("saveFile"), "write disk", !c);
    act("saveFileAs", "Save SQL file as…", "download", k("saveFileAs"), "write disk rename", !c);
    act("exportSelection", "Export selection as .sql…", "download", "", "save file", !c);
    act("openFile", "Open SQL file…", "folder", k("openFile"), "load script disk");
    act("runSqlFile", "Run SQL file on a data source…", "playAll", "", "execute script seed dump import batch");
    act("help", "Help", "search", k("help"), "documentation docs guide manual how troubleshooting");
    act("showDdl", "Show DDL of the selected object", "view", k("showDdl"), "create statement definition source script table view function");
    act("importData", "Import data (CSV / JSON) into a table…", "download", "", "csv tsv json ndjson load upload file wizard");
    act("newTable", "New table…", "plus", "", "create table designer schema");
    act("designTable", "Edit table (table designer)…", "pencil", "", "alter table designer columns indexes foreign keys");
    act("welcomeTour", "Welcome tour", "sparkle", "", "intro help onboarding");
    for (const p of getSettings().files.recent) {
      const name = p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
      out.push({ group: "Recent files", label: name, icon: "folder", detail: p, keywords: "recent sql file", run: () => void openSqlFile(p) });
    }
    for (const e of store.list()) {
      const id = e.config.id;
      out.push({
        group: "Data sources",
        label: e.config.name,
        icon: "database",
        detail: DRIVER_LABELS[e.config.driver].split(" / ")[0] + (e.status === "connected" ? " · connected" : "") + (prodOptions(e.config) ? " · PROD" : ""),
        hint: "open console",
        keywords: e.config.folder ?? "",
        run: () => void this.openConsole(id),
      });
    }
    for (const t of this.strip.ordered()) {
      const e = store.conns.get(t.connId);
      out.push({ group: "Open tabs", label: autoName(t), icon: t.kind === "console" ? "terminal" : t.kind === "key" ? "key" : t.kind === "topic" ? "topic" : t.kind === "sessions" ? "server" : t.kind === "ddl" ? "view" : t.kind === "design" ? "table" : "group", detail: e?.config.name, run: () => this.activate(t) });
    }
    // Tables: only what the explorer already loaded (nothing is fetched for the palette).
    let n = 0;
    for (const e of store.list()) {
      if (e.status !== "connected" || !FED_DRIVERS.has(e.config.driver)) continue;
      const seen = new Set<string>();
      const dbs: { db: string | null; schemas: SchemaNode[] }[] = [{ db: e.defaultDb, schemas: e.schemas }];
      for (const d of e.dbs.values()) if (d.status === "ready" && d.name !== e.defaultDb) dbs.push({ db: d.name, schemas: d.schemas });
      for (const { db, schemas } of dbs) {
        if (seen.has(db ?? "")) continue;
        seen.add(db ?? "");
        for (const s of schemas) {
          for (const tb of s.tables) {
            if (++n > 5000) break;
            const id = e.config.id;
            const consoleDb = db === e.defaultDb ? null : db;
            const q = qualifiedName(e.config.driver, s.name, tb.name);
            const path = [db, s.name].filter((x, i, a) => x && (i === 0 || x !== a[0])).join(".");
            out.push({
              group: "Tables",
              label: tb.name,
              icon: tb.kind === "view" ? "view" : tb.kind === "materialized" ? "matview" : "table",
              detail: `${path} · ${e.config.name}`,
              run: () => void this.openConsole(id, { sql: `SELECT * FROM ${q} `, run: true, title: tb.name, table: tb.name, database: consoleDb, schema: s.name }),
            });
          }
        }
      }
    }
    return out;
  }

  /** The menu structure of the in-app ☰ menu (Windows / Linux); the native macOS menu in lib.rs mirrors it. */
  private menuSections(): AppMenuSection[] {
    const k = shortcutLabel;
    const c = this.activeConsole();
    const place = getSettings().tabs.placement;
    const sep: AppMenuEntry = { sep: true };
    return [
      {
        label: "DataTrip",
        items: [{ id: "settings", label: "Settings…", hint: k("settings") }, { id: "keyboardShortcuts", label: "Keyboard shortcuts…" }],
      },
      {
        label: "File",
        items: [
          { id: "newConnection", label: "New connection…" },
          { id: "newConsole", label: "New console", hint: k("newConsole") },
          { id: "newCrossSource", label: "New cross-source console" },
          sep,
          { id: "openFile", label: "Open SQL file…", hint: k("openFile") },
          { id: "saveFile", label: "Save", hint: k("saveFile"), disabled: !c },
          { id: "saveFileAs", label: "Save as…", hint: k("saveFileAs"), disabled: !c },
          { id: "exportSelection", label: "Export selection as .sql…", disabled: !c },
          { id: "runSqlFile", label: "Run SQL file on a data source…" },
          { id: "importData", label: "Import data…" },
          { id: "newTable", label: "New table…" },
          { id: "showDdl", label: "Show DDL", hint: k("showDdl") },
          sep,
          { id: "importDataGrip", label: "Import from DataGrip…" },
          { id: "vaultProfiles", label: "Vault profiles…" },
          { id: "sshProfiles", label: "SSH configurations…" },
          sep,
          { id: "reopenTab", label: "Reopen closed tab", hint: k("reopenTab") },
          { id: "closeTab", label: "Close tab", hint: k("closeTab"), disabled: !this.active },
        ],
      },
      {
        label: "Edit",
        items: [
          { id: "undo", label: "Undo", hint: k("undo") },
          { id: "redo", label: "Redo", hint: k("redo") },
          sep,
          { id: "cut", label: "Cut", hint: formatBinding("Mod-X") },
          { id: "copy", label: "Copy", hint: formatBinding("Mod-C") },
          { id: "paste", label: "Paste", hint: formatBinding("Mod-V") },
          { id: "selectAll", label: "Select all", hint: formatBinding("Mod-A") },
        ],
      },
      {
        label: "View",
        items: [
          { id: "tabsTop", label: "Tabs on top", checked: place === "top" },
          { id: "tabsLeft", label: "Tabs on the left", checked: place === "left" },
          { id: "tabsRight", label: "Tabs on the right", checked: place === "right" },
          sep,
          { id: "toggleSidebar", label: "Show sidebar", hint: k("toggleSidebar"), checked: !this.sidebarHidden },
          { id: "compactExplorer", label: "Compact explorer", checked: this.explorer.compact },
          sep,
          { id: "queryHistory", label: "Query history", hint: formatBinding("Mod-Shift-H") },
          { id: "commandPalette", label: "Command palette…", hint: k("commandPalette") },
        ],
      },
      {
        label: "Console",
        items: [
          { id: "runStatement", label: "Run statement", hint: k("runStatement"), disabled: !c },
          { id: "runAll", label: "Run all", hint: k("runAll"), disabled: !c },
          { id: "cancel", label: "Cancel query", hint: k("cancel"), disabled: !c?.isRunning },
          sep,
          { id: "formatSql", label: "Format SQL", hint: k("formatSql"), disabled: !c || c.isLineBased },
          { id: "askAi", label: "Ask AI…", hint: k("askAi") },
          { id: "explain", label: "Explain plan", hint: k("explain"), disabled: !c || c.isLineBased },
          sep,
          { id: "attachSource", label: "Attach source…", disabled: !c || c.isLineBased },
          sep,
          { id: "reconnect", label: "Reconnect data source", hint: k("reconnect") },
          { id: "sessions", label: "Sessions & locks" },
        ],
      },
      {
        label: "Window",
        items: [
          { id: "nextTab", label: "Next tab", hint: k("nextTab") },
          { id: "prevTab", label: "Previous tab", hint: k("prevTab") },
          { id: "jumpToTab", label: "Jump to tab…", hint: k("jumpToTab") },
        ],
      },
      {
        label: "Help",
        items: [
          { id: "help", label: "DataTrip help", hint: k("help") },
          { id: "welcomeTour", label: "Welcome tour" },
          sep,
          { id: "keyboardShortcuts", label: "Keyboard shortcuts…" },
          { id: "crossSourceGuide", label: "Cross-source queries guide" },
          { id: "commandPalette", label: "Command palette…", hint: k("commandPalette") },
          { id: "checkUpdates", label: "Check for updates…" },
        ],
      },
    ];
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
        return;
      case "formatSql": {
        // In the console's editor or with focus outside any text field (grid, tab strip); not in other inputs.
        const inEditor = e.target instanceof HTMLElement && c !== null && c.el.contains(e.target) && e.target.closest(".c-editor") !== null;
        if (!c || (editable && !inEditor) || c.isLineBased) return;
        e.preventDefault();
        c.formatSql();
        return;
      }
      case "explain": {
        // v0.16: in the console's editor or with focus outside any text field
        const inEditor = e.target instanceof HTMLElement && c !== null && c.el.contains(e.target) && e.target.closest(".c-editor") !== null;
        if (!c || (editable && !inEditor) || c.isLineBased) return;
        e.preventDefault();
        void c.explain();
        return;
      }
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
      case "saveFile":
      case "saveFileAs": {
        // The result grid handles ⌘S itself (submit edits) and prevents the default first.
        e.preventDefault();
        if (!c) return;
        if (a === "saveFile") void c.file.save();
        else void c.file.saveAs();
        return;
      }
      case "openFile":
        e.preventDefault();
        void openSqlFile();
        return;
      case "help":
        e.preventDefault();
        if (!isHelpOpen()) openHelp();
        return;
      case "showDdl":
        // Not while typing in a text field (the editor keeps its own keys).
        if (editable) return;
        e.preventDefault();
        showDdl();
        return;
    }
  }
}

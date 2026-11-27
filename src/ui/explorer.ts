// Left sidebar card: brand, filter and a lazy, virtualized DataGrip-style tree:
// connection -> databases (+ System databases) / Server objects -> schemas -> Tables / Views /
// Materialized views / Routines / Sequences -> table -> Columns / Keys / Foreign keys / Indexes.
import { api } from "../api";
import type { DatabaseNode, ForeignKeyNode, IndexNode, RedisKey, RoutineNode, SchemaNode, TableNode } from "../types";
import { DRIVER_LABELS } from "../types";
import { brandMark, clear, errMsg, h, icon } from "./dom";
import { showMenu } from "./menu";
import type { ConnEntry } from "./state";
import { store } from "./state";
import { qualifiedName } from "./sqlutil";
import { toast } from "./toast";
import { humanSize } from "./format";
import type { Density } from "./prefs";
import { ROW_HEIGHT, getCollapsedFolders, getDensity, pushRecent, renameCollapsedFolder, setDensity, setFolderCollapsed } from "./prefs";
import { dbVisible, folderNames, onScopeChange, schemaVisible, scopeLabel, scopeSummary, setFolder, setFolderForMany } from "./scope";
import { openScopePicker } from "./scopePicker";
import { DRIVER_ABBR, dataBadge, hasIcon, svgIcon } from "./icons";
import type { DropZone } from "./layout";
import { canDrop, canShift, connFolder, connKey, dropOn, folderKey, folderMeta, onLayoutChange, renameFolderLayout, setConnLook, setFolderLook, shift, sortFolder, topItems, ungroupFolderLayout } from "./layout";
import { closeLookPicker, openLookPicker } from "./lookPicker";
import { promptDialog } from "./prompt";
import { confirmDialog } from "./confirm";
import type { TNode } from "./redis";
import { KeyTrie, dbLabel, leafName, parseTtlInput, redisDbMeta, sentinelLabel, ttlLong, ttlShort, typeInfo } from "./redis";
import { collate, forgetOverview, loadOverview, onOverview, overviewOf, overviewState, stateClass, stateLabel } from "./kafka";
import { deleteTopicFlow, openCreateTopicDialog } from "./kafkaDialogs";
import { handleActionError } from "./recovery";
import { openSshProfilesDialog } from "./sshDialog";
import { vaults } from "./vault";
import { assignVaultProfile } from "./vaultAssign";
import { VaultChips } from "./vaultChips";
import { openVaultProfilesDialog } from "./vaultDialog";
import { getSettings, onSettingsChange, updateSettings } from "./settings";
import { openSettings } from "./settingsDialog";
import { formatBinding, shortcutLabel } from "./keymap";
import { FED_DRIVERS, TABLE_DRAG_MIME, setTableDrag, sourceRef } from "./federation";
import { prodOptions, prodTagClass } from "./prodSafety";
import type { TableDrag } from "./federation";
import { importData, openDesigner, showDdl } from "./dataActions";
import type { DbTarget } from "./dataTools";

const OVERSCAN = 8;
const GEAR_PATH =
  "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z";
/** Indent (px) per tree depth: compact = 12 per level (spec); comfortable keeps 0 / 16 / 30, then +14. */
const indentOf = (d: number, density: Density): number => (density === "compact" ? d * 12 : d <= 0 ? 0 : 16 + (d - 1) * 14);
const DRAG_MIME = "application/x-datatrip-conn";
const IS_MAC = /Mac/.test(navigator.userAgent);
const ALT_UP = IS_MAC ? "⌥↑" : "Alt+↑";
const ALT_DOWN = IS_MAC ? "⌥↓" : "Alt+↓";
const EDGE_ZONE = 36;
const STATUS_TEXT: Record<string, string> = { idle: "not connected", connecting: "connecting…", connected: "connected", error: "connection failed" };

export interface OpenConsoleOpts {
  sql?: string;
  run?: boolean;
  title?: string;
  /** Database to bind the console to (null / undefined = the connection's default). */
  database?: string | null;
  /** Schema to default completion to. */
  schema?: string | null;
  /** The schema was chosen by the user (navigator): PostgreSQL consoles also get a search_path. */
  explicitSchema?: boolean;
  /** The console was opened on this table / view (tab names: "orders · shop"). */
  table?: string;
}

export interface ExplorerHost {
  openConsole(connId: string, opts?: OpenConsoleOpts): void;
  addConnection(): void;
  importDataGrip(): void;
  editConnection(id: string): void;
  deleteConnection(id: string): void;
  copy(text: string): void;
  onSelect(connId: string): void;
  /** Redis: open a key in a key tab. */
  openKey(connId: string, db: string, key: string, keyType: string): void;
  /** Redis: keys were deleted from the explorer (open key tabs mark themselves gone). */
  keysDeleted(connId: string, db: string, keys: string[]): void;
  /** Redis: a key's TTL changed from the explorer (an open key tab reloads). */
  keyTouched(connId: string, db: string, key: string): void;
  /** Kafka: open a topic / consumer group tab. */
  openTopic(connId: string, topic: string): void;
  openGroup(connId: string, groupId: string): void;
  /** Kafka: open the produce dialog for a topic. */
  produceTo(connId: string, topic: string): void;
  /** Kafka: a topic was deleted from the explorer (its tab closes). */
  topicDeleted(connId: string, topic: string): void;
  /** Sidebar toolbar: Query history. */
  toggleHistory(): void;
  /** Sidebar toolbar: the ⌘K pill. */
  openPalette(): void;
  /** Multi-selection → "New cross-source console (N sources)": SQL data sources, in selection order. */
  newCrossSource(connIds: string[]): void;
  /** Data source menu › Run SQL file… (v0.15). */
  runSqlFile(connId: string): void;
  /** Data source menu › Sessions & locks (v0.16). */
  openSessions?(connId: string): void;
  /** Sidebar toolbar: ? (help center). */
  openHelp(): void;
}

/** Per (connection, database) Redis scan state behind the namespace tree. */
interface RedisState {
  sid: string;
  pattern: string;
  trie: KeyTrie;
  cursor: string;
  done: boolean;
  loading: boolean;
  error: string | null;
  /** Bumped on reset so late scan replies are dropped. */
  gen: number;
}

const SCAN_COUNT = 500;
/** A "page" of the namespace tree: scan until at least this many new keys (or the scan ends). */
const PAGE_KEYS = 100;
const MAX_SCAN_STEPS = 60;

interface RowSpec {
  key: string;
  label: string;
  icon?: string;
  iconCls?: string;
  badge?: HTMLElement;
  meta?: string;
  metaMono?: boolean;
  /** Extra class on the meta text (Kafka group states). */
  metaCls?: string;
  tag?: string;
  /** Extra class on the tag chip (Redis key types). */
  tagCls?: string;
  /** A Redis database row: kept visible, and its tree unfiltered, while the explorer filter drives the SCAN pattern. */
  redisDb?: boolean;
  expandable?: boolean;
  children?: () => RowSpec[];
  cls?: string;
  title?: string;
  actions?: HTMLElement[];
  onClick?: (e: MouseEvent, spec: RowSpec) => void;
  onDbl?: () => void;
  onContext?: (e: MouseEvent) => void;
  /** Called when the user opens the row (lazy loading, default child expansion). */
  onOpen?: () => void;
  /** Called after the row was expanded / collapsed by the user. */
  onToggle?: (open: boolean) => void;
  /** Right-aligned control after the meta text (the scope chip). */
  chip?: HTMLElement;
  /** Connection id this row can be dragged by (onto a folder row). */
  dragConn?: string;
  /** Folder name this row accepts dropped connections for. */
  dropFolder?: string;
  /** Layout key ("conn:<id>" / "folder:<name>") of a row that can be dragged and reordered. */
  dragKey?: string;
  /** A table / view row: dragged into a console it inserts its name (attaching its data source when needed). */
  dragTable?: TableDrag;
  /** v0.16: the object Show DDL / Edit table / Import data act on (⌥⌘D uses the selected row's). */
  target?: DbTarget;
  /** Connection id of a connection row (⌘/Ctrl-click multi-selection). */
  multiConn?: string;
  /** Folder appearance: icon stroked and name tinted in the folder's color. */
  look?: { color: string | null; icon: string | null };
}

interface DragState {
  key: string;
  isFolder: boolean;
  cancelled: boolean;
}
interface DropState {
  idx: number;
  zone: DropZone;
  key: string;
}

interface Flat {
  spec: RowSpec;
  depth: number;
  open: boolean;
}

export class Explorer {
  readonly el: HTMLElement;
  private tree: HTMLElement;
  private inner: HTMLElement;
  private filterInput: HTMLInputElement;
  private expanded = new Set<string>();
  private autoOpened = new Set<string>();
  private selected = "";
  private filter = "";
  /** The filter as typed (case kept): Redis SCAN patterns are case-sensitive. */
  private filterRaw = "";
  private redisSt = new Map<string, RedisState>();
  private rescanTimer: number | undefined;
  private flat: Flat[] = [];
  private rendered = new Map<number, HTMLElement>();
  private scrollQueued = false;
  private drag: DragState | null = null;
  private drop: DropState | null = null;
  private lastY = 0;
  private scrollRaf = 0;
  private pendingRender = false;
  private dropLine: HTMLElement = h("div", { class: "drop-line", "aria-hidden": "true", hidden: true });
  private density: Density = getDensity();
  private rowH = ROW_HEIGHT[getDensity()];
  /** ⌘/Ctrl-click multi-selection of data sources, in the order they were picked. */
  private multi: string[] = [];

  constructor(private host: ExplorerHost) {
    this.filterInput = h("input", {
      type: "search",
      placeholder: "Filter",
      "aria-label": "Filter data sources and tables",
      spellcheck: false,
      oninput: () => this.applyFilter(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Escape" && this.filterInput.value) {
          e.stopPropagation();
          this.filterInput.value = "";
          this.applyFilter();
        }
      },
    });
    this.inner = h("div", { class: "tree-inner" });
    this.tree = h("div", { class: "tree", role: "tree", tabindex: "0", "aria-label": "Connections" }, this.inner);
    this.tree.addEventListener("keydown", (ev) => this.onTreeKey(ev));
    this.tree.addEventListener("dragover", (ev) => this.onDragOver(ev));
    this.tree.addEventListener("dragleave", (ev) => {
      if (!ev.relatedTarget || !this.tree.contains(ev.relatedTarget as Node)) this.clearDrop();
    });
    this.tree.addEventListener("drop", (ev) => this.onDrop(ev));
    window.addEventListener("dragend", () => this.endDrag());
    window.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key === "Escape" && this.drag) {
          this.drag.cancelled = true;
          this.clearDrop();
        }
      },
      true,
    );
    this.tree.addEventListener("scroll", () => {
      if (this.scrollQueued) return;
      this.scrollQueued = true;
      requestAnimationFrame(() => {
        this.scrollQueued = false;
        this.paintWindow(false);
      });
    });
    // The + only adds a data source; everything else lives in the toolbar at the bottom, the menu and ⌘K.
    const addBtn = h(
      "button",
      { class: "side-plus", type: "button", title: "New connection", "aria-label": "New connection", onclick: () => host.addConnection() },
      icon("plus", 14),
    );
    // macOS draws the traffic lights over this strip (titleBarStyle Overlay); it doubles as a drag handle and
    // carries the logo mark. Windows/Linux have native title bars: the strip is hidden and the logo moves
    // into the filter row.
    const strip = h("div", { class: "traffic-strip", "data-tauri-drag-region": "" }, h("span", { class: "strip-fill", "data-tauri-drag-region": "" }), brandMark(18));
    this.el = h(
      "aside",
      { class: "sidebar" },
      strip,
      h(
        "div",
        { class: "side-top" },
        h("span", { class: "side-logo", "aria-hidden": "true" }, brandMark(18)),
        h("label", { class: "side-search" }, icon("search", 12), this.filterInput),
        addBtn,
      ),
      new VaultChips().el,
      this.tree,
      this.toolbar(),
    );
    this.el.setAttribute("aria-label", "Explorer");
    this.applyDensity();
    // Density lives in the app settings (Settings › Appearance); follow changes made there.
    onSettingsChange((st) => {
      if (st.appearance.density !== this.density) {
        this.density = st.appearance.density;
        this.applyDensity();
        this.render();
      }
    });
    onScopeChange(() => this.render());
    onLayoutChange(() => this.render());
    store.subscribe(() => this.render());
    onOverview(() => this.render());
    new ResizeObserver(() => this.paintWindow(false)).observe(this.tree);
  }

  private applyFilter(): void {
    this.filterRaw = this.filterInput.value.trim();
    this.filter = this.filterRaw.toLowerCase();
    this.render();
    // Redis trees are filtered by the server (SCAN MATCH): rescan the open databases once typing pauses.
    window.clearTimeout(this.rescanTimer);
    this.rescanTimer = window.setTimeout(() => {
      for (const e of store.list()) {
        if (e.config.driver !== "redis" || e.status !== "connected") continue;
        for (const d of e.databases) if (this.expanded.has(`d:${e.config.id}:${d.name}`)) void this.loadRedis(e, d.name);
      }
    }, 250);
  }

  /** ↑ ↓ move the selection, → / ← expand / collapse, ↵ activates (opens a key, toggles a folder). */
  private onTreeKey(ev: KeyboardEvent): void {
    if (ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
      const key = this.selectedMoveKey();
      if (!key) return;
      ev.preventDefault();
      this.moveSelected(key, ev.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (ev.target !== this.tree || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter"].includes(ev.key)) return;
    if (this.flat.length === 0) return;
    ev.preventDefault();
    let i = this.flat.findIndex((f) => f.spec.key === this.selected);
    if (i < 0) i = 0;
    const cur = this.flat[i];
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      const n = Math.max(0, Math.min(this.flat.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)));
      this.selected = this.flat[n].spec.key;
      const top = n * this.rowH;
      if (top < this.tree.scrollTop) this.tree.scrollTop = top;
      else if (top + this.rowH > this.tree.scrollTop + this.tree.clientHeight) this.tree.scrollTop = top + this.rowH - this.tree.clientHeight;
      this.render();
    } else if (ev.key === "ArrowRight") {
      if (cur.spec.expandable && !cur.open) this.toggle(cur.spec);
    } else if (ev.key === "ArrowLeft") {
      if (cur.spec.expandable && cur.open) this.toggle(cur.spec);
    } else {
      this.selected = cur.spec.key;
      if (cur.spec.onClick) cur.spec.onClick(new MouseEvent("click"), cur.spec);
      else if (cur.spec.expandable) this.toggle(cur.spec);
    }
  }

  private applyDensity(): void {
    this.rowH = ROW_HEIGHT[this.density];
    this.el.classList.toggle("compact", this.density === "compact");
    this.el.classList.toggle("comfortable", this.density === "comfortable");
    this.el.style.setProperty("--row-h", this.rowH + "px");
  }

  private setDensity(d: Density): void {
    if (d === this.density) return;
    this.density = d;
    setDensity(d);
    if (getSettings().appearance.density !== d) updateSettings((st) => (st.appearance.density = d));
    this.applyDensity();
    this.render();
  }

  // ------------------------------------------------------------------ expansion

  /** Opens the connection, its default database, that database's default schema and its tables. */
  expandConnection(id: string): void {
    this.expanded.add("c:" + id);
    const e = store.conns.get(id);
    if (e?.config.driver === "kafka") {
      void loadOverview(id);
      for (const k of [`kf:t:${id}`, `kf:g:${id}`]) {
        if (this.autoOpened.has(k)) continue;
        this.autoOpened.add(k);
        this.expanded.add(k);
      }
    }
    if (e?.defaultDb) this.openDatabaseDefaults(e, e.defaultDb);
    this.render();
  }

  private skipSchemaLevel(e: ConnEntry): boolean {
    return e.config.driver === "mysql" || e.config.driver === "sqlite";
  }

  private openDatabaseDefaults(e: ConnEntry, db: string): void {
    const id = e.config.id;
    const dkey = `d:${id}:${db}`;
    if (this.autoOpened.has(dkey)) return;
    const d = e.dbs.get(db);
    if (!d || d.status !== "ready") return;
    this.autoOpened.add(dkey);
    this.expanded.add(dkey);
    if (e.config.driver === "redis") {
      void this.loadRedis(e, db);
      return;
    }
    const schemas = d.schemas.filter((s) => schemaVisible(e, db, s.name));
    const ds = store.defaultSchemaFor(id, db === e.defaultDb ? null : db);
    const pick = (ds && schemas.find((s) => s.name === ds)?.name) ?? (schemas.find((s) => s.name === "public") ?? schemas[0])?.name;
    if (!pick) return;
    if (!this.skipSchemaLevel(e)) this.expanded.add(`s:${id}:${db}:${pick}`);
    this.expanded.add(`f:${id}:${db}:${pick}:tables`);
  }

  private toggle(spec: RowSpec): void {
    const key = spec.key;
    if (this.expanded.has(key)) {
      this.expanded.delete(key);
      spec.onToggle?.(false);
    } else {
      this.expanded.add(key);
      spec.onOpen?.();
      spec.onToggle?.(true);
    }
    this.render();
  }

  // ------------------------------------------------------------------ tree model

  private note(key: string, label: string, cls = ""): RowSpec {
    return { key, label, cls: "note " + cls };
  }

  private connSpec(e: ConnEntry): RowSpec {
    const id = e.config.id;
    const ckey = "c:" + id;
    const connected = e.status === "connected";
    const badge = dataBadge(e.config, "conn-badge " + e.status, this.density === "compact" ? 11 : 14, `${DRIVER_LABELS[e.config.driver]} · ${STATUS_TEXT[e.status]}`);
    const custom = hasIcon(e.config.icon);
    // How cross-source SQL names this data source (`asia32.postgres.users`).
    const sqlName = FED_DRIVERS.has(e.config.driver)
      ? sourceRef(
          { connId: id, name: e.config.name, driver: e.config.driver },
          store.list().filter((x) => FED_DRIVERS.has(x.config.driver)).map((x) => ({ connId: x.config.id, name: x.config.name, driver: x.config.driver })),
        )
      : null;
    const metaParts = [e.status === "connecting" ? "connecting…" : e.config.readOnly ? "read-only" : "", custom ? DRIVER_ABBR[e.config.driver] : ""].filter(Boolean);
    const actions: HTMLElement[] = [];
    if (connected) {
      actions.push(h("button", { class: "icon-btn xs", type: "button", title: "New console", "aria-label": "New console", onclick: (ev: Event) => (ev.stopPropagation(), this.host.openConsole(id)) }, icon("terminal", 13)));
      actions.push(h("button", { class: "icon-btn xs", type: "button", title: "Disconnect", "aria-label": "Disconnect", onclick: (ev: Event) => (ev.stopPropagation(), void this.disconnect(id)) }, icon("unplug", 13)));
    } else if (e.status !== "connecting") {
      actions.push(h("button", { class: "icon-btn xs", type: "button", title: "Connect", "aria-label": "Connect", onclick: (ev: Event) => (ev.stopPropagation(), void this.connect(id)) }, icon("plug", 13)));
    }
    return {
      key: ckey,
      label: e.config.name,
      badge,
      meta: metaParts.length ? metaParts.reverse().join(" · ") : undefined,
      metaCls: custom ? "drv" : undefined,
      // v0.16: production data sources carry a colored PROD tag
      tag: prodOptions(e.config) ? "PROD" : undefined,
      tagCls: prodOptions(e.config) ? "prod-tag " + prodTagClass(prodOptions(e.config)?.color ?? "") : undefined,
      // Every connection shows a disclosure triangle: on an idle one it connects first.
      expandable: e.status !== "error" || connected,
      cls: "conn " + e.status,
      title:
        e.status === "error" && e.error
          ? e.error
          : `${e.config.name} — ${DRIVER_LABELS[e.config.driver]}${e.session ? " " + e.session.serverVersion : ""}${sentinelLabel(e.config) ? " · " + sentinelLabel(e.config) : ""}${sqlName ? `\nUse in SQL as ${sqlName}` : ""}`,
      actions,
      chip: connected && e.config.driver !== "sqlite" && e.config.driver !== "kafka" && scopeSummary(e).total > 0 ? this.chipEl(e) : undefined,
      dragConn: id,
      dragKey: connKey(id),
      multiConn: id,
      children: () => {
        if (!connected) return e.status === "error" && e.error ? [this.note(`err:${id}`, e.error, "err")] : [];
        return this.connChildren(e);
      },
      onClick: (ev, spec) => {
        this.host.onSelect(id);
        const onTwisty = ev.target instanceof Element && ev.target.closest(".twisty") !== null;
        if (connected) this.toggle(spec);
        else if (onTwisty && e.status === "idle") void this.connect(id);
        else this.render();
      },
      onDbl: () => {
        if (!connected) void this.connect(id);
        else this.host.openConsole(id);
      },
      onContext: (ev) => {
        if (this.multi.length > 1 && this.multi.includes(id)) this.multiMenu(ev);
        else {
          this.multi = [];
          this.connMenu(ev, e);
        }
      },
    };
  }

  private connChildren(e: ConnEntry): RowSpec[] {
    const id = e.config.id;
    if (e.config.driver === "kafka") return this.kafkaChildren(e);
    if (e.config.driver === "redis") {
      const dbs = e.databases.slice().sort((a, b) => Number(a.name) - Number(b.name));
      const out = dbs.filter((d) => dbVisible(e, d.name)).map((d) => this.redisDbSpec(e, d));
      if (out.length === 0) out.push(this.note(`rn:${id}`, "No databases shown — use the chip to pick some"));
      out.push(this.serverObjectsSpec(e));
      return out;
    }
    const dbs = e.databases.slice().sort((a, b) => Number(b.name === e.defaultDb) - Number(a.name === e.defaultDb));
    const user = dbs.filter((d) => !d.isSystem && dbVisible(e, d.name));
    const sys = dbs.filter((d) => d.isSystem);
    const out: RowSpec[] = user.map((d) => this.dbSpec(e, d));
    if (sys.length) {
      out.push({
        key: `sd:${id}`,
        label: "System databases",
        icon: "folder",
        meta: String(sys.length),
        expandable: true,
        cls: "group",
        children: () => sys.map((d) => this.dbSpec(e, d)),
      });
    }
    out.push(this.serverObjectsSpec(e));
    return out;
  }

  private serverObjectsSpec(e: ConnEntry): RowSpec {
    return {
      key: `so:${e.config.id}`,
      label: "Server objects",
      icon: "server",
      expandable: true,
      cls: "group",
      children: () => this.serverObjectGroups(e),
    };
  }

  private serverObjectGroups(e: ConnEntry): RowSpec[] {
    const id = e.config.id;
    if (e.serverObjects.length === 0) return [this.note(`so0:${id}`, "Nothing to show")];
    return e.serverObjects.map((g) => {
      const iconName = /role|user|login/i.test(g.label) ? "role" : /space/i.test(g.label) ? "tablespace" : "folder";
      return {
        key: `sg:${id}:${g.label}`,
        label: g.label,
        icon: "folder",
        meta: g.error ? undefined : String(g.items.length),
        expandable: true,
        cls: "group",
        children: () =>
          g.error
            ? [this.note(`sge:${id}:${g.label}`, `Not permitted: ${g.error}`)]
            : g.items.length === 0
              ? [this.note(`sg0:${id}:${g.label}`, "Empty")]
              : g.items.map((it) => ({
                  key: `si:${id}:${g.label}:${it.name}`,
                  label: it.name,
                  icon: iconName,
                  meta: it.detail ?? undefined,
                  title: it.detail ? `${it.name} — ${it.detail}` : it.name,
                  cls: "leaf",
                })),
      };
    });
  }

  private dbSpec(e: ConnEntry, d: DatabaseNode): RowSpec {
    const id = e.config.id;
    const key = `d:${id}:${d.name}`;
    const isDefault = d.name === e.defaultDb;
    const consoleDb = isDefault ? null : d.name;
    return {
      key,
      label: d.name,
      icon: "database",
      meta: humanSize(d.sizeBytes),
      expandable: true,
      cls: "db" + (isDefault ? " current" : ""),
      title: d.comment ? `${d.name} — ${d.comment}` : d.name,
      onOpen: () => void this.loadDb(e, d.name),
      children: () => {
        const entry = e.dbs.get(d.name);
        if (!entry || entry.status === "idle" || entry.status === "loading") return [this.note(`ld:${key}`, "Loading…")];
        if (entry.status === "error") return [this.note(`er:${key}`, entry.error ?? "Could not open database", "err")];
        if (this.skipSchemaLevel(e)) {
          const s = entry.schemas[0];
          return s ? this.schemaFolders(e, d.name, s) : [this.note(`em:${key}`, "Empty")];
        }
        if (entry.schemas.length === 0) return [this.note(`em:${key}`, "No schemas")];
        const ds = store.defaultSchemaFor(id, isDefault ? null : d.name);
        const shown = entry.schemas.filter((s) => schemaVisible(e, d.name, s.name));
        if (shown.length === 0) return [this.note(`hs:${key}`, "All schemas are hidden (see visible databases)")];
        return shown.map((s) => this.schemaSpec(e, d.name, s, s.name === ds));
      },
      onContext: (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "New console here", icon: "terminal", onClick: () => this.host.openConsole(id, { database: consoleDb }) },
          ...this.schemaLevelItems(e, d.name),
          { label: "Refresh", icon: "refresh", onClick: () => void this.refreshDb(id, d.name) },
          { sep: true },
          { label: "Copy name", icon: "copy", onClick: () => this.host.copy(d.name) },
        ]),
    };
  }

  /** v0.16: "New table…" / "Import data…" on a database row of MySQL / SQLite (no schema level). */
  private schemaLevelItems(e: ConnEntry, db: string): { label: string; icon: string; onClick: () => void }[] {
    if (!this.skipSchemaLevel(e)) return [];
    const schema = e.dbs.get(db)?.schemas[0]?.name ?? (e.config.driver === "sqlite" ? "main" : db);
    const t: DbTarget = { connId: e.config.id, database: db, schema, kind: "schema" };
    return [
      { label: "New table…", icon: "plus", onClick: () => openDesigner(t, true) },
      { label: "Import data…", icon: "download", onClick: () => importData(t) },
    ];
  }

  /** v0.16: the selected row's object (Show DDL ⌥⌘D, palette actions). */
  selectedTarget(): DbTarget | null {
    if (!this.selected) return null;
    return this.flat.find((f) => f.spec.key === this.selected)?.spec.target ?? null;
  }

  private async loadDb(e: ConnEntry, db: string): Promise<void> {
    await store.ensureDb(e.config.id, db);
    this.openDatabaseDefaults(e, db);
    this.render();
  }

  private schemaSpec(e: ConnEntry, db: string, s: SchemaNode, isDefault: boolean): RowSpec {
    const id = e.config.id;
    const key = `s:${id}:${db}:${s.name}`;
    const consoleDb = db === e.defaultDb ? null : db;
    return {
      key,
      label: s.name,
      icon: "schema",
      meta: isDefault ? "default" : undefined,
      expandable: true,
      cls: "schema",
      target: FED_DRIVERS.has(e.config.driver) ? { connId: id, database: db, schema: s.name, kind: "schema" } : undefined,
      children: () => this.schemaFolders(e, db, s),
      onContext: (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "New console", icon: "terminal", onClick: () => this.host.openConsole(id, { database: consoleDb, schema: s.name }) },
          { label: "New table…", icon: "plus", onClick: () => openDesigner({ connId: id, database: db, schema: s.name, kind: "schema" }, true) },
          { label: "Import data…", icon: "download", onClick: () => importData({ connId: id, database: db, schema: s.name, kind: "schema" }) },
          { label: "Refresh", icon: "refresh", onClick: () => void this.refreshDb(id, db) },
          { sep: true },
          { label: "Copy name", icon: "copy", onClick: () => this.host.copy(s.name) },
        ]),
    };
  }

  private schemaFolders(e: ConnEntry, db: string, s: SchemaNode): RowSpec[] {
    const id = e.config.id;
    const base = `f:${id}:${db}:${s.name}:`;
    const tables = s.tables.filter((t) => t.kind === "table");
    const views = s.tables.filter((t) => t.kind === "view");
    const mviews = s.tables.filter((t) => t.kind === "materialized");
    const folder = (k: string, label: string, ic: string, n: number, kids: () => RowSpec[]): RowSpec => ({
      key: base + k,
      label,
      icon: ic,
      meta: String(n),
      expandable: true,
      cls: "group",
      children: kids,
    });
    const out: RowSpec[] = [];
    if (tables.length) out.push(folder("tables", "Tables", "table", tables.length, () => tables.map((t) => this.tableSpec(e, db, s, t))));
    if (views.length) out.push(folder("views", "Views", "view", views.length, () => views.map((t) => this.tableSpec(e, db, s, t))));
    if (mviews.length) out.push(folder("mviews", "Materialized views", "matview", mviews.length, () => mviews.map((t) => this.tableSpec(e, db, s, t))));
    if (s.routines?.length) out.push(folder("routines", "Routines", "func", s.routines.length, () => s.routines.map((r) => this.routineSpec(base, r, e, db, s.name))));
    if (s.sequences?.length) {
      out.push(folder("seqs", "Sequences", "seq", s.sequences.length, () => s.sequences.map((q): RowSpec => {
          const target: DbTarget = { connId: id, database: db, schema: s.name, name: q, kind: "sequence" };
          return {
            key: `${base}seq:${q}`,
            label: q,
            icon: "seq",
            cls: "leaf",
            target,
            onContext: (ev: MouseEvent) =>
              showMenu(ev.clientX, ev.clientY, [
                { label: "Show DDL", icon: "view", hint: shortcutLabel("showDdl"), onClick: () => showDdl(target) },
                { label: "Copy name", icon: "copy", onClick: () => this.host.copy(q) },
              ]),
          };
        })));
    }
    if (out.length === 0) out.push(this.note(`em:${base}`, "Empty"));
    return out;
  }

  private routineSpec(base: string, r: RoutineNode, e: ConnEntry, db: string, schema: string): RowSpec {
    const sig = `${r.name}(${r.arguments ?? ""})`;
    const target: DbTarget = { connId: e.config.id, database: db, schema, name: r.name, kind: r.kind, arguments: r.arguments };
    return {
      target,
      onContext: (ev: MouseEvent) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "Show DDL", icon: "view", hint: shortcutLabel("showDdl"), onClick: () => showDdl(target) },
          { sep: true },
          { label: "Copy name", icon: "copy", onClick: () => this.host.copy(r.name) },
        ]),
      key: `${base}r:${sig}`,
      label: r.name,
      icon: r.kind === "procedure" ? "proc" : "func",
      meta: r.arguments ? `(${r.arguments})` : "()",
      metaMono: true,
      title: `${r.kind} ${sig}${r.returnType ? " → " + r.returnType : ""}`,
      cls: "leaf",
    };
  }

  private tableSpec(e: ConnEntry, db: string, s: SchemaNode, t: TableNode): RowSpec {
    const id = e.config.id;
    const key = `t:${id}:${db}:${s.name}:${t.name}`;
    const q = qualifiedName(e.config.driver, s.name, t.name);
    const consoleDb = db === e.defaultDb ? null : db;
    const openData = (): void => {
      pushRecent(id, { db, schema: s.name, name: t.name, kind: t.kind });
      this.host.openConsole(id, { sql: `SELECT * FROM ${q} `, run: true, title: t.name, table: t.name, database: consoleDb, schema: s.name });
    };
    const colsKey = `${key}:cols`;
    const fkLabel = (fk: ForeignKeyNode): string => `→ ${fk.refSchema && fk.refSchema !== s.name ? fk.refSchema + "." : ""}${fk.refTable}(${fk.refColumns.join(", ")})`;
    const ixTag = (ix: IndexNode): string | undefined => (ix.primary ? "PK" : ix.unique ? "unique" : undefined);
    const hasKids = t.columns.length > 0;
    const ddlTarget: DbTarget = { connId: id, database: db, schema: s.name, name: t.name, kind: t.kind };
    const sqlSrc = FED_DRIVERS.has(e.config.driver);
    const isTable = t.kind === "table";
    return {
      key,
      label: t.name,
      icon: t.kind === "view" ? "view" : t.kind === "materialized" ? "matview" : "table",
      expandable: hasKids,
      cls: "table",
      title: t.comment ? `${s.name}.${t.name} — ${t.comment}` : `${s.name}.${t.name}`,
      dragTable: FED_DRIVERS.has(e.config.driver) ? { connId: id, database: db, schema: s.name, table: t.name } : undefined,
      target: FED_DRIVERS.has(e.config.driver) ? ddlTarget : undefined,
      onOpen: () => this.expanded.add(colsKey),
      onClick: (ev, spec) => {
        if (ev.detail > 1) return;
        this.toggle(spec);
      },
      onDbl: () => {
        this.expanded.delete(key);
        this.render();
        openData();
      },
      onContext: (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "Open data", icon: "table", onClick: openData },
          { sep: true },
          ...(sqlSrc
            ? [
                { label: "Show DDL", icon: "view", hint: shortcutLabel("showDdl"), onClick: () => showDdl(ddlTarget) },
                ...(isTable
                  ? [
                      { label: "Edit table…", icon: "pencil", onClick: () => openDesigner(ddlTarget, false) },
                      { label: "Import data…", icon: "download", onClick: () => importData(ddlTarget) },
                    ]
                  : []),
                { sep: true },
              ]
            : []),
          { label: "Copy name", icon: "copy", onClick: () => this.host.copy(t.name) },
          { label: "Copy qualified name", icon: "copy", onClick: () => this.host.copy(q) },
          { sep: true },
          { label: "Refresh", icon: "refresh", onClick: () => void this.refreshDb(id, db) },
        ]),
      children: () => {
        const out: RowSpec[] = [];
        const folder = (k: string, label: string, ic: string, n: number, kids: () => RowSpec[]): void => {
          out.push({ key: `${key}:${k}`, label, icon: ic, meta: String(n), expandable: true, cls: "group", children: kids });
        };
        folder("cols", "Columns", "column", t.columns.length, () =>
          t.columns.map((c) => {
            const pk = t.primaryKey.includes(c.name);
            return {
              key: `${key}:col:${c.name}`,
              label: c.name,
              icon: pk ? "key" : "column",
              iconCls: pk ? "pk" : "",
              meta: c.dataType + (c.nullable ? "?" : ""),
              metaMono: true,
              cls: "column leaf" + (pk ? " is-pk" : ""),
              title: `${c.name} ${c.dataType}${c.nullable ? "" : " NOT NULL"}${c.defaultValue ? " DEFAULT " + c.defaultValue : ""}${pk ? " (primary key)" : ""}`,
              onContext: (ev: MouseEvent) => showMenu(ev.clientX, ev.clientY, [{ label: "Copy name", icon: "copy", onClick: () => this.host.copy(c.name) }]),
            };
          }),
        );
        if (t.primaryKey.length) {
          const pkIx = t.indexes?.find((i) => i.primary);
          folder("keys", "Keys", "key", 1, () => [
            { key: `${key}:pk`, label: pkIx?.name ?? "primary key", icon: "key", iconCls: "pk", meta: t.primaryKey.join(", "), metaMono: true, cls: "leaf", title: `PRIMARY KEY (${t.primaryKey.join(", ")})` },
          ]);
        }
        if (t.foreignKeys?.length) {
          folder("fks", "Foreign keys", "fk", t.foreignKeys.length, () =>
            t.foreignKeys.map((fk) => ({
              key: `${key}:fk:${fk.name}`,
              label: fk.name,
              icon: "fk",
              meta: fkLabel(fk),
              metaMono: true,
              cls: "leaf",
              title: `${fk.name}: (${fk.columns.join(", ")}) ${fkLabel(fk)}`,
            })),
          );
        }
        if (t.indexes?.length) {
          folder("ix", "Indexes", "index", t.indexes.length, () =>
            t.indexes.map((ix) => ({
              key: `${key}:ix:${ix.name}`,
              label: ix.name,
              icon: "index",
              meta: ix.columns.join(", "),
              metaMono: true,
              tag: ixTag(ix),
              cls: "leaf",
              title: `${ix.name} (${ix.columns.join(", ")})${ix.unique ? " UNIQUE" : ""}`,
              target: sqlSrc ? { connId: id, database: db, schema: s.name, name: ix.name, kind: "index" as const, table: t.name } : undefined,
              onContext: sqlSrc
                ? (ev: MouseEvent) =>
                    showMenu(ev.clientX, ev.clientY, [
                      { label: "Show DDL", icon: "view", hint: shortcutLabel("showDdl"), onClick: () => showDdl({ connId: id, database: db, schema: s.name, name: ix.name, kind: "index", table: t.name }) },
                      { label: "Copy name", icon: "copy", onClick: () => this.host.copy(ix.name) },
                    ])
                : undefined,
            })),
          );
        }
        return out;
      },
    };
  }

  // ------------------------------------------------------------------ redis

  private rkey(id: string, db: string): string {
    return `${id}\u0000${db}`;
  }

  private redisPattern(): string {
    return this.filterRaw ? `*${this.filterRaw}*` : "*";
  }

  private redisDbSpec(e: ConnEntry, d: DatabaseNode): RowSpec {
    const id = e.config.id;
    const key = `d:${id}:${d.name}`;
    const isDefault = d.name === e.defaultDb;
    const consoleDb = isDefault ? null : d.name;
    const meta = redisDbMeta(d);
    return {
      key,
      label: dbLabel(d.name),
      icon: "database",
      meta: meta || undefined,
      expandable: true,
      redisDb: true,
      cls: "db rdb" + (isDefault ? " current" : "") + (meta === "empty" ? " empty" : ""),
      title: `${dbLabel(d.name)}${d.comment ? " — " + d.comment : ""}${isDefault ? " (current)" : ""}`,
      onOpen: () => void this.loadRedis(e, d.name),
      children: () => this.redisDbChildren(e, d.name),
      onContext: (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "New console here", icon: "terminal", onClick: () => this.host.openConsole(id, { database: consoleDb }) },
          { label: "Refresh keys", icon: "refresh", onClick: () => void this.loadRedis(e, d.name, true) },
          { sep: true },
          { label: "Copy name", icon: "copy", onClick: () => this.host.copy(dbLabel(d.name)) },
        ]),
    };
  }

  /** Opens the database's session and runs the first SCAN step (or restarts it when the filter changed). */
  async loadRedis(e: ConnEntry, db: string, fresh = false): Promise<void> {
    const id = e.config.id;
    const k = this.rkey(id, db);
    await store.ensureDb(id, db);
    const entry = e.dbs.get(db);
    const sid = entry?.session?.sessionId;
    const prev = this.redisSt.get(k);
    if (!sid) {
      this.redisSt.set(k, { sid: "", pattern: "*", trie: new KeyTrie(), cursor: "0", done: true, loading: false, error: entry?.error ?? "Could not open the database", gen: (prev?.gen ?? 0) + 1 });
      this.render();
      return;
    }
    const pattern = this.redisPattern();
    if (prev && !fresh && prev.sid === sid && prev.pattern === pattern && !prev.error) return;
    this.redisSt.set(k, { sid, pattern, trie: new KeyTrie(), cursor: "0", done: false, loading: false, error: null, gen: (prev?.gen ?? 0) + 1 });
    await this.scanMore(e, db);
  }

  private async scanMore(e: ConnEntry, db: string): Promise<void> {
    const k = this.rkey(e.config.id, db);
    const st = this.redisSt.get(k);
    if (!st || st.loading || st.done || !st.sid) return;
    st.loading = true;
    st.error = null;
    const gen = st.gen;
    this.render();
    try {
      // One "page" keeps scanning until it found a useful number of new keys: SCAN MATCH can return empty
      // steps while the cursor is still moving.
      let fresh = 0;
      for (let step = 0; step < MAX_SCAN_STEPS && !st.done && fresh < PAGE_KEYS; step++) {
        const r = await api.redisScan(st.sid, st.pattern, st.cursor, SCAN_COUNT, null);
        if (st.gen !== gen || this.redisSt.get(k) !== st) return;
        fresh += st.trie.add(r.keys);
        st.cursor = r.cursor;
        st.done = r.done;
        if (this.filterRaw) {
          // A server-side filter leaves few keys: open the small namespaces so the matches are visible.
          for (const f of st.trie.folders(st.trie.root, 3, 30)) this.expanded.add(`rf:${e.config.id}:${db}:${f.path}`);
        }
        if (!st.done && fresh < PAGE_KEYS) this.render();
      }
    } catch (err) {
      if (st.gen !== gen || this.redisSt.get(k) !== st) return;
      st.error = errMsg(err);
    } finally {
      if (st.gen === gen) st.loading = false;
      this.render();
    }
  }

  private redisDbChildren(e: ConnEntry, db: string): RowSpec[] {
    const id = e.config.id;
    const k = this.rkey(id, db);
    const entry = e.dbs.get(db);
    if (entry?.status === "error") return [this.note(`er:${k}`, entry.error ?? "Could not open database", "err")];
    const st = this.redisSt.get(k);
    if (!st) return [this.note(`ld:${k}`, "Scanning…")];
    if (st.trie.size === 0) {
      if (st.error) return [this.note(`se:${k}`, st.error, "err")];
      if (st.loading || !st.done) return [this.note(`ld:${k}`, "Scanning…")];
      return [this.note(`em:${k}`, this.filterRaw ? `No keys match “${this.filterRaw}”` : "No keys")];
    }
    const out = this.redisNodeRows(e, db, st, st.trie.root);
    if (st.error) out.push(this.note(`se:${k}`, st.error, "err"));
    if (st.loading) out.push(this.note(`ld:${k}`, "Scanning…"));
    else if (!st.done) {
      out.push({
        key: `rm:${k}`,
        label: "Load more…",
        cls: "note more",
        meta: `${st.trie.size.toLocaleString()} loaded`,
        title: "Scan the next batch of keys",
        onClick: () => void this.scanMore(e, db),
      });
    }
    return out;
  }

  private redisNodeRows(e: ConnEntry, db: string, st: RedisState, n: TNode): RowSpec[] {
    const { folders, leaves } = st.trie.childrenOf(n);
    const out: RowSpec[] = [];
    for (const f of folders) out.push(this.redisFolderSpec(e, db, st, f));
    for (const k of leaves) out.push(this.redisKeySpec(e, db, st, k));
    return out;
  }

  private redisFolderSpec(e: ConnEntry, db: string, st: RedisState, f: TNode): RowSpec {
    const id = e.config.id;
    const ro = e.config.readOnly === true;
    return {
      key: `rf:${id}:${db}:${f.path}`,
      label: f.name || "(empty)",
      icon: "folder",
      meta: f.count.toLocaleString(),
      expandable: true,
      cls: "group rfolder",
      title: `${f.path}* — ${f.count.toLocaleString()} loaded key${f.count === 1 ? "" : "s"}`,
      children: () => this.redisNodeRows(e, db, st, f),
      onContext: (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "Copy pattern", icon: "copy", hint: `${f.path}*`, onClick: () => this.host.copy(`${f.path}*`) },
          { sep: true },
          { label: "Delete all keys under…", icon: "trash", danger: true, disabled: ro, onClick: () => void this.deleteNamespace(e, db, st, f) },
        ]),
    };
  }

  private redisKeySpec(e: ConnEntry, db: string, st: RedisState, k: RedisKey): RowSpec {
    const id = e.config.id;
    const t = typeInfo(k.keyType);
    const ttl = ttlShort(k.ttl);
    const ro = e.config.readOnly === true;
    return {
      key: `rk:${id}:${db}:${k.key}`,
      label: leafName(k.key) || "(empty)",
      icon: "key",
      tag: t.chip,
      tagCls: t.cls,
      meta: ttl || undefined,
      cls: "leaf rkey",
      title: `${k.key} — ${t.label}${k.ttl !== null ? ` · expires in ${ttlLong(k.ttl)}` : ""}`,
      onClick: () => this.host.openKey(id, db, k.key, k.keyType),
      onContext: (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "Open", icon: "view", hint: "↵", onClick: () => this.host.openKey(id, db, k.key, k.keyType) },
          { label: "Copy key", icon: "copy", onClick: () => this.host.copy(k.key) },
          { sep: true },
          { label: "Set TTL…", icon: "clock", disabled: ro, onClick: () => void this.setKeyTtl(e, db, st, k) },
          { label: "Delete…", icon: "trash", danger: true, disabled: ro, onClick: () => void this.deleteKey(e, db, st, k) },
        ]),
    };
  }

  private async setKeyTtl(e: ConnEntry, db: string, st: RedisState, k: RedisKey): Promise<void> {
    const text = await promptDialog("Set TTL", "Time to live", k.ttl !== null ? String(Math.round(k.ttl)) : "", "Set TTL", [], {
      icon: "clock",
      hint: "Seconds, or 5m / 2h / 1d. Type “persist” to remove the expiry.",
      validate: (v) => (parseTtlInput(v) === undefined ? "Not a valid TTL — try 90, 5m, 2h, 1d or persist." : null),
    });
    if (text === null) return;
    const ttl = parseTtlInput(text);
    if (ttl === undefined) return;
    try {
      await api.redisSetTtl(st.sid, k.key, ttl);
      k.ttl = ttl;
      this.render();
      this.host.keyTouched(e.config.id, db, k.key);
      toast(ttl === null ? "Expiry removed" : `TTL set to ${ttlLong(ttl)}`, "ok");
    } catch (err) {
      toast(errMsg(err), "error");
    }
  }

  private async deleteKey(e: ConnEntry, db: string, st: RedisState, k: RedisKey): Promise<void> {
    const ok = await confirmDialog("Delete key?", `“${k.key}” will be removed from ${dbLabel(db)}. This can't be undone.`, "Delete", true);
    if (!ok) return;
    try {
      const n = await api.redisDelete(st.sid, [k.key]);
      st.trie.remove([k.key]);
      this.render();
      this.host.keysDeleted(e.config.id, db, [k.key]);
      toast(n > 0 ? "Key deleted" : "Key was already gone", n > 0 ? "ok" : "info");
    } catch (err) {
      toast(errMsg(err), "error");
    }
  }

  private async deleteNamespace(e: ConnEntry, db: string, st: RedisState, f: TNode): Promise<void> {
    const keys = st.trie.collect(f);
    if (keys.length === 0) return;
    const partial = st.done ? "" : " The scan has not finished, so the server may hold more keys with this prefix; they are not touched.";
    const ok = await confirmDialog(
      "Delete keys?",
      `Delete the ${keys.length.toLocaleString()} loaded key${keys.length === 1 ? "" : "s"} under “${f.path}*” from ${dbLabel(db)}? Only keys already loaded in this tree are deleted.${partial} This can't be undone.`,
      `Delete ${keys.length.toLocaleString()} key${keys.length === 1 ? "" : "s"}`,
      true,
    );
    if (!ok) return;
    try {
      let removed = 0;
      for (let i = 0; i < keys.length; i += 500) removed += await api.redisDelete(st.sid, keys.slice(i, i + 500));
      st.trie.remove(keys);
      this.render();
      this.host.keysDeleted(e.config.id, db, keys);
      toast(`Deleted ${removed.toLocaleString()} key${removed === 1 ? "" : "s"}`, "ok");
    } catch (err) {
      toast(`Delete failed: ${errMsg(err)}`, "error");
      void this.loadRedis(e, db, true);
    }
  }

  /** A key was deleted elsewhere (key tab): drop it from the loaded tree. */
  redisKeysRemoved(connId: string, db: string, keys: string[]): void {
    const st = this.redisSt.get(this.rkey(connId, db));
    if (!st) return;
    st.trie.remove(keys);
    this.render();
  }

  /** A key's TTL changed elsewhere (key tab). */
  redisTtlChanged(connId: string, db: string, key: string, ttl: number | null): void {
    const k = this.redisSt.get(this.rkey(connId, db))?.trie.get(key);
    if (!k) return;
    k.ttl = ttl;
    this.render();
  }

  private forgetRedis(id: string): void {
    for (const k of [...this.redisSt.keys()]) if (k.startsWith(id + "\u0000")) this.redisSt.delete(k);
  }

  // ------------------------------------------------------------------ kafka

  private kafkaChildren(e: ConnEntry): RowSpec[] {
    const id = e.config.id;
    const o = overviewOf(id);
    if (!o) {
      const st = overviewState(id);
      return [st.error ? this.note(`kf:err:${id}`, st.error, "err") : this.note(`kf:ld:${id}`, "Loading…")];
    }
    const ro = e.config.readOnly === true;
    const topics = o.topics.slice().sort((a, b) => collate(a.name, b.name));
    const groups = o.groups.slice().sort((a, b) => collate(a.groupId, b.groupId));
    const topicRows = (): RowSpec[] =>
      topics.length === 0
        ? [this.note(`kf:t0:${id}`, "No topics")]
        : topics.map((t) => ({
            key: `kf:tp:${id}:${t.name}`,
            label: t.name,
            icon: "topic",
            meta: `${t.partitions}p`,
            cls: "leaf ktopic" + (t.internal ? " internal" : ""),
            title: `${t.name} — ${t.partitions} partition${t.partitions === 1 ? "" : "s"} · RF ${t.replicationFactor}${t.internal ? " · internal" : ""}`,
            onClick: () => this.host.openTopic(id, t.name),
            onContext: (ev) =>
              showMenu(ev.clientX, ev.clientY, [
                { label: "Open", icon: "view", hint: "↵", onClick: () => this.host.openTopic(id, t.name) },
                { label: "Produce message…", icon: "send", disabled: ro, onClick: () => this.host.produceTo(id, t.name) },
                { label: "Copy name", icon: "copy", onClick: () => this.host.copy(t.name) },
                { sep: true },
                { label: "Delete topic…", icon: "trash", danger: true, disabled: ro, onClick: () => void this.deleteTopic(id, t.name) },
              ]),
          }));
    const groupRows = (): RowSpec[] =>
      groups.length === 0
        ? [this.note(`kf:g0:${id}`, "No consumer groups")]
        : groups.map((g) => ({
            key: `kf:gp:${id}:${g.groupId}`,
            label: g.groupId,
            icon: "group",
            meta: stateLabel(g.state),
            metaCls: stateClass(g.state),
            cls: "leaf kgroup",
            title: `${g.groupId} — ${stateLabel(g.state)} · ${g.members} member${g.members === 1 ? "" : "s"}`,
            onClick: () => this.host.openGroup(id, g.groupId),
            onContext: (ev) =>
              showMenu(ev.clientX, ev.clientY, [
                { label: "Open", icon: "view", hint: "↵", onClick: () => this.host.openGroup(id, g.groupId) },
                { label: "Copy id", icon: "copy", onClick: () => this.host.copy(g.groupId) },
              ]),
          }));
    const brokerRows = (): RowSpec[] =>
      o.brokers.map((b) => ({
        key: `kf:br:${id}:${b.id}`,
        label: `${b.id} · ${b.host}:${b.port}`,
        icon: "server",
        meta: b.isController ? "controller" : undefined,
        cls: "leaf kbroker",
        title: `Broker ${b.id} — ${b.host}:${b.port}${b.isController ? " (controller)" : ""}`,
      }));
    return [
      {
        key: `kf:t:${id}`,
        label: "Topics",
        icon: "topic",
        meta: String(topics.length),
        expandable: true,
        cls: "group",
        children: topicRows,
        onContext: (ev) =>
          showMenu(ev.clientX, ev.clientY, [
            { label: "Create topic…", icon: "plus", disabled: ro, onClick: () => void this.createTopic(id) },
            { label: "Refresh", icon: "refresh", onClick: () => void loadOverview(id, true) },
          ]),
      },
      { key: `kf:g:${id}`, label: "Consumer groups", icon: "group", meta: String(groups.length), expandable: true, cls: "group", children: groupRows },
      { key: `kf:b:${id}`, label: "Brokers", icon: "server", meta: String(o.brokers.length), expandable: true, cls: "group", children: brokerRows },
    ];
  }

  private async createTopic(id: string): Promise<void> {
    const name = await openCreateTopicDialog(id);
    if (name) this.host.openTopic(id, name);
  }

  private async deleteTopic(id: string, topic: string): Promise<void> {
    if (await deleteTopicFlow(id, topic)) this.host.topicDeleted(id, topic);
  }

  // ------------------------------------------------------------------ flattening

  private flatten(): Flat[] {
    const out: Flat[] = [];
    const collapsed = getCollapsedFolders();
    const top: RowSpec[] = [];
    for (const it of topItems()) {
      if (it.kind === "conn") {
        top.push(this.connSpec(it.entry));
        continue;
      }
      const { name, members: list } = it;
      const key = "fo:" + name;
      if (collapsed.has(name)) this.expanded.delete(key);
      else this.expanded.add(key);
      const meta = folderMeta(name);
      top.push({
        key,
        label: name,
        icon: "folder",
        meta: String(list.length),
        expandable: true,
        cls: "folder",
        title: `${name} — ${list.length} data source${list.length === 1 ? "" : "s"}`,
        children: () => list.map((e) => this.connSpec(e)),
        onToggle: (open) => setFolderCollapsed(name, !open),
        onContext: (ev) => this.folderMenu(ev, name, list),
        dropFolder: name,
        dragKey: folderKey(name),
        look: { color: meta?.color ?? null, icon: meta?.icon ?? null },
      });
    }
    for (const spec of top) {
      if (!this.filter) this.walk(spec, 0, out);
      else this.walkFiltered(spec, 0, out);
    }
    return out;
  }

  private walk(spec: RowSpec, depth: number, out: Flat[]): void {
    const open = !!spec.expandable && this.expanded.has(spec.key) && !!spec.children;
    out.push({ spec, depth, open });
    if (open) for (const c of spec.children!()) this.walk(c, depth + 1, out);
  }

  /** Keeps a node when it or any loaded descendant matches; matching branches auto-expand. */
  private walkFiltered(spec: RowSpec, depth: number, out: Flat[]): boolean {
    if (spec.redisDb && this.expanded.has(spec.key) && spec.children) {
      // The server already filtered this tree (SCAN MATCH): show it as loaded.
      out.push({ spec, depth, open: true });
      for (const c of spec.children()) this.walk(c, depth + 1, out);
      return true;
    }
    const self = spec.label.toLowerCase().includes(this.filter);
    const kids: Flat[] = [];
    if (spec.expandable && spec.children) for (const c of spec.children()) this.walkFiltered(c, depth + 1, kids);
    if (kids.length) {
      out.push({ spec, depth, open: true }, ...kids);
      return true;
    }
    if (self) {
      out.push({ spec, depth, open: false });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ rendering

  render(): void {
    if (this.drag) {
      // Never rebuild the rows under an active drag (the dragged element must stay alive until dragend).
      this.pendingRender = true;
      return;
    }
    this.flat = this.flatten();
    const entries = store.list();
    const n = this.flat.length;
    if (entries.length === 0) {
      this.inner.style.height = "";
      this.rendered.clear();
      clear(this.inner);
      this.inner.appendChild(
        h(
          "div",
          { class: "side-empty" },
          h("div", { class: "side-empty-title" }, "No connections yet"),
          h("div", { class: "side-empty-text" }, "Add a PostgreSQL, MySQL, SQLite, SQL Server, Redis or Kafka data source to start exploring."),
          h("button", { class: "linkbtn", type: "button", onclick: () => this.host.importDataGrip() }, "Import from DataGrip…"),
        ),
      );
      return;
    }
    this.inner.style.height = n * this.rowH + "px";
    this.paintWindow(true);
  }

  private paintWindow(full: boolean): void {
    if (store.list().length === 0) return;
    const n = this.flat.length;
    if (full) {
      this.rendered.clear();
      clear(this.inner);
      if (n === 0) {
        this.inner.style.height = "";
        this.inner.appendChild(h("div", { class: "empty-note" }, "Nothing matches the filter."));
        return;
      }
    }
    if (n === 0) return;
    const top = this.tree.scrollTop;
    const vh = this.tree.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / this.rowH) - OVERSCAN);
    const end = Math.min(n, Math.ceil((top + vh) / this.rowH) + OVERSCAN);
    const keep = this.drag ? this.flat.findIndex((f) => f.spec.dragKey === this.drag?.key) : -1;
    for (const [i, el] of this.rendered) {
      if ((i < start || i >= end) && i !== keep) {
        el.remove();
        this.rendered.delete(i);
      }
    }
    if (this.dropLine.parentNode !== this.inner) this.inner.appendChild(this.dropLine);
    for (let i = start; i < end; i++) {
      if (this.rendered.has(i)) continue;
      const el = this.rowEl(this.flat[i], i);
      this.rendered.set(i, el);
      this.inner.appendChild(el);
    }
  }

  private rowEl(fr: Flat, idx: number): HTMLElement {
    const s = fr.spec;
    const expandable = !!s.expandable;
    const compact = this.density === "compact";
    const caret = h("span", { class: "twisty" + (expandable ? (fr.open ? " open" : "") : " none"), "aria-hidden": "true" }, expandable ? icon("caret", compact ? 8 : 10) : null);
    let lead: HTMLElement | null = s.badge ?? null;
    if (!lead && s.look) {
      lead = svgIcon(hasIcon(s.look.icon) ? s.look.icon : "folder", compact ? 14 : 16, s.look.color ?? "currentColor", 2);
    } else if (!lead && s.icon) {
      lead = icon(s.icon, compact ? 13 : 15);
      if (s.iconCls) lead.classList.add(s.iconCls);
    }
    const dragging = this.drag !== null && s.dragKey === this.drag.key;
    const r = h(
      "div",
      {
        class: "node-row " + (s.cls ?? "") + (this.selected === s.key || (s.multiConn !== undefined && this.multi.includes(s.multiConn)) ? " selected" : "") + (s.actions && s.actions.length ? " has-actions" : "") + (dragging ? " dragging" : ""),
        role: "treeitem",
        "aria-level": String(fr.depth + 1),
        "aria-expanded": expandable ? String(fr.open) : undefined,
        "aria-selected": this.selected === s.key ? "true" : undefined,
        title: s.title ?? (s.meta ? `${s.label} — ${s.meta}` : s.label),
        style: `top:${idx * this.rowH}px`,
      },
      h("span", { class: "indent", style: `width:${indentOf(fr.depth, this.density)}px` }),
      caret,
      lead,
      h("span", { class: "label", style: s.look?.color ? `color:${s.look.color}` : undefined }, s.label),
      s.tag ? h("span", { class: "badge-tag" + (s.tagCls ? " " + s.tagCls : "") }, s.tag) : null,
      s.meta ? h("span", { class: "meta" + (s.metaMono ? " mono" : "") + (s.metaCls ? " " + s.metaCls : "") }, s.meta) : null,
      s.actions && s.actions.length ? h("span", { class: "node-actions" }, s.actions) : null,
      s.chip ?? null,
    );
    if (s.dragKey && !this.filter) {
      const dk = s.dragKey;
      r.draggable = true;
      r.addEventListener("dragstart", (ev) => {
        if (s.dragConn) {
          ev.dataTransfer?.setData(DRAG_MIME, s.dragConn);
          ev.dataTransfer?.setData("text/plain", store.conns.get(s.dragConn)?.config.name ?? s.dragConn);
        } else ev.dataTransfer?.setData("text/plain", s.label);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
        this.drag = { key: dk, isFolder: dk.startsWith("folder:"), cancelled: false };
        this.drop = null;
        closeLookPicker();
        window.setTimeout(() => r.classList.add("dragging"), 0);
      });
      r.addEventListener("dragend", () => this.endDrag());
    }
    if (s.dragTable && !s.dragKey) {
      const dt = s.dragTable;
      r.draggable = true;
      r.addEventListener("dragstart", (ev) => {
        ev.dataTransfer?.setData(TABLE_DRAG_MIME, JSON.stringify(dt));
        ev.dataTransfer?.setData("text/plain", qualifiedName(store.conns.get(dt.connId)?.config.driver ?? "postgres", dt.schema, dt.table));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
        setTableDrag(dt);
      });
      r.addEventListener("dragend", () => setTableDrag(null));
    }
    r.addEventListener("click", (e) => {
      // ⌘-click (Ctrl-click elsewhere) on data sources: multi-selection (cross-source console, reconnect all…).
      if (s.multiConn !== undefined && (IS_MAC ? e.metaKey : e.ctrlKey)) {
        this.toggleMulti(s.multiConn);
        return;
      }
      if (this.multi.length) this.multi = [];
      this.selected = s.key;
      if (s.onClick) s.onClick(e, s);
      else if (expandable) this.toggle(s);
      else this.render();
    });
    if (s.onDbl) r.addEventListener("dblclick", s.onDbl);
    if (s.onContext) {
      r.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.selected = s.key;
        this.render();
        s.onContext?.(e);
      });
    }
    return r;
  }

  // ------------------------------------------------------------------ drag & drop reordering

  private folderOpen = (name: string): boolean => this.expanded.has("fo:" + name);

  /** Row under a viewport Y (and the fraction down that row), or null past the last row. */
  private hit(clientY: number): { idx: number; frac: number } | null {
    const top = this.inner.getBoundingClientRect().top;
    const y = clientY - top;
    const idx = Math.floor(y / this.rowH);
    if (idx < 0 || idx >= this.flat.length) return null;
    return { idx, frac: (y - idx * this.rowH) / this.rowH };
  }

  /** End (inclusive flat index) of the row's block: the row plus all of its open descendants. */
  private blockEnd(idx: number): number {
    const d = this.flat[idx].depth;
    let j = idx;
    while (j + 1 < this.flat.length && this.flat[j + 1].depth > d) j++;
    return j;
  }

  private onDragOver(ev: DragEvent): void {
    const d = this.drag;
    if (!d || d.cancelled) return;
    this.lastY = ev.clientY;
    const ok = this.updateDrop(ev.clientY);
    if (ok) {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    }
    // Auto-scroll near the top / bottom edge of the tree.
    const r = this.tree.getBoundingClientRect();
    const near = ev.clientY < r.top + EDGE_ZONE || ev.clientY > r.bottom - EDGE_ZONE;
    if (near && !this.scrollRaf) this.scrollRaf = requestAnimationFrame(() => this.autoScrollTick());
  }

  private autoScrollTick(): void {
    this.scrollRaf = 0;
    if (!this.drag) return;
    const r = this.tree.getBoundingClientRect();
    let dy = 0;
    if (this.lastY < r.top + EDGE_ZONE) dy = -Math.ceil(((r.top + EDGE_ZONE - this.lastY) / EDGE_ZONE) * 14);
    else if (this.lastY > r.bottom - EDGE_ZONE) dy = Math.ceil(((this.lastY - (r.bottom - EDGE_ZONE)) / EDGE_ZONE) * 14);
    if (dy === 0) return;
    const before = this.tree.scrollTop;
    this.tree.scrollTop = before + dy;
    if (this.tree.scrollTop !== before) {
      this.paintWindow(false);
      this.updateDrop(this.lastY);
    }
    this.scrollRaf = requestAnimationFrame(() => this.autoScrollTick());
  }

  /** Works out the drop zone under the pointer and draws the insertion line / folder highlight. */
  private updateDrop(clientY: number): boolean {
    const d = this.drag;
    const h0 = this.hit(clientY);
    const row = h0 ? this.flat[h0.idx] : null;
    const key = row?.spec.dragKey;
    if (!d || !h0 || !row || !key) {
      this.clearDrop();
      return false;
    }
    const isFolderRow = row.spec.dropFolder !== undefined;
    let zone: DropZone = h0.frac < 0.5 ? "before" : "after";
    if (isFolderRow && !d.isFolder && h0.frac > 0.28 && h0.frac < 0.72) zone = "into";
    if (!canDrop(d.key, key, zone, this.folderOpen)) {
      this.clearDrop();
      return false;
    }
    this.drop = { idx: h0.idx, zone, key };
    this.paintDrop();
    return true;
  }

  private paintDrop(): void {
    for (const el of this.inner.querySelectorAll(".drop-target")) el.classList.remove("drop-target");
    const dr = this.drop;
    const d = this.drag;
    if (!dr || !d) {
      this.dropLine.hidden = true;
      return;
    }
    const row = this.flat[dr.idx];
    if (dr.zone === "into") {
      this.dropLine.hidden = true;
      this.rendered.get(dr.idx)?.classList.add("drop-target");
      return;
    }
    // "after" sits below the row's whole open block, except onto an open folder (then it becomes its first member).
    const firstMember = dr.zone === "after" && !d.isFolder && row.spec.dropFolder !== undefined && row.open && this.flat[dr.idx + 1]?.depth === row.depth + 1;
    const lineIdx = dr.zone === "before" ? dr.idx : (firstMember ? dr.idx : this.blockEnd(dr.idx)) + 1;
    const depth = firstMember ? row.depth + 1 : row.depth;
    const pad = this.density === "compact" ? 6 : 10;
    this.dropLine.style.top = lineIdx * this.rowH + "px";
    this.dropLine.style.left = pad + 8 + indentOf(depth, this.density) + "px";
    this.dropLine.style.right = pad + "px";
    this.dropLine.hidden = false;
  }

  private clearDrop(): void {
    this.drop = null;
    this.paintDrop();
  }

  private onDrop(ev: DragEvent): void {
    const d = this.drag;
    if (!d) return;
    ev.preventDefault();
    const ok = !d.cancelled && this.updateDrop(ev.clientY);
    const dr = this.drop;
    this.endDrag();
    if (!ok || !dr) return;
    if (dropOn(d.key, dr.key, dr.zone, this.folderOpen)) this.revealMoved(d.key);
  }

  /** After a move: make sure the destination folder is open and the moved row is visible. */
  private revealMoved(key: string): void {
    if (key.startsWith("conn:")) {
      const f = connFolder(store.conns.get(key.slice(5))!);
      if (f && !this.folderOpen(f)) {
        setFolderCollapsed(f, false);
        this.expanded.add("fo:" + f);
        this.render();
      }
    }
    this.scrollToKey(key);
  }

  private endDrag(): void {
    if (!this.drag && !this.drop) return;
    this.drag = null;
    this.drop = null;
    this.dropLine.hidden = true;
    for (const el of this.inner.querySelectorAll(".drop-target, .dragging")) el.classList.remove("drop-target", "dragging");
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    this.scrollRaf = 0;
    if (this.pendingRender) {
      this.pendingRender = false;
      this.render();
    }
  }

  private selectedMoveKey(): string | null {
    if (this.filter) return null;
    return this.flat.find((f) => f.spec.key === this.selected)?.spec.dragKey ?? null;
  }

  private moveSelected(key: string, d: number): void {
    if (!shift(key, d)) return;
    this.scrollToKey(key);
  }

  private scrollToKey(dragKey: string): void {
    const i = this.flat.findIndex((f) => f.spec.dragKey === dragKey);
    if (i < 0) return;
    const top = i * this.rowH;
    if (top < this.tree.scrollTop) this.tree.scrollTop = top;
    else if (top + this.rowH > this.tree.scrollTop + this.tree.clientHeight) this.tree.scrollTop = top + this.rowH - this.tree.clientHeight;
    this.paintWindow(false);
  }

  /** Opens the Color & icon popover next to the sidebar, level with the given point. */
  private openLook(ev: { clientY: number }, t: Parameters<typeof openLookPicker>[0]): void {
    const sb = this.el.getBoundingClientRect();
    openLookPicker(t, { x: sb.right + 8, y: ev.clientY - 20 });
  }

  private connLookTarget(e: ConnEntry): Parameters<typeof openLookPicker>[0] {
    const id = e.config.id;
    return {
      folder: false,
      driver: e.config.driver,
      name: () => store.conns.get(id)?.config.name ?? e.config.name,
      color: () => store.conns.get(id)?.config.color ?? null,
      icon: () => store.conns.get(id)?.config.icon ?? null,
      set: (p) => setConnLook(id, p),
    };
  }

  private folderLookTarget(name: string): Parameters<typeof openLookPicker>[0] {
    return {
      folder: true,
      name: () => name,
      color: () => folderMeta(name)?.color ?? null,
      icon: () => folderMeta(name)?.icon ?? null,
      set: (p) => setFolderLook(name, p),
    };
  }

  // ------------------------------------------------------------------ sidebar toolbar, multi-selection

  /** View › Compact explorer. */
  get compact(): boolean {
    return this.density === "compact";
  }

  toggleCompact(): void {
    this.setDensity(this.density === "compact" ? "comfortable" : "compact");
  }

  /** Bottom toolbar: Settings, Vault profiles, SSH configurations, Query history, Import, and the ⌘K pill. */
  private toolbar(): HTMLElement {
    const btn = (ic: string, name: string, run: () => void): HTMLButtonElement =>
      h("button", { class: "side-tool", type: "button", "aria-label": name, onclick: run }, icon(ic, 17));
    const bSettings = btn("sliders", "Settings", () => openSettings());
    // The board's gear (the shared icon set has none).
    const gear = h("span", { class: "ico", style: "width:17px;height:17px", "aria-hidden": "true" });
    gear.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="${GEAR_PATH}"/></svg>`;
    bSettings.replaceChildren(gear);
    const bVault = btn("key", "Vault profiles", () => openVaultProfilesDialog());
    const bSsh = btn("server", "SSH configurations", () => openSshProfilesDialog());
    const bHistory = btn("clock", "Query history", () => this.host.toggleHistory());
    const bImport = btn("download", "Import from DataGrip", () => this.host.importDataGrip());
    const pill = h("button", { class: "side-k", type: "button", "aria-label": "Command palette", onclick: () => this.host.openPalette() });
    const bHelp = h("button", { class: "side-tool side-help", type: "button", "aria-label": "Help", onclick: () => this.host.openHelp() }, "?");
    const label = (name: string, key: string): string => (key ? `${name} (${key})` : name);
    const sync = (): void => {
      bSettings.title = label("Settings", shortcutLabel("settings"));
      bVault.title = "Vault profiles — tokens, OIDC sign-in, which data sources use them";
      bSsh.title = "SSH configurations — jump hosts and keys";
      bHistory.title = label("Query history", formatBinding("Mod-Shift-H"));
      bImport.title = "Import data sources from DataGrip";
      bHelp.title = label("Help", shortcutLabel("help"));
      const k = shortcutLabel("commandPalette");
      pill.textContent = k || "⌘K";
      pill.title = label("Command palette — every action, data source, table and tab", k);
    };
    sync();
    onSettingsChange(sync);
    return h("div", { class: "side-tools", role: "toolbar", "aria-label": "Tools" }, bSettings, bVault, bSsh, bHistory, bImport, bHelp, h("span", { class: "spacer" }), pill);
  }

  /** ⌘/Ctrl-click on a data source: adds it to (or removes it from) the multi-selection. */
  private toggleMulti(id: string): void {
    // The first ⌘-click keeps the data source that was selected before.
    if (this.multi.length === 0 && this.selected.startsWith("c:") && this.selected !== "c:" + id && store.conns.has(this.selected.slice(2))) this.multi.push(this.selected.slice(2));
    const i = this.multi.indexOf(id);
    if (i >= 0) this.multi.splice(i, 1);
    else this.multi.push(id);
    this.selected = "c:" + id;
    this.host.onSelect(id);
    this.render();
  }

  /** Context menu of a multi-selection of data sources. */
  private multiMenu(ev: MouseEvent): void {
    const ents = this.multi.map((id) => store.conns.get(id)).filter((e): e is ConnEntry => e !== undefined);
    const sql = ents.filter((e) => FED_DRIVERS.has(e.config.driver));
    const names = sql.map((e) => e.config.name);
    showMenu(
      ev.clientX,
      ev.clientY,
      [
        { label: `${ents.length} data sources selected`, disabled: true },
        {
          label: sql.length >= 2 ? `New cross-source console (${sql.length} sources)` : "New cross-source console (needs 2 SQL sources)",
          icon: "layers",
          disabled: sql.length < 2,
          onClick: () => this.host.newCrossSource(sql.map((e) => e.config.id)),
        },
        ...(sql.length >= 2 ? [{ label: `Query ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} together`, disabled: true }] : []),
        { sep: true },
        { label: "Reconnect all", icon: "refresh", onClick: () => ents.forEach((e) => void this.reconnect(e.config.id)) },
        {
          label: "Disconnect all",
          icon: "unplug",
          disabled: !ents.some((e) => e.status === "connected"),
          onClick: () => ents.filter((e) => e.status === "connected").forEach((e) => void this.disconnect(e.config.id)),
        },
        { sep: true },
        {
          label: "Clear selection",
          icon: "x",
          onClick: () => {
            this.multi = [];
            this.render();
          },
        },
      ],
      { minWidth: 260 },
    );
  }

  // ------------------------------------------------------------------ actions

  private connMenu(ev: MouseEvent, e: ConnEntry): void {
    const id = e.config.id;
    const connected = e.status === "connected";
    showMenu(ev.clientX, ev.clientY, [
      connected
        ? { label: "Disconnect", icon: "unplug", onClick: () => void this.disconnect(id) }
        : { label: "Connect", icon: "plug", onClick: () => void this.connect(id) },
      { label: "Reconnect", icon: "refresh", hint: shortcutLabel("reconnect"), onClick: () => void this.reconnect(id) },
      { label: "New console", icon: "terminal", disabled: !connected, onClick: () => this.host.openConsole(id) },
      { label: "Run SQL file…", icon: "playAll", disabled: !FED_DRIVERS.has(e.config.driver), onClick: () => this.host.runSqlFile(id) },
      { label: "Sessions & locks", icon: "server", disabled: !FED_DRIVERS.has(e.config.driver), onClick: () => this.host.openSessions?.(id) },
      { label: "Refresh", icon: "refresh", disabled: !connected, onClick: () => void this.refresh(id) },
      { sep: true },
      { label: "Edit…", icon: "pencil", onClick: () => this.host.editConnection(id) },
      { label: "Color & icon…", icon: "palette", onClick: () => this.openLook(ev, this.connLookTarget(e)) },
      { sep: true },
      { label: "Move up", icon: "up", hint: ALT_UP, disabled: !canShift(connKey(id), -1), onClick: () => this.moveSelected(connKey(id), -1) },
      { label: "Move down", icon: "down", hint: ALT_DOWN, disabled: !canShift(connKey(id), 1), onClick: () => this.moveSelected(connKey(id), 1) },
      { label: "Move to folder", icon: "folder", hint: "▸", onClick: () => this.moveMenu(ev.clientX, ev.clientY, e) },
      { label: "Copy name", icon: "copy", onClick: () => this.host.copy(e.config.name) },
      { sep: true },
      { label: "Delete", icon: "trash", danger: true, onClick: () => this.host.deleteConnection(id) },
    ]);
  }

  /** The "N of M" / "all" scope chip on a connected server row. */
  private chipEl(e: ConnEntry): HTMLElement {
    const sum = scopeSummary(e);
    const id = e.config.id;
    return h(
      "button",
      {
        class: "scope-chip" + (sum.filtered ? " filtered" : ""),
        type: "button",
        title: "Choose visible databases",
        "aria-label": `Visible databases on ${e.config.name}: ${scopeLabel(sum)}. Choose…`,
        "aria-haspopup": "dialog",
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          const chip = ev.currentTarget as HTMLElement;
          const sb = this.el.getBoundingClientRect();
          const r = chip.getBoundingClientRect();
          this.selected = "c:" + id;
          this.host.onSelect(id);
          openScopePicker(id, { x: sb.right - 36, y: r.bottom + 6 });
          this.render();
        },
        ondblclick: (ev: Event) => ev.stopPropagation(),
      },
      scopeLabel(sum),
    );
  }

  private moveMenu(x: number, y: number, e: ConnEntry): void {
    const id = e.config.id;
    const cur = e.config.folder?.trim() || null;
    const items = folderNames().map((f) => ({ label: f, checked: f === cur, onClick: () => void setFolder(id, f) }));
    showMenu(
      x,
      y,
      [
        ...items,
        ...(items.length ? [{ sep: true }] : []),
        { label: "New folder…", icon: "plus", onClick: () => void this.newFolderFor(id) },
        { label: "Remove from folder", icon: "x", disabled: cur === null, onClick: () => void setFolder(id, null) },
      ],
      { minWidth: 200 },
    );
  }

  private async newFolderFor(id: string): Promise<void> {
    const name = await promptDialog("New folder", "Folder name", "", "Create", folderNames());
    if (name) await setFolder(id, name);
  }

  private folderMenu(ev: MouseEvent, name: string, members: ConnEntry[]): void {
    const ids = members.map((m) => m.config.id);
    const fk = folderKey(name);
    showMenu(ev.clientX, ev.clientY, [
      { label: "Color & icon…", icon: "palette", onClick: () => this.openLook(ev, this.folderLookTarget(name)) },
      { sep: true },
      { label: "Move up", icon: "up", hint: ALT_UP, disabled: !canShift(fk, -1), onClick: () => this.moveSelected(fk, -1) },
      { label: "Move down", icon: "down", hint: ALT_DOWN, disabled: !canShift(fk, 1), onClick: () => this.moveSelected(fk, 1) },
      { label: "Sort folder A–Z", icon: "sort", disabled: members.length < 2, onClick: () => sortFolder(name) },
      { sep: true },
      {
        label: "Rename…",
        icon: "pencil",
        onClick: async () => {
          const next = await promptDialog("Rename folder", "Folder name", name, "Rename", folderNames());
          if (next && next !== name) {
            renameCollapsedFolder(name, next);
            renameFolderLayout(name, next);
            await setFolderForMany(ids, next);
          }
        },
      },
      { label: "Use Vault profile", icon: "key", hint: "▸", onClick: () => window.setTimeout(() => this.vaultProfileMenu(ev.clientX, ev.clientY, members), 0) },
      { sep: true },
      {
        label: "Ungroup",
        icon: "x",
        onClick: () => {
          ungroupFolderLayout(name);
          void setFolderForMany(ids, null);
        },
      },
    ]);
  }

  /** Second level of the folder menu: bulk-assign a shared Vault profile to every connection in the folder. */
  private vaultProfileMenu(x: number, y: number, members: ConnEntry[]): void {
    const ids = members.map((m) => m.config.id);
    const apply = async (pid: string | null): Promise<void> => {
      try {
        const n = await assignVaultProfile(pid, ids);
        toast(pid ? `${vaults.get(pid)?.name ?? "Profile"} applied to ${n} connection${n === 1 ? "" : "s"}` : `Vault profile removed from ${n} connection${n === 1 ? "" : "s"}`, "ok");
      } catch (e) {
        toast(errMsg(e), "error");
      }
    };
    const items = vaults.profiles.map((p) => ({
      label: p.name,
      checked: members.length > 0 && members.every((m) => m.config.authMethod === "vault" && m.config.vault?.profileId === p.id),
      onClick: () => void apply(p.id),
    }));
    showMenu(x, y, [
      ...(items.length ? items : [{ label: "No Vault profiles yet", disabled: true }]),
      { sep: true },
      { label: "None", icon: "x", onClick: () => void apply(null) },
      { label: "Manage profiles…", icon: "key", onClick: () => openVaultProfilesDialog() },
    ], { minWidth: 200 });
  }

  async connect(id: string, after?: () => void): Promise<void> {
    try {
      await store.connect(id);
      this.expandConnection(id);
    } catch (err) {
      // Expired Vault token or unknown SSH host: fix it inline, then retry this connect (and run `after`).
      const retry = async (): Promise<void> => {
        await this.connect(id);
        if (store.conns.get(id)?.status === "connected") after?.();
      };
      if (handleActionError(err, retry)) return;
      const msg = errMsg(err);
      const authFail = /password|authentication|access denied|login failed|auth failed|28P01|28000/i.test(msg);
      toast(`Could not connect: ${msg}${authFail ? "\nEdit connection to set the password." : ""}`, "error");
    }
  }

  /**
   * Drops and re-opens every session of the data source (fresh Vault credentials, fresh SSH forward) without
   * closing consoles. Not connected yet → a plain connect.
   */
  async reconnect(id: string): Promise<void> {
    const e = store.conns.get(id);
    if (!e) return;
    const name = e.config.name;
    if (e.status !== "connected") {
      await this.connect(id);
      if (store.conns.get(id)?.status === "connected") toast(`Connected to ${name}`, "ok");
      return;
    }
    try {
      const r = await api.reconnectConnection(id);
      if (r.sessions === 0) {
        // Nothing was open on the backend side (e.g. it restarted): connect from scratch.
        await this.disconnect(id);
        await this.connect(id);
        if (store.conns.get(id)?.status === "connected") toast(`Connected to ${name}`, "ok");
        return;
      }
      const skipped = r.skippedInTx > 0 ? ` · ${r.skippedInTx} skipped (open transaction)` : "";
      toast(`Reconnected to ${name} · ${r.elapsedMs.toLocaleString()} ms${skipped}`, "ok");
    } catch (err) {
      // Expired Vault token / unknown SSH host: fix it inline, then reconnect again.
      if (handleActionError(err, () => this.reconnect(id))) return;
      toast(`Could not reconnect: ${errMsg(err)}`, "error");
    }
  }

  async disconnect(id: string): Promise<void> {
    this.forgetRedis(id);
    forgetOverview(id);
    await store.disconnect(id);
  }

  async refresh(id: string): Promise<void> {
    try {
      await store.refresh(id);
      const e = store.conns.get(id);
      if (e?.config.driver === "kafka") await loadOverview(id, true);
      if (e?.config.driver === "redis") {
        this.forgetRedis(id);
        for (const d of e.databases) if (this.expanded.has(`d:${id}:${d.name}`)) void this.loadRedis(e, d.name);
      }
      toast("Refreshed", "ok");
    } catch (err) {
      toast(`Refresh failed: ${errMsg(err)}`, "error");
    }
  }

  private async refreshDb(id: string, db: string): Promise<void> {
    try {
      await store.refreshDb(id, db);
      toast("Schema refreshed", "ok");
    } catch (err) {
      toast(`Refresh failed: ${errMsg(err)}`, "error");
    }
  }
}

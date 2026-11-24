// Left sidebar card: brand, filter, connections -> schemas -> tables (+ Views group) -> columns.
import type { SchemaNode, TableNode } from "../types";
import { DRIVER_LABELS } from "../types";
import { brandMark, clear, errMsg, h, icon } from "./dom";
import { showMenu } from "./menu";
import type { ConnEntry } from "./state";
import { store } from "./state";
import { connColor, qualifiedName } from "./sqlutil";
import { toast } from "./toast";

/** Indent (px) per tree depth, from the spec: 0 / 16 / 30, then +14 per level. */
const INDENT = [0, 16, 30, 44, 58, 72];
const DRIVER_ABBR: Record<string, string> = { postgres: "PG", mysql: "MY", sqlite: "SQ", mssql: "MS" };
const STATUS_TEXT: Record<string, string> = { idle: "not connected", connecting: "connecting…", connected: "connected", error: "connection failed" };

export interface ExplorerHost {
  openConsole(connId: string, opts?: { sql?: string; run?: boolean; title?: string }): void;
  addConnection(): void;
  importDataGrip(): void;
  editConnection(id: string): void;
  deleteConnection(id: string): void;
  copy(text: string): void;
  onSelect(connId: string): void;
}

interface RowSpec {
  key: string;
  depth: number;
  icon?: HTMLElement;
  badge?: HTMLElement;
  label: string;
  meta?: string;
  pk?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  cls?: string;
  title?: string;
  actions?: HTMLElement[];
  onClick?: (e: MouseEvent) => void;
  onDbl?: () => void;
  onContext?: (e: MouseEvent) => void;
}

export class Explorer {
  readonly el: HTMLElement;
  private tree: HTMLElement;
  private filterInput: HTMLInputElement;
  private expanded = new Set<string>();
  private selected = "";
  private filter = "";

  constructor(private host: ExplorerHost) {
    this.filterInput = h("input", {
      type: "search",
      placeholder: "Search",
      "aria-label": "Filter connections and tables",
      spellcheck: false,
      oninput: () => {
        this.filter = this.filterInput.value.trim().toLowerCase();
        this.render();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Escape" && this.filterInput.value) {
          e.stopPropagation();
          this.filterInput.value = "";
          this.filter = "";
          this.render();
        }
      },
    });
    this.tree = h("div", { class: "tree", role: "tree", "aria-label": "Connections" });
    const addBtn = h(
      "button",
      {
        class: "pill-btn wide side-add",
        type: "button",
        "aria-haspopup": "menu",
        onclick: (ev: MouseEvent) => {
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          showMenu(r.left, r.top - 6, [
            { label: "New connection…", icon: "plus", onClick: () => host.addConnection() },
            { label: "Import from DataGrip…", icon: "download", onClick: () => host.importDataGrip() },
          ], { above: true, minWidth: r.width });
        },
      },
      "+ New connection",
    );
    // macOS draws the traffic lights over this strip (titleBarStyle Overlay); it doubles as a drag handle.
    // Windows/Linux have native title bars: the strip is hidden by CSS there.
    const strip = h("div", { class: "traffic-strip", "data-tauri-drag-region": "", "aria-hidden": "true" });
    this.el = h(
      "aside",
      { class: "sidebar", "aria-label": "Explorer" },
      strip,
      h("div", { class: "brand-row", "data-tauri-drag-region": "" }, brandMark(22), h("span", { class: "brand-name", "data-tauri-drag-region": "" }, "DataTrip")),
      h("label", { class: "side-search" }, icon("search", 13), this.filterInput),
      this.tree,
      h("div", { class: "side-foot" }, addBtn),
    );
    store.subscribe(() => this.render());
  }

  expandConnection(id: string): void {
    this.expanded.add("c:" + id);
    const e = store.conns.get(id);
    if (e) {
      const ds = e.session?.defaultSchema;
      const schemas = e.schemas;
      const pick = schemas.length === 1 ? schemas[0].name : ds ?? schemas[0]?.name;
      if (pick) {
        this.expanded.add(`s:${id}:${pick}`);
        this.expanded.add(`g:${id}:${pick}:tables`);
      }
    }
    this.render();
  }

  private toggle(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.render();
  }

  render(): void {
    const scrollTop = this.tree.scrollTop;
    clear(this.tree);
    const entries = store.list();
    if (entries.length === 0) {
      this.tree.appendChild(
        h(
          "div",
          { class: "side-empty" },
          h("div", { class: "side-empty-title" }, "No connections yet"),
          h("div", { class: "side-empty-text" }, "Add a PostgreSQL, MySQL, SQLite or SQL Server database to start exploring."),
          h("button", { class: "linkbtn", type: "button", onclick: () => this.host.importDataGrip() }, "Import from DataGrip…"),
        ),
      );
      return;
    }
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const e of entries) shown += this.renderConn(e, frag);
    if (shown === 0) frag.appendChild(h("div", { class: "empty-note" }, "Nothing matches the filter."));
    this.tree.appendChild(frag);
    this.tree.scrollTop = scrollTop;
  }

  private row(parent: DocumentFragment, s: RowSpec): HTMLElement {
    const caret = h("span", { class: "twisty" + (s.expandable ? (s.expanded ? " open" : "") : " none"), "aria-hidden": "true" }, s.expandable ? icon("caret", 10) : null);
    const r = h(
      "div",
      {
        class: "node-row " + (s.cls ?? "") + (this.selected === s.key ? " selected" : ""),
        role: "treeitem",
        "aria-level": String(s.depth + 1),
        "aria-expanded": s.expandable ? String(!!s.expanded) : undefined,
        "aria-selected": this.selected === s.key ? "true" : undefined,
        title: s.title,
      },
      h("span", { class: "indent", style: `width:${INDENT[Math.min(s.depth, INDENT.length - 1)]}px` }),
      caret,
      s.badge ?? s.icon ?? null,
      h("span", { class: "label" }, s.label),
      s.pk ? h("span", { class: "badge-pk" }, "PK") : null,
      s.meta ? h("span", { class: "meta" }, s.meta) : null,
      s.actions && s.actions.length ? h("span", { class: "node-actions" }, s.actions) : null,
    );
    r.addEventListener("click", (e) => {
      this.selected = s.key;
      s.onClick?.(e);
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
    parent.appendChild(r);
    return r;
  }

  private renderConn(e: ConnEntry, frag: DocumentFragment): number {
    const id = e.config.id;
    const ckey = "c:" + id;
    const f = this.filter;
    const connected = e.status === "connected";
    const nameMatch = !f || e.config.name.toLowerCase().includes(f);

    // Pre-compute filtered schema contents when connected.
    type G = { schema: SchemaNode; tables: TableNode[]; views: TableNode[] };
    const groups: G[] = [];
    if (connected) {
      for (const s of e.schemas) {
        const match = (t: TableNode): boolean => !f || t.name.toLowerCase().includes(f);
        const tables = s.tables.filter((t) => t.kind === "table" && match(t));
        const views = s.tables.filter((t) => t.kind === "view" && match(t));
        if (tables.length || views.length || (!f && s.tables.length === 0)) groups.push({ schema: s, tables, views });
      }
    }
    if (f && !nameMatch && groups.length === 0) return 0;

    const open = connected && (f ? true : this.expanded.has(ckey));
    const badge = h(
      "span",
      { class: "conn-badge " + e.status, style: `--c:${connColor(e.config)}`, title: `${DRIVER_LABELS[e.config.driver]} · ${STATUS_TEXT[e.status]}` },
      DRIVER_ABBR[e.config.driver],
    );
    const actions: HTMLElement[] = [];
    if (connected) {
      actions.push(h("button", { class: "icon-btn xs", type: "button", title: "New console", "aria-label": "New console", onclick: (ev: Event) => (ev.stopPropagation(), this.host.openConsole(id)) }, icon("terminal", 13)));
      actions.push(h("button", { class: "icon-btn xs", type: "button", title: "Disconnect", "aria-label": "Disconnect", onclick: (ev: Event) => (ev.stopPropagation(), void this.disconnect(id)) }, icon("unplug", 13)));
    } else if (e.status !== "connecting") {
      actions.push(h("button", { class: "icon-btn xs", type: "button", title: "Connect", "aria-label": "Connect", onclick: (ev: Event) => (ev.stopPropagation(), void this.connect(id)) }, icon("plug", 13)));
    }
    this.row(frag, {
      key: ckey,
      depth: 0,
      badge,
      label: e.config.name,
      meta: e.status === "connecting" ? "connecting…" : e.config.readOnly ? "read-only" : undefined,
      // Every connection shows a disclosure triangle: on an idle one it connects first.
      expandable: e.status !== "error" || connected,
      expanded: open,
      cls: "conn " + e.status,
      title: e.status === "error" && e.error ? e.error : `${e.config.name} — ${DRIVER_LABELS[e.config.driver]}${e.session ? " " + e.session.serverVersion : ""}`,
      actions,
      onClick: (ev) => {
        this.host.onSelect(id);
        const onTwisty = ev.target instanceof Element && ev.target.closest(".twisty") !== null;
        if (connected) this.toggle(ckey);
        else if (onTwisty && e.status === "idle") void this.connect(id);
        else this.render();
      },
      onDbl: () => {
        if (!connected) void this.connect(id);
        else this.host.openConsole(id);
      },
      onContext: (ev) => this.connMenu(ev, e),
    });
    if (e.status === "error" && e.error) {
      frag.appendChild(h("div", { class: "node-error", title: e.error }, e.error));
    }
    if (!connected || !open) return 1;

    for (const g of groups) {
      const s = g.schema;
      const single = groups.length === 1 && e.schemas.length === 1;
      let depth = 1;
      if (!single) {
        const skey = `s:${id}:${s.name}`;
        const sopen = f ? true : this.expanded.has(skey);
        this.row(frag, {
          key: skey,
          depth: 1,
          label: s.name,
          meta: s.name === e.session?.defaultSchema ? "default" : undefined,
          expandable: true,
          expanded: sopen,
          cls: "schema",
          onClick: () => this.toggle(skey),
          onContext: (ev) => showMenu(ev.clientX, ev.clientY, [
            { label: "Copy name", icon: "copy", onClick: () => this.host.copy(s.name) },
            { label: "Refresh", icon: "refresh", onClick: () => void this.refresh(id) },
          ]),
        });
        if (!sopen) continue;
        depth = 2;
      }
      // Tables sit directly under their schema; views get their own collapsible group after them.
      for (const t of g.tables) this.renderTable(frag, e, s, t, depth);
      if (g.tables.length === 0 && g.views.length === 0) {
        frag.appendChild(h("div", { class: "empty-note tree-note", style: `padding-left:${INDENT[Math.min(depth, INDENT.length - 1)] + 40}px` }, "No tables"));
      }
      if (g.views.length) {
        const gkey = `g:${id}:${s.name}:views`;
        const gopen = f ? true : this.expanded.has(gkey);
        this.row(frag, {
          key: gkey,
          depth,
          icon: icon("view", 14),
          label: "Views",
          meta: String(g.views.length),
          expandable: true,
          expanded: gopen,
          cls: "group",
          onClick: () => this.toggle(gkey),
        });
        if (gopen) for (const t of g.views) this.renderTable(frag, e, s, t, depth + 1);
      }
    }
    return 1;
  }

  private renderTable(frag: DocumentFragment, e: ConnEntry, s: SchemaNode, t: TableNode, depth: number): void {
    const id = e.config.id;
    const key = `t:${id}:${s.name}:${t.name}`;
    const open = this.expanded.has(key);
    const q = qualifiedName(e.config.driver, s.name, t.name);
    this.row(frag, {
      key,
      depth,
      label: t.name,
      meta: undefined,
      expandable: t.columns.length > 0,
      expanded: open,
      cls: "table",
      title: `${s.name}.${t.name}`,
      onClick: (ev) => {
        if ((ev as MouseEvent).detail > 1) return;
        this.toggle(key);
      },
      onDbl: () => {
        this.expanded.delete(key);
        this.render();
        this.host.openConsole(id, { sql: `SELECT * FROM ${q}`, run: true, title: t.name });
      },
      onContext: (ev) => showMenu(ev.clientX, ev.clientY, [
        { label: "Open data", icon: "table", onClick: () => this.host.openConsole(id, { sql: `SELECT * FROM ${q}`, run: true, title: t.name }) },
        { label: "New console", icon: "terminal", onClick: () => this.host.openConsole(id) },
        { sep: true },
        { label: "Copy name", icon: "copy", onClick: () => this.host.copy(q) },
        { label: "Refresh", icon: "refresh", onClick: () => void this.refresh(id) },
      ]),
    });
    if (!open) return;
    for (const c of t.columns) {
      this.row(frag, {
        key: `${key}:${c.name}`,
        depth: depth + 1,
        label: c.name,
        meta: c.dataType,
        pk: t.primaryKey.includes(c.name),
        cls: "column" + (t.primaryKey.includes(c.name) ? " is-pk" : ""),
        title: `${c.name} ${c.dataType}${c.nullable ? "" : " NOT NULL"}${c.defaultValue ? " DEFAULT " + c.defaultValue : ""}`,
        onContext: (ev) => showMenu(ev.clientX, ev.clientY, [{ label: "Copy name", icon: "copy", onClick: () => this.host.copy(c.name) }]),
      });
    }
  }

  private connMenu(ev: MouseEvent, e: ConnEntry): void {
    const id = e.config.id;
    const connected = e.status === "connected";
    showMenu(ev.clientX, ev.clientY, [
      connected
        ? { label: "Disconnect", icon: "unplug", onClick: () => void this.disconnect(id) }
        : { label: "Connect", icon: "plug", onClick: () => void this.connect(id) },
      { label: "New console", icon: "terminal", disabled: !connected, onClick: () => this.host.openConsole(id) },
      { label: "Refresh", icon: "refresh", disabled: !connected, onClick: () => void this.refresh(id) },
      { sep: true },
      { label: "Edit…", icon: "pencil", onClick: () => this.host.editConnection(id) },
      { label: "Copy name", icon: "copy", onClick: () => this.host.copy(e.config.name) },
      { sep: true },
      { label: "Delete", icon: "trash", danger: true, onClick: () => this.host.deleteConnection(id) },
    ]);
  }

  async connect(id: string): Promise<void> {
    try {
      await store.connect(id);
      this.expandConnection(id);
    } catch (err) {
      const msg = errMsg(err);
      const authFail = /password|authentication|access denied|login failed|auth failed|28P01|28000/i.test(msg);
      toast(`Could not connect: ${msg}${authFail ? "\nEdit connection to set the password." : ""}`, "error");
    }
  }

  async disconnect(id: string): Promise<void> {
    await store.disconnect(id);
  }

  async refresh(id: string): Promise<void> {
    try {
      await store.refresh(id);
      toast("Schema refreshed", "ok");
    } catch (err) {
      toast(`Refresh failed: ${errMsg(err)}`, "error");
    }
  }
}

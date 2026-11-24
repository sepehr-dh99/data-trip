// Left sidebar: connections -> schemas -> Tables/Views -> columns.
import type { SchemaNode, TableNode } from "../types";
import { DRIVER_LABELS } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { showMenu } from "./menu";
import type { ConnEntry } from "./state";
import { store } from "./state";
import { connColor, qualifiedName } from "./sqlutil";
import { toast } from "./toast";

export interface ExplorerHost {
  openConsole(connId: string, opts?: { sql?: string; run?: boolean; title?: string }): void;
  addConnection(): void;
  editConnection(id: string): void;
  deleteConnection(id: string): void;
  copy(text: string): void;
  onSelect(connId: string): void;
}

interface RowSpec {
  key: string;
  depth: number;
  icon?: HTMLElement;
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
      class: "input",
      type: "search",
      placeholder: "Filter tables…",
      "aria-label": "Filter explorer",
      oninput: () => {
        this.filter = this.filterInput.value.trim().toLowerCase();
        this.render();
      },
    });
    this.tree = h("div", { class: "tree", role: "tree" });
    this.el = h(
      "aside",
      { class: "panel sidebar", "aria-label": "Explorer" },
      h(
        "div",
        { class: "panel-head" },
        h("div", { class: "panel-title" }, icon("database", 15), "Explorer"),
        h("button", { class: "icon-btn", type: "button", title: "New connection", "aria-label": "New connection", onclick: () => host.addConnection() }, icon("plus", 16)),
      ),
      h("div", { class: "panel-search" }, icon("search", 13), this.filterInput),
      this.tree,
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
          icon("plug", 28),
          h("div", { class: "side-empty-title" }, "No connections yet"),
          h("div", { class: "side-empty-text" }, "Add a PostgreSQL, MySQL, SQLite or SQL Server database to start exploring."),
          h("button", { class: "btn primary", type: "button", onclick: () => this.host.addConnection() }, icon("plus", 14), "Add connection"),
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

  private row(parent: DocumentFragment, s: RowSpec): void {
    const caret = h("span", { class: "twisty" + (s.expandable ? (s.expanded ? " open" : "") : " none") }, s.expandable ? icon("chevron", 12) : null);
    const r = h(
      "div",
      {
        class: "node-row " + (s.cls ?? "") + (this.selected === s.key ? " selected" : ""),
        style: `padding-left:${8 + s.depth * 14}px`,
        role: "treeitem",
        "aria-expanded": s.expandable ? String(!!s.expanded) : undefined,
        title: s.title,
      },
      caret,
      s.icon ?? null,
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
        s.onContext?.(e);
      });
    }
    parent.appendChild(r);
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

    const open = f ? true : this.expanded.has(ckey);
    const color = connColor(e.config);
    const dot = h("span", { class: "conn-dot " + e.status, style: `--c:${color}`, title: e.status });
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
      icon: dot,
      label: e.config.name,
      meta: e.status === "connecting" ? "connecting…" : DRIVER_LABELS[e.config.driver].split(" ")[0],
      expandable: connected,
      expanded: open,
      cls: "conn " + e.status,
      title: e.status === "error" && e.error ? e.error : `${DRIVER_LABELS[e.config.driver]}${e.session ? " · " + e.session.serverVersion : ""}`,
      actions,
      onClick: () => {
        this.host.onSelect(id);
        if (connected) this.toggle(ckey);
        else this.render();
      },
      onDbl: () => {
        if (!connected) void this.connect(id);
        else this.host.openConsole(id);
      },
      onContext: (ev) => this.connMenu(ev, e),
    });
    if (e.status === "error" && e.error) {
      frag.appendChild(h("div", { class: "node-error", style: "padding-left:36px" }, e.error));
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
          icon: icon("schema", 15),
          label: s.name,
          meta: s.name === e.session?.defaultSchema ? "default" : undefined,
          expandable: true,
          expanded: sopen,
          onClick: () => this.toggle(skey),
          onContext: (ev) => showMenu(ev.clientX, ev.clientY, [
            { label: "Copy name", icon: "copy", onClick: () => this.host.copy(s.name) },
            { label: "Refresh", icon: "refresh", onClick: () => void this.refresh(id) },
          ]),
        });
        if (!sopen) continue;
        depth = 2;
      }
      const kinds: Array<["tables" | "views", TableNode[], string]> = [
        ["tables", g.tables, "Tables"],
        ["views", g.views, "Views"],
      ];
      for (const [kind, list, label] of kinds) {
        if (list.length === 0 && (f || kind === "views")) continue;
        const gkey = `g:${id}:${s.name}:${kind}`;
        const gopen = f ? true : this.expanded.has(gkey);
        this.row(frag, {
          key: gkey,
          depth,
          icon: icon(kind === "tables" ? "table" : "view", 15),
          label,
          meta: String(list.length),
          expandable: list.length > 0,
          expanded: gopen,
          cls: "group",
          onClick: () => list.length && this.toggle(gkey),
        });
        if (!gopen) continue;
        for (const t of list) this.renderTable(frag, e, s, t, depth + 1);
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
      icon: icon(t.kind === "view" ? "view" : "table", 15),
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
        icon: icon(t.primaryKey.includes(c.name) ? "key" : "dots", 13),
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
      toast(`Could not connect: ${errMsg(err)}`, "error");
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

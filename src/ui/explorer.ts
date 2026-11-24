// Left sidebar card: brand, filter and a lazy, virtualized DataGrip-style tree:
// connection -> databases (+ System databases) / Server objects -> schemas -> Tables / Views /
// Materialized views / Routines / Sequences -> table -> Columns / Keys / Foreign keys / Indexes.
import type { DatabaseNode, ForeignKeyNode, IndexNode, RoutineNode, SchemaNode, TableNode } from "../types";
import { DRIVER_LABELS } from "../types";
import { brandMark, clear, errMsg, h, icon } from "./dom";
import { showMenu } from "./menu";
import type { ConnEntry } from "./state";
import { store } from "./state";
import { connColor, qualifiedName } from "./sqlutil";
import { toast } from "./toast";

const ROW_H = 32;
const OVERSCAN = 8;
/** Indent (px) per tree depth, from the spec: 0 / 16 / 30, then +14 per level. */
const indentOf = (d: number): number => (d <= 0 ? 0 : 16 + (d - 1) * 14);
const DRIVER_ABBR: Record<string, string> = { postgres: "PG", mysql: "MY", sqlite: "SQ", mssql: "MS" };
const STATUS_TEXT: Record<string, string> = { idle: "not connected", connecting: "connecting…", connected: "connected", error: "connection failed" };

export interface OpenConsoleOpts {
  sql?: string;
  run?: boolean;
  title?: string;
  /** Database to bind the console to (null / undefined = the connection's default). */
  database?: string | null;
  /** Schema to default completion to. */
  schema?: string | null;
}

export interface ExplorerHost {
  openConsole(connId: string, opts?: OpenConsoleOpts): void;
  addConnection(): void;
  importDataGrip(): void;
  editConnection(id: string): void;
  deleteConnection(id: string): void;
  copy(text: string): void;
  onSelect(connId: string): void;
}

interface RowSpec {
  key: string;
  label: string;
  icon?: string;
  iconCls?: string;
  badge?: HTMLElement;
  meta?: string;
  metaMono?: boolean;
  tag?: string;
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
}

interface Flat {
  spec: RowSpec;
  depth: number;
  open: boolean;
}

function humanSize(n: number | null): string | undefined {
  if (n === null || n === undefined || n < 0) return undefined;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : Number(v.toFixed(1))} ${u[i]}`;
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
  private flat: Flat[] = [];
  private rendered = new Map<number, HTMLElement>();
  private scrollQueued = false;

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
    this.inner = h("div", { class: "tree-inner" });
    this.tree = h("div", { class: "tree", role: "tree", "aria-label": "Connections" }, this.inner);
    this.tree.addEventListener("scroll", () => {
      if (this.scrollQueued) return;
      this.scrollQueued = true;
      requestAnimationFrame(() => {
        this.scrollQueued = false;
        this.paintWindow(false);
      });
    });
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
    new ResizeObserver(() => this.paintWindow(false)).observe(this.tree);
  }

  // ------------------------------------------------------------------ expansion

  /** Opens the connection, its default database, that database's default schema and its tables. */
  expandConnection(id: string): void {
    this.expanded.add("c:" + id);
    const e = store.conns.get(id);
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
    const schemas = d.schemas;
    const ds = store.defaultSchemaFor(id, db === e.defaultDb ? null : db);
    const pick = (ds && schemas.find((s) => s.name === ds)?.name) ?? (schemas.find((s) => s.name === "public") ?? schemas[0])?.name;
    if (!pick) return;
    if (!this.skipSchemaLevel(e)) this.expanded.add(`s:${id}:${db}:${pick}`);
    this.expanded.add(`f:${id}:${db}:${pick}:tables`);
  }

  private toggle(spec: RowSpec): void {
    const key = spec.key;
    if (this.expanded.has(key)) this.expanded.delete(key);
    else {
      this.expanded.add(key);
      spec.onOpen?.();
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
    return {
      key: ckey,
      label: e.config.name,
      badge,
      meta: e.status === "connecting" ? "connecting…" : e.config.readOnly ? "read-only" : undefined,
      // Every connection shows a disclosure triangle: on an idle one it connects first.
      expandable: e.status !== "error" || connected,
      cls: "conn " + e.status,
      title: e.status === "error" && e.error ? e.error : `${e.config.name} — ${DRIVER_LABELS[e.config.driver]}${e.session ? " " + e.session.serverVersion : ""}`,
      actions,
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
      onContext: (ev) => this.connMenu(ev, e),
    };
  }

  private connChildren(e: ConnEntry): RowSpec[] {
    const id = e.config.id;
    const dbs = e.databases.slice().sort((a, b) => Number(b.name === e.defaultDb) - Number(a.name === e.defaultDb));
    const user = dbs.filter((d) => !d.isSystem);
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
    out.push({
      key: `so:${id}`,
      label: "Server objects",
      icon: "server",
      expandable: true,
      cls: "group",
      children: () => this.serverObjectGroups(e),
    });
    return out;
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
        return entry.schemas.map((s) => this.schemaSpec(e, d.name, s, s.name === ds));
      },
      onContext: (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "New console here", icon: "terminal", onClick: () => this.host.openConsole(id, { database: consoleDb }) },
          { label: "Refresh", icon: "refresh", onClick: () => void this.refreshDb(id, d.name) },
          { sep: true },
          { label: "Copy name", icon: "copy", onClick: () => this.host.copy(d.name) },
        ]),
    };
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
      children: () => this.schemaFolders(e, db, s),
      onContext: (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          { label: "New console", icon: "terminal", onClick: () => this.host.openConsole(id, { database: consoleDb, schema: s.name }) },
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
    if (s.routines?.length) out.push(folder("routines", "Routines", "func", s.routines.length, () => s.routines.map((r) => this.routineSpec(base, r))));
    if (s.sequences?.length) {
      out.push(folder("seqs", "Sequences", "seq", s.sequences.length, () => s.sequences.map((q) => ({ key: `${base}seq:${q}`, label: q, icon: "seq", cls: "leaf" }))));
    }
    if (out.length === 0) out.push(this.note(`em:${base}`, "Empty"));
    return out;
  }

  private routineSpec(base: string, r: RoutineNode): RowSpec {
    const sig = `${r.name}(${r.arguments ?? ""})`;
    return {
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
    const openData = (): void => this.host.openConsole(id, { sql: `SELECT * FROM ${q} `, run: true, title: t.name, database: consoleDb, schema: s.name });
    const colsKey = `${key}:cols`;
    const fkLabel = (fk: ForeignKeyNode): string => `→ ${fk.refSchema && fk.refSchema !== s.name ? fk.refSchema + "." : ""}${fk.refTable}(${fk.refColumns.join(", ")})`;
    const ixTag = (ix: IndexNode): string | undefined => (ix.primary ? "PK" : ix.unique ? "unique" : undefined);
    const hasKids = t.columns.length > 0;
    return {
      key,
      label: t.name,
      icon: t.kind === "view" ? "view" : t.kind === "materialized" ? "matview" : "table",
      expandable: hasKids,
      cls: "table",
      title: t.comment ? `${s.name}.${t.name} — ${t.comment}` : `${s.name}.${t.name}`,
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
            })),
          );
        }
        return out;
      },
    };
  }

  // ------------------------------------------------------------------ flattening

  private flatten(): Flat[] {
    const out: Flat[] = [];
    const f = this.filter;
    const entries = store.list();
    for (const e of entries) {
      const spec = this.connSpec(e);
      if (!f) this.walk(spec, 0, out);
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
          h("div", { class: "side-empty-text" }, "Add a PostgreSQL, MySQL, SQLite or SQL Server database to start exploring."),
          h("button", { class: "linkbtn", type: "button", onclick: () => this.host.importDataGrip() }, "Import from DataGrip…"),
        ),
      );
      return;
    }
    this.inner.style.height = n * ROW_H + "px";
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
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(n, Math.ceil((top + vh) / ROW_H) + OVERSCAN);
    for (const [i, el] of this.rendered) {
      if (i < start || i >= end) {
        el.remove();
        this.rendered.delete(i);
      }
    }
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
    const caret = h("span", { class: "twisty" + (expandable ? (fr.open ? " open" : "") : " none"), "aria-hidden": "true" }, expandable ? icon("caret", 10) : null);
    let lead: HTMLElement | null = s.badge ?? null;
    if (!lead && s.icon) {
      lead = icon(s.icon, 15);
      if (s.iconCls) lead.classList.add(s.iconCls);
    }
    const r = h(
      "div",
      {
        class: "node-row " + (s.cls ?? "") + (this.selected === s.key ? " selected" : "") + (s.actions && s.actions.length ? " has-actions" : ""),
        role: "treeitem",
        "aria-level": String(fr.depth + 1),
        "aria-expanded": expandable ? String(fr.open) : undefined,
        "aria-selected": this.selected === s.key ? "true" : undefined,
        title: s.title ?? (s.meta ? `${s.label} — ${s.meta}` : s.label),
        style: `top:${idx * ROW_H}px`,
      },
      h("span", { class: "indent", style: `width:${indentOf(fr.depth)}px` }),
      caret,
      lead,
      h("span", { class: "label" }, s.label),
      s.tag ? h("span", { class: "badge-tag" }, s.tag) : null,
      s.meta ? h("span", { class: "meta" + (s.metaMono ? " mono" : "") }, s.meta) : null,
      s.actions && s.actions.length ? h("span", { class: "node-actions" }, s.actions) : null,
    );
    r.addEventListener("click", (e) => {
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

  // ------------------------------------------------------------------ actions

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

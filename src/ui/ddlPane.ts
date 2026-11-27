// Show DDL (v0.16, board T): a read-only tab "<name> — DDL" with the object's CREATE statement read from the
// catalog (backend get_ddl), syntax-highlighted, with Indexes / Comments / Schema-qualified toggles, Copy and
// Open in console.
import "../styles/data.css";
import { api } from "../api";
import type { DdlKind } from "../types";
import { DRIVER_LABELS } from "../types";
import { clear, copyText, errMsg, h, icon } from "./dom";
import type { TabPane } from "./tabs";
import { store } from "./state";
import { toast } from "./toast";
import { shortcutLabel } from "./keymap";
import { highlightSql } from "./sqlHighlight";
import type { DbTarget } from "./dataTools";
import { consoleDb, dataHost, sessionFor } from "./dataTools";
import type { WsDdl } from "./workspace";

const KIND_LABEL: Record<DdlKind, string> = {
  table: "Table",
  view: "View",
  materialized: "Materialized view",
  function: "Function",
  procedure: "Procedure",
  sequence: "Sequence",
  index: "Index",
};
const KIND_ICON: Record<DdlKind, string> = { table: "table", view: "view", materialized: "matview", function: "func", procedure: "proc", sequence: "seq", index: "index" };

/** Renders highlighted SQL as numbered lines into `host`. */
export function renderSqlLines(host: HTMLElement, sql: string, numbers = true): number {
  clear(host);
  const lines = highlightSql(sql.replace(/\n$/, ""));
  lines.forEach((segs, i) => {
    const row = h("div", { class: "dd-line" });
    if (numbers) row.appendChild(h("span", { class: "dd-ln", "aria-hidden": "true" }, String(i + 1)));
    const code = h("span", { class: "dd-code" });
    for (const s of segs) code.appendChild(s.c === "ws" ? document.createTextNode(s.t) : h("span", { class: "syn-" + s.c }, s.t));
    if (!segs.length) code.textContent = "​";
    row.appendChild(code);
    host.appendChild(row);
  });
  return lines.length;
}

export class DdlPane implements TabPane {
  readonly kind = "ddl" as const;
  readonly el: HTMLElement;
  readonly controls: HTMLElement = h("div", { class: "cap-controls" });
  title: string;
  connId: string;
  database: string | null;
  readonly tabIcon: { icon: string; cls: string };
  private opts = { indexes: true, comments: true, qualified: true };
  private body = h("div", { class: "dd-body", tabindex: "0", "aria-label": "DDL" });
  private foot = h("span", { class: "dd-foot-info" });
  private toastEl = h("span", { class: "dd-foot-ok" });
  private btnCopy: HTMLButtonElement;
  private text = "";
  private seq = 0;
  private toggles: { key: "indexes" | "comments" | "qualified"; btn: HTMLButtonElement; enabled: boolean }[] = [];
  /** v0.17: restored on launch: the DDL is read when the tab is first shown. */
  private lazy = false;
  /** v0.17: the toggles changed (the shell saves the workspace). */
  onChange: (() => void) | null = null;

  /** `init.lazy`: restored on launch — read the DDL on first show; `init.options`: the saved toggles. */
  constructor(readonly target: DbTarget, init: { lazy?: boolean; options?: WsDdl["options"] } = {}) {
    if (init.options) this.opts = { ...init.options };
    const kind = target.kind as DdlKind;
    this.connId = target.connId;
    this.database = consoleDb(target.connId, target.database);
    this.title = `${target.name ?? ""} — DDL`;
    this.tabIcon = { icon: KIND_ICON[kind] ?? "table", cls: "tt-ddl" };
    const e = store.conns.get(target.connId);
    const driver = e?.config.driver ?? "postgres";
    const path = [target.database, driver === "mysql" || driver === "sqlite" ? null : target.schema, target.name].filter(Boolean).join(".") + (target.arguments ? (target.arguments.startsWith("(") ? target.arguments : `(${target.arguments})`) : "");
    const mk = (key: "indexes" | "comments" | "qualified", label: string, enabled: boolean, tip: string): HTMLButtonElement => {
      const btn = h(
        "button",
        { class: "dd-chk", type: "button", role: "checkbox", title: enabled ? "" : tip, disabled: !enabled, onclick: () => {
          this.opts[key] = !this.opts[key];
          this.syncToggles();
          void this.load();
          this.onChange?.();
        } },
        h("span", { class: "dd-box", "aria-hidden": "true" }),
        label,
      );
      this.toggles.push({ key, btn, enabled });
      return btn;
    };
    const tableLike = kind === "table" || kind === "materialized";
    this.btnCopy = h("button", { class: "btn sm", type: "button", onclick: () => void this.copy() }, icon("copy", 13), "Copy");
    const head = h(
      "div",
      { class: "dd-head" },
      h("span", { class: "dd-path mono", title: path }, path),
      h("span", { class: "dd-kind" }, `${KIND_LABEL[kind] ?? kind} · ${e?.config.name ?? ""}`),
      h("div", { class: "spacer" }),
      mk("indexes", "Indexes", tableLike, "Only tables and materialized views have indexes"),
      mk("comments", "Comments", driver !== "sqlite", "SQLite has no comments"),
      mk("qualified", "Schema-qualified", driver !== "sqlite", "SQLite names aren't schema-qualified"),
      this.btnCopy,
      h("button", { class: "btn sm primary", type: "button", onclick: () => this.openInConsole() }, "Open in console"),
    );
    const foot = h("div", { class: "dd-foot" }, this.foot, h("div", { class: "spacer" }), this.toastEl, h("span", null, `${shortcutLabel("showDdl") || "Show DDL"} from any table, view or routine`));
    this.el = h("div", { class: "ddl-pane" }, head, this.body, foot);
    this.syncToggles();
    if (init.lazy) this.lazy = true;
    else void this.load();
  }

  /** v0.17: what restore on launch saves for this tab. */
  snapshot(): WsDdl {
    const t = this.target;
    return { kind: t.kind as DdlKind, database: t.database, schema: t.schema, name: t.name ?? "", arguments: t.arguments ?? null, table: t.table ?? null, options: { ...this.opts } };
  }

  private syncToggles(): void {
    for (const t of this.toggles) {
      const on = t.enabled && this.opts[t.key];
      t.btn.classList.toggle("on", on);
      t.btn.setAttribute("aria-checked", String(on));
    }
  }

  get effectiveDatabase(): string | null {
    return this.target.database;
  }
  get isRunning(): boolean {
    return false;
  }
  focus(): void {
    this.body.focus({ preventScroll: true });
    if (this.lazy) {
      this.lazy = false;
      void this.load();
    }
  }
  async dispose(): Promise<void> {}
  dropSession(): void {}
  updateSchema(): void {}
  async switchDatabase(): Promise<void> {
    toast("A DDL tab shows one object — open Show DDL on another one", "info");
  }
  async switchConnection(): Promise<void> {}
  currentSchemaName(): string | null {
    return this.target.schema;
  }
  async setDefaultSchema(): Promise<void> {}

  /** Same object (an open tab is focused instead of a second one). */
  matches(t: DbTarget): boolean {
    const a = this.target;
    return a.connId === t.connId && a.database === t.database && a.schema === t.schema && a.name === t.name && a.kind === t.kind && (a.arguments ?? null) === (t.arguments ?? null);
  }

  async load(): Promise<void> {
    const my = ++this.seq;
    this.body.classList.add("loading");
    try {
      const sid = (await sessionFor(this.target.connId, this.target.database)).sessionId;
      const t = this.target;
      const ddl = await api.getDdl(sid, { kind: t.kind as DdlKind, schema: t.schema, name: t.name ?? "", arguments: t.arguments ?? null, table: t.table ?? null, options: { ...this.opts } });
      if (my !== this.seq) return;
      const e = store.conns.get(t.connId);
      const path = [t.database, e?.config.driver === "mysql" || e?.config.driver === "sqlite" ? null : t.schema, t.name].filter(Boolean).join(".");
      const kind = KIND_LABEL[t.kind as DdlKind] ?? t.kind;
      this.text = `-- ${path} · ${kind.toLowerCase()} · ${e?.config.name ?? ""} (${DRIVER_LABELS[e?.config.driver ?? "postgres"]})\n${ddl}`;
      const n = renderSqlLines(this.body, this.text);
      const now = new Date();
      this.foot.textContent = `Read from the catalog · ${n} lines · ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    } catch (err) {
      if (my !== this.seq) return;
      this.text = "";
      clear(this.body);
      this.body.appendChild(
        h(
          "div",
          { class: "dd-error" },
          icon("alert", 16),
          h("span", null, errMsg(err)),
          h("button", { class: "btn sm", type: "button", onclick: () => void this.load() }, "Try again"),
        ),
      );
      this.foot.textContent = "";
    } finally {
      if (my === this.seq) this.body.classList.remove("loading");
    }
  }

  private async copy(): Promise<void> {
    if (!this.text) return;
    await copyText(this.text);
    this.btnCopy.lastChild!.textContent = "Copied ✓";
    window.setTimeout(() => {
      if (this.btnCopy.lastChild) this.btnCopy.lastChild.textContent = "Copy";
    }, 1600);
  }

  private openInConsole(): void {
    if (!this.text) return;
    const t = this.target;
    dataHost().openConsole(t.connId, { sql: this.text, database: consoleDb(t.connId, t.database), schema: t.schema });
    const e = store.conns.get(t.connId);
    toast(`Opened in a new console on ${e?.config.name ?? "the data source"}${t.database ? " · " + t.database : ""} (not run)`, "ok");
  }
}

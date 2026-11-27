// Table designer (v0.16, board V): a tab with Columns / Indexes / Foreign keys grids and a live SQL preview of
// the exact statements (CREATE TABLE for a new table, ALTERs for an existing one; SQLite rebuilds the table when
// ALTER can't). Apply confirms, runs them on a dedicated session in one transaction where the engine allows
// (MySQL: in order, stopping at the first error), then refreshes the explorer and reloads the design.
import "../styles/data.css";
import { api } from "../api";
import type { Driver } from "../types";
import { clear, copyText, errMsg, h, icon } from "./dom";
import type { TabPane } from "./tabs";
import { store } from "./state";
import { toast } from "./toast";
import { showMenu } from "./menu";
import { isProdConnection } from "./ai";
import type { DCol, DFk, DIdx, DesignOrig, DesignState, Dialect, Stmt } from "./designerSql";
import { DIALECT_NAMES, TYPE_LISTS, designSql, runnable, sameType, transactionalDdl } from "./designerSql";
import { renderSqlLines } from "./ddlPane";
import type { DbTarget } from "./dataTools";
import { consoleDb, findTable, sessionFor } from "./dataTools";

const BEGIN: Record<Dialect, string> = { postgres: "BEGIN", mysql: "START TRANSACTION", sqlite: "BEGIN", mssql: "BEGIN TRANSACTION" };
const COMMIT: Record<Dialect, string> = { postgres: "COMMIT", mysql: "COMMIT", sqlite: "COMMIT", mssql: "COMMIT TRANSACTION" };
const ROLLBACK: Record<Dialect, string> = { postgres: "ROLLBACK", mysql: "ROLLBACK", sqlite: "ROLLBACK", mssql: "ROLLBACK TRANSACTION" };
const ON_DELETE = ["", "CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT"];

function dialectOf(d: Driver): Dialect {
  return d === "mysql" ? "mysql" : d === "mssql" ? "mssql" : d === "sqlite" ? "sqlite" : "postgres";
}

function chk(on: boolean, label: string, onclick: () => void, disabled = false): HTMLButtonElement {
  return h(
    "button",
    { class: "dd-chk solo" + (on ? " on" : ""), type: "button", role: "checkbox", "aria-checked": String(on), "aria-label": label, title: label, disabled, onclick },
    h("span", { class: "dd-box", "aria-hidden": "true" }),
  );
}

export class DesignerPane implements TabPane {
  readonly kind = "design" as const;
  readonly el: HTMLElement;
  readonly controls: HTMLElement = h("div", { class: "cap-controls" });
  title: string;
  connId: string;
  database: string | null;
  readonly tabIcon = { icon: "table", cls: "tt-design" };
  private d: Dialect;
  private schema: string | null;
  private st: DesignState;
  private orig: DesignOrig | null = null;
  private sub: "cols" | "idx" | "fk" = "cols";
  private nNew = 0;
  private stmts: Stmt[] = [];
  private gridEl = h("div", { class: "ds-grid" });
  private subEl = h("div", { class: "seg ds-sub", role: "radiogroup", "aria-label": "Section" });
  private addBtn = h("button", { class: "btn sm", type: "button", onclick: () => this.addThing() });
  private nameInput: HTMLInputElement;
  private sqlEl = h("div", { class: "ds-sql dd-body", tabindex: "0", "aria-label": "SQL preview" });
  private countEl = h("span", { class: "ds-count" });
  private txEl = h("div", { class: "ds-tx" });
  private appliedEl = h("div", { class: "ds-applied" });
  private applyBtn: HTMLButtonElement;
  private copyBtn: HTMLButtonElement;
  private headTitle = h("span", { class: "ds-title" });
  private rowEls = new Map<string, HTMLElement>();
  private busy = false;

  constructor(readonly target: DbTarget, readonly create: boolean) {
    const e = store.conns.get(target.connId);
    this.d = dialectOf(e?.config.driver ?? "postgres");
    this.connId = target.connId;
    this.database = consoleDb(target.connId, target.database);
    this.schema = target.schema ?? (this.d === "sqlite" ? "main" : null);
    const name = create ? "new_table" : (target.name ?? "");
    this.st = { schema: this.schema, name, cols: [], idx: [], fks: [] };
    this.title = create ? "New table — Design" : `${name} — Design`;
    if (create) {
      const idType = this.d === "sqlite" ? "INTEGER" : this.d === "mysql" ? "BIGINT" : "bigint";
      this.st.cols = [{ k: "n1", name: "id", type: idType, nn: true, def: "", pk: true, cmt: "" }];
      this.nNew = 1;
    }
    this.nameInput = h("input", {
      class: "input mono ds-name",
      type: "text",
      spellcheck: false,
      "aria-label": "Table name",
      value: name,
      oninput: () => {
        this.st.name = this.nameInput.value.trim();
        this.changed();
      },
    });
    this.applyBtn = h("button", { class: "btn sm primary", type: "button", onclick: () => this.askApply() }, "Apply…");
    this.copyBtn = h("button", { class: "btn sm", type: "button", onclick: () => void this.copySql() }, "Copy");
    const prefix = this.schema && this.d !== "sqlite" ? `${this.schema}.` : this.d === "sqlite" ? "(main)" : "";
    const top = h(
      "div",
      { class: "ds-top" },
      h("span", { class: "ds-tab" }, icon("table", 13), this.headTitle),
      h("div", { class: "spacer" }),
      h("span", { class: "ds-src" }, `${e?.config.name ?? ""} · ${DIALECT_NAMES[this.d]}${target.database ? " · " + target.database : ""}`),
    );
    const bar = h(
      "div",
      { class: "ds-bar" },
      h("label", { class: "ds-namewrap" }, h("span", { class: "mono ds-prefix" }, prefix), this.nameInput),
      this.subEl,
      h("div", { class: "spacer" }),
      this.addBtn,
    );
    const left = h("div", { class: "ds-main" }, bar, this.gridEl);
    const aside = h(
      "aside",
      { class: "ds-aside", "aria-label": "SQL preview" },
      h("div", { class: "ds-aside-head" }, h("b", null, "SQL preview"), this.countEl, h("div", { class: "spacer" }), this.copyBtn),
      this.sqlEl,
      h(
        "div",
        { class: "ds-aside-foot" },
        this.txEl,
        this.appliedEl,
        h("div", { class: "ds-actions" }, h("button", { class: "btn sm", type: "button", onclick: () => this.revertAll() }, "Revert all"), this.applyBtn),
      ),
    );
    this.el = h("div", { class: "designer-pane" }, top, h("div", { class: "ds-split" }, left, aside));
    this.headTitle.textContent = this.title;
    this.render();
    if (!create) void this.loadExisting(name);
  }

  get effectiveDatabase(): string | null {
    return this.target.database;
  }
  get isRunning(): boolean {
    return this.busy;
  }
  get dirty(): boolean {
    return this.stmts.some((s) => !s.note);
  }
  focus(): void {
    this.nameInput.focus({ preventScroll: true });
  }
  async dispose(): Promise<void> {}
  dropSession(): void {}
  updateSchema(): void {}
  async switchDatabase(): Promise<void> {
    toast("The designer edits one table", "info");
  }
  async switchConnection(): Promise<void> {}
  currentSchemaName(): string | null {
    return this.schema;
  }
  async setDefaultSchema(): Promise<void> {}

  matches(t: DbTarget, create: boolean): boolean {
    return !create && this.orig !== null && t.connId === this.connId && t.database === this.target.database && t.schema === this.target.schema && t.name === this.orig.name;
  }

  // ------------------------------------------------------------------ load

  private async loadExisting(name: string): Promise<void> {
    this.gridEl.textContent = "Loading…";
    try {
      const sess = await sessionFor(this.connId, this.target.database);
      const t = findTable(this.connId, this.target.database, this.target.schema, name);
      if (!t) throw new Error(`${name} wasn't found — refresh the explorer`);
      const ex = await api.tableExtras(sess.sessionId, this.schema, name).catch(() => null);
      const pkIx = t.indexes?.find((i) => i.primary);
      const cols: DCol[] = t.columns.map((c, i) => ({
        k: "c" + i,
        name: c.name,
        type: c.dataType,
        nn: !c.nullable,
        def: c.defaultValue ?? "",
        pk: t.primaryKey.includes(c.name),
        cmt: ex?.comments[c.name] ?? "",
        auto: !!ex && (ex.autoIncrement.includes(c.name) || (ex.autoIncrement.includes("*") && t.primaryKey.length === 1 && t.primaryKey[0] === c.name)),
      }));
      const idx: DIdx[] = (t.indexes ?? []).map((x, i) => ({ k: "i" + i, name: x.name, cols: x.columns.join(", "), uniq: x.unique, prim: x.primary }));
      const fks: DFk[] = (t.foreignKeys ?? []).map((f, i) => ({
        k: "f" + i,
        name: f.name,
        cols: f.columns.join(", "),
        ref: f.refSchema && f.refSchema !== this.schema ? `${f.refSchema}.${f.refTable}` : f.refTable,
        refCols: f.refColumns.join(", "),
        onDelete: ex?.fkOnDelete[f.name] ?? "",
      }));
      this.orig = {
        schema: this.schema,
        name,
        cols: cols.map((c) => ({ ...c })),
        idx: idx.map((x) => ({ ...x })),
        fks: fks.map((f) => ({ ...f })),
        pkName: pkIx?.name ?? null,
        defaultConstraints: ex?.defaultConstraints ?? {},
        autoIncrement: !!ex?.autoIncrement.includes("*"),
      };
      this.st = { schema: this.schema, name, cols, idx, fks };
      this.nameInput.value = name;
      this.title = `${name} — Design`;
      this.headTitle.textContent = this.title;
      this.render();
    } catch (err) {
      clear(this.gridEl);
      this.gridEl.appendChild(h("div", { class: "dd-error" }, icon("alert", 16), h("span", null, errMsg(err)), h("button", { class: "btn sm", type: "button", onclick: () => void this.loadExisting(name) }, "Try again")));
    }
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    const nCols = this.st.cols.filter((c) => !c.deleted).length;
    const nIdx = this.st.idx.filter((x) => !x.deleted).length;
    const nFk = this.st.fks.filter((f) => !f.deleted).length;
    clear(this.subEl);
    for (const [id, label] of [["cols", `Columns ${nCols}`], ["idx", `Indexes ${nIdx}`], ["fk", `Foreign keys ${nFk}`]] as const) {
      this.subEl.appendChild(
        h("button", { class: "seg-btn" + (this.sub === id ? " on" : ""), type: "button", role: "radio", "aria-checked": String(this.sub === id), onclick: () => { this.sub = id; this.render(); } }, label),
      );
    }
    this.addBtn.textContent = this.sub === "cols" ? "+ Add column" : this.sub === "idx" ? "+ Add index" : "+ Add foreign key";
    this.rowEls.clear();
    clear(this.gridEl);
    if (this.sub === "cols") this.renderCols();
    else if (this.sub === "idx") this.renderIdx();
    else this.renderFks();
    this.updatePreview();
  }

  private origCol(k: string): DCol | undefined {
    return this.orig?.cols.find((c) => c.k === k);
  }

  private colMark(c: DCol): string {
    if (!this.orig) return "";
    if (c.deleted) return " dropped";
    const o = this.origCol(c.k);
    if (!o) return " new";
    const ch = o.name !== c.name || !sameType(this.d, o.type, c.type) || o.nn !== c.nn || o.def.trim() !== c.def.trim() || o.cmt.trim() !== c.cmt.trim() || o.pk !== c.pk;
    return ch ? " changed" : "";
  }

  private renderCols(): void {
    const head = h("div", { class: "ds-row ds-cols ds-hrow" }, h("span"), h("span", null, "Name"), h("span", null, "Type"), h("span", null, "Not null"), h("span", null, "Default"), h("span", null, "PK"), h("span", null, this.d === "sqlite" ? "Comment (not saved by SQLite)" : "Comment"), h("span"));
    this.gridEl.appendChild(head);
    const cols = this.st.cols;
    cols.forEach((c, i) => {
      const row = h("div", { class: "ds-row ds-cols" + this.colMark(c) });
      const set = (patch: Partial<DCol>, rerender = false): void => {
        Object.assign(c, patch);
        if (rerender) this.render();
        else {
          row.className = "ds-row ds-cols" + this.colMark(c);
          this.updatePreview();
        }
      };
      const name = h("input", { class: "input mono ds-in", type: "text", spellcheck: false, "aria-label": "Column name", value: c.name, disabled: !!c.deleted, oninput: () => set({ name: name.value.trim() }) });
      const type = h("input", { class: "input mono ds-in ds-type", type: "text", spellcheck: false, "aria-label": "Type", value: c.type, disabled: !!c.deleted, oninput: () => set({ type: type.value }) });
      const typeBtn = h("button", { class: "ds-typebtn", type: "button", title: `${DIALECT_NAMES[this.d]} types`, "aria-label": "Choose a type", disabled: !!c.deleted, onclick: (ev: MouseEvent) => {
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu(r.left - 140, r.bottom + 4, TYPE_LISTS[this.d].map((t) => ({ label: t.type, hint: t.hint, checked: sameType(this.d, t.type, c.type), onClick: () => {
          type.value = t.type;
          set({ type: t.type });
        } })), { minWidth: 240 });
      } }, "▾");
      const def = h("input", { class: "input mono ds-in", type: "text", spellcheck: false, placeholder: "—", "aria-label": "Default (SQL expression)", title: "An SQL expression: 'text' needs quotes; 0, true, now()…", value: c.def, disabled: !!c.deleted, oninput: () => set({ def: def.value }) });
      const cmt = h("input", { class: "input ds-in", type: "text", placeholder: "Add a comment", "aria-label": "Comment", value: c.cmt, disabled: !!c.deleted, oninput: () => set({ cmt: cmt.value }) });
      const isNew = !this.origCol(c.k);
      row.append(
        h("span", { class: "ds-grip", "aria-hidden": "true" }, "⋮⋮"),
        name,
        h("span", { class: "ds-typewrap" }, type, typeBtn),
        chk(c.nn, "Not null", () => set({ nn: !c.nn }, true), !!c.deleted),
        def,
        chk(c.pk, "Primary key", () => set({ pk: !c.pk, nn: !c.pk ? true : c.nn }, true), !!c.deleted),
        cmt,
        h(
          "span",
          { class: "ds-acts" },
          h("button", { class: "icon-btn xs", type: "button", "aria-label": "Move up", title: "Move up", disabled: i === 0, onclick: () => this.move(i, -1) }, "▲"),
          h("button", { class: "icon-btn xs", type: "button", "aria-label": "Move down", title: "Move down", disabled: i === cols.length - 1, onclick: () => this.move(i, 1) }, "▼"),
          h(
            "button",
            { class: "icon-btn xs " + (c.deleted ? "ds-restore" : "ds-del"), type: "button", "aria-label": c.deleted ? "Restore column" : "Delete column", title: c.deleted ? "Restore column" : "Delete column", onclick: () => {
              if (isNew && this.orig) this.st.cols = this.st.cols.filter((x) => x !== c);
              else if (!this.orig) this.st.cols = this.st.cols.filter((x) => x !== c);
              else c.deleted = !c.deleted;
              this.render();
            } },
            c.deleted ? "↺" : "✕",
          ),
        ),
      );
      this.rowEls.set(c.k, row);
      this.gridEl.appendChild(row);
    });
    this.gridEl.appendChild(
      h(
        "div",
        { class: "ds-legend" },
        this.orig ? [h("span", null, h("i", { class: "ok" }, "▌"), " new"), h("span", null, h("i", { class: "warn" }, "▌"), " changed"), h("span", null, h("i", { class: "bad" }, "▌"), " dropped")] : null,
        h("span", null, `▲▼ reorder · ▾ for the ${DIALECT_NAMES[this.d]} type list, or type any type`),
      ),
    );
  }

  private renderIdx(): void {
    this.gridEl.appendChild(h("div", { class: "ds-row ds-idx ds-hrow" }, h("span", null, "Name"), h("span", null, "Columns"), h("span", null, "Unique"), h("span", null, "Kind"), h("span")));
    for (const x of this.st.idx) {
      const o = this.orig?.idx.find((y) => y.k === x.k);
      const mark = !this.orig ? "" : x.deleted ? " dropped" : !o ? " new" : o.name !== x.name || o.cols !== x.cols || o.uniq !== x.uniq ? " changed" : "";
      const row = h("div", { class: "ds-row ds-idx" + mark });
      const upd = (): void => {
        const m = !this.orig ? "" : x.deleted ? " dropped" : !o ? " new" : o.name !== x.name || o.cols !== x.cols || o.uniq !== x.uniq ? " changed" : "";
        row.className = "ds-row ds-idx" + m;
        this.updatePreview();
      };
      const ro = !!x.prim || !!x.deleted;
      const name = h("input", { class: "input mono ds-in", type: "text", spellcheck: false, "aria-label": "Index name", value: x.name, disabled: ro, oninput: () => { x.name = name.value.trim(); upd(); } });
      const cols = h("input", { class: "input mono ds-in", type: "text", spellcheck: false, "aria-label": "Index columns", placeholder: "a, b DESC", value: x.cols, disabled: ro, oninput: () => { x.cols = cols.value; upd(); } });
      row.append(
        name,
        cols,
        chk(x.uniq, "Unique", () => { x.uniq = !x.uniq; this.render(); }, ro),
        h("span", { class: "ds-kind" }, x.prim ? "primary key (edit the PK column flags)" : x.uniq ? "unique index" : "index"),
        x.prim
          ? h("span")
          : h("button", { class: "icon-btn xs " + (x.deleted ? "ds-restore" : "ds-del"), type: "button", "aria-label": x.deleted ? "Restore index" : "Drop index", title: x.deleted ? "Restore index" : "Drop index", onclick: () => {
              if (!o) this.st.idx = this.st.idx.filter((y) => y !== x);
              else x.deleted = !x.deleted;
              this.render();
            } }, x.deleted ? "↺" : "✕"),
      );
      this.gridEl.appendChild(row);
    }
    if (!this.st.idx.length) this.gridEl.appendChild(h("div", { class: "ds-empty" }, "No indexes. Add one with “+ Add index”."));
  }

  private renderFks(): void {
    this.gridEl.appendChild(h("div", { class: "ds-row ds-fk ds-hrow" }, h("span", null, "Name"), h("span", null, "Columns"), h("span", null, "References table"), h("span", null, "Columns"), h("span", null, "On delete"), h("span")));
    for (const f of this.st.fks) {
      const o = this.orig?.fks.find((y) => y.k === f.k);
      const isNew = !o;
      const row = h("div", { class: "ds-row ds-fk" + (!this.orig ? "" : f.deleted ? " dropped" : isNew ? " new" : "") });
      const ro = !isNew || !!f.deleted;
      const inp = (key: "name" | "cols" | "ref" | "refCols", label: string, ph = ""): HTMLInputElement => {
        const el = h("input", { class: "input mono ds-in", type: "text", spellcheck: false, "aria-label": label, placeholder: ph, value: f[key], disabled: ro, oninput: () => { f[key] = el.value; this.updatePreview(); } });
        return el;
      };
      const sel = h("select", { class: "input ds-in", "aria-label": "On delete", disabled: ro, onchange: () => { f.onDelete = sel.value; this.updatePreview(); } }, ON_DELETE.map((a) => h("option", { value: a }, a || "NO ACTION")));
      sel.value = ON_DELETE.includes(f.onDelete.toUpperCase()) ? f.onDelete.toUpperCase() : "";
      row.append(
        inp("name", "Foreign key name"),
        inp("cols", "Columns", "customer_id"),
        inp("ref", "Referenced table", this.schema && this.d !== "sqlite" ? `${this.schema}.customers` : "customers"),
        inp("refCols", "Referenced columns", "id"),
        sel,
        h("button", { class: "icon-btn xs " + (f.deleted ? "ds-restore" : "ds-del"), type: "button", "aria-label": f.deleted ? "Restore foreign key" : "Drop foreign key", title: f.deleted ? "Restore" : "Drop foreign key", onclick: () => {
          if (isNew) this.st.fks = this.st.fks.filter((y) => y !== f);
          else f.deleted = !f.deleted;
          this.render();
        } }, f.deleted ? "↺" : "✕"),
      );
      this.gridEl.appendChild(row);
    }
    if (!this.st.fks.length) this.gridEl.appendChild(h("div", { class: "ds-empty" }, "No foreign keys on this table. Add one with “+ Add foreign key”."));
    // Tables referencing this one (from the explorer's metadata).
    if (this.orig) {
      const refs: string[] = [];
      for (const s of store.schemasFor(this.connId, this.database)) {
        for (const t of s.tables) {
          for (const fk of t.foreignKeys ?? []) {
            if (fk.refTable === this.orig.name && (fk.refSchema === null || fk.refSchema === this.schema || this.d === "mysql" || this.d === "sqlite")) refs.push(`${t.name}.${fk.columns.join(", ")} → ${this.orig.name}.${fk.refColumns.join(", ")} (${fk.name})`);
          }
        }
      }
      if (refs.length) this.gridEl.appendChild(h("div", { class: "ds-refby" }, h("b", null, "Referenced by "), refs.slice(0, 8).join(" · "), " — dropping or retyping those columns would break them."));
    }
  }

  private move(i: number, dir: number): void {
    const j = i + dir;
    const a = this.st.cols;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    this.render();
  }

  private addThing(): void {
    this.nNew++;
    const n = this.nNew;
    if (this.sub === "cols") {
      const type = this.d === "sqlite" ? "TEXT" : this.d === "mysql" ? "VARCHAR(255)" : this.d === "mssql" ? "nvarchar(255)" : "text";
      this.st.cols.push({ k: "n" + n, name: `column_${n}`, type, nn: false, def: "", pk: false, cmt: "" });
    } else if (this.sub === "idx") {
      const c = this.st.cols.find((x) => !x.deleted && !x.pk) ?? this.st.cols[0];
      this.st.idx.push({ k: "ni" + n, name: `${this.st.name || "t"}_${c?.name ?? "col"}_idx`, cols: c?.name ?? "", uniq: false });
    } else {
      this.st.fks.push({ k: "nf" + n, name: `${this.st.name || "t"}_fk${n}`, cols: "", ref: "", refCols: "id", onDelete: "" });
    }
    this.render();
  }

  private revertAll(): void {
    if (!this.orig) {
      const idType = this.d === "sqlite" ? "INTEGER" : this.d === "mysql" ? "BIGINT" : "bigint";
      this.st = { schema: this.schema, name: "new_table", cols: [{ k: "n1", name: "id", type: idType, nn: true, def: "", pk: true, cmt: "" }], idx: [], fks: [] };
    } else {
      const o = this.orig;
      this.st = { schema: o.schema, name: o.name, cols: o.cols.map((c) => ({ ...c })), idx: o.idx.map((x) => ({ ...x })), fks: o.fks.map((f) => ({ ...f })) };
    }
    this.nameInput.value = this.st.name;
    this.appliedEl.textContent = "";
    this.render();
  }

  private changed(): void {
    this.appliedEl.textContent = "";
    this.updatePreview();
  }

  // ------------------------------------------------------------------ preview

  /** What's wrong with the design (null = fine). */
  private problem(): string | null {
    if (!this.st.name.trim()) return "Give the table a name.";
    const live = this.st.cols.filter((c) => !c.deleted);
    if (!live.length) return "A table needs at least one column.";
    const seen = new Set<string>();
    for (const c of live) {
      if (!c.name.trim()) return "Every column needs a name.";
      if (!c.type.trim()) return `Column ${c.name} needs a type.`;
      const k = c.name.toLowerCase();
      if (seen.has(k)) return `Two columns are named ${c.name}.`;
      seen.add(k);
    }
    for (const x of this.st.idx) if (!x.deleted && !x.prim && (!x.name.trim() || !x.cols.trim())) return "Every index needs a name and columns.";
    for (const f of this.st.fks) if (!f.deleted && (!f.name.trim() || !f.cols.trim() || !f.ref.trim() || !f.refCols.trim())) return "Every foreign key needs a name, columns and the referenced table and columns.";
    return null;
  }

  private updatePreview(): void {
    let res: { stmts: Stmt[]; rebuild: boolean };
    try {
      res = designSql(this.d, this.st, this.orig);
    } catch (e) {
      res = { stmts: [{ sql: `-- ${errMsg(e)}`, note: true }], rebuild: false };
    }
    this.stmts = res.stmts;
    const text = res.stmts.length ? res.stmts.map((s) => s.sql).join("\n\n") : "-- No changes yet";
    renderSqlLines(this.sqlEl, text, false);
    const n = runnable(res.stmts).length;
    this.countEl.textContent = `${n} statement${n === 1 ? "" : "s"}`;
    const e = store.conns.get(this.connId);
    const prob = this.problem();
    const ro = e?.config.readOnly === true;
    this.applyBtn.disabled = n === 0 || !!prob || ro || this.busy;
    this.txEl.className = "ds-tx" + (prob || ro || this.d === "mysql" ? " warn" : "");
    this.txEl.textContent = ro
      ? "This data source is read-only."
      : prob
        ? prob
        : this.d === "mysql"
          ? "MySQL commits each DDL statement on its own, so this can’t run in one transaction: statements run in order and stop at the first error."
          : `${DIALECT_NAMES[this.d]} runs all statements in one transaction — if any fails, nothing changes.${e && isProdConnection(e.config) ? ` ${e.config.name} is a production data source: you’ll confirm first.` : ""}`;
  }

  private async copySql(): Promise<void> {
    await copyText(this.stmts.map((s) => s.sql).join("\n\n"));
    this.copyBtn.textContent = "Copied ✓";
    window.setTimeout(() => (this.copyBtn.textContent = "Copy"), 1500);
  }

  // ------------------------------------------------------------------ apply

  private askApply(): void {
    const stmts = runnable(this.stmts);
    if (!stmts.length || this.busy) return;
    const e = store.conns.get(this.connId);
    const prod = !!e && isProdConnection(e.config);
    const overlay = h("div", { class: "overlay" });
    const close = (): void => {
      window.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 160);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        close();
      }
    };
    const sql = h("div", { class: "dd-body ds-confirm-sql" });
    renderSqlLines(sql, this.stmts.map((s) => s.sql).join("\n\n"), false);
    const ok = h("button", { class: "btn " + (prod ? "danger-solid" : "primary"), type: "button", onclick: () => { close(); void this.apply(); } }, transactionalDdl(this.d) ? "Apply in one transaction" : `Run ${stmts.length} statement${stmts.length === 1 ? "" : "s"}`);
    overlay.appendChild(
      h(
        "div",
        { class: "dialog ds-confirm", role: "alertdialog", "aria-modal": "true", "aria-label": "Apply changes" },
        h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon("alert", 18), `Apply ${stmts.length} statement${stmts.length === 1 ? "" : "s"} to ${this.st.name}?`)),
        h(
          "div",
          { class: "dialog-body" },
          h("div", { class: "ds-confirm-sub" + (prod ? " prod" : "") }, `${e?.config.name ?? ""} · ${DIALECT_NAMES[this.d]}${prod ? " · Production data source" : ""}`),
          sql,
          h("div", { class: "ds-tx" + (this.d === "mysql" ? " warn" : "") }, this.txEl.textContent ?? ""),
        ),
        h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"), ok),
      ),
    );
    document.body.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    ok.focus();
  }

  private async apply(): Promise<void> {
    const stmts = runnable(this.stmts);
    const d = this.d;
    this.busy = true;
    this.updatePreview();
    this.appliedEl.className = "ds-applied";
    this.appliedEl.textContent = "Applying…";
    const started = performance.now();
    let sid: string | null = null;
    let inTx = false;
    let failedAt: string | null = null;
    try {
      sid = (await api.openSession(this.connId, this.database)).sessionId;
      // SQLite: PRAGMA foreign_keys has no effect inside a transaction.
      const pre = stmts.filter((s) => d === "sqlite" && /^PRAGMA foreign_keys\s*=\s*OFF/i.test(s));
      const post = stmts.filter((s) => d === "sqlite" && /^PRAGMA foreign_keys\s*=\s*ON/i.test(s));
      const main = stmts.filter((s) => !pre.includes(s) && !post.includes(s));
      for (const s of pre) await api.execute(sid, s, 1);
      if (transactionalDdl(d)) {
        await api.execute(sid, BEGIN[d], 1);
        inTx = true;
      }
      for (const s of main) {
        failedAt = s;
        await api.execute(sid, s, 1);
      }
      failedAt = null;
      if (inTx) {
        await api.execute(sid, COMMIT[d], 1);
        inTx = false;
      }
      for (const s of post) await api.execute(sid, s, 1);
      const ms = Math.round(performance.now() - started);
      const newName = this.st.name;
      await store.refreshDb(this.connId, this.target.database ?? store.conns.get(this.connId)?.defaultDb ?? "").catch(() => undefined);
      this.busy = false;
      await this.loadExisting(newName);
      this.appliedEl.className = "ds-applied ok";
      this.appliedEl.textContent = `✓ Applied ${stmts.length} statement${stmts.length === 1 ? "" : "s"} in ${ms} ms · table reloaded`;
      toast(`${newName}: changes applied`, "ok");
    } catch (err) {
      if (inTx && sid) await api.execute(sid, ROLLBACK[d], 1).catch(() => undefined);
      this.appliedEl.className = "ds-applied bad";
      this.appliedEl.textContent = `✕ ${errMsg(err)}${failedAt ? ` — in: ${failedAt.split("\n")[0].slice(0, 120)}` : ""}${inTx ? " · rolled back, nothing changed" : d === "mysql" && failedAt ? " · statements before it were applied" : ""}`;
      if (d === "mysql") await store.refreshDb(this.connId, this.target.database ?? "").catch(() => undefined);
    } finally {
      this.busy = false;
      if (sid) void api.closeSession(sid).catch(() => undefined);
      this.updatePreview();
    }
  }
}

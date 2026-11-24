// Virtualized result grid: fixed row height, windowed rendering, client-side sort/filter,
// range selection, TSV copy and (optionally) pending cell edits.
import type { Cell, ColumnMeta, QueryResult, RowEdit } from "../types";
import type { EditContext } from "./sqlutil";
import { clear, copyText, debounce, h, icon } from "./dom";
import { showMenu } from "./menu";

const ROW_H = 34;
const RN_MIN = 44;
/** Empty space under the last row so it can scroll clear of the floating result pill. */
const BOTTOM_PAD = 68;
const OVERSCAN = 8;
const NUMERIC_TYPE = /int|serial|numeric|decimal|float|double|real|number|money|bit\b/i;
const TEMPORAL_TYPE = /date|time|interval/i;
const IS_MAC = /Mac/.test(navigator.userAgent);
const MODK = IS_MAC ? "⌘" : "Ctrl+";
const BOOL_TYPE = /^(bool|boolean)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface GridCallbacks {
  onSubmit(edits: RowEdit[]): Promise<void>;
  onLoadMore(): void;
  onExport(): void;
}

/** Presentation tweaks for read-only uses of the grid (Redis key viewer / console). */
export interface GridOptions {
  hideExport?: boolean;
  hideReadOnlyChip?: boolean;
  /** Context menu with the copy actions only. */
  plainMenu?: boolean;
  /** Stretch the last column over the free width. */
  fillLast?: boolean;
  /** Replaces the "N rows" text of the result pill. */
  countLabel?: (shown: number, total: number, truncated: boolean) => string;
  loadMoreLabel?: string;
  loadMoreTitle?: string;
  /** Minimum width (px) per column, by index. */
  minWidths?: number[];
}

interface InsertRow {
  cells: Cell[];
  touched: Set<number>;
}

interface Pos {
  r: number;
  c: number;
}

type RowEl = HTMLDivElement & { _ri?: number; _wv?: number; _cells?: HTMLDivElement[]; _rn?: HTMLDivElement };

export class ResultGrid {
  readonly el: HTMLElement;
  private cb: GridCallbacks;
  private opts: GridOptions = {};
  private baseWidths: number[] = [];
  private btnExport!: HTMLButtonElement;

  // data
  private cols: ColumnMeta[] = [];
  private rows: Cell[][] = [];
  private truncated = false;
  private maxRows = 0;
  private widths: number[] = [];
  private numeric: boolean[] = [];
  private order: number[] = [];
  private rnW = RN_MIN;
  // view state
  private sortCol = -1;
  private sortDir: 1 | -1 = 1;
  private filter = "";
  private anchor: Pos | null = null;
  private head: Pos | null = null;
  private dragging = false;
  // editing
  private ctx: EditContext | null = null;
  private reason = "";
  private overrides = new Map<number, Map<number, Cell>>();
  private inserts: InsertRow[] = [];
  private deleted = new Set<number>();
  private editor: HTMLInputElement | null = null;
  private submitting = false;

  // dom
  private pill: HTMLElement;
  private filterInput: HTMLInputElement;
  private filterWrap: HTMLElement;
  private countEl: HTMLElement;
  private metaEl: HTMLElement;
  private meta = "";
  private btnLoadMore: HTMLButtonElement;
  private roChip: HTMLElement;
  private btnAdd: HTMLButtonElement;
  private pendGroup: HTMLElement;
  private btnSubmit: HTMLButtonElement;
  private btnRevert: HTMLButtonElement;
  private btnDelete: HTMLButtonElement;
  private btnNull: HTMLButtonElement;
  private pendingEl: HTMLElement;
  private scroller: HTMLElement;
  private headEl: HTMLElement;
  private cornerEl: HTMLElement;
  private colCls: string[] = [];
  private body: HTMLElement;
  private active = new Map<number, RowEl>();
  private pool: RowEl[] = [];
  private widthVersion = 0;
  private raf = 0;
  private fullRefill = true;
  private poolColCount = -1;

  constructor(cb: GridCallbacks) {
    this.cb = cb;
    this.filterInput = h("input", {
      class: "pill-input",
      type: "search",
      placeholder: "Filter rows",
      "aria-label": "Filter rows",
      spellcheck: false,
      oninput: debounce(() => {
        this.filter = this.filterInput.value.trim().toLowerCase();
        this.rebuildOrder();
      }, 140),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          this.filterInput.value = "";
          this.filter = "";
          this.rebuildOrder();
          this.filterWrap.classList.remove("open");
          this.focus();
        } else if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          this.focus();
        }
      },
      onblur: () => {
        if (!this.filterInput.value) this.filterWrap.classList.remove("open");
      },
    });
    const filterBtn = h(
      "button",
      {
        class: "pill-icon",
        type: "button",
        title: "Filter rows",
        "aria-label": "Filter rows",
        onclick: () => {
          const open = !this.filterWrap.classList.contains("open") || !this.filterInput.value;
          this.filterWrap.classList.add("open");
          if (open) this.filterInput.focus();
        },
      },
      icon("search", 14),
    );
    this.filterWrap = h("div", { class: "pill-filter" }, filterBtn, this.filterInput);
    this.countEl = h("span", { class: "pill-count" });
    this.metaEl = h("span", { class: "pill-meta", "aria-live": "polite" });
    this.btnLoadMore = h("button", { class: "pill-link", type: "button", onclick: () => this.cb.onLoadMore() }, "Load more");
    this.roChip = h("span", { class: "pill-chip" }, "read-only");
    const btn = (label: string, fn: () => void, cls = "", title = label): HTMLButtonElement => h("button", { class: "pill-btn " + cls, type: "button", title, onclick: fn }, label);
    const btnExport = btn("Export", () => this.cb.onExport(), "", "Export result to CSV or JSON");
    this.btnExport = btnExport;
    this.btnAdd = btn("+ Row", () => this.addRow(), "", "Add a row");
    this.pendingEl = h("span", { class: "pill-pending" });
    this.btnRevert = btn("Revert", () => this.revert(), "", "Discard pending changes");
    this.btnDelete = btn("Delete row", () => this.deleteSelected(), "", "Mark selected rows for deletion (again to undo)");
    this.btnNull = btn("Set NULL", () => this.nullSelected(), "", "Set selected cells to NULL");
    this.btnSubmit = btn("Submit", () => void this.submit(), "accent", `Write pending changes to the database (${MODK}S)`);
    this.pendGroup = h("div", { class: "pill-group pending" }, h("span", { class: "pill-sep", "aria-hidden": "true" }), this.pendingEl, this.btnRevert, this.btnDelete, this.btnNull, this.btnSubmit);
    this.pill = h(
      "div",
      { class: "float-pill g-pill", role: "toolbar", "aria-label": "Result" },
      h("span", { class: "pill-stat" }, h("span", { class: "pill-dot", "aria-hidden": "true" }), this.countEl),
      this.metaEl,
      this.btnLoadMore,
      this.roChip,
      this.filterWrap,
      h("div", { class: "pill-group" }, btnExport, this.btnAdd),
      this.pendGroup,
    );
    this.cornerEl = h("div", { class: "g-corner" });
    this.headEl = h("div", { class: "g-head", role: "row" });
    const headBar = h("div", { class: "g-headbar" }, this.cornerEl, h("div", { class: "g-headclip" }, this.headEl));
    this.body = h("div", { class: "g-body" });
    this.scroller = h("div", { class: "g-scroll", tabindex: "0", role: "grid", "aria-label": "Result rows" }, this.body);
    this.el = h("div", { class: "grid" }, headBar, this.scroller, h("div", { class: "pill-wrap" }, this.pill));

    this.scroller.addEventListener(
      "scroll",
      () => {
        const x = this.scroller.scrollLeft;
        this.headEl.style.transform = x ? `translate3d(${-x}px,0,0)` : "";
        this.scroller.classList.toggle("hs", x > 0);
        this.schedule();
      },
      { passive: true },
    );
    this.scroller.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.scroller.addEventListener("dblclick", (e) => this.onDblClick(e));
    this.scroller.addEventListener("keydown", (e) => this.onKey(e));
    this.scroller.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    new ResizeObserver(() => {
      this.fitLast();
      this.schedule();
    }).observe(this.scroller);
  }

  /** Read-only presentation tweaks; call before setResult. */
  setOptions(o: GridOptions): void {
    this.opts = o;
    this.btnExport.hidden = o.hideExport === true;
    if (o.loadMoreLabel) this.btnLoadMore.textContent = o.loadMoreLabel;
    this.updateBar();
  }

  /** With fillLast: the last column takes whatever width the others leave free. */
  private fitLast(): void {
    if (!this.opts.fillLast || this.cols.length === 0) return;
    const last = this.cols.length - 1;
    let others = this.rnW;
    for (let i = 0; i < last; i++) others += this.widths[i];
    const avail = this.scroller.clientWidth - others - 2;
    const w = Math.max(this.baseWidths[last] ?? this.widths[last], avail);
    if (w === this.widths[last]) return;
    this.widths[last] = w;
    const hc = this.headEl.children[last] as HTMLElement | undefined;
    if (hc) hc.style.width = w + "px";
    this.widthVersion++;
    this.body.style.width = this.totalW() + "px";
    this.headEl.style.width = this.totalW() - this.rnW + "px";
  }

  /** Timing / server text shown next to the row count, e.g. "15 ms · PostgreSQL 16.2". */
  setMeta(text: string): void {
    this.meta = text;
    if (!this.flashTimer) this.metaEl.textContent = text;
  }

  // ---------------------------------------------------------------- data in

  setResult(res: QueryResult, ctx: EditContext | null, reason: string, maxRows: number): void {
    this.cols = res.columns;
    this.rows = res.rows;
    this.truncated = res.truncated;
    this.maxRows = maxRows;
    this.ctx = ctx;
    this.reason = reason;
    this.overrides.clear();
    this.inserts = [];
    this.deleted.clear();
    this.anchor = this.head = null;
    this.cancelEdit();
    this.submitting = false;
    this.numeric = this.cols.map((c) => NUMERIC_TYPE.test(c.typeName));
    this.colCls = this.cols.map((c, i) => (this.numeric[i] ? " num" : TEMPORAL_TYPE.test(c.typeName) ? " t" : ""));
    this.rnW = Math.max(RN_MIN, String(this.rows.length).length * 7 + 22);
    const keep = this.widths.length === this.cols.length && this.sortCol >= 0 ? this.sortCol : -1;
    this.widths = this.cols.map((c, i) => Math.max(this.autoWidth(c, i), this.opts.minWidths?.[i] ?? 0));
    this.baseWidths = [...this.widths];
    this.sortCol = keep;
    if (keep < 0) this.sortDir = 1;
    this.poolColCount = -1;
    this.buildHeader();
    this.fitLast();
    this.rebuildOrder();
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.headEl.style.transform = "";
    this.scroller.classList.remove("hs");
    this.updateBar();
  }

  hasPending(): boolean {
    return this.pendingCount() > 0;
  }

  focus(): void {
    this.scroller.focus({ preventScroll: true });
  }

  private autoWidth(c: ColumnMeta, i: number): number {
    let len = c.name.length + 3;
    const n = Math.min(this.rows.length, 60);
    for (let r = 0; r < n; r++) {
      const v = this.rows[r][i];
      const l = v === null ? 4 : String(v).length;
      if (l > len) len = l;
    }
    return Math.max(72, Math.min(360, Math.round(len * (this.numeric[i] ? 7.6 : 7.9) + (this.numeric[i] ? 34 : 26))));
  }

  private totalW(): number {
    let t = this.rnW;
    for (const w of this.widths) t += w;
    return t;
  }

  // ---------------------------------------------------------------- cell access

  private n(): number {
    return this.rows.length;
  }

  private getCell(ri: number, c: number): Cell {
    const n = this.n();
    if (ri >= n) return this.inserts[ri - n].cells[c];
    const o = this.overrides.get(ri);
    if (o && o.has(c)) return o.get(c) as Cell;
    return this.rows[ri][c];
  }

  private fmt(v: Cell): string {
    if (v === null) return "NULL";
    if (typeof v === "string") return v.length > 400 ? v.slice(0, 400) + "…" : v;
    return String(v);
  }

  private pendingCount(): number {
    return this.overrides.size + this.inserts.length + this.deleted.size;
  }

  private editable(): boolean {
    return this.ctx !== null;
  }

  private cellEditable(ri: number, c: number): boolean {
    if (!this.ctx || this.ctx.colMap[c] === null) return false;
    return !this.deleted.has(ri);
  }

  // ---------------------------------------------------------------- order (filter + sort)

  private rebuildOrder(): void {
    const n = this.n();
    let idx: number[] = [];
    if (this.filter) {
      const f = this.filter;
      for (let i = 0; i < n; i++) {
        const row = this.rows[i];
        for (let c = 0; c < row.length; c++) {
          const v = this.getCell(i, c);
          if (v !== null && String(v).toLowerCase().includes(f)) {
            idx.push(i);
            break;
          }
        }
      }
    } else {
      idx = new Array<number>(n);
      for (let i = 0; i < n; i++) idx[i] = i;
    }
    if (this.sortCol >= 0) {
      const c = this.sortCol;
      const dir = this.sortDir;
      const num = this.numeric[c];
      const rows = this.rows;
      const keys = new Map<number, Cell>();
      for (const i of idx) keys.set(i, this.getCell(i, c));
      idx.sort((a, b) => {
        const x = keys.get(a) as Cell;
        const y = keys.get(b) as Cell;
        if (x === null || y === null) return x === y ? a - b : x === null ? 1 : -1;
        let d: number;
        if (typeof x === "number" && typeof y === "number") d = x - y;
        else if (num && !isNaN(Number(x)) && !isNaN(Number(y))) d = Number(x) - Number(y);
        else if (typeof x === "boolean" || typeof y === "boolean") d = Number(x) - Number(y);
        else d = collator.compare(String(x), String(y));
        return d === 0 ? a - b : d * dir;
      });
      void rows;
    }
    for (let k = 0; k < this.inserts.length; k++) idx.push(n + k);
    this.order = idx;
    this.body.style.height = idx.length * ROW_H + BOTTOM_PAD + "px";
    this.body.style.width = this.totalW() + "px";
    this.headEl.style.width = this.totalW() - this.rnW + "px";
    this.clampSelection();
    this.fullRefill = true;
    this.updateBar();
    this.schedule();
  }

  private clampSelection(): void {
    const last = this.order.length - 1;
    if (last < 0 || !this.anchor || !this.head) {
      if (last < 0) this.anchor = this.head = null;
      return;
    }
    this.anchor = { r: Math.min(this.anchor.r, last), c: this.anchor.c };
    this.head = { r: Math.min(this.head.r, last), c: this.head.c };
  }

  // ---------------------------------------------------------------- header

  private buildHeader(): void {
    clear(this.headEl);
    this.cornerEl.style.width = this.rnW + "px";
    this.cols.forEach((col, i) => {
      const isPk = !!this.ctx && this.ctx.colMap[i] !== null && this.ctx.pk.includes(this.ctx.colMap[i] as string);
      const sortMark = h("span", { class: "g-sort" });
      const hc = h(
        "div",
        { class: "g-hc" + (this.numeric[i] ? " num" : ""), role: "columnheader", style: `width:${this.widths[i]}px`, title: `${col.name} — ${col.typeName}${isPk ? " · primary key" : ""}\nClick to sort` },
        h("div", { class: "g-hc-main" }, isPk ? icon("key", 11) : null, h("span", { class: "g-hc-name" }, col.name), sortMark),
      );
      (hc as HTMLElement & { _sort?: HTMLElement })._sort = sortMark;
      hc.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("g-rs")) return;
        this.toggleSort(i);
      });
      const rs = h("div", { class: "g-rs" });
      rs.addEventListener("pointerdown", (e) => this.startResize(e, i, hc));
      hc.appendChild(rs);
      this.headEl.appendChild(hc);
    });
    this.updateSortMarks();
  }

  private updateSortMarks(): void {
    const cells = this.headEl.querySelectorAll<HTMLElement>(".g-hc");
    cells.forEach((hc, i) => {
      const m = (hc as HTMLElement & { _sort?: HTMLElement })._sort;
      if (!m) return;
      m.textContent = i === this.sortCol ? (this.sortDir === 1 ? "▲" : "▼") : "";
      hc.classList.toggle("sorted", i === this.sortCol);
    });
  }

  private toggleSort(c: number): void {
    if (this.sortCol !== c) {
      this.sortCol = c;
      this.sortDir = 1;
    } else if (this.sortDir === 1) this.sortDir = -1;
    else this.sortCol = -1;
    this.updateSortMarks();
    this.rebuildOrder();
  }

  private startResize(e: PointerEvent, i: number, hc: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = this.widths[i];
    const move = (ev: PointerEvent): void => {
      this.widths[i] = Math.max(48, Math.min(1200, startW + ev.clientX - startX));
      this.baseWidths[i] = this.widths[i];
      hc.style.width = this.widths[i] + "px";
      this.widthVersion++;
      this.body.style.width = this.totalW() + "px";
      this.headEl.style.width = this.totalW() - this.rnW + "px";
      this.schedule();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col");
    };
    document.body.classList.add("resizing-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---------------------------------------------------------------- rendering

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private makeRow(): RowEl {
    const row = h("div", { class: "g-row", role: "row" }) as RowEl;
    const rn = h("div", { class: "g-rn" });
    row.appendChild(rn);
    row._rn = rn;
    row._cells = [];
    for (let c = 0; c < this.cols.length; c++) {
      const cell = h("div", { class: "g-cell", role: "gridcell" });
      row._cells.push(cell);
      row.appendChild(cell);
    }
    return row;
  }

  private selRect(): { r0: number; r1: number; c0: number; c1: number } | null {
    if (!this.anchor || !this.head) return null;
    return {
      r0: Math.min(this.anchor.r, this.head.r),
      r1: Math.max(this.anchor.r, this.head.r),
      c0: Math.min(this.anchor.c, this.head.c),
      c1: Math.max(this.anchor.c, this.head.c),
    };
  }

  private render(): void {
    const total = this.order.length;
    const viewH = this.scroller.clientHeight;
    const top = this.scroller.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(total - 1, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);
    if (this.poolColCount !== this.cols.length) {
      this.pool = [];
      this.poolColCount = this.cols.length;
      clear(this.body);
      this.active.clear();
      this.fullRefill = true;
    }
    if (this.fullRefill) {
      // Hide pooled rows: when the window shrinks (filter, delete) unused ones would stay visible.
      for (const [, r] of this.active) {
        r.style.display = "none";
        this.pool.push(r);
      }
      this.active.clear();
      this.fullRefill = false;
    }
    for (const [i, r] of this.active) {
      if (i < first || i > last) {
        this.active.delete(i);
        r.style.display = "none";
        this.pool.push(r);
      }
    }
    const sel = this.selRect();
    const multi = !!sel && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1);
    const cur = this.head;
    const n = this.n();
    const ncol = this.cols.length;
    const tw = this.totalW() + "px";
    for (let i = first; i <= last; i++) {
      let row = this.active.get(i);
      if (!row) {
        row = this.pool.pop();
        if (!row) {
          row = this.makeRow();
          this.body.appendChild(row);
        }
        this.active.set(i, row);
      }
      row.style.display = "";
      row.style.top = i * ROW_H + "px";
      row.style.width = tw;
      const ri = this.order[i];
      const isNew = ri >= n;
      const isDel = this.deleted.has(ri);
      const rowSel = !!sel && i >= sel.r0 && i <= sel.r1;
      row.className =
        "g-row" +
        (isNew ? " new" : "") +
        (isDel ? " del" : "") +
        (rowSel ? " rowsel" + (i === sel.r0 ? " r0" : "") + (i === sel.r1 ? " r1" : "") : "");
      const rn = row._rn as HTMLDivElement;
      rn.style.width = this.rnW + "px";
      rn.textContent = isNew ? "+" : String(ri + 1);
      const ov = this.overrides.get(ri);
      const cells = row._cells as HTMLDivElement[];
      for (let c = 0; c < ncol; c++) {
        const cell = cells[c];
        const v = this.getCell(ri, c);
        let cls = "g-cell" + this.colCls[c];
        if (v === null) cls += " null";
        if (ov && ov.has(c)) cls += " dirty";
        else if (isNew && this.inserts[ri - n].touched.has(c)) cls += " dirty";
        if (sel && rowSel && c >= sel.c0 && c <= sel.c1) {
          if (multi) cls += " sel";
          if (cur && cur.r === i && cur.c === c) cls += " cur";
        }
        cell.className = cls;
        cell.style.width = this.widths[c] + "px";
        const text = this.fmt(v);
        if (cell.textContent !== text) cell.textContent = text;
      }
    }
    if (this.editor) this.positionEditor();
  }

  // ---------------------------------------------------------------- selection & pointer

  private hit(e: MouseEvent): Pos | null {
    const rect = this.body.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const x = e.clientX - rect.left;
    if (this.order.length === 0) return null;
    let r = Math.floor(y / ROW_H);
    r = Math.max(0, Math.min(this.order.length - 1, r));
    // The row-number gutter is sticky: compare against viewport-relative x.
    const gutterX = e.clientX - this.scroller.getBoundingClientRect().left;
    if (gutterX < this.rnW) return { r, c: -1 };
    let acc = this.rnW;
    for (let c = 0; c < this.widths.length; c++) {
      acc += this.widths[c];
      if (x < acc) return { r, c };
    }
    return { r, c: this.widths.length - 1 };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".g-head") || t.closest(".g-edit")) return;
    if (!t.closest(".g-body")) return;
    this.commitEdit();
    const p = this.hit(e);
    if (!p) return;
    this.scroller.focus({ preventScroll: true });
    const last = this.cols.length - 1;
    if (p.c < 0) {
      // row number: select whole row(s)
      if (e.shiftKey && this.anchor) this.head = { r: p.r, c: last };
      else {
        this.anchor = { r: p.r, c: 0 };
        this.head = { r: p.r, c: last };
      }
      this.dragMode = "row";
    } else {
      if (e.shiftKey && this.anchor) this.head = p;
      else this.anchor = this.head = p;
      this.dragMode = "cell";
    }
    this.dragging = true;
    this.fullRefill = true;
    this.schedule();
    this.updateBar();
    const move = (ev: PointerEvent): void => {
      if (!this.dragging) return;
      const q = this.hit(ev);
      if (!q) return;
      const nh = this.dragMode === "row" ? { r: q.r, c: last } : { r: q.r, c: Math.max(0, q.c) };
      if (!this.head || nh.r !== this.head.r || nh.c !== this.head.c) {
        this.head = nh;
        this.fullRefill = true;
        this.schedule();
      }
    };
    const up = (): void => {
      this.dragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  private dragMode: "cell" | "row" = "cell";

  private selectAll(): void {
    if (this.order.length === 0) return;
    this.anchor = { r: 0, c: 0 };
    this.head = { r: this.order.length - 1, c: this.cols.length - 1 };
    this.fullRefill = true;
    this.schedule();
    this.updateBar();
  }

  private move(dr: number, dc: number, extend: boolean): void {
    if (this.order.length === 0 || this.cols.length === 0) return;
    const base = this.head ?? { r: 0, c: 0 };
    const nh = {
      r: Math.max(0, Math.min(this.order.length - 1, base.r + dr)),
      c: Math.max(0, Math.min(this.cols.length - 1, base.c + dc)),
    };
    this.head = nh;
    if (!extend || !this.anchor) this.anchor = nh;
    this.fullRefill = true;
    this.scrollTo(nh);
    this.schedule();
    this.updateBar();
  }

  private scrollTo(p: Pos): void {
    const s = this.scroller;
    const top = p.r * ROW_H;
    if (top < s.scrollTop) s.scrollTop = top;
    else if (top + ROW_H > s.scrollTop + s.clientHeight - BOTTOM_PAD) s.scrollTop = top + ROW_H - (s.clientHeight - BOTTOM_PAD);
    let left = this.rnW;
    for (let c = 0; c < p.c; c++) left += this.widths[c];
    const right = left + this.widths[p.c];
    if (left - this.rnW < s.scrollLeft) s.scrollLeft = left - this.rnW;
    else if (right > s.scrollLeft + s.clientWidth) s.scrollLeft = right - s.clientWidth;
  }

  private onKey(e: KeyboardEvent): void {
    if (this.editor) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (mod && (k === "a" || k === "A")) {
      e.preventDefault();
      this.selectAll();
    } else if (mod && (k === "c" || k === "C")) {
      e.preventDefault();
      void this.copySelection(e.shiftKey);
    } else if (mod && (k === "s" || k === "S")) {
      e.preventDefault();
      void this.submit();
    } else if (k === "ArrowDown") (e.preventDefault(), this.move(1, 0, e.shiftKey));
    else if (k === "ArrowUp") (e.preventDefault(), this.move(-1, 0, e.shiftKey));
    else if (k === "ArrowLeft") (e.preventDefault(), this.move(0, -1, e.shiftKey));
    else if (k === "ArrowRight") (e.preventDefault(), this.move(0, 1, e.shiftKey));
    else if (k === "Tab") (e.preventDefault(), this.move(0, e.shiftKey ? -1 : 1, false));
    else if (k === "PageDown") (e.preventDefault(), this.move(Math.floor(this.scroller.clientHeight / ROW_H) - 1, 0, e.shiftKey));
    else if (k === "PageUp") (e.preventDefault(), this.move(-(Math.floor(this.scroller.clientHeight / ROW_H) - 1), 0, e.shiftKey));
    else if (k === "Home") (e.preventDefault(), this.move(mod ? -1e9 : 0, -1e9, e.shiftKey));
    else if (k === "End") (e.preventDefault(), this.move(mod ? 1e9 : 0, 1e9, e.shiftKey));
    else if (k === "Enter" || k === "F2") {
      if (this.head) {
        e.preventDefault();
        this.startEdit(this.head);
      }
    }
  }

  private async copySelection(withHeader: boolean): Promise<void> {
    const sel = this.selRect();
    if (!sel) return;
    const q = (s: string): string => (/[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const lines: string[] = [];
    if (withHeader) {
      const hd: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) hd.push(q(this.cols[c].name));
      lines.push(hd.join("\t"));
    }
    for (let r = sel.r0; r <= sel.r1; r++) {
      const ri = this.order[r];
      const out: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) {
        const v = this.getCell(ri, c);
        out.push(v === null ? "" : q(String(v)));
      }
      lines.push(out.join("\t"));
    }
    await copyText(lines.join("\n"));
    const cnt = (sel.r1 - sel.r0 + 1) * (sel.c1 - sel.c0 + 1);
    this.flash(`Copied ${cnt.toLocaleString()} cell${cnt === 1 ? "" : "s"}`);
  }

  private flashTimer = 0;
  private flash(msg: string): void {
    this.metaEl.textContent = msg;
    this.metaEl.classList.add("flash");
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = 0;
      this.metaEl.classList.remove("flash");
      this.metaEl.textContent = this.meta;
    }, 1600);
  }

  // ---------------------------------------------------------------- context menu

  private onContextMenu(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (!t.closest(".g-body") || t.closest(".g-edit")) return;
    e.preventDefault();
    this.commitEdit();
    const p = this.hit(e);
    if (!p) return;
    const sel = this.selRect();
    const inside = !!sel && p.r >= sel.r0 && p.r <= sel.r1 && (p.c < 0 || (p.c >= sel.c0 && p.c <= sel.c1));
    if (!inside) {
      const last = this.cols.length - 1;
      if (p.c < 0) {
        this.anchor = { r: p.r, c: 0 };
        this.head = { r: p.r, c: last };
      } else this.anchor = this.head = p;
      this.fullRefill = true;
      this.schedule();
      this.updateBar();
    }
    const editable = this.editable();
    const cell = this.head;
    const ri = cell ? this.order[cell.r] : undefined;
    const canEditCell = editable && !!cell && ri !== undefined && this.cellEditable(ri, cell.c);
    const anyDeleted = (() => {
      const s2 = this.selRect();
      if (!s2) return false;
      for (let r = s2.r0; r <= s2.r1; r++) if (this.deleted.has(this.order[r])) return true;
      return false;
    })();
    if (this.opts.plainMenu) {
      showMenu(e.clientX, e.clientY, [
        { label: "Copy", icon: "copy", hint: MODK + "C", onClick: () => void this.copySelection(false) },
        { label: "Copy with header", icon: "copy", hint: MODK + "⇧C", onClick: () => void this.copySelection(true) },
      ]);
      return;
    }
    showMenu(e.clientX, e.clientY, [
      { label: "Copy", icon: "copy", hint: MODK + "C", onClick: () => void this.copySelection(false) },
      { label: "Copy with header", icon: "copy", hint: MODK + "⇧C", onClick: () => void this.copySelection(true) },
      { sep: true },
      { label: "Edit cell", icon: "pencil", hint: "↵", disabled: !canEditCell, onClick: () => cell && this.startEdit(cell) },
      { label: "Set NULL", icon: "x", disabled: !editable, onClick: () => this.nullSelected() },
      { label: anyDeleted ? "Restore row" : "Delete row", icon: anyDeleted ? "undo" : "minus", danger: !anyDeleted, disabled: !editable, onClick: () => this.deleteSelected() },
      { label: "Add row", icon: "plus", disabled: !editable, onClick: () => this.addRow() },
    ]);
  }

  // ---------------------------------------------------------------- editing

  private onDblClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (!t.closest(".g-body")) return;
    const p = this.hit(e);
    if (p && p.c >= 0) this.startEdit(p);
  }

  private startEdit(p: Pos): void {
    this.commitEdit();
    if (!this.editable()) {
      this.flash(this.reason || "Read-only result");
      return;
    }
    const ri = this.order[p.r];
    if (ri === undefined || !this.cellEditable(ri, p.c)) {
      this.flash(this.deleted.has(ri) ? "Row is marked for deletion" : "Computed column is read-only");
      return;
    }
    const v = this.getCell(ri, p.c);
    const input = h("input", { class: "g-edit", type: "text", spellcheck: false });
    input.value = v === null ? "" : String(v);
    input.placeholder = v === null ? "NULL" : "";
    input.dataset.r = String(p.r);
    input.dataset.c = String(p.c);
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.commitEdit();
        this.move(1, 0, false);
        this.focus();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.cancelEdit();
        this.focus();
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        this.commitEdit();
        this.move(0, ev.shiftKey ? -1 : 1, false);
        this.focus();
      }
    });
    input.addEventListener("blur", () => this.commitEdit());
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    this.editor = input;
    this.anchor = this.head = p;
    this.body.appendChild(input);
    this.positionEditor();
    input.focus();
    input.select();
    this.fullRefill = true;
    this.schedule();
  }

  private positionEditor(): void {
    const ed = this.editor;
    if (!ed) return;
    const r = Number(ed.dataset.r);
    const c = Number(ed.dataset.c);
    let left = this.rnW;
    for (let i = 0; i < c; i++) left += this.widths[i];
    ed.style.top = r * ROW_H + "px";
    ed.style.left = left + "px";
    ed.style.width = this.widths[c] + "px";
    ed.style.height = ROW_H + "px";
  }

  private cancelEdit(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.remove();
  }

  private parseValue(c: number, text: string, orig: Cell): Cell {
    if (text === "" && orig === null) return null;
    const type = this.cols[c].typeName;
    if (/^null$/i.test(text) && orig === null) return null;
    if (BOOL_TYPE.test(type)) {
      if (/^(true|t|1)$/i.test(text)) return true;
      if (/^(false|f|0)$/i.test(text)) return false;
    }
    if (NUMERIC_TYPE.test(type) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text.trim())) {
      const num = Number(text);
      if (Number.isSafeInteger(num) || String(num) === text.trim()) return num;
    }
    return text;
  }

  private commitEdit(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    const r = Number(ed.dataset.r);
    const c = Number(ed.dataset.c);
    const text = ed.value;
    ed.remove();
    const ri = this.order[r];
    if (ri === undefined) return;
    const orig = this.getCell(ri, c);
    if (orig !== null && String(orig) === text) return;
    this.setCell(ri, c, this.parseValue(c, text, orig));
  }

  private setCell(ri: number, c: number, v: Cell): void {
    const n = this.n();
    if (ri >= n) {
      const ins = this.inserts[ri - n];
      ins.cells[c] = v;
      ins.touched.add(c);
    } else {
      let o = this.overrides.get(ri);
      if (this.rows[ri][c] === v) {
        if (o) {
          o.delete(c);
          if (o.size === 0) this.overrides.delete(ri);
        }
      } else {
        if (!o) this.overrides.set(ri, (o = new Map()));
        o.set(c, v);
      }
    }
    this.fullRefill = true;
    if (this.sortCol === c || this.filter) this.rebuildOrder();
    this.updateBar();
    this.schedule();
  }

  private addRow(): void {
    if (!this.editable()) return;
    this.commitEdit();
    this.inserts.push({ cells: this.cols.map(() => null), touched: new Set() });
    this.rebuildOrder();
    const r = this.order.length - 1;
    const c = Math.max(0, (this.ctx as EditContext).colMap.findIndex((x) => x !== null));
    this.anchor = this.head = { r, c };
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.scrollTo(this.head);
    this.schedule();
    this.focus();
  }

  private deleteSelected(): void {
    const sel = this.selRect();
    if (!sel || !this.editable()) return;
    this.commitEdit();
    const n = this.n();
    const ris: number[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) ris.push(this.order[r]);
    const existing = ris.filter((x) => x < n);
    const newIdx = ris.filter((x) => x >= n).map((x) => x - n).sort((a, b) => b - a);
    for (const k of newIdx) this.inserts.splice(k, 1);
    if (existing.length) {
      const allDeleted = existing.every((x) => this.deleted.has(x));
      for (const x of existing) {
        if (allDeleted) this.deleted.delete(x);
        else {
          this.deleted.add(x);
          this.overrides.delete(x);
        }
      }
    }
    this.rebuildOrder();
  }

  private nullSelected(): void {
    const sel = this.selRect();
    if (!sel || !this.editable()) return;
    this.commitEdit();
    for (let r = sel.r0; r <= sel.r1; r++) {
      const ri = this.order[r];
      for (let c = sel.c0; c <= sel.c1; c++) if (this.cellEditable(ri, c)) this.setCell(ri, c, null);
    }
  }

  private revert(): void {
    this.cancelEdit();
    this.overrides.clear();
    this.inserts = [];
    this.deleted.clear();
    this.rebuildOrder();
  }

  buildEdits(): RowEdit[] {
    const ctx = this.ctx;
    if (!ctx) return [];
    const edits: RowEdit[] = [];
    const n = this.n();
    const keyOf = (ri: number): { key: Record<string, Cell>; types: Record<string, string> } => {
      const key: Record<string, Cell> = {};
      const types: Record<string, string> = {};
      ctx.pk.forEach((k, j) => {
        key[k] = this.rows[ri][ctx.pkIdx[j]];
        types[k] = ctx.types[k] ?? "";
      });
      return { key, types };
    };
    for (const [ri, o] of this.overrides) {
      if (this.deleted.has(ri) || ri >= n) continue;
      const { key, types } = keyOf(ri);
      const changes: Record<string, Cell> = {};
      for (const [c, v] of o) {
        const name = ctx.colMap[c];
        if (name === null) continue;
        changes[name] = v;
        types[name] = ctx.types[name] ?? "";
      }
      if (Object.keys(changes).length) edits.push({ kind: "update", schema: ctx.schema, table: ctx.table, key, changes, columnTypes: types });
    }
    for (const ins of this.inserts) {
      const changes: Record<string, Cell> = {};
      const types: Record<string, string> = {};
      for (const c of ins.touched) {
        const name = ctx.colMap[c];
        if (name === null) continue;
        changes[name] = ins.cells[c];
        types[name] = ctx.types[name] ?? "";
      }
      edits.push({ kind: "insert", schema: ctx.schema, table: ctx.table, key: {}, changes, columnTypes: types });
    }
    for (const ri of this.deleted) {
      const { key, types } = keyOf(ri);
      edits.push({ kind: "delete", schema: ctx.schema, table: ctx.table, key, changes: {}, columnTypes: types });
    }
    return edits;
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.hasPending()) return;
    this.commitEdit();
    const edits = this.buildEdits();
    if (edits.length === 0) return;
    this.submitting = true;
    this.updateBar();
    try {
      await this.cb.onSubmit(edits);
    } finally {
      this.submitting = false;
      this.updateBar();
    }
  }

  // ---------------------------------------------------------------- toolbar state

  private updateBar(): void {
    const total = this.rows.length + this.inserts.length;
    const shown = this.order.length;
    this.countEl.textContent = this.opts.countLabel
      ? this.opts.countLabel(shown, total, this.truncated)
      : shown === total
        ? `${total.toLocaleString()} row${total === 1 ? "" : "s"}`
        : `${shown.toLocaleString()} of ${total.toLocaleString()} rows`;
    const editable = this.editable();
    const pending = this.pendingCount();
    this.btnAdd.hidden = !editable;
    this.roChip.hidden = editable || this.opts.hideReadOnlyChip === true;
    this.roChip.title = this.reason || "This result can't be edited";
    this.btnLoadMore.hidden = !this.truncated;
    this.btnLoadMore.title = this.opts.loadMoreTitle ?? `Showing the first ${this.maxRows.toLocaleString()} rows — load ${(this.maxRows * 2).toLocaleString()}`;
    this.pendGroup.hidden = !editable || pending === 0;
    this.pill.classList.toggle("has-pending", editable && pending > 0);
    this.btnSubmit.disabled = pending === 0 || this.submitting;
    this.btnRevert.disabled = pending === 0 || this.submitting;
    this.btnDelete.disabled = !this.selRect();
    this.btnNull.disabled = !this.selRect();
    this.pendingEl.textContent = pending ? `${pending} pending` : "";
    if (this.filter) this.filterWrap.classList.add("open");
  }
}

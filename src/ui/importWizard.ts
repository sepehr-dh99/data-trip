// Import data (v0.16, board V): a 5-step wizard — File → Format (detected, editable, live preview) → Target
// (map to an existing table with type checks and one-click fixes, or create a new table with inferred types) →
// Options (truncate, conflicts, batches, transactions, SQL preview) → Import (progress, counts, failed rows).
// Parsing / inserting happens in the backend (import_preview / import_run, src-tauri/src/import.rs).
import "../styles/data.css";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type { ImportFailure, ImportFormat, ImportPreview, ImportProgress, ImportRequest, SessionInfo, TableNode } from "../types";
import { clear, copyText, debounce, errMsg, h, icon } from "./dom";
import { store } from "./state";
import { toast } from "./toast";
import { showMenu } from "./menu";
import { confirmDialog } from "./confirm";
import { humanSize } from "./format";
import { isProdConnection } from "./ai";
import type { Dialect } from "./designerSql";
import { TYPE_LISTS, columnNameFor, createTableForImport, qname, typeForKind } from "./designerSql";
import type { DbTarget } from "./dataTools";
import { consoleDb, dataHost, findTable } from "./dataTools";

const STEPS = ["File", "Format", "Target", "Options", "Import"];
const FILTERS = [
  { name: "Data files", extensions: ["csv", "tsv", "txt", "tab", "json", "ndjson", "jsonl"] },
  { name: "All files", extensions: ["*"] },
];

interface NewCol {
  include: boolean;
  name: string;
  type: string;
}

const AUTO: ImportFormat = { kind: null, delimiter: null, quote: null, header: null, encoding: null, nullText: "", dateFormat: "", flatten: null };

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const fmtN = (n: number): string => n.toLocaleString();

function seg<T extends string>(label: string, opts: [T, string][], cur: T, pick: (v: T) => void): HTMLElement {
  return h(
    "div",
    { class: "seg iw-seg", role: "radiogroup", "aria-label": label },
    opts.map(([v, l]) => h("button", { class: "seg-btn" + (v === cur ? " on" : ""), type: "button", role: "radio", "aria-checked": String(v === cur), onclick: () => pick(v) }, l)),
  );
}

function check(on: boolean, label: string, onclick: () => void): HTMLButtonElement {
  return h("button", { class: "dd-chk" + (on ? " on" : ""), type: "button", role: "checkbox", "aria-checked": String(on), onclick }, h("span", { class: "dd-box", "aria-hidden": "true" }), label);
}

function field(label: string, ...kids: (HTMLElement | null)[]): HTMLElement {
  return h("div", { class: "iw-field" }, h("span", { class: "iw-label" }, label), ...kids);
}

/** Opens the wizard for a table (existing target) or a schema (new or chosen table). */
export function openImportWizard(target: DbTarget): void {
  if (document.querySelector(".import-wizard")) return;
  new ImportWizard(target);
}

class ImportWizard {
  private overlay = h("div", { class: "overlay" });
  private stepsEl = h("div", { class: "iw-steps" });
  private body = h("div", { class: "iw-body" });
  private footInfo = h("span", { class: "iw-foot-info" });
  private btnBack: HTMLButtonElement;
  private btnNext: HTMLButtonElement;
  private step = 1;
  private d: Dialect;
  private connName: string;
  private path: string | null = null;
  private fmt: ImportFormat = { ...AUTO };
  private preview: ImportPreview | null = null;
  private previewErr: string | null = null;
  private previewSeq = 0;
  private mode: "existing" | "new";
  private table: string | null;
  private newName = "";
  private map: string[] = [];
  private newCols: NewCol[] = [];
  private mapForTable: string | null = null;
  private truncate = false;
  private conflict: "fail" | "skip" | "update" = "fail";
  private batch = 1000;
  private tx: "batch" | "single" = "batch";
  private stopAfter = 100;
  // run
  private runId: string | null = null;
  private progress: ImportProgress | null = null;
  private failures: ImportFailure[] = [];
  private seen = new Set<number>();
  private running = false;
  private finishedMsg: string | null = null;
  private background = false;
  private runErr: string | null = null;
  private recheck = debounce(() => void this.loadPreview(), 250);

  constructor(private target: DbTarget) {
    const e = store.conns.get(target.connId);
    const drv = e?.config.driver ?? "postgres";
    this.d = drv === "mysql" ? "mysql" : drv === "mssql" ? "mssql" : drv === "sqlite" ? "sqlite" : "postgres";
    this.connName = e?.config.name ?? "";
    this.mode = target.kind === "table" && target.name ? "existing" : "new";
    this.table = target.kind === "table" && target.name ? target.name : (this.tables()[0]?.name ?? null);
    this.btnBack = h("button", { class: "btn", type: "button", onclick: () => this.go(this.step - 1) }, "Back");
    this.btnNext = h("button", { class: "btn primary", type: "button", onclick: () => void this.next() }, "Next");
    const where = [this.connName, target.database, this.d === "mysql" || this.d === "sqlite" ? null : target.schema].filter(Boolean).join(" · ");
    const dlg = h(
      "div",
      { class: "dialog import-wizard", role: "dialog", "aria-modal": "true", "aria-label": "Import data" },
      h(
        "div",
        { class: "dialog-head" },
        h("div", { class: "dialog-title" }, icon("download", 18), "Import data", h("span", { class: "iw-where" }, `into ${where}`)),
        h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: () => this.close() }, icon("x", 16)),
      ),
      this.stepsEl,
      this.body,
      h("div", { class: "dialog-foot" }, this.footInfo, h("div", { class: "spacer" }), this.btnBack, this.btnNext),
    );
    this.overlay.appendChild(dlg);
    document.body.appendChild(this.overlay);
    window.addEventListener("keydown", this.onKey, true);
    this.render();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !document.querySelector(".ctx-menu")) {
      e.stopPropagation();
      this.close();
    }
  };

  private close(): void {
    if (this.running) {
      this.background = true;
      toast("The import keeps running — you'll get a message when it's done", "info");
    }
    window.removeEventListener("keydown", this.onKey, true);
    this.overlay.classList.add("leaving");
    window.setTimeout(() => this.overlay.remove(), 160);
  }

  // ------------------------------------------------------------------ data

  private tables(): TableNode[] {
    const e = store.conns.get(this.target.connId);
    if (!e) return [];
    const schemas = store.schemasFor(this.target.connId, consoleDb(this.target.connId, this.target.database));
    const s = schemas.find((x) => x.name === this.target.schema) ?? (schemas.length === 1 ? schemas[0] : undefined);
    return (s?.tables ?? []).filter((t) => t.kind === "table");
  }

  private targetTable(): TableNode | null {
    return this.table ? findTable(this.target.connId, this.target.database, this.target.schema, this.table) : null;
  }

  private fileName(): string {
    const p = this.path ?? "";
    return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
  }

  /** Target types per source column (for the backend checks). */
  private checkTypes(): (string | null)[] | null {
    const pv = this.preview;
    if (!pv || this.step < 3) return null;
    if (this.mode === "new") return this.newCols.map((c) => (c.include ? c.type : null));
    const t = this.targetTable();
    return pv.columns.map((_, i) => {
      const name = this.map[i];
      return name ? (t?.columns.find((c) => c.name === name)?.dataType ?? null) : null;
    });
  }

  private async loadPreview(): Promise<void> {
    if (!this.path) return;
    const my = ++this.previewSeq;
    try {
      const pv = await api.importPreview(this.path, this.fmt, this.checkTypes());
      if (my !== this.previewSeq) return;
      const colsChanged = !this.preview || this.preview.columns.join("\u0000") !== pv.columns.join("\u0000");
      this.preview = pv;
      this.previewErr = null;
      if (colsChanged) {
        this.autoMap();
        this.inferNew();
      }
    } catch (e) {
      if (my !== this.previewSeq) return;
      this.preview = null;
      this.previewErr = errMsg(e);
    }
    this.render();
  }

  private autoMap(): void {
    const pv = this.preview;
    const t = this.targetTable();
    this.mapForTable = this.table;
    if (!pv || !t) {
      this.map = pv ? pv.columns.map(() => "") : [];
      return;
    }
    const used = new Set<string>();
    const out = pv.columns.map((src) => {
      const exact = t.columns.find((c) => norm(c.name) === norm(src) && !used.has(c.name));
      if (exact) {
        used.add(exact.name);
        return exact.name;
      }
      return "";
    });
    pv.columns.forEach((src, i) => {
      if (out[i]) return;
      const ns = norm(src);
      const cands = t.columns.filter((c) => !used.has(c.name) && norm(c.name).length >= 3 && ns.length >= 3 && (ns.includes(norm(c.name)) || norm(c.name).includes(ns)));
      if (cands.length === 1) {
        out[i] = cands[0].name;
        used.add(cands[0].name);
      }
    });
    this.map = out;
  }

  private inferNew(): void {
    const pv = this.preview;
    if (!pv) return;
    const used = new Set<string>();
    this.newCols = pv.columns.map((src, i) => {
      let name = columnNameFor(src);
      let k = 2;
      while (used.has(name)) name = `${columnNameFor(src)}_${k++}`;
      used.add(name);
      const inf = pv.inferred[i];
      return { include: true, name, type: inf ? typeForKind(this.d, inf.kind, inf.maxLen, inf.precision, inf.scale) : TYPE_LISTS[this.d][0].type };
    });
    if (!this.newName) this.newName = columnNameFor(this.fileName().replace(/\.[^.]+$/, "")) || "imported";
  }

  private mappedCount(): number {
    return this.mode === "new" ? this.newCols.filter((c) => c.include && c.name.trim()).length : this.map.filter(Boolean).length;
  }

  private keyColumns(): string[] {
    if (this.mode === "new") return [];
    return this.targetTable()?.primaryKey ?? [];
  }

  private targetName(): string {
    return this.mode === "new" ? this.newName.trim() : (this.table ?? "");
  }

  // ------------------------------------------------------------------ navigation

  private canGo(step: number): boolean {
    if (this.running || this.progress) return false;
    if (step <= 1) return true;
    if (!this.path || !this.preview) return false;
    if (step >= 4) return this.mappedCount() > 0 && !!this.targetName();
    return true;
  }

  private go(step: number): void {
    if (step < 1 || step > 4 || !this.canGo(step)) return;
    const was = this.step;
    this.step = step;
    if (step === 3 && this.mode === "existing" && this.mapForTable !== this.table) this.autoMap();
    if (step === 3 && was !== 3) void this.loadPreview();
    else this.render();
  }

  private async next(): Promise<void> {
    if (this.step === 5) {
      if (this.running) this.close();
      else this.close();
      return;
    }
    if (this.step === 1 && !this.path) return void this.chooseFile();
    if (this.step === 4) return void this.run();
    this.go(this.step + 1);
  }

  private async chooseFile(): Promise<void> {
    let p: string | null = null;
    try {
      const r = await open({ multiple: false, directory: false, title: "Import data from…", filters: FILTERS });
      p = typeof r === "string" ? r : null;
    } catch (e) {
      toast(`Couldn't open the file dialog: ${errMsg(e)}`, "error");
      return;
    }
    if (!p) return;
    this.path = p;
    this.fmt = { ...AUTO };
    this.preview = null;
    this.newName = "";
    await this.loadPreview();
    if (this.preview) this.go(2);
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    // Re-rendering after a re-check must not steal the caret from the field being typed in.
    const act = document.activeElement;
    const focusKey = act instanceof HTMLInputElement && this.body.contains(act) ? act.dataset.focus : undefined;
    const selStart = act instanceof HTMLInputElement ? act.selectionStart : null;
    this.renderInner();
    if (focusKey) {
      const el = this.body.querySelector<HTMLInputElement>(`input[data-focus="${focusKey}"]`);
      if (el) {
        el.focus();
        try {
          if (selStart !== null) el.setSelectionRange(selStart, selStart);
        } catch {
          /* number inputs have no selection */
        }
      }
    }
  }

  private renderInner(): void {
    clear(this.stepsEl);
    STEPS.forEach((s, i) => {
      const k = i + 1;
      const cur = this.step === k;
      const done = this.step > k;
      if (i) this.stepsEl.appendChild(h("span", { class: "iw-stepline", "aria-hidden": "true" }));
      this.stepsEl.appendChild(
        h(
          "button",
          { class: "iw-step" + (cur ? " cur" : done ? " done" : ""), type: "button", disabled: k === 5 || !this.canGo(k), onclick: () => this.go(k) },
          h("span", { class: "iw-dot" }, done ? "✓" : String(k)),
          s,
        ),
      );
    });
    clear(this.body);
    if (this.step === 1) this.renderFile();
    else if (this.step === 2) this.renderFormat();
    else if (this.step === 3) this.renderTarget();
    else if (this.step === 4) this.renderOptions();
    else this.renderRun();
    const tn = this.targetName();
    const tq = tn ? qname(this.d, this.d === "mysql" || this.d === "sqlite" ? null : this.target.schema, tn) : "";
    this.footInfo.textContent = this.path ? `${this.fileName()}${this.step >= 3 && tq ? " → " + tq : ""}` : `${this.connName}${this.target.database ? " · " + this.target.database : ""}`;
    this.btnBack.hidden = this.step <= 1 || this.step >= 5;
    const rows = this.preview ? (this.preview.totalRows ?? this.preview.estimatedRows) : 0;
    this.btnNext.textContent = this.step === 1 ? (this.path ? "Next" : "Choose file…") : this.step === 4 ? `Import ${this.preview?.totalRows === null ? "~" : ""}${fmtN(rows)} rows` : this.step === 5 ? (this.running ? "Run in background" : "Done") : "Next";
    this.btnNext.disabled = this.step === 2 ? !this.preview : this.step === 3 ? !this.canGo(4) : this.step === 4 ? !this.canGo(4) : false;
  }

  private renderFile(): void {
    const drop = h(
      "div",
      { class: "iw-drop" },
      h("span", { class: "iw-drop-ico" }, "⇣"),
      h("div", { class: "iw-drop-title" }, "Choose a CSV, TSV or JSON file"),
      h("button", { class: "btn sm", type: "button", onclick: () => void this.chooseFile() }, "Choose file…"),
      h("div", { class: "iw-hint" }, ".csv .tsv .txt .json .ndjson · any size, streamed in batches"),
    );
    this.body.appendChild(drop);
    if (this.path) {
      const pv = this.preview;
      const kind = pv?.format.kind === "csv" ? (pv.format.delimiter === "\t" ? "TSV" : "CSV") : pv?.format.kind === "ndjson" ? "NDJSON" : pv ? "JSON" : "";
      this.body.append(
        h("div", { class: "iw-label" }, "Selected file"),
        h(
          "div",
          { class: "iw-file" },
          h("span", { class: "iw-badge" }, kind || "?"),
          h("span", { class: "iw-file-main" }, h("b", null, this.fileName()), h("span", { class: "mono" }, this.path)),
          h("span", { class: "iw-file-meta" }, pv ? `${humanSize(pv.fileSize) ?? ""} · ${kind} · ${pv.totalRows !== null ? "" : "~"}${fmtN(pv.totalRows ?? pv.estimatedRows)} rows` : ""),
        ),
      );
    }
    if (this.previewErr) this.body.appendChild(h("div", { class: "iw-err" }, icon("alert", 14), this.previewErr));
  }

  private renderFormat(): void {
    const pv = this.preview;
    const f = pv?.format ?? this.fmt;
    const set = (patch: Partial<ImportFormat>): void => {
      this.fmt = { ...(this.preview?.format ?? this.fmt), ...patch };
      void this.loadPreview();
    };
    const opts = h("div", { class: "iw-opts" }, h("div", { class: "iw-ok" }, "✓ Detected automatically — change anything"));
    const isCsv = f.kind === "csv";
    opts.appendChild(field("File type", seg("File type", [["csv", "CSV / TSV"], ["ndjson", "NDJSON"], ["json", "JSON array"]], (f.kind ?? "csv") as "csv" | "ndjson" | "json", (v) => set({ kind: v, delimiter: null, header: null }))));
    if (isCsv) {
      const delim = f.delimiter === "\t" ? "tab" : (f.delimiter ?? ",");
      opts.appendChild(field("Delimiter", seg("Delimiter", [[",", ","], [";", ";"], ["tab", "Tab"], ["|", "|"]], delim as string, (v) => set({ delimiter: v === "tab" ? "\t" : v }))));
      const q = f.quote === "" ? "none" : (f.quote ?? '"');
      opts.appendChild(field("Quote character", seg("Quote", [['"', '"'], ["'", "'"], ["none", "none"]], q as string, (v) => set({ quote: v === "none" ? "" : v }))));
      opts.appendChild(check(f.header !== false, "First row is the header", () => set({ header: !(f.header !== false) })));
    } else {
      opts.appendChild(check(f.flatten !== false, "Flatten nested objects (customer.id)", () => set({ flatten: !(f.flatten !== false) })));
    }
    const enc = f.encoding === "utf16le" || f.encoding === "utf16be" ? "utf16" : (f.encoding ?? "utf8");
    opts.appendChild(field("Encoding", seg("Encoding", [["utf8", "UTF-8"], ["utf16", "UTF-16"], ["latin1", "Latin-1"]], enc as string, (v) => set({ encoding: v === "utf16" ? (f.encoding === "utf16be" ? "utf16be" : "utf16le") : (v as "utf8" | "latin1") }))));
    const nullIn = h("input", { class: "input mono iw-in", type: "text", spellcheck: false, placeholder: "empty field", "aria-label": "Treat as NULL", "data-focus": "null", value: f.nullText, oninput: () => {
      this.fmt = { ...(this.preview?.format ?? this.fmt), nullText: nullIn.value };
      this.recheck();
    } });
    const dateIn = h("input", { class: "input mono iw-in", type: "text", spellcheck: false, placeholder: "auto (YYYY-MM-DD)", "aria-label": "Date format", "data-focus": "date", title: "y year · M month · d day · H hour · m minute · s second, e.g. dd/MM/yyyy HH:mm", value: f.dateFormat, oninput: () => {
      this.fmt = { ...(this.preview?.format ?? this.fmt), dateFormat: dateIn.value };
      this.recheck();
    } });
    opts.append(field("Treat as NULL", nullIn), field("Date format", dateIn));
    const right = h("div", { class: "iw-prev" });
    if (!pv) {
      right.appendChild(this.previewErr ? h("div", { class: "iw-err" }, icon("alert", 14), this.previewErr) : h("div", { class: "iw-hint" }, "Reading…"));
    } else {
      right.appendChild(h("div", { class: "iw-hint" }, `Preview · first ${pv.rows.length} of ${pv.totalRows !== null ? "" : "~"}${fmtN(pv.totalRows ?? pv.estimatedRows)} rows · ${pv.columns.length} column${pv.columns.length === 1 ? "" : "s"}`));
      right.appendChild(this.previewTable(pv));
      if (pv.encodingNote) right.appendChild(h("div", { class: "iw-note" }, pv.encodingNote));
      for (const w of pv.warnings) right.appendChild(h("div", { class: "iw-warn" }, w));
    }
    this.body.appendChild(h("div", { class: "iw-format" }, opts, right));
  }

  private previewTable(pv: ImportPreview): HTMLElement {
    const t = h("table", { class: "iw-table mono" });
    t.appendChild(h("thead", null, h("tr", null, pv.columns.map((c) => h("th", { title: c }, c)))));
    const tb = h("tbody");
    for (const r of pv.rows) {
      tb.appendChild(
        h(
          "tr",
          null,
          pv.columns.map((_, i) => {
            const v = r[i] ?? null;
            return h("td", { class: v === null ? "null" : /^-?\d+(\.\d+)?$/.test(v) ? "num" : "", title: v ?? "NULL" }, v === null ? "NULL" : v.length > 80 ? v.slice(0, 80) + "…" : v);
          }),
        ),
      );
    }
    t.appendChild(tb);
    return h("div", { class: "iw-tablewrap" }, t);
  }

  private renderTarget(): void {
    const pv = this.preview;
    if (!pv) return;
    const tables = this.tables();
    const schemaPrefix = this.d === "mysql" || this.d === "sqlite" ? "" : `${this.target.schema ?? ""}.`;
    const card = (mode: "existing" | "new", label: string, sub: HTMLElement | string): HTMLElement =>
      h(
        "button",
        { class: "iw-card" + (this.mode === mode ? " on" : ""), type: "button", disabled: mode === "existing" && !tables.length, onclick: () => {
          if (this.mode === mode) return;
          this.mode = mode;
          if (mode === "existing" && this.mapForTable !== this.table) this.autoMap();
          void this.loadPreview();
        } },
        h("span", { class: "iw-radio", "aria-hidden": "true" }),
        h("span", { class: "iw-card-main" }, h("b", null, label), typeof sub === "string" ? h("span", { class: "mono" }, sub) : sub),
      );
    const tableSel = h(
      "select",
      { class: "input iw-in", "aria-label": "Target table", onclick: (e: Event) => e.stopPropagation(), onchange: () => {
        this.table = tableSel.value;
        this.autoMap();
        void this.loadPreview();
      } },
      tables.map((t) => h("option", { value: t.name }, t.name)),
    );
    if (this.table) tableSel.value = this.table;
    const nameIn = h("input", { class: "input mono iw-in", type: "text", spellcheck: false, "aria-label": "New table name", "data-focus": "newname", value: this.newName, onclick: (e: Event) => e.stopPropagation(), oninput: () => {
      this.newName = nameIn.value.trim();
      this.updateNext();
    } });
    this.body.appendChild(
      h(
        "div",
        { class: "iw-cards" },
        card("existing", "Existing table", tables.length ? h("span", { class: "iw-inline" }, h("span", { class: "mono" }, schemaPrefix), tableSel) : "no tables in this schema"),
        card("new", "Create a new table", h("span", { class: "iw-inline" }, h("span", { class: "mono" }, schemaPrefix), nameIn, h("span", { class: "iw-hint" }, "types inferred"))),
      ),
    );
    const isNew = this.mode === "new";
    const t = this.targetTable();
    const grid = h("div", { class: "iw-map" });
    grid.appendChild(h("div", { class: "iw-maprow head" }, h("span", null, "Source column"), h("span", null, "Sample"), h("span", null, isNew ? "New column" : "Target column"), h("span", null, "Type"), h("span", null, "Check")));
    let warnings = 0;
    pv.columns.forEach((src, i) => {
      const sample = pv.rows
        .slice(0, 3)
        .map((r) => r[i] ?? "NULL")
        .join(" · ");
      const chk = pv.checks[i] ?? null;
      let tgtCell: HTMLElement;
      let typeCell: HTMLElement;
      let mapped: boolean;
      if (isNew) {
        const c = this.newCols[i];
        mapped = !!c?.include;
        const inc = h("button", { class: "dd-chk solo" + (c.include ? " on" : ""), type: "button", role: "checkbox", "aria-checked": String(c.include), title: c.include ? "Imported (click to skip)" : "Skipped", onclick: () => {
          c.include = !c.include;
          void this.loadPreview();
        } }, h("span", { class: "dd-box" }));
        const nm = h("input", { class: "input mono iw-in", type: "text", spellcheck: false, "aria-label": "New column name", "data-focus": `name:${i}`, value: c.name, disabled: !c.include, oninput: () => {
          c.name = nm.value.trim();
          this.updateNext();
        } });
        tgtCell = h("span", { class: "iw-inline" }, inc, nm);
        const ty = h("input", { class: "input mono iw-in iw-type", type: "text", spellcheck: false, "aria-label": "Column type", "data-focus": `type:${i}`, value: c.type, disabled: !c.include, oninput: () => {
          c.type = ty.value;
          this.recheck();
        } });
        const tbtn = h("button", { class: "ds-typebtn", type: "button", "aria-label": "Choose a type", disabled: !c.include, onclick: (ev: MouseEvent) => {
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          showMenu(r.left - 150, r.bottom + 4, TYPE_LISTS[this.d].map((x) => ({ label: x.type, hint: x.hint, checked: x.type === c.type, onClick: () => {
            c.type = x.type;
            void this.loadPreview();
          } })), { minWidth: 230 });
        } }, "▾");
        typeCell = h("span", { class: "ds-typewrap" }, ty, tbtn);
      } else {
        const name = this.map[i] ?? "";
        mapped = !!name;
        const btn = h("button", { class: "iw-pick mono" + (name ? "" : " skip"), type: "button", onclick: (ev: MouseEvent) => {
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          const items = (t?.columns ?? []).map((c) => ({ label: c.name, hint: c.dataType, checked: c.name === name, disabled: this.map.some((m, j) => m === c.name && j !== i), onClick: () => {
            this.map[i] = c.name;
            void this.loadPreview();
          } }));
          showMenu(r.left, r.bottom + 4, [...items, { sep: true }, { label: "— skip column", checked: !name, onClick: () => {
            this.map[i] = "";
            void this.loadPreview();
          } }], { minWidth: Math.max(220, r.width) });
        } }, h("span", { class: "iw-arrow" }, "→"), h("span", { class: "iw-pick-name" }, name || "skip"), h("span", { class: "iw-caret" }, "▾"));
        tgtCell = btn;
        typeCell = h("span", { class: "mono iw-typename" }, name ? (t?.columns.find((c) => c.name === name)?.dataType ?? "") : "—");
      }
      let chkCell: HTMLElement;
      if (!mapped) chkCell = h("span", { class: "iw-chk skip" }, "skipped — not imported");
      else if (chk) {
        warnings++;
        const fix = chk.fix;
        chkCell = h(
          "span",
          { class: "iw-chk warn", title: `${chk.bad} of ${pv.sampleRows} sample values don't fit (first at line ${chk.line})` },
          h("span", { class: "iw-chk-msg" }, `⚠ ${chk.message}`),
          fix
            ? h("button", { class: "btn xs", type: "button", onclick: () => {
                this.fmt = { ...(this.preview?.format ?? this.fmt), ...(fix.kind === "dateFormat" ? { dateFormat: fix.value } : { nullText: fix.value }) };
                void this.loadPreview();
              } }, fix.label)
            : null,
        );
      } else chkCell = h("span", { class: "iw-chk ok" }, !isNew && this.map[i] && norm(this.map[i]) !== norm(src) ? "✓ matched by name" : "✓ ok");
      grid.appendChild(h("div", { class: "iw-maprow" + (mapped ? "" : " off") }, h("span", { class: "mono iw-src", title: src }, src), h("span", { class: "mono iw-sample", title: sample }, sample), tgtCell, typeCell, chkCell));
    });
    this.body.appendChild(grid);
    let summary: string;
    if (isNew) summary = `Creates ${schemaPrefix}${this.newName || "…"} with ${this.mappedCount()} columns, then imports into it. Click a type to change it.`;
    else {
      const used = new Set(this.map.filter(Boolean));
      const unfilled = (t?.columns ?? []).filter((c) => !used.has(c.name)).map((c) => c.name);
      summary = `${this.mappedCount()} of ${pv.columns.length} source columns mapped${unfilled.length ? ` · not filled: ${unfilled.slice(0, 8).join(", ")}${unfilled.length > 8 ? "…" : ""} (column default or NULL)` : ""}`;
    }
    if (warnings) summary += ` · ${warnings} warning${warnings === 1 ? "" : "s"} (rows that don't fit are reported as failed)`;
    this.body.appendChild(h("div", { class: "iw-hint iw-summary" }, summary));
  }

  private updateNext(): void {
    this.btnNext.disabled = !this.canGo(4);
    const tn = this.targetName();
    if (this.path) this.footInfo.textContent = `${this.fileName()}${tn ? " → " + tn : ""}`;
  }

  private request(): ImportRequest | null {
    const pv = this.preview;
    if (!pv) return null;
    const schema = this.d === "sqlite" ? (this.target.schema ?? "main") : this.target.schema;
    const mapping: ImportRequest["mapping"] = [];
    let createSql: string[] = [];
    if (this.mode === "new") {
      this.newCols.forEach((c, i) => {
        if (c.include && c.name.trim()) mapping.push({ source: i, column: c.name.trim(), typeName: c.type.trim() });
      });
      createSql = [createTableForImport(this.d, this.d === "sqlite" && schema === "main" ? null : schema, this.newName.trim(), mapping.map((m) => ({ name: m.column, type: m.typeName })))];
    } else {
      const t = this.targetTable();
      this.map.forEach((name, i) => {
        if (name) mapping.push({ source: i, column: name, typeName: t?.columns.find((c) => c.name === name)?.dataType ?? "" });
      });
    }
    const keys = this.keyColumns();
    const conflict = keys.length && keys.every((k) => mapping.some((m) => m.column === k)) ? this.conflict : "fail";
    return {
      format: pv.format,
      sourceColumns: pv.columns,
      target: { schema: this.d === "sqlite" && schema === "main" ? null : schema, table: this.targetName(), createSql },
      mapping,
      keyColumns: keys,
      options: { truncate: this.mode === "existing" && this.truncate, onConflict: conflict, batchSize: this.batch, transaction: this.tx, stopAfter: this.stopAfter },
    };
  }

  private planSql(req: ImportRequest): string {
    const d = this.d;
    const T = qname(d, req.target.schema, req.target.table);
    const cols = req.mapping.map((m) => qname(d, null, m.column)).join(", ");
    const rows = this.preview ? (this.preview.totalRows ?? this.preview.estimatedRows) : 0;
    const batches = Math.max(1, Math.ceil(rows / Math.max(1, this.batch)));
    const ph = d === "postgres" ? "$1, $2, …" : d === "mssql" ? "@P1, @P2, …" : "?, ?, …";
    const lines: string[] = [];
    for (const c of req.target.createSql) lines.push(c);
    if (req.options.truncate) lines.push(d === "sqlite" ? `DELETE FROM ${T};` : `TRUNCATE TABLE ${T};`);
    const keys = req.keyColumns.map((k) => qname(d, null, k)).join(", ");
    const head = req.options.onConflict === "skip" && d === "mysql" ? "INSERT IGNORE INTO" : d === "mssql" && req.options.onConflict === "update" ? "MERGE INTO" : "INSERT INTO";
    let s = `${head} ${T} (${cols})\nVALUES (${ph}), …   -- ~${fmtN(rows)} rows in ${fmtN(batches)} batch${batches === 1 ? "" : "es"}`;
    if (req.options.onConflict === "skip") s += d === "postgres" || d === "sqlite" ? `\nON CONFLICT DO NOTHING` : d === "mssql" ? `\n-- rows whose key (${keys}) exists are skipped (WHERE NOT EXISTS)` : "";
    if (req.options.onConflict === "update") s += d === "postgres" || d === "sqlite" ? `\nON CONFLICT (${keys}) DO UPDATE SET …` : d === "mysql" ? "\nON DUPLICATE KEY UPDATE …" : `\n-- MERGE … ON (${keys}) WHEN MATCHED THEN UPDATE … WHEN NOT MATCHED THEN INSERT …`;
    lines.push(s + ";");
    if (req.options.transaction === "single") {
      lines.unshift("BEGIN;");
      lines.push("COMMIT;   -- or ROLLBACK if any row fails");
    }
    return lines.join("\n");
  }

  private renderOptions(): void {
    const req = this.request();
    if (!req) return;
    const keys = this.keyColumns();
    const keysMapped = keys.length > 0 && keys.every((k) => req.mapping.some((m) => m.column === k));
    const box = h("div", { class: "iw-options" });
    const tn = this.targetName();
    if (this.mode === "existing") {
      box.appendChild(
        h(
          "div",
          { class: "iw-optrow top" },
          check(this.truncate, "", () => {
            this.truncate = !this.truncate;
            this.render();
          }),
          h(
            "div",
            { class: "iw-optcol" },
            h("span", null, "Empty ", h("b", { class: "mono" }, tn), " before importing (", this.d === "sqlite" ? "DELETE" : "TRUNCATE", ")"),
            this.truncate ? h("span", { class: "iw-danger" }, `Deletes all rows currently in ${tn}.${this.d === "mysql" ? " MySQL commits TRUNCATE at once — it can't be undone." : this.tx === "single" ? " Undone if the import is rolled back." : " Cannot be undone after it runs."}`) : null,
          ),
        ),
      );
    }
    const conflictLabel = keys.length ? `If the key (${keys.join(", ")}) already exists` : "If a row conflicts";
    const cseg = keysMapped
      ? seg("On conflict", [["fail", "Fail the row"], ["skip", "Skip"], ["update", "Update"]], this.conflict, (v) => {
          this.conflict = v;
          this.render();
        })
      : h("span", { class: "iw-hint" }, keys.length ? "Map the key column(s) to skip or update existing rows." : this.mode === "new" ? "A new table has no rows yet." : "The table has no primary key: conflicting rows fail.");
    const note = !keysMapped ? "" : this.conflict === "update" ? (this.d === "mysql" ? "ON DUPLICATE KEY UPDATE" : this.d === "mssql" ? "MERGE" : `ON CONFLICT (${keys.join(", ")}) DO UPDATE`) : this.conflict === "skip" ? (this.d === "mysql" ? "INSERT IGNORE (also ignores other row errors)" : this.d === "mssql" ? "WHERE NOT EXISTS" : "ON CONFLICT DO NOTHING") : "reported in failed rows";
    box.appendChild(h("div", { class: "iw-optrow" }, h("span", { class: "iw-optlabel" }, conflictLabel), cseg, h("span", { class: "iw-hint" }, note)));
    const rows = this.preview ? (this.preview.totalRows ?? this.preview.estimatedRows) : 0;
    const bIn = h("input", { class: "input mono iw-in iw-num", type: "number", min: "1", max: "100000", "aria-label": "Batch size", value: String(this.batch), oninput: () => {
      this.batch = Math.max(1, Math.min(100000, Number(bIn.value) || 1000));
      bNote.textContent = `${fmtN(Math.max(1, Math.ceil(rows / this.batch)))} batches`;
    }, onchange: () => this.render() });
    const bNote = h("span", { class: "iw-hint" }, `${fmtN(Math.max(1, Math.ceil(rows / this.batch)))} batches · statements stay under the server's parameter limit`);
    box.appendChild(h("div", { class: "iw-optrow" }, h("span", { class: "iw-optlabel" }, "Batch size"), bIn, bNote));
    box.appendChild(
      h(
        "div",
        { class: "iw-optrow" },
        h("span", { class: "iw-optlabel" }, "Transactions"),
        seg("Transactions", [["batch", "Commit each batch"], ["single", "One transaction (all or nothing)"]], this.tx, (v) => {
          this.tx = v;
          this.render();
        }),
      ),
    );
    const sIn = h("input", { class: "input mono iw-in iw-num", type: "number", min: "0", "aria-label": "Stop after failed rows", value: String(this.stopAfter), oninput: () => {
      this.stopAfter = Math.max(0, Number(sIn.value) || 0);
    } });
    box.appendChild(h("div", { class: "iw-optrow" }, h("span", { class: "iw-optlabel" }, "Stop after"), sIn, h("span", { class: "iw-hint" }, "failed rows (0 = never stop; failures are listed, not imported)")));
    box.appendChild(h("pre", { class: "iw-plan mono" }, this.planSql(req)));
    const e = store.conns.get(this.target.connId);
    if (e?.config.readOnly) box.appendChild(h("div", { class: "iw-danger" }, `${this.connName} is read-only — importing is not allowed.`));
    else if (e && isProdConnection(e.config)) box.appendChild(h("div", { class: "iw-prod" }, h("span", { class: "iw-proddot" }), `${this.connName} is a production data source — you’ll confirm before anything is written.`));
    this.body.appendChild(box);
    if (e?.config.readOnly) this.btnNext.disabled = true;
  }

  // ------------------------------------------------------------------ run

  private async run(): Promise<void> {
    const req = this.request();
    if (!req || !this.path || this.running) return;
    const e = store.conns.get(this.target.connId);
    if (!e) return;
    if (isProdConnection(e.config) || req.options.truncate) {
      const ok = await confirmDialog(
        `Import into ${req.target.table}?`,
        `${isProdConnection(e.config) ? `${e.config.name} is a production data source. ` : ""}${req.options.truncate ? `All rows currently in ${req.target.table} are deleted first. ` : ""}About ${fmtN(this.preview?.totalRows ?? this.preview?.estimatedRows ?? 0)} rows will be written.`,
        "Import",
        true,
      );
      if (!ok) return;
    }
    this.step = 5;
    this.running = true;
    this.progress = null;
    this.failures = [];
    this.seen.clear();
    this.finishedMsg = null;
    this.runErr = null;
    this.runId = "imp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    this.render();
    let unlisten: (() => void) | null = null;
    let sess: SessionInfo | null = null;
    const started = performance.now();
    try {
      unlisten = await listen<ImportProgress>("import-progress", (ev) => {
        if (ev.payload.runId === this.runId) this.onProgress(ev.payload);
      });
      if (!(await dataHost().ensureConnected(this.target.connId))) throw new Error(`Couldn't connect to ${this.connName}`);
      // A dedicated session: the consoles' transactions and running statements aren't involved.
      sess = await api.openSession(this.target.connId, consoleDb(this.target.connId, this.target.database));
      const final = await api.importRun(sess.sessionId, this.path, req, this.runId);
      this.onProgress(final);
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      this.finishedMsg = final.cancelled ? "Import stopped" : final.rolledBack ? "Import rolled back" : final.stopped ? "Import stopped early" : `✓ Import finished in ${secs} s`;
    } catch (err) {
      this.runErr = errMsg(err);
      this.finishedMsg = "Import failed";
    } finally {
      unlisten?.();
      if (sess) void api.closeSession(sess.sessionId).catch(() => undefined);
      this.running = false;
      const last = this.lastProgress();
      if (req.target.createSql.length || last?.inserted) void store.refreshDb(this.target.connId, this.target.database ?? e.defaultDb ?? "").catch(() => undefined);
      if (this.background) {
        const p = last;
        toast(this.runErr ? `Import into ${req.target.table} failed: ${this.runErr}` : `${this.finishedMsg}: ${fmtN(p?.inserted ?? 0)} inserted, ${fmtN(p?.skipped ?? 0)} skipped, ${fmtN(p?.failed ?? 0)} failed`, this.runErr || p?.failed ? "error" : "ok", 8000);
      } else this.render();
    }
  }

  /** (A method, so TypeScript doesn't narrow the field after it was reset.) */
  private lastProgress(): ImportProgress | null {
    return this.progress;
  }

  private onProgress(p: ImportProgress): void {
    for (const f of p.failures) {
      if (this.seen.has(f.n)) continue;
      this.seen.add(f.n);
      this.failures.push(f);
    }
    if (!this.progress || p.elapsedMs >= this.progress.elapsedMs || p.finished) this.progress = p;
    if (!this.background && this.step === 5) this.renderRunLive();
  }

  private runEls: { title: HTMLElement; bar: HTMLElement; counts: HTMLElement; list: HTMLElement; extra: HTMLElement } | null = null;

  private renderRun(): void {
    const title = h("span", { class: "iw-run-title" });
    const bar = h("div", { class: "iw-bar" }, h("div", { class: "iw-bar-fill" }));
    const counts = h("div", { class: "iw-counts" });
    const list = h("div", { class: "iw-fails mono" });
    const extra = h("div", { class: "iw-extra" });
    const stop = this.running ? h("button", { class: "btn sm danger-text", type: "button", onclick: () => this.runId && void api.importCancel(this.runId) }, "Stop") : null;
    this.body.append(h("div", { class: "iw-run-head" }, title, h("div", { class: "spacer" }), stop), bar, counts, h("div", { class: "iw-label" }, "Failed rows"), list, extra);
    this.runEls = { title, bar, counts, list, extra };
    this.renderRunLive();
  }

  private renderRunLive(): void {
    const els = this.runEls;
    if (!els || !els.title.isConnected) return;
    const p = this.progress;
    const tn = this.targetName();
    els.title.textContent = this.running ? `Importing ${this.fileName()} → ${tn}` : (this.finishedMsg ?? "");
    const pct = p && p.bytesTotal > 0 ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100) : 0;
    const fill = els.bar.firstElementChild as HTMLElement;
    fill.style.width = (this.running ? pct : 100) + "%";
    fill.classList.toggle("done", !this.running && !this.runErr && !p?.rolledBack && !p?.cancelled);
    fill.classList.toggle("bad", !this.running && (!!this.runErr || !!p?.rolledBack));
    clear(els.counts);
    if (p) {
      const secs = p.elapsedMs / 1000;
      const rate = secs > 0.3 ? Math.round(p.rowsRead / secs) : 0;
      const left = rate > 0 && pct > 0 && pct < 100 ? Math.max(0, Math.round((secs * (100 - pct)) / pct)) : null;
      const est = this.preview ? (this.preview.totalRows ?? this.preview.estimatedRows) : 0;
      els.counts.append(
        h("span", null, `${fmtN(p.rowsRead)} / ${this.preview?.totalRows === null ? "~" : ""}${fmtN(Math.max(est, p.rowsRead))} rows`),
        h("span", { class: "ok" }, `✓ ${fmtN(p.inserted)} inserted${this.conflict === "update" ? " or updated" : ""}`),
        h("span", { class: "warn" }, `↷ ${fmtN(p.skipped)} skipped (key exists)`),
        h("span", { class: "bad" }, `✕ ${fmtN(p.failed)} failed`),
        h("span", { class: "dim" }, this.running ? (rate ? `${fmtN(rate)} rows/s${left !== null ? ` · about ${left} s left` : ""}` : "") : p.rolledBack ? "rolled back" : this.tx === "single" ? "committed once" : "batches committed"),
      );
    } else els.counts.append(h("span", { class: "dim" }, "Connecting…"));
    clear(els.list);
    els.list.appendChild(h("div", { class: "iw-failrow head" }, h("span", null, "Line"), h("span", null, "Column"), h("span", null, "Value"), h("span", null, "Error")));
    for (const f of this.failures.slice(0, 200)) {
      els.list.appendChild(h("div", { class: "iw-failrow" }, h("span", { class: "warn" }, fmtN(f.line)), h("span", null, f.column ?? "—"), h("span", { class: "bad", title: f.value ?? "" }, f.value === null ? "—" : `'${f.value.slice(0, 40)}'`), h("span", { class: "msg", title: f.message }, f.message)));
    }
    if (this.failures.length > 200) els.list.appendChild(h("div", { class: "iw-hint" }, `…and ${fmtN(this.failures.length - 200)} more (Save failed rows to see them all)`));
    if (!this.failures.length) els.list.appendChild(h("div", { class: "iw-hint" }, this.running ? "None so far." : "None."));
    clear(els.extra);
    if (this.runErr) els.extra.appendChild(h("div", { class: "iw-err" }, icon("alert", 14), this.runErr));
    if (p?.stopped) els.extra.appendChild(h("div", { class: "iw-warn" }, p.stopped));
    if (p?.note) els.extra.appendChild(h("div", { class: "iw-note" }, p.note));
    if (!this.running) {
      const btns = h("div", { class: "iw-done-btns" });
      if (this.failures.length) {
        btns.append(
          h("button", { class: "btn sm", type: "button", onclick: () => void this.saveFailures() }, "Save failed rows as CSV…"),
          h("button", { class: "btn sm", type: "button", onclick: () => void copyText(this.failures.map((f) => `line ${f.line}${f.column ? " · " + f.column : ""}${f.value !== null ? ` · '${f.value}'` : ""}: ${f.message}`).join("\n")).then(() => toast("Errors copied", "ok")) }, "Copy errors"),
        );
      }
      if (!this.runErr || this.progress?.inserted) {
        btns.appendChild(
          h("button", { class: "btn sm", type: "button", onclick: () => {
            const T = qname(this.d, this.d === "sqlite" ? null : this.target.schema, tn);
            dataHost().openConsole(this.target.connId, { sql: `SELECT * FROM ${T}`, database: consoleDb(this.target.connId, this.target.database), schema: this.target.schema, title: tn });
            this.close();
          } }, `Open ${tn}`),
        );
      }
      els.extra.appendChild(btns);
    }
    this.btnNext.textContent = this.running ? "Run in background" : "Done";
  }

  private async saveFailures(): Promise<void> {
    const req = this.request();
    const path = await save({ title: "Save failed rows", defaultPath: this.fileName().replace(/\.[^.]+$/, "") + "_failed.csv", filters: [{ name: "CSV", extensions: ["csv"] }] }).catch(() => null);
    if (!path || !req) return;
    const q = (s: string | null): string => (s === null ? "" : /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const head = ["line", ...req.mapping.map((m) => req.sourceColumns[m.source]), "error"];
    const lines = [head.map(q).join(",")];
    for (const f of this.failures) lines.push([String(f.line), ...req.mapping.map((_, i) => f.row[i] ?? null), f.message].map((x) => q(x)).join(","));
    try {
      await api.writeTextFile(path, lines.join("\n") + "\n");
      toast(`Saved ${fmtN(this.failures.length)} failed rows`, "ok");
    } catch (e) {
      toast(`Couldn't save: ${errMsg(e)}`, "error");
    }
  }
}

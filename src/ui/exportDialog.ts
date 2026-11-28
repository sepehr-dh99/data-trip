// Export dialog: format + options on the left, live preview on the right, Copy / Save in the footer.
import { preferences, save } from "../platform";
import { api } from "../api";
import type { Cell, Driver, ExportOptions, ExportTextFormat } from "../types";
import { clear, copyText, errMsg, h, icon } from "./dom";
import { FORMAT_EXT, FORMAT_LABEL, formatRows } from "./exportFormat";
import { toast } from "./toast";

const PREVIEW_ROWS = 50;
const ALL_ROWS_CAP = 200_000;
/** Above this many rows the size summary is estimated from the preview instead of formatting everything. */
const SIZE_EXACT_MAX = 4000;
const FORMATS: ExportTextFormat[] = ["csv", "tsv", "json", "sql", "markdown"];

export interface ExportSelection {
  columns: string[];
  rows: Cell[][];
}

export interface ExportDialogParams {
  driver: Driver;
  columns: string[];
  /** Rows currently loaded in the grid, in display order. */
  rows: Cell[][];
  selection: ExportSelection | null;
  /** Qualified + dialect-quoted table of the result, when detected. */
  tableName: string | null;
  /** The statement to re-run for "All rows"; null when it cannot be re-run. */
  sql: string | null;
  /** Tooltip for the disabled "All rows" scope. */
  allDisabledReason: string;
  getSessionId(): Promise<string>;
  /** Start on the selection scope (opened from the cell context menu). */
  preferSelection?: boolean;
}

// ------------------------------------------------------------------ remembered options

export interface ExportPrefs {
  includeHeader: boolean;
  delim: "," | ";" | "\t" | "|" | "custom";
  delimCustom: string;
  quote: string;
  nullKey: "empty" | "NULL" | "\\N" | "custom";
  nullCustom: string;
  crlf: boolean;
}

const DEFAULT_PREFS: ExportPrefs = { includeHeader: true, delim: ",", delimCustom: "", quote: '"', nullKey: "empty", nullCustom: "", crlf: false };
const KEY_FORMAT = "dt.export.format";
const keyFor = (f: ExportTextFormat): string => "dt.export.opts." + f;

export function lastExportFormat(): ExportTextFormat {
  const f = preferences.getItem(KEY_FORMAT) as ExportTextFormat | null;
  return f && FORMATS.includes(f) ? f : "csv";
}

export function loadPrefs(f: ExportTextFormat): ExportPrefs {
  try {
    const raw = preferences.getItem(keyFor(f));
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ExportPrefs>) };
  } catch {
    /* corrupt entry: fall back to defaults */
  }
  return { ...DEFAULT_PREFS };
}

function savePrefs(f: ExportTextFormat, p: ExportPrefs): void {
  preferences.setItem(keyFor(f), JSON.stringify(p));
}

export function prefsToOptions(format: ExportTextFormat, p: ExportPrefs, tableName: string | null): ExportOptions {
  const o: ExportOptions = { format, includeHeader: p.includeHeader, lineEnding: p.crlf ? "\r\n" : "\n" };
  if (format === "csv") {
    o.delimiter = p.delim === "custom" ? p.delimCustom || "," : p.delim;
    o.quote = p.quote;
  }
  if (format === "csv" || format === "tsv" || format === "markdown") o.nullText = p.nullKey === "empty" ? "" : p.nullKey === "custom" ? p.nullCustom : p.nullKey;
  if (format === "sql") o.tableName = tableName && tableName.trim() ? tableName.trim() : "my_table";
  return o;
}

/** Options remembered for a format (used by "Copy as" in the grid menu). */
export function rememberedOptions(format: ExportTextFormat, tableName: string | null): ExportOptions {
  return prefsToOptions(format, loadPrefs(format), tableName);
}

// ------------------------------------------------------------------ helpers

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString()} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;
type Scope = "loaded" | "all" | "selection";

function switchEl(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const b = h("button", { class: "sw", type: "button", role: "switch", "aria-label": label, onclick: () => { set(!get()); sync(); } });
  const sync = (): void => {
    b.classList.toggle("on", get());
    b.setAttribute("aria-checked", String(get()));
  };
  sync();
  const wrap = h("div", { class: "export-switch" }, h("span", { class: "field-label" }, label), b);
  (wrap as HTMLElement & { _sync?: () => void })._sync = sync;
  return wrap;
}

// ------------------------------------------------------------------ dialog

export function openExportDialog(p: ExportDialogParams): void {
  let format = lastExportFormat();
  let prefs = loadPrefs(format);
  const tableDefault = p.tableName && p.tableName.trim() ? p.tableName : "my_table";
  let table = tableDefault;
  const canAll = p.sql !== null;
  const sel = p.selection;
  let scope: Scope = p.preferSelection && sel ? "selection" : "loaded";
  let busy = false;

  const overlay = h("div", { class: "overlay" });
  const options = (): ExportOptions => prefsToOptions(format, prefs, format === "sql" ? table : null);

  // --- format segmented
  const segBtns = FORMATS.map((f) => h("button", { class: "seg-btn", type: "button", role: "radio", onclick: () => setFormat(f) }, FORMAT_LABEL[f]));
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Format" }, segBtns);

  // --- option controls
  const header = switchEl("Include column headers", () => prefs.includeHeader, (v) => { prefs.includeHeader = v; changed(); });

  const selDelim = h("select", { class: "input", "aria-label": "Delimiter", onchange: () => { prefs.delim = selDelim.value as ExportPrefs["delim"]; changed(); } },
    h("option", { value: "," }, "Comma ( , )"), h("option", { value: ";" }, "Semicolon ( ; )"), h("option", { value: "\t" }, "Tab"), h("option", { value: "|" }, "Pipe ( | )"), h("option", { value: "custom" }, "Custom…"));
  const inDelim = h("input", { class: "input", type: "text", maxlength: "4", placeholder: "Delimiter", spellcheck: false, "aria-label": "Custom delimiter", oninput: () => { prefs.delimCustom = inDelim.value; changed(); } });
  const delimField = h("div", { class: "field" }, h("span", { class: "field-label" }, "Delimiter"), selDelim, inDelim);

  const selQuote = h("select", { class: "input", "aria-label": "Quote character", onchange: () => { prefs.quote = selQuote.value; changed(); } },
    h("option", { value: '"' }, 'Double quote ( " )'), h("option", { value: "'" }, "Single quote ( ' )"), h("option", { value: "" }, "None"));
  const quoteField = h("label", { class: "field" }, h("span", { class: "field-label" }, "Quote"), selQuote);

  const selNull = h("select", { class: "input", "aria-label": "NULL as", onchange: () => { prefs.nullKey = selNull.value as ExportPrefs["nullKey"]; changed(); } },
    h("option", { value: "empty" }, "Empty"), h("option", { value: "NULL" }, "NULL"), h("option", { value: "\\N" }, "\\N"), h("option", { value: "custom" }, "Custom…"));
  const inNull = h("input", { class: "input", type: "text", placeholder: "NULL text", spellcheck: false, "aria-label": "Custom NULL text", oninput: () => { prefs.nullCustom = inNull.value; changed(); } });
  const nullField = h("div", { class: "field" }, h("span", { class: "field-label" }, "NULL as"), selNull, inNull);

  const leBtns = [false, true].map((crlf) => h("button", { class: "seg-btn", type: "button", role: "radio", onclick: () => { prefs.crlf = crlf; changed(); } }, crlf ? "CRLF" : "LF"));
  const leField = h("div", { class: "field" }, h("span", { class: "field-label" }, "Line ending"), h("div", { class: "seg", role: "radiogroup", "aria-label": "Line ending" }, leBtns));

  const inTable = h("input", { class: "input mono", type: "text", spellcheck: false, "aria-label": "Table name", value: table, oninput: () => { table = inTable.value; changed(false); } });
  const tableField = h("label", { class: "field" }, h("span", { class: "field-label" }, "Table name"), inTable);

  // --- scope
  const scopes: { id: Scope; label: string; off?: string }[] = [
    { id: "loaded", label: `Loaded rows (${p.rows.length.toLocaleString()})` },
    { id: "all", label: "All rows", off: canAll ? undefined : p.allDisabledReason },
  ];
  if (sel) scopes.push({ id: "selection", label: `Selection (${sel.rows.length.toLocaleString()}×${sel.columns.length.toLocaleString()})` });
  const scopeBtns = scopes.map((s) =>
    h("button", { class: "seg-btn", type: "button", role: "radio", disabled: !!s.off, title: s.off ?? (s.id === "all" ? "Re-runs the query and exports every row" : ""), onclick: () => { scope = s.id; changed(false); } }, s.label),
  );
  const scopeField = h("div", { class: "field" }, h("span", { class: "field-label" }, "Scope"), h("div", { class: "seg export-scope", role: "radiogroup", "aria-label": "Scope" }, scopeBtns));

  // --- preview
  const pre = h("pre", { class: "export-pre", tabindex: "0", "aria-label": "Export preview" });
  const sumEl = h("span", { class: "export-sum" });
  const noteEl = h("div", { class: "export-note" });
  const preview = h("div", { class: "export-prev" }, h("div", { class: "export-prev-head" }, h("span", { class: "field-label" }, "Preview"), sumEl), pre, noteEl);

  const btnCopy = h("button", { class: "btn ghost", type: "button", onclick: () => void doCopy() }, icon("copy", 15), "Copy to clipboard");
  const btnSave = h("button", { class: "btn primary", type: "button", onclick: () => void doSave() }, icon("download", 15), "Save to file…");
  const btnCancel = h("button", { class: "btn ghost", type: "button", onclick: () => close() }, "Cancel");

  const dlg = h(
    "div",
    { class: "dialog export-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Export results" },
    h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon("download", 18), "Export results"), h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: () => close() }, icon("x", 16))),
    h("div", { class: "export-top" }, seg),
    h("div", { class: "dialog-body export-body" }, h("div", { class: "export-opts" }, header, delimField, quoteField, nullField, leField, tableField, scopeField), preview),
    h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), btnCancel, btnCopy, btnSave),
  );
  overlay.appendChild(dlg);

  // --- logic
  function scopeData(): { columns: string[]; rows: Cell[][] } {
    if (scope === "selection" && sel) return sel;
    return { columns: p.columns, rows: p.rows };
  }

  function changed(persist = true): void {
    if (persist) savePrefs(format, prefs);
    refresh();
  }

  function setFormat(f: ExportTextFormat): void {
    format = f;
    prefs = loadPrefs(f);
    preferences.setItem(KEY_FORMAT, f);
    refresh();
  }

  function refresh(): void {
    segBtns.forEach((b, i) => {
      const on = FORMATS[i] === format;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
    (header as HTMLElement & { _sync?: () => void })._sync?.();
    selDelim.value = prefs.delim;
    inDelim.value = prefs.delimCustom;
    inDelim.hidden = prefs.delim !== "custom";
    selQuote.value = prefs.quote;
    selNull.value = prefs.nullKey;
    inNull.value = prefs.nullCustom;
    inNull.hidden = prefs.nullKey !== "custom";
    leBtns.forEach((b, i) => {
      const on = (i === 1) === prefs.crlf;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
    const csv = format === "csv";
    delimField.hidden = !csv;
    quoteField.hidden = !csv;
    nullField.hidden = !(csv || format === "tsv" || format === "markdown");
    tableField.hidden = format !== "sql";
    scopes.forEach((s, i) => {
      const on = s.id === scope;
      scopeBtns[i].classList.toggle("on", on);
      scopeBtns[i].setAttribute("aria-checked", String(on));
    });

    const d = scopeData();
    const total = scope === "all" ? p.rows.length : d.rows.length;
    const shown = d.rows.slice(0, PREVIEW_ROWS);
    const text = formatRows(d.columns, shown, options(), p.driver);
    pre.textContent = text;
    if (scope === "all") {
      sumEl.textContent = "All rows · re-runs the query";
      noteEl.textContent = `Preview of the first ${Math.min(PREVIEW_ROWS, p.rows.length)} loaded rows`;
    } else {
      let bytes: number;
      let approx = "";
      if (d.rows.length <= SIZE_EXACT_MAX) bytes = byteLen(formatRows(d.columns, d.rows, options(), p.driver));
      else {
        bytes = Math.round((byteLen(text) / Math.max(1, shown.length)) * d.rows.length);
        approx = "~";
      }
      sumEl.textContent = `${total.toLocaleString()} row${total === 1 ? "" : "s"} · ${approx}${sizeText(bytes)}`;
      noteEl.textContent = d.rows.length > PREVIEW_ROWS ? `Showing the first ${PREVIEW_ROWS} of ${d.rows.length.toLocaleString()} rows` : "";
    }
    btnCopy.disabled = busy;
    btnSave.disabled = busy;
  }

  function setBusy(b: boolean): void {
    busy = b;
    btnCopy.disabled = b;
    btnSave.disabled = b;
    dlg.classList.toggle("busy", b);
  }

  async function fetchAll(): Promise<{ columns: string[]; rows: Cell[][] }> {
    const sid = await p.getSessionId();
    const res = await api.execute(sid, p.sql as string, ALL_ROWS_CAP);
    if (res.truncated) toast(`Result capped at ${ALL_ROWS_CAP.toLocaleString()} rows. Use Save to file… to stream everything.`, "info", 6000);
    return { columns: res.columns.map((c) => c.name), rows: res.rows };
  }

  async function doCopy(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const d = scope === "all" ? await fetchAll() : scopeData();
      await copyText(formatRows(d.columns, d.rows, options(), p.driver));
      toast(`Copied ${d.rows.length.toLocaleString()} row${d.rows.length === 1 ? "" : "s"} as ${FORMAT_LABEL[format]}`, "ok");
      close();
    } catch (e) {
      toast(`Copy failed: ${errMsg(e)}`, "error");
      setBusy(false);
    }
  }

  async function doSave(): Promise<void> {
    if (busy) return;
    const ext = FORMAT_EXT[format];
    setBusy(true);
    try {
      const path = await save({ title: "Export result", defaultPath: "result." + ext, filters: [{ name: FORMAT_LABEL[format], extensions: [ext] }], purpose: "output" });
      if (!path) {
        setBusy(false);
        return;
      }
      let n: number;
      if (scope === "all") {
        n = await api.exportQueryWith(await p.getSessionId(), p.sql as string, options(), path);
      } else {
        const d = scopeData();
        await api.writeTextFile(path, formatRows(d.columns, d.rows, options(), p.driver));
        n = d.rows.length;
      }
      toast(`Exported ${n.toLocaleString()} row${n === 1 ? "" : "s"} to ${path}`, "ok");
      close();
    } catch (e) {
      toast(`Export failed: ${errMsg(e)}`, "error");
      setBusy(false);
    }
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  function close(): void {
    window.removeEventListener("keydown", onKey, true);
    overlay.classList.add("leaving");
    window.setTimeout(() => overlay.remove(), 160);
  }
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  clear(pre);
  document.body.appendChild(overlay);
  window.addEventListener("keydown", onKey, true);
  refresh();
  btnSave.focus();
}

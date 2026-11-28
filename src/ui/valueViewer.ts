// Cell value viewer (v0.16, board T): a panel docked right of the result grid that follows the selected cell.
// Text | JSON (formatted, colored, foldable) | Hex (default for binary), Wrap, size + line count, Copy; on
// editable results ✎ Edit with live JSON validation and "Save to grid" (a pending cell edit, submitted like
// any other). Formatting logic: valueFormat.ts.
import { preferences } from "../platform";
import "../styles/data.css";
import type { Cell } from "../types";
import { clear, copyText, h, icon } from "./dom";
import { TextEditor } from "./editor";
import type { JNode, ValueMode } from "./valueFormat";
import { HEX_CAP, VIEW_CAP, byteLength, cellText, defaultMode, hexRows, hexToBytes, isBinaryType, isHexBlob, isJsonType, jsonLines, jsonToStore, lineCount, parseJson, prettyJson, sizeLabel, textBytes, topLevelPaths } from "./valueFormat";

export interface ViewerCell {
  /** Underlying row index and column. */
  ri: number;
  c: number;
  column: string;
  typeName: string;
  value: Cell;
  editable: boolean;
  /** Why it can't be edited (shown as the Edit tooltip). */
  reason: string;
  /** "row 3 · id 90419" */
  rowLabel: string;
}

export interface ViewerHost {
  current(): ViewerCell | null;
  /** Puts the text into the grid as a pending edit of (ri, c). */
  save(ri: number, c: number, text: string): void;
  closed(): void;
  focusGrid(): void;
}

const WRAP_KEY = "dt.viewer.wrap";

export class ValueViewer {
  readonly el: HTMLElement;
  private isOpen = false;
  private cell: ViewerCell | null = null;
  private mode: ValueMode = "text";
  private modeChosenFor: string | null = null;
  private wrap = preferences.getItem(WRAP_KEY) !== "0";
  private folded = new Set<string>();
  private editing = false;
  private editor: TextEditor | null = null;
  private draftValid = true;
  private nameEl = h("span", { class: "vv-name" });
  private metaEl = h("span", { class: "vv-meta mono" });
  private btnCopy: HTMLButtonElement;
  private btnEdit: HTMLButtonElement;
  private seg = h("div", { class: "seg vv-seg", role: "radiogroup", "aria-label": "View as" });
  private wrapBtn: HTMLButtonElement;
  private foldBtn: HTMLButtonElement;
  private sizeEl = h("span", { class: "vv-size" });
  private body = h("div", { class: "vv-body", tabindex: "0", "aria-label": "Value" });
  private foot = h("div", { class: "vv-foot", hidden: true });
  private validEl = h("span", { class: "vv-valid" });
  private btnSave: HTMLButtonElement;
  private lastKey = "";

  constructor(private host: ViewerHost) {
    this.btnCopy = h("button", { class: "btn sm", type: "button", onclick: () => void this.copy() }, "Copy");
    this.btnEdit = h("button", { class: "btn sm", type: "button", onclick: () => this.startEdit() }, "✎ Edit");
    this.wrapBtn = h("button", { class: "vv-wrap", type: "button", role: "switch", onclick: () => {
      this.wrap = !this.wrap;
      preferences.setItem(WRAP_KEY, this.wrap ? "1" : "0");
      this.paint();
    } }, h("span", { class: "sw sm", "aria-hidden": "true" }), "Wrap");
    this.foldBtn = h("button", { class: "btn xs", type: "button", onclick: () => this.foldAll() }, "Fold all");
    this.btnSave = h("button", { class: "btn sm primary", type: "button", onclick: () => this.saveEdit() }, "Save to grid");
    this.foot.append(this.validEl, h("button", { class: "btn sm", type: "button", onclick: () => this.cancelEdit() }, "Cancel"), this.btnSave);
    for (const [m, label] of [["text", "Text"], ["json", "JSON"], ["hex", "Hex"]] as const) {
      this.seg.appendChild(h("button", { class: "seg-btn", type: "button", role: "radio", "data-mode": m, onclick: () => this.setMode(m) }, label));
    }
    this.el = h(
      "aside",
      { class: "value-viewer", "aria-label": "Value viewer", hidden: true },
      h(
        "div",
        { class: "vv-head" },
        this.nameEl,
        this.metaEl,
        h("div", { class: "spacer" }),
        this.btnCopy,
        this.btnEdit,
        h("button", { class: "icon-btn", type: "button", title: "Close value viewer (Esc)", "aria-label": "Close value viewer", onclick: () => this.close() }, icon("x", 14)),
      ),
      h("div", { class: "vv-bar" }, this.seg, this.wrapBtn, this.foldBtn, h("div", { class: "spacer" }), this.sizeEl),
      this.body,
      this.foot,
    );
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (this.editing) this.cancelEdit();
        else {
          this.close();
          this.host.focusGrid();
        }
      } else if (this.editing && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        this.saveEdit();
      }
    });
  }

  get open(): boolean {
    return this.isOpen;
  }

  show(): void {
    this.isOpen = true;
    this.el.hidden = false;
    this.lastKey = "";
    this.update();
  }

  close(): void {
    if (!this.isOpen) return;
    this.cancelEdit();
    this.isOpen = false;
    this.el.hidden = true;
    this.host.closed();
  }

  /** Follows the grid's selected cell (cheap when nothing changed). */
  update(): void {
    if (!this.isOpen) return;
    const cell = this.host.current();
    const key = cell ? `${cell.ri}:${cell.c}:${typeof cell.value}:${cell.value === null ? "∅" : String(cell.value).length}:${String(cell.value).slice(0, 64)}:${cell.editable}` : "";
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (this.editing) {
      // Moving to another cell drops an unsaved draft.
      if (!cell || !this.cell || cell.ri !== this.cell.ri || cell.c !== this.cell.c) this.cancelEdit();
      else return;
    }
    const colKey = cell ? `${cell.c}:${cell.column}` : null;
    if (cell && colKey !== this.modeChosenFor) {
      this.mode = defaultMode(cell.typeName, cell.value);
      this.modeChosenFor = null;
      this.folded.clear();
    }
    this.cell = cell;
    this.paint();
  }

  private setMode(m: ValueMode): void {
    this.mode = m;
    this.modeChosenFor = this.cell ? `${this.cell.c}:${this.cell.column}` : null;
    this.paint();
  }

  private text(): string {
    return cellText(this.cell?.value ?? null);
  }

  private parsed(): JNode | null {
    const t = this.text();
    if (t.length > VIEW_CAP) return null;
    const p = parseJson(t);
    return p.ok ? p.node : null;
  }

  private paint(): void {
    const c = this.cell;
    this.seg.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
      const on = b.dataset.mode === this.mode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
    this.wrapBtn.setAttribute("aria-checked", String(this.wrap));
    this.wrapBtn.querySelector(".sw")?.classList.toggle("on", this.wrap);
    this.body.classList.toggle("wrap", this.wrap);
    this.foot.hidden = !this.editing;
    this.btnCopy.hidden = this.editing;
    this.btnEdit.hidden = this.editing;
    this.seg.classList.toggle("off", this.editing);
    if (this.editing) return;
    clear(this.body);
    if (!c) {
      this.nameEl.textContent = "No cell selected";
      this.metaEl.textContent = "";
      this.sizeEl.textContent = "";
      this.foldBtn.hidden = true;
      this.btnEdit.disabled = true;
      this.btnCopy.disabled = true;
      this.body.appendChild(h("div", { class: "vv-empty" }, "Select a cell in the grid to see its value."));
      return;
    }
    this.nameEl.textContent = c.column;
    this.metaEl.textContent = `${c.typeName} · ${c.rowLabel}`;
    this.btnCopy.disabled = c.value === null;
    const text = this.text();
    const binary = isBinaryType(c.typeName) || isHexBlob(text);
    const cut = binary && text.endsWith("…");
    const editBlock = !c.editable ? c.reason || "This result can't be edited" : binary ? "Binary values can't be edited here" : text.length > VIEW_CAP ? "Values over 2 MB can't be edited here" : "";
    this.btnEdit.disabled = !!editBlock;
    this.btnEdit.title = editBlock || "Edit the value (⌘↵ saves to the grid)";
    if (c.value === null) {
      this.foldBtn.hidden = true;
      this.sizeEl.textContent = "NULL";
      this.body.appendChild(h("div", { class: "vv-empty null" }, "NULL"));
      return;
    }
    let mode = this.mode;
    const node = mode === "json" ? this.parsed() : null;
    if (mode === "json" && !node) mode = "text";
    this.foldBtn.hidden = mode !== "json";
    if (mode === "hex") {
      const bytes = (binary ? hexToBytes(text) : null) ?? textBytes(text);
      this.sizeEl.textContent = `${bytes.length.toLocaleString()} bytes${cut ? "+ (cut)" : ""}`;
      const pre = h("div", { class: "vv-hex mono" });
      for (const r of hexRows(bytes)) pre.appendChild(h("div", { class: "vv-hexrow" }, h("span", { class: "off" }, r.off), h("span", { class: "hx" }, r.hex), h("span", { class: "asc" }, r.ascii)));
      this.body.appendChild(pre);
      const notes: string[] = [];
      if (bytes.length > HEX_CAP) notes.push(`Showing the first ${sizeLabel(HEX_CAP)} of ${sizeLabel(bytes.length)}.`);
      if (cut) notes.push("The value is longer: results carry the first 4 KB of binary columns.");
      if (binary) notes.push("Hex is the default view for bytea / BLOB / varbinary columns.");
      if (notes.length) this.body.appendChild(h("div", { class: "vv-note" }, notes.join(" ")));
      return;
    }
    const bytes = byteLength(text);
    if (mode === "json" && node) {
      const res = jsonLines(node, this.folded);
      this.foldBtn.textContent = this.folded.size ? "Unfold all" : "Fold all";
      const lines = res.lines;
      this.sizeEl.textContent = `${sizeLabel(bytes)} · ${lineCount(prettyJson(node)).toLocaleString()} lines`;
      const box = h("div", { class: "vv-json mono" });
      lines.forEach((l, i) => {
        const row = h("div", { class: "vv-jl" }, h("span", { class: "ln" }, String(i + 1)));
        const fold = h("span", { class: "fd" });
        if (l.path) {
          const path = l.path;
          fold.appendChild(
            h("button", { class: "vv-fold", type: "button", "aria-label": l.folded ? "Unfold" : "Fold", onclick: () => {
              if (this.folded.has(path)) this.folded.delete(path);
              else this.folded.add(path);
              this.paint();
            } }, l.folded ? "▸" : "▾"),
          );
        }
        row.append(fold, h("span", { class: "ind", style: `width:${l.depth * 16}px` }));
        const code = h("span", { class: "code" });
        for (const s of l.segs) code.appendChild(h("span", { class: "j-" + s.c }, s.t));
        row.appendChild(code);
        box.appendChild(row);
      });
      this.body.appendChild(box);
      if (res.truncated) this.body.appendChild(h("div", { class: "vv-note" }, `Showing the first ${lines.length.toLocaleString()} lines — fold nodes or use Copy for the whole value.`));
      return;
    }
    this.sizeEl.textContent = `${sizeLabel(bytes)} · ${lineCount(text).toLocaleString()} line${lineCount(text) === 1 ? "" : "s"}`;
    this.body.appendChild(h("div", { class: "vv-text mono" }, text.length > VIEW_CAP ? text.slice(0, VIEW_CAP) : text));
    if (text.length > VIEW_CAP) this.body.appendChild(h("div", { class: "vv-note" }, `Showing the first 2 MB of ${sizeLabel(bytes)} — Copy copies the whole value.`));
    if (this.mode === "json" && !node) this.body.prepend(h("div", { class: "vv-note warn" }, text.length > VIEW_CAP ? "Too large to format as JSON." : "Not valid JSON — shown as text."));
  }

  private foldAll(): void {
    const node = this.parsed();
    if (!node) return;
    if (this.folded.size) this.folded.clear();
    else for (const p of topLevelPaths(node)) this.folded.add(p);
    this.paint();
  }

  private async copy(): Promise<void> {
    if (!this.cell || this.cell.value === null) return;
    await copyText(this.text());
    this.btnCopy.textContent = "Copied ✓";
    window.setTimeout(() => (this.btnCopy.textContent = "Copy"), 1500);
  }

  // ------------------------------------------------------------------ edit

  private jsonish(): boolean {
    const c = this.cell;
    return !!c && (isJsonType(c.typeName) || this.mode === "json");
  }

  startEdit(): void {
    const c = this.cell;
    if (!c || this.btnEdit.disabled) return;
    const node = this.jsonish() ? this.parsed() : null;
    const start = node ? prettyJson(node) : this.text();
    this.editing = true;
    clear(this.body);
    const host = h("div", { class: "vv-editor" });
    this.body.appendChild(host);
    this.editor = new TextEditor(host, { doc: start, onChange: () => this.validate(), onSubmit: () => this.saveEdit() });
    this.paint();
    this.validate();
    this.editor.focus();
  }

  private validate(): void {
    if (!this.editor) return;
    const draft = this.editor.getText();
    if (this.jsonish()) {
      const p = parseJson(draft);
      this.editor.setJson(p.ok);
      this.draftValid = p.ok;
      this.validEl.className = "vv-valid " + (p.ok ? "ok" : "bad");
      this.validEl.textContent = p.ok ? "✓ Valid JSON" : `✕ ${p.message} · line ${p.line}, column ${p.col}`;
      this.body.classList.toggle("invalid", !p.ok);
    } else {
      this.draftValid = true;
      this.validEl.className = "vv-valid";
      this.validEl.textContent = `${lineCount(draft)} line${lineCount(draft) === 1 ? "" : "s"} · ${sizeLabel(byteLength(draft))}`;
      this.body.classList.remove("invalid");
    }
    this.btnSave.disabled = !this.draftValid;
  }

  private saveEdit(): void {
    const c = this.cell;
    if (!this.editing || !this.editor || !c || !this.draftValid) return;
    const draft = this.editor.getText();
    const value = this.jsonish() ? jsonToStore(draft, this.text()) : draft;
    this.cancelEdit();
    this.host.save(c.ri, c.c, value);
    this.lastKey = "";
    this.update();
  }

  cancelEdit(): void {
    if (!this.editing) return;
    this.editing = false;
    this.editor?.destroy();
    this.editor = null;
    this.body.classList.remove("invalid");
    this.lastKey = "";
    this.paint();
  }
}


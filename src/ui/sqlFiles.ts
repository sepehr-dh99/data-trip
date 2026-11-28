// SQL files (v0.15, board R): a console bound to a .sql file (Save ⌘S / Save as / ● unsaved / changed on disk),
// Open SQL file (⌘O, "Run it against" picker remembered per file, recent files), Export selection, dropping a
// .sql file on the window (opens an unbound copy) and Run SQL file (a bottom panel; the backend streams the file
// from disk, splits and executes it — backend `run_sql_file`).
import { getPlatform, open, save, listen } from "../platform";
import { EditorState, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { api } from "../api";
import type { Driver, SessionInfo, SqlRunFailure, SqlRunOptions, SqlRunProgress } from "../types";
import { DRIVER_LABELS } from "../types";
import { splitStatements } from "../sqlsplit";
import { confirmDialog } from "./confirm";
import { clear, errMsg, h, icon } from "./dom";
import { showMenu } from "./menu";
import type { MenuItem } from "./menu";
import { shortcutLabel } from "./keymap";
import { getSettings, updateSettings } from "./settings";
import type { FileTarget } from "./settings";
import { store } from "./state";
import { connColor } from "./sqlutil";
import { toast } from "./toast";
import { isProdConnection } from "./ai";
import type { ConsolePane } from "./console";
import "../styles/files.css";

/** What the SQL file features need from the shell (App). */
export interface FileHost {
  openConsole(connId: string, opts: { sql?: string; database?: string | null; title?: string }): Promise<ConsolePane | null>;
  consoles(): ConsolePane[];
  activeConsole(): ConsolePane | null;
  activate(c: ConsolePane): void;
  /** The data source the shell considers current (active tab, else the explorer selection). */
  currentConn(): string | null;
  /** Connects the data source when needed (explorer connect, with recovery); true when connected. */
  ensureConnected(connId: string): Promise<boolean>;
}

let host: FileHost | null = null;

const SQL_DRIVERS: ReadonlySet<Driver> = new Set<Driver>(["postgres", "mysql", "sqlite", "mssql"]);
const FILTERS = [
  { name: "SQL files", extensions: ["sql", "txt"] },
  { name: "All files", extensions: ["*"] },
];
const MAX_DROP_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------- small helpers

/** "\r\n" / "\r" → "\n" (CodeMirror's document always uses "\n"). */
const normEol = (t: string): string => t.replace(/\r\n?/g, "\n");

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/** "/Users/me/work/x" → "~/work/x" when the home directory is recognisable. */
function shortDir(dir: string): string {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(.*)$/.exec(dir);
  return m ? "~" + m[2] : dir;
}

export function humanSize(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " bytes";
}

const fmtInt = (n: number): string => n.toLocaleString("en-US");

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A file name for a console title ("console 2" → "console 2.sql", "x.sql" stays). */
function suggestedName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "query";
  return /\.(sql|txt)$/i.test(base) ? base : base + ".sql";
}

function addRecent(path: string): void {
  updateSettings((s) => {
    s.files.recent = [path, ...s.files.recent.filter((p) => p !== path)].slice(0, 10);
  });
}

function forgetRecent(path: string): void {
  updateSettings((s) => {
    s.files.recent = s.files.recent.filter((p) => p !== path);
  });
}

function rememberTarget(path: string, t: FileTarget): void {
  updateSettings((s) => {
    delete s.files.targets[path];
    s.files.targets[path] = { connId: t.connId, database: t.database };
    const keys = Object.keys(s.files.targets);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete s.files.targets[k];
  });
}

function connLabel(connId: string, database: string | null): string {
  const e = store.conns.get(connId);
  if (!e) return "unknown data source";
  const db = database ?? e.defaultDb;
  return db && e.config.driver !== "sqlite" ? `${e.config.name} · ${db}` : e.config.name;
}

function isMissing(msg: string): boolean {
  return /no such file|not found|cannot find|os error 2\b|os error 3\b/i.test(msg);
}

// ---------------------------------------------------------------- "Run it against" picker

interface PickOptions {
  title: string;
  meta: string;
  okLabel: string;
  /** Offer "Remember for this file" (Open of a real file). */
  remember: boolean;
  preferred: FileTarget | null;
  preferredNote?: string;
}

interface Picked extends FileTarget {
  remember: boolean;
}

/** Board R "Open … / Run it against": data source + database, the remembered / current one first. */
export function pickTarget(o: PickOptions): Promise<Picked | null> {
  return new Promise((resolve) => {
    const cands: { connId: string; database: string | null; note: string }[] = [];
    const add = (connId: string, database: string | null, note: string): void => {
      const e = store.conns.get(connId);
      if (!e || !SQL_DRIVERS.has(e.config.driver)) return;
      if (cands.some((c) => c.connId === connId && (c.database ?? "") === (database ?? ""))) return;
      cands.push({ connId, database, note });
    };
    if (o.preferred) add(o.preferred.connId, o.preferred.database, o.preferredNote ?? "last used with this file");
    const cur = host?.activeConsole();
    if (cur) add(cur.connId, cur.database, "current console");
    const sel = host?.currentConn();
    if (sel) add(sel, null, "selected in the explorer");
    const rest = store.list().filter((e) => SQL_DRIVERS.has(e.config.driver));
    rest.sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected"));
    for (const e of rest) add(e.config.id, null, e.status === "connected" ? "connected" : DRIVER_LABELS[e.config.driver].split(" / ")[0]);
    let chosen = 0;
    const overlay = h("div", { class: "overlay" });
    const okBtn = h("button", { class: "btn primary", type: "button" }, o.okLabel);
    const remember = h("input", { type: "checkbox", checked: true });
    const dbSel = h("select", { class: "input", "aria-label": "Database" });
    const dbRow = h("label", { class: "field sf-db" }, h("span", { class: "field-label" }, "Database"), dbSel);
    const list = h("div", { class: "sf-targets", role: "listbox", "aria-label": "Run it against" });
    const done = (v: Picked | null): void => {
      window.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(v);
    };
    const finish = (): void => {
      const c = cands[chosen];
      if (!c) return;
      const db = dbRow.hidden ? c.database : dbSel.value === "" ? null : dbSel.value;
      done({ connId: c.connId, database: db, remember: o.remember && remember.checked });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        finish();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (e.target instanceof HTMLSelectElement) return;
        e.preventDefault();
        chosen = Math.max(0, Math.min(cands.length - 1, chosen + (e.key === "ArrowDown" ? 1 : -1)));
        render();
      }
    };
    const syncDb = (): void => {
      const c = cands[chosen];
      const e = c ? store.conns.get(c.connId) : undefined;
      clear(dbSel);
      const names = e && e.config.driver !== "sqlite" && e.status === "connected" ? e.databases.filter((d) => !d.isSystem).map((d) => d.name) : [];
      dbRow.hidden = names.length < 2;
      if (dbRow.hidden || !e) return;
      dbSel.appendChild(h("option", { value: "" }, `Default${e.defaultDb ? " (" + e.defaultDb + ")" : ""}`));
      for (const n of names) if (n !== e.defaultDb) dbSel.appendChild(h("option", { value: n }, n));
      dbSel.value = c.database && names.includes(c.database) && c.database !== e.defaultDb ? c.database : "";
    };
    const render = (): void => {
      clear(list);
      cands.forEach((c, i) => {
        const e = store.conns.get(c.connId);
        const row = h(
          "button",
          { class: "sf-target" + (i === chosen ? " on" : ""), type: "button", role: "option", "aria-selected": String(i === chosen) },
          h("span", { class: "sf-dot", style: `--c:${e ? connColor(e.config) : "var(--text-3)"}`, "aria-hidden": "true" }),
          h("span", { class: "sf-name" }, connLabel(c.connId, c.database)),
          h("span", { class: "sf-note" }, c.note),
        );
        row.addEventListener("click", () => {
          chosen = i;
          render();
        });
        row.addEventListener("dblclick", () => {
          chosen = i;
          finish();
        });
        list.appendChild(row);
      });
      okBtn.disabled = cands.length === 0;
      syncDb();
    };
    okBtn.addEventListener("click", finish);
    overlay.appendChild(
      h(
        "div",
        { class: "dialog small sf-dialog", role: "dialog", "aria-modal": "true", "aria-label": o.title },
        h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon("terminal", 18), o.title)),
        h(
          "div",
          { class: "dialog-body" },
          h("div", { class: "sf-meta mono" }, o.meta),
          h("div", { class: "sf-label" }, "Run it against"),
          cands.length ? list : h("p", { class: "sf-empty" }, "Add a PostgreSQL, MySQL, SQLite or SQL Server data source first."),
          dbRow,
          o.remember ? h("label", { class: "check sf-remember" }, remember, h("span", null, "Remember for this file")) : null,
        ),
        h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: () => done(null) }, "Cancel"), okBtn),
      ),
    );
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) done(null);
    });
    document.body.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    render();
    okBtn.focus();
  });
}

// ---------------------------------------------------------------- the binding of one console

export interface WsFile {
  path: string;
  mtimeMs: number | null;
  /** Unsaved changes when the workspace was saved. */
  dirty: boolean;
}

export interface FileBindingHooks {
  view(): EditorView;
  /** Title / path changed: re-render the tabs and save the workspace. */
  renamed(name: string): void;
  /** The unsaved-changes state changed. */
  dirtyChanged(): void;
  connId(): string;
  database(): string | null;
  title(): string;
  /** The console this binding belongs to. */
  pane(): ConsolePane;
}

interface DiskVersion {
  text: string;
  mtimeMs: number;
  bom: boolean;
}

/** v0.17: everything a binding knows ("Reopen closed tab" brings it back without reading the file again). */
export interface FileMemo {
  path: string;
  /** Last saved / loaded text (the dirty baseline). */
  saved: string;
  mtimeMs: number | null;
  eol: "\n" | "\r\n";
  bom: boolean;
  dirty: boolean;
  /** A changed-on-disk version the user hadn't decided about yet (banner). */
  pending: DiskVersion | null;
}

export class FileBinding {
  /** Bound file, null = a plain console. */
  path: string | null = null;
  /** Read-only tab (Compare: the version on disk). */
  readOnly = false;
  /** Banner over the editor (changed on disk / deleted / read-only copy). */
  readonly banner: HTMLElement = h("div", { class: "file-banner", role: "status", hidden: true });
  /** File ▾ in the console's capsule controls. */
  readonly button: HTMLButtonElement;
  private saved = "";
  private mtime: number | null = null;
  private eol: "\n" | "\r\n" = "\n";
  private bom = false;
  private isDirty = false;
  private dirtyTimer: number | undefined;
  private checking = false;
  private pending: DiskVersion | null = null;

  constructor(private hooks: FileBindingHooks) {
    this.button = h("button", { class: "cap-btn ghost file-btn", type: "button", title: "File: save, open and run SQL files", "aria-haspopup": "menu", onclick: () => this.openMenu() }, "File", h("span", { class: "file-caret", "aria-hidden": "true" }, "▾"));
  }

  private text(): string {
    return this.hooks.view().state.doc.toString();
  }

  get dirty(): boolean {
    return this.isDirty;
  }

  get name(): string {
    return this.path ? baseName(this.path) : this.hooks.title();
  }

  /** Editor text changed (debounced dirty check: length first, then the text). */
  onEdit(): void {
    if (!this.path) return;
    if (this.dirtyTimer !== undefined) window.clearTimeout(this.dirtyTimer);
    this.dirtyTimer = window.setTimeout(() => {
      this.dirtyTimer = undefined;
      this.recompute();
    }, 120);
  }

  private recompute(): void {
    const doc = this.hooks.view().state.doc;
    const d = this.path !== null && !this.readOnly && (doc.length !== this.saved.length || doc.toString() !== this.saved);
    if (d !== this.isDirty) {
      this.isDirty = d;
      this.hooks.dirtyChanged();
    }
  }

  /** Binds the console to `path` whose current content (`text`, as loaded into the editor) is on disk. */
  bind(path: string, text: string, mtimeMs: number, bom: boolean): void {
    this.path = path;
    this.saved = normEol(text);
    this.eol = /\r\n/.test(text) ? "\r\n" : "\n";
    this.bom = bom;
    this.mtime = mtimeMs;
    this.pending = null;
    this.hideBanner();
    this.recompute();
    this.hooks.renamed(baseName(path));
  }

  /** What restore on launch keeps (null for a plain console). */
  snapshot(): WsFile | null {
    return this.path && !this.readOnly ? { path: this.path, mtimeMs: this.mtime, dirty: this.isDirty } : null;
  }

  /** Restore on launch: the editor already has the saved text; the file is read again for the baseline. */
  restore(f: WsFile): void {
    this.path = f.path;
    this.mtime = f.mtimeMs;
    this.saved = this.text();
    // v0.17: keep the unsaved-changes dot (and the close prompt) until the baseline is known, also when unreadable
    this.isDirty = f.dirty;
    void this.loadBaseline(f.dirty);
  }

  /** v0.17: the binding for "Reopen closed tab" (null for a plain console / a read-only compare tab). */
  memo(): FileMemo | null {
    if (!this.path || this.readOnly) return null;
    return { path: this.path, saved: this.saved, mtimeMs: this.mtime, eol: this.eol, bom: this.bom, dirty: this.isDirty, pending: this.pending };
  }

  /**
   * v0.17: "Reopen closed tab": the console (already holding the closed tab's text) is bound to the same file with the
   * same baseline and mtime, so Save writes there with the external-change check (FILE_CHANGED) and the dot is right.
   */
  adopt(m: FileMemo): void {
    this.path = m.path;
    this.saved = m.saved;
    this.mtime = m.mtimeMs;
    this.eol = m.eol;
    this.bom = m.bom;
    this.pending = m.pending;
    this.isDirty = m.dirty;
    this.hideBanner();
    this.recompute();
    if (this.pending) this.showChanged();
    this.hooks.renamed(baseName(m.path));
    // changed while the tab was closed?
    void this.checkDisk();
  }

  private async loadBaseline(wasDirty: boolean): Promise<void> {
    const path = this.path;
    if (!path) return;
    let d;
    try {
      d = await api.sqlFileRead(path);
    } catch (e) {
      const m = errMsg(e);
      if (isMissing(m)) this.showMissing();
      return;
    }
    if (this.path !== path) return;
    this.eol = /\r\n/.test(d.text) ? "\r\n" : "\n";
    this.bom = d.bom;
    const disk = normEol(d.text);
    if (d.mtimeMs === this.mtime || disk === this.text()) {
      this.saved = disk;
      this.mtime = d.mtimeMs;
      this.recompute();
      return;
    }
    // Changed while DataTrip was closed.
    if (wasDirty) this.saved = disk;
    this.recompute();
    this.pending = { text: disk, mtimeMs: d.mtimeMs, bom: d.bom };
    this.showChanged();
  }

  /** Window focus / tab activation: has the file changed on disk? */
  async checkDisk(): Promise<void> {
    const path = this.path;
    if (!path || this.readOnly || this.checking) return;
    this.checking = true;
    try {
      const st = await api.fileMtime(path);
      if (this.path !== path) return;
      if (!st) {
        this.showMissing();
        return;
      }
      if (this.banner.dataset.kind === "missing") this.hideBanner();
      if (st.mtimeMs === this.mtime || (this.pending && this.pending.mtimeMs === st.mtimeMs)) return;
      const d = await api.sqlFileRead(path);
      if (this.path !== path) return;
      const disk = normEol(d.text);
      if (disk === this.text()) {
        // Touched, or saved elsewhere with the same text: nothing to decide.
        this.saved = disk;
        this.mtime = d.mtimeMs;
        this.bom = d.bom;
        this.pending = null;
        this.hideBanner();
        this.recompute();
        return;
      }
      this.pending = { text: disk, mtimeMs: d.mtimeMs, bom: d.bom };
      this.showChanged();
    } catch {
      // unreadable right now: try again on the next focus
    } finally {
      this.checking = false;
    }
  }

  private hideBanner(): void {
    this.banner.hidden = true;
    delete this.banner.dataset.kind;
    clear(this.banner);
  }

  private bannerBtn(label: string, cls: string, run: () => void): HTMLButtonElement {
    return h("button", { class: "btn sm " + cls, type: "button", onclick: run }, label);
  }

  private showChanged(): void {
    clear(this.banner);
    this.banner.dataset.kind = "changed";
    this.banner.hidden = false;
    this.banner.append(
      h("span", { class: "fb-ico", "aria-hidden": "true" }, "!"),
      h("span", { class: "fb-text" }, h("b", null, this.name), " changed on disk since you opened it."),
      this.bannerBtn("Reload from disk", "fb-main", () => this.reload()),
      this.bannerBtn("Keep mine", "ghost", () => this.keepMine()),
      this.bannerBtn("Compare", "ghost fb-link", () => void this.compare()),
    );
  }

  private showMissing(): void {
    if (this.banner.dataset.kind === "missing") return;
    clear(this.banner);
    this.banner.dataset.kind = "missing";
    this.banner.hidden = false;
    this.banner.append(
      h("span", { class: "fb-ico", "aria-hidden": "true" }, "!"),
      h("span", { class: "fb-text" }, h("b", null, this.name), " was moved or deleted on disk."),
      this.bannerBtn("Save it again", "fb-main", () => void this.writeTo(this.path ?? "", null)),
      this.bannerBtn("Save as…", "ghost", () => void this.saveAs()),
      this.bannerBtn("Dismiss", "ghost", () => this.hideBanner()),
    );
  }

  private reload(): void {
    const p = this.pending;
    if (!p) return this.hideBanner();
    const view = this.hooks.view();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: p.text } });
    this.saved = p.text;
    this.mtime = p.mtimeMs;
    this.bom = p.bom;
    this.pending = null;
    this.hideBanner();
    this.recompute();
  }

  /** Keep the editor's text: the next ⌘S overwrites the disk version without asking. */
  private keepMine(): void {
    const p = this.pending;
    if (p) {
      this.saved = p.text;
      this.mtime = p.mtimeMs;
    }
    this.pending = null;
    this.hideBanner();
    this.recompute();
  }

  /** The disk version in a new read-only tab "file.sql (on disk)". */
  private async compare(): Promise<void> {
    const p = this.pending;
    if (!p || !host) return;
    const pane = await host.openConsole(this.hooks.connId(), { sql: p.text, database: this.hooks.database(), title: `${this.name} (on disk)` });
    pane?.file.makeReadOnly(`The version of ${this.name} on disk (read-only). Use Save as to keep a copy.`);
  }

  /** Compare tabs: the editor refuses edits. */
  makeReadOnly(note: string): void {
    this.readOnly = true;
    this.hooks.view().dispatch({ effects: StateEffect.appendConfig.of([EditorState.readOnly.of(true)]) });
    clear(this.banner);
    this.banner.dataset.kind = "readonly";
    this.banner.hidden = false;
    this.banner.append(h("span", { class: "fb-ico ro", "aria-hidden": "true" }, "i"), h("span", { class: "fb-text" }, note));
  }

  // ------------------------------------------------------------ save

  /** ⌘S: writes back to the bound file (no dialog); a plain console asks where (Save as). */
  async save(): Promise<boolean> {
    if (!this.path || this.readOnly) return this.saveAs();
    return this.writeTo(this.path, this.mtime);
  }

  /** ⇧⌘S: asks for a path and binds the console to it. */
  async saveAs(): Promise<boolean> {
    let p: string | null;
    try {
      p = await save({ title: "Save SQL file", defaultPath: this.path ?? suggestedName(this.hooks.title()), filters: FILTERS, purpose: "sql" });
    } catch (e) {
      toast(`Couldn't open the save dialog: ${errMsg(e)}`, "error");
      return false;
    }
    if (!p) return false;
    if (this.readOnly) {
      // A saved copy of a compare tab becomes a normal, editable file console.
      this.readOnly = false;
      this.hooks.view().dispatch({ effects: StateEffect.appendConfig.of([EditorState.readOnly.of(false)]) });
      this.hideBanner();
    }
    const written = await this.writeTo(p, null);
    if (written) getPlatform().download?.(p);
    return written;
  }

  private async writeTo(path: string, expected: number | null): Promise<boolean> {
    if (!path) return false;
    const text = this.text();
    const out = this.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
    try {
      const r = await api.sqlFileWrite(path, out, expected, this.bom);
      const renamed = path !== this.path;
      this.path = path;
      this.saved = text;
      this.mtime = r.mtimeMs;
      this.pending = null;
      this.hideBanner();
      this.recompute();
      if (renamed) this.hooks.renamed(baseName(path));
      addRecent(path);
      rememberTarget(path, { connId: this.hooks.connId(), database: this.hooks.database() });
      toast(`Saved ${baseName(path)}`, "ok", 1800);
      return true;
    } catch (e) {
      const m = errMsg(e);
      if (m.startsWith("FILE_CHANGED:")) {
        const ok = await confirmDialog(
          "Changed on disk",
          `${baseName(path)} was changed outside DataTrip after you opened it. Overwrite it with your version? (Cancel keeps both: your text stays here and the file is untouched.)`,
          "Overwrite",
          true,
        );
        if (!ok) {
          void this.checkDisk();
          return false;
        }
        return this.writeTo(path, null);
      }
      toast(`Couldn't save ${baseName(path)}: ${m}`, "error");
      return false;
    }
  }

  /** Writes the selection (or the whole console) to a new file, without binding. */
  async exportSelection(): Promise<void> {
    const st = this.hooks.view().state;
    const parts = st.selection.ranges.filter((r) => !r.empty).map((r) => st.sliceDoc(r.from, r.to));
    const sel = parts.join("\n");
    const text = sel || st.doc.toString();
    let p: string | null;
    try {
      p = await save({ title: sel ? "Export selection as .sql" : "Export console as .sql", defaultPath: suggestedName(this.path ? baseName(this.path).replace(/\.(sql|txt)$/i, "") + (sel ? "_selection" : "_copy") : this.hooks.title()), filters: FILTERS, purpose: "sql", localCopy: true });
    } catch (e) {
      toast(`Couldn't open the save dialog: ${errMsg(e)}`, "error");
      return;
    }
    if (!p) return;
    try {
      await api.sqlFileWrite(p, text.endsWith("\n") ? text : text + "\n", null, false);
      getPlatform().download?.(p);
      addRecent(p);
      toast(`Exported to ${baseName(p)}`, "ok");
    } catch (e) {
      toast(`Couldn't export: ${errMsg(e)}`, "error");
    }
  }

  // ------------------------------------------------------------ File ▾

  private hasSelection(): boolean {
    return this.hooks.view().state.selection.ranges.some((r) => !r.empty);
  }

  private openMenu(): void {
    const r = this.button.getBoundingClientRect();
    const pane = this.hooks.pane();
    const items: MenuItem[] = [
      { label: "Save", icon: "download", hint: shortcutLabel("saveFile"), onClick: () => void this.save() },
      { label: "Save as…", hint: shortcutLabel("saveFileAs"), onClick: () => void this.saveAs() },
      { label: this.hasSelection() ? "Export selection as .sql…" : "Export console as .sql…", onClick: () => void this.exportSelection() },
      { sep: true },
      { label: "Open SQL file…", icon: "folder", hint: shortcutLabel("openFile"), onClick: () => void openSqlFile() },
      { label: "Run SQL file on a data source…", icon: "playAll", disabled: pane.isLineBased, onClick: () => void runSqlFileFlow({ console: pane }) },
      ...recentItems(),
    ];
    showMenu(Math.max(8, r.right - 290), r.bottom + 6, items, { minWidth: 290 });
  }
}

function recentItems(): MenuItem[] {
  const rec = getSettings().files.recent;
  if (!rec.length) return [];
  return [
    { sep: true },
    { label: "Recent files", disabled: true },
    ...rec.map((p): MenuItem => ({ label: `${baseName(p)} — ${shortDir(dirName(p))}`, onClick: () => void openSqlFile(p) })),
  ];
}

// ---------------------------------------------------------------- open

/**
 * Open SQL file: native open dialog (or `path` from the recent list), then the "Run it against" picker (skipped for
 * a recent file whose data source is remembered), then a console bound to the file. An already open file is
 * activated instead.
 */
export async function openSqlFile(path?: string): Promise<void> {
  if (!host) return;
  let p = path ?? null;
  if (!p) {
    try {
      const r = await open({ multiple: false, directory: false, title: "Open SQL file", filters: FILTERS, purpose: "sql" });
      p = typeof r === "string" ? r : null;
    } catch (e) {
      toast(`Couldn't open the file dialog: ${errMsg(e)}`, "error");
      return;
    }
  }
  if (!p) return;
  const already = host.consoles().find((c) => c.file.path === p);
  if (already) {
    host.activate(already);
    void already.file.checkDisk();
    return;
  }
  let f;
  try {
    f = await api.sqlFileRead(p);
  } catch (e) {
    const m = errMsg(e);
    if (m.startsWith("FILE_TOO_LARGE:")) {
      const run = await confirmDialog("File too large to edit", m.replace(/^FILE_TOO_LARGE:\s*/, "").replace(/ Use Run SQL file… to execute it without opening it\.$/, "") + " Run it on a data source instead (it is streamed from disk, not loaded)?", "Run SQL file…");
      if (run) await runSqlFileFlow({ path: p });
      return;
    }
    if (isMissing(m)) forgetRecent(p);
    toast(`Couldn't open ${baseName(p)}: ${m}`, "error");
    return;
  }
  const remembered = getSettings().files.targets[p] ?? null;
  const known = remembered && store.conns.has(remembered.connId) ? remembered : null;
  let target: Picked | null;
  if (path && known) target = { ...known, remember: false };
  else {
    const n = f.size <= 2 * 1024 * 1024 ? splitStatements(f.text).length : null;
    target = await pickTarget({
      title: `Open ${baseName(p)}`,
      meta: `${shortDir(dirName(p))}/${baseName(p)} · ${humanSize(f.size)}${n !== null ? ` · ${fmtInt(n)} statement${n === 1 ? "" : "s"}` : ""}`,
      okLabel: "Open in a console",
      remember: true,
      preferred: known,
    });
  }
  if (!target) return;
  if (target.remember) rememberTarget(p, target);
  addRecent(p);
  const text = normEol(f.text);
  const pane = await host.openConsole(target.connId, { sql: text, database: target.database, title: baseName(p) });
  pane?.file.bind(p, f.text, f.mtimeMs, f.bom);
}

/** Dropped .sql / .txt files (DOM drop: the window has no native file drop): unbound copies. */
async function openDropped(files: File[]): Promise<void> {
  if (!host) return;
  for (const file of files) {
    if (file.size > MAX_DROP_BYTES) {
      toast(`${file.name} is ${humanSize(file.size)}: too big to open in a console. Use File › Run SQL file… instead.`, "error");
      continue;
    }
    let text: string;
    try {
      text = normEol(await file.text()).replace(/^﻿/, "");
    } catch (e) {
      toast(`Couldn't read ${file.name}: ${errMsg(e)}`, "error");
      continue;
    }
    const target = await pickTarget({
      title: `Open ${file.name}`,
      meta: `${humanSize(file.size)} · ${fmtInt(splitStatements(text).length)} statements · dropped file`,
      okLabel: "Open in a console",
      remember: false,
      preferred: null,
    });
    if (!target) return;
    const pane = await host.openConsole(target.connId, { sql: text, database: target.database, title: file.name });
    if (pane) toast("Opened a copy — use Save as to choose where it's saved", "info", 5000);
  }
}

// ---------------------------------------------------------------- run SQL file

const panels = new WeakMap<ConsolePane, RunPanel>();

/**
 * Run SQL file: pick the file (unless given), the data source (the console's / the given one, else the picker),
 * then the run panel at the bottom of a console of that data source (the given / active one, else a new console).
 */
export async function runSqlFileFlow(o: { console?: ConsolePane; connId?: string; database?: string | null; path?: string } = {}): Promise<void> {
  if (!host) return;
  let p = o.path ?? null;
  if (!p) {
    const on = o.console ? connLabel(o.console.connId, o.console.database) : o.connId ? connLabel(o.connId, o.database ?? null) : "";
    try {
      const r = await open({ multiple: false, directory: false, title: on ? `Run SQL file on ${on}` : "Run SQL file", filters: FILTERS, purpose: "script" });
      p = typeof r === "string" ? r : null;
    } catch (e) {
      toast(`Couldn't open the file dialog: ${errMsg(e)}`, "error");
      return;
    }
  }
  if (!p) return;
  const st = await api.fileMtime(p).catch(() => null);
  if (!st) {
    toast(`Couldn't read ${baseName(p)}`, "error");
    return;
  }
  let connId = o.console?.connId ?? o.connId ?? null;
  let database = o.console ? o.console.database : (o.database ?? null);
  if (!connId) {
    const t = await pickTarget({
      title: `Run ${baseName(p)}`,
      meta: `${shortDir(dirName(p))}/${baseName(p)} · ${humanSize(st.size)}`,
      okLabel: "Continue",
      remember: false,
      preferred: getSettings().files.targets[p] ?? null,
    });
    if (!t) return;
    connId = t.connId;
    database = t.database;
  }
  const e = store.conns.get(connId);
  if (!e || !SQL_DRIVERS.has(e.config.driver)) {
    toast("Run SQL file works with PostgreSQL, MySQL, SQLite and SQL Server data sources.", "info");
    return;
  }
  const cur = host.activeConsole();
  let pane = o.console ?? (cur && cur.connId === connId && (cur.database ?? "") === (database ?? "") ? cur : null);
  if (!pane) pane = await host.openConsole(connId, { database, title: `run ${baseName(p)}` });
  if (!pane) return;
  host.activate(pane);
  const existing = panels.get(pane);
  if (existing?.running) {
    toast("A SQL file is already running in this console", "info");
    return;
  }
  existing?.remove();
  const panel = new RunPanel(pane, p, st.size, connId, database);
  panels.set(pane, panel);
}

class RunPanel {
  readonly el: HTMLElement;
  running = false;
  private runId = "";
  private failures: SqlRunFailure[] = [];
  private failEl: HTMLElement;
  private head: HTMLElement;
  private bar: HTMLElement;
  private counts: HTMLElement;
  private actions: HTMLElement;
  private optsEl: HTMLElement;
  private noteEl: HTMLElement;
  private optStop: HTMLInputElement;
  private optBatch: HTMLInputElement;
  private optBatchN: HTMLInputElement;
  private optSingle: HTMLInputElement;

  constructor(
    private pane: ConsolePane,
    private path: string,
    size: number,
    private connId: string,
    private database: string | null,
  ) {
    const cfg = store.conns.get(connId)?.config;
    this.optStop = h("input", { type: "checkbox" });
    this.optBatch = h("input", { type: "checkbox", checked: true });
    this.optBatchN = h("input", { class: "input sr-n", type: "number", min: "1", max: "100000", value: "500", "aria-label": "Statements per transaction" });
    this.optSingle = h("input", { type: "checkbox" });
    this.optBatch.addEventListener("change", () => {
      if (this.optBatch.checked) this.optSingle.checked = false;
    });
    this.optSingle.addEventListener("change", () => {
      if (this.optSingle.checked) this.optBatch.checked = false;
    });
    this.optsEl = h(
      "div",
      { class: "sr-opts" },
      h("label", { class: "check" }, this.optStop, h("span", null, "Stop on first error")),
      h("label", { class: "check" }, this.optBatch, h("span", null, "One transaction per "), this.optBatchN, h("span", null, " statements")),
      h("label", { class: "check" }, this.optSingle, h("span", null, "Run in a single transaction (all or nothing)")),
    );
    this.head = h("div", { class: "sr-title" });
    this.actions = h("div", { class: "sr-actions" });
    this.bar = h("div", { class: "sr-fill" });
    this.counts = h("div", { class: "sr-counts" });
    this.failEl = h("div", { class: "sr-log mono", role: "log", "aria-label": "Failures" });
    this.noteEl = h("div", { class: "sr-note", hidden: true });
    const warn =
      cfg && (cfg.readOnly || isProdConnection(cfg))
        ? h("div", { class: "sr-warn" }, icon("alert", 13), cfg.readOnly ? `${cfg.name} is read-only: statements that change data will fail.` : `${cfg.name} looks like a production data source. The file's statements change its data.`)
        : null;
    this.el = h(
      "section",
      { class: "sqlrun", "aria-label": "Run SQL file" },
      h("div", { class: "sr-head" }, this.head, h("span", { class: "sr-meta" }, humanSize(size)), h("div", { class: "spacer" }), this.actions),
      warn,
      h("div", { class: "sr-bar" }, this.bar),
      this.counts,
      this.optsEl,
      this.noteEl,
      this.failEl,
    );
    pane.el.appendChild(this.el);
    this.renderIdle();
  }

  remove(): void {
    this.el.remove();
  }

  private title(verb: string): void {
    clear(this.head);
    this.head.append(verb + " ", h("b", null, baseName(this.path)), ` on ${connLabel(this.connId, this.database)}`);
    this.head.title = this.path;
  }

  private btn(label: string, cls: string, run: () => void): HTMLButtonElement {
    return h("button", { class: "btn sm " + cls, type: "button", onclick: run }, label);
  }

  private renderIdle(): void {
    this.title("Run");
    clear(this.actions);
    this.actions.append(this.btn("Cancel", "ghost", () => this.remove()), this.btn("Run", "primary", () => void this.start()));
    this.optsEl.hidden = false;
    this.bar.style.width = "0%";
    this.counts.textContent = "The file is read from disk and run statement by statement on its own connection; nothing is loaded into the editor.";
    this.failEl.hidden = true;
  }

  private options(): SqlRunOptions {
    const n = Math.max(1, Math.min(100000, Math.round(Number(this.optBatchN.value) || 500)));
    return { stopOnError: this.optStop.checked, batchTx: this.optBatch.checked && !this.optSingle.checked ? n : null, singleTx: this.optSingle.checked };
  }

  private async start(): Promise<void> {
    if (this.running || !host) return;
    const opts = this.options();
    this.running = true;
    this.failures = [];
    clear(this.failEl);
    this.failEl.hidden = false;
    this.noteEl.hidden = true;
    this.optsEl.hidden = true;
    this.title("Running");
    clear(this.actions);
    const stop = this.btn("Stop", "sr-stop", () => void this.stop(stop));
    this.actions.append(stop);
    this.counts.textContent = "Connecting…";
    this.runId = globalThis.crypto.randomUUID?.() ?? "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    let unlisten: (() => void) | null = null;
    let sess: SessionInfo | null = null;
    try {
      unlisten = await listen<SqlRunProgress>("sqlfile-progress", (ev) => {
        if (ev.payload.runId === this.runId) this.update(ev.payload);
      });
      if (!(await host.ensureConnected(this.connId))) throw new Error(`Couldn't connect to ${connLabel(this.connId, this.database)}`);
      // Its own session: the console's transaction state and running statements are not involved.
      sess = await api.openSession(this.connId, this.database);
      this.counts.textContent = "Counting statements…";
      const final = await api.runSqlFile(sess.sessionId, this.path, opts, this.runId);
      this.update(final);
      this.finish(final);
    } catch (e) {
      this.finish(null, errMsg(e));
    } finally {
      unlisten?.();
      if (sess) void api.closeSession(sess.sessionId).catch(() => undefined);
      this.running = false;
    }
  }

  private async stop(b: HTMLButtonElement): Promise<void> {
    b.disabled = true;
    b.textContent = "Stopping…";
    await api.runSqlFileCancel(this.runId).catch(() => undefined);
  }

  private update(p: SqlRunProgress): void {
    if (!this.el.isConnected && this.running) {
      // The console was closed: don't keep running behind its back.
      void api.runSqlFileCancel(this.runId).catch(() => undefined);
      return;
    }
    const pct = p.total ? (p.done / p.total) * 100 : p.bytesTotal ? (p.bytesDone / p.bytesTotal) * 100 : 0;
    this.bar.style.width = Math.min(100, p.finished && !p.stopped ? 100 : pct).toFixed(1) + "%";
    clear(this.counts);
    const total = p.total !== null ? `${fmtInt(p.done)} / ${fmtInt(p.total)} statements` : `${fmtInt(p.done)} statements`;
    let timing = fmtDuration(p.elapsedMs);
    if (!p.finished && p.done > 0 && p.elapsedMs > 3000) {
      const left = p.total ? ((p.total - p.done) * p.elapsedMs) / p.done : p.bytesDone > 0 ? ((p.bytesTotal - p.bytesDone) * p.elapsedMs) / p.bytesDone : 0;
      if (left > 0) timing += ` · about ${fmtDuration(left)} left`;
    }
    this.counts.append(
      ...[
      h("span", null, total),
      h("span", { class: "sr-ok" }, `✓ ${fmtInt(p.ok)} ok`),
      h("span", { class: "sr-fail" + (p.failed ? "" : " zero") }, `✕ ${fmtInt(p.failed)} failed`),
      p.rolledBack ? h("span", { class: "sr-rb", title: "Ran fine, then undone by a transaction rollback" }, `↺ ${fmtInt(p.rolledBack)} rolled back`) : null,
      h("span", { class: "sr-time" }, timing),
      ].filter((x): x is HTMLSpanElement => x !== null),
    );
    if (p.lastError && this.failures.length < 1000) {
      const f = p.lastError;
      this.failures.push(f);
      const stmt = f.statement.length > 70 ? f.statement.slice(0, 70) + " …" : f.statement;
      this.failEl.appendChild(
        h(
          "div",
          { class: "sr-line", title: `${f.statement}\n\n${f.message}` },
          h("span", { class: "sr-ln" }, `✕ line ${fmtInt(f.line)}`),
          " ",
          stmt,
          h("span", { class: "sr-msg" }, " — " + f.message),
        ),
      );
      this.failEl.scrollTop = this.failEl.scrollHeight;
    }
    if (p.note) {
      this.noteEl.hidden = false;
      this.noteEl.textContent = p.note;
    }
  }

  private finish(p: SqlRunProgress | null, error?: string): void {
    clear(this.actions);
    this.title(error ? "Couldn't run" : p?.cancelled ? "Stopped" : p?.stopped ? "Stopped" : "Ran");
    this.actions.append(this.btn("Run again", "ghost", () => this.renderIdle()), this.btn("Close", "ghost", () => this.remove()));
    if (error) {
      this.failEl.hidden = false;
      this.failEl.appendChild(h("div", { class: "sr-line" }, h("span", { class: "sr-ln" }, "✕"), " " + error));
      return;
    }
    if (!p) return;
    if (p.stopped) this.failEl.appendChild(h("div", { class: "sr-line sr-stopped" }, p.stopped));
    if (!p.failed && !p.stopped) this.failEl.appendChild(h("div", { class: "sr-line sr-done" }, `✓ All ${fmtInt(p.ok)} statements ran in ${fmtDuration(p.elapsedMs)}.`));
    if (host?.activeConsole() !== this.pane) {
      toast(`${baseName(this.path)}: ${fmtInt(p.ok)} ok, ${fmtInt(p.failed)} failed${p.stopped ? " — " + p.stopped : ""}`, p.failed ? "error" : "ok");
    }
  }
}

// ---------------------------------------------------------------- shell wiring

let dropEl: HTMLElement | null = null;

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** Wires the shell: window focus checks the active file console, .sql files dropped on the window open copies. */
export function initSqlFiles(h0: FileHost): void {
  host = h0;
  window.addEventListener("focus", () => void host?.activeConsole()?.file.checkDisk());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void host?.activeConsole()?.file.checkDisk();
  });
  let depth = 0;
  const showDrop = (on: boolean): void => {
    if (on && !dropEl) {
      dropEl = h("div", { class: "file-drop", "aria-hidden": "true" }, h("div", { class: "file-drop-card" }, icon("download", 22), h("div", null, "Drop to open as a new console"), h("div", { class: "file-drop-sub" }, ".sql or .txt — a copy; Save as chooses where it's saved")));
      document.body.appendChild(dropEl);
    } else if (!on && dropEl) {
      dropEl.remove();
      dropEl = null;
    }
  };
  // Capture phase: wins over CodeMirror, which would insert a dropped file's text into the editor.
  window.addEventListener(
    "dragenter",
    (e) => {
      if (!hasFiles(e)) return;
      depth++;
      showDrop(true);
    },
    true,
  );
  window.addEventListener(
    "dragleave",
    (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) showDrop(false);
    },
    true,
  );
  window.addEventListener(
    "dragover",
    (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    true,
  );
  window.addEventListener(
    "drop",
    (e) => {
      if (!hasFiles(e)) return;
      depth = 0;
      showDrop(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      e.preventDefault();
      e.stopPropagation();
      if (document.querySelector(".overlay:not(.leaving)")) return;
      const sql = files.filter((f) => /\.(sql|txt)$/i.test(f.name));
      if (!sql.length) {
        if (files.length) toast("Drop .sql or .txt files to open them in a console", "info");
        return;
      }
      void openDropped(sql);
    },
    true,
  );
}

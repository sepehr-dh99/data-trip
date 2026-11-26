import { api } from "../api";
import type { HistoryEntry } from "../types";
import { clear, debounce, errMsg, h, icon } from "./dom";

/** Window event fired after history entries were deleted elsewhere (Settings › Clear history): panels refresh. */
export const HISTORY_CHANGED = "dt-history-changed";

export interface HistoryHost {
  insert(sql: string): void;
  run(sql: string): void;
  /** The drawer's own close button / Escape. */
  close(): void;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export class HistoryPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private scopeBtn: HTMLButtonElement;
  private connId: string | null = null;
  private connName = "";
  private allScope = false;
  private visible = false;
  private seq = 0;

  constructor(private host: HistoryHost) {
    this.search = h("input", { type: "search", placeholder: "Search history", "aria-label": "Search history", spellcheck: false, oninput: debounce(() => void this.refresh(), 180) });
    this.scopeBtn = h("button", { class: "scope-chip", type: "button", title: "Toggle between this connection and all connections", onclick: () => {
      this.allScope = !this.allScope;
      this.updateScope();
      void this.refresh();
    } });
    this.list = h("div", { class: "hist-list", role: "list" });
    this.el = h(
      "aside",
      { class: "history-drawer", "aria-label": "Query history", "aria-hidden": "true", inert: true },
      h(
        "div",
        { class: "drawer-head" },
        h("div", { class: "drawer-title" }, icon("clock", 15), "History"),
        this.scopeBtn,
        h("button", { class: "icon-btn", type: "button", title: "Close history", "aria-label": "Close history", onclick: () => this.host.close() }, icon("x", 14)),
      ),
      h("label", { class: "side-search drawer-search" }, icon("search", 13), this.search),
      this.list,
    );
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.host.close();
      }
    });
    this.updateScope();
    window.addEventListener(HISTORY_CHANGED, () => void this.refresh());
  }

  private updateScope(): void {
    this.scopeBtn.textContent = this.allScope || !this.connId ? "All connections" : this.connName || "This connection";
  }

  setConnection(id: string | null, name: string): void {
    if (id === this.connId) return;
    this.connId = id;
    this.connName = name;
    this.updateScope();
    if (this.visible) void this.refresh();
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.el.classList.toggle("open", this.visible);
    this.el.setAttribute("aria-hidden", String(!this.visible));
    if (this.visible) this.el.removeAttribute("inert");
    else this.el.setAttribute("inert", "");
    if (this.visible) {
      void this.refresh();
      this.search.focus({ preventScroll: true });
    }
    return this.visible;
  }

  isOpen(): boolean {
    return this.visible;
  }

  async refresh(): Promise<void> {
    if (!this.visible) return;
    const my = ++this.seq;
    try {
      const q = this.search.value.trim();
      const items = await api.listHistory(this.allScope ? null : this.connId, q === "" ? null : q, 200);
      if (my !== this.seq) return;
      this.render(items);
    } catch (e) {
      clear(this.list);
      this.list.appendChild(h("div", { class: "empty-note err" }, errMsg(e)));
    }
  }

  private render(items: HistoryEntry[]): void {
    clear(this.list);
    if (items.length === 0) {
      this.list.appendChild(h("div", { class: "empty-note" }, "No queries yet. Run something and it will show up here."));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const row = h(
        "div",
        { class: "hist-item" + (it.ok ? "" : " bad"), tabindex: "0", role: "listitem", title: it.error ?? "Click to insert, double-click to run" },
        h(
          "div",
          { class: "hist-meta" },
          h("span", { class: "hist-dot " + (it.ok ? "ok" : "err") }),
          h("span", { class: "hist-when" }, when(it.executedAt)),
          h("span", { class: "spacer" }),
          h("span", { class: "hist-stats" }, (it.ok && it.rows !== null ? `${it.rows.toLocaleString()} rows · ` : "") + `${it.elapsedMs} ms`),
        ),
        h("div", { class: "hist-sql" }, it.sql.trim()),
        it.ok ? null : h("div", { class: "hist-err" }, it.error ?? "Error"),
      );
      // Only the first click of a double-click inserts; the double-click then runs.
      row.addEventListener("click", (e) => {
        if (e.detail <= 1) this.host.insert(it.sql);
      });
      row.addEventListener("dblclick", () => this.host.run(it.sql));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.host.insert(it.sql);
      });
      frag.appendChild(row);
    }
    this.list.appendChild(frag);
  }
}

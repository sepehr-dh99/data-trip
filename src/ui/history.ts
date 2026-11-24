import { api } from "../api";
import type { HistoryEntry } from "../types";
import { clear, debounce, errMsg, h, icon } from "./dom";

export interface HistoryHost {
  insert(sql: string): void;
  run(sql: string): void;
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
    this.search = h("input", { class: "input", type: "search", placeholder: "Search history…", "aria-label": "Search history", oninput: debounce(() => void this.refresh(), 180) });
    this.scopeBtn = h("button", { class: "chip btn-chip", type: "button", title: "Toggle between this connection and all connections", onclick: () => {
      this.allScope = !this.allScope;
      this.updateScope();
      void this.refresh();
    } });
    this.list = h("div", { class: "hist-list" });
    this.el = h(
      "aside",
      { class: "panel history hidden", "aria-label": "Query history" },
      h("div", { class: "panel-head" }, h("div", { class: "panel-title" }, icon("clock", 15), "History"), this.scopeBtn),
      h("div", { class: "panel-search" }, icon("search", 13), this.search),
      this.list,
    );
    this.updateScope();
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
    this.el.classList.toggle("hidden", !this.visible);
    if (this.visible) {
      void this.refresh();
      this.search.focus();
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
        { class: "hist-item" + (it.ok ? "" : " bad"), tabindex: "0", title: it.error ?? "Click to insert, double-click to run" },
        h(
          "div",
          { class: "hist-meta" },
          h("span", { class: "hist-dot " + (it.ok ? "ok" : "err") }),
          h("span", null, when(it.executedAt)),
          h("span", { class: "spacer" }),
          h("span", null, it.ok && it.rows !== null ? `${it.rows.toLocaleString()} rows · ` : ""),
          h("span", null, `${it.elapsedMs} ms`),
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

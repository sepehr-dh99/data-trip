// Console tabs: the top strip (tabs that fit + "+N more" list + ⋯ menu) and the left / right rail (filter, grouping,
// sorting, pinned tabs, custom groups, drag to reorder). Tab names follow Settings › Tabs › Tab names; manual names,
// pinned tabs and custom groups are stored in the settings (tabs keyed by a stable key, see tabKey()).
import { preferences } from "../platform";
import type { ConnectionConfig } from "../types";
import { DRIVER_LABELS } from "../types";
import { clear, h, icon } from "./dom";
import { showMenu } from "./menu";
import type { MenuItem } from "./menu";
import { promptDialog } from "./prompt";
import { dbLabel } from "./redis";
import { getSettings, onSettingsChange, updateSettings } from "./settings";
import type { CustomTabGroup, TabGroup, TabPlacement, TabSort } from "./settings";
import { shortcutLabel } from "./keymap";
import { CONN_COLORS, connColor } from "./sqlutil";
import { store } from "./state";
import type { TabPane } from "./tabs";

export interface TabStripHost {
  /** Open tabs in manual order. */
  tabs(): TabPane[];
  active(): TabPane | null;
  activate(t: TabPane): void;
  close(t: TabPane): void;
  closeMany(list: TabPane[]): void;
  newConsole(): void;
  /** New manual order (same tabs). */
  setOrder(list: TabPane[]): void;
  /** Called after names / placement changed (navigator, capsule fit). */
  changed(): void;
}

interface Meta {
  key: string;
  /** Manual name (double-click / Rename); null = automatic. */
  name: string | null;
  /** Date.now() of the last activation (Recently used). */
  used: number;
}

interface Group {
  id: string;
  label: string;
  color: string;
  items: TabPane[];
  custom?: CustomTabGroup;
}

const DRAG_MIME = "application/x-datatrip-tab";
const UNGROUPED = "__ungrouped";
const RAIL_MIN = 180;
const RAIL_MAX = 440;
const NAMES_KEY = "dt.tabNames";
const COLLAPSED_KEY = "dt.tabGroupsCollapsed";

const GROUP_LABELS: Record<TabGroup, string> = { source: "Data source", database: "Database", kind: "Kind", custom: "My groups", none: "None" };
const SORT_LABELS: Record<TabSort, string> = { manual: "Manual", name: "A–Z", recent: "Recent" };
const PLACE_NAMES: Record<TabPlacement, string> = { top: "on top", left: "on the left", right: "on the right" };
/** Placement glyph: a window with the tab area filled ([x, y, w, h] of the filled rect). */
const PLACE_RECT: Record<TabPlacement, [number, number, number, number]> = { top: [2.5, 2.5, 9, 2], left: [2.5, 2.5, 3, 7], right: [8.5, 2.5, 3, 7] };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function placeGlyph(p: TabPlacement): HTMLSpanElement {
  const [x, y, w, hh] = PLACE_RECT[p];
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = `<svg width="14" height="12" viewBox="0 0 14 12" fill="none" aria-hidden="true"><rect x=".75" y=".75" width="12.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.2"/><rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="1" fill="currentColor"/></svg>`;
  return s;
}

/** rgba() of a #rrggbb color, else the given fallback. */
function soft(color: string, alpha: number, fallback = "var(--fill)"): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function connOf(t: TabPane): ConnectionConfig | null {
  return store.conns.get(t.connId)?.config ?? null;
}

function dbText(t: TabPane): string | null {
  const cfg = connOf(t);
  const db = t.effectiveDatabase;
  if (cfg?.driver === "redis") return dbLabel(db);
  return db;
}

/** "Tables" / "Consoles" / "Redis keys" / "Kafka topics" / "Consumer groups". */
function kindLabel(t: TabPane): string {
  if (t.kind === "console") return t.table ? "Tables" : "Consoles";
  if (t.kind === "key") return "Redis keys";
  if (t.kind === "topic") return "Kafka topics";
  if (t.kind === "sessions") return "Sessions & locks";
  if (t.kind === "ddl") return "DDL";
  if (t.kind === "design") return "Table designer";
  return "Consumer groups";
}

/** Stable key used to remember pinned tabs and custom-group membership (connection + database + object). */
export function tabKey(t: TabPane): string {
  const db = t.effectiveDatabase ?? "";
  if (t.kind === "console") return t.table ? `table:${t.connId}:${db}:${t.currentSchemaName() ?? ""}.${t.table}` : `console:${t.connId}:${db}:${t.title}`;
  return `${t.kind}:${t.connId}:${db}:${t.title}`;
}

/** Automatic tab name for the current naming setting. */
export function autoName(t: TabPane): string {
  const naming = getSettings().tabs.naming;
  const cfg = connOf(t);
  const conn = cfg?.name ?? "";
  // Cross-source consoles read several databases: no single database in the name.
  const db = t.sourceBadge ? "" : dbText(t);
  if (t.kind !== "console") return naming === "source" && conn ? `${conn} / ${t.title}` : t.title;
  // Consoles bound to a .sql file are named after the file.
  if (t.filePath) return naming === "source" && conn ? `${conn} / ${t.title}` : t.title;
  if (naming === "classic") return t.title;
  if (naming === "source") return `${conn || t.title}${db ? " / " + db : ""}${t.table ? " · " + t.table : ""}`;
  const base = t.table ?? t.title;
  return db ? `${base} · ${db}` : base;
}

/** Tooltip path: "shop.public.orders — Prod PG". */
export function fullPath(t: TabPane): string {
  const cfg = connOf(t);
  const conn = cfg ? cfg.name : "";
  const db = dbText(t);
  let path: string;
  if (t.kind === "console" && t.filePath) return conn ? `${t.filePath} — ${conn}` : t.filePath;
  if (t.kind === "console" && t.table) {
    const parts: string[] = [];
    if (t.effectiveDatabase) parts.push(t.effectiveDatabase);
    const sc = t.currentSchemaName();
    if (sc && sc !== t.effectiveDatabase) parts.push(sc);
    parts.push(t.table);
    path = parts.join(".");
  } else if (t.kind === "console") path = `${t.title}${db ? " · " + db : ""}`;
  else if (t.kind === "key") path = `${db ?? "db0"} · ${t.title}`;
  else if (t.kind === "sessions") path = t.title;
  else if (t.kind === "ddl" || t.kind === "design") path = `${db ? db + " · " : ""}${t.title}`;
  else path = `${t.kind === "topic" ? "topic" : "group"} ${t.title}`;
  return conn ? `${path} — ${conn}` : path;
}

export class TabStrip {
  /** Goes into the capsule (top placement). */
  readonly topEl: HTMLElement;
  /** Goes into the sheet (left / right placement). */
  readonly railEl: HTMLElement;
  private tabsEl = h("div", { class: "cap-tabs", role: "tablist", "aria-label": "Consoles" });
  private moreBtn: HTMLButtonElement;
  private menuBtn: HTMLButtonElement;
  private placeTop: HTMLElement;
  private railCount = h("span", { class: "rail-count" });
  private railFilter: HTMLInputElement;
  private groupBtn: HTMLButtonElement;
  private sortBtn: HTMLButtonElement;
  private railList = h("div", { class: "rail-list", role: "tablist", "aria-label": "Consoles", "aria-orientation": "vertical" });
  private railHint = h("span", { class: "rail-hint" });
  private railJump = h("span", { class: "rail-jump" });
  private meta = new Map<TabPane, Meta>();
  private els = new Map<TabPane, HTMLElement[]>();
  private collapsed: Set<string>;
  private q = "";
  private hiddenTop: TabPane[] = [];
  private closeAll: (() => void) | null = null;
  private editing = false;
  /** Tab being renamed inline (closing it must not leave the strip frozen). */
  private editingTab: TabPane | null = null;
  /** Ends an inline rename without saving (used when its tab goes away). */
  private cancelRename: (() => void) | null = null;
  private pending = false;
  private drag: TabPane | null = null;
  private railW: number;
  private sheet: HTMLElement | null = null;
  private capWrap: HTMLElement | null = null;
  private lastPlacement: TabPlacement | null = null;
  /** Manual names that survive a restart (by tab key). */
  private savedNames: Record<string, string>;

  constructor(
    private host: TabStripHost,
    addBtn: HTMLButtonElement,
  ) {
    this.collapsed = new Set(readJson<string[]>(COLLAPSED_KEY, []));
    this.savedNames = readJson<Record<string, string>>(NAMES_KEY, {});
    this.railW = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Number(preferences.getItem("dt.tabRailW")) || 248));

    this.moreBtn = h("button", { class: "cap-more", type: "button", "aria-haspopup": "dialog", hidden: true, onclick: () => this.toggleAll() }, "+0 more ▾");
    this.menuBtn = h("button", { class: "cap-icon cap-tabmenu", type: "button", title: "Tab options", "aria-label": "Tab options", "aria-haspopup": "menu", onclick: () => this.openTabOptions() }, icon("dots", 16));
    this.placeTop = this.placementSwitch();
    this.topEl = h("div", { class: "cap-tabs-wrap" }, this.tabsEl, this.moreBtn, addBtn, this.placeTop, this.menuBtn);
    // Translate vertical wheel into horizontal scrolling for the strip (kept for the fitting edge cases).
    this.tabsEl.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.tabsEl.scrollWidth > this.tabsEl.clientWidth) {
          this.tabsEl.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );

    // ---- rail
    this.railFilter = h("input", { class: "rail-filter-input", type: "search", spellcheck: false, autocomplete: "off", "aria-label": "Filter tabs" });
    this.railFilter.addEventListener("input", () => {
      this.q = this.railFilter.value;
      this.renderRail();
    });
    this.railFilter.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (this.railFilter.value) {
          this.railFilter.value = "";
          this.q = "";
          this.renderRail();
        } else this.host.active()?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.railList.querySelector<HTMLElement>(".rt-row")?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const first = this.railRows()[0];
        if (first) {
          const t = this.paneOfRow(first);
          if (t) this.pick(t);
        }
      }
    });
    this.groupBtn = h("button", { class: "rail-pick", type: "button", "aria-haspopup": "menu", onclick: () => this.openGroupMenu() });
    this.sortBtn = h("button", { class: "rail-pick", type: "button", "aria-haspopup": "menu", onclick: () => this.openSortMenu() });
    const addRail = h("button", { class: "rail-add", type: "button", title: `New console (${shortcutLabel("newConsole")})`, "aria-label": "New console", onclick: () => this.host.newConsole() }, icon("plus", 13));
    const resizer = h("div", { class: "rail-resizer", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize tab rail", title: "Drag to resize" });
    this.bindResizer(resizer);
    this.railList.addEventListener("keydown", (e) => this.onRailKey(e));
    this.railList.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget || !this.railList.contains(e.relatedTarget as Node)) this.clearDropMarks();
    });
    this.railEl = h(
      "div",
      { class: "tab-rail", hidden: true },
      h("div", { class: "rail-head" }, this.railCount, this.placementSwitch(), addRail),
      h("label", { class: "rail-filter" }, icon("search", 12), this.railFilter),
      h("div", { class: "rail-picks" }, this.groupBtn, this.sortBtn),
      this.railList,
      h("div", { class: "rail-foot" }, this.railHint, h("span", { class: "spacer" }), this.railJump),
      resizer,
    );
    window.addEventListener("dragend", () => this.endDrag());
    onSettingsChange(() => {
      this.applyPlacement();
      this.render();
      this.host.changed();
    });
  }

  // ------------------------------------------------------------------ placement

  /** Hooks the rail into the sheet (classes / width) and the strip's capsule wrapper. */
  mount(sheet: HTMLElement): void {
    this.sheet = sheet;
    this.capWrap = this.topEl;
    sheet.appendChild(this.railEl);
    this.applyPlacement();
  }

  get placement(): TabPlacement {
    return getSettings().tabs.placement;
  }

  get vertical(): boolean {
    return this.placement !== "top";
  }

  private applyPlacement(): void {
    const p = this.placement;
    const v = p !== "top";
    if (this.sheet) {
      this.sheet.classList.toggle("tabs-rail", v);
      this.sheet.classList.toggle("tabs-left", p === "left");
      this.sheet.classList.toggle("tabs-right", p === "right");
      this.sheet.style.setProperty("--rail-w", this.railW + "px");
    }
    this.railEl.hidden = !v;
    if (this.capWrap) this.capWrap.hidden = v;
    if (p !== this.lastPlacement) {
      this.lastPlacement = p;
      this.closeAll?.();
    }
  }

  private setPlacement(p: TabPlacement): void {
    if (p !== this.placement) updateSettings((s) => (s.tabs.placement = p));
  }

  private placementSwitch(): HTMLElement {
    const btns = (["top", "left", "right"] as TabPlacement[]).map((p) => {
      const b = h("button", { class: "place-btn", type: "button", role: "radio", "data-p": p, title: `Tabs ${PLACE_NAMES[p]}`, "aria-label": `Tabs ${PLACE_NAMES[p]}`, onclick: () => this.setPlacement(p) }, placeGlyph(p));
      return b;
    });
    return h("div", { class: "place-switch", role: "radiogroup", "aria-label": "Tab placement" }, btns);
  }

  private syncPlacementSwitches(): void {
    const p = this.placement;
    for (const b of [...this.topEl.querySelectorAll<HTMLElement>(".place-btn"), ...this.railEl.querySelectorAll<HTMLElement>(".place-btn")]) {
      const on = b.dataset.p === p;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  private bindResizer(el: HTMLElement): void {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.railW;
      const dir = this.placement === "right" ? -1 : 1;
      const move = (ev: PointerEvent): void => {
        this.railW = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + dir * (ev.clientX - startX)));
        this.sheet?.style.setProperty("--rail-w", this.railW + "px");
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing-col");
        preferences.setItem("dt.tabRailW", String(Math.round(this.railW)));
        this.host.changed();
      };
      document.body.classList.add("resizing-col");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  // ------------------------------------------------------------------ model

  private metaOf(t: TabPane): Meta {
    let m = this.meta.get(t);
    if (!m) {
      const base = tabKey(t);
      const taken = new Set([...this.meta.values()].map((x) => x.key));
      let key = base;
      for (let i = 2; taken.has(key); i++) key = `${base}#${i}`;
      m = { key, name: this.savedNames[key] ?? null, used: Date.now() };
      this.meta.set(t, m);
    }
    return m;
  }

  /** Display name: manual name, else the automatic one. */
  nameOf(t: TabPane): string {
    return this.metaOf(t).name ?? autoName(t);
  }

  /** Manual name of a tab (for "reopen closed tab"). */
  manualName(t: TabPane): string | null {
    return this.metaOf(t).name;
  }

  setManualName(t: TabPane, name: string | null): void {
    const m = this.metaOf(t);
    m.name = name && name.trim() ? name.trim() : null;
    if (m.name) this.savedNames[m.key] = m.name;
    else delete this.savedNames[m.key];
    writeJson(NAMES_KEY, this.savedNames);
    this.render();
    this.host.changed();
  }

  touch(t: TabPane): void {
    this.metaOf(t).used = Date.now();
  }

  forget(t: TabPane): void {
    this.meta.delete(t);
    this.els.delete(t);
    // Closing the tab that is being renamed ends the rename, so the next render() isn't deferred forever.
    if (this.editingTab === t) this.cancelRename?.();
  }

  /** Stable key of a tab (pinned tabs, custom groups, restore on launch). */
  keyFor(t: TabPane): string {
    return this.keyOf(t);
  }

  /**
   * A tab restored on launch keeps the key it was saved with, so pinned tabs and custom-group membership still
   * match before its data source is connected again (the automatic key would lack the database then).
   */
  adopt(t: TabPane, key: string, name: string | null): void {
    if (this.meta.has(t)) return;
    const taken = new Set([...this.meta.values()].map((x) => x.key));
    const base = key || tabKey(t);
    let k = base;
    for (let i = 2; taken.has(k); i++) k = `${base}#${i}`;
    this.meta.set(t, { key: k, name: name && name.trim() ? name.trim() : (this.savedNames[k] ?? null), used: Date.now() });
  }

  /** `next` takes over `old`'s place, key, name and last use (a restored placeholder became the real tab). */
  replace(old: TabPane, next: TabPane): void {
    const m = this.meta.get(old);
    this.meta.delete(old);
    this.els.delete(old);
    if (m) this.meta.set(next, m);
  }

  private keyOf(t: TabPane): string {
    return this.metaOf(t).key;
  }

  private isPinned(t: TabPane): boolean {
    return getSettings().tabs.pinned.includes(this.keyOf(t));
  }

  private customOf(t: TabPane): CustomTabGroup | null {
    const k = this.keyOf(t);
    return getSettings().tabs.customGroups.find((g) => g.members.includes(k)) ?? null;
  }

  private sorted(list: TabPane[], custom?: CustomTabGroup): TabPane[] {
    const sort = getSettings().tabs.sort;
    const order = this.host.tabs();
    if (sort === "name") return [...list].sort((a, b) => collator.compare(this.nameOf(a), this.nameOf(b)));
    if (sort === "recent") return [...list].sort((a, b) => this.metaOf(b).used - this.metaOf(a).used);
    if (custom) {
      const idx = (t: TabPane): number => {
        const i = custom.members.indexOf(this.keyOf(t));
        return i < 0 ? 1e9 + order.indexOf(t) : i;
      };
      return [...list].sort((a, b) => idx(a) - idx(b));
    }
    return [...list].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  private pinnedTabs(): TabPane[] {
    const keys = getSettings().tabs.pinned;
    return this.host
      .tabs()
      .filter((t) => keys.includes(this.keyOf(t)))
      .sort((a, b) => keys.indexOf(this.keyOf(a)) - keys.indexOf(this.keyOf(b)));
  }

  private matches(t: TabPane): boolean {
    const q = this.q.trim().toLowerCase();
    if (!q) return true;
    const cfg = connOf(t);
    return `${this.nameOf(t)} ${cfg?.name ?? ""} ${fullPath(t)} ${kindLabel(t)}`.toLowerCase().includes(q);
  }

  /** Groups of the given tabs for the current grouping (custom groups: every group, even empty, then Ungrouped). */
  private groups(list: TabPane[], mode: TabGroup = getSettings().tabs.group): Group[] {
    if (mode === "none") return [{ id: "__all", label: "", color: "", items: this.sorted(list) }];
    if (mode === "custom") {
      const out: Group[] = getSettings().tabs.customGroups.map((g) => ({ id: g.id, label: g.name, color: g.color, items: [] as TabPane[], custom: g }));
      const rest: TabPane[] = [];
      for (const t of list) {
        const g = this.customOf(t);
        const slot = g ? out.find((x) => x.id === g.id) : undefined;
        if (slot) slot.items.push(t);
        else rest.push(t);
      }
      for (const g of out) g.items = this.sorted(g.items, g.custom);
      if (rest.length) out.push({ id: UNGROUPED, label: "Ungrouped", color: "var(--text-4)", items: this.sorted(rest) });
      return out;
    }
    const map = new Map<string, Group>();
    for (const t of this.sorted(list)) {
      const cfg = connOf(t);
      let id: string;
      let label: string;
      let color = cfg ? connColor(cfg) : "var(--text-3)";
      if (mode === "source") {
        id = "s:" + t.connId;
        label = cfg?.name ?? "Data source";
      } else if (mode === "database") {
        const db = dbText(t);
        id = `d:${t.connId}:${t.effectiveDatabase ?? ""}`;
        label = `${cfg?.name ?? "Data source"}${db ? " / " + db : ""}`;
      } else {
        label = kindLabel(t);
        id = "k:" + label;
        color = "var(--text-3)";
      }
      let g = map.get(id);
      if (!g) {
        g = { id, label, color, items: [] };
        map.set(id, g);
      }
      g.items.push(t);
    }
    return [...map.values()];
  }

  /** Every tab in display order (pinned first): what next / previous tab walk through. */
  ordered(): TabPane[] {
    const pinned = this.pinnedTabs();
    const rest = this.host.tabs().filter((t) => !pinned.includes(t));
    if (!this.vertical) return [...pinned, ...this.sorted(rest)];
    return [...pinned, ...this.groups(rest).flatMap((g) => g.items)];
  }

  // ------------------------------------------------------------------ rendering

  render(): void {
    if (this.editing) {
      this.pending = true;
      return;
    }
    this.els.clear();
    this.syncPlacementSwitches();
    this.renderTop();
    this.renderRail();
  }

  setRunning(t: TabPane): void {
    for (const el of this.els.get(t) ?? []) el.classList.toggle("running", t.isRunning);
  }

  private remember(t: TabPane, el: HTMLElement): void {
    const l = this.els.get(t) ?? [];
    l.push(el);
    this.els.set(t, l);
  }

  private badge(t: TabPane): HTMLElement | null {
    if (getSettings().tabs.naming !== "table") return null;
    if (t.sourceBadge) return h("span", { class: "tab-src multi" }, t.sourceBadge);
    const cfg = connOf(t);
    if (!cfg) return null;
    const c = connColor(cfg);
    return h("span", { class: "tab-src", style: `--c:${c};--cs:${soft(c, 0.16)}` }, cfg.name);
  }

  private tooltip(t: TabPane): string {
    const cfg = connOf(t);
    const server = cfg ? DRIVER_LABELS[cfg.driver].split(" / ")[0] + (store.conns.get(t.connId)?.session?.serverVersion ? " " + store.conns.get(t.connId)?.session?.serverVersion : "") : "";
    const tip = getSettings().tabs.sort === "manual" ? "Double-click to rename · drag to reorder" : "Double-click to rename";
    return `${fullPath(t)}${server ? " (" + server + ")" : ""}${t.statusHint ? "\n" + t.statusHint : ""}\n${tip}`;
  }

  private renderTop(): void {
    clear(this.tabsEl);
    if (this.vertical) {
      this.moreBtn.hidden = true;
      return;
    }
    const active = this.host.active();
    const manual = getSettings().tabs.sort === "manual";
    for (const t of this.ordered()) {
      const isActive = t === active;
      const cfg = connOf(t);
      const color = cfg ? connColor(cfg) : "var(--accent)";
      const close = h(
        "button",
        { class: "tab-close", type: "button", tabindex: "-1", title: `Close (${shortcutLabel("closeTab")})`, "aria-label": `Close ${this.nameOf(t)}`, onclick: (ev: Event) => (ev.stopPropagation(), this.host.close(t)) },
        icon("x", 11),
      );
      const title = h("span", { class: "tab-title" + (t.kind === "key" || t.kind === "topic" || t.kind === "group" ? " mono" : "") }, this.nameOf(t));
      const tab = h(
        "div",
        {
          class: "tab" + (isActive ? " active" : "") + (t.isRunning ? " running" : "") + (this.isPinned(t) ? " pinned" : ""),
          role: "tab",
          tabindex: isActive ? "0" : "-1",
          style: `--c:${color}`,
          title: this.tooltip(t),
          "aria-selected": String(isActive),
          draggable: manual ? "true" : undefined,
        },
        t.tabIcon ? h("span", { class: "tab-ico " + t.tabIcon.cls, "aria-hidden": "true" }, icon(t.tabIcon.icon, 13)) : h("span", { class: "tab-dot", "aria-hidden": "true" }),
        this.isPinned(t) ? h("span", { class: "tab-pin", "aria-hidden": "true" }, icon("pin", 11)) : null,
        title,
        this.badge(t),
        t.dirty ? h("span", { class: "tab-dirty", title: "Unsaved changes", "aria-label": "Unsaved changes" }) : null,
        close,
      );
      tab.addEventListener("click", () => {
        if (t !== this.host.active()) this.host.activate(t);
      });
      tab.addEventListener("auxclick", (ev) => {
        if (ev.button === 1) this.host.close(t);
      });
      tab.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        if (ev.target instanceof Element && ev.target.closest(".tab-close")) return;
        this.startRename(t, title);
      });
      tab.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this.tabMenu(t, ev.clientX, ev.clientY, title);
      });
      tab.addEventListener("keydown", (ev) => {
        const list = this.visibleTop();
        const i = list.indexOf(t);
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
          ev.preventDefault();
          const next = list[(i + (ev.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
          if (next) {
            this.host.activate(next);
            this.els.get(next)?.[0]?.focus();
          }
        } else if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this.host.activate(t);
        } else if (ev.key === "Delete") {
          ev.preventDefault();
          this.host.close(t);
        } else if (ev.key === "F2") {
          ev.preventDefault();
          this.startRename(t, title);
        }
      });
      if (manual) this.bindDrag(tab, t, "top", "x");
      this.remember(t, tab);
      this.tabsEl.appendChild(tab);
    }
    this.moreBtn.hidden = true;
    this.hiddenTop = [];
  }

  private visibleTop(): TabPane[] {
    return this.ordered().filter((t) => !this.hiddenTop.includes(t));
  }

  /**
   * Top placement: shows the tabs that fit the strip (the active one always) and moves the rest behind "+N more".
   * Called by the shell after the capsule's own layout pass.
   */
  fitTop(): void {
    if (this.vertical) return;
    const list = this.ordered();
    const tabs = list.map((t) => this.els.get(t)?.[0]).filter((x): x is HTMLElement => !!x);
    for (const el of tabs) el.classList.remove("off");
    this.moreBtn.hidden = true;
    this.hiddenTop = [];
    if (tabs.length === 0) return;
    if (this.tabsEl.scrollWidth <= this.tabsEl.clientWidth + 1) return;
    // Reserve room for the "+N more" button, then fill greedily.
    this.moreBtn.textContent = `+${list.length} more ▾`;
    this.moreBtn.hidden = false;
    const avail = this.tabsEl.clientWidth;
    const gap = 2;
    const w = tabs.map((el) => el.offsetWidth);
    const active = this.host.active();
    const ai = active ? list.indexOf(active) : -1;
    const shown = new Set<number>();
    let used = 0;
    for (let i = 0; i < list.length; i++) {
      if (used + w[i] + (shown.size ? gap : 0) > avail) break;
      used += w[i] + (shown.size ? gap : 0);
      shown.add(i);
    }
    if (ai >= 0 && !shown.has(ai)) {
      const order = [...shown].sort((a, b) => b - a);
      for (const i of order) {
        if (used + w[ai] + gap <= avail) break;
        shown.delete(i);
        used -= w[i] + gap;
      }
      shown.add(ai);
    }
    if (shown.size === 0 && list.length) shown.add(ai >= 0 ? ai : 0);
    list.forEach((t, i) => {
      if (!shown.has(i)) {
        tabs[i].classList.add("off");
        this.hiddenTop.push(t);
      }
    });
    const n = this.hiddenTop.length;
    this.moreBtn.hidden = n === 0;
    this.moreBtn.textContent = `+${n} more ▾`;
    this.moreBtn.title = `${n} more tab${n === 1 ? "" : "s"} — ${shortcutLabel("jumpToTab")} to search all tabs`;
    this.tabsEl.scrollLeft = 0;
  }

  private renderRail(): void {
    if (!this.vertical) return;
    const st = getSettings().tabs;
    const all = this.host.tabs();
    this.railCount.textContent = `${all.length} console${all.length === 1 ? "" : "s"}`;
    this.railFilter.placeholder = `Filter tabs   ${shortcutLabel("jumpToTab")}`;
    clear(this.groupBtn);
    this.groupBtn.append("Group: ", h("b", null, GROUP_LABELS[st.group]), " ▾");
    clear(this.sortBtn);
    this.sortBtn.append("Sort: ", h("b", null, SORT_LABELS[st.sort]), " ▾");
    this.railHint.textContent = st.sort === "manual" ? (st.group === "custom" ? "Drag ⠿ to reorder or into a group" : "Drag ⠿ to reorder") : st.sort === "name" ? "Sorted A–Z" : "Sorted by recent use";
    this.railJump.textContent = shortcutLabel("jumpToTab") ? `${shortcutLabel("jumpToTab")} jump` : "";

    const scroll = this.railList.scrollTop;
    const hadFocus = this.railList.contains(document.activeElement) ? this.paneOfRow(document.activeElement as HTMLElement) : null;
    clear(this.railList);
    const q = this.q.trim();
    const pinned = q ? [] : this.pinnedTabs();
    const rest = all.filter((t) => this.matches(t) && !pinned.includes(t));
    if (pinned.length) {
      this.railList.append(h("div", { class: "rail-sec" }, icon("pin", 11), "Pinned"));
      for (const t of pinned) this.railList.append(this.railRow(t, "pinned", false));
    }
    const groups = this.groups(rest);
    const flat = st.group === "none";
    const dotByGroup = st.group === "source" || st.group === "database";
    for (const g of groups) {
      if (q && g.items.length === 0) continue;
      const open = flat || !!q || !this.collapsed.has(g.id);
      if (!flat) this.railList.append(this.groupHeader(g, open));
      if (open) for (const t of g.items) this.railList.append(this.railRow(t, g.id, !dotByGroup, flat));
    }
    if (st.group === "custom" && !q) {
      this.railList.append(h("button", { class: "rail-newgroup", type: "button", onclick: () => void this.newGroup(null) }, "+ New group…"));
    }
    if (all.length > 0 && pinned.length === 0 && rest.length === 0) this.railList.append(h("div", { class: "rail-empty" }, "No tab matches"));
    if (all.length === 0) this.railList.append(h("div", { class: "rail-empty" }, "No open tabs"));
    this.railList.scrollTop = scroll;
    if (hadFocus) (this.els.get(hadFocus) ?? []).find((el) => this.railList.contains(el))?.focus();
  }

  private groupHeader(g: Group, open: boolean): HTMLElement {
    const manual = getSettings().tabs.sort === "manual";
    const b = h(
      "button",
      { class: "rail-group", type: "button", "aria-expanded": String(open), "data-group": g.id, title: g.custom ? "Right-click to rename, recolor or delete the group" : g.label },
      h("span", { class: "rail-chev", "aria-hidden": "true" }, open ? "▾" : "▸"),
      h("span", { class: "rail-gdot", style: `--c:${g.color}`, "aria-hidden": "true" }),
      h("span", { class: "rail-glabel" }, g.label),
      h("span", { class: "rail-gcount" }, String(g.items.length)),
    );
    b.addEventListener("click", () => {
      if (open) this.collapsed.add(g.id);
      else this.collapsed.delete(g.id);
      writeJson(COLLAPSED_KEY, [...this.collapsed]);
      this.renderRail();
    });
    if (g.custom) {
      const cg = g.custom;
      b.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this.customGroupMenu(cg, ev.clientX, ev.clientY);
      });
    }
    if (manual && (g.custom || g.id === UNGROUPED)) {
      b.addEventListener("dragover", (ev) => {
        if (!this.drag) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
        this.clearDropMarks();
        b.classList.add("drop-into");
      });
      b.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const d = this.drag;
        this.clearDropMarks();
        if (d) this.dropInto(d, g.custom ? g.custom.id : null);
      });
    }
    return b;
  }

  private railRow(t: TabPane, section: string, showDot: boolean, flat = false): HTMLElement {
    const active = t === this.host.active();
    const st = getSettings().tabs;
    const manual = st.sort === "manual";
    const cfg = connOf(t);
    const color = cfg ? connColor(cfg) : "var(--text-3)";
    const name = h("span", { class: "rt-name" + (t.kind === "key" || t.kind === "topic" || t.kind === "group" ? " mono" : "") }, this.nameOf(t));
    const row = h(
      "div",
      {
        class: "rt-row" + (active ? " active" : "") + (t.isRunning ? " running" : "") + (section === "pinned" || flat ? " flat" : ""),
        role: "tab",
        tabindex: active ? "0" : "-1",
        "aria-selected": String(active),
        title: this.tooltip(t),
        style: `--c:${color}`,
        "data-section": section,
        draggable: manual ? "true" : undefined,
      },
      t.tabIcon
        ? h("span", { class: "rt-ico tab-ico " + t.tabIcon.cls, "aria-hidden": "true" }, icon(t.tabIcon.icon, 12))
        : h("span", { class: "rt-dot" + (showDot || section === "pinned" ? "" : " quiet"), "aria-hidden": "true" }),
      name,
      t.dirty ? h("span", { class: "rt-dirty", title: "Unsaved changes", "aria-label": "Unsaved changes" }, "●") : null,
      section === "pinned" ? h("span", { class: "rt-pin", "aria-hidden": "true" }, icon("pin", 11)) : null,
      manual ? h("span", { class: "rt-handle", "aria-hidden": "true" }, "⠿") : null,
      h(
        "button",
        { class: "rt-close", type: "button", tabindex: "-1", title: `Close (${shortcutLabel("closeTab")})`, "aria-label": `Close ${this.nameOf(t)}`, onclick: (ev: Event) => (ev.stopPropagation(), this.host.close(t)) },
        icon("x", 10),
      ),
    );
    row.addEventListener("click", () => this.pick(t));
    row.addEventListener("auxclick", (ev) => {
      if (ev.button === 1) this.host.close(t);
    });
    row.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      if (ev.target instanceof Element && ev.target.closest(".rt-close")) return;
      this.startRename(t, name);
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.tabMenu(t, ev.clientX, ev.clientY, name);
    });
    if (manual) this.bindDrag(row, t, section, "y");
    this.remember(t, row);
    return row;
  }

  private railRows(): HTMLElement[] {
    return [...this.railList.querySelectorAll<HTMLElement>(".rt-row")];
  }

  private paneOfRow(el: HTMLElement | null): TabPane | null {
    if (!el) return null;
    for (const [t, list] of this.els) if (list.includes(el)) return t;
    return null;
  }

  private onRailKey(e: KeyboardEvent): void {
    const rows = this.railRows();
    const cur = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>(".rt-row") : null;
    if (!cur) return;
    const i = rows.indexOf(cur);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (n) n.focus();
      else if (e.key === "ArrowUp") this.railFilter.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const t = this.paneOfRow(cur);
      if (t) this.pick(t);
    } else if (e.key === "Delete") {
      e.preventDefault();
      const t = this.paneOfRow(cur);
      if (t) this.host.close(t);
    } else if (e.key === "F2") {
      e.preventDefault();
      const t = this.paneOfRow(cur);
      const name = cur.querySelector<HTMLElement>(".rt-name");
      if (t && name) this.startRename(t, name);
    }
  }

  private pick(t: TabPane): void {
    if (t !== this.host.active()) this.host.activate(t);
    else t.focus();
  }

  // ------------------------------------------------------------------ rename

  private startRename(t: TabPane, label: HTMLElement): void {
    if (this.editing) return;
    this.editing = true;
    this.editingTab = t;
    const before = this.nameOf(t);
    const input = h("input", { class: "tab-rename", type: "text", value: before, spellcheck: false, "aria-label": "Tab name" });
    input.size = Math.max(6, before.length + 1);
    clear(label);
    label.appendChild(input);
    label.closest<HTMLElement>("[draggable]")?.setAttribute("draggable", "false");
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      this.editing = false;
      this.editingTab = null;
      this.cancelRename = null;
      const v = input.value.trim();
      const alive = this.host.tabs().includes(t);
      if (save && alive && v !== before) this.setManualName(t, v === autoName(t) ? null : v || null);
      else this.render();
      if (this.pending) {
        this.pending = false;
        this.render();
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
        t.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
        t.focus();
      }
    });
    input.addEventListener("input", () => (input.size = Math.max(6, input.value.length + 1)));
    input.addEventListener("blur", () => finish(true));
    this.cancelRename = () => finish(false);
    for (const ev of ["click", "dblclick", "pointerdown", "mousedown"]) input.addEventListener(ev, (e) => e.stopPropagation());
    input.focus();
    input.select();
    // Could not take focus (row already detached): don't leave the strip frozen waiting for a blur.
    if (document.activeElement !== input) finish(false);
  }

  /** Rename from a menu: inline when the tab is on screen, else a prompt. */
  rename(t: TabPane): void {
    const el = (this.els.get(t) ?? []).find((x) => x.isConnected && !x.classList.contains("off") && x.offsetParent !== null);
    const label = el?.querySelector<HTMLElement>(".tab-title, .rt-name");
    if (label) {
      this.startRename(t, label);
      return;
    }
    void promptDialog("Rename tab", "Tab name", this.nameOf(t), "Rename").then((v) => {
      if (v !== null) this.setManualName(t, v === autoName(t) ? null : v || null);
    });
  }

  // ------------------------------------------------------------------ menus

  private groupLabelOf(t: TabPane): { id: string; label: string } | null {
    const mode = getSettings().tabs.group;
    if (mode === "none") return null;
    const g = this.groups(this.host.tabs()).find((x) => x.items.includes(t));
    return g ? { id: g.id, label: g.label } : null;
  }

  private tabMenu(t: TabPane, x: number, y: number, label: HTMLElement): void {
    const pinned = this.isPinned(t);
    const all = this.host.tabs();
    const grp = this.groupLabelOf(t);
    const inGroup = grp ? this.groups(all).find((g) => g.id === grp.id)?.items ?? [] : [];
    showMenu(
      x,
      y,
      [
        { label: "Rename…", icon: "pencil", hint: "F2", onClick: () => window.setTimeout(() => (label.isConnected ? this.startRename(t, label) : this.rename(t)), 0) },
        { label: pinned ? "Unpin" : "Pin", icon: "pin", onClick: () => this.togglePin(t) },
        { label: "Move to group", icon: "layers", hint: "▸", onClick: () => window.setTimeout(() => this.moveMenu(t, x, y), 0) },
        { sep: true },
        { label: "Close", icon: "x", hint: shortcutLabel("closeTab"), onClick: () => this.host.close(t) },
        { label: "Close others", disabled: all.length < 2, onClick: () => this.host.closeMany(all.filter((o) => o !== t && !this.isPinned(o))) },
        { label: grp ? `Close all in “${grp.label}”` : "Close all in group", disabled: !grp, onClick: () => this.host.closeMany(inGroup) },
      ],
      { minWidth: 210 },
    );
  }

  private moveMenu(t: TabPane, x: number, y: number): void {
    const cur = this.customOf(t);
    const groups = getSettings().tabs.customGroups;
    const items: MenuItem[] = groups.map((g) => ({ label: g.name, checked: cur?.id === g.id, onClick: () => this.dropInto(t, g.id) }));
    showMenu(
      x,
      y,
      [
        ...items,
        ...(items.length ? [{ sep: true }] : []),
        { label: "New group…", icon: "plus", onClick: () => void this.newGroup(t) },
        { label: "Remove from group", icon: "x", disabled: !cur, onClick: () => this.dropInto(t, null) },
      ],
      { minWidth: 200 },
    );
  }

  private customGroupMenu(g: CustomTabGroup, x: number, y: number): void {
    showMenu(
      x,
      y,
      [
        {
          label: "Rename…",
          icon: "pencil",
          onClick: async () => {
            const v = await promptDialog("Rename group", "Group name", g.name, "Rename");
            if (v) updateSettings((s) => s.tabs.customGroups.filter((x) => x.id === g.id).forEach((x) => (x.name = v)));
          },
        },
        { label: "Color", icon: "palette", hint: "▸", onClick: () => window.setTimeout(() => this.colorMenu(g, x, y), 0) },
        { sep: true },
        { label: "Delete group", icon: "trash", danger: true, onClick: () => updateSettings((s) => (s.tabs.customGroups = s.tabs.customGroups.filter((x) => x.id !== g.id))) },
      ],
      { minWidth: 180 },
    );
  }

  private colorMenu(g: CustomTabGroup, x: number, y: number): void {
    showMenu(
      x,
      y,
      CONN_COLORS.map((c) => ({ label: c, checked: g.color.toLowerCase() === c.toLowerCase(), onClick: () => updateSettings((s) => s.tabs.customGroups.filter((x) => x.id === g.id).forEach((x) => (x.color = c))) })),
      { minWidth: 150 },
    );
  }

  private openGroupMenu(): void {
    const r = this.groupBtn.getBoundingClientRect();
    const cur = getSettings().tabs.group;
    const opts: [TabGroup, string, string][] = [
      ["source", "Data source", ""],
      ["database", "Database", ""],
      ["kind", "Kind", "tables · consoles · topics"],
      ["custom", "My groups", "drag tabs in"],
      ["none", "None", "flat list"],
    ];
    showMenu(
      r.left,
      r.bottom + 6,
      opts.map(([v, label, hint]) => ({ label, hint, checked: cur === v, onClick: () => updateSettings((s) => (s.tabs.group = v)) })),
      { minWidth: Math.max(220, r.width) },
    );
  }

  private sortItems(): MenuItem[] {
    const cur = getSettings().tabs.sort;
    const opts: [TabSort, string, string][] = [
      ["manual", "Manual", "drag ⠿"],
      ["name", "Name A–Z", ""],
      ["recent", "Recently used", ""],
    ];
    return opts.map(([v, label, hint]) => ({ label, hint, checked: cur === v, onClick: () => updateSettings((s) => (s.tabs.sort = v)) }));
  }

  private openSortMenu(): void {
    const r = this.sortBtn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 6, this.sortItems(), { minWidth: Math.max(200, r.width) });
  }

  /** Top placement ⋯: sort, placement, close others, rename. */
  private openTabOptions(): void {
    const r = this.menuBtn.getBoundingClientRect();
    const p = this.placement;
    const active = this.host.active();
    const all = this.host.tabs();
    showMenu(
      r.right - 240,
      r.bottom + 8,
      [
        ...this.sortItems().map((i, k) => (k === 0 ? { ...i, label: "Manual (drag to reorder)", hint: "" } : k === 1 ? { ...i, label: "By name" } : i)),
        { sep: true },
        ...(["top", "left", "right"] as TabPlacement[]).map((v) => ({ label: `Tabs ${PLACE_NAMES[v]}`, checked: p === v, onClick: () => this.setPlacement(v) })),
        { sep: true },
        { label: "Close other tabs", disabled: !active || all.length < 2, onClick: () => active && this.host.closeMany(all.filter((o) => o !== active && !this.isPinned(o))) },
        { label: "Rename tab…", icon: "pencil", disabled: !active, onClick: () => active && window.setTimeout(() => this.rename(active), 0) },
      ],
      { minWidth: 240 },
    );
  }

  // ------------------------------------------------------------------ pin / groups

  togglePin(t: TabPane): void {
    const k = this.keyOf(t);
    updateSettings((s) => {
      const i = s.tabs.pinned.indexOf(k);
      if (i >= 0) s.tabs.pinned.splice(i, 1);
      else s.tabs.pinned.push(k);
    });
  }

  /** Moves the tab into a custom group (null = out of every group), optionally before / after another tab. */
  private dropInto(t: TabPane, groupId: string | null, target?: TabPane, after = false): void {
    const k = this.keyOf(t);
    const tk = target ? this.keyOf(target) : null;
    updateSettings((s) => {
      for (const g of s.tabs.customGroups) g.members = g.members.filter((m) => m !== k);
      const g = groupId ? s.tabs.customGroups.find((x) => x.id === groupId) : undefined;
      if (!g) return;
      const at = tk ? g.members.indexOf(tk) : -1;
      if (at >= 0) g.members.splice(at + (after ? 1 : 0), 0, k);
      else g.members.push(k);
    });
  }

  private async newGroup(t: TabPane | null): Promise<void> {
    const names = getSettings().tabs.customGroups.map((g) => g.name);
    const name = await promptDialog("New tab group", "Group name", "", "Create", [], { validate: (v) => (names.some((n) => n.toLowerCase() === v.toLowerCase()) ? "A group with that name exists" : null) });
    if (!name) return;
    const id = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const used = new Set(getSettings().tabs.customGroups.map((g) => g.color.toLowerCase()));
    const color = CONN_COLORS.find((c) => !used.has(c.toLowerCase())) ?? CONN_COLORS[names.length % CONN_COLORS.length];
    const k = t ? this.keyOf(t) : null;
    updateSettings((s) => {
      if (k) for (const g of s.tabs.customGroups) g.members = g.members.filter((m) => m !== k);
      s.tabs.customGroups.push({ id, name, color, members: k ? [k] : [] });
      s.tabs.group = "custom";
    });
  }

  // ------------------------------------------------------------------ drag & drop (manual sort)

  private bindDrag(el: HTMLElement, t: TabPane, section: string, axis: "x" | "y"): void {
    el.addEventListener("dragstart", (ev) => {
      if (this.editing) {
        ev.preventDefault();
        return;
      }
      this.drag = t;
      el.classList.add("dragging");
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData(DRAG_MIME, this.keyOf(t));
        ev.dataTransfer.setData("text/plain", this.nameOf(t));
      }
    });
    el.addEventListener("dragover", (ev) => {
      if (!this.drag || this.drag === t) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      const r = el.getBoundingClientRect();
      const after = axis === "x" ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
      this.clearDropMarks();
      el.classList.add(after ? "drop-after" : "drop-before");
    });
    el.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const d = this.drag;
      const after = el.classList.contains("drop-after");
      this.clearDropMarks();
      if (d && d !== t) this.dropOnTab(d, t, after, section);
    });
  }

  private clearDropMarks(): void {
    for (const el of [...this.railEl.querySelectorAll(".drop-before, .drop-after, .drop-into"), ...this.tabsEl.querySelectorAll(".drop-before, .drop-after")]) {
      el.classList.remove("drop-before", "drop-after", "drop-into");
    }
  }

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.clearDropMarks();
    for (const el of [...this.railEl.querySelectorAll(".dragging"), ...this.tabsEl.querySelectorAll(".dragging")]) el.classList.remove("dragging");
  }

  private dropOnTab(d: TabPane, target: TabPane, after: boolean, section: string): void {
    const dk = this.keyOf(d);
    const tk = this.keyOf(target);
    const targetPinned = this.isPinned(target);
    const dragPinned = this.isPinned(d);
    const intoPinned = section === "pinned" || (section === "top" && targetPinned);
    // manual order of the open tabs
    const order = this.host.tabs().filter((x) => x !== d);
    const ti = order.indexOf(target);
    order.splice(ti + (after ? 1 : 0), 0, d);
    this.host.setOrder(order);
    const mode = getSettings().tabs.group;
    updateSettings((s) => {
      const p = s.tabs.pinned;
      if (intoPinned) {
        const i = p.indexOf(dk);
        if (i >= 0) p.splice(i, 1);
        const at = p.indexOf(tk);
        p.splice(at < 0 ? p.length : at + (after ? 1 : 0), 0, dk);
        return;
      }
      if (dragPinned && section !== "top") s.tabs.pinned = p.filter((k) => k !== dk);
      if (mode === "custom" && section !== "top") {
        for (const g of s.tabs.customGroups) g.members = g.members.filter((m) => m !== dk);
        const g = s.tabs.customGroups.find((x) => x.id === section);
        if (g) {
          const at = g.members.indexOf(tk);
          g.members.splice(at < 0 ? g.members.length : at + (after ? 1 : 0), 0, dk);
        }
      }
    });
    this.render();
  }

  // ------------------------------------------------------------------ jump (⌘P) / all tabs list

  /** ⌘P: the rail's filter, or (tabs on top) the searchable list of every tab. */
  jump(): void {
    if (this.vertical) {
      this.railFilter.focus();
      this.railFilter.select();
    } else if (!this.closeAll) this.openAll(this.moreBtn.hidden ? this.menuBtn : this.moreBtn);
    else this.closeAll();
  }

  private toggleAll(): void {
    if (this.closeAll) this.closeAll();
    else this.openAll(this.moreBtn);
  }

  private openAll(anchor: HTMLElement): void {
    this.closeAll?.();
    const total = this.host.tabs().length;
    const input = h("input", { class: "all-search", type: "search", spellcheck: false, autocomplete: "off", placeholder: `Search ${total} tab${total === 1 ? "" : "s"}`, "aria-label": "Search all tabs" });
    const list = h("div", { class: "all-list", role: "listbox", "aria-label": "All tabs" });
    const pop = h("div", { class: "tabs-all", role: "dialog", "aria-label": "All tabs" }, h("label", { class: "all-field" }, icon("search", 12), input), list);
    let q = "";
    let sel = 0;
    let flat: TabPane[] = [];
    const draw = (): void => {
      clear(list);
      const saveQ = this.q;
      this.q = q;
      const items = this.host.tabs().filter((t) => this.matches(t));
      this.q = saveQ;
      const mode = getSettings().tabs.group;
      const groups = this.groups(items, mode).filter((g) => g.items.length > 0);
      flat = groups.flatMap((g) => g.items);
      if (sel >= flat.length) sel = Math.max(0, flat.length - 1);
      const active = this.host.active();
      for (const g of groups) {
        if (mode !== "none") list.append(h("div", { class: "all-group" }, h("span", { class: "rail-gdot", style: `--c:${g.color}` }), h("span", null, g.label), h("span", { class: "rail-gcount" }, String(g.items.length))));
        for (const t of g.items) {
          const i = flat.indexOf(t);
          const row = h(
            "button",
            { class: "all-row" + (t === active ? " active" : "") + (i === sel ? " sel" : "") + (mode === "none" ? " flat" : ""), type: "button", role: "option", "aria-selected": String(i === sel), title: fullPath(t) },
            h("span", { class: "all-name" + (t.kind === "key" || t.kind === "topic" || t.kind === "group" ? " mono" : "") }, this.nameOf(t)),
            this.isPinned(t) ? h("span", { class: "rt-pin" }, icon("pin", 11)) : null,
            this.hiddenTop.includes(t) ? null : h("span", { class: "all-shown", title: "Shown in the tab strip" }, "•"),
          );
          row.addEventListener("click", () => {
            close();
            this.host.activate(t);
          });
          list.append(row);
        }
      }
      if (flat.length === 0) list.append(h("div", { class: "rail-empty" }, q ? "No tab matches" : "No open tabs"));
      list.querySelector<HTMLElement>(".all-row.sel")?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => {
      q = input.value;
      sel = 0;
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (flat.length) sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length;
        draw();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const t = flat[sel];
        close();
        if (t) this.host.activate(t);
      }
    });
    const away = (e: Event): void => {
      if (e.target instanceof Node && (pop.contains(e.target) || anchor.contains(e.target))) return;
      close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        this.host.active()?.focus();
      }
    };
    const close = (): void => {
      if (this.closeAll !== close) return;
      this.closeAll = null;
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", onKey, true);
      pop.remove();
      this.moreBtn.classList.remove("on");
    };
    this.closeAll = close;
    const active = this.host.active();
    sel = 0;
    draw();
    if (active && flat.indexOf(active) > 0) {
      sel = flat.indexOf(active);
      draw();
    }
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.right - pw.width, window.innerWidth - pw.width - 8)) + "px";
    pop.style.top = Math.min(r.bottom + 8, window.innerHeight - pw.height - 8) + "px";
    this.moreBtn.classList.add("on");
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", onKey, true);
    input.focus();
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = preferences.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown): void {
  try {
    preferences.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full / disabled: names stay for this session */
  }
}

// Settings window (board I): sections Editor, Appearance, Results grid, Console tabs, Keymap, Data & history.
// Every control writes through updateSettings(), so changes apply instantly and are saved to settings.json.
import { api } from "../api";
import { confirmDialog } from "./confirm";
import { clear, errMsg, h } from "./dom";
import { HISTORY_CHANGED } from "./history";
import { toast } from "./toast";
import { ACTIONS, PRESETS, PRESET_LABELS, bindingOf, conflictFor, eventToBinding, formatBinding, setBinding } from "./keymap";
import type { ActionId } from "./keymap";
import { FONT_LABELS, FONT_STACKS, HIBERNATE_ROWS, IDLE_MINUTES, defaultSettings, effectiveTokenColors, getSettings, lineHeightPx, onSettingsChange, updateSettings } from "./settings";
import type { AppSettings, EditorFont, IdleMinutes, KeymapPreset, LineHeight, PageSize } from "./settings";
import { THEMES, TOKEN_KEYS, TOKEN_PALETTE } from "./themes";
import type { TokenKey } from "./themes";
import { buildAiSettings } from "./aiSettings";
import { buildSnippetSettings } from "./snippetSettings";
import { checkForUpdates, onUpdateState, updateState } from "./updates";

export type SettingsSection = "editor" | "appearance" | "results" | "tabs" | "keymap" | "data" | "ai" | "updates" | "snippets";

interface SectionDef {
  id: SettingsSection;
  label: string;
  short: string;
  color: string;
  sub: string;
}

const SECTIONS: SectionDef[] = [
  { id: "editor", label: "Editor", short: "Ed", color: "#ff3b5c", sub: "Font, size and color theme for SQL consoles" },
  { id: "appearance", label: "Appearance", short: "Ap", color: "#5e5ce6", sub: "Accent, glass and density" },
  { id: "results", label: "Results grid", short: "Rs", color: "#0a84ff", sub: "Paging, borders and value display" },
  { id: "tabs", label: "Console tabs", short: "Tb", color: "#ff9f0a", sub: "Placement, sorting and names" },
  { id: "keymap", label: "Keymap", short: "Km", color: "#30b0c7", sub: "Keyboard shortcuts" },
  { id: "snippets", label: "Snippets", short: "Sn", color: "#ff2d55", sub: "Abbreviations that expand into SQL" },
  { id: "data", label: "Data & history", short: "Dh", color: "#34c759", sub: "History, safety and reconnects" },
  { id: "updates", label: "Updates", short: "Up", color: "#64d2ff", sub: "Version, checking and installing updates" },
  { id: "ai", label: "AI assistant", short: "AI", color: "#bf5af2", sub: "Codex, Claude Code, API key or Ollama · what is sent" },
];

const ACCENTS: [string, string][] = [
  ["#FF1A3C", "Red"],
  ["#FF9F0A", "Orange"],
  ["#30D158", "Green"],
  ["#0A84FF", "Blue"],
  ["#BF5AF2", "Purple"],
  ["#8E8E93", "Graphite"],
];

interface Item {
  el: HTMLElement;
  /** Lower-case text the search box matches against. */
  text: string;
}

type Sync = () => void;

const SVG_SEARCH =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

export function openSettings(section?: SettingsSection): void {
  const existing = document.querySelector<HTMLElement>(".settings-dialog");
  if (existing) {
    (existing as HTMLElement & { _go?: (s: SettingsSection) => void })._go?.(section ?? "editor");
    return;
  }
  new SettingsWindow(section ?? "editor");
}

class SettingsWindow {
  private overlay: HTMLElement;
  private dlg: HTMLElement;
  private syncs: Sync[] = [];
  private sections = new Map<SettingsSection, { el: HTMLElement; items: Item[] }>();
  private cur: SettingsSection;
  private query = "";
  private navBtns = new Map<SettingsSection, HTMLButtonElement>();
  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private body: HTMLElement;
  private empty: HTMLElement;
  private recording: { id: ActionId; btn: HTMLButtonElement } | null = null;
  private hintEl: HTMLElement | null = null;
  private off: () => void;

  constructor(start: SettingsSection) {
    this.cur = start;
    this.overlay = h("div", { class: "overlay" });
    const search = h("input", {
      type: "search",
      placeholder: "Search settings",
      "aria-label": "Search settings",
      spellcheck: false,
      oninput: () => {
        this.query = search.value.trim().toLowerCase();
        this.render();
      },
    });
    const nav = h("nav", { class: "st-nav" }, h("div", { class: "st-title" }, "Settings"), h("label", { class: "st-search" }, this.svg(SVG_SEARCH), search));
    for (const s of SECTIONS) {
      const b = h("button", { class: "st-cat", type: "button", onclick: () => this.go(s.id) }, h("span", { class: "st-ic", style: `background:${s.color}` }, s.short), s.label);
      this.navBtns.set(s.id, b);
      nav.appendChild(b);
    }
    nav.appendChild(h("div", { class: "spacer" }));
    nav.appendChild(h("div", { class: "st-note" }, "Changes apply instantly and are saved to settings.json."));

    this.titleEl = h("span", { class: "st-h" });
    this.subEl = h("span", { class: "st-sub" });
    const reset = h("button", { class: "st-pill", type: "button", onclick: () => this.resetSection() }, "Reset section");
    const closeBtn = h("button", { class: "st-pill st-x", type: "button", "aria-label": "Close settings", onclick: () => this.close() }, "✕");
    const head = h("div", { class: "st-head" }, this.titleEl, this.subEl, h("div", { class: "spacer" }), reset, closeBtn);
    this.empty = h("div", { class: "st-empty", hidden: true }, "No settings match your search.");
    this.body = h("div", { class: "st-body" });
    this.dlg = h("div", { class: "dialog settings-dialog", role: "dialog", "aria-label": "Settings" }, nav, h("div", { class: "st-main" }, head, this.body));
    (this.dlg as HTMLElement & { _go?: (s: SettingsSection) => void })._go = (s) => this.go(s);
    this.overlay.appendChild(this.dlg);

    this.buildEditor();
    this.buildAppearance();
    this.buildResults();
    this.buildTabs();
    this.buildKeymap();
    this.buildData();
    this.buildUpdates();
    this.section("ai", buildAiSettings({
      row: (t, d, c, x) => this.row(t, d, c, x),
      toggle: (l, g, st) => this.toggle(l, g, st),
      textField: (l, g, st, m, w) => this.textField(l, g, st, m, w),
      onSync: (f) => this.syncs.push(f),
    }));
    this.section("snippets", buildSnippetSettings({
      row: (t, d, c, x) => this.row(t, d, c, x),
      toggle: (l, g, st) => this.toggle(l, g, st),
      onSync: (f) => this.syncs.push(f),
    }));
    for (const s of SECTIONS) {
      const sec = this.sections.get(s.id);
      if (sec) this.body.appendChild(sec.el);
    }
    this.body.appendChild(this.empty);

    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    window.addEventListener("keydown", this.onKey, true);
    this.off = onSettingsChange(() => this.sync());
    document.body.appendChild(this.overlay);
    this.render();
  }

  private svg(markup: string): HTMLElement {
    const s = h("span", { class: "st-svg" });
    s.innerHTML = markup;
    return s;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.recording) {
      this.recordKey(e);
      return;
    }
    if (e.key === "Escape") {
      // A confirm dialog opened from here handles its own Escape.
      const top = [...document.querySelectorAll(".overlay:not(.leaving)")].pop();
      if (top && top !== this.overlay) return;
      e.stopPropagation();
      e.preventDefault();
      this.close();
    }
  };

  private close(): void {
    window.removeEventListener("keydown", this.onKey, true);
    this.off();
    this.overlay.classList.add("leaving");
    window.setTimeout(() => this.overlay.remove(), 160);
  }

  private go(s: SettingsSection): void {
    this.cur = s;
    this.query = "";
    const input = this.overlay.querySelector<HTMLInputElement>(".st-search input");
    if (input) input.value = "";
    this.render();
  }

  private sync(): void {
    for (const f of this.syncs) f();
  }

  /** Shows the current section (or, while searching, every matching item of every section). */
  private render(): void {
    const q = this.query;
    let any = false;
    for (const s of SECTIONS) {
      const sec = this.sections.get(s.id);
      if (!sec) continue;
      let shown = 0;
      for (const it of sec.items) {
        const hit = !q || it.text.includes(q) || s.label.toLowerCase().includes(q);
        it.el.hidden = !hit;
        if (hit) shown++;
      }
      const visible = q ? shown > 0 : s.id === this.cur;
      sec.el.hidden = !visible;
      const label = sec.el.querySelector<HTMLElement>(".st-seclabel");
      if (label) label.hidden = !q;
      if (visible) any = true;
      this.navBtns.get(s.id)?.classList.toggle("on", !q && s.id === this.cur);
    }
    this.empty.hidden = any;
    const def = SECTIONS.find((x) => x.id === this.cur) ?? SECTIONS[0];
    this.titleEl.textContent = q ? "Search results" : def.label;
    this.subEl.textContent = q ? `“${this.query}”` : def.sub;
    this.body.scrollTop = 0;
    this.sync();
  }

  private resetSection(): void {
    const d = defaultSettings();
    const id = this.cur;
    updateSettings((s) => {
      if (id === "editor") s.editor = d.editor;
      else if (id === "appearance") s.appearance = d.appearance;
      else if (id === "results") s.results = d.results;
      else if (id === "keymap") s.keymap = d.keymap;
      else if (id === "data") s.data = d.data;
      else if (id === "ai") s.ai = d.ai;
      else if (id === "updates") s.updates = d.updates;
      else if (id === "snippets") s.snippets = d.snippets;
      else {
        s.tabs.placement = d.tabs.placement;
        s.tabs.sort = d.tabs.sort;
        s.tabs.group = d.tabs.group;
        s.tabs.naming = d.tabs.naming;
      }
    });
  }

  // ------------------------------------------------------------------ building blocks

  private section(id: SettingsSection, items: Item[]): void {
    const def = SECTIONS.find((x) => x.id === id) as SectionDef;
    const el = h("div", { class: "st-sec" }, h("div", { class: "st-seclabel", hidden: true }, def.label));
    for (const it of items) el.appendChild(it.el);
    this.sections.set(id, { el, items });
  }

  private seg<T extends string | number>(label: string, opts: [T, string][], get: () => T, set: (v: T) => void): HTMLElement {
    const btns = opts.map(([v, name]) => h("button", { class: "seg-btn", type: "button", role: "radio", onclick: () => set(v) }, name));
    const el = h("div", { class: "seg st-seg", role: "radiogroup", "aria-label": label }, btns);
    this.syncs.push(() =>
      opts.forEach(([v], i) => {
        btns[i].classList.toggle("on", get() === v);
        btns[i].setAttribute("aria-checked", String(get() === v));
      }),
    );
    return el;
  }

  private toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const b = h("button", { class: "sw", type: "button", role: "switch", "aria-label": label, onclick: () => set(!get()) });
    this.syncs.push(() => {
      b.classList.toggle("on", get());
      b.setAttribute("aria-checked", String(get()));
    });
    return b;
  }

  private row(title: string, desc: string, control: HTMLElement, extra = ""): Item {
    const el = h("div", { class: "st-row" }, h("div", { class: "st-row-text" }, h("div", { class: "st-row-title" }, title), h("div", { class: "st-row-desc" }, desc)), control);
    return { el, text: (title + " " + desc + " " + extra).toLowerCase() };
  }

  private textField(label: string, get: () => string, set: (v: string) => void, mono: boolean, width: number): HTMLInputElement {
    const inp = h("input", {
      class: "st-input" + (mono ? " mono" : ""),
      type: "text",
      spellcheck: false,
      "aria-label": label,
      style: `width:${width}px`,
      oninput: () => set(inp.value),
    });
    this.syncs.push(() => {
      if (document.activeElement !== inp) inp.value = get();
    });
    return inp;
  }

  private block(label: string, ...children: (Node | string)[]): HTMLElement {
    return h("div", { class: "st-block" }, h("span", { class: "st-label" }, label), ...children);
  }

  // ------------------------------------------------------------------ Editor

  private buildEditor(): void {
    const S = (): AppSettings => getSettings();
    const fonts = (Object.keys(FONT_LABELS) as EditorFont[]).map((f) => {
      const b = h("button", { class: "st-chipbtn", type: "button", style: `font-family:${FONT_STACKS[f]}`, onclick: () => updateSettings((s) => (s.editor.fontFamily = f)) }, FONT_LABELS[f]);
      this.syncs.push(() => b.classList.toggle("on", S().editor.fontFamily === f));
      return b;
    });
    const sizeEl = h("span", { class: "st-stepval" });
    this.syncs.push(() => (sizeEl.textContent = S().editor.fontSize + " px"));
    const step = (d: number): void => updateSettings((s) => (s.editor.fontSize = Math.max(11, Math.min(20, s.editor.fontSize + d))));
    const stepper = h("div", { class: "st-stepper" }, h("button", { type: "button", "aria-label": "Smaller", onclick: () => step(-1) }, "−"), sizeEl, h("button", { type: "button", "aria-label": "Larger", onclick: () => step(1) }, "+"));
    const lh = this.seg<LineHeight>("Line height", [["tight", "Tight"], ["normal", "Normal"], ["loose", "Loose"]], () => S().editor.lineHeight, (v) => updateSettings((s) => (s.editor.lineHeight = v)));
    const lig = this.toggle("Ligatures", () => S().editor.ligatures, (v) => updateSettings((s) => (s.editor.ligatures = v)));
    const top = h(
      "div",
      { class: "st-fonts" },
      this.block("Font", h("div", { class: "st-wrap" }, fonts)),
      h("div", { class: "st-fonts-r" }, this.block("Size", stepper), this.block("Line height", lh), this.block("Ligatures", lig)),
    );

    // themes
    const themeBtns = THEMES.map((t) => {
      const chips = (["keyword", "string", "number", "type"] as TokenKey[]).map((k) => h("span", { class: "st-chip", style: `background:${t.colors[k]}` }));
      const b = h("button", { class: "st-theme", type: "button", title: t.name, onclick: () => updateSettings((s) => {
        s.editor.colorTheme = t.id;
        s.editor.tokenColors = {};
      }) }, h("span", { class: "st-chips" }, chips), h("span", { class: "st-theme-name" }, t.name));
      this.syncs.push(() => b.classList.toggle("on", S().editor.colorTheme === t.id));
      return b;
    });
    const themes = this.block(
      "Text colors · " + THEMES.length + " presets · background stays the app’s glass",
      h("div", { class: "st-themes" }, themeBtns),
    );

    // per-token colors
    let editing: TokenKey | null = null;
    const resetBtn = h("button", { class: "st-link", type: "button", onclick: () => updateSettings((s) => (s.editor.tokenColors = {})) });
    const tokRows = TOKEN_KEYS.map(({ key, label }) => {
      const sw = h("button", { class: "st-tokswatch", type: "button", "aria-label": `Edit ${label} color`, onclick: () => {
        editing = editing === key ? null : key;
        this.sync();
      } });
      const hex = h("span", { class: "st-hex mono" });
      const custom = h("span", { class: "st-custom" });
      const pal = h("span", { class: "st-pal" });
      const swatches = TOKEN_PALETTE.map((c) => h("button", { class: "st-dot", type: "button", "aria-label": c, style: `background:${c}`, onclick: () => {
        updateSettings((s) => (s.editor.tokenColors[key] = c));
        editing = null;
        this.sync();
      } }));
      const picker = h("input", { class: "st-colorinput", type: "color", "aria-label": `Custom ${label} color`, oninput: () => updateSettings((s) => (s.editor.tokenColors[key] = picker.value)) });
      pal.append(...swatches, picker);
      const row = h("div", { class: "st-tok" }, sw, h("span", { class: "st-tokname" }, label), pal, hex, custom);
      this.syncs.push(() => {
        const c = effectiveTokenColors(S())[key];
        sw.style.background = c;
        hex.textContent = c;
        custom.textContent = S().editor.tokenColors[key] ? "custom" : "";
        pal.hidden = editing !== key;
        hex.hidden = custom.hidden = editing === key;
        row.classList.toggle("open", editing === key);
        swatches.forEach((d, i) => d.classList.toggle("on", TOKEN_PALETTE[i].toLowerCase() === c.toLowerCase()));
        if (editing === key && /^#[0-9a-f]{6}$/i.test(c)) picker.value = c.toLowerCase();
      });
      return row;
    });
    this.syncs.push(() => {
      const n = Object.keys(S().editor.tokenColors).length;
      resetBtn.textContent = n ? `Reset ${n} custom` : "";
      resetBtn.hidden = n === 0;
    });
    const custom = h("div", { class: "st-customize" }, h("div", { class: "st-customhead" }, h("span", { class: "st-label" }, "Customize each color"), h("div", { class: "spacer" }), resetBtn), h("div", { class: "st-toks" }, tokRows));

    // preview
    const pv = h("div", { class: "st-preview" });
    const SRC = [
      "-- Revenue by country, last 30 days",
      "SELECT u.country,",
      "       COUNT(*)     AS orders,",
      "       SUM(o.total) AS revenue",
      "FROM shop.public.orders o",
      "JOIN shop.public.users u ON u.id = o.user_id",
      "WHERE o.status = 'paid' AND o.created_at > now() - INTERVAL '30 days'",
      "GROUP BY u.country",
      "ORDER BY revenue DESC",
      "LIMIT 20;",
    ];
    this.syncs.push(() => {
      const s = S();
      const tc = effectiveTokenColors(s);
      pv.style.fontFamily = FONT_STACKS[s.editor.fontFamily];
      pv.style.fontSize = s.editor.fontSize + "px";
      pv.style.lineHeight = lineHeightPx(s.editor.fontSize, s.editor.lineHeight) + "px";
      pv.style.fontVariantLigatures = s.editor.ligatures ? "normal" : "none";
      clear(pv);
      SRC.forEach((line, i) => {
        const l = h("div", { class: "st-pvline" }, h("span", { class: "st-pvnum" }, String(i + 1)));
        for (const seg of highlightLine(line, tc)) l.appendChild(h("span", { style: `color:${seg.c}` }, seg.t));
        pv.appendChild(l);
      });
    });
    const left = h("div", { class: "st-col" }, themes, custom);
    const right = h("div", { class: "st-col" }, this.block("Preview", pv));
    const lower = h("div", { class: "st-twocol" }, left, right);

    this.section("editor", [
      { el: top, text: "font typeface size line height ligatures jetbrains fira cascadia" },
      { el: lower, text: "text colors themes presets color customize preview syntax keyword string number comment darcula dracula nord monokai" },
    ]);
  }

  // ------------------------------------------------------------------ Appearance

  private buildAppearance(): void {
    const S = (): AppSettings => getSettings();
    const dots = ACCENTS.map(([c, name]) => {
      const b = h("button", { class: "st-accent", type: "button", "aria-label": name, style: `background:${c};--ring:${c}`, onclick: () => updateSettings((s) => (s.appearance.accent = c)) });
      this.syncs.push(() => b.classList.toggle("on", S().appearance.accent.toLowerCase() === c.toLowerCase()));
      return b;
    });
    const picker = h("input", { class: "st-colorinput", type: "color", "aria-label": "Custom accent color", oninput: () => updateSettings((s) => (s.appearance.accent = picker.value.toUpperCase())) });
    this.syncs.push(() => (picker.value = S().appearance.accent.toLowerCase()));
    const accent = this.row("Accent color", "Buttons, selection, caret and focus rings", h("div", { class: "st-accents" }, dots, picker));

    const range = h("input", { type: "range", min: "0", max: "100", "aria-label": "Ambient glow", class: "st-range", oninput: () => updateSettings((s) => (s.appearance.glow = Number(range.value))) });
    this.syncs.push(() => {
      if (document.activeElement !== range) range.value = String(S().appearance.glow);
    });
    const glow = this.row("Ambient glow", "Strength of the soft color behind the glass", range);

    const ui = this.row("Interface size", "Sidebar, tabs and menus", this.seg("Interface size", [["s", "Small"], ["m", "Medium"], ["l", "Large"]], () => S().appearance.uiSize, (v) => updateSettings((s) => (s.appearance.uiSize = v))));
    const reduce = this.row("Reduce transparency", "Solid panels instead of glass (faster on older GPUs)", this.toggle("Reduce transparency", () => S().appearance.reduceTransparency, (v) => updateSettings((s) => (s.appearance.reduceTransparency = v))));
    const dens = this.row("Tree density", "Row height in the database explorer", this.seg("Tree density", [["compact", "Compact"], ["comfortable", "Comfortable"]], () => S().appearance.density, (v) => updateSettings((s) => (s.appearance.density = v))));
    this.section("appearance", [accent, glow, ui, reduce, dens]);
  }

  // ------------------------------------------------------------------ Results grid

  private buildResults(): void {
    const S = (): AppSettings => getSettings();
    const ps = this.row(
      "Page size",
      "Rows fetched per page; use the pager to load the next page",
      this.seg<PageSize>("Page size", [[100, "100"], [500, "500"], [1000, "1,000"], [0, "All"]], () => S().results.pageSize, (v) => updateSettings((s) => (s.results.pageSize = v))),
      "pagination paging rows",
    );
    const borders = this.row("Grid borders", "Hairlines between rows and columns", this.toggle("Grid borders", () => S().results.borders, (v) => updateSettings((s) => (s.results.borders = v))));
    const sample = h("span", { class: "st-sample mono" }, h("span", { class: "k-num" }, "42.5"), " ", h("span", { class: "k-date" }, "2026-11-26"), " ", h("span", {}, "text"), " ", h("span", { class: "k-bool" }, "true"), " ", h("span", { class: "k-key" }, "#1037"), " ", h("span", { class: "k-null" }, "NULL"));
    const types = this.row(
      "Color values by type",
      "Numbers, dates, text, booleans, keys and NULL each get their own color",
      h("div", { class: "st-ctl" }, sample, this.toggle("Color values by type", () => S().results.typeColors, (v) => updateSettings((s) => (s.results.typeColors = v)))),
    );
    const count = this.row("Count total rows", "Runs COUNT(*) in the background so the pager shows “of 12,431”", this.toggle("Count total rows", () => S().results.countRows, (v) => updateSettings((s) => (s.results.countRows = v))));
    const nul = this.row("NULL is shown as", "Text for NULL cells (dimmed)", this.textField("NULL text", () => S().results.nullText, (v) => updateSettings((s) => (s.results.nullText = v)), true, 120));
    const maxw = h("input", {
      class: "st-input",
      type: "number",
      min: "80",
      max: "1200",
      step: "10",
      "aria-label": "Max column width",
      style: "width:100px",
      onchange: () => updateSettings((s) => (s.results.maxColWidth = Number(maxw.value) || 320)),
    });
    this.syncs.push(() => {
      if (document.activeElement !== maxw) maxw.value = String(S().results.maxColWidth);
    });
    const mw = this.row("Max column width", "Longer values are truncated (in px); open a cell to see all", maxw);
    this.section("results", [ps, borders, types, count, nul, mw]);
  }

  // ------------------------------------------------------------------ Console tabs

  private buildTabs(): void {
    const S = (): AppSettings => getSettings();
    const place = this.row("Tab placement", "Where console tabs live", this.seg("Tab placement", [["top", "Top"], ["left", "Left"], ["right", "Right"]], () => S().tabs.placement, (v) => updateSettings((s) => (s.tabs.placement = v))));
    const sort = this.row("Sort tabs", "Manual keeps the order you drag them into", this.seg("Sort tabs", [["manual", "Manual"], ["name", "Name"], ["recent", "Recently used"]], () => S().tabs.sort, (v) => updateSettings((s) => (s.tabs.sort = v))));
    const group = this.row(
      "Group tabs by",
      "How tabs are grouped when there are many; custom groups are created from a tab’s menu",
      this.seg("Group tabs", [["source", "Data source"], ["database", "Database"], ["kind", "Kind"], ["custom", "Custom"], ["none", "None"]], () => S().tabs.group, (v) => updateSettings((s) => (s.tabs.group = v))),
    );
    const names: ["table" | "source" | "classic", string, string, string][] = [
      ["table", "table · database  [source]", "orders · shop", "Prod PG"],
      ["source", "source / database", "Prod PG / shop", ""],
      ["classic", "Console N (classic)", "Console 3", ""],
    ];
    const opts = names.map(([id, name, ex, src]) => {
      const b = h("button", { class: "st-radio", type: "button", role: "radio", onclick: () => updateSettings((s) => (s.tabs.naming = id)) }, h("span", { class: "st-dotr" }), h("span", { class: "st-radio-name" }, name), h("span", { class: "st-ex" }, ex, src ? h("span", { class: "st-ex-src" }, src) : null));
      this.syncs.push(() => {
        b.classList.toggle("on", S().tabs.naming === id);
        b.setAttribute("aria-checked", String(S().tabs.naming === id));
      });
      return b;
    });
    const naming: Item = {
      el: h("div", { class: "st-row col" }, h("div", { class: "st-row-title" }, "Tab names"), h("div", { class: "st-row-desc" }, "How new consoles are titled. Rename any tab with a double-click."), h("div", { class: "st-radios", role: "radiogroup", "aria-label": "Tab names" }, opts)),
      text: "tab names naming titles console table database source classic",
    };
    this.section("tabs", [place, sort, group, naming]);
  }

  // ------------------------------------------------------------------ Keymap

  private buildKeymap(): void {
    const S = (): AppSettings => getSettings();
    const preset = this.seg<KeymapPreset>("Keymap preset", (Object.keys(PRESET_LABELS) as KeymapPreset[]).map((p) => [p, PRESET_LABELS[p]] as [KeymapPreset, string]), () => S().keymap.preset, (v) =>
      updateSettings((s) => {
        s.keymap.preset = v;
        s.keymap.overrides = {};
      }),
    );
    this.hintEl = h("span", { class: "st-hint" }, "Click a shortcut, then press the new keys · Esc cancels · ⌫ resets · Del unbinds");
    const head: Item = { el: h("div", { class: "st-keyhead" }, h("span", { class: "st-label" }, "Preset"), preset, h("div", { class: "spacer" }), this.hintEl), text: "keymap preset shortcuts keyboard datagrip vscode" };

    const rows = ACTIONS.map((a) => {
      const btn = h("button", { class: "st-key mono", type: "button", onclick: () => this.startRecording(a.id, btn) });
      const custom = h("span", { class: "st-custom" });
      const row = h("div", { class: "st-keyrow" }, h("span", { class: "st-keyname" }, a.name), custom, btn);
      this.syncs.push(() => {
        if (this.recording && this.recording.id === a.id) return;
        const b = bindingOf(a.id);
        btn.textContent = b ? formatBinding(b) : "—";
        btn.classList.toggle("unbound", !b);
        const isCustom = a.id in S().keymap.overrides;
        custom.textContent = isCustom ? "custom" : "";
        const dup = b ? conflictFor(a.id, b) : null;
        row.classList.toggle("conflict", dup !== null);
        const dupName = dup ? ACTIONS.find((x) => x.id === dup)?.name : "";
        btn.title = dup ? `Also used by “${dupName}”` : PRESETS[S().keymap.preset][a.id] === b ? "" : "Default: " + (formatBinding(PRESETS[S().keymap.preset][a.id]) || "none");
      });
      return row;
    });
    const grid: Item = { el: h("div", { class: "st-keys" }, rows), text: ACTIONS.map((a) => a.name).join(" ").toLowerCase() + " shortcut key binding" };
    this.section("keymap", [head, grid]);
  }

  private startRecording(id: ActionId, btn: HTMLButtonElement): void {
    if (this.recording) this.stopRecording();
    this.recording = { id, btn };
    btn.classList.add("recording");
    btn.textContent = "Press keys…";
  }

  private stopRecording(): void {
    const r = this.recording;
    this.recording = null;
    r?.btn.classList.remove("recording");
    this.sync();
  }

  private recordKey(e: KeyboardEvent): void {
    const r = this.recording;
    if (!r) return;
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return this.stopRecording();
    if (e.key === "Backspace" && !(e.metaKey || e.ctrlKey || e.altKey)) {
      this.stopRecording();
      setBinding(r.id, null);
      return;
    }
    if (e.key === "Delete" && !(e.metaKey || e.ctrlKey || e.altKey)) {
      this.stopRecording();
      setBinding(r.id, "");
      return;
    }
    const b = eventToBinding(e);
    if (!b) return;
    if (!/^(Mod|Ctrl|Alt|Meta)-/.test(b) && !/^(Shift-)?F\d+$/.test(b)) {
      if (this.hintEl) this.hintEl.textContent = "Add a modifier key (⌘/Ctrl, ⌥/Alt or ⌃) to the shortcut.";
      return;
    }
    this.stopRecording();
    if (this.hintEl) this.hintEl.textContent = "Click a shortcut, then press the new keys · Esc cancels · ⌫ resets · Del unbinds";
    setBinding(r.id, b);
  }

  // ------------------------------------------------------------------ Data & history

  private buildData(): void {
    const S = (): AppSettings => getSettings();
    const keep = this.row("Keep query history for", "Searchable from the History panel", this.seg<number>("History", [[30, "30 days"], [90, "90 days"], [365, "1 year"], [0, "Forever"]], () => S().data.historyDays, (v) => updateSettings((s) => (s.data.historyDays = v as 30 | 90 | 365 | 0))));
    const restore = this.row("Restore consoles on launch", "Reopen tabs in their order with their text and cursor; data sources connect when a tab is used", this.toggle("Restore consoles", () => S().data.restoreConsoles, (v) => updateSettings((s) => (s.data.restoreConsoles = v))));
    const confirm = this.row("Confirm risky statements", "Ask before UPDATE or DELETE without WHERE, DROP, TRUNCATE", this.toggle("Confirm risky statements", () => S().data.confirmRisky, (v) => updateSettings((s) => (s.data.confirmRisky = v))));
    const auto = this.row("Auto-reconnect", "Reconnect silently when a connection drops or Vault credentials expire", this.toggle("Auto-reconnect", () => S().data.autoReconnect, (v) => updateSettings((s) => (s.data.autoReconnect = v))));
    // v0.15: idle disconnect (a small select)
    const idleSel = h("select", { class: "st-input st-select", "aria-label": "Disconnect idle consoles after" });
    for (const m of IDLE_MINUTES) idleSel.appendChild(h("option", { value: String(m) }, m === 0 ? "Never" : m >= 60 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`));
    idleSel.addEventListener("change", () => updateSettings((s) => (s.data.idleDisconnectMinutes = Number(idleSel.value) as IdleMinutes)));
    this.syncs.push(() => (idleSel.value = String(S().data.idleDisconnectMinutes)));
    const idle = this.row("Disconnect idle consoles after", "Closes a console’s database session when it sat unused (never during a transaction or a running query); the next run reconnects silently", idleSel, "idle timeout session close disconnect");
    // v0.17: hidden consoles beyond the 10 most recent drop their result rows above this many (0 = never)
    const hibSel = h("select", { class: "st-input st-select", "aria-label": "Release hidden results above" });
    const hibLabel = (n: number): string => (n === 0 ? "Never" : `${n.toLocaleString()} rows`);
    for (const n of HIBERNATE_ROWS) hibSel.appendChild(h("option", { value: String(n) }, hibLabel(n)));
    hibSel.addEventListener("change", () => updateSettings((s) => (s.data.hibernateResultRows = Number(hibSel.value))));
    this.syncs.push(() => {
      const v = S().data.hibernateResultRows;
      if (!HIBERNATE_ROWS.includes(v) && !hibSel.querySelector(`option[value="${v}"]`)) hibSel.appendChild(h("option", { value: String(v) }, hibLabel(v)));
      hibSel.value = String(v);
    });
    const hib = this.row("Release hidden results above", "Consoles you haven't used among the last 10 free their result grids; above this many rows per console the rows are dropped too and come back with Run again", hibSel, "memory hibernate release results rows consoles");
    const clearBtn = h("button", { class: "st-pill", type: "button", onclick: () => void this.clearHistory(clearBtn) }, "Clear history…");
    const wipe = this.row("Clear query history", "Delete every entry of every data source from the History panel", clearBtn, "delete remove history");
    this.section("data", [keep, restore, confirm, auto, idle, hib, wipe]);
  }

  // ------------------------------------------------------------------ Updates

  private buildUpdates(): void {
    const S = (): AppSettings => getSettings();
    const ver = h("div", { class: "st-row-title" });
    const line = h("div", { class: "st-row-desc" });
    const btn = h("button", { class: "st-pill", type: "button", onclick: () => void checkForUpdates(true) }, "Check for updates");
    const head: Item = { el: h("div", { class: "st-row" }, h("div", { class: "st-row-text" }, ver, line), btn), text: "version check for updates now" };
    const paint = (): void => {
      const u = updateState();
      ver.textContent = `DataTrip ${u.status?.currentVersion ?? ""}`;
      btn.disabled = !u.status?.configured || u.phase === "checking" || u.phase === "downloading";
      btn.textContent = u.phase === "checking" ? "Checking…" : "Check for updates";
      if (!u.status?.configured) line.textContent = "Updates aren't set up for this build (it has no update signing key).";
      else if (u.phase === "available" || u.phase === "downloading") line.textContent = `${u.info?.version} is available — see the card in the corner`;
      else if (u.phase === "ready") line.textContent = `${u.info?.version} is downloaded — restart to finish`;
      else if (u.phase === "error") line.textContent = `Last check failed: ${u.error}`;
      else if (u.lastCheck) line.textContent = `Last checked ${new Date(u.lastCheck).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · you're up to date`;
      else line.textContent = "Not checked yet";
    };
    onUpdateState(paint);
    this.syncs.push(paint);
    const auto = this.row("Check for updates automatically", "On launch and once a day while DataTrip is open", this.toggle("Check automatically", () => S().updates.auto, (v) => updateSettings((s) => (s.updates.auto = v))));
    const bg = this.row("Download updates in the background", "Then only a restart is needed; off = ask first", this.toggle("Download in the background", () => S().updates.background, (v) => updateSettings((s) => (s.updates.background = v))));
    const pre = this.row("Include pre-releases", "Get beta versions before they are final", this.toggle("Include pre-releases", () => S().updates.prerelease, (v) => updateSettings((s) => (s.updates.prerelease = v))));
    const note: Item = {
      el: h("div", { class: "st-row-desc st-upd-note" }, "Updates come from DataTrip's GitHub releases and are verified with its signing key before they are installed. Also in Help › Check for updates… and the command palette."),
      text: "github releases signing key",
    };
    this.section("updates", [head, auto, bg, pre, note]);
  }

  private async clearHistory(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      let n: number | null = null;
      try {
        n = await api.countHistory(null);
      } catch {
        n = null;
      }
      if (n === 0) {
        toast("Query history is already empty", "info");
        return;
      }
      const what = n === null ? "Every query in the history" : `All ${n.toLocaleString()} ${n === 1 ? "query" : "queries"} in the history`;
      const ok = await confirmDialog("Clear query history?", `${what} will be deleted for every data source. This can't be undone.`, "Clear history", true);
      if (!ok) return;
      const deleted = await api.clearHistory(null);
      window.dispatchEvent(new CustomEvent(HISTORY_CHANGED));
      toast(`Deleted ${deleted.toLocaleString()} history ${deleted === 1 ? "entry" : "entries"}`, "ok");
    } catch (e) {
      toast(`Could not clear history: ${errMsg(e)}`, "error");
    } finally {
      btn.disabled = false;
    }
  }
}

// ---- preview highlighter (same tokenizer as the board)

const KW = /^(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|ORDER|BY|GROUP|LIMIT|AS|DESC|ASC|INSERT|INTO|VALUES|UPDATE|SET|WITH|IN|NOT|NULL|IS|HAVING|DISTINCT|INTERVAL|BETWEEN)$/i;
const FN = /^(COUNT|SUM|AVG|MIN|MAX|NOW|COALESCE)$/i;

function highlightLine(src: string, tc: Record<TokenKey, string>): { t: string; c: string }[] {
  const out: { t: string; c: string }[] = [];
  const re = /(--.*$)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let c = tc.text;
    if (m[1]) c = tc.comment;
    else if (m[2]) c = tc.string;
    else if (m[3]) c = tc.number;
    else if (m[4]) c = FN.test(m[4]) ? tc.type : KW.test(m[4]) ? tc.keyword : tc.text;
    else if (m[6]) c = tc.punct;
    out.push({ t: m[0], c });
  }
  return out;
}

// Command palette (⌘K / Ctrl+K): every action with its shortcut, plus data sources, tables (from the explorer's
// already-loaded metadata) and open tabs. Fuzzy filter, ↑↓ to move, ↵ to run, Esc to close.
import { clear, h, icon } from "./dom";

export type PaletteGroup = "Actions" | "Data sources" | "Tables" | "Open tabs" | "Recent files";

export interface PaletteItem {
  group: PaletteGroup;
  label: string;
  /** Secondary text after the label (table path, driver…). */
  detail?: string;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string;
  /** Icon name (dom.ts icons). */
  icon?: string;
  /** Extra words that match the filter (not shown). */
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

const GROUP_ORDER: PaletteGroup[] = ["Actions", "Data sources", "Open tabs", "Recent files", "Tables"];
/** Rows per group: without a query tables stay short; with one, enough to scroll. */
const LIMIT_EMPTY: Record<PaletteGroup, number> = { Actions: 60, "Data sources": 12, "Open tabs": 12, "Recent files": 5, Tables: 8 };
const LIMIT_QUERY: Record<PaletteGroup, number> = { Actions: 30, "Data sources": 20, "Open tabs": 20, "Recent files": 10, Tables: 60 };

/**
 * Fuzzy score of `text` for query `q` (both lower case): every query character must appear in order. Higher is
 * better: contiguous runs, word starts and an early first hit count; a plain substring wins outright. -1 = no match.
 */
export function fuzzyScore(text: string, q: string): number {
  if (!q) return 0;
  const sub = text.indexOf(q);
  if (sub >= 0) return 1000 - sub * 2 - (text.length - q.length) * 0.1 + (sub === 0 || /[\s._\-/·(]/.test(text[sub - 1] ?? " ") ? 200 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = text.indexOf(ch, ti);
    if (i < 0) return -1;
    if (i === prev + 1) score += 8;
    if (i === 0 || /[\s._\-/·(]/.test(text[i - 1])) score += 6;
    score -= Math.min(i - ti, 10) * 0.5;
    prev = i;
    ti = i + 1;
  }
  return score;
}

let openEl: HTMLElement | null = null;

export function isPaletteOpen(): boolean {
  return openEl !== null;
}

/** Opens the palette over the app; `items` is read once (call again to refresh). */
export function openPalette(items: PaletteItem[], placeholder = "Type a command, table or data source…"): void {
  if (openEl) {
    openEl.querySelector<HTMLInputElement>("input")?.focus();
    return;
  }
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = h("input", { class: "pal-input", type: "text", placeholder, spellcheck: false, autocomplete: "off", "aria-label": "Search commands", role: "combobox", "aria-expanded": "true", "aria-controls": "dt-palette-list" });
  const list = h("div", { class: "pal-list", id: "dt-palette-list", role: "listbox", "aria-label": "Commands" });
  const overlay = h(
    "div",
    { class: "overlay pal-overlay" },
    h(
      "div",
      { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" },
      h("label", { class: "pal-search" }, icon("search", 16), input),
      list,
      h("div", { class: "pal-foot" }, h("span", null, "↑↓ move"), h("span", null, "↵ run"), h("span", null, "esc close"), h("span", { class: "spacer" }), h("span", null, "Every action, with its shortcut")),
    ),
  );
  let shown: PaletteItem[] = [];
  let sel = 0;
  const rows: HTMLElement[] = [];

  const close = (refocus: boolean): void => {
    if (!openEl) return;
    window.removeEventListener("keydown", onKey, true);
    openEl = null;
    overlay.classList.add("leaving");
    window.setTimeout(() => overlay.remove(), 140);
    if (refocus && restoreFocus?.isConnected) restoreFocus.focus();
  };
  const run = (it: PaletteItem | undefined): void => {
    if (!it || it.disabled) return;
    close(true);
    // After the overlay is gone, so the action's own dialogs and focus win.
    window.setTimeout(() => it.run(), 0);
  };
  const paintSel = (): void => {
    rows.forEach((r, i) => {
      r.classList.toggle("on", i === sel);
      r.setAttribute("aria-selected", String(i === sel));
    });
    const r = rows[sel];
    if (r) {
      input.setAttribute("aria-activedescendant", r.id);
      r.scrollIntoView({ block: "nearest" });
    }
  };
  const render = (): void => {
    const q = input.value.trim().toLowerCase();
    const groups = new Map<PaletteGroup, { it: PaletteItem; s: number }[]>();
    for (const it of items) {
      const hay = `${it.label} ${it.detail ?? ""} ${it.keywords ?? ""}`.toLowerCase();
      const s = q ? Math.max(fuzzyScore(it.label.toLowerCase(), q) + 50, fuzzyScore(hay, q)) : 0;
      if (q && s < 0) continue;
      const g = groups.get(it.group) ?? [];
      g.push({ it, s });
      groups.set(it.group, g);
    }
    clear(list);
    rows.length = 0;
    shown = [];
    // With a query the best-scoring group comes first.
    const order = [...GROUP_ORDER];
    if (q) order.sort((a, b) => Math.max(-1, ...(groups.get(b) ?? []).map((x) => x.s)) - Math.max(-1, ...(groups.get(a) ?? []).map((x) => x.s)));
    for (const g of order) {
      const entries = groups.get(g);
      if (!entries || !entries.length) continue;
      if (q) entries.sort((a, b) => b.s - a.s);
      const lim = (q ? LIMIT_QUERY : LIMIT_EMPTY)[g];
      list.appendChild(h("div", { class: "pal-group", role: "presentation" }, g, entries.length > lim ? h("span", { class: "pal-more" }, `${lim} of ${entries.length}`) : null));
      for (const { it } of entries.slice(0, lim)) {
        const idx = shown.length;
        const row = h(
          "div",
          { class: "pal-row" + (it.disabled ? " disabled" : ""), role: "option", id: `dt-pal-${idx}`, "aria-disabled": it.disabled ? "true" : undefined },
          icon(it.icon ?? "chevron", 15),
          h("span", { class: "pal-label" }, it.label, it.detail ? h("span", { class: "pal-detail" }, it.detail) : null),
          it.hint ? h("span", { class: "pal-hint" }, it.hint) : null,
        );
        row.addEventListener("pointermove", () => {
          if (sel !== idx) {
            sel = idx;
            paintSel();
          }
        });
        row.addEventListener("click", () => run(it));
        rows.push(row);
        shown.push(it);
        list.appendChild(row);
      }
    }
    if (!shown.length) list.appendChild(h("div", { class: "pal-empty" }, "Nothing matches."));
    sel = 0;
    paintSel();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!shown.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      paintSel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      run(shown[sel]);
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };
  input.addEventListener("input", render);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close(true);
  });
  document.body.appendChild(overlay);
  openEl = overlay;
  window.addEventListener("keydown", onKey, true);
  render();
  input.focus();
}

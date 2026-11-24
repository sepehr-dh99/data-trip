// Built-in icon + color set for folders and data sources (explorer, navigator, switchers, dialogs).
import type { ConnectionConfig } from "../types";
import { connColor } from "./sqlutil";

/** [name, SVG path] on a 24px grid, drawn with a 2px round stroke. */
export const ICONS: [string, string][] = [
  ["database", "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"],
  ["server", "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01"],
  ["cloud", "M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z"],
  ["globe", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"],
  ["lock", "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3"],
  ["shield", "M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7z"],
  ["rocket", "M5 15c-1 1-1.5 3.5-1.5 4.5 1 0 3.5-.5 4.5-1.5M9 15l-3-3 3-5c3-4 7-4.5 11-4.5 0 4-.5 8-4.5 11l-5 3zM15 9h.01"],
  ["flask", "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"],
  ["bug", "M8 9h8v6a4 4 0 0 1-8 0zM12 9V6M9 6a3 3 0 0 1 6 0M4 12h4M16 12h4M5 18l3-2M19 18l-3-2M5 7l3 2M19 7l-3 2"],
  ["wrench", "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.8-.7-.7-2.8z"],
  ["chart", "M4 20V10M10 20V4M16 20v-7M22 20H2"],
  ["cart", "M3 4h2l2.5 11h11L21 8H6.5M9 20h.01M17 20h.01"],
  ["card", "M3 6h18v12H3zM3 10h18M7 15h3"],
  ["users", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6"],
  ["mail", "M3 6h18v12H3zM3 7l9 6 9-6"],
  ["bolt", "M13 2 4 14h7l-1 8 9-12h-7z"],
  ["leaf", "M5 21c0-9 5-14 16-16-1 11-6 16-14 16M5 21l7-7"],
  ["box", "M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"],
  ["layers", "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17l10 5 10-5"],
  ["star", "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"],
  ["flag", "M5 21V4M5 4h11l-2 4 2 4H5"],
  ["home", "M3 11 12 4l9 7M5 10v10h14V10"],
  ["briefcase", "M3 7h18v12H3zM9 7V5h6v2M3 12h18"],
  ["map", "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14"],
  ["terminal", "M3 5h18v14H3zM7 9l3 3-3 3M13 15h4"],
  ["key", "M15 7a4 4 0 1 1-3.5 6L5 19.5V22H2v-3l6.5-6.5A4 4 0 0 1 15 7zM16 8h.01"],
  ["cpu", "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"],
  ["folder", "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
];
export const ICON_PATHS: Record<string, string> = Object.fromEntries(ICONS);
export const FOLDER_ICON = "folder";

/** [name, hex] swatches offered by the Color & icon picker. */
export const COLORS: [string, string][] = [
  ["Red", "#FF453A"],
  ["Orange", "#FF9F0A"],
  ["Yellow", "#FFD60A"],
  ["Green", "#30D158"],
  ["Mint", "#63E6BE"],
  ["Teal", "#40C8E0"],
  ["Blue", "#0A84FF"],
  ["Indigo", "#5E5CE6"],
  ["Purple", "#BF5AF2"],
  ["Pink", "#FF375F"],
  ["Brown", "#AC8E68"],
  ["Graphite", "#8E8E93"],
];

export const DRIVER_ABBR: Record<string, string> = { postgres: "PG", mysql: "MY", sqlite: "SQ", mssql: "MS", redis: "RD", kafka: "KF" };

export function hasIcon(name: string | null | undefined): name is string {
  return !!name && name in ICON_PATHS;
}

/** Inline SVG (stroke = currentColor unless given) for a built-in icon. */
export function svgMarkup(name: string, size: number, stroke = "currentColor", width = 2): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name] ?? ""}"/></svg>`;
}

export function svgIcon(name: string, size: number, stroke = "currentColor", width = 2): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "ico look-ico";
  s.style.width = s.style.height = size + "px";
  s.innerHTML = svgMarkup(name, size, stroke, width);
  return s;
}

/** Fills a badge element: the custom icon (white stroke) when the data source has one, else the driver abbreviation. */
export function fillBadge(el: HTMLElement, cfg: Pick<ConnectionConfig, "driver" | "icon">, iconSize: number): void {
  if (hasIcon(cfg.icon)) {
    el.innerHTML = svgMarkup(cfg.icon, iconSize, "#fff", 2.2);
    el.classList.add("has-icon");
  } else {
    el.textContent = DRIVER_ABBR[cfg.driver] ?? "";
    el.classList.remove("has-icon");
  }
}

/** A data-source badge: custom icon or abbreviation on its (custom or driver) color. */
export function dataBadge(cfg: ConnectionConfig, cls: string, iconSize: number, title?: string): HTMLSpanElement {
  const b = document.createElement("span");
  b.className = cls;
  b.style.setProperty("--c", connColor(cfg));
  if (title) b.title = title;
  fillBadge(b, cfg, iconSize);
  return b;
}

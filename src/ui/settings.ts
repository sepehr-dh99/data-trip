// App settings: typed model with defaults, load / save (settings.json via the backend), live apply to the
// document (CSS variables + classes) and change notification. The frontend owns the shape; the backend stores
// the raw JSON verbatim.
import { api } from "../api";
import { DEFAULT_THEME, TOKEN_KEYS, getTheme } from "./themes";
import type { TokenKey } from "./themes";
import { getDensity, setDensity } from "./prefs";
import type { Density } from "./prefs";

export type EditorFont = "jetbrains" | "sf" | "fira" | "cascadia" | "system";
export type LineHeight = "tight" | "normal" | "loose";
export type UiSize = "s" | "m" | "l";
export type PageSize = 100 | 500 | 1000 | 0;
export type TabPlacement = "top" | "left" | "right";
export type TabSort = "manual" | "name" | "recent";
export type TabGroup = "source" | "database" | "kind" | "custom" | "none";
export type TabNaming = "table" | "source" | "classic";
export type KeymapPreset = "datatrip" | "datagrip" | "vscode";
export type HistoryDays = 30 | 90 | 365 | 0;
export type AiProvider = "codex" | "claude" | "opencode" | "openai" | "ollama";

export interface FileTarget {
  connId: string;
  database: string | null;
}

export interface CustomTabGroup {
  id: string;
  name: string;
  color: string;
  members: string[];
}

/** v0.15: idle-disconnect choices (Settings › Data & history); 0 = never. */
export type IdleMinutes = 0 | 5 | 15 | 30 | 60 | 120;
export const IDLE_MINUTES: IdleMinutes[] = [5, 15, 30, 60, 120, 0];

export interface AppSettings {
  editor: {
    fontFamily: EditorFont;
    fontSize: number;
    lineHeight: LineHeight;
    ligatures: boolean;
    colorTheme: string;
    tokenColors: Partial<Record<TokenKey, string>>;
  };
  appearance: {
    accent: string;
    glow: number;
    uiSize: UiSize;
    reduceTransparency: boolean;
    density: Density;
  };
  results: {
    pageSize: PageSize;
    borders: boolean;
    typeColors: boolean;
    countRows: boolean;
    nullText: string;
    maxColWidth: number;
  };
  tabs: {
    placement: TabPlacement;
    sort: TabSort;
    group: TabGroup;
    naming: TabNaming;
    customGroups: CustomTabGroup[];
    pinned: string[];
  };
  keymap: {
    preset: KeymapPreset;
    overrides: Record<string, string>;
  };
  data: {
    historyDays: HistoryDays;
    restoreConsoles: boolean;
    confirmRisky: boolean;
    autoReconnect: boolean;
    /** v0.15: close a console's database session after this many idle minutes (0 = never). */
    idleDisconnectMinutes: IdleMinutes;
  };
  /** In-app updates (v0.14). */
  updates: {
    /** Check on launch and once a day while open. */
    auto: boolean;
    /** Download a found update without asking (then only a restart is needed). */
    background: boolean;
    /** Offer pre-releases too. */
    prerelease: boolean;
    /** Version the user dismissed with "Later" (not offered again until a newer one). */
    skipped: string;
  };
  /** SQL files (v0.15): recently opened / saved files and the data source each was last used with. */
  files: {
    /** Most recent first, max 10. */
    recent: string[];
    /** File path → data source + database to run it against (max 200). */
    targets: Record<string, FileTarget>;
  };
  /** Help (v0.15). */
  help: {
    /** The welcome tour was finished or skipped. */
    tourDone: boolean;
  };
  /** AI assistant in SQL consoles (v0.12). */
  ai: {
    provider: AiProvider;
    /** Model for Codex / Claude Code / the API ("" = the provider's default). */
    model: string;
    /** OpenAI-compatible endpoint ("" = https://api.openai.com/v1). */
    baseUrl: string;
    /** Ollama model ("" = the first installed one). */
    ollamaModel: string;
    /** Send only the tables the request is about (+ FK neighbours) instead of the whole schema. */
    autoTables: boolean;
    /** Include 20 sample rows per picked table (never for read-only / production data sources). */
    samples: boolean;
    /** No AI at all for production data sources. */
    blockProd: boolean;
  };
}

export const FONT_STACKS: Record<EditorFont, string> = {
  jetbrains: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  sf: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  fira: '"Fira Code", ui-monospace, Menlo, Consolas, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
  system: "monospace",
};
export const FONT_LABELS: Record<EditorFont, string> = {
  jetbrains: "JetBrains Mono",
  sf: "SF Mono / Menlo",
  fira: "Fira Code",
  cascadia: "Cascadia Code",
  system: "System monospace",
};
const LINE_HEIGHT_RATIO: Record<LineHeight, number> = { tight: 1.45, normal: 1.7, loose: 1.95 };
export const PAGE_SIZES: PageSize[] = [100, 500, 1000, 0];

export function defaultSettings(): AppSettings {
  return {
    editor: { fontFamily: "jetbrains", fontSize: 13, lineHeight: "normal", ligatures: true, colorTheme: DEFAULT_THEME, tokenColors: {} },
    appearance: { accent: "#FF1A3C", glow: 55, uiSize: "m", reduceTransparency: false, density: getDensity() },
    results: { pageSize: 500, borders: true, typeColors: true, countRows: false, nullText: "NULL", maxColWidth: 320 },
    tabs: { placement: "top", sort: "manual", group: "source", naming: "table", customGroups: [], pinned: [] },
    keymap: { preset: "datatrip", overrides: {} },
    data: { historyDays: 90, restoreConsoles: true, confirmRisky: true, autoReconnect: true, idleDisconnectMinutes: 15 },
    updates: { auto: true, background: false, prerelease: false, skipped: "" },
    files: { recent: [], targets: {} },
    help: { tourDone: false },
    ai: { provider: "codex", model: "", baseUrl: "", ollamaModel: "", autoTables: true, samples: false, blockProd: true },
  };
}

// ---- tolerant merge

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], d: T): T {
  return allowed.includes(v as T) ? (v as T) : d;
}
const HEX = /^#[0-9a-fA-F]{6}$/;

export function mergeSettings(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const e = isObj(raw.editor) ? raw.editor : {};
  const a = isObj(raw.appearance) ? raw.appearance : {};
  const r = isObj(raw.results) ? raw.results : {};
  const t = isObj(raw.tabs) ? raw.tabs : {};
  const k = isObj(raw.keymap) ? raw.keymap : {};
  const x = isObj(raw.data) ? raw.data : {};
  const ai = isObj(raw.ai) ? raw.ai : {};
  const up = isObj(raw.updates) ? raw.updates : {};
  const fl = isObj(raw.files) ? raw.files : {};
  const hp = isObj(raw.help) ? raw.help : {};
  const targets: Record<string, FileTarget> = {};
  if (isObj(fl.targets)) {
    for (const path of Object.keys(fl.targets).slice(-200)) {
      const t = fl.targets[path];
      if (isObj(t) && typeof t.connId === "string") targets[path] = { connId: t.connId, database: typeof t.database === "string" ? t.database : null };
    }
  }

  const tokenColors: Partial<Record<TokenKey, string>> = {};
  if (isObj(e.tokenColors)) {
    for (const tk of TOKEN_KEYS) {
      const c = e.tokenColors[tk.key];
      if (typeof c === "string" && HEX.test(c)) tokenColors[tk.key] = c;
    }
  }
  const groups: CustomTabGroup[] = [];
  if (Array.isArray(t.customGroups)) {
    for (const g of t.customGroups) {
      if (isObj(g) && typeof g.id === "string" && typeof g.name === "string") {
        groups.push({
          id: g.id,
          name: g.name,
          color: str(g.color, "#8e8e96"),
          members: Array.isArray(g.members) ? g.members.filter((m): m is string => typeof m === "string") : [],
        });
      }
    }
  }
  const overrides: Record<string, string> = {};
  if (isObj(k.overrides)) for (const key of Object.keys(k.overrides)) if (typeof k.overrides[key] === "string") overrides[key] = k.overrides[key] as string;
  const dens = a.density === undefined ? getDensity() : oneOf<Density>(a.density, ["compact", "comfortable"], d.appearance.density);

  return {
    editor: {
      fontFamily: oneOf<EditorFont>(e.fontFamily, ["jetbrains", "sf", "fira", "cascadia", "system"], d.editor.fontFamily),
      fontSize: Math.round(num(e.fontSize, d.editor.fontSize, 11, 20)),
      lineHeight: oneOf<LineHeight>(e.lineHeight, ["tight", "normal", "loose"], d.editor.lineHeight),
      ligatures: bool(e.ligatures, d.editor.ligatures),
      colorTheme: getTheme(str(e.colorTheme, DEFAULT_THEME)).id,
      tokenColors,
    },
    appearance: {
      accent: typeof a.accent === "string" && HEX.test(a.accent) ? a.accent : d.appearance.accent,
      glow: Math.round(num(a.glow, d.appearance.glow, 0, 100)),
      uiSize: oneOf<UiSize>(a.uiSize, ["s", "m", "l"], d.appearance.uiSize),
      reduceTransparency: bool(a.reduceTransparency, d.appearance.reduceTransparency),
      density: dens,
    },
    results: {
      pageSize: oneOf<PageSize>(r.pageSize, PAGE_SIZES, d.results.pageSize),
      borders: bool(r.borders, d.results.borders),
      typeColors: bool(r.typeColors, d.results.typeColors),
      countRows: bool(r.countRows, d.results.countRows),
      nullText: str(r.nullText, d.results.nullText),
      maxColWidth: Math.round(num(r.maxColWidth, d.results.maxColWidth, 80, 1200)),
    },
    tabs: {
      placement: oneOf<TabPlacement>(t.placement, ["top", "left", "right"], d.tabs.placement),
      sort: oneOf<TabSort>(t.sort, ["manual", "name", "recent"], d.tabs.sort),
      group: oneOf<TabGroup>(t.group, ["source", "database", "kind", "custom", "none"], d.tabs.group),
      naming: oneOf<TabNaming>(t.naming, ["table", "source", "classic"], d.tabs.naming),
      customGroups: groups,
      pinned: Array.isArray(t.pinned) ? t.pinned.filter((p): p is string => typeof p === "string") : [],
    },
    keymap: { preset: oneOf<KeymapPreset>(k.preset, ["datatrip", "datagrip", "vscode"], d.keymap.preset), overrides },
    data: {
      historyDays: oneOf<HistoryDays>(x.historyDays, [30, 90, 365, 0], d.data.historyDays),
      restoreConsoles: bool(x.restoreConsoles, d.data.restoreConsoles),
      confirmRisky: bool(x.confirmRisky, d.data.confirmRisky),
      autoReconnect: bool(x.autoReconnect, d.data.autoReconnect),
      idleDisconnectMinutes: oneOf<IdleMinutes>(x.idleDisconnectMinutes, IDLE_MINUTES, d.data.idleDisconnectMinutes),
    },
    updates: {
      auto: bool(up.auto, d.updates.auto),
      background: bool(up.background, d.updates.background),
      prerelease: bool(up.prerelease, d.updates.prerelease),
      skipped: str(up.skipped, d.updates.skipped),
    },
    files: {
      recent: Array.isArray(fl.recent) ? fl.recent.filter((p): p is string => typeof p === "string" && p !== "").slice(0, 10) : [],
      targets,
    },
    help: { tourDone: bool(hp.tourDone, d.help.tourDone) },
    ai: {
      provider: oneOf<AiProvider>(ai.provider, ["codex", "claude", "opencode", "openai", "ollama"], d.ai.provider),
      model: str(ai.model, d.ai.model).trim(),
      baseUrl: str(ai.baseUrl, d.ai.baseUrl).trim(),
      ollamaModel: str(ai.ollamaModel, d.ai.ollamaModel).trim(),
      autoTables: bool(ai.autoTables, d.ai.autoTables),
      samples: bool(ai.samples, d.ai.samples),
      blockProd: bool(ai.blockProd, d.ai.blockProd),
    },
  };
}

// ---- state

let current: AppSettings = defaultSettings();
const listeners = new Set<(s: AppSettings) => void>();
let saveTimer: number | undefined;

export function getSettings(): AppSettings {
  return current;
}

export async function loadSettings(): Promise<void> {
  let raw: unknown = {};
  try {
    raw = await api.getSettings();
  } catch {
    raw = {};
  }
  current = mergeSettings(raw);
  applySettings(current);
  notify();
}

function notify(): void {
  for (const cb of [...listeners]) {
    try {
      cb(current);
    } catch {
      /* one broken listener must not stop the others */
    }
  }
}

export function onSettingsChange(cb: (s: AppSettings) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function scheduleSave(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    api.saveSettings(current as unknown as Record<string, unknown>).catch(() => {
      /* best effort: the next change retries */
    });
  }, 300);
}

/** Mutates a copy, re-validates, applies to the document, persists (debounced 300 ms) and notifies. */
export function updateSettings(mut: (s: AppSettings) => void): void {
  const next = mergeSettings(JSON.parse(JSON.stringify(current)));
  mut(next);
  current = mergeSettings(next);
  applySettings(current);
  scheduleSave();
  notify();
}

// ---- color helpers

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(c: [number, number, number]): string {
  return "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function mix(c: [number, number, number], to: [number, number, number], t: number): [number, number, number] {
  return [c[0] + (to[0] - c[0]) * t, c[1] + (to[1] - c[1]) * t, c[2] + (to[2] - c[2]) * t];
}

/** The accent family derived from one hex color (matches the default red's hand-tuned values closely). */
export function accentFamily(hex: string): Record<string, string> {
  const c = rgb(hex);
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  const a = (al: number): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${al})`;
  return {
    "--accent": hex.toLowerCase(),
    "--accent-hover": toHex(mix(c, white, 0.1)),
    "--accent-press": toHex(mix(c, black, 0.1)),
    "--accent-text": toHex(mix(c, white, 0.38)),
    "--accent-text-hover": toHex(mix(c, white, 0.55)),
    "--accent-glow": `0 4px 16px ${a(0.35)}`,
    "--accent-soft": a(0.14),
    "--accent-sel": a(0.3),
    "--accent-sel-blur": a(0.18),
    "--focus-ring": `0 0 0 1.5px ${a(0.85)}, 0 0 0 5px ${a(0.22)}`,
    "--glow-a": a(0.55),
  };
}

export function lineHeightPx(size: number, lh: LineHeight): number {
  return Math.round(size * LINE_HEIGHT_RATIO[lh]);
}

/** Token colors in effect: theme preset + per-token overrides. */
export function effectiveTokenColors(s: AppSettings): Record<TokenKey, string> {
  return { ...getTheme(s.editor.colorTheme).colors, ...s.editor.tokenColors };
}

export function applySettings(s: AppSettings): void {
  const root = document.documentElement;
  const st = root.style;
  // editor
  st.setProperty("--editor-font", FONT_STACKS[s.editor.fontFamily]);
  st.setProperty("--editor-font-size", s.editor.fontSize + "px");
  st.setProperty("--editor-line-height", lineHeightPx(s.editor.fontSize, s.editor.lineHeight) + "px");
  st.setProperty("--editor-ligatures", s.editor.ligatures ? "normal" : "none");
  const tc = effectiveTokenColors(s);
  st.setProperty("--syn-keyword", tc.keyword);
  st.setProperty("--syn-string", tc.string);
  st.setProperty("--syn-number", tc.number);
  st.setProperty("--syn-comment", tc.comment);
  st.setProperty("--syn-punct", tc.punct);
  st.setProperty("--syn-type", tc.type);
  st.setProperty("--syn-text", tc.text);
  // accent
  const fam = accentFamily(s.appearance.accent);
  for (const k of Object.keys(fam)) st.setProperty(k, fam[k]);
  // ambient glow
  const g = s.appearance.glow / 100;
  st.setProperty("--glow-strength", String(+g.toFixed(3)));
  st.setProperty("--glow-mid", String(+(g * 0.7).toFixed(3)));
  // classes
  root.classList.toggle("ui-s", s.appearance.uiSize === "s");
  root.classList.toggle("ui-m", s.appearance.uiSize === "m");
  root.classList.toggle("ui-l", s.appearance.uiSize === "l");
  root.classList.toggle("reduce-transparency", s.appearance.reduceTransparency);
  root.classList.toggle("grid-borders", s.results.borders);
  root.classList.toggle("grid-types", s.results.typeColors);
  root.classList.toggle("density-compact", s.appearance.density === "compact");
  root.classList.toggle("density-comfortable", s.appearance.density === "comfortable");
  st.setProperty("--grid-max-col", s.results.maxColWidth + "px");
  if (getDensity() !== s.appearance.density) setDensity(s.appearance.density);
}

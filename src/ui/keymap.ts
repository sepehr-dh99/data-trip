// Keyboard actions: registry, presets (DataTrip / DataGrip / VS Code), user overrides, event matching and labels.
//
// A binding is a string such as "Mod-Shift-Enter": modifiers Mod (Cmd on macOS, Ctrl elsewhere), Ctrl, Alt, Shift,
// Meta (literal Cmd/Win key), then the key: a letter (upper case), a digit, "Enter", "Tab", "ArrowLeft", "F5",
// or one of . , / ; ' [ ] \ - = ` . The empty string means "unbound".
import { getSettings, onSettingsChange, updateSettings } from "./settings";
import type { KeymapPreset } from "./settings";

export type ActionId =
  | "runStatement"
  | "runAll"
  | "cancel"
  | "newConsole"
  | "closeTab"
  | "reopenTab"
  | "formatSql"
  | "toggleComment"
  | "find"
  | "undo"
  | "redo"
  | "reconnect"
  | "settings"
  | "nextTab"
  | "prevTab"
  | "jumpToTab"
  | "toggleSidebar"
  | "commandPalette"
  | "askAi"
  | "saveFile"
  | "saveFileAs"
  | "openFile"
  | "help"
  | "explain"
  | "showDdl";

export interface ActionInfo {
  id: ActionId;
  name: string;
  /** Handled by CodeMirror itself (editor.ts builds its keymap from the registry); shown and remappable, not matched globally. */
  editor?: boolean;
}

export const ACTIONS: ActionInfo[] = [
  { id: "runStatement", name: "Run statement" },
  { id: "runAll", name: "Run all" },
  { id: "cancel", name: "Cancel query" },
  { id: "newConsole", name: "New console" },
  { id: "closeTab", name: "Close tab" },
  { id: "reopenTab", name: "Reopen closed tab" },
  { id: "formatSql", name: "Format SQL" },
  { id: "toggleComment", name: "Toggle comment", editor: true },
  { id: "find", name: "Find in console", editor: true },
  { id: "undo", name: "Undo", editor: true },
  { id: "redo", name: "Redo", editor: true },
  { id: "reconnect", name: "Reconnect data source" },
  { id: "settings", name: "Settings" },
  { id: "nextTab", name: "Next tab" },
  { id: "prevTab", name: "Previous tab" },
  { id: "jumpToTab", name: "Jump to tab" },
  { id: "toggleSidebar", name: "Toggle sidebar" },
  { id: "commandPalette", name: "Command palette" },
  { id: "askAi", name: "Ask AI" },
  { id: "saveFile", name: "Save SQL file" },
  { id: "saveFileAs", name: "Save SQL file as…" },
  { id: "openFile", name: "Open SQL file…" },
  { id: "help", name: "Help" },
  { id: "explain", name: "Explain plan" },
  { id: "showDdl", name: "Show DDL" },
];

type Table = Record<ActionId, string>;

const DATATRIP: Table = {
  runStatement: "Mod-Enter",
  runAll: "Mod-Shift-Enter",
  cancel: "Mod-.",
  newConsole: "Mod-N",
  closeTab: "Mod-W",
  reopenTab: "Mod-Shift-T",
  formatSql: "Mod-Alt-L",
  toggleComment: "Mod-/",
  find: "Mod-F",
  undo: "Mod-Z",
  redo: "Mod-Shift-Z",
  reconnect: "Mod-Alt-R",
  settings: "Mod-,",
  nextTab: "Ctrl-Tab",
  prevTab: "Ctrl-Shift-Tab",
  jumpToTab: "Mod-P",
  toggleSidebar: "Mod-B",
  commandPalette: "Mod-K",
  askAi: "Mod-I",
  saveFile: "Mod-S",
  saveFileAs: "Mod-Shift-S",
  openFile: "Mod-O",
  help: "F1",
  explain: "Mod-Alt-E",
  showDdl: "Mod-Alt-D",
};

export const PRESETS: Record<KeymapPreset, Table> = {
  datatrip: DATATRIP,
  datagrip: {
    ...DATATRIP,
    runAll: "Mod-Shift-Enter",
    cancel: "Mod-F2",
    newConsole: "Mod-Shift-N",
    formatSql: "Mod-Alt-L",
    reconnect: "",
    nextTab: "Alt-ArrowRight",
    prevTab: "Alt-ArrowLeft",
    jumpToTab: "Mod-E",
    toggleSidebar: "Mod-1",
  },
  vscode: {
    ...DATATRIP,
    cancel: "Mod-.",
    formatSql: "Alt-Shift-F",
    reconnect: "",
  },
};

export const PRESET_LABELS: Record<KeymapPreset, string> = { datatrip: "DataTrip", datagrip: "DataGrip", vscode: "VS Code" };

const isMac = (): boolean => document.documentElement.classList.contains("mac");

// ---- parsing

interface Parsed {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export function parseBinding(spec: string): Parsed | null {
  if (!spec) return null;
  const parts = spec.split("-");
  // a trailing "-" key ("Mod--") yields an empty last part
  let key = parts.pop() ?? "";
  if (key === "" && parts.length > 0) key = "-";
  const p: Parsed = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key };
  for (const m of parts) {
    if (m === "Mod") p.mod = true;
    else if (m === "Ctrl") p.ctrl = true;
    else if (m === "Alt") p.alt = true;
    else if (m === "Shift") p.shift = true;
    else if (m === "Meta") p.meta = true;
    else if (m !== "") return null;
  }
  return key ? p : null;
}

const CODE_KEYS: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** Layout-independent key name of an event (so Alt-L is "L" even where Alt+L types a symbol). */
function eventKey(e: KeyboardEvent): string {
  const c = e.code;
  if (c.startsWith("Key") && c.length === 4) return c[3];
  if (c.startsWith("Digit") && c.length === 6) return c[5];
  if (CODE_KEYS[c]) return CODE_KEYS[c];
  const k = e.key;
  if (k.length === 1) return k.toUpperCase();
  if (k === " ") return "Space";
  return k;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "OS", "CapsLock"]);

/** The binding string for a pressed combination, or null when only modifiers are down. */
export function eventToBinding(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const mac = isMac();
  const out: string[] = [];
  if (mac) {
    if (e.metaKey) out.push("Mod");
    if (e.ctrlKey) out.push("Ctrl");
  } else {
    if (e.ctrlKey) out.push("Mod");
    if (e.metaKey) out.push("Meta");
  }
  if (e.altKey) out.push("Alt");
  if (e.shiftKey) out.push("Shift");
  out.push(eventKey(e));
  return out.join("-");
}

function matches(p: Parsed, e: KeyboardEvent): boolean {
  const mac = isMac();
  const wantMeta = p.meta || (p.mod && mac);
  const wantCtrl = p.ctrl || (p.mod && !mac);
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl) return false;
  if (e.altKey !== p.alt || e.shiftKey !== p.shift) return false;
  return eventKey(e) === (p.key.length === 1 ? p.key.toUpperCase() : p.key);
}

// ---- effective table

export function presetBinding(preset: KeymapPreset, id: ActionId): string {
  return PRESETS[preset][id];
}

/** The binding in effect: user override, else the preset's. "" = unbound. */
export function bindingOf(id: ActionId): string {
  const km = getSettings().keymap;
  const o = km.overrides[id];
  return typeof o === "string" ? o : PRESETS[km.preset][id];
}

let parsedCache: { id: ActionId; p: Parsed }[] | null = null;
onSettingsChange(() => {
  parsedCache = null;
});

function table(): { id: ActionId; p: Parsed }[] {
  if (parsedCache) return parsedCache;
  const t: { id: ActionId; p: Parsed }[] = [];
  for (const a of ACTIONS) {
    const p = parseBinding(bindingOf(a.id));
    if (p) t.push({ id: a.id, p });
  }
  parsedCache = t;
  return t;
}

/** The action a key event triggers (editor-handled actions included), or null. */
export function matchAction(e: KeyboardEvent): ActionId | null {
  if (e.isComposing || MODIFIER_KEYS.has(e.key)) return null;
  for (const t of table()) if (matches(t.p, e)) return t.id;
  return null;
}

// ---- labels

const MAC_KEYS: Record<string, string> = {
  Enter: "↵",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "␣",
};
const WIN_KEYS: Record<string, string> = { ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Escape: "Esc" };

export function formatBinding(spec: string): string {
  const p = parseBinding(spec);
  if (!p) return "";
  if (isMac()) {
    const ctrl = p.ctrl ? "⌃" : "";
    const alt = p.alt ? "⌥" : "";
    const shift = p.shift ? "⇧" : "";
    const meta = p.mod || p.meta ? "⌘" : "";
    return ctrl + alt + shift + meta + (MAC_KEYS[p.key] ?? p.key);
  }
  const parts: string[] = [];
  if (p.mod || p.ctrl) parts.push("Ctrl");
  if (p.alt) parts.push("Alt");
  if (p.shift) parts.push("Shift");
  if (p.meta) parts.push("Win");
  parts.push(WIN_KEYS[p.key] ?? p.key);
  return parts.join("+");
}

/** Display label of an action's shortcut ("⇧⌘↵" on macOS, "Ctrl+Shift+Enter" elsewhere); "" when unbound. */
export function shortcutLabel(id: ActionId): string {
  return formatBinding(bindingOf(id));
}

/** Key name in CodeMirror's syntax ("Mod-Alt-l"), or null when unbound. */
export function codeMirrorKey(id: ActionId): string | null {
  const p = parseBinding(bindingOf(id));
  if (!p) return null;
  const parts: string[] = [];
  if (p.mod) parts.push("Mod");
  if (p.ctrl) parts.push("Ctrl");
  if (p.meta) parts.push("Meta");
  if (p.alt) parts.push("Alt");
  if (p.shift) parts.push("Shift");
  parts.push(p.key.length === 1 ? p.key.toLowerCase() : p.key);
  return parts.join("-");
}

// ---- editing (used by the settings dialog)

/** Sets (binding string), unbinds ("") or resets (null) one action. */
export function setBinding(id: ActionId, spec: string | null): void {
  updateSettings((s) => {
    if (spec === null || spec === PRESETS[s.keymap.preset][id]) delete s.keymap.overrides[id];
    else s.keymap.overrides[id] = spec;
  });
}

/** Another action that already uses `spec` (for conflict hints), or null. */
export function conflictFor(id: ActionId, spec: string): ActionId | null {
  for (const a of ACTIONS) if (a.id !== id && bindingOf(a.id) === spec) return a.id;
  return null;
}

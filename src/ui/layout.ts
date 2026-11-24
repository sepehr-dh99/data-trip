// Explorer order + folder appearance, persisted in <config>/explorer_layout.json.
//
// Display order: top level = layout.order (folder:<name> / conn:<id>), then folders / top-level connections
// that are missing from it (folders first, each group alphabetical). Inside a folder = layout.folderOrder[name],
// then missing members alphabetically. Stale entries are dropped when the layout is saved.
import { api } from "../api";
import type { ExplorerLayout, FolderMeta } from "../types";
import { debounce, errMsg } from "./dom";
import type { ConnEntry } from "./state";
import { store } from "./state";
import { toast } from "./toast";
import { updateConfig } from "./scope";

let layout: ExplorerLayout = { order: [], folderOrder: {}, folders: [] };
const listeners = new Set<() => void>();

export function onLayoutChange(fn: () => void): void {
  listeners.add(fn);
}
function emit(): void {
  for (const l of listeners) l();
}

export async function loadLayout(): Promise<void> {
  try {
    const l = await api.getExplorerLayout();
    layout = { order: Array.isArray(l?.order) ? l.order : [], folderOrder: l?.folderOrder && typeof l.folderOrder === "object" ? l.folderOrder : {}, folders: Array.isArray(l?.folders) ? l.folders : [] };
  } catch {
    layout = { order: [], folderOrder: {}, folders: [] };
  }
  emit();
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export interface FolderItem {
  kind: "folder";
  name: string;
  members: ConnEntry[];
}
export interface ConnItem {
  kind: "conn";
  entry: ConnEntry;
}
export type TopItem = FolderItem | ConnItem;

export const folderKey = (name: string): string => "folder:" + name;
export const connKey = (id: string): string => "conn:" + id;
export const connFolder = (e: ConnEntry): string | null => e.config.folder?.trim() || null;

/** The explorer's top-level display model. */
export function topItems(): TopItem[] {
  const folders = new Map<string, ConnEntry[]>();
  const loose = new Map<string, ConnEntry>();
  for (const e of store.list()) {
    const f = connFolder(e);
    if (f) folders.set(f, [...(folders.get(f) ?? []), e]);
    else loose.set(e.config.id, e);
  }
  const out: TopItem[] = [];
  const usedF = new Set<string>();
  const usedC = new Set<string>();
  const members = (name: string): ConnEntry[] => {
    const all = folders.get(name) ?? [];
    const order = layout.folderOrder[name] ?? [];
    const res: ConnEntry[] = [];
    const seen = new Set<string>();
    for (const id of order) {
      const e = all.find((x) => x.config.id === id);
      if (e && !seen.has(id)) (res.push(e), seen.add(id));
    }
    return [...res, ...all.filter((e) => !seen.has(e.config.id)).sort((a, b) => byName(a.config.name, b.config.name))];
  };
  for (const k of layout.order) {
    if (k.startsWith("folder:")) {
      const name = k.slice(7);
      if (folders.has(name) && !usedF.has(name)) {
        usedF.add(name);
        out.push({ kind: "folder", name, members: members(name) });
      }
    } else if (k.startsWith("conn:")) {
      const id = k.slice(5);
      const e = loose.get(id);
      if (e && !usedC.has(id)) {
        usedC.add(id);
        out.push({ kind: "conn", entry: e });
      }
    }
  }
  for (const name of [...folders.keys()].filter((n) => !usedF.has(n)).sort(byName)) out.push({ kind: "folder", name, members: members(name) });
  for (const e of [...loose.values()].filter((x) => !usedC.has(x.config.id)).sort((a, b) => byName(a.config.name, b.config.name))) out.push({ kind: "conn", entry: e });
  return out;
}

// ---------------------------------------------------------------- persistence

function normalized(): ExplorerLayout {
  const items = topItems();
  const names = new Set(items.filter((i): i is FolderItem => i.kind === "folder").map((i) => i.name));
  const folderOrder: Record<string, string[]> = {};
  for (const i of items) if (i.kind === "folder") folderOrder[i.name] = i.members.map((m) => m.config.id);
  return {
    order: items.map((i) => (i.kind === "folder" ? folderKey(i.name) : connKey(i.entry.config.id))),
    folderOrder,
    folders: layout.folders.filter((f) => names.has(f.name) && (f.color || f.icon)).map((f) => ({ name: f.name, color: f.color ?? null, icon: f.icon ?? null })),
  };
}

const flush = debounce(() => {
  layout = normalized();
  api.saveExplorerLayout(layout).catch((e) => toast(`Could not save the explorer layout: ${errMsg(e)}`, "error"));
}, 300);

/** Persists the (normalized) layout shortly; re-renders subscribers at once. */
export function touchLayout(): void {
  emit();
  flush();
}

/** Snapshot used by tests. */
export function currentLayout(): ExplorerLayout {
  return normalized();
}

// ---------------------------------------------------------------- folder appearance

export function folderMeta(name: string): FolderMeta | undefined {
  return layout.folders.find((f) => f.name === name);
}

const lookListeners = new Set<() => void>();
/** Subscribe to color / icon changes (tabs and the navigator redraw their badges). */
export function onLookChange(fn: () => void): void {
  lookListeners.add(fn);
}
function emitLook(): void {
  for (const l of lookListeners) l();
}

export function setFolderLook(name: string, patch: { color?: string | null; icon?: string | null }): void {
  const cur = folderMeta(name);
  if (cur) Object.assign(cur, patch);
  else layout.folders.push({ name, color: patch.color ?? null, icon: patch.icon ?? null });
  touchLayout();
}

/** Data source color / icon: applied at once, saved (debounced) through the connection config. */
export function setConnLook(id: string, patch: { color?: string | null; icon?: string | null }): void {
  void updateConfig(id, patch, 300);
  store.emit();
  emitLook();
}

// ---------------------------------------------------------------- ordering

interface Model {
  top: { key: string; ids: string[] }[];
}

function buildModel(): Model {
  return { top: topItems().map((i) => (i.kind === "folder" ? { key: folderKey(i.name), ids: i.members.map((m) => m.config.id) } : { key: connKey(i.entry.config.id), ids: [] })) };
}

interface Loc {
  top: number;
  /** Index inside the folder, or -1 for a top-level entry. */
  sub: number;
}
function locate(m: Model, key: string): Loc | null {
  const t = m.top.findIndex((x) => x.key === key);
  if (t >= 0) return { top: t, sub: -1 };
  if (key.startsWith("conn:")) {
    const id = key.slice(5);
    for (let i = 0; i < m.top.length; i++) {
      const s = m.top[i].ids.indexOf(id);
      if (m.top[i].key.startsWith("folder:") && s >= 0) return { top: i, sub: s };
    }
  }
  return null;
}

/** Writes the model back: layout lists and each moved connection's folder. */
function commit(m: Model, moved: Map<string, string | null>): void {
  m.top = m.top.filter((x) => !x.key.startsWith("folder:") || x.ids.length > 0);
  layout.order = m.top.map((x) => x.key);
  layout.folderOrder = {};
  for (const x of m.top) if (x.key.startsWith("folder:")) layout.folderOrder[x.key.slice(7)] = x.ids;
  for (const [id, f] of moved) void updateConfig(id, { folder: f });
  store.emit();
  touchLayout();
}

export type DropZone = "before" | "after" | "into";

interface MoveResult {
  model: Model;
  moved: Map<string, string | null>;
}

/** Computes (without applying) the result of dropping `dragKey` on `targetKey`; null = not allowed. */
function planMove(dragKey: string, targetKey: string, zone: DropZone, folderOpen: (name: string) => boolean): MoveResult | null {
  if (dragKey === targetKey) return null;
  const m = buildModel();
  const isFolder = dragKey.startsWith("folder:");
  const src = locate(m, dragKey);
  const tgt = locate(m, targetKey);
  if (!src || !tgt) return null;
  const tgtIsFolder = targetKey.startsWith("folder:");
  if (isFolder && (tgt.sub >= 0 || zone === "into")) return null; // folders live at top level only
  if (zone === "into" && !tgtIsFolder) return null;
  const moved = new Map<string, string | null>();
  const id = dragKey.slice(5);
  // take the dragged entry out
  let entry: { key: string; ids: string[] };
  if (src.sub >= 0) {
    m.top[src.top].ids.splice(src.sub, 1);
    entry = { key: dragKey, ids: [] };
  } else entry = m.top.splice(src.top, 1)[0];
  const t2 = locate(m, targetKey);
  if (!t2) return null;
  const tName = targetKey.slice(7);
  if (isFolder) {
    m.top.splice(t2.top + (zone === "after" ? 1 : 0), 0, entry);
    return { model: m, moved };
  }
  const intoFolder = (fi: number, at: number): void => {
    const f = m.top[fi];
    f.ids.splice(at, 0, id);
    moved.set(id, f.key.slice(7));
  };
  if (tgtIsFolder) {
    const fi = t2.top;
    if (zone === "into") intoFolder(fi, m.top[fi].ids.length);
    else if (zone === "after" && folderOpen(tName) && m.top[fi].ids.length > 0) intoFolder(fi, 0);
    else {
      m.top.splice(fi + (zone === "after" ? 1 : 0), 0, { key: dragKey, ids: [] });
      moved.set(id, null);
    }
  } else if (t2.sub >= 0) {
    intoFolder(t2.top, t2.sub + (zone === "after" ? 1 : 0));
  } else {
    m.top.splice(t2.top + (zone === "after" ? 1 : 0), 0, { key: dragKey, ids: [] });
    moved.set(id, null);
  }
  // a connection that stayed in its own folder needs no config change
  const cur = connFolder(store.conns.get(id)!);
  if (moved.get(id) === cur) moved.delete(id);
  return { model: m, moved };
}

export function canDrop(dragKey: string, targetKey: string, zone: DropZone, folderOpen: (name: string) => boolean): boolean {
  return planMove(dragKey, targetKey, zone, folderOpen) !== null;
}

export function dropOn(dragKey: string, targetKey: string, zone: DropZone, folderOpen: (name: string) => boolean): boolean {
  const r = planMove(dragKey, targetKey, zone, folderOpen);
  if (!r) return false;
  commit(r.model, r.moved);
  return true;
}

/** True when the entry can move by `d` (-1 / +1) inside its list. */
export function canShift(key: string, d: number): boolean {
  const m = buildModel();
  const l = locate(m, key);
  if (!l) return false;
  const len = l.sub >= 0 ? m.top[l.top].ids.length : m.top.length;
  const i = l.sub >= 0 ? l.sub : l.top;
  return i + d >= 0 && i + d < len;
}

export function shift(key: string, d: number): boolean {
  const m = buildModel();
  const l = locate(m, key);
  if (!l || !canShift(key, d)) return false;
  const arr = (l.sub >= 0 ? m.top[l.top].ids : m.top) as unknown[];
  const i = l.sub >= 0 ? l.sub : l.top;
  const [x] = arr.splice(i, 1);
  arr.splice(i + d, 0, x);
  commit(m, new Map());
  return true;
}

export function sortFolder(name: string): void {
  const m = buildModel();
  const f = m.top.find((x) => x.key === folderKey(name));
  if (!f) return;
  const nm = (id: string): string => store.conns.get(id)?.config.name ?? "";
  f.ids.sort((a, b) => byName(nm(a), nm(b)));
  commit(m, new Map());
}

/** Moves the folder's order / appearance entries to the new name (call before re-assigning the members). */
export function renameFolderLayout(from: string, to: string): void {
  const m = buildModel();
  const src = m.top.find((x) => x.key === folderKey(from));
  if (!src || from === to) return;
  const existing = m.top.find((x) => x.key === folderKey(to));
  if (existing) {
    existing.ids.push(...src.ids);
    m.top = m.top.filter((x) => x !== src);
    layout.folders = layout.folders.filter((f) => f.name !== from);
  } else {
    src.key = folderKey(to);
    const meta = folderMeta(from);
    layout.folders = layout.folders.filter((f) => f.name !== from && f.name !== to);
    if (meta) layout.folders.push({ ...meta, name: to });
  }
  layout.order = m.top.map((x) => x.key);
  layout.folderOrder = {};
  for (const x of m.top) if (x.key.startsWith("folder:")) layout.folderOrder[x.key.slice(7)] = x.ids;
  flush();
}

/** Ungroup: the members take the folder's place at top level; its appearance entry goes away. */
export function ungroupFolderLayout(name: string): void {
  const m = buildModel();
  const i = m.top.findIndex((x) => x.key === folderKey(name));
  if (i < 0) return;
  const ids = m.top[i].ids;
  m.top.splice(i, 1, ...ids.map((id) => ({ key: connKey(id), ids: [] as string[] })));
  layout.order = m.top.map((x) => x.key);
  layout.folderOrder = {};
  for (const x of m.top) if (x.key.startsWith("folder:")) layout.folderOrder[x.key.slice(7)] = x.ids;
  layout.folders = layout.folders.filter((f) => f.name !== name);
  flush();
}

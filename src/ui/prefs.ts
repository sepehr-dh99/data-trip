// Small localStorage-backed preferences: explorer density, folder collapse state, remembered
// unchecked databases (scope) and recently opened objects.
import { preferences } from "../platform";

function get(key: string): string | null {
  try {
    return preferences.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string): void {
  try {
    preferences.setItem(key, value);
  } catch {
    /* storage unavailable: preferences just don't persist */
  }
}
function getJson<T>(key: string): T | null {
  const raw = get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export type Density = "compact" | "comfortable";
export const ROW_HEIGHT: Record<Density, number> = { compact: 22, comfortable: 32 };

export function getDensity(): Density {
  return get("dt.density") === "comfortable" ? "comfortable" : "compact";
}
export function setDensity(d: Density): void {
  set("dt.density", d);
}

// ---- folders
export function getCollapsedFolders(): Set<string> {
  const v = getJson<string[]>("dt.folders.collapsed");
  return new Set(Array.isArray(v) ? v : []);
}
export function setFolderCollapsed(name: string, collapsed: boolean): void {
  const s = getCollapsedFolders();
  if (collapsed) s.add(name);
  else s.delete(name);
  set("dt.folders.collapsed", JSON.stringify([...s]));
}
export function renameCollapsedFolder(from: string, to: string): void {
  const s = getCollapsedFolders();
  if (!s.delete(from)) return;
  s.add(to);
  set("dt.folders.collapsed", JSON.stringify([...s]));
}

// ---- scope: databases the user explicitly unchecked (null = never recorded)
export function getUnchecked(connId: string): string[] | null {
  const v = getJson<string[]>("dt.scope.unchecked." + connId);
  return Array.isArray(v) ? v : null;
}
export function setUnchecked(connId: string, names: string[]): void {
  set("dt.scope.unchecked." + connId, JSON.stringify(names));
}

// ---- recent objects (Go to…)
export type ObjKind = "table" | "view" | "materialized" | "function" | "procedure" | "sequence";
export interface RecentObj {
  db: string | null;
  schema: string | null;
  name: string;
  kind: ObjKind;
}
export function getRecent(connId: string): RecentObj[] {
  const v = getJson<RecentObj[]>("dt.recent." + connId);
  return Array.isArray(v) ? v : [];
}
export function pushRecent(connId: string, o: RecentObj): void {
  const same = (x: RecentObj): boolean => x.db === o.db && x.schema === o.schema && x.name === o.name && x.kind === o.kind;
  const list = [o, ...getRecent(connId).filter((x) => !same(x))].slice(0, 8);
  set("dt.recent." + connId, JSON.stringify(list));
}

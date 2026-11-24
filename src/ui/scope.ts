// Explorer visibility scope (which databases / schemas a data source shows) and config helpers.
//
// Semantics (ConnectionConfig.scope):
//  - scope null, or scope.databases null  -> every database is shown.
//  - scope.databases = [...]               -> those databases are shown; every other known database is hidden,
//    except that with scope.showNew a database that appeared on the server after the last edit is shown.
//    "Known but unchecked" databases are remembered in localStorage (prefs.getUnchecked) so we can tell
//    them from new ones; without that record, unlisted databases stay hidden.
//  - scope.schemas[db] = [...]             -> only those schemas are listed under that database.
//  System databases are not governed by the scope (they keep their own folder in the tree).
import { api } from "../api";
import type { ExplorerScope } from "../types";
import type { ConnectionConfig, DatabaseNode } from "../types";
import { errMsg } from "./dom";
import { getUnchecked, setUnchecked } from "./prefs";
import { redisKeyCount } from "./redis";
import type { ConnEntry } from "./state";
import { store } from "./state";
import { toast } from "./toast";

const listeners = new Set<() => void>();
/** Subscribe to scope changes (explorer rows / chips must refresh). */
export function onScopeChange(fn: () => void): void {
  listeners.add(fn);
}
function emitScope(): void {
  for (const l of listeners) l();
}

export function userDatabases(e: ConnEntry): DatabaseNode[] {
  return e.databases.filter((d) => !d.isSystem);
}

export function dbVisible(e: ConnEntry, name: string): boolean {
  const sc = e.config.scope;
  if (e.config.driver === "redis" && !sc) {
    // Redis servers list 16 databases, most of them empty: by default show the non-empty ones and the current one.
    const d = e.databases.find((x) => x.name === name);
    return !d || d.isCurrent || name === e.defaultDb || (redisKeyCount(d) ?? 1) > 0;
  }
  if (!sc || sc.databases === null || sc.databases === undefined) return true;
  if (sc.databases.includes(name)) return true;
  if (sc.showNew) {
    const un = getUnchecked(e.config.id);
    return un !== null && !un.includes(name);
  }
  return false;
}

export function schemaVisible(e: ConnEntry, db: string, schema: string): boolean {
  const list = e.config.scope?.schemas?.[db];
  return !list || list.includes(schema);
}

export interface ScopeSummary {
  shown: number;
  total: number;
  filtered: boolean;
}
export function scopeSummary(e: ConnEntry): ScopeSummary {
  const user = userDatabases(e);
  const shown = user.filter((d) => dbVisible(e, d.name)).length;
  return { shown, total: user.length, filtered: shown !== user.length };
}
export function scopeLabel(s: ScopeSummary): string {
  return s.filtered ? `${s.shown} of ${s.total}` : "all";
}

// ---------------------------------------------------------------- persistence

const timers = new Map<string, number>();

/** Updates a connection's config in memory at once and persists it (debounced when delay > 0). */
export function updateConfig(id: string, patch: Partial<ConnectionConfig>, delay = 0): Promise<void> {
  const e = store.conns.get(id);
  if (!e) return Promise.resolve();
  e.config = { ...e.config, ...patch };
  const run = async (): Promise<void> => {
    const cur = store.conns.get(id);
    if (!cur) return;
    try {
      await api.saveConnection(cur.config, null);
    } catch (err) {
      toast(`Could not save: ${errMsg(err)}`, "error");
    }
  };
  if (delay <= 0) return run();
  const prev = timers.get(id);
  if (prev !== undefined) window.clearTimeout(prev);
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      void run();
    }, delay),
  );
  return Promise.resolve();
}

function baseScope(e: ConnEntry): ExplorerScope {
  const sc = e.config.scope;
  return { databases: sc?.databases ? [...sc.databases] : null, schemas: { ...(sc?.schemas ?? {}) }, showNew: sc?.showNew === true };
}

function commit(e: ConnEntry, sc: ExplorerScope): void {
  updateConfig(e.config.id, { scope: sc }, 400);
  emitScope();
}

export function checkedDatabases(e: ConnEntry): Set<string> {
  return new Set(userDatabases(e).filter((d) => dbVisible(e, d.name)).map((d) => d.name));
}

export function setCheckedDatabases(e: ConnEntry, checked: Set<string>): void {
  const sc = baseScope(e);
  const known = userDatabases(e).map((d) => d.name);
  const all = known.every((n) => checked.has(n));
  setUnchecked(e.config.id, known.filter((n) => !checked.has(n)));
  sc.databases = all && sc.showNew ? null : known.filter((n) => checked.has(n));
  commit(e, sc);
}

export function selectAllDatabases(e: ConnEntry): void {
  setCheckedDatabases(e, new Set(userDatabases(e).map((d) => d.name)));
}

export function selectDefaultOnly(e: ConnEntry): void {
  const def = e.defaultDb ?? userDatabases(e)[0]?.name;
  setCheckedDatabases(e, new Set(def ? [def] : []));
}

export function setShowNew(e: ConnEntry, on: boolean): void {
  const sc = baseScope(e);
  const known = userDatabases(e).map((d) => d.name);
  if (sc.databases === null && !on) {
    sc.databases = known;
    setUnchecked(e.config.id, []);
  } else if (sc.databases !== null && getUnchecked(e.config.id) === null) {
    const listed = sc.databases;
    setUnchecked(e.config.id, known.filter((n) => !listed.includes(n)));
  }
  sc.showNew = on;
  commit(e, sc);
}

export function setSchemaChecked(e: ConnEntry, db: string, allSchemas: string[], schema: string, on: boolean): void {
  const sc = baseScope(e);
  const cur = new Set(sc.schemas[db] ?? allSchemas);
  if (on) cur.add(schema);
  else cur.delete(schema);
  if (allSchemas.every((s) => cur.has(s))) delete sc.schemas[db];
  else sc.schemas[db] = allSchemas.filter((s) => cur.has(s));
  commit(e, sc);
}

// ---------------------------------------------------------------- folders

/** Folder names in order of first appearance. */
export function folderNames(): string[] {
  const out: string[] = [];
  for (const e of store.list()) {
    const f = e.config.folder;
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

export async function setFolder(id: string, folder: string | null): Promise<void> {
  const p = updateConfig(id, { folder: folder && folder.trim() ? folder.trim() : null });
  store.emit();
  await p;
}

export async function setFolderForMany(ids: string[], folder: string | null): Promise<void> {
  const f = folder && folder.trim() ? folder.trim() : null;
  const ps = ids.map((id) => updateConfig(id, { folder: f }));
  store.emit();
  await Promise.all(ps);
}

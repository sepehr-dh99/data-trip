// v0.16 glue: Show DDL, the table designer and Import data are opened from the explorer, the command palette,
// the app menu and ⌥⌘D. The shell registers a host (initDataTools); explorer rows carry a DbTarget.
import type { DdlKind, Driver, SessionInfo, TableNode } from "../types";
import type { TabPane } from "./tabs";
import { store } from "./state";
import { toast } from "./toast";
import { errMsg } from "./dom";
import { FED_DRIVERS } from "./federation";

/** An explorer object: a table / view / routine / sequence / index, or a schema (kind "schema"). */
export interface DbTarget {
  connId: string;
  /** The real database name (the connection's default included). */
  database: string | null;
  schema: string | null;
  name?: string;
  kind: DdlKind | "schema";
  arguments?: string | null;
  /** Indexes: their table. */
  table?: string | null;
}

export interface DataToolsHost {
  /** Adds a new tab and activates it. */
  addTab(pane: TabPane): void;
  tabs(): TabPane[];
  activate(pane: TabPane): void;
  openConsole(connId: string, o: { sql: string; database: string | null; schema: string | null; title?: string }): void;
  ensureConnected(connId: string): Promise<boolean>;
  /** The explorer's selected object. */
  selectedTarget(): DbTarget | null;
  /** The active tab's data source / database / schema / table (a console opened on a table). */
  activeContext(): { connId: string; database: string | null; schema: string | null; table: string | null } | null;
}

let host: DataToolsHost | null = null;

export function initDataTools(h: DataToolsHost): void {
  host = h;
}

export function dataHost(): DataToolsHost {
  if (!host) throw new Error("Data tools are not initialized");
  return host;
}

/** SQL data sources (Show DDL, designer and import work on these). */
export function isSqlDriver(d: Driver): boolean {
  return FED_DRIVERS.has(d);
}

/** Database name for opening consoles: null when it's the connection's default. */
export function consoleDb(connId: string, database: string | null): string | null {
  const e = store.conns.get(connId);
  return database && e && database !== e.defaultDb ? database : null;
}

/** The explorer session of (connection, database), connecting / opening the database when needed. */
export async function sessionFor(connId: string, database: string | null): Promise<SessionInfo> {
  const h = dataHost();
  if (!(await h.ensureConnected(connId))) throw new Error("Couldn't connect to the data source");
  const e = store.conns.get(connId);
  if (!e || !e.session) throw new Error("The data source isn't connected");
  if (!database || database === e.defaultDb) return e.session;
  await store.ensureDb(connId, database);
  const d = e.dbs.get(database);
  if (!d?.session) throw new Error(d?.error ?? `Couldn't open the database ${database}`);
  return d.session;
}

/** The introspected table (null when not loaded / gone). */
export function findTable(connId: string, database: string | null, schema: string | null, name: string): TableNode | null {
  const e = store.conns.get(connId);
  if (!e) return null;
  const schemas = store.schemasFor(connId, database === e.defaultDb ? null : database);
  for (const s of schemas) {
    if (schema && s.name !== schema && schemas.length > 1) continue;
    const t = s.tables.find((x) => x.name === name);
    if (t) return t;
  }
  return null;
}

/** The target ⌥⌘D / the palette act on: the explorer selection, else the active console's table. */
export function currentTarget(want: "ddl" | "table" | "schema"): DbTarget | null {
  const h = dataHost();
  const sel = h.selectedTarget();
  if (sel) {
    if (want === "ddl" && sel.kind !== "schema") return sel;
    if (want === "table" && (sel.kind === "table" || sel.kind === "schema")) return sel;
    if (want === "schema") return sel;
  }
  const a = h.activeContext();
  if (!a) return sel;
  const e = store.conns.get(a.connId);
  if (!e || !isSqlDriver(e.config.driver)) return sel;
  const db = a.database ?? e.defaultDb;
  if (a.table && want !== "schema") return { connId: a.connId, database: db, schema: a.schema, name: a.table, kind: "table" };
  return { connId: a.connId, database: db, schema: a.schema ?? store.defaultSchemaFor(a.connId, a.database), kind: "schema" };
}

export function reportError(prefix: string, e: unknown): void {
  toast(`${prefix}: ${errMsg(e)}`, "error");
}

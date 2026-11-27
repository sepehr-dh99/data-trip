// Cross-source queries: alias rules shared by the console's "Sources" strip.
import type { Driver } from "../types";

/** Drivers the backend can pull rows from for a cross-source query. */
export const FED_DRIVERS: ReadonlySet<Driver> = new Set<Driver>(["postgres", "mysql", "sqlite", "mssql"]);

const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Valid alias: `[A-Za-z_][A-Za-z0-9_]*` (the backend compares aliases case-insensitively). */
export function isAlias(s: string): boolean {
  return ALIAS_RE.test(s);
}

/** "Prod PG" → "prod_pg", "1st db" → "s_1st_db", "" → "src". */
export function aliasSlug(name: string): string {
  let s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) s = "src";
  if (/^[0-9]/.test(s)) s = "s_" + s;
  return s.slice(0, 40);
}

/** `base`, or `base_2`, `base_3`… — unique among `taken` (case-insensitive). */
export function uniqueAlias(base: string, taken: string[]): string {
  const low = new Set(taken.map((t) => t.toLowerCase()));
  if (!low.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const c = `${base}_${i}`;
    if (!low.has(c.toLowerCase())) return c;
  }
}

// ---- dragging a table from the explorer into a console

/** dataTransfer type of a table dragged from the explorer (JSON of `TableDrag`). */
export const TABLE_DRAG_MIME = "application/x-datatrip-table";

/** A table being dragged from the explorer. `database` is the real database name (never null for server sources). */
export interface TableDrag {
  connId: string;
  database: string | null;
  schema: string;
  table: string;
}

let currentDrag: TableDrag | null = null;

/**
 * The table under an explorer drag right now (dragover can't read dataTransfer data, only its types; the drop
 * target uses this to describe what dropping would do).
 */
export function tableDrag(): TableDrag | null {
  return currentDrag;
}

export function setTableDrag(d: TableDrag | null): void {
  currentDrag = d;
}

/** Reads the dropped table from a drop event (null when it isn't one). */
export function droppedTable(ev: DragEvent): TableDrag | null {
  const raw = ev.dataTransfer?.getData(TABLE_DRAG_MIME);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TableDrag>;
    if (typeof v.connId !== "string" || typeof v.schema !== "string" || typeof v.table !== "string") return null;
    return { connId: v.connId, database: typeof v.database === "string" ? v.database : null, schema: v.schema, table: v.table };
  } catch {
    return null;
  }
}

export function hasTableDrag(ev: DragEvent): boolean {
  return ev.dataTransfer?.types.includes(TABLE_DRAG_MIME) === true;
}

// A row removed from the virtualized tree mid-drag never gets its own dragend.
window.addEventListener("dragend", () => setTableDrag(null));
window.addEventListener("drop", () => window.setTimeout(() => setTableDrag(null), 0));

/** A name part of an `alias.schema.table` reference: bare when it is a plain lower-case identifier, else "quoted". */
export function refPart(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

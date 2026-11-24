// Dialect helpers: identifier quoting, completion schema, edit-context detection.
import type { ColumnMeta, ConnectionConfig, Driver, SchemaNode, TableNode } from "../types";

export function quoteIdent(driver: Driver, name: string): string {
  switch (driver) {
    case "mysql":
      return "`" + name.replace(/`/g, "``") + "`";
    case "mssql":
      return "[" + name.replace(/]/g, "]]") + "]";
    default:
      return '"' + name.replace(/"/g, '""') + '"';
  }
}

export function qualifiedName(driver: Driver, schema: string | null, table: string): string {
  return (schema ? quoteIdent(driver, schema) + "." : "") + quoteIdent(driver, table);
}

export function buildCompletionSchema(
  schemas: SchemaNode[],
  defaultSchema: string | null,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const single = schemas.length === 1;
  for (const s of schemas) {
    const isDefault = single || s.name === defaultSchema;
    for (const t of s.tables) {
      const cols = t.columns.map((c) => c.name);
      out[`${s.name}.${t.name}`] = cols;
      if (isDefault) out[t.name] = cols;
    }
  }
  return out;
}

export const CONN_COLORS = [
  "#0a84ff",
  "#30b0c7",
  "#34c759",
  "#ffb020",
  "#ff7a45",
  "#ff4d6d",
  "#bf5af2",
  "#8e8e93",
  "#d82c20",
  "#5b5bd6",
];

/** Per-driver badge colors used when a connection has no color of its own. */
export const DRIVER_COLORS: Record<string, string> = { postgres: "#3b6fd8", mysql: "#c4701f", sqlite: "#2a9d4a", mssql: "#8e44c4", redis: "#d82c20", kafka: "#5b5bd6" };

/** A connection's color: its own, else its driver's default (explorer badge, tab dot). */
export function connColor(cfg: ConnectionConfig): string {
  if (cfg.color) return cfg.color;
  return DRIVER_COLORS[cfg.driver] ?? CONN_COLORS[0];
}

/** Everything the grid needs to turn cell edits into RowEdit[]. */
export interface EditContext {
  schema: string | null;
  table: string;
  pk: string[];
  /** Per result column: matching table column name, or null for computed columns. */
  colMap: (string | null)[];
  pkIdx: number[];
  types: Record<string, string>;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|` + "`(?:[^`]|``)+`" + String.raw`|\[(?:[^\]]|\]\])+\]|[\w$\u0080-￿]+)`;
const SIMPLE_SELECT = new RegExp(
  String.raw`^\s*select\s+(?:all\s+)?([\s\S]+?)\s+from\s+(${IDENT}(?:\s*\.\s*${IDENT}){0,2})` +
    String.raw`(?:\s+(?:as\s+)?(?!(?:where|order|limit|offset|fetch|for|window)\b)[\w$]+)?` +
    String.raw`(?:\s+(?:where|order\s+by|limit|offset|fetch|for\s+(?:update|share))\b[\s\S]*)?\s*;?\s*$`,
  "i",
);
const REJECT = /\b(join|group\s+by|union|intersect|except|having|distinct|into)\b/i;

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function unquote(part: string): string {
  const p = part.trim();
  if (p.startsWith('"')) return p.slice(1, -1).replace(/""/g, '"');
  if (p.startsWith("`")) return p.slice(1, -1).replace(/``/g, "`");
  if (p.startsWith("[")) return p.slice(1, -1).replace(/\]\]/g, "]");
  return p;
}

/** Splits a select list on top-level commas (outside parentheses, quotes and brackets). */
function splitSelectList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      i++;
      while (i < list.length && list[i] !== close) i++;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

interface SelectItem {
  /** Source column (unquoted) or "*"; null for an expression. */
  col: string | null;
  /** Output alias (unquoted), if any. */
  alias: string | null;
}

const ITEM = new RegExp(String.raw`^(?:${IDENT}\s*\.\s*)*(${IDENT}|\*)(?:\s+(?:as\s+)?(${IDENT}))?$`, "i");
const BINARY_TYPE = /bytea|blob|binary|^image$|geometry/i;
const TRAILING_ALIAS = new RegExp(String.raw`\s(?:as\s+)?(${IDENT})$`, "i");

function parseSelectItem(item: string): SelectItem {
  const m = ITEM.exec(item);
  if (m) return { col: m[1] === "*" ? "*" : unquote(m[1]), alias: m[2] ? unquote(m[2]) : null };
  const a = TRAILING_ALIAS.exec(item);
  return { col: null, alias: a ? unquote(a[1]) : null };
}

export interface EditDetection {
  ctx: EditContext | null;
  reason: string;
}

export function detectEditContext(
  statement: string,
  columns: ColumnMeta[],
  schemas: SchemaNode[],
  defaultSchema: string | null,
  readOnly: boolean,
): EditDetection {
  const none = (reason: string): EditDetection => ({ ctx: null, reason });
  if (readOnly) return none("Read-only connection");
  const sql = stripComments(statement).trim();
  const m = SIMPLE_SELECT.exec(sql);
  if (!m || REJECT.test(sql)) return none("Read-only result: editing needs a simple single-table SELECT");
  const parts = m[2].split(/\s*\.\s*/).map(unquote);
  const tname = parts[parts.length - 1];
  const sname = parts.length >= 2 ? parts[parts.length - 2] : null;
  let found: { s: SchemaNode; t: TableNode } | null = null;
  const lower = (x: string): string => x.toLowerCase();
  const pickIn = (s: SchemaNode): TableNode | undefined =>
    s.tables.find((t) => t.name === tname) ?? s.tables.find((t) => lower(t.name) === lower(tname));
  if (sname !== null) {
    const s = schemas.find((x) => lower(x.name) === lower(sname));
    const t = s ? pickIn(s) : undefined;
    if (s && t) found = { s, t };
  } else {
    const ordered = [...schemas].sort(
      (a, b) => Number(b.name === defaultSchema) - Number(a.name === defaultSchema),
    );
    for (const s of ordered) {
      const t = pickIn(s);
      if (t) {
        found = { s, t };
        break;
      }
    }
  }
  if (!found) return none("Read-only result: table not found in schema");
  const { s, t } = found;
  if (t.kind !== "table") return none("Read-only result: views cannot be edited");
  if (t.primaryKey.length === 0) return none("Read-only result: table has no primary key");
  const byLower = new Map<string, string>();
  for (const c of t.columns) byLower.set(lower(c.name), c.name);
  // Map result columns to table columns. Expressions and aliases must never be mistaken for a
  // real column (e.g. `SELECT name AS id ...` would otherwise make edits target the wrong row).
  const items = splitSelectList(m[1]).map(parseSelectItem);
  let colMap: (string | null)[];
  if (!items.some((it) => it.col === "*") && items.length === columns.length) {
    colMap = items.map((it) => (it.col === null ? null : byLower.get(lower(it.col)) ?? null));
  } else {
    const blocked = new Set<string>();
    for (const it of items) {
      if (it.alias !== null && (it.col === null || lower(it.alias) !== lower(it.col))) blocked.add(lower(it.alias));
    }
    colMap = columns.map((c) => (blocked.has(lower(c.name)) ? null : byLower.get(lower(c.name)) ?? null));
  }
  // Binary cells arrive as (possibly truncated) "0x…" display text; writing that back would
  // store the text itself, so binary columns are read-only.
  const binary = new Set(t.columns.filter((c) => BINARY_TYPE.test(c.dataType)).map((c) => c.name));
  colMap = colMap.map((x) => (x !== null && binary.has(x) ? null : x));
  const pkIdx: number[] = [];
  for (const k of t.primaryKey) {
    const i = colMap.findIndex((x) => x === k);
    if (i < 0) return none(`Read-only result: primary key column "${k}" is not in the result`);
    pkIdx.push(i);
  }
  const types: Record<string, string> = {};
  for (const c of t.columns) types[c.name] = c.dataType;
  const schemaName = s.name;
  return { ctx: { schema: schemaName, table: t.name, pk: t.primaryKey, colMap, pkIdx, types }, reason: "" };
}

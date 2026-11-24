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

// ---------------------------------------------------------------------------------------------
// Filter bar support: parse a simple single-table SELECT into head / WHERE / ORDER BY / tail and
// rebuild it. A small lexer keeps strings, quoted identifiers, comments and parentheses out of the
// keyword search, so `WHERE note = 'order by x'` is not mistaken for an ORDER BY clause.

interface LexOpts {
  brackets: boolean;
  backticks: boolean;
  backslash: boolean;
  dollar: boolean;
  hash: boolean;
}

function lexOpts(driver: Driver): LexOpts {
  switch (driver) {
    case "mysql":
      return { brackets: false, backticks: true, backslash: true, dollar: false, hash: true };
    case "mssql":
      return { brackets: true, backticks: false, backslash: false, dollar: false, hash: false };
    case "sqlite":
      return { brackets: true, backticks: true, backslash: false, dollar: false, hash: false };
    default:
      return { brackets: false, backticks: false, backslash: false, dollar: true, hash: false };
  }
}

type TokKind = "word" | "id" | "str" | "num" | "op" | "comment";
interface Tok {
  k: TokKind;
  s: number;
  e: number;
  /** Lower-cased text for words, raw text otherwise. */
  text: string;
  /** Parenthesis depth (a "(" has the depth outside it, a ")" the depth outside it as well). */
  depth: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[\w$\u0080-￿]/;

/** Tokenizes `sql`; null when a string, quoted identifier or block comment is not terminated. */
function lex(sql: string, driver: Driver): Tok[] | null {
  const o = lexOpts(driver);
  const out: Tok[] = [];
  const n = sql.length;
  let depth = 0;
  let i = 0;
  const push = (k: TokKind, s: number, e: number, d = depth): void => {
    out.push({ k, s, e, text: k === "word" ? sql.slice(s, e).toLowerCase() : sql.slice(s, e), depth: d });
  };
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      push("comment", i, j);
      i = j;
      continue;
    }
    if (o.hash && c === "#") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      push("comment", i, j);
      i = j;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      if (j < 0) return null;
      push("comment", i, j + 2);
      i = j + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        if (o.backslash && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      push("str", i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"' || (c === "`" && o.backticks) || (c === "[" && o.brackets)) {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        if (sql[j] === close) {
          if (sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      push("id", i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$" && o.dollar) {
      const m = /^\$[A-Za-z_\u0080-￿]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const j = sql.indexOf(m[0], i + m[0].length);
        if (j < 0) return null;
        push("str", i, j + m[0].length);
        i = j + m[0].length;
        continue;
      }
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(sql[j])) j++;
      push("num", i, j);
      i = j;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      push("word", i, j);
      i = j;
      continue;
    }
    if (c === "(") {
      push("op", i, i + 1, depth);
      depth++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      push("op", i, i + 1, depth);
    } else push("op", i, i + 1);
    i++;
  }
  return out;
}

/** Replaces every comment (outside strings) by a space. */
function blankComments(sql: string, toks: Tok[]): string {
  let out = "";
  let at = 0;
  for (const t of toks) {
    if (t.k !== "comment") continue;
    out += sql.slice(at, t.s) + " ";
    at = t.e;
  }
  return out + sql.slice(at);
}

const AGGREGATES = new Set([
  "count", "sum", "avg", "min", "max", "group_concat", "string_agg", "array_agg", "json_agg", "jsonb_agg",
  "listagg", "total", "every", "bool_and", "bool_or", "stddev", "variance", "json_arrayagg", "json_objectagg",
]);
const TABLE_STOP = new Set(["where", "order", "limit", "offset", "fetch", "for", "group", "having", "union", "intersect", "except", "window", "join", "inner", "left", "right", "full", "cross", "natural", "on", "using", "into", "lateral", "tablesample", "with", "returning"]);
const FOR_LOCK = /^(update|share|no|key)$/;

/** A simple single-table SELECT split around its WHERE / ORDER BY clauses. */
export interface ParsedSelect {
  /** Leading comments / whitespace of the statement, kept verbatim. */
  prefix: string;
  /** `SELECT <cols> FROM <table> [alias]`, comments removed. */
  head: string;
  /** WHERE condition without the keyword ("" when absent). */
  where: string;
  /** ORDER BY list without the keywords ("" when absent). */
  order: string;
  /** Everything from LIMIT / OFFSET / FETCH / FOR on ("" when absent). */
  tail: string;
  schema: string | null;
  table: string;
}

/**
 * Splits a simple `SELECT <cols> FROM <table> [WHERE …] [ORDER BY …] [LIMIT/OFFSET/FETCH/FOR …]`.
 * Returns null for anything else (joins, aggregates, grouping, set operations, subquery sources,
 * other statement kinds). A trailing `;` is dropped. Comments inside the statement are dropped.
 */
export function parseFilterable(statement: string, driver: Driver): ParsedSelect | null {
  if (driver === "redis" || driver === "kafka") return null;
  const first = lex(statement, driver);
  if (!first) return null;
  const real = first.find((t) => t.k !== "comment");
  if (!real) return null;
  const prefix = statement.slice(0, real.s);
  const body = blankComments(statement.slice(real.s), first.filter((t) => t.s >= real.s)
    .map((t) => ({ ...t, s: t.s - real.s, e: t.e - real.s })));
  const toks = lex(body, driver);
  if (!toks) return null;
  while (toks.length && toks[toks.length - 1].k === "op" && toks[toks.length - 1].text === ";") toks.pop();
  if (toks.some((t) => t.k === "op" && t.text === ";")) return null;
  if (toks.length < 4 || toks[0].k !== "word" || toks[0].text !== "select") return null;
  const wd = (i: number): string => (toks[i] && toks[i].k === "word" && toks[i].depth === 0 ? toks[i].text : "");
  const from = toks.findIndex((t) => t.k === "word" && t.depth === 0 && t.text === "from");
  if (from < 2) return null;
  for (let i = 1; i < from; i++) {
    const t = toks[i];
    if (t.k === "word" && (AGGREGATES.has(t.text) && toks[i + 1]?.text === "(")) return null;
    if (t.k === "word" && t.depth === 0 && (t.text === "into" || t.text === "over")) return null;
    if (t.k === "word" && t.text === "over" && toks[i + 1]?.text === "(") return null;
  }
  // table reference: ident(.ident){0,2} [[AS] alias]
  let i = from + 1;
  const parts: string[] = [];
  const isName = (t: Tok | undefined): boolean => !!t && (t.k === "id" || (t.k === "word" && !TABLE_STOP.has(t.text) && t.text !== "select"));
  if (!isName(toks[i])) return null;
  parts.push(body.slice(toks[i].s, toks[i].e));
  let end = toks[i].e;
  i++;
  while (toks[i]?.text === "." && isName(toks[i + 1]) && parts.length < 3) {
    parts.push(body.slice(toks[i + 1].s, toks[i + 1].e));
    end = toks[i + 1].e;
    i += 2;
  }
  if (toks[i]?.text === "." || toks[i]?.text === "(" || toks[i]?.text === ",") return null;
  if (wd(i) === "as") {
    if (!isName(toks[i + 1])) return null;
    end = toks[i + 1].e;
    i += 2;
  } else if (isName(toks[i]) && toks[i].k !== "word") {
    end = toks[i].e;
    i++;
  } else if (isName(toks[i])) {
    end = toks[i].e;
    i++;
  }
  const head = body.slice(0, end).trim();
  // clauses
  let whereAt = -1;
  let orderAt = -1;
  let tailAt = -1;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j];
    if (t.depth !== 0 || t.k !== "word") continue;
    const w = t.text;
    if (w === "where" && whereAt < 0 && orderAt < 0 && tailAt < 0 && j === i) whereAt = j;
    else if (w === "order" && toks[j + 1]?.text === "by" && toks[j + 1].depth === 0 && orderAt < 0 && tailAt < 0) orderAt = j;
    else if ((w === "limit" || w === "offset" || w === "fetch" || (w === "for" && FOR_LOCK.test(toks[j + 1]?.text ?? ""))) && tailAt < 0) tailAt = j;
    else if (w === "union" || w === "intersect" || w === "except" || w === "having" || w === "window" || w === "into" || (w === "group" && toks[j + 1]?.text === "by")) return null;
    else if (w === "join" && tailAt < 0) return null;
  }
  // everything between the table reference and the first clause must be empty
  const firstClause = [whereAt, orderAt, tailAt].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  if (firstClause === undefined ? i < toks.length : firstClause !== i) return null;
  if (whereAt < 0 && orderAt < 0 && tailAt < 0 && i < toks.length) return null;
  const stop = (from0: number): number => {
    const nexts = [orderAt, tailAt].filter((x) => x > from0);
    return nexts.length ? Math.min(...nexts) : toks.length;
  };
  const text = (a: number, b: number): string => (a >= b ? "" : body.slice(toks[a].s, toks[b - 1].e).trim());
  const where = whereAt >= 0 ? text(whereAt + 1, stop(whereAt)) : "";
  const order = orderAt >= 0 ? text(orderAt + 2, tailAt > orderAt ? tailAt : toks.length) : "";
  const tail = tailAt >= 0 ? text(tailAt, toks.length) : "";
  if (orderAt >= 0 && whereAt >= 0 && orderAt < whereAt) return null;
  const table = parts[parts.length - 1];
  return {
    prefix,
    head,
    where,
    order,
    tail,
    schema: parts.length >= 2 ? unquote(parts[parts.length - 2]) : null,
    table: unquote(table),
  };
}

/** Rebuilds the statement with new WHERE / ORDER BY texts (empty = clause omitted). */
export function buildFilteredSql(p: ParsedSelect, where: string, order: string): string {
  const w = where.trim().replace(/;+\s*$/, "").trim();
  const o = order.trim().replace(/;+\s*$/, "").trim();
  return p.prefix + [p.head, w ? "WHERE " + w : "", o ? "ORDER BY " + o : "", p.tail].filter(Boolean).join("\n");
}

export interface OrderItem {
  /** Expression text as written, e.g. `"name"` or `t.created_at`. */
  expr: string;
  /** Unquoted column name when the expression is a plain (qualified) column, else null. */
  col: string | null;
  dir: "ASC" | "DESC" | null;
  /** "NULLS FIRST" / "NULLS LAST" or "". */
  nulls: string;
}

/** Splits an ORDER BY list (without the keywords) into items. */
export function parseOrderItems(order: string, driver: Driver): OrderItem[] {
  const toks = lex(order, driver)?.filter((t) => t.k !== "comment");
  if (!toks || toks.length === 0) return [];
  const groups: Tok[][] = [[]];
  for (const t of toks) {
    if (t.k === "op" && t.text === "," && t.depth === 0) groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  const items: OrderItem[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    let end = g.length;
    let nulls = "";
    let dir: "ASC" | "DESC" | null = null;
    const w = (k: number): string => (g[k]?.k === "word" ? g[k].text : "");
    if (end >= 3 && w(end - 2) === "nulls" && (w(end - 1) === "first" || w(end - 1) === "last")) {
      nulls = "NULLS " + w(end - 1).toUpperCase();
      end -= 2;
    }
    if (end >= 2 && (w(end - 1) === "asc" || w(end - 1) === "desc")) {
      dir = w(end - 1) === "asc" ? "ASC" : "DESC";
      end--;
    }
    if (nulls === "" && end >= 3 && w(end - 2) === "nulls" && (w(end - 1) === "first" || w(end - 1) === "last")) {
      nulls = "NULLS " + w(end - 1).toUpperCase();
      end -= 2;
    }
    if (end === 0) continue;
    const expr = order.slice(g[0].s, g[end - 1].e);
    // plain column: name(.name)* with nothing else
    let col: string | null = null;
    const nameToks = g.slice(0, end);
    const plain = nameToks.every((t, k) => (k % 2 === 0 ? t.k === "id" || t.k === "word" : t.text === ".")) && nameToks.length % 2 === 1;
    if (plain) col = unquote(order.slice(nameToks[nameToks.length - 1].s, nameToks[nameToks.length - 1].e));
    items.push({ expr, col, dir, nulls });
  }
  return items;
}

export function formatOrderItems(items: OrderItem[]): string {
  return items.map((it) => [it.expr, it.dir ?? "", it.nulls].filter(Boolean).join(" ")).join(", ");
}

/** Sort marks for the grid header: column name (lower-case) and direction, in priority order. */
export function orderMarks(order: string, driver: Driver): { name: string; dir: "asc" | "desc" }[] {
  const out: { name: string; dir: "asc" | "desc" }[] = [];
  for (const it of parseOrderItems(order, driver)) if (it.col !== null) out.push({ name: it.col.toLowerCase(), dir: it.dir === "DESC" ? "desc" : "asc" });
  return out;
}

/**
 * New ORDER BY text after a click on a column header: ASC → DESC → cleared. With `append`
 * (shift-click) the column joins / cycles inside the existing sort instead of replacing it.
 */
export function nextOrder(order: string, column: string, append: boolean, driver: Driver): string {
  const items = parseOrderItems(order, driver);
  const low = column.toLowerCase();
  const idx = items.findIndex((it) => it.col !== null && it.col.toLowerCase() === low);
  const q = quoteIdent(driver, column);
  if (!append) {
    if (items.length === 1 && idx === 0) {
      const it = items[0];
      if (it.dir === "DESC") return "";
      return formatOrderItems([{ ...it, dir: "DESC" }]);
    }
    return `${q} ASC`;
  }
  if (idx < 0) return formatOrderItems([...items, { expr: q, col: column, dir: "ASC", nulls: "" }]);
  const it = items[idx];
  if (it.dir === "DESC") items.splice(idx, 1);
  else items[idx] = { ...it, dir: "DESC" };
  return formatOrderItems(items);
}

const RESERVED = new Set([
  "all", "and", "any", "as", "asc", "between", "by", "case", "check", "column", "constraint", "create", "cross", "current", "default", "desc",
  "distinct", "else", "end", "except", "exists", "false", "for", "foreign", "from", "full", "group", "having", "in", "index", "inner", "insert",
  "into", "is", "join", "key", "left", "like", "limit", "natural", "not", "null", "offset", "on", "or", "order", "outer", "primary", "references",
  "right", "select", "set", "table", "then", "to", "true", "union", "unique", "update", "user", "using", "values", "when", "where", "with",
  "year", "month", "day", "hour", "minute", "second", "time", "timestamp", "date", "text", "value", "type", "level", "role", "rank", "row", "rows",
]);

/** True when `name` has to be quoted to be used as an identifier in `driver`'s SQL. */
export function needsQuote(driver: Driver, name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
  if (RESERVED.has(name.toLowerCase())) return true;
  return driver === "postgres" && name !== name.toLowerCase();
}

export function quoteIfNeeded(driver: Driver, name: string): string {
  return needsQuote(driver, name) ? quoteIdent(driver, name) : name;
}

export interface FilterCompletion {
  label: string;
  apply: string;
  kind: "column" | "keyword";
  detail?: string;
}

/** Completion candidates for a filter input: the table's columns plus keywords / operators. */
export function filterCompletions(
  kind: "where" | "order",
  driver: Driver,
  columns: { name: string; type?: string }[],
  quoted = false,
): FilterCompletion[] {
  const out: FilterCompletion[] = columns.map((c) => {
    const q = quoted ? quoteIdent(driver, c.name) : quoteIfNeeded(driver, c.name);
    return { label: q, apply: q, kind: "column" as const, detail: c.type };
  });
  const pg = driver === "postgres";
  const kws =
    kind === "where"
      ? ["AND", "OR", "NOT", "IN", "NOT IN", "LIKE", "NOT LIKE", ...(pg ? ["ILIKE", "NOT ILIKE"] : []), "IS NULL", "IS NOT NULL", "BETWEEN", "EXISTS", "TRUE", "FALSE", "NULL"]
      : ["ASC", "DESC", ...(driver === "mssql" || driver === "mysql" ? [] : ["NULLS FIRST", "NULLS LAST"])];
  for (const k of kws) out.push({ label: k, apply: k, kind: "keyword" });
  return out;
}

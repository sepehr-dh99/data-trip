// Production safety (v0.16, board W): statement classification for the write confirmation, the production flag of a
// data source and the estimate queries. Pure (no DOM), node tests: node scripts/test-ops.mjs.
import type { ConnectionConfig, Driver } from "../types";
import { maskCode } from "./params";

/** Colors offered in the connection dialog (board W). */
export const PROD_COLORS: { name: string; hex: string }[] = [
  { name: "Red", hex: "#FF1A3C" },
  { name: "Orange", hex: "#ff9f0a" },
  { name: "Violet", hex: "#bf5af2" },
  { name: "Blue", hex: "#0a84ff" },
  { name: "Green", hex: "#30d158" },
];

/** CSS class of the explorer PROD tag for a color (`prod-c0` … `prod-c4`). */
export function prodTagClass(color: string): string {
  const i = PROD_COLORS.findIndex((c) => c.hex.toLowerCase() === color.toLowerCase());
  return "prod-c" + Math.max(0, i);
}

/** The explicit production options of a data source when it is marked as production, else null. */
export interface ProdFlags {
  enabled: true;
  color: string;
  confirmWrites: boolean;
  typeNameForDrop: boolean;
}

export function prodOptions(c: ConnectionConfig | null | undefined): ProdFlags | null {
  const p = c?.production;
  if (!p || p.enabled !== true) return null;
  return {
    enabled: true,
    color: typeof p.color === "string" && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : PROD_COLORS[0].hex,
    confirmWrites: p.confirmWrites !== false,
    typeNameForDrop: p.typeNameForDrop !== false,
  };
}

export interface StatementClass {
  /** SELECT, INSERT, UPDATE, DELETE, MERGE, DROP TABLE, TRUNCATE, CREATE INDEX, ALTER TABLE, CALL… */
  kind: string;
  /** Changes data or schema (anything but a plain read). */
  write: boolean;
  /** CREATE / ALTER / DROP / TRUNCATE / RENAME / GRANT / REVOKE / COMMENT. */
  ddl: boolean;
  /** DROP or TRUNCATE (removes a whole table or all its rows). */
  destructive: boolean;
  /** Target table as written (`shop.public.orders`), or null. */
  table: string | null;
  /** Top-level WHERE condition (whitespace collapsed, ≤ 160 chars), or null. */
  where: string | null;
  /** UPDATE / DELETE without a top-level WHERE. */
  noWhere: boolean;
}

const READ_HEADS = new Set(["select", "with", "show", "explain", "describe", "desc", "values", "table", "pragma", "use", "set", "begin", "start", "commit", "rollback", "end", "savepoint", "release", "abort", "declare", "print", "fetch", "close", "listen", "notify", "unlisten", "discard", "reset", "deallocate"]);
const DDL = new Set(["create", "alter", "drop", "truncate", "rename", "grant", "revoke", "comment"]);

/** Index of the first top-level occurrence (paren depth 0) of `re` (anchored keyword test) in masked text, or -1. */
function topLevel(masked: string, re: RegExp, from = 0): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[A-Za-z]/.test(c) && !/[\w$]/.test(masked[i - 1] ?? " ")) {
      const m = re.exec(masked.slice(i, i + 40));
      if (m && m.index === 0) return i;
    }
  }
  return -1;
}

const NAME = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[A-Za-z_][\w$#@]*)(?:\s*\.\s*(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[A-Za-z_][\w$#@]*)){0,3}`;

/** The (original) text of a name matched in the masked string at `at` with length `len`. */
function nameAt(sql: string, masked: string, re: RegExp, from: number): string | null {
  const m = re.exec(masked.slice(from));
  if (!m || m[1] === undefined) return null;
  const at = from + m.index + m[0].lastIndexOf(m[1]);
  return sql.slice(at, at + m[1].length).replace(/\s*\.\s*/g, ".");
}

function whereOf(sql: string, masked: string, from: number): string | null {
  const w = topLevel(masked, /^where\b/i, from);
  if (w < 0) return null;
  const end = topLevel(masked, /^(?:returning|order\s+by|limit|output|option|group\s+by|having|window|for\s+update)\b/i, w + 5);
  const text = sql.slice(w + 5, end < 0 ? sql.length : end).replace(/;\s*$/, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 160 ? text.slice(0, 160) + "…" : text;
}

/** What a statement does, for the production confirmation (statement kind, target table, WHERE, risks). */
export function classifyStatement(sql: string, driver: Driver): StatementClass {
  const masked = maskCode(sql, driver);
  const out: StatementClass = { kind: "", write: false, ddl: false, destructive: false, table: null, where: null, noWhere: false };
  const lead = /^[\s(]*/.exec(masked)?.[0].length ?? 0;
  const head = /^([A-Za-z]+)/.exec(masked.slice(lead))?.[1]?.toLowerCase() ?? "";
  let at = lead;
  let kw = head;
  if (head === "with") {
    // the statement a CTE list belongs to: first top-level INSERT / UPDATE / DELETE / MERGE / SELECT after it
    const k = topLevel(masked, /^(?:insert|update|delete|merge|select)\b/i, lead + 4);
    if (k >= 0) {
      at = k;
      kw = /^([A-Za-z]+)/.exec(masked.slice(k))?.[1]?.toLowerCase() ?? "select";
    } else kw = "select";
    // data-modifying CTEs (WITH x AS (DELETE …) SELECT …)
    if (kw === "select" && /\b(?:insert|update|delete)\b/i.test(masked)) {
      out.kind = "WITH (writes)";
      out.write = true;
      return out;
    }
  }
  out.kind = kw.toUpperCase();
  if (kw === "select" || kw === "values" || kw === "table") {
    // SELECT … INTO creates a table (SQL Server / PostgreSQL); MySQL INTO OUTFILE / @var writes nothing to tables
    const into = topLevel(masked, /^into\b/i, at);
    if (into >= 0 && !/^into\s+(?:outfile|dumpfile|@)/i.test(masked.slice(into, into + 20))) {
      out.kind = "SELECT INTO";
      out.write = true;
      out.table = nameAt(sql, masked, new RegExp(String.raw`^into\s+(?:temp(?:orary)?\s+|unlogged\s+)?(?:table\s+)?(${NAME})`, "i"), into);
    }
    return out;
  }
  if (kw === "explain") {
    // EXPLAIN ANALYZE <write> executes it
    if (/^explain\s*(?:\([^)]*\banalyze\b[^)]*\)|\s+analyze\b)/i.test(masked.slice(at))) {
      const inner = classifyStatement(sql.slice(at).replace(/^\s*explain\s*(?:\([^)]*\)|\s+analyze(?:\s+verbose)?)\s*/i, ""), driver);
      if (inner.write) return { ...inner, kind: "EXPLAIN ANALYZE " + inner.kind };
    }
    return out;
  }
  if (READ_HEADS.has(kw) || kw === "") return out;
  out.write = true;
  if (kw === "update") {
    out.table = nameAt(sql, masked, new RegExp(String.raw`^update\s+(?:only\s+|low_priority\s+|ignore\s+)*(${NAME})`, "i"), at);
    out.where = whereOf(sql, masked, at);
    out.noWhere = out.where === null;
    return out;
  }
  if (kw === "delete") {
    out.table =
      nameAt(sql, masked, new RegExp(String.raw`^delete\s+(?:low_priority\s+|quick\s+|ignore\s+)*from\s+(?:only\s+)?(${NAME})`, "i"), at) ??
      nameAt(sql, masked, new RegExp(String.raw`^delete\s+(?:top\s*\([^)]*\)\s*)?(${NAME})`, "i"), at);
    out.where = whereOf(sql, masked, at);
    out.noWhere = out.where === null;
    return out;
  }
  if (kw === "insert" || kw === "replace" || kw === "upsert") {
    out.table = nameAt(sql, masked, new RegExp(String.raw`^(?:insert|replace|upsert)\s+(?:low_priority\s+|delayed\s+|high_priority\s+|ignore\s+|or\s+\w+\s+)*(?:into\s+)?(${NAME})`, "i"), at);
    return out;
  }
  if (kw === "merge") {
    out.table = nameAt(sql, masked, new RegExp(String.raw`^merge\s+(?:top\s*\([^)]*\)\s*)?(?:into\s+)?(${NAME})`, "i"), at);
    return out;
  }
  if (DDL.has(kw)) {
    out.ddl = true;
    const m = /^(\w+)\s+(?:(?:or\s+replace|temporary|temp|unique|materialized|global|local|unlogged|if\s+exists|if\s+not\s+exists|concurrently|clustered|nonclustered)\s+)*(table|view|index|schema|database|sequence|function|procedure|trigger|type|extension|role|user|column|constraint)?/i.exec(masked.slice(at));
    const obj = m?.[2]?.toUpperCase() ?? "";
    out.kind = (kw.toUpperCase() + (obj ? " " + obj : "")).trim();
    out.destructive = kw === "drop" || kw === "truncate";
    if (kw === "truncate") out.table = nameAt(sql, masked, new RegExp(String.raw`^truncate\s+(?:table\s+)?(?:only\s+)?(${NAME})`, "i"), at);
    else if (kw === "drop" || kw === "alter" || kw === "create") {
      out.table = nameAt(
        sql,
        masked,
        new RegExp(String.raw`^\w+\s+(?:(?:or\s+replace|temporary|temp|unique|materialized|global|local|unlogged|concurrently|clustered|nonclustered)\s+)*\w+\s+(?:if\s+(?:not\s+)?exists\s+)?(?:concurrently\s+)?(${NAME})`, "i"),
        at,
      );
      if (kw === "create" && obj === "INDEX") {
        const on = nameAt(sql, masked, new RegExp(String.raw`\bon\s+(?:only\s+)?(${NAME})`, "i"), at);
        if (on) out.table = on;
      }
    }
    return out;
  }
  // CALL / EXEC / DO / COPY / LOAD / LOCK / VACUUM / ANALYZE / REINDEX … may change data
  return out;
}

/** True for statements the production confirmation is about (INSERT, UPDATE, DELETE, MERGE, DDL…). */
export function isWrite(sql: string, driver: Driver): boolean {
  return classifyStatement(sql, driver).write;
}

/** SQL that estimates how many rows a write touches (PG / MySQL only), or null when there is no cheap way. */
export function estimateSql(c: StatementClass, sql: string, driver: Driver): { sql: string; format: "pg-json" | "mysql-rows" | "pg-reltuples" | "mysql-table-rows" } | null {
  const body = sql.trim().replace(/;\s*$/, "");
  if (driver === "postgres") {
    if (c.kind === "UPDATE" || c.kind === "DELETE" || c.kind === "INSERT" || c.kind === "MERGE") return { sql: `EXPLAIN (FORMAT JSON) ${body}`, format: "pg-json" };
    if (c.destructive && c.table && (c.kind === "TRUNCATE" || c.kind === "DROP TABLE")) {
      return { sql: `SELECT c.reltuples::bigint AS n FROM pg_class c WHERE c.oid = to_regclass(${pgText(c.table)})`, format: "pg-reltuples" };
    }
    return null;
  }
  if (driver === "mysql") {
    if (c.kind === "UPDATE" || c.kind === "DELETE") return { sql: `EXPLAIN ${body}`, format: "mysql-rows" };
    if (c.destructive && c.table && (c.kind === "TRUNCATE" || c.kind === "DROP TABLE")) {
      const parts = c.table.split(".").map((p) => p.replace(/^`|`$/g, ""));
      const t = parts[parts.length - 1];
      const db = parts.length > 1 ? `'${parts[parts.length - 2].replace(/'/g, "''")}'` : "DATABASE()";
      return { sql: `SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = '${t.replace(/'/g, "''")}'`, format: "mysql-table-rows" };
    }
  }
  return null;
}

function pgText(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Row estimate from an estimate query's first cell(s), or null. */
export function parseEstimate(format: "pg-json" | "mysql-rows" | "pg-reltuples" | "mysql-table-rows", columns: string[], rows: unknown[][]): number | null {
  if (!rows.length) return null;
  if (format === "pg-json") {
    try {
      const raw = rows[0][0];
      const j = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan?: Record<string, unknown> }[];
      let p = j?.[0]?.Plan;
      // ModifyTable's own Plan Rows is 0: the rows it touches are its input's
      if (p && p["Node Type"] === "ModifyTable" && Array.isArray(p.Plans) && p.Plans.length) p = p.Plans[0] as Record<string, unknown>;
      const n = Number(p?.["Plan Rows"]);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  if (format === "mysql-rows") {
    const i = columns.findIndex((c) => c.toLowerCase() === "rows");
    if (i < 0) return null;
    let max: number | null = null;
    for (const r of rows) {
      const n = Number(r[i]);
      if (Number.isFinite(n)) max = max === null ? n : Math.max(max, n);
    }
    return max;
  }
  const n = Number(rows[0][0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** "~12 480 (planner estimate)", "all ~3.4M rows". */
export function formatEstimate(n: number, c: StatementClass): string {
  const fmt = n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M" : Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
  if (c.destructive) return c.kind === "DROP TABLE" ? `all ~${fmt} rows and the table` : `all ~${fmt} rows`;
  if (c.noWhere) return `~${fmt} — every row`;
  return `~${fmt} (planner estimate)`;
}

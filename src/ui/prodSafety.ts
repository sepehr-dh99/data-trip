// Production safety (v0.16, board W): statement classification for the write confirmation, the production flag of a
// data source and the estimate queries. Pure (no DOM), node tests: node scripts/test-ops.mjs.
import type { Cell, ConnectionConfig, Driver, RowEdit } from "../types";
import { maskCode, stringLiteral } from "./params";

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

// ---------------------------------------------------------------- v0.17: grid edits

export interface EditSummary {
  updates: number;
  inserts: number;
  deletes: number;
  /** Target tables as shown (`public.orders`), in first-seen order. */
  tables: string[];
}

export function summarizeEdits(edits: RowEdit[]): EditSummary {
  const out: EditSummary = { updates: 0, inserts: 0, deletes: 0, tables: [] };
  for (const e of edits) {
    if (e.kind === "update") out.updates++;
    else if (e.kind === "insert") out.inserts++;
    else out.deletes++;
    const t = e.schema ? `${e.schema}.${e.table}` : e.table;
    if (!out.tables.includes(t)) out.tables.push(t);
  }
  return out;
}

/** "2 updates, 1 insert, 3 deletes" (kinds with 0 left out). */
export function editCountsText(s: EditSummary): string {
  const part = (n: number, one: string): string => (n ? `${n} ${one}${n === 1 ? "" : "s"}` : "");
  return [part(s.updates, "update"), part(s.inserts, "insert"), part(s.deletes, "delete")].filter(Boolean).join(", ") || "no changes";
}

function quoteIdentFor(driver: Driver, name: string): string {
  if (driver === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (driver === "mssql") return "[" + name.replace(/]/g, "]]") + "]";
  return '"' + name.replace(/"/g, '""') + '"';
}

const NUMERIC_COL = /int|serial|numeric|decimal|float|double|real|money|number|bit\b/i;

/** A cell as an SQL literal for display (the backend binds the values as parameters). */
export function cellLiteral(v: Cell, type: string, driver: Driver): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return driver === "postgres" ? (v ? "TRUE" : "FALSE") : v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : stringLiteral(String(v), driver);
  const s = String(v);
  if (NUMERIC_COL.test(type) && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s.trim())) return s.trim();
  return stringLiteral(s.replace(/\u0000/g, ""), driver);
}

/**
 * The statements apply_edits runs for the pending grid changes (same shape as the backend's `build_edit`), with the
 * values written in as literals so they can be read in the confirmation.
 */
export function editStatements(edits: RowEdit[], driver: Driver): string[] {
  const q = (n: string): string => quoteIdentFor(driver, n);
  const where = (e: RowEdit): string =>
    Object.entries(e.key)
      .map(([k, v]) => (v === null ? `${q(k)} IS NULL` : `${q(k)} = ${cellLiteral(v, e.columnTypes[k] ?? "", driver)}`))
      .join(" AND ");
  return edits.map((e) => {
    const table = (e.schema && e.schema.trim() ? q(e.schema) + "." : "") + q(e.table);
    const changes = Object.entries(e.changes);
    if (e.kind === "insert") {
      if (!changes.length) return driver === "mysql" ? `INSERT INTO ${table} () VALUES ()` : `INSERT INTO ${table} DEFAULT VALUES`;
      return `INSERT INTO ${table} (${changes.map(([k]) => q(k)).join(", ")}) VALUES (${changes.map(([k, v]) => cellLiteral(v, e.columnTypes[k] ?? "", driver)).join(", ")})`;
    }
    if (e.kind === "update") return `UPDATE ${table} SET ${changes.map(([k, v]) => `${q(k)} = ${cellLiteral(v, e.columnTypes[k] ?? "", driver)}`).join(", ")} WHERE ${where(e)}`;
    return `DELETE FROM ${table} WHERE ${where(e)}`;
  });
}

/** The statement list of the confirmation: the first `max` statements (each + `end`), then "-- +N more". */
export function statementListText(stmts: string[], max = 8, maxChars = 1600, end = ";"): string {
  const shown: string[] = [];
  let chars = 0;
  for (const s of stmts) {
    if (shown.length >= max || (shown.length > 0 && chars + s.length > maxChars)) break;
    const one = s.length > 400 ? s.slice(0, 400) + "…" : s;
    shown.push(one + end);
    chars += one.length;
  }
  const rest = stmts.length - shown.length;
  return shown.join("\n") + (rest > 0 ? `\n${end === ";" ? "-- " : "# "}+${rest} more` : "");
}

// ---------------------------------------------------------------- v0.17: Redis commands

/** Splits a Redis command line like the backend (redis-cli style quotes); never throws. */
export function redisArgs(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    let cur = "";
    const q = line[i];
    if (q === '"' || q === "'") {
      i++;
      while (i < n && line[i] !== q) {
        if (line[i] === "\\" && i + 1 < n) {
          cur += line[i + 1];
          i += 2;
          continue;
        }
        cur += line[i++];
      }
      i++;
    } else {
      while (i < n && !/\s/.test(line[i])) cur += line[i++];
    }
    out.push(cur);
  }
  return out;
}

export interface CommandClass {
  /** Upper-case command (SET, CONFIG SET, FLUSHDB, produce, delete topic…). */
  kind: string;
  /** Changes data or server state. */
  write: boolean;
  /** Removes a whole keyspace / topic: asks for the typed name (like DROP / TRUNCATE). */
  destructive: boolean;
  /** First key / topic, when the command names one. */
  target: string | null;
  /** Number of keys a multi-key delete names (DEL / UNLINK), else 0. */
  keys: number;
}

const REDIS_WRITES = new Set(
  (
    "SET SETEX SETNX PSETEX MSET MSETNX APPEND GETSET GETDEL GETEX DEL UNLINK PERSIST MOVE COPY RESTORE HSET HSETNX " +
    "HMSET HDEL LPOP RPOP LSET LREM LTRIM LINSERT LMOVE BLMOVE RPOPLPUSH BRPOPLPUSH LMPOP BLMPOP BLPOP BRPOP SADD SREM " +
    "SPOP SMOVE ZADD ZINCRBY ZMPOP BZMPOP BZPOPMIN BZPOPMAX ZRANGESTORE XADD XDEL XTRIM XGROUP XACK XCLAIM XAUTOCLAIM " +
    "XSETID PFADD PFMERGE GEOADD GEOSEARCHSTORE SETRANGE SETBIT BITOP BITFIELD FLUSHDB FLUSHALL SWAPDB SCRIPT FUNCTION " +
    "SHUTDOWN DEBUG MIGRATE REPLICAOF SLAVEOF JSON.SET JSON.DEL JSON.FORGET JSON.ARRAPPEND JSON.ARRINSERT JSON.ARRPOP " +
    "JSON.ARRTRIM JSON.NUMINCRBY JSON.NUMMULTBY JSON.STRAPPEND JSON.TOGGLE JSON.CLEAR JSON.MERGE JSON.MSET"
  ).split(" "),
);
const REDIS_WRITE_PREFIX = ["INCR", "DECR", "EXPIRE", "PEXPIRE", "RENAME", "HINCRBY", "LPUSH", "RPUSH", "ZREM", "ZPOP", "EVAL", "FCALL"];
/** Commands that wipe a whole database / the server (typed name like DROP / TRUNCATE). */
const REDIS_DESTRUCTIVE = new Set(["FLUSHDB", "FLUSHALL", "SWAPDB", "SHUTDOWN"]);

/**
 * What a Redis console line does, mirroring the backend's write list (`db/redis.rs is_write_command`): reads pass,
 * writes ask on production, FLUSHDB / FLUSHALL / SWAPDB / SHUTDOWN are destructive.
 */
export function classifyRedisCommand(line: string): CommandClass {
  const args = redisArgs(line.trim());
  const name = (args[0] ?? "").toUpperCase();
  const rest = args.slice(1);
  const sub = (rest[0] ?? "").toUpperCase();
  const out: CommandClass = { kind: name, write: false, destructive: false, target: rest[0] ?? null, keys: 0 };
  if (!name) return out;
  if (name === "CONFIG" || name === "ACL" || name === "SCRIPT" || name === "FUNCTION" || name === "XGROUP" || name === "CLIENT" || name === "CLUSTER") {
    out.kind = sub ? `${name} ${sub}` : name;
    out.target = null;
  }
  if (REDIS_WRITES.has(name)) out.write = true;
  else if (name === "CONFIG") out.write = sub === "SET" || sub === "REWRITE" || sub === "RESETSTAT";
  else if (name === "ACL") out.write = !["WHOAMI", "LIST", "USERS", "CAT", "GETUSER", "LOG", "GENPASS", "DRYRUN", "HELP"].includes(sub);
  else if (name === "SORT") out.write = rest.some((a) => a.toUpperCase() === "STORE");
  else if (REDIS_WRITE_PREFIX.some((p) => name.startsWith(p)) || (name.startsWith("S") && name.endsWith("STORE")) || (name.startsWith("Z") && name.endsWith("STORE"))) out.write = true;
  if (name === "SCRIPT" || name === "FUNCTION") out.write = sub !== "EXISTS" && sub !== "LIST" && sub !== "DUMP" && sub !== "STATS" && sub !== "HELP";
  if (REDIS_DESTRUCTIVE.has(name) || ((name === "SCRIPT" || name === "FUNCTION") && sub === "FLUSH")) {
    out.destructive = true;
    out.target = null;
  }
  if (name === "DEL" || name === "UNLINK") out.keys = rest.length;
  if (name === "FLUSHDB" || name === "FLUSHALL" || name === "SHUTDOWN" || name === "SWAPDB") out.target = null;
  return out;
}

// ---------------------------------------------------------------- v0.17: Kafka actions

/** What a Kafka console line does (`produce`, `create topic`, `delete topic` change the cluster; the rest read). */
export function classifyKafkaCommand(line: string): CommandClass {
  const args = redisArgs(line.trim());
  const w0 = (args[0] ?? "").toLowerCase();
  const w1 = (args[1] ?? "").toLowerCase();
  const out: CommandClass = { kind: w0, write: false, destructive: false, target: null, keys: 0 };
  if (w0 === "produce") {
    out.write = true;
    out.target = args[1] ?? null;
  } else if ((w0 === "create" || w0 === "delete") && w1 === "topic") {
    out.kind = `${w0} topic`;
    out.write = true;
    out.destructive = w0 === "delete";
    out.target = args[2] ?? null;
  }
  return out;
}

/** Kafka actions of the panes (dialogs), for the production confirmation. */
export type KafkaAction =
  | { kind: "produce"; topic: string; partition: number | null; key: string | null; value: string | null; headers: number }
  | { kind: "create topic"; topic: string; partitions: number; replication: number }
  | { kind: "delete topic"; topic: string }
  | { kind: "reset offsets"; group: string; topic: string; to: string; value: number | null; partitions: number };

/** The equivalent console command / description shown in the confirmation's code block. */
export function kafkaActionText(a: KafkaAction): string {
  const arg = (s: string): string => (/^[^\s"'=]+$/.test(s) ? s : JSON.stringify(s));
  if (a.kind === "produce") {
    const v = a.value === null ? null : a.value.length > 600 ? a.value.slice(0, 600) + "…" : a.value;
    return ["produce", arg(a.topic), a.key !== null ? `key=${arg(a.key)}` : "", a.partition !== null ? `partition=${a.partition}` : "", a.headers ? `(+${a.headers} header${a.headers === 1 ? "" : "s"})` : "", v !== null ? `value=${arg(v)}` : ""].filter(Boolean).join(" ");
  }
  if (a.kind === "create topic") return `create topic ${arg(a.topic)} partitions=${a.partitions} replication=${a.replication}`;
  if (a.kind === "delete topic") return `delete topic ${arg(a.topic)}`;
  return `reset offsets of group ${arg(a.group)} on ${arg(a.topic)} to ${a.to}${a.value !== null ? " " + a.value : ""}`;
}

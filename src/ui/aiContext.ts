// Pure helpers of the AI assistant's schema context (no DOM, no Tauri): picking the tables a request is about and
// rendering them as CREATE TABLE text, plus sample-row helpers. Re-exported by ai.ts; node-tested by
// scripts/test-ai-context.mjs.
import type { Cell, Driver, QueryResult, SchemaNode, TableNode } from "../types";
import { quoteIdent } from "./sqlutil";

export const DIALECT_NAMES: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  mssql: "SQL Server (T-SQL)",
};


// ---------------------------------------------------------------- schema context

export interface PickedTable {
  schema: string;
  table: TableNode;
  score: number;
}

export interface SchemaContext {
  /** CREATE TABLE-like text sent to the provider. */
  text: string;
  /** Tables sent with columns (best match first). */
  tables: PickedTable[];
  /** True when tables were picked from the request (else the whole schema or a names-only list). */
  picked: boolean;
  /** Only table names were sent (big schema, nothing matched). */
  namesOnly: boolean;
}

/** Tables sent in full per request (split across the sources of a cross-source request). */
export const MAX_TABLES = 25;
/** Without picking, schemas up to this many tables are sent in full. */
const FULL_SCHEMA_MAX = 60;
const MAX_COLUMNS = 80;
export const MAX_NAMES = 300;
export const MAX_CHARS = 60_000;
const GENERIC_COLUMNS = new Set(["id", "name", "type", "value", "data", "created", "updated", "created_at", "updated_at", "description", "uuid"]);

/** Lower-case words of the text, with naive singular / plural variants ("orders" → order, "categories" → category). */
export function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []) {
    const parts = [raw, ...raw.split("_").filter((p) => p.length > 0)];
    for (const w of parts) {
      out.add(w);
      if (w.endsWith("ies") && w.length > 4) out.add(w.slice(0, -3) + "y");
      else if (w.endsWith("es") && w.length > 4) out.add(w.slice(0, -2));
      if (w.endsWith("s") && w.length > 3) out.add(w.slice(0, -1));
      else out.add(w + "s");
    }
  }
  return out;
}

export function scoreTable(schema: string, t: TableNode, words: Set<string>, textLower: string): number {
  const name = t.name.toLowerCase();
  let score = 0;
  if (words.has(name) || textLower.includes(`${schema.toLowerCase()}.${name}`)) score += 10;
  else {
    // a multi-word name ("order_items") whose parts all appear
    const parts = name.split(/[_\s]+/).filter((p) => p.length >= 3);
    if (parts.length > 1 && parts.every((p) => words.has(p))) score += 8;
    else for (const p of parts) if (words.has(p)) score += 3;
  }
  let cols = 0;
  for (const c of t.columns) {
    const cn = c.name.toLowerCase();
    if (cn.length >= 3 && !GENERIC_COLUMNS.has(cn) && words.has(cn)) cols++;
  }
  return score + Math.min(cols, 4);
}

/** Display name the model should use: schema-qualified for PostgreSQL / SQL Server, quoted only when needed. */
export function displayName(driver: Driver, schema: string, table: string): string {
  const id = (n: string): string => ((driver === "postgres" ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/).test(n) ? n : quoteIdent(driver, n));
  const qualify = driver === "postgres" || driver === "mssql";
  return qualify ? `${id(schema)}.${id(table)}` : id(table);
}

/**
 * `CREATE TABLE name (…)` of one table. `nameOf` names tables (default: `displayName`), `colDriver` quotes columns
 * (cross-source queries run in SQLite, so their columns are quoted the SQLite way).
 */
export function renderTable(driver: Driver, schema: string, t: TableNode, nameOf?: (schema: string, table: string) => string, colDriver: Driver = driver): string {
  const nm = nameOf ?? ((s: string, tb: string): string => displayName(driver, s, tb));
  const name = nm(schema, t.name);
  const id = (n: string): string => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n) ? n : quoteIdent(colDriver, n));
  const lines: string[] = [];
  for (const c of t.columns.slice(0, MAX_COLUMNS)) lines.push(`  ${id(c.name)} ${c.dataType}${c.nullable ? "" : " NOT NULL"}`);
  if (t.columns.length > MAX_COLUMNS) lines.push(`  -- … ${t.columns.length - MAX_COLUMNS} more columns`);
  if (t.kind === "table" && t.primaryKey.length) lines.push(`  PRIMARY KEY (${t.primaryKey.map(id).join(", ")})`);
  for (const fk of t.foreignKeys) {
    const ref = nm(fk.refSchema ?? schema, fk.refTable);
    lines.push(`  FOREIGN KEY (${fk.columns.map(id).join(", ")}) REFERENCES ${ref} (${fk.refColumns.map(id).join(", ")})`);
  }
  const kind = t.kind === "table" ? "TABLE" : t.kind === "materialized" ? "MATERIALIZED VIEW" : "VIEW";
  const comment = t.comment ? ` -- ${t.comment.replace(/\s+/g, " ").slice(0, 200)}` : "";
  return `CREATE ${kind} ${name} (${comment}\n${lines.join(",\n")}\n);`;
}

export interface ContextInput {
  driver: Driver;
  schemas: SchemaNode[];
  database: string | null;
  defaultSchema: string | null;
  /** The request text plus any SQL / error it is about (used to pick tables). */
  text: string;
  autoTables: boolean;
}

/** What `pickTables` chose: tables to send in full (best first) and how they were chosen. */
export interface TablePick {
  full: PickedTable[];
  picked: boolean;
  namesOnly: boolean;
  all: { schema: string; table: TableNode }[];
}

/**
 * Tables of `schemas` to send in full for a request (CONTRACT.md v0.12 › Schema context): with `autoTables` the
 * ones scoring ≥ 2 (max `budget`) + their FK neighbours; nothing matched → all when ≤ `budget`, else names only.
 * Without `autoTables`: all when ≤ 60 tables, else as with it.
 */
export function pickTables(schemas: SchemaNode[], text: string, defaultSchema: string | null, autoTables: boolean, budget: number = MAX_TABLES): TablePick {
  const all: { schema: string; table: TableNode }[] = [];
  for (const s of schemas) for (const t of s.tables) all.push({ schema: s.name, table: t });
  const words = wordsOf(text);
  const lower = text.toLowerCase();
  const scored: PickedTable[] = all
    .map((x) => ({ ...x, score: scoreTable(x.schema, x.table, words, lower) }))
    .filter((x) => x.score >= 2)
    // ties: the default schema first
    .sort((a, b) => b.score - a.score || Number(b.schema === defaultSchema) - Number(a.schema === defaultSchema));

  let full: PickedTable[] = [];
  let picked = false;
  let namesOnly = false;
  if (!autoTables && budget >= MAX_TABLES && all.length <= FULL_SCHEMA_MAX) {
    full = all.map((x) => ({ ...x, score: 0 }));
  } else if (scored.length > 0) {
    picked = true;
    full = scored.slice(0, budget);
    // plus the tables they reference and the tables referencing them (joins usually need them)
    const key = (schema: string, table: string): string => `${schema.toLowerCase()}.${table.toLowerCase()}`;
    const have = new Set(full.map((x) => key(x.schema, x.table.name)));
    const byKey = new Map(all.map((x) => [key(x.schema, x.table.name), x] as const));
    const strong = full.filter((x) => x.score >= 3);
    const add = (x: { schema: string; table: TableNode } | undefined): void => {
      if (!x || full.length >= budget) return;
      const k = key(x.schema, x.table.name);
      if (have.has(k)) return;
      have.add(k);
      full.push({ ...x, score: 0 });
    };
    for (const p of strong) for (const fk of p.table.foreignKeys) add(byKey.get(key(fk.refSchema ?? p.schema, fk.refTable)));
    for (const x of all) {
      if (full.length >= budget) break;
      if (x.table.foreignKeys.some((fk) => strong.some((p) => key(fk.refSchema ?? x.schema, fk.refTable) === key(p.schema, p.table.name)))) add(x);
    }
  } else if (all.length <= budget) {
    full = all.map((x) => ({ ...x, score: 0 }));
  } else {
    namesOnly = true;
  }
  return { full, picked, namesOnly, all };
}

/** Builds the schema summary for a request (see CONTRACT.md v0.12 › AI assistant for the rules). */
export function buildSchemaContext(inp: ContextInput): SchemaContext {
  const { full, picked, namesOnly, all } = pickTables(inp.schemas, inp.text, inp.defaultSchema, inp.autoTables);

  const dialect = DIALECT_NAMES[inp.driver] ?? "SQL";
  const head = [`-- ${dialect}`];
  if (inp.database) head.push(`database ${inp.database}`);
  if (inp.defaultSchema && (inp.driver === "postgres" || inp.driver === "mssql")) head.push(`default schema ${inp.defaultSchema}`);
  const parts: string[] = [head.join(" · ")];
  let size = parts[0].length;
  const sent: PickedTable[] = [];
  for (const x of full) {
    const t = renderTable(inp.driver, x.schema, x.table);
    if (size + t.length > MAX_CHARS) break;
    parts.push(t);
    size += t.length;
    sent.push(x);
  }
  const sentKeys = new Set(sent.map((x) => `${x.schema}.${x.table.name}`));
  const rest = all.filter((x) => !sentKeys.has(`${x.schema}.${x.table.name}`));
  if (rest.length > 0) {
    const names = rest.slice(0, MAX_NAMES).map((x) => displayName(inp.driver, x.schema, x.table.name));
    const more = rest.length > MAX_NAMES ? ` … and ${rest.length - MAX_NAMES} more` : "";
    parts.push(`-- ${sent.length ? "Other tables" : "Tables"} (names only): ${names.join(", ")}${more}`);
  }
  if (all.length === 0) parts.push("-- (no tables loaded for this database)");
  return { text: parts.join("\n\n"), tables: sent, picked, namesOnly };
}

// ---------------------------------------------------------------- sample rows

export const SAMPLE_ROWS = 20;
/** Sample rows are fetched for at most this many of the picked tables. */
export const SAMPLE_TABLES = 3;

/** `SELECT * … LIMIT 20` (SQL Server: TOP 20) for one table, identifiers quoted. */
export function sampleSql(driver: Driver, schema: string, table: string): string {
  const q = (driver === "postgres" || driver === "mssql" ? quoteIdent(driver, schema) + "." : "") + quoteIdent(driver, table);
  return driver === "mssql" ? `SELECT TOP ${SAMPLE_ROWS} * FROM ${q}` : `SELECT * FROM ${q} LIMIT ${SAMPLE_ROWS}`;
}

function cellText(v: Cell): string {
  if (v === null) return "NULL";
  const s = typeof v === "string" ? v : String(v);
  const one = s.replace(/\s+/g, " ");
  return one.length > 40 ? one.slice(0, 40) + "…" : one;
}

/** Sample rows as SQL comments under a heading. */
export function renderSamples(driver: Driver, schema: string, table: string, res: QueryResult): string {
  const out = [`-- ${res.rows.length} sample rows of ${displayName(driver, schema, table)}:`, "-- " + res.columns.map((c) => c.name).join(" | ")];
  for (const r of res.rows.slice(0, SAMPLE_ROWS)) out.push("-- " + r.map(cellText).join(" | "));
  return out.join("\n");
}

// AI assistant: provider status, production detection and the schema context sent with a request.
// No UI here (see aiPanel.ts / aiEditor.ts / aiSettings.ts). The backend side is src-tauri/src/ai.rs.
import { api } from "../api";
import type { AiProviderId, AiProviderStatus, Cell, ConnectionConfig, Driver, QueryResult, SchemaNode, TableNode } from "../types";
import { getSettings } from "./settings";
import type { AppSettings } from "./settings";
import { quoteIdent } from "./sqlutil";

export const AI_PROVIDER_NAMES: Record<AiProviderId, string> = {
  codex: "Codex CLI",
  claude: "Claude Code CLI",
  openai: "API key",
  ollama: "Ollama (local)",
};

/** Drivers the assistant writes for (Redis / Kafka consoles get no AI). */
export const AI_DRIVERS: ReadonlySet<Driver> = new Set<Driver>(["postgres", "mysql", "sqlite", "mssql"]);

export const DIALECT_NAMES: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  mssql: "SQL Server (T-SQL)",
};

// ---------------------------------------------------------------- production data sources

/** "prod" / "production" as a word of the name or folder ("Prod PG", "eu-prod", "prod_db", folder "Production"). */
const PROD = /(?:^|[^a-z0-9])prod(?:uction)?(?:[^a-z0-9]|$)/i;

/** A data source is treated as production when it is read-only or its name / folder says "prod". */
export function isProdConnection(c: ConnectionConfig | null | undefined): boolean {
  if (!c) return false;
  return c.readOnly === true || PROD.test(c.name) || PROD.test(c.folder ?? "");
}

/** Why AI is refused for this data source (Settings › Block AI for production), or null. */
export function aiBlockedReason(c: ConnectionConfig | null | undefined, s: AppSettings = getSettings()): string | null {
  if (!c || !s.ai.blockProd || !isProdConnection(c)) return null;
  const why = c.readOnly ? "is read-only" : "looks like production";
  return `AI is off for “${c.name}”: it ${why} and “Block AI for production data sources” is on (Settings › AI assistant).`;
}

/** Sample rows may be sent: the setting is on and the data source is neither read-only nor production. */
export function samplesAllowed(c: ConnectionConfig | null | undefined, s: AppSettings = getSettings()): boolean {
  return !!c && s.ai.samples && !isProdConnection(c);
}

// ---------------------------------------------------------------- providers

let providerCache: { at: number; list: Promise<AiProviderStatus[]> } | null = null;

/** Provider status (cached 30 s; `force` re-detects). Never rejects: a failure yields []. */
export function loadProviders(force = false): Promise<AiProviderStatus[]> {
  const now = Date.now();
  if (!force && providerCache && now - providerCache.at < 30_000) return providerCache.list;
  const list = api.aiProviders().catch(() => [] as AiProviderStatus[]);
  providerCache = { at: now, list };
  return list;
}

/** Short label of the configured provider for the prompt box chip ("Codex · ChatGPT sign-in"). */
export function providerChip(s: AppSettings, status: AiProviderStatus | undefined): string {
  const a = s.ai;
  switch (a.provider) {
    case "codex":
      return status?.signedIn ? "Codex · ChatGPT sign-in" : a.model ? `Codex · ${a.model}` : "Codex";
    case "claude":
      return a.model ? `Claude Code · ${a.model}` : "Claude Code";
    case "openai":
      return `API · ${a.model || "gpt-4o-mini"}`;
    case "ollama":
      return `Ollama · ${a.ollamaModel || status?.models[0] || "local"}`;
  }
}

/** Short provider name for result bars ("Codex · 2.1 s"). */
export function providerShort(id: AiProviderId): string {
  return id === "codex" ? "Codex" : id === "claude" ? "Claude Code" : id === "openai" ? "API" : "Ollama";
}

/** Model to send for the configured provider (null = provider default). */
export function modelFor(s: AppSettings): string | null {
  const m = s.ai.provider === "ollama" ? s.ai.ollamaModel : s.ai.model;
  return m.trim() ? m.trim() : null;
}

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

const MAX_TABLES = 25;
/** Without picking, schemas up to this many tables are sent in full. */
const FULL_SCHEMA_MAX = 60;
const MAX_COLUMNS = 80;
const MAX_NAMES = 300;
const MAX_CHARS = 60_000;
const GENERIC_COLUMNS = new Set(["id", "name", "type", "value", "data", "created", "updated", "created_at", "updated_at", "description", "uuid"]);

/** Lower-case words of the text, with naive singular / plural variants ("orders" → order, "categories" → category). */
function wordsOf(text: string): Set<string> {
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

function scoreTable(schema: string, t: TableNode, words: Set<string>, textLower: string): number {
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

function renderTable(driver: Driver, schema: string, t: TableNode): string {
  const name = displayName(driver, schema, t.name);
  const id = (n: string): string => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n) ? n : quoteIdent(driver, n));
  const lines: string[] = [];
  for (const c of t.columns.slice(0, MAX_COLUMNS)) lines.push(`  ${id(c.name)} ${c.dataType}${c.nullable ? "" : " NOT NULL"}`);
  if (t.columns.length > MAX_COLUMNS) lines.push(`  -- … ${t.columns.length - MAX_COLUMNS} more columns`);
  if (t.kind === "table" && t.primaryKey.length) lines.push(`  PRIMARY KEY (${t.primaryKey.map(id).join(", ")})`);
  for (const fk of t.foreignKeys) {
    const ref = displayName(driver, fk.refSchema ?? schema, fk.refTable);
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

/** Builds the schema summary for a request (see CONTRACT.md v0.12 › AI assistant for the rules). */
export function buildSchemaContext(inp: ContextInput): SchemaContext {
  const all: { schema: string; table: TableNode }[] = [];
  for (const s of inp.schemas) for (const t of s.tables) all.push({ schema: s.name, table: t });
  const words = wordsOf(inp.text);
  const lower = inp.text.toLowerCase();
  const scored: PickedTable[] = all
    .map((x) => ({ ...x, score: scoreTable(x.schema, x.table, words, lower) }))
    .filter((x) => x.score >= 2)
    // ties: the default schema first
    .sort((a, b) => b.score - a.score || Number(b.schema === inp.defaultSchema) - Number(a.schema === inp.defaultSchema));

  let full: PickedTable[] = [];
  let picked = false;
  let namesOnly = false;
  if (!inp.autoTables && all.length <= FULL_SCHEMA_MAX) {
    full = all.map((x) => ({ ...x, score: 0 }));
  } else if (scored.length > 0) {
    picked = true;
    full = scored.slice(0, MAX_TABLES);
    // plus the tables they reference and the tables referencing them (joins usually need them)
    const key = (schema: string, table: string): string => `${schema.toLowerCase()}.${table.toLowerCase()}`;
    const have = new Set(full.map((x) => key(x.schema, x.table.name)));
    const byKey = new Map(all.map((x) => [key(x.schema, x.table.name), x] as const));
    const strong = full.filter((x) => x.score >= 3);
    const add = (x: { schema: string; table: TableNode } | undefined): void => {
      if (!x || full.length >= MAX_TABLES) return;
      const k = key(x.schema, x.table.name);
      if (have.has(k)) return;
      have.add(k);
      full.push({ ...x, score: 0 });
    };
    for (const p of strong) for (const fk of p.table.foreignKeys) add(byKey.get(key(fk.refSchema ?? p.schema, fk.refTable)));
    for (const x of all) {
      if (full.length >= MAX_TABLES) break;
      if (x.table.foreignKeys.some((fk) => strong.some((p) => key(fk.refSchema ?? x.schema, fk.refTable) === key(p.schema, p.table.name)))) add(x);
    }
  } else if (all.length <= MAX_TABLES) {
    full = all.map((x) => ({ ...x, score: 0 }));
  } else {
    namesOnly = true;
  }

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

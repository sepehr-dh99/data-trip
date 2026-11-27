// AI assistant × cross-source queries (CONTRACT.md v0.15): the "Data sources you can use" list sent with every
// request, detection of requests that need other data sources, the cross-source rules + per-source schemas, and a
// local check of generated cross-source SQL (one automatic refine round fixes what it finds).
// Pure (no DOM, no Tauri): node-tested by scripts/test-ai-context.mjs.
import type { Driver, SchemaNode, TableNode } from "../types";
import { findTableRefs, resolveSource, routeStatement, sourceSlug, tableRef } from "./federation";
import type { RouteContext } from "./federation";
import { DIALECT_NAMES, MAX_CHARS, MAX_NAMES, MAX_TABLES, pickTables, renderTable, wordsOf } from "./aiContext";

/** What the assistant knows about one SQL data source (the explorer's cache; nothing is loaded here). */
export interface AiSourceInfo {
  connId: string;
  name: string;
  driver: Driver;
  /** How it is written in SQL: its slug, or its quoted name (`sourceRef`). */
  ref: string;
  /** Database it reads from: the console's current one (own source), the attachment's, else the default. */
  database: string | null;
  /** Databases of its server (cached explorer list). */
  databases: { name: string; isSystem: boolean }[];
  /** Introspection of `database` (empty when not loaded). */
  schemas: SchemaNode[];
  defaultSchema: string | null;
  /** The console's own data source. */
  own: boolean;
  /** AI is off for it (production / read-only with “Block AI for production data sources” on). */
  blocked: boolean;
}

const MAX_LISTED = 60;
/** Slugs / database names too generic to count as "the request names that source". */
const GENERIC = new Set(["db", "database", "data", "main", "local", "source", "sources", "server", "test", "default", "public", "dbo", "table", "tables", "query", "sql", "new", "old", "all"]);

const driverName = (d: Driver): string => (DIALECT_NAMES[d] ?? d).replace(/ \(T-SQL\)$/, "");

/**
 * The compact list of SQL data sources sent with every request: SQL name, driver and, for the console's own
 * source, its current database. Names only (no schema). Blocked (production) sources are left out.
 */
export function sourcesSection(sources: readonly AiSourceInfo[]): string {
  const usable = sources.filter((s) => s.own || !s.blocked);
  if (usable.length === 0) return "";
  const own = usable.filter((s) => s.own);
  const rest = usable.filter((s) => !s.own);
  const lines = ["Data sources you can use (a query may combine them as source.database.table):"];
  for (const s of [...own, ...rest].slice(0, MAX_LISTED)) {
    const bits = [driverName(s.driver)];
    if (s.own) bits.push("this console" + (s.database ? ` · current database ${s.database}` : ""));
    lines.push(`- ${s.ref} — ${bits.join(" · ")}`);
  }
  if (usable.length > MAX_LISTED) lines.push(`- … and ${usable.length - MAX_LISTED} more`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- detection

export interface CrossDetect {
  /** Other (usable) sources the request involves, in catalog order. */
  involved: string[];
  /** Why each source was picked: "named", "used in the SQL", "table orders", "database shop", "tables". */
  reasons: Record<string, string>;
  /** The request asks for a cross-source query in words ("across sources", "cross-source", …). */
  explicit: boolean;
  /** Involved sources AI may not use; `essential` = the request names it (or the SQL uses it). */
  blocked: { connId: string; essential: boolean }[];
  /** Cross-source rules apply to this request. */
  cross: boolean;
}

const EXPLICIT: RegExp[] = [
  /\bcross[\s_-]?(?:source|database|db|server|connection)s?\b/i,
  /\bfederat(?:e|ed|ion)\b/i,
  /\b(?:across|between|both|several|multiple|different|two|three|other)\b[^.?!\n]{0,40}\b(?:data[\s_-]?sources?|sources|databases|dbs|servers|connections)\b/i,
  /\b(?:join|compare|combine|match|merge|union|correlate)\b[^.?!\n]{0,60}\b(?:with|against|to|from|and|in|on)\b[^.?!\n]{0,40}\b(?:data[\s_-]?source|other source|another source|other server|another server|other database|another database)\b/i,
];

/** "Stage MySQL!" → "_stage_mysql_" (word-boundary matching of slugs). */
function normWords(text: string): string {
  return "_" + text.toLowerCase().replace(/[^a-z0-9]+/g, "_") + "_";
}

/** Table names compared without a trailing plural "s". */
const tkey = (n: string): string => n.toLowerCase().replace(/s$/, "");

function tablesOf(s: AiSourceInfo): TableNode[] {
  return s.schemas.flatMap((x) => x.tables);
}

/**
 * Other data sources a request needs, from the request text (and the SQL it is about) and cached metadata only:
 * a source's name / slug in the text; a table or database (≥ 4 / ≥ 3 characters) that exists only on another
 * source (only once this console's own schema is loaded); the connIds `sqlUses` (sources the current SQL already
 * reads from). Words like "across sources" / "cross-source" make it explicit: then tables named in the request
 * pick sources even when the console's own source has a table of that name too.
 */
export function detectCrossSource(text: string, sources: readonly AiSourceInfo[], sqlUses: readonly string[] = []): CrossDetect {
  const own = sources.find((s) => s.own) ?? null;
  const norm = normWords(text);
  const words = wordsOf(text);
  const explicit = EXPLICIT.some((re) => re.test(text));
  const ownTables = new Set(own ? tablesOf(own).map((t) => tkey(t.name)) : []);
  const ownLoaded = ownTables.size > 0;
  const ownDbs = new Set((own?.databases ?? []).map((d) => d.name.toLowerCase()));
  if (own?.database) ownDbs.add(own.database.toLowerCase());
  const reasons: Record<string, string> = {};
  const order: string[] = [];
  const pick = (id: string, why: string): void => {
    if (reasons[id] === undefined) order.push(id);
    // the strongest reason wins: named / used in the SQL over table / database hits
    if (reasons[id] === undefined || why === "named" || why === "used in the SQL") reasons[id] = why;
  };
  for (const s of sources) {
    if (s.own) continue;
    if (sqlUses.includes(s.connId)) pick(s.connId, "used in the SQL");
    const slug = sourceSlug(s.name);
    const quoted = [`"${s.name}"`, `\`${s.name}\``, `[${s.name}]`].some((q) => text.toLowerCase().includes(q.toLowerCase()));
    if (quoted || (slug.length >= 3 && !GENERIC.has(slug) && norm.includes(`_${slug}_`))) {
      pick(s.connId, "named");
      continue;
    }
    // A table named in the request that only this source has (or, explicitly cross-source, any it has).
    if (ownLoaded || explicit) {
      const hit = tablesOf(s).find((t) => {
        const n = t.name.toLowerCase();
        return n.length >= 4 && !GENERIC.has(n) && words.has(n) && (explicit || !ownTables.has(tkey(n)));
      });
      if (hit) {
        pick(s.connId, `table ${hit.name}`);
        continue;
      }
    }
    // A database of that server named in the request that this console's server doesn't have.
    const db = s.databases.find((d) => {
      const n = d.name.toLowerCase();
      return !d.isSystem && n.length >= 3 && !GENERIC.has(n) && !ownDbs.has(n) && words.has(n);
    });
    if (db) pick(s.connId, `database ${db.name}`);
  }
  const involved: string[] = [];
  const blocked: { connId: string; essential: boolean }[] = [];
  for (const id of order) {
    const s = sources.find((x) => x.connId === id);
    if (!s) continue;
    if (s.blocked) blocked.push({ connId: id, essential: reasons[id] === "named" || reasons[id] === "used in the SQL" });
    else involved.push(id);
  }
  const others = sources.some((s) => !s.own && !s.blocked);
  return { involved, reasons, explicit, blocked, cross: involved.length > 0 || (explicit && others) };
}

// ---------------------------------------------------------------- rules + schemas

/** `ref.db.table` the way `federated_execute` resolves it (columns quoted the SQLite way). */
function refName(s: AiSourceInfo): (schema: string, table: string) => string {
  return (schema: string, table: string): string => tableRef(s.ref, s.driver, s.driver === "sqlite" ? null : s.database, schema, table);
}

/** The cross-source rules with a short example over the involved sources (own first). */
export function crossRules(sources: readonly AiSourceInfo[]): string {
  const a = sources[0];
  const b = sources.find((s) => s !== a) ?? null;
  const ex = (s: AiSourceInfo | null, fallbackRef: string, table: string): string => {
    if (!s) return `${fallbackRef}.shop.${table}`;
    const def = s.driver === "postgres" ? "public" : s.driver === "mssql" ? "dbo" : s.database ?? "main";
    return tableRef(s.ref, s.driver, s.driver === "sqlite" ? null : s.database ?? "database", def, table);
  };
  const ta = ex(a ?? null, "asia32", "users");
  const tb = ex(b, "stage_mysql", "orders");
  return [
    "Cross-source query rules (DataTrip pulls each table from its data source, then runs the outer query itself):",
    "1. Write EVERY table as source.database.table — also the tables of this console's own data source. PostgreSQL / SQL Server tables in a schema other than public / dbo: source.database.schema.table. SQLite: source.main.table. Use exactly the names of the schema below.",
    "2. source is the data source's SQL name from the list above (lower case, _ for spaces and other characters). A name that isn't a plain identifier is written as its exact name in double quotes: \"Odd Name\".database.table.",
    "3. The outer query runs in SQLite: use SQLite syntax and functions only — strftime('%Y-%m', col), date('now', '-30 days'), datetime('now'), || to concatenate, CAST(x AS INTEGER|REAL|TEXT), COALESCE / IFNULL, LIKE (no ILIKE: LIKE ignores ASCII case; or lower(x) LIKE …), LIMIT n. No TOP, no ::casts, no NOW(), DATE_TRUNC, EXTRACT, INTERVAL, GETDATE() or DATEADD. Dates and timestamps arrive as ISO text.",
    "4. Give every table an alias and qualify every column with it (a.col); avoid SELECT *. Put filters on one table into WHERE (a.created_at >= '2026-01-01'): they are pushed down to that data source, so less data is pulled (at most 200 000 rows per table).",
    "5. Read only: exactly one SELECT (or WITH … SELECT). No INSERT, UPDATE, DELETE or DDL. Results are read-only.",
    "Example (shape only — use the real tables and columns below):",
    `    SELECT u.id, u.email, COUNT(o.id) AS order_count`,
    `    FROM ${ta} AS u`,
    `    JOIN ${tb} AS o ON o.user_id = u.id`,
    `    WHERE o.created_at >= '2026-01-01'`,
    `    GROUP BY u.id, u.email`,
    `    ORDER BY order_count DESC`,
    `    LIMIT 100;`,
  ].join("\n");
}

export interface CrossTable {
  connId: string;
  ref: string;
  schema: string;
  table: TableNode;
}

export interface CrossContext {
  /** Rules + per-source CREATE TABLE text (cross-source names). */
  text: string;
  /** Tables sent in full, best first per source. */
  tables: CrossTable[];
  /** Tables sent per source. */
  perSource: Record<string, number>;
}

/**
 * Schemas of every involved source (own first) under cross-source names, the 25-table budget split across them:
 * each gets an equal share of what it wants (its picked tables, CONTRACT v0.12 rules), leftovers go to the sources
 * that want more, in order. The rest of each source as one names-only line.
 */
export function buildCrossContext(sources: readonly AiSourceInfo[], text: string, autoTables: boolean): CrossContext {
  const list = sources.filter((s) => !s.blocked || s.own);
  const picks = list.map((s) => pickTables(s.schemas, text, s.defaultSchema, autoTables, MAX_TABLES));
  const want = picks.map((p) => (p.namesOnly ? 0 : p.full.length));
  const n = Math.max(1, list.length);
  const share = Math.floor(MAX_TABLES / n);
  const alloc = want.map((w) => Math.min(w, share));
  let left = MAX_TABLES - alloc.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length && left > 0; i++) {
    const more = Math.min(left, want[i] - alloc[i]);
    alloc[i] += more;
    left -= more;
  }
  const parts: string[] = [crossRules(list)];
  let size = parts[0].length;
  const tables: CrossTable[] = [];
  const perSource: Record<string, number> = {};
  const namesCap = Math.max(20, Math.floor(MAX_NAMES / n));
  list.forEach((s, i) => {
    const nm = refName(s);
    const head = [`-- ${s.ref} (${driverName(s.driver)})`];
    if (s.database && s.driver !== "sqlite") head.push(`database ${s.database}`);
    if (s.own) head.push("this console's data source");
    parts.push(head.join(" · "));
    const sent: { schema: string; table: TableNode }[] = [];
    for (const x of picks[i].full.slice(0, alloc[i])) {
      const t = renderTable(s.driver, x.schema, x.table, nm, "sqlite");
      if (size + t.length > MAX_CHARS) break;
      parts.push(t);
      size += t.length;
      sent.push(x);
      tables.push({ connId: s.connId, ref: s.ref, schema: x.schema, table: x.table });
    }
    perSource[s.connId] = sent.length;
    const sentKeys = new Set(sent.map((x) => `${x.schema}.${x.table.name}`));
    const rest = picks[i].all.filter((x) => !sentKeys.has(`${x.schema}.${x.table.name}`));
    if (rest.length > 0) {
      const names = rest.slice(0, namesCap).map((x) => nm(x.schema, x.table.name));
      const more = rest.length > namesCap ? ` … and ${rest.length - namesCap} more` : "";
      const line = `-- ${sent.length ? "Other tables" : "Tables"} of ${s.ref} (names only): ${names.join(", ")}${more}`;
      if (size + line.length <= MAX_CHARS) {
        parts.push(line);
        size += line.length;
      }
    }
    if (picks[i].all.length === 0) parts.push(`-- (no tables loaded for ${s.ref})`);
  });
  return { text: parts.join("\n\n"), tables, perSource };
}

// ---------------------------------------------------------------- checking generated SQL

/** Strings and comments blanked (quoted identifiers kept): keyword checks of the outer query. */
function codeText(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** CTE names (`WITH x AS (`, `, y (a, b) AS (`), lower case. */
function cteNames(code: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:\bwith\s+(?:recursive\s+)?|,\s*)("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*(?:\([^)]*\)\s*)?as\s*(?:(?:not\s+)?materialized\s*)?\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.add(m[1].replace(/^["`[]|["`\]]$/g, "").toLowerCase());
  return out;
}

const STOP_FROM = new Set(["where", "group", "order", "having", "limit", "window", "union", "except", "intersect", "on", "using", "offset", "fetch", "returning", "set", "values", "join", "left", "right", "inner", "outer", "full", "cross", "natural"]);

/** One-part table names in table positions (FROM of a SELECT level, JOIN, FROM-list commas), outside strings. */
function bareTables(code: string): string[] {
  const toks = code.match(/"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w$]*|[0-9.]+|\S/g) ?? [];
  const out: string[] = [];
  const sel: boolean[] = [false];
  const inFrom: boolean[] = [false];
  let expect = false;
  const isName = (t: string | undefined): boolean => t !== undefined && /^(?:"|`|\[|[A-Za-z_])/.test(t);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const w = t.toLowerCase();
    const top = sel.length - 1;
    if (t === "(") {
      sel.push(false);
      inFrom.push(false);
      expect = false;
      continue;
    }
    if (t === ")") {
      if (sel.length > 1) {
        sel.pop();
        inFrom.pop();
      }
      expect = false;
      continue;
    }
    if (t === ",") {
      expect = inFrom[top];
      continue;
    }
    if (w === "select") {
      sel[top] = true;
      inFrom[top] = false;
      expect = false;
      continue;
    }
    if ((w === "from" && sel[top]) || w === "join") {
      inFrom[top] = true;
      expect = true;
      continue;
    }
    if (STOP_FROM.has(w)) {
      if (w !== "join" && !["left", "right", "inner", "outer", "full", "cross", "natural"].includes(w)) inFrom[top] = false;
      expect = false;
      continue;
    }
    if (expect && (w === "lateral" || w === "only")) continue;
    if (expect && isName(t)) {
      const next = toks[i + 1];
      if (next !== "." && next !== "(") out.push(t.replace(/^["`[]|["`\]]$/g, ""));
      // skip the rest of a dotted name
      while (toks[i + 1] === "." && isName(toks[i + 2])) i += 2;
    }
    expect = false;
  }
  return out;
}

export interface CrossCheck {
  /** The SQL runs across sources (`routeStatement`). */
  federated: boolean;
  /** What is wrong, phrased for the refine request ("unknown data source 'x'", "used ILIKE …"). */
  problems: string[];
}

const DIALECT_CHECKS: [RegExp, string][] = [
  [/\bilike\b/i, "used ILIKE in the outer query — it runs in SQLite, which has no ILIKE: use LIKE (ignores ASCII case) or lower(x) LIKE …"],
  [/::\s*[A-Za-z_]/, "used a PostgreSQL ::cast in the outer query — SQLite needs CAST(x AS INTEGER|REAL|TEXT)"],
  [/\bnow\s*\(\s*\)/i, "used NOW() in the outer query — SQLite: datetime('now') or date('now')"],
  [/\bdate_trunc\s*\(/i, "used DATE_TRUNC in the outer query — SQLite: strftime('%Y-%m-01', col) / date(col, 'start of month')"],
  [/\bextract\s*\(/i, "used EXTRACT in the outer query — SQLite: strftime('%Y', col) etc."],
  [/\binterval\s+'/i, "used INTERVAL in the outer query — SQLite: date(col, '-30 days')"],
  [/\b(?:getdate|sysdatetime)\s*\(/i, "used GETDATE() in the outer query — SQLite: datetime('now')"],
  [/\b(?:dateadd|datediff|datepart|datename)\s*\(/i, "used a SQL Server date function in the outer query — SQLite: date() / julianday() / strftime()"],
  [/\bselect\s+(?:distinct\s+)?top\s*\(?\s*\d/i, "used TOP n in the outer query — SQLite: LIMIT n at the end"],
  [/\bisnull\s*\(/i, "used ISNULL() in the outer query — SQLite: IFNULL() or COALESCE()"],
  [/\bto_char\s*\(|\bdate_format\s*\(/i, "used TO_CHAR / DATE_FORMAT in the outer query — SQLite: strftime()"],
  [/\bfetch\s+(?:first|next)\b|\boffset\s+\d+\s+rows?\b/i, "used OFFSET … ROWS / FETCH FIRST in the outer query — SQLite: LIMIT n OFFSET m"],
];

/**
 * Checks generated SQL the way the console would run it (`routeStatement`, RouteContext of the console): ambiguous
 * / unknown data source names, cross-source references missing the database, tables without a data source in a
 * cross-source query, non-SQLite syntax in the outer query, writes, blocked sources, and (when the request named
 * other sources: `expected`) a query that doesn't read from them at all. Empty `problems` = fine.
 */
export function checkCrossSql(sql: string, ctx: RouteContext, sources: readonly AiSourceInfo[], expected: readonly string[] = []): CrossCheck {
  const problems: string[] = [];
  const add = (p: string): void => {
    if (!problems.includes(p) && problems.length < 8) problems.push(p);
  };
  const route = routeStatement(sql, ctx);
  if (route.kind === "error") add(route.message);
  const federated = route.kind === "federated";
  const byId = new Map(sources.map((s) => [s.connId, s] as const));
  const usable = sources.filter((s) => !s.blocked || s.own).map((s) => s.ref);
  const used = new Set<string>();
  for (const ref of findTableRefs(sql)) {
    const first = ref.parts[0];
    const text = ref.parts.map((p) => (p.quoted ? `"${p.text}"` : p.text)).join(".");
    const r = resolveSource(first, ctx);
    if (r?.kind === "ambiguous") continue; // already reported by routeStatement (3+ parts)
    if (r?.kind === "source") {
      const s = byId.get(r.connId);
      if (s?.blocked && !s.own) add(`reads from ${s.name}, a production data source the assistant may not use — leave it out`);
      if (r.connId !== ctx.ownConnId && (r.via === "slug" || r.via === "name") && s && s.driver !== "sqlite" && ref.parts.length < 3) {
        add(`'${text}' is missing the database: write ${tableRef(s.ref, s.driver, s.database ?? "database", null, ref.parts[ref.parts.length - 1].text)}`);
      } else used.add(r.connId);
      continue;
    }
    const native = ctx.nativeNames.has(first.text.toLowerCase());
    if (!native && ref.parts.length >= 3) add(`unknown data source '${first.text}' — the data sources are: ${usable.join(", ")}`);
    else if (federated) add(`'${text}' has no data source — in a cross-source query write every table as source.database.table`);
  }
  if (federated) {
    const code = codeText(sql);
    const ctes = cteNames(code);
    for (const name of bareTables(code)) {
      if (ctes.has(name.toLowerCase())) continue;
      add(`table '${name}' has no data source — in a cross-source query write it as source.database.${name}`);
    }
    for (const [re, msg] of DIALECT_CHECKS) if (re.test(code)) add(msg);
    if (/^\s*(?:insert|update|delete|merge|create|drop|alter|truncate|replace|upsert)\b/i.test(code)) add("writes data — cross-source queries are read-only: write one SELECT");
  }
  const missing = expected.filter((id) => !used.has(id) && byId.get(id) && !byId.get(id)?.blocked);
  if (missing.length > 0 && !federated) {
    const names = missing.map((id) => byId.get(id)?.ref ?? id);
    add(`the query doesn't read from ${names.join(", ")} — write its tables as source.database.table so DataTrip runs it across sources`);
  }
  return { federated, problems };
}

/** The refine instruction of the automatic second round. */
export function refinePrompt(problems: readonly string[]): string {
  return `DataTrip checked this cross-source query before showing it and found: ${problems.map((p) => p.replace(/[.\s]+$/, "")).join("; ")}. Fix exactly these problems and keep everything else.`;
}

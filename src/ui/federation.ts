// Cross-source queries (CONTRACT.md v0.13): data source names in SQL (slugs, quoted names, attached aliases),
// the finder of table references, routing of a console statement and the alias rules of the "Sources" strip.
// Everything above the drag-and-drop section is pure (no DOM) so scripts/test-federation.mjs can run it in node.
import type { Driver, FedSource } from "../types";

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

// ---- data source names in SQL (v0.13)

/**
 * The name a data source answers to in SQL: lower case, every run of characters other than a–z / 0–9 → "_",
 * trimmed of "_" ("Asia32" → asia32, "Stage MySQL" → stage_mysql). Same rule as the backend's `fedsql::slug`.
 * "" when nothing is left (such a source can only be written quoted).
 */
export function sourceSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** A SQL data source of the connection list. */
export interface CatalogSource {
  connId: string;
  name: string;
  driver: Driver;
}

/** How to write a data source in SQL: its slug when that is a plain identifier no other source shares, else its quoted name. */
export function sourceRef(src: CatalogSource, all: readonly CatalogSource[] = []): string {
  const slug = sourceSlug(src.name);
  const shared = all.some((o) => o.connId !== src.connId && sourceSlug(o.name) === slug);
  return /^[a-z_][a-z0-9_]*$/.test(slug) && !shared ? slug : `"${src.name.replace(/"/g, '""')}"`;
}

/** Default schema of `source.database.table` per driver (MySQL / SQLite: none). */
export function defaultSchemaOf(driver: Driver): string | null {
  return driver === "postgres" ? "public" : driver === "mssql" ? "dbo" : null;
}

/**
 * `source.database.table`, or `source.database.schema.table` for a PostgreSQL / SQL Server schema other than
 * public / dbo. SQLite → `source.main.table`; MySQL ignores `schema` (database = schema). No database known →
 * the older `source.schema.table` form.
 */
export function tableRef(src: string, driver: Driver, database: string | null, schema: string | null, table: string): string {
  const t = refPart(table);
  if (driver === "sqlite") return `${src}.main.${t}`;
  if (database === null || database === "") return schema ? `${src}.${refPart(schema)}.${t}` : `${src}.${t}`;
  if (driver === "mysql" || schema === null || schema === defaultSchemaOf(driver)) return `${src}.${refPart(database)}.${t}`;
  return `${src}.${refPart(database)}.${refPart(schema)}.${t}`;
}

/** One name part as written: `text` without quotes; `quoted` for "…", `…` or […]. */
export interface RefPart {
  text: string;
  quoted: boolean;
  from: number;
  to: number;
}

/** A dotted name in a table position (after FROM, JOIN, INTO, UPDATE, or a comma in a FROM list). */
export interface TableRef {
  parts: RefPart[];
  from: number;
  to: number;
}

interface Tok {
  kind: "word" | "quoted" | "punct" | "other";
  text: string;
  from: number;
  to: number;
}

/** Significant tokens of SQL (whitespace, comments and string literals dropped; offsets kept). */
function tokens(sql: string): Tok[] {
  const out: Tok[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const start = i;
      i++;
      let text = "";
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            text += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        text += sql[i++];
      }
      if (c !== "'") out.push({ kind: "quoted", text, from: start, to: i });
      else out.push({ kind: "other", text: "''", from: start, to: i });
    } else if (/[A-Za-z_\u00C0-\uFFFF]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$\u00C0-\uFFFF]/.test(sql[i])) i++;
      out.push({ kind: "word", text: sql.slice(start, i), from: start, to: i });
    } else if (/[0-9]/.test(c)) {
      const start = i;
      while (i < n && /[0-9.eE]/.test(sql[i])) i++;
      out.push({ kind: "other", text: sql.slice(start, i), from: start, to: i });
    } else {
      out.push({ kind: "punct", text: c, from: i, to: i + 1 });
      i++;
    }
  }
  return out;
}

const ENDS_FROM = new Set(["where", "group", "order", "having", "limit", "window", "union", "except", "intersect", "select", "offset", "fetch", "qualify", "returning", "set", "values", "for"]);
const TABLE_KW = new Set(["from", "join", "into", "update"]);

/** Dotted names in table positions, outside strings and comments; only those with 2+ parts. */
export function findTableRefs(sql: string): TableRef[] {
  const ts = tokens(sql);
  const out: TableRef[] = [];
  const inFrom: boolean[] = [false];
  let expect = false;
  const isName = (t: Tok | undefined): boolean => t !== undefined && (t.kind === "word" || t.kind === "quoted");
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    const dotNext = ts[k + 1]?.kind === "punct" && ts[k + 1].text === ".";
    if (t.kind === "punct") {
      if (t.text === "(") {
        inFrom.push(false);
        expect = false;
      } else if (t.text === ")") {
        if (inFrom.length > 1) inFrom.pop();
        expect = false;
      } else if (t.text === "," && inFrom[inFrom.length - 1]) expect = true;
      continue;
    }
    if (t.kind === "word" && !dotNext) {
      const w = t.text.toLowerCase();
      if (TABLE_KW.has(w)) {
        if (w === "from") inFrom[inFrom.length - 1] = true;
        expect = true;
        continue;
      }
      if (ENDS_FROM.has(w)) {
        inFrom[inFrom.length - 1] = false;
        expect = false;
        continue;
      }
      if (expect && (w === "lateral" || w === "only")) continue;
    }
    if (!expect || !isName(t)) {
      expect = false;
      continue;
    }
    expect = false;
    // name (. name)*
    const parts: RefPart[] = [{ text: t.text, quoted: t.kind === "quoted", from: t.from, to: t.to }];
    let j = k + 1;
    while (ts[j]?.kind === "punct" && ts[j].text === "." && isName(ts[j + 1]) && ts[j + 1].from === ts[j].to) {
      const p = ts[j + 1];
      parts.push({ text: p.text, quoted: p.kind === "quoted", from: p.from, to: p.to });
      j += 2;
    }
    if (parts.length >= 2) out.push({ parts, from: parts[0].from, to: parts[parts.length - 1].to });
    k = j - 1;
  }
  return out;
}

/** What the console knows when it decides how a statement runs. */
export interface RouteContext {
  /** The console's own data source. */
  ownConnId: string;
  /** Every SQL data source of the connection list (the console's own included). */
  sources: readonly CatalogSource[];
  /** Sources attached in the Sources strip (aliases are extra names). */
  attached: readonly { alias: string; connId: string }[];
  /** The own source's alias in the Sources strip (null when the strip isn't in use). */
  ownAlias: string | null;
  /** Lower-case databases of the console's server and schemas of its database: native names, never sources. */
  nativeNames: ReadonlySet<string>;
}

/** The data source a reference's first part names. */
export type Resolved =
  | { kind: "source"; connId: string; via: "attached" | "ownAlias" | "name" | "slug"; alias?: string }
  | { kind: "ambiguous"; message: string }
  | null;

/**
 * The data source behind a first part: an attached alias / the own alias first, then (unless it is a database or
 * schema name of the console's own server) the exact name of a data source when quoted, then a slug.
 */
export function resolveSource(part: { text: string; quoted: boolean }, ctx: RouteContext): Resolved {
  const low = part.text.toLowerCase();
  const att = ctx.attached.find((a) => a.alias.toLowerCase() === low);
  if (att) return { kind: "source", connId: att.connId, via: "attached", alias: att.alias };
  if (ctx.ownAlias && ctx.ownAlias.toLowerCase() === low) return { kind: "source", connId: ctx.ownConnId, via: "ownAlias", alias: ctx.ownAlias };
  if (ctx.nativeNames.has(low)) return null;
  const pick = (hits: CatalogSource[], via: "name" | "slug"): Resolved => {
    const ids = [...new Set(hits.map((h) => h.connId))];
    if (ids.length === 1) return { kind: "source", connId: ids[0], via };
    const names = ids.map((id) => hits.find((h) => h.connId === id)?.name ?? id);
    return {
      kind: "ambiguous",
      message: `'${part.text}' matches more than one data source (${names.join(", ")}). Quote the exact name, e.g. "${names[0]}".database.table, or rename one of them.`,
    };
  };
  if (part.quoted) {
    const hits = ctx.sources.filter((s) => s.name.toLowerCase() === low);
    if (hits.length) return pick(hits, "name");
  }
  if (!low) return null;
  const hits = ctx.sources.filter((s) => sourceSlug(s.name) === low);
  return hits.length ? pick(hits, "slug") : null;
}

/** A reference to a data source found in a statement. */
export interface SourceUse {
  connId: string;
  via: "attached" | "ownAlias" | "name" | "slug";
  alias?: string;
  ref: TableRef;
}

export type Route = { kind: "native" } | { kind: "federated"; uses: SourceUse[] } | { kind: "error"; message: string; ref: TableRef };

/**
 * How a console statement runs. Federated when a table reference names (by slug, quoted name or attached alias)
 * a data source other than the console's own — or, with sources attached, an attached alias / the own alias.
 * Slug / name references need 3+ parts (`source.database.table`), except SQLite sources (`source.table`); a first
 * part that is a database or schema of the console's own server is native (MSSQL db.schema.table, MySQL
 * db.table). Two data sources with that slug → error.
 */
export function routeStatement(sql: string, ctx: RouteContext): Route {
  const uses: SourceUse[] = [];
  let trigger = false;
  for (const ref of findTableRefs(sql)) {
    const r = resolveSource(ref.parts[0], ctx);
    if (!r) continue;
    if (r.kind === "ambiguous") {
      if (ref.parts.length >= 3) return { kind: "error", message: r.message, ref };
      continue;
    }
    const src = ctx.sources.find((s) => s.connId === r.connId);
    const minParts = r.via === "attached" || r.via === "ownAlias" || src?.driver === "sqlite" ? 2 : 3;
    if (ref.parts.length < minParts) continue;
    uses.push({ connId: r.connId, via: r.via, alias: r.alias, ref });
    if (r.via === "attached" || (r.via === "ownAlias" && ctx.attached.length > 0) || r.connId !== ctx.ownConnId) trigger = true;
  }
  return trigger ? { kind: "federated", uses } : { kind: "native" };
}

/** The console's side of `fedSourcesFor`. */
export interface FedOwn {
  connId: string;
  name: string;
  /** The console's current database (null = the connection's default). */
  database: string | null;
}

/**
 * FedSource list for a federated statement: the console's own source under its slug (and its strip alias), the
 * attached sources under their aliases, and every other referenced source under its slug (database: the
 * attachment's when attached, else null = the connection's default). Aliases are unique (case-insensitive) and
 * valid identifiers; a source whose slug isn't one gets `aliasSlug` (it is then written quoted in SQL).
 */
export function fedSourcesFor(
  uses: readonly SourceUse[],
  own: FedOwn,
  ownAlias: string | null,
  attached: readonly { alias: string; connId: string; database: string | null }[],
  sources: readonly CatalogSource[],
): FedSource[] {
  const out: FedSource[] = [];
  const taken = new Set<string>();
  const add = (alias: string, connectionId: string, database: string | null): void => {
    if (!isAlias(alias) || taken.has(alias.toLowerCase())) return;
    taken.add(alias.toLowerCase());
    out.push({ alias, connectionId, database });
  };
  // Attached aliases first: they win over slugs.
  for (const a of attached) add(a.alias, a.connId, a.database);
  if (ownAlias) add(ownAlias, own.connId, own.database);
  const slugAlias = (name: string): string => {
    const s = sourceSlug(name);
    if (isAlias(s)) return s;
    return uniqueAlias(aliasSlug(name), [...taken]);
  };
  const ownSlug = slugAlias(own.name);
  if (!out.some((f) => f.connectionId === own.connId && f.alias.toLowerCase() === ownSlug.toLowerCase())) add(ownSlug, own.connId, own.database);
  // The own source is always there (also when its slug is taken by an alias), so quoted names resolve too.
  if (!out.some((f) => f.connectionId === own.connId)) add(uniqueAlias(aliasSlug(own.name), [...taken]), own.connId, own.database);
  const done = new Set<string>([own.connId]);
  for (const u of uses) {
    if (done.has(u.connId)) continue;
    done.add(u.connId);
    const src = sources.find((s) => s.connId === u.connId);
    if (!src) continue;
    const att = attached.find((a) => a.connId === u.connId);
    const alias = slugAlias(src.name);
    if (taken.has(alias.toLowerCase())) {
      // The slug is some other source's alias here: keep the source reachable (by its quoted name).
      if (!out.some((f) => f.connectionId === src.connId)) add(uniqueAlias(alias, [...taken]), src.connId, att?.database ?? null);
      continue;
    }
    add(alias, src.connId, att?.database ?? null);
  }
  return out;
}

/** A dotted reference being typed: the complete parts before the last dot (quotes removed). */
export function refPathBefore(text: string): { path: { text: string; quoted: boolean }[]; word: string } | null {
  const m = /((?:(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"\n]*"|`[^`\n]*`|\[[^\]\n]*\])\.){1,3})([A-Za-z0-9_]*)$/.exec(text);
  if (!m) return null;
  const start = m.index;
  if (start > 0 && /[\w.$"`\]]/.test(text[start - 1])) return null;
  const path: { text: string; quoted: boolean }[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_$]*|"[^"\n]*"|`[^`\n]*`|\[[^\]\n]*\])\./g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[1])) !== null) {
    const raw = p[1];
    const q = /^["`[]/.test(raw);
    path.push({ text: q ? raw.slice(1, -1) : raw, quoted: q });
  }
  return { path, word: m[2] };
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

// A row removed from the virtualized tree mid-drag never gets its own dragend. (No window in the node tests.)
if (typeof window !== "undefined") {
  window.addEventListener("dragend", () => setTableDrag(null));
  window.addEventListener("drop", () => window.setTimeout(() => setTableDrag(null), 0));
}

/** A name part of a `source.database.table` reference: bare when it is a plain lower-case identifier, else "quoted". */
export function refPart(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

// Snippets (v0.16, board W): built-in defaults, user snippets from settings, abbreviation matching and the
// conversion of a body with $CURSOR / $TABLE / $COLUMN / $SELECTION / $DATE into a CodeMirror snippet template.
// Pure (no DOM), node tests: node scripts/test-ops.mjs.
import type { Driver } from "../types";

export type SnippetDialect = "postgres" | "mysql" | "mssql" | "sqlite";
export const SNIPPET_DIALECTS: SnippetDialect[] = ["postgres", "mysql", "mssql", "sqlite"];
export const DIALECT_SHORT: Record<SnippetDialect, string> = { postgres: "PG", mysql: "MySQL", mssql: "MSSQL", sqlite: "SQLite" };

export interface Snippet {
  /** Typed before Tab, e.g. "sel". Letters, digits and _ only. */
  abbr: string;
  /** Description ("Select everything from…"). */
  name: string;
  /** Text with $CURSOR, $TABLE, $COLUMN, $SELECTION and $DATE placeholders. */
  body: string;
  dialects: SnippetDialect[];
}

export type ExpandKey = "tab" | "enter" | "space";

export interface SnippetSettings {
  /** User snippets (one with a built-in's abbreviation replaces it). */
  user: Snippet[];
  /** Abbreviations of built-ins the user deleted. */
  hidden: string[];
  expandKey: ExpandKey;
  /** Offer snippets in the completion list. */
  inCompletion: boolean;
}

const ALL: SnippetDialect[] = ["postgres", "mysql", "mssql", "sqlite"];

export const BUILTIN_SNIPPETS: Snippet[] = [
  { abbr: "sel", name: "Select everything from…", body: "SELECT * FROM $CURSOR", dialects: ALL },
  { abbr: "selw", name: "Select with a filter", body: "SELECT * FROM $TABLE WHERE $CURSOR", dialects: ALL },
  { abbr: "cnt", name: "Count rows", body: "SELECT count(*) FROM $TABLE$CURSOR", dialects: ALL },
  { abbr: "ins", name: "Insert a row", body: "INSERT INTO $TABLE ($COLUMN)\nVALUES ($CURSOR);", dialects: ALL },
  { abbr: "upd", name: "Update rows", body: "UPDATE $TABLE\nSET $COLUMN = $CURSOR\nWHERE ;", dialects: ALL },
  { abbr: "del", name: "Delete rows", body: "DELETE FROM $TABLE\nWHERE $CURSOR;", dialects: ALL },
  { abbr: "j", name: "Join", body: "JOIN $TABLE ON $CURSOR", dialects: ALL },
  { abbr: "lj", name: "Left join", body: "LEFT JOIN $TABLE ON $CURSOR", dialects: ALL },
  { abbr: "gb", name: "Group by", body: "GROUP BY $CURSOR", dialects: ALL },
  { abbr: "ob", name: "Order by", body: "ORDER BY $CURSOR", dialects: ALL },
  { abbr: "selc", name: "Count by a column", body: "SELECT $COLUMN, count(*)\nFROM $TABLE\nGROUP BY $COLUMN\nORDER BY 2 DESC$CURSOR;", dialects: ALL },
  { abbr: "today", name: "Rows created today", body: "SELECT * FROM $TABLE WHERE created_at >= $DATE$CURSOR", dialects: ALL },
  { abbr: "top", name: "First 100 rows", body: "SELECT TOP 100 * FROM $TABLE$CURSOR", dialects: ["mssql"] },
  { abbr: "lim", name: "First 100 rows", body: "SELECT * FROM $TABLE LIMIT 100$CURSOR", dialects: ["postgres", "mysql", "sqlite"] },
  { abbr: "locks", name: "Who is blocking whom", body: "SELECT pid, pg_blocking_pids(pid) AS blocked_by, query\nFROM pg_stat_activity\nWHERE cardinality(pg_blocking_pids(pid)) > 0;$CURSOR", dialects: ["postgres"] },
];

export function defaultSnippetSettings(): SnippetSettings {
  return { user: [], hidden: [], expandKey: "tab", inCompletion: true };
}

const ABBR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

export function validAbbr(a: string): boolean {
  return ABBR_RE.test(a);
}

/** Tolerant merge of the settings' `snippets` object. */
export function mergeSnippetSettings(raw: unknown): SnippetSettings {
  const d = defaultSnippetSettings();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return d;
  const o = raw as Record<string, unknown>;
  const user: Snippet[] = [];
  if (Array.isArray(o.user)) {
    for (const x of o.user.slice(0, 500)) {
      if (typeof x !== "object" || x === null) continue;
      const s = x as Record<string, unknown>;
      if (typeof s.abbr !== "string" || typeof s.body !== "string") continue;
      const dialects = Array.isArray(s.dialects) ? (s.dialects.filter((v) => SNIPPET_DIALECTS.includes(v as SnippetDialect)) as SnippetDialect[]) : [...ALL];
      user.push({ abbr: s.abbr.slice(0, 32), name: typeof s.name === "string" ? s.name.slice(0, 200) : "", body: s.body.slice(0, 20_000), dialects });
    }
  }
  return {
    user,
    hidden: Array.isArray(o.hidden) ? o.hidden.filter((v): v is string => typeof v === "string").slice(0, 200) : [],
    expandKey: o.expandKey === "enter" || o.expandKey === "space" ? o.expandKey : "tab",
    inCompletion: o.inCompletion !== false,
  };
}

/** Built-ins (minus hidden and those a user snippet with the same abbreviation replaces) followed by user snippets. */
export function effectiveSnippets(s: SnippetSettings): (Snippet & { builtin: boolean; edited: boolean })[] {
  const out: (Snippet & { builtin: boolean; edited: boolean })[] = [];
  for (const b of BUILTIN_SNIPPETS) {
    if (s.hidden.includes(b.abbr)) continue;
    const u = s.user.find((x) => x.abbr === b.abbr);
    out.push(u ? { ...u, builtin: true, edited: true } : { ...b, builtin: true, edited: false });
  }
  for (const u of s.user) if (!out.some((x) => x.abbr === u.abbr)) out.push({ ...u, builtin: false, edited: false });
  return out;
}

/** Snippets that apply to a console of `driver` (none for Redis / Kafka). */
export function snippetsFor(list: Snippet[], driver: Driver): Snippet[] {
  if (!SNIPPET_DIALECTS.includes(driver as SnippetDialect)) return [];
  return list.filter((s) => s.dialects.includes(driver as SnippetDialect) && validAbbr(s.abbr));
}

/**
 * The abbreviation right before the caret on its line: a word that starts the line or follows whitespace / `(` / `,`,
 * outside a string or comment (rough check on the line). null when there is none.
 */
export function abbrBefore(lineText: string, col: number): { word: string; from: number } | null {
  const before = lineText.slice(0, col);
  const m = /(?:^|[\s(,;])([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  if (!m) return null;
  const from = col - m[1].length;
  // inside a string literal or after a line comment on this line
  const head = before.slice(0, from);
  if ((head.match(/'/g) ?? []).length % 2 === 1 || head.includes("--")) return null;
  // `x.sel` is a qualified name, not an abbreviation
  if (head.endsWith(".")) return null;
  return { word: m[1], from };
}

/** The snippet whose abbreviation is exactly `word` (case-sensitive first, then case-insensitive). */
export function findSnippet(list: Snippet[], word: string): Snippet | null {
  return list.find((s) => s.abbr === word) ?? list.find((s) => s.abbr.toLowerCase() === word.toLowerCase()) ?? null;
}

const PLACEHOLDER = /\$(CURSOR|TABLE|COLUMN|SELECTION|DATE)(?![A-Za-z0-9_])/g;

/** Escapes text for a CodeMirror snippet template (braces are the only special characters). */
function escapeTemplate(s: string): string {
  return s.replace(/[{}]/g, (c) => "\\" + c);
}

export interface TemplateInfo {
  /** CodeMirror `snippet()` template. */
  template: string;
  /** First field is $TABLE (open table completion inside it). */
  firstIsTable: boolean;
  /** First field is $COLUMN. */
  firstIsColumn: boolean;
  /** The caret lands right after FROM / JOIN / INTO / UPDATE (open table completion there). */
  cursorAfterTableKeyword: boolean;
}

/** `YYYY-MM-DD` of `d` in local time. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Body → template: $TABLE → `${1:table}`, $COLUMN → `${2:column}` (repeats are linked), $CURSOR → the last field,
 * $SELECTION → the selected text, $DATE → today's date (quoted unless already inside quotes).
 */
export function snippetTemplate(body: string, selection: string, today: Date): TemplateInfo {
  let out = "";
  let at = 0;
  let first: string | null = null;
  let cursorAfterTableKeyword = false;
  let m: RegExpExecArray | null;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(body))) {
    const lit = body.slice(at, m.index);
    out += escapeTemplate(lit);
    at = m.index + m[0].length;
    const kind = m[1];
    if (kind === "TABLE") {
      out += "${1:table}";
      first = first ?? "TABLE";
    } else if (kind === "COLUMN") {
      out += "${2:column}";
      first = first ?? "COLUMN";
    } else if (kind === "CURSOR") {
      out += "${3}";
      first = first ?? "CURSOR";
      if (/\b(?:from|join|into|update|table)\s+$/i.test(body.slice(0, m.index))) cursorAfterTableKeyword = true;
    } else if (kind === "SELECTION") {
      out += escapeTemplate(selection);
    } else if (kind === "DATE") {
      const quoted = body[m.index - 1] === "'";
      out += quoted ? isoDate(today) : `'${isoDate(today)}'`;
    }
  }
  out += escapeTemplate(body.slice(at));
  return { template: out, firstIsTable: first === "TABLE", firstIsColumn: first === "COLUMN", cursorAfterTableKeyword: first === "CURSOR" && cursorAfterTableKeyword };
}

/** One-line preview of a body (the settings list, completion info). */
export function snippetPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** "all SQL" or "PG, MySQL". */
export function dialectLabel(d: SnippetDialect[]): string {
  if (SNIPPET_DIALECTS.every((x) => d.includes(x))) return "all SQL";
  if (!d.length) return "none";
  return d.map((x) => DIALECT_SHORT[x]).join(", ");
}

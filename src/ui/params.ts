// Query parameters (v0.16, board U): `:name`, `?` and `$1…$n` in the statement being run. Pure (no DOM), node
// tests: node scripts/test-ops.mjs.
//
// Values are bound by substituting properly quoted SQL literals for the parameter tokens (per dialect: numbers
// validated and parenthesised when negative, strings quoted with '' doubling — PostgreSQL E'…' when the value has a
// backslash, MySQL a _utf8mb4 X'…' hex literal then, SQL Server N'…' —, dates quoted, NULL). The substituted text works
// unchanged with the paging wrapper, Count rows, Load more and cross-source routing (see CONTRACT.md v0.16).
import type { Driver, SchemaNode } from "../types";

export type ParamStyle = "named" | "positional" | "numbered";
export type ParamKind = "text" | "number" | "date";

export interface ParamToken {
  /** Offsets of the token in the statement. */
  from: number;
  to: number;
  /** The token as written (`:customer_id`, `?`, `$1`). */
  text: string;
  /** Identity: `:name` (named), `?1`… (positional, numbered across a run), `$1` (numbered). */
  key: string;
  style: ParamStyle;
}

export interface ParamValue {
  kind: ParamKind;
  value: string;
  isNull: boolean;
}

/** One distinct parameter of a run, in first-appearance order. */
export interface ParamInfo {
  key: string;
  style: ParamStyle;
  /** Shown in the popover: `:customer_id`, `? #1`, `$1`. */
  label: string;
  /** `orders.customer_id · bigint` when the compared column is known, else "". */
  hint: string;
  /** The compared column's type (validation messages), or "". */
  columnType: string;
  /** Kind inferred from the column type (number / date / text). */
  kind: ParamKind;
  /** `o.status` — the column reference it is compared to with `=` / `<>` (NULL hint), or "". */
  column: string;
  /** Compared with = / <> / != (a NULL value never matches). */
  equality: boolean;
}

/** Drivers whose statements can carry parameters. */
export function paramsSupported(driver: Driver): boolean {
  return driver === "postgres" || driver === "mysql" || driver === "sqlite" || driver === "mssql";
}

const IDENT = /[A-Za-z0-9_$\u0080-￿]/;

/** Statements whose bodies use $n / :name for their own purposes (PREPARE, routine / trigger definitions). */
const SKIP_HEAD = /^(?:prepare|create\s+(?:or\s+replace\s+)?(?:definer\s*=\s*\S+\s+)?(?:function|procedure|trigger))\b/i;

function headOf(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
}

/**
 * Replaces comments and the insides of string literals / quoted identifiers / dollar-quoted bodies with spaces
 * (same length, newlines kept), per dialect. Quote characters themselves are kept.
 */
export function maskCode(sql: string, driver: Driver): string {
  const out = sql.split("");
  const n = sql.length;
  const pg = driver === "postgres";
  const my = driver === "mysql";
  const brackets = driver === "mssql" || driver === "sqlite";
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const nx = sql[i + 1] ?? "";
    if (c === "-" && nx === "-") {
      let e = sql.indexOf("\n", i);
      if (e < 0) e = n;
      blank(i, e);
      i = e;
      continue;
    }
    if (my && c === "#") {
      let e = sql.indexOf("\n", i);
      if (e < 0) e = n;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === "/" && nx === "*") {
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (pg && sql[k] === "/" && sql[k + 1] === "*") {
          depth++;
          k += 2;
        } else if (sql[k] === "*" && sql[k + 1] === "/") {
          depth--;
          k += 2;
        } else k++;
      }
      blank(i, k);
      i = k;
      continue;
    }
    if (c === "'") {
      // PostgreSQL E'…' and MySQL strings take backslash escapes
      const prev = sql[i - 1] ?? "";
      const bs = my || (pg && (prev === "E" || prev === "e") && !IDENT.test(sql[i - 2] ?? ""));
      let k = i + 1;
      while (k < n) {
        if (bs && sql[k] === "\\") {
          k += 2;
          continue;
        }
        if (sql[k] === "'") {
          if (sql[k + 1] === "'") {
            k += 2;
            continue;
          }
          break;
        }
        k++;
      }
      blank(i + 1, Math.min(k, n));
      i = k + 1;
      continue;
    }
    if (c === '"' || c === "`" || (brackets && c === "[")) {
      const close = c === "[" ? "]" : c;
      let k = i + 1;
      while (k < n) {
        if (my && c === '"' && sql[k] === "\\") {
          k += 2;
          continue;
        }
        if (sql[k] === close) {
          if (close !== "]" && sql[k + 1] === close) {
            k += 2;
            continue;
          }
          break;
        }
        k++;
      }
      blank(i + 1, Math.min(k, n));
      i = k + 1;
      continue;
    }
    if (pg && c === "$" && !IDENT.test(sql[i - 1] ?? "")) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        const end = e < 0 ? n : e + tag.length;
        blank(i + tag.length, e < 0 ? n : e);
        i = end;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/**
 * Parameter tokens of one statement: `:name` everywhere (not `::cast`, not `:=`, not after an identifier / `]` / `)`
 * like `arr[lo:hi]`), `?` for MySQL / SQLite / SQL Server (`?NNN` numbered for SQLite), `$1…$n` for PostgreSQL.
 * Strings, quoted names, comments and dollar-quoted bodies are skipped. Redis / Kafka → none.
 * `qStart`: positional `?` are numbered from qStart + 1 (one run numbers them across its statements).
 */
export function scanParams(sql: string, driver: Driver, qStart = 0): ParamToken[] {
  if (!paramsSupported(driver)) return [];
  if (SKIP_HEAD.test(headOf(sql))) return [];
  const m = maskCode(sql, driver);
  const out: ParamToken[] = [];
  const qOk = driver === "mysql" || driver === "sqlite" || driver === "mssql";
  let q = qStart;
  const n = m.length;
  for (let i = 0; i < n; i++) {
    const c = m[i];
    if (c === ":") {
      if (m[i + 1] === ":") {
        i++;
        continue;
      }
      const prev = m[i - 1] ?? "";
      if (prev === ":" || IDENT.test(prev) || prev === "]" || prev === ")" || prev === '"' || prev === "`") continue;
      const r = /^[A-Za-z_][A-Za-z0-9_]*/.exec(m.slice(i + 1, i + 130));
      if (!r) continue;
      out.push({ from: i, to: i + 1 + r[0].length, text: sql.slice(i, i + 1 + r[0].length), key: ":" + r[0], style: "named" });
      i += r[0].length;
      continue;
    }
    if (c === "?" && qOk) {
      if (driver === "sqlite") {
        const d = /^\d+/.exec(m.slice(i + 1, i + 8));
        if (d) {
          out.push({ from: i, to: i + 1 + d[0].length, text: sql.slice(i, i + 1 + d[0].length), key: "?" + Number(d[0]), style: "numbered" });
          i += d[0].length;
          continue;
        }
      }
      q++;
      out.push({ from: i, to: i + 1, text: "?", key: "?" + q, style: "positional" });
      continue;
    }
    if (c === "$" && driver === "postgres" && !IDENT.test(m[i - 1] ?? "")) {
      const d = /^\d+/.exec(m.slice(i + 1, i + 8));
      if (d && !IDENT.test(m[i + 1 + d[0].length] ?? "")) {
        out.push({ from: i, to: i + 1 + d[0].length, text: sql.slice(i, i + 1 + d[0].length), key: "$" + Number(d[0]), style: "numbered" });
        i += d[0].length;
      }
    }
  }
  return out;
}

/** Number of positional `?` tokens (to number the next statement's). */
export function positionalCount(tokens: ParamToken[]): number {
  return tokens.filter((t) => t.style === "positional").length;
}

// ---------------------------------------------------------------- column / type inference

const NUMBER_TYPE = /\b(?:int|integer|bigint|smallint|tinyint|mediumint|int2|int4|int8|serial|bigserial|smallserial|numeric|decimal|real|double|float|float4|float8|money|smallmoney|number|bit)\b/i;
const DATE_TYPE = /\b(?:date|time|timestamp|timestamptz|datetime|datetime2|smalldatetime|datetimeoffset|year)\b/i;

/** text / number / date for a column type name. */
export function kindOfType(type: string): ParamKind {
  const t = type.toLowerCase();
  if (DATE_TYPE.test(t) && !/interval/.test(t)) return "date";
  if (NUMBER_TYPE.test(t) && !/\[\]|char|text/.test(t)) return "number";
  return "text";
}

interface TableRef {
  schema: string | null;
  table: string;
  alias: string | null;
}

const unq = (s: string): string => s.replace(/^["`[]|["`\]]$/g, "");

/** Tables named after FROM / JOIN / UPDATE / INTO in a (masked) statement, with their aliases. */
function tableRefs(masked: string, sql: string): TableRef[] {
  const out: TableRef[] = [];
  const name = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[A-Za-z_][\w$]*)`;
  const re = new RegExp(String.raw`\b(?:from|join|update|into)\s+(${name}(?:\s*\.\s*${name}){0,2})(?:\s+(?:as\s+)?(${name}))?`, "gi");
  const KW = /^(?:where|on|set|join|left|right|inner|outer|full|cross|group|order|limit|having|using|values|select|natural|union|returning|window|offset|fetch|for|lateral)$/i;
  let r: RegExpExecArray | null;
  while ((r = re.exec(masked))) {
    // read names from the original (quoted names were blanked in the mask)
    const at = r.index + r[0].indexOf(r[1]);
    const raw = sql.slice(at, at + r[1].length);
    const parts = raw.split(/\s*\.\s*/).map(unq);
    const table = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
    let alias: string | null = null;
    if (r[2] && !KW.test(r[2])) {
      const ai = r.index + r[0].lastIndexOf(r[2]);
      alias = unq(sql.slice(ai, ai + r[2].length));
    }
    out.push({ schema, table, alias });
  }
  return out;
}

/** The column a parameter at `from..to` is compared with (`col = :p`, `:p = col`, `col IN (…, :p`, `col BETWEEN :a AND :b`, `SET col = :p`). */
function comparedColumn(masked: string, sql: string, from: number, to: number): { ref: string; equality: boolean } | null {
  const before = masked.slice(Math.max(0, from - 300), from);
  const ref = String.raw`((?:[A-Za-z_][\w$]*|"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\])(?:\s*\.\s*(?:[A-Za-z_][\w$]*|"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\])){0,2})`;
  const pick = (re: RegExp, eqOps: boolean): { ref: string; equality: boolean } | null => {
    const m = re.exec(before);
    if (!m) return null;
    const start = from - before.length + m.index + m[0].indexOf(m[1]);
    const text = sql.slice(start, start + m[1].length);
    if (/^(?:and|or|not|where|set|on|when|then|else|case|select)$/i.test(text)) return null;
    const op = (m[2] ?? "").trim();
    return { ref: text, equality: eqOps && (op === "=" || op === "<>" || op === "!=") };
  };
  return (
    pick(new RegExp(ref + String.raw`\s*(=|<>|!=|>=|<=|>|<|\blike\b|\bilike\b|\bnot\s+like\b)\s*$`, "i"), true) ??
    pick(new RegExp(ref + String.raw`\s+(?:not\s+)?in\s*\([^()]*$`, "i"), false) ??
    pick(new RegExp(ref + String.raw`\s+(?:not\s+)?between\s+(?:[^()]*?\s+and\s+)?$`, "i"), false) ??
    (() => {
      const after = masked.slice(to, to + 200);
      const m = new RegExp(String.raw`^\s*(=|<>|!=|>=|<=|>|<)\s*` + ref, "i").exec(after);
      if (!m) return null;
      const start = to + m.index + m[0].lastIndexOf(m[2]);
      const text = sql.slice(start, start + m[2].length);
      if (/^(?:null|true|false)$/i.test(text)) return null;
      return { ref: text, equality: m[1] === "=" || m[1] === "<>" || m[1] === "!=" };
    })()
  );
}

/** Distinct parameters of a run (statements + their tokens) with inferred column / type from cached metadata. */
export function describeParams(
  stmts: { sql: string; tokens: ParamToken[] }[],
  driver: Driver,
  schemas: SchemaNode[],
  defaultSchema: string | null,
): ParamInfo[] {
  const out: ParamInfo[] = [];
  const seen = new Map<string, ParamInfo>();
  for (const st of stmts) {
    if (!st.tokens.length) continue;
    const masked = maskCode(st.sql, driver);
    const refs = tableRefs(masked, st.sql);
    for (const t of st.tokens) {
      let info = seen.get(t.key);
      if (!info) {
        info = {
          key: t.key,
          style: t.style,
          label: t.style === "positional" ? `? #${t.key.slice(1)}` : t.key,
          hint: "",
          columnType: "",
          kind: "text",
          column: "",
          equality: false,
        };
        seen.set(t.key, info);
        out.push(info);
      }
      if (info.hint) continue;
      const cmp = comparedColumn(masked, st.sql, t.from, t.to);
      if (!cmp) continue;
      info.column = cmp.ref.replace(/\s+/g, "");
      info.equality = info.equality || cmp.equality;
      const parts = cmp.ref.split(/\s*\.\s*/).map(unq);
      const col = parts[parts.length - 1];
      const qual = parts.length >= 2 ? parts[parts.length - 2] : null;
      const found = findColumn(col, qual, refs, schemas, defaultSchema);
      if (found) {
        info.hint = `${found.table}.${found.column} · ${found.type}`;
        info.columnType = found.type;
        info.kind = kindOfType(found.type);
      } else {
        info.hint = cmp.ref.replace(/\s+/g, "");
      }
    }
  }
  return out;
}

function findColumn(
  col: string,
  qual: string | null,
  refs: TableRef[],
  schemas: SchemaNode[],
  defaultSchema: string | null,
): { table: string; column: string; type: string } | null {
  const lc = col.toLowerCase();
  const candidates = qual ? refs.filter((r) => (r.alias ?? r.table).toLowerCase() === qual.toLowerCase() || r.table.toLowerCase() === qual.toLowerCase()) : refs;
  for (const r of candidates) {
    for (const s of schemas) {
      if (r.schema ? s.name.toLowerCase() !== r.schema.toLowerCase() : schemas.length > 1 && defaultSchema !== null && s.name !== defaultSchema) continue;
      const t = s.tables.find((x) => x.name.toLowerCase() === r.table.toLowerCase());
      const c = t?.columns.find((x) => x.name.toLowerCase() === lc);
      if (t && c) return { table: t.name, column: c.name, type: c.dataType };
    }
  }
  return null;
}

// ---------------------------------------------------------------- validation and literals

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** Validation message for a value, or "" when it can be used. */
export function validateParam(v: ParamValue, columnType = ""): string {
  if (v.isNull) return "";
  const s = v.value.trim();
  if (v.kind === "number") {
    if (s === "") return "Enter a value or choose NULL";
    if (!NUMBER_RE.test(s)) return "Not a number" + (columnType ? ` — the column is ${columnType}` : "");
    return "";
  }
  if (v.kind === "date") {
    if (s === "") return "Enter a value or choose NULL";
    if (!DATE_RE.test(s)) return "Use YYYY-MM-DD (time optional)";
    return "";
  }
  if (v.value.includes("\u0000")) return "Text can't contain a NUL character";
  return "";
}

function hexUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** A quoted string literal for the dialect (always safe to paste into SQL text). */
export function stringLiteral(s: string, driver: Driver): string {
  const doubled = s.replace(/'/g, "''");
  if (driver === "postgres") return s.includes("\\") ? `E'${doubled.replace(/\\/g, "\\\\")}'` : `'${doubled}'`;
  if (driver === "mysql") return /[\\\u0000-\u001f]/.test(s) ? `_utf8mb4 X'${hexUtf8(s)}'` : `'${doubled}'`;
  if (driver === "mssql") return `N'${doubled}'`;
  return `'${doubled}'`;
}

/** The SQL literal for a (valid) value. Throws when the value is invalid. */
export function paramLiteral(v: ParamValue, driver: Driver): string {
  if (v.isNull) return "NULL";
  const err = validateParam(v);
  if (err) throw new Error(err);
  if (v.kind === "number") {
    const s = v.value.trim().replace(/^\+/, "");
    // `x - -1` would start a comment: negative numbers go in parentheses
    return s.startsWith("-") ? `(${s})` : s;
  }
  if (v.kind === "date") return stringLiteral(v.value.trim(), driver);
  return stringLiteral(v.value, driver);
}

/** What the result chips show: `:id = 1042`, `$2 = '2026-11-01'`, `?1 = NULL`. */
export function chipText(key: string, v: ParamValue): string {
  const shown = v.isNull ? "NULL" : v.kind === "number" ? v.value.trim() : `'${v.value.length > 40 ? v.value.slice(0, 40) + "…" : v.value}'`;
  return `${key} = ${shown}`;
}

export interface Substitution {
  sql: string;
  /** Replaced ranges of the original: [from, to) became `len` characters. In order. */
  edits: { from: number; to: number; len: number }[];
}

/** Replaces every token with its value's literal. */
export function substituteParams(sql: string, tokens: ParamToken[], values: Record<string, ParamValue>, driver: Driver): Substitution {
  const sorted = [...tokens].sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  const edits: Substitution["edits"] = [];
  for (const t of sorted) {
    const v = values[t.key];
    if (!v) throw new Error(`No value for ${t.key}`);
    const lit = paramLiteral(v, driver);
    out += sql.slice(at, t.from) + lit;
    edits.push({ from: t.from, to: t.to, len: lit.length });
    at = t.to;
  }
  return { sql: out + sql.slice(at), edits };
}

/** Index in the original statement of index `pos` of the substituted one (inside a literal → its token's start). */
export function mapBack(edits: Substitution["edits"], pos: number): number {
  let shift = 0;
  for (const e of edits) {
    const sFrom = e.from + shift;
    if (pos < sFrom) break;
    if (pos < sFrom + e.len) return e.from;
    shift += e.len - (e.to - e.from);
  }
  return pos - shift;
}

function cpIndex(s: string, cp: number): number {
  let i = 0;
  for (let n = 0; n < cp && i < s.length; n++) i += (s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  return i;
}

function cpCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += (s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1) n++;
  return n;
}

/**
 * An error raised by the substituted statement (`executed` = what ran: the substituted SQL or the pager's wrapper
 * around it), re-expressed against the original statement with its parameter tokens: `{position}` (1-based code
 * points) or `{line}`; {} when it can't be mapped.
 */
export function mapParamError(err: { position?: unknown; line?: unknown }, substituted: string, executed: string, sub: Substitution, original: string): { position?: number; line?: number } {
  const pos = typeof err.position === "number" && err.position >= 1 ? err.position : null;
  const line = typeof err.line === "number" && err.line >= 1 ? err.line : null;
  const lead = substituted.length - substituted.trimStart().length;
  const k = executed === substituted ? 0 : executed.indexOf(substituted.trimStart().slice(0, 80)) - lead;
  if (k < 0 && executed !== substituted) return {};
  if (pos !== null) {
    const idx = cpIndex(executed, pos - 1) - k;
    if (idx < 0 || idx > substituted.length) return {};
    const o = mapBack(sub.edits, idx);
    return { position: cpCount(original.slice(0, o)) + 1 };
  }
  if (line !== null && executed === substituted) {
    // values may contain newlines: map the line's start offset back
    const lines = substituted.split("\n");
    if (line > lines.length) return {};
    const off = lines.slice(0, line - 1).reduce((a, x) => a + x.length + 1, 0);
    const o = mapBack(sub.edits, off);
    return { line: original.slice(0, o).split("\n").length };
  }
  return {};
}

/** "A comparison with NULL is never true…" when a NULL value is compared with = / <> (else ""). */
export function nullHint(params: ParamInfo[], values: Record<string, ParamValue>): string {
  const p = params.find((x) => values[x.key]?.isNull && x.equality);
  if (!p) return "";
  const col = p.column || "the column";
  return `A comparison with NULL is never true, so no rows match. To find missing values write  ${col} IS NULL  instead.`;
}

/** Default (empty) value for a parameter, from its inferred kind. */
export function emptyValue(p: ParamInfo): ParamValue {
  return { kind: p.kind, value: "", isNull: false };
}

/** Values remembered for a console (restored workspace): `{ remember, values, at }`. */
export interface RememberedParams {
  remember: boolean;
  values: Record<string, ParamValue>;
  /** ms since the epoch of the last run with these values. */
  at: number;
}

/** Tolerant parsing of a saved `RememberedParams` (null when absent / invalid). */
export function parseRemembered(v: unknown): RememberedParams | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const values: Record<string, ParamValue> = {};
  if (typeof o.values === "object" && o.values !== null) {
    for (const [k, x] of Object.entries(o.values as Record<string, unknown>).slice(0, 200)) {
      if (typeof x !== "object" || x === null) continue;
      const p = x as Record<string, unknown>;
      const kind: ParamKind = p.kind === "number" || p.kind === "date" ? p.kind : "text";
      values[k] = { kind, value: typeof p.value === "string" ? p.value.slice(0, 10_000) : "", isNull: p.isNull === true };
    }
  }
  return { remember: o.remember !== false, values, at: typeof o.at === "number" && isFinite(o.at) ? o.at : 0 };
}

// Pure result formatter shared by the export dialog, "Copy as" and the grid. The output must stay
// byte-identical with src-tauri/src/export.rs (CONTRACT.md "v0.9 additions").
import type { Cell, Driver, ExportOptions } from "../types";
import { quoteIdent } from "./sqlutil";

export type ColumnLike = string | { name: string };

const colName = (c: ColumnLike): string => (typeof c === "string" ? c : c.name);

/** Plain text of one cell for CSV / TSV / Markdown. */
function cellText(v: Cell, nullText: string): string {
  if (v === null || v === undefined) return nullText;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** JSON value text: numbers keep their text, non-finite numbers degrade to null. */
function jsonValue(v: Cell): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  return JSON.stringify(v);
}

function sqlValue(v: Cell, driver: Driver): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return driver === "mssql" ? (v ? "1" : "0") : v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") v = JSON.stringify(v);
  return "'" + v.replace(/'/g, "''") + "'";
}

/** `a`, `a_2`, `a_3` … for repeated column names (JSON objects); names already taken are skipped. */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  const next = new Map<string, number>();
  return names.map((n) => {
    let name = n;
    if (used.has(name)) {
      let k = next.get(n) ?? 2;
      while (used.has(`${n}_${k}`)) k++;
      name = `${n}_${k}`;
      next.set(n, k + 1);
    }
    used.add(name);
    return name;
  });
}

function csvLine(fields: string[], nulls: boolean[], delim: string, q: string): string {
  return fields
    .map((f, i) => {
      if (nulls[i] || q === "") return f;
      const needs = f.includes(delim) || f.includes(q) || f.includes("\r") || f.includes("\n") || f.startsWith(" ") || f.endsWith(" ");
      return needs ? q + f.split(q).join(q + q) + q : f;
    })
    .join(delim);
}

const tsvEsc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const mdEsc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");

export function formatRows(columns: ColumnLike[], rows: Cell[][], options: ExportOptions, driver: Driver): string {
  const names = columns.map(colName);
  const le = options.lineEnding || "\n";
  const nullText = options.nullText ?? "";
  const header = options.includeHeader;
  const out: string[] = [];
  switch (options.format) {
    case "csv": {
      const delim = options.delimiter || ",";
      const q = options.quote ?? '"';
      if (header) out.push(csvLine(names, names.map(() => false), delim, q));
      for (const r of rows) {
        out.push(
          csvLine(
            names.map((_, i) => cellText(r[i], nullText)),
            names.map((_, i) => r[i] === null || r[i] === undefined),
            delim,
            q,
          ),
        );
      }
      break;
    }
    case "tsv": {
      if (header) out.push(names.map(tsvEsc).join("\t"));
      for (const r of rows) out.push(names.map((_, i) => (r[i] === null || r[i] === undefined ? nullText : tsvEsc(cellText(r[i], "")))).join("\t"));
      break;
    }
    case "json": {
      if (rows.length === 0) {
        out.push("[]");
        break;
      }
      const keys = header ? uniqueNames(names).map((n) => JSON.stringify(n)) : [];
      const items = rows.map((r) => {
        const vals = names.map((_, i) => jsonValue(r[i]));
        return "  " + (header ? "{" + vals.map((v, i) => keys[i] + ": " + v).join(", ") + "}" : "[" + vals.join(", ") + "]");
      });
      return "[" + le + items.join("," + le) + le + "]" + le;
    }
    case "sql": {
      const table = options.tableName || "my_table";
      const cols = header ? " (" + names.map((n) => quoteIdent(driver, n)).join(", ") + ")" : "";
      for (const r of rows) out.push(`INSERT INTO ${table}${cols} VALUES (${names.map((_, i) => sqlValue(r[i], driver)).join(", ")});`);
      break;
    }
    case "markdown": {
      if (names.length === 0) break;
      const hd = header ? names : names.map((_, i) => "col" + (i + 1));
      out.push("| " + hd.map(mdEsc).join(" | ") + " |");
      out.push("| " + hd.map(() => "---").join(" | ") + " |");
      for (const r of rows) out.push("| " + names.map((_, i) => (r[i] === null || r[i] === undefined ? nullText : mdEsc(cellText(r[i], "")))).join(" | ") + " |");
      break;
    }
  }
  return out.map((l) => l + le).join("");
}

export const FORMAT_LABEL: Record<ExportOptions["format"], string> = { csv: "CSV", tsv: "TSV", json: "JSON", sql: "SQL INSERT", markdown: "Markdown" };
export const FORMAT_EXT: Record<ExportOptions["format"], string> = { csv: "csv", tsv: "tsv", json: "json", sql: "sql", markdown: "md" };

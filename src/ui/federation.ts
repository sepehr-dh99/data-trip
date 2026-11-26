// Cross-source queries: alias rules shared by the console's "Sources" strip.
import type { Driver } from "../types";

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

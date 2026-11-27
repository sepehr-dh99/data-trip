// Cross-source consoles: the "pick SQL data sources" dialog and the example query of the guide card, built from
// real tables of the attached sources.
import type { Driver, SchemaNode, TableNode } from "../types";
import { DRIVER_LABELS } from "../types";
import { h, icon } from "./dom";
import { FED_DRIVERS, refPart, tableRef } from "./federation";
import { connColor } from "./sqlutil";
import { store } from "./state";

// ---------------------------------------------------------------- example query

export interface ExampleSource {
  /** How the source is written in SQL: its slug (or quoted name / attached alias). */
  ref: string;
  /** Data source name (for the comment line). */
  name: string;
  driver: Driver;
  /** Database the tables come from (null = unknown: the older `source.schema.table` form is written). */
  database: string | null;
  schemas: SchemaNode[];
  /** Schema unqualified names resolve to (tried first). */
  defaultSchema: string | null;
}

interface Cand {
  schema: string;
  t: TableNode;
  cols: Set<string>;
  def: boolean;
}

const SYSTEM_SCHEMA = /^(information_schema|pg_catalog|pg_toast|sys|mysql|performance_schema|INFORMATION_SCHEMA)$/;

/** Tables of a source worth showing in an example (plain tables first, then views), default schema first. */
function candidates(src: ExampleSource): Cand[] {
  const out: Cand[] = [];
  for (const s of src.schemas) {
    if (SYSTEM_SCHEMA.test(s.name)) continue;
    for (const t of s.tables) out.push({ schema: s.name, t, cols: new Set(t.columns.map((c) => c.name.toLowerCase())), def: s.name === src.defaultSchema });
  }
  const rank = (c: Cand): number => (c.t.kind === "table" ? 0 : 2) + (c.def ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.t.name.localeCompare(b.t.name)).slice(0, 400);
}

/** "users" → "user", "categories" → "category", "addresses" → "address". */
function singular(n: string): string {
  const s = n.toLowerCase();
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
  if (/(sses|xes|ches|shes)$/.test(s)) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && s.length > 2) return s.slice(0, -1);
  return s;
}

/** Original-case column name of `t` matching lower-case `low`. */
const colOf = (t: TableNode, low: string): string => t.columns.find((c) => c.name.toLowerCase() === low)?.name ?? low;

interface Join {
  score: number;
  /** Column of the first table, column of the second. */
  ac: string;
  bc: string;
}

function joinOf(a: Cand, b: Cand): Join | null {
  const aFk = singular(b.t.name) + "_id";
  if (a.cols.has(aFk) && b.cols.has("id")) return { score: 5, ac: colOf(a.t, aFk), bc: colOf(b.t, "id") };
  const bFk = singular(a.t.name) + "_id";
  if (b.cols.has(bFk) && a.cols.has("id")) return { score: 5, ac: colOf(a.t, "id"), bc: colOf(b.t, bFk) };
  const common = [...a.cols].filter((c) => c !== "id" && c.endsWith("_id") && b.cols.has(c)).sort()[0];
  if (common) return { score: 3, ac: colOf(a.t, common), bc: colOf(b.t, common) };
  for (const c of ["uuid", "email", "code", "sku", "name"]) if (a.cols.has(c) && b.cols.has(c)) return { score: 2, ac: colOf(a.t, c), bc: colOf(b.t, c) };
  if (a.cols.has("id") && b.cols.has("id")) return { score: 1, ac: colOf(a.t, "id"), bc: colOf(b.t, "id") };
  return null;
}

/** Table alias: the table's first letter (a second one if both start alike). */
function tableAlias(name: string, taken: string): string {
  const l = (/[a-z]/i.exec(name)?.[0] ?? "t").toLowerCase();
  return l === taken ? l + "2" : l;
}

const colRef = (alias: string, col: string): string => `${alias}.${refPart(col)}`;

/**
 * An example cross-source query over the first two sources that have tables: a pair of tables that share a
 * join column (orders.user_id = users.id, a common *_id column…) when one exists, else the first table of each
 * with a join condition to adjust. Null when fewer than two sources have tables.
 */
export function exampleQuery(sources: ExampleSource[]): string | null {
  const withTables = sources.map((s) => ({ s, c: candidates(s) })).filter((x) => x.c.length > 0);
  if (withTables.length < 2) return null;
  const [A, B] = withTables;
  let best: { a: Cand; b: Cand; j: Join } | null = null;
  // Bounded search: enough for real schemas, cheap for huge ones.
  for (const a of A.c.slice(0, 150)) {
    for (const b of B.c.slice(0, 150)) {
      const j = joinOf(a, b);
      if (j && (!best || j.score > best.j.score)) best = { a, b, j };
    }
    if (best && best.j.score >= 5) break;
  }
  const a = best?.a ?? A.c[0];
  const b = best?.b ?? B.c[0];
  const aa = tableAlias(a.t.name, "");
  const ba = tableAlias(b.t.name, aa);
  // source.database.table (PostgreSQL / SQL Server schemas other than public / dbo: source.database.schema.table).
  const ref = (src: ExampleSource, c: Cand): string => tableRef(src.ref, src.driver, src.database, c.schema, c.t.name);
  const strong = best !== null && best.j.score >= 2;
  const j = best?.j ?? null;
  const pick = (c: Cand, n: number, skip: string | null): string[] =>
    c.t.columns
      .map((x) => x.name)
      .filter((x) => x !== skip)
      .slice(0, n);
  const aCols = pick(a, 3, null).map((x) => colRef(aa, x));
  const bCols = pick(b, 2, j?.bc ?? null).map((x) => colRef(ba, x));
  const cols = [...aCols, ...bCols];
  const lines: string[] = [];
  lines.push(
    strong
      ? `-- Example: ${a.t.name} (${A.s.name}) joined with ${b.t.name} (${B.s.name})`
      : `-- Example: ${a.t.name} (${A.s.name}) next to ${b.t.name} (${B.s.name}) — adjust the join condition`,
  );
  lines.push(`SELECT ${cols.length ? cols.join(", ") : `${aa}.*, ${ba}.*`}`);
  lines.push(`FROM ${ref(A.s, a)} ${aa}`);
  if (j) lines.push(`JOIN ${ref(B.s, b)} ${ba} ON ${colRef(ba, j.bc)} = ${colRef(aa, j.ac)}`);
  else {
    const ac = a.t.columns[0]?.name;
    const bc = b.t.columns[0]?.name;
    lines.push(ac && bc ? `JOIN ${ref(B.s, b)} ${ba} ON ${colRef(ba, bc)} = ${colRef(aa, ac)}` : `CROSS JOIN ${ref(B.s, b)} ${ba}`);
  }
  lines.push("LIMIT 100;");
  return lines.join("\n");
}

// ---------------------------------------------------------------- source picker

/** SQL data sources a cross-source query can read from. */
export function fedCandidates(): { id: string; name: string; driver: string }[] {
  return store
    .list()
    .filter((e) => FED_DRIVERS.has(e.config.driver))
    .map((e) => ({ id: e.config.id, name: e.config.name, driver: DRIVER_LABELS[e.config.driver].split(" / ")[0] }));
}

/**
 * "New cross-source console": pick two or more SQL data sources. Resolves with their ids (the first one becomes
 * the console's own source), or null when cancelled. `preselect` ids start checked.
 */
export function pickCrossSources(preselect: string[] = []): Promise<string[] | null> {
  return new Promise((resolve) => {
    const cands = fedCandidates();
    const chosen: string[] = preselect.filter((id) => cands.some((c) => c.id === id));
    const overlay = h("div", { class: "overlay" });
    const okBtn = h("button", { class: "btn primary", type: "button" }, "Open console");
    const countEl = h("span", { class: "xs-count" });
    const sync = (): void => {
      okBtn.disabled = chosen.length < 2;
      countEl.textContent = chosen.length < 2 ? "Pick at least two" : `${chosen.length} sources`;
    };
    const done = (v: string[] | null): void => {
      window.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      } else if (e.key === "Enter" && chosen.length >= 2 && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        done([...chosen]);
      }
    };
    okBtn.addEventListener("click", () => chosen.length >= 2 && done([...chosen]));
    const rows = cands.map((c) => {
      const e = store.conns.get(c.id);
      const cb = h("input", { type: "checkbox", checked: chosen.includes(c.id), "aria-label": c.name });
      cb.addEventListener("change", () => {
        const i = chosen.indexOf(c.id);
        if (cb.checked && i < 0) chosen.push(c.id);
        else if (!cb.checked && i >= 0) chosen.splice(i, 1);
        sync();
      });
      return h(
        "label",
        { class: "xs-row" },
        cb,
        h("span", { class: "fed-dot", style: `--c:${e ? connColor(e.config) : "var(--text-3)"}`, "aria-hidden": "true" }),
        h("span", { class: "xs-name" }, c.name),
        h("span", { class: "xs-meta" }, c.driver + (e?.status === "connected" ? " · connected" : "")),
      );
    });
    overlay.appendChild(
      h(
        "div",
        { class: "dialog small xs-dialog", role: "dialog", "aria-modal": "true", "aria-label": "New cross-source console" },
        h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon("layers", 18), "New cross-source console")),
        h(
          "div",
          { class: "dialog-body" },
          h("p", { class: "xs-lead" }, "Pick the data sources to query together. The first one you pick is the console's own source. In SQL each one is its name in lower case with _ for spaces: dataSource.database.table."),
          cands.length >= 2 ? h("div", { class: "xs-list" }, rows) : h("p", { class: "xs-lead" }, "You need at least two PostgreSQL, MySQL, SQLite or SQL Server data sources."),
        ),
        h("div", { class: "dialog-foot" }, countEl, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: () => done(null) }, "Cancel"), okBtn),
      ),
    );
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) done(null);
    });
    document.body.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    sync();
    overlay.querySelector<HTMLInputElement>("input")?.focus();
  });
}

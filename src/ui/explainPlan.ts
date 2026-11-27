// Explain plans (v0.16, board U): the EXPLAIN statement per dialect and parsers that turn PostgreSQL JSON, MySQL JSON /
// EXPLAIN ANALYZE text, SQLite EXPLAIN QUERY PLAN rows and SQL Server showplan XML into one tree. Pure (no DOM), node
// tests: node scripts/test-ops.mjs.
import type { Driver } from "../types";

export type PlanFormat = "pg-json" | "mysql-json" | "mysql-tree" | "sqlite" | "mssql-xml";

export interface PlanNode {
  /** Preorder index. */
  id: number;
  depth: number;
  /** "Seq Scan on orders o", "Hash Join", "Full table scan on orders". */
  name: string;
  /** One-line details (conditions, keys). */
  detail: string;
  /** Detail lines for the selection panel and the raw text. */
  extras: string[];
  /** Estimated rows (per loop). */
  estRows: number | null;
  /** Actual rows (per loop; ANALYZE only). */
  actRows: number | null;
  loops: number | null;
  startupCost: number | null;
  totalCost: number | null;
  /** Inclusive time over all loops (ms; ANALYZE only). */
  totalMs: number | null;
  /** Time spent in this node alone (ms; ANALYZE only). */
  selfMs: number | null;
  /** Cost of this node alone (total minus the children's totals). */
  selfCost: number | null;
  /** Scanned relation and index (hints). */
  relation: string | null;
  schema: string | null;
  index: string | null;
  /** Filter applied while scanning (hints). */
  filter: string | null;
  /** Rows the filter threw away (ANALYZE). */
  removed: number | null;
  /** Full scan of a table (Seq Scan, MySQL ALL, SQLite SCAN, SQL Server Table / Clustered Index Scan). */
  fullScan: boolean;
  /** I/O line (BUFFERS). */
  buffers: string | null;
  children: PlanNode[];
}

export interface PlanHint {
  text: string;
  /** "CREATE INDEX …" to copy, or null. */
  createIndex: string | null;
}

export interface Plan {
  format: PlanFormat;
  analyze: boolean;
  /** Preorder. */
  nodes: PlanNode[];
  /** 0..1 share of the self metric (self time with ANALYZE, else self cost) per node; empty without numbers. */
  share: number[];
  /** Index of the slowest / most expensive node, -1 when unknown. */
  slowest: number;
  planningMs: number | null;
  executionMs: number | null;
  hint: PlanHint | null;
  /** The text shown by "Raw". */
  raw: string;
}

export interface ExplainRequest {
  /** Statements run before / after the explain (SQL Server SHOWPLAN on / off). */
  pre: string[];
  sql: string;
  post: string[];
  format: PlanFormat;
  /** ANALYZE actually applied (false where the dialect has none). */
  analyze: boolean;
}

/** MySQL 8.0.18+ (not MariaDB) has EXPLAIN ANALYZE. */
export function mysqlHasAnalyze(serverVersion: string): boolean {
  if (/maria/i.test(serverVersion)) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(serverVersion.trim());
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  return v[0] > 8 || (v[0] === 8 && (v[1] > 0 || v[2] >= 18));
}

/** Whether the dialect / server can run EXPLAIN ANALYZE. */
export function analyzeSupported(driver: Driver, serverVersion: string): boolean {
  return driver === "postgres" || (driver === "mysql" && mysqlHasAnalyze(serverVersion));
}

/** The explain statement(s) for `sql` (one statement, no trailing `;`). */
export function explainRequest(driver: Driver, sql: string, opts: { analyze: boolean; buffers: boolean; serverVersion: string }): ExplainRequest | null {
  const body = sql.trim().replace(/;\s*$/, "");
  if (!body) return null;
  if (driver === "postgres") {
    const o = ["FORMAT JSON"];
    if (opts.analyze) o.push("ANALYZE");
    if (opts.analyze && opts.buffers) o.push("BUFFERS");
    return { pre: [], sql: `EXPLAIN (${o.join(", ")}) ${body}`, post: [], format: "pg-json", analyze: opts.analyze };
  }
  if (driver === "mysql") {
    if (opts.analyze && mysqlHasAnalyze(opts.serverVersion)) return { pre: [], sql: `EXPLAIN ANALYZE ${body}`, post: [], format: "mysql-tree", analyze: true };
    return { pre: [], sql: `EXPLAIN FORMAT=JSON ${body}`, post: [], format: "mysql-json", analyze: false };
  }
  if (driver === "sqlite") return { pre: [], sql: `EXPLAIN QUERY PLAN ${body}`, post: [], format: "sqlite", analyze: false };
  if (driver === "mssql") return { pre: ["SET SHOWPLAN_XML ON"], sql: body, post: ["SET SHOWPLAN_XML OFF"], format: "mssql-xml", analyze: false };
  return null;
}

// ---------------------------------------------------------------- shared

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function blank(depth: number, name: string): PlanNode {
  return {
    id: 0,
    depth,
    name,
    detail: "",
    extras: [],
    estRows: null,
    actRows: null,
    loops: null,
    startupCost: null,
    totalCost: null,
    totalMs: null,
    selfMs: null,
    selfCost: null,
    relation: null,
    schema: null,
    index: null,
    filter: null,
    removed: null,
    fullScan: false,
    buffers: null,
    children: [],
  };
}

function flatten(root: PlanNode[]): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (n: PlanNode, d: number): void => {
    n.id = out.length;
    n.depth = d;
    out.push(n);
    for (const c of n.children) walk(c, d + 1);
  };
  for (const r of root) walk(r, 0);
  return out;
}

/** Self time / self cost from inclusive numbers (clamped at 0). */
function computeSelf(nodes: PlanNode[]): void {
  for (const n of nodes) {
    if (n.totalMs !== null) {
      const kids = n.children.reduce((a, c) => a + (c.totalMs ?? 0), 0);
      n.selfMs = Math.max(0, n.totalMs - kids);
    }
    if (n.totalCost !== null) {
      const kids = n.children.reduce((a, c) => a + (c.totalCost ?? 0), 0);
      n.selfCost = Math.max(0, n.totalCost - kids);
    }
  }
}

function finish(format: PlanFormat, analyze: boolean, roots: PlanNode[], raw: string, planningMs: number | null, executionMs: number | null, sql: string, driver: Driver): Plan {
  const nodes = flatten(roots);
  computeSelf(nodes);
  const useTime = analyze && nodes.some((n) => n.selfMs !== null);
  const metric = nodes.map((n) => (useTime ? n.selfMs ?? 0 : n.selfCost ?? 0));
  const total = metric.reduce((a, b) => a + b, 0);
  const share = total > 0 ? metric.map((m) => m / total) : [];
  let slowest = -1;
  if (total > 0) {
    let best = -1;
    metric.forEach((m, i) => {
      if (m > best) {
        best = m;
        slowest = i;
      }
    });
  }
  const plan: Plan = { format, analyze: useTime || analyze, nodes, share, slowest, planningMs, executionMs, hint: null, raw };
  plan.hint = planHint(plan, sql, driver);
  return plan;
}

/** Misestimate factor (≥ 1) of a node, or null without actual rows. */
export function misestimate(n: PlanNode): number | null {
  if (n.estRows === null || n.actRows === null) return null;
  const hi = Math.max(n.estRows, n.actRows);
  const lo = Math.max(1, Math.min(n.estRows, n.actRows));
  return hi / lo;
}

// ---------------------------------------------------------------- PostgreSQL

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strOf = (v: unknown): string | null => (typeof v === "string" ? v : null);

function pgName(p: Obj): string {
  const type = strOf(p["Node Type"]) ?? "Node";
  const join = strOf(p["Join Type"]);
  let name = type;
  if (join && join !== "Inner" && /Join|Nested Loop/.test(type)) {
    name = type === "Nested Loop" ? `Nested Loop ${join} Join` : type.replace(/ Join$/, ` ${join} Join`);
  }
  const strategy = strOf(p.Strategy);
  if (type === "Aggregate" && strategy && strategy !== "Plain") name = (strategy === "Hashed" ? "HashAggregate" : strategy === "Sorted" ? "GroupAggregate" : strategy === "Mixed" ? "MixedAggregate" : name);
  const idx = strOf(p["Index Name"]);
  const rel = strOf(p["Relation Name"]);
  const alias = strOf(p.Alias);
  if (idx) name += ` using ${idx}`;
  if (rel) name += ` on ${rel}${alias && alias !== rel ? " " + alias : ""}`;
  else if (strOf(p["CTE Name"])) name += ` on ${strOf(p["CTE Name"])}`;
  else if (strOf(p["Function Name"])) name += ` on ${strOf(p["Function Name"])}`;
  return name;
}

const PG_DETAIL_KEYS: [string, string][] = [
  ["Hash Cond", "Hash Cond"],
  ["Merge Cond", "Merge Cond"],
  ["Join Filter", "Join Filter"],
  ["Index Cond", "Index Cond"],
  ["Recheck Cond", "Recheck Cond"],
  ["Filter", "Filter"],
  ["Rows Removed by Filter", "Rows Removed by Filter"],
  ["Rows Removed by Index Recheck", "Rows Removed by Index Recheck"],
  ["Sort Key", "Sort Key"],
  ["Sort Method", "Sort Method"],
  ["Group Key", "Group Key"],
  ["Presorted Key", "Presorted Key"],
  ["Hash Buckets", "Buckets"],
  ["Hash Batches", "Batches"],
  ["Peak Memory Usage", "Memory (kB)"],
  ["Sort Space Used", "Sort Space (kB)"],
  ["Workers Planned", "Workers Planned"],
  ["Workers Launched", "Workers Launched"],
  ["Heap Fetches", "Heap Fetches"],
  ["Subplan Name", "Subplan"],
];

function pgExtras(p: Obj): string[] {
  const out: string[] = [];
  for (const [k, label] of PG_DETAIL_KEYS) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    const text = Array.isArray(v) ? v.map(String).join(", ") : String(v);
    out.push(`${label}: ${text}`);
  }
  return out;
}

function pgBuffers(p: Obj): string | null {
  const parts: string[] = [];
  const hit = num(p["Shared Hit Blocks"]);
  const read = num(p["Shared Read Blocks"]);
  const dirt = num(p["Shared Dirtied Blocks"]);
  const writ = num(p["Shared Written Blocks"]);
  const shared = [hit ? `hit=${hit}` : "", read ? `read=${read}` : "", dirt ? `dirtied=${dirt}` : "", writ ? `written=${writ}` : ""].filter(Boolean);
  if (shared.length) parts.push("shared " + shared.join(" "));
  const tr = num(p["Temp Read Blocks"]);
  const tw = num(p["Temp Written Blocks"]);
  const temp = [tr ? `read=${tr}` : "", tw ? `written=${tw}` : ""].filter(Boolean);
  if (temp.length) parts.push("temp " + temp.join(" "));
  return parts.length ? "Buffers: " + parts.join(", ") : null;
}

function pgNode(p: Obj, depth: number): PlanNode {
  const n = blank(depth, pgName(p));
  n.extras = pgExtras(p);
  n.detail = n.extras.filter((x) => !/^(?:Buckets|Batches|Memory|Workers|Heap Fetches|Sort Space)/.test(x)).join(" · ");
  n.estRows = num(p["Plan Rows"]);
  n.startupCost = num(p["Startup Cost"]);
  n.totalCost = num(p["Total Cost"]);
  n.actRows = num(p["Actual Rows"]);
  n.loops = num(p["Actual Loops"]);
  const t = num(p["Actual Total Time"]);
  if (t !== null) n.totalMs = t * (n.loops ?? 1);
  n.relation = strOf(p["Relation Name"]);
  n.schema = strOf(p.Schema);
  n.index = strOf(p["Index Name"]);
  n.filter = strOf(p.Filter);
  n.removed = num(p["Rows Removed by Filter"]);
  n.fullScan = p["Node Type"] === "Seq Scan";
  n.buffers = pgBuffers(p);
  if (Array.isArray(p.Plans)) n.children = p.Plans.filter(isObj).map((c) => pgNode(c, depth + 1));
  return n;
}

function fmtCost(v: number | null): string {
  return v === null ? "?" : v.toFixed(2);
}

function pgRaw(nodes: PlanNode[], analyze: boolean, planningMs: number | null, executionMs: number | null): string {
  const lines: string[] = [];
  for (const n of nodes) {
    const pre = n.depth === 0 ? "" : " ".repeat((n.depth - 1) * 6 + 2) + "->  ";
    const ind = " ".repeat(n.depth === 0 ? 2 : (n.depth - 1) * 6 + 8);
    let head = `${pre}${n.name}  (cost=${fmtCost(n.startupCost)}..${fmtCost(n.totalCost)} rows=${n.estRows ?? "?"})`;
    if (analyze && n.actRows !== null) {
      const per = n.totalMs !== null && n.loops ? n.totalMs / n.loops : null;
      head += ` (actual time=${per === null ? "?" : per.toFixed(3)} rows=${n.actRows} loops=${n.loops ?? 1})`;
    }
    lines.push(head);
    for (const x of n.extras) lines.push(ind + x);
    if (n.buffers) lines.push(ind + n.buffers);
  }
  if (planningMs !== null) lines.push(`Planning Time: ${planningMs.toFixed(3)} ms`);
  if (executionMs !== null) lines.push(`Execution Time: ${executionMs.toFixed(3)} ms`);
  return lines.join("\n");
}

export function parsePgJson(text: string, analyze: boolean, sql = ""): Plan {
  const j = JSON.parse(text) as unknown;
  const top = Array.isArray(j) ? j[0] : j;
  if (!isObj(top) || !isObj(top.Plan)) throw new Error("Unexpected EXPLAIN output");
  const root = pgNode(top.Plan, 0);
  const planning = num(top["Planning Time"]);
  const execution = num(top["Execution Time"]);
  const plan = finish("pg-json", analyze, [root], "", planning, execution, sql, "postgres");
  plan.raw = pgRaw(plan.nodes, plan.analyze, planning, execution);
  return plan;
}

// ---------------------------------------------------------------- MySQL JSON

const MY_OPS: Record<string, string> = {
  ordering_operation: "Sort",
  grouping_operation: "Group",
  duplicates_removal: "Remove duplicates",
  windowing: "Window",
  buffer_result: "Buffer result",
  materialized_from_subquery: "Materialize subquery",
  union_result: "Union",
  nested_loop: "Nested loop",
};

function myTableNode(t: Obj, depth: number): PlanNode {
  const table = strOf(t.table_name) ?? "?";
  const access = (strOf(t.access_type) ?? "").toUpperCase();
  const key = strOf(t.key);
  let name: string;
  if (access === "ALL") name = `Full table scan on ${table}`;
  else if (access === "INDEX") name = `Index scan on ${table}${key ? " using " + key : ""}`;
  else if (access === "RANGE") name = `Index range scan on ${table}${key ? " using " + key : ""}`;
  else if (access === "REF" || access === "EQ_REF" || access === "REF_OR_NULL") name = `Index lookup on ${table}${key ? " using " + key : ""}`;
  else if (access === "CONST" || access === "SYSTEM") name = `Single-row lookup on ${table}`;
  else name = `${access ? access.toLowerCase() + " " : ""}access on ${table}`;
  const n = blank(depth, name);
  n.relation = table;
  n.index = key;
  n.fullScan = access === "ALL";
  n.estRows = num(t.rows_examined_per_scan);
  const cost = isObj(t.cost_info) ? t.cost_info : {};
  // own cost (read + eval); prefix_cost is cumulative over the join order
  const own = (num(cost.read_cost) ?? 0) + (num(cost.eval_cost) ?? 0);
  n.totalCost = own > 0 ? own : num(cost.prefix_cost);
  if (num(cost.prefix_cost) !== null) n.extras.push(`Prefix cost: ${num(cost.prefix_cost)}`);
  const cond = strOf(t.attached_condition);
  n.filter = cond;
  if (key) n.extras.push(`Key: ${key}${Array.isArray(t.used_key_parts) ? " (" + t.used_key_parts.join(", ") + ")" : ""}`);
  if (Array.isArray(t.possible_keys)) n.extras.push(`Possible keys: ${t.possible_keys.join(", ")}`);
  if (Array.isArray(t.ref)) n.extras.push(`Ref: ${t.ref.join(", ")}`);
  if (cond) n.extras.push(`Condition: ${cond}`);
  const filtered = num(t.filtered);
  if (filtered !== null) n.extras.push(`Filtered: ${filtered}%`);
  const produced = num(t.rows_produced_per_join);
  if (produced !== null) n.extras.push(`Rows produced: ${produced}`);
  n.detail = n.extras.filter((x) => !/^Possible keys/.test(x)).join(" · ");
  // nested subqueries of the table (materialized derived tables)
  const kids: PlanNode[] = [];
  for (const k of Object.keys(t)) if (k in MY_OPS || k === "query_block") kids.push(...myWalk(t[k], k, depth + 1));
  n.children = kids;
  return n;
}

function sumCost(nodes: PlanNode[]): number | null {
  return nodes.some((c) => c.totalCost !== null) ? nodes.reduce((a, c) => a + (c.totalCost ?? 0), 0) : null;
}

/** Turns a JSON value under key `key` into nodes. */
function myWalk(v: unknown, key: string, depth: number): PlanNode[] {
  if (key === "table" && isObj(v)) return [myTableNode(v, depth)];
  if (key === "nested_loop" && Array.isArray(v)) {
    const n = blank(depth, "Nested loop");
    for (const item of v) if (isObj(item)) for (const k of Object.keys(item)) n.children.push(...myWalk(item[k], k, depth + 1));
    n.totalCost = sumCost(n.children);
    return [n];
  }
  if (key === "query_block" && isObj(v)) {
    const out: PlanNode[] = [];
    for (const k of Object.keys(v)) out.push(...myWalk(v[k], k, depth));
    return out;
  }
  if (key === "query_specifications" && Array.isArray(v)) {
    const out: PlanNode[] = [];
    for (const item of v) if (isObj(item)) for (const k of Object.keys(item)) out.push(...myWalk(item[k], k, depth));
    return out;
  }
  if (key in MY_OPS && isObj(v)) {
    const n = blank(depth, MY_OPS[key]);
    if (v.using_filesort === true) n.extras.push("Using filesort");
    if (v.using_temporary_table === true) n.extras.push("Using temporary table");
    n.detail = n.extras.join(" · ");
    for (const k of Object.keys(v)) n.children.push(...myWalk(v[k], k, depth + 1));
    n.totalCost = sumCost(n.children);
    return [n];
  }
  if ((key === "attached_subqueries" || key === "optimized_away_subqueries" || key === "select_list_subqueries") && Array.isArray(v)) {
    const out: PlanNode[] = [];
    for (const item of v) if (isObj(item)) for (const k of Object.keys(item)) out.push(...myWalk(item[k], k, depth));
    return out;
  }
  return [];
}

export function parseMysqlJson(text: string, sql = ""): Plan {
  const j = JSON.parse(text) as unknown;
  if (!isObj(j) || !isObj(j.query_block)) throw new Error("Unexpected EXPLAIN output");
  const qb = j.query_block;
  const root = blank(0, "Query block" + (num(qb.select_id) !== null ? ` #${num(qb.select_id)}` : ""));
  const cost = isObj(qb.cost_info) ? num(qb.cost_info.query_cost) : null;
  if (cost !== null) root.extras.push(`Query cost: ${cost}`);
  if (strOf(qb.message)) root.detail = strOf(qb.message) ?? "";
  for (const k of Object.keys(qb)) root.children.push(...myWalk(qb[k], k, 1));
  root.totalCost = Math.max(cost ?? 0, sumCost(root.children) ?? 0) || null;
  const plan = finish("mysql-json", false, [root], JSON.stringify(j, null, 2), null, null, sql, "mysql");
  return plan;
}

// ---------------------------------------------------------------- MySQL EXPLAIN ANALYZE / FORMAT=TREE

export function parseMysqlTree(text: string, sql = ""): Plan {
  const roots: PlanNode[] = [];
  const stack: PlanNode[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(\s*)->\s*(.*)$/.exec(raw);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 4);
    let rest = m[2];
    const n = blank(depth, "");
    const act = /\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.e+]+) loops=(\d+)\)/.exec(rest);
    if (act) {
      n.actRows = Number(act[3]);
      n.loops = Number(act[4]);
      n.totalMs = Number(act[2]) * n.loops;
      rest = rest.replace(act[0], "");
    } else if (/\(never executed\)/.test(rest)) {
      n.actRows = 0;
      n.loops = 0;
      n.totalMs = 0;
      rest = rest.replace(/\(never executed\)/, "");
    }
    const est = /\(cost=([\d.e+]+)(?:\.\.([\d.e+]+))? rows=([\d.e+]+)\)/.exec(rest);
    if (est) {
      n.totalCost = Number(est[2] ?? est[1]);
      n.startupCost = est[2] ? Number(est[1]) : null;
      n.estRows = Number(est[3]);
      rest = rest.replace(est[0], "");
    }
    rest = rest.trim();
    // "Filter: (o.created_at >= …)" / "Table scan on o" / "Index lookup on c using PRIMARY (id=o.customer_id)"
    const colon = /^([A-Z][\w -]*?):\s+(.*)$/.exec(rest);
    if (colon && !/ on /.test(colon[1])) {
      n.name = colon[1];
      n.detail = colon[2];
      if (/^Filter$/i.test(colon[1])) n.filter = colon[2];
    } else n.name = rest;
    const scan = /^(Table scan|Index scan|Index range scan|Index lookup|Single-row index lookup|Covering index scan|Covering index lookup|Full scan) on (\S+)(?: using (\S+))?/i.exec(rest);
    if (scan) {
      n.relation = scan[2];
      n.index = scan[3] ?? null;
      n.fullScan = /^table scan/i.test(scan[1]);
    }
    n.extras = n.detail ? [n.detail] : [];
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(n);
    else roots.push(n);
    stack.push(n);
  }
  if (!roots.length) throw new Error("Unexpected EXPLAIN output");
  // MySQL prints the filter as its own node above the scan: give the scan its filter (hints)
  const all = flatten(roots);
  for (const n of all) if (n.filter && n.children.length === 1 && n.children[0].fullScan && !n.children[0].filter) n.children[0].filter = n.filter;
  const analyze = all.some((n) => n.totalMs !== null);
  return finish("mysql-tree", analyze, roots, text.trim(), null, analyze ? roots[0].totalMs : null, sql, "mysql");
}

// ---------------------------------------------------------------- SQLite

/** Rows of EXPLAIN QUERY PLAN: [id, parent, notused, detail]. */
export function parseSqlitePlan(rows: unknown[][], sql = ""): Plan {
  const byId = new Map<number, PlanNode>();
  const roots: PlanNode[] = [];
  const lines: string[] = [];
  for (const r of rows) {
    const id = num(r[0]) ?? byId.size + 1;
    const parent = num(r[1]) ?? 0;
    const detail = String(r[3] ?? r[r.length - 1] ?? "");
    const n = blank(0, detail);
    const scan = /^(SCAN|SEARCH)\s+(?:TABLE\s+)?(\S+)(?:\s+AS\s+(\S+))?(?:\s+USING\s+(?:COVERING\s+|INTEGER PRIMARY KEY)?\s*(?:INDEX\s+)?(\S+)?)?/i.exec(detail);
    if (scan) {
      n.relation = scan[2];
      n.index = scan[4] ?? null;
      n.fullScan = scan[1].toUpperCase() === "SCAN" && !/USING/i.test(detail);
    }
    byId.set(id, n);
    const p = byId.get(parent);
    if (p) p.children.push(n);
    else roots.push(n);
  }
  if (!roots.length) throw new Error("No plan returned");
  const nodes = flatten(roots);
  for (const n of nodes) lines.push((n.depth ? "  ".repeat(n.depth - 1) + "|--" : "") + n.name);
  return finish("sqlite", false, roots, "QUERY PLAN\n" + lines.join("\n"), null, null, sql, "sqlite");
}

// ---------------------------------------------------------------- SQL Server showplan XML (subset)

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return out;
}

const unbracket = (s: string | undefined): string | null => (s ? s.replace(/^\[|\]$/g, "") : null);

export function parseMssqlXml(xml: string, sql = ""): Plan {
  const roots: PlanNode[] = [];
  const stack: PlanNode[] = [];
  const re = /<(\/?)(RelOp|Object|Predicate|ScalarOperator|SeekPredicates|MissingIndex|ColumnGroup|Column)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let inPredicate = false;
  let seekDepth = 0;
  const missing: { table: string; schema: string | null; cols: string[]; include: string[] }[] = [];
  let curMissing: { table: string; schema: string | null; cols: string[]; include: string[] } | null = null;
  let groupUsage = "";
  let firstStmt = true;
  while ((m = re.exec(xml))) {
    const closing = m[1] === "/";
    const tag = m[2];
    const a = closing ? {} : attrs(m[3]);
    const selfClosing = m[4] === "/";
    if (tag === "RelOp") {
      if (closing) {
        stack.pop();
        continue;
      }
      const n = blank(stack.length, a.PhysicalOp ?? "Operator");
      if (a.LogicalOp && a.LogicalOp !== a.PhysicalOp) n.extras.push(`Logical: ${a.LogicalOp}`);
      n.estRows = num(a.EstimateRows);
      n.totalCost = num(a.EstimatedTotalSubtreeCost);
      n.fullScan = a.PhysicalOp === "Table Scan" || a.PhysicalOp === "Clustered Index Scan" || a.PhysicalOp === "Index Scan";
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(n);
      else if (firstStmt) roots.push(n);
      if (!parent && roots.length) firstStmt = false;
      if (!selfClosing) stack.push(n);
      continue;
    }
    const cur = stack[stack.length - 1];
    if (tag === "Object" && cur && !closing && !cur.relation) {
      cur.relation = unbracket(a.Table);
      cur.schema = unbracket(a.Schema);
      cur.index = unbracket(a.Index);
      const alias = unbracket(a.Alias);
      if (cur.relation) cur.name += ` on ${cur.schema ? cur.schema + "." : ""}${cur.relation}${alias && alias !== cur.relation ? " " + alias : ""}${cur.index ? ` (${cur.index})` : ""}`;
      continue;
    }
    if (tag === "SeekPredicates") {
      seekDepth += closing ? -1 : selfClosing ? 0 : 1;
      continue;
    }
    if (tag === "Predicate") {
      inPredicate = !closing && !selfClosing;
      continue;
    }
    if (tag === "ScalarOperator" && !closing && cur && a.ScalarString) {
      if (inPredicate && !cur.filter) {
        cur.filter = a.ScalarString;
        cur.extras.push(`Predicate: ${a.ScalarString}`);
      } else if (seekDepth > 0 && !cur.extras.some((x) => x.startsWith("Seek:"))) cur.extras.push(`Seek: ${a.ScalarString}`);
      continue;
    }
    if (tag === "MissingIndex" && !closing) {
      curMissing = { table: unbracket(a.Table) ?? "?", schema: unbracket(a.Schema), cols: [], include: [] };
      missing.push(curMissing);
      continue;
    }
    if (tag === "ColumnGroup" && !closing) {
      groupUsage = a.Usage ?? "";
      continue;
    }
    if (tag === "Column" && !closing && curMissing && a.Name && groupUsage && stack.length === 0) {
      if (groupUsage === "INCLUDE") curMissing.include.push(unbracket(a.Name) ?? a.Name);
      else curMissing.cols.push(unbracket(a.Name) ?? a.Name);
    }
  }
  if (!roots.length) throw new Error("No plan returned (SHOWPLAN_XML)");
  for (const n of flatten(roots)) n.detail = n.extras.filter((x) => !x.startsWith("Logical:")).join(" · ");
  const plan = finish("mssql-xml", false, roots, xml, null, null, sql, "mssql");
  if (missing.length && missing[0].cols.length) {
    const mi = missing[0];
    const tbl = (mi.schema ? `[${mi.schema}].` : "") + `[${mi.table}]`;
    const name = `IX_${mi.table}_${mi.cols.join("_")}`.replace(/[^\w]/g, "_").slice(0, 120);
    const ddl = `CREATE INDEX [${name}] ON ${tbl} (${mi.cols.map((c) => `[${c}]`).join(", ")})${mi.include.length ? ` INCLUDE (${mi.include.map((c) => `[${c}]`).join(", ")})` : ""};`;
    plan.hint = { text: `SQL Server suggests a missing index on ${mi.table} (${mi.cols.join(", ")}).`, createIndex: ddl };
  }
  return plan;
}

// ---------------------------------------------------------------- dispatch

/** Parses an explain result (`columns` / `rows` of the QueryResult). */
export function parsePlan(format: PlanFormat, rows: unknown[][], analyze: boolean, sql = ""): Plan {
  if (format === "sqlite") return parseSqlitePlan(rows, sql);
  if (!rows.length) throw new Error("No plan returned");
  if (format === "pg-json") {
    const cell = rows[0][0];
    return parsePgJson(typeof cell === "string" ? cell : JSON.stringify(cell), analyze, sql);
  }
  if (format === "mysql-json") return parseMysqlJson(String(rows[0][0] ?? ""), sql);
  if (format === "mysql-tree") return parseMysqlTree(rows.map((r) => String(r[0] ?? "")).join("\n"), sql);
  return parseMssqlXml(String(rows[0][0] ?? ""), sql);
}

// ---------------------------------------------------------------- hints

/** First column name compared in a filter text: `(created_at >= …)`, `` (`shop`.`o`.`created_at` > …) ``, `([o].[status]='x')`. */
export function filterColumn(filter: string): string | null {
  const ref = String.raw`((?:(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)\.)*(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*))`;
  const m = new RegExp(String.raw`(?:^|[(\s])` + ref + String.raw`(?:\)?::[\w ]+)?\s*(?:=|>=|<=|<>|!=|>|<|~~\*?|\bLIKE\b|\bIN\b|\bBETWEEN\b|\bIS\b)`, "i").exec(filter);
  if (!m) return null;
  const parts = m[1].split(".");
  const col = parts[parts.length - 1].replace(/^["`[]|["`\]]$/g, "");
  if (/^(?:now|current_date|current_timestamp|true|false|null|and|or|not)$/i.test(col)) return null;
  return col;
}

/** Columns compared in the statement's WHERE (`alias.col =`, `col >=`): a fallback when the plan has no filter text. */
function whereColumnFor(sql: string, relation: string): string | null {
  const w = /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|\bhaving\b|$)/i.exec(sql);
  if (!w) return null;
  return filterColumn("(" + w[1].trim());
}

const big = (n: number): string => (n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M" : n >= 10_000 ? Math.round(n / 1000) + "k" : String(Math.round(n)));

function quoteFor(driver: Driver, name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  if (driver === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (driver === "mssql") return "[" + name.replace(/]/g, "]]") + "]";
  return '"' + name.replace(/"/g, '""') + '"';
}

/** The hint line for obvious cases: a full scan that dominates the plan and filters on a column → suggest an index. */
export function planHint(plan: Plan, sql: string, driver: Driver): PlanHint | null {
  const cands = plan.nodes
    .map((n, i) => ({ n, share: plan.share[i] ?? 0, i }))
    .filter((x) => x.n.fullScan && x.n.relation)
    .sort((a, b) => b.share - a.share);
  const c = cands[0];
  if (!c) return null;
  const n = c.n;
  const scanned = (n.actRows ?? n.estRows ?? 0) * Math.max(1, n.loops ?? 1) + (n.removed ?? 0);
  const dominant = c.i === plan.slowest || c.share >= 0.3 || plan.share.length === 0;
  const large = scanned >= 10_000 || plan.format === "sqlite" || (n.estRows === null && plan.share.length === 0);
  if (!dominant || !large) return null;
  const col = (n.filter ? filterColumn(n.filter) : null) ?? whereColumnFor(sql, n.relation as string);
  if (!col) return null;
  const rel = n.relation as string;
  const table = n.schema && driver !== "sqlite" ? `${quoteFor(driver, n.schema)}.${quoteFor(driver, rel)}` : quoteFor(driver, rel);
  const idxName = `idx_${rel}_${col}`.replace(/[^\w]/g, "_").slice(0, 60);
  const ddl = `CREATE INDEX ${quoteFor(driver, idxName)} ON ${table} (${quoteFor(driver, col)});`;
  const what = plan.format === "pg-json" ? "Seq Scan" : "Full scan";
  let text: string;
  if (n.removed !== null && n.actRows !== null && n.removed > 0) {
    const pct = Math.round((n.removed / (n.removed + n.actRows * Math.max(1, n.loops ?? 1))) * 100);
    text = `${what} on ${rel} reads ${big(scanned)} rows to keep ${big(n.actRows * Math.max(1, n.loops ?? 1))} (${pct}% removed by the filter)${plan.share.length ? ` and takes ${Math.round(c.share * 100)}% of the ${plan.analyze ? "time" : "cost"}` : ""} — an index on ${rel} (${col}) could help.`;
  } else if (plan.share.length) {
    text = `${what} on ${rel} is the most expensive step (est. ${big(scanned)} rows scanned) — an index on ${rel} (${col}) could help.${plan.analyze ? "" : " Turn on ANALYZE for real timings."}`;
  } else {
    text = `${what} of ${rel} reads the whole table — an index on ${rel} (${col}) could help.`;
  }
  return { text, createIndex: ddl };
}

/** "1.2M", "32 214" — row counts in the tree. */
export function fmtRows(n: number | null): string {
  if (n === null) return "—";
  if (n >= 10_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  return Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
}

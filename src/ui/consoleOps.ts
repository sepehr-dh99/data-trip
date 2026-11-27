// Console helpers of v0.16 (kept out of console.ts): preparing a run with parameters (popover → substituted SQL), the
// chips bar above a parameterized result, the production write confirmation with row estimates, and explain
// orchestration (ANALYZE of writes inside BEGIN … ROLLBACK, SQL Server SHOWPLAN on / off).
import type { EditorView } from "@codemirror/view";
import { api } from "../api";
import type { ConnectionConfig, Driver, QueryResult, SchemaNode } from "../types";
import { h } from "./dom";
import { chipText, describeParams, mapParamError, nullHint, paramsSupported, positionalCount, scanParams, substituteParams } from "./params";
import type { ParamInfo, ParamToken, ParamValue, RememberedParams, Substitution } from "./params";
import { askParams, lastUsedNote } from "./paramsPopover";
import { classifyStatement, estimateSql, formatEstimate, parseEstimate, prodOptions } from "./prodSafety";
import type { StatementClass } from "./prodSafety";
import { confirmProdWrites } from "./prodUi";
import { explainRequest, parsePlan } from "./explainPlan";
import type { Plan } from "./explainPlan";
import { confirmDialog } from "./confirm";

/** A statement that ran with parameters (result chips, error mapping, Edit parameters). */
export interface ParamRun {
  /** The statement as written (with its parameter tokens). */
  original: string;
  sub: Substitution;
  chips: string[];
  nullHint: string;
}

export interface PreparedRun {
  stmts: string[];
  info: (ParamRun | null)[];
}

export interface ParamContext {
  driver: Driver;
  view: EditorView;
  wrap: HTMLElement;
  schemas: SchemaNode[];
  defaultSchema: string | null;
  memory: RememberedParams | null;
  setMemory(m: RememberedParams): void;
  /** Dialect the literals are written in for a statement (cross-source statements: SQLite). */
  dialectFor(sql: string): Driver;
  /** Doc offset of a statement in the editor (-1 = not found). */
  locate(sql: string): number;
  /** "Run" / "Explain". */
  action: string;
}

/** Scans the statements; asks for values when any has parameters. null = cancelled. */
export async function prepareParams(ctx: ParamContext, stmts: string[]): Promise<PreparedRun | null> {
  if (!paramsSupported(ctx.driver)) return { stmts, info: stmts.map(() => null) };
  let q = 0;
  const scans: ParamToken[][] = stmts.map((sql) => {
    const t = scanParams(sql, ctx.driver, q);
    q += positionalCount(t);
    return t;
  });
  if (scans.every((t) => t.length === 0)) return { stmts, info: stmts.map(() => null) };
  const params: ParamInfo[] = describeParams(
    stmts.map((sql, i) => ({ sql, tokens: scans[i] })),
    ctx.driver,
    ctx.schemas,
    ctx.defaultSchema,
  );
  const firstIdx = scans.findIndex((t) => t.length > 0);
  const firstSql = stmts[firstIdx];
  const lastIdx = scans.length - 1 - [...scans].reverse().findIndex((t) => t.length > 0);
  const docText = ctx.view.state.doc.toString();
  const start = ctx.locate(firstSql);
  const lastStart = ctx.locate(stmts[lastIdx]);
  const anchor = lastStart >= 0 ? lastStart + stmts[lastIdx].length : start >= 0 ? start + firstSql.length : ctx.view.state.selection.main.head;
  const lineOf = (pos: number): number => docText.slice(0, Math.max(0, pos)).split("\n").length;
  const styles = new Set(params.map((p) => p.style));
  const styleText = styles.size > 1 ? "mixed" : styles.has("named") ? "named" : styles.has("positional") ? "positional ?" : "numbered $n";
  const where =
    start >= 0
      ? (() => {
          const a = lineOf(start);
          const b = lineOf(anchor);
          return stmts.length > 1 ? `${stmts.length} statements` : a === b ? `statement on line ${a}` : `statement on lines ${a}–${b}`;
        })()
      : stmts.length > 1
        ? `${stmts.length} statements`
        : "statement";
  const mem = ctx.memory;
  const ans = await askParams({
    wrap: ctx.wrap,
    view: ctx.view,
    anchor: Math.max(0, Math.min(anchor, ctx.view.state.doc.length)),
    subtitle: `${where} · ${styleText} parameter${params.length === 1 ? "" : "s"}`,
    params,
    values: mem?.values ?? {},
    remember: mem ? mem.remember : true,
    rememberNote: mem ? lastUsedNote(mem.at) : "",
    action: ctx.action,
  });
  if (!ans) return null;
  // keep every value seen so far (other statements' parameters stay remembered)
  const values: Record<string, ParamValue> = { ...(mem?.values ?? {}), ...ans.values };
  ctx.setMemory({ remember: ans.remember, values, at: Date.now() });
  const out: PreparedRun = { stmts: [], info: [] };
  stmts.forEach((sql, i) => {
    if (!scans[i].length) {
      out.stmts.push(sql);
      out.info.push(null);
      return;
    }
    const sub = substituteParams(sql, scans[i], ans.values, ctx.dialectFor(sql));
    const mine = params.filter((p) => scans[i].some((t) => t.key === p.key));
    out.stmts.push(sub.sql);
    out.info.push({
      original: sql,
      sub,
      chips: mine.map((p) => chipText(p.key, ans.values[p.key])),
      nullHint: nullHint(mine, ans.values),
    });
  });
  return out;
}

/** The error of a parameterized statement, re-expressed against its original text (error underline). */
export function paramError(e: unknown, run: ParamRun, executed: string): { position?: number; line?: number } {
  return mapParamError(e as { position?: unknown; line?: unknown }, run.sub.sql, executed, run.sub, run.original);
}

/** Chips with the values used above a result + "Edit parameters" (+ the NULL hint). */
export function paramBar(run: ParamRun, onEdit: () => void): HTMLElement {
  return h(
    "div",
    { class: "pr-wrap" },
    h(
      "div",
      { class: "pr-bar", role: "group", "aria-label": "Parameter values used" },
      h("span", { class: "pr-k" }, "Parameters"),
      run.chips.map((c) => h("span", { class: "pr-chip mono", title: c }, c)),
      h("div", { class: "spacer" }),
      h("button", { class: "btn sm pr-edit", type: "button", onclick: () => onEdit() }, "Edit parameters"),
    ),
    run.nullHint ? h("div", { class: "pr-null", role: "note" }, run.nullHint) : null,
  );
}

// ---------------------------------------------------------------- production writes

export interface WriteConfirmContext {
  config: ConnectionConfig | undefined;
  driver: Driver;
  database: string | null;
  /** The console's session when estimates are safe (auto-commit, no typed transaction), else null. */
  sessionId: () => Promise<string | null>;
}

/** Production confirmation; returns null when the data source isn't production (the caller falls back to confirmRisky). */
export async function confirmWrites(ctx: WriteConfirmContext, stmts: string[]): Promise<boolean | null> {
  const cfg = ctx.config;
  const p = prodOptions(cfg);
  if (!p || !cfg) return null;
  const writes = stmts.map((s) => classifyStatement(s, ctx.driver)).filter((c) => c.write);
  if (!writes.length) return null;
  if (!p.confirmWrites && !(p.typeNameForDrop && writes.some((w) => w.destructive))) return null;
  return confirmProdWrites({
    config: cfg,
    database: ctx.database,
    driver: ctx.driver,
    stmts,
    estimate: (c: StatementClass, sql: string) => estimateRows(ctx, c, sql),
  });
}

async function estimateRows(ctx: WriteConfirmContext, c: StatementClass, sql: string): Promise<string | null> {
  const q = estimateSql(c, sql, ctx.driver);
  if (!q) return c.destructive ? (c.kind === "DROP TABLE" ? "all rows and the table" : "all rows") : null;
  const sid = await ctx.sessionId().catch(() => null);
  if (!sid) return null;
  const run = api.execute(sid, q.sql, 50, false).then((r: QueryResult) => parseEstimate(q.format, r.columns.map((x) => x.name), r.rows));
  const timeout = new Promise<null>((res) => window.setTimeout(() => res(null), 4000));
  const n = await Promise.race([run.catch(() => null), timeout]);
  return n === null ? (c.destructive ? "all rows" : null) : formatEstimate(n, c);
}

// ---------------------------------------------------------------- explain

export interface ExplainRun {
  plan: Plan;
  write: boolean;
  kind: string;
}

/**
 * Runs the explain of one statement on the console's session. ANALYZE of a write asks first and runs inside BEGIN …
 * ROLLBACK (SAVEPOINT … ROLLBACK TO in a manual transaction). null = cancelled by the user.
 */
export async function runExplain(
  sid: string,
  driver: Driver,
  sql: string,
  o: { analyze: boolean; buffers: boolean; serverVersion: string; manualTx: boolean; askedWrite?: boolean },
): Promise<ExplainRun | null> {
  const c = classifyStatement(sql, driver);
  const req = explainRequest(driver, sql, o);
  if (!req) throw new Error("Nothing to explain");
  if (c.ddl) throw new Error(`EXPLAIN can't show a plan for ${c.kind} statements`);
  const wrapTx = req.analyze && c.write;
  if (wrapTx && !o.askedWrite) {
    const ok = await confirmDialog(
      `Explain ANALYZE this ${c.kind}?`,
      `ANALYZE runs the statement to measure it. DataTrip runs it inside ${o.manualTx ? "a savepoint" : "BEGIN"} … ROLLBACK, so its changes are undone — but triggers still fire, sequences advance and locks are taken while it runs.`,
      "Run inside ROLLBACK",
      true,
    );
    if (!ok) return null;
  }
  const begin = o.manualTx ? "SAVEPOINT dt_explain" : driver === "mysql" ? "START TRANSACTION" : "BEGIN";
  const end = o.manualTx ? "ROLLBACK TO SAVEPOINT dt_explain" : "ROLLBACK";
  let res: QueryResult;
  if (wrapTx) await api.execute(sid, begin, 1, false);
  try {
    for (const p of req.pre) await api.execute(sid, p, 1, false);
    try {
      res = await api.execute(sid, req.sql, 10_000);
    } finally {
      for (const p of req.post) await api.execute(sid, p, 1, false).catch(() => undefined);
    }
  } finally {
    if (wrapTx) {
      await api.execute(sid, end, 1, false).catch(() => undefined);
      if (o.manualTx) await api.execute(sid, "RELEASE SAVEPOINT dt_explain", 1, false).catch(() => undefined);
    }
  }
  const rows = req.format === "mysql-tree" ? res.rows.map((r) => [r[0]]) : res.rows;
  const plan = parsePlan(req.format, rows as unknown[][], req.analyze, sql);
  return { plan, write: wrapTx, kind: c.kind || "SELECT" };
}

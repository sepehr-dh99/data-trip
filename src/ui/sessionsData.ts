// Sessions & locks (v0.16, board W): per-dialect queries, normalized rows, lock chains and the cancel / kill
// commands. Pure (no DOM), node tests: node scripts/test-ops.mjs.
import type { Cell, Driver } from "../types";

export interface SessionRow {
  pid: string;
  user: string;
  app: string;
  client: string;
  db: string;
  /** active / idle / idle in transaction / background / … (as the server reports it, normalized). */
  state: string;
  /** Seconds the current state (query, transaction, idle) has lasted; null = unknown. */
  durationS: number | null;
  /** Pids this session waits for (lock waits). */
  blockedBy: string[];
  /** Wait event text ("Lock: transactionid"), or "". */
  waitEvent: string;
  query: string;
  /** The session this tab queries through (never cancelled / killed). */
  self: boolean;
  /** Server background process (autovacuum, replication…). */
  background: boolean;
}

export interface SessionQueries {
  /** Main list. */
  list: string;
  /** Optional lock-wait queries tried in order until one works: rows (waiting pid, blocking pid). */
  waits: string[];
  /** Optional: (pid, transaction seconds) for sessions with an open transaction (MySQL). */
  trx?: string;
}

/** The queries for a dialect, or null when sessions don't apply (SQLite, Redis, Kafka). */
export function sessionQueries(driver: Driver): SessionQueries | null {
  if (driver === "postgres") {
    return {
      list: `SELECT a.pid, a.usename AS user_name, a.application_name, COALESCE(host(a.client_addr), '') AS client, a.datname AS db,
  COALESCE(a.state, '') AS state, COALESCE(a.wait_event_type, '') AS wait_event_type, COALESCE(a.wait_event, '') AS wait_event,
  EXTRACT(EPOCH FROM (now() - CASE WHEN a.state = 'active' THEN a.query_start WHEN a.state LIKE 'idle in transaction%' THEN a.xact_start ELSE COALESCE(a.state_change, a.backend_start) END))::float8 AS duration_s,
  array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by, COALESCE(a.query, '') AS query,
  (a.pid = pg_backend_pid()) AS is_self, COALESCE(a.backend_type, '') AS backend_type
FROM pg_stat_activity a
ORDER BY (a.state = 'active') DESC, a.pid`,
      waits: [],
    };
  }
  if (driver === "mysql") {
    return {
      list: `SELECT ID AS pid, USER AS user_name, '' AS application_name, HOST AS client, COALESCE(DB, '') AS db, COMMAND AS command,
  COALESCE(STATE, '') AS state_detail, TIME AS duration_s, COALESCE(INFO, '') AS query, (ID = CONNECTION_ID()) AS is_self
FROM information_schema.PROCESSLIST
ORDER BY (COMMAND <> 'Sleep') DESC, ID`,
      waits: [
        "SELECT waiting_pid, blocking_pid FROM sys.innodb_lock_waits",
        `SELECT r.trx_mysql_thread_id AS waiting_pid, b.trx_mysql_thread_id AS blocking_pid
FROM performance_schema.data_lock_waits w
JOIN information_schema.INNODB_TRX r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
JOIN information_schema.INNODB_TRX b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID`,
        `SELECT r.trx_mysql_thread_id AS waiting_pid, b.trx_mysql_thread_id AS blocking_pid
FROM information_schema.INNODB_LOCK_WAITS w
JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id
JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id`,
      ],
      trx: "SELECT trx_mysql_thread_id AS pid, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS trx_s FROM information_schema.INNODB_TRX",
    };
  }
  if (driver === "mssql") {
    return {
      list: `SELECT s.session_id AS pid, s.login_name AS user_name, COALESCE(s.program_name, '') AS application_name, COALESCE(s.host_name, '') AS client,
  COALESCE(DB_NAME(COALESCE(r.database_id, s.database_id)), '') AS db,
  CASE WHEN r.session_id IS NOT NULL THEN 'active' WHEN s.open_transaction_count > 0 THEN 'idle in transaction' ELSE 'idle' END AS state,
  COALESCE(r.wait_type, '') AS wait_event,
  DATEDIFF(SECOND, COALESCE(r.start_time, s.last_request_end_time, s.login_time), SYSDATETIME()) AS duration_s,
  COALESCE(CAST(NULLIF(r.blocking_session_id, 0) AS varchar(12)), '') AS blocked_by,
  COALESCE(t.text, '') AS query, CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END AS is_self
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) t
WHERE s.is_user_process = 1
ORDER BY CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END, s.session_id`,
      waits: [],
    };
  }
  return null;
}

const s = (v: Cell | undefined): string => (v === null || v === undefined ? "" : String(v));
const n = (v: Cell | undefined): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const truthy = (v: Cell | undefined): boolean => v === true || v === 1 || v === "1" || v === "t" || v === "true";

/** Rows of the list query → SessionRow[] (columns looked up by name). */
export function normalizeSessions(driver: Driver, columns: string[], rows: Cell[][]): SessionRow[] {
  const idx = (name: string): number => columns.findIndex((c) => c.toLowerCase() === name);
  const col = (r: Cell[], name: string): Cell | undefined => {
    const i = idx(name);
    return i >= 0 ? r[i] : undefined;
  };
  return rows.map((r) => {
    const pid = s(col(r, "pid"));
    let state = s(col(r, "state"));
    let background = false;
    let app = s(col(r, "application_name"));
    if (driver === "postgres") {
      const bt = s(col(r, "backend_type"));
      if (bt && bt !== "client backend") {
        background = true;
        if (!app) app = bt;
        if (!state) state = "background";
      }
    }
    if (driver === "mysql") {
      const cmd = s(col(r, "command"));
      const detail = s(col(r, "state_detail"));
      if (cmd === "Sleep") state = "idle";
      else if (cmd === "Query" || cmd === "Execute") state = "active";
      else if (cmd === "Daemon" || /^Binlog/.test(cmd) || cmd === "Connect") {
        state = "background";
        background = true;
        if (!app) app = s(col(r, "user_name")) === "event_scheduler" ? "event scheduler" : cmd.toLowerCase();
      } else state = cmd.toLowerCase();
      if (detail && state === "active") app = app || "";
    }
    const blocked = s(col(r, "blocked_by"))
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "" && x !== "0" && x !== pid);
    const we = [s(col(r, "wait_event_type")), s(col(r, "wait_event"))].filter(Boolean).join(": ") || (driver === "mysql" ? s(col(r, "state_detail")) : "");
    return {
      pid,
      user: s(col(r, "user_name")),
      app,
      client: s(col(r, "client")),
      db: s(col(r, "db")),
      state: state || "unknown",
      durationS: n(col(r, "duration_s")),
      blockedBy: blocked,
      waitEvent: we,
      query: s(col(r, "query")).trim(),
      self: truthy(col(r, "is_self")),
      background,
    };
  });
}

/** Adds lock waits (waiting pid → blocking pid) found by a separate query (MySQL). */
export function applyWaits(rows: SessionRow[], waits: [string, string][]): void {
  const by = new Map(rows.map((r) => [r.pid, r]));
  for (const [w, b] of waits) {
    const r = by.get(w);
    if (r && b && b !== w && !r.blockedBy.includes(b)) r.blockedBy.push(b);
  }
}

/** MySQL: a sleeping session with an open InnoDB transaction is "idle in transaction" (duration = transaction age). */
export function applyTransactions(rows: SessionRow[], trx: [string, number | null][]): void {
  const by = new Map(rows.map((r) => [r.pid, r]));
  for (const [pid, secs] of trx) {
    const r = by.get(pid);
    if (r && r.state === "idle") {
      r.state = "idle in transaction";
      if (secs !== null) r.durationS = secs;
    }
  }
}

/** Sessions waiting (directly or through others) on `pid`, breadth-first, without cycles. */
export function blockedChain(rows: SessionRow[], pid: string): string[] {
  const out: string[] = [];
  const seen = new Set([pid]);
  let cur = [pid];
  while (cur.length) {
    const next: string[] = [];
    for (const p of cur) {
      for (const r of rows) {
        if (r.blockedBy.includes(p) && !seen.has(r.pid)) {
          seen.add(r.pid);
          out.push(r.pid);
          next.push(r.pid);
        }
      }
    }
    cur = next;
  }
  return out;
}

export interface LockChain {
  /** The session at the head of the chain (blocks others, waits for nobody listed). */
  root: string;
  /** Every session waiting on it, directly or indirectly. */
  waiting: string[];
}

/** Lock chains: roots that block others and wait for nobody (or for a session not in the list), largest first. */
export function lockChains(rows: SessionRow[]): LockChain[] {
  const pids = new Set(rows.map((r) => r.pid));
  const blockers = new Set<string>();
  for (const r of rows) for (const b of r.blockedBy) blockers.add(b);
  const out: LockChain[] = [];
  for (const r of rows) {
    if (!blockers.has(r.pid)) continue;
    if (r.blockedBy.some((b) => pids.has(b) && b !== r.pid)) continue;
    out.push({ root: r.pid, waiting: blockedChain(rows, r.pid) });
  }
  // a cycle (deadlock in progress) has no root: report its first member
  if (!out.length && blockers.size) {
    const first = rows.find((r) => blockers.has(r.pid));
    if (first) out.push({ root: first.pid, waiting: blockedChain(rows, first.pid) });
  }
  return out.sort((a, b) => b.waiting.length - a.waiting.length);
}

export type SessionAction = "cancel" | "kill";

/** The exact command for Cancel query / Kill session, or null when the dialect has no such action. */
export function sessionCommand(driver: Driver, action: SessionAction, pid: string): string | null {
  if (!/^\d+$/.test(pid)) return null;
  if (driver === "postgres") return action === "cancel" ? `SELECT pg_cancel_backend(${pid});` : `SELECT pg_terminate_backend(${pid});`;
  if (driver === "mysql") return action === "cancel" ? `KILL QUERY ${pid};` : `KILL ${pid};`;
  if (driver === "mssql") return action === "kill" ? `KILL ${pid};` : null;
  return null;
}

/** "12 min 04 s", "48 s". */
export function fmtDuration(sec: number | null): string {
  if (sec === null || !isFinite(sec)) return "";
  const t = Math.max(0, Math.round(sec));
  if (t >= 3600) return `${Math.floor(t / 3600)} h ${String(Math.floor((t % 3600) / 60)).padStart(2, "0")} min`;
  if (t >= 60) return `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, "0")} s`;
  return `${t} s`;
}

/** Filters of the tab: active only, hide idle, search (user / application / query / pid / client). */
export function filterSessions(rows: SessionRow[], f: { activeOnly: boolean; hideIdle: boolean; query: string }): SessionRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    const waiting = r.blockedBy.length > 0;
    if (f.activeOnly && r.state !== "active" && !waiting) return false;
    if (f.hideIdle && r.state === "idle" && !waiting) return false;
    if (q && !`${r.pid} ${r.user} ${r.app} ${r.client} ${r.db} ${r.query}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

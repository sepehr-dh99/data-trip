// Node tests of the v0.16 pure logic (CONTRACT.md v0.16): query parameters (src/ui/params.ts), explain plan parsing
// (src/ui/explainPlan.ts), sessions & locks (src/ui/sessionsData.ts), snippets (src/ui/snippets.ts) and statement
// classification for production safety (src/ui/prodSafety.ts); v0.17: grid edit / Redis / Kafka confirmation helpers,
// the SQL Server actual plan (STATISTICS XML) and the driver-aware error → help article matching (src/help/articles.ts).
// Run: node scripts/test-ops.mjs   (Node ≥ 22.18; older Node 22: node --experimental-strip-types …)
import assert from "node:assert/strict";
import { register } from "node:module";

// The frontend imports siblings without an extension (Vite style): let node try "<specifier>.ts".
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e && e.code === "ERR_MODULE_NOT_FOUND" && /^\\.{1,2}\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    throw e;
  }
}`),
);

const P = await import("../src/ui/params.ts");
const E = await import("../src/ui/explainPlan.ts");
const S = await import("../src/ui/sessionsData.ts");
const N = await import("../src/ui/snippets.ts");
const W = await import("../src/ui/prodSafety.ts");
const A = await import("../src/help/articles.ts");

let failed = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✕ ${name}\n  ${String(e.stack || e.message).split("\n").slice(0, 6).join("\n  ")}`);
  }
}
const keys = (sql, d, q) => P.scanParams(sql, d, q).map((t) => t.key);

// ---------------------------------------------------------------- parameters

test("named params, not casts / assignments / strings / comments", () => {
  const sql = "SELECT a::int, ':x' AS s, \"col:y\" -- :c\nFROM t WHERE a = :id AND b >= :from_date /* :z */ AND c := 1 AND d IN (:id, :other)";
  assert.deepEqual(keys(sql, "postgres"), [":id", ":from_date", ":id", ":other"]);
});
test("PG dollar quotes and E strings are skipped; $n numbered", () => {
  const sql = "SELECT $1, $body$ :no $2 $body$, E'it\\'s :no', x FROM t WHERE y = $2 AND z = $10";
  assert.deepEqual(keys(sql, "postgres"), ["$1", "$2", "$10"]);
});
test("? only outside PostgreSQL (JSON operators)", () => {
  assert.deepEqual(keys("SELECT * FROM t WHERE j ? 'a' AND j ?| array['b']", "postgres"), []);
  assert.deepEqual(keys("SELECT * FROM t WHERE a = ? AND b = ?", "mysql"), ["?1", "?2"]);
  assert.deepEqual(keys("SELECT * FROM t WHERE a = ?", "sqlite", 2), ["?3"]);
  assert.deepEqual(keys("SELECT ?2, ?1", "sqlite"), ["?2", "?1"]);
});
test("$n not for MySQL; array slices and labels aren't params", () => {
  assert.deepEqual(keys("SELECT $1 FROM t", "mysql"), []);
  assert.deepEqual(keys("SELECT arr[lo:hi], arr[1:2] FROM t", "postgres"), []);
  assert.deepEqual(keys("SELECT a FROM t WHERE b=:p", "mssql"), [":p"]);
  assert.deepEqual(keys("SELECT `a:b`, 'x\\':y' FROM t WHERE c = :v", "mysql"), [":v"]);
});
test("Redis / Kafka and routine definitions get none", () => {
  assert.deepEqual(keys("GET :x", "redis"), []);
  assert.deepEqual(keys("PREPARE q AS SELECT $1", "postgres"), []);
  assert.deepEqual(keys("CREATE OR REPLACE FUNCTION f(int) RETURNS int AS $$ SELECT $1 $$ LANGUAGE sql", "postgres"), []);
});
test("literals per dialect", () => {
  const v = (value, kind = "text", isNull = false) => ({ value, kind, isNull });
  assert.equal(P.paramLiteral(v("O'Brien"), "postgres"), "'O''Brien'");
  assert.equal(P.paramLiteral(v("a\\b'"), "postgres"), "E'a\\\\b'''");
  assert.equal(P.paramLiteral(v("a\\b"), "mysql"), "_utf8mb4 X'615c62'");
  assert.equal(P.paramLiteral(v("x'y"), "mysql"), "'x''y'");
  assert.equal(P.paramLiteral(v("é"), "mssql"), "N'é'");
  assert.equal(P.paramLiteral(v("-5", "number"), "postgres"), "(-5)");
  assert.equal(P.paramLiteral(v("+1.5e3", "number"), "sqlite"), "1.5e3");
  assert.equal(P.paramLiteral(v("2026-11-01", "date"), "postgres"), "'2026-11-01'");
  assert.equal(P.paramLiteral(v("", "text", true), "mysql"), "NULL");
  assert.throws(() => P.paramLiteral(v("1; DROP TABLE x", "number"), "postgres"));
  assert.throws(() => P.paramLiteral(v("2026-13", "date"), "postgres"));
});
test("validation messages", () => {
  assert.equal(P.validateParam({ value: "abc", kind: "number", isNull: false }, "bigint"), "Not a number — the column is bigint");
  assert.equal(P.validateParam({ value: "", kind: "number", isNull: false }), "Enter a value or choose NULL");
  assert.equal(P.validateParam({ value: "2026-11-01 10:30", kind: "date", isNull: false }), "");
  assert.equal(P.validateParam({ value: "x", kind: "date", isNull: true }), "");
  assert.equal(P.validateParam({ value: "", kind: "text", isNull: false }), "");
});
test("substitution, mapBack and error mapping", () => {
  const sql = "SELECT * FROM t WHERE a = :id AND b = :name";
  const toks = P.scanParams(sql, "postgres");
  const sub = P.substituteParams(sql, toks, { ":id": { kind: "number", value: "1042", isNull: false }, ":name": { kind: "text", value: "x", isNull: false } }, "postgres");
  assert.equal(sub.sql, "SELECT * FROM t WHERE a = 1042 AND b = 'x'");
  const at = sub.sql.indexOf("AND");
  assert.equal(P.mapBack(sub.edits, at), sql.indexOf("AND"));
  assert.equal(P.mapBack(sub.edits, sub.sql.indexOf("1042") + 2), sql.indexOf(":id"));
  // error at "AND" (1-based) through the pager's wrapper
  const wrapped = `SELECT * FROM (\n${sub.sql}\n) AS _dt_page LIMIT 501 OFFSET 0`;
  const pos = wrapped.indexOf("AND") + 1;
  assert.deepEqual(P.mapParamError({ position: pos }, sub.sql, wrapped, sub, sql), { position: sql.indexOf("AND") + 1 });
});
test("describeParams infers column and type from cached schema", () => {
  const schemas = [
    {
      name: "public",
      routines: [],
      sequences: [],
      tables: [
        {
          name: "orders",
          kind: "table",
          primaryKey: ["id"],
          indexes: [],
          foreignKeys: [],
          comment: null,
          columns: [
            { name: "customer_id", dataType: "bigint", nullable: false, defaultValue: null },
            { name: "created_at", dataType: "timestamptz", nullable: false, defaultValue: null },
            { name: "status", dataType: "text", nullable: false, defaultValue: null },
          ],
        },
      ],
    },
  ];
  const sql = "SELECT o.id FROM shop.public.orders o WHERE o.customer_id = :customer_id AND o.created_at >= :from_date AND :status = o.status";
  const info = P.describeParams([{ sql, tokens: P.scanParams(sql, "postgres") }], "postgres", schemas, "public");
  assert.deepEqual(info.map((i) => [i.key, i.hint, i.kind]), [
    [":customer_id", "orders.customer_id · bigint", "number"],
    [":from_date", "orders.created_at · timestamptz", "date"],
    [":status", "orders.status · text", "text"],
  ]);
  assert.equal(info[0].equality, true);
  assert.equal(info[1].equality, false);
  const hint = P.nullHint(info, { ":status": { kind: "text", value: "", isNull: true } });
  assert.match(hint, /o\.status IS NULL/);
});
test("remembered values parse tolerantly", () => {
  assert.equal(P.parseRemembered(null), null);
  const r = P.parseRemembered({ remember: true, at: 5, values: { ":a": { kind: "number", value: "1", isNull: false }, bad: 3 } });
  assert.deepEqual(r, { remember: true, at: 5, values: { ":a": { kind: "number", value: "1", isNull: false } } });
});

// ---------------------------------------------------------------- production safety

test("classify writes, tables, WHERE", () => {
  const c = (s, d = "postgres") => W.classifyStatement(s, d);
  let x = c("UPDATE shop.public.customers\nSET marketing_opt_in = false;");
  assert.deepEqual([x.kind, x.write, x.table, x.noWhere], ["UPDATE", true, "shop.public.customers", true]);
  x = c("DELETE FROM shop.public.orders\nWHERE status = 'cancelled'\n  AND created_at < '2025-01-01';");
  assert.deepEqual([x.kind, x.table, x.where, x.noWhere], ["DELETE", "shop.public.orders", "status = 'cancelled' AND created_at < '2025-01-01'", false]);
  x = c("DROP TABLE IF EXISTS shop.public.events_archive_2023;");
  assert.deepEqual([x.kind, x.destructive, x.ddl, x.table], ["DROP TABLE", true, true, "shop.public.events_archive_2023"]);
  x = c("TRUNCATE shop.public.events;");
  assert.deepEqual([x.kind, x.destructive, x.table], ["TRUNCATE", true, "shop.public.events"]);
  x = c("SELECT id FROM t WHERE x = 'DELETE FROM y'");
  assert.equal(x.write, false);
  x = c("WITH old AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM old)");
  assert.deepEqual([x.kind, x.table, x.noWhere], ["DELETE", "t", false]);
  x = c("INSERT INTO `shop`.`users` (a) VALUES (1)", "mysql");
  assert.deepEqual([x.kind, x.table], ["INSERT", "`shop`.`users`"]);
  x = c("CREATE INDEX CONCURRENTLY idx ON orders (created_at)");
  assert.deepEqual([x.kind, x.ddl, x.table], ["CREATE INDEX", true, "orders"]);
  x = c("UPDATE t SET a = (SELECT 1 WHERE true)");
  assert.equal(x.noWhere, true);
  x = c("MERGE INTO [dbo].[t] AS t USING s ON t.id = s.id WHEN MATCHED THEN DELETE;", "mssql");
  assert.deepEqual([x.kind, x.table], ["MERGE", "[dbo].[t]"]);
  x = c("SELECT * INTO backup_t FROM t", "mssql");
  assert.deepEqual([x.kind, x.write, x.table], ["SELECT INTO", true, "backup_t"]);
  x = c("EXPLAIN ANALYZE DELETE FROM t");
  assert.equal(x.write, true);
  assert.equal(c("EXPLAIN SELECT 1").write, false);
  assert.equal(c("SET search_path TO x").write, false);
});
test("estimates", () => {
  const cls = W.classifyStatement("DELETE FROM orders WHERE id > 5", "postgres");
  assert.equal(W.estimateSql(cls, "DELETE FROM orders WHERE id > 5;", "postgres").sql, "EXPLAIN (FORMAT JSON) DELETE FROM orders WHERE id > 5");
  const j = JSON.stringify([{ Plan: { "Node Type": "ModifyTable", "Plan Rows": 0, Plans: [{ "Node Type": "Seq Scan", "Plan Rows": 12480 }] } }]);
  assert.equal(W.parseEstimate("pg-json", ["QUERY PLAN"], [[j]]), 12480);
  assert.equal(W.parseEstimate("mysql-rows", ["id", "table", "rows"], [[1, "t", 52340]]), 52340);
  assert.equal(W.formatEstimate(12480, cls), "~12 480 (planner estimate)");
  assert.equal(W.estimateSql(W.classifyStatement("SELECT 1", "sqlite"), "SELECT 1", "sqlite"), null);
});
test("production options", () => {
  assert.equal(W.prodOptions({ name: "x" }), null);
  assert.equal(W.prodOptions({ name: "x", production: { enabled: false } }), null);
  assert.deepEqual(W.prodOptions({ name: "x", production: { enabled: true } }), { enabled: true, color: "#FF1A3C", confirmWrites: true, typeNameForDrop: true });
});

// ---------------------------------------------------------------- explain

const PG_PLAN = [
  {
    Plan: {
      "Node Type": "Limit",
      "Startup Cost": 48210.55,
      "Total Cost": 48210.6,
      "Plan Rows": 20,
      "Actual Total Time": 412.8,
      "Actual Rows": 20,
      "Actual Loops": 1,
      Plans: [
        {
          "Node Type": "Hash Join",
          "Join Type": "Inner",
          "Startup Cost": 1902.2,
          "Total Cost": 47805.35,
          "Plan Rows": 30950,
          "Actual Total Time": 395.6,
          "Actual Rows": 32214,
          "Actual Loops": 1,
          "Hash Cond": "(o.customer_id = c.id)",
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "orders",
              Schema: "public",
              Alias: "o",
              "Startup Cost": 0,
              "Total Cost": 45120.4,
              "Plan Rows": 31200,
              "Actual Total Time": 371.2,
              "Actual Rows": 32214,
              "Actual Loops": 1,
              Filter: "(created_at >= (now() - '30 days'::interval))",
              "Rows Removed by Filter": 1168402,
              "Shared Hit Blocks": 2114,
              "Shared Read Blocks": 18902,
            },
            {
              "Node Type": "Hash",
              "Startup Cost": 1741,
              "Total Cost": 1741,
              "Plan Rows": 12900,
              "Actual Total Time": 10.2,
              "Actual Rows": 13120,
              "Actual Loops": 1,
              Plans: [
                {
                  "Node Type": "Index Scan",
                  "Index Name": "customers_tier_idx",
                  "Relation Name": "customers",
                  Alias: "c",
                  "Startup Cost": 0.42,
                  "Total Cost": 1741,
                  "Plan Rows": 12900,
                  "Actual Total Time": 7.8,
                  "Actual Rows": 13120,
                  "Actual Loops": 1,
                  "Index Cond": "(tier = 'gold'::text)",
                },
              ],
            },
          ],
        },
      ],
    },
    "Planning Time": 1.912,
    "Execution Time": 412.873,
  },
];

test("explain statements per dialect", () => {
  assert.equal(E.explainRequest("postgres", "SELECT 1;", { analyze: true, buffers: true, serverVersion: "16.2" }).sql, "EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) SELECT 1");
  assert.equal(E.explainRequest("postgres", "SELECT 1", { analyze: false, buffers: true, serverVersion: "" }).sql, "EXPLAIN (FORMAT JSON) SELECT 1");
  assert.equal(E.explainRequest("mysql", "SELECT 1", { analyze: true, buffers: false, serverVersion: "8.0.36" }).format, "mysql-tree");
  assert.equal(E.explainRequest("mysql", "SELECT 1", { analyze: true, buffers: false, serverVersion: "8.0.17" }).format, "mysql-json");
  assert.equal(E.explainRequest("mysql", "SELECT 1", { analyze: true, buffers: false, serverVersion: "10.11.6-MariaDB" }).format, "mysql-json");
  assert.deepEqual(E.explainRequest("mssql", "SELECT 1", { analyze: false, buffers: false, serverVersion: "" }).pre, ["SET SHOWPLAN_XML ON"]);
  // v0.17: SQL Server ANALYZE = actual plan via STATISTICS XML; the marker makes the backend return only the plans
  const ms = E.explainRequest("mssql", "UPDATE t SET a = 1;", { analyze: true, buffers: false, serverVersion: "" });
  assert.deepEqual([ms.pre, ms.post, ms.analyze, ms.format], [["SET STATISTICS XML ON"], ["SET STATISTICS XML OFF"], true, "mssql-xml"]);
  assert.equal(ms.sql, E.MSSQL_SHOWPLAN_MARKER + " UPDATE t SET a = 1");
  assert.equal(E.explainRequest("mssql", "SELECT 1", { analyze: false, buffers: false, serverVersion: "" }).sql, "/*datatrip:showplan*/ SELECT 1");
  assert.equal(E.analyzeSupported("mssql", "Microsoft SQL Server 2019"), true);
  assert.equal(E.analyzeSupported("sqlite", ""), false);
  assert.equal(E.explainRequest("sqlite", "SELECT 1", { analyze: false, buffers: false, serverVersion: "" }).sql, "EXPLAIN QUERY PLAN SELECT 1");
});
test("PostgreSQL JSON plan: tree, self time, slowest, hint, raw", () => {
  const plan = E.parsePlan("pg-json", [[JSON.stringify(PG_PLAN)]], true, "SELECT … WHERE o.created_at >= now() - interval '30 days'");
  assert.deepEqual(plan.nodes.map((n) => [n.depth, n.name]), [
    [0, "Limit"],
    [1, "Hash Join"],
    [2, "Seq Scan on orders o"],
    [2, "Hash"],
    [3, "Index Scan using customers_tier_idx on customers c"],
  ]);
  assert.equal(plan.slowest, 2);
  assert.ok(Math.abs(plan.nodes[1].selfMs - (395.6 - 371.2 - 10.2)) < 1e-6);
  assert.equal(plan.executionMs, 412.873);
  assert.ok(plan.hint);
  assert.match(plan.hint.text, /Seq Scan on orders reads 1\.2M rows to keep 32k \(97% removed/);
  assert.equal(plan.hint.createIndex, "CREATE INDEX idx_orders_created_at ON public.orders (created_at);");
  assert.match(plan.raw, /->  Seq Scan on orders o  \(cost=0\.00\.\.45120\.40 rows=31200\) \(actual time=371\.200 rows=32214 loops=1\)/);
  assert.match(plan.raw, /Buffers: shared hit=2114 read=18902/);
  assert.equal(E.misestimate(plan.nodes[0]), 1);
});
test("PostgreSQL estimate-only plan uses cost shares", () => {
  const p = JSON.parse(JSON.stringify(PG_PLAN));
  const strip = (n) => {
    for (const k of Object.keys(n)) if (k.startsWith("Actual") || k === "Rows Removed by Filter") delete n[k];
    (n.Plans ?? []).forEach(strip);
  };
  strip(p[0].Plan);
  delete p[0]["Execution Time"];
  const plan = E.parsePlan("pg-json", [[JSON.stringify(p)]], false);
  assert.equal(plan.analyze, false);
  assert.equal(plan.slowest, 2);
  assert.ok(Math.abs(plan.share.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.match(plan.hint.text, /most expensive step/);
});
test("MySQL JSON plan", () => {
  const j = {
    query_block: {
      select_id: 1,
      cost_info: { query_cost: "12034.50" },
      ordering_operation: {
        using_filesort: true,
        nested_loop: [
          { table: { table_name: "o", access_type: "ALL", rows_examined_per_scan: 98000, filtered: "33.33", cost_info: { read_cost: "9000.00", eval_cost: "980.00", prefix_cost: "9980.00" }, attached_condition: "(`shop`.`o`.`created_at` >= <cache>((now() - interval 30 day)))" } },
          { table: { table_name: "c", access_type: "eq_ref", key: "PRIMARY", used_key_parts: ["id"], rows_examined_per_scan: 1, cost_info: { read_cost: "1500.00", eval_cost: "554.50", prefix_cost: "12034.50" } } },
        ],
      },
    },
  };
  const plan = E.parsePlan("mysql-json", [[JSON.stringify(j)]], false, "");
  assert.deepEqual(plan.nodes.map((n) => n.name), ["Query block #1", "Sort", "Nested loop", "Full table scan on o", "Index lookup on c using PRIMARY"]);
  assert.equal(plan.slowest, 3);
  assert.equal(plan.hint.createIndex, "CREATE INDEX idx_o_created_at ON o (created_at);");
});
test("MySQL EXPLAIN ANALYZE text", () => {
  const text = [
    "-> Limit: 20 row(s)  (cost=12034 rows=20) (actual time=150.1..150.2 rows=20 loops=1)",
    "    -> Nested loop inner join  (cost=12034 rows=32666) (actual time=0.2..148.0 rows=32214 loops=1)",
    "        -> Filter: (o.created_at >= <cache>((now() - interval 30 day)))  (cost=9980 rows=32666) (actual time=0.1..120.0 rows=32214 loops=1)",
    "            -> Table scan on o  (cost=9980 rows=98000) (actual time=0.05..80.0 rows=1200616 loops=1)",
    "        -> Single-row index lookup on c using PRIMARY (id=o.customer_id)  (cost=0.25 rows=1) (actual time=0.001..0.001 rows=1 loops=32214)",
  ].join("\n");
  const plan = E.parsePlan("mysql-tree", [[text]], true);
  assert.deepEqual(plan.nodes.map((n) => n.depth), [0, 1, 2, 3, 2]);
  assert.equal(plan.nodes[3].relation, "o");
  assert.equal(plan.nodes[3].fullScan, true);
  assert.ok(plan.analyze);
  assert.equal(plan.nodes[4].totalMs, 0.001 * 32214);
  assert.equal(plan.hint.createIndex, "CREATE INDEX idx_o_created_at ON o (created_at);");
});
test("SQLite query plan", () => {
  const plan = E.parsePlan("sqlite", [[2, 0, 0, "SCAN orders"], [5, 0, 0, "SEARCH customers USING INTEGER PRIMARY KEY (rowid=?)"], [9, 0, 0, "USE TEMP B-TREE FOR ORDER BY"]], false, "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'paid' ORDER BY o.total");
  assert.deepEqual(plan.nodes.map((n) => n.name), ["SCAN orders", "SEARCH customers USING INTEGER PRIMARY KEY (rowid=?)", "USE TEMP B-TREE FOR ORDER BY"]);
  assert.equal(plan.nodes[0].fullScan, true);
  assert.equal(plan.hint.createIndex, "CREATE INDEX idx_orders_status ON orders (status);");
});
test("SQL Server showplan XML subset", () => {
  const xml = `<ShowPlanXML><BatchSequence><Batch><Statements><StmtSimple><QueryPlan>
<MissingIndexes><MissingIndexGroup Impact="91.2"><MissingIndex Database="[shop]" Schema="[dbo]" Table="[orders]"><ColumnGroup Usage="EQUALITY"><Column Name="[status]" ColumnId="3"/></ColumnGroup><ColumnGroup Usage="INCLUDE"><Column Name="[total]" ColumnId="4"/></ColumnGroup></MissingIndex></MissingIndexGroup></MissingIndexes>
<RelOp NodeId="0" PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="120" EstimatedTotalSubtreeCost="5.5">
 <Hash><RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="120" EstimatedTotalSubtreeCost="4.5">
   <IndexScan><Object Database="[shop]" Schema="[dbo]" Table="[orders]" Index="[PK_orders]" Alias="[o]"/>
   <Predicate><ScalarOperator ScalarString="[shop].[dbo].[orders].[status] as [o].[status]=N'paid'"/></Predicate></IndexScan></RelOp>
 <RelOp NodeId="2" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.5"><IndexScan><Object Schema="[dbo]" Table="[customers]" Index="[IX_c]"/></IndexScan></RelOp>
 </Hash></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
  const plan = E.parsePlan("mssql-xml", [[xml]], false);
  assert.deepEqual(plan.nodes.map((n) => [n.depth, n.name]), [
    [0, "Hash Match"],
    [1, "Clustered Index Scan on dbo.orders o (PK_orders)"],
    [1, "Index Seek on dbo.customers (IX_c)"],
  ]);
  assert.equal(plan.slowest, 1);
  assert.equal(plan.hint.createIndex, "CREATE INDEX [IX_orders_status] ON [dbo].[orders] ([status]) INCLUDE ([total]);");
});
test("filterColumn", () => {
  assert.equal(E.filterColumn("(created_at >= (now() - '30 days'::interval))"), "created_at");
  assert.equal(E.filterColumn("((status)::text = 'paid'::text)"), "status");
  assert.equal(E.filterColumn("(`shop`.`o`.`created_at` >= x)"), "created_at");
});

// ---------------------------------------------------------------- sessions

test("normalize PG sessions and trace lock chains", () => {
  const cols = ["pid", "user_name", "application_name", "client", "db", "state", "wait_event_type", "wait_event", "duration_s", "blocked_by", "query", "is_self", "backend_type"];
  const rows = [
    [48121, "app_rw", "checkout-api", "10.4.2.17", "shop", "idle in transaction", "Client", "ClientRead", 724, "", "UPDATE …", false, "client backend"],
    [48177, "app_rw", "checkout-api", "10.4.2.18", "shop", "active", "Lock", "transactionid", 221, "48121", "UPDATE …", false, "client backend"],
    [48190, "batch", "order-sync", "10.4.3.40", "shop", "active", "Lock", "tuple", 72, "48177", "SELECT … FOR UPDATE", false, "client backend"],
    [48214, "dt", "DataTrip", "", "shop", "active", "", "", 0, "", "SELECT …", true, "client backend"],
    [47901, "postgres", "", "", "", "", "", "", 251, "", "autovacuum: VACUUM", false, "autovacuum worker"],
  ];
  const list = S.normalizeSessions("postgres", cols, rows);
  assert.equal(list[0].pid, "48121");
  assert.equal(list[3].self, true);
  assert.equal(list[4].background, true);
  assert.equal(list[4].app, "autovacuum worker");
  assert.equal(list[1].waitEvent, "Lock: transactionid");
  const chains = S.lockChains(list);
  assert.deepEqual(chains, [{ root: "48121", waiting: ["48177", "48190"] }]);
  assert.equal(S.filterSessions(list, { activeOnly: true, hideIdle: false, query: "" }).length, 3);
  assert.equal(S.filterSessions(list, { activeOnly: false, hideIdle: false, query: "order-sync" }).length, 1);
});
test("MySQL sessions with waits and transactions", () => {
  const cols = ["pid", "user_name", "application_name", "client", "db", "command", "state_detail", "duration_s", "query", "is_self"];
  const list = S.normalizeSessions("mysql", cols, [
    [10, "app", "", "h:1", "shop", "Sleep", "", 300, "", 0],
    [11, "app", "", "h:2", "shop", "Query", "updating", 20, "UPDATE t …", 0],
    [12, "me", "", "h:3", "", "Query", "executing", 0, "SELECT …", 1],
    [5, "event_scheduler", "", "localhost", "", "Daemon", "Waiting", 9999, "", 0],
  ]);
  S.applyTransactions(list, [["10", 310]]);
  S.applyWaits(list, [["11", "10"]]);
  assert.equal(list[0].state, "idle in transaction");
  assert.equal(list[0].durationS, 310);
  assert.equal(list[3].background, true);
  assert.deepEqual(S.lockChains(list), [{ root: "10", waiting: ["11"] }]);
});
test("cancel / kill commands", () => {
  assert.equal(S.sessionCommand("postgres", "cancel", "42"), "SELECT pg_cancel_backend(42);");
  assert.equal(S.sessionCommand("postgres", "kill", "42"), "SELECT pg_terminate_backend(42);");
  assert.equal(S.sessionCommand("mysql", "cancel", "42"), "KILL QUERY 42;");
  assert.equal(S.sessionCommand("mssql", "cancel", "42"), null);
  assert.equal(S.sessionCommand("mssql", "kill", "42"), "KILL 42;");
  assert.equal(S.sessionCommand("postgres", "kill", "1; DROP"), null);
  assert.equal(S.sessionQueries("sqlite"), null);
  assert.equal(S.fmtDuration(724), "12 min 04 s");
});

// ---------------------------------------------------------------- snippets

test("snippet templates", () => {
  const d = new Date(2026, 10, 27);
  let t = N.snippetTemplate("SELECT * FROM $CURSOR", "", d);
  assert.deepEqual(t, { template: "SELECT * FROM ${3}", firstIsTable: false, firstIsColumn: false, cursorAfterTableKeyword: true });
  t = N.snippetTemplate("SELECT * FROM $TABLE WHERE $CURSOR", "", d);
  assert.equal(t.template, "SELECT * FROM ${1:table} WHERE ${3}");
  assert.equal(t.firstIsTable, true);
  t = N.snippetTemplate("SELECT $COLUMN FROM $TABLE GROUP BY $COLUMN {x} $DATE '$DATE' $SELECTION", "a{b}", d);
  assert.equal(t.template, "SELECT ${2:column} FROM ${1:table} GROUP BY ${2:column} \\{x\\} '2026-11-27' '2026-11-27' a\\{b\\}");
  assert.equal(t.firstIsColumn, true);
});
test("abbreviation detection and lookup", () => {
  assert.deepEqual(N.abbrBefore("  sel", 5), { word: "sel", from: 2 });
  assert.deepEqual(N.abbrBefore("WHERE x IN (sel", 15), { word: "sel", from: 12 });
  assert.equal(N.abbrBefore("SELECT 'sel", 11), null);
  assert.equal(N.abbrBefore("a.sel", 5), null);
  assert.equal(N.abbrBefore("-- sel", 6), null);
  const list = N.snippetsFor(N.effectiveSnippets(N.defaultSnippetSettings()), "mssql");
  assert.ok(N.findSnippet(list, "top"));
  assert.equal(N.findSnippet(list, "lim"), null);
  assert.equal(N.snippetsFor(list, "redis").length, 0);
});
test("user snippets override, hide and merge", () => {
  const s = N.mergeSnippetSettings({ user: [{ abbr: "sel", name: "Mine", body: "SELECT 1", dialects: ["postgres", "bogus"] }, { abbr: "x", body: "X" }], hidden: ["cnt"], expandKey: "space", inCompletion: false });
  assert.deepEqual(s.user[0].dialects, ["postgres"]);
  const eff = N.effectiveSnippets(s);
  assert.equal(eff.find((e) => e.abbr === "sel").name, "Mine");
  assert.equal(eff.find((e) => e.abbr === "sel").edited, true);
  assert.equal(eff.some((e) => e.abbr === "cnt"), false);
  assert.equal(eff[eff.length - 1].abbr, "x");
  assert.equal(s.expandKey, "space");
  assert.equal(N.dialectLabel(["postgres", "mysql"]), "PG, MySQL");
});

// ---------------------------------------------------------------- v0.17: SQL Server actual plan (STATISTICS XML)

const MSSQL_ACTUAL = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" Version="1.564" Build="16.0.4135.4" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
  <BatchSequence>
    <Batch>
      <Statements>
        <StmtSimple StatementText="SELECT o.id, c.name FROM dbo.orders o JOIN dbo.customers c ON c.id = o.customer_id WHERE o.status = N'paid'" StatementId="1" StatementCompId="1" StatementType="SELECT" RetrievedFromCache="true" StatementSubTreeCost="12.4107" StatementEstRows="1200" SecurityPolicyApplied="false" StatementOptmLevel="FULL" QueryHash="0x4E1A2B3C4D5E6F70" QueryPlanHash="0x0F1E2D3C4B5A6978" CardinalityEstimationModelVersion="160">
          <StatementSetOptions QUOTED_IDENTIFIER="true" ARITHABORT="true" CONCAT_NULL_YIELDS_NULL="true" ANSI_NULLS="true" ANSI_PADDING="true" ANSI_WARNINGS="true" NUMERIC_ROUNDABORT="false" />
          <QueryPlan DegreeOfParallelism="4" MemoryGrant="4096" CachedPlanSize="64" CompileTime="3" CompileCPU="3" CompileMemory="560">
            <ThreadStat Branches="1" UsedThreads="4">
              <ThreadReservation NodeId="0" ReservedThreads="4" />
            </ThreadStat>
            <MemoryGrantInfo SerialRequiredMemory="1536" SerialDesiredMemory="2048" RequiredMemory="1600" DesiredMemory="4096" RequestedMemory="4096" GrantWaitTime="0" GrantedMemory="4096" MaxUsedMemory="2304" MaxQueryMemory="1024000" />
            <OptimizerHardwareDependentProperties EstimatedAvailableMemoryGrant="204800" EstimatedPagesCached="51200" EstimatedAvailableDegreeOfParallelism="4" MaxCompileMemory="1048576" />
            <QueryTimeStats CpuTime="210" ElapsedTime="64" />
            <RelOp NodeId="0" PhysicalOp="Parallelism" LogicalOp="Gather Streams" EstimateRows="1200" EstimateIO="0" EstimateCPU="0.0298" AvgRowSize="40" EstimatedTotalSubtreeCost="12.4107" Parallel="true" EstimateRebinds="0" EstimateRewinds="0" EstimatedExecutionMode="Row">
              <OutputList>
                <ColumnReference Database="[shop]" Schema="[dbo]" Table="[orders]" Alias="[o]" Column="id" />
              </OutputList>
              <RunTimeInformation>
                <RunTimeCountersPerThread Thread="0" ActualRows="25480" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="63" ActualCPUms="2" />
              </RunTimeInformation>
              <Parallelism>
                <RelOp NodeId="1" PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="1200" EstimateIO="0" EstimateCPU="0.21" AvgRowSize="40" EstimatedTotalSubtreeCost="12.3809" Parallel="true" EstimateRebinds="0" EstimateRewinds="0" EstimatedExecutionMode="Row">
                  <OutputList />
                  <MemoryFractions Input="1" Output="1" />
                  <RunTimeInformation>
                    <RunTimeCountersPerThread Thread="4" ActualRows="6400" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="60" ActualCPUms="21" InputMemoryGrant="1024" OutputMemoryGrant="1024" UsedMemoryGrant="576" />
                    <RunTimeCountersPerThread Thread="3" ActualRows="6300" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="58" ActualCPUms="20" />
                    <RunTimeCountersPerThread Thread="2" ActualRows="6380" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="59" ActualCPUms="20" />
                    <RunTimeCountersPerThread Thread="1" ActualRows="6400" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="57" ActualCPUms="19" />
                    <RunTimeCountersPerThread Thread="0" ActualRows="0" ActualEndOfScans="0" ActualExecutions="0" />
                  </RunTimeInformation>
                  <Hash>
                    <DefinedValues />
                    <HashKeysBuild><ColumnReference Database="[shop]" Schema="[dbo]" Table="[customers]" Alias="[c]" Column="id" /></HashKeysBuild>
                    <RelOp NodeId="2" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="5000" EstimateIO="0.0231" EstimateCPU="0.0056" AvgRowSize="30" EstimatedTotalSubtreeCost="0.0287" TableCardinality="5000" Parallel="true" EstimateRebinds="0" EstimateRewinds="0" EstimatedExecutionMode="Row">
                      <OutputList />
                      <RunTimeInformation>
                        <RunTimeCountersPerThread Thread="4" ActualRows="1250" ActualRowsRead="1250" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="4" ActualCPUms="1" ActualScans="1" ActualLogicalReads="9" />
                        <RunTimeCountersPerThread Thread="3" ActualRows="1250" ActualRowsRead="1250" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="3" ActualCPUms="1" ActualScans="1" ActualLogicalReads="9" />
                        <RunTimeCountersPerThread Thread="2" ActualRows="1250" ActualRowsRead="1250" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="3" ActualCPUms="1" ActualScans="1" ActualLogicalReads="9" />
                        <RunTimeCountersPerThread Thread="1" ActualRows="1250" ActualRowsRead="1250" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="2" ActualCPUms="1" ActualScans="1" ActualLogicalReads="9" />
                        <RunTimeCountersPerThread Thread="0" ActualRows="0" ActualEndOfScans="0" ActualExecutions="0" />
                      </RunTimeInformation>
                      <IndexScan Ordered="false" ForcedIndex="false" ForceSeek="false" ForceScan="false" NoExpandHint="false" Storage="RowStore">
                        <DefinedValues />
                        <Object Database="[shop]" Schema="[dbo]" Table="[customers]" Index="[IX_customers_name]" Alias="[c]" IndexKind="NonClustered" Storage="RowStore" />
                      </IndexScan>
                    </RelOp>
                    <RelOp NodeId="3" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="1200" EstimateIO="11.2" EstimateCPU="0.275" AvgRowSize="24" EstimatedTotalSubtreeCost="11.475" TableCardinality="1000000" Parallel="true" EstimateRebinds="0" EstimateRewinds="0" EstimatedExecutionMode="Row">
                      <OutputList />
                      <RunTimeInformation>
                        <RunTimeCountersPerThread Thread="4" ActualRows="6400" ActualRowsRead="251000" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="55" ActualCPUms="40" ActualScans="1" ActualLogicalReads="3100" />
                        <RunTimeCountersPerThread Thread="3" ActualRows="6300" ActualRowsRead="249000" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="52" ActualCPUms="39" ActualScans="1" ActualLogicalReads="3050" />
                        <RunTimeCountersPerThread Thread="2" ActualRows="6380" ActualRowsRead="250500" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="54" ActualCPUms="40" ActualScans="1" ActualLogicalReads="3090" />
                        <RunTimeCountersPerThread Thread="1" ActualRows="6400" ActualRowsRead="249500" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="51" ActualCPUms="38" ActualScans="1" ActualLogicalReads="3060" />
                        <RunTimeCountersPerThread Thread="0" ActualRows="0" ActualEndOfScans="0" ActualExecutions="0" />
                      </RunTimeInformation>
                      <IndexScan Ordered="false" ForcedIndex="false" ForceScan="false" NoExpandHint="false" Storage="RowStore">
                        <DefinedValues />
                        <Object Database="[shop]" Schema="[dbo]" Table="[orders]" Index="[PK_orders]" Alias="[o]" IndexKind="Clustered" Storage="RowStore" />
                        <Predicate>
                          <ScalarOperator ScalarString="[shop].[dbo].[orders].[status] as [o].[status]=N'paid'">
                            <Compare CompareOp="EQ"><ScalarOperator><Identifier><ColumnReference Database="[shop]" Schema="[dbo]" Table="[orders]" Alias="[o]" Column="status" /></Identifier></ScalarOperator><ScalarOperator><Const ConstValue="N'paid'" /></ScalarOperator></Compare>
                          </ScalarOperator>
                        </Predicate>
                      </IndexScan>
                    </RelOp>
                  </Hash>
                </RelOp>
              </Parallelism>
            </RelOp>
          </QueryPlan>
        </StmtSimple>
      </Statements>
    </Batch>
  </BatchSequence>
</ShowPlanXML>`;

test("SQL Server actual plan: RunTimeCountersPerThread, misestimate, self time, hint", () => {
  const sql = "SELECT o.id, c.name FROM dbo.orders o JOIN dbo.customers c ON c.id = o.customer_id WHERE o.status = N'paid'";
  const plan = E.parsePlan("mssql-xml", [[MSSQL_ACTUAL]], true, sql);
  assert.equal(plan.analyze, true);
  assert.deepEqual(plan.nodes.map((n) => [n.depth, n.name]), [
    [0, "Parallelism"],
    [1, "Hash Match"],
    [2, "Index Scan on dbo.customers c (IX_customers_name)"],
    [2, "Clustered Index Scan on dbo.orders o (PK_orders)"],
  ]);
  const [gather, hash, cust, orders] = plan.nodes;
  // ActualRows summed over the threads; a parallel operator every thread ran once = one execution
  assert.deepEqual([gather.actRows, gather.loops, hash.actRows, hash.loops, cust.actRows, orders.actRows, orders.loops], [25480, 1, 25480, 1, 5000, 25480, 1]);
  assert.equal(E.misestimate(orders) > 20, true);
  assert.equal(E.misestimate(cust), 1);
  // inclusive time = the slowest thread; self = inclusive − children
  assert.deepEqual([gather.totalMs, hash.totalMs, cust.totalMs, orders.totalMs], [63, 60, 4, 55]);
  assert.deepEqual([gather.selfMs, hash.selfMs, cust.selfMs, orders.selfMs], [3, 1, 4, 55]);
  assert.equal(plan.slowest, 3);
  assert.equal(orders.removed, 1_000_000 - 25480);
  assert.equal(plan.executionMs, 64);
  assert.equal(plan.planningMs, 3);
  assert.match(orders.extras.join(" | "), /Actual rows: 25480, executions: 4, threads: 4, rows read: 1000000/);
  assert.equal(plan.hint.createIndex, "CREATE INDEX idx_orders_status ON dbo.orders (status);");
  assert.match(plan.hint.text, /reads 1M rows to keep 25k \(97% removed by the filter\)/);
  // the estimated plan (no RunTimeInformation) still parses as before
  const est = E.parsePlan("mssql-xml", [[MSSQL_ACTUAL.replace(/<RunTimeInformation>[\s\S]*?<\/RunTimeInformation>/g, "").replace(/<QueryTimeStats[^>]*\/>/, "")]], false, sql);
  assert.equal(est.analyze, false);
  assert.equal(est.nodes[3].actRows, null);
  assert.equal(est.executionMs, null);
});
test("SQL Server actual plan: nested loops executions, operators that never ran, batch mode", () => {
  const xml = `<ShowPlanXML><BatchSequence><Batch><Statements><StmtSimple><QueryPlan CompileTime="1">
<QueryTimeStats CpuTime="9" ElapsedTime="12" />
<RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="40" EstimatedTotalSubtreeCost="0.9">
 <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1200" ActualEndOfScans="1" ActualExecutions="1" ActualElapsedms="11" /></RunTimeInformation>
 <NestedLoops Optimized="false">
  <RelOp NodeId="1" PhysicalOp="Hash Match" LogicalOp="Aggregate" EstimateRows="40" EstimatedTotalSubtreeCost="0.5" EstimatedExecutionMode="Batch">
   <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1200" Batches="2" ActualEndOfScans="0" ActualExecutions="1" ActualExecutionMode="Batch" ActualElapsedms="2" /></RunTimeInformation>
   <Hash><RelOp NodeId="2" PhysicalOp="Columnstore Index Scan" LogicalOp="Index Scan" EstimateRows="100000" EstimatedTotalSubtreeCost="0.4" EstimatedExecutionMode="Batch">
    <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="100000" ActualRowsRead="100000" Batches="112" ActualEndOfScans="0" ActualExecutions="1" ActualExecutionMode="Batch" ActualElapsedms="6" /></RunTimeInformation>
    <IndexScan><Object Schema="[dbo]" Table="[events]" Index="[CCI_events]" /></IndexScan></RelOp></Hash></RelOp>
  <RelOp NodeId="3" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.3">
   <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1200" ActualEndOfScans="0" ActualExecutions="1200" ActualElapsedms="2" /></RunTimeInformation>
   <IndexScan><Object Schema="[dbo]" Table="[users]" Index="[PK_users]" /></IndexScan></RelOp>
  <RelOp NodeId="4" PhysicalOp="Filter" LogicalOp="Filter" EstimateRows="1" EstimatedTotalSubtreeCost="0.01" />
 </NestedLoops></RelOp>
</QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
  const plan = E.parsePlan("mssql-xml", [[xml]], true);
  const [nl, agg, cci, seek, filter] = plan.nodes;
  assert.deepEqual([seek.loops, seek.actRows, E.misestimate(seek)], [1200, 1, 1]);
  assert.deepEqual([filter.actRows, filter.loops], [0, 0]);
  // batch mode reports its own time: made inclusive (2 + 6), so self time stays 2
  assert.deepEqual([cci.totalMs, agg.totalMs, agg.selfMs, nl.selfMs], [6, 8, 2, 1]);
  assert.match(agg.extras.join(" | "), /batch mode/);
  assert.equal(E.misestimate(agg), 30);
  assert.deepEqual([plan.executionMs, plan.planningMs], [12, 1]);
});

// ---------------------------------------------------------------- v0.17: production confirmation helpers

test("grid edits: counts, statements, +N more", () => {
  const edits = [
    { kind: "update", schema: "public", table: "orders", key: { id: 7 }, changes: { status: "paid", note: "it's ok" }, columnTypes: { id: "int4", status: "text", note: "text" } },
    { kind: "update", schema: "public", table: "orders", key: { id: 8 }, changes: { total: "12.50", flag: true }, columnTypes: { id: "int4", total: "numeric", flag: "bool" } },
    { kind: "insert", schema: "public", table: "orders", key: {}, changes: { id: "9", status: null }, columnTypes: { id: "int8", status: "text" } },
    { kind: "insert", schema: "public", table: "orders", key: {}, changes: {}, columnTypes: {} },
    { kind: "delete", schema: "public", table: "orders", key: { id: 3, region: null }, changes: {}, columnTypes: { id: "int4", region: "text" } },
  ];
  const s = W.summarizeEdits(edits);
  assert.deepEqual([s.updates, s.inserts, s.deletes, s.tables], [2, 2, 1, ["public.orders"]]);
  assert.equal(W.editCountsText(s), "2 updates, 2 inserts, 1 delete");
  assert.equal(W.editCountsText(W.summarizeEdits(edits.slice(4))), "1 delete");
  const pg = W.editStatements(edits, "postgres");
  assert.deepEqual(pg, [
    `UPDATE "public"."orders" SET "status" = 'paid', "note" = 'it''s ok' WHERE "id" = 7`,
    `UPDATE "public"."orders" SET "total" = 12.50, "flag" = TRUE WHERE "id" = 8`,
    `INSERT INTO "public"."orders" ("id", "status") VALUES (9, NULL)`,
    `INSERT INTO "public"."orders" DEFAULT VALUES`,
    `DELETE FROM "public"."orders" WHERE "id" = 3 AND "region" IS NULL`,
  ]);
  const my = W.editStatements(edits, "mysql");
  assert.equal(my[1], "UPDATE `public`.`orders` SET `total` = 12.50, `flag` = 1 WHERE `id` = 8");
  assert.equal(my[3], "INSERT INTO `public`.`orders` () VALUES ()");
  assert.equal(W.editStatements([{ ...edits[0], schema: "dbo" }], "mssql")[0], "UPDATE [dbo].[orders] SET [status] = N'paid', [note] = N'it''s ok' WHERE [id] = 7");
  // a numeric-looking text in a text column stays quoted
  assert.equal(W.cellLiteral("007", "varchar(10)", "postgres"), "'007'");
  const list = W.statementListText(Array.from({ length: 12 }, (_, i) => `DELETE FROM t WHERE id = ${i}`));
  assert.equal(list.split("\n").length, 9);
  assert.match(list, /DELETE FROM t WHERE id = 7;\n-- \+4 more$/);
  assert.equal(W.statementListText(["SET a 1"], 8, 1600, ""), "SET a 1");
});
test("Redis command classification", () => {
  const c = (l) => W.classifyRedisCommand(l);
  for (const r of ["GET user:1", "HGETALL s", "SCAN 0 MATCH x*", "TTL k", "KEYS *", "CONFIG GET maxmemory", "SORT l", "INFO", "ACL WHOAMI", "SCRIPT EXISTS abc", "XRANGE s - +", "  "]) assert.equal(c(r).write, false, r);
  for (const w of ["SET a 1", "del a", "UNLINK a b", "EXPIRE k 60", "PEXPIREAT k 1", "HSET h f v", "LPUSH l x", "RPUSHX l x", "INCRBY n 2", "ZADD z 1 a", "SINTERSTORE d a b", "SORT l STORE d", "CONFIG SET maxmemory 1gb", "JSON.SET k $ 1", "EVAL 'return 1' 0", "XADD s * f v", "RENAME a b"]) assert.equal(c(w).write, true, w);
  assert.deepEqual([c("SET 'my key' 1").target, c("SET \"a b\" 1").target], ["my key", "a b"]);
  assert.deepEqual([c("FLUSHDB").destructive, c("flushall async").destructive, c("SWAPDB 0 1").destructive, c("SCRIPT FLUSH").destructive, c("DEL a").destructive], [true, true, true, true, false]);
  assert.equal(c("FLUSHDB").target, null);
  assert.equal(c("DEL a b c").keys, 3);
  assert.equal(c("config set x 1").kind, "CONFIG SET");
});
test("Kafka command / action classification", () => {
  const k = (l) => W.classifyKafkaCommand(l);
  for (const r of ["topics", "groups", "describe topic orders", "consume orders --latest --limit 5"]) assert.equal(k(r).write, false, r);
  assert.deepEqual([k('produce orders key=1 value="a b"').write, k("produce orders value=1").target], [true, "orders"]);
  assert.deepEqual([k("create topic t2 partitions=3").kind, k("create topic t2").destructive], ["create topic", false]);
  const d = k("DELETE TOPIC orders.v1");
  assert.deepEqual([d.write, d.destructive, d.target, d.kind], [true, true, "orders.v1", "delete topic"]);
  assert.equal(W.kafkaActionText({ kind: "produce", topic: "orders", partition: null, key: "k 1", value: "{}", headers: 2 }), 'produce orders key="k 1" (+2 headers) value={}');
  assert.equal(W.kafkaActionText({ kind: "delete topic", topic: "orders" }), "delete topic orders");
  assert.equal(W.kafkaActionText({ kind: "create topic", topic: "t", partitions: 3, replication: 2 }), "create topic t partitions=3 replication=2");
  assert.equal(W.kafkaActionText({ kind: "reset offsets", group: "g", topic: "t", to: "offset", value: 42, partitions: 3 }), "reset offsets of group g on t to offset 42");
});
test("error help is driver-aware (Redis / Kafka commands, not SQL)", () => {
  const f = A.errorArticleFor;
  assert.equal(f("ERR wrong number of arguments for 'hset' command", { driver: "redis" }), "trouble-redis-command");
  assert.equal(f("WRONGTYPE Operation against a key holding the wrong kind of value", { driver: "redis" }), "trouble-redis-command");
  assert.equal(f("ERR unknown command 'FOO', with args beginning with: ", { driver: "redis" }), "trouble-redis-command");
  assert.equal(f("READONLY You can't write against a read only replica.", { driver: "redis" }), "trouble-redis-server");
  assert.equal(f("OOM command not allowed when used memory > 'maxmemory'.", { driver: "redis" }), "trouble-redis-server");
  assert.equal(f("NOAUTH Authentication required.", { driver: "redis" }), "trouble-auth");
  // the same words on a SQL source don't lead to the Redis articles
  assert.equal(f('syntax error at or near "SELEC"', { driver: "postgres" }), null);
  assert.equal(f("ERR syntax error"), null);
  assert.equal(f('Unknown command "consum". Commands: topics, …', { driver: "kafka" }), "trouble-kafka-command");
  assert.equal(f('Expected name=value, got "x" (quote values containing spaces)', { driver: "kafka" }), "trouble-kafka-command");
  assert.equal(f("Could not create topic orders: Broker: Topic already exists", { driver: "kafka" }), "trouble-kafka-admin");
  assert.equal(f('Consumer group "g" is Stable; stop its consumers (the group must be Empty) before resetting offsets', { driver: "kafka" }), "trouble-kafka-admin");
  assert.equal(f("Could not connect to Kafka: timeout", { driver: "kafka" }), "trouble-kafka-transport");
  assert.equal(f("No data source named 'x'", { driver: "redis" }), null);
  assert.equal(f("No data source named 'x'", { driver: "postgres" }), "cross-source");
  const ids = new Set(A.ARTICLES.map((a) => a.id));
  for (const m of A.ERROR_HELP) assert.ok(ids.has(m.id), m.id);
  for (const a of A.ARTICLES) for (const r of a.related ?? []) assert.ok(ids.has(r), `${a.id} → ${r}`);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

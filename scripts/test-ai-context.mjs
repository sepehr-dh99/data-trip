// Node tests of the AI assistant's context building (src/ui/aiContext.ts, src/ui/aiCross.ts — CONTRACT.md v0.15).
// Run: node scripts/test-ai-context.mjs   (Node ≥ 22.18; older Node 22: node --experimental-strip-types …)
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

const { buildSchemaContext, pickTables } = await import("../src/ui/aiContext.ts");
const { buildCrossContext, checkCrossSql, crossRules, detectCrossSource, refinePrompt, sourcesSection } = await import("../src/ui/aiCross.ts");

let failed = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✕ ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

const col = (name, dataType = "integer", nullable = true) => ({ name, dataType, nullable });
const table = (name, columns, fks = []) => ({ name, kind: "table", columns, primaryKey: ["id"], foreignKeys: fks, comment: null });
const schema = (name, tables) => ({ name, tables });

const ASIA = {
  connId: "a",
  name: "Asia32",
  driver: "postgres",
  ref: "asia32",
  database: "postgres",
  databases: [{ name: "postgres", isSystem: false }, { name: "analytics", isSystem: false }],
  schemas: [schema("public", [table("users", [col("id"), col("email", "text")]), table("invoices", [col("id"), col("user_id")])])],
  defaultSchema: "public",
  own: true,
  blocked: false,
};
const STAGE = {
  connId: "s",
  name: "Stage MySQL",
  driver: "mysql",
  ref: "stage_mysql",
  database: "shop",
  databases: [{ name: "shop", isSystem: false }, { name: "mysql", isSystem: true }],
  schemas: [schema("shop", [table("orders", [col("id"), col("user_id"), col("total", "decimal(10,2)"), col("created_at", "datetime")]), table("users", [col("id"), col("email", "varchar(200)")])])],
  defaultSchema: null,
  own: false,
  blocked: false,
};
const LITE = {
  connId: "l",
  name: "Local file",
  driver: "sqlite",
  ref: "local_file",
  database: null,
  databases: [],
  schemas: [schema("main", [table("notes", [col("id"), col("body", "text")])])],
  defaultSchema: null,
  own: false,
  blocked: false,
};
const PROD = {
  connId: "p",
  name: "Prod PG",
  driver: "postgres",
  ref: "prod_pg",
  database: "app",
  databases: [{ name: "app", isSystem: false }],
  schemas: [schema("public", [table("payments", [col("id")])])],
  defaultSchema: "public",
  own: false,
  blocked: true,
};
const ALL = [ASIA, STAGE, LITE, PROD];

const routeCtx = {
  ownConnId: "a",
  sources: ALL.map((s) => ({ connId: s.connId, name: s.name, driver: s.driver })),
  attached: [],
  ownAlias: null,
  nativeNames: new Set(["postgres", "analytics", "public"]),
};

test("single-source context is unchanged by the refactor", () => {
  const ctx = buildSchemaContext({ driver: "postgres", schemas: ASIA.schemas, database: "postgres", defaultSchema: "public", text: "users with invoices", autoTables: true });
  assert.ok(ctx.text.startsWith("-- PostgreSQL · database postgres · default schema public"));
  assert.ok(ctx.text.includes("CREATE TABLE public.users ("));
  assert.equal(ctx.picked, true);
  assert.deepEqual(ctx.tables.map((t) => t.table.name).sort(), ["invoices", "users"]);
  const p = pickTables(ASIA.schemas, "nothing matches here", "public", true, 1);
  assert.equal(p.namesOnly, true);
});

test("sources list: names, drivers, own database; no blocked sources", () => {
  const txt = sourcesSection(ALL);
  assert.ok(txt.includes("- asia32 — PostgreSQL · this console · current database postgres"), txt);
  assert.ok(txt.includes("- stage_mysql — MySQL"));
  assert.ok(txt.includes("- local_file — SQLite"));
  assert.ok(!txt.includes("prod_pg"));
  assert.ok(!txt.includes("orders"), "no schema in the list");
});

test("detection: named source, table only elsewhere, database only elsewhere, explicit words", () => {
  let d = detectCrossSource("total of orders per user email from stage mysql", ALL);
  assert.deepEqual(d.involved, ["s"]);
  assert.equal(d.reasons.s, "named");
  assert.equal(d.cross, true);
  d = detectCrossSource("count orders per day", ALL);
  assert.deepEqual(d.involved, ["s"]);
  assert.equal(d.reasons.s, "table orders");
  d = detectCrossSource("list users", ALL);
  assert.deepEqual(d.involved, [], "users exists on the own source too");
  assert.equal(d.cross, false);
  d = detectCrossSource("everything in the shop database", ALL);
  assert.deepEqual(d.involved, ["s"]);
  d = detectCrossSource("compare users across data sources", ALL);
  assert.equal(d.explicit, true);
  assert.ok(d.involved.includes("s"));
  assert.equal(d.cross, true);
  d = detectCrossSource("users and their notes", ALL);
  assert.ok(d.involved.includes("l"));
});

test("detection: blocked production sources", () => {
  let d = detectCrossSource("join prod_pg payments with users", ALL);
  assert.deepEqual(d.involved, []);
  assert.deepEqual(d.blocked, [{ connId: "p", essential: true }]);
  d = detectCrossSource("sum of payments", ALL);
  assert.deepEqual(d.blocked, [{ connId: "p", essential: false }]);
  d = detectCrossSource("refine", ALL, ["s"]);
  assert.equal(d.reasons.s, "used in the SQL");
});

test("detection needs the own schema for table hits", () => {
  const ownEmpty = { ...ASIA, schemas: [] };
  const d = detectCrossSource("count orders per day", [ownEmpty, STAGE]);
  assert.deepEqual(d.involved, []);
});

test("cross context: rules, example, cross-source names, budget split", () => {
  const ctx = buildCrossContext([ASIA, STAGE], "users and their orders totals", true);
  assert.ok(ctx.text.includes("Cross-source query rules"));
  assert.ok(ctx.text.includes("FROM asia32.postgres.users AS u"), ctx.text);
  assert.ok(ctx.text.includes("JOIN stage_mysql.shop.orders AS o"));
  assert.ok(ctx.text.includes("CREATE TABLE asia32.postgres.users ("));
  assert.ok(ctx.text.includes("CREATE TABLE stage_mysql.shop.orders ("));
  assert.ok(ctx.text.includes("strftime"));
  assert.ok(ctx.text.includes("no ILIKE"));
  assert.ok(ctx.tables.length <= 25);
  assert.ok(ctx.perSource.a >= 1 && ctx.perSource.s >= 1);
  // big schemas: 25 tables in total, shared
  const many = (prefix, n) => [schema("public", Array.from({ length: n }, (_, i) => table(`${prefix}_orders_${i}`, [col("id"), col("order_ref")])))];
  const big = buildCrossContext([{ ...ASIA, schemas: many("a", 40) }, { ...STAGE, schemas: many("b", 40), driver: "postgres", database: "x" }], "orders", true);
  assert.equal(big.tables.length, 25);
  assert.ok(Math.abs(big.perSource.a - big.perSource.s) <= 1, JSON.stringify(big.perSource));
  // a source that wants little leaves the rest to the other
  const lop = buildCrossContext([{ ...ASIA, schemas: many("a", 40) }, LITE], "orders notes", true);
  assert.equal(lop.perSource.l, 1);
  assert.equal(lop.perSource.a, 24);
  assert.ok(crossRules([LITE]).includes("local_file.main.users"));
});

test("check: a correct cross-source query passes", () => {
  const sql = "SELECT u.email, SUM(o.total) AS total FROM asia32.postgres.users AS u JOIN stage_mysql.shop.orders AS o ON o.user_id = u.id WHERE o.created_at >= '2026-01-01' AND u.email LIKE '%@x.com' GROUP BY u.email ORDER BY total DESC LIMIT 10";
  const r = checkCrossSql(sql, routeCtx, ALL, ["s"]);
  assert.equal(r.federated, true);
  assert.deepEqual(r.problems, []);
  const cte = "WITH t AS (SELECT o.user_id, COUNT(*) AS n FROM stage_mysql.shop.orders o GROUP BY o.user_id) SELECT u.email, t.n FROM asia32.postgres.users u JOIN t ON t.user_id = u.id";
  assert.deepEqual(checkCrossSql(cte, routeCtx, ALL).problems, []);
  const sub = "SELECT u.id FROM asia32.postgres.users u WHERE u.id IN (SELECT o.user_id FROM stage_mysql.shop.orders o) AND strftime('%Y', u.created) = '2026' AND substr(u.email, 1, 2) = 'ab'";
  assert.deepEqual(checkCrossSql(sub, routeCtx, ALL).problems, []);
});

test("check: the typical bad queries", () => {
  // unknown source
  let r = checkCrossSql("select * from asia32.postgres.users u join stagemysql.shop.orders o on o.user_id = u.id", routeCtx, ALL);
  assert.ok(r.problems.some((p) => p.startsWith("unknown data source 'stagemysql'")), r.problems.join("\n"));
  // missing database
  r = checkCrossSql("select * from users u join stage_mysql.orders o on o.user_id = u.id", routeCtx, ALL, ["s"]);
  assert.ok(r.problems.some((p) => p.includes("'stage_mysql.orders' is missing the database: write stage_mysql.shop.orders")), r.problems.join("\n"));
  assert.ok(r.problems.some((p) => p.startsWith("the query doesn't read from stage_mysql")));
  // ILIKE, ::cast, NOW(), bare own table, TOP
  r = checkCrossSql("select top 5 u.email from users u join stage_mysql.shop.orders o on o.user_id = u.id where u.email ilike '%a%' and o.created_at > now() - interval '1 day' and o.total::int > 3", routeCtx, ALL);
  assert.equal(r.federated, true);
  const has = (s) => assert.ok(r.problems.some((p) => p.includes(s)), `${s}\n${r.problems.join("\n")}`);
  has("used ILIKE");
  has("::cast");
  has("NOW()");
  has("INTERVAL");
  has("table 'users' has no data source");
  has("TOP n");
  // writes
  r = checkCrossSql("delete from stage_mysql.shop.orders where id in (select u.id from asia32.postgres.users u)", routeCtx, ALL);
  assert.ok(r.problems.some((p) => p.includes("read-only")), r.problems.join("\n"));
  // blocked source
  r = checkCrossSql("select * from asia32.postgres.users u join prod_pg.app.payments p on p.id = u.id", routeCtx, ALL);
  assert.ok(r.problems.some((p) => p.includes("production data source")));
  // a native single-source query is fine
  assert.deepEqual(checkCrossSql("select * from public.users where email ilike 'a%'", routeCtx, ALL).problems, []);
  // strings and comments don't count
  assert.deepEqual(checkCrossSql("select u.id from asia32.postgres.users u join stage_mysql.shop.orders o on o.user_id = u.id where u.email = 'ilike now()' -- ::int", routeCtx, ALL).problems, []);
  assert.ok(refinePrompt(["used ILIKE in the outer query."]).includes("found: used ILIKE in the outer query. Fix"));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

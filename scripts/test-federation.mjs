// Node tests of the cross-source naming / routing logic in src/ui/federation.ts (CONTRACT.md v0.13).
// Run: node scripts/test-federation.mjs   (Node ≥ 22.18; older Node 22: node --experimental-strip-types …)
import assert from "node:assert/strict";
import {
  fedSourcesFor,
  findTableRefs,
  refPathBefore,
  resolveSource,
  routeStatement,
  sourceRef,
  sourceSlug,
  tableRef,
} from "../src/ui/federation.ts";

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

const SOURCES = [
  { connId: "a", name: "Asia32", driver: "postgres" },
  { connId: "s", name: "Stage MySQL", driver: "mysql" },
  { connId: "m", name: "Sales MSSQL", driver: "mssql" },
  { connId: "l", name: "Local file", driver: "sqlite" },
  { connId: "p", name: "Public", driver: "postgres" },
];

/** Context of a console on `own` (defaults: the Asia32 console, no attachments). */
function ctx(over = {}) {
  return {
    ownConnId: "a",
    sources: SOURCES,
    attached: [],
    ownAlias: null,
    nativeNames: new Set(["postgres", "app", "public", "sales"]),
    ...over,
  };
}

const kinds = (r) => r.kind;
const usedIds = (r) => (r.kind === "federated" ? [...new Set(r.uses.map((u) => u.connId))].sort() : []);

test("slugs", () => {
  assert.equal(sourceSlug("Asia32"), "asia32");
  assert.equal(sourceSlug("Stage MySQL"), "stage_mysql");
  assert.equal(sourceSlug("  --Prod  PG (eu-1)-- "), "prod_pg_eu_1");
  assert.equal(sourceSlug("1st db"), "1st_db");
  assert.equal(sourceSlug("سرور"), "");
  assert.equal(sourceRef(SOURCES[1], SOURCES), "stage_mysql");
  assert.equal(sourceRef({ connId: "x", name: "1st db", driver: "mysql" }), '"1st db"');
  const twins = [...SOURCES, { connId: "a2", name: "asia-32", driver: "mysql" }]; // slug asia_32: no clash
  const clash = [...SOURCES, { connId: "a3", name: "ASIA32!", driver: "mysql" }];
  assert.equal(sourceRef(SOURCES[0], twins), "asia32");
  assert.equal(sourceRef(SOURCES[0], clash), '"Asia32"');
});

test("table refs: positions, quoting, strings and comments", () => {
  const refs = findTableRefs(
    "select a.id, b.x from asia32.postgres.users a join \"Stage MySQL\".shop.users b on b.id = a.id, [Sales MSSQL].crm.dbo.t c -- from x.y.z\nwhere a.k = 'from p.q.r'",
  );
  assert.deepEqual(
    refs.map((r) => r.parts.map((p) => (p.quoted ? `«${p.text}»` : p.text)).join(".")),
    ["asia32.postgres.users", "«Stage MySQL».shop.users", "«Sales MSSQL».crm.dbo.t"],
  );
  assert.deepEqual(findTableRefs("select x.y.z from t"), []);
  assert.equal(findTableRefs("select * from (select * from asia32.postgres.u) s join l.t on 1=1").length, 2);
});

test("the user's query runs federated from any console", () => {
  const sql = "select * from asia32.postgres.users a join stage_mysql.shop.users b on b.email = a.email";
  const r = routeStatement(sql, ctx({ ownConnId: "m", nativeNames: new Set(["master", "sales"]) }));
  assert.equal(r.kind, "federated");
  assert.deepEqual(usedIds(r), ["a", "s"]);
  // From the Asia32 console its own slug is fine too.
  const own = routeStatement(sql, ctx());
  assert.equal(own.kind, "federated");
  assert.deepEqual(usedIds(own), ["a", "s"]);
});

test("native names stay native", () => {
  // Only the own source referenced → native (also by its slug).
  assert.equal(kinds(routeStatement("select * from public.users", ctx())), "native");
  assert.equal(kinds(routeStatement("select * from asia32.postgres.users", ctx())), "native");
  // "public" is a data source slug AND a schema of this database → native.
  assert.equal(kinds(routeStatement("select * from public.x.users", ctx())), "native");
  // MSSQL db.schema.table where db is a database of the console's server.
  const ms = ctx({ ownConnId: "m", nativeNames: new Set(["master", "sales", "dbo"]) });
  assert.equal(kinds(routeStatement("select * from sales.dbo.orders", ms)), "native");
  // MySQL db.table (2 parts never route to a server source by slug).
  const my = ctx({ ownConnId: "s", nativeNames: new Set(["shop"]) });
  assert.equal(kinds(routeStatement("select * from shop.users", my)), "native");
  assert.equal(kinds(routeStatement("select * from asia32.users", my)), "native");
  // Column references aren't table references.
  assert.equal(kinds(routeStatement("select stage_mysql.shop.x from t", ctx())), "native");
});

test("quoted names and SQLite two-part references", () => {
  const r = routeStatement('select * from "Stage MySQL".shop.users', ctx());
  assert.equal(r.kind, "federated");
  assert.equal(r.uses[0].via, "name");
  const b = routeStatement("select * from `stage mysql`.shop.users", ctx());
  assert.deepEqual(usedIds(b), ["s"]);
  const l = routeStatement("select * from local_file.notes n join asia32.postgres.users u on u.id = n.uid", ctx({ ownConnId: "s", nativeNames: new Set(["shop"]) }));
  assert.deepEqual(usedIds(l), ["a", "l"]);
});

test("ambiguous slugs are an error", () => {
  const sources = [...SOURCES, { connId: "s2", name: "stage-mysql", driver: "mysql" }];
  const r = routeStatement("select * from stage_mysql.shop.users", ctx({ sources }));
  assert.equal(r.kind, "error");
  assert.match(r.message, /matches more than one data source \(Stage MySQL, stage-mysql\)/);
  assert.match(r.message, /Quote the exact name/);
  const q = routeStatement('select * from "stage-mysql".shop.users', ctx({ sources }));
  assert.deepEqual(usedIds(q), ["s2"]);
});

test("attached aliases keep working", () => {
  const c = ctx({ attached: [{ alias: "my", connId: "s" }], ownAlias: "pg" });
  const r = routeStatement("select * from pg.public.users u join my.orders o on o.uid = u.id", c);
  assert.equal(r.kind, "federated");
  assert.deepEqual(usedIds(r), ["a", "s"]);
  // An attached alias wins over a native name.
  const c2 = ctx({ attached: [{ alias: "app", connId: "s" }] });
  assert.equal(kinds(routeStatement("select * from app.orders", c2)), "federated");
  // Own alias alone, nothing attached → native.
  assert.equal(kinds(routeStatement("select * from pg.public.users", ctx({ ownAlias: "pg" }))), "native");
});

test("resolveSource tiers", () => {
  assert.equal(resolveSource({ text: "asia32", quoted: false }, ctx()).connId, "a");
  assert.equal(resolveSource({ text: "ASIA32", quoted: false }, ctx()).connId, "a");
  assert.equal(resolveSource({ text: "sales", quoted: false }, ctx()), null); // native name
  assert.equal(resolveSource({ text: "Sales MSSQL", quoted: true }, ctx()).connId, "m");
  assert.equal(resolveSource({ text: "nobody", quoted: false }, ctx()), null);
});

test("FedSources sent for a statement", () => {
  const r = routeStatement("select * from asia32.postgres.users a join stage_mysql.shop.users b on 1 = 1", ctx({ ownConnId: "m", nativeNames: new Set() }));
  const fs = fedSourcesFor(r.uses, { connId: "m", name: "Sales MSSQL", database: "crm" }, null, [], SOURCES);
  assert.deepEqual(fs, [
    { alias: "sales_mssql", connectionId: "m", database: "crm" },
    { alias: "asia32", connectionId: "a", database: null },
    { alias: "stage_mysql", connectionId: "s", database: null },
  ]);
  // Attached: alias first (with its database), own strip alias + own slug, slug of an attached source too.
  const c = ctx({ attached: [{ alias: "my", connId: "s" }], ownAlias: "pg" });
  const r2 = routeStatement("select * from pg.public.u join stage_mysql.shop.o on 1 = 1 join my.t on 1 = 1", c);
  const fs2 = fedSourcesFor(r2.uses, { connId: "a", name: "Asia32", database: "app" }, "pg", [{ alias: "my", connId: "s", database: "shop" }], SOURCES);
  assert.deepEqual(fs2, [
    { alias: "my", connectionId: "s", database: "shop" },
    { alias: "pg", connectionId: "a", database: "app" },
    { alias: "asia32", connectionId: "a", database: "app" },
    { alias: "stage_mysql", connectionId: "s", database: "shop" },
  ]);
  // A source without a usable slug still gets a valid alias (it is written quoted).
  const odd = [...SOURCES, { connId: "o", name: "1st db", driver: "mysql" }];
  const r3 = routeStatement('select * from "1st db".shop.t', ctx({ sources: odd }));
  const fs3 = fedSourcesFor(r3.uses, { connId: "a", name: "Asia32", database: null }, null, [], odd);
  assert.deepEqual(fs3.map((f) => f.alias), ["asia32", "s_1st_db"]);
});

test("references written by the example / drag", () => {
  assert.equal(tableRef("asia32", "postgres", "postgres", "public", "users"), "asia32.postgres.users");
  assert.equal(tableRef("asia32", "postgres", "postgres", "sales", "orders"), "asia32.postgres.sales.orders");
  assert.equal(tableRef("asia32", "postgres", "Analytics", "public", "Events"), 'asia32."Analytics"."Events"');
  assert.equal(tableRef("stage_mysql", "mysql", "shop", "shop", "users"), "stage_mysql.shop.users");
  assert.equal(tableRef("sales_mssql", "mssql", "crm", "dbo", "t"), "sales_mssql.crm.t");
  assert.equal(tableRef("sales_mssql", "mssql", "crm", "hr", "t"), "sales_mssql.crm.hr.t");
  assert.equal(tableRef("local_file", "sqlite", null, "main", "notes"), "local_file.main.notes");
  assert.equal(tableRef('"1st db"', "mysql", null, "shop", "t"), '"1st db".shop.t');
});

test("completion path parsing", () => {
  assert.deepEqual(refPathBefore("select * from asia32."), { path: [{ text: "asia32", quoted: false }], word: "" });
  assert.deepEqual(refPathBefore("from asia32.postgres.us"), {
    path: [
      { text: "asia32", quoted: false },
      { text: "postgres", quoted: false },
    ],
    word: "us",
  });
  assert.deepEqual(refPathBefore('join "Stage MySQL".shop.'), {
    path: [
      { text: "Stage MySQL", quoted: true },
      { text: "shop", quoted: false },
    ],
    word: "",
  });
  assert.equal(refPathBefore("from a.b.c.d."), null);
  assert.equal(refPathBefore("select 1"), null);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

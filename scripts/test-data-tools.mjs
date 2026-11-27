// Node tests of the v0.16 pure modules: value viewer formatting (src/ui/valueFormat.ts), the table designer's
// SQL (src/ui/designerSql.ts) and the read-only SQL highlighter (src/ui/sqlHighlight.ts).
// Run: node scripts/test-data-tools.mjs   (Node ≥ 22.18; older Node 22: node --experimental-strip-types …)
import assert from "node:assert/strict";
import { compactJson, defaultMode, hexRows, hexToBytes, jsonLines, jsonToStore, parseJson, prettyJson, sizeLabel, topLevelPaths, wantsViewer } from "../src/ui/valueFormat.ts";
import { colList, createTableForImport, designSql, ident, normType, runnable, sameType, typeForKind } from "../src/ui/designerSql.ts";
import { highlightSql } from "../src/ui/sqlHighlight.ts";

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

// ------------------------------------------------------------------ value viewer

test("viewer: which cells open it", () => {
  assert.equal(wantsViewer("text", "short"), false);
  assert.equal(wantsViewer("text", "x".repeat(200)), true);
  assert.equal(wantsViewer("text", "a\nb"), true);
  assert.equal(wantsViewer("jsonb", "{}"), true);
  assert.equal(wantsViewer("text", '{"a":1}'), true);
  assert.equal(wantsViewer("text", "{not json}"), false);
  assert.equal(wantsViewer("bytea", "0x00"), true);
  assert.equal(wantsViewer("int4", 5), false);
  assert.equal(wantsViewer("text", null), false);
  assert.equal(defaultMode("bytea", "0x0102"), "hex");
  assert.equal(defaultMode("text", '{"a":1}'), "json");
  assert.equal(defaultMode("text", "hello"), "text");
});

test("json: numbers survive, errors have positions", () => {
  const p = parseJson('{"id": 12345678901234567890, "f": 1.50, "s": "a\\"b", "n": null, "t": [true, {}]}');
  assert.ok(p.ok);
  assert.equal(compactJson(p.node), '{"id":12345678901234567890,"f":1.50,"s":"a\\"b","n":null,"t":[true,{}]}');
  const bad = parseJson('{\n  "a": 1,\n  "b": }');
  assert.equal(bad.ok, false);
  assert.equal(bad.line, 3);
  assert.equal(bad.col, 8);
  assert.equal(parseJson("[1,]").ok, false);
  assert.equal(parseJson("1 2").ok, false);
  assert.equal(prettyJson(parseJson('{"a":[1,2],"b":{}}').node), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}');
});

test("json: lines and folding", () => {
  const p = parseJson('{"a":1,"m":{"x":1,"y":2},"l":[1,2]}');
  const all = jsonLines(p.node, new Set());
  assert.equal(all.lines.length, 11);
  assert.equal(all.lines[0].path, "$");
  const paths = topLevelPaths(p.node);
  assert.deepEqual(paths, ["$.m", "$.l"]);
  const f = jsonLines(p.node, new Set(paths));
  assert.equal(f.lines.length, 5);
  assert.ok(f.lines[2].folded);
  assert.ok(f.lines[2].segs.some((s) => s.t.includes("2 keys")));
  const capped = jsonLines(p.node, new Set(), 3);
  assert.ok(capped.truncated);
  assert.equal(jsonToStore('{\n "a": 10000000000000000001\n}', '{"a":1}'), '{"a":10000000000000000001}');
  assert.equal(jsonToStore('{\n "a": 1\n}', '{\n"a":0\n}'), '{\n "a": 1\n}');
});

test("hex", () => {
  const b = hexToBytes("0x48656c6c6f…");
  assert.deepEqual([...b], [72, 101, 108, 108, 111]);
  const rows = hexRows(b);
  assert.equal(rows[0].off, "00000000");
  assert.equal(rows[0].ascii, "Hello");
  assert.equal(hexToBytes("nope"), null);
  assert.equal(sizeLabel(2470), "2.41 KB");
});

// ------------------------------------------------------------------ designer

const col = (k, name, type, o = {}) => ({ k, name, type, nn: false, def: "", pk: false, cmt: "", ...o });
const ORIG = {
  schema: "public",
  name: "customers",
  cols: [col("c1", "id", "bigint", { nn: true, pk: true }), col("c2", "email", "text", { nn: true }), col("c3", "name", "text"), col("c4", "score", "integer", { def: "0" })],
  idx: [
    { k: "i1", name: "customers_pkey", cols: "id", uniq: true, prim: true },
    { k: "i2", name: "customers_email_key", cols: "email", uniq: true },
  ],
  fks: [],
  pkName: "customers_pkey",
};
const clone = (x) => JSON.parse(JSON.stringify(x));

test("designer: identifiers and types", () => {
  assert.equal(ident("postgres", "orders"), "orders");
  assert.equal(ident("postgres", "Orders"), '"Orders"');
  assert.equal(ident("postgres", "user"), '"user"');
  assert.equal(ident("mysql", "order"), "`order`");
  assert.equal(ident("mssql", "My Col"), "[My Col]");
  assert.equal(colList("postgres", "a, B, lower(c)"), 'a, "B", lower(c)');
  assert.ok(sameType("postgres", "character varying(255)", "varchar(255)"));
  assert.ok(sameType("postgres", "timestamp with time zone", "timestamptz"));
  assert.ok(sameType("mysql", "int(11)", "INT"));
  assert.ok(!sameType("mysql", "tinyint(1)", "tinyint"));
  assert.equal(normType("postgres", "Numeric( 12 , 2 )"), "numeric(12,2)");
});

test("designer: create table", () => {
  const st = { schema: "public", name: "countries", cols: [col("n1", "id", "bigint", { nn: true, pk: true }), col("n2", "code", "char(2)", { nn: true, cmt: "ISO code" }), col("n3", "created_at", "timestamptz", { def: "now()" })], idx: [{ k: "x", name: "countries_code_key", cols: "code", uniq: true }], fks: [] };
  const pg = runnable(designSql("postgres", st, null).stmts);
  assert.equal(pg[0], "CREATE TABLE public.countries (\n    id bigint NOT NULL,\n    code char(2) NOT NULL,\n    created_at timestamptz DEFAULT now(),\n    PRIMARY KEY (id)\n);");
  assert.equal(pg[1], "CREATE UNIQUE INDEX countries_code_key ON public.countries (code);");
  assert.equal(pg[2], "COMMENT ON COLUMN public.countries.code IS 'ISO code';");
  const my = runnable(designSql("mysql", { ...st, schema: "shop", cols: st.cols.map((c) => ({ ...c, type: c.type === "timestamptz" ? "DATETIME(6)" : c.type })) }, null).stmts);
  assert.ok(my[0].includes("code char(2) NOT NULL COMMENT 'ISO code'"));
  assert.ok(my[0].includes("created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP"));
  const ms = runnable(designSql("mssql", { ...st, schema: "dbo" }, null).stmts);
  assert.ok(ms[0].includes("CONSTRAINT PK_countries PRIMARY KEY (id)"));
  assert.ok(ms[0].includes("created_at timestamptz NULL DEFAULT SYSUTCDATETIME()"));
  assert.ok(ms.some((s) => s.startsWith("EXEC sp_addextendedproperty")));
});

test("designer: alter postgres", () => {
  const cur = clone(ORIG);
  cur.cols[2].name = "full_name";
  cur.cols[3].type = "bigint";
  cur.cols[3].nn = true;
  cur.cols[3].def = "";
  cur.cols[1].cmt = "Login";
  cur.cols.push(col("n1", "opt_in", "boolean", { nn: true, def: "false" }));
  cur.idx.push({ k: "n2", name: "customers_name_idx", cols: "full_name", uniq: false });
  cur.idx[1].deleted = true;
  cur.fks.push({ k: "f1", name: "customers_country_fk", cols: "id", ref: "public.countries", refCols: "id", onDelete: "CASCADE" });
  const s = runnable(designSql("postgres", cur, ORIG).stmts);
  assert.deepEqual(s, [
    "DROP INDEX public.customers_email_key;",
    "COMMENT ON COLUMN public.customers.email IS 'Login';",
    "ALTER TABLE public.customers RENAME COLUMN name TO full_name;",
    "ALTER TABLE public.customers ALTER COLUMN score TYPE bigint USING score::bigint;",
    "ALTER TABLE public.customers ALTER COLUMN score SET NOT NULL;",
    "ALTER TABLE public.customers ALTER COLUMN score DROP DEFAULT;",
    "ALTER TABLE public.customers ADD COLUMN opt_in boolean NOT NULL DEFAULT false;",
    "CREATE INDEX customers_name_idx ON public.customers (full_name);",
    "ALTER TABLE public.customers ADD CONSTRAINT customers_country_fk FOREIGN KEY (id) REFERENCES public.countries (id) ON DELETE CASCADE;",
  ]);
  assert.deepEqual(designSql("postgres", clone(ORIG), ORIG).stmts, []);
});

test("designer: alter mysql, mssql, pk and drops", () => {
  const o = clone(ORIG);
  o.schema = "shop";
  o.cols[1].type = "VARCHAR(255)";
  const cur = clone(o);
  cur.cols[1].nn = false;
  cur.cols[2].name = "full_name";
  cur.cols[3].deleted = true;
  cur.cols.push(col("n1", "note", "TEXT"));
  const my = runnable(designSql("mysql", cur, o).stmts);
  assert.deepEqual(my, [
    "ALTER TABLE shop.customers MODIFY COLUMN email VARCHAR(255);",
    "ALTER TABLE shop.customers RENAME COLUMN name TO full_name;",
    "ALTER TABLE shop.customers DROP COLUMN score;",
    "ALTER TABLE shop.customers ADD COLUMN note TEXT AFTER full_name;",
  ]);
  const om = clone(ORIG);
  om.schema = "dbo";
  om.pkName = "PK__cust__1";
  om.defaultConstraints = { score: "DF__customers__score__12" };
  const cm = clone(om);
  cm.cols[3].def = "1";
  cm.cols[2].pk = true;
  cm.cols[2].name = "label";
  const ms = runnable(designSql("mssql", cm, om).stmts);
  assert.deepEqual(ms, [
    "EXEC sp_rename N'dbo.customers.name', N'label', N'COLUMN';",
    "ALTER TABLE dbo.customers DROP CONSTRAINT DF__customers__score__12;",
    "ALTER TABLE dbo.customers ADD CONSTRAINT DF_customers_score DEFAULT 1 FOR score;",
    "ALTER TABLE dbo.customers DROP CONSTRAINT PK__cust__1;",
    "ALTER TABLE dbo.customers ADD CONSTRAINT PK_customers PRIMARY KEY (id, label);",
  ]);
});

test("designer: sqlite rebuild", () => {
  const o = clone(ORIG);
  o.schema = "main";
  o.cols[0].type = "INTEGER";
  o.autoIncrement = true;
  const cur = clone(o);
  cur.cols[3].type = "REAL";
  cur.cols[2].name = "full_name";
  const r = designSql("sqlite", cur, o);
  assert.ok(r.rebuild);
  const s = runnable(r.stmts);
  assert.equal(s[0], "PRAGMA foreign_keys = OFF;");
  assert.ok(s[1].startsWith("CREATE TABLE customers_new (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,"));
  assert.equal(s[2], "INSERT INTO customers_new (id, email, full_name, score)\nSELECT id, email, name, score FROM customers;");
  assert.equal(s[3], "DROP TABLE customers;");
  assert.equal(s[4], "ALTER TABLE customers_new RENAME TO customers;");
  assert.equal(s[5], "CREATE UNIQUE INDEX customers_email_key ON customers (email);");
  // A rename alone needs no rebuild.
  const c2 = clone(o);
  c2.cols[2].name = "label";
  assert.deepEqual(runnable(designSql("sqlite", c2, o).stmts), ["ALTER TABLE customers RENAME COLUMN name TO label;"]);
});

test("import: new table types", () => {
  assert.equal(typeForKind("postgres", "decimal", 7, 6, 2), "numeric(10,2)");
  assert.equal(typeForKind("mysql", "text", 30, 0, 0), "VARCHAR(100)");
  assert.equal(typeForKind("mssql", "text", 5000, 0, 0), "nvarchar(max)");
  assert.equal(createTableForImport("postgres", "public", "t_import", [{ name: "customer_id", type: "bigint" }]), "CREATE TABLE public.t_import (\n    customer_id bigint\n);");
});

// ------------------------------------------------------------------ highlighter

test("highlight", () => {
  const lines = highlightSql("CREATE TABLE t (\n  id bigint DEFAULT 'a''b', -- note\n  \"Name\" text\n);");
  assert.equal(lines.length, 4);
  const kinds = (l) => l.filter((s) => s.c !== "ws").map((s) => s.c);
  assert.deepEqual(kinds(lines[0]), ["kw", "kw", "id", "punct"]);
  assert.deepEqual(kinds(lines[1]), ["id", "type", "kw", "str", "punct", "cmt"]);
  assert.deepEqual(kinds(lines[2]), ["id", "type"]);
  assert.equal(highlightSql("a\n/* x\ny */b").length, 3);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

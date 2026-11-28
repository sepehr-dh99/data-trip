import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withIpc } from "./test-web-postgres.mjs";

const origin = process.env.DATATRIP_TEST_ORIGIN ?? "http://127.0.0.1:1421";
const base = `${origin}/api/v1`;
async function guest() {
  const response = await fetch(`${base}/login/guest`, { method: "POST", headers: { Origin: origin } });
  assert.equal(response.status, 200);
  const session = await response.json();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie, Origin: origin, "X-DataTrip-Session": session.binding };
  const get = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const post = (path, value = {}) => get(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const op = async (name, args, expected = 200) => {
    const response = await post(`/operations/${name}`, args);
    const value = await response.json();
    assert.equal(response.status, expected, `${name}: ${JSON.stringify(value)}`);
    return value;
  };
  return { ...session, get, post, op };
}
const a = await guest();
const b = await guest();
const desktopExports = new Map();
const formats = ["csv", "tsv", "json", "sql", "markdown"];
try {
  const source = "id,name\n1,one\n2,two\n";
  const uploaded = await a.get("/files/upload?name=sample.csv&purpose=import", { method: "POST", body: source });
  assert.equal(uploaded.status, 200);
  const path = (await uploaded.json()).file;
  const preview = await a.op("import_preview", { path });
  assert.deepEqual(preview.rows, [["1", "one"], ["2", "two"]]);
  if (process.env.DATATRIP_TEST_IPC) {
    const directory = await mkdtemp(join(tmpdir(), "datatrip-ipc-files-"));
    try {
      await withIpc(process.env.DATATRIP_TEST_IPC, async (invoke) => {
        const input = join(directory, "sample.csv");
        const sqlite = join(directory, "fixture.sqlite");
        await writeFile(input, source);
        await writeFile(sqlite, "");
        assert.deepEqual(await invoke("import_preview", { path: input }), preview);
        const saved = await invoke("save_connection", { config: { driver: "sqlite", name: "File fixture", filePath: sqlite } });
        const { sessionId } = await invoke("open_session", { connectionId: saved.id });
        try {
          const query = (sql) => invoke("execute", { sessionId, sql, maxRows: 10 });
          await query("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT)");
          await query("INSERT INTO sample VALUES (1, 'one'), (2, 'two')");
          assert.deepEqual((await query("SELECT id, name FROM sample ORDER BY id")).rows, [[1, "one"], [2, "two"]]);
          for (const format of formats) {
            const output = join(directory, `results.${format}`);
            assert.equal(await invoke("export_query_with", { sessionId, path: output,
              sql: "SELECT * FROM sample ORDER BY id", options: { format } }), 2);
            const bytes = await readFile(output, "utf8");
            if (format === "csv") assert.equal(bytes, source);
            desktopExports.set(format, bytes);
          }
        } finally {
          await invoke("close_session", { sessionId });
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    console.log("SQLite query and export plus the identical import preview passed through desktop IPC");
  }
  await b.op("import_preview", { path }, 404);
  assert.equal((await b.get("/events", { headers: { "X-DataTrip-Session": a.binding } })).status, 401);
  const output = async (name, purpose) => {
    const response = await a.post("/files/output", { name, purpose });
    assert.equal(response.status, 200);
    return (await response.json()).file;
  };
  const filePath = await output("workspace.sqlite", "sqlite");
  const config = await a.op("save_connection", { config: { name: "SQLite", driver: "sqlite", filePath } });
  const { sessionId } = await a.op("open_session", { connectionId: config.id });
  const query = (sql) => a.op("execute", { sessionId, sql, maxRows: 25 });
  await query("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT)");
  const ddl = await a.op("get_ddl", { sessionId, request: { schema: "main", name: "sample", kind: "table" } });
  assert.match(ddl, /CREATE TABLE sample/);
  assert.match((await a.op("execute", { sessionId, sql: "ATTACH DATABASE ':memory:' AS extra", maxRows: 1 }, 400)).message, /authorized/i);
  const runId = randomUUID();
  const events = await a.get("/events");
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  try {
    const request = {
      format: preview.format, sourceColumns: preview.columns, target: { table: "sample" },
      mapping: [{ source: 0, column: "id", typeName: "integer" }, { source: 1, column: "name", typeName: "text" }],
      options: { transaction: "single" },
    };
    const run = { sessionId, path, runId, request };
    assert.equal((await a.op("import_run", run)).inserted, 2);
    assert.match(Buffer.from((await reader.read()).value).toString(), /import-progress/);
    assert.equal((await a.get(`/jobs/${runId}`)).status, 200);
    assert.equal((await b.get(`/jobs/${runId}`)).status, 404);
    await a.op("import_run", run, 409);
    await b.op("import_cancel", { runId });
    assert.deepEqual((await query("SELECT * FROM sample ORDER BY id")).rows, [[1, "one"], [2, "two"]]);
  } finally {
    await reader.cancel();
  }
  const file = await output("results.csv", "output");
  assert.equal(await a.op("export_query_with", { sessionId, sql: "SELECT * FROM sample ORDER BY id", path: file, options: { format: "csv" } }), 2);
  const result = await a.get(`/files/${file}?binding=${a.binding}`);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), source);
  assert.equal((await b.get(`/files/${file}?binding=${b.binding}`)).status, 404);
  for (const format of formats.slice(1)) {
    if (!desktopExports.has(format)) continue;
    const path = await output(`results.${format}`, "output");
    assert.equal(await a.op("export_query_with", { sessionId, sql: "SELECT * FROM sample ORDER BY id", path, options: { format } }), 2);
    assert.equal(await (await a.get(`/files/${path}?binding=${a.binding}`)).text(), desktopExports.get(format));
  }
  const sqlPath = await output("update.sql", "sql");
  const options = { stopOnError: true, singleTx: true };
  const saved = await a.op("sql_file_write", { path: sqlPath, text: "UPDATE sample SET name = 'updated' WHERE id = 2;\n" });
  assert.equal((await a.op("sql_file_read", { path: sqlPath })).mtimeMs, saved.mtimeMs);
  await a.op("run_sql_file", { sessionId, path: sqlPath, options, runId: randomUUID() });
  assert.deepEqual((await query("SELECT name FROM sample WHERE id = 2")).rows, [["updated"]]);
  assert.equal(await a.op("apply_edits", { sessionId, edits: [{
    kind: "update", schema: "main", table: "sample", key: { id: 2 }, changes: { name: "edited" },
  }] }), 1);
  assert.deepEqual((await query("SELECT name FROM sample WHERE id = 2")).rows, [["edited"]]);
  if (process.env.DATATRIP_TEST_SQLITE_SNAPSHOT === "1") {
    await query("BEGIN");
    await query("INSERT INTO sample VALUES (3, 'uncommitted')");
    const downloaded = await a.get(`/files/${filePath}?binding=${a.binding}`);
    assert.equal(downloaded.status, 200);
    const snapshot = Buffer.from(await downloaded.arrayBuffer());
    assert.ok(snapshot.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")));
    const upload = await a.get("/files/upload?name=snapshot.sqlite&purpose=sqlite", { method: "POST", body: snapshot });
    assert.equal(upload.status, 200);
    const copy = await a.op("save_connection", { config: { name: "Snapshot", driver: "sqlite", filePath: (await upload.json()).file } });
    const destination = await a.op("open_session", { connectionId: copy.id });
    assert.deepEqual((await a.op("execute", { sessionId: destination.sessionId, sql: "SELECT id FROM sample ORDER BY id", maxRows: 10 })).rows, [[1], [2]]);
    await a.op("close_session", { sessionId: destination.sessionId });
    await query("ROLLBACK");
    console.log("SQLite download contains the committed state while the original has a pending write");
  }
  if (process.env.DATATRIP_TEST_FED === "1") {
    const pg = await a.op("save_connection", { config: {
      name: "Fixture PostgreSQL", driver: "postgres", host: "127.0.0.1", port: 55432, username: "datatrip", database: "postgres",
    } });
    const remote = await a.op("open_session", { connectionId: pg.id });
    const table = `dt_fixture_${randomUUID().replaceAll("-", "")}`;
    const remoteQuery = (sql) => a.op("execute", { sessionId: remote.sessionId, sql, maxRows: 10 });
    try {
      await remoteQuery(`CREATE TABLE public.${table} AS SELECT 2 AS id, 'postgres'::text AS source`);
      const { result, plan } = await a.op("federated_execute", {
        sources: [{ alias: "local", connectionId: config.id }, { alias: "remote", connectionId: pg.id }],
        sql: `SELECT l.name, r.source FROM local.main.sample AS l JOIN remote.postgres.public.${table} AS r ON l.id = r.id`,
        maxRows: 10,
      });
      assert.deepEqual(result.rows, [["edited", "postgres"]]);
      assert.equal(plan.length, 3);
      if (process.env.DATATRIP_TEST_LARGE_FILES === "1") {
        const chunk = new TextEncoder().encode("id,name\n1,bulk\n".padEnd(64 * 1024, "\n"));
        let chunks = 320;
        const body = new ReadableStream({
          async pull(controller) {
            if (chunks === 0) { controller.close(); return; }
            if (chunks % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
            chunks -= 1;
            controller.enqueue(chunk);
          },
        });
        const large = await a.get("/files/upload?name=large.csv&purpose=import", { method: "POST", body, duplex: "half" });
        assert.equal(large.status, 200);
        const preview = await a.op("import_preview", { path: (await large.json()).file });
        assert.equal(preview.fileSize, 320 * chunk.byteLength);
        const target = await output("large.tsv", "output");
        const row = "x".repeat(1024) + "\n";
        assert.equal(await a.op("export_query_with", {
          sessionId: remote.sessionId, sql: "SELECT repeat('x', 1024) AS value FROM generate_series(1, 20000)",
          path: target, options: { format: "tsv", includeHeader: false },
        }), 20_000);
        const download = await a.get(`/files/${target}?binding=${a.binding}`, { headers: { "Accept-Encoding": "identity" } });
        assert.equal(download.status, 200);
        assert.equal(Number(download.headers.get("content-length")), 20_000 * row.length);
        let bytes = 0;
        for await (const block of download.body) {
          bytes += block.byteLength;
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assert.equal(bytes, 20_000 * row.length);
        console.log("20 MiB streamed upload and paced download passed");
      }
    } finally {
      await remoteQuery(`DROP TABLE IF EXISTS public.${table}`);
      await a.op("close_session", { sessionId: remote.sessionId });
      await a.op("delete_connection", { id: pg.id });
    }
  }
  await a.op("close_session", { sessionId });
} finally {
  await a.post("/logout");
  await b.post("/logout");
}
console.log("SQLite, native preview, import progress, idempotent job IDs, SQL script, streaming export and workspace file isolation passed");

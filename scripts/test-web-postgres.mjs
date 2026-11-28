// Run against the guest-enabled dev instance and a disposable PostgreSQL server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const postgres = {
  host: process.env.DATATRIP_TEST_PG_HOST ?? "127.0.0.1",
  port: Number(process.env.DATATRIP_TEST_PG_PORT ?? 55432),
  username: process.env.DATATRIP_TEST_PG_USER ?? "datatrip",
};
const mysql = process.env.DATATRIP_TEST_MYSQL ? {
  host: process.env.DATATRIP_TEST_MYSQL,
  port: Number(process.env.DATATRIP_TEST_MYSQL_PORT ?? 53306),
  username: "datatrip", database: "datatrip",
  password: process.env.DATATRIP_TEST_MYSQL_PASSWORD ?? "datatrip-fixture",
} : null;
const sqlServer = process.env.DATATRIP_TEST_MSSQL_PASSWORD ? {
  host: process.env.DATATRIP_TEST_MSSQL ?? "127.0.0.1",
  port: Number(process.env.DATATRIP_TEST_MSSQL_PORT ?? 51433),
  password: process.env.DATATRIP_TEST_MSSQL_PASSWORD,
} : null;

async function mysqlScenario(invoke, { password, ...endpoint }) {
  const config = { driver: "mysql", name: "MariaDB fixture", ...endpoint };
  assert.match((await invoke("test_connection", { config, password })).version, /MariaDB/);
  const saved = await invoke("save_connection", { config, password });
  try {
    const { sessionId } = await invoke("open_session", { connectionId: saved.id });
    try {
      const query = (sql) => invoke("execute", { sessionId, sql, maxRows: 10 });
      assert.deepEqual((await query("SELECT 42")).rows, [[42]]);
      await query("CREATE TEMPORARY TABLE tmp_port (id INT PRIMARY KEY, message VARCHAR(30))");
      await invoke("set_auto_commit", { sessionId, autoCommit: false });
      await query("INSERT INTO tmp_port VALUES (1, 'hello')");
      await invoke("rollback", { sessionId });
      assert.deepEqual((await query("SELECT id FROM tmp_port")).rows, []);
      await query("INSERT INTO tmp_port VALUES (2, 'world')");
      await invoke("commit", { sessionId });
      await invoke("rollback", { sessionId });
      await invoke("set_auto_commit", { sessionId, autoCommit: true });
      assert.deepEqual((await query("SELECT id, message FROM tmp_port")).rows, [[2, "world"]]);
    } finally {
      await invoke("close_session", { sessionId });
    }
  } finally {
    await invoke("delete_connection", { id: saved.id });
  }
}

async function sqlServerScenario(invoke, { password, ...endpoint }) {
  const config = { name: "SQL Server fixture", driver: "mssql", database: "master", username: "sa",
    trustServerCertificate: true, ...endpoint };
  assert.match((await invoke("test_connection", { config, password })).version, /SQL Server/);
  const saved = await invoke("save_connection", { config, password });
  try {
    const { sessionId } = await invoke("open_session", { connectionId: saved.id });
    try {
      const query = (sql) => invoke("execute", { sessionId, sql, maxRows: 10 });
      assert.deepEqual((await query("SELECT 42 AS answer")).rows, [[42]]);
      await query("CREATE TABLE #port_fixture (id INT PRIMARY KEY)");
      await invoke("set_auto_commit", { sessionId, autoCommit: false });
      await query("INSERT INTO #port_fixture VALUES (1)");
      await invoke("rollback", { sessionId });
      assert.deepEqual((await query("SELECT id FROM #port_fixture")).rows, []);
      await query("INSERT INTO #port_fixture VALUES (2)");
      await invoke("commit", { sessionId });
      assert.deepEqual((await query("SELECT id FROM #port_fixture")).rows, [[2]]);
      await invoke("rollback", { sessionId });
      await invoke("set_auto_commit", { sessionId, autoCommit: true });
      await assert.rejects(() => query("SELECT missing_column\nFROM #port_fixture"), (error) =>
        Number.isInteger(error.line) && /missing_column/.test(error.message));
    } finally {
      await invoke("close_session", { sessionId });
    }
  } finally {
    await invoke("delete_connection", { id: saved.id });
  }
}

export async function postgresScenario(invoke, { host, port, username }) {
  const original = await invoke("get_settings");
  await invoke("save_settings", { settings: { ...original, contractFixture: true } });
  try {
    assert.equal((await invoke("get_settings")).contractFixture, true);
    const config = { driver: "postgres", name: "Contract fixture", host, port, username, database: "postgres" };
    assert.ok((await invoke("test_connection", { config })).version);
    const saved = await invoke("save_connection", { config, password: null, sentinelPassword: null });
    try {
      assert.deepEqual((await invoke("list_connections")).find((c) => c.id === saved.id), saved);
      const { sessionId } = await invoke("open_session", { connectionId: saved.id, database: null });
      try {
        const execute = (sql, maxRows = 5) => invoke("execute", { sessionId, sql, maxRows });
        assert.deepEqual((await execute("SELECT 42 AS answer")).rows, [[42]]);
        await assert.rejects(() => execute("SELECT FROM WHERE"), (err) => err.position === 13 && err.message.includes("WHERE"));
        const page = await execute("SELECT generate_series(1, 9)", 3);
        assert.equal(page.truncated, true);
        assert.deepEqual(page.rows, [[1], [2], [3]]);
        await execute("CREATE TEMP TABLE port_fixture (n integer PRIMARY KEY)");
        await invoke("set_auto_commit", { sessionId, autoCommit: false });
        await execute("INSERT INTO port_fixture VALUES (1)");
        await invoke("rollback", { sessionId });
        assert.deepEqual((await execute("SELECT * FROM port_fixture")).rows, []);
        await execute("INSERT INTO port_fixture VALUES (2)");
        await invoke("commit", { sessionId });
        assert.deepEqual((await execute("SELECT * FROM port_fixture")).rows, [[2]]);
        await invoke("rollback", { sessionId });
        await invoke("set_auto_commit", { sessionId, autoCommit: true });
        const cancelled = assert.rejects(() => execute("SELECT pg_sleep(10)"), /cancel/i);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await invoke("cancel", { sessionId });
        await cancelled;
        assert.deepEqual((await execute("SELECT 123")).rows, [[123]]);
        assert.equal((await invoke("reconnect_connection", { connectionId: saved.id })).sessions, 1);
        assert.deepEqual((await execute("SELECT 456")).rows, [[456]]);
        return sessionId;
      } finally {
        assert.equal(await invoke("close_session", { sessionId }), null);
      }
    } finally {
      await invoke("delete_connection", { id: saved.id });
    }
  } finally {
    await invoke("save_settings", { settings: original });
  }
}

async function webScenario() {
  const origin = process.env.DATATRIP_TEST_ORIGIN ?? "http://127.0.0.1:1421";
  async function post(path, args, session) {
    const response = await fetch(`${origin}/api/v1/${path}`, {
      method: "POST",
      headers: {
        Origin: origin, "Content-Type": "application/json",
        ...(session && { Cookie: session.cookie, "X-DataTrip-Session": session.binding }),
      },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      const error = await response.json();
      throw Object.assign(new Error(error.message), error, { status: response.status });
    }
    if (response.status === 204) return null;
    const value = await response.json();
    if (path === "login/guest") value.cookie = response.headers.get("set-cookie").split(";")[0];
    return value;
  }
  const first = await post("login/guest", {});
  const second = await post("login/guest", {});
  assert.notEqual(first.workspaceId, second.workspaceId);
  try {
    const run = (who, name, args = {}) => post(`operations/${name}`, args, who);
    await postgresScenario(async (name, args) => {
      const result = await run(first, name, args);
      if (name === "open_session") {
        await assert.rejects(() => run(second, "cancel", { sessionId: result.sessionId }), /Session not found/);
        await assert.rejects(() => run(second, "execute", { sessionId: result.sessionId, sql: "SELECT 1", maxRows: 5 }), /Session not found/);
      }
      return result;
    }, postgres);
    if (mysql) await mysqlScenario((name, args) => run(first, name, args), mysql);
    if (sqlServer) await sqlServerScenario((name, args) => run(first, name, args), sqlServer);
    const readOnly = await run(first, "save_connection", { config: {
      ...postgres, driver: "postgres", name: "Read-only fixture", database: "postgres", readOnly: true,
    } });
    const { sessionId } = await run(first, "open_session", { connectionId: readOnly.id });
    try {
      const query = (sql) => run(first, "execute", { sessionId, sql, maxRows: 5 });
      assert.deepEqual((await query("SELECT 99")).rows, [[99]]);
      await assert.rejects(() => query("SET TRANSACTION READ WRITE"), /read-only/);
    } finally {
      await run(first, "close_session", { sessionId });
      await run(first, "delete_connection", { id: readOnly.id });
    }
    assert.deepEqual(await run(second, "list_connections"), []);
    assert.deepEqual(await run(second, "get_settings"), {});
    assert.deepEqual(await run(second, "list_history", { limit: 5 }), []);
  } finally {
    await post("logout", {}, first);
    await post("logout", {}, second);
  }
  console.log("PostgreSQL wire, transaction, cancel, reconnect and two-guest isolation fixture passed");
  if (mysql) console.log("MariaDB authentication and transaction fixture passed over HTTP");
  if (sqlServer) console.log("SQL Server authentication, transactions and error line passed over HTTP");
}

export async function withIpc(binary, scenario) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = once(child, "exit");
  const pending = new Map();
  let nextId = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if ("error" in reply) waiter.reject(Object.assign(new Error(reply.error.message), reply.error));
    else waiter.resolve(reply.result);
  });
  const invoke = (name, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, name, args }) + "\n");
  });
  child.on("exit", () => { for (const { reject } of pending.values()) reject(new Error("Tauri fixture exited")); });
  try {
    await scenario(invoke);
  } finally {
    child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
  }
}

async function ipcScenario(binary) {
  await withIpc(binary, async (invoke) => {
    assert.deepEqual(await invoke("get_settings"), { data: { restoreConsoles: true } });
    assert.deepEqual(await invoke("get_workspace"), { version: 1, tabs: [], active: -1 });
    assert.equal((await invoke("list_connections"))[0].name, "Pre-port bookmark");
    assert.equal((await invoke("list_vault_profiles"))[0].name, "Pre-port Vault");
    assert.equal((await invoke("list_ssh_profiles"))[0].name, "Pre-port SSH");
    const history = (await invoke("list_history", { connectionId: "legacy", limit: 1 }))[0];
    assert.deepEqual([history.sql, history.elapsedMs, history.rows, history.ok], ["SELECT 1", 7, 1, true]);
    await postgresScenario(invoke, postgres);
    if (mysql) await mysqlScenario(invoke, mysql);
    if (sqlServer) await sqlServerScenario(invoke, sqlServer);
  });
  console.log("The same PostgreSQL fixture and pre-port JSON state passed through Tauri IPC dispatch");
  if (mysql) console.log("The same MariaDB authentication and transaction fixture passed through Tauri IPC dispatch");
  if (sqlServer) console.log("The same SQL Server fixture passed through Tauri IPC dispatch");
}

if (process.argv[1]?.endsWith("test-web-postgres.mjs")) {
  if (process.env.DATATRIP_TEST_IPC) await ipcScenario(process.env.DATATRIP_TEST_IPC);
  if (process.env.DATATRIP_SKIP_HTTP !== "1") await webScenario();
}

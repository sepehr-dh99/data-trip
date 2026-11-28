// Optional integration smoke for disposable Redis/Redis Sentinel and Kafka instances.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { withIpc } from "./test-web-postgres.mjs";

const origin = process.env.DATATRIP_TEST_ORIGIN ?? "http://127.0.0.1:8082";
const guest = await fetch(`${origin}/api/v1/login/guest`, { method: "POST", headers: { Origin: origin } });
assert.equal(guest.status, 200);
const { binding } = await guest.json();
const headers = { Origin: origin, Cookie: guest.headers.get("set-cookie").split(";")[0],
  "X-DataTrip-Session": binding, "Content-Type": "application/json" };
const post = (path, args) => fetch(`${origin}/api/v1/${path}`, { method: "POST", headers, body: JSON.stringify(args) });
async function webOperation(name, args, status = 200) {
  const response = await post(`operations/${name}`, args);
  const result = await response.json();
  assert.equal(response.status, status, `${name}: ${JSON.stringify(result)}`);
  return result;
}
async function withConnection(op, config, action) {
  const test = await op("test_connection", { config });
  assert.ok(test.version);
  if (config.redis?.mode === "sentinel") assert.ok(test.details.some((line) => line.includes("Connected to master")));
  const { id } = await op("save_connection", { config });
  const { sessionId } = await op("open_session", { connectionId: id });
  const run = (name, args, status) => op(name, { sessionId, ...args }, status);
  try {
    await action(run, id);
  } finally {
    await run("close_session");
    await op("delete_connection", { id });
  }
}

async function exerciseBrokers(op, transport, failover) {
  if (process.env.DATATRIP_TEST_REDIS) {
    const [host, port] = process.env.DATATRIP_TEST_REDIS.split(":");
    const config = { name: "Fixture Redis", driver: "redis", host, port: Number(port), database: "0" };
    const key = `port-fixture-${randomUUID()}`;
    const exercise = async (run) => {
      await run("execute", { sql: `SET ${key} value`, maxRows: 10 });
      try {
        const scan = await run("redis_scan", { pattern: key, cursor: "0", count: 100 });
        assert.ok(JSON.stringify(scan).includes(key));
        assert.ok(JSON.stringify(await run("redis_get", { key, limit: 10 })).includes("value"));
        await run("redis_set_ttl", { key, ttl: 100 });
      } finally {
        assert.equal(await run("redis_delete", { keys: [key] }), 1);
      }
    };
    await withConnection(op, config, exercise);
    await withConnection(op, { ...config, readOnly: true }, async (run) => {
      const error = await run("execute", { sql: `SET ${key} nope`, maxRows: 10 }, 400);
      assert.match(error.message, /read.only/i);
    });
    if (process.env.DATATRIP_TEST_SENTINEL) {
      const sentinel = process.env.DATATRIP_TEST_SENTINEL;
      await withConnection(op, { ...config, redis: { mode: "sentinel", sentinels: [sentinel], masterName: "datatrip-test" } },
        async (run, connectionId) => {
          await exercise(run);
          if (failover) {
            const [sentinelHost, sentinelPort] = sentinel.split(":");
            const sentinelCommand = (...args) => execFileSync(process.env.DATATRIP_TEST_REDIS_FAILOVER,
              ["-h", sentinelHost, "-p", sentinelPort, "--raw", "SENTINEL", ...args], { encoding: "utf8" }).trim();
            assert.equal(sentinelCommand("FAILOVER", "datatrip-test"), "OK");
            let master = port;
            for (let attempt = 0; attempt < 80 && master === port; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 250));
              master = sentinelCommand("get-master-addr-by-name", "datatrip-test").split("\n")[1];
            }
            assert.ok(master && master !== port, "Redis Sentinel did not promote the replica");
            assert.equal((await op("reconnect_connection", { connectionId })).sessions, 1);
            await exercise(run);
            console.log("Redis Sentinel promoted its replica and the same console session reconnected");
          }
        });
    }
    console.log(`${transport}: Redis browsing, TTL, writes, read-only and configured Sentinel discovery passed`);
  }
  if (process.env.DATATRIP_TEST_KAFKA) {
    const config = { name: "Fixture Kafka", driver: "kafka", host: process.env.DATATRIP_TEST_KAFKA };
    await withConnection(op, config, async (run) => {
      assert.ok((await run("kafka_overview")).brokers.length);
      const topic = `datatrip-${randomUUID()}`;
      await run("kafka_create_topic", { topic, partitions: 1, replicationFactor: 1 });
      try {
        await run("kafka_produce", { request: { topic, key: "fixture", value: "port", partition: 0 } });
        assert.equal((await run("kafka_topic", { topic })).name, topic);
        const consumed = await run("kafka_consume", { request: { topic, from: "latest", limit: 10 } });
        assert.ok(JSON.stringify(consumed).includes("port"));
      } finally {
        await run("kafka_delete_topic", { topic });
      }
    });
    console.log(`${transport}: Kafka broker discovery, topic admin, produce and consume passed`);
  }
}

try {
  if (process.env.DATATRIP_TEST_IPC) {
    await withIpc(process.env.DATATRIP_TEST_IPC, (invoke) => exerciseBrokers(async (name, args, status = 200) => {
      if (status === 200) return invoke(name, args);
      try {
        await invoke(name, args);
      } catch (error) {
        return error;
      }
      assert.fail(`${name} should fail`);
    }, "Tauri IPC", false));
  }
  await exerciseBrokers(webOperation, "HTTP", Boolean(process.env.DATATRIP_TEST_REDIS_FAILOVER));
} finally {
  assert.equal((await post("logout", {})).status, 204);
}

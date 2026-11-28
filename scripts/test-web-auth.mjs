import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

const bin = resolve(process.env.DATATRIP_WEB_BIN ?? "src-web/target/debug/datatrip-web");
const temp = await mkdtemp(`${tmpdir()}/datatrip-auth-`);
const hash = (password) => execFileSync(bin, ["hash-password", "--stdin"], { input: `${password}\n`, encoding: "utf8" }).trim();
const users = ["alpha", "beta"].map((username) => ({ id: `${username}-id`, username, passwordHash: hash(`${username}-test`) }));
const key = randomBytes(32).toString("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "fixture" }];
const claims = new Map();
const json = (res, value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
const provider = createServer(async (req, res) => {
  if (req.url === "/.well-known/openid-configuration") {
    return json(res, {
      issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`, jwks_uri: `${issuer}jwks`,
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (req.url === "/jwks") return json(res, { keys });
  if (req.url === "/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = new URLSearchParams(body);
    const grant = claims.get(data.get("code"));
    claims.delete(data.get("code"));
    if (!grant || createHash("sha256").update(data.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) {
      res.statusCode = 400;
      return json(res, { error: "invalid_grant" });
    }
    const base = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base({ alg: "RS256", kid: "fixture" })}.${base({
      iss: issuer, sub: "oidc-user", aud: grant.bad ? "wrong-client" : "datatrip-fixture", iat: now, exp: now + 120,
      nonce: grant.nonce,
    })}`;
    return json(res, { token_type: "Bearer", access_token: "disposable", id_token: `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}` });
  }
  if (req.url === "/v1/auth/token/lookup-self" || req.url === "/v1/database/creds/fixture") {
    if (req.headers["x-vault-token"] !== "fixture-vault-token") {
      res.statusCode = 403;
      return json(res, { errors: ["permission denied"] });
    }
    if (req.url.endsWith("lookup-self")) {
      return json(res, { data: { display_name: "fixture", policies: ["read"], ttl: 600, renewable: true } });
    }
    return json(res, { lease_id: "fixture", lease_duration: 600, renewable: false,
      data: { username: "fixture-db-user", password: "not-for-browser" } });
  }
  if (req.url === "/v1/models" || req.url === "/v1/chat/completions") {
    if (req.headers.authorization !== "Bearer fixture-ai-key") {
      res.statusCode = 401;
      return json(res, { error: "unauthorized" });
    }
    if (req.url.endsWith("models")) return json(res, { data: [{ id: "fixture-model" }] });
    return json(res, { choices: [{ message: { content: "```sql\nSELECT 42\n```\nFixture response" } }] });
  }
  if (req.url === "/api/tags") return json(res, { models: [{ name: "fixture-ollama" }] });
  if (req.url === "/api/chat") return json(res, { message: { content: "Ready" } });
  res.writeHead(404).end();
});
const issuer = (await listen(provider)) + "/";
let child;
let serial = 0;
const env = { ...process.env, DATATRIP_TEST_KEY: key };
async function stop() {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await closed, [0, null]);
}
async function launch(auth, { dir = `case-${++serial}`, sessionSeconds = 300, invalid = false, providers = false, endpoints = {} } = {}) {
  const free = createServer();
  const origin = await listen(free);
  await new Promise((resolve) => free.close(resolve));
  const file = `${temp}/current.yml`;
  await writeFile(file, JSON.stringify({
    bind: origin.slice(7), publicOrigin: origin, dataDir: `${temp}/${dir}`, assetsDir: "dist-web",
    workspaceKeyEnv: "DATATRIP_TEST_KEY", auth, sessionSeconds, ...endpoints,
    ...(providers && { openaiUrl: `${issuer}v1`, ollamaUrl: issuer }),
  }));
  child = spawn(bin, ["--config", file], { env, stdio: ["ignore", "ignore", "pipe"] });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk; });
  if (invalid) {
    const [status] = await once(child, "exit");
    assert.equal(status, 1, output);
    return output;
  }
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(output);
    if ((await fetch(`${origin}/readyz`).catch(() => null))?.ok) return origin;
    await wait(50);
  }
  throw new Error(`Server did not become ready: ${output}`);
}
function browser(origin) {
  let binding;
  const cookies = new Map();
  const send = async (path, data, headers = {}) => {
    const initial = {
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...(binding && { "X-DataTrip-Session": binding }),
      ...headers,
    };
    const response = await fetch(`${origin}/api/v1/${path}`, data === undefined ? { headers: initial, redirect: "manual" } : {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...initial }, body: JSON.stringify(data), redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(";")[0];
      const [key, value] = first.split("=");
      if (value) cookies.set(key, value);
      else cookies.delete(key);
    }
    const value = response.headers.get("content-type")?.startsWith("application/json") ? await response.json() : null;
    if (response.ok && value?.binding) binding = value.binding;
    return { status: response.status, value, location: response.headers.get("location") };
  };
  return { send, token: () => cookies.get("datatrip_session"), setBinding: (value) => { binding = value; } };
}
const local = { local: { users } };
const oidc = { oidc: { issuer, clientId: "datatrip-fixture" } };
const credentials = (username) => ({ username, password: `${username}-test` });
async function entry(client) {
  const { version, ...options } = (await client.send("session")).value;
  assert.match(version, /^\d+\.\d+\.\d+/);
  return options;
}
async function loginOidc(client, kind) {
  const started = await client.send("login/oidc", {});
  assert.equal(started.status, 200);
  const params = new URL(started.value.url).searchParams;
  assert.equal(params.get("code_challenge_method"), "S256");
  const code = randomBytes(12).toString("hex");
  claims.set(code, { challenge: params.get("code_challenge"), nonce: params.get("nonce"), bad: kind === "audience" });
  const state = kind === "state" ? "wrong" : params.get("state");
  const callback = await client.send(`login/oidc/callback?code=${code}&state=${state}`);
  assert.equal(callback.location, kind ? "/?signInFailed=1" : "/");
  return (await client.send("session")).value.session;
}
try {
  assert.match(await launch({}, { invalid: true }), /Enable at least one/);
  assert.match(await launch({ anonymous: true, local: { users: [{ ...users[0], passwordHash: "plain" }] } }, { invalid: true }), /Invalid local account/);
  assert.match(await launch({ anonymous: true, oidc: { issuer: "http://127.0.0.1:1/", clientId: "fixture" } }, { invalid: true }), /OIDC discovery failed/);
  const guestOrigin = await launch({ anonymous: true });
  const guest = browser(guestOrigin);
  assert.deepEqual(await entry(guest), { session: null, anonymous: true, local: false, oidc: false });
  assert.equal((await guest.send("login/guest", {})).status, 200);
  const postgres = { driver: "postgres", name: "Local database", host: "localhost", port: 5432 };
  const saveConnection = (browser, config) => browser.send("operations/save_connection", { config });
  const vaultProfile = { id: "fixture-vault", name: "Fixture Vault", address: issuer, tokenSource: "keychain" };
  const saveVault = (browser, profile = vaultProfile) => browser.send("operations/save_vault_profile", { profile });
  assert.equal((await saveConnection(guest, postgres)).status, 200);
  assert.equal((await saveConnection(guest, { ...postgres, host: "/tmp" })).status, 400);
  assert.equal((await saveConnection(guest, { ...postgres, driver: "kafka" })).status, 403);
  assert.equal((await saveVault(guest)).status, 200);
  assert.match((await saveVault(guest, { ...vaultProfile, tokenSource: "env" })).value.message, /requires a workspace token/);
  assert.match((await saveVault(guest, { ...vaultProfile, address: "file:///tmp/vault" })).value.message, /valid HTTP or HTTPS/);
  await stop();
  const unrestricted = browser(await launch({ anonymous: true }, { endpoints: {
    restrictDatabaseEndpoint: false, databaseEndpoints: [], restrictVaultServer: false, vaultServers: [],
  } }));
  assert.equal((await unrestricted.send("login/guest", {})).status, 200);
  assert.equal((await saveConnection(unrestricted, postgres)).status, 200);
  const sentinel = { driver: "redis", name: "Sentinel", redis: { mode: "sentinel", sentinels: ["localhost:26379"] } };
  assert.equal((await saveConnection(unrestricted, sentinel)).status, 200);
  assert.equal((await saveVault(unrestricted)).status, 200);
  await stop();
  const restricted = browser(await launch({ anonymous: true }, { endpoints: {
    restrictDatabaseEndpoint: true, databaseEndpoints: ["127.0.0.1:5432"],
    restrictVaultServer: true, vaultServers: [issuer],
  } }));
  assert.equal((await restricted.send("login/guest", {})).status, 200);
  assert.equal((await saveConnection(restricted, postgres)).status, 403);
  assert.equal((await saveConnection(restricted, { ...postgres, host: "127.0.0.1" })).status, 200);
  assert.equal((await saveConnection(restricted, { ...postgres, host: "127.0.0.1", port: 5433 })).status, 403);
  assert.equal((await saveConnection(restricted, sentinel)).status, 403);
  assert.equal((await saveVault(restricted)).status, 200);
  assert.match((await saveVault(restricted, { ...vaultProfile, address: `${issuer}other` })).value.message, /outside the instance's allowed servers/);
  await stop();
  const denyAll = browser(await launch({ anonymous: true }, { endpoints: { restrictDatabaseEndpoint: true, restrictVaultServer: true } }));
  assert.equal((await denyAll.send("login/guest", {})).status, 200);
  assert.equal((await saveConnection(denyAll, { ...postgres, host: "127.0.0.1" })).status, 403);
  assert.match((await saveVault(denyAll)).value.message, /outside the instance's allowed servers/);
  await stop();
  const localOrigin = await launch(local, { dir: "named", providers: true });
  const a = browser(localOrigin);
  const b = browser(localOrigin);
  assert.deepEqual(await entry(a), { session: null, anonymous: false, local: true, oidc: false });
  assert.equal((await a.send("login/guest", {})).status, 401);
  assert.equal((await a.send("login/local", credentials("alpha"), { Origin: "https://example.invalid" })).status, 403);
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await a.send("login/local", { username: "does-not-exist", password: "wrong" })).value.message, "Invalid username or password");
  }
  assert.equal((await a.send("login/local", { username: "does-not-exist", password: "wrong" })).status, 429);
  const alpha = (await a.send("login/local", credentials("alpha"))).value;
  const beta = (await b.send("login/local", credentials("beta"))).value;
  assert.notEqual(alpha.workspaceId, beta.workspaceId);
  await a.send("operations/save_settings", { settings: { test: "alpha" } });
  assert.deepEqual((await b.send("operations/get_settings", {})).value, {});
  const file = (await a.send("files/output", { name: "persist.sqlite", purpose: "sqlite" })).value.file;
  const secret = "disposable-workspace-credential";
  const saved = (await a.send("operations/save_connection", {
    config: { id: "persisted", name: "Persistence", driver: "sqlite", filePath: file }, password: secret,
  })).value;
  assert.ok(!JSON.stringify(saved).includes(secret));
  const workspaces = await readdir(`${temp}/named/workspaces`);
  const paths = await Promise.all(workspaces.map(async (dir) => {
    const path = `${temp}/named/workspaces/${dir}`;
    const owner = JSON.parse(await readFile(`${path}/owner.json`, "utf8"));
    return owner.id === alpha.workspaceId ? path : null;
  }));
  assert.equal((await readFile(`${paths.find(Boolean)}/connections.enc`)).includes(Buffer.from(secret)), false);
  const otherBrowser = browser(localOrigin);
  assert.equal((await otherBrowser.send("login/local", credentials("alpha"))).value.workspaceId, alpha.workspaceId);
  const { sessionId } = (await otherBrowser.send("operations/open_session", { connectionId: saved.id })).value;
  const sql = (text) => otherBrowser.send("operations/execute", { sessionId, sql: text, maxRows: 10 });
  assert.equal((await sql("CREATE TABLE persistence (id INTEGER PRIMARY KEY)")).status, 200);
  assert.equal((await sql("BEGIN")).status, 200);
  assert.equal((await sql("INSERT INTO persistence VALUES (1)")).status, 200);
  const unauthorizedCancel = await a.send("operations/cancel", { sessionId });
  assert.match(unauthorizedCancel.value.message, /Session not found/);
  assert.deepEqual((await b.send("operations/list_connections", {})).value, []);
  const profile = vaultProfile;
  const vault = await a.send("operations/save_vault_profile", { profile, token: "fixture-vault-token" });
  assert.equal(vault.status, 200);
  assert.ok(!JSON.stringify(vault.value).includes("fixture-vault-token"));
  assert.equal((await a.send("operations/vault_token_info", { profile })).value.displayName, "fixture");
  assert.equal((await b.send("operations/vault_token_info", { profile })).status, 400);
  const checked = await a.send("operations/test_vault", { config: {
    id: "persisted", name: "Vault test", driver: "postgres", authMethod: "vault",
    vault: { profileId: profile.id, secretPath: "database/creds/fixture" },
  } });
  assert.equal(checked.value.secretKind, "dynamic");
  assert.ok(!JSON.stringify(checked.value).includes("not-for-browser"));
  assert.equal((await a.send("operations/ai_set_api_key", { key: "fixture-ai-key" })).status, 200);
  const models = await a.send("operations/ai_models", { provider: "openai", baseUrl: "http://invalid.example" });
  assert.deepEqual(models.value.models, [{ id: "fixture-model" }]);
  assert.match((await b.send("operations/ai_models", { provider: "openai" })).value.error, /No API key/);
  const sourceIds = [saved.id];
  const generated = await a.send("operations/ai_generate", { sourceIds, request: { provider: "openai", mode: "write", prompt: "Return 42." } });
  assert.equal(generated.value.sql, "SELECT 42");
  const explanation = await a.send("operations/ai_generate", { sourceIds, request: { provider: "ollama", mode: "explain" } });
  assert.equal(explanation.value.explanation, "Ready");
  await a.send("operations/save_connection", { config: { ...saved, production: { enabled: true } } });
  assert.equal((await a.send("operations/ai_generate", { sourceIds, request: { provider: "ollama", mode: "explain" } })).status, 403);
  await a.send("operations/save_connection", { config: saved });
  assert.equal((await a.send("operations/ai_generate", { sourceIds, request: { provider: "codex", mode: "write" } })).status, 400);
  if (process.env.PLAYWRIGHT_MODULE) {
    const { firefox } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
    const engine = await firefox.launch();
    try {
      const page = await engine.newPage();
      await page.goto(localOrigin);
      const enter = async (username) => {
        await page.getByLabel("Username").fill(username);
        await page.getByLabel("Password").fill(credentials(username).password);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.locator(".shell").waitFor();
      };
      await enter("alpha");
      await page.getByText("Persistence", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.getByText("Help", { exact: true }).click();
      await page.getByText("Sign out", { exact: true }).click();
      await page.getByLabel("Username").waitFor();
      await enter("beta");
      assert.equal(await page.getByText("Persistence", { exact: true }).count(), 0);
      console.log("Firefox sign-out and account switch discarded the previous workspace UI");
    } finally {
      await engine.close();
    }
  }
  const oldToken = a.token();
  assert.equal((await a.send("login/local", credentials("beta"))).value.workspaceId, beta.workspaceId);
  assert.notEqual(a.token(), oldToken);
  a.setBinding(alpha.binding);
  assert.equal((await a.send("operations/get_settings", {})).status, 401);
  assert.equal((await a.send("operations/get_settings", {}, { Cookie: `datatrip_session=${oldToken}` })).status, 401);
  a.setBinding((await a.send("session")).value.session.binding);
  assert.equal((await a.send("logout", {})).status, 204);
  assert.equal((await a.send("operations/get_settings", {})).status, 401);
  await stop();
  const restarted = browser(await launch(local, { dir: "named" }));
  assert.equal((await restarted.send("login/local", credentials("alpha"))).value.workspaceId, alpha.workspaceId);
  assert.equal((await restarted.send("operations/get_settings", {})).value.test, "alpha");
  const reopened = (await restarted.send("operations/open_session", { connectionId: saved.id })).value;
  const after = await restarted.send("operations/execute", {
    sessionId: reopened.sessionId, sql: "SELECT id FROM persistence", maxRows: 10,
  });
  assert.deepEqual(after.value.rows, [], "A live transaction was rolled back during shutdown");
  await stop();
  const oidcOnly = browser(await launch(oidc));
  assert.equal((await oidcOnly.send("login/guest", {})).status, 401);
  assert.equal(await loginOidc(oidcOnly, "state"), null);
  assert.equal(await loginOidc(oidcOnly, "audience"), null);
  assert.ok((await loginOidc(oidcOnly)).workspaceId);
  await stop();
  const dual = browser(await launch({ ...local, ...oidc }));
  assert.deepEqual(await entry(dual), { session: null, anonymous: false, local: true, oidc: true });
  assert.equal((await dual.send("login/local", credentials("alpha"))).status, 200);
  assert.ok((await loginOidc(dual)).workspaceId);
  await stop();
  const mixed = browser(await launch({ anonymous: true, ...local, ...oidc }, { dir: "mixed", sessionSeconds: 30 }));
  const temporary = (await mixed.send("login/guest", {})).value;
  const named = (await mixed.send("login/local", credentials("alpha"))).value;
  assert.notEqual(temporary.workspaceId, named.workspaceId);
  assert.deepEqual(await readdir(`${temp}/mixed/guests`), []);
  if (process.env.DATATRIP_TEST_EXPIRY === "1") {
    await wait(31_000);
    assert.equal((await mixed.send("session")).value.session, null);
    assert.equal((await mixed.send("operations/get_settings", {})).status, 401);
  }
  console.log("Authentication, session isolation/expiry, encrypted workspace persistence, Vault/AI provider fixtures and graceful rollback passed");
} finally {
  await stop();
  await new Promise((resolve) => provider.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

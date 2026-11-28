#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const children = new Set();
let signalExit;

function stopChildren(signal) {
  if (!children.size) return;
  for (const child of children) child.kill(signal);
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000).unref();
}

function start(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    children.add(child);
    child.once("error", (error) => {
      children.delete(child);
      reject(error);
    });
    child.once("exit", (code) => {
      children.delete(child);
      resolve(code ?? 1);
    });
  });
}

function cli(packageName, bin) {
  try {
    const manifest = require.resolve(`${packageName}/package.json`);
    return join(dirname(manifest), require(manifest).bin[bin]);
  } catch {
    throw new Error("Install the frontend dependencies with npm ci first.");
  }
}

function workspaceKey() {
  let key = process.env.DATATRIP_WEB_WORKSPACE_KEY;
  if (key === undefined) {
    const directory = join(root, ".datatrip-web");
    const path = join(directory, "local-workspace-key");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    key = readFileSync(path, "utf8").trim();
  }
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("The workspace key must be 64 hex characters.");
  return key;
}

async function run(mode) {
  if (mode === "desktop") {
    return start(process.execPath, [cli("@tauri-apps/cli", "tauri"), "dev"]);
  }

  const vite = cli("vite", "vite");
  const key = workspaceKey();
  const target = join(root, "src-web", "target");
  const built = await start("cargo", [
    "build", "--locked", "--manifest-path", "src-web/Cargo.toml", "--target-dir", target,
  ]);
  if (built !== 0 || signalExit) return built;

  const executable = process.platform === "win32" ? "datatrip-web.exe" : "datatrip-web";
  const server = start(join(target, "debug", executable), ["--config", "src-web/dev.yml"], {
    ...process.env,
    DATATRIP_WEB_WORKSPACE_KEY: key,
  });
  const frontend = start(process.execPath, [vite, "--config", "vite.web.config.ts"]);
  return Promise.race([server, frontend]);
}

const [mode = "desktop", ...extra] = process.argv.slice(2);
if (extra.length || !["desktop", "web", "--help", "-h"].includes(mode)) {
  console.error("Usage: node scripts/run-local.mjs [desktop|web]");
  process.exitCode = 2;
} else if (mode === "--help" || mode === "-h") {
  console.log("Usage: node scripts/run-local.mjs [desktop|web] (default: desktop)");
} else {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      signalExit = code;
      stopChildren(signal);
    });
  }
  try {
    process.exitCode = await run(mode);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.exitCode = signalExit ?? process.exitCode;
    stopChildren("SIGTERM");
  }
}

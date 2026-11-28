// Install Playwright and its browsers separately. PLAYWRIGHT_MODULE can point to
// the absolute path of a local playwright/index.mjs.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const origin = process.env.DATATRIP_TEST_ORIGIN ?? "http://127.0.0.1:8082";
const filenames = await readdir("dist-web/assets");
const worker = filenames.find((name) => /^webImportWorker-.*\.js$/.test(name));
const gzip = async (names) => {
  let total = 0;
  for (const file of names) total += gzipSync(await readFile(`dist-web/assets/${file}`)).length;
  return total;
};
const initial = await gzip(filenames.filter((name) => /^(web|bootstrap)-.*\.js$/.test(name)));
console.log(`Initial JS through IDE bootstrap: ${initial} bytes gzip`);
assert.ok(initial < 400_000, "Initial JavaScript exceeds 400 kB gzip");
for (const [feature, pattern] of [
  ["Format SQL", /^esm-.*\.js$/],
  ["First import", /^(importWizard|designerSql|webImportWorker|datatrip_wasm)[-_].*\.(js|wasm)$/],
  ["Connection dialog", /^connDialog-.*\.js$/],
  ["Settings", /^settingsDialog-.*\.js$/],
]) console.log(`${feature}: ${await gzip(filenames.filter((name) => pattern.test(name)))} deferred bytes gzip`);

const engines = (process.env.DATATRIP_TEST_BROWSERS ?? "chromium,firefox,webkit").split(",");
for (const engine of engines) {
  const browser = await playwright[engine].launch({
    headless: true,
    ...(engine === "chromium" && process.env.DATATRIP_CHROMIUM_PATH ? { executablePath: process.env.DATATRIP_CHROMIUM_PATH } : {}),
  });
  try {
    const samples = [];
    const baseline = [];
    const baselineOrigin = process.env.DATATRIP_TEST_BASELINE_ORIGIN;
    for (let i = 0; i < 5; i += 1) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const earlyRequests = [];
      page.on("request", (request) => earlyRequests.push(request.url()));
      const start = performance.now();
      await page.goto(origin);
      await page.locator(".shell").waitFor().catch(async (error) => {
        throw new Error(`${engine} could not load the IDE: ${errors.join("; ")} ${(await page.locator("body").innerText()).slice(0, 400)}`, { cause: error });
      });
      samples.push(performance.now() - start);
      assert.deepEqual(errors, []);
      assert.ok(earlyRequests.every((url) => !url.endsWith(".wasm") && !url.includes("webImportWorker")));
      if (i === 0) {
        const session = await page.evaluate(async () => (await (await fetch("/api/v1/session", { cache: "no-store" })).json()).session);
        const cookies = await context.cookies(origin);
        const cookie = cookies.find((cookie) => cookie.name === "datatrip_session");
        assert.ok(cookie, `${engine} did not store the HTTP-only session cookie`);
        const headers = { Origin: origin, Cookie: `${cookie.name}=${cookie.value}`, "X-DataTrip-Session": session.binding };
        const large = "id,name\n" + "12,DataTrip\n".repeat(1_000_000);
        const inputs = [
          { name: "large.csv", text: large },
          { name: "flatten.ndjson", text: '{"id":1,"entry":{"name":"one","when":"2026-10-27"}}\n{bad}\n{"id":2}\n' },
          { name: "quotes.tsv", text: 'id\tname\n1\t"one\ntwo"\n2\t"unterminated' },
          { name: "empty.csv", text: "" },
        ];
        for (const { name, text } of inputs) {
          const uploaded = await context.request.post(`${origin}/api/v1/files/upload?name=${name}&purpose=import`, { headers, data: Buffer.from(text) });
          assert.equal(uploaded.status(), 200);
          const { file } = await uploaded.json();
          const native = await context.request.post(`${origin}/api/v1/operations/import_preview`, {
            headers, data: { path: file, checkTypes: ["integer", "text"] },
          });
          const reply = await page.evaluate(async ({ worker, name, text }) => {
            const start = performance.now();
            const thread = new Worker(`/assets/${worker}`, { type: "module" });
            try {
              const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Preview timed out")), 10_000);
                thread.onmessage = (message) => { clearTimeout(timeout); resolve(message.data); };
                thread.onerror = (e) => { clearTimeout(timeout); reject(new Error(e.message)); };
                thread.postMessage({ file: new File([text], name), format: null, checks: ["integer", "text"] });
              });
              return { ...result, elapsed: performance.now() - start };
            } finally {
              thread.terminate();
            }
          }, { worker, name, text });
          if (native.ok()) assert.deepEqual(reply.preview, await native.json(), name);
          else assert.equal(reply.error, (await native.json()).message, name);
          console.log(`${engine} ${name} worker round trip: ${reply.elapsed.toFixed(0)} ms`);
        }
        if (process.env.DATATRIP_TEST_BROWSER_SQL === "1") {
          const op = async (name, data) => {
            const response = await context.request.post(`${origin}/api/v1/operations/${name}`, { headers, data });
            assert.equal(response.status(), 200, await response.text());
            return response.json();
          };
          const { id } = await op("save_connection", { config: {
            name: "Browser performance fixture", driver: "postgres", host: "127.0.0.1",
            port: 55432, database: "postgres", username: "datatrip",
          } });
          const sql = "SELECT i, md5(i::text) AS value FROM generate_series(1, 8000) AS i";
          await op("save_settings", { settings: { data: { restoreConsoles: true }, help: { tourDone: true }, results: { pageSize: 0 } } });
          await op("save_workspace", { workspace: { version: 1, active: 0, tabs: [{
            kind: "console", key: "perf-fixture", connId: id, title: "Performance", console: { sql, cursor: 8 },
          }] } });
          const editorStarted = performance.now();
          await page.reload();
          await page.locator(".cm-content").first().waitFor();
          console.log(`${engine}: restored editor visible after ${(performance.now() - editorStarted).toFixed(0)} ms`);
          const cdp = engine === "chromium" ? await context.newCDPSession(page) : null;
          const memory = async () => (await cdp?.send("Runtime.getHeapUsage"))?.usedSize;
          const before = await memory();
          const queryStarted = performance.now();
          const nextQuery = () => page.waitForResponse((response) => {
            if (!response.url().endsWith("/operations/execute") || !response.ok()) return false;
            return response.request().postDataJSON().sql.includes("generate_series");
          });
          let result = nextQuery();
          await page.getByRole("button", { name: "Run", exact: true }).click();
          assert.equal((await (await result).json()).rows.length, 500);
          await page.locator(".grid").first().waitFor();
          console.log(`${engine}: first query and grid ${(performance.now() - queryStarted).toFixed(0)} ms`);
          const largeStarted = performance.now();
          for (const expected of [1000, 2000, 4000, 8000]) {
            result = nextQuery();
            await page.getByRole("button", { name: "Load more", exact: true }).click();
            assert.equal((await (await result).json()).rows.length, expected);
          }
          await page.locator(".g-scroll").first().evaluate((grid) => { grid.scrollTop = grid.scrollHeight; });
          await page.waitForFunction(() => document.querySelector(".g-scroll")?.textContent.includes("8000"));
          const after = await memory();
          console.log(`${engine}: expand to 8,000 rows and scroll ${(performance.now() - largeStarted).toFixed(0)} ms` +
            (before && after ? `, JS heap delta ${((after - before) / 1_048_576).toFixed(1)} MiB` : ""));
        }
      }
      const entry = await context.request.get(`${origin}/api/v1/session`);
      const { session } = await entry.json();
      if (session) {
        await context.request.post(`${origin}/api/v1/logout`, { headers: { Origin: origin, "X-DataTrip-Session": session.binding } });
      }
      await context.close();
      if (baselineOrigin) {
        const previous = await browser.newContext();
        try {
          await previous.addInitScript(() => {
            // The pre-port bundle has no browser transport. Mock only startup
            // IPC so it can render the same empty IDE shell in the same browser.
            window.__TAURI_INTERNALS__ = {
              transformCallback: () => 1,
              invoke: async (name) => {
                if (name === "get_settings") return { help: { tourDone: true } };
                if (name.startsWith("list_")) return [];
                if (name === "get_explorer_layout" || name === "get_workspace") return {};
                return null;
              },
            };
          });
          const page = await previous.newPage();
          const start = performance.now();
          await page.goto(baselineOrigin);
          await page.locator(".shell").waitFor();
          baseline.push(performance.now() - start);
        } finally {
          await previous.close();
        }
      }
    }
if (process.env.DATATRIP_TEST_DEV_ORIGIN) {
      const dev = process.env.DATATRIP_TEST_DEV_ORIGIN;
      const page = await browser.newPage();
      try {
        await page.goto(dev);
        await page.locator(".shell").waitFor();
        await page.evaluate(() => {
          window.Worker = class { constructor() { throw new DOMException("Worker disabled by fixture", "SecurityError"); } };
        });
        const text = "id,name\n1,fallback\n";
        const traffic = [];
        page.on("response", (response) => {
          if (response.url().includes("/files/upload") || response.url().includes("/operations/import_preview")) {
            traffic.push({ url: response.url(), status: response.status(),
              args: response.url().includes("import_preview") ? response.request().postData() : null });
          }
        });
        let uploadConfirmed = false;
        page.on("dialog", async (dialog) => {
          uploadConfirmed ||= /upload.*fallback\.csv/i.test(dialog.message());
          await dialog.accept();
        });
        await page.evaluate(async (text) => {
            const originalClick = HTMLInputElement.prototype.click;
            HTMLInputElement.prototype.click = function () {
              if (this.type !== "file") return originalClick.call(this);
              const transfer = new DataTransfer();
              transfer.items.add(new File([text], "fallback.csv", { type: "text/csv" }));
              this.files = transfer.files;
              this.dispatchEvent(new Event("change"));
            };
            const api = "/api/v1";
            const session = (await (await fetch(`${api}/session`)).json()).session;
            const { createWebFiles } = await import("/src/webFiles.ts");
            const request = async (path, options) => {
              const response = await fetch(api + path, options);
              if (!response.ok) throw new Error((await response.json()).message);
              return response.json();
            };
            const post = (path, data, binding) => request(path, {
              method: "POST", headers: { "Content-Type": "application/json", "X-DataTrip-Session": binding },
              body: JSON.stringify(data),
            });
            const files = createWebFiles(session.binding, session.workspaceId, session.guest, new AbortController().signal, request, post);
            const button = document.createElement("button");
            button.textContent = "Choose import fixture";
            button.onclick = async () => {
              try {
                const path = await files.open({ purpose: "import" });
                button.dataset.preview = JSON.stringify((await files.invoke("import_preview", { path })).rows);
              } catch (error) {
                button.dataset.preview = String(error);
              }
            };
            document.body.append(button);
          }, text);
        await page.getByText("Choose import fixture").click();
        await page.locator("button[data-preview]").waitFor({ state: "attached" });
        assert.equal(await page.locator("button[data-preview]").getAttribute("data-preview"), '[["1","fallback"]]', JSON.stringify(traffic));
        assert.equal(uploadConfirmed, true);
        console.log(`${engine}: worker unavailable → explicit upload → native preview passed`);
      } finally {
        await page.close();
      }
    }
    samples.sort((a, b) => a - b);
    console.log(`${engine}: median cold navigation to IDE shell ${samples[2].toFixed(0)} ms (5 fresh contexts)`);
    if (baseline.length) {
      baseline.sort((a, b) => a - b);
      console.log(`${engine}: baseline median ${baseline[2].toFixed(0)} ms (mock startup IPC, 5 fresh contexts)`);
    }
  } finally {
    await browser.close();
  }
}

import { defineConfig } from "vite";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const webPort = Number(process.env.DATATRIP_WEB_DEV_PORT ?? 1421);

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    watch: { ignored: ["**/dist/**", "**/target/**", "**/.datatrip-web/**"] },
    proxy: {
      "/api": {
        target: process.env.DATATRIP_WEB_API ?? "http://127.0.0.1:8080",
      },
    },
  },
  plugins: [{
    name: "datatrip-web-entry",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/" || req.url?.startsWith("/?")) req.url = "/web.html";
        next();
      });
    },
    async closeBundle() {
      if (this.meta.watchMode) return;
      const dir = "dist-web/assets";
      const entries = await readdir(dir).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      await Promise.all(entries.filter((entry) => /\.(?:js|css|wasm)$/.test(entry)).map(async (entry) => {
        const path = `${dir}/${entry}`;
        await writeFile(`${path}.gz`, gzipSync(await readFile(path)));
      }));
    },
  }],
  worker: { format: "es" },
  build: {
    outDir: "dist-web",
    target: "es2021",
    rollupOptions: { input: "web.html" },
  },
});

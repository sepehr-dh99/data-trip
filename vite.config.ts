import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/dist-web/**", "**/target/**", "**/.datatrip-web/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});

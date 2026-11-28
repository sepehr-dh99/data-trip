import type { ImportFormat, ImportPreview } from "./types";

export type PreviewRequest = { file: File; format: ImportFormat | null; checks: (string | null)[] | null };
export type PreviewReply = { preview: ImportPreview } | { error: string; parse: boolean };

// Vite resolves the generated module for web builds. For a web dev checkout without Wasm,
// the worker reports unavailability and the authorized native path handles the sample.
const bindings = import.meta.glob<{
  default: () => Promise<unknown>;
  import_preview: (bytes: Uint8Array, options: string) => string;
}>("./generated/datatrip_wasm.js");

self.addEventListener("message", async ({ data }: MessageEvent<PreviewRequest>) => {
  const { file, format, checks } = data;
  let parse = false;
  try {
    const load = bindings["./generated/datatrip_wasm.js"];
    if (!load) throw new Error("Wasm preview is unavailable");
    const wasm = await load();
    await wasm.default();
    const bytes = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
    const options = JSON.stringify({ name: file.name, size: file.size, format, checks });
    parse = true;
    const preview = JSON.parse(wasm.import_preview(bytes, options)) as ImportPreview;
    self.postMessage({ preview } satisfies PreviewReply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ error: message, parse: parse && !(error instanceof WebAssembly.RuntimeError) } satisfies PreviewReply);
  }
});

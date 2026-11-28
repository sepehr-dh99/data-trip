import type { OpenFileOptions, Platform, SaveFileOptions } from "./platform";
import type { PreviewReply, PreviewRequest } from "./webImportWorker";
import type { ImportPreview } from "./types";
import { browserHandles } from "./browserHandles";

type LocalFile = { file: File; uploaded?: Promise<string> };
type Http = <T>(path: string, options?: RequestInit) => Promise<T>;
type Post = <T>(path: string, args: unknown, binding: string) => Promise<T>;

export function createWebFiles(binding: string, workspaceId: string, guest: boolean, signal: AbortSignal, request: Http, post: Post) {
  const local = new Map<string, LocalFile>();
  const handles = browserHandles(workspaceId, guest);
  function upload(file: File, purpose: NonNullable<OpenFileOptions["purpose"]>): Promise<string> {
    const params = new URLSearchParams({ name: file.name, purpose });
    return request<{ file: string }>("/files/upload?" + params, {
      method: "POST", headers: { "X-DataTrip-Session": binding }, body: file, signal,
    }).then((result) => result.file);
  }

  async function open(options: OpenFileOptions): Promise<string | null> {
    if ((options.purpose === "sql" || options.purpose === "script") && handles.open) {
      try {
        return await handles.open();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
      }
    }
    const file = await pickFile(options);
    if (!file) return null;
    const purpose = options.purpose ?? "text";
    if (purpose === "sql" || purpose === "script" || purpose === "sqlite" || purpose === "material") {
      if (!window.confirm(`Upload a copy of “${file.name}” to your DataTrip workspace?`)) return null;
      return upload(file, purpose);
    }
    const id = `local/${crypto.randomUUID()}/${file.name}`;
    if (local.size >= 8) local.delete(local.keys().next().value!);
    local.set(id, { file });
    return id;
  }

  async function save(options: SaveFileOptions): Promise<string | null> {
    const suggested = (options.defaultPath ?? "download").split(/[\\/]/).pop() ?? "download";
    if (options.purpose === "sql" && !options.localCopy && handles.saveAs) {
      try {
        return await handles.saveAs(suggested);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
      }
    }
    const name = window.prompt(options.title ?? "Save file", suggested);
    if (!name) return null;
    const result = await post<{ file: string }>("/files/output", { name, purpose: options.purpose ?? "output" }, binding);
    return result.file;
  }

  function download(file: string): void {
    if (!/^[0-9a-f-]{36}\//i.test(file)) return;
    const anchor = document.createElement("a");
    anchor.href = `/api/v1/files/${file.split("/").map(encodeURIComponent).join("/")}?binding=${encodeURIComponent(binding)}`;
    anchor.download = file.split("/").pop() ?? "";
    anchor.rel = "noreferrer";
    anchor.click();
  }

  const invoke: Platform["invoke"] = async <T>(name: string, supplied?: Record<string, unknown>) => {
    let args = supplied ?? {};
    if (name === "vault_oidc_login") {
      const popup = window.open("about:blank", "_blank");
      if (!popup) throw new Error("Allow pop-ups for DataTrip to sign in to Vault");
      popup.opener = null;
      try {
        const { id, url } = await post<{ id: string; url: string }>("/operations/vault_oidc_login", args, binding);
        popup.location.href = url;
        for (;;) {
          const value = await request<T | null>(`/vault-oidc/${encodeURIComponent(id)}`, {
            headers: { "X-DataTrip-Session": binding }, signal,
          });
          if (value !== null) return value;
          if (popup.closed) {
            await post("/operations/vault_oidc_cancel", {}, binding);
            throw new Error("OIDC_CANCELLED: Vault sign-in window closed");
          }
          await new Promise((resolve) => window.setTimeout(resolve, 800));
        }
      } finally {
        popup.close();
      }
    }
    const path = typeof args.path === "string" ? args.path : "";
    if (handles.isBrowserFile(path)) {
      if (name === "sql_file_write") {
        return await handles.save(path, String(args.text), args.expectedMtimeMs as number | null, Boolean(args.bom)) as T;
      }
      const file = await handles.file(path).catch((error) => {
        if (name === "file_mtime" && error instanceof DOMException && error.name === "NotFoundError") return null;
        throw error;
      });
      if (name === "file_mtime") return (file ? { mtimeMs: file.lastModified, size: file.size } : null) as T;
      if (!file) throw new Error("The browser file could not be read");
      if (name === "sql_file_read") {
        if (file.size > 8 * 1024 * 1024) throw new Error("FILE_TOO_LARGE: The file is larger than 8 MiB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { text, bom, mtimeMs: file.lastModified, size: file.size } as T;
      }
      if (name === "run_sql_file") {
        if (!window.confirm(`Upload “${file.name}” to run it on the DataTrip server?`)) throw new Error("No file uploaded");
        args = { ...args, path: await upload(file, "script") };
      }
    }
    const selection = local.get(path);
    if (name === "read_text_file" && selection) {
      if (selection.file.size > 8 * 1024 * 1024) throw new Error("File is larger than 8 MiB");
      const bytes = await selection.file.arrayBuffer();
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) as T;
      } catch {
        throw new Error("File is not valid UTF-8 text");
      }
    }
    if ((name === "import_preview" || name === "import_run") && selection) {
      if (name === "import_preview") {
        try {
          return await preview({
            file: selection.file,
            format: args.format as PreviewRequest["format"],
            checks: args.checkTypes as PreviewRequest["checks"],
          }, signal) as T;
        } catch (error) {
          if (signal.aborted) throw error;
          // Expected Rust parsing errors are already the authoritative preview message.
          if (error instanceof PreviewError) throw error;
        }
      }
      if (!selection.uploaded) {
        const reason = name === "import_preview" ? "Preview could not run in this browser." : "Import runs on the DataTrip server.";
        if (!window.confirm(`${reason} Upload “${selection.file.name}” to your workspace?`)) {
          throw new Error("No file uploaded");
        }
        selection.uploaded = upload(selection.file, "import").catch((error) => {
          selection.uploaded = undefined;
          throw error;
        });
      }
      args = { ...args, path: await selection.uploaded };
    }
    let result: T;
    try {
      result = await post<T>("/operations/" + name, args, binding);
    } catch (error) {
      const id = args.runId;
      // A lost response is resolved via the original run ID, never by starting it again.
      if (typeof id !== "string" || !["import_run", "run_sql_file"].includes(name)
        || ((error as { status?: number }).status && (error as { status: number }).status < 500)) throw error;
      result = await recoverRun<T>(id, binding, signal, request);
    }
    if (["write_text_file", "export_query", "export_query_with"].includes(name)) download(path);
    return result;
  };

  return { open, save, download, invoke };
}

function pickFile(options: OpenFileOptions): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = (options.filters ?? []).flatMap((filter) => filter.extensions).filter((ext) => ext !== "*").map((ext) => `.${ext}`).join(",");
    input.hidden = true;
    const complete = (file: File | null) => { input.remove(); resolve(file); };
    input.addEventListener("change", () => complete(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => complete(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

class PreviewError extends Error {}

function preview(input: PreviewRequest, signal: AbortSignal): Promise<ImportPreview> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./webImportWorker.ts", import.meta.url), { type: "module" });
    const finish = () => { worker.terminate(); clearTimeout(timer); signal.removeEventListener("abort", aborted); };
    const fail = (reason: unknown) => { finish(); reject(reason); };
    const aborted = () => fail(signal.reason);
    const timer = window.setTimeout(() => fail(new Error("Worker preview timed out")), 10_000);
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    worker.onerror = () => fail(new Error("Could not load the preview worker"));
    worker.onmessage = (message: MessageEvent<PreviewReply>) => {
      finish();
      if ("preview" in message.data) resolve(message.data.preview);
      else reject(message.data.parse ? new PreviewError(message.data.error) : new Error(message.data.error));
    };
    worker.postMessage(input);
  });
}

async function recoverRun<T>(id: string, binding: string, signal: AbortSignal, request: Http): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await request<{ state: "running" | "success" | "failure"; value: T; error: unknown }>(
      `/jobs/${encodeURIComponent(id)}`, { headers: { "X-DataTrip-Session": binding }, signal },
    );
    if (result.state === "success") return result.value;
    if (result.state === "failure") throw result.error;
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error("The job is still running; its result could not be recovered");
}

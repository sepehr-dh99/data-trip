// Browser-granted SQL file access. Handle IDs are opaque and scoped to the workspace.
type WritableFile = {
  write(bytes: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};
type Handle = FileSystemFileHandle & {
  queryPermission(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  createWritable(): Promise<WritableFile>;
};
type FilePickers = Window & {
  showOpenFilePicker?: (options: { multiple: false }) => Promise<Handle[]>;
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<Handle>;
};

const isBrowserFile = (path: string): boolean => path.startsWith("browser-file/");
const pickers = window as FilePickers;
const fileChanged = (name: string) => new Error(`FILE_CHANGED: ${name} was changed on disk after you opened it.`);

export function browserHandles(workspaceId: string, guest: boolean) {
  let database: Promise<IDBDatabase> | undefined;
  const memory = new Map<string, Handle>();

  function openDatabase(): Promise<IDBDatabase> {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(`datatrip-files-${workspaceId}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("handles");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return database;
  }

  async function store(handle: Handle): Promise<string> {
    const id = `browser-file/${crypto.randomUUID()}/${handle.name}`;
    memory.set(id, handle);
    if (!guest) {
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("handles", "readwrite");
        transaction.objectStore("handles").put(handle, id);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => resolve();
      });
    }
    return id;
  }

  async function get(id: string): Promise<Handle> {
    let handle = memory.get(id);
    if (!handle && !guest) {
      const db = await openDatabase();
      handle = await new Promise<Handle | undefined>((resolve, reject) => {
        const request = db.transaction("handles").objectStore("handles").get(id);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as Handle | undefined);
      });
      if (handle) memory.set(id, handle);
    }
    if (!handle) throw new Error("This browser does not have the file handle. Choose the file again.");
    return handle;
  }

  async function file(id: string): Promise<File> {
    const handle = await get(id);
    const mode = { mode: "read" } as const;
    if (await handle.queryPermission(mode) !== "granted") {
      if (await handle.requestPermission(mode) !== "granted") throw new Error("Permission to read this file was denied");
    }
    return handle.getFile();
  }

  async function save(
    id: string, text: string, expectedMtimeMs: number | null, bom: boolean,
  ): Promise<{ mtimeMs: number }> {
    const handle = await get(id);
    const mode = { mode: "readwrite" } as const;
    if (await handle.queryPermission(mode) !== "granted") {
      if (await handle.requestPermission(mode) !== "granted") throw new Error("Permission to save this file was denied");
    }
    const before = await handle.getFile();
    if (expectedMtimeMs !== null && before.lastModified !== expectedMtimeMs) throw fileChanged(before.name);
    const stream = await handle.createWritable();
    try {
      await stream.write(new Blob([bom ? "\uFEFF" : "", text], { type: "text/plain;charset=utf-8" }));
      if (expectedMtimeMs !== null && (await handle.getFile()).lastModified !== expectedMtimeMs) throw fileChanged(before.name);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
    return { mtimeMs: (await handle.getFile()).lastModified };
  }

  return {
    isBrowserFile,
    file,
    save,
    open: pickers.showOpenFilePicker && (async () => {
      try {
        const [handle] = await pickers.showOpenFilePicker!({ multiple: false });
        return handle ? store(handle) : null;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
      }
    }),
    saveAs: pickers.showSaveFilePicker && (async (suggestedName: string) => {
      try {
        return store(await pickers.showSaveFilePicker!({ suggestedName }));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
      }
    }),
  };
}

export type CommandTransport = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
export type EventTransport = <T>(name: string, receive: (event: { payload: T }) => void) => Promise<() => void>;
type FileFilter = { name: string; extensions: string[] };
export interface OpenFileOptions {
  multiple?: false;
  directory?: false;
  defaultPath?: string;
  title?: string;
  filters?: FileFilter[];
  purpose?: "sql" | "script" | "import" | "text" | "material" | "sqlite";
}
export interface SaveFileOptions {
  defaultPath?: string;
  title?: string;
  filters?: FileFilter[];
  purpose?: "sql" | "output" | "sqlite";
  localCopy?: boolean;
}

export interface Platform {
  mode: "desktop" | "web";
  invoke: CommandTransport;
  listen: EventTransport;
  open: (options: OpenFileOptions) => Promise<string | null>;
  save: (options: SaveFileOptions) => Promise<string | null>;
  preferences: Pick<Storage, "getItem" | "setItem">;
  signOut?: () => void;
  version?: string;
  download?: (file: string) => void;
}

let platform: Platform;
export const setPlatform = (value: Platform): void => { platform = value; };
export const getPlatform = (): Platform => platform;
export const isDesktop = (): boolean => platform.mode === "desktop";
export const hasNativeMenu = (): boolean => isDesktop() && /Mac/.test(navigator.userAgent);
export const invoke: CommandTransport = (name, args) => platform.invoke(name, args);
export const listen: EventTransport = (name, receive) => platform.listen(name, receive);
export const open: Platform["open"] = (options) => platform.open(options);
export const save: Platform["save"] = (options) => platform.save(options);
export const preferences: Platform["preferences"] = {
  getItem: (key) => platform.preferences.getItem(key),
  setItem: (key, value) => platform.preferences.setItem(key, value),
};

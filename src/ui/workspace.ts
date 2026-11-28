// Restore consoles on launch: the open tabs (manual order, active tab, console text / cursor / bindings / attached
// cross-source sources, Redis key / Kafka topic / group tabs, v0.17: Sessions & locks and Show DDL tabs) are saved to <config>/workspace.json through the
// backend (debounced, and flushed when the window goes away) and reopened lazily on the next start.
import { isDesktop } from "../platform";
import { api } from "../api";
import { h, icon } from "./dom";
import { typeInfo } from "./redis";
import type { TabPane } from "./tabs";
import { parseRemembered } from "./params";
import type { RememberedParams } from "./params";
import type { DdlKind } from "../types";

export type WsKind = TabPane["kind"];

/** A data source attached to a console for cross-source queries. */
export interface WsSource {
  alias: string;
  connId: string;
  database: string | null;
}

/** What a SQL / Redis / Kafka console needs to come back. */
export interface WsConsole {
  sql: string;
  cursor: number;
  /** Bound database; null = the connection's default. */
  database: string | null;
  /** The effective database when saved (tab names before the data source is connected again). */
  dbHint: string | null;
  schema: string | null;
  /** The schema was picked explicitly (PostgreSQL then also sets search_path). */
  schemaExplicit: boolean;
  table: string | null;
  /** Cross-source: alias of the console's own source (null = automatic). */
  ownAlias: string | null;
  /** Cross-source: database of the console's own source (null = the console's database). */
  ownDb: string | null;
  sources: WsSource[];
  /** The Sources strip was open (even without attached sources). */
  fedShown: boolean;
  /** Opened as a cross-source console (tab badge "N sources"); absent in older workspaces. */
  crossSource?: boolean;
  /** v0.15: the .sql file the console is bound to (absent / null = a plain console). */
  file?: { path: string; mtimeMs: number | null; dirty: boolean } | null;
  /** v0.16: parameter values remembered for this console ("Remember values for this console"). */
  params?: RememberedParams | null;
}

/** v0.17: a Sessions & locks tab (filters and auto-refresh). */
export interface WsSessions {
  activeOnly: boolean;
  hideIdle: boolean;
  query: string;
  auto: boolean;
  /** Auto-refresh interval in seconds (2 | 5 | 10). */
  every: number;
}

/** v0.17: a Show DDL tab (its DDL is read again when the tab is first shown). */
export interface WsDdl {
  kind: DdlKind;
  /** The real database name. */
  database: string | null;
  schema: string | null;
  name: string;
  arguments: string | null;
  table: string | null;
  options: { indexes: boolean; comments: boolean; qualified: boolean };
}

export interface WsTab {
  kind: WsKind;
  /** Stable tab key at save time (pinned tabs / custom groups refer to it). */
  key: string;
  /** Manual tab name, null = automatic. */
  name: string | null;
  connId: string;
  /** Console: its title ("console 2"); key / topic / group: the key, topic or group id. */
  title: string;
  /** Redis key tabs: database index; consoles: see `console.database`. */
  database: string | null;
  console?: WsConsole;
  /** Redis key tabs: last known key type (tab icon before loading). */
  keyType?: string;
  /** v0.17: Sessions & locks tabs. */
  sessions?: WsSessions;
  /** v0.17: Show DDL tabs. */
  ddl?: WsDdl;
}

export interface Workspace {
  version: 1;
  /** Open tabs in manual order. */
  tabs: WsTab[];
  /** Index of the active tab in `tabs`, -1 = none. */
  active: number;
}

// ---- tolerant parsing

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const KINDS: readonly WsKind[] = ["console", "key", "topic", "group", "sessions", "ddl"];
const DDL_KINDS: readonly DdlKind[] = ["table", "view", "materialized", "function", "procedure", "sequence", "index"];

function parseSessions(v: unknown): WsSessions {
  const o = isObj(v) ? v : {};
  const every = o.every === 2 || o.every === 10 ? o.every : 5;
  return { activeOnly: o.activeOnly === true, hideIdle: o.hideIdle === true, query: str(o.query) ?? "", auto: o.auto !== false, every };
}

function parseDdl(v: unknown): WsDdl | null {
  if (!isObj(v)) return null;
  const kind = DDL_KINDS.includes(v.kind as DdlKind) ? (v.kind as DdlKind) : null;
  const name = str(v.name);
  if (!kind || !name) return null;
  const o = isObj(v.options) ? v.options : {};
  return {
    kind,
    database: str(v.database),
    schema: str(v.schema),
    name,
    arguments: str(v.arguments),
    table: str(v.table),
    options: { indexes: o.indexes !== false, comments: o.comments !== false, qualified: o.qualified !== false },
  };
}

function parseSource(v: unknown): WsSource | null {
  if (!isObj(v)) return null;
  const alias = str(v.alias);
  const connId = str(v.connId);
  if (!alias || !connId) return null;
  return { alias, connId, database: str(v.database) };
}

function parseConsole(v: unknown): WsConsole {
  const c = isObj(v) ? v : {};
  const cursor = typeof c.cursor === "number" && isFinite(c.cursor) ? Math.max(0, Math.floor(c.cursor)) : 0;
  return {
    sql: str(c.sql) ?? "",
    cursor,
    database: str(c.database),
    dbHint: str(c.dbHint),
    schema: str(c.schema),
    schemaExplicit: c.schemaExplicit === true,
    table: str(c.table),
    ownAlias: str(c.ownAlias),
    ownDb: str(c.ownDb),
    sources: Array.isArray(c.sources) ? c.sources.map(parseSource).filter((s): s is WsSource => s !== null) : [],
    fedShown: c.fedShown === true,
    crossSource: c.crossSource === true,
    file: parseFile(c.file),
    params: parseRemembered(c.params),
  };
}

function parseFile(v: unknown): WsConsole["file"] {
  if (!isObj(v)) return null;
  const path = str(v.path);
  if (!path) return null;
  return { path, mtimeMs: typeof v.mtimeMs === "number" && isFinite(v.mtimeMs) ? v.mtimeMs : null, dirty: v.dirty === true };
}

export function parseWorkspace(raw: unknown): Workspace {
  const out: Workspace = { version: 1, tabs: [], active: -1 };
  if (!isObj(raw) || !Array.isArray(raw.tabs)) return out;
  for (const t of raw.tabs) {
    if (!isObj(t)) continue;
    const kind = KINDS.includes(t.kind as WsKind) ? (t.kind as WsKind) : null;
    const connId = str(t.connId);
    const title = str(t.title);
    if (!kind || !connId || title === null) continue;
    const ddl = kind === "ddl" ? parseDdl(t.ddl) : null;
    if (kind === "ddl" && !ddl) continue;
    out.tabs.push({
      kind,
      key: str(t.key) ?? "",
      name: str(t.name),
      connId,
      title,
      database: str(t.database),
      console: kind === "console" ? parseConsole(t.console) : undefined,
      keyType: str(t.keyType) ?? undefined,
      sessions: kind === "sessions" ? parseSessions(t.sessions) : undefined,
      ddl: ddl ?? undefined,
    });
  }
  const a = typeof raw.active === "number" ? Math.floor(raw.active) : -1;
  out.active = a >= 0 && a < out.tabs.length ? a : -1;
  return out;
}

export async function loadWorkspace(): Promise<Workspace> {
  try {
    return parseWorkspace(await api.getWorkspace());
  } catch (error) {
    if (!isDesktop()) throw error;
    return parseWorkspace(null);
  }
}

// ---- debounced saving

const SAVE_DELAY = 1000;

/**
 * Saves what `collect()` returns (null = saving is off) 1 s after the last `schedule()`, and at once on `flush()`
 * (window hidden / closing). Identical snapshots are not written twice.
 */
export class WorkspaceSaver {
  private timer: number | undefined;
  private last = "";
  private saving: Promise<void> | null = null;

  constructor(private collect: () => Workspace | null) {
    const flush = (): void => { void this.flush(); };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }

  schedule(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, SAVE_DELAY);
  }

  /** Writes now if a save is pending. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
      this.write();
    }
    await this.saving;
  }

  /** Forgets the pending save (restore turned off). */
  cancel(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private write(): void {
    let ws: Workspace | null;
    try {
      ws = this.collect();
    } catch {
      return;
    }
    if (!ws) return;
    const json = JSON.stringify(ws);
    if (json === this.last) return;
    this.last = json;
    const run = (): Promise<void> =>
      api.saveWorkspace(JSON.parse(json) as Record<string, unknown>).then(
        () => undefined,
        () => {
          // Best effort: the next change retries.
          if (this.last === json) this.last = "";
          if (!isDesktop()) window.dispatchEvent(new Event("dt-workspace-save-failed"));
        },
      );
    // Keep writes in order (atomic rename on the backend; the newest must land last).
    this.saving = (this.saving ?? Promise.resolve()).then(run, run);
  }
}

// ---- placeholder for restored Redis key / Kafka topic / group tabs (opened when first activated)

export class RestoredPane implements TabPane {
  readonly el: HTMLElement;
  readonly controls: HTMLElement = h("div", { class: "cap-controls" });
  title: string;
  connId: string;
  database: string | null;
  readonly isRunning = false;
  readonly tabIcon: { icon: string; cls: string };

  constructor(readonly kind: WsKind, readonly saved: WsTab) {
    this.title = saved.title;
    this.connId = saved.connId;
    this.database = kind === "key" ? saved.database : null;
    if (kind === "key") {
      const t = typeInfo(saved.keyType ?? "");
      this.tabIcon = { icon: t.icon, cls: t.cls };
    } else if (kind === "topic") this.tabIcon = { icon: "topic", cls: "kt-topic" };
    else this.tabIcon = { icon: "group", cls: "kt-group" };
    this.el = h(
      "div",
      { class: "r-message", tabindex: "-1" },
      h("span", { class: "spinner", "aria-hidden": "true" }),
      h("div", { class: "r-message-sub" }, "Opening…"),
    );
  }

  get effectiveDatabase(): string | null {
    return this.kind === "key" ? this.database : null;
  }

  get objectLabel(): { glyph: "topic" | "group"; name: string } | undefined {
    return this.kind === "topic" || this.kind === "group" ? { glyph: this.kind, name: this.title } : undefined;
  }

  /** Shown when the tab can't be opened (connection failed). */
  showError(text: string): void {
    this.el.replaceChildren(icon("alert", 20), h("div", { class: "r-message-title" }, "Couldn't open this tab"), h("div", { class: "r-message-sub" }, text));
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }
  async dispose(): Promise<void> {}
  dropSession(): void {}
  updateSchema(): void {}
  async switchDatabase(): Promise<void> {}
  async switchConnection(): Promise<void> {}
  currentSchemaName(): string | null {
    return null;
  }
  async setDefaultSchema(): Promise<void> {}
}

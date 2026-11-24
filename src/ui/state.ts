// Connection registry shared by the explorer, consoles and shell.
import { api } from "../api";
import { humanMsg } from "./dom";
import { handleActionError } from "./recovery";
import type { ConnectionConfig, DatabaseNode, ObjectGroup, SchemaNode, SessionInfo } from "../types";

export type ConnStatus = "idle" | "connecting" | "connected" | "error";

/** An explorer-side (connection, database) pair: its own session and introspection. */
export interface DbEntry {
  name: string;
  status: "idle" | "loading" | "ready" | "error";
  session: SessionInfo | null;
  schemas: SchemaNode[];
  error: string | null;
  promise?: Promise<void>;
}

export interface ConnEntry {
  config: ConnectionConfig;
  status: ConnStatus;
  /** Session on the connection's default database (also used for server-level queries). */
  session: SessionInfo | null;
  /** Introspection of the default database. */
  schemas: SchemaNode[];
  error: string | null;
  databases: DatabaseNode[];
  serverObjects: ObjectGroup[];
  /** Name of the default database (session.database or the one flagged current). */
  defaultDb: string | null;
  /** Explorer sessions, one per database that was expanded. */
  dbs: Map<string, DbEntry>;
}

const errText = (e: unknown): string => humanMsg(e instanceof Error ? e.message : String(e));

type Listener = () => void;

class Store {
  conns = new Map<string, ConnEntry>();
  private listeners = new Set<Listener>();
  private schemaListeners = new Set<(id: string) => void>();

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  onSchema(fn: (id: string) => void): void {
    this.schemaListeners.add(fn);
  }
  emit(): void {
    for (const l of this.listeners) l();
  }

  list(): ConnEntry[] {
    return [...this.conns.values()];
  }

  async load(): Promise<void> {
    const list = await api.listConnections();
    const next = new Map<string, ConnEntry>();
    for (const cfg of list) {
      const old = this.conns.get(cfg.id);
      next.set(
        cfg.id,
        old ? { ...old, config: cfg } : { config: cfg, status: "idle", session: null, schemas: [], error: null, databases: [], serverObjects: [], defaultDb: null, dbs: new Map() },
      );
    }
    for (const [id, e] of this.conns) {
      if (!next.has(id)) this.closeAll(e);
    }
    this.conns = next;
    this.emit();
  }

  async connect(id: string): Promise<void> {
    const e = this.conns.get(id);
    if (!e || e.status === "connecting" || e.status === "connected") return;
    e.status = "connecting";
    e.error = null;
    this.emit();
    try {
      e.session = await api.openSession(id);
      const sid = e.session.sessionId;
      const [schemas, databases, serverObjects] = await Promise.all([
        api.introspect(sid),
        api.listDatabases(sid).catch(() => [] as DatabaseNode[]),
        api.listServerObjects(sid).catch(() => [] as ObjectGroup[]),
      ]);
      e.schemas = schemas;
      e.databases = databases;
      e.serverObjects = serverObjects;
      e.defaultDb = e.session.database ?? databases.find((d) => d.isCurrent)?.name ?? null;
      if (e.defaultDb && !e.databases.some((d) => d.name === e.defaultDb)) {
        e.databases = [{ name: e.defaultDb, isCurrent: true, isSystem: false, sizeBytes: null, comment: null }, ...e.databases];
      }
      e.dbs = new Map();
      if (e.defaultDb) e.dbs.set(e.defaultDb, { name: e.defaultDb, status: "ready", session: e.session, schemas, error: null });
      e.status = "connected";
    } catch (err) {
      e.status = "error";
      e.error = errText(err);
      this.closeAll(e);
      e.session = null;
      this.emit();
      throw err;
    }
    this.emit();
    for (const l of this.schemaListeners) l(id);
  }

  private closeAll(e: ConnEntry): void {
    const main = e.session;
    for (const d of e.dbs.values()) {
      if (d.session && d.session !== main) void api.closeSession(d.session.sessionId).catch(() => undefined);
    }
    if (main) void api.closeSession(main.sessionId).catch(() => undefined);
    e.dbs = new Map();
  }

  async disconnect(id: string): Promise<void> {
    const e = this.conns.get(id);
    if (!e) return;
    this.closeAll(e);
    e.session = null;
    e.status = "idle";
    e.schemas = [];
    e.databases = [];
    e.serverObjects = [];
    e.defaultDb = null;
    e.error = null;
    this.emit();
  }

  /** Schemas introspected for (connection, database); null = the connection's default database. */
  schemasFor(id: string, database: string | null): SchemaNode[] {
    const e = this.conns.get(id);
    if (!e) return [];
    if (database === null || database === e.defaultDb) return e.schemas;
    return e.dbs.get(database)?.schemas ?? [];
  }

  /** Default schema of that database's explorer session. */
  defaultSchemaFor(id: string, database: string | null): string | null {
    const e = this.conns.get(id);
    if (!e) return null;
    if (database === null || database === e.defaultDb) return e.session?.defaultSchema ?? null;
    return e.dbs.get(database)?.session?.defaultSchema ?? null;
  }

  /** Opens (once) the explorer session for a database and introspects it. */
  ensureDb(id: string, name: string): Promise<void> {
    const e = this.conns.get(id);
    if (!e || e.status !== "connected") return Promise.resolve();
    let d = e.dbs.get(name);
    if (d && (d.status === "ready" || d.promise)) return d.promise ?? Promise.resolve();
    d = d ?? { name, status: "idle", session: null, schemas: [], error: null };
    const entry = d;
    entry.status = "loading";
    entry.error = null;
    e.dbs.set(name, entry);
    entry.promise = (async () => {
      try {
        const s = await api.openSession(id, name);
        if (e.dbs.get(name) !== entry || e.status !== "connected") {
          void api.closeSession(s.sessionId).catch(() => undefined);
          return;
        }
        entry.session = s;
        entry.schemas = await api.introspect(s.sessionId);
        entry.status = "ready";
      } catch (err) {
        entry.status = "error";
        entry.error = errText(err);
        // Expired Vault token / unknown SSH host: offer the fix inline, then open the database again.
        handleActionError(err, () => {
          if (e.dbs.get(name) === entry) e.dbs.delete(name);
          return this.ensureDb(id, name).then(() => this.emit());
        });
        if (entry.session) void api.closeSession(entry.session.sessionId).catch(() => undefined);
        entry.session = null;
      } finally {
        entry.promise = undefined;
        this.emit();
        for (const l of this.schemaListeners) l(id);
      }
    })();
    this.emit();
    return entry.promise;
  }

  /** Re-introspects one database (opens it if it was never loaded). */
  async refreshDb(id: string, name: string): Promise<void> {
    const e = this.conns.get(id);
    const d = e?.dbs.get(name);
    if (!e || !d || !d.session) {
      await this.ensureDb(id, name);
      return;
    }
    d.schemas = await api.introspect(d.session.sessionId);
    if (name === e.defaultDb) e.schemas = d.schemas;
    this.emit();
    for (const l of this.schemaListeners) l(id);
  }

  /** Refreshes the database list, server objects and every loaded database. */
  async refresh(id: string): Promise<void> {
    const e = this.conns.get(id);
    if (!e || !e.session) return;
    const sid = e.session.sessionId;
    const [databases, serverObjects] = await Promise.all([
      api.listDatabases(sid).catch(() => e.databases),
      api.listServerObjects(sid).catch(() => e.serverObjects),
    ]);
    e.databases = databases;
    e.serverObjects = serverObjects;
    const loaded = [...e.dbs.values()].filter((d) => d.session);
    const results = await Promise.allSettled(
      loaded.map(async (d) => {
        d.schemas = await api.introspect(d.session!.sessionId);
        if (d.name === e.defaultDb) e.schemas = d.schemas;
      }),
    );
    if (!e.defaultDb || !e.dbs.has(e.defaultDb)) e.schemas = await api.introspect(sid);
    this.emit();
    for (const l of this.schemaListeners) l(id);
    const bad = results.find((r) => r.status === "rejected");
    if (bad && bad.status === "rejected") throw bad.reason;
  }
}

export const store = new Store();

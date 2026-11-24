// Connection registry shared by the explorer, consoles and shell.
import { api } from "../api";
import type { ConnectionConfig, SchemaNode, SessionInfo } from "../types";

export type ConnStatus = "idle" | "connecting" | "connected" | "error";

export interface ConnEntry {
  config: ConnectionConfig;
  status: ConnStatus;
  session: SessionInfo | null;
  schemas: SchemaNode[];
  error: string | null;
}

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
        old ? { ...old, config: cfg } : { config: cfg, status: "idle", session: null, schemas: [], error: null },
      );
    }
    for (const [id, e] of this.conns) {
      if (!next.has(id) && e.session) void api.closeSession(e.session.sessionId).catch(() => undefined);
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
      e.schemas = await api.introspect(e.session.sessionId);
      e.status = "connected";
    } catch (err) {
      e.status = "error";
      e.error = err instanceof Error ? err.message : String(err);
      if (e.session) void api.closeSession(e.session.sessionId).catch(() => undefined);
      e.session = null;
      this.emit();
      throw err;
    }
    this.emit();
    for (const l of this.schemaListeners) l(id);
  }

  async disconnect(id: string): Promise<void> {
    const e = this.conns.get(id);
    if (!e) return;
    const s = e.session;
    e.session = null;
    e.status = "idle";
    e.schemas = [];
    e.error = null;
    this.emit();
    if (s) await api.closeSession(s.sessionId).catch(() => undefined);
  }

  async refresh(id: string): Promise<void> {
    const e = this.conns.get(id);
    if (!e || !e.session) return;
    e.schemas = await api.introspect(e.session.sessionId);
    this.emit();
    for (const l of this.schemaListeners) l(id);
  }
}

export const store = new Store();

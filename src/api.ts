// Typed wrappers around Tauri commands. Contract: see CONTRACT.md.
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionConfig,
  DatabaseNode,
  ExportFormat,
  HistoryEntry,
  ObjectGroup,
  QueryResult,
  RowEdit,
  SchemaNode,
  ServerInfo,
  SessionInfo,
  VaultCheck,
} from "./types";

/** Normalizes any thrown value from invoke() into an Error with a readable message. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e: unknown) {
    if (e && typeof e === "object" && "message" in e) {
      throw new Error(String((e as { message: unknown }).message));
    }
    throw new Error(typeof e === "string" ? e : JSON.stringify(e));
  }
}

export const api = {
  listConnections: () => call<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig, password: string | null) =>
    call<ConnectionConfig>("save_connection", { config, password }),
  deleteConnection: (id: string) => call<null>("delete_connection", { id }),
  testConnection: (config: ConnectionConfig, password: string | null, vaultToken: string | null = null) =>
    call<ServerInfo>("test_connection", { config, password, vaultToken }),

  /** database: connect to this database instead of the connection's default (null = default). */
  openSession: (connectionId: string, database: string | null = null) =>
    call<SessionInfo>("open_session", { connectionId, database }),
  /** Databases on the session's server. */
  listDatabases: (sessionId: string) => call<DatabaseNode[]>("list_databases", { sessionId }),
  /** Server-level objects (roles, tablespaces, users, logins…), grouped. */
  listServerObjects: (sessionId: string) => call<ObjectGroup[]>("list_server_objects", { sessionId }),
  closeSession: (sessionId: string) => call<null>("close_session", { sessionId }),
  introspect: (sessionId: string) => call<SchemaNode[]>("introspect", { sessionId }),

  execute: (sessionId: string, sql: string, maxRows: number) =>
    call<QueryResult>("execute", { sessionId, sql, maxRows }),
  cancel: (sessionId: string) => call<null>("cancel", { sessionId }),
  setAutoCommit: (sessionId: string, autoCommit: boolean) =>
    call<null>("set_auto_commit", { sessionId, autoCommit }),
  commit: (sessionId: string) => call<null>("commit", { sessionId }),
  rollback: (sessionId: string) => call<null>("rollback", { sessionId }),
  applyEdits: (sessionId: string, edits: RowEdit[]) =>
    call<number>("apply_edits", { sessionId, edits }),

  listHistory: (connectionId: string | null, search: string | null, limit: number) =>
    call<HistoryEntry[]>("list_history", { connectionId, search, limit }),
  exportQuery: (sessionId: string, sql: string, format: ExportFormat, path: string) =>
    call<number>("export_query", { sessionId, sql, format, path }),

  /** Reads a UTF-8 text file chosen by the user (max 8 MiB). Used by importers. */
  readTextFile: (path: string) => call<string>("read_text_file", { path }),

  /** Resolves the Vault secret for this config and reports what it found (no secrets returned). */
  testVault: (config: ConnectionConfig, vaultToken: string | null) =>
    call<VaultCheck>("test_vault", { config, vaultToken }),
  /** Stores (or with "" clears) the Vault token in the OS keychain for tokenSource "keychain". */
  setVaultToken: (connectionId: string, token: string) =>
    call<null>("set_vault_token", { connectionId, token }),
};

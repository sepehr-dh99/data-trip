// Typed wrappers around Tauri commands. Contract: see CONTRACT.md.
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionConfig,
  DatabaseNode,
  ExportFormat,
  HistoryEntry,
  ObjectGroup,
  QueryResult,
  RedisScanResult,
  KafkaOverview,
  KafkaTopicDetail,
  KafkaConsumeRequest,
  KafkaConsumeResult,
  KafkaProduceRequest,
  KafkaProduceResult,
  KafkaGroupDetail,
  RedisValue,
  RowEdit,
  SchemaNode,
  ServerInfo,
  SessionInfo,
  VaultCheck,
  VaultProfile,
  VaultTokenInfo,
  ExplorerLayout,
  ExportOptions,
  SshProfile,
  SshCheck,
  ReconnectResult,
  FedSource,
  FedResult,
  AiProviderStatus,
  AiProviderId,
  AiModels,
  AiRequest,
  AiResult,
  UpdateStatus,
  UpdateInfo,
  TextFile,
  FileStat,
  SqlRunOptions,
  SqlRunProgress,
} from "./types";

/** Normalizes any thrown value from invoke() into an Error with a readable message. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e: unknown) {
    if (e && typeof e === "object" && "message" in e) {
      const o = e as { message: unknown; position?: unknown; line?: unknown };
      const err: Error & { position?: number; line?: number } = new Error(String(o.message));
      // v0.15: where a statement failed (1-based character offset / line of the executed SQL).
      if (typeof o.position === "number") err.position = o.position;
      if (typeof o.line === "number") err.line = o.line;
      throw err;
    }
    throw new Error(typeof e === "string" ? e : JSON.stringify(e));
  }
}

export const api = {
  listConnections: () => call<ConnectionConfig[]>("list_connections"),
  /** sentinelPassword (Redis Sentinel): null = keep the stored one, "" = clear. */
  saveConnection: (config: ConnectionConfig, password: string | null, sentinelPassword: string | null = null) =>
    call<ConnectionConfig>("save_connection", { config, password, sentinelPassword }),
  deleteConnection: (id: string) => call<null>("delete_connection", { id }),
  /** sentinelPassword: typed sentinel password (null = the stored one). */
  testConnection: (config: ConnectionConfig, password: string | null, vaultToken: string | null = null, sentinelPassword: string | null = null) =>
    call<ServerInfo>("test_connection", { config, password, vaultToken, sentinelPassword }),

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

  /** Redis: one SCAN step on the session's database. pattern uses Redis glob syntax ("*" = all). */
  redisScan: (sessionId: string, pattern: string, cursor: string, count: number, keyType: string | null) =>
    call<RedisScanResult>("redis_scan", { sessionId, pattern, cursor, count, keyType }),
  /** Redis: a key's value, first `limit` elements for collections. */
  redisGet: (sessionId: string, key: string, limit: number) =>
    call<RedisValue>("redis_get", { sessionId, key, limit }),
  /** Redis: delete keys (UNLINK); returns how many existed. Refused on read-only connections. */
  redisDelete: (sessionId: string, keys: string[]) => call<number>("redis_delete", { sessionId, keys }),
  /** Redis: set TTL in seconds, or null to persist (remove expiry). Refused on read-only connections. */
  redisSetTtl: (sessionId: string, key: string, ttl: number | null) =>
    call<null>("redis_set_ttl", { sessionId, key, ttl }),

  /** Kafka: brokers, topics (internal ones only if config.kafka.showInternal) and consumer groups. */
  kafkaOverview: (sessionId: string) => call<KafkaOverview>("kafka_overview", { sessionId }),
  kafkaTopic: (sessionId: string, topic: string) => call<KafkaTopicDetail>("kafka_topic", { sessionId, topic }),
  /** Reads messages without joining or committing any consumer group. */
  kafkaConsume: (sessionId: string, request: KafkaConsumeRequest) =>
    call<KafkaConsumeResult>("kafka_consume", { sessionId, request }),
  /** Refused on read-only connections. */
  kafkaProduce: (sessionId: string, request: KafkaProduceRequest) =>
    call<KafkaProduceResult>("kafka_produce", { sessionId, request }),
  kafkaGroup: (sessionId: string, groupId: string) => call<KafkaGroupDetail>("kafka_group", { sessionId, groupId }),
  /** Reset a group's committed offsets for one topic. Group must be Empty. to: "earliest"|"latest"|"timestamp"|"offset". Refused on read-only. */
  kafkaResetOffsets: (sessionId: string, groupId: string, topic: string, to: string, value: number | null) =>
    call<number>("kafka_reset_offsets", { sessionId, groupId, topic, to, value }),
  kafkaCreateTopic: (sessionId: string, topic: string, partitions: number, replicationFactor: number) =>
    call<null>("kafka_create_topic", { sessionId, topic, partitions, replicationFactor }),
  kafkaDeleteTopic: (sessionId: string, topic: string) => call<null>("kafka_delete_topic", { sessionId, topic }),

  // ── Explorer layout (order, folder color/icon) ──
  getExplorerLayout: () => call<ExplorerLayout>("get_explorer_layout"),
  saveExplorerLayout: (layout: ExplorerLayout) => call<null>("save_explorer_layout", { layout }),

  // ── Shared Vault profiles ──
  listVaultProfiles: () => call<VaultProfile[]>("list_vault_profiles"),
  /** token: null = keep stored token, "" = clear, otherwise store (keychain source). Returns the saved profile (id filled). */
  saveVaultProfile: (profile: VaultProfile, token: string | null) =>
    call<VaultProfile>("save_vault_profile", { profile, token }),
  deleteVaultProfile: (id: string) => call<null>("delete_vault_profile", { id }),
  /** Looks up the token (auth/token/lookup-self). token overrides the stored one (to check before saving). */
  vaultTokenInfo: (profile: VaultProfile, token: string | null) =>
    call<VaultTokenInfo>("vault_token_info", { profile, token }),
  renewVaultToken: (profileId: string) => call<VaultTokenInfo>("renew_vault_token", { profileId }),

  // ── Shared SSH tunnels ──
  listSshProfiles: () => call<SshProfile[]>("list_ssh_profiles"),
  /** secret = key passphrase or password; null = keep, "" = clear. */
  saveSshProfile: (profile: SshProfile, secret: string | null) =>
    call<SshProfile>("save_ssh_profile", { profile, secret }),
  deleteSshProfile: (id: string) => call<null>("delete_ssh_profile", { id }),
  /** Connects to the SSH server, checks the host key and (if trusted) authenticates. Never opens a tunnel. */
  testSshProfile: (profile: SshProfile, secret: string | null) =>
    call<SshCheck>("test_ssh_profile", { profile, secret }),
  /** Stores host:port → fingerprint as trusted (after the user confirms it). */
  trustSshHost: (host: string, port: number, fingerprint: string) =>
    call<null>("trust_ssh_host", { host, port, fingerprint }),

  /** Re-runs `sql` without a row limit and streams it to `path` in the chosen text format. Returns rows written. */
  exportQueryWith: (sessionId: string, sql: string, options: ExportOptions, path: string) =>
    call<number>("export_query_with", { sessionId, sql, options, path }),
  /** Writes UTF-8 text to a user-chosen path (max 512 MiB). Used to save already-loaded results. */
  writeTextFile: (path: string, content: string) => call<null>("write_text_file", { path, content }),

  /** Reads a UTF-8 text file chosen by the user (max 8 MiB). Used by importers. */
  readTextFile: (path: string) => call<string>("read_text_file", { path }),

  /** Resolves the Vault secret for this config and reports what it found (no secrets returned). */
  testVault: (config: ConnectionConfig, vaultToken: string | null) =>
    call<VaultCheck>("test_vault", { config, vaultToken }),
  /** Stores (or with "" clears) the Vault token in the OS keychain for tokenSource "keychain". */
  setVaultToken: (connectionId: string, token: string) =>
    call<null>("set_vault_token", { connectionId, token }),

  // ── v0.10 ──
  /** Raw settings object from <config>/settings.json ({} when none). Shape owned by src/ui/settings.ts. */
  getSettings: () => call<Record<string, unknown>>("get_settings"),
  saveSettings: (settings: Record<string, unknown>) => call<null>("save_settings", { settings }),
  /** Drops and re-opens every open session of a connection (fresh Vault credentials / SSH forward). */
  reconnectConnection: (connectionId: string) => call<ReconnectResult>("reconnect_connection", { connectionId }),
  /** Runs one SELECT across several data sources (see CONTRACT.md v0.10). */
  federatedExecute: (sources: FedSource[], sql: string, maxRows: number) =>
    call<FedResult>("federated_execute", { sources, sql, maxRows }),
  /** Browser OIDC sign-in for a Vault profile; resolves when the callback arrives (5 min timeout). */
  vaultOidcLogin: (profileId: string, role: string | null) =>
    call<VaultTokenInfo>("vault_oidc_login", { profileId, role }),
  vaultOidcCancel: () => call<null>("vault_oidc_cancel"),

  // ── v0.11 ──
  /** Raw workspace object from <config>/workspace.json ({} when none). Shape owned by src/ui/workspace.ts. */
  getWorkspace: () => call<Record<string, unknown>>("get_workspace"),
  saveWorkspace: (workspace: Record<string, unknown>) => call<null>("save_workspace", { workspace }),
  /** Deletes history older than `days` days (0 = keep forever, no-op). Returns the deleted count. */
  pruneHistory: (days: number) => call<number>("prune_history", { days }),
  /** Deletes the history of one connection, or all history when null. Returns the deleted count. */
  clearHistory: (connectionId: string | null) => call<number>("clear_history", { connectionId }),
  /** Number of history entries (one connection, or all when null). */
  countHistory: (connectionId: string | null) => call<number>("count_history", { connectionId }),

  // ── v0.12: AI assistant ──
  /** Which AI providers are installed / configured / running. */
  aiProviders: () => call<AiProviderStatus[]>("ai_providers"),
  /** One generation (write / fix / explain / refine). Never executes anything. Cancelled → error "AI_CANCELLED: …". */
  aiGenerate: (request: AiRequest) => call<AiResult>("ai_generate", { request }),
  aiCancel: () => call<null>("ai_cancel"),
  /** Stores (or with null clears) the OpenAI-compatible API key in the keychain; it is never read back. */
  aiSetApiKey: (key: string | null) => call<null>("ai_set_api_key", { key }),
  /** v0.15: the provider's model catalog (cached 10 min by the backend; refresh = reload). Never rejects for provider problems (see `error`). */
  aiModels: (provider: AiProviderId, baseUrl: string | null = null, refresh = false) => call<AiModels>("ai_models", { provider, baseUrl, refresh }),
  // ── v0.14: in-app updates ──
  updateStatus: () => call<UpdateStatus>("update_status"),
  updateCheck: (includePre: boolean) => call<UpdateInfo | null>("update_check", { includePre }),
  updateDownload: () => call<null>("update_download"),
  updateInstall: (restart: boolean) => call<null>("update_install", { restart }),
  updateOpenPage: (url: string) => call<null>("update_open_page", { url }),
  // ── v0.15: SQL files ──
  /** Reads a text file for a console (max 8 MiB; larger → error "FILE_TOO_LARGE: …"). */
  sqlFileRead: (path: string) => call<TextFile>("sql_file_read", { path }),
  /** Atomic write; with expectedMtimeMs a file changed on disk meanwhile → error "FILE_CHANGED: …". */
  sqlFileWrite: (path: string, text: string, expectedMtimeMs: number | null, bom = false) =>
    call<{ mtimeMs: number }>("sql_file_write", { path, text, expectedMtimeMs, bom }),
  /** Modification time and size; null when the file doesn't exist. */
  fileMtime: (path: string) => call<FileStat | null>("file_mtime", { path }),
  /** Runs a script file statement by statement (events "sqlfile-progress"); resolves with the final progress. */
  runSqlFile: (sessionId: string, path: string, options: SqlRunOptions, runId: string) =>
    call<SqlRunProgress>("run_sql_file", { sessionId, path, options, runId }),
  runSqlFileCancel: (runId: string) => call<null>("run_sql_file_cancel", { runId }),
};

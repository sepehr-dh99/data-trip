// IPC contract types. Mirrors src-tauri/src/model.rs. Do not change shapes without updating both sides.

export type Driver = "postgres" | "mysql" | "sqlite" | "mssql" | "redis" | "kafka";

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: Driver;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  filePath?: string | null;
  sslMode?: "disable" | "prefer" | "require" | "verify-ca" | "verify-full" | null;
  trustServerCertificate?: boolean;
  /** PEM CA bundle for verify-ca / verify-full (PostgreSQL, MySQL). */
  sslCaPath?: string | null;
  /** Client certificate / key for mutual TLS (PostgreSQL, MySQL). */
  sslCertPath?: string | null;
  sslKeyPath?: string | null;
  /** Connect through this shared SSH tunnel (SshProfile.id). */
  sshProfileId?: string | null;
  color?: string | null;
  /** Built-in explorer icon name (e.g. "globe"); null = driver badge. */
  icon?: string | null;
  readOnly?: boolean;
  /** How credentials are obtained. Default "password" (OS keychain). */
  authMethod?: AuthMethod;
  /** Required when authMethod === "vault". */
  vault?: VaultConfig | null;
  /** Explorer folder this data source is grouped under (e.g. "Production"); null = top level. */
  folder?: string | null;
  /** Which databases/schemas the explorer shows. null = everything. */
  scope?: ExplorerScope | null;
  /** Kafka only. `host` holds the bootstrap servers ("b1:9092,b2:9092"); username/password are SASL creds. */
  kafka?: KafkaConfig | null;
}

/** Explorer visibility for one data source (stored with the connection, UI-only). */
export interface ExplorerScope {
  /** Visible databases; null = all. */
  databases: string[] | null;
  /** Per database: visible schemas; a database missing here shows all its schemas. */
  schemas: Record<string, string[]>;
  /** Show databases that appear on the server later. */
  showNew: boolean;
}

export type AuthMethod = "password" | "vault";

/** file = ~/.vault-token (as written by `vault login`), env = VAULT_TOKEN, keychain = set via setVaultToken */
export type VaultTokenSource = "file" | "env" | "keychain";

/** HashiCorp Vault credential source: KV v1, KV v2 (<mount>/data/<path>) or dynamic engines (database/creds/<role>). */
export interface VaultConfig {
  address?: string | null;
  namespace?: string | null;
  tokenSource?: VaultTokenSource;
  tokenFile?: string | null;
  secretPath: string;
  usernameKey?: string | null;
  passwordKey?: string | null;
  caCertPath?: string | null;
  skipTlsVerify?: boolean;
  /** Shared Vault profile; when set, address/namespace/token/TLS come from the profile. */
  profileId?: string | null;
}

/** A shared Vault login (e.g. "Prod Vault"). The token is kept in the OS keychain, never returned. */
export interface VaultProfile {
  id: string;
  name: string;
  address?: string | null;
  namespace?: string | null;
  /** keychain = pasted token · file = read tokenFile each use · env = VAULT_TOKEN */
  tokenSource?: VaultTokenSource;
  tokenFile?: string | null;
  caCertPath?: string | null;
  skipTlsVerify?: boolean;
  color?: string | null;
}

export interface VaultTokenInfo {
  displayName: string | null;
  policies: string[];
  /** Remaining seconds; 0 = never expires. */
  ttlSecs: number;
  expireTime: string | null;
  renewable: boolean;
}

/** A shared SSH tunnel (bastion). Passphrase/password live in the OS keychain. */
export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port?: number | null;
  user: string;
  /** "key" (default) | "password" | "agent" */
  authMethod?: "key" | "password" | "agent" | null;
  privateKeyPath?: string | null;
  keepaliveSecs?: number | null;
}

export interface SshCheck {
  fingerprint: string;
  keyType: string;
  hostKeyStatus: "trusted" | "new" | "changed";
  authenticated: boolean;
}

/** Result of testVault — never includes secrets. */
export interface VaultCheck {
  username: string | null;
  secretKind: "kv2" | "kv1" | "dynamic";
  leaseDurationSecs: number | null;
  renewable: boolean;
}

export interface ServerInfo {
  version: string;
}

export interface SessionInfo {
  sessionId: string;
  connectionId: string;
  driver: Driver;
  serverVersion: string;
  defaultSchema: string | null;
  /** Database this session is connected to. */
  database: string | null;
}

/** A database on the server (PG/MSSQL catalogs, MySQL databases, SQLite "main"). */
export interface DatabaseNode {
  name: string;
  isCurrent: boolean;
  isSystem: boolean;
  sizeBytes: number | null;
  comment: string | null;
}

/** Group of server-level objects shown under "Server objects" (Roles, Tablespaces, Users, Logins…). */
export interface ObjectGroup {
  label: string;
  items: ObjectItem[];
  error: string | null;
}

export interface ObjectItem {
  name: string;
  detail: string | null;
}

export type Cell = null | boolean | number | string;

export interface ColumnMeta {
  name: string;
  typeName: string;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Cell[][];
  rowsAffected: number | null;
  truncated: boolean;
  elapsedMs: number;
  statement: string;
}

export interface ColumnNode {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
}

export type TableKind = "table" | "view" | "materialized";

export interface TableNode {
  name: string;
  kind: TableKind;
  columns: ColumnNode[];
  primaryKey: string[];
  indexes: IndexNode[];
  foreignKeys: ForeignKeyNode[];
  comment: string | null;
}

export interface IndexNode {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeyNode {
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
}

export type RoutineKind = "function" | "procedure";

export interface RoutineNode {
  name: string;
  kind: RoutineKind;
  arguments: string | null;
  returnType: string | null;
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
  routines: RoutineNode[];
  sequences: string[];
}

export type EditKind = "insert" | "update" | "delete";

export interface RowEdit {
  kind: EditKind;
  schema: string | null;
  table: string;
  key: Record<string, Cell>;
  changes: Record<string, Cell>;
  columnTypes: Record<string, string>;
}

export interface HistoryEntry {
  id: number;
  connectionId: string;
  sql: string;
  executedAt: string;
  elapsedMs: number;
  rows: number | null;
  ok: boolean;
  error: string | null;
}

export type ExportFormat = "csv" | "json";

export interface AppError {
  message: string;
}

export const DEFAULT_PORTS: Record<Driver, number | null> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: null,
  mssql: 1433,
  redis: 6379,
  kafka: 9092,
};

export const DRIVER_LABELS: Record<Driver, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  sqlite: "SQLite",
  mssql: "SQL Server",
  redis: "Redis",
  kafka: "Kafka",
};

// ── Redis ───────────────────────────────────────────────────────────────────

export interface RedisKey {
  key: string;
  /** "string" | "hash" | "list" | "set" | "zset" | "stream" | "ReJSON-RL" | other */
  keyType: string;
  /** Seconds to live; null = no expiry. */
  ttl: number | null;
}

export interface RedisScanResult {
  /** Pass to the next call; "0" when complete. */
  cursor: string;
  keys: RedisKey[];
  done: boolean;
}

/** A key's value. `value` shape by type:
 *  string/ReJSON-RL: string · hash: {field,value}[] · list/set: string[] ·
 *  zset: {member,score}[] · stream: {id, fields: Record<string,string>}[] */
export interface RedisValue {
  key: string;
  keyType: string;
  ttl: number | null;
  size: number | null;
  memoryBytes: number | null;
  value: unknown;
  truncated: boolean;
}

// ── Kafka ───────────────────────────────────────────────────────────────────

export interface KafkaConfig {
  /** "plaintext" | "ssl" | "sasl_plaintext" | "sasl_ssl" */
  securityProtocol?: string | null;
  /** "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512" | "OAUTHBEARER" */
  saslMechanism?: string | null;
  caCertPath?: string | null;
  clientCertPath?: string | null;
  clientKeyPath?: string | null;
  skipTlsVerify?: boolean;
  showInternal?: boolean;
}
export interface KafkaBroker { id: number; host: string; port: number; isController: boolean; }
export interface KafkaTopicInfo { name: string; partitions: number; replicationFactor: number; internal: boolean; }
export interface KafkaGroupInfo { groupId: string; state: string; protocolType: string; members: number; }
export interface KafkaOverview { clusterId: string | null; brokers: KafkaBroker[]; topics: KafkaTopicInfo[]; groups: KafkaGroupInfo[]; }
export interface KafkaPartitionInfo { id: number; leader: number; replicas: number[]; isr: number[]; low: number; high: number; }
export interface KafkaConfigEntry { name: string; value: string | null; isDefault: boolean; }
export interface KafkaTopicDetail { name: string; internal: boolean; partitions: KafkaPartitionInfo[]; messageCount: number; configs: KafkaConfigEntry[]; }
export interface KafkaHeader { key: string; value: string | null; }
export interface KafkaMessage {
  partition: number; offset: number; timestampMs: number | null;
  key: string | null; value: string | null; headers: KafkaHeader[];
  keySize: number; valueSize: number; valueTruncated: boolean;
}
export type KafkaFrom = "latest" | "earliest" | "timestamp" | "offset" | "positions";
export interface KafkaConsumeRequest {
  topic: string; partition?: number | null; from: KafkaFrom;
  timestampMs?: number | null; offset?: number | null; positions?: Record<number, number> | null;
  limit: number; keyContains?: string | null; valueContains?: string | null; timeoutMs?: number | null;
}
export interface KafkaConsumeResult { messages: KafkaMessage[]; nextPositions: Record<number, number>; reachedEnd: boolean; scanned: number; }
export interface KafkaProduceRequest { topic: string; partition?: number | null; key?: string | null; value?: string | null; headers: KafkaHeader[]; }
export interface KafkaProduceResult { partition: number; offset: number; }
export interface KafkaGroupMember { memberId: string; clientId: string; host: string; assignments: string[]; }
export interface KafkaGroupOffset { topic: string; partition: number; committed: number | null; end: number; lag: number | null; }
export interface KafkaGroupDetail { groupId: string; state: string; protocol: string; members: KafkaGroupMember[]; offsets: KafkaGroupOffset[]; totalLag: number; }

// ── Explorer layout ─────────────────────────────────────────────────────────

export interface FolderMeta {
  name: string;
  color?: string | null;
  /** Built-in icon name; null = folder icon. */
  icon?: string | null;
}

/** Stored in <config>/explorer_layout.json. Items missing from the lists are appended alphabetically. */
export interface ExplorerLayout {
  /** Top-level order: "folder:<name>" and "conn:<id>" entries. */
  order: string[];
  /** Folder name -> connection ids in display order. */
  folderOrder: Record<string, string[]>;
  folders: FolderMeta[];
}

// IPC contract types. Mirrors src-tauri/src/model.rs. Do not change shapes without updating both sides.

export type Driver = "postgres" | "mysql" | "sqlite" | "mssql";

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: Driver;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  filePath?: string | null;
  sslMode?: "disable" | "prefer" | "require" | null;
  trustServerCertificate?: boolean;
  color?: string | null;
  readOnly?: boolean;
  /** How credentials are obtained. Default "password" (OS keychain). */
  authMethod?: AuthMethod;
  /** Required when authMethod === "vault". */
  vault?: VaultConfig | null;
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
};

export const DRIVER_LABELS: Record<Driver, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  sqlite: "SQLite",
  mssql: "SQL Server",
};

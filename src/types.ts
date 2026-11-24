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

export type TableKind = "table" | "view";

export interface TableNode {
  name: string;
  kind: TableKind;
  columns: ColumnNode[];
  primaryKey: string[];
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
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

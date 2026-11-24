//! IPC contract types. Mirrors `src/types.ts`. Do not change shapes without updating both sides.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Sqlite,
    Mssql,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub driver: Driver,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    /// SQLite file path.
    #[serde(default)]
    pub file_path: Option<String>,
    /// "disable" | "prefer" | "require" (Postgres/MySQL); MSSQL: "require" => encrypt, else trust-cert off-encrypt.
    #[serde(default)]
    pub ssl_mode: Option<String>,
    /// MSSQL only: trust server certificate.
    #[serde(default)]
    pub trust_server_certificate: bool,
    /// Accent colour shown in the UI, e.g. "#ff5f57".
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    /// How credentials are obtained. Default: stored password (OS keychain).
    #[serde(default)]
    pub auth_method: AuthMethod,
    /// Required when `auth_method == Vault`.
    #[serde(default)]
    pub vault: Option<VaultConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    #[default]
    Password,
    Vault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultTokenSource {
    /// Read the token from a file (default `~/.vault-token`, as written by `vault login`).
    #[default]
    File,
    /// Read the `VAULT_TOKEN` environment variable.
    Env,
    /// Token stored in the OS keychain via `set_vault_token`.
    Keychain,
}

/// HashiCorp Vault credential source. Works with KV v1, KV v2 (`<mount>/data/<path>`)
/// and dynamic secrets engines such as `database/creds/<role>`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    /// e.g. "https://vault.example.com:8200". Falls back to the VAULT_ADDR env var.
    #[serde(default)]
    pub address: Option<String>,
    /// Vault Enterprise namespace (X-Vault-Namespace).
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub token_source: VaultTokenSource,
    /// Used when token_source == File. Default "~/.vault-token".
    #[serde(default)]
    pub token_file: Option<String>,
    /// Path after /v1/, e.g. "secret/data/db/prod" or "database/creds/readonly".
    #[serde(default)]
    pub secret_path: String,
    /// Key holding the username in the secret's data. Default "username".
    #[serde(default)]
    pub username_key: Option<String>,
    /// Key holding the password in the secret's data. Default "password".
    #[serde(default)]
    pub password_key: Option<String>,
    /// Optional PEM CA bundle for a private Vault CA.
    #[serde(default)]
    pub ca_cert_path: Option<String>,
    #[serde(default)]
    pub skip_tls_verify: bool,
}

/// Result of `test_vault`: never contains the password or token.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCheck {
    pub username: Option<String>,
    /// "kv2" | "kv1" | "dynamic"
    pub secret_kind: String,
    pub lease_duration_secs: Option<u64>,
    pub renewable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub connection_id: String,
    pub driver: Driver,
    pub server_version: String,
    /// Default schema for unqualified names (e.g. "public", "dbo", current MySQL database, "main").
    pub default_schema: Option<String>,
    /// Database this session is connected to (PG/MSSQL catalog, MySQL current database, SQLite "main").
    #[serde(default)]
    pub database: Option<String>,
}

/// A database on the server (PostgreSQL/SQL Server catalogs, MySQL databases, SQLite "main").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseNode {
    pub name: String,
    /// True for the database the session is connected to.
    pub is_current: bool,
    /// System databases (MySQL mysql/sys/information_schema/performance_schema, MSSQL master/model/msdb/tempdb).
    #[serde(default)]
    pub is_system: bool,
    #[serde(default)]
    pub size_bytes: Option<i64>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// A generic group of server-level objects for the explorer's "Server objects" folder,
/// e.g. { label: "Roles", items: [...] }, { label: "Tablespaces", items: [...] }.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectGroup {
    pub label: String,
    pub items: Vec<ObjectItem>,
    /// Set when the group could not be read (e.g. permission denied); items is then empty.
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectItem {
    pub name: String,
    /// Short secondary text, e.g. "superuser · login", "owner postgres".
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: Option<u64>,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub statement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnNode {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
    /// PostgreSQL materialized view.
    Materialized,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNode {
    pub name: String,
    pub kind: TableKind,
    pub columns: Vec<ColumnNode>,
    pub primary_key: Vec<String>,
    #[serde(default)]
    pub indexes: Vec<IndexNode>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyNode>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexNode {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyNode {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutineKind {
    Function,
    Procedure,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineNode {
    pub name: String,
    pub kind: RoutineKind,
    /// Argument list as text, e.g. "(p_id integer, p_name text)".
    #[serde(default)]
    pub arguments: Option<String>,
    #[serde(default)]
    pub return_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<TableNode>,
    #[serde(default)]
    pub routines: Vec<RoutineNode>,
    #[serde(default)]
    pub sequences: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditKind {
    Insert,
    Update,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowEdit {
    pub kind: EditKind,
    pub schema: Option<String>,
    pub table: String,
    /// Primary-key column -> original value. Used for Update/Delete WHERE clause.
    #[serde(default)]
    pub key: BTreeMap<String, serde_json::Value>,
    /// Column -> new value. Used for Insert/Update.
    #[serde(default)]
    pub changes: BTreeMap<String, serde_json::Value>,
    /// Column -> declared data type (from introspection), for every column in key and changes.
    #[serde(default)]
    pub column_types: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub sql: String,
    pub executed_at: String,
    pub elapsed_ms: i64,
    pub rows: Option<i64>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

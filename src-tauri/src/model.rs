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
    Redis,
    Kafka,
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
    /// PEM CA bundle for verify-ca / verify-full (PostgreSQL, MySQL).
    #[serde(default)]
    pub ssl_ca_path: Option<String>,
    /// Client certificate / key for mutual TLS (PostgreSQL, MySQL).
    #[serde(default)]
    pub ssl_cert_path: Option<String>,
    #[serde(default)]
    pub ssl_key_path: Option<String>,
    /// Connect through this shared SSH tunnel (SshProfile.id). The DB host/port are resolved on the SSH server.
    #[serde(default)]
    pub ssh_profile_id: Option<String>,
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
    /// Explorer folder this data source is grouped under (e.g. "Production"); None = top level.
    #[serde(default)]
    pub folder: Option<String>,
    /// Which databases/schemas the explorer shows for this data source. None = everything.
    #[serde(default)]
    pub scope: Option<ExplorerScope>,
    /// Kafka only. `host` holds the bootstrap servers ("b1:9092,b2:9092"); `username`/password are SASL creds.
    #[serde(default)]
    pub kafka: Option<KafkaConfig>,
}

/// Explorer visibility for one data source (UI-only; the backend just stores it).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerScope {
    /// Visible databases; None = all databases.
    #[serde(default)]
    pub databases: Option<Vec<String>>,
    /// Per database: visible schemas. A database missing here shows all its schemas.
    #[serde(default)]
    pub schemas: std::collections::BTreeMap<String, Vec<String>>,
    /// Whether databases that appear on the server later are shown automatically.
    #[serde(default)]
    pub show_new: bool,
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
    /// When set, address / namespace / token / TLS settings come from this shared Vault profile and the
    /// fields above (except secret_path, username_key, password_key) are ignored.
    #[serde(default)]
    pub profile_id: Option<String>,
}

/// A shared Vault login used by many connections (e.g. "Prod Vault", "Stage Vault").
/// The token itself is stored in the OS keychain (service "DataTrip-VaultProfile", user = id), never in JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultProfile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    /// Keychain = the pasted token; File = read token_file on every use; Env = VAULT_TOKEN.
    #[serde(default)]
    pub token_source: VaultTokenSource,
    #[serde(default)]
    pub token_file: Option<String>,
    #[serde(default)]
    pub ca_cert_path: Option<String>,
    #[serde(default)]
    pub skip_tls_verify: bool,
    /// Accent shown in the UI.
    #[serde(default)]
    pub color: Option<String>,
}

/// From `auth/token/lookup-self`. Never contains the token.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTokenInfo {
    pub display_name: Option<String>,
    pub policies: Vec<String>,
    /// Remaining seconds; 0 = never expires (root / no TTL).
    pub ttl_secs: i64,
    /// ISO 8601, when Vault reports one.
    pub expire_time: Option<String>,
    pub renewable: bool,
}

/// A shared SSH tunnel configuration (bastion / jump host). Secrets (key passphrase or password) live in the
/// OS keychain (service "DataTrip-SSH", user = id).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    pub user: String,
    /// "key" (default) | "password" | "agent"
    #[serde(default)]
    pub auth_method: Option<String>,
    /// Private key path for "key" auth, e.g. "~/.ssh/id_ed25519". OpenSSH and PEM formats.
    #[serde(default)]
    pub private_key_path: Option<String>,
    /// Connection keep-alive interval in seconds (default 30).
    #[serde(default)]
    pub keepalive_secs: Option<u64>,
}

/// Result of `test_ssh_profile`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCheck {
    /// "SHA256:…" fingerprint of the server host key.
    pub fingerprint: String,
    pub key_type: String,
    /// "trusted" (matches a stored key) | "new" (never seen: the UI asks the user, then calls trust_ssh_host)
    /// | "changed" (differs from the stored key — possible MITM; refuse until the user re-trusts explicitly).
    pub host_key_status: String,
    /// Set only when the host key is trusted and authentication succeeded.
    pub authenticated: bool,
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

// ── Redis ────────────────────────────────────────────────────────────────────

/// One key from a Redis SCAN, with its type and TTL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKey {
    pub key: String,
    /// "string" | "hash" | "list" | "set" | "zset" | "stream" | "ReJSON-RL" | other TYPE reply.
    pub key_type: String,
    /// Seconds to live; None = no expiry.
    pub ttl: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanResult {
    /// Cursor to pass to the next call; "0" when the scan is complete.
    pub cursor: String,
    pub keys: Vec<RedisKey>,
    pub done: bool,
}

/// A key's value, shaped by type:
/// - string / ReJSON-RL: `value` = string
/// - hash: `value` = [{ "field": string, "value": string }]
/// - list: `value` = [string]            (index = position + offset 0)
/// - set:  `value` = [string]
/// - zset: `value` = [{ "member": string, "score": number|string }]  (ascending by score)
/// - stream: `value` = [{ "id": string, "fields": { name: value } }] (oldest first)
/// Binary-unsafe bytes are rendered as "0x…" hex like SQL binary cells.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisValue {
    pub key: String,
    pub key_type: String,
    pub ttl: Option<i64>,
    /// Element count (STRLEN for strings, HLEN/LLEN/SCARD/ZCARD/XLEN otherwise).
    pub size: Option<i64>,
    /// Approximate memory in bytes (MEMORY USAGE), when permitted.
    pub memory_bytes: Option<i64>,
    pub value: serde_json::Value,
    /// True when only the first `limit` elements (or 1 MiB of a string) were returned.
    pub truncated: bool,
}

// ── Kafka ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConfig {
    /// "plaintext" | "ssl" | "sasl_plaintext" | "sasl_ssl" (librdkafka security.protocol). Default "plaintext".
    #[serde(default)]
    pub security_protocol: Option<String>,
    /// "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512" | "OAUTHBEARER". Default "PLAIN" when SASL is used.
    #[serde(default)]
    pub sasl_mechanism: Option<String>,
    /// PEM CA bundle path.
    #[serde(default)]
    pub ca_cert_path: Option<String>,
    /// mTLS client certificate / key (PEM).
    #[serde(default)]
    pub client_cert_path: Option<String>,
    #[serde(default)]
    pub client_key_path: Option<String>,
    #[serde(default)]
    pub skip_tls_verify: bool,
    /// Show internal topics (__consumer_offsets, _schemas, …). Default false.
    #[serde(default)]
    pub show_internal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaBroker {
    pub id: i32,
    pub host: String,
    pub port: i32,
    pub is_controller: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaTopicInfo {
    pub name: String,
    pub partitions: i32,
    pub replication_factor: i32,
    pub internal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaGroupInfo {
    pub group_id: String,
    /// "Stable" | "Empty" | "PreparingRebalance" | "CompletingRebalance" | "Dead" | other.
    pub state: String,
    pub protocol_type: String,
    pub members: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaOverview {
    pub cluster_id: Option<String>,
    pub brokers: Vec<KafkaBroker>,
    pub topics: Vec<KafkaTopicInfo>,
    pub groups: Vec<KafkaGroupInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaPartitionInfo {
    pub id: i32,
    pub leader: i32,
    pub replicas: Vec<i32>,
    pub isr: Vec<i32>,
    /// Low / high watermarks (earliest available offset, next offset to be written).
    pub low: i64,
    pub high: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConfigEntry {
    pub name: String,
    pub value: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaTopicDetail {
    pub name: String,
    pub internal: bool,
    pub partitions: Vec<KafkaPartitionInfo>,
    /// Sum over partitions of (high - low). Approximate for compacted topics.
    pub message_count: i64,
    pub configs: Vec<KafkaConfigEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaHeader {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaMessage {
    pub partition: i32,
    pub offset: i64,
    /// Epoch milliseconds, if the record has a timestamp.
    pub timestamp_ms: Option<i64>,
    /// UTF-8 text, or "0x…" hex for binary; None = null key/value.
    pub key: Option<String>,
    pub value: Option<String>,
    pub headers: Vec<KafkaHeader>,
    pub key_size: i64,
    pub value_size: i64,
    /// Value cut at 256 KiB.
    pub value_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConsumeRequest {
    pub topic: String,
    /// None = all partitions.
    #[serde(default)]
    pub partition: Option<i32>,
    /// "latest" (the newest `limit` messages) | "earliest" | "timestamp" | "offset" | "positions".
    pub from: String,
    #[serde(default)]
    pub timestamp_ms: Option<i64>,
    /// With from == "offset": start offset in `partition` (or every partition).
    #[serde(default)]
    pub offset: Option<i64>,
    /// With from == "positions": partition -> next offset to read (from a previous result; used to follow).
    #[serde(default)]
    pub positions: Option<std::collections::BTreeMap<i32, i64>>,
    pub limit: u32,
    #[serde(default)]
    pub key_contains: Option<String>,
    #[serde(default)]
    pub value_contains: Option<String>,
    /// Max time to wait for messages. Default 3000.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConsumeResult {
    /// Sorted by timestamp then partition/offset; newest last.
    pub messages: Vec<KafkaMessage>,
    /// partition -> next offset after what was read (pass back as `positions` to follow).
    pub next_positions: std::collections::BTreeMap<i32, i64>,
    /// True when every requested partition reached its high watermark.
    pub reached_end: bool,
    /// Messages scanned (including those dropped by the key/value filters).
    pub scanned: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaProduceRequest {
    pub topic: String,
    #[serde(default)]
    pub partition: Option<i32>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub headers: Vec<KafkaHeader>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaProduceResult {
    pub partition: i32,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaGroupMember {
    pub member_id: String,
    pub client_id: String,
    pub host: String,
    /// "topic:0,1,2" style summary per topic.
    pub assignments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaGroupOffset {
    pub topic: String,
    pub partition: i32,
    /// None = no committed offset.
    pub committed: Option<i64>,
    pub end: i64,
    pub lag: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaGroupDetail {
    pub group_id: String,
    pub state: String,
    pub protocol: String,
    pub members: Vec<KafkaGroupMember>,
    pub offsets: Vec<KafkaGroupOffset>,
    pub total_lag: i64,
}

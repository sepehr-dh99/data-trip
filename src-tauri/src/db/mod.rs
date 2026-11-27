//! Driver abstraction: `DbConn` over the four supported databases plus shared helpers
//! (identifier quoting, value conversion, edit SQL building, schema assembly).

use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnMeta, ColumnNode, ConnectionConfig, DatabaseNode, Driver, EditKind, ForeignKeyNode,
    IndexNode, ObjectGroup, ObjectItem, QueryResult, RoutineKind, RoutineNode, RowEdit, SchemaNode,
    TableKind, TableNode,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

pub mod kafka;
pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod sqlite;

// ---------------------------------------------------------------------------
// Streaming interface
// ---------------------------------------------------------------------------

/// Receives the first result set of a statement, row by row.
pub trait RowSink: Send {
    fn columns(&mut self, cols: &[ColumnMeta]) -> AppResult<()>;
    /// Return Ok(false) to stop reading further rows.
    fn row(&mut self, row: Vec<Value>) -> AppResult<bool>;
}

pub struct StreamEnd {
    /// Rows affected by a statement that returned no result set (None when unknown).
    pub rows_affected: Option<u64>,
    pub stopped_early: bool,
}

/// Collects up to `max_rows` rows in memory.
pub struct Collector {
    pub max_rows: usize,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
}

impl RowSink for Collector {
    fn columns(&mut self, cols: &[ColumnMeta]) -> AppResult<()> {
        if self.columns.is_empty() {
            self.columns = cols.to_vec();
        }
        Ok(())
    }

    fn row(&mut self, row: Vec<Value>) -> AppResult<bool> {
        if self.rows.len() >= self.max_rows {
            self.truncated = true;
            return Ok(false);
        }
        self.rows.push(row);
        Ok(true)
    }
}

/// Collects every row as optional text (used for catalog queries and scalars).
pub struct TextRows {
    pub rows: Vec<Vec<Option<String>>>,
}

impl TextRows {
    pub fn new() -> Self {
        TextRows { rows: Vec::new() }
    }
}

impl RowSink for TextRows {
    fn columns(&mut self, _cols: &[ColumnMeta]) -> AppResult<()> {
        Ok(())
    }

    fn row(&mut self, row: Vec<Value>) -> AppResult<bool> {
        self.rows
            .push(row.iter().map(value_to_opt_string).collect());
        Ok(true)
    }
}

pub fn value_to_opt_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Connection enum
// ---------------------------------------------------------------------------

pub enum DbConn {
    Postgres(sqlx::PgConnection),
    Mysql(sqlx::MySqlConnection),
    Sqlite(sqlx::SqliteConnection),
    Mssql(tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>),
    Redis(self::redis::RedisConn),
    Kafka(self::kafka::KafkaConn),
}

pub struct Connected {
    pub conn: DbConn,
    pub server_version: String,
    pub default_schema: Option<String>,
    /// Database the connection landed in (PG current_database(), MySQL DATABASE(), MSSQL DB_NAME(), SQLite "main").
    pub database: Option<String>,
    /// Server-side connection/process id (Postgres pid, MySQL connection id).
    pub backend_id: Option<i64>,
    /// SSH forward this connection runs through; released when dropped. Set by the credentials layer.
    pub tunnel: Option<crate::ssh::ForwardLease>,
}

/// Connects with a 15 second timeout.
pub fn connect<'a>(
    cfg: &'a ConnectionConfig,
    password: Option<&'a str>,
) -> futures::future::BoxFuture<'a, AppResult<Connected>> {
    Box::pin(async move {
        let fut = async {
            match cfg.driver {
                Driver::Postgres => postgres::connect(cfg, password).await,
                Driver::Mysql => mysql::connect(cfg, password).await,
                Driver::Sqlite => sqlite::connect(cfg).await,
                Driver::Mssql => mssql::connect(cfg, password).await,
                Driver::Redis => self::redis::connect(cfg, password).await,
                Driver::Kafka => self::kafka::connect(cfg, password).await,
            }
        };
        match tokio::time::timeout(Duration::from_secs(15), fut).await {
            Ok(r) => r,
            Err(_) => Err(AppError::new("Connection timed out after 15 seconds")),
        }
    })
}

/// Server-side cancel of the running statement, using a fresh short-lived connection.
pub fn cancel_backend<'a>(
    cfg: &'a ConnectionConfig,
    password: Option<&'a str>,
    backend_id: i64,
) -> futures::future::BoxFuture<'a, AppResult<()>> {
    Box::pin(async move {
        let fut = async {
            match cfg.driver {
                Driver::Postgres => postgres::cancel(cfg, password, backend_id).await,
                Driver::Mysql => mysql::cancel(cfg, password, backend_id).await,
                _ => Err(AppError::new("Server-side cancel is not supported")),
            }
        };
        match tokio::time::timeout(Duration::from_secs(10), fut).await {
            Ok(r) => r,
            Err(_) => Err(AppError::new("Cancel request timed out")),
        }
    })
}

impl DbConn {
    pub fn driver(&self) -> Driver {
        match self {
            DbConn::Postgres(_) => Driver::Postgres,
            DbConn::Mysql(_) => Driver::Mysql,
            DbConn::Sqlite(_) => Driver::Sqlite,
            DbConn::Mssql(_) => Driver::Mssql,
            DbConn::Redis(_) => Driver::Redis,
            DbConn::Kafka(_) => Driver::Kafka,
        }
    }

    /// Graceful close where cheap; otherwise the connection is simply dropped.
    pub fn close(self) -> futures::future::BoxFuture<'static, ()> {
        Box::pin(async move {
            match self {
                DbConn::Postgres(c) => postgres::close(c).await,
                DbConn::Mysql(c) => mysql::close(c).await,
                DbConn::Sqlite(c) => sqlite::close(c).await,
                DbConn::Mssql(c) => drop(c),
                DbConn::Redis(c) => drop(c),
                DbConn::Kafka(c) => kafka::close(c).await,
            }
        })
    }

    /// Streams the first result set of a single statement into `sink`.
    pub fn stream<'a>(
        &'a mut self,
        sql: &'a str,
        sink: &'a mut dyn RowSink,
    ) -> futures::future::BoxFuture<'a, AppResult<StreamEnd>> {
        Box::pin(async move {
            match self {
                DbConn::Postgres(c) => postgres::stream(c, sql, sink).await,
                DbConn::Mysql(c) => mysql::stream(c, sql, sink).await,
                DbConn::Sqlite(c) => sqlite::stream(c, sql, sink).await,
                DbConn::Mssql(c) => mssql::stream(c, sql, sink).await,
                DbConn::Redis(c) => self::redis::stream(c, sql, sink).await,
                DbConn::Kafka(c) => self::kafka::stream(c, sql, sink).await,
            }
        })
    }

    /// Runs one statement and collects up to `max_rows` rows.
    pub fn execute<'a>(
        &'a mut self,
        sql: &'a str,
        max_rows: usize,
    ) -> futures::future::BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let started = Instant::now();
            let mut collector = Collector {
                max_rows,
                columns: Vec::new(),
                rows: Vec::new(),
                truncated: false,
            };
            // MySQL reports "near '…' at line N": turn it into a character position of this statement.
            let end = self
                .stream(sql, &mut collector)
                .await
                .map_err(|e| e.locate_in(sql))?;
            let rows_affected = if collector.columns.is_empty() {
                end.rows_affected
            } else {
                None
            };
            Ok(QueryResult {
                columns: collector.columns,
                rows: collector.rows,
                rows_affected,
                truncated: collector.truncated,
                elapsed_ms: started.elapsed().as_millis() as u64,
                statement: sql.trim().to_string(),
            })
        })
    }

    /// Runs a statement and discards any result (BEGIN/COMMIT/ROLLBACK/SET...).
    pub fn run_simple<'a>(
        &'a mut self,
        sql: &'a str,
    ) -> futures::future::BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            match self {
                DbConn::Postgres(c) => postgres::run_simple(c, sql).await,
                DbConn::Mysql(c) => mysql::run_simple(c, sql).await,
                DbConn::Sqlite(c) => sqlite::run_simple(c, sql).await,
                DbConn::Mssql(c) => mssql::run_simple(c, sql).await,
                // No transactions: BEGIN/COMMIT/ROLLBACK are never issued for Redis.
                DbConn::Redis(_) | DbConn::Kafka(_) => Ok(()),
            }
        })
    }

    pub fn introspect<'a>(
        &'a mut self,
    ) -> futures::future::BoxFuture<'a, AppResult<Vec<SchemaNode>>> {
        Box::pin(async move {
            match self {
                DbConn::Postgres(c) => postgres::introspect(c).await,
                DbConn::Mysql(c) => mysql::introspect(c).await,
                DbConn::Sqlite(c) => sqlite::introspect(c).await,
                DbConn::Mssql(c) => mssql::introspect(c).await,
                DbConn::Redis(_) | DbConn::Kafka(_) => Ok(Vec::new()),
            }
        })
    }

    pub fn list_databases<'a>(
        &'a mut self,
    ) -> futures::future::BoxFuture<'a, AppResult<Vec<DatabaseNode>>> {
        Box::pin(async move {
            if let DbConn::Redis(c) = self {
                // Numeric order, not alphabetical: keep as returned.
                return self::redis::list_databases(c).await;
            }
            let mut dbs = match self {
                DbConn::Postgres(c) => postgres::list_databases(c).await?,
                DbConn::Mysql(c) => mysql::list_databases(c).await?,
                DbConn::Sqlite(c) => sqlite::list_databases(c).await?,
                DbConn::Mssql(c) => mssql::list_databases(c).await?,
                DbConn::Redis(_) | DbConn::Kafka(_) => Vec::new(),
            };
            sort_databases(&mut dbs);
            Ok(dbs)
        })
    }

    pub fn list_server_objects<'a>(
        &'a mut self,
    ) -> futures::future::BoxFuture<'a, AppResult<Vec<ObjectGroup>>> {
        Box::pin(async move {
            match self {
                DbConn::Postgres(c) => postgres::list_server_objects(c).await,
                DbConn::Mysql(c) => mysql::list_server_objects(c).await,
                DbConn::Sqlite(_) => Ok(Vec::new()),
                DbConn::Mssql(c) => mssql::list_server_objects(c).await,
                DbConn::Redis(c) => self::redis::list_server_objects(c).await,
                DbConn::Kafka(c) => self::kafka::list_server_objects(c).await,
            }
        })
    }

    fn redis_conn(&mut self) -> AppResult<&mut self::redis::RedisConn> {
        match self {
            DbConn::Redis(c) => Ok(c),
            _ => Err(AppError::new("This operation is only available for Redis")),
        }
    }

    pub fn redis_scan<'a>(
        &'a mut self,
        pattern: &'a str,
        cursor: &'a str,
        count: u32,
        key_type: Option<&'a str>,
    ) -> futures::future::BoxFuture<'a, AppResult<crate::model::RedisScanResult>> {
        Box::pin(async move {
            let c = self.redis_conn()?;
            self::redis::scan(c, pattern, cursor, count, key_type).await
        })
    }

    pub fn redis_get<'a>(
        &'a mut self,
        key: &'a str,
        limit: usize,
    ) -> futures::future::BoxFuture<'a, AppResult<crate::model::RedisValue>> {
        Box::pin(async move {
            let c = self.redis_conn()?;
            self::redis::get(c, key, limit).await
        })
    }

    pub fn redis_delete<'a>(
        &'a mut self,
        keys: &'a [String],
    ) -> futures::future::BoxFuture<'a, AppResult<u64>> {
        Box::pin(async move {
            let c = self.redis_conn()?;
            self::redis::delete(c, keys).await
        })
    }

    pub fn redis_set_ttl<'a>(
        &'a mut self,
        key: &'a str,
        ttl: Option<i64>,
    ) -> futures::future::BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            let c = self.redis_conn()?;
            self::redis::set_ttl(c, key, ttl).await
        })
    }

    fn kafka_conn(&mut self) -> AppResult<&mut self::kafka::KafkaConn> {
        match self {
            DbConn::Kafka(c) => Ok(c),
            _ => Err(AppError::new("This operation is only available for Kafka")),
        }
    }

    pub fn kafka_overview<'a>(
        &'a mut self,
    ) -> futures::future::BoxFuture<'a, AppResult<crate::model::KafkaOverview>> {
        Box::pin(async move {
            let c = self.kafka_conn()?;
            self::kafka::overview(c).await
        })
    }

    pub fn kafka_topic<'a>(
        &'a mut self,
        topic: &'a str,
    ) -> futures::future::BoxFuture<'a, AppResult<crate::model::KafkaTopicDetail>> {
        Box::pin(async move {
            let c = self.kafka_conn()?;
            self::kafka::topic(c, topic).await
        })
    }

    pub fn kafka_consume<'a>(
        &'a mut self,
        req: crate::model::KafkaConsumeRequest,
    ) -> futures::future::BoxFuture<'a, AppResult<crate::model::KafkaConsumeResult>> {
        Box::pin(async move {
            let c = self.kafka_conn()?;
            self::kafka::consume(c, req).await
        })
    }

    pub fn kafka_produce<'a>(
        &'a mut self,
        req: crate::model::KafkaProduceRequest,
    ) -> futures::future::BoxFuture<'a, AppResult<crate::model::KafkaProduceResult>> {
        Box::pin(async move {
            let c = self.kafka_conn()?;
            self::kafka::produce(c, req).await
        })
    }

    pub fn kafka_group<'a>(
        &'a mut self,
        group: &'a str,
    ) -> futures::future::BoxFuture<'a, AppResult<crate::model::KafkaGroupDetail>> {
        Box::pin(async move {
            let c = self.kafka_conn()?;
            self::kafka::group(c, group).await
        })
    }

    pub fn kafka_reset_offsets<'a>(
        &'a mut self,
        group: &'a str,
        topic: &'a str,
        to: &'a str,
        value: Option<i64>,
    ) -> futures::future::BoxFuture<'a, AppResult<u64>> {
        Box::pin(async move {
            let c = self.kafka_conn()?;
            self::kafka::reset_offsets(c, group, topic, to, value).await
        })
    }

    pub fn kafka_create_topic<'a>(
        &'a mut self,
        topic: &'a str,
        partitions: i32,
        replication: i32,
    ) -> futures::future::BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            let c = self.kafka_conn()?;
            self::kafka::create_topic(c, topic, partitions, replication).await
        })
    }

    pub fn kafka_delete_topic<'a>(
        &'a mut self,
        topic: &'a str,
    ) -> futures::future::BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            let c = self.kafka_conn()?;
            self::kafka::delete_topic(c, topic).await
        })
    }

    fn exec_edit<'a>(
        &'a mut self,
        sql: &'a str,
        params: &'a [Value],
    ) -> futures::future::BoxFuture<'a, AppResult<u64>> {
        Box::pin(async move {
            match self {
                DbConn::Postgres(c) => postgres::exec_params(c, sql, params).await,
                DbConn::Mysql(c) => mysql::exec_params(c, sql, params).await,
                DbConn::Sqlite(c) => sqlite::exec_params(c, sql, params).await,
                DbConn::Mssql(c) => mssql::exec_params(c, sql, params).await,
                DbConn::Redis(_) => Err(AppError::new("Row edits are not supported for Redis")),
                DbConn::Kafka(_) => Err(AppError::new("Row edits are not supported for Kafka")),
            }
        })
    }

    /// Applies all edits atomically. `in_manual_tx`: a user transaction is already open, so a
    /// savepoint is used instead of BEGIN/COMMIT.
    pub fn apply_edits<'a>(
        &'a mut self,
        edits: &'a [RowEdit],
        in_manual_tx: bool,
    ) -> futures::future::BoxFuture<'a, AppResult<u64>> {
        Box::pin(async move {
            let d = self.driver();
            let mut built: Vec<(String, Vec<Value>)> = Vec::new();
            for e in edits {
                built.push(build_edit(d, e)?);
            }
            if built.is_empty() {
                return Ok(0);
            }
            if in_manual_tx {
                self.run_simple(savepoint_sql(d)).await?;
            } else {
                self.run_simple(begin_sql(d)).await?;
            }
            let mut total: u64 = 0;
            for (sql, params) in &built {
                match self.exec_edit(sql, params).await {
                    Ok(n) => total += n,
                    Err(e) => {
                        self.rollback_edits(in_manual_tx).await;
                        return Err(e);
                    }
                }
            }
            if in_manual_tx {
                if let Some(r) = release_sql(d) {
                    self.run_simple(r).await?;
                }
            } else {
                self.run_simple(commit_sql(d)).await?;
            }
            Ok(total)
        })
    }

    fn rollback_edits<'a>(&'a mut self, in_manual_tx: bool) -> futures::future::BoxFuture<'a, ()> {
        Box::pin(async move {
            let d = self.driver();
            if in_manual_tx {
                let _ = self.run_simple(rollback_to_sql(d)).await;
                if let Some(r) = release_sql(d) {
                    let _ = self.run_simple(r).await;
                }
            } else {
                let _ = self.run_simple(rollback_sql(d)).await;
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Transaction statements
// ---------------------------------------------------------------------------

pub fn begin_sql(d: Driver) -> &'static str {
    match d {
        Driver::Postgres => "BEGIN",
        Driver::Mysql => "START TRANSACTION",
        Driver::Sqlite => "BEGIN",
        Driver::Mssql => "BEGIN TRANSACTION",
        Driver::Redis | Driver::Kafka => "",
    }
}

pub fn commit_sql(d: Driver) -> &'static str {
    match d {
        Driver::Mssql => "COMMIT TRANSACTION",
        _ => "COMMIT",
    }
}

pub fn rollback_sql(d: Driver) -> &'static str {
    match d {
        Driver::Mssql => "ROLLBACK TRANSACTION",
        _ => "ROLLBACK",
    }
}

fn savepoint_sql(d: Driver) -> &'static str {
    match d {
        Driver::Mssql => "SAVE TRANSACTION dt_edits",
        _ => "SAVEPOINT dt_edits",
    }
}

fn release_sql(d: Driver) -> Option<&'static str> {
    match d {
        Driver::Mssql => None,
        _ => Some("RELEASE SAVEPOINT dt_edits"),
    }
}

fn rollback_to_sql(d: Driver) -> &'static str {
    match d {
        Driver::Mssql => "ROLLBACK TRANSACTION dt_edits",
        _ => "ROLLBACK TO SAVEPOINT dt_edits",
    }
}

// ---------------------------------------------------------------------------
// Identifier quoting
// ---------------------------------------------------------------------------

pub fn quote_ident(d: Driver, name: &str) -> String {
    match d {
        Driver::Mysql => format!("`{}`", name.replace('`', "``")),
        Driver::Mssql => format!("[{}]", name.replace(']', "]]")),
        Driver::Postgres | Driver::Sqlite | Driver::Redis | Driver::Kafka => {
            format!("\"{}\"", name.replace('"', "\"\""))
        }
    }
}

pub fn qualified_name(d: Driver, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.trim().is_empty() => {
            format!("{}.{}", quote_ident(d, s), quote_ident(d, table))
        }
        _ => quote_ident(d, table),
    }
}

// ---------------------------------------------------------------------------
// Edit SQL building
// ---------------------------------------------------------------------------

struct ParamBuilder {
    driver: Driver,
    vals: Vec<Value>,
}

impl ParamBuilder {
    /// Registers a value and returns its placeholder text.
    fn push(&mut self, v: &Value, col_type: Option<&str>) -> AppResult<String> {
        let v = match self.driver {
            Driver::Postgres => v.clone(),
            _ => coerce_int_param(v, col_type),
        };
        self.vals.push(v);
        let n = self.vals.len();
        Ok(match self.driver {
            Driver::Postgres => match col_type {
                Some(t) if !t.trim().is_empty() => {
                    if t.contains(';') || t.contains("--") || t.contains("/*") {
                        return Err(AppError::new(format!("Invalid column type: {}", t)));
                    }
                    format!("CAST(${} AS {})", n, t.trim())
                }
                _ => format!("${}", n),
            },
            Driver::Mysql | Driver::Sqlite | Driver::Redis | Driver::Kafka => "?".to_string(),
            Driver::Mssql => format!("@P{}", n),
        })
    }
}

/// Integer columns may arrive as exact strings (see `int_value`). Bind them as integers:
/// MySQL compares a string with an integer column as DOUBLE, which can match the wrong rows.
fn coerce_int_param(v: &Value, col_type: Option<&str>) -> Value {
    let s = match v {
        Value::String(s) => s,
        _ => return v.clone(),
    };
    let upper = col_type.unwrap_or("").trim().to_uppercase();
    let base: String = upper
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    if !is_int_name(&base) {
        return v.clone();
    }
    let t = s.trim();
    if let Ok(i) = t.parse::<i64>() {
        return Value::from(i);
    }
    if let Ok(u) = t.parse::<u64>() {
        return Value::from(u);
    }
    v.clone()
}

/// Builds one parameterized statement for a row edit.
pub fn build_edit(d: Driver, e: &RowEdit) -> AppResult<(String, Vec<Value>)> {
    let table = qualified_name(d, e.schema.as_deref(), &e.table);
    let mut pb = ParamBuilder {
        driver: d,
        vals: Vec::new(),
    };
    let ty = |col: &str| -> Option<String> { e.column_types.get(col).cloned() };

    match e.kind {
        EditKind::Insert => {
            if e.changes.is_empty() {
                let sql = match d {
                    Driver::Mysql => format!("INSERT INTO {} () VALUES ()", table),
                    _ => format!("INSERT INTO {} DEFAULT VALUES", table),
                };
                return Ok((sql, pb.vals));
            }
            let mut cols: Vec<String> = Vec::new();
            let mut vals: Vec<String> = Vec::new();
            for (c, v) in &e.changes {
                cols.push(quote_ident(d, c));
                if v.is_null() {
                    vals.push("NULL".to_string());
                } else {
                    vals.push(pb.push(v, ty(c).as_deref())?);
                }
            }
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                table,
                cols.join(", "),
                vals.join(", ")
            );
            Ok((sql, pb.vals))
        }
        EditKind::Update => {
            if e.key.is_empty() {
                return Err(AppError::new(
                    "Cannot update a row without a key (table has no primary key?)",
                ));
            }
            if e.changes.is_empty() {
                return Err(AppError::new("Update has no changes"));
            }
            let mut sets: Vec<String> = Vec::new();
            for (c, v) in &e.changes {
                if v.is_null() {
                    sets.push(format!("{} = NULL", quote_ident(d, c)));
                } else {
                    let p = pb.push(v, ty(c).as_deref())?;
                    sets.push(format!("{} = {}", quote_ident(d, c), p));
                }
            }
            let wh = build_where(d, e, &mut pb)?;
            let sql = format!("UPDATE {} SET {} WHERE {}", table, sets.join(", "), wh);
            Ok((sql, pb.vals))
        }
        EditKind::Delete => {
            if e.key.is_empty() {
                return Err(AppError::new(
                    "Cannot delete a row without a key (table has no primary key?)",
                ));
            }
            let wh = build_where(d, e, &mut pb)?;
            let sql = format!("DELETE FROM {} WHERE {}", table, wh);
            Ok((sql, pb.vals))
        }
    }
}

fn build_where(d: Driver, e: &RowEdit, pb: &mut ParamBuilder) -> AppResult<String> {
    let mut parts: Vec<String> = Vec::new();
    for (c, v) in &e.key {
        if v.is_null() {
            parts.push(format!("{} IS NULL", quote_ident(d, c)));
        } else {
            let ty = e.column_types.get(c).cloned();
            let p = pb.push(v, ty.as_deref())?;
            parts.push(format!("{} = {}", quote_ident(d, c), p));
        }
    }
    Ok(parts.join(" AND "))
}

/// Text form of a JSON value for binding as a Postgres text parameter.
pub fn value_to_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b {
            "true".to_string()
        } else {
            "false".to_string()
        }),
        other => Some(other.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

/// Hex form of binary data, truncated to 4096 bytes.
pub fn hex_value(bytes: &[u8]) -> Value {
    const LIMIT: usize = 4096;
    if bytes.len() > LIMIT {
        Value::String(format!("0x{}\u{2026}", hex::encode(&bytes[..LIMIT])))
    } else {
        Value::String(format!("0x{}", hex::encode(bytes)))
    }
}

/// Largest integer a JavaScript number holds exactly (2^53 - 1).
const MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

/// Integer cell: a JSON number when the frontend can represent it exactly, else an exact string
/// (a bigint key rounded by JSON.parse would make edits target the wrong row).
pub fn int_value(i: i64) -> Value {
    if (-MAX_SAFE_INT..=MAX_SAFE_INT).contains(&i) {
        Value::from(i)
    } else {
        Value::String(i.to_string())
    }
}

pub fn float_value(f: f64) -> Value {
    match serde_json::Number::from_f64(f) {
        Some(n) => Value::Number(n),
        None => Value::String(f.to_string()),
    }
}

fn is_int_name(base: &str) -> bool {
    matches!(
        base,
        "TINYINT"
            | "SMALLINT"
            | "MEDIUMINT"
            | "INT"
            | "INTEGER"
            | "BIGINT"
            | "INT2"
            | "INT4"
            | "INT8"
            | "SMALLSERIAL"
            | "SERIAL"
            | "BIGSERIAL"
            | "OID"
            | "YEAR"
    )
}

fn is_float_name(base: &str) -> bool {
    matches!(base, "FLOAT" | "FLOAT4" | "FLOAT8" | "DOUBLE" | "REAL")
}

/// Converts a textual cell (text protocol) to a wire value using the column type name.
pub fn text_to_value(driver: Driver, type_name: &str, text: Option<String>) -> Value {
    let s = match text {
        None => return Value::Null,
        Some(s) => s,
    };
    let upper = type_name.to_uppercase();
    let base = upper.split_whitespace().next().unwrap_or("");

    let mysql_bool = driver == Driver::Mysql && (base == "BOOLEAN" || base == "BOOL");
    if is_int_name(base) || mysql_bool {
        return match s.trim().parse::<i64>() {
            Ok(i) => int_value(i),
            Err(_) => Value::String(s),
        };
    }
    if is_float_name(base) {
        return match s.trim().parse::<f64>() {
            Ok(f) => float_value(f),
            Err(_) => Value::String(s),
        };
    }
    if driver == Driver::Postgres {
        if base == "BOOL" || base == "BOOLEAN" {
            return match s.as_str() {
                "t" | "true" => Value::Bool(true),
                "f" | "false" => Value::Bool(false),
                _ => Value::String(s),
            };
        }
        if base == "BYTEA" {
            if let Some(h) = s.strip_prefix("\\x") {
                if let Ok(bytes) = hex::decode(h) {
                    return hex_value(&bytes);
                }
            }
            return Value::String(s);
        }
    }
    Value::String(s)
}

// ---------------------------------------------------------------------------
// SQL text helpers
// ---------------------------------------------------------------------------

/// Index of the first char after leading whitespace, parentheses, semicolons and comments.
fn skip_leading(b: &[char]) -> usize {
    let len = b.len();
    let mut i = 0usize;
    loop {
        while i < len && (b[i].is_whitespace() || b[i] == '(' || b[i] == ';') {
            i += 1;
        }
        if i + 1 < len && b[i] == '-' && b[i + 1] == '-' {
            while i < len && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if i + 1 < len && b[i] == '/' && b[i + 1] == '*' {
            i += 2;
            while i + 1 < len && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        break;
    }
    i.min(len)
}

/// First keyword of a statement (upper-case), skipping whitespace, parentheses and comments.
pub fn first_keyword(sql: &str) -> String {
    let b: Vec<char> = sql.chars().take(2000).collect();
    let len = b.len();
    let mut i = skip_leading(&b);
    let mut kw = String::new();
    while i < len && b[i].is_alphabetic() {
        kw.extend(b[i].to_uppercase());
        i += 1;
    }
    kw
}

/// First `n` whitespace-separated words of a statement (upper-case), after leading comments.
fn leading_words(sql: &str, n: usize) -> Vec<String> {
    let b: Vec<char> = sql.chars().take(2000).collect();
    let i = skip_leading(&b);
    let rest: String = b[i..].iter().collect();
    rest.split(|c: char| c.is_whitespace() || c == ';')
        .filter(|w| !w.is_empty())
        .take(n)
        .map(|w| w.to_uppercase())
        .collect()
}

/// Effect of a user-typed statement on the session's transaction state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxControl {
    /// BEGIN / START TRANSACTION: a transaction is now open.
    Begin,
    /// COMMIT / ROLLBACK / END: the transaction is over.
    End,
    /// MySQL DDL: implicitly commits, so the transaction is over.
    ImplicitCommit,
}

pub fn tx_control(d: Driver, sql: &str) -> Option<TxControl> {
    let w = leading_words(sql, 4);
    let w0 = w.first().map(String::as_str).unwrap_or("");
    let w1 = w.get(1).map(String::as_str).unwrap_or("");
    let savepoint = w.iter().skip(1).any(|x| x == "TO");
    match w0 {
        "BEGIN" => match d {
            // T-SQL BEGIN alone opens a block (BEGIN ... END / BEGIN TRY), not a transaction.
            Driver::Mssql => {
                matches!(w1, "TRAN" | "TRANSACTION" | "DISTRIBUTED").then_some(TxControl::Begin)
            }
            _ => Some(TxControl::Begin),
        },
        "START" if w1 == "TRANSACTION" => Some(TxControl::Begin),
        "COMMIT" => Some(TxControl::End),
        "END" if matches!(d, Driver::Postgres | Driver::Sqlite) => Some(TxControl::End),
        "ABORT" if d == Driver::Postgres => Some(TxControl::End),
        "ROLLBACK" if !savepoint => {
            // T-SQL: ROLLBACK TRAN <name> rolls back to a savepoint only.
            if d == Driver::Mssql && matches!(w1, "TRAN" | "TRANSACTION") && w.len() > 2 {
                None
            } else {
                Some(TxControl::End)
            }
        }
        "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE"
            if d == Driver::Mysql && w1 != "TEMPORARY" =>
        {
            Some(TxControl::ImplicitCommit)
        }
        _ => None,
    }
}

/// Statements that normally produce a result set.
pub fn is_query_like(kw: &str) -> bool {
    matches!(
        kw,
        "SELECT"
            | "WITH"
            | "SHOW"
            | "VALUES"
            | "TABLE"
            | "EXPLAIN"
            | "DESCRIBE"
            | "DESC"
            | "PRAGMA"
    )
}

// ---------------------------------------------------------------------------
// Schema assembly
// ---------------------------------------------------------------------------

fn cell(r: &[Option<String>], i: usize) -> Option<String> {
    r.get(i).cloned().flatten()
}

pub type CatRow = Vec<Option<String>>;

/// Optional catalog parts, merged into the schema tree by `assemble`.
/// Missing/failed parts are simply empty.
#[derive(Default)]
pub struct CatalogExtras {
    /// Schema names that must appear even when they hold no tables: [schema]
    pub schemas: Vec<String>,
    /// [schema, table, index, unique("1"|"0"), primary("1"|"0"), column] one row per key column, in order.
    pub indexes: Vec<CatRow>,
    /// [schema, table, fk name, column, ref schema, ref table, ref column] one row per column, in order.
    pub fks: Vec<CatRow>,
    /// [schema, table, comment]
    pub comments: Vec<CatRow>,
    /// [schema, name, "function"|"procedure", arguments, return type]
    pub routines: Vec<CatRow>,
    /// [schema, name]
    pub sequences: Vec<CatRow>,
}

#[derive(Default)]
struct SchemaAcc {
    tables: BTreeMap<String, TableNode>,
    routines: Vec<RoutineNode>,
    sequences: Vec<String>,
}

/// Builds the schema tree from catalog rows.
/// `col_rows`: [schema, table, kind("table"|"view"|"materialized"), column, data_type, nullable("1"|"0"), default, ordinal]
/// `pk_rows`:  [schema, table, column] ordered by key position.
pub fn assemble(
    col_rows: &[CatRow],
    pk_rows: &[CatRow],
    extras: &CatalogExtras,
) -> Vec<SchemaNode> {
    let mut map: BTreeMap<String, SchemaAcc> = BTreeMap::new();
    for name in &extras.schemas {
        map.entry(name.clone()).or_default();
    }
    for r in col_rows {
        let schema = cell(r, 0).unwrap_or_default();
        let table = cell(r, 1).unwrap_or_default();
        let kind = match cell(r, 2).as_deref() {
            Some("view") => TableKind::View,
            Some("materialized") => TableKind::Materialized,
            _ => TableKind::Table,
        };
        let col = ColumnNode {
            name: cell(r, 3).unwrap_or_default(),
            data_type: cell(r, 4).unwrap_or_default(),
            nullable: cell(r, 5).as_deref() != Some("0"),
            default_value: cell(r, 6),
        };
        let tables = &mut map.entry(schema).or_default().tables;
        let node = tables.entry(table.clone()).or_insert_with(|| TableNode {
            name: table,
            kind,
            columns: Vec::new(),
            primary_key: Vec::new(),
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            comment: None,
        });
        node.columns.push(col);
    }
    for r in pk_rows {
        let schema = cell(r, 0).unwrap_or_default();
        let table = cell(r, 1).unwrap_or_default();
        let col = cell(r, 2).unwrap_or_default();
        if let Some(t) = map.get_mut(&schema).and_then(|a| a.tables.get_mut(&table)) {
            t.primary_key.push(col);
        }
    }
    for r in &extras.indexes {
        let schema = cell(r, 0).unwrap_or_default();
        let table = cell(r, 1).unwrap_or_default();
        let name = cell(r, 2).unwrap_or_default();
        let col = cell(r, 5).unwrap_or_else(|| "(expression)".to_string());
        if let Some(t) = map.get_mut(&schema).and_then(|a| a.tables.get_mut(&table)) {
            match t.indexes.last_mut() {
                Some(ix) if ix.name == name => ix.columns.push(col),
                _ => t.indexes.push(IndexNode {
                    name,
                    columns: vec![col],
                    unique: cell(r, 3).as_deref() == Some("1"),
                    primary: cell(r, 4).as_deref() == Some("1"),
                }),
            }
        }
    }
    for r in &extras.fks {
        let schema = cell(r, 0).unwrap_or_default();
        let table = cell(r, 1).unwrap_or_default();
        let name = cell(r, 2).unwrap_or_default();
        let col = cell(r, 3).unwrap_or_default();
        let ref_col = cell(r, 6);
        if let Some(t) = map.get_mut(&schema).and_then(|a| a.tables.get_mut(&table)) {
            match t.foreign_keys.last_mut() {
                Some(fk) if fk.name == name => {
                    fk.columns.push(col);
                    if let Some(c) = ref_col {
                        fk.ref_columns.push(c);
                    }
                }
                _ => t.foreign_keys.push(ForeignKeyNode {
                    name,
                    columns: vec![col],
                    ref_schema: cell(r, 4),
                    ref_table: cell(r, 5).unwrap_or_default(),
                    ref_columns: ref_col.into_iter().collect(),
                }),
            }
        }
    }
    for r in &extras.comments {
        let schema = cell(r, 0).unwrap_or_default();
        let table = cell(r, 1).unwrap_or_default();
        let comment = cell(r, 2).filter(|c| !c.trim().is_empty());
        if let Some(t) = map.get_mut(&schema).and_then(|a| a.tables.get_mut(&table)) {
            t.comment = comment;
        }
    }
    for r in &extras.routines {
        let schema = cell(r, 0).unwrap_or_default();
        let kind = if cell(r, 2).as_deref() == Some("procedure") {
            RoutineKind::Procedure
        } else {
            RoutineKind::Function
        };
        map.entry(schema).or_default().routines.push(RoutineNode {
            name: cell(r, 1).unwrap_or_default(),
            kind,
            arguments: cell(r, 3),
            return_type: cell(r, 4),
        });
    }
    for r in &extras.sequences {
        let schema = cell(r, 0).unwrap_or_default();
        map.entry(schema)
            .or_default()
            .sequences
            .push(cell(r, 1).unwrap_or_default());
    }
    map.into_iter()
        .map(|(name, acc)| SchemaNode {
            name,
            tables: acc.tables.into_values().collect(),
            routines: acc.routines,
            sequences: acc.sequences,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Server-level listings
// ---------------------------------------------------------------------------

pub fn truthy(v: Option<&String>) -> bool {
    matches!(
        v.map(|s| s.trim().to_lowercase()).as_deref(),
        Some("1") | Some("t") | Some("true")
    )
}

/// Current first, then user databases A-Z, then system databases A-Z.
pub fn sort_databases(dbs: &mut [DatabaseNode]) {
    dbs.sort_by(|a, b| {
        let rank = |d: &DatabaseNode| -> u8 {
            if d.is_current {
                0
            } else if !d.is_system {
                1
            } else {
                2
            }
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// Builds a server-object group from a query result; an error becomes the group's `error`.
pub fn make_group(
    label: &str,
    res: AppResult<Vec<CatRow>>,
    f: impl Fn(&CatRow) -> Option<ObjectItem>,
) -> ObjectGroup {
    match res {
        Ok(rows) => ObjectGroup {
            label: label.to_string(),
            items: rows.iter().filter_map(|r| f(r)).collect(),
            error: None,
        },
        Err(e) => ObjectGroup {
            label: label.to_string(),
            items: Vec::new(),
            error: Some(e.message),
        },
    }
}

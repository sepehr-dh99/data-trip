//! Redis / Valkey driver (redis-rs 0.27, multiplexed async connection, RESP2).
//!
//! Every `pub fn` that awaits returns a `BoxFuture` built with `Box::pin(async move { .. })`
//! (same pattern as the other drivers) so the spawned session job stays provably `Send`.

use super::{float_value, hex_value, int_value, Connected, DbConn, RowSink, StreamEnd};
use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnMeta, ConnectionConfig, DatabaseNode, ObjectGroup, ObjectItem, RedisKey, RedisScanResult,
    RedisValue,
};
use futures::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// A Redis connection plus the settings the driver needs per command.
pub struct RedisConn {
    conn: ::redis::aio::MultiplexedConnection,
    read_only: bool,
    /// Selected database index.
    db: i64,
}

/// Largest string value returned by `redis_get` (bytes).
const MAX_STRING_BYTES: i64 = 1024 * 1024;
/// Upper bound for one SCAN step.
const MAX_SCAN_COUNT: u32 = 1000;
/// Upper bound for `redis_get` collection limits.
const MAX_LIMIT: usize = 100_000;

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

fn db_index(cfg: &ConnectionConfig) -> AppResult<i64> {
    match cfg.database.as_deref().map(str::trim) {
        None | Some("") => Ok(0),
        Some(s) => match s.parse::<i64>() {
            Ok(n) if n >= 0 => Ok(n),
            _ => Err(AppError::new(format!(
                "Redis database must be a non-negative integer (0-15 by default), got \"{}\"",
                s
            ))),
        },
    }
}

/// Human-readable error text: "CODE detail" for server errors, otherwise redis-rs' own message.
fn err_text(e: &::redis::RedisError) -> String {
    match (e.code(), e.detail()) {
        (Some(code), Some(detail)) => format!("{} {}", code, detail),
        (Some(code), None) => code.to_string(),
        (None, Some(detail)) => detail.to_string(),
        (None, None) => e.to_string(),
    }
}

fn app_err(e: ::redis::RedisError) -> AppError {
    AppError::new(err_text(&e))
}

pub fn connect<'a>(
    cfg: &'a ConnectionConfig,
    password: Option<&'a str>,
) -> BoxFuture<'a, AppResult<Connected>> {
    Box::pin(async move {
        let db = db_index(cfg)?;
        let host = cfg
            .host
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .unwrap_or("127.0.0.1")
            .to_string();
        let port = cfg.port.unwrap_or(6379);
        let tls = cfg.ssl_mode.as_deref() == Some("require");
        let addr = if tls {
            // VERIFY: field set of ConnectionAddr::TcpTls in redis 0.27 (host, port, insecure, tls_params).
            ::redis::ConnectionAddr::TcpTls {
                host,
                port,
                insecure: false,
                tls_params: None,
            }
        } else {
            ::redis::ConnectionAddr::Tcp(host, port)
        };
        let info = ::redis::ConnectionInfo {
            addr,
            // VERIFY: RedisConnectionInfo has `db: i64`, `username`, `password` and implements Default.
            redis: ::redis::RedisConnectionInfo {
                db,
                username: cfg
                    .username
                    .as_deref()
                    .map(str::trim)
                    .filter(|u| !u.is_empty())
                    .map(str::to_string),
                password: password.filter(|p| !p.is_empty()).map(str::to_string),
                ..Default::default()
            },
        };
        let client = ::redis::Client::open(info).map_err(app_err)?;
        // VERIFY: exists in redis 0.27 with features "aio" + "tokio-comp".
        let conn = client
            .get_multiplexed_async_connection()
            .await
            .map_err(app_err)?;
        let mut rc = RedisConn {
            conn,
            read_only: cfg.read_only,
            db,
        };
        let version = match info_map(&mut rc.conn, "server").await {
            Ok(m) => m
                .get("redis_version")
                .or_else(|| m.get("valkey_version"))
                .cloned()
                .unwrap_or_else(|| "Redis".to_string()),
            Err(_) => "Redis".to_string(),
        };
        Ok(Connected {
            conn: DbConn::Redis(rc),
            server_version: version,
            default_schema: None,
            database: Some(db.to_string()),
            backend_id: None,
        })
    })
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

fn make_cmd(name: &str, args: &[&[u8]]) -> ::redis::Cmd {
    let mut c = ::redis::cmd(name);
    for a in args {
        c.arg(*a);
    }
    c
}

/// Runs one command and returns the raw reply.
fn run<'a>(
    conn: &'a mut ::redis::aio::MultiplexedConnection,
    cmd: ::redis::Cmd,
) -> BoxFuture<'a, AppResult<::redis::Value>> {
    Box::pin(async move {
        // VERIFY: query_async's return type is inferred from the annotation (works for both
        // `query_async<T>` and `query_async<C, T>` signatures).
        let v: ::redis::Value = cmd.query_async(conn).await.map_err(app_err)?;
        Ok(v)
    })
}

/// Runs a non-atomic pipeline and returns one reply per command.
fn run_pipe<'a>(
    conn: &'a mut ::redis::aio::MultiplexedConnection,
    pipe: ::redis::Pipeline,
) -> BoxFuture<'a, AppResult<Vec<::redis::Value>>> {
    Box::pin(async move {
        let v: Vec<::redis::Value> = pipe.query_async(conn).await.map_err(app_err)?;
        Ok(v)
    })
}

fn bytes_json(b: &[u8]) -> Value {
    match std::str::from_utf8(b) {
        Ok(s) => Value::String(s.to_string()),
        Err(_) => hex_value(b),
    }
}

fn bytes_text(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => value_text(&bytes_json(b)),
    }
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Text of a scalar reply (bulk/simple string, integer, double, okay).
fn rv_text(v: &::redis::Value) -> Option<String> {
    match v {
        ::redis::Value::BulkString(b) => Some(bytes_text(b)),
        ::redis::Value::SimpleString(s) => Some(s.clone()),
        ::redis::Value::Okay => Some("OK".to_string()),
        ::redis::Value::Int(i) => Some(i.to_string()),
        ::redis::Value::Double(d) => Some(d.to_string()),
        ::redis::Value::VerbatimString { text, .. } => Some(text.clone()),
        _ => None,
    }
}

fn rv_int(v: &::redis::Value) -> Option<i64> {
    match v {
        ::redis::Value::Int(i) => Some(*i),
        ::redis::Value::BulkString(b) => std::str::from_utf8(b).ok()?.trim().parse().ok(),
        ::redis::Value::SimpleString(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn rv_bytes(v: &::redis::Value) -> Option<Vec<u8>> {
    match v {
        ::redis::Value::BulkString(b) => Some(b.clone()),
        ::redis::Value::SimpleString(s) => Some(s.clone().into_bytes()),
        ::redis::Value::Int(i) => Some(i.to_string().into_bytes()),
        _ => None,
    }
}

fn rv_items(v: &::redis::Value) -> Vec<&::redis::Value> {
    match v {
        ::redis::Value::Array(a) | ::redis::Value::Set(a) => a.iter().collect(),
        ::redis::Value::Push { data, .. } => data.iter().collect(),
        _ => Vec::new(),
    }
}

/// Flat [k, v, k, v ...] array or RESP3 map into pairs.
fn rv_pairs(v: &::redis::Value) -> Vec<(&::redis::Value, &::redis::Value)> {
    match v {
        ::redis::Value::Map(m) => m.iter().map(|(k, v)| (k, v)).collect(),
        other => {
            let items = rv_items(other);
            items
                .chunks(2)
                .filter(|c| c.len() == 2)
                .map(|c| (c[0], c[1]))
                .collect()
        }
    }
}

/// Converts any reply to JSON (nested structures stay structured).
fn rv_json(v: &::redis::Value) -> Value {
    match v {
        ::redis::Value::Nil => Value::Null,
        ::redis::Value::Int(i) => int_value(*i),
        ::redis::Value::BulkString(b) => bytes_json(b),
        ::redis::Value::SimpleString(s) => Value::String(s.clone()),
        ::redis::Value::Okay => Value::String("OK".to_string()),
        ::redis::Value::Array(a) | ::redis::Value::Set(a) => {
            Value::Array(a.iter().map(rv_json).collect())
        }
        ::redis::Value::Map(m) => {
            let mut o = serde_json::Map::new();
            for (k, val) in m {
                o.insert(key_string(k), rv_json(val));
            }
            Value::Object(o)
        }
        ::redis::Value::Double(d) => float_value(*d),
        ::redis::Value::Boolean(b) => Value::Bool(*b),
        ::redis::Value::VerbatimString { text, .. } => Value::String(text.clone()),
        ::redis::Value::Attribute { data, .. } => rv_json(data),
        ::redis::Value::Push { data, .. } => Value::Array(data.iter().map(rv_json).collect()),
        // BigNumber, ServerError and anything added later: Debug rendering.
        other => Value::String(format!("{:?}", other)),
    }
}

fn key_string(v: &::redis::Value) -> String {
    match rv_text(v) {
        Some(s) => s,
        None => match rv_json(v) {
            Value::String(s) => s,
            other => other.to_string(),
        },
    }
}

/// Grid cell: scalars stay scalars, nested structures become JSON text.
fn rv_cell(v: &::redis::Value) -> Value {
    match rv_json(v) {
        j @ (Value::Array(_) | Value::Object(_)) => {
            Value::String(serde_json::to_string(&j).unwrap_or_default())
        }
        other => other,
    }
}

// ---------------------------------------------------------------------------
// INFO helpers
// ---------------------------------------------------------------------------

fn parse_info(text: &str) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            m.insert(k.to_string(), v.to_string());
        }
    }
    m
}

fn info_map<'a>(
    conn: &'a mut ::redis::aio::MultiplexedConnection,
    section: &'a str,
) -> BoxFuture<'a, AppResult<BTreeMap<String, String>>> {
    Box::pin(async move {
        let v = run(conn, make_cmd("INFO", &[section.as_bytes()])).await?;
        let text = rv_text(&v).unwrap_or_default();
        Ok(parse_info(&text))
    })
}

// ---------------------------------------------------------------------------
// Command line tokenizer
// ---------------------------------------------------------------------------

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Splits one command line into arguments (redis-cli style).
/// Whitespace separates; "double quotes" support \n \r \t \b \a \\ \" \xHH; 'single quotes' are
/// literal (only \' is an escape).
pub fn tokenize(line: &str) -> AppResult<Vec<Vec<u8>>> {
    let b = line.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    let mut out: Vec<Vec<u8>> = Vec::new();
    loop {
        while i < n && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= n {
            break;
        }
        let mut cur: Vec<u8> = Vec::new();
        match b[i] {
            b'"' => {
                i += 1;
                let mut closed = false;
                while i < n {
                    match b[i] {
                        b'\\' if i + 1 < n => {
                            if b[i + 1] == b'x'
                                && i + 3 < n
                                && hex_digit(b[i + 2]).is_some()
                                && hex_digit(b[i + 3]).is_some()
                            {
                                let hi = hex_digit(b[i + 2]).unwrap_or(0);
                                let lo = hex_digit(b[i + 3]).unwrap_or(0);
                                cur.push(hi * 16 + lo);
                                i += 4;
                            } else {
                                cur.push(match b[i + 1] {
                                    b'n' => b'\n',
                                    b'r' => b'\r',
                                    b't' => b'\t',
                                    b'b' => 8,
                                    b'a' => 7,
                                    other => other,
                                });
                                i += 2;
                            }
                        }
                        b'"' => {
                            closed = true;
                            i += 1;
                            break;
                        }
                        c => {
                            cur.push(c);
                            i += 1;
                        }
                    }
                }
                if !closed {
                    return Err(AppError::new("Unbalanced double quotes in command"));
                }
                if i < n && !b[i].is_ascii_whitespace() {
                    return Err(AppError::new(
                        "A closing quote must be followed by a space or the end of the command",
                    ));
                }
            }
            b'\'' => {
                i += 1;
                let mut closed = false;
                while i < n {
                    match b[i] {
                        b'\\' if i + 1 < n && b[i + 1] == b'\'' => {
                            cur.push(b'\'');
                            i += 2;
                        }
                        b'\'' => {
                            closed = true;
                            i += 1;
                            break;
                        }
                        c => {
                            cur.push(c);
                            i += 1;
                        }
                    }
                }
                if !closed {
                    return Err(AppError::new("Unbalanced single quotes in command"));
                }
                if i < n && !b[i].is_ascii_whitespace() {
                    return Err(AppError::new(
                        "A closing quote must be followed by a space or the end of the command",
                    ));
                }
            }
            _ => {
                while i < n && !b[i].is_ascii_whitespace() {
                    cur.push(b[i]);
                    i += 1;
                }
            }
        }
        out.push(cur);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Command policy
// ---------------------------------------------------------------------------

fn refused_command(name: &str) -> Option<&'static str> {
    match name {
        "MULTI" | "EXEC" | "DISCARD" | "WATCH" | "UNWATCH" => Some(
            "Transactions (MULTI/EXEC/WATCH) are not supported: each command runs on its own.",
        ),
        "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "MONITOR" | "SYNC" | "PSYNC" => Some(
            "Streaming commands (SUBSCRIBE/PSUBSCRIBE/SSUBSCRIBE/MONITOR/SYNC/PSYNC) are not supported in the console.",
        ),
        "SELECT" => Some("SELECT is not supported: pick the database in the explorer instead."),
        _ => None,
    }
}

/// True for commands that modify data or server state (used for read-only mode and rowsAffected).
fn is_write_command(name: &str, args: &[Vec<u8>]) -> bool {
    let sub = args
        .first()
        .map(|a| String::from_utf8_lossy(a).to_uppercase())
        .unwrap_or_default();
    match name {
        "SET" | "SETEX" | "SETNX" | "PSETEX" | "MSET" | "MSETNX" | "APPEND" | "GETSET"
        | "GETDEL" | "GETEX" | "DEL" | "UNLINK" | "PERSIST" | "MOVE" | "COPY" | "RESTORE"
        | "HSET" | "HSETNX" | "HMSET" | "HDEL" | "LPOP" | "RPOP" | "LSET" | "LREM" | "LTRIM"
        | "LINSERT" | "LMOVE" | "BLMOVE" | "RPOPLPUSH" | "BRPOPLPUSH" | "LMPOP" | "BLMPOP"
        | "BLPOP" | "BRPOP" | "SADD" | "SREM" | "SPOP" | "SMOVE" | "ZADD" | "ZINCRBY" | "ZMPOP"
        | "BZMPOP" | "BZPOPMIN" | "BZPOPMAX" | "ZRANGESTORE" | "XADD" | "XDEL" | "XTRIM"
        | "XGROUP" | "XACK" | "XCLAIM" | "XAUTOCLAIM" | "XSETID" | "PFADD" | "PFMERGE"
        | "GEOADD" | "GEOSEARCHSTORE" | "SETRANGE" | "SETBIT" | "BITOP" | "BITFIELD"
        | "FLUSHDB" | "FLUSHALL" | "SWAPDB" | "SCRIPT" | "FUNCTION" | "SHUTDOWN" | "DEBUG"
        | "MIGRATE" | "REPLICAOF" | "SLAVEOF" | "JSON.SET" | "JSON.DEL" | "JSON.FORGET"
        | "JSON.ARRAPPEND" | "JSON.ARRINSERT" | "JSON.ARRPOP" | "JSON.ARRTRIM"
        | "JSON.NUMINCRBY" | "JSON.NUMMULTBY" | "JSON.STRAPPEND" | "JSON.TOGGLE" | "JSON.CLEAR"
        | "JSON.MERGE" | "JSON.MSET" => true,
        "CONFIG" => matches!(sub.as_str(), "SET" | "REWRITE" | "RESETSTAT"),
        "ACL" => !matches!(sub.as_str(), "WHOAMI" | "LIST" | "USERS" | "CAT"),
        "SORT" => args.iter().any(|a| a.eq_ignore_ascii_case(b"STORE")),
        _ => {
            name.starts_with("INCR")
                || name.starts_with("DECR")
                || name.starts_with("EXPIRE")
                || name.starts_with("PEXPIRE")
                || name.starts_with("RENAME")
                || name.starts_with("HINCRBY")
                || name.starts_with("LPUSH")
                || name.starts_with("RPUSH")
                || name.starts_with("ZREM")
                || name.starts_with("ZPOP")
                || name.starts_with("EVAL")
                || name.starts_with("FCALL")
                || (name.starts_with('S') && name.ends_with("STORE"))
                || (name.starts_with('Z') && name.ends_with("STORE"))
        }
    }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

struct Shaped {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<Value>>,
    rows_affected: Option<u64>,
}

fn col(name: &str, type_name: &str) -> ColumnMeta {
    ColumnMeta {
        name: name.to_string(),
        type_name: type_name.to_string(),
    }
}

fn value_type_name(v: &Value) -> &'static str {
    match v {
        Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
        Value::Number(_) => "double",
        Value::Bool(_) => "boolean",
        _ => "text",
    }
}

fn pair_shape(a: &str, b: &str, pairs: Vec<(&::redis::Value, &::redis::Value)>) -> Shaped {
    Shaped {
        columns: vec![col(a, "text"), col(b, "text")],
        rows: pairs
            .into_iter()
            .map(|(k, v)| vec![rv_cell(k), rv_cell(v)])
            .collect(),
        rows_affected: None,
    }
}

/// Maps a reply to grid columns/rows according to the command that produced it.
fn shape_reply(name: &str, args: &[Vec<u8>], write: bool, reply: &::redis::Value) -> Shaped {
    let with_scores = args.iter().any(|a| a.eq_ignore_ascii_case(b"WITHSCORES"));
    match reply {
        ::redis::Value::Int(n) if write => Shaped {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: Some((*n).max(0) as u64),
        },
        ::redis::Value::Map(m) => {
            pair_shape("field", "value", m.iter().map(|(k, v)| (k, v)).collect())
        }
        ::redis::Value::Array(items) => {
            let sub = args
                .first()
                .map(|a| String::from_utf8_lossy(a).to_uppercase())
                .unwrap_or_default();
            let flat_pairs =
                items.len() % 2 == 0 && (name == "HGETALL" || (name == "CONFIG" && sub == "GET"));
            if flat_pairs {
                return pair_shape("field", "value", rv_pairs(reply));
            }
            if with_scores
                && items.len() % 2 == 0
                && matches!(
                    name,
                    "ZRANGE" | "ZREVRANGE" | "ZRANGEBYSCORE" | "ZREVRANGEBYSCORE" | "ZRANGEBYLEX"
                )
            {
                return pair_shape("member", "score", rv_pairs(reply));
            }
            let is_stream = matches!(name, "XRANGE" | "XREVRANGE")
                && items.iter().all(|e| match e {
                    ::redis::Value::Array(p) => {
                        p.len() == 2
                            && matches!(p[1], ::redis::Value::Array(_) | ::redis::Value::Map(_))
                    }
                    _ => false,
                });
            if is_stream {
                let rows = items
                    .iter()
                    .map(|e| {
                        let p = rv_items(e);
                        let id = p.first().map(|v| rv_cell(v)).unwrap_or(Value::Null);
                        let fields = match p.get(1) {
                            Some(f) => {
                                let mut o = serde_json::Map::new();
                                for (k, v) in rv_pairs(f) {
                                    o.insert(key_string(k), rv_json(v));
                                }
                                Value::String(
                                    serde_json::to_string(&Value::Object(o)).unwrap_or_default(),
                                )
                            }
                            None => Value::Null,
                        };
                        vec![id, fields]
                    })
                    .collect();
                return Shaped {
                    columns: vec![col("id", "text"), col("fields", "json")],
                    rows,
                    rows_affected: None,
                };
            }
            let rows: Vec<Vec<Value>> = items.iter().map(|v| vec![rv_cell(v)]).collect();
            let ty = rows
                .first()
                .and_then(|r| r.first())
                .map(value_type_name)
                .unwrap_or("text");
            Shaped {
                columns: vec![col("value", ty)],
                rows,
                rows_affected: None,
            }
        }
        ::redis::Value::Set(items) | ::redis::Value::Push { data: items, .. } => Shaped {
            columns: vec![col("value", "text")],
            rows: items.iter().map(|v| vec![rv_cell(v)]).collect(),
            rows_affected: None,
        },
        other => {
            let cell = rv_cell(other);
            let ty = value_type_name(&cell);
            Shaped {
                columns: vec![col("value", ty)],
                rows: vec![vec![cell]],
                rows_affected: None,
            }
        }
    }
}

/// Parses, checks and runs one command line, pushing the shaped reply into `sink`.
pub fn stream<'a>(
    c: &'a mut RedisConn,
    line: &'a str,
    sink: &'a mut dyn RowSink,
) -> BoxFuture<'a, AppResult<StreamEnd>> {
    Box::pin(async move {
        let mut tokens = tokenize(line)?;
        if tokens.is_empty() {
            return Err(AppError::new("Empty command"));
        }
        let name_bytes = tokens.remove(0);
        let name = match String::from_utf8(name_bytes) {
            Ok(s) => s,
            Err(_) => return Err(AppError::new("Command name must be valid UTF-8")),
        };
        let upper = name.to_uppercase();
        if let Some(msg) = refused_command(&upper) {
            return Err(AppError::new(msg));
        }
        let write = is_write_command(&upper, &tokens);
        if write && c.read_only {
            return Err(AppError::new(format!(
                "This connection is read-only; {} is not allowed",
                upper
            )));
        }
        let mut cmd = ::redis::cmd(&upper);
        for a in &tokens {
            cmd.arg(a.as_slice());
        }
        let reply = run(&mut c.conn, cmd).await?;
        let shaped = shape_reply(&upper, &tokens, write, &reply);
        if shaped.columns.is_empty() {
            return Ok(StreamEnd {
                rows_affected: shaped.rows_affected,
                stopped_early: false,
            });
        }
        sink.columns(&shaped.columns)?;
        let mut stopped = false;
        for r in shaped.rows {
            if !sink.row(r)? {
                stopped = true;
                break;
            }
        }
        Ok(StreamEnd {
            rows_affected: None,
            stopped_early: stopped,
        })
    })
}

// ---------------------------------------------------------------------------
// Key browser
// ---------------------------------------------------------------------------

pub fn scan<'a>(
    c: &'a mut RedisConn,
    pattern: &'a str,
    cursor: &'a str,
    count: u32,
    key_type: Option<&'a str>,
) -> BoxFuture<'a, AppResult<RedisScanResult>> {
    Box::pin(async move {
        let count = count.clamp(1, MAX_SCAN_COUNT).to_string();
        let pattern = if pattern.is_empty() { "*" } else { pattern };
        let cursor = if cursor.trim().is_empty() {
            "0"
        } else {
            cursor.trim()
        };
        let mut cmd = ::redis::cmd("SCAN");
        cmd.arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(count.as_str());
        if let Some(t) = key_type.map(str::trim).filter(|t| !t.is_empty()) {
            cmd.arg("TYPE").arg(t);
        }
        let reply = run(&mut c.conn, cmd).await?;
        let parts = rv_items(&reply);
        let next = parts
            .first()
            .and_then(|v| rv_text(v))
            .unwrap_or_else(|| "0".to_string());
        let mut keys: Vec<Vec<u8>> = parts
            .get(1)
            .map(|v| rv_items(v).into_iter().filter_map(rv_bytes).collect())
            .unwrap_or_default();
        keys.sort();
        keys.dedup();
        let mut out: Vec<RedisKey> = Vec::with_capacity(keys.len());
        if !keys.is_empty() {
            let mut pipe = ::redis::pipe();
            for k in &keys {
                pipe.cmd("TYPE").arg(k.as_slice());
                pipe.cmd("TTL").arg(k.as_slice());
            }
            let res = run_pipe(&mut c.conn, pipe).await?;
            for (i, k) in keys.iter().enumerate() {
                let ty = res.get(i * 2).and_then(rv_text).unwrap_or_default();
                if ty == "none" {
                    continue; // expired or deleted between SCAN and TYPE
                }
                let ttl = res.get(i * 2 + 1).and_then(rv_int).filter(|t| *t >= 0);
                out.push(RedisKey {
                    key: String::from_utf8_lossy(k).into_owned(),
                    key_type: ty,
                    ttl,
                });
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(RedisScanResult {
            done: next == "0",
            cursor: next,
            keys: out,
        })
    })
}

fn size_command(ty: &str) -> Option<&'static str> {
    match ty {
        "string" => Some("STRLEN"),
        "hash" => Some("HLEN"),
        "list" => Some("LLEN"),
        "set" => Some("SCARD"),
        "zset" => Some("ZCARD"),
        "stream" => Some("XLEN"),
        _ => None,
    }
}

fn score_json(v: &::redis::Value) -> Value {
    match v {
        ::redis::Value::Double(d) => float_value(*d),
        ::redis::Value::Int(i) => int_value(*i),
        other => match rv_text(other) {
            Some(s) => match s.trim().parse::<f64>() {
                Ok(f) if f.is_finite() => float_value(f),
                _ => Value::String(s),
            },
            None => Value::Null,
        },
    }
}

/// HSCAN / SSCAN loop collecting up to `limit` entries. Returns (flat items, more_available).
fn scan_loop<'a>(
    conn: &'a mut ::redis::aio::MultiplexedConnection,
    scan_cmd: &'static str,
    key: &'a [u8],
    limit: usize,
    per_item: usize,
) -> BoxFuture<'a, AppResult<(Vec<::redis::Value>, bool)>> {
    Box::pin(async move {
        let mut cursor = "0".to_string();
        let mut items: Vec<::redis::Value> = Vec::new();
        let batch = limit.clamp(10, 1000).to_string();
        let mut more = false;
        for _ in 0..100_000u32 {
            let mut cmd = ::redis::cmd(scan_cmd);
            cmd.arg(key)
                .arg(cursor.as_str())
                .arg("COUNT")
                .arg(batch.as_str());
            let reply = run(conn, cmd).await?;
            let parts = rv_items(&reply);
            cursor = parts
                .first()
                .and_then(|v| rv_text(v))
                .unwrap_or_else(|| "0".to_string());
            if let Some(chunk) = parts.get(1) {
                for it in rv_items(chunk) {
                    items.push(it.clone());
                }
            }
            if items.len() >= limit * per_item {
                more = cursor != "0" || items.len() > limit * per_item;
                items.truncate(limit * per_item);
                break;
            }
            if cursor == "0" {
                break;
            }
        }
        Ok((items, more))
    })
}

pub fn get<'a>(
    c: &'a mut RedisConn,
    key: &'a str,
    limit: usize,
) -> BoxFuture<'a, AppResult<RedisValue>> {
    Box::pin(async move {
        let limit = limit.clamp(1, MAX_LIMIT);
        let k = key.as_bytes();
        let conn = &mut c.conn;
        let ty_reply = run(conn, make_cmd("TYPE", &[k])).await?;
        let ty = rv_text(&ty_reply).unwrap_or_default();
        if ty == "none" {
            return Err(AppError::new(format!("Key \"{}\" does not exist", key)));
        }

        let mut pipe = ::redis::pipe();
        pipe.cmd("TTL").arg(k);
        if let Some(sc) = size_command(&ty) {
            pipe.cmd(sc).arg(k);
        }
        let res = run_pipe(conn, pipe).await?;
        let ttl = res.first().and_then(rv_int).filter(|t| *t >= 0);
        let size = res.get(1).and_then(rv_int);
        let memory_bytes = match run(conn, make_cmd("MEMORY", &[b"USAGE", k])).await {
            Ok(v) => rv_int(&v),
            Err(_) => None,
        };

        let mut truncated = false;
        let value: Value = match ty.as_str() {
            "string" => {
                let big = size.map(|s| s > MAX_STRING_BYTES).unwrap_or(false);
                if big {
                    truncated = true;
                    let end = (MAX_STRING_BYTES - 1).to_string();
                    let v = run(conn, make_cmd("GETRANGE", &[k, b"0", end.as_bytes()])).await?;
                    Value::String(
                        rv_bytes(&v)
                            .map(|b| String::from_utf8_lossy(&b).into_owned())
                            .unwrap_or_default(),
                    )
                } else {
                    let v = run(conn, make_cmd("GET", &[k])).await?;
                    match &v {
                        ::redis::Value::Nil => Value::Null,
                        other => rv_bytes(other)
                            .map(|b| bytes_json(&b))
                            .unwrap_or_else(|| rv_json(other)),
                    }
                }
            }
            "ReJSON-RL" => match run(conn, make_cmd("JSON.GET", &[k])).await {
                Ok(v) => {
                    let mut s = rv_text(&v).unwrap_or_default();
                    if s.len() as i64 > MAX_STRING_BYTES {
                        let mut cut = MAX_STRING_BYTES as usize;
                        while cut > 0 && !s.is_char_boundary(cut) {
                            cut -= 1;
                        }
                        s.truncate(cut);
                        truncated = true;
                    }
                    Value::String(s)
                }
                Err(e) => Value::String(format!("JSON.GET failed: {}", e.message)),
            },
            "hash" => {
                let small = size.map(|s| s as usize <= limit).unwrap_or(false);
                let flat: Vec<::redis::Value> = if small {
                    let v = run(conn, make_cmd("HGETALL", &[k])).await?;
                    rv_pairs(&v)
                        .into_iter()
                        .flat_map(|(a, b)| [a.clone(), b.clone()])
                        .collect()
                } else {
                    let (items, more) = scan_loop(conn, "HSCAN", k, limit, 2).await?;
                    truncated = more;
                    items
                };
                let arr = ::redis::Value::Array(flat);
                let mut rows: Vec<Value> = rv_pairs(&arr)
                    .into_iter()
                    .map(|(f, v)| json!({ "field": value_text(&rv_json(f)), "value": value_text(&rv_json(v)) }))
                    .collect();
                rows.sort_by(|a, b| value_text(&a["field"]).cmp(&value_text(&b["field"])));
                Value::Array(rows)
            }
            "list" => {
                let stop = (limit as i64 - 1).to_string();
                let v = run(conn, make_cmd("LRANGE", &[k, b"0", stop.as_bytes()])).await?;
                truncated = size.map(|s| s as usize > limit).unwrap_or(false);
                Value::Array(rv_items(&v).into_iter().map(rv_json).collect())
            }
            "set" => {
                let small = size.map(|s| s as usize <= limit).unwrap_or(false);
                let items: Vec<::redis::Value> = if small {
                    let v = run(conn, make_cmd("SMEMBERS", &[k])).await?;
                    rv_items(&v).into_iter().cloned().collect()
                } else {
                    let (items, more) = scan_loop(conn, "SSCAN", k, limit, 1).await?;
                    truncated = more;
                    items
                };
                let mut out: Vec<Value> = items.iter().map(rv_json).collect();
                out.sort_by_key(value_text);
                Value::Array(out)
            }
            "zset" => {
                let stop = (limit as i64 - 1).to_string();
                let v = run(
                    conn,
                    make_cmd("ZRANGE", &[k, b"0", stop.as_bytes(), b"WITHSCORES"]),
                )
                .await?;
                truncated = size.map(|s| s as usize > limit).unwrap_or(false);
                Value::Array(
                    rv_pairs(&v)
                        .into_iter()
                        .map(|(m, s)| json!({ "member": rv_json(m), "score": score_json(s) }))
                        .collect(),
                )
            }
            "stream" => {
                let n = limit.to_string();
                let v = run(
                    conn,
                    make_cmd("XRANGE", &[k, b"-", b"+", b"COUNT", n.as_bytes()]),
                )
                .await?;
                truncated = size.map(|s| s as usize > limit).unwrap_or(false);
                let entries: Vec<Value> = rv_items(&v)
                    .into_iter()
                    .map(|e| {
                        let p = rv_items(e);
                        let id = p.first().map(|x| rv_json(x)).unwrap_or(Value::Null);
                        let mut fields = serde_json::Map::new();
                        if let Some(f) = p.get(1) {
                            for (fk, fv) in rv_pairs(f) {
                                fields.insert(key_string(fk), rv_json(fv));
                            }
                        }
                        json!({ "id": id, "fields": Value::Object(fields) })
                    })
                    .collect();
                Value::Array(entries)
            }
            _ => Value::Null,
        };

        Ok(RedisValue {
            key: key.to_string(),
            key_type: ty,
            ttl,
            size,
            memory_bytes,
            value,
            truncated,
        })
    })
}

pub fn delete<'a>(c: &'a mut RedisConn, keys: &'a [String]) -> BoxFuture<'a, AppResult<u64>> {
    Box::pin(async move {
        if c.read_only {
            return Err(AppError::new(
                "This connection is read-only; deleting keys is not allowed",
            ));
        }
        if keys.is_empty() {
            return Ok(0);
        }
        let args: Vec<&[u8]> = keys.iter().map(|k| k.as_bytes()).collect();
        let reply = match run(&mut c.conn, make_cmd("UNLINK", &args)).await {
            Ok(v) => v,
            Err(_) => run(&mut c.conn, make_cmd("DEL", &args)).await?,
        };
        Ok(rv_int(&reply).unwrap_or(0).max(0) as u64)
    })
}

pub fn set_ttl<'a>(
    c: &'a mut RedisConn,
    key: &'a str,
    ttl: Option<i64>,
) -> BoxFuture<'a, AppResult<()>> {
    Box::pin(async move {
        if c.read_only {
            return Err(AppError::new(
                "This connection is read-only; changing a TTL is not allowed",
            ));
        }
        let k = key.as_bytes();
        let reply = match ttl {
            Some(n) => {
                if n <= 0 {
                    return Err(AppError::new("TTL must be a positive number of seconds"));
                }
                let s = n.to_string();
                run(&mut c.conn, make_cmd("EXPIRE", &[k, s.as_bytes()])).await?
            }
            None => run(&mut c.conn, make_cmd("PERSIST", &[k])).await?,
        };
        // EXPIRE returns 0 when the key is missing; PERSIST returns 0 when it had no expiry.
        if ttl.is_some() && rv_int(&reply) == Some(0) {
            return Err(AppError::new(format!("Key \"{}\" does not exist", key)));
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

pub fn list_databases<'a>(c: &'a mut RedisConn) -> BoxFuture<'a, AppResult<Vec<DatabaseNode>>> {
    Box::pin(async move {
        let total = match run(&mut c.conn, make_cmd("CONFIG", &[b"GET", b"databases"])).await {
            Ok(v) => rv_pairs(&v)
                .first()
                .and_then(|(_, val)| rv_int(val))
                .filter(|n| *n > 0)
                .unwrap_or(16),
            Err(_) => 16,
        }
        .min(1024);
        let mut counts: BTreeMap<i64, i64> = BTreeMap::new();
        if let Ok(m) = info_map(&mut c.conn, "keyspace").await {
            for (k, v) in m {
                let idx = match k.strip_prefix("db").and_then(|s| s.parse::<i64>().ok()) {
                    Some(i) => i,
                    None => continue,
                };
                let keys = v
                    .split(',')
                    .find_map(|kv| kv.strip_prefix("keys="))
                    .and_then(|n| n.parse::<i64>().ok())
                    .unwrap_or(0);
                counts.insert(idx, keys);
            }
        }
        let max_idx = counts.keys().next_back().copied().unwrap_or(-1);
        let total = total.max(max_idx + 1).max(c.db + 1);
        Ok((0..total)
            .map(|i| {
                let n = counts.get(&i).copied().unwrap_or(0);
                DatabaseNode {
                    name: i.to_string(),
                    is_current: i == c.db,
                    is_system: false,
                    size_bytes: None,
                    comment: Some(if n == 0 {
                        "empty".to_string()
                    } else {
                        format!("{} keys", n)
                    }),
                }
            })
            .collect())
    })
}

fn group_from(
    label: &str,
    res: AppResult<BTreeMap<String, String>>,
    fields: &[(&str, &str)],
) -> ObjectGroup {
    match res {
        Ok(m) => ObjectGroup {
            label: label.to_string(),
            items: fields
                .iter()
                .filter_map(|(key, shown)| {
                    let v = m.get(*key)?;
                    let detail = if *key == "rdb_last_save_time" {
                        v.trim()
                            .parse::<i64>()
                            .ok()
                            .and_then(|s| chrono::DateTime::<chrono::Utc>::from_timestamp(s, 0))
                            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                            .unwrap_or_else(|| v.clone())
                    } else {
                        v.clone()
                    };
                    Some(ObjectItem {
                        name: shown.to_string(),
                        detail: Some(detail),
                    })
                })
                .collect(),
            error: None,
        },
        Err(e) => ObjectGroup {
            label: label.to_string(),
            items: Vec::new(),
            error: Some(e.message),
        },
    }
}

pub fn list_server_objects<'a>(c: &'a mut RedisConn) -> BoxFuture<'a, AppResult<Vec<ObjectGroup>>> {
    Box::pin(async move {
        let server = info_map(&mut c.conn, "server").await;
        let memory = info_map(&mut c.conn, "memory").await;
        let clients = info_map(&mut c.conn, "clients").await;
        let persistence = info_map(&mut c.conn, "persistence").await;
        Ok(vec![
            group_from(
                "Server",
                server,
                &[
                    ("redis_version", "redis_version"),
                    ("redis_mode", "redis_mode"),
                    ("os", "os"),
                    ("uptime_in_days", "uptime_in_days"),
                    ("tcp_port", "tcp_port"),
                ],
            ),
            group_from(
                "Memory",
                memory,
                &[
                    ("used_memory_human", "used_memory_human"),
                    ("used_memory_peak_human", "used_memory_peak_human"),
                    ("maxmemory_human", "maxmemory_human"),
                    ("maxmemory_policy", "maxmemory_policy"),
                ],
            ),
            group_from(
                "Clients",
                clients,
                &[
                    ("connected_clients", "connected_clients"),
                    ("blocked_clients", "blocked_clients"),
                ],
            ),
            group_from(
                "Persistence",
                persistence,
                &[
                    ("rdb_last_save_time", "rdb_last_save_time"),
                    ("aof_enabled", "aof_enabled"),
                ],
            ),
        ])
    })
}

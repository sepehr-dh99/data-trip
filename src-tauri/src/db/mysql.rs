//! MySQL / MariaDB driver (sqlx, text protocol for ad-hoc SQL).

use super::{
    first_keyword, hex_value, is_query_like, text_to_value, Connected, DbConn, RowSink, StreamEnd,
    TextRows,
};
use crate::error::AppResult;
use crate::model::{ColumnMeta, ConnectionConfig, Driver, SchemaNode};
use futures::StreamExt;
use serde_json::Value;
use sqlx::mysql::{MySqlConnectOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column, Connection, Either, Executor, MySqlConnection, Row, TypeInfo};

fn options(cfg: &ConnectionConfig, password: Option<&str>) -> MySqlConnectOptions {
    let host = cfg
        .host
        .as_deref()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or("localhost");
    let mut o = MySqlConnectOptions::new()
        .host(host)
        .port(cfg.port.unwrap_or(3306));
    if let Some(u) = cfg.username.as_deref().filter(|u| !u.is_empty()) {
        o = o.username(u);
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        o = o.password(p);
    }
    if let Some(db) = cfg.database.as_deref().filter(|d| !d.is_empty()) {
        o = o.database(db);
    }
    let mode = match cfg.ssl_mode.as_deref() {
        Some("disable") => MySqlSslMode::Disabled,
        Some("require") => MySqlSslMode::Required,
        _ => MySqlSslMode::Preferred,
    };
    o.ssl_mode(mode)
}

pub fn connect<'a>(
    cfg: &'a ConnectionConfig,
    password: Option<&'a str>,
) -> futures::future::BoxFuture<'a, AppResult<Connected>> {
    Box::pin(async move {
        let opts = options(cfg, password);
        let mut conn = MySqlConnection::connect_with(&opts).await?;
        if cfg.read_only {
            run_simple(&mut conn, "SET SESSION TRANSACTION READ ONLY").await?;
        }
        let server_version = scalar(&mut conn, "SELECT VERSION()")
            .await?
            .unwrap_or_default();
        let default_schema = scalar(&mut conn, "SELECT DATABASE()").await?;
        let backend_id = scalar(&mut conn, "SELECT CONNECTION_ID()")
            .await?
            .and_then(|s| s.trim().parse::<i64>().ok());
        Ok(Connected {
            conn: DbConn::Mysql(conn),
            server_version,
            default_schema,
            backend_id,
        })
    })
}

pub fn close(conn: MySqlConnection) -> futures::future::BoxFuture<'static, ()> {
    Box::pin(async move {
        let _ = conn.close().await;
    })
}

pub fn cancel<'a>(
    cfg: &'a ConnectionConfig,
    password: Option<&'a str>,
    backend_id: i64,
) -> futures::future::BoxFuture<'a, AppResult<()>> {
    Box::pin(async move {
        let opts = options(cfg, password);
        let mut conn = MySqlConnection::connect_with(&opts).await?;
        let sql = format!("KILL QUERY {}", backend_id);
        let res = run_simple(&mut conn, &sql).await;
        let _ = conn.close().await;
        res
    })
}

pub fn run_simple<'a>(
    conn: &'a mut MySqlConnection,
    sql: &'a str,
) -> futures::future::BoxFuture<'a, AppResult<()>> {
    Box::pin(async move {
        // Drain via fetch_many: RawSql::execute trips rustc's higher-ranked Send check.
        let mut s = sqlx::raw_sql(sql).fetch_many(&mut *conn);
        while let Some(item) = s.next().await {
            item?;
        }
        Ok(())
    })
}

fn scalar<'a>(
    conn: &'a mut MySqlConnection,
    sql: &'a str,
) -> futures::future::BoxFuture<'a, AppResult<Option<String>>> {
    Box::pin(async move {
        let mut sink = TextRows::new();
        stream(conn, sql, &mut sink).await?;
        Ok(sink
            .rows
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next())
            .flatten())
    })
}

fn is_binary_type(type_name: &str) -> bool {
    let u = type_name.to_uppercase();
    u.contains("BLOB") || u.contains("BINARY") || u == "BIT" || u == "GEOMETRY"
}

fn columns_of(row: &MySqlRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
        })
        .collect()
}

fn cells_of(row: &MySqlRow) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(row.columns().len());
    for (i, col) in row.columns().iter().enumerate() {
        let tn = col.type_info().name().to_string();
        if is_binary_type(&tn) {
            match row.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
                Ok(Some(bytes)) => out.push(hex_value(&bytes)),
                Ok(None) => out.push(Value::Null),
                Err(_) => out.push(Value::String(format!("<{}>", tn))),
            }
            continue;
        }
        match row.try_get_unchecked::<Option<String>, _>(i) {
            Ok(text) => out.push(text_to_value(Driver::Mysql, &tn, text)),
            Err(_) => match row.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
                Ok(Some(bytes)) => out.push(hex_value(&bytes)),
                Ok(None) => out.push(Value::Null),
                Err(_) => out.push(Value::String(format!("<{}>", tn))),
            },
        }
    }
    out
}

pub fn stream<'a>(
    conn: &'a mut MySqlConnection,
    sql: &'a str,
    sink: &'a mut dyn RowSink,
) -> futures::future::BoxFuture<'a, AppResult<StreamEnd>> {
    // Boxed with an explicit Send bound: works around rustc's "Executor is not general
    // enough" higher-ranked lifetime error when this future is spawned.
    Box::pin(async move {
        let mut affected: u64 = 0;
        let mut sent_cols = false;
        let mut got_rows = false;
        let mut set_done = false;
        let mut stopped = false;
        {
            let mut s = sqlx::raw_sql(sql).fetch_many(&mut *conn);
            while let Some(item) = s.next().await {
                match item? {
                    Either::Left(res) => {
                        affected += res.rows_affected();
                        if got_rows {
                            set_done = true;
                        }
                    }
                    Either::Right(row) => {
                        if set_done {
                            continue;
                        }
                        if !sent_cols {
                            sink.columns(&columns_of(&row))?;
                            sent_cols = true;
                        }
                        got_rows = true;
                        if !sink.row(cells_of(&row))? {
                            stopped = true;
                            break;
                        }
                    }
                }
            }
        }

        // A SELECT with zero rows yields no row items; recover column headers by describing it.
        if !sent_cols && !stopped && is_query_like(&first_keyword(sql)) {
            // VERIFY: sqlx 0.8 `Executor::describe` and `Describe::columns()`.
            if let Ok(d) = (&mut *conn).describe(sql).await {
                let cols: Vec<ColumnMeta> = d
                    .columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                    })
                    .collect();
                if !cols.is_empty() {
                    sink.columns(&cols)?;
                    sent_cols = true;
                }
            }
        }

        Ok(StreamEnd {
            rows_affected: if sent_cols { None } else { Some(affected) },
            stopped_early: stopped,
        })
    })
}

pub fn exec_params<'a>(
    conn: &'a mut MySqlConnection,
    sql: &'a str,
    params: &'a [Value],
) -> futures::future::BoxFuture<'a, AppResult<u64>> {
    Box::pin(async move {
        let mut q = sqlx::query::<sqlx::MySql>(sql);
        for p in params {
            q = match p {
                Value::Null => q.bind(Option::<String>::None),
                Value::Bool(b) => q.bind(*b),
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        q.bind(i)
                    } else if let Some(u) = n.as_u64() {
                        q.bind(u)
                    } else if let Some(f) = n.as_f64() {
                        q.bind(f)
                    } else {
                        q.bind(n.to_string())
                    }
                }
                Value::String(s) => q.bind(s.clone()),
                other => q.bind(other.to_string()),
            };
        }
        let res = q.execute(&mut *conn).await?;
        Ok(res.rows_affected())
    })
}

const SYSTEM_DBS: &str = "('information_schema', 'mysql', 'performance_schema', 'sys')";

pub fn introspect<'a>(
    conn: &'a mut MySqlConnection,
) -> futures::future::BoxFuture<'a, AppResult<Vec<SchemaNode>>> {
    Box::pin(async move {
        // Everything is cast to CHAR: some MySQL 8 information_schema columns are reported as binary.
        let cols_sql = format!(
            "SELECT CAST(c.TABLE_SCHEMA AS CHAR), CAST(c.TABLE_NAME AS CHAR), \
                    CAST(CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS CHAR), \
                    CAST(c.COLUMN_NAME AS CHAR), CAST(c.COLUMN_TYPE AS CHAR), \
                    CAST(CASE WHEN c.IS_NULLABLE = 'YES' THEN '1' ELSE '0' END AS CHAR), \
                    CAST(c.COLUMN_DEFAULT AS CHAR), CAST(c.ORDINAL_POSITION AS CHAR) \
             FROM information_schema.COLUMNS c \
             JOIN information_schema.TABLES t \
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
             WHERE c.TABLE_SCHEMA NOT IN {} \
             ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION",
            SYSTEM_DBS
        );
        let pk_sql = format!(
            "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR) \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE CONSTRAINT_NAME = 'PRIMARY' AND TABLE_SCHEMA NOT IN {} \
             ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
            SYSTEM_DBS
        );
        let mut cols = TextRows::new();
        stream(conn, &cols_sql, &mut cols).await?;
        let mut pks = TextRows::new();
        stream(conn, &pk_sql, &mut pks).await?;
        Ok(super::assemble(&cols.rows, &pks.rows))
    })
}

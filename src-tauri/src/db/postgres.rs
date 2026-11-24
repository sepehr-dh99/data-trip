//! PostgreSQL driver (sqlx, simple-query/text protocol for ad-hoc SQL).

use super::{
    first_keyword, is_query_like, text_to_value, value_to_text, Connected, DbConn, RowSink,
    StreamEnd, TextRows,
};
use crate::error::AppResult;
use crate::model::{ColumnMeta, ConnectionConfig, Driver, SchemaNode};
use futures::StreamExt;
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgRow, PgSslMode};
use sqlx::{Column, Connection, Either, Executor, PgConnection, Row, TypeInfo};

fn options(cfg: &ConnectionConfig, password: Option<&str>) -> PgConnectOptions {
    let host = cfg
        .host
        .as_deref()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or("localhost");
    let mut o = PgConnectOptions::new()
        .host(host)
        .port(cfg.port.unwrap_or(5432))
        .application_name("DataTrip");
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
        Some("disable") => PgSslMode::Disable,
        Some("require") => PgSslMode::Require,
        _ => PgSslMode::Prefer,
    };
    o.ssl_mode(mode)
}

pub fn connect<'a>(
    cfg: &'a ConnectionConfig,
    password: Option<&'a str>,
) -> futures::future::BoxFuture<'a, AppResult<Connected>> {
    Box::pin(async move {
        let opts = options(cfg, password);
        let mut conn = PgConnection::connect_with(&opts).await?;
        if cfg.read_only {
            run_simple(
                &mut conn,
                "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
            )
            .await?;
        }
        let server_version = scalar(&mut conn, "SHOW server_version")
            .await?
            .unwrap_or_default();
        let default_schema = scalar(&mut conn, "SELECT current_schema()").await?;
        let backend_id = scalar(&mut conn, "SELECT pg_backend_pid()")
            .await?
            .and_then(|s| s.trim().parse::<i64>().ok());
        Ok(Connected {
            conn: DbConn::Postgres(conn),
            server_version,
            default_schema,
            backend_id,
        })
    })
}

pub fn close(conn: PgConnection) -> futures::future::BoxFuture<'static, ()> {
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
        let mut conn = PgConnection::connect_with(&opts).await?;
        let sql = format!("SELECT pg_cancel_backend({})", backend_id);
        let res = run_simple(&mut conn, &sql).await;
        let _ = conn.close().await;
        res
    })
}

pub fn run_simple<'a>(
    conn: &'a mut PgConnection,
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
    conn: &'a mut PgConnection,
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

fn columns_of(row: &PgRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
        })
        .collect()
}

fn cells_of(row: &PgRow) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(row.columns().len());
    for (i, col) in row.columns().iter().enumerate() {
        let tn = col.type_info().name().to_string();
        match row.try_get_unchecked::<Option<String>, _>(i) {
            Ok(text) => out.push(text_to_value(Driver::Postgres, &tn, text)),
            Err(_) => match row.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
                Ok(Some(bytes)) => out.push(super::hex_value(&bytes)),
                Ok(None) => out.push(Value::Null),
                Err(_) => out.push(Value::String(format!("<{}>", tn))),
            },
        }
    }
    out
}

pub fn stream<'a>(
    conn: &'a mut PgConnection,
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
    conn: &'a mut PgConnection,
    sql: &'a str,
    params: &'a [Value],
) -> futures::future::BoxFuture<'a, AppResult<u64>> {
    Box::pin(async move {
        let mut q = sqlx::query::<sqlx::Postgres>(sql);
        for p in params {
            q = q.bind(value_to_text(p));
        }
        let res = q.execute(&mut *conn).await?;
        Ok(res.rows_affected())
    })
}

const NOT_SYSTEM: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
     AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'";

pub fn introspect<'a>(
    conn: &'a mut PgConnection,
) -> futures::future::BoxFuture<'a, AppResult<Vec<SchemaNode>>> {
    Box::pin(async move {
        let cols_sql = format!(
            "SELECT n.nspname, c.relname, \
                    CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END, \
                    a.attname, format_type(a.atttypid, a.atttypmod), \
                    CASE WHEN a.attnotnull THEN '0' ELSE '1' END, \
                    pg_get_expr(d.adbin, d.adrelid), \
                    a.attnum::text \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND {} \
             ORDER BY n.nspname, c.relname, a.attnum",
            NOT_SYSTEM
        );
        let pk_sql = format!(
            "SELECT n.nspname, c.relname, a.attname \
             FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_class c ON c.oid = i.indrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum \
             WHERE i.indisprimary AND {} \
             ORDER BY n.nspname, c.relname, k.ord",
            NOT_SYSTEM
        );

        let mut cols = TextRows::new();
        stream(conn, &cols_sql, &mut cols).await?;
        let mut pks = TextRows::new();
        stream(conn, &pk_sql, &mut pks).await?;
        if cols.rows.is_empty() && pks.rows.is_empty() {
            return Ok(Vec::new());
        }
        Ok(super::assemble(&cols.rows, &pks.rows))
    })
}

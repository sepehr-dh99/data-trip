//! SQLite driver (sqlx). Values are typed, so cells are decoded by their runtime storage class.

use super::{
    first_keyword, float_value, hex_value, int_value, is_query_like, Connected, DbConn, RowSink,
    StreamEnd, TextRows,
};
use crate::error::{AppError, AppResult};
use crate::model::{ColumnMeta, ConnectionConfig, SchemaNode};
use futures::StreamExt;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteRow};
use sqlx::{Column, Connection, Either, Executor, Row, SqliteConnection, TypeInfo, ValueRef};

pub fn connect<'a>(
    cfg: &'a ConnectionConfig,
) -> futures::future::BoxFuture<'a, AppResult<Connected>> {
    Box::pin(async move {
        let path = match cfg.file_path.as_deref() {
            Some(p) if !p.trim().is_empty() => p.trim().to_string(),
            _ => {
                return Err(AppError::new(
                    "SQLite connections need a database file path",
                ))
            }
        };
        if !std::path::Path::new(&path).exists() {
            return Err(AppError::new(format!(
                "SQLite database file not found: {}",
                path
            )));
        }
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(false);
        let mut conn = SqliteConnection::connect_with(&opts).await?;
        if cfg.read_only {
            run_simple(&mut conn, "PRAGMA query_only = ON").await?;
        }
        let server_version = scalar(&mut conn, "select sqlite_version()")
            .await?
            .unwrap_or_default();
        Ok(Connected {
            conn: DbConn::Sqlite(conn),
            server_version,
            default_schema: Some("main".to_string()),
            backend_id: None,
        })
    })
}

pub fn close(conn: SqliteConnection) -> futures::future::BoxFuture<'static, ()> {
    Box::pin(async move {
        let _ = conn.close().await;
    })
}

pub fn run_simple<'a>(
    conn: &'a mut SqliteConnection,
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
    conn: &'a mut SqliteConnection,
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

/// Decodes every cell by its runtime storage class. Returns (runtime type names, values).
fn cells_of(row: &SqliteRow) -> (Vec<String>, Vec<Value>) {
    let n = row.columns().len();
    let mut types: Vec<String> = Vec::with_capacity(n);
    let mut vals: Vec<Value> = Vec::with_capacity(n);
    for i in 0..n {
        let (is_null, rt) = match row.try_get_raw(i) {
            Ok(raw) => (raw.is_null(), raw.type_info().name().to_uppercase()),
            Err(_) => (true, "NULL".to_string()),
        };
        if is_null {
            types.push("NULL".to_string());
            vals.push(Value::Null);
            continue;
        }
        let v = if rt.contains("INT") {
            match row.try_get_unchecked::<i64, _>(i) {
                Ok(x) => int_value(x),
                Err(_) => Value::String(format!("<{}>", rt)),
            }
        } else if rt.contains("REAL") || rt.contains("FLOAT") || rt.contains("DOUBLE") {
            match row.try_get_unchecked::<f64, _>(i) {
                Ok(x) => float_value(x),
                Err(_) => Value::String(format!("<{}>", rt)),
            }
        } else if rt.contains("BLOB") {
            match row.try_get_unchecked::<Vec<u8>, _>(i) {
                Ok(b) => hex_value(&b),
                Err(_) => Value::String(format!("<{}>", rt)),
            }
        } else {
            match row.try_get_unchecked::<String, _>(i) {
                Ok(s) => Value::String(s),
                Err(_) => match row.try_get_unchecked::<Vec<u8>, _>(i) {
                    Ok(b) => hex_value(&b),
                    Err(_) => Value::String(format!("<{}>", rt)),
                },
            }
        };
        types.push(rt);
        vals.push(v);
    }
    (types, vals)
}

fn columns_of(row: &SqliteRow, runtime: &[String]) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let declared = c.type_info().name().to_string();
            let type_name = if declared.eq_ignore_ascii_case("NULL") || declared.is_empty() {
                runtime.get(i).cloned().unwrap_or(declared)
            } else {
                declared
            };
            ColumnMeta {
                name: c.name().to_string(),
                type_name,
            }
        })
        .collect()
}

pub fn stream<'a>(
    conn: &'a mut SqliteConnection,
    sql: &'a str,
    sink: &'a mut dyn RowSink,
) -> futures::future::BoxFuture<'a, AppResult<StreamEnd>> {
    // Boxed with an explicit Send bound: works around rustc's "Executor is not general
    // enough" higher-ranked lifetime error when this future is spawned.
    Box::pin(async move {
        let kw = first_keyword(sql);
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
                        let (types, vals) = cells_of(&row);
                        if !sent_cols {
                            sink.columns(&columns_of(&row, &types))?;
                            sent_cols = true;
                        }
                        got_rows = true;
                        if !sink.row(vals)? {
                            stopped = true;
                            break;
                        }
                    }
                }
            }
        }

        // A SELECT with zero rows yields no row items; recover column headers by describing it.
        if !sent_cols && !stopped && is_query_like(&kw) {
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

        // sqlite3_changes() is stale after a SELECT, so only trust it for DML.
        let rows_affected = if sent_cols {
            None
        } else if matches!(kw.as_str(), "INSERT" | "UPDATE" | "DELETE" | "REPLACE") {
            Some(affected)
        } else if is_query_like(&kw) {
            None
        } else {
            Some(0)
        };
        Ok(StreamEnd {
            rows_affected,
            stopped_early: stopped,
        })
    })
}

pub fn exec_params<'a>(
    conn: &'a mut SqliteConnection,
    sql: &'a str,
    params: &'a [Value],
) -> futures::future::BoxFuture<'a, AppResult<u64>> {
    Box::pin(async move {
        let mut q = sqlx::query::<sqlx::Sqlite>(sql);
        for p in params {
            q = match p {
                Value::Null => q.bind(Option::<String>::None),
                Value::Bool(b) => q.bind(*b),
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        q.bind(i)
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

pub fn introspect<'a>(
    conn: &'a mut SqliteConnection,
) -> futures::future::BoxFuture<'a, AppResult<Vec<SchemaNode>>> {
    Box::pin(async move {
        // One query: every table/view joined with its PRAGMA table_info rows.
        let sql = "SELECT m.name, m.type, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk \
                   FROM sqlite_master m, pragma_table_info(m.name) p \
                   WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                   ORDER BY m.name, p.cid";
        let mut sink = TextRows::new();
        stream(conn, sql, &mut sink).await?;

        let mut col_rows: Vec<Vec<Option<String>>> = Vec::new();
        // (table, pk position, column)
        let mut pk_entries: Vec<(String, i64, String)> = Vec::new();
        for r in &sink.rows {
            let get = |i: usize| -> Option<String> { r.get(i).cloned().flatten() };
            let table = get(0).unwrap_or_default();
            let kind = if get(1).as_deref() == Some("view") {
                "view"
            } else {
                "table"
            };
            let col = get(2).unwrap_or_default();
            let notnull = get(4).unwrap_or_default();
            let pk = get(6)
                .and_then(|s| s.trim().parse::<i64>().ok())
                .unwrap_or(0);
            if pk > 0 {
                pk_entries.push((table.clone(), pk, col.clone()));
            }
            col_rows.push(vec![
                Some("main".to_string()),
                Some(table),
                Some(kind.to_string()),
                Some(col),
                Some(get(3).unwrap_or_default()),
                Some(if notnull == "1" { "0" } else { "1" }.to_string()),
                get(5),
                None,
            ]);
        }
        pk_entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let pk_rows: Vec<Vec<Option<String>>> = pk_entries
            .into_iter()
            .map(|(t, _, c)| vec![Some("main".to_string()), Some(t), Some(c)])
            .collect();
        Ok(super::assemble(&col_rows, &pk_rows))
    })
}

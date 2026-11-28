//! SQLite driver (sqlx). Values are typed, so cells are decoded by their runtime storage class.

use super::{
    first_keyword, float_value, hex_value, int_value, is_query_like, CatRow, CatalogExtras,
    Connected, DbConn, RowSink, StreamEnd, TextRows,
};
use crate::error::{AppError, AppResult};
use crate::model::{ColumnMeta, ConnectionConfig, DatabaseNode, SchemaNode};
use futures::StreamExt;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteRow};
use sqlx::{Column, Connection, Either, Executor, Row, SqliteConnection, TypeInfo, ValueRef};

pub fn connect<'a>(
    cfg: &'a ConnectionConfig,
) -> futures::future::BoxFuture<'a, AppResult<Connected>> {
    connect_file(cfg, false)
}

pub fn connect_hosted(
    cfg: &ConnectionConfig,
) -> futures::future::BoxFuture<'_, AppResult<Connected>> {
    connect_file(cfg, true)
}

/// Writes a consistent snapshot to a path selected by the web adapter.
pub async fn snapshot(source: &std::path::Path, destination: &str) -> AppResult<()> {
    let options = SqliteConnectOptions::new().filename(source).read_only(true);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    run_simple(
        &mut connection,
        "PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY;",
    )
    .await?;
    sqlx::query("VACUUM INTO ?")
        .bind(destination)
        .execute(&mut connection)
        .await?;
    connection.close().await?;
    Ok(())
}

fn connect_file(
    cfg: &ConnectionConfig,
    hosted: bool,
) -> futures::future::BoxFuture<'_, AppResult<Connected>> {
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
        if hosted {
            isolate(&mut conn, cfg.read_only).await?;
        }
        if cfg.read_only && !hosted {
            run_simple(&mut conn, "PRAGMA query_only = ON").await?;
        }
        let server_version = scalar(&mut conn, "select sqlite_version()")
            .await?
            .unwrap_or_default();
        Ok(Connected {
            conn: DbConn::Sqlite(conn),
            server_version,
            default_schema: Some("main".to_string()),
            database: Some("main".to_string()),
            backend_id: None,
            tunnel: None,
        })
    })
}

/// The raw handle is only accessed while sqlx has stopped its worker. The callback has
/// static code and either a null pointer or a marker; it never dereferences user data.
pub async fn isolate(conn: &mut SqliteConnection, read_only: bool) -> AppResult<()> {
    use libsqlite3_sys::*;
    run_simple(
        conn,
        "PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY;",
    )
    .await?;
    let page_size = scalar(conn, "PRAGMA page_size")
        .await?
        .and_then(|size| size.parse::<u64>().ok())
        .filter(|size| *size > 0)
        .ok_or_else(|| AppError::new("Could not determine workspace SQLite page size"))?;
    run_simple(
        conn,
        &format!("PRAGMA max_page_count = {}", 128 * 1024 * 1024 / page_size),
    )
    .await?;
    if read_only {
        run_simple(conn, "PRAGMA query_only = ON").await?;
    }
    let mut handle = conn.lock_handle().await?;
    let raw = handle.as_raw_handle().as_ptr();
    let marker = if read_only {
        std::ptr::NonNull::<std::ffi::c_void>::dangling().as_ptr()
    } else {
        std::ptr::null_mut()
    };
    let rc = unsafe {
        sqlite3_limit(raw, SQLITE_LIMIT_LENGTH, 16 * 1024 * 1024);
        sqlite3_set_authorizer(raw, Some(authorize), marker)
    };
    if rc != SQLITE_OK {
        return Err(AppError::new(
            "Could not authorize workspace SQLite connection",
        ));
    }
    Ok(())
}

unsafe extern "C" fn authorize(
    marker: *mut std::ffi::c_void,
    action: std::ffi::c_int,
    first: *const std::ffi::c_char,
    second: *const std::ffi::c_char,
    _database: *const std::ffi::c_char,
    _trigger: *const std::ffi::c_char,
) -> std::ffi::c_int {
    use libsqlite3_sys::*;
    // SQLite guarantees null or NUL-terminated strings for the callback lifetime.
    let arg = |ptr: *const std::ffi::c_char| {
        (!ptr.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(ptr).to_bytes() })
    };
    let allowed = match action {
        SQLITE_ATTACH | SQLITE_DETACH | SQLITE_CREATE_VTABLE | SQLITE_DROP_VTABLE => false,
        SQLITE_FUNCTION => !arg(second).is_some_and(|func| {
            func.eq_ignore_ascii_case(b"load_extension")
                || func.eq_ignore_ascii_case(b"readfile")
                || func.eq_ignore_ascii_case(b"writefile")
        }),
        SQLITE_PRAGMA => arg(first).is_some_and(|pragma| {
            [
                b"table_info".as_slice(),
                b"table_xinfo",
                b"index_list",
                b"index_info",
                b"index_xinfo",
                b"foreign_key_list",
                b"integrity_check",
                b"quick_check",
                b"foreign_key_check",
                b"database_list",
                b"schema_version",
                b"table_list",
            ]
            .iter()
            .any(|name| {
                pragma.eq_ignore_ascii_case(name)
                    && (!pragma.eq_ignore_ascii_case(b"schema_version") || second.is_null())
            }) || (marker.is_null() && pragma.eq_ignore_ascii_case(b"foreign_keys"))
        }),
        _ => true,
    };
    if allowed {
        SQLITE_OK
    } else {
        SQLITE_DENY
    }
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

        let idx_sql = "SELECT m.name, il.name, CAST(il.\"unique\" AS TEXT), \
                              CASE WHEN il.origin = 'pk' THEN '1' ELSE '0' END, ii.name \
                       FROM sqlite_master m, pragma_index_list(m.name) il, pragma_index_info(il.name) ii \
                       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                       ORDER BY m.name, il.name, ii.seqno";
        let fk_sql = "SELECT m.name, fk.id, fk.\"from\", fk.\"table\", fk.\"to\" \
                      FROM sqlite_master m, pragma_foreign_key_list(m.name) fk \
                      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                      ORDER BY m.name, fk.id, fk.seq";
        // Reshape into the shared row formats.
        let mut indexes: Vec<CatRow> = Vec::new();
        let mut idx = TextRows::new();
        if stream(conn, idx_sql, &mut idx).await.is_ok() {
            for r in idx.rows {
                let g = |i: usize| -> Option<String> { r.get(i).cloned().flatten() };
                let unique = if g(2).as_deref() == Some("1") {
                    "1"
                } else {
                    "0"
                };
                indexes.push(vec![
                    Some("main".to_string()),
                    g(0),
                    g(1),
                    Some(unique.to_string()),
                    g(3),
                    g(4),
                ]);
            }
        }
        let mut fks: Vec<CatRow> = Vec::new();
        let mut fk = TextRows::new();
        if stream(conn, fk_sql, &mut fk).await.is_ok() {
            for r in fk.rows {
                let g = |i: usize| -> Option<String> { r.get(i).cloned().flatten() };
                let table = g(0).unwrap_or_default();
                let name = format!("{}_fk_{}", table, g(1).unwrap_or_default());
                fks.push(vec![
                    Some("main".to_string()),
                    Some(table),
                    Some(name),
                    g(2),
                    Some("main".to_string()),
                    g(3),
                    g(4),
                ]);
            }
        }
        let extras = CatalogExtras {
            schemas: vec!["main".to_string()],
            indexes,
            fks,
            ..Default::default()
        };
        Ok(super::assemble(&col_rows, &pk_rows, &extras))
    })
}

pub fn list_databases<'a>(
    conn: &'a mut SqliteConnection,
) -> futures::future::BoxFuture<'a, AppResult<Vec<DatabaseNode>>> {
    Box::pin(async move {
        let mut out = vec![DatabaseNode {
            name: "main".to_string(),
            is_current: true,
            is_system: false,
            size_bytes: None,
            comment: None,
        }];
        // Attached databases (best effort); "main" and "temp" are skipped.
        let mut sink = TextRows::new();
        if stream(conn, "PRAGMA database_list", &mut sink)
            .await
            .is_ok()
        {
            for r in &sink.rows {
                if let Some(name) = r.get(1).cloned().flatten() {
                    if name != "main" && name != "temp" {
                        out.push(DatabaseNode {
                            name,
                            is_current: false,
                            is_system: false,
                            size_bytes: None,
                            comment: None,
                        });
                    }
                }
            }
        }
        Ok(out)
    })
}

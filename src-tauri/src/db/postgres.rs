//! PostgreSQL driver (sqlx, simple-query/text protocol for ad-hoc SQL).

use super::{
    first_keyword, is_query_like, make_group, text_to_value, truthy, value_to_text, CatRow,
    CatalogExtras, Connected, DbConn, RowSink, StreamEnd, TextRows,
};
use crate::error::AppResult;
use crate::model::{
    ColumnMeta, ConnectionConfig, DatabaseNode, Driver, ObjectGroup, ObjectItem, SchemaNode,
};
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
        Some("verify-ca") => PgSslMode::VerifyCa,
        Some("verify-full") => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    };
    o = o.ssl_mode(mode);
    // VERIFY: sqlx 0.8 PgConnectOptions::{ssl_root_cert, ssl_client_cert, ssl_client_key} take impl AsRef<Path>.
    if let Some(p) = path_opt(&cfg.ssl_ca_path) {
        o = o.ssl_root_cert(p);
    }
    if let Some(p) = path_opt(&cfg.ssl_cert_path) {
        o = o.ssl_client_cert(p);
    }
    if let Some(p) = path_opt(&cfg.ssl_key_path) {
        o = o.ssl_client_key(p);
    }
    o
}

/// Non-empty path with a leading `~` expanded.
fn path_opt(p: &Option<String>) -> Option<String> {
    p.as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(crate::vault::expand_tilde)
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
        let database = scalar(&mut conn, "SELECT current_database()").await?;
        let backend_id = scalar(&mut conn, "SELECT pg_backend_pid()")
            .await?
            .and_then(|s| s.trim().parse::<i64>().ok());
        Ok(Connected {
            conn: DbConn::Postgres(conn),
            server_version,
            default_schema,
            database,
            backend_id,
            tunnel: None,
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

fn rows_of<'a>(
    conn: &'a mut PgConnection,
    sql: &'a str,
) -> futures::future::BoxFuture<'a, AppResult<Vec<CatRow>>> {
    Box::pin(async move {
        let mut sink = TextRows::new();
        stream(conn, sql, &mut sink).await?;
        Ok(sink.rows)
    })
}

/// Not extension-owned (hides e.g. PostGIS functions).
const NOT_EXTENSION: &str =
    "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep WHERE dep.objid = {oid} AND dep.deptype = 'e')";

pub fn introspect<'a>(
    conn: &'a mut PgConnection,
) -> futures::future::BoxFuture<'a, AppResult<Vec<SchemaNode>>> {
    Box::pin(async move {
        let cols_sql = format!(
            "SELECT n.nspname, c.relname, \
                    CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized' ELSE 'table' END, \
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
        let schemas_sql = format!(
            "SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE {} ORDER BY n.nspname",
            NOT_SYSTEM
        );
        // Works on PG 9.6+: indnatts exists everywhere (on 11+ it also counts INCLUDE columns).
        // One row per index key column, in index order; expression columns use the index definition text.
        let idx_sql = format!(
            "SELECT n.nspname, t.relname, i.relname, \
                    CASE WHEN x.indisunique THEN '1' ELSE '0' END, \
                    CASE WHEN x.indisprimary THEN '1' ELSE '0' END, \
                    COALESCE(a.attname::text, pg_get_indexdef(x.indexrelid, k.n, true)) \
             FROM pg_catalog.pg_index x \
             JOIN pg_catalog.pg_class t ON t.oid = x.indrelid \
             JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
             CROSS JOIN LATERAL generate_series(1, x.indnatts::int) AS k(n) \
             LEFT JOIN pg_catalog.pg_attribute a \
               ON a.attrelid = t.oid AND a.attnum = x.indkey[k.n - 1] \
             WHERE t.relkind IN ('r', 'p', 'm') AND {} \
             ORDER BY n.nspname, t.relname, i.relname, k.n",
            NOT_SYSTEM
        );
        let fk_sql = format!(
            "SELECT n.nspname, t.relname, c.conname, a.attname, rn.nspname, rt.relname, ra.attname \
             FROM pg_catalog.pg_constraint c \
             JOIN pg_catalog.pg_class t ON t.oid = c.conrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_catalog.pg_class rt ON rt.oid = c.confrelid \
             JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.relnamespace \
             CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, rattnum, ord) \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum \
             JOIN pg_catalog.pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.rattnum \
             WHERE c.contype = 'f' AND {} \
             ORDER BY n.nspname, t.relname, c.conname, k.ord",
            NOT_SYSTEM
        );
        let comment_sql = format!(
            "SELECT n.nspname, c.relname, obj_description(c.oid, 'pg_class') \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND {} \
               AND obj_description(c.oid, 'pg_class') IS NOT NULL",
            NOT_SYSTEM
        );
        let routine_sql_11 = format!(
            "SELECT n.nspname, p.proname, \
                    CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END, \
                    '(' || pg_get_function_identity_arguments(p.oid) || ')', \
                    CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE p.prokind IN ('f', 'p') AND {} AND {} \
             ORDER BY n.nspname, p.proname, p.oid",
            NOT_SYSTEM,
            NOT_EXTENSION.replace("{oid}", "p.oid")
        );
        let seq_sql = format!(
            "SELECT n.nspname, c.relname \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind = 'S' AND {} AND {} \
             ORDER BY n.nspname, c.relname",
            NOT_SYSTEM,
            NOT_EXTENSION.replace("{oid}", "c.oid")
        );

        // pg_proc.prokind only exists from PG 11; PG 10 and older use proisagg/proiswindow and have no procedures.
        let routine_sql_10 = format!(
            "SELECT n.nspname, p.proname, 'function', \
                    '(' || pg_get_function_identity_arguments(p.oid) || ')', \
                    pg_get_function_result(p.oid) \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE NOT p.proisagg AND NOT p.proiswindow AND {} AND {} \
             ORDER BY n.nspname, p.proname, p.oid",
            NOT_SYSTEM,
            NOT_EXTENSION.replace("{oid}", "p.oid")
        );
        let version_num: i64 = rows_of(conn, "SHOW server_version_num")
            .await
            .ok()
            .and_then(|rows| rows.into_iter().next())
            .and_then(|row| row.into_iter().next().flatten())
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(110_000);
        let routine_sql = if version_num >= 110_000 {
            routine_sql_11
        } else {
            routine_sql_10
        };

        let cols = rows_of(conn, &cols_sql).await?;
        let pks = rows_of(conn, &pk_sql).await?;
        // Optional parts: on failure leave them empty.
        let extras = CatalogExtras {
            schemas: rows_of(conn, &schemas_sql)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|r| r.into_iter().next().flatten())
                .collect(),
            indexes: rows_of(conn, &idx_sql).await.unwrap_or_default(),
            fks: rows_of(conn, &fk_sql).await.unwrap_or_default(),
            comments: rows_of(conn, &comment_sql).await.unwrap_or_default(),
            routines: rows_of(conn, &routine_sql).await.unwrap_or_default(),
            sequences: rows_of(conn, &seq_sql).await.unwrap_or_default(),
        };
        Ok(super::assemble(&cols, &pks, &extras))
    })
}

pub fn list_databases<'a>(
    conn: &'a mut PgConnection,
) -> futures::future::BoxFuture<'a, AppResult<Vec<DatabaseNode>>> {
    Box::pin(async move {
        let sql = "SELECT d.datname, \
                          CASE WHEN d.datname = current_database() THEN '1' ELSE '0' END, \
                          CASE WHEN has_database_privilege(d.datname, 'CONNECT') \
                               THEN pg_database_size(d.datname) END, \
                          shobj_description(d.oid, 'pg_database') \
                   FROM pg_database d \
                   WHERE NOT d.datistemplate AND d.datallowconn \
                     AND has_database_privilege(d.datname, 'CONNECT')";
        let rows = rows_of(conn, sql).await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                Some(DatabaseNode {
                    name: r.first().cloned().flatten()?,
                    is_current: truthy(r.get(1).and_then(|v| v.as_ref())),
                    is_system: false,
                    size_bytes: r
                        .get(2)
                        .cloned()
                        .flatten()
                        .and_then(|s| s.trim().parse::<i64>().ok()),
                    comment: r.get(3).cloned().flatten().filter(|c| !c.is_empty()),
                })
            })
            .collect())
    })
}

pub fn list_server_objects<'a>(
    conn: &'a mut PgConnection,
) -> futures::future::BoxFuture<'a, AppResult<Vec<ObjectGroup>>> {
    Box::pin(async move {
        let roles_sql = "SELECT rolname, CASE WHEN rolsuper THEN '1' ELSE '0' END, \
                                CASE WHEN rolcanlogin THEN '1' ELSE '0' END \
                         FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname";
        let roles = rows_of(conn, roles_sql).await;
        let ts_sql = "SELECT t.spcname, pg_get_userbyid(t.spcowner) \
                      FROM pg_tablespace t ORDER BY t.spcname";
        let spaces = rows_of(conn, ts_sql).await;
        Ok(vec![
            make_group("Roles", roles, |r| {
                let name = r.first().cloned().flatten()?;
                let superuser = truthy(r.get(1).and_then(|v| v.as_ref()));
                let login = truthy(r.get(2).and_then(|v| v.as_ref()));
                let detail = match (superuser, login) {
                    (true, true) => "superuser \u{b7} login",
                    (true, false) => "superuser \u{b7} no login",
                    (false, true) => "login",
                    (false, false) => "no login",
                };
                Some(ObjectItem {
                    name,
                    detail: Some(detail.to_string()),
                })
            }),
            make_group("Tablespaces", spaces, |r| {
                let name = r.first().cloned().flatten()?;
                let detail = r.get(1).cloned().flatten().map(|o| format!("owner {}", o));
                Some(ObjectItem { name, detail })
            }),
        ])
    })
}

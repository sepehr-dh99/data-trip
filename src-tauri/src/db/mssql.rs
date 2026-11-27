//! SQL Server driver (tiberius over tokio TcpStream).

use super::{
    first_keyword, float_value, hex_value, int_value, make_group, truthy, CatRow, CatalogExtras,
    Connected, DbConn, RowSink, StreamEnd, TextRows,
};
use crate::error::AppResult;
use crate::model::{
    ColumnMeta, ConnectionConfig, DatabaseNode, ObjectGroup, ObjectItem, SchemaNode,
};
use futures::TryStreamExt;
use serde_json::Value;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

pub type MssqlClient = Client<Compat<TcpStream>>;

pub fn connect<'a>(
    cfg: &'a ConnectionConfig,
    password: Option<&'a str>,
) -> futures::future::BoxFuture<'a, AppResult<Connected>> {
    Box::pin(async move {
        let host = cfg
            .host
            .as_deref()
            .filter(|h| !h.trim().is_empty())
            .unwrap_or("localhost");
        let mut config = Config::new();
        config.host(host);
        config.port(cfg.port.unwrap_or(1433));
        config.application_name("DataTrip");
        config.authentication(AuthMethod::sql_server(
            cfg.username.clone().unwrap_or_default(),
            password.unwrap_or("").to_string(),
        ));
        if let Some(db) = cfg.database.as_deref().filter(|d| !d.is_empty()) {
            config.database(db);
        }
        if cfg.trust_server_certificate {
            config.trust_cert();
        }
        // VERIFY: tiberius 0.12 `EncryptionLevel::{Required, Off}` with the `rustls` feature.
        if cfg.ssl_mode.as_deref() == Some("require") {
            config.encryption(EncryptionLevel::Required);
        } else {
            config.encryption(EncryptionLevel::Off);
        }

        let tcp = TcpStream::connect(config.get_addr()).await?;
        tcp.set_nodelay(true)?;
        let mut client = Client::connect(config, tcp.compat_write()).await?;

        let version = scalar(&mut client, "SELECT @@VERSION")
            .await?
            .unwrap_or_default();
        let server_version = version.lines().next().unwrap_or("").trim().to_string();
        let default_schema = scalar(&mut client, "SELECT SCHEMA_NAME()").await?;
        let database = scalar(&mut client, "SELECT DB_NAME()").await?;
        Ok(Connected {
            conn: DbConn::Mssql(client),
            server_version,
            default_schema,
            database,
            backend_id: None,
            tunnel: None,
        })
    })
}

pub fn run_simple<'a>(
    client: &'a mut MssqlClient,
    sql: &'a str,
) -> futures::future::BoxFuture<'a, AppResult<()>> {
    Box::pin(async move {
        let stream = client.simple_query(sql.to_string()).await?;
        stream.into_results().await?;
        Ok(())
    })
}

fn scalar<'a>(
    client: &'a mut MssqlClient,
    sql: &'a str,
) -> futures::future::BoxFuture<'a, AppResult<Option<String>>> {
    Box::pin(async move {
        let mut sink = TextRows::new();
        stream(client, sql, &mut sink).await?;
        Ok(sink
            .rows
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next())
            .flatten())
    })
}

fn cell_to_value(row: &tiberius::Row, idx: usize, data: &ColumnData<'static>) -> Value {
    #[allow(unreachable_patterns)]
    match data {
        ColumnData::U8(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I16(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I32(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I64(v) => v.map(int_value).unwrap_or(Value::Null),
        ColumnData::F32(v) => match v {
            // Go through the shortest decimal form so 0.1f32 shows as 0.1.
            Some(x) => float_value(x.to_string().parse::<f64>().unwrap_or(f64::NAN)),
            None => Value::Null,
        },
        ColumnData::F64(v) => v.map(float_value).unwrap_or(Value::Null),
        ColumnData::Bit(v) => v.map(Value::Bool).unwrap_or(Value::Null),
        ColumnData::String(v) => match v {
            Some(s) => Value::String(s.to_string()),
            None => Value::Null,
        },
        ColumnData::Guid(v) => match v {
            Some(g) => Value::String(g.to_string()),
            None => Value::Null,
        },
        ColumnData::Binary(v) => match v {
            Some(b) => hex_value(&b[..]),
            None => Value::Null,
        },
        ColumnData::Numeric(v) => match v {
            Some(n) => Value::String(n.to_string()),
            None => Value::Null,
        },
        // VERIFY: `XmlData` implements Display in tiberius 0.12.
        ColumnData::Xml(v) => match v {
            Some(x) => Value::String(x.to_string()),
            None => Value::Null,
        },
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            match row.try_get::<chrono::NaiveDateTime, _>(idx) {
                Ok(Some(d)) => Value::String(d.format("%Y-%m-%dT%H:%M:%S%.f").to_string()),
                Ok(None) => Value::Null,
                Err(_) => Value::String("<datetime>".to_string()),
            }
        }
        ColumnData::Date(_) => match row.try_get::<chrono::NaiveDate, _>(idx) {
            Ok(Some(d)) => Value::String(d.format("%Y-%m-%d").to_string()),
            Ok(None) => Value::Null,
            Err(_) => Value::String("<date>".to_string()),
        },
        ColumnData::Time(_) => match row.try_get::<chrono::NaiveTime, _>(idx) {
            Ok(Some(d)) => Value::String(d.format("%H:%M:%S%.f").to_string()),
            Ok(None) => Value::Null,
            Err(_) => Value::String("<time>".to_string()),
        },
        // VERIFY: FromSql for chrono::DateTime<FixedOffset> exists with the `chrono` feature.
        ColumnData::DateTimeOffset(_) => {
            match row.try_get::<chrono::DateTime<chrono::FixedOffset>, _>(idx) {
                Ok(Some(d)) => Value::String(d.format("%Y-%m-%dT%H:%M:%S%.f%:z").to_string()),
                Ok(None) => Value::Null,
                Err(_) => Value::String("<datetimeoffset>".to_string()),
            }
        }
        _ => Value::String("<unsupported>".to_string()),
    }
}

/// Prefix of a statement DataTrip explains under `SET SHOWPLAN_XML ON` / `SET STATISTICS XML ON`
/// (frontend `MSSQL_SHOWPLAN_MARKER`): only the showplan result sets are returned, one row each.
const SHOWPLAN_MARKER: &str = "/*datatrip:showplan*/";

/// The XML showplan result set's column ("Microsoft SQL Server 2005 XML Showplan").
fn is_showplan_column(name: &str) -> bool {
    name.to_ascii_lowercase().contains("showplan")
}

pub fn stream<'a>(
    client: &'a mut MssqlClient,
    sql: &'a str,
    sink: &'a mut dyn RowSink,
) -> futures::future::BoxFuture<'a, AppResult<StreamEnd>> {
    Box::pin(async move {
        // Explain: the statement's own results (rows of an analyzed SELECT) are skipped, the plans are the result.
        let plan_mode = sql.trim_start().starts_with(SHOWPLAN_MARKER);
        let kw = first_keyword(sql);
        // For plain DML, append SELECT @@ROWCOUNT to learn the affected row count.
        let dml = !plan_mode
            && matches!(kw.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE")
            && !sql.to_uppercase().contains("OUTPUT");
        let batch = if dml {
            let sep = if sql.trim_end().ends_with(';') {
                "\n"
            } else {
                "\n;"
            };
            format!("{}{}SELECT @@ROWCOUNT", sql, sep)
        } else {
            sql.to_string()
        };

        let mut qs = client.simple_query(batch).await?;
        let mut sets: usize = 0;
        let mut count: Option<u64> = None;
        let mut stopped = false;
        let mut sent_cols = false;
        let mut in_plan = false;

        while let Some(item) = qs.try_next().await? {
            match item {
                QueryItem::Metadata(meta) if plan_mode => {
                    in_plan =
                        matches!(meta.columns().first(), Some(c) if is_showplan_column(c.name()));
                    if in_plan && !sent_cols {
                        sink.columns(&[ColumnMeta {
                            name: "Showplan".to_string(),
                            type_name: "Xml".to_string(),
                        }])?;
                        sent_cols = true;
                    }
                }
                QueryItem::Row(row) if plan_mode => {
                    if !in_plan {
                        continue;
                    }
                    let cells: Vec<Value> = row
                        .cells()
                        .take(1)
                        .enumerate()
                        .map(|(i, (_, d))| cell_to_value(&row, i, d))
                        .collect();
                    if !sink.row(cells)? {
                        stopped = true;
                        break;
                    }
                }
                QueryItem::Metadata(meta) => {
                    sets += 1;
                    if !dml && sets == 1 {
                        let cols: Vec<ColumnMeta> = meta
                            .columns()
                            .iter()
                            .map(|c| ColumnMeta {
                                name: c.name().to_string(),
                                type_name: format!("{:?}", c.column_type()),
                            })
                            .collect();
                        sink.columns(&cols)?;
                        sent_cols = true;
                    }
                }
                QueryItem::Row(row) => {
                    if dml {
                        if let Ok(Some(n)) = row.try_get::<i32, _>(0) {
                            if n >= 0 {
                                count = Some(n as u64);
                            }
                        }
                        continue;
                    }
                    if sets != 1 {
                        continue;
                    }
                    let cells: Vec<Value> = row
                        .cells()
                        .enumerate()
                        .map(|(i, (_, d))| cell_to_value(&row, i, d))
                        .collect();
                    if !sink.row(cells)? {
                        stopped = true;
                        break;
                    }
                }
            }
        }
        if stopped {
            // The TDS response must be fully consumed before the connection can be reused.
            while let Some(_item) = qs.try_next().await? {}
        }

        Ok(StreamEnd {
            rows_affected: if sent_cols { None } else { count },
            stopped_early: stopped,
        })
    })
}

pub fn exec_params<'a>(
    client: &'a mut MssqlClient,
    sql: &'a str,
    params: &'a [Value],
) -> futures::future::BoxFuture<'a, AppResult<u64>> {
    Box::pin(async move {
        let mut q = tiberius::Query::new(sql.to_string());
        // VERIFY: IntoSql is implemented for bool, i64, f64, String and Option<String>.
        for p in params {
            match p {
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
        let res = q.execute(&mut *client).await?;
        Ok(res.total())
    })
}

fn rows_of<'a>(
    client: &'a mut MssqlClient,
    sql: &'a str,
) -> futures::future::BoxFuture<'a, AppResult<Vec<CatRow>>> {
    Box::pin(async move {
        let mut sink = TextRows::new();
        stream(client, sql, &mut sink).await?;
        Ok(sink.rows)
    })
}

const SCHEMA_OK: &str =
    "{s}.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND {s}.name NOT LIKE 'db[_]%'";

pub fn introspect<'a>(
    client: &'a mut MssqlClient,
) -> futures::future::BoxFuture<'a, AppResult<Vec<SchemaNode>>> {
    Box::pin(async move {
        let cols_sql = "SELECT c.TABLE_SCHEMA, c.TABLE_NAME, \
                CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END, \
                c.COLUMN_NAME, \
                CASE \
                  WHEN c.DATA_TYPE IN ('varchar','nvarchar','char','nchar','varbinary','binary') \
                    THEN c.DATA_TYPE + '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'max' \
                         ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(10)) END + ')' \
                  WHEN c.DATA_TYPE IN ('decimal','numeric') \
                    THEN c.DATA_TYPE + '(' + CAST(c.NUMERIC_PRECISION AS varchar(10)) + ',' \
                         + CAST(c.NUMERIC_SCALE AS varchar(10)) + ')' \
                  ELSE c.DATA_TYPE END, \
                CASE WHEN c.IS_NULLABLE = 'YES' THEN '1' ELSE '0' END, \
                c.COLUMN_DEFAULT, \
                CAST(c.ORDINAL_POSITION AS varchar(10)) \
             FROM INFORMATION_SCHEMA.COLUMNS c \
             JOIN INFORMATION_SCHEMA.TABLES t \
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
             WHERE c.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') \
               AND c.TABLE_SCHEMA NOT LIKE 'db[_]%' \
             ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION";
        let pk_sql = "SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME \
             FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
               ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
              AND kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
              AND kcu.TABLE_NAME = tc.TABLE_NAME \
             WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' \
             ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION";
        let schemas_sql = format!(
            "SELECT s.name FROM sys.schemas s WHERE {} ORDER BY s.name",
            SCHEMA_OK.replace("{s}", "s")
        );
        let idx_sql = format!(
            "SELECT s.name, t.name, i.name, \
                    CASE WHEN i.is_unique = 1 THEN '1' ELSE '0' END, \
                    CASE WHEN i.is_primary_key = 1 THEN '1' ELSE '0' END, c.name \
             FROM sys.indexes i \
             JOIN sys.tables t ON t.object_id = i.object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                                      AND ic.is_included_column = 0 \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE i.type > 0 AND i.is_hypothetical = 0 AND i.name IS NOT NULL AND {} \
             ORDER BY s.name, t.name, i.name, ic.key_ordinal, ic.index_column_id",
            SCHEMA_OK.replace("{s}", "s")
        );
        let fk_sql = format!(
            "SELECT s.name, t.name, fk.name, pc.name, rs.name, rt.name, rc.name \
             FROM sys.foreign_keys fk \
             JOIN sys.tables t ON t.object_id = fk.parent_object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
             JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
             JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
             WHERE {} \
             ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id",
            SCHEMA_OK.replace("{s}", "s")
        );
        // Arguments are best effort (FOR XML PATH escapes &, < and > in names).
        let routine_sql = format!(
            "SELECT s.name, o.name, CASE WHEN o.type = 'P' THEN 'procedure' ELSE 'function' END, \
                    '(' + ISNULL(STUFF((SELECT ', ' + p.name + ' ' + TYPE_NAME(p.user_type_id) \
                                        FROM sys.parameters p \
                                        WHERE p.object_id = o.object_id AND p.parameter_id > 0 \
                                        ORDER BY p.parameter_id FOR XML PATH('')), 1, 2, ''), '') + ')', \
                    (SELECT TYPE_NAME(p.user_type_id) FROM sys.parameters p \
                     WHERE p.object_id = o.object_id AND p.parameter_id = 0) \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0 AND {} \
             ORDER BY s.name, o.name",
            SCHEMA_OK.replace("{s}", "s")
        );
        let seq_sql = format!(
            "SELECT s.name, q.name FROM sys.sequences q \
             JOIN sys.schemas s ON s.schema_id = q.schema_id \
             WHERE {} ORDER BY s.name, q.name",
            SCHEMA_OK.replace("{s}", "s")
        );

        let cols = rows_of(client, cols_sql).await?;
        let pks = rows_of(client, pk_sql).await?;
        let extras = CatalogExtras {
            schemas: rows_of(client, &schemas_sql)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|r| r.into_iter().next().flatten())
                .collect(),
            indexes: rows_of(client, &idx_sql).await.unwrap_or_default(),
            fks: rows_of(client, &fk_sql).await.unwrap_or_default(),
            comments: Vec::new(),
            routines: rows_of(client, &routine_sql).await.unwrap_or_default(),
            sequences: rows_of(client, &seq_sql).await.unwrap_or_default(),
        };
        Ok(super::assemble(&cols, &pks, &extras))
    })
}

pub fn list_databases<'a>(
    client: &'a mut MssqlClient,
) -> futures::future::BoxFuture<'a, AppResult<Vec<DatabaseNode>>> {
    Box::pin(async move {
        let sql = "SELECT name, CASE WHEN name = DB_NAME() THEN 1 ELSE 0 END, database_id \
                   FROM sys.databases WHERE HAS_DBACCESS(name) = 1";
        let rows = rows_of(client, sql).await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = r.first().cloned().flatten()?;
                let id = r
                    .get(2)
                    .cloned()
                    .flatten()
                    .and_then(|s| s.trim().parse::<i64>().ok())
                    .unwrap_or(i64::MAX);
                Some(DatabaseNode {
                    name,
                    is_current: truthy(r.get(1).and_then(|v| v.as_ref())),
                    is_system: id <= 4,
                    size_bytes: None,
                    comment: None,
                })
            })
            .collect())
    })
}

pub fn list_server_objects<'a>(
    client: &'a mut MssqlClient,
) -> futures::future::BoxFuture<'a, AppResult<Vec<ObjectGroup>>> {
    Box::pin(async move {
        let sql = "SELECT name, LOWER(type_desc) FROM sys.server_principals \
                   WHERE type IN ('S', 'U', 'G') AND name NOT LIKE '##%' ORDER BY name";
        let logins = rows_of(client, sql).await;
        Ok(vec![make_group("Logins", logins, |r| {
            Some(ObjectItem {
                name: r.first().cloned().flatten()?,
                detail: r.get(1).cloned().flatten(),
            })
        })])
    })
}

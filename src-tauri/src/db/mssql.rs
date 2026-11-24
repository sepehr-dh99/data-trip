//! SQL Server driver (tiberius over tokio TcpStream).

use super::{
    first_keyword, float_value, hex_value, int_value, Connected, DbConn, RowSink, StreamEnd,
    TextRows,
};
use crate::error::AppResult;
use crate::model::{ColumnMeta, ConnectionConfig, SchemaNode};
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
        Ok(Connected {
            conn: DbConn::Mssql(client),
            server_version,
            default_schema,
            backend_id: None,
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

pub fn stream<'a>(
    client: &'a mut MssqlClient,
    sql: &'a str,
    sink: &'a mut dyn RowSink,
) -> futures::future::BoxFuture<'a, AppResult<StreamEnd>> {
    Box::pin(async move {
        let kw = first_keyword(sql);
        // For plain DML, append SELECT @@ROWCOUNT to learn the affected row count.
        let dml = matches!(kw.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE")
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

        while let Some(item) = qs.try_next().await? {
            match item {
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
        let mut cols = TextRows::new();
        stream(client, cols_sql, &mut cols).await?;
        let mut pks = TextRows::new();
        stream(client, pk_sql, &mut pks).await?;
        Ok(super::assemble(&cols.rows, &pks.rows))
    })
}

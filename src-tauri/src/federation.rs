//! Cross-source queries (`federated_execute`): every table the SQL references as
//! `alias.schema.table` / `alias.table` is pulled from its source over a temporary session
//! (with the projection / WHERE pushdown planned by `fedsql`), loaded into an in-memory SQLite
//! database, and the rewritten query runs there.

use crate::credentials::CredentialSource;
use crate::db::{self, DbConn};
use crate::error::{AppError, AppResult};
use crate::fedsql::{self, Dialect, PlannedTable};
use crate::model::{
    ColumnMeta, ConnectionConfig, Driver, FedResult, FedSource, FedStep, QueryResult,
};
use crate::session::Session;
use crate::store::Store;
use futures::future::BoxFuture;
use serde_json::Value;
use sqlx::Connection;
use std::collections::HashSet;
use std::time::Instant;

/// Rows pulled per table at most.
const PULL_CAP: usize = 200_000;
/// Bound parameters per INSERT (SQLite allows 32 766).
const SQLITE_MAX_VARS: usize = 32_000;
const MAX_ROWS_PER_INSERT: usize = 500;

struct Attached {
    alias: String,
    config: ConnectionConfig,
}

struct Pulled {
    table: PlannedTable,
    result: QueryResult,
    elapsed_ms: u64,
}

fn dialect_of(d: Driver) -> Option<Dialect> {
    match d {
        Driver::Postgres => Some(Dialect::Postgres),
        Driver::Mysql => Some(Dialect::Mysql),
        Driver::Sqlite => Some(Dialect::Sqlite),
        Driver::Mssql => Some(Dialect::Mssql),
        Driver::Redis | Driver::Kafka => None,
    }
}

fn valid_alias(a: &str) -> bool {
    let mut chars = a.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Prefixes an error with where it happened, unless the UI parses its leading code.
fn with_context(ctx: &str, e: AppError) -> AppError {
    let m = &e.message;
    if m.starts_with("VAULT_TOKEN_INVALID:") || m.starts_with("SSH_HOST_") {
        return e;
    }
    AppError::new(format!("{}: {}", ctx, m))
}

fn quote_sqlite(name: &str) -> String {
    fedsql::quote_raw(Dialect::Sqlite, name)
}

/// Column names made unique (SQLite compares them case-insensitively); empty names get one.
fn unique_columns(cols: &[ColumnMeta]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::with_capacity(cols.len());
    for (i, c) in cols.iter().enumerate() {
        let base = if c.name.trim().is_empty() {
            format!("column{}", i + 1)
        } else {
            c.name.clone()
        };
        let mut name = base.clone();
        let mut k = 2;
        while seen.contains(&name.to_lowercase()) {
            name = format!("{}_{}", base, k);
            k += 1;
        }
        seen.insert(name.to_lowercase());
        out.push(name);
    }
    out
}

fn looks_decimal(type_name: &str) -> bool {
    let t = type_name.to_uppercase();
    t.contains("NUMERIC") || t.contains("DECIMAL") || t.contains("MONEY") || t.contains("NUMBER")
}

fn looks_integer(type_name: &str) -> bool {
    let t = type_name.to_uppercase();
    t.contains("INT") || t.contains("SERIAL") || t.contains("BOOL") || t == "BIT"
}

fn looks_float(type_name: &str) -> bool {
    let t = type_name.to_uppercase();
    t.contains("FLOAT") || t.contains("DOUBLE") || t.contains("REAL")
}

/// SQLite column type from the pulled values: whole numbers / booleans → INTEGER, other
/// numbers → REAL, strings → TEXT (NUMERIC for exact decimals sent as text, so they compare as
/// numbers), mixed → no type (values kept as they are). All NULL → guessed from the source type.
fn column_type(rows: &[Vec<Value>], i: usize, source_type: &str) -> &'static str {
    let (mut ints, mut floats, mut strs, mut other) = (0usize, 0usize, 0usize, 0usize);
    for row in rows {
        match row.get(i) {
            None | Some(Value::Null) => {}
            Some(Value::Bool(_)) => ints += 1,
            Some(Value::Number(n)) => {
                if n.is_i64() || n.is_u64() {
                    ints += 1
                } else {
                    floats += 1
                }
            }
            Some(Value::String(_)) => strs += 1,
            Some(_) => other += 1,
        }
    }
    let numbers = ints + floats;
    if numbers == 0 && strs == 0 && other == 0 {
        return if looks_decimal(source_type) {
            "NUMERIC"
        } else if looks_integer(source_type) {
            "INTEGER"
        } else if looks_float(source_type) {
            "REAL"
        } else {
            "TEXT"
        };
    }
    if strs == 0 && other == 0 {
        return if floats > 0 { "REAL" } else { "INTEGER" };
    }
    if numbers == 0 && other == 0 {
        return if looks_decimal(source_type) {
            "NUMERIC"
        } else {
            "TEXT"
        };
    }
    ""
}

/// Opens a temporary session on one source, pulls its tables, and always closes the session.
fn pull_source<'a>(
    creds: &'a CredentialSource,
    attached: &'a Attached,
    tables: Vec<PlannedTable>,
) -> BoxFuture<'a, AppResult<Vec<Pulled>>> {
    Box::pin(async move {
        let (session, _info) = Session::open(attached.config.clone(), creds.clone())
            .await
            .map_err(|e| {
                with_context(&format!("{} ({})", attached.alias, attached.config.name), e)
            })?;
        let mut out: Vec<Pulled> = Vec::with_capacity(tables.len());
        let mut failure: Option<AppError> = None;
        for t in tables {
            let started = Instant::now();
            match session.execute(t.pull_sql.clone(), PULL_CAP + 1).await {
                Ok(r) if r.rows.len() > PULL_CAP || r.truncated => {
                    failure = Some(AppError::new(format!(
                        "{} has more than 200 000 rows. Add a WHERE filter on its columns \
                         (e.g. WHERE x.created_at >= '2024-01-01') so it can be applied at the source.",
                        t.display
                    )));
                    break;
                }
                Ok(r) if r.columns.is_empty() => {
                    failure = Some(AppError::new(format!("{} returned no columns.", t.display)));
                    break;
                }
                Ok(r) => out.push(Pulled {
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    table: t,
                    result: r,
                }),
                Err(e) => {
                    failure = Some(with_context(&t.display, e));
                    break;
                }
            }
        }
        session.close().await;
        match failure {
            Some(e) => Err(e),
            None => Ok(out),
        }
    })
}

/// Creates and fills one in-memory table (one transaction, batched multi-row INSERTs).
fn load_table<'a>(
    conn: &'a mut sqlx::SqliteConnection,
    p: &'a Pulled,
) -> BoxFuture<'a, AppResult<()>> {
    Box::pin(async move {
        let cols = unique_columns(&p.result.columns);
        let ncols = cols.len();
        if ncols == 0 {
            return Err(AppError::new("the table has no columns"));
        }
        let defs: Vec<String> = cols
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let src_type = p
                    .result
                    .columns
                    .get(i)
                    .map(|m| m.type_name.as_str())
                    .unwrap_or("");
                let ty = column_type(&p.result.rows, i, src_type);
                if ty.is_empty() {
                    quote_sqlite(c)
                } else {
                    format!("{} {}", quote_sqlite(c), ty)
                }
            })
            .collect();
        let table = quote_sqlite(&p.table.sqlite_name);
        db::sqlite::run_simple(
            conn,
            &format!("CREATE TABLE {} ({})", table, defs.join(", ")),
        )
        .await?;
        if p.result.rows.is_empty() {
            return Ok(());
        }
        let per = (SQLITE_MAX_VARS / ncols).clamp(1, MAX_ROWS_PER_INSERT);
        let tuple = format!("({})", vec!["?"; ncols].join(", "));
        db::sqlite::run_simple(conn, "BEGIN").await?;
        for chunk in p.result.rows.chunks(per) {
            let sql = format!(
                "INSERT INTO {} VALUES {}",
                table,
                vec![tuple.as_str(); chunk.len()].join(", ")
            );
            let mut params: Vec<Value> = Vec::with_capacity(chunk.len() * ncols);
            for row in chunk {
                params.extend((0..ncols).map(|i| row.get(i).cloned().unwrap_or(Value::Null)));
            }
            if let Err(e) = db::sqlite::exec_params(conn, &sql, &params).await {
                let _ = db::sqlite::run_simple(conn, "ROLLBACK").await;
                return Err(e);
            }
        }
        db::sqlite::run_simple(conn, "COMMIT").await
    })
}

/// Loads the pulled tables into a fresh in-memory SQLite database and runs the query there.
fn run_in_memory<'a>(
    pulled: &'a [Pulled],
    sql: &'a str,
    max_rows: usize,
) -> BoxFuture<'a, AppResult<QueryResult>> {
    Box::pin(async move {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await?;
        for p in pulled {
            if let Err(e) = load_table(&mut conn, p).await {
                db::sqlite::close(conn).await;
                return Err(with_context(
                    &format!("Loading {} into memory", p.table.display),
                    e,
                ));
            }
        }
        let mut dbc = DbConn::Sqlite(conn);
        let res = dbc.execute(sql, max_rows).await;
        dbc.close().await;
        res
    })
}

/// Runs one SELECT / WITH across several data sources (see CONTRACT.md v0.10).
pub fn federated_execute<'a>(
    store: &'a Store,
    creds: &'a CredentialSource,
    sources: Vec<FedSource>,
    sql: String,
    max_rows: usize,
) -> BoxFuture<'a, AppResult<FedResult>> {
    Box::pin(async move {
        let started = Instant::now();
        if sources.is_empty() {
            return Err(AppError::new(
                "Attach at least one data source to run a cross-source query.",
            ));
        }
        let mut attached: Vec<Attached> = Vec::with_capacity(sources.len());
        let mut aliases: Vec<(String, Dialect)> = Vec::with_capacity(sources.len());
        let mut seen: HashSet<String> = HashSet::new();
        for s in &sources {
            let alias = s.alias.trim().to_string();
            if !valid_alias(&alias) {
                return Err(AppError::new(format!(
                    "'{}' is not a valid source alias (letters, digits and _, not starting with a digit).",
                    alias
                )));
            }
            if !seen.insert(alias.to_lowercase()) {
                return Err(AppError::new(format!(
                    "The source alias '{}' is used twice.",
                    alias
                )));
            }
            let mut config = store.get_connection(&s.connection_id).await?;
            let dialect = match dialect_of(config.driver) {
                Some(d) => d,
                None => {
                    return Err(AppError::new(format!(
                        "Cross-source queries support PostgreSQL, MySQL, SQLite and SQL Server; \
                         '{}' ({}) is not one of them.",
                        config.name, alias
                    )))
                }
            };
            if config.driver != Driver::Sqlite {
                if let Some(db) = s
                    .database
                    .as_deref()
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                {
                    config.database = Some(db.to_string());
                }
            }
            aliases.push((alias.clone(), dialect));
            attached.push(Attached { alias, config });
        }

        let plan = fedsql::plan(&sql, &aliases).map_err(AppError::new)?;

        // One temporary session per referenced source; sources are pulled concurrently.
        let mut jobs = Vec::new();
        for a in &attached {
            let tables: Vec<PlannedTable> = plan
                .tables
                .iter()
                .filter(|t| t.source == a.alias.to_lowercase())
                .cloned()
                .collect();
            if !tables.is_empty() {
                jobs.push(pull_source(creds, a, tables));
            }
        }
        let outcomes = futures::future::join_all(jobs).await;
        let mut pulled: Vec<Pulled> = Vec::new();
        for o in outcomes {
            pulled.extend(o?);
        }

        let mut steps: Vec<FedStep> = Vec::with_capacity(pulled.len() + 1);
        for p in &pulled {
            let a = attached
                .iter()
                .find(|a| a.alias.to_lowercase() == p.table.source);
            steps.push(FedStep {
                alias: a.map(|a| a.alias.clone()).unwrap_or_default(),
                connection_id: a.map(|a| a.config.id.clone()).unwrap_or_default(),
                source_name: a.map(|a| a.config.name.clone()).unwrap_or_default(),
                sql: p.table.pull_sql.clone(),
                rows: p.result.rows.len() as u64,
                elapsed_ms: p.elapsed_ms,
            });
        }

        let join_started = Instant::now();
        let mut result = run_in_memory(&pulled, &plan.sql, max_rows).await?;
        let n = pulled.len();
        steps.push(FedStep {
            alias: String::new(),
            connection_id: String::new(),
            source_name: "DataTrip".to_string(),
            sql: format!(
                "join \u{b7} {} {} (in memory)",
                n,
                if n == 1 { "table" } else { "tables" }
            ),
            rows: result.rows.len() as u64,
            elapsed_ms: join_started.elapsed().as_millis() as u64,
        });
        result.statement = sql.trim().to_string();
        result.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(FedResult {
            result,
            plan: steps,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn column_types_follow_values() {
        let rows = vec![
            vec![
                json!(1),
                json!(1.5),
                json!("a"),
                json!(null),
                json!("12.50"),
                json!(true),
            ],
            vec![
                json!(2),
                json!(2),
                json!("b"),
                json!(null),
                json!("3"),
                json!(false),
            ],
        ];
        assert_eq!(column_type(&rows, 0, "int4"), "INTEGER");
        assert_eq!(column_type(&rows, 1, "float8"), "REAL");
        assert_eq!(column_type(&rows, 2, "text"), "TEXT");
        assert_eq!(column_type(&rows, 3, "int8"), "INTEGER");
        assert_eq!(column_type(&rows, 4, "numeric"), "NUMERIC");
        assert_eq!(column_type(&rows, 4, "varchar"), "TEXT");
        assert_eq!(column_type(&rows, 5, "bool"), "INTEGER");
        let mixed = vec![vec![json!(1)], vec![json!("x")]];
        assert_eq!(column_type(&mixed, 0, "sql_variant"), "");
    }

    #[test]
    fn unique_column_names() {
        let cols = vec![
            ColumnMeta {
                name: "id".to_string(),
                type_name: "int".to_string(),
            },
            ColumnMeta {
                name: "ID".to_string(),
                type_name: "int".to_string(),
            },
            ColumnMeta {
                name: String::new(),
                type_name: "int".to_string(),
            },
        ];
        assert_eq!(unique_columns(&cols), vec!["id", "ID_2", "column3"]);
    }

    #[test]
    fn aliases() {
        assert!(valid_alias("pg"));
        assert!(valid_alias("_x1"));
        assert!(!valid_alias("1x"));
        assert!(!valid_alias("a-b"));
        assert!(!valid_alias(""));
    }
}

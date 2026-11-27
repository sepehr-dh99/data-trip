//! Cross-source queries (`federated_execute`): every table the SQL references as
//! `source.database.table` / `source.database.schema.table` (or the older `alias.schema.table` /
//! `alias.table`) is pulled from its source over a temporary session per (source, database)
//! (with the projection / WHERE pushdown planned by `fedsql`), loaded into an in-memory SQLite
//! database, and the rewritten query runs there.

use crate::credentials::CredentialSource;
use crate::db::{self, DbConn};
use crate::error::{AppError, AppResult};
use crate::fedsql::{self, Dialect, Middle, Name, PlannedTable, SourceDef};
use crate::model::{
    ColumnMeta, ConnectionConfig, Driver, FedResult, FedSource, FedStep, QueryResult,
};
use crate::session::Session;
use crate::store::Store;
use futures::future::BoxFuture;
use serde_json::Value;
use sqlx::Connection;
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

/// Rows pulled per table at most.
const PULL_CAP: usize = 200_000;
/// Bound parameters per INSERT (SQLite allows 32 766).
const SQLITE_MAX_VARS: usize = 32_000;
const MAX_ROWS_PER_INSERT: usize = 500;

/// One (connection, database) pair the UI sent, with every alias it answers to.
struct Src {
    aliases: Vec<String>,
    /// The connection with `database` overridden by the FedSource's database.
    config: ConnectionConfig,
    dialect: Dialect,
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

/// A temporary session and the database it is connected to.
struct Open {
    session: Arc<Session>,
    database: Option<String>,
}

/// Opens a temporary session on a source, on `database` instead of its default when given.
fn open_session<'a>(
    creds: &'a CredentialSource,
    src: &'a Src,
    database: Option<&'a str>,
) -> BoxFuture<'a, AppResult<Open>> {
    Box::pin(async move {
        let mut config = src.config.clone();
        if let Some(db) = database {
            config.database = Some(db.to_string());
        }
        let ctx = match database {
            Some(db) => format!("{} \u{b7} {}", src.config.name, db),
            None => src.config.name.clone(),
        };
        let fallback = config.database.clone();
        let (session, info) = Session::open(config, creds.clone())
            .await
            .map_err(|e| with_context(&ctx, e))?;
        Ok(Open {
            session,
            database: info.database.or(fallback),
        })
    })
}

async fn close_all(open: HashMap<usize, Open>) {
    for o in open.into_values() {
        o.session.close().await;
    }
}

/// Pulls the tables of one (source, database) pair over `open` (else a new temporary session) and always
/// closes the session. Returns the rows and the database they came from.
fn pull_group<'a>(
    creds: &'a CredentialSource,
    src: &'a Src,
    database: Option<String>,
    open: Option<Open>,
    tables: Vec<PlannedTable>,
) -> BoxFuture<'a, AppResult<(Vec<Pulled>, Option<String>)>> {
    Box::pin(async move {
        let open = match open {
            Some(o) => o,
            None => open_session(creds, src, database.as_deref()).await?,
        };
        let session = &open.session;
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
            None => Ok((out, open.database)),
        }
    })
}

/// Schemas of the session's database (PostgreSQL / SQL Server), lower case.
fn list_schemas<'a>(
    session: &'a Arc<Session>,
    d: Dialect,
) -> BoxFuture<'a, AppResult<Vec<String>>> {
    Box::pin(async move {
        let sql = match d {
            Dialect::Postgres => "SELECT nspname FROM pg_catalog.pg_namespace",
            Dialect::Mssql => "SELECT name FROM sys.schemas",
            Dialect::Mysql | Dialect::Sqlite => return Ok(Vec::new()),
        };
        let r = session.execute(sql.to_string(), 100_000).await?;
        Ok(r.rows
            .iter()
            .filter_map(|row| row.first().and_then(Value::as_str).map(str::to_lowercase))
            .collect())
    })
}

/// Middle-part answers keyed by (source id, lower-case part).
type Answers = HashMap<(usize, String), Result<Middle, String>>;

/// Decides database vs schema for every `source.x.table` middle part: `x` is a database when the server
/// lists one of that name (case-insensitive; database list cached per run), else a schema of the source's
/// default database when that has one, else an error. Opens (and keeps in `open`) one session per source
/// on its default database.
fn classify_middles<'a>(
    creds: &'a CredentialSource,
    srcs: &'a [Src],
    requests: Vec<(usize, Name)>,
    open: &'a mut HashMap<usize, Open>,
) -> BoxFuture<'a, AppResult<Answers>> {
    Box::pin(async move {
        let mut answers: Answers = HashMap::new();
        let mut databases: HashMap<usize, Vec<String>> = HashMap::new();
        let mut schemas: HashMap<usize, Vec<String>> = HashMap::new();
        for (id, name) in requests {
            let src = &srcs[id];
            let session = match open.get(&id) {
                Some(o) => o.session.clone(),
                None => {
                    let o = open_session(creds, src, None).await?;
                    let s = o.session.clone();
                    open.insert(id, o);
                    s
                }
            };
            if let Entry::Vacant(v) = databases.entry(id) {
                let list = session.list_databases().await.map_err(|e| {
                    with_context(&format!("Listing the databases of {}", src.config.name), e)
                })?;
                v.insert(list.into_iter().map(|d| d.name).collect());
            }
            let low = name.text.to_lowercase();
            let exact = databases
                .get(&id)
                .and_then(|l| l.iter().find(|d| d.to_lowercase() == low).cloned());
            let answer = match exact {
                Some(db) => Ok(Middle::Database(db)),
                None => {
                    if let Entry::Vacant(v) = schemas.entry(id) {
                        let list = list_schemas(&session, src.dialect).await.map_err(|e| {
                            with_context(&format!("Listing the schemas of {}", src.config.name), e)
                        })?;
                        v.insert(list);
                    }
                    if schemas.get(&id).is_some_and(|l| l.contains(&low)) {
                        Ok(Middle::Schema)
                    } else {
                        Err(format!(
                            "'{}' is neither a database nor a schema on {}",
                            name.text, src.config.name
                        ))
                    }
                }
            };
            answers.insert((id, low), answer);
        }
        Ok(answers)
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

/// Merges the UI's sources into (connection, database) pairs; each pair answers to all of its aliases,
/// the first pair of a connection also to the data source's exact name (and its slug).
fn merge_sources(entries: Vec<(FedSource, ConnectionConfig)>) -> AppResult<Vec<Src>> {
    let mut srcs: Vec<Src> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (s, mut config) in entries {
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
        let db_key = |c: &ConnectionConfig| c.database.as_deref().unwrap_or("").to_lowercase();
        match srcs
            .iter()
            .position(|x| x.config.id == config.id && db_key(&x.config) == db_key(&config))
        {
            Some(i) => srcs[i].aliases.push(alias),
            None => srcs.push(Src {
                aliases: vec![alias],
                config,
                dialect,
            }),
        }
    }
    Ok(srcs)
}

fn source_defs(srcs: &[Src]) -> Vec<SourceDef> {
    let mut named: HashSet<&str> = HashSet::new();
    srcs.iter()
        .map(|s| SourceDef {
            label: s.config.name.clone(),
            dialect: s.dialect,
            aliases: s.aliases.clone(),
            names: if named.insert(s.config.id.as_str()) {
                vec![s.config.name.clone()]
            } else {
                Vec::new()
            },
        })
        .collect()
}

/// Runs one SELECT / WITH across several data sources (see CONTRACT.md v0.10 and v0.13).
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
                "Refer to at least one data source to run a cross-source query.",
            ));
        }
        let mut entries: Vec<(FedSource, ConnectionConfig)> = Vec::with_capacity(sources.len());
        for s in sources {
            let config = store.get_connection(&s.connection_id).await?;
            entries.push((s, config));
        }
        let srcs = merge_sources(entries)?;
        let defs = source_defs(&srcs);

        // `source.x.table` on PostgreSQL / SQL Server: is x a database or a schema? Ask the servers.
        let requests = fedsql::middle_parts(&sql, &defs).map_err(AppError::new)?;
        let mut open: HashMap<usize, Open> = HashMap::new();
        let answers = if requests.is_empty() {
            HashMap::new()
        } else {
            match classify_middles(creds, &srcs, requests, &mut open).await {
                Ok(a) => a,
                Err(e) => {
                    close_all(open).await;
                    return Err(e);
                }
            }
        };
        let classify = |id: usize, n: &Name| -> Result<Middle, String> {
            answers
                .get(&(id, n.text.to_lowercase()))
                .cloned()
                .unwrap_or(Ok(Middle::Schema))
        };
        let plan = match fedsql::plan(&sql, &defs, &classify) {
            Ok(p) => p,
            Err(e) => {
                close_all(open).await;
                return Err(AppError::new(e));
            }
        };

        // One temporary session per (source, database) pair; pairs are pulled concurrently. A session
        // opened for the database list is reused for its source's default database.
        let mut groups: Vec<(usize, Option<String>, Vec<PlannedTable>)> = Vec::new();
        for t in &plan.tables {
            let default_db = open
                .get(&t.source)
                .and_then(|o| o.database.clone())
                .or_else(|| srcs[t.source].config.database.clone());
            // The source's default database by name → the default pair (one session less).
            let db = t.database.clone().filter(|d| {
                !matches!(default_db.as_deref(), Some(x) if x.to_lowercase() == d.to_lowercase())
            });
            let key = db.as_ref().map(|d| d.to_lowercase());
            match groups
                .iter()
                .position(|g| g.0 == t.source && g.1.as_ref().map(|d| d.to_lowercase()) == key)
            {
                Some(i) => groups[i].2.push(t.clone()),
                None => groups.push((t.source, db, vec![t.clone()])),
            }
        }
        let mut jobs = Vec::with_capacity(groups.len());
        for (id, db, tables) in groups {
            let reuse = if db.is_none() { open.remove(&id) } else { None };
            jobs.push(pull_group(creds, &srcs[id], db, reuse, tables));
        }
        close_all(open).await;
        let outcomes = futures::future::join_all(jobs).await;
        let mut pulled: Vec<(Pulled, Option<String>)> = Vec::new();
        let mut failure: Option<AppError> = None;
        for o in outcomes {
            match o {
                Ok((ps, db)) => pulled.extend(ps.into_iter().map(|p| (p, db.clone()))),
                Err(e) => {
                    if failure.is_none() {
                        failure = Some(e);
                    }
                }
            }
        }
        if let Some(e) = failure {
            return Err(e);
        }

        let mut steps: Vec<FedStep> = Vec::with_capacity(pulled.len() + 1);
        for (p, db) in &pulled {
            let src = &srcs[p.table.source];
            steps.push(FedStep {
                alias: p.table.alias.clone(),
                connection_id: src.config.id.clone(),
                source_name: src.config.name.clone(),
                database: db.clone(),
                sql: p.table.pull_sql.clone(),
                rows: p.result.rows.len() as u64,
                elapsed_ms: p.elapsed_ms,
            });
        }
        let pulled: Vec<Pulled> = pulled.into_iter().map(|(p, _)| p).collect();

        let join_started = Instant::now();
        let mut result = run_in_memory(&pulled, &plan.sql, max_rows).await?;
        let n = pulled.len();
        steps.push(FedStep {
            alias: String::new(),
            connection_id: String::new(),
            source_name: "DataTrip".to_string(),
            database: None,
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

//! Show DDL and table extras (v0.16). Catalog queries run on an existing session through
//! `Session::execute` (one statement each, no history), so nothing here is reachable from inside a
//! session job; the text assembly lives in the std-only `ddlgen` module.

use crate::db;
use crate::ddlgen::{self, DdlOpts};
use crate::error::{AppError, AppResult};
use crate::model::Driver;
use crate::session::Session;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

fn yes() -> bool {
    true
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct DdlOptions {
    #[serde(default = "yes")]
    pub indexes: bool,
    #[serde(default = "yes")]
    pub comments: bool,
    #[serde(default = "yes")]
    pub qualified: bool,
}

impl Default for DdlOptions {
    fn default() -> Self {
        DdlOptions {
            indexes: true,
            comments: true,
            qualified: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlRequest {
    /// "table" | "view" | "materialized" | "function" | "procedure" | "sequence" | "index"
    pub kind: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    /// Routines: the argument list as the explorer shows it (picks one overload).
    #[serde(default)]
    pub arguments: Option<String>,
    /// Indexes: the table the index belongs to.
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub options: DdlOptions,
}

type Rows = Vec<Vec<Option<String>>>;

async fn rows(session: &Arc<Session>, sql: String) -> AppResult<Rows> {
    let r = session.execute(sql, 100_000).await?;
    Ok(r.rows
        .iter()
        .map(|row| row.iter().map(db::value_to_opt_string).collect())
        .collect())
}

fn cell(r: &[Option<String>], i: usize) -> Option<String> {
    r.get(i).cloned().flatten()
}

fn text(r: &[Option<String>], i: usize) -> String {
    cell(r, i).unwrap_or_default()
}

fn flag(r: &[Option<String>], i: usize) -> bool {
    matches!(
        cell(r, i).as_deref(),
        Some("1") | Some("t") | Some("true") | Some("TRUE") | Some("True")
    )
}

/// A string literal for catalog lookups ('…', quotes doubled; MySQL also escapes backslashes).
fn lit(d: Driver, s: &str) -> String {
    match d {
        Driver::Mysql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        Driver::Mssql => format!("N'{}'", s.replace('\'', "''")),
        _ => format!("'{}'", s.replace('\'', "''")),
    }
}

fn not_found(kind: &str, name: &str) -> AppError {
    AppError::new(format!(
        "{} {} was not found (it may have been dropped or renamed). Refresh the explorer.",
        kind, name
    ))
}

/// The CREATE statement(s) of one database object, per driver (see CONTRACT.md v0.16).
#[tauri::command]
pub async fn get_ddl(
    state: State<'_, AppState>,
    session_id: String,
    request: DdlRequest,
) -> AppResult<String> {
    let session = state.sessions.get(&session_id)?;
    let o = DdlOpts {
        indexes: request.options.indexes,
        comments: request.options.comments,
        qualified: request.options.qualified,
    };
    let out = match session.config.driver {
        Driver::Postgres => pg_ddl(&session, &request, o).await?,
        Driver::Mysql => mysql_ddl(&session, &request, o).await?,
        Driver::Sqlite => sqlite_ddl(&session, &request).await?,
        Driver::Mssql => ms_ddl(&session, &request, o).await?,
        Driver::Redis | Driver::Kafka => {
            return Err(AppError::new(
                "Show DDL works with PostgreSQL, MySQL, SQLite and SQL Server data sources.",
            ))
        }
    };
    Ok(out.trim_end().to_string() + "\n")
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

async fn pg_version(session: &Arc<Session>) -> i64 {
    rows(session, "SHOW server_version_num".into())
        .await
        .ok()
        .and_then(|r| r.first().and_then(|x| cell(x, 0)))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(120_000)
}

fn norm_args(s: &str) -> String {
    let t = s.trim();
    let t = t
        .strip_prefix('(')
        .and_then(|x| x.strip_suffix(')'))
        .unwrap_or(t);
    t.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

async fn pg_ddl(session: &Arc<Session>, req: &DdlRequest, o: DdlOpts) -> AppResult<String> {
    let d = Driver::Postgres;
    let schema = req.schema.clone().unwrap_or_else(|| "public".into());
    match req.kind.as_str() {
        "function" | "procedure" => return pg_routine(session, &schema, req, o).await,
        "index" => {
            let r = rows(
                session,
                format!(
                    "SELECT pg_get_indexdef(c.oid) FROM pg_catalog.pg_class c \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = {} AND c.relname = {} AND c.relkind IN ('i', 'I')",
                    lit(d, &schema),
                    lit(d, &req.name)
                ),
            )
            .await?;
            let def = r
                .first()
                .and_then(|x| cell(x, 0))
                .ok_or_else(|| not_found("Index", &req.name))?;
            let def = if o.qualified {
                def
            } else {
                ddlgen::pg_unqualify_index(&def, &schema)
            };
            return Ok(ddlgen::finish_statement(&def));
        }
        _ => {}
    }
    let head = rows(
        session,
        format!(
            "SELECT c.oid::text, c.relkind::text, obj_description(c.oid, 'pg_class'), c.relpersistence::text \
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {} AND c.relname = {}",
            lit(d, &schema),
            lit(d, &req.name)
        ),
    )
    .await?;
    let h = head.first().ok_or_else(|| not_found("Object", &req.name))?;
    let oid = text(h, 0);
    if oid.is_empty() || !oid.chars().all(|c| c.is_ascii_digit()) {
        return Err(not_found("Object", &req.name));
    }
    let relkind = text(h, 1);
    let comment = cell(h, 2);
    match relkind.as_str() {
        "v" | "m" => {
            let body = rows(
                session,
                format!("SELECT pg_get_viewdef({}::oid, true)", oid),
            )
            .await?;
            let body = body.first().and_then(|x| cell(x, 0)).unwrap_or_default();
            let mat = relkind == "m";
            let mut out =
                ddlgen::pg_view_ddl(&schema, &req.name, mat, &body, comment.as_deref(), o);
            if mat && o.indexes {
                let idx = pg_indexes(session, &oid).await.unwrap_or_default();
                if !idx.is_empty() {
                    out.push('\n');
                    for i in idx {
                        let def = if o.qualified {
                            i
                        } else {
                            ddlgen::pg_unqualify_index(&i, &schema)
                        };
                        out.push_str(ddlgen::strip_semicolon(&def));
                        out.push_str(";\n");
                    }
                }
            }
            Ok(out)
        }
        "S" => pg_sequence(session, &schema, &req.name, &oid, comment.as_deref(), o).await,
        "r" | "p" | "f" => {
            let version = pg_version(session).await;
            let identity = if version >= 100_000 {
                "a.attidentity::text"
            } else {
                "''"
            };
            let generated = if version >= 120_000 {
                "a.attgenerated::text"
            } else {
                "''"
            };
            let cols = rows(
                session,
                format!(
                    "SELECT a.attname, format_type(a.atttypid, a.atttypmod), \
                            CASE WHEN a.attnotnull THEN '1' ELSE '0' END, \
                            pg_get_expr(d.adbin, d.adrelid), {}, {}, \
                            CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation \
                                 THEN (SELECT co.collname FROM pg_catalog.pg_collation co WHERE co.oid = a.attcollation) END, \
                            col_description(a.attrelid, a.attnum) \
                     FROM pg_catalog.pg_attribute a \
                     JOIN pg_catalog.pg_type t ON t.oid = a.atttypid \
                     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                     WHERE a.attrelid = {}::oid AND a.attnum > 0 AND NOT a.attisdropped \
                     ORDER BY a.attnum",
                    identity, generated, oid
                ),
            )
            .await?;
            let columns: Vec<ddlgen::PgColumn> = cols
                .iter()
                .map(|r| {
                    let ident = text(r, 4).chars().next().filter(|c| *c == 'a' || *c == 'd');
                    ddlgen::PgColumn {
                        name: text(r, 0),
                        type_name: text(r, 1),
                        not_null: flag(r, 2),
                        default: cell(r, 3),
                        identity: ident,
                        generated: text(r, 5) == "s",
                        collation: cell(r, 6).filter(|c| c != "default"),
                        comment: cell(r, 7),
                    }
                })
                .collect();
            let cons = rows(
                session,
                format!(
                    "SELECT conname, pg_get_constraintdef(oid, true) FROM pg_catalog.pg_constraint \
                     WHERE conrelid = {}::oid AND contype IN ('p', 'u', 'c', 'f', 'x') \
                     ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, conname",
                    oid
                ),
            )
            .await?;
            let constraints: Vec<ddlgen::PgConstraint> = cons
                .iter()
                .map(|r| ddlgen::PgConstraint {
                    name: text(r, 0),
                    def: text(r, 1),
                })
                .collect();
            let indexes = if o.indexes {
                pg_indexes(session, &oid).await.unwrap_or_default()
            } else {
                Vec::new()
            };
            let partition_by = if relkind == "p" {
                rows(session, format!("SELECT pg_get_partkeydef({}::oid)", oid))
                    .await
                    .ok()
                    .and_then(|r| r.first().and_then(|x| cell(x, 0)))
            } else {
                None
            };
            let t = ddlgen::PgTable {
                schema: &schema,
                name: &req.name,
                unlogged: text(h, 3) == "u",
                partition_by,
                columns: &columns,
                constraints: &constraints,
                indexes: &indexes,
                comment,
            };
            let mut out = ddlgen::pg_table_ddl(&t, o);
            if relkind == "f" {
                out = format!(
                    "-- Foreign table: the server and options are not shown\n{}",
                    out.replacen("CREATE TABLE", "CREATE FOREIGN TABLE", 1)
                );
            }
            Ok(out)
        }
        other => Err(AppError::new(format!(
            "Show DDL doesn't support this kind of object (relkind '{}').",
            other
        ))),
    }
}

async fn pg_indexes(session: &Arc<Session>, oid: &str) -> AppResult<Vec<String>> {
    let r = rows(
        session,
        format!(
            "SELECT pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
             WHERE i.indrelid = {}::oid AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c \
               WHERE c.conindid = i.indexrelid AND c.conrelid = i.indrelid AND c.contype IN ('p', 'u', 'x')) \
             ORDER BY ic.relname",
            oid
        ),
    )
    .await?;
    Ok(r.iter().filter_map(|x| cell(x, 0)).collect())
}

async fn pg_sequence(
    session: &Arc<Session>,
    schema: &str,
    name: &str,
    oid: &str,
    comment: Option<&str>,
    o: DdlOpts,
) -> AppResult<String> {
    let r = rows(
        session,
        format!(
            "SELECT format_type(s.seqtypid, NULL), s.seqstart::text, s.seqincrement::text, s.seqmin::text, \
                    s.seqmax::text, s.seqcache::text, CASE WHEN s.seqcycle THEN '1' ELSE '0' END \
             FROM pg_catalog.pg_sequence s WHERE s.seqrelid = {}::oid",
            oid
        ),
    )
    .await
    .map_err(|e| AppError::new(format!("Couldn't read the sequence (PostgreSQL 10 or newer is needed): {}", e.message)))?;
    let s = r.first().ok_or_else(|| not_found("Sequence", name))?;
    let owner = rows(
        session,
        format!(
            "SELECT tn.nspname, t.relname, a.attname FROM pg_catalog.pg_depend d \
             JOIN pg_catalog.pg_class t ON t.oid = d.refobjid \
             JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
             WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = {}::oid AND d.deptype IN ('a', 'i') LIMIT 1",
            oid
        ),
    )
    .await
    .unwrap_or_default();
    let owned_by = owner.first().map(|x| {
        format!(
            "{}.{}",
            ddlgen::pg_qname(&text(x, 0), &text(x, 1), o.qualified),
            ddlgen::pg_ident(&text(x, 2))
        )
    });
    let seq = ddlgen::PgSequence {
        type_name: text(s, 0),
        start: text(s, 1),
        increment: text(s, 2),
        min: text(s, 3),
        max: text(s, 4),
        cache: text(s, 5),
        cycle: flag(s, 6),
        owned_by,
    };
    Ok(ddlgen::pg_sequence_ddl(schema, name, &seq, comment, o))
}

async fn pg_routine(
    session: &Arc<Session>,
    schema: &str,
    req: &DdlRequest,
    o: DdlOpts,
) -> AppResult<String> {
    let d = Driver::Postgres;
    let list = rows(
        session,
        format!(
            "SELECT p.oid::text, pg_get_function_identity_arguments(p.oid), obj_description(p.oid, 'pg_proc') \
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {} AND p.proname = {} ORDER BY p.oid",
            lit(d, schema),
            lit(d, &req.name)
        ),
    )
    .await?;
    if list.is_empty() {
        return Err(not_found("Routine", &req.name));
    }
    let wanted = req.arguments.as_deref().map(norm_args);
    let mut pick: Vec<&Vec<Option<String>>> = list
        .iter()
        .filter(|r| match &wanted {
            Some(w) => norm_args(&text(r, 1)) == *w,
            None => true,
        })
        .collect();
    if pick.is_empty() {
        pick = list.iter().collect();
    }
    let word = if req.kind == "procedure" {
        "PROCEDURE"
    } else {
        "FUNCTION"
    };
    let mut parts: Vec<String> = Vec::new();
    for r in pick {
        let oid = text(r, 0);
        if !oid.chars().all(|c| c.is_ascii_digit()) || oid.is_empty() {
            continue;
        }
        let def = match rows(session, format!("SELECT pg_get_functiondef({}::oid)", oid)).await {
            Ok(x) => x.first().and_then(|y| cell(y, 0)).unwrap_or_default(),
            Err(e) => format!("-- {}({}): {}\n", req.name, text(r, 1), e.message),
        };
        let def = if o.qualified {
            def
        } else {
            ddlgen::pg_unqualify_routine(&def, schema)
        };
        let mut s = ddlgen::finish_statement(&def);
        if o.comments {
            if let Some(c) = cell(r, 2) {
                s.push_str(&format!(
                    "\nCOMMENT ON {} {}({}) IS {};\n",
                    word,
                    ddlgen::pg_qname(schema, &req.name, o.qualified),
                    text(r, 1),
                    ddlgen::sql_string(&c)
                ));
            }
        }
        parts.push(s);
    }
    Ok(parts.join("\n"))
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

fn my_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

async fn mysql_ddl(session: &Arc<Session>, req: &DdlRequest, o: DdlOpts) -> AppResult<String> {
    let d = Driver::Mysql;
    let db_name = match req.schema.clone().filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => {
            let r = rows(session, "SELECT DATABASE()".into()).await?;
            r.first().and_then(|x| cell(x, 0)).unwrap_or_default()
        }
    };
    let q = format!("{}.{}", my_ident(&db_name), my_ident(&req.name));
    match req.kind.as_str() {
        "table" => {
            let r = rows(session, format!("SHOW CREATE TABLE {}", q)).await?;
            let mut s = r
                .first()
                .and_then(|x| cell(x, 1))
                .ok_or_else(|| not_found("Table", &req.name))?;
            if !o.indexes {
                s = ddlgen::strip_mysql_indexes(&s);
            }
            if !o.comments {
                s = ddlgen::strip_mysql_comments(&s);
            }
            if o.qualified {
                s = ddlgen::mysql_qualify(&s, "TABLE", &req.name, &db_name);
            }
            Ok(ddlgen::finish_statement(&s))
        }
        "view" | "materialized" => {
            let r = rows(session, format!("SHOW CREATE VIEW {}", q)).await?;
            let mut s = r
                .first()
                .and_then(|x| cell(x, 1))
                .ok_or_else(|| not_found("View", &req.name))?;
            if o.qualified {
                s = ddlgen::mysql_qualify(&s, "VIEW", &req.name, &db_name);
            }
            Ok(ddlgen::finish_statement(&s))
        }
        "function" | "procedure" => {
            let word = if req.kind == "procedure" {
                "PROCEDURE"
            } else {
                "FUNCTION"
            };
            let r = rows(session, format!("SHOW CREATE {} {}", word, q)).await?;
            let s = r.first().and_then(|x| cell(x, 2)).ok_or_else(|| {
                AppError::new(format!(
                    "MySQL didn't return the body of {} — you may lack the privilege to see it (SHOW_ROUTINE or being its definer).",
                    req.name
                ))
            })?;
            let mut s = s;
            if !o.comments {
                s = ddlgen::strip_mysql_comments(&s);
            }
            if o.qualified {
                s = ddlgen::mysql_qualify(&s, word, &req.name, &db_name);
            }
            // A routine body has its own semicolons: show it with a DELIMITER, as a client would run it.
            Ok(format!("DELIMITER ;;\n{}\n;;\nDELIMITER ;\n", s.trim_end()))
        }
        "index" => {
            let table = req
                .table
                .clone()
                .ok_or_else(|| AppError::new("Show DDL of an index needs its table"))?;
            let where_ = format!(
                "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND INDEX_NAME = {} ORDER BY SEQ_IN_INDEX",
                lit(d, &db_name),
                lit(d, &table),
                lit(d, &req.name)
            );
            let r = match rows(
                session,
                format!("SELECT CAST(NON_UNIQUE AS CHAR), COLUMN_NAME, INDEX_TYPE, CAST(SUB_PART AS CHAR), EXPRESSION {}", where_),
            )
            .await
            {
                Ok(r) => r,
                // MySQL < 8.0.13 / MariaDB: no EXPRESSION column.
                Err(_) => {
                    rows(
                        session,
                        format!("SELECT CAST(NON_UNIQUE AS CHAR), COLUMN_NAME, INDEX_TYPE, CAST(SUB_PART AS CHAR) {}", where_),
                    )
                    .await?
                }
            };
            let first = r.first().ok_or_else(|| not_found("Index", &req.name))?;
            let tq = if o.qualified {
                format!("{}.{}", my_ident(&db_name), my_ident(&table))
            } else {
                my_ident(&table)
            };
            let cols: Vec<String> = r
                .iter()
                .map(|x| match (cell(x, 1), cell(x, 4)) {
                    (Some(c), _) => match cell(x, 3) {
                        Some(n) if !n.is_empty() => format!("{}({})", my_ident(&c), n),
                        _ => my_ident(&c),
                    },
                    (None, Some(e)) => format!("({})", e),
                    (None, None) => "?".into(),
                })
                .collect();
            if req.name == "PRIMARY" {
                return Ok(format!(
                    "ALTER TABLE {} ADD PRIMARY KEY ({});\n",
                    tq,
                    cols.join(", ")
                ));
            }
            let itype = text(first, 2).to_uppercase();
            let prefix = if text(first, 0) == "0" {
                "UNIQUE "
            } else if itype == "FULLTEXT" || itype == "SPATIAL" {
                if itype == "FULLTEXT" {
                    "FULLTEXT "
                } else {
                    "SPATIAL "
                }
            } else {
                ""
            };
            Ok(format!(
                "CREATE {}INDEX {} ON {} ({});\n",
                prefix,
                my_ident(&req.name),
                tq,
                cols.join(", ")
            ))
        }
        "sequence" => {
            // MariaDB sequences.
            let r = rows(session, format!("SHOW CREATE SEQUENCE {}", q)).await?;
            let s = r
                .first()
                .and_then(|x| cell(x, 1))
                .ok_or_else(|| not_found("Sequence", &req.name))?;
            Ok(ddlgen::finish_statement(&s))
        }
        other => Err(AppError::new(format!(
            "Show DDL doesn't support '{}' objects on MySQL.",
            other
        ))),
    }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async fn sqlite_ddl(session: &Arc<Session>, req: &DdlRequest) -> AppResult<String> {
    let d = Driver::Sqlite;
    let schema = req
        .schema
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "main".into());
    let master = format!("{}.sqlite_master", db::quote_ident(d, &schema));
    if req.kind == "index" {
        let r = rows(
            session,
            format!(
                "SELECT sql FROM {} WHERE type = 'index' AND name = {}",
                master,
                lit(d, &req.name)
            ),
        )
        .await?;
        let row = r.first().ok_or_else(|| not_found("Index", &req.name))?;
        return Ok(match cell(row, 0) {
            Some(s) => ddlgen::finish_statement(&s),
            None => format!("-- {} is created automatically for a PRIMARY KEY or UNIQUE constraint of the table.\n", req.name),
        });
    }
    let r = rows(
        session,
        format!(
            "SELECT sql FROM {} WHERE type IN ('table', 'view') AND name = {}",
            master,
            lit(d, &req.name)
        ),
    )
    .await?;
    let main = r
        .first()
        .and_then(|x| cell(x, 0))
        .ok_or_else(|| not_found("Object", &req.name))?;
    let mut out = ddlgen::finish_statement(&main);
    let extra = rows(
        session,
        format!(
            "SELECT sql FROM {} WHERE type IN ('index', 'trigger') AND tbl_name = {} AND sql IS NOT NULL \
             ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name",
            master,
            lit(d, &req.name)
        ),
    )
    .await
    .unwrap_or_default();
    let ix: Vec<String> = extra
        .iter()
        .filter_map(|x| cell(x, 0))
        .filter(|s| {
            let up = s.trim_start().to_uppercase();
            let is_index = up.starts_with("CREATE INDEX") || up.starts_with("CREATE UNIQUE INDEX");
            req.options.indexes || !is_index
        })
        .map(|s| ddlgen::finish_statement(&s))
        .collect();
    if !ix.is_empty() {
        out.push('\n');
        out.push_str(&ix.join(""));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------

async fn ms_object(
    session: &Arc<Session>,
    schema: &str,
    name: &str,
) -> AppResult<(String, String)> {
    let d = Driver::Mssql;
    let r = rows(
        session,
        format!(
            "SELECT CAST(o.object_id AS nvarchar(20)), RTRIM(o.type) FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = {} AND o.name = {}",
            lit(d, schema),
            lit(d, name)
        ),
    )
    .await?;
    let row = r.first().ok_or_else(|| not_found("Object", name))?;
    let id = text(row, 0);
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err(not_found("Object", name));
    }
    Ok((id, text(row, 1)))
}

fn num(r: &[Option<String>], i: usize) -> i64 {
    text(r, i)
        .trim()
        .parse::<f64>()
        .map(|f| f as i64)
        .unwrap_or(0)
}

async fn ms_index_list(
    session: &Arc<Session>,
    id: &str,
    only: Option<&str>,
    constraints: bool,
) -> AppResult<Vec<(ddlgen::MsIndex, bool, bool)>> {
    let d = Driver::Mssql;
    let filter = match only {
        Some(n) => format!(" AND i.name = {}", lit(d, n)),
        None => String::new(),
    };
    let cons = if constraints {
        ""
    } else {
        " AND i.is_primary_key = 0 AND i.is_unique_constraint = 0"
    };
    let r = rows(
        session,
        format!(
            "SELECT i.name, CASE WHEN i.is_unique = 1 THEN '1' ELSE '0' END, i.type_desc, \
                    CASE WHEN i.is_primary_key = 1 THEN '1' ELSE '0' END, CASE WHEN i.is_unique_constraint = 1 THEN '1' ELSE '0' END, \
                    CASE WHEN ic.is_included_column = 1 THEN '1' ELSE '0' END, c.name, \
                    CASE WHEN ic.is_descending_key = 1 THEN '1' ELSE '0' END, i.filter_definition \
             FROM sys.indexes i \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE i.object_id = {} AND i.type > 0{}{} \
             ORDER BY i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id",
            id, cons, filter
        ),
    )
    .await?;
    let mut out: Vec<(ddlgen::MsIndex, bool, bool)> = Vec::new();
    for x in &r {
        let name = text(x, 0);
        if out.last().map(|(i, _, _)| i.name != name).unwrap_or(true) {
            out.push((
                ddlgen::MsIndex {
                    name: name.clone(),
                    unique: flag(x, 1),
                    type_desc: text(x, 2),
                    keys: Vec::new(),
                    included: Vec::new(),
                    filter: cell(x, 8),
                },
                flag(x, 3),
                flag(x, 4),
            ));
        }
        if let Some((ix, _, _)) = out.last_mut() {
            if flag(x, 5) {
                ix.included.push(text(x, 6));
            } else {
                ix.keys.push((text(x, 6), flag(x, 7)));
            }
        }
    }
    Ok(out)
}

async fn ms_ddl(session: &Arc<Session>, req: &DdlRequest, o: DdlOpts) -> AppResult<String> {
    let schema = req
        .schema
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "dbo".into());
    if req.kind == "index" {
        let table = req
            .table
            .clone()
            .ok_or_else(|| AppError::new("Show DDL of an index needs its table"))?;
        let (tid, _) = ms_object(session, &schema, &table).await?;
        let list = ms_index_list(session, &tid, Some(&req.name), true).await?;
        let (ix, pk, uq) = list
            .into_iter()
            .next()
            .ok_or_else(|| not_found("Index", &req.name))?;
        let tq = ddlgen::ms_qname(&schema, &table, o.qualified);
        if pk || uq {
            let cols: Vec<String> = ix
                .keys
                .iter()
                .map(|(c, desc)| {
                    format!(
                        "{} {}",
                        ddlgen::ms_ident(c),
                        if *desc { "DESC" } else { "ASC" }
                    )
                })
                .collect();
            return Ok(format!(
                "ALTER TABLE {} ADD CONSTRAINT {} {} {} ({});\n",
                tq,
                ddlgen::ms_ident(&ix.name),
                if pk { "PRIMARY KEY" } else { "UNIQUE" },
                ix.type_desc,
                cols.join(", ")
            ));
        }
        return Ok(ddlgen::ms_index_ddl(&tq, &ix) + "\n");
    }
    let (id, otype) = ms_object(session, &schema, &req.name).await?;
    match otype.as_str() {
        "U" => ms_table(session, &schema, &req.name, &id, o).await,
        "SO" => {
            let r = rows(
                session,
                format!(
                    "SELECT TYPE_NAME(user_type_id), CAST(start_value AS nvarchar(40)), CAST(increment AS nvarchar(40)), \
                            CAST(minimum_value AS nvarchar(40)), CAST(maximum_value AS nvarchar(40)), \
                            CASE WHEN is_cycling = 1 THEN '1' ELSE '0' END, CASE WHEN is_cached = 1 THEN '1' ELSE '0' END, \
                            CAST(cache_size AS nvarchar(20)) \
                     FROM sys.sequences WHERE object_id = {}",
                    id
                ),
            )
            .await?;
            let s = r.first().ok_or_else(|| not_found("Sequence", &req.name))?;
            let cache = if flag(s, 6) {
                Some(cell(s, 7).unwrap_or_default())
            } else {
                None
            };
            Ok(ddlgen::ms_sequence_ddl(
                &ddlgen::ms_qname(&schema, &req.name, o.qualified),
                &text(s, 0),
                &text(s, 1),
                &text(s, 2),
                &text(s, 3),
                &text(s, 4),
                flag(s, 5),
                cache.as_deref(),
            ))
        }
        _ => {
            let r = rows(session, format!("SELECT OBJECT_DEFINITION({})", id)).await?;
            match r.first().and_then(|x| cell(x, 0)) {
                Some(def) => {
                    let mut s = def.trim().to_string();
                    s.push('\n');
                    let comments = if o.comments {
                        ms_comments(session, &id).await
                    } else {
                        HashMap::new()
                    };
                    if let Some(c) = comments.get(&0) {
                        let kind = match otype.as_str() {
                            "V" => "VIEW",
                            "P" => "PROCEDURE",
                            _ => "FUNCTION",
                        };
                        s.push_str(&format!(
                            "GO\nEXEC sp_addextendedproperty N'MS_Description', {}, N'SCHEMA', {}, N'{}', {};\n",
                            ddlgen::ms_string(c),
                            ddlgen::ms_string(&schema),
                            kind,
                            ddlgen::ms_string(&req.name)
                        ));
                    }
                    Ok(s)
                }
                None => Ok(format!(
                    "-- The definition of {} isn't available: it is encrypted, or you lack the VIEW DEFINITION permission.\n",
                    req.name
                )),
            }
        }
    }
}

/// MS_Description values by minor_id (0 = the object, else the column id).
async fn ms_comments(session: &Arc<Session>, id: &str) -> HashMap<i64, String> {
    let r = rows(
        session,
        format!(
            "SELECT CAST(ep.minor_id AS nvarchar(20)), CAST(ep.value AS nvarchar(max)) FROM sys.extended_properties ep \
             WHERE ep.class = 1 AND ep.major_id = {} AND ep.name = N'MS_Description'",
            id
        ),
    )
    .await
    .unwrap_or_default();
    r.iter()
        .filter_map(|x| Some((text(x, 0).parse::<i64>().ok()?, cell(x, 1)?)))
        .collect()
}

async fn ms_table(
    session: &Arc<Session>,
    schema: &str,
    name: &str,
    id: &str,
    o: DdlOpts,
) -> AppResult<String> {
    let cols = rows(
        session,
        format!(
            "SELECT c.name, TYPE_NAME(c.user_type_id), CAST(c.max_length AS nvarchar(20)), CAST(c.precision AS nvarchar(20)), \
                    CAST(c.scale AS nvarchar(20)), CASE WHEN c.is_nullable = 1 THEN '1' ELSE '0' END, \
                    CASE WHEN c.is_identity = 1 THEN '1' ELSE '0' END, CAST(ic.seed_value AS nvarchar(40)), \
                    CAST(ic.increment_value AS nvarchar(40)), dc.name, dc.definition, cc.definition, \
                    CASE WHEN cc.is_persisted = 1 THEN '1' ELSE '0' END, c.collation_name, \
                    CAST(c.column_id AS nvarchar(20)), \
                    CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(200)) \
             FROM sys.columns c \
             LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
             LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
             LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
             WHERE c.object_id = {} ORDER BY c.column_id",
            id
        ),
    )
    .await?;
    let comments = if o.comments {
        ms_comments(session, id).await
    } else {
        HashMap::new()
    };
    let columns: Vec<ddlgen::MsColumn> = cols
        .iter()
        .map(|r| {
            let col_id = text(r, 14).parse::<i64>().unwrap_or(-1);
            let coll = cell(r, 13);
            let db_coll = cell(r, 15);
            ddlgen::MsColumn {
                name: text(r, 0),
                type_text: ddlgen::ms_type(&text(r, 1), num(r, 2), num(r, 3), num(r, 4)),
                nullable: flag(r, 5),
                identity: if flag(r, 6) {
                    Some((text(r, 7), text(r, 8)))
                } else {
                    None
                },
                default_name: cell(r, 9),
                default_def: cell(r, 10),
                computed: cell(r, 11).map(|e| (e, flag(r, 12))),
                collation: coll.filter(|c| Some(c) != db_coll.as_ref()),
                comment: comments.get(&col_id).cloned(),
            }
        })
        .collect();
    let keys_rows = rows(
        session,
        format!(
            "SELECT kc.name, RTRIM(kc.type), i.type_desc, col.name, CASE WHEN ic.is_descending_key = 1 THEN '1' ELSE '0' END \
             FROM sys.key_constraints kc \
             JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id \
             WHERE kc.parent_object_id = {} ORDER BY kc.type, kc.name, ic.key_ordinal",
            id
        ),
    )
    .await
    .unwrap_or_default();
    let mut keys: Vec<ddlgen::MsKey> = Vec::new();
    for x in &keys_rows {
        let n = text(x, 0);
        if keys.last().map(|k| k.name != n).unwrap_or(true) {
            keys.push(ddlgen::MsKey {
                name: n,
                kind: text(x, 1),
                type_desc: text(x, 2),
                cols: Vec::new(),
            });
        }
        if let Some(k) = keys.last_mut() {
            k.cols.push((text(x, 3), flag(x, 4)));
        }
    }
    let fk_rows = rows(
        session,
        format!(
            "SELECT fk.name, pc.name, SCHEMA_NAME(rt.schema_id), rt.name, rc.name, \
                    fk.delete_referential_action_desc, fk.update_referential_action_desc \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
             JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id \
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
             WHERE fk.parent_object_id = {} ORDER BY fk.name, fkc.constraint_column_id",
            id
        ),
    )
    .await
    .unwrap_or_default();
    let mut fks: Vec<ddlgen::MsFk> = Vec::new();
    for x in &fk_rows {
        let n = text(x, 0);
        if fks.last().map(|f| f.name != n).unwrap_or(true) {
            fks.push(ddlgen::MsFk {
                name: n,
                ref_schema: text(x, 2),
                ref_table: text(x, 3),
                on_delete: text(x, 5),
                on_update: text(x, 6),
                ..Default::default()
            });
        }
        if let Some(f) = fks.last_mut() {
            f.cols.push(text(x, 1));
            f.ref_cols.push(text(x, 4));
        }
    }
    let checks: Vec<(String, String)> = rows(
        session,
        format!("SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = {} ORDER BY name", id),
    )
    .await
    .unwrap_or_default()
    .iter()
    .map(|x| (text(x, 0), text(x, 1)))
    .collect();
    let indexes: Vec<ddlgen::MsIndex> = if o.indexes {
        ms_index_list(session, id, None, false)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(i, _, _)| i)
            .collect()
    } else {
        Vec::new()
    };
    let t = ddlgen::MsTable {
        schema,
        name,
        columns: &columns,
        keys: &keys,
        fks: &fks,
        checks: &checks,
        indexes: &indexes,
        comment: comments.get(&0).cloned(),
    };
    Ok(ddlgen::ms_table_ddl(&t, o))
}

// ---------------------------------------------------------------------------
// Table extras for the table designer
// ---------------------------------------------------------------------------

/// What the table designer needs beyond the explorer's introspection.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableExtras {
    /// Column comments by column name.
    pub comments: HashMap<String, String>,
    /// SQL Server: default constraint name by column name.
    pub default_constraints: HashMap<String, String>,
    /// MySQL AUTO_INCREMENT columns; PostgreSQL / SQL Server identity columns.
    pub auto_increment: Vec<String>,
    /// Foreign key name → ON DELETE action ("CASCADE", "SET NULL", … ; "NO ACTION" omitted).
    pub fk_on_delete: HashMap<String, String>,
    /// SQLite: the table's CREATE statement (kept for the copy-table rebuild).
    pub create_sql: Option<String>,
    /// Table comment.
    pub table_comment: Option<String>,
}

#[tauri::command]
pub async fn table_extras(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<TableExtras> {
    let session = state.sessions.get(&session_id)?;
    let d = session.config.driver;
    let mut x = TableExtras::default();
    match d {
        Driver::Postgres => {
            let s = schema.unwrap_or_else(|| "public".into());
            let qn = lit(
                d,
                &format!("{}.{}", ddlgen::pg_ident(&s), ddlgen::pg_ident(&table)),
            );
            let version = pg_version(&session).await;
            let ident = if version >= 100_000 {
                "a.attidentity::text"
            } else {
                "''"
            };
            if let Ok(r) = rows(
                &session,
                format!(
                    "SELECT a.attname, col_description(a.attrelid, a.attnum), {} FROM pg_catalog.pg_attribute a \
                     WHERE a.attrelid = to_regclass({}) AND a.attnum > 0 AND NOT a.attisdropped",
                    ident, qn
                ),
            )
            .await
            {
                for r in &r {
                    if let Some(c) = cell(r, 1) {
                        x.comments.insert(text(r, 0), c);
                    }
                    if matches!(text(r, 2).as_str(), "a" | "d") {
                        x.auto_increment.push(text(r, 0));
                    }
                }
            }
            if let Ok(r) = rows(
                &session,
                format!(
                    "SELECT conname, confdeltype::text FROM pg_catalog.pg_constraint WHERE contype = 'f' AND conrelid = to_regclass({})",
                    qn
                ),
            )
            .await
            {
                for r in &r {
                    let a = match text(r, 1).as_str() {
                        "r" => "RESTRICT",
                        "c" => "CASCADE",
                        "n" => "SET NULL",
                        "d" => "SET DEFAULT",
                        _ => continue,
                    };
                    x.fk_on_delete.insert(text(r, 0), a.into());
                }
            }
            if let Ok(r) = rows(
                &session,
                format!("SELECT obj_description(to_regclass({}), 'pg_class')", qn),
            )
            .await
            {
                x.table_comment = r.first().and_then(|y| cell(y, 0));
            }
        }
        Driver::Mysql => {
            let db_name = match schema.filter(|s| !s.is_empty()) {
                Some(s) => s,
                None => rows(&session, "SELECT DATABASE()".into())
                    .await?
                    .first()
                    .and_then(|y| cell(y, 0))
                    .unwrap_or_default(),
            };
            if let Ok(r) = rows(
                &session,
                format!(
                    "SELECT COLUMN_NAME, COLUMN_COMMENT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
                    lit(d, &db_name),
                    lit(d, &table)
                ),
            )
            .await
            {
                for r in &r {
                    if let Some(c) = cell(r, 1).filter(|c| !c.is_empty()) {
                        x.comments.insert(text(r, 0), c);
                    }
                    if text(r, 2).to_lowercase().contains("auto_increment") {
                        x.auto_increment.push(text(r, 0));
                    }
                }
            }
            if let Ok(r) = rows(
                &session,
                format!(
                    "SELECT CONSTRAINT_NAME, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = {} AND TABLE_NAME = {}",
                    lit(d, &db_name),
                    lit(d, &table)
                ),
            )
            .await
            {
                for r in &r {
                    let a = text(r, 1).to_uppercase();
                    if !a.is_empty() && a != "NO ACTION" {
                        x.fk_on_delete.insert(text(r, 0), a);
                    }
                }
            }
            if let Ok(r) = rows(
                &session,
                format!(
                    "SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
                    lit(d, &db_name),
                    lit(d, &table)
                ),
            )
            .await
            {
                x.table_comment = r.first().and_then(|y| cell(y, 0)).filter(|c| !c.is_empty());
            }
        }
        Driver::Mssql => {
            let s = schema.unwrap_or_else(|| "dbo".into());
            if let Ok((id, _)) = ms_object(&session, &s, &table).await {
                let names = rows(
                    &session,
                    format!(
                        "SELECT CAST(c.column_id AS nvarchar(20)), c.name, dc.name, CASE WHEN c.is_identity = 1 THEN '1' ELSE '0' END \
                         FROM sys.columns c LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
                         WHERE c.object_id = {}",
                        id
                    ),
                )
                .await
                .unwrap_or_default();
                let comments = ms_comments(&session, &id).await;
                for r in &names {
                    let cid = text(r, 0).parse::<i64>().unwrap_or(-1);
                    if let Some(c) = comments.get(&cid) {
                        x.comments.insert(text(r, 1), c.clone());
                    }
                    if let Some(dc) = cell(r, 2) {
                        x.default_constraints.insert(text(r, 1), dc);
                    }
                    if flag(r, 3) {
                        x.auto_increment.push(text(r, 1));
                    }
                }
                x.table_comment = comments.get(&0).cloned();
                if let Ok(r) = rows(
                    &session,
                    format!("SELECT name, delete_referential_action_desc FROM sys.foreign_keys WHERE parent_object_id = {}", id),
                )
                .await
                {
                    for r in &r {
                        let a = text(r, 1).replace('_', " ").to_uppercase();
                        if !a.is_empty() && a != "NO ACTION" {
                            x.fk_on_delete.insert(text(r, 0), a);
                        }
                    }
                }
            }
        }
        Driver::Sqlite => {
            let s = schema
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "main".into());
            if let Ok(r) = rows(
                &session,
                format!(
                    "SELECT sql FROM {}.sqlite_master WHERE type = 'table' AND name = {}",
                    db::quote_ident(d, &s),
                    lit(d, &table)
                ),
            )
            .await
            {
                x.create_sql = r.first().and_then(|y| cell(y, 0));
                if let Some(sql) = &x.create_sql {
                    if sql.to_uppercase().contains("AUTOINCREMENT") {
                        // The INTEGER PRIMARY KEY column is the AUTOINCREMENT one; the frontend knows the PK.
                        x.auto_increment.push("*".into());
                    }
                }
            }
        }
        Driver::Redis | Driver::Kafka => {}
    }
    Ok(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_normalize() {
        assert_eq!(norm_args("(p_order_id bigint)"), "p_order_id bigint");
        assert_eq!(norm_args("a  integer, b text"), "a integer, b text");
    }

    #[test]
    fn literals() {
        assert_eq!(lit(Driver::Mysql, "a'b\\c"), "'a''b\\\\c'");
        assert_eq!(lit(Driver::Mssql, "o'k"), "N'o''k'");
        assert_eq!(lit(Driver::Postgres, "x"), "'x'");
    }
}

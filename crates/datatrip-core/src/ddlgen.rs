//! Show DDL (v0.16), the pure part: CREATE statements assembled from catalog rows (PostgreSQL tables and
//! sequences, SQL Server tables / indexes / sequences) and the post-processing of server-generated DDL
//! (MySQL `SHOW CREATE …`: hide indexes / comments, schema-qualify). Std only:
//! `rustc --edition 2021 --test src/ddlgen.rs`.

/// What the DDL tab asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DdlOpts {
    pub indexes: bool,
    pub comments: bool,
    pub qualified: bool,
}

/// A SQL string literal ('…' with quotes doubled).
pub fn sql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// SQL Server N'…' literal.
pub fn ms_string(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

/// Words PostgreSQL quotes in identifiers (reserved key words of PostgreSQL 16, plus a few type names).
const PG_RESERVED: &[&str] = &[
    "all",
    "analyse",
    "analyze",
    "and",
    "any",
    "array",
    "as",
    "asc",
    "asymmetric",
    "authorization",
    "binary",
    "both",
    "case",
    "cast",
    "check",
    "collate",
    "collation",
    "column",
    "concurrently",
    "constraint",
    "create",
    "cross",
    "current_catalog",
    "current_date",
    "current_role",
    "current_schema",
    "current_time",
    "current_timestamp",
    "current_user",
    "default",
    "deferrable",
    "desc",
    "distinct",
    "do",
    "else",
    "end",
    "except",
    "false",
    "fetch",
    "for",
    "foreign",
    "freeze",
    "from",
    "full",
    "grant",
    "group",
    "having",
    "ilike",
    "in",
    "initially",
    "inner",
    "intersect",
    "into",
    "is",
    "isnull",
    "join",
    "lateral",
    "leading",
    "left",
    "like",
    "limit",
    "localtime",
    "localtimestamp",
    "natural",
    "not",
    "notnull",
    "null",
    "offset",
    "on",
    "only",
    "or",
    "order",
    "outer",
    "overlaps",
    "placing",
    "primary",
    "references",
    "returning",
    "right",
    "select",
    "session_user",
    "similar",
    "some",
    "symmetric",
    "system_user",
    "table",
    "tablesample",
    "then",
    "to",
    "trailing",
    "true",
    "union",
    "unique",
    "user",
    "using",
    "variadic",
    "verbose",
    "when",
    "where",
    "window",
    "with",
];

/// PostgreSQL identifier as `quote_ident` writes it: bare when lower-case simple and not reserved.
pub fn pg_ident(name: &str) -> String {
    let simple = !name.is_empty()
        && name
            .chars()
            .next()
            .map(|c| c.is_ascii_lowercase() || c == '_')
            .unwrap_or(false)
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '$');
    if simple && !PG_RESERVED.contains(&name) {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

pub fn pg_qname(schema: &str, name: &str, qualified: bool) -> String {
    if qualified && !schema.is_empty() {
        format!("{}.{}", pg_ident(schema), pg_ident(name))
    } else {
        pg_ident(name)
    }
}

pub fn ms_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

pub fn ms_qname(schema: &str, name: &str, qualified: bool) -> String {
    if qualified && !schema.is_empty() {
        format!("{}.{}", ms_ident(schema), ms_ident(name))
    } else {
        ms_ident(name)
    }
}

fn pad(s: &str, w: usize) -> String {
    let n = s.chars().count();
    if n >= w {
        format!("{} ", s)
    } else {
        format!("{}{}", s, " ".repeat(w - n + 1))
    }
}

/// Trailing `;` removed (and whitespace).
pub fn strip_semicolon(s: &str) -> &str {
    let t = s.trim_end();
    t.strip_suffix(';').unwrap_or(t).trim_end()
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct PgColumn {
    pub name: String,
    pub type_name: String,
    pub not_null: bool,
    pub default: Option<String>,
    /// 'a' = GENERATED ALWAYS AS IDENTITY, 'd' = BY DEFAULT.
    pub identity: Option<char>,
    /// A stored generated column: `default` holds the expression.
    pub generated: bool,
    pub collation: Option<String>,
    pub comment: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PgConstraint {
    pub name: String,
    /// pg_get_constraintdef output, e.g. `PRIMARY KEY (id)`.
    pub def: String,
}

pub struct PgTable<'a> {
    pub schema: &'a str,
    pub name: &'a str,
    pub unlogged: bool,
    /// `PARTITION BY …` text (pg_get_partkeydef), when partitioned.
    pub partition_by: Option<String>,
    pub columns: &'a [PgColumn],
    pub constraints: &'a [PgConstraint],
    /// pg_get_indexdef of indexes that don't back a constraint.
    pub indexes: &'a [String],
    pub comment: Option<String>,
}

/// pg_get_indexdef always writes `ON schema.table`: drop the schema when names aren't qualified.
pub fn pg_unqualify_index(def: &str, schema: &str) -> String {
    let needle = format!(" ON {}.", pg_ident(schema));
    let only = format!(" ON ONLY {}.", pg_ident(schema));
    def.replacen(&only, " ON ONLY ", 1)
        .replacen(&needle, " ON ", 1)
}

pub fn pg_table_ddl(t: &PgTable, o: DdlOpts) -> String {
    let q = pg_qname(t.schema, t.name, o.qualified);
    let w = t
        .columns
        .iter()
        .map(|c| pg_ident(&c.name).chars().count())
        .max()
        .unwrap_or(0)
        .min(28);
    let tw = t
        .columns
        .iter()
        .map(|c| c.type_name.chars().count())
        .max()
        .unwrap_or(0)
        .min(24);
    let mut body: Vec<String> = Vec::new();
    for c in t.columns {
        let mut s = format!("    {}", pad(&pg_ident(&c.name), w));
        s.push_str(&c.type_name);
        let mut tail = String::new();
        if let Some(coll) = &c.collation {
            tail.push_str(&format!(" COLLATE {}", pg_ident(coll)));
        }
        match c.identity {
            Some('a') => tail.push_str(" GENERATED ALWAYS AS IDENTITY"),
            Some('d') => tail.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
            _ => {}
        }
        if c.generated {
            if let Some(e) = &c.default {
                tail.push_str(&format!(" GENERATED ALWAYS AS ({}) STORED", e));
            }
        } else if c.identity.is_none() {
            if c.not_null {
                tail.push_str(" NOT NULL");
            }
            if let Some(d) = &c.default {
                tail.push_str(&format!(" DEFAULT {}", d));
            }
        }
        if !tail.is_empty() {
            let n = c.type_name.chars().count();
            if n < tw {
                s.push_str(&" ".repeat(tw - n));
            }
        }
        s.push_str(&tail);
        body.push(s);
    }
    for k in t.constraints {
        body.push(format!("    CONSTRAINT {} {}", pg_ident(&k.name), k.def));
    }
    let mut out = format!(
        "CREATE {}TABLE {} (\n{}\n)",
        if t.unlogged { "UNLOGGED " } else { "" },
        q,
        body.join(",\n")
    );
    if let Some(p) = &t.partition_by {
        out.push_str(&format!(" PARTITION BY {}", p));
    }
    out.push_str(";\n");
    if o.indexes && !t.indexes.is_empty() {
        out.push('\n');
        for i in t.indexes {
            let def = if o.qualified {
                i.clone()
            } else {
                pg_unqualify_index(i, t.schema)
            };
            out.push_str(strip_semicolon(&def));
            out.push_str(";\n");
        }
    }
    if o.comments {
        let mut lines: Vec<String> = Vec::new();
        if let Some(c) = &t.comment {
            lines.push(format!("COMMENT ON TABLE {} IS {};", q, sql_string(c)));
        }
        for c in t.columns {
            if let Some(cm) = &c.comment {
                lines.push(format!(
                    "COMMENT ON COLUMN {}.{} IS {};",
                    q,
                    pg_ident(&c.name),
                    sql_string(cm)
                ));
            }
        }
        if !lines.is_empty() {
            out.push('\n');
            out.push_str(&lines.join("\n"));
            out.push('\n');
        }
    }
    out
}

#[derive(Clone, Debug, Default)]
pub struct PgSequence {
    pub type_name: String,
    pub start: String,
    pub increment: String,
    pub min: String,
    pub max: String,
    pub cache: String,
    pub cycle: bool,
    /// `table.column` (already quoted / qualified) of OWNED BY.
    pub owned_by: Option<String>,
}

pub fn pg_sequence_ddl(
    schema: &str,
    name: &str,
    s: &PgSequence,
    comment: Option<&str>,
    o: DdlOpts,
) -> String {
    let q = pg_qname(schema, name, o.qualified);
    let mut out = format!("CREATE SEQUENCE {}", q);
    if !s.type_name.is_empty() && s.type_name != "bigint" {
        out.push_str(&format!("\n    AS {}", s.type_name));
    }
    out.push_str(&format!(
        "\n    START WITH {}\n    INCREMENT BY {}",
        s.start, s.increment
    ));
    out.push_str(&format!("\n    MINVALUE {}\n    MAXVALUE {}", s.min, s.max));
    if !s.cache.is_empty() && s.cache != "1" {
        out.push_str(&format!("\n    CACHE {}", s.cache));
    }
    if s.cycle {
        out.push_str("\n    CYCLE");
    }
    out.push_str(";\n");
    if let Some(ob) = &s.owned_by {
        out.push_str(&format!("\nALTER SEQUENCE {} OWNED BY {};\n", q, ob));
    }
    if o.comments {
        if let Some(c) = comment {
            out.push_str(&format!(
                "\nCOMMENT ON SEQUENCE {} IS {};\n",
                q,
                sql_string(c)
            ));
        }
    }
    out
}

/// A view / materialized view from pg_get_viewdef.
pub fn pg_view_ddl(
    schema: &str,
    name: &str,
    materialized: bool,
    body: &str,
    comment: Option<&str>,
    o: DdlOpts,
) -> String {
    let q = pg_qname(schema, name, o.qualified);
    let body = strip_semicolon(body.trim_start_matches(['\n', '\r']));
    let body = body.trim_start();
    let mut out = if materialized {
        format!("CREATE MATERIALIZED VIEW {} AS\n{};\n", q, body)
    } else {
        format!("CREATE OR REPLACE VIEW {} AS\n{};\n", q, body)
    };
    if o.comments {
        if let Some(c) = comment {
            out.push_str(&format!(
                "\nCOMMENT ON {} {} IS {};\n",
                if materialized {
                    "MATERIALIZED VIEW"
                } else {
                    "VIEW"
                },
                q,
                sql_string(c)
            ));
        }
    }
    out
}

/// pg_get_functiondef writes `CREATE OR REPLACE FUNCTION schema.name(`; unqualify that header when asked.
pub fn pg_unqualify_routine(def: &str, schema: &str) -> String {
    let id = pg_ident(schema);
    let mut lines: Vec<String> = def.lines().map(|l| l.to_string()).collect();
    if let Some(first) = lines.first_mut() {
        for kw in ["FUNCTION ", "PROCEDURE "] {
            let needle = format!("{}{}.", kw, id);
            if first.contains(&needle) {
                *first = first.replacen(&needle, kw, 1);
                break;
            }
        }
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------

/// Type text from sys.columns (max_length in bytes, -1 = max).
pub fn ms_type(type_name: &str, max_length: i64, precision: i64, scale: i64) -> String {
    let t = type_name.to_ascii_lowercase();
    match t.as_str() {
        "varchar" | "char" | "varbinary" | "binary" => {
            if max_length < 0 {
                format!("{}(max)", t)
            } else {
                format!("{}({})", t, max_length)
            }
        }
        "nvarchar" | "nchar" => {
            if max_length < 0 {
                format!("{}(max)", t)
            } else {
                format!("{}({})", t, max_length / 2)
            }
        }
        "decimal" | "numeric" => format!("{}({},{})", t, precision, scale),
        "datetime2" | "time" | "datetimeoffset" => {
            if scale == 7 {
                t
            } else {
                format!("{}({})", t, scale)
            }
        }
        _ => type_name.to_string(),
    }
}

#[derive(Clone, Debug, Default)]
pub struct MsColumn {
    pub name: String,
    pub type_text: String,
    pub nullable: bool,
    /// (seed, increment) of an IDENTITY column.
    pub identity: Option<(String, String)>,
    pub default_name: Option<String>,
    pub default_def: Option<String>,
    /// Computed column expression and PERSISTED.
    pub computed: Option<(String, bool)>,
    pub collation: Option<String>,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct MsKey {
    pub name: String,
    /// "PK" | "UQ"
    pub kind: String,
    /// CLUSTERED / NONCLUSTERED
    pub type_desc: String,
    /// (column, descending)
    pub cols: Vec<(String, bool)>,
}

#[derive(Clone, Debug, Default)]
pub struct MsFk {
    pub name: String,
    pub cols: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_cols: Vec<String>,
    pub on_delete: String,
    pub on_update: String,
}

#[derive(Clone, Debug, Default)]
pub struct MsIndex {
    pub name: String,
    pub unique: bool,
    pub type_desc: String,
    pub keys: Vec<(String, bool)>,
    pub included: Vec<String>,
    pub filter: Option<String>,
}

fn ms_action(a: &str) -> Option<String> {
    let a = a.trim().replace('_', " ");
    if a.is_empty() || a.eq_ignore_ascii_case("NO ACTION") {
        None
    } else {
        Some(a.to_uppercase())
    }
}

pub fn ms_index_ddl(table_q: &str, x: &MsIndex) -> String {
    let td = x.type_desc.to_uppercase();
    if td.contains("XML") || td.contains("SPATIAL") || td.contains("HEAP") {
        return format!("-- {} index {} is not scripted", td, ms_ident(&x.name));
    }
    if td.contains("COLUMNSTORE") {
        let cols = if td.starts_with("CLUSTERED") {
            String::new()
        } else {
            let all: Vec<String> = x
                .keys
                .iter()
                .map(|(c, _)| ms_ident(c))
                .chain(x.included.iter().map(|c| ms_ident(c)))
                .collect();
            format!(" ({})", all.join(", "))
        };
        return format!(
            "CREATE {} INDEX {} ON {}{};",
            td,
            ms_ident(&x.name),
            table_q,
            cols
        );
    }
    let keys: Vec<String> = x
        .keys
        .iter()
        .map(|(c, desc)| format!("{} {}", ms_ident(c), if *desc { "DESC" } else { "ASC" }))
        .collect();
    let mut s = format!(
        "CREATE {}{} INDEX {} ON {} ({})",
        if x.unique { "UNIQUE " } else { "" },
        td,
        ms_ident(&x.name),
        table_q,
        keys.join(", ")
    );
    if !x.included.is_empty() {
        let inc: Vec<String> = x.included.iter().map(|c| ms_ident(c)).collect();
        s.push_str(&format!(" INCLUDE ({})", inc.join(", ")));
    }
    if let Some(f) = &x.filter {
        s.push_str(&format!(" WHERE {}", f));
    }
    s.push(';');
    s
}

pub struct MsTable<'a> {
    pub schema: &'a str,
    pub name: &'a str,
    pub columns: &'a [MsColumn],
    pub keys: &'a [MsKey],
    pub fks: &'a [MsFk],
    /// (name, definition)
    pub checks: &'a [(String, String)],
    pub indexes: &'a [MsIndex],
    pub comment: Option<String>,
}

pub fn ms_table_ddl(t: &MsTable, o: DdlOpts) -> String {
    let q = ms_qname(t.schema, t.name, o.qualified);
    let w = t
        .columns
        .iter()
        .map(|c| ms_ident(&c.name).chars().count())
        .max()
        .unwrap_or(0)
        .min(30);
    let mut body: Vec<String> = Vec::new();
    for c in t.columns {
        let mut s = format!("    {}", pad(&ms_ident(&c.name), w));
        if let Some((expr, persisted)) = &c.computed {
            s.push_str(&format!(
                "AS {}{}",
                expr,
                if *persisted { " PERSISTED" } else { "" }
            ));
            body.push(s);
            continue;
        }
        s.push_str(&c.type_text);
        if let Some(coll) = &c.collation {
            s.push_str(&format!(" COLLATE {}", coll));
        }
        if let Some((seed, inc)) = &c.identity {
            s.push_str(&format!(" IDENTITY({},{})", seed, inc));
        }
        s.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
        if let Some(d) = &c.default_def {
            match &c.default_name {
                Some(n) => s.push_str(&format!(" CONSTRAINT {} DEFAULT {}", ms_ident(n), d)),
                None => s.push_str(&format!(" DEFAULT {}", d)),
            }
        }
        body.push(s);
    }
    for k in t.keys {
        let cols: Vec<String> = k
            .cols
            .iter()
            .map(|(c, desc)| format!("{} {}", ms_ident(c), if *desc { "DESC" } else { "ASC" }))
            .collect();
        body.push(format!(
            "    CONSTRAINT {} {} {} ({})",
            ms_ident(&k.name),
            if k.kind == "PK" {
                "PRIMARY KEY"
            } else {
                "UNIQUE"
            },
            k.type_desc.to_uppercase(),
            cols.join(", ")
        ));
    }
    for f in t.fks {
        let cols: Vec<String> = f.cols.iter().map(|c| ms_ident(c)).collect();
        let rcols: Vec<String> = f.ref_cols.iter().map(|c| ms_ident(c)).collect();
        let mut s = format!(
            "    CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            ms_ident(&f.name),
            cols.join(", "),
            ms_qname(
                &f.ref_schema,
                &f.ref_table,
                o.qualified || f.ref_schema != t.schema
            ),
            rcols.join(", ")
        );
        if let Some(a) = ms_action(&f.on_delete) {
            s.push_str(&format!(" ON DELETE {}", a));
        }
        if let Some(a) = ms_action(&f.on_update) {
            s.push_str(&format!(" ON UPDATE {}", a));
        }
        body.push(s);
    }
    for (n, d) in t.checks {
        body.push(format!("    CONSTRAINT {} CHECK {}", ms_ident(n), d));
    }
    let mut out = format!("CREATE TABLE {} (\n{}\n);\n", q, body.join(",\n"));
    if o.indexes && !t.indexes.is_empty() {
        out.push('\n');
        for x in t.indexes {
            out.push_str(&ms_index_ddl(&q, x));
            out.push('\n');
        }
    }
    if o.comments {
        let mut lines: Vec<String> = Vec::new();
        let prop = |value: &str, col: Option<&str>| -> String {
            let mut s = format!(
                "EXEC sp_addextendedproperty N'MS_Description', {}, N'SCHEMA', {}, N'TABLE', {}",
                ms_string(value),
                ms_string(t.schema),
                ms_string(t.name)
            );
            if let Some(c) = col {
                s.push_str(&format!(", N'COLUMN', {}", ms_string(c)));
            }
            s.push(';');
            s
        };
        if let Some(c) = &t.comment {
            lines.push(prop(c, None));
        }
        for c in t.columns {
            if let Some(cm) = &c.comment {
                lines.push(prop(cm, Some(&c.name)));
            }
        }
        if !lines.is_empty() {
            out.push('\n');
            out.push_str(&lines.join("\n"));
            out.push('\n');
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub fn ms_sequence_ddl(
    q: &str,
    type_name: &str,
    start: &str,
    inc: &str,
    min: &str,
    max: &str,
    cycle: bool,
    cache: Option<&str>,
) -> String {
    let mut s = format!(
        "CREATE SEQUENCE {}\n    AS {}\n    START WITH {}\n    INCREMENT BY {}\n    MINVALUE {}\n    MAXVALUE {}",
        q, type_name, start, inc, min, max
    );
    s.push_str(if cycle {
        "\n    CYCLE"
    } else {
        "\n    NO CYCLE"
    });
    match cache {
        Some(c) if !c.is_empty() => s.push_str(&format!("\n    CACHE {}", c)),
        Some(_) => s.push_str("\n    CACHE"),
        None => s.push_str("\n    NO CACHE"),
    }
    s.push_str(";\n");
    s
}

// ---------------------------------------------------------------------------
// MySQL post-processing
// ---------------------------------------------------------------------------

/// Removes ` COMMENT '…'` / ` COMMENT='…'` clauses (outside identifiers and other strings).
pub fn strip_mysql_comments(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    let starts = |i: usize, pat: &str| -> bool {
        let p: Vec<char> = pat.chars().collect();
        i + p.len() <= c.len() && c[i..i + p.len()] == p[..]
    };
    while i < c.len() {
        let ch = c[i];
        if ch == '`' {
            // identifier: copy through the closing backtick (`` = literal)
            out.push(ch);
            i += 1;
            while i < c.len() {
                out.push(c[i]);
                if c[i] == '`' {
                    if i + 1 < c.len() && c[i + 1] == '`' {
                        out.push('`');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if ch == '\'' {
            out.push(ch);
            i += 1;
            while i < c.len() {
                out.push(c[i]);
                if c[i] == '\\' && i + 1 < c.len() {
                    out.push(c[i + 1]);
                    i += 2;
                    continue;
                }
                if c[i] == '\'' {
                    if i + 1 < c.len() && c[i + 1] == '\'' {
                        out.push('\'');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        let pat = if starts(i, " COMMENT '") {
            Some(" COMMENT '".len())
        } else if starts(i, " COMMENT='") {
            Some(" COMMENT='".len())
        } else {
            None
        };
        if let Some(n) = pat {
            i += n;
            // skip the string
            while i < c.len() {
                if c[i] == '\\' && i + 1 < c.len() {
                    i += 2;
                    continue;
                }
                if c[i] == '\'' {
                    if i + 1 < c.len() && c[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// Drops plain / FULLTEXT / SPATIAL `KEY` lines of SHOW CREATE TABLE (PRIMARY / UNIQUE stay) and fixes the comma.
pub fn strip_mysql_indexes(s: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for l in s.lines() {
        let t = l.trim_start();
        if t.starts_with("KEY `")
            || t.starts_with("FULLTEXT KEY `")
            || t.starts_with("SPATIAL KEY `")
        {
            continue;
        }
        lines.push(l.to_string());
    }
    // The last definition line before the closing ") ENGINE…" must not end with a comma.
    if let Some(close) = lines.iter().rposition(|l| l.starts_with(')')) {
        if close > 0 {
            let prev = &mut lines[close - 1];
            if prev.ends_with(',') {
                prev.pop();
            }
        }
    }
    lines.join("\n")
}

/// Inserts `` `db`. `` before the object name after `keyword` (`TABLE`, `VIEW`, `FUNCTION`, `PROCEDURE`).
pub fn mysql_qualify(s: &str, keyword: &str, name: &str, db: &str) -> String {
    let qn = format!("`{}`", name.replace('`', "``"));
    let needle = format!("{} {}", keyword, qn);
    match s.find(&needle) {
        Some(i) => {
            let at = i + keyword.len() + 1;
            format!("{}`{}`.{}", &s[..at], db.replace('`', "``"), &s[at..])
        }
        None => s.to_string(),
    }
}

/// Final touch for any DDL text: one trailing newline, statements end with `;`.
pub fn finish_statement(s: &str) -> String {
    let t = s.trim_end();
    if t.is_empty() {
        return String::new();
    }
    if t.ends_with(';') || t.ends_with("END") || t.ends_with("end") || t.ends_with("GO") {
        format!("{}\n", t)
    } else {
        format!("{};\n", t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: DdlOpts = DdlOpts {
        indexes: true,
        comments: true,
        qualified: true,
    };

    #[test]
    fn idents() {
        assert_eq!(pg_ident("orders"), "orders");
        assert_eq!(pg_ident("Orders"), "\"Orders\"");
        assert_eq!(pg_ident("user"), "\"user\"");
        assert_eq!(pg_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(ms_ident("a]b"), "[a]]b]");
        assert_eq!(sql_string("it's"), "'it''s'");
    }

    #[test]
    fn pg_table() {
        let cols = vec![
            PgColumn {
                name: "id".into(),
                type_name: "bigint".into(),
                not_null: true,
                identity: Some('a'),
                ..Default::default()
            },
            PgColumn {
                name: "status".into(),
                type_name: "text".into(),
                not_null: true,
                default: Some("'pending'::text".into()),
                comment: Some("It's the state".into()),
                ..Default::default()
            },
            PgColumn {
                name: "paid_at".into(),
                type_name: "timestamp with time zone".into(),
                ..Default::default()
            },
        ];
        let cons = vec![PgConstraint {
            name: "orders_pkey".into(),
            def: "PRIMARY KEY (id)".into(),
        }];
        let idx = vec![
            "CREATE INDEX orders_status_idx ON public.orders USING btree (status)".to_string(),
        ];
        let t = PgTable {
            schema: "public",
            name: "orders",
            unlogged: false,
            partition_by: None,
            columns: &cols,
            constraints: &cons,
            indexes: &idx,
            comment: Some("One row per checkout".into()),
        };
        let s = pg_table_ddl(&t, ALL);
        assert!(
            s.starts_with("CREATE TABLE public.orders (\n    id      bigint"),
            "{}",
            s
        );
        assert!(s.contains("GENERATED ALWAYS AS IDENTITY,\n"));
        assert!(s.contains("NOT NULL DEFAULT 'pending'::text,\n"));
        assert!(s.contains("    CONSTRAINT orders_pkey PRIMARY KEY (id)\n);\n"));
        assert!(s.contains("CREATE INDEX orders_status_idx ON public.orders USING btree (status);"));
        assert!(s.contains("COMMENT ON COLUMN public.orders.status IS 'It''s the state';"));
        let s2 = pg_table_ddl(
            &t,
            DdlOpts {
                indexes: false,
                comments: false,
                qualified: false,
            },
        );
        assert!(s2.starts_with("CREATE TABLE orders ("));
        assert!(!s2.contains("INDEX") && !s2.contains("COMMENT"));
        assert_eq!(
            pg_unqualify_index(
                "CREATE UNIQUE INDEX x ON public.orders USING btree (a)",
                "public"
            ),
            "CREATE UNIQUE INDEX x ON orders USING btree (a)"
        );
        assert_eq!(
            pg_unqualify_routine(
                "CREATE OR REPLACE FUNCTION public.f(a integer)\n RETURNS int",
                "public"
            ),
            "CREATE OR REPLACE FUNCTION f(a integer)\n RETURNS int"
        );
    }

    #[test]
    fn pg_view_and_sequence() {
        let v = pg_view_ddl("public", "v", false, " SELECT 1;", Some("x"), ALL);
        assert_eq!(
            v,
            "CREATE OR REPLACE VIEW public.v AS\nSELECT 1;\n\nCOMMENT ON VIEW public.v IS 'x';\n"
        );
        let s = PgSequence {
            type_name: "bigint".into(),
            start: "1".into(),
            increment: "1".into(),
            min: "1".into(),
            max: "9223372036854775807".into(),
            cache: "1".into(),
            cycle: false,
            owned_by: Some("public.orders.id".into()),
        };
        let d = pg_sequence_ddl("public", "orders_id_seq", &s, None, ALL);
        assert!(d.starts_with("CREATE SEQUENCE public.orders_id_seq\n    START WITH 1"));
        assert!(d.contains("OWNED BY public.orders.id;"));
    }

    #[test]
    fn ms_table() {
        assert_eq!(ms_type("nvarchar", 510, 0, 0), "nvarchar(255)");
        assert_eq!(ms_type("varbinary", -1, 0, 0), "varbinary(max)");
        assert_eq!(ms_type("decimal", 9, 12, 2), "decimal(12,2)");
        assert_eq!(ms_type("datetime2", 8, 27, 7), "datetime2");
        assert_eq!(ms_type("int", 4, 10, 0), "int");
        let cols = vec![
            MsColumn {
                name: "id".into(),
                type_text: "bigint".into(),
                identity: Some(("1".into(), "1".into())),
                ..Default::default()
            },
            MsColumn {
                name: "name".into(),
                type_text: "nvarchar(255)".into(),
                nullable: true,
                default_name: Some("DF_t_name".into()),
                default_def: Some("(N'x')".into()),
                comment: Some("Name".into()),
                ..Default::default()
            },
        ];
        let keys = vec![MsKey {
            name: "PK_t".into(),
            kind: "PK".into(),
            type_desc: "CLUSTERED".into(),
            cols: vec![("id".into(), false)],
        }];
        let fks = vec![MsFk {
            name: "FK_t_o".into(),
            cols: vec!["id".into()],
            ref_schema: "dbo".into(),
            ref_table: "o".into(),
            ref_cols: vec!["id".into()],
            on_delete: "CASCADE".into(),
            on_update: "NO_ACTION".into(),
        }];
        let idx = vec![MsIndex {
            name: "IX_t_name".into(),
            unique: false,
            type_desc: "NONCLUSTERED".into(),
            keys: vec![("name".into(), true)],
            included: vec!["id".into()],
            filter: Some("([name] IS NOT NULL)".into()),
        }];
        let checks = vec![("CK_t".to_string(), "([id]>(0))".to_string())];
        let t = MsTable {
            schema: "dbo",
            name: "t",
            columns: &cols,
            keys: &keys,
            fks: &fks,
            checks: &checks,
            indexes: &idx,
            comment: None,
        };
        let s = ms_table_ddl(&t, ALL);
        assert!(
            s.contains("    [id]   bigint IDENTITY(1,1) NOT NULL,\n"),
            "{}",
            s
        );
        assert!(s.contains("[name] nvarchar(255) NULL CONSTRAINT [DF_t_name] DEFAULT (N'x'),"));
        assert!(s.contains("CONSTRAINT [PK_t] PRIMARY KEY CLUSTERED ([id] ASC),"));
        assert!(s.contains("REFERENCES [dbo].[o] ([id]) ON DELETE CASCADE,"));
        assert!(s.contains("CONSTRAINT [CK_t] CHECK ([id]>(0))\n);"));
        assert!(s.contains("CREATE NONCLUSTERED INDEX [IX_t_name] ON [dbo].[t] ([name] DESC) INCLUDE ([id]) WHERE ([name] IS NOT NULL);"));
        assert!(s.contains("N'COLUMN', N'name';"));
    }

    #[test]
    fn mysql_post() {
        let s = "CREATE TABLE `t` (\n  `id` int NOT NULL COMMENT 'the ''id''',\n  `a` varchar(3) DEFAULT ' COMMENT ''x''',\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `u` (`a`),\n  KEY `k` (`a`)\n) ENGINE=InnoDB COMMENT='tbl'";
        let c = strip_mysql_comments(s);
        assert!(c.contains("`id` int NOT NULL,"));
        assert!(c.contains("DEFAULT ' COMMENT ''x''',"));
        assert!(c.ends_with(") ENGINE=InnoDB"));
        let i = strip_mysql_indexes(s);
        assert!(i.contains("UNIQUE KEY `u` (`a`)\n) ENGINE"), "{}", i);
        assert!(!i.contains("KEY `k`"));
        assert_eq!(
            mysql_qualify("CREATE TABLE `t` (", "TABLE", "t", "shop"),
            "CREATE TABLE `shop`.`t` ("
        );
        assert_eq!(finish_statement("SELECT 1\n\n"), "SELECT 1;\n");
    }
}

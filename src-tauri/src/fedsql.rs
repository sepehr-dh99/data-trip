//! Pure SQL analysis for cross-source (federated) queries: a small tokenizer, the finder for
//! `alias.schema.table` / `alias.table` references, projection / WHERE pushdown and the rewrite of
//! the outer query for the in-memory SQLite database. Std only, so it is easy to unit test.
//!
//! Everything here is deliberately conservative: when a pushdown cannot be proven safe by these
//! simple rules, the whole table is pulled (`SELECT *`, no WHERE).

use std::collections::{HashMap, HashSet};

/// Identifier quoting / folding rules of a source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
    Mssql,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Ws,
    Comment,
    /// Unquoted identifier or keyword.
    Ident,
    /// `"x"`, `` `x` `` or `[x]`.
    QIdent,
    /// `'…'`
    Str,
    Num,
    /// Any other single character.
    Punct,
}

#[derive(Clone, Debug)]
pub struct Tok {
    pub kind: Kind,
    /// Byte offsets into the source text.
    pub start: usize,
    pub end: usize,
    pub text: String,
}

impl Tok {
    fn is_punct(&self, s: &str) -> bool {
        self.kind == Kind::Punct && self.text == s
    }

    fn is_kw(&self, k: &str) -> bool {
        self.kind == Kind::Ident && self.text.eq_ignore_ascii_case(k)
    }

    fn is_name(&self) -> bool {
        matches!(self.kind, Kind::Ident | Kind::QIdent)
    }
}

/// Splits SQL into tokens; concatenating every token's text gives back the input.
pub fn tokenize(sql: &str) -> Vec<Tok> {
    let cs: Vec<(usize, char)> = sql.char_indices().collect();
    let n = cs.len();
    let at = |i: usize| -> usize {
        if i < n {
            cs[i].0
        } else {
            sql.len()
        }
    };
    let mut out: Vec<Tok> = Vec::new();
    let mut i = 0;
    while i < n {
        let c = cs[i].1;
        let next = if i + 1 < n { Some(cs[i + 1].1) } else { None };
        let begin = i;
        let kind = if c.is_whitespace() {
            while i < n && cs[i].1.is_whitespace() {
                i += 1;
            }
            Kind::Ws
        } else if c == '-' && next == Some('-') {
            while i < n && cs[i].1 != '\n' {
                i += 1;
            }
            Kind::Comment
        } else if c == '/' && next == Some('*') {
            i += 2;
            while i < n && !(cs[i].1 == '*' && i + 1 < n && cs[i + 1].1 == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            Kind::Comment
        } else if c == '\'' || c == '"' || c == '`' || c == '[' {
            let close = if c == '[' { ']' } else { c };
            i += 1;
            while i < n {
                if cs[i].1 == close {
                    if i + 1 < n && cs[i + 1].1 == close {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            if c == '\'' {
                Kind::Str
            } else {
                Kind::QIdent
            }
        } else if c.is_alphabetic() || c == '_' {
            while i < n && (cs[i].1.is_alphanumeric() || cs[i].1 == '_' || cs[i].1 == '$') {
                i += 1;
            }
            Kind::Ident
        } else if c.is_ascii_digit() || (c == '.' && next.is_some_and(|d| d.is_ascii_digit())) {
            while i < n && (cs[i].1.is_ascii_digit() || cs[i].1 == '.') {
                i += 1;
            }
            if i < n && (cs[i].1 == 'e' || cs[i].1 == 'E') {
                let mut j = i + 1;
                if j < n && (cs[j].1 == '+' || cs[j].1 == '-') {
                    j += 1;
                }
                if j < n && cs[j].1.is_ascii_digit() {
                    i = j;
                    while i < n && cs[i].1.is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            Kind::Num
        } else {
            i += 1;
            Kind::Punct
        };
        let (s, e) = (at(begin), at(i));
        out.push(Tok {
            kind,
            start: s,
            end: e,
            text: sql[s..e].to_string(),
        });
    }
    out
}

/// An identifier as written: unquoted (case-insensitive) or quoted (exact).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Name {
    pub text: String,
    pub quoted: bool,
}

impl Name {
    /// Identity of a table/column name: unquoted names fold to lower case.
    fn key(&self) -> String {
        if self.quoted {
            self.text.clone()
        } else {
            self.text.to_lowercase()
        }
    }

    /// Case-insensitive comparison key (SQLite and alias semantics).
    fn ci(&self) -> String {
        self.text.to_lowercase()
    }
}

fn name_of(t: &Tok) -> Option<Name> {
    match t.kind {
        Kind::Ident => Some(Name {
            text: t.text.clone(),
            quoted: false,
        }),
        Kind::QIdent => {
            let open = t.text.chars().next()?;
            let close = if open == '[' { ']' } else { open };
            let mut inner = &t.text[open.len_utf8()..];
            if !inner.is_empty() && inner.ends_with(close) {
                inner = &inner[..inner.len() - close.len_utf8()];
            }
            let doubled: String = [close, close].iter().collect();
            Some(Name {
                text: inner.replace(&doubled, &close.to_string()),
                quoted: true,
            })
        }
        _ => None,
    }
}

/// Quotes an arbitrary string as an identifier of the dialect.
pub fn quote_raw(d: Dialect, s: &str) -> String {
    match d {
        Dialect::Mysql => format!("`{}`", s.replace('`', "``")),
        Dialect::Mssql => format!("[{}]", s.replace(']', "]]")),
        Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

/// Quotes a name for a source, keeping its meaning: PostgreSQL folds unquoted names to lower
/// case; in the other dialects quoting does not change case sensitivity.
pub fn quote_name(d: Dialect, n: &Name) -> String {
    if !n.quoted && d == Dialect::Postgres {
        quote_raw(d, &n.text.to_lowercase())
    } else {
        quote_raw(d, &n.text)
    }
}

/// Words that are never column names when they appear bare.
const KEYWORDS: &[&str] = &[
    "ALL",
    "AND",
    "AS",
    "ASC",
    "BETWEEN",
    "BINARY",
    "BOTH",
    "BY",
    "CASE",
    "CAST",
    "COLLATE",
    "CROSS",
    "CURRENT",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "DESC",
    "DISTINCT",
    "ELSE",
    "END",
    "ESCAPE",
    "EXCEPT",
    "EXCLUDE",
    "EXISTS",
    "FALSE",
    "FILTER",
    "FIRST",
    "FOLLOWING",
    "FROM",
    "FULL",
    "GLOB",
    "GROUP",
    "GROUPS",
    "HAVING",
    "IN",
    "INDEXED",
    "INNER",
    "INTERSECT",
    "IS",
    "ISNULL",
    "JOIN",
    "LAST",
    "LEADING",
    "LATERAL",
    "LEFT",
    "LIKE",
    "LIMIT",
    "MATCH",
    "MATERIALIZED",
    "NATURAL",
    "NO",
    "NOCASE",
    "NOT",
    "NOTNULL",
    "NULL",
    "NULLS",
    "OFFSET",
    "ON",
    "ONLY",
    "OR",
    "ORDER",
    "OTHERS",
    "OUTER",
    "OVER",
    "PARTITION",
    "PRECEDING",
    "RANGE",
    "RECURSIVE",
    "REGEXP",
    "RIGHT",
    "ROW",
    "ROWS",
    "RTRIM",
    "SELECT",
    "THEN",
    "TIES",
    "TRAILING",
    "TRUE",
    "UNBOUNDED",
    "UNION",
    "USING",
    "VALUES",
    "WHEN",
    "WHERE",
    "WINDOW",
    "WITH",
];

fn is_keyword(word: &str) -> bool {
    let up = word.to_ascii_uppercase();
    KEYWORDS.contains(&up.as_str())
}

/// Keywords allowed inside a pushed-down WHERE conjunct.
const PUSH_KEYWORDS: &[&str] = &["AND", "OR", "NOT", "IS", "NULL", "IN", "BETWEEN", "LIKE"];

/// One table pulled from a source.
#[derive(Clone, Debug)]
pub struct PlannedTable {
    /// Source alias, lower case.
    pub source: String,
    /// The reference as written, e.g. `pg.public.users`.
    pub display: String,
    /// Name of the table in the in-memory SQLite database (unquoted).
    pub sqlite_name: String,
    /// Statement run on the source.
    pub pull_sql: String,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub tables: Vec<PlannedTable>,
    /// The outer query rewritten for the in-memory SQLite database.
    pub sql: String,
}

/// A run of `name . name . name [. *]` starting at a significant-token position.
struct Chain {
    /// Significant-token positions of the name parts.
    parts: Vec<usize>,
    /// Ends with `.*`.
    star: bool,
    /// Significant-token position after the chain.
    end: usize,
}

#[derive(Default, Clone, Copy)]
struct Level {
    saw_select: bool,
    in_from: bool,
}

struct DTable {
    source: String,
    schema: Option<Name>,
    table: Name,
    display: String,
    sqlite_name: String,
    uses: Vec<usize>,
}

struct Use {
    table: usize,
    /// Text that qualifies this use's columns in the rewritten query.
    alias_raw: String,
    /// Lower-case effective alias (explicit alias, else the table name).
    eff: String,
    explicit_alias: bool,
    depth: usize,
    nullable: bool,
    span: (usize, usize),
}

struct ColRef {
    qual: Vec<Name>,
    /// None = `qualifier.*`.
    col: Option<Name>,
    col_raw: String,
    span: (usize, usize),
}

struct Analyzer<'a> {
    toks: &'a [Tok],
    sig: &'a [usize],
}

impl<'a> Analyzer<'a> {
    fn tok(&self, p: usize) -> Option<&'a Tok> {
        self.sig.get(p).map(|&i| &self.toks[i])
    }

    fn chain_at(&self, p: usize) -> Chain {
        let mut parts = vec![p];
        let mut q = p + 1;
        let mut star = false;
        loop {
            let dot = self.tok(q).is_some_and(|t| t.is_punct("."));
            if !dot {
                break;
            }
            match self.tok(q + 1) {
                Some(t) if t.is_name() => {
                    parts.push(q + 1);
                    q += 2;
                }
                Some(t) if t.is_punct("*") => {
                    star = true;
                    q += 2;
                    break;
                }
                _ => break,
            }
        }
        Chain {
            parts,
            star,
            end: q,
        }
    }

    fn name(&self, p: usize) -> Name {
        self.tok(p).and_then(name_of).unwrap_or_default()
    }

    fn is_paren_at(&self, p: usize) -> bool {
        self.tok(p).is_some_and(|t| t.is_punct("("))
    }

    /// Optional table / subquery alias at `p`: `AS x`, `"x"` or a bare non-keyword.
    /// Returns (alias position, next position).
    fn alias_at(&self, p: usize) -> (Option<usize>, usize) {
        match self.tok(p) {
            Some(t) if t.is_kw("AS") => match self.tok(p + 1) {
                Some(n) if n.is_name() => (Some(p + 1), p + 2),
                _ => (None, p + 1),
            },
            Some(t) if t.kind == Kind::QIdent => (Some(p), p + 1),
            Some(t)
                if t.kind == Kind::Ident
                    && !is_keyword(&t.text)
                    && !self
                        .tok(p + 1)
                        .is_some_and(|n| n.is_punct(".") || n.is_punct("(")) =>
            {
                (Some(p), p + 1)
            }
            _ => (None, p),
        }
    }

    fn span(&self, first: usize, last: usize) -> (usize, usize) {
        (
            self.toks[self.sig[first]].start,
            self.toks[self.sig[last]].end,
        )
    }

    fn raw(&self, first: usize, last: usize) -> String {
        self.sig[first..=last]
            .iter()
            .map(|&i| self.toks[i].text.as_str())
            .collect()
    }
}

/// Plans a federated query. `sources` = (alias, dialect) of every attached source.
pub fn plan(sql: &str, sources: &[(String, Dialect)]) -> Result<Plan, String> {
    let dialects: HashMap<String, Dialect> = sources
        .iter()
        .map(|(a, d)| (a.to_lowercase(), *d))
        .collect();
    let toks = tokenize(sql);
    let mut sig: Vec<usize> = toks
        .iter()
        .enumerate()
        .filter(|(_, t)| !matches!(t.kind, Kind::Ws | Kind::Comment))
        .map(|(i, _)| i)
        .collect();

    // One statement only (a trailing `;` is fine).
    if let Some(pos) = sig.iter().position(|&i| toks[i].is_punct(";")) {
        if sig[pos..].iter().any(|&i| !toks[i].is_punct(";")) {
            return Err("Run one statement at a time in a cross-source query.".to_string());
        }
        sig.truncate(pos);
    }
    let first_word = sig.iter().map(|&i| &toks[i]).find(|t| !t.is_punct("("));
    let is_query = matches!(first_word, Some(t) if t.is_kw("SELECT") || t.is_kw("WITH"));
    if !is_query {
        return Err("Cross-source queries support only SELECT / WITH statements.".to_string());
    }

    let az = Analyzer {
        toks: &toks,
        sig: &sig,
    };

    let mut tables: Vec<DTable> = Vec::new();
    let mut uses: Vec<Use> = Vec::new();
    let mut colrefs: Vec<ColRef> = Vec::new();
    let mut bare: Vec<String> = Vec::new();
    let mut declared: HashSet<String> = HashSet::new();
    let mut sqlite_names: HashSet<String> = HashSet::new();

    let mut levels: Vec<Level> = vec![Level::default()];
    let mut expect_table = false;
    let mut pending_left = false;
    let mut nullable_next = false;
    let mut outer_right_full = false;
    let mut natural = false;
    let mut global_star = false;
    let mut where0: Vec<usize> = Vec::new();
    let mut set_op0 = false;

    let mut p = 0;
    while p < sig.len() {
        let t = &toks[sig[p]];
        let depth = levels.len() - 1;
        if t.kind == Kind::Punct {
            match t.text.as_str() {
                "(" => {
                    levels.push(Level::default());
                    expect_table = false;
                }
                ")" => {
                    if levels.len() > 1 {
                        levels.pop();
                    }
                    expect_table = false;
                    // Alias of a subquery / table function in FROM.
                    if levels.last().is_some_and(|l| l.in_from) {
                        if let (Some(a), next) = az.alias_at(p + 1) {
                            declared.insert(az.name(a).ci());
                            p = next;
                            continue;
                        }
                    }
                }
                "," => {
                    if levels.last().is_some_and(|l| l.in_from) {
                        expect_table = true;
                    }
                }
                "*" => {
                    let prev = if p > 0 { az.tok(p - 1) } else { None };
                    let select_star = prev.is_some_and(|pt| {
                        pt.is_punct(",")
                            || pt.is_kw("SELECT")
                            || pt.is_kw("DISTINCT")
                            || pt.is_kw("ALL")
                    });
                    if select_star {
                        global_star = true;
                    }
                }
                _ => {}
            }
            p += 1;
            continue;
        }

        let followed_by_dot = az.tok(p + 1).is_some_and(|n| n.is_punct("."));
        if t.kind == Kind::Ident && !followed_by_dot && is_keyword(&t.text) {
            let up = t.text.to_ascii_uppercase();
            let top = levels.last_mut().expect("level");
            match up.as_str() {
                "SELECT" => {
                    top.saw_select = true;
                    top.in_from = false;
                    expect_table = false;
                }
                "FROM" => {
                    if top.saw_select {
                        top.in_from = true;
                        expect_table = true;
                    }
                }
                "JOIN" => {
                    expect_table = true;
                    nullable_next = pending_left;
                    pending_left = false;
                }
                "LEFT" => pending_left = true,
                "RIGHT" | "FULL" => outer_right_full = true,
                "NATURAL" => natural = true,
                "WHERE" => {
                    top.in_from = false;
                    expect_table = false;
                    if depth == 0 {
                        where0.push(p);
                    }
                }
                "GROUP" | "ORDER" | "HAVING" | "LIMIT" | "WINDOW" | "OFFSET" => {
                    top.in_from = false;
                    expect_table = false;
                }
                "UNION" | "EXCEPT" | "INTERSECT" => {
                    top.in_from = false;
                    top.saw_select = false;
                    expect_table = false;
                    if depth == 0 {
                        set_op0 = true;
                    }
                }
                "AS" => {
                    if let Some(n) = az.tok(p + 1).and_then(name_of) {
                        declared.insert(n.ci());
                        p += 2;
                        continue;
                    }
                }
                _ => {}
            }
            p += 1;
            continue;
        }

        if t.is_name() {
            let ch = az.chain_at(p);
            let next_is_paren = az.is_paren_at(ch.end);
            if expect_table && !ch.star {
                expect_table = false;
                if next_is_paren {
                    // Table-valued function, e.g. json_each(...).
                    p = ch.end;
                    continue;
                }
                let (alias_pos, next) = az.alias_at(ch.end);
                if ch.parts.len() == 1 {
                    // CTE or other local name.
                    declared.insert(az.name(p).ci());
                    if let Some(a) = alias_pos {
                        declared.insert(az.name(a).ci());
                    }
                    p = next;
                    continue;
                }
                let last = *ch.parts.last().expect("parts");
                let display = az.raw(p, last);
                let src = az.name(p);
                if !dialects.contains_key(&src.ci()) {
                    return Err(format!(
                        "Unknown source alias '{}' — attach it or use alias.schema.table",
                        src.text
                    ));
                }
                if ch.parts.len() > 3 {
                    return Err(format!(
                        "'{}' has too many name parts — use alias.schema.table or alias.table",
                        display
                    ));
                }
                let schema = if ch.parts.len() == 3 {
                    Some(az.name(ch.parts[1]))
                } else {
                    None
                };
                let table = az.name(last);
                let source = src.ci();
                let idx = match tables.iter().position(|d| {
                    d.source == source
                        && d.table.key() == table.key()
                        && d.schema.as_ref().map(Name::key) == schema.as_ref().map(Name::key)
                }) {
                    Some(i) => i,
                    None => {
                        let mut base = source.clone();
                        if let Some(s) = &schema {
                            base.push('.');
                            base.push_str(&s.key());
                        }
                        base.push('.');
                        base.push_str(&table.key());
                        let mut name = base.clone();
                        let mut k = 2;
                        while sqlite_names.contains(&name.to_lowercase()) {
                            name = format!("{}#{}", base, k);
                            k += 1;
                        }
                        sqlite_names.insert(name.to_lowercase());
                        tables.push(DTable {
                            source,
                            schema,
                            table: table.clone(),
                            display,
                            sqlite_name: name,
                            uses: Vec::new(),
                        });
                        tables.len() - 1
                    }
                };
                let (alias_raw, eff, explicit_alias) = match alias_pos {
                    Some(a) => {
                        let at = &toks[sig[a]];
                        (at.text.clone(), az.name(a).ci(), true)
                    }
                    None => (toks[sig[last]].text.clone(), table.ci(), false),
                };
                tables[idx].uses.push(uses.len());
                uses.push(Use {
                    table: idx,
                    alias_raw,
                    eff,
                    explicit_alias,
                    depth,
                    nullable: nullable_next,
                    span: az.span(p, last),
                });
                nullable_next = false;
                p = next;
                continue;
            }
            if ch.parts.len() == 1 && !ch.star {
                let followed_by_str = az.tok(p + 1).is_some_and(|n| n.kind == Kind::Str);
                if !(next_is_paren || (t.kind == Kind::Ident && followed_by_str)) {
                    bare.push(az.name(p).ci());
                }
                p += 1;
                continue;
            }
            if next_is_paren {
                // schema.function(...)
                p = ch.end;
                continue;
            }
            let last_sig = ch.end - 1;
            let (qual_parts, col) = if ch.star {
                (ch.parts.clone(), None)
            } else {
                let n = ch.parts.len();
                (ch.parts[..n - 1].to_vec(), Some(az.name(ch.parts[n - 1])))
            };
            let col_raw = if ch.star {
                "*".to_string()
            } else {
                toks[sig[*ch.parts.last().expect("parts")]].text.clone()
            };
            colrefs.push(ColRef {
                qual: qual_parts.iter().map(|&q| az.name(q)).collect(),
                col,
                col_raw,
                span: az.span(p, last_sig),
            });
            p = ch.end;
            continue;
        }
        p += 1;
    }

    if tables.is_empty() {
        return Err(
            "No attached source is referenced. Refer to tables as alias.schema.table (e.g. pg.public.users)."
                .to_string(),
        );
    }

    // Effective aliases → uses; an alias used twice makes its tables ambiguous.
    let mut by_eff: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, u) in uses.iter().enumerate() {
        by_eff.entry(u.eff.clone()).or_default().push(i);
    }
    let mut ambiguous = vec![false; tables.len()];
    for list in by_eff.values() {
        if list.len() > 1 {
            for &u in list {
                ambiguous[uses[u].table] = true;
            }
        }
    }

    let mut cols: Vec<Vec<Name>> = vec![Vec::new(); tables.len()];
    let mut star = vec![false; tables.len()];
    let mut replacements: Vec<(usize, usize, String)> = Vec::new();
    let add_col = |cols: &mut [Vec<Name>], star: &mut [bool], ti: usize, c: &Option<Name>| match c {
        Some(n) => {
            if !cols[ti].iter().any(|x| x.ci() == n.ci()) {
                cols[ti].push(n.clone());
            }
        }
        None => star[ti] = true,
    };
    for cr in &colrefs {
        if cr.qual.len() == 1 {
            if let Some(list) = by_eff.get(&cr.qual[0].ci()) {
                for &u in list {
                    add_col(&mut cols, &mut star, uses[u].table, &cr.col);
                }
            }
            continue;
        }
        let src = cr.qual[0].ci();
        if !dialects.contains_key(&src) {
            continue;
        }
        let (schema, table) = if cr.qual.len() == 2 {
            (None, &cr.qual[1])
        } else if cr.qual.len() == 3 {
            (Some(&cr.qual[1]), &cr.qual[2])
        } else {
            continue;
        };
        let found = tables.iter().position(|d| {
            d.source == src
                && d.table.key() == table.key()
                && d.schema.as_ref().map(Name::key) == schema.map(Name::key)
        });
        if let Some(ti) = found {
            add_col(&mut cols, &mut star, ti, &cr.col);
            let u = &uses[tables[ti].uses[0]];
            replacements.push((
                cr.span.0,
                cr.span.1,
                format!("{}.{}", u.alias_raw, cr.col_raw),
            ));
        }
    }

    let known: HashSet<String> = by_eff.keys().cloned().collect();
    let unresolved_bare = bare
        .iter()
        .any(|b| !declared.contains(b) && !known.contains(b));
    let projection_ok = !global_star && !natural && !unresolved_bare;

    // ----- WHERE pushdown -----
    let mut filters: Vec<Vec<String>> = vec![Vec::new(); tables.len()];
    let pushable = |ti: usize| -> bool {
        let d = &tables[ti];
        if outer_right_full || ambiguous[ti] || d.uses.len() != 1 {
            return false;
        }
        let u = &uses[d.uses[0]];
        u.depth == 0 && !u.nullable
    };
    if where0.len() == 1 && !set_op0 {
        let start = where0[0] + 1;
        let mut end = start;
        let mut d = 0usize;
        while end < sig.len() {
            let t = &toks[sig[end]];
            if t.is_punct("(") {
                d += 1;
            } else if t.is_punct(")") {
                if d == 0 {
                    break;
                }
                d -= 1;
            } else if d == 0
                && t.kind == Kind::Ident
                && [
                    "GROUP",
                    "ORDER",
                    "HAVING",
                    "LIMIT",
                    "WINDOW",
                    "OFFSET",
                    "UNION",
                    "EXCEPT",
                    "INTERSECT",
                ]
                .iter()
                .any(|k| t.is_kw(k))
            {
                break;
            }
            end += 1;
        }
        let mut conjuncts: Vec<(usize, usize)> = Vec::new();
        let mut cs = start;
        let mut d = 0usize;
        let mut between = false;
        let mut has_or = false;
        for (off, &tix) in sig[start..end].iter().enumerate() {
            let q = start + off;
            let t = &toks[tix];
            if t.is_punct("(") {
                d += 1;
            } else if t.is_punct(")") {
                d = d.saturating_sub(1);
            } else if d == 0 {
                if t.is_kw("OR") {
                    has_or = true;
                } else if t.is_kw("BETWEEN") {
                    between = true;
                } else if t.is_kw("AND") {
                    if between {
                        between = false;
                    } else {
                        conjuncts.push((cs, q));
                        cs = q + 1;
                    }
                }
            }
        }
        conjuncts.push((cs, end));
        if !has_or {
            for (a, b) in conjuncts {
                if let Some((alias, chains)) = analyze_conjunct(&az, a, b) {
                    let ti = match by_eff.get(&alias) {
                        Some(list) if list.len() == 1 => uses[list[0]].table,
                        _ => continue,
                    };
                    if !pushable(ti) {
                        continue;
                    }
                    let dialect = dialects
                        .get(&tables[ti].source)
                        .copied()
                        .unwrap_or(Dialect::Postgres);
                    filters[ti].push(render_conjunct(&toks, sig[a], sig[b - 1], &chains, dialect));
                }
            }
        }
    }

    // ----- pull statements -----
    let mut planned: Vec<PlannedTable> = Vec::new();
    for (ti, d) in tables.iter().enumerate() {
        let dialect = dialects
            .get(&d.source)
            .copied()
            .unwrap_or(Dialect::Postgres);
        let select_list = if projection_ok && !ambiguous[ti] && !star[ti] && !cols[ti].is_empty() {
            cols[ti]
                .iter()
                .map(|c| quote_name(dialect, c))
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            "*".to_string()
        };
        let mut from = String::new();
        if let Some(s) = &d.schema {
            from.push_str(&quote_name(dialect, s));
            from.push('.');
        }
        from.push_str(&quote_name(dialect, &d.table));
        let mut pull = format!("SELECT {} FROM {}", select_list, from);
        if !filters[ti].is_empty() {
            let w: Vec<String> = filters[ti].iter().map(|f| format!("({})", f)).collect();
            pull.push_str(" WHERE ");
            pull.push_str(&w.join(" AND "));
        }
        planned.push(PlannedTable {
            source: d.source.clone(),
            display: d.display.clone(),
            sqlite_name: d.sqlite_name.clone(),
            pull_sql: pull,
        });
    }

    // ----- rewrite -----
    for u in &uses {
        let name = quote_raw(Dialect::Sqlite, &tables[u.table].sqlite_name);
        let text = if u.explicit_alias {
            name
        } else {
            format!("{} AS {}", name, u.alias_raw)
        };
        replacements.push((u.span.0, u.span.1, text));
    }
    replacements.sort_by_key(|r| r.0);
    let mut out = String::with_capacity(sql.len() + 64);
    let mut pos = 0;
    for (s, e, text) in replacements {
        if s < pos {
            continue;
        }
        out.push_str(&sql[pos..s]);
        out.push_str(&text);
        pos = e;
    }
    out.push_str(&sql[pos..]);

    Ok(Plan {
        tables: planned,
        sql: out,
    })
}

/// `alias.col` inside a pushed conjunct: (first token index, last token index, column).
type PushChain = (usize, usize, Name);

/// Checks that a WHERE conjunct (significant positions `a..b`) only uses literals, comparison
/// operators, IS/NULL/IN/BETWEEN/LIKE/NOT/AND/OR and columns qualified by ONE table alias.
/// Returns (lower-case alias, chains as (first token index, last token index, column)).
fn analyze_conjunct(az: &Analyzer<'_>, a: usize, b: usize) -> Option<(String, Vec<PushChain>)> {
    if a >= b {
        return None;
    }
    let mut alias: Option<String> = None;
    let mut chains: Vec<PushChain> = Vec::new();
    let mut q = a;
    while q < b {
        let t = az.tok(q)?;
        match t.kind {
            Kind::Num => {}
            Kind::Str => {
                if t.text.contains('\\') {
                    return None;
                }
            }
            Kind::Punct => match t.text.as_str() {
                "=" | "<" | ">" | "!" | "(" | ")" | "," => {}
                "-" => {
                    if !(q + 1 < b && az.tok(q + 1).is_some_and(|n| n.kind == Kind::Num)) {
                        return None;
                    }
                }
                _ => return None,
            },
            Kind::Ident if !az.tok(q + 1).is_some_and(|n| n.is_punct(".")) => {
                let up = t.text.to_ascii_uppercase();
                if !PUSH_KEYWORDS.contains(&up.as_str()) {
                    return None;
                }
            }
            Kind::Ident | Kind::QIdent => {
                let ch = az.chain_at(q);
                if ch.end > b || ch.star || ch.parts.len() != 2 || az.is_paren_at(ch.end) {
                    return None;
                }
                let qa = az.name(ch.parts[0]).ci();
                match &alias {
                    Some(x) if *x != qa => return None,
                    _ => alias = Some(qa),
                }
                chains.push((az.sig[q], az.sig[ch.end - 1], az.name(ch.parts[1])));
                q = ch.end;
                continue;
            }
            Kind::Ws | Kind::Comment => {}
        }
        q += 1;
    }
    alias.map(|a| (a, chains))
}

/// The conjunct's text with `alias.col` replaced by the source-quoted column; whitespace and
/// comments collapse to single spaces; literals are kept verbatim.
fn render_conjunct(
    toks: &[Tok],
    first: usize,
    last: usize,
    chains: &[PushChain],
    dialect: Dialect,
) -> String {
    let mut out = String::new();
    let mut i = first;
    while i <= last {
        if let Some((_, end, col)) = chains.iter().find(|c| c.0 == i) {
            out.push_str(&quote_name(dialect, col));
            i = end + 1;
            continue;
        }
        match toks[i].kind {
            Kind::Ws | Kind::Comment => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            _ => out.push_str(&toks[i].text),
        }
        i += 1;
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn srcs() -> Vec<(String, Dialect)> {
        vec![
            ("pg".to_string(), Dialect::Postgres),
            ("my".to_string(), Dialect::Mysql),
            ("ms".to_string(), Dialect::Mssql),
            ("lite".to_string(), Dialect::Sqlite),
        ]
    }

    fn table<'a>(p: &'a Plan, name: &str) -> &'a PlannedTable {
        p.tables
            .iter()
            .find(|t| t.sqlite_name == name)
            .unwrap_or_else(|| panic!("no table {} in {:?}", name, p.tables))
    }

    #[test]
    fn tokenizer_round_trips_and_classifies() {
        let sql = "SELECT 'a''b', \"x\"\"y\", `z`, [w]]v] -- c pg.a.b\n/* pg.x.y */ 1.5e3 FROM t;";
        let toks = tokenize(sql);
        let joined: String = toks.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(joined, sql);
        let kinds: Vec<Kind> = toks
            .iter()
            .filter(|t| !matches!(t.kind, Kind::Ws))
            .map(|t| t.kind)
            .collect();
        assert_eq!(
            kinds,
            vec![
                Kind::Ident,
                Kind::Str,
                Kind::Punct,
                Kind::QIdent,
                Kind::Punct,
                Kind::QIdent,
                Kind::Punct,
                Kind::QIdent,
                Kind::Comment,
                Kind::Comment,
                Kind::Num,
                Kind::Ident,
                Kind::Ident,
                Kind::Punct,
            ]
        );
        let q = toks.iter().find(|t| t.text.starts_with('"')).expect("q");
        assert_eq!(name_of(q).expect("name").text, "x\"y");
        let b = toks.iter().find(|t| t.text.starts_with('[')).expect("b");
        assert_eq!(name_of(b).expect("name").text, "w]v");
    }

    #[test]
    fn tokenizer_handles_unicode_and_unterminated() {
        let sql = "SELECT 'héllo' AS ünï, 'open";
        let toks = tokenize(sql);
        let joined: String = toks.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(joined, sql);
        assert_eq!(toks.last().expect("last").kind, Kind::Str);
    }

    #[test]
    fn join_with_projection_and_pushdown() {
        let sql = "SELECT u.name, o.total FROM pg.public.users u JOIN my.orders AS o ON o.user_id = u.id \
                   WHERE u.active = 1 AND o.total > 100 ORDER BY o.total DESC";
        let p = plan(sql, &srcs()).expect("plan");
        assert_eq!(p.tables.len(), 2);
        assert_eq!(
            table(&p, "pg.public.users").pull_sql,
            "SELECT \"name\", \"id\", \"active\" FROM \"public\".\"users\" WHERE (\"active\" = 1)"
        );
        assert_eq!(
            table(&p, "my.orders").pull_sql,
            "SELECT `total`, `user_id` FROM `orders` WHERE (`total` > 100)"
        );
        assert_eq!(
            p.sql,
            "SELECT u.name, o.total FROM \"pg.public.users\" u JOIN \"my.orders\" AS o ON o.user_id = u.id \
                   WHERE u.active = 1 AND o.total > 100 ORDER BY o.total DESC"
        );
        assert_eq!(table(&p, "pg.public.users").display, "pg.public.users");
    }

    #[test]
    fn star_pulls_everything_and_cross_alias_conjunct_is_not_pushed() {
        let p = plan("SELECT * FROM pg.t a, my.u b WHERE a.id = b.id", &srcs()).expect("plan");
        assert_eq!(table(&p, "pg.t").pull_sql, "SELECT * FROM \"t\"");
        assert_eq!(table(&p, "my.u").pull_sql, "SELECT * FROM `u`");
        assert_eq!(
            p.sql,
            "SELECT * FROM \"pg.t\" a, \"my.u\" b WHERE a.id = b.id"
        );
    }

    #[test]
    fn qualified_star_pulls_that_table_only() {
        let p = plan(
            "SELECT a.*, b.x FROM pg.t a JOIN my.u b ON b.id = a.id",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(table(&p, "pg.t").pull_sql, "SELECT * FROM \"t\"");
        assert_eq!(table(&p, "my.u").pull_sql, "SELECT `x`, `id` FROM `u`");
    }

    #[test]
    fn bare_column_disables_projection_but_not_pushdown() {
        let p = plan("SELECT name FROM pg.users u WHERE u.id = 1", &srcs()).expect("plan");
        assert_eq!(
            table(&p, "pg.users").pull_sql,
            "SELECT * FROM \"users\" WHERE (\"id\" = 1)"
        );
    }

    #[test]
    fn output_aliases_and_count_star_keep_projection() {
        let p = plan(
            "SELECT u.city AS c, count(*) AS n FROM pg.users u GROUP BY u.city ORDER BY n DESC, c",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.users").pull_sql,
            "SELECT \"city\" FROM \"users\""
        );
    }

    #[test]
    fn top_level_or_prevents_pushdown() {
        let p = plan(
            "SELECT u.id FROM pg.users u WHERE u.a = 1 AND u.b = 2 OR u.c = 3",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.users").pull_sql,
            "SELECT \"id\", \"a\", \"b\", \"c\" FROM \"users\""
        );
    }

    #[test]
    fn parenthesized_or_on_one_alias_is_pushed() {
        let p = plan(
            "SELECT u.id FROM pg.users u WHERE (u.a = 1 OR u.b IS NULL) AND u.c IN (1, 2)",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.users").pull_sql,
            "SELECT \"id\", \"a\", \"b\", \"c\" FROM \"users\" WHERE ((\"a\" = 1 OR \"b\" IS NULL)) AND (\"c\" IN (1, 2))"
        );
    }

    #[test]
    fn between_and_is_one_conjunct() {
        let p = plan(
            "SELECT u.id FROM pg.users u WHERE u.age BETWEEN 18 AND 30 AND u.name = 'O''Brien'",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.users").pull_sql,
            "SELECT \"id\", \"age\", \"name\" FROM \"users\" WHERE (\"age\" BETWEEN 18 AND 30) AND (\"name\" = 'O''Brien')"
        );
    }

    #[test]
    fn left_join_nullable_side_is_not_filtered() {
        let p = plan(
            "SELECT a.id, b.v FROM pg.t a LEFT JOIN my.u b ON b.id = a.id WHERE a.k = 1 AND b.v IS NULL",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.t").pull_sql,
            "SELECT \"id\", \"k\" FROM \"t\" WHERE (\"k\" = 1)"
        );
        assert_eq!(table(&p, "my.u").pull_sql, "SELECT `v`, `id` FROM `u`");
    }

    #[test]
    fn right_join_disables_all_where_pushdown() {
        let p = plan(
            "SELECT a.id FROM pg.t a RIGHT JOIN my.u b ON b.id = a.id WHERE a.k = 1",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.t").pull_sql,
            "SELECT \"id\", \"k\" FROM \"t\""
        );
    }

    #[test]
    fn subquery_function_and_param_conjuncts_are_not_pushed() {
        let p = plan(
            "SELECT u.id FROM pg.users u WHERE u.id IN (SELECT o.uid FROM my.orders o) \
             AND lower(u.name) = 'a' AND u.x = ? AND u.y || 'a' = 'ba' AND u.z = 5",
            &srcs(),
        )
        .expect("plan");
        let pull = &table(&p, "pg.users").pull_sql;
        assert!(pull.ends_with("WHERE (\"z\" = 5)"), "{}", pull);
        // The subquery's table is pulled without filters.
        assert_eq!(
            table(&p, "my.orders").pull_sql,
            "SELECT `uid` FROM `orders`"
        );
    }

    #[test]
    fn self_join_pulls_once_without_filters() {
        let p = plan(
            "SELECT a.id, b.id FROM pg.t a JOIN pg.t b ON a.parent = b.id WHERE a.k = 1",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(p.tables.len(), 1);
        assert_eq!(
            table(&p, "pg.t").pull_sql,
            "SELECT \"id\", \"parent\", \"k\" FROM \"t\""
        );
        assert_eq!(
            p.sql,
            "SELECT a.id, b.id FROM \"pg.t\" a JOIN \"pg.t\" b ON a.parent = b.id WHERE a.k = 1"
        );
    }

    #[test]
    fn unaliased_tables_get_their_name_and_full_column_refs_are_rewritten() {
        let p = plan(
            "SELECT pg.public.users.name, users.id FROM pg.public.users WHERE users.id > 10",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.public.users").pull_sql,
            "SELECT \"name\", \"id\" FROM \"public\".\"users\" WHERE (\"id\" > 10)"
        );
        assert_eq!(
            p.sql,
            "SELECT users.name, users.id FROM \"pg.public.users\" AS users WHERE users.id > 10"
        );
    }

    #[test]
    fn dialect_quoting() {
        let p = plan("SELECT o.\"Total\" FROM ms.dbo.Orders o; ", &srcs()).expect("plan");
        assert_eq!(
            table(&p, "ms.dbo.orders").pull_sql,
            "SELECT [Total] FROM [dbo].[Orders]"
        );
        let p = plan(
            "SELECT x.\"Id\" FROM pg.\"Sales\".\"Big Orders\" x",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.Sales.Big Orders").pull_sql,
            "SELECT \"Id\" FROM \"Sales\".\"Big Orders\""
        );
        assert_eq!(p.sql, "SELECT x.\"Id\" FROM \"pg.Sales.Big Orders\" x");
        let p = plan("SELECT * FROM PG.Public.Users", &srcs()).expect("plan");
        assert_eq!(
            table(&p, "pg.public.users").pull_sql,
            "SELECT * FROM \"public\".\"users\""
        );
    }

    #[test]
    fn comments_and_strings_are_ignored() {
        let p = plan(
            "SELECT 'pg.a.b' AS s, u.id -- FROM foo.bar.baz\nFROM /* bar.x.y */ lite.main.users u",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(p.tables.len(), 1);
        assert_eq!(
            table(&p, "lite.main.users").pull_sql,
            "SELECT \"id\" FROM \"main\".\"users\""
        );
    }

    #[test]
    fn errors() {
        let e = plan("SELECT * FROM foo.bar.baz", &srcs()).expect_err("unknown");
        assert!(e.starts_with("Unknown source alias 'foo'"), "{}", e);
        let e = plan("DELETE FROM pg.users", &srcs()).expect_err("dml");
        assert!(e.contains("only SELECT"), "{}", e);
        let e = plan("SELECT * FROM pg.t; DROP TABLE x", &srcs()).expect_err("multi");
        assert!(e.contains("one statement"), "{}", e);
        let e = plan("SELECT 1", &srcs()).expect_err("none");
        assert!(e.contains("No attached source"), "{}", e);
        let e = plan("SELECT * FROM pg.a.b.c", &srcs()).expect_err("parts");
        assert!(e.contains("too many name parts"), "{}", e);
    }

    #[test]
    fn function_from_and_subquery_alias_do_not_confuse_the_finder() {
        let p = plan(
            "WITH c AS (SELECT o.uid, o.amt FROM my.orders o) \
             SELECT trim(BOTH ' ' FROM u.name), s.n FROM pg.users u \
             JOIN (SELECT c.uid, sum(c.amt) AS n FROM c GROUP BY c.uid) s ON s.uid = u.id",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(p.tables.len(), 2);
        assert_eq!(
            table(&p, "pg.users").pull_sql,
            "SELECT \"name\", \"id\" FROM \"users\""
        );
        assert_eq!(
            table(&p, "my.orders").pull_sql,
            "SELECT `uid`, `amt` FROM `orders`"
        );
    }

    #[test]
    fn using_and_natural_disable_projection() {
        let p = plan("SELECT a.x FROM pg.t a JOIN my.u b USING (id)", &srcs()).expect("plan");
        assert_eq!(table(&p, "pg.t").pull_sql, "SELECT * FROM \"t\"");
        let p = plan("SELECT a.x FROM pg.t a NATURAL JOIN my.u b", &srcs()).expect("plan");
        assert_eq!(table(&p, "my.u").pull_sql, "SELECT * FROM `u`");
    }

    #[test]
    fn mysql_backslash_literal_is_not_pushed() {
        let p = plan(
            "SELECT o.id FROM my.t o WHERE o.p = 'C:\\x' AND o.q = 1",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "my.t").pull_sql,
            "SELECT `id`, `p`, `q` FROM `t` WHERE (`q` = 1)"
        );
    }

    #[test]
    fn union_disables_where_pushdown() {
        let p = plan(
            "SELECT a.id FROM pg.t a WHERE a.k = 1 UNION ALL SELECT b.id FROM my.u b WHERE b.k = 2",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.t").pull_sql,
            "SELECT \"id\", \"k\" FROM \"t\""
        );
        assert_eq!(table(&p, "my.u").pull_sql, "SELECT `id`, `k` FROM `u`");
    }

    #[test]
    fn negative_numbers_and_not_like_are_pushed() {
        let p = plan(
            "SELECT t.id FROM pg.t t WHERE t.v >= -5 AND t.name NOT LIKE 'x%' AND t.w <> 3",
            &srcs(),
        )
        .expect("plan");
        assert_eq!(
            table(&p, "pg.t").pull_sql,
            "SELECT \"id\", \"v\", \"name\", \"w\" FROM \"t\" WHERE (\"v\" >= -5) AND (\"name\" NOT LIKE 'x%') AND (\"w\" <> 3)"
        );
    }
}

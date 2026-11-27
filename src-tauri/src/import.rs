//! Import data (v0.16): preview a CSV / TSV / JSON array / NDJSON file (format detection, first rows, type
//! inference, checks against target column types) and stream it into a table with batched, parameterized
//! multi-row INSERTs on a session, with progress events `import-progress` and cancel. The file is read on a
//! blocking thread in chunks (never whole); parsing, conversion and SQL text live in the std-only `importfmt`.

use crate::db;
use crate::error::{AppError, AppResult};
use crate::importfmt::{
    self, Bound, Conflict, CsvParser, DateFormat, Decoder, Dialect, Encoding, Inferrer, InsertSpec,
    JsonArraySplitter, SourceKind, TargetClass,
};
use crate::model::Driver;
use crate::session::Session;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Event carrying `ImportProgress`.
pub const PROGRESS_EVENT: &str = "import-progress";
const PREVIEW_BYTES: usize = 1024 * 1024;
const PREVIEW_ROWS: usize = 50;
const SAMPLE_ROWS: usize = 1000;
const CHUNK: usize = 256 * 1024;
const EMIT_EVERY: Duration = Duration::from_millis(150);
/// Failures kept with their details (more are only counted).
const MAX_FAILURES: u64 = 1000;

#[derive(Deserialize, Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportFormat {
    /// "csv" | "json" | "ndjson"; null = detect.
    pub kind: Option<String>,
    /// One character ("\t" = tab); null = detect.
    pub delimiter: Option<String>,
    /// One character; "" = no quoting; null = `"`.
    pub quote: Option<String>,
    /// First row is the header; null = detect.
    pub header: Option<bool>,
    /// "utf8" | "utf16le" | "utf16be" | "latin1"; null / "auto" = detect.
    pub encoding: Option<String>,
    /// Values equal to this are NULL (empty fields always are).
    pub null_text: String,
    /// e.g. "dd/MM/yyyy"; "" = ISO only.
    pub date_format: String,
    /// JSON: nested objects become `a.b` columns (default true).
    pub flatten: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferredColumn {
    /// "int" | "bigint" | "decimal" | "bool" | "date" | "timestamp" | "json" | "text"
    pub kind: String,
    pub max_len: usize,
    pub precision: usize,
    pub scale: usize,
    pub nullable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFix {
    pub label: String,
    /// "dateFormat" | "nullText"
    pub kind: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnCheck {
    /// The first value that doesn't fit, its line and why.
    pub value: String,
    pub line: u64,
    pub message: String,
    /// How many sample values don't fit.
    pub bad: u64,
    pub fix: Option<CheckFix>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// The effective format (every field filled).
    pub format: ImportFormat,
    pub columns: Vec<String>,
    /// First rows (NULL rules applied).
    pub rows: Vec<Vec<Option<String>>>,
    /// Their 1-based lines.
    pub lines: Vec<u64>,
    pub sample_rows: u64,
    /// Exact row count when the whole file fit in the sample.
    pub total_rows: Option<u64>,
    pub estimated_rows: u64,
    pub file_size: u64,
    pub warnings: Vec<String>,
    pub encoding_note: Option<String>,
    pub inferred: Vec<InferredColumn>,
    /// Per column (when target types were sent): the first value that doesn't fit.
    pub checks: Vec<Option<ColumnCheck>>,
}

/// The resolved format.
#[derive(Clone)]
struct Eff {
    kind: SourceKind,
    delim: char,
    quote: Option<char>,
    header: bool,
    enc: Encoding,
    null_text: String,
    date_fmt: Option<DateFormat>,
    date_spec: String,
    flatten: bool,
}

impl Eff {
    fn to_format(&self) -> ImportFormat {
        ImportFormat {
            kind: Some(self.kind.id().to_string()),
            delimiter: Some(self.delim.to_string()),
            quote: Some(self.quote.map(|c| c.to_string()).unwrap_or_default()),
            header: Some(self.header),
            encoding: Some(self.enc.id().to_string()),
            null_text: self.null_text.clone(),
            date_format: self.date_spec.clone(),
            flatten: Some(self.flatten),
        }
    }
}

fn delim_of(s: &str) -> Option<char> {
    match s {
        "\\t" | "tab" | "Tab" | "TAB" => Some('\t'),
        _ => s.chars().next(),
    }
}

// ---------------------------------------------------------------------------
// Record sources
// ---------------------------------------------------------------------------

/// A row of optional values.
type Row = Vec<Option<String>>;
/// A JSON record: (column, value) pairs.
type Pairs = Vec<(String, Option<String>)>;

enum Rec {
    /// CSV fields (NULL rules applied).
    Fields(u64, Vec<Option<String>>),
    /// A JSON record as (column, value) pairs.
    Obj(u64, Vec<(String, Option<String>)>),
    /// A JSON element / line that didn't parse.
    Bad(u64, String),
}

enum Parser {
    Csv(CsvParser),
    Ndjson { buf: String, line: u64 },
    Json(JsonArraySplitter),
}

struct RowSource {
    parser: Parser,
    dec: Decoder,
    null_text: String,
    flatten: bool,
    raw: Vec<importfmt::CsvRecord>,
    elems: Vec<(u64, String)>,
}

fn json_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn flatten_into(prefix: &str, v: &Value, flatten: bool, out: &mut Vec<(String, Option<String>)>) {
    match v {
        Value::Object(m) if flatten || prefix.is_empty() => {
            for (k, x) in m {
                let key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", prefix, k)
                };
                if let Value::Object(_) = x {
                    if flatten {
                        flatten_into(&key, x, flatten, out);
                        continue;
                    }
                }
                out.push((key, json_text(x)));
            }
        }
        _ => out.push((
            if prefix.is_empty() {
                "value".into()
            } else {
                prefix.to_string()
            },
            json_text(v),
        )),
    }
}

impl RowSource {
    fn new(e: &Eff) -> RowSource {
        let parser = match e.kind {
            SourceKind::Csv => Parser::Csv(CsvParser::new(e.delim, e.quote)),
            SourceKind::Ndjson => Parser::Ndjson {
                buf: String::new(),
                line: 1,
            },
            SourceKind::JsonArray => Parser::Json(JsonArraySplitter::default()),
        };
        RowSource {
            parser,
            dec: Decoder::new(e.enc),
            null_text: e.null_text.clone(),
            flatten: e.flatten,
            raw: Vec::new(),
            elems: Vec::new(),
        }
    }

    fn json_rec(&self, line: u64, text: &str) -> Rec {
        match serde_json::from_str::<Value>(text) {
            Ok(v) => {
                let mut pairs: Vec<(String, Option<String>)> = Vec::new();
                match &v {
                    Value::Array(items) => {
                        for (i, x) in items.iter().enumerate() {
                            pairs.push((format!("column{}", i + 1), json_text(x)));
                        }
                    }
                    _ => flatten_into("", &v, self.flatten, &mut pairs),
                }
                let pairs = pairs
                    .into_iter()
                    .map(|(k, v)| {
                        let v = v.filter(|s| self.null_text.is_empty() || *s != self.null_text);
                        (k, v)
                    })
                    .collect();
                Rec::Obj(line, pairs)
            }
            Err(e) => Rec::Bad(line, format!("not valid JSON: {}", e)),
        }
    }

    /// Feeds bytes; `last` = end of file (the last record is completed).
    fn feed(&mut self, bytes: &[u8], last: bool, out: &mut Vec<Rec>) {
        let text = self.dec.feed(bytes, last);
        match &mut self.parser {
            Parser::Csv(p) => {
                p.feed(&text, &mut self.raw);
                if last {
                    p.finish(&mut self.raw);
                }
                let nt = self.null_text.clone();
                for r in self.raw.drain(..) {
                    let f = r
                        .fields
                        .into_iter()
                        .map(|v| {
                            if importfmt::null_rule(&v, &nt) {
                                None
                            } else {
                                Some(v)
                            }
                        })
                        .collect();
                    out.push(Rec::Fields(r.line, f));
                }
            }
            Parser::Ndjson { buf, line } => {
                buf.push_str(&text);
                let mut lines: Vec<(u64, String)> = Vec::new();
                while let Some(i) = buf.find('\n') {
                    let l: String = buf.drain(..=i).collect();
                    lines.push((*line, l));
                    *line += 1;
                }
                if last && !buf.trim().is_empty() {
                    lines.push((*line, std::mem::take(buf)));
                }
                for (n, l) in lines {
                    let t = l.trim().trim_start_matches('\u{FEFF}');
                    if t.is_empty() {
                        continue;
                    }
                    let rec = self.json_rec(n, t);
                    out.push(rec);
                }
            }
            Parser::Json(s) => {
                s.feed(&text, &mut self.elems);
                if s.not_array {
                    out.push(Rec::Bad(
                        1,
                        "the file doesn't start with a JSON array ( [ … ] ) — try NDJSON".into(),
                    ));
                    // Stop producing anything else.
                    self.elems.clear();
                    return;
                }
                if last {
                    s.finish(&mut self.elems);
                }
                let elems: Vec<(u64, String)> = self.elems.drain(..).collect();
                for (n, t) in elems {
                    let rec = self.json_rec(n, &t);
                    out.push(rec);
                }
            }
        }
    }

    fn unterminated(&self) -> Option<u64> {
        match &self.parser {
            Parser::Csv(p) => p.unterminated,
            _ => None,
        }
    }
}

fn resolve(path: &str, head: &[u8], f: &ImportFormat) -> (Eff, Option<String>) {
    let (enc, note) = match f.encoding.as_deref().and_then(Encoding::parse) {
        Some(e) => (e, None),
        None => importfmt::detect_encoding(head),
    };
    let mut dec = Decoder::new(enc);
    let text = dec.feed(head, true);
    let kind = match f.kind.as_deref().and_then(SourceKind::parse) {
        Some(k) => k,
        None => importfmt::sniff_kind(path, &text),
    };
    let quote = match f.quote.as_deref() {
        Some("") => None,
        Some(q) => q.chars().next(),
        None => Some('"'),
    };
    let delim = match f.delimiter.as_deref().and_then(delim_of) {
        Some(d) => d,
        None => importfmt::detect_delimiter(path, &text, quote),
    };
    let header = match f.header {
        Some(h) => h,
        None => {
            if kind == SourceKind::Csv {
                let recs = importfmt::parse_csv(&text, delim, quote);
                let rows: Vec<Vec<String>> = recs.into_iter().take(10).map(|r| r.fields).collect();
                importfmt::detect_header(&rows)
            } else {
                true
            }
        }
    };
    let date_spec = f.date_format.trim().to_string();
    let eff = Eff {
        kind,
        delim,
        quote,
        header,
        enc,
        null_text: f.null_text.clone(),
        date_fmt: DateFormat::parse(&date_spec),
        date_spec,
        flatten: f.flatten.unwrap_or(true),
    };
    (eff, note)
}

fn read_head(path: &str) -> AppResult<(Vec<u8>, u64)> {
    let mut file =
        File::open(path).map_err(|e| AppError::new(format!("Could not open {}: {}", path, e)))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = vec![0u8; PREVIEW_BYTES.min(size as usize)];
    let mut got = 0usize;
    while got < head.len() {
        match file.read(&mut head[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) => return Err(AppError::new(format!("Could not read {}: {}", path, e))),
        }
    }
    head.truncate(got);
    Ok((head, size))
}

fn dialect_of(d: Driver) -> AppResult<Dialect> {
    match d {
        Driver::Postgres => Ok(Dialect::Postgres),
        Driver::Mysql => Ok(Dialect::Mysql),
        Driver::Sqlite => Ok(Dialect::Sqlite),
        Driver::Mssql => Ok(Dialect::Mssql),
        Driver::Redis | Driver::Kafka => Err(AppError::new(
            "Import data works with PostgreSQL, MySQL, SQLite and SQL Server data sources.",
        )),
    }
}

/// Header names (CSV) / union of keys (JSON) and the data rows of a parsed sample.
fn table_of(recs: Vec<Rec>, e: &Eff, warnings: &mut Vec<String>) -> (Vec<String>, Vec<(u64, Row)>) {
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<(u64, Vec<Option<String>>)> = Vec::new();
    let mut bad = 0u64;
    let mut first_bad: Option<(u64, String)> = None;
    if e.kind == SourceKind::Csv {
        let mut it = recs.into_iter();
        let mut width = 0usize;
        if e.header {
            for r in it.by_ref() {
                if let Rec::Fields(_, f) = r {
                    let names: Vec<String> = f.into_iter().map(|v| v.unwrap_or_default()).collect();
                    columns = importfmt::unique_names(&names);
                    width = columns.len();
                    break;
                }
            }
        }
        let mut ragged = 0u64;
        let mut ragged_at = 0u64;
        for r in it {
            if let Rec::Fields(line, f) = r {
                if !e.header && f.len() > width {
                    width = f.len();
                }
                if e.header && f.len() != width {
                    ragged += 1;
                    if ragged_at == 0 {
                        ragged_at = line;
                    }
                }
                rows.push((line, f));
            }
        }
        if !e.header {
            columns = (1..=width).map(|i| format!("column{}", i)).collect();
        }
        for (_, r) in rows.iter_mut() {
            r.resize(columns.len(), None);
        }
        if ragged > 0 {
            warnings.push(format!(
                "{} row{} {} a different number of fields than the header (first at line {}).",
                ragged,
                if ragged == 1 { "" } else { "s" },
                if ragged == 1 { "has" } else { "have" },
                ragged_at
            ));
        }
    } else {
        let mut objs: Vec<(u64, Pairs)> = Vec::new();
        for r in recs {
            match r {
                Rec::Obj(line, pairs) => {
                    for (k, _) in &pairs {
                        if !columns.contains(k) {
                            columns.push(k.clone());
                        }
                    }
                    objs.push((line, pairs));
                }
                Rec::Bad(line, m) => {
                    bad += 1;
                    if first_bad.is_none() {
                        first_bad = Some((line, m));
                    }
                }
                Rec::Fields(..) => {}
            }
        }
        for (line, pairs) in objs {
            let map: HashMap<String, Option<String>> = pairs.into_iter().collect();
            rows.push((
                line,
                columns
                    .iter()
                    .map(|c| map.get(c).cloned().flatten())
                    .collect(),
            ));
        }
    }
    if let Some((line, m)) = first_bad {
        warnings.push(format!(
            "{} record{} {} {} (first at line {}: {}).",
            bad,
            if bad == 1 { "" } else { "s" },
            if bad == 1 { "is" } else { "are" },
            "skipped",
            line,
            m
        ));
    }
    (columns, rows)
}

/// Format detection + the first rows of a file + inferred column types + (optionally) checks against the
/// target column types (see CONTRACT.md v0.16).
#[tauri::command]
pub async fn import_preview(
    path: String,
    format: Option<ImportFormat>,
    check_types: Option<Vec<Option<String>>>,
) -> AppResult<ImportPreview> {
    let f = format.unwrap_or_default();
    tokio::task::spawn_blocking(move || preview_blocking(&path, &f, check_types.as_deref()))
        .await
        .map_err(|e| AppError::new(format!("Internal error: {}", e)))?
}

fn preview_blocking(
    path: &str,
    f: &ImportFormat,
    check_types: Option<&[Option<String>]>,
) -> AppResult<ImportPreview> {
    let (head, size) = read_head(path)?;
    if head.is_empty() {
        return Err(AppError::new("The file is empty."));
    }
    let complete = head.len() as u64 >= size;
    let (e, enc_note) = resolve(path, &head, f);
    let mut src = RowSource::new(&e);
    let mut recs: Vec<Rec> = Vec::new();
    src.feed(&head, complete, &mut recs);
    let mut warnings: Vec<String> = Vec::new();
    if src.dec.replaced > 0 {
        warnings.push(format!(
            "{} character{} couldn't be read as {} — try another encoding.",
            src.dec.replaced,
            if src.dec.replaced == 1 { "" } else { "s" },
            enc_label(e.enc)
        ));
    }
    if let Some(line) = src.unterminated() {
        warnings.push(format!(
            "A quoted field starting at line {} is never closed — check the quote character.",
            line
        ));
    }
    let total_records = recs.len() as u64;
    let mut sample_text_mojibake = false;
    if e.enc == Encoding::Latin1 {
        let mut d = Decoder::new(Encoding::Latin1);
        sample_text_mojibake =
            importfmt::looks_like_mojibake(&d.feed(&head[..head.len().min(65536)], true));
    }
    let (columns, rows) = table_of(recs, &e, &mut warnings);
    if columns.is_empty() {
        return Err(AppError::new("No columns were found in the file."));
    }
    if e.kind == SourceKind::Csv && columns.len() == 1 {
        warnings.insert(
            0,
            "Everything lands in one column — the delimiter is probably wrong.".into(),
        );
    }
    if sample_text_mojibake {
        warnings.insert(
            0,
            "Accented characters look garbled — the file is most likely UTF-8.".into(),
        );
    }
    if e.kind == SourceKind::Csv && !e.header {
        warnings.push(format!(
            "The first row is data: columns are named column1…column{}.",
            columns.len()
        ));
    }
    let sample: Vec<&(u64, Vec<Option<String>>)> = rows.iter().take(SAMPLE_ROWS).collect();
    let mut inf = Inferrer::new(columns.len());
    for (_, r) in &sample {
        inf.add(r, e.date_fmt.as_ref());
    }
    let inferred: Vec<InferredColumn> = inf
        .result()
        .into_iter()
        .map(|c| InferredColumn {
            kind: c.kind.id().to_string(),
            max_len: c.max_len,
            precision: c.precision,
            scale: c.scale,
            nullable: c.nulls > 0 || c.values == 0,
        })
        .collect();
    let mut checks: Vec<Option<ColumnCheck>> = Vec::new();
    if let Some(types) = check_types {
        for (i, t) in types.iter().enumerate().take(columns.len()) {
            checks.push(match t {
                Some(t) if !t.trim().is_empty() => check_column(&sample, i, t, &e),
                _ => None,
            });
        }
    }
    let data_records = rows.len() as u64;
    let header_n = if e.kind == SourceKind::Csv && e.header {
        1
    } else {
        0
    };
    let estimated = if complete {
        data_records
    } else {
        let per = (head.len() as f64) / (total_records.max(1) as f64);
        (((size as f64) / per.max(1.0)) as u64).saturating_sub(header_n)
    };
    Ok(ImportPreview {
        format: e.to_format(),
        columns,
        rows: rows
            .iter()
            .take(PREVIEW_ROWS)
            .map(|(_, r)| r.clone())
            .collect(),
        lines: rows.iter().take(PREVIEW_ROWS).map(|(l, _)| *l).collect(),
        sample_rows: sample.len() as u64,
        total_rows: if complete { Some(data_records) } else { None },
        estimated_rows: estimated,
        file_size: size,
        warnings,
        encoding_note: enc_note,
        inferred,
        checks,
    })
}

fn enc_label(e: Encoding) -> &'static str {
    match e {
        Encoding::Utf8 => "UTF-8",
        Encoding::Utf16Le | Encoding::Utf16Be => "UTF-16",
        Encoding::Latin1 => "Latin-1",
    }
}

fn check_column(
    sample: &[&(u64, Vec<Option<String>>)],
    i: usize,
    type_name: &str,
    e: &Eff,
) -> Option<ColumnCheck> {
    // The dialect only changes how good values are bound, not whether they convert.
    let mut first: Option<(String, u64, String)> = None;
    let mut bad = 0u64;
    let mut bad_values: Vec<&str> = Vec::new();
    for (line, r) in sample {
        let v = r.get(i).and_then(|x| x.as_deref());
        if let Err(m) = importfmt::convert(Dialect::Postgres, type_name, v, e.date_fmt.as_ref()) {
            bad += 1;
            if let Some(s) = v {
                if bad_values.len() < 50 {
                    bad_values.push(s);
                }
            }
            if first.is_none() {
                first = Some((v.unwrap_or("").to_string(), *line, m));
            }
        }
    }
    let (value, line, message) = first?;
    let class = importfmt::classify_type(type_name);
    let fix = match class {
        TargetClass::Date | TargetClass::Timestamp | TargetClass::TimestampTz => {
            let values: Vec<&str> = sample
                .iter()
                .filter_map(|(_, r)| r.get(i).and_then(|x| x.as_deref()))
                .take(200)
                .collect();
            importfmt::suggest_date_format(&values).map(|f| CheckFix {
                label: format!("Use {}", f),
                kind: "dateFormat".into(),
                value: f.to_string(),
            })
        }
        TargetClass::Int | TargetClass::Decimal | TargetClass::Float | TargetClass::Bool => {
            let all_same = !bad_values.is_empty() && bad_values.iter().all(|v| *v == bad_values[0]);
            if all_same && bad_values[0].chars().count() <= 20 {
                Some(CheckFix {
                    label: format!("Treat “{}” as NULL", bad_values[0]),
                    kind: "nullText".into(),
                    value: bad_values[0].to_string(),
                })
            } else {
                None
            }
        }
        _ => None,
    };
    Some(ColumnCheck {
        value,
        line,
        message,
        bad,
        fix,
    })
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMap {
    /// Index into `sourceColumns`.
    pub source: usize,
    /// Target column name.
    pub column: String,
    /// Target column type (as introspected / created).
    #[serde(default)]
    pub type_name: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportTarget {
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    /// CREATE TABLE (+ comments …) to run first, for "Create a new table".
    #[serde(default)]
    pub create_sql: Vec<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    #[serde(default)]
    pub truncate: bool,
    /// "fail" | "skip" | "update"
    #[serde(default)]
    pub on_conflict: String,
    #[serde(default)]
    pub batch_size: u32,
    /// "batch" (commit each batch) | "single" (one transaction, all or nothing)
    #[serde(default)]
    pub transaction: String,
    /// Stop after this many failed rows (0 = never).
    #[serde(default)]
    pub stop_after: u32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub format: ImportFormat,
    pub source_columns: Vec<String>,
    pub target: ImportTarget,
    pub mapping: Vec<ColumnMap>,
    /// Key columns (target names) for skip / update on conflict.
    #[serde(default)]
    pub key_columns: Vec<String>,
    pub options: ImportOptions,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    /// Sequence number (failures arrive in several events).
    pub n: u64,
    pub line: u64,
    pub column: Option<String>,
    pub value: Option<String>,
    pub message: String,
    /// The row's mapped source values (for "Save failed rows").
    pub row: Vec<Option<String>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub run_id: String,
    pub rows_read: u64,
    /// Rows written (in update mode: inserted or updated).
    pub inserted: u64,
    /// Rows that already existed (skip mode).
    pub skipped: u64,
    pub failed: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub elapsed_ms: u64,
    /// Failures since the previous event.
    pub failures: Vec<ImportFailure>,
    pub finished: bool,
    pub cancelled: bool,
    /// Everything written was rolled back (one transaction with failures, cancel, server error).
    pub rolled_back: bool,
    pub stopped: Option<String>,
    pub note: Option<String>,
}

struct RunCtl {
    cancel: Arc<AtomicBool>,
    session: Arc<Session>,
}

/// Running imports by run id (for `import_cancel`).
#[derive(Default)]
pub struct ImportRuns {
    map: Mutex<HashMap<String, RunCtl>>,
}

impl ImportRuns {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunCtl>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct SrcRow {
    line: u64,
    values: Vec<Option<String>>,
}

enum Msg {
    Rows(Vec<SrcRow>, u64),
    /// A record that couldn't be read (bad JSON, too many fields).
    Bad(u64, String),
    Done(u64),
    Fail(String),
}

fn produce(
    path: String,
    e: Eff,
    columns: Vec<String>,
    batch: usize,
    tx: tokio::sync::mpsc::Sender<Msg>,
    halt: Arc<AtomicBool>,
) {
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(err) => {
            let _ = tx.blocking_send(Msg::Fail(format!("Could not open {}: {}", path, err)));
            return;
        }
    };
    let mut src = RowSource::new(&e);
    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    let mut header_pending = e.kind == SourceKind::Csv && e.header;
    let width = columns.len();
    let index: HashMap<&str, usize> = columns
        .iter()
        .enumerate()
        .map(|(i, c)| (c.as_str(), i))
        .collect();
    let mut rows: Vec<SrcRow> = Vec::with_capacity(batch);
    loop {
        if halt.load(Ordering::SeqCst) {
            return;
        }
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(err) => {
                let _ = tx.blocking_send(Msg::Fail(format!("Could not read {}: {}", path, err)));
                return;
            }
        };
        done += n as u64;
        let last = n == 0;
        let mut recs: Vec<Rec> = Vec::new();
        src.feed(&buf[..n], last, &mut recs);
        for r in recs {
            match r {
                Rec::Fields(line, mut f) => {
                    if header_pending {
                        header_pending = false;
                        continue;
                    }
                    if f.len() > width {
                        let extra = f[width..].iter().any(|v| v.is_some());
                        if extra {
                            let msg = format!("{} fields, expected {}", f.len(), width);
                            if tx.blocking_send(Msg::Bad(line, msg)).is_err() {
                                return;
                            }
                            continue;
                        }
                    }
                    f.resize(width, None);
                    rows.push(SrcRow { line, values: f });
                }
                Rec::Obj(line, pairs) => {
                    let mut v: Vec<Option<String>> = vec![None; width];
                    for (k, x) in pairs {
                        if let Some(i) = index.get(k.as_str()) {
                            v[*i] = x;
                        }
                    }
                    rows.push(SrcRow { line, values: v });
                }
                Rec::Bad(line, m) => {
                    if tx.blocking_send(Msg::Bad(line, m)).is_err() {
                        return;
                    }
                    if let Parser::Json(s) = &src.parser {
                        if s.not_array {
                            let _ =
                                tx.blocking_send(Msg::Fail("The file isn't a JSON array.".into()));
                            return;
                        }
                    }
                }
            }
            if rows.len() >= batch {
                let full = std::mem::replace(&mut rows, Vec::with_capacity(batch));
                if tx.blocking_send(Msg::Rows(full, done)).is_err() {
                    return;
                }
            }
        }
        if last {
            break;
        }
    }
    if !rows.is_empty() && tx.blocking_send(Msg::Rows(rows, done)).is_err() {
        return;
    }
    let _ = tx.blocking_send(Msg::Done(done));
}

fn to_value(b: Bound) -> Value {
    match b {
        Bound::Null => Value::Null,
        Bound::Int(i) => Value::from(i),
        Bound::Float(f) => db::float_value(f),
        Bound::Bool(v) => Value::Bool(v),
        Bound::Text(s) => Value::String(s),
    }
}

fn emit(app: &AppHandle, p: &mut ImportProgress, started: Instant) {
    p.elapsed_ms = started.elapsed().as_millis() as u64;
    let _ = app.emit(PROGRESS_EVENT, p.clone());
    p.failures.clear();
}

/// Streams a file into a table (events `import-progress`); resolves with the final progress.
#[tauri::command]
pub async fn import_run(
    app: AppHandle,
    state: State<'_, AppState>,
    runs: State<'_, ImportRuns>,
    session_id: String,
    path: String,
    request: ImportRequest,
    run_id: String,
) -> AppResult<ImportProgress> {
    let session = state.sessions.get(&session_id)?;
    let dialect = dialect_of(session.config.driver)?;
    if session.config.read_only {
        return Err(AppError::new(
            "This data source is read-only; importing is not allowed.",
        ));
    }
    if request.mapping.is_empty() {
        return Err(AppError::new("Map at least one column to import."));
    }
    if request.target.table.trim().is_empty() {
        return Err(AppError::new("Choose a target table."));
    }
    for m in &request.mapping {
        if m.source >= request.source_columns.len() {
            return Err(AppError::new(
                "The column mapping doesn't match the file's columns.",
            ));
        }
    }
    let bytes_total = std::fs::metadata(&path)
        .map_err(|e| AppError::new(format!("Could not read {}: {}", path, e)))?
        .len();
    let (head, _) = read_head(&path)?;
    let (eff, _) = resolve(&path, &head, &request.format);
    let cancel = Arc::new(AtomicBool::new(false));
    runs.lock().insert(
        run_id.clone(),
        RunCtl {
            cancel: cancel.clone(),
            session: session.clone(),
        },
    );
    let res = run_import(
        &app,
        &session,
        dialect,
        path,
        eff,
        request,
        bytes_total,
        &run_id,
        &cancel,
    )
    .await;
    runs.lock().remove(&run_id);
    res
}

/// Stops a running import (the running statement is cancelled; an open transaction is rolled back).
#[tauri::command]
pub async fn import_cancel(runs: State<'_, ImportRuns>, run_id: String) -> AppResult<()> {
    let found = runs
        .lock()
        .get(&run_id)
        .map(|c| (c.cancel.clone(), c.session.clone()));
    if let Some((flag, session)) = found {
        flag.store(true, Ordering::SeqCst);
        let _ = session.cancel().await;
    }
    Ok(())
}

/// One converted row ready to insert.
struct Ready {
    line: u64,
    params: Vec<Value>,
    raw: Vec<Option<String>>,
}

struct Run<'a> {
    app: &'a AppHandle,
    session: &'a Arc<Session>,
    d: Dialect,
    single: bool,
    conflict: Conflict,
    p: ImportProgress,
    started: Instant,
    last_emit: Instant,
    fail_seq: u64,
    stop_after: u64,
}

impl Run<'_> {
    fn fail(
        &mut self,
        line: u64,
        column: Option<String>,
        value: Option<String>,
        message: String,
        row: Vec<Option<String>>,
    ) {
        self.p.failed += 1;
        self.fail_seq += 1;
        if self.fail_seq <= MAX_FAILURES {
            self.p.failures.push(ImportFailure {
                n: self.fail_seq,
                line,
                column,
                value,
                message,
                row,
            });
        }
    }

    fn tick(&mut self) {
        if self.last_emit.elapsed() >= EMIT_EVERY || !self.p.failures.is_empty() {
            emit(self.app, &mut self.p, self.started);
            self.last_emit = Instant::now();
        }
    }

    fn over_limit(&self) -> bool {
        self.stop_after > 0 && self.p.failed >= self.stop_after
    }

    async fn exec(&self, sql: &str) -> AppResult<()> {
        self.session.execute(sql.to_string(), 1).await.map(|_| ())
    }

    fn count(&mut self, rows: u64, affected: u64) {
        if self.conflict == Conflict::Skip {
            let ins = affected.min(rows);
            self.p.inserted += ins;
            self.p.skipped += rows - ins;
        } else {
            self.p.inserted += rows;
        }
    }

    /// Inserts rows one by one (after a batch failed) to find the failing ones. In one transaction each row
    /// gets a savepoint. Err = the transaction can't continue.
    async fn one_by_one(&mut self, spec: &InsertSpec<'_>, rows: &[Ready]) -> AppResult<()> {
        let sql = importfmt::insert_sql(spec, 1);
        for r in rows {
            if self.single {
                self.exec(importfmt::savepoint_sql(self.d)).await?;
            }
            match self
                .session
                .exec_params(sql.clone(), r.params.clone())
                .await
            {
                Ok(n) => {
                    self.count(1, n);
                    if self.single {
                        if let Some(rel) = importfmt::release_sql(self.d) {
                            self.exec(rel).await?;
                        }
                    }
                }
                Err(e) => {
                    if self.single {
                        if let Err(e2) = self.exec(importfmt::rollback_to_sql(self.d)).await {
                            return Err(AppError::new(format!(
                                "{} (and the server ended the transaction: {})",
                                e.message, e2.message
                            )));
                        }
                        if let Some(rel) = importfmt::release_sql(self.d) {
                            self.exec(rel).await?;
                        }
                    }
                    self.fail(r.line, None, None, e.message, r.raw.clone());
                    if self.over_limit() {
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    /// Writes one batch: multi-row statements; on an error, row by row.
    async fn write(
        &mut self,
        spec: &InsertSpec<'_>,
        rows: Vec<Ready>,
        per_stmt: usize,
    ) -> AppResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        if self.single {
            for chunk in rows.chunks(per_stmt) {
                self.exec(importfmt::savepoint_sql(self.d)).await?;
                let sql = importfmt::insert_sql(spec, chunk.len());
                let params: Vec<Value> = chunk
                    .iter()
                    .flat_map(|r| r.params.iter().cloned())
                    .collect();
                match self.session.exec_params(sql, params).await {
                    Ok(n) => {
                        self.count(chunk.len() as u64, n);
                        if let Some(rel) = importfmt::release_sql(self.d) {
                            self.exec(rel).await?;
                        }
                    }
                    Err(_) => {
                        self.exec(importfmt::rollback_to_sql(self.d)).await?;
                        // ROLLBACK TO keeps the savepoint: release it so they don't pile up.
                        if let Some(rel) = importfmt::release_sql(self.d) {
                            self.exec(rel).await?;
                        }
                        self.one_by_one(spec, chunk).await?;
                        if self.over_limit() {
                            return Ok(());
                        }
                    }
                }
            }
            return Ok(());
        }
        // Commit each batch: one transaction per batch; a failing batch is rolled back and retried row by row
        // (each row committed on its own).
        let (inserted, skipped) = (self.p.inserted, self.p.skipped);
        self.exec(db::begin_sql(driver_of(self.d))).await?;
        let mut failed = false;
        for chunk in rows.chunks(per_stmt) {
            let sql = importfmt::insert_sql(spec, chunk.len());
            let params: Vec<Value> = chunk
                .iter()
                .flat_map(|r| r.params.iter().cloned())
                .collect();
            match self.session.exec_params(sql, params).await {
                Ok(n) => self.count(chunk.len() as u64, n),
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
        if !failed {
            match self.exec(db::commit_sql(driver_of(self.d))).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    self.p.inserted = inserted;
                    self.p.skipped = skipped;
                    return Err(AppError::new(format!(
                        "Couldn't commit a batch: {}",
                        e.message
                    )));
                }
            }
        }
        let _ = self.exec(db::rollback_sql(driver_of(self.d))).await;
        self.p.inserted = inserted;
        self.p.skipped = skipped;
        self.one_by_one(spec, &rows).await
    }
}

fn driver_of(d: Dialect) -> Driver {
    match d {
        Dialect::Postgres => Driver::Postgres,
        Dialect::Mysql => Driver::Mysql,
        Dialect::Sqlite => Driver::Sqlite,
        Dialect::Mssql => Driver::Mssql,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_import(
    app: &AppHandle,
    session: &Arc<Session>,
    d: Dialect,
    path: String,
    eff: Eff,
    req: ImportRequest,
    bytes_total: u64,
    run_id: &str,
    cancel: &Arc<AtomicBool>,
) -> AppResult<ImportProgress> {
    let started = Instant::now();
    let driver = driver_of(d);
    let single = req.options.transaction == "single";
    let conflict = importfmt::Conflict::parse(&req.options.on_conflict);
    let batch = (req.options.batch_size.clamp(1, 100_000)) as usize;
    let table = importfmt::qualified(d, req.target.schema.as_deref(), &req.target.table);
    let cols: Vec<String> = req.mapping.iter().map(|m| m.column.clone()).collect();
    let types: Vec<String> = req.mapping.iter().map(|m| m.type_name.clone()).collect();
    let keys: Vec<String> = req
        .key_columns
        .iter()
        .filter(|k| cols.contains(k))
        .cloned()
        .collect();
    if conflict == Conflict::Update && keys.is_empty() {
        return Err(AppError::new(
            "“Update” needs the table's key columns among the mapped columns — map the key, or choose Skip / Fail.",
        ));
    }
    if conflict != Conflict::Fail && keys.is_empty() && d == Dialect::Mssql {
        return Err(AppError::new(
            "On SQL Server, “Skip” needs the table's key columns among the mapped columns — map the key, or choose Fail.",
        ));
    }
    let spec = InsertSpec {
        dialect: d,
        table: &table,
        cols: &cols,
        types: &types,
        keys: &keys,
        conflict,
    };
    let per_stmt = importfmt::rows_per_statement(d, cols.len(), batch);
    let mut run = Run {
        app,
        session,
        d,
        single,
        conflict,
        p: ImportProgress {
            run_id: run_id.to_string(),
            rows_read: 0,
            inserted: 0,
            skipped: 0,
            failed: 0,
            bytes_done: 0,
            bytes_total,
            elapsed_ms: 0,
            failures: Vec::new(),
            finished: false,
            cancelled: false,
            rolled_back: false,
            stopped: None,
            note: if conflict == Conflict::Update {
                Some("Rows that already existed were updated; “inserted” counts inserted and updated rows.".into())
            } else {
                None
            },
        },
        started,
        last_emit: Instant::now(),
        fail_seq: 0,
        stop_after: u64::from(req.options.stop_after),
    };
    emit(app, &mut run.p, started);

    // New table first (DDL; MySQL commits it on its own anyway).
    for sql in &req.target.create_sql {
        if sql.trim().is_empty() {
            continue;
        }
        if let Err(e) = run.exec(sql).await {
            return Err(AppError::new(format!(
                "Couldn't create the table: {}",
                e.message
            )));
        }
    }
    let truncate = importfmt::truncate_sql(d, &table);
    let mut in_tx = false;
    if req.options.truncate && (!single || d == Dialect::Mysql) {
        run.exec(&truncate)
            .await
            .map_err(|e| AppError::new(format!("Couldn't empty the table: {}", e.message)))?;
        if single && d == Dialect::Mysql {
            run.p.note = Some("MySQL commits TRUNCATE immediately: the table was emptied before the import transaction.".into());
        }
    }
    if single {
        run.exec(db::begin_sql(driver)).await?;
        in_tx = true;
        if req.options.truncate && d != Dialect::Mysql {
            if let Err(e) = run.exec(&truncate).await {
                let _ = run.exec(db::rollback_sql(driver)).await;
                return Err(AppError::new(format!(
                    "Couldn't empty the table: {}",
                    e.message
                )));
            }
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Msg>(4);
    let halt = Arc::new(AtomicBool::new(false));
    let producer_halt = halt.clone();
    let src_cols = req.source_columns.clone();
    let eff2 = eff.clone();
    let producer = tokio::task::spawn_blocking(move || {
        produce(path, eff2, src_cols, batch, tx, producer_halt)
    });
    let mut completed = false;
    let mut fatal: Option<String> = None;
    while let Some(msg) = rx.recv().await {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let rows = match msg {
            Msg::Done(bytes) => {
                run.p.bytes_done = bytes;
                completed = true;
                break;
            }
            Msg::Fail(m) => {
                fatal = Some(m);
                break;
            }
            Msg::Bad(line, m) => {
                run.p.rows_read += 1;
                run.fail(line, None, None, m, Vec::new());
                if run.over_limit() {
                    break;
                }
                run.tick();
                continue;
            }
            Msg::Rows(rows, bytes) => {
                run.p.bytes_done = bytes;
                rows
            }
        };
        run.p.rows_read += rows.len() as u64;
        let mut ready: Vec<Ready> = Vec::with_capacity(rows.len());
        for r in rows {
            let raw: Vec<Option<String>> = req
                .mapping
                .iter()
                .map(|m| r.values.get(m.source).cloned().flatten())
                .collect();
            let mut params: Vec<Value> = Vec::with_capacity(req.mapping.len());
            let mut bad: Option<(String, Option<String>, String)> = None;
            for m in &req.mapping {
                let v = r.values.get(m.source).and_then(|x| x.as_deref());
                match importfmt::convert(d, &m.type_name, v, eff.date_fmt.as_ref()) {
                    Ok(b) => params.push(to_value(b)),
                    Err(msg) => {
                        bad = Some((m.column.clone(), v.map(|s| s.to_string()), msg));
                        break;
                    }
                }
            }
            match bad {
                Some((col, val, msg)) => run.fail(r.line, Some(col), val, msg, raw),
                None => ready.push(Ready {
                    line: r.line,
                    params,
                    raw,
                }),
            }
        }
        if run.over_limit() {
            break;
        }
        if let Err(e) = run.write(&spec, ready, per_stmt).await {
            fatal = Some(e.message);
            break;
        }
        if run.over_limit() || cancel.load(Ordering::SeqCst) {
            break;
        }
        run.tick();
    }
    halt.store(true, Ordering::SeqCst);
    drop(rx);
    let _ = producer.await;

    if cancel.load(Ordering::SeqCst) {
        run.p.cancelled = true;
    }
    if !completed && fatal.is_none() && !run.p.cancelled && run.over_limit() {
        run.p.stopped = Some(format!("Stopped after {} failed rows.", run.p.failed));
    }
    if let Some(m) = &fatal {
        run.p.stopped = Some(m.clone());
    }
    if in_tx {
        let all_ok = completed && run.p.failed == 0 && !run.p.cancelled && fatal.is_none();
        if all_ok {
            if let Err(e) = run.exec(db::commit_sql(driver)).await {
                run.p.rolled_back = true;
                run.p.stopped = Some(format!("Couldn't commit: {}", e.message));
            }
        } else {
            let _ = run.exec(db::rollback_sql(driver)).await;
            run.p.rolled_back = true;
            if run.p.failed > 0 && !run.p.cancelled && fatal.is_none() {
                run.p.note = Some(format!(
                    "One transaction (all or nothing): {} row{} failed, so nothing was imported. Fix them, or use “Commit each batch”.",
                    run.p.failed,
                    if run.p.failed == 1 { "" } else { "s" }
                ));
            }
        }
        if run.p.rolled_back {
            run.p.inserted = 0;
            run.p.skipped = 0;
        }
    } else if run.p.cancelled {
        // An interrupted batch transaction: roll it back (harmless when none is open).
        let _ = run.exec(db::rollback_sql(driver)).await;
    }
    if run.fail_seq > MAX_FAILURES {
        let extra = run.fail_seq - MAX_FAILURES;
        let n = format!(
            "Only the first {} failures are listed ({} more).",
            MAX_FAILURES, extra
        );
        run.p.note = Some(match run.p.note.take() {
            Some(x) => format!("{} {}", x, n),
            None => n,
        });
    }
    run.p.finished = true;
    emit(app, &mut run.p, started);
    Ok(run.p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eff(kind: SourceKind) -> Eff {
        Eff {
            kind,
            delim: ',',
            quote: Some('"'),
            header: true,
            enc: Encoding::Utf8,
            null_text: "n/a".into(),
            date_fmt: None,
            date_spec: String::new(),
            flatten: true,
        }
    }

    #[test]
    fn json_records_flatten() {
        let e = eff(SourceKind::Ndjson);
        let mut src = RowSource::new(&e);
        let mut out = Vec::new();
        src.feed(
            b"{\"a\":1,\"c\":{\"id\":2,\"e\":\"n/a\"},\"t\":[1,2]}\n\n{\"a\":",
            false,
            &mut out,
        );
        src.feed(b"3}", true, &mut out);
        let mut w = Vec::new();
        let (cols, rows) = table_of(out, &e, &mut w);
        assert_eq!(cols, vec!["a", "c.id", "c.e", "t"]);
        assert_eq!(
            rows[0].1,
            vec![
                Some("1".into()),
                Some("2".into()),
                None,
                Some("[1,2]".into())
            ]
        );
        assert_eq!(rows[1], (3, vec![Some("3".into()), None, None, None]));
    }

    #[test]
    fn csv_table() {
        let e = eff(SourceKind::Csv);
        let mut src = RowSource::new(&e);
        let mut out = Vec::new();
        src.feed(b"id,name\n1,n/a\n2,\n3,x,y\n", true, &mut out);
        let mut w = Vec::new();
        let (cols, rows) = table_of(out, &e, &mut w);
        assert_eq!(cols, vec!["id", "name"]);
        assert_eq!(rows[0].1, vec![Some("1".into()), None]);
        assert_eq!(rows[1].1, vec![Some("2".into()), None]);
        assert_eq!(w.len(), 1);
    }
}

//! Byte-oriented import previews and shared record decoding.

use crate::{
    self as importfmt, CsvParser, DateFormat, Decoder, Dialect, Encoding, Inferrer,
    JsonArraySplitter, SourceKind, TargetClass,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::collections::HashSet;

pub const PREVIEW_BYTES: usize = 1024 * 1024;
const PREVIEW_ROWS: usize = 50;
const SAMPLE_ROWS: usize = 1000;

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
pub struct Eff {
    pub kind: SourceKind,
    pub delim: char,
    pub quote: Option<char>,
    pub header: bool,
    pub enc: Encoding,
    pub null_text: String,
    pub date_fmt: Option<DateFormat>,
    pub date_spec: String,
    pub flatten: bool,
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

pub enum Rec {
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

pub struct RowSource {
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
    pub fn new(e: &Eff) -> RowSource {
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
    pub fn feed(&mut self, bytes: &[u8], last: bool, out: &mut Vec<Rec>) {
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

    pub fn invalid_json_array(&self) -> bool {
        matches!(&self.parser, Parser::Json(parser) if parser.not_array)
    }
}

pub fn resolve(path: &str, head: &[u8], f: &ImportFormat) -> (Eff, Option<String>) {
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

/// Header names (CSV) / union of keys (JSON) and the data rows of a parsed sample.
fn table_of(
    recs: Vec<Rec>,
    e: &Eff,
    warnings: &mut Vec<String>,
) -> Result<(Vec<String>, Vec<(u64, Row)>), String> {
    const MAX_COLUMNS: usize = 4096;
    const MAX_SAMPLE_CELLS: usize = 2_000_000;
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
            if width > MAX_COLUMNS {
                return Err("The file has too many columns to preview.".into());
            }
            columns = (1..=width).map(|i| format!("column{}", i)).collect();
        }
        if columns.len() > MAX_COLUMNS
            || rows.len().min(SAMPLE_ROWS) * columns.len() > MAX_SAMPLE_CELLS
        {
            return Err("The sample has too many cells to preview.".into());
        }
        for (_, r) in rows.iter_mut().take(SAMPLE_ROWS) {
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
        let mut seen = HashSet::new();
        for r in recs {
            match r {
                Rec::Obj(line, pairs) => {
                    for (k, _) in &pairs {
                        if seen.insert(k.clone()) {
                            columns.push(k.clone());
                            if columns.len() > MAX_COLUMNS {
                                return Err("The file has too many columns to preview.".into());
                            }
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
        if objs.len().min(SAMPLE_ROWS) * columns.len() > MAX_SAMPLE_CELLS {
            return Err("The sample has too many cells to preview.".into());
        }
        for (index, (line, pairs)) in objs.into_iter().enumerate() {
            if index >= SAMPLE_ROWS {
                rows.push((line, Vec::new()));
                continue;
            }
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
    Ok((columns, rows))
}

pub fn preview(
    path: &str,
    head: &[u8],
    size: u64,
    f: &ImportFormat,
    check_types: Option<&[Option<String>]>,
) -> Result<ImportPreview, String> {
    if head.is_empty() {
        return Err("The file is empty.".into());
    }
    let complete = head.len() as u64 >= size;
    let (e, enc_note) = resolve(path, head, f);
    let mut src = RowSource::new(&e);
    let mut recs: Vec<Rec> = Vec::new();
    src.feed(head, complete, &mut recs);
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
    let (columns, rows) = table_of(recs, &e, &mut warnings)?;
    if columns.is_empty() {
        return Err("No columns were found in the file.".into());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn eff(kind: SourceKind) -> Eff {
        Eff {
            kind,
            delim: ',',
            quote: Some('"'),
            header: true,
            enc: importfmt::Encoding::Utf8,
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
        let (cols, rows) = table_of(out, &e, &mut w).unwrap();
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
        let (cols, rows) = table_of(out, &e, &mut w).unwrap();
        assert_eq!(cols, vec!["id", "name"]);
        assert_eq!(rows[0].1, vec![Some("1".into()), None]);
        assert_eq!(rows[1].1, vec![Some("2".into()), None]);
        assert_eq!(w.len(), 1);
    }
}

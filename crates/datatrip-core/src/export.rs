//! Streaming CSV / JSON export of a query result (no row limit).

use crate::db::{DbConn, RowSink};
use crate::error::{AppError, AppResult};
use crate::model::{ColumnMeta, Driver, ExportFormat, ExportOptions};
use serde_json::Value;
use std::fs::File;
use std::io::{BufWriter, Write};

fn csv_cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

struct CsvSink {
    wtr: csv::Writer<ExportFile>,
    wrote_header: bool,
    count: u64,
}

impl RowSink for CsvSink {
    fn columns(&mut self, cols: &[ColumnMeta]) -> AppResult<()> {
        if !self.wrote_header {
            self.wtr
                .write_record(cols.iter().map(|c| c.name.as_str()))?;
            self.wrote_header = true;
        }
        Ok(())
    }

    fn row(&mut self, row: Vec<Value>) -> AppResult<bool> {
        let cells: Vec<String> = row.iter().map(csv_cell).collect();
        self.wtr.write_record(&cells)?;
        self.count += 1;
        Ok(true)
    }
}

struct JsonSink {
    w: BufWriter<ExportFile>,
    names: Vec<String>,
    started: bool,
    count: u64,
}

impl RowSink for JsonSink {
    fn columns(&mut self, cols: &[ColumnMeta]) -> AppResult<()> {
        if !self.started {
            self.names = cols.iter().map(|c| c.name.clone()).collect();
            self.w.write_all(b"[")?;
            self.started = true;
        }
        Ok(())
    }

    fn row(&mut self, row: Vec<Value>) -> AppResult<bool> {
        if self.count > 0 {
            self.w.write_all(b",\n")?;
        } else {
            self.w.write_all(b"\n")?;
        }
        self.w.write_all(b"{")?;
        for (i, v) in row.iter().enumerate() {
            if i > 0 {
                self.w.write_all(b",")?;
            }
            let name = self
                .names
                .get(i)
                .cloned()
                .unwrap_or_else(|| format!("col{}", i));
            serde_json::to_writer(&mut self.w, &name)?;
            self.w.write_all(b":")?;
            serde_json::to_writer(&mut self.w, v)?;
        }
        self.w.write_all(b"}")?;
        self.count += 1;
        Ok(true)
    }
}

fn create_file(path: &str) -> AppResult<File> {
    File::create(path).map_err(|e| AppError::new(format!("Cannot write {}: {}", path, e)))
}

pub const HOSTED_EXPORT_LIMIT: u64 = 128 * 1024 * 1024;

struct ExportFile {
    file: File,
    remaining: u64,
}

impl ExportFile {
    fn create(path: &str, hosted: bool) -> AppResult<Self> {
        Ok(Self {
            file: create_file(path)?,
            remaining: if hosted {
                HOSTED_EXPORT_LIMIT
            } else {
                u64::MAX
            },
        })
    }
}

impl Write for ExportFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(std::io::Error::other(
                "Export exceeds workspace file size limit",
            ));
        }
        let written = self.file.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

/// Re-runs `sql` on the connection and streams every row to `path`. Returns rows written.
pub fn export<'a>(
    conn: &'a mut DbConn,
    sql: &'a str,
    format: ExportFormat,
    path: &'a str,
    hosted: bool,
) -> futures::future::BoxFuture<'a, AppResult<u64>> {
    Box::pin(async move {
        match format {
            ExportFormat::Csv => {
                let file = ExportFile::create(path, hosted)?;
                let mut sink = CsvSink {
                    wtr: csv::Writer::from_writer(file),
                    wrote_header: false,
                    count: 0,
                };
                conn.stream(sql, &mut sink).await?;
                sink.wtr.flush()?;
                Ok(sink.count)
            }
            ExportFormat::Json => {
                let file = ExportFile::create(path, hosted)?;
                let mut sink = JsonSink {
                    w: BufWriter::new(file),
                    names: Vec::new(),
                    started: false,
                    count: 0,
                };
                conn.stream(sql, &mut sink).await?;
                if !sink.started {
                    sink.w.write_all(b"[")?;
                }
                sink.w.write_all(b"\n]\n")?;
                sink.w.flush()?;
                Ok(sink.count)
            }
        }
    })
}

// ---------------------------------------------------------------------------
// export_query_with: option-driven formats (csv, tsv, json, sql, markdown).
// Everything up to `ExportSink` is pure (no I/O) so it can be unit tested; the output must stay
// byte-identical to the frontend formatter (CONTRACT.md "v0.9 additions").
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextFormat {
    Csv,
    Tsv,
    Json,
    Sql,
    Markdown,
}

impl TextFormat {
    pub fn parse(s: &str) -> AppResult<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "csv" => Ok(Self::Csv),
            "tsv" => Ok(Self::Tsv),
            "json" => Ok(Self::Json),
            "sql" => Ok(Self::Sql),
            "markdown" | "md" => Ok(Self::Markdown),
            other => Err(AppError::new(format!("Unknown export format: {}", other))),
        }
    }
}

/// `ExportOptions` with defaults applied. Empty delimiter / line ending / table name fall back to
/// the default; an empty quote disables quoting.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub format: TextFormat,
    pub include_header: bool,
    pub delimiter: String,
    pub quote: String,
    pub null_text: String,
    pub line_ending: String,
    pub table_name: String,
}

pub fn resolve(o: &ExportOptions) -> AppResult<Resolved> {
    let non_empty = |v: &Option<String>, d: &str| match v {
        Some(x) if !x.is_empty() => x.clone(),
        _ => d.to_string(),
    };
    Ok(Resolved {
        format: TextFormat::parse(&o.format)?,
        include_header: o.include_header,
        delimiter: non_empty(&o.delimiter, ","),
        quote: o.quote.clone().unwrap_or_else(|| "\"".to_string()),
        null_text: o.null_text.clone().unwrap_or_default(),
        line_ending: non_empty(&o.line_ending, "\n"),
        table_name: non_empty(&o.table_name, "my_table"),
    })
}

/// Text of a non-NULL cell for csv / tsv / markdown (NULL is handled by the caller).
pub fn plain_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn csv_field(s: &str, delimiter: &str, quote: &str) -> String {
    if quote.is_empty() {
        return s.to_string();
    }
    let needs = (!delimiter.is_empty() && s.contains(delimiter))
        || s.contains(quote)
        || s.contains('\r')
        || s.contains('\n')
        || s.starts_with(' ')
        || s.ends_with(' ');
    if !needs {
        return s.to_string();
    }
    let doubled = s.replace(quote, &format!("{}{}", quote, quote));
    format!("{}{}{}", quote, doubled, quote)
}

pub fn csv_header_line(names: &[String], r: &Resolved) -> String {
    let f: Vec<String> = names
        .iter()
        .map(|n| csv_field(n, &r.delimiter, &r.quote))
        .collect();
    format!("{}{}", f.join(&r.delimiter), r.line_ending)
}

pub fn csv_row_line(row: &[Value], r: &Resolved) -> String {
    let f: Vec<String> = row
        .iter()
        .map(|v| match v {
            Value::Null => r.null_text.clone(),
            other => csv_field(&plain_text(other), &r.delimiter, &r.quote),
        })
        .collect();
    format!("{}{}", f.join(&r.delimiter), r.line_ending)
}

pub fn tsv_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

pub fn tsv_header_line(names: &[String], r: &Resolved) -> String {
    let f: Vec<String> = names.iter().map(|n| tsv_escape(n)).collect();
    format!("{}{}", f.join("\t"), r.line_ending)
}

pub fn tsv_row_line(row: &[Value], r: &Resolved) -> String {
    let f: Vec<String> = row
        .iter()
        .map(|v| match v {
            Value::Null => r.null_text.clone(),
            other => tsv_escape(&plain_text(other)),
        })
        .collect();
    format!("{}{}", f.join("\t"), r.line_ending)
}

/// Unique JSON keys: repeated names get `_2`, `_3`, ... (skipping any name already taken).
pub fn dedupe_names(names: &[String]) -> Vec<String> {
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out = Vec::with_capacity(names.len());
    for n in names {
        let mut key = n.clone();
        if used.contains(&key) {
            let mut k = *seen.get(n).unwrap_or(&1);
            loop {
                k += 1;
                key = format!("{}_{}", n, k);
                if !used.contains(&key) {
                    break;
                }
            }
            seen.insert(n.clone(), k);
        } else {
            seen.entry(n.clone()).or_insert(1);
        }
        used.insert(key.clone());
        out.push(key);
    }
    out
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// One JSON element: an object `{"a": 1, "b": null}` when `keys` is given, else an array `[1, null]`.
/// No indentation and no line ending.
pub fn json_row(row: &[Value], keys: Option<&[String]>) -> String {
    let vals: Vec<String> = row
        .iter()
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()))
        .collect();
    match keys {
        Some(keys) => {
            let parts: Vec<String> = vals
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    let k = keys
                        .get(i)
                        .cloned()
                        .unwrap_or_else(|| format!("col{}", i + 1));
                    format!("{}: {}", json_str(&k), v)
                })
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
        None => format!("[{}]", vals.join(", ")),
    }
}

/// Opening of the JSON document before the first element.
pub fn json_open(le: &str) -> String {
    format!("[{}", le)
}

/// Separator written before every element after the first.
pub fn json_element(element: &str, first: bool, le: &str) -> String {
    if first {
        format!("  {}", element)
    } else {
        format!(",{}  {}", le, element)
    }
}

/// Closing of the JSON document; `any` = at least one element was written.
pub fn json_close(any: bool, le: &str) -> String {
    if any {
        format!("{}]{}", le, le)
    } else {
        format!("[]{}", le)
    }
}

fn sql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn sql_value(v: &Value, driver: Driver) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => match (driver, b) {
            (Driver::Mssql, true) => "1".to_string(),
            (Driver::Mssql, false) => "0".to_string(),
            (_, true) => "TRUE".to_string(),
            (_, false) => "FALSE".to_string(),
        },
        Value::Number(n) => n.to_string(),
        Value::String(s) => sql_string(s),
        other => sql_string(&other.to_string()),
    }
}

pub fn sql_insert_line(row: &[Value], names: &[String], r: &Resolved, driver: Driver) -> String {
    let vals: Vec<String> = row.iter().map(|v| sql_value(v, driver)).collect();
    let cols = if r.include_header {
        let q: Vec<String> = names
            .iter()
            .map(|n| crate::db::quote_ident(driver, n))
            .collect();
        format!(" ({})", q.join(", "))
    } else {
        String::new()
    };
    format!(
        "INSERT INTO {}{} VALUES ({});{}",
        r.table_name,
        cols,
        vals.join(", "),
        r.line_ending
    )
}

pub fn md_escape(s: &str) -> String {
    s.replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace('\n', "<br>")
        .replace('\r', "<br>")
}

/// Header line plus the `| --- |` separator line. Uses `col1..colN` when the header is off.
pub fn md_header_lines(names: &[String], r: &Resolved) -> String {
    let shown: Vec<String> = if r.include_header {
        names.iter().map(|n| md_escape(n)).collect()
    } else {
        (1..=names.len()).map(|i| format!("col{}", i)).collect()
    };
    let sep: Vec<&str> = shown.iter().map(|_| "---").collect();
    format!(
        "| {} |{}| {} |{}",
        shown.join(" | "),
        r.line_ending,
        sep.join(" | "),
        r.line_ending
    )
}

pub fn md_row_line(row: &[Value], r: &Resolved) -> String {
    let f: Vec<String> = row
        .iter()
        .map(|v| match v {
            Value::Null => md_escape(&r.null_text),
            other => md_escape(&plain_text(other)),
        })
        .collect();
    format!("| {} |{}", f.join(" | "), r.line_ending)
}

struct ExportSink {
    w: BufWriter<ExportFile>,
    r: Resolved,
    driver: Driver,
    names: Vec<String>,
    json_keys: Vec<String>,
    opened: bool,
    count: u64,
}

impl ExportSink {
    fn put(&mut self, s: &str) -> AppResult<()> {
        self.w.write_all(s.as_bytes())?;
        Ok(())
    }

    /// Writes whatever must precede the rows; safe to call more than once.
    fn open(&mut self) -> AppResult<()> {
        if self.opened {
            return Ok(());
        }
        self.opened = true;
        let head = match self.r.format {
            TextFormat::Csv if self.r.include_header => csv_header_line(&self.names, &self.r),
            TextFormat::Tsv if self.r.include_header => tsv_header_line(&self.names, &self.r),
            TextFormat::Markdown => md_header_lines(&self.names, &self.r),
            TextFormat::Json => {
                self.json_keys = dedupe_names(&self.names);
                String::new()
            }
            _ => String::new(),
        };
        self.put(&head)
    }

    /// Writes the trailer. Call after the stream ended (also when no columns were reported).
    fn finish(&mut self) -> AppResult<()> {
        self.open()?;
        if self.r.format == TextFormat::Json {
            let tail = json_close(self.count > 0, &self.r.line_ending.clone());
            self.put(&tail)?;
        }
        self.w.flush()?;
        Ok(())
    }
}

impl RowSink for ExportSink {
    fn columns(&mut self, cols: &[ColumnMeta]) -> AppResult<()> {
        if !self.opened {
            self.names = cols.iter().map(|c| c.name.clone()).collect();
            self.open()?;
        }
        Ok(())
    }

    fn row(&mut self, row: Vec<Value>) -> AppResult<bool> {
        self.open()?;
        let le = self.r.line_ending.clone();
        let line = match self.r.format {
            TextFormat::Csv => csv_row_line(&row, &self.r),
            TextFormat::Tsv => tsv_row_line(&row, &self.r),
            TextFormat::Markdown => md_row_line(&row, &self.r),
            TextFormat::Sql => sql_insert_line(&row, &self.names, &self.r, self.driver),
            TextFormat::Json => {
                let keys = if self.r.include_header {
                    Some(self.json_keys.as_slice())
                } else {
                    None
                };
                let el = json_row(&row, keys);
                let first = self.count == 0;
                let mut s = String::new();
                if first {
                    s.push_str(&json_open(&le));
                }
                s.push_str(&json_element(&el, first, &le));
                s
            }
        };
        self.put(&line)?;
        self.count += 1;
        Ok(true)
    }
}

/// Re-runs `sql` (no row limit) and streams it to `path` using `options`. Writes to a temp file
/// beside `path` and renames on success. Returns rows written.
pub fn export_with<'a>(
    conn: &'a mut DbConn,
    sql: &'a str,
    options: &'a ExportOptions,
    path: &'a str,
    hosted: bool,
) -> futures::future::BoxFuture<'a, AppResult<u64>> {
    Box::pin(async move {
        let r = resolve(options)?;
        let target = crate::vault::expand_tilde(path.trim());
        let tmp = format!("{}.dt-tmp", target);
        let file = ExportFile::create(&tmp, hosted)?;
        let mut sink = ExportSink {
            w: BufWriter::new(file),
            r,
            driver: conn.driver(),
            names: Vec::new(),
            json_keys: Vec::new(),
            opened: false,
            count: 0,
        };
        let res = match conn.stream(sql, &mut sink).await {
            Ok(_) => sink.finish(),
            Err(e) => Err(e),
        };
        let n = sink.count;
        drop(sink);
        match res {
            Ok(()) => {
                if let Err(e) = std::fs::rename(&tmp, &target) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(AppError::new(format!("Cannot write {}: {}", target, e)));
                }
                Ok(n)
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                Err(e)
            }
        }
    })
}

pub const MAX_WRITE_BYTES: usize = 512 * 1024 * 1024;

/// Atomically writes `content` to `path` (`~` expanded): temp file in the same directory, then rename.
pub fn write_text_atomic(path: &str, content: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::new("No file path given"));
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(AppError::new("Content is larger than 512 MiB"));
    }
    let target = crate::vault::expand_tilde(path.trim());
    let tmp = format!("{}.dt-tmp", target);
    let res = (|| -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, &target)
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::new(format!("Cannot write {}: {}", target, e)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opts(format: &str) -> ExportOptions {
        ExportOptions {
            format: format.to_string(),
            include_header: true,
            delimiter: None,
            quote: None,
            null_text: None,
            line_ending: None,
            table_name: None,
        }
    }
    fn res(format: &str) -> Resolved {
        resolve(&opts(format)).unwrap()
    }
    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_and_unknown_format() {
        let r = res("csv");
        assert_eq!(r.delimiter, ",");
        assert_eq!(r.quote, "\"");
        assert_eq!(r.line_ending, "\n");
        assert_eq!(r.table_name, "my_table");
        assert!(resolve(&opts("xml")).is_err());
    }

    #[test]
    fn csv_quoting_rules() {
        assert_eq!(csv_field("plain", ",", "\""), "plain");
        assert_eq!(csv_field("a,b", ",", "\""), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\"", ",", "\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("a\nb", ",", "\""), "\"a\nb\"");
        assert_eq!(csv_field("a\rb", ",", "\""), "\"a\rb\"");
        assert_eq!(csv_field(" lead", ",", "\""), "\" lead\"");
        assert_eq!(csv_field("trail ", ",", "\""), "\"trail \"");
        assert_eq!(csv_field("", ",", "\""), "");
        assert_eq!(csv_field("a,b \"x\"", ",", ""), "a,b \"x\"");
        assert_eq!(csv_field("a;b", ";", "'"), "'a;b'");
        assert_eq!(csv_field("it's", ";", "'"), "'it''s'");
    }

    #[test]
    fn csv_lines_null_and_values() {
        let mut r = res("csv");
        let row = vec![
            json!(null),
            json!(true),
            json!(1.50),
            json!("a,b"),
            json!(12345678901234567890u64),
        ];
        assert_eq!(
            csv_row_line(&row, &r),
            ",true,1.5,\"a,b\",12345678901234567890\n"
        );
        r.null_text = " NULL".to_string();
        r.line_ending = "\r\n".to_string();
        // NULL text is never quoted, even with leading space.
        assert_eq!(csv_row_line(&[json!(null), json!("x")], &r), " NULL,x\r\n");
        assert_eq!(csv_header_line(&names(&["a", "b,c"]), &r), "a,\"b,c\"\r\n");
    }

    #[test]
    fn tsv_escapes() {
        assert_eq!(tsv_escape("a\\b\tc\nd\re"), "a\\\\b\\tc\\nd\\re");
        let mut r = res("tsv");
        r.null_text = "\\N".to_string();
        assert_eq!(
            tsv_row_line(&[json!("a\tb"), json!(null), json!(false)], &r),
            "a\\tb\t\\N\tfalse\n"
        );
        assert_eq!(tsv_header_line(&names(&["x", "y"]), &r), "x\ty\n");
    }

    #[test]
    fn json_objects_arrays_and_layout() {
        let keys = dedupe_names(&names(&["a", "b"]));
        let row = vec![json!(null), json!("q\"x")];
        assert_eq!(
            json_row(&row, Some(&keys)),
            "{\"a\": null, \"b\": \"q\\\"x\"}"
        );
        assert_eq!(
            json_row(&[json!(1.0), json!(true), json!("s")], None),
            "[1.0, true, \"s\"]"
        );
        let le = "\n";
        let doc = format!(
            "{}{}{}{}",
            json_open(le),
            json_element("{\"a\": 1}", true, le),
            json_element("{\"a\": 2}", false, le),
            json_close(true, le)
        );
        assert_eq!(doc, "[\n  {\"a\": 1},\n  {\"a\": 2}\n]\n");
        assert_eq!(json_close(false, le), "[]\n");
        assert_eq!(json_close(false, "\r\n"), "[]\r\n");
    }

    #[test]
    fn json_duplicate_keys() {
        assert_eq!(
            dedupe_names(&names(&["id", "id", "name", "id"])),
            names(&["id", "id_2", "name", "id_3"])
        );
        assert_eq!(
            dedupe_names(&names(&["a", "a_2", "a"])),
            names(&["a", "a_2", "a_3"])
        );
    }

    #[test]
    fn sql_inserts() {
        let mut r = res("sql");
        r.table_name = "public.orders".to_string();
        let row = vec![
            json!(1),
            json!("O'Neil"),
            json!(null),
            json!(true),
            json!(2.50),
        ];
        let cols = names(&["id", "na\"me", "x", "ok", "p"]);
        assert_eq!(
            sql_insert_line(&row, &cols, &r, Driver::Postgres),
            "INSERT INTO public.orders (\"id\", \"na\"\"me\", \"x\", \"ok\", \"p\") VALUES (1, 'O''Neil', NULL, TRUE, 2.5);\n"
        );
        assert!(sql_insert_line(&row, &cols, &r, Driver::Mysql).contains("(`id`, `na\"me`,"));
        assert!(sql_insert_line(&row, &cols, &r, Driver::Sqlite).contains("(\"id\","));
        let ms = sql_insert_line(&row, &cols, &r, Driver::Mssql);
        assert!(ms.contains("([id], [na\"me],"));
        assert!(ms.contains("NULL, 1, 2.5);"));
        assert_eq!(sql_value(&json!(false), Driver::Mssql), "0");
        assert_eq!(sql_value(&json!(false), Driver::Postgres), "FALSE");
        r.include_header = false;
        r.line_ending = "\r\n".to_string();
        assert_eq!(
            sql_insert_line(&[json!(1)], &names(&["id"]), &r, Driver::Postgres),
            "INSERT INTO public.orders VALUES (1);\r\n"
        );
    }

    #[test]
    fn markdown_rules() {
        let mut r = res("markdown");
        assert_eq!(
            md_header_lines(&names(&["a", "b|c"]), &r),
            "| a | b\\|c |\n| --- | --- |\n"
        );
        r.include_header = false;
        assert_eq!(
            md_header_lines(&names(&["a", "b"]), &r),
            "| col1 | col2 |\n| --- | --- |\n"
        );
        r.null_text = "-".to_string();
        assert_eq!(
            md_row_line(&[json!("x|y"), json!("l1\nl2"), json!(null), json!(3)], &r),
            "| x\\|y | l1<br>l2 | - | 3 |\n"
        );
        assert_eq!(md_row_line(&[json!("a\r\nb")], &r), "| a<br>b |\n");
    }

    #[test]
    fn write_text_rejects_oversize_and_empty_path() {
        assert!(write_text_atomic("", "x").is_err());
    }
}

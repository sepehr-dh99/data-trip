//! Streaming CSV / JSON export of a query result (no row limit).

use crate::db::{DbConn, RowSink};
use crate::error::{AppError, AppResult};
use crate::model::{ColumnMeta, ExportFormat};
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
    wtr: csv::Writer<File>,
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
    w: BufWriter<File>,
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

/// Re-runs `sql` on the connection and streams every row to `path`. Returns rows written.
pub fn export<'a>(
    conn: &'a mut DbConn,
    sql: &'a str,
    format: ExportFormat,
    path: &'a str,
) -> futures::future::BoxFuture<'a, AppResult<u64>> {
    Box::pin(async move {
        match format {
            ExportFormat::Csv => {
                let file = create_file(path)?;
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
                let file = create_file(path)?;
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

//! Import data (v0.16): preview a CSV / TSV / JSON array / NDJSON file (format detection, first rows, type
//! inference, checks against target column types) and stream it into a table with batched, parameterized
//! multi-row INSERTs on a session, with progress events `import-progress` and cancel. The file is read on a
//! blocking thread in chunks (never whole); parsing, conversion and SQL text live in the std-only `importfmt`.

use crate::db;
use crate::error::{AppError, AppResult};
use crate::importfmt::preview::{resolve, Eff, Rec, RowSource, PREVIEW_BYTES};
pub use crate::importfmt::preview::{ImportFormat, ImportPreview};
use crate::importfmt::{self, Bound, Conflict, Dialect, InsertSpec, SourceKind};
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

/// Event carrying `ImportProgress`.
type ProgressSink<'a> = dyn Fn(&ImportProgress) + Send + Sync + 'a;

pub const PROGRESS_EVENT: &str = "import-progress";
const CHUNK: usize = 256 * 1024;
const EMIT_EVERY: Duration = Duration::from_millis(150);
/// Failures kept with their details (more are only counted).
const MAX_FAILURES: u64 = 1000;

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

/// Format detection + the first rows of a file + inferred column types + (optionally) checks against the
/// target column types (see CONTRACT.md v0.16).
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
    format: &ImportFormat,
    checks: Option<&[Option<String>]>,
) -> AppResult<ImportPreview> {
    let (head, size) = read_head(path)?;
    Ok(crate::importfmt::preview::preview(
        path, &head, size, format, checks,
    )?)
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
                    if src.invalid_json_array() {
                        let _ = tx.blocking_send(Msg::Fail("The file isn't a JSON array.".into()));
                        return;
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

fn emit(app: &ProgressSink<'_>, p: &mut ImportProgress, started: Instant) {
    p.elapsed_ms = started.elapsed().as_millis() as u64;
    app(p);
    p.failures.clear();
}

/// Streams a file into a table (events `import-progress`); resolves with the final progress.
pub async fn import_run(
    app: &ProgressSink<'_>,
    state: &AppState,
    runs: &ImportRuns,
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
        app,
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
pub async fn import_cancel(runs: &ImportRuns, run_id: String) -> AppResult<()> {
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
    app: &'a ProgressSink<'a>,
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
    app: &ProgressSink<'_>,
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

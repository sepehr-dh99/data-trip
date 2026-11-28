//! SQL files (v0.15): open / save a console's `.sql` file with change detection, and run a whole script on a
//! session without loading it into the UI. The script is read from disk line by line on a blocking thread,
//! split into statements here (quotes, comments, PostgreSQL dollar quotes, MySQL `DELIMITER`, SQL Server `GO`)
//! and executed one by one on the session; progress goes to the frontend as `sqlfile-progress` events.

use crate::db::{self, TxControl};
use crate::error::{AppError, AppResult};
use crate::model::Driver;
use crate::session::Session;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

/// Largest file opened in an editor; bigger scripts are run with Run SQL file instead.
const MAX_EDITOR_FILE: u64 = 8 * 1024 * 1024;
/// Event carrying `RunProgress`.
type ProgressSink<'a> = dyn Fn(&RunProgress) + Send + Sync + 'a;

pub const PROGRESS_EVENT: &str = "sqlfile-progress";
/// Progress events are sent at most this often (failures and the end are always sent).
const EMIT_EVERY: Duration = Duration::from_millis(120);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub text: String,
    pub mtime_ms: u64,
    pub size: u64,
    /// The file started with a UTF-8 byte order mark (removed from `text`, written back on save).
    pub bom: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: u64,
}

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve(path: &str) -> AppResult<String> {
    let p = crate::vault::expand_tilde(path.trim());
    if p.trim().is_empty() {
        return Err(AppError::new("No file path given"));
    }
    Ok(p)
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn human_size(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{} bytes", n)
    }
}

fn read_blocking(path: &str) -> AppResult<TextFile> {
    let path = resolve(path)?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::new(format!("Could not read {}: {}", path, e)))?;
    if !meta.is_file() {
        return Err(AppError::new(format!("{} is not a file", path)));
    }
    if meta.len() > MAX_EDITOR_FILE {
        return Err(AppError::new(format!(
            "FILE_TOO_LARGE: {} is {}, too big to open in a console (8 MB at most). \
             Use Run SQL file… to execute it without opening it.",
            file_name(&path),
            human_size(meta.len())
        )));
    }
    // Metadata first: a change between the two calls then shows up as "changed on disk" later.
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::new(format!("Could not read {}: {}", path, e)))?;
    let mut text = String::from_utf8(bytes).map_err(|_| {
        AppError::new("The file is not UTF-8 text, so it can't be opened in a console.")
    })?;
    let bom = text.starts_with('\u{feff}');
    if bom {
        text.remove(0);
    }
    Ok(TextFile {
        text,
        mtime_ms: mtime_of(&meta),
        size: meta.len(),
        bom,
    })
}

fn write_blocking(
    path: &str,
    text: &str,
    expected_mtime_ms: Option<f64>,
    bom: bool,
) -> AppResult<WriteResult> {
    let path = resolve(path)?;
    // Write through a symlink to its target (the atomic rename would replace the link itself).
    let is_link = std::fs::symlink_metadata(&path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let target = if is_link {
        std::fs::canonicalize(&path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.clone())
    } else {
        path.clone()
    };
    let existing = std::fs::metadata(&target).ok();
    if let (Some(exp), Some(meta)) = (expected_mtime_ms, existing.as_ref()) {
        let cur = mtime_of(meta) as f64;
        if (cur - exp).abs() >= 1.0 {
            return Err(AppError::new(format!(
                "FILE_CHANGED: {} was changed on disk after it was opened or last saved.",
                file_name(&path)
            )));
        }
    }
    if bom {
        let mut content = String::with_capacity(text.len() + 3);
        content.push('\u{feff}');
        content.push_str(text);
        crate::export::write_text_atomic(&target, &content)?;
    } else {
        crate::export::write_text_atomic(&target, text)?;
    }
    // The rename created a new file: keep the old one's permissions.
    if let Some(meta) = existing {
        let _ = std::fs::set_permissions(&target, meta.permissions());
    }
    let meta = std::fs::metadata(&target)
        .map_err(|e| AppError::new(format!("Saved, but could not read {} back: {}", path, e)))?;
    Ok(WriteResult {
        mtime_ms: mtime_of(&meta),
    })
}

/// Reads a UTF-8 text file for a console (max 8 MiB) with its modification time.
pub async fn sql_file_read(path: String) -> AppResult<TextFile> {
    tokio::task::spawn_blocking(move || read_blocking(&path))
        .await
        .map_err(|e| AppError::new(format!("Read failed: {}", e)))?
}

/// Writes a console's text atomically. With `expected_mtime_ms`, refuses (error `FILE_CHANGED:`) when the
/// file on disk has another modification time.
pub async fn sql_file_write(
    path: String,
    text: String,
    expected_mtime_ms: Option<f64>,
    bom: Option<bool>,
) -> AppResult<WriteResult> {
    tokio::task::spawn_blocking(move || {
        write_blocking(&path, &text, expected_mtime_ms, bom.unwrap_or(false))
    })
    .await
    .map_err(|e| AppError::new(format!("Write failed: {}", e)))?
}

/// Modification time and size of a file; null when it does not exist.
pub async fn file_mtime(path: String) -> AppResult<Option<FileStat>> {
    let path = resolve(&path)?;
    Ok(std::fs::metadata(&path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| FileStat {
            mtime_ms: mtime_of(&m),
            size: m.len(),
        }))
}

// ---------------------------------------------------------------------------
// Statement splitter (streaming, one line at a time)
// ---------------------------------------------------------------------------

/// Dialect rules of the splitter (the same as `src/sqlsplit.ts` + client-side separators).
#[derive(Clone, Copy)]
pub struct SplitConfig {
    /// `[..]` quotes an identifier (SQL Server, SQLite).
    pub brackets: bool,
    /// PostgreSQL `$tag$ … $tag$` bodies and `E'…'` strings.
    pub dollar: bool,
    /// Backslash escapes inside '…' and "…" (MySQL).
    pub backslash: bool,
    /// MySQL: `#` line comments, `/*! … */` executable comments, the client's `DELIMITER` command.
    pub mysql: bool,
    /// SQL Server: a line with just `GO` ends a batch.
    pub go: bool,
    /// SQL Server script with GO lines: only GO separates (`;` stays inside the batch).
    pub go_only: bool,
}

impl SplitConfig {
    pub fn for_driver(d: Driver) -> Self {
        let base = SplitConfig {
            brackets: false,
            dollar: false,
            backslash: false,
            mysql: false,
            go: false,
            go_only: false,
        };
        match d {
            Driver::Postgres => SplitConfig {
                dollar: true,
                ..base
            },
            Driver::Mysql => SplitConfig {
                backslash: true,
                mysql: true,
                ..base
            },
            Driver::Sqlite => SplitConfig {
                brackets: true,
                ..base
            },
            Driver::Mssql => SplitConfig {
                brackets: true,
                go: true,
                ..base
            },
            Driver::Redis | Driver::Kafka => base,
        }
    }
}

/// One statement of a script: its text (trimmed, without the separator) and the line it starts on.
#[derive(Debug)]
pub struct Stmt {
    pub line: u64,
    pub sql: String,
    /// Bytes of the file read when the statement ended (progress).
    pub end_byte: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    /// A quoted string / identifier: the quote char and whether backslash escapes.
    Quote(char, bool),
    Bracket,
    /// Block comment nesting depth.
    Block(u32),
    Dollar,
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$' || !c.is_ascii()
}

/// Length of a `$tag$` / `$$` opener at the start of `s`, if any.
fn dollar_tag(s: &[char]) -> Option<usize> {
    if s.first() != Some(&'$') {
        return None;
    }
    let mut j = 1;
    while j < s.len() && j < 80 {
        let c = s[j];
        if c == '$' {
            return Some(j + 1);
        }
        let ok = if j == 1 {
            c.is_alphabetic() || c == '_' || !c.is_ascii()
        } else {
            c.is_alphanumeric() || c == '_' || !c.is_ascii()
        };
        if !ok {
            return None;
        }
        j += 1;
    }
    None
}

/// `s` without `prefix`, matched ASCII case-insensitively.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let n = prefix.len();
    if s.len() >= n && s.is_char_boundary(n) && s[..n].eq_ignore_ascii_case(prefix) {
        Some(&s[n..])
    } else {
        None
    }
}

/// `GO` or `GO 5` on its own line (SQL Server batch separator).
fn is_go_line(line: &str) -> bool {
    let t = line.trim();
    match strip_prefix_ci(t, "go") {
        Some("") => true,
        Some(rest) => {
            rest.starts_with(char::is_whitespace) && rest.trim().chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

pub struct Splitter {
    cfg: SplitConfig,
    mode: Mode,
    tag: Vec<char>,
    delimiter: Vec<char>,
    buf: String,
    content: bool,
    /// The current block comment belongs to the statement (it started after content, or is `/*! … */`).
    keep_comment: bool,
    start_line: u64,
    prev: char,
    prev2: char,
    /// A `GO` line was seen (SQL Server).
    pub saw_go: bool,
    pub out: Vec<Stmt>,
}

impl Splitter {
    pub fn new(cfg: SplitConfig) -> Self {
        Splitter {
            cfg,
            mode: Mode::Normal,
            tag: Vec::new(),
            delimiter: vec![';'],
            buf: String::new(),
            content: false,
            keep_comment: false,
            start_line: 0,
            prev: ' ',
            prev2: ' ',
            saw_go: false,
            out: Vec::new(),
        }
    }

    fn mark_content(&mut self, line_no: u64) {
        if !self.content {
            self.content = true;
            self.start_line = line_no;
        }
    }

    fn shift(&mut self, c: char) {
        self.prev2 = self.prev;
        self.prev = c;
    }

    fn push(&mut self) {
        if self.content {
            let s = std::mem::take(&mut self.buf);
            let t = s.trim();
            if !t.is_empty() {
                let sql = if t.len() == s.len() { s } else { t.to_string() };
                self.out.push(Stmt {
                    line: self.start_line,
                    sql,
                    end_byte: 0,
                });
            }
        }
        self.buf.clear();
        self.content = false;
        self.prev = ' ';
        self.prev2 = ' ';
    }

    fn delimiter_at(&self, chars: &[char], i: usize) -> bool {
        !self.cfg.go_only && chars[i..].starts_with(&self.delimiter)
    }

    /// Feeds one line (with its line break, if any). Finished statements are appended to `out`.
    pub fn feed_line(&mut self, line: &str, line_no: u64) {
        if self.mode == Mode::Normal {
            if self.cfg.mysql && !self.content {
                if let Some(rest) = strip_prefix_ci(line.trim(), "delimiter") {
                    if rest.starts_with(char::is_whitespace) && !rest.trim().is_empty() {
                        self.delimiter = rest.trim().chars().collect();
                        self.buf.clear();
                        return;
                    }
                }
            }
            if self.cfg.go && is_go_line(line) {
                self.saw_go = true;
                self.push();
                return;
            }
        }
        let chars: Vec<char> = line.chars().collect();
        let n = chars.len();
        let mut i = 0;
        while i < n {
            let c = chars[i];
            let next = if i + 1 < n { chars[i + 1] } else { '\0' };
            match self.mode {
                Mode::Normal => {
                    if self.delimiter_at(&chars, i) {
                        i += self.delimiter.len();
                        self.push();
                        continue;
                    }
                    if c.is_whitespace() {
                        if self.content {
                            self.buf.push(c);
                        }
                        self.shift(c);
                        i += 1;
                        continue;
                    }
                    if (c == '-' && next == '-') || (c == '#' && self.cfg.mysql) {
                        // Line comment: the rest of the line (dropped before the statement starts).
                        if self.content {
                            self.buf.extend(&chars[i..]);
                        }
                        self.shift(' ');
                        break;
                    }
                    if c == '/' && next == '*' {
                        if self.cfg.mysql && i + 2 < n && chars[i + 2] == '!' {
                            self.mark_content(line_no);
                        }
                        self.keep_comment = self.content;
                        if self.keep_comment {
                            self.buf.push_str("/*");
                        }
                        self.mode = Mode::Block(1);
                        i += 2;
                        continue;
                    }
                    self.mark_content(line_no);
                    if c == '\'' || c == '"' || c == '`' {
                        let e_string = self.cfg.dollar
                            && c == '\''
                            && (self.prev == 'E' || self.prev == 'e')
                            && !is_ident(self.prev2);
                        let esc = (self.cfg.backslash && c != '`') || e_string;
                        self.buf.push(c);
                        self.mode = Mode::Quote(c, esc);
                        i += 1;
                        continue;
                    }
                    if c == '[' && self.cfg.brackets {
                        self.buf.push(c);
                        self.mode = Mode::Bracket;
                        i += 1;
                        continue;
                    }
                    if c == '$' && self.cfg.dollar && !is_ident(self.prev) {
                        if let Some(len) = dollar_tag(&chars[i..]) {
                            self.tag = chars[i..i + len].to_vec();
                            self.buf.extend(&chars[i..i + len]);
                            self.mode = Mode::Dollar;
                            i += len;
                            continue;
                        }
                    }
                    self.buf.push(c);
                    self.shift(c);
                    i += 1;
                }
                Mode::Quote(q, esc) => {
                    self.buf.push(c);
                    if esc && c == '\\' {
                        if i + 1 < n {
                            self.buf.push(chars[i + 1]);
                        }
                        i += 2;
                        continue;
                    }
                    if c == q {
                        if next == q {
                            self.buf.push(next);
                            i += 2;
                            continue;
                        }
                        self.mode = Mode::Normal;
                        self.prev2 = ' ';
                        self.prev = q;
                    }
                    i += 1;
                }
                Mode::Bracket => {
                    self.buf.push(c);
                    if c == ']' {
                        if next == ']' {
                            self.buf.push(next);
                            i += 2;
                            continue;
                        }
                        self.mode = Mode::Normal;
                        self.prev2 = ' ';
                        self.prev = ']';
                    }
                    i += 1;
                }
                Mode::Block(depth) => {
                    if c == '/' && next == '*' {
                        if self.keep_comment {
                            self.buf.push_str("/*");
                        }
                        self.mode = Mode::Block(depth + 1);
                        i += 2;
                        continue;
                    }
                    if c == '*' && next == '/' {
                        if self.keep_comment {
                            self.buf.push_str("*/");
                        }
                        self.mode = if depth <= 1 {
                            Mode::Normal
                        } else {
                            Mode::Block(depth - 1)
                        };
                        self.shift(' ');
                        i += 2;
                        continue;
                    }
                    if self.keep_comment {
                        self.buf.push(c);
                    }
                    i += 1;
                }
                Mode::Dollar => {
                    if c == '$' && chars[i..].starts_with(&self.tag) {
                        self.buf.extend(&chars[i..i + self.tag.len()]);
                        i += self.tag.len();
                        self.mode = Mode::Normal;
                        self.prev2 = ' ';
                        self.prev = '$';
                        continue;
                    }
                    self.buf.push(c);
                    i += 1;
                }
            }
        }
    }

    /// End of input: the last statement (even an unterminated one) is emitted.
    pub fn finish(&mut self) {
        self.mode = Mode::Normal;
        self.push();
    }
}

/// Reads `path` line by line and calls `f` for every statement; `f` returning false stops early.
/// Ok(false) when stopped (by `f` or `halt`).
fn for_each_statement(
    path: &str,
    cfg: SplitConfig,
    halt: &AtomicBool,
    mut f: impl FnMut(Stmt) -> bool,
) -> Result<(bool, bool), String> {
    let file = File::open(path).map_err(|e| format!("Could not read {}: {}", path, e))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut sp = Splitter::new(cfg);
    let mut raw: Vec<u8> = Vec::new();
    let mut line_no: u64 = 0;
    let mut consumed: u64 = 0;
    loop {
        raw.clear();
        let n = reader
            .read_until(b'\n', &mut raw)
            .map_err(|e| format!("Could not read {}: {}", path, e))?;
        if n == 0 {
            break;
        }
        line_no += 1;
        consumed += n as u64;
        if halt.load(Ordering::SeqCst) {
            return Ok((false, sp.saw_go));
        }
        let mut line = std::str::from_utf8(&raw)
            .map_err(|_| format!("Line {} is not UTF-8 text.", line_no))?;
        if line_no == 1 {
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
        }
        sp.feed_line(line, line_no);
        for mut s in sp.out.drain(..) {
            s.end_byte = consumed;
            if !f(s) {
                return Ok((false, sp.saw_go));
            }
        }
    }
    sp.finish();
    for mut s in sp.out.drain(..) {
        s.end_byte = consumed;
        if !f(s) {
            return Ok((false, sp.saw_go));
        }
    }
    Ok((true, sp.saw_go))
}

// ---------------------------------------------------------------------------
// Run SQL file
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase", default)]
pub struct RunOptions {
    /// Stop at the first failing statement (default: keep going).
    pub stop_on_error: bool,
    /// Statements per transaction (null / 0 = auto-commit every statement).
    pub batch_tx: Option<u32>,
    /// The whole file in one transaction (rolled back at the first error).
    pub single_tx: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunFailure {
    pub line: u64,
    /// The statement's first 200 characters (one line).
    pub statement: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunProgress {
    pub run_id: String,
    /// Statements executed (ok + failed).
    pub done: u64,
    /// Statements in the file (counted before running); null until counted.
    pub total: Option<u64>,
    pub ok: u64,
    pub failed: u64,
    /// Statements that ran fine but were undone by a transaction rollback.
    pub rolled_back: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub elapsed_ms: u64,
    /// The failure that triggered this event (every failure gets its own event).
    pub last_error: Option<RunFailure>,
    pub finished: bool,
    pub cancelled: bool,
    /// Why the run ended before the end of the file (first error, read error, …).
    pub stopped: Option<String>,
    /// Something worth knowing about the run (the file manages its own transactions, …).
    pub note: Option<String>,
}

struct RunCtl {
    cancel: Arc<AtomicBool>,
    session: Arc<Session>,
}

/// Running `run_sql_file` calls by run id (for `run_sql_file_cancel`).
#[derive(Default)]
pub struct SqlFileRuns {
    map: Mutex<HashMap<String, RunCtl>>,
}

impl SqlFileRuns {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunCtl>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }
}

enum Msg {
    Total(u64),
    Stmt(Stmt),
    Done,
    Fail(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TxMode {
    Auto,
    Batch(u64),
    Single,
}

/// Counts the statements (first pass), then streams them to the runner (second pass).
fn produce(
    path: &str,
    mut cfg: SplitConfig,
    tx: tokio::sync::mpsc::Sender<Msg>,
    halt: &AtomicBool,
) {
    let mut count: u64 = 0;
    let first = for_each_statement(path, cfg, halt, |_| {
        count += 1;
        true
    });
    let saw_go = match first {
        Ok((true, go)) => go,
        Ok((false, _)) => return,
        Err(e) => {
            let _ = tx.blocking_send(Msg::Fail(e));
            return;
        }
    };
    if saw_go {
        // A script with GO lines: GO separates batches, `;` stays inside them.
        cfg.go_only = true;
        count = 0;
        match for_each_statement(path, cfg, halt, |_| {
            count += 1;
            true
        }) {
            Ok((true, _)) => {}
            Ok((false, _)) => return,
            Err(e) => {
                let _ = tx.blocking_send(Msg::Fail(e));
                return;
            }
        }
    }
    if tx.blocking_send(Msg::Total(count)).is_err() {
        return;
    }
    match for_each_statement(path, cfg, halt, |s| tx.blocking_send(Msg::Stmt(s)).is_ok()) {
        Ok((true, _)) => {
            let _ = tx.blocking_send(Msg::Done);
        }
        Ok((false, _)) => {}
        Err(e) => {
            let _ = tx.blocking_send(Msg::Fail(e));
        }
    }
}

fn preview(sql: &str) -> String {
    let mut out = String::new();
    let mut n = 0;
    let mut last_space = false;
    for c in sql.chars() {
        let c = if c.is_whitespace() { ' ' } else { c };
        if c == ' ' && last_space {
            continue;
        }
        last_space = c == ' ';
        if n >= 200 {
            out.push('…');
            break;
        }
        out.push(c);
        n += 1;
    }
    out
}

fn emit(app: &ProgressSink<'_>, p: &mut RunProgress, started: Instant) {
    p.elapsed_ms = started.elapsed().as_millis() as u64;
    app(p);
}

fn plural(n: u64, one: &str) -> String {
    if n == 1 {
        format!("1 {}", one)
    } else {
        format!("{} {}s", n, one)
    }
}

/// Runs a script file on a session, statement by statement, emitting `sqlfile-progress` events; resolves with
/// the final progress when the run ends (finished, stopped or cancelled).
pub async fn run_sql_file(
    app: &ProgressSink<'_>,
    state: &AppState,
    runs: &SqlFileRuns,
    session_id: String,
    path: String,
    options: RunOptions,
    run_id: String,
) -> AppResult<RunProgress> {
    let session = state.sessions.get(&session_id)?;
    let driver = session.config.driver;
    if matches!(driver, Driver::Redis | Driver::Kafka) {
        return Err(AppError::new(
            "Run SQL file works with PostgreSQL, MySQL, SQLite and SQL Server data sources.",
        ));
    }
    let path = resolve(&path)?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::new(format!("Could not read {}: {}", path, e)))?;
    if !meta.is_file() {
        return Err(AppError::new(format!("{} is not a file", path)));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    runs.lock().insert(
        run_id.clone(),
        RunCtl {
            cancel: cancel.clone(),
            session: session.clone(),
        },
    );
    let res = execute_file(
        app,
        &session,
        driver,
        path,
        meta.len(),
        options,
        &run_id,
        &cancel,
    )
    .await;
    runs.lock().remove(&run_id);
    Ok(res)
}

/// Stops a running `run_sql_file` (the current statement is cancelled; an open transaction is rolled back).
pub async fn run_sql_file_cancel(runs: &SqlFileRuns, run_id: String) -> AppResult<()> {
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

#[allow(clippy::too_many_arguments)]
async fn execute_file(
    app: &ProgressSink<'_>,
    session: &Arc<Session>,
    driver: Driver,
    path: String,
    bytes_total: u64,
    opts: RunOptions,
    run_id: &str,
    cancel: &Arc<AtomicBool>,
) -> RunProgress {
    let started = Instant::now();
    let mode = if opts.single_tx {
        TxMode::Single
    } else {
        match opts.batch_tx {
            Some(n) if n > 0 => TxMode::Batch(u64::from(n)),
            _ => TxMode::Auto,
        }
    };
    let mut p = RunProgress {
        run_id: run_id.to_string(),
        done: 0,
        total: None,
        ok: 0,
        failed: 0,
        rolled_back: 0,
        bytes_done: 0,
        bytes_total,
        elapsed_ms: 0,
        last_error: None,
        finished: false,
        cancelled: false,
        stopped: None,
        note: None,
    };
    emit(app, &mut p, started);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Msg>(256);
    let halt = Arc::new(AtomicBool::new(false));
    let producer_halt = halt.clone();
    let cfg = SplitConfig::for_driver(driver);
    let producer = tokio::task::spawn_blocking(move || produce(&path, cfg, tx, &producer_halt));

    let begin = db::begin_sql(driver).to_string();
    let commit = db::commit_sql(driver).to_string();
    let rollback = db::rollback_sql(driver).to_string();
    // A transaction DataTrip opened (batch / single mode) and how many statements ran ok in it.
    let mut own_tx = false;
    let mut in_tx_count: u64 = 0;
    let mut in_tx_ok: u64 = 0;
    // The script runs its own BEGIN / COMMIT: DataTrip stops wrapping it.
    let mut file_tx = false;
    let mut last_emit: Option<Instant> = None;
    let mut stopped: Option<String> = None;
    let mut last_line: u64 = 0;
    let mut completed = false;

    while let Some(msg) = rx.recv().await {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let s = match msg {
            Msg::Total(n) => {
                p.total = Some(n);
                emit(app, &mut p, started);
                continue;
            }
            Msg::Done => {
                completed = true;
                break;
            }
            Msg::Fail(e) => {
                stopped = Some(e);
                break;
            }
            Msg::Stmt(s) => s,
        };
        p.bytes_done = s.end_byte;
        last_line = s.line;
        let ctl = db::tx_control(driver, &s.sql);
        if mode != TxMode::Auto
            && !file_tx
            && matches!(ctl, Some(TxControl::Begin) | Some(TxControl::End))
        {
            // Commit what DataTrip opened before the script's own transaction statements take over.
            if own_tx {
                own_tx = false;
                if let Err(e) = session.execute(commit.clone(), 1).await {
                    p.failed += 1;
                    p.rolled_back += in_tx_ok;
                    p.last_error = Some(RunFailure {
                        line: s.line,
                        statement: "COMMIT".into(),
                        message: format!("Couldn't commit the transaction: {}", e.message),
                    });
                    emit(app, &mut p, started);
                    p.last_error = None;
                }
            }
            file_tx = true;
            p.note = Some(
                "The file has its own BEGIN / COMMIT statements, so DataTrip stopped wrapping it in transactions."
                    .into(),
            );
        }
        if mode != TxMode::Auto && !file_tx && !own_tx {
            match session.execute(begin.clone(), 1).await {
                Ok(_) => {
                    own_tx = true;
                    in_tx_count = 0;
                    in_tx_ok = 0;
                }
                Err(e) => {
                    stopped = Some(format!("Couldn't start a transaction: {}", e.message));
                    break;
                }
            }
        }
        let line = s.line;
        let head = preview(&s.sql);
        let r = session.execute(s.sql, 1).await;
        p.done += 1;
        match r {
            Ok(_) => {
                p.ok += 1;
                if own_tx {
                    in_tx_count += 1;
                    in_tx_ok += 1;
                    if ctl == Some(TxControl::ImplicitCommit) {
                        // MySQL commits before (and after) DDL: the open transaction is over.
                        own_tx = false;
                        if mode == TxMode::Single && p.note.is_none() {
                            p.note = Some(
                                "MySQL commits automatically around CREATE / ALTER / DROP, so those can't be rolled back."
                                    .into(),
                            );
                        }
                    } else if let TxMode::Batch(n) = mode {
                        if in_tx_count >= n {
                            own_tx = false;
                            if let Err(e) = session.execute(commit.clone(), 1).await {
                                p.failed += 1;
                                p.rolled_back += in_tx_ok;
                                p.last_error = Some(RunFailure {
                                    line,
                                    statement: "COMMIT".into(),
                                    message: format!(
                                        "Couldn't commit the last {}: {}",
                                        plural(in_tx_count, "statement"),
                                        e.message
                                    ),
                                });
                                emit(app, &mut p, started);
                                p.last_error = None;
                                if opts.stop_on_error {
                                    stopped = Some("Stopped at the first error.".into());
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                if cancel.load(Ordering::SeqCst) {
                    // The statement was cancelled by Stop: not a failure of the script.
                    p.done -= 1;
                    break;
                }
                p.failed += 1;
                let mut message = e.message;
                if own_tx {
                    own_tx = false;
                    let _ = session.execute(rollback.clone(), 1).await;
                    p.rolled_back += in_tx_ok;
                    if in_tx_ok > 0 {
                        message.push_str(&format!(
                            " (the transaction was rolled back, undoing {} before it)",
                            plural(in_tx_ok, "statement")
                        ));
                    }
                }
                p.last_error = Some(RunFailure {
                    line,
                    statement: head,
                    message,
                });
                emit(app, &mut p, started);
                last_emit = Some(Instant::now());
                p.last_error = None;
                if mode == TxMode::Single && !file_tx {
                    stopped = Some(
                        "Stopped: the transaction was rolled back, nothing was changed.".into(),
                    );
                    break;
                }
                if opts.stop_on_error {
                    stopped = Some(format!("Stopped at the first error (line {}).", line));
                    break;
                }
                continue;
            }
        }
        let due = match last_emit {
            Some(t) => t.elapsed() >= EMIT_EVERY,
            None => true,
        };
        if due {
            emit(app, &mut p, started);
            last_emit = Some(Instant::now());
        }
    }

    // Let the reader thread go, then wait for it (it never blocks once the receiver is gone).
    halt.store(true, Ordering::SeqCst);
    drop(rx);
    let _ = producer.await;

    if cancel.load(Ordering::SeqCst) {
        p.cancelled = true;
        stopped = Some(format!(
            "Stopped by you after {}.",
            plural(p.done, "statement")
        ));
    }
    if own_tx {
        if completed && !p.cancelled {
            if let Err(e) = session.execute(commit.clone(), 1).await {
                p.failed += 1;
                p.rolled_back += in_tx_ok;
                p.last_error = Some(RunFailure {
                    line: last_line,
                    statement: "COMMIT".into(),
                    message: format!("Couldn't commit the transaction: {}", e.message),
                });
            }
        } else {
            let _ = session.execute(rollback.clone(), 1).await;
            p.rolled_back += in_tx_ok;
        }
    }
    p.finished = true;
    p.stopped = stopped;
    emit(app, &mut p, started);
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(cfg: SplitConfig, text: &str) -> Vec<(u64, String)> {
        let mut sp = Splitter::new(cfg);
        for (i, line) in text.split_inclusive('\n').enumerate() {
            sp.feed_line(line, i as u64 + 1);
        }
        sp.finish();
        sp.out.into_iter().map(|s| (s.line, s.sql)).collect()
    }

    #[test]
    fn splits_postgres() {
        let pg = SplitConfig::for_driver(Driver::Postgres);
        let r = split(
            pg,
            "-- header\nSELECT 1;\n\nSELECT 'a;b' , \"x;y\";\nCREATE FUNCTION f() RETURNS int AS $body$\nBEGIN; RETURN 1; END\n$body$ LANGUAGE plpgsql;\n/* c; */ SELECT E'it\\'s;';\nSELECT 2",
        );
        assert_eq!(r.len(), 5);
        assert_eq!(r[0], (2, "SELECT 1".to_string()));
        assert_eq!(r[1], (4, "SELECT 'a;b' , \"x;y\"".to_string()));
        assert_eq!(r[2].0, 5);
        assert!(r[2].1.ends_with("LANGUAGE plpgsql"));
        assert_eq!(r[3], (8, "SELECT E'it\\'s;'".to_string()));
        assert_eq!(r[4], (9, "SELECT 2".to_string()));
    }

    #[test]
    fn splits_mysql_delimiter() {
        let my = SplitConfig::for_driver(Driver::Mysql);
        let r = split(
            my,
            "/*!40101 SET NAMES utf8 */;\n# comment\nDELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\nINSERT INTO t VALUES ('a\\';b');\n",
        );
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].1, "/*!40101 SET NAMES utf8 */");
        assert_eq!(
            r[1],
            (4, "CREATE PROCEDURE p() BEGIN SELECT 1; END".to_string())
        );
        assert_eq!(r[2], (6, "INSERT INTO t VALUES ('a\\';b')".to_string()));
    }

    #[test]
    fn splits_mssql_go() {
        let mut ms = SplitConfig::for_driver(Driver::Mssql);
        ms.go_only = true;
        let r = split(
            ms,
            "CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\n  SELECT [a;b];\nEND\nGO\nSELECT 2\ngo 3\n",
        );
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].0, 1);
        assert!(r[0].1.contains("SELECT [a;b];"));
        assert_eq!(r[1], (7, "SELECT 2".to_string()));
    }

    #[test]
    fn previews_one_line() {
        assert_eq!(
            preview("INSERT  INTO t\n  VALUES (1)"),
            "INSERT INTO t VALUES (1)"
        );
        assert_eq!(preview(&"x".repeat(300)).chars().count(), 201);
    }
}

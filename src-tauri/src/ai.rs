//! AI assistant for SQL consoles: provider detection and one-shot SQL generation.
//!
//! Providers: the Codex CLI (`codex exec`, uses the user's ChatGPT sign-in), the Claude Code CLI (`claude -p`),
//! an OpenAI-compatible HTTP API (key in the OS keychain) and a local Ollama server. The backend only builds a
//! prompt, asks the provider and returns the text of its answer: generated SQL is never executed here.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

/// Keychain service / user of the OpenAI-compatible API key.
const KEY_SERVICE: &str = "DataTrip-AI";
const KEY_USER: &str = "openai-api-key";
/// A provider gets this long to answer.
const TIMEOUT_SECS: u64 = 120;
const OLLAMA_URL: &str = "http://127.0.0.1:11434";
const OPENAI_URL: &str = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL: &str = "gpt-4o-mini";
/// Prefix of the error a cancelled request fails with (the UI drops it silently).
pub const CANCELLED: &str = "AI_CANCELLED";

/// Model catalogs are cached this long (per provider + base URL).
const MODELS_TTL: Duration = Duration::from_secs(600);
/// A model-listing CLI (`opencode models`, `codex debug models`) gets this long.
const MODELS_CLI_SECS: u64 = 15;

/// Running request (id + cancel sender), an in-memory fallback for the API key when no keychain exists and the
/// model catalog cache.
#[derive(Default)]
pub struct AiState {
    running: Mutex<Option<(u64, oneshot::Sender<()>)>>,
    next_id: AtomicU64,
    mem_key: Mutex<Option<String>>,
    models: Mutex<HashMap<String, (Instant, AiModels)>>,
}

impl AiState {
    fn api_key(&self) -> Option<String> {
        if let Some(k) = self
            .mem_key
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return Some(k);
        }
        match keyring::Entry::new(KEY_SERVICE, KEY_USER).and_then(|e| e.get_password()) {
            Ok(k) if !k.trim().is_empty() => Some(k),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderStatus {
    /// "codex" | "claude" | "opencode" | "openai" | "ollama"
    pub id: String,
    /// Installed / configured / running.
    pub available: bool,
    /// Codex: an auth file exists (null = unknown).
    pub signed_in: Option<bool>,
    /// CLI path when found.
    pub path: Option<String>,
    /// One line for the settings card.
    pub detail: String,
    /// Ollama: installed model names.
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    /// "codex" | "claude" | "opencode" | "openai" | "ollama"
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    /// OpenAI-compatible endpoint (default https://api.openai.com/v1).
    #[serde(default)]
    pub base_url: Option<String>,
    /// "write" | "fix" | "explain" | "refine"
    pub mode: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub driver: String,
    /// e.g. "PostgreSQL 16.2"; defaults to the driver's dialect name.
    #[serde(default)]
    pub dialect_hint: Option<String>,
    /// CREATE TABLE-like summary of the relevant tables (built by the frontend).
    #[serde(default)]
    pub schema_context: String,
    #[serde(default)]
    pub current_sql: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// The request may need tables of other data sources: the schema context then holds the cross-source
    /// rules (`source.database.table`, SQLite outer query) and the involved sources' schemas.
    #[serde(default)]
    pub cross_source: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResult {
    pub sql: Option<String>,
    pub explanation: Option<String>,
    pub elapsed_ms: u64,
    pub provider: String,
}

/// One entry of a provider's model catalog.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    /// What goes to `--model` / the API.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// e.g. "suggested", "from config.toml".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModels {
    pub models: Vec<AiModel>,
    /// Where the list came from, e.g. "`opencode models`".
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub async fn ai_providers(state: State<'_, AiState>) -> AppResult<Vec<AiProviderStatus>> {
    let mut out = Vec::new();

    let codex = find_binary("codex");
    let codex_auth = codex_signed_in();
    out.push(AiProviderStatus {
        id: "codex".into(),
        available: codex.is_some(),
        signed_in: Some(codex_auth),
        path: codex.as_ref().map(|p| p.display().to_string()),
        detail: match &codex {
            Some(p) if codex_auth => format!("Found {} · uses your ChatGPT sign-in", p.display()),
            Some(p) => format!("Found {} · run `codex login` in a terminal", p.display()),
            None => "Install with `npm i -g @openai/codex`, then run `codex login`".into(),
        },
        models: Vec::new(),
    });

    let claude = find_binary("claude");
    out.push(AiProviderStatus {
        id: "claude".into(),
        available: claude.is_some(),
        signed_in: None,
        path: claude.as_ref().map(|p| p.display().to_string()),
        detail: match &claude {
            Some(p) => format!("Found {} · uses your Claude sign-in", p.display()),
            None => "Install Claude Code, then sign in by running `claude` once".into(),
        },
        models: Vec::new(),
    });

    let opencode = find_binary("opencode");
    let opencode_auth = opencode_signed_in();
    out.push(AiProviderStatus {
        id: "opencode".into(),
        available: opencode.is_some(),
        signed_in: if opencode.is_some() {
            Some(opencode_auth)
        } else {
            None
        },
        path: opencode.as_ref().map(|p| p.display().to_string()),
        detail: match &opencode {
            Some(p) if opencode_auth => format!("Found {} · uses your OpenCode providers", p.display()),
            Some(p) => format!(
                "Found {} · run `opencode auth login` in a terminal (or set a provider key)",
                p.display()
            ),
            None => "Install with `npm i -g opencode-ai` (or the opencode.ai installer), then run `opencode auth login`"
                .into(),
        },
        models: Vec::new(),
    });

    let key_set = state.api_key().is_some();
    out.push(AiProviderStatus {
        id: "openai".into(),
        available: key_set,
        signed_in: None,
        path: None,
        detail: if key_set {
            "API key stored in the keychain".into()
        } else {
            "OpenAI-compatible endpoint + key, stored in the keychain".into()
        },
        models: Vec::new(),
    });

    let models = ollama_models().await;
    out.push(AiProviderStatus {
        id: "ollama".into(),
        available: models.is_some(),
        signed_in: None,
        path: None,
        detail: match &models {
            Some(m) if m.is_empty() => "Running · no models yet (`ollama pull llama3.1`)".into(),
            Some(m) => format!(
                "Running · {} model{}",
                m.len(),
                if m.len() == 1 { "" } else { "s" }
            ),
            None => "Not running on 127.0.0.1:11434".into(),
        },
        models: models.unwrap_or_default(),
    });
    Ok(out)
}

#[tauri::command]
pub async fn ai_generate(state: State<'_, AiState>, request: AiRequest) -> AppResult<AiResult> {
    let prompt = build_prompt(&request);
    let (tx, rx) = oneshot::channel::<()>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    {
        // A newer request replaces (and so cancels) an older one.
        let mut g = state.running.lock().unwrap_or_else(|e| e.into_inner());
        *g = Some((id, tx));
    }
    let api_key = if request.provider == "openai" {
        state.api_key()
    } else {
        None
    };
    let started = Instant::now();
    let label = provider_label(&request.provider);
    let work = run_provider(&request, &prompt, api_key);
    let outcome: AppResult<String> = tokio::select! {
        r = tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), work) => match r {
            Ok(r) => r,
            Err(_) => Err(AppError::new(format!(
                "{} did not answer within {} s. Try again, or pick a faster model in Settings › AI assistant.",
                label, TIMEOUT_SECS
            ))),
        },
        _ = rx => Err(AppError::new(format!("{}: cancelled", CANCELLED))),
    };
    {
        let mut g = state.running.lock().unwrap_or_else(|e| e.into_inner());
        if g.as_ref().map(|(i, _)| *i) == Some(id) {
            *g = None;
        }
    }
    let reply = outcome?;
    let reply = reply.trim();
    if reply.is_empty() {
        return Err(AppError::new(format!(
            "{} returned an empty answer. Try rephrasing the request.",
            label
        )));
    }
    let (sql, explanation) = if request.mode == "explain" {
        (None, Some(strip_fences(reply)))
    } else {
        let (sql, rest) = extract_sql(reply);
        if sql.is_empty() {
            return Err(AppError::new(format!(
                "{} answered without any SQL: {}",
                label,
                truncate(reply, 300)
            )));
        }
        (Some(sql), if rest.is_empty() { None } else { Some(rest) })
    };
    Ok(AiResult {
        sql,
        explanation,
        elapsed_ms: started.elapsed().as_millis() as u64,
        provider: request.provider.clone(),
    })
}

/// The model catalog of a provider (cached 10 min; `refresh` reloads). Never fails: problems go to `error`
/// with whatever could still be listed (Codex: config + suggested models).
#[tauri::command]
pub async fn ai_models(
    state: State<'_, AiState>,
    provider: String,
    base_url: Option<String>,
    refresh: Option<bool>,
) -> AppResult<AiModels> {
    let base = base_url
        .map(|b| b.trim().trim_end_matches('/').to_string())
        .filter(|b| !b.is_empty());
    let key = format!("{}|{}", provider, base.as_deref().unwrap_or(""));
    if refresh != Some(true) {
        let cache = state.models.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, m)) = cache.get(&key) {
            if at.elapsed() < MODELS_TTL {
                return Ok(m.clone());
            }
        }
    }
    let out = match provider.as_str() {
        "opencode" => opencode_models().await,
        "codex" => codex_models().await,
        "claude" => claude_models(),
        "openai" => openai_models(base.as_deref(), state.api_key()).await,
        "ollama" => match ollama_models().await {
            Some(list) => AiModels {
                models: list
                    .into_iter()
                    .map(|id| AiModel {
                        id,
                        label: None,
                        note: None,
                    })
                    .collect(),
                source: "Ollama /api/tags".into(),
                error: None,
            },
            None => AiModels {
                models: Vec::new(),
                source: "Ollama /api/tags".into(),
                error: Some("Ollama is not running on 127.0.0.1:11434".into()),
            },
        },
        other => AiModels {
            models: Vec::new(),
            source: String::new(),
            error: Some(format!("Unknown AI provider \"{}\"", other)),
        },
    };
    // Failures are not cached for long: a refresh after fixing the setup should work at once.
    if out.error.is_none() || !out.models.is_empty() {
        state
            .models
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, (Instant::now(), out.clone()));
    }
    Ok(out)
}

/// Cancels the running request (the CLI process is killed, the HTTP request dropped).
#[tauri::command]
pub async fn ai_cancel(state: State<'_, AiState>) -> AppResult<()> {
    let taken = state
        .running
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some((_, tx)) = taken {
        let _ = tx.send(());
    }
    Ok(())
}

/// Stores (Some) or clears (None / "") the OpenAI-compatible API key. The key is never returned to the UI.
#[tauri::command]
pub async fn ai_set_api_key(state: State<'_, AiState>, key: Option<String>) -> AppResult<()> {
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let mut mem = state.mem_key.lock().unwrap_or_else(|e| e.into_inner());
    match key {
        None => {
            let _ = keyring::Entry::new(KEY_SERVICE, KEY_USER).and_then(|e| e.delete_credential());
            *mem = None;
        }
        Some(k) => {
            match keyring::Entry::new(KEY_SERVICE, KEY_USER).and_then(|e| e.set_password(&k)) {
                Ok(()) => *mem = None,
                // No usable keychain (e.g. Linux without a secret service): keep it for this run only.
                Err(_) => *mem = Some(k),
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ prompt

fn provider_label(id: &str) -> &'static str {
    match id {
        "codex" => "Codex",
        "claude" => "Claude Code",
        "opencode" => "OpenCode",
        "openai" => "The API",
        "ollama" => "Ollama",
        _ => "The AI provider",
    }
}

fn dialect_name(driver: &str) -> &'static str {
    match driver {
        "postgres" => "PostgreSQL",
        "mysql" => "MySQL",
        "sqlite" => "SQLite",
        "mssql" => "SQL Server (T-SQL)",
        _ => "SQL",
    }
}

const SYSTEM_RULES: &str = "Rules:\n\
- Reply with exactly one ```sql code block holding the statement, followed by at most two short sentences.\n\
- Use only the tables and columns in the schema below and qualify table names the way the schema shows them.\n\
- Write one statement unless more are clearly needed; end each with a semicolon.\n\
- Do not modify data (no INSERT/UPDATE/DELETE/DDL) unless the request asks for it.\n\
- If something is ambiguous, make a sensible assumption and say so in the sentences.\n\
- Answer directly: do not run commands, open files or use tools.";

fn build_prompt(r: &AiRequest) -> String {
    let dialect = r
        .dialect_hint
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| dialect_name(&r.driver).to_string());
    let mut p = String::new();
    if r.cross_source && r.mode != "explain" {
        p.push_str(&format!(
            "You write SQL for DataTrip, a database IDE. This console is on {}.\n\
             The request may need tables of other data sources. If it does, write ONE cross-source SELECT that \
             follows the cross-source rules below (its outer query runs in SQLite). If it only needs this \
             console's data source, write a normal {} query instead.\n{}\n",
            dialect, dialect, SYSTEM_RULES
        ));
    } else if r.mode == "explain" {
        p.push_str(&format!(
            "You explain {} SQL for DataTrip, a database IDE.\n\
             Explain in plain language, in at most three short sentences and without code blocks, what the SQL \
             below does. Do not run commands or use tools.\n",
            dialect
        ));
    } else {
        p.push_str(&format!(
            "You write {} SQL for DataTrip, a database IDE.\n{}\n",
            dialect, SYSTEM_RULES
        ));
    }
    let schema = r.schema_context.trim();
    if !schema.is_empty() {
        p.push_str("\nSchema:\n");
        p.push_str(schema);
        p.push('\n');
    }
    let current = r
        .current_sql
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let ask = r.prompt.trim();
    match r.mode.as_str() {
        "fix" => {
            p.push_str("\nThis statement failed:\n```sql\n");
            p.push_str(current.unwrap_or(""));
            p.push_str("\n```\n");
            if let Some(e) = r.error.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                p.push_str("Error:\n");
                p.push_str(&truncate(e, 2000));
                p.push('\n');
            }
            p.push_str(
                "Return the corrected statement. Change as little as possible and keep the formatting.\n",
            );
            if !ask.is_empty() {
                p.push_str("Note from the user: ");
                p.push_str(ask);
                p.push('\n');
            }
        }
        "refine" => {
            p.push_str("\nThis is the statement you wrote:\n```sql\n");
            p.push_str(current.unwrap_or(""));
            p.push_str("\n```\nChange it as follows: ");
            p.push_str(if ask.is_empty() { "improve it" } else { ask });
            p.push('\n');
        }
        "explain" => {
            p.push_str("\nSQL:\n```sql\n");
            p.push_str(current.unwrap_or(ask));
            p.push_str("\n```\n");
        }
        _ => {
            if let Some(c) = current {
                p.push_str(
                    "\nThe statement under the cursor (for context, may be unrelated):\n```sql\n",
                );
                p.push_str(c);
                p.push_str("\n```\n");
            }
            p.push_str("\nRequest: ");
            p.push_str(ask);
            p.push('\n');
        }
    }
    p
}

/// The first ```sql block (else the first fenced block, else the whole reply) and the remaining prose.
fn extract_sql(reply: &str) -> (String, String) {
    let lower = reply.to_ascii_lowercase();
    let start = lower.find("```sql").or_else(|| lower.find("```"));
    if let Some(s) = start {
        // skip the fence line (```sql / ```postgresql …)
        let after = &reply[s + 3..];
        let body_start = after.find('\n').map(|i| i + 1).unwrap_or(after.len());
        let body = &after[body_start..];
        let (code, after_code) = match body.find("```") {
            Some(e) => (&body[..e], &body[e + 3..]),
            None => (body, ""),
        };
        let before = reply[..s].trim();
        let mut prose = String::new();
        for part in [before, after_code.trim()] {
            if !part.is_empty() {
                if !prose.is_empty() {
                    prose.push(' ');
                }
                prose.push_str(part);
            }
        }
        return (code.trim().to_string(), collapse_ws(&prose));
    }
    (reply.trim().to_string(), String::new())
}

fn strip_fences(reply: &str) -> String {
    collapse_ws(&reply.replace("```sql", "").replace("```", ""))
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// The last `max` characters (CLI error output ends with the useful part).
fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.trim().to_string();
    }
    let out: String = s.chars().skip(n - max).collect();
    format!("…{}", out.trim())
}

// ------------------------------------------------------------------ providers

async fn run_provider(r: &AiRequest, prompt: &str, api_key: Option<String>) -> AppResult<String> {
    let model = r
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string);
    match r.provider.as_str() {
        "codex" => run_codex(prompt, model).await,
        "claude" => run_claude(prompt, model).await,
        "opencode" => run_opencode(prompt, model).await,
        "openai" => run_openai(prompt, model, r.base_url.as_deref(), api_key).await,
        "ollama" => run_ollama(prompt, model).await,
        other => Err(AppError::new(format!("Unknown AI provider \"{}\"", other))),
    }
}

/// A fresh empty working directory for a CLI run, removed when dropped (also on cancel / timeout).
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> AppResult<TempDir> {
        let p = std::env::temp_dir().join(format!("datatrip-ai-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p)?;
        Ok(TempDir(p))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct CliOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Runs a CLI (no shell) in `cwd` with the prompt on stdin; the process is killed when the future is dropped.
async fn run_cli(bin: &Path, args: &[String], cwd: &Path, input: &str) -> AppResult<CliOutput> {
    run_cli_with_env(bin, args, cwd, input, &[]).await
}

/// `run_cli` with extra environment variables for the child.
async fn run_cli_with_env(
    bin: &Path,
    args: &[String],
    cwd: &Path,
    input: &str,
    extra_env: &[(&str, &str)],
) -> AppResult<CliOutput> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Inside an AppImage: don't let the CLI (and its `node`) load the image's bundled libraries.
    crate::child_env::clean_tokio(&mut cmd);
    // GUI apps get a minimal PATH (macOS): node-based CLIs need `node` from the same places we searched.
    if let Some(path) = child_path(bin) {
        cmd.env("PATH", path);
    }
    cmd.env("NO_COLOR", "1");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    // Windows: no console window flashing up for the CLI (CREATE_NO_WINDOW).
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::new(format!("Could not start {}: {}", bin.display(), e)))?;
    if let Some(mut stdin) = child.stdin.take() {
        let bytes = input.as_bytes().to_vec();
        // Written concurrently so a CLI that prints before reading can't deadlock on full pipes.
        tokio::spawn(async move {
            let _ = stdin.write_all(&bytes).await;
            let _ = stdin.shutdown().await;
        });
    }
    let out = child.wait_with_output().await?;
    Ok(CliOutput {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn looks_like_auth_error(s: &str) -> bool {
    let m = s.to_ascii_lowercase();
    m.contains("login")
        || m.contains("log in")
        || m.contains("sign in")
        || m.contains("not authenticated")
        || m.contains("unauthorized")
        || m.contains("401")
        || m.contains("api key")
}

async fn run_codex(prompt: &str, model: Option<String>) -> AppResult<String> {
    let bin = find_binary("codex").ok_or_else(|| {
        AppError::new(
            "Codex CLI not found. Install it with `npm i -g @openai/codex`, then run `codex login` in a terminal \
             to sign in with ChatGPT.",
        )
    })?;
    let dir = TempDir::new()?;
    let answer = dir.0.join("answer.md");
    let mut args: Vec<String> = vec![
        "exec".into(),
        "--skip-git-repo-check".into(),
        "--sandbox".into(),
        "read-only".into(),
        "--color".into(),
        "never".into(),
        "--output-last-message".into(),
        answer.display().to_string(),
    ];
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m);
    }
    // "-": read the prompt from stdin (keeps long schema text off the command line).
    args.push("-".into());
    let out = run_cli(&bin, &args, &dir.0, prompt).await?;
    if !out.ok {
        let err = tail(&out.stderr, 600);
        if looks_like_auth_error(&out.stderr) {
            return Err(AppError::new(format!(
                "Codex is not signed in. Run `codex login` in a terminal, then try again. ({})",
                err
            )));
        }
        return Err(AppError::new(format!("Codex failed: {}", err)));
    }
    let file = std::fs::read_to_string(&answer).unwrap_or_default();
    Ok(if file.trim().is_empty() {
        out.stdout
    } else {
        file
    })
}

async fn run_claude(prompt: &str, model: Option<String>) -> AppResult<String> {
    let bin = find_binary("claude").ok_or_else(|| {
        AppError::new(
            "Claude Code CLI not found. Install Claude Code, run `claude` once in a terminal to sign in, then try \
             again.",
        )
    })?;
    let dir = TempDir::new()?;
    let mut args: Vec<String> = vec!["-p".into(), "--output-format".into(), "text".into()];
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m);
    }
    let out = run_cli(&bin, &args, &dir.0, prompt).await?;
    if !out.ok {
        let msg = if out.stderr.trim().is_empty() {
            &out.stdout
        } else {
            &out.stderr
        };
        let err = tail(msg, 600);
        if looks_like_auth_error(msg) {
            return Err(AppError::new(format!(
                "Claude Code is not signed in. Run `claude` in a terminal and sign in, then try again. ({})",
                err
            )));
        }
        return Err(AppError::new(format!("Claude Code failed: {}", err)));
    }
    Ok(out.stdout)
}

/// OpenCode's inline config for a DataTrip run: no file edits, shell commands or web access —
/// it only has to answer with SQL.
const OPENCODE_CONFIG: &str = r#"{"permission":{"edit":"deny","bash":"deny","webfetch":"deny"}}"#;

/// Longest prompt passed as a command-line argument (Windows caps a command line at 32 767
/// characters); longer prompts go through a file the model reads.
const OPENCODE_MAX_ARG: usize = 24_000;

async fn run_opencode(prompt: &str, model: Option<String>) -> AppResult<String> {
    let bin = find_binary("opencode").ok_or_else(|| {
        AppError::new(
            "OpenCode CLI not found. Install it with `npm i -g opencode-ai` (or the installer from \
             opencode.ai), run `opencode auth login` in a terminal, then try again.",
        )
    })?;
    let dir = TempDir::new()?;
    let mut args: Vec<String> = vec!["run".into()];
    if let Some(m) = model {
        // OpenCode models are "provider/model", e.g. "anthropic/claude-sonnet-4-5".
        args.push("--model".into());
        args.push(m);
    }
    if prompt.len() > OPENCODE_MAX_ARG {
        std::fs::write(dir.0.join("request.md"), prompt)?;
        args.push(
            "Read the file request.md in the current directory and follow its instructions exactly. \
             Reply only as it asks."
                .into(),
        );
    } else {
        args.push(prompt.to_string());
    }
    let out = run_cli_with_env(
        &bin,
        &args,
        &dir.0,
        "",
        &[("OPENCODE_CONFIG_CONTENT", OPENCODE_CONFIG)],
    )
    .await?;
    if !out.ok {
        let msg = if out.stderr.trim().is_empty() {
            &out.stdout
        } else {
            &out.stderr
        };
        let err = tail(msg, 600);
        if looks_like_auth_error(msg) {
            return Err(AppError::new(format!(
                "OpenCode has no provider signed in. Run `opencode auth login` in a terminal, then try again. ({})",
                err
            )));
        }
        return Err(AppError::new(format!("OpenCode failed: {}", err)));
    }
    Ok(out.stdout)
}

/// OpenCode keeps provider sign-ins in `$XDG_DATA_HOME/opencode/auth.json`
/// (default `~/.local/share/opencode`).
fn opencode_signed_in() -> bool {
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".local").join("share")));
    data.map(|d| d.join("opencode").join("auth.json").is_file())
        .unwrap_or(false)
}

fn http_client(timeout: Duration) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(AppError::from)
}

/// `{"error": {"message": …}}` / `{"error": "…"}` of an HTTP error body, else the body itself.
fn http_error_text(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v.pointer("/error/message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
        if let Some(m) = v.get("error").and_then(|m| m.as_str()) {
            return m.to_string();
        }
    }
    truncate(body.trim(), 300)
}

fn messages(prompt: &str) -> serde_json::Value {
    serde_json::json!([{ "role": "user", "content": prompt }])
}

async fn run_openai(
    prompt: &str,
    model: Option<String>,
    base_url: Option<&str>,
    api_key: Option<String>,
) -> AppResult<String> {
    let key = api_key.ok_or_else(|| {
        AppError::new("No API key set. Add one in Settings › AI assistant › API key.")
    })?;
    let base = base_url
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .unwrap_or(OPENAI_URL)
        .trim_end_matches('/')
        .to_string();
    let url = format!("{}/chat/completions", base);
    let body = serde_json::json!({
        "model": model.unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string()),
        "messages": messages(prompt),
    });
    let client = http_client(Duration::from_secs(TIMEOUT_SECS))?;
    let resp = client
        .post(&url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::new(format!("Could not reach {}: {}", base, e)))?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(AppError::new(format!(
            "The API answered {}: {}",
            status.as_u16(),
            http_error_text(&text)
        )));
    }
    let v: serde_json::Value = serde_json::from_str(&text)?;
    Ok(v.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string())
}

async fn run_ollama(prompt: &str, model: Option<String>) -> AppResult<String> {
    let model = match model {
        Some(m) => m,
        None => match ollama_models().await {
            None => {
                return Err(AppError::new(
                    "Ollama is not running. Start it (`ollama serve` or the Ollama app), then try again.",
                ))
            }
            Some(list) => list.into_iter().next().ok_or_else(|| {
                AppError::new("Ollama has no models yet. Run `ollama pull llama3.1` in a terminal.")
            })?,
        },
    };
    let body = serde_json::json!({ "model": model, "messages": messages(prompt), "stream": false });
    let client = http_client(Duration::from_secs(TIMEOUT_SECS))?;
    let resp = client
        .post(format!("{}/api/chat", OLLAMA_URL))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            AppError::new(format!(
                "Could not reach Ollama on 127.0.0.1:11434 ({}). Is it running?",
                e
            ))
        })?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(AppError::new(format!(
            "Ollama answered {}: {}",
            status.as_u16(),
            http_error_text(&text)
        )));
    }
    let v: serde_json::Value = serde_json::from_str(&text)?;
    Ok(v.pointer("/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string())
}

/// Installed Ollama models (None = not running). 1 s timeout.
async fn ollama_models() -> Option<Vec<String>> {
    let client = http_client(Duration::from_secs(1)).ok()?;
    let resp = client
        .get(format!("{}/api/tags", OLLAMA_URL))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    let mut out = Vec::new();
    if let Some(list) = v.get("models").and_then(|m| m.as_array()) {
        for m in list {
            if let Some(n) = m.get("name").and_then(|n| n.as_str()) {
                out.push(n.to_string());
            }
        }
    }
    Some(out)
}

// ------------------------------------------------------------------ CLI discovery

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Directories searched besides PATH: package-manager bins that GUI apps on macOS don't get on their PATH.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    } else {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    if let Some(home) = home_dir() {
        for rel in [
            ".local/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".bun/bin",
            ".claude/local",
            ".opencode/bin",
            ".cargo/bin",
        ] {
            dirs.push(home.join(rel));
        }
        // nvm: newest Node version first
        if let Ok(rd) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
            let mut versions: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            versions.sort();
            versions.reverse();
            dirs.extend(versions);
        }
    }
    dirs
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = crate::child_env::strip_appimage_dirs(
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default(),
    );
    for d in extra_dirs() {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// First `name` executable on PATH or in the extra directories.
fn find_binary(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{}.exe", name),
            format!("{}.cmd", name),
            format!("{}.bat", name),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in search_dirs() {
        for n in &names {
            let p = dir.join(n);
            if is_executable(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// PATH for a CLI child: its own directory, the extra directories, then the inherited PATH.
fn child_path(bin: &Path) -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = bin.parent() {
        dirs.push(parent.to_path_buf());
    }
    for d in search_dirs() {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).ok()
}

/// Codex keeps its sign-in in `$CODEX_HOME/auth.json` (default `~/.codex`).
fn codex_signed_in() -> bool {
    let dir = std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")));
    dir.map(|d| d.join("auth.json").is_file()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_first_sql_block() {
        let (sql, rest) = extract_sql("Here:\n```sql\nSELECT 1;\n```\nCounts one.");
        assert_eq!(sql, "SELECT 1;");
        assert_eq!(rest, "Here: Counts one.");
    }

    #[test]
    fn whole_reply_without_fence() {
        let (sql, rest) = extract_sql("  SELECT 2;  ");
        assert_eq!(sql, "SELECT 2;");
        assert!(rest.is_empty());
    }

    #[test]
    fn parses_opencode_models() {
        let m = parse_opencode_models(
            "Loading…\nanthropic/claude-sonnet-4-5\nopenai/gpt-5.1\n\nWARN something odd\nopencode/big-pickle\n",
        );
        let ids: Vec<&str> = m.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "anthropic/claude-sonnet-4-5",
                "openai/gpt-5.1",
                "opencode/big-pickle"
            ]
        );
    }

    #[test]
    fn parses_codex_models() {
        let json = r#"{"models":[{"slug":"gpt-6.2-sol","display_name":"GPT-6.2 Sol"},{"slug":"x-1","visibility":"hide"},{"id":"gpt-6-luna"}]}"#;
        let ids: Vec<String> = parse_codex_models(json).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["gpt-6.2-sol", "gpt-6-luna"]);
        let ids: Vec<String> =
            parse_codex_models("Models:\n- gpt-6.2-sol (default)\n- gpt-6-luna\n")
                .into_iter()
                .map(|m| m.id)
                .collect();
        assert_eq!(ids, ["gpt-6.2-sol", "gpt-6-luna"]);
    }

    #[test]
    fn parses_toml_model() {
        assert_eq!(
            parse_toml_model("# c\nmodel = \"gpt-6.2-sol\"\n[profiles.x]\nmodel = \"y\"\n"),
            Some("gpt-6.2-sol".into())
        );
        assert_eq!(parse_toml_model("[a]\nmodel = \"y\""), None);
        assert_eq!(parse_toml_model("model_reasoning_effort = \"high\""), None);
    }

    #[test]
    fn unterminated_fence() {
        let (sql, _) = extract_sql("```postgresql\nSELECT 3;");
        assert_eq!(sql, "SELECT 3;");
    }
}

// ------------------------------------------------------------------ model catalogs

/// Codex models offered when the CLI can't list its catalog (ChatGPT sign-in names, Nov 2026).
const CODEX_SUGGESTED: &[(&str, &str)] = &[
    ("gpt-6.2-sol", "GPT-6.2 Sol"),
    ("gpt-6.2-astra", "GPT-6.2 Astra"),
    ("gpt-6.1-sol", "GPT-6.1 Sol"),
    ("gpt-6-luna", "GPT-6 Luna"),
];

/// Claude Code `--model` aliases, then pinned model ids.
const CLAUDE_MODELS: &[(&str, &str, &str)] = &[
    ("sonnet", "Sonnet (latest)", "alias"),
    ("opus", "Opus (latest)", "alias"),
    ("haiku", "Haiku (latest)", "alias"),
    ("opusplan", "Opus to plan, Sonnet to write", "alias"),
    ("claude-opus-5-5", "Claude Opus 5.5", "pinned"),
    ("claude-haiku-5-5", "Claude Haiku 5.5", "pinned"),
];

fn model_entry(id: &str, label: Option<&str>, note: Option<&str>) -> AiModel {
    AiModel {
        id: id.to_string(),
        label: label.map(str::to_string),
        note: note.map(str::to_string),
    }
}

fn claude_models() -> AiModels {
    AiModels {
        models: CLAUDE_MODELS
            .iter()
            .map(|&(id, label, note)| model_entry(id, Some(label), Some(note)))
            .collect(),
        source: "Claude Code model aliases".into(),
        error: None,
    }
}

/// Runs a model-listing CLI with no stdin, in a temp dir, capped at 15 s.
async fn list_cli(bin: &Path, args: &[String]) -> Result<CliOutput, String> {
    let dir = TempDir::new().map_err(|e| e.message)?;
    match tokio::time::timeout(
        Duration::from_secs(MODELS_CLI_SECS),
        run_cli(bin, args, &dir.0, ""),
    )
    .await
    {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(e.message),
        Err(_) => Err(format!("timed out after {} s", MODELS_CLI_SECS)),
    }
}

/// `provider/model` lines of `opencode models` (other output — banners, warnings — is skipped).
pub fn parse_opencode_models(stdout: &str) -> Vec<AiModel> {
    let mut out: Vec<AiModel> = Vec::new();
    for line in stdout.lines() {
        let t = line.trim();
        let ok = !t.is_empty()
            && !t.contains(char::is_whitespace)
            && t.contains('/')
            && !t.starts_with('/')
            && !t.ends_with('/')
            && !t.contains("://")
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || "/._-:@+[]".contains(c));
        if ok && !out.iter().any(|m| m.id == t) {
            out.push(model_entry(t, None, None));
        }
    }
    out
}

async fn opencode_models() -> AiModels {
    let source = "`opencode models`".to_string();
    let bin = match find_binary("opencode") {
        Some(b) => b,
        None => {
            return AiModels {
                models: Vec::new(),
                source,
                error: Some("OpenCode CLI not found".into()),
            }
        }
    };
    match list_cli(&bin, &["models".to_string()]).await {
        Ok(out) => {
            let models = parse_opencode_models(&out.stdout);
            let error = if models.is_empty() {
                Some(if out.ok {
                    "`opencode models` listed no models — run `opencode auth login`".to_string()
                } else {
                    format!("`opencode models` failed: {}", tail(&out.stderr, 300))
                })
            } else {
                None
            };
            AiModels {
                models,
                source,
                error,
            }
        }
        Err(e) => AiModels {
            models: Vec::new(),
            source,
            error: Some(format!("`opencode models` failed: {}", e)),
        },
    }
}

fn looks_like_model_id(t: &str) -> bool {
    (3..=80).contains(&t.len())
        && t.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && t.chars().any(|c| c.is_ascii_digit() || c == '-')
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-:/".contains(c))
}

/// Model ids of `codex debug models`: JSON (objects with `slug` / `id` / `model`, label from `display_name`;
/// entries with `visibility: "hide"` skipped), else lines that look like model ids.
pub fn parse_codex_models(stdout: &str) -> Vec<AiModel> {
    fn walk(v: &serde_json::Value, out: &mut Vec<AiModel>) {
        match v {
            serde_json::Value::Array(a) => {
                for x in a {
                    walk(x, out);
                }
            }
            serde_json::Value::Object(o) => {
                let id = ["slug", "id", "model"]
                    .iter()
                    .find_map(|k| o.get(*k).and_then(|x| x.as_str()));
                if let Some(id) = id.map(str::trim).filter(|s| looks_like_model_id(s)) {
                    let hidden = o.get("visibility").and_then(|x| x.as_str()) == Some("hide");
                    if !hidden && !out.iter().any(|m| m.id == id) {
                        let label = o
                            .get("display_name")
                            .or_else(|| o.get("displayName"))
                            .and_then(|x| x.as_str())
                            .filter(|l| !l.trim().is_empty() && *l != id);
                        out.push(model_entry(id, label, None));
                    }
                    return;
                }
                for x in o.values() {
                    walk(x, out);
                }
            }
            _ => {}
        }
    }
    let mut out: Vec<AiModel> = Vec::new();
    let t = stdout.trim();
    let json_start = t.find(['{', '[']);
    if let Some(i) = json_start {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t[i..]) {
            walk(&v, &mut out);
            return out;
        }
    }
    for line in t.lines() {
        let w = line.trim().trim_start_matches(['-', '*', ' ']).trim();
        let w = w.split_whitespace().next().unwrap_or("");
        if looks_like_model_id(w) && !out.iter().any(|m| m.id == w) {
            out.push(model_entry(w, None, None));
        }
    }
    out
}

/// `model = "…"` of `$CODEX_HOME/config.toml` (default `~/.codex`), top level only.
fn codex_config_model() -> Option<String> {
    let dir = std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")))?;
    let text = std::fs::read_to_string(dir.join("config.toml")).ok()?;
    parse_toml_model(&text)
}

pub fn parse_toml_model(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            break;
        }
        let rest = match t.strip_prefix("model") {
            Some(r) => r.trim_start(),
            None => continue,
        };
        let rest = match rest.strip_prefix('=') {
            Some(r) => r.trim(),
            None => continue,
        };
        let q = rest.chars().next()?;
        if q != '"' && q != '\'' {
            continue;
        }
        let body = &rest[1..];
        if let Some(end) = body.find(q) {
            let m = body[..end].trim();
            if !m.is_empty() {
                return Some(m.to_string());
            }
        }
    }
    None
}

async fn codex_models() -> AiModels {
    let error: Option<String> = match find_binary("codex") {
        None => Some("Codex CLI not found".into()),
        Some(bin) => {
            let args = vec!["debug".to_string(), "models".to_string()];
            match list_cli(&bin, &args).await {
                Ok(out) if out.ok => {
                    let models = parse_codex_models(&out.stdout);
                    if !models.is_empty() {
                        return AiModels {
                            models,
                            source: "`codex debug models`".into(),
                            error: None,
                        };
                    }
                    Some("`codex debug models` listed no models".into())
                }
                Ok(out) => Some(format!(
                    "`codex debug models` isn't available in this Codex version ({})",
                    tail(&out.stderr, 200)
                )),
                Err(e) => Some(format!("`codex debug models` failed: {}", e)),
            }
        }
    };
    let mut models: Vec<AiModel> = Vec::new();
    if let Some(m) = codex_config_model() {
        models.push(model_entry(&m, None, Some("from config.toml")));
    }
    for &(id, label) in CODEX_SUGGESTED {
        if !models.iter().any(|m| m.id == id) {
            models.push(model_entry(id, Some(label), Some("suggested")));
        }
    }
    AiModels {
        models,
        source: "Codex config + suggested models".into(),
        error,
    }
}

async fn openai_models(base_url: Option<&str>, api_key: Option<String>) -> AiModels {
    let base = base_url.unwrap_or(OPENAI_URL).to_string();
    let source = format!("{}/models", base);
    let key = match api_key {
        Some(k) => k,
        None => {
            return AiModels {
                models: Vec::new(),
                source,
                error: Some("No API key set".into()),
            }
        }
    };
    let result = fetch_openai_models(&source, &base, key).await;
    match result {
        Ok(models) => AiModels {
            models,
            source,
            error: None,
        },
        Err(e) => AiModels {
            models: Vec::new(),
            source,
            error: Some(e),
        },
    }
}

async fn fetch_openai_models(url: &str, base: &str, key: String) -> Result<Vec<AiModel>, String> {
    let client = http_client(Duration::from_secs(MODELS_CLI_SECS)).map_err(|e| e.message)?;
    let resp = client
        .get(url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("Could not reach {}: {}", base, e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "The API answered {}: {}",
            status.as_u16(),
            http_error_text(&text)
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut out: Vec<AiModel> = Vec::new();
    if let Some(list) = v.get("data").and_then(|d| d.as_array()) {
        for m in list {
            if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                if !out.iter().any(|x| x.id == id) {
                    out.push(model_entry(id, None, None));
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

//! HashiCorp Vault client: token resolution, secret fetch (KV v1 / KV v2 / dynamic) and a
//! per-connection cache for dynamic credentials. Tokens and passwords are never logged or
//! included in error messages.

use crate::error::{AppError, AppResult};
use crate::model::{VaultConfig, VaultProfile, VaultTokenInfo, VaultTokenSource};
use futures::future::BoxFuture;
use serde_json::Value;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// Cached dynamic credentials are dropped this long before the lease ends.
pub(crate) const LEASE_MARGIN: Duration = Duration::from_secs(30);

/// A secret read from Vault. Deliberately has no `Debug` impl.
pub struct VaultSecret {
    /// "kv2" | "kv1" | "dynamic"
    pub kind: &'static str,
    pub username: Option<String>,
    pub password: String,
    pub lease_secs: Option<u64>,
    pub renewable: bool,
}

/// Expands a leading `~` using HOME (or USERPROFILE on Windows).
pub fn expand_tilde(path: &str) -> String {
    let rest = if path == "~" {
        Some("")
    } else if let Some(r) = path.strip_prefix("~/") {
        Some(r)
    } else {
        path.strip_prefix("~\\")
    };
    match rest {
        Some(r) => {
            let home = std::env::var("HOME")
                .ok()
                .filter(|h| !h.is_empty())
                .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()));
            match home {
                Some(h) if r.is_empty() => h,
                Some(h) => std::path::Path::new(&h)
                    .join(r)
                    .to_string_lossy()
                    .into_owned(),
                None => path.to_string(),
            }
        }
        None => path.to_string(),
    }
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn resolve_token(
    cfg: &VaultConfig,
    keychain_token: Option<String>,
    explicit: Option<String>,
) -> AppResult<String> {
    if let Some(t) = explicit {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let token = match cfg.token_source {
        VaultTokenSource::File => {
            let path = expand_tilde(non_empty(&cfg.token_file).unwrap_or("~/.vault-token"));
            match std::fs::read_to_string(&path) {
                Ok(s) => s.trim().to_string(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(AppError::new(format!(
                        "Vault token file {} not found. Run `vault login` or pick another token source.",
                        path
                    )))
                }
                Err(e) => {
                    return Err(AppError::new(format!(
                        "Could not read Vault token file {}: {}",
                        path, e
                    )))
                }
            }
        }
        VaultTokenSource::Env => match std::env::var("VAULT_TOKEN") {
            Ok(t) => t.trim().to_string(),
            Err(_) => {
                return Err(AppError::new(
                    "The VAULT_TOKEN environment variable is not set. Pick another token source or start DataTrip from a shell that has it.",
                ))
            }
        },
        VaultTokenSource::Keychain => match keychain_token {
            Some(t) => t.trim().to_string(),
            None => {
                return Err(AppError::new(
                    "No Vault token is stored in the keychain for this connection. Enter one in the connection settings.",
                ))
            }
        },
        // The OIDC sign-in stores its token in the keychain exactly like a pasted one.
        VaultTokenSource::Oidc => match keychain_token {
            Some(t) => t.trim().to_string(),
            None => {
                return Err(AppError::new(
                    "Not signed in to Vault yet. Use \"Sign in with OIDC\" in the Vault profile.",
                ))
            }
        },
    };
    if token.is_empty() {
        let src = match cfg.token_source {
            VaultTokenSource::File => "token file",
            VaultTokenSource::Env => "VAULT_TOKEN",
            VaultTokenSource::Keychain => "keychain token",
            VaultTokenSource::Oidc => "OIDC token",
        };
        return Err(AppError::new(format!("The Vault {} is empty.", src)));
    }
    Ok(token)
}

fn resolve_address(cfg: &VaultConfig) -> AppResult<String> {
    let addr = match non_empty(&cfg.address) {
        Some(a) => a.to_string(),
        None => std::env::var("VAULT_ADDR")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AppError::new("No Vault address. Set one in the connection or define VAULT_ADDR.")
            })?,
    };
    let addr = addr.trim_end_matches('/').to_string();
    if !(addr.starts_with("http://") || addr.starts_with("https://")) {
        return Err(AppError::new(
            "The Vault address must start with http:// or https://",
        ));
    }
    Ok(addr)
}

fn normalize_path(raw: &str) -> AppResult<String> {
    let p = raw.trim().trim_start_matches('/');
    let p = p.strip_prefix("v1/").unwrap_or(p).trim_end_matches('/');
    if p.is_empty() {
        return Err(AppError::new("The Vault secret path is empty."));
    }
    Ok(p.to_string())
}

fn build_client(cfg: &VaultConfig) -> AppResult<reqwest::Client> {
    let mut b = reqwest::Client::builder().timeout(HTTP_TIMEOUT);
    if cfg.hosted {
        b = b.redirect(reqwest::redirect::Policy::none()).no_proxy();
    }
    if let Some(p) = non_empty(&cfg.ca_cert_path) {
        let path = expand_tilde(p);
        let bytes = std::fs::read(&path)
            .map_err(|e| AppError::new(format!("Could not read CA certificate {}: {}", path, e)))?;
        // VERIFY: reqwest 0.12 Certificate::from_pem(&[u8]) -> Result<Certificate>
        let cert = reqwest::Certificate::from_pem(&bytes).map_err(|e| {
            AppError::new(format!("{} is not a valid PEM certificate: {}", path, e))
        })?;
        b = b.add_root_certificate(cert);
    }
    if cfg.skip_tls_verify {
        b = b.danger_accept_invalid_certs(true);
    }
    b.build()
        .map_err(|e| AppError::new(format!("Could not set up the Vault HTTP client: {}", e)))
}

fn net_error(addr: &str, e: &reqwest::Error) -> AppError {
    if e.is_timeout() {
        return AppError::new(format!(
            "Timed out after {} s talking to Vault at {}.",
            HTTP_TIMEOUT.as_secs(),
            addr
        ));
    }
    let mut parts: Vec<String> = Vec::new();
    // VERIFY: reqwest::Error implements std::error::Error (source chain used for TLS details)
    let mut src = e.source();
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    let detail = if parts.is_empty() {
        e.to_string()
    } else {
        parts.join(": ")
    };
    AppError::new(format!("Could not reach Vault at {}: {}", addr, detail))
}

fn vault_errors(body: &Value) -> Option<String> {
    let arr = body.get("errors")?.as_array()?;
    let msgs: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
    if msgs.is_empty() {
        None
    } else {
        Some(msgs.join("; "))
    }
}

fn value_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Parses a Vault read response into a secret. Pure, so it is easy to reason about.
fn parse_secret(cfg: &VaultConfig, path: &str, body: &Value) -> AppResult<VaultSecret> {
    let data = body.get("data");
    let kv2_values = data
        .and_then(|d| d.get("data"))
        .filter(|inner| inner.is_object())
        .filter(|_| data.map(|d| d.get("metadata").is_some()).unwrap_or(false));
    let lease_id = body.get("lease_id").and_then(|v| v.as_str()).unwrap_or("");

    let (kind, values, lease_secs, renewable) = if let Some(vals) = kv2_values {
        ("kv2", vals, None, false)
    } else if !lease_id.is_empty() {
        let secs = body.get("lease_duration").and_then(|v| v.as_u64());
        let renewable = body
            .get("renewable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        match data {
            Some(d) if d.is_object() => ("dynamic", d, secs, renewable),
            _ => {
                return Err(AppError::new(format!(
                    "Vault returned no data for {}.",
                    path
                )))
            }
        }
    } else {
        match data {
            Some(d) if d.is_object() => ("kv1", d, None, false),
            _ => {
                return Err(AppError::new(format!(
                    "Vault returned no data for {}.",
                    path
                )))
            }
        }
    };

    let user_key = non_empty(&cfg.username_key).unwrap_or("username");
    let pass_key = non_empty(&cfg.password_key).unwrap_or("password");
    let username = values
        .get(user_key)
        .and_then(value_string)
        .filter(|s| !s.is_empty());
    let password = match values.get(pass_key).and_then(value_string) {
        Some(p) => p,
        None => {
            let mut keys: Vec<&str> = values
                .as_object()
                .map(|m| m.keys().map(|k| k.as_str()).collect())
                .unwrap_or_default();
            keys.sort_unstable();
            return Err(AppError::new(format!(
                "The secret at {} has no \"{}\" key (keys found: {}).",
                path,
                pass_key,
                if keys.is_empty() {
                    "none".to_string()
                } else {
                    keys.join(", ")
                }
            )));
        }
    };
    Ok(VaultSecret {
        kind,
        username,
        password,
        lease_secs,
        renewable,
    })
}

/// Reads the configured secret from Vault. `keychain_token` is the token stored for the
/// connection (used when the token source is Keychain); `explicit_token` overrides any source.
pub fn fetch<'a>(
    cfg: &'a VaultConfig,
    keychain_token: Option<String>,
    explicit_token: Option<String>,
) -> BoxFuture<'a, AppResult<VaultSecret>> {
    Box::pin(async move {
        let addr = resolve_address(cfg)?;
        let path = normalize_path(&cfg.secret_path)?;
        let token = resolve_token(cfg, keychain_token, explicit_token)?;
        let client = build_client(cfg)?;
        let url = format!("{}/v1/{}", addr, path);
        let mut req = client
            .get(url.as_str())
            .header("X-Vault-Token", token.as_str());
        if let Some(ns) = non_empty(&cfg.namespace) {
            req = req.header("X-Vault-Namespace", ns);
        }
        let resp = req.send().await.map_err(|e| net_error(&addr, &e))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| net_error(&addr, &e))?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

        if !status.is_success() {
            let detail = vault_errors(&body);
            return Err(match status.as_u16() {
                403 => AppError::new(format!(
                    "Vault denied access to {} (permission denied). Check the token's policy.",
                    path
                )),
                404 => AppError::new(format!(
                    "No secret at {}. For KV v2 the path is <mount>/data/<name>.",
                    path
                )),
                code => match detail {
                    Some(d) => AppError::new(format!("Vault error ({}): {}", code, d)),
                    None => AppError::new(format!("Vault returned HTTP {}.", code)),
                },
            });
        }
        if body.is_null() {
            return Err(AppError::new(format!(
                "Vault at {} returned an unexpected (non-JSON) response.",
                addr
            )));
        }
        if let Some(d) = vault_errors(&body) {
            return Err(AppError::new(format!("Vault error: {}", d)));
        }
        parse_secret(cfg, &path, &body)
    })
}

/// Connection-level Vault config with address / namespace / token source / TLS taken from a shared profile.
/// secret_path, username_key and password_key stay from the connection. The result has no profile_id.
pub fn merge_profile(conn: &VaultConfig, p: &VaultProfile) -> VaultConfig {
    let mut c = conn.clone();
    c.address = p.address.clone();
    c.namespace = p.namespace.clone();
    c.token_source = p.token_source;
    c.token_file = p.token_file.clone();
    c.ca_cert_path = p.ca_cert_path.clone();
    c.skip_tls_verify = p.skip_tls_verify;
    c.profile_id = None;
    c
}

/// Config for talking to Vault on behalf of a profile alone (token lookup / renew).
pub fn config_from_profile(p: &VaultProfile) -> VaultConfig {
    merge_profile(&VaultConfig::default(), p)
}

/// True when an error message from `fetch` means Vault rejected the token (HTTP 403).
pub fn is_token_rejection(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("permission denied")
        || m.contains("invalid token")
        || m.contains("denied access")
        || m.contains("token expired")
}

/// `VAULT_TOKEN_INVALID:<profileId>:<text>` - the UI parses the prefix to offer "paste new token".
pub fn token_invalid_error(profile_id: &str, profile_name: &str) -> AppError {
    AppError::new(format!(
        "VAULT_TOKEN_INVALID:{}:Token for {} is expired or invalid",
        profile_id, profile_name
    ))
}

pub enum TokenError {
    /// HTTP 403 from Vault: the token is expired, revoked or invalid.
    Invalid,
    Other(AppError),
}

impl From<AppError> for TokenError {
    fn from(e: AppError) -> Self {
        TokenError::Other(e)
    }
}

fn parse_token_info(body: &Value) -> VaultTokenInfo {
    let data = body.get("data").unwrap_or(&Value::Null);
    let policies = data
        .get("policies")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    VaultTokenInfo {
        display_name: data
            .get("display_name")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        policies,
        ttl_secs: data.get("ttl").and_then(|v| v.as_i64()).unwrap_or(0),
        expire_time: data
            .get("expire_time")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        renewable: data
            .get("renewable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

/// `auth/token/lookup-self`, optionally after `auth/token/renew-self` (empty body).
/// The token is never included in errors.
pub fn token_info<'a>(
    cfg: &'a VaultConfig,
    keychain_token: Option<String>,
    explicit_token: Option<String>,
    renew: bool,
) -> BoxFuture<'a, Result<VaultTokenInfo, TokenError>> {
    Box::pin(async move {
        let addr = resolve_address(cfg)?;
        let token = resolve_token(cfg, keychain_token, explicit_token)?;
        let client = build_client(cfg)?;
        if renew {
            let mut req = client
                .post(format!("{}/v1/auth/token/renew-self", addr))
                .header("X-Vault-Token", token.as_str());
            if let Some(ns) = non_empty(&cfg.namespace) {
                req = req.header("X-Vault-Namespace", ns);
            }
            let resp = req.send().await.map_err(|e| net_error(&addr, &e))?;
            let status = resp.status();
            if status.as_u16() == 403 {
                return Err(TokenError::Invalid);
            }
            if !status.is_success() {
                let text = resp.text().await.unwrap_or_default();
                let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                return Err(TokenError::Other(match vault_errors(&body) {
                    Some(d) => AppError::new(format!("Could not renew the Vault token: {}", d)),
                    None => AppError::new(format!(
                        "Could not renew the Vault token (HTTP {}).",
                        status.as_u16()
                    )),
                }));
            }
        }
        let mut req = client
            .get(format!("{}/v1/auth/token/lookup-self", addr))
            .header("X-Vault-Token", token.as_str());
        if let Some(ns) = non_empty(&cfg.namespace) {
            req = req.header("X-Vault-Namespace", ns);
        }
        let resp = req.send().await.map_err(|e| net_error(&addr, &e))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| net_error(&addr, &e))?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status.as_u16() == 403 {
            return Err(TokenError::Invalid);
        }
        if !status.is_success() {
            return Err(TokenError::Other(match vault_errors(&body) {
                Some(d) => AppError::new(format!("Vault error ({}): {}", status.as_u16(), d)),
                None => AppError::new(format!("Vault returned HTTP {}.", status.as_u16())),
            }));
        }
        if body.is_null() {
            return Err(TokenError::Other(AppError::new(format!(
                "Vault at {} returned an unexpected (non-JSON) response.",
                addr
            ))));
        }
        Ok(parse_token_info(&body))
    })
}

struct CachedCreds {
    username: Option<String>,
    password: String,
    expires_at: Instant,
}

/// Dynamic-secret credentials per connection id. KV secrets are never cached.
pub struct VaultCache {
    map: Mutex<HashMap<String, CachedCreds>>,
}

impl VaultCache {
    pub fn new() -> Self {
        VaultCache {
            map: Mutex::new(HashMap::new()),
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, HashMap<String, CachedCreds>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Returns (username, password) while the lease is still comfortably valid.
    #[allow(dead_code)]
    pub fn get(&self, conn_id: &str) -> Option<(Option<String>, String)> {
        self.get_with_expiry(conn_id).map(|(u, p, _)| (u, p))
    }

    /// Like `get`, plus the instant the cached credentials stop being trusted.
    pub fn get_with_expiry(&self, conn_id: &str) -> Option<(Option<String>, String, Instant)> {
        let mut m = self.guard();
        match m.get(conn_id) {
            Some(c) if c.expires_at > Instant::now() => {
                Some((c.username.clone(), c.password.clone(), c.expires_at))
            }
            Some(_) => {
                m.remove(conn_id);
                None
            }
            None => None,
        }
    }

    /// Caches a dynamic secret; no-op when the lease is missing or shorter than the safety margin.
    pub fn put(&self, conn_id: &str, secret: &VaultSecret) {
        if conn_id.is_empty() || secret.kind != "dynamic" {
            return;
        }
        let lease = Duration::from_secs(secret.lease_secs.unwrap_or(0));
        if lease <= LEASE_MARGIN {
            return;
        }
        self.guard().insert(
            conn_id.to_string(),
            CachedCreds {
                username: secret.username.clone(),
                password: secret.password.clone(),
                expires_at: Instant::now() + lease - LEASE_MARGIN,
            },
        );
    }

    pub fn invalidate(&self, conn_id: &str) {
        self.guard().remove(conn_id);
    }
}

impl Default for VaultCache {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// OIDC browser sign-in (like `vault login -method=oidc`)
// ---------------------------------------------------------------------------

/// Must be listed in the Vault role's `allowed_redirect_uris`.
pub const OIDC_REDIRECT_URI: &str = "http://localhost:8250/oidc/callback";
const OIDC_PORT: u16 = 8250;
const OIDC_TIMEOUT: Duration = Duration::from_secs(300);

/// The pending OIDC sign-in (at most one: they share port 8250), so it can be cancelled.
pub struct OidcLogins {
    pending: Mutex<Option<Arc<Notify>>>,
}

impl OidcLogins {
    pub fn new() -> Self {
        OidcLogins {
            pending: Mutex::new(None),
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, Option<Arc<Notify>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn begin(&self) -> Arc<Notify> {
        let n = Arc::new(Notify::new());
        *self.guard() = Some(n.clone());
        n
    }

    fn finish(&self, n: &Arc<Notify>) {
        let mut g = self.guard();
        if g.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, n)) {
            *g = None;
        }
    }

    /// Aborts the pending sign-in; false when none is running.
    pub fn cancel(&self) -> bool {
        let pending = self.guard().take();
        match pending {
            Some(n) => {
                // notify_one keeps a permit when the login is not waiting at this instant.
                n.notify_one();
                true
            }
            None => false,
        }
    }
}

impl Default for OidcLogins {
    fn default() -> Self {
        Self::new()
    }
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &c in s.as_bytes() {
        if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b'_' | b'~') {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{:02X}", c));
        }
    }
    out
}

fn hex_digit(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// Decodes `application/x-www-form-urlencoded` text (`+` = space, `%XX`).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() => match (hex_digit(b[i + 1]), hex_digit(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(b'%');
                    i += 1;
                }
            },
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// What the browser's request to the callback listener carried.
enum Callback {
    Code {
        code: String,
        state: String,
    },
    Failed(String),
    /// favicon.ico, probes, malformed requests: answered with 404 / 400 and ignored.
    Ignore,
}

/// Parses the request line `GET /oidc/callback?code=…&state=… HTTP/1.1`.
fn parse_callback(head: &str) -> Callback {
    let line = head.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" {
        return Callback::Ignore;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/oidc/callback" {
        return Callback::Ignore;
    }
    let mut code = String::new();
    let mut state = String::new();
    let mut error = String::new();
    let mut description = String::new();
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "code" => code = percent_decode(v),
            "state" => state = percent_decode(v),
            "error" => error = percent_decode(v),
            "error_description" => description = percent_decode(v),
            _ => {}
        }
    }
    if !code.is_empty() && !state.is_empty() {
        Callback::Code { code, state }
    } else if !error.is_empty() || !description.is_empty() {
        let msg = if description.is_empty() {
            error
        } else if error.is_empty() {
            description
        } else {
            format!("{} ({})", description, error)
        };
        Callback::Failed(msg)
    } else {
        Callback::Ignore
    }
}

fn http_page(status: &str, body: &str) -> String {
    let html = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>DataTrip</title></head>\
         <body style=\"font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;\
         justify-content:center;height:90vh;margin:0;color:#333\"><p style=\"font-size:16px\">{}</p></body></html>",
        body
    );
    format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        status,
        html.len(),
        html
    )
}

async fn read_request_head(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
            break;
        }
    }
    Ok(buf)
}

type CallbackResult = Result<(String, String), String>;

/// Answers one browser connection and reports a code/state pair (or an IdP error).
async fn handle_callback(mut stream: TcpStream, tx: mpsc::UnboundedSender<CallbackResult>) {
    use tokio::io::AsyncWriteExt;
    let head =
        match tokio::time::timeout(Duration::from_secs(10), read_request_head(&mut stream)).await {
            Ok(Ok(h)) => h,
            _ => return,
        };
    let head = String::from_utf8_lossy(&head).into_owned();
    let (response, outcome) = match parse_callback(&head) {
        Callback::Code { code, state } => (
            http_page(
                "200 OK",
                "Signed in \u{2014} you can close this tab and return to DataTrip.",
            ),
            Some(Ok((code, state))),
        ),
        Callback::Failed(msg) => (
            http_page(
                "200 OK",
                &format!(
                    "Sign-in failed: {}. You can close this tab and return to DataTrip.",
                    html_escape(&msg)
                ),
            ),
            Some(Err(format!("Vault OIDC sign-in failed: {}", msg))),
        ),
        Callback::Ignore => (http_page("404 Not Found", "Not found"), None),
    };
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    if let Some(o) = outcome {
        let _ = tx.send(o);
    }
}

/// Accepts browser connections until the callback arrives or the sign-in is cancelled.
async fn accept_callback(
    listener: TcpListener,
    cancel: Arc<Notify>,
) -> AppResult<(String, String)> {
    let (tx, mut rx) = mpsc::unbounded_channel::<CallbackResult>();
    loop {
        tokio::select! {
            _ = cancel.notified() => {
                return Err(AppError::new("OIDC_CANCELLED: The Vault sign-in was cancelled."));
            }
            got = rx.recv() => {
                match got {
                    Some(Ok(pair)) => return Ok(pair),
                    Some(Err(msg)) => return Err(AppError::new(msg)),
                    None => {}
                }
            }
            acc = listener.accept() => {
                // Browsers may open speculative connections that never send a request,
                // so every connection is answered on its own task.
                match acc {
                    Ok((stream, _)) => {
                        tokio::spawn(handle_callback(stream, tx.clone()));
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            }
        }
    }
}

/// Binds 127.0.0.1:8250. `retry`: a previous sign-in was just cancelled and may still hold it.
async fn bind_callback_port(retry: bool) -> AppResult<TcpListener> {
    let mut attempts = if retry { 30 } else { 1 };
    loop {
        match TcpListener::bind(("127.0.0.1", OIDC_PORT)).await {
            Ok(l) => return Ok(l),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                attempts -= 1;
                if attempts == 0 {
                    return Err(AppError::new(
                        "Port 8250 is in use (another vault login running?)",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => {
                return Err(AppError::new(format!(
                    "Could not listen on 127.0.0.1:{} for the OIDC callback: {}",
                    OIDC_PORT, e
                )))
            }
        }
    }
}

/// Opens a URL in the default browser without going through a shell.
pub fn open_browser(url: &str) -> AppResult<()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(url);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Inside an AppImage the browser must use the system's libraries, not the image's.
    crate::child_env::clean_std(&mut cmd);
    match cmd.spawn() {
        Ok(mut child) => {
            // Reap the launcher so it does not linger as a zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) => Err(AppError::new(format!(
            "Could not open the web browser for the Vault sign-in: {}",
            e
        ))),
    }
}

/// Reads a Vault JSON response; non-2xx statuses become errors carrying Vault's `errors`.
async fn vault_json(addr: &str, what: &str, resp: reqwest::Response) -> AppResult<Value> {
    let status = resp.status();
    let text = resp.text().await.map_err(|e| net_error(addr, &e))?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(match vault_errors(&body) {
            Some(d) => AppError::new(format!("{} failed: {}", what, d)),
            None => AppError::new(format!("{} failed (HTTP {}).", what, status.as_u16())),
        });
    }
    if let Some(d) = vault_errors(&body) {
        return Err(AppError::new(format!("{} failed: {}", what, d)));
    }
    Ok(body)
}

/// Browser sign-in with Vault's OIDC auth method. Returns the new client token (never logged).
/// `role`: explicit role, else the profile's `oidc_role`, else the mount's default role.
/// `open` shows Vault's sign-in page (an in-app window, or the default browser).
pub fn oidc_login<'a>(
    profile: &'a VaultProfile,
    role: Option<String>,
    logins: &'a OidcLogins,
    open: &'a (dyn Fn(&str) -> AppResult<()> + Send + Sync),
) -> BoxFuture<'a, AppResult<String>> {
    Box::pin(async move {
        let cfg = config_from_profile(profile);
        let addr = resolve_address(&cfg)?;
        let client = build_client(&cfg)?;
        let mount = non_empty(&profile.oidc_mount)
            .unwrap_or("oidc")
            .trim_matches('/')
            .to_string();
        let role = role
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .or_else(|| non_empty(&profile.oidc_role))
            .unwrap_or("")
            .to_string();

        // Only one sign-in can own the callback port: a new one replaces the pending one.
        let replaced = logins.cancel();
        let listener = bind_callback_port(replaced).await?;
        let cancel = logins.begin();
        let res = oidc_flow(
            &client,
            &cfg,
            &addr,
            &mount,
            &role,
            listener,
            cancel.clone(),
            open,
        )
        .await;
        logins.finish(&cancel);
        res
    })
}

async fn oidc_flow(
    client: &reqwest::Client,
    cfg: &VaultConfig,
    addr: &str,
    mount: &str,
    role: &str,
    listener: TcpListener,
    cancel: Arc<Notify>,
    open: &(dyn Fn(&str) -> AppResult<()> + Send + Sync),
) -> AppResult<String> {
    let (auth_url, nonce) =
        oidc_auth_url(client, cfg, addr, mount, role, OIDC_REDIRECT_URI).await?;
    open(&auth_url)?;

    let (code, state) =
        match tokio::time::timeout(OIDC_TIMEOUT, accept_callback(listener, cancel)).await {
            Ok(r) => r?,
            Err(_) => {
                return Err(AppError::new(
                    "OIDC_TIMEOUT: The Vault sign-in timed out after 5 minutes.",
                ))
            }
        };

    oidc_exchange(client, cfg, addr, mount, &code, &state, &nonce).await
}

pub struct VaultOidcExchange {
    cfg: VaultConfig,
    addr: String,
    mount: String,
    nonce: String,
    client: reqwest::Client,
}

impl VaultOidcExchange {
    pub async fn start(
        cfg: VaultConfig,
        profile: &VaultProfile,
        role: Option<String>,
        redirect_uri: &str,
    ) -> AppResult<(String, Self)> {
        let addr = resolve_address(&cfg)?;
        let client = build_client(&cfg)?;
        let mount = non_empty(&profile.oidc_mount)
            .unwrap_or("oidc")
            .trim_matches('/')
            .to_owned();
        let role = role
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .or_else(|| non_empty(&profile.oidc_role))
            .unwrap_or("");
        let (url, nonce) = oidc_auth_url(&client, &cfg, &addr, &mount, role, redirect_uri).await?;
        Ok((
            url,
            Self {
                cfg,
                addr,
                mount,
                nonce,
                client,
            },
        ))
    }

    pub async fn finish(self, code: &str, state: &str) -> AppResult<String> {
        oidc_exchange(
            &self.client,
            &self.cfg,
            &self.addr,
            &self.mount,
            code,
            state,
            &self.nonce,
        )
        .await
    }
}

async fn oidc_auth_url(
    client: &reqwest::Client,
    cfg: &VaultConfig,
    addr: &str,
    mount: &str,
    role: &str,
    redirect_uri: &str,
) -> AppResult<(String, String)> {
    let nonce = format!(
        "{}{}",
        hex::encode(uuid::Uuid::new_v4().as_bytes()),
        hex::encode(uuid::Uuid::new_v4().as_bytes())
    );
    let body = serde_json::json!({
        "role": role,
        "redirect_uri": redirect_uri,
        "client_nonce": nonce,
    });
    let mut req = client
        .post(format!("{}/v1/auth/{}/oidc/auth_url", addr, mount))
        .json(&body);
    if let Some(ns) = non_empty(&cfg.namespace) {
        req = req.header("X-Vault-Namespace", ns);
    }
    let resp = req.send().await.map_err(|e| net_error(addr, &e))?;
    let v = vault_json(addr, "Vault OIDC sign-in", resp).await?;
    let auth_url = v
        .get("data")
        .and_then(|d| d.get("auth_url"))
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    if auth_url.is_empty() {
        return Err(AppError::new(format!(
            "Vault returned no sign-in URL. Check the OIDC role and that its allowed_redirect_uris include {}.",
            redirect_uri
        )));
    }
    if !(auth_url.starts_with("https://") || auth_url.starts_with("http://")) {
        return Err(AppError::new(
            "Vault returned an unexpected sign-in URL (not http/https).",
        ));
    }
    Ok((auth_url, nonce))
}

async fn oidc_exchange(
    client: &reqwest::Client,
    cfg: &VaultConfig,
    addr: &str,
    mount: &str,
    code: &str,
    state: &str,
    nonce: &str,
) -> AppResult<String> {
    let url = format!(
        "{}/v1/auth/{}/oidc/callback?code={}&state={}&client_nonce={}",
        addr,
        mount,
        percent_encode(code),
        percent_encode(state),
        percent_encode(nonce)
    );
    let mut req = client.get(url.as_str());
    if let Some(ns) = non_empty(&cfg.namespace) {
        req = req.header("X-Vault-Namespace", ns);
    }
    let resp = req.send().await.map_err(|e| net_error(addr, &e))?;
    let v = vault_json(addr, "Vault OIDC sign-in", resp).await?;
    let token = v
        .get("auth")
        .and_then(|a| a.get("client_token"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(AppError::new(
            "Vault completed the OIDC sign-in but returned no token.",
        ));
    }
    Ok(token)
}

#[cfg(test)]
mod oidc_tests {
    use super::*;

    #[test]
    fn parses_callback_request_line() {
        match parse_callback(
            "GET /oidc/callback?code=a%2Fb+c&state=st_1 HTTP/1.1\r\nHost: x\r\n\r\n",
        ) {
            Callback::Code { code, state } => {
                assert_eq!(code, "a/b c");
                assert_eq!(state, "st_1");
            }
            _ => panic!("expected code"),
        }
        assert!(matches!(
            parse_callback("GET /favicon.ico HTTP/1.1\r\n\r\n"),
            Callback::Ignore
        ));
        match parse_callback(
            "GET /oidc/callback?error=access_denied&error_description=User%20cancelled HTTP/1.1",
        ) {
            Callback::Failed(m) => assert_eq!(m, "User cancelled (access_denied)"),
            _ => panic!("expected failure"),
        }
    }

    #[test]
    fn percent_round_trip() {
        let s = "a b/c?d=é&%";
        assert_eq!(percent_decode(&percent_encode(s)), s);
        assert_eq!(percent_decode("100%"), "100%");
    }
}

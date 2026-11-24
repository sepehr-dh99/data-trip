//! HashiCorp Vault client: token resolution, secret fetch (KV v1 / KV v2 / dynamic) and a
//! per-connection cache for dynamic credentials. Tokens and passwords are never logged or
//! included in error messages.

use crate::error::{AppError, AppResult};
use crate::model::{VaultConfig, VaultProfile, VaultTokenInfo, VaultTokenSource};
use futures::future::BoxFuture;
use serde_json::Value;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// Cached dynamic credentials are dropped this long before the lease ends.
const LEASE_MARGIN: Duration = Duration::from_secs(30);

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
    };
    if token.is_empty() {
        let src = match cfg.token_source {
            VaultTokenSource::File => "token file",
            VaultTokenSource::Env => "VAULT_TOKEN",
            VaultTokenSource::Keychain => "keychain token",
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
    pub fn get(&self, conn_id: &str) -> Option<(Option<String>, String)> {
        let mut m = self.guard();
        match m.get(conn_id) {
            Some(c) if c.expires_at > Instant::now() => {
                Some((c.username.clone(), c.password.clone()))
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

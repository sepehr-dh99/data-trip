//! Turns a `ConnectionConfig` into the effective (username, password) used to connect:
//! stored keychain password, or a secret read from HashiCorp Vault.
//! Every physical connect (test, open, reconnect, server-side cancel) goes through here so
//! Vault sessions always use fresh or still-valid cached credentials.

use crate::db;
use crate::error::{AppError, AppResult};
use crate::model::{AuthMethod, ConnectionConfig, Driver, VaultTokenSource};
use crate::store::Store;
use crate::vault::{self, VaultCache};
use futures::future::BoxFuture;
use std::sync::Arc;

#[derive(Clone)]
pub struct CredentialSource {
    store: Arc<Store>,
    cache: Arc<VaultCache>,
}

struct Resolved {
    config: ConnectionConfig,
    password: Option<String>,
    from_cache: bool,
}

/// Heuristic for "the database rejected the credentials" across the supported drivers.
fn looks_like_auth_failure(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("password authentication failed")
        || m.contains("authentication failed")
        || m.contains("access denied")
        || m.contains("login failed")
        || m.contains("28p01")
        || m.contains("28000")
}

impl CredentialSource {
    pub fn new(store: Arc<Store>, cache: Arc<VaultCache>) -> Self {
        CredentialSource { store, cache }
    }

    pub fn invalidate(&self, connection_id: &str) {
        self.cache.invalidate(connection_id);
    }

    fn resolve_inner<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        explicit_password: Option<String>,
        explicit_vault_token: Option<String>,
        use_cache: bool,
    ) -> BoxFuture<'a, AppResult<Resolved>> {
        Box::pin(async move {
            if cfg.auth_method != AuthMethod::Vault || cfg.driver == Driver::Sqlite {
                let pw = match explicit_password {
                    Some(p) => Some(p),
                    None => self.store.get_password(&cfg.id),
                };
                return Ok(Resolved {
                    config: cfg.clone(),
                    password: pw,
                    from_cache: false,
                });
            }
            let vcfg = match cfg.vault.as_ref() {
                Some(v) => v,
                None => {
                    return Err(AppError::new(
                        "Vault settings are missing for this connection.",
                    ))
                }
            };
            let mut out = cfg.clone();
            if use_cache {
                if let Some((user, pass)) = self.cache.get(&cfg.id) {
                    if user.is_some() {
                        out.username = user;
                    }
                    return Ok(Resolved {
                        config: out,
                        password: Some(pass),
                        from_cache: true,
                    });
                }
            }
            let keychain_token = if vcfg.token_source == VaultTokenSource::Keychain {
                self.store.get_vault_token(&cfg.id)
            } else {
                None
            };
            let secret = vault::fetch(vcfg, keychain_token, explicit_vault_token).await?;
            if use_cache {
                self.cache.put(&cfg.id, &secret);
            }
            if secret.username.is_some() {
                out.username = secret.username.clone();
            }
            Ok(Resolved {
                config: out,
                password: Some(secret.password),
                from_cache: false,
            })
        })
    }

    /// Effective config (username possibly replaced by Vault's) and password for a connect.
    #[allow(dead_code)]
    pub fn resolve<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        explicit_password: Option<String>,
    ) -> BoxFuture<'a, AppResult<(ConnectionConfig, Option<String>)>> {
        Box::pin(async move {
            let r = self
                .resolve_inner(cfg, explicit_password, None, true)
                .await?;
            Ok((r.config, r.password))
        })
    }

    /// Resolves credentials and opens a physical connection. With cached dynamic credentials,
    /// an authentication failure invalidates the cache and retries once with a fresh secret.
    /// `use_cache = false` (test connection) neither reads nor writes the cache.
    pub fn connect<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        explicit_password: Option<String>,
        explicit_vault_token: Option<String>,
        use_cache: bool,
    ) -> BoxFuture<'a, AppResult<db::Connected>> {
        Box::pin(async move {
            let r = self
                .resolve_inner(
                    cfg,
                    explicit_password.clone(),
                    explicit_vault_token.clone(),
                    use_cache,
                )
                .await?;
            let first = db::connect(&r.config, r.password.as_deref()).await;
            let retry = match &first {
                Err(e) => r.from_cache && looks_like_auth_failure(&e.message),
                Ok(_) => false,
            };
            if !retry {
                return first;
            }
            self.cache.invalidate(&cfg.id);
            let r2 = self
                .resolve_inner(cfg, explicit_password, explicit_vault_token, use_cache)
                .await?;
            db::connect(&r2.config, r2.password.as_deref()).await
        })
    }

    /// Server-side cancel on a fresh connection, using the same credential resolution.
    pub fn cancel_backend<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        backend_id: i64,
    ) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            let r = self.resolve_inner(cfg, None, None, true).await?;
            db::cancel_backend(&r.config, r.password.as_deref(), backend_id).await
        })
    }
}

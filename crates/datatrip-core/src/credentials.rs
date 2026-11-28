//! Turns a `ConnectionConfig` into the effective (username, password) used to connect:
//! stored keychain password, or a secret read from HashiCorp Vault.
//! Every physical connect (test, open, reconnect, server-side cancel) goes through here so
//! Vault sessions always use fresh or still-valid cached credentials.

use crate::db;
use crate::error::{AppError, AppResult};
use crate::model::{AuthMethod, ConnectionConfig, Driver, VaultConfig, VaultTokenSource};
use crate::profiles::Profiles;
use crate::ssh::{ForwardLease, TunnelManager};
use crate::store::Store;
use crate::vault::{self, VaultCache};
use futures::future::BoxFuture;
use std::sync::Arc;
use std::time::{Duration, Instant};

type ConnectionPolicy = dyn Fn(&ConnectionConfig) -> AppResult<ConnectionConfig> + Send + Sync;
type VaultPolicy = dyn Fn(VaultConfig) -> AppResult<VaultConfig> + Send + Sync;

#[derive(Clone)]
pub struct CredentialSource {
    store: Arc<Store>,
    cache: Arc<VaultCache>,
    profiles: Arc<Profiles>,
    tunnels: Arc<TunnelManager>,
    hosted: Option<Arc<ConnectionPolicy>>,
    vault_policy: Option<Arc<VaultPolicy>>,
    sentinel_endpoints: Option<Arc<[std::net::SocketAddr]>>,
    force_read_only: bool,
}

/// Effective Vault settings for one connection: profile values merged in, plus the keychain token.
pub struct PreparedVault {
    pub config: VaultConfig,
    pub keychain_token: Option<String>,
    /// (profile id, profile name) when the connection uses a shared profile.
    pub profile: Option<(String, String)>,
}

struct Resolved {
    config: ConnectionConfig,
    password: Option<String>,
    from_cache: bool,
    /// When dynamic Vault credentials stop being trusted (lease end minus a safety margin).
    expires_at: Option<Instant>,
}

/// Lease end minus the safety margin; short leases get half their duration.
fn lease_deadline(secret: &vault::VaultSecret) -> Option<Instant> {
    if secret.kind != "dynamic" {
        return None;
    }
    let lease = Duration::from_secs(secret.lease_secs.filter(|s| *s > 0)?);
    let usable = if lease > vault::LEASE_MARGIN * 2 {
        lease - vault::LEASE_MARGIN
    } else {
        lease / 2
    };
    Some(Instant::now() + usable)
}

/// Token sources whose token lives in the keychain (pasted, or from an OIDC sign-in).
fn uses_keychain(src: VaultTokenSource) -> bool {
    matches!(src, VaultTokenSource::Keychain | VaultTokenSource::Oidc)
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
    pub fn new(
        store: Arc<Store>,
        cache: Arc<VaultCache>,
        profiles: Arc<Profiles>,
        tunnels: Arc<TunnelManager>,
    ) -> Self {
        CredentialSource {
            store,
            cache,
            profiles,
            tunnels,
            hosted: None,
            vault_policy: None,
            sentinel_endpoints: None,
            force_read_only: false,
        }
    }

    pub fn with_hosted_policy(
        mut self,
        resolve: impl Fn(&ConnectionConfig) -> AppResult<ConnectionConfig> + Send + Sync + 'static,
        vault_policy: impl Fn(VaultConfig) -> AppResult<VaultConfig> + Send + Sync + 'static,
        sentinel_endpoints: Arc<[std::net::SocketAddr]>,
        force_read_only: bool,
    ) -> Self {
        self.hosted = Some(Arc::new(resolve));
        self.vault_policy = Some(Arc::new(vault_policy));
        self.sentinel_endpoints = Some(sentinel_endpoints);
        self.force_read_only = force_read_only;
        self
    }

    pub fn is_hosted(&self) -> bool {
        self.store.is_hosted()
    }

    pub fn enforce_read_only(&self, config: &mut ConnectionConfig) {
        config.read_only |= self.force_read_only;
    }

    pub fn authorize_vault(&self, config: VaultConfig) -> AppResult<VaultConfig> {
        match &self.vault_policy {
            Some(policy) => policy(config),
            None => Ok(config),
        }
    }

    /// Resolves the connection's Vault settings (shared profile or its own) and keychain token.
    pub fn prepare_vault<'a>(
        &'a self,
        vcfg: &'a VaultConfig,
        conn_id: &'a str,
        explicit_token: bool,
    ) -> BoxFuture<'a, AppResult<PreparedVault>> {
        Box::pin(async move {
            let pid = vcfg
                .profile_id
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty());
            match pid {
                Some(pid) => {
                    let p = self.profiles.get_vault(pid).await?;
                    let config = self.authorize_vault(vault::merge_profile(vcfg, &p))?;
                    let keychain_token = if uses_keychain(config.token_source) && !explicit_token {
                        self.profiles.vault_token(&p.id)
                    } else {
                        None
                    };
                    Ok(PreparedVault {
                        config,
                        keychain_token,
                        profile: Some((p.id, p.name)),
                    })
                }
                None => {
                    let keychain_token = if uses_keychain(vcfg.token_source) && !explicit_token {
                        self.store.get_vault_token(conn_id, vcfg)
                    } else {
                        None
                    };
                    Ok(PreparedVault {
                        config: self.authorize_vault(vcfg.clone())?,
                        keychain_token,
                        profile: None,
                    })
                }
            }
        })
    }

    /// A Vault rejection of a shared profile's token becomes `VAULT_TOKEN_INVALID:<id>:<text>`.
    pub fn map_vault_error(err: AppError, profile: &Option<(String, String)>) -> AppError {
        match profile {
            Some((id, name)) if vault::is_token_rejection(&err.message) => {
                vault::token_invalid_error(id, name)
            }
            _ => err,
        }
    }

    /// Opens a local forward when the connection uses an SSH profile; returns the config the
    /// driver should connect with (host 127.0.0.1, ephemeral local port) and the lease.
    /// With verify-full / verify-identity TLS the host name check sees 127.0.0.1 (not the DB host).
    fn tunnel_config<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
    ) -> BoxFuture<'a, AppResult<(ConnectionConfig, Option<ForwardLease>)>> {
        Box::pin(async move {
            let pid = match cfg
                .ssh_profile_id
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
            {
                Some(p) => p,
                None => return Ok((cfg.clone(), None)),
            };
            let (default_host, default_port) = match cfg.driver {
                Driver::Sqlite => return Ok((cfg.clone(), None)),
                Driver::Kafka => {
                    return Err(AppError::new(
                        "SSH tunnels are not supported for Kafka: brokers advertise their own addresses, \
                         so clients cannot be redirected through a single forward.",
                    ))
                }
                Driver::Postgres => ("localhost", 5432),
                Driver::Mysql => ("localhost", 3306),
                Driver::Mssql => ("localhost", 1433),
                Driver::Redis => ("127.0.0.1", 6379),
            };
            let host = cfg
                .host
                .as_deref()
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .unwrap_or(default_host)
                .to_string();
            let port = cfg.port.unwrap_or(default_port);
            let lease = self.tunnels.acquire(pid, &host, port).await?;
            let mut out = cfg.clone();
            out.host = Some("127.0.0.1".to_string());
            out.port = Some(lease.local_port());
            Ok((out, Some(lease)))
        })
    }

    /// Connects the driver, through the SSH tunnel when configured. The lease is stored in
    /// `Connected.tunnel` so the forward lives as long as the database connection.
    /// Redis Sentinel resolves the master itself and opens one forward per node it contacts.
    fn connect_tunneled<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        password: Option<&'a str>,
        sentinel_password: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<db::Connected>> {
        Box::pin(async move {
            let resolved;
            let cfg = if let Some(resolve) = &self.hosted {
                let mut checked = resolve(cfg)?;
                self.enforce_read_only(&mut checked);
                resolved = checked;
                &resolved
            } else {
                cfg
            };
            if self.is_hosted() && cfg.driver == Driver::Sqlite {
                return db::sqlite::connect_hosted(cfg).await;
            }
            if db::redis::is_sentinel(cfg) {
                let tunnels = cfg
                    .ssh_profile_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(|pid| (self.tunnels.as_ref(), pid));
                return db::redis::connect_sentinel(
                    cfg,
                    password,
                    sentinel_password,
                    tunnels,
                    self.sentinel_endpoints.as_deref(),
                )
                .await;
            }
            let (tcfg, lease) = self.tunnel_config(cfg).await?;
            match db::connect(&tcfg, password, self.is_hosted()).await {
                Ok(mut c) => {
                    c.tunnel = lease;
                    Ok(c)
                }
                Err(e) => {
                    if lease.is_some() {
                        let m = e.message.to_lowercase();
                        if m.contains("certificate") || m.contains("hostname") {
                            return Err(AppError::new(format!(
                                "{} (through an SSH tunnel the TLS host name check sees 127.0.0.1; \
                                 use verify-ca instead of verify-full)",
                                e.message
                            )));
                        }
                    }
                    Err(e)
                }
            }
        })
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
                    None => self.store.connection_password(cfg),
                };
                return Ok(Resolved {
                    config: cfg.clone(),
                    password: pw,
                    from_cache: false,
                    expires_at: None,
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
                if let Some((user, pass, until)) = self.cache.get_with_expiry(&cfg.id) {
                    if user.is_some() {
                        out.username = user;
                    }
                    return Ok(Resolved {
                        config: out,
                        password: Some(pass),
                        from_cache: true,
                        expires_at: Some(until),
                    });
                }
            }
            let prepared = self
                .prepare_vault(vcfg, &cfg.id, explicit_vault_token.is_some())
                .await?;
            let secret = match vault::fetch(
                &prepared.config,
                prepared.keychain_token,
                explicit_vault_token,
            )
            .await
            {
                Ok(s) => s,
                Err(e) => return Err(Self::map_vault_error(e, &prepared.profile)),
            };
            if use_cache {
                self.cache.put(&cfg.id, &secret);
            }
            if secret.username.is_some() {
                out.username = secret.username.clone();
            }
            let expires_at = lease_deadline(&secret);
            Ok(Resolved {
                config: out,
                password: Some(secret.password),
                from_cache: false,
                expires_at,
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
    #[allow(dead_code)]
    pub fn connect<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        explicit_password: Option<String>,
        explicit_vault_token: Option<String>,
        use_cache: bool,
    ) -> BoxFuture<'a, AppResult<db::Connected>> {
        Box::pin(async move {
            self.connect_with_expiry(cfg, explicit_password, explicit_vault_token, use_cache)
                .await
                .map(|(c, _)| c)
        })
    }

    /// Test connection: like `connect` without the cache; `sentinel_password` (Redis Sentinel) overrides
    /// the stored one when non-empty.
    pub fn connect_test<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        explicit_password: Option<String>,
        explicit_vault_token: Option<String>,
        sentinel_password: Option<String>,
    ) -> BoxFuture<'a, AppResult<db::Connected>> {
        Box::pin(async move {
            self.connect_full(
                cfg,
                explicit_password,
                explicit_vault_token,
                false,
                sentinel_password,
            )
            .await
            .map(|(c, _)| c)
        })
    }

    /// `connect`, plus when the credentials it used stop being valid (dynamic Vault leases only).
    pub fn connect_with_expiry<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        explicit_password: Option<String>,
        explicit_vault_token: Option<String>,
        use_cache: bool,
    ) -> BoxFuture<'a, AppResult<(db::Connected, Option<Instant>)>> {
        self.connect_full(
            cfg,
            explicit_password,
            explicit_vault_token,
            use_cache,
            None,
        )
    }

    fn connect_full<'a>(
        &'a self,
        cfg: &'a ConnectionConfig,
        explicit_password: Option<String>,
        explicit_vault_token: Option<String>,
        use_cache: bool,
        sentinel_override: Option<String>,
    ) -> BoxFuture<'a, AppResult<(db::Connected, Option<Instant>)>> {
        Box::pin(async move {
            // Sentinel password: keychain only (never from Vault), used when the sentinels need one.
            let sentinel_auth = db::redis::is_sentinel(cfg)
                && matches!(cfg.redis.as_ref(), Some(r) if r.sentinel_auth);
            let sentinel_pw = if sentinel_auth {
                sentinel_override
                    .filter(|p| !p.is_empty())
                    .or_else(|| self.store.get_sentinel_password(cfg))
            } else {
                None
            };
            let r = self
                .resolve_inner(
                    cfg,
                    explicit_password.clone(),
                    explicit_vault_token.clone(),
                    use_cache,
                )
                .await?;
            let first = self
                .connect_tunneled(&r.config, r.password.as_deref(), sentinel_pw.as_deref())
                .await;
            let retry = match &first {
                Err(e) => r.from_cache && looks_like_auth_failure(&e.message),
                Ok(_) => false,
            };
            if !retry {
                return first.map(|c| (c, r.expires_at));
            }
            self.cache.invalidate(&cfg.id);
            let r2 = self
                .resolve_inner(cfg, explicit_password, explicit_vault_token, use_cache)
                .await?;
            let c = self
                .connect_tunneled(&r2.config, r2.password.as_deref(), sentinel_pw.as_deref())
                .await?;
            Ok((c, r2.expires_at))
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
            let config = match &self.hosted {
                Some(resolve) => resolve(&r.config)?,
                None => r.config,
            };
            let (tcfg, _lease) = self.tunnel_config(&config).await?;
            db::cancel_backend(&tcfg, r.password.as_deref(), backend_id, self.is_hosted()).await
        })
    }
}

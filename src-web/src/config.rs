use anyhow::{bail, Context, Result};
use argon2::{password_hash::PasswordHash, Params};
use serde::Deserialize;
use std::{collections::HashSet, net::SocketAddr, path::PathBuf};
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub bind: SocketAddr,
    pub public_origin: Url,
    pub data_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub auth: Auth,
    pub database_endpoints: Vec<SocketAddr>,
    #[serde(default)]
    pub read_only: bool,
    /// Enable only when every network connection from the runtime is filtered at deployment.
    #[serde(default)]
    pub kafka_network_policy: bool,
    #[serde(default)]
    pub vault_servers: Vec<Url>,
    #[serde(default)]
    pub ssh_endpoints: Vec<SocketAddr>,
    pub openai_url: Option<Url>,
    pub ollama_url: Option<Url>,
    #[serde(default = "session_seconds")]
    pub session_seconds: u64,
    #[serde(default = "idle_seconds")]
    pub idle_seconds: u64,
    #[serde(default = "drain_seconds")]
    pub drain_seconds: u64,
    pub workspace_key_env: String,
}

fn session_seconds() -> u64 {
    8 * 60 * 60
}
fn drain_seconds() -> u64 {
    15
}

fn idle_seconds() -> u64 {
    900
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    #[serde(default)]
    pub anonymous: bool,
    pub local: Option<Local>,
    pub oidc: Option<Oidc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Local {
    pub users: Vec<User>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct User {
    pub id: String,
    pub username: String,
    pub password_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Oidc {
    pub issuer: String,
    pub client_id: String,
    pub client_secret_env: Option<String>,
}

impl Config {
    pub fn load(path: &str) -> Result<(Self, [u8; 32])> {
        let mut config: Self = serde_yaml::from_slice(
            &std::fs::read(path).context("Read web config")?,
        )
        .map_err(|_| anyhow::anyhow!("Invalid web config; check required fields and types"))?;
        // Store and import paths must remain literal even when the operator changes CWD.
        let cwd = std::env::current_dir()?;
        config.data_dir = cwd.join(&config.data_dir);
        config.assets_dir = cwd.join(&config.assets_dir);
        let origin = &config.public_origin;
        let local = origin.host_str() == Some("localhost")
            || origin.host_str().is_some_and(|h| {
                h.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
            });
        if !(origin.scheme() == "https" || (origin.scheme() == "http" && local))
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            bail!("publicOrigin must be an HTTPS origin or loopback HTTP origin");
        }
        if !(30..=86_400).contains(&config.session_seconds)
            || !(30..=3600).contains(&config.idle_seconds)
            || !(1..=60).contains(&config.drain_seconds)
        {
            bail!("Invalid session or drain lifetime");
        }
        if !config.auth.anonymous && config.auth.local.is_none() && config.auth.oidc.is_none() {
            bail!("Enable at least one authentication method");
        }
        if [
            "PGUSER",
            "PGPASSWORD",
            "PGDATABASE",
            "PGSSLROOTCERT",
            "PGSSLCERT",
            "PGSSLKEY",
            "PGOPTIONS",
        ]
        .iter()
        .any(|name| std::env::var_os(name).is_some())
        {
            bail!(
                "Remove inherited PostgreSQL credentials/options from the web server environment"
            );
        }
        for url in config
            .vault_servers
            .iter()
            .chain(config.openai_url.iter())
            .chain(config.ollama_url.iter())
        {
            if !matches!(url.scheme(), "http" | "https")
                || url.host().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                bail!("Invalid Vault or AI endpoint configuration");
            }
        }
        if let Some(local) = &config.auth.local {
            let mut ids = HashSet::new();
            let mut usernames = HashSet::new();
            if local.users.is_empty() || local.users.len() > 256 {
                bail!("Configure between 1 and 256 local users");
            }
            for user in &local.users {
                let hash = PasswordHash::new(&user.password_hash).ok();
                let valid = hash.as_ref().is_some_and(|hash| {
                    hash.algorithm.as_str() == "argon2id"
                        && hash.version == Some(19)
                        && hash.salt.is_some()
                        && hash.hash.is_some()
                        && Params::try_from(hash).is_ok_and(|p| {
                            (19_456..=131_072).contains(&p.m_cost())
                                && (2..=6).contains(&p.t_cost())
                                && p.p_cost() <= 4
                        })
                });
                if !valid
                    || user.id.is_empty()
                    || user.id.len() > 128
                    || user.username.trim() != user.username
                    || user.username.is_empty()
                    || user.username.len() > 128
                    || !ids.insert(&user.id)
                    || !usernames.insert(&user.username)
                {
                    bail!("Invalid local account configuration: require unique IDs, usernames and bounded Argon2id hashes");
                }
            }
        }
        let key = std::env::var(&config.workspace_key_env)
            .ok()
            .and_then(|key| hex::decode(key).ok())
            .and_then(|key| key.try_into().ok())
            .context("Workspace key environment variable must hold 32 hex-encoded bytes")?;
        Ok((config, key))
    }
}

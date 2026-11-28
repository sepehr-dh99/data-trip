//! Native operations and state shared by the desktop and headless runtimes.

pub mod ai;
pub mod child_env;
pub mod commands;
pub mod credentials;
pub mod db;
pub mod ddl;
pub mod ddlgen;
pub mod error;
pub mod export;
pub mod federation;
pub mod fedsql;
pub mod import;
pub mod model;
pub mod profiles;
pub mod session;
pub mod sqlfile;
pub mod ssh;
pub mod store;
pub mod vault;
pub use datatrip_import_format as importfmt;

use std::{path::Path, sync::Arc};

pub struct AppState {
    pub store: Arc<store::Store>,
    pub vault_cache: Arc<vault::VaultCache>,
    pub creds: credentials::CredentialSource,
    pub sessions: session::SessionRegistry,
    pub profiles: Arc<profiles::Profiles>,
    pub tunnels: Arc<ssh::TunnelManager>,
    pub oidc: vault::OidcLogins,
}

impl AppState {
    pub async fn open(config_dir: &Path, data_dir: &Path) -> error::AppResult<Self> {
        let store = Arc::new(store::Store::open(config_dir, data_dir).await?);
        let profiles = Arc::new(profiles::Profiles::new(config_dir, store.clone()));
        Ok(Self::with_store(store, profiles, data_dir))
    }

    pub fn with_store(
        store: Arc<store::Store>,
        profiles: Arc<profiles::Profiles>,
        data_dir: &Path,
    ) -> Self {
        let tunnels = Arc::new(ssh::TunnelManager::new(profiles.clone(), data_dir));
        Self::with_tunnels(store, profiles, tunnels)
    }

    pub fn with_tunnels(
        store: Arc<store::Store>,
        profiles: Arc<profiles::Profiles>,
        tunnels: Arc<ssh::TunnelManager>,
    ) -> Self {
        let vault_cache = Arc::new(vault::VaultCache::new());
        let creds = credentials::CredentialSource::new(
            store.clone(),
            vault_cache.clone(),
            profiles.clone(),
            tunnels.clone(),
        );
        Self {
            store,
            vault_cache,
            creds,
            sessions: session::SessionRegistry::new(),
            profiles,
            tunnels,
            oidc: vault::OidcLogins::new(),
        }
    }
}

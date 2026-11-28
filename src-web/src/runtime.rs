use crate::{
    auth::{self, OidcClient, PendingOidc},
    config::Config,
};
use anyhow::{bail, Context, Result};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use datatrip_core::{
    error::AppError,
    profiles::Profiles,
    ssh::{KnownHosts, TunnelManager},
    store::Store,
    AppState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Weak},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;

pub struct WebError(StatusCode, AppError);
pub type WebResult<T> = std::result::Result<T, WebError>;

impl WebError {
    pub fn new(status: StatusCode, message: &str) -> Self {
        Self(status, AppError::new(message))
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "Your DataTrip session has ended")
    }
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not access the workspace",
        )
    }
}

impl From<AppError> for WebError {
    fn from(error: AppError) -> Self {
        Self(StatusCode::BAD_REQUEST, error)
    }
}

impl IntoResponse for WebError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Owner {
    Local { id: String },
    Oidc { issuer: String, subject: String },
    Guest { id: Uuid },
}

#[derive(Serialize, Deserialize)]
struct WorkspaceMetadata {
    owner: Owner,
    id: Uuid,
}

pub struct Workspace {
    pub id: Uuid,
    pub dir: PathBuf,
    pub guest: bool,
    pub mutating_connections: Mutex<()>,
    pub file_writes: Mutex<()>,
    pub jobs: Semaphore,
    store: Arc<Store>,
    profiles: Arc<Profiles>,
    known_hosts: Arc<KnownHosts>,
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if self.guest {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
}

pub struct BrowserSession {
    pub workspace: Arc<Workspace>,
    pub binding: Uuid,
    pub expires: Instant,
    pub core: AppState,
    pub jobs: Semaphore,
    pub events_permits: Arc<Semaphore>,
    pub download_permits: Arc<Semaphore>,
    pub opening: Mutex<()>,
    pub runs: crate::jobs::Runs,
    pub sql_runs: datatrip_core::sqlfile::SqlFileRuns,
    pub import_runs: datatrip_core::import::ImportRuns,
    pub ai: datatrip_core::ai::AiState,
    pub vault_oidc: crate::vault_oidc::Flow,
}

impl BrowserSession {
    async fn close(&self) {
        self.jobs.close();
        self.runs.stop.cancel();
        let _ = datatrip_core::ai::ai_cancel(&self.ai).await;
        self.vault_oidc.cancel().await;
        let _opening = self.opening.lock().await;
        futures::future::join_all(self.core.sessions.take_all().iter().map(|s| s.close())).await;
        let _write = self.workspace.file_writes.lock().await;
        crate::files::clean_outputs(&self.workspace.dir, Some(self.binding));
    }
}

pub struct Runtime {
    pub config: Config,
    pub origin: String,
    pub oidc: Option<OidcClient>,
    pub oidc_pending: Mutex<HashMap<Uuid, PendingOidc>>,
    pub login_attempts: Mutex<HashMap<String, (Instant, u8)>>,
    pub login_workers: Arc<Semaphore>,
    pub draining: AtomicBool,
    sessions: Mutex<HashMap<Uuid, Arc<BrowserSession>>>,
    workspaces: Mutex<HashMap<PathBuf, Weak<Workspace>>>,
    key: [u8; 32],
    _volume_lock: File,
}

impl Runtime {
    pub async fn open(config: Config, key: [u8; 32]) -> Result<Arc<Self>> {
        let oidc = auth::discover(&config).await?;
        fs::create_dir_all(&config.data_dir).context("Create web data directory")?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(config.data_dir.join("instance.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .context("Another DataTrip server owns this volume")?;
        let guests = config.data_dir.join("guests");
        match fs::remove_dir_all(&guests) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).context("Clean up old guest workspaces"),
        }
        private_directory(&guests)?;
        private_directory(&config.data_dir.join("workspaces"))?;
        let runtime = Arc::new(Self {
            origin: config.public_origin.origin().ascii_serialization(),
            config,
            key,
            oidc,
            oidc_pending: Mutex::new(HashMap::new()),
            login_attempts: Mutex::new(HashMap::new()),
            login_workers: Arc::new(Semaphore::new(4)),
            draining: AtomicBool::new(false),
            sessions: Mutex::new(HashMap::new()),
            workspaces: Mutex::new(HashMap::new()),
            _volume_lock: lock,
        });
        let weak = Arc::downgrade(&runtime);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            loop {
                interval.tick().await;
                let Some(runtime) = weak.upgrade() else { break };
                runtime.expire().await;
            }
        });
        Ok(runtime)
    }

    async fn workspace(&self, owner: Owner) -> Result<Arc<Workspace>> {
        let guest = matches!(owner, Owner::Guest { .. });
        let hash = hex::encode(Sha256::digest(serde_json::to_vec(&owner)?));
        let dir = self
            .config
            .data_dir
            .join(if guest { "guests" } else { "workspaces" })
            .join(hash);
        let mut workspaces = self.workspaces.lock().await;
        if let Some(workspace) = workspaces.get(&dir).and_then(Weak::upgrade) {
            return Ok(workspace);
        }
        let (metadata, created) = workspace_metadata(&dir, owner)?;
        crate::files::clean_outputs(&dir, None);
        let store = match Store::open_hosted(&dir, &self.key, metadata.id.to_string()).await {
            Ok(store) => Arc::new(store),
            Err(e) => {
                if guest && created {
                    let _ = fs::remove_dir_all(&dir);
                }
                return Err(e.into());
            }
        };
        let workspace = Arc::new(Workspace {
            id: metadata.id,
            guest,
            profiles: Arc::new(Profiles::new(&dir, store.clone())),
            store,
            dir: dir.clone(),
            mutating_connections: Mutex::new(()),
            file_writes: Mutex::new(()),
            jobs: Semaphore::new(16),
            known_hosts: Arc::new(KnownHosts::load_for(&dir, false)),
        });
        workspaces.retain(|_, workspace| workspace.strong_count() != 0);
        workspaces.insert(dir, Arc::downgrade(&workspace));
        Ok(workspace)
    }

    pub async fn login(
        &self,
        old: Option<Uuid>,
        owner: Owner,
    ) -> WebResult<(Uuid, Arc<BrowserSession>)> {
        let mut sessions = self.sessions.lock().await;
        if self.draining.load(std::sync::atomic::Ordering::Acquire) || sessions.len() >= 256 {
            return Err(WebError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Session limit reached",
            ));
        }
        let workspace = self
            .workspace(owner)
            .await
            .map_err(|_| WebError::internal())?;
        if sessions
            .iter()
            .filter(|(token, session)| Some(**token) != old && session.workspace.id == workspace.id)
            .count()
            >= 4
        {
            return Err(WebError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Workspace sign-in limit reached",
            ));
        }
        let ssh_dir = workspace.dir.clone();
        let ssh_endpoints = self.config.ssh_endpoints.clone();
        let tunnels = Arc::new(TunnelManager::with_policy(
            workspace.profiles.clone(),
            workspace.known_hosts.clone(),
            Some(Arc::new(move |profile| {
                ssh_profile_files(&ssh_dir, &ssh_endpoints, profile)
            })),
        ));
        let mut core =
            AppState::with_tunnels(workspace.store.clone(), workspace.profiles.clone(), tunnels);
        let dir = workspace.dir.clone();
        let vault_dir = dir.clone();
        let vault_servers = self.config.vault_servers.clone();
        core.creds = core.creds.with_hosted_policy(
            move |config| crate::files::database_files(&dir, config),
            move |mut config| {
                use datatrip_core::model::VaultTokenSource;
                let url = config
                    .address
                    .as_deref()
                    .and_then(|address| url::Url::parse(address).ok());
                if !url.is_some_and(|url| vault_servers.contains(&url))
                    || !matches!(
                        config.token_source,
                        VaultTokenSource::Keychain | VaultTokenSource::Oidc
                    )
                {
                    return Err(AppError::new(
                        "Hosted Vault requires an approved server and a workspace token",
                    ));
                }
                config.ca_cert_path = config
                    .ca_cert_path
                    .as_deref()
                    .map(|reference| crate::files::material(&vault_dir, reference))
                    .transpose()?;
                config.hosted = true;
                Ok(config)
            },
            self.config.database_endpoints.clone().into(),
            self.config.read_only,
        );
        let token = Uuid::new_v4();
        let provider_url = |url: &Option<url::Url>| {
            url.as_ref()
                .map(|url| url.as_str().trim_end_matches('/').to_owned())
        };
        let ai = datatrip_core::ai::AiState::hosted(
            workspace.store.clone(),
            provider_url(&self.config.openai_url),
            provider_url(&self.config.ollama_url),
        );
        let session = Arc::new(BrowserSession {
            workspace,
            binding: Uuid::new_v4(),
            expires: Instant::now() + Duration::from_secs(self.config.session_seconds),
            core,
            jobs: Semaphore::new(8),
            events_permits: Arc::new(Semaphore::new(4)),
            download_permits: Arc::new(Semaphore::new(2)),
            opening: Mutex::new(()),
            runs: Default::default(),
            sql_runs: Default::default(),
            import_runs: Default::default(),
            ai,
            vault_oidc: Default::default(),
        });
        let previous = old.and_then(|token| sessions.remove(&token));
        sessions.insert(token, session.clone());
        drop(sessions);
        if let Some(previous) = previous {
            previous.close().await;
        }
        Ok((token, session))
    }

    pub async fn session(&self, token: Option<Uuid>) -> Option<Arc<BrowserSession>> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(&token?)
            .filter(|s| s.expires > Instant::now())
            .cloned()
    }

    pub async fn authorized(&self, headers: &HeaderMap) -> WebResult<Arc<BrowserSession>> {
        let session = self
            .session(auth::cookie(headers, auth::SESSION))
            .await
            .ok_or_else(WebError::unauthorized)?;
        let binding = headers
            .get("x-datatrip-session")
            .and_then(|h| h.to_str().ok())
            .and_then(|value| Uuid::parse_str(value).ok());
        if binding != Some(session.binding) {
            return Err(WebError::unauthorized());
        }
        Ok(session)
    }

    pub async fn logout(&self, token: Uuid) {
        let session = self.sessions.lock().await.remove(&token);
        if let Some(session) = session {
            session.close().await;
        }
    }

    async fn expire(&self) {
        let now = Instant::now();
        let (expired, active) = {
            let mut sessions = self.sessions.lock().await;
            let expired: Vec<_> = sessions
                .iter()
                .filter_map(|(id, s)| (s.expires <= now).then_some(*id))
                .collect();
            let expired = expired
                .into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect::<Vec<_>>();
            (expired, sessions.values().cloned().collect::<Vec<_>>())
        };
        self.oidc_pending
            .lock()
            .await
            .retain(|_, p| p.expires > now);
        self.login_attempts
            .lock()
            .await
            .retain(|_, (expires, _)| *expires > now);
        futures::future::join_all(expired.iter().map(|s| s.close())).await;
        let limit = Duration::from_secs(self.config.idle_seconds);
        let idle: Vec<_> = active
            .iter()
            .flat_map(|s| s.core.sessions.take_idle(limit))
            .collect();
        futures::future::join_all(idle.iter().map(|s| async {
            let _ = tokio::time::timeout(Duration::from_secs(2), s.close()).await;
        }))
        .await;
    }

    pub async fn shutdown(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().await);
        futures::future::join_all(sessions.values().map(|s| s.close())).await;
    }
}

pub fn ssh_profile_files(
    dir: &Path,
    endpoints: &[std::net::SocketAddr],
    profile: &datatrip_core::model::SshProfile,
) -> datatrip_core::error::AppResult<datatrip_core::model::SshProfile> {
    let endpoint = profile
        .host
        .parse::<std::net::IpAddr>()
        .ok()
        .map(|ip| std::net::SocketAddr::new(ip, profile.port.unwrap_or(22)));
    if !endpoint.is_some_and(|address| endpoints.contains(&address)) {
        return Err(AppError::new(
            "SSH server is outside the instance's allowed endpoints",
        ));
    }
    let mut profile = profile.clone();
    profile.private_key_path = profile
        .private_key_path
        .as_deref()
        .map(|reference| crate::files::material(dir, reference))
        .transpose()?;
    Ok(profile)
}

fn workspace_metadata(dir: &Path, owner: Owner) -> Result<(WorkspaceMetadata, bool)> {
    private_directory(dir)?;
    let path = dir.join("owner.json");
    match fs::read(&path) {
        Ok(bytes) => {
            let metadata: WorkspaceMetadata = serde_json::from_slice(&bytes)?;
            if metadata.owner != owner {
                bail!("Workspace owner mismatch");
            }
            Ok((metadata, false))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let metadata = WorkspaceMetadata {
                owner,
                id: Uuid::new_v4(),
            };
            let temporary = path.with_extension("tmp");
            fs::write(&temporary, serde_json::to_vec(&metadata)?)?;
            fs::rename(temporary, path)?;
            Ok((metadata, true))
        }
        Err(error) => Err(error.into()),
    }
}

fn private_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

//! SSH tunnels (russh 0.45 + russh-keys 0.45).
//!
//! * `KnownHosts`: trusted host keys in `<data>/known_hosts.json` ("host:port" -> "SHA256:..."), plus a
//!   read-only look at `~/.ssh/known_hosts`.
//! * `TunnelManager`: one SSH client session per profile (re-opened transparently when it drops) and local
//!   forwards `127.0.0.1:<ephemeral>` -> target host:port, keyed by (profile, host, port) and reference
//!   counted through `ForwardLease`. The listener closes when the count reaches zero; the SSH session is
//!   closed after 60 s without any forward.
//!
//! Secrets (key passphrase / password) come from the keychain via `Profiles` and are never logged or put
//! into error messages.

use crate::error::{AppError, AppResult};
use crate::model::{SshCheck, SshProfile};
use crate::profiles::{write_json_atomic, Profiles};
use crate::vault::expand_tilde;
use async_trait::async_trait;
use futures::future::BoxFuture;
use russh::client::{self, Handle};
use russh_keys::key;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_CLOSE: Duration = Duration::from_secs(60);
const DEFAULT_KEEPALIVE_SECS: u64 = 30;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// Host keys
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostStatus {
    Trusted,
    New,
    Changed,
}

impl HostStatus {
    fn as_str(self) -> &'static str {
        match self {
            HostStatus::Trusted => "trusted",
            HostStatus::New => "new",
            HostStatus::Changed => "changed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct HostKeyReport {
    /// "SHA256:<base64, no padding>"
    pub fingerprint: String,
    pub key_type: String,
    pub status: HostStatus,
}

pub struct KnownHosts {
    path: PathBuf,
    map: Mutex<HashMap<String, String>>,
    consult_openssh: bool,
}

impl KnownHosts {
    pub fn load(data_dir: &std::path::Path) -> Self {
        Self::load_for(data_dir, true)
    }

    pub fn load_for(data_dir: &std::path::Path, consult_openssh: bool) -> Self {
        let path = data_dir.join("known_hosts.json");
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<HashMap<String, String>>(&t).ok())
            .unwrap_or_default();
        KnownHosts {
            path,
            map: Mutex::new(map),
            consult_openssh,
        }
    }

    fn key(host: &str, port: u16) -> String {
        format!("{}:{}", host.trim().to_lowercase(), port)
    }

    /// Stores or replaces the trusted fingerprint for host:port.
    pub fn trust(&self, host: &str, port: u16, fingerprint: &str) -> AppResult<()> {
        let fp = fingerprint.trim();
        if !fp.starts_with("SHA256:") || fp.len() < 12 {
            return Err(AppError::new(
                "The fingerprint must look like SHA256:<base64>.",
            ));
        }
        let mut m = lock(&self.map);
        m.insert(Self::key(host, port), fp.to_string());
        write_json_atomic(&self.path, &*m)
    }

    fn status(&self, host: &str, port: u16, fp: &str, pubkey: &key::PublicKey) -> HostStatus {
        let stored = lock(&self.map).get(&Self::key(host, port)).cloned();
        if stored.as_deref() == Some(fp) {
            return HostStatus::Trusted;
        }
        // Read-only look at the OpenSSH file (handles hashed entries and [host]:port).
        // VERIFY: russh_keys::check_known_hosts_path(host, port, &PublicKey, path) -> Result<bool, Error>;
        // Ok(true) = match, Ok(false) = unknown host, Err(Error::KeyChanged{..}) = different key.
        let mut openssh_changed = false;
        if let Some(p) = self.consult_openssh.then(openssh_known_hosts).flatten() {
            match russh_keys::check_known_hosts_path(host, port, pubkey, p) {
                Ok(true) => return HostStatus::Trusted,
                Ok(false) => {}
                Err(russh_keys::Error::KeyChanged { .. }) => openssh_changed = true,
                Err(_) => {}
            }
        }
        if stored.is_some() || openssh_changed {
            HostStatus::Changed
        } else {
            HostStatus::New
        }
    }
}

fn openssh_known_hosts() -> Option<PathBuf> {
    let p = PathBuf::from(expand_tilde("~/.ssh/known_hosts"));
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

fn host_key_error(host: &str, port: u16, r: &HostKeyReport) -> AppError {
    let code = if r.status == HostStatus::Changed {
        "SSH_HOST_CHANGED"
    } else {
        "SSH_HOST_UNKNOWN"
    };
    AppError::new(format!(
        "{}:{}:{}:{}:{}",
        code, host, port, r.fingerprint, r.key_type
    ))
}

// ---------------------------------------------------------------------------
// russh client
// ---------------------------------------------------------------------------

struct ClientHandler {
    host: String,
    port: u16,
    known: Arc<KnownHosts>,
    report: Arc<Mutex<Option<HostKeyReport>>>,
}

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    // VERIFY: russh 0.45 Handler uses #[async_trait] and `&key::PublicKey` (russh_keys::key::PublicKey).
    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // VERIFY: PublicKey::fingerprint() is base64(SHA-256(blob)) without padding and without prefix.
        let fp = format!("SHA256:{}", server_public_key.fingerprint());
        let status = self
            .known
            .status(&self.host, self.port, &fp, server_public_key);
        // VERIFY: PublicKey::name() returns the algorithm name, e.g. "ssh-ed25519".
        *lock(&self.report) = Some(HostKeyReport {
            fingerprint: fp,
            key_type: server_public_key.name().to_string(),
            status,
        });
        // Anything but a trusted key aborts the handshake (russh reports UnknownKey).
        Ok(status == HostStatus::Trusted)
    }
}

struct SshConn {
    handle: Handle<ClientHandler>,
}

enum Opened {
    Ready(SshConn, HostKeyReport),
    /// Host key not trusted: handshake aborted before authentication.
    HostKey(HostKeyReport),
}

fn disconnect(conn: Arc<SshConn>) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        // VERIFY: Handle::disconnect(Disconnect, &str, &str) -> Result<(), Error>.
        let _ = conn
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    })
}

/// Connects, checks the host key and (only when trusted) authenticates.
fn open_session<'a>(
    known: Arc<KnownHosts>,
    profile: &'a SshProfile,
    secret: Option<String>,
) -> BoxFuture<'a, AppResult<Opened>> {
    Box::pin(async move {
        let host = profile.host.trim().to_string();
        let port = profile.port.unwrap_or(22);
        let keepalive = profile.keepalive_secs.unwrap_or(DEFAULT_KEEPALIVE_SECS);

        let mut config = client::Config::default();
        if keepalive > 0 {
            config.keepalive_interval = Some(Duration::from_secs(keepalive));
            config.keepalive_max = 3;
        }
        // The keep-alive keeps an idle tunnel open; do not let russh's inactivity timer close it.
        config.inactivity_timeout = None;

        let report: Arc<Mutex<Option<HostKeyReport>>> = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            host: host.clone(),
            port,
            known,
            report: report.clone(),
        };
        // VERIFY: client::connect(Arc<Config>, impl ToSocketAddrs, Handler) -> Result<Handle<H>, H::Error>.
        let res = tokio::time::timeout(
            CONNECT_TIMEOUT,
            client::connect(Arc::new(config), (host.as_str(), port), handler),
        )
        .await;
        let reported = lock(&report).clone();
        let mut handle = match res {
            Err(_) => {
                return Err(AppError::new(format!(
                    "Timed out connecting to SSH host {}:{}.",
                    host, port
                )))
            }
            Ok(Err(e)) => {
                if let Some(r) = reported {
                    if r.status != HostStatus::Trusted {
                        return Ok(Opened::HostKey(r));
                    }
                }
                return Err(AppError::new(format!(
                    "Could not connect to SSH host {}:{}: {}",
                    host, port, e
                )));
            }
            Ok(Ok(h)) => h,
        };
        let reported = match reported {
            Some(r) if r.status == HostStatus::Trusted => r,
            Some(r) => return Ok(Opened::HostKey(r)),
            None => return Err(AppError::new("The SSH server sent no host key.")),
        };

        let user = profile.user.trim().to_string();
        if user.is_empty() {
            return Err(AppError::new("The SSH user name is empty."));
        }
        let secret = secret.filter(|s| !s.is_empty());
        let method = profile.auth_method.as_deref().unwrap_or("key");
        let authenticated = match method {
            "password" => {
                let pw = secret.ok_or_else(|| {
                    AppError::new("No SSH password is stored for this configuration.")
                })?;
                // VERIFY: 0.45 returns Result<bool>; 0.46+ returns Result<AuthResult> (use .success()).
                handle
                    .authenticate_password(user, pw)
                    .await
                    .map_err(|e| AppError::new(format!("SSH authentication error: {}", e)))?
            }
            "agent" => {
                // VERIFY: could be implemented with russh_keys::agent::client::AgentClient::connect_env()
                // + request_identities() + Handle::authenticate_future(); left out until verified.
                return Err(AppError::new(
                    "SSH agent authentication is not supported yet. Use a private key file or a password.",
                ));
            }
            _ => {
                let path = profile
                    .private_key_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(expand_tilde)
                    .ok_or_else(|| {
                        AppError::new("Choose a private key file for this SSH configuration.")
                    })?;
                let path_for_err = path.clone();
                let passphrase = secret;
                // Decrypting the key (bcrypt KDF) is CPU-heavy: keep it off the async threads.
                // VERIFY: russh_keys::load_secret_key(path, Option<&str>) -> Result<key::KeyPair, Error>.
                let key = tokio::task::spawn_blocking(move || {
                    russh_keys::load_secret_key(&path, passphrase.as_deref())
                })
                .await
                .map_err(|e| AppError::new(format!("Could not load the SSH key: {}", e)))?
                .map_err(|e| {
                    let m = e.to_string();
                    if m.to_lowercase().contains("encrypted") {
                        AppError::new(format!(
                            "The private key {} is encrypted. Save its passphrase in the SSH configuration.",
                            path_for_err
                        ))
                    } else {
                        AppError::new(format!(
                            "Could not load the private key {}: {}",
                            path_for_err, m
                        ))
                    }
                })?;
                // VERIFY: 0.45 authenticate_publickey(user, Arc<KeyPair>) -> Result<bool>;
                // 0.46+ takes PrivateKeyWithHashAlg and returns AuthResult.
                handle
                    .authenticate_publickey(user, Arc::new(key))
                    .await
                    .map_err(|e| AppError::new(format!("SSH authentication error: {}", e)))?
            }
        };
        if !authenticated {
            return Err(AppError::new(format!(
                "The SSH server {}:{} rejected the credentials for {}.",
                host, port, profile.user
            )));
        }
        Ok(Opened::Ready(SshConn { handle }, reported))
    })
}

// ---------------------------------------------------------------------------
// Tunnel manager
// ---------------------------------------------------------------------------

type ForwardKey = (String, String, u16);
type Slot = Arc<tokio::sync::Mutex<Option<Arc<SshConn>>>>;

struct ForwardEntry {
    local_port: u16,
    refs: usize,
    shutdown: watch::Sender<bool>,
}

struct Inner {
    profiles: Arc<Profiles>,
    known: Arc<KnownHosts>,
    slots: Mutex<HashMap<String, Slot>>,
    forwards: Mutex<HashMap<ForwardKey, ForwardEntry>>,
    /// Bumped on every release that leaves a profile without forwards; guards the idle timer.
    epochs: Mutex<HashMap<String, u64>>,
    create_lock: tokio::sync::Mutex<()>,
    profile_policy: Option<Arc<ProfilePolicy>>,
}

type ProfilePolicy = dyn Fn(&SshProfile) -> AppResult<SshProfile> + Send + Sync;

impl Inner {
    fn authorized_profile(&self, profile: &SshProfile) -> AppResult<SshProfile> {
        match &self.profile_policy {
            Some(policy) => policy(profile),
            None => Ok(profile.clone()),
        }
    }

    fn slot(&self, pid: &str) -> Slot {
        lock(&self.slots)
            .entry(pid.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone()
    }

    /// The live SSH session for the profile, (re)connecting when missing or dropped.
    fn ensure_conn(self: Arc<Self>, pid: String) -> BoxFuture<'static, AppResult<Arc<SshConn>>> {
        Box::pin(async move {
            let slot = self.slot(&pid);
            let mut guard = slot.lock().await;
            if let Some(c) = guard.as_ref() {
                // VERIFY: Handle::is_closed(&self) -> bool.
                if !c.handle.is_closed() {
                    return Ok(c.clone());
                }
            }
            *guard = None;
            let profile = self.authorized_profile(&self.profiles.get_ssh(&pid).await?)?;
            let secret = self.profiles.ssh_secret(&pid);
            match open_session(self.known.clone(), &profile, secret).await? {
                Opened::Ready(conn, _) => {
                    let conn = Arc::new(conn);
                    *guard = Some(conn.clone());
                    Ok(conn)
                }
                Opened::HostKey(r) => Err(host_key_error(
                    profile.host.trim(),
                    profile.port.unwrap_or(22),
                    &r,
                )),
            }
        })
    }

    fn try_ref(&self, key: &ForwardKey) -> Option<u16> {
        let mut f = lock(&self.forwards);
        f.get_mut(key).map(|e| {
            e.refs += 1;
            e.local_port
        })
    }

    fn release(self: &Arc<Self>, key: &ForwardKey) {
        let mut emptied = false;
        {
            let mut f = lock(&self.forwards);
            let remove = match f.get_mut(key) {
                Some(e) => {
                    e.refs = e.refs.saturating_sub(1);
                    e.refs == 0
                }
                None => false,
            };
            if remove {
                if let Some(e) = f.remove(key) {
                    let _ = e.shutdown.send(true);
                }
                emptied = !f.keys().any(|k| k.0 == key.0);
            }
        }
        if !emptied {
            return;
        }
        let epoch = {
            let mut m = lock(&self.epochs);
            let e = m.entry(key.0.clone()).or_insert(0);
            *e += 1;
            *e
        };
        let inner = self.clone();
        let pid = key.0.clone();
        tokio::spawn(async move {
            tokio::time::sleep(IDLE_CLOSE).await;
            inner.close_if_idle(pid, epoch).await;
        });
    }

    fn still_idle(&self, pid: &str, epoch: u64) -> bool {
        let same_epoch = lock(&self.epochs).get(pid).copied() == Some(epoch);
        same_epoch && !lock(&self.forwards).keys().any(|k| k.0 == pid)
    }

    fn close_if_idle(self: Arc<Self>, pid: String, epoch: u64) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            if !self.still_idle(&pid, epoch) {
                return;
            }
            let slot = self.slot(&pid);
            let mut guard = slot.lock().await;
            // Re-check under the slot lock: acquire() holds it while it (re)connects.
            if !self.still_idle(&pid, epoch) {
                return;
            }
            if let Some(c) = guard.take() {
                disconnect(c).await;
            }
        })
    }
}

/// Copies bytes between an accepted local socket and a direct-tcpip channel until either side ends
/// or the forward is shut down.
fn bridge(
    conn: Arc<SshConn>,
    mut tcp: TcpStream,
    host: String,
    port: u16,
    local_port: u16,
    mut shutdown: watch::Receiver<bool>,
) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        // VERIFY: Handle::channel_open_direct_tcpip(&self, host, port: u32, originator_addr, originator_port: u32).
        let channel = match conn
            .handle
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", u32::from(local_port))
            .await
        {
            Ok(c) => c,
            Err(_) => return,
        };
        // VERIFY: Channel::into_stream() -> impl AsyncRead + AsyncWrite + Unpin (available since russh 0.44).
        let mut stream = channel.into_stream();
        tokio::select! {
            _ = shutdown.changed() => {}
            _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => {}
        }
    })
}

fn spawn_accept_loop(
    inner: Arc<Inner>,
    listener: TcpListener,
    key: ForwardKey,
    local_port: u16,
    mut shutdown: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                accepted = listener.accept() => {
                    let tcp = match accepted {
                        Ok((tcp, _)) => tcp,
                        Err(_) => {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                    };
                    let _ = tcp.set_nodelay(true);
                    let inner = inner.clone();
                    let rx = shutdown.clone();
                    let (pid, host, port) = key.clone();
                    tokio::spawn(async move {
                        // Reconnects the SSH session transparently when it dropped.
                        let conn = match inner.ensure_conn(pid).await {
                            Ok(c) => c,
                            Err(_) => return,
                        };
                        bridge(conn, tcp, host, port, local_port, rx).await;
                    });
                }
            }
        }
    });
}

/// A reference to a local forward. Dropping it releases the forward (closed at zero references).
pub struct ForwardLease {
    inner: Arc<Inner>,
    key: ForwardKey,
    local_port: u16,
}

impl ForwardLease {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }
}

impl Drop for ForwardLease {
    fn drop(&mut self) {
        self.inner.release(&self.key);
    }
}

pub struct TunnelManager {
    inner: Arc<Inner>,
}

impl TunnelManager {
    pub fn new(profiles: Arc<Profiles>, data_dir: &std::path::Path) -> Self {
        Self::with_policy(profiles, Arc::new(KnownHosts::load(data_dir)), None)
    }

    pub fn with_policy(
        profiles: Arc<Profiles>,
        known: Arc<KnownHosts>,
        profile_policy: Option<Arc<ProfilePolicy>>,
    ) -> Self {
        TunnelManager {
            inner: Arc::new(Inner {
                profiles,
                known,
                slots: Mutex::new(HashMap::new()),
                forwards: Mutex::new(HashMap::new()),
                epochs: Mutex::new(HashMap::new()),
                create_lock: tokio::sync::Mutex::new(()),
                profile_policy,
            }),
        }
    }

    /// Opens (or reuses) the SSH session and a local forward to `host:port` resolved on the SSH server.
    pub fn acquire<'a>(
        &'a self,
        profile_id: &'a str,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, AppResult<ForwardLease>> {
        Box::pin(async move {
            let inner = self.inner.clone();
            // Fails early with SSH_HOST_UNKNOWN / SSH_HOST_CHANGED / auth errors.
            inner.clone().ensure_conn(profile_id.to_string()).await?;

            let key: ForwardKey = (profile_id.to_string(), host.to_string(), port);
            if let Some(local_port) = inner.try_ref(&key) {
                return Ok(ForwardLease {
                    inner,
                    key,
                    local_port,
                });
            }
            let _create = inner.create_lock.lock().await;
            if let Some(local_port) = inner.try_ref(&key) {
                return Ok(ForwardLease {
                    inner: inner.clone(),
                    key,
                    local_port,
                });
            }
            let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
            let local_port = listener.local_addr()?.port();
            let (tx, rx) = watch::channel(false);
            lock(&inner.forwards).insert(
                key.clone(),
                ForwardEntry {
                    local_port,
                    refs: 1,
                    shutdown: tx,
                },
            );
            spawn_accept_loop(inner.clone(), listener, key.clone(), local_port, rx);
            Ok(ForwardLease {
                inner: inner.clone(),
                key,
                local_port,
            })
        })
    }

    /// Connects, reports the host key status and authenticates only when the key is trusted.
    pub fn test<'a>(
        &'a self,
        profile: &'a SshProfile,
        secret: Option<String>,
    ) -> BoxFuture<'a, AppResult<SshCheck>> {
        Box::pin(async move {
            let secret =
                match secret {
                    Some(s) => Some(s),
                    None if !profile.id.is_empty() => {
                        let same_server =
                            self.inner.profile_policy.is_none()
                                || self.inner.profiles.get_ssh(&profile.id).await.is_ok_and(
                                    |saved| crate::profiles::same_ssh_server(&saved, profile),
                                );
                        same_server
                            .then(|| self.inner.profiles.ssh_secret(&profile.id))
                            .flatten()
                    }
                    None => None,
                };
            let profile = self.inner.authorized_profile(profile)?;
            match open_session(self.inner.known.clone(), &profile, secret).await? {
                Opened::Ready(conn, r) => {
                    disconnect(Arc::new(conn)).await;
                    Ok(SshCheck {
                        fingerprint: r.fingerprint,
                        key_type: r.key_type,
                        host_key_status: r.status.as_str().to_string(),
                        authenticated: true,
                    })
                }
                Opened::HostKey(r) => Ok(SshCheck {
                    fingerprint: r.fingerprint,
                    key_type: r.key_type,
                    host_key_status: r.status.as_str().to_string(),
                    authenticated: false,
                }),
            }
        })
    }

    pub fn trust_host(&self, host: &str, port: u16, fingerprint: &str) -> AppResult<()> {
        self.inner.known.trust(host, port, fingerprint)
    }
}

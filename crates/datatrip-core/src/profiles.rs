//! Shared Vault and SSH profiles: JSON files in the config directory (atomic writes) and secrets in the
//! OS keychain (in-memory fallback when the keychain is unavailable; never written to disk).
//!
//! Keychain entries: service "DataTrip-VaultProfile" (user = profile id, the token) and
//! service "DataTrip-SSH" (user = profile id, key passphrase or password).

use crate::error::{AppError, AppResult};
use crate::model::{SshProfile, VaultProfile};
use crate::store::{ProfileSecret, Store};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const VAULT_PROFILE_SERVICE: &str = "DataTrip-VaultProfile";
const SSH_SERVICE: &str = "DataTrip-SSH";

/// One keychain service plus the in-memory fallback.
struct SecretStore {
    service: &'static str,
    mem: Mutex<HashMap<String, String>>,
}

impl SecretStore {
    fn new(service: &'static str) -> Self {
        SecretStore {
            service,
            mem: Mutex::new(HashMap::new()),
        }
    }

    fn mem(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.mem.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Empty value clears the entry.
    fn set(&self, id: &str, value: &str) {
        if id.is_empty() {
            return;
        }
        if value.is_empty() {
            self.clear(id);
            return;
        }
        match keyring::Entry::new(self.service, id).and_then(|e| e.set_password(value)) {
            Ok(()) => {
                self.mem().remove(id);
            }
            Err(_) => {
                self.mem().insert(id.to_string(), value.to_string());
            }
        }
    }

    fn clear(&self, id: &str) {
        let _ = keyring::Entry::new(self.service, id).and_then(|e| e.delete_credential());
        self.mem().remove(id);
    }

    fn get(&self, id: &str) -> Option<String> {
        if id.is_empty() {
            return None;
        }
        if let Some(v) = self.mem().get(id) {
            return Some(v.clone());
        }
        keyring::Entry::new(self.service, id)
            .and_then(|e| e.get_password())
            .ok()
    }
}

fn read_list<T: DeserializeOwned>(path: &Path) -> AppResult<Vec<T>> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            if text.trim().is_empty() {
                return Ok(Vec::new());
            }
            serde_json::from_str::<Vec<T>>(&text)
                .map_err(|e| AppError::new(format!("Could not read {}: {}", path.display(), e)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

fn save_profile<T>(
    profiles: &mut Vec<ProfileSecret<T>>,
    profile: T,
    key: fn(&T) -> &str,
    secret: Option<String>,
) -> AppResult<()> {
    if let Some(record) = profiles
        .iter_mut()
        .find(|record| key(&record.profile) == key(&profile))
    {
        record.profile = profile;
        if let Some(secret) = secret {
            record.secret = Some(secret).filter(|s| !s.is_empty());
        }
    } else {
        if profiles.len() >= 100 {
            return Err(AppError::new("Workspace profile limit reached"));
        }
        profiles.push(ProfileSecret {
            profile,
            secret: secret.filter(|s| !s.is_empty()),
        });
    }
    Ok(())
}

/// Atomic write: temp file in the same directory, then rename.
pub fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> AppResult<()> {
    let json = serde_json::to_string_pretty(value)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub struct Profiles {
    store: Arc<Store>,
    vault_path: PathBuf,
    ssh_path: PathBuf,
    layout_path: PathBuf,
    settings_path: PathBuf,
    workspace_path: PathBuf,
    file_lock: tokio::sync::Mutex<()>,
    vault_tokens: SecretStore,
    ssh_secrets: SecretStore,
}

impl Profiles {
    pub fn new(config_dir: &Path, store: Arc<Store>) -> Self {
        Profiles {
            store,
            vault_path: config_dir.join("vault_profiles.json"),
            ssh_path: config_dir.join("ssh_profiles.json"),
            layout_path: config_dir.join("explorer_layout.json"),
            settings_path: config_dir.join("settings.json"),
            workspace_path: config_dir.join("workspace.json"),
            file_lock: tokio::sync::Mutex::new(()),
            vault_tokens: SecretStore::new(VAULT_PROFILE_SERVICE),
            ssh_secrets: SecretStore::new(SSH_SERVICE),
        }
    }

    // ----- Explorer layout -----

    pub async fn get_layout(&self) -> AppResult<crate::model::ExplorerLayout> {
        let _g = self.file_lock.lock().await;
        match std::fs::read_to_string(&self.layout_path) {
            Ok(text) if !text.trim().is_empty() => serde_json::from_str(&text).map_err(|e| {
                AppError::new(format!(
                    "Could not read {}: {}",
                    self.layout_path.display(),
                    e
                ))
            }),
            Ok(_) => Ok(Default::default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn save_layout(&self, layout: &crate::model::ExplorerLayout) -> AppResult<()> {
        let _g = self.file_lock.lock().await;
        write_json_atomic(&self.layout_path, layout)
    }

    // ----- App settings (shape owned by the frontend) -----

    /// `<config>/settings.json` as raw JSON; `{}` when missing, unreadable or not an object.
    pub async fn get_settings(&self) -> serde_json::Value {
        let _g = self.file_lock.lock().await;
        let parsed = std::fs::read_to_string(&self.settings_path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        match parsed {
            Some(v) if v.is_object() => v,
            _ => serde_json::Value::Object(serde_json::Map::new()),
        }
    }

    pub async fn save_settings(&self, settings: &serde_json::Value) -> AppResult<()> {
        if !settings.is_object() {
            return Err(AppError::new("Settings must be a JSON object."));
        }
        let _g = self.file_lock.lock().await;
        write_json_atomic(&self.settings_path, settings)
    }

    // ----- Workspace: open console tabs to restore on launch (shape owned by the frontend) -----

    /// `<config>/workspace.json` as raw JSON; `{}` when missing, unreadable or not an object.
    pub async fn get_workspace(&self) -> serde_json::Value {
        let _g = self.file_lock.lock().await;
        let parsed = std::fs::read_to_string(&self.workspace_path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        match parsed {
            Some(v) if v.is_object() => v,
            _ => serde_json::Value::Object(serde_json::Map::new()),
        }
    }

    pub async fn save_workspace(&self, workspace: &serde_json::Value) -> AppResult<()> {
        if !workspace.is_object() {
            return Err(AppError::new("Workspace must be a JSON object."));
        }
        let _g = self.file_lock.lock().await;
        write_json_atomic(&self.workspace_path, workspace)
    }

    // ----- Vault profiles -----

    pub async fn list_vault(&self) -> AppResult<Vec<VaultProfile>> {
        if self.store.is_hosted() {
            return self.store.hosted_profiles(|records| &mut records.vault);
        }
        let _g = self.file_lock.lock().await;
        read_list(&self.vault_path)
    }

    pub async fn get_vault(&self, id: &str) -> AppResult<VaultProfile> {
        self.list_vault()
            .await?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::new("The shared Vault profile no longer exists."))
    }

    /// `token`: None keeps the stored one, Some("") clears it, Some(t) stores it.
    pub async fn save_vault(
        &self,
        mut profile: VaultProfile,
        token: Option<String>,
    ) -> AppResult<VaultProfile> {
        if profile.id.trim().is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        if profile.name.trim().is_empty() {
            return Err(AppError::new("A Vault profile needs a name."));
        }
        if self.store.is_hosted() {
            self.store.update_hosted_profiles(
                |r| &mut r.vault,
                |list| {
                    if token.is_none() && list.iter().any(|record| record.profile.id == profile.id
                        && record.secret.is_some() && !same_vault_server(&profile, &record.profile)) {
                        return Err(AppError::new("Enter or clear the saved token before changing its Vault address or TLS options."));
                    }
                    save_profile(
                        list,
                        profile.clone(),
                        |v| &v.id,
                        token.map(|t| t.trim().to_owned()),
                    )
                },
            )?;
            return Ok(profile);
        }
        {
            let _g = self.file_lock.lock().await;
            let mut list: Vec<VaultProfile> = read_list(&self.vault_path)?;
            match list.iter().position(|p| p.id == profile.id) {
                Some(i) => list[i] = profile.clone(),
                None => list.push(profile.clone()),
            }
            write_json_atomic(&self.vault_path, &list)?;
        }
        if let Some(t) = token {
            self.vault_tokens.set(&profile.id, t.trim());
        }
        Ok(profile)
    }

    pub async fn delete_vault(&self, id: &str) -> AppResult<()> {
        let users: Vec<String> = self
            .store
            .list_connections()
            .await?
            .into_iter()
            .filter(|c| {
                c.vault
                    .as_ref()
                    .and_then(|v| v.profile_id.as_deref())
                    .map(|p| p == id)
                    .unwrap_or(false)
            })
            .map(|c| c.name)
            .collect();
        if !users.is_empty() {
            return Err(AppError::new(format!(
                "This Vault profile is used by: {}. Switch those connections to another configuration first.",
                users.join(", ")
            )));
        }
        if self.store.is_hosted() {
            return self.store.update_hosted_profiles(
                |r| &mut r.vault,
                |list| {
                    list.retain(|r| r.profile.id != id);
                    Ok(())
                },
            );
        }
        {
            let _g = self.file_lock.lock().await;
            let mut list: Vec<VaultProfile> = read_list(&self.vault_path)?;
            list.retain(|p| p.id != id);
            write_json_atomic(&self.vault_path, &list)?;
        }
        self.vault_tokens.clear(id);
        Ok(())
    }

    pub fn vault_token(&self, id: &str) -> Option<String> {
        if self.store.is_hosted() {
            return self
                .store
                .hosted_profile_secret(|r| &mut r.vault, id, |p| &p.id);
        }
        self.vault_tokens.get(id)
    }

    /// Stores a profile's token (as `save_vault` does for a pasted one); "" clears it.
    pub fn set_vault_token(&self, id: &str, token: &str) -> AppResult<()> {
        if self.store.is_hosted() {
            return self.store.update_hosted_profiles(
                |r| &mut r.vault,
                |list| {
                    let record = list
                        .iter_mut()
                        .find(|r| r.profile.id == id)
                        .ok_or_else(|| {
                            AppError::new("The shared Vault profile no longer exists.")
                        })?;
                    record.secret = Some(token.trim().to_owned()).filter(|s| !s.is_empty());
                    Ok(())
                },
            );
        }
        self.vault_tokens.set(id, token.trim());
        Ok(())
    }

    /// Ids of connections whose Vault config references this profile.
    pub async fn connections_using_vault(&self, id: &str) -> AppResult<Vec<String>> {
        Ok(self
            .store
            .list_connections()
            .await?
            .into_iter()
            .filter(|c| {
                c.vault
                    .as_ref()
                    .and_then(|v| v.profile_id.as_deref())
                    .map(|p| p == id)
                    .unwrap_or(false)
            })
            .map(|c| c.id)
            .collect())
    }

    // ----- SSH profiles -----

    pub async fn list_ssh(&self) -> AppResult<Vec<SshProfile>> {
        if self.store.is_hosted() {
            return self.store.hosted_profiles(|records| &mut records.ssh);
        }
        let _g = self.file_lock.lock().await;
        read_list(&self.ssh_path)
    }

    pub async fn get_ssh(&self, id: &str) -> AppResult<SshProfile> {
        self.list_ssh()
            .await?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::new("The SSH configuration no longer exists."))
    }

    /// `secret`: None keeps the stored one, Some("") clears it, Some(s) stores it.
    pub async fn save_ssh(
        &self,
        mut profile: SshProfile,
        secret: Option<String>,
    ) -> AppResult<SshProfile> {
        if profile.id.trim().is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        if profile.name.trim().is_empty() {
            return Err(AppError::new("An SSH configuration needs a name."));
        }
        if profile.host.trim().is_empty() {
            return Err(AppError::new("The SSH host is empty."));
        }
        if self.store.is_hosted() {
            self.store.update_hosted_profiles(
                |r| &mut r.ssh,
                |list| {
                    if secret.is_none()
                        && list.iter().any(|record| {
                            record.profile.id == profile.id
                                && record.secret.is_some()
                                && !same_ssh_server(&profile, &record.profile)
                        })
                    {
                        return Err(AppError::new(
                            "Enter or clear the saved SSH secret before changing its destination.",
                        ));
                    }
                    save_profile(list, profile.clone(), |v| &v.id, secret)
                },
            )?;
            return Ok(profile);
        }
        {
            let _g = self.file_lock.lock().await;
            let mut list: Vec<SshProfile> = read_list(&self.ssh_path)?;
            match list.iter().position(|p| p.id == profile.id) {
                Some(i) => list[i] = profile.clone(),
                None => list.push(profile.clone()),
            }
            write_json_atomic(&self.ssh_path, &list)?;
        }
        if let Some(s) = secret {
            self.ssh_secrets.set(&profile.id, &s);
        }
        Ok(profile)
    }

    pub async fn delete_ssh(&self, id: &str) -> AppResult<()> {
        let users: Vec<String> = self
            .store
            .list_connections()
            .await?
            .into_iter()
            .filter(|c| c.ssh_profile_id.as_deref() == Some(id))
            .map(|c| c.name)
            .collect();
        if !users.is_empty() {
            return Err(AppError::new(format!(
                "This SSH configuration is used by: {}. Switch those connections to another configuration first.",
                users.join(", ")
            )));
        }
        if self.store.is_hosted() {
            return self.store.update_hosted_profiles(
                |r| &mut r.ssh,
                |list| {
                    list.retain(|r| r.profile.id != id);
                    Ok(())
                },
            );
        }
        {
            let _g = self.file_lock.lock().await;
            let mut list: Vec<SshProfile> = read_list(&self.ssh_path)?;
            list.retain(|p| p.id != id);
            write_json_atomic(&self.ssh_path, &list)?;
        }
        self.ssh_secrets.clear(id);
        Ok(())
    }

    pub fn ssh_secret(&self, id: &str) -> Option<String> {
        if self.store.is_hosted() {
            return self
                .store
                .hosted_profile_secret(|r| &mut r.ssh, id, |p| &p.id);
        }
        self.ssh_secrets.get(id)
    }
}

pub fn same_vault_server(a: &VaultProfile, b: &VaultProfile) -> bool {
    a.address == b.address
        && a.namespace == b.namespace
        && a.skip_tls_verify == b.skip_tls_verify
        && a.ca_cert_path == b.ca_cert_path
}

pub fn same_ssh_server(a: &SshProfile, b: &SshProfile) -> bool {
    a.host == b.host
        && a.port == b.port
        && a.user == b.user
        && a.auth_method == b.auth_method
        && a.private_key_path == b.private_key_path
}

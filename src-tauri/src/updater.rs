//! In-app updates from the project's GitHub releases (tauri-plugin-updater).
//!
//! The newest published release (optionally pre-releases) carrying a `latest.json` asset is the
//! update manifest; tauri-action writes it when the build is signed. Every download is verified
//! against the minisign public key baked into the build (`DATATRIP_UPDATER_PUBKEY`, the CI
//! repository variable `TAURI_UPDATER_PUBKEY`). Without that key the updater is off.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const REPO: &str = "sepehr-dh99/data-trip";

/// Minisign public key embedded at build time; absent = updates not set up for this build.
const PUBKEY: Option<&str> = option_env!("DATATRIP_UPDATER_PUBKEY");

#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub configured: bool,
    pub current_version: String,
    /// "macos" | "windows" | "linux"
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Release notes (the release body).
    pub notes: Option<String>,
    pub date: Option<String>,
    /// The release page on GitHub.
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn pubkey() -> Option<&'static str> {
    PUBKEY.map(str::trim).filter(|k| !k.is_empty())
}

fn upd_err(e: tauri_plugin_updater::Error) -> AppError {
    AppError::new(format!("Update failed: {}", e))
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    UpdateStatus {
        configured: pubkey().is_some(),
        current_version: app.package_info().version.to_string(),
        platform: platform().into(),
    }
}

/// The `latest.json` URL and page of the newest published release (pre-releases optional).
async fn manifest_url(include_pre: bool) -> AppResult<Option<(String, String)>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("DataTrip-updater")
        .build()
        .map_err(AppError::from)?;
    let resp = client
        .get(format!(
            "https://api.github.com/repos/{}/releases?per_page=15",
            REPO
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(AppError::from)?;
    if !resp.status().is_success() {
        return Err(AppError::new(format!(
            "GitHub answered {} while checking for updates",
            resp.status()
        )));
    }
    let list: serde_json::Value = resp.json().await.map_err(AppError::from)?;
    for r in list.as_array().into_iter().flatten() {
        if r["draft"].as_bool().unwrap_or(false) {
            continue;
        }
        if !include_pre && r["prerelease"].as_bool().unwrap_or(false) {
            continue;
        }
        let page = r["html_url"].as_str().unwrap_or_default().to_string();
        for a in r["assets"].as_array().into_iter().flatten() {
            if a["name"].as_str() == Some("latest.json") {
                if let Some(u) = a["browser_download_url"].as_str() {
                    return Ok(Some((u.to_string(), page)));
                }
            }
        }
    }
    Ok(None)
}

/// Checks GitHub for a newer version. `null` = up to date (or no signed release yet).
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    include_pre: bool,
) -> AppResult<Option<UpdateInfo>> {
    let key = pubkey()
        .ok_or_else(|| AppError::new("Updates aren't set up in this build (no signing key)."))?;
    let Some((manifest, page)) = manifest_url(include_pre).await? else {
        return Ok(None);
    };
    let url = tauri::Url::parse(&manifest)
        .map_err(|e| AppError::new(format!("Bad update URL {}: {}", manifest, e)))?;
    let updater = app
        .updater_builder()
        .pubkey(key)
        .timeout(Duration::from_secs(120))
        .endpoints(vec![url])
        .map_err(upd_err)?
        .build()
        .map_err(upd_err)?;
    let found = updater.check().await.map_err(upd_err)?;
    *lock(&state.bytes) = None;
    match found {
        None => {
            *lock(&state.pending) = None;
            Ok(None)
        }
        Some(u) => {
            let info = UpdateInfo {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                notes: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
                url: page,
            };
            *lock(&state.pending) = Some(u);
            Ok(Some(info))
        }
    }
}

/// Downloads (and verifies) the update found by `update_check`; emits `update-progress`.
#[tauri::command]
pub async fn update_download(app: AppHandle, state: State<'_, UpdaterState>) -> AppResult<()> {
    let update = lock(&state.pending)
        .clone()
        .ok_or_else(|| AppError::new("No update to download. Check for updates first."))?;
    let emitter = app.clone();
    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(upd_err)?;
    *lock(&state.bytes) = Some(bytes);
    Ok(())
}

/// Installs the downloaded update. `restart`: relaunch DataTrip right away (Windows always
/// does: its installer replaces the running app).
#[tauri::command]
pub fn update_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    restart: bool,
) -> AppResult<()> {
    let update = lock(&state.pending)
        .clone()
        .ok_or_else(|| AppError::new("No update to install. Check for updates first."))?;
    let bytes = lock(&state.bytes)
        .take()
        .ok_or_else(|| AppError::new("The update hasn't been downloaded yet."))?;
    update.install(&bytes).map_err(upd_err)?;
    *lock(&state.pending) = None;
    if restart {
        app.restart();
    }
    Ok(())
}

/// Opens a release page of this project in the default browser (only GitHub pages of the repo).
#[tauri::command]
pub fn update_open_page(url: String) -> AppResult<()> {
    let prefix = format!("https://github.com/{}/", REPO);
    if !url.starts_with(&prefix) {
        return Err(AppError::new("Not a DataTrip release page."));
    }
    crate::vault::open_browser(&url)
}

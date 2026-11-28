//! Workspace files. Application operations accept opaque UUIDs plus a display name,
//! never a path supplied by the browser.
use crate::runtime::{BrowserSession, Runtime, WebError, WebResult};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{fs, io::AsyncWriteExt};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const MAX_FILE: u64 = 128 * 1024 * 1024;
const MAX_WORKSPACE: u64 = 512 * 1024 * 1024;
const MAX_FILES: usize = 128;
pub const EXPORT_LIMIT: u64 = datatrip_core::export::HOSTED_EXPORT_LIMIT;

pub async fn check_write(session: &BrowserSession, path: &str, size: u64) -> WebResult<()> {
    let (_, total) = usage(&folder(session)).await?;
    let previous = fs::metadata(path).await.map_or(0, |meta| meta.len());
    if size > MAX_FILE || total.saturating_sub(previous).saturating_add(size) > MAX_WORKSPACE {
        return Err(too_large());
    }
    Ok(())
}

pub struct ExportStage {
    pub path: String,
}

impl ExportStage {
    pub fn new(target: &str) -> Self {
        Self {
            path: format!("{target}.{}.staged", Uuid::new_v4()),
        }
    }
    pub fn complete(&self, target: &str) -> WebResult<()> {
        std::fs::rename(&self.path, target).map_err(|_| WebError::internal())
    }
}

impl Drop for ExportStage {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(format!("{}.dt-tmp", self.path));
    }
}

pub fn routes() -> Router<Arc<Runtime>> {
    Router::new()
        .route("/files/upload", post(upload))
        .route("/files/output", post(output))
        .route("/files/{id}/{name}", get(download))
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    Sql,
    Script,
    Import,
    Text,
    Material,
    Sqlite,
    Output,
}

impl Purpose {
    fn temporary(self) -> bool {
        matches!(self, Self::Import | Self::Script | Self::Output)
    }
}

#[derive(Deserialize, Serialize)]
struct FileSpec {
    name: String,
    purpose: Purpose,
}

#[derive(Serialize)]
struct Uploaded {
    file: String,
}

struct Staged(Option<PathBuf>);

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(dir) = self.0.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn missing() -> WebError {
    WebError::new(StatusCode::NOT_FOUND, "Workspace file not found")
}
fn too_large() -> WebError {
    WebError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Workspace file quota exceeded",
    )
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}

fn folder(session: &BrowserSession) -> PathBuf {
    session.workspace.dir.join("files")
}

fn file_spec(dir: &FsPath) -> WebResult<StoredFile> {
    let bytes = std::fs::read(dir.join("file.json")).map_err(|_| missing())?;
    serde_json::from_slice(&bytes).map_err(|_| missing())
}

pub fn clean_outputs(workspace: &FsPath, binding: Option<Uuid>) {
    let Ok(entries) = std::fs::read_dir(workspace.join("files")) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let remove = file_spec(&path).is_ok_and(|spec| {
            spec.purpose.temporary() && (binding.is_none() || spec.binding == binding)
        }) || (binding.is_none()
            && path.extension().is_some_and(|ext| ext == "upload"));
        if remove {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

#[derive(Deserialize, Serialize)]
struct StoredFile {
    name: String,
    purpose: Purpose,
    binding: Option<Uuid>,
}

pub fn resolve(
    session: &BrowserSession,
    reference: &str,
    allowed: &[Purpose],
    exists: bool,
) -> WebResult<String> {
    resolve_at(
        &session.workspace.dir,
        Some(session.binding),
        reference,
        allowed,
        exists,
    )
}

fn resolve_at(
    dir: &FsPath,
    binding: Option<Uuid>,
    reference: &str,
    allowed: &[Purpose],
    exists: bool,
) -> WebResult<String> {
    let (id, name) = reference.split_once('/').ok_or_else(missing)?;
    let id = Uuid::parse_str(id).map_err(|_| missing())?;
    let directory = dir.join("files").join(id.to_string());
    let spec = file_spec(&directory)?;
    if !allowed.contains(&spec.purpose)
        || spec.name != name
        || !valid_name(name)
        || (spec.binding.is_some() && spec.binding != binding)
    {
        return Err(missing());
    }
    let path = directory.join("data").join(name);
    if exists && !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
        return Err(missing());
    }
    Ok(path.to_string_lossy().into_owned())
}

pub fn database_files(
    dir: &FsPath,
    config: &datatrip_core::model::ConnectionConfig,
) -> datatrip_core::error::AppResult<datatrip_core::model::ConnectionConfig> {
    let mut result = config.clone();
    let lookup = |reference: &str, purpose| {
        resolve_at(dir, None, reference, &[purpose], true).map_err(|_| {
            datatrip_core::error::AppError::new("Workspace file not found for this connection")
        })
    };
    result.file_path = config
        .file_path
        .as_deref()
        .map(|reference| lookup(reference, Purpose::Sqlite))
        .transpose()?;
    for path in [
        &mut result.ssl_ca_path,
        &mut result.ssl_cert_path,
        &mut result.ssl_key_path,
    ] {
        *path = path
            .as_deref()
            .map(|reference| lookup(reference, Purpose::Material))
            .transpose()?;
    }
    if let Some(kafka) = &mut result.kafka {
        for path in [
            &mut kafka.ca_cert_path,
            &mut kafka.client_cert_path,
            &mut kafka.client_key_path,
        ] {
            *path = path
                .as_deref()
                .map(|reference| lookup(reference, Purpose::Material))
                .transpose()?;
        }
    }
    Ok(result)
}

pub fn material(dir: &FsPath, reference: &str) -> datatrip_core::error::AppResult<String> {
    resolve_at(dir, None, reference, &[Purpose::Material], true).map_err(|_| {
        datatrip_core::error::AppError::new("Workspace certificate or key file not found")
    })
}

async fn usage(root: &FsPath) -> WebResult<(usize, u64)> {
    let mut dirs = fs::read_dir(root).await.map_err(|_| WebError::internal())?;
    let mut count = 0;
    let mut bytes = 0;
    while let Some(entry) = dirs.next_entry().await.map_err(|_| WebError::internal())? {
        if Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() {
            continue;
        }
        count += 1;
        if let Ok(mut data) = fs::read_dir(entry.path().join("data")).await {
            while let Some(file) = data.next_entry().await.map_err(|_| WebError::internal())? {
                bytes += file
                    .metadata()
                    .await
                    .map_err(|_| WebError::internal())?
                    .len();
            }
        }
    }
    Ok((count, bytes))
}

async fn provision(
    session: &BrowserSession,
    spec: FileSpec,
    body: Option<Body>,
) -> WebResult<Uploaded> {
    if !valid_name(&spec.name) {
        return Err(WebError::new(StatusCode::BAD_REQUEST, "Invalid file name"));
    }
    let _write = session.workspace.file_writes.lock().await;
    let root = folder(session);
    fs::create_dir_all(&root)
        .await
        .map_err(|_| WebError::internal())?;
    let (count, usage) = usage(&root).await?;
    if count >= MAX_FILES || usage >= MAX_WORKSPACE {
        return Err(too_large());
    }
    let mut limit = MAX_FILE.min(MAX_WORKSPACE - usage);
    if spec.purpose == Purpose::Material {
        limit = limit.min(1024 * 1024);
    }
    let id = Uuid::new_v4();
    let tmp = root.join(format!("{id}.upload"));
    let mut cleanup = Staged(Some(tmp.clone()));
    fs::create_dir_all(tmp.join("data"))
        .await
        .map_err(|_| WebError::internal())?;
    let metadata = StoredFile {
        name: spec.name.clone(),
        purpose: spec.purpose,
        binding: spec.purpose.temporary().then_some(session.binding),
    };
    fs::write(
        tmp.join("file.json"),
        serde_json::to_vec(&metadata).map_err(|_| WebError::internal())?,
    )
    .await
    .map_err(|_| WebError::internal())?;
    if let Some(body) = body {
        let mut stream = body.into_data_stream();
        let mut target = fs::File::create(tmp.join("data").join(&spec.name))
            .await
            .map_err(|_| WebError::internal())?;
        let mut bytes = 0;
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| WebError::new(StatusCode::BAD_REQUEST, "Upload failed"))?;
            bytes += chunk.len() as u64;
            if bytes > limit {
                return Err(too_large());
            }
            target
                .write_all(&chunk)
                .await
                .map_err(|_| WebError::internal())?;
        }
        target.sync_all().await.map_err(|_| WebError::internal())?;
    }
    fs::rename(tmp, root.join(id.to_string()))
        .await
        .map_err(|_| WebError::internal())?;
    cleanup.0 = None;
    Ok(Uploaded {
        file: format!("{id}/{}", spec.name),
    })
}

async fn upload(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
    Query(spec): Query<FileSpec>,
    body: Body,
) -> WebResult<Json<Uploaded>> {
    let session = runtime.authorized(&headers).await?;
    if spec.purpose == Purpose::Output {
        return Err(missing());
    }
    let _permit = session.jobs.try_acquire().map_err(|_| too_large())?;
    let file = tokio::select! {
        _ = session.runs.stop.cancelled() => return Err(WebError::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(300), provision(&session, spec, Some(body))) =>
            result.map_err(|_| WebError::new(StatusCode::REQUEST_TIMEOUT, "Upload timed out"))??,
    };
    Ok(Json(file))
}

async fn output(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
    Json(spec): Json<FileSpec>,
) -> WebResult<Json<Uploaded>> {
    let session = runtime.authorized(&headers).await?;
    if !matches!(
        spec.purpose,
        Purpose::Output | Purpose::Sql | Purpose::Sqlite
    ) {
        return Err(missing());
    }
    let body = (spec.purpose == Purpose::Sqlite).then(Body::empty);
    Ok(Json(provision(&session, spec, body).await?))
}

#[derive(Deserialize)]
struct Download {
    binding: Uuid,
}

async fn download(
    State(runtime): State<Arc<Runtime>>,
    mut headers: HeaderMap,
    Path((id, name)): Path<(Uuid, String)>,
    Query(request): Query<Download>,
) -> WebResult<Response> {
    // A browser download is a navigation, so authorization here uses the cookie and
    // a session binding in the URL. The binding itself cannot authenticate a request.
    headers.insert(
        "x-datatrip-session",
        request.binding.to_string().parse().unwrap(),
    );
    let session = runtime.authorized(&headers).await?;
    let reference = format!("{id}/{name}");
    let permit = session
        .download_permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| WebError::new(StatusCode::TOO_MANY_REQUESTS, "Download limit reached"))?;
    let (file, snapshot) =
        match resolve(&session, &reference, &[Purpose::Output, Purpose::Sql], true) {
            Ok(path) => (fs::File::open(path).await.map_err(|_| missing())?, None),
            Err(_) => {
                let path = resolve(&session, &reference, &[Purpose::Sqlite], true)?;
                let _permit = session.jobs.try_acquire().map_err(|_| too_large())?;
                let _workspace = session
                    .workspace
                    .jobs
                    .try_acquire()
                    .map_err(|_| too_large())?;
                let temp = tempfile::NamedTempFile::new().map_err(|_| WebError::internal())?;
                let destination = temp.path().to_str().ok_or_else(WebError::internal)?;
                tokio::time::timeout(
                    Duration::from_secs(20),
                    datatrip_core::db::sqlite::snapshot(FsPath::new(&path), destination),
                )
                .await
                .map_err(|_| {
                    WebError::new(StatusCode::GATEWAY_TIMEOUT, "SQLite snapshot timed out")
                })??;
                (
                    fs::File::open(temp.path())
                        .await
                        .map_err(|_| WebError::internal())?,
                    Some(temp),
                )
            }
        };
    let size = file.metadata().await.map_err(|_| missing())?.len();
    let encoded = percent_encoding::utf8_percent_encode(&name, percent_encoding::NON_ALPHANUMERIC);
    let stop = session.runs.stop.clone();
    let stream = ReaderStream::new(file)
        .take_until(stop.cancelled_owned())
        .map(move |chunk| {
            let _until_download_finishes = (&snapshot, &permit);
            chunk
        });
    let response = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, size)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename*=UTF-8''{encoded}"),
        )
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::from_stream(stream))
        .map_err(|_| WebError::internal())?;
    Ok(response)
}

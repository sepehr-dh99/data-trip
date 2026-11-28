//! Desktop adapter for shared import operations.

use crate::{error::AppResult, AppState};
pub use core::{ImportFormat, ImportPreview, ImportProgress, ImportRequest, ImportRuns};
use datatrip_core::import as core;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn import_preview(
    path: String,
    format: Option<ImportFormat>,
    check_types: Option<Vec<Option<String>>>,
) -> AppResult<ImportPreview> {
    core::import_preview(path, format, check_types).await
}

#[tauri::command]
pub async fn import_run(
    app: AppHandle,
    state: State<'_, AppState>,
    runs: State<'_, ImportRuns>,
    session_id: String,
    path: String,
    request: ImportRequest,
    run_id: String,
) -> AppResult<ImportProgress> {
    core::import_run(
        &|progress| {
            let _ = app.emit(core::PROGRESS_EVENT, progress);
        },
        &state,
        &runs,
        session_id,
        path,
        request,
        run_id,
    )
    .await
}

#[tauri::command]
pub async fn import_cancel(runs: State<'_, ImportRuns>, run_id: String) -> AppResult<()> {
    core::import_cancel(&runs, run_id).await
}

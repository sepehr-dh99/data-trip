//! Desktop adapter for shared sqlfile operations.

use crate::{error::AppResult, AppState};
pub use core::{FileStat, RunOptions, RunProgress, SqlFileRuns, TextFile, WriteResult};
use datatrip_core::sqlfile as core;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn sql_file_read(path: String) -> AppResult<TextFile> {
    core::sql_file_read(path).await
}

#[tauri::command]
pub async fn sql_file_write(
    path: String,
    text: String,
    expected_mtime_ms: Option<f64>,
    bom: Option<bool>,
) -> AppResult<WriteResult> {
    core::sql_file_write(path, text, expected_mtime_ms, bom).await
}

#[tauri::command]
pub async fn file_mtime(path: String) -> AppResult<Option<FileStat>> {
    core::file_mtime(path).await
}

#[tauri::command]
pub async fn run_sql_file(
    app: AppHandle,
    state: State<'_, AppState>,
    runs: State<'_, SqlFileRuns>,
    session_id: String,
    path: String,
    options: RunOptions,
    run_id: String,
) -> AppResult<RunProgress> {
    core::run_sql_file(
        &|progress| {
            let _ = app.emit(core::PROGRESS_EVENT, progress);
        },
        &state,
        &runs,
        session_id,
        path,
        options,
        run_id,
    )
    .await
}

#[tauri::command]
pub async fn run_sql_file_cancel(runs: State<'_, SqlFileRuns>, run_id: String) -> AppResult<()> {
    core::run_sql_file_cancel(&runs, run_id).await
}

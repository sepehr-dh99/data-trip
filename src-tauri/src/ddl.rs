//! Desktop adapter for shared ddl operations.

use crate::{error::AppResult, AppState};
pub use core::{DdlRequest, TableExtras};
use datatrip_core::ddl as core;
use tauri::State;

#[tauri::command]
pub async fn get_ddl(
    state: State<'_, AppState>,
    session_id: String,
    request: DdlRequest,
) -> AppResult<String> {
    core::get_ddl(&state, session_id, request).await
}

#[tauri::command]
pub async fn table_extras(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<TableExtras> {
    core::table_extras(&state, session_id, schema, table).await
}

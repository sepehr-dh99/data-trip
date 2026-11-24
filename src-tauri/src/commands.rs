//! Tauri commands. Names and arguments mirror CONTRACT.md / src/api.ts.

use crate::error::{AppError, AppResult};
use crate::model::{
    ConnectionConfig, ExportFormat, HistoryEntry, QueryResult, RowEdit, SchemaNode, ServerInfo,
    SessionInfo,
};
use crate::session::Session;
use crate::{db, AppState};
use std::time::Instant;
use tauri::State;

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionConfig>> {
    state.store.list_connections().await
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<ConnectionConfig> {
    state.store.save_connection(config, password).await
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_connection(&id).await
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<ServerInfo> {
    let pw = match password {
        Some(p) => Some(p),
        None => state.store.get_password(&config.id),
    };
    let connected = db::connect(&config, pw.as_deref()).await?;
    let version = connected.server_version.clone();
    connected.conn.close().await;
    Ok(ServerInfo { version })
}

#[tauri::command]
pub async fn open_session(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<SessionInfo> {
    let config = state.store.get_connection(&connection_id).await?;
    let password = state.store.get_password(&config.id);
    let (session, info) = Session::open(config, password).await?;
    state.sessions.insert(session);
    Ok(info)
}

#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    if let Some(s) = state.sessions.remove(&session_id) {
        s.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn introspect(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<SchemaNode>> {
    let s = state.sessions.get(&session_id)?;
    s.introspect().await
}

#[tauri::command]
pub async fn execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    max_rows: u32,
) -> AppResult<QueryResult> {
    let s = state.sessions.get(&session_id)?;
    let started = Instant::now();
    let res = s.execute(sql.clone(), max_rows as usize).await;
    let elapsed = started.elapsed().as_millis() as i64;
    match &res {
        Ok(r) => {
            let rows = match r.rows_affected {
                Some(n) if r.columns.is_empty() => n as i64,
                _ => r.rows.len() as i64,
            };
            let _ = state
                .store
                .add_history(
                    &s.config.id,
                    &sql,
                    r.elapsed_ms as i64,
                    Some(rows),
                    true,
                    None,
                )
                .await;
        }
        Err(e) => {
            let _ = state
                .store
                .add_history(&s.config.id, &sql, elapsed, None, false, Some(&e.message))
                .await;
        }
    }
    res
}

#[tauri::command]
pub async fn cancel(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let s = state.sessions.get(&session_id)?;
    s.cancel().await
}

#[tauri::command]
pub async fn set_auto_commit(
    state: State<'_, AppState>,
    session_id: String,
    auto_commit: bool,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id)?;
    s.set_auto_commit(auto_commit).await
}

#[tauri::command]
pub async fn commit(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let s = state.sessions.get(&session_id)?;
    s.commit().await
}

#[tauri::command]
pub async fn rollback(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let s = state.sessions.get(&session_id)?;
    s.rollback().await
}

#[tauri::command]
pub async fn apply_edits(
    state: State<'_, AppState>,
    session_id: String,
    edits: Vec<RowEdit>,
) -> AppResult<u64> {
    let s = state.sessions.get(&session_id)?;
    s.apply_edits(edits).await
}

#[tauri::command]
pub async fn list_history(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    search: Option<String>,
    limit: u32,
) -> AppResult<Vec<HistoryEntry>> {
    state.store.list_history(connection_id, search, limit).await
}

#[tauri::command]
pub async fn export_query(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    format: ExportFormat,
    path: String,
) -> AppResult<u64> {
    if path.trim().is_empty() {
        return Err(AppError::new("No export path given"));
    }
    let s = state.sessions.get(&session_id)?;
    let started = Instant::now();
    let res = s.export(sql.clone(), format, path).await;
    let elapsed = started.elapsed().as_millis() as i64;
    match &res {
        Ok(n) => {
            let _ = state
                .store
                .add_history(&s.config.id, &sql, elapsed, Some(*n as i64), true, None)
                .await;
        }
        Err(e) => {
            let _ = state
                .store
                .add_history(&s.config.id, &sql, elapsed, None, false, Some(&e.message))
                .await;
        }
    }
    res
}

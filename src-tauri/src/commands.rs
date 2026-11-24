//! Tauri commands. Names and arguments mirror CONTRACT.md / src/api.ts.

use crate::error::{AppError, AppResult};
use crate::model::{
    AuthMethod, ConnectionConfig, DatabaseNode, Driver, ExportFormat, HistoryEntry, ObjectGroup,
    QueryResult, RowEdit, SchemaNode, ServerInfo, SessionInfo, VaultCheck, VaultTokenSource,
};
use crate::session::Session;
use crate::{vault, AppState};
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
    let saved = state.store.save_connection(config, password).await?;
    state.vault_cache.invalidate(&saved.id);
    Ok(saved)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.vault_cache.invalidate(&id);
    state.store.delete_connection(&id).await
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
    vault_token: Option<String>,
) -> AppResult<ServerInfo> {
    // Unsaved edits: never read or populate the Vault credential cache.
    let creds = state.creds.clone();
    let connected = creds
        .connect(
            &config,
            password,
            vault_token.filter(|t| !t.trim().is_empty()),
            false,
        )
        .await?;
    let version = connected.server_version.clone();
    connected.conn.close().await;
    Ok(ServerInfo { version })
}

#[tauri::command]
pub async fn open_session(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
) -> AppResult<SessionInfo> {
    let mut config = state.store.get_connection(&connection_id).await?;
    // The override lives in the session's config, so reconnects reuse it. SQLite has one file.
    if config.driver != Driver::Sqlite {
        if let Some(db) = database.filter(|d| !d.trim().is_empty()) {
            config.database = Some(db);
        }
    }
    let (session, info) = Session::open(config, state.creds.clone()).await?;
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
pub async fn list_databases(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<DatabaseNode>> {
    let s = state.sessions.get(&session_id)?;
    s.list_databases().await
}

#[tauri::command]
pub async fn list_server_objects(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<ObjectGroup>> {
    let s = state.sessions.get(&session_id)?;
    s.list_server_objects().await
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

/// Reads the Vault secret for an (possibly unsaved) config and reports what was found.
/// Never returns the password or token, and does not touch the credential cache.
#[tauri::command]
pub async fn test_vault(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    vault_token: Option<String>,
) -> AppResult<VaultCheck> {
    let vcfg = match (config.auth_method, config.vault.as_ref()) {
        (AuthMethod::Vault, Some(v)) => v.clone(),
        _ => return Err(AppError::new("This connection does not use Vault.")),
    };
    let explicit = vault_token.filter(|t| !t.trim().is_empty());
    let keychain = if vcfg.token_source == VaultTokenSource::Keychain && explicit.is_none() {
        state.store.get_vault_token(&config.id)
    } else {
        None
    };
    let secret = vault::fetch(&vcfg, keychain, explicit).await?;
    Ok(VaultCheck {
        username: secret.username,
        secret_kind: secret.kind.to_string(),
        lease_duration_secs: secret.lease_secs,
        renewable: secret.renewable,
    })
}

/// Stores the Vault token in the OS keychain; an empty token deletes it.
#[tauri::command]
pub async fn set_vault_token(
    state: State<'_, AppState>,
    connection_id: String,
    token: String,
) -> AppResult<()> {
    if connection_id.trim().is_empty() {
        return Err(AppError::new("Save the connection before storing a token."));
    }
    state.store.set_vault_token(&connection_id, token.trim());
    state.vault_cache.invalidate(&connection_id);
    Ok(())
}

const MAX_TEXT_FILE: u64 = 8 * 1024 * 1024;

/// Reads a UTF-8 text file (max 8 MiB). Used by importers.
#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    let path = vault::expand_tilde(path.trim());
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::new(format!("Could not read {}: {}", path, e)))?;
    if !meta.is_file() {
        return Err(AppError::new(format!("{} is not a file", path)));
    }
    if meta.len() > MAX_TEXT_FILE {
        return Err(AppError::new("File is larger than 8 MiB"));
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::new(format!("Could not read {}: {}", path, e)))?;
    if bytes.len() as u64 > MAX_TEXT_FILE {
        return Err(AppError::new("File is larger than 8 MiB"));
    }
    String::from_utf8(bytes).map_err(|_| AppError::new("File is not valid UTF-8 text"))
}

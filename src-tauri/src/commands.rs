//! Tauri commands. Names and arguments mirror CONTRACT.md / src/api.ts.

use crate::credentials::CredentialSource;
use crate::error::{AppError, AppResult};
use crate::model::{
    AuthMethod, ConnectionConfig, DatabaseNode, Driver, ExportFormat, FedResult, FedSource,
    HistoryEntry, KafkaConsumeRequest, KafkaConsumeResult, KafkaGroupDetail, KafkaOverview,
    KafkaProduceRequest, KafkaProduceResult, KafkaTopicDetail, ObjectGroup, QueryResult,
    ReconnectResult, RedisScanResult, RedisValue, RowEdit, SchemaNode, ServerInfo, SessionInfo,
    SshCheck, SshProfile, VaultCheck, VaultProfile, VaultTokenInfo,
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

/// Deletes history older than `days` days (0 = keep forever: no-op). Returns the deleted count.
#[tauri::command]
pub async fn prune_history(state: State<'_, AppState>, days: u32) -> AppResult<u64> {
    state.store.prune_history(days).await
}

/// Deletes the history of one connection, or all history when `connection_id` is null.
#[tauri::command]
pub async fn clear_history(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<u64> {
    state.store.clear_history(connection_id).await
}

/// Number of history entries (one connection, or all when null).
#[tauri::command]
pub async fn count_history(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<u64> {
    state.store.count_history(connection_id).await
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

#[tauri::command]
pub async fn export_query_with(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    options: crate::model::ExportOptions,
    path: String,
) -> AppResult<u64> {
    if path.trim().is_empty() {
        return Err(AppError::new("No export path given"));
    }
    let s = state.sessions.get(&session_id)?;
    let started = Instant::now();
    let res = s.export_with(sql.clone(), options, path).await;
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

/// Writes already-loaded text (preview / clipboard export) atomically; max 512 MiB.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || crate::export::write_text_atomic(&path, &content))
        .await
        .map_err(|e| AppError::new(format!("Write failed: {}", e)))?
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
    let prepared = state
        .creds
        .prepare_vault(&vcfg, &config.id, explicit.is_some())
        .await?;
    let secret = vault::fetch(&prepared.config, prepared.keychain_token, explicit)
        .await
        .map_err(|e| CredentialSource::map_vault_error(e, &prepared.profile))?;
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

/// Redis: one SCAN step on the session's database (keys sorted, with type and TTL).
#[tauri::command]
pub async fn redis_scan(
    state: State<'_, AppState>,
    session_id: String,
    pattern: String,
    cursor: String,
    count: u32,
    key_type: Option<String>,
) -> AppResult<RedisScanResult> {
    let s = state.sessions.get(&session_id)?;
    s.redis_scan(pattern, cursor, count, key_type).await
}

/// Redis: a key's value; collections are limited to the first `limit` elements.
#[tauri::command]
pub async fn redis_get(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    limit: u32,
) -> AppResult<RedisValue> {
    let s = state.sessions.get(&session_id)?;
    s.redis_get(key, limit as usize).await
}

/// Redis: deletes keys (UNLINK, falling back to DEL). Returns how many existed.
#[tauri::command]
pub async fn redis_delete(
    state: State<'_, AppState>,
    session_id: String,
    keys: Vec<String>,
) -> AppResult<u64> {
    let s = state.sessions.get(&session_id)?;
    s.redis_delete(keys).await
}

/// Redis: sets a TTL in seconds, or removes the expiry when `ttl` is null.
#[tauri::command]
pub async fn redis_set_ttl(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    ttl: Option<i64>,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id)?;
    s.redis_set_ttl(key, ttl).await
}

/// Kafka: brokers, topics and consumer groups.
#[tauri::command]
pub async fn kafka_overview(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<KafkaOverview> {
    let s = state.sessions.get(&session_id)?;
    s.kafka_overview().await
}

/// Kafka: partitions with watermarks and topic configs.
#[tauri::command]
pub async fn kafka_topic(
    state: State<'_, AppState>,
    session_id: String,
    topic: String,
) -> AppResult<KafkaTopicDetail> {
    let s = state.sessions.get(&session_id)?;
    s.kafka_topic(topic).await
}

/// Kafka: reads messages without joining or committing any consumer group.
#[tauri::command]
pub async fn kafka_consume(
    state: State<'_, AppState>,
    session_id: String,
    request: KafkaConsumeRequest,
) -> AppResult<KafkaConsumeResult> {
    let s = state.sessions.get(&session_id)?;
    s.kafka_consume(request).await
}

/// Kafka: produces one message. Refused on read-only connections.
#[tauri::command]
pub async fn kafka_produce(
    state: State<'_, AppState>,
    session_id: String,
    request: KafkaProduceRequest,
) -> AppResult<KafkaProduceResult> {
    let s = state.sessions.get(&session_id)?;
    s.kafka_produce(request).await
}

/// Kafka: group state, members and per-partition lag.
#[tauri::command]
pub async fn kafka_group(
    state: State<'_, AppState>,
    session_id: String,
    group_id: String,
) -> AppResult<KafkaGroupDetail> {
    let s = state.sessions.get(&session_id)?;
    s.kafka_group(group_id).await
}

/// Kafka: resets a group's committed offsets for a topic (group must be Empty).
#[tauri::command]
pub async fn kafka_reset_offsets(
    state: State<'_, AppState>,
    session_id: String,
    group_id: String,
    topic: String,
    to: String,
    value: Option<i64>,
) -> AppResult<u64> {
    let s = state.sessions.get(&session_id)?;
    s.kafka_reset_offsets(group_id, topic, to, value).await
}

/// Kafka: creates a topic. Refused on read-only connections.
#[tauri::command]
pub async fn kafka_create_topic(
    state: State<'_, AppState>,
    session_id: String,
    topic: String,
    partitions: i32,
    replication_factor: i32,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id)?;
    s.kafka_create_topic(topic, partitions, replication_factor)
        .await
}

/// Kafka: deletes a topic. Refused on read-only connections.
#[tauri::command]
pub async fn kafka_delete_topic(
    state: State<'_, AppState>,
    session_id: String,
    topic: String,
) -> AppResult<()> {
    let s = state.sessions.get(&session_id)?;
    s.kafka_delete_topic(topic).await
}

// ----- shared Vault profiles -----

#[tauri::command]
pub async fn get_explorer_layout(
    state: State<'_, AppState>,
) -> AppResult<crate::model::ExplorerLayout> {
    state.profiles.get_layout().await
}

#[tauri::command]
pub async fn save_explorer_layout(
    state: State<'_, AppState>,
    layout: crate::model::ExplorerLayout,
) -> AppResult<()> {
    state.profiles.save_layout(&layout).await
}

#[tauri::command]
pub async fn list_vault_profiles(state: State<'_, AppState>) -> AppResult<Vec<VaultProfile>> {
    state.profiles.list_vault().await
}

/// `token`: None keeps the stored token, "" clears it, anything else replaces it.
#[tauri::command]
pub async fn save_vault_profile(
    state: State<'_, AppState>,
    profile: VaultProfile,
    token: Option<String>,
) -> AppResult<VaultProfile> {
    let saved = state.profiles.save_vault(profile, token).await?;
    for conn_id in state.profiles.connections_using_vault(&saved.id).await? {
        state.vault_cache.invalidate(&conn_id);
    }
    Ok(saved)
}

#[tauri::command]
pub async fn delete_vault_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.profiles.delete_vault(&id).await
}

fn token_error(e: vault::TokenError, id: &str, name: &str) -> AppError {
    match e {
        vault::TokenError::Invalid => vault::token_invalid_error(id, name),
        vault::TokenError::Other(e) => e,
    }
}

/// Looks up the token (typed override, else the profile's own source). Never returns the token.
#[tauri::command]
pub async fn vault_token_info(
    state: State<'_, AppState>,
    profile: VaultProfile,
    token: Option<String>,
) -> AppResult<VaultTokenInfo> {
    let explicit = token.filter(|t| !t.trim().is_empty());
    let cfg = vault::config_from_profile(&profile);
    let keychain = if explicit.is_none() {
        state.profiles.vault_token(&profile.id)
    } else {
        None
    };
    vault::token_info(&cfg, keychain, explicit, false)
        .await
        .map_err(|e| token_error(e, &profile.id, &profile.name))
}

/// `auth/token/renew-self`, then `lookup-self`, with the stored profile's token.
#[tauri::command]
pub async fn renew_vault_token(
    state: State<'_, AppState>,
    profile_id: String,
) -> AppResult<VaultTokenInfo> {
    let profile = state.profiles.get_vault(&profile_id).await?;
    let cfg = vault::config_from_profile(&profile);
    let keychain = state.profiles.vault_token(&profile.id);
    let info = vault::token_info(&cfg, keychain, None, true)
        .await
        .map_err(|e| token_error(e, &profile.id, &profile.name))?;
    for conn_id in state.profiles.connections_using_vault(&profile.id).await? {
        state.vault_cache.invalidate(&conn_id);
    }
    Ok(info)
}

// ----- shared SSH profiles -----

#[tauri::command]
pub async fn list_ssh_profiles(state: State<'_, AppState>) -> AppResult<Vec<SshProfile>> {
    state.profiles.list_ssh().await
}

/// `secret`: None keeps the stored passphrase/password, "" clears it, anything else replaces it.
#[tauri::command]
pub async fn save_ssh_profile(
    state: State<'_, AppState>,
    profile: SshProfile,
    secret: Option<String>,
) -> AppResult<SshProfile> {
    state.profiles.save_ssh(profile, secret).await
}

#[tauri::command]
pub async fn delete_ssh_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.profiles.delete_ssh(&id).await
}

#[tauri::command]
pub async fn test_ssh_profile(
    state: State<'_, AppState>,
    profile: SshProfile,
    secret: Option<String>,
) -> AppResult<SshCheck> {
    let tunnels = state.tunnels.clone();
    tunnels.test(&profile, secret).await
}

#[tauri::command]
pub async fn trust_ssh_host(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    fingerprint: String,
) -> AppResult<()> {
    state.tunnels.trust_host(&host, port, &fingerprint)
}

// ----- v0.10: settings, reconnect, cross-source queries, Vault OIDC -----

/// Raw settings object from `<config>/settings.json` (`{}` when none).
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    Ok(state.profiles.get_settings().await)
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: serde_json::Value,
) -> AppResult<()> {
    state.profiles.save_settings(&settings).await
}

// ----- v0.11: workspace (restore consoles on launch) -----

/// Raw workspace object from `<config>/workspace.json` (`{}` when none).
#[tauri::command]
pub async fn get_workspace(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    Ok(state.profiles.get_workspace().await)
}

#[tauri::command]
pub async fn save_workspace(
    state: State<'_, AppState>,
    workspace: serde_json::Value,
) -> AppResult<()> {
    state.profiles.save_workspace(&workspace).await
}

/// Drops and re-opens the physical connection of every open session of the connection
/// (fresh Vault credentials and SSH forward); sessions inside a transaction are skipped.
#[tauri::command]
pub async fn reconnect_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<ReconnectResult> {
    let started = Instant::now();
    let sessions = state.sessions.for_connection(&connection_id);
    if sessions.is_empty() {
        return Ok(ReconnectResult {
            sessions: 0,
            skipped_in_tx: 0,
            elapsed_ms: 0,
        });
    }
    // Once for the connection: the first session fetches fresh credentials, the others share them.
    state.creds.invalidate(&connection_id);
    let mut done: u32 = 0;
    let mut skipped: u32 = 0;
    let mut first_err: Option<AppError> = None;
    for s in sessions {
        match s.reconnect().await {
            Ok(true) => done += 1,
            Ok(false) => skipped += 1,
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }
    if let Some(e) = first_err {
        return Err(e);
    }
    Ok(ReconnectResult {
        sessions: done,
        skipped_in_tx: skipped,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Runs one SELECT / WITH across several data sources, joined in an in-memory SQLite database.
#[tauri::command]
pub async fn federated_execute(
    state: State<'_, AppState>,
    sources: Vec<FedSource>,
    sql: String,
    max_rows: u32,
) -> AppResult<FedResult> {
    crate::federation::federated_execute(
        &state.store,
        &state.creds,
        sources,
        sql,
        max_rows as usize,
    )
    .await
}

/// Browser sign-in with Vault's OIDC auth method; stores the token like a pasted one.
#[tauri::command]
pub async fn vault_oidc_login(
    state: State<'_, AppState>,
    profile_id: String,
    role: Option<String>,
) -> AppResult<VaultTokenInfo> {
    let profile = state.profiles.get_vault(&profile_id).await?;
    let token = vault::oidc_login(&profile, role, &state.oidc).await?;
    state.profiles.set_vault_token(&profile.id, &token);
    for conn_id in state.profiles.connections_using_vault(&profile.id).await? {
        state.vault_cache.invalidate(&conn_id);
    }
    let cfg = vault::config_from_profile(&profile);
    vault::token_info(&cfg, None, Some(token), false)
        .await
        .map_err(|e| token_error(e, &profile.id, &profile.name))
}

/// Aborts a pending `vault_oidc_login` (it fails with `OIDC_CANCELLED: …`).
#[tauri::command]
pub async fn vault_oidc_cancel(state: State<'_, AppState>) -> AppResult<()> {
    state.oidc.cancel();
    Ok(())
}

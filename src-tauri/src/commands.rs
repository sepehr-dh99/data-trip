//! Tauri IPC adapters. Shared behavior lives in datatrip-core.

use crate::error::AppResult;
use crate::model::{
    ConnectionConfig, DatabaseNode, ExportFormat, FedResult, FedSource, HistoryEntry,
    KafkaConsumeRequest, KafkaConsumeResult, KafkaGroupDetail, KafkaOverview, KafkaProduceRequest,
    KafkaProduceResult, KafkaTopicDetail, ObjectGroup, QueryResult, ReconnectResult,
    RedisScanResult, RedisValue, RowEdit, SchemaNode, ServerInfo, SessionInfo, SshCheck,
    SshProfile, VaultCheck, VaultProfile, VaultTokenInfo,
};
use crate::{vault, AppState};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use datatrip_core::commands as core;

macro_rules! ipc {
    ($(fn $name:ident($($args:tt)*) -> $result:ty => ($($passed:tt)*);)*) => {
        $(
            #[tauri::command]
            pub async fn $name($($args)*) -> AppResult<$result> {
                core::$name($($passed)*).await
            }
        )*
    };
}

ipc! {
    fn list_connections(state: State<'_, AppState>) -> Vec<ConnectionConfig> => (&state);
    fn save_connection(
        state: State<'_, AppState>,
        config: ConnectionConfig,
        password: Option<String>,
        sentinel_password: Option<String>,
    ) -> ConnectionConfig => (&state, config, password, sentinel_password);
    fn delete_connection(state: State<'_, AppState>, id: String) -> () => (&state, id);
    fn test_connection(
        state: State<'_, AppState>,
        config: ConnectionConfig,
        password: Option<String>,
        vault_token: Option<String>,
        sentinel_password: Option<String>,
    ) -> ServerInfo => (&state, config, password, vault_token, sentinel_password);
    fn open_session(
        state: State<'_, AppState>,
        connection_id: String,
        database: Option<String>,
    ) -> SessionInfo => (&state, connection_id, database);
    fn close_session(state: State<'_, AppState>, session_id: String) -> () => (&state, session_id);
    fn introspect(
        state: State<'_, AppState>,
        session_id: String,
    ) -> Vec<SchemaNode> => (&state, session_id);
    fn list_databases(
        state: State<'_, AppState>,
        session_id: String,
    ) -> Vec<DatabaseNode> => (&state, session_id);
    fn list_server_objects(
        state: State<'_, AppState>,
        session_id: String,
    ) -> Vec<ObjectGroup> => (&state, session_id);
    fn execute(
        state: State<'_, AppState>,
        session_id: String,
        sql: String,
        max_rows: u32,
        history: Option<bool>,
    ) -> QueryResult => (&state, session_id, sql, max_rows, history);
    fn cancel(state: State<'_, AppState>, session_id: String) -> () => (&state, session_id);
    fn set_auto_commit(
        state: State<'_, AppState>,
        session_id: String,
        auto_commit: bool,
    ) -> () => (&state, session_id, auto_commit);
    fn commit(state: State<'_, AppState>, session_id: String) -> () => (&state, session_id);
    fn rollback(state: State<'_, AppState>, session_id: String) -> () => (&state, session_id);
    fn apply_edits(
        state: State<'_, AppState>,
        session_id: String,
        edits: Vec<RowEdit>,
    ) -> u64 => (&state, session_id, edits);
    fn list_history(
        state: State<'_, AppState>,
        connection_id: Option<String>,
        search: Option<String>,
        limit: u32,
    ) -> Vec<HistoryEntry> => (&state, connection_id, search, limit);
    fn prune_history(state: State<'_, AppState>, days: u32) -> u64 => (&state, days);
    fn clear_history(
        state: State<'_, AppState>,
        connection_id: Option<String>,
    ) -> u64 => (&state, connection_id);
    fn count_history(
        state: State<'_, AppState>,
        connection_id: Option<String>,
    ) -> u64 => (&state, connection_id);
    fn export_query(
        state: State<'_, AppState>,
        session_id: String,
        sql: String,
        format: ExportFormat,
        path: String,
    ) -> u64 => (&state, session_id, sql, format, path);
    fn export_query_with(
        state: State<'_, AppState>,
        session_id: String,
        sql: String,
        options: crate::model::ExportOptions,
        path: String,
    ) -> u64 => (&state, session_id, sql, options, path);
    fn write_text_file(path: String, content: String) -> () => (path, content);
    fn test_vault(
        state: State<'_, AppState>,
        config: ConnectionConfig,
        vault_token: Option<String>,
    ) -> VaultCheck => (&state, config, vault_token);
    fn set_vault_token(
        state: State<'_, AppState>,
        connection_id: String,
        token: String,
    ) -> () => (&state, connection_id, token);
    fn read_text_file(path: String) -> String => (path);
    fn redis_scan(
        state: State<'_, AppState>,
        session_id: String,
        pattern: String,
        cursor: String,
        count: u32,
        key_type: Option<String>,
    ) -> RedisScanResult => (&state, session_id, pattern, cursor, count, key_type);
    fn redis_get(
        state: State<'_, AppState>,
        session_id: String,
        key: String,
        limit: u32,
    ) -> RedisValue => (&state, session_id, key, limit);
    fn redis_delete(
        state: State<'_, AppState>,
        session_id: String,
        keys: Vec<String>,
    ) -> u64 => (&state, session_id, keys);
    fn redis_set_ttl(
        state: State<'_, AppState>,
        session_id: String,
        key: String,
        ttl: Option<i64>,
    ) -> () => (&state, session_id, key, ttl);
    fn kafka_overview(
        state: State<'_, AppState>,
        session_id: String,
    ) -> KafkaOverview => (&state, session_id);
    fn kafka_topic(
        state: State<'_, AppState>,
        session_id: String,
        topic: String,
    ) -> KafkaTopicDetail => (&state, session_id, topic);
    fn kafka_consume(
        state: State<'_, AppState>,
        session_id: String,
        request: KafkaConsumeRequest,
    ) -> KafkaConsumeResult => (&state, session_id, request);
    fn kafka_produce(
        state: State<'_, AppState>,
        session_id: String,
        request: KafkaProduceRequest,
    ) -> KafkaProduceResult => (&state, session_id, request);
    fn kafka_group(
        state: State<'_, AppState>,
        session_id: String,
        group_id: String,
    ) -> KafkaGroupDetail => (&state, session_id, group_id);
    fn kafka_reset_offsets(
        state: State<'_, AppState>,
        session_id: String,
        group_id: String,
        topic: String,
        to: String,
        value: Option<i64>,
    ) -> u64 => (&state, session_id, group_id, topic, to, value);
    fn kafka_create_topic(
        state: State<'_, AppState>,
        session_id: String,
        topic: String,
        partitions: i32,
        replication_factor: i32,
    ) -> () => (&state, session_id, topic, partitions, replication_factor);
    fn kafka_delete_topic(
        state: State<'_, AppState>,
        session_id: String,
        topic: String,
    ) -> () => (&state, session_id, topic);
    fn get_explorer_layout(state: State<'_, AppState>) -> crate::model::ExplorerLayout => (&state);
    fn save_explorer_layout(
        state: State<'_, AppState>,
        layout: crate::model::ExplorerLayout,
    ) -> () => (&state, layout);
    fn list_vault_profiles(state: State<'_, AppState>) -> Vec<VaultProfile> => (&state);
    fn save_vault_profile(
        state: State<'_, AppState>,
        profile: VaultProfile,
        token: Option<String>,
    ) -> VaultProfile => (&state, profile, token);
    fn delete_vault_profile(state: State<'_, AppState>, id: String) -> () => (&state, id);
    fn vault_token_info(
        state: State<'_, AppState>,
        profile: VaultProfile,
        token: Option<String>,
    ) -> VaultTokenInfo => (&state, profile, token);
    fn renew_vault_token(
        state: State<'_, AppState>,
        profile_id: String,
    ) -> VaultTokenInfo => (&state, profile_id);
    fn list_ssh_profiles(state: State<'_, AppState>) -> Vec<SshProfile> => (&state);
    fn save_ssh_profile(
        state: State<'_, AppState>,
        profile: SshProfile,
        secret: Option<String>,
    ) -> SshProfile => (&state, profile, secret);
    fn delete_ssh_profile(state: State<'_, AppState>, id: String) -> () => (&state, id);
    fn test_ssh_profile(
        state: State<'_, AppState>,
        profile: SshProfile,
        secret: Option<String>,
    ) -> SshCheck => (&state, profile, secret);
    fn trust_ssh_host(
        state: State<'_, AppState>,
        host: String,
        port: u16,
        fingerprint: String,
    ) -> () => (&state, host, port, fingerprint);
    fn get_settings(state: State<'_, AppState>) -> serde_json::Value => (&state);
    fn save_settings(
        state: State<'_, AppState>,
        settings: serde_json::Value,
    ) -> () => (&state, settings);
    fn get_workspace(state: State<'_, AppState>) -> serde_json::Value => (&state);
    fn save_workspace(
        state: State<'_, AppState>,
        workspace: serde_json::Value,
    ) -> () => (&state, workspace);
    fn reconnect_connection(
        state: State<'_, AppState>,
        connection_id: String,
    ) -> ReconnectResult => (&state, connection_id);
    fn federated_execute(
        state: State<'_, AppState>,
        sources: Vec<FedSource>,
        sql: String,
        max_rows: u32,
    ) -> FedResult => (&state, sources, sql, max_rows);
}

/// Browser sign-in with Vault's OIDC auth method; stores the token like a pasted one.
#[tauri::command]
pub async fn vault_oidc_login(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    role: Option<String>,
) -> AppResult<VaultTokenInfo> {
    let profile = state.profiles.get_vault(&profile_id).await?;
    let window_app = app.clone();
    let open = move |url: &str| -> AppResult<()> { open_oidc_window(&window_app, url) };
    let result = vault::oidc_login(&profile, role, &state.oidc, &open).await;
    // The sign-in window has done its job (or the login failed/was cancelled): close it.
    if let Some(w) = app.get_webview_window(OIDC_WINDOW) {
        let _ = w.close();
    }
    let token = result?;
    state.profiles.set_vault_token(&profile.id, &token)?;
    for conn_id in state.profiles.connections_using_vault(&profile.id).await? {
        state.vault_cache.invalidate(&conn_id);
    }
    let cfg = vault::config_from_profile(&profile);
    vault::token_info(&cfg, None, Some(token), false)
        .await
        .map_err(|e| core::token_error(e, &profile.id, &profile.name))
}

const OIDC_WINDOW: &str = "vault-oidc";

/// Shows Vault's OIDC sign-in page in a DataTrip window (no IPC access: it gets no capabilities).
/// Closing that window cancels the sign-in. Falls back to the default browser if the window
/// cannot be created.
fn open_oidc_window(app: &AppHandle, url: &str) -> AppResult<()> {
    let parsed: tauri::Url = match url.parse() {
        Ok(u) => u,
        Err(_) => return vault::open_browser(url),
    };
    if let Some(old) = app.get_webview_window(OIDC_WINDOW) {
        let _ = old.close();
    }
    let built = WebviewWindowBuilder::new(app, OIDC_WINDOW, WebviewUrl::External(parsed))
        .title("Sign in to Vault — DataTrip")
        .inner_size(520.0, 720.0)
        .min_inner_size(380.0, 480.0)
        .center()
        .focused(true)
        .build();
    match built {
        Ok(w) => {
            let handle = app.clone();
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    // Closed by the user before finishing: stop waiting for the callback.
                    let _ = handle.state::<AppState>().oidc.cancel();
                }
            });
            Ok(())
        }
        Err(_) => vault::open_browser(url),
    }
}

/// Aborts a pending `vault_oidc_login` (it fails with `OIDC_CANCELLED: …`).
#[tauri::command]
pub async fn vault_oidc_cancel(state: State<'_, AppState>) -> AppResult<()> {
    state.oidc.cancel();
    Ok(())
}

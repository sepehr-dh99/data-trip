//! DataTrip backend: Tauri builder, shared state and command registration.

pub mod ai;
pub mod app_menu;
pub mod commands;
pub mod credentials;
pub mod db;
pub mod error;
pub mod export;
pub mod federation;
pub mod fedsql;
pub mod model;
pub mod profiles;
pub mod session;
pub mod ssh;
pub mod store;
pub mod vault;

use std::sync::Arc;
use tauri::Manager;

/// Shared application state, managed by Tauri.
pub struct AppState {
    pub store: Arc<store::Store>,
    pub vault_cache: Arc<vault::VaultCache>,
    pub creds: credentials::CredentialSource,
    pub sessions: session::SessionRegistry,
    pub profiles: Arc<profiles::Profiles>,
    pub tunnels: Arc<ssh::TunnelManager>,
    /// The pending Vault OIDC browser sign-in, if any.
    pub oidc: vault::OidcLogins,
}

pub fn run() {
    // macOS: native menu bar (custom items emit the "menu" event); Windows / Linux: none.
    app_menu::with_app_menu(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&data_dir)?;
            let store = tauri::async_runtime::block_on(store::Store::open(&config_dir, &data_dir))?;
            let store = Arc::new(store);
            let vault_cache = Arc::new(vault::VaultCache::new());
            let profiles = Arc::new(profiles::Profiles::new(&config_dir, store.clone()));
            let tunnels = Arc::new(ssh::TunnelManager::new(profiles.clone(), &data_dir));
            let creds = credentials::CredentialSource::new(
                store.clone(),
                vault_cache.clone(),
                profiles.clone(),
                tunnels.clone(),
            );
            app.manage(ai::AiState::default());
            app.manage(AppState {
                store,
                vault_cache,
                creds,
                sessions: session::SessionRegistry::new(),
                profiles,
                tunnels,
                oidc: vault::OidcLogins::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::open_session,
            commands::close_session,
            commands::introspect,
            commands::list_databases,
            commands::list_server_objects,
            commands::execute,
            commands::cancel,
            commands::set_auto_commit,
            commands::commit,
            commands::rollback,
            commands::apply_edits,
            commands::list_history,
            commands::prune_history,
            commands::clear_history,
            commands::count_history,
            commands::export_query,
            commands::export_query_with,
            commands::write_text_file,
            commands::read_text_file,
            commands::test_vault,
            commands::set_vault_token,
            commands::get_explorer_layout,
            commands::save_explorer_layout,
            commands::list_vault_profiles,
            commands::save_vault_profile,
            commands::delete_vault_profile,
            commands::vault_token_info,
            commands::renew_vault_token,
            commands::list_ssh_profiles,
            commands::save_ssh_profile,
            commands::delete_ssh_profile,
            commands::test_ssh_profile,
            commands::trust_ssh_host,
            commands::redis_scan,
            commands::redis_get,
            commands::redis_delete,
            commands::redis_set_ttl,
            commands::kafka_overview,
            commands::kafka_topic,
            commands::kafka_consume,
            commands::kafka_produce,
            commands::kafka_group,
            commands::kafka_reset_offsets,
            commands::kafka_create_topic,
            commands::kafka_delete_topic,
            commands::get_settings,
            commands::save_settings,
            commands::get_workspace,
            commands::save_workspace,
            commands::reconnect_connection,
            commands::federated_execute,
            commands::vault_oidc_login,
            commands::vault_oidc_cancel,
            ai::ai_providers,
            ai::ai_generate,
            ai::ai_cancel,
            ai::ai_set_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DataTrip");
}

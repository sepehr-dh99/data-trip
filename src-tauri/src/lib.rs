//! DataTrip backend: Tauri builder, shared state and command registration.

pub mod commands;
pub mod credentials;
pub mod db;
pub mod error;
pub mod export;
pub mod model;
pub mod session;
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
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&data_dir)?;
            let store = tauri::async_runtime::block_on(store::Store::open(&config_dir, &data_dir))?;
            let store = Arc::new(store);
            let vault_cache = Arc::new(vault::VaultCache::new());
            let creds = credentials::CredentialSource::new(store.clone(), vault_cache.clone());
            app.manage(AppState {
                store,
                vault_cache,
                creds,
                sessions: session::SessionRegistry::new(),
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
            commands::export_query,
            commands::read_text_file,
            commands::test_vault,
            commands::set_vault_token,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running DataTrip");
}

//! DataTrip backend: Tauri builder, shared state and command registration.

pub mod commands;
pub mod db;
pub mod error;
pub mod export;
pub mod model;
pub mod session;
pub mod store;

use tauri::Manager;

/// Shared application state, managed by Tauri.
pub struct AppState {
    pub store: store::Store,
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
            app.manage(AppState {
                store,
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
            commands::execute,
            commands::cancel,
            commands::set_auto_commit,
            commands::commit,
            commands::rollback,
            commands::apply_edits,
            commands::list_history,
            commands::export_query,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DataTrip");
}

//! Stdio driver for the PostgreSQL contract fixture, using Tauri's actual IPC dispatch.
use datatrip_lib::{commands, ddl, import, AppState};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::Path,
};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test,
    webview::InvokeRequest,
    WebviewUrl, WebviewWindowBuilder,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    write_pre_port_state(dir.path())?;
    let state = tauri::async_runtime::block_on(AppState::open(dir.path(), dir.path()))?;
    tauri::async_runtime::block_on(state.store.add_history(
        "legacy",
        "SELECT 1",
        7,
        Some(1),
        true,
        None,
    ))?;
    let app = test::mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_workspace,
            commands::list_connections,
            commands::list_history,
            commands::list_vault_profiles,
            commands::list_ssh_profiles,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::open_session,
            commands::execute,
            commands::set_auto_commit,
            commands::commit,
            commands::rollback,
            commands::apply_edits,
            commands::export_query_with,
            commands::cancel,
            commands::reconnect_connection,
            commands::close_session,
            commands::redis_scan,
            commands::redis_get,
            commands::redis_delete,
            commands::redis_set_ttl,
            commands::kafka_overview,
            commands::kafka_topic,
            commands::kafka_consume,
            commands::kafka_produce,
            commands::kafka_create_topic,
            commands::kafka_delete_topic,
            import::import_preview,
            ddl::get_ddl,
        ])
        .build(test::mock_context(test::noop_assets()))?;
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default()).build()?;
    std::thread::scope(|scope| -> Result<(), Box<dyn std::error::Error>> {
        for line in io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line?)?;
            let command = request["name"]
                .as_str()
                .ok_or("Missing operation")?
                .to_owned();
            let window = webview.clone();
            scope.spawn(move || {
                let result = test::get_ipc_response(
                    &window,
                    InvokeRequest {
                        cmd: command,
                        callback: CallbackFn(1),
                        error: CallbackFn(2),
                        url: "tauri://localhost".parse().unwrap(),
                        body: InvokeBody::Json(request["args"].clone()),
                        headers: Default::default(),
                        invoke_key: test::INVOKE_KEY.into(),
                    },
                );
                let response = match result {
                    Ok(body) => {
                        json!({"id": request["id"], "result": body.deserialize::<Value>().unwrap()})
                    }
                    Err(err) => json!({"id": request["id"], "error": err}),
                };
                let _ = writeln!(io::stdout().lock(), "{response}");
            });
        }
        Ok(())
    })
}

fn write_pre_port_state(dir: &Path) -> std::io::Result<()> {
    std::fs::write(
        dir.join("settings.json"),
        r#"{"data":{"restoreConsoles":true}}"#,
    )?;
    std::fs::write(
        dir.join("workspace.json"),
        r#"{"version":1,"tabs":[],"active":-1}"#,
    )?;
    std::fs::write(
        dir.join("connections.json"),
        r#"[{"id":"legacy","name":"Pre-port bookmark","driver":"postgres"}]"#,
    )?;
    std::fs::write(
        dir.join("vault_profiles.json"),
        r#"[{"id":"legacy-vault","name":"Pre-port Vault","address":"https://vault.example.org","tokenSource":"keychain"}]"#,
    )?;
    std::fs::write(
        dir.join("ssh_profiles.json"),
        r#"[{"id":"legacy-ssh","name":"Pre-port SSH","host":"ssh.example.org","user":"data"}]"#,
    )
}

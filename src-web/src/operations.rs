//! Versioned, explicitly registered operations and their hosted policy.
use crate::files::{self, Purpose};
use crate::runtime::{BrowserSession, Runtime, WebError, WebResult};
use axum::{
    extract::{rejection::JsonRejection, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use datatrip_core::{
    ai::{self, AiRequest},
    commands as core,
    import::{self, ImportFormat, ImportRequest},
    model::{
        AuthMethod, ConnectionConfig, Driver, ExplorerLayout, ExportFormat, ExportOptions,
        FedSource, KafkaConsumeRequest, KafkaProduceRequest, RedisMode, RowEdit, SshProfile,
        VaultProfile,
    },
    sqlfile::{self, RunOptions},
};
use serde_json::Value;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

// Each entry defines its own typed HTTP handler. No command-name router or IPC bridge.
macro_rules! operations {
    ($(
        $name:ident ($runtime:ident, $session:ident $(, $arg:ident: $kind:ty)* $(,)?) $body:block
    )*) => {
        pub fn routes() -> Router<Arc<Runtime>> {
            Router::new()$(.route(concat!("/operations/", stringify!($name)), post($name)))*
        }
        $(
            async fn $name(
                State($runtime): State<Arc<Runtime>>, headers: HeaderMap,
                body: Result<Json<Value>, JsonRejection>,
            ) -> WebResult<axum::response::Response> {
                let $session = $runtime.authorized(&headers).await?;
                let Json(body) = body.map_err(|_| invalid_arguments())?;
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Args { $($arg: $kind,)* }
                let Args { $($arg,)* } = serde_json::from_value(body).map_err(|_| invalid_arguments())?;
                let _permit = if matches!(stringify!($name), "cancel" | "close_session" | "import_cancel" | "run_sql_file_cancel" | "ai_cancel" | "vault_oidc_cancel") {
                    None
                } else {
                    let busy = |_| WebError::new(StatusCode::TOO_MANY_REQUESTS, "Too many active workspace operations");
                    Some(($session.jobs.try_acquire().map_err(busy)?, $session.workspace.jobs.try_acquire().map_err(busy)?))
                };
                let value = async { $body }.await?;
                bounded_json(&value)
            }
        )*
    };
}

fn check_secret(secret: Option<&str>) -> WebResult<()> {
    if secret.is_some_and(|secret| secret.len() > 16 * 1024) {
        return Err(WebError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Credential exceeds the size limit",
        ));
    }
    Ok(())
}

fn invalid_arguments() -> WebError {
    WebError::new(StatusCode::BAD_REQUEST, "Invalid operation arguments")
}

fn bounded_json(value: &impl serde::Serialize) -> WebResult<axum::response::Response> {
    use axum::response::IntoResponse;
    struct Limited(Vec<u8>);
    impl std::io::Write for Limited {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            if self.0.len() + data.len() > 16 * 1024 * 1024 {
                return Err(std::io::Error::other("Response exceeds 16 MiB"));
            }
            self.0.extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut body = Limited(Vec::new());
    serde_json::to_writer(&mut body, value)
        .map_err(|_| WebError::new(StatusCode::PAYLOAD_TOO_LARGE, "Response exceeds 16 MiB"))?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body.0,
    )
        .into_response())
}

fn validated_config(runtime: &Runtime, config: &ConnectionConfig) -> WebResult<()> {
    if serde_json::to_vec(config).map_or(true, |bytes| bytes.len() > 64 * 1024)
        || config.id.len() > 128
        || config.name.len() > 512
        || config.database.as_ref().is_some_and(|db| db.len() > 512)
        || config
            .username
            .as_ref()
            .is_some_and(|user| user.len() > 512)
        || (config.file_path.is_some() != (config.driver == Driver::Sqlite))
    {
        return Err(WebError::new(
            StatusCode::BAD_REQUEST,
            "This connection uses options unavailable on the hosted runtime",
        ));
    }
    let port = match config.driver {
        Driver::Postgres => 5432,
        Driver::Mysql => 3306,
        Driver::Mssql => 1433,
        Driver::Redis => 6379,
        Driver::Sqlite => return Ok(()),
        Driver::Kafka => {
            if !runtime.config.kafka_network_policy {
                return Err(WebError::new(
                    StatusCode::FORBIDDEN,
                    "Kafka requires a deployment network policy for discovered brokers",
                ));
            }
            let bootstrap = config
                .host
                .as_deref()
                .unwrap_or_default()
                .split(',')
                .map(str::trim);
            return check_endpoints(runtime, bootstrap, config.port.unwrap_or(9092));
        }
    };
    if let Some(redis) = &config.redis {
        if config.driver == Driver::Redis && redis.mode == RedisMode::Sentinel {
            return check_endpoints(runtime, redis.sentinels.iter().map(String::as_str), 26379);
        }
    }
    let ip = config
        .host
        .as_deref()
        .and_then(|host| host.parse::<IpAddr>().ok());
    if ip.is_some_and(|ip| {
        runtime
            .config
            .database_endpoints
            .contains(&SocketAddr::new(ip, config.port.unwrap_or(port)))
    }) {
        return Ok(());
    }
    Err(WebError::new(
        StatusCode::FORBIDDEN,
        "Database address is outside the instance's allowed endpoints",
    ))
}

fn check_endpoints<'a>(
    runtime: &Runtime,
    entries: impl Iterator<Item = &'a str>,
    port: u16,
) -> WebResult<()> {
    let addresses: Vec<_> = entries.take(17).collect();
    if !addresses.is_empty()
        && addresses.len() <= 16
        && addresses.iter().all(|address| {
            let endpoint = address.parse::<SocketAddr>().ok().or_else(|| {
                address
                    .trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .ok()
                    .map(|ip| SocketAddr::new(ip, port))
            });
            endpoint.is_some_and(|endpoint| runtime.config.database_endpoints.contains(&endpoint))
        })
    {
        return Ok(());
    }
    Err(WebError::new(
        StatusCode::FORBIDDEN,
        "Database addresses are outside the instance's allowed endpoints",
    ))
}

async fn validate_saved(runtime: &Runtime, session: &BrowserSession, id: &str) -> WebResult<()> {
    validated_config(runtime, &session.core.store.get_connection(id).await?)
}

async fn validate_credentials(
    session: &BrowserSession,
    config: &ConnectionConfig,
) -> WebResult<()> {
    if config.auth_method == AuthMethod::Vault {
        let vault = config.vault.as_ref().ok_or_else(invalid_arguments)?;
        session
            .core
            .creds
            .prepare_vault(vault, &config.id, true)
            .await?;
    }
    if let Some(id) = &config.ssh_profile_id {
        session.core.profiles.get_ssh(id).await?;
    }
    Ok(())
}

async fn run_on_session<T>(
    session: &BrowserSession,
    id: &str,
    run: impl std::future::Future<Output = datatrip_core::error::AppResult<T>>,
) -> WebResult<T> {
    match tokio::time::timeout(Duration::from_secs(60), run).await {
        Ok(result) => Ok(result?),
        Err(_) => {
            if let Some(connection) = session.core.sessions.remove(id) {
                let _ = tokio::time::timeout(Duration::from_secs(2), connection.close()).await;
            }
            Err(WebError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "Operation timed out and the connection was closed; its outcome may be unknown",
            ))
        }
    }
}

operations! {
    get_settings(_rt, s) { Ok::<_, WebError>(core::get_settings(&s.core).await?) }
    save_settings(_rt, s, settings: Value) { Ok::<_, WebError>(core::save_settings(&s.core, settings).await?) }
    get_workspace(_rt, s) { Ok::<_, WebError>(core::get_workspace(&s.core).await?) }
    save_workspace(_rt, s, workspace: Value) { Ok::<_, WebError>(core::save_workspace(&s.core, workspace).await?) }
    get_explorer_layout(_rt, s) { Ok::<_, WebError>(core::get_explorer_layout(&s.core).await?) }
    save_explorer_layout(_rt, s, layout: ExplorerLayout) { Ok::<_, WebError>(core::save_explorer_layout(&s.core, layout).await?) }
    list_connections(_rt, s) { Ok::<_, WebError>(core::list_connections(&s.core).await?) }
    save_connection(rt, s, config: ConnectionConfig, password: Option<String>, sentinel_password: Option<String>) {
        check_secret(password.as_deref())?;
        check_secret(sentinel_password.as_deref())?;
        validated_config(&rt, &config)?;
        files::database_files(&s.workspace.dir, &config)?;
        let _opening = s.workspace.mutating_connections.lock().await;
        validate_credentials(&s, &config).await?;
        Ok::<_, WebError>(core::save_connection(&s.core, config, password, sentinel_password).await?)
    }
    delete_connection(_rt, s, id: String) {
        let _opening = s.workspace.mutating_connections.lock().await;
        Ok::<_, WebError>(core::delete_connection(&s.core, id).await?)
    }
    list_vault_profiles(_rt, s) { Ok::<_, WebError>(core::list_vault_profiles(&s.core).await?) }
    save_vault_profile(_rt, s, profile: VaultProfile, token: Option<String>) {
        check_secret(token.as_deref())?;
        if serde_json::to_vec(&profile).map_or(true, |bytes| bytes.len() > 16 * 1024) { return Err(invalid_arguments()); }
        let _mutation = s.workspace.mutating_connections.lock().await;
        s.core.creds.authorize_vault(datatrip_core::vault::config_from_profile(&profile))?;
        Ok::<_, WebError>(core::save_vault_profile(&s.core, profile, token).await?)
    }
    delete_vault_profile(_rt, s, id: String) {
        let _mutation = s.workspace.mutating_connections.lock().await;
        Ok::<_, WebError>(core::delete_vault_profile(&s.core, id).await?)
    }
    vault_token_info(_rt, s, profile: VaultProfile, token: Option<String>) {
        Ok::<_, WebError>(core::vault_token_info(&s.core, profile, token).await?)
    }
    renew_vault_token(_rt, s, profile_id: String) {
        Ok::<_, WebError>(core::renew_vault_token(&s.core, profile_id).await?)
    }
    vault_oidc_login(rt, s, profile_id: String, role: Option<String>) {
        crate::vault_oidc::begin(&rt, &s, profile_id, role).await
    }
    vault_oidc_cancel(_rt, s) {
        s.vault_oidc.cancel().await;
        Ok::<_, WebError>(())
    }
    test_vault(_rt, s, config: ConnectionConfig, vault_token: Option<String>) {
        Ok::<_, WebError>(core::test_vault(&s.core, config, vault_token).await?)
    }
    set_vault_token(_rt, s, connection_id: String, token: String) {
        check_secret(Some(&token))?;
        Ok::<_, WebError>(core::set_vault_token(&s.core, connection_id, token).await?)
    }
    list_ssh_profiles(_rt, s) { Ok::<_, WebError>(core::list_ssh_profiles(&s.core).await?) }
    save_ssh_profile(rt, s, profile: SshProfile, secret: Option<String>) {
        check_secret(secret.as_deref())?;
        if serde_json::to_vec(&profile).map_or(true, |bytes| bytes.len() > 16 * 1024) { return Err(invalid_arguments()); }
        crate::runtime::ssh_profile_files(&s.workspace.dir, &rt.config.ssh_endpoints, &profile)?;
        let _mutation = s.workspace.mutating_connections.lock().await;
        Ok::<_, WebError>(core::save_ssh_profile(&s.core, profile, secret).await?)
    }
    delete_ssh_profile(_rt, s, id: String) {
        let _mutation = s.workspace.mutating_connections.lock().await;
        Ok::<_, WebError>(core::delete_ssh_profile(&s.core, id).await?)
    }
    test_ssh_profile(_rt, s, profile: SshProfile, secret: Option<String>) {
        Ok::<_, WebError>(core::test_ssh_profile(&s.core, profile, secret).await?)
    }
    trust_ssh_host(rt, s, host: String, port: u16, fingerprint: String) {
        let address = host.parse::<IpAddr>().ok().map(|ip| SocketAddr::new(ip, port));
        if !address.is_some_and(|address| rt.config.ssh_endpoints.contains(&address)) {
            return Err(WebError::new(StatusCode::FORBIDDEN, "SSH server is outside the instance's allowed endpoints"));
        }
        Ok::<_, WebError>(core::trust_ssh_host(&s.core, host, port, fingerprint).await?)
    }
    ai_providers(_rt, s) { Ok::<_, WebError>(ai::ai_providers(&s.ai).await?) }
    ai_cancel(_rt, s) { Ok::<_, WebError>(ai::ai_cancel(&s.ai).await?) }
    ai_set_api_key(_rt, s, key: Option<String>) {
        check_secret(key.as_deref())?;
        Ok::<_, WebError>(ai::ai_set_api_key(&s.ai, key).await?)
    }
    ai_models(_rt, s, provider: String, base_url: Option<String>, refresh: Option<bool>) {
        Ok::<_, WebError>(ai::ai_models(&s.ai, provider, base_url, refresh).await?)
    }
    ai_generate(_rt, s, request: AiRequest, source_ids: Vec<String>) {
        if request.schema_context.len() > 100_000 || request.prompt.len() > 64_000 {
            return Err(invalid_arguments());
        }
        if source_ids.is_empty() || source_ids.len() > 32 { return Err(invalid_arguments()); }
        let settings = core::get_settings(&s.core).await?;
        for id in source_ids {
            let mut config = s.core.store.get_connection(&id).await?;
            s.core.creds.enforce_read_only(&mut config);
            if settings.pointer("/ai/blockProd") != Some(&Value::Bool(false)) && ai::source_blocks_ai(&config) {
                return Err(WebError::new(StatusCode::FORBIDDEN, "AI is blocked for this production data source"));
            }
        }
        tokio::select! {
            _ = s.runs.stop.cancelled() => Err(WebError::unauthorized()),
            value = ai::ai_generate(&s.ai, request) => Ok::<_, WebError>(value?),
        }
    }
    test_connection(rt, s, config: ConnectionConfig, password: Option<String>, vault_token: Option<String>, sentinel_password: Option<String>) {
        validated_config(&rt, &config)?;
        files::database_files(&s.workspace.dir, &config)?;
        Ok::<_, WebError>(core::test_connection(&s.core, config, password, vault_token, sentinel_password).await?)
    }
    open_session(rt, s, connection_id: String, database: Option<String>) {
        let _opening = s.opening.lock().await;
        if s.jobs.is_closed() { return Err(WebError::unauthorized()); }
        if s.core.sessions.count() >= 16 {
            return Err(WebError::new(StatusCode::TOO_MANY_REQUESTS, "Connection limit reached"));
        }
        let _mutation = s.workspace.mutating_connections.lock().await;
        validate_saved(&rt, &s, &connection_id).await?;
        Ok::<_, WebError>(core::open_session(&s.core, connection_id, database).await?)
    }
    close_session(_rt, s, session_id: String) { Ok::<_, WebError>(core::close_session(&s.core, session_id).await?) }
    introspect(_rt, s, session_id: String) { run_on_session(&s, &session_id, core::introspect(&s.core, session_id.clone())).await }
    list_databases(_rt, s, session_id: String) { run_on_session(&s, &session_id, core::list_databases(&s.core, session_id.clone())).await }
    list_server_objects(_rt, s, session_id: String) { run_on_session(&s, &session_id, core::list_server_objects(&s.core, session_id.clone())).await }
    execute(_rt, s, session_id: String, sql: String, max_rows: u32, history: Option<bool>) {
        if sql.len() > 256 * 1024 { return Err(invalid_arguments()); }
        run_on_session(&s, &session_id, core::execute(&s.core, session_id.clone(), sql, max_rows.min(10_001), history)).await
    }
    cancel(_rt, s, session_id: String) { Ok::<_, WebError>(core::cancel(&s.core, session_id).await?) }
    set_auto_commit(_rt, s, session_id: String, auto_commit: bool) {
        run_on_session(&s, &session_id, core::set_auto_commit(&s.core, session_id.clone(), auto_commit)).await
    }
    commit(_rt, s, session_id: String) { run_on_session(&s, &session_id, core::commit(&s.core, session_id.clone())).await }
    rollback(_rt, s, session_id: String) { run_on_session(&s, &session_id, core::rollback(&s.core, session_id.clone())).await }
    apply_edits(_rt, s, session_id: String, edits: Vec<RowEdit>) {
        run_on_session(&s, &session_id, core::apply_edits(&s.core, session_id.clone(), edits)).await
    }
    list_history(_rt, s, connection_id: Option<String>, search: Option<String>, limit: u32) {
        Ok::<_, WebError>(core::list_history(&s.core, connection_id, search, limit.min(500)).await?)
    }
    prune_history(_rt, s, days: u32) { Ok::<_, WebError>(core::prune_history(&s.core, days).await?) }
    clear_history(_rt, s, connection_id: Option<String>) { Ok::<_, WebError>(core::clear_history(&s.core, connection_id).await?) }
    count_history(_rt, s, connection_id: Option<String>) { Ok::<_, WebError>(core::count_history(&s.core, connection_id).await?) }
    reconnect_connection(_rt, s, connection_id: String) {
        Ok::<_, WebError>(core::reconnect_connection(&s.core, connection_id).await?)
    }
    federated_execute(rt, s, sources: Vec<FedSource>, sql: String, max_rows: u32) {
        if sources.len() > 8 || sql.len() > 256 * 1024 { return Err(invalid_arguments()); }
        let _mutation = s.workspace.mutating_connections.lock().await;
        for source in &sources { validate_saved(&rt, &s, &source.connection_id).await?; }
        tokio::time::timeout(Duration::from_secs(60), core::federated_execute(&s.core, sources, sql, max_rows.min(10_001)))
            .await.map_err(|_| WebError::new(StatusCode::GATEWAY_TIMEOUT, "Cross-source query timed out"))?
            .map_err(Into::into)
    }
    redis_scan(_rt, s, session_id: String, pattern: String, cursor: String, count: u32, key_type: Option<String>) {
        run_on_session(&s, &session_id, core::redis_scan(&s.core, session_id.clone(), pattern, cursor, count.min(5000), key_type)).await
    }
    redis_get(_rt, s, session_id: String, key: String, limit: u32) {
        run_on_session(&s, &session_id, core::redis_get(&s.core, session_id.clone(), key, limit.min(5000))).await
    }
    redis_delete(_rt, s, session_id: String, keys: Vec<String>) {
        run_on_session(&s, &session_id, core::redis_delete(&s.core, session_id.clone(), keys)).await
    }
    redis_set_ttl(_rt, s, session_id: String, key: String, ttl: Option<i64>) {
        run_on_session(&s, &session_id, core::redis_set_ttl(&s.core, session_id.clone(), key, ttl)).await
    }
    kafka_overview(_rt, s, session_id: String) {
        run_on_session(&s, &session_id, core::kafka_overview(&s.core, session_id.clone())).await
    }
    kafka_topic(_rt, s, session_id: String, topic: String) {
        run_on_session(&s, &session_id, core::kafka_topic(&s.core, session_id.clone(), topic)).await
    }
    kafka_consume(_rt, s, session_id: String, request: KafkaConsumeRequest) {
        run_on_session(&s, &session_id, core::kafka_consume(&s.core, session_id.clone(), request)).await
    }
    kafka_produce(_rt, s, session_id: String, request: KafkaProduceRequest) {
        run_on_session(&s, &session_id, core::kafka_produce(&s.core, session_id.clone(), request)).await
    }
    kafka_group(_rt, s, session_id: String, group_id: String) {
        run_on_session(&s, &session_id, core::kafka_group(&s.core, session_id.clone(), group_id)).await
    }
    kafka_reset_offsets(_rt, s, session_id: String, group_id: String, topic: String, to: String, value: Option<i64>) {
        run_on_session(&s, &session_id, core::kafka_reset_offsets(&s.core, session_id.clone(), group_id, topic, to, value)).await
    }
    kafka_create_topic(_rt, s, session_id: String, topic: String, partitions: i32, replication_factor: i32) {
        run_on_session(&s, &session_id, core::kafka_create_topic(&s.core, session_id.clone(), topic, partitions, replication_factor)).await
    }
    kafka_delete_topic(_rt, s, session_id: String, topic: String) {
        run_on_session(&s, &session_id, core::kafka_delete_topic(&s.core, session_id.clone(), topic)).await
    }
    get_ddl(_rt, s, session_id: String, request: datatrip_core::ddl::DdlRequest) {
        run_on_session(&s, &session_id, datatrip_core::ddl::get_ddl(&s.core, session_id.clone(), request)).await
    }
    table_extras(_rt, s, session_id: String, schema: Option<String>, table: String) {
        run_on_session(&s, &session_id, datatrip_core::ddl::table_extras(&s.core, session_id.clone(), schema, table)).await
    }
    read_text_file(_rt, s, path: String) {
        let file = files::resolve(&s, &path, &[Purpose::Text, Purpose::Sql], true)?;
        Ok::<_, WebError>(core::read_text_file(file).await?)
    }
    write_text_file(_rt, s, path: String, content: String) {
        let _write = s.workspace.file_writes.lock().await;
        let file = files::resolve(&s, &path, &[Purpose::Output], false)?;
        files::check_write(&s, &file, content.len() as u64).await?;
        Ok::<_, WebError>(core::write_text_file(file, content).await?)
    }
    sql_file_read(_rt, s, path: String) {
        let file = files::resolve(&s, &path, &[Purpose::Sql], true)?;
        Ok::<_, WebError>(sqlfile::sql_file_read(file).await?)
    }
    sql_file_write(_rt, s, path: String, text: String, expected_mtime_ms: Option<f64>, bom: Option<bool>) {
        let _write = s.workspace.file_writes.lock().await;
        let file = files::resolve(&s, &path, &[Purpose::Sql], false)?;
        files::check_write(&s, &file, text.len() as u64 + 3).await?;
        Ok::<_, WebError>(sqlfile::sql_file_write(file, text, expected_mtime_ms, bom).await?)
    }
    file_mtime(_rt, s, path: String) {
        let file = files::resolve(&s, &path, &[Purpose::Sql, Purpose::Script], false)?;
        Ok::<_, WebError>(sqlfile::file_mtime(file).await?)
    }
    import_preview(_rt, s, path: String, format: Option<ImportFormat>, check_types: Option<Vec<Option<String>>>) {
        let file = files::resolve(&s, &path, &[Purpose::Import], true)?;
        Ok::<_, WebError>(import::import_preview(file, format, check_types).await?)
    }
    import_run(_rt, s, session_id: String, path: String, request: ImportRequest, run_id: String) {
        let path = files::resolve(&s, &path, &[Purpose::Import], true)?;
        crate::jobs::run(s.clone(), run_id.clone(), session_id.clone(), move |session| async move {
            let emit = |progress: &import::ImportProgress| session.runs.publish(import::PROGRESS_EVENT, progress);
            import::import_run(&emit, &session.core, &session.import_runs, session_id, path, request, run_id).await
        }).await
    }
    import_cancel(_rt, s, run_id: String) {
        Ok::<_, WebError>(import::import_cancel(&s.import_runs, run_id).await?)
    }
    run_sql_file(_rt, s, session_id: String, path: String, options: RunOptions, run_id: String) {
        let path = files::resolve(&s, &path, &[Purpose::Sql, Purpose::Script], true)?;
        crate::jobs::run(s.clone(), run_id.clone(), session_id.clone(), move |session| async move {
            let emit = |progress: &sqlfile::RunProgress| session.runs.publish(sqlfile::PROGRESS_EVENT, progress);
            sqlfile::run_sql_file(&emit, &session.core, &session.sql_runs, session_id, path, options, run_id).await
        }).await
    }
    run_sql_file_cancel(_rt, s, run_id: String) {
        Ok::<_, WebError>(sqlfile::run_sql_file_cancel(&s.sql_runs, run_id).await?)
    }
    export_query(_rt, s, session_id: String, sql: String, format: ExportFormat, path: String) {
        let _write = s.workspace.file_writes.lock().await;
        let target = files::resolve(&s, &path, &[Purpose::Output], false)?;
        files::check_write(&s, &target, files::EXPORT_LIMIT).await?;
        let stage = files::ExportStage::new(&target);
        let value = run_on_session(&s, &session_id, core::export_query(&s.core, session_id.clone(), sql, format, stage.path.clone())).await?;
        stage.complete(&target)?;
        Ok::<_, WebError>(value)
    }
    export_query_with(_rt, s, session_id: String, sql: String, options: ExportOptions, path: String) {
        let _write = s.workspace.file_writes.lock().await;
        let target = files::resolve(&s, &path, &[Purpose::Output], false)?;
        files::check_write(&s, &target, files::EXPORT_LIMIT).await?;
        let stage = files::ExportStage::new(&target);
        let value = run_on_session(&s, &session_id, core::export_query_with(&s.core, session_id.clone(), sql, options, stage.path.clone())).await?;
        stage.complete(&target)?;
        Ok::<_, WebError>(value)
    }
}

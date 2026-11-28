use crate::{
    auth,
    runtime::{BrowserSession, Runtime, WebError, WebResult},
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use datatrip_core::{
    error::{AppError, AppResult},
    model::{VaultProfile, VaultTokenInfo, VaultTokenSource},
    vault::{self, VaultOidcExchange},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

const CALLBACK: &str = "/api/v1/vault-oidc/callback";
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct Flow(Mutex<Option<Pending>>);

struct Pending {
    id: Uuid,
    state: String,
    profile: VaultProfile,
    exchange: Option<VaultOidcExchange>,
    deadline: Instant,
    outcome: Option<AppResult<VaultTokenInfo>>,
}

impl Flow {
    pub async fn cancel(&self) {
        if let Some(pending) = self.0.lock().await.as_mut() {
            pending.exchange = None;
            pending.outcome = Some(Err(AppError::new(
                "OIDC_CANCELLED: Vault sign-in cancelled",
            )));
        }
    }
}

#[derive(Serialize)]
pub struct Started {
    id: Uuid,
    url: url::Url,
}

pub async fn begin(
    runtime: &Runtime,
    session: &BrowserSession,
    profile_id: String,
    role: Option<String>,
) -> WebResult<Started> {
    if runtime.config.public_origin.scheme() != "https" {
        return Err(WebError::new(
            StatusCode::FORBIDDEN,
            "Hosted Vault OIDC requires HTTPS",
        ));
    }
    let mut flow = session.vault_oidc.0.lock().await;
    let profile = session.core.profiles.get_vault(&profile_id).await?;
    if profile.token_source != VaultTokenSource::Oidc {
        return Err(AppError::new("This is not an OIDC Vault profile").into());
    }
    if profile.oidc_mount.as_deref().is_some_and(|mount| {
        !mount
            .trim_matches('/')
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }) {
        return Err(AppError::new("Invalid Vault OIDC mount").into());
    }
    let config = session
        .core
        .creds
        .authorize_vault(vault::config_from_profile(&profile))?;
    let redirect_uri = runtime
        .config
        .public_origin
        .join(CALLBACK)
        .map_err(|_| WebError::internal())?;
    let (url, exchange) =
        VaultOidcExchange::start(config, &profile, role, redirect_uri.as_str()).await?;
    let url = url::Url::parse(&url).map_err(|_| WebError::internal())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::new("Vault returned an invalid OIDC authorization URL").into());
    }
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| AppError::new("Vault returned no OIDC state"))?;
    let id = Uuid::new_v4();
    *flow = Some(Pending {
        id,
        state,
        profile,
        exchange: Some(exchange),
        deadline: Instant::now() + TIMEOUT,
        outcome: None,
    });
    Ok(Started { id, url })
}

pub fn routes() -> Router<Arc<Runtime>> {
    Router::new()
        .route("/vault-oidc/callback", get(callback))
        .route("/vault-oidc/{id}", get(status))
}

async fn status(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> WebResult<Json<Option<VaultTokenInfo>>> {
    let session = runtime.authorized(&headers).await?;
    let mut flow = session.vault_oidc.0.lock().await;
    let pending = flow
        .as_mut()
        .filter(|pending| pending.id == id)
        .ok_or_else(|| AppError::new("OIDC_CANCELLED: Vault sign-in was replaced"))?;
    if pending.deadline <= Instant::now() {
        pending.exchange = None;
        return Err(AppError::new("OIDC_TIMEOUT: Vault sign-in timed out").into());
    }
    match &pending.outcome {
        Some(result) => Ok(Json(Some(result.clone()?))),
        None => Ok(Json(None)),
    }
}

#[derive(Deserialize)]
struct Callback {
    state: String,
    code: Option<String>,
}

async fn callback(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Response {
    let complete = async {
        let session = runtime
            .session(auth::cookie(&headers, auth::SESSION))
            .await?;
        let mut flow = session.vault_oidc.0.lock().await;
        let pending = flow
            .as_mut()
            .filter(|pending| pending.deadline > Instant::now() && pending.state == query.state)?;
        let exchange = pending.exchange.take()?;
        let result: AppResult<_> = async {
            let code = query
                .code
                .ok_or_else(|| AppError::new("Vault OIDC sign-in was declined"))?;
            let token = exchange.finish(&code, &query.state).await?;
            let _mutation = session.workspace.mutating_connections.lock().await;
            let current = session.core.profiles.get_vault(&pending.profile.id).await?;
            if serde_json::to_value(&current)? != serde_json::to_value(&pending.profile)?
                || session.runs.stop.is_cancelled()
            {
                return Err(AppError::new(
                    "Vault profile or browser session changed during sign-in",
                ));
            }
            session.core.profiles.set_vault_token(&current.id, &token)?;
            for id in session
                .core
                .profiles
                .connections_using_vault(&current.id)
                .await?
            {
                session.core.vault_cache.invalidate(&id);
            }
            let config = session
                .core
                .creds
                .authorize_vault(vault::config_from_profile(&current))?;
            vault::token_info(&config, None, Some(token), false)
                .await
                .map_err(|error| {
                    datatrip_core::commands::token_error(error, &current.id, &current.name)
                })
        }
        .await;
        let success = result.is_ok();
        pending.outcome = Some(result);
        Some(success)
    }
    .await;
    let message = if complete == Some(true) {
        "Vault sign-in completed. You can close this tab."
    } else {
        "Vault sign-in failed. Return to DataTrip to try again."
    };
    (
        [(axum::http::header::REFERRER_POLICY, "no-referrer")],
        Html(message),
    )
        .into_response()
}

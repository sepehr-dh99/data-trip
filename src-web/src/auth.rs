use crate::{
    config::Config,
    runtime::{BrowserSession, Owner, Runtime, WebError, WebResult},
};
use anyhow::{bail, Context, Result};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, SaltString},
    Argon2, PasswordHasher, PasswordVerifier,
};
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use openidconnect::{
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
    reqwest, AccessTokenHash, AuthorizationCode, ClientId, ClientSecret, CsrfToken,
    EndpointMaybeSet, EndpointNotSet, EndpointSet, IssuerUrl, Nonce, OAuth2TokenResponse,
    PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, TokenResponse,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const SESSION: &str = "datatrip_session";
const OIDC_COOKIE: &str = "datatrip_oidc";
const CALLBACK: &str = "/api/v1/login/oidc/callback";
const OIDC_TIMEOUT: u64 = 300;

type Provider = CoreClient<
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointMaybeSet,
    EndpointMaybeSet,
>;
pub struct OidcClient {
    http: reqwest::Client,
    provider: Provider,
}

pub struct PendingOidc {
    pub expires: Instant,
    csrf: CsrfToken,
    nonce: Nonce,
    verifier: PkceCodeVerifier,
    session: Option<Uuid>,
}

pub async fn discover(config: &Config) -> Result<Option<OidcClient>> {
    let Some(oidc) = &config.auth.oidc else {
        return Ok(None);
    };
    let secure = |url: &url::Url| {
        url.scheme() == "https"
            || (config.public_origin.scheme() == "http"
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    };
    let issuer = IssuerUrl::new(oidc.issuer.clone()).context("Invalid OIDC issuer URL")?;
    if oidc.client_id.trim().is_empty()
        || !secure(issuer.url())
        || issuer.url().host().is_none()
        || !issuer.url().username().is_empty()
        || issuer.url().password().is_some()
        || issuer.url().query().is_some()
        || issuer.url().fragment().is_some()
    {
        bail!("Invalid OIDC client or issuer configuration");
    }
    let secret = oidc
        .client_secret_env
        .as_ref()
        .map(|name| {
            std::env::var(name)
                .ok()
                .filter(|secret| !secret.is_empty())
                .map(ClientSecret::new)
                .context("Missing configured OIDC client secret")
        })
        .transpose()?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()?;
    let metadata = CoreProviderMetadata::discover_async(issuer, &http)
        .await
        .map_err(|_| anyhow::anyhow!("OIDC discovery failed"))?;
    if !secure(metadata.authorization_endpoint().url())
        || !metadata
            .token_endpoint()
            .is_some_and(|endpoint| secure(endpoint.url()))
        || !secure(metadata.jwks_uri().url())
    {
        bail!("OIDC provider did not supply secure endpoints");
    }
    let provider =
        CoreClient::from_provider_metadata(metadata, ClientId::new(oidc.client_id.clone()), secret)
            .set_redirect_uri(RedirectUrl::from_url(config.public_origin.join(CALLBACK)?));
    Ok(Some(OidcClient { http, provider }))
}

pub fn hash_password(stdin: bool) -> Result<()> {
    let password = if stdin {
        use std::io::BufRead;
        std::io::stdin()
            .lock()
            .lines()
            .next()
            .transpose()?
            .unwrap_or_default()
    } else {
        let password = rpassword::prompt_password("Password: ")?;
        if password != rpassword::prompt_password("Confirm password: ")? {
            bail!("Passwords did not match");
        }
        password
    };
    if password.is_empty() || password.len() > 1024 {
        bail!("Passwords did not match or have an invalid length");
    }
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default().hash_password(password.as_bytes(), &salt)?;
    println!("{hash}");
    Ok(())
}

pub fn cookie(headers: &HeaderMap, name: &str) -> Option<Uuid> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| Uuid::parse_str(value).ok()).flatten())
}

fn set_cookie(
    runtime: &Runtime,
    name: &str,
    value: Option<Uuid>,
    seconds: u64,
) -> header::HeaderValue {
    let token = value.map(|id| id.to_string()).unwrap_or_default();
    let secure = if runtime.config.public_origin.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    format!("{name}={token}; Path=/; Max-Age={seconds}; HttpOnly; SameSite=Lax{secure}")
        .parse()
        .unwrap()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescription {
    workspace_id: Uuid,
    binding: Uuid,
    guest: bool,
}

impl From<&BrowserSession> for SessionDescription {
    fn from(session: &BrowserSession) -> Self {
        Self {
            workspace_id: session.workspace.id,
            binding: session.binding,
            guest: session.workspace.guest,
        }
    }
}

#[derive(Serialize)]
pub struct Entry {
    session: Option<SessionDescription>,
    anonymous: bool,
    local: bool,
    oidc: bool,
    version: &'static str,
}

pub async fn session(State(runtime): State<Arc<Runtime>>, headers: HeaderMap) -> Json<Entry> {
    Json(Entry {
        session: runtime
            .session(cookie(&headers, SESSION))
            .await
            .as_deref()
            .map(Into::into),
        anonymous: runtime.config.auth.anonymous,
        local: runtime.config.auth.local.is_some(),
        oidc: runtime.oidc.is_some(),
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Deserialize)]
pub struct Login {
    username: String,
    password: String,
}

pub async fn login(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
    Json(login): Json<Login>,
) -> WebResult<Response> {
    let credentials = || WebError::new(StatusCode::UNAUTHORIZED, "Invalid username or password");
    let local = runtime.config.auth.local.as_ref().ok_or_else(credentials)?;
    if login.username.len() > 128 || login.password.len() > 1024 {
        return Err(credentials());
    }
    let user = local
        .users
        .iter()
        .find(|user| user.username == login.username);
    let user_key = user.map_or("", |user| user.username.as_str());
    {
        let now = Instant::now();
        let mut attempts = runtime.login_attempts.lock().await;
        let window = attempts
            .entry(user_key.to_owned())
            .or_insert((now + Duration::from_secs(60), 0));
        if now >= window.0 {
            *window = (now + Duration::from_secs(60), 0);
        }
        if window.1 >= 8 || attempts.values().map(|slot| u16::from(slot.1)).sum::<u16>() >= 40 {
            return Err(WebError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many sign-in attempts; try again in a minute",
            ));
        }
        attempts.get_mut(user_key).expect("window exists").1 += 1;
    }
    let hash = user.unwrap_or(&local.users[0]).password_hash.clone();
    let password = login.password;
    let worker = runtime
        .login_workers
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            WebError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Sign-in is busy; try again shortly",
            )
        })?;
    let valid = tokio::task::spawn_blocking(move || {
        let _worker = worker;
        PasswordHash::new(&hash).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .map_err(|_| WebError::internal())?;
    let user = user.filter(|_| valid).ok_or_else(credentials)?;
    enter(
        &runtime,
        &headers,
        Owner::Local {
            id: user.id.clone(),
        },
    )
    .await
}

pub async fn guest(State(runtime): State<Arc<Runtime>>, headers: HeaderMap) -> WebResult<Response> {
    if !runtime.config.auth.anonymous {
        return Err(WebError::unauthorized());
    }
    enter(&runtime, &headers, Owner::Guest { id: Uuid::new_v4() }).await
}

async fn enter(runtime: &Runtime, headers: &HeaderMap, owner: Owner) -> WebResult<Response> {
    let (token, session) = runtime.login(cookie(headers, SESSION), owner).await?;
    let mut response = Json(SessionDescription::from(&*session)).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(
            runtime,
            SESSION,
            Some(token),
            runtime.config.session_seconds,
        ),
    );
    Ok(response)
}

pub async fn logout(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
) -> WebResult<Response> {
    if let Some(token) = cookie(&headers, SESSION) {
        runtime.authorized(&headers).await?;
        runtime.logout(token).await;
    }
    if let Some(pending) = cookie(&headers, OIDC_COOKIE) {
        runtime.oidc_pending.lock().await.remove(&pending);
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    for name in [SESSION, OIDC_COOKIE] {
        response
            .headers_mut()
            .append(header::SET_COOKIE, set_cookie(&runtime, name, None, 0));
    }
    Ok(response)
}

pub async fn oidc_start(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
) -> WebResult<Response> {
    let client = runtime.oidc.as_ref().ok_or_else(WebError::unauthorized)?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, csrf, nonce) = client
        .provider
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .set_pkce_challenge(challenge)
        .url();
    let mut pending = runtime.oidc_pending.lock().await;
    if let Some(old) = cookie(&headers, OIDC_COOKIE) {
        pending.remove(&old);
    }
    if pending.len() >= 256 {
        return Err(WebError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many pending sign-ins",
        ));
    }
    let key = Uuid::new_v4();
    pending.insert(
        key,
        PendingOidc {
            expires: Instant::now() + Duration::from_secs(OIDC_TIMEOUT),
            csrf,
            nonce,
            verifier,
            session: cookie(&headers, SESSION),
        },
    );
    let mut response = Json(serde_json::json!({ "url": url })).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(&runtime, OIDC_COOKIE, Some(key), OIDC_TIMEOUT),
    );
    Ok(response)
}

#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: Option<String>,
}

pub async fn oidc_callback(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Response {
    let result = finish_oidc(&runtime, &headers, query).await;
    let mut response = Redirect::to(if result.is_ok() {
        "/"
    } else {
        "/?signInFailed=1"
    })
    .into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(&runtime, OIDC_COOKIE, None, 0),
    );
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    if let Ok(token) = result {
        response.headers_mut().append(
            header::SET_COOKIE,
            set_cookie(
                &runtime,
                SESSION,
                Some(token),
                runtime.config.session_seconds,
            ),
        );
    }
    response
}

async fn finish_oidc(runtime: &Runtime, headers: &HeaderMap, query: Callback) -> Result<Uuid> {
    let client = runtime.oidc.as_ref().context("OIDC disabled")?;
    let key = cookie(headers, OIDC_COOKIE).context("Missing login cookie")?;
    let pending = runtime
        .oidc_pending
        .lock()
        .await
        .remove(&key)
        .context("No pending login")?;
    if pending.expires < Instant::now()
        || pending.session != cookie(headers, SESSION)
        || query.state.as_ref() != Some(pending.csrf.secret())
    {
        bail!("Invalid login state");
    }
    let token = client
        .provider
        .exchange_code(AuthorizationCode::new(query.code.context("No login code")?))?
        .set_pkce_verifier(pending.verifier)
        .request_async(&client.http)
        .await?;
    let id = token.id_token().context("No identity token")?;
    let verifier = client.provider.id_token_verifier();
    let claims = id.claims(&verifier, &pending.nonce)?;
    if let Some(expected) = claims.access_token_hash() {
        let actual = AccessTokenHash::from_token(
            token.access_token(),
            id.signing_alg()?,
            id.signing_key(&verifier)?,
        )?;
        if &actual != expected {
            bail!("Invalid access token binding");
        }
    }
    let owner = Owner::Oidc {
        issuer: claims.issuer().as_str().to_owned(),
        subject: claims.subject().as_str().to_owned(),
    };
    let (token, _) = runtime
        .login(pending.session, owner)
        .await
        .map_err(|_| anyhow::anyhow!("Workspace unavailable"))?;
    Ok(token)
}

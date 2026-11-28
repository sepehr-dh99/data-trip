mod auth;
mod config;
mod files;
mod jobs;
mod operations;
mod runtime;
mod vault_oidc;

use anyhow::{bail, Context, Result};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, get_service, post},
    Router,
};
use runtime::Runtime;
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config_path = match args.as_slice() {
        [command] if command == "hash-password" => return auth::hash_password(false),
        [command, flag] if command == "hash-password" && flag == "--stdin" => {
            return auth::hash_password(true)
        }
        [command] if command == "healthcheck" => return healthcheck(),
        [flag, path] if flag == "--config" => path,
        _ => bail!("Usage: datatrip-web --config <path> | hash-password [--stdin] | healthcheck"),
    };
    let (config, key) = config::Config::load(config_path)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run(config, key));
    runtime.shutdown_timeout(Duration::from_secs(2));
    result
}

async fn run(config: config::Config, key: [u8; 32]) -> Result<()> {
    let bind = config.bind;
    let assets = config.assets_dir.clone();
    let runtime = Runtime::open(config, key).await?;
    let api = operations::routes()
        .merge(files::routes())
        .merge(jobs::routes())
        .merge(vault_oidc::routes())
        .route("/session", get(auth::session))
        .route("/login/local", post(auth::login))
        .route("/login/guest", post(auth::guest))
        .route("/login/oidc", post(auth::oidc_start))
        .route("/login/oidc/callback", get(auth::oidc_callback))
        .route("/logout", post(auth::logout))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(axum::extract::DefaultBodyLimit::max(10 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(runtime.clone(), api_policy));
    let app = Router::new()
        .route("/livez", get(|| async { StatusCode::OK }))
        .route("/readyz", get(ready))
        .nest("/api/v1", api)
        .nest_service(
            "/assets",
            ServeDir::new(assets.join("assets")).precompressed_gzip(),
        )
        .route_service("/", get_service(ServeFile::new(assets.join("web.html"))))
        .layer(middleware::from_fn(static_policy))
        .layer(CompressionLayer::new())
        .with_state(runtime.clone());
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .context("Bind web listener")?;
    eprintln!("DataTrip web listening on {}", listener.local_addr()?);
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let deadline = Duration::from_secs(runtime.config.drain_seconds);
    let signal_runtime = runtime.clone();
    let mut server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    tokio::select! {
        result = &mut server => { result??; }
        () = shutdown_signal() => {
            signal_runtime.draining.store(true, Ordering::Release);
            if tokio::time::timeout(deadline, async {
                signal_runtime.shutdown().await;
                let _ = stop.send(());
                (&mut server).await
            }).await.is_err() {
                server.abort();
            }
        }
    }
    Ok(())
}

fn healthcheck() -> Result<()> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    let port = std::env::var("DATATRIP_PROBE_PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse()?;
    let timeout = Duration::from_secs(2);
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut socket = TcpStream::connect_timeout(&address, timeout)?;
    socket.set_read_timeout(Some(timeout))?;
    socket.set_write_timeout(Some(timeout))?;
    socket.write_all(b"GET /readyz HTTP/1.0\r\n\r\n")?;
    let mut status = String::new();
    BufReader::new(socket).read_line(&mut status)?;
    if status.split_ascii_whitespace().nth(1) != Some("200") {
        bail!("DataTrip web is not ready");
    }
    Ok(())
}

async fn ready(State(runtime): State<Arc<Runtime>>) -> StatusCode {
    if runtime.draining.load(Ordering::Acquire) {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    }
}

async fn api_policy(State(runtime): State<Arc<Runtime>>, req: Request, next: Next) -> Response {
    let allowed = req.method().is_safe()
        || req
            .headers()
            .get(header::ORIGIN)
            .and_then(|origin| origin.to_str().ok())
            == Some(runtime.origin.as_str());
    let mut response = if !allowed {
        (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({"message":"Invalid request origin"})),
        )
            .into_response()
    } else if runtime.draining.load(Ordering::Acquire) {
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    } else {
        next.run(req).await
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

async fn static_policy(req: Request, next: Next) -> Response {
    let asset = req.uri().path().starts_with("/assets/");
    let index = req.uri().path() == "/";
    let mut response = next.run(req).await;
    if response.status().is_success() && (asset || index) {
        let cache = if asset {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, cache.parse().unwrap());
    }
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"
            .parse().unwrap(),
    );
    response
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

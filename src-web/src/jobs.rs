use crate::runtime::{BrowserSession, Runtime, WebError, WebResult};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Json, Router,
};
use datatrip_core::error::AppError;
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::{broadcast, watch, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Status {
    Running,
    Success { value: Value },
    Failure { error: AppError },
}

#[derive(Clone)]
struct Progress {
    name: &'static str,
    json: String,
}

pub struct Runs {
    pub stop: CancellationToken,
    entries: Mutex<HashMap<Uuid, watch::Receiver<Status>>>,
    events: broadcast::Sender<Progress>,
}

impl Default for Runs {
    fn default() -> Self {
        Self {
            stop: CancellationToken::new(),
            entries: Mutex::new(HashMap::new()),
            events: broadcast::channel(16).0,
        }
    }
}

impl Runs {
    pub fn publish(&self, name: &'static str, payload: &impl Serialize) {
        if self.events.receiver_count() == 0 {
            return;
        }
        if let Ok(json) = serde_json::to_string(payload) {
            if json.len() <= 256 * 1024 {
                let _ = self.events.send(Progress { name, json });
            }
        }
    }
}

pub async fn run<T, F, Fut>(
    session: Arc<BrowserSession>,
    id: String,
    database_session: String,
    action: F,
) -> WebResult<Value>
where
    T: Serialize + Send + 'static,
    F: FnOnce(Arc<BrowserSession>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, AppError>> + Send + 'static,
{
    let id = Uuid::parse_str(&id)
        .map_err(|_| WebError::new(StatusCode::BAD_REQUEST, "Invalid run ID"))?;
    let (sender, mut receiver) = watch::channel(Status::Running);
    {
        let mut entries = session.runs.entries.lock().await;
        if entries.contains_key(&id) {
            return Err(WebError::new(
                StatusCode::CONFLICT,
                "Run ID already used; check its status",
            ));
        }
        if entries.len() >= 128
            || entries
                .values()
                .filter(|status| matches!(*status.borrow(), Status::Running))
                .count()
                >= 2
        {
            return Err(WebError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Workspace run limit reached",
            ));
        }
        entries.insert(id, receiver.clone());
    }
    tokio::spawn(async move {
        let action_session = session.clone();
        let result = tokio::select! {
            _ = session.runs.stop.cancelled() => Err(AppError::new("Session ended; job stopped")),
            result = tokio::time::timeout(Duration::from_secs(300), action(action_session)) => {
                match result {
                    Ok(result) => result,
                    Err(_) => {
                        if let Some(connection) = session.core.sessions.remove(&database_session) {
                            let _ = tokio::time::timeout(Duration::from_secs(2), connection.close()).await;
                        }
                        Err(AppError::new("Job timed out; its write outcome may be unknown"))
                    }
                }
            },
        };
        let status = match result.and_then(|value| Ok(serde_json::to_value(value)?)) {
            Ok(value) => Status::Success { value },
            Err(error) => Status::Failure { error },
        };
        let _ = sender.send(status);
    });
    let result = receiver
        .wait_for(|status| !matches!(status, Status::Running))
        .await
        .map_err(|_| WebError::internal())?
        .clone();
    match result {
        Status::Success { value } => Ok(value),
        Status::Failure { error } => Err(error.into()),
        Status::Running => unreachable!(),
    }
}

pub fn routes() -> Router<Arc<Runtime>> {
    Router::new()
        .route("/events", get(events))
        .route("/jobs/{id}", get(status))
}

async fn status(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> WebResult<Json<Status>> {
    let session = runtime.authorized(&headers).await?;
    let entries = session.runs.entries.lock().await;
    let result = entries
        .get(&id)
        .ok_or_else(|| WebError::new(StatusCode::NOT_FOUND, "Unknown run ID"))?
        .borrow()
        .clone();
    Ok(Json(result))
}

async fn events(
    State(runtime): State<Arc<Runtime>>,
    headers: HeaderMap,
) -> WebResult<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>> {
    let session = runtime.authorized(&headers).await?;
    let permit = session
        .events_permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            WebError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Event connection limit reached",
            )
        })?;
    let receiver = session.runs.events.subscribe();
    let stop = session.runs.stop.clone();
    let stream = futures::stream::unfold(
        (receiver, stop, permit),
        |(mut receiver, stop, permit)| async move {
            loop {
                let received = tokio::select! {
                    _ = stop.cancelled() => return None,
                    event = receiver.recv() => event,
                };
                match received {
                    Ok(event) => {
                        return Some((
                            Ok(Event::default().event(event.name).data(event.json)),
                            (receiver, stop, permit),
                        ))
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue, // terminal status remains available via /jobs
                }
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default().interval(Duration::from_secs(10))))
}

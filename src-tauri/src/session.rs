//! Open sessions: one dedicated physical connection each, with cancel and manual-transaction support.

use crate::credentials::CredentialSource;
use crate::db::{self, DbConn};
use crate::error::{AppError, AppResult};
use crate::export;
use crate::model::{
    ConnectionConfig, DatabaseNode, Driver, ExportFormat, ObjectGroup, QueryResult,
    RedisScanResult, RedisValue, RowEdit, SchemaNode, SessionInfo,
};
use crate::model::{
    KafkaConsumeRequest, KafkaConsumeResult, KafkaGroupDetail, KafkaOverview, KafkaProduceRequest,
    KafkaProduceResult, KafkaTopicDetail,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::task::AbortHandle;

pub enum Job {
    Execute {
        sql: String,
        max_rows: usize,
    },
    Export {
        sql: String,
        format: ExportFormat,
        path: String,
    },
    Introspect,
    ListDatabases,
    ServerObjects,
    Edits(Vec<RowEdit>),
    Simple(String),
    RedisScan {
        pattern: String,
        cursor: String,
        count: u32,
        key_type: Option<String>,
    },
    RedisGet {
        key: String,
        limit: usize,
    },
    RedisDelete(Vec<String>),
    RedisSetTtl {
        key: String,
        ttl: Option<i64>,
    },
    KafkaOverview,
    KafkaTopic(String),
    KafkaConsume(KafkaConsumeRequest),
    KafkaProduce(KafkaProduceRequest),
    KafkaGroup(String),
    KafkaResetOffsets {
        group: String,
        topic: String,
        to: String,
        value: Option<i64>,
    },
    KafkaCreateTopic {
        topic: String,
        partitions: i32,
        replication: i32,
    },
    KafkaDeleteTopic(String),
}

pub enum JobOut {
    Query(QueryResult),
    Count(u64),
    Schema(Vec<SchemaNode>),
    Databases(Vec<DatabaseNode>),
    Groups(Vec<ObjectGroup>),
    RedisScan(RedisScanResult),
    RedisValue(RedisValue),
    KafkaOverview(KafkaOverview),
    KafkaTopic(KafkaTopicDetail),
    KafkaConsume(KafkaConsumeResult),
    KafkaProduce(KafkaProduceResult),
    KafkaGroup(KafkaGroupDetail),
    Unit,
}

pub struct Session {
    pub id: String,
    pub config: ConnectionConfig,
    /// Re-resolves credentials (keychain password or Vault secret) on every (re)connect.
    creds: CredentialSource,
    conn: tokio::sync::Mutex<Option<DbConn>>,
    auto_commit: AtomicBool,
    in_tx: AtomicBool,
    broken: AtomicBool,
    /// Abort handles of spawned jobs (running or waiting for the connection), by job number.
    running: Mutex<HashMap<u64, AbortHandle>>,
    next_job: AtomicU64,
    /// Job number that most recently acquired the connection.
    active_job: AtomicU64,
    backend_id: Mutex<Option<i64>>,
}

/// Marks the session's connection broken if dropped while armed, i.e. when the job that owns
/// the connection is aborted (cancel/close) or panics mid-protocol. Runs before the connection
/// lock is released, so the next job always sees the flag.
struct BrokenOnAbort<'a> {
    session: &'a Session,
    armed: bool,
}

impl Drop for BrokenOnAbort<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.session.broken.store(true, Ordering::SeqCst);
        }
    }
}

/// Drivers without transactions: BEGIN/COMMIT/ROLLBACK are never issued.
fn has_no_transactions(d: Driver) -> bool {
    matches!(d, Driver::Redis | Driver::Kafka)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Session {
    /// Connects and registers nothing; the caller inserts the session into the registry.
    pub async fn open(
        config: ConnectionConfig,
        creds: CredentialSource,
    ) -> AppResult<(Arc<Session>, SessionInfo)> {
        let connected = creds.connect(&config, None, None, true).await?;
        let info = SessionInfo {
            session_id: uuid::Uuid::new_v4().to_string(),
            connection_id: config.id.clone(),
            driver: config.driver,
            server_version: connected.server_version.clone(),
            default_schema: connected.default_schema.clone(),
            database: connected.database.clone(),
        };
        let session = Arc::new(Session {
            id: info.session_id.clone(),
            config,
            creds,
            conn: tokio::sync::Mutex::new(Some(connected.conn)),
            auto_commit: AtomicBool::new(true),
            in_tx: AtomicBool::new(false),
            broken: AtomicBool::new(false),
            running: Mutex::new(HashMap::new()),
            next_job: AtomicU64::new(0),
            active_job: AtomicU64::new(0),
            backend_id: Mutex::new(connected.backend_id),
        });
        Ok((session, info))
    }

    /// Reconnects when the connection is missing or was marked broken.
    fn ensure_connected<'a>(
        &'a self,
        slot: &'a mut Option<DbConn>,
    ) -> futures::future::BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            if slot.is_some() && !self.broken.load(Ordering::SeqCst) {
                return Ok(());
            }
            // Drop the old connection without a graceful close (it may be mid-protocol).
            drop(slot.take());
            let lost_tx = self.in_tx.swap(false, Ordering::SeqCst);
            let connected = self.creds.connect(&self.config, None, None, true).await?;
            *lock(&self.backend_id) = connected.backend_id;
            *slot = Some(connected.conn);
            self.broken.store(false, Ordering::SeqCst);
            if lost_tx {
                return Err(AppError::new(
                    "The connection was reset and the open transaction was rolled back. \
                     Run your statements again.",
                ));
            }
            Ok(())
        })
    }

    fn begin_if_needed<'a>(
        &'a self,
        conn: &'a mut DbConn,
    ) -> futures::future::BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            if !self.auto_commit.load(Ordering::SeqCst) && !self.in_tx.load(Ordering::SeqCst) {
                conn.run_simple(db::begin_sql(self.config.driver)).await?;
                self.in_tx.store(true, Ordering::SeqCst);
            }
            Ok(())
        })
    }

    fn run_locked(
        self: Arc<Self>,
        seq: u64,
        job: Job,
    ) -> futures::future::BoxFuture<'static, AppResult<JobOut>> {
        Box::pin(async move {
            let mut guard = self.conn.lock().await;
            self.active_job.store(seq, Ordering::SeqCst);
            // Declared after `guard`, so it is dropped (and flags the connection) first.
            let mut tripwire = BrokenOnAbort {
                session: &*self,
                armed: true,
            };
            let res = self.run_job(&mut guard, job).await;
            tripwire.armed = false;
            res
        })
    }

    fn run_job<'a>(
        &'a self,
        slot: &'a mut Option<DbConn>,
        job: Job,
    ) -> futures::future::BoxFuture<'a, AppResult<JobOut>> {
        Box::pin(async move {
            self.ensure_connected(slot).await?;
            let conn = match slot.as_mut() {
                Some(c) => c,
                None => return Err(AppError::new("Not connected")),
            };
            match job {
                Job::Execute { sql, max_rows } if has_no_transactions(self.config.driver) => {
                    // Redis and Kafka have no transactions in DataTrip: skip transaction tracking.
                    Ok(JobOut::Query(conn.execute(&sql, max_rows).await?))
                }
                Job::Execute { sql, max_rows } => {
                    // Track transactions the user opens or ends with typed statements, so that
                    // manual mode re-issues BEGIN after a typed COMMIT/ROLLBACK (instead of
                    // silently auto-committing everything that follows).
                    let ctl = db::tx_control(self.config.driver, &sql);
                    if ctl != Some(db::TxControl::Begin) {
                        self.begin_if_needed(conn).await?;
                    }
                    let r = conn.execute(&sql, max_rows).await?;
                    match ctl {
                        Some(db::TxControl::Begin) => self.in_tx.store(true, Ordering::SeqCst),
                        Some(db::TxControl::End) | Some(db::TxControl::ImplicitCommit) => {
                            self.in_tx.store(false, Ordering::SeqCst)
                        }
                        None => {}
                    }
                    Ok(JobOut::Query(r))
                }
                Job::Export { sql, format, path } => {
                    if !has_no_transactions(self.config.driver) {
                        self.begin_if_needed(conn).await?;
                    }
                    let n = export::export(conn, &sql, format, &path).await?;
                    Ok(JobOut::Count(n))
                }
                Job::Introspect => Ok(JobOut::Schema(conn.introspect().await?)),
                Job::ListDatabases => Ok(JobOut::Databases(conn.list_databases().await?)),
                Job::ServerObjects => Ok(JobOut::Groups(conn.list_server_objects().await?)),
                Job::Edits(edits) => {
                    if self.config.read_only {
                        return Err(AppError::new(
                            "This connection is read-only; edits are not allowed",
                        ));
                    }
                    self.begin_if_needed(conn).await?;
                    let manual = self.in_tx.load(Ordering::SeqCst);
                    let n = conn.apply_edits(&edits, manual).await?;
                    Ok(JobOut::Count(n))
                }
                Job::Simple(sql) => {
                    conn.run_simple(&sql).await?;
                    Ok(JobOut::Unit)
                }
                Job::RedisScan {
                    pattern,
                    cursor,
                    count,
                    key_type,
                } => Ok(JobOut::RedisScan(
                    conn.redis_scan(&pattern, &cursor, count, key_type.as_deref())
                        .await?,
                )),
                Job::RedisGet { key, limit } => {
                    Ok(JobOut::RedisValue(conn.redis_get(&key, limit).await?))
                }
                Job::RedisDelete(keys) => Ok(JobOut::Count(conn.redis_delete(&keys).await?)),
                Job::RedisSetTtl { key, ttl } => {
                    conn.redis_set_ttl(&key, ttl).await?;
                    Ok(JobOut::Unit)
                }
                Job::KafkaOverview => Ok(JobOut::KafkaOverview(conn.kafka_overview().await?)),
                Job::KafkaTopic(t) => Ok(JobOut::KafkaTopic(conn.kafka_topic(&t).await?)),
                Job::KafkaConsume(r) => Ok(JobOut::KafkaConsume(conn.kafka_consume(r).await?)),
                Job::KafkaProduce(r) => Ok(JobOut::KafkaProduce(conn.kafka_produce(r).await?)),
                Job::KafkaGroup(g) => Ok(JobOut::KafkaGroup(conn.kafka_group(&g).await?)),
                Job::KafkaResetOffsets {
                    group,
                    topic,
                    to,
                    value,
                } => Ok(JobOut::Count(
                    conn.kafka_reset_offsets(&group, &topic, &to, value).await?,
                )),
                Job::KafkaCreateTopic {
                    topic,
                    partitions,
                    replication,
                } => {
                    conn.kafka_create_topic(&topic, partitions, replication)
                        .await?;
                    Ok(JobOut::Unit)
                }
                Job::KafkaDeleteTopic(t) => {
                    conn.kafka_delete_topic(&t).await?;
                    Ok(JobOut::Unit)
                }
            }
        })
    }

    /// Runs a job on a spawned task so that it can be aborted by `cancel`.
    async fn run(self: &Arc<Self>, job: Job) -> AppResult<JobOut> {
        let seq = self.next_job.fetch_add(1, Ordering::SeqCst) + 1;
        let me = Arc::clone(self);
        let handle = tokio::spawn(async move { me.run_locked(seq, job).await });
        lock(&self.running).insert(seq, handle.abort_handle());
        let joined = handle.await;
        lock(&self.running).remove(&seq);
        // A job aborted while owning the connection has already marked it broken
        // (BrokenOnAbort); one aborted while still waiting for the lock left it intact.
        match joined {
            Ok(r) => r,
            Err(e) => {
                if e.is_cancelled() {
                    Err(AppError::new("Query cancelled"))
                } else {
                    Err(AppError::new(format!("Internal error: {}", e)))
                }
            }
        }
    }

    pub async fn execute(self: &Arc<Self>, sql: String, max_rows: usize) -> AppResult<QueryResult> {
        match self.run(Job::Execute { sql, max_rows }).await? {
            JobOut::Query(r) => Ok(r),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn export(
        self: &Arc<Self>,
        sql: String,
        format: ExportFormat,
        path: String,
    ) -> AppResult<u64> {
        match self.run(Job::Export { sql, format, path }).await? {
            JobOut::Count(n) => Ok(n),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn introspect(self: &Arc<Self>) -> AppResult<Vec<SchemaNode>> {
        match self.run(Job::Introspect).await? {
            JobOut::Schema(s) => Ok(s),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn list_databases(self: &Arc<Self>) -> AppResult<Vec<DatabaseNode>> {
        match self.run(Job::ListDatabases).await? {
            JobOut::Databases(d) => Ok(d),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn list_server_objects(self: &Arc<Self>) -> AppResult<Vec<ObjectGroup>> {
        match self.run(Job::ServerObjects).await? {
            JobOut::Groups(g) => Ok(g),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn apply_edits(self: &Arc<Self>, edits: Vec<RowEdit>) -> AppResult<u64> {
        match self.run(Job::Edits(edits)).await? {
            JobOut::Count(n) => Ok(n),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn redis_scan(
        self: &Arc<Self>,
        pattern: String,
        cursor: String,
        count: u32,
        key_type: Option<String>,
    ) -> AppResult<RedisScanResult> {
        let job = Job::RedisScan {
            pattern,
            cursor,
            count,
            key_type,
        };
        match self.run(job).await? {
            JobOut::RedisScan(r) => Ok(r),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn redis_get(self: &Arc<Self>, key: String, limit: usize) -> AppResult<RedisValue> {
        match self.run(Job::RedisGet { key, limit }).await? {
            JobOut::RedisValue(v) => Ok(v),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn redis_delete(self: &Arc<Self>, keys: Vec<String>) -> AppResult<u64> {
        match self.run(Job::RedisDelete(keys)).await? {
            JobOut::Count(n) => Ok(n),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn redis_set_ttl(self: &Arc<Self>, key: String, ttl: Option<i64>) -> AppResult<()> {
        self.run(Job::RedisSetTtl { key, ttl }).await.map(|_| ())
    }

    pub async fn kafka_overview(self: &Arc<Self>) -> AppResult<KafkaOverview> {
        match self.run(Job::KafkaOverview).await? {
            JobOut::KafkaOverview(o) => Ok(o),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn kafka_topic(self: &Arc<Self>, topic: String) -> AppResult<KafkaTopicDetail> {
        match self.run(Job::KafkaTopic(topic)).await? {
            JobOut::KafkaTopic(t) => Ok(t),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn kafka_consume(
        self: &Arc<Self>,
        request: KafkaConsumeRequest,
    ) -> AppResult<KafkaConsumeResult> {
        match self.run(Job::KafkaConsume(request)).await? {
            JobOut::KafkaConsume(r) => Ok(r),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn kafka_produce(
        self: &Arc<Self>,
        request: KafkaProduceRequest,
    ) -> AppResult<KafkaProduceResult> {
        if self.config.read_only {
            return Err(AppError::new(
                "This connection is read-only; producing messages is not allowed",
            ));
        }
        match self.run(Job::KafkaProduce(request)).await? {
            JobOut::KafkaProduce(r) => Ok(r),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn kafka_group(self: &Arc<Self>, group_id: String) -> AppResult<KafkaGroupDetail> {
        match self.run(Job::KafkaGroup(group_id)).await? {
            JobOut::KafkaGroup(g) => Ok(g),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn kafka_reset_offsets(
        self: &Arc<Self>,
        group: String,
        topic: String,
        to: String,
        value: Option<i64>,
    ) -> AppResult<u64> {
        if self.config.read_only {
            return Err(AppError::new(
                "This connection is read-only; resetting offsets is not allowed",
            ));
        }
        let job = Job::KafkaResetOffsets {
            group,
            topic,
            to,
            value,
        };
        match self.run(job).await? {
            JobOut::Count(n) => Ok(n),
            _ => Err(AppError::new("Unexpected result")),
        }
    }

    pub async fn kafka_create_topic(
        self: &Arc<Self>,
        topic: String,
        partitions: i32,
        replication: i32,
    ) -> AppResult<()> {
        if self.config.read_only {
            return Err(AppError::new(
                "This connection is read-only; creating topics is not allowed",
            ));
        }
        let job = Job::KafkaCreateTopic {
            topic,
            partitions,
            replication,
        };
        self.run(job).await.map(|_| ())
    }

    pub async fn kafka_delete_topic(self: &Arc<Self>, topic: String) -> AppResult<()> {
        if self.config.read_only {
            return Err(AppError::new(
                "This connection is read-only; deleting topics is not allowed",
            ));
        }
        self.run(Job::KafkaDeleteTopic(topic)).await.map(|_| ())
    }

    pub async fn set_auto_commit(self: &Arc<Self>, on: bool) -> AppResult<()> {
        if has_no_transactions(self.config.driver) {
            return Ok(());
        }
        if on && self.in_tx.load(Ordering::SeqCst) {
            self.run(Job::Simple(db::commit_sql(self.config.driver).to_string()))
                .await?;
            self.in_tx.store(false, Ordering::SeqCst);
        }
        self.auto_commit.store(on, Ordering::SeqCst);
        Ok(())
    }

    pub async fn commit(self: &Arc<Self>) -> AppResult<()> {
        if has_no_transactions(self.config.driver) {
            return Ok(());
        }
        if !self.in_tx.load(Ordering::SeqCst) {
            return Ok(());
        }
        let res = self
            .run(Job::Simple(db::commit_sql(self.config.driver).to_string()))
            .await;
        // COMMIT ends the transaction even when it fails (the server rolls back).
        self.in_tx.store(false, Ordering::SeqCst);
        res.map(|_| ())
    }

    pub async fn rollback(self: &Arc<Self>) -> AppResult<()> {
        if has_no_transactions(self.config.driver) {
            return Ok(());
        }
        if !self.in_tx.load(Ordering::SeqCst) {
            return Ok(());
        }
        let res = self
            .run(Job::Simple(
                db::rollback_sql(self.config.driver).to_string(),
            ))
            .await;
        self.in_tx.store(false, Ordering::SeqCst);
        res.map(|_| ())
    }

    /// Cancels the running statement. Postgres/MySQL: server-side cancel on a fresh connection
    /// (the session stays usable). Otherwise, or if that fails: abort the task and reconnect later.
    pub async fn cancel(&self) -> AppResult<()> {
        // Target the job that owns the connection, not merely the most recently queued one.
        let active = self.active_job.load(Ordering::SeqCst);
        let handle = lock(&self.running).remove(&active);
        let handle = match handle {
            Some(h) => h,
            None => return Ok(()),
        };
        let mut server_cancelled = false;
        if matches!(self.config.driver, Driver::Postgres | Driver::Mysql) {
            let id = *lock(&self.backend_id);
            if let Some(id) = id {
                server_cancelled = self.creds.cancel_backend(&self.config, id).await.is_ok();
            }
        }
        if !server_cancelled {
            // BrokenOnAbort marks the connection broken if the job is actually interrupted.
            handle.abort();
        }
        Ok(())
    }

    pub async fn close(&self) {
        let handles: Vec<AbortHandle> = lock(&self.running).drain().map(|(_, h)| h).collect();
        for h in handles {
            h.abort();
        }
        let mut guard = self.conn.lock().await;
        if let Some(c) = guard.take() {
            if self.broken.load(Ordering::SeqCst) {
                // Interrupted mid-protocol: a graceful close could block; just drop it.
                drop(c);
            } else {
                c.close().await;
            }
        }
    }
}

pub struct SessionRegistry {
    map: Mutex<HashMap<String, Arc<Session>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        SessionRegistry {
            map: Mutex::new(HashMap::new()),
        }
    }

    pub fn insert(&self, s: Arc<Session>) {
        lock(&self.map).insert(s.id.clone(), s);
    }

    pub fn get(&self, id: &str) -> AppResult<Arc<Session>> {
        lock(&self.map)
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("Session not found (it may have been closed)"))
    }

    pub fn remove(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.map).remove(id)
    }
}

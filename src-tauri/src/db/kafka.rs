//! Apache Kafka driver (rust-rdkafka 0.37 / librdkafka).
//!
//! librdkafka calls are blocking, so every one of them runs inside `tokio::task::spawn_blocking`
//! (see `blocking`). Admin and producer futures are driven with `Handle::block_on` on that same
//! blocking thread, so no rdkafka future ever has to be `Send` inside the session job.
//! Every `pub fn` that awaits returns a `BoxFuture` built with `Box::pin(async move { .. })`
//! (same pattern as the other drivers).
//!
//! Consuming never joins or commits a consumer group: partitions are assigned manually, with a
//! throwaway `group.id`, auto commit off.

use super::{int_value, Connected, DbConn, RowSink, StreamEnd};
use crate::error::{AppError, AppResult};
use crate::model::{
    ColumnMeta, ConnectionConfig, KafkaBroker, KafkaConfigEntry, KafkaConsumeRequest,
    KafkaConsumeResult, KafkaGroupDetail, KafkaGroupInfo, KafkaGroupMember, KafkaGroupOffset,
    KafkaHeader, KafkaMessage, KafkaOverview, KafkaPartitionInfo, KafkaProduceRequest,
    KafkaProduceResult, KafkaTopicDetail, KafkaTopicInfo, ObjectGroup, ObjectItem,
};
use futures::future::BoxFuture;
use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, ResourceSpecifier, TopicReplication};
use rdkafka::client::DefaultClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{BaseConsumer, CommitMode, Consumer};
use rdkafka::error::KafkaError;
use rdkafka::message::{BorrowedMessage, Header, Headers, OwnedHeaders};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;
use rdkafka::{Message, Offset, TopicPartitionList};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Metadata / admin / commit calls wait at most this long.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// Value cut-off for consumed messages.
const MAX_VALUE_BYTES: usize = 256 * 1024;
/// Upper bound for one consume request.
const MAX_LIMIT: u32 = 10_000;
const DEFAULT_CONSUME_TIMEOUT_MS: u64 = 3000;
const MAX_CONSUME_TIMEOUT_MS: u64 = 60_000;
const COMMANDS_HELP: &str = "topics, groups, brokers, describe topic <t> [configs], describe group <g>, \
consume <t> [--from-beginning|--latest|--from-timestamp <ISO>|--offset <n>] [--partition <n>] [--limit <n>] \
[--key-contains <s>] [--value-contains <s>], produce <t> [key=<k>] [partition=<n>] [header.<k>=<v>] value=<v>, \
create topic <t> [partitions=<n>] [replication=<n>], delete topic <t>";

/// Long-lived client handles of one session (cheap to clone: everything is shared).
#[derive(Clone)]
pub struct KafkaConn {
    admin: Arc<AdminClient<DefaultClientContext>>,
    /// Metadata, watermarks, group list and manual-assignment consuming.
    consumer: Arc<BaseConsumer>,
    /// Created on first produce.
    producer: Arc<Mutex<Option<Arc<FutureProducer>>>>,
    /// Base client settings (contains the SASL password: never log it).
    cfg: Arc<ClientConfig>,
    read_only: bool,
    show_internal: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Runs blocking librdkafka work off the async runtime.
fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> BoxFuture<'static, AppResult<T>> {
    Box::pin(async move {
        match tokio::task::spawn_blocking(f).await {
            Ok(r) => r,
            Err(e) => Err(AppError::new(format!("Kafka task failed: {}", e))),
        }
    })
}

/// Drives an rdkafka future to completion from a `spawn_blocking` thread.
fn block_on_rt<F: std::future::Future>(f: F) -> AppResult<F::Output> {
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| AppError::new("No async runtime available for the Kafka client"))?;
    Ok(handle.block_on(f))
}

fn kerr(e: KafkaError) -> AppError {
    AppError::new(e.to_string())
}

fn kctx(what: &str, e: KafkaError) -> AppError {
    AppError::new(format!("{}: {}", what, e))
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// "b1,b2:9093" + default port -> "b1:9092,b2:9093".
fn bootstrap_servers(host: &str, port: u16) -> AppResult<String> {
    let mut out: Vec<String> = Vec::new();
    // Accept the separators people paste from configs: commas, spaces, semicolons, newlines.
    for entry in host.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let e = entry.trim();
        if e.is_empty() {
            continue;
        }
        // Ignore an optional "PLAINTEXT://" style prefix when looking for a port.
        let rest = e.rsplit("://").next().unwrap_or(e);
        let has_port = if rest.starts_with('[') {
            rest.contains("]:")
        } else {
            rest.contains(':')
        };
        if has_port {
            out.push(e.to_string());
        } else {
            out.push(format!("{}:{}", e, port));
        }
    }
    if out.is_empty() {
        return Err(AppError::new(
            "Enter at least one bootstrap server (host:port)",
        ));
    }
    Ok(out.join(","))
}

fn build_config(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ClientConfig> {
    let host = non_empty(&cfg.host).unwrap_or("");
    let servers = bootstrap_servers(host, cfg.port.unwrap_or(9092))?;
    let k = cfg.kafka.clone().unwrap_or_default();
    let protocol = non_empty(&k.security_protocol)
        .unwrap_or("plaintext")
        .to_lowercase();
    if !matches!(
        protocol.as_str(),
        "plaintext" | "ssl" | "sasl_plaintext" | "sasl_ssl"
    ) {
        return Err(AppError::new(format!(
            "Unknown Kafka security protocol \"{}\" (use plaintext, ssl, sasl_plaintext or sasl_ssl)",
            protocol
        )));
    }
    let mut c = ClientConfig::new();
    c.set("bootstrap.servers", servers);
    c.set("client.id", "datatrip");
    c.set("security.protocol", protocol.as_str());
    c.set("socket.timeout.ms", "15000");
    c.set("socket.connection.setup.timeout.ms", "15000");
    c.set("request.timeout.ms", "15000");
    if protocol.starts_with("sasl") {
        let mech = non_empty(&k.sasl_mechanism)
            .unwrap_or("PLAIN")
            .to_uppercase();
        if mech == "OAUTHBEARER" {
            return Err(AppError::new(
                "SASL OAUTHBEARER is not supported yet (it needs a token callback). Use PLAIN or SCRAM.",
            ));
        }
        if !matches!(mech.as_str(), "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512") {
            return Err(AppError::new(format!(
                "Unsupported SASL mechanism \"{}\" (use PLAIN, SCRAM-SHA-256 or SCRAM-SHA-512)",
                mech
            )));
        }
        c.set("sasl.mechanism", mech);
        if let Some(u) = non_empty(&cfg.username) {
            c.set("sasl.username", u);
        }
        if let Some(p) = password {
            c.set("sasl.password", p);
        }
    }
    if protocol.contains("ssl") {
        if let Some(p) = non_empty(&k.ca_cert_path) {
            c.set("ssl.ca.location", crate::vault::expand_tilde(p));
        }
        if let Some(p) = non_empty(&k.client_cert_path) {
            c.set("ssl.certificate.location", crate::vault::expand_tilde(p));
        }
        if let Some(p) = non_empty(&k.client_key_path) {
            c.set("ssl.key.location", crate::vault::expand_tilde(p));
        }
        if k.skip_tls_verify {
            c.set("enable.ssl.certificate.verification", "false");
        }
    }
    Ok(c)
}

fn consumer_config(base: &ClientConfig, group: &str) -> ClientConfig {
    let mut c = base.clone();
    c.set("group.id", group);
    c.set("enable.auto.commit", "false");
    c.set("enable.auto.offset.store", "false");
    c.set("enable.partition.eof", "true");
    c.set("auto.offset.reset", "earliest");
    c.set("fetch.message.max.bytes", "1048576");
    c
}

/// Temporary consumer that only fetches/commits offsets for `group` (never subscribes).
fn group_consumer(c: &KafkaConn, group: &str) -> AppResult<BaseConsumer> {
    consumer_config(&c.cfg, group)
        .create::<BaseConsumer>()
        .map_err(|e| kctx("Could not create Kafka consumer", e))
}

fn is_internal(name: &str) -> bool {
    name.starts_with('_')
}

fn fetch_meta(c: &KafkaConn, topic: Option<&str>) -> AppResult<rdkafka::metadata::Metadata> {
    c.consumer
        .fetch_metadata(topic, CALL_TIMEOUT)
        .map_err(|e| kctx("Could not fetch cluster metadata", e))
}

/// Partition ids of an existing topic, sorted.
fn topic_partition_ids(c: &KafkaConn, topic: &str) -> AppResult<Vec<i32>> {
    let md = fetch_meta(c, Some(topic))?;
    let t = md
        .topics()
        .iter()
        .find(|t| t.name() == topic)
        .ok_or_else(|| AppError::new(format!("Topic \"{}\" not found", topic)))?;
    if let Some(err) = t.error() {
        // VERIFY: MetadataTopic::error() returns Option<RDKafkaRespErr> (printed with Debug).
        return Err(AppError::new(format!(
            "Topic \"{}\" is not available: {:?}",
            topic, err
        )));
    }
    let mut ids: Vec<i32> = t.partitions().iter().map(|p| p.id()).collect();
    if ids.is_empty() {
        return Err(AppError::new(format!(
            "Topic \"{}\" has no partitions",
            topic
        )));
    }
    ids.sort_unstable();
    Ok(ids)
}

fn watermarks(c: &KafkaConn, topic: &str, partition: i32) -> AppResult<(i64, i64)> {
    c.consumer
        .fetch_watermarks(topic, partition, CALL_TIMEOUT)
        .map_err(|e| {
            kctx(
                &format!("Could not read offsets of {}[{}]", topic, partition),
                e,
            )
        })
}

/// Text form of bytes: UTF-8 string, else "0x" hex. `cut` = bytes were truncated (a multi-byte
/// character may be split at the end).
fn text_form(bytes: &[u8], cut: bool) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(e) => {
            if cut && e.error_len().is_none() && e.valid_up_to() > 0 {
                if let Ok(s) = std::str::from_utf8(&bytes[..e.valid_up_to()]) {
                    return s.to_string();
                }
            }
            format!("0x{}", hex::encode(bytes))
        }
    }
}

fn iso_time(ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Resolves, per partition, the first offset whose timestamp is >= `ts_ms`
/// (None = no such message, i.e. the end of the partition).
fn offsets_for_ts(
    consumer: &BaseConsumer,
    topic: &str,
    parts: &[i32],
    ts_ms: i64,
) -> AppResult<BTreeMap<i32, Option<i64>>> {
    let mut tpl = TopicPartitionList::new();
    for p in parts {
        tpl.add_partition_offset(topic, *p, Offset::Offset(ts_ms))
            .map_err(kerr)?;
    }
    let res = consumer
        .offsets_for_times(tpl, CALL_TIMEOUT)
        .map_err(|e| kctx("Could not look up offsets by timestamp", e))?;
    let mut out = BTreeMap::new();
    for e in res.elements() {
        let v = match e.offset() {
            Offset::Offset(o) if o >= 0 => Some(o),
            _ => None,
        };
        out.insert(e.partition(), v);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Connect / close
// ---------------------------------------------------------------------------

/// Host names such as `kafka-headless.ops`, `kafka.ns.svc` or `*.cluster.local` only exist in
/// a Kubernetes cluster's DNS.
fn looks_cluster_internal(server: &str) -> bool {
    let host = server.rsplit("://").next().unwrap_or(server);
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    if host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    host.contains("-headless")
        || host.ends_with(".svc")
        || host.contains(".svc.")
        || host.ends_with(".cluster.local")
}

/// Turns a failed first metadata fetch into an actionable message: probes each bootstrap
/// server with a plain TCP connect to tell "network can't reach it" (VPN, firewall, a broker
/// only reachable through a jump host) from "reachable, but the handshake failed" (wrong
/// security protocol, TLS or SASL settings).
fn connect_error(servers: &str, protocol: &str, e: KafkaError) -> AppError {
    use std::net::{TcpStream, ToSocketAddrs};
    let mut unreachable: Vec<String> = Vec::new();
    let mut reachable: Vec<String> = Vec::new();
    for s in servers.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let addr = s.rsplit("://").next().unwrap_or(s);
        let resolved = match addr.to_socket_addrs() {
            Ok(mut it) => it.next(),
            Err(_) => {
                unreachable.push(format!("{} (host name not found)", addr));
                continue;
            }
        };
        match resolved {
            Some(sa) => match TcpStream::connect_timeout(&sa, Duration::from_secs(3)) {
                Ok(_) => reachable.push(addr.to_string()),
                Err(err) => unreachable.push(format!("{} ({})", addr, err)),
            },
            None => unreachable.push(format!("{} (host name not found)", addr)),
        }
    }
    let base = format!("Could not connect to Kafka: {}.", e);
    let internal = servers
        .split(',')
        .map(str::trim)
        .find(|s| looks_cluster_internal(s));
    if let (true, Some(name)) = (reachable.is_empty(), internal) {
        return AppError::new(format!(
            "{} {} looks like a Kubernetes-internal service name: it only resolves inside the \
             cluster, not from this computer (even on VPN). Use the brokers' external addresses \
             (ask your infrastructure team which bootstrap servers are reachable over VPN).",
            base,
            name.rsplit("://").next().unwrap_or(name)
        ));
    }
    if reachable.is_empty() && !unreachable.is_empty() {
        AppError::new(format!(
            "{} None of the bootstrap servers can be reached from this computer: {}. \
             Check that you are on the right network or VPN; brokers that are only reachable \
             through an SSH jump host are not supported yet.",
            base,
            unreachable.join(", ")
        ))
    } else if !reachable.is_empty() {
        AppError::new(format!(
            "{} {} accepts connections, but the Kafka handshake failed. Check the security \
             protocol (currently {}): a PLAINTEXT listener rejects SSL/SASL clients and vice versa.",
            base,
            reachable.join(", "),
            protocol.to_uppercase()
        ))
    } else {
        AppError::new(format!(
            "{} Check the bootstrap servers, security protocol and credentials.",
            base
        ))
    }
}

pub fn connect<'a>(
    cfg: &'a ConnectionConfig,
    password: Option<&'a str>,
) -> BoxFuture<'a, AppResult<Connected>> {
    Box::pin(async move {
        let base = build_config(cfg, password)?;
        let servers = base.get("bootstrap.servers").unwrap_or("").to_string();
        let protocol = base
            .get("security.protocol")
            .unwrap_or("plaintext")
            .to_string();
        let read_only = cfg.read_only;
        let show_internal = cfg.kafka.as_ref().map(|k| k.show_internal).unwrap_or(false);
        let (conn, brokers) = blocking(move || {
            let admin = base
                .create::<AdminClient<DefaultClientContext>>()
                .map_err(|e| kctx("Could not create Kafka admin client", e))?;
            let group = format!("datatrip-browser-{}", uuid::Uuid::new_v4());
            let consumer = consumer_config(&base, &group)
                .create::<BaseConsumer>()
                .map_err(|e| kctx("Could not create Kafka consumer", e))?;
            let md = consumer
                .fetch_metadata(None, CALL_TIMEOUT)
                .map_err(|e| connect_error(&servers, &protocol, e))?;
            let n = md.brokers().len();
            Ok((
                KafkaConn {
                    admin: Arc::new(admin),
                    consumer: Arc::new(consumer),
                    producer: Arc::new(Mutex::new(None)),
                    cfg: Arc::new(base),
                    read_only,
                    show_internal,
                },
                n,
            ))
        })
        .await?;
        Ok(Connected {
            conn: DbConn::Kafka(conn),
            server_version: format!(
                "Kafka cluster ({} broker{})",
                brokers,
                if brokers == 1 { "" } else { "s" }
            ),
            default_schema: None,
            database: None,
            backend_id: None,
            tunnel: None,
        })
    })
}

/// Dropping a consumer/producer can block briefly: do it off the runtime.
pub fn close(c: KafkaConn) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        let _ = tokio::task::spawn_blocking(move || drop(c)).await;
    })
}

// ---------------------------------------------------------------------------
// Overview / topic / group
// ---------------------------------------------------------------------------

fn groups_list(c: &KafkaConn) -> Vec<KafkaGroupInfo> {
    // A failure here (e.g. missing ACL) must not hide topics and brokers.
    let list = match c.consumer.fetch_group_list(None, CALL_TIMEOUT) {
        Ok(l) => l,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<KafkaGroupInfo> = list
        .groups()
        .iter()
        .map(|g| KafkaGroupInfo {
            group_id: g.name().to_string(),
            state: g.state().to_string(),
            protocol_type: g.protocol_type().to_string(),
            members: g.members().len() as i32,
        })
        .collect();
    out.sort_by(|a, b| a.group_id.cmp(&b.group_id));
    out
}

fn overview_blocking(c: &KafkaConn) -> AppResult<KafkaOverview> {
    let md = fetch_meta(c, None)?;
    // VERIFY: librdkafka's metadata does not expose the controller id or cluster id; reported as
    // "not a controller" / None.
    let mut brokers: Vec<KafkaBroker> = md
        .brokers()
        .iter()
        .map(|b| KafkaBroker {
            id: b.id(),
            host: b.host().to_string(),
            port: b.port(),
            is_controller: false,
        })
        .collect();
    brokers.sort_by_key(|b| b.id);
    let mut topics: Vec<KafkaTopicInfo> = md
        .topics()
        .iter()
        .filter(|t| c.show_internal || !is_internal(t.name()))
        .map(|t| KafkaTopicInfo {
            name: t.name().to_string(),
            partitions: t.partitions().len() as i32,
            replication_factor: t
                .partitions()
                .first()
                .map(|p| p.replicas().len() as i32)
                .unwrap_or(0),
            internal: is_internal(t.name()),
        })
        .collect();
    topics.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(KafkaOverview {
        cluster_id: None,
        brokers,
        topics,
        groups: groups_list(c),
    })
}

pub fn overview(c: &KafkaConn) -> BoxFuture<'static, AppResult<KafkaOverview>> {
    let c = c.clone();
    blocking(move || overview_blocking(&c))
}

fn topic_configs(c: &KafkaConn, topic: &str) -> Vec<KafkaConfigEntry> {
    let opts = AdminOptions::new().request_timeout(Some(CALL_TIMEOUT));
    let spec = [ResourceSpecifier::Topic(topic)];
    let res = match block_on_rt(c.admin.describe_configs(&spec, &opts)) {
        Ok(Ok(r)) => r,
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    for r in res {
        // VERIFY: ConfigResourceResult = Result<ConfigResource, RDKafkaErrorCode>;
        // ConfigEntry { name, value: Option<String>, is_default, .. }.
        if let Ok(resource) = r {
            for e in resource.entries {
                out.push(KafkaConfigEntry {
                    name: e.name,
                    value: e.value,
                    is_default: e.is_default,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn topic_blocking(c: &KafkaConn, topic: &str) -> AppResult<KafkaTopicDetail> {
    let md = fetch_meta(c, Some(topic))?;
    let t = md
        .topics()
        .iter()
        .find(|t| t.name() == topic)
        .ok_or_else(|| AppError::new(format!("Topic \"{}\" not found", topic)))?;
    if let Some(err) = t.error() {
        return Err(AppError::new(format!(
            "Topic \"{}\" is not available: {:?}",
            topic, err
        )));
    }
    let mut partitions = Vec::new();
    let mut count: i64 = 0;
    for p in t.partitions() {
        let (low, high) = watermarks(c, topic, p.id()).unwrap_or((0, 0));
        count += (high - low).max(0);
        partitions.push(KafkaPartitionInfo {
            id: p.id(),
            leader: p.leader(),
            replicas: p.replicas().to_vec(),
            isr: p.isr().to_vec(),
            low,
            high,
        });
    }
    partitions.sort_by_key(|p| p.id);
    Ok(KafkaTopicDetail {
        name: topic.to_string(),
        internal: is_internal(topic),
        partitions,
        message_count: count,
        configs: topic_configs(c, topic),
    })
}

pub fn topic(c: &KafkaConn, topic: &str) -> BoxFuture<'static, AppResult<KafkaTopicDetail>> {
    let c = c.clone();
    let topic = topic.to_string();
    blocking(move || topic_blocking(&c, &topic))
}

/// Minimal big-endian reader for the consumer-protocol assignment layout.
struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.i.checked_add(n)?;
        let s = self.b.get(self.i..end)?;
        self.i = end;
        Some(s)
    }
    fn i16(&mut self) -> Option<i16> {
        let s = self.take(2)?;
        Some(i16::from_be_bytes([s[0], s[1]]))
    }
    fn i32(&mut self) -> Option<i32> {
        let s = self.take(4)?;
        Some(i32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn string(&mut self) -> Option<String> {
        let n = self.i16()?;
        if n < 0 {
            return Some(String::new());
        }
        let s = self.take(n as usize)?;
        Some(String::from_utf8_lossy(s).into_owned())
    }
}

/// Decodes a ConsumerProtocolAssignment (version i16, [topic, [partition]], user data) into
/// (topic, sorted partitions). None when the bytes are not in that layout.
fn decode_assignment(b: &[u8]) -> Option<Vec<(String, Vec<i32>)>> {
    // VERIFY: layout of the "consumer" protocol assignment (v0/v1: topics array, then user data).
    let mut r = Reader { b, i: 0 };
    let _version = r.i16()?;
    let n = r.i32()?;
    if !(0..=100_000).contains(&n) {
        return None;
    }
    let mut out = Vec::new();
    for _ in 0..n {
        let topic = r.string()?;
        let pc = r.i32()?;
        if !(0..=1_000_000).contains(&pc) {
            return None;
        }
        let mut parts = Vec::new();
        for _ in 0..pc {
            parts.push(r.i32()?);
        }
        parts.sort_unstable();
        out.push((topic, parts));
    }
    Some(out)
}

fn group_blocking(c: &KafkaConn, group: &str) -> AppResult<KafkaGroupDetail> {
    let list = c
        .consumer
        .fetch_group_list(Some(group), CALL_TIMEOUT)
        .map_err(|e| kctx("Could not read the consumer group", e))?;
    let g = list
        .groups()
        .iter()
        .find(|g| g.name() == group)
        .ok_or_else(|| AppError::new(format!("Consumer group \"{}\" not found", group)))?;
    let mut members = Vec::new();
    let mut topics: BTreeSet<String> = BTreeSet::new();
    for m in g.members() {
        let mut assignments = Vec::new();
        if let Some(parsed) = m.assignment().and_then(decode_assignment) {
            for (t, parts) in parsed {
                let list: Vec<String> = parts.iter().map(|p| p.to_string()).collect();
                assignments.push(format!("{}:{}", t, list.join(",")));
                topics.insert(t);
            }
        }
        members.push(KafkaGroupMember {
            member_id: m.id().to_string(),
            client_id: m.client_id().to_string(),
            host: m.client_host().to_string(),
            assignments,
        });
    }
    // Topics to ask committed offsets for: the assigned ones, else every topic.
    let md = fetch_meta(c, None)?;
    let mut tpl = TopicPartitionList::new();
    for t in md.topics() {
        if t.name() == "__consumer_offsets" {
            continue;
        }
        if !topics.is_empty() && !topics.contains(t.name()) {
            continue;
        }
        for p in t.partitions() {
            tpl.add_partition(t.name(), p.id());
        }
    }
    let mut offsets = Vec::new();
    let mut total_lag: i64 = 0;
    if tpl.count() > 0 {
        let gc = group_consumer(c, group)?;
        let committed = gc
            .committed_offsets(tpl, CALL_TIMEOUT)
            .map_err(|e| kctx("Could not read committed offsets", e))?;
        for e in committed.elements() {
            if e.error().is_err() {
                continue;
            }
            let off = match e.offset() {
                Offset::Offset(o) if o >= 0 => o,
                _ => continue,
            };
            let end = watermarks(c, e.topic(), e.partition()).map(|w| w.1).ok();
            let lag = end.map(|h| (h - off).max(0));
            total_lag += lag.unwrap_or(0);
            offsets.push(KafkaGroupOffset {
                topic: e.topic().to_string(),
                partition: e.partition(),
                committed: Some(off),
                end: end.unwrap_or(off),
                lag,
            });
        }
        offsets.sort_by(|a, b| (&a.topic, a.partition).cmp(&(&b.topic, b.partition)));
    }
    Ok(KafkaGroupDetail {
        group_id: group.to_string(),
        state: g.state().to_string(),
        protocol: g.protocol().to_string(),
        members,
        offsets,
        total_lag,
    })
}

pub fn group(c: &KafkaConn, group: &str) -> BoxFuture<'static, AppResult<KafkaGroupDetail>> {
    let c = c.clone();
    let group = group.to_string();
    blocking(move || group_blocking(&c, &group))
}

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

fn to_message(m: &BorrowedMessage<'_>) -> KafkaMessage {
    let key = m.key();
    let (value, value_size, value_truncated) = match m.payload() {
        Some(p) => {
            let cut = p.len() > MAX_VALUE_BYTES;
            let slice = if cut { &p[..MAX_VALUE_BYTES] } else { p };
            (Some(text_form(slice, cut)), p.len() as i64, cut)
        }
        None => (None, 0, false),
    };
    // VERIFY: Headers::get(idx) returns Header { key: &str, value: Option<&[u8]> } in rdkafka 0.36+.
    let headers = match m.headers() {
        Some(h) => (0..h.count())
            .map(|i| {
                let hd = h.get(i);
                KafkaHeader {
                    key: hd.key.to_string(),
                    value: hd.value.map(|v| text_form(v, false)),
                }
            })
            .collect(),
        None => Vec::new(),
    };
    KafkaMessage {
        partition: m.partition(),
        offset: m.offset(),
        timestamp_ms: m.timestamp().to_millis(),
        key: key.map(|k| text_form(k, false)),
        value,
        headers,
        key_size: key.map(|k| k.len() as i64).unwrap_or(0),
        value_size,
        value_truncated,
    }
}

fn contains_ci(hay: &Option<String>, needle_lower: &str) -> bool {
    match hay {
        Some(h) => h.to_lowercase().contains(needle_lower),
        None => false,
    }
}

fn consume_blocking(c: &KafkaConn, req: KafkaConsumeRequest) -> AppResult<KafkaConsumeResult> {
    let topic = req.topic.as_str();
    let limit = req.limit.clamp(1, MAX_LIMIT) as usize;
    let timeout_ms = req
        .timeout_ms
        .unwrap_or(DEFAULT_CONSUME_TIMEOUT_MS)
        .clamp(100, MAX_CONSUME_TIMEOUT_MS);
    let from = req.from.to_lowercase();
    if !matches!(
        from.as_str(),
        "latest" | "earliest" | "timestamp" | "offset" | "positions"
    ) {
        return Err(AppError::new(format!(
            "Unknown start position \"{}\" (latest, earliest, timestamp, offset, positions)",
            req.from
        )));
    }
    let all = topic_partition_ids(c, topic)?;
    let parts: Vec<i32> = match req.partition {
        Some(p) => {
            if !all.contains(&p) {
                return Err(AppError::new(format!(
                    "Topic \"{}\" has no partition {}",
                    topic, p
                )));
            }
            vec![p]
        }
        None => all,
    };
    if from == "positions" {
        let pos = req
            .positions
            .as_ref()
            .ok_or_else(|| AppError::new("positions are required when from = \"positions\""))?;
        if pos.is_empty() {
            return Err(AppError::new("positions must not be empty"));
        }
    }
    // partition -> (low, high)
    let mut marks: BTreeMap<i32, (i64, i64)> = BTreeMap::new();
    for p in &parts {
        marks.insert(*p, watermarks(c, topic, *p)?);
    }
    // Start offsets.
    let mut start: BTreeMap<i32, i64> = BTreeMap::new();
    let latest = from == "latest";
    match from.as_str() {
        "latest" => {
            let per = (limit as i64 + parts.len() as i64 - 1) / parts.len() as i64;
            for (p, (low, high)) in &marks {
                start.insert(*p, (*high - per).max(*low));
            }
        }
        "earliest" => {
            for (p, (low, _)) in &marks {
                start.insert(*p, *low);
            }
        }
        "timestamp" => {
            let ts = req.timestamp_ms.ok_or_else(|| {
                AppError::new("timestampMs is required when from = \"timestamp\"")
            })?;
            let found = offsets_for_ts(&c.consumer, topic, &parts, ts)?;
            for (p, (_, high)) in &marks {
                let o = found.get(p).copied().flatten().unwrap_or(*high);
                start.insert(*p, o);
            }
        }
        "offset" => {
            let off = req
                .offset
                .ok_or_else(|| AppError::new("offset is required when from = \"offset\""))?;
            for (p, (low, high)) in &marks {
                start.insert(*p, off.clamp(*low, *high));
            }
        }
        _ => {
            let pos = req.positions.clone().unwrap_or_default();
            for (p, (low, high)) in &marks {
                let o = pos.get(p).copied().unwrap_or(*low);
                start.insert(*p, o.clamp(*low, *high));
            }
        }
    }
    let mut next: BTreeMap<i32, i64> = start.clone();
    // Partitions that still have something to read.
    let mut pending: BTreeSet<i32> = BTreeSet::new();
    let mut tpl = TopicPartitionList::new();
    for (p, s) in &start {
        let high = marks.get(p).map(|m| m.1).unwrap_or(0);
        if *s < high {
            tpl.add_partition_offset(topic, *p, Offset::Offset(*s))
                .map_err(kerr)?;
            pending.insert(*p);
        }
    }
    if pending.is_empty() {
        return Ok(KafkaConsumeResult {
            messages: Vec::new(),
            next_positions: next,
            reached_end: true,
            scanned: 0,
        });
    }
    let assigned = pending.clone();
    c.consumer
        .assign(&tpl)
        .map_err(|e| kctx("Could not assign partitions", e))?;

    let key_f = req
        .key_contains
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    let val_f = req
        .value_contains
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    let mut kept: Vec<KafkaMessage> = Vec::new();
    let mut scanned: u64 = 0;
    let mut last_err: Option<String> = None;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if pending.is_empty() || (!latest && kept.len() >= limit) {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let wait = (deadline - now).min(Duration::from_millis(250));
        match c.consumer.poll(wait) {
            None => {}
            Some(Ok(m)) => {
                let p = m.partition();
                if m.topic() != topic || !assigned.contains(&p) {
                    continue;
                }
                scanned += 1;
                next.insert(p, m.offset() + 1);
                let high = marks.get(&p).map(|w| w.1).unwrap_or(0);
                if m.offset() + 1 >= high {
                    pending.remove(&p);
                }
                let msg = to_message(&m);
                if let Some(f) = &key_f {
                    if !contains_ci(&msg.key, f) {
                        continue;
                    }
                }
                if let Some(f) = &val_f {
                    if !contains_ci(&msg.value, f) {
                        continue;
                    }
                }
                kept.push(msg);
            }
            Some(Err(KafkaError::PartitionEOF(p))) => {
                pending.remove(&p);
            }
            Some(Err(e)) => {
                last_err = Some(e.to_string());
            }
        }
    }
    let _ = c.consumer.unassign();
    if kept.is_empty() && scanned == 0 && !pending.is_empty() {
        // Messages exist in the range but none arrived: usually the partition leaders advertise an
        // address this computer can't reach (e.g. Kubernetes-internal names). Say which.
        let waiting: u64 = pending
            .iter()
            .map(|p| {
                let high = marks.get(p).map(|m| m.1).unwrap_or(0);
                let from = start.get(p).copied().unwrap_or(high);
                (high - from).max(0) as u64
            })
            .sum();
        let diag = leader_diagnosis(c, topic, &pending);
        let mut msg = format!(
            "No messages arrived within {:.0} s, although partition{} {} hold{} {} message{} in this range.",
            timeout_ms as f64 / 1000.0,
            if pending.len() == 1 { "" } else { "s" },
            pending
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(", "),
            if pending.len() == 1 { "s" } else { "" },
            waiting,
            if waiting == 1 { "" } else { "s" }
        );
        if let Some(d) = diag {
            msg.push(' ');
            msg.push_str(&d);
        }
        if let Some(e) = last_err {
            msg.push_str(&format!(" Last error: {}.", e));
        }
        return Err(AppError::new(msg));
    }
    kept.sort_by_key(|m| (m.timestamp_ms.unwrap_or(0), m.partition, m.offset));
    if latest && kept.len() > limit {
        let extra = kept.len() - limit;
        kept.drain(..extra);
    }
    Ok(KafkaConsumeResult {
        messages: kept,
        next_positions: next,
        reached_end: pending.is_empty(),
        scanned,
    })
}

/// Explains why the leaders of `parts` can't be read from: the address each leader advertises
/// (metadata), whether this computer can resolve it and open a TCP connection to it.
fn leader_diagnosis(c: &KafkaConn, topic: &str, parts: &BTreeSet<i32>) -> Option<String> {
    use std::net::{TcpStream, ToSocketAddrs};
    let md = c.consumer.fetch_metadata(Some(topic), CALL_TIMEOUT).ok()?;
    let t = md.topics().iter().find(|t| t.name() == topic)?;
    let mut leaders: BTreeSet<i32> = BTreeSet::new();
    for p in t.partitions() {
        if parts.contains(&p.id()) {
            leaders.insert(p.leader());
        }
    }
    let mut unresolved: Vec<String> = Vec::new();
    let mut unreachable: Vec<String> = Vec::new();
    let mut ok: Vec<String> = Vec::new();
    for id in leaders {
        let Some(b) = md.brokers().iter().find(|b| b.id() == id) else {
            unreachable.push(format!("broker {} (not in metadata)", id));
            continue;
        };
        let addr = format!("{}:{}", b.host(), b.port());
        match addr.to_socket_addrs().ok().and_then(|mut it| it.next()) {
            None => unresolved.push(addr),
            Some(sa) => match TcpStream::connect_timeout(&sa, Duration::from_secs(3)) {
                Ok(_) => ok.push(addr),
                Err(e) => unreachable.push(format!("{} ({})", addr, e)),
            },
        }
    }
    if !unresolved.is_empty() {
        return Some(format!(
            "The partition leaders advertise {}, which this computer can't resolve. Listing topics works \
             through the bootstrap servers, but messages are read from each leader at the address it \
             advertises — here a name that only exists inside the cluster. Ask your infrastructure team \
             for an external listener reachable over VPN, or map those names to reachable IPs in your \
             hosts file.",
            unresolved.join(", ")
        ));
    }
    if !unreachable.is_empty() {
        return Some(format!(
            "The partition leaders can't be reached from this computer: {}. Check the VPN / firewall \
             for those addresses.",
            unreachable.join(", ")
        ));
    }
    if !ok.is_empty() {
        return Some(format!(
            "The partition leaders ({}) accept connections; try again with a longer wait or check the \
             security protocol.",
            ok.join(", ")
        ));
    }
    None
}

pub fn consume(
    c: &KafkaConn,
    req: KafkaConsumeRequest,
) -> BoxFuture<'static, AppResult<KafkaConsumeResult>> {
    let c = c.clone();
    blocking(move || consume_blocking(&c, req))
}

// ---------------------------------------------------------------------------
// Produce / offsets / topics
// ---------------------------------------------------------------------------

fn read_only_err(what: &str) -> AppError {
    AppError::new(format!(
        "This connection is read-only; {} is not allowed",
        what
    ))
}

fn producer_for(c: &KafkaConn) -> AppResult<Arc<FutureProducer>> {
    let mut slot = c.producer.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = slot.as_ref() {
        return Ok(Arc::clone(p));
    }
    let mut cfg = (*c.cfg).clone();
    cfg.set("message.timeout.ms", "10000");
    let p = cfg
        .create::<FutureProducer>()
        .map_err(|e| kctx("Could not create Kafka producer", e))?;
    let p = Arc::new(p);
    *slot = Some(Arc::clone(&p));
    Ok(p)
}

fn produce_blocking(c: &KafkaConn, req: KafkaProduceRequest) -> AppResult<KafkaProduceResult> {
    if c.read_only {
        return Err(read_only_err("producing messages"));
    }
    if req.topic.trim().is_empty() {
        return Err(AppError::new("Topic is required"));
    }
    let producer = producer_for(c)?;
    let mut headers = OwnedHeaders::new();
    for h in &req.headers {
        headers = headers.insert(Header {
            key: h.key.as_str(),
            value: h.value.as_deref(),
        });
    }
    let mut record: FutureRecord<'_, str, str> = FutureRecord::to(&req.topic);
    if let Some(k) = req.key.as_deref() {
        record = record.key(k);
    }
    if let Some(v) = req.value.as_deref() {
        record = record.payload(v);
    }
    if let Some(p) = req.partition {
        record = record.partition(p);
    }
    if !req.headers.is_empty() {
        record = record.headers(headers);
    }
    // VERIFY: FutureProducer::send(record, Timeout) resolves to Result<(i32, i64), (KafkaError, OwnedMessage)>.
    let sent = block_on_rt(producer.send(record, Timeout::After(CALL_TIMEOUT)))?;
    match sent {
        Ok((partition, offset)) => Ok(KafkaProduceResult { partition, offset }),
        Err((e, _)) => Err(kctx("Produce failed", e)),
    }
}

pub fn produce(
    c: &KafkaConn,
    req: KafkaProduceRequest,
) -> BoxFuture<'static, AppResult<KafkaProduceResult>> {
    let c = c.clone();
    blocking(move || produce_blocking(&c, req))
}

fn reset_blocking(
    c: &KafkaConn,
    group: &str,
    topic: &str,
    to: &str,
    value: Option<i64>,
) -> AppResult<u64> {
    if c.read_only {
        return Err(read_only_err("resetting offsets"));
    }
    let list = c
        .consumer
        .fetch_group_list(Some(group), CALL_TIMEOUT)
        .map_err(|e| kctx("Could not read the consumer group", e))?;
    let g = list
        .groups()
        .iter()
        .find(|g| g.name() == group)
        .ok_or_else(|| AppError::new(format!("Consumer group \"{}\" not found", group)))?;
    if g.state() != "Empty" {
        return Err(AppError::new(format!(
            "Consumer group \"{}\" is {}; stop its consumers (the group must be Empty) before resetting offsets",
            group,
            g.state()
        )));
    }
    let parts = topic_partition_ids(c, topic)?;
    let mut marks: BTreeMap<i32, (i64, i64)> = BTreeMap::new();
    for p in &parts {
        marks.insert(*p, watermarks(c, topic, *p)?);
    }
    let mut targets: BTreeMap<i32, i64> = BTreeMap::new();
    match to.to_lowercase().as_str() {
        "earliest" => {
            for (p, (low, _)) in &marks {
                targets.insert(*p, *low);
            }
        }
        "latest" => {
            for (p, (_, high)) in &marks {
                targets.insert(*p, *high);
            }
        }
        "timestamp" => {
            let ts = value.ok_or_else(|| AppError::new("A timestamp (epoch ms) is required"))?;
            let found = offsets_for_ts(&c.consumer, topic, &parts, ts)?;
            for (p, (_, high)) in &marks {
                targets.insert(*p, found.get(p).copied().flatten().unwrap_or(*high));
            }
        }
        "offset" => {
            let off = value.ok_or_else(|| AppError::new("An offset is required"))?;
            if off < 0 {
                return Err(AppError::new("The offset must not be negative"));
            }
            for (p, (low, high)) in &marks {
                targets.insert(*p, off.clamp(*low, *high));
            }
        }
        other => {
            return Err(AppError::new(format!(
                "Unknown reset target \"{}\" (earliest, latest, timestamp, offset)",
                other
            )))
        }
    }
    let mut tpl = TopicPartitionList::new();
    for (p, o) in &targets {
        tpl.add_partition_offset(topic, *p, Offset::Offset(*o))
            .map_err(kerr)?;
    }
    let gc = group_consumer(c, group)?;
    // VERIFY: committing for an Empty group from a consumer that never joined (generation -1).
    gc.commit(&tpl, CommitMode::Sync)
        .map_err(|e| kctx("Could not commit offsets", e))?;
    Ok(targets.len() as u64)
}

pub fn reset_offsets(
    c: &KafkaConn,
    group: &str,
    topic: &str,
    to: &str,
    value: Option<i64>,
) -> BoxFuture<'static, AppResult<u64>> {
    let c = c.clone();
    let (group, topic, to) = (group.to_string(), topic.to_string(), to.to_string());
    blocking(move || reset_blocking(&c, &group, &topic, &to, value))
}

fn create_topic_blocking(
    c: &KafkaConn,
    topic: &str,
    partitions: i32,
    replication: i32,
) -> AppResult<()> {
    if c.read_only {
        return Err(read_only_err("creating topics"));
    }
    if topic.trim().is_empty() {
        return Err(AppError::new("Topic name is required"));
    }
    if partitions < 1 || replication < 1 {
        return Err(AppError::new(
            "Partitions and replication factor must be at least 1",
        ));
    }
    let nt = NewTopic::new(topic, partitions, TopicReplication::Fixed(replication));
    let opts = AdminOptions::new()
        .request_timeout(Some(CALL_TIMEOUT))
        .operation_timeout(Some(CALL_TIMEOUT));
    let res = block_on_rt(c.admin.create_topics(&[nt], &opts))?
        .map_err(|e| kctx("Could not create topic", e))?;
    for r in res {
        if let Err((name, code)) = r {
            return Err(AppError::new(format!(
                "Could not create topic {}: {}",
                name, code
            )));
        }
    }
    Ok(())
}

pub fn create_topic(
    c: &KafkaConn,
    topic: &str,
    partitions: i32,
    replication: i32,
) -> BoxFuture<'static, AppResult<()>> {
    let c = c.clone();
    let topic = topic.to_string();
    blocking(move || create_topic_blocking(&c, &topic, partitions, replication))
}

fn delete_topic_blocking(c: &KafkaConn, topic: &str) -> AppResult<()> {
    if c.read_only {
        return Err(read_only_err("deleting topics"));
    }
    if topic.trim().is_empty() {
        return Err(AppError::new("Topic name is required"));
    }
    let opts = AdminOptions::new()
        .request_timeout(Some(CALL_TIMEOUT))
        .operation_timeout(Some(CALL_TIMEOUT));
    let res = block_on_rt(c.admin.delete_topics(&[topic], &opts))?
        .map_err(|e| kctx("Could not delete topic", e))?;
    for r in res {
        if let Err((name, code)) = r {
            return Err(AppError::new(format!(
                "Could not delete topic {}: {}",
                name, code
            )));
        }
    }
    Ok(())
}

pub fn delete_topic(c: &KafkaConn, topic: &str) -> BoxFuture<'static, AppResult<()>> {
    let c = c.clone();
    let topic = topic.to_string();
    blocking(move || delete_topic_blocking(&c, &topic))
}

// ---------------------------------------------------------------------------
// Server objects
// ---------------------------------------------------------------------------

pub fn list_server_objects(c: &KafkaConn) -> BoxFuture<'static, AppResult<Vec<ObjectGroup>>> {
    let c = c.clone();
    blocking(move || {
        let md = fetch_meta(&c, None)?;
        let mut brokers: Vec<(i32, String)> = md
            .brokers()
            .iter()
            .map(|b| (b.id(), format!("{}:{}", b.host(), b.port())))
            .collect();
        brokers.sort_by_key(|b| b.0);
        let cluster = ObjectGroup {
            label: "Cluster".to_string(),
            items: vec![
                ObjectItem {
                    name: "Cluster ID".to_string(),
                    detail: Some("unknown".to_string()),
                },
                ObjectItem {
                    name: "Controller".to_string(),
                    detail: Some("unknown".to_string()),
                },
                ObjectItem {
                    name: "Brokers".to_string(),
                    detail: Some(brokers.len().to_string()),
                },
            ],
            error: None,
        };
        let list = ObjectGroup {
            label: "Brokers".to_string(),
            items: brokers
                .into_iter()
                .map(|(id, addr)| ObjectItem {
                    name: id.to_string(),
                    detail: Some(addr),
                })
                .collect(),
            error: None,
        };
        Ok(vec![cluster, list])
    })
}

// ---------------------------------------------------------------------------
// Command language
// ---------------------------------------------------------------------------

struct Shaped {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<Value>>,
    rows_affected: Option<u64>,
}

fn col(name: &str, type_name: &str) -> ColumnMeta {
    ColumnMeta {
        name: name.to_string(),
        type_name: type_name.to_string(),
    }
}

fn affected(n: u64) -> Shaped {
    Shaped {
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected: Some(n),
    }
}

fn opt_i64(v: Option<i64>) -> Value {
    v.map(int_value).unwrap_or(Value::Null)
}

/// Splits a line into tokens. Whitespace separates; single or double quotes group (also in the
/// middle of a token, as in `key="a b"`); inside double quotes `\" \\ \n \t \r` are escapes.
fn tokenize(line: &str) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else if ch == '\\' && q == '"' {
                    match chars.peek().copied() {
                        Some('n') => {
                            cur.push('\n');
                            chars.next();
                        }
                        Some('t') => {
                            cur.push('\t');
                            chars.next();
                        }
                        Some('r') => {
                            cur.push('\r');
                            chars.next();
                        }
                        Some('"') => {
                            cur.push('"');
                            chars.next();
                        }
                        Some('\\') => {
                            cur.push('\\');
                            chars.next();
                        }
                        _ => cur.push('\\'),
                    }
                } else {
                    cur.push(ch);
                }
            }
            None => {
                if ch.is_whitespace() {
                    if started {
                        out.push(std::mem::take(&mut cur));
                        started = false;
                    }
                } else if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                    started = true;
                } else {
                    cur.push(ch);
                    started = true;
                }
            }
        }
    }
    if quote.is_some() {
        return Err(AppError::new("Unbalanced quotes in command"));
    }
    if started {
        out.push(cur);
    }
    Ok(out)
}

fn parse_ts(s: &str) -> AppResult<i64> {
    let t = s.trim();
    if let Ok(n) = t.parse::<i64>() {
        return Ok(n);
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(t) {
        return Ok(d.timestamp_millis());
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        if let Some(dt) = d.and_hms_opt(0, 0, 0) {
            return Ok(dt.and_utc().timestamp_millis());
        }
    }
    Err(AppError::new(format!(
        "Cannot parse timestamp \"{}\" (use ISO 8601 such as 2024-05-01T12:00:00Z, or epoch milliseconds)",
        s
    )))
}

fn parse_num<T: std::str::FromStr>(name: &str, s: &str) -> AppResult<T> {
    s.trim()
        .parse::<T>()
        .map_err(|_| AppError::new(format!("{} must be a number, got \"{}\"", name, s)))
}

fn parse_consume(args: &[String]) -> AppResult<KafkaConsumeRequest> {
    let topic = args
        .first()
        .ok_or_else(|| AppError::new("Usage: consume <topic> [--from-beginning|--latest|--from-timestamp <ISO>|--offset <n>] [--partition <n>] [--limit <n>] [--key-contains <s>] [--value-contains <s>]"))?
        .clone();
    let mut req = KafkaConsumeRequest {
        topic,
        partition: None,
        from: "latest".to_string(),
        timestamp_ms: None,
        offset: None,
        positions: None,
        limit: 100,
        key_contains: None,
        value_contains: None,
        timeout_ms: None,
    };
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        // --opt=value form.
        let (flag, inline): (&str, Option<String>) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (a, None),
        };
        let value = |i: &mut usize| -> AppResult<String> {
            if let Some(v) = inline.clone() {
                return Ok(v);
            }
            *i += 1;
            args.get(*i)
                .cloned()
                .ok_or_else(|| AppError::new(format!("{} needs a value", flag)))
        };
        match flag {
            "--from-beginning" | "--earliest" => req.from = "earliest".to_string(),
            "--latest" => req.from = "latest".to_string(),
            "--from-timestamp" => {
                let v = value(&mut i)?;
                req.from = "timestamp".to_string();
                req.timestamp_ms = Some(parse_ts(&v)?);
            }
            "--offset" => {
                let v = value(&mut i)?;
                req.from = "offset".to_string();
                req.offset = Some(parse_num::<i64>("--offset", &v)?);
            }
            "--partition" => {
                let v = value(&mut i)?;
                req.partition = Some(parse_num::<i32>("--partition", &v)?);
            }
            "--limit" => {
                let v = value(&mut i)?;
                req.limit = parse_num::<u32>("--limit", &v)?;
            }
            "--key-contains" => req.key_contains = Some(value(&mut i)?),
            "--value-contains" => req.value_contains = Some(value(&mut i)?),
            other => {
                return Err(AppError::new(format!(
                    "Unknown consume option \"{}\"",
                    other
                )));
            }
        }
        i += 1;
    }
    Ok(req)
}

fn parse_produce(args: &[String]) -> AppResult<KafkaProduceRequest> {
    let topic = args
        .first()
        .ok_or_else(|| {
            AppError::new(
                "Usage: produce <topic> [key=<k>] [partition=<n>] [header.<k>=<v>]... value=<v>",
            )
        })?
        .clone();
    let mut req = KafkaProduceRequest {
        topic,
        partition: None,
        key: None,
        value: None,
        headers: Vec::new(),
    };
    for a in &args[1..] {
        let (k, v) = a.split_once('=').ok_or_else(|| {
            AppError::new(format!(
                "Expected name=value, got \"{}\" (quote values containing spaces)",
                a
            ))
        })?;
        match k {
            "key" => req.key = Some(v.to_string()),
            "value" => req.value = Some(v.to_string()),
            "partition" => req.partition = Some(parse_num::<i32>("partition", v)?),
            _ => match k.strip_prefix("header.") {
                Some(name) if !name.is_empty() => req.headers.push(KafkaHeader {
                    key: name.to_string(),
                    value: Some(v.to_string()),
                }),
                _ => {
                    return Err(AppError::new(format!(
                        "Unknown produce argument \"{}\" (key, value, partition, header.<name>)",
                        k
                    )))
                }
            },
        }
    }
    if req.value.is_none() && req.key.is_none() {
        return Err(AppError::new("produce needs at least value=<v> or key=<k>"));
    }
    Ok(req)
}

fn run_line(c: &KafkaConn, line: &str) -> BoxFuture<'static, AppResult<Shaped>> {
    let c = c.clone();
    let line = line.to_string();
    Box::pin(async move {
        let tokens = tokenize(&line)?;
        let words: Vec<String> = tokens.iter().map(|t| t.to_lowercase()).collect();
        let w0 = words.first().map(String::as_str).unwrap_or("");
        let w1 = words.get(1).map(String::as_str).unwrap_or("");
        match (w0, w1) {
            ("topics", _) => {
                let o = overview(&c).await?;
                Ok(Shaped {
                    columns: vec![
                        col("name", "string"),
                        col("partitions", "int"),
                        col("replication", "int"),
                        col("internal", "bool"),
                    ],
                    rows: o
                        .topics
                        .iter()
                        .map(|t| {
                            vec![
                                json!(t.name),
                                json!(t.partitions),
                                json!(t.replication_factor),
                                json!(t.internal),
                            ]
                        })
                        .collect(),
                    rows_affected: None,
                })
            }
            ("groups", _) => {
                let o = overview(&c).await?;
                Ok(Shaped {
                    columns: vec![
                        col("group_id", "string"),
                        col("state", "string"),
                        col("protocol_type", "string"),
                        col("members", "int"),
                    ],
                    rows: o
                        .groups
                        .iter()
                        .map(|g| {
                            vec![
                                json!(g.group_id),
                                json!(g.state),
                                json!(g.protocol_type),
                                json!(g.members),
                            ]
                        })
                        .collect(),
                    rows_affected: None,
                })
            }
            ("brokers", _) => {
                let o = overview(&c).await?;
                Ok(Shaped {
                    columns: vec![
                        col("id", "int"),
                        col("host", "string"),
                        col("port", "int"),
                        col("controller", "bool"),
                    ],
                    rows: o
                        .brokers
                        .iter()
                        .map(|b| {
                            vec![
                                json!(b.id),
                                json!(b.host),
                                json!(b.port),
                                json!(b.is_controller),
                            ]
                        })
                        .collect(),
                    rows_affected: None,
                })
            }
            ("describe", "topic") => {
                let name = tokens
                    .get(2)
                    .ok_or_else(|| AppError::new("Usage: describe topic <topic> [configs]"))?;
                let d = topic(&c, name).await?;
                if words.get(3).map(String::as_str) == Some("configs") {
                    return Ok(Shaped {
                        columns: vec![
                            col("name", "string"),
                            col("value", "string"),
                            col("default", "bool"),
                        ],
                        rows: d
                            .configs
                            .iter()
                            .map(|e| vec![json!(e.name), json!(e.value), json!(e.is_default)])
                            .collect(),
                        rows_affected: None,
                    });
                }
                Ok(Shaped {
                    columns: vec![
                        col("partition", "int"),
                        col("leader", "int"),
                        col("replicas", "string"),
                        col("isr", "string"),
                        col("low", "long"),
                        col("high", "long"),
                    ],
                    rows: d
                        .partitions
                        .iter()
                        .map(|p| {
                            vec![
                                json!(p.id),
                                json!(p.leader),
                                json!(join_ints(&p.replicas)),
                                json!(join_ints(&p.isr)),
                                int_value(p.low),
                                int_value(p.high),
                            ]
                        })
                        .collect(),
                    rows_affected: None,
                })
            }
            ("describe", "group") => {
                let name = tokens
                    .get(2)
                    .ok_or_else(|| AppError::new("Usage: describe group <group>"))?;
                let g = group(&c, name).await?;
                Ok(Shaped {
                    columns: vec![
                        col("topic", "string"),
                        col("partition", "int"),
                        col("committed", "long"),
                        col("end", "long"),
                        col("lag", "long"),
                    ],
                    rows: g
                        .offsets
                        .iter()
                        .map(|o| {
                            vec![
                                json!(o.topic),
                                json!(o.partition),
                                opt_i64(o.committed),
                                int_value(o.end),
                                opt_i64(o.lag),
                            ]
                        })
                        .collect(),
                    rows_affected: None,
                })
            }
            ("consume", _) => {
                let req = parse_consume(&tokens[1..])?;
                let r = consume(&c, req).await?;
                Ok(Shaped {
                    columns: vec![
                        col("partition", "int"),
                        col("offset", "long"),
                        col("timestamp", "timestamp"),
                        col("key", "string"),
                        col("value", "string"),
                        col("headers", "json"),
                    ],
                    rows: r
                        .messages
                        .iter()
                        .map(|m| {
                            let hdrs: Vec<Value> = m
                                .headers
                                .iter()
                                .map(|h| json!({ "key": h.key, "value": h.value }))
                                .collect();
                            vec![
                                json!(m.partition),
                                int_value(m.offset),
                                m.timestamp_ms
                                    .and_then(iso_time)
                                    .map(Value::String)
                                    .unwrap_or(Value::Null),
                                json!(m.key),
                                json!(m.value),
                                Value::String(Value::Array(hdrs).to_string()),
                            ]
                        })
                        .collect(),
                    rows_affected: None,
                })
            }
            ("produce", _) => {
                let req = parse_produce(&tokens[1..])?;
                let r = produce(&c, req).await?;
                Ok(Shaped {
                    columns: vec![col("partition", "int"), col("offset", "long")],
                    rows: vec![vec![json!(r.partition), int_value(r.offset)]],
                    rows_affected: None,
                })
            }
            ("create", "topic") => {
                let name = tokens.get(2).ok_or_else(|| {
                    AppError::new("Usage: create topic <topic> [partitions=<n>] [replication=<n>]")
                })?;
                let mut partitions = 1i32;
                let mut replication = 1i32;
                for a in &tokens[3..] {
                    match a.split_once('=') {
                        Some(("partitions", v)) => partitions = parse_num("partitions", v)?,
                        Some(("replication", v)) => replication = parse_num("replication", v)?,
                        _ => {
                            return Err(AppError::new(format!(
                                "Unknown create topic argument \"{}\" (partitions=<n>, replication=<n>)",
                                a
                            )))
                        }
                    }
                }
                create_topic(&c, name, partitions, replication).await?;
                Ok(affected(1))
            }
            ("delete", "topic") => {
                let name = tokens
                    .get(2)
                    .ok_or_else(|| AppError::new("Usage: delete topic <topic>"))?;
                delete_topic(&c, name).await?;
                Ok(affected(1))
            }
            _ => Err(AppError::new(format!(
                "Unknown command \"{}\". Commands: {}",
                tokens.first().map(String::as_str).unwrap_or(""),
                COMMANDS_HELP
            ))),
        }
    })
}

fn join_ints(v: &[i32]) -> String {
    v.iter()
        .map(|x| x.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// Runs the command language: one command per line (blank lines and `#`/`--` comments skipped).
/// The last command's result is returned.
pub fn stream<'a>(
    c: &'a KafkaConn,
    text: &'a str,
    sink: &'a mut dyn RowSink,
) -> BoxFuture<'a, AppResult<StreamEnd>> {
    Box::pin(async move {
        let mut last: Option<Shaped> = None;
        for raw in text.lines() {
            let line = raw.trim().trim_end_matches(';').trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("--") {
                continue;
            }
            last = Some(run_line(c, line).await?);
        }
        let shaped = match last {
            Some(s) => s,
            None => return Err(AppError::new("Empty command")),
        };
        if shaped.columns.is_empty() {
            return Ok(StreamEnd {
                rows_affected: shaped.rows_affected,
                stopped_early: false,
            });
        }
        sink.columns(&shaped.columns)?;
        let mut stopped = false;
        for r in shaped.rows {
            if !sink.row(r)? {
                stopped = true;
                break;
            }
        }
        Ok(StreamEnd {
            rows_affected: None,
            stopped_early: stopped,
        })
    })
}

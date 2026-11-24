//! Persistent state: connection configs (JSON file), passwords (OS keyring, in-memory fallback)
//! and query history (SQLite database).

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, HistoryEntry};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "DataTrip";
const VAULT_KEYRING_SERVICE: &str = "DataTrip-Vault";
const HISTORY_KEEP: i64 = 5000;

pub struct Store {
    connections_path: PathBuf,
    file_lock: tokio::sync::Mutex<()>,
    history: SqlitePool,
    /// Used only when the OS keyring is unavailable. Never written to disk.
    mem_passwords: Mutex<HashMap<String, String>>,
    /// Same fallback for Vault tokens (keychain token source).
    mem_vault_tokens: Mutex<HashMap<String, String>>,
}

impl Store {
    pub async fn open(config_dir: &Path, data_dir: &Path) -> AppResult<Store> {
        let opts = SqliteConnectOptions::new()
            .filename(data_dir.join("history.db"))
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS history (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                connection_id TEXT NOT NULL, \
                \"sql\" TEXT NOT NULL, \
                executed_at TEXT NOT NULL, \
                elapsed_ms INTEGER NOT NULL, \
                \"rows\" INTEGER NULL, \
                ok INTEGER NOT NULL, \
                error TEXT NULL)",
        )
        .execute(&pool)
        .await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_history_conn ON history (connection_id, id)")
            .execute(&pool)
            .await?;
        Ok(Store {
            connections_path: config_dir.join("connections.json"),
            file_lock: tokio::sync::Mutex::new(()),
            history: pool,
            mem_passwords: Mutex::new(HashMap::new()),
            mem_vault_tokens: Mutex::new(HashMap::new()),
        })
    }

    // ----- connections -----

    fn read_connections(&self) -> AppResult<Vec<ConnectionConfig>> {
        match std::fs::read_to_string(&self.connections_path) {
            Ok(text) => {
                if text.trim().is_empty() {
                    return Ok(Vec::new());
                }
                serde_json::from_str::<Vec<ConnectionConfig>>(&text).map_err(|e| {
                    AppError::new(format!(
                        "Could not read {}: {}",
                        self.connections_path.display(),
                        e
                    ))
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn write_connections(&self, list: &[ConnectionConfig]) -> AppResult<()> {
        let json = serde_json::to_string_pretty(list)?;
        let tmp = self.connections_path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.connections_path)?;
        Ok(())
    }

    pub async fn list_connections(&self) -> AppResult<Vec<ConnectionConfig>> {
        let _g = self.file_lock.lock().await;
        self.read_connections()
    }

    pub async fn get_connection(&self, id: &str) -> AppResult<ConnectionConfig> {
        let list = self.list_connections().await?;
        list.into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::new("Connection not found"))
    }

    /// `password`: None keeps the stored one, Some("") clears it, Some(p) stores it.
    pub async fn save_connection(
        &self,
        mut config: ConnectionConfig,
        password: Option<String>,
    ) -> AppResult<ConnectionConfig> {
        if config.id.trim().is_empty() {
            config.id = uuid::Uuid::new_v4().to_string();
        }
        {
            let _g = self.file_lock.lock().await;
            let mut list = self.read_connections()?;
            match list.iter().position(|c| c.id == config.id) {
                Some(i) => list[i] = config.clone(),
                None => list.push(config.clone()),
            }
            self.write_connections(&list)?;
        }
        match password {
            None => {}
            Some(p) if p.is_empty() => self.clear_password(&config.id),
            Some(p) => self.set_password(&config.id, &p),
        }
        Ok(config)
    }

    pub async fn delete_connection(&self, id: &str) -> AppResult<()> {
        {
            let _g = self.file_lock.lock().await;
            let mut list = self.read_connections()?;
            list.retain(|c| c.id != id);
            self.write_connections(&list)?;
        }
        self.clear_password(id);
        self.clear_vault_token(id);
        Ok(())
    }

    // ----- passwords -----

    fn mem(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.mem_passwords.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_password(&self, id: &str, password: &str) {
        let res = keyring::Entry::new(KEYRING_SERVICE, id).and_then(|e| e.set_password(password));
        match res {
            Ok(()) => {
                self.mem().remove(id);
            }
            Err(_) => {
                self.mem().insert(id.to_string(), password.to_string());
            }
        }
    }

    fn clear_password(&self, id: &str) {
        // NoEntry (nothing stored) and keyring failures are both fine here.
        let _ = keyring::Entry::new(KEYRING_SERVICE, id).and_then(|e| e.delete_credential());
        self.mem().remove(id);
    }

    pub fn get_password(&self, id: &str) -> Option<String> {
        if id.is_empty() {
            return None;
        }
        if let Some(p) = self.mem().get(id) {
            return Some(p.clone());
        }
        match keyring::Entry::new(KEYRING_SERVICE, id).and_then(|e| e.get_password()) {
            Ok(p) => Some(p),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => None,
        }
    }

    // ----- vault tokens -----

    fn mem_tokens(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.mem_vault_tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Stores the Vault token for a connection; an empty token deletes it.
    pub fn set_vault_token(&self, id: &str, token: &str) {
        if id.is_empty() {
            return;
        }
        if token.is_empty() {
            self.clear_vault_token(id);
            return;
        }
        let res =
            keyring::Entry::new(VAULT_KEYRING_SERVICE, id).and_then(|e| e.set_password(token));
        match res {
            Ok(()) => {
                self.mem_tokens().remove(id);
            }
            Err(_) => {
                self.mem_tokens().insert(id.to_string(), token.to_string());
            }
        }
    }

    pub fn clear_vault_token(&self, id: &str) {
        let _ = keyring::Entry::new(VAULT_KEYRING_SERVICE, id).and_then(|e| e.delete_credential());
        self.mem_tokens().remove(id);
    }

    pub fn get_vault_token(&self, id: &str) -> Option<String> {
        if id.is_empty() {
            return None;
        }
        if let Some(t) = self.mem_tokens().get(id) {
            return Some(t.clone());
        }
        keyring::Entry::new(VAULT_KEYRING_SERVICE, id)
            .and_then(|e| e.get_password())
            .ok()
    }

    // ----- history -----

    pub async fn add_history(
        &self,
        connection_id: &str,
        sql: &str,
        elapsed_ms: i64,
        rows: Option<i64>,
        ok: bool,
        error: Option<&str>,
    ) -> AppResult<()> {
        let executed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query(
            "INSERT INTO history (connection_id, \"sql\", executed_at, elapsed_ms, \"rows\", ok, error) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(connection_id.to_string())
        .bind(sql.to_string())
        .bind(executed_at)
        .bind(elapsed_ms)
        .bind(rows)
        .bind(if ok { 1_i64 } else { 0_i64 })
        .bind(error.map(|s| s.to_string()))
        .execute(&self.history)
        .await?;
        sqlx::query(
            "DELETE FROM history WHERE id <= \
             (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?)",
        )
        .bind(HISTORY_KEEP)
        .execute(&self.history)
        .await?;
        Ok(())
    }

    pub async fn list_history(
        &self,
        connection_id: Option<String>,
        search: Option<String>,
        limit: u32,
    ) -> AppResult<Vec<HistoryEntry>> {
        let mut sql = String::from(
            "SELECT id, connection_id, \"sql\", executed_at, elapsed_ms, \"rows\", ok, error \
             FROM history WHERE 1 = 1",
        );
        let conn_filter = connection_id.filter(|c| !c.is_empty());
        let search_filter = search
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if conn_filter.is_some() {
            sql.push_str(" AND connection_id = ?");
        }
        if search_filter.is_some() {
            sql.push_str(" AND \"sql\" LIKE ? ESCAPE '\\'");
        }
        sql.push_str(" ORDER BY id DESC LIMIT ?");

        let limit: i64 = if limit == 0 {
            200
        } else {
            i64::from(limit.min(5000))
        };
        let mut q = sqlx::query::<sqlx::Sqlite>(&sql);
        if let Some(c) = conn_filter {
            q = q.bind(c);
        }
        if let Some(s) = search_filter {
            let escaped = s
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            q = q.bind(format!("%{}%", escaped));
        }
        q = q.bind(limit);
        let rows = q.fetch_all(&self.history).await?;

        let mut out: Vec<HistoryEntry> = Vec::with_capacity(rows.len());
        for r in rows {
            out.push(HistoryEntry {
                id: r.try_get::<i64, _>("id")?,
                connection_id: r.try_get::<String, _>("connection_id")?,
                sql: r.try_get::<String, _>("sql")?,
                executed_at: r.try_get::<String, _>("executed_at")?,
                elapsed_ms: r.try_get::<i64, _>("elapsed_ms")?,
                rows: r.try_get::<Option<i64>, _>("rows")?,
                ok: r.try_get::<i64, _>("ok")? != 0,
                error: r.try_get::<Option<String>, _>("error")?,
            });
        }
        Ok(out)
    }
}

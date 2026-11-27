//! Application error type. Serializes as `{ "message": string, "position"?: number, "line"?: number }`
//! (`position` / `line` only when the driver reported where a statement failed).

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use std::fmt;

#[derive(Debug, Clone)]
pub struct AppError {
    pub message: String,
    /// 1-based character offset into the executed statement where it failed (PostgreSQL, MySQL).
    pub position: Option<usize>,
    /// 1-based line of the executed statement where it failed (SQL Server, MySQL).
    pub line: Option<usize>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(message: impl Into<String>) -> Self {
        AppError {
            message: message.into(),
            position: None,
            line: None,
        }
    }

    /// Fills `position` from MySQL's "… near '<rest>' at line N" once the executed statement is known
    /// (the snippet is the statement text from the failing token on).
    pub fn locate_in(mut self, sql: &str) -> Self {
        if self.position.is_some() {
            return self;
        }
        let line = match self.line {
            Some(l) if l >= 1 => l,
            _ => return self,
        };
        let snippet = match mysql_near_snippet(&self.message) {
            Some(s) => s,
            None => return self,
        };
        if snippet.is_empty() {
            // "near '' at line N": the statement ended too early.
            let n = sql.trim_end().chars().count();
            if n > 0 {
                self.position = Some(n);
            }
            return self;
        }
        let mut start = 0usize;
        for _ in 1..line {
            match sql[start..].find('\n') {
                Some(i) => start += i + 1,
                None => return self,
            }
        }
        if let Some(i) = sql[start..].find(snippet.as_str()) {
            self.position = Some(sql[..start + i].chars().count() + 1);
        }
        self
    }
}

/// MySQL syntax errors end with "… near '<rest of the statement>' at line N".
fn mysql_error_line(message: &str) -> Option<usize> {
    if !message.contains("near '") {
        return None;
    }
    let i = message.rfind("' at line ")?;
    let digits: String = message[i + "' at line ".len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse::<usize>().ok().filter(|n| *n >= 1)
}

fn mysql_near_snippet(message: &str) -> Option<String> {
    let a = message.find("near '")? + "near '".len();
    let b = message.rfind("' at line ")?;
    if b < a {
        return None;
    }
    Some(message[a..b].to_string())
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let n = 1 + usize::from(self.position.is_some()) + usize::from(self.line.is_some());
        let mut st = serializer.serialize_struct("AppError", n)?;
        st.serialize_field("message", &self.message)?;
        if let Some(p) = self.position {
            st.serialize_field("position", &p)?;
        }
        if let Some(l) = self.line {
            st.serialize_field("line", &l)?;
        }
        st.end()
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::Database(d) => {
                let mut err = AppError::new(d.message().to_string());
                if let Some(pg) = d.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() {
                    if let Some(sqlx::postgres::PgErrorPosition::Original(p)) = pg.position() {
                        err.position = Some(p);
                    }
                } else {
                    err.line = mysql_error_line(&err.message);
                }
                err
            }
            _ => AppError::new(e.to_string()),
        }
    }
}

impl From<tiberius::error::Error> for AppError {
    fn from(e: tiberius::error::Error) -> Self {
        let line = match &e {
            tiberius::error::Error::Server(t) if t.line() > 0 => Some(t.line() as usize),
            _ => None,
        };
        let mut err = AppError::new(e.to_string());
        err.line = line;
        err
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::new(format!("Keyring error: {}", e))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new(e.to_string())
    }
}

impl From<csv::Error> for AppError {
    fn from(e: csv::Error) -> Self {
        AppError::new(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::new(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::new(e.to_string())
    }
}

impl From<String> for AppError {
    fn from(e: String) -> Self {
        AppError::new(e)
    }
}

impl From<&str> for AppError {
    fn from(e: &str) -> Self {
        AppError::new(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_near_position() {
        let msg = "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server \
                   version for the right syntax to use near 'FORM users' at line 2";
        let mut e = AppError::new(msg);
        e.line = mysql_error_line(msg);
        assert_eq!(e.line, Some(2));
        let e = e.locate_in("SELECT *\nFORM users");
        assert_eq!(e.position, Some(10));
    }

    #[test]
    fn serializes_without_position() {
        let v = serde_json::to_value(AppError::new("x")).unwrap_or_default();
        assert_eq!(v, serde_json::json!({ "message": "x" }));
    }
}

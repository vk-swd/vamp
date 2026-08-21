use serde::{Deserialize, Serialize};

/// A 64-bit integer ID serialised as a string for safe JavaScript interop.
///
/// JavaScript's `number` type cannot safely represent integers beyond 2^53 - 1,
/// so database row IDs (SQLite BIGINT / i64) are transmitted as decimal strings.
///
/// On the Rust side, use [`BigintId::to_i64`] before binding to a SQL query.
/// SQLite rows that derive [`sqlx::FromRow`] convert automatically via the
/// `#[sqlx(try_from = "i64")]` attribute on each field.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
#[specta(transparent)]
pub struct BigintId(pub String);

impl BigintId {
    pub fn from_i64(n: i64) -> Self {
        BigintId(n.to_string())
    }

    pub fn to_i64(&self) -> i64 {
        self.0.parse().expect("BigintId: invalid integer string")
    }
}

impl TryFrom<i64> for BigintId {
    type Error = std::convert::Infallible;
    fn try_from(n: i64) -> Result<Self, Self::Error> {
        Ok(BigintId::from_i64(n))
    }
}

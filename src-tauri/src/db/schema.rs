use serde::{Deserialize, Serialize};

/// Full row returned from the `track_info` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TrackRow {
    pub id: i64,
    pub artist: String,
    pub track_name: String,
    pub length_seconds: Option<i32>,
    pub bitrate_kbps: Option<i32>,
    pub tempo_bpm: Option<f32>,
    pub addition_time: String,
}

/// Full row returned from the `errors` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ErrorRow {
    pub key: String,
    pub error_text: String,
}

/// Full row returned from the `track_add_conflicts` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TrackAddConflict {
    pub id: i64,
    pub artist: String,
    pub track_name: String,
    pub length_seconds: Option<i32>,
    pub bitrate_kbps: Option<i32>,
    pub tempo_bpm: Option<f32>,
    pub addition_time: String,
    pub conflict_reason: String,
    pub same_track_id: i64,
}

/// Full row returned from the `track_sources` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TrackSource {
    pub id: i64,
    pub track_id: i64,
    pub url: String,
}

/// Full row returned from the `listen_info` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ListenInfo {
    pub id: i64,
    pub track_id: i64,
    pub listened_from: i64,
    pub listened_to: i64,
}

/// Full row returned from the `tags` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Tag {
    pub id: i64,
    pub tag_name: String,
}

/// Full row returned from the `track_meta` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TrackMeta {
    pub id: i64,
    pub track_id: i64,
    pub key: String,
    pub value: String,
}

/// Input for inserting a new track.
#[derive(Debug, Serialize, Deserialize)]
pub struct NewTrack {
    pub artist: String,
    pub track_name: String,
    pub length_seconds: Option<i32>,
    pub bitrate_kbps: Option<i32>,
    pub tempo_bpm: Option<f32>,
    pub addition_time: String,
    pub sources: Vec<String>,
}

/// Partial update — only `Some` fields are written to the database.
/// Pass `None` for any field that should remain unchanged.
#[derive(Debug, Serialize, Deserialize)]
pub struct TrackUpdate {
    pub artist: Option<String>,
    pub track_name: Option<String>,
    pub length_seconds: Option<i32>,
    pub bitrate_kbps: Option<i32>,
    pub tempo_bpm: Option<f32>,
    pub addition_time: Option<String>,
}

/// Input for inserting a new error record.
#[derive(Debug, Serialize, Deserialize)]
pub struct NewError {
    pub key: String,
    pub error_text: String,
}

// ---------------------------------------------------------------------------
// Search / filter types (mirror of the TypeScript SearchParam / SearchCriteria)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub enum NumericOperator {
    #[serde(rename = "<")]  Lt,
    #[serde(rename = ">")]  Gt,
    #[serde(rename = "=")]  Eq,
    #[serde(rename = "<=")] Lte,
    #[serde(rename = ">=")] Gte,
    #[serde(rename = "!=")] Ne,
}

impl NumericOperator {
    pub fn as_sql(&self) -> &'static str {
        match self {
            Self::Lt  => "<",
            Self::Gt  => ">",
            Self::Eq  => "=",
            Self::Lte => "<=",
            Self::Gte => ">=",
            Self::Ne  => "!=",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SearchParam {
    NumericComparison { operator: NumericOperator, value: f64 },
    NumericBetween    { min: f64, max: f64 },
    TextLike          { pattern: String, case_sensitive: bool },
    TextIn            { values: Vec<String> },
    NullCheck         { is_null: bool },
    /// Filter tracks by tag IDs. Use with `column_name = "tags"`.
    /// Returns tracks that have at least one of the provided tag IDs assigned.
    TagsIn            { tag_ids: Vec<i64> },
    /// Like TagsIn, but only returns tracks that have ALL of the provided tag IDs assigned.
    TagsAll           { tag_ids: Vec<i64> },
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchCriteria {
    pub column_name: String,
    pub criteria: Vec<SearchParam>,
}

/// Input for `assign_tags`: one track paired with the tag IDs to assign to it.
#[derive(Debug, Serialize, Deserialize)]
pub struct TagAssignment {
    pub track_id: i64,
    pub tag_ids: Vec<i64>,
}

/// Input for inserting a new track-add conflict record.
#[derive(Debug, Serialize, Deserialize)]
pub struct NewTrackConflict {
    pub artist: String,
    pub track_name: String,
    pub length_seconds: Option<i32>,
    pub bitrate_kbps: Option<i32>,
    pub tempo_bpm: Option<f32>,
    pub addition_time: String,
    pub conflict_reason: String,
    pub same_track_id: i64,
}

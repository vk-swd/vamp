use serde::{Deserialize, Serialize};

/// Full row returned from the `track_info` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TrackRow {
    pub id: i64,
    pub artist: String,
    pub track_name: String,
    pub length_seconds: i32,
    pub bitrate_kbps: i32,
    pub tempo_bpm: f32,
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
    pub length_seconds: i32,
    pub bitrate_kbps: i32,
    pub tempo_bpm: f32,
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
    pub length_seconds: i32,
    pub bitrate_kbps: i32,
    pub tempo_bpm: f32,
    pub addition_time: String,
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

/// Input for inserting a new track-add conflict record.
#[derive(Debug, Serialize, Deserialize)]
pub struct NewTrackConflict {
    pub artist: String,
    pub track_name: String,
    pub length_seconds: i32,
    pub bitrate_kbps: i32,
    pub tempo_bpm: f32,
    pub addition_time: String,
    pub conflict_reason: String,
    pub same_track_id: i64,
}

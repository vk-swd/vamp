use async_trait::async_trait;
use std::sync::Arc;

use crate::db::schema::{
    ListenInfo, NewError, NewTrack, NewTrackConflict, SearchCriteria, Tag, TagAssignment,
    TrackMeta, TrackRow, TrackSource, TrackUpdate,
};

/// Shared-ownership, type-erased repository handle used as Tauri managed state.
pub type ArcRepo = Arc<dyn AppRepository + Send + Sync>;

/// Unified repository trait covering all data operations.
///
/// Implement this trait on a new struct to swap the storage backend
/// (e.g., replace SQLite with PostgreSQL) without touching any command or
/// business logic.
#[async_trait]
pub trait AppRepository: Send + Sync {
    // ------------------------------------------------------------------
    // Tracks
    // ------------------------------------------------------------------

    /// Insert a new track and return its generated `id`.
    async fn add_track(&self, track: NewTrack) -> Result<i64, sqlx::Error>;

    /// Insert multiple tracks in a single transaction; returns all generated IDs in order.
    async fn add_tracks(&self, tracks: Vec<NewTrack>) -> Result<Vec<i64>, sqlx::Error>;

    /// Apply a partial update; only `Some` fields are written to the row.
    async fn update_track(&self, id: i64, update: TrackUpdate) -> Result<(), sqlx::Error>;

    /// Cursor-based pagination ordered by `id ASC`.
    /// Returns rows with `id > cursor`; pass `None` to start from the beginning.
    /// `criteria` is an optional list of column filters received from the frontend.
    async fn get_tracks(
        &self,
        cursor: Option<i64>,
        criteria: Option<Vec<SearchCriteria>>,
        limit: u32,
    ) -> Result<Vec<TrackRow>, sqlx::Error>;

    async fn get_track(&self, id: i64) -> Result<TrackRow, sqlx::Error>;

    async fn delete_track(&self, id: i64) -> Result<(), sqlx::Error>;

    // ------------------------------------------------------------------
    // Listen history
    // ------------------------------------------------------------------

    /// Record a listening session and return its generated `id`.
    async fn add_listen(&self, track_id: i64, from: i64, to: i64) -> Result<i64, sqlx::Error>;

    async fn get_listens_for_track(
        &self,
        track_id: i64,
    ) -> Result<Vec<ListenInfo>, sqlx::Error>;

    // ------------------------------------------------------------------
    // Tags
    // ------------------------------------------------------------------

    async fn add_tag(&self, name: String) -> Result<i64, sqlx::Error>;

    async fn edit_tag(&self, id: i64, name: String) -> Result<(), sqlx::Error>;

    async fn delete_tag(&self, id: i64) -> Result<(), sqlx::Error>;

    async fn get_all_tags(&self) -> Result<Vec<Tag>, sqlx::Error>;

    async fn get_tags(&self, pattern: String) -> Result<Vec<Tag>, sqlx::Error>;

    async fn assign_tag(&self, track_id: i64, tag_id: i64) -> Result<(), sqlx::Error>;

    /// Assign multiple tags to multiple tracks in a single transaction.
    async fn assign_tags(&self, assignments: Vec<TagAssignment>) -> Result<(), sqlx::Error>;

    async fn remove_tag(&self, track_id: i64, tag_id: i64) -> Result<(), sqlx::Error>;

    async fn get_tags_for_track(&self, track_id: i64) -> Result<Vec<Tag>, sqlx::Error>;

    // ------------------------------------------------------------------
    // Track metadata
    // ------------------------------------------------------------------

    async fn add_meta(
        &self,
        track_id: i64,
        key: String,
        value: String,
    ) -> Result<i64, sqlx::Error>;

    async fn update_meta(&self, id: i64, value: String) -> Result<(), sqlx::Error>;

    async fn delete_meta(&self, id: i64) -> Result<(), sqlx::Error>;

    async fn get_meta_for_track(&self, track_id: i64) -> Result<Vec<TrackMeta>, sqlx::Error>;

    // ------------------------------------------------------------------
    // Track sources
    // ------------------------------------------------------------------

    /// Add a URL for a track; returns the new row's `id`.
    async fn add_track_source(&self, track_id: i64, url: String) -> Result<i64, sqlx::Error>;

    /// Remove a URL from a track (looked up by track_id + url).
    async fn remove_track_source(&self, track_id: i64, url: String) -> Result<(), sqlx::Error>;

    /// Atomically swap `old_url` for `new_url` on the given track.
    async fn edit_track_source(
        &self,
        track_id: i64,
        old_url: String,
        new_url: String,
    ) -> Result<(), sqlx::Error>;

    async fn get_sources_for_track(
        &self,
        track_id: i64,
    ) -> Result<Vec<TrackSource>, sqlx::Error>;

    /// Fetch a page of tracks together with their sources in two queries
    /// (one for tracks, one IN-query for all their sources).
    async fn get_tracks_with_sources(
        &self,
        cursor: Option<i64>,
        criteria: Option<Vec<SearchCriteria>>,
        limit: u32,
    ) -> Result<Vec<crate::db::schema::TrackWithSources>, sqlx::Error>;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// Insert an error record; returns the key on success.
    async fn add_error(&self, error: NewError) -> Result<String, sqlx::Error>;

    // ------------------------------------------------------------------
    // Track-add conflicts
    // ------------------------------------------------------------------

    /// Record a track-add conflict and return its generated `id`.
    async fn add_track_conflict(&self, conflict: NewTrackConflict) -> Result<i64, sqlx::Error>;
}

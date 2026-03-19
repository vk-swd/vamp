use std::path::Path;

use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::db::repository::AppRepository;
use crate::db::schema::{ListenInfo, NewTrack, Tag, TrackMeta, TrackRow, TrackSource, TrackUpdate};

/// Concrete SQLite-backed implementation of [`AppRepository`].
pub struct SqliteRepository {
    pool: SqlitePool,
}

impl SqliteRepository {
    /// Open (or create) the SQLite database at `path`, run all pending
    /// migrations, and return a ready-to-use repository.
    ///
    /// Foreign-key enforcement is activated on every connection via the
    /// `foreign_keys` pragma baked into the connection options.
    pub async fn new(path: impl AsRef<Path>) -> Result<Self, sqlx::Error> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .pragma("foreign_keys", "ON")
            .create_if_missing(true);

        let pool = SqlitePoolOptions::new().connect_with(options).await?;

        // sqlx::migrate!() reads files from `./migrations` relative to
        // Cargo.toml at compile time; no DATABASE_URL is needed.
        sqlx::migrate!().run(&pool).await?;

        Ok(Self { pool })
    }
}

#[async_trait]
impl AppRepository for SqliteRepository {
    // ------------------------------------------------------------------
    // Tracks
    // ------------------------------------------------------------------

    async fn add_track(&self, t: NewTrack) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "INSERT INTO track_info (artist, track_name, length_seconds, bitrate_kbps, tempo_bpm)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(t.artist)
        .bind(t.track_name)
        .bind(t.length_seconds)
        .bind(t.bitrate_kbps)
        .bind(t.tempo_bpm)
        .execute(&self.pool)
        .await?;

        Ok(row.last_insert_rowid())
    }

    async fn update_track(&self, id: i64, u: TrackUpdate) -> Result<(), sqlx::Error> {
        // Build the SET clause dynamically — column names come from our code,
        // never from user input, so string interpolation is safe here.
        let mut cols: Vec<&str> = Vec::new();
        if u.artist.is_some()          { cols.push("artist = ?"); }
        if u.track_name.is_some()      { cols.push("track_name = ?"); }
        if u.length_seconds.is_some()  { cols.push("length_seconds = ?"); }
        if u.bitrate_kbps.is_some()    { cols.push("bitrate_kbps = ?"); }
        if u.tempo_bpm.is_some()       { cols.push("tempo_bpm = ?"); }

        if cols.is_empty() {
            return Ok(());
        }

        let sql = format!("UPDATE track_info SET {} WHERE id = ?", cols.join(", "));
        let mut q = sqlx::query(&sql);
        if let Some(v) = u.artist         { q = q.bind(v); }
        if let Some(v) = u.track_name     { q = q.bind(v); }
        if let Some(v) = u.length_seconds { q = q.bind(v); }
        if let Some(v) = u.bitrate_kbps   { q = q.bind(v); }
        if let Some(v) = u.tempo_bpm      { q = q.bind(v); }
        q = q.bind(id);

        q.execute(&self.pool).await?;
        Ok(())
    }

    async fn get_tracks(
        &self,
        cursor: Option<i64>,
        limit: u32,
    ) -> Result<Vec<TrackRow>, sqlx::Error> {
        let after = cursor.unwrap_or(0);
        sqlx::query_as::<_, TrackRow>(
            "SELECT * FROM track_info WHERE id > ? ORDER BY id ASC LIMIT ?",
        )
        .bind(after)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
    }

    async fn get_track(&self, id: i64) -> Result<TrackRow, sqlx::Error> {
        sqlx::query_as::<_, TrackRow>("SELECT * FROM track_info WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
    }

    async fn delete_track(&self, id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM track_info WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Listen history
    // ------------------------------------------------------------------

    async fn add_listen(&self, track_id: i64, from: i64, to: i64) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "INSERT INTO listen_info (track_id, listened_from, listened_to) VALUES (?, ?, ?)",
        )
        .bind(track_id)
        .bind(from)
        .bind(to)
        .execute(&self.pool)
        .await?;

        Ok(row.last_insert_rowid())
    }

    async fn get_listens_for_track(
        &self,
        track_id: i64,
    ) -> Result<Vec<ListenInfo>, sqlx::Error> {
        sqlx::query_as::<_, ListenInfo>(
            "SELECT * FROM listen_info WHERE track_id = ? ORDER BY id ASC",
        )
        .bind(track_id)
        .fetch_all(&self.pool)
        .await
    }

    // ------------------------------------------------------------------
    // Tags
    // ------------------------------------------------------------------

    async fn add_tag(&self, name: String) -> Result<i64, sqlx::Error> {
        let row = sqlx::query("INSERT INTO tags (tag_name) VALUES (?)")
            .bind(name)
            .execute(&self.pool)
            .await?;
        Ok(row.last_insert_rowid())
    }

    async fn edit_tag(&self, id: i64, name: String) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE tags SET tag_name = ? WHERE id = ?")
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn delete_tag(&self, id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM tags WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn get_all_tags(&self) -> Result<Vec<Tag>, sqlx::Error> {
        sqlx::query_as::<_, Tag>("SELECT * FROM tags ORDER BY id ASC")
            .fetch_all(&self.pool)
            .await
    }

    async fn assign_tag(&self, track_id: i64, tag_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT OR IGNORE INTO tag_assignments (track_id, tag_id) VALUES (?, ?)",
        )
        .bind(track_id)
        .bind(tag_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn remove_tag(&self, track_id: i64, tag_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM tag_assignments WHERE track_id = ? AND tag_id = ?",
        )
        .bind(track_id)
        .bind(tag_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn get_tags_for_track(&self, track_id: i64) -> Result<Vec<Tag>, sqlx::Error> {
        sqlx::query_as::<_, Tag>(
            "SELECT t.id, t.tag_name
             FROM tags t
             INNER JOIN tag_assignments ta ON ta.tag_id = t.id
             WHERE ta.track_id = ?
             ORDER BY t.id ASC",
        )
        .bind(track_id)
        .fetch_all(&self.pool)
        .await
    }

    // ------------------------------------------------------------------
    // Track metadata
    // ------------------------------------------------------------------

    async fn add_meta(
        &self,
        track_id: i64,
        key: String,
        value: String,
    ) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "INSERT INTO track_meta (track_id, key, value) VALUES (?, ?, ?)",
        )
        .bind(track_id)
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;

        Ok(row.last_insert_rowid())
    }

    async fn update_meta(&self, id: i64, value: String) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE track_meta SET value = ? WHERE id = ?")
            .bind(value)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn delete_meta(&self, id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM track_meta WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn get_meta_for_track(&self, track_id: i64) -> Result<Vec<TrackMeta>, sqlx::Error> {
        sqlx::query_as::<_, TrackMeta>(
            "SELECT * FROM track_meta WHERE track_id = ? ORDER BY id ASC",
        )
        .bind(track_id)
        .fetch_all(&self.pool)
        .await
    }

    // ------------------------------------------------------------------
    // Track sources
    // ------------------------------------------------------------------

    async fn add_track_source(&self, track_id: i64, url: String) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "INSERT INTO track_sources (track_id, url) VALUES (?, ?)",
        )
        .bind(track_id)
        .bind(url)
        .execute(&self.pool)
        .await?;
        Ok(row.last_insert_rowid())
    }

    async fn remove_track_source(&self, track_id: i64, url: String) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM track_sources WHERE track_id = ? AND url = ?",
        )
        .bind(track_id)
        .bind(url)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn edit_track_source(
        &self,
        track_id: i64,
        old_url: String,
        new_url: String,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "DELETE FROM track_sources WHERE track_id = ? AND url = ?",
        )
        .bind(track_id)
        .bind(&old_url)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO track_sources (track_id, url) VALUES (?, ?)",
        )
        .bind(track_id)
        .bind(&new_url)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn get_sources_for_track(
        &self,
        track_id: i64,
    ) -> Result<Vec<TrackSource>, sqlx::Error> {
        sqlx::query_as::<_, TrackSource>(
            "SELECT * FROM track_sources WHERE track_id = ? ORDER BY id ASC",
        )
        .bind(track_id)
        .fetch_all(&self.pool)
        .await
    }
}

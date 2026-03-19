use std::path::Path;

use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::db::repository::AppRepository;
use crate::db::schema::{
    ListenInfo, NewError, NewTrack, NewTrackConflict, Tag, TrackMeta, TrackRow, TrackSource,
    TrackUpdate,
};

// ---------------------------------------------------------------------------
// Error-logging helper
// ---------------------------------------------------------------------------
//
// Every `?`-propagated sqlx error is first written to `errors` (best-effort)
// and printed to stdout before being returned to the caller.  If the DB write
// itself fails, that failure is reported on stdout as well.
//
// `add_error` is intentionally NOT wrapped by `try_log` to prevent infinite
// recursion.

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

    /// On `Err`, logs the error both to stdout and (best-effort) to the
    /// `errors` table, then returns the error unchanged so the caller can
    /// propagate it.
    async fn try_log<T>(
        &self,
        context: &str,
        result: Result<T, sqlx::Error>,
    ) -> Result<T, sqlx::Error> {
        let e = match result {
            Ok(v) => return Ok(v),
            Err(e) => e,
        };

        let error_text = format!("[{}] {}", context, e);
        println!("[ERROR] {}", error_text);

        let db_result = sqlx::query("INSERT INTO errors (error_text) VALUES (?)")
            .bind(&error_text)
            .execute(&self.pool)
            .await;

        match db_result {
            Ok(_) => println!("[error_log] recorded to db: OK"),
            Err(ref log_err) => println!("[error_log] recorded to db: FAILED ({})", log_err),
        }

        Err(e)
    }
}

#[async_trait]
impl AppRepository for SqliteRepository {
    // ------------------------------------------------------------------
    // Tracks
    // ------------------------------------------------------------------

    async fn add_track(&self, t: NewTrack) -> Result<i64, sqlx::Error> {
        if t.sources.is_empty() {
            return Err(sqlx::Error::Protocol(
                "add_track: at least one source URL is required".into(),
            ));
        }

        let mut tx = self
            .try_log("add_track: begin transaction", self.pool.begin().await)
            .await?;

        let row = self
            .try_log(
                "add_track: insert track_info",
                sqlx::query(
                    "INSERT INTO track_info
                         (artist, track_name, length_seconds, bitrate_kbps, tempo_bpm, addition_time)
                     VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(t.artist)
                .bind(t.track_name)
                .bind(t.length_seconds)
                .bind(t.bitrate_kbps)
                .bind(t.tempo_bpm)
                .bind(t.addition_time)
                .execute(&mut *tx)
                .await,
            )
            .await?;

        let track_id = row.last_insert_rowid();

        for url in t.sources {
            self.try_log(
                "add_track: insert track_sources",
                sqlx::query("INSERT INTO track_sources (track_id, url) VALUES (?, ?)")
                    .bind(track_id)
                    .bind(url)
                    .execute(&mut *tx)
                    .await,
            )
            .await?;
        }

        self.try_log("add_track: commit", tx.commit().await).await?;
        Ok(track_id)
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
        if u.addition_time.is_some()   { cols.push("addition_time = ?"); }

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
        if let Some(v) = u.addition_time  { q = q.bind(v); }
        q = q.bind(id);

        self.try_log("update_track", q.execute(&self.pool).await)
            .await
            .map(|_| ())
    }

    async fn get_tracks(
        &self,
        cursor: Option<i64>,
        limit: u32,
    ) -> Result<Vec<TrackRow>, sqlx::Error> {
        let after = cursor.unwrap_or(0);
        self.try_log(
            "get_tracks",
            sqlx::query_as::<_, TrackRow>(
                "SELECT * FROM track_info WHERE id > ? ORDER BY id ASC LIMIT ?",
            )
            .bind(after)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await,
        )
        .await
    }

    async fn get_track(&self, id: i64) -> Result<TrackRow, sqlx::Error> {
        self.try_log(
            "get_track",
            sqlx::query_as::<_, TrackRow>("SELECT * FROM track_info WHERE id = ?")
                .bind(id)
                .fetch_one(&self.pool)
                .await,
        )
        .await
    }

    async fn delete_track(&self, id: i64) -> Result<(), sqlx::Error> {
        self.try_log(
            "delete_track",
            sqlx::query("DELETE FROM track_info WHERE id = ?")
                .bind(id)
                .execute(&self.pool)
                .await,
        )
        .await
        .map(|_| ())
    }

    // ------------------------------------------------------------------
    // Listen history
    // ------------------------------------------------------------------

    async fn add_listen(&self, track_id: i64, from: i64, to: i64) -> Result<i64, sqlx::Error> {
        self.try_log(
            "add_listen",
            sqlx::query(
                "INSERT INTO listen_info (track_id, listened_from, listened_to) VALUES (?, ?, ?)",
            )
            .bind(track_id)
            .bind(from)
            .bind(to)
            .execute(&self.pool)
            .await,
        )
        .await
        .map(|r| r.last_insert_rowid())
    }

    async fn get_listens_for_track(
        &self,
        track_id: i64,
    ) -> Result<Vec<ListenInfo>, sqlx::Error> {
        self.try_log(
            "get_listens_for_track",
            sqlx::query_as::<_, ListenInfo>(
                "SELECT * FROM listen_info WHERE track_id = ? ORDER BY id ASC",
            )
            .bind(track_id)
            .fetch_all(&self.pool)
            .await,
        )
        .await
    }

    // ------------------------------------------------------------------
    // Tags
    // ------------------------------------------------------------------

    async fn add_tag(&self, name: String) -> Result<i64, sqlx::Error> {
        self.try_log(
            "add_tag",
            sqlx::query("INSERT INTO tags (tag_name) VALUES (?)")
                .bind(name)
                .execute(&self.pool)
                .await,
        )
        .await
        .map(|r| r.last_insert_rowid())
    }

    async fn edit_tag(&self, id: i64, name: String) -> Result<(), sqlx::Error> {
        self.try_log(
            "edit_tag",
            sqlx::query("UPDATE tags SET tag_name = ? WHERE id = ?")
                .bind(name)
                .bind(id)
                .execute(&self.pool)
                .await,
        )
        .await
        .map(|_| ())
    }

    async fn delete_tag(&self, id: i64) -> Result<(), sqlx::Error> {
        self.try_log(
            "delete_tag",
            sqlx::query("DELETE FROM tags WHERE id = ?")
                .bind(id)
                .execute(&self.pool)
                .await,
        )
        .await
        .map(|_| ())
    }

    async fn get_all_tags(&self) -> Result<Vec<Tag>, sqlx::Error> {
        self.try_log(
            "get_all_tags",
            sqlx::query_as::<_, Tag>("SELECT * FROM tags ORDER BY id ASC")
                .fetch_all(&self.pool)
                .await,
        )
        .await
    }

    async fn assign_tag(&self, track_id: i64, tag_id: i64) -> Result<(), sqlx::Error> {
        self.try_log(
            "assign_tag",
            sqlx::query(
                "INSERT OR IGNORE INTO tag_assignments (track_id, tag_id) VALUES (?, ?)",
            )
            .bind(track_id)
            .bind(tag_id)
            .execute(&self.pool)
            .await,
        )
        .await
        .map(|_| ())
    }

    async fn remove_tag(&self, track_id: i64, tag_id: i64) -> Result<(), sqlx::Error> {
        self.try_log(
            "remove_tag",
            sqlx::query(
                "DELETE FROM tag_assignments WHERE track_id = ? AND tag_id = ?",
            )
            .bind(track_id)
            .bind(tag_id)
            .execute(&self.pool)
            .await,
        )
        .await
        .map(|_| ())
    }

    async fn get_tags_for_track(&self, track_id: i64) -> Result<Vec<Tag>, sqlx::Error> {
        self.try_log(
            "get_tags_for_track",
            sqlx::query_as::<_, Tag>(
                "SELECT t.id, t.tag_name
                 FROM tags t
                 INNER JOIN tag_assignments ta ON ta.tag_id = t.id
                 WHERE ta.track_id = ?
                 ORDER BY t.id ASC",
            )
            .bind(track_id)
            .fetch_all(&self.pool)
            .await,
        )
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
        self.try_log(
            "add_meta",
            sqlx::query(
                "INSERT INTO track_meta (track_id, key, value) VALUES (?, ?, ?)",
            )
            .bind(track_id)
            .bind(key)
            .bind(value)
            .execute(&self.pool)
            .await,
        )
        .await
        .map(|r| r.last_insert_rowid())
    }

    async fn update_meta(&self, id: i64, value: String) -> Result<(), sqlx::Error> {
        self.try_log(
            "update_meta",
            sqlx::query("UPDATE track_meta SET value = ? WHERE id = ?")
                .bind(value)
                .bind(id)
                .execute(&self.pool)
                .await,
        )
        .await
        .map(|_| ())
    }

    async fn delete_meta(&self, id: i64) -> Result<(), sqlx::Error> {
        self.try_log(
            "delete_meta",
            sqlx::query("DELETE FROM track_meta WHERE id = ?")
                .bind(id)
                .execute(&self.pool)
                .await,
        )
        .await
        .map(|_| ())
    }

    async fn get_meta_for_track(&self, track_id: i64) -> Result<Vec<TrackMeta>, sqlx::Error> {
        self.try_log(
            "get_meta_for_track",
            sqlx::query_as::<_, TrackMeta>(
                "SELECT * FROM track_meta WHERE track_id = ? ORDER BY id ASC",
            )
            .bind(track_id)
            .fetch_all(&self.pool)
            .await,
        )
        .await
    }

    // ------------------------------------------------------------------
    // Track sources
    // ------------------------------------------------------------------

    async fn add_track_source(&self, track_id: i64, url: String) -> Result<i64, sqlx::Error> {
        self.try_log(
            "add_track_source",
            sqlx::query("INSERT INTO track_sources (track_id, url) VALUES (?, ?)")
                .bind(track_id)
                .bind(url)
                .execute(&self.pool)
                .await,
        )
        .await
        .map(|r| r.last_insert_rowid())
    }

    async fn remove_track_source(&self, track_id: i64, url: String) -> Result<(), sqlx::Error> {
        self.try_log(
            "remove_track_source",
            sqlx::query("DELETE FROM track_sources WHERE track_id = ? AND url = ?")
                .bind(track_id)
                .bind(url)
                .execute(&self.pool)
                .await,
        )
        .await
        .map(|_| ())
    }

    async fn edit_track_source(
        &self,
        track_id: i64,
        old_url: String,
        new_url: String,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self
            .try_log("edit_track_source: begin transaction", self.pool.begin().await)
            .await?;

        self.try_log(
            "edit_track_source: delete old url",
            sqlx::query("DELETE FROM track_sources WHERE track_id = ? AND url = ?")
                .bind(track_id)
                .bind(&old_url)
                .execute(&mut *tx)
                .await,
        )
        .await?;

        self.try_log(
            "edit_track_source: insert new url",
            sqlx::query("INSERT INTO track_sources (track_id, url) VALUES (?, ?)")
                .bind(track_id)
                .bind(&new_url)
                .execute(&mut *tx)
                .await,
        )
        .await?;

        self.try_log("edit_track_source: commit", tx.commit().await)
            .await
            .map(|_| ())
    }

    async fn get_sources_for_track(
        &self,
        track_id: i64,
    ) -> Result<Vec<TrackSource>, sqlx::Error> {
        self.try_log(
            "get_sources_for_track",
            sqlx::query_as::<_, TrackSource>(
                "SELECT * FROM track_sources WHERE track_id = ? ORDER BY id ASC",
            )
            .bind(track_id)
            .fetch_all(&self.pool)
            .await,
        )
        .await
    }

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    async fn add_error(&self, e: NewError) -> Result<String, sqlx::Error> {
        // Intentionally not wrapped with try_log to avoid infinite recursion.
        match sqlx::query("INSERT INTO errors (error_text) VALUES (?)")
            .bind(&e.error_text)
            .execute(&self.pool)
            .await
        {
            Ok(r) => Ok(r.last_insert_rowid().to_string()),
            Err(err) => {
                println!("[ERROR] [add_error] {}", err);
                Err(err)
            }
        }
    }

    // ------------------------------------------------------------------
    // Track-add conflicts
    // ------------------------------------------------------------------

    async fn add_track_conflict(&self, c: NewTrackConflict) -> Result<i64, sqlx::Error> {
        self.try_log(
            "add_track_conflict",
            sqlx::query(
                "INSERT INTO track_add_conflicts
                     (artist, track_name, length_seconds, bitrate_kbps, tempo_bpm,
                      addition_time, conflict_reason, same_track_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(c.artist)
            .bind(c.track_name)
            .bind(c.length_seconds)
            .bind(c.bitrate_kbps)
            .bind(c.tempo_bpm)
            .bind(c.addition_time)
            .bind(c.conflict_reason)
            .bind(c.same_track_id)
            .execute(&self.pool)
            .await,
        )
        .await
        .map(|r| r.last_insert_rowid())
    }
}

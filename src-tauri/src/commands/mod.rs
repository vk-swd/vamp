//! Tauri commands exposed to the React frontend.
//!
//! # Integration steps for `main.rs`
//!
//! **Step 1** — add two module declarations near the top of `main.rs`:
//! ```rust
//! mod db;
//! mod commands;
//! ```
//!
//! **Step 2** — call `setup_database` inside the existing `.setup()` closure,
//! _after_ the `window` / webview setup block:
//! ```rust
//! tauri::async_runtime::block_on(commands::setup_database(app.handle().clone()))?;
//! ```
//!
//! **Step 3** — extend `.invoke_handler(tauri::generate_handler![…])`:
//! ```rust
//! .invoke_handler(tauri::generate_handler![
//!     log_from_ui,
//!     commands::add_track,        commands::update_track,
//!     commands::get_tracks,       commands::get_track,
//!     commands::delete_track,
//!     commands::add_listen,       commands::get_listens_for_track,
//!     commands::add_tag,          commands::edit_tag,
//!     commands::delete_tag,       commands::get_all_tags,
//!     commands::assign_tag,       commands::remove_tag,
//!     commands::get_tags_for_track,
//!     commands::add_meta,         commands::update_meta,
//!     commands::delete_meta,      commands::get_meta_for_track,
//! ])
//! ```

use tauri::Manager;

use crate::db::{
    repository::ArcRepo,
    schema::{ListenInfo, NewTrack, SearchCriteria, Tag, TrackMeta, TrackRow, TrackUpdate},
};

/// Convenience alias: the Tauri State wrapper around the repository handle.
type Repo<'a> = tauri::State<'a, ArcRepo>;

// ======================================================================
// Database initialisation helper (not a Tauri command)
// ======================================================================

/// Resolve the platform app-data directory, open (or create) `vampagent.db`,
/// run pending migrations, and register the repository as Tauri managed state.
///
/// Call this once from inside the `.setup()` closure in `main.rs`.

pub fn default_dir(handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    return handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())
}
pub async fn setup_database(handle: tauri::AppHandle, db_full_path: std::path::PathBuf) -> Result<(), String> {
    let repo = crate::db::sqlite::SqliteRepository::new(db_full_path)
        .await
        .map_err(|e| e.to_string())?;
    // Managing a single database connection because SQLite is used.
    let repo: ArcRepo = std::sync::Arc::new(repo);
    handle.manage(repo);
    Ok(())
}

// ======================================================================
// Track commands
// ======================================================================

#[tauri::command]
pub async fn add_track(repo: Repo<'_>, track: NewTrack) -> Result<i64, String> {
    repo.add_track(track).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_track(
    repo: Repo<'_>,
    id: i64,
    update: TrackUpdate,
) -> Result<(), String> {
    repo.update_track(id, update).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tracks(
    repo: Repo<'_>,
    cursor: Option<i64>,
    criteria: Option<Vec<SearchCriteria>>,
    limit: u32,
) -> Result<Vec<TrackRow>, String> {
    repo.get_tracks(cursor, criteria, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_track(repo: Repo<'_>, id: i64) -> Result<TrackRow, String> {
    repo.get_track(id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_track(repo: Repo<'_>, id: i64) -> Result<(), String> {
    repo.delete_track(id).await.map_err(|e| e.to_string())
}

// ======================================================================
// Listen-history commands
// ======================================================================

#[tauri::command]
pub async fn add_listen(
    repo: Repo<'_>,
    track_id: i64,
    from: i64,
    to: i64,
) -> Result<i64, String> {
    repo.add_listen(track_id, from, to)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_listens_for_track(
    repo: Repo<'_>,
    track_id: i64,
) -> Result<Vec<ListenInfo>, String> {
    repo.get_listens_for_track(track_id)
        .await
        .map_err(|e| e.to_string())
}

// ======================================================================
// Tag commands
// ======================================================================

#[tauri::command]
pub async fn add_tag(repo: Repo<'_>, name: String) -> Result<i64, String> {
    repo.add_tag(name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn edit_tag(repo: Repo<'_>, id: i64, name: String) -> Result<(), String> {
    repo.edit_tag(id, name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_tag(repo: Repo<'_>, id: i64) -> Result<(), String> {
    repo.delete_tag(id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_tags(repo: Repo<'_>) -> Result<Vec<Tag>, String> {
    repo.get_all_tags().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tags(repo: Repo<'_>, pattern: String) -> Result<Vec<Tag>, String> {
    repo.get_tags(pattern).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn assign_tag(
    repo: Repo<'_>,
    track_id: i64,
    tag_id: i64,
) -> Result<(), String> {
    repo.assign_tag(track_id, tag_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_tag(
    repo: Repo<'_>,
    track_id: i64,
    tag_id: i64,
) -> Result<(), String> {
    repo.remove_tag(track_id, tag_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tags_for_track(
    repo: Repo<'_>,
    track_id: i64,
) -> Result<Vec<Tag>, String> {
    repo.get_tags_for_track(track_id)
        .await
        .map_err(|e| e.to_string())
}

// ======================================================================
// Track-metadata commands
// ======================================================================

#[tauri::command]
pub async fn add_meta(
    repo: Repo<'_>,
    track_id: i64,
    key: String,
    value: String,
) -> Result<i64, String> {
    repo.add_meta(track_id, key, value)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_meta(
    repo: Repo<'_>,
    id: i64,
    value: String,
) -> Result<(), String> {
    repo.update_meta(id, value).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_meta(repo: Repo<'_>, id: i64) -> Result<(), String> {
    repo.delete_meta(id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_meta_for_track(
    repo: Repo<'_>,
    track_id: i64,
) -> Result<Vec<TrackMeta>, String> {
    repo.get_meta_for_track(track_id)
        .await
        .map_err(|e| e.to_string())
}

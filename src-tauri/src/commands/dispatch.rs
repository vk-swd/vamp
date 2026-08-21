//! Single-entry-point dispatch command for the frontend.
//!
//! JS usage:
//!   invoke('dispatch', { kind: 'AddTrack',  payload: { artist: '...', ... } })
//!   invoke('dispatch', { kind: 'GetAllTags', payload: null })
//!
//! Every DB operation the app exposes is reachable through this one command.
//! The tagged-union payload is reconstructed server-side from the flat
//! `{ kind, payload }` arguments that Tauri passes through.

use serde::{Deserialize, Serialize};

use crate::commands::listen_guard::ArcListenGuard;
use crate::db::{
    repository::ArcRepo,
    schema::{NewTrack, SearchCriteria, TagAssignment, TrackUpdate},
    filtered_schema::SearchCriteriaFiltered,
    bigint_id::BigintId,
};
use std::fs;
use base64::{Engine, engine::general_purpose::STANDARD};
type Repo<'a> = tauri::State<'a, ArcRepo>;

use std::env;
use std::sync::OnceLock;

static SCRIPT_DATA: OnceLock<String> = OnceLock::new();

fn get_script_data() -> &'static str {
    SCRIPT_DATA.get_or_init(|| {
        let path = env::var("SCRIPT_PATH").expect("SCRIPT_PATH not set");
        let bytes = fs::read(&path).expect("failed to read script file");
        STANDARD.encode(&bytes)
    })
}

// ─── Payload argument structs ────────────────────────────────────────────────
// One struct per command variant that carries more than one field.
// Single-field variants reuse existing schema types directly.

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct UpdateTrackArgs {
    pub id: BigintId,
    pub update: TrackUpdate,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct GetTracksArgs {
    pub cursor: Option<BigintId>,
    pub criteria: Option<Vec<SearchCriteria>>,
    pub limit: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct GetTracksFilteredArgs {
    pub cursor: Option<BigintId>,
    pub criteria: Option<Vec<SearchCriteriaFiltered>>,
    pub limit: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct IdArg {
    pub id: BigintId,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct TrackIdArg {
    pub track_id: BigintId,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct AddListenArgs {
    pub track_id: BigintId,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct AddListenedSecondsArgs {
    pub track_id: BigintId,
    pub seconds: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct NameArg {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct EditTagArgs {
    pub id: BigintId,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct PatternArg {
    pub pattern: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct AssignTagArgs {
    pub track_id: BigintId,
    pub tag_id: BigintId,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct AddMetaArgs {
    pub track_id: BigintId,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct UpdateMetaArgs {
    pub id: BigintId,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct AddTrackSourceArgs {
    pub track_id: BigintId,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct RemoveTrackSourceArgs {
    pub track_id: BigintId,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct EditTrackSourceArgs {
    pub track_id: BigintId,
    pub old_url: String,
    pub new_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct LogFromUiArgs {
    pub message: String,
}

// ─── Command enum ─────────────────────────────────────────────────────────────

/// Discriminated union of every DB operation.
/// JS serialises as `{ "kind": "<VariantName>", "payload": <args> }`.
#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(tag = "kind", content = "payload", rename_all = "PascalCase")]
pub enum Command {
    // Tracks
    AddTrack(NewTrack),
    AddTracks(Vec<NewTrack>),
    UpdateTrack(UpdateTrackArgs),
    GetTracks(GetTracksArgs),
    GetTracksWithSources(GetTracksArgs),
    GetTracksFiltered(GetTracksFilteredArgs),
    GetTrack(IdArg),
    DeleteTrack(IdArg),
    // Listen history
    AddListen(AddListenArgs),
    GetListensForTrack(TrackIdArg),
    AddListenedSeconds(AddListenedSecondsArgs),
    // Tags
    AddTag(NameArg),
    EditTag(EditTagArgs),
    DeleteTag(IdArg),
    GetAllTags(()),       // payload: null
    GetTags(PatternArg),
    AssignTag(AssignTagArgs),
    AssignTags(Vec<TagAssignment>),
    RemoveTag(AssignTagArgs),
    GetTagsForTrack(TrackIdArg),
    // Track metadata
    AddMeta(AddMetaArgs),
    UpdateMeta(UpdateMetaArgs),
    DeleteMeta(IdArg),
    GetMetaForTrack(TrackIdArg),
    // Track sources
    AddTrackSource(AddTrackSourceArgs),
    RemoveTrackSource(RemoveTrackSourceArgs),
    EditTrackSource(EditTrackSourceArgs),
    GetSourcesForTrack(TrackIdArg),
    GetHtmlBundle(()),
    LogFromUi(LogFromUiArgs),
}

// ─── Shared execution logic ───────────────────────────────────────────────────

/// Execute a `Command` against the repository and return a JSON-serialised result.
/// Called by both the Tauri IPC command and the WebSocket server.
pub async fn execute(repo: &ArcRepo, guard: &ArcListenGuard, cmd: Command) -> Result<serde_json::Value, String> {
    let value = match cmd {
        // ── Tracks ─────────────────────────────────────────────────────────
        Command::AddTrack(track) =>
            to_val(repo.add_track(track).await)?,

        Command::AddTracks(tracks) =>
            to_val(repo.add_tracks(tracks).await)?,

        Command::UpdateTrack(UpdateTrackArgs { id, update }) => {
            repo.update_track(id.to_i64(), update).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetTracks(GetTracksArgs { cursor, criteria, limit }) =>
            to_val(repo.get_tracks(cursor.map(|c| c.to_i64()), criteria, limit).await)?,

        Command::GetTracksWithSources(GetTracksArgs { cursor, criteria, limit }) =>
            to_val(repo.get_tracks_with_sources(cursor.map(|c| c.to_i64()), criteria, limit).await)?,

        Command::GetTracksFiltered(GetTracksFilteredArgs { cursor, criteria, limit }) =>
            to_val(repo.get_tracks_filtered(cursor.map(|c| c.to_i64()), criteria, limit).await)?,

        Command::GetTrack(IdArg { id }) =>
            to_val(repo.get_track(id.to_i64()).await)?,

        Command::DeleteTrack(IdArg { id }) => {
            repo.delete_track(id.to_i64()).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        // ── Listen history ──────────────────────────────────────────────────
        Command::AddListen(AddListenArgs { track_id, from, to }) =>
            to_val(repo.add_listen(track_id.to_i64(), from, to).await)?,

        Command::GetListensForTrack(TrackIdArg { track_id }) =>
            to_val(repo.get_listens_for_track(track_id.to_i64()).await)?,

        Command::AddListenedSeconds(AddListenedSecondsArgs { track_id, seconds }) => {
            if guard.should_record(seconds) {
                repo.add_listened_seconds(track_id.to_i64(), seconds).await.map_err(|e| e.to_string())?;
            }
            serde_json::Value::Null
        }

        // ── Tags ────────────────────────────────────────────────────────────
        Command::AddTag(NameArg { name }) =>
            to_val(repo.add_tag(name).await)?,

        Command::EditTag(EditTagArgs { id, name }) => {
            repo.edit_tag(id.to_i64(), name).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::DeleteTag(IdArg { id }) => {
            repo.delete_tag(id.to_i64()).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetAllTags(()) =>
            to_val(repo.get_all_tags().await)?,

        Command::GetTags(PatternArg { pattern }) =>
            to_val(repo.get_tags(pattern).await)?,

        Command::AssignTag(AssignTagArgs { track_id, tag_id }) => {
            repo.assign_tag(track_id.to_i64(), tag_id.to_i64()).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::AssignTags(assignments) => {
            repo.assign_tags(assignments).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::RemoveTag(AssignTagArgs { track_id, tag_id }) => {
            repo.remove_tag(track_id.to_i64(), tag_id.to_i64()).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetTagsForTrack(TrackIdArg { track_id }) =>
            to_val(repo.get_tags_for_track(track_id.to_i64()).await)?,

        // ── Track metadata ──────────────────────────────────────────────────
        Command::AddMeta(AddMetaArgs { track_id, key, value }) =>
            to_val(repo.add_meta(track_id.to_i64(), key, value).await)?,

        Command::UpdateMeta(UpdateMetaArgs { id, value }) => {
            repo.update_meta(id.to_i64(), value).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::DeleteMeta(IdArg { id }) => {
            repo.delete_meta(id.to_i64()).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetMetaForTrack(TrackIdArg { track_id }) =>
            to_val(repo.get_meta_for_track(track_id.to_i64()).await)?,

        // ── Track sources ───────────────────────────────────────────────────
        Command::AddTrackSource(AddTrackSourceArgs { track_id, url }) =>
            to_val(repo.add_track_source(track_id.to_i64(), url).await)?,

        Command::RemoveTrackSource(RemoveTrackSourceArgs { track_id, url }) => {
            repo.remove_track_source(track_id.to_i64(), url).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::EditTrackSource(EditTrackSourceArgs { track_id, old_url, new_url }) => {
            repo.edit_track_source(track_id.to_i64(), old_url, new_url).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetSourcesForTrack(TrackIdArg { track_id }) =>
            to_val(repo.get_sources_for_track(track_id.to_i64()).await)?,
        Command::GetHtmlBundle(()) => {
            // In dev, this serves the unbundled JS/CSS from the webpack dev server
            serde_json::to_value(get_script_data()).map_err(|e| e.to_string())?
        }
        Command::LogFromUi(LogFromUiArgs { message }) => {
            println!("[UI] {}", message);
            serde_json::Value::Null
        }
    };

    Ok(value)
}

// ─── Tauri IPC command ────────────────────────────────────────────────────────

/// Single Tauri command that routes to every DB operation.
///
/// Call from JS as:
/// ```js
/// const result = await invoke('dispatch', { kind: 'AddTrack', payload: { ... } });
/// ```
/// `payload` may be omitted or `null` for zero-argument commands (e.g. `GetAllTags`).
#[tauri::command]
pub async fn dispatch(
    repo: Repo<'_>,
    guard: tauri::State<'_, ArcListenGuard>,
    kind: String,
    payload: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = payload.unwrap_or(serde_json::Value::Null);
    let cmd: Command = serde_json::from_value(serde_json::json!({ "kind": kind, "payload": payload }))
         .map_err(|e| e.to_string())?;
    execute(&*repo, &*guard, cmd).await
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/// Convert a sqlx Result<T> where T: Serialize into a serde_json::Value, mapping
/// both the sqlx error and the serialisation error to String.
fn to_val<T: serde::Serialize>(result: Result<T, sqlx::Error>) -> Result<serde_json::Value, String> {
    let data = result.map_err(|e| e.to_string())?;
    serde_json::to_value(data).map_err(|e| e.to_string())
}

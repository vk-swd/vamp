//! Single-entry-point dispatch command for the frontend.
//!
//! JS usage:
//!   invoke('dispatch', { kind: 'AddTrack',  payload: { artist: '...', ... } })
//!   invoke('dispatch', { kind: 'GetAllTags', payload: null })
//!
//! Every DB operation the app exposes is reachable through this one command.
//! The tagged-union payload is reconstructed server-side from the flat
//! `{ kind, payload }` arguments that Tauri passes through.

use serde::Deserialize;

use crate::db::{
    repository::ArcRepo,
    schema::{NewTrack, SearchCriteria, TagAssignment, TrackUpdate},
};

type Repo<'a> = tauri::State<'a, ArcRepo>;

// ─── Payload argument structs ────────────────────────────────────────────────
// One struct per command variant that carries more than one field.
// Single-field variants reuse existing schema types directly.

#[derive(Deserialize)]
pub struct UpdateTrackArgs {
    pub id: i64,
    pub update: TrackUpdate,
}

#[derive(Deserialize)]
pub struct GetTracksArgs {
    pub cursor: Option<i64>,
    pub criteria: Option<Vec<SearchCriteria>>,
    pub limit: u32,
}

#[derive(Deserialize)]
pub struct IdArg {
    pub id: i64,
}

#[derive(Deserialize)]
pub struct TrackIdArg {
    pub track_id: i64,
}

#[derive(Deserialize)]
pub struct AddListenArgs {
    pub track_id: i64,
    pub from: i64,
    pub to: i64,
}

#[derive(Deserialize)]
pub struct AddListenedSecondsArgs {
    pub track_id: i64,
    pub seconds: i64,
}

#[derive(Deserialize)]
pub struct NameArg {
    pub name: String,
}

#[derive(Deserialize)]
pub struct EditTagArgs {
    pub id: i64,
    pub name: String,
}

#[derive(Deserialize)]
pub struct PatternArg {
    pub pattern: String,
}

#[derive(Deserialize)]
pub struct AssignTagArgs {
    pub track_id: i64,
    pub tag_id: i64,
}

#[derive(Deserialize)]
pub struct AddMetaArgs {
    pub track_id: i64,
    pub key: String,
    pub value: String,
}

#[derive(Deserialize)]
pub struct UpdateMetaArgs {
    pub id: i64,
    pub value: String,
}

// ─── Command enum ─────────────────────────────────────────────────────────────

/// Discriminated union of every DB operation.
/// JS serialises as `{ "kind": "<VariantName>", "payload": <args> }`.
#[derive(Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "PascalCase")]
pub enum Command {
    // Tracks
    AddTrack(NewTrack),
    AddTracks(Vec<NewTrack>),
    UpdateTrack(UpdateTrackArgs),
    GetTracks(GetTracksArgs),
    GetTracksWithSources(GetTracksArgs),
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
}

// ─── Dispatch command ─────────────────────────────────────────────────────────

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
    kind: String,
    payload: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = payload.unwrap_or(serde_json::Value::Null);
    let cmd: Command = serde_json::from_value(serde_json::json!({ "kind": kind, "payload": payload }))
        .map_err(|e| e.to_string())?;

    let value = match cmd {
        // ── Tracks ─────────────────────────────────────────────────────────
        Command::AddTrack(track) =>
            to_val(repo.add_track(track).await)?,

        Command::AddTracks(tracks) =>
            to_val(repo.add_tracks(tracks).await)?,

        Command::UpdateTrack(UpdateTrackArgs { id, update }) => {
            repo.update_track(id, update).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetTracks(GetTracksArgs { cursor, criteria, limit }) =>
            to_val(repo.get_tracks(cursor, criteria, limit).await)?,

        Command::GetTracksWithSources(GetTracksArgs { cursor, criteria, limit }) =>
            to_val(repo.get_tracks_with_sources(cursor, criteria, limit).await)?,

        Command::GetTrack(IdArg { id }) =>
            to_val(repo.get_track(id).await)?,

        Command::DeleteTrack(IdArg { id }) => {
            repo.delete_track(id).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        // ── Listen history ──────────────────────────────────────────────────
        Command::AddListen(AddListenArgs { track_id, from, to }) =>
            to_val(repo.add_listen(track_id, from, to).await)?,

        Command::GetListensForTrack(TrackIdArg { track_id }) =>
            to_val(repo.get_listens_for_track(track_id).await)?,

        Command::AddListenedSeconds(AddListenedSecondsArgs { track_id, seconds }) => {
            repo.add_listened_seconds(track_id, seconds).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        // ── Tags ────────────────────────────────────────────────────────────
        Command::AddTag(NameArg { name }) =>
            to_val(repo.add_tag(name).await)?,

        Command::EditTag(EditTagArgs { id, name }) => {
            repo.edit_tag(id, name).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::DeleteTag(IdArg { id }) => {
            repo.delete_tag(id).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetAllTags(()) =>
            to_val(repo.get_all_tags().await)?,

        Command::GetTags(PatternArg { pattern }) =>
            to_val(repo.get_tags(pattern).await)?,

        Command::AssignTag(AssignTagArgs { track_id, tag_id }) => {
            repo.assign_tag(track_id, tag_id).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::AssignTags(assignments) => {
            repo.assign_tags(assignments).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::RemoveTag(AssignTagArgs { track_id, tag_id }) => {
            repo.remove_tag(track_id, tag_id).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetTagsForTrack(TrackIdArg { track_id }) =>
            to_val(repo.get_tags_for_track(track_id).await)?,

        // ── Track metadata ──────────────────────────────────────────────────
        Command::AddMeta(AddMetaArgs { track_id, key, value }) =>
            to_val(repo.add_meta(track_id, key, value).await)?,

        Command::UpdateMeta(UpdateMetaArgs { id, value }) => {
            repo.update_meta(id, value).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::DeleteMeta(IdArg { id }) => {
            repo.delete_meta(id).await.map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }

        Command::GetMetaForTrack(TrackIdArg { track_id }) =>
            to_val(repo.get_meta_for_track(track_id).await)?,
    };

    Ok(value)
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/// Convert a sqlx Result<T> where T: Serialize into a serde_json::Value, mapping
/// both the sqlx error and the serialisation error to String.
fn to_val<T: serde::Serialize>(result: Result<T, sqlx::Error>) -> Result<serde_json::Value, String> {
    let data = result.map_err(|e| e.to_string())?;
    serde_json::to_value(data).map_err(|e| e.to_string())
}

import { invoke } from '@tauri-apps/api/core';

// ─── Types mirroring src-tauri/src/db/schema.rs ─────────────────────────────

export type TrackRow = {
  id: number;
  artist: string;
  track_name: string;
  length_seconds: number | null;
  bitrate_kbps: number | null;
  tempo_bpm: number | null;
  addition_time: string;
};

export type Tag = {
  id: number;
  tag_name: string;
};

export type ListenInfo = {
  id: number;
  track_id: number;
  listened_from: number;
  listened_to: number;
};

export type TrackMeta = {
  id: number;
  track_id: number;
  key: string;
  value: string;
};

export type TrackSource = {
  id: number;
  track_id: number;
  url: string;
};

export type NewTrack = {
  artist: string;
  track_name: string;
  length_seconds: number | null;
  bitrate_kbps: number | null;
  tempo_bpm: number | null;
  addition_time: string;
  sources: string[];
};

export type TrackUpdate = {
  artist?: string | null;
  track_name?: string | null;
  length_seconds?: number | null;
  bitrate_kbps?: number | null;
  tempo_bpm?: number | null;
  addition_time?: string | null;
};

// ─── Search / filter types (mirror of SearchParam / SearchCriteria in schema.rs)

// Note: field names use snake_case to match Rust's serde deserialization.
// The `mode` tag matches the Rust #[serde(tag = "mode", rename_all = "snake_case")]
// enum variants.

export type SearchParam =
  | { mode: 'numeric_comparison'; operator: '<' | '>' | '=' | '<=' | '>=' | '!='; value: number }
  | { mode: 'numeric_between'; min: number; max: number }
  | { mode: 'text_like'; pattern: string; case_sensitive: boolean }
  | { mode: 'text_in'; values: string[] }
  | { mode: 'null_check'; is_null: boolean }
  | { mode: 'tags_in'; tag_ids: number[] };

export type SearchCriteria = {
  column_name: string;
  criteria: SearchParam[];
};

// ─── Tauri command wrappers ──────────────────────────────────────────────────
// Each function maps 1-to-1 to a #[tauri::command] in src-tauri/src/commands/mod.rs.

// Tracks
export const addTrack = (track: NewTrack): Promise<number> =>
  invoke('add_track', { track });

export const updateTrack = (id: number, update: TrackUpdate): Promise<void> =>
  invoke('update_track', { id, update });

export const getTracks = (
  cursor: number | null,
  criteria: SearchCriteria[] | null,
  limit: number,
): Promise<TrackRow[]> =>
  invoke('get_tracks', { cursor, criteria, limit });

export const getTrack = (id: number): Promise<TrackRow> =>
  invoke('get_track', { id });

export const deleteTrack = (id: number): Promise<void> =>
  invoke('delete_track', { id });

// Listen history
export const addListen = (trackId: number, from: number, to: number): Promise<number> =>
  invoke('add_listen', { trackId, from, to });

export const getListensForTrack = (trackId: number): Promise<ListenInfo[]> =>
  invoke('get_listens_for_track', { trackId });

// Tags
export const addTag = (name: string): Promise<number> =>
  invoke('add_tag', { name });

export const editTag = (id: number, name: string): Promise<void> =>
  invoke('edit_tag', { id, name });

export const deleteTag = (id: number): Promise<void> =>
  invoke('delete_tag', { id });

export const getAllTags = (): Promise<Tag[]> =>
  invoke('get_all_tags');

export const getTagsByPattern = (pattern: string): Promise<Tag[]> =>
  invoke('get_tags', { pattern });

export const assignTag = (trackId: number, tagId: number): Promise<void> =>
  invoke('assign_tag', { trackId, tagId });

export const removeTagFromTrack = (trackId: number, tagId: number): Promise<void> =>
  invoke('remove_tag', { trackId, tagId });

export const getTagsForTrack = (trackId: number): Promise<Tag[]> =>
  invoke('get_tags_for_track', { trackId });

// Track metadata
export const addMeta = (trackId: number, key: string, value: string): Promise<number> =>
  invoke('add_meta', { trackId, key, value });

export const updateMeta = (id: number, value: string): Promise<void> =>
  invoke('update_meta', { id, value });

export const deleteMeta = (id: number): Promise<void> =>
  invoke('delete_meta', { id });

export const getMetaForTrack = (trackId: number): Promise<TrackMeta[]> =>
  invoke('get_meta_for_track', { trackId });

// Track sources
export const addTrackSource = (trackId: number, url: string): Promise<number> =>
  invoke('add_track_source', { trackId, url });

export const removeTrackSource = (trackId: number, url: string): Promise<void> =>
  invoke('remove_track_source', { trackId, url });

export const editTrackSource = (trackId: number, oldUrl: string, newUrl: string): Promise<void> =>
  invoke('edit_track_source', { trackId, oldUrl, newUrl });

export const getSourcesForTrack = (trackId: number): Promise<TrackSource[]> =>
  invoke('get_sources_for_track', { trackId });

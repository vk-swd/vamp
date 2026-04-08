import { dispatch } from './dispatchClient';
// ─── Types mirroring src-tauri/src/db/schema.rs ─────────────────────────────

export type TrackRow = {
  id: number;
  artist: string;
  track_name: string;
  length_seconds: number | null;
  bitrate_kbps: number | null;
  tempo_bpm: number | null;
  addition_time: string;
  listened_seconds: number;
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

// export type TrackMeta = {
//   id: number;
//   track_id: number;
//   key: string;
//   value: string;
// };

export type TrackSource = {
  id: number;
  track_id: number;
  url: string;
};

/** A TrackRow with all its source URLs bundled in — mirrors schema::TrackWithSources. */
export type TrackWithSources = TrackRow & { sources: TrackSource[] };

export type NewTrack = Omit<TrackRow, 'id'> & {
  sources: string[];
};

export type TrackUpdate = Partial<TrackRow>;

// ─── Search / filter types (mirror of SearchParam / SearchCriteria in schema.rs)

// Note: field names use snake_case to match Rust's serde deserialization.
// The `mode` tag matches the Rust #[serde(tag = "mode", rename_all = "snake_case")]
// enum variants.

type NumericComparison = {
  mode: 'numeric_comparison';
  operator: '<' | '>' | '=' | '<=' | '>=' | '!=';
  value: number;
};

export type NumericBetween = {
  mode: 'numeric_between';
  min: number;
  max: number;  // inclusive on both ends
};

// --- Text searches ---

export type TextLike = {
  mode: 'text_like';
  pattern: string;       // e.g. "%rock%", "The%", "%band"
  caseSensitive: boolean;
};

export type TextIn = {
  mode: 'text_in';
  values: string[];
};

export type TagsIn = {
  mode: 'tags_in';
  /** Track must have AT LEAST ONE of these tag IDs. */
  tag_ids: number[];
};

export type TagsAll = {
  mode: 'tags_all';
  /** Track must have ALL of these tag IDs. */
  tag_ids: number[];
};

// --- Null search ---

export type NullCheck = {
  mode: 'null_check';
  is_null: boolean;  // true = IS NULL, false = IS NOT NULL
};

// --- Union ---

export type SearchParam = NumericComparison
  | NumericBetween
  | TextLike
  | TextIn
  | TagsIn
  | TagsAll
  | NullCheck;

export type SearchCriteria = {
  column_name: string;
  criteria: SearchParam[];
};

/** Input for `assign_tags`: one track paired with its tag IDs. */
export type TagAssignment = {
  track_id: number;
  tag_ids: number[];
};

// ─── Tauri command wrappers ──────────────────────────────────────────────────
// All operations are routed through dispatchClient (invoke or WebSocket mode).
// Tracks
export const addTrack = (track: NewTrack): Promise<number> =>
  dispatch('AddTrack', track);

export const addTracks = (tracks: NewTrack[]): Promise<number[]> =>
  dispatch('AddTracks', tracks);

export const updateTrack = (id: number, update: TrackUpdate): Promise<void> =>
  dispatch('UpdateTrack', { id, update });

export const getTracks = (
  cursor: number | null,
  criteria: SearchCriteria[] | null,
  limit: number,
): Promise<TrackRow[]> =>
  dispatch('GetTracks', { cursor, criteria, limit });

export const getTracksWithSources = (
  cursor: number | null,
  criteria: SearchCriteria[] | null,
  limit: number,
): Promise<TrackWithSources[]> =>
  dispatch('GetTracksWithSources', { cursor, criteria, limit });

export const getTrack = (id: number): Promise<TrackRow> =>
  dispatch('GetTrack', { id });

export const deleteTrack = (id: number): Promise<void> =>
  dispatch('DeleteTrack', { id });

// Listen history
export const addListen = (trackId: number, from: number, to: number): Promise<number> =>
  dispatch('AddListen', { track_id: trackId, from, to });

export const getListensForTrack = (trackId: number): Promise<ListenInfo[]> =>
  dispatch('GetListensForTrack', { track_id: trackId });

export const addListenedSeconds = (trackId: number, seconds: number): Promise<void> =>
  dispatch('AddListenedSeconds', { track_id: trackId, seconds });

// Tags
export const addTag = (name: string): Promise<number> =>
  dispatch('AddTag', { name });

export const editTag = (id: number, name: string): Promise<void> =>
  dispatch('EditTag', { id, name });

export const deleteTag = (id: number): Promise<void> =>
  dispatch('DeleteTag', { id });

export const getAllTags = (): Promise<Tag[]> =>
  dispatch('GetAllTags');

export const getTagsByPattern = (pattern: string): Promise<Tag[]> =>
  dispatch('GetTags', { pattern });

export const assignTag = (trackId: number, tagId: number): Promise<void> =>
  dispatch('AssignTag', { track_id: trackId, tag_id: tagId });

export const assignTags = (assignments: TagAssignment[]): Promise<void> =>
  dispatch('AssignTags', assignments);

export const removeTagFromTrack = (trackId: number, tagId: number): Promise<void> =>
  dispatch('RemoveTag', { track_id: trackId, tag_id: tagId });

export const getTagsForTrack = (trackId: number): Promise<Tag[]> =>
  dispatch('GetTagsForTrack', { track_id: trackId });

// Track metadata
export const addMeta = (trackId: number, key: string, value: string): Promise<number> =>
  dispatch('AddMeta', { track_id: trackId, key, value });

export const updateMeta = (id: number, value: string): Promise<void> =>
  dispatch('UpdateMeta', { id, value });

export const deleteMeta = (id: number): Promise<void> =>
  dispatch('DeleteMeta', { id });

// Track sources
export const addTrackSource = (trackId: number, url: string): Promise<number> =>
  dispatch('AddTrackSource', { track_id: trackId, url });

export const removeTrackSource = (trackId: number, url: string): Promise<void> =>
  dispatch('RemoveTrackSource', { track_id: trackId, url });

export const editTrackSource = (trackId: number, oldUrl: string, newUrl: string): Promise<void> =>
  dispatch('EditTrackSource', { track_id: trackId, old_url: oldUrl, new_url: newUrl });

export const getSourcesForTrack = (trackId: number): Promise<TrackSource[]> =>
  dispatch('GetSourcesForTrack', { track_id: trackId });


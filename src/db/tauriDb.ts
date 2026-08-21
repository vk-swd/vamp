import { dispatch } from './dispatchClient';
import type {
  BigintId,
  CriteriaName, SearchCriteriaFiltered, TagAssignment,
  NewTrack, TrackUpdate, SearchCriteria, SearchParam,
} from './generatedTypes';
export type {
  BigintId,
  CriteriaName, SearchCriteriaFiltered, TagAssignment,
  NewTrack, TrackUpdate, SearchCriteria, SearchParam,
} from './generatedTypes';
// ─── Types mirroring src-tauri/src/db/schema.rs ─────────────────────────────

export type TrackRow = {
  id: BigintId;
  artist: string;
  track_name: string;
  length_seconds: number | null;
  bitrate_kbps: number | null;
  tempo_bpm: number | null;
  addition_time: string;
  listened_seconds: number;
};

export type Tag = {
  id: BigintId;
  tag_name: string;
};

export type ListenInfo = {
  id: BigintId;
  track_id: BigintId;
  listened_from: number;
  listened_to: number;
};

export type TrackSource = {
  id: BigintId;
  track_id: BigintId;
  url: string;
};

/** A TrackRow with all its source URLs bundled in — mirrors schema::TrackWithSources. */
export type TrackWithSources = TrackRow & { sources: TrackSource[] };


// ─── Tauri command wrappers ──────────────────────────────────────────────────
// All operations are routed through dispatchClient (invoke or WebSocket mode).
// Tracks
export const addTrack = (track: NewTrack): Promise<BigintId> =>
  dispatch('AddTrack', track);

export const addTracks = (tracks: NewTrack[]): Promise<BigintId[]> =>
  dispatch('AddTracks', tracks);

export const updateTrack = (id: BigintId, update: TrackUpdate): Promise<void> =>
  dispatch('UpdateTrack', { id, update });

export const getTracks = (
  cursor: BigintId | null,
  criteria: SearchCriteria[] | null,
  limit: number,
): Promise<TrackRow[]> =>
  dispatch('GetTracks', { cursor, criteria, limit });

export const getTracksWithSources = (
  cursor: BigintId | null,
  criteria: SearchCriteria[] | null,
  limit: number,
): Promise<TrackWithSources[]> =>
  dispatch('GetTracksWithSources', { cursor, criteria, limit });

export const getTrack = (id: BigintId): Promise<TrackRow> =>
  dispatch('GetTrack', { id });

export const getTracksFiltered = (
  cursor: BigintId | null,
  criteria: SearchCriteriaFiltered[] | null,
  limit: number,
): Promise<TrackRow[]> =>
  dispatch('GetTracksFiltered', { cursor, criteria, limit });

export const deleteTrack = (id: BigintId): Promise<void> =>
  dispatch('DeleteTrack', { id });

// Listen history
export const addListen = (trackId: BigintId, from: string, to: string): Promise<BigintId> =>
  dispatch('AddListen', { track_id: trackId, from, to });

export const getListensForTrack = (trackId: BigintId): Promise<ListenInfo[]> =>
  dispatch('GetListensForTrack', { track_id: trackId });

export const addListenedSeconds = (trackId: BigintId, seconds: number): Promise<void> =>
  dispatch('AddListenedSeconds', { track_id: trackId, seconds });

// Tags
export const addTag = (name: string): Promise<BigintId> =>
  dispatch('AddTag', { name });

export const editTag = (id: BigintId, name: string): Promise<void> =>
  dispatch('EditTag', { id, name });

export const deleteTag = (id: BigintId): Promise<void> =>
  dispatch('DeleteTag', { id });

export const getAllTags = (): Promise<Tag[]> =>
  dispatch('GetAllTags');

export const getTagsByPattern = (pattern: string): Promise<Tag[]> =>
  dispatch('GetTags', { pattern });

export const assignTag = (trackId: BigintId, tagId: BigintId): Promise<void> =>
  dispatch('AssignTag', { track_id: trackId, tag_id: tagId });

export const assignTags = async (assignments: TagAssignment[]): Promise<void> => 
  dispatch('AssignTags', assignments);

export const removeTagFromTrack = (trackId: BigintId, tagId: BigintId): Promise<void> =>
  dispatch('RemoveTag', { track_id: trackId, tag_id: tagId });

export const getTagsForTrack = (trackId: BigintId): Promise<Tag[]> =>
  dispatch('GetTagsForTrack', { track_id: trackId });

// Track metadata
export const addMeta = (trackId: BigintId, key: string, value: string): Promise<BigintId> =>
  dispatch('AddMeta', { track_id: trackId, key, value });

export const updateMeta = (id: BigintId, value: string): Promise<void> =>
  dispatch('UpdateMeta', { id, value });

export const deleteMeta = (id: BigintId): Promise<void> =>
  dispatch('DeleteMeta', { id });

// Track sources
export const addTrackSource = (trackId: BigintId, url: string): Promise<BigintId> =>
  dispatch('AddTrackSource', { track_id: trackId, url });

export const removeTrackSource = (trackId: BigintId, url: string): Promise<void> =>
  dispatch('RemoveTrackSource', { track_id: trackId, url });

export const editTrackSource = (trackId: BigintId, oldUrl: string, newUrl: string): Promise<void> =>
  dispatch('EditTrackSource', { track_id: trackId, old_url: oldUrl, new_url: newUrl });

export const getSourcesForTrack = (trackId: BigintId): Promise<TrackSource[]> =>
  dispatch('GetSourcesForTrack', { track_id: trackId });


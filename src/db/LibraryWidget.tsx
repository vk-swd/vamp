import { createContext, useEffect, useState } from 'react';
import { SearchWidget } from "./filter/SearchWidget";
import { TrackList } from './data/TrackList';
import { Button } from '../ui/elements';
import { TrackInfoDialog, type TrackData } from './track/TrackInfo';
import { addTrack, getTracksWithSources, getAllTags, getTagsByPattern, type Tag } from './tauriDb';
import { DeleteTrackContext } from '../ui/deleteContext';
import type { TrackWithSources } from './data/TrackItem';
import { log } from '../logger';
import { usePlayerStore } from '../store';

const HALF_PAGE_SIZE = 10;
const PAGE_SIZE = 20;
const PAGE_STEP = 10;

class TagLookupContextValue {
  async getAllTags(): Promise<Tag[]> {
    return getAllTags();
  }
  async getTags(pattern: string): Promise<Tag[]> {
    return getTagsByPattern(pattern);
  }
}
const tagGetter = new TagLookupContextValue()
export const TagLookupContext = createContext(tagGetter);


  

class DataLookupContextValue {

}
const dataGetter = new DataLookupContextValue()
export const DataLookupContext = createContext(dataGetter);


export interface LibraryWidgetProps {
  cursor: number | null;
  onCursorChange: (cursor: number | null) => void;
  onDeleteTrack: (id: number) => Promise<void>;
}

export function LibraryWidget({ cursor, onCursorChange, onDeleteTrack }: LibraryWidgetProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const [tracks,      setTracks]      = useState<TrackWithSources[]>([]);
  // TODO: make a variable holding current items request so that if i get some response for old unprocessed requests
  // those are safely ignored and i only deal with current requests. Make this thing generalised.
  const selectedTracks = usePlayerStore((s) => s.selectedTracks);
  const setSelectedTracks = usePlayerStore((s) => s.setSelectedTracks);
  const playlists = usePlayerStore((s) => s.playlists);
  const addTrackToPlaylist = usePlayerStore((s) => s.addTrackToPlaylist);
  const createPlaylist = usePlayerStore((s) => s.createPlaylist);
  function loadPage(fromCursor: number | null) {
    const limit = fromCursor === null ? PAGE_SIZE : HALF_PAGE_SIZE;
    getTracksWithSources(fromCursor, null, limit)
      .then((withSources: TrackWithSources[]) => {
        const pos = Math.max(0, Math.min(withSources.length - 1, HALF_PAGE_SIZE));
        onCursorChange(withSources[pos]?.id ?? null);
        setTracks(withSources);
      })
      .catch(e => log(`Failed to load tracks: ${e}`));
  }

  // Load first page on mount.
  useEffect(() => { loadPage(cursor); }, []);

  function paginate(idx: number) {
    if (tracks.length === 0) {
      loadPage(null);
    } else {
      const a = HALF_PAGE_SIZE + HALF_PAGE_SIZE / 2;
      const b = Math.max(0, Math.min(idx, tracks.length - 1));
      loadPage(tracks[b].id);
    }
  }

  function handlePageNext() {
    paginate(HALF_PAGE_SIZE + HALF_PAGE_SIZE / 2);
  }
  function handlePagePrev() {
    paginate(HALF_PAGE_SIZE / 2);
  }

  const deleteCtx = {
    onDelete: (id: number) => onDeleteTrack(id).then(() => loadPage(cursor)),
  };

  return (
    <DeleteTrackContext.Provider value={deleteCtx}>
    <DataLookupContext.Provider value={dataGetter}>
    <TagLookupContext.Provider value={tagGetter}>
      <div className="filter-widget">
        <SearchWidget />
        <TrackList
          tracks={tracks}
          selectionMode={true}
          selectedIds={selectedTracks.map(t => t.id)}
          onSelectionToggle={(id, selected) => {
            if (selected) {
              const track = tracks.find(t => t.id === id);
              if (track && !selectedTracks.some(t => t.id === id)) {
                setSelectedTracks([...selectedTracks, track]);
              }
            } else {
              setSelectedTracks(selectedTracks.filter(t => t.id !== id));
            }
          }}
          onPagePrev={handlePagePrev}
          onPageNext={handlePageNext}
          hasPrev={true}
          hasNext={true}
          playlists={playlists}
          onAddToPlaylist={(track, playlistId) => addTrackToPlaylist(playlistId, track)}
          onCreatePlaylistWithTrack={(track, name) => {
            const id = createPlaylist(name);
            addTrackToPlaylist(id, track);
          }}
          onInfo={(track) => { /* TODO: show track information panel */ }}
        />
        <Button onClick={() => setDialogOpen(true)}>Add Track</Button>
        <Button variant="secondary" onClick={() => loadPage(cursor)}>↻ Refresh</Button>
      </div>
      {dialogOpen && (
        <TrackInfoDialog
          mode="add"
          onAdd={(data: TrackData) =>
            addTrack({
              artist:         data.artist,
              track_name:     data.track_name,
              length_seconds: data.length_seconds,
              bitrate_kbps:   data.bitrate_kbps ?? null,
              tempo_bpm:      data.tempo_bpm    ?? null,
              addition_time:  new Date().toISOString(),
              sources:        data.sources,
              listened_seconds: 0,
            }).then(id => {
              log(`Track added with id ${id}`);
              // Reload the same page so the new track appears.
              loadPage(cursor);
              setDialogOpen(false);
            })
          }
          onClose={() => setDialogOpen(false)}
        />
      )}
    </TagLookupContext.Provider>
    </DataLookupContext.Provider>
    </DeleteTrackContext.Provider>
  );
}

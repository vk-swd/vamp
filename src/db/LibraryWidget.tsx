import { createContext, useEffect, useState } from 'react';
import { SearchWidget } from "./filter/SearchWidget";
import { invoke } from '@tauri-apps/api/core';
import { TrackList } from './data/TrackList';
import { Button } from '../ui/elements';
import { TrackInfoDialog, type TrackData } from './track/TrackInfo';
import { addTrack, getTracksWithSources } from './tauriDb';
import type { TrackWithSources } from './data/TrackItem';
import { log } from '../logger';
import { usePlayerStore } from '../store';

const PAGE_SIZE = 20;

class TagLookupContextValue {
  async getAllTags(): Promise<string[]> {
    return invoke("get_all_tags")
  }
  async getTags(pattern: string): Promise<string[]> {
    return invoke("get_tags", {pattern});
  }
}
const tagGetter = new TagLookupContextValue()
export const TagLookupContext = createContext(tagGetter);


  

class DataLookupContextValue {

}
const dataGetter = new DataLookupContextValue()
export const DataLookupContext = createContext(dataGetter);


export function LibraryWidget() {
  const [dialogOpen, setDialogOpen] = useState(false);

  const [tracks,      setTracks]      = useState<TrackWithSources[]>([]);
  const [cursor,      setCursor]      = useState<number | null>(null);
  const [prevCursors, setPrevCursors] = useState<(number | null)[]>([]);
  const [hasNext,     setHasNext]     = useState(false);

  const selectedTracks = usePlayerStore((s) => s.selectedTracks);
  const setSelectedTracks = usePlayerStore((s) => s.setSelectedTracks);
  const playlists = usePlayerStore((s) => s.playlists);
  const addTrackToPlaylist = usePlayerStore((s) => s.addTrackToPlaylist);
  const createPlaylist = usePlayerStore((s) => s.createPlaylist);

  function loadPage(fromCursor: number | null) {
    getTracksWithSources(fromCursor, null, PAGE_SIZE)
      .then((withSources: TrackWithSources[]) => {
        setTracks(withSources);
        setHasNext(withSources.length === PAGE_SIZE);
      })
      .catch(e => log(`Failed to load tracks: ${e}`));
  }

  // Load first page on mount.
  useEffect(() => { loadPage(null); }, []);

  function handlePageNext() {
    if (!hasNext || tracks.length === 0) return;
    const nextCursor = tracks[tracks.length - 1].id;
    setPrevCursors(prev => [...prev, cursor]);
    setCursor(nextCursor);
    loadPage(nextCursor);
  }

  function handlePagePrev() {
    if (prevCursors.length === 0) return;
    const prevCursor = prevCursors[prevCursors.length - 1];
    setPrevCursors(prev => prev.slice(0, -1));
    setCursor(prevCursor);
    loadPage(prevCursor);
  }

  return (
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
          hasPrev={prevCursors.length > 0}
          hasNext={hasNext}
          playlists={playlists}
          onAddToPlaylist={(track, playlistId) => addTrackToPlaylist(playlistId, track)}
          onCreatePlaylistWithTrack={(track, name) => {
            const id = createPlaylist(name);
            addTrackToPlaylist(id, track);
          }}
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
  );
}

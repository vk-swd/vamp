import { createContext, useState } from 'react';
import { SearchWidget } from "./filter/SearchWidget";
import { invoke } from '@tauri-apps/api/core';
import { TrackList } from './data/TrackList';
import { Button } from '../ui/elements';
import { TrackInfoDialog, type TrackData } from './track/TrackInfo';
import { addTrack } from './tauriDb';
import { log } from '../logger';

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

  return (
    <DataLookupContext.Provider value={dataGetter}>
    <TagLookupContext.Provider value={tagGetter}>
      <div className="filter-widget">
        <SearchWidget />
        <TrackList tracks={[]}></TrackList>
        <Button onClick={() => setDialogOpen(true)}>Add Track</Button>
      </div>
      {dialogOpen && (
        <TrackInfoDialog
          mode="add"
          onAdd={async (data: TrackData) => {
            const id = await addTrack({
              artist:         data.artist,
              track_name:     data.track_name,
              length_seconds: data.length_seconds,
              bitrate_kbps:   data.bitrate_kbps ?? null,
              tempo_bpm:      data.tempo_bpm    ?? null,
              addition_time:  new Date().toISOString(),
              sources:        data.sources,
            });
            log(`Track added with id ${id}`);
            setDialogOpen(false);
          }}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </TagLookupContext.Provider>
    </DataLookupContext.Provider>
  );
}

import { createContext, useState } from 'react';
import { SearchWidget } from "./filter/SearchWidget";
import { invoke } from '@tauri-apps/api/core';
import { TrackList } from './data/TrackList';
import { Button } from '../ui/elements';
import { TrackInfoDialog } from './track/TrackInfo';

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
          onAdd={data => { console.log('add track', data); setDialogOpen(false); }}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </TagLookupContext.Provider>
    </DataLookupContext.Provider>
  );
}

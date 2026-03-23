import { createContext } from 'react';
import { SearchWidget } from "./filter/SearchWidget";
import { invoke } from '@tauri-apps/api/core';
import { TrackList } from './track/TrackList';

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
 
  return (

    <DataLookupContext.Provider value={dataGetter}>
    <TagLookupContext.Provider value={tagGetter}>
      <div className="filter-widget">
        <SearchWidget />
        <TrackList tracks={[]}></TrackList>
      </div>
    </TagLookupContext.Provider>
    </DataLookupContext.Provider>
  );
}

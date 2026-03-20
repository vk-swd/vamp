import { createContext, useContext, useState } from 'react';
import { SearchWidget } from "./filter/SearchWidget";
import { log } from '../logger';
import { invoke } from '@tauri-apps/api/core';

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
      </div>
    </TagLookupContext.Provider>
    </DataLookupContext.Provider>
  );
}

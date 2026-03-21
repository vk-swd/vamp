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


type NumericComparison = {
  mode: 'numeric_comparison';
  field: string;
  operator: '<' | '>' | '=' | '<=' | '>=' | '!=';
  value: number;
};

type NumericBetween = {
  mode: 'numeric_between';
  field: string;
  min: number;
  max: number;  // inclusive on both ends
};

// --- Text searches ---

type TextLike = {
  mode: 'text_like';
  field: string;
  pattern: string;       // e.g. "%rock%", "The%", "%band"
  caseSensitive: boolean;
};

type TextIn = {
  mode: 'text_in';
  field: string;
  values: string[];
};

// --- Null search ---

type NullCheck = {
  mode: 'null_check';
  field: string;
  isNull: boolean;  // true = IS NULL, false = IS NOT NULL
};

// --- Union ---

type SearchParam =
  | NumericComparison
  | NumericBetween
  | TextLike
  | TextIn
  | NullCheck;

type SearchCriteria = {
  columnName: string;
  criteria: SearchParam[];
};
  
type DataLookupParameters = {

  // define parameters for data lookup here
}
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

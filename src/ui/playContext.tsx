import React from 'react';
import type { TrackWithSources } from '../db/data/TrackItem';

export type OnPlayFn = (track: TrackWithSources, sourceUrl: string) => void;

export const TrackPlayContext = React.createContext<OnPlayFn>(() => {});

export function TrackPlayProvider({ onPlay, children }: { onPlay: OnPlayFn; children: React.ReactNode }) {
  return <TrackPlayContext.Provider value={onPlay}>{children}</TrackPlayContext.Provider>;
}

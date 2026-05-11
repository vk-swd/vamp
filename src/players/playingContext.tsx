import React from "react";




type PlayTrackFns = { 
    setIsPlaying: (isPlaying: boolean) => void;
    // setCurrentTrackId: (id: number | null) => void;
}


export const TrackPlayContext1 = React.createContext<PlayTrackFns | null>(null);

export function TrackPlayProvider({ onPlay, children }: { onPlay: PlayTrackFns; children: React.ReactNode }) {
  return <TrackPlayContext1.Provider value={onPlay}>{children}</TrackPlayContext1.Provider>;
}

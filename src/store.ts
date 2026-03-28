import { create } from "zustand";
import type { TrackWithSources } from "./db/tauriDb";

interface PlayerStore {
  /** The live YT.Player instance, or null when nothing is playing. */
  ytPlayer: YT.Player | null;
  setYtPlayer: (player: YT.Player | null) => void;
  /** Set this to a source URL to request playback from anywhere in the app. */
  nowPlayingUrl: string | null;
  setNowPlayingUrl: (url: string | null) => void;
  /** Database track ID of the currently playing track, or null. */
  nowPlayingDbId: number | null;
  setNowPlayingDbId: (id: number | null) => void;
  /** Tracks currently selected in the library — forms the active playlist. */
  selectedTracks: TrackWithSources[];
  setSelectedTracks: (tracks: TrackWithSources[]) => void;
  /** When true, the current video replays instead of advancing to next track. */
  loopEnabled: boolean;
  setLoopEnabled: (enabled: boolean) => void;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  ytPlayer: null,
  setYtPlayer: (player) => set({ ytPlayer: player }),
  nowPlayingUrl: null,
  setNowPlayingUrl: (url) => set({ nowPlayingUrl: url }),
  nowPlayingDbId: null,
  setNowPlayingDbId: (id) => set({ nowPlayingDbId: id }),
  selectedTracks: [],
  setSelectedTracks: (tracks) => set({ selectedTracks: tracks }),
  loopEnabled: false,
  setLoopEnabled: (enabled) => set({ loopEnabled: enabled }),
}));

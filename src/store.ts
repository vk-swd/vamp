import { create } from "zustand";
import type { TrackWithSources } from "./db/tauriDb";

// ── Active-player strategy ────────────────────────────────────────────────────

/** Control functions provided by whichever player is currently active. */
export interface ActivePlayerControls {
  play: () => void;
  pause: () => void;
  /** Stop playback and reset position to the beginning. */
  stop: () => void;
  /** Seek to the beginning and start playing. */
  replay: () => void;
  /** Seek to an absolute position (seconds). */
  seekTo: (seconds: number) => void;
  /** Return the current playback position in seconds (synchronous). */
  getCurrentTime: () => number;
  /** Return the total duration in seconds (synchronous). */
  getDuration: () => number;
  /** Return the current volume 0-100 (synchronous). */
  getVolume: () => number;
  /** Set the volume 0-100. */
  setVolume: (volume: number) => void;
}

const NOOP_CONTROLS: ActivePlayerControls = {
  play: () => {},
  pause: () => {},
  stop: () => {},
  replay: () => {},
  seekTo: () => {},
  getCurrentTime: () => 0,
  getDuration: () => 0,
  getVolume: () => 100,
  setVolume: () => {},
};

// ── Store interface ───────────────────────────────────────────────────────────

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

  // ── Strategy: active player controls ──────────────────────────────────────
  /** Play the active player. No-op when no player is loaded. */
  play: () => void;
  /** Pause the active player. No-op when no player is loaded. */
  pause: () => void;
  /** Stop the active player and reset to start. No-op when no player is loaded. */
  stop: () => void;
  /** Restart the active player from the beginning. No-op when no player is loaded. */
  replay: () => void;
  /** Seek the active player to the given position in seconds. No-op when no player is loaded. */
  seekTo: (seconds: number) => void;
  /** Return the current playback position in seconds. Returns 0 when no player is loaded. */
  getCurrentTime: () => number;
  /** Return the total duration in seconds. Returns 0 when no player is loaded. */
  getDuration: () => number;
  /** Return the current volume 0-100. Returns 100 when no player is loaded. */
  getVolume: () => number;
  /** Set the volume 0-100. No-op when no player is loaded. */
  setVolume: (volume: number) => void;
  /** True while a player has registered itself as active. */
  playerActive: boolean;
  /**
   * Called by the active player when the user seeks inside the player widget.
   * Register a listener via `setOnSeekTo` to react (e.g. sync a progress bar).
   * Reset to no-op whenever a player loads or unloads.
   */
  onSeekTo: (seconds: number) => void;
  /** Register the active player's control functions. Called by player components on mount/ready. */
  setActivePlayer: (controls: ActivePlayerControls) => void;
  /** Reset all player controls to no-ops. Called by player components on unmount. */
  clearActivePlayer: () => void;
  /** Subscribe to seek-from-player events (e.g. to update a progress bar). */
  setOnSeekTo: (fn: (seconds: number) => void) => void;
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

  // Strategy defaults — all no-ops until a player registers itself.
  ...NOOP_CONTROLS,
  playerActive: false,
  onSeekTo: () => {},
  setActivePlayer: (controls) => set({ ...controls, playerActive: true, onSeekTo: () => {} }),
  clearActivePlayer: () => set({ ...NOOP_CONTROLS, playerActive: false, onSeekTo: () => {} }),
  setOnSeekTo: (fn) => set({ onSeekTo: fn }),
}));

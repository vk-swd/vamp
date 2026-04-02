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
  /** Enable or disable looping of the current track. Optional; may not be supported by all players. */
  setLoop: (enabled: boolean) => void;
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
  setLoop: () => {},
};

// ── Store interface ───────────────────────────────────────────────────────────

interface PlayerStore {
  /** The live YT.Player instance, or null when nothing is playing. */
  ytPlayer: YT.Player | null;
  setYtPlayer: (player: YT.Player | null) => void;
  /**
   * Track requested for playback. Assign via setTrackToPlay — assCounter
   * is bumped on every call so the same track can be re-triggered.
   */
  trackToPlay: { track: TrackWithSources; sourceUrl: string; assCounter: number } | null;
  setTrackToPlay: (track: TrackWithSources, sourceUrl: string) => void;
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
  /** Enable or disable looping of the current track. No-op when no player is loaded. */
  setLoop: (enabled: boolean) => void;
  /** True while a player has registered itself as active. */
  playerActive: boolean;
  /**
   * Called by the active player when the user seeks inside the player widget.
   * Register a listener via `setOnSeekTo` to react (e.g. sync a progress bar).
   * Reset to no-op whenever a player loads or unloads.
   */
  onSeekTo: (seconds: number) => void;
  /** True while a track is actively playing (not paused or stopped). */
  isPlaying: boolean;
  /** Directly update the isPlaying flag. Called by player components on playback state change. */
  setIsPlaying: (playing: boolean) => void;
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
  trackToPlay: null,
  setTrackToPlay: (track, sourceUrl) => set(state => ({
    trackToPlay: {
      track,
      sourceUrl,
      assCounter: (state.trackToPlay?.assCounter ?? 0) + 1,
    },
  })),
  selectedTracks: [],
  setSelectedTracks: (tracks) => set({ selectedTracks: tracks }),
  loopEnabled: false,
  setLoopEnabled: (enabled) => set({ loopEnabled: enabled }),

  // Strategy defaults — all no-ops until a player registers itself.
  ...NOOP_CONTROLS,
  playerActive: false,
  isPlaying: false,
  onSeekTo: () => {},
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setActivePlayer: (controls) => set({
    ...controls,
    playerActive: true,
    isPlaying: false,
    onSeekTo: () => {},
  }),
  clearActivePlayer: () => set({ ...NOOP_CONTROLS, playerActive: false, isPlaying: false, onSeekTo: () => {} }),
  setOnSeekTo: (fn) => set({ onSeekTo: fn }),
}));

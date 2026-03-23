import { create } from "zustand";

interface PlayerStore {
  /** The live YT.Player instance, or null when nothing is playing. */
  ytPlayer: YT.Player | null;
  setYtPlayer: (player: YT.Player | null) => void;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  ytPlayer: null,
  setYtPlayer: (player) => set({ ytPlayer: player }),
}));

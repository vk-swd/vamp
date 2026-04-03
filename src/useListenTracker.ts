import { useEffect, useRef } from "react";
import { usePlayerStore } from "./store";

/**
 * Polls playback state every second.  While a track is actively playing,
 * accumulates listened time per track.  Every time the accumulator crosses
 * the 10-second threshold, `onListenedSeconds` is called with the track DB id
 * and 10 seconds credit.
 *
 * Track changes reset the accumulator.  Pausing / stopping preserves it so
 * that resuming the same track continues where it left off.
 *
 * Mount this hook once at the App level — it has no UI.
 */
export function useListenTracker(
  onListenedSeconds: (trackId: number, seconds: number) => void,
) {
  const callbackRef = useRef(onListenedSeconds);
  callbackRef.current = onListenedSeconds;

  const lastTrackIdRef = useRef<number | null>(null);
  const accumulatedRef = useRef<number>(0);

  useEffect(() => {
    const intervalId = setInterval(() => {
      const { isPlaying, trackToPlay } = usePlayerStore.getState();
      if (!isPlaying) return;

      const currentTrackId = trackToPlay?.track.id ?? null;
      if (currentTrackId === null) return;

      if (currentTrackId !== lastTrackIdRef.current) {
        // Track changed while playing — drop any partial time from the old track.
        accumulatedRef.current = 0;
        lastTrackIdRef.current = currentTrackId;
      }

      accumulatedRef.current += 1;

      if (accumulatedRef.current >= 10) {
        accumulatedRef.current -= 10;
        // TODO make an outbox for asunc data commit
        callbackRef.current(currentTrackId, 10);
      }
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);
}

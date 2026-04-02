import { MutableRefObject, useEffect, useRef, useState } from "react";
import { log } from "./logger";
import { usePlayerStore } from "./store";

declare global {
  interface Window {
    YT: typeof YT;
    onYouTubeIframeAPIReady?: () => void;
  }
}


function startWaitForHangup(timerRef: any, setShowReload: any) {
  setShowReload(false);
  if (timerRef.current) {
    clearTimeout(timerRef.current);
  }
  timerRef.current = setTimeout(() => {
    log(`Timer expired, still loading, show button to reload`)
    setShowReload(true);
  }, 1000);
}
function setUpPlayer(
  scriptId: () => string,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  videoId: string,
  onPlayerReady: (player: YT.Player) => void,
  onStateChange: (state: number) => void,
) {
  const currentId = scriptId();
  return new YT.Player(currentId, {
        height: '390',
        width: '640',
        videoId,
        playerVars: {
          'playsinline': 1
        },
        events: {
          'onReady': (e: YT.PlayerEvent) => {
            if (currentId != scriptId()) {
              log(`getting onReady for old player wtf`)
              return;
            }
            if (timerRef.current) {
              clearTimeout(timerRef.current);
              timerRef.current = null;
            }
            e.target.playVideo();
            e.target.getIframe().style.display = "block";
            log(`Player ready ${e.target.getVideoData().title}`)
            onPlayerReady(e.target);
          },
          'onStateChange': (s: any) => {
            log(`Player state changed ${s.data}`)
            onStateChange(s.data);
          },
        }
      })
}
// Three stages:
//  "loading" — no iframe yet, loading started, 1-second timer running
//  "waiting" — timer expired, still loading (do nothing)
//  "ready"   — onReady fired, player active, timer cleared
export interface YoutubePlayerOwnerProps {
  videoId: string;
  /** Called every 20 s while playback is active with how many seconds to credit. */
  onListenedSeconds?: (seconds: number) => void;
  /** Called once the player is ready. Omit for preview-only instances. */
  onPlayerReady?: (player: YT.Player) => void;
  /** Called when the video finishes playing (state ENDED). */
  onEnded?: () => void;
  /**
   * When true, registers this player as the app-wide active player in the
   * Zustand store (play/pause/stop/replay/seekTo). Only set on main-playback
   * instances — NOT on preview players.
   */
  registerAsActivePlayer?: boolean;
}

export function YoutubePlayerOwner({ videoId, onListenedSeconds, onPlayerReady, onEnded, registerAsActivePlayer }: YoutubePlayerOwnerProps) {
  const [mountKey, setMountKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable random prefix unique per component instance — prevents colliding
  // HTML element IDs when multiple YoutubePlayerOwner instances are mounted.
  const instanceIdRef = useRef<string>(Math.random().toString(36).slice(2, 9));
  // Tracks which mountKey was last initialized so StrictMode's extra
  // mount/unmount/remount cycle doesn't fire setup twice for the same key.
  const initForKeyRef = useRef<number>(-1);
  // Local reference to the player — no Zustand dependency here.
  const playerRef = useRef<YT.Player | null>(null);
  // Wall-clock timestamp (ms) when playback last started/resumed. null = not playing.
  const playStartRef = useRef<number | null>(null);
  // Seconds listened that haven't been flushed to the DB yet.
  const accumulatedRef = useRef<number>(0);
  // Interval that fires every 20 s as a safety net while playback is active.
  const listenIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Keep callback accessible inside closures without re-creating them.
  const onListenedSecondsRef = useRef<((s: number) => void) | undefined>(onListenedSeconds);
  onListenedSecondsRef.current = onListenedSeconds;
  const onEndedRef = useRef<(() => void) | undefined>(onEnded);
  onEndedRef.current = onEnded;

  /** Add elapsed time since last start to the accumulator. Resets the clock. */
  function snapshotElapsed() {
    if (playStartRef.current === null) return;
    const elapsed = (Date.now() - playStartRef.current) / 1000;
    playStartRef.current = Date.now(); // reset so the next snapshot doesn't double-count
    accumulatedRef.current += elapsed;
  }

  /** Drain accumulated seconds in 20-second chunks via the callback. */
  function drainAccumulated() {
    while (accumulatedRef.current >= 20) {
      accumulatedRef.current -= 20;
      onListenedSecondsRef.current?.(20);
    }
  }

  function stopListenTimer() {
    if (listenIntervalRef.current !== null) {
      clearInterval(listenIntervalRef.current);
      listenIntervalRef.current = null;
    }
  }

  function startListenTimer() {
    stopListenTimer();
    listenIntervalRef.current = setInterval(() => {
      snapshotElapsed();
      drainAccumulated();
    }, 20_000);
  }

  function handleStateChange(state: number) {
    // YT.PlayerState: PLAYING = 1, PAUSED = 2, ENDED = 0, BUFFERING = 3
    // Buffering (3) occurs during playback — treat as still playing.
    if (registerAsActivePlayer) {
      usePlayerStore.getState().setIsPlaying(state === 1 || state === 3);
    }
    if (state === 1) {
      // Playback started/resumed — start clock and safety-net timer.
      playStartRef.current = Date.now();
      startListenTimer();
    } else {
      // Playback paused/ended/buffering — stop timer, snapshot and drain.
      stopListenTimer();
      snapshotElapsed();
      playStartRef.current = null;
      drainAccumulated();
      if (state === 0) {
        onEndedRef.current?.();
      }
    }
  }

  function handlePlayerReady(player: YT.Player) {
    playerRef.current = player;
    onPlayerReady?.(player);
    if (registerAsActivePlayer) {
        usePlayerStore.getState().setActivePlayer({
          play:           () => player.playVideo(),
          pause:          () => player.pauseVideo(),
          stop:           () => player.stopVideo(),
          replay:         () => { player.seekTo(0, true); player.playVideo(); },
          seekTo:         (s) => player.seekTo(s, true),
          getCurrentTime: () => player.getCurrentTime(),
          getDuration:    () => player.getDuration(),
          getVolume:      () => player.getVolume(),
          setVolume:      (v) => player.setVolume(v),
          setLoop:        (enabled: boolean) => player.setLoop(enabled)
        });
    }
  }

  const [showReload, setShowReload] = useState(false);
  function makeIframeName() {
    return "yt-player-" + instanceIdRef.current + "-" + mountKey;
  }

  useEffect(() => {
    try {
      if (playerRef.current) {
        const currentId = playerRef.current.getVideoData().video_id;
        if (currentId !== videoId) {
          playerRef.current.loadVideoById(videoId);
        }
      }
    } catch (e) {
      log(`videoId effect: player not accessible (stale ref?): ${e}`);
    }
  }, [videoId]);

  useEffect(() => {
    // Guard: only run once per mountKey — prevents StrictMode double-invocation
    // from creating two players. Using the key (not a boolean) means intentional
    // reloads via handleReload (which increments mountKey) still work correctly.
    if (initForKeyRef.current === mountKey) {
      log(`useEffect skipped for mountKey ${mountKey} (already initialized)`);
      return;
    }
    initForKeyRef.current = mountKey;
    log(`useEffect triggered with mountKey ${mountKey}, videoId ${videoId}`)
    if (window.YT?.Player) {
      if (!playerRef.current) {
        setUpPlayer(makeIframeName, timerRef, videoId, handlePlayerReady, handleStateChange);
        startWaitForHangup(timerRef, setShowReload);
        log(`made a player ${makeIframeName()}`)
      } else {
        log("Should be impossible - using effect with player.");
      }
    } else if (window.onYouTubeIframeAPIReady) {
      // Might be still waiting for the script but it hasn't come
      log("Should be impossible - dont have a player but have a callback and somebody reloaded but didnt remove the callback.");
    } else {
      log("Adding a callback.");
      const currentScriptId = makeIframeName();
      window.onYouTubeIframeAPIReady = () => {
        if (makeIframeName() !== currentScriptId) {
          log(`Script id mismatch ${makeIframeName()} vs ${currentScriptId}, probably old script, ignore`)
          return;
        }
        log(`Element is being created`)
        setUpPlayer(makeIframeName, timerRef, videoId, handlePlayerReady, handleStateChange);
        startWaitForHangup(timerRef, setShowReload);
      }
      startWaitForHangup(timerRef, setShowReload);
      const alreadyInserted = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (!alreadyInserted) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(script);
      } else {
        log(`that should not happen - having script but not having a callback`)
      }
    }
    return () => {
      log(`unmounted`)
      stopListenTimer();
      snapshotElapsed();
      playStartRef.current = null;
      drainAccumulated();
      if (registerAsActivePlayer) {
        usePlayerStore.getState().clearActivePlayer();
      }
    }
  }, [mountKey]);
  
  const handleReload = () => {
    log(`Reloading player, unmounting old one if exists ${mountKey}`)
    playerRef.current?.destroy();
    playerRef.current = null;
    if (window.YT?.Player == undefined) {
      window.onYouTubeIframeAPIReady = undefined;
      const alreadyInserted = document.head.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (alreadyInserted) {
        document.head.removeChild(alreadyInserted);
      }
    }
    setMountKey(mountKey + 1);
    log(`Updated mount key to ${mountKey}, should trigger reload`)
  };
  return (
    <div>
      <div id={makeIframeName()} />
      <button onClick={handleReload}  style={{ display: showReload ? "block" : "none" }}>Reload</button>
    </div>
  );
}

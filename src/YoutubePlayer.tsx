import { MutableRefObject, useEffect, useRef, useState } from "react";
import { log } from "./logger";

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
  /** Called once the player is ready. Omit for preview-only instances. */
  onPlayerReady?: (player: YT.Player) => void;
}

export function YoutubePlayerOwner({ videoId, onPlayerReady }: YoutubePlayerOwnerProps) {
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

  const [showReload, setShowReload] = useState(false);
  function makeIframeName() { 
    return "yt-player-" + instanceIdRef.current + "-" + mountKey; 
  }

  function handlePlayerReady(player: YT.Player) {
    playerRef.current = player;
    onPlayerReady?.(player);
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
        setUpPlayer(makeIframeName, timerRef, videoId, handlePlayerReady);
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
        setUpPlayer(makeIframeName, timerRef, videoId, handlePlayerReady);
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

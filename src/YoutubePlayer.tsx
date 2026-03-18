import { MutableRefObject, useEffect, useRef, useState } from "react";
import { log } from "./logger";
import { loadedPlayerStore, usePlayerStore } from "./store";

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
function setUpPlayer(scriptId: () => string, timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>, videoId: string, setLoadedPlayer: any) {
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
            setLoadedPlayer(e.target);
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
export function YoutubePlayerOwner({ videoId }: { videoId: string }) {
  const [mountKey, setMountKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ytPlayerState = usePlayerStore((state) => state);
  const lPlayerStore = loadedPlayerStore((state) => state);
  
  const [showReload, setShowReload] = useState(false);
  function makeIframeName() { 
    return "yt-player-" + mountKey; 
  }
  useEffect(() => {
    if (ytPlayerState.ytPlayer) {
      const currentId = ytPlayerState.ytPlayer.getVideoData().video_id;
      if (currentId !== videoId) {
        ytPlayerState.ytPlayer.loadVideoById(videoId);
      }
    }
  }, [videoId]);

  useEffect(() => {
    log(`useEffect triggered with mountKey ${mountKey}, videoId ${videoId}`)
    if (window.YT?.Player) {
      if (!ytPlayerState.ytPlayer) {
        ytPlayerState.setYtPlayer(setUpPlayer(makeIframeName, timerRef, videoId, lPlayerStore.setYtPlayer));
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
        ytPlayerState.setYtPlayer(setUpPlayer(makeIframeName, timerRef, videoId, lPlayerStore.setYtPlayer));
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
    ytPlayerState.ytPlayer?.destroy();
    ytPlayerState.setYtPlayer(null);
    lPlayerStore.setYtPlayer(null);
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

import { useEffect, useRef } from "react";

// @types/youtube provides the global YT namespace — only extend Window for the callback.
declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}

// ── Singleton: load the API script once, return a promise that resolves when ready
let apiReady: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {

    console.log("loadYouTubeApi");
  if (apiReady) return apiReady;

  apiReady = new Promise((resolve) => {
    // Already loaded (e.g. hot-reload)
    if (window.YT?.Player) {
      resolve();
      return;
    }

    // Chain onto any previously set callback
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") prev();
      resolve();
    };

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      const first = document.getElementsByTagName("script")[0];
      first.parentNode!.insertBefore(tag, first);
    }
  });

  return apiReady;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface YoutubePlayerProps {
  videoId: string;
}

export function YoutubePlayer({ videoId }: YoutubePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  // Keep a ref so the async API-ready callback always sees the latest videoId
  const videoIdRef = useRef(videoId);
  videoIdRef.current = videoId;

  // Create the player once the API and the DOM node are both ready
  useEffect(() => {
    let destroyed = false;

    loadYouTubeApi().then(() => {
      if (destroyed || !containerRef.current) return;

      playerRef.current = new YT.Player(containerRef.current, {
        videoId: videoIdRef.current,
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
        },
        events: {
          onReady: (e) => e.target.playVideo(),
          onError: (e) => {
            console.error("YouTube Player Error:", e.data);
            // Optionally, you could set some error state here to display in the UI
          },
          onStateChange: (e) => {
            // Auto-close the player when the video ends
            console.log("Player state changed:", e.data);
          }
        },
      });
    });

    return () => {
      destroyed = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once – video changes handled below

  // When videoId changes after the player is already created, cue the new video
  useEffect(() => {
    playerRef.current?.loadVideoById(videoId);
  }, [videoId]);

  return <div ref={containerRef} className="yt-api-player" />;
}

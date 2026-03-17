import { useEffect, useRef, useState } from "react";
import { loadYouTubeApi } from "./youtubeApi";
import { usePlayerStore } from "./store";

// ── Loading widget (YOW) ──────────────────────────────────────────────────────

interface LoadingWidgetProps {
  failed: boolean;
  attempt: number;
}

function YoutubePlayerLoadingWidget({ failed, attempt }: LoadingWidgetProps) {
  return (
    <div className="yt-loading-widget">
      <div className="yt-loading-spinner" />
      <p className="yt-loading-msg">
        {failed
          ? `YouTube API unavailable – retrying… (attempt ${attempt})`
          : "Loading YouTube player…"}
      </p>
    </div>
  );
}

// ── Core player (YT) ─────────────────────────────────────────────────────────
// Only rendered by YoutubePlayerOwner once the IFrame API is confirmed ready.

function YoutubePlayerCore({ videoId }: { videoId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const videoIdRef = useRef(videoId);
  videoIdRef.current = videoId;

  const setYtPlayer = usePlayerStore((s) => s.setYtPlayer);

  // Create the YT.Player exactly once — API is guaranteed ready at this point.
  useEffect(() => {
    if (!containerRef.current) return;

    playerRef.current = new YT.Player(containerRef.current, {
      videoId: videoIdRef.current,
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: (e) => {
          e.target.playVideo();
          setYtPlayer(e.target as YT.Player);
        },
        onError: (e) => console.error("YouTube Player Error:", e.data),
        onStateChange: (e) => console.log("Player state changed:", e.data),
      },
    });

    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
      setYtPlayer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once per mount lifetime

  // When videoId changes, cue the new video without remounting the IFrame.
  useEffect(() => {
    playerRef.current?.loadVideoById(videoId);
  }, [videoId]);

  return <div ref={containerRef} className="yt-api-player" />;
}

// ── Owner (YO) ────────────────────────────────────────────────────────────────
// Manages API loading. Shows the loading widget while waiting or retrying,
// then swaps in YoutubePlayerCore once the API is ready.
// Retries every second on failure, stopping cleanly when unmounted.

type ApiState = "loading" | "ready" | "failed";

export function YoutubePlayerOwner({ videoId }: { videoId: string }) {
  const [apiState, setApiState] = useState<ApiState>("loading");
  const [attempt, setAttempt] = useState(1);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    function tryLoad() {
      if (cancelled) return;
      setApiState("loading");
      loadYouTubeApi()
        .then(() => {
          if (!cancelled) setApiState("ready");
        })
        .catch(() => {
          if (!cancelled) {
            setApiState("failed");
            setAttempt((n) => n + 1);
            retryTimer = setTimeout(tryLoad, 1000);
          }
        });
    }

    tryLoad();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, []); // run once per mount lifetime

  if (apiState === "ready") return <YoutubePlayerCore videoId={videoId} />;
  return <YoutubePlayerLoadingWidget failed={apiState === "failed"} attempt={attempt} />;
}

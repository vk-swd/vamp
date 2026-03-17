import { useEffect } from "react";
import YouTube, { YouTubeEvent, YouTubeProps } from "react-youtube";
import { usePlayerStore } from "./store";
import { log } from "./logger";

export function YoutubePlayerOwner({ videoId }: { videoId: string }) {
  const setYtPlayer = usePlayerStore((s) => s.setYtPlayer);

  useEffect(() => {
    return () => setYtPlayer(null);
  }, []);
  log(`Loading YouTube video: ${videoId}`);
  const opts: YouTubeProps["opts"] = {
    playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1 },
  };

  const onReady: YouTubeProps["onReady"] = (e) => {
    log("YouTube player ready");
    e.target.playVideo();
    setYtPlayer(e.target as YT.Player);
  };

  return (
    <YouTube
      videoId={videoId}
      opts={opts}
      onReady={onReady}
      onError={(e: YouTubeEvent<number>) => log(`YouTube Player Error: ${e.data}`)}
      onStateChange={(e: YouTubeEvent<number>) => log(`Player state changed: ${e.data}`)}
      className="yt-api-player"
    />
  );
}

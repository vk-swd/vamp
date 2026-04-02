import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "./store";
import { log } from "./logger";
import { Button, WrappingLabel } from "./ui/elements";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function PlayerControls({trackLabel, duration}: {trackLabel: string; duration: number}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(100);
  const isDraggingRef = useRef(false);

  const playerActive = usePlayerStore((s) => s.playerActive);
  const isPlaying    = usePlayerStore((s) => s.isPlaying);
  const play         = usePlayerStore((s) => s.play);
  const pause        = usePlayerStore((s) => s.pause);
  const stop         = usePlayerStore((s) => s.stop);
  const seekTo       = usePlayerStore((s) => s.seekTo);
  const getCurrentTime = usePlayerStore((s) => s.getCurrentTime);
  const getVolume      = usePlayerStore((s) => s.getVolume);
  const storeSetVolume = usePlayerStore((s) => s.setVolume);
  const setLoop        = usePlayerStore((s) => s.setLoop);
  const loopEnabled    = usePlayerStore((s) => s.loopEnabled);
  const setLoopEnabled = usePlayerStore((s) => s.setLoopEnabled);
  

  // When a player becomes active: sync initial volume and start polling time/duration.
  useEffect(() => {
    log(`Player active: ${playerActive}`);
    if (!playerActive) {
      setCurrentTime(0);
      return;
    }

    setVolume(getVolume());

    const id = setInterval(() => {
      if (!isDraggingRef.current) {
        setCurrentTime(getCurrentTime());
      }
    }, 250);
    return () => clearInterval(id);
  }, [playerActive]);

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentTime(parseFloat(e.target.value));
  };

  const commitSeek = (e: React.SyntheticEvent<HTMLInputElement>) => {
    isDraggingRef.current = false;
    seekTo(parseFloat((e.target as HTMLInputElement).value));
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    setVolume(v);
    storeSetVolume(v);
  };

  const volumeIcon = volume === 0 ? "🔇" : volume < 50 ? "🔉" : "🔊";

  return (
    <div className="player-controls">
      {/* Play / Stop row */}
      <div className="ctrl-row ctrl-buttons">
        <Button
          disabled={!playerActive}
          onClick={isPlaying ? pause : play}
        >
          {isPlaying ? "⏸" : "▶"}
        </Button>
        <Button
          disabled={!playerActive}
          onClick={stop}
        >
          ■
        </Button>
        <Button
          title="Loop current track instead of advancing to next"
          onClick={() => { setLoop(!loopEnabled); setLoopEnabled(!loopEnabled)}}
        >⟳</Button>
        {trackLabel && (
          <WrappingLabel
            text={trackLabel}
            style={{ flex: 1, paddingTop: 6 }}
          />
        )}
         {/* Volume row */}
        <div className="ctrl-row">
          <span className="ctrl-label">{volumeIcon}</span>
          <input
            type="range"
            className="ctrl-slider"
            min={0}
            max={100}
            step={1}
            value={volume}
            disabled={!playerActive}
            onChange={handleVolumeChange}
          />
          <span className="ctrl-time">{volume}%</span>
        </div>
      </div>

      {/* Seek row */}
      <div className="ctrl-row">
        <span className="ctrl-time">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="ctrl-slider"
          min={0}
          max={duration > 0 ? duration : 0}
          step={0.5}
          value={currentTime}
          disabled={!playerActive || duration === 0}
          onMouseDown={() => { isDraggingRef.current = true; }}
          onTouchStart={() => { isDraggingRef.current = true; }}
          onChange={handleSeekChange}
          onMouseUp={commitSeek}
          onTouchEnd={commitSeek}
        />
        <span className="ctrl-time">{formatTime(duration)}</span>
      </div>
    </div>
  );
}

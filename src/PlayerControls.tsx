import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "./store";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function PlayerControls() {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(100);
  const isDraggingRef = useRef(false);

  const playerActive = usePlayerStore((s) => s.playerActive);
  const play         = usePlayerStore((s) => s.play);
  const stop         = usePlayerStore((s) => s.stop);
  const seekTo       = usePlayerStore((s) => s.seekTo);
  const getCurrentTime = usePlayerStore((s) => s.getCurrentTime);
  const getDuration    = usePlayerStore((s) => s.getDuration);
  const getVolume      = usePlayerStore((s) => s.getVolume);
  const storeSetVolume = usePlayerStore((s) => s.setVolume);
  const loopEnabled    = usePlayerStore((s) => s.loopEnabled);
  const setLoopEnabled = usePlayerStore((s) => s.setLoopEnabled);

  // When a player becomes active: sync initial volume and start polling time/duration.
  useEffect(() => {
    if (!playerActive) {
      setCurrentTime(0);
      setDuration(0);
      return;
    }

    setVolume(getVolume());

    const id = setInterval(() => {
      if (!isDraggingRef.current) {
        setCurrentTime(getCurrentTime());
      }
      setDuration(getDuration());
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
        <button
          className="btn btn-primary ctrl-btn"
          disabled={!playerActive}
          onClick={play}
        >
          ▶ Play
        </button>
        <button
          className="btn btn-secondary ctrl-btn"
          disabled={!playerActive}
          onClick={stop}
        >
          ■ Stop
        </button>
        <button
          className={`btn ctrl-btn${loopEnabled ? " btn-primary" : " btn-secondary"}`}
          title="Loop current track instead of advancing to next"
          onClick={() => setLoopEnabled(!loopEnabled)}
        >
          ⟳ Loop
        </button>
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
  );
}

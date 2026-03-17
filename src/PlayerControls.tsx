import { useEffect, useRef, useState } from "react";

interface PlayerControlsProps {
  player: YT.Player | null;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function PlayerControls({ player }: PlayerControlsProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(100);
  const isDraggingRef = useRef(false);

  // Sync initial volume and poll time/duration while player is available
  useEffect(() => {
    if (!player) {
      setCurrentTime(0);
      setDuration(0);
      return;
    }

    setVolume(player.getVolume());

    const id = setInterval(() => {
      if (!isDraggingRef.current) {
        setCurrentTime(player.getCurrentTime() ?? 0);
      }
      setDuration(player.getDuration() ?? 0);
    }, 250);

    return () => clearInterval(id);
  }, [player]);

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentTime(parseFloat(e.target.value));
  };

  const commitSeek = (e: React.SyntheticEvent<HTMLInputElement>) => {
    isDraggingRef.current = false;
    player?.seekTo(parseFloat((e.target as HTMLInputElement).value), true);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    setVolume(v);
    player?.setVolume(v);
  };

  const volumeIcon = volume === 0 ? "🔇" : volume < 50 ? "🔉" : "🔊";

  return (
    <div className="player-controls">
      {/* Play / Stop row */}
      <div className="ctrl-row ctrl-buttons">
        <button
          className="btn btn-primary ctrl-btn"
          disabled={!player}
          onClick={() => player?.playVideo()}
        >
          ▶ Play
        </button>
        <button
          className="btn btn-secondary ctrl-btn"
          disabled={!player}
          onClick={() => player?.stopVideo()}
        >
          ■ Stop
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
          disabled={!player || duration === 0}
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
          disabled={!player}
          onChange={handleVolumeChange}
        />
        <span className="ctrl-time">{volume}%</span>
      </div>
    </div>
  );
}

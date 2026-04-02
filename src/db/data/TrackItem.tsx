import React from 'react';
import { TrackRow, TrackSource, TrackWithSources } from "../tauriDb";
import { usePlayerStore } from '../../store';

export type { TrackWithSources };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '--:--:--';
  const totalSec = Math.max(0, Math.floor(seconds));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}


// ─── TrackItem ────────────────────────────────────────────────────────────────

export interface TrackItemProps {
  track: TrackWithSources;
  selectionMode: boolean;
  selected: boolean;
  activeSource: string | null;
  onSelect: (id: number, checked: boolean) => void;
  onContextMenu: (e: React.MouseEvent, trackId: number) => void;
  onSourceChange: (trackId: number, url: string | null) => void;
}


export function TrackItem({
  track,
  selectionMode,
  selected,
  activeSource,
  onSelect,
  onContextMenu,
  onSourceChange,
}: TrackItemProps) {
  const setTrackToPlay = usePlayerStore((s) => s.setTrackToPlay);

  return (
    <div
      className={`tracklist-item${selected ? ' tracklist-item--selected' : ''}`}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, track.id); }}
    >
      <div className={`tracklist-item__checkbox${selectionMode ? ' tracklist-item__checkbox--visible' : ''}`}>
        <input
          type="checkbox"
          checked={selected}
          onChange={e => onSelect(track.id, e.target.checked)}
          tabIndex={selectionMode ? 0 : -1}
        />
      </div>

      <div className="tracklist-item__info">
        <span className="tracklist-item__artist">{track.artist}</span>
        <span className="tracklist-item__name">{track.track_name}</span>
      </div>

      <span className="tracklist-item__duration">
        {formatDuration(track.length_seconds)}
      </span>

      <div className="tracklist-item__source">
        <select
          className="tracklist-src-select"
          value={activeSource ?? ''}
          disabled={track.sources.length === 0}
          onChange={e => onSourceChange(track.id, e.target.value || null)}
        >
          {track.sources.length === 0 && (
            <option value="">No sources</option>
          )}
          {track.sources.map(s => (
            <option key={s.url} value={s.url}>{s.url}</option>
          ))}
        </select>
      </div>

      <button
        className="tracklist-item__play-btn"
        disabled={!activeSource}
        title={activeSource ? `Play: ${activeSource}` : 'No source available'}
        onClick={() => { if (activeSource) { setTrackToPlay(track, activeSource); } }}
      >
        ▶
      </button>
    </div>
  );
}
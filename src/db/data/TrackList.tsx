import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { TrackRow } from '../tauriDb';
import './TrackList.css';
import { TrackItem, type TrackWithSources } from './TrackItem';
import { usePlayerStore } from '../../store';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrackListProps {
  tracks: TrackWithSources[];
  selectionMode?: boolean;
  /** External selected IDs — the list renders these as selected. */
  selectedIds?: number[];
  /** Fired when a single track is toggled; parent decides how to store/remove. */
  onSelectionToggle?: (id: number, selected: boolean) => void;
  onPagePrev?: () => void;
  onPageNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}


// ─── Placeholder play action ──────────────────────────────────────────────────

export function playTrack(_track: TrackRow, _sourceUrl: string | null): void {
  // TODO: implement playback
}

// ─── Context menu state ───────────────────────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  trackId: number;
}


// ─── TrackList ────────────────────────────────────────────────────────────────

export function TrackList({
  tracks,
  selectionMode = false,
  selectedIds = [],
  onSelectionToggle,
  onPagePrev,
  onPageNext,
  hasPrev = false,
  hasNext = false,
}: TrackListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeSources, setActiveSources] = useState<Record<number, string | null>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const setTrackToPlay = usePlayerStore((s) => s.setTrackToPlay);

  const selectedSet = new Set(selectedIds);

  // Close context menu on any outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close, { once: true });
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, trackId: number) => {
    setContextMenu({ x: e.clientX, y: e.clientY, trackId });
  }, []);

  const handleSourceChange = useCallback((trackId: number, url: string | null) => {
    setActiveSources(prev => ({ ...prev, [trackId]: url }));
  }, []);

  const scroll = (dir: 'up' | 'down') => {
    scrollRef.current?.scrollBy({ top: dir === 'up' ? -240 : 240, behavior: 'smooth' });
  };
  const handleUp   = onPagePrev ?? (() => scroll('up'));
  const handleDown = onPageNext ?? (() => scroll('down'));

  const contextTrack = contextMenu
    ? tracks.find(t => t.id === contextMenu.trackId) ?? null
    : null;

  return (
    <div className="tracklist">
      <button
        className="tracklist__nav-btn tracklist__nav-btn--top"
        onClick={handleUp}
        disabled={onPagePrev !== undefined && !hasPrev}
        aria-label="Previous page"
      >▲</button>

      <div className="tracklist__scroll" ref={scrollRef}>
        {tracks.map(track => (
          <TrackItem
            key={track.id}
            track={track}
            selectionMode={selectionMode}
            selected={selectedSet.has(track.id)}
            activeSource={activeSources[track.id] ?? track.sources[0]?.url ?? null}
            onSelect={onSelectionToggle ?? (() => {})}
            onContextMenu={handleContextMenu}
            onSourceChange={handleSourceChange}
          />
        ))}
      </div>

      <button
        className="tracklist__nav-btn tracklist__nav-btn--bottom"
        onClick={handleDown}
        disabled={onPageNext !== undefined && !hasNext}
        aria-label="Next page"
      >▼</button>

      {contextMenu && contextTrack && (
        <ul
          className="tracklist__context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <li
            className="tracklist__context-menu-item"
            onClick={() => {
              onSelectionToggle?.(contextTrack.id, !selectedSet.has(contextTrack.id));
              setContextMenu(null);
            }}

          >
            Select
          </li>
          <li
            className="tracklist__context-menu-item"
            onClick={() => {
              const src = activeSources[contextTrack.id] ?? contextTrack.sources[0]?.url ?? null;
              if (src) { setTrackToPlay(contextTrack, src); }
              setContextMenu(null);
            }}
          >
            Play
          </li>
          <li
            className="tracklist__context-menu-item"
            onClick={() => {
              // TODO: show track information panel
              setContextMenu(null);
            }}
          >
            Information
          </li>
        </ul>
      )}
    </div>
  );
}

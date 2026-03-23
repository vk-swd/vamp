import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { TrackRow } from '../tauriDb';
import './TrackList.css';
import { TrackItem, type TrackWithSources, TrackListProps } from './TrackItem';

// ─── Types ────────────────────────────────────────────────────────────────────


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
  onSelectionChange,
  onPagePrev,
  onPageNext,
  hasPrev = false,
  hasNext = false,
}: TrackListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [activeSources, setActiveSources] = useState<Record<number, string | null>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Close context menu on any outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close, { once: true });
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleSelect = useCallback((id: number, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      onSelectionChange?.([...next]);
      return next;
    });
  }, [onSelectionChange]);

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
            selected={selectedIds.has(track.id)}
            activeSource={activeSources[track.id] ?? track.sources[0]?.url ?? null}
            onSelect={handleSelect}
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
              handleSelect(contextTrack.id, !selectedIds.has(contextTrack.id));
              setContextMenu(null);
            }}
          >
            Select
          </li>
          <li
            className="tracklist__context-menu-item"
            onClick={() => {
              const src = activeSources[contextTrack.id] ?? contextTrack.sources[0]?.url ?? null;
              playTrack(contextTrack, src);
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

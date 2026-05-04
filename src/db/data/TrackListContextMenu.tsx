import React from 'react';
import type { TrackWithSources } from './TrackItem';

export interface TrackListContextMenuProps {
  x: number;
  y: number;
  track: TrackWithSources;
  isSelected: boolean;
  activeSource: string | null;
  playlists: Array<{ id: string; name: string }>;
  onSelect:        () => void;
  onPlay:          () => void;
  onAddToPlaylist: (playlistId: string) => void;
  onNewPlaylist:   () => void;
  onInfo:          () => void;
  onClose:         () => void;
}

export function TrackListContextMenu({
  x, y, isSelected, playlists,
  onSelect, onPlay, onAddToPlaylist, onNewPlaylist, onInfo, onClose,
}: TrackListContextMenuProps) {
  return (
    <ul
      className="tracklist__context-menu"
      style={{ top: y, left: x }}
      onClick={e => e.stopPropagation()}
    >
      <li
        className="tracklist__context-menu-item"
        onClick={() => { onSelect(); onClose(); }}
      >
        {isSelected ? 'Deselect' : 'Select'}
      </li>
      <li
        className="tracklist__context-menu-item"
        onClick={() => { onPlay(); onClose(); }}
      >
        Play
      </li>
      <li className="tracklist__context-menu-item tracklist__context-menu-item--has-sub">
        Add to Playlist
        <ul className="tracklist__context-submenu" onClick={e => e.stopPropagation()}>
          {playlists.map(pl => (
            <li
              key={pl.id}
              className="tracklist__context-menu-item"
              onClick={() => { onAddToPlaylist(pl.id); onClose(); }}
            >
              {pl.name}
            </li>
          ))}
          <li
            className="tracklist__context-menu-item"
            onClick={() => { onClose(); onNewPlaylist(); }}
          >
            + New Playlist…
          </li>
        </ul>
      </li>
      <li
        className="tracklist__context-menu-item"
        onClick={() => { onInfo(); onClose(); }}
      >
        Information
      </li>
    </ul>
  );
}

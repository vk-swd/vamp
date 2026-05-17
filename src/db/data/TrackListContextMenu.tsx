import React from 'react';
import type { TrackWithSources } from './TrackItem';
import { DeleteTrackContext } from '../../ui/deleteContext';
import { TrackPlayContext } from '../../ui/playContext';

export interface TrackListContextMenuProps {
  x: number;
  y: number;
  track: TrackWithSources;
  isSelected: boolean;
  activeSource: string | null;
  playlists: Array<{ id: string; name: string }>;
  onSelect:        () => void;
  onAddToPlaylist: (playlistId: string) => void;
  onNewPlaylist:   () => void;
  onInfo:          () => void;
  onClose:         () => void;
}

export function TrackListContextMenu({
  x, y, track, isSelected, activeSource, playlists,
  onSelect, onAddToPlaylist, onNewPlaylist, onInfo, onClose,
}: TrackListContextMenuProps) {
  const { onDelete } = React.useContext(DeleteTrackContext);
  const onPlay = React.useContext(TrackPlayContext);
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
        onClick={() => { if (activeSource) { onPlay(track, activeSource); } onClose(); }}
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
      <li
        className="tracklist__context-menu-item"
        onClick={() => { onDelete(track.id); onClose(); }}
      >
        Delete
      </li>
    </ul>
  );
}

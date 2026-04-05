import { usePlayerStore } from '../store';
import { PlaylistView } from './PlaylistView';
import './playlist.css';

export function PlaylistsTab() {
  const playlists = usePlayerStore((s) => s.playlists);
  const removeTrackFromPlaylist = usePlayerStore((s) => s.removeTrackFromPlaylist);
  const reorderPlaylistTrack = usePlayerStore((s) => s.reorderPlaylistTrack);
  const deletePlaylist = usePlayerStore((s) => s.deletePlaylist);
  const activePlaylistId = usePlayerStore((s) => s.activePlaylistId);
  const setActivePlaylistId = usePlayerStore((s) => s.setActivePlaylistId);

  const activePlaylist = playlists.find(pl => pl.id === activePlaylistId) ?? playlists[0];

  function handleDelete(id: string) {
    if (activePlaylistId === id) {
      const idx = playlists.findIndex(pl => pl.id === id);
      const next = playlists[idx + 1] ?? playlists[idx - 1];
      setActivePlaylistId(next?.id ?? '');
    }
    deletePlaylist(id);
  }

  return (
    <div className="playlists-tab">
      <div className="playlists-tab__tabs">
        {playlists.map(pl => (
          <div
            key={pl.id}
            className={`playlists-tab__tab${activePlaylistId === pl.id ? ' playlists-tab__tab--active' : ''}`}
            onClick={() => setActivePlaylistId(pl.id)}
          >
            <span className="playlists-tab__tab-name">{pl.name}</span>
            <button
              className="playlists-tab__tab-close"
              onClick={e => { e.stopPropagation(); handleDelete(pl.id); }}
              aria-label={`Delete playlist ${pl.name}`}
            >✕</button>
          </div>
        ))}
      </div>

      {activePlaylist && (
        <PlaylistView
          tracks={activePlaylist.tracks}
          onReorder={(from, to) => reorderPlaylistTrack(activePlaylist.id, from, to)}
          onRemove={(trackId) => removeTrackFromPlaylist(activePlaylist.id, trackId)}
        />
      )}
    </div>
  );
}

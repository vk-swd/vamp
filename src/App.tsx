import { useState, useRef, useEffect, type FormEvent } from "react";
// import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { YoutubePlayerOwner } from "./YoutubePlayer";
import { PlayerControls } from "./PlayerControls";
import { usePlayerStore } from "./store";
import "./App.css";
import { addListenedSeconds } from "./db/tauriDb";
import { log } from "./logger";
import { useListenTracker } from "./useListenTracker";
import { LibraryWidget } from "./db/LibraryWidget";
import { SCPlayer } from "./players/SCPlayer";
import { getTrackSource } from "./common/utils";
import { PlaylistsTab } from "./playlist/PlaylistsTab";

// ── helpers ───────────────────────────────────────────────────────────────────

// ── types ─────────────────────────────────────────────────────────────────────

// type TabId = "library" | "now-playing" | "playlist" | "database" | "browserleaks";
type TabId = "library" | "now-playing" | "playlist" | "database";
type SourceType = "youtube" | "soundcloud" | "localfile";

interface Track {
  id: string;
  sourceType: SourceType;
  dbTrackId?: number;
}

// ── placeholder sub-components ────────────────────────────────────────────────

function LocalFileInfo() {
  return <div className="placeholder-panel">Local file info coming soon</div>;
}

// ── Now Playing tab content ───────────────────────────────────────────────────

interface NowPlayingTabProps {
  track: Track;
}

function NowPlayingTab({ track }: NowPlayingTabProps) {
  const [mountKey] = useState(0);
  const setYtPlayer = usePlayerStore((s) => s.setYtPlayer);
  const loopEnabled = usePlayerStore((s) => s.loopEnabled);
  const selectedTracks = usePlayerStore((s) => s.selectedTracks);
  const playlists = usePlayerStore((s) => s.playlists);
  const activePlaylistId = usePlayerStore((s) => s.activePlaylistId);
  const setTrackToPlay = usePlayerStore((s) => s.setTrackToPlay);

  // Clear the global player reference when this tab unmounts.
  useEffect(() => () => { setYtPlayer(null); }, []);

  const [scKey, setScKey] = useState(0);
  const [scAutoPlay, setScAutoPlay] = useState(true);

  // When a completely new track arrives, restore autoplay for it.
  useEffect(() => {
    setScAutoPlay(true);
  }, [track.id]);

  function handleEnded() {
    log(`${loopEnabled} ${selectedTracks.length} ${track.dbTrackId}`);
    if (loopEnabled) return;
    // Reload the SC widget without autoplaying first, then advance track.
    setScAutoPlay(false);
    setScKey((prev) => prev + 1);

    // Try the active playlist first, fall back to selectedTracks.
    const activePlaylist = playlists.find(pl => pl.id === activePlaylistId);
    const queue = (activePlaylist && activePlaylist.tracks.length > 0)
      ? activePlaylist.tracks
      : selectedTracks;

    if (queue.length === 0) return;
    const currentIndex = queue.findIndex(t => t.id === track.dbTrackId);
    const nextIndex = (currentIndex === -1 ? 0 : currentIndex + 1) % queue.length;
    const nextTrack = queue[nextIndex];
    const url = nextTrack.sources[0]?.url ?? null;
    if (url) {
      setTrackToPlay(nextTrack, url);
    }
  }
  
  return (
    <div className="now-playing-tab">
      <div className="player-container">
        {track.sourceType === "youtube" && (
          <YoutubePlayerOwner
            key={mountKey}
            videoId={track.id}
            registerAsActivePlayer
            onPlayerReady={setYtPlayer}
            onEnded={handleEnded}
          />
        )}
        {/* <button onClick={updated}>hello</button> */}
        {track.sourceType === "soundcloud" && <SCPlayer key={scKey} url={track.id} autoPlay={scAutoPlay} registerAsActivePlayer onFinish={handleEnded} />}
        {track.sourceType === "localfile" && <LocalFileInfo />}
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("library");
  const [track, setTrack] = useState<Track | null>(null);
  const [input, setInput] = useState("");
  const [scError, setScError] = useState<string | null>(null);
  const [scLibraryUrl, setScLibraryUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trackToPlay = usePlayerStore((s) => s.trackToPlay);

  useListenTracker((trackId, seconds) => {
    addListenedSeconds(trackId, seconds).catch((e) => log(`addListenedSeconds: ${e}`));
  });

  // ── load video ──
  const loadVideo = (raw: string, dbTrackId?: number) => {
    const source = getTrackSource(raw.trim());
    log(`Detected source type: ${source?.type} id: ${source?.id} from input: ${raw}`);
    if (source?.type === 'youtube') {
      setTrack({ id: source.id, sourceType: "youtube", dbTrackId });
    } else if (source?.type === 'soundcloud') {
      setTrack({ id: source.id, sourceType: "soundcloud", dbTrackId });
    } else {
      setTrack(null);
    }
  };

  // React to play requests coming from the library/tracklist.
  useEffect(() => {
    if (!trackToPlay) return;
    loadVideo(trackToPlay.sourceUrl, trackToPlay.track.id);
  }, [trackToPlay]);

  const tabs: { id: TabId; label: string; disabled?: boolean }[] = [
    { id: "library",      label: "Library" },
    { id: "now-playing",  label: "Now Playing", disabled: !track },
    { id: "playlist",     label: "Playlist" },
    { id: "database",     label: "Database" },
    // { id: "browserleaks", label: "BrowserLeaks" },
  ];
  const getDuration    = usePlayerStore((s) => s.getDuration);
  return (
    <div className="app">
      {/* ── Tab bar ── */}
      <nav className="tab-bar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={[
              "tab-btn",
              activeTab === t.id ? "tab-btn--active" : "",
              t.disabled        ? "tab-btn--disabled" : "",
            ].filter(Boolean).join(" ")}
            disabled={t.disabled}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ── Tab content ── */}
      <main className="tab-content">
        {/*
          Now Playing — kept mounted whenever a track is active so the player
          stays alive while the user browses other tabs. Hidden via CSS only.
        */}
        {track && (
          <div className={activeTab !== "now-playing" ? "tab-panel--hidden" : ""}>
            <NowPlayingTab track={track} />
          </div>
        )}

        {/* Playlist */}
        {activeTab === "playlist" && <PlaylistsTab />}

        {/* Database */}
        {activeTab === "database" && (
          <div>
            <LibraryWidget/>
          </div>
        )}

        {/* BrowserLeaks
        {activeTab === "browserleaks" && (
          <div className="placeholder-panel">
            BrowserLeaks opened in a separate window.
          </div>
        )} */}

      </main>

      {/* ── Persistent bottom bar ── */}
      <footer className="bottom-bar">
        <PlayerControls trackLabel={`${trackToPlay?.track.artist} - ${trackToPlay?.track.track_name}`} duration={getDuration()} />
      </footer>
    </div>
  );
}

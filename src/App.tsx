import { useState, useRef, useEffect, type FormEvent } from "react";
import { YoutubePlayerOwner } from "./YoutubePlayer";
import { PlayerControls } from "./PlayerControls";
import { usePlayerStore } from "./store";
import "./App.css";
import { addListenedSeconds } from "./db/tauriDb";
import { log } from "./logger";
import { LibraryWidget } from "./db/LibraryWidget";
import { SCPlayer } from "./players/SCPlayer";

// ── helpers ───────────────────────────────────────────────────────────────────

function extractVideoId(raw: string): string | null {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (m) return m[1];
  }
  return null;
}

/** Returns the URL if it looks like a valid SoundCloud track/playlist link, otherwise null. */
function extractSoundCloudUrl(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "soundcloud.com" && parsed.pathname.length > 1) {
      return trimmed;
    }
  } catch {
    // not a valid URL
  }
  return null;
}

// ── types ─────────────────────────────────────────────────────────────────────

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
  const setNowPlayingUrl = usePlayerStore((s) => s.setNowPlayingUrl);
  const setNowPlayingDbId = usePlayerStore((s) => s.setNowPlayingDbId);

  // Clear the global player reference when this tab unmounts.
  useEffect(() => () => { setYtPlayer(null); }, []);

  function handleEnded() {
    log(`${loopEnabled} ${selectedTracks.length} ${track.dbTrackId}`);
    if (loopEnabled) return;
    if (selectedTracks.length === 0) return;
    const currentIndex = selectedTracks.findIndex(t => t.id === track.dbTrackId);
    const nextIndex = (currentIndex === -1 ? 0 : currentIndex + 1) % selectedTracks.length;
    const nextTrack = selectedTracks[nextIndex];
    const url = nextTrack.sources[0]?.url ?? null;
    if (url) {
      setNowPlayingDbId(nextTrack.id);
      setNowPlayingUrl(url);
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
            onListenedSeconds={track.dbTrackId != null
              ? (s) => addListenedSeconds(track.dbTrackId!, s).catch((e) => log(`addListenedSeconds: ${e}`))
              : undefined}
            onPlayerReady={setYtPlayer}
            onEnded={handleEnded}
          />
        )}
        {/* <button onClick={updated}>hello</button> */}
        {track.sourceType === "soundcloud" && <SCPlayer url={track.id} autoPlay registerAsActivePlayer />}
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

  const ytPlayer = usePlayerStore((s) => s.ytPlayer);
  const nowPlayingUrl = usePlayerStore((s) => s.nowPlayingUrl);
  const setNowPlayingUrl = usePlayerStore((s) => s.setNowPlayingUrl);
  const nowPlayingDbId = usePlayerStore((s) => s.nowPlayingDbId);
  const setNowPlayingDbId = usePlayerStore((s) => s.setNowPlayingDbId);

  // ── load video ──
  const loadVideo = (raw: string, dbTrackId?: number) => {
    const id = extractVideoId(raw.trim());
    if (id) {
      setTrack({ id, sourceType: "youtube", dbTrackId });
      setActiveTab("now-playing");
    } else {
      setTrack(null);
    }
  };

  // ── load SoundCloud track into the library embed ──
  const handleScSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = extractSoundCloudUrl(input);
    if (url) {
      setScLibraryUrl(url);
      setScError(null);
    } else {
      setScError("⚠️  Please enter a valid SoundCloud track URL (e.g. https://soundcloud.com/artist/track).");
      setScLibraryUrl(null);
    }
  };

  // React to play requests coming from the library/tracklist.
  useEffect(() => {
    if (!nowPlayingUrl) return;
    loadVideo(nowPlayingUrl, nowPlayingDbId ?? undefined);
    setNowPlayingUrl(null);
    setNowPlayingDbId(null);
  }, [nowPlayingUrl]);

  const tabs: { id: TabId; label: string; disabled?: boolean }[] = [
    { id: "library",     label: "Library" },
    { id: "now-playing", label: "Now Playing", disabled: !track },
    { id: "playlist",    label: "Playlist" },
    { id: "database",    label: "Database" },
  ];

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <div className="header-brand">
          <svg className="brand-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
          </svg>
          <span className="brand-text">Vamp</span>
        </div>
      </header>

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

        {/* Library */}
        {activeTab === "library" && (
          <div className="library-tab">
            <section className="search-section">
              <form onSubmit={handleScSubmit} className="search-form">
                <input
                  ref={inputRef}
                  type="text"
                  className={`search-input${scError ? " search-input--error" : ""}`}
                  placeholder="Paste a SoundCloud track URL…"
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    if (scError) setScError(null);
                  }}
                />
                <button type="submit" className="btn btn-primary">
                  ▶ Load
                </button>
              </form>
              {scError && <p className="error-msg">{scError}</p>}
            </section>

            {scLibraryUrl ? (
              <section className="sc-embed-section">
                <SCPlayer url={scLibraryUrl} registerAsActivePlayer />
              </section>
            ) : (
              <section className="featured-section">
                <p className="hint">
                  Paste a SoundCloud track URL above to embed the player here.
                </p>
              </section>
            )}
          </div>
        )}

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
        {activeTab === "playlist" && (
          <div className="placeholder-panel">Playlist coming soon</div>
        )}

        {/* Database */}
        {activeTab === "database" && (
          <div>
            <LibraryWidget/>
          </div>
        )}

      </main>

      {/* ── Persistent bottom bar ── */}
      <footer className="bottom-bar">
        <PlayerControls player={ytPlayer} />
      </footer>
    </div>
  );
}

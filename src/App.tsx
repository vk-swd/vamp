import { useState, useRef, useEffect, type FormEvent } from "react";
import { YoutubePlayerOwner } from "./YoutubePlayer";
import { PlayerControls } from "./PlayerControls";
import { usePlayerStore } from "./store";
import "./App.css";
import { addListenedSeconds } from "./db/tauriDb";
import { log } from "./logger";
import { LibraryWidget } from "./db/LibraryWidget";

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

const FEATURED: { id: string; title: string; thumb: string }[] = [
  {
    id: "R8MWKsheHxk",
    title: "dnb",
    thumb: "https://img.youtube.com/vi/R8MWKsheHxk/mqdefault.jpg",
  }
];

// ── types ─────────────────────────────────────────────────────────────────────

type TabId = "library" | "now-playing" | "playlist" | "database";
type SourceType = "youtube" | "soundcloud" | "localfile";

interface Track {
  id: string;
  sourceType: SourceType;
  dbTrackId?: number;
}

// ── placeholder sub-components ────────────────────────────────────────────────

function SoundCloudPlayer() {
  return <div className="placeholder-panel">SoundCloud player coming soon</div>;
}

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

  // Clear the global player reference when this tab unmounts.
  useEffect(() => () => { setYtPlayer(null); }, []);

  return (
    <div className="now-playing-tab">
      <div className="player-container">
        {track.sourceType === "youtube" && (
          <YoutubePlayerOwner
            key={mountKey}
            videoId={track.id}
            onListenedSeconds={track.dbTrackId != null
              ? (s) => addListenedSeconds(track.dbTrackId!, s).catch((e) => log(`addListenedSeconds: ${e}`))
              : undefined}
            onPlayerReady={setYtPlayer}
          />
        )}
        {/* <button onClick={updated}>hello</button> */}
        {track.sourceType === "soundcloud" && <SoundCloudPlayer />}
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
  const [error, setError] = useState<string | null>(null);
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
      setError(null);
      setActiveTab("now-playing");
    } else {
      setError("⚠️  Could not find a valid YouTube video ID.");
      setTrack(null);
    }
  };

  // React to play requests coming from the library/tracklist.
  useEffect(() => {
    if (!nowPlayingUrl) return;
    loadVideo(nowPlayingUrl, nowPlayingDbId ?? undefined);
    setNowPlayingUrl(null);
    setNowPlayingDbId(null);
  }, [nowPlayingUrl]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    loadVideo(input);
  };

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
          <span className="brand-text">VampAgent</span>
        </div>
        <span className="brand-sub">YouTube Viewer</span>
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
              <form onSubmit={handleSubmit} className="search-form">
                <input
                  ref={inputRef}
                  type="text"
                  className={`search-input${error ? " search-input--error" : ""}`}
                  placeholder="Paste a YouTube URL or video ID…"
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    if (error) setError(null);
                  }}
                />
                <button type="submit" className="btn btn-primary">
                  ▶ Play
                </button>
              </form>
              {error && <p className="error-msg">{error}</p>}
            </section>

            <section className="featured-section">
              <h2 className="featured-heading">Featured Videos</h2>
              <div className="featured-grid">
                {FEATURED.map((v) => (
                  <button
                    key={v.id}
                    className="thumb-card"
                    onClick={() => {
                      setInput(v.id);
                      loadVideo(v.id);
                    }}
                  >
                    <img src={v.thumb} alt={v.title} className="thumb-img" />
                    <p className="thumb-title">{v.title}</p>
                  </button>
                ))}
              </div>
              <p className="hint">
                Paste any YouTube URL or video ID in the bar above, or pick a
                featured video.
              </p>
            </section>
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

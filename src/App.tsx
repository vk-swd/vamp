import { useState, useRef, type FormEvent } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { YoutubePlayer } from "./YoutubePlayer";
import "./App.css";

// ── helpers ──────────────────────────────────────────────────────────────────

function extractVideoId(raw: string): string | null {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,          // ?v=ID  or  &v=ID
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,      // youtu.be/ID
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/, // embed/ID
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/, // shorts/ID
    /^([a-zA-Z0-9_-]{11})$/,               // bare 11-char ID
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (m) return m[1];
  }
  return null;
}

const FEATURED: { id: string; title: string; thumb: string }[] = [
  {
    id: "dQw4w9WgXcQ",
    title: "Never Gonna Give You Up",
    thumb: "https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
  },
  {
    id: "9bZkp7q19f0",
    title: "Gangnam Style",
    thumb: "https://img.youtube.com/vi/9bZkp7q19f0/mqdefault.jpg",
  },
  {
    id: "JGwWNGJdvx8",
    title: "Shape of You",
    thumb: "https://img.youtube.com/vi/JGwWNGJdvx8/mqdefault.jpg",
  },
  {
    id: "kJQP7kiw5Fk",
    title: "Despacito",
    thumb: "https://img.youtube.com/vi/kJQP7kiw5Fk/mqdefault.jpg",
  },
];

// ── component ────────────────────────────────────────────────────────────────

export default function App() {
  const [input, setInput] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webviewError, setWebviewError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── open in dedicated webview window ──
  const openWebviewWindow = async (id: string) => {
    setWebviewError(null);
    try {
      const label = `yt-${id}`;
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return;
      }
      const win = new WebviewWindow(label, {
        url: `https://www.youtube.com/watch?v=${id}`,
        title: "YouTube – VampAgent",
        width: 1280,
        height: 760,
        center: true,
        resizable: true,
        decorations: true,
      });
      win.once("tauri://error", (e: unknown) => {
        setWebviewError(`Webview error: ${JSON.stringify(e)}`);
      });
    } catch (err) {
      setWebviewError(`Failed to open webview: ${String(err)}`);
    }
  };

  // ── load: extract ID then immediately open native window ──
  const loadVideo = (raw: string) => {
    const id = extractVideoId(raw.trim());
    if (id) {
      setVideoId(id);
      setError(null);
      setWebviewError(null);
    } else {
      setError("⚠️  Could not find a valid YouTube video ID.");
      setVideoId(null);
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    loadVideo(input);
  };

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

      {/* ── Search bar ── */}
      <section className="search-section">
        <form onSubmit={handleSubmit} className="search-form">
          <input
            ref={inputRef}
            type="text"
            className={`search-input ${error ? "search-input--error" : ""}`}
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

      {/* ── Player ── */}
      {videoId && (
        <section className="player-section">
          <div className="player-container">
            <YoutubePlayer videoId={videoId} />
          </div>

          <div className="player-actions">
            <button className="btn btn-secondary" onClick={() => void openWebviewWindow(videoId)}>
              <svg viewBox="0 0 24 24" fill="currentColor" className="btn-icon">
                <path d="M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm-1 14H6V7h12v10z" />
              </svg>
              Open in Webview Window
            </button>
            <a
              href={`https://www.youtube.com/watch?v=${videoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost"
            >
              Open on YouTube ↗
            </a>
          </div>

          {webviewError && <p className="error-msg">{webviewError}</p>}
        </section>
      )}

      {/* ── Featured / Placeholder ── */}
      {!videoId && (
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
      )}
    </div>
  );
}

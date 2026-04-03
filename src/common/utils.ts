// ─── Track source detection ───────────────────────────────────────────────────

export type TrackSourceType = 'youtube' | 'soundcloud' | 'local';

export interface TrackSource {
  type: TrackSourceType;
  /**
   * For 'youtube'    : the 11-character video ID.
   * For 'soundcloud' : the full track URL.
   * For 'local'      : the file path / raw string as-is.
   */
  id: string;
}

/**
 * Inspect a raw source string and return its type + normalised identifier.
 * Returns null only when the input is empty.
 */
export function getTrackSource(raw: string): TrackSource | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // ── YouTube ──
  const ytPatterns: RegExp[] = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of ytPatterns) {
    const m = trimmed.match(p);
    if (m) return { type: 'youtube', id: m[1] };
  }

  // ── SoundCloud ──
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === 'soundcloud.com' && parsed.pathname.length > 1) {
      return { type: 'soundcloud', id: trimmed };
    }
  } catch {
    // not a valid URL — fall through to local
  }

  // ── Local file / unknown ──
  return { type: 'local', id: trimmed };
}

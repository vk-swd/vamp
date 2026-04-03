import { useEffect, useRef } from "react";
import { usePlayerStore } from "../store";
import { log } from "../logger";

// ── SoundCloud Widget API types ───────────────────────────────────────────────

declare global {
  interface Window {
    SC?: {
      Widget: {
        (iframe: HTMLIFrameElement): SCWidget;
        Events: {
          READY: string;
          PLAY: string;
          PAUSE: string;
          FINISH: string;
          SEEK: string;
          PLAY_PROGRESS: string;
          ERROR: string;
        };
      };
    };
  }
}

export interface SCWidget {
  bind: (event: string, listener: (...args: any[]) => void) => void;
  unbind: (event: string) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seekTo: (milliseconds: number) => void;
  getPosition: (callback: (position: number) => void) => void;
  getDuration: (callback: (duration: number) => void) => void;
  setVolume: (volume: number) => void;
  getVolume: (callback: (volume: number) => void) => void;
  isPaused: (callback: (isPaused: boolean) => void) => void;
  getCurrentSound: (callback: (sound: any) => void) => void;
}

// ── constants ─────────────────────────────────────────────────────────────────

const SC_WIDGET_API_URL = "https://w.soundcloud.com/player/api.js";
const SC_EMBED_BASE = "https://w.soundcloud.com/player/";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns a Promise that resolves once the SC Widget API script is loaded. */
function loadScApi(): Promise<void> {
  return new Promise((resolve) => {
    if (window.SC) {
      resolve();
      return;
    }
    const existing = document.getElementById(
      "sc-widget-api",
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = "sc-widget-api";
    script.src = SC_WIDGET_API_URL;
    script.async = true;
    script.onload = () => resolve();
    document.head.appendChild(script);
  });
}

// ── component ─────────────────────────────────────────────────────────────────

export interface SCPlayerProps {
  /** Full SoundCloud track / playlist URL. */
  url: string;
  /** Height of the embedded player in pixels (default: 166). */
  height?: number;
  /** Whether the track should start playing automatically (default: false). */
  autoPlay?: boolean;
  /** Called once the Widget API is ready and the widget can be controlled. */
  onReady?: (widget: SCWidget) => void;
  /** Called when playback finishes. */
  onFinish?: () => void;
  /**
   * When true, registers this player as the app-wide active player in the
   * Zustand store (play/pause/stop/replay/seekTo/onSeekTo). Only set on
   * main-playback instances — NOT on preview players.
   */
  registerAsActivePlayer?: boolean;
}

/**
 * Self-contained SoundCloud embed that loads the official Widget API and
 * wires up event callbacks.  Pass a full SoundCloud track URL as `url`.
 */
export function SCPlayer({
  url,
  height = 166,
  autoPlay = false,
  onReady,
  onFinish,
  registerAsActivePlayer,
}: SCPlayerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const widgetRef = useRef<SCWidget | null>(null);
  // Cached playback position (ms), updated via playProgress for synchronous getCurrentTime.
  const positionMsRef = useRef<number>(0);
  // Cached duration (ms), fetched once on ready.
  const durationMsRef = useRef<number>(0);
  // Cached volume (0-100), mirrors what we set so getVolume() is synchronous.
  const volumeRef = useRef<number>(100);
  // Keep callbacks fresh without re-running the effect.
  const onReadyRef = useRef(onReady);
  const onFinishRef = useRef(onFinish);
  onReadyRef.current = onReady;
  onFinishRef.current = onFinish;

  const embedUrl =
    `${SC_EMBED_BASE}?url=${encodeURIComponent(url)}` +
    `&color=%23ff5500` +
    `&auto_play=${autoPlay ? "true" : "false"}` +
    `&hide_related=false` +
    `&show_comments=true` +
    `&show_user=true` +
    `&show_reposts=false` +
    `&show_teaser=true` +
    `&visual=false`;

  useEffect(() => {
    let cancelled = false;

    loadScApi().then(() => {
      if (cancelled || !iframeRef.current || !window.SC) return;

      const widget = window.SC.Widget(iframeRef.current);
      widgetRef.current = widget;

      widget.bind("ready", () => {
        if (cancelled) return;
        onReadyRef.current?.(widget);

        if (registerAsActivePlayer) {
            log(`Registering SC player as active player in store`);
          usePlayerStore.getState().setActivePlayer({
            play:           () => { 
                log(`playing`);
                widget.play()
            },
            pause:          () => { log(`pausing`); widget.pause(); },
            stop:           () => { 
                log(`stopping`);
                widget.seekTo(0); widget.pause(); },
            replay:         () => { log(`replaying`); widget.seekTo(0); widget.play(); },
            seekTo:         (s) => { log(`seeking to ${s}`); widget.seekTo(s * 1000); },
            getCurrentTime: () => positionMsRef.current / 1000,
            getDuration:    () => durationMsRef.current / 1000,
            getVolume:      () => volumeRef.current,
            setVolume:      (v) => { volumeRef.current = v; widget.setVolume(v); },
            setLoop:        () => {},
          });

          // Cache the track duration once the widget is ready.
          widget.getDuration((ms: number) => { durationMsRef.current = ms; });

          // Mirror YoutubePlayer's isPlaying updates.
          const Events = window.SC!.Widget.Events;
          widget.bind(Events.PLAY,   () => { if (!cancelled) usePlayerStore.getState().setIsPlaying(true);  });
          widget.bind(Events.PAUSE,  () => { if (!cancelled) usePlayerStore.getState().setIsPlaying(false); });
          widget.bind(Events.FINISH, () => { if (!cancelled) usePlayerStore.getState().setIsPlaying(false); });

          // Keep positionMsRef in sync for synchronous getCurrentTime reads.
          widget.bind(Events.PLAY_PROGRESS, (e: { currentPosition: number }) => {
            if (!cancelled) {
              positionMsRef.current = e.currentPosition;
              usePlayerStore.getState().setIsPlaying(true);
            }
          });

          // Forward seek events from the SC widget to the store's onSeekTo slot.
          widget.bind(Events.SEEK, (e: { currentPosition: number }) => {
            if (!cancelled) {
              positionMsRef.current = e.currentPosition;
              usePlayerStore.getState().onSeekTo(e.currentPosition / 1000);
            }
          });
        }
      });

      widget.bind("finish", () => {
        if (cancelled) return;
        onFinishRef.current?.();
      });
    });

    return () => {
      cancelled = true;
      widgetRef.current = null;
      if (registerAsActivePlayer) {
        usePlayerStore.getState().clearActivePlayer();
      }
    };
  }, [url]);

  return (
    <iframe
      ref={iframeRef}
      width="100%"
      height={height}
      scrolling="no"
      frameBorder="0"
      allow="autoplay"
      src={embedUrl}
      title="SoundCloud Player"
      style={{ borderRadius: 4, display: "block" }}
    />
  );
}

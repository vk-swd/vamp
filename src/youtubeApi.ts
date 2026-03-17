// @types/youtube provides the global YT namespace.
declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}

/**
 * Resettable singleton.
 * - null  → not yet attempted, or the last attempt failed (ready to retry)
 * - Promise → a load is in flight or has already resolved successfully
 */
let apiReady: Promise<void> | null = null;

/**
 * Request the YouTube IFrame API.
 *
 * Returns a Promise that:
 *  - resolves once `window.YT.Player` is available
 *  - rejects if the <script> tag fails to load (network error, CSP, etc.)
 *
 * After a rejection `apiReady` is reset to null so the next call starts a
 * fresh attempt — enabling the retry loop in YoutubePlayerOwner.
 */
export function loadYouTubeApi(): Promise<void> {
  if (apiReady) return apiReady;

  apiReady = new Promise<void>((resolve, reject) => {
    // Already available — e.g. after a Vite hot-reload
    if (window.YT?.Player) {
      resolve();
      return;
    }

    // Overwrite (don't chain) the global callback.
    // We also clear it on error so stale closures don't pile up.
    window.onYouTubeIframeAPIReady = () => {
      resolve();
    };

    // Remove any <script> left by a previous failed attempt so the browser
    // doesn't think it is already loading the same URL.
    document
      .querySelectorAll('script[src="https://www.youtube.com/iframe_api"]')
      .forEach((s) => s.remove());

    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => {
      apiReady = null;                          // allow next call to retry
      window.onYouTubeIframeAPIReady = undefined;
      reject(new Error("Failed to load YouTube IFrame API"));
    };
    document.head.appendChild(tag);
  });

  return apiReady;
}

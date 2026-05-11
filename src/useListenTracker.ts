/**
 * Polls playback state every second.  While a track is actively playing,
 * accumulates listened time per track.  Every time the accumulator crosses
 * the 10-second threshold, `onListenedSeconds` is called with the track DB id
 * and 10 seconds credit.
 *
 * Track changes reset the accumulator.  Pausing / stopping preserves it so
 * that resuming the same track continues where it left off.
 *
 * Mount this hook once at the App level — it has no UI.
 */

export class ListenTracker {
  public currentTrackId: number | null = null
  listened: number = 0;
  timer: NodeJS.Timeout | null = null;
  public isPlaying: boolean = false;
  constructor(private callback: (trackId: number, seconds: number) => Promise<void>) {
    this.restratTimer();
  }
  kill() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  checkPlayed(): Promise<void> {
    if (this.isPlaying && this.currentTrackId !== null) {
      this.listened += 1;

      if (this.listened >= 10) {
        this.listened -= 10;
        // TODO make an outbox for async data commit
        return this.callback(this.currentTrackId, 10);
      }
    }
    return Promise.resolve();
  }
  restratTimer(): Promise<void> {
    return this.checkPlayed().then(_ => {
      this.timer = setTimeout(() => this.restratTimer(), 1000);
    })
  }
}
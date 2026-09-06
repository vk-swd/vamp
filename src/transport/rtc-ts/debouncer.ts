import { DEFAULT_ICE_RESTART_TIMEOUT_MS } from './types';

/**
 * Debounces ICE restarts.
 *
 * Mirrors `src-tauri/rtc/debouncer.rs`: `start()` arms a timer, `end()` disarms it,
 * and the timer firing means the connection stayed broken long enough to act on.
 *
 * Each arming carries a generation number. A firing hands its generation back so a
 * late timeout that raced an `end()` can be recognised and ignored by the caller.
 */
export class IceRestartDebouncer {
    #timer: ReturnType<typeof setTimeout> | undefined = undefined;
    #generation = 0;

    constructor(
        private readonly onTimeout: (generation: number) => void,
        private readonly timeoutMs: number = DEFAULT_ICE_RESTART_TIMEOUT_MS,
    ) {}

    get armed(): boolean {
        return this.#timer !== undefined;
    }

    get generation(): number {
        return this.#generation;
    }

    /** Arms the timer. Already-armed keeps the running deadline, as in the Rust version. */
    start(): number {
        if (this.#timer !== undefined) return this.#generation;
        return this.#arm();
    }

    /** Restarts the deadline from zero. Used when negotiation makes progress. */
    refresh(): number {
        this.#clear();
        return this.#arm();
    }

    end(): void {
        this.#clear();
    }

    stop(): void {
        this.#clear();
    }

    #arm(): number {
        this.#generation += 1;
        const generation = this.#generation;
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.onTimeout(generation);
        }, this.timeoutMs);
        return generation;
    }

    #clear(): void {
        if (this.#timer === undefined) return;
        clearTimeout(this.#timer);
        this.#timer = undefined;
    }
}

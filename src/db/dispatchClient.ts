import { invoke } from '@tauri-apps/api/core';

// ─── Mode ─────────────────────────────────────────────────────────────────────

export type DispatchMode = 'invoke' | 'ws';

let mode: DispatchMode = 'invoke';

export function setDispatchMode(m: DispatchMode): void {
  mode = m;
}

export function getDispatchMode(): DispatchMode {
  return mode;
}

// ─── WebSocket client (singleton) ─────────────────────────────────────────────

const WS_URL = 'ws://localhost:8090';

type WsState = 'disconnected' | 'connecting' | 'connected' | 'failed';

class WsDispatchClient {
  private ws: WebSocket | null = null;
  private state: WsState = 'disconnected';
  /** Shared promise while a connection attempt is in progress. */
  private connectingPromise: Promise<void> | null = null;

  private connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    // Reuse an in-flight connection attempt so concurrent callers wait together.
    if (this.connectingPromise) return this.connectingPromise;

    this.state = 'connecting';
    this.connectingPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        this.ws = ws;
        this.state = 'connected';
        this.connectingPromise = null;
        resolve();
      };

      ws.onerror = () => {
        // onclose fires right after onerror; handled there.
        this.state = 'failed';
        this.ws = null;
        this.connectingPromise = null;
        reject(new Error(`WebSocket connection to ${WS_URL} failed`));
      };

      ws.onclose = () => {
        // If we were connected, move back to disconnected so the next send retries.
        if (this.state === 'connected') {
          this.state = 'disconnected';
          this.ws = null;
        }
      };
    });

    return this.connectingPromise;
  }

  /** Connect (if needed) then fire-and-forget the message.
   *  Resolves when the message has been accepted by the send buffer.
   *  Rejects (and sets state to 'failed') when connections cannot be established.
   *  The next call after a failure will retry the connection. */
  async send(kind: string, payload: unknown): Promise<void> {
    // 'failed' and 'disconnected' both require a fresh connection attempt.
    if (this.state !== 'connected') {
      await this.connect();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.state = 'disconnected';
      throw new Error('WebSocket is not open');
    }
    // TODO: monitor buffered amount
    this.ws.send(JSON.stringify({ kind, payload: payload ?? null }));
  }

  getState(): WsState { return this.state; }
}

const wsClient = new WsDispatchClient();

// ─── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Route a command to the backend.
 *
 * In `invoke` mode (default): calls `invoke('dispatch', …)` via Tauri IPC and
 * returns the typed result.
 *
 * In `ws` mode: connects to `ws://localhost:8090` on the first call, then
 * fire-and-forgets the message. The returned promise resolves when the message
 * is handed to the WebSocket send buffer. Return type `T` is nominal only in
 * this mode — no response value is returned.
 *
 * Set the mode with `setDispatchMode('invoke' | 'ws')`.
 */
export function dispatch<T>(kind: string, payload: unknown = null): Promise<T> {
  if (mode === 'ws') {
    return wsClient.send(kind, payload).then(() => undefined as unknown as T);
  }
  return invoke<T>('dispatch', { kind, payload });
}

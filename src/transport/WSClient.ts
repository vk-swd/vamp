
export class WSocket {
  private state: WsState = 'disconnected';
  /** Shared promise while a connection attempt is in progress. */
  private connectingPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
    static open(url: string | URL): Promise<WSocket> {
        const ws = new WebSocket(url);
        return new WSocket(ws);
    }
    constructor(private ws: WebSocket) {
        // ws.readyState
    }
  private rejectAllPending(reason: string): void {
    for (const p of this.pending.values()) {
      p.reject(new Error(reason));
    }
    this.pending.clear();
    
  }

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

      ws.onmessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string) as WsResponse;
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if ('error' in msg) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.ok);
        }
      };

      ws.onerror = (e) => {
        // onclose fires right after onerror; handled there.
        this.state = 'failed';
        this.ws = null;
        this.connectingPromise = null;
        const err = `WebSocket connection to ${WS_URL} failed`;
        this.rejectAllPending(err);
        reject(new Error(err));
      };

      ws.onclose = () => {
        // If we were connected, move back to disconnected so the next send retries.
        if (this.state === 'connected') {
          this.state = 'disconnected';
          this.ws = null;
          this.rejectAllPending('WebSocket closed unexpectedly');
        }
      };
    });

    return this.connectingPromise;
  }

  /** Connect (if needed), send the message, and return a Promise that resolves
   *  with the server's response value. Rejects on connection failure or server error. */
  async send<T>(kind: string, payload: unknown): Promise<T> {
    // 'failed' and 'disconnected' both require a fresh connection attempt.
    if (this.state !== 'connected') {
      await this.connect();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.state = 'disconnected';
      throw new Error('WebSocket is not open');
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ id, kind, payload: payload ?? null }));
    });
  }

  getState(): WsState { return this.state; }
}
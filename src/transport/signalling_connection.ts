type SignalKind = 'offer' | 'answer' | 'ice-candidate';
export type SignalMsg = { type: SignalKind; sdp: string; neg_id: string };
export type TransportMsg<T> =
  | { type: 'normal'; sn: number; node_id: string; payload: T }
  | { type: 'ack'; sn: number; node_id: string };
type WireMsg<T> = {
  tag: string;
  message?: TransportMsg<T>;
  payload?: TransportMsg<T>;
};

type PendingSignal = {
  frame: string;
  resolve: () => void;
  reject: (reason: unknown) => void;
  retryTimer?: ReturnType<typeof setTimeout>;
};

export type SignallingConnectionConfig = {
  signallingUrl: string;
  sessionId: string;
  signallingRetryMs?: number;
};

const DEFAULT_SIGNALLING_RETRY = 1_000;

export function makeNodeId(): string {
  return crypto.randomUUID();
}

function toWire<T>(tag: string, message?: TransportMsg<T>): string {
  // The signalling server routes `payload`, while the Rust RTC transport reads
  // `message`. Sending both keeps the two existing protocol readers compatible.
  return JSON.stringify({ tag, message, payload: message });
}

function fromWire<T>(raw: string): WireMsg<T> {
  const wire = JSON.parse(raw) as WireMsg<T>;
  if (typeof wire.tag !== 'string' || (!wire.message && !wire.payload)) {
    throw new Error('invalid RTC wire message');
  }
  return wire;
}

export class SequenceFilter {
  private nodeId: string | undefined;
  private lastSn = -1;

  accept(nodeId: string, sn: number): boolean {
    if (!this.nodeId) {
      this.nodeId = nodeId;
      this.lastSn = sn;
      return true;
    }
    return this.nodeId === nodeId && sn > this.lastSn && (this.lastSn = sn, true);
  }
}

export class SignallingConnection {
  private socket: WebSocket | undefined;
  private stopped = false;
  private connecting: Promise<void> | undefined;
  private readonly outboundNodeId = makeNodeId();
  private nextSn = 0;
  private readonly pending = new Map<number, PendingSignal>();
  private readonly inboundFilter = new SequenceFilter();
  private readonly retryMs: number;
  private onSignal: ((signal: SignalMsg) => void) | undefined;

  constructor(private readonly config: SignallingConnectionConfig) {
    this.retryMs = config.signallingRetryMs ?? DEFAULT_SIGNALLING_RETRY;
  }

  setSignalHandler(handler: (signal: SignalMsg) => void): void {
    this.onSignal = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.config.signallingUrl);
      let opened = false;
      socket.onopen = () => {
        opened = true;
        this.socket = socket;
        this.connecting = undefined;
        socket.send(JSON.stringify({ tag: this.config.sessionId }));
        this.retryPending();
        resolve();
      };
      socket.onmessage = (event) => this.receive(String(event.data));
      socket.onerror = () => {
        if (!opened) {
          this.connecting = undefined;
          reject(new Error(`Unable to connect to ${this.config.signallingUrl}`));
        }
      };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = undefined;
        if (!this.stopped) this.reconnect();
      };
    });
    return this.connecting;
  }

  private reconnect(): void {
    if (this.stopped || this.connecting) return;
    this.connecting = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.connecting = undefined;
        this.connect().then(resolve).catch(() => resolve());
      }, this.retryMs);
    });
  }

  private receive(raw: string): void {
    let wire: WireMsg<SignalMsg>;
    try {
      wire = fromWire<SignalMsg>(raw);
    } catch {
      return;
    }
    const message = wire.message ?? wire.payload;
    if (!message) return;

    if (message.type === 'ack') {
      const pending = this.pending.get(message.sn);
      if (!pending) return;
      this.pending.delete(message.sn);
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
      pending.resolve();
      return;
    }

    this.sendAck(message.sn, message.node_id);
    if (this.inboundFilter.accept(message.node_id, message.sn)) {
      this.onSignal?.(message.payload);
    }
  }

  private sendAck(sn: number, nodeId: string): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(toWire(this.config.sessionId, { type: 'ack', sn, node_id: nodeId }));
  }

  private retryPending(): void {
    for (const [sn, pending] of this.pending) this.sendPending(sn, pending);
  }

  private sendPending(sn: number, pending: PendingSignal): void {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(pending.frame);
    pending.retryTimer = setTimeout(() => {
      if (this.pending.has(sn)) this.sendPending(sn, pending);
    }, this.retryMs * 6);
  }

  async send(signal: SignalMsg): Promise<void> {
    if (this.stopped) throw new Error('RTC signalling connection is closed');
    await this.connect();
    const sn = this.nextSn++;
    const message: TransportMsg<SignalMsg> = {
      type: 'normal',
      sn,
      node_id: this.outboundNodeId,
      payload: signal,
    };
    const frame = toWire(this.config.sessionId, message);
    await new Promise<void>((resolve, reject) => {
      const pending = { frame, resolve, reject };
      this.pending.set(sn, pending);
      this.sendPending(sn, pending);
    });
  }

  close(): void {
    this.stopped = true;
    if (this.connecting) this.connecting = undefined;
    for (const pending of this.pending.values()) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
      pending.reject(new Error('RTC signalling connection closed'));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = undefined;
  }
}

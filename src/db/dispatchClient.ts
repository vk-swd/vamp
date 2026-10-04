import { callInvoke } from './tauriInvoke';
import { DataTransportMessage, RemoteRequest, RemoteResponse } from '../transport/generatedTypes';
import { DataTransport } from '../transport/rtc-ts/data_transport';
import { Command } from './generatedTypes';
// ─── Mode ─────────────────────────────────────────────────────────────────────
// Set window.__TRANSPORT__ = 'ws' (e.g. in index.html) to route via WebSocket.
// Undefined or any other value falls back to Tauri IPC invoke.

declare global {
  interface Window { __TRANSPORT__?: string; }
}

// ─── WebSocket client (singleton) ─────────────────────────────────────────────

// const WS_URL = 'wss://192.168.0.106:8090';
const WS_URL = 'ws://localhost:8090';

type PendingRequest = {
  // TODO: Define result types.
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  abortCtl: AbortController;
};

interface Connection<TransportedMsg> {
  send(data: TransportedMsg, signal?: AbortSignal): void;
  setMessageHandler(handler: (payload: TransportedMsg) => void): void;
}
type TransportMessage<ResponseType> = DataTransportMessage<Command, ResponseType>;
type TransportConnection<ResponseType> = Connection<TransportMessage<ResponseType>>;
class DispatchClient<ResponseType> {
  nextId = 0;
  connection: TransportConnection<ResponseType>;
  // TODO: clean up pending requests on timeout or some error condition.
  // For now it is not as critical, as requests are serialised.
  private pending = new Map<string, PendingRequest>();
  constructor(connection: TransportConnection<ResponseType>) {
    this.connection = connection;
    this.connection.setMessageHandler((payload: TransportMessage<ResponseType>) => {
      if (payload.type === 'response') {
        const pending = this.pending.get(payload.id);
        if (!pending) {
          return;
        }
        this.pending.delete(payload.id);
        if (payload.result.type === 'error') {
          pending.reject(new Error(payload.result.message));
        } else {
          pending.resolve(payload.result.value);
        }
      }
    });
  }
   /** Connect (if needed), send the message, and return a Promise that resolves
   *  with the server's response value. Rejects on connection failure or server error. */
  async send(cmd: Command): Promise<ResponseType> {
    const id = String(this.nextId++);
    const abortCtl = new AbortController();
    console.log(`Sent message: ${id} ${this.nextId}, ${cmd.kind}`);
    return new Promise<ResponseType>((resolve, reject) => {
      this.pending.set(id, { resolve: (value: unknown) => {
        console.log(`Resolving request with ID ${id}`);
        resolve(value as ResponseType);
      }, reject, abortCtl });
      this.connection.send({ type: "request", id, cmd }, abortCtl.signal);
    });
  }

  private rejectAllPending(reason: string): void {
    for (const p of this.pending.values()) {
      p.abortCtl.abort();
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

class WSConnection<TransportedMsg> implements Connection<TransportedMsg> {
  private ws: WebSocket | null = null;
  private incomingBuffer: TransportedMsg[] = [];
  private handler: ((msg: TransportedMsg) => void) | undefined = undefined;
  private connectingPromise: { completion: Promise<void>, abortCtl: AbortController } | null = null;

  constructor(private url: string) {}

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectingPromise) return this.connectingPromise.completion;
    if (this.ws) {
      this.close();
    }
    const abortCtl = new AbortController();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    abortCtl.signal.addEventListener('abort', () => {
      ws.close();
    });
    this.connectingPromise = { completion: new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        resolve();
      };
      ws.onmessage = (event: MessageEvent) => {
        let msg: TransportedMsg;
        try {
          msg = JSON.parse(event.data as string) as TransportedMsg;
        } catch (e) {
          console.error('Failed to parse WebSocket message', e);
          return;
        }
        if (this.handler) {
          this.handler(msg);
        } else {
          this.incomingBuffer.push(msg);
        }
      };
      ws.onerror = (e) => {
        reject(new Error(`WebSocket connection to ${this.url} failed`));
      };
    }), abortCtl };
    return this.connectingPromise.completion;
  }
  send(msg: TransportedMsg, _?: AbortSignal): void {
    this.ws!.send(JSON.stringify(msg));
  }
  setMessageHandler(handler: (msg: TransportedMsg) => void): void {
    this.handler = handler;
    while (this.incomingBuffer.length > 0) {
      const msg = this.incomingBuffer.shift()!;
      this.handler(msg);
    }
  }
  close() {
    if (this.connectingPromise) {
      this.connectingPromise.abortCtl.abort();
      this.connectingPromise = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

let wsClient: DispatchClient<any> | undefined = undefined;
// let rtcClient: DispatchClient<DataTransport<DataTransportMessage<any>>, any> | null = null;
// ─── Dispatch ──────────────────────────────────────────────────────────────────

  const connector = new WSConnection<any>(WS_URL);
  await connector.connect();
  wsClient = new DispatchClient<any>(connector);
/**
 * Route a command to the backend.
 *
 * Routes via WebSocket when `window.__TRANSPORT__ === 'ws'`, otherwise via Tauri IPC invoke.
 */
export async function dispatch<T>(cmd: Command): Promise<T> {
  if (window.__TRANSPORT__ === 'ws') {
    // if(!rtcClient) {

    //   rtcClient = new DispatchClient<DataTransport<DataTransportMessage<any>>, any>(
    //     // new DataTransport());
    // }
    return wsClient!.send(cmd);
  }
  return callInvoke<T>('app_dispatch', cmd);
}

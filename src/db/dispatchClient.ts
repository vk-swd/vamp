import { callInvoke } from './tauriInvoke';
import { DataTransportMessage, RemoteRequest, RemoteResponse } from '../transport/generatedTypes';
import { DataTransport } from '../transport/rtc-ts/data_transport';
import { Command } from './generatedTypes';
import { log } from '@ts-src/logger';
// ─── Mode ─────────────────────────────────────────────────────────────────────
// Set window.__TRANSPORT__ = 'ws' (e.g. in index.html) to route via WebSocket.
// Undefined or any other value falls back to Tauri IPC invoke.

declare global {
  interface Window { __TRANSPORT__?: string; }
}

// ─── WebSocket client (singleton) ─────────────────────────────────────────────

// const WS_URL = 'wss://192.168.0.106:8090';
const WS_URL = 'ws://localhost:8090';

type WsState = 'disconnected' | 'connecting' | 'connected' | 'failed';

type PendingRequest = {
  // TODO: Define result types.
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

interface Connection<TransportedMsg> {
  send(data: TransportedMsg, signal?: AbortSignal): Promise<void>;
  setMessageHandler(handler: (payload: TransportedMsg) => void): void;
}

class DispatchClient<ConnectionType extends Connection<DataTransportMessage<Command, TransportedMsg>>, TransportedMsg> {
  nextId = 0;
  connection: ConnectionType;
  // TODO: clean up pending requests on timeout or some error condition.
  // For now it is not as critical, as requests are serialised.
  private pending = new Map<string, PendingRequest>();
  constructor(connection: ConnectionType) {
    this.connection = connection;
    this.connection.setMessageHandler((payload: DataTransportMessage<Command, TransportedMsg>) => {
      if (payload.type === 'response') {
        const pending = this.pending.get(payload.id);
        if (!pending) {
          log(`Received response for unknown request ID ${JSON.stringify(payload)}`);
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
  async send(cmd: Command): Promise<TransportedMsg> {
    const id = String(this.nextId++);
    return new Promise<TransportedMsg>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.connection.send({ type: "request", id, cmd });
    });
  }
}

class WsDispatchClient {
  private ws: WebSocket | null = null;
  private state: WsState = 'disconnected';
  /** Shared promise while a connection attempt is in progress. */
  private connectingPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();

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
        const msg = JSON.parse(event.data as string) as RemoteResponse<any>;
        const pending = this.pending.get(msg.id);
        if (!pending) {
          log(`Received response for unknown request ID ${JSON.stringify(msg)}`);
          return;
        }

        this.pending.delete(msg.id);
        if (msg.result.type === 'error') {
          pending.reject(new Error(msg.result.message));
        } else {
          pending.resolve(msg.result.value);
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
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ id, cmd: { kind, payload: payload ?? null } }));
    });
  }

  getState(): WsState { return this.state; }
}

const wsClient = new WsDispatchClient();
// let rtcClient: DispatchClient<DataTransport<DataTransportMessage<any>>, any> | null = null;
// ─── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Route a command to the backend.
 *
 * Routes via WebSocket when `window.__TRANSPORT__ === 'ws'`, otherwise via Tauri IPC invoke.
 */
export function dispatch<T>(cmd: Command): Promise<T> {
  if (window.__TRANSPORT__ === 'ws') {
    // if(!rtcClient) {

    //   rtcClient = new DispatchClient<DataTransport<DataTransportMessage<any>>, any>(
    //     // new DataTransport());
    // }
    return wsClient.send<T>(cmd.kind, cmd.payload);
  }
  return callInvoke<T>('app_dispatch', cmd);
}

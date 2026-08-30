import { WsResponse } from '../db/generatedTypes';
import {
  SequenceFilter,
  SignallingConnection,
  SignalMsg,
  SignallingConnectionConfig,
  TransportMsg,
  makeNodeId,
} from './signalling_connection';

type DataChannelMsg = { msg: string };

export type RtcConnectionConfig = {
  signallingUrl: SignallingConnectionConfig['signallingUrl'];
  sessionId: SignallingConnectionConfig['sessionId'];
  coturnIp: string;
  coturnPort: string | number;
  stunCredentials: string;
  iceRestartAfterMs?: number;
  signallingRetryMs?: SignallingConnectionConfig['signallingRetryMs'];
};

type RtcState = 'closed' | 'connecting' | 'negotiating' | 'connected' | 'disconnected';

const DEFAULT_ICE_RESTART_TIMEOUT = 60_000;
const DATA_CHANNEL_LABEL = 'default';

function splitCredentials(credentials: string): { username: string; credential: string } {
  const separator = credentials.indexOf(':');
  if (separator < 1) {
    throw new Error('stunCredentials must have the form username:password');
  }
  return {
    username: credentials.slice(0, separator),
    credential: credentials.slice(separator + 1),
  };
}

class RtcConnection {
  private readonly signalling: SignallingConnection;
  private peer: RTCPeerConnection | undefined;
  private dataChannel: RTCDataChannel | undefined;
  private readonly dataChannelFilter = new SequenceFilter();
  private readonly outboundNodeId = makeNodeId();
  private nextDataSn = 0;
  private currentNegotiationId: string | undefined;
  private state: RtcState = 'closed';
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  private readonly readyWaiters: Array<{
    resolve: () => void;
    reject: (reason: unknown) => void;
  }> = [];

  constructor(private readonly config: RtcConnectionConfig) {
    this.signalling = new SignallingConnection(config);
    this.signalling.setSignalHandler((signal) => this.handleSignal(signal));
  }

  async start(): Promise<void> {
    if (this.state !== 'closed') return this.startPromise;
    this.state = 'connecting';
    this.startPromise = this.startInternal().catch((error) => {
      this.state = 'closed';
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    await this.signalling.start();
    await this.createPeer(true);
    await this.createOffer(false);
  }

  private async createPeer(createChannel: boolean): Promise<void> {
    this.peer?.close();
    const credentials = splitCredentials(this.config.stunCredentials);
    const peer = new RTCPeerConnection({
      iceServers: [{
        urls: `turn:${this.config.coturnIp}:${this.config.coturnPort}`,
        username: credentials.username,
        credential: credentials.credential,
      }],
    });
    this.peer = peer;
    this.dataChannel = undefined;
    this.state = 'negotiating';

    peer.onicecandidate = (event) => {
      if (!event.candidate || !this.currentNegotiationId) return;
      void this.signalling.send({
        type: 'ice-candidate',
        sdp: JSON.stringify(event.candidate.toJSON()),
        neg_id: this.currentNegotiationId,
      }).catch(() => undefined);
    };
    peer.onconnectionstatechange = () => this.handleConnectionState(peer.connectionState);
    peer.ondatachannel = (event) => this.attachDataChannel(event.channel);
    if (createChannel) this.attachDataChannel(peer.createDataChannel(DATA_CHANNEL_LABEL));
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    if (channel.label !== DATA_CHANNEL_LABEL) {
      channel.close();
      return;
    }
    this.dataChannel?.close();
    this.dataChannel = channel;
    channel.onopen = () => {
      if (this.peer?.connectionState === 'connected') {
        this.state = 'connected';
        this.cancelRestart();
        this.resolveReady();
      }
    };
    channel.onmessage = (event) => this.receiveDataMessage(String(event.data));
    channel.onclose = () => {
      if (this.dataChannel === channel) this.dataChannel = undefined;
      if (this.state === 'connected') this.handleConnectionState('disconnected');
    };
    channel.onerror = () => {
      if (this.state === 'connected') this.handleConnectionState('disconnected');
    };
  }

  private async createOffer(iceRestart: boolean): Promise<void> {
    const peer = this.peer;
    if (!peer) throw new Error('RTC peer is not initialized');
    const negotiationId = `${crypto.randomUUID()}`;
    this.currentNegotiationId = negotiationId;
    const offer = await peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await peer.setLocalDescription(offer);
    await this.signalling.send({
      type: 'offer',
      sdp: offer.sdp ?? '',
      neg_id: negotiationId,
    });
  }

  private async handleSignal(signal: SignalMsg): Promise<void> {
    // This peer is the offerer. Remote offers are not part of this
    // connection's negotiation flow; a new local offer is created on restart.
    if (signal.type === 'offer' || !this.peer || signal.neg_id !== this.currentNegotiationId) return;
    try {
      if (signal.type === 'answer') {
        await this.peer?.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      } else if (signal.type === 'ice-candidate') {
        await this.peer?.addIceCandidate(JSON.parse(signal.sdp) as RTCIceCandidateInit);
      }
    } catch {
      this.scheduleRestart();
    }
  }

  private handleConnectionState(connectionState: RTCPeerConnectionState): void {
    if (connectionState === 'connected' && this.dataChannel?.readyState === 'open') {
      this.state = 'connected';
      this.cancelRestart();
      this.resolveReady();
      return;
    }
    if (connectionState === 'disconnected' || connectionState === 'failed') {
      this.state = 'disconnected';
      this.scheduleRestart();
    } else if (connectionState === 'closed') {
      this.state = 'closed';
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.state === 'closed') return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.restartIce();
    }, this.config.iceRestartAfterMs ?? DEFAULT_ICE_RESTART_TIMEOUT);
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private waitUntilReady(): Promise<void> {
    if (this.state === 'connected' && this.dataChannel?.readyState === 'open') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  private resolveReady(): void {
    while (this.readyWaiters.length > 0) this.readyWaiters.shift()?.resolve();
  }

  private rejectReady(reason: Error): void {
    while (this.readyWaiters.length > 0) this.readyWaiters.shift()?.reject(reason);
  }

  private async restartIce(): Promise<void> {
    if (this.state === 'closed') return;
    try {
      if (!this.peer || this.peer.connectionState === 'closed' || this.dataChannel?.readyState === 'closed') {
        await this.createPeer(true);
        await this.createOffer(false);
      } else {
        this.state = 'negotiating';
        await this.createOffer(true);
      }
    } catch {
      this.scheduleRestart();
    }
  }

  private receiveDataMessage(raw: string): void {
    let message: TransportMsg<DataChannelMsg>;
    try {
      message = JSON.parse(raw) as TransportMsg<DataChannelMsg>;
    } catch {
      return;
    }
    if (message.type === 'ack') return;
    this.sendDataMessage({ type: 'ack', sn: message.sn, node_id: message.node_id });
    if (!this.dataChannelFilter.accept(message.node_id, message.sn)) return;
    let response: WsResponse<unknown>;
    try {
      response = JSON.parse(message.payload.msg) as WsResponse<unknown>;
    } catch {
      return;
    }
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;
    this.pendingRequests.delete(response.id);
    if (response.result.type === 'error') pending.reject(new Error(response.result.message));
    else pending.resolve(response.result.value);
  }

  private sendDataMessage(message: TransportMsg<DataChannelMsg>): void {
    const channel = this.dataChannel;
    if (channel?.readyState !== 'open') throw new Error('RTC data channel is not open');
    channel.send(JSON.stringify(message));
  }

  async send<T>(kind: string, payload: unknown): Promise<T> {
    await this.start();
    await this.waitUntilReady();
    const id = crypto.randomUUID();
    const request = { id, cmd: { kind, payload: payload ?? null } };
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.sendDataMessage({
          type: 'normal',
          sn: this.nextDataSn++,
          node_id: this.outboundNodeId,
          payload: { msg: JSON.stringify(request) },
        });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  close(): void {
    this.cancelRestart();
    this.state = 'closed';
    this.rejectReady(new Error('RTC connection closed'));
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('RTC connection closed'));
    }
    this.pendingRequests.clear();
    this.dataChannel?.close();
    this.peer?.close();
    this.signalling.close();
  }

  getState(): RtcState {
    return this.state;
  }
}

let configuredConnection: RtcConnection | undefined;
let configuration: RtcConnectionConfig | undefined;

export function configureRtcConnection(config: RtcConnectionConfig): void {
  configuredConnection?.close();
  configuration = config;
  configuredConnection = new RtcConnection(config);
}

export function dispatch<T>(kind: string, payload: unknown = null): Promise<T> {
  if (!configuredConnection || !configuration) {
    return Promise.reject(new Error('RTC connection is not configured'));
  }
  return configuredConnection.send<T>(kind, payload);
}

export function closeRtcConnection(): void {
  configuredConnection?.close();
  configuredConnection = undefined;
  configuration = undefined;
}

export function rtcConnectionState(): RtcState {
  return configuredConnection?.getState() ?? 'closed';
}

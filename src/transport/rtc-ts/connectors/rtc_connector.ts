import { SignalMsg, TransportMsg, WireMsg } from '../../generatedTypes';
import { Connector, NodeState } from './connector';
import { WsSignallingConnector } from './ws_signalling_connector';
import { SendRetryHandle, TransportHandler } from '../transport_handler';

enum DebounceEvent {
    DisconnectedIce,
    FailedIce,
    ClosedChannel,
    NegotiatingChannel,
    NegotiatingICE,
    Failover
}

function parse_msg<T>(json: string): T {
    try {
        const msg = JSON.parse(json) as T;
        return msg;
    } catch (e) {
        console.error('Failed to parse message', e);
        throw e;
    }
}

export class RtcConnector implements Connector<string> {
    private currentNegotiationId: string | undefined;

    deliveryState: SendRetryHandle | undefined = undefined;
    pendingRequests: [SignalMsg, (() => void) | undefined][] = [];
    // senderHandle: 
    async sendSignallingMessage(msg: SignalMsg, sender: TransportHandler<SignalMsg>, callback?: () => void): Promise<void> {
        this.pendingRequests.push([msg, callback]);
        if (this.deliveryState) {
            return Promise.resolve();
        }
        while (this.pendingRequests.length > 0) {
            const [msg, callback] = this.pendingRequests[0];
            try {
                this.deliveryState = sender.send(msg, 4000);
                await this.deliveryState.resend_task;
                this.pendingRequests.shift();
                callback?.();
            } catch (e) {
                console.error('Failed to send signalling message: ', msg, " because: ", e);
            }
        }
        this.deliveryState = undefined;
    }

    private channel: RTCDataChannel | undefined;
    private peerConnection: RTCPeerConnection | undefined;

    private readonly wsConnector: WsSignallingConnector;
    private readonly wsTransportHandler: TransportHandler<SignalMsg>;

    // Debouncer ===============
    private debounceStartTime: number | undefined = undefined;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    private handlingDebounce = false;
    private readonly DISCONNECTED_RESTART_INTERVAL = 5000;
    private readonly FAILED_RESTART_INTERVAL = 1000;
    private readonly CLOSED_CHANNEL_INTERVAL = 1000;
    private readonly FAILOVER_INTERVAL = 500;
    private readonly NEGOTIATING_INTERVAL = Math.max(10000, this.DISCONNECTED_RESTART_INTERVAL, this.FAILED_RESTART_INTERVAL); // must be longest timeout among all others
    // =========================

    constructor(
        tag: string,
        private channelName: string,
        private ssUrl: string,
        private config: { iceServers: RTCIceServer[] },
        private messageHandler: (frame: string) => void
    
    ) {
        const wireRegistrationFrame: WireMsg<void> = { tag, message: null }
        this.wsTransportHandler = new TransportHandler<SignalMsg>(
            (payload: TransportMsg<SignalMsg>) => {
                const frame = JSON.stringify(payload);
                this.wsConnector.send(frame);
            },
            async (payload: SignalMsg) => {
                await this.handleSignalMsg(payload);
            }
        );
        this.wsConnector = new WsSignallingConnector(this.ssUrl, 
            /* registrationFrame */ JSON.stringify(wireRegistrationFrame), /* messageHandler */ 
            (frame: string) => {
                const msg = parse_msg<WireMsg<SignalMsg>>(frame);
                this.wsTransportHandler.handle_incoming(msg.message!);
                // handle incoming messages
            });
    }

    private startDebounceIfFaster(delay: number) {
        const now = Date.now();
        if (!this.debounceTimer || (this.debounceStartTime && (now - this.debounceStartTime) > delay)) {
            this.startDebounce(delay, now);
        }
    }
    private startDebounce(delay: number, now: number) {
        clearTimeout(this.debounceTimer);
        this.debounceStartTime = now;
        this.debounceTimer = setTimeout(() => this.onDebounceTimeout(), delay);
    }
    private addDebounceEvent(event: DebounceEvent) {
        if (this.handlingDebounce) {
            return;
        }
        switch (event) {
            case DebounceEvent.DisconnectedIce:
                this.startDebounceIfFaster(this.DISCONNECTED_RESTART_INTERVAL);
                break;
            case DebounceEvent.FailedIce:
                this.startDebounceIfFaster(this.FAILED_RESTART_INTERVAL);
                break;
            case DebounceEvent.ClosedChannel:
                this.startDebounceIfFaster(this.CLOSED_CHANNEL_INTERVAL);
                break;
            case DebounceEvent.NegotiatingChannel:
            case DebounceEvent.NegotiatingICE:
                // supposed to be called when no other events are pending
                this.startDebounce(this.NEGOTIATING_INTERVAL, Date.now());
                break;
            case DebounceEvent.Failover:
                this.startDebounce(this.FAILOVER_INTERVAL, Date.now());
                break;
        }
    }
    private isConnected() {
        return this.peerConnection!.iceConnectionState === 'connected' || this.peerConnection!.iceConnectionState === 'completed';
    }
    private isChannelOpen() {
        return this.channel?.readyState === 'open';
    }
    private debounceFailed() {
        this.handlingDebounce = false;
        this.addDebounceEvent(DebounceEvent.Failover);
    }
    private async onDebounceTimeout() {
        // While this handler is in progress, no debounce will be scheduled
        if (this.state() === NodeState.Closed) {
            return;
        }
        let hasConnection = this.isConnected();
        let channelOpen = this.isChannelOpen();
        if (hasConnection && channelOpen) {
            // Nothing to do, everything is fine
            return;
        }
        this.handlingDebounce = true;
        if (this.deliveryState) {
            // That might be too rough if only datachannel was closed,
            // but if it truly hurts, the connection will break eventually
            // and the debouncer will be called again. 
            // So to make things simple just clean deliveries here.
            this.pendingRequests = [];
            this.deliveryState.abort_controller?.abort(new Error('Making new negotiation attempt'));
            try {
                // Hopefully this does not hang...
                await this.deliveryState.resend_task;
            } catch (e) {
                console.error('Failed to resend task for ', e);
            }
            this.deliveryState = undefined;
        }

        // Going all in on a new negotiation might cause the old
        // sdp pair to miss on some ice candidates that could help recover old connection
        // or even establish it, but for simplicity this distinction of pending/current 
        // SDPs is not handled for now.

        this.currentNegotiationId = crypto.randomUUID();
        const iceRestart = !hasConnection;
        if (!channelOpen) {
            this.startNewChannel();
        }
        let offer;
        try {
            offer = await this.peerConnection!.createOffer({ iceRestart });
        } catch (e) {
            console.error('Failed to restart ICE for ', e);
            this.debounceFailed();
            return;
        }
        {
            const newPeerConnected = this.isConnected();
            const newChannelOpen = this.isChannelOpen();
            if (newPeerConnected && newChannelOpen) {
                // Situation resolved itself
                this.handlingDebounce = false;
                return;
            }
            if (newPeerConnected != hasConnection || newChannelOpen != channelOpen) {
                // Something changed, just start again later
                this.debounceFailed();
                return;
            }
        }
        try {
            await this.peerConnection!.setLocalDescription(offer);
        } catch (e) {
            console.error('Failed to set local description for ', e);
            this.debounceFailed();
            return;
        }
        if (this.isConnected() !== hasConnection || this.isChannelOpen() !== channelOpen) {
            // Something changed, rollback and retry later
            try {
                await this.peerConnection!.setLocalDescription( {type: 'rollback' });
            } catch (e) {
                // Probably should recreate peer connection at this point
                // TODO: see if it ever pops up and handle it then.
                console.error('Error during rollback ', e);
            }
            this.debounceFailed();
            return;
        }
        this.handlingDebounce = false;
        this.addDebounceEvent(DebounceEvent.NegotiatingICE);
        const sdp = this.peerConnection?.localDescription?.sdp ?? '';
        const neg_id = this.currentNegotiationId!;
        const signal_msg = { type: 'offer', sdp, neg_id } as SignalMsg;
        // now just wait for things to get better or retry the whole thing 
        // after the timeout
        this.sendSignallingMessage(signal_msg, this.wsTransportHandler);
    }
    async startPeerConnection(): Promise<void> {
        if (this.peerConnection) {
            console.warn('Peer connection already exists');
            return;
        }
        this.peerConnection = new RTCPeerConnection(this.config);
        this.peerConnection.oniceconnectionstatechange = () => {
            if (this.peerConnection?.iceConnectionState === 'disconnected') {
                this.addDebounceEvent(DebounceEvent.DisconnectedIce);
            }
            if (this.peerConnection?.iceConnectionState === 'failed') {
                this.addDebounceEvent(DebounceEvent.FailedIce);
            }
        };
        // In the worst case, some stale endpoint will get checked and rejected
        // So no need to track when the gathering restarts
        // this.peerConnection.onicegatheringstatechange = () => {
        this.peerConnection.ondatachannel = (event) => {
            // Channels can only be created by current peer - the initiator.
            event.channel.close();
        };
        this.peerConnection.onconnectionstatechange = () => {
            // For now it is included to check behavior.
            // Seems like it should mirror iceconnectionstatechange
            // + reflect dtls problems.
            console.warn('[rtc] connection state changed', 
                this.peerConnection?.connectionState, this.peerConnection?.iceConnectionState);
            this.peerConnection?.getTransceivers().forEach(t => {
                const rt = t.receiver.transport;
                const st = t.sender.transport;
                console.warn('[rtc] transceiver recv state:', rt?.state,', send: ', st?.state);
            });
        };
        this.peerConnection.onicecandidate = (event) => {
            if (!event.candidate) {
                return;
            }
            this.sendSignallingMessage({
                type: 'ice-candidate',
                sdp: JSON.stringify(event.candidate?.toJSON()),
                neg_id: this.currentNegotiationId!,
            }, this.wsTransportHandler);
        };
        this.startNewChannel();
        // This will initiate negotiation and will set up the debouncer to check the progress.
        this.onDebounceTimeout();
    }
    clearChannel() {
        if (!this.channel) {
            return;
        }
        this.channel.onmessage = null;
        this.channel.onclose = null;
        this.channel.onerror = null;
        this.channel.close();
        this.channel = undefined;
    }
    startNewChannel() {
        this.clearChannel();
        this.channel = this.peerConnection!.createDataChannel(this.channelName);
        // No need to track - channel state will be checked at delivery time.
        // this.channel.onopen = () => {}
        this.channel.onmessage = (event) => {
            // Could be a stale channel, but don't check it right now,
            // because it is a connection can break even while the response
            // is awaited. So not much is gained by checking staleness.
            // Staleness is when the message arrived and was scheduled for processing
            // just before the channel was closed and restarted (which is very unlikely).
            this.messageHandler(event.data);
        };
        this.channel.onerror = (event) => {
            console.error('[rtc] data channel error', event);
        };
        this.channel.onclose = () => {
            // This might be problematic in case a stale event was thrown,
            // but debounce timeout is not forcing new channel creation, it 
            // will do nothing if the channel is fine at timeout.
            this.addDebounceEvent(DebounceEvent.ClosedChannel);
        };
    }

    async handleSignalMsg(msg: SignalMsg) {
        if (!this.peerConnection) {
            console.error('Received signal message but no peer connection exists');
            return;
        }
        if (msg.neg_id !== this.currentNegotiationId) {
            // Nobody else can initiate any negotiation, so skip unexpected ids.
            console.warn('Received signal message with unexpected negotiation id', msg.neg_id);
            return;
        }
        // 1. Ignore offers as this peer is the initiator
        // 2. If the negotiation id is right, just apply the answer and the candidate
        // and let the RtcPeerConnection verify the assignement.
        // What matters is that the connection recovers when the timer hits.
        if (msg.type === 'answer') {
            // TODO: validate sdp
            try {
                await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            } catch (e) {
                console.error('Failed to apply remote description', e);
            }
        } else if (msg.type === 'ice-candidate') {
            // TODO: validate sdp
            try {
                await this.peerConnection.addIceCandidate(JSON.parse(msg.sdp));
            } catch (e) {
                console.error('Failed to add ICE candidate', e);
            }
        }
    }

    state(): NodeState {
        if (this.peerConnection?.iceConnectionState === 'closed') {
            return NodeState.Closed;
        }
        if ((this.peerConnection?.iceConnectionState === 'connected' ||
            this.peerConnection?.iceConnectionState === 'completed') && this.channel?.readyState !== 'open') {
            return NodeState.Connected;
        }
        return NodeState.Connecting;
    }

    send(frame: string): void {
        if (this.state() !== NodeState.Connected) {
            throw new Error('peer connection not connected');
        }
        this.channel!.send(frame);
    }

    getConnector(): Connector<string> {
        return this;
    }

    close(): void {
        this.peerConnection?.close();
        this.channel?.close();
        this.wsTransportHandler.stop();
        this.wsConnector.close();
    }
}
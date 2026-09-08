import { SignalMsg, TransportMsg, WireMsg } from '../../generatedTypes';
import { Connector, NodeState } from './connector';
import { WsSignallingConnector } from './ws_signalling_connector';
import { SendRetryHandle, TransportHandler } from '../transport_handler';

type QueueEvent = {
    id: number;
    name: string;
    run: () => Promise<void>;
};

function parseMessage<T>(frame: string): T {
    return JSON.parse(frame) as T;
}

/**
 * Owns one initiator-side WebRTC connection.
 *
 * WebRTC callbacks are external event sources. They only enqueue work here;
 * peer mutations and signalling sends are performed by one FIFO processor.
 */

class SessionLifeTimeFlags {
    applyingLocalDescription = false; //after this new candidates will berelated to this session
    // track candidates using the gathering state change
    gatheringStarted = false;
    awaitingAnswer = false;
    rollingBack = false;
    applyingRemoteDescription = false;
    sendingOffer = false;
    sendingCandidate = false;
    sending = false;
    // addingCandidate = false; // this is not montored since it does not have any processing after it...yet
    awaitingReconnect = false;
    waitingForRestart = false;
}
class SessionLifeTime {
    SessionId = crypto.randomUUID();
    flags: SessionLifeTimeFlags = new SessionLifeTimeFlags();
    dcState: DCLifeTime | undefined = undefined;
    pendingRequests: [SignalMsg, (() => void) | undefined][] = [];
    debounceState: DebounceState = new DebounceState();
    deliveryState: SendRetryHandle | undefined = undefined;
    isAlive = true;
    // senderHandle: 
    async sendSignallingMessage(msg: SignalMsg, sender: TransportHandler<SignalMsg>, callback?: () => void): Promise<void> {
        this.pendingRequests.push([msg, callback]);
        if (this.deliveryState) {
            return Promise.resolve();
        }
        while (this.pendingRequests.length > 0 && this.isAlive) {
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
}


enum DebounceEvent {
    DisconnectedIce,
    FailedIce,
    ClosedChannel,
    NegotiatingChannel,
    NegotiatingICE
}
/**
 * makea test to see how signals are sent...
 * but i need to design things for a safe operation, not rely on observed one...
 * 
 * 
 */
class DCLifeTime {
    id = crypto.randomUUID();
    isClosed = true;
}

class DebounceState {
    ongoningNegotiation = false;
    disconnectedStateWait = false;
    closedChannelWait = false;
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
    private sessions = new Map<string, SessionLifeTime>();
    /**
     * Datachannels are independent of sessions...sort of...you can negotiate
     * new datachannels without ice restarts...
     * do if the channel was closed while ice was connected, then i trigger opening channel with regular sdp
     * within the same session i mean...
     * if the channel was closed while the session was disconnected, then i would need to restart ice and recreate datachannel
     * if the channel was not closed at all, then i need to restart ice, but not create a new channel.
     * i might get close event while i have an ongoing ice restart negotiation, or i might loose conecntion while i have an ongoing datachannel negotiation...
     */
    private currentSessionId: string | undefined;
    private currentChannelId: string | undefined;

    private channel: RTCDataChannel | undefined;
    private peerConnection: RTCPeerConnection | undefined;

    private readonly wsConnector: WsSignallingConnector;
    private readonly wsTransportHandler: TransportHandler<SignalMsg>;

    private nodeState: NodeState = NodeState.Connecting;

    // Debouncer ===============
    private debounceEvents: Set<DebounceEvent> = new Set();
    private debounceStartTime: number | undefined = undefined;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    private readonly DISCONNECTED_RESTART_INTERVAL = 5000;
    private readonly FAILED_RESTART_INTERVAL = 1000;
    private readonly CLOSED_CHANNEL_INTERVAL = 1000;
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

    startDebounceIfFaster(delay: number) {
        const now = Date.now();
        if (!this.debounceTimer || (this.debounceStartTime && (now - this.debounceStartTime) > delay)) {
            this.startDebounce(delay, now);
        }
    }
    startDebounce(delay: number, now: number) {
        clearTimeout(this.debounceTimer);
        this.debounceStartTime = now;
        this.debounceTimer = setTimeout(() => this.onDebounceTimeout(), delay);
    }
    addDebounceEvent(event: DebounceEvent) {
        /**
         * Old debounce events:
         * 1. Old datachannel "onopen" event was scheduled before new channel replaced
         * the old one and the negotiation started = premature and fake negotiation success.
         * Solution - use current channel id to reconcile channel events. 
         * 2. Similar conflict with peer connection (though it is very unlikely to happen) 
         * - similar solution.
         * Both ids should be checked outside.
         */
        if (this.debounceEvents.has(event)) {
            // Ignore duplicates
            return;
        }
        this.debounceEvents.add(event);
        switch (event) {
            case DebounceEvent.DisconnectedIce:
                // if i wait for failed ice, then i dont need to reschedule anything
                if (this.debounceEvents.has(DebounceEvent.FailedIce)) {
                    return;
                }
                // If the channel was closed, then ICE can restart too, 
                // when timeout hits. But no need to reset the timer.
                if (this.debounceEvents.has(DebounceEvent.ClosedChannel)) {
                    return;
                }
                // If the channel is being created after DebounceEvent.ClosedChannel,
                // then unless ICE recovers the channel creation will fail.
                // Just update the timer for a faster restart.
                this.startDebounceIfFaster(this.DISCONNECTED_RESTART_INTERVAL);
                break;
            case DebounceEvent.FailedIce:
                // There is no recovery, so the disconnected event will be ignored,
                // and timer should restart to timeout sooner.
                this.startDebounceIfFaster(this.FAILED_RESTART_INTERVAL);
                break;
            case DebounceEvent.ClosedChannel:
                // If ICE didnt fail, it means remote peer closed channel,
                // which he had no right to do and channel needs to be restored.
                // But if ICE has already failed in some form, then when restart
                // happens OR when the connection is restored, new channel will
                // need to be recreated, part of restart or not.
                if (this.debounceEvents.has(DebounceEvent.FailedIce) || 
                    this.debounceEvents.has(DebounceEvent.DisconnectedIce) ||
                    // When ICE is renegotiated, it should finish first.
                    // It means if ICE is established, then we will be left
                    // with a channel negotiation and it will be rescheduled
                    // when ICE set up finishes.
                    this.debounceEvents.has(DebounceEvent.NegotiatingICE)) {
                    return;
                }
                this.startDebounceIfFaster(this.CLOSED_CHANNEL_INTERVAL);
                break;
            case DebounceEvent.NegotiatingChannel:
            case DebounceEvent.NegotiatingICE:
                // supposed to be called when no other events are pending
                this.startDebounce(this.NEGOTIATING_INTERVAL, Date.now());
                break;
        }
    }
    private clearDebounceEvent(event: DebounceEvent) {
        this.debounceEvents.delete(event);
    }
    private onDebounceTimeout() {
        // It is possible, that debounce event happened during the debounce timeout routine.
        // It might happen if ICE connection breaks during channel negotiation.
        //      In that case channel negotiation does not need to finish. 
        //      If it finishes before ice restores (which should be impossible) - fine.
        //      If it does not finish - create new SessionLifeTime and start anew, 
        //          with new channel or not.
        // It might happen if the channel gets closed during ICE restart negotiation.
        //    In that case, the ICE restart needs to finish first, and then start
        //    new channel negotiation.

    }
    async startPeerConnection(): Promise<void> {
        if (this.peerConnection) {
            console.warn('Peer connection already exists');
            return;
        }
        this.startNewSession();
    }
    startNewSession() {
        let restart = true;
        if (!this.peerConnection) {
            restart = false;
            this.peerConnection = new RTCPeerConnection(this.config);
        }
        const newSession = new SessionLifeTime();
        this.addDebounceEvent(DebounceEvent.NegotiatingICE);
        if (this.currentSessionId) {
            const currentSession = this.sessions.get(this.currentSessionId);
            if (currentSession) {
                newSession.dcState = currentSession.dcState;
                currentSession.isAlive = false;
            }
        }
        this.sessions.set(newSession.SessionId, newSession);
        this.currentSessionId = newSession.SessionId;

        this.peerConnection.oniceconnectionstatechange = () => {
            if (this.currentSessionId != newSession.SessionId ||
                !newSession.isAlive) {
                console.warn('[rtc] ignoring iceconnectionstatechange for abandoned session', newSession.SessionId);
                return;
            }
            if (this.peerConnection?.iceConnectionState === 'disconnected') {
                this.nodeState = NodeState.Connecting;
                this.addDebounceEvent(DebounceEvent.DisconnectedIce);
            }
            if (this.peerConnection?.iceConnectionState === 'failed') {
                this.nodeState = NodeState.Connecting;
                this.addDebounceEvent(DebounceEvent.FailedIce);
            }
            // connected of completed represent a working connection
            if (this.peerConnection?.iceConnectionState === 'connected' ||
                this.peerConnection?.iceConnectionState === 'completed') {
                this.clearDebounceEvent(DebounceEvent.DisconnectedIce);
                this.clearDebounceEvent(DebounceEvent.FailedIce);
                this.clearDebounceEvent(DebounceEvent.NegotiatingICE);
                if (this.channel?.readyState === 'open') {
                    this.nodeState = NodeState.Connected;
                }
            }
        };
        this.peerConnection.onicegatheringstatechange = () => {
            if (this.currentSessionId != newSession.SessionId ||
                !newSession.isAlive) {
                console.warn('[rtc] ignoring icegatheringstatechange for abandoned session', newSession.SessionId);
                return;
            }
            if (this.peerConnection?.iceGatheringState === 'gathering') {
                // Once gathering started, mark new session ready do accept
                // new candidates, to make sure those are current candidates
                // since Peer Connection is still the same.
                newSession.flags.gatheringStarted = true;
            }
        };
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
            if (!event.candidate) return;
            if (this.currentSessionId !== newSession.SessionId ||
                !newSession.isAlive
            ) {
                console.error('No current session id for ICE candidate', newSession.SessionId, this.currentSessionId);
                return;
            }
            if (!newSession.flags.gatheringStarted) {
                console.warn(`ICE candidate ${JSON.stringify(event.candidate)} 
                received before gathering started for session ${this.currentSessionId}`);
                return;
            }
            newSession.sendSignallingMessage({
                type: 'ice-candidate',
                sdp: JSON.stringify(event.candidate.toJSON()),
                neg_id: this.currentSessionId!,
            }, this.wsTransportHandler);
        };
        this.sessions.set(newSession.SessionId, newSession);
        if (!newSession.dcState || newSession.dcState.isClosed) {
            this.addDebounceEvent(DebounceEvent.NegotiatingChannel);
            this.startNewChannel();
        }
        return this.negotiate(restart, newSession);
    }
    startNewChannel() {
        if (!this.peerConnection || !this.currentSessionId) {
            console.error('No peer connection exists or current session set', 
            this.currentSessionId);
            return;
        }
        const currentSession = this.sessions.get(this.currentSessionId!);
        if (!currentSession) {
            console.error('No current session exists');
            return;
        }
        this.clearChannel();
        const newChannelState = new DCLifeTime();
        currentSession.dcState = newChannelState;
        this.channel = this.peerConnection.createDataChannel(this.channelName);
        this.channel.onopen = () => {
            const currentSessionLocal = this.sessions.get(this.currentSessionId!);
            if (!currentSessionLocal || 
                currentSessionLocal.dcState?.id !== newChannelState.id) {
                console.error('No current session exists');
                return;
            }
            this.clearDebounceEvent(DebounceEvent.NegotiatingChannel);
            this.clearDebounceEvent(DebounceEvent.ClosedChannel);
            // Because the channel will be a single track in the ICE connection,
            // it will be impossible to have an open channel 
            // with iceConnectionState != completed or connected
            if (this.peerConnection?.iceConnectionState == 'connected' ||
                this.peerConnection?.iceConnectionState == 'completed'
            ) {
                this.nodeState = NodeState.Connected;
            }
        }
        this.channel.onmessage = (event) => {
            if (!this.currentSessionId || 
                this.sessions.get(this.currentSessionId)?.dcState?.id 
                !== newChannelState.id ) {
                console.warn('Message from a stale data channel', event.data);
            }
            this.messageHandler(event.data);
        };
        this.channel.onerror = (event) => {
            console.error('[rtc] data channel error', event);
        };
        this.channel.onclose = () => {
            // since datachannels are unrelated to ICE connection session,
            // isAlive is not checked
            if (!this.currentSessionId || 
                this.sessions.get(this.currentSessionId)?.dcState?.id 
                !== newChannelState.id ) {
                console.error('No current session exists');
                return;
            }
            this.nodeState = NodeState.Connecting;
            this.addDebounceEvent(DebounceEvent.ClosedChannel);
        };
    }

    private async negotiate(iceRestart: boolean, session: SessionLifeTime): Promise<void> {
        const peer = this.peerConnection;
        if (!peer || !session.isAlive) {
            return;
        }
        session.flags.applyingLocalDescription = true;
        let offer;
        try {
            offer = await peer.createOffer({ iceRestart });
        } catch (e) {
            console.error('Failed to create offer for ', session.SessionId, e);
            return;
        }
        if (!session.isAlive) {
            return;
        }
        try {
            await peer.setLocalDescription(offer);
        } catch (e) {
            console.error('Failed to set local description for ', session.SessionId, e);
            return;
        }
        session.flags.applyingLocalDescription = false;
        if (!session.isAlive) return;
        session.flags.sendingOffer = true;
        session.flags.awaitingAnswer = true;
        try {
            await this.sendSignal({ type: 'offer', sdp: offer.sdp ?? '', neg_id: `${session.SessionId}` });
        } catch (e) {
            console.error('Failed to send offer signal for ', session.SessionId, e);
        }
        session.flags.sendingOffer = false;
    }
    async handleSignalMsg(msg: SignalMsg) {
        if (!this.peerConnection) {
            console.error('Received signal message but no peer connection exists');
            return;
        }
        if (!this.sessions.has(msg.neg_id) || msg.neg_id !== this.currentSessionId) {
            // Nobody else can initiate any negotiation, so skip unexpected ids.
            console.warn('Received signal message with unexpected negotiation id', msg.neg_id);
            return;
        }
        // ignore offers as this peer is the initiator
        if (msg.type === 'answer') {
            const negState = this.sessions.get(msg.neg_id)!;
            if (!negState.flags.awaitingAnswer ||
                // The rollback case that means that coming answer will be discarded
                // But before rollback, the awaitingAnswer state should be set to false,
                //  so this should not be possible.
                negState.flags.rollingBack ||
                // Just in case we received a duplicate answer
                // (thw awaitingAnswer state is not set to false unless the sdp is 
                // successfully applied)
                negState.flags.applyingRemoteDescription ||
                // Again, this can happen if we didnt get an ack message,
                // but the answer was sent, or if the intrnet routed ack after
                // the answer. It will be very rare, but still possible. Let
                // the renegotiation timer handle it for now.
                // Maybe later just consider this answer as the ack.
                negState.flags.sendingOffer ||
                // This means we haven't yet started waiting for an answer 
                // or sent the offer...this is just an experimental flag for now.
                negState.flags.applyingLocalDescription
                // Ignore sending event - at this point just apply the answer and let
                // problems with outgoing messages be handled 
                // by the cosmos (ICE connection failure + debouncer).
                // negState.flags.sendingCandidate
            ) {
                // this should not be possible
                console.warn(`Anomaly: Received answer while ${JSON.stringify(negState)}. Ignore ${msg.sdp}`);
                return;
            }
            // TODO: validate sdp
            negState.flags.applyingRemoteDescription = true;
            try {
                await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            } catch (e) {
                console.error('Failed to apply remote description', e);
            }
            negState.flags.applyingRemoteDescription = false;
            // Here the following case is not handled: when an ICE restart was triggered and 
            // the local sdp was assigned, offer sent and answer await started.
            // It is done because it is very unlikely to happen.
            // Actually, if ICE restart happens, the whole current negotiation state will change.
            if (this.peerConnection.signalingState === 'stable') {
                negState.flags.awaitingAnswer = false;
            } else {
                console.warn('Unexpected signalling state after applying answer:', this.peerConnection.signalingState);
            }
        } else if (msg.type === 'ice-candidate') {
            const negState = this.sessions.get(msg.neg_id)!;
            // Candidates should start coming only after the answer was generated 
            // and set as local SDP by a remote peer. And since the implemented protocol here
            // is to send one message at a time, the case when two messages were sent in
            // order but due to routing differences arrived in different order should
            // be impossible.
            if (negState.flags.awaitingAnswer || 
                // candidate while rolling back is inconvenient but could be ignored: it means offer came through
                // but we decided not to apply it and start a new one...and it probably 
                // means we haven't changed new current negotiation and that's why 
                // stale candidate was allowed.
                negState.flags.rollingBack || 
                // if the remote description is not set, adding candidate will throw
                // It is also posible that there is current remote sdp and a pending sdp 
                // is still in the process of being applied. In that case it could be accepted,
                // bit for simplicity this case will just be logged for now, since it is not 
                // proven to be a problem.
                negState.flags.applyingRemoteDescription ||
                // That would mean that we haven't got any answer yet or that we got 
                // a candidate before we got an answer and without getting acknowledgement for the offer.
                // In the former case this case should be impossible.
                // The latter case should be very unlikely and we could buffer incoming signalling events until 
                // one of our retries gets a response and all message sequence arrives,
                // but for now this will not be handled for simplicity.
                negState.flags.sendingOffer) {
                // wait for next restart
                console.warn(`Anomaly: Received ICE candidate while ${JSON.stringify(negState)}. Ignore ${msg.sdp}`);
                return;
            }
            // TODO: validate sdp
            try {
                await this.peerConnection.addIceCandidate(JSON.parse(msg.sdp));
            } catch (e) {
                console.error('Failed to add ICE candidate', e);
            }
        }
    }



    state(): NodeState {
        if (this.closed) return NodeState.Closed;
        if (!this.peerConnection || !this.channel) return NodeState.Connecting;
        if (this.peerConnection.connectionState === 'connected' && this.channel.readyState === 'open') {
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
        if (this.closed) return;
        this.closed = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        this.queue = [];
        this.wsTransportHandler.abort_current_delivery('RTC connector closed');
        this.wsTransportHandler.stop();
        this.clearPeer();
        this.wsConnector.close();
    }

    private enqueue(name: string, run: () => Promise<void>): number {
        const id = ++this.nextEventId;
        if (this.closed) return id;
        this.queue.push({ id, name, run });
        void this.processQueue();
        return id;
    }

    private async processQueue(): Promise<void> {
        if (this.processingQueue) return;
        this.processingQueue = true;
        try {
            while (!this.closed && this.queue.length > 0) {
                const event = this.queue.shift()!;
                try {
                    await event.run();
                } catch (error) {
                    console.warn(`[rtc] event ${event.name} (${event.id}) failed`, error);
                }
            }
        } finally {
            this.processingQueue = false;
            if (!this.closed && this.queue.length > 0) void this.processQueue();
        }
    }

    private enqueueSignal(message: SignalMsg): void {
        if (message.type === 'offer' || message.type === 'local-candidate') return;
        const negotiationId = Number(message.neg_id);
        if (!Number.isInteger(negotiationId)) return;

        if (message.type === 'answer') {
            this.enqueue('remoteAnswer', () => this.applyAnswer(negotiationId, message.sdp));
        } else if (message.type === 'ice-candidate') {
            this.enqueue('remoteIceCandidate', () => this.applyRemoteCandidate(negotiationId, message.sdp));
        }
    }

    private async createConnection(): Promise<void> {
        if (this.closed || this.peerConnection) return;

        const peer = new RTCPeerConnection(this.config);
        this.peerConnection = peer;
        this.assignPeerCallbacks(peer);
        this.createChannel(peer);
        await this.negotiate(false);
    }

    private assignPeerCallbacks(peer: RTCPeerConnection): void {
        peer.onicecandidate = (event) => {
            if (!event.candidate || peer !== this.peerConnection) return;
            const negotiationId = this.nextNegotiationId;
            this.enqueue('localIceCandidate', async () => {
                if (peer !== this.peerConnection || negotiationId !== this.nextNegotiationId) return;
                await this.sendSignal({
                    type: 'ice-candidate',
                    sdp: JSON.stringify(event.candidate!.toJSON()),
                    neg_id: `${negotiationId}`,
                });
            });
        };

        peer.ondatachannel = (event) => {
            event.channel.close();
        };

        peer.onconnectionstatechange = () => {
            if (peer !== this.peerConnection) return;
            if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') {
                this.scheduleRestart(false);
            } else if (peer.connectionState === 'connected' && !this.restartWithNewChannel) {
                this.cancelRestartTimer();
            }
        };
    }

    private async sendSignal(message: SignalMsg): Promise<void> {
        await this.wsTransportHandler.send(message, 5000);
    }

    private async applyAnswer(negotiationId: number, sdp: string): Promise<void> {
        if (!this.peerConnection || negotiationId !== this.nextNegotiationId) return;
        await this.peerConnection.setRemoteDescription({ type: 'answer', sdp });
        this.remoteDescriptionNegotiation = negotiationId;
        const pending = this.pendingRemoteCandidates.filter((candidate) => candidate.negotiationId === negotiationId);
        this.pendingRemoteCandidates = [];
        for (const candidate of pending) {
            await this.peerConnection.addIceCandidate(JSON.parse(candidate.sdp));
        }
    }

    private async applyRemoteCandidate(negotiationId: number, sdp: string): Promise<void> {
        if (!this.peerConnection || negotiationId !== this.nextNegotiationId) return;
        if (this.remoteDescriptionNegotiation !== negotiationId) {
            this.pendingRemoteCandidates.push({ negotiationId, sdp });
            return;
        }
        await this.peerConnection.addIceCandidate(JSON.parse(sdp));
    }

    private scheduleRestart(withNewChannel: boolean): void {
        if (this.closed) return;
        if (withNewChannel) this.restartWithNewChannel = true;
        if (this.restartTimer) return;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            this.needRestart = true;
            this.queue = [];
            this.wsTransportHandler.abort_current_delivery('RTC restart requested');
            this.enqueue('restartConnection', () => this.restartConnection());
        }, this.restartDelayMs);
    }

    private cancelRestartTimer(): void {
        if (!this.restartTimer) return;
        clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
    }

    private async restartConnection(): Promise<void> {
        if (this.closed || !this.needRestart) return;
        this.needRestart = false;
        const withNewChannel = this.restartWithNewChannel;
        this.restartWithNewChannel = false;
        const peer = this.peerConnection;
        if (!peer) {
            await this.createConnection();
            return;
        }
        if (withNewChannel) this.createChannel(peer);
        await this.negotiate(true);
    }

    private clearChannel(): void {
        if (!this.channel) return;
        this.channel.onopen = null;
        this.channel.onclose = null;
        this.channel.onmessage = null;
        this.channel.onerror = null;
        this.channel.close();
        this.channel = undefined;
    }

    private clearPeer(): void {
        this.clearChannel();
        if (!this.peerConnection) return;
        this.peerConnection.onicecandidate = null;
        this.peerConnection.ondatachannel = null;
        this.peerConnection.onconnectionstatechange = null;
        this.peerConnection.close();
        this.peerConnection = undefined;
    }
}
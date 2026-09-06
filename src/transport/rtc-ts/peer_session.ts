/**
 * Wraps a single `RTCPeerConnection` lifetime.
 *
 * Equivalent of `RtcConnectionHandler` in the plan sketch plus
 * `new_default_peer_connection` from `src-tauri/rtc/rtc_peer_stuff.rs`.
 *
 * Knows nothing about signalling transport or restarts; it only turns peer
 * connection events into callbacks and applies remote descriptions.
 */

import { SignalMsg, TransportMsg, WireMsg } from "../generatedTypes";
import { Connector, NodeState } from "./connectors/connector";
import { WsSignallingConnector } from "./connectors/ws_signalling_connector";
import { TransportHandler } from "./transport_handler";


enum DCState {
    Sending,
    Idle
}
type DCMsg = {
    fragment_id: number,
    total_fragments: number,
    data: string
}

class DcConnector implements Connector<string> {
    constructor(
        private send_impl: (frame: string) => void,
        private close_impl: () => void,
        private state_impl: () => NodeState
    ){

    }
    send(frame: string): void {
        this.send_impl(frame);
    }
    close(): void {
        this.close_impl();
    }
    state(): NodeState {
        return this.state_impl();
    }
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
enum RtcConnectorState {
    Connected,
    PendingDeliveryConnecting
}
class RtcChannelKeeper {
    channel: RTCDataChannel | undefined = undefined;
    peerConnection: RTCPeerConnection | undefined = undefined;
    wsConnector: WsSignallingConnector;
    wsTransportHandler: TransportHandler<SignalMsg>;
    negotiationId: number | undefined = undefined;
    dataChannelId = 0;
    pendingToSend: { id: number, msg: SignalMsg }[] = [];
    deliveryId = 0;
    pendingDelivery: Promise<void> | undefined = undefined;
    restartTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
    restartWithNewChannel = false;
    constructor(
        tag: string,
        private channelName: string,
        private ssUrl: string,
        private config: { iceServers: RTCIceServer[] }
    
    ) {
        const wireRegistrationFrame: WireMsg<void> = { tag, message: null }
        this.wsTransportHandler = new TransportHandler<SignalMsg>(
            (payload: TransportMsg<SignalMsg>) => {
                const frame = JSON.stringify(payload);
                this.wsConnector.send(frame);
            },
            (payload: SignalMsg) => {
                this.handleSignalMsg(payload);
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
    sendSignalMsg(msg?: SignalMsg) {
        if (msg) {
            this.pendingToSend.push({ id: this.deliveryId++, msg });
        }
        if (!this.pendingDelivery && this.pendingToSend.length > 0) {
            const front = this.pendingToSend[0];
            const frontMsg = front.msg;
            this.pendingDelivery = 
                this.wsTransportHandler.send(frontMsg, 5000)
                .catch((e) => {
                    console.error('[rtc] failed to send signal message', e);
                })
                .finally(() => {
                    this.pendingDelivery = undefined;
                    if (this.pendingToSend.length > 0 &&
                        this.pendingToSend[0].id === front.id
                    ) {
                        this.pendingToSend.shift();
                    }
                    this.sendSignalMsg();
                });
        }
    }
    dropStalePending() {
        if (this.pendingToSend.length > 0) {
            console.debug('[rtc] dropping stale pending messages', this.pendingToSend.length);
            this.pendingToSend = [];
        }
        if (this.pendingDelivery) {
            console.debug('[rtc] dropping stale pending delivery');
            this.wsTransportHandler.abort_current_delivery();
            this.pendingDelivery = undefined;
        }
    }   
    startConnection() {
        if (this.peerConnection) {
            return;
        }
        this.peerConnection = new RTCPeerConnection(this.config);
        this.restartChannel();

        const negotiationId = (this.negotiationId ?? 0) + 1;
        this.negotiationId = negotiationId;
        this.initConnection(negotiationId);       
        this.signalOffer();
    }
    clearDataChannelCallbacks(channel: RTCDataChannel) {
        channel.onopen = null;
        channel.onclose = null;
        channel.onmessage = null;
        channel.onerror = null;
    }
    initConnection(negotiationId: number) {
        let peerConnection = this.peerConnection;
        if (!peerConnection) {
            console.error('[rtc] cannot init connection, no peer connection');
            return;
        }
        peerConnection.onicecandidate = (event) => {
            if (!event.candidate) return;
            const sdpJson = JSON.stringify(event.candidate.toJSON());
            const signalMsg: SignalMsg = {
                type: 'ice-candidate',
                sdp: sdpJson,
                neg_id: `${negotiationId}`
            };
            // TODO: cancel send
            this.sendSignalMsg(signalMsg);
        };
        peerConnection.ondatachannel = (event) => {
            // Only GUI client creates data channels.
            const dc = event.channel;
            this.clearDataChannelCallbacks(dc);
            dc.close();
        };

        peerConnection.onconnectionstatechange = () => {
            console.debug('[rtc] connection state change', peerConnection?.connectionState);
            if (peerConnection?.connectionState == 'failed' ||
                peerConnection?.connectionState == 'disconnected') {
                this.requestRestart();
            } else {
                if (this.restartTimeout && !this.restartWithNewChannel) {
                    clearTimeout(this.restartTimeout);
                    this.restartTimeout = undefined;
                }
            }
        };
    }
    restartChannel() {
        if (!this.peerConnection) {
            console.error('[rtc] cannot restart channel, no peer connection');
            return;
        }
        if (this.channel) {
            const oldChannel = this.channel;
            this.clearDataChannelCallbacks(oldChannel);
            oldChannel.close();
            this.channel = undefined;
        }
        const dataChannelId = ++this.dataChannelId;
        const channel = this.peerConnection.createDataChannel(this.channelName);
        this.channel = channel;
        channel.onopen = () => {
            console.debug('[rtc] data channel open');
        };
        channel.onclose = () => {
            if (this.dataChannelId !== dataChannelId) {
                return;
            }
            this.clearDataChannelCallbacks(channel);
            this.channel = undefined;
            console.debug('[rtc] data channel closed');
            this.requestRestart(true, dataChannelId);
        };
        channel.onmessage = (event) => {
            console.debug('[rtc] data channel message', event.data);
        };
        channel.onerror = (event) => {
            console.error('[rtc] data channel error', event);
        };
    }

    requestRestart(newChannel = false, closedChannelId?: number) {
        if (newChannel && closedChannelId !== this.dataChannelId) {
            return;
        }
        if (newChannel) {
            this.restartWithNewChannel = true;
        }
        if (this.restartTimeout) {
            return;
        }
        this.restartTimeout = setTimeout(() => {
            this.restartTimeout = undefined;
            const recreateChannel = this.restartWithNewChannel;
            this.restartWithNewChannel = false;
            this.restartConnection(recreateChannel);
        }, 5000);
    }
    restartConnection(newChannel?: boolean) {
        if (!this.peerConnection) {
            this.startConnection();
            return;
        }
        const newNegotiationId = (this.negotiationId ?? 0) + 1;
        this.negotiationId = newNegotiationId;
        if (newChannel) {
            this.restartChannel();
        }
        this.initConnection(newNegotiationId);
        this.signalOffer();
    }
    signalOffer() {
        if (!this.peerConnection || this.negotiationId === undefined) {
            console.error('[rtc] cannot signal offer, no peer connection');
            return;
        }
        const negotiationId = this.negotiationId;
        this.peerConnection.createOffer({ iceRestart: true })
        .then((offer) => {
            if (negotiationId !== this.negotiationId) {
                console.debug('[rtc] ignoring offer for stale negotiation id', negotiationId);
                return;
            }
            return this.peerConnection!.setLocalDescription(offer);
        }).then(() => {
            if (negotiationId !== this.negotiationId) {
                console.debug('[rtc] ignoring offer for stale negotiation id', negotiationId);
                return;
            }
            const local = this.peerConnection!.localDescription;
            if (!local) throw new Error('peer connection returned no local offer description');
            this.sendSignalMsg({
                type: 'offer',
                sdp: local.sdp,
                neg_id: `${negotiationId}`
            });
        })
        .catch((e) => {
            console.error('[rtc] failed to create or send offer', e);
        });
    }
    handleSignalMsg(msg: SignalMsg) {
        if (!this.peerConnection) {
            console.error('Received signal message but no peer connection exists');
            return;
        }
        if (`${this.negotiationId}` != msg.neg_id) {
            console.warn('Received signal message with unexpected negotiation id', msg.neg_id);
            return;
        }
        // ignore offers as this peer is the initiator
        if (msg.type === 'answer') {
            // TODO: validate sdp
            this.peerConnection.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        } else if (msg.type === 'ice-candidate') {
            // TODO: validate sdp
            this.peerConnection.addIceCandidate(JSON.parse(msg.sdp));
        }
    }
    initRtcPeerConnection() {
        if (!this.peerConnection) {
            console.error('No peer connection exists to initialize');
            return;
        }
        this.peerConnection.onicecandidate = (event) => {
            if (!event.candidate) return;
            const sdpJson = JSON.stringify(event.candidate.toJSON());
            const signalMsg: SignalMsg = {
                type: 'ice-candidate',
                sdp: sdpJson,
                neg_id: `${this.negotiationId!}`
            };
            this.wsTransportHandler.send(signalMsg, 5000).catch((e) => {
                console.error('Failed to send local candidate', e);
            });
        };
    }
    close() {
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = undefined;
        }
        if (this.channel) {
            this.channel.close();
            this.channel = undefined;
        }
        this.wsConnector.close();
    }
    getConnector(): DcConnector {
        const sender = (frame: string) => {
            if (!this.peerConnection || 
                this.peerConnection.connectionState !== 'connected' ||
                !this.channel || 
                this.channel.readyState !== 'open') {
                throw new Error('peer connection not connected');
            }
            this.channel.send(frame);
        }
        const closer = () => {
            this.close();
        };
        const stateGetter = () => {
            if (!this.peerConnection || !this.channel) {
                return NodeState.Connecting;
            }
            if (this.peerConnection.connectionState === 'connected' && this.channel.readyState === 'open') {
                return NodeState.Connected;
            }
            return NodeState.Connecting;
        };
        return new DcConnector(
            sender,
            closer,
            stateGetter
        );
    }
}

function makeDCTransporthandler(onMessage: (msg: DCMsg) => void): TransportHandler<T> {
    
    const sender: (payload: TransportMsg<DCMsg>) => void = (payload) => {
        // implement sender logic here
    };
    const handler: (payload: DCMsg) => void = (payload) => {
        // implement handler logic here
    };

    return new TransportHandler<DCMsg>(sender, handler);
}
class DCConnection<TransportedType> {
    // outgoing chunks
    // incoming chunks
    state = DCState.Idle;
    chunks: DCMsg[] = [];
    constructor(private chunkSize: number = 1024, 
        private transportHandler: TransportHandler<TransportedType>) {
    }
    send(msg: TransportedType): void {
        if (this.state !== DCState.Idle) {
            throw new Error('send already in progress');
        }
        this.state = DCState.Sending;
        const chunks = this.chunkMessage(msg);
        // split into chunks and send
    }
    chunkMessage(msg: TransportedType): DCMsg[] {
        const str = JSON.stringify(msg);
        const chunkSize = this.chunkSize; // 1KB chunks
        const totalChunks = Math.ceil(str.length / chunkSize);
        const chunks: DCMsg[] = [];
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = start + chunkSize;
            const data = str.slice(start, end);
            chunks.push({
                fragment_id: i,
                total_fragments: totalChunks,
                data
            });
        }
        return chunks;
    }
}
type ChannelName = "rtc-dc";



class RtcConnector {

    openChannels: Map<ChannelName, RTCDataChannel> = new Map();
    iceServers: Array<RTCIceServer> = [];
    send(channel: ChannelName, msg: string): void {

    }
    maintainChannels() {

    }
}
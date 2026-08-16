import { SpMcQueue, MpScQueueStreamConsumer, CancelToken, JoinHandle, rustSpawn, rustSelect, fContinue, rBreak, Notifyer, SignalMsg, sleep, MpScQueueStreamProducer } from "./common";
import { WsConnector } from "./ws_connector";



class SignalMsgFilter {
    currentId: string | undefined = undefined;
    next(msg: SignalMsg): boolean {
        if (this.currentId === undefined) {
            this.currentId = msg.neg_id;
            return true;
        }
        if (this.currentId !== msg.neg_id) {
            // log and record a metric
            return false;
        }
        return true;
    }
}

enum DebounceEvent {
    Start,
    End
}
class IceRestartDebouncer {
    // AI instruction - implement a more idiomatic rust version with similar api.
    eventQueue = new SpMcQueue<{event: DebounceEvent, id: number}>();
    // debounceRequest = new SpMcQueue<number>();
    stopper: CancelToken = new CancelToken();
    notifyerQueue = new SpMcQueue<number>();
    finishHandle: JoinHandle<void> | undefined = undefined;
    scheduledId: number = 0;
    constructor() {
        this.run();
        // make idiomatic rust debouncer here
        // which would allow me to work with it using interface I layed out here.
    }
    async stop() {
        this.stopper.cancel();
        if (this.finishHandle) {
            await this.finishHandle;
            this.finishHandle = undefined;
        }
    }
    async start(): Promise<number> {
        this.scheduledId += 1;
        const id = this.scheduledId;
        await this.eventQueue.tx.send({event: DebounceEvent.Start, id: this.scheduledId})
        return id;
    }
    end(): Promise<void> {
        return this.eventQueue.tx.send({event: DebounceEvent.End, id: this.scheduledId})
    }
    run() {
        if (this.finishHandle) {
            return;
        }
        this.finishHandle = rustSpawn(async () => {
            let debState = DebounceEvent.End;
            let currentId = 0;
            while (1) {
                if (debState === DebounceEvent.End) {
                    await rustSelect([
                        // biased
                        this.eventQueue.rx.next().then(async ({event, id}: {event: DebounceEvent, id: number}) => {
                            if (event !== DebounceEvent.End) {
                                currentId = id;
                            }
                            debState = event;
                        }),
                        this.stopper.cancelled().then(async () => {
                            rBreak();
                        }),
                    ]);
                } else {
                    await rustSelect([
                        // biased
                        this.eventQueue.rx.next().then(async ({event, id}: {event: DebounceEvent, id: number}) => {
                            if (event !== DebounceEvent.End) {
                                currentId = id;
                            }
                            debState = event;
                        }),
                        sleep(5000).then(async () => {
                            // log and record a metric. This means previous negotiation took too long and will be restarted.
                            this.notifyerQueue.tx.send(currentId)
                            debState = DebounceEvent.End;
                        }),
                        this.stopper.cancelled().then(async () => {
                            rBreak();
                        })
                    ]);
                }
            }
        });
    }
    async waitForDebounce(id: number): Promise<void> {
        while (1) {
            const val = await this.notifyerQueue.rx.next()
            if (id == val) {
                return;
            }
        }
    }
}




class Atomic {
    private value: number = 0;
    load(): number {
        return this.value;
    }
    store(val: number): void {
        this.value = val;
    }
    increment(): void {
        this.value += 1;
    }
}
class RtcConnectionHandler {
    endpointId = crypto.randomUUID(); // constant through lifetime
    constructor() {
        // log events such as on_negotiation_needed and on signal state changed
    }
    // dont nullify on stable state and stopped gathering  
    // because other peer might still send candidates
    currentNegotiationId = new Atomic(); 
    needsRestart = true;
    scheduledRemoteSdp: string | undefined = undefined;
    getAnswer(): Promise<String> {
        // generate answer here
        return Promise.resolve("answer_sdp"); // generate answer sdp here
    }
    setLocalDescription(sdp: string): Promise<void> {
        // set local description here
        return Promise.resolve();
    }
    negotiationId(): string {   
        return this.endpointId + this.currentNegotiationId.load().toFixed();
    }
    updateCurrentNegotiationId(): void {
        // each rtcpeer instance should have uuid iinstance and an incrementing postfix
        // increment atomic postfix here
        this.currentNegotiationId.increment();
    }
    setForRestart(remoteSdp?: string) {
        this.needsRestart = true;
        this.scheduledRemoteSdp = remoteSdp;
    }
    restartIce(neg_id: string, remoteSdp?: string): Promise<SignalMsg> {
        if (remoteSdp) {
            // set remote sdp
            // create answer
            // set local sdp
            const localSdp = "local_sdp"; // generate local sdp here
            return Promise.resolve({ type: 'answer', sdp: localSdp, neg_id });
        } else {
            const localOffer = "make_local_sdp_with_restart"; // create offer
            this.setLocalDescription(localOffer);
            const localSdp = "got_local_description"; // get local description
            return Promise.resolve({ type: 'offer', sdp: localSdp, neg_id });
        }   
    }
    setOffer(offer: string): Promise<void> {
        return Promise.resolve();
    }
    setAnswer(answer: string): Promise<void> {
        // set remote sdp
        return Promise.resolve();
    }
    addIceCandidate(candidate: string): Promise<void> {
        return Promise.resolve();
    }
    onIceCandidate(callback: (candidate: string) => void): void {
    }
    onIceStateChange(callback: (state: 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed') => void): void {
        
    }
    onSignallingStateChange(callback: (state: 'stable' | 'have-local-offer' | 'have-remote-offer' | 'have-local-pranswer' | 'have-remote-pranswer' | 'closed') => void): void {
    }
    onNegotiationNeeded(callback: () => void): void {
        //log and record a metric, not sure i should use it
    }
}

class NegSessionIds {
    currentId: string
    constructor(initialId: string) {
        this.currentId = initialId;
    }
}
           
enum SelectEvents {
    ConnectionEvent,
    DebouncerTimeout,
    IncomingMsg,
    Error
}
type SelectEvent = {
    type: SelectEvents.ConnectionEvent | SelectEvents.DebouncerTimeout | SelectEvents.IncomingMsg | SelectEvents.Error,
    data?: any
}
const getEvent = async (debouncer: IceRestartDebouncer, debounceId: number,
    connectionEventQueueRx: MpScQueueStreamConsumer<ConnectionDebounceEvent>,
    incomingMsgQueueRx: MpScQueueStreamConsumer<SignalMsg>
): Promise<SelectEvent> => {
    const res = rustSelect<SelectEvent>([
        // biased
        // offerQueueRx.next().then((msg: SignalMsg) => ({ type: SelectEvents.IncomingMsg, data: msg })).catch(() => ({ type: SelectEvents.Error, data: "E1" })),
        connectionEventQueueRx.next().then((event: ConnectionDebounceEvent) => ({ type: SelectEvents.ConnectionEvent, data: event })).catch(() => ({ type: SelectEvents.Error, data: "E1" })),
        debouncer.waitForDebounce(debounceId).then(() => ({ type: SelectEvents.DebouncerTimeout, data: "" })).catch(() => ({ type: SelectEvents.Error, data: "E2" })),
        incomingMsgQueueRx.next().then((msg: SignalMsg) => ({ type: SelectEvents.IncomingMsg, data: msg })).catch(() => ({ type: SelectEvents.Error, data: "E3" })),
    ]);
    return res;
}
function initiatePeerConnectionCB(rtcPeerCon: RtcConnectionHandler,
    connectionEvent: MpScQueueStreamProducer<ConnectionDebounceEvent>,
    incomingMsgQueueTx: MpScQueueStreamProducer<SignalMsg>
): void {
    rtcPeerCon.onIceCandidate(async (candidate) => {
        await  incomingMsgQueueTx.try_send({ type: 'ice-candidate', sdp: candidate, neg_id: rtcPeerCon.currentNegotiationId.load().toFixed() }).catch(() => {
            // log and record metric.
        });
    });
    rtcPeerCon.onIceStateChange((state) => {
        if (state === 'failed' || state === 'disconnected') {
            connectionEvent.try_send(ConnectionDebounceEvent.Disconnected).catch(() => {
                // log and record metric.
            });
        }
        if (state === 'connected') {
            connectionEvent.try_send(ConnectionDebounceEvent.Connected).catch(() => {
                // log and record metric.
            });
        }
    });
}

async function processConnectionEvent(debouncer: IceRestartDebouncer, event: ConnectionDebounceEvent, isNegotiating: boolean): Promise<void> {
    
}
async function restartIce(rtcPeerCon: RtcConnectionHandler, negs: NegSessionIds, wsConnector: WsConnector): Promise<void> {
    rtcPeerCon.updateCurrentNegotiationId();
    negs.currentId = rtcPeerCon.negotiationId();
    let offerToSend: SignalMsg;
    try {
        offerToSend = await rtcPeerCon.restartIce(negs.currentId); 
    } catch (e) {
        // log and record a metric.
        // retry when debouncer hits. No special handling since 
        // this should be unlikely
        return;
    }
    await wsConnector.send(offerToSend);

}

async function acceptRemoteSdp(rtcPeerCon: RtcConnectionHandler, negs: NegSessionIds, msg: SignalMsg): Promise<void> {


}
enum ConnectionDebounceEvent {
    Connected,
    Disconnected
}
class Negotiator {
    wsConnector: WsConnector;
    incomingMsgQueue: SpMcQueue<SignalMsg>;
    connectionEventQueue = new SpMcQueue<ConnectionDebounceEvent>();
    runHandle: JoinHandle<void>;
    iceRestartDebouncer: IceRestartDebouncer = new IceRestartDebouncer();
    constructor(url: string, rttTag: string) {
        this.incomingMsgQueue = new SpMcQueue<SignalMsg>();
        this.wsConnector = new WsConnector(
            url, rttTag, async (msg: SignalMsg) => {
                await this.incomingMsgQueue.tx.try_send(msg).catch(() => {
                    // log and record metric.
                });
            }
        );
        this.runHandle = this.run();
    }
    async run() {
        return rustSpawn(async () => {
            const rtcPeerCon = new RtcConnectionHandler();
            initiatePeerConnectionCB(rtcPeerCon, this.connectionEventQueue.tx, this.incomingMsgQueue.tx);
            let negs = new NegSessionIds(rtcPeerCon.negotiationId());
            let connected = false;
            let negotiating = false;
            let debounceId = 0;
            while (1) {
                const event: SelectEvent = await getEvent(this.iceRestartDebouncer, debounceId, this.connectionEventQueue.rx, this.incomingMsgQueue.rx);
                if (event.type === SelectEvents.Error) {
                    // log and record a metric.
                    continue;
                }
                if (event.type === SelectEvents.ConnectionEvent) {
                    connected = event.data === ConnectionDebounceEvent.Connected;
                    if (connected && !negotiating) {
                        await this.iceRestartDebouncer.end();
                    } else if (!connected && !negotiating) {
                        debounceId = await this.iceRestartDebouncer.start();
                    }
                }
                if (event.type === SelectEvents.DebouncerTimeout) {
                    negotiating = true;
                    debounceId = await this.iceRestartDebouncer.start();
                    rustSelect([
                        restartIce(rtcPeerCon, negs, this.wsConnector),
                        this.iceRestartDebouncer.waitForDebounce(debounceId)
                    ])
                }
                if (event.type === SelectEvents.IncomingMsg) {
                    const msg: SignalMsg = event.data;
                    if (msg.type === 'offer') {
                        if (negotiating) {
                            // log and record a metric. Ignore the offer, because we are already negotiating.
                            return;
                        }
                        negotiating = true;
                        negs.currentId = msg.neg_id;
                        this.iceRestartDebouncer.refreshTimer();
                        /**
                         * Problems:
                         * 1) Debouncer might just have timed out and was scheduled for next loop pass
                         *  in which case it will trigger ice restart regardless of what is done here.
                         * 2) When remote offer arrives, stable state should be achieved here.
                         *  But if at some step the process fails it might leave side effects and 
                         *      instead of ice restart, whole connection should be restarted, because
                         *      rollback is not implemented in webrtc-rs.
                         * Both cases are left to be addressed for later as they are unlikely to happen
                         * in current operation.
                         */
                        let answerToSend: SignalMsg;
                        try {
                            answerToSend = await rtcPeerCon.restartIce(negs.currentId, msg.sdp); 
                        } catch (e) {
                            // log and record a metric.
                            // fail case here is not processed yet (see notes above)
                            // need to restart whole rtcpeer connection
                            return;
                        }
                        if (connected) {
                            this.iceRestartDebouncer.end();
                        } else {
                            this.iceRestartDebouncer.refreshTimer();
                        }
                        await this.wsConnector.send(answerToSend);
                    }
                    if (msg.type !== 'ice-candidate') {
                        if (msg.neg_id !== negs.currentId) {
                            // log and record a metric. Ignore the message.
                            return;
                        }
                    }
                    // After applying offer or answer check if stabble state is achieved
                    // If it was, then if connection achieved, then stop debouncer
                    if (msg.type === 'answer') {
                        try {
                            await rtcPeerCon.setAnswer(msg.sdp);
                            //if rtcpeer signalling state is stable {
                            negotiating = false;
                            if (connected) {
                                await this.iceRestartDebouncer.end();
                            } else {
                                await this.iceRestartDebouncer.refreshTimer();
                            }
                            //}
                        }
                        catch (e) {
                            // log and record a metric.
                            // should be safe to ignore failed attempt too
                            // because if it fails, debouncer will trigger a restart
                        }
                    } else if (msg.type === 'ice-candidate') {
                        // Delivery will be cancelledd by debouncer in unstable state.
                        // In stable state ice candidates need a timeout, because  
                        // hanging case likely means this candidate is not important.
                        msg.neg_id = negs.currentId; // assign current id to ice candidates, because they might be sent after answer is sent
                        await rustSelect([
                            sleep(5000).then(async () => {
                                // log and record a metric.
                                rBreak();
                            }),
                            this.wsConnector.send({...msg, type: 'ice-candidate-guest'}).catch(() => {
                                // log and record a metric.
                            }),
                        ]);
                    } else if (msg.type === 'ice-candidate-guest') {
                        await rtcPeerCon.addIceCandidate(msg.sdp).catch(() => {
                            // log and record a metric.
                        });
                    } else if (msg.type === 'offer') {
                        // was here just to update last id
                    }
                }
            }
        });
    }
}
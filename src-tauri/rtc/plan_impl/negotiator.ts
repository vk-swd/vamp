


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

enum DebounceEvents {
    IceConnected,
    IceDisconnected,
    SignallingStable,
    SignallingUnstable,
    ResetTimer
}
type DebounceEvent = {
    connection?: DebounceEvents.IceConnected | DebounceEvents.IceDisconnected,
    signalling?: DebounceEvents.SignallingStable | DebounceEvents.SignallingUnstable,
    resetTimer?: DebounceEvents.ResetTimer
}
class IceRestartDebouncer {
    eventQueue = new SpMcQueue<DebounceEvent>();
    // debounceRequest = new SpMcQueue<number>();
    stopper: CancelToken = new CancelToken();
    finishHandle: JoinHandle<void> | undefined = undefined;
    debState: DebounceEvent = {
        connection: DebounceEvents.IceDisconnected,
        signalling: DebounceEvents.SignallingUnstable,
    };
    constructor() {
        // make idiomatic rust debouncer here
        // which would allow me to work with it using interface I layed out here.
    }
    async stop() {
        this.stopper.cancel();
        return Promise.resolve();
    }
    registerEvent(event: DebounceEvent): Promise<void> {
        return this.eventQueue.tx.send(event).catch(() => {
            // log and record a metric. This should not happen, but if it does, ignore the event.
        });
    }
    async reset() {
        if (!this.finishHandle) {
            return;
        }
        await this.finishHandle;
        this.finishHandle = undefined;
    }
    run() {
        if (this.finishHandle) {
            return;
        }
        this.finishHandle = rustSpawn(async () => {
            const eventPoll = async (queueCons: MpScQueueStreamConsumer<DebounceEvent>, sigState: DebounceEvent): Promise<DebounceEvent> => {
                return queueCons.next().then((event: DebounceEvent) => {
                    if (event.connection) {
                        sigState.connection = event.connection;
                    }
                    if (event.signalling) {
                        sigState.signalling = event.signalling;
                    }
                    if (event.resetTimer) {
                        // log and record a metric. This should not happen, but if it does, ignore the event.
                    }
                    return event
                }).catch(() => {
                    // log and record a metric.
                    return {};
                });
            }
            while (1) {
                if (this.debState.connection === DebounceEvents.IceConnected && this.debState.signalling === DebounceEvents.SignallingStable) {
                    await rustSelect([
                        // biased
                        eventPoll(this.eventQueue.rx, this.debState),
                        this.stopper.cancelled().then(async () => {
                            rBreak();
                        }).catch(async () => {
                            // This should not happen, but add a log and metric here and retry after a timeout
                        }),
                    ]);
                } else {

                    const timedEventPoll = async (queueCons: MpScQueueStreamConsumer<DebounceEvent>, sigState: DebounceEvent) =>{
                        while (1) {
                            if (sigState.connection === DebounceEvents.IceConnected && sigState.signalling === DebounceEvents.SignallingStable) {
                                break;
                                // land on the untimed version to just poll events
                            } else {
                                await eventPoll(queueCons, sigState).then(async (event: DebounceEvent) => {
                                    if (event.resetTimer) {
                                        // Break and restart external timed await.
                                        // sigState will be used to signal that no debounce needed
                                        rBreak();
                                    }
                                })
                            }
                        }
                    }
                    await rustSelect([
                        // biased
                        timedEventPoll(this.eventQueue.rx, this.debState),
                        sleep(5000).then(async () => {
                            // log and record a metric. This means previous negotiation took too long and will be restarted.
                            rBreak();
                        }),
                        this.stopper.cancelled().then(async () => {
                            rBreak();
                        })
                    ]);
                }
            }
        });
    }
    waitForDebounce(): JoinHandle<void> {
        this.run();
        return this.finishHandle!;
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
    restartIce(remoteSdp?: string, neg_id: string): Promise<SignalMsg> {
        if (remoteSdp) {
            //check for rollback and make rollback where necessary
            // set remote sdp
            // create answer
            // set local sdp
            const localSdp = "local_sdp"; // generate local sdp here
            return Promise.resolve({ type: 'answer', sdp: localSdp, neg_id });
        } else {
            //check for rollback and make rollback where necessary
            const localOffer = "local_sdp"; // create offer
            this.setLocalDescription(localOffer);
            const localSdp = "local_sdp"; // get local description
            return Promise.resolve({ type: 'offer', sdp: localSdp, neg_id });
        }
        this.currentNegotiationId.increment();
        if (this.scheduledRemoteSdp) {

        }
        
        const newSdp = this.scheduledRemoteSdp ? this.scheduledRemoteSdp : "new_sdp"; // generate new sdp here
        await this.setLocalDescription(newSdp);
        const answer = await this.getAnswer();
        // make necessary steps - 
        this.needsRestart = false;
        return Promise.resolve(answer);
    }
    setOffer(offer: string): Promise<void> {
        return Promise.resolve();
    }
    setAnswer(answer: string): Promise<void> {
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
    lastId: string // use it to assign to empty neg ids (local ice candidates)
    constructor(initialId: string) {
        this.currentId = initialId;
        this.lastId = initialId;
    }

}
class Negotiator {
    wsConnector: WsConnector;
    incomingMsgQueue: SpMcQueue<SignalMsg>;
    incomingOfferQueue: SpMcQueue<SignalMsg>;
    runHandle: JoinHandle<void>;
    iceRestartDebouncer: IceRestartDebouncer = new IceRestartDebouncer();
    constructor(url: string, rttTag: string) {
        this.incomingMsgQueue = new SpMcQueue<SignalMsg>();
        this.incomingOfferQueue = new SpMcQueue<SignalMsg>();
        this.wsConnector = new WsConnector(
            url, rttTag, async (msg: SignalMsg) => {
                if (msg.type === 'offer') {
                    await this.incomingOfferQueue.tx.send(msg).catch(() => {
                        // log and record metric.
                    }); 
                } else {
                    await this.incomingMsgQueue.tx.send(msg).catch(() => {
                        // log and record metric.
                    });
                }
            }
        );
        this.runHandle = this.run();
    }
    async run() {
        return rustSpawn(async () => {
            const rtcPeerCon = new RtcConnectionHandler();
            rtcPeerCon.onIceCandidate(async (candidate) => {
                await  this.incomingMsgQueue.tx.try_send({ type: 'ice-candidate', sdp: candidate, neg_id: rtcPeerCon.currentNegotiationId.load().toFixed() }).catch(() => {
                    // log and record metric.
                });
            });
            rtcPeerCon.onIceStateChange((state) => {
                if (state === 'failed' || state === 'disconnected') {
                    this.iceRestartDebouncer.registerEvent({ connection: DebounceEvents.IceDisconnected }).catch(() => {
                        // log and record a metric. This should not happen, but if it does, ignore the event.
                    });
                }
                if (state === 'connected' || state === 'completed') {
                    this.iceRestartDebouncer.registerEvent({ connection: DebounceEvents.IceConnected }).catch(() => {
                        // log and record a metric. This should not happen, but if it does, ignore the event.
                    });
                }
            });
            let negs = new NegSessionIds(rtcPeerCon.negotiationId());
            
            
            async function wakeToRemoteOffer(offerQueueRx: MpScQueueStreamConsumer<SignalMsg>, negs: NegSessionIds, peerCon: RtcConnectionHandler, debouncer: IceRestartDebouncer): Promise<void> {
                return offerQueueRx.next().then(async (msg: SignalMsg) => {
                    // new offer came, stop current negotiation and start a new one 
                    if (negs.currentId == msg.neg_id) {
                        // log and record a metric. Ignore the message.
                        // This is unexpected.
                        return;
                    }
                    debouncer.registerEvent({ resetTimer: DebounceEvents.ResetTimer });
                    negs.currentId = msg.neg_id;
                    peerCon.setForRestart(msg.sdp);
                }).catch(async () => {
                    // This should not happen, but add a log and metric here and retry after a timeout
                })
            }
            async function maybeRestartIce(peerCon: RtcConnectionHandler, wsConnector: WsConnector): Promise<void> {
                return peerCon.maybeRestartIce().then(async (answer?: String) => {
                    // send the sdp if there is one
                }).catch(async () => {
                    // log and metric
                    // sleep for 1 sec
                });
            }
            enum SelectEvents {
                RemoteOffer,
                IceRestart,
                DebouncerTimeout,
                IncomingMsg,
                Error
            }
            type SelectEvent = {
                type: SelectEvents.RemoteOffer | SelectEvents.IceRestart | SelectEvents.DebouncerTimeout | SelectEvents.IncomingMsg | SelectEvents.Error,
                data?: any
            }
            const getEvent = async (offerQueueRx: MpScQueueStreamConsumer<SignalMsg>,
                debouncer: IceRestartDebouncer,
                incomingMsgQueueRx: MpScQueueStreamConsumer<SignalMsg>
            ): Promise<SelectEvent> => {
                const res = rustSelect<SelectEvent>([
                    // biased
                    offerQueueRx.next().then((msg: SignalMsg) => ({ type: SelectEvents.RemoteOffer, data: msg })).catch(() => ({ type: SelectEvents.Error, data: "E1" })),
                    debouncer.waitForDebounce().then(() => ({ type: SelectEvents.DebouncerTimeout, data: "" })).catch(() => ({ type: SelectEvents.Error, data: "E2" })),
                    incomingMsgQueueRx.next().then((msg: SignalMsg) => ({ type: SelectEvents.IncomingMsg, data: msg })).catch(() => ({ type: SelectEvents.Error, data: "E3" })),
                ]);
                return res;
            }
            while (1) {
                const event: SelectEvent = await getEvent(this.incomingOfferQueue.rx, this.iceRestartDebouncer, this.incomingMsgQueue.rx);
                if (event.type === SelectEvents.Error) {
                    // log and record a metric.
                    continue;
                }
                if (event.type === SelectEvents.RemoteOffer) {
                    const msg: SignalMsg = event.data;
                rustSelect([
                    // biased
                    wakeToRemoteOffer(this.incomingOfferQueue.rx, negs, rtcPeerCon, this.iceRestartDebouncer),
                    maybeRestartIce(rtcPeerCon, this.wsConnector),
                    this.iceRestartDebouncer.waitForDebounce().then(async () => {
                        rtcPeerCon.setForRestart();
                        rtcPeerCon.updateCurrentNegotiationId();
                        negs.currentId = rtcPeerCon.negotiationId();
                        this.iceRestartDebouncer.reset().catch(() => {
                            // log and record a metric
                        });
                        fContinue(); // restart on next iteration
                    }).catch(async () => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                    }),
                    this.incomingMsgQueue.rx.next().then(async (msg: SignalMsg) => {
                        if (msg.type !== 'ice-candidate') {
                            negs.lastId = msg.neg_id;
                            if (negs.lastId !== negs.currentId) {
                                // log and record a metric. Ignore the message.
                                return;
                            }
                        }
                        // After applying offer or answer check if stabble state is achieved
                        // If it was, then if connection achieved, then stop debouncer
                        if (msg.type === 'answer') {
                            await rtcPeerCon.setAnswer(msg.sdp).catch(() => {
                                // log and record a metric.
                                // should be safe to ignore failed attempt too
                            });
                        } else if (msg.type === 'ice-candidate') {
                            // Delivery will be cancelledd by debouncer in unstable state.
                            // In stable state ice candidates need a timeout, because  
                            // hanging case likely means this candidate is not important.
                            msg.neg_id = negs.lastId; // assign last id to ice candidates, because they might be sent after answer is sent
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
                    }).catch(async () => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                    }),
                ]);


            }
        });
    }
}
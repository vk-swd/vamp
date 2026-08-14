


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
    conState = DebounceEvents.IceDisconnected;
    sigState = DebounceEvents.SignallingUnstable;
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
            while (1) {
                if (this.conState === DebounceEvents.IceConnected && this.sigState === DebounceEvents.SignallingStable) {
                    await rustSelect([
                        // biased
                        this.eventQueue.rx.next().then(async (event: DebounceEvent) => {
                            // log and record a metric.
                            if (event.connection) {
                                this.conState = event.connection;
                            }
                            if (event.signalling) {
                                this.sigState = event.signalling;
                            }
                            fContinue();
                        }).catch(async () => {
                            // This should not happen, but add a log and metric here and retry after a timeout
                        }),
                        this.stopper.cancelled().then(async () => {
                            rBreak();
                        }).catch(async () => {
                            // This should not happen, but add a log and metric here and retry after a timeout
                        }),
                    ]);
                } else {
                    const timedEventPoll = async () =>{
                        while (1) {
                            if (this.conState === DebounceEvents.IceConnected && this.sigState === DebounceEvents.SignallingStable) {
                                break;
                            } else {
                                await this.eventQueue.rx.next().then(async (event: DebounceEvent) => {
                                    // log and record a metric.
                                    if (event.connection) {
                                        this.conState = event.connection;
                                    }
                                    if (event.signalling) {
                                        this.sigState = event.signalling;
                                    }
                                    if (event.resetTimer) {
                                        // Break and restart external timed await.
                                        rBreak();
                                    }
                                    fContinue();
                                }).catch(async () => {
                                    // This should not happen, but add a log and metric here and retry after a timeout
                                });
                            }
                        }
                    }
                    await rustSelect([
                        // biased
                        timedEventPoll().then(async () => {
                            fContinue();
                        }).catch(async () => {
                            // This should not happen, but add a log and metric here and retry after a timeout
                        }),
                        sleep(5000).then(async () => {
                            // log and record a metric. This means previous negotiation took too long and will be restarted.
                            rBreak();
                        }),
                        this.stopper.cancelled().then(async () => {
                            rBreak();
                        }).catch(async () => {
                            // This should not happen, but add a log and metric here and retry after a timeout
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
    constructor() {
        // log events such as on_negotiation_needed and on signal state changed
    }
    // dont nullify on stable state and stopped gathering  
    // because other peer might still send candidates
    currentNegotiationId = new Atomic(); 
    needsRestart = true;
    scheduledRemoteSdp: string | undefined = undefined;
    maybeRestartIce(): Promise<void> {
        if (!this.needsRestart && !this.scheduledRemoteSdp) {
            return Promise.resolve();
        }
        this.currentNegotiationId.increment();
        const newSdp = this.scheduledRemoteSdp ? this.scheduledRemoteSdp : "new_sdp"; // generate new sdp here
        // make necessary steps - 
        this.needsRestart = false;
        return Promise.resolve();
    }
    setForRestart(remoteSdp?: string) {
        this.needsRestart = true;
        this.scheduledRemoteSdp = remoteSdp;
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
            while (1) {
                rtcPeerCon.maybeRestartIce().catch(() => {
                    // log and metric
                    // sleep for 1 sec
                    fContinue();
                });
                rustSelect([
                    // biased
                    this.incomingOfferQueue.rx.next().then(async (msg: SignalMsg) => {
                        // new offer came, stop current negotiation and start a new one 
                        if (rtcPeerCon.currentNegotiationId.load().toFixed() == msg.neg_id) {
                            // log and record a metric. Ignore the message.
                            // This is unexpected.
                            return;
                        }
                        rtcPeerCon.currentNegotiationId.store(Number(msg.neg_id));
                        rtcPeerCon.setForRestart(msg.sdp);
                        fContinue(); // restart on next iteration
                    }).catch(async () => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                    }),
                    this.iceRestartDebouncer.waitForDebounce().then(async () => {
                        // log and record a metric.
                        // This means previous negotiation took too long and will be restarted.
                        rtcPeerCon.setForRestart();
                        this.iceRestartDebouncer.reset().catch(() => {
                            // log and record a metric
                        });
                        fContinue(); // restart on next iteration
                        // restart ice to start gathering
                        // make new offer and add it to the offer queue to start the negotiation.
                    }).catch(async () => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                    }),
                    this.incomingMsgQueue.rx.next().then(async (msg: SignalMsg) => {
                        if (msg.neg_id !== rtcPeerCon.currentNegotiationId.load().toFixed()) {
                            // log and record a metric. Ignore the message.
                            return;
                        }
                        // After applying offer or answer check if stabble state is achieved
                        // If it was, then if connection achieved, then stop debouncer
                        if (msg.type === 'answer') {
                            await rtcPeerCon.setAnswer(msg.sdp).catch(() => {
                                // log and record a metric.
                            });
                        } else if (msg.type === 'ice-candidate') {
                            // Delivery will be cancelledd by debouncer or hang here
                            // if signalling is stable and connection does not change.
                            // For Ice candidates added a timeout, because hanging case 
                            // likely means this candidate is not important.
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
                        } else {
                            // log and record a metric. Ignore the message.
                        }
                    }).catch(async () => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                    }),
                ]);
            }
        });
    }
}
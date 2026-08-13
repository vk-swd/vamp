


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

class IceRestartDebouncer {
    // iceRestartQueue = new SpMcQueue<number>();
    // debounceRequest = new SpMcQueue<number>();
    // stopper: CancelToken = new CancelToken();
    constructor() {
        // make idiomatic rust debouncer here
        // which would allow me to work with it using interface I layed out here.
    }
    async stop() {
        return Promise.resolve();
    }
    stopDebounce(): Promise<void> {
        return Promise.resolve();
    }
    waitForDebounce(): Promise<void> {
        return Promise.resolve();
    }
    startDebounce(): Promise<void> {
        return Promise.resolve();
    }
}

class RtcConnectionHandler {
    constructor() {
        // log events such as on_negotiation_needed and on signal state changed
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
            let currentNegotiationId: string | undefined = undefined;
            while (1) {
                rustSelect([
                    // biased
                    this.iceRestartDebouncer.waitForDebounce().then(async () => {
                        // log and record a metric.
                        // This means previous negotiation took too long and will be restarted.
                        currentNegotiationId = undefined;
                        // make new offer and add it to the offer queue to start the negotiation.
                    }).catch(async () => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                    }),
                    this.incomingOfferQueue.rx.next().then(async (msg: SignalMsg) => {
                        // new offer came, stop current negotiation and start a new one 
                        if (currentNegotiationId == msg.neg_id) {
                            // log and record a metric. Ignore the message.
                            // This is unexpected.
                            return;
                        }
                        await this.iceRestartDebouncer.startDebounce();
                        currentNegotiationId = msg.neg_id;
                        // start negotiation that will be cancelled by new incoming offer
                    }).catch(async () => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                    }),
                    this.incomingMsgQueue.rx.next().then(async (msg: SignalMsg) => {
                        if (msg.neg_id !==currentNegotiationId) {
                            // log and record a metric. Ignore the message.
                            return;
                        }
                    }).catch(async () => {
                        // This should not happen, but add a log and metric here and retry after a timeout
                    }),
                ]);
            }
        });
    }
}





function send_ack(send_q: MpScQueueStreamProducer<Ack>, msg: NormalMsg): void {
    send_q.try_send({type: 'ack', sn: msg.sn, node_id: msg.node_id}).catch(() => {
        // can't send the message (buffer full or somehting else) to ws - restart connection
    });
    // Don't wait for acks on acks
    // Lost ack = deliver retry
}
class SNFilter {
    last_sn: number | undefined = undefined;
    node_id: string | undefined = undefined;
    next(msg: NormalMsg): boolean {
        if (this.node_id === undefined || this.last_sn === undefined) {
            this.node_id = msg.node_id;
            this.last_sn = msg.sn;
            return true;
        }
        if (this.node_id !== msg.node_id) {
            // should be impossible - log and record a metric
            return false;
        }
        if (msg.sn <= this.last_sn) {
            // log and record a metric
            return false;
        }
        this.last_sn = msg.sn;
        return true;
    }
}


function startReceiveTask(
    wsStreamIn: MpScQueueStreamConsumer<string>,
    stopper: CancelToken,
    receiptHandler: (msg: SignalMsg) => Promise<void>,
    snFilter: SNFilter,
    ackQ: MpScQueueStreamProducer<Ack>,
    sendQ: MpScQueueStreamProducer<TransportMsg>,
): JoinHandle<void> {
    return rustSpawn(async () => {
        while (1) {
            await rustSelect([
                stopper.cancelled().then(() =>  rBreak() ),
                wsStreamIn.next().then(async (msgRaw: string) => {
                    const wireMsg = toTransport(msgRaw);
                    if (!wireMsg.message) return;
                    const tMsg = wireMsg.message;
                    if (tMsg.type === 'normal') {
                        send_ack(sendQ, tMsg); // send_ack(t_msg.id, t_msg.seq_num)
                        if (snFilter.next(tMsg)) {
                            await receiptHandler(tMsg.payload).catch(() => {
                                // ignore_error()
                            });
                        }
                    } else {
                        await ackQ.send(tMsg).catch(() => {
                            // log and record metric. Normally it should not happen
                            // but if nobody drains acks, it might happen.
                        });
                    }
                }).catch(() => {
                    // dont reset connection, it will be restarted from outside
                    rBreak();
                }),
            ]);
        }
    });
}
function toWireMsg(rttTag: string, msg: TransportMsg): string {
    return JSON.stringify({ tag: rttTag, message: msg });
}
function startSenderTask(
    tx: MpScQueueStreamProducer<string>,
    sendQRx: MpScQueueStreamConsumer<TransportMsg>,
    stopper: CancelToken,
    rttTag: string = "default"
): JoinHandle<MpScQueueStreamConsumer<TransportMsg>> {
    return rustSpawn(async () => {
        while (1) {
            await rustSelect([
                stopper.cancelled().then(() =>  rBreak() ),
                sendQRx.next().then(async (msg) => {
                    await tx.send(toWireMsg(rttTag, msg)).catch(async () => {
                        // This means ws is broken, needs restart
                        // Stop the task and restart will be done from outside
                        rBreak();
                    });
                }).catch(async () => {
                    // This should not happen, but add a log and metric here and retry after a timeout
                    // Normally it would mean someone cancelled ws connection and stopper will be triggered
                }),
            ]);
        }
        return sendQRx;
    });
}

function move<T>(item: T): T {
    // Placeholder for rust move semantics.
    return item;
}


class WsConnector {
    private asyncRunner: JoinHandle<void>;
    private ackQ = new SpMcQueue<Ack>();
    private sendQTx: MpScQueueStreamProducer<TransportMsg>;
    private stopper = new CancelToken(); // To stop async tasks
    private seqNumOut = 0;
    private nodeIdOut = crypto.randomUUID();

    constructor(
        private url: string,
        public rttTag: string,
        private receiptHandler: (msg: SignalMsg) => Promise<void>,
        private connectionFactory: (url: string) => Promise<SpMcQueue<string>> = openWS // for testing, can be overridden to use a mock connection
    ) {
        const sendQ = new SpMcQueue<TransportMsg>();
        this.sendQTx = sendQ.tx;
        this.asyncRunner = rustSpawn(async () => {
            await this.asyncRun(move(sendQ.rx));
        });
    }

    async asyncRun(sendQRx: MpScQueueStreamConsumer<TransportMsg>): Promise<void> {
        //make it static and return the handle
        const snFilter = new SNFilter();
        while (1) {
            const localStopper = new CancelToken();
            const { rx, tx } = await this.connectionFactory(this.url);
            const receiveHandle = startReceiveTask(
                rx, localStopper, this.receiptHandler,
                snFilter, this.ackQ.tx, this.sendQTx,
            );
            const senderHandle = startSenderTask(tx, move(sendQRx), localStopper, this.rttTag);

            await rustSelect([
                this.stopper.cancelled().then(async () => {
                    localStopper.cancel();
                    await receiveHandle;
                    await senderHandle;
                    rBreak();
                }),
                receiveHandle.then(async () => {
                    // likely some error occurred needing reconnection
                    localStopper.cancel();
                    await senderHandle;
                }),
                senderHandle.then(async () => {
                    // likely some error occurred needing reconnection
                    localStopper.cancel();
                    await receiveHandle;
                }),
            ]);
            sendQRx = move(await senderHandle);
            // TODO: add a metric for connection restarts
        }
    }

    stop(): Promise<void> {
        this.stopper.cancel();
        return this.asyncRunner;
    }

    private async sendAndWaitAck(msgOut: TransportMsg): Promise<void> {
        // Not thread safe - ack queue can only be polled by a single task at a time
        // Cancellable from outside
        await this.sendQTx.send(msgOut).catch((err) => {
            // Should not happen, because msgs are sent one at a time
            // Log and record metric just in case
        });
        while (true) {
            // Cancelled by caller
            this.ackQ.rx.next().then((ack) => {
                if (ack.sn === msgOut.sn) {
                    fReturn();
                }
            }).catch((err) => {
                // Should not happen, because ack queue is never closed
                // Log and record metric just in case
            })
        }
    }

    private async sendAndWaitAckRepeated(msgOut: TransportMsg): Promise<void> {
        while (true) {
            await rustSelect([
                sleep(6000).then(() => {}),
                this.sendAndWaitAck(msgOut).then(() => { 
                    fReturn(); 
                }),
            ]);
        }
    }

    async send(msg: SignalMsg): Promise<void> {
        // If cancelled, should not have leftover state:
        // send_q will be emptied by sender task.
        // might lose some acks, but not needed if send is cancelled.
        const sn = this.seqNumOut++;
        const msgOut: TransportMsg = { type: "normal", sn, node_id: this.nodeIdOut, payload: msg };

        // Cancelled by caller, dont check for stopper.
        await this.sendAndWaitAckRepeated(msgOut);
    }
}

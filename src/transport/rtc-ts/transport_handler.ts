
import { TransportMsg } from '../generatedTypes';
// import { AbortSignal } from 'web-globals';



export interface TransportCodec<TransportedType, CarrierType> {
    encode(msg: TransportMsg<TransportedType>): CarrierType;
    decode(frame: CarrierType): TransportMsg<TransportedType> | undefined;
}


class SnFilter {
    #nodeId: string | undefined = undefined;
    #lastSn: number | undefined = undefined;

    accept(nodeId: string, sn: number): boolean {
        if (this.#nodeId === undefined || this.#lastSn === undefined) {
            this.#nodeId = nodeId;
            this.#lastSn = sn;
            return true;
        }
        if (this.#nodeId !== nodeId) {
            console.warn('[rtc] dropping message from unexpected node', nodeId);
            return false;
        }
        if (sn <= this.#lastSn) {
            console.debug('[rtc] dropping stale message', sn);
            return false;
        }
        this.#lastSn = sn;
        return true;
    }
}

export class TransportHandler<CarrierType, TransportedType> {
    awaited_delivery: { sn: number, resend_task: Promise<void>, resolve_fn: () => void } | undefined = undefined;
    last_sent_sn: number | undefined = undefined;
    seq_num_out: number = 0;
    node_id_out: string = crypto.randomUUID();
    signal = new AbortController();
    sn_filter = new SnFilter();
    constructor(private sender: (payload: TransportMsg<TransportedType>) => void,
                private handler: (payload: TransportedType) => void) {
    }
    stop() {
        this.signal.abort();
    }

    handle_incoming(msg: TransportMsg<TransportedType>) {
        if (msg.type === 'ack') {
            if (this.awaited_delivery && this.awaited_delivery.sn === msg.sn) {
                this.awaited_delivery.resolve_fn();
                this.awaited_delivery = undefined;
            }
        } else if (msg.type === 'normal') {
            const ack_msg: TransportMsg<TransportedType> = { type: 'ack', sn: msg.sn, node_id: this.node_id_out };
            try {
                this.sender(ack_msg);
            } catch (e) {
                // log and add metric
            }
            if (!this.sn_filter.accept(msg.node_id, msg.sn)) {
                return;
            }
            this.handler(msg.payload);
        }
    }

    async #send_and_wait_ack_repeated(msg: TransportMsg<TransportedType>, sn: number, timeout: number) {
        if (this.awaited_delivery) {
            return Promise.reject(new Error('send already in progress'));
        }
        let resolve_fn: () => void = () => {};
        const resend_task = new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            resolve_fn = () => {
                settle();
            };
            const cleanup = () => {
                if (timer !== undefined) clearTimeout(timer);
                this.awaited_delivery = undefined;
                this.signal.signal.removeEventListener('abort', onAbort);
            };
            const settle = (err?: Error) => {
                cleanup();
                if (err) reject(err);
                else resolve();
            };
            const onAbort = () => settle(new Error('send aborted'));
            const resend = () => {
                if (timer !== undefined) clearTimeout(timer);
                try {
                    this.sender(msg);
                } catch (e) {
                    // log and add metric
                }
                timer = setTimeout(resend, timeout);
            };
            this.signal.signal.addEventListener('abort', onAbort, { once: true });
            resend();
        });
        this.awaited_delivery = { sn, resend_task, resolve_fn };
        return resend_task;
    }

    /// Reliably deliver a signalling message to the other peer, retrying
    /// until acknowledged (see memo.md "Ack messages" / "Delivery retries").
    /// `timeout` controls how long to wait for an ack before retrying
    /// (defaults to 6s via [`WsNodeHandler::send_default`]).
    async send(payload: TransportedType, timeout: number): Promise<void> {
        if (this.awaited_delivery) {
            return Promise.reject(new Error('send already in progress'));
        }
        if (this.signal.signal.aborted) {
            return Promise.reject(new Error('send aborted'));
        }
        this.seq_num_out++;
        const sn = this.seq_num_out;
        let msg: TransportMsg<TransportedType> = { type: 'normal', sn, node_id: this.node_id_out, payload };
        return this.#send_and_wait_ack_repeated(msg, sn, timeout);
    }
    async send_raw(payload: TransportMsg<TransportedType>): Promise<void> {
        try {
            this.sender(payload);
        } catch (e) {
            // log and record metric
        }
    }
}
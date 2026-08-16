/**
 * This is a pseudocode for rust logic
 * It does not capture memory ownership semantics or other syntax.
 * But it shows the logic while maintaining the layout
 *  so that remaining plumbing could be inferred by ai from context.
 */

// rBreak and fContinue are placeholders for the rust control flow keywords inside 
// "match" and "select" blocks.
export function rBreak() {}
export function fContinue() {}
export function fReturn() {}
export function rustSelect<T>(promises: Promise<any>[]): Promise<T> {
    // Placeholder implementation used for pseudocode.
    return Promise.resolve() as Promise<T>;
}
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export type JoinHandle<T> = Promise<T>;

export function rustSpawn<T>(f: () => Promise<T>): JoinHandle<T> {
    return f();
}
export class MpScQueueStreamProducer<T> {
    send(item: T): Promise<void> {
        return Promise.resolve();
    }
    try_send(item: T): Promise<void> {
        return Promise.resolve();
    }
}

export class Notifyer {
    notify_one() {

    }
    notified(): Promise<void> {
        return Promise.resolve();
    }
}
export class MpScQueueStreamConsumer<T> {
    next(): Promise<T> {
        return Promise.resolve({} as T);
    }
}

export class SpMcQueue<T> {
    tx = new MpScQueueStreamProducer<T>();
    rx = new MpScQueueStreamConsumer<T>();
}

type WireMessages = {
    tag: string;
    message?: TransportMsg;
};

type SnMsg = {
    sn: number;
    node_id: string;
};
type Ack = { type: 'ack' } & SnMsg;
type NormalMsg = { type: 'normal' } & SnMsg & { payload: SignalMsg };
type TransportMsg = Ack | NormalMsg;

export class CancelToken {
    cancel(): void {}
    cancelled(): Promise<void> { return Promise.resolve(); }
}

export type SignalMsg = { type: 'offer' | 'answer' | 'ice-candidate' | 'ice-candidate-guest', sdp: string, neg_id: string };
function openWS(url: string): Promise<SpMcQueue<string>> {
    return Promise.resolve(new SpMcQueue<string>());
}

function toTransport(msgRaw: string): WireMessages {
    // Serde emulator
    return JSON.parse(msgRaw) as WireMessages;
}





/**
 * Keeps one communication channel alive.
 *
 * Equivalent of `Node<T>` / `WsNode<T>` in `src-tauri/rtc/ws_node.rs`: 
 * it maintains a communication channel open by doing reconnects if delivery fails
 * 
 * T is message type carried by the channel.
 * Node does not parse T, it passes it to the handler provided by the owner.
 * Delivery is deliberately not tracked here — that is the transport handler's job.
 */

export interface Connector<T> {
    send(frame: T): void; //throws
    close(): void;
    state(): NodeState;
}

export enum NodeState {
    Connecting,
    Connected,
    Closing,
    Closed
}

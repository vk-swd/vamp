import { Connector, NodeState } from './connector';

type ValueRef<T> = { value: T };

export class WsSignallingConnector implements Connector<String> {
    #ws: WebSocket | undefined = undefined;
    #state: ValueRef<NodeState> = { value: NodeState.Connecting };
    #restartTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    #currentConnectionId: number = 0; // crutch to filter out stale signalse in case they are possible
    constructor(private readonly url: string, 
        private readonly registrationFrame: string,
        private messageHandler: (frame: string) => void) {
        this.restartWs();
    }

    send(frame: string): void {
        if (!this.#ws || this.#state.value !== NodeState.Connected) {
            throw new Error('ws not ready');
        }
        // send might throw, but we don't do anything here, all reconnection is set up
        // when the ws was created.
        this.#ws.send(frame);
    }

    close(): void {
        this.closeInternal();
    }

    state(): NodeState {
        return this.#state.value;
    }
    closeInternal(): void {
        const newState =  { value: NodeState.Closed };
        this.#state = newState;
        this.#currentConnectionId++;
        if (this.#ws) {
            this.#ws.onclose = null;
            this.#ws.onerror = null;
            this.#ws.onopen = null;
            this.#ws.onmessage = null;
            this.#ws.close();
            this.#ws = undefined;            
        }
    }
    restartWs(): void {
        this.closeInternal();
        if (this.#restartTimer) {
            clearTimeout(this.#restartTimer);
            this.#restartTimer = undefined;
        }
        const newState =  { value: NodeState.Connecting };
        this.#state = newState;
        this.#currentConnectionId++;
        const connectionId = this.#currentConnectionId;

        const ws = new WebSocket(this.url);
        ws.onopen = () => {
            newState.value = NodeState.Connected;
            ws.send(this.registrationFrame);
        };
        ws.onmessage = (event) => {
            this.messageHandler(event.data);
        };
        ws.onerror = (event) => {
            console.debug('[rtc] ws error', event);
        };
        ws.onclose = (event) => {
            // Can be closed by any participant:https://www.rfc-editor.org/info/rfc6455/#section-7.1.6
            if (connectionId !== this.#currentConnectionId) {
                return;
            }
            newState.value = NodeState.Closed;
            this.#restartTimer = setTimeout(() => {
                this.#restartTimer = undefined;
                this.restartWs();
            }, 1000);
        };
        this.#ws = ws;
    }
}





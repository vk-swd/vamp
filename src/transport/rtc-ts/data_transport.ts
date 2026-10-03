import { RtcConnector } from "./connectors/rtc_connector";
import { TransportHandler } from "./transport_handler";
import { TransportMsg } from "../generatedTypes";
/** 
 * Test if after reloading page it is still trying to send messages.
 * 
 * some requests need response and i need another message wrapping layer tracking that
 * 
 * need to use RemoteResponse and RemoteRequest on top of transport - transport part ensures
 * 
 * underlying type delivery, so it is transport<RemoteRequest, RemoteResponse>
 * 
 * on the backend i would need to make an automatic responder in the same way i made a 
 * ws server that accepts requests, processes them and sends responses to the 
 * requestor
 * 
 * this will live next to the rtc connector
 * 
 * and the same thing will need to exist in the browser
 */
// type TransportedMsg = DataTransportMessage<unknown>;
export class DataTransport<TransportedMsg> {
    private readonly dcTransportHandler: TransportHandler<TransportedMsg>;
    private readonly rtcConnector: RtcConnector;
    private handler: ((payload: TransportedMsg) => void) | undefined = undefined;
    private payloadQueue: TransportedMsg[] = [];
    constructor(
        tag: string,
        channelName: string,
        ssUrl: string,
        config: { iceServers: RTCIceServer[] }
    ) {
        const sender: (payload: TransportMsg<TransportedMsg>) => void = (payload) => {
            const frame = JSON.stringify(payload);
            this.rtcConnector.send(frame);
        };
        this.dcTransportHandler = new TransportHandler<TransportedMsg>(sender, (payload) => {
            if (this.payloadQueue.length > 0 || !this.handler) {
                // if handler ever becomes async
                this.payloadQueue.push(payload);
            } else {
                this.handler(payload);
            }
        });
        
        const rtcMsgHandler: (frame: string) => void = (frame) => {
            try {
                const dcMsg = JSON.parse(frame) as TransportMsg<TransportedMsg>;
                this.dcTransportHandler.handle_incoming(dcMsg);
            } catch (error) {
                console.error("Failed to handle RTC message:", frame, "error:", error);
            }
        };
        this.rtcConnector = new RtcConnector(tag, channelName, ssUrl, config, rtcMsgHandler);
    }
    setMessageHandler(handler: (payload: TransportedMsg) => void): void {
        this.handler = handler;
        while (this.payloadQueue.length > 0) {
            const payload = this.payloadQueue.shift()!;
            this.handler(payload);
        }
    }
    send(msg: TransportedMsg, signal?: AbortSignal): Promise<void> {
        const res = this.dcTransportHandler.send(msg, 3000);
        if (signal) {
            signal.addEventListener("abort", () => {
                res.abort_controller?.abort();
            });
        }
        return res.resend_task
    }

    close(): void {
        this.dcTransportHandler.stop();
        this.rtcConnector.close();
    }
}

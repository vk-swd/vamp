

RtcConnector

* This is a TypeScript implementation of `RtcConnector` in `src-tauri/rtc/rtc_connector.rs`, with one difference: this side is the initiator: it sends offers and initiates ICE restarts.
    * To easier navigate the state modified by async operations, state enums are defined, to reflect how those areconnected.

* The following changes are made as compared to Rust implementation:
    1. Unlike [Rust](../../../src-tauri/rtc/memo.md#node), TypeScript version does not initiate reconnection.
    2. Because events and object lifetimes are tied to a single thread, there is no need to serialise operations as state changes to avoid data races.
    >Note:
    >State variables reflect the last processed event, not real-time system state — a socket can be closed/errored at the system level before the corresponding JS callback has run, so checking a state variable can yield a stale positive.
    3. RtcConnector holds potentially many DataChannel handles. Each handle is a dedicateed Node - Transport - DC bundle. Reconnection is a linear process - disconnect -> wait -> reconnect. RtcConnector holds a list of datachannels and if any of those are closed or missing the delivery will just stall.
        3. Client ignores incoming datachannels, it just creates it sown. 
        4. keep datachannel alive, 
            5. recreate it if it closes
            6. restart ice
            7. recreates rtcpeer connection if everything goes south 
        Given the specifics of typescript single threaded command dispatch
        some complications may arise during connectivity state transitions:

        ```mermaid
        sequenceDiagram
        participant ps as RtcPeerConnection<bt>Sending
        participant p as RtcPeerConnection<br>Idle
        participant dc as RtcDataChannel
        participant t as Debounce Timer


        ```


        ok i am gettings somewhere...i realised that after i get out of any async task there could be a lot of things sequenced in the same operation flows...so some form of queuing is inevitable - you cant start sending a candidate or and offer and then when you are done waiting assume that the sate you fell asleep to was unchanged. also if one task is suspended another one might try perform the same blocking action on a single resource...which i don't want.
        


* 
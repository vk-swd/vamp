

RtcConnector

* This is a TypeScript implementation of `RtcConnector` in `src-tauri/rtc/rtc_connector.rs`, with one difference: this side is the initiator: it sends offers and initiates ICE restarts.
    * To easier navigate the state modified by async operations, state enums are defined, to reflect how those areconnected.

* The following changes are made as compared to Rust implementation:
    1. Unlike [Rust](../../../src-tauri/rtc/memo.md#node), TypeScript version does not initiate reconnection.
    2. Because events and object lifetimes are tied to a single thread, there is no need to serialise operations as state changes to avoid data races.
    >Note:
    >State variables reflect the last processed event, not real-time system state — a socket can be closed/errored at the system level before the corresponding JS callback has run, so checking a state variable can yield a stale positive.
    3. Only single datachannel is allowed to be used so far.
    4. At debouncee timeouts and after async signalling operations the iceconnectionstate and data channel readystate are checked to accomodate the following edge cases:
        1. Cancel renegotiation if conenction recovered during offer creation
        ```mermaid
        sequenceDiagram
        participant p as Peer
        participant d as debouce
        participant co as "Create Offer"

        p ->> d: disconnected
        activate d
        d ->> co: restart ICE
        deactivate d
        activate co
        p ->> co: recovered connection
        co --x d: check iceconnectionstate<br>drop offer<br>exit debounce
        deactivate co
        ```
        2. Cancel renegotiation and rollback pending local description if connection recovers during local SDP assignement

        ```mermaid
        sequenceDiagram
        participant p as Peer
        participant d as debouce
        participant co as "SetLocalDescription"
        participant r as "RollbackLocalSDP"

        p ->> d: disconnected
        activate d
        d ->> co: restart ICE
        deactivate d
        activate co
        p ->> co: recovered connection
        co ->> r: check iceconnectionstate<br>drop offer
        deactivate co
        activate r
        r --x d: exit debounce
        deactivate r
        ```
        3. If the connection was lost during rollback - restart the negotiation
        ```mermaid
        sequenceDiagram
        participant p as Peer
        participant d as debouce
        participant co as "SetLocalDescription"
        participant r as "RollbackLocalSDP"

        p ->> d: disconnected
        activate d
        d ->> co: restart ICE
        deactivate d
        activate co
        p ->> co: recovered connection
        co ->> r: check iceconnectionstate<br>drop offer
        deactivate co
        activate r
        p ->>r: disconnected again
        r ->> d: check iceconnectionstate<br>schedule new debounce
        deactivate r
        activate d

        d ->> co: ICE restart
        deactivate d
        ```
        4. If connection was fixed during debounce, do nnothing
        ```mermaid
        sequenceDiagram
        participant p as Peer
        participant d as debouce

        p ->> d: disconnected
        activate d
        p ->> d: restore connection
        d ->> p: check iceconnectionstate<br>do nothing
        deactivate d
        ```

        5. If connection restored and then was lost again during the debounce, don't restart the debounce timer.
        ```mermaid
        sequenceDiagram
        participant p as Peer
        participant d as debouce
        participant ir as ICE restart<br>steps

        p ->> d: disconnected
        activate d
        p ->> d: restore connection
        p ->> d: disconnected
        d ->> ir: check iceconnectionstat<br>ICE restart
        deactivate d
        ```
        6. If data channel was closed before the offer was sent, rollback the SDP and create new one with new data channel and send it.

        ```mermaid
        sequenceDiagram

        participant p as Peer
        participant dc as Data Channel
        participant d as debouce
        participant sl as setLocalDescription
        participant rl as rollbackLocalDescription
        participant net


        p ->> d: disconnected
        activate d
        d ->> sl: ICE restart
        deactivate d
        activate sl
        dc ->> sl: channel close
        sl ->> rl: check dc readyState<br>rollback
        deactivate sl
        activate rl
        rl  ->> sl: check dc and iceconnectionstate<br>ICE restart + new channel
        deactivate rl
        activate sl
        sl ->> net: send offer
        deactivate sl
        ```
        7. If channel was closed while the ICE restart offer was in flight, start renegotiating only after this negotiating session ends.

        ```mermaid
        sequenceDiagram

        participant p as Peer
        participant dc as Data Channel
        participant d as debouce
        participant net

        p ->> d: disconnected
        activate d
        d ->> net: debounce<br>ICE restart<br>send offer
        dc ->> d: closed
        net ->> p: answer
        p ->> d:connected
        d ->> sl: timeout<br>check readyState<br>create new data channel
        deactivate d

        ```
        8. Assign any incoming answer. Duplicates will be filtered by the RtcPeerConnection and answers not belonging to the current negotiation will be filtered by the [negotiation id](../../../src-tauri/rtc/memo.md#negotiation_session_id)
        
        ```mermaid
        sequenceDiagram

        participant p as Peer
        participant d as debouce
        participant net

        p ->> d: disconnected
        activate d
        d ->> net: debounce<br>ICE restart<br>send offer
        net ->> p: answer
        p ->> d:connected
        net ->> p: duplicate answer - assign and ignore
        d ->> d: timeout<br>check everything<br>do nothing
        deactivate d
        net ->> p: duplicate answer - assign and ignore

        ```
        9. If datachannel restart is negotiated and ice connection is lost, it either might recover or not, if it failed. In either case, a debounce will be in place together with the debounce awaiting for a new channel to be opened, and once it fires, it will restart ICE.
            1. A When the dc is opened but ice is not recovered (should be impossible with 1 channel):
            
            ```mermaid
            sequenceDiagram

            participant p as Peer
            participant dc as Data Channel
            participant d as debouce
            participant net

            dc ->> d: closed
            activate d
            d ->> d: timeout
            deactivate d
            d ->> net: debounce<br>DC restart<br>send offer
            activate d
            p ->> d: disconnected
            net ->> dc: answer for dc restart
            dc ->> d: opened
            d ->> d: timeout<br>check ice connection state
            deactivate d
            d ->> net: ICE restart etc.
            activate d
            deactivate d
            ```
            2. If dc was not opened in the end (more realistic option, but same result):
            ```mermaid
            sequenceDiagram

            participant p as Peer
            participant dc as Data Channel
            participant d as debouce
            participant net

            dc ->> d: closed
            activate d
            d ->> d: timeout
            deactivate d
            d ->> net: debounce<br>DC restart<br>send offer
            activate d
            p ->> d: disconnected
            net ->> dc: answer for dc restart
            d ->> d: timeout<br>check ice connection state<br>check data channel state
            deactivate d
            d ->> net: ICE restart <br>data channel restart <br>etc.
            activate d
            deactivate d
            ```


* 
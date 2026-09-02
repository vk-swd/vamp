

RtcConnector

* This is a TypeScript implementation of `RtcConnector` in `src-tauri/rtc/rtc_connector.rs`, with one difference: this side is the initiator: it sends offers and initiates ICE restarts.
    * To easier navigate the state modified by async operations, state enums are defined, to reflect how those areconnected.

* The following changes are made as compared to Rust implementation:
    1. Unlike [Node](../../../src-tauri/rtc/memo.md#node), TypeScript version does not initiate reconnection.
    Because events and object lifetimes are ties to a single thread, there is no need to serialise operations as state changes to avoid data races. 
    >Note:
    >State variables reflect the last processed event, not real-time system state — a socket can be closed/errored at the system level before the corresponding JS callback has run, so checking a state variable can yield a stale positive.
* 
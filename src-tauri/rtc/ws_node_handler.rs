//! Websocket message handling for [`WsNode`].
//!
//! `WsNode` owns the websocket and calls [`WsNodeHandler::process_message`]
//! for every received websocket message.  This module owns transport
//! decoding, sequence filtering, acknowledgements, and reliable sending.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use std::time::Duration;

use futures_util::{Sink, SinkExt};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::common::{MyRes, MyErr};
use crate::ws_node::{self, Connector};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct SignalMsg {
    #[serde(rename = "type")]
    pub kind: String, // "offer" | "answer" | "ice-candidate" | "ice-candidate-guest"
    pub sdp: String,
    pub neg_id: String,
}


/// Drops out-of-order / duplicate messages from a single sender.
/// See memo.md "Unordered messages".
struct SnFilter {
    node_id: Option<String>,
    last_sn: Option<u64>,
}
impl SnFilter {
    fn new() -> Self {
        Self { node_id: None, last_sn: None }
    }
    fn next(&mut self, node_id: &str, sn: u64) -> bool {
        let last = match self.last_sn {
            Some(last) => last,
            None => {
                // first message ever seen: accept it and remember the sender.
                self.node_id = Some(node_id.to_string());
                self.last_sn = Some(sn);
                return true;
            }
        };

        if self.node_id.as_deref() != Some(node_id) {
            // should be impossible - log and record a metric
            log::warn!("[WSC] node_id changed mid-stream: {:?} -> {node_id}", self.node_id);
            return false;
        }
        if sn <= last {
            // log and record a metric
            return false;
        }
        self.last_sn = Some(sn);
        true
    }
}

/// Wire message: either a payload ("normal") or an acknowledgement of one.
/// `sn` + `node_id` form the sequence-number pair used to detect loss/reorder
/// (see memo.md "Sequence numbers").
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TransportMsg {
    Ack { sn: u64, node_id: String },
    Normal { sn: u64, node_id: String, payload: SignalMsg },
}

impl TransportMsg {
    fn sn(&self) -> u64 {
        match self {
            TransportMsg::Ack { sn, .. } | TransportMsg::Normal { sn, .. } => *sn,
        }
    }
}


#[derive(Deserialize, Serialize, Clone, Debug)]
struct WireMsg {
    tag: String,
    message: Option<TransportMsg>,
}

fn to_wire_msg(rtt_tag: &String, msg: &TransportMsg) -> MyRes<String> {
    serde_json::to_string(&WireMsg { tag: rtt_tag.to_string(), message: Some(msg.clone()) })
        .map_err(|e| Box::new(e) as MyErr)
}

fn from_wire_msg(raw: &String) -> Option<TransportMsg> {
    serde_json::from_str::<WireMsg>(raw).ok().and_then(|w| w.message)
}

use super::ws_node::WsNode;

pub type MessageHandler<T> = fn(T) -> ();

/// Handles transport messages exchanged by a [`WsNode`].
pub struct WsNodeHandler {
    ws_node: WsNode,
    stopper: CancellationToken,
    seq_num_out: AtomicU64,
    ack_send_handle: tokio::task::JoinHandle<()>,
    incoming_ack_rx: mpsc::Receiver<TransportMsg>,
    rtt_tag: String,
    node_id_out: String,
}

impl WsNodeHandler {
    pub fn new<F>(
        connector: Connector,
        rtt_tag: String,
        message_handler: F,
    ) -> Self
    where
        F: Fn(SignalMsg) + Send + Sync + 'static,
    {
        let (ack_q_tx, mut ack_q_rx) = mpsc::channel::<TransportMsg>(16);
        let (incoming_ack_tx, incoming_ack_rx) = mpsc::channel::<TransportMsg>(16);
        
        let stopper = CancellationToken::new();
        let stopper_child = stopper.child_token();
        
        let sequence_filter_handle = Arc::new(Mutex::new(SnFilter::new()));
        let ws_node_handle = move |msg| {
            let Message::Text(raw) = msg else { return };
            let Some(transport_message) = from_wire_msg(&raw) else { return };

            match transport_message {
                TransportMsg::Normal { sn, node_id, payload } => {
                    let _ = ack_q_tx.try_send(TransportMsg::Ack {
                        sn,
                        node_id: node_id.clone(),
                    });

                    if sequence_filter_handle.lock().unwrap().next(&node_id, sn) {
                        message_handler(payload.into());
                    }
                }
                ack @ TransportMsg::Ack { .. } => {
                    let _ = incoming_ack_tx.try_send(ack);
                }
            }
        };
        let ws_node = WsNode::new_with_connector(connector, ws_node_handle);
        let ws_node_send_q = ws_node.send_tx.clone();
        let rtt_tag_clone = rtt_tag.clone();
        let ack_send_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stopper_child.cancelled() => break,
                    ack = ack_q_rx.recv() => {
                        match ack {
                            Some(ack) => {
                                let wire = match to_wire_msg(&rtt_tag_clone, &ack) {
                                    Ok(wire) => wire,
                                    Err(e) => {
                                        log::error!("[WSC] failed to serialize ack: {e}");
                                        continue;
                                    }
                                };
                                ws_node_send_q.send(Message::Text(wire)).await.unwrap_or_else(|e| {
                                    log::error!("[WSC] failed to send ack: {e}");
                                });
                            }
                            None => break,
                        }
                    }
                }
            }
        });

        Self {
            ws_node,
            stopper,
            seq_num_out: AtomicU64::new(0),
            ack_send_handle,
            rtt_tag,
            incoming_ack_rx,
            node_id_out: Uuid::new_v4().to_string(),
        }
    }


    /// Takes `&mut self` so the borrow checker enforces that only one
    /// caller can be waiting on the (single-consumer) ack queue at a time
    /// (mirrors the ts pseudocode's `sendAndWaitAck` caveat).
    async fn send_and_wait_ack(&mut self, msg: WireMsg, expected_sn: u64) -> MyRes<()> {
        self.ws_node.send(Message::Text(serde_json::to_string(&msg)?)).await?;
        loop {
            match self.incoming_ack_rx.recv().await {
                Some(TransportMsg::Ack { sn, .. }) if sn == expected_sn => return Ok(()),
                Some(_) => continue,
                None => return Err("ack channel closed".into()),
            }
        }
    }

    async fn send_and_wait_ack_repeated(&mut self, msg: WireMsg, sn: u64, timeout: Duration) -> MyRes<()> {
        loop {
            tokio::select! {
                _ = sleep(timeout) => continue,
                r = self.send_and_wait_ack(msg.clone(), sn) => match r {
                    Ok(()) => return Ok(()),
                    Err(_) => continue,
                },
            }
        }
    }

    /// Reliably deliver a signalling message to the other peer, retrying
    /// until acknowledged (see memo.md "Ack messages" / "Delivery retries").
    /// `timeout` controls how long to wait for an ack before retrying
    /// (defaults to 6s via [`WsNodeHandler::send_default`]).
    pub async fn send(&mut self, payload: SignalMsg, timeout: Duration) -> MyRes<()> {
        let sn = self.seq_num_out.fetch_add(1, Ordering::Relaxed);
        let msg = TransportMsg::Normal { sn, node_id: self.node_id_out.clone(), payload };
        let wire: WireMsg = WireMsg { tag: self.rtt_tag.clone(), message: Some(msg.clone()) };
        self.send_and_wait_ack_repeated(wire, sn, timeout).await
    }

    pub fn last_sent_sn(&self) -> u64 {
        self.seq_num_out.load(Ordering::Relaxed)
    }

    /// Like [`WsNodeHandler::send`], using the default 6s retry timeout.
    pub async fn send_default(&mut self, payload: SignalMsg) -> MyRes<()> {
        self.send(payload, Duration::from_secs(6)).await
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::mpsc::error::TryRecvError;
use webrtc::rtp::extension::transport_cc_extension;

use super::*;
    use crate::test_helpers::make_test_pair;

    const RTT_TAG: &str = "tag";
    /// Builds a `WsNodeHandler` wired to a single fake `WsNode` connection
    /// (via `ws_node::tests::make_test_pair`), returning the handler plus the
    /// test-side channel ends used to inject/observe wire traffic.
    fn make_handler() -> (WsNodeHandler, mpsc::Receiver<Message>, mpsc::Sender<Message>, mpsc::Receiver<SignalMsg>) {
        let pair = make_test_pair();
        let ws_sender_rx = pair.ws_sender_rx.expect("ws_sender_rx should be Some");
        let ws_receiver_tx = pair.ws_receiver_tx.expect("ws_receiver_tx should be Some");
        let inner = Mutex::new(Some((pair.ws_sender, pair.ws_receiver)));
        let connector: Connector = Box::new(move || {
            let (sender, receiver) = inner.lock().unwrap().take().expect("connector called more than once in this test");
            Box::pin(async move {
                Ok((Box::new(sender) as Box<dyn ws_node::WsSender>, Box::new(receiver) as Box<dyn ws_node::WsReceiver>))
            })
        });
        let (handle_tx , handle_rx) = mpsc::channel::<SignalMsg>(16);
        let record_layer_header = move |msg: SignalMsg| {
            let _ = handle_tx.try_send(msg.into());
        };
        let handler = WsNodeHandler::new(connector, RTT_TAG.to_string(), record_layer_header);
        (handler, ws_sender_rx, ws_receiver_tx, handle_rx)
    }

    fn ack_wire(sn: u64, node_id: &str) -> Message {
        let msg = TransportMsg::Ack { sn, node_id: node_id.to_string() };
        Message::Text(to_wire_msg(&"test".to_string(), &msg).unwrap())
    }

    fn decode_normal(msg: Message) -> (u64, String) {
        let Message::Text(raw) = msg else { panic!("expected text message") };
        match from_wire_msg(&raw).expect("valid wire message") {
            TransportMsg::Normal { sn, node_id, .. } => (sn, node_id),
            other => panic!("expected normal message, got {other:?}"),
        }
    }

    fn decode_ack(msg: Message) -> (u64, String) {
        let Message::Text(raw) = msg else { panic!("expected text message") };
        match from_wire_msg(&raw).expect("valid wire message") {
            TransportMsg::Ack { sn, node_id } => (sn, node_id),
            other => panic!("expected ack, got {other:?}"),
        }
    }
    const NODE_ID: &str = "node";
    const NEG_ID: &str = "neg";
    const SDP: &str = "sdp";
    fn make_message() -> SignalMsg {
        SignalMsg {
            kind: "offer".to_string(),
            sdp: SDP.to_string(),
            neg_id: NEG_ID.to_string(),
        }
    }
    fn make_wire_msg_txt(sn: u64) -> Message {
        let msg = TransportMsg::Normal { sn, node_id: NODE_ID.to_string(), payload: make_message() };
        let wire = to_wire_msg(&RTT_TAG.to_string(), &msg).unwrap();
        Message::Text(wire)
    }
    fn check_ack(msg: Message, expected_sn: u64) {
        let (sn, node_id) = decode_ack(msg);
        assert_eq!(sn, expected_sn);
        assert_eq!(node_id, NODE_ID.to_string());
    }
    #[tokio::test]
    async fn acks_are_sent_back_for_incoming_messages() {
        let (handler, mut ws_sender_rx, ws_receiver_tx, handle_rx) = make_handler();
        // let_connect().await;
        let expected_sn = 1;
        let normal_msg = make_wire_msg_txt(expected_sn);
        ws_receiver_tx.send(normal_msg).await.unwrap();
        check_ack(ws_sender_rx.recv().await.expect("ack should be sent back"), expected_sn);
        assert_eq!(handle_rx.len(), 1);
    }

    #[tokio::test]
    async fn out_of_order_messages_are_dropped_but_still_acked() {
        let (_handler, mut ws_sender_rx, ws_receiver_tx, _handle_rx) = make_handler();
        
        let first_sn = 1;
        let first_msg = make_wire_msg_txt(first_sn);
        
        ws_receiver_tx.send(first_msg).await.unwrap();
        check_ack(ws_sender_rx.recv().await.expect("ack should be sent back"), first_sn);
        assert_eq!(_handle_rx.len(), 1); // first message handled
        
        let second_sn = 0;
        let second_msg = make_wire_msg_txt(second_sn);
        ws_receiver_tx.send(second_msg).await.unwrap();
        check_ack(ws_sender_rx.recv().await.expect("ack should be sent back"), second_sn);
        assert_eq!(_handle_rx.len(), 1); // second message dropped
    }

    #[tokio::test]
    async fn retries_until_acked_then_sends_next_message() {
        let (mut handler, mut ws_sender_rx, ws_receiver_tx, _handle_rx) = make_handler();

        let timeout = Duration::from_millis(200);
        let (done_tx, mut done_rx) = mpsc::unbounded_channel::<u64>();
        let starting_sn = handler.last_sent_sn();
        let dummy_msg = make_message();
        let msg_to_add = 2;
        let msg_vector = vec![dummy_msg.clone(); msg_to_add];
        
        
        tokio::spawn(async move {
            for (i, msg) in msg_vector.into_iter().enumerate() {
                let last_sent_sn = handler.last_sent_sn();
                handler.send(msg, timeout).await.unwrap();
                done_tx.send(last_sent_sn).unwrap();
            }
        });

        // Initial send + two retries (each after a 200ms ack timeout), all
        // for the same (unacked) sn = 0 message.
        for _ in 0..3 {
            let msg = ws_sender_rx.recv().await.expect("retry should be resent");
            assert_eq!(decode_normal(msg).0, starting_sn);
        }

        // The second message must not have been sent yet.
        assert!(done_rx.try_recv().is_err());

        // Ack the first message; the handler should stop retrying and move on.
        ws_receiver_tx.send(ack_wire(starting_sn, "peer")).await.unwrap();
        assert_eq!(done_rx.recv().await, Some(starting_sn));

        let msg = ws_sender_rx.recv().await.expect("second message should be sent");
        assert_eq!(decode_normal(msg).0, starting_sn + 1);
    }
}
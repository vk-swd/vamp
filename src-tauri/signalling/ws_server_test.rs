use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{Sink, Stream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::ws_server::*;

// Ingress side of an emulated connection: a plain mpsc channel treated as an infallible
// message stream, standing in for the websocket ingress half in tests.
struct ChannelIngress(mpsc::UnboundedReceiver<Message>);

impl Stream for ChannelIngress {
    type Item = Result<Message, std::convert::Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(cx).map(|opt| opt.map(Ok))
    }
}

// Egress side of an emulated connection: a plain mpsc channel treated as an infallible
// message sink, standing in for the websocket egress half in tests.
struct ChannelEgress(mpsc::UnboundedSender<Message>);

impl Sink<Message> for ChannelEgress {
    type Error = std::convert::Infallible;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        // Ignore send errors: a dropped receiver just means the emulated participant
        // disconnected, which is a valid test scenario and shouldn't panic the sink.
        let _ = self.0.send(item);
        Ok(())
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

// One emulated participant driving a `run_connection` task through plain channels.
struct Participant {
    to_server: mpsc::UnboundedSender<Message>,
    from_server: mpsc::UnboundedReceiver<Message>,
    join: tokio::task::JoinHandle<()>,
}

impl Participant {
    fn send_json(&self, tag: &str, payload: Option<&str>) {
        let message = match payload {
            Some(payload) => Message::Text(format!(r#"{{"tag":"{tag}","payload":"{payload}"}}"#)),
            None => Message::Text(format!(r#"{{"tag":"{tag}"}}"#)),
        };
        // Ignore errors: if the connection already closed, tests assert that separately.
        let _ = self.to_server.send(message);
    }

    async fn try_recv(&mut self, timeout: Duration) -> Option<Message> {
        tokio::time::timeout(timeout, self.from_server.recv()).await.ok().flatten()
    }

    fn is_closed(&self) -> bool {
        self.join.is_finished()
    }

    #[allow(dead_code)]
    async fn disconnect(self) {
        drop(self.to_server);
        let _ = self.join.await;
    }
}

// Spins up an in-process emulated signalling server sharing one `ServerState`/`ServerMetrics`
// across every connected `Participant`, without any real websocket/TCP transport.
struct Harness {
    server_state: SharedServerState,
    config: ServerConfig,
    metrics: Arc<ServerMetrics>,
}

impl Harness {
    fn new(config: ServerConfig) -> Self {
        Self {
            server_state: Arc::new(Mutex::new(ServerState::default())),
            config,
            metrics: Arc::new(ServerMetrics::default()),
        }
    }

    fn connect(&self, cid: ConnectionId) -> Participant {
        let (to_server_tx, to_server_rx) = mpsc::unbounded_channel::<Message>();
        let (from_server_tx, from_server_rx) = mpsc::unbounded_channel::<Message>();

        let join = tokio::spawn(run_connection(
            cid,
            self.server_state.clone(),
            self.config.clone(),
            self.metrics.clone(),
            ChannelIngress(to_server_rx),
            ChannelEgress(from_server_tx),
        ));

        Participant {
            to_server: to_server_tx,
            from_server: from_server_rx,
            join,
        }
    }
}

const RECV_TIMEOUT: Duration = Duration::from_millis(200);

fn text_message(tag: &str, payload: Option<&str>) -> Message {
    match payload {
        Some(payload) => Message::Text(format!(r#"{{"tag":"{tag}","payload":"{payload}"}}"#)),
        None => Message::Text(format!(r#"{{"tag":"{tag}"}}"#)),
    }
}

// --- Ported ServerState-level unit tests (previously in ws_server.rs) ---

#[test]
fn first_message_without_payload_registers_without_forwarding() {
    let mut state = ServerState::default();
    let (tx, _rx) = mpsc::channel(1);
    state.record_connection(
        1,
        ConnectionHandler {
            send_spsc_q_putter: tx,
            close_notifier: CloseNotifier::new(),
        },
    );

    let result = state.record_rtr_and_get_forwarding_queue("room".to_string(), 1, false);

    assert!(result.is_err());
    assert!(state.rtt.get("room").expect("route should exist").contains(1));
}

#[test]
fn second_participant_payload_is_forwarded_to_first() {
    let mut state = ServerState::default();
    let (tx1, _rx1) = mpsc::channel(1);
    let (tx2, _rx2) = mpsc::channel(1);
    state.record_connection(
        1,
        ConnectionHandler {
            send_spsc_q_putter: tx1,
            close_notifier: CloseNotifier::new(),
        },
    );
    state.record_connection(
        2,
        ConnectionHandler {
            send_spsc_q_putter: tx2,
            close_notifier: CloseNotifier::new(),
        },
    );

    state.record_rtr_and_get_forwarding_queue("room".to_string(), 1, false).ok();
    let result = state.record_rtr_and_get_forwarding_queue("room".to_string(), 2, true);

    let forwarded_to = result.expect("should forward to first connection");
    assert!(Arc::ptr_eq(&forwarded_to, state.ct.get(&1).expect("connection 1 should exist")));
}

#[test]
fn third_participant_for_full_room_is_dropped() {
    let mut state = ServerState::default();
    for connection_id in [1, 2, 3] {
        let (tx, _rx) = mpsc::channel(1);
        state.record_connection(
            connection_id,
            ConnectionHandler {
                send_spsc_q_putter: tx,
                close_notifier: CloseNotifier::new(),
            },
        );
    }

    state.record_rtr_and_get_forwarding_queue("room".to_string(), 1, false).ok();
    state.record_rtr_and_get_forwarding_queue("room".to_string(), 2, true).ok();
    let result = state.record_rtr_and_get_forwarding_queue("room".to_string(), 3, true);

    assert!(result.is_err());
}

#[test]
fn parser_accepts_tag_aliases_and_optional_payload() {
    let parsed = parse_incoming(&Message::Text(r#"{"rtt_tag":"room","payload":{"sdp":"x"}}"#.to_string())).unwrap();
    assert_eq!(parsed.rtt_tag, "room");
    assert!(parsed.has_payload);

    let parsed = parse_incoming(&text_message("room", None)).unwrap();
    assert_eq!(parsed.rtt_tag, "room");
    assert!(!parsed.has_payload);
}

// --- Flow-level tests driven through `run_connection`, mapped to memo.md's test list ---

// 1. Happy path - participants connect to SS and exchange data.
#[tokio::test]
async fn happy_path_participants_exchange_messages() {
    let harness = Harness::new(ServerConfig::default());
    let mut p1 = harness.connect(1);
    let mut p2 = harness.connect(2);

    p1.send_json("room", None);
    tokio::time::sleep(Duration::from_millis(20)).await;

    p2.send_json("room", Some("offer"));
    let received = p1.try_recv(RECV_TIMEOUT).await.expect("p1 should receive p2's payload");
    assert_eq!(received, text_message("room", Some("offer")));

    p1.send_json("room", Some("answer"));
    let received = p2.try_recv(RECV_TIMEOUT).await.expect("p2 should receive p1's payload");
    assert_eq!(received, text_message("room", Some("answer")));
}

// 2. Test busy_work prevention - sustained traffic beyond the per-connection cap
// terminates the offending connection.
#[tokio::test]
async fn busy_work_sustained_traffic_capped_by_connection_limit() {
    let mut config = ServerConfig::default();
    config.messages_per_connection = 5;
    let harness = Harness::new(config);
    let mut p1 = harness.connect(1);
    let mut p2 = harness.connect(2);

    p1.send_json("room", None);
    tokio::time::sleep(Duration::from_millis(20)).await;

    // The message cap is tracked per-connection: p2's own 5 messages exhaust its cap of 5.
    for i in 0..5 {
        p2.send_json("room", Some(&format!("msg{i}")));
        let received = p1.try_recv(RECV_TIMEOUT).await;
        assert!(received.is_some(), "message {i} should still be forwarded");
    }

    // Any further message from p2 breaches its connection cap and closes it.
    p2.send_json("room", Some("over-the-limit"));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(p2.is_closed(), "connection should close once message limit is breached");
    // TODO: use metrics to identify measures taken at the server.
    // TODO: make a 5s capped waiter on the connection async task handle.
}

// 3. Test idle_connections prevention (use shorter timeouts in server config).
#[tokio::test]
async fn idle_connection_closed_after_first_message_timeout() {
    let mut config = ServerConfig::default();
    config.first_message_max_delay = Duration::from_millis(50);
    let harness = Harness::new(config);

    let silent = harness.connect(1);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(silent.is_closed(), "connection sending nothing should be closed after the first-message timeout");
}

#[tokio::test]
async fn connection_stays_open_when_first_message_arrives_in_time() {
    let mut config = ServerConfig::default();
    config.first_message_max_delay = Duration::from_millis(100);
    let harness = Harness::new(config);

    let mut prompt = harness.connect(1);
    prompt.send_json("room", None);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!prompt.is_closed(), "connection that registered in time should remain open");
}

// 4. Test ignore_flagged - bad connection should be closed.
#[tokio::test]
async fn flagged_connection_closed_on_tag_mismatch() {
    let harness = Harness::new(ServerConfig::default());
    let mut impostor = harness.connect(1);
    let mut honest_peer = harness.connect(2);
    let mut third_peer = harness.connect(3);

    impostor.send_json("room-a", None);
    honest_peer.send_json("room-a", None);
    tokio::time::sleep(Duration::from_millis(20)).await;

    impostor.send_json("room-b", Some("switched tags"));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(impostor.is_closed(), "connection changing its routing tag should be closed");

    // The other, unrelated participant in room-a is unaffected: it stays open, and once
    // the impostor's connection is torn down and a third, honest peer takes its place,
    // messages flow normally again.
    assert!(!honest_peer.is_closed());
    third_peer.send_json("room-a", Some("hello"));
    let received = honest_peer.try_recv(RECV_TIMEOUT).await;
    assert_eq!(received, Some(text_message("room-a", Some("hello"))));
}

// 5. Test lack_of_forwarding - connect, register but don't send.
#[tokio::test]
async fn lack_of_forwarding_registers_without_peer() {
    let harness = Harness::new(ServerConfig::default());
    let mut solo = harness.connect(1);

    solo.send_json("room", None);

    let received = solo.try_recv(RECV_TIMEOUT).await;
    assert!(received.is_none(), "no peer means no message should ever be forwarded back");
    assert!(!solo.is_closed(), "registered connection with no peer yet should remain open");
}

// 6. Test message_flood - configure 1 msg per (effectively unbounded) window, send 10, fwd 1.
#[tokio::test]
async fn message_flood_rate_limited_within_window() {
    let mut config = ServerConfig::default();
    config.messages_per_second = 1;
    config.messages_per_connection = 128;
    let harness = Harness::new(config);
    let mut p1 = harness.connect(1);
    let mut p2 = harness.connect(2);

    p1.send_json("room", None);
    tokio::time::sleep(Duration::from_millis(20)).await;

    // Burst 10 payload messages back-to-back within the same 1-second window.
    for i in 0..10 {
        p2.send_json("room", Some(&format!("msg{i}")));
    }

    let first = p1.try_recv(RECV_TIMEOUT).await;
    assert!(first.is_some(), "exactly one message should be forwarded within the rate-limit window");
    let second = p1.try_recv(RECV_TIMEOUT).await;
    assert!(second.is_none(), "remaining messages in the same window should be rate-limited");
    assert!(!p2.is_closed(), "being rate-limited by time should drop messages, not close the connection");
    assert!(harness.metrics.rate_limited_by_time_count() >= 1, "excess messages should be recorded as time-rate-limited");
}

// 7. Test message_limits - set 3 msgs, send 10, receive up to the cap. Count drop stats.
#[tokio::test]
async fn message_limits_drop_after_cap_with_metrics() {
    let mut config = ServerConfig::default();
    config.messages_per_connection = 3;
    let harness = Harness::new(config);
    let mut p1 = harness.connect(1);
    let mut p2 = harness.connect(2);

    p1.send_json("room", None);
    tokio::time::sleep(Duration::from_millis(20)).await;

    // Cap of 3 is spent by registration (1) plus 2 forwardable payloads.
    for i in 0..10 {
        p2.send_json("room", Some(&format!("msg{i}")));
    }

    let mut forwarded = 0;
    while p1.try_recv(RECV_TIMEOUT).await.is_some() {
        forwarded += 1;
    }
    // p2's own cap of 3 messages is fully spent forwarding payloads (p1 already used its
    // own quota registering, on its own separate per-connection counter).
    assert_eq!(forwarded, 3, "only messages within p2's per-connection cap should be forwarded");
    assert!(harness.metrics.rate_limited_by_count_count() >= 1, "exceeding the cap should be recorded in metrics");
}

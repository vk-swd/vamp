use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
use webkit2gtk::gio::TcpConnection;

use crate::common::{MyErr, MyRes};

pub type ConnectionId = u64;
pub type RoutingTag = String;

const DEFAULT_MAX_MESSAGE_SIZE: usize = 8192;
const DEFAULT_SEND_BUFFER_LIMIT: usize = 100;
const DEFAULT_MESSAGES_PER_SECOND: usize = 10;
const DEFAULT_MESSAGES_PER_CONNECTION: usize = 128;
const FIRST_MESSAGE_MAX_DELAY: Duration = Duration::from_secs(5);
const IDLE_CHECK_TIMEOUT: Duration = Duration::from_secs(60);

type SharedServerState = Arc<Mutex<ServerState>>;
type CloseNotifier = CancellationToken;

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub max_message_size: usize,
    pub send_buffer_limit: usize,
    pub messages_per_second: usize,
    pub messages_per_connection: usize,
    pub first_message_max_delay: Duration,
    pub idle_check_timeout: Duration,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            max_message_size: DEFAULT_MAX_MESSAGE_SIZE,
            send_buffer_limit: DEFAULT_SEND_BUFFER_LIMIT,
            messages_per_second: DEFAULT_MESSAGES_PER_SECOND,
            messages_per_connection: DEFAULT_MESSAGES_PER_CONNECTION,
            first_message_max_delay: FIRST_MESSAGE_MAX_DELAY,
            idle_check_timeout: IDLE_CHECK_TIMEOUT,
        }
    }
}

pub async fn run_server_with_config(addr: SocketAddr, config: ServerConfig) {
    let listener = TcpListener::bind(addr).await.expect("failed to bind signalling websocket listener");
    let server_state = Arc::new(Mutex::new(ServerState::default()));
    let mut next_connection_id = 0;

    log::info!("[SS2] Listening on {addr}");

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let connection_id = next_connection_id;
                next_connection_id += 1;
                tokio::spawn(set_up_ws_connection(
                    stream,
                    peer,
                    connection_id,
                    server_state.clone(),
                    config.clone(),
                ));
            }
            Err(error) => log::error!("[SS2] Accept error: {error}"),
        }
    }
}
struct MsgProcessor {
    close_notifier: CloseNotifier,
    server_state: SharedServerState,
    src_connection_id: ConnectionId,
    msg_rate_limiter: MsgRateLimiter,
    non_idle_marker: Arc<NonIdleMarker>,
}
impl MsgProcessor {
    fn new(
        close_notifier: CloseNotifier,
        server_state: SharedServerState,
        src_connection_id: ConnectionId,
        msg_rate_limiter: MsgRateLimiter,
        non_idle_marker: Arc<NonIdleMarker>,
    ) -> Self {
        Self {
            close_notifier,
            server_state,
            src_connection_id,
            msg_rate_limiter,
            non_idle_marker,
        }
    }
    async fn process(self: &mut Self, message: Message) -> MyRes<()> {
        self.msg_rate_limiter.rate_limit_by_time()?;
        self.msg_rate_limiter.limit_messages()?;

        let parsed_msg = parse_incoming(&message)?;
        self.non_idle_marker.increment_incoming();
        if let Err(error) = self.msg_rate_limiter.try_brand_rtt_tag(&parsed_msg.rtt_tag) {
            self.close_notifier.cancel();
            return Err(error).into();
        }

        let rtt_tag = parsed_msg.rtt_tag.clone();
        let has_payload = parsed_msg.has_payload;
        
        let dst_con_handler =  self.server_state.lock().await
        .record_rtr_and_get_forwarding_queue(rtt_tag, self.src_connection_id, has_payload)?;
        
        dst_con_handler.send_spsc_q_putter.try_send(message)
        .map_err(|err| build_err(&parsed_msg.rtt_tag, self.src_connection_id, ("failed to send message to destination")))?;
        self.non_idle_marker.increment_forwarded();
        return Ok(());
    }
}

async fn set_up_ws_connection(
    tcp_connection: tokio::net::TcpStream,
    peer: SocketAddr,
    src_connection_id: ConnectionId,
    server_state: SharedServerState,
    config: ServerConfig,
)
{
    let ws_config = WebSocketConfig {
        max_message_size: Some(config.max_message_size),
        max_frame_size: Some(config.max_message_size),
        ..Default::default()
    };

    let ws_connection = match accept_async_with_config(tcp_connection, Some(ws_config)).await {
        Ok(ws_connection) => ws_connection,
        Err(error) => {
            log::error!("[SS2] Handshake error peer={peer}: {error}");
            return;
        }
    };

    let (ws_egress, ws_ingress) = ws_connection.split();
    let (send_spsc_q_putter, send_spsc_q_getter) = mpsc::channel::<Message>(config.send_buffer_limit);
    let close_notifier = CloseNotifier::new();
    let non_idle_marker = Arc::new(NonIdleMarker::default());


    log::info!("[SS2] Connection opened id={src_connection_id} peer={peer}");
    let msg_rate_limiter = MsgRateLimiter::new(config.messages_per_second, config.messages_per_connection);
    let connection_close_notifier = close_notifier.clone();
    let msg_server_state = server_state.clone();

    let msg_process_callback = MsgProcessor::new(close_notifier.clone(), server_state.clone(), src_connection_id, msg_rate_limiter, non_idle_marker.clone());

    let receiving_join_handle = tokio::spawn(listen_task(
        close_notifier.clone(),
        msg_process_callback,
        ws_ingress,
    ));
    let send_join_handle = tokio::spawn(spawn_egress_task(
        close_notifier.clone(),
        ws_egress,
        send_spsc_q_getter,
    ));
    let idle_check_join_handle = tokio::spawn(start_idle_checker(
        non_idle_marker.clone(),
        close_notifier.clone(),
        config.first_message_max_delay,
        config.idle_check_timeout,
    ));

    server_state.lock().await.record_connection(
        src_connection_id,
        ConnectionHandler {
            send_spsc_q_putter,
            close_notifier: close_notifier.clone(),
        }
    );

    let (receiving_result, _, _) = tokio::join!(
        receiving_join_handle,
        send_join_handle,
        idle_check_join_handle,
    );
    let rtt_tag = receiving_result.ok().flatten();

    close_notifier.cancel();
    {
        let mut unlocked_state = server_state.lock().await;
        unlocked_state.remove_records_for(src_connection_id, rtt_tag.as_ref());
    }
    log::info!("[SS2] Connection closed id={src_connection_id} peer={peer}");
}

async fn spawn_egress_task<S>(
    close_notifier: CloseNotifier,
    mut ws_egress: S,
    mut send_spsc_q_getter: mpsc::Receiver<Message>,
) where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    loop {
        tokio::select! {
            _ = close_notifier.cancelled() => break,
            msg = send_spsc_q_getter.recv() => {
                let Some(msg) = msg else {
                    break;
                };

                if ws_egress.send(msg).await.is_err() {
                    close_notifier.cancel();
                    break;
                }
            }
        }
    }

    let _ = ws_egress.close().await;
}

async fn listen_task(
    close_notifier: CloseNotifier,
    mut msg_process_callback: MsgProcessor,
    mut ws_ingress: futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>>,
) -> Option<RoutingTag> {
    loop {
        tokio::select! {
            _ = close_notifier.cancelled() => break,
            incoming = ws_ingress.next() => {
                match incoming {
                    Some(Ok(message)) => {
                        if message.is_close() {
                            break;
                        }
                        if let Err(error) = msg_process_callback.process(message).await {
                            log::info!("[SS2] Error processing message: {error}");
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        log::info!("[SS2] Websocket read error: {error}");
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    close_notifier.cancel();
    msg_process_callback.msg_rate_limiter.tag
}

async fn start_idle_checker(
    non_idle_marker: Arc<NonIdleMarker>,
    close_notifier: CloseNotifier,
    first_message_max_delay: Duration,
    idle_check_timeout: Duration,
) {
    tokio::select! {
        _ = close_notifier.cancelled() => return,
        _ = tokio::time::sleep(first_message_max_delay) => {}
    }

    if non_idle_marker.incoming() == 0 {
        log::info!("[SS2] Closing idle connection: first message timeout");
        close_notifier.cancel();
        return;
    }

    let mut checked_forwarded = non_idle_marker.forwarded();
    loop {
        tokio::select! {
            _ = close_notifier.cancelled() => return,
            _ = tokio::time::sleep(idle_check_timeout) => {
                let forwarded = non_idle_marker.forwarded();
                if forwarded == checked_forwarded {
                    log::info!("[SS2] Closing stale connection: no forwarded messages");
                    close_notifier.cancel();
                    return;
                }
                checked_forwarded = forwarded;
            }
        }
    }
}

#[derive(Clone, Default)]
struct NonIdleMarker {
    incoming: Arc<std::sync::atomic::AtomicUsize>,
    forwarded: Arc<std::sync::atomic::AtomicUsize>,
}

impl NonIdleMarker {
    fn increment_incoming(&self) {
        self.incoming.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    fn increment_forwarded(&self) {
        self.forwarded.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    fn incoming(&self) -> usize {
        self.incoming.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn forwarded(&self) -> usize {
        self.forwarded.load(std::sync::atomic::Ordering::Relaxed)
    }
}

struct MsgRateLimiter {
    tag: Option<RoutingTag>,
    window_started_at: Instant,
    window_message_count: usize,
    total_message_count: usize,
    max_messages_per_second: usize,
    max_messages_per_connection: usize,
}

impl MsgRateLimiter {
    fn new(max_messages_per_second: usize, max_messages_per_connection: usize) -> Self {
        Self {
            tag: None,
            window_started_at: Instant::now(),
            window_message_count: 0,
            total_message_count: 0,
            max_messages_per_second,
            max_messages_per_connection,
        }
    }

    fn rate_limit_by_time(&mut self) -> MyRes<()> {
        let now = Instant::now();
        if now.duration_since(self.window_started_at) >= Duration::from_secs(1) {
            self.window_started_at = now;
            self.window_message_count = 0;
        }

        if self.window_message_count >= self.max_messages_per_second {
            return Err(MyErr::from("message rate limit exceeded"));
        }

        self.window_message_count += 1;
        Ok(())
    }

    fn limit_messages(&mut self) -> MyRes<()> {
        if self.total_message_count >= self.max_messages_per_connection {
            return Err(MyErr::from("connection message limit reached"));
        }

        self.total_message_count += 1;
        Ok(())
    }

    fn try_brand_rtt_tag(&mut self, tag: &RoutingTag) -> MyRes<()> {
        match &self.tag {
            Some(existing) if existing != tag => Err(MyErr::from("connection changed routing tag")),
            Some(_) => Ok(()),
            None => {
                self.tag = Some(tag.clone());
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ForwardResult {
    Forwarded,
}

#[derive(Default)]
struct ServerState {
    rtt: HashMap<RoutingTag, RoutingRecord>,
    ct: HashMap<ConnectionId, Arc<ConnectionHandler>>,
}

fn build_err(rtt_tag: &RoutingTag, cid: ConnectionId, msg: &str) -> MyErr {
    MyErr::from(format!("[cid={} rtt_tag={:?}]: {}", cid, rtt_tag, msg))
}

impl ServerState {
    fn record_connection(
        self: &mut Self,
        cid: ConnectionId,
        tcp_connection_bundle: ConnectionHandler
    ) {
        self.ct.insert(cid, Arc::new(tcp_connection_bundle));
    }
    fn record_rtr_and_get_forwarding_queue(
        self: &mut Self,
        rtt_tag: RoutingTag,
        cid: ConnectionId,
        has_payload: bool,
    ) -> MyRes<Arc<ConnectionHandler>> {
        if !self.ct.contains_key(&cid) {
            return Err(build_err(&rtt_tag, cid, "Connection id not found"));
        }

        let rtt_record = self.rtt.entry(rtt_tag.clone()).or_default();

        if rtt_record.is_full() && !rtt_record.contains(cid) {
            return Err(build_err(&rtt_tag, cid, "Routing record full"));
        }

        if !rtt_record.contains(cid) {
            rtt_record.add(cid);
        }

        if !has_payload {
            return Err(build_err(&rtt_tag, cid, "RecordOnly"));
        }

        let Some(other_connection_id) = rtt_record.other_connection(cid) else {
            return Err(build_err(&rtt_tag, cid, "No other connection"));
        };

        let Some(other_connection) = self.ct.get(&other_connection_id) else {
            log::warn!("[SS2] Connection id {} not found in ct, removing from rtt record", other_connection_id);
            rtt_record.remove(other_connection_id);
            return Err(build_err(&rtt_tag, cid, "No other connection"));
        };

        Ok(Arc::clone(other_connection))
    }

    fn remove_records_for(self: &mut Self, connection_id: ConnectionId, rtt_tag: Option<&RoutingTag>) {
        self.ct.remove(&connection_id);

        let Some(rtt_tag) = rtt_tag else {
            return;
        };

        if let Some(record) = self.rtt.get_mut(rtt_tag) {
            record.remove(connection_id);
            if record.is_empty() {
                self.rtt.remove(rtt_tag);
            }
        }
    }

}
#[derive(Clone)]
struct ConnectionHandler {
    send_spsc_q_putter: mpsc::Sender<Message>,
    close_notifier: CloseNotifier,
}

#[derive(Default)]
struct RoutingRecord {
    pair: Vec<ConnectionId>,
}

impl RoutingRecord {
    fn contains(&self, connection_id: ConnectionId) -> bool {
        self.pair.contains(&connection_id)
    }

    fn is_full(&self) -> bool {
        self.pair.len() >= 2
    }

    fn add(&mut self, connection_id: ConnectionId) {
        if !self.contains(connection_id) && !self.is_full() {
            self.pair.push(connection_id);
        }
    }

    fn other_connection(&self, connection_id: ConnectionId) -> Option<ConnectionId> {
        self.pair.iter().copied().find(|id| *id != connection_id)
    }

    fn remove(&mut self, connection_id: ConnectionId) {
        self.pair.retain(|id| *id != connection_id);
    }

    fn is_empty(&self) -> bool {
        self.pair.is_empty()
    }
}

enum ForwardingDecision {
    Forward {
        dst_connection_id: ConnectionId,
        tx: mpsc::Sender<Message>,
    },
    RecordOnly,
    Drop,
}

#[derive(Debug, Deserialize)]
struct WireMessage {
    #[serde(alias = "rtt_tag", alias = "rt")]
    tag: RoutingTag,
    #[serde(default)]
    payload: Option<serde_json::Value>,
}

struct ParsedMessage {
    rtt_tag: RoutingTag,
    has_payload: bool,
}

fn parse_incoming(message: &Message) -> MyRes<ParsedMessage> {
    let text = match message {
        Message::Text(text) => text.clone(),
        Message::Binary(bytes) => String::from_utf8(bytes.clone()).map_err(|_| MyErr::from("binary message is not utf-8"))?,
        _ => return Err(MyErr::from("unsupported websocket message")),
    };

    let wire_message = serde_json::from_str::<WireMessage>(&text).map_err(|_| MyErr::from("invalid signalling message"))?;
    if wire_message.tag.is_empty() {
        return Err(MyErr::from("empty routing tag"));
    }

    Ok(ParsedMessage {
        rtt_tag: wire_message.tag,
        has_payload: wire_message.payload.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_message(tag: &str, payload: Option<&str>) -> Message {
        match payload {
            Some(payload) => Message::Text(format!(r#"{{"tag":"{tag}","payload":"{payload}"}}"#)),
            None => Message::Text(format!(r#"{{"tag":"{tag}"}}"#)),
        }
    }

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
}
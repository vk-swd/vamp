use std::collections::HashMap;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::time::{timeout, Duration};
use futures_util::{SinkExt, StreamExt, Stream};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

// Mirrors the TS ROUTE_LIMIT constant.
// A connection may register at most ROUTE_LIMIT+1 source addresses before
// further registrations are rejected.
const ROUTE_LIMIT: usize = 2;
const BUFFER_SIZE: usize = 32;
// ── wire types ────────────────────────────────────────────────────────────────

/// Only src/dst are needed for routing; payload and originType pass through.
// #[derive(Deserialize)]
// struct WsMsg {
//     src: String,
//     dst: String,
// // }]
// mod common_types;

#[derive(Serialize)]
struct ErrorResponse<'a> {
    src: &'a str,
    msg: &'a str,
}

fn error_msg(msg: &str) -> Message {
    Message::Text(serde_json::to_string(&ErrorResponse { src: "error", msg }).unwrap())
}

// ── shared state ──────────────────────────────────────────────────────────────

struct ConnectionInfo {
    // TODO: add timeout info
    tx: mpsc::Sender<Message>,
    local_addrs: HashSet<String>,
    remote_addrs: HashSet<String>,
}

#[derive(Default)]
struct SharedState {
    connections: HashMap<u64, ConnectionInfo>,
    /// Maps a registered source address to the socket-id that owns it.
    r_table: HashMap<String, u64>,
}

type State = Arc<Mutex<SharedState>>;
// ── connection handler ────────────────────────────────────────────────────────

pub fn msg_to_txt(msg: &Message) -> Option<String> {
    match msg {
        Message::Text(t) => Some(t.clone()),
        Message::Binary(b) => match String::from_utf8(b.clone()) {
            Ok(s) => Some(s),
            Err(_) => None,
        },
        _ => None,
    }
}
fn get_routing_info(raw: tokio_tungstenite::tungstenite::Message) -> Option<WsMsg<String>> {
    // Accept text; treat binary as UTF-8 text (mirrors WS onmessage .toString()).
    let text = msg_to_txt(&raw)?;
    // log::info!("[SS] Incoming message (id={socket_id}): {text}");
    match serde_json::from_str(&text) {
        Ok(d) => d,
        Err(e) => {
            // log::info!("[SS] Parse error (id={socket_id}): {e}");
            return None;
        }
    }
}

enum FwdResult {
    FlagConnection(String),
    Forwarded(String),
    Result(String),
}
use super::common_types::WsMsg;
fn record_and_q_forwarding(shared_state: &mut SharedState, socket_id: u64, data: &WsMsg<String>, raw: tokio_tungstenite::tungstenite::Message) -> FwdResult {
    // Signalling is meant to exchange offers/answers for a single datachannel connection.
    // Since I want to make things simple and with no authorisation, connecting participants should 
    // not be able to get any information about each other and should not store any state.
    // That's why:
    //  1. The connection mappings will exist only while the connection is open
    //  2. Any forwarding errors will not close the originator's connection.
    // The authentication and load balancing and rate limiting is expected to be done by external service

    let r_table = &mut shared_state.r_table;
    let connections = &mut shared_state.connections;
    let connection = match connections.get_mut(&socket_id) {
        Some(c) => c,
        None => {
            return FwdResult::Result(format!("[SS] No connection record for socket id={}. Ignore. Will timeout.",socket_id));
        }
    };
    let mb_existing_record = r_table.get(&data.src);
    if let Some(&existing) = mb_existing_record {
        if existing != socket_id {
            return FwdResult::FlagConnection(format!("[SS] Dangling record or impersonation. Src: {}. Old id: {}. New id: {}", data.src, existing, socket_id));
        }
    }

    // Prevent people hijack multiple sources.
    // Connections are ratelimited outside
    // TODO: the sources are not cleaned...for now it's ok, as the overflow is unlikely now.
    if connection.local_addrs.len() >= ROUTE_LIMIT {
        return FwdResult::Result(format!("[SS] Local address limit reached for socket id={}. Ignore.", socket_id));
    }

    // Prevent people probe forwarding to different destinations.
    if connection.remote_addrs.len() >= ROUTE_LIMIT {
        connection.remote_addrs.retain(|addr|  r_table.contains_key(addr));
        if connection.remote_addrs.len() >= ROUTE_LIMIT {
            return FwdResult::Result(format!("[SS] Remote address limit reached for socket id={}. Ignore.", socket_id));
        }
    }

    // Register / refresh src → this socket in the routing table.
    r_table.insert(data.src.clone(), socket_id);
    if let Some(c) = connections.get_mut(&socket_id) {
        c.local_addrs.insert(data.src.clone());
        if data.dst != data.src {
            c.remote_addrs.insert(data.dst.clone());
        }
    }

    if data.dst == data.src || !r_table.contains_key(&data.dst){
        return FwdResult::Result(format!("[SS] Didn't forward to {} from {}", data.dst, data.src));
    }

    // Forward raw frame to destination socket.
    let dst_id = match r_table.get(&data.dst).copied() {
        Some(id) => id,
        None => {
            return FwdResult::Result("Destination connection lost mid-route".to_string());
        }
    };

    match connections.get(&dst_id) {
        Some(dst) => {
            match dst.tx.try_send(raw) {
                Ok(_) => return FwdResult::Forwarded(format!("[SS] Forwarded message from {} to {}", data.src, data.dst)),
                Err(_) => return FwdResult::Result(format!("[SS] Forward failed (dst id={dst_id})")),
            }
        },
        None => {
            return FwdResult::Result(format!("[SS] No live connection for dst id={}. Ignore.", data.dst));
        }
    }
}

// [`MsgLimiter`]: is necessary to limit number of messages reaching processing phase.;
struct MsgLimiter {
    is_flagged: bool,
    window_start: tokio::time::Instant,
    msg_count: usize,
}
const MSG_PER_SECOND: usize = 10;
impl MsgLimiter {
    fn new() -> Self {
        Self { is_flagged: false, window_start: tokio::time::Instant::now(), msg_count: 0 }
    }
    fn check(&mut self) -> bool {
        if self.is_flagged {
            return false;
        }
        if self.window_start.elapsed() > Duration::from_secs(1) {
            self.window_start = tokio::time::Instant::now();
            self.msg_count = 0;
        }
        self.msg_count += 1;
        if self.msg_count > MSG_PER_SECOND {
            return false;
        }
        true
    }
    fn flag_bad_connection(&mut self) {
        self.is_flagged = true;
    }
}

struct ConnectionTimeoutTracker {
    timeout_start: tokio::time::Instant,
    to_wait: tokio::time::Duration
}
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn next_msg<T>(source: &mut T) -> SimpleResult<Message>
where
    T: Stream<Item = tokio_tungstenite::tungstenite::Result<Message>> + Unpin,
{
    match source.next().await {
        Some(Ok(m)) => SimpleResult::Ok(m),
        Some(Err(e)) => SimpleResult::Err(e.to_string()),
        None => SimpleResult::Err("Connection closed".to_string()),
    }
}

pub enum SimpleResult<T> {
    Ok(T),
    Err(String),
}
impl ConnectionTimeoutTracker {
    fn new() -> Self {
        Self { timeout_start: tokio::time::Instant::now(), to_wait: IDLE_TIMEOUT }
    }
    async fn timed_wait_for_rx<T>(&mut self, source: &mut T) -> SimpleResult<Message>
    where
        T: Stream<Item = tokio_tungstenite::tungstenite::Result<Message>> + Unpin,
    {
        let result = tokio::select! {
            biased;
            msg = next_msg(source) => msg,
            _ = tokio::time::sleep(self.to_wait) => SimpleResult::Err(String::from("Connection timed out due to inactivity")),
        };
        self.to_wait = IDLE_TIMEOUT - self.timeout_start.elapsed();
        result
    }
    fn refresh(&mut self) {
        self.timeout_start = tokio::time::Instant::now();
    }
}
async fn spawn_connection<S>(stream: S, socket_id: u64, state: State)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let ws_config = WebSocketConfig {
        max_message_size: Some(8192), // mirrors maxPayload: 8192 in the TS server
        max_frame_size: Some(8192),
        ..Default::default()
    };

    let ws_stream = match accept_async_with_config(stream, Some(ws_config)).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[SS] Handshake error (id={socket_id}): {e}");
            return;
        }
    };

    let (mut sink, mut source) = ws_stream.split();
    let (tx, mut rx) = mpsc::channel::<Message>(BUFFER_SIZE);

    state.lock().await.connections.insert(
        socket_id,
        ConnectionInfo { tx, local_addrs: HashSet::new(), remote_addrs: HashSet::new() },
    );
    println!("[SS] Connection opened (id={socket_id})");

    // Dedicated task that drains the outbound channel and writes to the sink.
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Message receive loop.
    let mut connection_timeout_tracker = ConnectionTimeoutTracker::new();
    let mut msg_limiter = MsgLimiter::new();
    loop {
        let msg = match connection_timeout_tracker.timed_wait_for_rx(&mut source).await {
            SimpleResult::Ok(m) => m,
            SimpleResult::Err(_) => break,
        };
        if !msg_limiter.check() {
            log::info!("[SS] Ignoring message from flagged connection (id={socket_id})");
            continue;
        }
        let routing_info = match get_routing_info(msg.clone()) {
            Some(data) => data,
            None => continue,
        };
        let result_report = {
            let mut s = state.lock().await;
            match record_and_q_forwarding(&mut s, socket_id, &routing_info, msg) {
                FwdResult::Result(info) => {
                    info
                },
                FwdResult::Forwarded(info) => {
                    connection_timeout_tracker.refresh();
                    info
                },
                FwdResult::FlagConnection(info) => {
                    msg_limiter.flag_bad_connection();
                    info
                }
            }
        };
        log::info!("{}", result_report);
    }

    log::info!("[SS] Removing routes for socket id={}", socket_id);
    // Clean up routing table entries and connection record on close.
    {
        let mut s = state.lock().await;
        if let Some(con) = s.connections.remove(&socket_id) {
            for addr in &con.local_addrs {
                s.r_table.remove(addr);
            }
            // Dst records will be removed on demand and will otherwise be removed at timeout.
        }
    }
    send_task.abort();
    println!("[SS] Connection closed (id={socket_id})");
}

// ── graceful shutdown ─────────────────────────────────────────────────────────

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate())
            .expect("failed to register SIGTERM handler");
        tokio::select! {
            _ = sigterm.recv()           => println!("[SS] SIGTERM received, shutting down"),
            _ = tokio::signal::ctrl_c() => println!("[SS] SIGINT received, shutting down"),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for Ctrl+C");
        println!("[SS] SIGINT received, shutting down");
    }
}

pub async fn run_server(addr: SocketAddr) {
    let state: State = Arc::new(Mutex::new(SharedState::default()));
    // Use nginx as reverse proxy to provide encryption
    let listener = TcpListener::bind(addr).await.expect("failed to bind TCP listener");

    // Pin shutdown future so it can be polled across loop iterations.
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    let mut next_id: u64 = 0;
    loop {
        tokio::select! {
            biased; // modifier to check shutdown first
            _ = &mut shutdown => break,
            result = listener.accept() => {
                match result {
                    Ok((stream, _peer)) => {
                        log::info!("[SS] New TCP connection from {}, assigning socket id={}", _peer.to_string(), next_id);
                        let socket_id = next_id;
                        next_id += 1;
                        let state = state.clone();
                        tokio::spawn(spawn_connection(stream, socket_id, state));
                    }
                    Err(e) => eprintln!("[SS] Accept error: {e}"),
                }
            }
        }
    }

    println!("[SS] Server stopped.");
}
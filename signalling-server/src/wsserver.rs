use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::BufReader;
use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
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

// ── wire types ────────────────────────────────────────────────────────────────

/// Only src/dst are needed for routing; payload and originType pass through.
#[derive(Deserialize)]
struct SSMsg {
    src: String,
    dst: String,
}

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
    tx: mpsc::UnboundedSender<Message>,
    local_addrs: Vec<String>,
}

struct SharedState {
    connections: HashMap<u64, ConnectionInfo>,
    /// Maps a registered source address to the socket-id that owns it.
    r_table: HashMap<String, u64>,
}

impl SharedState {
    fn new() -> Self {
        Self {
            connections: HashMap::new(),
            r_table: HashMap::new(),
        }
    }
}

type State = Arc<Mutex<SharedState>>;
pub fn hello() {
      println!("Hello from wsserver!");
}
// ── connection handler ────────────────────────────────────────────────────────

async fn handle_connection<S>(stream: S, socket_id: u64, state: State)
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
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    state.lock().await.connections.insert(
        socket_id,
        ConnectionInfo { tx, local_addrs: Vec::new() },
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
    while let Some(result) = source.next().await {
        let raw = match result {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("[SS] WebSocket error (id={socket_id}): {e}");
                break;
            }
        };

        // Accept text; treat binary as UTF-8 text (mirrors WS onmessage .toString()).
        // All other frame types (ping / pong / close) are skipped.
        let text = match &raw {
            Message::Text(t) => t.clone(),
            Message::Binary(b) => match String::from_utf8(b.clone()) {
                Ok(s) => s,
                Err(_) => continue,
            },
            _ => continue,
        };

        eprintln!("[SS] Incoming message (id={socket_id}): {text}");
        let data: SSMsg = match serde_json::from_str(&text) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[SS] Parse error (id={socket_id}): {e}");
                continue;
            }
        };

        let mut s = state.lock().await;

        // Reject if src is already claimed by a different connection.
        if let Some(&existing) = s.r_table.get(&data.src) {
            if existing != socket_id {
                eprintln!("[SS] Source already registered from different connection: {}", data.src);
                if let Some(c) = s.connections.get(&socket_id) {
                    let _ = c.tx.send(error_msg(
                        "Source already registered from a different connection",
                    ));
                }
                continue;
            }
        }

        // Reject if dst is unknown (self-addressing is always allowed).
        if data.dst != data.src && !s.r_table.contains_key(&data.dst) {
            eprintln!("[SS] Destination not found: {}", data.dst);
            if let Some(c) = s.connections.get(&socket_id) {
                let _ = c.tx.send(error_msg("Destination not found"));
            }
            continue;
        }

        // Enforce per-connection address limit (mirrors TS: > ROUTE_LIMIT).
        if s.connections.get(&socket_id).map_or(0, |c| c.local_addrs.len()) > ROUTE_LIMIT {
            if let Some(c) = s.connections.get(&socket_id) {
                let _ = c.tx.send(error_msg("too many refs, reset server registration"));
            }
            continue;
        }

        // Register / refresh src → this socket in the routing table.
        s.r_table.insert(data.src.clone(), socket_id);
        if let Some(c) = s.connections.get_mut(&socket_id) {
            c.local_addrs.push(data.src.clone());
        }

        // Self-registration message (announce / heartbeat) – nothing else to do.
        if data.dst == data.src {
            continue;
        }

        // Forward raw frame to destination socket.
        let dst_id = match s.r_table.get(&data.dst).copied() {
            Some(id) => id,
            None => {
                eprintln!("[SS] Destination connection lost mid-route: {}", data.dst);
                if let Some(c) = s.connections.get(&socket_id) {
                    let _ = c.tx.send(error_msg("Failed to find connection for destination"));
                }
                continue;
            }
        };

        if let Some(dst) = s.connections.get(&dst_id) {
            if dst.tx.send(raw).is_err() {
                eprintln!("[SS] Forward failed (dst id={dst_id})");
                if let Some(src) = s.connections.get(&socket_id) {
                    let _ = src.tx.send(error_msg("Failed to forward message"));
                }
            }
        } else {
            eprintln!("[SS] No live connection for dst id={dst_id}");
            if let Some(c) = s.connections.get(&socket_id) {
                let _ = c.tx.send(error_msg("Failed to find connection for destination"));
            }
        }
    }

    // Clean up routing table entries and connection record on close.
    let mut s = state.lock().await;
    if let Some(con) = s.connections.remove(&socket_id) {
        for addr in &con.local_addrs {
            s.r_table.remove(addr);
        }
    }
    drop(s);

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

// ── entry point ───────────────────────────────────────────────────────────────
pub async fn run_server() {
    let port: u16 = env::var("SS_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(9001);

    let state: State = Arc::new(Mutex::new(SharedState::new()));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr).await.expect("failed to bind TCP listener");

    // Pin shutdown future so it can be polled across loop iterations.
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    let mut next_id: u64 = 0;
    loop {
        tokio::select! {
            biased; // check shutdown first
            _ = &mut shutdown => break,
            result = listener.accept() => {
                match result {
                    Ok((stream, _peer)) => {
                        let socket_id = next_id;
                        next_id += 1;
                        let state = state.clone();
                        tokio::spawn(handle_connection(stream, socket_id, state));
                    }
                    Err(e) => eprintln!("[SS] Accept error: {e}"),
                }
            }
        }
    }

    println!("[SS] Server stopped.");
}
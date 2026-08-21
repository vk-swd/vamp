//! Generic WebSocket request/response server.
//!
//! Listens on the provided address and routes each incoming JSON request through
//! a caller-provided async handler object.

use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[async_trait]
pub trait WsMessageHandler: Send + Sync + 'static {
    async fn handle(&self, message: Message) -> Message;
}

/// Bind to `addr`, then spawn a background task that accepts WebSocket
/// connections and forwards parsed requests to `handler`.
pub async fn start(addr: SocketAddr, handler: Arc<dyn WsMessageHandler>) -> Result<tokio::task::JoinHandle<()>, String> {
    let listener = TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    println!("[WS] listening on {addr}");
    Ok(tokio::spawn(accept_loop(listener, handler)))
}

async fn accept_loop(listener: TcpListener, handler: Arc<dyn WsMessageHandler>) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let handler = handler.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, handler).await {
                        eprintln!("[WS] {peer}: {e}");
                    }
                });
            }
            Err(e) => eprintln!("[WS] accept error: {e}"),
        }
    }
}

async fn handle_connection(stream: tokio::net::TcpStream, handler: Arc<dyn WsMessageHandler>) -> Result<(), String> {
    let ws = accept_async(stream).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();

    while let Some(msg) = read.next().await {
        let message = match msg {
            Ok(message) => message,
            Err(_) => break,
        };

        let response = route(message, &*handler).await;
        if write.send(response).await.is_err() {
            break;
        }
    }
    Ok(())
}

async fn route(message: Message, handler: &dyn WsMessageHandler) -> Message {
    handler.handle(message).await
}

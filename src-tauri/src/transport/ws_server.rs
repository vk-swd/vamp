//! Generic WebSocket request/response server.
//!
//! Listens on the provided address and routes each incoming JSON request through
//! a caller-provided async handler object.

use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WsRequest<T = serde_json::Value> {
    pub id: u64,
    pub kind: String,
    pub payload: Option<T>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WsResponse<T = serde_json::Value> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> WsResponse<T> {
    pub fn ok(id: u64, value: T) -> Self {
        Self {
            id: Some(id),
            ok: Some(value),
            error: None,
        }
    }

    pub fn error(id: Option<u64>, message: impl Into<String>) -> Self {
        Self {
            id,
            ok: None,
            error: Some(message.into()),
        }
    }
}

#[async_trait]
pub trait WsMessageHandler: Send + Sync + 'static {
    async fn handle(&self, request: WsRequest<serde_json::Value>) -> Result<serde_json::Value, String>;
}

/// Bind to `addr`, then spawn a background task that accepts WebSocket
/// connections and forwards parsed requests to `handler`.
pub async fn start(addr: SocketAddr, handler: Arc<dyn WsMessageHandler>) -> Result<(), String> {
    let listener = TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    println!("[WS] listening on {addr}");
    tokio::spawn(accept_loop(listener, handler));
    Ok(())
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
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };

        let response = route(&text, &*handler).await;
        let response_text = serde_json::to_string(&response).map_err(|e| e.to_string())?;
        if write.send(Message::Text(response_text.into())).await.is_err() {
            break;
        }
    }
    Ok(())
}

async fn route(text: &str, handler: &dyn WsMessageHandler) -> WsResponse<serde_json::Value> {
    let request: WsRequest<serde_json::Value> = match serde_json::from_str(text) {
        Ok(request) => request,
        Err(e) => return WsResponse::error(None, e.to_string()),
    };
    let id = request.id;
    match handler.handle(request).await {
        Ok(value) => WsResponse::ok(id, value),
        Err(error) => WsResponse::error(Some(id), error),
    }
}

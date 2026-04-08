//! WebSocket server — mirrors the Tauri IPC `dispatch` command over a plain WebSocket.
//!
//! Listens on `127.0.0.1:8090`.  Every incoming text frame must be a JSON object
//! matching the same `{ "kind": "…", "payload": … }` schema used by the IPC dispatch.
//! Each command is executed against the shared repository and the result (or error)
//! is sent back as a JSON text frame: `{ "ok": <value> }` or `{ "error": "…" }`.

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::commands::dispatch::{execute, Command};
use crate::db::repository::ArcRepo;

/// Bind to `addr`, then spawn a background task that accepts WebSocket connections
/// and dispatches commands to `repo`.  Returns as soon as the listener is bound.
pub async fn start(repo: ArcRepo, addr: SocketAddr) -> Result<(), String> {
    let listener = TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    println!("[WS] listening on {addr}");
    tokio::spawn(accept_loop(listener, repo));
    Ok(())
}

async fn accept_loop(listener: TcpListener, repo: ArcRepo) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let repo = repo.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, repo).await {
                        eprintln!("[WS] {peer}: {e}");
                    }
                });
            }
            Err(e) => eprintln!("[WS] accept error: {e}"),
        }
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    repo: ArcRepo,
) -> Result<(), String> {
    let ws = accept_async(stream).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();

    while let Some(msg) = read.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };

        let response = route(&text, &repo).await;
        if write.send(Message::Text(response)).await.is_err() {
            break;
        }
    }
    Ok(())
}

/// Parse `{ "id": N, "kind": "…", "payload": … }`, execute the command, return a JSON reply.
/// The `id` field is echoed back so the client can match the response to its request.
async fn route(text: &str, repo: &ArcRepo) -> String {
    println!("[WS] received: {text}");
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return err_json(None, e.to_string()),
    };
    let id = v.get("id").cloned();
    let cmd: Command = match serde_json::from_value(v) {
        Ok(c) => c,
        Err(e) => return err_json(id.as_ref(), e.to_string()),
    };
    match execute(repo, cmd).await {
        Ok(val) => {
            let mut res = serde_json::json!({ "ok": val });
            if let Some(id) = &id { res["id"] = id.clone(); }
            println!("[WS] sending: {res}");
            res.to_string()
        }
        Err(e) => err_json(id.as_ref(), e),
    }
}

fn err_json(id: Option<&serde_json::Value>, msg: String) -> String {
    let mut res = serde_json::json!({ "error": msg });
    if let Some(id) = id { res["id"] = id.clone(); }
    res.to_string()
}

//! Secure WebSocket server (WSS) — mirrors the Tauri IPC `dispatch` command over TLS.
//!
//! Listens on `0.0.0.0:8090`.  Every incoming text frame must be a JSON object
//! matching the same `{ "kind": "…", "payload": … }` schema used by the IPC dispatch.
//! Each command is executed against the shared repository and the result (or error)
//! is sent back as a JSON text frame: `{ "ok": <value> }` or `{ "error": "…" }`.
//!
//! TLS certificate (`cert.pem`) and private key (`key.pem`) are loaded from the paths
//! passed to `start()`.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use rustls_pemfile::{certs, pkcs8_private_keys};
use tokio::net::TcpListener;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::commands::dispatch::{execute, Command};
use crate::db::repository::ArcRepo;

fn load_tls_config(cert_path: &Path, key_path: &Path) -> Result<ServerConfig, String> {
    let cert_file = std::fs::File::open(cert_path)
        .map_err(|e| format!("Cannot open cert {}: {e}", cert_path.display()))?;
    let key_file = std::fs::File::open(key_path)
        .map_err(|e| format!("Cannot open key {}: {e}", key_path.display()))?;

    let cert_chain = certs(&mut std::io::BufReader::new(cert_file))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Bad cert: {e}"))?;

    let mut keys = pkcs8_private_keys(&mut std::io::BufReader::new(key_file))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Bad key: {e}"))?;

    if keys.is_empty() {
        return Err("No PKCS8 private keys found in key file".to_string());
    }

    ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, keys.remove(0).into())
        .map_err(|e| e.to_string())
}

/// Bind to `addr` with TLS, then spawn a background task that accepts secure WebSocket
/// connections and dispatches commands to `repo`.  Returns as soon as the listener is bound.
pub async fn start(repo: ArcRepo, addr: SocketAddr, cert_path: &Path, key_path: &Path) -> Result<(), String> {
    let tls_config = load_tls_config(cert_path, key_path)?;
    let acceptor = TlsAcceptor::from(Arc::new(tls_config));

    let listener = TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    println!("[WSS] listening on {addr}");
    tokio::spawn(accept_loop(listener, repo, acceptor));
    Ok(())
}

async fn accept_loop(listener: TcpListener, repo: ArcRepo, acceptor: TlsAcceptor) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let repo = repo.clone();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, repo, acceptor).await {
                        eprintln!("[WSS] {peer}: {e}");
                    }
                });
            }
            Err(e) => eprintln!("[WSS] accept error: {e}"),
        }
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    repo: ArcRepo,
    acceptor: TlsAcceptor,
) -> Result<(), String> {
    let tls_stream = acceptor.accept(stream).await.map_err(|e| e.to_string())?;
    let ws = accept_async(tls_stream).await.map_err(|e| e.to_string())?;
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

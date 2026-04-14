use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Notify};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async_tls_with_config, Connector, tungstenite::{protocol::WebSocketConfig, Message}};
use rustls::{ClientConfig, RootCertStore};
use webrtc_sdp::{
    attribute_type::SdpAttributeType,
    media_type::SdpMediaValue,
    parse_sdp,
};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_gatherer_state::RTCIceGathererState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

const ICE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const ICE_GATHER_TIMEOUT: Duration = Duration::from_secs(5);

// ── wire type ─────────────────────────────────────────────────────────────────

#[derive(Deserialize, Serialize, Clone, Debug)]
struct WsMsg {
    src: String,
    dst: String,
    payload: String,
}

// ── offer validation ──────────────────────────────────────────────────────────

/// Parses the SDP string with `webrtc-sdp` (full grammar check) and then
/// verifies the structural requirements for a data-channel offer:
///   - Parses without error
///   - Contains at least one `application` (data-channel) m-line
///   - ICE credentials (ufrag + pwd) present at session or media level
///   - DTLS fingerprint present at session or media level
///   - DTLS setup role present at session or media level
fn validate_offer(sdp: &str) -> bool {
    let session = match parse_sdp(sdp, false) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[WSC] SDP parse failed: {e}");
            return false;
        }
    };

    // Must contain an application (data-channel) m-line.
    let app = match session
        .media
        .iter()
        .find(|m| *m.get_type() == SdpMediaValue::Application)
    {
        Some(m) => m,
        None => {
            eprintln!("[WSC] SDP missing application m-line");
            return false;
        }
    };

    // Each required attribute must appear at session level or on the app m-line.
    let required = [
        SdpAttributeType::IceUfrag,
        SdpAttributeType::IcePwd,
        SdpAttributeType::Fingerprint,
        SdpAttributeType::Setup,
    ];
    for attr in required {
        if session.get_attribute(attr.clone()).is_none() && app.get_attribute(attr.clone()).is_none() {
            eprintln!("[WSC] SDP missing a required ICE/DTLS attribute");
            return false;
        }
    }

    true
}

// ── WebRTC helpers ────────────────────────────────────────────────────────────

fn build_rtc_api() -> webrtc::error::Result<webrtc::api::API> {
    let mut media_engine = MediaEngine::default();
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)?;
    Ok(APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build())
}

// ── per-offer negotiation task ─────────────────────────────────────────────────

/// Full answer-side negotiation for a single offer:
///  1. Parse and apply the remote offer.
///  2. Create + set a local answer (gather ICE candidates).
///  3. Send the answer back via the signalling channel.
///  4. Wait up to [`ICE_CONNECT_TIMEOUT`] for ICE to connect; drop on timeout.
async fn negotiate_answer(
    offer_sdp: String,
    // Our own address — used as `src` in the reply message.
    reply_src: String,
    // The remote's address — used as `dst` in the reply, and in log messages.
    reply_dst: String,
    ws_tx: mpsc::UnboundedSender<Message>,
) -> webrtc::error::Result<()> {
    // ── Build peer connection ──────────────────────────────────────────────────
    let api = build_rtc_api()?;
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    };
    let pc = Arc::new(api.new_peer_connection(config).await?);

    // ── Register callbacks before any descriptions are set ────────────────────

    // Log data channels opened by the remote peer (answerer side; we accept, not create).
    pc.on_data_channel(Box::new(|dc| {
        let label = dc.label().to_owned();
        Box::pin(async move {
            println!("[WSC] DataChannel '{}' opened by remote", label);
        })
    }));

    // Signal when ICE candidate gathering is finished.
    let gathering_done = Arc::new(Notify::new());
    let gd = gathering_done.clone();
    pc.on_ice_gathering_state_change(Box::new(move |state: RTCIceGathererState| {
        let gd = gd.clone();
        Box::pin(async move {
            if state == RTCIceGathererState::Complete {
                gd.notify_one();
            }
        })
    }));

    // Signal when ICE connectivity is confirmed.
    let connected = Arc::new(Notify::new());
    let conn = connected.clone();
    pc.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
        
        let conn = conn.clone();
        Box::pin(async move {
            println!("[WSC] ICE state → {}", state);
            if matches!(
                state,
                RTCIceConnectionState::Connected | RTCIceConnectionState::Completed
            ) {
                conn.notify_one();
            }
        })
    }));

    // ── Apply offer, create and set local answer ───────────────────────────────
    pc.set_remote_description(RTCSessionDescription::offer(offer_sdp)?).await?;

    let answer = pc.create_answer(None).await?;
    // Triggers ICE candidate gathering.
    pc.set_local_description(answer).await?;

    // Wait for gathering to complete so the answer SDP contains all candidates.
    if timeout(ICE_GATHER_TIMEOUT, gathering_done.notified())
        .await
        .is_err()
    {
        eprintln!(
            "[WSC] ICE gathering did not complete within {:?} — sending partial answer",
            ICE_GATHER_TIMEOUT
        );
    }

    // ── Send completed answer back to the offerer ──────────────────────────────
    let local_sdp = match pc.local_description().await {
        Some(d) => d.sdp,
        None => {
            eprintln!("[WSC] No local description available after gathering");
            return Ok(());
        }
    };

    let reply = WsMsg {
        src: reply_src,
        dst: reply_dst.clone(),
        payload: local_sdp,
    };
    if ws_tx
        .send(Message::Text(
            serde_json::to_string(&reply).expect("reply serialization is infallible"),
        ))
        .is_err()
    {
        eprintln!("[WSC] WebSocket send channel closed before answer could be delivered");
        return Ok(());
    }
    println!("[WSC] Answer sent to '{}'", reply.dst);

    // ── Await ICE connection (10-second deadline) ──────────────────────────────
    match timeout(ICE_CONNECT_TIMEOUT, connected.notified()).await {
        Ok(_) => println!("[WSC] ICE connection established with '{}'", reply_dst),
        Err(_) => {
            eprintln!(
                "[WSC] ICE connection to '{}' timed out after {:?} — dropping peer connection",
                reply_dst, ICE_CONNECT_TIMEOUT
            );
            let _ = pc.close().await;
        }
    }

    Ok(())
}

// ── offer dispatcher ──────────────────────────────────────────────────────────

async fn handle_offer(
    offer_sdp: String,
    // `src` from the inbound message (the remote peer's address).
    incoming_src: String,
    // `dst` from the inbound message (our registered address).
    incoming_dst: String,
    ws_tx: mpsc::UnboundedSender<Message>,
) {
    if !validate_offer(&offer_sdp) {
        eprintln!(
            "[WSC] Offer from '{}' failed validation \
             (missing data-channel m-line or ICE credentials) — dropping",
            incoming_src
        );
        return;
    }

    // Swap src/dst: their address becomes our dst, our address becomes our src.
    if let Err(e) = negotiate_answer(offer_sdp, incoming_dst, incoming_src, ws_tx).await {
        eprintln!("[WSC] Negotiation error: {e}");
    }
}

// ── public entry point ────────────────────────────────────────────────────────

/// Connects to the signalling server at `server_url`, registers `src_addr`,
/// and processes incoming ICE offer messages until the connection is closed.
pub async fn run_client(server_url: &str, src_addr: String) {
    let ws_config = WebSocketConfig {
        max_message_size: Some(8192),
        max_frame_size: Some(8192),
        ..Default::default()
    };

    let mut root_store = RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls_config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    let connector = Connector::Rustls(Arc::new(tls_config));

    let (ws_stream, _) = match connect_async_tls_with_config(server_url, Some(ws_config), false, Some(connector)).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[WSC] Failed to connect to {server_url}: {e}");
            return;
        }
    };
    println!("[WSC] Connected to {server_url}");

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    // All outbound messages from offer-handler tasks are queued here and
    // written to the WebSocket sink by a dedicated send task.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();

    tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Self-registration: lets the signalling server know our address.
    let reg = WsMsg {
        src: src_addr.clone(),
        dst: src_addr.clone(),
        payload: String::new(),
    };
    if out_tx
        .send(Message::Text(serde_json::to_string(&reg).unwrap()))
        .is_err()
    {
        eprintln!("[WSC] Failed to enqueue registration message");
        return;
    }
    println!("[WSC] Registered as '{src_addr}'");

    // ── Receive loop ──────────────────────────────────────────────────────────
    while let Some(result) = ws_source.next().await {
        let raw = match result {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[WSC] Receive error: {e}");
                break;
            }
        };

        let text = match &raw {
            Message::Text(t) => t.clone(),
            Message::Binary(b) => match String::from_utf8(b.clone()) {
                Ok(s) => s,
                Err(_) => continue,
            },
            _ => continue,
        };

        let msg: WsMsg = match serde_json::from_str::<WsMsg>(&text) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[WSC] Message parse error: {e}");
                continue;
            }
        };

        if msg.src == "error" {
            eprintln!("[WSC] Server error: {}", msg.payload);
            continue;
        }

        // Self-registration echoes and heartbeat messages carry an empty payload.
        if msg.payload.is_empty() {
            continue;
        }

        println!("[WSC] Received offer from '{}' for '{}'", msg.src, msg.dst);

        tokio::spawn(handle_offer(
            msg.payload.clone(),
            msg.src.clone(),
            msg.dst.clone(),
            out_tx.clone(),
        ));
    }

    println!("[WSC] Disconnected from signalling server");
}



enum WRTCState {
    Idle,
    Connected,
    Failed
}
use uuid::Uuid;


struct WRTCConnection {

}

struct WSConnection {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    state: WRTCState,
}
impl WSConnection {
    fn new(socket: WebSocketStream<MaybeTlsStream<TcpStream>>) -> Self {
        WSConnection {
            socket,
            state: WRTCState::Idle,
        }
    }
    async fn get() {
        // get the message from the socket
    }
    async fn send(&self, msg: &str) {
        // send the message to the socket
    }
}
impl WRTCConnection {
    async fn new() -> Self {
        let id = Uuid::new_v4().simple().to_string();
        // connect to signalling server
        // wait for some offer
        // try establish connection
        // if anything fails
        //  1. Before the connection - drop everything and restart with new code.
        //  2. After the connection - tretry with the same code, until it is manually dropped.
        WRTCConnection {}
    }
    async fn connectToSignallingServer(&self) {
        // the connection polls the messages and expects incoming offer
        // when offer comes, it tries to generate an answer and get to the next level.
        // if it fails, it should stop trying because it would mean that either the offer was bad or
        // or that the answer is impossible to generate.
        // either way, a response should be relayed back
        // and the operation should be cancelled.
        // what if more then one offer arrives? this should not be expected....single device per connection.
        // connect to signalling server
    }
    async fn waitForOffer(&self) {
        // wait for some offer
    }
    async fn establishConnection(&self) {
        // try establish connection
    }
    async fn handleFailure(&self) {
        self.connectToSignallingServer().await;
        // if anything fails
        //  1. Before the connection - drop everything and restart with new code.
        //  2. After the connection - tretry with the same code, until it is manually dropped.
    }
}

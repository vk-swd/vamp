// use std::net::TcpStream;
use tokio::net::TcpStream;
use tokio::spawn;
use webrtc::data;
use webrtc::data::data_channel::DataChannel;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::dtls::conn;
use webrtc::error::Result;
use webrtc::ice_transport::ice_candidate::RTCIceCandidate;
use webrtc::peer_connection::RTCPeerConnection;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify, mpsc};
use tokio::time::timeout;

use tokio_tungstenite::{WebSocketStream, MaybeTlsStream};
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

use crate::common::{MyErr, MyRes};

const ICE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const ICE_GATHER_TIMEOUT: Duration = Duration::from_secs(5);

// ── wire type ─────────────────────────────────────────────────────────────────
use super::dc::openDC;

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

fn build_rtc_api() -> MyRes<webrtc::api::API> {
    let mut media_engine = MediaEngine::default();
    let mut registry = Registry::new();
    registry = match register_default_interceptors(registry, &mut media_engine) {
        Ok(r) => r,
        Err(e) => return Err(Box::new(e)),
    };
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
/// 
struct WRTCConnection {
    // Fields for managing the connection would go here.
    dc: Arc<RTCDataChannel>,
    pc: Arc<RTCPeerConnection>
}


fn defaultRTCConfig() -> RTCConfiguration {
    RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["turns:username1:passVeryh@hamsterworks.org:9011".to_owned()],
            username: "username1".to_owned(),
            credential: "passVeryh".to_owned(),
            credential_type: webrtc::ice_transport::ice_credential_type::RTCIceCredentialType::Password,
            ..Default::default()
        }],
        ..Default::default()
    }
}

enum WRTCState {
    Idle,
    Connected,
    Failed
}
use uuid::Uuid;

fn defaultWsConfig() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(8192),
        max_frame_size: Some(8192),
        ..Default::default()
    }
}

async fn connectToSS(config: &WsConfig) -> MyRes<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>> {
    if (!config.is_tls) {
        log::info!("[WSC] Connecting to url '{}'", config.url);
        return match tokio_tungstenite::connect_async(&config.url).await {
            Ok(s) => Ok(s.0),
            Err(e) => {
                eprintln!("[WSC] Failed to connect to {}: {}", config.url, e);
                return Err(Box::new(e));
            }
        };
    }
    let mut root_store = RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls_config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    let connector = Connector::Rustls(Arc::new(tls_config));
    log::info!("[WSC] Connecting to url '{}'", config.url);
    return match connect_async_tls_with_config(&config.url, Some(defaultWsConfig()), false, Some(connector)).await {
        Ok(s) => Ok(s.0),
        Err(e) => {
            eprintln!("[WSC] Failed to connect to {}: {}", config.url, e);
            return Err(Box::new(e));
        }
    };
}
// ── public entry point ────────────────────────────────────────────────────────
type WsSink = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, Message>;
type WsStream = futures_util::stream::SplitStream<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>>;

// returns false when the outer reconnect loop should stop
async fn ws_receive_loop(abort: &Notify, read: &mut WsStream, ingress_out: &mpsc::Sender<Message>) -> bool {
    loop {
        let data = tokio::select! {
            _ = abort.notified() => return false,
            msg = read.next() => match msg {
                Some(Ok(m)) => m,
                Some(Err(e)) => {
                    eprintln!("[WSC] Error receiving message: {e}");
                    break;
                }
                None => {
                    log::info!("[WSC] Connection closed by server");
                    break;
                }
            }
        };
        ingress_out.try_send(data).ok();
    }
    true
}

async fn ws_send_loop(abort: Arc<Notify>, mut write: WsSink, mut egress_q_getter: mpsc::Receiver<Message>) -> mpsc::Receiver<Message> {
    loop {
        tokio::select! {
            _ = abort.notified() => break,
            msg = egress_q_getter.recv() => match msg {
                Some(msg) => {
                    match write.send(msg).await {
                        Err(e) => {
                            // Let sender know? Just log it and  dont do retries for now.
                            // Otherwise make a local queue for retries.
                            eprintln!("[WSC] Failed to send message: {e}");
                            break;
                        }
                        _ => {}
                    }
                }
                None => {
                    // This shouldn't happen though, unless the other end was destroyed.
                    log::info!("[WSC] Egress buffer closed, stopping sender task");
                    break;
                }
            }
        }
    }
    egress_q_getter
}

#[derive(Clone)]
struct WsConfig {
    url: String,
    is_tls: bool,
}

struct WsHandle {
    ingress: mpsc::Receiver<Message>,
    egress_q_putter: mpsc::Sender<Message>,
    abort: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

fn connect_to_ws(config: WsConfig) -> WsHandle {
    /* Minimal implementation of websocket reconnection logic
        The user does not have to know about the reconnection. 
        It will either send and receive or will wait untill its own timeout.
        Bad address is not handled here - global timeout for ICE connection breaks bad attempts.
     */
    let (tx, rx) = mpsc::channel::<Message>(100);
    let (egress_q_putter, out_rx) = mpsc::channel::<Message>(100);
    let abort = Arc::new(Notify::new());
    let abort_notify = abort.clone();
    let task = tokio::spawn(async move {
        let mut egress_q_getter = out_rx;
        let ingress_out = tx;
        let mut keep_reconnecting = true;
        while keep_reconnecting {
            let connection = match connectToSS(&config).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[WSC] Failed to connect to signalling server: {e}");
                    // wait a bit and try again
                    tokio::select! {
                        _ = abort_notify.notified() => break,
                        _ = tokio::time::sleep(Duration::from_secs(1)) => continue
                    }
                }
            };
            let (write, mut read) = connection.split();
            let abort_send = Arc::new(Notify::new());
            let handle = tokio::spawn(ws_send_loop(abort_send.clone(), write, egress_q_getter));
            keep_reconnecting = ws_receive_loop(&abort_notify, &mut read, &ingress_out).await;
            abort_send.notify_waiters();
            egress_q_getter = handle.await.unwrap();
        }
    });
    WsHandle { ingress: rx, egress_q_putter, abort, task }
}

impl WsHandle {
    fn close(&self) {
        self.abort.notify_waiters();
    }
    fn send(&self, msg: Message) -> MyRes {
        self.egress_q_putter.try_send(msg).map_err(|e| e.to_string().into())
    }
    async fn nextMsg(&mut self) -> MyRes<Message> {
        let ws_end = &mut (self.task);
        tokio::select! {
            _ = ws_end => Err("WebSocket task ended".into()),
            msg = self.ingress.recv() => match msg {
                Some(m) => Ok(m),
                None => Err("WebSocket connection closed".into())
            }
        }
    }
}

struct IceCon {
    offer: String,
    config: RTCConfiguration,
    data_channel: Arc<RTCDataChannel>,
    pc: Arc<RTCPeerConnection>
}


fn make_register_msg(session_id: String) -> WsMsg {
    WsMsg {
        src: session_id.clone(),
        dst: session_id.clone(),
        payload: String::new(),
    }
}

async fn await_offer(ws_handle: &mut WsHandle) -> MyRes<WsMsg> {
    loop {
        let msg = ws_handle.nextMsg().await;
        let ws_message = match msg {
            Ok(message) => message,
            Err(e) => { return Err(e) }
        };
        let text = match ws_message {
            Message::Text(raw) => raw,
            _ => {
                println!("[WSC] Received non-text message: '{ws_message:?}'");
                continue;
            }
        };
        let parsed_msg = match serde_json::from_str::<WsMsg>(&text) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("[WSC] Failed to parse message as JSON: {e}");
                continue;
            }
        };
        if !validate_offer(&parsed_msg.payload) {
            log::info!("invalid offer {:?}", parsed_msg.payload);
            continue;
        }
        return Ok(parsed_msg);
    };
}
async fn run_client1(ws_conf: WsConfig, session_id: String) {
    loop {
        let mut ws_handle = connect_to_ws(ws_conf.clone());
        match ws_handle.send(Message::Text(serde_json::to_string(&make_register_msg(session_id.clone())).unwrap())) {
            Ok(_) => (),
            Err(e) => {
                eprintln!("[WSC] Failed to send registration message: {e}");
                continue;
            }
        }
        // let ws_end = &mut (ws_handle.task);
        let offer = tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(100)) => {
                continue; // Timeout waiting for offer, reconnect
            }
            msg = await_offer(&mut ws_handle) => {
                match msg {
                    Ok(message) => message,
                    Err(e) => {
                        eprintln!("[WSC] Error receiving message: {e}. Reconnect to signalling server.");
                        continue;
                    }
                }
            }
        };


    }
}

struct IceHandle {
    answer: String,
    dc: Arc<std::sync::Mutex<Option<Arc<RTCDataChannel>>>>,
    dc_ready: Arc<Notify>,
    pc: Arc<RTCPeerConnection>
}

async fn start_ice(offer: String) -> MyRes<IceHandle> {
    let api = build_rtc_api()?;
    let pc = Arc::new(api.new_peer_connection(defaultRTCConfig()).await?);

    let dc: Arc<std::sync::Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(std::sync::Mutex::new(None));
    let dc_ready = Arc::new(Notify::new());
    let (dc_clone, ready_clone) = (dc.clone(), dc_ready.clone());
    pc.on_data_channel(Box::new(move |chan: Arc<RTCDataChannel>| {
        let (dc_clone, ready_clone) = (dc_clone.clone(), ready_clone.clone());
        chan.on_open(Box::new(move || {
            dc_clone.lock().unwrap().replace(chan.clone());
            ready_clone.notify_one();
            Box::pin(async move {})
        }));
        Box::pin(async move {})
    }));

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
    
    pc.set_remote_description(RTCSessionDescription::offer(offer)?).await?;
    let answer = pc.create_answer(None).await?;
    pc.set_local_description(answer).await?;

    gathering_done.notified().await;
    pc.close().await?;
    let answer_sdp = match pc.local_description().await {
        Some(desc) => desc.sdp,
        None => return Err("no local description after gathering".into()),
    };

    Ok(IceHandle { answer: answer_sdp, dc, dc_ready, pc })
}
/// Connects to the signalling server at `server_url`, registers `src_addr`,
/// and processes incoming ICE offer messages until the connection is closed.
use std::time::Instant;
pub async fn run_client(server_url: &str, src_addr: String) {
    //        let selectedPair = pc.sctp.transport.iceTransport.getSelectedCandidatePair()
    log::info!("[WSC] Starting client with source address '{src_addr}'");
    let mut connection = match connectToSS(server_url).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[WSC] Failed to connect to signalling server: {e}");
            return;
        }
    };
    let reg = Message::Text(serde_json::to_string(&WsMsg {
        src: src_addr.clone(),
        dst: src_addr.clone(),
        payload: String::new(),
    }).unwrap());
    log::info!("[WSC] Sending registration message for source address '{src_addr}'");
    let (mut write, mut read) = connection.split();
    // use request ids to ignore duplicate offer sends - sender is not notified of any delivery.



    let write_ptr = Arc::new(tokio::sync::Mutex::new(write));
    if let Err(e) = write_ptr.lock().await.send(reg).await {
        eprintln!("[WSC] Failed to send registration message: {e}");
        return;
    }
    let mut start = Instant::now();

    log::info!("[WSC] waiting for messages '{src_addr}'");
    let mut incomingMsgCount = 0;
    let flag = Arc::new(AtomicBool::new(false));
    loop {
        let next_msg = read.next().await;
        if flag.load(Ordering::SeqCst) {
            continue;
        }
        let (sdp, offer_src) = match next_msg {
            Some(Ok(Message::Text(raw))) => {
                match serde_json::from_str::<WsMsg>(&raw) {
                    Ok(msg) => (msg.payload, msg.src),
                    Err(e) => {
                        eprintln!("[WSC] Failed to parse message as JSON: {e}");
                        continue;
                    }
                }
            },
            Some(Ok(m)) => {
                println!("[WSC] Received non-text message: '{m:?}'");
                continue;
            }
            Some(Err(e)) => {
                eprintln!("[WSC] Error receiving message: {e}");
                break;
            }
            None => {
                log::info!("[WSC] Connection closed by server");
                break;
            }
        };
        flag.store(true, Ordering::SeqCst);
        let write_clone = write_ptr.clone();
        let my_addr = src_addr.clone();
        tokio::spawn(async move {
            let wrtc_con = 
            openDC(sdp, 
                defaultRTCConfig(), 
                |answer| {
                    log::info!("[WSC] Delivering answer back to server");
                    let wc = write_clone.clone();
                    let reply = serde_json::to_string(&WsMsg {
                        src: my_addr.clone(),
                        dst: offer_src.clone(),
                        payload: answer,
                    }).unwrap();
                    async move {
                        wc.lock().await.send(Message::Text(reply)).await
                            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
                    }
                }
            ).await;
            let wcon = match wrtc_con {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[WSC] WebRTC connection failed: {e}");
                    return;
                }
            };
            log::info!("[WSC] WebRTC connection established successfully");
            wcon.dc.on_message(Box::new(move |msg| {
                if msg.is_string {
                    log::info!("[WSC] Received message over DataChannel ({})", match std::str::from_utf8(&msg.data) {
                        Ok(s) => s,
                        Err(_) => "[Invalid UTF-8]",
                    });
                }
                Box::pin(async move {})
            }));
            let sizesent = wcon.dc.send_text("hellooooo").await;
            // match sizesent.await {
            //     Ok(s) => (),
            //     Err(e) => {
            //         eprintln!("[WSC] Failed to send data over DataChannel: {e}");
            //         return;
            //     }
            // };
            // 5;
            // log::info!("[WSC] WebRTC sent '{}' bytes over dc", sizesent);
        });

        // println!("[WSC] Received ws msg: '{:?}'", next_msg);
    }
}


use std::sync::Arc;

use sea_query::Keyword::Null;
use tokio::sync::{Mutex, Notify, mpsc};

use tokio::time::{sleep, timeout, Duration};
use webrtc::Error::new;
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::ice_transport::ice_candidate::RTCIceCandidate;
use webrtc::ice_transport::ice_candidate_type::RTCIceCandidateType;
use webrtc::ice_transport::ice_gatherer_state::RTCIceGathererState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtcp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream, tungstenite::Message};
use uuid::Uuid;

fn log(msg: &str) {
    let now_text: String = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
    println!("[SS] {} {}", now_text, msg);
}

async fn test_p2() {
    log("test_p2 started");
    log("test_p2 started1");
    sleep(Duration::from_secs(1)).await;
    log("test_p2 started2");
    log("test_p2 started3");
    sleep(Duration::from_secs(1)).await;
    log("test_p2 started4");
    log("test_p2 started5");
    sleep(Duration::from_secs(1)).await;
    log("test_p2 finished");
}
async fn test_p3() {
    const II: i32 = 1;
    log("test_p3 started");
    log("test_p3 started1");
    sleep(Duration::from_secs(3)).await;
    log(&format!("test_p3 finished {}", II));
}

async fn test_circle(qprod: mpsc::Sender<String>, mut qcons: mpsc::Receiver<String>, label: String) {
    log(&format!("{} test_circle started", label));
    let msg: String = format!("{} test_circle sent", label);
    qprod.try_send(msg.clone()).unwrap();
    log(&format!("{} test_circle sent {}", label, msg));
    let msg1: String = qcons.recv().await.unwrap();
    log(&format!("{} test_circle received {}", label, msg1));
}

async fn test_p1() {
    let (qprod1, qcons1) = mpsc::channel::<String>(10);
    let (qprod2, qcons2) = mpsc::channel::<String>(10);
    tokio::select! {
        _ = test_p2() => {},
        _ = test_p3() => {},
        _ = sleep(Duration::from_secs(2)) => {
            log("test_p1 timeout");
        }
    }
    log("test_p1 finished");
}


async fn test_circle_main() {
    let (qprod1, qcons1) = mpsc::channel::<String>(10);
    let (qprod2, qcons2) = mpsc::channel::<String>(10);
    let (qprod3, qcons3) = mpsc::channel::<String>(10);
    let (qprod4, qcons4) = mpsc::channel::<String>(10);
    
    tokio::select! {
            biased;
        _ = test_circle(qprod2.clone(), qcons1, "A".to_string()) => {},
        _ = test_circle(qprod3.clone(), qcons2, "B".to_string()) => {},
        _ = test_circle(qprod4.clone(), qcons3, "C".to_string()) => {},
        _ = test_circle(qprod1.clone(), qcons4, "D".to_string()) => {}
        }
}

async fn test_circle_main1() {
    let (qprod1, qcons1) = mpsc::channel::<String>(10);
    let (qprod2, qcons2) = mpsc::channel::<String>(10);
    let (qprod3, qcons3) = mpsc::channel::<String>(10);
    let (qprod4, qcons4) = mpsc::channel::<String>(10);
    
    tokio::select! {
            biased;
        _ = test_circle(qprod1.clone(), qcons4, "A".to_string()) => {},
        _ = test_circle(qprod1.clone(), qcons3, "B".to_string()) => {},
        _ = test_circle(qprod4.clone(), qcons2, "C".to_string()) => {}
        }
}

fn get_join_handle(callback: Option<impl Fn(u64) + Send + 'static>) -> (tokio::task::JoinHandle<mpsc::Receiver<u64>>, mpsc::Sender<u64>) {
    let (tx, mut rx) = mpsc::channel::<u64>(10);
    let handle = tokio::spawn(async move {
        let num = rx.recv().await.unwrap();
        if let Some(cb) = callback {
            cb(num);
        }
        return rx;
    });
    return (handle, tx);
}
async fn infiniteCall() {
    loop {
        log("infiniteCall loop");
        sleep(Duration::from_secs(1)).await;
    }
}
async fn join_handle_test() {
    let (_handle, _tx) = get_join_handle(Some(|num| {}));
    tokio::spawn(async move {
        log("handle waiter spawned sleeper");
        sleep(Duration::from_secs(2)).await;
        _tx.send(1).await.unwrap();
        log("handle waiter sent 1");
    });
    tokio::select! {
        biased;
        _ = _handle => {
            log("handleWaiter finished");
        },
        _ = infiniteCall() => {
            log("handleWaiter timeout")
        }
    }
}
// Reads COTURN_IP/COTURN_PORT/STUN_CREDENTIALS (see test/yamls/services/backend.yaml,
// test_net_env, test/yamls/.env) and builds the single-entry ice_servers list used to
// reach the coturn server started by the `sigturn` service.
fn coturn_ice_servers_from_env() -> Vec<RTCIceServer> {
    let coturn_ip = std::env::var("COTURN_IP").expect("COTURN_IP env var not set (see test/yamls/services/backend.yaml)");
    let coturn_port = std::env::var("COTURN_PORT").expect("COTURN_PORT env var not set (see test_net_env)");
    let stun_credentials = std::env::var("STUN_CREDENTIALS").expect("STUN_CREDENTIALS env var not set (see test/yamls/.env)");
    let (stun_username, stun_credential) = stun_credentials
        .split_once(':')
        .expect("STUN_CREDENTIALS must be of the form username:password");

    vec![RTCIceServer {
        urls: vec![format!("turn:{}:{}", coturn_ip, coturn_port)],
        username: stun_username.to_owned(),
        credential: stun_credential.to_owned(),
        ..Default::default()
    }]
}

// Builds a peer connection with a default API (default MediaEngine + interceptors)
// and the coturn ice_servers from env (see coturn_ice_servers_from_env). Used by every
// webrtc test in this file so they all negotiate against the same TURN/STUN setup.
async fn new_default_peer_connection() -> Arc<RTCPeerConnection> {
    let mut media_engine = MediaEngine::default();
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine).unwrap();
    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();

    let conf = RTCConfiguration {
        ice_servers: coturn_ice_servers_from_env(),
        ..Default::default()
    };
    Arc::new(api.new_peer_connection(conf).await.unwrap())
}

async fn test_webrtc_fresh_rollback() {
    let pc = new_default_peer_connection().await;
    // creating a connection and setting local description


    log(&format!("signal state after creation is {}", pc.signaling_state()));

    let offer = pc.create_offer(None).await.unwrap();
    let rollbackofferjson = serde_json::json!({
        "type": "rollback",
        "sdp": offer.sdp.to_string()
    });
    let offerclone = offer.clone();
    pc.set_local_description(offer).await.unwrap();
    log(&format!("signal state after  set_local_description is {}", pc.signaling_state()));
    // creating a rollback offer
    let desc: RTCSessionDescription = serde_json::from_value(rollbackofferjson).unwrap();
    pc.set_local_description(offerclone).await.unwrap();
    log(&format!("signal state after rollvback is {}", pc.signaling_state()));

    pc.on_ice_candidate(Box::new(move |candidate| {
        Box::pin(async move {
            log(&format!("ICE candidate: {:?}", candidate));
        })
    }));
    pc.on_ice_gathering_state_change(Box::new(move |state| {
        Box::pin(async move {
            log(&format!("ICE gathering state changed: {:?}", state));
        })
    }));
    sleep(Duration::from_secs(5)).await;
    log("making offer for restart");
    let restart_offer = pc.create_offer(Some(webrtc::peer_connection::offer_answer_options::RTCOfferOptions {
        ice_restart: true,
        ..Default::default()
    })).await.unwrap();
    log("made offer for restart");
    pc.set_local_description(restart_offer).await.unwrap();
    log("set offer for restart");
    sleep(Duration::from_secs(5)).await;
    log("finished test_webrtc_fresh_rollback");

    pc.create_answer(None).await.unwrap();
}

struct HandleKeeper {
    handle: tokio::task::JoinHandle<mpsc::Receiver<u64>>,
}
impl HandleKeeper {
    // async fn awaithim(&mut self) -> mpsc::Receiver<u64> {
    //     self.handle.await.unwrap()
    // }
}
async fn wait_same_join_handle() {
    let (handle, tx) = get_join_handle(Some(|num| {}));
    let mut handle_heeper = HandleKeeper { handle };
    for i in 0..2 {
        tokio::select! {
            biased;
            _ = &mut handle_heeper.handle => {
                log(&format!("handleWaiter finished on iteration {}", i));
            },
            _ = sleep(Duration::from_secs(1)) => {
                log(&format!("slept through {} handle wait", i));
            }
        }
        tx.send(1).await.unwrap();
    }
}

async fn notifyer_experimetn() {
    let notifyer = Arc::new(Notify::new());
    let notifyer_clone = notifyer.clone();
    let (handle, tx) = get_join_handle(Some(move |num| {
        notifyer_clone.notify_one();
    }));
    tokio::select! {
        biased;
        _ = sleep(Duration::from_secs(1)) => {
            log("handleWaiter finished");
        },
        _ = notifyer.notified() => {
            log("notifyer_experimetn notified");
        }
    }
    tx.send(1).await.unwrap();
    log("notifyer_experimetn sent 1");
    
    tokio::select! {
        biased;
        _ = sleep(Duration::from_secs(1)) => {
            log("handleWaiter finished 1");
        },
        _ = notifyer.notified() => {
            log("notifyer_experimetn notified 1");
        }
    }
    log("notifyer_experimetn notified 2");
    notifyer.notify_one();
    notifyer.notified().await;
    
    log("notifyer_experimetn notified 3");
    notifyer.notify_one();
    notifyer.notify_one();
    notifyer.notify_one();
    notifyer.notify_one();
    notifyer.notified().await;
    log("notifyer_experimetn notified 4");
    
    notifyer.notify_one();
    sleep(Duration::from_secs(1)).await;
    notifyer.notified().await;
    log("notifyer_experimetn notified 5");

}


// test/yamls/services/sigturn.yaml / test_net_env) and checks that ICE gathering
// yields both a server reflexive (srflx, from STUN) and a relay (from TURN) candidate,
// at the addresses that the sigturn/vps_front configuration says they should arrive at:
// - the relay candidate's address must be VPS_EDGE_IP, since that's the `external-ip`
//   coturn is configured to advertise (see test/turn/turnserver.conf.template) and the
//   address vps_front DNATs back to sigturn (see test/yamls/services/vps_front.yaml).
// - the srflx candidate's address must be NAT_A_EDGE_IP, since that's the static address
//   nat_backend masquerades backend's outbound traffic to (see
//   test/yamls/services/nat_backend.yaml).
async fn test_ice_candidates_collection() {
    let nat_a_edge_ip = std::env::var("NAT_A_EDGE_IP").expect("NAT_A_EDGE_IP env var not set (see test_net_env)");
    let vps_edge_ip = std::env::var("VPS_EDGE_IP").expect("VPS_EDGE_IP env var not set (see test/yamls/services/backend.yaml)");

    let pc = new_default_peer_connection().await;

    // A data channel is required so the offer has an m-line to gather candidates for.
    let _dc = pc.create_data_channel("probe", None).await.unwrap();

    let found_candidates: Arc<Mutex<Vec<(RTCIceCandidateType, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let found_candidates_cb = found_candidates.clone();
    pc.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
        let found_candidates_cb = found_candidates_cb.clone();
        Box::pin(async move {
            if let Some(candidate) = candidate {
                log(&format!("ICE candidate: {}", candidate));
                found_candidates_cb.lock().await.push((candidate.typ, candidate.address.clone()));
            }
        })
    }));

    let gathering_done = Arc::new(Notify::new());
    let gathering_done_cb = gathering_done.clone();
    pc.on_ice_gathering_state_change(Box::new(move |state: RTCIceGathererState| {
        let gathering_done_cb = gathering_done_cb.clone();
        Box::pin(async move {
            if state == RTCIceGathererState::Complete {
                gathering_done_cb.notify_one();
            }
        })
    }));

    let offer = pc.create_offer(None).await.unwrap();
    pc.set_local_description(offer).await.unwrap();

    tokio::select! {
        _ = gathering_done.notified() => {},
        _ = sleep(Duration::from_secs(10)) => {
            log("ICE gathering timed out");
        }
    }

    let candidates = found_candidates.lock().await;
    log(&format!("collected candidates: {:?}", *candidates));

    let srflx_candidate = candidates.iter().find(|(typ, _)| *typ == RTCIceCandidateType::Srflx);
    assert!(srflx_candidate.is_some(), "no server reflexive candidate collected");
    let (_, srflx_addr) = srflx_candidate.unwrap();
    assert_eq!(
        srflx_addr, &nat_a_edge_ip,
        "srflx candidate address {} does not match NAT_A_EDGE_IP {} (nat_backend's masquerade address)",
        srflx_addr, nat_a_edge_ip
    );

    let relay_candidate = candidates.iter().find(|(typ, _)| *typ == RTCIceCandidateType::Relay);
    assert!(relay_candidate.is_some(), "no relay candidate collected");
    let (_, relay_addr) = relay_candidate.unwrap();
    assert_eq!(
        relay_addr, &vps_edge_ip,
        "relay candidate address {} does not match VPS_EDGE_IP {} (coturn's configured external-ip)",
        relay_addr, vps_edge_ip
    );
}





// ── signalling + datachannel handshake test ───────────────────────────────────
// Uses the real signalling server (see src-tauri/signalling/ws_server.rs and
// src-tauri/signalling/memo.md for the message/routing protocol) to receive an
// offer from another service under a well-known routing tag, then verifies a
// "hello" / "what is your name" exchange over the opened data channel.
//
// Wire format matches WireMessage in ws_server.rs: {"tag": <routing tag>, "payload": <sdp>}.
// A message with no "payload" only registers the connection under the routing tag
// (see memo.md HS2); the routing record forwards the next payload-bearing message
// sent under the same tag to the peer that registered first (HS4). So we must
// register (no payload) before the offering service sends its offer, or the offer
// would be dropped with no other participant to forward to.

type WsRead = futures_util::stream::SplitStream<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>>;
type WsWrite = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, Message>;

// Connects to the signalling server, retrying on failure (e.g. server not up yet) with
// a fixed delay between attempts, up to `max_attempts` tries total.
async fn connect_with_retry(
    ss_url: &str,
    max_attempts: u32,
    retry_delay: Duration,
) -> WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>> {
    for attempt in 1..=max_attempts {
        match connect_async(ss_url).await {
            Ok((ws_stream, _)) => return ws_stream,
            Err(err) => {
                log(&format!(
                    "connect attempt {}/{} to signalling server failed: {}",
                    attempt, max_attempts, err
                ));
                if attempt == max_attempts {
                    panic!("failed to connect to signalling server after {} attempts: {}", max_attempts, err);
                }
                sleep(retry_delay).await;
            }
        }
    }
    unreachable!()
}

// Reads websocket messages until one carries a payload, and returns it. Non-forwardable
// messages (registrations, keepalives, etc.) are silently skipped.
async fn recv_payload(ws_read: &mut WsRead) -> Option<String> {
    while let Some(msg) = ws_read.next().await {
        let msg = match msg {
            Ok(msg) => msg,
            Err(err) => {
                log(&format!("[SS msg] websocket read error while waiting for payload: {}", err));
                return None;
            }
        };
        let text = match msg {
            Message::Text(t) => t,
            other => {
                log(&format!("[SS msg] skipping non-text message: {:?}", other));
                continue;
            }
        };
        log(&format!("[SS msg] received: {}", text));
        let value: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(err) => {
                log(&format!("[SS msg] failed to parse message as JSON: {}", err));
                return None;
            }
        };
        if let Some(payload) = value.get("payload").and_then(|p| p.as_str()) {
            return Some(payload.to_owned());
        }
        log("[SS msg] message had no payload, skipping (registration/keepalive)");
    }
    None
}

// This is the side under test: connects to the signalling server, registers under a
// fresh routing tag, waits for the offer forwarded from another service, sets it as
// the remote description, creates and sends back an answer, then once the data
// channel is open sends "hello" and expects "what is your name" back within 5 seconds.
async fn test_signalling_datachannel_handshake() {
    let ss_url = std::env::var("SS_URL").expect("SS_URL env var not set (see compose.yaml)");
    let tag = std::env::var("RTC_SESSION_ID").expect("RTC_SESSION_ID env var not set (see test/yamls/services/backend.yaml)");

    log(&format!("[SS msg] connecting to {} with tag {}", ss_url, tag));
    let ws_stream = connect_with_retry(&ss_url, 5, Duration::from_millis(500)).await;
    let (mut ws_write, mut ws_read) = ws_stream.split();

    // HS2: register under the routing tag with no payload before the other service
    // connects, so its offer gets forwarded to us instead of being dropped for lack
    // of a peer.
    let register_msg = json!({"tag": tag}).to_string();
    log(&format!("[SS msg] sending: {}", register_msg));
    ws_write.send(Message::Text(register_msg)).await.unwrap();
    log("registered on signalling server");

    let offer_sdp = recv_payload(&mut ws_read).await.expect("did not receive offer from signalling server");
    log(&format!("received offer: {}", offer_sdp));

    let pc = new_default_peer_connection().await;

    // Fires once with the data channel opened by the offering side, and once more
    // per message received on it.
    let (dc_open_tx, dc_open_rx) = tokio::sync::oneshot::channel::<Arc<RTCDataChannel>>();
    let (msg_tx, mut msg_rx) = mpsc::channel::<String>(8);
    let mut dc_open_tx = Some(dc_open_tx);
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let msg_tx = msg_tx.clone();
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let msg_tx = msg_tx.clone();
            Box::pin(async move {
                msg_tx.send(String::from_utf8_lossy(&msg.data).into_owned()).await.ok();
            })
        }));

        let dc_open_tx = dc_open_tx.take();
        let dc_for_open = dc.clone();
        dc.on_open(Box::new(move || {
            let dc_for_open = dc_for_open.clone();
            if let Some(tx) = dc_open_tx {
                tx.send(dc_for_open).ok();
            }
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

    pc.set_remote_description(RTCSessionDescription::offer(offer_sdp).unwrap()).await.unwrap();
    let answer = pc.create_answer(None).await.unwrap();
    pc.set_local_description(answer).await.unwrap();
    gathering_done.notified().await;
    let answer_sdp = pc.local_description().await.unwrap().sdp;

    let answer_msg = json!({"tag": tag, "payload": answer_sdp}).to_string();
    log(&format!("[SS msg] sending: {}", answer_msg));
    ws_write.send(Message::Text(answer_msg)).await.unwrap();
    log("sent answer");

    let dc = timeout(Duration::from_secs(10), dc_open_rx)
        .await
        .expect("data channel did not open in time")
        .expect("data channel sender dropped before opening");

    dc.send_text("hello").await.unwrap();
    log("sent 'hello'");

    let reply = timeout(Duration::from_secs(5), msg_rx.recv())
        .await
        .expect("did not receive a reply within 5 seconds")
        .expect("data channel closed before replying");
    assert_eq!(reply, "what is your name", "unexpected reply from remote peer: {}", reply);
    log("received expected 'what is your name' reply, test passed");

    pc.close().await.ok();
}

#[tokio::main]
pub async fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls CryptoProvider");

    println!("Hello, world!");
    test_ice_candidates_collection().await;
    test_signalling_datachannel_handshake().await;
}

use std::sync::Arc;

use sea_query::Keyword::Null;
use tokio::sync::{Mutex, Notify, mpsc};

use tokio::time::{sleep, Duration};
use webrtc::Error::new;
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::ice_transport::ice_candidate::RTCIceCandidate;
use webrtc::ice_transport::ice_candidate_type::RTCIceCandidateType;
use webrtc::ice_transport::ice_gatherer_state::RTCIceGathererState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtcp;

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
async fn test_webrtc_fresh_rollback() {
    let mut media_engine = MediaEngine::default();
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine).unwrap();
    let mut api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();
    // creating a connection and setting local description


    let conf = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["turns:username1:passVeryh@hamsterworks.org:9011".to_owned()],
            username: "username1".to_owned(),
            credential: "passVeryh".to_owned(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let pc = Arc::new(api.new_peer_connection(conf).await.unwrap());
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

// Connects to the coturn server started by the `sigturn` service (see
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
    let coturn_ip = std::env::var("COTURN_IP").expect("COTURN_IP env var not set (see test/yamls/services/backend.yaml)");
    let coturn_port = std::env::var("COTURN_PORT").expect("COTURN_PORT env var not set (see test_net_env)");
    let stun_credentials = std::env::var("STUN_CREDENTIALS").expect("STUN_CREDENTIALS env var not set (see test/yamls/.env)");
    let nat_a_edge_ip = std::env::var("NAT_A_EDGE_IP").expect("NAT_A_EDGE_IP env var not set (see test_net_env)");
    let vps_edge_ip = std::env::var("VPS_EDGE_IP").expect("VPS_EDGE_IP env var not set (see test/yamls/services/backend.yaml)");
    let (stun_username, stun_credential) = stun_credentials
        .split_once(':')
        .expect("STUN_CREDENTIALS must be of the form username:password");

    let mut media_engine = MediaEngine::default();
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine).unwrap();
    let mut api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();

    let conf = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec![format!("turn:{}:{}", coturn_ip, coturn_port)],
            username: stun_username.to_owned(),
            credential: stun_credential.to_owned(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let pc = Arc::new(api.new_peer_connection(conf).await.unwrap());

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
#[tokio::main]
pub async fn main() {
    println!("Hello, world!");
    test_ice_candidates_collection().await;
}

use std::sync::Arc;

use sea_query::Keyword::Null;
use tokio::sync::{Mutex, Notify, mpsc};

use tokio::time::{sleep, Duration};
use webrtc::Error::new;
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
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

fn get_join_handle() -> (tokio::task::JoinHandle<()>, mpsc::Sender<u64>) {
    let (tx, mut rx) = mpsc::channel::<u64>(10);
    let handle = tokio::spawn(async move {
        let num = rx.recv().await.unwrap();
        log(&format!("joinHandleTest received {}", num));
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
    let (_handle, _tx) = get_join_handle();
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
}
#[tokio::main]
pub async fn main() {
    println!("Hello, world!");
    test_webrtc_fresh_rollback().await;
}
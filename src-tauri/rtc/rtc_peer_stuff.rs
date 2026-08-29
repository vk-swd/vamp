
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Notify};
use tokio::time::sleep;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use tokio::net::TcpStream;
use futures_util::SinkExt;
use futures_util::StreamExt;

use webrtc::api::media_engine::MediaEngine;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::interceptor::registry::Registry;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;

use crate::ws_node::{Connector, WsConnector};


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


enum ConnectionState {
    Connecting,
    Connected,
    UpReconnecting, // when ice connected by offer arrives or we send an offer
    DownReconnecting, // when ice disconnected by offer arrives or we send an offer
    Closed
}
// Builds a peer connection with a default API (default MediaEngine + interceptors)
// and the coturn ice_servers from env (see coturn_ice_servers_from_env). Used by every
// webrtc test in this file so they all negotiate against the same TURN/STUN setup.
pub async fn new_default_peer_connection() -> Arc<RTCPeerConnection> {
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

pub fn signalling_server_connector() -> WsConnector {
    let url = std::env::var("SS_URL").expect("SS_URL env var not set (see compose.yaml)");
    WsConnector::new(url)
}
pub async fn set_up_data_channel_listener() {
    // let ss_url = std::env::var("SS_URL").expect("SS_URL env var not set (see compose.yaml)");
    // let tag = std::env::var("RTC_SESSION_ID").expect("RTC_SESSION_ID env var not set (see test/yamls/services/backend.yaml)");

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

   
}

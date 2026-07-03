
use std::future::Future;
use std::sync::Arc;

use tokio::sync::Notify;
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::data;
use webrtc::data::data_channel::DataChannel;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::ice_transport::ice_candidate::RTCIceCandidate;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_gatherer_state::RTCIceGathererState;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;


enum DataChannelSessionState {
    New,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed
}
pub struct DataChannelSession {
    // label: String,
    pub dc: Arc<RTCDataChannel>,
    pc: Arc<RTCPeerConnection>
}

impl DataChannelSession {

}


fn build_rtc_api() -> webrtc::error::Result<webrtc::api::API> {
    let mut media_engine = MediaEngine::default();
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)?;
    Ok(APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build())
}


pub async fn openDC<F, Fut>(offer: String, config: RTCConfiguration, 
    deliverAnswer: F) -> std::result::Result<DataChannelSession, Box<dyn std::error::Error + Send + Sync>>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = std::result::Result<(), Box<dyn std::error::Error + Send + Sync>>>,
{
    let api = build_rtc_api().map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
    let pc = Arc::new(api.new_peer_connection(config).await?);
// ── Register callbacks before any descriptions are set ────────────────────
    // Log data channels opened by the remote peer (answerer side; we accept, not create).
    
    let pc_clone = pc.clone();
    let data_channel_received = Arc::new(Notify::new());
    let data_channel_received_cpy = data_channel_received.clone();
    let data_channle: Arc<std::sync::Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(std::sync::Mutex::new(None));
    let dc_clone: Arc<std::sync::Mutex<Option<Arc<RTCDataChannel>>>> = data_channle.clone();
    pc_clone.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let label = dc.label().to_owned();
        dc_clone.lock().unwrap().replace(dc);
        data_channel_received_cpy.notify_one();
        Box::pin(async move {
            log::info!("[WSC] DataChannel '{}' opened by remote", label);
        })
    }));

    // Signal when ICE candidate gathering is finished.
    let gathering_done = Arc::new(Notify::new());
    let gd = gathering_done.clone();
    pc.on_ice_gathering_state_change(Box::new(move |state: RTCIceGathererState| {
        log::info!("[WSC] ICE on_ice_gathering_state_change → {}", state);
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
        log::info!("[WSC] ICE state → {}", state);
        if matches!(
            state,
            RTCIceConnectionState::Connected | RTCIceConnectionState::Completed
        ) {
            conn.notify_one();
        }
        Box::pin(async move {})
    }));
    pc.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
        if let Some(candidate) = candidate {
            log::info!("[WSC] ICE candidate → {}", candidate);
        }
        Box::pin(async move {})
    }));
    // ── Apply offer, create and set local answer ───────────────────────────────
    pc.set_remote_description(RTCSessionDescription::offer(offer)?).await?;

    log::info!("[WSC] ICE set_remote_description done");
    let answer = pc.create_answer(None).await?;
    
    log::info!("[WSC] ICE create_answer done");
    pc.set_local_description(answer.clone()).await?;

    gathering_done.notified().await;
    log::info!("[WSC] ICE gathering complete");

    let payload = match pc.local_description().await {
        Some(desc) => desc.sdp.clone(),
        None => {
            return Err(Box::new(std::io::Error::new(std::io::ErrorKind::Other, "no local description")) as Box<dyn std::error::Error + Send + Sync>);
        }
    };
    log::info!("[WSC] receibing local desc {}", &payload);
    match deliverAnswer(payload.clone()).await {
        Ok(fut) => fut,
        Err(e) => {
            log::error!("[WSC] Failed to deliver answer: {e}");
            return Err(e);
        }
    };
    // Triggers ICE candidate gathering.

    data_channel_received.notified().await;
    // This would be the entry point for starting a new WebRTC connection.
    let dc = data_channle.lock().unwrap().as_ref().unwrap().clone();
    Ok(DataChannelSession { pc, dc })
}
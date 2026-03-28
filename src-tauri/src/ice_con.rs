//!
//! # How the connection is set up
//!
//! 1. **Signalling (out-of-band)** — The remote peer creates an SDP offer and
//!    delivers it to this server (e.g. via HTTP POST or a WebSocket message).
//!
//! 2. **`IceConnection::from_offer`** — The server calls this function with the
//!    raw SDP offer string. Internally it:
//!    a. Builds an `RTCPeerConnection` with a public STUN server for NAT
//!       traversal.
//!    b. Registers `on_data_channel` — any DataChannel the peer opens will
//!       automatically receive an echo handler.
//!    c. Sets the remote description (the offer) and creates an SDP answer.
//!    d. Waits for ICE gathering to complete so the returned answer SDP already
//!       contains all local candidates (non-trickle / vanilla ICE).
//!    e. Returns `(IceConnection, answer_sdp)` — the caller must forward
//!       `answer_sdp` back to the peer through the same signalling channel.
//!
//! 3. **ICE negotiation** — Browser ↔ server exchange STUN connectivity
//!    checks in the background. `RTCPeerConnectionState` transitions are
//!    mirrored into the `ConnectionState` machine via a callback.
//!
//! 4. **Data channel open / echo** — When the peer's DataChannel fires
//!    `on_open` the connection is live. Every subsequent message is echoed
//!    back as `"<unix_ms>|<original_message>"`.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use tokio::sync::Mutex;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/// Mirrors `RTCPeerConnectionState` so callers can inspect connection health
/// without holding an async lock on the underlying peer connection.
///
/// Transitions (driven by the WebRTC layer):
///
/// ```text
///  New ──► Connecting ──► Connected
///                │             │
///                ▼             ▼
///           Failed       Disconnected
///                │
///                ▼
///             Closed
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    /// Freshly created; ICE has not yet started.
    New,
    /// ICE checks are in progress.
    Connecting,
    /// All ICE transports are connected or completed.
    Connected,
    /// At least one transport has lost its connection.
    Disconnected,
    /// ICE has failed; a new offer/answer cycle is required to recover.
    Failed,
    /// The connection was closed by calling [`IceConnection::close`].
    Closed,
}

impl From<RTCPeerConnectionState> for ConnectionState {
    fn from(s: RTCPeerConnectionState) -> Self {
        match s {
            RTCPeerConnectionState::New          => Self::New,
            RTCPeerConnectionState::Connecting   => Self::Connecting,
            RTCPeerConnectionState::Connected    => Self::Connected,
            RTCPeerConnectionState::Disconnected => Self::Disconnected,
            RTCPeerConnectionState::Failed       => Self::Failed,
            RTCPeerConnectionState::Closed       => Self::Closed,
            _                                    => Self::New,
        }
    }
}

// ---------------------------------------------------------------------------
// Connection struct
// ---------------------------------------------------------------------------

/// A single WebRTC echo connection.
///
/// Obtain one via [`IceConnection::from_offer`], which also yields the SDP
/// answer to return to the remote peer. Drop or call [`IceConnection::close`]
/// when done.
pub struct IceConnection {
    /// Unique connection identifier (hex nanosecond timestamp at creation).
    pub id: String,
    /// Current state, updated asynchronously by the WebRTC runtime.
    pub state: Arc<Mutex<ConnectionState>>,
    peer_connection: Arc<RTCPeerConnection>,
}

impl IceConnection {
    /// Accept an SDP offer from a remote peer, complete ICE gathering, and
    /// return the connection handle together with the SDP answer to send back.
    pub async fn from_offer(offer_sdp: String) -> Result<(Self, String)> {
        let id = new_id();

        // No media tracks — data channels only.
        let api = APIBuilder::new().build();

        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            }],
            ..Default::default()
        };

        let pc = Arc::new(api.new_peer_connection(config).await?);
        let state = Arc::new(Mutex::new(ConnectionState::New));

        // Mirror RTCPeerConnectionState into our enum.
        pc.on_peer_connection_state_change(Box::new({
            let state = Arc::clone(&state);
            move |s| {
                let state = Arc::clone(&state);
                Box::pin(async move {
                    let next = ConnectionState::from(s);
                    log::info!("ice_con: state → {next:?}");
                    *state.lock().await = next;
                })
            }
        }));

        // Wire an echo handler to every DataChannel the peer opens.
        pc.on_data_channel(Box::new({
            let id = id.clone();
            move |dc| {
                let id = id.clone();
                Box::pin(async move {
                    wire_echo_handler(dc, id).await;
                })
            }
        }));

        // Apply the remote offer.
        pc.set_remote_description(RTCSessionDescription::offer(offer_sdp)?).await?;

        // Create local answer and wait for all ICE candidates to be gathered
        // before returning (non-trickle ICE — answer SDP is self-contained).
        let answer = pc.create_answer(None).await?;
        let mut gather_done = pc.gathering_complete_promise().await;
        pc.set_local_description(answer).await?;
        let _ = gather_done.recv().await;

        let answer_sdp = pc
            .local_description()
            .await
            .ok_or_else(|| anyhow::anyhow!("no local description after ICE gathering"))?
            .sdp;

        let conn = IceConnection { id, state, peer_connection: pc };
        Ok((conn, answer_sdp))
    }

    /// Gracefully close the peer connection and mark state as `Closed`.
    pub async fn close(&self) -> Result<()> {
        self.peer_connection.close().await?;
        *self.state.lock().await = ConnectionState::Closed;
        Ok(())
    }

    /// Non-blocking snapshot of the current connection state.
    pub async fn current_state(&self) -> ConnectionState {
        self.state.lock().await.clone()
    }
}

// ---------------------------------------------------------------------------
// Echo handler
// ---------------------------------------------------------------------------

/// Attach open/message callbacks to `dc`.
///
/// On `open`:  logs the channel name.
/// On `message`: sends back `"<unix_ms>|<original_text>"`.
async fn wire_echo_handler(dc: Arc<RTCDataChannel>, conn_id: String) {
    let label = dc.label().to_owned();

    dc.on_open(Box::new({
        let conn_id = conn_id.clone();
        let label = label.clone();
        move || {
            log::info!("[{conn_id}] data channel '{label}' open");
            Box::pin(async {})
        }
    }));

    dc.on_message(Box::new({
        let dc_echo = Arc::clone(&dc);
        let conn_id = conn_id.clone();
        move |msg: DataChannelMessage| {
            let dc_echo = Arc::clone(&dc_echo);
            let conn_id = conn_id.clone();
            Box::pin(async move {
                let reply = format!("{}|{}", now_ms(), String::from_utf8_lossy(&msg.data));
                if let Err(e) = dc_echo.send_text(reply).await {
                    log::warn!("[{conn_id}] echo send failed: {e}");
                }
            })
        }
    }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn new_id() -> String {
    format!("{:x}", now_ms())
}

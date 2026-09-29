
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use super::ws_node::WsConnector;

use super::ws_node_handler::{from_wire_msg, to_wire_msg};
use super::common::{MyErr, MyRes};
use super::debouncer::IceRestartDebouncer;
use super::transport_types::WireMsg;
use super::ws_node::{Connector, Receiver, Sender};
use super::ws_node_handler::{
    SignalKind, SignalMsg, TransportHandler, TransportHandlerControl,
};
use super::transport_types::TransportMsg;

use super::rtc_peer_stuff::new_default_peer_connection;

type ToMutex<T> = tokio::sync::Mutex<T>;
type ToReceiver<T> = tokio::sync::mpsc::Receiver<T>;
type ToSender<T> = tokio::sync::mpsc::Sender<T>;
// pub struct RealSender(RealSink);
// pub struct RealReceiver(RealStream);


struct RtcSender {
    dc: Arc<webrtc::data_channel::RTCDataChannel>,
    connection_state: Arc<AtomicBool>
} 
struct RtcReceiver {
    receiver: Arc<ToMutex<tokio::sync::mpsc::Receiver<String>>>,
}

#[async_trait]
impl Sender for RtcSender {
    type Item = String;
    async fn send(&mut self, msg: String) -> MyRes<()> {
        if self.connection_state.load(Ordering::Relaxed) == false || self.dc.ready_state() != webrtc::data_channel::data_channel_state::RTCDataChannelState::Open {
            return Err("rtc sender not ready".into());
        }
        // other side will close the receiver and this will return an error
        match self.dc.send_text(msg).await {
            Ok(_) => Ok(()),
            Err(e) => Err(Box::new(e) as MyErr),
        }
    }
}

#[async_trait]
impl Receiver for RtcReceiver {
    type Item = String;
    async fn recv(&mut self) -> MyRes<Option<Self::Item>> {
        // other side will drop the sender and this will return None
        // no...first create datachannel and then add a callback there...
        // data channel survives while teh ice is down so there is no need to reconnect
        match self.receiver.lock().await.recv().await {
            Some(msg) => Ok(Some(msg)),
            None => Err("rtc receiver channel closed".into()),
        }
    }
}


#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct DCMsg {
    pub msg: String,
}


struct ConnectionState {
    is_connected: bool,
    channel_open: bool
}
struct RtcConnectorSharedState {
    dc_state: Arc<DCState>,
    connection_state: Arc<AtomicBool>,
    // TODO: test if false sharing is a problem here
    connected_notifier: Arc<tokio::sync::Notify>,
}

impl RtcConnectorSharedState {
    pub async fn wait_for_connected(&self) -> (Box<dyn Sender<Item = String>>, Box<dyn Receiver<Item = String>>) {
        loop {
            if self.connection_state.load(Ordering::Relaxed) && self.dc_state.dc.ready_state() == webrtc::data_channel::data_channel_state::RTCDataChannelState::Open {
                break;
            }
            self.connected_notifier.notified().await;
        }
        let connection_state = self.connection_state.clone();
        let dc = self.dc_state.dc.clone();
        let receiver = self.dc_state.receiver_rx.clone();
        let rtc_sender = RtcSender { connection_state, dc };
        let rtc_receiver = RtcReceiver { receiver };
        return (Box::new(rtc_sender), Box::new(rtc_receiver));
    }
}

struct DataChannelConnector {
    shared_state: Arc<RtcConnectorSharedState>,
}

#[async_trait]
impl Connector<String> for DataChannelConnector {
    async fn connect(&self) -> MyRes<(Box<dyn Sender<Item = String>>, Box<dyn Receiver<Item = String>>)> {
        Ok(self.shared_state.wait_for_connected().await)
    }
}

struct TransportHandlerState {
    dc_shared_state: Arc<RtcConnectorSharedState>,
    transport_handler_control: Arc<Mutex<Option<TransportHandlerControl>>>,
}


type DCMapPrt = Arc<ToMutex<HashMap<String, Arc<TransportHandlerState>>>>;
pub struct RtcConnector {
    shared_state: DCMapPrt,
    ice_debouncer: Arc<IceRestartDebouncer>,
    incoming_channels_notifier: Arc<tokio::sync::Notify>,
    cancellation_token: CancellationToken,
    run_handle: tokio::task::JoinHandle<()>
}

pub struct RtcConnectorConfig {
    pub signalling_url: String,
    pub session_id: String,
}

impl RtcConnector {
    pub fn new(config: RtcConnectorConfig) -> Self {
        // let (rtc_sender, rtc_receiver) = tokio::sync::mpsc::channel(16);
        let shared_state = Arc::new(ToMutex::new(HashMap::new()));
        let registration_msg = Message::Text(
            serde_json::to_string(&WireMsg::<()> {
                tag: config.session_id.clone(),
                message: None,
            })
            .expect("registration message should serialize"),
        );
        let ws_connector = Box::new(WsConnector::with_initial_message(
            config.signalling_url,
            registration_msg,
        ));
        let (signal_tx, signal_rx) = tokio::sync::mpsc::channel::<SignalMsg>(8);
        let (offer_tx, offer_rx) = tokio::sync::mpsc::channel::<SignalMsg>(8);
        let incoming_channels_notifier = Arc::new(Notify::new());
        let cancellation_token = CancellationToken::new();
        let ice_debouncer = Arc::new(IceRestartDebouncer::new());
        
        let signal_tx_clone = signal_tx.clone();
        let message_handler = move |msg: SignalMsg| {
            if msg.kind == SignalKind::Offer {
                let _ = offer_tx.try_send(msg.clone());
            }
            let _ = signal_tx_clone.try_send(msg);
        };
        let session_id = config.session_id.clone();
        let ws_node_handler = TransportHandler::<Message, SignalMsg>::new(
            ws_connector, 
            message_handler,
            |msg: Message| {
                let Message::Text(raw) = msg else {
                    let msg_type = match msg {
                        Message::Binary(_) => "binary",
                        Message::Close(_) => "close",
                        Message::Ping(_) => "ping",
                        Message::Pong(_) => "pong",
                        Message::Frame(_) => "frame",
                        _ => "unknown",
                    };
                    return Err(format!("expected text signalling message: {}", msg_type).into());
                };
                super::ws_node_handler::from_wire_msg(&raw)
                    .ok_or_else(|| format!("invalid signalling message: {}", raw).into())
            },
            move |msg: TransportMsg<SignalMsg>| {
                to_wire_msg(session_id.clone(), Some(msg))
            },
        );


        let run_handle = run(
            signal_rx,
            offer_rx,
            signal_tx,
            ws_node_handler,
            incoming_channels_notifier.clone(),
            shared_state.clone(),
            cancellation_token.clone(),
            ice_debouncer.clone(),
        );
        RtcConnector {
            shared_state,
            ice_debouncer,
            incoming_channels_notifier,
            cancellation_token,
            run_handle
        }
    }

    pub fn cancel(&self) {
        self.cancellation_token.cancel();
    }

    pub async fn wait_for_a_data_channel_connector<F>(
        &mut self,
        message_handler: F,
    ) -> MyRes<Box<TransportHandler<String, DCMsg>>>
    where
        F: Fn(DCMsg) + Send + Sync + 'static,
    {
        // await by datachannel label
        // keep track of produced TransportHandlers - if such handler exists, then return error
        // when remving element from transport handler list, close it
        // transporthandler shouldnt need a mutex, just arc
        // actually let wsnode be created here if it is missing for the first time.
        // arc<mutex<optional<wsnode>>>...then lock it and check if it is none, then create it and fill it in, then unlock it and return the wsnode 
        let dc_state: Arc<TransportHandlerState> = {
            loop {
                 {
                    let guard = self.shared_state.lock().await;
                    match guard.get("default") {
                        Some(transport_handler_state) => {
                            // Handle the case where the default shared state exists
                            break transport_handler_state.clone();
                        }
                        None => {}
                    }
                }
                self.incoming_channels_notifier.notified().await;
            }
        };
        let mut control = dc_state.transport_handler_control.lock().await;
        if control.is_some() {
            return Err("transport handler already has an owner".into());
        }

        let new_transport_handler = TransportHandler::<String, DCMsg>::new(
            Box::new(DataChannelConnector {
                shared_state: dc_state.dc_shared_state.clone(),
            }),
            message_handler,
            |msg: String| {
                serde_json::from_str::<TransportMsg<DCMsg>>(&msg)
                    .map_err(|e| Box::new(e) as MyErr)
            },
            |msg: TransportMsg<DCMsg>| {
                serde_json::to_string(&msg)
                    .map_err(|e| Box::new(e) as MyErr)
            },
        );
        control.replace(new_transport_handler.control());
        Ok(Box::new(new_transport_handler))
    }
}

#[derive(Clone)]
struct DCState {
    dc: Arc<webrtc::data_channel::RTCDataChannel>, //for send and ready state
    receiver_rx: Arc<ToMutex<tokio::sync::mpsc::Receiver<String>>>,
    dc_id: String,
}

fn init_rtc_connection(
    connection: &RTCPeerConnection, 
    incoming_channels_notifier: Arc<tokio::sync::Notify>,
    data_channels: DCMapPrt,
    ice_debouncer: Arc<IceRestartDebouncer>,
) {
    let connection_flag = Arc::new(AtomicBool::new(false));
    let connection_flag_clone = connection_flag.clone();

    let connection_notifier = Arc::new(Notify::new());
    let connection_notifier_clone = connection_notifier.clone();

    
    connection.on_peer_connection_state_change(Box::new(move |state| {
        match state {
            webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Connected => {
                connection_flag_clone.store(true, Ordering::SeqCst);
                connection_notifier_clone.notify_waiters();
                ice_debouncer.end();
            }
            webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Disconnected
            | webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Failed => {
                connection_flag_clone.store(false, Ordering::SeqCst);
                ice_debouncer.start();
            }
            webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Closed => {
                connection_flag_clone.store(false, Ordering::SeqCst);
            }
            _ => {}
        }
        Box::pin(async move {})
    }));
    let data_channels_clone = data_channels.clone();// Handle ICE connection state change here.
    let incoming_channels_notifier_clone = incoming_channels_notifier.clone();
    // whenever new data channel arrives, i need to ignore messages from another channel
    
    connection.on_data_channel(Box::new(move |dc| {
        let dc_id = dc.id();

        let (receiver_tx, receiver_rx) = tokio::sync::mpsc::channel::<String>(16);
        dc.on_message(Box::new(move |msg| {
            if msg.is_string {
                match receiver_tx.try_send(String::from_utf8_lossy(&msg.data).into_owned()) {
                    Ok(_) => {}
                    Err(e) => {
                        log::error!("Failed to receive data channel message: {:?}", e);
                    }
                }
            } else {
                log::warn!("Received binary message on data channel, ignoring.");
            }
            Box::pin(async move {})
        }));
        // Make DC close event for cleanup - include dc id.
        dc.on_close(Box::new(move || {
            Box::pin(async move {
                // Handle data channel close event here.
            })
        }));

        let dc_shared_state = Arc::new(RtcConnectorSharedState {
            dc_state: Arc::new(DCState {
                dc: dc.clone(),
                receiver_rx: Arc::new(ToMutex::new(receiver_rx)),
                dc_id: dc_id.to_string(),
            }),
            connection_state: connection_flag.clone(),
            connected_notifier: connection_notifier.clone(),
        });
        let dc_state = Arc::new(TransportHandlerState {
            dc_shared_state,
            transport_handler_control: Arc::new(Mutex::new(None)),
        });
        let data_channels_clone_clone = data_channels_clone.clone();
        let incoming_channels_notifier_clone_clone = incoming_channels_notifier_clone.clone();
        let channel_name = dc.label().to_string();
        Box::pin(async move {
            let previous_state = data_channels_clone_clone
                .lock()
                .await
                .insert(channel_name, dc_state);
            if let Some(previous_state) = previous_state {
                let previous_control = {
                    previous_state.transport_handler_control.lock().await.take()
                };
                if let Some(previous_control) = previous_control {
                    previous_control.cancel();
                }
                let _ = previous_state.dc_shared_state.dc_state.dc.close().await;
            }

            incoming_channels_notifier_clone_clone.notify_waiters();
        })
    }));
}

fn init_local_candidate_handling(
    connection: Arc<RTCPeerConnection>,
    local_candidate_queue_tx: ToSender<SignalMsg>,
) {
    connection.on_ice_candidate(Box::new(move |candidate| {
        let local_candidate_queue_tx_clone = local_candidate_queue_tx.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                // A None candidate marks the end of ICE gathering.
                return;
            };

            let candidate = match candidate.to_json() {
                Ok(candidate) => candidate,
                Err(error) => {
                    log::warn!("failed to convert local ICE candidate: {error}");
                    return;
                }
            };
            let sdp = match serde_json::to_string(&candidate) {
                Ok(sdp) => sdp,
                Err(error) => {
                    log::warn!("failed to serialize local ICE candidate: {error}");
                    return;
                }
            };

            let local_candidate = SignalMsg {
                kind: SignalKind::LocalCandidate,
                sdp,
                // The negotiation ID is assigned when this message is
                // consumed, after the corresponding offer is known.
                neg_id: String::new(),
            };
            if let Err(error) = local_candidate_queue_tx_clone.send(local_candidate).await {
                log::warn!("failed to queue local ICE candidate: {error}");
            }
        })
    }));
}

async fn handle_offer(
    connection: &RTCPeerConnection,
    offer: SignalMsg,
    websocket_transport_handler: &mut TransportHandler<Message, SignalMsg>,
) -> MyRes<()> {
    let negotiation_id = offer.neg_id;
    let remote_description = RTCSessionDescription::offer(offer.sdp)?;
    connection.set_remote_description(remote_description).await?;

    let answer = connection.create_answer(None).await?;
    connection.set_local_description(answer).await?;

    let local_description = connection
        .local_description()
        .await
        .ok_or_else(|| "peer connection returned no local answer description")?;
    websocket_transport_handler
        .send_default(SignalMsg {
            kind: SignalKind::Answer,
            sdp: local_description.sdp,
            neg_id: negotiation_id,
        })
        .await?;

    Ok(())
}

async fn handle_incoming_candidate(
    connection: &RTCPeerConnection,
    candidate: SignalMsg,
) -> MyRes<()> {
    let candidate = serde_json::from_str::<RTCIceCandidateInit>(&candidate.sdp)?;
    connection.add_ice_candidate(candidate).await?;
    Ok(())
}

async fn close_data_channels(data_channels: &DCMapPrt) {
    let channels = {
        let mut guard = data_channels.lock().await;
        guard.drain().map(|(_, state)| state).collect::<Vec<_>>()
    };

    for channel in channels {
        if let Some(control) = channel.transport_handler_control.lock().await.take() {
            control.cancel();
        }
        let _ = channel.dc_shared_state.dc_state.dc.close().await;
    }
}

fn run(mut signal_rx: ToReceiver<SignalMsg>,
    mut offer_rx: ToReceiver<SignalMsg>,
    signal_tx: ToSender<SignalMsg>,
    mut websocket_transport_handler: TransportHandler<Message, SignalMsg>,
    incoming_channels_notifier: Arc<tokio::sync::Notify>,
    dc_map: DCMapPrt,
    cancellation_token: CancellationToken,
    ice_debouncer: Arc<IceRestartDebouncer>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut debounce_rx = ice_debouncer.subscribe();
        let mut rtc_peer_con = Option::<Arc<RTCPeerConnection>>::None;
        let mut current_offer = Option::<SignalMsg>::None;
        let mut current_negotiation_id = Option::<String>::None;
        let mut restart_rtc_peer = true;
        loop {
            
            if restart_rtc_peer {
                restart_rtc_peer = false;
                if let Some(peer_con) = rtc_peer_con.as_ref() {
                    close_data_channels(&dc_map).await;
                    let _ = peer_con.close().await;
                    current_offer = None;
                    current_negotiation_id = None;
                }
                rtc_peer_con = Some(new_default_peer_connection().await);
                init_rtc_connection(
                    rtc_peer_con.as_ref().unwrap(),
                    incoming_channels_notifier.clone(),
                    dc_map.clone(),
                    ice_debouncer.clone(),
                );
                init_local_candidate_handling(rtc_peer_con.as_ref().unwrap().clone(), signal_tx.clone());
            }
            // it is ok to handle signalling in the same select as 
            // other current events because they can only get interrupted
            // by a new offer or by a debounce, which is fine.
            tokio::select! {
                _ = cancellation_token.cancelled() => break,
                debounce_event = debounce_rx.recv() => {
                    match debounce_event {
                        Ok(_) => {
                            restart_rtc_peer = true;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                offer = offer_rx.recv() => {
                    match offer {
                        Some(offer) => {
                            current_offer = Some(offer);
                            current_negotiation_id = current_offer.as_ref().map(|offer| offer.neg_id.clone());
                        }
                        None => break,
                    }
                }

                _ = async {}, if current_negotiation_id.as_ref().is_some_and(|id| !id.is_empty()) && current_offer.is_some() => {
                    let offer = current_offer
                        .take()
                        .expect("current_offer was checked above");
                    if let Err(error) = handle_offer(
                        rtc_peer_con.as_ref().expect("rtc_peer_con should be Some"),
                        offer,
                        &mut websocket_transport_handler,
                    ).await {
                        log::warn!("failed to handle signalling offer: {error}");
                    }
                }
                signal_msg = signal_rx.recv(), if current_negotiation_id.as_ref().is_some_and(|id| !id.is_empty()) => {
                    match signal_msg {
                        Some(msg) => {
                            let Some(negotiation_id) = current_negotiation_id.as_ref() else {
                                continue;
                            };

                            let msg = if msg.kind == SignalKind::LocalCandidate {
                                SignalMsg {
                                    neg_id: negotiation_id.clone(),
                                    ..msg
                                }
                            } else if msg.neg_id != *negotiation_id {
                                continue;
                            } else {
                                msg
                            };

                            if msg.kind == SignalKind::LocalCandidate {
                                let local_candidate = SignalMsg {
                                    kind: SignalKind::IceCandidate,
                                    ..msg
                                };
                                if let Err(error) = websocket_transport_handler.send_default(local_candidate).await {
                                    log::warn!("failed to send local ICE candidate: {error}");
                                }
                            } else if msg.kind == SignalKind::IceCandidate {
                                if let Err(error) = handle_incoming_candidate(
                                    rtc_peer_con.as_ref().expect("rtc_peer_con should be Some"),
                                    msg,
                                ).await {
                                    log::warn!("failed to handle incoming ICE candidate: {error}");
                                }
                            }
                        }
                        None => break,
                    }
                }
            }

        }
        websocket_transport_handler.stop().await;
    })
}
enum RtcState {
    AwaitingOffer,
    StableConnected,
    StableDisconnected,
    AwaitingAnswer,
}
enum Action {
    // when to disconnect
    SendCandidate(String),
    ReceiveOffer(String),
    Wait,
    ReceiveCandidate(String),
    StunError(String),
}
async fn process_events() -> MyRes<Action> {
    Ok(Action::Wait)
}
fn set_up_rtc_connection() -> MyRes<()> {
    Ok(())
}
fn process_signal_msg() -> MyRes<bool> {
    let restart_debounce = false;
    Ok(restart_debounce)
}
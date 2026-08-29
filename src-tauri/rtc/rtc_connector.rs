
use std::collections::HashMap;
use std::{iter::Map, sync::Arc};
use std::sync::atomic::{AtomicBool, Ordering};
use async_trait::async_trait;
use serde::{Serialize, Deserialize};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;
use webrtc::peer_connection::RTCPeerConnection;
use crate::{common::{MyErr, MyRes}, debouncer::SimpleDebouncer, rtc_peer_stuff::new_default_peer_connection, ws_node::{Connector, Receiver, Sender}};
use tokio::{signal, sync::Mutex};
use crate::ws_node_handler::{TransportMsg, SignalMsg, TransportHandler, TransportHandlerControl};

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
struct DCMsg {
    msg: String,
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
struct RtcConnector {
    shared_state: DCMapPrt,
    ice_debouncer: SimpleDebouncer,
    incoming_channels: ToReceiver<String>,
    incoming_channels_notifier: Arc<tokio::sync::Notify>,
}

struct RtcConnectorConfig {
    signalling_url: String,
    session_id: String,
}

impl RtcConnector {
    pub fn new() -> Self {
        // let (rtc_sender, rtc_receiver) = tokio::sync::mpsc::channel(16);
        let shared_state = Arc::new(ToMutex::new(HashMap::new()));
        let ws_connector = Box::new(crate::rtc_peer_stuff::signalling_server_connector());
        let (signal_tx, mut signal_rx) = tokio::sync::mpsc::channel::<SignalMsg>(8);
        let (offer_tx, mut offer_rx) = tokio::sync::mpsc::channel::<SignalMsg>(8);
        let (local_candidate_tx, mut local_candidate_rx) = tokio::sync::mpsc::channel::<SignalMsg>(8);
        
        let message_handler = move |msg: SignalMsg| {
            if msg.kind == "offer" {
                let _ = offer_tx.try_send(msg);
            } else {
                let _ = signal_tx.try_send(msg);
            }
        };
        let ws_node_handler = TransportHandler::<Message, SignalMsg>::new(
            ws_connector, 
            message_handler,
            |msg: Message| {
                let Message::Text(raw) = msg else {
                    return Err("expected text signalling message".into());
                };
                crate::ws_node_handler::from_wire_msg(&raw)
                    .ok_or_else(|| "invalid signalling message".into())
            },
            |msg: TransportMsg<SignalMsg>| {
                crate::ws_node_handler::to_wire_msg("signalling".to_string(), &msg)
            },
        );
        RtcConnector {
            shared_state,
            ice_debouncer: SimpleDebouncer::new(),
        }
    }


    async fn wait_for_a_data_channel_connector<F>(
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
            }
            webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Disconnected => {
                connection_flag_clone.store(false, Ordering::SeqCst);
            }
            webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Failed => {
                connection_flag_clone.store(false, Ordering::SeqCst);
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
fn run(mut signal_rx: ToReceiver<SignalMsg>, 
    mut offer_rx: ToReceiver<SignalMsg>, 
    mut local_candidate_rx: ToReceiver<SignalMsg>, 
    shared_state: Arc<RtcConnectorSharedState>,
    dc_map: DCMapPrt) {
    tokio::spawn(async move {
        let rtc_peer_con = new_default_peer_connection().await;
        let mut current_offer = Option::<SignalMsg>::None;
        let mut current_negotiation_id = Option::<String>::None;
        loop {
            tokio::select! {
                offer = offer_rx.recv() => {
                    match offer {
                        Some(offer) => {
                            current_offer = Some(offer);
                        }
                        None => break,
                    }
                    // add tombstone to local candidates and to connection state
                }

                _ = async {}, if current_offer.is_some() => {
                    let offer = current_offer
                        .take()
                        .expect("current_offer was checked above");
                    current_negotiation_id = Some(offer.neg_id.clone());
                    // Process `offer` and use `rtc_peer_con` here.
                    let _ = offer;
                }
                signal_msg = signal_rx.recv() => {
                    match signal_msg {
                        Some(msg) => {
                            // Process `msg` and use `rtc_peer_con` here.
                            let _ = msg;
                        }
                        None => break,
                    }
                }
                local_candidate_msg = local_candidate_rx.recv() => {
                    match local_candidate_msg {
                        Some(msg) => {
                            // Process `msg` and use `rtc_peer_con` here.
                            let _ = msg;
                        }
                        None => break,
                    }
                }
            }
        }
    });
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
    ChannelClosed(String),
    ChannelOpened(String),
    StunError(String),
    // can i fail to send to datachannel with a connected ice?
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
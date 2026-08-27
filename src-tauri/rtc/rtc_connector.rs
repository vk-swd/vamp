
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use async_trait::async_trait;
use crate::{common::{MyErr, MyRes}, debouncer::SimpleDebouncer, ws_node::{Connector, Receiver, Sender}};
use tokio::sync::Mutex;
use crate::ws_node_handler::{TransportMsg, SignalMsg};


// pub struct RealSender(RealSink);
// pub struct RealReceiver(RealStream);


struct RtcSender {
    is_connected: Arc<AtomicBool>,
    sender: tokio::sync::mpsc::Sender<String>,    
} 
struct RtcReceiver {
    receiver: Arc<Mutex<tokio::sync::mpsc::Receiver<String>>>,
}

#[async_trait]
impl Sender for RtcSender {
    type Item = String;
    async fn send(&mut self, msg: String) -> MyRes<()> {
        if self.is_connected.load(std::sync::atomic::Ordering::Relaxed) == false {
            return Ok(());
        }
        // other side will close the receiver and this will return an error
        self.sender.send(msg).await.map_err(|e| Box::new(e) as MyErr)
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

struct RtcConnectorSharedState {
    is_connected: Arc<AtomicBool>,
    connected_notifier: Arc<tokio::sync::Notify>,
    dc_sender_tx: tokio::sync::mpsc::Sender<String>,
    dc_receiver_rx: Arc<Mutex<tokio::sync::mpsc::Receiver<String>>>,

    dc_receiver_tx: tokio::sync::mpsc::Sender<String>,
    dc_sender_rx: Arc<Mutex<tokio::sync::mpsc::Receiver<String>>>,
}

impl RtcConnectorSharedState {
    fn new() -> Self {
        let (dc_sender_tx, dc_sender_rx) = tokio::sync::mpsc::channel(16);
        let (dc_receiver_tx, dc_receiver_rx) = tokio::sync::mpsc::channel(16);
        RtcConnectorSharedState {
            is_connected: Arc::new(AtomicBool::new(false)),
            connected_notifier: Arc::new(tokio::sync::Notify::new()),
            dc_sender_tx,
            dc_receiver_rx: Arc::new(Mutex::new(dc_receiver_rx)),
            dc_receiver_tx,
            dc_sender_rx: Arc::new(Mutex::new(dc_sender_rx)),
        }
    }
    pub async fn wait_for_connected(&self) -> (Box<dyn Sender<Item = String>>, Box<dyn Receiver<Item = String>>) {
        while !self.is_connected.load(std::sync::atomic::Ordering::SeqCst) {
            self.connected_notifier.notified().await;
        }
        let is_connected = self.is_connected.clone();
        let sender = self.dc_sender_tx.clone();
        let receiver = self.dc_receiver_rx.clone();
        let rtc_sender = RtcSender { is_connected, sender };
        let rtc_receiver = RtcReceiver { receiver };
        return (Box::new(rtc_sender), Box::new(rtc_receiver));
    }
}

struct RtcConnector {
    shared_state: Arc<RtcConnectorSharedState>,
    ice_debouncer: SimpleDebouncer
}

struct RtcConnectorConfig {
    signalling_url: String,
    session_id: String,
}

#[async_trait]
impl Connector<String> for RtcConnector {
    async fn connect(&self) -> MyRes<(Box<dyn Sender<Item = String>>, Box<dyn Receiver<Item = String>>)> {
        Ok(self.shared_state.wait_for_connected().await)
    }
}
impl RtcConnector {
    pub fn new() -> Self {
        // let (rtc_sender, rtc_receiver) = tokio::sync::mpsc::channel(16);


        RtcConnector {
            shared_state: Arc::new(RtcConnectorSharedState::new()),
            ice_debouncer: SimpleDebouncer::new(),
        }
    }


    fn run(&mut self) {
        tokio::spawn(async move {
            let mut debouncer = SimpleDebouncer::new();
            loop {
                // wait for ice restart signal
                tokio::select! {
                    _ = debouncer.wait_for_debounce() => {
                        //restart ice
                    },
                    _ = process_events() => {
                        // process events
                    },
                }
            }
        });

    }
}
enum RtcState {
    AwaitingOffer,
    StableConnected,
    StableDisconnected,
    AwaitingAnswer,
}
enum Action {
    SendCandidate(String),
    SendOffer(String),
    ReceiveOffer(String),
    ReceiveAnswer(String),
    Wait,
    ReceiveCandidate(String),
    RestartIce
}
async fn process_events() -> MyRes<()> {
    Ok(())
}
fn set_up_rtc_connection() -> MyRes<()> {
    Ok(())
}
fn process_signal_msg() -> MyRes<bool> {
    let restart_debounce = false;
    Ok(restart_debounce)
}
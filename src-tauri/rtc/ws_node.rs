//! Reconnecting websocket transport used by the signalling connection.
//!
//! `WsNode` knows nothing about acks, sequence numbers, or `SignalMsg` -
//! it just keeps a websocket connection to a url alive, exposes `send_tx`
//! for outgoing frames and delivers incoming frames to the `MessageHandler`
//! given at construction time. Reliability (acks, retries, ordering) is
//! layered on top by the caller. See `memo.md` ("Signalling connection
//! handling pipeline").
//!
//! `sender_task`/`receive_task` are generic over the `WsSender`/`WsReceiver`
//! traits, so they work the same whether backed by a real websocket
//! (`RealSender`/`RealReceiver`) or, in tests, a pair of mpsc channels
//! (`ChannelSender`/`ChannelReceiver`).

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

pub type MyErr = Box<dyn std::error::Error + Send + Sync>;
pub type MyRes<T = ()> = std::result::Result<T, MyErr>;


/// Callback invoked for each incoming message, for the whole lifetime of
/// the `WsNode`.
pub type MessageHandler = Box<dyn Fn(Message) + Send + Sync>;

/// Sending half of a duplex message stream - a real websocket connection or
/// an in-memory test double.
#[async_trait]
pub trait Sender: Send {
    type Item;
    async fn send(&mut self, msg: Self::Item) -> MyRes<()>;
}

/// Receiving half of a duplex message stream. `recv` returning `Ok(None)`
/// means the peer closed the connection cleanly; an `Err` means something
/// broke and the caller should reconnect.
#[async_trait]
pub trait Receiver: Send {
    type Item;
    async fn recv(&mut self) -> MyRes<Option<Self::Item>>;
}

/// Produces a fresh `(sender, receiver)` pair for one connection attempt.
/// In production this opens a real websocket; in tests it can hand out
/// pre-built channel-backed pairs instead.

#[async_trait]
pub trait Connector<T>: Send + Sync {
    async fn connect(&self) -> MyRes<(Box<dyn Sender<Item = T>>, Box<dyn Receiver<Item = T>>)>;
}

pub struct WsConnector {
    url: String,
    initial_message: Option<Message>,
}
impl WsConnector {
    pub fn new(url: String) -> Self {
        Self { url, initial_message: None }
    }

    pub fn with_initial_message(url: String, initial_message: Message) -> Self {
        Self {
            url,
            initial_message: Some(initial_message),
        }
    }
}
#[async_trait]
impl Connector<Message> for WsConnector {
    async fn connect(&self) -> MyRes<(Box<dyn Sender<Item = Message>>, Box<dyn Receiver<Item = Message>>)> {
        let (mut sender, receiver) = open_ws(&self.url).await?;
        if let Some(initial_message) = &self.initial_message {
            match sender.send(initial_message.clone()).await {
                Ok(_) => log::info!("[WSC] sent initial message"),
                Err(e) => {
                    log::warn!("[WSC] failed to send initial message: {e}");
                    return Err(e);
                }
            }
        }
        Ok((Box::new(sender) as Box<dyn Sender<Item = Message>>, Box::new(receiver) as Box<dyn Receiver<Item = Message>>))
    }
}

// ---------------------------------------------------------------------------
// Real websocket implementation
// ---------------------------------------------------------------------------

type RealSink = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, Message>;
type RealStream = futures_util::stream::SplitStream<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>>;

pub struct RealSender(RealSink);
pub struct RealReceiver(RealStream);

#[async_trait]
impl Sender for RealSender {
    type Item = Message;
    async fn send(&mut self, msg: Self::Item) -> MyRes<()> {
        self.0.send(msg).await.map_err(|e| Box::new(e) as MyErr)
    }
}

#[async_trait]
impl Receiver for RealReceiver {
    type Item = Message;
    async fn recv(&mut self) -> MyRes<Option<Self::Item>> {
        match self.0.next().await {
            Some(Ok(m)) => Ok(Some(m)),
            Some(Err(e)) => Err(Box::new(e) as MyErr),
            None => Ok(None),
        }
    }
}

fn default_ws_config() -> WebSocketConfig {
    WebSocketConfig { max_message_size: Some(8192), max_frame_size: Some(8192), ..Default::default() }
}

async fn open_ws(url: &str) -> MyRes<(RealSender, RealReceiver)> {
    log::info!("[WSC] Connecting to url '{url}'");
    let (stream, _) = connect_async_with_config(url, Some(default_ws_config()), false)
        .await
        .map_err(|e| Box::new(e) as MyErr)?;
    let (sink, stream) = stream.split();
    Ok((RealSender(sink), RealReceiver(stream)))
}

/// `Connector` that opens a real websocket connection to `url`.
fn real_connector(url: String) -> Box<dyn Connector<Message>> {
    Box::new(WsConnector::new(url))
}


// ---------------------------------------------------------------------------
// Connection-agnostic sender/receiver tasks
// ---------------------------------------------------------------------------

async fn sender_task<T>(
    mut ws_sender: Box<dyn Sender<Item = T>>,
    mut send_rx: mpsc::Receiver<T>,
    stopper: CancellationToken,
) -> mpsc::Receiver<T> {
    loop {
        tokio::select! {
            _ = stopper.cancelled() => break,
            msg = send_rx.recv() => match msg {
                Some(m) => {
                    log::info!("[WSC] sending message");
                    if let Err(e) = ws_sender.send(m).await {
                        // This means ws is broken, needs restart.
                        // Stop the task and restart will be done from outside.
                        log::warn!("[WSC] send failed: {e}");
                        break;
                    }
                }
                None => {
                    // This shouldn't happen though, unless the client was dropped.
                    log::info!("[WSC] send queue closed, stopping sender task");
                    break;
                }
            }
        }
    }
    send_rx
}

async fn receive_task<F, T>(
    mut ws_receiver: Box<dyn Receiver<Item = T>>,
    stopper: CancellationToken,
    handler: F,
) -> F
    where
        F: Fn(T) + Send + Sync + 'static,
        T: Send + 'static
{
    loop {
        let msg = tokio::select! {
            _ = stopper.cancelled() => break,
            msg = ws_receiver.recv() => match msg {
                Ok(Some(m)) => m,
                Ok(None) => {
                    log::info!("[WSC] signalling connection closed by peer");
                    break;
                }
                Err(e) => {
                    log::warn!("[WSC] receive error: {e}");
                    // dont reset connection, it will be restarted from outside
                    break;
                }
            }
        };
        handler(msg);
    }
    handler
}

async fn run_loop<F, T>(
    connector: Box<dyn Connector<T>>,
    stopper: CancellationToken,
    mut send_rx: mpsc::Receiver<T>,
    mut handler: F,
    connected_state: Arc<AtomicBool>
) 
    where
        F: Fn(T) + Send + Sync + 'static,
        T: Send + 'static
{
    connected_state.store(false, std::sync::atomic::Ordering::SeqCst);
    while !stopper.is_cancelled() {
        let (ws_sender, ws_receiver) = tokio::select! {
            _ = stopper.cancelled() => break,
            conn = connector.connect() => match conn {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[WSC] failed to connect: {e}");
                    tokio::select! {
                        _ = stopper.cancelled() => break,
                        _ = sleep(Duration::from_secs(1)) => continue,
                    }
                }
            }
        };
        connected_state.store(true, std::sync::atomic::Ordering::SeqCst);
        let local_stopper = stopper.child_token();
        let mut receive_handle =
            tokio::spawn(receive_task(ws_receiver, local_stopper.clone(), handler));
        let mut sender_handle = tokio::spawn(sender_task::<T>(ws_sender, send_rx, local_stopper.clone()));

        send_rx = tokio::select! {
            _ = stopper.cancelled() => {
                // local_stopper is a child of stopper, so it's already cancelled here.
                let _ = (&mut receive_handle).await;
                let _ = (&mut sender_handle).await;
                break;
            }
            r = &mut receive_handle => {
                // likely some error occurred needing reconnection
                handler = match r {
                    Ok(handler) => handler,
                    Err(_) => break,
                };
                local_stopper.cancel();
                match (&mut sender_handle).await {
                    Ok(rx) => rx,
                    Err(_) => break,
                }
            }
            r = &mut sender_handle => {
                // likely some error occurred needing reconnection
                local_stopper.cancel();
                handler = match (&mut receive_handle).await {
                    Ok(handler) => handler,
                    Err(_) => break,
                };
                match r {
                    Ok(rx) => rx,
                    Err(_) => break,
                }
            }
        };
        log::info!("[WSC] connection lost, reconnecting...");
        // TODO: add a metric for connection restarts
    }
    connected_state.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Keeps a websocket connection to `url` alive, reconnecting as needed.
/// Outgoing frames go through `send_tx`; incoming frames are delivered to
/// the `MessageHandler` given at construction time, for the whole
/// lifetime of the `WsNode`.
pub struct WsNode<T: Send + 'static>
{
    pub send_tx: mpsc::Sender<T>,
    stopper: CancellationToken,
    is_connected: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl<T: Send + 'static> WsNode<T>
{
    /// Like `new`, but lets the caller supply the `Connector` used to open
    /// each connection attempt - tests use this to hand out channel-backed
    /// sender/receiver pairs instead of real websockets.
    pub fn new_with_connector<F>(connector: Box<dyn Connector<T>>, handler: F) -> Self
    where
        F: Fn(T) + Send + Sync + 'static,
    {
        let (send_tx, send_rx) = mpsc::channel::<T>(64);
        let handler = Box::new(handler);
        let stopper = CancellationToken::new();

        let is_connected = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn(run_loop(connector, stopper.clone(), send_rx, handler, is_connected.clone()));

        Self { send_tx, stopper, is_connected, task }
    }

    pub async fn send(&self, msg: T) -> MyRes<()> {
        if self.is_connected.load(std::sync::atomic::Ordering::SeqCst) {
            self.send_tx.send(msg).await.map_err(|_| "send queue closed".into())
        } else {
            Err("not connected".into())
        }
    }

    pub async fn stop(self) {
        self.stopper.cancel();
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {
    // ---------------------------------------------------------------------------
    // Tests for the reconnecting websocket transport.
    // ---------------------------------------------------------------------------
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use super::super::test_helpers::make_test_pair;
    use super::super::test_helpers::TestPair;
    struct TestConnector {
        pairs: Mutex<Vec<TestPair>>,
    }
    #[async_trait]
    impl Connector<Message> for TestConnector {
        async fn connect(&self) -> MyRes<(Box<dyn Sender<Item = Message>>, Box<dyn Receiver<Item = Message>>)> {
            let mut pairs = self.pairs.lock().unwrap();
            assert_ne!(pairs.len(), 0, "no more pairs to hand out");
            let first_pair = pairs.remove(0);
            // the pair will get dropped and moved ws_sender and receiver will get invalidated
            Ok((Box::new(first_pair.ws_sender) as Box<dyn Sender<Item = Message>>, Box::new(first_pair.ws_receiver) as Box<dyn Receiver<Item = Message>>))
        }
    }
    /// `WsNode` should reconnect through `number_of_failed_attempts` dead
    /// pairs and keep delivering once it reaches the last, live pair.
    async fn reconnect_delivers_on_next_pair_with_params(number_of_failed_attempts: i32) {
        let mut test_pairs: Vec<TestPair> =
            (0..=number_of_failed_attempts).map(|_| make_test_pair()).collect();
        let TestPair { ws_sender, ws_receiver, ws_sender_rx, ws_receiver_tx } = make_test_pair();
        let mut last_ws_sender_rx = ws_sender_rx.expect("last ws_sender_rx should be Some");
        let last_ws_receiver_tx = ws_receiver_tx.expect("last ws_receiver_tx should be Some");
        
        test_pairs.push(TestPair {
            ws_sender,
            ws_receiver,
            ws_sender_rx: None,
            ws_receiver_tx: None,
        });
        let pairs = Mutex::new(test_pairs);
        let connector: Box<dyn Connector<Message>> =
            Box::new(TestConnector { pairs })
        ;

        let (recv_tx, mut recv_rx) = mpsc::unbounded_channel::<Message>();
        let node = WsNode::new_with_connector(connector, move |msg| {
            let _ = recv_tx.send(msg);
        });

        last_ws_receiver_tx.send(Message::text("world")).await.unwrap();
        assert_eq!(recv_rx.recv().await, Some(Message::text("world")));

        node.send(Message::text("hello")).await.unwrap();
        assert_eq!(last_ws_sender_rx.recv().await, Some(Message::text("hello")));

        node.stop().await;
    }

    #[tokio::test]
    async fn reconnect_delivers_through_multiple_dead_pairs() {
        for i in 1..=13 {
            reconnect_delivers_on_next_pair_with_params(i).await;
        }
    }

}


//! Reconnecting websocket transport used by the signalling connection.
//!
//! `WsNode` knows nothing about acks, sequence numbers, or `SignalMsg` -
//! it just keeps a websocket connection to a url alive, exposes `send_tx`
//! for outgoing frames and `receive_rx` for incoming frames. Reliability
//! (acks, retries, ordering) is layered on top by the caller. See
//! `memo.md` ("Signalling connection handling pipeline").
//!
//! `sender_task`/`receive_task` are generic over the `WsSender`/`WsReceiver`
//! traits, so they work the same whether backed by a real websocket
//! (`RealSender`/`RealReceiver`) or, in tests, a pair of mpsc channels
//! (`ChannelSender`/`ChannelReceiver`).

use std::time::Duration;

use async_trait::async_trait;
use futures_util::future::BoxFuture;
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

/// Produces a fresh `(sender, receiver)` pair for one connection attempt.
/// In production this opens a real websocket; in tests it can hand out
/// pre-built channel-backed pairs instead.
pub type Connector = Box<dyn Fn() -> BoxFuture<'static, MyRes<(Box<dyn WsSender>, Box<dyn WsReceiver>)>> + Send + Sync>;

/// Sending half of a duplex message stream - a real websocket connection or
/// an in-memory test double.
#[async_trait]
pub trait WsSender: Send {
    async fn send(&mut self, msg: Message) -> MyRes<()>;
}

/// Receiving half of a duplex message stream. `recv` returning `Ok(None)`
/// means the peer closed the connection cleanly; an `Err` means something
/// broke and the caller should reconnect.
#[async_trait]
pub trait WsReceiver: Send {
    async fn recv(&mut self) -> MyRes<Option<Message>>;
}

// ---------------------------------------------------------------------------
// Real websocket implementation
// ---------------------------------------------------------------------------

type RealSink = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, Message>;
type RealStream = futures_util::stream::SplitStream<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>>;

pub struct RealSender(RealSink);
pub struct RealReceiver(RealStream);

#[async_trait]
impl WsSender for RealSender {
    async fn send(&mut self, msg: Message) -> MyRes<()> {
        self.0.send(msg).await.map_err(|e| Box::new(e) as MyErr)
    }
}

#[async_trait]
impl WsReceiver for RealReceiver {
    async fn recv(&mut self) -> MyRes<Option<Message>> {
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
fn real_connector(url: String) -> Connector {
    Box::new(move || {
        let url = url.clone();
        Box::pin(async move {
            let (sender, receiver) = open_ws(&url).await?;
            Ok((Box::new(sender) as Box<dyn WsSender>, Box::new(receiver) as Box<dyn WsReceiver>))
        })
    })
}


// ---------------------------------------------------------------------------
// Connection-agnostic sender/receiver tasks
// ---------------------------------------------------------------------------

async fn sender_task(
    mut ws_sender: Box<dyn WsSender>,
    mut send_rx: mpsc::Receiver<Message>,
    stopper: CancellationToken,
) -> mpsc::Receiver<Message> {
    loop {
        tokio::select! {
            _ = stopper.cancelled() => break,
            msg = send_rx.recv() => match msg {
                Some(m) => {
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

async fn receive_task(mut ws_receiver: Box<dyn WsReceiver>, stopper: CancellationToken, receive_tx: mpsc::Sender<Message>) {
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
        if receive_tx.send(msg).await.is_err() {
            // nobody is listening anymore, nothing more to do here
            break;
        }
    }
}

async fn run_loop(
    connector: Connector,
    stopper: CancellationToken,
    mut send_rx: mpsc::Receiver<Message>,
    receive_tx: mpsc::Sender<Message>,
) {
    while !stopper.is_cancelled() {
        let (ws_sender, ws_receiver) = tokio::select! {
            _ = stopper.cancelled() => break,
            conn = connector() => match conn {
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

        let local_stopper = stopper.child_token();
        let mut receive_handle =
            tokio::spawn(receive_task(ws_receiver, local_stopper.clone(), receive_tx.clone()));
        let mut sender_handle = tokio::spawn(sender_task(ws_sender, send_rx, local_stopper.clone()));

        send_rx = tokio::select! {
            _ = stopper.cancelled() => {
                // local_stopper is a child of stopper, so it's already cancelled here.
                let _ = (&mut receive_handle).await;
                match (&mut sender_handle).await {
                    Ok(rx) => rx,
                    Err(_) => break,
                }
            }
            r = &mut receive_handle => {
                // likely some error occurred needing reconnection
                let _ = r;
                local_stopper.cancel();
                match (&mut sender_handle).await {
                    Ok(rx) => rx,
                    Err(_) => break,
                }
            }
            r = &mut sender_handle => {
                // likely some error occurred needing reconnection
                local_stopper.cancel();
                let _ = (&mut receive_handle).await;
                match r {
                    Ok(rx) => rx,
                    Err(_) => break,
                }
            }
        };
        // TODO: add a metric for connection restarts
    }
}

/// Keeps a websocket connection to `url` alive, reconnecting as needed.
/// Outgoing frames go through `send_tx`; incoming frames arrive on
/// `receive_rx`.
pub struct WsNode {
    pub send_tx: mpsc::Sender<Message>,
    pub receive_rx: mpsc::Receiver<Message>,
    stopper: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl WsNode {
    pub fn new(url: String) -> Self {
        let connector = real_connector(url.clone());
        Self::new_with_connector(connector)
    }

    /// Like `new`, but lets the caller supply the `Connector` used to open
    /// each connection attempt - tests use this to hand out channel-backed
    /// sender/receiver pairs instead of real websockets.
    pub fn new_with_connector(connector: Connector) -> Self {
        let (send_tx, send_rx) = mpsc::channel::<Message>(64);
        let (receive_tx, receive_rx) = mpsc::channel::<Message>(64);
        let stopper = CancellationToken::new();

        let task = tokio::spawn(run_loop(connector, stopper.clone(), send_rx, receive_tx));

        Self { send_tx, receive_rx, stopper, task }
    }

    pub async fn send(&self, msg: Message) -> MyRes<()> {
        self.send_tx.send(msg).await.map_err(|_| "send queue closed".into())
    }

    pub async fn recv(&mut self) -> Option<Message> {
        self.receive_rx.recv().await
    }

    pub async fn stop(self) {
        self.stopper.cancel();
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {

    // ---------------------------------------------------------------------------
    // Test implementation: emulates the wire with a pair of mpsc channels.
    // ---------------------------------------------------------------------------

    /// `WsSender` that forwards to an mpsc channel instead of a real socket -
    /// tests read from the paired `Receiver<Message>` to assert what `WsNode`
    /// sent "over the wire".
    pub struct ChannelSender(pub mpsc::Sender<Message>);
    pub struct ChannelReceiver(pub mpsc::Receiver<Message>);

    #[async_trait]
    impl WsSender for ChannelSender {
        async fn send(&mut self, msg: Message) -> MyRes<()> {
            self.0.send(msg).await.map_err(|_| "test channel closed".into())
        }
    }

    #[async_trait]
    impl WsReceiver for ChannelReceiver {
        async fn recv(&mut self) -> MyRes<Option<Message>> {
            Ok(self.0.recv().await)
        }
    }
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// Builds a connected pair: a `ChannelSender`/`ChannelReceiver` for use
    /// by `sender_task`/`receive_task`, plus the test-side channel ends
    /// used to inject/observe traffic.
    struct TestPair {
        ws_sender: ChannelSender,
        ws_receiver: ChannelReceiver,
        ws_sender_rx: Option<mpsc::Receiver<Message>>,
        ws_receiver_tx: Option<mpsc::Sender<Message>>,
    }

    fn make_test_pair() -> TestPair {
        let (sender_tx, sender_rx) = mpsc::channel::<Message>(16); // WsNode -> test
        let (receiver_tx, receiver_rx) = mpsc::channel::<Message>(16); // test -> WsNode
        TestPair {
            ws_sender: ChannelSender(sender_tx),
            ws_receiver: ChannelReceiver(receiver_rx),
            ws_sender_rx: Some(sender_rx),
            ws_receiver_tx: Some(receiver_tx),
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
        
        test_pairs.push(TestPair { ws_sender, ws_receiver, ws_sender_rx: None, ws_receiver_tx: None });
        let pairs = Mutex::new(test_pairs);
        let connector: Connector =
            Box::new(move || {
                let mut pairs = pairs.lock().unwrap();
                assert_ne!(pairs.len(), 0, "no more pairs to hand out");
                let first_pair = pairs.remove(0);
                Box::pin(async move {
                    // the pari will get dropped and moved ws_sender and receiver will get invalidated
                    Ok((Box::new(first_pair.ws_sender) as Box<dyn WsSender>, Box::new(first_pair.ws_receiver) as Box<dyn WsReceiver>))
                })
            })
        ;

        let mut node = WsNode::new_with_connector(connector);

        last_ws_receiver_tx.send(Message::text("world")).await.unwrap();
        assert_eq!(node.recv().await, Some(Message::text("world")));

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

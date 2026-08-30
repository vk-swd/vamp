

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::common::{MyRes};
use super::ws_node::{Sender, Receiver};

/// `WsSender` that forwards to an mpsc channel instead of a real socket.
pub(crate) struct ChannelSender(pub(crate) mpsc::Sender<Message>);

/// `WsReceiver` that reads from an mpsc channel instead of a real socket.
pub(crate) struct ChannelReceiver(pub(crate) mpsc::Receiver<Message>);

#[async_trait]
impl Sender for ChannelSender {
    type Item = Message;
    async fn send(&mut self, msg: Message) -> MyRes<()> {
        self.0.send(msg).await.map_err(|_| "test channel closed".into())
    }
}

#[async_trait]
impl Receiver for ChannelReceiver {
    type Item = Message;
    async fn recv(&mut self) -> MyRes<Option<Message>> {
        Ok(self.0.recv().await)
    }
}

/// A fake duplex websocket pair and the test-side channel ends used to
/// inject and observe traffic.
pub(crate) struct TestPair {
    pub(crate) ws_sender: ChannelSender,
    pub(crate) ws_receiver: ChannelReceiver,
    pub(crate) ws_sender_rx: Option<mpsc::Receiver<Message>>,
    pub(crate) ws_receiver_tx: Option<mpsc::Sender<Message>>,
}

pub(crate) fn make_test_pair() -> TestPair {
    let (sender_tx, sender_rx) = mpsc::channel::<Message>(16); // WsNode -> test
    let (receiver_tx, receiver_rx) = mpsc::channel::<Message>(16); // test -> WsNode
    TestPair {
        ws_sender: ChannelSender(sender_tx),
        ws_receiver: ChannelReceiver(receiver_rx),
        ws_sender_rx: Some(sender_rx),
        ws_receiver_tx: Some(receiver_tx),
    }
}

use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const DEBOUNCE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DebounceEvent {
    Start,
    End,
}

struct Event {
    event: DebounceEvent,
}

pub struct IceRestartDebouncer {
    event_tx: mpsc::Sender<Event>,
    notify_tx: broadcast::Sender<()>,
    stopper: CancellationToken,
    finish_handle: Mutex<Option<JoinHandle<()>>>,
}

impl IceRestartDebouncer {
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::channel(64);
        let (notify_tx, _) = broadcast::channel(64);
        let stopper = CancellationToken::new();

        let handle = Self::spawn_run(event_rx, notify_tx.clone(), stopper.clone());

        Self {
            event_tx,
            notify_tx,
            stopper,
            finish_handle: Mutex::new(Some(handle)),
        }
    }

    fn spawn_run(
        mut event_rx: mpsc::Receiver<Event>,
        notify_tx: broadcast::Sender<()>,
        stopper: CancellationToken,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut deb_state = DebounceEvent::End;
            loop {
                if deb_state == DebounceEvent::End {
                    tokio::select! {
                        biased;
                        _ = stopper.cancelled() => break,
                        maybe_event = event_rx.recv() => {
                            match maybe_event {
                                Some(Event { event }) => {
                                    deb_state = event;
                                }
                                None => break, // all senders dropped
                            }
                        }
                    }
                } else {
                    tokio::select! {
                        biased;
                        _ = stopper.cancelled() => break,
                        maybe_event = event_rx.recv() => {
                            match maybe_event {
                                Some(Event { event }) => {
                                    deb_state = event;
                                }
                                None => break,
                            }
                        }
                        _ = tokio::time::sleep(DEBOUNCE_TIMEOUT) => {
                            // Previous negotiation took too long; will be restarted.
                            let _ = notify_tx.send(());
                            deb_state = DebounceEvent::End;
                        }
                    }
                }
            }
        })
    }

    pub async fn stop(&self) {
        self.stopper.cancel();
        let handle = self.finish_handle.lock().unwrap().take();
        if let Some(handle) = handle {
            let _ = handle.await;
        }
    }

    pub fn start(&self) {
        let _ = self.event_tx.try_send(Event {
            event: DebounceEvent::Start,
        });
    }

    pub fn end(&self) {
        let _ = self.event_tx.try_send(Event {
            event: DebounceEvent::End,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.notify_tx.subscribe()
    }
}

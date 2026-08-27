use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use futures_util::StreamExt;
use tokio_util::time::DelayQueue;
const DEBOUNCE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DebounceEvent {
    Start,
    End,
}

struct Event {
    event: DebounceEvent,
    id: u64,
}

pub struct IceRestartDebouncer {
    event_tx: mpsc::Sender<Event>,
    notify_tx: broadcast::Sender<u64>,
    stopper: CancellationToken,
    scheduled_id: AtomicU64,
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
            scheduled_id: AtomicU64::new(0),
            finish_handle: Mutex::new(Some(handle)),
        }
    }

    fn spawn_run(
        mut event_rx: mpsc::Receiver<Event>,
        notify_tx: broadcast::Sender<u64>,
        stopper: CancellationToken,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut deb_state = DebounceEvent::End;
            let mut current_id: u64 = 0;

            loop {
                if deb_state == DebounceEvent::End {
                    tokio::select! {
                        biased;
                        _ = stopper.cancelled() => break,
                        maybe_event = event_rx.recv() => {
                            match maybe_event {
                                Some(Event { event, id }) => {
                                    if event != DebounceEvent::End {
                                        current_id = id;
                                    }
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
                                Some(Event { event, id }) => {
                                    if event != DebounceEvent::End {
                                        current_id = id;
                                    }
                                    deb_state = event;
                                }
                                None => break,
                            }
                        }
                        _ = tokio::time::sleep(DEBOUNCE_TIMEOUT) => {
                            // Previous negotiation took too long; will be restarted.
                            let _ = notify_tx.send(current_id);
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

    pub async fn start(&self) -> u64 {
        let id = self.scheduled_id.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self
            .event_tx
            .send(Event { event: DebounceEvent::Start, id })
            .await;
        id
    }

    pub async fn end(&self) {
        let id = self.scheduled_id.load(Ordering::Relaxed);
        let _ = self
            .event_tx
            .send(Event { event: DebounceEvent::End, id })
            .await;
    }

    pub async fn wait_for_debounce(&self, id: u64) {
        let mut rx = self.notify_tx.subscribe();
        loop {
            match rx.recv().await {
                Ok(val) if val == id => return,
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue, // missed some, keep trying
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

pub struct SimpleDebouncer {
    task_queue: DelayQueue<u64>,
    key: Option<tokio_util::time::delay_queue::Key>,
}

impl SimpleDebouncer {
    pub fn new() -> Self {
        Self {
            task_queue: DelayQueue::new(),
            key: None,
        }
    }

    pub async fn stop(&mut self) {
        if let Some(key) = self.key.take() {
            self.task_queue.remove(&key);
            self.key = None;
        }
    }

    pub async fn start(&mut self) {
        if let Some(key) = self.key.take() {
            self.task_queue.remove(&key);
        }
        let key: tokio_util::time::delay_queue::Key = self.task_queue.insert(0, DEBOUNCE_TIMEOUT);
        self.key = Some(key);
    }
    pub fn is_running(&self) -> bool {
        self.key.is_some()
    }
    pub async fn wait_for_debounce(&mut self) {
        self.task_queue.next().await;
        self.key = None;
        
    }
}
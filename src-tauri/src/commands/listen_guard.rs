use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct ListenGuard {
    last: Mutex<Option<Instant>>,
}

pub type ArcListenGuard = Arc<ListenGuard>;

impl ListenGuard {
    pub fn new() -> ArcListenGuard {
        Arc::new(Self { last: Mutex::new(None) })
    }

    /// Returns true if this listen record should be committed.
    /// Rejects records for the same track arriving within the specified interval (in seconds) of the previous one.
    pub fn should_record(&self, interval: i32) -> bool {
        let now = Instant::now();
        let mut guard = self.last.lock().unwrap();
        match *guard {
            Some(t) => {
                let should_drop = (now - t) < Duration::from_secs_f64(interval as f64 * 0.9);
                if !should_drop {
                    *guard = Some(now);
                }
                !should_drop
            }
            _ => {
                *guard = Some(now);
                true
            }
        }
    }
}

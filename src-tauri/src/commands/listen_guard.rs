use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct ListenGuard {
    last: Mutex<Option<(i64, Instant)>>,
}

pub type ArcListenGuard = Arc<ListenGuard>;

impl ListenGuard {
    pub fn new() -> ArcListenGuard {
        Arc::new(Self { last: Mutex::new(None) })
    }

    /// Returns true if this listen record should be committed.
    /// Rejects records for the same track arriving within the specified interval (in seconds) of the previous one.
    pub fn should_record(&self, track_id: i64, interval: i64) -> bool {
        let mut guard = self.last.lock().unwrap();
        match *guard {
            Some((id, t)) if id == track_id && t.elapsed() < Duration::from_secs_f64(interval as f64 * 0.9) => false,
            _ => {
                *guard = Some((track_id, Instant::now()));
                true
            }
        }
    }
}

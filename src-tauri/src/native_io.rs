//! Admission happens before scheduling blocking work. Dropping an awaiting caller does not
//! release its permit: the synchronous OS operation owns it until actual settlement.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

pub struct IoGate {
    active: Arc<AtomicUsize>,
    limit: usize,
}

impl IoGate {
    fn new(limit: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }

    pub fn try_acquire(&self) -> Option<IoPermit> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.limit).then_some(active + 1)
            })
            .ok()?;
        Some(IoPermit {
            active: Arc::clone(&self.active),
        })
    }

    pub fn unsettled(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

pub struct IoPermit {
    active: Arc<AtomicUsize>,
}

impl Drop for IoPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct NativeIo {
    pub open: IoGate,
    pub range: IoGate,
    pub metadata: IoGate,
    pub control: IoGate,
}

impl NativeIo {
    pub fn global() -> &'static Self {
        static IO: OnceLock<NativeIo> = OnceLock::new();
        IO.get_or_init(|| Self {
            open: IoGate::new(crate::open_request::MAX_OPEN_REQUESTS),
            range: IoGate::new(4),
            metadata: IoGate::new(2),
            control: IoGate::new(8),
        })
    }

    pub fn unsettled(&self) -> usize {
        self.open.unsettled()
            + self.range.unsettled()
            + self.metadata.unsettled()
            + self.control.unsettled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn blocked_work_keeps_capacity_until_os_work_settles() {
        let gate = IoGate::new(1);
        let permit = gate.try_acquire().unwrap();
        let (release, wait) = mpsc::channel();
        let (done, completion) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _permit = permit;
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            let _ = done.send(());
        });
        // Simulate a caller abandoning its response receiver, not cancelling OS work.
        drop(completion);
        assert_eq!(gate.unsettled(), 1);
        assert!(gate.try_acquire().is_none());
        release.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(gate.unsettled(), 0);
        assert!(gate.try_acquire().is_some());
    }

    #[test]
    fn aborting_started_blocking_task_does_not_release_its_permit() {
        let gate = IoGate::new(1);
        let permit = gate.try_acquire().unwrap();
        let (started, ready) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let (finished, settled) = mpsc::channel();
        let handle = tauri::async_runtime::spawn_blocking(move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            drop(permit);
            finished.send(()).unwrap();
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        handle.abort();
        drop(handle);
        assert_eq!(gate.unsettled(), 1);
        assert!(gate.try_acquire().is_none());
        release.send(()).unwrap();
        settled.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(gate.unsettled(), 0);
    }
    #[test]
    fn independent_control_capacity_survives_saturated_io() {
        let reads = IoGate::new(2);
        let control = IoGate::new(1);
        let first = reads.try_acquire().unwrap();
        let second = reads.try_acquire().unwrap();
        assert!(reads.try_acquire().is_none());
        assert!(control.try_acquire().is_some());
        drop(first);
        drop(second);
        assert_eq!(reads.unsettled(), 0);
    }
}

use super::{
    CleanupTask, PdfOwner, PdfSessionError, SessionId, Sessions, TeardownOwner,
    TrustedRecentIdentity,
};
use crate::native_io::IoPermit;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex};

pub(crate) enum FileValue {
    Range(Vec<u8>),
    Identity(TrustedRecentIdentity),
}

pub(crate) type FileWork = Box<dyn FnOnce() -> Result<FileValue, PdfSessionError> + Send + 'static>;
pub(crate) type FileCallback =
    Box<dyn FnOnce(Result<FileValue, PdfSessionError>, FileCompletion) + Send + 'static>;

pub(crate) struct DispatchJob {
    pub(crate) reservation_id: u64,
    pub(crate) owner: PdfOwner,
    pub(crate) id: SessionId,
    pub(crate) generation: u64,
    pub(crate) file: Arc<Mutex<File>>,
    pub(crate) file_key: usize,
    pub(crate) work: Option<FileWork>,
    pub(crate) complete: Option<FileCallback>,
    pub(crate) metadata_permit: Option<IoPermit>,
}

struct Reservation {
    owner: PdfOwner,
    id: SessionId,
    file_key: usize,
    phase: ReservationPhase,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReservationPhase {
    Queued,
    Selected,
}

pub(crate) struct DispatcherState {
    queues: HashMap<SessionId, VecDeque<u64>>,
    order: VecDeque<SessionId>,
    jobs: HashMap<u64, DispatchJob>,
    reservations: HashMap<u64, Reservation>,
    selected_files: HashSet<usize>,
    queued: usize,
    selected: usize,
    next_reservation: u64,
}

impl DispatcherState {
    pub(crate) fn file_selected(&self, file_key: usize) -> bool {
        self.selected_files.contains(&file_key)
    }
}

pub(crate) struct FileDispatcher {
    state: Mutex<DispatcherState>,
}

impl FileDispatcher {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(DispatcherState {
                queues: HashMap::new(),
                order: VecDeque::new(),
                jobs: HashMap::new(),
                reservations: HashMap::new(),
                selected_files: HashSet::new(),
                queued: 0,
                selected: 0,
                next_reservation: 1,
            }),
        }
    }

    pub(crate) fn enqueue(&self, mut job: DispatchJob) -> Result<u64, Box<DispatchJob>> {
        let mut state = self.state.lock().expect("file dispatcher poisoned");
        if state.queued >= super::MAX_PROCESS_QUEUE {
            return Err(Box::new(job));
        }
        let reservation_id = state.next_reservation;
        let Some(next_reservation) = reservation_id.checked_add(1) else {
            return Err(Box::new(job));
        };
        state.next_reservation = next_reservation;
        job.reservation_id = reservation_id;
        let id = job.id.clone();
        let owner = job.owner.clone();
        let file_key = job.file_key;
        let new_session_queue = state.queues.get(&id).map_or(true, VecDeque::is_empty);
        state
            .queues
            .entry(id.clone())
            .or_default()
            .push_back(reservation_id);
        if new_session_queue {
            state.order.push_back(id.clone());
        }
        state.jobs.insert(reservation_id, job);
        state.reservations.insert(
            reservation_id,
            Reservation {
                owner,
                id,
                file_key,
                phase: ReservationPhase::Queued,
            },
        );
        state.queued += 1;
        Ok(reservation_id)
    }

    /// Select only the head of each session queue. Sessions rotate fairly; an ineligible
    /// head is not bypassed by a later job from the same session.
    pub(crate) fn take_next<F>(&self, mut eligible: F) -> Option<DispatchJob>
    where
        F: FnMut(&DispatcherState, &DispatchJob) -> bool,
    {
        let mut state = self.state.lock().expect("file dispatcher poisoned");
        if state.selected >= super::MAX_PROCESS_IN_FLIGHT {
            return None;
        }
        let rounds = state.order.len();
        for _ in 0..rounds {
            let Some(session_id) = state.order.pop_front() else {
                break;
            };
            let Some(reservation_id) = state
                .queues
                .get(&session_id)
                .and_then(VecDeque::front)
                .copied()
            else {
                continue;
            };
            let Some(job) = state.jobs.get(&reservation_id) else {
                continue;
            };
            if state.selected_files.contains(&job.file_key) || !eligible(&state, job) {
                state.order.push_back(session_id);
                continue;
            }
            let queue = state
                .queues
                .get_mut(&session_id)
                .expect("selected file queue missing");
            debug_assert_eq!(queue.front().copied(), Some(reservation_id));
            queue.pop_front();
            if queue.is_empty() {
                state.queues.remove(&session_id);
            } else {
                state.order.push_back(session_id);
            }
            state.queued = state.queued.checked_sub(1).expect("file queue underflow");
            let file_key = {
                let reservation = state
                    .reservations
                    .get_mut(&reservation_id)
                    .expect("selected reservation missing");
                reservation.phase = ReservationPhase::Selected;
                reservation.file_key
            };
            state.selected += 1;
            assert!(state.selected_files.insert(file_key));
            return state.jobs.remove(&reservation_id);
        }
        None
    }

    pub(crate) fn revoke_where<F>(&self, mut predicate: F) -> Vec<DispatchJob>
    where
        F: FnMut(&DispatchJob) -> bool,
    {
        let mut state = self.state.lock().expect("file dispatcher poisoned");
        let ids = state
            .jobs
            .iter()
            .filter_map(|(reservation_id, job)| predicate(job).then_some(*reservation_id))
            .collect::<Vec<_>>();
        let mut revoked = Vec::with_capacity(ids.len());
        for reservation_id in ids {
            let Some(job) = state.jobs.remove(&reservation_id) else {
                continue;
            };
            let (removed, queue_empty) = if let Some(queue) = state.queues.get_mut(&job.id) {
                let position = queue.iter().position(|id| *id == reservation_id);
                if let Some(position) = position {
                    queue.remove(position);
                }
                (position.is_some(), queue.is_empty())
            } else {
                (false, false)
            };
            if removed {
                state.queued = state.queued.checked_sub(1).expect("file queue underflow");
            }
            if queue_empty {
                state.queues.remove(&job.id);
            }
            revoked.push(job);
        }
        let queued_sessions = state.queues.keys().cloned().collect::<HashSet<_>>();
        state.order.retain(|id| queued_sessions.contains(id));
        revoked
    }

    pub(crate) fn release(&self, reservation_id: u64) -> Option<(SessionId, ReservationPhase)> {
        let mut state = self.state.lock().expect("file dispatcher poisoned");
        let reservation = state.reservations.remove(&reservation_id)?;
        if reservation.phase == ReservationPhase::Selected {
            state.selected = state
                .selected
                .checked_sub(1)
                .expect("selected file admission underflow");
            state.selected_files.remove(&reservation.file_key);
        }
        Some((reservation.id, reservation.phase))
    }

    pub(crate) fn queued(&self) -> usize {
        self.state.lock().expect("file dispatcher poisoned").queued
    }

    pub(crate) fn selected(&self) -> usize {
        self.state
            .lock()
            .expect("file dispatcher poisoned")
            .selected
    }

    pub(crate) fn has_work_for_owner(&self, owner: &PdfOwner) -> bool {
        let state = self.state.lock().expect("file dispatcher poisoned");
        state.jobs.values().any(|job| &job.owner == owner)
            || state
                .reservations
                .values()
                .any(|reservation| &reservation.owner == owner)
    }
}

pub(crate) struct FileCompletion {
    inner: Option<FileCompletionInner>,
}

struct FileCompletionInner {
    dispatcher: Arc<FileDispatcher>,
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
    cleanup_tx: SyncSender<CleanupTask>,
    id: SessionId,
    owner: PdfOwner,
    generation: u64,
    reservation_id: u64,
    metadata_permit: Option<IoPermit>,
}

impl FileCompletion {
    pub(crate) fn empty() -> Self {
        Self { inner: None }
    }

    pub(crate) fn is_admitted(&self) -> bool {
        self.inner.is_some()
    }

    pub(super) fn from_job(
        dispatcher: Arc<FileDispatcher>,
        sessions: Arc<Mutex<Sessions>>,
        drained: Arc<Condvar>,
        cleanup_tx: SyncSender<CleanupTask>,
        job: &mut DispatchJob,
    ) -> Self {
        Self {
            inner: Some(FileCompletionInner {
                dispatcher,
                sessions,
                drained,
                cleanup_tx,
                id: job.id.clone(),
                owner: job.owner.clone(),
                generation: job.generation,
                reservation_id: job.reservation_id,
                metadata_permit: job.metadata_permit.take(),
            }),
        }
    }

    pub(crate) fn guard_result<T>(
        &self,
        result: Result<T, PdfSessionError>,
    ) -> Result<T, PdfSessionError> {
        let Some(inner) = &self.inner else {
            return result;
        };
        let sessions = inner.sessions.lock().expect("session state poisoned");
        let Some(session) = sessions.entries.get(&inner.id) else {
            return Err(PdfSessionError::SessionNotFound);
        };
        if session.owner.window_label != inner.owner.window_label {
            return Err(PdfSessionError::OwnerMismatch);
        }
        if session.owner.generation != inner.owner.generation
            || session.generation != inner.generation
        {
            return Err(PdfSessionError::GenerationMismatch);
        }
        if session.teardown != TeardownOwner::Active {
            return Err(PdfSessionError::SessionClosing);
        }
        result
    }
}

impl Drop for FileCompletion {
    fn drop(&mut self) {
        let Some(mut inner) = self.inner.take() else {
            return;
        };
        let mut sessions = inner.sessions.lock().expect("session state poisoned");
        if let Some((id, phase)) = inner.dispatcher.release(inner.reservation_id) {
            match phase {
                ReservationPhase::Queued => {
                    if let Some(session) = sessions.entries.get_mut(&id) {
                        session.queued = session
                            .queued
                            .checked_sub(1)
                            .expect("session queue underflow");
                    }
                    sessions.process_queued = sessions
                        .process_queued
                        .checked_sub(1)
                        .expect("process queue underflow");
                }
                ReservationPhase::Selected => {
                    if let Some(session) = sessions.entries.get_mut(&id) {
                        session.in_flight = session
                            .in_flight
                            .checked_sub(1)
                            .expect("session selected underflow");
                    }
                    sessions.process_in_flight = sessions
                        .process_in_flight
                        .checked_sub(1)
                        .expect("process selected underflow");
                }
            }
            super::PdfSessionManager::queue_deferred_drained_session(
                &mut sessions,
                &inner.cleanup_tx,
                &id,
            );
        }
        drop(sessions);
        drop(inner.metadata_permit.take());
        inner.drained.notify_all();
        super::pump_file_dispatch_parts(
            inner.dispatcher,
            inner.sessions,
            inner.drained,
            inner.cleanup_tx,
        );
    }
}

pub(crate) fn file_key(file: &Arc<Mutex<File>>) -> usize {
    Arc::as_ptr(file) as usize
}

pub(crate) fn spawn_selected_job(
    mut job: DispatchJob,
    dispatcher: Arc<FileDispatcher>,
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
    cleanup_tx: SyncSender<CleanupTask>,
) {
    let token = FileCompletion::from_job(
        Arc::clone(&dispatcher),
        Arc::clone(&sessions),
        Arc::clone(&drained),
        cleanup_tx.clone(),
        &mut job,
    );
    let Some(work) = job.work.take() else {
        drop(token);
        return;
    };
    let Some(complete) = job.complete.take() else {
        drop(token);
        return;
    };
    drop(job.file); // Only the executing closure retains the extra handle before completion.
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
            .unwrap_or(Err(PdfSessionError::FileUnreadable));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            complete(result, token);
        }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn owner(generation: u64) -> PdfOwner {
        PdfOwner {
            window_label: format!("window-{generation}"),
            generation,
        }
    }

    fn id(value: char) -> SessionId {
        SessionId(value.to_string().repeat(64))
    }

    fn job(id: SessionId, owner: PdfOwner, file: Arc<Mutex<File>>) -> DispatchJob {
        DispatchJob {
            reservation_id: 0,
            owner,
            id,
            generation: 1,
            file_key: file_key(&file),
            file,
            work: None,
            complete: None,
            metadata_permit: None,
        }
    }

    #[test]
    fn queue_has_global_bound_and_head_only_selection() {
        let dispatcher = FileDispatcher::new();
        let path =
            std::env::temp_dir().join(format!("modeleaf-dispatch-{}.bin", rand::random::<u64>()));
        let mut created = File::create(&path).unwrap();
        created.write_all(b"source-bytes").unwrap();
        drop(created);
        let file = Arc::new(Mutex::new(File::open(&path).unwrap()));
        let first = id('a');
        let second = id('b');
        for index in 0..super::super::MAX_PROCESS_QUEUE {
            let session = if index == 0 {
                first.clone()
            } else {
                second.clone()
            };
            let owner = if index == 0 { owner(1) } else { owner(2) };
            dispatcher
                .enqueue(job(session, owner, Arc::clone(&file)))
                .ok()
                .expect("bounded dispatch admission");
        }
        assert!(dispatcher
            .enqueue(job(first.clone(), owner(1), Arc::clone(&file)))
            .is_err());
        let selected = dispatcher
            .take_next(|_, job| job.id == first)
            .expect("first session head should be selected");
        assert_eq!(selected.id, first);
        assert!(dispatcher.take_next(|_, _| true).is_none());
        dispatcher.release(selected.reservation_id);
        let second_selected = dispatcher
            .take_next(|_, _| true)
            .expect("next file owner becomes eligible after release");
        dispatcher.release(second_selected.reservation_id);
        drop(dispatcher);
        drop(file);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_file_is_physically_exclusive_until_completion_release() {
        let dispatcher = FileDispatcher::new();
        let path =
            std::env::temp_dir().join(format!("modeleaf-dispatch-{}.bin", rand::random::<u64>()));
        File::create(&path).unwrap();
        let file = Arc::new(Mutex::new(File::open(&path).unwrap()));
        let first = dispatcher
            .enqueue(job(id('a'), owner(1), Arc::clone(&file)))
            .ok()
            .expect("bounded dispatch admission");
        let second = dispatcher
            .enqueue(job(id('b'), owner(2), Arc::clone(&file)))
            .ok()
            .expect("bounded dispatch admission");
        let selected = dispatcher
            .take_next(|state, job| !state.file_selected(job.file_key))
            .unwrap();
        assert_eq!(selected.reservation_id, first);
        assert!(dispatcher
            .take_next(|state, job| !state.file_selected(job.file_key))
            .is_none());
        assert_eq!(
            dispatcher.release(first).unwrap().1,
            ReservationPhase::Selected
        );
        let second_selected = dispatcher
            .take_next(|state, job| !state.file_selected(job.file_key))
            .unwrap();
        assert_eq!(second_selected.reservation_id, second);
        dispatcher.release(second_selected.reservation_id);
        drop(dispatcher);
        drop(file);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn selected_limit_is_four_with_distinct_retained_handles() {
        let dispatcher = FileDispatcher::new();
        let path =
            std::env::temp_dir().join(format!("modeleaf-dispatch-{}.bin", rand::random::<u64>()));
        File::create(&path).unwrap();
        let files = (0..4)
            .map(|_| Arc::new(Mutex::new(File::open(&path).unwrap())))
            .collect::<Vec<_>>();
        let reservations = files
            .iter()
            .enumerate()
            .map(|(index, file)| {
                dispatcher
                    .enqueue(job(
                        id((b'a' + index as u8) as char),
                        owner(index as u64 + 1),
                        Arc::clone(file),
                    ))
                    .ok()
                    .expect("bounded dispatch admission")
            })
            .collect::<Vec<_>>();
        for _ in 0..4 {
            assert!(dispatcher
                .take_next(|state, job| !state.file_selected(job.file_key))
                .is_some());
        }
        assert_eq!(dispatcher.selected(), 4);
        assert!(dispatcher
            .take_next(|state, job| !state.file_selected(job.file_key))
            .is_none());
        for reservation in reservations {
            dispatcher.release(reservation);
        }
        drop(dispatcher);
        drop(files);
        std::fs::remove_file(path).unwrap();
    }
}

use crate::external_link::{validate_external_link, ExternalLinkError};
use crate::local_path::{
    FinalHandlePolicy, LocalPathPolicy, SystemFinalHandlePolicy, SystemLocalPathPolicy,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

pub const NORMAL_RANGE_LIMIT: u32 = 1024 * 1024;
pub const ABSOLUTE_RANGE_LIMIT: u32 = 4 * 1024 * 1024;
pub const MAX_DOCUMENT_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_SESSIONS: usize = 8;
pub const MAX_PROCESS_IN_FLIGHT: usize = 4;
pub const MAX_SESSION_IN_FLIGHT: usize = 2;
pub const MAX_PROCESS_QUEUE: usize = 32;
pub const MAX_SESSION_QUEUE: usize = 8;
pub const MAX_EXTERNAL_LINK_OPERATIONS: usize = 256;
pub const MAX_EXTERNAL_LINK_PROCESS_IN_FLIGHT: usize = 4;
pub const MAX_EXTERNAL_LINK_SESSION_IN_FLIGHT: usize = 2;
pub const MAX_OPEN_PROCESS_IN_FLIGHT: usize = MAX_SESSIONS;
const MAX_HANDLE_CLEANUP_QUEUE: usize = MAX_SESSIONS;
const MAX_OWNER_FENCES: usize = 64;
const EXTERNAL_LINK_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

pub const MAX_EXTERNAL_LINKS_PER_SESSION: usize = 256;
pub const MAX_CLOSED_SESSION_TOMBSTONES: usize = 64;
pub const MAX_ANNOTATION_ID_BYTES: usize = 1_024;

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
pub struct SessionId(String);
impl SessionId {
    fn random() -> Self {
        let mut bytes = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        Self(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    pub fn from_opaque(value: String) -> Result<Self, PdfSessionError> {
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            Ok(Self(value))
        } else {
            Err(PdfSessionError::SessionNotFound)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
pub struct PdfOwner {
    pub window_label: String,
    pub generation: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PdfSessionMetadata {
    pub session_id: SessionId,
    pub document_generation: u64,
    pub length: u64,
}
#[derive(Debug, Eq, PartialEq)]
pub struct TrustedRecentIdentity {
    canonical_path: PathBuf,
}

impl TrustedRecentIdentity {
    pub(crate) fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ExternalLinkRegistration {
    pub annotation_id: String,
    pub target: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelBarrier {
    pub barrier_id: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExternalLinkActivationOperation<'a> {
    pub registry_revision: u64,
    pub annotation_id: &'a str,
    pub operation_id: &'a str,
    pub operation_sequence: u64,
}

impl<'a> ExternalLinkActivationOperation<'a> {
    pub fn new(
        registry_revision: u64,
        annotation_id: &'a str,
        operation_id: &'a str,
        operation_sequence: u64,
    ) -> Self {
        Self {
            registry_revision,
            annotation_id,
            operation_id,
            operation_sequence,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PdfSessionError {
    PathRejected,
    MissingFile,
    FileUnreadable,
    PdfInvalid,
    DocumentTooLarge,
    SessionCapacity,
    RangeInvalid,
    RangeCapacity,
    SessionNotFound,
    OwnerMismatch,
    GenerationMismatch,
    SessionClosing,
    BarrierMismatch,
    DialogFailed,
    ExternalLinkDrainTimeout,
}
impl std::fmt::Display for PdfSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.tag())
    }
}
impl std::error::Error for PdfSessionError {}
impl PdfSessionError {
    pub fn tag(&self) -> &'static str {
        match self {
            Self::PathRejected => "PATH_REJECTED",
            Self::MissingFile => "MISSING_FILE",
            Self::FileUnreadable => "FILE_UNREADABLE",
            Self::PdfInvalid => "PDF_INVALID",
            Self::DocumentTooLarge => "DOCUMENT_TOO_LARGE",
            Self::SessionCapacity => "SESSION_CAPACITY",
            Self::RangeInvalid => "RANGE_INVALID",
            Self::RangeCapacity => "RANGE_CAPACITY",
            Self::SessionNotFound => "SESSION_NOT_FOUND",
            Self::OwnerMismatch => "OWNER_MISMATCH",
            Self::GenerationMismatch => "GENERATION_MISMATCH",
            Self::SessionClosing => "SESSION_CLOSING",
            Self::BarrierMismatch => "BARRIER_MISMATCH",
            Self::DialogFailed => "DIALOG_FAILED",
            Self::ExternalLinkDrainTimeout => "EXTERNAL_LINK_DRAIN_TIMEOUT",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileSnapshot {
    length: u64,
    modified: SystemTime,
}
enum ExternalLinkTransaction {
    Prepared {
        revision: u64,
        proposed_links: HashMap<String, String>,
    },
    Committed {
        revision: u64,
        previous_links: HashMap<String, String>,
        previous_revision: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TeardownOwner {
    Active,
    CommandCancelling,
    LifecycleDeferred,
}

struct ActivePrintLease {
    id: u64,
    cancellation_flag: Arc<AtomicBool>,
}
struct Session {
    owner: PdfOwner,
    generation: u64,
    length: u64,
    modified: SystemTime,
    file: Arc<Mutex<File>>,
    teardown: TeardownOwner,
    queued: usize,
    in_flight: usize,
    external_link_in_flight: usize,
    print_lease: Option<ActivePrintLease>,
    print_invalidated: bool,
    activation_operations: HashMap<u64, Arc<ActivationOperation>>,
    retained_activation_operations: VecDeque<u64>,
    highest_operation_sequence: u64,
    barrier: Option<u64>,
    external_links: HashMap<String, String>,
    registry_revision: u64,
    finalized_external_link_revision: Option<u64>,
    aborted_external_link_revision: Option<u64>,
    external_link_transaction: Option<ExternalLinkTransaction>,
}
#[derive(Clone)]
struct ClosedSession {
    id: SessionId,
    owner: PdfOwner,
    generation: u64,
    barrier_id: u64,
}

enum ActivationOperationState {
    Pending,
    Complete(Result<(), ExternalLinkError>),
}
struct ActivationOperation {
    id: String,
    state: Mutex<ActivationOperationState>,
}
struct OwnerFence {
    window_label: String,
    generation: u64,
}
struct OpeningOperation {
    owner: PdfOwner,
    invalidated: Arc<AtomicBool>,
}
struct CleanupTask {
    owner: PdfOwner,
    id: SessionId,
    session: Session,
    closed: Option<ClosedSession>,
}
struct Sessions {
    entries: HashMap<SessionId, Session>,
    closed_tombstones: VecDeque<ClosedSession>,
    next_generation: u64,
    next_barrier: u64,
    next_print_lease: u64,
    process_queued: usize,
    process_in_flight: usize,
    external_link_process_in_flight: usize,
    process_opening_in_flight: usize,
    opening_operations: HashMap<u64, OpeningOperation>,
    next_open_sequence: u64,
    owner_generation_fences: VecDeque<OwnerFence>,
    lifecycle_fence_all: bool,
    cleanup_pending: usize,
    pending_closes: HashMap<SessionId, ClosedSession>,
    cleanup_by_session: HashMap<SessionId, PdfOwner>,
    cleanup_by_owner: HashMap<PdfOwner, usize>,
}
#[derive(Clone)]
pub struct PdfSessionManager {
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
    cleanup_tx: SyncSender<CleanupTask>,
}
pub struct PdfPrintLease {
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
    id: SessionId,
    lease_id: u64,
    cancellation_flag: Arc<AtomicBool>,
    cleanup_tx: SyncSender<CleanupTask>,
}

impl PdfPrintLease {
    pub fn cancellation_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancellation_flag)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancellation_flag.load(Ordering::Acquire)
    }
}

impl Drop for PdfPrintLease {
    fn drop(&mut self) {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        if let Some(session) = sessions.entries.get_mut(&self.id) {
            if session.print_lease.as_ref().is_some_and(|lease| {
                lease.id == self.lease_id
                    && Arc::ptr_eq(&lease.cancellation_flag, &self.cancellation_flag)
            }) {
                session.print_lease = None;
            }
        }
        PdfSessionManager::queue_deferred_drained_session(
            &mut sessions,
            &self.cleanup_tx,
            &self.id,
        );
        self.drained.notify_all();
    }
}

struct ExternalLinkAdmission {
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
    id: SessionId,
    released: bool,
    cleanup_tx: SyncSender<CleanupTask>,
}

impl ExternalLinkAdmission {
    fn settle(
        &mut self,
        operation: &Arc<ActivationOperation>,
        sequence: u64,
        result: Result<(), ExternalLinkError>,
    ) {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        if let Some(session) = sessions.entries.get_mut(&self.id) {
            if session
                .activation_operations
                .get(&sequence)
                .is_some_and(|current| Arc::ptr_eq(current, operation))
            {
                *operation
                    .state
                    .lock()
                    .expect("external-link operation poisoned") =
                    ActivationOperationState::Complete(result);
                while session.retained_activation_operations.len() >= MAX_EXTERNAL_LINK_OPERATIONS {
                    if let Some(oldest) = session.retained_activation_operations.pop_front() {
                        session.activation_operations.remove(&oldest);
                    }
                }
                session.retained_activation_operations.push_back(sequence);
            }
            session.external_link_in_flight -= 1;
        }
        sessions.external_link_process_in_flight -= 1;
        self.released = true;
        PdfSessionManager::queue_deferred_drained_session(
            &mut sessions,
            &self.cleanup_tx,
            &self.id,
        );
        self.drained.notify_all();
    }
}

impl Drop for ExternalLinkAdmission {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        if let Some(session) = sessions.entries.get_mut(&self.id) {
            session.external_link_in_flight -= 1;
        }
        sessions.external_link_process_in_flight -= 1;
        self.released = true;
        PdfSessionManager::queue_deferred_drained_session(
            &mut sessions,
            &self.cleanup_tx,
            &self.id,
        );
        self.drained.notify_all();
    }
}
struct OpenAdmission {
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
    sequence: u64,
    invalidated: Arc<AtomicBool>,
    released: bool,
}

impl OpenAdmission {
    fn release(&mut self) {
        if self.released {
            return;
        }
        {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            if sessions.opening_operations.remove(&self.sequence).is_some() {
                sessions.process_opening_in_flight = sessions
                    .process_opening_in_flight
                    .checked_sub(1)
                    .expect("opening admission underflow");
            }
            self.released = true;
        }
        self.drained.notify_all();
    }
}

impl Drop for OpenAdmission {
    fn drop(&mut self) {
        self.release();
    }
}

struct ProcessAdmission {
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
    id: SessionId,
    queued: bool,
    in_flight: bool,
    released: bool,
    cleanup_tx: SyncSender<CleanupTask>,
    file: Option<Arc<Mutex<File>>>,
}

impl ProcessAdmission {
    fn promote(&mut self) -> Result<(), PdfSessionError> {
        if !self.queued || self.in_flight || self.released {
            return Err(PdfSessionError::SessionClosing);
        }
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let process_full = sessions.process_in_flight >= MAX_PROCESS_IN_FLIGHT;
        let session = sessions
            .entries
            .get_mut(&self.id)
            .ok_or(PdfSessionError::SessionNotFound)?;
        if session.teardown != TeardownOwner::Active {
            return Err(PdfSessionError::SessionClosing);
        }
        if process_full || session.in_flight >= MAX_SESSION_IN_FLIGHT {
            return Err(PdfSessionError::RangeCapacity);
        }
        session.queued -= 1;
        session.in_flight += 1;
        sessions.process_queued -= 1;
        sessions.process_in_flight += 1;
        self.queued = false;
        self.in_flight = true;
        Ok(())
    }

    fn finish(&mut self) -> bool {
        if self.released {
            return false;
        }
        drop(self.file.take());
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let closing = sessions
            .entries
            .get(&self.id)
            .map_or(true, |session| session.teardown != TeardownOwner::Active);
        if let Some(session) = sessions.entries.get_mut(&self.id) {
            if self.queued {
                session.queued -= 1;
            }
            if self.in_flight {
                session.in_flight -= 1;
            }
        }
        if self.queued {
            sessions.process_queued -= 1;
        }
        if self.in_flight {
            sessions.process_in_flight -= 1;
        }
        self.queued = false;
        self.in_flight = false;
        self.released = true;
        PdfSessionManager::queue_deferred_drained_session(
            &mut sessions,
            &self.cleanup_tx,
            &self.id,
        );
        self.drained.notify_all();
        closing
    }
}

impl Drop for ProcessAdmission {
    fn drop(&mut self) {
        self.finish();
    }
}
impl Default for PdfSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PdfSessionManager {
    fn begin_cleanup_locked(sessions: &mut Sessions, id: &SessionId, owner: &PdfOwner) {
        sessions.cleanup_pending += 1;
        sessions
            .cleanup_by_session
            .insert(id.clone(), owner.clone());
        *sessions.cleanup_by_owner.entry(owner.clone()).or_insert(0) += 1;
    }

    fn finish_cleanup_locked(
        sessions: &mut Sessions,
        id: &SessionId,
        owner: &PdfOwner,
        closed: Option<ClosedSession>,
    ) {
        sessions.cleanup_pending = sessions
            .cleanup_pending
            .checked_sub(1)
            .expect("cleanup admission underflow");
        sessions.cleanup_by_session.remove(id);
        let remove_owner = if let Some(count) = sessions.cleanup_by_owner.get_mut(owner) {
            *count = count.checked_sub(1).expect("owner cleanup underflow");
            *count == 0
        } else {
            false
        };
        if remove_owner {
            sessions.cleanup_by_owner.remove(owner);
        }
        if let Some(closed) = closed {
            sessions.pending_closes.remove(&closed.id);
            sessions.closed_tombstones.push_back(closed);
            while sessions.closed_tombstones.len() > MAX_CLOSED_SESSION_TOMBSTONES {
                sessions.closed_tombstones.pop_front();
            }
        }
    }

    fn enqueue_cleanup_locked(
        cleanup_tx: &SyncSender<CleanupTask>,
        sessions: &mut Sessions,
        id: &SessionId,
        session: Session,
        closed: Option<ClosedSession>,
    ) -> Option<CleanupTask> {
        let owner = session.owner.clone();
        Self::begin_cleanup_locked(sessions, id, &owner);
        let task = CleanupTask {
            id: id.clone(),
            owner,
            session,
            closed,
        };
        match cleanup_tx.try_send(task) {
            Ok(()) => None,
            Err(TrySendError::Full(task) | TrySendError::Disconnected(task)) => {
                // Rollback is NOT physical settlement and must not create a close tombstone.
                Self::finish_cleanup_locked(sessions, &task.id, &task.owner, None);
                Some(task)
            }
        }
    }
    pub fn new() -> Self {
        let sessions = Arc::new(Mutex::new(Sessions {
            entries: HashMap::new(),
            closed_tombstones: VecDeque::new(),
            next_generation: 1,
            next_barrier: 1,
            next_print_lease: 1,
            process_queued: 0,
            process_in_flight: 0,
            external_link_process_in_flight: 0,
            process_opening_in_flight: 0,
            opening_operations: HashMap::new(),
            next_open_sequence: 1,
            owner_generation_fences: VecDeque::new(),
            lifecycle_fence_all: false,
            cleanup_pending: 0,
            pending_closes: HashMap::new(),
            cleanup_by_session: HashMap::new(),
            cleanup_by_owner: HashMap::new(),
        }));
        let drained = Arc::new(Condvar::new());
        let (cleanup_tx, cleanup_rx) = mpsc::sync_channel::<CleanupTask>(MAX_HANDLE_CLEANUP_QUEUE);
        let worker_sessions = Arc::clone(&sessions);
        let worker_drained = Arc::clone(&drained);
        std::thread::Builder::new()
            .name("modeleaf-pdf-handle-cleanup".into())
            .spawn(move || {
                while let Ok(task) = cleanup_rx.recv() {
                    let owner = task.owner.clone();
                    let id = task.id.clone();
                    let closed = task.closed;
                    drop(task.session);
                    let mut state = worker_sessions.lock().expect("session state poisoned");
                    Self::finish_cleanup_locked(&mut state, &id, &owner, closed);
                    drop(state);
                    worker_drained.notify_all();
                }
            })
            .expect("failed to start PDF handle cleanup worker");
        Self {
            sessions,
            drained,
            cleanup_tx,
        }
    }
    fn owner_fenced(sessions: &Sessions, owner: &PdfOwner) -> bool {
        sessions.lifecycle_fence_all
            || sessions.owner_generation_fences.iter().any(|fence| {
                fence.window_label == owner.window_label && owner.generation <= fence.generation
            })
    }

    fn fence_owner(sessions: &mut Sessions, owner: &PdfOwner) {
        if let Some(fence) = sessions
            .owner_generation_fences
            .iter_mut()
            .find(|fence| fence.window_label == owner.window_label)
        {
            fence.generation = fence.generation.max(owner.generation);
            return;
        }
        sessions.owner_generation_fences.push_back(OwnerFence {
            window_label: owner.window_label.clone(),
            generation: owner.generation,
        });
        while sessions.owner_generation_fences.len() > MAX_OWNER_FENCES {
            sessions.owner_generation_fences.pop_front();
        }
    }

    fn admit_open(&self, owner: &PdfOwner) -> Result<OpenAdmission, PdfSessionError> {
        let invalidated = Arc::new(AtomicBool::new(false));
        let sequence = {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            if Self::owner_fenced(&sessions, owner) {
                return Err(PdfSessionError::SessionClosing);
            }
            let occupied = sessions
                .entries
                .len()
                .checked_add(sessions.process_opening_in_flight)
                .and_then(|count| count.checked_add(sessions.cleanup_pending));
            if sessions.entries.len() >= MAX_SESSIONS
                || sessions.process_opening_in_flight >= MAX_OPEN_PROCESS_IN_FLIGHT
                || occupied.map_or(true, |count| count >= MAX_SESSIONS)
            {
                return Err(PdfSessionError::SessionCapacity);
            }
            let sequence = sessions.next_open_sequence;
            sessions.next_open_sequence = sessions
                .next_open_sequence
                .checked_add(1)
                .ok_or(PdfSessionError::SessionCapacity)?;
            sessions.opening_operations.insert(
                sequence,
                OpeningOperation {
                    owner: owner.clone(),
                    invalidated: Arc::clone(&invalidated),
                },
            );
            sessions.process_opening_in_flight += 1;
            sequence
        };
        Ok(OpenAdmission {
            sessions: Arc::clone(&self.sessions),
            drained: Arc::clone(&self.drained),
            sequence,
            invalidated,
            released: false,
        })
    }

    pub fn owner_is_empty(&self, owner: &PdfOwner) -> bool {
        let sessions = self.sessions.lock().expect("session state poisoned");
        !sessions
            .entries
            .values()
            .any(|session| &session.owner == owner)
            && !sessions
                .opening_operations
                .values()
                .any(|operation| &operation.owner == owner)
            && !sessions.cleanup_by_owner.contains_key(owner)
    }

    /// Opens a read-only filesystem PDF and validates the retained handle's storage policy,
    /// deriving its identity from that handle rather than resolving the mutable input path.
    #[cfg(windows)]
    pub fn open_local_file(
        &self,
        owner: PdfOwner,
        path: &Path,
    ) -> Result<PdfSessionMetadata, PdfSessionError> {
        self.open_local_with_identity(
            owner,
            path,
            &SystemLocalPathPolicy,
            &SystemFinalHandlePolicy,
            |path| File::open(path),
            |file| SystemFinalHandlePolicy.canonical_path(file),
        )
    }

    #[cfg(not(windows))]
    pub fn open_local_file(
        &self,
        owner: PdfOwner,
        path: &Path,
    ) -> Result<PdfSessionMetadata, PdfSessionError> {
        self.open_local(
            owner,
            path,
            &SystemLocalPathPolicy,
            &SystemFinalHandlePolicy,
            |path| File::open(path),
        )
    }

    /// Test/injected opener boundary. Its supplied path is an explicitly trusted identity; the
    /// production entry point above always obtains identity from the retained handle instead.
    pub fn open_local<P, F, O>(
        &self,
        owner: PdfOwner,
        path: &Path,
        policy: &P,
        final_policy: &F,
        opener: O,
    ) -> Result<PdfSessionMetadata, PdfSessionError>
    where
        P: LocalPathPolicy,
        F: FinalHandlePolicy,
        O: FnOnce(&Path) -> io::Result<File>,
    {
        self.open_local_with_identity(owner, path, policy, final_policy, opener, |_| {
            Ok(path.to_path_buf())
        })
    }

    fn open_local_with_identity<P, F, O, I>(
        &self,
        owner: PdfOwner,
        path: &Path,
        policy: &P,
        final_policy: &F,
        opener: O,
        identity: I,
    ) -> Result<PdfSessionMetadata, PdfSessionError>
    where
        P: LocalPathPolicy,
        F: FinalHandlePolicy,
        O: FnOnce(&Path) -> io::Result<File>,
        I: FnOnce(&File) -> Result<PathBuf, crate::local_path::PathPolicyError>,
    {
        let mut open_admission = self.admit_open(&owner)?;
        let origin = policy
            .classify_syntax(path)
            .map_err(|_| PdfSessionError::PathRejected)?;
        let resolved = policy
            .classify(path)
            .map_err(|_| PdfSessionError::PathRejected)?;
        match (origin, resolved) {
            (
                crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable,
                crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable,
            )
            | (crate::local_path::DriveKind::Remote, crate::local_path::DriveKind::Remote) => {}
            _ => return Err(PdfSessionError::PathRejected),
        }
        policy
            .validate_preopen(path)
            .map_err(|_| PdfSessionError::PathRejected)?;
        let mut file = opener(path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound
                && origin != crate::local_path::DriveKind::Remote
            {
                PdfSessionError::MissingFile
            } else {
                PdfSessionError::FileUnreadable
            }
        })?;
        let final_kind = final_policy
            .classify_final(&file)
            .map_err(|_| PdfSessionError::PathRejected)?;
        match (origin, final_kind) {
            (
                crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable,
                crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable,
            )
            | (crate::local_path::DriveKind::Remote, crate::local_path::DriveKind::Remote) => {}
            _ => return Err(PdfSessionError::PathRejected),
        }
        identity(&file).map_err(|_| PdfSessionError::PathRejected)?;
        let metadata = file
            .metadata()
            .map_err(|_| PdfSessionError::FileUnreadable)?;
        if !metadata.is_file() {
            return Err(PdfSessionError::FileUnreadable);
        }
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err(PdfSessionError::DocumentTooLarge);
        }
        let modified = metadata
            .modified()
            .map_err(|_| PdfSessionError::FileUnreadable)?;
        let mut magic = [0_u8; 5];
        file.read_exact(&mut magic).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                PdfSessionError::PdfInvalid
            } else {
                PdfSessionError::FileUnreadable
            }
        })?;
        if magic != *b"%PDF-" {
            return Err(PdfSessionError::PdfInvalid);
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|_| PdfSessionError::FileUnreadable)?;
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        if open_admission.invalidated.load(Ordering::Acquire)
            || Self::owner_fenced(&sessions, &owner)
        {
            return Err(PdfSessionError::SessionClosing);
        }
        if sessions.entries.len() >= MAX_SESSIONS {
            return Err(PdfSessionError::SessionCapacity);
        }
        let generation = sessions.next_generation;
        sessions.next_generation = sessions
            .next_generation
            .checked_add(1)
            .ok_or(PdfSessionError::SessionCapacity)?;
        let session_id = SessionId::random();
        let length = metadata.len();
        sessions.opening_operations.remove(&open_admission.sequence);
        sessions.process_opening_in_flight -= 1;
        open_admission.released = true;
        self.drained.notify_all();
        sessions.entries.insert(
            session_id.clone(),
            Session {
                owner,
                generation,
                length,
                modified,
                file: Arc::new(Mutex::new(file)),
                teardown: TeardownOwner::Active,
                queued: 0,
                in_flight: 0,
                print_lease: None,
                print_invalidated: false,
                barrier: None,
                external_links: HashMap::new(),
                external_link_in_flight: 0,
                activation_operations: HashMap::new(),
                retained_activation_operations: VecDeque::new(),
                highest_operation_sequence: 0,
                registry_revision: 0,
                finalized_external_link_revision: None,
                aborted_external_link_revision: None,
                external_link_transaction: None,
            },
        );
        Ok(PdfSessionMetadata {
            session_id,
            document_generation: generation,
            length,
        })
    }
    /// Re-validates the retained file handle and returns its current canonical identity
    /// for native recent-document persistence without resolving the mutable input path.
    pub fn trusted_recent_identity(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<TrustedRecentIdentity, PdfSessionError> {
        let (mut admission, _) = self.admit_file_operation(owner, id, generation)?;
        let file_arc = admission.file.take().expect("admitted file missing");
        let file = file_arc.lock().expect("session file poisoned");
        admission.promote()?;
        let result = SystemFinalHandlePolicy
            .classify_final(&file)
            .and_then(|_| SystemFinalHandlePolicy.canonical_path(&file))
            .map(|canonical_path| TrustedRecentIdentity { canonical_path })
            .map_err(|_| PdfSessionError::PathRejected);
        drop(file);
        drop(file_arc);
        if admission.finish() {
            Err(PdfSessionError::SessionClosing)
        } else {
            result
        }
    }

    fn admit_file_operation(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<(ProcessAdmission, FileSnapshot), PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        if sessions.process_queued >= MAX_PROCESS_QUEUE {
            return Err(PdfSessionError::RangeCapacity);
        }
        let session = Self::checked_session(&mut sessions, owner, id, generation)?;
        if session.teardown != TeardownOwner::Active {
            return Err(PdfSessionError::SessionClosing);
        }
        if session.queued >= MAX_SESSION_QUEUE {
            return Err(PdfSessionError::RangeCapacity);
        }
        let file = Arc::clone(&session.file);
        let snapshot = FileSnapshot {
            length: session.length,
            modified: session.modified,
        };
        session.queued += 1;
        sessions.process_queued += 1;
        Ok((
            ProcessAdmission {
                sessions: Arc::clone(&self.sessions),
                drained: Arc::clone(&self.drained),
                id: id.clone(),
                queued: true,
                in_flight: false,
                released: false,
                cleanup_tx: self.cleanup_tx.clone(),
                file: Some(file),
            },
            snapshot,
        ))
    }
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn resolve_canonical_path(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<PathBuf, PdfSessionError> {
        Ok(self
            .trusted_recent_identity(owner, id, generation)?
            .canonical_path)
    }
    pub fn session_length(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<u64, PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let session = Self::checked_session(&mut sessions, owner, id, generation)?;
        if session.teardown != TeardownOwner::Active {
            return Err(PdfSessionError::SessionClosing);
        }
        Ok(session.length)
    }
    /// Invalidates only print admission for sessions belonging to a replaced or
    /// closing renderer. Existing read/close authority is left intact.
    pub fn invalidate_print_owner(&self, window_label: &str) {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        for session in sessions
            .entries
            .values_mut()
            .filter(|session| session.owner.window_label == window_label)
        {
            session.print_invalidated = true;
            if let Some(lease) = &session.print_lease {
                lease.cancellation_flag.store(true, Ordering::Release);
            }
        }
        self.drained.notify_all();
    }
    pub fn acquire_print_lease(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<PdfPrintLease, PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        {
            let session = Self::checked_session(&mut sessions, owner, id, generation)?;
            if session.teardown != TeardownOwner::Active
                || session.print_invalidated
                || session.print_lease.is_some()
            {
                return Err(PdfSessionError::SessionClosing);
            }
        }
        let lease_id = sessions.next_print_lease;
        sessions.next_print_lease = sessions
            .next_print_lease
            .checked_add(1)
            .ok_or(PdfSessionError::SessionCapacity)?;
        let cancellation_flag = Arc::new(AtomicBool::new(false));
        sessions
            .entries
            .get_mut(id)
            .expect("validated print session missing")
            .print_lease = Some(ActivePrintLease {
            id: lease_id,
            cancellation_flag: Arc::clone(&cancellation_flag),
        });
        Ok(PdfPrintLease {
            sessions: Arc::clone(&self.sessions),
            drained: Arc::clone(&self.drained),
            id: id.clone(),
            lease_id,
            cleanup_tx: self.cleanup_tx.clone(),
            cancellation_flag,
        })
    }

    pub fn read_range(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        offset: u64,
        length: u32,
    ) -> Result<Vec<u8>, PdfSessionError> {
        self.read_range_limited(owner, id, generation, offset, length, NORMAL_RANGE_LIMIT)
    }
    pub fn read_range_absolute(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        offset: u64,
        length: u32,
    ) -> Result<Vec<u8>, PdfSessionError> {
        self.read_range_limited(owner, id, generation, offset, length, ABSOLUTE_RANGE_LIMIT)
    }
    fn read_range_limited(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        offset: u64,
        length: u32,
        limit: u32,
    ) -> Result<Vec<u8>, PdfSessionError> {
        if length > limit {
            return Err(PdfSessionError::RangeCapacity);
        }
        offset
            .checked_add(u64::from(length))
            .ok_or(PdfSessionError::RangeInvalid)?;
        let (mut admission, expected) = self.admit_file_operation(owner, id, generation)?;
        // Declared after admission: unwind drops the borrowed file before releasing admission.
        let file_arc = admission.file.take().expect("admitted file missing");
        let file = file_arc.lock().expect("file state poisoned");
        admission.promote()?;
        let available = usize::try_from(
            expected
                .length
                .saturating_sub(offset)
                .min(u64::from(length)),
        )
        .map_err(|_| PdfSessionError::RangeInvalid)?;
        let result = Self::read_file(file, offset, available, expected);
        drop(file_arc);
        if admission.finish() {
            Err(PdfSessionError::SessionClosing)
        } else {
            result
        }
    }
    fn file_snapshot(file: &File) -> Result<FileSnapshot, PdfSessionError> {
        let metadata = file
            .metadata()
            .map_err(|_| PdfSessionError::FileUnreadable)?;
        if !metadata.is_file() {
            return Err(PdfSessionError::FileUnreadable);
        }
        Ok(FileSnapshot {
            length: metadata.len(),
            modified: metadata
                .modified()
                .map_err(|_| PdfSessionError::FileUnreadable)?,
        })
    }

    fn read_file(
        mut file: std::sync::MutexGuard<'_, File>,
        offset: u64,
        available: usize,
        expected: FileSnapshot,
    ) -> Result<Vec<u8>, PdfSessionError> {
        if Self::file_snapshot(&file)? != expected {
            return Err(PdfSessionError::FileUnreadable);
        }
        if available > 0 {
            file.seek(SeekFrom::Start(offset))
                .map_err(|_| PdfSessionError::FileUnreadable)?;
        }
        let mut result = vec![0; available];
        if available > 0 {
            file.read_exact(&mut result)
                .map_err(|_| PdfSessionError::FileUnreadable)?;
        }
        if Self::file_snapshot(&file)? != expected {
            return Err(PdfSessionError::FileUnreadable);
        }
        Ok(result)
    }
    pub fn prepare_external_links(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        registry_revision: u64,
        entries: Vec<ExternalLinkRegistration>,
    ) -> Result<(), ExternalLinkError> {
        if registry_revision == 0 || entries.len() > MAX_EXTERNAL_LINKS_PER_SESSION {
            return Err(if registry_revision == 0 {
                ExternalLinkError::StaleRegistration
            } else {
                ExternalLinkError::LinkCapacity
            });
        }
        let mut proposed_links = HashMap::with_capacity(entries.len());
        for entry in entries {
            if !valid_annotation_id(&entry.annotation_id)
                || proposed_links
                    .insert(entry.annotation_id.clone(), entry.target.clone())
                    .is_some()
            {
                return Err(ExternalLinkError::LinkRejected);
            }
            validate_external_link(&entry.target)?;
        }

        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let session = Self::checked_external_link_session(&mut sessions, owner, id, generation)?;
        if let Some(ExternalLinkTransaction::Prepared {
            revision,
            proposed_links: prepared_links,
        }) = &session.external_link_transaction
        {
            return if *revision == registry_revision && *prepared_links == proposed_links {
                Ok(())
            } else {
                Err(ExternalLinkError::StaleRegistration)
            };
        }
        if registry_revision <= session.registry_revision {
            return Err(ExternalLinkError::StaleRegistration);
        }
        if let Some(ExternalLinkTransaction::Committed { revision, .. }) =
            session.external_link_transaction.take()
        {
            session.finalized_external_link_revision = Some(revision);
        }
        session.aborted_external_link_revision = None;
        session.external_link_transaction = Some(ExternalLinkTransaction::Prepared {
            revision: registry_revision,
            proposed_links,
        });
        Ok(())
    }

    pub fn commit_external_links(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        registry_revision: u64,
    ) -> Result<(), ExternalLinkError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let session = Self::checked_external_link_session(&mut sessions, owner, id, generation)?;
        match session.external_link_transaction.take() {
            Some(ExternalLinkTransaction::Prepared {
                revision,
                proposed_links,
            }) if revision == registry_revision => {
                let previous_links = std::mem::replace(&mut session.external_links, proposed_links);
                let previous_revision = std::mem::replace(&mut session.registry_revision, revision);
                session.external_link_transaction = Some(ExternalLinkTransaction::Committed {
                    revision,
                    previous_links,
                    previous_revision,
                });
                Ok(())
            }
            Some(transaction @ ExternalLinkTransaction::Committed { revision, .. })
                if revision == registry_revision =>
            {
                session.external_link_transaction = Some(transaction);
                Ok(())
            }
            Some(transaction) => {
                session.external_link_transaction = Some(transaction);
                Err(ExternalLinkError::StaleRegistration)
            }
            None if session.finalized_external_link_revision == Some(registry_revision)
                && session.registry_revision == registry_revision =>
            {
                Ok(())
            }
            None => Err(ExternalLinkError::StaleRegistration),
        }
    }

    pub fn finalize_external_links(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        registry_revision: u64,
    ) -> Result<(), ExternalLinkError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let session = Self::checked_external_link_session(&mut sessions, owner, id, generation)?;
        match session.external_link_transaction.take() {
            Some(ExternalLinkTransaction::Committed { revision, .. })
                if revision == registry_revision =>
            {
                session.finalized_external_link_revision = Some(revision);
                Ok(())
            }
            Some(transaction) => {
                session.external_link_transaction = Some(transaction);
                Err(ExternalLinkError::StaleRegistration)
            }
            None if session.finalized_external_link_revision == Some(registry_revision)
                && session.registry_revision == registry_revision =>
            {
                Ok(())
            }
            None => Err(ExternalLinkError::StaleRegistration),
        }
    }
    pub fn abort_external_links(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        registry_revision: u64,
    ) -> Result<(), ExternalLinkError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let session = Self::checked_external_link_session(&mut sessions, owner, id, generation)?;
        match session.external_link_transaction.take() {
            Some(ExternalLinkTransaction::Prepared { revision, .. })
                if revision == registry_revision =>
            {
                session.aborted_external_link_revision = Some(revision);
                Ok(())
            }
            Some(ExternalLinkTransaction::Committed {
                revision,
                previous_links,
                previous_revision,
            }) if revision == registry_revision => {
                session.external_links = previous_links;
                session.registry_revision = previous_revision;
                session.aborted_external_link_revision = Some(revision);
                Ok(())
            }
            Some(transaction) => {
                session.external_link_transaction = Some(transaction);
                Err(ExternalLinkError::StaleRegistration)
            }
            None if session.aborted_external_link_revision == Some(registry_revision)
                || (session.finalized_external_link_revision == Some(registry_revision)
                    && session.registry_revision == registry_revision) =>
            {
                Ok(())
            }
            None if registry_revision > session.registry_revision => {
                session.aborted_external_link_revision = Some(registry_revision);
                Ok(())
            }
            None => Err(ExternalLinkError::StaleRegistration),
        }
    }
    pub fn resolve_external_link(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        annotation_id: &str,
    ) -> Result<String, ExternalLinkError> {
        if !valid_annotation_id(annotation_id) {
            return Err(ExternalLinkError::LinkRejected);
        }
        let target = {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            let session =
                Self::checked_external_link_session(&mut sessions, owner, id, generation)?;
            Self::external_link_target(session, annotation_id, None)?
        };
        validate_external_link(&target)?;
        Ok(target)
    }
    #[cfg(any(test, debug_assertions))]
    /// Test hook retaining the historical launcher injection surface.
    pub fn activate_external_link_with<F, E>(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        registry_revision: u64,
        annotation_id: &str,
        launcher: F,
    ) -> Result<(), ExternalLinkError>
    where
        F: FnOnce(&str) -> Result<(), E>,
        E: 'static,
    {
        let operation_sequence = self
            .sessions
            .lock()
            .expect("session state poisoned")
            .entries
            .get(id)
            .map(|session| {
                session
                    .highest_operation_sequence
                    .checked_add(1)
                    .unwrap_or(0)
            })
            .unwrap_or(1);
        self.activate_external_link_with_operation(
            owner,
            id,
            generation,
            ExternalLinkActivationOperation::new(
                registry_revision,
                annotation_id,
                &format!("test-{:032x}", rand::random::<u128>()),
                operation_sequence,
            ),
            launcher,
        )
    }

    /// Atomically resolves, deduplicates, and admits an activation. Duplicate pending operations return immediately.
    pub fn activate_external_link_with_operation<F, E>(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        operation: ExternalLinkActivationOperation<'_>,
        launcher: F,
    ) -> Result<(), ExternalLinkError>
    where
        F: FnOnce(&str) -> Result<(), E>,
        E: 'static,
    {
        if operation.registry_revision == 0 {
            return Err(ExternalLinkError::StaleRegistration);
        }
        if !valid_annotation_id(operation.annotation_id)
            || !valid_operation_id(operation.operation_id)
        {
            return Err(ExternalLinkError::LinkRejected);
        }
        let (target, activation_operation, sequence) = {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            let process_full =
                sessions.external_link_process_in_flight >= MAX_EXTERNAL_LINK_PROCESS_IN_FLIGHT;
            let (target, activation_operation, sequence, is_new) = {
                let session = sessions
                    .entries
                    .get_mut(id)
                    .ok_or(ExternalLinkError::SessionNotFound)?;
                if session.owner.window_label != owner.window_label {
                    return Err(ExternalLinkError::OwnerMismatch);
                }
                if session.owner.generation != owner.generation || session.generation != generation
                {
                    return Err(ExternalLinkError::GenerationMismatch);
                }
                let sequence = operation.operation_sequence;
                if let Some(existing) = session.activation_operations.get(&sequence) {
                    if existing.id != operation.operation_id {
                        return Err(ExternalLinkError::LinkOperationMismatch);
                    }
                    return match &*existing
                        .state
                        .lock()
                        .expect("external-link operation poisoned")
                    {
                        ActivationOperationState::Pending => {
                            Err(ExternalLinkError::LinkOperationInProgress)
                        }
                        ActivationOperationState::Complete(result) => result.clone(),
                    };
                }
                if sequence <= session.highest_operation_sequence {
                    return Err(ExternalLinkError::LinkOperationExpired);
                }
                if session.teardown != TeardownOwner::Active {
                    return Err(ExternalLinkError::SessionClosing);
                }
                if process_full
                    || session.external_link_in_flight >= MAX_EXTERNAL_LINK_SESSION_IN_FLIGHT
                {
                    return Err(ExternalLinkError::LinkCapacity);
                }
                let target = Self::external_link_target(
                    session,
                    operation.annotation_id,
                    Some(operation.registry_revision),
                )?;
                validate_external_link(&target)?;
                let activation_operation = Arc::new(ActivationOperation {
                    id: operation.operation_id.to_owned(),
                    state: Mutex::new(ActivationOperationState::Pending),
                });
                session.highest_operation_sequence = sequence;
                session
                    .activation_operations
                    .insert(sequence, Arc::clone(&activation_operation));
                session.external_link_in_flight += 1;
                (target, activation_operation, sequence, true)
            };
            if is_new {
                sessions.external_link_process_in_flight += 1;
            }
            (target, activation_operation, sequence)
        };
        let mut admission = ExternalLinkAdmission {
            sessions: Arc::clone(&self.sessions),
            drained: Arc::clone(&self.drained),
            id: id.clone(),
            released: false,
            cleanup_tx: self.cleanup_tx.clone(),
        };
        let (result, panic_payload) =
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| launcher(&target))) {
                Ok(result) => (result.map_err(preserve_launch_outcome), None),
                Err(payload) => (Err(ExternalLinkError::LinkLaunchFailed), Some(payload)),
            };
        admission.settle(&activation_operation, sequence, result.clone());
        drop(admission);
        if let Some(payload) = panic_payload {
            std::panic::resume_unwind(payload);
        }
        result
    }
    fn external_link_target(
        session: &Session,
        annotation_id: &str,
        registry_revision: Option<u64>,
    ) -> Result<String, ExternalLinkError> {
        if registry_revision.is_none() || registry_revision == Some(session.registry_revision) {
            if let Some(target) = session.external_links.get(annotation_id) {
                return Ok(target.clone());
            }
        }
        if let Some(ExternalLinkTransaction::Committed {
            previous_links,
            previous_revision,
            ..
        }) = &session.external_link_transaction
        {
            if registry_revision.is_none() || registry_revision == Some(*previous_revision) {
                if let Some(target) = previous_links.get(annotation_id) {
                    return Ok(target.clone());
                }
            }
        }
        if registry_revision.is_some()
            && registry_revision != Some(session.registry_revision)
            && !matches!(
                &session.external_link_transaction,
                Some(ExternalLinkTransaction::Committed { previous_revision, .. })
                    if registry_revision == Some(*previous_revision)
            )
        {
            return Err(ExternalLinkError::StaleRegistration);
        }
        Err(ExternalLinkError::AnnotationNotFound)
    }

    pub fn cancel(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<CancelBarrier, PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        if !sessions.entries.contains_key(id) {
            return Self::closed_barrier(&sessions, owner, id, generation)?
                .map(|barrier_id| CancelBarrier { barrier_id })
                .ok_or(PdfSessionError::SessionNotFound);
        }
        let session = Self::checked_session(&mut sessions, owner, id, generation)?;
        match session.teardown {
            TeardownOwner::Active => session.teardown = TeardownOwner::CommandCancelling,
            TeardownOwner::CommandCancelling => {}
            TeardownOwner::LifecycleDeferred => return Err(PdfSessionError::SessionClosing),
        }
        if let Some(lease) = &session.print_lease {
            lease.cancellation_flag.store(true, Ordering::Release);
        }
        self.drained.notify_all();
        if let Some(barrier_id) = session.barrier {
            return Ok(CancelBarrier { barrier_id });
        }
        while sessions
            .entries
            .get(id)
            .ok_or(PdfSessionError::SessionNotFound)?
            .in_flight
            != 0
            || sessions
                .entries
                .get(id)
                .ok_or(PdfSessionError::SessionNotFound)?
                .queued
                != 0
            || sessions
                .entries
                .get(id)
                .ok_or(PdfSessionError::SessionNotFound)?
                .print_lease
                .is_some()
        {
            sessions = self.drained.wait(sessions).expect("session state poisoned");
        }
        let deadline = Instant::now() + EXTERNAL_LINK_DRAIN_TIMEOUT;
        while sessions
            .entries
            .get(id)
            .ok_or(PdfSessionError::SessionNotFound)?
            .external_link_in_flight
            != 0
        {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(PdfSessionError::ExternalLinkDrainTimeout)?;
            let (next, timed_out) = self
                .drained
                .wait_timeout(sessions, remaining)
                .expect("session state poisoned");
            sessions = next;
            if timed_out.timed_out()
                && sessions
                    .entries
                    .get(id)
                    .ok_or(PdfSessionError::SessionNotFound)?
                    .external_link_in_flight
                    != 0
            {
                return Err(PdfSessionError::ExternalLinkDrainTimeout);
            }
        }
        if sessions
            .entries
            .get(id)
            .ok_or(PdfSessionError::SessionNotFound)?
            .teardown
            != TeardownOwner::CommandCancelling
        {
            return Err(PdfSessionError::SessionClosing);
        }
        if let Some(barrier_id) = sessions
            .entries
            .get(id)
            .ok_or(PdfSessionError::SessionNotFound)?
            .barrier
        {
            return Ok(CancelBarrier { barrier_id });
        }
        let barrier_id = sessions.next_barrier;
        sessions.next_barrier = sessions
            .next_barrier
            .checked_add(1)
            .ok_or(PdfSessionError::BarrierMismatch)?;
        sessions
            .entries
            .get_mut(id)
            .ok_or(PdfSessionError::SessionNotFound)?
            .barrier = Some(barrier_id);
        Ok(CancelBarrier { barrier_id })
    }
    pub fn close(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        barrier_id: u64,
    ) -> Result<(), PdfSessionError> {
        {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            if let Some(pending) = sessions.pending_closes.get(id) {
                if pending.owner.window_label != owner.window_label {
                    return Err(PdfSessionError::OwnerMismatch);
                }
                if pending.owner.generation != owner.generation || pending.generation != generation
                {
                    return Err(PdfSessionError::GenerationMismatch);
                }
                if pending.barrier_id != barrier_id {
                    return Err(PdfSessionError::BarrierMismatch);
                }
                return Err(PdfSessionError::SessionClosing);
            }
            if !sessions.entries.contains_key(id) {
                return match Self::closed_barrier(&sessions, owner, id, generation)? {
                    Some(expected) if expected == barrier_id => Ok(()),
                    Some(_) => Err(PdfSessionError::BarrierMismatch),
                    None => Err(PdfSessionError::SessionNotFound),
                };
            }
            let session = Self::checked_session(&mut sessions, owner, id, generation)?;
            if session.teardown != TeardownOwner::CommandCancelling
                || session.in_flight != 0
                || session.queued != 0
                || session.print_lease.is_some()
                || session.external_link_in_flight != 0
            {
                return Err(PdfSessionError::SessionClosing);
            }
            if session.barrier != Some(barrier_id) {
                return Err(PdfSessionError::BarrierMismatch);
            }
            let closed = ClosedSession {
                id: id.clone(),
                owner: owner.clone(),
                generation,
                barrier_id,
            };
            let removed = sessions
                .entries
                .remove(id)
                .expect("validated session missing");
            sessions.pending_closes.insert(id.clone(), closed.clone());
            if let Some(task) = Self::enqueue_cleanup_locked(
                &self.cleanup_tx,
                &mut sessions,
                id,
                removed,
                Some(closed),
            ) {
                sessions.pending_closes.remove(id);
                sessions.entries.insert(id.clone(), task.session);
                return Err(PdfSessionError::SessionClosing);
            }
        }
        let deadline = Instant::now() + EXTERNAL_LINK_DRAIN_TIMEOUT;
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        loop {
            if sessions.pending_closes.contains_key(id) {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    return Err(PdfSessionError::SessionClosing);
                };
                let (next, timed_out) = self
                    .drained
                    .wait_timeout(sessions, remaining)
                    .expect("session state poisoned");
                sessions = next;
                if timed_out.timed_out() && sessions.pending_closes.contains_key(id) {
                    return Err(PdfSessionError::SessionClosing);
                }
                continue;
            }
            return match Self::closed_barrier(&sessions, owner, id, generation)? {
                Some(expected) if expected == barrier_id => Ok(()),
                Some(_) => Err(PdfSessionError::BarrierMismatch),
                None => Err(PdfSessionError::SessionNotFound),
            };
        }
    }
    /// Transfers timed-out command cancellation to lifecycle cleanup without releasing its owner.
    pub(crate) fn defer_command_cancellation(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<(), PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let session = Self::checked_session(&mut sessions, owner, id, generation)?;
        match session.teardown {
            TeardownOwner::CommandCancelling => session.teardown = TeardownOwner::LifecycleDeferred,
            TeardownOwner::LifecycleDeferred => {}
            TeardownOwner::Active => return Err(PdfSessionError::SessionClosing),
        }
        Self::queue_deferred_drained_session(&mut sessions, &self.cleanup_tx, id);
        self.drained.notify_all();
        Ok(())
    }

    /// No success is published until this exact session's last handle has settled.
    pub(crate) fn reap_deferred_cancellation(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<bool, PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        if let Some(cleanup_owner) = sessions.cleanup_by_session.get(id) {
            if cleanup_owner != owner {
                return Err(PdfSessionError::OwnerMismatch);
            }
            return Ok(false);
        }
        let Some(session) = sessions.entries.get(id) else {
            return Ok(true);
        };
        if session.owner.window_label != owner.window_label {
            return Err(PdfSessionError::OwnerMismatch);
        }
        if session.owner.generation != owner.generation || session.generation != generation {
            return Err(PdfSessionError::GenerationMismatch);
        }
        if session.teardown != TeardownOwner::LifecycleDeferred {
            return Err(PdfSessionError::SessionClosing);
        }
        Self::queue_deferred_drained_session(&mut sessions, &self.cleanup_tx, id);
        // Even an idle session now belongs to the cleanup worker; retry observes settlement.
        self.drained.notify_all();
        Ok(false)
    }

    pub fn drain_owner(&self, window_label: &str) {
        self.drain_matching(
            |owner| owner.window_label == window_label,
            EXTERNAL_LINK_DRAIN_TIMEOUT,
            None,
            false,
        );
    }

    pub fn defer_owned(&self, owner: &PdfOwner) {
        self.defer_matching(|candidate| candidate == owner, Some(owner.clone()), false);
    }

    pub fn drain_owned(&self, owner: &PdfOwner) {
        self.drain_matching(
            |candidate| candidate == owner,
            EXTERNAL_LINK_DRAIN_TIMEOUT,
            Some(owner.clone()),
            false,
        );
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn drain_owner_with_timeout_for_test(&self, window_label: &str, timeout: Duration) {
        self.drain_matching(
            |owner| owner.window_label == window_label,
            timeout,
            None,
            false,
        );
    }

    pub fn defer_all(&self) {
        self.defer_matching(|_| true, None, true);
    }

    pub fn drain_all(&self) {
        self.drain_matching(|_| true, EXTERNAL_LINK_DRAIN_TIMEOUT, None, true);
    }

    fn schedule_idle_cleanup_locked(
        &self,
        sessions: &mut Sessions,
        matches: &impl Fn(&PdfOwner) -> bool,
        all: bool,
    ) {
        let ids = sessions
            .entries
            .iter()
            .filter_map(|(id, session)| {
                ((all || matches(&session.owner))
                    && session.teardown == TeardownOwner::LifecycleDeferred
                    && session.in_flight == 0
                    && session.queued == 0
                    && session.external_link_in_flight == 0
                    && session.print_lease.is_none())
                .then_some(id.clone())
            })
            .collect::<Vec<_>>();
        for id in ids {
            let Some(session) = sessions.entries.remove(&id) else {
                continue;
            };
            if let Some(task) =
                Self::enqueue_cleanup_locked(&self.cleanup_tx, sessions, &id, session, None)
            {
                sessions.entries.insert(id, task.session);
                break;
            }
        }
    }
    fn defer_matching(
        &self,
        matches: impl Fn(&PdfOwner) -> bool,
        explicit: Option<PdfOwner>,
        all: bool,
    ) {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        if all {
            sessions.lifecycle_fence_all = true;
        }
        let mut owners = explicit.into_iter().collect::<Vec<_>>();
        for session in sessions.entries.values() {
            if all || matches(&session.owner) {
                owners.push(session.owner.clone());
            }
        }
        for operation in sessions.opening_operations.values() {
            if all || matches(&operation.owner) {
                operation.invalidated.store(true, Ordering::Release);
                owners.push(operation.owner.clone());
            }
        }
        if !all {
            for owner in owners {
                Self::fence_owner(&mut sessions, &owner);
            }
        }
        for session in sessions.entries.values_mut() {
            if !(all || matches(&session.owner)) {
                continue;
            }
            if let Some(lease) = &session.print_lease {
                lease.cancellation_flag.store(true, Ordering::Release);
            }
            if matches!(
                session.teardown,
                TeardownOwner::Active | TeardownOwner::CommandCancelling
            ) {
                session.teardown = TeardownOwner::LifecycleDeferred;
            }
        }
        self.schedule_idle_cleanup_locked(&mut sessions, &matches, all);
        drop(sessions);
        self.drained.notify_all();
    }

    fn drain_matching(
        &self,
        matches: impl Fn(&PdfOwner) -> bool,
        timeout: Duration,
        explicit: Option<PdfOwner>,
        all: bool,
    ) {
        self.defer_matching(&matches, explicit, all);
        let deadline = Instant::now() + timeout;
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        loop {
            self.schedule_idle_cleanup_locked(&mut sessions, &matches, all);
            let work = sessions
                .opening_operations
                .values()
                .any(|operation| all || matches(&operation.owner))
                || sessions
                    .cleanup_by_owner
                    .keys()
                    .any(|owner| all || matches(owner))
                || sessions.entries.values().any(|session| {
                    (all || matches(&session.owner))
                        && session.teardown == TeardownOwner::LifecycleDeferred
                });
            if !work {
                break;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return;
            };
            let (next, timed_out) = self
                .drained
                .wait_timeout(sessions, remaining)
                .expect("session state poisoned");
            sessions = next;
            if timed_out.timed_out() {
                return;
            }
        }
    }

    fn queue_deferred_drained_session(
        sessions: &mut Sessions,
        cleanup_tx: &SyncSender<CleanupTask>,
        id: &SessionId,
    ) {
        if !sessions.entries.get(id).is_some_and(|session| {
            session.teardown == TeardownOwner::LifecycleDeferred
                && session.in_flight == 0
                && session.queued == 0
                && session.external_link_in_flight == 0
                && session.print_lease.is_none()
        }) {
            return;
        }
        let session = sessions
            .entries
            .remove(id)
            .expect("drained session missing");
        if let Some(task) = Self::enqueue_cleanup_locked(cleanup_tx, sessions, id, session, None) {
            sessions.entries.insert(id.clone(), task.session);
        }
    }
    pub fn assert_empty(&self) -> bool {
        let sessions = self.sessions.lock().expect("session state poisoned");
        sessions
            .entries
            .values()
            .all(|session| session.print_lease.is_none())
            && sessions.entries.is_empty()
            && sessions.process_queued == 0
            && sessions.process_in_flight == 0
            && sessions.external_link_process_in_flight == 0
            && sessions.process_opening_in_flight == 0
            && sessions.opening_operations.is_empty()
            && sessions.cleanup_pending == 0
            && sessions.cleanup_by_session.is_empty()
            && sessions.pending_closes.is_empty()
    }

    fn checked_external_link_session<'a>(
        sessions: &'a mut Sessions,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<&'a mut Session, ExternalLinkError> {
        let session = sessions
            .entries
            .get_mut(id)
            .ok_or(ExternalLinkError::SessionNotFound)?;
        if session.owner.window_label != owner.window_label {
            return Err(ExternalLinkError::OwnerMismatch);
        }
        if session.owner.generation != owner.generation || session.generation != generation {
            return Err(ExternalLinkError::GenerationMismatch);
        }
        if session.teardown != TeardownOwner::Active {
            return Err(ExternalLinkError::SessionClosing);
        }
        Ok(session)
    }

    fn closed_barrier(
        sessions: &Sessions,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<Option<u64>, PdfSessionError> {
        match sessions
            .closed_tombstones
            .iter()
            .rev()
            .find(|closed| closed.id == *id)
        {
            Some(closed) if closed.owner.window_label != owner.window_label => {
                Err(PdfSessionError::OwnerMismatch)
            }
            Some(closed)
                if closed.owner.generation != owner.generation
                    || closed.generation != generation =>
            {
                Err(PdfSessionError::GenerationMismatch)
            }
            Some(closed) => Ok(Some(closed.barrier_id)),
            None => Ok(None),
        }
    }

    fn checked_session<'a>(
        sessions: &'a mut Sessions,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<&'a mut Session, PdfSessionError> {
        let session = sessions
            .entries
            .get_mut(id)
            .ok_or(PdfSessionError::SessionNotFound)?;
        if session.owner.window_label != owner.window_label {
            return Err(PdfSessionError::OwnerMismatch);
        }
        if session.owner.generation != owner.generation || session.generation != generation {
            return Err(PdfSessionError::GenerationMismatch);
        }
        Ok(session)
    }
}
fn preserve_launch_outcome<E: 'static>(error: E) -> ExternalLinkError {
    (&error as &dyn Any)
        .downcast_ref::<ExternalLinkError>()
        .filter(|error| {
            matches!(
                error,
                ExternalLinkError::LinkLaunchTimeout | ExternalLinkError::LinkDispatchExpired
            )
        })
        .cloned()
        .unwrap_or(ExternalLinkError::LinkLaunchFailed)
}
fn valid_annotation_id(annotation_id: &str) -> bool {
    !annotation_id.is_empty()
        && annotation_id.len() <= MAX_ANNOTATION_ID_BYTES
        && !annotation_id.chars().any(char::is_control)
}
fn valid_operation_id(operation_id: &str) -> bool {
    !operation_id.is_empty()
        && operation_id.len() <= MAX_ANNOTATION_ID_BYTES
        && !operation_id.chars().any(char::is_control)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    #[test]
    fn renderer_invalidation_rejects_old_prints_and_preserves_read_close_authority() {
        let (manager, id, path) = session();
        let lease = manager.acquire_print_lease(&owner(), &id, 7).unwrap();
        manager.invalidate_print_owner("another-window");
        assert!(!lease.is_cancelled());
        manager.invalidate_print_owner(&owner().window_label);
        assert!(lease.is_cancelled());
        drop(lease);
        assert!(matches!(
            manager.acquire_print_lease(&owner(), &id, 7),
            Err(PdfSessionError::SessionClosing)
        ));
        assert_eq!(manager.session_length(&owner(), &id, 7), Ok(9));
        manager.drain_owned(&owner());
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }
    fn owner() -> PdfOwner {
        PdfOwner {
            window_label: "reader".into(),
            generation: 3,
        }
    }

    fn session() -> (PdfSessionManager, SessionId, PathBuf) {
        let path =
            std::env::temp_dir().join(format!("modeleaf-link-{}.pdf", rand::random::<u64>()));
        let mut created = File::create(&path).unwrap();
        created.write_all(b"%PDF-test").unwrap();
        drop(created);

        let manager = PdfSessionManager::new();
        let id = SessionId("a".repeat(64));
        manager.sessions.lock().unwrap().entries.insert(
            id.clone(),
            Session {
                owner: owner(),
                generation: 7,
                teardown: TeardownOwner::Active,
                length: 9,
                modified: std::fs::metadata(&path).unwrap().modified().unwrap(),
                file: Arc::new(Mutex::new(File::open(&path).unwrap())),
                queued: 0,
                in_flight: 0,
                print_lease: None,
                print_invalidated: false,
                barrier: None,
                external_links: HashMap::new(),
                external_link_in_flight: 0,
                activation_operations: HashMap::new(),
                retained_activation_operations: VecDeque::new(),
                highest_operation_sequence: 0,
                registry_revision: 0,
                finalized_external_link_revision: None,
                aborted_external_link_revision: None,
                external_link_transaction: None,
            },
        );
        (manager, id, path)
    }

    fn registration(annotation_id: &str, target: &str) -> ExternalLinkRegistration {
        ExternalLinkRegistration {
            annotation_id: annotation_id.into(),
            target: target.into(),
        }
    }

    fn install(
        manager: &PdfSessionManager,
        id: &SessionId,
        revision: u64,
        entries: Vec<ExternalLinkRegistration>,
    ) {
        manager
            .prepare_external_links(&owner(), id, 7, revision, entries)
            .unwrap();
        manager
            .commit_external_links(&owner(), id, 7, revision)
            .unwrap();
        manager
            .finalize_external_links(&owner(), id, 7, revision)
            .unwrap();
    }

    #[test]
    fn recent_identity_does_not_hold_sessions_while_waiting_for_file() {
        let (manager, id, path) = session();
        let file = {
            let sessions = manager.sessions.lock().unwrap();
            Arc::clone(&sessions.entries.get(&id).unwrap().file)
        };
        let file_guard = file.lock().unwrap();
        let recent_manager = manager.clone();
        let recent_id = id.clone();
        let recent = std::thread::spawn(move || {
            recent_manager.trusted_recent_identity(&owner(), &recent_id, 7)
        });
        for _ in 0..100 {
            if Arc::strong_count(&file) >= 3 {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(Arc::strong_count(&file) >= 3);
        assert_eq!(manager.session_length(&owner(), &id, 7), Ok(9));

        drop(file_guard);
        assert!(recent.join().unwrap().is_ok());
        manager.drain_owned(&owner());
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn external_link_transaction_defers_activation_until_commit() {
        let (manager, id, path) = session();
        manager
            .prepare_external_links(
                &owner(),
                &id,
                7,
                1,
                vec![registration("new", "https://example.com/new")],
            )
            .unwrap();
        assert_eq!(
            manager.resolve_external_link(&owner(), &id, 7, "new"),
            Err(ExternalLinkError::AnnotationNotFound)
        );
        manager.commit_external_links(&owner(), &id, 7, 1).unwrap();
        assert_eq!(
            manager.resolve_external_link(&owner(), &id, 7, "new"),
            Ok("https://example.com/new".into())
        );
        manager
            .prepare_external_links(
                &owner(),
                &id,
                7,
                2,
                vec![registration("second", "https://example.com/second")],
            )
            .unwrap();
        manager.commit_external_links(&owner(), &id, 7, 2).unwrap();
        manager
            .finalize_external_links(&owner(), &id, 7, 2)
            .unwrap();
        assert_eq!(manager.abort_external_links(&owner(), &id, 7, 2), Ok(()));
        drop(manager);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn external_link_transaction_abort_restores_previous_registry() {
        let (manager, id, path) = session();
        install(
            &manager,
            &id,
            1,
            vec![registration("old", "https://example.com/old")],
        );
        manager
            .prepare_external_links(
                &owner(),
                &id,
                7,
                2,
                vec![registration("discarded", "https://example.com/discarded")],
            )
            .unwrap();
        manager.abort_external_links(&owner(), &id, 7, 2).unwrap();
        assert_eq!(
            manager.resolve_external_link(&owner(), &id, 7, "old"),
            Ok("https://example.com/old".into())
        );
        manager
            .prepare_external_links(
                &owner(),
                &id,
                7,
                2,
                vec![registration("new", "https://example.com/new")],
            )
            .unwrap();
        manager.commit_external_links(&owner(), &id, 7, 2).unwrap();
        manager.abort_external_links(&owner(), &id, 7, 2).unwrap();
        assert_eq!(
            manager.resolve_external_link(&owner(), &id, 7, "old"),
            Ok("https://example.com/old".into())
        );
        assert_eq!(
            manager.resolve_external_link(&owner(), &id, 7, "new"),
            Err(ExternalLinkError::AnnotationNotFound)
        );
        assert_eq!(
            manager.finalize_external_links(&owner(), &id, 7, 2),
            Err(ExternalLinkError::StaleRegistration)
        );
        manager
            .prepare_external_links(&owner(), &id, 7, 2, vec![])
            .unwrap();
        assert_eq!(
            manager.commit_external_links(&owner(), &id, 7, 3),
            Err(ExternalLinkError::StaleRegistration)
        );
        manager.abort_external_links(&owner(), &id, 7, 2).unwrap();
        drop(manager);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn external_link_transaction_rejects_invalid_entries_without_changing_active_registry() {
        let (manager, id, path) = session();
        install(
            &manager,
            &id,
            1,
            vec![registration("old", "https://example.com/old")],
        );
        assert_eq!(
            manager.prepare_external_links(
                &owner(),
                &id,
                7,
                2,
                vec![registration("bad", "javascript:alert(1)")]
            ),
            Err(ExternalLinkError::LinkRejected)
        );
        assert_eq!(
            manager.resolve_external_link(&owner(), &id, 7, "old"),
            Ok("https://example.com/old".into())
        );
        drop(manager);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn close_acknowledgements_are_idempotent_and_tombstones_are_bounded() {
        let (manager, id, path) = session();
        let barrier = manager.cancel(&owner(), &id, 7).unwrap();
        assert_eq!(manager.cancel(&owner(), &id, 7), Ok(barrier.clone()));
        manager.close(&owner(), &id, 7, barrier.barrier_id).unwrap();
        assert_eq!(manager.close(&owner(), &id, 7, barrier.barrier_id), Ok(()));
        assert_eq!(
            manager.close(&owner(), &id, 7, barrier.barrier_id + 1),
            Err(PdfSessionError::BarrierMismatch)
        );
        assert_eq!(
            manager.close(
                &PdfOwner {
                    window_label: "other".into(),
                    generation: 3
                },
                &id,
                7,
                barrier.barrier_id
            ),
            Err(PdfSessionError::OwnerMismatch)
        );
        assert_eq!(
            manager.close(&owner(), &id, 8, barrier.barrier_id),
            Err(PdfSessionError::GenerationMismatch)
        );
        assert_eq!(manager.sessions.lock().unwrap().closed_tombstones.len(), 1);
        drop(manager);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn external_link_retries_preserve_finalized_registry() {
        let (manager, id, path) = session();
        let links = vec![registration("new", "https://example.com/new")];
        manager
            .prepare_external_links(&owner(), &id, 7, 1, links.clone())
            .unwrap();
        manager
            .prepare_external_links(&owner(), &id, 7, 1, links)
            .unwrap();
        manager.commit_external_links(&owner(), &id, 7, 1).unwrap();
        manager.commit_external_links(&owner(), &id, 7, 1).unwrap();
        manager
            .finalize_external_links(&owner(), &id, 7, 1)
            .unwrap();
        manager
            .finalize_external_links(&owner(), &id, 7, 1)
            .unwrap();
        manager.abort_external_links(&owner(), &id, 7, 1).unwrap();
        assert_eq!(
            manager.resolve_external_link(&owner(), &id, 7, "new"),
            Ok("https://example.com/new".into())
        );
        drop(manager);
        std::fs::remove_file(path).unwrap();
    }

    fn wait_for_teardown(manager: &PdfSessionManager, id: &SessionId, expected: TeardownOwner) {
        let mut sessions = manager.sessions.lock().unwrap();
        while sessions.entries.get(id).unwrap().teardown != expected {
            sessions = manager.drained.wait(sessions).unwrap();
        }
    }

    fn external_link_admission(
        manager: &PdfSessionManager,
        id: &SessionId,
    ) -> ExternalLinkAdmission {
        let mut sessions = manager.sessions.lock().unwrap();
        sessions
            .entries
            .get_mut(id)
            .unwrap()
            .external_link_in_flight += 1;
        sessions.external_link_process_in_flight += 1;
        ExternalLinkAdmission {
            sessions: Arc::clone(&manager.sessions),
            drained: Arc::clone(&manager.drained),
            id: id.clone(),
            released: false,
            cleanup_tx: manager.cleanup_tx.clone(),
        }
    }

    #[test]
    fn lifecycle_drain_deadline_retains_never_settling_range_ownership() {
        let (manager, id, path) = session();
        {
            let mut sessions = manager.sessions.lock().unwrap();
            sessions.entries.get_mut(&id).unwrap().queued = 1;
            sessions.process_queued = 1;
        }

        manager.drain_owner_with_timeout_for_test(&owner().window_label, Duration::ZERO);
        {
            let sessions = manager.sessions.lock().unwrap();
            let retained = sessions.entries.get(&id).unwrap();
            assert_eq!(retained.teardown, TeardownOwner::LifecycleDeferred);
            assert_eq!(retained.queued, 1);
        }

        {
            let mut sessions = manager.sessions.lock().unwrap();
            sessions.entries.get_mut(&id).unwrap().queued = 0;
            sessions.process_queued = 0;
            PdfSessionManager::queue_deferred_drained_session(
                &mut sessions,
                &manager.cleanup_tx,
                &id,
            );
        };
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn lifecycle_drain_atomically_claims_command_cancellation() {
        let (manager, id, path) = session();
        let admission = external_link_admission(&manager, &id);
        let cancelling_manager = manager.clone();
        let cancelling_id = id.clone();
        let cancelling =
            std::thread::spawn(move || cancelling_manager.cancel(&owner(), &cancelling_id, 7));

        wait_for_teardown(&manager, &id, TeardownOwner::CommandCancelling);
        manager.drain_owner_with_timeout_for_test(&owner().window_label, Duration::ZERO);
        assert_eq!(
            manager
                .sessions
                .lock()
                .unwrap()
                .entries
                .get(&id)
                .unwrap()
                .teardown,
            TeardownOwner::LifecycleDeferred
        );

        drop(admission);
        assert!(matches!(
            cancelling.join().unwrap(),
            Err(PdfSessionError::SessionClosing | PdfSessionError::SessionNotFound)
        ));
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn lifecycle_deferred_rejects_cancel_and_removes_after_admission() {
        let (manager, id, path) = session();
        let admission = external_link_admission(&manager, &id);
        manager.drain_owner_with_timeout_for_test(&owner().window_label, Duration::ZERO);
        assert_eq!(
            manager
                .sessions
                .lock()
                .unwrap()
                .entries
                .get(&id)
                .unwrap()
                .teardown,
            TeardownOwner::LifecycleDeferred
        );

        assert_eq!(
            manager.cancel(&owner(), &id, 7),
            Err(PdfSessionError::SessionClosing)
        );
        drop(admission);
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn external_link_admission_drop_removes_only_lifecycle_deferred_sessions() {
        let (manager, lifecycle_id, path) = session();
        let command_id = SessionId("b".repeat(64));
        let unrelated_id = SessionId("c".repeat(64));
        {
            let mut sessions = manager.sessions.lock().unwrap();
            sessions.entries.get_mut(&lifecycle_id).unwrap().teardown =
                TeardownOwner::LifecycleDeferred;
            for (id, teardown) in [
                (&command_id, TeardownOwner::CommandCancelling),
                (&unrelated_id, TeardownOwner::Active),
            ] {
                sessions.entries.insert(
                    id.clone(),
                    Session {
                        owner: owner(),
                        generation: 7,
                        length: 9,
                        modified: std::fs::metadata(&path).unwrap().modified().unwrap(),
                        file: Arc::new(Mutex::new(File::open(&path).unwrap())),
                        teardown,
                        queued: 0,
                        in_flight: 0,
                        print_lease: None,
                        print_invalidated: false,
                        external_link_in_flight: 0,
                        activation_operations: HashMap::new(),
                        retained_activation_operations: VecDeque::new(),
                        highest_operation_sequence: 0,
                        barrier: None,
                        external_links: HashMap::new(),
                        registry_revision: 0,
                        finalized_external_link_revision: None,
                        aborted_external_link_revision: None,
                        external_link_transaction: None,
                    },
                );
            }
        }
        let lifecycle = external_link_admission(&manager, &lifecycle_id);
        let command = external_link_admission(&manager, &command_id);
        let unrelated = external_link_admission(&manager, &unrelated_id);
        assert_eq!(
            manager
                .sessions
                .lock()
                .unwrap()
                .external_link_process_in_flight,
            3
        );

        drop(lifecycle);
        let sessions = manager.sessions.lock().unwrap();
        assert!(!sessions.entries.contains_key(&lifecycle_id));
        assert_eq!(
            sessions
                .entries
                .get(&command_id)
                .unwrap()
                .external_link_in_flight,
            1
        );
        assert_eq!(
            sessions
                .entries
                .get(&unrelated_id)
                .unwrap()
                .external_link_in_flight,
            1
        );
        assert_eq!(sessions.external_link_process_in_flight, 2);
        drop(sessions);

        drop(command);
        let sessions = manager.sessions.lock().unwrap();
        assert_eq!(
            sessions
                .entries
                .get(&command_id)
                .unwrap()
                .external_link_in_flight,
            0
        );
        assert_eq!(
            sessions
                .entries
                .get(&unrelated_id)
                .unwrap()
                .external_link_in_flight,
            1
        );
        assert_eq!(sessions.external_link_process_in_flight, 1);
        drop(sessions);

        drop(unrelated);
        let sessions = manager.sessions.lock().unwrap();
        assert!(sessions.entries.contains_key(&command_id));
        assert!(sessions.entries.contains_key(&unrelated_id));
        assert_eq!(
            sessions
                .entries
                .get(&unrelated_id)
                .unwrap()
                .external_link_in_flight,
            0
        );
        assert_eq!(sessions.external_link_process_in_flight, 0);
        drop(sessions);
        let barrier = manager.cancel(&owner(), &command_id, 7).unwrap();
        manager
            .close(&owner(), &command_id, 7, barrier.barrier_id)
            .unwrap();
        manager.drain_all();
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn print_lease_validates_owner_and_generations_atomically() {
        fn assert_send_static<T: Send + 'static>() {}
        assert_send_static::<PdfPrintLease>();

        let (manager, id, path) = session();
        let wrong_window = PdfOwner {
            window_label: "other".into(),
            generation: owner().generation,
        };
        assert!(matches!(
            manager.acquire_print_lease(&wrong_window, &id, 7),
            Err(PdfSessionError::OwnerMismatch)
        ));
        let wrong_owner_generation = PdfOwner {
            window_label: owner().window_label,
            generation: owner().generation + 1,
        };
        assert!(matches!(
            manager.acquire_print_lease(&wrong_owner_generation, &id, 7),
            Err(PdfSessionError::GenerationMismatch)
        ));
        assert!(matches!(
            manager.acquire_print_lease(&owner(), &id, 8),
            Err(PdfSessionError::GenerationMismatch)
        ));

        let lease = manager.acquire_print_lease(&owner(), &id, 7).unwrap();
        assert!(!lease.is_cancelled());
        drop(lease);
        manager.drain_owned(&owner());
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn session_cancel_propagates_to_print_lease() {
        let (manager, id, path) = session();
        let lease = manager.acquire_print_lease(&owner(), &id, 7).unwrap();
        let cancellation_flag = lease.cancellation_flag();
        let cancelling_manager = manager.clone();
        let cancelling_id = id.clone();
        let cancelling =
            std::thread::spawn(move || cancelling_manager.cancel(&owner(), &cancelling_id, 7));

        wait_for_teardown(&manager, &id, TeardownOwner::CommandCancelling);
        assert!(lease.is_cancelled());
        assert!(cancellation_flag.load(Ordering::Acquire));
        drop(lease);

        let barrier = cancelling.join().unwrap().unwrap();
        manager.close(&owner(), &id, 7, barrier.barrier_id).unwrap();
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn close_barrier_retains_session_until_print_lease_drops() {
        let (manager, id, path) = session();
        let lease = manager.acquire_print_lease(&owner(), &id, 7).unwrap();
        let cancelling_manager = manager.clone();
        let cancelling_id = id.clone();
        let cancelling =
            std::thread::spawn(move || cancelling_manager.cancel(&owner(), &cancelling_id, 7));

        wait_for_teardown(&manager, &id, TeardownOwner::CommandCancelling);
        assert_eq!(
            manager.close(&owner(), &id, 7, 1),
            Err(PdfSessionError::SessionClosing)
        );
        assert!(manager.sessions.lock().unwrap().entries.contains_key(&id));
        drop(lease);

        let barrier = cancelling.join().unwrap().unwrap();
        assert!(matches!(
            manager.acquire_print_lease(&owner(), &id, 7),
            Err(PdfSessionError::SessionClosing)
        ));
        manager.close(&owner(), &id, 7, barrier.barrier_id).unwrap();
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn lifecycle_drain_retains_print_lease_then_reaps_on_drop() {
        let (manager, id, path) = session();
        let lease = manager.acquire_print_lease(&owner(), &id, 7).unwrap();

        manager.drain_owner_with_timeout_for_test(&owner().window_label, Duration::ZERO);
        assert!(lease.is_cancelled());
        {
            let sessions = manager.sessions.lock().unwrap();
            let retained = sessions.entries.get(&id).unwrap();
            assert_eq!(retained.teardown, TeardownOwner::LifecycleDeferred);
            assert!(retained.print_lease.is_some());
        }
        assert!(!manager.assert_empty());

        drop(lease);
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn print_lease_reacquire_uses_a_fresh_flag_without_resetting_the_old_one() {
        let (manager, id, path) = session();
        let first = manager.acquire_print_lease(&owner(), &id, 7).unwrap();
        let old_flag = first.cancellation_flag();
        old_flag.store(true, Ordering::Release);
        assert!(first.is_cancelled());
        drop(first);

        let second = manager.acquire_print_lease(&owner(), &id, 7).unwrap();
        let new_flag = second.cancellation_flag();
        assert!(!Arc::ptr_eq(&old_flag, &new_flag));
        assert!(old_flag.load(Ordering::Acquire));
        assert!(!second.is_cancelled());
        assert!(matches!(
            manager.acquire_print_lease(&owner(), &id, 7),
            Err(PdfSessionError::SessionClosing)
        ));

        drop(second);
        assert!(old_flag.load(Ordering::Acquire));
        manager.drain_owned(&owner());
        assert_empty_after_cleanup(manager.clone());
        std::fs::remove_file(path).unwrap();
    }
    fn assert_empty_after_cleanup(manager: PdfSessionManager) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut state = manager.sessions.lock().unwrap();
        while state.cleanup_pending != 0 {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("cleanup did not settle");
            state = manager.drained.wait_timeout(state, remaining).unwrap().0;
        }
        drop(state);
        assert!(manager.assert_empty());
    }

    struct TestPolicy(crate::local_path::DriveKind);
    impl LocalPathPolicy for TestPolicy {
        fn classify(
            &self,
            _: &Path,
        ) -> Result<crate::local_path::DriveKind, crate::local_path::PathPolicyError> {
            Ok(self.0)
        }
    }
    impl FinalHandlePolicy for TestPolicy {
        fn classify_final(
            &self,
            _: &File,
        ) -> Result<crate::local_path::DriveKind, crate::local_path::PathPolicyError> {
            Ok(self.0)
        }
    }
    fn network_test_pdf() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "modeleaf-network-lifetime-{}.pdf",
            rand::random::<u64>()
        ));
        std::fs::write(&path, b"%PDF-test").unwrap();
        path
    }
    fn settle_test_cleanup(manager: &PdfSessionManager, task: CleanupTask) {
        let CleanupTask {
            owner,
            id,
            session,
            closed,
        } = task;
        drop(session);
        PdfSessionManager::finish_cleanup_locked(
            &mut manager.sessions.lock().unwrap(),
            &id,
            &owner,
            closed,
        );
        manager.drained.notify_all();
    }

    #[test]
    fn blocked_opens_keep_capacity_and_cannot_publish_after_owner_fence_eviction() {
        let path = network_test_pdf();
        let manager = PdfSessionManager::new();
        let (started_tx, started_rx) = mpsc::channel();
        let mut workers = Vec::new();
        let mut releases = Vec::new();
        for _ in 0..MAX_OPEN_PROCESS_IN_FLIGHT {
            let worker = manager.clone();
            let path = path.clone();
            let started = started_tx.clone();
            let (release, wait) = mpsc::channel();
            releases.push(release);
            workers.push(std::thread::spawn(move || {
                let policy = TestPolicy(crate::local_path::DriveKind::Remote);
                worker.open_local(owner(), &path, &policy, &policy, |path| {
                    started.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(10)).unwrap();
                    File::open(path)
                })
            }));
        }
        for _ in 0..MAX_OPEN_PROCESS_IN_FLIGHT {
            started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        let remote = TestPolicy(crate::local_path::DriveKind::Remote);
        assert_eq!(
            manager.open_local(owner(), &path, &remote, &remote, |_| panic!(
                "capacity must precede opener"
            )),
            Err(PdfSessionError::SessionCapacity)
        );
        manager.defer_owned(&owner());
        assert!(!manager.owner_is_empty(&owner()));
        for index in 0..=MAX_OWNER_FENCES {
            manager.defer_owned(&PdfOwner {
                window_label: format!("retired-{index}"),
                generation: 1,
            });
        }
        assert!(
            manager
                .sessions
                .lock()
                .unwrap()
                .owner_generation_fences
                .len()
                <= MAX_OWNER_FENCES
        );
        for release in releases {
            release.send(()).unwrap();
        }
        for worker in workers {
            assert_eq!(worker.join().unwrap(), Err(PdfSessionError::SessionClosing));
        }
        assert_empty_after_cleanup(manager);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn remote_not_found_does_not_claim_proven_file_absence() {
        let manager = PdfSessionManager::new();
        let remote = TestPolicy(crate::local_path::DriveKind::Remote);
        assert_eq!(
            manager.open_local(
                owner(),
                Path::new(r"\\server\share\unavailable.pdf"),
                &remote,
                &remote,
                |_| Err(io::Error::from(io::ErrorKind::NotFound))
            ),
            Err(PdfSessionError::FileUnreadable)
        );
        assert_empty_after_cleanup(manager);
    }

    #[test]
    fn retained_ranges_reject_length_changes_and_exact_read_shortfalls() {
        let (manager, id, path) = session();
        let snapshot = PdfSessionManager::file_snapshot(&File::open(&path).unwrap()).unwrap();
        let file = Mutex::new(File::open(&path).unwrap());
        assert_eq!(
            PdfSessionManager::read_file(file.lock().unwrap(), 0, 10, snapshot),
            Err(PdfSessionError::FileUnreadable)
        );
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(5)
            .unwrap();
        assert_eq!(
            manager.read_range(&owner(), &id, 7, 0, 5),
            Err(PdfSessionError::FileUnreadable)
        );
        manager.drain_owned(&owner());
        assert_empty_after_cleanup(manager);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn retained_ranges_reject_same_length_modification() {
        let (manager, id, path) = session();
        let mut writer = File::options().write(true).open(&path).unwrap();
        writer.write_all(b"%PDF-best").unwrap();
        writer
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(123))
            .unwrap();
        drop(writer);
        assert_eq!(
            manager.read_range(&owner(), &id, 7, 0, 9),
            Err(PdfSessionError::FileUnreadable)
        );
        manager.drain_owned(&owner());
        assert_empty_after_cleanup(manager);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn deferred_close_remains_unsettled_until_exact_handle_disposal() {
        let (mut manager, id, path) = session();
        let (sender, receiver) = mpsc::sync_channel(MAX_HANDLE_CLEANUP_QUEUE);
        manager.cleanup_tx = sender;
        manager.defer_owned(&owner());
        let task = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!manager.assert_empty());
        assert!(!manager.owner_is_empty(&owner()));
        assert_eq!(
            manager.reap_deferred_cancellation(&owner(), &id, 7),
            Ok(false)
        );
        settle_test_cleanup(&manager, task);
        assert_eq!(
            manager.reap_deferred_cancellation(&owner(), &id, 7),
            Ok(true)
        );
        assert_empty_after_cleanup(manager);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn pending_close_does_not_publish_a_successful_tombstone_early() {
        let (mut manager, id, path) = session();
        let (sender, receiver) = mpsc::sync_channel(MAX_HANDLE_CLEANUP_QUEUE);
        manager.cleanup_tx = sender;
        let barrier = manager.cancel(&owner(), &id, 7).unwrap();
        let closing = manager.clone();
        let closing_id = id.clone();
        let barrier_id = barrier.barrier_id;
        let worker =
            std::thread::spawn(move || closing.close(&owner(), &closing_id, 7, barrier_id));
        let task = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(manager
            .sessions
            .lock()
            .unwrap()
            .closed_tombstones
            .is_empty());
        assert!(!manager.assert_empty());
        assert_eq!(
            manager.close(&owner(), &id, 7, barrier_id),
            Err(PdfSessionError::SessionClosing)
        );
        assert_eq!(
            manager.close(&owner(), &id, 7, barrier_id + 1),
            Err(PdfSessionError::BarrierMismatch)
        );
        settle_test_cleanup(&manager, task);
        assert_eq!(worker.join().unwrap(), Ok(()));
        assert_eq!(manager.close(&owner(), &id, 7, barrier_id), Ok(()));
        assert_empty_after_cleanup(manager);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejected_cleanup_enqueue_retains_handle_without_success_tombstone() {
        let (mut manager, id, path) = session();
        let original_sender = manager.cleanup_tx.clone();
        let (sender, receiver) = mpsc::sync_channel(MAX_HANDLE_CLEANUP_QUEUE);
        drop(receiver);
        manager.cleanup_tx = sender;
        let barrier = manager.cancel(&owner(), &id, 7).unwrap();
        assert_eq!(
            manager.close(&owner(), &id, 7, barrier.barrier_id),
            Err(PdfSessionError::SessionClosing)
        );
        assert!(manager
            .sessions
            .lock()
            .unwrap()
            .closed_tombstones
            .is_empty());
        assert!(!manager.assert_empty());
        manager.cleanup_tx = original_sender;
        manager.close(&owner(), &id, 7, barrier.barrier_id).unwrap();
        assert_empty_after_cleanup(manager);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn physical_cleanup_keeps_the_global_handle_quota_reserved() {
        let path = network_test_pdf();
        let mut manager = PdfSessionManager::new();
        let (sender, receiver) = mpsc::sync_channel(MAX_HANDLE_CLEANUP_QUEUE);
        manager.cleanup_tx = sender;
        let policy = TestPolicy(crate::local_path::DriveKind::Remote);
        for _ in 0..MAX_SESSIONS {
            manager
                .open_local(owner(), &path, &policy, &policy, |path| File::open(path))
                .unwrap();
        }
        manager.defer_owned(&owner());
        let other = PdfOwner {
            window_label: "other".into(),
            generation: 44,
        };
        assert_eq!(
            manager.open_local(other, &path, &policy, &policy, |_| panic!(
                "closing handles consume quota"
            )),
            Err(PdfSessionError::SessionCapacity)
        );
        for _ in 0..MAX_SESSIONS {
            settle_test_cleanup(
                &manager,
                receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
            );
        }
        assert_empty_after_cleanup(manager);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn queued_range_cannot_return_bytes_after_owner_invalidation() {
        let (manager, id, path) = session();
        let file = Arc::clone(&manager.sessions.lock().unwrap().entries[&id].file);
        let guard = file.lock().unwrap();
        let reading = manager.clone();
        let reading_id = id.clone();
        let reader = std::thread::spawn(move || reading.read_range(&owner(), &reading_id, 7, 0, 9));
        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.sessions.lock().unwrap().process_queued == 0 {
            assert!(Instant::now() < deadline, "range was not admitted");
            std::thread::yield_now();
        }
        manager.defer_owned(&owner());
        assert!(!manager.owner_is_empty(&owner()));
        drop(guard);
        drop(file);
        assert_eq!(reader.join().unwrap(), Err(PdfSessionError::SessionClosing));
        assert_empty_after_cleanup(manager);
        std::fs::remove_file(path).unwrap();
    }
}

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
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

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
    RemotePath,
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
            Self::RemotePath => "REMOTE_PATH",
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

struct Session {
    owner: PdfOwner,
    generation: u64,
    length: u64,
    file: Arc<Mutex<File>>,
    teardown: TeardownOwner,
    queued: usize,
    in_flight: usize,
    external_link_in_flight: usize,
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
struct Sessions {
    entries: HashMap<SessionId, Session>,
    closed_tombstones: VecDeque<ClosedSession>,
    next_generation: u64,
    next_barrier: u64,
    process_queued: usize,
    process_in_flight: usize,
    external_link_process_in_flight: usize,
}
#[derive(Clone)]
pub struct PdfSessionManager {
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
}

struct ExternalLinkAdmission {
    sessions: Arc<Mutex<Sessions>>,
    drained: Arc<Condvar>,
    id: SessionId,
    released: bool,
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
            session.external_link_in_flight = session
                .external_link_in_flight
                .checked_sub(1)
                .expect("external-link admission underflow");
        }
        sessions.external_link_process_in_flight = sessions
            .external_link_process_in_flight
            .checked_sub(1)
            .expect("external-link process admission underflow");
        self.released = true;
        PdfSessionManager::remove_deferred_drained_session(&mut sessions, &self.id);
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
            session.external_link_in_flight = session
                .external_link_in_flight
                .checked_sub(1)
                .expect("external-link admission underflow");
        }
        sessions.external_link_process_in_flight = sessions
            .external_link_process_in_flight
            .checked_sub(1)
            .expect("external-link process admission underflow");
        PdfSessionManager::remove_deferred_drained_session(&mut sessions, &self.id);
        self.drained.notify_all();
    }
}
impl Default for PdfSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PdfSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(Sessions {
                entries: HashMap::new(),
                closed_tombstones: VecDeque::new(),
                next_generation: 1,
                next_barrier: 1,
                process_queued: 0,
                process_in_flight: 0,
                external_link_process_in_flight: 0,
            })),
            drained: Arc::new(Condvar::new()),
        }
    }

    /// Opens a production local PDF, validates the retained handle's locality, and derives its
    /// identity from that handle rather than resolving the mutable input path.
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
        match policy.classify(path) {
            Ok(crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable) => {}
            Ok(crate::local_path::DriveKind::Remote)
            | Err(crate::local_path::PathPolicyError::RemotePath) => {
                return Err(PdfSessionError::RemotePath)
            }
            Err(crate::local_path::PathPolicyError::PathRejected) => {
                return Err(PdfSessionError::PathRejected)
            }
        }
        policy.validate_preopen(path).map_err(|error| match error {
            crate::local_path::PathPolicyError::RemotePath => PdfSessionError::RemotePath,
            crate::local_path::PathPolicyError::PathRejected => PdfSessionError::PathRejected,
        })?;
        if !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
        {
            return Err(PdfSessionError::PdfInvalid);
        }
        let session_capacity_reached = {
            let sessions = self.sessions.lock().expect("session state poisoned");
            sessions.entries.len() >= MAX_SESSIONS
        };
        if session_capacity_reached {
            return Err(PdfSessionError::SessionCapacity);
        }
        let mut file = opener(path).map_err(|_| PdfSessionError::FileUnreadable)?;
        match final_policy.classify_final(&file) {
            Ok(crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable) => {}
            Ok(crate::local_path::DriveKind::Remote)
            | Err(crate::local_path::PathPolicyError::RemotePath) => {
                return Err(PdfSessionError::RemotePath)
            }
            Err(crate::local_path::PathPolicyError::PathRejected) => {
                return Err(PdfSessionError::PathRejected)
            }
        }
        identity(&file).map_err(|error| match error {
            crate::local_path::PathPolicyError::RemotePath => PdfSessionError::RemotePath,
            crate::local_path::PathPolicyError::PathRejected => PdfSessionError::PathRejected,
        })?;
        let metadata = file
            .metadata()
            .map_err(|_| PdfSessionError::FileUnreadable)?;
        if !metadata.is_file() {
            return Err(PdfSessionError::FileUnreadable);
        }
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err(PdfSessionError::DocumentTooLarge);
        }
        let mut magic = [0_u8; 5];
        if file
            .read(&mut magic)
            .map_err(|_| PdfSessionError::FileUnreadable)?
            != magic.len()
            || magic != *b"%PDF-"
        {
            return Err(PdfSessionError::PdfInvalid);
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|_| PdfSessionError::FileUnreadable)?;
        let mut sessions = self.sessions.lock().expect("session state poisoned");
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
        sessions.entries.insert(
            session_id.clone(),
            Session {
                owner,
                generation,
                length,
                file: Arc::new(Mutex::new(file)),
                queued: 0,
                in_flight: 0,
                barrier: None,
                external_links: HashMap::new(),
                external_link_in_flight: 0,
                activation_operations: HashMap::new(),
                retained_activation_operations: VecDeque::new(),
                teardown: TeardownOwner::Active,
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
    /// Re-validates the retained file handle and returns its opening-time canonical local identity
    /// for native recent-document persistence. This never resolves the mutable path used to open it.
    pub fn trusted_recent_identity(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<TrustedRecentIdentity, PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        let session = Self::checked_session(&mut sessions, owner, id, generation)?;
        let file = session.file.lock().expect("session file poisoned");
        match SystemFinalHandlePolicy.classify_final(&file) {
            Ok(crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable) => {}
            Ok(crate::local_path::DriveKind::Remote)
            | Err(crate::local_path::PathPolicyError::RemotePath) => {
                return Err(PdfSessionError::RemotePath)
            }
            Err(crate::local_path::PathPolicyError::PathRejected) => {
                return Err(PdfSessionError::PathRejected)
            }
        }
        let canonical_path = SystemFinalHandlePolicy
            .canonical_path(&file)
            .map_err(|error| match error {
                crate::local_path::PathPolicyError::RemotePath => PdfSessionError::RemotePath,
                crate::local_path::PathPolicyError::PathRejected => PdfSessionError::PathRejected,
            })?;
        Ok(TrustedRecentIdentity { canonical_path })
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
        let (file, available) = {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            if sessions.process_queued >= MAX_PROCESS_QUEUE {
                return Err(PdfSessionError::RangeCapacity);
            }
            let (file, available) = {
                let session = Self::checked_session(&mut sessions, owner, id, generation)?;
                if session.teardown != TeardownOwner::Active {
                    return Err(PdfSessionError::SessionClosing);
                }
                if session.queued >= MAX_SESSION_QUEUE {
                    return Err(PdfSessionError::RangeCapacity);
                }
                session.queued += 1;
                (
                    Arc::clone(&session.file),
                    session.length.saturating_sub(offset).min(u64::from(length)),
                )
            };
            sessions.process_queued += 1;
            (file, available)
        };
        let file = file.lock().expect("file state poisoned");
        {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            let process_full = sessions.process_in_flight >= MAX_PROCESS_IN_FLIGHT;
            let (closing, session_full) = {
                let session = sessions
                    .entries
                    .get_mut(id)
                    .ok_or(PdfSessionError::SessionNotFound)?;
                session.queued -= 1;
                (
                    session.teardown != TeardownOwner::Active,
                    session.in_flight >= MAX_SESSION_IN_FLIGHT,
                )
            };
            sessions.process_queued -= 1;
            if closing {
                Self::remove_deferred_drained_session(&mut sessions, id);
                self.drained.notify_all();
                return Err(PdfSessionError::SessionClosing);
            }
            if process_full || session_full {
                self.drained.notify_all();
                return Err(PdfSessionError::RangeCapacity);
            }
            sessions
                .entries
                .get_mut(id)
                .ok_or(PdfSessionError::SessionNotFound)?
                .in_flight += 1;
            sessions.process_in_flight += 1;
        }
        let available = match usize::try_from(available) {
            Ok(available) => available,
            Err(_) => {
                let mut sessions = self.sessions.lock().expect("session state poisoned");
                sessions
                    .entries
                    .get_mut(id)
                    .ok_or(PdfSessionError::SessionNotFound)?
                    .in_flight -= 1;
                sessions.process_in_flight -= 1;
                Self::remove_deferred_drained_session(&mut sessions, id);
                self.drained.notify_all();
                return Err(PdfSessionError::RangeInvalid);
            }
        };
        let result = Self::read_file(file, offset, available);
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        sessions
            .entries
            .get_mut(id)
            .ok_or(PdfSessionError::SessionNotFound)?
            .in_flight -= 1;
        sessions.process_in_flight -= 1;
        Self::remove_deferred_drained_session(&mut sessions, id);
        self.drained.notify_all();
        result
    }
    fn read_file(
        mut file: std::sync::MutexGuard<'_, File>,
        offset: u64,
        available: usize,
    ) -> Result<Vec<u8>, PdfSessionError> {
        if available == 0 {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| PdfSessionError::FileUnreadable)?;
        let mut result = vec![0; available];
        let read = file
            .read(&mut result)
            .map_err(|_| PdfSessionError::FileUnreadable)?;
        result.truncate(read);
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
            TeardownOwner::Active | TeardownOwner::LifecycleDeferred => {
                session.teardown = TeardownOwner::CommandCancelling
            }
            TeardownOwner::CommandCancelling => {}
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
        let mut sessions = self.sessions.lock().expect("session state poisoned");
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
            || session.external_link_in_flight != 0
        {
            return Err(PdfSessionError::SessionClosing);
        }
        if session.barrier != Some(barrier_id) {
            return Err(PdfSessionError::BarrierMismatch);
        }
        sessions.entries.remove(id);
        sessions.closed_tombstones.push_back(ClosedSession {
            id: id.clone(),
            owner: owner.clone(),
            generation,
            barrier_id,
        });
        while sessions.closed_tombstones.len() > MAX_CLOSED_SESSION_TOMBSTONES {
            sessions.closed_tombstones.pop_front();
        }
        Ok(())
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
        Self::remove_deferred_drained_session(&mut sessions, id);
        self.drained.notify_all();
        Ok(())
    }

    /// Reaps a deferred cancellation after its raw work has settled.
    pub(crate) fn reap_deferred_cancellation(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<bool, PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
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
        if session.in_flight != 0 || session.queued != 0 || session.external_link_in_flight != 0 {
            return Ok(false);
        }
        sessions.entries.remove(id);
        Ok(true)
    }

    pub fn drain_owner(&self, window_label: &str) {
        self.drain_matching(
            |owner| owner.window_label == window_label,
            EXTERNAL_LINK_DRAIN_TIMEOUT,
        );
    }
    pub fn drain_owned(&self, owner: &PdfOwner) {
        {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            for session in sessions.entries.values_mut() {
                if session.owner == *owner && session.teardown == TeardownOwner::CommandCancelling {
                    session.teardown = TeardownOwner::LifecycleDeferred;
                }
            }
            self.drained.notify_all();
        }
        self.drain_matching(
            |session_owner| session_owner == owner,
            EXTERNAL_LINK_DRAIN_TIMEOUT,
        );
    }
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn drain_owner_with_timeout_for_test(&self, window_label: &str, timeout: Duration) {
        self.drain_matching(|owner| owner.window_label == window_label, timeout);
    }

    pub fn drain_all(&self) {
        self.drain_matching(|_| true, EXTERNAL_LINK_DRAIN_TIMEOUT);
    }

    fn drain_matching(&self, matches: impl Fn(&PdfOwner) -> bool, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        for session in sessions.entries.values_mut() {
            if matches(&session.owner) && session.teardown == TeardownOwner::Active {
                session.teardown = TeardownOwner::LifecycleDeferred;
            }
        }
        while sessions.entries.values().any(|session| {
            session.teardown == TeardownOwner::LifecycleDeferred
                && matches(&session.owner)
                && (session.in_flight != 0
                    || session.queued != 0
                    || session.external_link_in_flight != 0)
        }) {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return;
            };
            let (next, timed_out) = self
                .drained
                .wait_timeout(sessions, remaining)
                .expect("session state poisoned");
            sessions = next;
            if timed_out.timed_out()
                && sessions.entries.values().any(|session| {
                    session.teardown == TeardownOwner::LifecycleDeferred
                        && matches(&session.owner)
                        && (session.in_flight != 0
                            || session.queued != 0
                            || session.external_link_in_flight != 0)
                })
            {
                return;
            }
        }
        sessions.entries.retain(|_, session| {
            !(session.teardown == TeardownOwner::LifecycleDeferred && matches(&session.owner))
        });
    }

    fn remove_deferred_drained_session(sessions: &mut Sessions, id: &SessionId) {
        if sessions.entries.get(id).is_some_and(|session| {
            session.teardown == TeardownOwner::LifecycleDeferred
                && session.in_flight == 0
                && session.queued == 0
                && session.external_link_in_flight == 0
        }) {
            sessions.entries.remove(id);
        }
    }

    #[cfg(debug_assertions)]
    pub fn assert_empty(&self) -> bool {
        let sessions = self.sessions.lock().expect("session state poisoned");
        sessions.entries.is_empty()
            && sessions.process_queued == 0
            && sessions.process_in_flight == 0
            && sessions.external_link_process_in_flight == 0
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
                file: Arc::new(Mutex::new(File::open(&path).unwrap())),
                queued: 0,
                in_flight: 0,
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
            PdfSessionManager::remove_deferred_drained_session(&mut sessions, &id);
        }
        assert!(manager.assert_empty());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn command_cancel_first_keeps_its_ownership_through_lifecycle_drain() {
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
            TeardownOwner::CommandCancelling
        );

        drop(admission);
        let barrier = cancelling.join().unwrap().unwrap();
        assert_eq!(manager.cancel(&owner(), &id, 7), Ok(barrier.clone()));
        manager.close(&owner(), &id, 7, barrier.barrier_id).unwrap();
        assert_eq!(manager.close(&owner(), &id, 7, barrier.barrier_id), Ok(()));
        assert!(manager.assert_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn lifecycle_deferred_cancel_takeover_prevents_automatic_removal() {
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

        let cancelling_manager = manager.clone();
        let cancelling_id = id.clone();
        let cancelling =
            std::thread::spawn(move || cancelling_manager.cancel(&owner(), &cancelling_id, 7));
        wait_for_teardown(&manager, &id, TeardownOwner::CommandCancelling);
        drop(admission);
        let barrier = cancelling.join().unwrap().unwrap();
        assert!(manager.sessions.lock().unwrap().entries.contains_key(&id));
        manager.close(&owner(), &id, 7, barrier.barrier_id).unwrap();
        assert!(manager.assert_empty());
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
                        file: Arc::new(Mutex::new(File::open(&path).unwrap())),
                        teardown,
                        queued: 0,
                        in_flight: 0,
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
        assert!(manager.assert_empty());
        std::fs::remove_file(path).unwrap();
    }
}

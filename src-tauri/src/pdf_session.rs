use crate::local_path::{
    FinalHandlePolicy, LocalPathPolicy, SystemFinalHandlePolicy, SystemLocalPathPolicy,
};
use rand::RngCore;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

pub const NORMAL_RANGE_LIMIT: u32 = 1024 * 1024;
pub const ABSOLUTE_RANGE_LIMIT: u32 = 4 * 1024 * 1024;
pub const MAX_DOCUMENT_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_SESSIONS: usize = 8;
pub const MAX_PROCESS_IN_FLIGHT: usize = 4;
pub const MAX_SESSION_IN_FLIGHT: usize = 2;
pub const MAX_PROCESS_QUEUE: usize = 32;
pub const MAX_SESSION_QUEUE: usize = 8;

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
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
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CancelBarrier {
    pub barrier_id: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PdfSessionError {
    PathRejected,
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
        }
    }
}

struct Session {
    owner: PdfOwner,
    generation: u64,
    length: u64,
    file: Arc<Mutex<File>>,
    closing: bool,
    // The File mutex serializes physical reads per session; this explicit bound protects
    // queued work if I/O becomes parallel later.
    queued: usize,
    in_flight: usize,
    barrier: Option<u64>,
}
struct Sessions {
    entries: HashMap<SessionId, Session>,
    next_generation: u64,
    next_barrier: u64,
    process_queued: usize,
    process_in_flight: usize,
}
pub struct PdfSessionManager {
    sessions: Mutex<Sessions>,
    drained: Condvar,
}
impl Default for PdfSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PdfSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(Sessions {
                entries: HashMap::new(),
                next_generation: 1,
                next_barrier: 1,
                process_queued: 0,
                process_in_flight: 0,
            }),
            drained: Condvar::new(),
        }
    }

    /// Opens only a local PDF. The retained handle is locality-checked after open to prevent
    /// reparse targets from bypassing the pre-open policy.
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
        match policy.classify(path) {
            Ok(crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable) => {}
            Ok(crate::local_path::DriveKind::Remote) | Err(_) => {
                return Err(PdfSessionError::PathRejected)
            }
        }
        if !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
        {
            return Err(PdfSessionError::PdfInvalid);
        }
        if self
            .sessions
            .lock()
            .expect("session state poisoned")
            .entries
            .len()
            >= MAX_SESSIONS
        {
            return Err(PdfSessionError::SessionCapacity);
        }
        let mut file = opener(path).map_err(|_| PdfSessionError::FileUnreadable)?;
        match final_policy.classify_final(&file) {
            Ok(crate::local_path::DriveKind::Fixed | crate::local_path::DriveKind::Removable) => {}
            Ok(crate::local_path::DriveKind::Remote) | Err(_) => {
                return Err(PdfSessionError::PathRejected)
            }
        }
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
                closing: false,
                queued: 0,
                in_flight: 0,
                barrier: None,
            },
        );
        Ok(PdfSessionMetadata {
            session_id,
            document_generation: generation,
            length,
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
        let (file, available) = {
            let mut sessions = self.sessions.lock().expect("session state poisoned");
            if sessions.process_queued >= MAX_PROCESS_QUEUE {
                return Err(PdfSessionError::RangeCapacity);
            }
            let (file, available) = {
                let session = Self::checked_session(&mut sessions, owner, id, generation)?;
                if session.closing {
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
                (session.closing, session.in_flight >= MAX_SESSION_IN_FLIGHT)
            };
            sessions.process_queued -= 1;
            if closing {
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
    pub fn cancel(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<CancelBarrier, PdfSessionError> {
        let mut sessions = self.sessions.lock().expect("session state poisoned");
        Self::checked_session(&mut sessions, owner, id, generation)?.closing = true;
        while {
            let session = sessions
                .entries
                .get(id)
                .ok_or(PdfSessionError::SessionNotFound)?;
            session.in_flight != 0 || session.queued != 0
        } {
            sessions = self.drained.wait(sessions).expect("session state poisoned");
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
        let session = Self::checked_session(&mut sessions, owner, id, generation)?;
        if !session.closing || session.in_flight != 0 || session.queued != 0 {
            return Err(PdfSessionError::SessionClosing);
        }
        if session.barrier != Some(barrier_id) {
            return Err(PdfSessionError::BarrierMismatch);
        }
        sessions.entries.remove(id);
        Ok(())
    }
    pub fn assert_empty(&self) -> bool {
        let sessions = self.sessions.lock().expect("session state poisoned");
        sessions.entries.is_empty()
            && sessions.process_queued == 0
            && sessions.process_in_flight == 0
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

use crate::commands::state::{
    format_recent_timestamp, RecentFile, StateFileError, StateFileStore, SystemClock,
    MAX_RECENT_FILES,
};
use crate::local_path::{DriveKind, LocalPathPolicy, PathPolicyError};
use crate::pdf_session::TrustedRecentIdentity;
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};

const MAX_DISPLAY_PATH_UTF16_UNITS: usize = 32_767;
pub const MAX_RECENT_DOCUMENTS: usize = MAX_RECENT_FILES;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocument {
    recent_id: String,
    display_name: String,
    display_path: String,
}
impl RecentDocument {
    pub fn recent_id(&self) -> &str {
        &self.recent_id
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn display_path(&self) -> &str {
        &self.display_path
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecentStateReason {
    StateUnreadable,
    StateInvalidRoot,
    RecentFieldInvalid,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "tag",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum RecentListOutcome {
    Ready {
        revision: String,
        entries: Vec<RecentDocument>,
    },
    StateUnavailable {
        reason: RecentStateReason,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecentStorageReason {
    StateWriteFailed,
    IdentityUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "tag",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum RecentRecordOutcome {
    Committed {
        revision: String,
        entries: Vec<RecentDocument>,
    },
    StateUnavailable {
        reason: RecentStateReason,
    },
    StorageFailed {
        reason: RecentStorageReason,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "tag",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum RecentOpenOutcome {
    Admitted {
        request_id: String,
    },
    StaleSelection {
        revision: String,
        entries: Vec<RecentDocument>,
    },
    MissingPruned {
        revision: String,
        entries: Vec<RecentDocument>,
    },
    MissingPruneFailed {
        reason: String,
    },
    AccessDenied {
        reason: String,
    },
    TransientFailure {
        reason: String,
    },
    DocumentRejected {
        reason: String,
    },
    StateUnavailable {
        reason: RecentStateReason,
    },
}

#[derive(Debug)]
pub enum RecentStoreError {
    RemotePath,
    PathRejected,
    NotPdf,
    MissingRecentId,
    Io(io::Error),
    StateUnavailable(RecentStateReason),
}
impl std::fmt::Display for RecentStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::RemotePath => "REMOTE_PATH",
            Self::PathRejected => "PATH_REJECTED",
            Self::NotPdf => "PDF_INVALID",
            Self::MissingRecentId => "RECENT_NOT_FOUND",
            Self::Io(_) => "RECENT_STORAGE_FAILED",
            Self::StateUnavailable(_) => "RECENT_STATE_UNAVAILABLE",
        })
    }
}
impl std::error::Error for RecentStoreError {}
impl From<io::Error> for RecentStoreError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Clone, Debug)]
struct StoredRecent {
    recent_id: String,
    canonical_path: PathBuf,
}

/// Native path authority; projected paths are bounded display metadata and only opaque IDs resolve.
pub struct RecentStore {
    state: StateFileStore,
    records: Vec<StoredRecent>,
    health: Option<RecentStateReason>,
    revision: u64,
}
impl RecentStore {
    pub fn load<P: AsRef<Path>, L: LocalPathPolicy>(
        state_path: P,
        policy: &L,
    ) -> Result<Self, RecentStoreError> {
        let state = StateFileStore::new(state_path.as_ref().to_path_buf());
        let (records, health) = match state.load_recents_strict() {
            Ok(values)
                if values
                    .iter()
                    .all(|value| valid_persisted_recent(value, policy)) =>
            {
                (records_from_state(values, &[]), None)
            }
            Ok(_) => (Vec::new(), Some(RecentStateReason::RecentFieldInvalid)),
            Err(StateFileError::Absent) => (Vec::new(), None),
            Err(StateFileError::Invalid) => (Vec::new(), Some(RecentStateReason::StateInvalidRoot)),
            Err(StateFileError::RecentInvalid) => {
                (Vec::new(), Some(RecentStateReason::RecentFieldInvalid))
            }
            Err(_) => (Vec::new(), Some(RecentStateReason::StateUnreadable)),
        };
        Ok(Self {
            state,
            records,
            health,
            revision: 0,
        })
    }

    pub fn list_outcome(&self) -> RecentListOutcome {
        match self.health {
            Some(reason) => RecentListOutcome::StateUnavailable { reason },
            None => RecentListOutcome::Ready {
                revision: self.revision.to_string(),
                entries: self.documents(),
            },
        }
    }

    pub fn snapshot(&self) -> (String, Vec<RecentDocument>) {
        (self.revision.to_string(), self.documents())
    }

    pub fn health_reason(&self) -> Option<RecentStateReason> {
        self.health
    }
    fn ensure_writable(&self) -> Result<(), RecentStoreError> {
        match self.health {
            Some(reason) => Err(RecentStoreError::StateUnavailable(reason)),
            None => Ok(()),
        }
    }
    fn committed(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    pub fn documents(&self) -> Vec<RecentDocument> {
        self.records
            .iter()
            .filter_map(|record| {
                Some(RecentDocument {
                    recent_id: record.recent_id.clone(),
                    display_name: safe_display_name(&record.canonical_path)?,
                    display_path: safe_display_path(&record.canonical_path)?,
                })
            })
            .collect()
    }

    pub fn record_trusted_opened_and_save(
        &mut self,
        identity: TrustedRecentIdentity,
    ) -> Result<RecentDocument, RecentStoreError> {
        self.record_canonical_opened(identity.canonical_path().to_path_buf())
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn debug_record_opened_and_save<L: LocalPathPolicy>(
        &mut self,
        path: &Path,
        policy: &L,
    ) -> Result<RecentDocument, RecentStoreError> {
        self.record_canonical_opened(validate_and_canonicalize(path, policy)?)
    }

    fn record_canonical_opened(
        &mut self,
        canonical_path: PathBuf,
    ) -> Result<RecentDocument, RecentStoreError> {
        self.ensure_writable()?;
        if !is_pdf(&canonical_path) {
            return Err(RecentStoreError::NotPdf);
        }
        let canonical_path = normalize_canonical_path(canonical_path)?;
        let display_name = safe_display_name(&canonical_path).ok_or(RecentStoreError::NotPdf)?;
        let display_path =
            safe_display_path(&canonical_path).ok_or(RecentStoreError::PathRejected)?;
        let timestamp = format_recent_timestamp(&SystemClock).map_err(state_error)?;
        self.state
            .record_recent_success(RecentFile {
                absolute_path: canonical_path.to_string_lossy().into_owned(),
                last_opened_at: timestamp,
            })
            .map_err(state_error)?;
        let recent_id = self
            .records
            .iter()
            .find(|record| record.canonical_path == canonical_path)
            .map(|record| record.recent_id.clone())
            .unwrap_or_else(new_recent_id);
        self.records
            .retain(|record| record.canonical_path != canonical_path);
        self.records.insert(
            0,
            StoredRecent {
                recent_id: recent_id.clone(),
                canonical_path: canonical_path.clone(),
            },
        );
        self.records.truncate(MAX_RECENT_DOCUMENTS);
        self.committed();
        Ok(RecentDocument {
            recent_id,
            display_name,
            display_path,
        })
    }

    pub fn clear_all_and_save(&mut self) -> Result<bool, RecentStoreError> {
        self.ensure_writable()?;
        let persisted_changed = match self.state.clear_recents() {
            Ok(changed) => changed,
            Err(StateFileError::Invalid) => {
                let reason = RecentStateReason::StateInvalidRoot;
                self.health = Some(reason);
                return Err(RecentStoreError::StateUnavailable(reason));
            }
            Err(StateFileError::RecentInvalid) => {
                let reason = RecentStateReason::RecentFieldInvalid;
                self.health = Some(reason);
                return Err(RecentStoreError::StateUnavailable(reason));
            }
            Err(error) => return Err(state_error(error)),
        };
        let changed = persisted_changed || !self.records.is_empty();
        self.records.clear();
        if changed {
            self.committed();
        }
        Ok(changed)
    }
    pub fn prune_missing_id(&mut self, recent_id: &str) -> Result<bool, RecentStoreError> {
        self.ensure_writable()?;
        let Some(index) = self
            .records
            .iter()
            .position(|record| record.recent_id == recent_id)
        else {
            return Ok(false);
        };
        let path = self.records[index]
            .canonical_path
            .to_string_lossy()
            .into_owned();
        if !self.state.remove_recent_path(&path).map_err(state_error)? {
            return Ok(false);
        }
        self.records.remove(index);
        self.committed();
        Ok(true)
    }
    pub fn resolve_for_open<L: LocalPathPolicy>(
        &self,
        recent_id: &str,
        policy: &L,
    ) -> Result<PathBuf, RecentStoreError> {
        self.ensure_writable()?;
        let record = self
            .records
            .iter()
            .find(|record| record.recent_id == recent_id)
            .ok_or(RecentStoreError::MissingRecentId)?;
        policy
            .validate_syntax(&record.canonical_path)
            .map_err(map_policy_error)?;
        match policy
            .classify_syntax(&record.canonical_path)
            .map_err(map_policy_error)?
        {
            DriveKind::Fixed | DriveKind::Removable => {}
            DriveKind::Remote => return Err(RecentStoreError::RemotePath),
        }
        policy
            .validate_existing_ancestors(&record.canonical_path)
            .map_err(map_policy_error)?;
        std::fs::metadata(&record.canonical_path).map_err(RecentStoreError::Io)?;
        validate_and_canonicalize(&record.canonical_path, policy)
    }
}

fn valid_persisted_recent<L: LocalPathPolicy>(value: &RecentFile, policy: &L) -> bool {
    let path = Path::new(&value.absolute_path);
    path.is_absolute()
        && is_pdf(path)
        && value.last_opened_at.parse::<u64>().is_ok()
        && safe_display_name(path).is_some()
        && safe_display_path(path).is_some()
        && policy.validate_syntax(path).is_ok()
        && matches!(
            policy.classify_syntax(path),
            Ok(DriveKind::Fixed | DriveKind::Removable)
        )
}
fn records_from_state(values: Vec<RecentFile>, previous: &[StoredRecent]) -> Vec<StoredRecent> {
    values
        .into_iter()
        .map(|value| {
            let canonical_path = PathBuf::from(value.absolute_path);
            let recent_id = previous
                .iter()
                .find(|record| record.canonical_path == canonical_path)
                .map(|record| record.recent_id.clone())
                .unwrap_or_else(new_recent_id);
            StoredRecent {
                recent_id,
                canonical_path,
            }
        })
        .collect()
}
fn new_recent_id() -> String {
    format!("recent-{:032x}", rand::random::<u128>())
}
fn safe_display_name(path: &Path) -> Option<String> {
    let value = path.file_name()?.to_string_lossy();
    if value.is_empty() {
        return None;
    }
    Some(
        value
            .chars()
            .map(|character| {
                if character.is_control() || character == '/' || character == '\\' {
                    '\u{FFFD}'
                } else {
                    character
                }
            })
            .collect(),
    )
}
fn safe_display_path(path: &Path) -> Option<String> {
    let value: String = path
        .to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_control() {
                '\u{FFFD}'
            } else {
                character
            }
        })
        .collect();
    if value.is_empty() || value.encode_utf16().count() > MAX_DISPLAY_PATH_UTF16_UNITS {
        return None;
    }
    Some(value)
}
fn is_pdf(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn validate_and_canonicalize<L: LocalPathPolicy>(
    path: &Path,
    policy: &L,
) -> Result<PathBuf, RecentStoreError> {
    match policy.classify(path).map_err(map_policy_error)? {
        DriveKind::Fixed | DriveKind::Removable => {}
        DriveKind::Remote => return Err(RecentStoreError::RemotePath),
    }
    policy.validate_preopen(path).map_err(map_policy_error)?;
    if !is_pdf(path) {
        return Err(RecentStoreError::NotPdf);
    }
    normalize_canonical_path(std::fs::canonicalize(path).map_err(RecentStoreError::Io)?)
}
#[cfg(windows)]
fn normalize_canonical_path(path: PathBuf) -> Result<PathBuf, RecentStoreError> {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return Ok(PathBuf::from(format!(r"\\{rest}")));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return Ok(PathBuf::from(rest));
    }
    Ok(path)
}
#[cfg(not(windows))]
fn normalize_canonical_path(path: PathBuf) -> Result<PathBuf, RecentStoreError> {
    Ok(path)
}
fn map_policy_error(error: PathPolicyError) -> RecentStoreError {
    match error {
        PathPolicyError::RemotePath => RecentStoreError::RemotePath,
        PathPolicyError::PathRejected => RecentStoreError::PathRejected,
    }
}
fn state_error(error: StateFileError) -> RecentStoreError {
    RecentStoreError::Io(io::Error::other(match error {
        StateFileError::Absent => "state absent",
        StateFileError::Invalid => "state invalid",
        StateFileError::RecentInvalid => "recent field invalid",
        StateFileError::Io => "state I/O",
        StateFileError::LockTimeout => "state lock timeout",
        StateFileError::Fault => "state persistence fault",
    }))
}

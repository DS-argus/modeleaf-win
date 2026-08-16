use crate::commands::state::{
    format_recent_timestamp, RecentFile, StateFileError, StateFileStore, SystemClock,
    MAX_RECENT_FILES,
};
use crate::local_path::{DriveKind, LocalPathPolicy, PathPolicyError};
use crate::pdf_session::TrustedRecentIdentity;
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};

pub const MAX_RECENT_DOCUMENTS: usize = MAX_RECENT_FILES;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocument {
    recent_id: String,
    display_name: String,
}
impl RecentDocument {
    pub fn recent_id(&self) -> &str {
        &self.recent_id
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

#[derive(Debug)]
pub enum RecentStoreError {
    RemotePath,
    PathRejected,
    NotPdf,
    MissingRecentId,
    Io(io::Error),
}
impl std::fmt::Display for RecentStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::RemotePath => "REMOTE_PATH",
            Self::PathRejected => "PATH_REJECTED",
            Self::NotPdf => "PDF_INVALID",
            Self::MissingRecentId => "RECENT_NOT_FOUND",
            Self::Io(_) => "RECENT_STORAGE_FAILED",
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

/// Native-only path authority. Renderer projections contain only opaque IDs and leaf names.
pub struct RecentStore {
    state: StateFileStore,
    records: Vec<StoredRecent>,
    startup_recovery_needed: bool,
}
impl RecentStore {
    pub fn load<P: AsRef<Path>, L: LocalPathPolicy>(
        state_path: P,
        _policy: &L,
    ) -> Result<Self, RecentStoreError> {
        let state = StateFileStore::new(state_path.as_ref().to_path_buf());
        let (records, startup_recovery_needed) = match state.load() {
            Ok(snapshot) => (records_from_state(snapshot.recent_files, &[]), false),
            Err(StateFileError::Absent) => (Vec::new(), false),
            Err(_) => (Vec::new(), true),
        };
        Ok(Self {
            state,
            records,
            startup_recovery_needed,
        })
    }

    pub fn take_startup_recovery_needed(&mut self) -> bool {
        std::mem::take(&mut self.startup_recovery_needed)
    }

    pub fn documents(&self) -> Vec<RecentDocument> {
        self.records
            .iter()
            .filter_map(|record| {
                Some(RecentDocument {
                    recent_id: record.recent_id.clone(),
                    display_name: safe_display_name(&record.canonical_path)?,
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
        if !is_pdf(&canonical_path) {
            return Err(RecentStoreError::NotPdf);
        }
        let canonical_path = normalize_canonical_path(canonical_path)?;
        let timestamp = format_recent_timestamp(&SystemClock).map_err(state_error)?;
        self.state
            .record_recent_success(RecentFile {
                absolute_path: canonical_path.to_string_lossy().into_owned(),
                last_opened_at: timestamp,
            })
            .map_err(state_error)?;
        let snapshot = self.state.load().map_err(state_error)?;
        self.records = records_from_state(snapshot.recent_files, &self.records);
        let record = self
            .records
            .iter()
            .find(|record| record.canonical_path == canonical_path)
            .ok_or(RecentStoreError::MissingRecentId)?;
        Ok(RecentDocument {
            recent_id: record.recent_id.clone(),
            display_name: safe_display_name(&record.canonical_path)
                .ok_or(RecentStoreError::NotPdf)?,
        })
    }

    pub fn prune_missing_id(&mut self, recent_id: &str) -> Result<bool, RecentStoreError> {
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
        Ok(true)
    }
    pub fn resolve_for_open<L: LocalPathPolicy>(
        &self,
        recent_id: &str,
        policy: &L,
    ) -> Result<PathBuf, RecentStoreError> {
        let record = self
            .records
            .iter()
            .find(|record| record.recent_id == recent_id)
            .ok_or(RecentStoreError::MissingRecentId)?;
        validate_and_canonicalize(&record.canonical_path, policy)
    }
}

fn records_from_state(values: Vec<RecentFile>, previous: &[StoredRecent]) -> Vec<StoredRecent> {
    values
        .into_iter()
        .filter_map(|value| {
            let canonical_path = PathBuf::from(value.absolute_path);
            if !is_pdf(&canonical_path) {
                return None;
            }
            let recent_id = previous
                .iter()
                .find(|record| record.canonical_path == canonical_path)
                .map(|record| record.recent_id.clone())
                .unwrap_or_else(new_recent_id);
            Some(StoredRecent {
                recent_id,
                canonical_path,
            })
        })
        .collect()
}
fn new_recent_id() -> String {
    format!("recent-{:032x}", rand::random::<u128>())
}
fn safe_display_name(path: &Path) -> Option<String> {
    path.file_name()?
        .to_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
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
        StateFileError::Io => "state I/O",
        StateFileError::LockTimeout => "state lock timeout",
        StateFileError::Fault => "state persistence fault",
    }))
}

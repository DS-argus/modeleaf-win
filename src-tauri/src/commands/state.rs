//! Durable ownership of the three state.json siblings.
use crate::persistence::{
    atomic_write::{self, AtomicWriteFaults},
    lock::SidecarLock,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const MAX_STATE_BYTES: u64 = 256 * 1024;
pub const MAX_RECENT_FILES: usize = 15;
pub const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const VALID_THEMES: &[&str] = &[
    "tokyo-night",
    "gruvbox-dark",
    "solarized-dark",
    "dracula",
    "everforest",
    "nord",
    "catppuccin-latte",
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecentFile {
    pub absolute_path: String,
    pub last_opened_at: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkDestinationIndicatorStyle {
    PulseRing,
    Target,
    Beacon,
    StaticRing,
    DiamondPulse,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkDestinationIndicator {
    pub style: LinkDestinationIndicatorStyle,
    pub color: String,
    pub size: f64,
    pub duration_ms: u32,
}
impl LinkDestinationIndicator {
    pub fn validate(&self) -> Result<(), StateFileError> {
        if !valid_indicator_color(&self.color)
            || !self.size.is_finite()
            || !(16.0..=48.0).contains(&self.size)
            || !(500..=3000).contains(&self.duration_ms)
        {
            Err(StateFileError::Invalid)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StateSnapshot {
    pub selected_theme: Option<String>,
    pub recent_files: Vec<RecentFile>,
    pub link_destination_indicator: Option<LinkDestinationIndicator>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecentPruneOutcome {
    PrunedMissing,
    RetainedPermissionDenied,
    RetainedSharingViolation,
    RetainedTransientFailure,
    RetainedNetworkFailure,
    RetainedInvalidPdf,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StateFileError {
    Absent,
    Invalid,
    RecentInvalid,
    Io,
    LockTimeout,
    Fault,
}

/// Narrow deterministic time seam for callers constructing recent DTOs.
pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}
#[derive(Default)]
pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}
/// Classifies a recent path without granting this store filesystem authority.
pub trait RecentPathClassifier: Send + Sync {
    fn classify(&self, path: &Path) -> RecentPruneOutcome;
}

pub struct StateFileStore {
    path: PathBuf,
    lock_timeout: Duration,
}
impl StateFileStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock_timeout: DEFAULT_LOCK_TIMEOUT,
        }
    }
    pub fn with_lock_timeout(path: PathBuf, lock_timeout: Duration) -> Self {
        Self { path, lock_timeout }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn load(&self) -> Result<StateSnapshot, StateFileError> {
        Ok(decode_snapshot(&self.read_root()?))
    }
    pub fn load_recents_strict(&self) -> Result<Vec<RecentFile>, StateFileError> {
        decode_recents_strict(self.read_root()?.get("recent_files"))
    }
    pub fn read_indicator(&self) -> Result<Option<LinkDestinationIndicator>, StateFileError> {
        match self.load() {
            Ok(snapshot) => Ok(snapshot.link_destination_indicator),
            Err(StateFileError::Absent) => Ok(None),
            Err(error) => Err(error),
        }
    }
    pub fn set_selected_theme(&self, value: String) -> Result<(), StateFileError> {
        if !VALID_THEMES.contains(&value.as_str()) {
            return Err(StateFileError::Invalid);
        }
        self.update(|root| {
            root.insert("selected_theme".into(), Value::String(value));
            Ok(())
        })
    }
    pub fn set_link_destination_indicator(
        &self,
        value: LinkDestinationIndicator,
    ) -> Result<(), StateFileError> {
        let mut value = value;
        value.validate()?;
        if value.color.starts_with('#') {
            value.color.make_ascii_lowercase();
        }
        self.update(|root| {
            root.insert(
                "link_destination_indicator".into(),
                serde_json::to_value(value).map_err(|_| StateFileError::Invalid)?,
            );
            Ok(())
        })
    }
    /// Successful opens are exact-path deduplicated, newest first, capped at fifteen.
    pub fn record_recent_success(&self, value: RecentFile) -> Result<(), StateFileError> {
        if value.absolute_path.is_empty() {
            return Err(StateFileError::Invalid);
        }
        self.update_recent(|root| {
            let mut recents = decode_recents_strict(root.get("recent_files"))?;
            recents.retain(|item| item.absolute_path != value.absolute_path);
            recents.insert(0, value);
            recents.truncate(MAX_RECENT_FILES);
            root.insert(
                "recent_files".into(),
                serde_json::to_value(recents).map_err(|_| StateFileError::Invalid)?,
            );
            Ok(())
        })
    }
    /// Clears only the recent-files sibling through the shared state transaction.
    pub fn clear_recents(&self) -> Result<bool, StateFileError> {
        self.clear_recents_with_faults(AtomicWriteFaults::default())
    }
    fn clear_recents_with_faults(&self, faults: AtomicWriteFaults) -> Result<bool, StateFileError> {
        let mut changed = false;
        self.update_recent_with_faults(
            |root| {
                changed = !decode_recents_strict(root.get("recent_files"))?.is_empty();
                root.insert("recent_files".into(), Value::Array(Vec::new()));
                Ok(())
            },
            faults,
        )?;
        Ok(changed)
    }
    /// Only confirmed absence is pruned; all other classifications are retained.
    pub fn remove_recent_path(&self, absolute_path: &str) -> Result<bool, StateFileError> {
        let mut removed = false;
        self.update_recent(|root| {
            let mut recents = decode_recents_strict(root.get("recent_files"))?;
            recents.retain(|item| {
                let matches = item.absolute_path == absolute_path;
                removed |= matches;
                !matches
            });
            root.insert(
                "recent_files".into(),
                serde_json::to_value(recents).map_err(|_| StateFileError::Invalid)?,
            );
            Ok(())
        })?;
        Ok(removed)
    }
    pub fn prune_recents(
        &self,
        classifier: &dyn RecentPathClassifier,
    ) -> Result<usize, StateFileError> {
        let mut removed = 0;
        self.update_recent(|root| {
            let mut recents = decode_recents_strict(root.get("recent_files"))?;
            recents.retain(|item| {
                let missing = classifier.classify(Path::new(&item.absolute_path))
                    == RecentPruneOutcome::PrunedMissing;
                removed += usize::from(missing);
                !missing
            });
            root.insert(
                "recent_files".into(),
                serde_json::to_value(recents).map_err(|_| StateFileError::Invalid)?,
            );
            Ok(())
        })?;
        Ok(removed)
    }
    fn update_recent(
        &self,
        change: impl FnOnce(&mut Map<String, Value>) -> Result<(), StateFileError>,
    ) -> Result<(), StateFileError> {
        self.update_recent_with_faults(change, AtomicWriteFaults::default())
    }
    fn update_recent_with_faults(
        &self,
        change: impl FnOnce(&mut Map<String, Value>) -> Result<(), StateFileError>,
        faults: AtomicWriteFaults,
    ) -> Result<(), StateFileError> {
        let _guard = SidecarLock::acquire(&self.path, self.lock_timeout).map_err(map_lock_error)?;
        let mut root = match self.read_root() {
            Ok(root) => root,
            Err(StateFileError::Absent) => Map::new(),
            Err(error) => return Err(error),
        };
        change(&mut root)?;
        let bytes = serialize_stable(&root)?;
        if bytes.len() as u64 > MAX_STATE_BYTES {
            return Err(StateFileError::Invalid);
        }
        atomic_write::replace_with_faults(&self.path, &bytes, "state", faults)
            .map_err(map_persistence_error)
    }
    fn update(
        &self,
        change: impl FnOnce(&mut Map<String, Value>) -> Result<(), StateFileError>,
    ) -> Result<(), StateFileError> {
        self.update_with_faults(change, AtomicWriteFaults::default())
    }
    fn update_with_faults(
        &self,
        change: impl FnOnce(&mut Map<String, Value>) -> Result<(), StateFileError>,
        faults: AtomicWriteFaults,
    ) -> Result<(), StateFileError> {
        let _guard = SidecarLock::acquire(&self.path, self.lock_timeout).map_err(map_lock_error)?;
        let mut root = match self.read_root() {
            Ok(root) => root,
            Err(StateFileError::Absent | StateFileError::Invalid) => Map::new(),
            Err(error) => return Err(error),
        };
        change(&mut root)?;
        let bytes = serialize_stable(&root)?;
        if bytes.len() as u64 > MAX_STATE_BYTES {
            return Err(StateFileError::Invalid);
        }
        atomic_write::replace_with_faults(&self.path, &bytes, "state", faults)
            .map_err(map_persistence_error)
    }
    #[cfg(test)]
    fn set_selected_theme_with_faults(
        &self,
        value: &str,
        faults: AtomicWriteFaults,
    ) -> Result<(), StateFileError> {
        if !VALID_THEMES.contains(&value) {
            return Err(StateFileError::Invalid);
        }
        self.update_with_faults(
            |root| {
                root.insert("selected_theme".into(), Value::String(value.to_owned()));
                Ok(())
            },
            faults,
        )
    }
    fn read_root(&self) -> Result<Map<String, Value>, StateFileError> {
        let mut file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(StateFileError::Absent)
            }
            Err(_) => return Err(StateFileError::Io),
        };
        let mut bytes = Vec::with_capacity((MAX_STATE_BYTES as usize).min(8192));
        file.by_ref()
            .take(MAX_STATE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| StateFileError::Io)?;
        if bytes.len() as u64 > MAX_STATE_BYTES {
            return Err(StateFileError::Invalid);
        }
        match serde_json::from_slice(&bytes) {
            Ok(Value::Object(root)) => Ok(root),
            _ => Err(StateFileError::Invalid),
        }
    }
}
fn valid_indicator_color(value: &str) -> bool {
    matches!(
        value,
        "red"
            | "amber"
            | "cyan"
            | "green"
            | "purple"
            | "accent"
            | "auto-contrast"
            | "high-contrast"
    ) || (value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
}
fn decode_snapshot(root: &Map<String, Value>) -> StateSnapshot {
    StateSnapshot {
        selected_theme: root
            .get("selected_theme")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        recent_files: decode_recents(root.get("recent_files")),
        link_destination_indicator: root
            .get("link_destination_indicator")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .filter(|value: &LinkDestinationIndicator| value.validate().is_ok()),
    }
}
fn decode_recents(value: Option<&Value>) -> Vec<RecentFile> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<RecentFile>(value.clone()).ok())
        .filter(|item| !item.absolute_path.is_empty())
        .filter(|item| seen.insert(item.absolute_path.clone()))
        .take(MAX_RECENT_FILES)
        .collect()
}
fn decode_recents_strict(value: Option<&Value>) -> Result<Vec<RecentFile>, StateFileError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let entries = value.as_array().ok_or(StateFileError::RecentInvalid)?;
    if entries.len() > MAX_RECENT_FILES {
        return Err(StateFileError::RecentInvalid);
    }
    let mut seen = HashSet::new();
    let mut decoded = Vec::with_capacity(entries.len());
    for value in entries {
        let item = serde_json::from_value::<RecentFile>(value.clone())
            .map_err(|_| StateFileError::RecentInvalid)?;
        if item.absolute_path.is_empty() || !seen.insert(item.absolute_path.clone()) {
            return Err(StateFileError::RecentInvalid);
        }
        decoded.push(item);
    }
    Ok(decoded)
}
fn sort_value(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().cloned().collect();
            keys.sort_unstable();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), sort_value(object[&key].clone()));
            }
            Value::Object(sorted)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(sort_value).collect()),
        value => value,
    }
}
fn serialize_stable(root: &Map<String, Value>) -> Result<Vec<u8>, StateFileError> {
    serde_json::to_string_pretty(&sort_value(Value::Object(root.clone())))
        .map(|text| text.into_bytes())
        .map_err(|_| StateFileError::Invalid)
}
fn map_lock_error(error: crate::persistence::lock::LockError) -> StateFileError {
    match error {
        crate::persistence::lock::LockError::Timeout => StateFileError::LockTimeout,
        crate::persistence::lock::LockError::Io(_) => StateFileError::Io,
    }
}
fn map_persistence_error(error: io::Error) -> StateFileError {
    if error.to_string().contains("injected fault") {
        StateFileError::Fault
    } else {
        StateFileError::Io
    }
}
pub fn format_recent_timestamp(clock: &dyn Clock) -> Result<String, StateFileError> {
    clock
        .now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .map_err(|_| StateFileError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (PathBuf, StateFileStore) {
        let directory = std::env::temp_dir().join(format!(
            "modeleaf-state-{name}-상태-{:032x}",
            rand::random::<u128>()
        ));
        let path = directory.join(format!("{}-state.json", "긴".repeat(20)));
        (
            directory,
            StateFileStore::with_lock_timeout(path, Duration::from_millis(20)),
        )
    }

    #[test]
    fn updates_preserve_unknown_and_malformed_non_target_siblings() {
        let (directory, store) = store("siblings");
        fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        fs::write(
            store.path(),
            br#"{"future":{"keep":true},"recent_files":{},"link_destination_indicator":17}"#,
        )
        .unwrap();
        store.set_selected_theme("nord".into()).unwrap();
        let root: Value = serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(root["future"]["keep"], true);
        assert!(root["recent_files"].is_object());
        assert_eq!(root["link_destination_indicator"], 17);
        assert_eq!(
            store.load().unwrap().selected_theme.as_deref(),
            Some("nord")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn theme_accepts_exactly_the_frozen_seven_ids() {
        let (directory, store) = store("themes");
        for theme in VALID_THEMES {
            store.set_selected_theme((*theme).into()).unwrap();
        }
        assert_eq!(
            store.set_selected_theme("unknown".into()),
            Err(StateFileError::Invalid)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn indicator_accepts_all_styles_fractional_size_and_exact_bounds() {
        let (directory, store) = store("indicator");
        let styles = [
            LinkDestinationIndicatorStyle::PulseRing,
            LinkDestinationIndicatorStyle::Target,
            LinkDestinationIndicatorStyle::Beacon,
            LinkDestinationIndicatorStyle::StaticRing,
            LinkDestinationIndicatorStyle::DiamondPulse,
        ];
        for style in styles {
            store
                .set_link_destination_indicator(LinkDestinationIndicator {
                    style,
                    color: "#12aBcF".into(),
                    size: 28.5,
                    duration_ms: 1500,
                })
                .unwrap();
        }
        assert_eq!(store.read_indicator().unwrap().unwrap().color, "#12abcf");
        assert_eq!(
            LinkDestinationIndicator {
                style: LinkDestinationIndicatorStyle::Target,
                color: "cyan".into(),
                size: 15.9,
                duration_ms: 1500
            }
            .validate(),
            Err(StateFileError::Invalid)
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn successful_recents_dedupe_promote_and_cap_at_fifteen() {
        let (directory, store) = store("recent");
        for index in 0..16 {
            store
                .record_recent_success(RecentFile {
                    absolute_path: format!("C:/문서/{index}.pdf"),
                    last_opened_at: index.to_string(),
                })
                .unwrap();
        }
        store
            .record_recent_success(RecentFile {
                absolute_path: "C:/문서/3.pdf".into(),
                last_opened_at: "99".into(),
            })
            .unwrap();
        let recents = store.load().unwrap().recent_files;
        assert_eq!(recents.len(), 15);
        assert_eq!(
            recents[0],
            RecentFile {
                absolute_path: "C:/문서/3.pdf".into(),
                last_opened_at: "99".into()
            }
        );
        assert_eq!(
            recents
                .iter()
                .filter(|entry| entry.absolute_path.ends_with("/3.pdf"))
                .count(),
            1
        );
        fs::remove_dir_all(directory).unwrap();
    }

    struct MissingOnly;
    impl RecentPathClassifier for MissingOnly {
        fn classify(&self, path: &Path) -> RecentPruneOutcome {
            if path.to_string_lossy().contains("missing") {
                RecentPruneOutcome::PrunedMissing
            } else {
                RecentPruneOutcome::RetainedPermissionDenied
            }
        }
    }
    #[test]
    fn prune_removes_only_confirmed_missing_paths() {
        let (directory, store) = store("prune");
        for name in ["missing.pdf", "denied.pdf"] {
            store
                .record_recent_success(RecentFile {
                    absolute_path: name.into(),
                    last_opened_at: "0".into(),
                })
                .unwrap();
        }
        assert_eq!(store.prune_recents(&MissingOnly).unwrap(), 1);
        assert_eq!(
            store.load().unwrap().recent_files[0].absolute_path,
            "denied.pdf"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn mutation_fails_closed_on_lock_contention() {
        let (directory, store) = store("lock");
        let _lock = SidecarLock::acquire(store.path(), Duration::from_millis(20)).unwrap();
        assert_eq!(
            store.set_selected_theme("dracula".into()),
            Err(StateFileError::LockTimeout)
        );
        drop(_lock);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn publication_faults_retain_or_commit_complete_state_and_clean_temps() {
        let (directory, store) = store("faults");
        store.set_selected_theme("dracula".into()).unwrap();
        let original = fs::read(store.path()).unwrap();
        let before = AtomicWriteFaults {
            fail_before_replace: true,
            ..Default::default()
        };
        assert_eq!(
            store.set_selected_theme_with_faults("nord", before),
            Err(StateFileError::Fault)
        );
        assert_eq!(fs::read(store.path()).unwrap(), original);
        let after = AtomicWriteFaults {
            fail_after_replace: true,
            ..Default::default()
        };
        assert_eq!(
            store.set_selected_theme_with_faults("nord", after),
            Err(StateFileError::Fault)
        );
        assert_eq!(
            store.load().unwrap().selected_theme.as_deref(),
            Some("nord")
        );
        assert_eq!(
            fs::read_dir(store.path().parent().unwrap())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn invalid_root_recovers_explicitly_and_writes_stable_sorted_json() {
        let (directory, store) = store("invalid-root");
        fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        fs::write(store.path(), b"[]").unwrap();
        assert_eq!(store.load(), Err(StateFileError::Invalid));
        store.set_selected_theme("everforest".into()).unwrap();
        let text = fs::read_to_string(store.path()).unwrap();
        assert!(text.contains("\n  \"selected_theme\": \"everforest\"\n"));
        assert!(!text.contains("\\/"));
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn oversized_state_is_rejected_without_unbounded_allocation() {
        let (directory, store) = store("oversized");
        fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        fs::write(
            store.path(),
            format!(r#"{{"future":"{}"}}"#, "x".repeat(MAX_STATE_BYTES as usize)),
        )
        .unwrap();
        assert_eq!(store.load(), Err(StateFileError::Invalid));
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn missing_indicator_reads_as_unsaved_default() {
        let (directory, store) = store("missing-indicator");
        assert_eq!(store.read_indicator(), Ok(None));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn mutation_that_would_exceed_state_limit_preserves_previous_bytes() {
        let (directory, store) = store("write-limit");
        fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        let original = format!(
            r#"{{"future":"{}"}}"#,
            "x".repeat(MAX_STATE_BYTES as usize - 14)
        )
        .into_bytes();
        assert!(original.len() as u64 <= MAX_STATE_BYTES);
        fs::write(store.path(), &original).unwrap();
        assert_eq!(
            store.set_selected_theme("nord".into()),
            Err(StateFileError::Invalid)
        );
        assert_eq!(fs::read(store.path()).unwrap(), original);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn clear_recents_pre_replace_fault_retains_the_complete_prior_state() {
        let (directory, store) = store("clear-fault");
        fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        fs::write(
            store.path(),
            r#"{"future":{"keep":true},"selected_theme":"nord","recent_files":[{"absolute_path":"C:/문서/keep.pdf","last_opened_at":"1"}]}"#,
        )
        .unwrap();
        let original = fs::read(store.path()).unwrap();
        let fault = AtomicWriteFaults {
            fail_before_replace: true,
            ..Default::default()
        };

        assert_eq!(
            store.clear_recents_with_faults(fault),
            Err(StateFileError::Fault)
        );
        assert_eq!(fs::read(store.path()).unwrap(), original);
        assert_eq!(store.load().unwrap().recent_files.len(), 1);
        assert!(store.clear_recents().unwrap());
        let root: Value = serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
        assert!(root["recent_files"].as_array().unwrap().is_empty());
        assert_eq!(root["selected_theme"], "nord");
        assert_eq!(root["future"]["keep"], true);
        fs::remove_dir_all(directory).unwrap();
    }
}

use crate::local_path::{DriveKind, LocalPathPolicy, PathPolicyError};
use crate::pdf_session::TrustedRecentIdentity;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub const MAX_RECENT_DOCUMENTS: usize = 15;
const MAX_PERSISTED_BYTES: u64 = 64 * 1024;
const QUARANTINE_FILE_NAME: &str = "recent.quarantine.json";
const MAX_JSON_NESTING: usize = 32;
const SCHEMA_VERSION: u64 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    #[cfg(windows)]
    volume_serial_number: u32,
    #[cfg(windows)]
    file_index: u64,
    #[cfg(not(windows))]
    device: u64,
    #[cfg(not(windows))]
    inode: u64,
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information)
            .map_err(|_| io::Error::last_os_error())?;
    }
    Ok(FileIdentity {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(windows))]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
fn open_state_file(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        DELETE, FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .access_mode(FILE_GENERIC_READ.0 | DELETE.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .open(path)
}

#[cfg(not(windows))]
fn open_state_file(path: &Path) -> io::Result<File> {
    File::open(path)
}
/// The only recent-document representation intended to cross the renderer boundary.
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
    Io(io::Error),
    RemotePath,
    PathRejected,
    NotPdf,
    MissingRecentId,
    OrdinalExhausted,
}

impl From<io::Error> for RecentStoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for RecentStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Io(_) => "RECENT_STORAGE_FAILED",
            Self::RemotePath => "RECENT_REMOTE_PATH",
            Self::PathRejected => "RECENT_PATH_REJECTED",
            Self::NotPdf => "RECENT_PDF_INVALID",
            Self::MissingRecentId => "RECENT_NOT_FOUND",
            Self::OrdinalExhausted => "RECENT_STORAGE_FAILED",
        })
    }
}
impl std::error::Error for RecentStoreError {}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StoredRecent {
    recent_id: String,
    display_name: String,
    last_opened_ordinal: u64,
    canonical_path: PathBuf,
}

/// Native-only recent document state. Paths are intentionally not exposed by `documents`.
pub struct RecentStore {
    state_path: PathBuf,
    records: Vec<StoredRecent>,
    next_ordinal: u64,
    startup_recovery_needed: bool,
    #[cfg(debug_assertions)]
    before_quarantine: Option<Box<dyn FnOnce() + Send>>,
}

impl RecentStore {
    /// Loads persisted state from one bounded file handle. Any unreadable, invalid, or
    /// unquarantinable state is nonfatal: startup receives an empty store and can publish
    /// path-free recovery evidence.
    pub fn load<P: AsRef<Path>, L: LocalPathPolicy>(
        state_path: P,
        policy: &L,
    ) -> Result<Self, RecentStoreError> {
        Self::load_inner(
            state_path,
            policy,
            #[cfg(debug_assertions)]
            None,
        )
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn load_with_post_check_before_quarantine_hook<P: AsRef<Path>, L: LocalPathPolicy>(
        state_path: P,
        policy: &L,
        before_quarantine: impl FnOnce() + Send + 'static,
    ) -> Result<Self, RecentStoreError> {
        Self::load_inner(state_path, policy, Some(Box::new(before_quarantine)))
    }

    fn load_inner<P: AsRef<Path>, L: LocalPathPolicy>(
        state_path: P,
        policy: &L,
        #[cfg(debug_assertions)] before_quarantine: Option<Box<dyn FnOnce() + Send>>,
    ) -> Result<Self, RecentStoreError> {
        let state_path = state_path.as_ref().to_path_buf();
        let mut store = Self {
            state_path,
            records: Vec::new(),
            next_ordinal: 1,
            startup_recovery_needed: false,
            #[cfg(debug_assertions)]
            before_quarantine,
        };
        let mut file = match open_state_file(&store.state_path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(store),
            Err(_) => {
                store.startup_recovery_needed = true;
                return Ok(store);
            }
        };
        let parsed_identity = match file_identity(&file) {
            Ok(identity) => identity,
            Err(_) => {
                store.startup_recovery_needed = true;
                return Ok(store);
            }
        };
        let mut bytes = Vec::new();
        let read_failed = std::io::Read::by_ref(&mut file)
            .take(MAX_PERSISTED_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err();
        if read_failed || bytes.len() > MAX_PERSISTED_BYTES as usize {
            store.startup_recovery_needed = true;
            let _ = store.quarantine_matching(&file, parsed_identity, &bytes);
            return Ok(store);
        }
        match std::str::from_utf8(&bytes)
            .ok()
            .and_then(|contents| parse_persisted(contents, policy).ok())
        {
            Some((records, next_ordinal)) => {
                store.records = records;
                store.next_ordinal = next_ordinal;
            }
            None => {
                store.startup_recovery_needed = true;
                let _ = store.quarantine_matching(&file, parsed_identity, &bytes);
            }
        }
        Ok(store)
    }

    /// Returns whether startup recovered from unusable durable state exactly once.
    pub fn take_startup_recovery_needed(&mut self) -> bool {
        std::mem::take(&mut self.startup_recovery_needed)
    }

    pub fn documents(&self) -> Vec<RecentDocument> {
        let mut records = self.records.clone();
        records.sort_by(|left, right| {
            right
                .last_opened_ordinal
                .cmp(&left.last_opened_ordinal)
                .then_with(|| left.recent_id.cmp(&right.recent_id))
        });
        records
            .into_iter()
            .map(|record| RecentDocument {
                recent_id: record.recent_id,
                display_name: record.display_name,
            })
            .collect()
    }

    /// Registers a successfully opened PDF after policy-validating its supplied path.
    /// Debug/test-only path registration seam. Production registration must use a retained handle identity.
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn debug_record_opened<L: LocalPathPolicy>(
        &mut self,
        path: &Path,
        policy: &L,
    ) -> Result<RecentDocument, RecentStoreError> {
        self.record_canonical_opened(validate_and_canonicalize(path, policy)?)
    }

    /// Registers and persists an identity derived from an already locality-vetted retained PDF
    /// handle. It deliberately does not resolve the mutable pathname again.
    pub fn record_trusted_opened_and_save(
        &mut self,
        identity: TrustedRecentIdentity,
    ) -> Result<RecentDocument, RecentStoreError> {
        let mut candidate = Self {
            state_path: self.state_path.clone(),
            records: self.records.clone(),
            next_ordinal: self.next_ordinal,
            startup_recovery_needed: self.startup_recovery_needed,
            #[cfg(debug_assertions)]
            before_quarantine: None,
        };
        let document = candidate.record_canonical_opened(normalize_canonical_local_path(
            identity.canonical_path().to_path_buf(),
        )?)?;
        candidate.save()?;
        self.records = candidate.records;
        self.next_ordinal = candidate.next_ordinal;
        Ok(document)
    }

    fn record_canonical_opened(
        &mut self,
        canonical_path: PathBuf,
    ) -> Result<RecentDocument, RecentStoreError> {
        let ordinal = self.take_ordinal()?;
        if let Some(record) = self
            .records
            .iter_mut()
            .find(|record| record.canonical_path == canonical_path)
        {
            record.last_opened_ordinal = ordinal;
            record.display_name =
                safe_display_name(&canonical_path).ok_or(RecentStoreError::NotPdf)?;
            return Ok(to_document(record));
        }

        let record = StoredRecent {
            recent_id: new_recent_id(&self.records),
            display_name: safe_display_name(&canonical_path).ok_or(RecentStoreError::NotPdf)?,
            last_opened_ordinal: ordinal,
            canonical_path,
        };
        if self.records.len() == MAX_RECENT_DOCUMENTS {
            let oldest = self
                .records
                .iter()
                .enumerate()
                .min_by(|(_, left), (_, right)| {
                    left.last_opened_ordinal
                        .cmp(&right.last_opened_ordinal)
                        .then_with(|| left.recent_id.cmp(&right.recent_id))
                })
                .map(|(index, _)| index)
                .expect("non-empty capped recent store");
            self.records.remove(oldest);
        }
        let document = to_document(&record);
        self.records.push(record);
        Ok(document)
    }

    /// Registers and persists an opened PDF without exposing an in-memory update if persistence fails.
    /// Debug/test-only transactional path registration seam.
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn debug_record_opened_and_save<L: LocalPathPolicy>(
        &mut self,
        path: &Path,
        policy: &L,
    ) -> Result<RecentDocument, RecentStoreError> {
        let mut candidate = Self {
            state_path: self.state_path.clone(),
            records: self.records.clone(),
            next_ordinal: self.next_ordinal,
            startup_recovery_needed: self.startup_recovery_needed,
            #[cfg(debug_assertions)]
            before_quarantine: None,
        };
        let document = candidate.debug_record_opened(path, policy)?;
        candidate.save()?;
        self.records = candidate.records;
        self.next_ordinal = candidate.next_ordinal;
        Ok(document)
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

    /// Atomically persists the bounded native state. This file is never a renderer DTO.
    pub fn save(&self) -> Result<(), RecentStoreError> {
        let contents = serialize_persisted(&self.records, self.next_ordinal);
        if contents.len() > MAX_PERSISTED_BYTES as usize {
            return Err(RecentStoreError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "recent state exceeds persisted size limit",
            )));
        }
        let parent = self
            .state_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let temp_path = unique_temp_path(parent);
        let result = (|| -> io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_path)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            drop(file);
            atomic_replace(&temp_path, &self.state_path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        result.map_err(RecentStoreError::Io)
    }

    fn take_ordinal(&mut self) -> Result<u64, RecentStoreError> {
        let ordinal = self.next_ordinal;
        self.next_ordinal = self
            .next_ordinal
            .checked_add(1)
            .ok_or(RecentStoreError::OrdinalExhausted)?;
        Ok(ordinal)
    }
    fn quarantine_matching(
        &mut self,
        parsed_file: &File,
        parsed_identity: FileIdentity,
        bytes: &[u8],
    ) -> Result<(), RecentStoreError> {
        if file_identity(parsed_file)? != parsed_identity {
            return Ok(());
        }

        #[cfg(debug_assertions)]
        if let Some(before_quarantine) = self.before_quarantine.take() {
            before_quarantine();
        }

        let quarantine = self.state_path.with_file_name(QUARANTINE_FILE_NAME);
        write_quarantine_bytes(&quarantine, bytes)?;
        #[cfg(windows)]
        delete_file_handle(parsed_file)?;
        #[cfg(not(windows))]
        {
            let current = match File::open(&self.state_path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
            };
            if file_identity(&current)? == parsed_identity {
                fs::remove_file(&self.state_path)?;
            }
        }
        Ok(())
    }
}

fn write_quarantine_bytes(quarantine: &Path, bytes: &[u8]) -> Result<(), RecentStoreError> {
    let parent = quarantine
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temp_path = unique_temp_path(parent);
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temp_path, quarantine)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result.map_err(RecentStoreError::Io)
}

#[cfg(windows)]
fn delete_file_handle(file: &File) -> Result<(), RecentStoreError> {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };

    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            u32::try_from(size_of::<FILE_DISPOSITION_INFO>())
                .expect("FILE_DISPOSITION_INFO fits u32"),
        )
        .map_err(|_| RecentStoreError::Io(io::Error::last_os_error()))?;
    }
    Ok(())
}
fn to_document(record: &StoredRecent) -> RecentDocument {
    RecentDocument {
        recent_id: record.recent_id.clone(),
        display_name: record.display_name.clone(),
    }
}

fn validate_and_canonicalize<L: LocalPathPolicy>(
    path: &Path,
    policy: &L,
) -> Result<PathBuf, RecentStoreError> {
    if safe_display_name(path).is_none() {
        return Err(RecentStoreError::NotPdf);
    }
    policy.validate_preopen(path).map_err(map_policy_error)?;
    match policy.classify(path).map_err(map_policy_error)? {
        DriveKind::Fixed | DriveKind::Removable => {}
        DriveKind::Remote => return Err(RecentStoreError::RemotePath),
    }
    let canonical = fs::canonicalize(path).map_err(RecentStoreError::Io)?;
    let canonical = normalize_canonical_local_path(canonical)?;
    policy
        .validate_preopen(&canonical)
        .map_err(map_policy_error)?;
    match policy.classify(&canonical).map_err(map_policy_error)? {
        DriveKind::Fixed | DriveKind::Removable => Ok(canonical),
        DriveKind::Remote => Err(RecentStoreError::RemotePath),
    }
}

#[cfg(windows)]
fn normalize_canonical_local_path(path: PathBuf) -> Result<PathBuf, RecentStoreError> {
    let path = path.to_string_lossy();
    let lower = path.to_ascii_lowercase();
    if lower.starts_with(r"\\?\unc\") {
        return Err(RecentStoreError::RemotePath);
    }
    Ok(path
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(path.as_ref())))
}

#[cfg(not(windows))]
fn normalize_canonical_local_path(path: PathBuf) -> Result<PathBuf, RecentStoreError> {
    Ok(path)
}

fn map_policy_error(error: PathPolicyError) -> RecentStoreError {
    match error {
        PathPolicyError::RemotePath => RecentStoreError::RemotePath,
        PathPolicyError::PathRejected => RecentStoreError::PathRejected,
    }
}

fn safe_display_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if name.is_empty()
        || name.chars().any(char::is_control)
        || !name.to_ascii_lowercase().ends_with(".pdf")
    {
        return None;
    }
    Some(name.to_owned())
}

fn new_recent_id(records: &[StoredRecent]) -> String {
    loop {
        let id = format!("{:032x}", rand::random::<u128>());
        if !records.iter().any(|record| record.recent_id == id) {
            return id;
        }
    }
}
fn unique_temp_path(parent: &Path) -> PathBuf {
    loop {
        let path = parent.join(format!(".recent-{:032x}.tmp", rand::random::<u128>()));
        if !path.exists() {
            return path;
        }
    }
}
#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|_| io::Error::last_os_error())
    }
}
#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}
fn serialize_persisted(records: &[StoredRecent], next_ordinal: u64) -> String {
    let mut text = format!(
        "{{\"schemaVersion\":{SCHEMA_VERSION},\"nextOrdinal\":{next_ordinal},\"records\":["
    );
    for (index, record) in records.iter().enumerate() {
        if index != 0 {
            text.push(',');
        }
        text.push_str("{\"recentId\":");
        push_json_string(&mut text, &record.recent_id);
        text.push_str(",\"displayName\":");
        push_json_string(&mut text, &record.display_name);
        text.push_str(",\"lastOpenedOrdinal\":");
        text.push_str(&record.last_opened_ordinal.to_string());
        text.push_str(",\"path\":");
        push_json_string(&mut text, &record.canonical_path.to_string_lossy());
        text.push('}');
    }
    text.push_str("]}");
    text
}

fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => {
                output.push_str(&format!("\\u{:04x}", character as u32))
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

#[derive(Debug, Eq, PartialEq)]
enum Json {
    Object(BTreeMap<String, Json>),
    Array(Vec<Json>),
    String(String),
    Number(u64),
}

fn parse_persisted(
    contents: &str,
    policy: &impl LocalPathPolicy,
) -> Result<(Vec<StoredRecent>, u64), ()> {
    let mut parser = JsonParser::new(contents);
    let root = parser.value(MAX_JSON_NESTING)?;
    parser.whitespace();
    if !parser.done() {
        return Err(());
    }
    let mut root = object(root)?;
    if root.remove("schemaVersion") != Some(Json::Number(SCHEMA_VERSION)) {
        return Err(());
    }
    let next_ordinal = number(root.remove("nextOrdinal").ok_or(())?)?;
    let entries = array(root.remove("records").ok_or(())?)?;
    if !root.is_empty() || entries.len() > MAX_RECENT_DOCUMENTS {
        return Err(());
    }
    let mut records = Vec::with_capacity(entries.len());
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut maximum = 0;
    for entry in entries {
        let mut entry = object(entry)?;
        let recent_id = string(entry.remove("recentId").ok_or(())?)?;
        let display_name = string(entry.remove("displayName").ok_or(())?)?;
        let last_opened_ordinal = number(entry.remove("lastOpenedOrdinal").ok_or(())?)?;
        let path = PathBuf::from(string(entry.remove("path").ok_or(())?)?);
        if !entry.is_empty()
            || !valid_recent_id(&recent_id)
            || last_opened_ordinal == 0
            || safe_display_name(&path).as_deref() != Some(display_name.as_str())
        {
            return Err(());
        }
        policy.validate_preopen(&path).map_err(|_| ())?;
        match policy.classify(&path).map_err(|_| ())? {
            DriveKind::Fixed | DriveKind::Removable => {}
            DriveKind::Remote => return Err(()),
        }
        if !ids.insert(recent_id.clone()) || !paths.insert(path.clone()) {
            return Err(());
        }
        maximum = maximum.max(last_opened_ordinal);
        records.push(StoredRecent {
            recent_id,
            display_name,
            last_opened_ordinal,
            canonical_path: path,
        });
    }
    if next_ordinal == 0 || next_ordinal <= maximum {
        return Err(());
    }
    Ok((records, next_ordinal))
}
fn object(value: Json) -> Result<BTreeMap<String, Json>, ()> {
    if let Json::Object(value) = value {
        Ok(value)
    } else {
        Err(())
    }
}
fn array(value: Json) -> Result<Vec<Json>, ()> {
    if let Json::Array(value) = value {
        Ok(value)
    } else {
        Err(())
    }
}
fn string(value: Json) -> Result<String, ()> {
    if let Json::String(value) = value {
        Ok(value)
    } else {
        Err(())
    }
}
fn number(value: Json) -> Result<u64, ()> {
    if let Json::Number(value) = value {
        Ok(value)
    } else {
        Err(())
    }
}
fn valid_recent_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

struct JsonParser<'a> {
    input: &'a [u8],
    index: usize,
}
impl<'a> JsonParser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            input: input.as_bytes(),
            index: 0,
        }
    }
    fn done(&self) -> bool {
        self.index == self.input.len()
    }
    fn whitespace(&mut self) {
        while self
            .input
            .get(self.index)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.index += 1;
        }
    }
    fn value(&mut self, remaining_depth: usize) -> Result<Json, ()> {
        self.whitespace();
        match self.input.get(self.index) {
            Some(b'{') => self.object(remaining_depth),
            Some(b'[') => self.array(remaining_depth),
            Some(b'\"') => self.string().map(Json::String),
            Some(b'0'..=b'9') => self.number().map(Json::Number),
            _ => Err(()),
        }
    }
    fn object(&mut self, remaining_depth: usize) -> Result<Json, ()> {
        if remaining_depth == 0 {
            return Err(());
        }
        self.index += 1;
        self.whitespace();
        let mut object = BTreeMap::new();
        if self.consume(b'}') {
            return Ok(Json::Object(object));
        }
        loop {
            let key = self.string()?;
            self.whitespace();
            if !self.consume(b':') {
                return Err(());
            }
            let value = self.value(remaining_depth - 1)?;
            if object.insert(key, value).is_some() {
                return Err(());
            }
            self.whitespace();
            if self.consume(b'}') {
                return Ok(Json::Object(object));
            }
            if !self.consume(b',') {
                return Err(());
            }
            self.whitespace();
        }
    }
    fn array(&mut self, remaining_depth: usize) -> Result<Json, ()> {
        if remaining_depth == 0 {
            return Err(());
        }
        self.index += 1;
        self.whitespace();
        let mut array = Vec::new();
        if self.consume(b']') {
            return Ok(Json::Array(array));
        }
        loop {
            array.push(self.value(remaining_depth - 1)?);
            self.whitespace();
            if self.consume(b']') {
                return Ok(Json::Array(array));
            }
            if !self.consume(b',') {
                return Err(());
            }
        }
    }
    fn string(&mut self) -> Result<String, ()> {
        if !self.consume(b'\"') {
            return Err(());
        }
        let mut output = String::new();
        loop {
            let byte = *self.input.get(self.index).ok_or(())?;
            self.index += 1;
            match byte {
                b'\"' => return Ok(output),
                b'\\' => {
                    let escaped = *self.input.get(self.index).ok_or(())?;
                    self.index += 1;
                    match escaped {
                        b'\"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => {
                            let code = self.hex4()?;
                            let character = char::from_u32(code).ok_or(())?;
                            output.push(character);
                        }
                        _ => return Err(()),
                    }
                }
                0..=0x1f => return Err(()),
                byte if byte < 0x80 => output.push(byte as char),
                _ => {
                    let remaining =
                        std::str::from_utf8(&self.input[self.index - 1..]).map_err(|_| ())?;
                    let character = remaining.chars().next().ok_or(())?;
                    output.push(character);
                    self.index += character.len_utf8() - 1;
                }
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, ()> {
        let digits = self.input.get(self.index..self.index + 4).ok_or(())?;
        self.index += 4;
        std::str::from_utf8(digits)
            .map_err(|_| ())?
            .chars()
            .try_fold(0, |number, digit| {
                digit
                    .to_digit(16)
                    .map(|digit| number * 16 + digit)
                    .ok_or(())
            })
    }
    fn number(&mut self) -> Result<u64, ()> {
        let start = self.index;
        while self.input.get(self.index).is_some_and(u8::is_ascii_digit) {
            self.index += 1;
        }
        if start == self.index || (self.index - start > 1 && self.input[start] == b'0') {
            return Err(());
        }
        std::str::from_utf8(&self.input[start..self.index])
            .map_err(|_| ())?
            .parse()
            .map_err(|_| ())
    }
    fn consume(&mut self, byte: u8) -> bool {
        if self.input.get(self.index) == Some(&byte) {
            self.index += 1;
            true
        } else {
            false
        }
    }
}

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const SCHEMA_VERSION: u64 = 1;
const MAX_PERSISTED_BYTES: u64 = 1024;
const QUARANTINE_FILE_NAME: &str = "theme-state.quarantine.json";
const TEMP_PREFIX: &str = ".theme-state-";
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
const TEMP_SUFFIX: &str = ".tmp";
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeId {
    TokyoNight,
    GruvboxDark,
    SolarizedDark,
    Dracula,
    Everforest,
    CatppuccinLatte,
}

impl ThemeId {
    pub const DEFAULT: Self = Self::TokyoNight;

    pub fn from_id(value: &str) -> Option<Self> {
        Some(match value {
            "tokyo-night" => Self::TokyoNight,
            "gruvbox-dark" => Self::GruvboxDark,
            "solarized-dark" => Self::SolarizedDark,
            "dracula" => Self::Dracula,
            "everforest" => Self::Everforest,
            "catppuccin-latte" => Self::CatppuccinLatte,
            _ => return None,
        })
    }

    pub const fn as_id(self) -> &'static str {
        match self {
            Self::TokyoNight => "tokyo-night",
            Self::GruvboxDark => "gruvbox-dark",
            Self::SolarizedDark => "solarized-dark",
            Self::Dracula => "dracula",
            Self::Everforest => "everforest",
            Self::CatppuccinLatte => "catppuccin-latte",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeState {
    theme_id: ThemeId,
    revision: u64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag")]
pub enum ThemeStateError {
    #[serde(rename = "THEME_STATE_CONFLICT")]
    Conflict,
    #[serde(rename = "THEME_STATE_STORAGE_FAILED")]
    Storage,
}
impl ThemeState {
    pub const fn theme_id(self) -> ThemeId {
        self.theme_id
    }

    pub const fn revision(self) -> u64 {
        self.revision
    }
}

impl fmt::Display for ThemeStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Conflict => "THEME_STATE_CONFLICT",
            Self::Storage => "THEME_STATE_STORAGE_FAILED",
        })
    }
}

impl std::error::Error for ThemeStateError {}

#[derive(Clone)]
pub struct ThemeStateManager {
    inner: Arc<Mutex<ThemeStateInner>>,
}

struct ThemeStateInner {
    state_path: PathBuf,
    current: ThemeState,
    startup_recovery_needed: bool,
}

impl ThemeStateManager {
    /// Loads one bounded, native-owned state file. Missing or invalid state always starts from
    /// the deterministic default; invalid bytes are moved to the fixed quarantine file when able.
    pub fn load<P: AsRef<Path>>(state_path: P) -> Self {
        let state_path = state_path.as_ref().to_path_buf();
        remove_interrupted_temps(&state_path);
        let (current, startup_recovery_needed) = load_state(&state_path);
        Self {
            inner: Arc::new(Mutex::new(ThemeStateInner {
                state_path,
                current,
                startup_recovery_needed,
            })),
        }
    }

    pub fn current(&self) -> ThemeState {
        self.inner
            .lock()
            .expect("theme state lock poisoned")
            .current
    }

    /// Persists the candidate before exposing it as current. Calls are serialized by this manager.
    pub fn commit(
        &self,
        theme_id: ThemeId,
        base_revision: u64,
    ) -> Result<ThemeState, ThemeStateError> {
        let mut inner = self.inner.lock().expect("theme state lock poisoned");
        if base_revision != inner.current.revision {
            return Err(ThemeStateError::Conflict);
        }
        let revision = inner
            .current
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_REVISION)
            .ok_or(ThemeStateError::Storage)?;
        let candidate = ThemeState { theme_id, revision };
        persist_state(&inner.state_path, candidate).map_err(|_| ThemeStateError::Storage)?;
        inner.current = candidate;
        Ok(candidate)
    }

    /// Returns recovery evidence once without exposing corrupt bytes or filesystem details.
    pub fn take_startup_recovery_needed(&self) -> bool {
        let mut inner = self.inner.lock().expect("theme state lock poisoned");
        std::mem::take(&mut inner.startup_recovery_needed)
    }
}

fn default_state() -> ThemeState {
    ThemeState {
        theme_id: ThemeId::DEFAULT,
        revision: 0,
    }
}

fn load_state(path: &Path) -> (ThemeState, bool) {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return (default_state(), false),
        Err(_) => return (default_state(), true),
    };
    let mut bytes = Vec::new();
    let read_failed = std::io::Read::by_ref(&mut file)
        .take(MAX_PERSISTED_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err();
    let parsed = (!read_failed && bytes.len() <= MAX_PERSISTED_BYTES as usize)
        .then(|| std::str::from_utf8(&bytes).ok().and_then(parse_persisted))
        .flatten();
    match parsed {
        Some(state) => (state, false),
        None => {
            let _ = quarantine(path, &bytes);
            (default_state(), true)
        }
    }
}

fn quarantine(state_path: &Path, bytes: &[u8]) -> io::Result<()> {
    let quarantine = state_path.with_file_name(QUARANTINE_FILE_NAME);
    write_atomically(&quarantine, bytes)?;
    fs::remove_file(state_path)
}

fn persist_state(path: &Path, state: ThemeState) -> io::Result<()> {
    let contents = format!(
        r#"{{"schemaVersion":{SCHEMA_VERSION},"themeId":"{}","revision":{}}}"#,
        state.theme_id.as_id(),
        state.revision
    );
    if contents.len() > MAX_PERSISTED_BYTES as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "theme state too large",
        ));
    }
    write_atomically(path, contents.as_bytes())
}

fn write_atomically(destination: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary = unique_temp_path(parent);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn unique_temp_path(parent: &Path) -> PathBuf {
    loop {
        let candidate = parent.join(format!(
            "{TEMP_PREFIX}{:032x}{TEMP_SUFFIX}",
            rand::random::<u128>()
        ));
        if !candidate.exists() {
            return candidate;
        }
    }
}

fn remove_interrupted_temps(state_path: &Path) {
    let Some(parent) = state_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(TEMP_PREFIX) && name.ends_with(TEMP_SUFFIX) {
            let _ = fs::remove_file(entry.path());
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

fn parse_persisted(contents: &str) -> Option<ThemeState> {
    let mut parser = StateParser::new(contents);
    parser.whitespace();
    parser.consume(b'{')?;
    let mut schema_version = None;
    let mut theme_id = None;
    let mut revision = None;
    loop {
        parser.whitespace();
        if parser.consume(b'}').is_some() {
            break;
        }
        let key = parser.string()?;
        parser.whitespace();
        parser.consume(b':')?;
        parser.whitespace();
        match key.as_str() {
            "schemaVersion" if schema_version.is_none() => schema_version = Some(parser.number()?),
            "themeId" if theme_id.is_none() => {
                theme_id = Some(ThemeId::from_id(&parser.string()?)?)
            }
            "revision" if revision.is_none() => {
                let parsed = parser.number()?;
                if parsed > MAX_SAFE_REVISION {
                    return None;
                }
                revision = Some(parsed);
            }
            _ => return None,
        }
        parser.whitespace();
        if parser.consume(b'}').is_some() {
            break;
        }
        parser.consume(b',')?;
        parser.whitespace();
        if parser.input.get(parser.index) == Some(&b'}') {
            return None;
        }
    }
    parser.whitespace();
    if !parser.done() || schema_version != Some(SCHEMA_VERSION) {
        return None;
    }
    Some(ThemeState {
        theme_id: theme_id?,
        revision: revision?,
    })
}

struct StateParser<'a> {
    input: &'a [u8],
    index: usize,
}

impl<'a> StateParser<'a> {
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

    fn consume(&mut self, byte: u8) -> Option<()> {
        if self.input.get(self.index) == Some(&byte) {
            self.index += 1;
            Some(())
        } else {
            None
        }
    }

    fn string(&mut self) -> Option<String> {
        self.consume(b'"')?;
        let start = self.index;
        while let Some(&byte) = self.input.get(self.index) {
            match byte {
                b'"' => {
                    let value = std::str::from_utf8(&self.input[start..self.index])
                        .ok()?
                        .to_owned();
                    self.index += 1;
                    return Some(value);
                }
                b'\\' | 0..=0x1f | 0x80..=u8::MAX => return None,
                _ => self.index += 1,
            }
        }
        None
    }

    fn number(&mut self) -> Option<u64> {
        let start = self.index;
        while self.input.get(self.index).is_some_and(u8::is_ascii_digit) {
            self.index += 1;
        }
        if start == self.index || (self.index - start > 1 && self.input[start] == b'0') {
            return None;
        }
        std::str::from_utf8(&self.input[start..self.index])
            .ok()?
            .parse()
            .ok()
    }
}

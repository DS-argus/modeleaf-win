//! Bounded local diagnostics. This module has no network transport and accepts no caller path.

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const MAX_DIAGNOSTIC_BYTES: usize = 1_024;
pub const MAX_LOG_BYTES: u64 = 8 * 1_024;
pub const MAX_LOG_FILES: usize = 3;
const LOG_FILE_NAME: &str = "diagnostics.jsonl";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticEventName {
    Application,
    PdfSession,
    PdfRender,
    ExternalLink,
    ThemeState,
    Quit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticOutcome {
    Success,
    Rejected,
    Failure,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticTag {
    None,
    ValidationRejected,
    LocalityRejected,
    Conflict,
    IoFailure,
    Timeout,
    Redacted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticStorageClass {
    Local,
}

/// The complete renderer-to-native diagnostic contract. Unknown fields are denied by serde,
/// and there is deliberately no message, map, path, or arbitrary value field.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticEvent {
    pub event: DiagnosticEventName,
    pub outcome: DiagnosticOutcome,
    pub tag: DiagnosticTag,
    pub storage_class: DiagnosticStorageClass,
    pub epoch_ms: u64,
    pub app_version: String,
    pub runtime_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticError {
    InvalidEvent,
    Io,
}

impl std::fmt::Display for DiagnosticError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidEvent => "DIAGNOSTIC_INVALID_EVENT",
            Self::Io => "DIAGNOSTIC_STORAGE_FAILED",
        })
    }
}

impl std::error::Error for DiagnosticError {}

impl From<io::Error> for DiagnosticError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

/// Native-only local log. `app_data_directory` is selected by composition from the application
/// data directory; diagnostics callers only provide a `DiagnosticEvent`.
pub struct DiagnosticLog {
    write_lock: std::sync::Mutex<()>,
    directory: PathBuf,
}

impl DiagnosticLog {
    pub fn open(app_data_directory: impl AsRef<Path>) -> Result<Self, DiagnosticError> {
        fs::create_dir_all(app_data_directory.as_ref())?;
        Ok(Self {
            directory: app_data_directory.as_ref().to_path_buf(),
            write_lock: std::sync::Mutex::new(()),
        })
    }

    pub fn record(&self, event: &DiagnosticEvent) -> Result<(), DiagnosticError> {
        validate(event)?;
        let _guard = self.write_lock.lock().map_err(|_| DiagnosticError::Io)?;
        let line = encode(event);
        if line.len() > MAX_DIAGNOSTIC_BYTES {
            return Err(DiagnosticError::InvalidEvent);
        }
        let active = self.active_path();
        let current_length = fs::metadata(&active)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current_length > 0 && current_length.saturating_add(line.len() as u64) > MAX_LOG_BYTES {
            self.rotate()?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.active_path())?;
        file.write_all(line.as_bytes())?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    }

    fn active_path(&self) -> PathBuf {
        self.directory.join(LOG_FILE_NAME)
    }

    fn rotated_path(&self, index: usize) -> PathBuf {
        self.directory.join(format!("{LOG_FILE_NAME}.{index}"))
    }

    fn rotate(&self) -> Result<(), DiagnosticError> {
        let oldest = self.rotated_path(MAX_LOG_FILES - 1);
        if oldest.exists() {
            fs::remove_file(oldest)?;
        }
        for index in (1..MAX_LOG_FILES - 1).rev() {
            let source = self.rotated_path(index);
            if source.exists() {
                fs::rename(source, self.rotated_path(index + 1))?;
            }
        }
        let active = self.active_path();
        if active.exists() {
            fs::rename(active, self.rotated_path(1))?;
        }
        sync_directory(&self.directory)?;
        Ok(())
    }
}

fn validate(event: &DiagnosticEvent) -> Result<(), DiagnosticError> {
    if event.epoch_ms > 9_999_999_999_999
        || event.page.is_some_and(|value| value > 1_000_000)
        || event.count.is_some_and(|value| value > 1_000_000)
        || event.duration_ms.is_some_and(|value| value > 86_400_000)
        || event
            .generation
            .is_some_and(|value| value > 9_007_199_254_740_991)
        || !valid_version(&event.app_version)
        || !valid_version(&event.runtime_version)
        || !event.trace_id.as_deref().map_or(true, valid_id)
        || !event.request_id.as_deref().map_or(true, valid_id)
        || !event.session_id.as_deref().map_or(true, valid_id)
    {
        return Err(DiagnosticError::InvalidEvent);
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_version(value: &str) -> bool {
    if value.len() > 32 || value.bytes().any(|byte| byte.is_ascii_control()) {
        return false;
    }
    let mut parts = value.splitn(4, '.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch_and_suffix) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || !digits(major) || !digits(minor) {
        return false;
    }
    let (patch, suffix) = match patch_and_suffix.find(['-', '.']) {
        Some(index) => (
            &patch_and_suffix[..index],
            Some(&patch_and_suffix[index + 1..]),
        ),
        None => (patch_and_suffix, None),
    };
    digits(patch)
        && suffix.map_or(true, |text| {
            !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}
fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn encode(event: &DiagnosticEvent) -> String {
    let mut output = format!(
        "{{\"event\":\"{}\",\"outcome\":\"{}\",\"tag\":\"{}\",\"storageClass\":\"LOCAL\",\"epochMs\":{},\"appVersion\":\"{}\",\"runtimeVersion\":\"{}\"",
        event_name(event.event), outcome(event.outcome), tag(event.tag), event.epoch_ms, event.app_version, event.runtime_version,
    );
    optional_string(&mut output, "traceId", &event.trace_id);
    optional_string(&mut output, "requestId", &event.request_id);
    optional_string(&mut output, "sessionId", &event.session_id);
    optional_number(&mut output, "page", event.page.map(u64::from));
    optional_number(&mut output, "count", event.count.map(u64::from));
    optional_number(&mut output, "durationMs", event.duration_ms.map(u64::from));
    optional_number(&mut output, "generation", event.generation);
    output.push_str("}\n");
    output
}

fn optional_string(output: &mut String, name: &str, value: &Option<String>) {
    if let Some(value) = value {
        output.push_str(",\"");
        output.push_str(name);
        output.push_str("\":\"");
        output.push_str(value);
        output.push('"');
    }
}
fn optional_number(output: &mut String, name: &str, value: Option<u64>) {
    if let Some(value) = value {
        output.push_str(",\"");
        output.push_str(name);
        output.push_str("\":");
        output.push_str(&value.to_string());
    }
}

fn event_name(value: DiagnosticEventName) -> &'static str {
    match value {
        DiagnosticEventName::Application => "APPLICATION",
        DiagnosticEventName::PdfSession => "PDF_SESSION",
        DiagnosticEventName::PdfRender => "PDF_RENDER",
        DiagnosticEventName::ExternalLink => "EXTERNAL_LINK",
        DiagnosticEventName::ThemeState => "THEME_STATE",
        DiagnosticEventName::Quit => "QUIT",
    }
}
fn outcome(value: DiagnosticOutcome) -> &'static str {
    match value {
        DiagnosticOutcome::Success => "SUCCESS",
        DiagnosticOutcome::Rejected => "REJECTED",
        DiagnosticOutcome::Failure => "FAILURE",
        DiagnosticOutcome::Cancelled => "CANCELLED",
    }
}
fn tag(value: DiagnosticTag) -> &'static str {
    match value {
        DiagnosticTag::None => "NONE",
        DiagnosticTag::ValidationRejected => "VALIDATION_REJECTED",
        DiagnosticTag::LocalityRejected => "LOCALITY_REJECTED",
        DiagnosticTag::Conflict => "CONFLICT",
        DiagnosticTag::IoFailure => "IO_FAILURE",
        DiagnosticTag::Timeout => "TIMEOUT",
        DiagnosticTag::Redacted => "REDACTED",
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), DiagnosticError> {
    File::open(path)?.sync_all()?;
    Ok(())
}
#[cfg(not(unix))]
fn sync_directory(_: &Path) -> Result<(), DiagnosticError> {
    Ok(())
}

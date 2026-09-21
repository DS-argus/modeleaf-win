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
    Deferred,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "deserialize_present")]
    pub stage: Option<PdfDiagnosticStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "deserialize_present")]
    pub os_code: Option<i32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub renderer_code: Option<PdfRendererCode>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub http_status: Option<u16>,
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
    if !valid_native_observation(event) {
        return Err(DiagnosticError::InvalidEvent);
    }
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
    if let Some(code) = event.renderer_code {
        output.push_str(",\"rendererCode\":");
        output.push_str(&serde_json::to_string(&code).expect("finite renderer code"));
    }
    optional_number(&mut output, "httpStatus", event.http_status.map(u64::from));
    if let Some(stage) = event.stage {
        output.push_str(",\"stage\":");
        output.push_str(&serde_json::to_string(&stage).expect("finite diagnostic stage"));
    }
    if let Some(code) = event.os_code {
        output.push_str(&format!(",\"osCode\":{code}"));
    }
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
        DiagnosticTag::Deferred => "DEFERRED",
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

/// Native observed operation, never a path or caller-controlled message.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PdfDiagnosticStage {
    Open,
    OpenMetadata,
    OpenModified,
    OpenFileKind,
    OpenHeaderRead,
    OpenHeaderValidate,
    OpenRewind,
    RangeBeforeMetadata,
    RangeBeforeModified,
    RangeBeforeFileKind,
    RangeBeforeValidate,
    RangeSeek,
    RangeRead,
    RangeAfterMetadata,
    RangeAfterModified,
    RangeAfterFileKind,
    RangeAfterValidate,
}

impl PdfDiagnosticStage {
    fn classification(self) -> (DiagnosticOutcome, DiagnosticTag) {
        use PdfDiagnosticStage::*;
        match self {
            OpenFileKind | OpenHeaderValidate | RangeBeforeFileKind | RangeAfterFileKind => (
                DiagnosticOutcome::Rejected,
                DiagnosticTag::ValidationRejected,
            ),
            RangeBeforeValidate | RangeAfterValidate => {
                (DiagnosticOutcome::Failure, DiagnosticTag::Conflict)
            }
            _ => (DiagnosticOutcome::Failure, DiagnosticTag::IoFailure),
        }
    }
}

fn valid_native_observation(event: &DiagnosticEvent) -> bool {
    if let Some(code) = event.renderer_code {
        let failure = PdfRendererFailure {
            code,
            http_status: event.http_status,
        };
        let (outcome, tag) = code.classification();
        return failure.validate().is_ok()
            && event.event == DiagnosticEventName::PdfRender
            && event.stage.is_none()
            && event.os_code.is_none()
            && event.outcome == outcome
            && event.tag == tag;
    }
    if event.http_status.is_some() {
        return false;
    }
    let Some(stage) = event.stage else {
        return event.os_code.is_none();
    };
    let (outcome, tag) = stage.classification();
    event.event == DiagnosticEventName::PdfSession
        && event.outcome == outcome
        && event.tag == tag
        && (tag == DiagnosticTag::IoFailure || event.os_code.is_none())
}

/// Renderer ingress cannot claim native evidence, even if the serialized event is valid.
pub fn validate_renderer_event(event: &DiagnosticEvent) -> Result<(), DiagnosticError> {
    if event.stage.is_some()
        || event.os_code.is_some()
        || event.renderer_code.is_some()
        || event.http_status.is_some()
    {
        return Err(DiagnosticError::InvalidEvent);
    }
    validate(event)
}

const MAX_PDF_FAILURE_QUEUE: usize = 32;

#[derive(Clone, Copy)]
struct PdfFailure {
    stage: PdfDiagnosticStage,
    os_code: Option<i32>,
    epoch_ms: u64,
}

impl PdfFailure {
    fn event(self) -> DiagnosticEvent {
        let (outcome, tag) = self.stage.classification();
        DiagnosticEvent {
            event: DiagnosticEventName::PdfSession,
            outcome,
            tag,
            storage_class: DiagnosticStorageClass::Local,
            epoch_ms: self.epoch_ms,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            runtime_version: "0.0.0".to_owned(),
            trace_id: None,
            request_id: None,
            session_id: None,
            page: None,
            count: None,
            duration_ms: None,
            generation: None,
            stage: Some(self.stage),
            os_code: self.os_code,
            renderer_code: None,
            http_status: None,
        }
    }
}

/// One worker, at most 32 pending failures. Full/disconnected queues drop evidence, not PDF work.
/// No persistence guarantee: sink errors and shutdown may lose observations.
pub(crate) struct NativePdfDiagnostics {
    sender: std::sync::mpsc::SyncSender<DiagnosticEvent>,
    counters: std::sync::Arc<PdfDiagnosticCounters>,
}

impl NativePdfDiagnostics {
    pub(crate) fn new(
        sink: impl Fn(&DiagnosticEvent) -> Result<(), DiagnosticError> + Send + 'static,
    ) -> io::Result<Self> {
        let (sender, receiver) =
            std::sync::mpsc::sync_channel::<DiagnosticEvent>(MAX_PDF_FAILURE_QUEUE);
        let counters = std::sync::Arc::new(PdfDiagnosticCounters::default());
        counters
            .running
            .store(true, std::sync::atomic::Ordering::Release);
        let worker = std::sync::Arc::clone(&counters);
        std::thread::Builder::new()
            .name("modeleaf-pdf-diagnostics".into())
            .spawn(move || {
                let guard = PdfDiagnosticWorkerGuard(worker);
                while let Ok(event) = receiver.recv() {
                    if sink(&event).is_err() {
                        increment(&guard.0.write_failures);
                    }
                }
            })?;
        Ok(Self { sender, counters })
    }

    fn submit(&self, event: DiagnosticEvent) -> PdfDiagnosticReceipt {
        let delivery = match self.sender.try_send(event) {
            Ok(()) => PdfDiagnosticDelivery::Queued,
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                increment(&self.counters.dropped);
                PdfDiagnosticDelivery::Dropped
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                increment(&self.counters.dropped);
                PdfDiagnosticDelivery::Unavailable
            }
        };
        PdfDiagnosticReceipt {
            delivery,
            worker: if self
                .counters
                .running
                .load(std::sync::atomic::Ordering::Acquire)
            {
                PdfDiagnosticWorker::Running
            } else {
                PdfDiagnosticWorker::Stopped
            },
            dropped: Some(
                self.counters
                    .dropped
                    .load(std::sync::atomic::Ordering::Relaxed),
            ),
            write_failures: Some(
                self.counters
                    .write_failures
                    .load(std::sync::atomic::Ordering::Relaxed),
            ),
        }
    }
    pub(crate) fn report_renderer(
        &self,
        failure: &PdfRendererFailure,
    ) -> Result<PdfDiagnosticReceipt, DiagnosticError> {
        failure.validate()?;
        Ok(self.submit(failure.event()))
    }
}
/// Declare before PDF admission/locks so drop queues the observation after their release.
/// It records an observed operation failure even if owner invalidation replaces its public result.
pub(crate) struct PdfFailureObservation<'a> {
    sink: Option<&'a NativePdfDiagnostics>,
    failure: std::cell::Cell<Option<PdfFailure>>,
}

impl<'a> PdfFailureObservation<'a> {
    pub(crate) fn new(sink: Option<&'a NativePdfDiagnostics>) -> Self {
        Self {
            sink,
            failure: std::cell::Cell::new(None),
        }
    }

    pub(crate) fn capture(&self, stage: PdfDiagnosticStage, error: Option<&io::Error>) {
        if self.failure.get().is_some() {
            return;
        }
        let os_code = if stage.classification().1 == DiagnosticTag::IoFailure {
            error.and_then(io::Error::raw_os_error)
        } else {
            None
        };
        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        self.failure.set(Some(PdfFailure {
            stage,
            os_code,
            epoch_ms,
        }));
    }
}

impl Drop for PdfFailureObservation<'_> {
    fn drop(&mut self) {
        if let (Some(sink), Some(failure)) = (self.sink, self.failure.get()) {
            let _ = sink.submit(failure.event());
        }
    }
}

fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod pdf_failure_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn failure() -> PdfFailure {
        PdfFailure {
            stage: PdfDiagnosticStage::RangeRead,
            os_code: Some(5),
            epoch_ms: 1,
        }
    }

    #[test]
    fn shared_stage_matrix_round_trips_and_rejects_incompatible_combinations() {
        let matrix: Vec<(PdfDiagnosticStage, DiagnosticOutcome, DiagnosticTag)> =
            serde_json::from_str(include_str!(
                "../../tests/fixtures/pdfDiagnosticStages.json"
            ))
            .unwrap();
        let outcomes = [
            DiagnosticOutcome::Success,
            DiagnosticOutcome::Rejected,
            DiagnosticOutcome::Failure,
            DiagnosticOutcome::Cancelled,
        ];
        let tags = [
            DiagnosticTag::None,
            DiagnosticTag::ValidationRejected,
            DiagnosticTag::LocalityRejected,
            DiagnosticTag::Conflict,
            DiagnosticTag::IoFailure,
            DiagnosticTag::Timeout,
            DiagnosticTag::Deferred,
            DiagnosticTag::Redacted,
        ];
        let events = [
            DiagnosticEventName::Application,
            DiagnosticEventName::PdfSession,
            DiagnosticEventName::PdfRender,
            DiagnosticEventName::ExternalLink,
            DiagnosticEventName::ThemeState,
            DiagnosticEventName::Quit,
        ];
        for (stage, outcome, tag) in matrix {
            let event = PdfFailure {
                stage,
                os_code: None,
                ..failure()
            }
            .event();
            assert_eq!((event.outcome, event.tag), (outcome, tag));
            assert!(validate(&event).is_ok());
            assert!(validate_renderer_event(&event).is_err());
            for code in [
                None,
                Some(i32::MIN),
                Some(-1),
                Some(0),
                Some(5),
                Some(i32::MAX),
            ] {
                let mut candidate = event.clone();
                candidate.os_code = code;
                assert_eq!(
                    validate(&candidate).is_ok(),
                    code.is_none() || tag == DiagnosticTag::IoFailure
                );
                if validate(&candidate).is_ok() {
                    let encoded = encode(&candidate);
                    assert!(encoded.len() <= MAX_DIAGNOSTIC_BYTES);
                    assert_eq!(
                        serde_json::from_str::<DiagnosticEvent>(&encoded).unwrap(),
                        candidate
                    );
                    assert_eq!(
                        serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
                        serde_json::to_value(&candidate).unwrap()
                    );
                }
            }
            for other_event in events {
                let mut candidate = event.clone();
                candidate.event = other_event;
                assert_eq!(
                    validate(&candidate).is_ok(),
                    other_event == DiagnosticEventName::PdfSession
                );
            }
            for other_outcome in outcomes {
                for other_tag in tags {
                    let mut candidate = event.clone();
                    candidate.outcome = other_outcome;
                    candidate.tag = other_tag;
                    assert_eq!(
                        validate(&candidate).is_ok(),
                        other_outcome == outcome && other_tag == tag
                    );
                }
            }
        }
    }

    #[test]
    fn native_fields_are_strict_and_renderer_cannot_forge_them() {
        let event = failure().event();
        assert!(validate_renderer_event(&event).is_err());
        let mut absent = event.clone();
        absent.stage = None;
        absent.os_code = None;
        assert!(validate_renderer_event(&absent).is_ok());
        absent.os_code = Some(5);
        assert!(validate(&absent).is_err());
        assert!(validate_renderer_event(&absent).is_err());
        for code in [
            serde_json::json!(-2147483649_i64),
            serde_json::json!(2147483648_i64),
            serde_json::json!(1.5),
            serde_json::json!("5"),
            serde_json::Value::Null,
        ] {
            let mut value = serde_json::to_value(&event).unwrap();
            value["osCode"] = code;
            assert!(serde_json::from_value::<DiagnosticEvent>(value).is_err());
        }
        for stage in [
            serde_json::json!("POLICY"),
            serde_json::json!("unknown"),
            serde_json::json!(0),
            serde_json::Value::Null,
        ] {
            let mut value = serde_json::to_value(&event).unwrap();
            value["stage"] = stage;
            assert!(serde_json::from_value::<DiagnosticEvent>(value).is_err());
        }
        let mut value = serde_json::to_value(&event).unwrap();
        value["message"] = serde_json::json!("private");
        assert!(serde_json::from_value::<DiagnosticEvent>(value).is_err());
    }

    #[test]
    fn observation_captures_only_first_failure_and_only_actual_raw_code() {
        let (sender, receiver) = mpsc::sync_channel(4);
        let sink = NativePdfDiagnostics {
            sender,
            counters: Default::default(),
        };
        for code in [None, Some(i32::MIN), Some(i32::MAX)] {
            let observation = PdfFailureObservation::new(Some(&sink));
            let error = code
                .map(io::Error::from_raw_os_error)
                .unwrap_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof));
            observation.capture(PdfDiagnosticStage::RangeRead, Some(&error));
            observation.capture(PdfDiagnosticStage::RangeAfterValidate, None);
            assert!(receiver.try_recv().is_err());
            drop(observation);
            let event = receiver.try_recv().unwrap();
            assert_eq!(event.stage, Some(PdfDiagnosticStage::RangeRead));
            assert_eq!(event.os_code, code);
            assert!(receiver.try_recv().is_err());
        }
        drop(PdfFailureObservation::new(Some(&sink)));
        assert!(receiver.try_recv().is_err()); // No success events.
        let observation = PdfFailureObservation::new(Some(&sink));
        observation.capture(PdfDiagnosticStage::RangeBeforeValidate, None);
        drop(observation);
        let event = receiver.try_recv().unwrap();
        assert_eq!(event.tag, DiagnosticTag::Conflict);
        assert_eq!(event.os_code, None);
    }

    #[test]
    fn blocked_sink_has_bounded_nonblocking_queue_and_failure_does_not_recurse() {
        let (entered, started) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        let sink = NativePdfDiagnostics::new(move |_| {
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            finished.send(()).unwrap();
            Err(DiagnosticError::Io)
        })
        .unwrap();
        assert!(sink.sender.try_send(failure().event()).is_ok());
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        for _ in 0..MAX_PDF_FAILURE_QUEUE {
            assert!(sink.sender.try_send(failure().event()).is_ok());
        }
        assert!(matches!(
            sink.sender.try_send(failure().event()),
            Err(mpsc::TrySendError::Full(_))
        ));
        // Dropping an observed failure while full must not wait for the blocked sink.
        let observation = PdfFailureObservation::new(Some(&sink));
        observation.capture(
            PdfDiagnosticStage::Open,
            Some(&io::Error::from_raw_os_error(5)),
        );
        drop(observation);
        drop(sink);
        for _ in 0..=MAX_PDF_FAILURE_QUEUE {
            release.send(()).unwrap();
            done.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        assert!(started.try_iter().count() == MAX_PDF_FAILURE_QUEUE);
        assert!(done.recv_timeout(Duration::from_secs(5)).is_err());
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let disconnected = NativePdfDiagnostics {
            sender,
            counters: Default::default(),
        };
        let observation = PdfFailureObservation::new(Some(&disconnected));
        observation.capture(PdfDiagnosticStage::OpenHeaderValidate, None);
        drop(observation); // A disconnected sink cannot replace a PDF result either.
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum PdfRendererCode {
    #[serde(rename = "PDF_OPEN_REQUEST")]
    OpenRequest,
    #[serde(rename = "PDF_SOURCE")]
    Source,
    #[serde(rename = "PDF_LOAD")]
    Load,
    #[serde(rename = "PDF_LOAD_INVALID")]
    LoadInvalid,
    #[serde(rename = "PDF_LOAD_HTTP")]
    LoadHttp,
    #[serde(rename = "PDF_METADATA")]
    Metadata,
    #[serde(rename = "PDF_FIRST_RENDER")]
    FirstRender,
    #[serde(rename = "PDF_RENDER")]
    Render,
    #[serde(rename = "PDF_PRESENTATION")]
    Presentation,
    #[serde(rename = "PDF_RANGE_FETCH")]
    RangeFetch,
    #[serde(rename = "PDF_RANGE_STATUS")]
    RangeStatus,
    #[serde(rename = "PDF_RANGE_HEADERS")]
    RangeHeaders,
    #[serde(rename = "PDF_RANGE_BODY")]
    RangeBody,
    #[serde(rename = "PDF_RANGE_LENGTH")]
    RangeLength,
    #[serde(rename = "PDF_TIMEOUT")]
    Timeout,
    #[serde(rename = "PDF_CANCELLED")]
    Cancelled,
    #[serde(rename = "PDF_PASSWORD")]
    Password,
    #[serde(rename = "PDF_RESOURCE_LIMIT")]
    ResourceLimit,
}
impl PdfRendererCode {
    fn classification(self) -> (DiagnosticOutcome, DiagnosticTag) {
        match self {
            Self::Cancelled => (DiagnosticOutcome::Cancelled, DiagnosticTag::None),
            Self::Timeout => (DiagnosticOutcome::Failure, DiagnosticTag::Timeout),
            _ => (DiagnosticOutcome::Failure, DiagnosticTag::Redacted),
        }
    }
}
/// Only finite renderer facts; native version/time and origin are not supplied by the renderer.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRendererFailure {
    pub code: PdfRendererCode,
    #[serde(default, deserialize_with = "deserialize_present")]
    pub http_status: Option<u16>,
}
impl PdfRendererFailure {
    pub fn validate(&self) -> Result<(), DiagnosticError> {
        let http = matches!(
            self.code,
            PdfRendererCode::RangeStatus | PdfRendererCode::LoadHttp
        );
        if if http {
            self.http_status
                .is_some_and(|status| (100..=599).contains(&status))
        } else {
            self.http_status.is_none()
        } {
            Ok(())
        } else {
            Err(DiagnosticError::InvalidEvent)
        }
    }
    fn event(&self) -> DiagnosticEvent {
        let mut event = PdfFailure {
            stage: PdfDiagnosticStage::Open,
            os_code: None,
            epoch_ms: epoch_ms(),
        }
        .event();
        let (outcome, tag) = self.code.classification();
        event.event = DiagnosticEventName::PdfRender;
        event.outcome = outcome;
        event.tag = tag;
        event.stage = None;
        event.renderer_code = Some(self.code);
        event.http_status = self.http_status;
        event
    }
}
fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PdfDiagnosticDelivery {
    Queued,
    Dropped,
    Unavailable,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PdfDiagnosticWorker {
    Running,
    Stopped,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDiagnosticReceipt {
    pub delivery: PdfDiagnosticDelivery,
    pub worker: PdfDiagnosticWorker,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_failures: Option<u32>,
}
impl PdfDiagnosticReceipt {
    pub(crate) fn unavailable() -> Self {
        Self {
            delivery: PdfDiagnosticDelivery::Unavailable,
            worker: PdfDiagnosticWorker::Unavailable,
            dropped: None,
            write_failures: None,
        }
    }
}
#[derive(Default)]
struct PdfDiagnosticCounters {
    running: std::sync::atomic::AtomicBool,
    dropped: std::sync::atomic::AtomicU32,
    write_failures: std::sync::atomic::AtomicU32,
}
fn increment(counter: &std::sync::atomic::AtomicU32) {
    let _ = counter.fetch_update(
        std::sync::atomic::Ordering::Relaxed,
        std::sync::atomic::Ordering::Relaxed,
        |value| Some(value.saturating_add(1).min(1_000_000)),
    );
}
struct PdfDiagnosticWorkerGuard(std::sync::Arc<PdfDiagnosticCounters>);
impl Drop for PdfDiagnosticWorkerGuard {
    fn drop(&mut self) {
        self.0
            .running
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(test)]
mod renderer_failure_tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn request() -> PdfRendererFailure {
        PdfRendererFailure {
            code: PdfRendererCode::Load,
            http_status: None,
        }
    }

    #[test]
    fn unavailable_worker_omits_unobserved_counters() {
        let receipt = PdfDiagnosticReceipt::unavailable();
        assert_eq!(receipt.dropped, None);
        assert_eq!(receipt.write_failures, None);
        assert_eq!(
            serde_json::to_value(receipt).unwrap(),
            serde_json::json!({
                "delivery": "UNAVAILABLE", "worker": "UNAVAILABLE"
            })
        );
    }
    #[test]
    fn renderer_matrix_round_trips_without_native_provenance() {
        let matrix: Vec<(
            PdfRendererCode,
            DiagnosticOutcome,
            DiagnosticTag,
            Option<u16>,
        )> = serde_json::from_str(include_str!(
            "../../tests/fixtures/pdfRendererFailures.json"
        ))
        .unwrap();
        for (code, outcome, tag, http_status) in matrix {
            let failure = PdfRendererFailure { code, http_status };
            let event = failure.event();
            assert!(failure.validate().is_ok());
            assert!(validate(&event).is_ok());
            assert!(validate_renderer_event(&event).is_err());
            assert_eq!((event.outcome, event.tag), (outcome, tag));
            assert!(event.stage.is_none() && event.os_code.is_none());
            assert_eq!(
                serde_json::from_str::<DiagnosticEvent>(&encode(&event)).unwrap(),
                event
            );
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&encode(&event)).unwrap(),
                serde_json::to_value(&event).unwrap()
            );
            assert!(encode(&event).len() <= MAX_DIAGNOSTIC_BYTES);
            for status in [
                None,
                Some(0),
                Some(99),
                Some(100),
                Some(599),
                Some(600),
                Some(u16::MAX),
            ] {
                let candidate = PdfRendererFailure {
                    code,
                    http_status: status,
                };
                assert_eq!(
                    candidate.validate().is_ok(),
                    if http_status.is_some() {
                        status.is_some_and(|status| (100..=599).contains(&status))
                    } else {
                        status.is_none()
                    }
                );
            }
            let mut invalid = event.clone();
            invalid.stage = Some(PdfDiagnosticStage::Open);
            assert!(validate(&invalid).is_err());
            invalid.stage = None;
            invalid.os_code = Some(5);
            assert!(validate(&invalid).is_err());
            for wrong_event in [
                DiagnosticEventName::PdfSession,
                DiagnosticEventName::ThemeState,
            ] {
                let mut invalid = event.clone();
                invalid.event = wrong_event;
                assert!(validate(&invalid).is_err());
            }
            for wrong_outcome in [
                DiagnosticOutcome::Success,
                DiagnosticOutcome::Failure,
                DiagnosticOutcome::Rejected,
                DiagnosticOutcome::Cancelled,
            ] {
                let mut candidate = event.clone();
                candidate.outcome = wrong_outcome;
                assert_eq!(validate(&candidate).is_ok(), wrong_outcome == outcome);
            }
            for wrong_tag in [
                DiagnosticTag::None,
                DiagnosticTag::Timeout,
                DiagnosticTag::IoFailure,
                DiagnosticTag::Redacted,
                DiagnosticTag::Conflict,
            ] {
                let mut candidate = event.clone();
                candidate.tag = wrong_tag;
                assert_eq!(validate(&candidate).is_ok(), wrong_tag == tag);
            }
        }
        for value in [
            serde_json::json!({"code":"PDF_LOAD","stage":"OPEN"}),
            serde_json::json!({"code":"PDF_LOAD","osCode":5}),
            serde_json::json!({"code":"PDF_LOAD","path":"private"}),
            serde_json::json!({"code":"unknown"}),
            serde_json::json!({"code":"PDF_LOAD","httpStatus":null}),
        ] {
            assert!(serde_json::from_value::<PdfRendererFailure>(value).is_err());
        }
    }

    #[test]
    fn receipts_report_queue_drop_disconnect_and_saturating_health_without_writes() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let sink = NativePdfDiagnostics {
            sender,
            counters: Arc::new(PdfDiagnosticCounters::default()),
        };
        sink.counters
            .running
            .store(true, std::sync::atomic::Ordering::Release);
        let queued = sink.report_renderer(&request()).unwrap();
        assert_eq!(queued.delivery, PdfDiagnosticDelivery::Queued);
        assert_eq!(queued.worker, PdfDiagnosticWorker::Running);
        let dropped = sink.report_renderer(&request()).unwrap();
        assert_eq!(dropped.delivery, PdfDiagnosticDelivery::Dropped);
        assert_eq!(dropped.dropped, Some(1));
        assert_eq!(dropped.write_failures, Some(0));
        assert_eq!(
            receiver.recv().unwrap().renderer_code,
            Some(PdfRendererCode::Load)
        );
        drop(receiver);
        drop(PdfDiagnosticWorkerGuard(Arc::clone(&sink.counters)));
        let unavailable = sink.report_renderer(&request()).unwrap();
        assert_eq!(unavailable.delivery, PdfDiagnosticDelivery::Unavailable);
        assert_eq!(unavailable.worker, PdfDiagnosticWorker::Stopped);
        sink.counters
            .dropped
            .store(1_000_000, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            sink.report_renderer(&request()).unwrap().dropped,
            Some(1_000_000)
        );
        assert_eq!(
            PdfDiagnosticReceipt::unavailable().worker,
            PdfDiagnosticWorker::Unavailable
        );
    }

    #[test]
    fn write_failure_is_counted_without_recursive_logging_or_replacing_pdf_failure() {
        let (entered, observed) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let sink = NativePdfDiagnostics::new(move |_| {
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Err(DiagnosticError::Io)
        })
        .unwrap();
        assert_eq!(
            sink.report_renderer(&request()).unwrap().delivery,
            PdfDiagnosticDelivery::Queued
        );
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            sink.report_renderer(&request()).unwrap().write_failures,
            Some(0)
        );
        release.send(()).unwrap();
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        // The second sink entry proves the first error has already been accounted for.
        assert_eq!(
            sink.counters
                .write_failures
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        release.send(()).unwrap();
        drop(sink);
        assert!(observed.recv_timeout(Duration::from_secs(5)).is_err());
    }
}

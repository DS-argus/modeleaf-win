pub mod commands;
pub mod diagnostics;
pub mod external_link;
pub mod local_path;
pub mod open_dialog;
pub mod open_request;
pub mod pdf_protocol;
pub mod pdf_session;
pub mod persistence;
pub mod recent;
pub mod theme_state;
pub mod workspace;
use crate::commands::config::{
    ConfigReadOutcome, ConfigResetOutcome, ConfigStore, ConfigWriteOutcome,
};
use crate::commands::state::{LinkDestinationIndicator, StateFileError, StateFileStore};
use crate::local_path::SystemLocalPathPolicy;
use external_link::{launch_external_link, shutdown_external_link_dispatcher, ExternalLinkError};
use open_dialog::choose_pdf_file;
use open_request::{
    resolve_second_instance_paths, OpenFailureId, OpenRequestCoordinator, OpenRequestError,
    OpenRequestId,
};
use pdf_session::{
    CancelBarrier, ExternalLinkActivationOperation, ExternalLinkRegistration, PdfOwner,
    PdfSessionError, PdfSessionManager, SessionId,
};
use rand::RngCore;
use recent::{
    RecentListOutcome, RecentOpenOutcome, RecentRecordOutcome, RecentStorageReason, RecentStore,
    RecentStoreError,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use theme_state::{ThemeId, ThemeStateError, ThemeStateManager};
use workspace::{WorkspaceError, WorkspaceManager};
const CANONICAL_DEFAULT_CONFIG: &str = include_str!("../../src/domain/config/default-config.toml");

#[derive(Clone, Default)]
pub struct QuitCoordinator {
    state: Arc<Mutex<QuitState>>,
}

#[derive(Default)]
struct QuitState {
    shutting_down: bool,
    finished: bool,
    failed: bool,
    cleanup_claimed: bool,
    pending_windows: HashSet<String>,
}

impl QuitCoordinator {
    pub fn begin(&self, labels: impl IntoIterator<Item = String>) -> bool {
        let mut state = self.state.lock().expect("quit coordinator poisoned");
        if state.shutting_down {
            return false;
        }
        state.shutting_down = true;
        state.pending_windows.extend(labels);
        true
    }

    pub fn is_shutting_down(&self) -> bool {
        self.state
            .lock()
            .expect("quit coordinator poisoned")
            .shutting_down
    }

    pub fn acknowledge(&self, label: &str, renderer_drained: bool) -> Option<bool> {
        let mut state = self.state.lock().expect("quit coordinator poisoned");
        if !state.shutting_down || state.finished || !state.pending_windows.remove(label) {
            return None;
        }
        state.failed |= !renderer_drained;
        if !state.pending_windows.is_empty() {
            return None;
        }
        state.finished = true;
        Some(!state.failed)
    }

    fn timeout(&self) -> Option<bool> {
        let mut state = self.state.lock().expect("quit coordinator poisoned");
        if !state.shutting_down || state.finished {
            return None;
        }
        state.failed = true;
        state.finished = true;
        Some(false)
    }

    fn claim_cleanup(&self) -> bool {
        let mut state = self.state.lock().expect("quit coordinator poisoned");
        if state.cleanup_claimed {
            return false;
        }
        state.cleanup_claimed = true;
        true
    }
}

pub fn drain_owner_for_lifecycle(
    coordinator: &OpenRequestCoordinator,
    workspace: &WorkspaceManager,
    sessions: &PdfSessionManager,
    owner: &PdfOwner,
) {
    coordinator.target_lost_for_lifecycle(owner);
    let _ = workspace.destroy_window(owner);
    sessions.drain_owned(owner);
}

fn drain_app_owners<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let coordinator = app.state::<OpenRequestCoordinator>();
    let workspace = app.state::<WorkspaceManager>();
    let sessions = app.state::<PdfSessionManager>();
    for label in app.webview_windows().keys() {
        if let Some(owner) = workspace.active_owner(label) {
            drain_owner_for_lifecycle(&coordinator, &workspace, &sessions, &owner);
        }
    }
    sessions.drain_all();
}

fn record_native_diagnostic<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    event: diagnostics::DiagnosticEventName,
    outcome: diagnostics::DiagnosticOutcome,
    tag: diagnostics::DiagnosticTag,
) {
    let Some(log) = app.try_state::<diagnostics::DiagnosticLog>() else {
        return;
    };
    let epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let event = diagnostics::DiagnosticEvent {
        event,
        outcome,
        tag,
        storage_class: diagnostics::DiagnosticStorageClass::Local,
        epoch_ms,
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        runtime_version: "0.0.0".to_owned(),
        trace_id: None,
        request_id: None,
        session_id: None,
        page: None,
        count: None,
        duration_ms: None,
        generation: None,
    };
    let _ = log.record(&event);
}

fn complete_quit_application<R: tauri::Runtime>(app: &tauri::AppHandle<R>, renderer_drained: bool) {
    if app.state::<QuitCoordinator>().claim_cleanup() {
        drain_app_owners(app);
        shutdown_external_link_dispatcher();
    }
    record_native_diagnostic(
        app,
        diagnostics::DiagnosticEventName::Quit,
        if renderer_drained {
            diagnostics::DiagnosticOutcome::Success
        } else {
            diagnostics::DiagnosticOutcome::Failure
        },
        if renderer_drained {
            diagnostics::DiagnosticTag::None
        } else {
            diagnostics::DiagnosticTag::Timeout
        },
    );
    app.exit(0);
}

fn timeout_quit_application<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(renderer_drained) = app.state::<QuitCoordinator>().timeout() {
        complete_quit_application(app, renderer_drained);
    }
}

fn acknowledge_quit_application<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    renderer_drained: bool,
) {
    if let Some(all_renderers_drained) = app
        .state::<QuitCoordinator>()
        .acknowledge(label, renderer_drained)
    {
        complete_quit_application(app, all_renderers_drained);
    }
}

fn begin_quit_application<R: tauri::Runtime + 'static>(app: &tauri::AppHandle<R>) {
    let labels = app.webview_windows().keys().cloned().collect::<Vec<_>>();
    if app.state::<QuitCoordinator>().begin(labels) {
        let _ = app.emit("quit-requested", ());
        let fallback = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            timeout_quit_application(&fallback);
        });
    }
}

#[tauri::command]
fn begin_quit(app: tauri::AppHandle) {
    begin_quit_application(&app);
}

#[tauri::command]
fn renderer_ready(window: Window) {
    if window.state::<QuitCoordinator>().is_shutting_down() {
        let _ = window.emit_to(window.label(), "quit-requested", ());
    }
}

#[tauri::command]
fn finish_quit(window: Window, renderer_drained: bool) {
    let label = window.label().to_owned();
    acknowledge_quit_application(window.app_handle(), &label, renderer_drained);
}
#[tauri::command]
fn read_config(state: State<'_, ConfigStore>) -> ConfigReadOutcome {
    state.read()
}

#[tauri::command]
fn write_default_config(state: State<'_, ConfigStore>) -> ConfigWriteOutcome {
    state.write_default(CANONICAL_DEFAULT_CONFIG)
}

#[tauri::command]
fn reset_config(state: State<'_, ConfigStore>) -> ConfigResetOutcome {
    state.reset(CANONICAL_DEFAULT_CONFIG)
}

#[tauri::command]
fn read_indicator_state(
    state: State<'_, StateFileStore>,
) -> Result<Option<LinkDestinationIndicator>, StateFileError> {
    state.read_indicator()
}

#[tauri::command]
fn commit_indicator_state(
    state: State<'_, StateFileStore>,
    value: LinkDestinationIndicator,
) -> Result<(), StateFileError> {
    state.set_link_destination_indicator(value)
}
#[tauri::command]
fn read_theme_state(state: State<'_, ThemeStateManager>) -> theme_state::ThemeState {
    state.current()
}

#[tauri::command]
fn commit_theme_state(
    app: tauri::AppHandle,
    state: State<'_, ThemeStateManager>,
    theme_id: ThemeId,
    base_revision: u64,
) -> Result<theme_state::ThemeState, ThemeStateError> {
    match state.commit(theme_id, base_revision) {
        Ok(committed) => {
            let _ = app.emit("theme-state-committed", committed);
            record_native_diagnostic(
                &app,
                diagnostics::DiagnosticEventName::ThemeState,
                diagnostics::DiagnosticOutcome::Success,
                diagnostics::DiagnosticTag::None,
            );
            Ok(committed)
        }
        Err(error) => {
            if error == ThemeStateError::Storage {
                let _ = app.emit("theme-state-committed", state.current());
            }
            let tag = if error == ThemeStateError::Conflict {
                diagnostics::DiagnosticTag::Conflict
            } else {
                diagnostics::DiagnosticTag::IoFailure
            };
            record_native_diagnostic(
                &app,
                diagnostics::DiagnosticEventName::ThemeState,
                diagnostics::DiagnosticOutcome::Failure,
                tag,
            );
            Err(error)
        }
    }
}

#[tauri::command]
fn record_diagnostic(
    diagnostics: State<'_, diagnostics::DiagnosticLog>,
    event: diagnostics::DiagnosticEvent,
) -> Result<(), diagnostics::DiagnosticError> {
    diagnostics.record(&event)
}

const MAX_PENDING_SECOND_INSTANCE_PATHS: usize = 8;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalLinkActivationRequest {
    operation_id: String,
    operation_sequence: u64,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    registry_revision: u64,
    annotation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
enum CreateAppWindowError {
    #[serde(rename = "WINDOW_CAPACITY")]
    Capacity,
    #[serde(rename = "WINDOW_CREATION_FAILED")]
    CreationFailed,
    #[serde(rename = "WINDOW_SETUP_FAILED")]
    SetupFailed,
    #[serde(rename = "WINDOW_SHUTTING_DOWN")]
    ShuttingDown,
}

#[derive(Clone, Default)]
struct AppWindowRegistry {
    windows: Arc<Mutex<HashMap<String, tauri::WebviewWindow>>>,
}

impl AppWindowRegistry {
    fn retain(&self, window: tauri::WebviewWindow) {
        self.windows
            .lock()
            .expect("app window registry poisoned")
            .insert(window.label().to_owned(), window);
    }

    fn remove(&self, label: &str) {
        self.windows
            .lock()
            .expect("app window registry poisoned")
            .remove(label);
    }
}

#[derive(Clone, Default)]
struct WindowCloseCoordinator {
    inner: Arc<Mutex<WindowCloseState>>,
}
#[derive(Default)]
struct WindowCloseState {
    ready: HashSet<String>,
    pending: HashMap<String, u64>,
    next_request_id: u64,
}
impl WindowCloseCoordinator {
    fn ready(&self, label: &str) -> Option<u64> {
        let mut state = self.inner.lock().expect("window close state poisoned");
        state.ready.insert(label.to_owned());
        state.pending.get(label).copied()
    }
    fn request(&self, label: &str) -> (u64, bool) {
        let mut state = self.inner.lock().expect("window close state poisoned");
        if let Some(request_id) = state.pending.get(label).copied() {
            return (request_id, state.ready.contains(label));
        }
        state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
        let request_id = state.next_request_id;
        state.pending.insert(label.to_owned(), request_id);
        (request_id, state.ready.contains(label))
    }
    fn acknowledge(&self, label: &str, request_id: Option<u64>) -> bool {
        let mut state = self.inner.lock().expect("window close state poisoned");
        match request_id {
            Some(expected) if state.pending.get(label).copied() != Some(expected) => false,
            _ => {
                state.pending.remove(label);
                true
            }
        }
    }
    fn claim_timeout(&self, label: &str, request_id: u64) -> bool {
        let mut state = self.inner.lock().expect("window close state poisoned");
        if state.pending.get(label).copied() != Some(request_id) {
            return false;
        }
        state.pending.remove(label);
        true
    }
    fn remove(&self, label: &str) {
        let mut state = self.inner.lock().expect("window close state poisoned");
        state.ready.remove(label);
        state.pending.remove(label);
    }
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowCloseRequest {
    request_id: u64,
}
pub fn generate_reader_window_label() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("reader-{:032x}", u128::from_be_bytes(bytes))
}

/// Preferred inner size for a new window, in logical pixels.
///
/// A fixed 1040x760 is wrong on both ends: cramped on a 4K panel and larger
/// than the work area on a small laptop. This takes a fraction of the current
/// monitor work area, clamped to the documented minimum and a comfortable
/// reading width, so the window always fits the display it opens on.
fn preferred_window_size<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> (f64, f64) {
    const DEFAULT: (f64, f64) = (1040.0, 760.0);
    const MIN: (f64, f64) = (480.0, 360.0);
    const MAX: (f64, f64) = (1600.0, 1200.0);
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return DEFAULT;
    };
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return DEFAULT;
    }
    let size = monitor.size();
    let logical_width = f64::from(size.width) / scale;
    let logical_height = f64::from(size.height) / scale;
    if !logical_width.is_finite() || !logical_height.is_finite() {
        return DEFAULT;
    }
    let width = (logical_width * 0.62).clamp(MIN.0, MAX.0.min(logical_width));
    let height = (logical_height * 0.78).clamp(MIN.1, MAX.1.min(logical_height));
    (width, height)
}
#[tauri::command]
async fn create_app_window(
    app: tauri::AppHandle,
    workspace: State<'_, WorkspaceManager>,
    windows: State<'_, AppWindowRegistry>,
) -> Result<(), CreateAppWindowError> {
    if app.state::<QuitCoordinator>().is_shutting_down() {
        return Err(CreateAppWindowError::ShuttingDown);
    }
    let (preferred_width, preferred_height) = preferred_window_size(&app);
    let label = generate_reader_window_label();
    let owner = workspace
        .claim_window(&label)
        .map_err(|_| CreateAppWindowError::Capacity)?;
    let window = match WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Modeleaf")
        .additional_browser_args("--force-renderer-accessibility")
        .visible(false)
        .decorations(true)
        .resizable(true)
        .fullscreen(false)
        .inner_size(preferred_width, preferred_height)
        .min_inner_size(480.0, 360.0)
        .build()
    {
        Ok(window) => window,
        Err(_) => {
            let _ = workspace.destroy_window(&owner);
            return Err(CreateAppWindowError::CreationFailed);
        }
    };
    if disable_browser_accelerators(&window).is_err() {
        let _ = window.destroy();
        let _ = workspace.destroy_window(&owner);
        return Err(CreateAppWindowError::SetupFailed);
    }
    if app.state::<QuitCoordinator>().is_shutting_down() {
        let _ = window.destroy();
        let _ = workspace.destroy_window(&owner);
        return Err(CreateAppWindowError::ShuttingDown);
    }
    if window.show().is_err() {
        let _ = window.destroy();
        let _ = workspace.destroy_window(&owner);
        return Err(CreateAppWindowError::SetupFailed);
    }
    windows.retain(window);
    Ok(())
}

#[tauri::command]
fn window_close_ready(
    window: tauri::WebviewWindow,
    coordinator: State<'_, WindowCloseCoordinator>,
) -> Result<(), &'static str> {
    if let Some(request_id) = coordinator.ready(window.label()) {
        window
            .emit_to(
                window.label(),
                "window-close-requested",
                WindowCloseRequest { request_id },
            )
            .map_err(|_| "WINDOW_CLOSE_DELIVERY_FAILED")?;
    }
    Ok(())
}
#[tauri::command]
fn close_current_window(
    window: tauri::WebviewWindow,
    coordinator: State<'_, WindowCloseCoordinator>,
    request_id: Option<u64>,
    renderer_drained: bool,
) -> Result<(), &'static str> {
    if !renderer_drained {
        record_native_diagnostic(
            window.app_handle(),
            diagnostics::DiagnosticEventName::Quit,
            diagnostics::DiagnosticOutcome::Failure,
            diagnostics::DiagnosticTag::Timeout,
        );
    }
    if !coordinator.acknowledge(window.label(), request_id) {
        return Err("WINDOW_CLOSE_STALE");
    }
    window.destroy().map_err(|_| "WINDOW_CLOSE_FAILED")
}
#[derive(Clone, Default)]
pub struct SecondInstanceIngress {
    pending: Arc<Mutex<PendingSecondInstanceIngress>>,
}

#[derive(Default)]
struct PendingSecondInstanceIngress {
    paths: VecDeque<PathBuf>,
    overflowed: bool,
}

impl SecondInstanceIngress {
    pub fn enqueue_paths(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut pending = self
            .pending
            .lock()
            .expect("second-instance ingress poisoned");
        for path in paths {
            if pending.paths.len() < MAX_PENDING_SECOND_INSTANCE_PATHS {
                pending.paths.push_back(path);
            } else {
                pending.overflowed = true;
            }
        }
    }

    pub fn take_ready(&self) -> (Vec<PathBuf>, bool) {
        let mut pending = self
            .pending
            .lock()
            .expect("second-instance ingress poisoned");
        (
            pending.paths.drain(..).collect(),
            std::mem::take(&mut pending.overflowed),
        )
    }
}
/// Chooses which window label should receive shell-opened paths.
///
/// Prefers the focused window so a second launch lands where the user is
/// looking. Otherwise falls back to the lowest label in sorted order, which is
/// stable and independent of `HashMap` iteration order. Returns `None` only
/// when no window is live, which leaves paths queued for a later window rather
/// than dropping them.
fn select_shell_open_label<'a>(windows: &[(&'a str, bool)]) -> Option<&'a str> {
    let mut labels = windows.iter().map(|(label, _)| *label).collect::<Vec<_>>();
    labels.sort_unstable();
    for label in &labels {
        if windows
            .iter()
            .any(|(candidate, focused)| candidate == label && *focused)
        {
            return Some(label);
        }
    }
    labels.first().copied()
}

/// Resolves the live window that should receive shell-opened paths.
///
/// The initial `main` window may already be closed while other reader windows
/// remain open, so this must never assume a fixed label.
fn resolve_shell_open_target<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<tauri::WebviewWindow<R>> {
    let windows = app.webview_windows();
    let focus = windows
        .iter()
        .map(|(label, window)| (label.as_str(), window.is_focused().unwrap_or(false)))
        .collect::<Vec<_>>();
    let selected = select_shell_open_label(&focus)?.to_owned();
    windows.get(&selected).cloned()
}

fn enqueue_second_instance(ingress: &SecondInstanceIngress, argv: Vec<String>, cwd: &str) {
    ingress.enqueue_paths(resolve_second_instance_paths(
        argv.into_iter().map(std::ffi::OsString::from),
        std::path::Path::new(cwd),
    ));
}

fn drain_second_instance_ingress<R, E>(
    emitter: &E,
    window_label: &str,
    coordinator: &OpenRequestCoordinator,
    ingress: &SecondInstanceIngress,
) where
    R: tauri::Runtime,
    E: Emitter<R>,
{
    let (paths, overflowed) = ingress.take_ready();
    for path in paths {
        let _ = emit_open_request(emitter, window_label, coordinator, &path);
    }
    if overflowed {
        let _ = publish_open_failure(
            emitter,
            window_label,
            coordinator,
            OpenRequestError::Capacity,
        );
    }
}

fn workspace_error(error: WorkspaceError) -> PdfSessionError {
    match error {
        WorkspaceError::SessionCapacity | WorkspaceError::WindowCapacity => {
            PdfSessionError::SessionCapacity
        }
        WorkspaceError::OwnerMismatch => PdfSessionError::OwnerMismatch,
        WorkspaceError::GenerationMismatch | WorkspaceError::WindowNotFound => {
            PdfSessionError::GenerationMismatch
        }
    }
}

fn command_owner(window: &Window, generation: u64) -> PdfOwner {
    PdfOwner {
        window_label: window.label().to_owned(),
        generation,
    }
}

fn publish_open_failure<R, E>(
    emitter: &E,
    window_label: &str,
    coordinator: &OpenRequestCoordinator,
    error: OpenRequestError,
) -> Result<(), OpenRequestError>
where
    R: tauri::Runtime,
    E: Emitter<R>,
{
    let failure = coordinator.ingest_failure(window_label, error)?;
    // Events are wake-up hints only. The coordinator retains the acknowledgement-replayed notice.
    emitter
        .emit("modeleaf://open-failure", failure)
        .map_err(|_| OpenRequestError::DeliveryExpired)?;
    Ok(())
}

fn emit_open_request<R, E>(
    emitter: &E,
    window_label: &str,
    coordinator: &OpenRequestCoordinator,
    path: &std::path::Path,
) -> Result<(), OpenRequestError>
where
    R: tauri::Runtime,
    E: Emitter<R>,
{
    match coordinator.ingest_path(window_label, path) {
        Ok(notice) => {
            emitter
                .emit("modeleaf://open-request", notice)
                .map_err(|_| OpenRequestError::DeliveryExpired)?;
            Ok(())
        }
        Err(error) => publish_open_failure(emitter, window_label, coordinator, error),
    }
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum NativeDialogFailureReason {
    OwnerUnavailable,
    WorkerFailed,
    PickerFailed,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum NativeSelectionRejectionReason {
    OpenRequestNotFound,
    OpenRequestCapacity,
    OpenRequestOwnerMismatch,
    OpenRequestNotClaimed,
    OpenRequestCancelled,
    OpenRequestRejected,
    OpenRequestDeliveryExpired,
    PathRejected,
    RemotePath,
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

fn native_selection_reason(error: OpenRequestError) -> NativeSelectionRejectionReason {
    match error {
        OpenRequestError::NotFound => NativeSelectionRejectionReason::OpenRequestNotFound,
        OpenRequestError::Capacity => NativeSelectionRejectionReason::OpenRequestCapacity,
        OpenRequestError::OwnerMismatch => NativeSelectionRejectionReason::OpenRequestOwnerMismatch,
        OpenRequestError::NotClaimed => NativeSelectionRejectionReason::OpenRequestNotClaimed,
        OpenRequestError::Cancelled => NativeSelectionRejectionReason::OpenRequestCancelled,
        OpenRequestError::Rejected => NativeSelectionRejectionReason::OpenRequestRejected,
        OpenRequestError::DeliveryExpired => {
            NativeSelectionRejectionReason::OpenRequestDeliveryExpired
        }
        OpenRequestError::Session(error) => match error {
            PdfSessionError::PathRejected => NativeSelectionRejectionReason::PathRejected,
            PdfSessionError::RemotePath => NativeSelectionRejectionReason::RemotePath,
            PdfSessionError::MissingFile => NativeSelectionRejectionReason::MissingFile,
            PdfSessionError::FileUnreadable => NativeSelectionRejectionReason::FileUnreadable,
            PdfSessionError::PdfInvalid => NativeSelectionRejectionReason::PdfInvalid,
            PdfSessionError::DocumentTooLarge => NativeSelectionRejectionReason::DocumentTooLarge,
            PdfSessionError::SessionCapacity => NativeSelectionRejectionReason::SessionCapacity,
            PdfSessionError::RangeInvalid => NativeSelectionRejectionReason::RangeInvalid,
            PdfSessionError::RangeCapacity => NativeSelectionRejectionReason::RangeCapacity,
            PdfSessionError::SessionNotFound => NativeSelectionRejectionReason::SessionNotFound,
            PdfSessionError::OwnerMismatch => NativeSelectionRejectionReason::OwnerMismatch,
            PdfSessionError::GenerationMismatch => {
                NativeSelectionRejectionReason::GenerationMismatch
            }
            PdfSessionError::SessionClosing => NativeSelectionRejectionReason::SessionClosing,
            PdfSessionError::BarrierMismatch => NativeSelectionRejectionReason::BarrierMismatch,
            PdfSessionError::DialogFailed => NativeSelectionRejectionReason::DialogFailed,
            PdfSessionError::ExternalLinkDrainTimeout => {
                NativeSelectionRejectionReason::ExternalLinkDrainTimeout
            }
        },
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "tag",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
enum NativeDialogOutcome {
    Cancelled,
    Admitted {
        request_id: OpenRequestId,
    },
    DialogFailed {
        reason: NativeDialogFailureReason,
    },
    SelectionRejected {
        reason: NativeSelectionRejectionReason,
    },
}
#[tauri::command]
async fn open_pdf_dialog(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
) -> Result<NativeDialogOutcome, OpenRequestError> {
    let owner_hwnd = match window.hwnd() {
        Ok(hwnd) if !hwnd.0.is_null() => hwnd.0 as isize,
        _ => {
            return Ok(NativeDialogOutcome::DialogFailed {
                reason: NativeDialogFailureReason::OwnerUnavailable,
            })
        }
    };
    let chosen =
        match tauri::async_runtime::spawn_blocking(move || choose_pdf_file(owner_hwnd)).await {
            Ok(result) => result,
            Err(_) => {
                return Ok(NativeDialogOutcome::DialogFailed {
                    reason: NativeDialogFailureReason::WorkerFailed,
                })
            }
        };
    Ok(match chosen {
        Ok(Some(path)) => match coordinator.ingest_path(window.label(), &path) {
            Ok(notice) => NativeDialogOutcome::Admitted {
                request_id: notice.request_id,
            },
            Err(error) => NativeDialogOutcome::SelectionRejected {
                reason: native_selection_reason(error),
            },
        },
        Ok(None) => NativeDialogOutcome::Cancelled,
        Err(_) => NativeDialogOutcome::DialogFailed {
            reason: NativeDialogFailureReason::PickerFailed,
        },
    })
}
#[tauri::command]
fn ack_open_failure(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
    failure_id: String,
) -> Result<(), OpenRequestError> {
    coordinator.acknowledge_failure(window.label(), OpenFailureId::from_opaque(failure_id)?)
}

#[tauri::command]
fn list_pending_open_ingress(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
) -> Result<Vec<open_request::PendingIngressNotice>, OpenRequestError> {
    coordinator.pending_ingress(window.label())
}

#[tauri::command]
fn claim_open_request(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
    request_id: String,
) -> Result<open_request::ClaimedOpenRequest, OpenRequestError> {
    coordinator.claim(window.label(), OpenRequestId::from_opaque(request_id)?)
}

#[tauri::command]
fn ack_open_request(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
    request_id: String,
) -> Result<(), OpenRequestError> {
    coordinator.acknowledge(window.label(), OpenRequestId::from_opaque(request_id)?)
}

#[tauri::command]
fn reject_open_request(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
    request_id: String,
) -> Result<(), OpenRequestError> {
    coordinator.reject(window.label(), OpenRequestId::from_opaque(request_id)?)
}
const RECENT_STATE_CHANGED_EVENT: &str = "recent-state-changed";
fn publish_recent_snapshot(window: &Window, outcome: &RecentListOutcome) {
    let _ = window
        .app_handle()
        .emit(RECENT_STATE_CHANGED_EVENT, outcome);
}

#[tauri::command]
fn record_recent(
    window: Window,
    sessions: State<'_, PdfSessionManager>,
    recents: State<'_, Mutex<RecentStore>>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
) -> RecentRecordOutcome {
    let owner = command_owner(&window, owner_generation);
    let session_id = match SessionId::from_opaque(session_id) {
        Ok(session_id) => session_id,
        Err(_) => {
            return RecentRecordOutcome::StorageFailed {
                reason: RecentStorageReason::IdentityUnavailable,
            }
        }
    };
    let identity = match sessions.trusted_recent_identity(&owner, &session_id, document_generation)
    {
        Ok(identity) => identity,
        Err(_) => {
            return RecentRecordOutcome::StorageFailed {
                reason: RecentStorageReason::IdentityUnavailable,
            }
        }
    };
    let mut recents = recents.lock().expect("recent store state poisoned");
    match recents.record_trusted_opened_and_save(identity) {
        Ok(_) => {
            let (revision, entries) = recents.snapshot();
            let event = RecentListOutcome::Ready {
                revision: revision.clone(),
                entries: entries.clone(),
            };
            drop(recents);
            publish_recent_snapshot(&window, &event);
            RecentRecordOutcome::Committed { revision, entries }
        }
        Err(RecentStoreError::StateUnavailable(reason)) => {
            RecentRecordOutcome::StateUnavailable { reason }
        }
        Err(_) => RecentRecordOutcome::StorageFailed {
            reason: RecentStorageReason::StateWriteFailed,
        },
    }
}
#[tauri::command]
fn list_recents(recents: State<'_, Mutex<RecentStore>>) -> RecentListOutcome {
    recents
        .lock()
        .expect("recent store state poisoned")
        .list_outcome()
}

fn prune_confirmed_missing(
    store: &mut RecentStore,
    recent_id: &str,
) -> (RecentOpenOutcome, Option<RecentListOutcome>) {
    match store.prune_missing_id(recent_id) {
        Ok(true) => {
            let (revision, entries) = store.snapshot();
            let event = RecentListOutcome::Ready {
                revision: revision.clone(),
                entries: entries.clone(),
            };
            (
                RecentOpenOutcome::MissingPruned { revision, entries },
                Some(event),
            )
        }
        Ok(false) => {
            let (revision, entries) = store.snapshot();
            (
                RecentOpenOutcome::StaleSelection { revision, entries },
                None,
            )
        }
        Err(RecentStoreError::StateUnavailable(_)) => (
            RecentOpenOutcome::MissingPruneFailed {
                reason: "STATE_UNAVAILABLE".into(),
            },
            None,
        ),
        Err(_) => (
            RecentOpenOutcome::MissingPruneFailed {
                reason: "STATE_WRITE_FAILED".into(),
            },
            None,
        ),
    }
}
#[tauri::command]
fn open_recent(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
    recents: State<'_, Mutex<RecentStore>>,
    recent_id: String,
) -> RecentOpenOutcome {
    let mut store = recents.lock().expect("recent store state poisoned");
    if let Some(reason) = store.health_reason() {
        return RecentOpenOutcome::StateUnavailable { reason };
    }
    let (outcome, event) = match store.resolve_for_open(&recent_id, &SystemLocalPathPolicy) {
        Ok(path) => match coordinator.ingest_path(window.label(), &path) {
            Ok(notice) => (
                RecentOpenOutcome::Admitted {
                    request_id: notice.request_id.into_opaque(),
                },
                None,
            ),
            Err(OpenRequestError::Session(PdfSessionError::MissingFile)) => {
                prune_confirmed_missing(&mut store, &recent_id)
            }
            Err(OpenRequestError::Session(PdfSessionError::RemotePath)) => (
                RecentOpenOutcome::AccessDenied {
                    reason: "REMOTE_PATH".into(),
                },
                None,
            ),
            Err(OpenRequestError::Session(PdfSessionError::PathRejected)) => (
                RecentOpenOutcome::AccessDenied {
                    reason: "PATH_REJECTED".into(),
                },
                None,
            ),
            Err(OpenRequestError::Session(PdfSessionError::FileUnreadable)) => (
                RecentOpenOutcome::TransientFailure {
                    reason: "IO_TRANSIENT".into(),
                },
                None,
            ),
            Err(error) => (
                RecentOpenOutcome::DocumentRejected {
                    reason: error.to_string(),
                },
                None,
            ),
        },
        Err(RecentStoreError::MissingRecentId) => {
            let (revision, entries) = store.snapshot();
            (
                RecentOpenOutcome::StaleSelection { revision, entries },
                None,
            )
        }
        Err(RecentStoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            prune_confirmed_missing(&mut store, &recent_id)
        }
        Err(RecentStoreError::RemotePath) => (
            RecentOpenOutcome::AccessDenied {
                reason: "REMOTE_PATH".into(),
            },
            None,
        ),
        Err(RecentStoreError::PathRejected) => (
            RecentOpenOutcome::AccessDenied {
                reason: "PATH_REJECTED".into(),
            },
            None,
        ),
        Err(RecentStoreError::NotPdf) => (
            RecentOpenOutcome::DocumentRejected {
                reason: "PDF_INVALID".into(),
            },
            None,
        ),
        Err(RecentStoreError::Io(error))
            if error.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            (
                RecentOpenOutcome::AccessDenied {
                    reason: "PERMISSION_DENIED".into(),
                },
                None,
            )
        }
        Err(RecentStoreError::Io(_)) => (
            RecentOpenOutcome::TransientFailure {
                reason: "IO_TRANSIENT".into(),
            },
            None,
        ),
        Err(RecentStoreError::StateUnavailable(reason)) => {
            (RecentOpenOutcome::StateUnavailable { reason }, None)
        }
    };
    drop(store);
    if let Some(event) = event.as_ref() {
        publish_recent_snapshot(&window, event);
    }
    outcome
}
#[tauri::command]
fn prepare_external_links(
    window: Window,
    state: State<'_, PdfSessionManager>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    registry_revision: u64,
    entries: Vec<ExternalLinkRegistration>,
) -> Result<(), ExternalLinkError> {
    let session_id =
        SessionId::from_opaque(session_id).map_err(|_| ExternalLinkError::SessionNotFound)?;
    state.prepare_external_links(
        &command_owner(&window, owner_generation),
        &session_id,
        document_generation,
        registry_revision,
        entries,
    )
}
#[tauri::command]
fn commit_external_links(
    window: Window,
    state: State<'_, PdfSessionManager>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    registry_revision: u64,
) -> Result<(), ExternalLinkError> {
    let session_id =
        SessionId::from_opaque(session_id).map_err(|_| ExternalLinkError::SessionNotFound)?;
    state.commit_external_links(
        &command_owner(&window, owner_generation),
        &session_id,
        document_generation,
        registry_revision,
    )
}

#[tauri::command]
fn finalize_external_links(
    window: Window,
    state: State<'_, PdfSessionManager>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    registry_revision: u64,
) -> Result<(), ExternalLinkError> {
    let session_id =
        SessionId::from_opaque(session_id).map_err(|_| ExternalLinkError::SessionNotFound)?;
    state.finalize_external_links(
        &command_owner(&window, owner_generation),
        &session_id,
        document_generation,
        registry_revision,
    )
}
#[tauri::command]
fn abort_external_links(
    window: Window,
    state: State<'_, PdfSessionManager>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    registry_revision: u64,
) -> Result<(), ExternalLinkError> {
    let session_id =
        SessionId::from_opaque(session_id).map_err(|_| ExternalLinkError::SessionNotFound)?;
    state.abort_external_links(
        &command_owner(&window, owner_generation),
        &session_id,
        document_generation,
        registry_revision,
    )
}

#[tauri::command]
async fn open_external_link(
    window: Window,
    state: State<'_, PdfSessionManager>,
    request: ExternalLinkActivationRequest,
) -> Result<u64, ExternalLinkError> {
    let session_id = SessionId::from_opaque(request.session_id)
        .map_err(|_| ExternalLinkError::SessionNotFound)?;
    let owner = command_owner(&window, request.owner_generation);
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let operation_sequence = request.operation_sequence;
        manager.activate_external_link_with_operation(
            &owner,
            &session_id,
            request.document_generation,
            ExternalLinkActivationOperation::new(
                request.registry_revision,
                &request.annotation_id,
                &request.operation_id,
                operation_sequence,
            ),
            launch_external_link,
        )?;
        Ok(operation_sequence)
    })
    .await
    .map_err(|_| ExternalLinkError::LinkLaunchFailed)?
}

#[tauri::command]
async fn cancel_pdf_session(
    window: Window,
    state: State<'_, PdfSessionManager>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
) -> Result<CancelBarrier, PdfSessionError> {
    let session_id = SessionId::from_opaque(session_id)?;
    let owner = command_owner(&window, owner_generation);
    let sessions = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        sessions.cancel(&owner, &session_id, document_generation)
    })
    .await
    .map_err(|_| PdfSessionError::SessionClosing)?
}
#[tauri::command]
async fn close_pdf_session(
    window: Window,
    state: State<'_, PdfSessionManager>,
    workspace: State<'_, WorkspaceManager>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    barrier_id: u64,
) -> Result<(), PdfSessionError> {
    let session_id = SessionId::from_opaque(session_id)?;
    let owner = command_owner(&window, owner_generation);
    state.close(&owner, &session_id, document_generation, barrier_id)?;
    workspace
        .release_session(&owner, &session_id)
        .map_err(workspace_error)
}

#[cfg(windows)]
fn disable_browser_accelerators<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window.with_webview(move |webview| {
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let core = webview.controller().CoreWebView2()?;
                let settings = core.Settings()?;
                let settings3 = settings.cast::<ICoreWebView2Settings3>()?;
                settings3.SetAreBrowserAcceleratorKeysEnabled(false)?;
                Ok(())
            })()
        }
        .map_err(|error| error.to_string());
        let _ = sender.send(result);
    })?;
    match receiver.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(std::io::Error::other(error).into()),
        Err(error) => Err(std::io::Error::other(format!(
            "WebView2 accelerator setup did not complete: {error}"
        ))
        .into()),
    }
}
#[cfg(not(windows))]
fn disable_browser_accelerators<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sessions = PdfSessionManager::new();
    let workspace = WorkspaceManager::new();
    let coordinator = OpenRequestCoordinator::new(sessions.clone(), workspace.clone());
    let second_instance_ingress = SecondInstanceIngress::default();
    second_instance_ingress.enqueue_paths(std::env::args_os().skip(1).map(PathBuf::from));
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("modeleaf-pdf", |context, request, responder| {
            let app = context.app_handle().clone();
            let webview_label = context.webview_label().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                let workspace = app.state::<WorkspaceManager>();
                let sessions = app.state::<PdfSessionManager>();
                let response = match workspace.active_owner(&webview_label) {
                    Some(owner) => {
                        pdf_protocol::handle_pdf_protocol_request(&request, &owner, &sessions)
                    }
                    None => tauri::http::Response::builder()
                        .status(tauri::http::StatusCode::NOT_FOUND)
                        .body(Vec::new())
                        .expect("static protocol response"),
                };
                responder.respond(response);
            });
        })
        .manage(second_instance_ingress)
        .manage(QuitCoordinator::default())
        .manage(AppWindowRegistry::default())
        .manage(WindowCloseCoordinator::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if app.state::<QuitCoordinator>().is_shutting_down() {
                return;
            }
            let ingress = app.state::<SecondInstanceIngress>();
            enqueue_second_instance(&ingress, argv, &cwd);
            if let Some(window) = resolve_shell_open_target(app) {
                let workspace = app.state::<WorkspaceManager>();
                let _ = workspace.claim_window(window.label());
                drain_second_instance_ingress(
                    &window,
                    window.label(),
                    &app.state::<OpenRequestCoordinator>(),
                    &ingress,
                );
            }
        }))
        .manage(sessions)
        .manage(workspace)
        .manage(coordinator)
        .setup(|app| {
            let app_local_data_directory = app.path().app_local_data_dir()?;
            let app_config_directory = app.path().app_config_dir()?;
            let state_path = app_local_data_directory.join("state.json");
            app.manage(ConfigStore::new(app_config_directory.join("config.toml")));
            app.manage(StateFileStore::new(state_path.clone()));
            let window = app.get_webview_window("main").expect("main window missing");
            disable_browser_accelerators(&window)?;
            // The configured size is a fallback. Resize to fit the monitor the
            // window actually opens on, then centre it, before it is shown.
            let (preferred_width, preferred_height) = preferred_window_size(app.handle());
            window.show()?;
            // The size must be applied after the window is realised. Setting it
            // while still hidden was silently overridden, leaving the window at
            // nearly the full work-area height regardless of configuration.
            let _ = window.set_size(tauri::LogicalSize::new(preferred_width, preferred_height));
            let _ = window.center();
            let recents = RecentStore::load(state_path.clone(), &SystemLocalPathPolicy)?;
            app.manage(Mutex::new(recents));
            let themes = ThemeStateManager::load(state_path);
            let theme_recovery_needed = themes.take_startup_recovery_needed();
            app.manage(themes);
            app.manage(diagnostics::DiagnosticLog::open(
                app_local_data_directory.join("diagnostics"),
            )?);
            if theme_recovery_needed {
                record_native_diagnostic(
                    app.handle(),
                    diagnostics::DiagnosticEventName::ThemeState,
                    diagnostics::DiagnosticOutcome::Rejected,
                    diagnostics::DiagnosticTag::ValidationRejected,
                );
            }
            app.state::<WorkspaceManager>()
                .claim_window(window.label())
                .expect("main window capacity");
            drain_second_instance_ingress(
                &window,
                window.label(),
                &app.state::<OpenRequestCoordinator>(),
                &app.state::<SecondInstanceIngress>(),
            );
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                if window.state::<QuitCoordinator>().is_shutting_down() {
                    return;
                }
                let ingress = window.state::<SecondInstanceIngress>();
                ingress.enqueue_paths(paths.iter().cloned());
                drain_second_instance_ingress(
                    window,
                    window.label(),
                    &window.state::<OpenRequestCoordinator>(),
                    &ingress,
                );
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let label = window.label().to_owned();
                let coordinator = window.state::<WindowCloseCoordinator>();
                let (request_id, ready) = coordinator.request(&label);
                if ready {
                    let _ = window.emit_to(
                        &label,
                        "window-close-requested",
                        WindowCloseRequest { request_id },
                    );
                }
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    std::thread::sleep(Duration::from_secs(5));
                    if !app
                        .state::<WindowCloseCoordinator>()
                        .claim_timeout(&label, request_id)
                    {
                        return;
                    }
                    record_native_diagnostic(
                        &app,
                        diagnostics::DiagnosticEventName::Quit,
                        diagnostics::DiagnosticOutcome::Failure,
                        diagnostics::DiagnosticTag::Timeout,
                    );
                    if let Some(target) = app.get_webview_window(&label) {
                        let workspace = app.state::<WorkspaceManager>();
                        if let Some(owner) = workspace.active_owner(&label) {
                            drain_owner_for_lifecycle(
                                &app.state::<OpenRequestCoordinator>(),
                                &workspace,
                                &app.state::<PdfSessionManager>(),
                                &owner,
                            );
                        }
                        let _ = target.destroy();
                    }
                });
            }
            tauri::WindowEvent::Destroyed => {
                let label = window.label().to_owned();
                window.state::<WindowCloseCoordinator>().remove(&label);
                window.state::<AppWindowRegistry>().remove(&label);
                let workspace = window.state::<WorkspaceManager>();
                if let Some(owner) = workspace.active_owner(&label) {
                    drain_owner_for_lifecycle(
                        &window.state::<OpenRequestCoordinator>(),
                        &workspace,
                        &window.state::<PdfSessionManager>(),
                        &owner,
                    );
                }
                if let Some(all_renderers_drained) =
                    window.state::<QuitCoordinator>().acknowledge(&label, false)
                {
                    complete_quit_application(window.app_handle(), all_renderers_drained);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            begin_quit,
            renderer_ready,
            finish_quit,
            read_config,
            write_default_config,
            reset_config,
            read_indicator_state,
            commit_indicator_state,
            read_theme_state,
            commit_theme_state,
            record_diagnostic,
            create_app_window,
            window_close_ready,
            close_current_window,
            open_pdf_dialog,
            record_recent,
            list_recents,
            open_recent,
            list_pending_open_ingress,
            ack_open_failure,
            claim_open_request,
            ack_open_request,
            reject_open_request,
            prepare_external_links,
            commit_external_links,
            finalize_external_links,
            abort_external_links,
            open_external_link,
            cancel_pdf_session,
            close_pdf_session
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Modeleaf")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit)
                && app.state::<QuitCoordinator>().claim_cleanup()
            {
                drain_app_owners(app);
                shutdown_external_link_dispatcher();
            }
        });
}
#[cfg(test)]
mod window_lifecycle_tests {
    use super::{select_shell_open_label, WindowCloseCoordinator};

    #[test]
    fn close_requests_are_replayed_and_acknowledged_per_window() {
        let coordinator = WindowCloseCoordinator::default();
        let (left_request, left_ready) = coordinator.request("left");
        let (right_request, right_ready) = coordinator.request("right");
        assert_eq!(coordinator.request("left"), (left_request, false));
        assert!(!left_ready);
        assert!(!right_ready);
        assert_eq!(coordinator.ready("left"), Some(left_request));
        assert!(coordinator.acknowledge("left", Some(left_request)));
        assert!(!coordinator.claim_timeout("left", left_request));
        assert!(coordinator.claim_timeout("right", right_request));
    }

    #[test]
    fn stale_close_acknowledgement_cannot_claim_a_peer_window() {
        let coordinator = WindowCloseCoordinator::default();
        coordinator.ready("left");
        coordinator.ready("right");
        let (left_request, _) = coordinator.request("left");
        let (right_request, _) = coordinator.request("right");
        assert!(!coordinator.acknowledge("right", Some(left_request)));
        assert!(coordinator.acknowledge("right", Some(right_request)));
        assert!(coordinator.claim_timeout("left", left_request));
    }

    #[test]
    fn shell_open_prefers_the_focused_window_over_label_order() {
        let windows = [("main", false), ("reader-00ff", true)];
        assert_eq!(select_shell_open_label(&windows), Some("reader-00ff"));
    }

    #[test]
    fn shell_open_falls_back_to_a_live_window_when_main_is_closed() {
        let windows = [("reader-00ff", false), ("reader-00aa", false)];
        assert_eq!(select_shell_open_label(&windows), Some("reader-00aa"));
    }

    #[test]
    fn shell_open_selection_is_stable_regardless_of_input_order() {
        let ascending = [("reader-00aa", false), ("reader-00ff", false)];
        let descending = [("reader-00ff", false), ("reader-00aa", false)];
        assert_eq!(
            select_shell_open_label(&ascending),
            select_shell_open_label(&descending)
        );
    }

    #[test]
    fn shell_open_has_no_target_when_no_window_is_live() {
        assert_eq!(select_shell_open_label(&[]), None);
    }
}

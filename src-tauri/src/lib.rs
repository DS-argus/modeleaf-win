pub mod diagnostics;
pub mod external_link;
pub mod local_path;
pub mod open_dialog;
pub mod open_request;
pub mod pdf_session;
pub mod recent;
pub mod theme_state;
pub mod workspace;
use crate::local_path::SystemLocalPathPolicy;
use external_link::{launch_external_link, shutdown_external_link_dispatcher, ExternalLinkError};
use open_dialog::choose_pdf_file;
use open_request::{
    resolve_second_instance_paths, OpenFailureId, OpenRequestCoordinator, OpenRequestError,
    OpenRequestId,
};
use pdf_session::{
    CancelBarrier, ExternalLinkRegistration, PdfOwner, PdfSessionError, PdfSessionManager,
    SessionId,
};
use recent::{RecentDocument, RecentStore, RecentStoreError};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{ipc::Response, Emitter, Manager, State, Window};
use theme_state::{ThemeId, ThemeStateError, ThemeStateManager};
use workspace::{WorkspaceError, WorkspaceManager};

#[derive(Clone, Default)]
pub struct QuitCoordinator {
    shutting_down: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
}

impl QuitCoordinator {
    pub fn begin(&self) -> bool {
        self.shutting_down
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }
    fn claim_finish(&self) -> bool {
        self.is_shutting_down()
            && self
                .finished
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
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

fn begin_quit_application<R: tauri::Runtime + 'static>(app: &tauri::AppHandle<R>) {
    if app.state::<QuitCoordinator>().begin() {
        let _ = app.emit("quit-requested", ());
        let fallback = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            finish_quit_application(&fallback, false);
        });
    }
}

fn finish_quit_application<R: tauri::Runtime>(app: &tauri::AppHandle<R>, renderer_drained: bool) {
    if !app.state::<QuitCoordinator>().claim_finish() {
        return;
    }
    drain_app_owners(app);
    shutdown_external_link_dispatcher();
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

#[tauri::command]
fn begin_quit(app: tauri::AppHandle) {
    begin_quit_application(&app);
}

#[tauri::command]
fn renderer_ready(app: tauri::AppHandle) {
    if app.state::<QuitCoordinator>().is_shutting_down() {
        let _ = app.emit("quit-requested", ());
    }
}

#[tauri::command]
fn finish_quit(app: tauri::AppHandle, renderer_drained: bool) {
    finish_quit_application(&app, renderer_drained);
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
enum RecentCommandError {
    OwnerMismatch,
    Session(PdfSessionError),
    NotFound,
    RemotePath,
    PathRejected,
    PdfInvalid,
    Storage,
}

impl std::fmt::Display for RecentCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::OwnerMismatch => "RECENT_OWNER_MISMATCH",
            Self::Session(error) => error.tag(),
            Self::NotFound => "RECENT_NOT_FOUND",
            Self::RemotePath => "RECENT_REMOTE_PATH",
            Self::PathRejected => "RECENT_PATH_REJECTED",
            Self::PdfInvalid => "RECENT_PDF_INVALID",
            Self::Storage => "RECENT_STORAGE_FAILED",
        })
    }
}
impl std::error::Error for RecentCommandError {}

fn recent_store_error(error: RecentStoreError) -> RecentCommandError {
    match error {
        RecentStoreError::RemotePath => RecentCommandError::RemotePath,
        RecentStoreError::PathRejected => RecentCommandError::PathRejected,
        RecentStoreError::NotPdf => RecentCommandError::PdfInvalid,
        RecentStoreError::MissingRecentId => RecentCommandError::NotFound,
        RecentStoreError::Io(_) | RecentStoreError::OrdinalExhausted => RecentCommandError::Storage,
    }
}

fn recent_open_failure(error: RecentStoreError) -> OpenRequestError {
    match error {
        RecentStoreError::NotPdf => OpenRequestError::Session(PdfSessionError::PdfInvalid),
        RecentStoreError::Io(_) => OpenRequestError::Session(PdfSessionError::FileUnreadable),
        // A recent path is never trusted as route provenance; collapse it at the coordinator.
        RecentStoreError::RemotePath
        | RecentStoreError::PathRejected
        | RecentStoreError::MissingRecentId
        | RecentStoreError::OrdinalExhausted => {
            OpenRequestError::Session(PdfSessionError::PathRejected)
        }
    }
}

fn recent_owner(
    workspace: &WorkspaceManager,
    window: &Window,
) -> Result<PdfOwner, RecentCommandError> {
    workspace
        .active_owner(window.label())
        .ok_or(RecentCommandError::OwnerMismatch)
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

#[tauri::command]
fn open_pdf_dialog(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
) -> Result<Option<open_request::OpenRequestNotice>, OpenRequestError> {
    match choose_pdf_file(&window) {
        Ok(Some(path)) => match coordinator.ingest_path(window.label(), &path) {
            Ok(notice) => Ok(Some(notice)),
            Err(error) => {
                publish_open_failure(&window, window.label(), &coordinator, error)?;
                Ok(None)
            }
        },
        Ok(None) => Ok(None),
        Err(error) => {
            publish_open_failure(&window, window.label(), &coordinator, error.into())?;
            Ok(None)
        }
    }
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

#[tauri::command]
fn record_recent(
    window: Window,
    sessions: State<'_, PdfSessionManager>,
    workspace: State<'_, WorkspaceManager>,
    recents: State<'_, Mutex<RecentStore>>,
    session_id: String,
    document_generation: u64,
) -> Result<RecentDocument, RecentCommandError> {
    let owner = recent_owner(&workspace, &window)?;
    let session_id = SessionId::from_opaque(session_id)
        .map_err(|_| RecentCommandError::Session(PdfSessionError::SessionNotFound))?;
    let identity = sessions
        .trusted_recent_identity(&owner, &session_id, document_generation)
        .map_err(RecentCommandError::Session)?;
    let mut recents = recents.lock().expect("recent store state poisoned");
    let document = recents
        .record_trusted_opened_and_save(identity)
        .map_err(recent_store_error)?;
    Ok(document)
}

#[tauri::command]
fn list_recents(recents: State<'_, Mutex<RecentStore>>) -> Vec<RecentDocument> {
    recents
        .lock()
        .expect("recent store state poisoned")
        .documents()
}

#[tauri::command]
fn open_recent(
    window: Window,
    coordinator: State<'_, OpenRequestCoordinator>,
    recents: State<'_, Mutex<RecentStore>>,
    recent_id: String,
) -> Result<(), RecentCommandError> {
    let path = match recents
        .lock()
        .expect("recent store state poisoned")
        .resolve_for_open(&recent_id, &SystemLocalPathPolicy)
    {
        Ok(path) => path,
        Err(error) => {
            publish_open_failure(
                &window,
                window.label(),
                &coordinator,
                recent_open_failure(error),
            )
            .map_err(|error| match error {
                OpenRequestError::OwnerMismatch => RecentCommandError::OwnerMismatch,
                OpenRequestError::Capacity => {
                    RecentCommandError::Session(PdfSessionError::SessionCapacity)
                }
                OpenRequestError::Session(error) => RecentCommandError::Session(error),
                _ => RecentCommandError::Storage,
            })?;
            return Ok(());
        }
    };
    emit_open_request(&window, window.label(), &coordinator, &path).map_err(|error| match error {
        OpenRequestError::Session(error) => RecentCommandError::Session(error),
        OpenRequestError::OwnerMismatch => RecentCommandError::OwnerMismatch,
        OpenRequestError::Capacity => RecentCommandError::Session(PdfSessionError::SessionCapacity),
        _ => RecentCommandError::Storage,
    })
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
    operation_id: String,
    operation_sequence: u64,
    state: State<'_, PdfSessionManager>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    registry_revision: u64,
    annotation_id: String,
) -> Result<(), ExternalLinkError> {
    let session_id =
        SessionId::from_opaque(session_id).map_err(|_| ExternalLinkError::SessionNotFound)?;
    let owner = command_owner(&window, owner_generation);
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.activate_external_link_with_operation(
            &owner,
            &session_id,
            document_generation,
            registry_revision,
            &annotation_id,
            &operation_id,
            operation_sequence,
            launch_external_link,
        )
    })
    .await
    .map_err(|_| ExternalLinkError::LinkLaunchFailed)?
}
#[tauri::command]
async fn read_pdf_range(
    window: Window,
    state: State<'_, PdfSessionManager>,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    offset: u64,
    length: u32,
) -> Result<Response, PdfSessionError> {
    let session_id = SessionId::from_opaque(session_id)?;
    let bytes = state.read_range(
        &command_owner(&window, owner_generation),
        &session_id,
        document_generation,
        offset,
        length,
    )?;
    Ok(Response::new(bytes))
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
    state.cancel(
        &command_owner(&window, owner_generation),
        &session_id,
        document_generation,
    )
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
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sessions = PdfSessionManager::new();
    let workspace = WorkspaceManager::new();
    let coordinator = OpenRequestCoordinator::new(sessions.clone(), workspace.clone());
    let second_instance_ingress = SecondInstanceIngress::default();
    second_instance_ingress.enqueue_paths(std::env::args_os().skip(1).map(PathBuf::from));
    tauri::Builder::default()
        .manage(second_instance_ingress)
        .manage(QuitCoordinator::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if app.state::<QuitCoordinator>().is_shutting_down() {
                return;
            }
            let ingress = app.state::<SecondInstanceIngress>();
            enqueue_second_instance(&ingress, argv, &cwd);
            if let Some(window) = app.get_webview_window("main") {
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
            let app_data_directory = app.path().app_data_dir()?;
            let window = app.get_webview_window("main").expect("main window missing");
            let mut recents = RecentStore::load(
                app_data_directory.join("recent.json"),
                &SystemLocalPathPolicy,
            )?;
            let recent_recovery_needed = recents.take_startup_recovery_needed();
            app.manage(Mutex::new(recents));
            let themes = ThemeStateManager::load(app_data_directory.join("theme-state.json"));
            let theme_recovery_needed = themes.take_startup_recovery_needed();
            app.manage(themes);
            app.manage(diagnostics::DiagnosticLog::open(
                app_data_directory.join("diagnostics"),
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
            if recent_recovery_needed {
                let _ = publish_open_failure(
                    &window,
                    window.label(),
                    &app.state::<OpenRequestCoordinator>(),
                    OpenRequestError::Session(PdfSessionError::FileUnreadable),
                );
            }
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
                begin_quit_application(&window.app_handle());
            }
            tauri::WindowEvent::Destroyed => {
                let workspace = window.state::<WorkspaceManager>();
                if let Some(owner) = workspace.active_owner(window.label()) {
                    drain_owner_for_lifecycle(
                        &window.state::<OpenRequestCoordinator>(),
                        &workspace,
                        &window.state::<PdfSessionManager>(),
                        &owner,
                    );
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            begin_quit,
            renderer_ready,
            finish_quit,
            read_theme_state,
            commit_theme_state,
            record_diagnostic,
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
            read_pdf_range,
            cancel_pdf_session,
            close_pdf_session
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Modeleaf")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) && app.state::<QuitCoordinator>().begin() {
                drain_app_owners(app);
                shutdown_external_link_dispatcher();
            }
        });
}

pub mod external_link;
pub mod local_path;
pub mod open_dialog;
pub mod pdf_session;

use external_link::{launch_external_link, shutdown_external_link_dispatcher, ExternalLinkError};
use open_dialog::{choose_pdf_file, open_selected_path, OpenPdfResponse};
use pdf_session::{
    CancelBarrier, ExternalLinkRegistration, PdfOwner, PdfSessionError, PdfSessionManager,
    SessionId,
};
use tauri::{ipc::Response, Manager, State, Window};

fn command_owner(window: &Window, generation: u64) -> PdfOwner {
    PdfOwner {
        window_label: window.label().to_owned(),
        generation,
    }
}
#[tauri::command]
fn open_pdf_dialog(
    window: Window,
    state: State<'_, PdfSessionManager>,
    owner_generation: u64,
) -> Result<Option<OpenPdfResponse>, PdfSessionError> {
    let selected = choose_pdf_file(&window)?;
    open_selected_path(
        &state,
        command_owner(&window, owner_generation),
        selected.as_deref(),
    )
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
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    barrier_id: u64,
) -> Result<(), PdfSessionError> {
    let session_id = SessionId::from_opaque(session_id)?;
    state.close(
        &command_owner(&window, owner_generation),
        &session_id,
        document_generation,
        barrier_id,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PdfSessionManager::new())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<PdfSessionManager>()
                    .drain_owner(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_pdf_dialog,
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
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<PdfSessionManager>().drain_all();
                shutdown_external_link_dispatcher();
            }
        });
}

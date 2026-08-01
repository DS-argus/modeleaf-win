pub mod local_path;
pub mod open_dialog;
pub mod pdf_session;

use open_dialog::{choose_pdf_file, open_selected_path, OpenPdfResponse};
use pdf_session::{CancelBarrier, PdfOwner, PdfSessionError, PdfSessionManager, SessionId};
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
            read_pdf_range,
            cancel_pdf_session,
            close_pdf_session
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Modeleaf")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<PdfSessionManager>().drain_all();
            }
        });
}

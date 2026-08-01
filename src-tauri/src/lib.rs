pub mod local_path;
pub mod pdf_session;

use pdf_session::{CancelBarrier, PdfOwner, PdfSessionError, PdfSessionManager, SessionId};
use tauri::{ipc::Response, State, Window};

fn command_owner(window: &Window, generation: u64) -> PdfOwner {
    PdfOwner {
        window_label: window.label().to_owned(),
        generation,
    }
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
        .invoke_handler(tauri::generate_handler![
            read_pdf_range,
            cancel_pdf_session,
            close_pdf_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Modeleaf");
}

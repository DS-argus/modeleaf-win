use crate::pdf_session::{PdfSessionError, PdfSessionManager, SessionId};
use tauri::{State, Window};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag="tag", rename_all="SCREAMING_SNAKE_CASE", rename_all_fields="camelCase")]
pub enum PathShortcutOutcome { Shown { text: String }, Copied { text: String }, Rejected { reason: String } }

fn resolve(window: &Window, sessions: &PdfSessionManager, session_id: String, document_generation: u64, owner_generation: u64) -> Result<std::path::PathBuf, PdfSessionError> {
    let id = SessionId::from_opaque(session_id)?;
    sessions.trusted_recent_identity(&crate::pdf_session::PdfOwner { window_label: window.label().to_owned(), generation: owner_generation }, &id, document_generation).map(|i| i.canonical_path().to_path_buf())
}

#[tauri::command]
pub fn path_shortcut(window: Window, sessions: State<'_, PdfSessionManager>, action: String, session_id: String, document_generation: u64, owner_generation: u64) -> PathShortcutOutcome {
    let path = match resolve(&window, &sessions, session_id, document_generation, owner_generation) { Ok(p) => p, Err(e) => return PathShortcutOutcome::Rejected { reason: format!("{e:?}") } };
    match action.as_str() {
        "y" => PathShortcutOutcome::Shown { text: path.parent().unwrap_or(path.as_path()).to_string_lossy().into_owned() },
        "yy" => {
            let text = path.to_string_lossy().into_owned();
            match copy_clipboard(&text) { Ok(()) => PathShortcutOutcome::Copied { text }, Err(reason) => PathShortcutOutcome::Rejected { reason } }
        }
        _ => PathShortcutOutcome::Rejected { reason: "UNKNOWN_ACTION".into() },
    }
}

#[cfg(windows)]
fn copy_clipboard(text: &str) -> Result<(), String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    unsafe {
        OpenClipboard(None).map_err(|_| "CLIPBOARD_UNAVAILABLE".to_owned())?;
        EmptyClipboard().map_err(|_| { let _=CloseClipboard(); "CLIPBOARD_UNAVAILABLE".to_owned() })?;
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = GlobalAlloc(GMEM_MOVEABLE, wide.len()*2).map_err(|_| "CLIPBOARD_UNAVAILABLE".to_owned())?;
        let ptr = GlobalLock(handle) as *mut u16;
        if ptr.is_null() { let _=CloseClipboard(); return Err("CLIPBOARD_UNAVAILABLE".into()); }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len()); GlobalUnlock(handle).ok();
        SetClipboardData(13, Some(HANDLE(handle.0))).map_err(|_| "CLIPBOARD_UNAVAILABLE".to_owned())?;
        CloseClipboard().map_err(|_| "CLIPBOARD_UNAVAILABLE".to_owned())
    }
}
#[cfg(not(windows))] fn copy_clipboard(_: &str) -> Result<(), String> { Err("UNSUPPORTED_PLATFORM".into()) }

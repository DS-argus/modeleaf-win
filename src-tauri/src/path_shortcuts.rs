use crate::pdf_session::{PdfOwner, PdfSessionError, PdfSessionManager, SessionId};
use tauri::{Manager, Window};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(
    tag = "tag",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum PathShortcutOutcome {
    Shown { text: String },
    Copied { text: String },
    Rejected { reason: String },
}
#[derive(Clone, Copy)]
enum PathAction {
    Show,
    Copy,
}

#[tauri::command]
pub async fn path_shortcut(
    window: Window,
    action: String,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
) -> PathShortcutOutcome {
    let action = match action.as_str() {
        "y" => PathAction::Show,
        "yy" => PathAction::Copy,
        _ => {
            return PathShortcutOutcome::Rejected {
                reason: "UNKNOWN_ACTION".into(),
            }
        }
    };
    let id = match SessionId::from_opaque(session_id) {
        Ok(id) => id,
        Err(error) => {
            return PathShortcutOutcome::Rejected {
                reason: format!("{error:?}"),
            }
        }
    };
    let sessions = window.state::<PdfSessionManager>().inner().clone();
    let owner = PdfOwner {
        window_label: window.label().to_owned(),
        generation: owner_generation,
    };
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    sessions.enqueue_trusted_identity(owner, id, document_generation, move |result, completion| {
        let outcome = match completion.guard_result(result) {
            Err(error) => PathShortcutOutcome::Rejected {
                reason: if error == PdfSessionError::SessionCapacity {
                    "SESSION_CAPACITY".into()
                } else {
                    format!("{error:?}")
                },
            },
            Ok(identity) => {
                let text = identity.canonical_path().to_string_lossy().into_owned();
                match action {
                    PathAction::Show => PathShortcutOutcome::Shown { text },
                    PathAction::Copy => match copy_clipboard(&text) {
                        Ok(()) => PathShortcutOutcome::Copied { text },
                        Err(reason) => PathShortcutOutcome::Rejected { reason },
                    },
                }
            }
        };
        let _ = sender.try_send(outcome);
        drop(completion);
    });
    receiver
        .recv()
        .await
        .unwrap_or(PathShortcutOutcome::Rejected {
            reason: "FILE_UNREADABLE".into(),
        })
}

#[cfg(windows)]
fn copy_clipboard(text: &str) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    unsafe {
        OpenClipboard(None).map_err(|_| "CLIPBOARD_UNAVAILABLE".to_owned())?;
        EmptyClipboard().map_err(|_| {
            let _ = CloseClipboard();
            "CLIPBOARD_UNAVAILABLE".to_owned()
        })?;
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2)
            .map_err(|_| "CLIPBOARD_UNAVAILABLE".to_owned())?;
        let ptr = GlobalLock(handle) as *mut u16;
        if ptr.is_null() {
            let _ = CloseClipboard();
            return Err("CLIPBOARD_UNAVAILABLE".into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
        GlobalUnlock(handle).ok();
        SetClipboardData(13, Some(HANDLE(handle.0)))
            .map_err(|_| "CLIPBOARD_UNAVAILABLE".to_owned())?;
        CloseClipboard().map_err(|_| "CLIPBOARD_UNAVAILABLE".to_owned())
    }
}
#[cfg(not(windows))]
fn copy_clipboard(_: &str) -> Result<(), String> {
    Err("UNSUPPORTED_PLATFORM".into())
}

use crate::pdf_session::{PdfOwner, PdfSessionError, PdfSessionManager, SessionId};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PdfDialogError {
    OwnerUnavailable,
    PickerFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PdfDialogDispatchError {
    DispatchFailed,
    ResultDropped,
}

pub type MainThreadDialogTask = Box<dyn FnOnce() + Send + 'static>;

pub async fn dispatch_pdf_dialog<D, E, F>(
    dispatch: D,
    picker: F,
) -> Result<Result<Option<PathBuf>, PdfDialogError>, PdfDialogDispatchError>
where
    D: FnOnce(MainThreadDialogTask) -> Result<(), E>,
    F: FnOnce() -> Result<Option<PathBuf>, PdfDialogError> + Send + 'static,
{
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    dispatch(Box::new(move || {
        let _ = sender.try_send(picker());
    }))
    .map_err(|_| PdfDialogDispatchError::DispatchFailed)?;

    receiver
        .recv()
        .await
        .ok_or(PdfDialogDispatchError::ResultDropped)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPdfResponse {
    pub session_id: SessionId,
    pub document_generation: u64,
    pub length: u64,
    pub display_name: String,
}

fn sanitized_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy())
        .filter(|name| !name.is_empty())
        .map(|name| {
            name.chars()
                .map(|character| {
                    if character.is_control() || character == '/' || character == '\\' {
                        '\u{FFFD}'
                    } else {
                        character
                    }
                })
                .collect()
        })
        .unwrap_or_else(|| "document.pdf".to_owned())
}

pub fn open_selected_path(
    manager: &PdfSessionManager,
    owner: PdfOwner,
    selected: Option<&Path>,
) -> Result<Option<OpenPdfResponse>, PdfSessionError> {
    let Some(path) = selected else {
        return Ok(None);
    };
    let metadata = manager.open_local_file(owner, path)?;
    Ok(Some(OpenPdfResponse {
        session_id: metadata.session_id,
        document_generation: metadata.document_generation,
        length: metadata.length,
        display_name: sanitized_display_name(path),
    }))
}

#[cfg(windows)]
pub fn choose_pdf_file(owner_hwnd: isize) -> Result<Option<PathBuf>, PdfDialogError> {
    use std::ffi::c_void;
    use windows::core::w;
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_DONTADDTORECENT, FOS_FILEMUSTEXIST,
        FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_STRICTFILETYPES, SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

    let owner = HWND(owner_hwnd as *mut c_void);
    if owner.is_invalid() || !unsafe { IsWindow(Some(owner)) }.as_bool() {
        return Err(PdfDialogError::OwnerUnavailable);
    }
    let owner_thread = unsafe { GetWindowThreadProcessId(owner, None) };
    if owner_thread == 0 || owner_thread != unsafe { GetCurrentThreadId() } {
        return Err(PdfDialogError::OwnerUnavailable);
    }

    let initialized =
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if initialized.is_err() {
        return Err(PdfDialogError::PickerFailed);
    }
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    // CoInitializeEx returning S_FALSE is still a successful balanced initialization.
    let _com_guard = ComGuard;

    let dialog: IFileOpenDialog = unsafe {
        CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| PdfDialogError::PickerFailed)?
    };
    let filters = [COMDLG_FILTERSPEC {
        pszName: w!("PDF files (*.pdf)"),
        pszSpec: w!("*.pdf"),
    }];
    unsafe {
        dialog
            .SetFileTypes(&filters)
            .map_err(|_| PdfDialogError::PickerFailed)?;
        dialog
            .SetFileTypeIndex(1)
            .map_err(|_| PdfDialogError::PickerFailed)?;
        let options = dialog
            .GetOptions()
            .map_err(|_| PdfDialogError::PickerFailed)?;
        dialog
            .SetOptions(
                options
                    | FOS_FORCEFILESYSTEM
                    | FOS_FILEMUSTEXIST
                    | FOS_PATHMUSTEXIST
                    | FOS_STRICTFILETYPES
                    | FOS_DONTADDTORECENT,
            )
            .map_err(|_| PdfDialogError::PickerFailed)?;
        if let Err(error) = dialog.Show(Some(owner)) {
            return if error.code() == ERROR_CANCELLED.to_hresult() {
                Ok(None)
            } else {
                Err(PdfDialogError::PickerFailed)
            };
        }
        let item = dialog
            .GetResult()
            .map_err(|_| PdfDialogError::PickerFailed)?;
        let display_name = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|_| PdfDialogError::PickerFailed)?;
        let decoded = display_name.to_string();
        CoTaskMemFree(Some(display_name.0.cast()));
        decoded
            .map(PathBuf::from)
            .map(Some)
            .map_err(|_| PdfDialogError::PickerFailed)
    }
}
#[cfg(not(windows))]
pub fn choose_pdf_file(owner_hwnd: isize) -> Result<Option<PathBuf>, PdfDialogError> {
    if owner_hwnd == 0 {
        Err(PdfDialogError::OwnerUnavailable)
    } else {
        Err(PdfDialogError::PickerFailed)
    }
}

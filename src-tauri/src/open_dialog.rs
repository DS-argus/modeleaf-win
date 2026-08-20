use crate::pdf_session::{PdfOwner, PdfSessionError, PdfSessionManager, SessionId};
use serde::Serialize;
use std::path::{Path, PathBuf};

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
pub fn choose_pdf_file(owner_hwnd: isize) -> Result<Option<PathBuf>, PdfSessionError> {
    use std::ffi::c_void;
    use windows::core::w;
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_DONTADDTORECENT, FOS_FILEMUSTEXIST,
        FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_STRICTFILETYPES, SIGDN_FILESYSPATH,
    };

    if owner_hwnd == 0 {
        return Err(PdfSessionError::DialogFailed);
    }
    let initialized =
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if initialized.is_err() {
        return Err(PdfSessionError::DialogFailed);
    }
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _com_guard = ComGuard;

    let dialog: IFileOpenDialog = unsafe {
        CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| PdfSessionError::DialogFailed)?
    };
    let filters = [COMDLG_FILTERSPEC {
        pszName: w!("PDF files (*.pdf)"),
        pszSpec: w!("*.pdf"),
    }];
    unsafe {
        dialog
            .SetFileTypes(&filters)
            .map_err(|_| PdfSessionError::DialogFailed)?;
        dialog
            .SetFileTypeIndex(1)
            .map_err(|_| PdfSessionError::DialogFailed)?;
        let options = dialog
            .GetOptions()
            .map_err(|_| PdfSessionError::DialogFailed)?;
        dialog
            .SetOptions(
                options
                    | FOS_FORCEFILESYSTEM
                    | FOS_FILEMUSTEXIST
                    | FOS_PATHMUSTEXIST
                    | FOS_STRICTFILETYPES
                    | FOS_DONTADDTORECENT,
            )
            .map_err(|_| PdfSessionError::DialogFailed)?;
        if let Err(error) = dialog.Show(Some(HWND(owner_hwnd as *mut c_void))) {
            return if error.code() == ERROR_CANCELLED.to_hresult() {
                Ok(None)
            } else {
                Err(PdfSessionError::DialogFailed)
            };
        }
        let item = dialog
            .GetResult()
            .map_err(|_| PdfSessionError::DialogFailed)?;
        let display_name = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|_| PdfSessionError::DialogFailed)?;
        let decoded = display_name.to_string();
        CoTaskMemFree(Some(display_name.0.cast()));
        decoded
            .map(PathBuf::from)
            .map(Some)
            .map_err(|_| PdfSessionError::DialogFailed)
    }
}
#[cfg(not(windows))]
pub fn choose_pdf_file(_owner_hwnd: isize) -> Result<Option<PathBuf>, PdfSessionError> {
    Err(PdfSessionError::DialogFailed)
}

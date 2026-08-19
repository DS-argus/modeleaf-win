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

    #[repr(C)]
    struct OpenFileNameW {
        l_struct_size: u32,
        hwnd_owner: isize,
        h_instance: isize,
        filter: *const u16,
        custom_filter: *mut u16,
        max_custom_filter: u32,
        filter_index: u32,
        file: *mut u16,
        max_file: u32,
        file_title: *mut u16,
        max_file_title: u32,
        initial_dir: *const u16,
        title: *const u16,
        flags: u32,
        file_offset: u16,
        file_extension: u16,
        default_extension: *const u16,
        custom_data: isize,
        hook: *mut c_void,
        template_name: *const u16,
        reserved: *mut c_void,
        reserved_dword: u32,
        flags_ex: u32,
    }

    #[link(name = "comdlg32")]
    unsafe extern "system" {
        fn GetOpenFileNameW(open_file_name: *mut OpenFileNameW) -> i32;
        fn CommDlgExtendedError() -> u32;
    }

    const OFN_EXPLORER: u32 = 0x0008_0000;
    const OFN_FILEMUSTEXIST: u32 = 0x0000_1000;
    const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
    const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
    const OFN_DONTADDTORECENT: u32 = 0x0200_0000;

    let filter: Vec<u16> = "PDF files (*.pdf)\0*.pdf\0\0".encode_utf16().collect();
    let mut file = vec![0_u16; 32_768];
    let mut open_file_name = OpenFileNameW {
        l_struct_size: u32::try_from(std::mem::size_of::<OpenFileNameW>())
            .map_err(|_| PdfSessionError::DialogFailed)?,
        hwnd_owner: owner_hwnd,
        h_instance: 0,
        filter: filter.as_ptr(),
        custom_filter: std::ptr::null_mut(),
        max_custom_filter: 0,
        filter_index: 1,
        file: file.as_mut_ptr(),
        max_file: u32::try_from(file.len()).map_err(|_| PdfSessionError::DialogFailed)?,
        file_title: std::ptr::null_mut(),
        max_file_title: 0,
        initial_dir: std::ptr::null(),
        title: std::ptr::null(),
        flags: OFN_EXPLORER
            | OFN_FILEMUSTEXIST
            | OFN_PATHMUSTEXIST
            | OFN_NOCHANGEDIR
            | OFN_DONTADDTORECENT,
        file_offset: 0,
        file_extension: 0,
        default_extension: std::ptr::null(),
        custom_data: 0,
        hook: std::ptr::null_mut(),
        template_name: std::ptr::null(),
        reserved: std::ptr::null_mut(),
        reserved_dword: 0,
        flags_ex: 0,
    };
    if unsafe { GetOpenFileNameW(&mut open_file_name) } == 0 {
        return if unsafe { CommDlgExtendedError() } == 0 {
            Ok(None)
        } else {
            Err(PdfSessionError::DialogFailed)
        };
    }
    let length = file
        .iter()
        .position(|unit| *unit == 0)
        .ok_or(PdfSessionError::DialogFailed)?;
    Ok(Some(PathBuf::from(
        String::from_utf16(&file[..length]).map_err(|_| PdfSessionError::DialogFailed)?,
    )))
}

#[cfg(not(windows))]
pub fn choose_pdf_file(_owner_hwnd: isize) -> Result<Option<PathBuf>, PdfSessionError> {
    Err(PdfSessionError::DialogFailed)
}

use crate::pdf_session::{PdfOwner, PdfSessionError, PdfSessionManager, SessionId};
use serde::Serialize;
use std::panic::{catch_unwind, AssertUnwindSafe};
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

pub type PdfDialogResult = Result<Option<PathBuf>, PdfDialogError>;
pub type MainThreadDialogTask = Box<dyn FnOnce() + Send + 'static>;
pub type PostedDialogPicker = Box<dyn FnOnce(isize) -> PdfDialogResult + Send + 'static>;
pub type PostedDialogCompletion = Box<dyn FnOnce(PdfDialogResult) + Send + 'static>;

pub async fn dispatch_pdf_dialog<D, E, S, SE, F>(
    dispatch: D,
    schedule: S,
    picker: F,
) -> Result<PdfDialogResult, PdfDialogDispatchError>
where
    D: FnOnce(MainThreadDialogTask) -> Result<(), E>,
    S: FnOnce(PostedDialogPicker, PostedDialogCompletion) -> Result<(), SE> + Send + 'static,
    F: FnOnce(isize) -> PdfDialogResult + Send + 'static,
{
    let (sender, mut receiver) =
        tauri::async_runtime::channel::<Result<PdfDialogResult, PdfDialogDispatchError>>(1);
    let schedule_failure_sender = sender.clone();
    dispatch(Box::new(move || {
        let completion: PostedDialogCompletion = Box::new(move |result| {
            let _ = sender.try_send(Ok(result));
        });
        let scheduled = catch_unwind(AssertUnwindSafe(|| schedule(Box::new(picker), completion)));
        if !matches!(scheduled, Ok(Ok(()))) {
            let _ = schedule_failure_sender.try_send(Err(PdfDialogDispatchError::DispatchFailed));
        }
    }))
    .map_err(|_| PdfDialogDispatchError::DispatchFailed)?;

    receiver
        .recv()
        .await
        .ok_or(PdfDialogDispatchError::ResultDropped)?
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
fn validated_owner(
    owner_hwnd: isize,
) -> Result<(windows::Win32::Foundation::HWND, u32), PdfDialogError> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

    let owner = HWND(owner_hwnd as *mut c_void);
    if owner.is_invalid() || !unsafe { IsWindow(Some(owner)) }.as_bool() {
        return Err(PdfDialogError::OwnerUnavailable);
    }
    let mut owner_process = 0;
    let owner_thread = unsafe { GetWindowThreadProcessId(owner, Some(&mut owner_process)) };
    if owner_thread == 0
        || owner_thread != unsafe { GetCurrentThreadId() }
        || owner_process != unsafe { GetCurrentProcessId() }
    {
        return Err(PdfDialogError::OwnerUnavailable);
    }
    Ok((owner, owner_thread))
}

#[cfg(windows)]
mod posted_dispatch {
    use super::{
        validated_owner, PdfDialogDispatchError, PdfDialogError, PostedDialogCompletion,
        PostedDialogPicker,
    };
    use crate::workspace::MAX_WINDOWS;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::OnceLock;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Shell::{
        DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        PostMessageW, RegisterWindowMessageW, WM_NCDESTROY,
    };

    const DIALOG_SUBCLASS_ID: usize = 0x4d4c_5044;
    const DIALOG_MESSAGE_MARKER: isize = 0x5044_714d;
    static DIALOG_MESSAGE: OnceLock<u32> = OnceLock::new();
    // Tokens are process-lifetime IDs carried by value; no queued message owns a raw pointer.
    static NEXT_DIALOG_TOKEN: AtomicUsize = AtomicUsize::new(1);

    struct DialogWork {
        picker: PostedDialogPicker,
        completion: PostedDialogCompletion,
    }

    #[derive(Debug, Eq, PartialEq)]
    enum PostedPhase<T> {
        Queued(T),
        Running,
    }

    struct PostedSlot<T> {
        token: usize,
        owner_thread: u32,
        phase: PostedPhase<T>,
    }

    struct PostedRegistry<T> {
        capacity: usize,
        slots: HashMap<isize, PostedSlot<T>>,
    }

    impl<T> PostedRegistry<T> {
        fn new(capacity: usize) -> Self {
            Self {
                capacity,
                slots: HashMap::new(),
            }
        }

        fn admit(
            &mut self,
            owner_hwnd: isize,
            token: usize,
            owner_thread: u32,
            work: T,
        ) -> Result<(), T> {
            if self.slots.contains_key(&owner_hwnd) || self.slots.len() >= self.capacity {
                return Err(work);
            }
            self.slots.insert(
                owner_hwnd,
                PostedSlot {
                    token,
                    owner_thread,
                    phase: PostedPhase::Queued(work),
                },
            );
            Ok(())
        }

        fn take_queued(&mut self, owner_hwnd: isize, token: usize, owner_thread: u32) -> Option<T> {
            let slot = self.slots.get_mut(&owner_hwnd)?;
            if slot.token != token
                || slot.owner_thread != owner_thread
                || !matches!(slot.phase, PostedPhase::Queued(_))
            {
                return None;
            }
            match std::mem::replace(&mut slot.phase, PostedPhase::Running) {
                PostedPhase::Queued(work) => Some(work),
                PostedPhase::Running => None,
            }
        }

        fn finish_running(&mut self, owner_hwnd: isize, token: usize) -> bool {
            let matches = self.slots.get(&owner_hwnd).is_some_and(|slot| {
                slot.token == token && matches!(slot.phase, PostedPhase::Running)
            });
            if matches {
                self.slots.remove(&owner_hwnd);
            }
            matches
        }

        fn remove_matching(&mut self, owner_hwnd: isize, token: usize) -> Option<PostedPhase<T>> {
            if !self
                .slots
                .get(&owner_hwnd)
                .is_some_and(|slot| slot.token == token)
            {
                return None;
            }
            self.slots.remove(&owner_hwnd).map(|slot| slot.phase)
        }
    }

    thread_local! {
        static POSTED_DIALOGS: RefCell<PostedRegistry<DialogWork>> =
            RefCell::new(PostedRegistry::new(MAX_WINDOWS));
    }

    fn registered_dialog_message() -> Option<u32> {
        let message = *DIALOG_MESSAGE.get_or_init(|| unsafe {
            RegisterWindowMessageW(w!("Modeleaf.NativePdfDialog.Dispatch.issue71.v1"))
        });
        (message != 0).then_some(message)
    }

    fn next_dialog_token() -> Option<usize> {
        NEXT_DIALOG_TOKEN
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |token| {
                token.checked_add(1)
            })
            .ok()
    }

    fn remove_slot(owner_hwnd: isize, token: usize) -> Option<PostedPhase<DialogWork>> {
        POSTED_DIALOGS.with(|registry| registry.borrow_mut().remove_matching(owner_hwnd, token))
    }

    fn remove_hook(hwnd: HWND) -> bool {
        unsafe {
            RemoveWindowSubclass(hwnd, Some(dialog_subclass_proc), DIALOG_SUBCLASS_ID).as_bool()
        }
    }

    fn rollback(owner_hwnd: isize, hwnd: HWND, token: usize, hook_installed: bool) {
        let removed = remove_slot(owner_hwnd, token);
        if hook_installed {
            let _ = remove_hook(hwnd);
        }
        drop(removed);
    }

    pub(super) fn post(
        owner_hwnd: isize,
        picker: PostedDialogPicker,
        completion: PostedDialogCompletion,
    ) -> Result<(), PdfDialogDispatchError> {
        let (owner, owner_thread) = match validated_owner(owner_hwnd) {
            Ok(owner) => owner,
            Err(error) => {
                drop(picker);
                completion(Err(error));
                return Ok(());
            }
        };
        let Some(message) = registered_dialog_message() else {
            return Err(PdfDialogDispatchError::DispatchFailed);
        };
        let Some(token) = next_dialog_token() else {
            return Err(PdfDialogDispatchError::DispatchFailed);
        };
        let work = DialogWork { picker, completion };
        let admitted = POSTED_DIALOGS.with(|registry| {
            registry
                .borrow_mut()
                .admit(owner_hwnd, token, owner_thread, work)
        });
        if admitted.is_err() {
            return Err(PdfDialogDispatchError::DispatchFailed);
        }

        if unsafe { GetWindowSubclass(owner, Some(dialog_subclass_proc), DIALOG_SUBCLASS_ID, None) }
            .as_bool()
            && !remove_hook(owner)
        {
            rollback(owner_hwnd, owner, token, false);
            return Err(PdfDialogDispatchError::DispatchFailed);
        }

        if !unsafe {
            SetWindowSubclass(owner, Some(dialog_subclass_proc), DIALOG_SUBCLASS_ID, token)
        }
        .as_bool()
        {
            rollback(owner_hwnd, owner, token, false);
            return Err(PdfDialogDispatchError::DispatchFailed);
        }

        let mut installed_ref_data = 0;
        if !unsafe {
            GetWindowSubclass(
                owner,
                Some(dialog_subclass_proc),
                DIALOG_SUBCLASS_ID,
                Some(&mut installed_ref_data),
            )
        }
        .as_bool()
            || installed_ref_data != token
        {
            rollback(owner_hwnd, owner, token, true);
            return Err(PdfDialogDispatchError::DispatchFailed);
        }

        // Posting is the boundary that lets the Tauri callback return before the picker runs.
        if unsafe {
            PostMessageW(
                Some(owner),
                message,
                WPARAM(token),
                LPARAM(DIALOG_MESSAGE_MARKER),
            )
        }
        .is_err()
        {
            rollback(owner_hwnd, owner, token, true);
            return Err(PdfDialogDispatchError::DispatchFailed);
        }
        Ok(())
    }

    fn handle_posted_dialog(hwnd: HWND, token: usize) {
        let owner_hwnd = hwnd.0 as isize;
        let owner_thread = unsafe { GetCurrentThreadId() };
        // Mark the slot running and release the registry borrow before Show's nested loop.
        let work = POSTED_DIALOGS.with(|registry| {
            registry
                .borrow_mut()
                .take_queued(owner_hwnd, token, owner_thread)
        });
        let Some(DialogWork { picker, completion }) = work else {
            return;
        };

        let picked = catch_unwind(AssertUnwindSafe(|| picker(owner_hwnd)));
        let Ok(mut result) = picked else {
            let removed = POSTED_DIALOGS
                .with(|registry| registry.borrow_mut().finish_running(owner_hwnd, token));
            if removed {
                let _ = remove_hook(hwnd);
            }
            drop(completion);
            return;
        };

        let owner_still_valid = validated_owner(owner_hwnd)
            .map(|(_, thread)| thread == owner_thread)
            .unwrap_or(false);
        let finished =
            POSTED_DIALOGS.with(|registry| registry.borrow_mut().finish_running(owner_hwnd, token));
        let hook_removed = !finished || remove_hook(hwnd);
        if !finished || !owner_still_valid {
            result = Err(PdfDialogError::OwnerUnavailable);
        } else if !hook_removed {
            result = Err(PdfDialogError::PickerFailed);
        }
        let _ = catch_unwind(AssertUnwindSafe(|| completion(result)));
    }

    fn handle_window_destroy(hwnd: HWND, token: usize) {
        let removed = remove_slot(hwnd.0 as isize, token);
        let _ = remove_hook(hwnd);
        drop(removed);
    }

    fn cleanup_after_panic(hwnd: HWND, token: usize) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let removed = remove_slot(hwnd.0 as isize, token);
            let _ = remove_hook(hwnd);
            drop(removed);
        }));
    }

    unsafe extern "system" fn dialog_subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        subclass_id: usize,
        ref_data: usize,
    ) -> LRESULT {
        let expected_message = DIALOG_MESSAGE.get().copied();
        let is_private_dispatch = expected_message.is_some_and(|expected| {
            message == expected
                && subclass_id == DIALOG_SUBCLASS_ID
                && ref_data != 0
                && wparam.0 == ref_data
                && lparam.0 == DIALOG_MESSAGE_MARKER
        });
        let handled = catch_unwind(AssertUnwindSafe(|| {
            if message == WM_NCDESTROY {
                handle_window_destroy(hwnd, ref_data);
                return false;
            }
            if is_private_dispatch {
                handle_posted_dialog(hwnd, ref_data);
                return true;
            }
            false
        }));
        match handled {
            Ok(true) => LRESULT(0),
            Ok(false) => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
            Err(_) => {
                cleanup_after_panic(hwnd, ref_data);
                if message == WM_NCDESTROY || !is_private_dispatch {
                    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
                } else {
                    LRESULT(0)
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{PostedPhase, PostedRegistry};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        #[test]
        fn registry_bounds_admission_per_owner_and_capacity() {
            let mut registry = PostedRegistry::new(2);
            assert!(registry.admit(11, 1, 101, "first").is_ok());
            assert_eq!(registry.admit(11, 2, 101, "duplicate"), Err("duplicate"));
            assert!(registry.admit(22, 3, 101, "second").is_ok());
            assert_eq!(registry.admit(33, 4, 101, "overflow"), Err("overflow"));
        }

        #[test]
        fn registry_requires_matching_owner_token_thread_and_phase() {
            let mut registry = PostedRegistry::new(1);
            registry.admit(11, 7, 101, "work").unwrap();

            assert_eq!(registry.take_queued(11, 8, 101), None);
            assert_eq!(registry.take_queued(11, 7, 202), None);
            assert_eq!(registry.take_queued(11, 7, 101), Some("work"));
            assert_eq!(registry.take_queued(11, 7, 101), None);
            assert!(registry.finish_running(11, 7));
            assert!(!registry.finish_running(11, 7));
        }

        #[test]
        fn destroy_cleanup_invalidates_a_running_token() {
            let mut registry = PostedRegistry::new(1);
            registry.admit(11, 7, 101, "work").unwrap();
            assert_eq!(registry.take_queued(11, 7, 101), Some("work"));
            assert_eq!(registry.remove_matching(11, 7), Some(PostedPhase::Running));
            assert!(!registry.finish_running(11, 7));
        }

        #[test]
        fn destroy_cleanup_drops_queued_work_exactly_once() {
            #[derive(Debug)]
            struct DropProbe(Arc<AtomicUsize>);
            impl Drop for DropProbe {
                fn drop(&mut self) {
                    self.0.fetch_add(1, Ordering::SeqCst);
                }
            }

            let drops = Arc::new(AtomicUsize::new(0));
            let mut registry = PostedRegistry::new(1);
            registry
                .admit(11, 7, 101, DropProbe(drops.clone()))
                .unwrap();
            assert!(registry.remove_matching(11, 8).is_none());
            assert_eq!(drops.load(Ordering::SeqCst), 0);

            let removed = registry.remove_matching(11, 7);
            assert!(matches!(&removed, Some(PostedPhase::Queued(_))));
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            drop(removed);
            assert_eq!(drops.load(Ordering::SeqCst), 1);
            assert!(registry.remove_matching(11, 7).is_none());
            assert_eq!(drops.load(Ordering::SeqCst), 1);
        }
    }
}

#[cfg(windows)]
pub(crate) fn post_pdf_dialog(
    owner_hwnd: isize,
    picker: PostedDialogPicker,
    completion: PostedDialogCompletion,
) -> Result<(), PdfDialogDispatchError> {
    posted_dispatch::post(owner_hwnd, picker, completion)
}

#[cfg(not(windows))]
pub(crate) fn post_pdf_dialog(
    owner_hwnd: isize,
    picker: PostedDialogPicker,
    completion: PostedDialogCompletion,
) -> Result<(), PdfDialogDispatchError> {
    completion(picker(owner_hwnd));
    Ok(())
}

#[cfg(windows)]
pub fn choose_pdf_file(owner_hwnd: isize) -> PdfDialogResult {
    use windows::core::w;
    use windows::Win32::Foundation::ERROR_CANCELLED;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_DONTADDTORECENT, FOS_FILEMUSTEXIST,
        FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_STRICTFILETYPES, SIGDN_FILESYSPATH,
    };

    let (owner, _) = validated_owner(owner_hwnd)?;
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
pub fn choose_pdf_file(owner_hwnd: isize) -> PdfDialogResult {
    if owner_hwnd == 0 {
        Err(PdfDialogError::OwnerUnavailable)
    } else {
        Err(PdfDialogError::PickerFailed)
    }
}

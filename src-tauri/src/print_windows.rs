use crate::print_job::{
    PrintPageRange, PrintWorkerCommand, PrintWorkerObserver, PrintWorkerResult, RasterPage,
};
use std::ffi::{c_void, OsString};
use std::fs;
use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicPtr, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::Duration;
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, SetLastError, ERROR_CANCELLED, ERROR_SUCCESS, HGLOBAL, HWND, LPARAM, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    DeleteDC, GetDeviceCaps, PatBlt, SetBrushOrgEx, SetStretchBltMode, StretchDIBits, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, GDI_ERROR, HALFTONE, HDC, HORZRES, LOGPIXELSX,
    LOGPIXELSY, SP_USERABORT, SRCCOPY, VERTRES, WHITENESS,
};
use windows::Win32::Storage::FileSystem::MoveFileW;
use windows::Win32::Storage::Xps::{
    AbortDoc, EndDoc, EndPage, SetAbortProc, StartDocW, StartPage, DOCINFOW,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Controls::Dialogs::{
    CommDlgExtendedError, GetSaveFileNameW, PrintDlgW, OFN_EXPLORER, OFN_OVERWRITEPROMPT,
    OFN_PATHMUSTEXIST, OPENFILENAMEW, PD_ENABLEPRINTHOOK, PD_HIDEPRINTTOFILE, PD_NOSELECTION,
    PD_PAGENUMS, PD_RETURNDC, PD_SELECTION, PD_USEDEVMODECOPIESANDCOLLATE, PRINTDLGW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumThreadWindows, GetClassNameW, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
    PostMessageW, IDCANCEL, WM_COMMAND, WM_INITDIALOG, WM_NCDESTROY,
};

const PRINT_ABORT_DOC_FAILED: &str = "PRINT_ABORT_DOC_FAILED";
const PRINT_CANCELLED: &str = "PRINT_CANCELLED";
const PRINT_COM_FAILED: &str = "PRINT_COM_FAILED";
const PRINT_DEVICE_INVALID: &str = "PRINT_DEVICE_INVALID";
const PRINT_DIALOG_FAILED: &str = "PRINT_DIALOG_FAILED";
const PRINT_DRAW_FAILED: &str = "PRINT_DRAW_FAILED";
const PRINT_END_DOC_FAILED: &str = "PRINT_END_DOC_FAILED";
const PRINT_END_PAGE_FAILED: &str = "PRINT_END_PAGE_FAILED";
const PRINT_RANGE_INVALID: &str = "PRINT_RANGE_INVALID";
const PRINT_START_DOC_FAILED: &str = "PRINT_START_DOC_FAILED";
const PRINT_NATIVE_CLEANUP_FAILED: &str = "PRINT_NATIVE_CLEANUP_FAILED";
const PRINT_SUBMITTED_CLEANUP_FAILED: &str = "PRINT_SUBMITTED_CLEANUP_FAILED";
const PRINT_START_PAGE_FAILED: &str = "PRINT_START_PAGE_FAILED";
const PRINT_WORKER_DISCONNECTED: &str = "PRINT_WORKER_DISCONNECTED";
const PRINT_WORKER_STATE: &str = "PRINT_WORKER_STATE";
const PRINT_OUTPUT_SELECTION_FAILED: &str = "PRINT_OUTPUT_SELECTION_FAILED";
const PRINT_OUTPUT_FINALIZE_FAILED: &str = "PRINT_OUTPUT_FINALIZE_FAILED";
const PRINT_OUTPUT_CLEANUP_FAILED: &str = "PRINT_OUTPUT_CLEANUP_FAILED";
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(20);
const OUTPUT_CLEANUP_RETRY_INTERVAL: Duration = Duration::from_millis(50);
const OUTPUT_CLEANUP_ATTEMPTS: u32 = 20;
const POINTS_PER_INCH: f64 = 72.0;
const NATIVE_DIALOG_CLASS: &[u16] = &[35, 51, 50, 55, 55, 48];

static ACTIVE_GDI_CANCELLATION: AtomicPtr<AtomicBool> = AtomicPtr::new(ptr::null_mut());

#[link(name = "kernel32")]
extern "system" {
    #[link_name = "GlobalFree"]
    fn global_free_raw(memory: HGLOBAL) -> HGLOBAL;
}

pub(crate) struct PrintCancellation {
    flag: Arc<AtomicBool>,
}

impl PrintCancellation {
    pub(crate) fn new(flag: Arc<AtomicBool>) -> Self {
        Self { flag }
    }
    pub(crate) fn signal(&self) {
        self.flag.store(true, Ordering::Release);
    }
    pub(crate) fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
    fn flag(&self) -> &Arc<AtomicBool> {
        &self.flag
    }
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, &'static str> {
        let initialized =
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        if initialized.is_err() {
            return Err(PRINT_COM_FAILED);
        }
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[derive(Default)]
struct DialogResources {
    hdc: Option<HDC>,
    dev_mode: Option<HGLOBAL>,
    dev_names: Option<HGLOBAL>,
}

impl DialogResources {
    fn take(dialog: &mut PRINTDLGW) -> Self {
        let hdc = (!dialog.hDC.is_invalid()).then_some(dialog.hDC);
        let dev_mode = (!dialog.hDevMode.is_invalid()).then_some(dialog.hDevMode);
        let dev_names = (!dialog.hDevNames.is_invalid()).then_some(dialog.hDevNames);
        dialog.hDC = HDC(ptr::null_mut());
        dialog.hDevMode = HGLOBAL(ptr::null_mut());
        dialog.hDevNames = HGLOBAL(ptr::null_mut());
        Self {
            hdc,
            dev_mode,
            dev_names,
        }
    }

    fn hdc(&self) -> Result<HDC, &'static str> {
        self.hdc.ok_or(PRINT_DEVICE_INVALID)
    }

    fn close(&mut self) -> Result<(), &'static str> {
        let mut failed = false;
        if let Some(hdc) = self.hdc.take() {
            if !unsafe { DeleteDC(hdc) }.as_bool() {
                self.hdc = Some(hdc);
                failed = true;
            }
        }
        if let Some(dev_mode) = self.dev_mode.take() {
            let returned = unsafe { global_free_raw(dev_mode) };
            if !returned.0.is_null() {
                self.dev_mode = Some(returned);
                failed = true;
            }
        }
        if let Some(dev_names) = self.dev_names.take() {
            let returned = unsafe { global_free_raw(dev_names) };
            if !returned.0.is_null() {
                self.dev_names = Some(returned);
                failed = true;
            }
        }
        if failed {
            Err(PRINT_NATIVE_CLEANUP_FAILED)
        } else {
            Ok(())
        }
    }
}

impl Drop for DialogResources {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn close_then_error<T>(
    resources: &mut DialogResources,
    error: &'static str,
) -> Result<T, &'static str> {
    resources.close()?;
    Err(error)
}

/// Owns only the unique staging path. Cleanup never touches the user-selected
/// destination; it becomes visible only after EndDoc completes successfully.
struct PrintOutput {
    final_path: PathBuf,
    staging_path: PathBuf,
    finalized: bool,
}

impl PrintOutput {
    fn select(
        owner: HWND,
        cancellation: &Arc<PrintCancellation>,
    ) -> Result<Option<Self>, &'static str> {
        let mut filename = vec![0_u16; 32_768];
        let filter: Vec<u16> = "PDF files\0*.pdf\0\0".encode_utf16().collect();
        let monitor = NativeDialogCancelMonitor::start(cancellation.clone(), None)?;
        let mut dialog = OPENFILENAMEW {
            lStructSize: mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: owner,
            lpstrFilter: PCWSTR(filter.as_ptr()),
            lpstrFile: windows::core::PWSTR(filename.as_mut_ptr()),
            nMaxFile: filename.len() as u32,
            lpstrDefExt: PCWSTR(windows::core::w!("pdf").as_ptr()),
            Flags: OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_OVERWRITEPROMPT,
            ..Default::default()
        };
        let selected = unsafe { GetSaveFileNameW(&mut dialog) }.as_bool();
        let error = if selected {
            0
        } else {
            unsafe { CommDlgExtendedError() }.0
        };
        drop(monitor);
        if !selected {
            return if error == 0 {
                Ok(None)
            } else {
                Err(PRINT_OUTPUT_SELECTION_FAILED)
            };
        }
        if cancellation.is_cancelled() {
            return Ok(None);
        }
        let end = filename
            .iter()
            .position(|value| *value == 0)
            .ok_or(PRINT_OUTPUT_SELECTION_FAILED)?;
        let final_path = PathBuf::from(OsString::from(
            String::from_utf16(&filename[..end]).map_err(|_| PRINT_OUTPUT_SELECTION_FAILED)?,
        ));
        let parent = final_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or(PRINT_OUTPUT_SELECTION_FAILED)?;
        let staging_path = unique_staging_path(parent)?;
        Ok(Some(Self {
            final_path,
            staging_path,
            finalized: false,
        }))
    }

    fn staging_wide(&self) -> Vec<u16> {
        self.staging_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn finalize(&mut self) -> Result<(), &'static str> {
        let staging = self.staging_wide();
        let final_path: Vec<u16> = self
            .final_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // MoveFileW deliberately has no replace flag: an existing destination is
        // never changed by finalization or failure cleanup.
        if unsafe { MoveFileW(PCWSTR(staging.as_ptr()), PCWSTR(final_path.as_ptr())) }.is_err() {
            return Err(PRINT_OUTPUT_FINALIZE_FAILED);
        }
        self.finalized = true;
        Ok(())
    }

    fn discard(&mut self) -> Result<(), &'static str> {
        if self.finalized || !self.staging_path.exists() {
            return Ok(());
        }
        for attempt in 0..OUTPUT_CLEANUP_ATTEMPTS {
            match fs::remove_file(&self.staging_path) {
                Ok(()) => return Ok(()),
                Err(_) if !self.staging_path.exists() => return Ok(()),
                Err(_) if attempt + 1 < OUTPUT_CLEANUP_ATTEMPTS => {
                    std::thread::sleep(OUTPUT_CLEANUP_RETRY_INTERVAL);
                }
                Err(_) => return Err(PRINT_OUTPUT_CLEANUP_FAILED),
            }
        }
        Err(PRINT_OUTPUT_CLEANUP_FAILED)
    }
}

impl Drop for PrintOutput {
    fn drop(&mut self) {
        let _ = self.discard();
    }
}

fn unique_staging_path(parent: &Path) -> Result<PathBuf, &'static str> {
    for _ in 0..32 {
        let candidate = parent.join(format!(
            ".modeleaf-print-{:032x}.pdf",
            rand::random::<u128>()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(PRINT_OUTPUT_SELECTION_FAILED)
}

enum DialogOutcome {
    Cancelled,
    Selected {
        resources: DialogResources,
        ranges: Vec<PrintPageRange>,
    },
}

struct DialogCapture {
    hwnd: AtomicIsize,
    thread_id: u32,
}

impl DialogCapture {
    fn cancel(&self) {
        let hwnd = HWND(self.hwnd.load(Ordering::Acquire) as *mut c_void);
        if !hwnd.is_invalid() && unsafe { GetWindowThreadProcessId(hwnd, None) } == self.thread_id {
            let _ = unsafe {
                PostMessageW(
                    Some(hwnd),
                    WM_COMMAND,
                    WPARAM(IDCANCEL.0 as usize),
                    LPARAM(0),
                )
            };
        }
    }
}

static ACTIVE_PRINT_DIALOG: AtomicPtr<DialogCapture> = AtomicPtr::new(ptr::null_mut());
struct DialogCaptureRegistration(Arc<DialogCapture>);
impl DialogCaptureRegistration {
    fn new(capture: Arc<DialogCapture>) -> Result<Self, &'static str> {
        ACTIVE_PRINT_DIALOG
            .compare_exchange(
                ptr::null_mut(),
                Arc::as_ptr(&capture) as *mut _,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| PRINT_WORKER_STATE)?;
        Ok(Self(capture))
    }
}
impl Drop for DialogCaptureRegistration {
    fn drop(&mut self) {
        let _ = ACTIVE_PRINT_DIALOG.compare_exchange(
            Arc::as_ptr(&self.0) as *mut _,
            ptr::null_mut(),
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

// Track the actual system-owned dialog HWND; the hook leaves all controls and
// default message processing to Windows. The process-wide print slot keeps the
// registration alive until PrintDlgW and its cancellation monitor settle.
unsafe extern "system" fn print_dialog_hook(
    hwnd: HWND,
    message: u32,
    _wparam: WPARAM,
    _lparam: LPARAM,
) -> usize {
    let capture = ACTIVE_PRINT_DIALOG.load(Ordering::Acquire);
    if !capture.is_null() {
        let capture = unsafe { &*capture };
        if message == WM_INITDIALOG {
            capture.hwnd.store(hwnd.0 as isize, Ordering::Release);
        } else if message == WM_NCDESTROY {
            let _ = capture.hwnd.compare_exchange(
                hwnd.0 as isize,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }
    0
}
struct NativeDialogCancelMonitor {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl NativeDialogCancelMonitor {
    fn start(
        cancellation: Arc<PrintCancellation>,
        capture: Option<Arc<DialogCapture>>,
    ) -> Result<Self, &'static str> {
        let owner_thread = unsafe { GetCurrentThreadId() };
        let stop = Arc::new(AtomicBool::new(false));
        let monitor_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("pdf-print-dialog-cancel".to_owned())
            .spawn(move || {
                while !monitor_stop.load(Ordering::Acquire) {
                    if cancellation.is_cancelled() {
                        if let Some(capture) = &capture {
                            capture.cancel();
                            std::thread::sleep(CANCEL_POLL_INTERVAL);
                            continue;
                        }
                        let _ = unsafe {
                            EnumThreadWindows(owner_thread, Some(cancel_owned_dialog), LPARAM(0))
                        };
                    }
                    std::thread::sleep(CANCEL_POLL_INTERVAL);
                }
            })
            .map_err(|_| PRINT_WORKER_STATE)?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for NativeDialogCancelMonitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

unsafe extern "system" fn cancel_owned_dialog(hwnd: HWND, _context: LPARAM) -> BOOL {
    if unsafe { IsWindowVisible(hwnd) }.as_bool() {
        let mut class_name = [0_u16; 32];
        let length = unsafe { GetClassNameW(hwnd, &mut class_name) };
        if length > 0 && is_native_dialog_class(&class_name[..length as usize]) {
            let _ = unsafe {
                PostMessageW(
                    Some(hwnd),
                    WM_COMMAND,
                    WPARAM(IDCANCEL.0 as usize),
                    LPARAM(0),
                )
            };
        }
    }
    BOOL(1)
}

fn is_native_dialog_class(class_name: &[u16]) -> bool {
    class_name == NATIVE_DIALOG_CLASS
}

fn show_print_dialog(
    hwnd: isize,
    page_count: u32,
    current_page: u32,
    cancellation: &Arc<PrintCancellation>,
) -> Result<DialogOutcome, &'static str> {
    let owner = HWND(hwnd as *mut c_void);
    if !unsafe { IsWindow(Some(owner)) }.as_bool() {
        return Err(PRINT_DIALOG_FAILED);
    }
    if page_count == 0
        || page_count > u16::MAX.into()
        || current_page == 0
        || current_page > page_count
    {
        return Err(PRINT_RANGE_INVALID);
    }
    if cancellation.is_cancelled() {
        return Ok(DialogOutcome::Cancelled);
    }
    let capture = Arc::new(DialogCapture {
        hwnd: AtomicIsize::new(0),
        thread_id: unsafe { GetCurrentThreadId() },
    });
    let registration = DialogCaptureRegistration::new(capture.clone())?;
    let monitor = NativeDialogCancelMonitor::start(cancellation.clone(), Some(capture))?;
    let mut dialog = PRINTDLGW {
        lStructSize: mem::size_of::<PRINTDLGW>() as u32,
        hwndOwner: owner,
        Flags: PD_RETURNDC
            | PD_ENABLEPRINTHOOK
            | PD_USEDEVMODECOPIESANDCOLLATE
            | PD_NOSELECTION
            | PD_HIDEPRINTTOFILE,
        lpfnPrintHook: Some(print_dialog_hook),
        nMinPage: 1,
        nMaxPage: page_count as u16,
        nFromPage: current_page as u16,
        nToPage: current_page as u16,
        nCopies: 1,
        ..Default::default()
    };
    let accepted = unsafe { PrintDlgW(&mut dialog) }.as_bool();
    let dialog_error = if accepted {
        0
    } else {
        unsafe { CommDlgExtendedError() }.0
    };
    drop(monitor);
    drop(registration);
    let mut resources = DialogResources::take(&mut dialog);
    if !accepted {
        resources.close()?;
        return if dialog_error == 0 {
            Ok(DialogOutcome::Cancelled)
        } else {
            Err(PRINT_DIALOG_FAILED)
        };
    }
    if cancellation.is_cancelled() {
        resources.close()?;
        return Ok(DialogOutcome::Cancelled);
    }
    if dialog.Flags.contains(PD_SELECTION) {
        return close_then_error(&mut resources, PRINT_RANGE_INVALID);
    }
    let range = if dialog.Flags.contains(PD_PAGENUMS) {
        PrintPageRange {
            from: dialog.nFromPage.into(),
            to: dialog.nToPage.into(),
        }
    } else {
        PrintPageRange {
            from: 1,
            to: page_count,
        }
    };
    if range.from == 0 || range.to < range.from || range.to > page_count {
        return close_then_error(&mut resources, PRINT_RANGE_INVALID);
    }
    if let Err(error) = resources.hdc() {
        return close_then_error(&mut resources, error);
    }
    Ok(DialogOutcome::Selected {
        resources,
        ranges: vec![range],
    })
}

struct AbortRegistration {
    pointer: *mut AtomicBool,
}

impl AbortRegistration {
    fn register(flag: &Arc<AtomicBool>) -> Result<Self, &'static str> {
        let pointer = Arc::as_ptr(flag) as *mut AtomicBool;
        ACTIVE_GDI_CANCELLATION
            .compare_exchange(
                ptr::null_mut(),
                pointer,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| PRINT_WORKER_STATE)?;
        Ok(Self { pointer })
    }
}

impl Drop for AbortRegistration {
    fn drop(&mut self) {
        let _ = ACTIVE_GDI_CANCELLATION.compare_exchange(
            self.pointer,
            ptr::null_mut(),
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

unsafe extern "system" fn print_abort_proc(_hdc: HDC, _error: i32) -> windows::core::BOOL {
    let cancellation = ACTIVE_GDI_CANCELLATION.load(Ordering::Acquire);
    if cancellation.is_null() || !unsafe { (*cancellation).load(Ordering::Acquire) } {
        windows::core::BOOL(1)
    } else {
        windows::core::BOOL(0)
    }
}

fn is_explicit_user_abort(result: i32, last_error: u32) -> bool {
    result == SP_USERABORT || last_error == ERROR_CANCELLED.0
}

fn classify_gdi_failure(result: i32, last_error: u32, fallback: &'static str) -> &'static str {
    if is_explicit_user_abort(result, last_error) {
        PRINT_CANCELLED
    } else {
        fallback
    }
}

fn checked_abort_result(result: i32) -> Result<(), &'static str> {
    if result > 0 {
        Ok(())
    } else {
        Err(PRINT_ABORT_DOC_FAILED)
    }
}
struct GdiDocument {
    _abort_registration: AbortRegistration,
    _dialog_monitor: NativeDialogCancelMonitor,
    resources: DialogResources,
    output: PrintOutput,
    cancellation: Arc<PrintCancellation>,
    started: bool,
}

impl GdiDocument {
    fn start(
        resources: &mut DialogResources,
        title: &str,
        output: PrintOutput,
        cancellation: Arc<PrintCancellation>,
    ) -> Result<Self, &'static str> {
        let hdc = resources.hdc()?;
        let abort_registration = AbortRegistration::register(cancellation.flag())?;
        if unsafe { SetAbortProc(hdc, Some(print_abort_proc)) } <= 0 {
            return Err(PRINT_START_DOC_FAILED);
        }
        if cancellation.is_cancelled() {
            return Err(PRINT_CANCELLED);
        }
        let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let output_path = output.staging_wide();
        let document = DOCINFOW {
            cbSize: mem::size_of::<DOCINFOW>() as i32,
            lpszDocName: PCWSTR(title.as_ptr()),
            lpszOutput: PCWSTR(output_path.as_ptr()),
            lpszDatatype: PCWSTR::null(),
            fwType: 0,
        };
        let dialog_monitor = NativeDialogCancelMonitor::start(cancellation.clone(), None)?;
        unsafe { SetLastError(ERROR_SUCCESS) };
        let start_result = unsafe { StartDocW(hdc, &document) };
        if start_result <= 0 {
            let last_error = unsafe { GetLastError() }.0;
            return Err(classify_gdi_failure(
                start_result,
                last_error,
                PRINT_START_DOC_FAILED,
            ));
        }
        Ok(Self {
            _abort_registration: abort_registration,
            _dialog_monitor: dialog_monitor,
            resources: mem::take(resources),
            output,
            cancellation,
            started: true,
        })
    }

    fn print_page(&mut self, page: &mut RasterPage) -> Result<(), &'static str> {
        if self.cancellation.is_cancelled() {
            return Err(PRINT_CANCELLED);
        }
        let hdc = self.resources.hdc()?;
        unsafe { SetLastError(ERROR_SUCCESS) };
        let start_result = unsafe { StartPage(hdc) };
        if start_result <= 0 {
            let last_error = unsafe { GetLastError() }.0;
            return Err(classify_gdi_failure(
                start_result,
                last_error,
                PRINT_START_PAGE_FAILED,
            ));
        }
        if self.cancellation.is_cancelled() {
            return Err(PRINT_CANCELLED);
        }

        let printable_width = unsafe { GetDeviceCaps(Some(hdc), HORZRES) };
        let printable_height = unsafe { GetDeviceCaps(Some(hdc), VERTRES) };
        let dpi_x = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSX) };
        let dpi_y = unsafe { GetDeviceCaps(Some(hdc), LOGPIXELSY) };
        if printable_width <= 0 || printable_height <= 0 || dpi_x <= 0 || dpi_y <= 0 {
            return Err(PRINT_DEVICE_INVALID);
        }
        if !unsafe { PatBlt(hdc, 0, 0, printable_width, printable_height, WHITENESS) }.as_bool() {
            return Err(PRINT_DRAW_FAILED);
        }
        if unsafe { SetStretchBltMode(hdc, HALFTONE) } == 0
            || !unsafe { SetBrushOrgEx(hdc, 0, 0, None) }.as_bool()
        {
            return Err(PRINT_DRAW_FAILED);
        }

        let source_width = page.width();
        let source_height = page.height();
        let page_width_points = page.width_points();
        let page_height_points = page.height_points();
        let destination = fit_to_printable_bounds(
            page_width_points,
            page_height_points,
            printable_width,
            printable_height,
            dpi_x,
            dpi_y,
        )?;
        composite_bgra_over_white(page.pixels_mut());
        if self.cancellation.is_cancelled() {
            return Err(PRINT_CANCELLED);
        }

        let pixels = page.pixels_mut();
        let bitmap = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: source_width as i32,
                biHeight: -(source_height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: pixels.len() as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        let drawn = unsafe {
            StretchDIBits(
                hdc,
                destination.x,
                destination.y,
                destination.width,
                destination.height,
                0,
                0,
                source_width as i32,
                source_height as i32,
                Some(pixels.as_ptr().cast()),
                &bitmap,
                DIB_RGB_COLORS,
                SRCCOPY,
            )
        };
        if drawn == 0 || drawn == GDI_ERROR {
            return Err(PRINT_DRAW_FAILED);
        }
        if self.cancellation.is_cancelled() {
            return Err(PRINT_CANCELLED);
        }
        unsafe { SetLastError(ERROR_SUCCESS) };
        let end_result = unsafe { EndPage(hdc) };
        if end_result <= 0 {
            let last_error = unsafe { GetLastError() }.0;
            return Err(classify_gdi_failure(
                end_result,
                last_error,
                PRINT_END_PAGE_FAILED,
            ));
        }
        Ok(())
    }

    fn abort(&mut self) -> Result<(), &'static str> {
        if !self.started {
            return Ok(());
        }
        let hdc = self.resources.hdc()?;
        let result = unsafe { AbortDoc(hdc) };
        self.started = false;
        checked_abort_result(result)
    }

    fn close_resources(&mut self) -> Result<(), &'static str> {
        self.resources.close()
    }

    fn discard_output(&mut self) -> Result<(), &'static str> {
        self.output.discard()
    }

    fn finish(&mut self) -> Result<(), &'static str> {
        if self.cancellation.is_cancelled() {
            return Err(PRINT_CANCELLED);
        }
        let hdc = self.resources.hdc()?;
        unsafe { SetLastError(ERROR_SUCCESS) };
        let end_result = unsafe { EndDoc(hdc) };
        if end_result <= 0 {
            let last_error = unsafe { GetLastError() }.0;
            return Err(classify_gdi_failure(
                end_result,
                last_error,
                PRINT_END_DOC_FAILED,
            ));
        }
        self.started = false;
        self.output.finalize()
    }
}

impl Drop for GdiDocument {
    fn drop(&mut self) {
        let _ = self.abort();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DestinationRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn fit_to_printable_bounds(
    page_width_points: f64,
    page_height_points: f64,
    printable_width: i32,
    printable_height: i32,
    dpi_x: i32,
    dpi_y: i32,
) -> Result<DestinationRect, &'static str> {
    if !page_width_points.is_finite()
        || !page_height_points.is_finite()
        || page_width_points <= 0.0
        || page_height_points <= 0.0
        || printable_width <= 0
        || printable_height <= 0
        || dpi_x <= 0
        || dpi_y <= 0
    {
        return Err(PRINT_DEVICE_INVALID);
    }

    let natural_width = page_width_points * f64::from(dpi_x) / POINTS_PER_INCH;
    let natural_height = page_height_points * f64::from(dpi_y) / POINTS_PER_INCH;
    let scale = (f64::from(printable_width) / natural_width)
        .min(f64::from(printable_height) / natural_height);
    if !natural_width.is_finite()
        || !natural_height.is_finite()
        || !scale.is_finite()
        || scale <= 0.0
    {
        return Err(PRINT_DEVICE_INVALID);
    }

    let width = (natural_width * scale)
        .round()
        .clamp(1.0, f64::from(printable_width)) as i32;
    let height = (natural_height * scale)
        .round()
        .clamp(1.0, f64::from(printable_height)) as i32;
    Ok(DestinationRect {
        x: (printable_width - width) / 2,
        y: (printable_height - height) / 2,
        width,
        height,
    })
}

fn composite_bgra_over_white(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        if alpha != 255 {
            let inverse = 255 - alpha;
            for channel in &mut pixel[..3] {
                let blended =
                    u32::from(*channel) * u32::from(alpha) + 255 * u32::from(inverse) + 127;
                *channel = (blended / 255) as u8;
            }
            pixel[3] = 255;
        }
    }
}

fn terminal_for_error(
    error: &'static str,
    completion: Option<SyncSender<()>>,
) -> PrintWorkerResult {
    if error == PRINT_CANCELLED {
        PrintWorkerResult::cancelled(completion)
    } else {
        PrintWorkerResult::failed(error, completion)
    }
}

fn after_resource_cleanup(
    mut resources: DialogResources,
    result: PrintWorkerResult,
) -> PrintWorkerResult {
    let cleanup = resources.close();
    match cleanup {
        Ok(()) => result,
        Err(_) if result.is_submitted() => result.with_failure(PRINT_SUBMITTED_CLEANUP_FAILED),
        Err(error) => result.with_failure(error),
    }
}

pub(crate) fn run_print_worker(
    hwnd: isize,
    page_count: u32,
    current_page: u32,
    title: String,
    cancellation: Arc<PrintCancellation>,
    commands: Receiver<PrintWorkerCommand>,
    observer: PrintWorkerObserver,
) -> PrintWorkerResult {
    let _apartment = match ComApartment::initialize() {
        Ok(apartment) => apartment,
        Err(error) => return terminal_for_error(error, None),
    };
    if cancellation.is_cancelled() {
        return PrintWorkerResult::cancelled(None);
    }
    let (mut resources, ranges) =
        match show_print_dialog(hwnd, page_count, current_page, &cancellation) {
            Ok(DialogOutcome::Cancelled) => return PrintWorkerResult::cancelled(None),
            Ok(DialogOutcome::Selected { resources, ranges }) => (resources, ranges),
            Err(error) => return terminal_for_error(error, None),
        };
    let output = match PrintOutput::select(HWND(hwnd as *mut c_void), &cancellation) {
        Ok(Some(output)) => output,
        Ok(None) => return after_resource_cleanup(resources, PrintWorkerResult::cancelled(None)),
        Err(error) => return after_resource_cleanup(resources, terminal_for_error(error, None)),
    };
    if cancellation.is_cancelled() {
        return after_resource_cleanup(resources, PrintWorkerResult::cancelled(None));
    }

    match observer.dialog_ready(&ranges, page_count) {
        Ok(true) => {}
        Ok(false) => {
            return after_resource_cleanup(resources, PrintWorkerResult::cancelled(None));
        }
        Err(error) => {
            return after_resource_cleanup(resources, terminal_for_error(error, None));
        }
    }
    let mut document =
        match GdiDocument::start(&mut resources, &title, output, cancellation.clone()) {
            Ok(document) => document,
            Err(error) => {
                return after_resource_cleanup(resources, terminal_for_error(error, None));
            }
        };

    let result = loop {
        if cancellation.is_cancelled() {
            break PrintWorkerResult::cancelled(None);
        }
        match commands.recv_timeout(CANCEL_POLL_INTERVAL) {
            Ok(PrintWorkerCommand::Cancel) => break PrintWorkerResult::cancelled(None),
            Ok(PrintWorkerCommand::Submit {
                mut page,
                completion,
            }) => {
                if cancellation.is_cancelled() {
                    break PrintWorkerResult::cancelled(Some(completion));
                }
                let page_number = page.page_number();
                if let Err(error) = document.print_page(&mut page) {
                    break terminal_for_error(error, Some(completion));
                }
                drop(page);
                match observer.page_submitted(page_number) {
                    Ok(true) => {
                        if completion.send(()).is_err() {
                            break PrintWorkerResult::failed(PRINT_WORKER_DISCONNECTED, None);
                        }
                    }
                    Ok(false) => break PrintWorkerResult::cancelled(Some(completion)),
                    Err(error) => break terminal_for_error(error, Some(completion)),
                }
            }
            Ok(PrintWorkerCommand::Finish { completion }) => {
                if let Err(error) = document.finish() {
                    break terminal_for_error(error, Some(completion));
                }
                break PrintWorkerResult::submitted(completion);
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                break PrintWorkerResult::failed(PRINT_WORKER_DISCONNECTED, None);
            }
        }
    };
    let abort_error = document.abort().err();
    let resource_error = document.close_resources().err();
    let output_error = document.discard_output().err();
    if let Some(error) = abort_error.or(resource_error).or(output_error) {
        if result.is_submitted() {
            result.with_failure(PRINT_SUBMITTED_CLEANUP_FAILED)
        } else {
            result.with_failure(error)
        }
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn staging_cleanup_preserves_existing_destination() {
        let root = std::env::temp_dir().join(format!(
            "modeleaf-print-test-{:032x}",
            rand::random::<u128>()
        ));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("existing.pdf");
        let staging_path = root.join(".modeleaf-print-partial.pdf");
        fs::write(&final_path, b"existing").unwrap();
        fs::write(&staging_path, b"partial").unwrap();
        drop(PrintOutput {
            final_path: final_path.clone(),
            staging_path: staging_path.clone(),
            finalized: false,
        });
        assert_eq!(fs::read(&final_path).unwrap(), b"existing");
        assert!(!staging_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_staging_cleanup_reports_a_failure() {
        let root = std::env::temp_dir().join(format!(
            "modeleaf-print-test-{:032x}",
            rand::random::<u128>()
        ));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("output.pdf");
        let staging_path = root.join("staging-directory.pdf");
        fs::create_dir(&staging_path).unwrap();
        let mut output = PrintOutput {
            final_path,
            staging_path,
            finalized: false,
        };
        assert_eq!(output.discard(), Err(PRINT_OUTPUT_CLEANUP_FAILED));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finalization_refuses_existing_destination_and_cleans_only_staging() {
        let root = std::env::temp_dir().join(format!(
            "modeleaf-print-test-{:032x}",
            rand::random::<u128>()
        ));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("existing.pdf");
        let staging_path = root.join(".modeleaf-print-complete.pdf");
        fs::write(&final_path, b"existing").unwrap();
        fs::write(&staging_path, b"complete").unwrap();
        let mut output = PrintOutput {
            final_path: final_path.clone(),
            staging_path: staging_path.clone(),
            finalized: false,
        };
        assert_eq!(output.finalize(), Err(PRINT_OUTPUT_FINALIZE_FAILED));
        drop(output);
        assert_eq!(fs::read(&final_path).unwrap(), b"existing");
        assert!(!staging_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finalization_publishes_only_after_staging_exists() {
        let root = std::env::temp_dir().join(format!(
            "modeleaf-print-test-{:032x}",
            rand::random::<u128>()
        ));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("output.pdf");
        let staging_path = root.join(".modeleaf-print-complete.pdf");
        fs::write(&staging_path, b"complete").unwrap();
        let mut output = PrintOutput {
            final_path: final_path.clone(),
            staging_path: staging_path.clone(),
            finalized: false,
        };
        assert!(!final_path.exists());
        output.finalize().unwrap();
        assert_eq!(fs::read(&final_path).unwrap(), b"complete");
        assert!(!staging_path.exists());
        drop(output);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abort_cleanup_requires_a_positive_result() {
        assert!(checked_abort_result(1).is_ok());
        for result in [0, -1, SP_USERABORT] {
            assert_eq!(checked_abort_result(result), Err(PRINT_ABORT_DOC_FAILED));
        }
    }
    #[test]
    fn dialog_hook_tracks_and_clears_only_its_registered_window() {
        let capture = Arc::new(DialogCapture {
            hwnd: AtomicIsize::new(0),
            thread_id: 1,
        });
        let registration = DialogCaptureRegistration::new(capture.clone()).unwrap();
        let other = Arc::new(DialogCapture {
            hwnd: AtomicIsize::new(0),
            thread_id: 2,
        });
        assert!(DialogCaptureRegistration::new(other).is_err());
        let hwnd = HWND(123_isize as *mut c_void);
        unsafe {
            print_dialog_hook(hwnd, WM_INITDIALOG, WPARAM(0), LPARAM(0));
        }
        assert_eq!(capture.hwnd.load(Ordering::Acquire), 123);
        unsafe {
            print_dialog_hook(
                HWND(456_isize as *mut c_void),
                WM_NCDESTROY,
                WPARAM(0),
                LPARAM(0),
            );
        }
        assert_eq!(capture.hwnd.load(Ordering::Acquire), 123);
        unsafe {
            print_dialog_hook(hwnd, WM_NCDESTROY, WPARAM(0), LPARAM(0));
        }
        assert_eq!(capture.hwnd.load(Ordering::Acquire), 0);
        drop(registration);
        assert!(ACTIVE_PRINT_DIALOG.load(Ordering::Acquire).is_null());
    }
    use super::*;

    #[test]
    fn fit_preserves_physical_aspect_and_centers() {
        let fitted = fit_to_printable_bounds(612.0, 792.0, 4800, 6300, 600, 600).unwrap();
        assert_eq!(
            fitted,
            DestinationRect {
                x: 0,
                y: 44,
                width: 4800,
                height: 6212,
            }
        );

        let mixed_dpi = fit_to_printable_bounds(720.0, 360.0, 2000, 2400, 200, 400).unwrap();
        assert_eq!(
            mixed_dpi,
            DestinationRect {
                x: 0,
                y: 200,
                width: 2000,
                height: 2000,
            }
        );
    }

    #[test]
    fn save_as_cancel_is_distinct_from_other_start_doc_failures() {
        assert_eq!(
            classify_gdi_failure(SP_USERABORT, ERROR_SUCCESS.0, PRINT_START_DOC_FAILED,),
            PRINT_CANCELLED
        );
        assert_eq!(
            classify_gdi_failure(-1, ERROR_CANCELLED.0, PRINT_START_DOC_FAILED),
            PRINT_CANCELLED
        );
        assert_eq!(
            classify_gdi_failure(-1, ERROR_SUCCESS.0, PRINT_START_DOC_FAILED),
            PRINT_START_DOC_FAILED
        );
    }

    #[test]
    fn save_as_monitor_matches_only_the_standard_dialog_class() {
        assert!(is_native_dialog_class(NATIVE_DIALOG_CLASS));
        assert!(!is_native_dialog_class(&[35, 51, 50, 55, 55]));
        assert!(!is_native_dialog_class(&[
            77, 111, 100, 101, 108, 101, 97, 102,
        ]));
    }

    #[test]
    fn transparent_bgra_is_composited_over_white_in_place() {
        let mut pixels = [0_u8, 0, 0, 0, 10, 20, 30, 255, 0, 0, 0, 128];
        composite_bgra_over_white(&mut pixels);
        assert_eq!(&pixels[0..4], &[255, 255, 255, 255]);
        assert_eq!(&pixels[4..8], &[10, 20, 30, 255]);
        assert_eq!(&pixels[8..12], &[127, 127, 127, 255]);
    }
}

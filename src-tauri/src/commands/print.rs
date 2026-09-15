use crate::pdf_session::{PdfOwner, PdfSessionManager, SessionId};
use crate::print_job::{PrintJobManager, PrintSnapshot};
use crate::workspace::WorkspaceManager;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{ipc::InvokeBody, ipc::Request, Manager, State, Window};

static PAGE_COMMAND_ACTIVE: AtomicBool = AtomicBool::new(false);

struct PageCommandPermit<'a>(&'a AtomicBool);

impl<'a> PageCommandPermit<'a> {
    fn acquire(active: &'a AtomicBool) -> Result<Self, String> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "PRINT_OPERATION_IN_PROGRESS".to_owned())?;
        Ok(Self(active))
    }
}

impl Drop for PageCommandPermit<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn owner(window: &Window, generation: u64) -> PdfOwner {
    PdfOwner {
        window_label: window.label().to_owned(),
        generation,
    }
}

#[tauri::command]
pub async fn start_pdf_print(
    window: Window,
    session_id: String,
    document_generation: u64,
    owner_generation: u64,
    page_count: u32,
    current_page: u32,
    title: String,
) -> Result<PrintSnapshot, String> {
    let sessions = window.state::<PdfSessionManager>();
    let jobs = window.state::<PrintJobManager>();
    let owner = owner(&window, owner_generation);
    if window
        .state::<WorkspaceManager>()
        .active_owner(window.label())
        .as_ref()
        != Some(&owner)
    {
        return Err("PRINT_OWNER_MISMATCH".into());
    }
    let id = SessionId::from_opaque(session_id).map_err(|error| error.tag().to_owned())?;
    let hwnd = window.hwnd().map_err(|_| "PRINT_OWNER_UNAVAILABLE")?;
    let lease = sessions
        .acquire_print_lease(&owner, &id, document_generation)
        .map_err(|error| error.tag().to_owned())?;
    jobs.start(
        owner,
        lease,
        hwnd.0 as isize,
        page_count,
        current_page,
        title,
    )
}

#[tauri::command]
pub async fn poll_pdf_print(
    window: Window,
    jobs: State<'_, PrintJobManager>,
    owner_generation: u64,
    job_id: String,
) -> Result<PrintSnapshot, String> {
    jobs.poll(&owner(&window, owner_generation), &job_id)
}

#[tauri::command]
pub async fn submit_pdf_print_page(
    window: Window,
    jobs: State<'_, PrintJobManager>,
    request: Request<'_>,
) -> Result<PrintSnapshot, String> {
    let job_id = request
        .headers()
        .get("x-print-job")
        .and_then(|value| value.to_str().ok())
        .ok_or("PRINT_JOB_INVALID")?
        .to_owned();
    let generation = request
        .headers()
        .get("x-print-owner-generation")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or("PRINT_OWNER_MISMATCH")?;
    let owner = owner(&window, generation);
    let jobs = jobs.inner().clone();
    jobs.poll(&owner, &job_id)?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err("PRINT_PAGE_INVALID".into());
    };
    if body.len() > 64 * 1024 * 1024 + 32 {
        return Err("PRINT_IMAGE_LIMIT".into());
    }
    // Tauri owns the received transport buffer. Admit before making our own
    // copy or queuing blocking work, including concurrent authenticated calls.
    let permit = PageCommandPermit::acquire(&PAGE_COMMAND_ACTIVE)?;
    let body = body.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = jobs.submit(&owner, &job_id, body);
        drop(permit);
        result
    })
    .await
    .map_err(|_| "PRINT_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn finish_pdf_print(
    window: Window,
    jobs: State<'_, PrintJobManager>,
    owner_generation: u64,
    job_id: String,
) -> Result<PrintSnapshot, String> {
    let owner = owner(&window, owner_generation);
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || jobs.finish(&owner, &job_id))
        .await
        .map_err(|_| "PRINT_WORKER_FAILED".to_owned())?
}

#[tauri::command]
pub async fn cancel_pdf_print(
    window: Window,
    jobs: State<'_, PrintJobManager>,
    owner_generation: u64,
    job_id: String,
) -> Result<PrintSnapshot, String> {
    jobs.cancel(&owner(&window, owner_generation), &job_id)
}

#[tauri::command]
pub async fn release_pdf_print(
    window: Window,
    jobs: State<'_, PrintJobManager>,
    owner_generation: u64,
    job_id: String,
) -> Result<(), String> {
    jobs.release(&owner(&window, owner_generation), &job_id)
}

#[cfg(test)]
mod tests {
    use super::PageCommandPermit;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn page_copy_admission_is_exclusive_until_the_previous_command_settles() {
        let active = AtomicBool::new(false);
        let permit = PageCommandPermit::acquire(&active).unwrap();
        assert!(PageCommandPermit::acquire(&active).is_err());
        assert!(active.load(Ordering::Acquire));
        drop(permit);
        let reopened = PageCommandPermit::acquire(&active).unwrap();
        assert!(PageCommandPermit::acquire(&active).is_err());
        drop(reopened);
        assert!(!active.load(Ordering::Acquire));
    }

    #[test]
    fn unwinding_a_failed_command_releases_its_copy_admission() {
        let active = AtomicBool::new(false);
        let result = std::panic::catch_unwind(|| {
            let _permit = PageCommandPermit::acquire(&active).unwrap();
            panic!("injected command failure");
        });
        assert!(result.is_err());
        assert!(PageCommandPermit::acquire(&active).is_ok());
    }
}

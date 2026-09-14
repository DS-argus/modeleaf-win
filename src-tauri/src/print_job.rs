use crate::pdf_session::{PdfOwner, PdfPrintLease};
use rand::RngCore;
use serde::Serialize;
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};

pub(crate) const PRINT_PAGE_HEADER_BYTES: usize = 32;
pub(crate) const PRINT_PAGE_MAGIC: u32 = 0x3152_504D;
pub(crate) const MAX_PRINT_PAGE_PIXELS_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_PRINT_PAGE_PAYLOAD_BYTES: usize =
    PRINT_PAGE_HEADER_BYTES + MAX_PRINT_PAGE_PIXELS_BYTES;
pub(crate) const MAX_PRINT_PAGE_DIMENSION: u32 = 32_768;
pub(crate) const MAX_PRINT_PAGE_RANGES: usize = 16;
const MAX_PRINT_TITLE_UTF16: usize = 512;
const PRINT_RASTER_PIXELS_PER_POINT: f64 = 300.0 / 72.0;

const PRINT_BUSY: &str = "PRINT_BUSY";
const PRINT_CANCELLED: &str = "PRINT_CANCELLED";
const PRINT_GENERATION_MISMATCH: &str = "PRINT_GENERATION_MISMATCH";
const PRINT_INCOMPLETE: &str = "PRINT_INCOMPLETE";
const PRINT_JOB_NOT_FOUND: &str = "PRINT_JOB_NOT_FOUND";
const PRINT_JOB_TERMINAL: &str = "PRINT_JOB_TERMINAL";
const PRINT_MANAGER_UNAVAILABLE: &str = "PRINT_MANAGER_UNAVAILABLE";
const PRINT_NOT_READY: &str = "PRINT_NOT_READY";
const PRINT_OPERATION_IN_PROGRESS: &str = "PRINT_OPERATION_IN_PROGRESS";
const PRINT_OWNER_MISMATCH: &str = "PRINT_OWNER_MISMATCH";
const PRINT_PAGE_ORDER: &str = "PRINT_PAGE_ORDER";
const PRINT_PAYLOAD_INVALID: &str = "PRINT_PAYLOAD_INVALID";
const PRINT_PAYLOAD_TOO_LARGE: &str = "PRINT_PAYLOAD_TOO_LARGE";
const PRINT_RANGE_INVALID: &str = "PRINT_RANGE_INVALID";
const PRINT_RELEASE_PENDING: &str = "PRINT_RELEASE_PENDING";
const PRINT_REQUEST_INVALID: &str = "PRINT_REQUEST_INVALID";
const PRINT_WORKER_PANIC: &str = "PRINT_WORKER_PANIC";
const PRINT_WORKER_STATE: &str = "PRINT_WORKER_STATE";
const PRINT_WORKER_UNAVAILABLE: &str = "PRINT_WORKER_UNAVAILABLE";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintPageRange {
    pub from: u32,
    pub to: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintSnapshot {
    pub job_id: String,
    pub phase: String,
    pub page_count: u32,
    pub page_ranges: Vec<PrintPageRange>,
    pub submitted_pages: u32,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PrintPhase {
    Dialog,
    Ready,
    Printing,
    Submitted,
    Cancelled,
    Failed,
}

impl PrintPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dialog => "dialog",
            Self::Ready => "ready",
            Self::Printing => "printing",
            Self::Submitted => "submitted",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Submitted | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug)]
pub(crate) struct RasterPage {
    payload: Vec<u8>,
    page_number: u32,
    width: u32,
    height: u32,
    width_points: f64,
    height_points: f64,
}

impl RasterPage {
    fn parse(payload: Vec<u8>) -> Result<Self, String> {
        if payload.len() > MAX_PRINT_PAGE_PAYLOAD_BYTES {
            return Err(PRINT_PAYLOAD_TOO_LARGE.to_owned());
        }
        if payload.len() < PRINT_PAGE_HEADER_BYTES {
            return Err(PRINT_PAYLOAD_INVALID.to_owned());
        }

        let magic = read_u32(&payload, 0);
        let page_number = read_u32(&payload, 4);
        let width = read_u32(&payload, 8);
        let height = read_u32(&payload, 12);
        let width_points = read_f64(&payload, 16);
        let height_points = read_f64(&payload, 24);
        if magic != PRINT_PAGE_MAGIC
            || page_number == 0
            || width == 0
            || height == 0
            || width > MAX_PRINT_PAGE_DIMENSION
            || height > MAX_PRINT_PAGE_DIMENSION
            || !width_points.is_finite()
            || !height_points.is_finite()
            || width_points <= 0.0
            || height_points <= 0.0
        {
            return Err(PRINT_PAYLOAD_INVALID.to_owned());
        }
        let expected_width = width_points * PRINT_RASTER_PIXELS_PER_POINT;
        let expected_height = height_points * PRINT_RASTER_PIXELS_PER_POINT;
        if !expected_width.is_finite()
            || !expected_height.is_finite()
            || (expected_width - f64::from(width)).abs() > 1.0
            || (expected_height - f64::from(height)).abs() > 1.0
        {
            return Err(PRINT_PAYLOAD_INVALID.to_owned());
        }

        let pixels = (width as usize)
            .checked_mul(height as usize)
            .and_then(|count| count.checked_mul(4))
            .ok_or_else(|| PRINT_PAYLOAD_INVALID.to_owned())?;
        if pixels > MAX_PRINT_PAGE_PIXELS_BYTES {
            return Err(PRINT_PAYLOAD_TOO_LARGE.to_owned());
        }
        let expected = PRINT_PAGE_HEADER_BYTES
            .checked_add(pixels)
            .ok_or_else(|| PRINT_PAYLOAD_INVALID.to_owned())?;
        if payload.len() != expected {
            return Err(PRINT_PAYLOAD_INVALID.to_owned());
        }

        Ok(Self {
            payload,
            page_number,
            width,
            height,
            width_points,
            height_points,
        })
    }

    pub(crate) fn page_number(&self) -> u32 {
        self.page_number
    }

    pub(crate) fn width(&self) -> u32 {
        self.width
    }

    pub(crate) fn height(&self) -> u32 {
        self.height
    }

    pub(crate) fn width_points(&self) -> f64 {
        self.width_points
    }

    pub(crate) fn height_points(&self) -> f64 {
        self.height_points
    }

    pub(crate) fn pixels_mut(&mut self) -> &mut [u8] {
        &mut self.payload[PRINT_PAGE_HEADER_BYTES..]
    }
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("bounded header"),
    )
}

fn read_f64(bytes: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("bounded header"),
    )
}

#[derive(Clone, Debug)]
struct PageCursor {
    ranges: Vec<PrintPageRange>,
    range_index: usize,
    next_page: u32,
}

impl PageCursor {
    fn new(ranges: Vec<PrintPageRange>) -> Self {
        let next_page = ranges.first().map_or(0, |range| range.from);
        Self {
            ranges,
            range_index: 0,
            next_page,
        }
    }

    fn expected(&self) -> Option<u32> {
        self.ranges.get(self.range_index).map(|_| self.next_page)
    }

    fn advance(&mut self, page_number: u32) -> Result<(), &'static str> {
        let Some(range) = self.ranges.get(self.range_index) else {
            return Err(PRINT_PAGE_ORDER);
        };
        if page_number != self.next_page {
            return Err(PRINT_PAGE_ORDER);
        }
        if self.next_page < range.to {
            self.next_page += 1;
        } else {
            self.range_index += 1;
            self.next_page = self
                .ranges
                .get(self.range_index)
                .map_or(0, |next| next.from);
        }
        Ok(())
    }
}

pub(crate) fn normalize_page_ranges(
    ranges: &[PrintPageRange],
    page_count: u32,
) -> Result<Vec<PrintPageRange>, &'static str> {
    if ranges.is_empty() || ranges.len() > MAX_PRINT_PAGE_RANGES || page_count == 0 {
        return Err(PRINT_RANGE_INVALID);
    }
    let mut normalized = ranges.to_vec();
    if normalized
        .iter()
        .any(|range| range.from == 0 || range.from > range.to || range.to > page_count)
    {
        return Err(PRINT_RANGE_INVALID);
    }
    normalized.sort_unstable_by_key(|range| (range.from, range.to));

    let mut merged: Vec<PrintPageRange> = Vec::with_capacity(normalized.len());
    for range in normalized {
        if let Some(previous) = merged.last_mut() {
            if range.from <= previous.to.saturating_add(1) {
                previous.to = previous.to.max(range.to);
                continue;
            }
        }
        merged.push(range);
    }
    if merged.len() > MAX_PRINT_PAGE_RANGES {
        return Err(PRINT_RANGE_INVALID);
    }
    Ok(merged)
}

fn selected_page_count(ranges: &[PrintPageRange]) -> Result<u32, &'static str> {
    ranges.iter().try_fold(0_u32, |total, range| {
        let count = range
            .to
            .checked_sub(range.from)
            .and_then(|distance| distance.checked_add(1))
            .ok_or(PRINT_RANGE_INVALID)?;
        total.checked_add(count).ok_or(PRINT_RANGE_INVALID)
    })
}

pub(crate) enum PrintWorkerCommand {
    Submit {
        page: RasterPage,
        completion: SyncSender<()>,
    },
    Finish {
        completion: SyncSender<()>,
    },
    Cancel,
}

pub(crate) enum PrintWorkerTerminal {
    Submitted,
    Cancelled,
    Failed(&'static str),
}

pub(crate) struct PrintWorkerResult {
    terminal: PrintWorkerTerminal,
    completion: Option<SyncSender<()>>,
}

impl PrintWorkerResult {
    pub(crate) fn submitted(completion: SyncSender<()>) -> Self {
        Self {
            terminal: PrintWorkerTerminal::Submitted,
            completion: Some(completion),
        }
    }

    pub(crate) fn cancelled(completion: Option<SyncSender<()>>) -> Self {
        Self {
            terminal: PrintWorkerTerminal::Cancelled,
            completion,
        }
    }

    pub(crate) fn failed(error: &'static str, completion: Option<SyncSender<()>>) -> Self {
        Self {
            terminal: PrintWorkerTerminal::Failed(error),
            completion,
        }
    }

    pub(crate) fn with_failure(mut self, error: &'static str) -> Self {
        self.terminal = PrintWorkerTerminal::Failed(error);
        self
    }

    pub(crate) fn is_submitted(&self) -> bool {
        matches!(self.terminal, PrintWorkerTerminal::Submitted)
    }
    fn into_parts(self) -> (PrintWorkerTerminal, Option<SyncSender<()>>) {
        (self.terminal, self.completion)
    }
}

struct PrintJob {
    owner: PdfOwner,
    job_id: String,
    phase: PrintPhase,
    page_count: u32,
    page_ranges: Vec<PrintPageRange>,
    page_cursor: Option<PageCursor>,
    selected_pages: u32,
    submitted_pages: u32,
    error: Option<String>,
    pending_operation: bool,
    worker_live: bool,
    abandoned: bool,
    cancellation: Arc<crate::print_windows::PrintCancellation>,
    commands: SyncSender<PrintWorkerCommand>,
}

impl PrintJob {
    fn snapshot(&self) -> PrintSnapshot {
        PrintSnapshot {
            job_id: self.job_id.clone(),
            phase: self.phase.as_str().to_owned(),
            page_count: self.page_count,
            page_ranges: self.page_ranges.clone(),
            submitted_pages: self.submitted_pages,
            error: self.error.clone(),
        }
    }

    fn is_reapable_abandoned(&self) -> bool {
        self.abandoned && !self.worker_live && self.phase.is_terminal()
    }
}

#[derive(Default)]
struct ManagerState {
    job: Option<PrintJob>,
}

fn reap_finished_abandoned(state: &mut ManagerState) -> bool {
    if state
        .job
        .as_ref()
        .is_some_and(PrintJob::is_reapable_abandoned)
    {
        drop(state.job.take());
        true
    } else {
        false
    }
}

struct ManagerShared {
    state: Mutex<ManagerState>,
    changed: Condvar,
}

impl ManagerShared {
    fn new() -> Self {
        Self {
            state: Mutex::new(ManagerState::default()),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, ManagerState>, String> {
        self.state
            .lock()
            .map_err(|_| PRINT_MANAGER_UNAVAILABLE.to_owned())
    }

    fn settle_worker(&self, job_id: &str, result: PrintWorkerResult) {
        let (terminal, completion) = result.into_parts();
        if let Ok(mut state) = self.state.lock() {
            if let Some(job) = state
                .job
                .as_mut()
                .filter(|current| current.job_id == job_id)
            {
                job.pending_operation = false;
                job.worker_live = false;
                match terminal {
                    PrintWorkerTerminal::Submitted => {
                        job.phase = PrintPhase::Submitted;
                        job.error = None;
                    }
                    PrintWorkerTerminal::Cancelled => {
                        job.phase = PrintPhase::Cancelled;
                        job.error = None;
                    }
                    PrintWorkerTerminal::Failed(error) => {
                        job.phase = PrintPhase::Failed;
                        job.error = Some(error.to_owned());
                    }
                }
            }
            self.changed.notify_all();
        }
        if let Some(completion) = completion {
            let _ = completion.send(());
        }
    }
}

#[derive(Clone)]
pub(crate) struct PrintWorkerObserver {
    shared: Arc<ManagerShared>,
    job_id: String,
}

impl PrintWorkerObserver {
    pub(crate) fn dialog_ready(
        &self,
        raw_ranges: &[PrintPageRange],
        page_count: u32,
    ) -> Result<bool, &'static str> {
        let ranges = normalize_page_ranges(raw_ranges, page_count)?;
        let selected_pages = selected_page_count(&ranges)?;
        let mut state = self.shared.state.lock().map_err(|_| PRINT_WORKER_STATE)?;
        let job = state
            .job
            .as_mut()
            .filter(|job| job.job_id == self.job_id)
            .ok_or(PRINT_WORKER_STATE)?;
        if job.phase != PrintPhase::Dialog || !job.worker_live || job.page_count != page_count {
            return Err(PRINT_WORKER_STATE);
        }
        job.page_ranges = ranges.clone();
        job.page_cursor = Some(PageCursor::new(ranges));
        job.selected_pages = selected_pages;
        job.phase = PrintPhase::Ready;
        let keep_running = !job.cancellation.is_cancelled();
        self.shared.changed.notify_all();
        Ok(keep_running)
    }

    pub(crate) fn page_submitted(&self, page_number: u32) -> Result<bool, &'static str> {
        let mut state = self.shared.state.lock().map_err(|_| PRINT_WORKER_STATE)?;
        let job = state
            .job
            .as_mut()
            .filter(|job| job.job_id == self.job_id)
            .ok_or(PRINT_WORKER_STATE)?;
        if !job.worker_live || !job.pending_operation || job.phase != PrintPhase::Printing {
            return Err(PRINT_WORKER_STATE);
        }
        job.page_cursor
            .as_mut()
            .ok_or(PRINT_WORKER_STATE)?
            .advance(page_number)?;
        job.submitted_pages = job
            .submitted_pages
            .checked_add(1)
            .ok_or(PRINT_WORKER_STATE)?;
        job.pending_operation = false;
        let keep_running = !job.cancellation.is_cancelled();
        self.shared.changed.notify_all();
        Ok(keep_running)
    }
}

#[derive(Clone)]
pub struct PrintJobManager {
    shared: Arc<ManagerShared>,
}

impl Default for PrintJobManager {
    fn default() -> Self {
        static PROCESS_PRINT_MANAGER: OnceLock<PrintJobManager> = OnceLock::new();
        PROCESS_PRINT_MANAGER
            .get_or_init(|| PrintJobManager {
                shared: Arc::new(ManagerShared::new()),
            })
            .clone()
    }
}

impl PrintJobManager {
    pub fn start(
        &self,
        owner: PdfOwner,
        lease: PdfPrintLease,
        hwnd: isize,
        page_count: u32,
        current_page: u32,
        title: String,
    ) -> Result<PrintSnapshot, String> {
        validate_start(hwnd, page_count, current_page, &title)?;
        let cancellation_flag = lease.cancellation_flag();
        if lease.is_cancelled() || cancellation_flag.load(std::sync::atomic::Ordering::Acquire) {
            return Err(PRINT_CANCELLED.to_owned());
        }

        let cancellation = Arc::new(crate::print_windows::PrintCancellation::new(
            cancellation_flag,
        ));
        let (commands, command_receiver) = mpsc::sync_channel(1);
        let job_id = random_job_id();
        let initial = PrintSnapshot {
            job_id: job_id.clone(),
            phase: PrintPhase::Dialog.as_str().to_owned(),
            page_count,
            page_ranges: Vec::new(),
            submitted_pages: 0,
            error: None,
        };

        {
            let mut state = self.shared.lock()?;
            // Lifecycle invalidation cancels the session lease before taking
            // this same manager lock to abandon any published job.
            if cancellation.is_cancelled() {
                return Err(PRINT_CANCELLED.to_owned());
            }
            reap_finished_abandoned(&mut state);
            if state.job.is_some() {
                return Err(PRINT_BUSY.to_owned());
            }
            state.job = Some(PrintJob {
                owner,
                job_id: job_id.clone(),
                phase: PrintPhase::Dialog,
                page_count,
                page_ranges: Vec::new(),
                page_cursor: None,
                selected_pages: 0,
                submitted_pages: 0,
                error: None,
                pending_operation: false,
                worker_live: true,
                abandoned: false,
                cancellation: cancellation.clone(),
                commands: commands.clone(),
            });
        }

        let shared = self.shared.clone();
        let supervisor_job_id = job_id.clone();
        let observer = PrintWorkerObserver {
            shared: self.shared.clone(),
            job_id: job_id.clone(),
        };
        let supervisor = std::thread::Builder::new()
            .name("pdf-print-supervisor".to_owned())
            .spawn(move || {
                let worker_cancellation = cancellation;
                let worker = std::thread::Builder::new()
                    .name("pdf-print-sta".to_owned())
                    .spawn(move || {
                        let outcome =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                crate::print_windows::run_print_worker(
                                    hwnd,
                                    page_count,
                                    current_page,
                                    title,
                                    worker_cancellation.clone(),
                                    command_receiver,
                                    observer,
                                )
                            }));
                        drop(lease);
                        match outcome {
                            Ok(result) => result,
                            Err(_) => PrintWorkerResult::failed(PRINT_WORKER_PANIC, None),
                        }
                    });
                let result = match worker {
                    Ok(worker) => match worker.join() {
                        Ok(result) => result,
                        Err(_) => PrintWorkerResult::failed(PRINT_WORKER_PANIC, None),
                    },
                    Err(_) => PrintWorkerResult::failed(PRINT_WORKER_UNAVAILABLE, None),
                };
                shared.settle_worker(&supervisor_job_id, result);
            });

        if supervisor.is_err() {
            let mut state = self.shared.lock()?;
            if state.job.as_ref().is_some_and(|job| job.job_id == job_id) {
                drop(state.job.take());
            }
            return Err(PRINT_WORKER_UNAVAILABLE.to_owned());
        }

        Ok(initial)
    }

    pub fn poll(&self, owner: &PdfOwner, job_id: &str) -> Result<PrintSnapshot, String> {
        let state = self.shared.lock()?;
        let job = find_job(&state, owner, job_id)?;
        Ok(job.snapshot())
    }

    pub fn submit(
        &self,
        owner: &PdfOwner,
        job_id: &str,
        payload: Vec<u8>,
    ) -> Result<PrintSnapshot, String> {
        let page = RasterPage::parse(payload)?;
        let page_number = page.page_number();
        let (completion_sender, completion_receiver) = mpsc::sync_channel(1);
        let commands = {
            let mut state = self.shared.lock()?;
            let job = find_job_mut(&mut state, owner, job_id)?;
            if job.phase.is_terminal() {
                return Err(PRINT_JOB_TERMINAL.to_owned());
            }
            if job.cancellation.is_cancelled() {
                return Err(PRINT_CANCELLED.to_owned());
            }
            if !matches!(job.phase, PrintPhase::Ready | PrintPhase::Printing) {
                return Err(PRINT_NOT_READY.to_owned());
            }
            if job.pending_operation {
                return Err(PRINT_OPERATION_IN_PROGRESS.to_owned());
            }
            if job.page_cursor.as_ref().and_then(PageCursor::expected) != Some(page_number) {
                return Err(PRINT_PAGE_ORDER.to_owned());
            }
            job.pending_operation = true;
            job.phase = PrintPhase::Printing;
            job.commands.clone()
        };

        match commands.try_send(PrintWorkerCommand::Submit {
            page,
            completion: completion_sender,
        }) {
            Ok(()) => self.await_operation(owner, job_id, completion_receiver),
            Err(TrySendError::Full(_)) => {
                self.revert_admission(owner, job_id)?;
                Err(PRINT_OPERATION_IN_PROGRESS.to_owned())
            }
            Err(TrySendError::Disconnected(_)) => {
                self.await_worker_settlement(owner, job_id, completion_receiver)
            }
        }
    }

    pub fn finish(&self, owner: &PdfOwner, job_id: &str) -> Result<PrintSnapshot, String> {
        let (completion_sender, completion_receiver) = mpsc::sync_channel(1);
        let commands = {
            let mut state = self.shared.lock()?;
            let job = find_job_mut(&mut state, owner, job_id)?;
            if job.phase.is_terminal() {
                return Err(PRINT_JOB_TERMINAL.to_owned());
            }
            if job.cancellation.is_cancelled() {
                return Err(PRINT_CANCELLED.to_owned());
            }
            if !matches!(job.phase, PrintPhase::Ready | PrintPhase::Printing) {
                return Err(PRINT_NOT_READY.to_owned());
            }
            if job.pending_operation {
                return Err(PRINT_OPERATION_IN_PROGRESS.to_owned());
            }
            if job.submitted_pages != job.selected_pages
                || job
                    .page_cursor
                    .as_ref()
                    .and_then(PageCursor::expected)
                    .is_some()
            {
                return Err(PRINT_INCOMPLETE.to_owned());
            }
            job.pending_operation = true;
            job.phase = PrintPhase::Printing;
            job.commands.clone()
        };

        match commands.try_send(PrintWorkerCommand::Finish {
            completion: completion_sender,
        }) {
            Ok(()) => self.await_operation(owner, job_id, completion_receiver),
            Err(TrySendError::Full(_)) => {
                self.revert_admission(owner, job_id)?;
                Err(PRINT_OPERATION_IN_PROGRESS.to_owned())
            }
            Err(TrySendError::Disconnected(_)) => {
                self.await_worker_settlement(owner, job_id, completion_receiver)
            }
        }
    }

    pub fn cancel(&self, owner: &PdfOwner, job_id: &str) -> Result<PrintSnapshot, String> {
        let (snapshot, action) = {
            let mut state = self.shared.lock()?;
            let job = find_job_mut(&mut state, owner, job_id)?;
            if job.phase.is_terminal() {
                return Ok(job.snapshot());
            }
            job.cancellation.signal();
            (
                job.snapshot(),
                CancelAction {
                    commands: job.commands.clone(),
                },
            )
        };
        action.dispatch();
        Ok(snapshot)
    }

    pub fn release(&self, owner: &PdfOwner, job_id: &str) -> Result<(), String> {
        let removed = {
            let mut state = self.shared.lock()?;
            let job = find_job(&state, owner, job_id)?;
            if job.worker_live || !job.phase.is_terminal() || job.pending_operation {
                return Err(PRINT_RELEASE_PENDING.to_owned());
            }
            state.job.take()
        };
        drop(removed);
        Ok(())
    }

    pub fn cancel_owner(&self, window_label: &str) {
        let action =
            {
                let Ok(mut state) = self.shared.state.lock() else {
                    return;
                };
                let Some(job) = state.job.as_mut().filter(|job| {
                    job.owner.window_label == window_label && !job.phase.is_terminal()
                }) else {
                    return;
                };
                job.cancellation.signal();
                Some(CancelAction {
                    commands: job.commands.clone(),
                })
            };
        if let Some(action) = action {
            action.dispatch();
        }
    }

    pub fn abandon_owner(&self, window_label: &str) {
        let action = {
            let Ok(mut state) = self.shared.state.lock() else {
                return;
            };
            if state.job.as_ref().is_some_and(|job| {
                job.owner.window_label == window_label && job.is_reapable_abandoned()
            }) {
                drop(state.job.take());
                return;
            }
            let Some(job) = state
                .job
                .as_mut()
                .filter(|job| job.owner.window_label == window_label)
            else {
                return;
            };
            job.abandoned = true;
            if job.phase.is_terminal() && !job.worker_live {
                drop(state.job.take());
                return;
            }
            job.cancellation.signal();
            Some(CancelAction {
                commands: job.commands.clone(),
            })
        };
        if let Some(action) = action {
            action.dispatch();
        }
    }

    fn await_operation(
        &self,
        owner: &PdfOwner,
        job_id: &str,
        completion: Receiver<()>,
    ) -> Result<PrintSnapshot, String> {
        let _ = completion.recv();
        self.wait_until_operation_settled(owner, job_id)
    }

    fn await_worker_settlement(
        &self,
        owner: &PdfOwner,
        job_id: &str,
        completion: Receiver<()>,
    ) -> Result<PrintSnapshot, String> {
        drop(completion);
        self.wait_until_operation_settled(owner, job_id)
    }

    fn wait_until_operation_settled(
        &self,
        owner: &PdfOwner,
        job_id: &str,
    ) -> Result<PrintSnapshot, String> {
        let mut state = self.shared.lock()?;
        loop {
            let job = find_job(&state, owner, job_id)?;
            if !job.pending_operation {
                return Ok(job.snapshot());
            }
            state = self
                .shared
                .changed
                .wait(state)
                .map_err(|_| PRINT_MANAGER_UNAVAILABLE.to_owned())?;
        }
    }

    fn revert_admission(&self, owner: &PdfOwner, job_id: &str) -> Result<(), String> {
        let mut state = self.shared.lock()?;
        let job = find_job_mut(&mut state, owner, job_id)?;
        if job.worker_live && !job.phase.is_terminal() && job.pending_operation {
            job.pending_operation = false;
            job.phase = if job.submitted_pages == 0 {
                PrintPhase::Ready
            } else {
                PrintPhase::Printing
            };
            self.shared.changed.notify_all();
        }
        Ok(())
    }
}

struct CancelAction {
    commands: SyncSender<PrintWorkerCommand>,
}

impl CancelAction {
    fn dispatch(self) {
        let _ = self.commands.try_send(PrintWorkerCommand::Cancel);
    }
}

fn validate_start(
    hwnd: isize,
    page_count: u32,
    current_page: u32,
    title: &str,
) -> Result<(), String> {
    if hwnd == 0
        || page_count == 0
        || current_page == 0
        || current_page > page_count
        || title.is_empty()
        || title.encode_utf16().count() > MAX_PRINT_TITLE_UTF16
        || title
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err(PRINT_REQUEST_INVALID.to_owned());
    }
    Ok(())
}

fn random_job_id() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn find_job<'a>(
    state: &'a ManagerState,
    owner: &PdfOwner,
    job_id: &str,
) -> Result<&'a PrintJob, String> {
    let job = state
        .job
        .as_ref()
        .filter(|job| job.job_id == job_id)
        .ok_or_else(|| PRINT_JOB_NOT_FOUND.to_owned())?;
    check_owner(&job.owner, owner)?;
    Ok(job)
}

fn find_job_mut<'a>(
    state: &'a mut ManagerState,
    owner: &PdfOwner,
    job_id: &str,
) -> Result<&'a mut PrintJob, String> {
    let job = state
        .job
        .as_mut()
        .filter(|job| job.job_id == job_id)
        .ok_or_else(|| PRINT_JOB_NOT_FOUND.to_owned())?;
    check_owner(&job.owner, owner)?;
    Ok(job)
}

fn check_owner(expected: &PdfOwner, actual: &PdfOwner) -> Result<(), String> {
    if expected.window_label != actual.window_label {
        Err(PRINT_OWNER_MISMATCH.to_owned())
    } else if expected.generation != actual.generation {
        Err(PRINT_GENERATION_MISMATCH.to_owned())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn payload(
        page_number: u32,
        width: u32,
        height: u32,
        width_points: f64,
        height_points: f64,
    ) -> Vec<u8> {
        let pixels = (width as usize) * (height as usize) * 4;
        let mut payload = vec![0_u8; PRINT_PAGE_HEADER_BYTES + pixels];
        payload[0..4].copy_from_slice(&PRINT_PAGE_MAGIC.to_le_bytes());
        payload[4..8].copy_from_slice(&page_number.to_le_bytes());
        payload[8..12].copy_from_slice(&width.to_le_bytes());
        payload[12..16].copy_from_slice(&height.to_le_bytes());
        payload[16..24].copy_from_slice(&width_points.to_le_bytes());
        payload[24..32].copy_from_slice(&height_points.to_le_bytes());
        payload
    }

    fn owner(label: &str, generation: u64) -> PdfOwner {
        PdfOwner {
            window_label: label.to_owned(),
            generation,
        }
    }

    #[test]
    fn ranges_are_sorted_merged_and_bounded() {
        assert_eq!(
            normalize_page_ranges(
                &[
                    PrintPageRange { from: 8, to: 9 },
                    PrintPageRange { from: 2, to: 4 },
                    PrintPageRange { from: 4, to: 7 },
                ],
                10,
            ),
            Ok(vec![PrintPageRange { from: 2, to: 9 }])
        );
        assert_eq!(
            normalize_page_ranges(&[PrintPageRange { from: 0, to: 1 }], 10),
            Err(PRINT_RANGE_INVALID)
        );
        assert_eq!(
            normalize_page_ranges(&[PrintPageRange { from: 2, to: 11 }], 10),
            Err(PRINT_RANGE_INVALID)
        );
        assert_eq!(
            normalize_page_ranges(
                &vec![PrintPageRange { from: 1, to: 1 }; MAX_PRINT_PAGE_RANGES + 1],
                10,
            ),
            Err(PRINT_RANGE_INVALID)
        );
    }

    #[test]
    fn cursor_requires_every_selected_page_once_in_order() {
        let mut cursor = PageCursor::new(vec![
            PrintPageRange { from: 2, to: 3 },
            PrintPageRange { from: 7, to: 8 },
        ]);
        assert_eq!(cursor.expected(), Some(2));
        assert_eq!(cursor.advance(3), Err(PRINT_PAGE_ORDER));
        for page in [2, 3, 7, 8] {
            assert_eq!(cursor.expected(), Some(page));
            assert_eq!(cursor.advance(page), Ok(()));
        }
        assert_eq!(cursor.expected(), None);
        assert_eq!(cursor.advance(9), Err(PRINT_PAGE_ORDER));
    }

    #[test]
    fn binary_page_header_and_exact_bgra_length_are_enforced() {
        let mut page = RasterPage::parse(payload(4, 2, 3, 0.48, 0.72)).unwrap();
        assert_eq!(page.page_number(), 4);
        assert_eq!(page.width(), 2);
        assert_eq!(page.height(), 3);
        assert_eq!(page.pixels_mut().len(), 24);

        let mut trailing = payload(1, 1, 1, 0.24, 0.24);
        trailing.push(0);
        assert_eq!(
            RasterPage::parse(trailing).unwrap_err(),
            PRINT_PAYLOAD_INVALID
        );
        assert_eq!(
            RasterPage::parse(payload(1, 1, 1, 72.0, 72.0)).unwrap_err(),
            PRINT_PAYLOAD_INVALID
        );
        let mut non_finite = payload(1, 1, 1, f64::NAN, 1.0);
        non_finite[16..24].copy_from_slice(&f64::INFINITY.to_le_bytes());
        assert_eq!(
            RasterPage::parse(non_finite).unwrap_err(),
            PRINT_PAYLOAD_INVALID
        );
        assert_eq!(
            RasterPage::parse(payload(1, MAX_PRINT_PAGE_DIMENSION + 1, 1, 1.0, 1.0)).unwrap_err(),
            PRINT_PAYLOAD_INVALID
        );
    }

    #[test]
    fn owner_window_and_generation_are_checked_separately() {
        let expected = owner("reader-a", 7);
        assert_eq!(
            check_owner(&expected, &owner("reader-b", 7)),
            Err(PRINT_OWNER_MISMATCH.to_owned())
        );
        assert_eq!(
            check_owner(&expected, &owner("reader-a", 8)),
            Err(PRINT_GENERATION_MISMATCH.to_owned())
        );
        assert_eq!(check_owner(&expected, &expected), Ok(()));
    }

    #[test]
    fn fake_consumer_advances_state_only_after_exact_page_completion() {
        let shared = Arc::new(ManagerShared::new());
        let cancellation_flag = Arc::new(AtomicBool::new(false));
        let cancellation = Arc::new(crate::print_windows::PrintCancellation::new(
            cancellation_flag,
        ));
        let (commands, _receiver) = mpsc::sync_channel(1);
        shared.state.lock().unwrap().job = Some(PrintJob {
            owner: owner("reader", 1),
            job_id: "job".to_owned(),
            phase: PrintPhase::Dialog,
            page_count: 3,
            page_ranges: Vec::new(),
            page_cursor: None,
            selected_pages: 0,
            submitted_pages: 0,
            error: None,
            pending_operation: false,
            worker_live: true,
            abandoned: false,
            cancellation,
            commands,
        });
        let observer = PrintWorkerObserver {
            shared: shared.clone(),
            job_id: "job".to_owned(),
        };
        assert_eq!(
            observer.dialog_ready(&[PrintPageRange { from: 2, to: 3 }], 3),
            Ok(true)
        );
        {
            let mut state = shared.state.lock().unwrap();
            let job = state.job.as_mut().unwrap();
            job.pending_operation = true;
            job.phase = PrintPhase::Printing;
        }
        assert_eq!(observer.page_submitted(3), Err(PRINT_PAGE_ORDER));
        assert_eq!(
            shared
                .state
                .lock()
                .unwrap()
                .job
                .as_ref()
                .unwrap()
                .submitted_pages,
            0
        );
        assert_eq!(observer.page_submitted(2), Ok(true));
        assert_eq!(
            shared
                .state
                .lock()
                .unwrap()
                .job
                .as_ref()
                .unwrap()
                .submitted_pages,
            1
        );
    }

    #[test]
    fn successful_end_doc_survives_late_cancel_and_cleanup_failure_stays_failed() {
        let shared = Arc::new(ManagerShared::new());
        let flag = Arc::new(AtomicBool::new(true));
        let cancellation = Arc::new(crate::print_windows::PrintCancellation::new(flag));
        let (commands, _receiver) = mpsc::sync_channel(1);
        shared.state.lock().unwrap().job = Some(PrintJob {
            owner: owner("reader", 3),
            job_id: "job".to_owned(),
            phase: PrintPhase::Printing,
            page_count: 1,
            page_ranges: vec![PrintPageRange { from: 1, to: 1 }],
            page_cursor: Some(PageCursor::new(vec![PrintPageRange { from: 1, to: 1 }])),
            selected_pages: 1,
            submitted_pages: 1,
            error: None,
            pending_operation: true,
            worker_live: true,
            abandoned: false,
            cancellation,
            commands,
        });
        let (completion, acknowledged) = mpsc::sync_channel(1);
        // The native worker creates Submitted only after EndDoc succeeds.
        shared.settle_worker("job", PrintWorkerResult::submitted(completion));
        assert_eq!(acknowledged.recv(), Ok(()));
        {
            let state = shared.state.lock().unwrap();
            let job = state.job.as_ref().unwrap();
            assert_eq!(job.phase, PrintPhase::Submitted);
            assert_eq!(job.error, None);
        }

        {
            let mut state = shared.state.lock().unwrap();
            let job = state.job.as_mut().unwrap();
            job.phase = PrintPhase::Printing;
            job.pending_operation = true;
            job.worker_live = true;
        }
        shared.settle_worker(
            "job",
            PrintWorkerResult::cancelled(None).with_failure("PRINT_ABORT_DOC_FAILED"),
        );
        let state = shared.state.lock().unwrap();
        let job = state.job.as_ref().unwrap();
        assert_eq!(job.phase, PrintPhase::Failed);
        assert_eq!(job.error.as_deref(), Some("PRINT_ABORT_DOC_FAILED"));
    }

    #[test]
    fn admission_rollback_preserves_a_racing_terminal_state() {
        let shared = Arc::new(ManagerShared::new());
        let cancellation = Arc::new(crate::print_windows::PrintCancellation::new(Arc::new(
            AtomicBool::new(true),
        )));
        let (commands, _receiver) = mpsc::sync_channel(1);
        shared.state.lock().unwrap().job = Some(PrintJob {
            owner: owner("reader", 5),
            job_id: "job".to_owned(),
            phase: PrintPhase::Failed,
            page_count: 1,
            page_ranges: vec![PrintPageRange { from: 1, to: 1 }],
            page_cursor: Some(PageCursor::new(vec![PrintPageRange { from: 1, to: 1 }])),
            selected_pages: 1,
            submitted_pages: 0,
            error: Some("PRINT_WORKER_DISCONNECTED".to_owned()),
            pending_operation: false,
            worker_live: false,
            abandoned: false,
            cancellation,
            commands,
        });
        let manager = PrintJobManager {
            shared: shared.clone(),
        };
        manager
            .revert_admission(&owner("reader", 5), "job")
            .unwrap();
        let state = shared.state.lock().unwrap();
        let job = state.job.as_ref().unwrap();
        assert_eq!(job.phase, PrintPhase::Failed);
        assert_eq!(job.error.as_deref(), Some("PRINT_WORKER_DISCONNECTED"));
        assert!(!job.worker_live);
    }

    #[test]
    fn abandoned_job_is_reaped_only_after_raw_worker_settlement() {
        let cancellation = Arc::new(crate::print_windows::PrintCancellation::new(Arc::new(
            AtomicBool::new(true),
        )));
        let (commands, _receiver) = mpsc::sync_channel(1);
        let mut state = ManagerState {
            job: Some(PrintJob {
                owner: owner("destroyed", 4),
                job_id: "orphan".to_owned(),
                phase: PrintPhase::Cancelled,
                page_count: 1,
                page_ranges: Vec::new(),
                page_cursor: None,
                selected_pages: 0,
                submitted_pages: 0,
                error: None,
                pending_operation: false,
                worker_live: true,
                abandoned: true,
                cancellation,
                commands,
            }),
        };
        assert!(!reap_finished_abandoned(&mut state));
        state.job.as_mut().unwrap().worker_live = false;
        assert!(reap_finished_abandoned(&mut state));
        assert!(state.job.is_none());
    }

    #[test]
    fn cancellation_is_idempotent_and_does_not_free_a_live_slot() {
        let shared = Arc::new(ManagerShared::new());
        let flag = Arc::new(AtomicBool::new(false));
        let cancellation = Arc::new(crate::print_windows::PrintCancellation::new(flag.clone()));
        let (commands, receiver) = mpsc::sync_channel(1);
        shared.state.lock().unwrap().job = Some(PrintJob {
            owner: owner("reader", 2),
            job_id: "job".to_owned(),
            phase: PrintPhase::Ready,
            page_count: 1,
            page_ranges: vec![PrintPageRange { from: 1, to: 1 }],
            page_cursor: Some(PageCursor::new(vec![PrintPageRange { from: 1, to: 1 }])),
            selected_pages: 1,
            submitted_pages: 0,
            error: None,
            pending_operation: false,
            worker_live: true,
            abandoned: false,
            cancellation,
            commands,
        });
        let manager = PrintJobManager {
            shared: shared.clone(),
        };

        manager.cancel_owner("reader");
        assert!(flag.load(Ordering::Acquire));
        assert!(matches!(
            receiver.try_recv(),
            Ok(PrintWorkerCommand::Cancel)
        ));
        manager.cancel_owner("reader");
        let state = shared.state.lock().unwrap();
        let job = state.job.as_ref().unwrap();
        assert!(job.worker_live);
        assert_eq!(job.phase, PrintPhase::Ready);
    }
}

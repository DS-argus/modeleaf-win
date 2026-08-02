use serde::Serialize;
#[cfg(windows)]
use std::sync::{
    mpsc::{self, SyncSender},
    Arc, Condvar, Mutex, OnceLock,
};
#[cfg(windows)]
use std::time::{Duration, Instant};
use url::Url;
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
#[cfg(windows)]
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW};

const MAX_TARGET_BYTES: usize = 8_192;
#[cfg(windows)]
const EXTERNAL_LINK_DISPATCH_QUEUE: usize = 32;
#[cfg(windows)]
const EXTERNAL_LINK_DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(windows)]
fn remaining_until(deadline: Instant) -> Result<Duration, ExternalLinkError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(ExternalLinkError::LinkDispatchExpired)
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExternalLinkError {
    LinkRejected,
    LinkCapacity,
    AnnotationNotFound,
    SessionNotFound,
    OwnerMismatch,
    GenerationMismatch,
    SessionClosing,
    StaleRegistration,
    LinkLaunchFailed,
    /// Injectable terminal outcome retained for operation replay; production dispatch never reports it while a worker is outstanding.
    LinkLaunchTimeout,
    LinkDispatcherUnavailable,
    LinkDispatcherFull,
    LinkDispatchExpired,
    LinkOperationExpired,
    LinkOperationInProgress,
    LinkOperationMismatch,
}
impl ExternalLinkError {
    pub fn tag(&self) -> &'static str {
        match self {
            Self::LinkRejected => "LINK_REJECTED",
            Self::LinkCapacity => "LINK_CAPACITY",
            Self::AnnotationNotFound => "ANNOTATION_NOT_FOUND",
            Self::SessionNotFound => "SESSION_NOT_FOUND",
            Self::OwnerMismatch => "OWNER_MISMATCH",
            Self::GenerationMismatch => "GENERATION_MISMATCH",
            Self::SessionClosing => "SESSION_CLOSING",
            Self::StaleRegistration => "STALE_REGISTRATION",
            Self::LinkLaunchFailed => "LINK_LAUNCH_FAILED",
            Self::LinkLaunchTimeout => "LINK_LAUNCH_TIMEOUT",
            Self::LinkDispatcherUnavailable => "LINK_DISPATCHER_UNAVAILABLE",
            Self::LinkDispatcherFull => "LINK_DISPATCHER_FULL",
            Self::LinkDispatchExpired => "LINK_DISPATCH_EXPIRED",
            Self::LinkOperationExpired => "LINK_OPERATION_EXPIRED",
            Self::LinkOperationInProgress => "LINK_OPERATION_IN_PROGRESS",
            Self::LinkOperationMismatch => "LINK_OPERATION_MISMATCH",
        }
    }
}
impl std::fmt::Display for ExternalLinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.tag())
    }
}
impl std::error::Error for ExternalLinkError {}

pub fn validate_external_link(target: &str) -> Result<(), ExternalLinkError> {
    if target.is_empty() || target.len() > MAX_TARGET_BYTES || target.chars().any(char::is_control)
    {
        return Err(ExternalLinkError::LinkRejected);
    }
    let parsed = Url::parse(target).map_err(|_| ExternalLinkError::LinkRejected)?;
    match parsed.scheme() {
        "http" | "https"
            if parsed.host().is_some()
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && !has_raw_userinfo(target) =>
        {
            Ok(())
        }

        "mailto" => {
            let recipient = target
                .split_once(':')
                .map(|(_, remainder)| remainder.split('?').next().unwrap_or(remainder))
                .ok_or(ExternalLinkError::LinkRejected)?;
            if valid_mailto_recipient(recipient) && !has_encoded_cr_or_lf(target) {
                Ok(())
            } else {
                Err(ExternalLinkError::LinkRejected)
            }
        }
        _ => Err(ExternalLinkError::LinkRejected),
    }
}
#[cfg(any(test, debug_assertions))]
pub fn open_external_link_with<F, E>(target: &str, launcher: F) -> Result<(), ExternalLinkError>
where
    F: FnOnce(&str) -> Result<(), E>,
{
    validate_external_link(target)?;
    launcher(target).map_err(|_| ExternalLinkError::LinkLaunchFailed)
}
pub(crate) fn launch_external_link(target: &str) -> Result<(), ExternalLinkError> {
    validate_external_link(target)?;
    dispatch_registered_handler(target.to_owned())
}
fn has_raw_userinfo(target: &str) -> bool {
    let Some((_, remainder)) = target.split_once(':') else {
        return false;
    };
    let Some(authority) = remainder.strip_prefix("//") else {
        return false;
    };
    authority
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(authority)
        .contains('@')
}
fn valid_mailto_recipient(path: &str) -> bool {
    let Some(path) = percent_decode_once(path) else {
        return false;
    };
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('/')
        && path.split(',').all(|recipient| {
            let Some((local, domain)) = recipient.split_once('@') else {
                return false;
            };
            !local.is_empty()
                && !domain.is_empty()
                && !domain.contains('@')
                && local
                    .chars()
                    .chain(domain.chars())
                    .all(|c| !c.is_whitespace() && !c.is_control())
        })
}
fn percent_decode_once(value: &str) -> Option<String> {
    fn hex_value(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            decoded
                .push(hex_value(*bytes.get(index + 1)?)? << 4 | hex_value(*bytes.get(index + 2)?)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}
fn has_encoded_cr_or_lf(target: &str) -> bool {
    target
        .as_bytes()
        .windows(3)
        .any(|b| b[0] == b'%' && b[1] == b'0' && matches!(b[2], b'a' | b'A' | b'd' | b'D'))
}
#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DispatchStartState {
    Pending,
    Started,
    Expired,
}

#[cfg(windows)]
struct DispatchStart {
    state: Mutex<DispatchStartState>,
    changed: Condvar,
}

#[cfg(windows)]
impl DispatchStart {
    fn new() -> Self {
        Self {
            state: Mutex::new(DispatchStartState::Pending),
            changed: Condvar::new(),
        }
    }
}

#[cfg(windows)]
struct DispatchJob {
    target: Vec<u16>,
    deadline: Instant,
    start: Arc<DispatchStart>,
    completion: SyncSender<Result<(), ExternalLinkError>>,
}

#[cfg(windows)]
enum DispatcherStatus {
    Uninitialized,
    Starting,
    Running(SyncSender<DispatchJob>),
    Shutdown,
    Failed,
}

#[cfg(windows)]
struct DispatcherState {
    status: DispatcherStatus,
}

#[cfg(windows)]
struct DispatcherLifecycle {
    state: Mutex<DispatcherState>,
    changed: Condvar,
}
#[cfg(windows)]
impl DispatcherLifecycle {
    fn new() -> Self {
        Self {
            state: Mutex::new(DispatcherState {
                status: DispatcherStatus::Uninitialized,
            }),
            changed: Condvar::new(),
        }
    }

    fn acquire<F>(
        &self,
        deadline: Instant,
        initializer: F,
    ) -> Result<SyncSender<DispatchJob>, ExternalLinkError>
    where
        F: FnOnce() -> Result<SyncSender<DispatchJob>, ExternalLinkError>,
    {
        let mut initializer = Some(initializer);
        let mut state = self
            .state
            .lock()
            .expect("external-link dispatcher poisoned");
        loop {
            remaining_until(deadline)?;
            match &state.status {
                DispatcherStatus::Running(sender) => return Ok(sender.clone()),
                DispatcherStatus::Shutdown | DispatcherStatus::Failed => {
                    return Err(ExternalLinkError::LinkDispatcherUnavailable)
                }
                DispatcherStatus::Starting => {
                    let remaining = remaining_until(deadline)?;
                    let (next, timeout) = self
                        .changed
                        .wait_timeout(state, remaining)
                        .expect("external-link dispatcher poisoned");
                    state = next;
                    if timeout.timed_out() && matches!(&state.status, DispatcherStatus::Starting) {
                        return Err(ExternalLinkError::LinkDispatchExpired);
                    }
                }
                DispatcherStatus::Uninitialized => {
                    state.status = DispatcherStatus::Starting;
                    drop(state);
                    let initialized = initializer
                        .take()
                        .expect("dispatcher initializer used once")(
                    );
                    state = self
                        .state
                        .lock()
                        .expect("external-link dispatcher poisoned");
                    match initialized {
                        Ok(sender) if matches!(&state.status, DispatcherStatus::Starting) => {
                            state.status = DispatcherStatus::Running(sender.clone());
                            self.changed.notify_all();
                            return Ok(sender);
                        }
                        Err(error) => {
                            if matches!(&state.status, DispatcherStatus::Starting) {
                                state.status = DispatcherStatus::Failed;
                            }
                            self.changed.notify_all();
                            return Err(error);
                        }
                        Ok(_) => return Err(ExternalLinkError::LinkDispatcherUnavailable),
                    }
                }
            }
        }
    }
    fn shutdown(&self) {
        let mut state = self
            .state
            .lock()
            .expect("external-link dispatcher poisoned");
        state.status = DispatcherStatus::Shutdown;
        self.changed.notify_all();
    }

    fn is_shutdown(&self) -> bool {
        matches!(
            self.state
                .lock()
                .expect("external-link dispatcher poisoned")
                .status,
            DispatcherStatus::Shutdown
        )
    }
}

#[cfg(windows)]
fn dispatcher_lifecycle() -> &'static DispatcherLifecycle {
    static DISPATCHER: OnceLock<DispatcherLifecycle> = OnceLock::new();
    DISPATCHER.get_or_init(DispatcherLifecycle::new)
}

#[cfg(windows)]
fn dispatcher(deadline: Instant) -> Result<SyncSender<DispatchJob>, ExternalLinkError> {
    dispatcher_lifecycle().acquire(deadline, || {
        let (sender, receiver) = mpsc::sync_channel::<DispatchJob>(EXTERNAL_LINK_DISPATCH_QUEUE);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let spawned = std::thread::Builder::new()
            .name("external-link-sta".into())
            .spawn(move || {
                if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
                    let _ = ready_sender.send(false);
                    return;
                }
                let _ = ready_sender.send(true);
                for job in receiver {
                    run_dispatch_job(job, shell_execute_lpfile);
                }
                unsafe { CoUninitialize() };
            });
        if spawned.is_err() {
            return Err(ExternalLinkError::LinkDispatcherUnavailable);
        }
        match remaining_until(deadline).and_then(|remaining| {
            ready_receiver
                .recv_timeout(remaining)
                .map_err(|_| ExternalLinkError::LinkDispatcherUnavailable)
        }) {
            Ok(true) => Ok(sender),
            Ok(false) | Err(ExternalLinkError::LinkDispatcherUnavailable) => {
                Err(ExternalLinkError::LinkDispatcherUnavailable)
            }
            Err(error) => Err(error),
        }
    })
}

pub(crate) fn shutdown_external_link_dispatcher() {
    #[cfg(windows)]
    dispatcher_lifecycle().shutdown();
}

#[cfg(windows)]
fn run_dispatch_job<F>(job: DispatchJob, executor: F)
where
    F: FnOnce(&[u16]) -> Result<(), ExternalLinkError>,
{
    run_dispatch_job_with_now(job, Instant::now, executor);
}

#[cfg(windows)]
fn run_dispatch_job_with_now<F, N>(job: DispatchJob, now: N, executor: F)
where
    F: FnOnce(&[u16]) -> Result<(), ExternalLinkError>,
    N: FnOnce() -> Instant,
{
    let started = {
        let mut state = job
            .start
            .state
            .lock()
            .expect("external-link dispatch start poisoned");
        if dispatcher_lifecycle().is_shutdown() || *state != DispatchStartState::Pending {
            false
        } else if now() >= job.deadline {
            *state = DispatchStartState::Expired;
            job.start.changed.notify_all();
            false
        } else {
            *state = DispatchStartState::Started;
            job.start.changed.notify_all();
            true
        }
    };
    let result = if started {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| executor(&job.target))) {
            Ok(result) => result,
            Err(_) => Err(ExternalLinkError::LinkLaunchFailed),
        }
    } else {
        Err(ExternalLinkError::LinkDispatchExpired)
    };
    let _ = job.completion.send(result);
}
#[cfg(windows)]
fn await_dispatch_start(start: &DispatchStart, deadline: Instant) -> Result<(), ExternalLinkError> {
    let mut state = start
        .state
        .lock()
        .expect("external-link dispatch start poisoned");
    loop {
        match *state {
            DispatchStartState::Started => return Ok(()),
            DispatchStartState::Expired => return Err(ExternalLinkError::LinkDispatchExpired),
            DispatchStartState::Pending => match remaining_until(deadline) {
                Ok(remaining) => {
                    let (next, _) = start
                        .changed
                        .wait_timeout(state, remaining)
                        .expect("external-link dispatch start poisoned");
                    state = next;
                }
                Err(_) => {
                    *state = DispatchStartState::Expired;
                    start.changed.notify_all();
                    return Err(ExternalLinkError::LinkDispatchExpired);
                }
            },
        }
    }
}

#[cfg(windows)]
fn await_dispatch_completion(
    completion: mpsc::Receiver<Result<(), ExternalLinkError>>,
) -> Result<(), ExternalLinkError> {
    completion
        .recv()
        .unwrap_or(Err(ExternalLinkError::LinkDispatcherUnavailable))
}

#[cfg(windows)]
fn enqueue_dispatch(
    sender: &SyncSender<DispatchJob>,
    target: Vec<u16>,
    deadline: Instant,
) -> Result<
    (
        Arc<DispatchStart>,
        mpsc::Receiver<Result<(), ExternalLinkError>>,
    ),
    ExternalLinkError,
> {
    remaining_until(deadline)?;
    let start = Arc::new(DispatchStart::new());
    let (completion_sender, completion_receiver) = mpsc::sync_channel(1);
    match sender.try_send(DispatchJob {
        target,
        deadline,
        start: start.clone(),
        completion: completion_sender,
    }) {
        Ok(()) => Ok((start, completion_receiver)),
        Err(mpsc::TrySendError::Full(_)) => Err(ExternalLinkError::LinkDispatcherFull),
        Err(mpsc::TrySendError::Disconnected(_)) => {
            Err(ExternalLinkError::LinkDispatcherUnavailable)
        }
    }
}

#[cfg(windows)]
fn dispatch_registered_handler(target: String) -> Result<(), ExternalLinkError> {
    let deadline = Instant::now() + EXTERNAL_LINK_DISPATCH_TIMEOUT;
    let target = target.encode_utf16().chain(std::iter::once(0)).collect();
    let (start, completion) = enqueue_dispatch(&dispatcher(deadline)?, target, deadline)?;
    await_dispatch_start(&start, deadline)?;
    await_dispatch_completion(completion)
}

#[cfg(not(windows))]
fn dispatch_registered_handler(_: String) -> Result<(), ExternalLinkError> {
    Err(ExternalLinkError::LinkDispatcherUnavailable)
}

#[cfg(windows)]
fn shell_execute_lpfile(target: &[u16]) -> Result<(), ExternalLinkError> {
    const SW_SHOWNORMAL: i32 = 1;
    let mut execute_info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_FLAG_NO_UI,
        lpFile: PCWSTR(target.as_ptr()),
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut execute_info) }.map_err(|_| ExternalLinkError::LinkLaunchFailed)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_targets_are_rejected_before_launcher_runs() {
        let mut launches = 0;
        assert_eq!(
            open_external_link_with("javascript:alert(1)", |_| {
                launches += 1;
                Ok::<(), ()>(())
            }),
            Err(ExternalLinkError::LinkRejected)
        );
        assert_eq!(launches, 0);
    }

    #[test]
    fn launcher_failure_has_stable_error() {
        assert_eq!(
            open_external_link_with("https://example.com/", |_| Err::<(), _>(())),
            Err(ExternalLinkError::LinkLaunchFailed)
        );
    }

    #[cfg(windows)]
    mod dispatcher {
        use super::*;
        use std::sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Barrier,
        };

        fn sender() -> SyncSender<DispatchJob> {
            let (sender, _receiver) = mpsc::sync_channel(1);
            sender
        }

        #[test]
        fn concurrent_startup_initializes_once() {
            let lifecycle = Arc::new(DispatcherLifecycle::new());
            let started = Arc::new(Barrier::new(2));
            let release = Arc::new(Barrier::new(2));
            let initializations = Arc::new(AtomicUsize::new(0));
            let first_lifecycle = lifecycle.clone();
            let first_started = started.clone();
            let first_release = release.clone();
            let first_initializations = initializations.clone();
            let first = std::thread::spawn(move || {
                first_lifecycle.acquire(Instant::now() + Duration::from_secs(1), move || {
                    first_initializations.fetch_add(1, Ordering::SeqCst);
                    first_started.wait();
                    first_release.wait();
                    Ok(sender())
                })
            });
            started.wait();
            let second_lifecycle = lifecycle.clone();
            let second = std::thread::spawn(move || {
                second_lifecycle.acquire(Instant::now() + Duration::from_secs(1), || Ok(sender()))
            });
            release.wait();
            assert!(first.join().unwrap().is_ok());
            assert!(second.join().unwrap().is_ok());
            assert_eq!(initializations.load(Ordering::SeqCst), 1);
        }

        #[test]
        fn readiness_failure_and_shutdown_are_sticky() {
            let failed = DispatcherLifecycle::new();
            assert!(matches!(
                failed.acquire(Instant::now() + Duration::from_secs(1), || Err(
                    ExternalLinkError::LinkDispatcherUnavailable
                )),
                Err(ExternalLinkError::LinkDispatcherUnavailable)
            ));
            assert!(matches!(
                failed.acquire(Instant::now() + Duration::from_secs(1), || Ok(sender())),
                Err(ExternalLinkError::LinkDispatcherUnavailable)
            ));

            let starting = DispatcherLifecycle::new();
            assert!(matches!(
                starting.acquire(Instant::now() + Duration::from_secs(1), || {
                    starting.shutdown();
                    Ok(sender())
                }),
                Err(ExternalLinkError::LinkDispatcherUnavailable)
            ));
            let running = DispatcherLifecycle::new();
            assert!(running
                .acquire(Instant::now() + Duration::from_secs(1), || Ok(sender()))
                .is_ok());
            running.shutdown();
            let respawned = AtomicBool::new(false);
            assert!(matches!(
                running.acquire(Instant::now() + Duration::from_secs(1), || {
                    respawned.store(true, Ordering::SeqCst);
                    Ok(sender())
                }),
                Err(ExternalLinkError::LinkDispatcherUnavailable)
            ));
            assert!(!respawned.load(Ordering::SeqCst));
        }

        #[test]
        fn pre_start_deadline_expires_but_started_work_waits_for_settlement() {
            let lifecycle = DispatcherLifecycle::new();
            assert!(matches!(
                lifecycle.acquire(Instant::now(), || Ok(sender())),
                Err(ExternalLinkError::LinkDispatchExpired)
            ));

            let (sender, receiver) = mpsc::sync_channel(1);
            assert!(matches!(
                enqueue_dispatch(&sender, vec![0], Instant::now()),
                Err(ExternalLinkError::LinkDispatchExpired)
            ));
            drop(receiver);

            let (sender, receiver) = mpsc::sync_channel(1);
            let (executor_started_sender, executor_started_receiver) = mpsc::sync_channel(1);
            let (release_sender, release_receiver) = mpsc::sync_channel(1);
            let worker = std::thread::spawn(move || {
                let job = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
                run_dispatch_job(job, |_| {
                    executor_started_sender.send(()).unwrap();
                    release_receiver
                        .recv_timeout(Duration::from_secs(1))
                        .unwrap();
                    Ok(())
                });
            });
            let deadline = Instant::now() + Duration::from_secs(1);
            let (start, completion) = enqueue_dispatch(&sender, vec![0], deadline).unwrap();
            executor_started_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
            assert_eq!(await_dispatch_start(&start, deadline), Ok(()));

            let (completion_waiter_started_sender, completion_waiter_started_receiver) =
                mpsc::sync_channel(1);
            let (result_sender, result_receiver) = mpsc::sync_channel(1);
            let waiter = std::thread::spawn(move || {
                completion_waiter_started_sender.send(()).unwrap();
                result_sender
                    .send(await_dispatch_completion(completion))
                    .unwrap();
            });
            completion_waiter_started_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
            assert!(matches!(
                result_receiver.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            release_sender.send(()).unwrap();
            assert_eq!(
                result_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap(),
                Ok(())
            );
            waiter.join().unwrap();
            worker.join().unwrap();
        }

        #[test]
        fn deadline_crossing_before_start_skips_executor() {
            let deadline = Instant::now() + Duration::from_secs(1);
            let start = Arc::new(DispatchStart::new());
            let start_for_now = start.clone();
            let (completion, result) = mpsc::sync_channel(1);
            let called = AtomicBool::new(false);
            run_dispatch_job_with_now(
                DispatchJob {
                    target: vec![0],
                    deadline,
                    start: start.clone(),
                    completion,
                },
                move || {
                    assert!(matches!(
                        start_for_now.state.try_lock(),
                        Err(std::sync::TryLockError::WouldBlock)
                    ));
                    deadline
                },
                |_| {
                    called.store(true, Ordering::SeqCst);
                    Ok(())
                },
            );
            assert_eq!(*start.state.lock().unwrap(), DispatchStartState::Expired);
            assert!(matches!(
                result.recv_timeout(Duration::ZERO),
                Ok(Err(ExternalLinkError::LinkDispatchExpired))
            ));
            assert!(!called.load(Ordering::SeqCst));
        }
        #[test]
        fn blocked_worker_cannot_launch_expired_queued_successor() {
            let (sender, receiver) = mpsc::sync_channel(2);
            let (first_started_sender, first_started_receiver) = mpsc::sync_channel(1);
            let (release_sender, release_receiver) = mpsc::sync_channel(1);
            let launched_successor = Arc::new(AtomicBool::new(false));
            let successor_launched_by_worker = launched_successor.clone();
            let worker = std::thread::spawn(move || {
                let first = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
                run_dispatch_job(first, |_| {
                    first_started_sender.send(()).unwrap();
                    release_receiver
                        .recv_timeout(Duration::from_secs(1))
                        .unwrap();
                    Ok(())
                });
                let successor = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
                run_dispatch_job(successor, |_| {
                    successor_launched_by_worker.store(true, Ordering::SeqCst);
                    Ok(())
                });
            });
            let first_deadline = Instant::now() + Duration::from_secs(1);
            let (_first_start, first_completion) =
                enqueue_dispatch(&sender, vec![0], first_deadline).unwrap();
            first_started_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap();

            let successor_deadline = Instant::now() + Duration::from_millis(50);
            let (successor_start, successor_completion) =
                enqueue_dispatch(&sender, vec![0], successor_deadline).unwrap();
            assert!(matches!(
                await_dispatch_start(&successor_start, successor_deadline),
                Err(ExternalLinkError::LinkDispatchExpired)
            ));
            release_sender.send(()).unwrap();
            assert!(first_completion
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .is_ok());
            assert!(matches!(
                successor_completion.recv_timeout(Duration::from_secs(1)),
                Ok(Err(ExternalLinkError::LinkDispatchExpired))
            ));
            worker.join().unwrap();
            assert!(!launched_successor.load(Ordering::SeqCst));
        }
    }
}

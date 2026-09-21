use crate::pdf_session::{PdfOwner, PdfSessionError, PdfSessionManager, SessionId};
use crate::workspace::{WorkspaceError, WorkspaceManager, MAX_WINDOWS};
use rand::RngCore;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const MAX_OPEN_REQUESTS: usize = 8;
pub const MAX_OPEN_FAILURES: usize = 8;
pub const MAX_OPEN_FAILURES_PER_OWNER: usize = MAX_OPEN_FAILURES / MAX_WINDOWS;
pub const MAX_OPEN_FAILURE_TOMBSTONES: usize = 64;
pub const MAX_OPEN_REQUEST_TOMBSTONES: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
pub struct OpenRequestId(String);
impl OpenRequestId {
    fn random() -> Self {
        let mut bytes = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        Self(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub fn from_opaque(value: String) -> Result<Self, OpenRequestError> {
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            Ok(Self(value))
        } else {
            Err(OpenRequestError::NotFound)
        }
    }

    pub fn into_opaque(self) -> String {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequestNotice {
    pub request_id: OpenRequestId,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize)]
pub struct OpenFailureId(String);
impl OpenFailureId {
    fn random() -> Self {
        let mut bytes = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        Self(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub fn from_opaque(value: String) -> Result<Self, OpenRequestError> {
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            Ok(Self(value))
        } else {
            Err(OpenRequestError::NotFound)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OpenFailureTag {
    PathRejected,
    PdfInvalid,
    MissingFile,
    FileUnreadable,
    SessionCapacity,
    DocumentTooLarge,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFailureNotice {
    pub failure_id: OpenFailureId,
    pub tag: OpenFailureTag,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedOpenRequest {
    pub session_id: SessionId,
    pub document_generation: u64,
    pub owner_generation: u64,
    pub length: u64,
    pub display_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "tag",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum OpenRequestError {
    NotFound,
    Capacity,
    OwnerMismatch,
    NotClaimed,
    Cancelled,
    Rejected,
    DeliveryExpired,
    Session(PdfSessionError),
}
impl std::fmt::Display for OpenRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotFound => "OPEN_REQUEST_NOT_FOUND",
            Self::Capacity => "OPEN_REQUEST_CAPACITY",
            Self::OwnerMismatch => "OPEN_REQUEST_OWNER_MISMATCH",
            Self::NotClaimed => "OPEN_REQUEST_NOT_CLAIMED",
            Self::Cancelled => "OPEN_REQUEST_CANCELLED",
            Self::Rejected => "OPEN_REQUEST_REJECTED",
            Self::DeliveryExpired => "OPEN_REQUEST_DELIVERY_EXPIRED",
            Self::Session(error) => error.tag(),
        })
    }
}
impl std::error::Error for OpenRequestError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "tag",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum PendingIngressNotice {
    OpenRequest {
        request_id: OpenRequestId,
    },
    OpenFailure {
        failure_id: OpenFailureId,
        failure_tag: OpenFailureTag,
    },
}
impl From<PdfSessionError> for OpenRequestError {
    fn from(value: PdfSessionError) -> Self {
        Self::Session(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Terminal {
    Acknowledged,
    Cancelled,
    Rejected,
}
struct PendingReservation {
    owner: PdfOwner,
    insertion_order: u64,
    valid: bool,
}

/// RAII admission for one bounded native open operation.
///
/// The admission owns the reservation until `ingest_reserved` settles it. Dropping it before
/// settlement releases the reservation, while owner invalidation deliberately leaves the pending
/// work counted until the worker settles.
pub struct OpenAdmission {
    coordinator: OpenRequestCoordinator,
    owner: PdfOwner,
    reservation_id: u64,
    settled: bool,
}

impl OpenAdmission {
    /// Returns the exact native owner captured before dispatch.
    pub fn owner(&self) -> &PdfOwner {
        &self.owner
    }
}

impl Drop for OpenAdmission {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        self.coordinator.release_reservation(self.reservation_id);
    }
}
struct LiveRequest {
    owner: PdfOwner,
    response: ClaimedOpenRequest,
    insertion_order: u64,
    claimed: bool,
}
struct DeferredCleanup {
    owner: PdfOwner,
    generation: u64,
    request_id: Option<OpenRequestId>,
}
struct Requests {
    pending: HashMap<u64, PendingReservation>,
    live: HashMap<OpenRequestId, LiveRequest>,
    terminal: HashMap<OpenRequestId, Terminal>,
    terminal_order: VecDeque<OpenRequestId>,
}

/// Native-only coordinator. Paths are consumed synchronously and never retained or serialized.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FailureTerminal {
    Acknowledged,
    Cancelled,
}
struct LiveFailure {
    owner: PdfOwner,
    tag: OpenFailureTag,
    insertion_order: u64,
}

struct Failures {
    live: HashMap<OpenFailureId, LiveFailure>,
    terminal: HashMap<OpenFailureId, FailureTerminal>,
    terminal_order: VecDeque<OpenFailureId>,
}

struct IngressOrder {
    next: u64,
}
#[derive(Clone)]
pub struct OpenRequestCoordinator {
    sessions: PdfSessionManager,
    workspace: WorkspaceManager,
    requests: Arc<Mutex<Requests>>,
    failures: Arc<Mutex<Failures>>,
    deferred: Arc<Mutex<HashMap<SessionId, DeferredCleanup>>>,
    ingress: Arc<Mutex<IngressOrder>>,
}

impl OpenRequestCoordinator {
    pub fn new(sessions: PdfSessionManager, workspace: WorkspaceManager) -> Self {
        Self {
            sessions,
            workspace,
            requests: Arc::new(Mutex::new(Requests {
                live: HashMap::new(),
                pending: HashMap::new(),
                terminal: HashMap::new(),
                terminal_order: VecDeque::new(),
            })),
            failures: Arc::new(Mutex::new(Failures {
                live: HashMap::new(),
                terminal: HashMap::new(),
                terminal_order: VecDeque::new(),
            })),
            ingress: Arc::new(Mutex::new(IngressOrder { next: 0 })),
            deferred: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Reserves bounded open capacity and captures the exact native owner before dispatch.
    pub fn reserve_open(&self, window_label: &str) -> Result<OpenAdmission, OpenRequestError> {
        self.reap_deferred();
        let mut ingress = self.ingress.lock().expect("open ingress order poisoned");
        let owner = self
            .workspace
            .active_owner(window_label)
            .ok_or(OpenRequestError::OwnerMismatch)?;
        let insertion_order = ingress.next;
        let next_order = insertion_order
            .checked_add(1)
            .ok_or(OpenRequestError::Capacity)?;
        let mut requests = self.requests.lock().expect("open request state poisoned");
        if requests.live.len().saturating_add(requests.pending.len()) >= MAX_OPEN_REQUESTS {
            return Err(OpenRequestError::Capacity);
        }
        requests.pending.insert(
            insertion_order,
            PendingReservation {
                owner: owner.clone(),
                insertion_order,
                valid: true,
            },
        );
        ingress.next = next_order;
        Ok(OpenAdmission {
            coordinator: self.clone(),
            owner,
            reservation_id: insertion_order,
            settled: false,
        })
    }

    /// Opens a reserved path without holding coordinator or workspace locks across I/O, then
    /// publishes only if the reservation and its captured owner are still current.
    pub fn ingest_reserved(
        &self,
        mut admission: OpenAdmission,
        path: &Path,
    ) -> Result<OpenRequestNotice, OpenRequestError> {
        let owner = admission.owner.clone();
        let coordinator = admission.coordinator.clone();
        coordinator.ensure_reservation_current(&owner, admission.reservation_id)?;
        let metadata = match coordinator.sessions.open_local_file(owner.clone(), path) {
            Ok(metadata) => metadata,
            Err(error) => {
                return Err(error.into());
            }
        };
        let result = coordinator.commit_reserved(&owner, admission.reservation_id, metadata, path);
        admission.settled = true;
        result
    }

    /// Convenience path for callers that do not need to dispatch the blocking open themselves.
    pub fn ingest_path(
        &self,
        window_label: &str,
        path: &Path,
    ) -> Result<OpenRequestNotice, OpenRequestError> {
        let admission = self.reserve_open(window_label)?;
        self.ingest_reserved(admission, path)
    }

    fn ensure_reservation_current(
        &self,
        owner: &PdfOwner,
        reservation_id: u64,
    ) -> Result<(), OpenRequestError> {
        let _ingress = self.ingress.lock().expect("open ingress order poisoned");
        let requests = self.requests.lock().expect("open request state poisoned");
        let current = requests
            .pending
            .get(&reservation_id)
            .is_some_and(|reservation| reservation.owner == *owner && reservation.valid);
        if !current {
            return Err(OpenRequestError::Cancelled);
        }
        self.workspace.check_owner(owner).map_err(workspace_error)
    }

    fn commit_reserved(
        &self,
        owner: &PdfOwner,
        reservation_id: u64,
        metadata: crate::pdf_session::PdfSessionMetadata,
        path: &Path,
    ) -> Result<OpenRequestNotice, OpenRequestError> {
        let unadopted = (metadata.session_id.clone(), metadata.document_generation);
        let mut rejection = None;
        let mut notice = None;
        {
            let _ingress = self.ingress.lock().expect("open ingress order poisoned");
            let mut requests = self.requests.lock().expect("open request state poisoned");
            let reservation = requests.pending.get(&reservation_id);
            let current = reservation
                .is_some_and(|reservation| reservation.owner == *owner && reservation.valid);
            if !current {
                requests.pending.remove(&reservation_id);
                rejection = Some(OpenRequestError::Cancelled);
            } else if let Err(error) = self.workspace.check_owner(owner) {
                requests.pending.remove(&reservation_id);
                rejection = Some(workspace_error(error));
            } else if let Err(error) = self
                .workspace
                .admit_session(owner, metadata.session_id.clone())
            {
                requests.pending.remove(&reservation_id);
                rejection = Some(workspace_error(error));
            } else {
                let reservation = requests
                    .pending
                    .remove(&reservation_id)
                    .expect("reserved open disappeared after validation");
                let request_id = OpenRequestId::random();
                let response = ClaimedOpenRequest {
                    session_id: metadata.session_id.clone(),
                    owner_generation: owner.generation,
                    document_generation: metadata.document_generation,
                    length: metadata.length,
                    display_name: display_name(path),
                };
                requests.live.insert(
                    request_id.clone(),
                    LiveRequest {
                        owner: owner.clone(),
                        response,
                        insertion_order: reservation.insertion_order,
                        claimed: false,
                    },
                );
                notice = Some(OpenRequestNotice { request_id });
            }
        }
        if let Some(error) = rejection {
            let _ = self.drain(owner, &unadopted.0, unadopted.1);
            return Err(error);
        }
        Ok(notice.expect("reserved open must publish or reject"))
    }

    fn release_reservation(&self, reservation_id: u64) {
        self.requests
            .lock()
            .expect("open request state poisoned")
            .pending
            .remove(&reservation_id);
    }

    /// Reports whether unsettled open work remains for this exact owner.
    pub fn has_pending_for_owner(&self, owner: &PdfOwner) -> bool {
        self.requests
            .lock()
            .expect("open request state poisoned")
            .pending
            .values()
            .any(|reservation| reservation.owner == *owner)
    }

    /// Lists IDs still awaiting terminal acknowledgement for the current native owner without
    /// changing their claim or delivery state.
    pub fn pending_notices(
        &self,
        window_label: &str,
    ) -> Result<Vec<OpenRequestNotice>, OpenRequestError> {
        let owner = self
            .workspace
            .active_owner(window_label)
            .ok_or(OpenRequestError::OwnerMismatch)?;
        self.reap_deferred_for_owner(&owner);
        let requests = self.requests.lock().expect("open request state poisoned");
        let mut notices: Vec<_> = requests
            .live
            .iter()
            .filter(|(_, request)| request.owner == owner)
            .map(|(request_id, request)| {
                (
                    request.insertion_order,
                    OpenRequestNotice {
                        request_id: request_id.clone(),
                    },
                )
            })
            .collect();
        notices.sort_by_key(|(insertion_order, _)| *insertion_order);
        Ok(notices.into_iter().map(|(_, notice)| notice).collect())
    }

    /// Queues a path-free native-ingress failure for the current owner.
    pub fn ingest_failure(
        &self,
        window_label: &str,
        error: OpenRequestError,
    ) -> Result<OpenFailureNotice, OpenRequestError> {
        let mut ingress = self.ingress.lock().expect("open ingress order poisoned");
        let owner = self
            .workspace
            .active_owner(window_label)
            .ok_or(OpenRequestError::OwnerMismatch)?;
        self.ingest_failure_locked(&mut ingress, owner, error)
    }

    /// Queues a failure for the exact owner captured before asynchronous dispatch.
    pub fn ingest_failure_owned(
        &self,
        owner: &PdfOwner,
        error: OpenRequestError,
    ) -> Result<OpenFailureNotice, OpenRequestError> {
        let mut ingress = self.ingress.lock().expect("open ingress order poisoned");
        self.workspace.check_owner(owner).map_err(workspace_error)?;
        self.ingest_failure_locked(&mut ingress, owner.clone(), error)
    }

    fn ingest_failure_locked(
        &self,
        ingress: &mut IngressOrder,
        owner: PdfOwner,
        error: OpenRequestError,
    ) -> Result<OpenFailureNotice, OpenRequestError> {
        let insertion_order = ingress.next;
        let next_order = insertion_order
            .checked_add(1)
            .ok_or(OpenRequestError::Capacity)?;
        let mut failures = self.failures.lock().expect("open failure state poisoned");
        let owner_at_capacity = failures
            .live
            .values()
            .filter(|failure| failure.owner == owner)
            .count()
            >= MAX_OPEN_FAILURES_PER_OWNER;
        let tag = if owner_at_capacity {
            let replaced_id = failures
                .live
                .iter()
                .filter(|(_, failure)| failure.owner == owner)
                .min_by_key(|(_, failure)| failure.insertion_order)
                .map(|(failure_id, _)| failure_id.clone())
                .expect("owner capacity requires a live owner failure");
            failures.live.remove(&replaced_id);
            insert_failure_terminal(&mut failures, replaced_id, FailureTerminal::Acknowledged);
            OpenFailureTag::SessionCapacity
        } else {
            if failures.live.len() >= MAX_OPEN_FAILURES {
                return Err(OpenRequestError::Capacity);
            }
            failure_tag(error)?
        };
        let failure_id = OpenFailureId::random();
        failures.live.insert(
            failure_id.clone(),
            LiveFailure {
                owner,
                tag,
                insertion_order,
            },
        );
        ingress.next = next_order;
        Ok(OpenFailureNotice { failure_id, tag })
    }

    /// Atomically returns every pending native ingress for this owner in publish order.
    pub fn pending_ingress(
        &self,
        window_label: &str,
    ) -> Result<Vec<PendingIngressNotice>, OpenRequestError> {
        let _ingress = self.ingress.lock().expect("open ingress order poisoned");
        let owner = self
            .workspace
            .active_owner(window_label)
            .ok_or(OpenRequestError::OwnerMismatch)?;
        self.reap_deferred_for_owner(&owner);
        let requests = self.requests.lock().expect("open request state poisoned");
        let failures = self.failures.lock().expect("open failure state poisoned");
        let mut notices: Vec<_> = requests
            .live
            .iter()
            .filter(|(_, request)| request.owner == owner)
            .map(|(request_id, request)| {
                (
                    request.insertion_order,
                    PendingIngressNotice::OpenRequest {
                        request_id: request_id.clone(),
                    },
                )
            })
            .chain(
                failures
                    .live
                    .iter()
                    .filter(|(_, failure)| failure.owner == owner)
                    .map(|(failure_id, failure)| {
                        (
                            failure.insertion_order,
                            PendingIngressNotice::OpenFailure {
                                failure_id: failure_id.clone(),
                                failure_tag: failure.tag,
                            },
                        )
                    }),
            )
            .collect();
        notices.sort_by_key(|(order, _)| *order);
        Ok(notices.into_iter().map(|(_, notice)| notice).collect())
    }

    pub fn pending_failures(
        &self,
        window_label: &str,
    ) -> Result<Vec<OpenFailureNotice>, OpenRequestError> {
        let owner = self
            .workspace
            .active_owner(window_label)
            .ok_or(OpenRequestError::OwnerMismatch)?;
        self.reap_deferred_for_owner(&owner);
        let failures = self.failures.lock().expect("open failure state poisoned");
        let mut notices: Vec<_> = failures
            .live
            .iter()
            .filter(|(_, failure)| failure.owner == owner)
            .map(|(failure_id, failure)| {
                (
                    failure.insertion_order,
                    OpenFailureNotice {
                        failure_id: failure_id.clone(),
                        tag: failure.tag,
                    },
                )
            })
            .collect();
        notices.sort_by_key(|(order, _)| *order);
        Ok(notices.into_iter().map(|(_, notice)| notice).collect())
    }

    pub fn acknowledge_failure(
        &self,
        window_label: &str,
        failure_id: OpenFailureId,
    ) -> Result<(), OpenRequestError> {
        let _ingress = self.ingress.lock().expect("open ingress order poisoned");
        let owner = self
            .workspace
            .active_owner(window_label)
            .ok_or(OpenRequestError::OwnerMismatch)?;
        let mut failures = self.failures.lock().expect("open failure state poisoned");
        match failures.live.get(&failure_id) {
            Some(failure) if failure.owner != owner => return Err(OpenRequestError::OwnerMismatch),
            Some(_) => {}
            None => return failure_terminal_result(&failures, &failure_id),
        }
        failures.live.remove(&failure_id);
        insert_failure_terminal(&mut failures, failure_id, FailureTerminal::Acknowledged);
        Ok(())
    }
    /// The only owner input is the live native workspace registration for this window.
    pub fn claim(
        &self,
        window_label: &str,
        request_id: OpenRequestId,
    ) -> Result<ClaimedOpenRequest, OpenRequestError> {
        let owner = self
            .workspace
            .active_owner(window_label)
            .ok_or(OpenRequestError::OwnerMismatch)?;
        let mut requests = self.requests.lock().expect("open request state poisoned");
        let request = match requests.live.get_mut(&request_id) {
            Some(request) => request,
            None => return terminal_error(&requests, &request_id),
        };
        if request.owner != owner {
            return Err(OpenRequestError::OwnerMismatch);
        }
        request.claimed = true;
        Ok(request.response.clone())
    }

    pub fn acknowledge(
        &self,
        window_label: &str,
        request_id: OpenRequestId,
    ) -> Result<(), OpenRequestError> {
        self.finish(window_label, request_id, Terminal::Acknowledged, false)
    }

    pub fn reject(
        &self,
        window_label: &str,
        request_id: OpenRequestId,
    ) -> Result<(), OpenRequestError> {
        self.finish(window_label, request_id, Terminal::Rejected, true)
    }

    /// Transfers all owner sessions to the lifecycle drain after tombstoning their ingress.
    /// The caller must invoke exactly one aggregate `PdfSessionManager::drain_owned` afterwards.
    pub fn target_lost_for_lifecycle(&self, owner: &PdfOwner) {
        let _ingress = self.ingress.lock().expect("open ingress order poisoned");
        {
            let mut failures = self.failures.lock().expect("open failure state poisoned");
            let ids: Vec<_> = failures
                .live
                .iter()
                .filter(|(_, failure)| failure.owner == *owner)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                failures.live.remove(&id);
                insert_failure_terminal(&mut failures, id, FailureTerminal::Cancelled);
            }
        }
        let mut state = self.requests.lock().expect("open request state poisoned");
        for reservation in state.pending.values_mut() {
            if reservation.owner == *owner {
                reservation.valid = false;
            }
        }
        let ids: Vec<_> = state
            .live
            .iter()
            .filter(|(_, request)| request.owner == *owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            state.live.remove(&id);
            insert_terminal(&mut state, id, Terminal::Cancelled);
        }
    }

    /// Must run before the workspace owner is destroyed. It never retargets a delivered request.
    pub fn target_lost(&self, owner: &PdfOwner) {
        let _ingress = self.ingress.lock().expect("open ingress order poisoned");
        {
            let mut failures = self.failures.lock().expect("open failure state poisoned");
            let ids: Vec<_> = failures
                .live
                .iter()
                .filter(|(_, failure)| failure.owner == *owner)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                failures.live.remove(&id);
                insert_failure_terminal(&mut failures, id, FailureTerminal::Cancelled);
            }
        }
        let sessions = {
            let mut state = self.requests.lock().expect("open request state poisoned");
            for reservation in state.pending.values_mut() {
                if reservation.owner == *owner {
                    reservation.valid = false;
                }
            }
            let ids: Vec<_> = state
                .live
                .iter()
                .filter(|(_, request)| request.owner == *owner)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| {
                    let request = state.live.remove(&id)?;
                    insert_terminal(&mut state, id, Terminal::Cancelled);
                    Some((
                        request.response.session_id,
                        request.response.document_generation,
                    ))
                })
                .collect::<Vec<_>>()
        };
        drop(_ingress);
        for (id, generation) in sessions {
            let _ = self.drain(owner, &id, generation);
        }
        self.reap_deferred();
    }

    fn finish(
        &self,
        window_label: &str,
        request_id: OpenRequestId,
        terminal: Terminal,
        drain: bool,
    ) -> Result<(), OpenRequestError> {
        let _ingress = self.ingress.lock().expect("open ingress order poisoned");
        let owner = self
            .workspace
            .active_owner(window_label)
            .ok_or(OpenRequestError::OwnerMismatch)?;
        let request = {
            let mut state = self.requests.lock().expect("open request state poisoned");
            if !state.live.contains_key(&request_id) {
                let outcome = terminal_result(&state, &request_id, terminal);
                let retry = terminal == Terminal::Rejected && outcome.is_ok();
                drop(state);
                drop(_ingress);
                if terminal == Terminal::Rejected
                    && (retry || self.has_deferred_request(&request_id))
                {
                    return self.retry_rejected(&owner, &request_id);
                }
                return outcome;
            }
            match state.live.get(&request_id) {
                Some(request) if request.owner != owner => {
                    return Err(OpenRequestError::OwnerMismatch)
                }
                Some(request) if !request.claimed && terminal == Terminal::Acknowledged => {
                    return Err(OpenRequestError::NotClaimed)
                }
                Some(_) => {}
                None => unreachable!("request existence checked above"),
            }
            if drain {
                let response = &state
                    .live
                    .get(&request_id)
                    .expect("validated request missing")
                    .response;
                // A duplicate reject must observe in-progress cleanup, never an early terminal success.
                self.remember_deferred(
                    &owner,
                    &response.session_id,
                    response.document_generation,
                    Some(&request_id),
                )?;
            }
            let request = state
                .live
                .remove(&request_id)
                .expect("request checked present");
            insert_terminal(&mut state, request_id.clone(), terminal);
            request
        };
        drop(_ingress);
        if drain {
            self.drain_for_request(
                &owner,
                &request.response.session_id,
                request.response.document_generation,
                Some(&request_id),
            )
        } else {
            Ok(())
        }
    }

    fn retry_rejected(
        &self,
        owner: &PdfOwner,
        request_id: &OpenRequestId,
    ) -> Result<(), OpenRequestError> {
        self.reap_deferred_for_owner(owner);
        let deferred = self
            .deferred
            .lock()
            .expect("open request deferred cleanup poisoned")
            .iter()
            .find_map(|(id, cleanup)| {
                (cleanup.request_id.as_ref() == Some(request_id))
                    .then(|| (id.clone(), cleanup.owner.clone(), cleanup.generation))
            });
        let Some((id, cleanup_owner, generation)) = deferred else {
            let requests = self.requests.lock().expect("open request state poisoned");
            return terminal_result(&requests, request_id, Terminal::Rejected);
        };
        if cleanup_owner != *owner {
            return Err(OpenRequestError::OwnerMismatch);
        }
        self.drain_for_request(owner, &id, generation, Some(request_id))
    }

    fn drain(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<(), OpenRequestError> {
        self.drain_for_request(owner, id, generation, None)
    }

    fn drain_for_request(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        request_id: Option<&OpenRequestId>,
    ) -> Result<(), OpenRequestError> {
        match self.sessions.cancel(owner, id, generation) {
            Ok(barrier) => match self
                .sessions
                .close(owner, id, generation, barrier.barrier_id)
            {
                Ok(()) => self.release_workspace_session(owner, id, generation, request_id),
                Err(PdfSessionError::SessionNotFound) => {
                    self.settle_missing(owner, id, generation, request_id)
                }
                Err(error) => self.unresolved_cleanup(owner, id, generation, request_id, error),
            },
            Err(PdfSessionError::SessionNotFound) => {
                self.settle_missing(owner, id, generation, request_id)
            }
            Err(PdfSessionError::ExternalLinkDrainTimeout) => {
                let error = match self
                    .sessions
                    .defer_command_cancellation(owner, id, generation)
                {
                    Ok(()) => PdfSessionError::ExternalLinkDrainTimeout,
                    Err(error) => error,
                };
                self.unresolved_cleanup(owner, id, generation, request_id, error)
            }
            Err(error) => self.unresolved_cleanup(owner, id, generation, request_id, error),
        }
    }

    fn settle_missing(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        request_id: Option<&OpenRequestId>,
    ) -> Result<(), OpenRequestError> {
        match self
            .sessions
            .reap_deferred_cancellation(owner, id, generation)
        {
            Ok(true) => self.release_workspace_session(owner, id, generation, request_id),
            Ok(false) => self.unresolved_cleanup(
                owner,
                id,
                generation,
                request_id,
                PdfSessionError::SessionNotFound,
            ),
            Err(error) => self.unresolved_cleanup(owner, id, generation, request_id, error),
        }
    }

    fn release_workspace_session(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        request_id: Option<&OpenRequestId>,
    ) -> Result<(), OpenRequestError> {
        match self.workspace.release_session(owner, id) {
            Ok(()) => {
                self.deferred
                    .lock()
                    .expect("open request deferred cleanup poisoned")
                    .remove(id);
                Ok(())
            }
            Err(error) => {
                let result = workspace_error(error);
                if let Some(request_id) = request_id {
                    self.remember_deferred(owner, id, generation, Some(request_id))?;
                }
                Err(result)
            }
        }
    }

    fn unresolved_cleanup(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        request_id: Option<&OpenRequestId>,
        error: PdfSessionError,
    ) -> Result<(), OpenRequestError> {
        self.remember_deferred(owner, id, generation, request_id)?;
        self.reap_deferred();
        if self.has_deferred_session(id) {
            Err(OpenRequestError::Session(error))
        } else {
            Ok(())
        }
    }

    fn remember_deferred(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        request_id: Option<&OpenRequestId>,
    ) -> Result<(), OpenRequestError> {
        let mut deferred = self
            .deferred
            .lock()
            .expect("open request deferred cleanup poisoned");
        if let Some(existing) = deferred.get_mut(id) {
            if existing.owner != *owner || existing.generation != generation {
                return Err(OpenRequestError::OwnerMismatch);
            }
            if request_id.is_some() {
                existing.request_id = request_id.cloned();
            }
            return Ok(());
        }
        if deferred.len() >= MAX_OPEN_REQUEST_TOMBSTONES {
            return Err(OpenRequestError::Capacity);
        }
        deferred.insert(
            id.clone(),
            DeferredCleanup {
                owner: owner.clone(),
                generation,
                request_id: request_id.cloned(),
            },
        );
        Ok(())
    }

    fn has_deferred_session(&self, id: &SessionId) -> bool {
        self.deferred
            .lock()
            .expect("open request deferred cleanup poisoned")
            .contains_key(id)
    }
    fn has_deferred_request(&self, request_id: &OpenRequestId) -> bool {
        self.deferred
            .lock()
            .expect("open request deferred cleanup poisoned")
            .values()
            .any(|cleanup| cleanup.request_id.as_ref() == Some(request_id))
    }

    fn reap_deferred(&self) {
        self.reap_deferred_matching(|_| true);
    }

    fn reap_deferred_for_owner(&self, owner: &PdfOwner) {
        self.reap_deferred_matching(|cleanup| cleanup.owner == *owner);
    }

    fn reap_deferred_matching(&self, matches: impl Fn(&DeferredCleanup) -> bool) {
        let deferred: Vec<_> = self
            .deferred
            .lock()
            .expect("open request deferred cleanup poisoned")
            .iter()
            .filter(|(_, cleanup)| matches(cleanup))
            .map(|(id, cleanup)| (id.clone(), cleanup.owner.clone(), cleanup.generation))
            .collect();
        for (id, owner, generation) in deferred {
            if self
                .sessions
                .reap_deferred_cancellation(&owner, &id, generation)
                .unwrap_or(false)
                && self.workspace.release_session(&owner, &id).is_ok()
            {
                self.deferred
                    .lock()
                    .expect("open request deferred cleanup poisoned")
                    .remove(&id);
            }
        }
    }
}
fn insert_terminal(state: &mut Requests, id: OpenRequestId, terminal: Terminal) {
    state.terminal.insert(id.clone(), terminal);
    state.terminal_order.push_back(id);
    while state.terminal_order.len() > MAX_OPEN_REQUEST_TOMBSTONES {
        if let Some(oldest) = state.terminal_order.pop_front() {
            state.terminal.remove(&oldest);
        }
    }
}

fn terminal_error(
    state: &Requests,
    id: &OpenRequestId,
) -> Result<ClaimedOpenRequest, OpenRequestError> {
    Err(match state.terminal.get(id) {
        Some(Terminal::Cancelled) => OpenRequestError::Cancelled,
        Some(Terminal::Rejected) => OpenRequestError::Rejected,
        _ => OpenRequestError::NotFound,
    })
}

fn terminal_result(
    state: &Requests,
    id: &OpenRequestId,
    expected: Terminal,
) -> Result<(), OpenRequestError> {
    match state.terminal.get(id) {
        Some(actual) if *actual == expected => Ok(()),
        Some(Terminal::Cancelled) => Err(OpenRequestError::Cancelled),
        Some(Terminal::Rejected) => Err(OpenRequestError::Rejected),
        _ => Err(OpenRequestError::NotFound),
    }
}
fn failure_tag(error: OpenRequestError) -> Result<OpenFailureTag, OpenRequestError> {
    Ok(match error {
        OpenRequestError::Capacity
        | OpenRequestError::Session(PdfSessionError::SessionCapacity) => {
            OpenFailureTag::SessionCapacity
        }
        OpenRequestError::Session(PdfSessionError::MissingFile) => OpenFailureTag::MissingFile,
        OpenRequestError::Session(PdfSessionError::FileUnreadable) => {
            OpenFailureTag::FileUnreadable
        }
        OpenRequestError::Session(PdfSessionError::PdfInvalid) => OpenFailureTag::PdfInvalid,
        OpenRequestError::Session(PdfSessionError::DocumentTooLarge) => {
            OpenFailureTag::DocumentTooLarge
        }
        // Route provenance is not trustworthy enough to expose. All rejected, dialog, and
        // otherwise unclassifiable ingress failures use the one approved opaque tag.
        _ => OpenFailureTag::PathRejected,
    })
}
fn insert_failure_terminal(state: &mut Failures, id: OpenFailureId, terminal: FailureTerminal) {
    state.terminal.insert(id.clone(), terminal);
    state.terminal_order.push_back(id);
    while state.terminal_order.len() > MAX_OPEN_FAILURE_TOMBSTONES {
        if let Some(oldest) = state.terminal_order.pop_front() {
            state.terminal.remove(&oldest);
        }
    }
}
fn failure_terminal_result(state: &Failures, id: &OpenFailureId) -> Result<(), OpenRequestError> {
    match state.terminal.get(id) {
        Some(FailureTerminal::Acknowledged) => Ok(()),
        Some(FailureTerminal::Cancelled) => Err(OpenRequestError::Cancelled),
        None => Err(OpenRequestError::NotFound),
    }
}
fn workspace_error(error: WorkspaceError) -> OpenRequestError {
    match error {
        WorkspaceError::SessionCapacity | WorkspaceError::WindowCapacity => {
            OpenRequestError::Session(PdfSessionError::SessionCapacity)
        }
        _ => OpenRequestError::OwnerMismatch,
    }
}
fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy())
        .filter(|name| !name.is_empty())
        .map(|name| {
            name.chars()
                .map(|c| {
                    if c.is_control() || c == '/' || c == '\\' {
                        '\u{FFFD}'
                    } else {
                        c
                    }
                })
                .collect()
        })
        .unwrap_or_else(|| "document.pdf".into())
}

/// Resolves second-instance arguments as native path values without string splitting or reparsing.
/// The first argv value is the executable path and is deliberately not returned.
pub fn resolve_second_instance_paths<I>(argv: I, sender_cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = OsString>,
{
    argv.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                sender_cwd.join(path)
            }
        })
        .collect()
}

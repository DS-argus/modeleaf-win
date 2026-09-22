use super::{PdfOwner, PdfSessionError, SessionId};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::ops::Range;
use std::sync::Mutex;

/// Additional logical-response assembly budget, independent of the retained document size cap.
pub(crate) const MAX_ASSEMBLY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CLOSED_DOCUMENTS: usize = 64;
const MAX_RELEASED_LEASES: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PdfAssemblyReleaseProof {
    Unallocated,
    Discarded,
    Transferred,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAssemblyLease {
    pub lease_id: u64,
    pub byte_length: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAssemblyStats {
    pub current_bytes: u64,
    pub peak_bytes: u64,
    pub active_leases: usize,
    pub pending_requests: usize,
    pub documents: usize,
}

pub(crate) type AssemblyCallback =
    Box<dyn FnOnce(Result<PdfAssemblyLease, PdfSessionError>) + Send + 'static>;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct DocumentKey {
    id: SessionId,
    generation: u64,
}

struct ActiveLease {
    lease: PdfAssemblyLease,
}

struct WaitingRequest {
    sequence: u64,
    range: Range<u64>,
    callback: AssemblyCallback,
}

struct DocumentState {
    owner: PdfOwner,
    cancel_through: u64,
    active: Option<ActiveLease>,
    waiting: Option<WaitingRequest>,
    finished: bool,
    released: VecDeque<u64>,
}

pub(crate) enum AssemblyCompletion {
    Callback {
        callback: AssemblyCallback,
        result: Result<PdfAssemblyLease, PdfSessionError>,
    },
}

pub(crate) struct PdfAssemblyLedger {
    state: Mutex<AssemblyState>,
}

struct AssemblyState {
    documents: HashMap<DocumentKey, DocumentState>,
    pending: VecDeque<DocumentKey>,
    closed_order: VecDeque<DocumentKey>,
    current_bytes: u64,
    peak_bytes: u64,
    next_lease_id: u64,
}

impl PdfAssemblyLedger {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(AssemblyState {
                documents: HashMap::new(),
                pending: VecDeque::new(),
                closed_order: VecDeque::new(),
                current_bytes: 0,
                peak_bytes: 0,
                next_lease_id: 1,
            }),
        }
    }

    fn key(id: &SessionId, generation: u64) -> DocumentKey {
        DocumentKey {
            id: id.clone(),
            generation,
        }
    }

    fn new_document(owner: PdfOwner) -> DocumentState {
        DocumentState {
            owner,
            cancel_through: 0,
            active: None,
            waiting: None,
            finished: false,
            released: VecDeque::new(),
        }
    }

    fn reject(callback: AssemblyCallback, error: PdfSessionError) -> Vec<AssemblyCompletion> {
        vec![AssemblyCompletion::Callback {
            callback,
            result: Err(error),
        }]
    }

    fn next_lease(
        state: &mut AssemblyState,
        byte_length: u64,
    ) -> Result<PdfAssemblyLease, PdfSessionError> {
        let lease_id = state.next_lease_id;
        if lease_id > MAX_SAFE_JS_INTEGER {
            return Err(PdfSessionError::SessionCapacity);
        }
        state.next_lease_id = lease_id
            .checked_add(1)
            .ok_or(PdfSessionError::SessionCapacity)?;
        Ok(PdfAssemblyLease {
            lease_id,
            byte_length,
        })
    }

    fn record_release(document: &mut DocumentState, lease_id: u64) {
        if document.released.contains(&lease_id) {
            return;
        }
        document.released.push_back(lease_id);
        while document.released.len() > MAX_RELEASED_LEASES {
            document.released.pop_front();
        }
    }

    fn mark_closed(state: &mut AssemblyState, key: &DocumentKey) {
        if !state.closed_order.iter().any(|candidate| candidate == key) {
            state.closed_order.push_back(key.clone());
        }
    }

    fn prune_closed(state: &mut AssemblyState) {
        while state.closed_order.len() > MAX_CLOSED_DOCUMENTS {
            let Some(key) = state.closed_order.pop_front() else {
                break;
            };
            let removable = state.documents.get(&key).is_some_and(|document| {
                document.finished && document.active.is_none() && document.waiting.is_none()
            });
            if removable {
                state.documents.remove(&key);
            }
        }
    }

    fn grant(
        state: &mut AssemblyState,
        document: &mut DocumentState,
        sequence: u64,
        range: Range<u64>,
        callback: AssemblyCallback,
    ) -> Vec<AssemblyCompletion> {
        let byte_length = range.end - range.start;
        let lease = match Self::next_lease(state, byte_length) {
            Ok(lease) => lease,
            Err(error) => return Self::reject(callback, error),
        };
        document.active = Some(ActiveLease {
            lease: lease.clone(),
        });
        let _ = sequence;
        state.current_bytes += byte_length;
        state.peak_bytes = state.peak_bytes.max(state.current_bytes);
        vec![AssemblyCompletion::Callback {
            callback,
            result: Ok(lease),
        }]
    }

    pub(crate) fn request(
        &self,
        owner: PdfOwner,
        id: &SessionId,
        generation: u64,
        sequence: u64,
        range: Range<u64>,
        callback: AssemblyCallback,
    ) -> (Vec<AssemblyCompletion>, bool) {
        let mut state = self.state.lock().expect("assembly ledger poisoned");
        if range.start > range.end {
            return (Self::reject(callback, PdfSessionError::RangeInvalid), false);
        }
        let byte_length = range.end - range.start;
        if byte_length > MAX_ASSEMBLY_BYTES {
            return (
                Self::reject(callback, PdfSessionError::DocumentTooLarge),
                false,
            );
        }
        let key = Self::key(id, generation);
        let mut document = state
            .documents
            .remove(&key)
            .unwrap_or_else(|| Self::new_document(owner.clone()));
        if document.owner != owner {
            state.documents.insert(key, document);
            return (
                Self::reject(callback, PdfSessionError::OwnerMismatch),
                false,
            );
        }
        if document.finished || sequence == 0 || sequence <= document.cancel_through {
            state.documents.insert(key, document);
            return (
                Self::reject(callback, PdfSessionError::SessionClosing),
                false,
            );
        }
        if document.waiting.is_some() {
            state.documents.insert(key, document);
            return (
                Self::reject(callback, PdfSessionError::RangeCapacity),
                false,
            );
        }
        let can_grant_now = document.active.is_none()
            && state.pending.is_empty()
            && state
                .current_bytes
                .checked_add(byte_length)
                .is_some_and(|total| total <= MAX_ASSEMBLY_BYTES);
        if can_grant_now {
            let completions = Self::grant(&mut state, &mut document, sequence, range, callback);
            let accepted = document.active.is_some();
            state.documents.insert(key, document);
            Self::prune_closed(&mut state);
            return (completions, accepted);
        }
        document.waiting = Some(WaitingRequest {
            sequence,
            range,
            callback,
        });
        state.pending.push_back(key.clone());
        state.documents.insert(key, document);
        (Vec::new(), true)
    }

    fn remove_pending_key(state: &mut AssemblyState, key: &DocumentKey) {
        if let Some(position) = state.pending.iter().position(|candidate| candidate == key) {
            state.pending.remove(position);
        }
    }

    /// Strict FIFO across documents: the first pending document is never bypassed. This
    /// gives deterministic fairness and avoids an active-document rotation loop.
    fn pump(state: &mut AssemblyState) -> Vec<AssemblyCompletion> {
        let mut completions = Vec::new();
        while let Some(key) = state.pending.front().cloned() {
            let Some(document) = state.documents.get(&key) else {
                state.pending.pop_front();
                continue;
            };
            let Some(waiting) = document.waiting.as_ref() else {
                state.pending.pop_front();
                continue;
            };
            if document.finished || document.active.is_some() {
                break;
            }
            let byte_length = waiting.range.end - waiting.range.start;
            let Some(total) = state.current_bytes.checked_add(byte_length) else {
                break;
            };
            if total > MAX_ASSEMBLY_BYTES {
                break;
            }
            let key = state.pending.pop_front().expect("pending assembly missing");
            let mut document = state.documents.remove(&key).expect("document missing");
            let waiting = document.waiting.take().expect("waiting assembly missing");
            completions.extend(Self::grant(
                state,
                &mut document,
                waiting.sequence,
                waiting.range,
                waiting.callback,
            ));
            state.documents.insert(key, document);
        }
        completions
    }
    pub(crate) fn cancel(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        sequence: u64,
    ) -> Result<Vec<AssemblyCompletion>, PdfSessionError> {
        let mut state = self.state.lock().expect("assembly ledger poisoned");
        let key = Self::key(id, generation);
        let mut document = state
            .documents
            .remove(&key)
            .unwrap_or_else(|| Self::new_document(owner.clone()));
        if document.owner != *owner {
            state.documents.insert(key, document);
            return Err(PdfSessionError::OwnerMismatch);
        }
        document.cancel_through = document.cancel_through.max(sequence);
        let waiting = document
            .waiting
            .as_ref()
            .is_some_and(|request| request.sequence <= sequence);
        let completion =
            waiting.then(|| document.waiting.take().expect("waiting assembly missing"));
        if completion.is_some() {
            Self::remove_pending_key(&mut state, &key);
        }
        if sequence == u64::MAX && document.active.is_none() && document.waiting.is_none() {
            document.finished = true;
            Self::mark_closed(&mut state, &key);
        }
        state.documents.insert(key, document);
        Self::prune_closed(&mut state);
        Ok(completion
            .into_iter()
            .map(|waiting| AssemblyCompletion::Callback {
                callback: waiting.callback,
                result: Err(PdfSessionError::SessionClosing),
            })
            .collect())
    }
    pub(crate) fn release(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
        lease_id: u64,
        _proof: PdfAssemblyReleaseProof,
    ) -> Result<Vec<AssemblyCompletion>, PdfSessionError> {
        let mut state = self.state.lock().expect("assembly ledger poisoned");
        let key = Self::key(id, generation);
        let mut document = state
            .documents
            .remove(&key)
            .ok_or(PdfSessionError::SessionNotFound)?;
        if document.owner != *owner {
            state.documents.insert(key, document);
            return Err(PdfSessionError::OwnerMismatch);
        }
        let Some(active) = document.active.take() else {
            let result = if document.released.contains(&lease_id) {
                Ok(Vec::new())
            } else {
                Err(PdfSessionError::SessionNotFound)
            };
            state.documents.insert(key, document);
            return result;
        };
        if active.lease.lease_id != lease_id {
            document.active = Some(active);
            state.documents.insert(key, document);
            return Err(PdfSessionError::SessionNotFound);
        }
        Self::record_release(&mut document, lease_id);
        state.current_bytes = state
            .current_bytes
            .checked_sub(active.lease.byte_length)
            .expect("assembly credit underflow");
        if document.cancel_through == u64::MAX && document.waiting.is_none() {
            document.finished = true;
            Self::mark_closed(&mut state, &key);
        }
        state.documents.insert(key, document);
        Self::prune_closed(&mut state);
        Ok(Self::pump(&mut state))
    }
    pub(crate) fn finish(
        &self,
        owner: &PdfOwner,
        id: &SessionId,
        generation: u64,
    ) -> Result<Vec<AssemblyCompletion>, PdfSessionError> {
        let mut state = self.state.lock().expect("assembly ledger poisoned");
        let key = Self::key(id, generation);
        let mut document = state
            .documents
            .remove(&key)
            .unwrap_or_else(|| Self::new_document(owner.clone()));
        if document.owner != *owner {
            state.documents.insert(key, document);
            return Err(PdfSessionError::OwnerMismatch);
        }
        if document.finished {
            state.documents.insert(key, document);
            return Ok(Vec::new());
        }
        document.finished = true;
        Self::remove_pending_key(&mut state, &key);
        let mut completions = Vec::new();
        if let Some(active) = document.active.take() {
            Self::record_release(&mut document, active.lease.lease_id);
            state.current_bytes = state
                .current_bytes
                .checked_sub(active.lease.byte_length)
                .expect("assembly credit underflow");
        }
        if let Some(waiting) = document.waiting.take() {
            completions.push(AssemblyCompletion::Callback {
                callback: waiting.callback,
                result: Err(PdfSessionError::SessionClosing),
            });
        }
        state.documents.insert(key.clone(), document);
        Self::mark_closed(&mut state, &key);
        completions.extend(Self::pump(&mut state));
        Self::prune_closed(&mut state);
        Ok(completions)
    }

    pub(crate) fn discard_owner(&self, owner: &PdfOwner) -> Vec<AssemblyCompletion> {
        let mut state = self.state.lock().expect("assembly ledger poisoned");
        let keys = state
            .documents
            .iter()
            .filter_map(|(key, document)| (&document.owner == owner).then_some(key.clone()))
            .collect::<Vec<_>>();
        let mut completions = Vec::new();
        for key in keys {
            Self::remove_pending_key(&mut state, &key);
            let Some(mut document) = state.documents.remove(&key) else {
                continue;
            };
            document.finished = true;
            if let Some(active) = document.active.take() {
                Self::record_release(&mut document, active.lease.lease_id);
                state.current_bytes = state
                    .current_bytes
                    .checked_sub(active.lease.byte_length)
                    .expect("assembly credit underflow");
            }
            if let Some(waiting) = document.waiting.take() {
                completions.push(AssemblyCompletion::Callback {
                    callback: waiting.callback,
                    result: Err(PdfSessionError::SessionClosing),
                });
            }
            state.documents.insert(key.clone(), document);
            Self::mark_closed(&mut state, &key);
        }
        completions.extend(Self::pump(&mut state));
        Self::prune_closed(&mut state);
        completions
    }

    pub(crate) fn owner_is_empty(&self, owner: &PdfOwner) -> bool {
        let state = self.state.lock().expect("assembly ledger poisoned");
        !state.documents.values().any(|document| {
            &document.owner == owner && (document.active.is_some() || document.waiting.is_some())
        })
    }

    pub(crate) fn work_count(&self, id: &SessionId, generation: u64) -> usize {
        let state = self.state.lock().expect("assembly ledger poisoned");
        state
            .documents
            .get(&Self::key(id, generation))
            .map_or(0, |document| {
                (document.active.is_some() as usize) + (document.waiting.is_some() as usize)
            })
    }

    pub(crate) fn is_empty(&self) -> bool {
        let state = self.state.lock().expect("assembly ledger poisoned");
        state
            .documents
            .values()
            .all(|document| document.active.is_none() && document.waiting.is_none())
            && state.current_bytes == 0
    }

    pub(crate) fn stats(&self) -> PdfAssemblyStats {
        let state = self.state.lock().expect("assembly ledger poisoned");
        PdfAssemblyStats {
            current_bytes: state.current_bytes,
            peak_bytes: state.peak_bytes,
            active_leases: state
                .documents
                .values()
                .filter(|document| document.active.is_some())
                .count(),
            pending_requests: state
                .documents
                .values()
                .filter(|document| document.waiting.is_some())
                .count(),
            documents: state
                .documents
                .values()
                .filter(|document| document.active.is_some() || document.waiting.is_some())
                .count(),
        }
    }
}

pub(crate) fn run_completions(completions: Vec<AssemblyCompletion>) {
    for AssemblyCompletion::Callback { callback, result } in completions {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(result)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn owner(generation: u64) -> PdfOwner {
        PdfOwner {
            window_label: format!("window-{generation}"),
            generation,
        }
    }

    fn id(value: char) -> SessionId {
        SessionId(value.to_string().repeat(64))
    }

    fn callback(
        sender: mpsc::Sender<Result<PdfAssemblyLease, PdfSessionError>>,
    ) -> AssemblyCallback {
        Box::new(move |result| {
            sender.send(result).unwrap();
        })
    }

    #[test]
    fn cancel_before_first_request_fences_late_grant() {
        let ledger = PdfAssemblyLedger::new();
        let owner = owner(1);
        let id = id('a');
        ledger.cancel(&owner, &id, 1, 7).unwrap();
        let (sender, receiver) = mpsc::channel();
        let (completions, admitted) = ledger.request(owner, &id, 1, 7, 0..4, callback(sender));
        assert!(!admitted);
        run_completions(completions);
        assert_eq!(
            receiver.recv().unwrap(),
            Err(PdfSessionError::SessionClosing)
        );
    }

    #[test]
    fn budget_is_process_wide_and_peak_is_monotonic() {
        let ledger = PdfAssemblyLedger::new();
        let first_owner = owner(1);
        let second_owner = owner(2);
        let first_id = id('a');
        let second_id = id('b');
        let first_length = MAX_ASSEMBLY_BYTES;
        let (first_sender, first_receiver) = mpsc::channel();
        let (completions, admitted) = ledger.request(
            first_owner.clone(),
            &first_id,
            1,
            1,
            0..first_length,
            callback(first_sender),
        );
        assert!(admitted);
        run_completions(completions);
        let first_lease = first_receiver.recv().unwrap().unwrap();
        let (second_sender, second_receiver) = mpsc::channel();
        let (completions, admitted) = ledger.request(
            second_owner.clone(),
            &second_id,
            2,
            1,
            0..1,
            callback(second_sender),
        );
        assert!(admitted);
        assert!(completions.is_empty());
        assert!(second_receiver.try_recv().is_err());
        let completions = ledger
            .release(
                &first_owner,
                &first_id,
                1,
                first_lease.lease_id,
                PdfAssemblyReleaseProof::Discarded,
            )
            .unwrap();
        run_completions(completions);
        assert!(second_receiver.recv().unwrap().is_ok());
        assert_eq!(ledger.stats().peak_bytes, MAX_ASSEMBLY_BYTES);
    }

    #[test]
    fn strict_fifo_has_one_active_document_and_preserves_wrong_release() {
        let ledger = PdfAssemblyLedger::new();
        let first_owner = owner(1);
        let second_owner = owner(2);
        let first_id = id('a');
        let second_id = id('b');
        let (sender, receiver) = mpsc::channel();
        let (completions, _) = ledger.request(
            first_owner.clone(),
            &first_id,
            1,
            1,
            0..MAX_ASSEMBLY_BYTES,
            callback(sender),
        );
        run_completions(completions);
        let first_lease = receiver.recv().unwrap().unwrap();
        let (second_sender, second_receiver) = mpsc::channel();
        let (completions, _) = ledger.request(
            second_owner.clone(),
            &second_id,
            2,
            1,
            0..1,
            callback(second_sender),
        );
        assert!(second_receiver.try_recv().is_err());
        assert!(completions.is_empty());
        match ledger.release(
            &first_owner,
            &first_id,
            1,
            first_lease.lease_id + 1,
            PdfAssemblyReleaseProof::Discarded,
        ) {
            Err(error) => assert_eq!(error, PdfSessionError::SessionNotFound),
            Ok(_) => panic!("wrong lease released active credit"),
        }
        let completions = ledger
            .release(
                &first_owner,
                &first_id,
                1,
                first_lease.lease_id,
                PdfAssemblyReleaseProof::Transferred,
            )
            .unwrap();
        run_completions(completions);
        assert!(second_receiver.recv().unwrap().is_ok());
    }

    #[test]
    fn cancel_pending_fences_late_grant_and_destroy_discards_owner() {
        let ledger = PdfAssemblyLedger::new();
        let first_owner = owner(1);
        let second_owner = owner(2);
        let first_id = id('a');
        let second_id = id('b');
        let (first_sender, first_receiver) = mpsc::channel();
        let (completions, _) = ledger.request(
            first_owner.clone(),
            &first_id,
            1,
            1,
            0..MAX_ASSEMBLY_BYTES,
            callback(first_sender),
        );
        run_completions(completions);
        let first_lease = first_receiver.recv().unwrap().unwrap();
        let (waiting_sender, waiting_receiver) = mpsc::channel();
        let (completions, _) = ledger.request(
            first_owner.clone(),
            &first_id,
            1,
            2,
            MAX_ASSEMBLY_BYTES..MAX_ASSEMBLY_BYTES,
            callback(waiting_sender),
        );
        assert!(completions.is_empty());
        let completions = ledger.cancel(&first_owner, &first_id, 1, 2).unwrap();
        run_completions(completions);
        assert_eq!(
            waiting_receiver.recv().unwrap(),
            Err(PdfSessionError::SessionClosing)
        );
        let (second_sender, second_receiver) = mpsc::channel();
        let (completions, _) = ledger.request(
            second_owner.clone(),
            &second_id,
            2,
            1,
            0..1,
            callback(second_sender),
        );
        assert!(completions.is_empty());
        let completions = ledger
            .release(
                &first_owner,
                &first_id,
                1,
                first_lease.lease_id,
                PdfAssemblyReleaseProof::Discarded,
            )
            .unwrap();
        run_completions(completions);
        assert!(second_receiver.recv().unwrap().is_ok());
        let _ = ledger.discard_owner(&second_owner);
        assert_eq!(ledger.stats().current_bytes, 0);
    }

    #[test]
    fn finish_is_idempotent_and_release_is_lost_ack_safe() {
        let ledger = PdfAssemblyLedger::new();
        let owner = owner(1);
        let id = id('a');
        let (sender, receiver) = mpsc::channel();
        let (completions, _) = ledger.request(owner.clone(), &id, 1, 1, 0..8, callback(sender));
        run_completions(completions);
        let lease = receiver.recv().unwrap().unwrap();
        run_completions(ledger.finish(&owner, &id, 1).unwrap());
        assert!(ledger.finish(&owner, &id, 1).unwrap().is_empty());
        assert!(ledger
            .release(
                &owner,
                &id,
                1,
                lease.lease_id,
                PdfAssemblyReleaseProof::Discarded,
            )
            .unwrap()
            .is_empty());
        assert!(ledger.is_empty());
    }
}

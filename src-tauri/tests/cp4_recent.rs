use modeleaf_lib::local_path::{DriveKind, LocalPathPolicy, PathPolicyError};
use modeleaf_lib::open_request::OpenRequestCoordinator;
use modeleaf_lib::pdf_session::{PdfOwner, PdfSessionError, PdfSessionManager};
use modeleaf_lib::recent::{RecentStore, RecentStoreError, MAX_RECENT_DOCUMENTS};
use modeleaf_lib::workspace::WorkspaceManager;
use std::fs;
use std::path::{Path, PathBuf};

struct Policy(DriveKind);
impl LocalPathPolicy for Policy {
    fn classify(&self, path: &Path) -> Result<DriveKind, PathPolicyError> {
        if path.to_string_lossy().starts_with(r"\\?\") {
            return Err(PathPolicyError::PathRejected);
        }
        Ok(self.0)
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("modeleaf-cp4-{label}-{}", rand::random::<u64>()));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn pdf(directory: &Path, index: usize) -> PathBuf {
    let path = directory.join(format!("document-{index}.PDF"));
    fs::write(&path, b"%PDF-1.7\n").unwrap();
    path
}

#[test]
fn cap_deduplicates_canonical_paths_and_reopen_bumps_order() {
    let directory = temp_dir("cap");
    let state = directory.join("recent.json");
    let policy = Policy(DriveKind::Fixed);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    let first = pdf(&directory, 0);
    let first_id = store
        .debug_record_opened(&first, &policy)
        .unwrap()
        .recent_id()
        .to_owned();
    for index in 1..=MAX_RECENT_DOCUMENTS {
        store
            .debug_record_opened(&pdf(&directory, index), &policy)
            .unwrap();
    }
    assert_eq!(store.documents().len(), MAX_RECENT_DOCUMENTS);
    assert!(!store
        .documents()
        .iter()
        .any(|item| item.recent_id() == first_id));

    let retained = pdf(&directory, MAX_RECENT_DOCUMENTS);
    let retained_id = store
        .debug_record_opened(&retained, &policy)
        .unwrap()
        .recent_id()
        .to_owned();
    let documents = store.documents();
    assert_eq!(documents.len(), MAX_RECENT_DOCUMENTS);
    assert_eq!(documents[0].recent_id(), retained_id);
    assert_eq!(
        documents
            .iter()
            .filter(|item| item.recent_id() == retained_id)
            .count(),
        1
    );
    assert_eq!(documents[0].display_name(), "document-15.PDF");

    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn renderer_documents_have_no_path_and_native_resolution_remains_private() {
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    let directory = temp_dir("dto");
    let state = directory.join("recent.json");
    let policy = Policy(DriveKind::Fixed);
    let path = pdf(&directory, 1);
    let canonical = fs::canonicalize(&path).unwrap();
    let mut store = RecentStore::load(&state, &policy).unwrap();
    let document = store.debug_record_opened(&path, &policy).unwrap();
    store.save().unwrap();

    let recent_id = document.recent_id().to_owned();
    let document_debug = format!("{document:?}");
    let serialized = match document.body().unwrap() {
        InvokeResponseBody::Json(json) => json,
        InvokeResponseBody::Raw(_) => {
            panic!("recent document must use the JSON IPC response shape")
        }
    };
    assert_eq!(
        serialized,
        format!(
            r#"{{"recentId":"{}","displayName":"document-1.PDF"}}"#,
            recent_id
        )
    );
    assert!(!serialized.contains("lastOpenedOrdinal"));

    let serialized_state = fs::read_to_string(&state).unwrap();
    assert!(!serialized_state.contains(r"\\?\"));
    assert!(!document_debug.contains(&canonical.to_string_lossy().to_string()));
    let resolved = store.resolve_for_open(&recent_id, &policy).unwrap();
    assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
    assert_eq!(resolved.file_name(), canonical.file_name());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn corrupt_wrong_schema_and_same_handle_oversize_state_use_one_fixed_quarantine() {
    let directory = temp_dir("quarantine");
    let state = directory.join("recent.json");
    let quarantine = directory.join("recent.quarantine.json");
    let policy = Policy(DriveKind::Fixed);

    fs::write(&state, "{not-json").unwrap();
    let store = RecentStore::load(&state, &policy).unwrap();
    assert!(store.documents().is_empty());
    assert_eq!(fs::read_to_string(&quarantine).unwrap(), "{not-json");
    assert!(!state.exists());

    fs::write(
        &state,
        r#"{"schemaVersion":99,"nextOrdinal":1,"records":[]}"#,
    )
    .unwrap();
    RecentStore::load(&state, &policy).unwrap();
    assert_eq!(
        fs::read_to_string(&quarantine).unwrap(),
        r#"{"schemaVersion":99,"nextOrdinal":1,"records":[]}"#
    );

    fs::write(&state, vec![b'x'; 64 * 1024 + 1]).unwrap();
    RecentStore::load(&state, &policy).unwrap();
    assert_eq!(fs::metadata(&quarantine).unwrap().len(), 64 * 1024 + 1);
    assert_eq!(
        fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .count(),
        1
    );
    fs::remove_dir_all(directory).unwrap();
}
#[cfg(all(debug_assertions, windows))]
#[test]
fn path_replacement_between_parse_and_quarantine_preserves_valid_replacement() {
    let directory = temp_dir("quarantine-replacement");
    let state = directory.join("recent.json");
    let retained_corrupt = directory.join("parsed-corrupt.json");
    let replacement = directory.join("replacement.json");
    let quarantine = directory.join("recent.quarantine.json");
    let valid = r#"{"schemaVersion":1,"nextOrdinal":1,"records":[]}"#;
    let policy = Policy(DriveKind::Fixed);

    fs::write(&state, "{corrupt").unwrap();
    fs::write(&replacement, valid).unwrap();
    let replacement_state = state.clone();
    let replacement_source = replacement.clone();
    let retained_corrupt_for_hook = retained_corrupt.clone();
    let mut store =
        RecentStore::load_with_post_check_before_quarantine_hook(&state, &policy, move || {
            fs::rename(&replacement_state, &retained_corrupt_for_hook).unwrap();
            fs::rename(&replacement_source, &replacement_state).unwrap();
        })
        .unwrap();

    assert!(store.documents().is_empty());
    assert!(store.take_startup_recovery_needed());
    assert_eq!(fs::read_to_string(&state).unwrap(), valid);
    assert_eq!(fs::read_to_string(&quarantine).unwrap(), "{corrupt");
    assert!(!retained_corrupt.exists());

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn maximum_size_deeply_nested_json_recovers_and_quarantines_once() {
    let policy = Policy(DriveKind::Fixed);
    let nested = [
        (
            "object",
            format!("{}0{}", "{\"x\":".repeat(33), "}".repeat(33)),
        ),
        ("array", format!("{}0{}", "[".repeat(33), "]".repeat(33))),
    ];

    for (label, mut contents) in nested {
        contents.push_str(&" ".repeat(64 * 1024 - contents.len()));
        assert_eq!(contents.len(), 64 * 1024);
        let directory = temp_dir(&format!("deep-{label}"));
        let state = directory.join("recent.json");
        let quarantine = directory.join("recent.quarantine.json");
        fs::write(&state, &contents).unwrap();

        let mut store = RecentStore::load(&state, &policy).unwrap();
        assert!(store.documents().is_empty());
        assert!(store.take_startup_recovery_needed());
        assert!(!store.take_startup_recovery_needed());
        assert_eq!(fs::read_to_string(&quarantine).unwrap(), contents);
        assert!(!state.exists());

        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn unreadable_or_unquarantinable_state_is_nonfatal_and_reports_fixed_recovery_evidence() {
    let directory = temp_dir("recovery");
    let state = directory.join("recent.json");
    let quarantine = directory.join("recent.quarantine.json");
    let policy = Policy(DriveKind::Fixed);
    fs::create_dir(&state).unwrap();
    fs::create_dir(&quarantine).unwrap();

    let mut store = RecentStore::load(&state, &policy).unwrap();
    assert!(store.documents().is_empty());
    assert!(store.take_startup_recovery_needed());
    assert!(!store.take_startup_recovery_needed());
    assert!(quarantine.is_dir());

    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn remote_paths_are_rejected_for_registration_and_resolution() {
    let directory = temp_dir("remote");
    let state = directory.join("recent.json");
    let local = Policy(DriveKind::Fixed);
    let remote = Policy(DriveKind::Remote);
    let path = pdf(&directory, 1);
    let mut store = RecentStore::load(&state, &local).unwrap();
    assert!(matches!(
        store.debug_record_opened(&path, &remote),
        Err(RecentStoreError::RemotePath)
    ));
    let document = store.debug_record_opened(&path, &local).unwrap();
    assert!(matches!(
        store.resolve_for_open(document.recent_id(), &remote),
        Err(RecentStoreError::RemotePath)
    ));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn owner_checked_committed_session_resolves_only_to_rust() {
    let directory = temp_dir("session-path");
    let path = pdf(&directory, 1);
    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "reader".into(),
        generation: 1,
    };
    let metadata = manager.open_local_file(owner.clone(), &path).unwrap();
    let wrong_owner = PdfOwner {
        window_label: "other".into(),
        generation: 1,
    };
    assert_eq!(
        manager.trusted_recent_identity(
            &wrong_owner,
            &metadata.session_id,
            metadata.document_generation,
        ),
        Err(PdfSessionError::OwnerMismatch)
    );
    let identity = manager
        .trusted_recent_identity(&owner, &metadata.session_id, metadata.document_generation)
        .unwrap();
    let mut store =
        RecentStore::load(directory.join("recent.json"), &Policy(DriveKind::Fixed)).unwrap();
    let document = store.record_trusted_opened_and_save(identity).unwrap();
    assert_eq!(
        store
            .resolve_for_open(document.recent_id(), &Policy(DriveKind::Fixed))
            .unwrap(),
        path
    );
    manager.drain_all();
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(windows)]
#[test]
fn retained_handle_identity_survives_path_swap_before_recent_recording() {
    let directory = temp_dir("retained-identity");
    let state = directory.join("recent.json");
    let original = pdf(&directory, 1);
    let retained = directory.join("retained.PDF");
    let replacement = b"%PDF-replacement";
    let owner = PdfOwner {
        window_label: "reader".into(),
        generation: 1,
    };
    let manager = PdfSessionManager::new();
    let metadata = manager.open_local_file(owner.clone(), &original).unwrap();

    assert_eq!(
        manager.trusted_recent_identity(
            &PdfOwner {
                window_label: "other".into(),
                generation: 1,
            },
            &metadata.session_id,
            metadata.document_generation,
        ),
        Err(PdfSessionError::OwnerMismatch)
    );
    assert_eq!(
        manager.trusted_recent_identity(
            &owner,
            &metadata.session_id,
            metadata.document_generation + 1
        ),
        Err(PdfSessionError::GenerationMismatch)
    );

    fs::rename(&original, &retained).unwrap();
    fs::write(&original, replacement).unwrap();
    let identity = manager
        .trusted_recent_identity(&owner, &metadata.session_id, metadata.document_generation)
        .unwrap();
    let policy = Policy(DriveKind::Fixed);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    let document = store.record_trusted_opened_and_save(identity).unwrap();
    let resolved = store
        .resolve_for_open(document.recent_id(), &policy)
        .unwrap();
    let retained_path = fs::canonicalize(&retained).unwrap();
    let retained_path = retained_path.to_string_lossy();
    let retained_path = PathBuf::from(
        retained_path
            .strip_prefix(r"\\?\")
            .unwrap_or(&retained_path),
    );
    assert_eq!(resolved, retained_path);
    assert_ne!(resolved, fs::canonicalize(&original).unwrap());
    assert_eq!(fs::read(&resolved).unwrap(), b"%PDF-1.7\n");
    assert_ne!(fs::read(&resolved).unwrap(), replacement);

    manager.drain_all();
    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn resolved_recent_reenters_the_open_request_coordinator_once() {
    let directory = temp_dir("reopen");
    let state = directory.join("recent.json");
    let policy = Policy(DriveKind::Fixed);
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-pdf")
        .join("사전규격공개 의견에 대한 답변(조달청).pdf");
    let expected_display_name = path.file_name().unwrap().to_string_lossy().to_string();
    let mut store = RecentStore::load(&state, &policy).unwrap();
    let document = store.debug_record_opened(&path, &policy).unwrap();
    let workspace = WorkspaceManager::new();
    workspace.claim_window("reader").unwrap();
    let sessions = PdfSessionManager::new();
    let coordinator = OpenRequestCoordinator::new(sessions.clone(), workspace);
    let resolved = store
        .resolve_for_open(document.recent_id(), &policy)
        .unwrap();
    let notice = coordinator.ingest_path("reader", &resolved).unwrap();
    let claimed = coordinator
        .claim("reader", notice.request_id.clone())
        .unwrap();
    assert_eq!(claimed.display_name, expected_display_name);
    coordinator
        .acknowledge("reader", notice.request_id)
        .unwrap();
    sessions.drain_all();
    fs::remove_dir_all(directory).unwrap();
}

fn persisted_state_with_path(path: &str) -> String {
    format!(
        "{{\"schemaVersion\":1,\"nextOrdinal\":2,\"records\":[{{\"recentId\":\"{}\",\"displayName\":\"document.pdf\",\"lastOpenedOrdinal\":1,\"path\":\"{}\"}}]}}",
        "0".repeat(32),
        path
    )
}

#[test]
fn save_accepts_exact_persisted_limit_and_preserves_durable_state_on_overflow() {
    let directory = temp_dir("persisted-limit");
    let state = directory.join("recent.json");
    let policy = Policy(DriveKind::Fixed);
    let path = format!(
        "{}{}",
        "a".repeat(64 * 1024 - persisted_state_with_path("/document.pdf").len()),
        "/document.pdf"
    );
    let durable = persisted_state_with_path(&path);
    assert_eq!(durable.len(), 64 * 1024);
    fs::write(&state, &durable).unwrap();

    let mut store = RecentStore::load(&state, &policy).unwrap();
    store.save().unwrap();
    assert_eq!(fs::read_to_string(&state).unwrap(), durable);

    let before = store.documents();
    assert!(matches!(
        store.debug_record_opened_and_save(&pdf(&directory, 1), &policy),
        Err(RecentStoreError::Io(_))
    ));
    assert_eq!(store.documents(), before);
    assert_eq!(fs::read_to_string(&state).unwrap(), durable);
    assert!(!directory.join("recent.quarantine.json").exists());

    let reloaded = RecentStore::load(&state, &policy).unwrap();
    assert_eq!(reloaded.documents().len(), 1);
    assert_eq!(
        reloaded.documents()[0].recent_id(),
        "00000000000000000000000000000000"
    );
    fs::remove_dir_all(directory).unwrap();
}

use modeleaf_lib::open_request::{
    OpenFailureTag, OpenRequestCoordinator, OpenRequestError, PendingIngressNotice,
    MAX_OPEN_FAILURES, MAX_OPEN_FAILURES_PER_OWNER, MAX_OPEN_FAILURE_TOMBSTONES, MAX_OPEN_REQUESTS,
};
use modeleaf_lib::pdf_session::{ExternalLinkRegistration, PdfSessionError, PdfSessionManager};
use modeleaf_lib::workspace::WorkspaceManager;
use modeleaf_lib::SecondInstanceIngress;
#[cfg(windows)]
use std::ffi::OsString;
use std::fs::File;
use std::io::Write;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
#[cfg(windows)]
#[test]
fn second_instance_arguments_use_the_sender_cwd_without_reparsing() {
    use modeleaf_lib::open_request::resolve_second_instance_paths;

    let cwd = Path::new(r"C:\sender cwd\한국어");
    let paths = resolve_second_instance_paths(
        vec![
            OsString::from(r"C:\Modeleaf\modeleaf.exe"),
            OsString::from("사전 규격.pdf"),
            OsString::from("-leading name.pdf"),
            OsString::from(r"D:\absolute\이미 열림.pdf"),
        ],
        cwd,
    );

    assert_eq!(
        paths,
        vec![
            cwd.join("사전 규격.pdf"),
            cwd.join("-leading name.pdf"),
            PathBuf::from(r"D:\absolute\이미 열림.pdf"),
        ]
    );
}

fn fixture(number: u8) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-cp4-{number}-{}.pdf",
        rand::random::<u64>()
    ));
    let mut file = File::create(&path).unwrap();
    file.write_all(b"%PDF-1.7").unwrap();
    path
}

fn coordinator() -> (OpenRequestCoordinator, WorkspaceManager, PdfSessionManager) {
    let workspace = WorkspaceManager::new();
    workspace.claim_window("reader").unwrap();
    let sessions = PdfSessionManager::new();
    (
        OpenRequestCoordinator::new(sessions.clone(), workspace.clone()),
        workspace,
        sessions,
    )
}
#[cfg(windows)]
fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
}

#[cfg(windows)]
#[test]
fn production_session_identity_and_bytes_follow_the_opened_handle_after_path_replacement() {
    let directory =
        std::env::temp_dir().join(format!("modeleaf-cp4-identity-{}", rand::random::<u64>()));
    std::fs::create_dir(&directory).unwrap();
    let retained = directory.join("retained.pdf");
    let replacement = directory.join("replacement.pdf");
    let input = directory.join("input.pdf");
    std::fs::write(&input, b"%PDF-1.7 retained").unwrap();
    std::fs::write(&replacement, b"%PDF-1.7 replacement").unwrap();

    let sessions = PdfSessionManager::new();
    let owner = modeleaf_lib::pdf_session::PdfOwner {
        window_label: "reader".into(),
        generation: 1,
    };
    let opened = sessions.open_local_file(owner.clone(), &input).unwrap();
    let identity = sessions
        .resolve_canonical_path(&owner, &opened.session_id, opened.document_generation)
        .unwrap();
    assert_eq!(
        identity,
        without_verbatim_prefix(std::fs::canonicalize(&input).unwrap())
    );

    std::fs::rename(&input, &retained).unwrap();
    std::fs::rename(&replacement, &input).unwrap();
    assert_eq!(
        sessions
            .read_range(
                &owner,
                &opened.session_id,
                opened.document_generation,
                0,
                32
            )
            .unwrap(),
        b"%PDF-1.7 retained"
    );
    assert_eq!(
        sessions
            .resolve_canonical_path(&owner, &opened.session_id, opened.document_generation)
            .unwrap(),
        identity
    );

    sessions.drain_all();
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(windows)]
#[test]
fn production_session_identity_follows_the_opened_reparse_target_after_path_swap() {
    let directory =
        std::env::temp_dir().join(format!("modeleaf-cp4-reparse-{}", rand::random::<u64>()));
    std::fs::create_dir(&directory).unwrap();
    let retained = directory.join("retained.pdf");
    let replacement = directory.join("replacement.pdf");
    let input = directory.join("input.pdf");
    std::fs::write(&retained, b"%PDF-1.7 retained").unwrap();
    std::fs::write(&replacement, b"%PDF-1.7 replacement").unwrap();
    match std::os::windows::fs::symlink_file(&retained, &input) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(1314) => {
            std::fs::remove_dir_all(directory).unwrap();
            return;
        }
        Err(error) => panic!("failed to create test symlink: {error}"),
    }

    let sessions = PdfSessionManager::new();
    let owner = modeleaf_lib::pdf_session::PdfOwner {
        window_label: "reader".into(),
        generation: 1,
    };
    let opened = sessions.open_local_file(owner.clone(), &input).unwrap();
    let identity = sessions
        .resolve_canonical_path(&owner, &opened.session_id, opened.document_generation)
        .unwrap();
    assert_eq!(
        identity,
        without_verbatim_prefix(std::fs::canonicalize(&retained).unwrap())
    );
    std::fs::remove_file(&input).unwrap();
    std::os::windows::fs::symlink_file(&replacement, &input).unwrap();
    assert_eq!(
        sessions
            .read_range(
                &owner,
                &opened.session_id,
                opened.document_generation,
                0,
                32
            )
            .unwrap(),
        b"%PDF-1.7 retained"
    );
    assert_eq!(
        sessions
            .resolve_canonical_path(&owner, &opened.session_id, opened.document_generation)
            .unwrap(),
        identity
    );

    sessions.drain_all();
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn callback_before_readiness_is_queued_and_ingested_exactly_once() {
    let workspace = WorkspaceManager::new();
    let sessions = PdfSessionManager::new();
    let coordinator = OpenRequestCoordinator::new(sessions.clone(), workspace.clone());
    let ingress = SecondInstanceIngress::default();
    let path = fixture(72);

    ingress.enqueue_paths(vec![path.clone()]);
    workspace.claim_window("reader").unwrap();
    for pending in ingress.take_ready().0 {
        coordinator.ingest_path("reader", &pending).unwrap();
    }

    assert_eq!(coordinator.pending_notices("reader").unwrap().len(), 1);
    sessions.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn pre_readiness_overflow_is_a_single_bounded_signal_per_large_batch() {
    let ingress = SecondInstanceIngress::default();
    ingress.enqueue_paths((0..10_000).map(|index| PathBuf::from(format!("queued-{index}.pdf"))));

    let (paths, overflowed) = ingress.take_ready();
    assert_eq!(paths.len(), 8);
    assert!(overflowed);
    let (paths, overflowed) = ingress.take_ready();
    assert!(paths.is_empty());
    assert!(!overflowed);

    ingress.enqueue_paths((0..10_000).map(|index| PathBuf::from(format!("next-{index}.pdf"))));
    let (paths, overflowed) = ingress.take_ready();
    assert_eq!(paths.len(), 8);
    assert!(overflowed);
}
#[test]
fn primary_startup_path_precedes_second_instance_callbacks_under_saturation() {
    let workspace = WorkspaceManager::new();
    let sessions = PdfSessionManager::new();
    let coordinator = OpenRequestCoordinator::new(sessions.clone(), workspace.clone());
    let ingress = SecondInstanceIngress::default();
    let primary = fixture(80);
    let callbacks: Vec<_> = (81..89).map(fixture).collect();

    ingress.enqueue_paths(vec![primary.clone()]);
    ingress.enqueue_paths(callbacks.clone());
    workspace.claim_window("reader").unwrap();

    let (paths, overflowed) = ingress.take_ready();
    assert_eq!(
        paths,
        std::iter::once(primary.clone())
            .chain(callbacks[..7].iter().cloned())
            .collect::<Vec<_>>()
    );
    assert!(overflowed);
    for path in paths {
        coordinator.ingest_path("reader", &path).unwrap();
    }

    let names: Vec<_> = coordinator
        .pending_notices("reader")
        .unwrap()
        .into_iter()
        .map(|notice| {
            coordinator
                .claim("reader", notice.request_id)
                .unwrap()
                .display_name
        })
        .collect();
    let expected: Vec<_> = std::iter::once(&primary)
        .chain(callbacks[..7].iter())
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, expected);
    assert!(ingress.take_ready().0.is_empty());

    sessions.drain_all();
    for path in std::iter::once(primary).chain(callbacks) {
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn native_drop_overflow_limits_open_work_and_records_one_capacity_notice() {
    let (coordinator, _, sessions) = coordinator();
    let ingress = SecondInstanceIngress::default();
    let paths: Vec<_> = (90..100).map(fixture).collect();

    ingress.enqueue_paths(paths.clone());
    let (ready, overflowed) = ingress.take_ready();
    assert_eq!(ready, paths[..8]);
    assert!(overflowed);
    for path in ready {
        coordinator.ingest_path("reader", &path).unwrap();
    }
    let overflow = coordinator
        .ingest_failure("reader", OpenRequestError::Capacity)
        .unwrap();

    assert_eq!(coordinator.pending_notices("reader").unwrap().len(), 8);
    assert_eq!(overflow.tag, OpenFailureTag::SessionCapacity);
    assert_eq!(
        coordinator.pending_failures("reader").unwrap(),
        vec![overflow]
    );
    assert!(ingress.take_ready().0.is_empty());

    sessions.drain_all();
    for path in paths {
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn notice_contains_only_the_opaque_request_id() {
    let (coordinator, _, sessions) = coordinator();
    let path = fixture(1);
    let notice = coordinator.ingest_path("reader", &path).unwrap();
    let debug = format!("{notice:?}");
    assert!(debug.contains("request_id"));
    assert!(!debug.contains(path.to_string_lossy().as_ref()));
    sessions.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn duplicate_claim_and_ack_are_idempotent_and_owner_checked() {
    let (coordinator, workspace, sessions) = coordinator();
    workspace.claim_window("other").unwrap();
    let path = fixture(2);
    let notice = coordinator.ingest_path("reader", &path).unwrap();
    assert_eq!(
        coordinator.claim("other", notice.request_id.clone()),
        Err(OpenRequestError::OwnerMismatch)
    );
    let first = coordinator
        .claim("reader", notice.request_id.clone())
        .unwrap();
    assert_eq!(
        first.owner_generation,
        workspace.active_owner("reader").unwrap().generation
    );
    assert_eq!(
        coordinator
            .claim("reader", notice.request_id.clone())
            .unwrap(),
        first
    );
    coordinator
        .acknowledge("reader", notice.request_id.clone())
        .unwrap();
    coordinator
        .acknowledge("reader", notice.request_id)
        .unwrap();
    sessions.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn failure_notices_are_owner_scoped_and_preserve_ingestion_order() {
    let (coordinator, workspace, _) = coordinator();
    workspace.claim_window("other").unwrap();

    let reader_first = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::RemotePath),
        )
        .unwrap();
    let other_first = coordinator
        .ingest_failure(
            "other",
            OpenRequestError::Session(PdfSessionError::PathRejected),
        )
        .unwrap();
    let reader_last = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::PdfInvalid),
        )
        .unwrap();

    assert_eq!(
        coordinator.pending_failures("reader").unwrap(),
        vec![reader_first, reader_last]
    );
    assert_eq!(
        coordinator.pending_failures("other").unwrap(),
        vec![other_first]
    );
}

#[test]
fn merged_pending_ingress_replays_requests_and_failures_in_exact_native_order() {
    let (coordinator, _, sessions) = coordinator();
    let first_path = fixture(70);
    let last_path = fixture(71);
    let first = coordinator.ingest_path("reader", &first_path).unwrap();
    let failure = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::PdfInvalid),
        )
        .unwrap();
    let last = coordinator.ingest_path("reader", &last_path).unwrap();

    assert_eq!(
        coordinator.pending_ingress("reader").unwrap(),
        vec![
            PendingIngressNotice::OpenRequest {
                request_id: first.request_id
            },
            PendingIngressNotice::OpenFailure {
                failure_id: failure.failure_id,
                failure_tag: OpenFailureTag::PdfInvalid,
            },
            PendingIngressNotice::OpenRequest {
                request_id: last.request_id
            },
        ]
    );
    sessions.drain_all();
    std::fs::remove_file(first_path).unwrap();
    std::fs::remove_file(last_path).unwrap();
}

#[test]
fn saturation_preserves_merged_a_failure_b_request_c_distinct_failure_order() {
    let (coordinator, _, sessions) = coordinator();
    let path = fixture(74);
    let displaced = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::PathRejected),
        )
        .unwrap();
    let first_failure = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::PdfInvalid),
        )
        .unwrap();
    let request = coordinator.ingest_path("reader", &path).unwrap();
    let overflow_summary = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::RemotePath),
        )
        .unwrap();

    assert_ne!(overflow_summary.failure_id, displaced.failure_id);
    assert_eq!(overflow_summary.tag, OpenFailureTag::SessionCapacity);
    assert_eq!(
        coordinator.pending_ingress("reader").unwrap(),
        vec![
            PendingIngressNotice::OpenFailure {
                failure_id: first_failure.failure_id,
                failure_tag: OpenFailureTag::PdfInvalid,
            },
            PendingIngressNotice::OpenRequest {
                request_id: request.request_id,
            },
            PendingIngressNotice::OpenFailure {
                failure_id: overflow_summary.failure_id,
                failure_tag: OpenFailureTag::SessionCapacity,
            },
        ]
    );
    coordinator
        .acknowledge_failure("reader", displaced.failure_id)
        .unwrap();
    sessions.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn failure_capacity_is_globally_bounded_across_all_owner_partitions() {
    let (coordinator, workspace, _) = coordinator();
    let labels = ["reader", "other", "third", "fourth"];
    for label in &labels[1..] {
        workspace.claim_window(label).unwrap();
    }

    for label in labels {
        for _ in 0..MAX_OPEN_FAILURES_PER_OWNER {
            coordinator
                .ingest_failure(
                    label,
                    OpenRequestError::Session(PdfSessionError::PdfInvalid),
                )
                .unwrap();
        }
    }

    assert_eq!(
        labels
            .into_iter()
            .map(|label| coordinator.pending_failures(label).unwrap().len())
            .sum::<usize>(),
        MAX_OPEN_FAILURES
    );
    let replacement = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::RemotePath),
        )
        .unwrap();
    assert_eq!(replacement.tag, OpenFailureTag::SessionCapacity);
    assert_eq!(
        labels
            .into_iter()
            .map(|label| coordinator.pending_failures(label).unwrap().len())
            .sum::<usize>(),
        MAX_OPEN_FAILURES
    );
}

#[test]
fn failure_acknowledgement_denies_wrong_owner() {
    let (coordinator, workspace, _) = coordinator();
    workspace.claim_window("other").unwrap();
    let notice = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::FileUnreadable),
        )
        .unwrap();

    assert_eq!(
        coordinator.acknowledge_failure("other", notice.failure_id.clone()),
        Err(OpenRequestError::OwnerMismatch)
    );
    assert_eq!(
        coordinator.pending_failures("reader").unwrap(),
        vec![notice]
    );
}

#[test]
fn failure_acknowledgement_is_idempotent_until_its_bounded_tombstone_expires() {
    let (coordinator, _, _) = coordinator();
    let first = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::RemotePath),
        )
        .unwrap();
    coordinator
        .acknowledge_failure("reader", first.failure_id.clone())
        .unwrap();
    coordinator
        .acknowledge_failure("reader", first.failure_id.clone())
        .unwrap();

    for _ in 0..MAX_OPEN_FAILURE_TOMBSTONES {
        let notice = coordinator
            .ingest_failure(
                "reader",
                OpenRequestError::Session(PdfSessionError::PathRejected),
            )
            .unwrap();
        coordinator
            .acknowledge_failure("reader", notice.failure_id)
            .unwrap();
    }
    assert_eq!(
        coordinator.acknowledge_failure("reader", first.failure_id),
        Err(OpenRequestError::NotFound)
    );
}

#[test]
fn target_loss_cancels_owner_failures() {
    let (coordinator, workspace, _) = coordinator();
    let owner = workspace.active_owner("reader").unwrap();
    let notice = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::PdfInvalid),
        )
        .unwrap();

    coordinator.target_lost(&owner);
    coordinator.target_lost(&owner);

    assert!(coordinator.pending_failures("reader").unwrap().is_empty());
    assert_eq!(
        coordinator.acknowledge_failure("reader", notice.failure_id),
        Err(OpenRequestError::Cancelled)
    );
}

#[test]
fn failure_notice_serializes_only_opaque_id_and_tag() {
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    let (coordinator, _, _) = coordinator();
    let notice = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::RemotePath),
        )
        .unwrap();
    assert_eq!(notice.tag, OpenFailureTag::RemotePath);

    let failure_id = match notice.failure_id.clone().body().unwrap() {
        InvokeResponseBody::Json(json) => json,
        InvokeResponseBody::Raw(_) => panic!("failure ID must use the JSON IPC response shape"),
    };
    let serialized = match notice.body().unwrap() {
        InvokeResponseBody::Json(json) => json,
        InvokeResponseBody::Raw(_) => panic!("failure notice must use the JSON IPC response shape"),
    };
    assert_eq!(
        serialized,
        format!(r#"{{"failureId":{failure_id},"tag":"REMOTE_PATH"}}"#)
    );
    assert!(!serialized.contains(r"C:\private\document.pdf"));
}

#[test]
fn document_too_large_failure_serializes_as_an_opaque_tag() {
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    let (coordinator, _, _) = coordinator();
    let notice = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::DocumentTooLarge),
        )
        .unwrap();
    assert_eq!(notice.tag, OpenFailureTag::DocumentTooLarge);

    let failure_id = match notice.failure_id.clone().body().unwrap() {
        InvokeResponseBody::Json(json) => json,
        InvokeResponseBody::Raw(_) => panic!("failure ID must use the JSON IPC response shape"),
    };
    let serialized = match notice.body().unwrap() {
        InvokeResponseBody::Json(json) => json,
        InvokeResponseBody::Raw(_) => panic!("failure notice must use the JSON IPC response shape"),
    };
    assert_eq!(
        serialized,
        format!(r#"{{"failureId":{failure_id},"tag":"DOCUMENT_TOO_LARGE"}}"#)
    );
}
#[test]
fn chooser_and_remote_failures_replay_with_safe_tags_until_acknowledged() {
    let (coordinator, workspace, _) = coordinator();
    workspace.claim_window("other").unwrap();

    let chooser = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::DialogFailed),
        )
        .unwrap();
    let remote = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::RemotePath),
        )
        .unwrap();

    assert_eq!(chooser.tag, OpenFailureTag::PathRejected);
    assert_eq!(remote.tag, OpenFailureTag::RemotePath);
    assert_eq!(
        coordinator.pending_failures("reader").unwrap(),
        vec![chooser.clone(), remote.clone()]
    );
    assert_eq!(
        coordinator.acknowledge_failure("other", chooser.failure_id.clone()),
        Err(OpenRequestError::OwnerMismatch)
    );
    coordinator
        .acknowledge_failure("reader", chooser.failure_id.clone())
        .unwrap();
    coordinator
        .acknowledge_failure("reader", chooser.failure_id)
        .unwrap();
    assert_eq!(
        coordinator.pending_failures("reader").unwrap(),
        vec![remote]
    );
}

#[test]
fn saturated_failures_replace_a_terminalized_id_with_a_fresh_capacity_summary() {
    let (coordinator, _, _) = coordinator();
    let first = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::PathRejected),
        )
        .unwrap();
    let retained = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::PdfInvalid),
        )
        .unwrap();
    let summary = coordinator
        .ingest_failure(
            "reader",
            OpenRequestError::Session(PdfSessionError::RemotePath),
        )
        .unwrap();

    assert_ne!(summary.failure_id, first.failure_id);
    assert_eq!(summary.tag, OpenFailureTag::SessionCapacity);
    assert_eq!(
        coordinator.pending_failures("reader").unwrap(),
        vec![retained, summary]
    );
    coordinator
        .acknowledge_failure("reader", first.failure_id)
        .unwrap();
}

#[test]
fn request_capacity_is_bounded_before_a_ninth_session_is_opened() {
    let (coordinator, _, sessions) = coordinator();
    let mut paths = Vec::new();
    for number in 0..MAX_OPEN_REQUESTS {
        let path = fixture(number as u8 + 10);
        coordinator.ingest_path("reader", &path).unwrap();
        paths.push(path);
    }
    let ninth = fixture(30);
    assert_eq!(
        coordinator.ingest_path("reader", &ninth),
        Err(OpenRequestError::Capacity)
    );
    sessions.drain_all();
    for path in paths.into_iter().chain(std::iter::once(ninth)) {
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn target_loss_cancels_an_unacknowledged_request_once_without_retargeting() {
    let (coordinator, workspace, sessions) = coordinator();
    let owner = workspace.active_owner("reader").unwrap();
    let path = fixture(40);
    let notice = coordinator.ingest_path("reader", &path).unwrap();
    coordinator.target_lost(&owner);
    coordinator.target_lost(&owner);
    assert_eq!(
        coordinator.claim("reader", notice.request_id),
        Err(OpenRequestError::Cancelled)
    );
    sessions.drain_all();
    std::fs::remove_file(path).unwrap();
}
#[test]
fn lifecycle_target_loss_tombstones_before_one_aggregate_owner_drain() {
    let (coordinator, workspace, sessions) = coordinator();
    let owner = workspace.active_owner("reader").unwrap();
    let path = fixture(73);
    let notice = coordinator.ingest_path("reader", &path).unwrap();

    coordinator.target_lost_for_lifecycle(&owner);
    assert_eq!(
        coordinator.claim("reader", notice.request_id),
        Err(OpenRequestError::Cancelled)
    );
    assert!(!sessions.assert_empty());
    sessions.drain_owned(&owner);
    workspace.destroy_window(&owner).unwrap();
    assert!(sessions.assert_empty());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn cold_start_enumeration_replays_pending_notice_without_claiming_it() {
    let (coordinator, _, sessions) = coordinator();
    let path = fixture(35);
    let notice = coordinator.ingest_path("reader", &path).unwrap();

    assert_eq!(
        coordinator.pending_notices("reader").unwrap(),
        vec![notice.clone()]
    );
    coordinator
        .claim("reader", notice.request_id.clone())
        .unwrap();
    assert_eq!(
        coordinator.pending_notices("reader").unwrap(),
        vec![notice.clone()]
    );
    coordinator
        .acknowledge("reader", notice.request_id)
        .unwrap();
    assert!(coordinator.pending_notices("reader").unwrap().is_empty());

    sessions.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn pending_notice_enumeration_is_owner_scoped_and_denies_unknown_windows() {
    let (coordinator, workspace, sessions) = coordinator();
    workspace.claim_window("other").unwrap();
    let path = fixture(36);
    let notice = coordinator.ingest_path("reader", &path).unwrap();

    assert!(coordinator.pending_notices("other").unwrap().is_empty());
    assert_eq!(
        coordinator.pending_notices("missing"),
        Err(OpenRequestError::OwnerMismatch)
    );
    assert_eq!(coordinator.pending_notices("reader").unwrap(), vec![notice]);

    sessions.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn pending_notices_replay_native_ingestion_order_per_owner_after_terminal_requests() {
    let (coordinator, workspace, sessions) = coordinator();
    workspace.claim_window("other").unwrap();
    let paths = vec![
        fixture(50),
        fixture(51),
        fixture(52),
        fixture(53),
        fixture(54),
    ];

    let reader_first = coordinator.ingest_path("reader", &paths[0]).unwrap();
    let reader_terminal = coordinator.ingest_path("reader", &paths[1]).unwrap();
    let other_first = coordinator.ingest_path("other", &paths[2]).unwrap();

    coordinator
        .claim("reader", reader_terminal.request_id.clone())
        .unwrap();
    coordinator
        .acknowledge("reader", reader_terminal.request_id)
        .unwrap();

    let reader_last = coordinator.ingest_path("reader", &paths[3]).unwrap();
    let other_last = coordinator.ingest_path("other", &paths[4]).unwrap();

    assert_eq!(
        coordinator.pending_notices("reader").unwrap(),
        vec![reader_first, reader_last]
    );
    assert_eq!(
        coordinator.pending_notices("other").unwrap(),
        vec![other_first, other_last]
    );

    sessions.drain_all();
    for path in paths {
        std::fs::remove_file(path).unwrap();
    }
}

fn deferred_cleanup_after_external_activation(reject: bool) {
    let (coordinator, workspace, sessions) = coordinator();
    let owner = workspace.active_owner("reader").unwrap();
    let path = fixture(if reject { 60 } else { 61 });
    let notice = coordinator.ingest_path("reader", &path).unwrap();
    let claimed = coordinator
        .claim("reader", notice.request_id.clone())
        .unwrap();
    let links = vec![ExternalLinkRegistration {
        annotation_id: "link".into(),
        target: "https://example.com/".into(),
    }];
    sessions
        .prepare_external_links(
            &owner,
            &claimed.session_id,
            claimed.document_generation,
            1,
            links,
        )
        .unwrap();
    sessions
        .commit_external_links(&owner, &claimed.session_id, claimed.document_generation, 1)
        .unwrap();
    sessions
        .finalize_external_links(&owner, &claimed.session_id, claimed.document_generation, 1)
        .unwrap();

    let (started_tx, started_rx) = mpsc::channel();
    let (settle_tx, settle_rx) = mpsc::channel();
    let activation_sessions = sessions.clone();
    let activation_owner = owner.clone();
    let activation_id = claimed.session_id.clone();
    let generation = claimed.document_generation;
    let activation = thread::spawn(move || {
        activation_sessions
            .activate_external_link_with(
                &activation_owner,
                &activation_id,
                generation,
                1,
                "link",
                move |_| {
                    started_tx.send(()).unwrap();
                    settle_rx.recv().unwrap();
                    Ok::<(), ()>(())
                },
            )
            .unwrap();
    });
    started_rx.recv().unwrap();

    if reject {
        coordinator
            .reject("reader", notice.request_id.clone())
            .unwrap();
        coordinator.reject("reader", notice.request_id).unwrap();
    } else {
        coordinator.target_lost_for_lifecycle(&owner);
        assert_eq!(
            coordinator.claim("reader", notice.request_id),
            Err(OpenRequestError::Cancelled)
        );
        workspace.destroy_window(&owner).unwrap();
        assert_eq!(workspace.budget().sessions, 0);
        assert!(!sessions.assert_empty());
        let lifecycle_sessions = sessions.clone();
        let lifecycle_owner = owner.clone();
        let lifecycle = thread::spawn(move || lifecycle_sessions.drain_owned(&lifecycle_owner));

        settle_tx.send(()).unwrap();
        activation.join().unwrap();
        lifecycle.join().unwrap();
        assert!(sessions.assert_empty());
        std::fs::remove_file(path).unwrap();
        return;
    }
    assert_eq!(workspace.budget().sessions, 1);
    assert!(!sessions.assert_empty());

    settle_tx.send(()).unwrap();
    activation.join().unwrap();
    assert!(coordinator.pending_ingress("reader").unwrap().is_empty());
    assert_eq!(workspace.budget().sessions, 0);
    std::fs::remove_file(path).unwrap();
    assert!(sessions.assert_empty());
}

#[test]
fn reject_defers_workspace_release_until_external_link_settles() {
    deferred_cleanup_after_external_activation(true);
}

#[test]
fn target_loss_keeps_native_session_until_aggregate_drain_settles() {
    deferred_cleanup_after_external_activation(false);
}

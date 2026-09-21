use modeleaf_lib::diagnostics::{
    DiagnosticEvent, DiagnosticEventName, DiagnosticLog, DiagnosticOutcome, DiagnosticStorageClass,
    DiagnosticTag,
};
use modeleaf_lib::open_request::OpenRequestCoordinator;
use modeleaf_lib::pdf_session::PdfSessionManager;
use modeleaf_lib::theme_state::{ThemeId, ThemeStateError, ThemeStateManager};
use modeleaf_lib::workspace::WorkspaceManager;
use modeleaf_lib::{drain_owner_for_lifecycle, QuitCoordinator};
use std::fs;
use std::path::PathBuf;

fn temp_dir(label: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("modeleaf-cp5-{label}-{}", rand::random::<u64>()));
    fs::create_dir(&directory).unwrap();
    directory
}

#[test]
fn native_quit_is_idempotent_and_drains_open_request_and_pdf_ownership() {
    let directory = temp_dir("quit");
    let path = directory.join("owned.pdf");
    fs::write(&path, b"%PDF-1.7\n").unwrap();

    let workspace = WorkspaceManager::new();
    let owner = workspace.claim_window("reader").unwrap();
    let sessions = PdfSessionManager::new();
    let requests = OpenRequestCoordinator::new(sessions.clone(), workspace.clone());
    requests.ingest_path("reader", &path).unwrap();
    assert_eq!(workspace.budget().sessions, 1);

    let quit = QuitCoordinator::default();
    assert!(quit.begin(["reader".to_owned()]));
    drain_owner_for_lifecycle(&requests, &workspace, &sessions, &owner);
    assert_eq!(workspace.budget().windows, 0);
    assert_eq!(workspace.budget().sessions, 0);
    sessions.drain_owned(&owner);
    assert!(sessions.assert_empty());

    assert!(requests.pending_ingress("reader").is_err());
    assert!(!quit.begin(["reader".to_owned()]));
    drain_owner_for_lifecycle(&requests, &workspace, &sessions, &owner);
    assert_eq!(workspace.budget().windows, 0);
    assert_eq!(workspace.budget().sessions, 0);
    sessions.drain_owned(&owner);
    assert!(sessions.assert_empty());

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn native_state_commands_have_finite_stale_and_diagnostic_rejections() {
    let directory = temp_dir("commands");
    let themes = ThemeStateManager::load(directory.join("theme-state.json"));
    let committed = themes.commit(ThemeId::Dracula, 0).unwrap();
    assert_eq!(committed.revision(), 1);
    assert_eq!(
        themes.commit(ThemeId::Everforest, 0),
        Err(ThemeStateError::Conflict)
    );

    let diagnostics = DiagnosticLog::open(directory.join("diagnostics")).unwrap();
    let invalid = DiagnosticEvent {
        event: DiagnosticEventName::Quit,
        outcome: DiagnosticOutcome::Rejected,
        tag: DiagnosticTag::ValidationRejected,
        storage_class: DiagnosticStorageClass::Local,
        epoch_ms: 0,
        app_version: "invalid".to_owned(),
        runtime_version: "1.0.0".to_owned(),
        trace_id: None,
        request_id: None,
        session_id: None,
        page: None,
        count: None,
        duration_ms: None,
        generation: None,
        stage: None,
        os_code: None,
    };
    assert!(diagnostics.record(&invalid).is_err());
    assert!(!directory
        .join("diagnostics")
        .join("diagnostics.jsonl")
        .exists());

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn native_quit_waits_for_every_window_and_aggregates_renderer_failures() {
    let quit = QuitCoordinator::default();
    assert!(quit.begin(["main".to_owned(), "reader-1".to_owned()]));
    assert_eq!(quit.acknowledge("main", true), None);
    assert_eq!(quit.acknowledge("reader-1", true), Some(true));
    assert_eq!(quit.acknowledge("reader-1", true), None);

    let failed = QuitCoordinator::default();
    assert!(failed.begin(["main".to_owned(), "reader-1".to_owned()]));
    assert_eq!(failed.acknowledge("main", false), None);
    assert_eq!(failed.acknowledge("reader-1", true), Some(false));
}

#[path = "../src/diagnostics.rs"]
mod diagnostics;

use diagnostics::{
    DiagnosticEvent, DiagnosticEventName, DiagnosticLog, DiagnosticOutcome, DiagnosticStorageClass,
    DiagnosticTag, MAX_LOG_BYTES,
};
use std::fs;
use std::path::PathBuf;

fn temp_dir(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "modeleaf-cp5-diagnostics-{label}-{}",
        rand::random::<u64>()
    ));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn event() -> DiagnosticEvent {
    DiagnosticEvent {
        event: DiagnosticEventName::PdfSession,
        outcome: DiagnosticOutcome::Success,
        tag: DiagnosticTag::None,
        storage_class: DiagnosticStorageClass::Local,
        epoch_ms: 1_700_000_000_000,
        app_version: "0.1.0".to_owned(),
        runtime_version: "5.7.284".to_owned(),
        trace_id: Some("0123456789abcdef0123456789abcdef".to_owned()),
        request_id: Some("11111111111111111111111111111111".to_owned()),
        session_id: Some("22222222222222222222222222222222".to_owned()),
        page: Some(1),
        count: Some(2),
        duration_ms: Some(50),
        generation: Some(3),
    }
}

#[test]
fn bounded_events_persist_and_rotate_deterministically() {
    let directory = temp_dir("rotation");
    let log = DiagnosticLog::open(&directory).unwrap();
    let event = event();
    for _ in 0..((MAX_LOG_BYTES as usize / 200) + 3) {
        log.record(&event).unwrap();
    }

    let active = fs::read_to_string(directory.join("diagnostics.jsonl")).unwrap();
    let previous = fs::read_to_string(directory.join("diagnostics.jsonl.1")).unwrap();
    assert!(!active.is_empty());
    assert!(!previous.is_empty());
    assert!(
        (fs::metadata(directory.join("diagnostics.jsonl"))
            .unwrap()
            .len())
            <= MAX_LOG_BYTES
    );
    assert!(
        (fs::metadata(directory.join("diagnostics.jsonl.1"))
            .unwrap()
            .len())
            <= MAX_LOG_BYTES
    );
    assert!(active
        .lines()
        .all(|line| line.contains("\"storageClass\":\"LOCAL\"")));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn prohibited_values_are_rejected_before_any_output() {
    let directory = temp_dir("redaction");
    let log = DiagnosticLog::open(&directory).unwrap();
    let hostile = [
        r"C:\Users\alice\secret.pdf",
        r"\\server\share\secret.pdf",
        "alice",
        "PDF content that must not be retained",
        "검색어 비밀번호",
        "password=hunter2",
        "https://example.test/secret.pdf",
        "line\ncontrol",
    ];

    for value in hostile {
        let mut invalid = event();
        invalid.app_version = value.to_owned();
        assert!(log.record(&invalid).is_err());
        let mut invalid = event();
        invalid.trace_id = Some(value.to_owned());
        assert!(log.record(&invalid).is_err());
    }

    assert!(!directory.join("diagnostics.jsonl").exists());
    let output = fs::read_dir(&directory)
        .unwrap()
        .flat_map(|entry| fs::read_to_string(entry.unwrap().path()))
        .collect::<String>();
    for value in hostile {
        assert!(!output.contains(value));
    }
    fs::remove_dir_all(directory).unwrap();
}

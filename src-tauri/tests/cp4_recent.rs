use modeleaf_lib::local_path::{DriveKind, LocalPathPolicy, PathPolicyError};
use modeleaf_lib::persistence::lock::lock_path;
use modeleaf_lib::recent::{
    RecentListOutcome, RecentStateReason, RecentStore, RecentStoreError, MAX_RECENT_DOCUMENTS,
};
use modeleaf_lib::theme_state::{ThemeId, ThemeStateManager};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

struct Policy(DriveKind);
impl LocalPathPolicy for Policy {
    fn classify(&self, _path: &Path) -> Result<DriveKind, PathPolicyError> {
        Ok(self.0)
    }
}
fn temp_dir(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "modeleaf-recent-{label}-문서-{:032x}",
        rand::random::<u128>()
    ));
    fs::create_dir_all(&directory).unwrap();
    directory
}
fn pdf(directory: &Path, index: usize) -> PathBuf {
    let path = directory.join(format!("문서-{index}.PDF"));
    fs::write(&path, b"%PDF-1.7\n").unwrap();
    path
}

#[test]
fn successful_opens_dedupe_promote_cap_and_persist_in_unified_state() {
    let directory = temp_dir("cap");
    let state = directory.join("state.json");
    let policy = Policy(DriveKind::Fixed);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    for index in 0..=MAX_RECENT_DOCUMENTS {
        store
            .debug_record_opened_and_save(&pdf(&directory, index), &policy)
            .unwrap();
    }
    assert_eq!(store.documents().len(), MAX_RECENT_DOCUMENTS);
    let retained = pdf(&directory, MAX_RECENT_DOCUMENTS);
    let reopened = store
        .debug_record_opened_and_save(&retained, &policy)
        .unwrap();
    assert_eq!(store.documents()[0].recent_id(), reopened.recent_id());
    assert_eq!(
        store
            .documents()
            .iter()
            .filter(|entry| entry.display_name() == retained.file_name().unwrap().to_string_lossy())
            .count(),
        1
    );
    let root: Value = serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
    assert_eq!(
        root["recent_files"].as_array().unwrap().len(),
        MAX_RECENT_DOCUMENTS
    );
    assert!(root["recent_files"][0]["last_opened_at"].is_string());
    assert!(root["recent_files"][0]["absolute_path"].is_string());
    assert!(root["recent_files"][0].get("displayPath").is_none());
    assert!(root["recent_files"][0].get("displayName").is_none());
    assert!(root["recent_files"][0].get("recentId").is_none());
    assert!(root.get("schemaVersion").is_none());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn renderer_projection_serializes_native_display_path_but_resolution_remains_id_authorized() {
    let directory = temp_dir("opaque");
    let long_directory = directory
        .join(format!("긴 디렉터리 with spaces 😀 {}", "가".repeat(48)))
        .join(format!("second long directory {} 공백", "b".repeat(72)));
    fs::create_dir_all(&long_directory).unwrap();
    let state = directory.join("state.json");
    let policy = Policy(DriveKind::Fixed);
    let path = long_directory.join("최종 문서 with spaces 😀.PDF");
    fs::write(&path, b"%PDF-1.7\n").unwrap();
    let forged_path = pdf(&directory, 99);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    let document = store.debug_record_opened_and_save(&path, &policy).unwrap();
    let resolved = store
        .resolve_for_open(document.recent_id(), &policy)
        .unwrap();

    assert_eq!(Path::new(document.display_path()), resolved);
    assert_eq!(
        document.display_name(),
        path.file_name().unwrap().to_string_lossy().as_ref()
    );
    assert!(document
        .display_path()
        .contains("긴 디렉터리 with spaces 😀"));
    assert!(!document.display_path().is_empty());
    assert!(document.display_path().encode_utf16().count() <= 32_767);
    assert!(!document.display_path().chars().any(char::is_control));

    let projection = serde_json::to_value(&document).unwrap();
    assert_eq!(
        projection,
        serde_json::json!({
            "recentId": document.recent_id(),
            "displayName": path.file_name().unwrap().to_string_lossy().into_owned(),
            "displayPath": resolved.to_string_lossy().into_owned(),
        })
    );
    let documents = store.documents();
    assert_eq!(documents, vec![document.clone()]);
    assert_eq!(serde_json::to_value(&documents[0]).unwrap(), projection);
    let list_projection = serde_json::to_value(store.list_outcome()).unwrap();
    assert_eq!(list_projection["entries"][0], projection);

    let mut forged_projection = projection;
    forged_projection["displayPath"] = Value::String(
        fs::canonicalize(&forged_path)
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    );
    assert_eq!(
        store
            .resolve_for_open(forged_projection["recentId"].as_str().unwrap(), &policy)
            .unwrap(),
        resolved
    );
    assert!(matches!(
        store.resolve_for_open(forged_projection["displayPath"].as_str().unwrap(), &policy),
        Err(RecentStoreError::MissingRecentId)
    ));
    assert!(matches!(
        store.resolve_for_open("recent-missing", &policy),
        Err(RecentStoreError::MissingRecentId)
    ));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn display_path_projection_sanitizes_controls_and_rejects_oversized_values() {
    let directory = temp_dir("display-path-guards");
    let policy = Policy(DriveKind::Fixed);
    let control_state = directory.join("control-state.json");
    let control_path = directory
        .join("줄\n바꿈 문서.PDF")
        .to_string_lossy()
        .into_owned();
    fs::write(
        &control_state,
        serde_json::to_vec(&serde_json::json!({
            "recent_files": [{
                "absolute_path": control_path,
                "last_opened_at": "1",
            }],
        }))
        .unwrap(),
    )
    .unwrap();
    let control_store = RecentStore::load(&control_state, &policy).unwrap();
    let control_documents = control_store.documents();
    let control_projection = serde_json::to_value(&control_documents[0]).unwrap();
    let display_path = control_projection["displayPath"].as_str().unwrap();
    assert!(display_path.contains('\u{FFFD}'));
    assert!(!display_path.is_empty());
    assert!(display_path.encode_utf16().count() <= 32_767);
    assert!(!display_path.chars().any(char::is_control));

    let oversized_state = directory.join("oversized-state.json");
    let oversized_path = directory
        .join(format!("{}.PDF", "a".repeat(32_768)))
        .to_string_lossy()
        .into_owned();
    let oversized_bytes = serde_json::to_vec(&serde_json::json!({
        "recent_files": [{
            "absolute_path": oversized_path,
            "last_opened_at": "1",
        }],
    }))
    .unwrap();
    fs::write(&oversized_state, &oversized_bytes).unwrap();
    let oversized_store = RecentStore::load(&oversized_state, &policy).unwrap();
    assert_eq!(
        oversized_store.list_outcome(),
        RecentListOutcome::StateUnavailable {
            reason: RecentStateReason::RecentFieldInvalid
        }
    );
    assert!(oversized_store.documents().is_empty());
    assert_eq!(fs::read(&oversized_state).unwrap(), oversized_bytes);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn theme_recent_and_unknown_fields_survive_each_others_updates() {
    let directory = temp_dir("merge");
    let state = directory.join("state.json");
    fs::write(&state, br#"{"future":{"keep":true}}"#).unwrap();
    let themes = ThemeStateManager::load(&state);
    themes.commit(ThemeId::Nord, 0).unwrap();
    let policy = Policy(DriveKind::Fixed);
    let mut recents = RecentStore::load(&state, &policy).unwrap();
    recents
        .debug_record_opened_and_save(&pdf(&directory, 0), &policy)
        .unwrap();
    let root: Value = serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
    assert_eq!(root["selected_theme"], "nord");
    assert_eq!(root["future"]["keep"], true);
    assert_eq!(root["recent_files"].as_array().unwrap().len(), 1);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn malformed_recent_sibling_is_reported_and_preserved_byte_for_byte() {
    let directory = temp_dir("malformed");
    let state = directory.join("state.json");
    fs::write(&state, br#"{"selected_theme":"dracula","recent_files":{}}"#).unwrap();
    let original = fs::read(&state).unwrap();
    assert_eq!(
        ThemeStateManager::load(&state).current().theme_id(),
        ThemeId::Dracula
    );
    let policy = Policy(DriveKind::Fixed);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    assert_eq!(
        store.list_outcome(),
        RecentListOutcome::StateUnavailable {
            reason: RecentStateReason::RecentFieldInvalid
        }
    );
    assert!(matches!(
        store.debug_record_opened_and_save(&pdf(&directory, 0), &policy),
        Err(RecentStoreError::StateUnavailable(
            RecentStateReason::RecentFieldInvalid
        ))
    ));
    assert_eq!(fs::read(&state).unwrap(), original);
    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn unknown_and_semantically_invalid_recent_members_are_fail_closed() {
    let directory = temp_dir("strict-members");
    let candidate = pdf(&directory, 0).to_string_lossy().into_owned();
    let invalid_members = [
        serde_json::json!({"absolute_path": candidate, "last_opened_at": "1", "extra": true}),
        serde_json::json!({"absolute_path": "relative.pdf", "last_opened_at": "1"}),
        serde_json::json!({"absolute_path": directory.join("not-pdf.txt").to_string_lossy(), "last_opened_at": "1"}),
        serde_json::json!({"absolute_path": directory.join("valid.pdf").to_string_lossy(), "last_opened_at": "invalid"}),
    ];
    let policy = Policy(DriveKind::Fixed);
    for (index, member) in invalid_members.into_iter().enumerate() {
        let state = directory.join(format!("state-{index}.json"));
        let bytes = serde_json::to_vec(
            &serde_json::json!({"selected_theme":"nord","recent_files":[member]}),
        )
        .unwrap();
        fs::write(&state, &bytes).unwrap();
        let mut store = RecentStore::load(&state, &policy).unwrap();
        assert_eq!(
            store.list_outcome(),
            RecentListOutcome::StateUnavailable {
                reason: RecentStateReason::RecentFieldInvalid
            }
        );
        assert!(matches!(
            store.debug_record_opened_and_save(&pdf(&directory, index + 10), &policy),
            Err(RecentStoreError::StateUnavailable(
                RecentStateReason::RecentFieldInvalid
            ))
        ));
        assert_eq!(fs::read(&state).unwrap(), bytes);
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_root_introduced_after_load_is_not_replaced_by_recent_mutation() {
    let directory = temp_dir("late-invalid-root");
    let state = directory.join("state.json");
    fs::write(&state, b"{}").unwrap();
    let policy = Policy(DriveKind::Fixed);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    fs::write(&state, b"[]").unwrap();
    assert!(matches!(
        store.debug_record_opened_and_save(&pdf(&directory, 0), &policy),
        Err(RecentStoreError::Io(_))
    ));
    assert_eq!(fs::read(&state).unwrap(), b"[]");
    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn invalid_root_is_reported_without_quarantine_or_compatibility_fallback() {
    let directory = temp_dir("invalid");
    let state = directory.join("state.json");
    fs::write(&state, b"not-json").unwrap();
    let policy = Policy(DriveKind::Fixed);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    assert!(matches!(
        store.list_outcome(),
        RecentListOutcome::StateUnavailable {
            reason: RecentStateReason::StateInvalidRoot
        }
    ));
    assert!(matches!(
        store.debug_record_opened_and_save(&pdf(&directory, 99), &policy),
        Err(RecentStoreError::StateUnavailable(
            RecentStateReason::StateInvalidRoot
        ))
    ));
    assert_eq!(fs::read(&state).unwrap(), b"not-json");
    assert!(!directory.join("recent.quarantine.json").exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn confirmed_missing_recent_is_pruned_but_other_failures_are_retained() {
    let directory = temp_dir("missing-prune");
    let state = directory.join("state.json");
    let policy = Policy(DriveKind::Fixed);
    let path = pdf(&directory, 0);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    let document = store.debug_record_opened_and_save(&path, &policy).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(
        matches!(store.resolve_for_open(document.recent_id(), &policy), Err(RecentStoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound)
    );
    assert!(store.prune_missing_id(document.recent_id()).unwrap());
    assert!(store.documents().is_empty());
    let root: Value = serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
    assert!(root["recent_files"].as_array().unwrap().is_empty());
    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn remote_and_non_pdf_paths_are_rejected_without_state_mutation() {
    let directory = temp_dir("policy");
    let state = directory.join("state.json");
    let path = pdf(&directory, 0);
    let mut remote = RecentStore::load(&state, &Policy(DriveKind::Remote)).unwrap();
    assert!(matches!(
        remote.debug_record_opened_and_save(&path, &Policy(DriveKind::Remote)),
        Err(RecentStoreError::RemotePath)
    ));
    let text = directory.join("notes.txt");
    fs::write(&text, b"x").unwrap();
    let mut local = RecentStore::load(&state, &Policy(DriveKind::Fixed)).unwrap();
    assert!(matches!(
        local.debug_record_opened_and_save(&text, &Policy(DriveKind::Fixed)),
        Err(RecentStoreError::NotPdf)
    ));
    assert!(!state.exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn clear_recents_is_durable_repeatable_and_keeps_cache_and_state_in_agreement() {
    let directory = temp_dir("clear");
    let state = directory.join("state.json");
    fs::write(
        &state,
        br##"{"future":{"keep":true},"selected_theme":"nord","link_destination_indicator":{"style":"target","color":"#12abcf","size":28.5,"duration_ms":1500}}"##,
    )
    .unwrap();
    let policy = Policy(DriveKind::Fixed);
    let first_pdf = pdf(&directory, 0);
    let second_pdf = pdf(&directory, 1);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    store
        .debug_record_opened_and_save(&first_pdf, &policy)
        .unwrap();
    store
        .debug_record_opened_and_save(&second_pdf, &policy)
        .unwrap();
    let (before_revision, before_entries) = store.snapshot();
    let cleared_ids: Vec<_> = before_entries
        .iter()
        .map(|entry| entry.recent_id().to_owned())
        .collect();

    assert!(store.clear_all_and_save().unwrap());
    let (cleared_revision, cleared_entries) = store.snapshot();
    assert_eq!(
        cleared_revision.parse::<u64>().unwrap(),
        before_revision.parse::<u64>().unwrap() + 1
    );
    assert!(cleared_entries.is_empty());
    assert_eq!(
        store.list_outcome(),
        RecentListOutcome::Ready {
            revision: cleared_revision.clone(),
            entries: cleared_entries
        }
    );
    for recent_id in cleared_ids {
        assert!(matches!(
            store.resolve_for_open(&recent_id, &policy),
            Err(RecentStoreError::MissingRecentId)
        ));
    }
    let root: Value = serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
    assert!(root["recent_files"].as_array().unwrap().is_empty());
    assert_eq!(root["selected_theme"], "nord");
    assert_eq!(root["link_destination_indicator"]["style"], "target");
    assert_eq!(root["future"]["keep"], true);
    assert!(first_pdf.exists());
    assert!(second_pdf.exists());

    let after_first_clear = fs::read(&state).unwrap();
    assert!(!store.clear_all_and_save().unwrap());
    assert_eq!(store.snapshot().0, cleared_revision);
    assert!(store.snapshot().1.is_empty());
    assert_eq!(fs::read(&state).unwrap(), after_first_clear);
    let reloaded = RecentStore::load(&state, &policy).unwrap();
    assert!(matches!(
        reloaded.list_outcome(),
        RecentListOutcome::Ready { entries, .. } if entries.is_empty()
    ));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn clear_recents_reports_malformed_state_without_replacing_it() {
    let directory = temp_dir("clear-malformed");
    let state = directory.join("state.json");
    let policy = Policy(DriveKind::Fixed);
    let source = pdf(&directory, 0);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    store
        .debug_record_opened_and_save(&source, &policy)
        .unwrap();
    fs::write(&state, br#"{"selected_theme":"dracula","recent_files":{}}"#).unwrap();
    let malformed = fs::read(&state).unwrap();

    assert!(matches!(
        store.clear_all_and_save(),
        Err(RecentStoreError::StateUnavailable(
            RecentStateReason::RecentFieldInvalid
        ))
    ));
    assert_eq!(
        store.list_outcome(),
        RecentListOutcome::StateUnavailable {
            reason: RecentStateReason::RecentFieldInvalid
        }
    );
    assert_eq!(fs::read(&state).unwrap(), malformed);
    assert!(source.exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn failed_clear_retains_durable_state_cache_ids_and_revision() {
    let directory = temp_dir("clear-failure");
    let state = directory.join("state.json");
    let policy = Policy(DriveKind::Fixed);
    let source = pdf(&directory, 0);
    let mut store = RecentStore::load(&state, &policy).unwrap();
    let recent = store
        .debug_record_opened_and_save(&source, &policy)
        .unwrap();
    let original = fs::read(&state).unwrap();
    let original_snapshot = store.snapshot();
    let sidecar = lock_path(&state);
    fs::remove_file(&sidecar).unwrap();
    fs::create_dir(&sidecar).unwrap();

    assert!(matches!(
        store.clear_all_and_save(),
        Err(RecentStoreError::Io(_))
    ));
    assert_eq!(store.snapshot(), original_snapshot);
    assert_eq!(fs::read(&state).unwrap(), original);
    assert_eq!(
        store
            .resolve_for_open(recent.recent_id(), &policy)
            .unwrap()
            .file_name(),
        source.file_name()
    );

    fs::remove_dir(&sidecar).unwrap();
    assert!(store.clear_all_and_save().unwrap());
    fs::remove_dir_all(directory).unwrap();
}

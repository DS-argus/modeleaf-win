use modeleaf_lib::theme_state::{ThemeId, ThemeStateError, ThemeStateManager};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::thread;

fn temp_dir(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "modeleaf-state-theme-{label}-{:032x}",
        rand::random::<u128>()
    ));
    fs::create_dir_all(&directory).unwrap();
    directory
}
fn state_path(directory: &Path) -> PathBuf {
    directory.join("state.json")
}

#[test]
fn absent_state_defaults_silently_to_tokyo_night() {
    let directory = temp_dir("absent");
    let manager = ThemeStateManager::load(state_path(&directory));
    assert_eq!(manager.current().theme_id(), ThemeId::TokyoNight);
    assert_eq!(manager.current().revision(), 0);
    assert!(!manager.take_startup_recovery_needed());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn every_exact_theme_id_round_trips_while_revision_remains_process_local() {
    let directory = temp_dir("themes");
    let path = state_path(&directory);
    let manager = ThemeStateManager::load(&path);
    let ids = [
        ThemeId::TokyoNight,
        ThemeId::GruvboxDark,
        ThemeId::SolarizedDark,
        ThemeId::Dracula,
        ThemeId::Everforest,
        ThemeId::Nord,
        ThemeId::CatppuccinLatte,
    ];
    let mut revision = 0;
    for id in ids {
        let committed = manager.commit(id, revision).unwrap();
        revision += 1;
        assert_eq!(committed.revision(), revision);
        let reloaded = ThemeStateManager::load(&path);
        assert_eq!(reloaded.current().theme_id(), id);
        assert_eq!(reloaded.current().revision(), 0);
    }
    let root: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(root.get("revision").is_none());
    assert_eq!(root["selected_theme"], "catppuccin-latte");
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn theme_commit_preserves_unknown_and_malformed_siblings() {
    let directory = temp_dir("siblings");
    let path = state_path(&directory);
    fs::write(
        &path,
        br#"{"future":{"keep":true},"recent_files":{},"selected_theme":"dracula"}"#,
    )
    .unwrap();
    let manager = ThemeStateManager::load(&path);
    assert_eq!(manager.current().theme_id(), ThemeId::Dracula);
    manager.commit(ThemeId::Nord, 0).unwrap();
    let root: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(root["future"]["keep"], true);
    assert!(root["recent_files"].is_object());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn stale_revision_preserves_current_and_durable_state() {
    let directory = temp_dir("stale");
    let path = state_path(&directory);
    let manager = ThemeStateManager::load(&path);
    let committed = manager.commit(ThemeId::Dracula, 0).unwrap();
    let durable_before = fs::read(&path).unwrap();
    assert_eq!(
        manager.commit(ThemeId::Everforest, 0),
        Err(ThemeStateError::Conflict)
    );
    assert_eq!(manager.current(), committed);
    assert_eq!(fs::read(&path).unwrap(), durable_before);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn concurrent_commits_serialize_to_one_winner() {
    let directory = temp_dir("concurrent");
    let manager = ThemeStateManager::load(state_path(&directory));
    let barrier = Arc::new(Barrier::new(3));
    let left = {
        let manager = manager.clone();
        let barrier = barrier.clone();
        thread::spawn(move || {
            barrier.wait();
            manager.commit(ThemeId::Dracula, 0)
        })
    };
    let right = {
        let manager = manager.clone();
        let barrier = barrier.clone();
        thread::spawn(move || {
            barrier.wait();
            manager.commit(ThemeId::Everforest, 0)
        })
    };
    barrier.wait();
    let results = [left.join().unwrap(), right.join().unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, &&Err(ThemeStateError::Conflict)))
            .count(),
        1
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_root_is_reported_once_and_recovers_on_explicit_commit() {
    let directory = temp_dir("invalid");
    let path = state_path(&directory);
    fs::write(&path, b"[]").unwrap();
    let manager = ThemeStateManager::load(&path);
    assert!(manager.take_startup_recovery_needed());
    assert!(!manager.take_startup_recovery_needed());
    manager.commit(ThemeId::Dracula, 0).unwrap();
    assert_eq!(
        ThemeStateManager::load(&path).current().theme_id(),
        ThemeId::Dracula
    );
    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn persistence_failure_keeps_the_previous_durable_theme() {
    let directory = temp_dir("storage-failure");
    let blocked_parent = directory.join("not-a-directory");
    fs::write(&blocked_parent, b"block").unwrap();
    let manager = ThemeStateManager::load(blocked_parent.join("state.json"));
    let previous = manager.current();

    assert_eq!(
        manager.commit(ThemeId::Nord, previous.revision()),
        Err(ThemeStateError::Storage)
    );
    assert_eq!(manager.current(), previous);
    assert!(!blocked_parent.join("state.json").exists());
    fs::remove_dir_all(directory).unwrap();
}

#[path = "../src/theme_state.rs"]
mod theme_state;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::thread;
use theme_state::{ThemeId, ThemeStateError, ThemeStateManager};

fn temp_dir(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "modeleaf-cp5-theme-{label}-{}",
        rand::random::<u64>()
    ));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn state_path(directory: &Path) -> PathBuf {
    directory.join("theme-state.json")
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
fn valid_state_and_every_exact_theme_id_round_trip() {
    let directory = temp_dir("themes");
    let path = state_path(&directory);
    fs::write(
        &path,
        r#"{"schemaVersion":1,"themeId":"dracula","revision":7}"#,
    )
    .unwrap();
    let manager = ThemeStateManager::load(&path);
    assert_eq!(manager.current().theme_id(), ThemeId::Dracula);
    assert_eq!(manager.current().revision(), 7);

    let ids = [
        ThemeId::TokyoNight,
        ThemeId::GruvboxDark,
        ThemeId::SolarizedDark,
        ThemeId::Dracula,
        ThemeId::Everforest,
        ThemeId::CatppuccinLatte,
    ];
    let mut revision = 7;
    for id in ids {
        revision += 1;
        let committed = manager.commit(id, revision - 1).unwrap();
        assert_eq!(committed.theme_id(), id);
        assert_eq!(committed.revision(), revision);
        let reloaded = ThemeStateManager::load(&path);
        assert_eq!(reloaded.current(), committed);
    }

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn stale_revision_preserves_current_state() {
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
    let left_manager = manager.clone();
    let left_barrier = barrier.clone();
    let left = thread::spawn(move || {
        left_barrier.wait();
        left_manager.commit(ThemeId::Dracula, 0)
    });
    let right_manager = manager.clone();
    let right_barrier = barrier.clone();
    let right = thread::spawn(move || {
        right_barrier.wait();
        right_manager.commit(ThemeId::Everforest, 0)
    });
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
    assert_eq!(manager.current().revision(), 1);

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn write_failure_does_not_mutate_current_state() {
    let directory = temp_dir("write-failure");
    let path = state_path(&directory);
    fs::create_dir(&path).unwrap();
    let manager = ThemeStateManager::load(&path);
    let before = manager.current();

    assert_eq!(
        manager.commit(ThemeId::Dracula, 0),
        Err(ThemeStateError::Storage)
    );
    assert_eq!(manager.current(), before);
    assert!(path.is_dir());

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn revisions_above_javascript_safe_integer_are_quarantined() {
    const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
    let directory = temp_dir("unsafe-revision");
    let path = state_path(&directory);
    let bytes = format!(
        r#"{{"schemaVersion":1,"themeId":"dracula","revision":{}}}"#,
        MAX_SAFE_REVISION + 1
    );
    fs::write(&path, bytes.as_bytes()).unwrap();

    let manager = ThemeStateManager::load(&path);
    assert_eq!(manager.current().theme_id(), ThemeId::TokyoNight);
    assert_eq!(manager.current().revision(), 0);
    assert!(manager.take_startup_recovery_needed());
    assert_eq!(
        fs::read(directory.join("theme-state.quarantine.json")).unwrap(),
        bytes.as_bytes()
    );
    assert!(!path.exists());

    fs::write(
        &path,
        format!(r#"{{"schemaVersion":1,"themeId":"dracula","revision":{MAX_SAFE_REVISION}}}"#),
    )
    .unwrap();
    let boundary = ThemeStateManager::load(&path);
    assert_eq!(boundary.current().revision(), MAX_SAFE_REVISION);
    assert_eq!(
        boundary.commit(ThemeId::Everforest, MAX_SAFE_REVISION),
        Err(ThemeStateError::Storage)
    );

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn malformed_unknown_and_oversize_states_are_quarantined_and_defaulted() {
    let cases = [
        ("malformed", b"{not-json".to_vec()),
        (
            "unknown",
            br#"{"schemaVersion":1,"themeId":"untrusted","revision":1}"#.to_vec(),
        ),
        ("oversize", vec![b'x'; 1025]),
    ];
    for (label, bytes) in cases {
        let directory = temp_dir(label);
        let path = state_path(&directory);
        let quarantine = directory.join("theme-state.quarantine.json");
        fs::write(&path, &bytes).unwrap();

        let manager = ThemeStateManager::load(&path);
        assert_eq!(manager.current().theme_id(), ThemeId::TokyoNight);
        assert_eq!(manager.current().revision(), 0);
        assert!(manager.take_startup_recovery_needed());
        assert!(!manager.take_startup_recovery_needed());
        assert_eq!(fs::read(&quarantine).unwrap(), bytes);
        assert!(!path.exists());

        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn interrupted_temp_is_removed_without_changing_valid_current_state() {
    let directory = temp_dir("interrupted-temp");
    let path = state_path(&directory);
    let durable = r#"{"schemaVersion":1,"themeId":"solarized-dark","revision":4}"#;
    fs::write(&path, durable).unwrap();
    let interrupted = directory.join(".theme-state-interrupted.tmp");
    fs::write(&interrupted, b"partial").unwrap();

    let manager = ThemeStateManager::load(&path);
    assert_eq!(manager.current().theme_id(), ThemeId::SolarizedDark);
    assert_eq!(manager.current().revision(), 4);
    assert_eq!(fs::read_to_string(&path).unwrap(), durable);
    assert!(!interrupted.exists());

    fs::remove_dir_all(directory).unwrap();
}

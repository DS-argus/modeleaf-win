use modeleaf_lib::commands::state::{RecentFile, StateFileStore};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

const CHILD_KIND: &str = "MODELEAF_W04_STATE_CHILD";
const RECENT_PATH: &str = "C:/문서/concurrent.pdf";
const RECENT_TIMESTAMP: &str = "1700000000";

#[test]
fn cross_process_state_helper() {
    let Ok(kind) = std::env::var(CHILD_KIND) else {
        return;
    };
    let state = PathBuf::from(std::env::var_os("MODELEAF_W04_STATE_PATH").unwrap());
    let barrier = PathBuf::from(std::env::var_os("MODELEAF_W04_STATE_BARRIER").unwrap());
    while !barrier.exists() {
        thread::sleep(Duration::from_millis(5));
    }
    let store = StateFileStore::new(state);
    match kind.as_str() {
        "theme" => store.set_selected_theme("nord".into()).unwrap(),
        "recent" => store
            .record_recent_success(RecentFile {
                absolute_path: RECENT_PATH.into(),
                last_opened_at: RECENT_TIMESTAMP.into(),
            })
            .unwrap(),
        _ => panic!("unknown child kind"),
    }
}

#[test]
fn separate_processes_preserve_independently_updated_fields() {
    let directory = std::env::temp_dir().join(format!(
        "modeleaf-w04-process-동시성-{:032x}",
        rand::random::<u128>()
    ));
    fs::create_dir_all(&directory).unwrap();
    let state = directory.join(format!("{}-state.json", "긴".repeat(20)));
    let barrier = directory.join("barrier");
    fs::write(
        &state,
        br##"{"future":{"keep":true},"link_destination_indicator":{"style":"diamond-pulse","color":"purple","size":31.5,"duration_ms":1700}}"##,
    )
    .unwrap();

    let mut theme = child("theme", &state, &barrier);
    let mut recent = child("recent", &state, &barrier);
    fs::write(&barrier, b"go").unwrap();
    assert!(theme.wait().unwrap().success());
    assert!(recent.wait().unwrap().success());

    let snapshot = StateFileStore::new(state.clone()).load().unwrap();
    assert_eq!(snapshot.selected_theme.as_deref(), Some("nord"));
    assert_eq!(
        snapshot.recent_files,
        vec![RecentFile {
            absolute_path: RECENT_PATH.into(),
            last_opened_at: RECENT_TIMESTAMP.into(),
        }]
    );
    let root: serde_json::Value = serde_json::from_slice(&fs::read(state).unwrap()).unwrap();
    assert_eq!(root["future"]["keep"], true);
    assert_eq!(
        root["link_destination_indicator"],
        serde_json::json!({
            "style": "diamond-pulse",
            "color": "purple",
            "size": 31.5,
            "duration_ms": 1700,
        })
    );
    fs::remove_dir_all(directory).unwrap();
}

fn child(kind: &str, state: &Path, barrier: &Path) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "cross_process_state_helper", "--nocapture"])
        .env(CHILD_KIND, kind)
        .env("MODELEAF_W04_STATE_PATH", state)
        .env("MODELEAF_W04_STATE_BARRIER", barrier)
        .spawn()
        .unwrap()
}

use modeleaf_lib::commands::state::{
    LinkDestinationIndicator, LinkDestinationIndicatorStyle, StateFileStore,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

const CHILD_KIND: &str = "MODELEAF_W04_STATE_CHILD";

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
        "indicator" => store
            .set_link_destination_indicator(LinkDestinationIndicator {
                style: LinkDestinationIndicatorStyle::DiamondPulse,
                color: "purple".into(),
                size: 31.5,
                duration_ms: 1700,
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
    let mut theme = child("theme", &state, &barrier);
    let mut indicator = child("indicator", &state, &barrier);
    fs::write(&barrier, b"go").unwrap();
    assert!(theme.wait().unwrap().success());
    assert!(indicator.wait().unwrap().success());
    let snapshot = StateFileStore::new(state).load().unwrap();
    assert_eq!(snapshot.selected_theme.as_deref(), Some("nord"));
    assert_eq!(snapshot.link_destination_indicator.unwrap().size, 31.5);
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

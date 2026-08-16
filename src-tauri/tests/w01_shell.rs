use modeleaf_lib::generate_reader_window_label;
use modeleaf_lib::workspace::{WorkspaceError, WorkspaceManager, MAX_WINDOWS};
use std::collections::HashSet;

#[test]
fn reader_window_labels_are_unique_lowercase_hex_tokens() {
    let labels: Vec<_> = (0..1_024).map(|_| generate_reader_window_label()).collect();
    let unique: HashSet<_> = labels.iter().collect();

    assert_eq!(unique.len(), labels.len());
    for label in labels {
        assert_eq!(label.len(), "reader-".len() + 32);
        assert!(label.starts_with("reader-"));
        assert!(label["reader-".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }
}

#[test]
fn destroyed_window_reclaims_capacity_and_issues_a_new_owner_generation() {
    let workspace = WorkspaceManager::new();
    let owners: Vec<_> = (0..MAX_WINDOWS)
        .map(|index| workspace.claim_window(&format!("reader-{index}")))
        .collect::<Result<_, _>>()
        .unwrap();

    assert_eq!(
        workspace.claim_window("reader-over-capacity"),
        Err(WorkspaceError::WindowCapacity)
    );

    let reclaimed_label = owners[0].window_label.clone();
    let prior_generation = owners[0].generation;
    workspace.destroy_window(&owners[0]).unwrap();
    assert!(workspace.active_owner(&reclaimed_label).is_none());

    let replacement = workspace.claim_window(&reclaimed_label).unwrap();
    assert_eq!(replacement.window_label, reclaimed_label);
    assert_ne!(replacement.generation, prior_generation);
    assert_eq!(workspace.budget().windows, MAX_WINDOWS);
}

#[test]
fn failed_window_construction_rollback_releases_the_claimed_owner() {
    let workspace = WorkspaceManager::new();
    let owner = workspace
        .claim_window("reader-construction-failure")
        .unwrap();

    workspace.destroy_window(&owner).unwrap();

    assert!(workspace.active_owner(&owner.window_label).is_none());
    assert_eq!(workspace.budget().windows, 0);
    let replacement = workspace.claim_window(&owner.window_label).unwrap();
    assert_ne!(replacement.generation, owner.generation);
}

use modeleaf_lib::pdf_session::{PdfOwner, SessionId};
use modeleaf_lib::workspace::{WorkspaceError, WorkspaceManager, MAX_DESTROYED_WINDOWS};

#[test]
fn destroyed_window_records_are_fifo_bounded_and_retain_recent_idempotence() {
    let workspace = WorkspaceManager::new();
    let mut destroyed = Vec::new();
    for index in 0..=MAX_DESTROYED_WINDOWS {
        let owner = workspace.claim_window(&format!("churn-{index}")).unwrap();
        workspace.destroy_window(&owner).unwrap();
        destroyed.push(owner);
    }

    assert_eq!(
        workspace.destroy_window(&destroyed[0]),
        Err(WorkspaceError::WindowNotFound)
    );
    assert_eq!(workspace.destroy_window(&destroyed[1]), Ok(()));
    assert_eq!(workspace.destroy_window(destroyed.last().unwrap()), Ok(()));
    assert_eq!(workspace.budget().windows, 0);
    assert_eq!(workspace.budget().sessions, 0);
}

fn session(number: u8) -> SessionId {
    SessionId::from_opaque(format!("{:064x}", number)).unwrap()
}

#[test]
fn four_sessions_per_window_fill_the_aggregate_budget_and_ninth_is_denied() {
    let workspace = WorkspaceManager::new();
    let a = workspace.claim_window("A").unwrap();
    let b = workspace.claim_window("B").unwrap();

    for number in 0..4 {
        workspace.admit_session(&a, session(number)).unwrap();
        workspace.admit_session(&b, session(number + 4)).unwrap();
    }

    assert_eq!(workspace.budget().windows, 2);
    assert_eq!(workspace.budget().sessions, 8);
    assert_eq!(
        workspace.admit_session(&a, session(8)),
        Err(WorkspaceError::SessionCapacity)
    );
    assert_eq!(workspace.budget().sessions, 8);
}

#[test]
fn four_windows_can_be_claimed_and_a_fifth_is_denied_without_mutation() {
    let workspace = WorkspaceManager::new();
    for label in ["A", "B", "C", "D"] {
        workspace.claim_window(label).unwrap();
    }

    assert_eq!(workspace.budget().windows, 4);
    assert_eq!(
        workspace.claim_window("E"),
        Err(WorkspaceError::WindowCapacity)
    );
    assert_eq!(workspace.budget().windows, 4);
    assert_eq!(workspace.budget().sessions, 0);
}

#[test]
fn releasing_a_session_admits_exactly_one_replacement() {
    let workspace = WorkspaceManager::new();
    let owner = workspace.claim_window("A").unwrap();
    for number in 0..8 {
        workspace.admit_session(&owner, session(number)).unwrap();
    }

    workspace.release_session(&owner, &session(3)).unwrap();
    workspace.admit_session(&owner, session(8)).unwrap();
    assert_eq!(workspace.budget().sessions, 8);
    assert_eq!(
        workspace.admit_session(&owner, session(9)),
        Err(WorkspaceError::SessionCapacity)
    );
}

#[test]
fn wrong_owner_cannot_release_or_change_the_budget() {
    let workspace = WorkspaceManager::new();
    let a = workspace.claim_window("A").unwrap();
    let b = workspace.claim_window("B").unwrap();
    let id = session(1);
    workspace.admit_session(&a, id.clone()).unwrap();

    assert_eq!(
        workspace.release_session(&b, &id),
        Err(WorkspaceError::OwnerMismatch)
    );
    assert_eq!(workspace.budget().sessions, 1);
}

#[test]
fn destroying_a_drains_only_a_and_is_idempotent() {
    let workspace = WorkspaceManager::new();
    let a = workspace.claim_window("A").unwrap();
    let b = workspace.claim_window("B").unwrap();
    let a_session = session(1);
    let b_session = session(2);
    workspace.admit_session(&a, a_session.clone()).unwrap();
    workspace.admit_session(&b, b_session.clone()).unwrap();

    workspace.destroy_window(&a).unwrap();
    workspace.destroy_window(&a).unwrap();
    assert_eq!(workspace.budget().windows, 1);
    assert_eq!(workspace.budget().sessions, 1);
    assert_eq!(workspace.release_session(&b, &b_session), Ok(()));
    assert_eq!(workspace.release_session(&a, &a_session), Ok(()));
}

#[test]
fn wrong_generation_cannot_destroy_an_owner() {
    let workspace = WorkspaceManager::new();
    let owner = workspace.claim_window("A").unwrap();
    let wrong_generation = PdfOwner {
        generation: owner.generation + 1,
        ..owner.clone()
    };
    assert_eq!(
        workspace.destroy_window(&wrong_generation),
        Err(WorkspaceError::GenerationMismatch)
    );
    assert_eq!(workspace.budget().windows, 1);
}

#[test]
fn late_release_for_the_destroyed_owner_is_terminal_but_wrong_generation_is_denied() {
    let workspace = WorkspaceManager::new();
    let owner = workspace.claim_window("A").unwrap();
    let id = session(9);
    workspace.admit_session(&owner, id.clone()).unwrap();
    workspace.destroy_window(&owner).unwrap();

    assert_eq!(workspace.release_session(&owner, &id), Ok(()));
    let wrong_generation = PdfOwner {
        generation: owner.generation + 1,
        ..owner
    };
    assert_eq!(
        workspace.release_session(&wrong_generation, &id),
        Err(WorkspaceError::GenerationMismatch)
    );
}

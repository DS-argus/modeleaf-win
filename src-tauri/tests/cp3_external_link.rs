use modeleaf_lib::external_link::{
    open_external_link_with, validate_external_link, ExternalLinkError,
};
use modeleaf_lib::pdf_session::{
    ExternalLinkActivationOperation, ExternalLinkRegistration, PdfOwner, PdfSessionManager,
};
use std::io::Write;

#[test]
fn allows_http_https_and_mailto_targets() {
    for target in [
        "http://example.com/path?query=value#fragment",
        "HTTPS://example.com/%E2%9C%93?q=%C3%A9",
        "mailto:reader@example.com?subject=PDF%20question",
        "mailto:reader%40example.com",
    ] {
        assert_eq!(validate_external_link(target), Ok(()), "{target}");
    }
}

#[test]
fn rejected_targets_never_reach_the_launcher() {
    let oversized = format!("https://example.com/{}", "a".repeat(8_192));
    let rejected = [
        "javascript:alert(1)",
        "file:///C:/document.pdf",
        "data:text/plain,hello",
        "relative/path",
        "https://reader:secret@example.com/",
        "https://@example.com/",
        "http:a:b@www.example.com",
        "https:reader:secret@example.com",
        "https://example.com/\u{0000}",
        "mailto:reader@example.com?subject=hello\r\nBcc:other@example.com",
        "mailto:reader@example.com?subject=hello%0d%0aBcc:other@example.com",
        "mailto:?subject=missing-address",
        "mailto://?subject=missing-address",
        "mailto:////?subject=missing-address",
        "mailto:reader",
        "mailto:@example.com",
        "mailto:reader@",
        "mailto:reader%20name@example.com",
        "mailto:reader%09name@example.com",
        "mailto:reader%00@example.com",
        "mailto:reader%1f@example.com",
        "mailto:reader@example%0d.com",
        "mailto:%2f",
        "mailto:%2F%2F",
        "mailto:reader%ZZ@example.com",
        "mailto:reader%FF@example.com",
        "https://[not-an-ipv6-address]/",
        &oversized,
    ];

    for target in rejected {
        let mut launches = 0;
        let result = open_external_link_with(target, |_| {
            launches += 1;
            Ok::<(), ()>(())
        });
        assert_eq!(result, Err(ExternalLinkError::LinkRejected), "{target:?}");
        assert_eq!(launches, 0, "{target:?}");
    }
}

#[test]
fn allowed_unicode_and_percent_encoded_target_is_launched_once_unchanged() {
    let target = "https://example.com/caf%C3%A9/日本語?label=%E2%9C%93";
    let mut launched = Vec::new();

    let result = open_external_link_with(target, |received| {
        launched.push(received.to_owned());
        Ok::<(), ()>(())
    });

    assert_eq!(result, Ok(()));
    assert_eq!(launched, vec![target]);
}

#[test]
fn external_link_registry_transaction_preserves_active_resolution() {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-transaction-{}.pdf",
        rand::random::<u64>()
    ));
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(b"%PDF-test").unwrap();
    drop(file);

    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "cp3".into(),
        generation: 1,
    };
    let session = manager.open_local_file(owner.clone(), &path).unwrap();
    let links = |annotation_id: &str, target: &str| {
        vec![ExternalLinkRegistration {
            annotation_id: annotation_id.into(),
            target: target.into(),
        }]
    };

    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            links("old", "https://example.com/old"),
        )
        .unwrap();
    assert_eq!(
        manager.resolve_external_link(
            &owner,
            &session.session_id,
            session.document_generation,
            "old",
        ),
        Err(ExternalLinkError::AnnotationNotFound)
    );
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();

    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            2,
            links("new", "https://example.com/new"),
        )
        .unwrap();
    assert_eq!(
        manager.prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            3,
            vec![],
        ),
        Err(ExternalLinkError::StaleRegistration)
    );
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    for (annotation_id, target) in [
        ("old", "https://example.com/old"),
        ("new", "https://example.com/new"),
    ] {
        assert_eq!(
            manager.resolve_external_link(
                &owner,
                &session.session_id,
                session.document_generation,
                annotation_id,
            ),
            Ok(target.into())
        );
    }
    manager
        .abort_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    assert_eq!(
        manager.resolve_external_link(
            &owner,
            &session.session_id,
            session.document_generation,
            "old",
        ),
        Ok("https://example.com/old".into())
    );
    assert_eq!(
        manager.finalize_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            2
        ),
        Err(ExternalLinkError::StaleRegistration)
    );

    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            2,
            links("final", "https://example.com/final"),
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    assert_eq!(
        manager.abort_external_links(&owner, &session.session_id, session.document_generation, 2),
        Ok(())
    );
    assert_eq!(
        manager.resolve_external_link(
            &owner,
            &session.session_id,
            session.document_generation,
            "final",
        ),
        Ok("https://example.com/final".into())
    );
    assert_eq!(
        manager.resolve_external_link(
            &owner,
            &session.session_id,
            session.document_generation,
            "old",
        ),
        Err(ExternalLinkError::AnnotationNotFound)
    );

    manager.drain_all();
    std::fs::remove_file(path).unwrap();
}
#[test]
fn outcome_unknown_prepare_abort_handles_installed_and_absent_future_revisions() {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-outcome-unknown-{}.pdf",
        rand::random::<u64>()
    ));
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(b"%PDF-test").unwrap();
    drop(file);

    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "outcome-unknown".into(),
        generation: 1,
    };
    let session = manager.open_local_file(owner.clone(), &path).unwrap();
    let link = |annotation_id: &str, target: &str| {
        vec![ExternalLinkRegistration {
            annotation_id: annotation_id.into(),
            target: target.into(),
        }]
    };

    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            link("old", "https://example.com/old"),
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();

    assert_eq!(
        manager.abort_external_links(&owner, &session.session_id, session.document_generation, 0),
        Err(ExternalLinkError::StaleRegistration)
    );

    // Native prepare installed revision 2, but the caller lost its response.
    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            2,
            link("discarded", "https://example.com/discarded"),
        )
        .unwrap();
    assert_eq!(
        manager.abort_external_links(&owner, &session.session_id, session.document_generation, 1),
        Err(ExternalLinkError::StaleRegistration)
    );
    assert_eq!(
        manager.abort_external_links(&owner, &session.session_id, session.document_generation, 3),
        Err(ExternalLinkError::StaleRegistration)
    );
    manager
        .abort_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    manager
        .abort_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    assert_eq!(
        manager.resolve_external_link(
            &owner,
            &session.session_id,
            session.document_generation,
            "old",
        ),
        Ok("https://example.com/old".into())
    );

    // A successful re-prepare proves the installed transaction was removed exactly once.
    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            2,
            link("current", "https://example.com/current"),
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();

    // Native prepare for revision 3 made no mutation; an absent future abort is accepted.
    manager
        .abort_external_links(&owner, &session.session_id, session.document_generation, 3)
        .unwrap();
    manager
        .abort_external_links(&owner, &session.session_id, session.document_generation, 3)
        .unwrap();
    assert_eq!(
        manager.abort_external_links(&owner, &session.session_id, session.document_generation, 1),
        Err(ExternalLinkError::StaleRegistration)
    );
    assert_eq!(
        manager.resolve_external_link(
            &owner,
            &session.session_id,
            session.document_generation,
            "current",
        ),
        Ok("https://example.com/current".into())
    );

    manager.drain_all();
    std::fs::remove_file(path).unwrap();
}
#[test]
fn stale_prepare_after_commit_preserves_revisions_and_transaction_controls() {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-stale-prepare-{}.pdf",
        rand::random::<u64>()
    ));
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(b"%PDF-test").unwrap();
    drop(file);

    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "stale-prepare".into(),
        generation: 1,
    };
    let session = manager.open_local_file(owner.clone(), &path).unwrap();
    let link = |annotation_id: &str, target: &str| {
        vec![ExternalLinkRegistration {
            annotation_id: annotation_id.into(),
            target: target.into(),
        }]
    };

    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            link("old", "https://example.com/old"),
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();

    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            2,
            link("new", "https://example.com/new"),
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();

    for revision in [1, 2] {
        assert_eq!(
            manager.prepare_external_links(
                &owner,
                &session.session_id,
                session.document_generation,
                revision,
                vec![],
            ),
            Err(ExternalLinkError::StaleRegistration)
        );
    }

    let mut current_target = None;
    manager
        .activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation,
            2,
            "new",
            |target| {
                current_target = Some(target.to_owned());
                Ok::<(), ()>(())
            },
        )
        .unwrap();
    assert_eq!(current_target.as_deref(), Some("https://example.com/new"));

    let mut previous_target = None;
    manager
        .activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            "old",
            |target| {
                previous_target = Some(target.to_owned());
                Ok::<(), ()>(())
            },
        )
        .unwrap();
    assert_eq!(previous_target.as_deref(), Some("https://example.com/old"));

    manager
        .abort_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    assert_eq!(
        manager.resolve_external_link(
            &owner,
            &session.session_id,
            session.document_generation,
            "old",
        ),
        Ok("https://example.com/old".into())
    );
    assert_eq!(
        manager.finalize_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            2
        ),
        Err(ExternalLinkError::StaleRegistration)
    );

    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            2,
            link("new", "https://example.com/new"),
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    assert_eq!(
        manager.prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            vec![],
        ),
        Err(ExternalLinkError::StaleRegistration)
    );
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 2)
        .unwrap();
    assert_eq!(
        manager.resolve_external_link(
            &owner,
            &session.session_id,
            session.document_generation,
            "new",
        ),
        Ok("https://example.com/new".into())
    );
    manager.drain_all();
    std::fs::remove_file(path).unwrap();
}
#[test]
fn launcher_failures_have_a_stable_non_target_tag() {
    let result = open_external_link_with("https://example.com/", |_| Err::<(), _>(()));

    assert_eq!(result, Err(ExternalLinkError::LinkLaunchFailed));
}
#[test]
fn production_activation_validates_identity_revision_errors_and_releases_its_lease() {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-activate-{}.pdf",
        rand::random::<u64>()
    ));
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(b"%PDF-test").unwrap();
    drop(file);
    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "activation".into(),
        generation: 7,
    };
    let session = manager.open_local_file(owner.clone(), &path).unwrap();
    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            vec![ExternalLinkRegistration {
                annotation_id: "link".into(),
                target: "https://example.com/".into(),
            }],
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();

    assert_eq!(
        manager.activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            "link",
            |_| Ok::<(), ()>(())
        ),
        Ok(())
    );
    assert_eq!(
        manager.activate_external_link_with(
            &PdfOwner {
                window_label: "other".into(),
                generation: 7
            },
            &session.session_id,
            session.document_generation,
            1,
            "link",
            |_| Ok::<(), ()>(())
        ),
        Err(ExternalLinkError::OwnerMismatch)
    );
    assert_eq!(
        manager.activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation + 1,
            1,
            "link",
            |_| Ok::<(), ()>(())
        ),
        Err(ExternalLinkError::GenerationMismatch)
    );
    assert_eq!(
        manager.activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation,
            2,
            "link",
            |_| Ok::<(), ()>(())
        ),
        Err(ExternalLinkError::StaleRegistration)
    );
    assert_eq!(
        manager.activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            "\n",
            |_| Ok::<(), ()>(())
        ),
        Err(ExternalLinkError::LinkRejected)
    );
    assert_eq!(
        manager.activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            "link",
            |_| Err::<(), _>(())
        ),
        Err(ExternalLinkError::LinkLaunchFailed)
    );
    assert_eq!(
        manager.activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            "link",
            |_| Err::<(), _>(ExternalLinkError::LinkLaunchTimeout)
        ),
        Err(ExternalLinkError::LinkLaunchTimeout)
    );
    assert_eq!(
        manager.activate_external_link_with(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            "link",
            |_| Ok::<(), ()>(())
        ),
        Ok(())
    );
    manager.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn activation_operation_ids_deduplicate_and_panic_does_not_hold_the_session() {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-operation-{}.pdf",
        rand::random::<u64>()
    ));
    std::fs::write(&path, b"%PDF-test").unwrap();
    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "operation".into(),
        generation: 1,
    };
    let session = manager.open_local_file(owner.clone(), &path).unwrap();
    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            vec![ExternalLinkRegistration {
                annotation_id: "link".into(),
                target: "https://example.com/".into(),
            }],
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();

    let mut launches = 0;
    for _ in 0..2 {
        manager
            .activate_external_link_with_operation(
                &owner,
                &session.session_id,
                session.document_generation,
                ExternalLinkActivationOperation::new(1, "link", "unique-operation", 1),
                |_| {
                    launches += 1;
                    Ok::<(), ()>(())
                },
            )
            .unwrap();
    }
    assert_eq!(launches, 1);

    let mut timeout_launches = 0;
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "timeout-operation", 2),
            |_| {
                timeout_launches += 1;
                Err::<(), _>(ExternalLinkError::LinkLaunchTimeout)
            }
        ),
        Err(ExternalLinkError::LinkLaunchTimeout)
    );
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "timeout-operation", 2),
            |_| {
                timeout_launches += 1;
                Ok::<(), ()>(())
            }
        ),
        Err(ExternalLinkError::LinkLaunchTimeout)
    );
    assert_eq!(timeout_launches, 1);

    let mut expired_launches = 0;
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "dispatch-expired", 3),
            |_| {
                expired_launches += 1;
                Err::<(), _>(ExternalLinkError::LinkDispatchExpired)
            }
        ),
        Err(ExternalLinkError::LinkDispatchExpired)
    );
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "dispatch-expired", 3),
            |_| {
                expired_launches += 1;
                Ok::<(), ()>(())
            }
        ),
        Err(ExternalLinkError::LinkDispatchExpired)
    );
    assert_eq!(expired_launches, 1);

    let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "panic-operation", 4),
            |_| -> Result<(), ()> { panic!("injected launcher panic") },
        )
    }));
    assert!(panic_result.is_err());

    let (entered_sender, entered_receiver) = std::sync::mpsc::sync_channel(1);
    let (release_sender, release_receiver) = std::sync::mpsc::sync_channel(1);
    let held_manager = manager.clone();
    let held_owner = owner.clone();
    let held_session = session.session_id.clone();
    let held_generation = session.document_generation;
    let held = std::thread::spawn(move || {
        held_manager.activate_external_link_with_operation(
            &held_owner,
            &held_session,
            held_generation,
            ExternalLinkActivationOperation::new(1, "link", "held-operation", 5),
            |_| {
                entered_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
                Ok::<(), ()>(())
            },
        )
    });
    entered_receiver.recv().unwrap();
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "held-operation", 5),
            |_| Ok::<(), ()>(())
        ),
        Err(ExternalLinkError::LinkOperationInProgress)
    );
    release_sender.send(()).unwrap();
    held.join().unwrap().unwrap();
    let barrier = manager
        .cancel(&owner, &session.session_id, session.document_generation)
        .unwrap();
    manager
        .close(
            &owner,
            &session.session_id,
            session.document_generation,
            barrier.barrier_id,
        )
        .unwrap();
    assert!(manager.assert_empty());
    std::fs::remove_file(path).unwrap();
}
#[test]

fn lifecycle_drain_timeout_defers_cleanup_until_external_admissions_release() {
    for panic_launch in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "modeleaf-external-link-deferred-drain-{}-{}.pdf",
            panic_launch,
            rand::random::<u64>()
        ));
        std::fs::write(&path, b"%PDF-test").unwrap();
        let manager = PdfSessionManager::new();
        let owner = PdfOwner {
            window_label: format!("deferred-drain-{panic_launch}"),
            generation: 1,
        };
        let session = manager.open_local_file(owner.clone(), &path).unwrap();
        manager
            .prepare_external_links(
                &owner,
                &session.session_id,
                session.document_generation,
                1,
                vec![ExternalLinkRegistration {
                    annotation_id: "link".into(),
                    target: "https://example.com/".into(),
                }],
            )
            .unwrap();
        manager
            .commit_external_links(&owner, &session.session_id, session.document_generation, 1)
            .unwrap();
        manager
            .finalize_external_links(&owner, &session.session_id, session.document_generation, 1)
            .unwrap();

        let (entered_sender, entered_receiver) = std::sync::mpsc::sync_channel(1);
        let (release_sender, release_receiver) = std::sync::mpsc::sync_channel(1);
        let held_manager = manager.clone();
        let held_owner = owner.clone();
        let held_session = session.session_id.clone();
        let generation = session.document_generation;
        let held = std::thread::spawn(move || {
            held_manager.activate_external_link_with_operation(
                &held_owner,
                &held_session,
                generation,
                ExternalLinkActivationOperation::new(1, "link", "gated-lifecycle-drain", 1),
                |_| {
                    entered_sender.send(()).unwrap();
                    release_receiver.recv().unwrap();
                    if panic_launch {
                        panic!("injected launcher panic");
                    }
                    Ok::<(), ()>(())
                },
            )
        });
        entered_receiver.recv().unwrap();

        manager.drain_owner_with_timeout_for_test(&owner.window_label, std::time::Duration::ZERO);
        assert!(!manager.assert_empty());
        assert_eq!(
            manager.activate_external_link_with_operation(
                &owner,
                &session.session_id,
                session.document_generation,
                ExternalLinkActivationOperation::new(1, "link", "after-lifecycle-timeout", 2),
                |_| Ok::<(), ()>(())
            ),
            Err(ExternalLinkError::SessionClosing)
        );

        release_sender.send(()).unwrap();
        if panic_launch {
            assert!(held.join().is_err());
        } else {
            held.join().unwrap().unwrap();
        }
        assert!(manager.assert_empty());
        std::fs::remove_file(path).unwrap();
    }
}
#[test]
fn closed_session_tombstones_do_not_limit_sequential_documents() {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-close-cycles-{}.pdf",
        rand::random::<u64>()
    ));
    std::fs::write(&path, b"%PDF-test").unwrap();
    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "close-cycles".into(),
        generation: 1,
    };

    for _ in 0..65 {
        let session = manager.open_local_file(owner.clone(), &path).unwrap();
        let barrier = manager
            .cancel(&owner, &session.session_id, session.document_generation)
            .unwrap();
        manager
            .close(
                &owner,
                &session.session_id,
                session.document_generation,
                barrier.barrier_id,
            )
            .unwrap();
    }

    std::fs::remove_file(path).unwrap();
}

#[test]
fn activation_operation_ids_roll_forward_without_relaunching_recent_retries() {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-operation-window-{}.pdf",
        rand::random::<u64>()
    ));
    std::fs::write(&path, b"%PDF-test").unwrap();
    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "operation-window".into(),
        generation: 1,
    };
    let session = manager.open_local_file(owner.clone(), &path).unwrap();
    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            vec![ExternalLinkRegistration {
                annotation_id: "link".into(),
                target: "https://example.com/".into(),
            }],
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();

    let mut launches = 0;
    for index in 0..257 {
        manager
            .activate_external_link_with_operation(
                &owner,
                &session.session_id,
                session.document_generation,
                ExternalLinkActivationOperation::new(
                    1,
                    "link",
                    &format!("operation-{index}"),
                    index + 1,
                ),
                |_| {
                    launches += 1;
                    Ok::<(), ()>(())
                },
            )
            .unwrap();
    }
    manager
        .activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "operation-256", 257),
            |_| {
                launches += 1;
                Ok::<(), ()>(())
            },
        )
        .unwrap();

    assert_eq!(launches, 257);
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "operation-0", 1),
            |_| {
                launches += 1;
                Ok::<(), ()>(())
            }
        ),
        Err(ExternalLinkError::LinkOperationExpired)
    );
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "different", 257),
            |_| {
                launches += 1;
                Ok::<(), ()>(())
            }
        ),
        Err(ExternalLinkError::LinkOperationMismatch)
    );
    assert_eq!(launches, 257);
    manager.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn external_link_permits_recover_after_all_terminal_outcomes() {
    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-permits-{}.pdf",
        rand::random::<u64>()
    ));
    std::fs::write(&path, b"%PDF-test").unwrap();
    let manager = PdfSessionManager::new();
    let owner = PdfOwner {
        window_label: "permit-recovery".into(),
        generation: 1,
    };
    let session = manager.open_local_file(owner.clone(), &path).unwrap();
    manager
        .prepare_external_links(
            &owner,
            &session.session_id,
            session.document_generation,
            1,
            vec![ExternalLinkRegistration {
                annotation_id: "link".into(),
                target: "https://example.com/".into(),
            }],
        )
        .unwrap();
    manager
        .commit_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();
    manager
        .finalize_external_links(&owner, &session.session_id, session.document_generation, 1)
        .unwrap();

    for (sequence, outcome) in [(1, 0), (2, 1), (3, 2)] {
        let result = manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(
                1,
                "link",
                &format!("terminal-{sequence}"),
                sequence,
            ),
            |_| match outcome {
                0 => Ok::<(), ExternalLinkError>(()),
                1 => Err(ExternalLinkError::LinkLaunchFailed),
                _ => Err(ExternalLinkError::LinkLaunchTimeout),
            },
        );
        assert_eq!(
            result,
            match outcome {
                0 => Ok(()),
                1 => Err(ExternalLinkError::LinkLaunchFailed),
                _ => Err(ExternalLinkError::LinkLaunchTimeout),
            }
        );
    }
    for (sequence, expected) in [
        (1, Ok(())),
        (2, Err(ExternalLinkError::LinkLaunchFailed)),
        (3, Err(ExternalLinkError::LinkLaunchTimeout)),
    ] {
        assert_eq!(
            manager.activate_external_link_with_operation(
                &owner,
                &session.session_id,
                session.document_generation,
                ExternalLinkActivationOperation::new(
                    1,
                    "link",
                    &format!("terminal-{sequence}"),
                    sequence
                ),
                |_| -> Result<(), ()> { panic!("terminal replay relaunched") }
            ),
            expected,
        );
    }
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "dispatch-terminal", 4),
            |_| Err::<(), _>(ExternalLinkError::LinkDispatchExpired)
        ),
        Err(ExternalLinkError::LinkDispatchExpired),
    );
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "dispatch-terminal", 4),
            |_| -> Result<(), ()> { panic!("dispatch replay relaunched") }
        ),
        Err(ExternalLinkError::LinkDispatchExpired),
    );
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "terminal-panic", 5),
            |_| -> Result<(), ()> { panic!("injected launcher panic") },
        )
    }));
    assert!(panic.is_err());
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "after-terminal-outcomes", 6),
            |_| Ok::<(), ()>(())
        ),
        Ok(())
    );
    manager.drain_all();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn external_link_capacity_is_bounded_per_session_and_process() {
    use std::sync::mpsc;
    use std::sync::{Arc, Barrier};

    let path = std::env::temp_dir().join(format!(
        "modeleaf-external-link-capacity-{}.pdf",
        rand::random::<u64>()
    ));
    std::fs::write(&path, b"%PDF-test").unwrap();
    let manager = PdfSessionManager::new();
    let install = |owner: &PdfOwner| {
        let session = manager.open_local_file(owner.clone(), &path).unwrap();
        manager
            .prepare_external_links(
                owner,
                &session.session_id,
                session.document_generation,
                1,
                vec![ExternalLinkRegistration {
                    annotation_id: "link".into(),
                    target: "https://example.com/".into(),
                }],
            )
            .unwrap();
        manager
            .commit_external_links(owner, &session.session_id, session.document_generation, 1)
            .unwrap();
        manager
            .finalize_external_links(owner, &session.session_id, session.document_generation, 1)
            .unwrap();
        session
    };
    let owner = PdfOwner {
        window_label: "per-session".into(),
        generation: 1,
    };
    let session = install(&owner);
    let entered = Arc::new(Barrier::new(3));
    let release = Arc::new(Barrier::new(3));
    let (ready_sender, ready_receiver) = mpsc::sync_channel(2);
    let mut held = Vec::new();
    for sequence in 1..=2 {
        let manager = manager.clone();
        let owner = owner.clone();
        let id = session.session_id.clone();
        let entered = entered.clone();
        let release = release.clone();
        let ready = ready_sender.clone();
        held.push(std::thread::spawn(move || {
            manager.activate_external_link_with_operation(
                &owner,
                &id,
                session.document_generation,
                ExternalLinkActivationOperation::new(
                    1,
                    "link",
                    &format!("session-{sequence}"),
                    sequence,
                ),
                |_| {
                    ready.send(()).unwrap();
                    entered.wait();
                    release.wait();
                    Ok::<(), ()>(())
                },
            )
        }));
        ready_receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }
    entered.wait();
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "session-excess", 3),
            |_| Ok::<(), ()>(())
        ),
        Err(ExternalLinkError::LinkCapacity)
    );
    release.wait();
    for held in held {
        assert_eq!(held.join().unwrap(), Ok(()));
    }
    assert_eq!(
        manager.activate_external_link_with_operation(
            &owner,
            &session.session_id,
            session.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "session-recovered", 4),
            |_| Ok::<(), ()>(())
        ),
        Ok(())
    );

    let process_entered = Arc::new(Barrier::new(5));
    let process_release = Arc::new(Barrier::new(5));
    let (process_ready_sender, process_ready_receiver) = mpsc::sync_channel(4);
    let mut process_held = Vec::new();
    for index in 0..4 {
        let owner = PdfOwner {
            window_label: format!("process-{index}"),
            generation: 1,
        };
        let session = install(&owner);
        let manager = manager.clone();
        let entered = process_entered.clone();
        let release = process_release.clone();
        let ready = process_ready_sender.clone();
        process_held.push(std::thread::spawn(move || {
            manager.activate_external_link_with_operation(
                &owner,
                &session.session_id,
                session.document_generation,
                ExternalLinkActivationOperation::new(1, "link", "held", 1),
                |_| {
                    ready.send(()).unwrap();
                    entered.wait();
                    release.wait();
                    Ok::<(), ()>(())
                },
            )
        }));
    }
    for _ in 0..4 {
        process_ready_receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }
    process_entered.wait();
    let excess_owner = PdfOwner {
        window_label: "process-excess".into(),
        generation: 1,
    };
    let excess = install(&excess_owner);
    assert_eq!(
        manager.activate_external_link_with_operation(
            &excess_owner,
            &excess.session_id,
            excess.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "process-excess", 1),
            |_| Ok::<(), ()>(())
        ),
        Err(ExternalLinkError::LinkCapacity)
    );
    process_release.wait();
    for held in process_held {
        assert_eq!(held.join().unwrap(), Ok(()));
    }
    assert_eq!(
        manager.activate_external_link_with_operation(
            &excess_owner,
            &excess.session_id,
            excess.document_generation,
            ExternalLinkActivationOperation::new(1, "link", "process-recovered", 2),
            |_| Ok::<(), ()>(())
        ),
        Ok(())
    );
    manager.drain_all();
    std::fs::remove_file(path).unwrap();
}

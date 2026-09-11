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

#[test]
fn native_pdf_dialog_rejects_invalid_owner_handles() {
    use modeleaf_lib::open_dialog::{choose_pdf_file, PdfDialogError};

    assert_eq!(choose_pdf_file(0), Err(PdfDialogError::OwnerUnavailable));
    #[cfg(windows)]
    assert_eq!(
        choose_pdf_file(isize::MAX),
        Err(PdfDialogError::OwnerUnavailable)
    );
}

#[test]
fn pdf_dialog_relay_runs_picker_after_scheduling_callback_returns() {
    use modeleaf_lib::open_dialog::{
        dispatch_pdf_dialog, PostedDialogCompletion, PostedDialogPicker,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    type QueuedDialog = (PostedDialogPicker, PostedDialogCompletion);

    let caller_thread = std::thread::current().id();
    let callback_returned = Arc::new(AtomicBool::new(false));
    let picker_saw_returned_callback = Arc::new(AtomicBool::new(false));
    let queued: Arc<Mutex<Option<QueuedDialog>>> = Arc::new(Mutex::new(None));
    let dispatch_thread = Arc::new(Mutex::new(None));
    let picker_thread = Arc::new(Mutex::new(None));

    let callback_returned_for_dispatch = callback_returned.clone();
    let callback_returned_for_schedule = callback_returned.clone();
    let callback_returned_for_picker = callback_returned.clone();
    let picker_saw_returned_callback_for_picker = picker_saw_returned_callback.clone();
    let queued_for_dispatch = queued.clone();
    let queued_for_schedule = queued.clone();
    let dispatch_thread_for_task = dispatch_thread.clone();
    let picker_thread_for_picker = picker_thread.clone();

    let outcome = tauri::async_runtime::block_on(dispatch_pdf_dialog(
        move |task| {
            std::thread::Builder::new()
                .name("test-dialog-ui-thread".into())
                .spawn(move || {
                    *dispatch_thread_for_task.lock().unwrap() = Some(std::thread::current().id());
                    task();
                    callback_returned_for_dispatch.store(true, Ordering::SeqCst);
                    let (picker, completion) = queued_for_dispatch.lock().unwrap().take().unwrap();
                    completion(picker(1));
                })
                .map_err(|_| ())?
                .join()
                .map_err(|_| ())?;
            Ok::<(), ()>(())
        },
        move |picker, completion| {
            assert!(!callback_returned_for_schedule.load(Ordering::SeqCst));
            let mut queued = queued_for_schedule.lock().unwrap();
            assert!(queued.is_none());
            *queued = Some((picker, completion));
            Ok::<(), ()>(())
        },
        move |_| {
            picker_saw_returned_callback_for_picker.store(
                callback_returned_for_picker.load(Ordering::SeqCst),
                Ordering::SeqCst,
            );
            *picker_thread_for_picker.lock().unwrap() = Some(std::thread::current().id());
            Ok(None)
        },
    ));

    assert_eq!(outcome, Ok(Ok(None)));
    assert!(picker_saw_returned_callback.load(Ordering::SeqCst));
    let dispatch_thread = dispatch_thread.lock().unwrap().unwrap();
    let picker_thread = picker_thread.lock().unwrap().unwrap();
    assert_eq!(picker_thread, dispatch_thread);
    assert_ne!(picker_thread, caller_thread);
}

#[test]
fn native_pdf_dialog_dispatch_preserves_select_cancel_and_picker_failure() {
    use modeleaf_lib::open_dialog::{dispatch_pdf_dialog, PdfDialogError};

    let selected = tauri::async_runtime::block_on(dispatch_pdf_dialog(
        |task| {
            task();
            Ok::<(), ()>(())
        },
        |picker, completion| {
            completion(picker(1));
            Ok::<(), ()>(())
        },
        |_| Ok(Some(std::path::PathBuf::from("selected.pdf"))),
    ));
    assert_eq!(
        selected,
        Ok(Ok(Some(std::path::PathBuf::from("selected.pdf"))))
    );

    let cancelled = tauri::async_runtime::block_on(dispatch_pdf_dialog(
        |task| {
            task();
            Ok::<(), ()>(())
        },
        |picker, completion| {
            completion(picker(1));
            Ok::<(), ()>(())
        },
        |_| Ok(None),
    ));
    assert_eq!(cancelled, Ok(Ok(None)));

    let failed = tauri::async_runtime::block_on(dispatch_pdf_dialog(
        |task| {
            task();
            Ok::<(), ()>(())
        },
        |picker, completion| {
            completion(picker(1));
            Ok::<(), ()>(())
        },
        |_| Err(PdfDialogError::PickerFailed),
    ));
    assert_eq!(failed, Ok(Err(PdfDialogError::PickerFailed)));
}

#[test]
fn native_pdf_dialog_dispatch_setup_and_dropped_work_are_terminal() {
    use modeleaf_lib::open_dialog::{dispatch_pdf_dialog, PdfDialogDispatchError};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let picker_called = Arc::new(AtomicBool::new(false));
    let picker_called_after_failure = picker_called.clone();
    let dispatch_failed = tauri::async_runtime::block_on(dispatch_pdf_dialog(
        |task| {
            drop(task);
            Err(())
        },
        |_, _| Ok::<(), ()>(()),
        move |_| {
            picker_called_after_failure.store(true, Ordering::SeqCst);
            Ok(None)
        },
    ));
    assert_eq!(dispatch_failed, Err(PdfDialogDispatchError::DispatchFailed));
    assert!(!picker_called.load(Ordering::SeqCst));

    let setup_failed = tauri::async_runtime::block_on(dispatch_pdf_dialog(
        |task| {
            task();
            Ok::<(), ()>(())
        },
        |picker, completion| {
            drop(picker);
            drop(completion);
            Err(())
        },
        |_| Ok(None),
    ));
    assert_eq!(setup_failed, Err(PdfDialogDispatchError::DispatchFailed));

    let task_dropped = tauri::async_runtime::block_on(dispatch_pdf_dialog(
        |task| {
            drop(task);
            Ok::<(), ()>(())
        },
        |_, _| Ok::<(), ()>(()),
        |_| Ok(None),
    ));
    assert_eq!(task_dropped, Err(PdfDialogDispatchError::ResultDropped));

    let posted_work_dropped = tauri::async_runtime::block_on(dispatch_pdf_dialog(
        |task| {
            task();
            Ok::<(), ()>(())
        },
        |picker, completion| {
            drop(picker);
            drop(completion);
            Ok::<(), ()>(())
        },
        |_| Ok(None),
    ));
    assert_eq!(
        posted_work_dropped,
        Err(PdfDialogDispatchError::ResultDropped)
    );
}

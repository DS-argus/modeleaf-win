use modeleaf_lib::local_path::{DriveKind, FinalHandlePolicy, LocalPathPolicy, PathPolicyError};
use modeleaf_lib::open_dialog::open_selected_path;
use modeleaf_lib::pdf_session::{PdfOwner, PdfSessionError, PdfSessionManager};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

struct Policy(DriveKind);
impl LocalPathPolicy for Policy {
    fn classify(&self, _: &Path) -> Result<DriveKind, PathPolicyError> {
        Ok(self.0)
    }
}

struct PreopenUnprovable;
impl LocalPathPolicy for PreopenUnprovable {
    fn classify(&self, _: &Path) -> Result<DriveKind, PathPolicyError> {
        Ok(DriveKind::Fixed)
    }

    fn validate_preopen(&self, _: &Path) -> Result<(), PathPolicyError> {
        Err(PathPolicyError::RemotePath)
    }
}

struct Final(DriveKind);
impl FinalHandlePolicy for Final {
    fn classify_final(&self, _: &File) -> Result<DriveKind, PathPolicyError> {
        Ok(self.0)
    }
}

fn owner() -> PdfOwner {
    PdfOwner {
        window_label: "reader".into(),
        generation: 7,
    }
}

fn fixture() -> PathBuf {
    let path = std::env::temp_dir().join(format!("modeleaf-cp1-{}.pdf", rand::random::<u64>()));
    let mut file = File::create(&path).unwrap();
    file.write_all(b"%PDF-1.7").unwrap();
    path
}

#[test]
fn cancel_returns_no_metadata_and_preserves_current_session() {
    let file = fixture();
    let manager = PdfSessionManager::new();
    let current = manager
        .open_local(
            owner(),
            Path::new(r"C:\current.pdf"),
            &Policy(DriveKind::Fixed),
            &Final(DriveKind::Fixed),
            |_| File::open(&file),
        )
        .unwrap();

    assert_eq!(open_selected_path(&manager, owner(), None).unwrap(), None);
    assert_eq!(
        manager
            .read_range(
                &owner(),
                &current.session_id,
                current.document_generation,
                0,
                5
            )
            .unwrap(),
        b"%PDF-"
    );

    let barrier = manager
        .cancel(&owner(), &current.session_id, current.document_generation)
        .unwrap();
    manager
        .close(
            &owner(),
            &current.session_id,
            current.document_generation,
            barrier.barrier_id,
        )
        .unwrap();
    assert!(manager.assert_empty());
    fs::remove_file(file).unwrap();
}

#[test]
fn opening_rejects_network_like_candidates_before_retaining_a_session() {
    let file = fixture();
    let manager = PdfSessionManager::new();
    assert_eq!(
        manager.open_local(
            owner(),
            Path::new(r"Z:\network.pdf"),
            &Policy(DriveKind::Remote),
            &Final(DriveKind::Fixed),
            |_| File::open(&file),
        ),
        Err(PdfSessionError::RemotePath)
    );
    assert!(manager.assert_empty());

    let final_remote = PdfSessionManager::new();
    assert_eq!(
        final_remote.open_local(
            owner(),
            Path::new(r"C:\reparse.pdf"),
            &Policy(DriveKind::Fixed),
            &Final(DriveKind::Remote),
            |_| File::open(&file),
        ),
        Err(PdfSessionError::RemotePath)
    );
    assert!(final_remote.assert_empty());
    fs::remove_file(file).unwrap();
}

#[test]
fn reparse_like_input_is_rejected_before_the_opener_runs() {
    let manager = PdfSessionManager::new();
    let mut opener_calls = 0;
    let result = manager.open_local(
        owner(),
        Path::new(r"C:\reparse.pdf"),
        &PreopenUnprovable,
        &Final(DriveKind::Fixed),
        |_| {
            opener_calls += 1;
            Err(std::io::Error::other("must not open"))
        },
    );

    assert_eq!(result, Err(PdfSessionError::RemotePath));
    assert_eq!(opener_calls, 0);
    assert!(manager.assert_empty());
}

#[test]
fn response_exposes_only_opaque_metadata_and_a_leaf_display_name() {
    let file = fixture();
    let manager = PdfSessionManager::new();
    let response = open_selected_path(&manager, owner(), Some(&file))
        .unwrap()
        .unwrap();

    assert_eq!(
        response.display_name,
        file.file_name().unwrap().to_string_lossy().as_ref()
    );
    assert!(!response.display_name.contains('\\'));
    assert!(!response.display_name.contains('/'));
    assert_eq!(response.length, 8);
    let wrong_owner = PdfOwner {
        window_label: "other".into(),
        generation: 7,
    };
    assert_eq!(
        manager.cancel(
            &wrong_owner,
            &response.session_id,
            response.document_generation
        ),
        Err(PdfSessionError::OwnerMismatch)
    );

    manager.drain_owner("reader");
    assert!(manager.assert_empty());
    fs::remove_file(file).unwrap();
}

#[test]
fn missing_file_is_distinct_from_unreadable_without_retaining_a_session() {
    let manager = PdfSessionManager::new();
    let result = manager.open_local(
        owner(),
        Path::new(r"C:\missing.pdf"),
        &Policy(DriveKind::Fixed),
        &Final(DriveKind::Fixed),
        |_| Err(std::io::Error::new(std::io::ErrorKind::NotFound, "missing")),
    );
    assert_eq!(result, Err(PdfSessionError::MissingFile));
    assert!(manager.assert_empty());
}

#[test]
fn long_unicode_path_keeps_the_source_bytes_unchanged_through_read_and_close() {
    let source = fixture();
    let before = fs::read(&source).unwrap();
    let input = PathBuf::from(r"C:\문서").join(format!("{}.pdf", "긴이름".repeat(90)));
    let manager = PdfSessionManager::new();
    let metadata = manager
        .open_local(
            owner(),
            &input,
            &Policy(DriveKind::Fixed),
            &Final(DriveKind::Fixed),
            |_| File::open(&source),
        )
        .unwrap();
    assert_eq!(
        manager
            .read_range(
                &owner(),
                &metadata.session_id,
                metadata.document_generation,
                0,
                5
            )
            .unwrap(),
        b"%PDF-"
    );
    let barrier = manager
        .cancel(&owner(), &metadata.session_id, metadata.document_generation)
        .unwrap();
    manager
        .close(
            &owner(),
            &metadata.session_id,
            metadata.document_generation,
            barrier.barrier_id,
        )
        .unwrap();
    assert_eq!(fs::read(&source).unwrap(), before);
    assert!(manager.assert_empty());
    fs::remove_file(source).unwrap();
}

#[test]
fn valid_pdf_content_opens_without_a_pdf_filename_extension() {
    let source = fixture();
    let manager = PdfSessionManager::new();
    let metadata = manager
        .open_local(
            owner(),
            Path::new(r"C:\document.bin"),
            &Policy(DriveKind::Fixed),
            &Final(DriveKind::Fixed),
            |_| File::open(&source),
        )
        .unwrap();
    let barrier = manager
        .cancel(&owner(), &metadata.session_id, metadata.document_generation)
        .unwrap();
    manager
        .close(
            &owner(),
            &metadata.session_id,
            metadata.document_generation,
            barrier.barrier_id,
        )
        .unwrap();
    assert!(manager.assert_empty());
    fs::remove_file(source).unwrap();
}

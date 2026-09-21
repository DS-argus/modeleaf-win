use modeleaf_lib::local_path::{
    classify_with_root_resolver, confirmed_local_missing, DriveKind, DriveTypeClassifier,
    FinalHandlePolicy, LocalPathPolicy, PathPolicyError, VolumeRootResolver,
};
use modeleaf_lib::pdf_session::{
    PdfOwner, PdfSessionError, PdfSessionManager, MAX_DOCUMENT_BYTES, MAX_SESSIONS,
    NORMAL_RANGE_LIMIT,
};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

struct Policy(DriveKind);
impl LocalPathPolicy for Policy {
    fn classify(&self, _: &Path) -> Result<DriveKind, PathPolicyError> {
        Ok(self.0)
    }
}
struct Final(Result<DriveKind, PathPolicyError>);
impl FinalHandlePolicy for Final {
    fn classify_final(&self, _: &File) -> Result<DriveKind, PathPolicyError> {
        self.0
    }
}
struct Root(&'static str);
impl VolumeRootResolver for Root {
    fn volume_root(&self, _: &Path) -> Result<PathBuf, PathPolicyError> {
        Ok(PathBuf::from(self.0))
    }
}
struct Classifier {
    outcome: Result<DriveKind, PathPolicyError>,
    root: Mutex<Option<PathBuf>>,
}
impl DriveTypeClassifier for Classifier {
    fn classify_root(&self, root: &Path) -> Result<DriveKind, PathPolicyError> {
        *self.root.lock().unwrap() = Some(root.to_path_buf());
        self.outcome
    }
}
fn classifier(outcome: Result<DriveKind, PathPolicyError>) -> Classifier {
    Classifier {
        outcome,
        root: Mutex::new(None),
    }
}
fn owner() -> PdfOwner {
    PdfOwner {
        window_label: "reader".into(),
        generation: 1,
    }
}
fn fixture() -> PathBuf {
    let path = std::env::temp_dir().join(format!("modeleaf-{}.pdf", rand::random::<u64>()));
    let mut file = File::create(&path).unwrap();
    file.write_all(b"%PDF-data").unwrap();
    path
}
fn open(manager: &PdfSessionManager, file: &Path) -> modeleaf_lib::pdf_session::PdfSessionMetadata {
    manager
        .open_local(
            owner(),
            Path::new(r"C:\file.pdf"),
            &Policy(DriveKind::Fixed),
            &Final(Ok(DriveKind::Fixed)),
            |_| File::open(file),
        )
        .unwrap()
}

#[test]
fn tags_are_uppercase_and_ranges_are_checked() {
    assert_eq!(PdfSessionError::RangeInvalid.tag(), "RANGE_INVALID");
    let file = fixture();
    let manager = PdfSessionManager::new();
    let metadata = open(&manager, &file);
    assert_eq!(
        manager.read_range(
            &owner(),
            &metadata.session_id,
            metadata.document_generation,
            u64::MAX,
            1
        ),
        Err(PdfSessionError::RangeInvalid)
    );
    assert_eq!(
        manager.read_range(
            &owner(),
            &metadata.session_id,
            metadata.document_generation,
            0,
            NORMAL_RANGE_LIMIT + 1
        ),
        Err(PdfSessionError::RangeCapacity)
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
    assert!(manager.assert_empty());
    fs::remove_file(file).unwrap();
}

#[test]
fn simulated_final_handle_remote_is_admitted_without_session_leak() {
    let file = fixture();
    let manager = PdfSessionManager::new();
    let metadata = manager
        .open_local(
            owner(),
            Path::new(r"Z:\file.pdf"),
            &Policy(DriveKind::Remote),
            &Final(Ok(DriveKind::Remote)),
            |_| File::open(&file),
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
    fs::remove_file(file).unwrap();
}

#[test]
fn preopen_rejection_does_not_call_opener_and_capacity_recovers() {
    let manager = PdfSessionManager::new();
    let called = AtomicBool::new(false);
    struct Reject;
    impl LocalPathPolicy for Reject {
        fn classify(&self, _: &Path) -> Result<DriveKind, PathPolicyError> {
            Err(PathPolicyError::PathRejected)
        }
    }
    assert_eq!(
        manager.open_local(
            owner(),
            Path::new(r"C:\file.pdf"),
            &Reject,
            &Final(Ok(DriveKind::Fixed)),
            |_| {
                called.store(true, Ordering::SeqCst);
                File::open("missing")
            }
        ),
        Err(PdfSessionError::PathRejected)
    );
    assert!(!called.load(Ordering::SeqCst));
    let file = fixture();
    for _ in 0..MAX_SESSIONS {
        open(&manager, &file);
    }
    assert_eq!(
        manager.open_local(
            owner(),
            Path::new(r"C:\file.pdf"),
            &Policy(DriveKind::Fixed),
            &Final(Ok(DriveKind::Fixed)),
            |_| File::open(&file)
        ),
        Err(PdfSessionError::SessionCapacity)
    );
    fs::remove_file(file).unwrap();
}

#[cfg(windows)]
#[test]
fn confirmed_local_missing_is_conservative_without_network_io() {
    let missing = std::env::temp_dir().join(format!(
        "modeleaf-cp0-missing-{}.pdf",
        rand::random::<u64>()
    ));
    assert!(confirmed_local_missing(&missing));
    assert!(!confirmed_local_missing(Path::new(
        r"\\server\share\missing.pdf"
    )));
    assert!(!confirmed_local_missing(Path::new(r"\\server")));
    assert!(!confirmed_local_missing(Path::new(
        r"C:\missing:stream.pdf"
    )));
}

#[test]
fn volume_roots_and_size_are_fail_closed() {
    let fixed = classifier(Ok(DriveKind::Fixed));
    assert_eq!(
        classify_with_root_resolver(Path::new(r"C:\mapped.pdf"), &Root("VOLUME_FIXED"), &fixed),
        Ok(DriveKind::Fixed)
    );
    assert_eq!(
        fixed.root.lock().unwrap().as_deref(),
        Some(Path::new("VOLUME_FIXED"))
    );
    assert_eq!(
        classify_with_root_resolver(
            Path::new(r"R:\mapped.pdf"),
            &Root("VOLUME_REMOVABLE"),
            &classifier(Ok(DriveKind::Removable))
        ),
        Ok(DriveKind::Removable)
    );
    assert_eq!(
        classify_with_root_resolver(
            Path::new(r"Z:\mapped.pdf"),
            &Root("VOLUME_REMOTE"),
            &classifier(Ok(DriveKind::Remote))
        ),
        Ok(DriveKind::Remote)
    );
    assert_eq!(
        classify_with_root_resolver(
            Path::new(r"X:\unknown.pdf"),
            &Root("VOLUME_UNKNOWN"),
            &classifier(Err(PathPolicyError::PathRejected))
        ),
        Err(PathPolicyError::PathRejected)
    );
    assert_eq!(
        classify_with_root_resolver(
            Path::new(r"\\server\share\mapped.pdf"),
            &Root("VOLUME_REMOTE"),
            &classifier(Ok(DriveKind::Remote))
        ),
        Ok(DriveKind::Remote)
    );
    for path in [
        Path::new(r"\\pipe\share\mapped.pdf"),
        Path::new(r"\\device\share\mapped.pdf"),
    ] {
        assert_eq!(
            classify_with_root_resolver(
                path,
                &Root("VOLUME_REMOTE"),
                &classifier(Ok(DriveKind::Remote))
            ),
            Ok(DriveKind::Remote),
            "{path:?}"
        );
    }
    for path in [
        Path::new(r"\\server"),
        Path::new(r"\\server\pipe\name.pdf"),
        Path::new(r"\\server\IPC$\name.pdf"),
        Path::new(r"\\server\share\file:stream.pdf"),
        Path::new(r"\\.\pipe\name.pdf"),
        Path::new(r"//?/UNC/server/share/file.pdf"),
        Path::new(r"\\?\UNC\server\share\file.pdf"),
        Path::new(r"\\server\.\file.pdf"),
        Path::new(r"C:\file:stream.pdf"),
        Path::new(r"C:\NUL.pdf"),
        Path::new(r"C:\CONIN$.pdf"),
        Path::new(r"C:\CONOUT$.pdf"),
        Path::new(r"C:\COM¹.pdf"),
        Path::new(r"C:\COM².pdf"),
        Path::new(r"C:\COM³.pdf"),
        Path::new(r"C:\LPT¹.pdf"),
        Path::new(r"C:\LPT².pdf"),
        Path::new(r"C:\LPT³.pdf"),
        Path::new("C:\\bad\0name.pdf"),
    ] {
        assert_eq!(
            classify_with_root_resolver(path, &Root("UNUSED"), &classifier(Ok(DriveKind::Remote))),
            Err(PathPolicyError::PathRejected),
            "{path:?}"
        );
    }
    let path = fixture();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_DOCUMENT_BYTES + 1)
        .unwrap();
    let manager = PdfSessionManager::new();
    assert_eq!(
        manager.open_local(
            owner(),
            Path::new(r"C:\file.pdf"),
            &Policy(DriveKind::Fixed),
            &Final(Ok(DriveKind::Fixed)),
            |_| File::open(&path)
        ),
        Err(PdfSessionError::DocumentTooLarge)
    );
    fs::remove_file(path).unwrap();
}

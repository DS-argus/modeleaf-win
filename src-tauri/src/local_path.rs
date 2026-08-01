use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DriveKind {
    Fixed,
    Removable,
    Remote,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PathPolicyError {
    PathRejected,
    RemotePath,
}

pub trait LocalPathPolicy: Send + Sync {
    fn classify(&self, path: &Path) -> Result<DriveKind, PathPolicyError>;
}

/// Resolves an input path to its volume root before drive-type classification.
pub trait VolumeRootResolver: Send + Sync {
    fn volume_root(&self, path: &Path) -> Result<PathBuf, PathPolicyError>;
}

/// Classifies a resolved volume root. Implementations must reject non-local roots.
pub trait DriveTypeClassifier: Send + Sync {
    fn classify_root(&self, root: &Path) -> Result<DriveKind, PathPolicyError>;
}

fn reject_unsafe_input(path: &Path) -> Result<(), PathPolicyError> {
    let text = path.to_string_lossy();
    let lower = text.to_ascii_lowercase();
    if lower.starts_with(r"\\.\")
        || lower.starts_with(r"\\?\")
        || lower.starts_with(r"\\")
        || lower.starts_with("//")
    {
        return Err(PathPolicyError::PathRejected);
    }
    let bytes = text.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || (bytes[2] != b'\\' && bytes[2] != b'/')
        || text[2..].contains(':')
    {
        return Err(PathPolicyError::PathRejected);
    }
    Ok(())
}

pub fn classify_with_root_resolver<R: VolumeRootResolver, C: DriveTypeClassifier>(
    path: &Path,
    resolver: &R,
    classifier: &C,
) -> Result<DriveKind, PathPolicyError> {
    reject_unsafe_input(path)?;
    let root = resolver.volume_root(path)?;
    classifier.classify_root(&root)
}

#[derive(Default)]
pub struct SystemDriveTypeClassifier;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
impl DriveTypeClassifier for SystemDriveTypeClassifier {
    fn classify_root(&self, root: &Path) -> Result<DriveKind, PathPolicyError> {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDriveTypeW;

        let root: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        match unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } {
            2 => Ok(DriveKind::Removable),
            3 => Ok(DriveKind::Fixed),
            4 => Err(PathPolicyError::RemotePath),
            _ => Err(PathPolicyError::PathRejected),
        }
    }
}

#[cfg(not(windows))]
impl DriveTypeClassifier for SystemDriveTypeClassifier {
    fn classify_root(&self, root: &Path) -> Result<DriveKind, PathPolicyError> {
        let text = root.to_string_lossy();
        if text.eq_ignore_ascii_case("REMOTE") {
            Err(PathPolicyError::RemotePath)
        } else if text.eq_ignore_ascii_case("REMOVABLE") {
            Ok(DriveKind::Removable)
        } else if text.eq_ignore_ascii_case("FIXED") {
            Ok(DriveKind::Fixed)
        } else {
            Err(PathPolicyError::PathRejected)
        }
    }
}

#[derive(Default)]
pub struct SystemVolumeRootResolver;

#[cfg(windows)]
impl VolumeRootResolver for SystemVolumeRootResolver {
    fn volume_root(&self, path: &Path) -> Result<PathBuf, PathPolicyError> {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetVolumePathNameW;
        let input: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut root = vec![0_u16; 32768];
        unsafe { GetVolumePathNameW(PCWSTR(input.as_ptr()), &mut root) }
            .map_err(|_| PathPolicyError::PathRejected)?;
        let length = root
            .iter()
            .position(|unit| *unit == 0)
            .ok_or(PathPolicyError::PathRejected)?;
        Ok(PathBuf::from(
            String::from_utf16(&root[..length]).map_err(|_| PathPolicyError::PathRejected)?,
        ))
    }
}

#[cfg(not(windows))]
impl VolumeRootResolver for SystemVolumeRootResolver {
    fn volume_root(&self, _: &Path) -> Result<PathBuf, PathPolicyError> {
        Ok(PathBuf::from("FIXED"))
    }
}

#[derive(Default)]
pub struct SystemLocalPathPolicy;
impl LocalPathPolicy for SystemLocalPathPolicy {
    fn classify(&self, path: &Path) -> Result<DriveKind, PathPolicyError> {
        classify_with_root_resolver(path, &SystemVolumeRootResolver, &SystemDriveTypeClassifier)
    }
}

/// Classifies the final path of an already-open handle. This is required after pre-open policy
/// validation so a local reparse point cannot redirect the retained handle to a remote location.
pub trait FinalHandlePolicy: Send + Sync {
    fn classify_final(&self, file: &std::fs::File) -> Result<DriveKind, PathPolicyError>;
}

#[derive(Default)]
pub struct SystemFinalHandlePolicy;

#[cfg(windows)]
impl FinalHandlePolicy for SystemFinalHandlePolicy {
    fn classify_final(&self, file: &std::fs::File) -> Result<DriveKind, PathPolicyError> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            GetFinalPathNameByHandleW, GETFINALPATHNAMEBYHANDLE_FLAGS,
        };
        let mut buffer = vec![0_u16; 32768];
        let length = unsafe {
            GetFinalPathNameByHandleW(
                HANDLE(file.as_raw_handle()),
                &mut buffer,
                GETFINALPATHNAMEBYHANDLE_FLAGS(0),
            )
        } as usize;
        if length == 0 || length >= buffer.len() {
            return Err(PathPolicyError::PathRejected);
        }
        let final_path =
            String::from_utf16(&buffer[..length]).map_err(|_| PathPolicyError::PathRejected)?;
        let local = final_path
            .strip_prefix(r"\\?\")
            .ok_or(PathPolicyError::PathRejected)?;
        let bytes = local.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || (bytes[2] != b'\\' && bytes[2] != b'/')
        {
            return Err(PathPolicyError::PathRejected);
        }
        SystemLocalPathPolicy.classify(Path::new(local))
    }
}

#[cfg(not(windows))]
impl FinalHandlePolicy for SystemFinalHandlePolicy {
    fn classify_final(&self, _: &std::fs::File) -> Result<DriveKind, PathPolicyError> {
        Ok(DriveKind::Fixed)
    }
}

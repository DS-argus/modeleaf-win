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
    fn validate_preopen(&self, _path: &Path) -> Result<(), PathPolicyError> {
        Ok(())
    }
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
    if lower.starts_with(r"\\.\") || lower.starts_with(r"\\?\") {
        return Err(PathPolicyError::PathRejected);
    }
    if lower.starts_with(r"\\") || lower.starts_with("//") {
        return Err(PathPolicyError::RemotePath);
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

fn classify_input_drive<C: DriveTypeClassifier>(
    path: &Path,
    classifier: &C,
) -> Result<DriveKind, PathPolicyError> {
    reject_unsafe_input(path)?;
    let text = path.to_string_lossy();
    classifier.classify_root(Path::new(&text[..3]))
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

#[cfg(windows)]
fn validate_reparse_components(path: &Path) -> Result<(), PathPolicyError> {
    validate_reparse_components_inner(path, 0)
}

#[cfg(windows)]
fn validate_reparse_components_inner(path: &Path, depth: usize) -> Result<(), PathPolicyError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
    };

    if depth >= 16 {
        return Err(PathPolicyError::PathRejected);
    }
    reject_unsafe_input(path)?;
    let mut components: Vec<&Path> = path
        .ancestors()
        .filter(|ancestor| ancestor.parent().is_some())
        .collect();
    components.reverse();

    for component_path in components {
        let wide: Vec<u16> = component_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let attributes = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            return Err(PathPolicyError::PathRejected);
        }
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            let target =
                read_reparse_target(component_path).map_err(|_| PathPolicyError::RemotePath)?;
            reject_unsafe_input(&target)?;
            match classify_input_drive(&target, &SystemDriveTypeClassifier)? {
                DriveKind::Fixed | DriveKind::Removable => {
                    validate_reparse_components_inner(&target, depth + 1)?;
                }
                DriveKind::Remote => return Err(PathPolicyError::RemotePath),
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn read_reparse_target(path: &Path) -> Result<PathBuf, PathPolicyError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_MODE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, MAXIMUM_REPARSE_DATA_BUFFER_SIZE, OPEN_EXISTING,
    };
    use windows::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT;
    use windows::Win32::System::IO::DeviceIoControl;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let flags =
        FILE_FLAGS_AND_ATTRIBUTES(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0);
    let share = FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_READ_ATTRIBUTES.0,
            share,
            None,
            OPEN_EXISTING,
            flags,
            None,
        )
    }
    .map_err(|_| PathPolicyError::PathRejected)?;

    let mut buffer = vec![0_u8; MAXIMUM_REPARSE_DATA_BUFFER_SIZE as usize];
    let mut returned = 0_u32;
    let result = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_REPARSE_POINT,
            None,
            0,
            Some(buffer.as_mut_ptr().cast()),
            buffer.len() as u32,
            Some(&mut returned),
            None,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.map_err(|_| PathPolicyError::PathRejected)?;
    decode_reparse_target(path, &buffer, returned as usize)
}

#[cfg(windows)]
fn decode_reparse_target(
    path: &Path,
    buffer: &[u8],
    returned: usize,
) -> Result<PathBuf, PathPolicyError> {
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;
    const SYMLINK_FLAG_RELATIVE: u32 = 1;

    if returned < 16 || returned > buffer.len() {
        return Err(PathPolicyError::PathRejected);
    }
    let tag = u32::from_le_bytes(
        buffer[0..4]
            .try_into()
            .map_err(|_| PathPolicyError::PathRejected)?,
    );
    let substitute_offset = u16::from_le_bytes(
        buffer[8..10]
            .try_into()
            .map_err(|_| PathPolicyError::PathRejected)?,
    ) as usize;
    let substitute_length = u16::from_le_bytes(
        buffer[10..12]
            .try_into()
            .map_err(|_| PathPolicyError::PathRejected)?,
    ) as usize;
    let (path_buffer_offset, relative) = match tag {
        IO_REPARSE_TAG_MOUNT_POINT => (16_usize, false),
        IO_REPARSE_TAG_SYMLINK => {
            if returned < 20 {
                return Err(PathPolicyError::PathRejected);
            }
            let flags = u32::from_le_bytes(
                buffer[16..20]
                    .try_into()
                    .map_err(|_| PathPolicyError::PathRejected)?,
            );
            (20_usize, flags & SYMLINK_FLAG_RELATIVE != 0)
        }
        _ => return Err(PathPolicyError::PathRejected),
    };
    if substitute_length == 0 || substitute_length % 2 != 0 {
        return Err(PathPolicyError::PathRejected);
    }
    let start = path_buffer_offset
        .checked_add(substitute_offset)
        .ok_or(PathPolicyError::PathRejected)?;
    let end = start
        .checked_add(substitute_length)
        .ok_or(PathPolicyError::PathRejected)?;
    if end > returned {
        return Err(PathPolicyError::PathRejected);
    }
    let units: Vec<u16> = buffer[start..end]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let substitute = String::from_utf16(&units).map_err(|_| PathPolicyError::PathRejected)?;

    if relative {
        return path
            .parent()
            .map(|parent| parent.join(substitute))
            .ok_or(PathPolicyError::PathRejected);
    }
    if let Some(unc) = substitute.strip_prefix(r"\??\UNC\") {
        return Ok(PathBuf::from(format!(r"\\{unc}")));
    }
    if let Some(local) = substitute
        .strip_prefix(r"\??\")
        .or_else(|| substitute.strip_prefix(r"\\?\"))
    {
        return Ok(PathBuf::from(local));
    }
    Ok(PathBuf::from(substitute))
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

    #[cfg(windows)]
    fn validate_preopen(&self, path: &Path) -> Result<(), PathPolicyError> {
        validate_reparse_components(path)
    }
}

/// Classifies and resolves the final path of an already-open handle. This is required after
/// pre-open policy validation so a local reparse point cannot redirect the retained handle to a
/// remote location.
pub trait FinalHandlePolicy: Send + Sync {
    fn classify_final(&self, file: &std::fs::File) -> Result<DriveKind, PathPolicyError>;

    /// Returns the local canonical identity of the retained handle. Production callers must use
    /// this instead of resolving the mutable input path after opening it.
    fn canonical_path(&self, _: &std::fs::File) -> Result<PathBuf, PathPolicyError> {
        Err(PathPolicyError::PathRejected)
    }
}

#[derive(Default)]
pub struct SystemFinalHandlePolicy;

#[cfg(windows)]
impl FinalHandlePolicy for SystemFinalHandlePolicy {
    fn classify_final(&self, file: &std::fs::File) -> Result<DriveKind, PathPolicyError> {
        let path = self.canonical_path(file)?;
        SystemLocalPathPolicy.classify(&path)
    }

    fn canonical_path(&self, file: &std::fs::File) -> Result<PathBuf, PathPolicyError> {
        final_handle_canonical_path(file)
    }
}

#[cfg(windows)]
fn final_handle_canonical_path(file: &std::fs::File) -> Result<PathBuf, PathPolicyError> {
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
    normalize_final_handle_path(&final_path)
}

#[cfg(windows)]
fn normalize_final_handle_path(final_path: &str) -> Result<PathBuf, PathPolicyError> {
    if final_path.starts_with(r"\\?\UNC\") {
        return Err(PathPolicyError::RemotePath);
    }
    let local = final_path
        .strip_prefix(r"\\?\")
        .ok_or(PathPolicyError::PathRejected)?;
    let path = PathBuf::from(local);
    reject_unsafe_input(&path)?;
    Ok(path)
}

#[cfg(not(windows))]
impl FinalHandlePolicy for SystemFinalHandlePolicy {
    fn classify_final(&self, _: &std::fs::File) -> Result<DriveKind, PathPolicyError> {
        Ok(DriveKind::Fixed)
    }

    fn canonical_path(&self, file: &std::fs::File) -> Result<PathBuf, PathPolicyError> {
        file.metadata().map_err(|_| PathPolicyError::PathRejected)?;
        Err(PathPolicyError::PathRejected)
    }
}
#[cfg(all(test, windows))]
mod reparse_tests {
    use super::*;

    const MOUNT_POINT: u32 = 0xA000_0003;
    const SYMLINK: u32 = 0xA000_000C;

    fn reparse_buffer(tag: u32, target: &str, relative: bool) -> Vec<u8> {
        let path_offset = if tag == SYMLINK { 20 } else { 16 };
        let units: Vec<u16> = target.encode_utf16().collect();
        let data_length = (path_offset + units.len() * 2 - 8) as u16;
        let mut buffer = vec![0_u8; path_offset + units.len() * 2];
        buffer[0..4].copy_from_slice(&tag.to_le_bytes());
        buffer[4..6].copy_from_slice(&data_length.to_le_bytes());
        buffer[10..12].copy_from_slice(&((units.len() * 2) as u16).to_le_bytes());
        if tag == SYMLINK && relative {
            buffer[16..20].copy_from_slice(&1_u32.to_le_bytes());
        }
        for (index, unit) in units.iter().enumerate() {
            let start = path_offset + index * 2;
            buffer[start..start + 2].copy_from_slice(&unit.to_le_bytes());
        }
        buffer
    }

    struct Root;
    impl VolumeRootResolver for Root {
        fn volume_root(&self, _: &Path) -> Result<PathBuf, PathPolicyError> {
            Ok(PathBuf::from(r"C:\"))
        }
    }

    struct Fixed;
    impl DriveTypeClassifier for Fixed {
        fn classify_root(&self, _: &Path) -> Result<DriveKind, PathPolicyError> {
            Ok(DriveKind::Fixed)
        }
    }

    struct Remote;
    impl DriveTypeClassifier for Remote {
        fn classify_root(&self, _: &Path) -> Result<DriveKind, PathPolicyError> {
            Err(PathPolicyError::RemotePath)
        }
    }

    #[test]
    fn proven_local_absolute_and_relative_targets_are_decoded() {
        let absolute = reparse_buffer(SYMLINK, r"\??\C:\local\book.pdf", false);
        let target =
            decode_reparse_target(Path::new(r"C:\links\book.pdf"), &absolute, absolute.len())
                .expect("local target");
        assert_eq!(target, PathBuf::from(r"C:\local\book.pdf"));
        assert_eq!(
            classify_with_root_resolver(&target, &Root, &Fixed),
            Ok(DriveKind::Fixed)
        );
        assert_eq!(classify_input_drive(&target, &Fixed), Ok(DriveKind::Fixed));

        let relative = reparse_buffer(SYMLINK, r"..\local\book.pdf", true);
        assert_eq!(
            decode_reparse_target(Path::new(r"C:\links\book.pdf"), &relative, relative.len()),
            Ok(PathBuf::from(r"C:\links\..\local\book.pdf"))
        );
    }

    #[test]
    fn remote_and_unprovable_targets_fail_closed() {
        let remote = reparse_buffer(MOUNT_POINT, r"\??\UNC\server\share", false);
        let target = decode_reparse_target(Path::new(r"C:\links\remote"), &remote, remote.len())
            .expect("decoded remote target");
        assert_eq!(target, PathBuf::from(r"\\server\share"));
        assert_eq!(
            reject_unsafe_input(&target),
            Err(PathPolicyError::RemotePath)
        );
        assert_eq!(
            classify_input_drive(Path::new(r"Z:\remote.pdf"), &Remote),
            Err(PathPolicyError::RemotePath)
        );

        let unknown = reparse_buffer(0x8000_001B, r"\??\C:\unknown", false);
        assert_eq!(
            decode_reparse_target(Path::new(r"C:\links\unknown"), &unknown, unknown.len()),
            Err(PathPolicyError::PathRejected)
        );
    }
}

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
}

pub trait LocalPathPolicy: Send + Sync {
    fn classify(&self, path: &Path) -> Result<DriveKind, PathPolicyError>;
    fn validate_syntax(&self, _path: &Path) -> Result<(), PathPolicyError> {
        Ok(())
    }
    fn classify_syntax(&self, path: &Path) -> Result<DriveKind, PathPolicyError> {
        self.classify(path)
    }
    fn validate_preopen(&self, _path: &Path) -> Result<(), PathPolicyError> {
        Ok(())
    }
    fn validate_existing_ancestors(&self, path: &Path) -> Result<(), PathPolicyError> {
        self.validate_preopen(path)
    }
}

/// Resolves an input path to its volume root before drive-type classification.
pub trait VolumeRootResolver: Send + Sync {
    fn volume_root(&self, path: &Path) -> Result<PathBuf, PathPolicyError>;
}

/// Classifies a resolved volume root, including remote roots.
pub trait DriveTypeClassifier: Send + Sync {
    fn classify_root(&self, root: &Path) -> Result<DriveKind, PathPolicyError>;
}

fn path_text(path: &Path) -> Result<&str, PathPolicyError> {
    path.to_str().ok_or(PathPolicyError::PathRejected)
}

fn is_separator(character: char) -> bool {
    character == '\\' || character == '/'
}

fn is_unc_path(text: &str) -> bool {
    text.len() >= 2
        && text
            .as_bytes()
            .first()
            .is_some_and(|byte| *byte == b'\\' || *byte == b'/')
        && text
            .as_bytes()
            .get(1)
            .is_some_and(|byte| *byte == b'\\' || *byte == b'/')
}

fn is_device_prefix(text: &str) -> bool {
    let normalized = text.replace('\\', "/").to_ascii_lowercase();
    normalized.starts_with("//./")
        || normalized.starts_with("//?/")
        || normalized.starts_with("/??/")
        || normalized.starts_with("/device/")
        || normalized.starts_with("/globalroot/")
        || normalized.starts_with("/dosdevices/")
}

fn is_reserved_dos_device(component: &str) -> bool {
    let stem = component.split(['.', ' ']).next().unwrap_or(component);
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CONIN$"
            | "CONOUT$"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
            | "CLOCK$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn validate_unc_authority_component(component: &str, share: bool) -> Result<(), PathPolicyError> {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.ends_with('.')
        || component.ends_with(' ')
        || component.chars().any(|character| {
            character.is_control() || matches!(character, ':' | '?' | '*' | '"' | '<' | '>' | '|')
        })
    {
        return Err(PathPolicyError::PathRejected);
    }
    if share
        && matches!(
            component.to_ascii_lowercase().as_str(),
            "pipe" | "ipc$" | "device" | "globalroot" | "dosdevices"
        )
    {
        return Err(PathPolicyError::PathRejected);
    }
    Ok(())
}

fn unc_authority(text: &str) -> Result<(&str, &str), PathPolicyError> {
    let mut components = text[2..].split(is_separator);
    let server = components.next().ok_or(PathPolicyError::PathRejected)?;
    let share = components.next().ok_or(PathPolicyError::PathRejected)?;
    validate_unc_authority_component(server, false)?;
    validate_unc_authority_component(share, true)?;
    Ok((server, share))
}

fn reject_unsafe_input(path: &Path) -> Result<(), PathPolicyError> {
    let text = path_text(path)?;
    if text.contains('\0') || is_device_prefix(text) {
        return Err(PathPolicyError::PathRejected);
    }
    if is_unc_path(text) {
        unc_authority(text)?;
        if text.contains(':') {
            return Err(PathPolicyError::PathRejected);
        }
        return Ok(());
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
    if text[3..].split(is_separator).any(is_reserved_dos_device) {
        return Err(PathPolicyError::PathRejected);
    }
    Ok(())
}

fn unc_volume_root(text: &str) -> Result<PathBuf, PathPolicyError> {
    let (server, share) = unc_authority(text)?;
    Ok(PathBuf::from(format!("\\\\{}\\{}\\", server, share)))
}

fn classify_input_drive<C: DriveTypeClassifier>(
    path: &Path,
    classifier: &C,
) -> Result<DriveKind, PathPolicyError> {
    reject_unsafe_input(path)?;
    let text = path_text(path)?;
    if is_unc_path(text) {
        return classifier.classify_root(&unc_volume_root(text)?);
    }
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
    let origin_kind = classify_input_drive(path, &SystemDriveTypeClassifier)?;
    validate_reparse_components_inner_with_origin(path, 0, false, origin_kind)
}

#[cfg(windows)]
fn validate_reparse_components_inner(
    path: &Path,
    depth: usize,
    allow_missing: bool,
) -> Result<(), PathPolicyError> {
    let origin_kind = classify_input_drive(path, &SystemDriveTypeClassifier)?;
    validate_reparse_components_inner_with_origin(path, depth, allow_missing, origin_kind)
}

#[cfg(windows)]
fn validate_reparse_components_inner_with_origin(
    path: &Path,
    depth: usize,
    allow_missing: bool,
    origin_kind: DriveKind,
) -> Result<(), PathPolicyError> {
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

    for (index, component_path) in components.iter().enumerate() {
        let wide: Vec<u16> = component_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let attributes = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            if allow_missing && index + 1 == components.len() {
                break;
            }
            return Err(PathPolicyError::PathRejected);
        }
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            let target = read_reparse_target(component_path)?;
            reject_unsafe_input(&target)?;
            let target_kind = classify_input_drive(&target, &SystemDriveTypeClassifier)?;
            if target_kind == DriveKind::Remote && origin_kind != DriveKind::Remote {
                return Err(PathPolicyError::PathRejected);
            }
            validate_reparse_components_inner_with_origin(&target, depth + 1, false, origin_kind)?;
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
            4 => Ok(DriveKind::Remote),
            _ => Err(PathPolicyError::PathRejected),
        }
    }
}

#[cfg(not(windows))]
impl DriveTypeClassifier for SystemDriveTypeClassifier {
    fn classify_root(&self, root: &Path) -> Result<DriveKind, PathPolicyError> {
        let text = root.to_string_lossy();
        if text.eq_ignore_ascii_case("REMOTE") {
            Ok(DriveKind::Remote)
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

    fn validate_syntax(&self, path: &Path) -> Result<(), PathPolicyError> {
        reject_unsafe_input(path)
    }

    fn classify_syntax(&self, path: &Path) -> Result<DriveKind, PathPolicyError> {
        classify_input_drive(path, &SystemDriveTypeClassifier)
    }

    #[cfg(windows)]
    fn validate_preopen(&self, path: &Path) -> Result<(), PathPolicyError> {
        validate_reparse_components(path)
    }

    #[cfg(windows)]
    fn validate_existing_ancestors(&self, path: &Path) -> Result<(), PathPolicyError> {
        validate_reparse_components_inner(path, 0, true)
    }
}
#[cfg(windows)]
fn normalize_existing_path(path: &Path) -> Result<PathBuf, PathPolicyError> {
    let text = path_text(path)?;
    if strip_prefix_ascii_case_insensitive(text, r"\\?\").is_some() {
        normalize_final_handle_path(text)
    } else {
        reject_unsafe_input(path)?;
        Ok(path.to_path_buf())
    }
}

#[cfg(windows)]
/// Conservatively confirms that a missing target is local and absent.
///
/// This performs blocking native filesystem checks; callers must invoke it off the event loop.
pub fn confirmed_local_missing(path: &Path) -> bool {
    let text = match path_text(path) {
        Ok(text) => text,
        Err(_) => return false,
    };
    if is_unc_path(text) {
        return false;
    }
    match classify_input_drive(path, &SystemDriveTypeClassifier) {
        Ok(DriveKind::Fixed | DriveKind::Removable) => {}
        Ok(DriveKind::Remote) | Err(_) => return false,
    }
    if validate_reparse_components_inner(path, 0, true).is_err() {
        return false;
    }
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return false,
    };
    let canonical_parent = match std::fs::canonicalize(parent)
        .ok()
        .and_then(|parent| normalize_existing_path(&parent).ok())
    {
        Some(parent) => parent,
        None => return false,
    };
    if !matches!(
        SystemLocalPathPolicy.classify(&canonical_parent),
        Ok(DriveKind::Fixed | DriveKind::Removable)
    ) {
        return false;
    }
    matches!(
        std::fs::metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

#[cfg(not(windows))]
pub fn confirmed_local_missing(_: &Path) -> bool {
    false
}

/// Classifies and resolves the final path of an already-open handle. This is required after
/// pre-open policy validation so a local reparse point cannot redirect the retained handle to a
/// remote location.
pub trait FinalHandlePolicy: Send + Sync {
    fn classify_final(&self, file: &std::fs::File) -> Result<DriveKind, PathPolicyError>;

    /// Returns the canonical identity of the retained handle. Production callers must use
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
fn strip_prefix_ascii_case_insensitive<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|candidate| candidate.eq_ignore_ascii_case(prefix))
        .map(|_| &value[prefix.len()..])
}

#[cfg(windows)]
fn normalize_final_handle_path(final_path: &str) -> Result<PathBuf, PathPolicyError> {
    if let Some(unc) = strip_prefix_ascii_case_insensitive(final_path, r"\\?\UNC\") {
        let path = PathBuf::from(format!(r"\\{unc}"));
        reject_unsafe_input(&path)?;
        return Ok(path);
    }
    let local = strip_prefix_ascii_case_insensitive(final_path, r"\\?\")
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
            Ok(DriveKind::Remote)
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
    fn direct_remote_targets_are_valid_but_unprovable_targets_fail_closed() {
        let remote = reparse_buffer(MOUNT_POINT, r"\??\UNC\server\share", false);
        let target = decode_reparse_target(Path::new(r"C:\links\remote"), &remote, remote.len())
            .expect("decoded remote target");
        assert_eq!(target, PathBuf::from(r"\\server\share"));
        assert_eq!(reject_unsafe_input(&target), Ok(()));
        assert_eq!(
            classify_input_drive(Path::new(r"Z:\remote.pdf"), &Remote),
            Ok(DriveKind::Remote)
        );

        let unknown = reparse_buffer(0x8000_001B, r"\??\C:\unknown", false);
        assert_eq!(
            decode_reparse_target(Path::new(r"C:\links\unknown"), &unknown, unknown.len()),
            Err(PathPolicyError::PathRejected)
        );
    }
    #[test]
    fn retained_unc_paths_are_normalized_without_admitting_devices() {
        assert_eq!(
            normalize_final_handle_path(r"\\?\UNC\server\share\book.pdf"),
            Ok(PathBuf::from(r"\\server\share\book.pdf"))
        );
        assert_eq!(
            normalize_final_handle_path(r"\\?\UNC\server\IPC$\book.pdf"),
            Err(PathPolicyError::PathRejected)
        );
        assert_eq!(
            normalize_final_handle_path(r"\\?\Volume{1234}\book.pdf"),
            Err(PathPolicyError::PathRejected)
        );
    }
}

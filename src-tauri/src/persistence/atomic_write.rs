use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default)]
pub struct AtomicWriteFaults {
    pub fail_before_write: bool,
    pub fail_before_sync: bool,
    pub fail_before_replace: bool,
    pub fail_after_replace: bool,
}

pub fn publish_exclusive(destination: &Path, bytes: &[u8], prefix: &str) -> io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = unique_temp_path(parent, prefix);
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_publish_exclusive(&temporary, destination)
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub fn replace(destination: &Path, bytes: &[u8], prefix: &str) -> io::Result<()> {
    replace_with_faults(destination, bytes, prefix, AtomicWriteFaults::default())
}

pub fn replace_with_faults(
    destination: &Path,
    bytes: &[u8],
    prefix: &str,
    faults: AtomicWriteFaults,
) -> io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = unique_temp_path(parent, prefix);
    let result = (|| {
        if faults.fail_before_write {
            return Err(injected("before write"));
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        if faults.fail_before_sync {
            return Err(injected("before sync"));
        }
        file.sync_all()?;
        drop(file);
        if faults.fail_before_replace {
            return Err(injected("before replace"));
        }
        atomic_replace(&temporary, destination)?;
        if faults.fail_after_replace {
            return Err(injected("after replace"));
        }
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn unique_temp_path(parent: &Path, prefix: &str) -> PathBuf {
    loop {
        let path = parent.join(format!(".{prefix}-{:032x}.tmp", rand::random::<u128>()));
        if !path.exists() {
            return path;
        }
    }
}

fn injected(boundary: &str) -> io::Error {
    io::Error::other(format!("injected fault: {boundary}"))
}

#[cfg(windows)]
fn retry_windows_move(mut operation: impl FnMut() -> windows::core::Result<()>) -> io::Result<()> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match operation() {
            Ok(()) => return Ok(()),
            Err(_) => {
                let error = io::Error::last_os_error();
                if !is_transient_windows_publication_error(&error) || Instant::now() >= deadline {
                    return Err(error);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
#[cfg(windows)]
fn is_transient_windows_publication_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}
#[cfg(windows)]
fn atomic_publish_exclusive(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    retry_windows_move(|| unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    })
}
#[cfg(not(windows))]
fn atomic_publish_exclusive(source: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}
#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    retry_windows_move(|| unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    })
}
#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("modeleaf-atomic-{:032x}", rand::random::<u128>()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn exclusive_publication_never_overwrites_existing_bytes() {
        let directory = directory();
        let destination = directory.join("config.toml");
        publish_exclusive(&destination, b"first", "config").unwrap();
        assert!(publish_exclusive(&destination, b"second", "config").is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"first");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn replacement_is_complete_and_cleans_temporary_files() {
        let directory = directory();
        let destination = directory.join("state.json");
        fs::write(&destination, b"old").unwrap();
        replace(&destination, b"new", "state").unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"new");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pre_replace_fault_retains_original_and_cleans_temporary() {
        let directory = directory();
        let destination = directory.join("state.json");
        fs::write(&destination, b"old").unwrap();
        let faults = AtomicWriteFaults {
            fail_before_replace: true,
            ..Default::default()
        };
        assert!(replace_with_faults(&destination, b"new", "state", faults).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn post_replace_fault_reports_failure_but_committed_bytes_are_recoverable() {
        let directory = directory();
        let destination = directory.join("state.json");
        let faults = AtomicWriteFaults {
            fail_after_replace: true,
            ..Default::default()
        };
        assert!(replace_with_faults(&destination, b"new", "state", faults).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"new");
        fs::remove_dir_all(directory).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn retries_only_known_windows_publication_interference() {
        for code in [5, 32, 33] {
            assert!(is_transient_windows_publication_error(
                &io::Error::from_raw_os_error(code)
            ));
        }
        for code in [2, 3, 87] {
            assert!(!is_transient_windows_publication_error(
                &io::Error::from_raw_os_error(code)
            ));
        }
    }
}

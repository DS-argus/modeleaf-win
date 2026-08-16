use fs2::FileExt;
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum LockError {
    Io(io::Error),
    Timeout,
}
impl std::fmt::Display for LockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "lock I/O failed: {error}"),
            Self::Timeout => formatter.write_str("lock timeout"),
        }
    }
}
impl std::error::Error for LockError {}

pub struct SidecarLock {
    file: File,
    path: PathBuf,
}

impl SidecarLock {
    pub fn acquire(destination: &Path, timeout: Duration) -> Result<Self, LockError> {
        let path = lock_path(destination);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(LockError::Io)?;
        }
        let deadline = Instant::now() + timeout;
        loop {
            if process_locks()
                .lock()
                .expect("process lock registry poisoned")
                .insert(path.clone())
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err(LockError::Timeout);
            }
            thread::sleep(Duration::from_millis(10));
        }
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) => {
                release_process(&path);
                return Err(LockError::Io(error));
            }
        };
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(Self { file, path }),
                Err(error) if is_contended(&error) => {
                    if Instant::now() >= deadline {
                        release_process(&path);
                        return Err(LockError::Timeout);
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    release_process(&path);
                    return Err(LockError::Io(error));
                }
            }
        }
    }
}
impl Drop for SidecarLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
        release_process(&self.path);
    }
}

fn is_contended(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        matches!(error.raw_os_error(), Some(32 | 33))
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn process_locks() -> &'static Mutex<HashSet<PathBuf>> {
    static LOCKS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashSet::new()))
}
fn release_process(path: &Path) {
    process_locks()
        .lock()
        .expect("process lock registry poisoned")
        .remove(path);
}

pub fn lock_path(destination: &Path) -> PathBuf {
    let mut value = destination.as_os_str().to_owned();
    value.push(".lock");
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "modeleaf-lock-{name}-{:032x}",
            rand::random::<u128>()
        ))
    }
    #[test]
    fn lock_is_exclusive_and_released_on_drop() {
        let destination = temporary_path("exclusive").join("state.json");
        let first = SidecarLock::acquire(&destination, Duration::from_millis(20)).unwrap();
        assert!(matches!(
            SidecarLock::acquire(&destination, Duration::from_millis(20)),
            Err(LockError::Timeout)
        ));
        drop(first);
        SidecarLock::acquire(&destination, Duration::from_millis(20)).unwrap();
        let _ = std::fs::remove_dir_all(destination.parent().unwrap());
    }
    #[test]
    fn lock_path_preserves_unicode_and_long_names() {
        let destination = PathBuf::from("설정").join(format!("{}.json", "긴".repeat(80)));
        assert_eq!(
            lock_path(&destination).to_string_lossy(),
            format!("{}.lock", destination.to_string_lossy())
        );
    }
}

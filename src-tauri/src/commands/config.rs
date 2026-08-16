use crate::persistence::atomic_write::{self, AtomicWriteFaults};
use crate::persistence::lock::{LockError, SidecarLock};
use serde::Serialize;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_CONFIG_BYTES: usize = 256 * 1024;
pub const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConfigReadOutcome {
    Missing,
    Loaded { text: String },
    TooLarge,
    InvalidUtf8,
    StorageFailed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConfigWriteOutcome {
    Created,
    AlreadyExists,
    TooLarge,
    LockTimeout,
    StorageFailed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConfigResetOutcome {
    Replaced,
    Unchanged,
    Missing,
    TooLarge,
    LockTimeout,
    StorageFailed,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ConfigResetFaults {
    pub backup: AtomicWriteFaults,
    pub config: AtomicWriteFaults,
}

#[derive(Clone, Debug)]
pub struct ConfigStore {
    path: PathBuf,
    lock_timeout: Duration,
}
impl ConfigStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock_timeout: DEFAULT_LOCK_TIMEOUT,
        }
    }
    pub fn with_lock_timeout(path: PathBuf, lock_timeout: Duration) -> Self {
        Self { path, lock_timeout }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> ConfigReadOutcome {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return ConfigReadOutcome::Missing
            }
            Err(_) => return ConfigReadOutcome::StorageFailed,
        };
        let mut bytes = Vec::with_capacity(MAX_CONFIG_BYTES.min(8192));
        if file
            .by_ref()
            .take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return ConfigReadOutcome::StorageFailed;
        }
        if bytes.len() > MAX_CONFIG_BYTES {
            return ConfigReadOutcome::TooLarge;
        }
        match String::from_utf8(bytes) {
            Ok(text) => ConfigReadOutcome::Loaded { text },
            Err(_) => ConfigReadOutcome::InvalidUtf8,
        }
    }

    pub fn write_default(&self, canonical: &str) -> ConfigWriteOutcome {
        if canonical.len() > MAX_CONFIG_BYTES {
            return ConfigWriteOutcome::TooLarge;
        }
        let _lock = match SidecarLock::acquire(&self.path, self.lock_timeout) {
            Ok(lock) => lock,
            Err(LockError::Timeout) => return ConfigWriteOutcome::LockTimeout,
            Err(LockError::Io(_)) => return ConfigWriteOutcome::StorageFailed,
        };
        if self.path.exists() {
            return ConfigWriteOutcome::AlreadyExists;
        }
        match atomic_write::publish_exclusive(&self.path, canonical.as_bytes(), "config") {
            Ok(()) => ConfigWriteOutcome::Created,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                ConfigWriteOutcome::AlreadyExists
            }
            Err(_) => ConfigWriteOutcome::StorageFailed,
        }
    }

    pub fn reset(&self, canonical: &str) -> ConfigResetOutcome {
        self.reset_with_faults(canonical, ConfigResetFaults::default())
    }

    pub fn reset_with_faults(
        &self,
        canonical: &str,
        faults: ConfigResetFaults,
    ) -> ConfigResetOutcome {
        if canonical.len() > MAX_CONFIG_BYTES {
            return ConfigResetOutcome::TooLarge;
        }
        let _lock = match SidecarLock::acquire(&self.path, self.lock_timeout) {
            Ok(lock) => lock,
            Err(LockError::Timeout) => return ConfigResetOutcome::LockTimeout,
            Err(LockError::Io(_)) => return ConfigResetOutcome::StorageFailed,
        };
        let mut original_file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return ConfigResetOutcome::Missing
            }
            Err(_) => return ConfigResetOutcome::StorageFailed,
        };
        let mut original = Vec::with_capacity(MAX_CONFIG_BYTES.min(8192));
        if original_file
            .by_ref()
            .take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_end(&mut original)
            .is_err()
        {
            return ConfigResetOutcome::StorageFailed;
        }
        if original.len() > MAX_CONFIG_BYTES {
            return ConfigResetOutcome::TooLarge;
        }
        drop(original_file);
        if original == canonical.as_bytes() {
            return ConfigResetOutcome::Unchanged;
        }
        let backup = backup_path(&self.path);
        if atomic_write::replace_with_faults(&backup, &original, "config-backup", faults.backup)
            .is_err()
        {
            return ConfigResetOutcome::StorageFailed;
        }
        if atomic_write::replace_with_faults(
            &self.path,
            canonical.as_bytes(),
            "config",
            faults.config,
        )
        .is_err()
        {
            return ConfigResetOutcome::StorageFailed;
        }
        ConfigResetOutcome::Replaced
    }
}

pub fn backup_path(config: &Path) -> PathBuf {
    let mut value = config.as_os_str().to_owned();
    value.push(".bak");
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (PathBuf, ConfigStore) {
        let directory = std::env::temp_dir().join(format!(
            "modeleaf-config-{name}-설정-{:032x}",
            rand::random::<u128>()
        ));
        let path = directory.join(format!("{}-config.toml", "긴".repeat(20)));
        (
            directory,
            ConfigStore::with_lock_timeout(path, Duration::from_millis(20)),
        )
    }

    #[test]
    fn read_distinguishes_missing_size_utf8_and_loaded() {
        let (directory, store) = store("read");
        assert_eq!(store.read(), ConfigReadOutcome::Missing);
        std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        std::fs::write(store.path(), b"[input]\nprefix = '<C-b>'\n").unwrap();
        assert!(matches!(store.read(), ConfigReadOutcome::Loaded { .. }));
        std::fs::write(store.path(), [0xff]).unwrap();
        assert_eq!(store.read(), ConfigReadOutcome::InvalidUtf8);
        std::fs::write(store.path(), vec![b'x'; MAX_CONFIG_BYTES + 1]).unwrap();
        assert_eq!(store.read(), ConfigReadOutcome::TooLarge);
        assert_eq!(store.reset("default"), ConfigResetOutcome::TooLarge);
        assert!(!backup_path(store.path()).exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn write_default_is_exclusive_and_preserves_existing_bytes() {
        let (directory, store) = store("write");
        assert_eq!(store.write_default("default"), ConfigWriteOutcome::Created);
        assert_eq!(
            store.write_default("other"),
            ConfigWriteOutcome::AlreadyExists
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), b"default");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn write_and_reset_fail_closed_when_lock_is_contended() {
        let (directory, store) = store("lock");
        let _lock = SidecarLock::acquire(store.path(), Duration::from_millis(20)).unwrap();
        assert_eq!(
            store.write_default("default"),
            ConfigWriteOutcome::LockTimeout
        );
        assert_eq!(store.reset("default"), ConfigResetOutcome::LockTimeout);
        drop(_lock);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reset_preserves_backup_and_is_idempotent() {
        let (directory, store) = store("reset");
        std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        std::fs::write(store.path(), b"custom").unwrap();
        assert_eq!(store.reset("default"), ConfigResetOutcome::Replaced);
        assert_eq!(std::fs::read(store.path()).unwrap(), b"default");
        assert_eq!(std::fs::read(backup_path(store.path())).unwrap(), b"custom");
        assert_eq!(store.reset("default"), ConfigResetOutcome::Unchanged);
        assert_eq!(std::fs::read(backup_path(store.path())).unwrap(), b"custom");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn final_replace_fault_keeps_original_and_durable_backup() {
        let (directory, store) = store("fault");
        std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
        std::fs::write(store.path(), b"custom").unwrap();
        let faults = ConfigResetFaults {
            config: AtomicWriteFaults {
                fail_before_replace: true,
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            store.reset_with_faults("default", faults),
            ConfigResetOutcome::StorageFailed
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), b"custom");
        assert_eq!(std::fs::read(backup_path(store.path())).unwrap(), b"custom");
        assert_eq!(store.reset("default"), ConfigResetOutcome::Replaced);
        assert_eq!(
            std::fs::read_dir(store.path().parent().unwrap())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}

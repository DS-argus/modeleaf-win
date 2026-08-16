use crate::commands::state::{StateFileError, StateFileStore};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex};

const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeId {
    TokyoNight,
    GruvboxDark,
    SolarizedDark,
    Dracula,
    Everforest,
    Nord,
    CatppuccinLatte,
}
impl ThemeId {
    pub const DEFAULT: Self = Self::TokyoNight;
    pub fn id(self) -> &'static str {
        match self {
            Self::TokyoNight => "tokyo-night",
            Self::GruvboxDark => "gruvbox-dark",
            Self::SolarizedDark => "solarized-dark",
            Self::Dracula => "dracula",
            Self::Everforest => "everforest",
            Self::Nord => "nord",
            Self::CatppuccinLatte => "catppuccin-latte",
        }
    }
    fn from_id(value: &str) -> Option<Self> {
        Some(match value {
            "tokyo-night" => Self::TokyoNight,
            "gruvbox-dark" => Self::GruvboxDark,
            "solarized-dark" => Self::SolarizedDark,
            "dracula" => Self::Dracula,
            "everforest" => Self::Everforest,
            "nord" => Self::Nord,
            "catppuccin-latte" => Self::CatppuccinLatte,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeState {
    theme_id: ThemeId,
    revision: u64,
}
impl ThemeState {
    pub fn theme_id(self) -> ThemeId {
        self.theme_id
    }
    pub fn revision(self) -> u64 {
        self.revision
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag")]
pub enum ThemeStateError {
    #[serde(rename = "THEME_STATE_CONFLICT")]
    Conflict,
    #[serde(rename = "THEME_STATE_STORAGE_FAILED")]
    Storage,
}
impl fmt::Display for ThemeStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Conflict => "THEME_STATE_CONFLICT",
            Self::Storage => "THEME_STATE_STORAGE_FAILED",
        })
    }
}
impl std::error::Error for ThemeStateError {}

#[derive(Clone)]
pub struct ThemeStateManager {
    inner: Arc<Mutex<ThemeStateInner>>,
}
struct ThemeStateInner {
    store: StateFileStore,
    current: ThemeState,
    startup_recovery_needed: bool,
}

impl ThemeStateManager {
    pub fn load<P: AsRef<Path>>(path: P) -> Self {
        let store = StateFileStore::new(path.as_ref().to_path_buf());
        let (theme_id, startup_recovery_needed) = match store.load() {
            Ok(snapshot) => (
                snapshot
                    .selected_theme
                    .as_deref()
                    .and_then(ThemeId::from_id)
                    .unwrap_or(ThemeId::DEFAULT),
                false,
            ),
            Err(StateFileError::Absent) => (ThemeId::DEFAULT, false),
            Err(_) => (ThemeId::DEFAULT, true),
        };
        Self {
            inner: Arc::new(Mutex::new(ThemeStateInner {
                store,
                current: ThemeState {
                    theme_id,
                    revision: 0,
                },
                startup_recovery_needed,
            })),
        }
    }
    pub fn current(&self) -> ThemeState {
        self.inner
            .lock()
            .expect("theme state lock poisoned")
            .current
    }
    pub fn commit(
        &self,
        theme_id: ThemeId,
        base_revision: u64,
    ) -> Result<ThemeState, ThemeStateError> {
        let mut inner = self.inner.lock().expect("theme state lock poisoned");
        if base_revision != inner.current.revision {
            return Err(ThemeStateError::Conflict);
        }
        let revision = inner
            .current
            .revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_REVISION)
            .ok_or(ThemeStateError::Storage)?;
        inner.current = ThemeState { theme_id, revision };
        inner
            .store
            .set_selected_theme(theme_id.id().to_owned())
            .map_err(|_| ThemeStateError::Storage)?;
        Ok(inner.current)
    }
    pub fn take_startup_recovery_needed(&self) -> bool {
        let mut inner = self.inner.lock().expect("theme state lock poisoned");
        std::mem::take(&mut inner.startup_recovery_needed)
    }
}

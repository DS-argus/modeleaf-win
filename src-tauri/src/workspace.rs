use crate::pdf_session::{PdfOwner, SessionId, MAX_SESSIONS};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

pub const MAX_WINDOWS: usize = 4;
pub const MAX_DESTROYED_WINDOWS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkspaceError {
    WindowCapacity,
    SessionCapacity,
    WindowNotFound,
    OwnerMismatch,
    GenerationMismatch,
}
impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::WindowCapacity => "WINDOW_CAPACITY",
            Self::SessionCapacity => "SESSION_CAPACITY",
            Self::WindowNotFound => "WINDOW_NOT_FOUND",
            Self::OwnerMismatch => "OWNER_MISMATCH",
            Self::GenerationMismatch => "GENERATION_MISMATCH",
        })
    }
}
impl std::error::Error for WorkspaceError {}

struct Workspace {
    windows: HashMap<String, u64>,
    destroyed_windows: HashMap<String, u64>,
    destroyed_window_order: VecDeque<String>,
    sessions: HashMap<SessionId, PdfOwner>,
    next_generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBudget {
    pub windows: usize,
    pub sessions: usize,
}

#[derive(Clone)]
pub struct WorkspaceManager {
    workspace: Arc<Mutex<Workspace>>,
}
impl Default for WorkspaceManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceManager {
    pub fn new() -> Self {
        Self {
            workspace: Arc::new(Mutex::new(Workspace {
                windows: HashMap::new(),
                destroyed_windows: HashMap::new(),
                destroyed_window_order: VecDeque::new(),
                sessions: HashMap::new(),
                next_generation: 1,
            })),
        }
    }

    pub fn claim_window(&self, label: &str) -> Result<PdfOwner, WorkspaceError> {
        let mut workspace = self.workspace.lock().expect("workspace state poisoned");
        if let Some(generation) = workspace.windows.get(label) {
            return Ok(PdfOwner {
                window_label: label.to_owned(),
                generation: *generation,
            });
        }
        if workspace.windows.len() >= MAX_WINDOWS {
            return Err(WorkspaceError::WindowCapacity);
        }
        let generation = workspace.next_generation;
        workspace.next_generation = workspace
            .next_generation
            .checked_add(1)
            .ok_or(WorkspaceError::WindowCapacity)?;
        workspace.windows.insert(label.to_owned(), generation);
        if workspace.destroyed_windows.remove(label).is_some() {
            workspace
                .destroyed_window_order
                .retain(|destroyed_label| destroyed_label != label);
        }
        Ok(PdfOwner {
            window_label: label.to_owned(),
            generation,
        })
    }

    pub fn check_owner(&self, owner: &PdfOwner) -> Result<(), WorkspaceError> {
        Self::check_owner_locked(
            &self.workspace.lock().expect("workspace state poisoned"),
            owner,
        )
    }

    /// Registers sessions opened before a coordinator was attached without double-counting IDs.
    pub fn admit_session(&self, owner: &PdfOwner, id: SessionId) -> Result<(), WorkspaceError> {
        let mut workspace = self.workspace.lock().expect("workspace state poisoned");
        Self::check_owner_locked(&workspace, owner)?;
        match workspace.sessions.get(&id) {
            Some(existing) if existing == owner => return Ok(()),
            Some(_) => return Err(WorkspaceError::OwnerMismatch),
            None => {}
        }
        if workspace.sessions.len() >= MAX_SESSIONS {
            return Err(WorkspaceError::SessionCapacity);
        }
        workspace.sessions.insert(id, owner.clone());
        Ok(())
    }
    pub fn release_session(&self, owner: &PdfOwner, id: &SessionId) -> Result<(), WorkspaceError> {
        let mut workspace = self.workspace.lock().expect("workspace state poisoned");
        if Self::destroyed_owner_locked(&workspace, owner) {
            return Ok(());
        }
        Self::check_owner_locked(&workspace, owner)?;
        match workspace.sessions.get(id) {
            Some(existing) if existing != owner => Err(WorkspaceError::OwnerMismatch),
            Some(_) => {
                workspace.sessions.remove(id);
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Drains exactly one owner. Repeating destruction with its generation is idempotent while its
    /// bounded FIFO destruction record is retained.
    pub fn destroy_window(&self, owner: &PdfOwner) -> Result<(), WorkspaceError> {
        let mut workspace = self.workspace.lock().expect("workspace state poisoned");
        match workspace.windows.get(&owner.window_label) {
            Some(generation) if *generation == owner.generation => {}
            Some(_) => return Err(WorkspaceError::GenerationMismatch),
            None => match workspace.destroyed_windows.get(&owner.window_label) {
                Some(generation) if *generation == owner.generation => return Ok(()),
                Some(_) => return Err(WorkspaceError::GenerationMismatch),
                None => return Err(WorkspaceError::WindowNotFound),
            },
        }
        workspace.windows.remove(&owner.window_label);
        workspace
            .sessions
            .retain(|_, session_owner| session_owner != owner);
        workspace
            .destroyed_windows
            .insert(owner.window_label.clone(), owner.generation);
        workspace
            .destroyed_window_order
            .push_back(owner.window_label.clone());
        if workspace.destroyed_window_order.len() > MAX_DESTROYED_WINDOWS {
            let evicted_label = workspace
                .destroyed_window_order
                .pop_front()
                .expect("non-empty over-cap destroyed window order");
            workspace.destroyed_windows.remove(&evicted_label);
        }
        Ok(())
    }

    pub fn active_owner(&self, label: &str) -> Option<PdfOwner> {
        let workspace = self.workspace.lock().expect("workspace state poisoned");
        workspace.windows.get(label).map(|generation| PdfOwner {
            window_label: label.to_owned(),
            generation: *generation,
        })
    }

    pub fn budget(&self) -> WorkspaceBudget {
        let workspace = self.workspace.lock().expect("workspace state poisoned");
        WorkspaceBudget {
            windows: workspace.windows.len(),
            sessions: workspace.sessions.len(),
        }
    }

    fn destroyed_owner_locked(workspace: &Workspace, owner: &PdfOwner) -> bool {
        workspace.destroyed_windows.get(&owner.window_label) == Some(&owner.generation)
    }

    fn check_owner_locked(workspace: &Workspace, owner: &PdfOwner) -> Result<(), WorkspaceError> {
        match workspace.windows.get(&owner.window_label) {
            Some(generation) if *generation == owner.generation => Ok(()),
            Some(_) => Err(WorkspaceError::GenerationMismatch),
            None if workspace
                .destroyed_windows
                .contains_key(&owner.window_label) =>
            {
                Err(WorkspaceError::GenerationMismatch)
            }
            None => Err(WorkspaceError::WindowNotFound),
        }
    }
}

use std::collections::HashMap;
use std::sync::Mutex;

use crate::terminal::manager::TerminalManager;

pub struct AppState {
    pub terminal_manager: Mutex<Option<TerminalManager>>,
    /// Which window asked for each shell, by session id.
    ///
    /// The manager holds every session in one map because a pty is a pty; this
    /// is the only thing that knows a session belongs to a *window*, and it
    /// exists for one moment: the window closing. Without it a closed window
    /// left its shells running — on POSIX until the app quit, on Windows
    /// genuinely orphaned, since there is no hangup and no parent-child
    /// lifetime link there. With one window that moment was the same as the
    /// app exiting and `shutdown_all` covered it.
    pub session_windows: Mutex<HashMap<String, String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            terminal_manager: Mutex::new(None),
            session_windows: Mutex::new(HashMap::new()),
        }
    }

    /// Records who owns a session.
    pub fn claim_session(&self, session_id: &str, label: &str) {
        if let Ok(mut owners) = self.session_windows.lock() {
            owners.insert(session_id.to_string(), label.to_string());
        }
    }

    /// Forgets one session, whatever became of it.
    pub fn release_session(&self, session_id: &str) {
        if let Ok(mut owners) = self.session_windows.lock() {
            owners.remove(session_id);
        }
    }

    /// Every session a window owns, and forgets them in the same breath.
    pub fn take_sessions_of(&self, label: &str) -> Vec<String> {
        let Ok(mut owners) = self.session_windows.lock() else {
            return Vec::new();
        };
        let mine: Vec<String> = owners
            .iter()
            .filter(|(_, owner)| owner.as_str() == label)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &mine {
            owners.remove(id);
        }
        mine
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

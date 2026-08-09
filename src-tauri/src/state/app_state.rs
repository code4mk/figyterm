use std::sync::Mutex;

use crate::terminal::manager::TerminalManager;

pub struct AppState {
    pub terminal_manager: Mutex<Option<TerminalManager>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            terminal_manager: Mutex::new(None),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

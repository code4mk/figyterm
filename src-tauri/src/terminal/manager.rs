use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::pty::PtyInstance;
use super::session::TerminalSession;

pub struct TerminalManager {
    sessions: HashMap<String, PtyInstance>,
    output_callback: Arc<dyn Fn(String, Vec<u8>) + Send + Sync>,
}

impl TerminalManager {
    pub fn new(output_callback: Arc<dyn Fn(String, Vec<u8>) + Send + Sync>) -> Self {
        Self {
            sessions: HashMap::new(),
            output_callback,
        }
    }

    pub fn create_session(
        &mut self,
        session_id: String,
        shell: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSession, String> {
        log::info!("Creating PTY session: id={}, shell={}, cwd={}", session_id, shell, cwd);

        let pty = PtyInstance::new(
            session_id.clone(),
            shell,
            cwd,
            cols,
            rows,
            self.output_callback.clone(),
        )?;

        let session = pty.session.clone();
        self.sessions.insert(session_id, pty);

        log::info!("PTY session created successfully: {}", session.id);
        Ok(session)
    }

    pub fn write_to_session(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let pty = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?;
        pty.write(data)
    }

    pub fn resize_session(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let pty = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?;
        log::debug!("Resizing session {}: {}x{}", session_id, cols, rows);
        pty.resize(cols, rows)
    }

    pub fn close_session(&mut self, session_id: &str) -> Result<(), String> {
        log::info!("Closing PTY session: {}", session_id);
        if let Some(pty) = self.sessions.remove(session_id) {
            pty.shutdown();
            Ok(())
        } else {
            Err(format!("Session not found: {}", session_id))
        }
    }

    pub fn get_session_info(&self, session_id: &str) -> Option<TerminalSession> {
        self.sessions.get(session_id).map(|pty| pty.session.clone())
    }

    pub fn list_sessions(&self) -> Vec<TerminalSession> {
        self.sessions.values().map(|pty| pty.session.clone()).collect()
    }

    pub fn shutdown_all(&mut self) {
        log::info!("Shutting down all PTY sessions");
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            let _ = self.close_session(&id);
        }
    }
}

pub type SharedTerminalManager = Arc<Mutex<TerminalManager>>;

pub fn create_shared_manager(
    output_callback: Arc<dyn Fn(String, Vec<u8>) + Send + Sync>,
) -> SharedTerminalManager {
    Arc::new(Mutex::new(TerminalManager::new(output_callback)))
}

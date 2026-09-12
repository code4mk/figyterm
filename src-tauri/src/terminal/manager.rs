use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::pty::PtyInstance;
use super::session::{PtyCommand, TerminalSession};

pub struct TerminalManager {
    sessions: HashMap<String, PtyInstance>,
    output_callback: Arc<dyn Fn(String, Vec<u8>) + Send + Sync>,
    /// Called from a reader thread when a session's child goes away on its own.
    exit_callback: Arc<dyn Fn(String) + Send + Sync>,
}

impl TerminalManager {
    pub fn new(
        output_callback: Arc<dyn Fn(String, Vec<u8>) + Send + Sync>,
        exit_callback: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Self {
        Self {
            sessions: HashMap::new(),
            output_callback,
            exit_callback,
        }
    }

    pub fn create_session(
        &mut self,
        session_id: String,
        shell: String,
        command: Option<PtyCommand>,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSession, String> {
        match &command {
            Some(spec) => log::info!(
                "Creating PTY session: id={}, program={}, args={:?}, cwd={}",
                session_id,
                spec.program,
                spec.args,
                cwd
            ),
            None => log::info!(
                "Creating PTY session: id={}, shell={}, cwd={}",
                session_id,
                shell,
                cwd
            ),
        }

        let pty = PtyInstance::new(
            session_id.clone(),
            shell,
            command,
            cwd,
            cols,
            rows,
            self.output_callback.clone(),
            self.exit_callback.clone(),
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

    /// Foreground PIDs across every session — i.e. commands the user is
    /// currently running. Empty means every pane is sitting at its prompt.
    pub fn foreground_pids(&self) -> Vec<u32> {
        self.sessions
            .values()
            .filter_map(|pty| pty.foreground_pid())
            .collect()
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
    exit_callback: Arc<dyn Fn(String) + Send + Sync>,
) -> SharedTerminalManager {
    Arc::new(Mutex::new(TerminalManager::new(output_callback, exit_callback)))
}

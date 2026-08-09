use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{BufReader, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use super::session::{SessionStatus, TerminalSession};

pub struct PtyInstance {
    pub session: TerminalSession,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    shutdown: Arc<Mutex<bool>>,
}

impl PtyInstance {
    pub fn new(
        session_id: String,
        shell: String,
        cwd: String,
        cols: u16,
        rows: u16,
        output_callback: Arc<dyn Fn(String, Vec<u8>) + Send + Sync>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(&["-l"]);
        cmd.cwd(&cwd);

        // Start with a clean environment like Terminal.app does.
        // Only pass essential vars — the login shell will source user config.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
        let lang = std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string());

        // Build a clean PATH from system defaults
        let default_path = format!(
            "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{}/.local/bin",
            home
        );

        cmd.env_clear();
        cmd.env("HOME", &home);
        cmd.env("USER", &user);
        cmd.env("SHELL", &shell);
        cmd.env("PATH", &default_path);
        cmd.env("LANG", &lang);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Figyterm");
        cmd.env("LOGNAME", &user);
        cmd.env("TMPDIR", std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string()));

        pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        let shutdown = Arc::new(Mutex::new(false));
        let shutdown_clone = shutdown.clone();
        let session_id_clone = session_id.clone();

        thread::spawn(move || {
            let mut buf_reader = BufReader::new(reader);
            let mut buf = [0u8; 4096];

            loop {
                if *shutdown_clone.lock().unwrap() {
                    break;
                }

                match buf_reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        output_callback(session_id_clone.clone(), data);
                    }
                    Err(_) => break,
                }
            }
        });

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let session = TerminalSession {
            id: session_id,
            shell: shell.clone(),
            cwd,
            title: shell.split('/').last().unwrap_or("terminal").to_string(),
            created_at: now,
            status: SessionStatus::Running,
        };

        Ok(Self {
            session,
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            shutdown,
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.write_all(data).map_err(|e| format!("Write failed: {}", e))?;
        writer.flush().map_err(|e| format!("Flush failed: {}", e))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(mut s) = self.shutdown.lock() {
            *s = true;
        }
    }
}

impl Drop for PtyInstance {
    fn drop(&mut self) {
        self.shutdown();
    }
}

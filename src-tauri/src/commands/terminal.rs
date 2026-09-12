use tauri::{AppHandle, Emitter, State};

use crate::state::app_state::AppState;
use crate::terminal::session::{PtyCommand, TerminalSession};

#[derive(serde::Serialize, Clone)]
struct TerminalOutput {
    session_id: String,
    data: Vec<u8>,
}

/// A session whose child ended on its own, rather than being closed.
#[derive(serde::Serialize, Clone)]
struct TerminalExit {
    session_id: String,
}

/// Finds an executable on `PATH`, the way a shell would.
///
/// Not the `which` crate: this only has to answer "is this on PATH", it runs
/// before any shell exists, and `split_paths` already knows that Windows
/// separates with `;`. Callers pass the full filename, so `PATHEXT` doesn't
/// come into it.
#[cfg(target_os = "windows")]
fn which(program: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

fn detect_shell() -> String {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            return shell;
        }
        for shell in &["/bin/zsh", "/bin/bash", "/bin/fish", "/bin/sh"] {
            if std::path::Path::new(shell).exists() {
                return shell.to_string();
            }
        }
        "/bin/sh".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        // Preference order, not availability order: COMSPEC is always set and
        // always points at cmd.exe, so reading it first would hand every
        // developer the one shell they least likely want. PowerShell 7 (`pwsh`)
        // is a separate install from the bundled Windows PowerShell 5.1, and
        // both are found via PATH rather than a fixed location, since 7 installs
        // per-user or per-machine and 5.1 moves with the system root.
        for shell in &["pwsh.exe", "powershell.exe"] {
            if which(shell).is_some() {
                return shell.to_string();
            }
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "/bin/sh".to_string()
    }
}

fn get_default_cwd() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string())
}

fn resolve_cwd(cwd: Option<String>) -> String {
    let default = get_default_cwd();
    let Some(raw) = cwd else {
        return default;
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return default;
    }

    let expanded = if trimmed == "~" {
        default.clone()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        format!("{}/{}", default, rest)
    } else {
        trimmed.to_string()
    };

    let path = std::path::Path::new(&expanded);
    if path.is_dir() {
        expanded
    } else {
        default
    }
}

/// `async` so opening a pty and spawning a shell happens off the main thread.
/// On Windows that pair is `CreatePseudoConsole` plus `CreateProcess`, which is
/// slow enough to be felt as a stutter every time a tab or pane is created.
///
/// `command` is how the Claude window asks for a pty that runs a program rather
/// than the user's shell. Omitting it is every other caller, and means exactly
/// what it always did.
///
/// `session_id` is likewise optional, and exists for one caller: Claude Code
/// takes `--session-id <uuid>`, so the conversation's id has to be decided
/// *before* the process starts in order to be passed to it. Everyone else lets
/// the backend mint one.
#[tauri::command(async)]
pub fn create_terminal_session(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    command: Option<PtyCommand>,
    session_id: Option<String>,
) -> Result<TerminalSession, String> {
    let session_id = session_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let shell = detect_shell();
    let cwd = resolve_cwd(cwd);

    let app_clone = app.clone();
    let output_callback = std::sync::Arc::new(move |sid: String, data: Vec<u8>| {
        let _ = app_clone.emit(
            "terminal-output",
            TerminalOutput {
                session_id: sid,
                data,
            },
        );
    });

    let exit_app = app.clone();
    let exit_callback = std::sync::Arc::new(move |sid: String| {
        let _ = exit_app.emit("terminal-exit", TerminalExit { session_id: sid });
    });

    let mut manager = state.terminal_manager.lock().map_err(|e| e.to_string())?;

    if manager.is_none() {
        *manager = Some(crate::terminal::manager::TerminalManager::new(
            output_callback.clone(),
            exit_callback.clone(),
        ));
    }

    let mgr = manager.as_mut().unwrap();
    mgr.create_session(session_id, shell, command, cwd, cols, rows)
}

#[tauri::command]
pub fn write_terminal_session(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let manager = state.terminal_manager.lock().map_err(|e| e.to_string())?;
    let mgr = manager
        .as_ref()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;
    mgr.write_to_session(&session_id, &data)
}

#[tauri::command]
pub fn resize_terminal_session(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = state.terminal_manager.lock().map_err(|e| e.to_string())?;
    let mgr = manager
        .as_ref()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;
    mgr.resize_session(&session_id, cols, rows)
}

#[tauri::command]
pub fn close_terminal_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut manager = state.terminal_manager.lock().map_err(|e| e.to_string())?;
    let mgr = manager
        .as_mut()
        .ok_or_else(|| "Terminal manager not initialized".to_string())?;
    mgr.close_session(&session_id)
}

#[tauri::command]
pub fn get_default_shell() -> String {
    detect_shell()
}

#[tauri::command]
pub fn get_default_working_directory() -> String {
    get_default_cwd()
}

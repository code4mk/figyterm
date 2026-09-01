use tauri::{AppHandle, Emitter, State};

use crate::state::app_state::AppState;
use crate::terminal::session::TerminalSession;

#[derive(serde::Serialize, Clone)]
struct TerminalOutput {
    session_id: String,
    data: Vec<u8>,
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
        if let Ok(ps) = std::env::var("COMSPEC") {
            return ps;
        }
        "powershell.exe".to_string()
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

#[tauri::command]
pub fn create_terminal_session(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<TerminalSession, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
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

    let mut manager = state.terminal_manager.lock().map_err(|e| e.to_string())?;

    if manager.is_none() {
        *manager = Some(crate::terminal::manager::TerminalManager::new(output_callback.clone()));
    }

    let mgr = manager.as_mut().unwrap();
    mgr.create_session(session_id, shell, cwd, cols, rows)
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

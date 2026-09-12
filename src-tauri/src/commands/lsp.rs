//! The five calls the editor's language-server client makes.
//!
//! `lsp_send` takes a whole message rather than a method and params, so that
//! Rust never has to know which messages exist. Replies do not come back from
//! it — a language server is a duplex stream and a command is request/response,
//! so everything the server says arrives as an event instead.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::lsp::registry::LspState;
use crate::lsp::server::{ExitInfo, ServerInfo};
use crate::spawn;

/// One message from a server. The body is JSON, unparsed: parsing it here only
/// to have Tauri serialise it again would be two round trips for nothing.
pub const MESSAGE_EVENT: &str = "lsp://message";

/// A server has gone. The client decides whether to restart.
pub const EXIT_EVENT: &str = "lsp://exit";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessagePayload<'a> {
    id: &'a str,
    body: String,
}

/// Whether a program is installed, and where.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub program: String,
    /// `None` means "not on PATH", which the settings panel renders as an
    /// install line rather than as a failure.
    pub path: Option<String>,
}

/// Which of these language servers the user actually has.
///
/// Asked for the whole table at once rather than one at a time: the first call
/// may have to run a login shell to find out what the user's real `PATH` is (see
/// `spawn::search_path`), and that should happen once.
#[tauri::command(async)]
pub fn lsp_detect(programs: Vec<String>) -> Vec<Detected> {
    programs
        .into_iter()
        .map(|program| Detected {
            path: spawn::find_program(&program).map(|p| p.to_string_lossy().into_owned()),
            program,
        })
        .collect()
}

/// Starts a server, or returns the one already running under `id`.
///
/// `id` is the client's key — `(workspace root, server)` — so restarting is
/// stop-then-start with the same id, and opening a second file of the same
/// language costs nothing.
#[tauri::command(async)]
pub fn lsp_start(
    app: AppHandle,
    state: State<'_, LspState>,
    id: String,
    language: String,
    program: String,
    args: Vec<String>,
    root: String,
) -> Result<ServerInfo, String> {
    let on_message = {
        let app = app.clone();
        Arc::new(move |id: &str, body: String| {
            let _ = app.emit(MESSAGE_EVENT, MessagePayload { id, body });
        })
    };

    let on_exit = {
        let app = app.clone();
        Arc::new(move |info: ExitInfo| {
            let _ = app.emit(EXIT_EVENT, info);
        })
    };

    let mut registry = state.registry.lock().map_err(|e| e.to_string())?;
    registry.start(id, language, program, args, root, on_message, on_exit)
}

/// Writes one already-formed JSON-RPC message to a server's stdin.
///
/// Not `async`: this is on the path of every keystroke once document sync is
/// live, and the work is a framed `write_all` to a pipe. Hopping to the async
/// runtime for that costs more than it does.
#[tauri::command]
pub fn lsp_send(state: State<'_, LspState>, id: String, message: String) -> Result<(), String> {
    let server = {
        let registry = state.registry.lock().map_err(|e| e.to_string())?;
        registry.get(&id)
    };
    // The lock is released before the write: a slow pipe must not block another
    // server's messages, and `send` can block if the server has stopped reading.
    server
        .ok_or_else(|| format!("no language server {id}"))?
        .send(&message)
}

#[tauri::command(async)]
pub fn lsp_stop(state: State<'_, LspState>, id: String) -> Result<(), String> {
    let mut registry = state.registry.lock().map_err(|e| e.to_string())?;
    registry.stop(&id);
    Ok(())
}

/// What is running, what it costs, and what it last said on stderr.
#[tauri::command]
pub fn lsp_status(state: State<'_, LspState>) -> Result<Vec<ServerInfo>, String> {
    let registry = state.registry.lock().map_err(|e| e.to_string())?;
    Ok(registry.status())
}

/// Ends every language server before the process goes away.
///
/// `lib.rs` already reaps the PTYs on `RunEvent::Exit` for the same reason: a
/// server left running is a process nobody can see, attached to a window that
/// no longer exists.
pub fn shutdown_servers(app: &AppHandle) {
    let state = app.state::<LspState>();
    let Ok(mut registry) = state.registry.lock() else {
        return;
    };
    registry.shutdown_all();
}

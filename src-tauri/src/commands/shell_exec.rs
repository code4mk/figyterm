use serde::Serialize;

use crate::spawn;

#[derive(Serialize)]
pub struct ShellCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub status: i32,
}

/// `async` so the subprocess is not spawned and waited for on the main thread.
///
/// This is the busiest command in the app — every autocomplete spec generator
/// goes through it, on a 120ms debounce while the user types — and a
/// synchronous command runs on the UI thread. Spawning a process costs
/// microseconds on POSIX and tens of milliseconds on Windows, and a command
/// that stalls (a `git` call against a disconnected network drive, say) stalls
/// the whole window with it, close button included.
#[tauri::command(async)]
pub fn execute_shell_command(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<ShellCommandOutput, String> {
    // `spawn::command` is what resolves the name through `PATHEXT` on Windows,
    // and what repairs a truncated PATH on POSIX so tools like python3 and bash
    // are found in production bundles — which inherit a minimal environment from
    // the launcher. The language servers need exactly the same two things, which
    // is why it now lives in one place; see `spawn.rs`.
    let mut cmd = spawn::command(&command);
    cmd.args(&args);

    if let Some(dir) = cwd {
        cmd.current_dir(&dir);
    }

    cmd.env("TERM", "xterm-256color");

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute command '{}': {}", command, e))?;

    Ok(ShellCommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        status: output.status.code().unwrap_or(-1),
    })
}

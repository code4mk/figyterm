use serde::Serialize;
use std::process::Command;

/// Prefixes prepended when the inherited PATH looks truncated. `/opt/homebrew`
/// only exists on Apple Silicon macOS, so it stays out of the Linux list rather
/// than sitting there as a dead entry.
#[cfg(target_os = "macos")]
const SYSTEM_PREFIXES: &str =
    "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const SYSTEM_PREFIXES: &str = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/games";

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
    let mut cmd = Command::new(&command);
    cmd.args(&args);

    // Without this every one of those generator calls flashes a console window
    // on screen. There is no console to show: the output is read, not displayed.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Some(dir) = cwd {
        cmd.current_dir(&dir);
    }

    cmd.env("TERM", "xterm-256color");

    // Repair a truncated PATH so tools like python3 and bash are found in
    // production bundles, which inherit a minimal environment from the launcher.
    //
    // POSIX-only: Windows has no equivalent of a GUI app being launched with a
    // stripped PATH, the directories here don't exist there, and `;` rather than
    // `:` separates them — so the inherited PATH is left exactly as it is.
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let current_path = std::env::var("PATH").unwrap_or_default();
        let full_path = if current_path.contains("/usr/local/bin") {
            current_path
        } else {
            format!("{}:{}/.local/bin:{}", SYSTEM_PREFIXES, home, current_path)
        };
        cmd.env("PATH", &full_path);
        cmd.env("HOME", &home);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute command '{}': {}", command, e))?;

    Ok(ShellCommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        status: output.status.code().unwrap_or(-1),
    })
}

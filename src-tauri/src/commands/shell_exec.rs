use serde::Serialize;
use std::process::Command;

/// Finds what `command` actually names on disk, the way a shell would.
///
/// `CreateProcessW` — and so `std::process::Command` — searches PATH for the
/// name and for the name plus `.exe`, and stops there. It does not consult
/// `PATHEXT`. Every Node tool installs its entry point as a `.cmd` shim
/// (`pnpm.cmd`, `npm.cmd`, `yarn.cmd`), so spawning `pnpm` fails with "program
/// not found" and the generator behind `pnpm run <tab>` silently returns
/// nothing. Resolving the name here and handing `Command` a full path is what
/// closes the gap; Rust knows how to run a `.bat`/`.cmd` from there, and since
/// 1.77.2 escapes the arguments safely when it does.
///
/// `None` means nothing matched, in which case the bare name is passed through
/// so the error the caller gets is the ordinary one.
#[cfg(target_os = "windows")]
fn resolve_program(command: &str) -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};

    // An explicit path is already an answer, give or take the extension.
    let has_separator = command.contains('\\') || command.contains('/');

    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| ext.to_string())
        .collect();

    // A name that already carries one of those extensions is used as written.
    let already_extended = Path::new(command)
        .extension()
        .map(|ext| {
            let ext = format!(".{}", ext.to_string_lossy());
            extensions.iter().any(|known| known.eq_ignore_ascii_case(&ext))
        })
        .unwrap_or(false);

    let candidates = |dir: &Path| -> Option<PathBuf> {
        if already_extended {
            let direct = dir.join(command);
            return direct.is_file().then_some(direct);
        }
        extensions.iter().find_map(|ext| {
            let candidate = dir.join(format!("{command}{ext}"));
            candidate.is_file().then_some(candidate)
        })
    };

    if has_separator {
        return candidates(Path::new(""));
    }

    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| candidates(&dir))
}

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
    #[cfg(target_os = "windows")]
    let program = resolve_program(&command).unwrap_or_else(|| command.clone().into());
    #[cfg(not(target_os = "windows"))]
    let program = command.clone();

    let mut cmd = Command::new(program);
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

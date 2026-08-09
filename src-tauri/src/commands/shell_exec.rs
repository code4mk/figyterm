use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct ShellCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub status: i32,
}

#[tauri::command]
pub fn execute_shell_command(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<ShellCommandOutput, String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args);

    if let Some(dir) = cwd {
        cmd.current_dir(&dir);
    }

    cmd.env("TERM", "xterm-256color");

    // Ensure a complete PATH so tools like python3, bash, etc. are found
    // in production .app bundles which have a minimal inherited environment
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let current_path = std::env::var("PATH").unwrap_or_default();
    let full_path = if current_path.contains("/usr/local/bin") {
        current_path
    } else {
        format!(
            "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{}/.local/bin:{}",
            home, current_path
        )
    };
    cmd.env("PATH", &full_path);
    cmd.env("HOME", &home);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute command '{}': {}", command, e))?;

    Ok(ShellCommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        status: output.status.code().unwrap_or(-1),
    })
}

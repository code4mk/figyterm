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

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute command '{}': {}", command, e))?;

    Ok(ShellCommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        status: output.status.code().unwrap_or(-1),
    })
}

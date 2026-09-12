use serde::{Deserialize, Serialize};

/// A program to run in the pty instead of the user's login shell.
///
/// The pty layer does not know what any of these are. It resolves the program
/// the way a shell would (see `spawn::find_program`), hands it the argv it was
/// given, and reads bytes — so adding a second kind of session is a caller's
/// decision rather than a change here.
///
/// `args` is a list, never a command string, and that is the point: a folder
/// path chosen by the user reaches the child as one argument, whatever is in
/// it. Nothing in this feature quotes anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyCommand {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSession {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub title: String,
    pub created_at: u64,
    pub status: SessionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
    Exited,
}

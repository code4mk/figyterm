//! Two things the Claude window needs from the host, and nothing else.
//!
//! Deliberately thin. The window runs the `claude` CLI in a pty like any other
//! program, so there is no protocol here, no process management and no state —
//! `commands/terminal.rs` already owns all of that. What is left is the pair of
//! questions TypeScript cannot answer for itself:
//!
//! 1. **Is Claude Code installed, and where?** Answered through `spawn.rs`,
//!    which already knows how to find a tool the user installed from a GUI
//!    process whose `PATH` is not theirs. That module exists because language
//!    servers had the same problem; a second copy of it would have been the
//!    wrong thing to add.
//! 2. **What was this conversation about?** Answered by reading the first user
//!    message out of the transcript the CLI writes. Decoration, and treated as
//!    such: every failure path returns `None`.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use crate::spawn;

/// How long `claude --version` gets before we stop waiting for it.
///
/// It is a fast call — but it is also the *first* time the binary is executed,
/// which on a cold page cache and a network-mounted home directory is not
/// instant. Generous enough not to fail spuriously, short enough that a hung
/// binary doesn't leave the window with a spinner forever.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// How much of a transcript is read looking for the first user message.
///
/// The opening entries are a summary and the session's metadata, so the message
/// is usually within the first few lines; a bounded read means a transcript of
/// any size costs the same.
const TRANSCRIPT_SCAN_LINES: usize = 40;

/// A tab title is a title, not a paragraph.
const TITLE_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProbe {
    pub found: bool,
    /// The absolute path that would be spawned. Shown in the not-found state
    /// too, where it is `None` and the message has to say what was searched.
    pub path: Option<String>,
    /// As `claude --version` reports it. `None` means it resolved but would not
    /// run, which is a different problem and worth telling apart.
    pub version: Option<String>,
    /// Why not, when `found` is false or `version` is `None`.
    pub error: Option<String>,
}

/// Where `claude` is, and whether it runs.
///
/// Not cached here: `spawn::find_program` already caches the expensive half (the
/// login shell's `PATH`), and a user who has just installed the CLI should be
/// able to press "Check again" and be believed.
#[tauri::command(async)]
pub fn claude_probe() -> ClaudeProbe {
    let Some(path) = spawn::find_program("claude") else {
        return ClaudeProbe {
            found: false,
            path: None,
            version: None,
            error: Some(format!(
                "`claude` was not found on PATH. Searched: {}",
                spawn::search_path()
            )),
        };
    };

    let display = path.to_string_lossy().into_owned();

    match run_version(&display) {
        Ok(version) => ClaudeProbe {
            found: true,
            path: Some(display),
            version: Some(version),
            error: None,
        },
        Err(error) => ClaudeProbe {
            found: true,
            path: Some(display),
            version: None,
            error: Some(error),
        },
    }
}

/// `claude --version`, with a deadline.
///
/// The wait happens on a scratch thread so a binary that never returns costs one
/// parked thread rather than the command's worker — the same shape
/// `spawn::login_path` uses, and for the same reason.
fn run_version(program: &str) -> Result<String, String> {
    let program = program.to_string();
    let (sender, receiver) = std::sync::mpsc::channel();

    std::thread::spawn(move || {
        let output = spawn::command(&program)
            .arg("--version")
            .stdin(Stdio::null())
            .output();
        let _ = sender.send(output);
    });

    let output = receiver
        .recv_timeout(VERSION_TIMEOUT)
        .map_err(|_| "`claude --version` did not respond".to_string())?
        .map_err(|e| format!("`claude --version` could not be run: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "`claude --version` failed".to_string()
        } else {
            stderr
        });
    }

    // "2.1.269 (Claude Code)" — the whole line is what the CLI considers its
    // version string, and it is shown verbatim rather than parsed. Nothing here
    // compares versions, so nothing here needs to understand them.
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        Err("`claude --version` printed nothing".to_string())
    } else {
        Ok(version)
    }
}

/// The first user message of a conversation, for a tab title.
///
/// `None` for every kind of failure, including "the transcript isn't where we
/// guessed" — see [`transcript_paths`]. A missing title costs a tab that says
/// "Conversation 3" instead, which is why none of this is allowed to be an
/// error the UI has to handle.
#[tauri::command(async)]
pub fn claude_transcript_head(root: String, session_id: String) -> Option<String> {
    for path in transcript_paths(&root, &session_id) {
        if let Some(title) = scan_head(&path).title {
            return Some(title);
        }
    }
    None
}

/// Whether this conversation already exists on disk.
///
/// The difference between `--session-id <id>` and `--resume <id>`, and getting
/// it wrong is not a soft failure: the CLI answers a reused id with
/// `Error: Session ID <id> is already in use.` and exits. So the caller doesn't
/// remember which one to pass — it asks, immediately before starting, and the
/// answer is a fact about the filesystem rather than a flag set earlier that
/// may since have stopped being true.
#[tauri::command(async)]
pub fn claude_session_exists(root: String, session_id: String) -> bool {
    transcript_paths(&root, &session_id)
        .iter()
        .any(|path| path.is_file())
}

/// One conversation found on disk that FigyTerm did not start.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastConversation {
    pub session_id: String,
    pub title: Option<String>,
    /// The git branch it was working on, when the CLI recorded one.
    pub branch: Option<String>,
    /// The transcript's mtime, epoch millis — when it was last spoken to.
    pub updated_at: u64,
}

/// What one pass over a transcript's head is worth reading out of it.
#[derive(Debug, Default)]
struct TranscriptHead {
    /// The first thing the user said.
    title: Option<String>,
    /// The branch the conversation started on.
    ///
    /// The CLI stamps `gitBranch` onto its entries, so this is recorded rather
    /// than worked out — no `git` process, no guess about which repository the
    /// folder belongs to. A conversation can of course move between branches
    /// while it runs; what is shown is where it began, which is what "what was
    /// I doing here" usually means. Absent for a folder that is not a
    /// repository.
    branch: Option<String>,
}

/// Conversations the CLI has recorded for a folder.
///
/// Every project has a history that predates FigyTerm knowing about it: work
/// done in a plain shell, in another editor, or before this project existed
/// here. They are all resumable by id, so the window can offer them rather
/// than pretending a folder's history began when it was added.
///
/// `exclude` is the set FigyTerm already tracks, which would otherwise appear
/// twice. An unreadable directory is an empty list, not an error.
#[tauri::command(async)]
pub fn claude_past_conversations(
    root: String,
    exclude: Vec<String>,
    limit: usize,
) -> Vec<PastConversation> {
    let known: std::collections::HashSet<String> = exclude.into_iter().collect();
    let mut found: Vec<PastConversation> = Vec::new();

    for dir in transcript_dirs(&root) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session_id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if known.contains(session_id) {
                continue;
            }

            let updated_at = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as u64)
                .unwrap_or(0);

            let head = scan_head(&path);
            found.push(PastConversation {
                session_id: session_id.to_string(),
                title: head.title,
                branch: head.branch,
                updated_at,
            });
        }

        // The first directory that exists is the answer; the second candidate
        // is only there because the mangling scheme is a guess.
        if !found.is_empty() {
            break;
        }
    }

    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    found.truncate(limit);
    found
}

/// The directories a root's transcripts might be in — see [`transcript_paths`].
fn transcript_dirs(root: &str) -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    else {
        return Vec::new();
    };

    let projects = home.join(".claude").join("projects");

    let broad: String = root
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let narrow: String = root
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();

    let mut dirs = vec![projects.join(&broad)];
    if narrow != broad {
        dirs.push(projects.join(&narrow));
    }
    dirs
}

/// Where the CLI might have put this conversation's transcript.
///
/// Claude Code writes to `~/.claude/projects/<mangled root>/<session id>.jsonl`,
/// and the mangling is not a documented interface — the observed form turns path
/// separators into `-`, but whether it also touches dots, spaces and underscores
/// is not something the directory listing on one machine can settle.
///
/// So both readings are tried, broadest first, and the caller takes whichever
/// exists. Guessing twice costs a `stat`; guessing once and being wrong costs
/// the feature.
fn transcript_paths(root: &str, session_id: &str) -> Vec<PathBuf> {
    // A session id reaches this from stored state, and it is about to become a
    // path segment. Anything that isn't a uuid character has no business here.
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Vec::new();
    }

    let file = format!("{session_id}.jsonl");
    transcript_dirs(root)
        .into_iter()
        .map(|dir| dir.join(&file))
        .collect()
}

/// Scans the head of a transcript for the things worth showing about it.
///
/// The transcript is JSON Lines, one entry per line, and the shape has changed
/// before — so this is written to *look* for what it wants rather than to parse
/// what is there, and gives up quietly on anything it doesn't recognise.
///
/// One pass for both fields: the title and the branch live on different
/// entries, and reading the file twice to collect them separately would be two
/// syscalls for one answer.
fn scan_head(path: &PathBuf) -> TranscriptHead {
    let mut head = TranscriptHead::default();

    let Ok(file) = std::fs::File::open(path) else {
        return head;
    };
    let reader = BufReader::new(file);

    for line in reader.lines().take(TRANSCRIPT_SCAN_LINES) {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };

        if head.branch.is_none() {
            if let Some(branch) = value.get("gitBranch").and_then(|b| b.as_str()) {
                // Present but empty is what a folder outside a repository
                // records, and an empty chip is worse than no chip.
                if !branch.trim().is_empty() {
                    head.branch = Some(branch.trim().to_string());
                }
            }
        }

        if head.title.is_none() {
            if let Some(title) = user_message(&value) {
                head.title = Some(title);
            }
        }

        if head.title.is_some() && head.branch.is_some() {
            break;
        }
    }

    head
}

/// The text of a user entry, if this value is one and it has any.
fn user_message(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }

    let content = value.get("message").and_then(|m| m.get("content"))?;

    // Either a bare string or the content-block array; a block array whose
    // first text block is a tool result is not something the user typed.
    let text = match content {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .find(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
            .and_then(|block| block.get("text"))
            .and_then(|text| text.as_str())
            .map(str::to_string)?,
        _ => return None,
    };

    let title = summarize(&text);
    (!title.is_empty()).then_some(title)
}

/// One line, short enough for a tab.
fn summarize(text: &str) -> String {
    // Command invocations and pasted context arrive with markup around them;
    // the first non-empty line is the part a person would recognise.
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('<'))
        .unwrap_or("")
        .trim();

    if first.chars().count() <= TITLE_CHARS {
        return first.to_string();
    }

    let clipped: String = first.chars().take(TITLE_CHARS).collect();
    // Break on a word if there is one nearby, rather than mid-word.
    match clipped.rsplit_once(' ') {
        Some((head, _)) if head.chars().count() > TITLE_CHARS / 2 => format!("{head}…"),
        _ => format!("{clipped}…"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_id_cannot_escape_the_projects_directory() {
        assert!(transcript_paths("/tmp/project", "../../etc/passwd").is_empty());
        assert!(transcript_paths("/tmp/project", "").is_empty());
    }

    /// The observed scheme: separators become dashes, case is kept.
    #[test]
    fn a_root_becomes_a_directory_name() {
        let paths = transcript_paths("/Users/me/GitHub/Nexus-RE", "abc-123");
        assert!(!paths.is_empty());
        let first = paths[0].to_string_lossy().into_owned();
        assert!(
            first.contains("-Users-me-GitHub-Nexus-RE"),
            "unexpected mangling: {first}"
        );
        assert!(first.ends_with("abc-123.jsonl"));
    }

    /// Both readings are offered when they differ, so a dot in a path doesn't
    /// decide the feature.
    #[test]
    fn a_dotted_root_is_guessed_twice() {
        let paths = transcript_paths("/Users/me/my.project", "abc-123");
        assert_eq!(paths.len(), 2);
        assert!(paths[0].to_string_lossy().contains("my-project"));
        assert!(paths[1].to_string_lossy().contains("my.project"));
    }

    /// The real shape, copied from a transcript the CLI wrote.
    ///
    /// The opening entries are metadata and queue bookkeeping — not messages —
    /// and the first `user` entry carries its content as a bare string. Both
    /// halves matter: a parser that took the first line, or that expected the
    /// content-block array, would find nothing here.
    #[test]
    fn the_first_user_message_is_found_past_the_metadata() {
        let dir = std::env::temp_dir().join("figyterm-transcript-head");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        std::fs::write(
            &path,
            concat!(
                r#"{"type":"custom-title","customTitle":"argv-check"}"#,
                "\n",
                r#"{"type":"agent-name","agentName":"argv-check"}"#,
                "\n",
                r#"{"type":"queue-operation","operation":"enqueue","content":"hi"}"#,
                "\n",
                r#"{"type":"mode","gitBranch":"feature/code-editor","cwd":"/tmp"}"#,
                "\n",
                r#"{"type":"user","message":{"role":"user","content":"fix the parser\nand tests"}}"#,
                "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#,
                "\n",
            ),
        )
        .unwrap();

        let head = scan_head(&path);
        assert_eq!(head.title, Some("fix the parser".to_string()));
        assert_eq!(head.branch, Some("feature/code-editor".to_string()));
    }

    /// The other shape: content as blocks, which is what a message with
    /// attachments or tool results looks like.
    #[test]
    fn a_content_block_message_is_read_too() {
        let dir = std::env::temp_dir().join("figyterm-transcript-blocks");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","message":{"content":[{"type":"image"},{"type":"text","text":"look at this"}]}}"#,
                "\n",
            ),
        )
        .unwrap();

        assert_eq!(scan_head(&path).title, Some("look at this".to_string()));
    }

    /// A transcript that has nothing to say yields nothing, rather than an
    /// error the tab strip would have to render.
    #[test]
    fn a_transcript_with_no_user_message_is_none() {
        let dir = std::env::temp_dir().join("figyterm-transcript-empty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(&path, "{\"type\":\"custom-title\"}\nnot json at all\n").unwrap();

        assert_eq!(scan_head(&path).title, None);
        assert_eq!(scan_head(&dir.join("missing.jsonl")).title, None);
    }

    /// A folder that is not a repository records `gitBranch` as an empty
    /// string, and an empty chip is worse than no chip.
    #[test]
    fn an_empty_branch_is_no_branch() {
        let dir = std::env::temp_dir().join("figyterm-transcript-nobranch");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");

        std::fs::write(
            &path,
            concat!(
                r#"{"type":"mode","gitBranch":"","cwd":"/tmp"}"#,
                "\n",
                r#"{"type":"user","message":{"content":"hello"}}"#,
                "\n",
            ),
        )
        .unwrap();

        let head = scan_head(&path);
        assert_eq!(head.branch, None);
        assert_eq!(head.title, Some("hello".to_string()));
    }

    #[test]
    fn a_title_is_one_short_line() {
        assert_eq!(summarize("fix the parser\nand the tests"), "fix the parser");
        assert_eq!(summarize("  \n\nhello "), "hello");
        assert_eq!(summarize("<command-name>/init</command-name>\nrun it"), "run it");
    }

    #[test]
    fn a_long_title_is_clipped_on_a_word() {
        let long = "please refactor the entire authentication subsystem and then \
                    write the integration tests for it as well";
        let title = summarize(long);
        assert!(title.ends_with('…'));
        assert!(title.chars().count() <= TITLE_CHARS + 1);
        assert!(!title.contains("  "));
    }
}

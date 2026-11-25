//! `git_status`, `git_diff`, `git_log`, `git_blame`, `git_commit`.
//!
//! Twenty-six git commands exist in `commands/git.rs`. The agent gets
//! five, because the rest answer questions it does not ask, and because
//! every tool definition sits in the cached prefix of every request for
//! the whole session — a tool nobody calls is a tax on every turn that
//! does not call it.
//!
//! ## Nothing here pushes
//!
//! No `git_push`, no `git_pull`, no branch switching, no stash. The agent
//! proposes and a human presses the button. That is a rule about blast
//! radius rather than about capability: `git/operations.rs` has all of
//! them a function call away, which is exactly the problem.
//!
//! `git_commit` is the one write, and it is one tool rather than
//! stage-then-commit as two. Separate tools invite a half-staged tree when
//! a turn is interrupted between them.
//!
//! ## Why these call `git::operations` directly
//!
//! The `git_*` **commands** resolve their directory through the editor's
//! root list, the same fence `commands/fs.rs` applies — so a folder the
//! agent is working in that the editor has never opened would be refused.
//! The operations underneath take a path and shell out, and the agent's
//! own root (`agent/workspace.rs`) is what it passes them.

use serde_json::{json, Value};

use super::output::{cap_lines, clip_line};
use super::{arg_str, arg_usize, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::git::operations::{self, GitChange};

const MAX_FILES: usize = 60;
const MAX_DIFF_LINES: usize = 300;
const MAX_LOG: usize = 50;

/// The repository this project sits in, or a sentence saying it does not.
///
/// The top level rather than the project root: a project opened on
/// `packages/web` of a monorepo is still in the repository above it, and
/// every git argument is relative to that.
fn repo(ctx: &ToolContext, tool: &str) -> Result<std::path::PathBuf, ToolError> {
    operations::top_level(ctx.root())
        .ok_or_else(|| format!("{tool}: this folder is not in a git repository"))
}

/// `M`, `A`, `D` — one letter, as `git status --short` writes it.
fn letter(change: GitChange) -> char {
    match change {
        GitChange::Added => 'A',
        GitChange::Modified => 'M',
        GitChange::Deleted => 'D',
        GitChange::Renamed => 'R',
        GitChange::Copied => 'C',
        GitChange::TypeChanged => 'T',
        GitChange::Untracked => '?',
        GitChange::Conflicted => 'U',
    }
}

pub struct Status;

impl Tool for Status {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_status",
            description: "The branch, how far ahead or behind it is, and every file that \
                has changed — staged and unstaged, in `git status --short` notation. Use \
                it before committing, and to find what you have already changed in this \
                session.",
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, _args: &Value) -> Result<ToolOutput, ToolError> {
        let root = repo(ctx, "git_status")?;
        let repo = operations::status(&root).map_err(|e| format!("git_status: {e}"))?;
        if !repo.is_repo {
            return Err("git_status: this folder is not in a git repository".into());
        }

        let mut head = match (&repo.branch, repo.detached) {
            (Some(branch), false) => format!("On {branch}"),
            (Some(sha), true) => format!("Detached at {sha}"),
            (None, _) => "On an unborn branch".to_string(),
        };
        if let Some(upstream) = &repo.upstream {
            head.push_str(&format!(" · {upstream}"));
            if repo.ahead > 0 {
                head.push_str(&format!(" · {} ahead", repo.ahead));
            }
            if repo.behind > 0 {
                head.push_str(&format!(" · {} behind", repo.behind));
            }
        }
        if repo.merging {
            head.push_str(" · merging");
        }

        if repo.files.is_empty() {
            return Ok(ToolOutput::text(format!("{head}\nNothing changed.")));
        }

        /*
          Two columns, as `git status --short` has them: what is staged and
          what is not. The agent needs the difference — "I edited it" and
          "it is ready to commit" are different facts, and a single letter
          per file would hide which.
        */
        let lines: Vec<String> = repo
            .files
            .iter()
            .map(|file| {
                let staged = file.staged.map(letter).unwrap_or(' ');
                let unstaged = file.unstaged.map(letter).unwrap_or(' ');
                match &file.from {
                    Some(from) => format!("{staged}{unstaged} {from} → {}", file.relative),
                    None => format!("{staged}{unstaged} {}", file.relative),
                }
            })
            .collect();

        let total = lines.len();
        let (kept, note) = cap_lines(lines, MAX_FILES, "ask about a sub-folder");
        let mut text = format!("{head}\n{} changed\n{}\n", total, kept.join("\n"));
        if let Some(note) = note {
            text.push_str(&note);
            text.push('\n');
        }
        if repo.truncated {
            text.push_str("--- git stopped listing: too many changes ---\n");
        }

        Ok(ToolOutput::text(text).with_detail(json!({
            "branch": repo.branch,
            "ahead": repo.ahead,
            "behind": repo.behind,
            "changed": total,
        })))
    }
}

pub struct Diff;

impl Tool for Diff {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_diff",
            description: "What changed in the working tree, as a unified diff. Give a path \
                for one file, or leave it out for everything. Use it to see what you have \
                done so far, or what somebody else did before you edit over it.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description":
                            "One file, relative to the project root. Omit for every \
                             changed file."
                    }
                },
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let root = repo(ctx, "git_diff")?;

        let wanted = args.get("path").and_then(Value::as_str).map(str::to_string);
        let relatives: Vec<String> = match &wanted {
            Some(path) => {
                // Through `resolve_in` first, so a path that leaves the
                // project is refused here rather than handed to git.
                let absolute = ctx.resolve(path)?;
                vec![relative_to(&root, &absolute)]
            }
            None => operations::status(&root)
                .map_err(|e| format!("git_diff: {e}"))?
                .files
                .iter()
                .map(|file| file.relative.clone())
                .collect(),
        };

        if relatives.is_empty() {
            return Ok(ToolOutput::text("Nothing has changed in the working tree."));
        }

        let mut lines: Vec<String> = Vec::new();
        for relative in relatives.iter().take(MAX_FILES) {
            match operations::file_diff(&root, relative) {
                Ok(diff) if !diff.trim().is_empty() => {
                    lines.extend(diff.lines().map(|line| clip_line(line, 300)));
                }
                // An untracked file has no diff; saying so beats silence.
                Ok(_) => lines.push(format!("(no diff for {relative} — untracked or binary)")),
                Err(error) => lines.push(format!("({relative}: {error})")),
            }
        }

        let (kept, note) = cap_lines(lines, MAX_DIFF_LINES, "ask for one file with `path`");
        let mut text = kept.join("\n");
        text.push('\n');
        if let Some(note) = note {
            text.push_str(&note);
            text.push('\n');
        }

        Ok(ToolOutput::text(text).with_detail(json!({ "files": relatives.len() })))
    }
}

/// `/a/b/src/x.rs` under `/a/b` → `src/x.rs`, forward slashes, as git wants.
fn relative_to(root: &std::path::Path, path: &std::path::Path) -> String {
    path.strip_prefix(root)
        .map(|rest| {
            rest.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

pub struct Log;

impl Tool for Log {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_log",
            description: "Recent commits: short sha, author, date and subject. Useful for \
                the conventions of this repository — how messages are written here, and \
                what has been happening in the code you are about to change.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "How many commits. Default 15, maximum 50."
                    }
                },
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let root = repo(ctx, "git_log")?;
        let limit = arg_usize(args, "limit", 15, MAX_LOG);

        let commits = operations::log(&root, limit, 0).map_err(|e| format!("git_log: {e}"))?;
        if commits.is_empty() {
            return Ok(ToolOutput::text("No commits yet."));
        }

        let lines: Vec<String> = commits
            .iter()
            .map(|commit| {
                format!(
                    "{} {} · {} · {}{}",
                    commit.short,
                    // The day, not the second: the year is what matters and
                    // a timestamp is eleven characters of noise per line.
                    commit.date.split('T').next().unwrap_or(&commit.date),
                    commit.author,
                    commit.subject,
                    if commit.unpushed { " (unpushed)" } else { "" }
                )
            })
            .collect();

        Ok(ToolOutput::text(lines.join("\n")).with_detail(json!({ "commits": commits.len() })))
    }
}

pub struct Blame;

impl Tool for Blame {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_blame",
            description: "Who last changed a line, when, and in which commit. The answer \
                to “why is this line like this” — the commit subject is usually the whole \
                explanation, and it is cheaper than reading the surrounding code and \
                guessing.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The file, relative to the project root." },
                    "line": { "type": "integer", "description": "1-based line, as `read` numbers them." }
                },
                "required": ["path", "line"],
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let root = repo(ctx, "git_blame")?;
        let path = arg_str(args, "path", "git_blame")?;
        if args.get("line").is_none() {
            return Err("git_blame: `line` is required — the line to explain".into());
        }
        let line = arg_usize(args, "line", 1, u32::MAX as usize);

        let absolute = ctx.resolve(&path)?;
        let relative = relative_to(&root, &absolute);
        let blame = operations::blame(&root, &relative).map_err(|e| format!("git_blame: {e}"))?;

        let Some(index) = blame.lines.get(line - 1) else {
            return Err(format!(
                "git_blame: {relative} has {} lines, so line {line} does not exist",
                blame.lines.len()
            ));
        };
        let Some(commit) = blame.commits.get(*index as usize) else {
            return Err(format!("git_blame: nothing recorded for {relative}:{line}"));
        };

        if commit.uncommitted {
            return Ok(ToolOutput::text(format!(
                "{relative}:{line} is uncommitted — it was changed in the working tree."
            )));
        }

        Ok(ToolOutput::text(format!(
            "{relative}:{line}\n{} · {} · {}\n{}",
            commit.short,
            commit.author,
            day(commit.time),
            commit.summary
        ))
        .with_detail(json!({ "sha": commit.sha, "author": commit.author })))
    }
}

/// Epoch seconds as `2026-11-25`.
///
/// Written out rather than taken from a date crate, because the only thing
/// anybody reads off a blame is the year and roughly when — and this is
/// the one place in the agent that needs a calendar.
fn day(epoch: i64) -> String {
    let days = epoch.div_euclid(86_400);
    let (mut year, mut left) = (1970i64, days);
    loop {
        let length = if leap(year) { 366 } else { 365 };
        if left < length {
            break;
        }
        left -= length;
        year += 1;
    }
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0;
    while month < 12 && left >= months[month] {
        left -= months[month];
        month += 1;
    }
    format!("{year:04}-{:02}-{:02}", month + 1, left + 1)
}

fn leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub struct Commit;

impl Tool for Commit {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_commit",
            description: "Stage the given files and commit them. Without `paths` it \
                commits everything that has changed. Write the message in the style of \
                this repository's own history — run `git_log` first if you have not. \
                This does not push.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The commit message. A subject line, and a body if it needs one."
                    },
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description":
                            "Files to stage, relative to the project root. Omit to commit \
                             every change."
                    }
                },
                "required": ["message"],
                "additionalProperties": false
            }),
            class: Class::Write,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let root = repo(ctx, "git_commit")?;
        let message = arg_str(args, "message", "git_commit")?;

        let relatives: Vec<String> = match args.get("paths").and_then(Value::as_array) {
            Some(items) => {
                let mut out = Vec::new();
                for item in items {
                    let Some(path) = item.as_str() else { continue };
                    let absolute = ctx.resolve(path)?;
                    out.push(relative_to(&root, &absolute));
                }
                out
            }
            None => operations::status(&root)
                .map_err(|e| format!("git_commit: {e}"))?
                .files
                .iter()
                .map(|file| file.relative.clone())
                .collect(),
        };

        if relatives.is_empty() {
            return Err("git_commit: nothing has changed, so there is nothing to commit".into());
        }

        /*
          Staged and committed in one call.

          As two tools this is a half-staged tree whenever a turn is
          interrupted between them — and the model cannot see the index,
          so it would have no way of noticing.
        */
        operations::stage(&root, &relatives).map_err(|e| format!("git_commit: {e}"))?;
        let result = operations::commit(&root, &message).map_err(|e| format!("git_commit: {e}"))?;

        Ok(ToolOutput::text(format!(
            "{result}\n{} file{} committed. Nothing was pushed.",
            relatives.len(),
            if relatives.len() == 1 { "" } else { "s" }
        ))
        .with_detail(json!({ "files": relatives, "message": message })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    /// A real repository, because these tools are a thin layer over `git`
    /// and a fake of it would test the fake.
    ///
    /// Skipped when git is not installed, rather than failing: this suite
    /// runs in places that have no git, and a red test there says nothing
    /// about the code.
    fn repo_at(name: &str) -> Option<ToolContext> {
        let dir = std::env::temp_dir().join(format!("figy-git-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).ok()?;

        let run = |args: &[&str]| -> bool {
            Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-q"]) {
            return None;
        }
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        run(&["config", "commit.gpgsign", "false"]);

        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").ok()?;
        run(&["add", "."]);
        run(&["commit", "-qm", "First commit"]);

        Some(ToolContext::new(std::fs::canonicalize(&dir).ok()?))
    }

    #[test]
    fn a_clean_repository_says_nothing_changed() {
        let Some(ctx) = repo_at("clean") else { return };
        let out = Status.call(&ctx, &json!({})).unwrap();
        assert!(out.text.contains("Nothing changed."));
        assert!(out.text.starts_with("On "), "the branch comes first: {}", out.text);
    }

    #[test]
    fn a_changed_file_shows_with_its_two_columns() {
        let Some(ctx) = repo_at("changed") else { return };
        std::fs::write(ctx.root().join("src/main.rs"), "fn main() { go(); }\n").unwrap();

        let out = Status.call(&ctx, &json!({})).unwrap();
        // Unstaged modification: a space, then `M`.
        assert!(out.text.contains(" M src/main.rs"), "got: {}", out.text);
        assert!(out.text.contains("1 changed"));
    }

    #[test]
    fn the_diff_is_the_working_tree() {
        let Some(ctx) = repo_at("diff") else { return };
        std::fs::write(ctx.root().join("src/main.rs"), "fn main() { go(); }\n").unwrap();

        let out = Diff.call(&ctx, &json!({})).unwrap();
        assert!(out.text.contains("-fn main() {}"), "got: {}", out.text);
        assert!(out.text.contains("+fn main() { go(); }"));
    }

    #[test]
    fn a_clean_tree_has_no_diff_and_says_so() {
        let Some(ctx) = repo_at("nodiff") else { return };
        let out = Diff.call(&ctx, &json!({})).unwrap();
        assert!(out.text.contains("Nothing has changed"));
    }

    #[test]
    fn the_log_is_one_line_per_commit() {
        let Some(ctx) = repo_at("log") else { return };
        let out = Log.call(&ctx, &json!({})).unwrap();
        assert!(out.text.contains("First commit"));
        assert!(out.text.contains("Test"));
        // The day, not the second.
        assert!(!out.text.contains(":00:"), "a timestamp is noise: {}", out.text);
    }

    #[test]
    fn blame_answers_why_a_line_is_like_that() {
        let Some(ctx) = repo_at("blame") else { return };
        let out = Blame
            .call(&ctx, &json!({ "path": "src/main.rs", "line": 1 }))
            .unwrap();
        assert!(out.text.contains("First commit"));
        assert!(out.text.contains("src/main.rs:1"));
    }

    #[test]
    fn blame_on_an_unsaved_line_says_it_is_yours() {
        let Some(ctx) = repo_at("blame-new") else { return };
        std::fs::write(ctx.root().join("src/main.rs"), "fn main() {}\nlet x = 1;\n").unwrap();
        let out = Blame
            .call(&ctx, &json!({ "path": "src/main.rs", "line": 2 }))
            .unwrap();
        assert!(out.text.contains("uncommitted"), "got: {}", out.text);
    }

    #[test]
    fn committing_stages_and_commits_in_one_step() {
        let Some(ctx) = repo_at("commit") else { return };
        std::fs::write(ctx.root().join("src/new.rs"), "// new\n").unwrap();

        let out = Commit
            .call(&ctx, &json!({ "message": "Add a file" }))
            .unwrap();
        assert!(out.text.contains("Nothing was pushed."));

        // And the tree is clean afterwards, which is the actual assertion.
        let after = Status.call(&ctx, &json!({})).unwrap();
        assert!(after.text.contains("Nothing changed."), "got: {}", after.text);
    }

    #[test]
    fn committing_nothing_is_refused_rather_than_an_empty_commit() {
        let Some(ctx) = repo_at("empty") else { return };
        let err = Commit
            .call(&ctx, &json!({ "message": "nothing" }))
            .unwrap_err();
        assert!(err.contains("nothing to commit"));
    }

    #[test]
    fn a_path_outside_the_project_never_reaches_git() {
        let Some(ctx) = repo_at("escape") else { return };
        assert!(Diff
            .call(&ctx, &json!({ "path": "../../../etc/passwd" }))
            .unwrap_err()
            .contains("outside"));
    }

    #[test]
    fn a_folder_with_no_repository_says_so() {
        let dir = std::env::temp_dir().join("figy-git-none");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = ToolContext::new(std::fs::canonicalize(&dir).unwrap());

        let err = Status.call(&ctx, &json!({})).unwrap_err();
        assert!(err.contains("not in a git repository"));
    }

    #[test]
    fn nothing_offered_here_can_push() {
        // The rule, as a test: a `push` tool added later fails this.
        for spec in [
            Status.spec(),
            Diff.spec(),
            Log.spec(),
            Blame.spec(),
            Commit.spec(),
        ] {
            assert!(!spec.name.contains("push"));
            assert!(!spec.name.contains("pull"));
        }
        assert_eq!(Commit.spec().class, Class::Write);
        assert_eq!(Status.spec().class, Class::Read);
    }

    #[test]
    fn epoch_seconds_become_a_day() {
        assert_eq!(day(0), "1970-01-01");
        assert_eq!(day(951_782_400), "2000-02-29"); // a leap day
        assert_eq!(day(1_764_028_800), "2025-11-25");
    }

    #[test]
    fn a_relative_path_is_what_git_is_given() {
        let root = PathBuf::from("/a/b");
        assert_eq!(relative_to(&root, &PathBuf::from("/a/b/src/x.rs")), "src/x.rs");
    }
}

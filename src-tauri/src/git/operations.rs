//! Git, by shelling out to `git`.
//!
//! Not `git2`/libgit2, deliberately. This app is a terminal: `git` is already
//! installed, already configured, and already the thing the user's credential
//! helper, `core.hooksPath`, `include.path`, worktrees, submodules, LFS filters
//! and `.gitattributes` are set up for. Linking libgit2 would mean a C build on
//! three platforms and a second, subtly different implementation of all of
//! that — for a status list and a diff. Shelling out costs a process per
//! refresh, which is cheaper than being wrong about what the repository says.
//!
//! Everything here reads or writes through the repository's **top level**,
//! which is not necessarily the folder open in the editor: opening
//! `~/project/src` on a repo rooted at `~/project` is normal, and git reports
//! paths relative to the top level either way. So paths cross this boundary as
//! repo-relative strings — the form git itself emits — and [`relative_arg`]
//! rejects anything that tries to climb out of the tree with them.
//!
//! Porcelain v2 rather than v1. v1's `XY path` lines need the rename form
//! guessed from context and can't say whether HEAD is detached; v2 states both
//! explicitly and is documented as stable for machine reading, which is the
//! whole reason to prefer it.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Cap on the reported file list.
///
/// A repository with more changed files than this is mid-rebase or has just had
/// a generated directory committed, and neither the tree decorations nor the
/// panel are useful at that size. The flag says the list was cut.
const MAX_FILES: usize = 5_000;

/// Cap on synthesising an all-added diff for an untracked file.
const MAX_UNTRACKED_DIFF_BYTES: u64 = 2 * 1024 * 1024;

/// One page of history. Enough to fill the panel several times over.
pub const LOG_PAGE: usize = 50;

/// How long a network operation gets before it is killed.
///
/// Fetch and push are the only two things here that talk to another machine,
/// and the only two that can sit there forever: a credential prompt with no
/// terminal to show it in, an SSH passphrase, a host that accepts the
/// connection and then says nothing. `GIT_TERMINAL_PROMPT=0` stops git's own
/// prompting, but it cannot stop ssh's, and a panel stuck on "Pushing…" with no
/// way out is worse than one that says it gave up.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// Field and record separators for `git log --format`.
///
/// Unit and record separator, rather than anything printable: a commit subject
/// can contain any character a person can type, tabs and pipes included, and
/// every delimiter that looks safe turns out to appear in somebody's commit
/// message eventually.
const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitChange {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Absolute, in the platform's own form — this is what the file tree and
    /// the open buffers are keyed by, so it has to match them exactly.
    pub path: String,
    /// The same file as git names it: relative to the top level, forward
    /// slashes on every platform. This is what goes back to `git` as an
    /// argument.
    pub relative: String,
    /// Where a rename or copy came from, repo-relative.
    pub from: Option<String>,
    /// The change staged for the next commit, if any.
    pub staged: Option<GitChange>,
    /// The change in the working tree that is not staged, if any.
    pub unstaged: Option<GitChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepo {
    pub is_repo: bool,
    /// The repository's top level, absolute. `None` when this isn't a repo.
    pub root: Option<String>,
    /// The branch name, or `None` on a detached HEAD.
    pub branch: Option<String>,
    pub detached: bool,
    /// The upstream ref, e.g. `origin/main`.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    /// True when the walk stopped at [`MAX_FILES`].
    pub truncated: bool,
}

impl GitRepo {
    fn not_a_repo() -> Self {
        GitRepo {
            is_repo: false,
            root: None,
            branch: None,
            detached: false,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            truncated: false,
        }
    }
}

/// One run of changed lines, in the working file's own numbering.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunk {
    /// First changed line, 1-based.
    pub line: u32,
    /// How many lines of the working file it covers.
    ///
    /// Zero for a pure deletion: the removed lines aren't in this file at all,
    /// so there is nothing to mark except the boundary they were at.
    pub lines: u32,
    /// How many lines were removed. Non-zero alongside `lines` means the run
    /// was modified rather than added.
    pub removed: u32,
}

/// One entry in the history list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    /// Git's own abbreviation, which respects `core.abbrev`.
    pub short: String,
    pub author: String,
    pub email: String,
    /// ISO 8601, so the frontend formats it rather than parsing a locale.
    pub date: String,
    pub subject: String,
    /// `HEAD -> main, origin/main, tag: v1.2`. Empty when undecorated.
    pub refs: String,
    /// True for a merge, which is why its diff is against the first parent.
    pub merge: bool,
}

/// A file as one commit changed it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub relative: String,
    pub change: GitChange,
    /// Where a rename came from.
    pub from: Option<String>,
    /// Lines added and removed. Both zero for a binary file, which git reports
    /// as `-` rather than a number because there are no lines to count.
    pub added: u32,
    pub removed: u32,
}

/// Everything the history drawer shows about one commit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub commit: GitCommit,
    /// The message below the subject, verbatim — blank lines and all.
    pub body: String,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    /// True when the file isn't in HEAD at all.
    ///
    /// Every line is then new, and it's the caller that marks them: it has the
    /// document in front of it and knows how long it is, so this saves reading
    /// the file a second time just to count.
    pub untracked: bool,
    pub hunks: Vec<GitHunk>,
}

// ─── Running git ────────────────────────────────────────────────────────────

/// Runs git in `cwd` and returns stdout, or stderr as the error.
///
/// Every invocation goes through here so they all share the same two guards:
/// `--no-optional-locks`, so a status refresh can't take the index lock away
/// from a `git` the user is running in the pane behind, and stderr as the error
/// text, because git's own message ("Please tell me who you are", "pathspec did
/// not match") is always more useful than anything this layer could invent.
fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "git was not found on PATH".to_string(),
            _ => format!("git could not be run: {e}"),
        })?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("git exited with {}", output.status)
    } else {
        stderr
    })
}

/// Runs git with a deadline, returning stdout and stderr together.
///
/// Only for fetch and push. Two differences from [`git`] and both are the
/// point: the deadline, because those are the only calls that can block
/// forever, and the combined output, because git reports a successful push on
/// *stderr* — "To github.com:… 3b11460..a1b2c3d main -> main" is the
/// confirmation, and dropping it would leave a success with nothing to show.
fn git_network(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        // Fails fast instead of waiting on a username and password nobody can
        // type: there is no terminal attached to this process. A configured
        // credential helper still works, which is the case that matters.
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "git was not found on PATH".to_string(),
            _ => format!("git could not be run: {e}"),
        })?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("git could not be read: {e}"))?;
                let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
                text.push_str(&String::from_utf8_lossy(&output.stderr));
                let text = text.trim().to_string();

                return if status.success() {
                    Ok(text)
                } else if text.is_empty() {
                    Err(format!("git exited with {status}"))
                } else {
                    Err(text)
                };
            }
            Ok(None) => {
                if started.elapsed() > NETWORK_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {} took longer than {} seconds and was stopped. \
                         If it is waiting for a password or a passphrase, run it \
                         in the terminal once so your credential helper has it.",
                        args.first().copied().unwrap_or("command"),
                        NETWORK_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(format!("git could not be waited on: {e}")),
        }
    }
}

/// The repository top level for a directory, or `None` if it isn't in one.
pub fn top_level(dir: &Path) -> Option<PathBuf> {
    // `--show-toplevel` is empty inside a bare repository, which has no working
    // tree and so nothing for the editor to decorate.
    let output = git(dir, &["rev-parse", "--show-toplevel"]).ok()?;
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Checks a repo-relative path before it goes back to git as an argument.
///
/// These come from git's own output and are round-tripped unchanged in the
/// normal case, so this is about the abnormal one: a path with `..` in it would
/// let a staging or discard argument name a file outside the repository
/// entirely. Absolute paths are refused for the same reason, and `--`-prefixed
/// ones because git would read them as options.
pub fn relative_arg(relative: &str) -> Result<&str, String> {
    if relative.is_empty() {
        return Err("No file given".into());
    }
    if relative.starts_with('-') {
        return Err(format!("{relative} is not a valid path"));
    }
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(format!("{relative} is outside the repository"));
    }
    Ok(relative)
}

/// Joins a repo-relative path onto the top level in the platform's own form.
fn absolute(root: &Path, relative: &str) -> String {
    let mut path = root.to_path_buf();
    for segment in relative.split('/') {
        path.push(segment);
    }
    path.to_string_lossy().into_owned()
}

// ─── Status ─────────────────────────────────────────────────────────────────

fn change_of(code: char) -> Option<GitChange> {
    match code {
        'M' => Some(GitChange::Modified),
        'A' => Some(GitChange::Added),
        'D' => Some(GitChange::Deleted),
        'R' => Some(GitChange::Renamed),
        'C' => Some(GitChange::Copied),
        'T' => Some(GitChange::TypeChanged),
        // '.' is v2's "unmodified on this side"; anything else is a code from a
        // newer git than this parser knows, and pretending it means nothing is
        // better than guessing.
        _ => None,
    }
}

/// Branch, upstream divergence and every changed file.
pub fn status(dir: &Path) -> Result<GitRepo, String> {
    let Some(root) = top_level(dir) else {
        return Ok(GitRepo::not_a_repo());
    };

    /*
      `-uall` rather than the default, which collapses an untracked directory to
      a single `dir/` entry. The file tree decorates rows, and a folder marked
      untracked with no marks on the files inside it reads as a bug.

      `--no-renames` is *not* passed: a rename shown as a delete plus an add is
      exactly the noise this panel exists to avoid.
    */
    let raw = git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?;

    let mut repo = GitRepo {
        is_repo: true,
        root: Some(root.to_string_lossy().into_owned()),
        ..GitRepo::not_a_repo()
    };

    // `-z` makes every record NUL-terminated, which is the only form that
    // survives a filename with a newline in it. A rename record carries its
    // original path as a *second* field, so the iterator has to be advanced by
    // hand rather than looped over.
    let mut fields = raw.split('\0').filter(|f| !f.is_empty());

    while let Some(record) = fields.next() {
        if repo.files.len() >= MAX_FILES {
            repo.truncated = true;
            break;
        }

        let Some((tag, rest)) = record.split_once(' ') else {
            continue;
        };

        match tag {
            "#" => read_header(&mut repo, rest),

            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
            "1" => {
                if let Some((staged, unstaged, path)) = ordinary(rest, ORDINARY_SKIP) {
                    repo.files.push(GitFile {
                        path: absolute(&root, path),
                        relative: path.to_string(),
                        from: None,
                        staged,
                        unstaged,
                    });
                }
            }

            // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`, then
            // the original path as the next NUL-terminated field.
            "2" => {
                let from = fields.next().map(str::to_string);
                if let Some((staged, unstaged, path)) = ordinary(rest, RENAME_SKIP) {
                    repo.files.push(GitFile {
                        path: absolute(&root, path),
                        relative: path.to_string(),
                        from,
                        staged,
                        unstaged,
                    });
                }
            }

            // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
            "u" => {
                if let Some(path) = unmerged_path(rest) {
                    repo.files.push(GitFile {
                        path: absolute(&root, path),
                        relative: path.to_string(),
                        from: None,
                        staged: None,
                        unstaged: Some(GitChange::Conflicted),
                    });
                }
            }

            "?" => repo.files.push(GitFile {
                path: absolute(&root, rest),
                relative: rest.to_string(),
                from: None,
                staged: None,
                unstaged: Some(GitChange::Untracked),
            }),

            // `!` is an ignored path, which is only emitted with
            // `--ignored` and isn't asked for.
            _ => {}
        }
    }

    Ok(repo)
}

fn read_header(repo: &mut GitRepo, rest: &str) {
    let Some((key, value)) = rest.split_once(' ') else {
        return;
    };
    match key {
        "branch.head" => {
            if value == "(detached)" {
                repo.detached = true;
            } else {
                repo.branch = Some(value.to_string());
            }
        }
        "branch.upstream" => repo.upstream = Some(value.to_string()),
        // `+1 -2`. Absent entirely when there is no upstream.
        "branch.ab" => {
            for part in value.split_whitespace() {
                let (sign, count) = part.split_at(1);
                let Ok(count) = count.parse::<u32>() else {
                    continue;
                };
                match sign {
                    "+" => repo.ahead = count,
                    "-" => repo.behind = count,
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/*
  How many space-separated fields precede the path in each record shape, counted
  from just after the leading tag. Off by one and the path silently comes back
  with an object hash glued to the front, which is not a path but is a string —
  so nothing errors, the tree shows a plausible-looking name, and every `git`
  argument built from it fails.

    1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
    u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>

  The tests at the bottom of this file exist because of that failure mode.
*/
const ORDINARY_SKIP: usize = 7;
const RENAME_SKIP: usize = 8;
const UNMERGED_SKIP: usize = 9;

/// Splits a `1`/`2` record into its two status codes and its path.
///
/// The path is whatever is left after `skip` fields, taken in one piece: it can
/// contain spaces, so it must not be split.
fn ordinary(rest: &str, skip: usize) -> Option<(Option<GitChange>, Option<GitChange>, &str)> {
    let mut codes = rest.chars();
    let staged = change_of(codes.next()?);
    let unstaged = change_of(codes.next()?);

    let mut remainder = rest;
    for _ in 0..skip {
        remainder = remainder.split_once(' ')?.1;
    }
    Some((staged, unstaged, remainder))
}

fn unmerged_path(rest: &str) -> Option<&str> {
    let mut remainder = rest;
    for _ in 0..UNMERGED_SKIP {
        remainder = remainder.split_once(' ')?.1;
    }
    Some(remainder)
}

// ─── Per-file changes ───────────────────────────────────────────────────────

/// Which lines of a file differ from HEAD.
///
/// `--unified=0` so each hunk header describes exactly the changed run and
/// nothing around it, which is all a change gutter can draw. The bodies are
/// ignored — only the `@@` lines are read — so this stays cheap on a file with
/// a large diff.
pub fn file_hunks(root: &Path, relative: &str) -> Result<GitFileDiff, String> {
    let relative = relative_arg(relative)?;

    let raw = git(
        root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--unified=0",
            "HEAD",
            "--",
            relative,
        ],
    )
    // A repository with no commits yet has no HEAD to diff against, and every
    // file in it is new. Treating that as "untracked" is both true and what the
    // caller already knows how to draw.
    .unwrap_or_default();

    if raw.trim().is_empty() {
        return Ok(GitFileDiff {
            untracked: !is_tracked(root, relative),
            hunks: Vec::new(),
        });
    }

    let mut hunks = Vec::new();
    for line in raw.lines() {
        if !line.starts_with("@@") {
            continue;
        }
        if let Some(hunk) = parse_hunk_header(line) {
            hunks.push(hunk);
        }
    }

    Ok(GitFileDiff {
        untracked: false,
        hunks,
    })
}

/// `@@ -old,oldLines +new,newLines @@` → one [`GitHunk`].
///
/// A missing count means one line, per the unified-diff format. A `newLines` of
/// zero is a pure deletion, and its `new` is the line the removed text used to
/// follow — so the marker belongs on the line after it, which is where the gap
/// now is.
fn parse_hunk_header(header: &str) -> Option<GitHunk> {
    let inner = header.strip_prefix("@@ ")?;
    let inner = inner.split(" @@").next()?;
    let (old, new) = inner.split_once(' ')?;

    let (_, removed) = parse_range(old.strip_prefix('-')?)?;
    let (start, added) = parse_range(new.strip_prefix('+')?)?;

    Some(if added == 0 {
        GitHunk {
            line: start.saturating_add(1).max(1),
            lines: 0,
            removed,
        }
    } else {
        GitHunk {
            line: start.max(1),
            lines: added,
            removed,
        }
    })
}

fn parse_range(text: &str) -> Option<(u32, u32)> {
    match text.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((text.parse().ok()?, 1)),
    }
}

fn is_tracked(root: &Path, relative: &str) -> bool {
    git(root, &["ls-files", "--error-unmatch", "--", relative]).is_ok()
}

/// A unified diff for one file: the working tree against HEAD.
///
/// Against HEAD rather than against the index, because that is the question the
/// panel is asking — "what would committing this file record?" — and the index
/// is not something the panel exposes. A file half-staged from the terminal
/// still shows all of its changes here, which is the honest answer.
pub fn file_diff(root: &Path, relative: &str) -> Result<String, String> {
    let relative = relative_arg(relative)?;

    let diff = git(
        root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--unified=3",
            "HEAD",
            "--",
            relative,
        ],
    )
    // No HEAD to compare against yet — a repository with no commits. Every
    // file in it is new, which the untracked path below handles.
    .unwrap_or_default();

    if !diff.trim().is_empty() {
        return Ok(diff);
    }

    // Nothing from `git diff` and the file isn't tracked: there is no blob to
    // compare against, so the diff is the whole file, added. Synthesised here
    // rather than with `--no-index` against the null device, which is spelled
    // differently on Windows and reports the path as `/dev/null` when it works.
    if is_tracked(root, relative) {
        return Ok(diff);
    }
    untracked_diff(root, relative)
}

fn untracked_diff(root: &Path, relative: &str) -> Result<String, String> {
    let mut path = root.to_path_buf();
    for segment in relative.split('/') {
        path.push(segment);
    }

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_UNTRACKED_DIFF_BYTES {
        return Err(format!(
            "{relative} is too large to show as a diff ({} MB)",
            size / (1024 * 1024)
        ));
    }

    let Ok(content) = std::fs::read_to_string(&path) else {
        return Err(format!("{relative} is not a text file"));
    };

    let lines: Vec<&str> = content.lines().collect();
    let mut out = format!("diff --git a/{relative} b/{relative}\nnew file\n--- /dev/null\n+++ b/{relative}\n");
    out.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    for line in lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

// ─── Changing things ────────────────────────────────────────────────────────

fn with_paths(root: &Path, leading: &[&str], relatives: &[String]) -> Result<(), String> {
    if relatives.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = leading.to_vec();
    args.push("--");
    for relative in relatives {
        args.push(relative_arg(relative)?);
    }
    git(root, &args).map(|_| ())
}

/// Stages paths. `git add` covers a modification, a new file and a deletion
/// alike, so the panel doesn't have to know which it is looking at.
pub fn stage(root: &Path, relatives: &[String]) -> Result<(), String> {
    with_paths(root, &["add"], relatives)
}

/// Unstages paths, leaving the working tree alone.
///
/// `reset -q HEAD --` rather than `restore --staged`: the latter arrived in git
/// 2.23 and this is the spelling that works on whatever git the user has.
pub fn unstage(root: &Path, relatives: &[String]) -> Result<(), String> {
    with_paths(root, &["reset", "-q", "HEAD"], relatives)
}

/// Throws away unstaged working-tree changes to tracked paths.
///
/// Tracked only. An untracked file has no version to restore, and deleting it
/// belongs to the filesystem layer, which puts it in the trash — a `git clean`
/// here would destroy it outright.
pub fn discard(root: &Path, relatives: &[String]) -> Result<(), String> {
    with_paths(root, &["checkout", "-q"], relatives)
}

/// Commits what is staged, returning git's own summary line.
pub fn commit(root: &Path, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("A commit needs a message".into());
    }
    // `--` isn't used and no pathspec is passed: this commits the index as the
    // user staged it, which is what the panel shows.
    git(root, &["commit", "-m", message]).map(|out| {
        out.lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Committed")
            .trim()
            .to_string()
    })
}

// ─── History ────────────────────────────────────────────────────────────────

/// Checks an object name before it becomes a git argument.
///
/// These come from this module's own `log` output, so the check is for the
/// abnormal case: anything that isn't hex cannot be a commit, and refusing it
/// here is what stops a revision argument ever being read as an option.
fn revision_arg(sha: &str) -> Result<&str, String> {
    let valid = sha.len() >= 4
        && sha.len() <= 40
        && sha.chars().all(|c| c.is_ascii_hexdigit());
    if valid {
        Ok(sha)
    } else {
        Err(format!("{sha} is not a commit"))
    }
}

/// The same fields the list shows, for one commit.
fn log_one(root: &Path, sha: &str) -> Result<GitCommit, String> {
    log_range(root, &["--max-count=1", sha])?
        .into_iter()
        .next()
        .ok_or_else(|| format!("{sha} is not a commit in this repository"))
}

/// One page of `git log`, newest first.
pub fn log(root: &Path, limit: usize, skip: usize) -> Result<Vec<GitCommit>, String> {
    let limit = format!("--max-count={}", limit.clamp(1, 500));
    let skip = format!("--skip={skip}");
    log_range(root, &[&limit, &skip])
}

/// `git log` with the fields the UI needs, over whatever range is given.
fn log_range(root: &Path, args: &[&str]) -> Result<Vec<GitCommit>, String> {
    let format = format!(
        "--format=%H{FIELD}%h{FIELD}%an{FIELD}%ae{FIELD}%aI{FIELD}%s{FIELD}%D{FIELD}%P{RECORD}"
    );
    let mut all = vec!["log", "--no-color", &format];
    all.extend_from_slice(args);

    let raw = match git(root, &all) {
        Ok(raw) => raw,
        // A repository with no commits has no history, which is not an error —
        // it is the state every repository starts in.
        Err(_) => return Ok(Vec::new()),
    };

    Ok(raw
        .split(RECORD)
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            if record.trim().is_empty() {
                return None;
            }
            let mut fields = record.split(FIELD);
            Some(GitCommit {
                sha: fields.next()?.to_string(),
                short: fields.next()?.to_string(),
                author: fields.next()?.to_string(),
                email: fields.next()?.to_string(),
                date: fields.next()?.to_string(),
                subject: fields.next()?.to_string(),
                refs: fields.next()?.to_string(),
                // More than one parent is a merge, which decides how its diff
                // has to be asked for below.
                merge: fields.next()?.split_whitespace().count() > 1,
            })
        })
        .collect())
}

/// The body of a commit's message, and everything it touched.
///
/// One call rather than three, because it is one click. `--first-parent` is on
/// both halves: `git show` on a merge prints nothing at all without it, and
/// against the first parent it shows what the merge brought in, which is the
/// question anyone opening one is asking.
pub fn commit_detail(root: &Path, sha: &str) -> Result<GitCommitDetail, String> {
    let sha = revision_arg(sha)?;

    // The subject line and the rest of the metadata come from the same place
    // the list does, so the drawer and the row it was opened from can never
    // disagree about what a commit says.
    let commit = log_one(root, sha)?;

    let raw = git(
        root,
        &[
            "show",
            &format!("--format=%b{RECORD}"),
            "--name-status",
            "--no-color",
            "--first-parent",
            "-z",
            sha,
        ],
    )?;

    // The format output comes first, terminated by the record separator; the
    // name-status records follow it.
    let (body, names) = raw.split_once(RECORD).unwrap_or(("", raw.as_str()));

    let mut files = statuses(names);
    apply_counts(root, sha, &mut files)?;

    Ok(GitCommitDetail {
        commit,
        body: body.trim_end().to_string(),
        files,
    })
}

/// Parses `show --name-status -z` records.
///
/// `<status>\0<path>\0`, or `<status>\0<from>\0<to>\0` for a rename or a copy
/// — so the status decides how many fields to take, and miscounting turns one
/// file's status into the next one's path.
///
/// The status is *trimmed* before its letter is read, which is not fussiness.
/// With a non-empty `--format` git separates the two outputs with a NUL and a
/// newline, so the first record arrives as `"\nM"` — and `'\n'` is not a status
/// letter, so it fell through to the default and reported the first file in
/// every commit as modified whatever it actually was.
fn statuses(raw: &str) -> Vec<GitCommitFile> {
    let mut files = Vec::new();
    let mut fields = raw
        .split('\0')
        .map(str::trim)
        .filter(|f| !f.is_empty());

    while let Some(status) = fields.next() {
        let code = status.chars().next().unwrap_or('?');
        let renamed = matches!(code, 'R' | 'C');
        let first = match fields.next() {
            Some(path) => path,
            None => break,
        };
        let (from, relative) = if renamed {
            match fields.next() {
                Some(to) => (Some(first.to_string()), to),
                None => break,
            }
        } else {
            (None, first)
        };

        files.push(GitCommitFile {
            relative: relative.to_string(),
            change: change_of(code).unwrap_or(GitChange::Modified),
            from,
            added: 0,
            removed: 0,
        });
    }

    files
}

/// Fills in the line counts from `--numstat`, matched by path.
///
/// A second call because `--name-status` and `--numstat` are two output
/// formats, not two columns of one: asking for both in a single `git show`
/// prints one block after the other, which is more parsing than running it
/// twice and joining on the path.
fn apply_counts(root: &Path, sha: &str, files: &mut [GitCommitFile]) -> Result<(), String> {
    let raw = git(
        root,
        &[
            "show",
            "--numstat",
            "--format=",
            "--no-color",
            "--first-parent",
            "-z",
            sha,
        ],
    )?;

    let mut fields = raw.split('\0').filter(|f| !f.is_empty()).peekable();
    while let Some(record) = fields.next() {
        // `<added>\t<removed>\t<path>`, and for a rename the path is *empty* and
        // the two paths follow as their own NUL-terminated fields.
        let mut parts = record.split('\t');
        let added = parts.next().unwrap_or("0");
        let removed = parts.next().unwrap_or("0");
        let inline = parts.next().unwrap_or("");

        let path = if inline.is_empty() {
            // Skip the source, keep the destination — the name-status pass
            // keyed these files by where they ended up.
            fields.next();
            match fields.next() {
                Some(to) => to.to_string(),
                None => break,
            }
        } else {
            inline.to_string()
        };

        // A binary file is reported as `-` on both counts: there are no lines
        // to count, which is not the same as none having changed.
        let added: u32 = added.parse().unwrap_or(0);
        let removed: u32 = removed.parse().unwrap_or(0);

        if let Some(file) = files.iter_mut().find(|f| f.relative == path) {
            file.added = added;
            file.removed = removed;
        }
    }

    Ok(())
}

/// One file's diff as a commit left it.
pub fn commit_diff(root: &Path, sha: &str, relative: &str) -> Result<String, String> {
    let sha = revision_arg(sha)?;
    let relative = relative_arg(relative)?;
    git(
        root,
        &[
            "show",
            "--no-color",
            "--no-ext-diff",
            "--unified=3",
            "--format=",
            "--first-parent",
            sha,
            "--",
            relative,
        ],
    )
}

// ─── Talking to a remote ────────────────────────────────────────────────────

fn current_branch(root: &Path) -> Result<String, String> {
    git(root, &["symbolic-ref", "--short", "HEAD"])
        .map(|out| out.trim().to_string())
        .map_err(|_| "HEAD is detached, so there is no branch to push".to_string())
}

/// The remote to publish a new branch to.
///
/// `origin` when it exists, the only one when there is exactly one, and
/// otherwise an honest refusal: picking between three remotes on the user's
/// behalf is how a branch ends up on the wrong one.
fn default_remote(root: &Path) -> Result<String, String> {
    let raw = git(root, &["remote"])?;
    let remotes: Vec<&str> = raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect();

    if remotes.iter().any(|r| *r == "origin") {
        return Ok("origin".to_string());
    }
    match remotes.as_slice() {
        [] => Err("This repository has no remotes".to_string()),
        [only] => Ok((*only).to_string()),
        _ => Err(format!(
            "This repository has several remotes ({}) and no `origin`, so push it              from the terminal once to choose one",
            remotes.join(", ")
        )),
    }
}

fn has_upstream(root: &Path) -> bool {
    git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_ok()
}

/// Updates the remote-tracking refs. Changes nothing in the working tree.
pub fn fetch(root: &Path) -> Result<String, String> {
    // `--prune`, so a branch deleted on the remote stops being reported as
    // something this repository has.
    git_network(root, &["fetch", "--prune"])
}

/// Pushes the current branch, setting its upstream the first time.
///
/// Pull is deliberately not here. A pull merges, a merge conflicts, and a
/// conflict needs somewhere to be resolved — which is a feature of its own and
/// not one this panel has. Fetch tells you that you are behind; the shell three
/// inches away does the rest.
pub fn push(root: &Path) -> Result<String, String> {
    if has_upstream(root) {
        return git_network(root, &["push"]);
    }
    let remote = default_remote(root)?;
    let branch = current_branch(root)?;
    git_network(root, &["push", "--set-upstream", &remote, &branch])
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `status --porcelain=v2` output, one of each record shape.
    ///
    /// The field counts are the whole risk in this parser: they are positional,
    /// git will never tell us they are wrong, and a path with an object hash on
    /// the front is still a perfectly good `String`.
    #[test]
    fn ordinary_record_path_excludes_the_object_names() {
        let rest = ".M N... 100644 100644 100644 681c3788 681c3788 README.md";
        let (staged, unstaged, path) = ordinary(rest, ORDINARY_SKIP).unwrap();
        assert_eq!(path, "README.md");
        assert_eq!(staged, None);
        assert_eq!(unstaged, Some(GitChange::Modified));
    }

    #[test]
    fn ordinary_record_keeps_spaces_in_a_path() {
        let rest = "A. N... 000000 100644 100644 00000000 f712020c docs/my notes.md";
        let (staged, unstaged, path) = ordinary(rest, ORDINARY_SKIP).unwrap();
        assert_eq!(path, "docs/my notes.md");
        assert_eq!(staged, Some(GitChange::Added));
        assert_eq!(unstaged, None);
    }

    #[test]
    fn rename_record_skips_the_similarity_score() {
        let rest = "R. N... 100644 100644 100644 681c3788 681c3788 R100 new/name.rs";
        let (staged, _, path) = ordinary(rest, RENAME_SKIP).unwrap();
        assert_eq!(path, "new/name.rs");
        assert_eq!(staged, Some(GitChange::Renamed));
    }

    #[test]
    fn unmerged_record_skips_all_three_stages() {
        let rest = "UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.rs";
        assert_eq!(unmerged_path(rest), Some("src/conflict.rs"));
    }

    #[test]
    fn hunk_header_with_counts() {
        let hunk = parse_hunk_header("@@ -10,3 +12,5 @@ fn thing() {").unwrap();
        assert_eq!(hunk.line, 12);
        assert_eq!(hunk.lines, 5);
        assert_eq!(hunk.removed, 3);
    }

    /// A missing count means one line, per the unified-diff format.
    #[test]
    fn hunk_header_without_counts() {
        let hunk = parse_hunk_header("@@ -4 +4 @@").unwrap();
        assert_eq!(hunk.line, 4);
        assert_eq!(hunk.lines, 1);
        assert_eq!(hunk.removed, 1);
    }

    /// A pure addition: nothing removed, so the run is new rather than changed.
    #[test]
    fn hunk_header_addition() {
        let hunk = parse_hunk_header("@@ -7,0 +8,4 @@").unwrap();
        assert_eq!(hunk.line, 8);
        assert_eq!(hunk.lines, 4);
        assert_eq!(hunk.removed, 0);
    }

    /// A pure deletion has no lines of its own; the marker goes on the line the
    /// gap is now above.
    #[test]
    fn hunk_header_deletion() {
        let hunk = parse_hunk_header("@@ -9,3 +8,0 @@").unwrap();
        assert_eq!(hunk.line, 9);
        assert_eq!(hunk.lines, 0);
        assert_eq!(hunk.removed, 3);
    }

    /// `<status>\0<path>\0`, with renames taking a third field. Miscount and
    /// the status of one file becomes the path of the next.
    #[test]
    fn commit_file_records_take_the_right_number_of_fields() {
        // Simulated `show --name-status -z` output: a modify, a rename, an add.
        let raw = "M\0src/lib.rs\0R100\0old/name.rs\0new/name.rs\0A\0docs/new.md\0";
        let mut fields = raw.split('\0').filter(|f| !f.is_empty());
        let mut seen = Vec::new();
        while let Some(status) = fields.next() {
            let code = status.chars().next().unwrap();
            let first = fields.next().unwrap();
            let path = if matches!(code, 'R' | 'C') {
                fields.next().unwrap()
            } else {
                first
            };
            seen.push((code, path.to_string()));
        }
        assert_eq!(
            seen,
            vec![
                ('M', "src/lib.rs".to_string()),
                ('R', "new/name.rs".to_string()),
                ('A', "docs/new.md".to_string()),
            ]
        );
    }

    /// `--numstat -z` puts a rename's paths in their own fields and leaves the
    /// inline path *empty* — verified against a real `git show`, because it is
    /// not what the non-`-z` format looks like.
    #[test]
    fn numstat_records_handle_a_rename() {
        let raw = "79\t2\tREADME.md\0" // an ordinary change
            .to_string()
            + "1\t0\t\0old.txt\0new.txt\0" // a rename
            + "-\t-\tlogo.png\0"; // a binary file

        let mut files = vec![
            GitCommitFile {
                relative: "README.md".into(),
                change: GitChange::Modified,
                from: None,
                added: 0,
                removed: 0,
            },
            GitCommitFile {
                relative: "new.txt".into(),
                change: GitChange::Renamed,
                from: Some("old.txt".into()),
                added: 0,
                removed: 0,
            },
            GitCommitFile {
                relative: "logo.png".into(),
                change: GitChange::Modified,
                from: None,
                added: 0,
                removed: 0,
            },
        ];

        // The body of `apply_counts`, without the subprocess.
        let mut fields = raw.split('\0').filter(|f| !f.is_empty()).peekable();
        while let Some(record) = fields.next() {
            let mut parts = record.split('\t');
            let added = parts.next().unwrap_or("0");
            let removed = parts.next().unwrap_or("0");
            let inline = parts.next().unwrap_or("");
            let path = if inline.is_empty() {
                fields.next();
                match fields.next() {
                    Some(to) => to.to_string(),
                    None => break,
                }
            } else {
                inline.to_string()
            };
            if let Some(file) = files.iter_mut().find(|f| f.relative == path) {
                file.added = added.parse().unwrap_or(0);
                file.removed = removed.parse().unwrap_or(0);
            }
        }

        assert_eq!((files[0].added, files[0].removed), (79, 2));
        assert_eq!((files[1].added, files[1].removed), (1, 0));
        // Binary: `-` on both counts, which is not the same as unchanged.
        assert_eq!((files[2].added, files[2].removed), (0, 0));
    }

    /// The regression above: git glues a newline to the first status when the
    /// `--format` is not empty, and `A` must still come back as an addition.
    #[test]
    fn status_records_survive_the_separator_git_puts_before_them() {
        let raw = "\0\nA\0src/new.rs\0D\0src/old.rs\0";
        let files = statuses(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].relative, "src/new.rs");
        assert_eq!(files[0].change, GitChange::Added);
        assert_eq!(files[1].relative, "src/old.rs");
        assert_eq!(files[1].change, GitChange::Deleted);
    }

    #[test]
    fn revision_arg_accepts_only_object_names() {
        assert!(revision_arg("3b11460").is_ok());
        assert!(revision_arg("4595984f3c8850d67e1b0496fe95ba7901dc9df4").is_ok());
        assert!(revision_arg("HEAD").is_err());
        assert!(revision_arg("--upload-pack=x").is_err());
        assert!(revision_arg("main").is_err());
        assert!(revision_arg("abc").is_err());
    }

    #[test]
    fn relative_arg_refuses_to_leave_the_repository() {
        assert!(relative_arg("src/lib.rs").is_ok());
        assert!(relative_arg("../secrets").is_err());
        assert!(relative_arg("a/../../b").is_err());
        assert!(relative_arg("--upload-pack=x").is_err());
        assert!(relative_arg("").is_err());
    }
}

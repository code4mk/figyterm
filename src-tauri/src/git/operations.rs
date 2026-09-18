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
use std::collections::HashSet;
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
    /// A merge is in progress and has stopped, conflicted or not.
    pub merging: bool,
    /// What is being merged in, as git recorded it — `feature/x`, or a SHA.
    pub merge_head: Option<String>,
}

impl GitRepo {
    fn not_a_repo() -> Self {
        GitRepo {
            is_repo: false,
            root: None,
            branch: None,
            detached: false,
            upstream: None,
            merging: false,
            merge_head: None,
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
    /// On this branch but not on its upstream: committed here and nowhere else.
    pub unpushed: bool,
}

/// How far back commits are checked against the upstream.
///
/// A branch further ahead than this is not one anybody is reading the top of,
/// and the marking is per-commit decoration rather than something correctness
/// rests on.
const UNPUSHED_SCAN: usize = 1_000;

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
/// How many ignored entries are worth returning.
///
/// Directories are collapsed by `--directory`, so a normal project produces a
/// handful — `node_modules`, `dist`, `.env`. A repository with tens of
/// thousands of individually-ignored files exists, and listing all of them to
/// grey out rows nobody will scroll to is not worth the memory.
const MAX_IGNORED: usize = 5_000;

/// The paths git is ignoring, with directories collapsed.
///
/// `--directory` is what makes this cheap: without it, a project with
/// `node_modules` in `.gitignore` returns every file underneath it, and the
/// answer is forty thousand paths describing one fact. With it, the answer is
/// `node_modules/`, and the caller treats anything beneath a returned directory
/// as ignored too.
///
/// Absolute paths, because that is what the explorer and the editor key on.
pub fn ignored(dir: &Path) -> Result<Vec<String>, String> {
    let Some(root) = top_level(dir) else {
        return Ok(Vec::new());
    };

    let raw = git(
        &root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    )?;

    Ok(raw
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .take(MAX_IGNORED)
        // git reports a directory with a trailing slash; the caller compares
        // against filesystem paths, which do not have one.
        .map(|entry| root.join(entry.trim_end_matches('/')).to_string_lossy().into_owned())
        .collect())
}

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

    let (merging, merge_head) = merge_state(&root);
    repo.merging = merging;
    repo.merge_head = merge_head;

    Ok(repo)
}

/**
 Whether a merge has stopped part-way, and what it was merging.

 Read from the files git leaves behind rather than by asking it: `status`
 already ran, and a second process on every watcher burst — a save, a build —
 to answer a question that changes twice a month is the trade this module keeps
 refusing elsewhere.

 `.git` is a *file* in a linked worktree or a submodule, pointing at the real
 directory; only then is git asked where that is, which keeps the extra process
 to the layouts that need it.
*/
fn merge_state(root: &Path) -> (bool, Option<String>) {
    let dot_git = root.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else if dot_git.exists() {
        match git(root, &["rev-parse", "--absolute-git-dir"]) {
            Ok(path) => PathBuf::from(path.trim()),
            Err(_) => return (false, None),
        }
    } else {
        return (false, None);
    };

    if !git_dir.join("MERGE_HEAD").exists() {
        return (false, None);
    }

    // `MERGE_MSG` opens with git's own "Merge branch 'x'" line, which names the
    // branch. Without it — a merge of a bare commit — the short SHA is what
    // there is to say.
    let named = std::fs::read_to_string(git_dir.join("MERGE_MSG"))
        .ok()
        .and_then(|text| merged_branch(&text))
        .or_else(|| {
            std::fs::read_to_string(git_dir.join("MERGE_HEAD"))
                .ok()
                .map(|sha| sha.trim().chars().take(7).collect())
        });

    (true, named)
}

/// The branch name out of git's own merge message.
///
/// `Merge branch 'fix' into main` — the name is what sits between the first
/// pair of quotes. Anything else (a merge of a bare commit, an edited message)
/// names nothing, and the caller falls back to the short SHA rather than
/// guessing at a shape git did not write.
fn merged_branch(message: &str) -> Option<String> {
    let first = message.lines().next()?;
    let (_, rest) = first.split_once('\'')?;
    let (name, _) = rest.split_once('\'')?;
    (!name.is_empty()).then(|| name.to_string())
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
    let mut commit = log_range(root, &["--max-count=1", sha])?
        .into_iter()
        .next()
        .ok_or_else(|| format!("{sha} is not a commit in this repository"))?;

    // Asked the same way the list asks, so the drawer and the row it was opened
    // from cannot disagree about whether it has been pushed.
    if let Some(pending) = unpushed(root) {
        commit.unpushed = pending.contains(&commit.sha);
    }
    Ok(commit)
}

/// One page of `git log`, newest first.
pub fn log(root: &Path, limit: usize, skip: usize) -> Result<Vec<GitCommit>, String> {
    let limit = format!("--max-count={}", limit.clamp(1, 500));
    let skip = format!("--skip={skip}");
    let mut commits = log_range(root, &[&limit, &skip])?;

    if let Some(pending) = unpushed(root) {
        for commit in &mut commits {
            commit.unpushed = pending.contains(&commit.sha);
        }
    }
    Ok(commits)
}

/// Which commits the upstream hasn't got.
///
/// Asked of git rather than inferred from the `ahead` count and the list's
/// order. "The newest N are the unpushed ones" holds only while the history is
/// linear, and a branch that has merged its upstream back in is exactly the
/// case where somebody wants to know what is still local.
///
/// `None` when there is no upstream — the command fails there — and then
/// nothing is marked: on an unpublished branch every commit is unpushed, which
/// is a true fact about five hundred rows and a useful one about none of them.
/// The Publish button says it once instead.
fn unpushed(root: &Path) -> Option<HashSet<String>> {
    let limit = format!("--max-count={UNPUSHED_SCAN}");
    let raw = git(root, &["rev-list", &limit, "@{upstream}..HEAD"]).ok()?;
    Some(
        raw.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect(),
    )
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
                // Filled in by `log`, which knows about the upstream.
                unpushed: false,
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
    merge_counts(&raw, files);
    Ok(())
}

/// Joins `--numstat` output onto files already read from `--name-status`.
///
/// Split out from [`apply_counts`] because a stash's counts come from
/// `git stash show`, which is a different command producing the same bytes.
fn merge_counts(raw: &str, files: &mut [GitCommitFile]) {
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

/// The fetch URL of the remote this branch tracks, or of the default one.
///
/// Raw, exactly as git has it — `git@github.com:user/repo.git` and
/// `https://gitlab.com/user/repo.git` both come back untouched. Turning one
/// into a web address is guesswork about a forge's URL scheme and belongs in
/// the frontend next to the code that builds the rest of the path; this only
/// answers "which remote, and what is it called".
///
/// Empty rather than an error when there is no remote: a repository without
/// one is normal, and the UI simply has no link to offer.
pub fn remote_url(root: &Path) -> Result<String, String> {
    // The branch's own remote first — a fork checked out with `upstream` as
    // well as `origin` should link to the one it actually tracks.
    let named = current_branch(root)
        .ok()
        .and_then(|branch| git(root, &["config", "--get", &format!("branch.{branch}.remote")]).ok())
        .map(|out| out.trim().to_string())
        .filter(|name| !name.is_empty());

    let remote = match named.or_else(|| default_remote(root).ok()) {
        Some(remote) => remote,
        None => return Ok(String::new()),
    };

    Ok(git(root, &["remote", "get-url", &remote])
        .map(|out| out.trim().to_string())
        .unwrap_or_default())
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

/// Brings the upstream's commits into the current branch.
///
/// This used to be left out on the grounds that a pull merges, a merge
/// conflicts, and a conflict needs somewhere to be resolved. The first two are
/// still true; the third turned out to be answered already — a conflicted file
/// is a state `git status` reports, the panel draws it with its own badge, and
/// the file opens in the editor like any other. What was missing was the
/// button, not the place to resolve them.
///
/// The strategy is the user's, not ours. A repository or a user with
/// `pull.rebase` or `pull.ff` set gets exactly what they configured; only when
/// neither is set does this pick, and it picks merge — the historical default,
/// and the one that leaves a rebase out of an operation nobody asked to
/// rewrite history with. The choice has to be made *somewhere*: git 2.34 and
/// later refuse a divergent pull outright when the config is silent, which
/// would surface here as a wall of hint text instead of a pull.
pub fn pull(root: &Path) -> Result<String, String> {
    if !has_upstream(root) {
        return Err(
            "This branch has no upstream to pull from — push it first, or set one with \
             `git branch --set-upstream-to`."
                .to_string(),
        );
    }

    let configured = ["pull.rebase", "pull.ff"]
        .iter()
        .any(|key| git(root, &["config", "--get", key]).is_ok());

    if configured {
        git_network(root, &["pull"])
    } else {
        git_network(root, &["pull", "--no-rebase"])
    }
}

/// Pushes the current branch, setting its upstream the first time.
pub fn push(root: &Path) -> Result<String, String> {
    if has_upstream(root) {
        return git_network(root, &["push"]);
    }
    let remote = default_remote(root)?;
    let branch = current_branch(root)?;
    git_network(root, &["push", "--set-upstream", &remote, &branch])
}

// ─── Conflicts ──────────────────────────────────────────────────────────────

/// Where the conflict markers are in one file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictFile {
    pub relative: String,
    /// Line of each `<<<<<<<`, 1-based. Empty when the file holds no markers,
    /// which is a real and different case — see [`conflict_marks`].
    pub lines: Vec<u32>,
    /// True when the walk stopped at [`MAX_MARKS`].
    pub truncated: bool,
}

/// Cap on markers reported per file. Past this the file is the problem.
const MAX_MARKS: usize = 200;

/// Cap on reading a file to look for markers.
const MAX_MARK_SCAN_BYTES: u64 = 8 * 1024 * 1024;

/**
 Which lines each conflicted file has its markers on.

 For the dialog that answers "why can't I commit": a count and a line number
 per conflict, so the answer is a place to go rather than a list of filenames.

 An empty `lines` is not a failure. A file can be unmerged with no markers in
 it at all — deleted on one side and modified on the other, or added by both as
 different file *types* — and those conflicts are settled by choosing a whole
 side, which is what the panel's buttons already do. Saying "no markers" is
 more useful than pretending to find some.

 The marker rule is deliberately identical to the editor's, in
 `mergeConflictScan.ts`: exactly seven `<` at the start of a line, followed by a
 space or nothing. Two implementations of one rule is a duplication worth
 naming — this one reads files off disk for a summary, that one reads an open
 buffer for decorations — and both are tested against the same shapes.
*/
pub fn conflict_marks(root: &Path, paths: &[String]) -> Result<Vec<GitConflictFile>, String> {
    let mut out = Vec::with_capacity(paths.len());

    for path in paths {
        let relative = relative_arg(path)?;
        let full = root.join(relative);

        let too_big = std::fs::metadata(&full)
            .map(|meta| meta.len() > MAX_MARK_SCAN_BYTES)
            .unwrap_or(false);

        // A file that cannot be read — deleted on this side, or binary — is
        // reported with no marks rather than dropped: it is still conflicted,
        // and leaving it out of the dialog would make the count disagree with
        // the panel behind it.
        let text = if too_big {
            None
        } else {
            std::fs::read_to_string(&full).ok()
        };

        let mut lines = Vec::new();
        let mut truncated = false;
        if let Some(text) = text {
            for (index, line) in text.lines().enumerate() {
                if is_conflict_start(line) {
                    if lines.len() >= MAX_MARKS {
                        truncated = true;
                        break;
                    }
                    lines.push(index as u32 + 1);
                }
            }
        }

        out.push(GitConflictFile {
            relative: relative.to_string(),
            lines,
            truncated,
        });
    }

    Ok(out)
}

/// Exactly seven `<` at the start of a line, then a space or the end of it.
///
/// The count matters: eight is not a marker, and `<<<<<<<<` appears in enough
/// generated files and ASCII art to be worth refusing.
fn is_conflict_start(line: &str) -> bool {
    let rest = match line.strip_prefix("<<<<<<<") {
        Some(rest) => rest,
        None => return false,
    };
    !rest.starts_with('<') && (rest.is_empty() || rest.starts_with(' '))
}

/// Which side of a conflict to keep wholesale.
///
/// `Ours` is the branch that was checked out when the merge started, `Theirs`
/// the one being merged in — git's own words, and confusing enough in a rebase
/// (where they swap) that the UI says "mine" and "incoming" instead and lets
/// git keep its vocabulary down here.
#[derive(Debug, Clone, Copy)]
pub enum Side {
    Ours,
    Theirs,
}

/// Takes one whole side of each conflicted file and marks it resolved.
///
/// Two steps, and the second is the one people forget at the command line:
/// `git checkout --ours` writes the file, but the path stays *unmerged* in the
/// index until it is added, so the commit would still be refused. Doing both
/// here is what makes the button mean "resolved" rather than "rewritten".
pub fn resolve_with(root: &Path, paths: &[String], side: Side) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let checked: Vec<&str> = paths
        .iter()
        .map(|path| relative_arg(path))
        .collect::<Result<_, _>>()?;

    let flag = match side {
        Side::Ours => "--ours",
        Side::Theirs => "--theirs",
    };

    let mut args = vec!["checkout", flag, "--"];
    args.extend_from_slice(&checked);
    git(root, &args)?;

    stage(root, paths)
}

/// Marks conflicted files resolved, exactly as they now stand on disk.
///
/// This is `git add`, named for what it does here: the file has been edited by
/// hand — the markers taken out, the right lines kept — and adding it is how
/// git is told the conflict is over.
pub fn mark_resolved(root: &Path, paths: &[String]) -> Result<(), String> {
    stage(root, paths)
}

/// Abandons the merge and puts the working tree back.
pub fn merge_abort(root: &Path) -> Result<String, String> {
    git(root, &["merge", "--abort"])
}

// ─── Branches ───────────────────────────────────────────────────────────────

/// How many refs the picker will list, local and remote together.
///
/// A repository that has been fetching a busy fork for a year can carry
/// thousands of remote-tracking branches, and none of them are found by
/// scrolling. The list is filtered by typing; this only keeps the reply from
/// being a megabyte of refs nobody will read.
const MAX_BRANCHES: usize = 500;

/// A ref the branch picker can offer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// `main` for a local branch, `origin/main` for a remote-tracking one.
    pub name: String,
    pub remote: bool,
    /// The one HEAD points at. Never true for a remote branch.
    pub current: bool,
    /// What a local branch tracks, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// The tip's commit date, ISO 8601 — the picker sorts on it.
    pub date: String,
    /// The tip's subject line, so a branch name means something in the list.
    pub subject: String,
}

/// Whether a name is safe to hand git as a ref argument.
///
/// The leading dash is the one that matters: `git switch -f` is not a branch
/// called `-f`. The rest of the deny list is `git check-ref-format`'s, applied
/// here so a bad name is refused with a sentence rather than by git in the
/// middle of an operation.
fn ref_arg(name: &str) -> Result<&str, String> {
    let bad = name.is_empty()
        || name.starts_with('-')
        || name.starts_with('.')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("@{")
        || name.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        });

    if bad {
        Err(format!("{name} is not a usable branch name"))
    } else {
        Ok(name)
    }
}

/// Every local and remote-tracking branch, current first, then most recent.
pub fn branches(root: &Path) -> Result<Vec<GitBranch>, String> {
    // The full refname leads, and is only there to say which namespace the row
    // came from. Asking `show-ref` per branch would answer the same question
    // with one process per branch, which on a repository with a few hundred is
    // a noticeable pause for a fact git is already holding.
    let format = format!(
        "--format=%(refname){FIELD}%(refname:short){FIELD}%(HEAD){FIELD}%(upstream:short){FIELD}\
         %(committerdate:iso-strict){FIELD}%(contents:subject)"
    );
    let count = format!("--count={MAX_BRANCHES}");
    let raw = git(
        root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &count,
            &format,
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    let mut out = Vec::new();
    for line in raw.lines() {
        let mut fields = line.split(FIELD);
        let full = fields.next().unwrap_or("").trim();
        let name = fields.next().unwrap_or("").trim().to_string();
        if full.is_empty() || name.is_empty() {
            continue;
        }
        // `origin/HEAD` is a symbolic ref standing for the remote's default
        // branch. Offering it would check out whatever it points at under a
        // name that isn't a branch.
        if name.ends_with("/HEAD") {
            continue;
        }

        let remote = full.starts_with("refs/remotes/");
        let current = fields.next().unwrap_or("").trim() == "*";
        let upstream = fields
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let date = fields.next().unwrap_or("").trim().to_string();
        let subject = fields.next().unwrap_or("").trim().to_string();

        out.push(GitBranch {
            name,
            remote,
            current,
            upstream,
            date,
            subject,
        });
    }

    // The branch you are on goes first however old its tip is: it is the one
    // the list is being read in relation to.
    out.sort_by_key(|branch| !branch.current);
    Ok(out)
}

/// Whether a local branch of this name exists.
///
/// Asked, not guessed from the shape of the name: a local branch called
/// `origin/thing` is legal, so "has a slash, must be remote" is wrong in
/// exactly the case where being wrong checks out the other branch.
fn name_is_local(root: &Path, name: &str) -> bool {
    git(
        root,
        &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")],
    )
    .is_ok()
}

/// Switches to `name`, creating a tracking branch for a remote one.
///
/// Picking `origin/feature` in the list means "work on that", which locally is
/// a branch of the same short name set up to track it — the DWIM that
/// `git switch` does on its own for an unambiguous name, done explicitly here
/// because the list can offer the same short name from two remotes.
pub fn switch_branch(root: &Path, name: &str, remote: bool) -> Result<String, String> {
    let name = ref_arg(name)?;

    if !remote {
        return git(root, &["switch", name]);
    }

    let local = name
        .split_once('/')
        .map(|(_, rest)| rest)
        .filter(|rest| !rest.is_empty())
        .ok_or_else(|| format!("{name} does not name a remote branch"))?;

    // Already have it locally: switch to that rather than failing on a name
    // that is taken.
    if name_is_local(root, local) {
        return git(root, &["switch", local]);
    }
    git(root, &["switch", "--track", name])
}

// ─── Stash ──────────────────────────────────────────────────────────────────

/// One entry from `git stash list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    /// The stash commit. What every operation here is keyed by; see below.
    pub sha: String,
    /// Its position at the time of listing, for the `stash@{n}` label.
    pub index: usize,
    /// The branch it was made on, from git's own subject line.
    pub branch: Option<String>,
    /// What to call it: the message given, or git's "WIP on…" line.
    pub message: String,
    pub date: String,
}

/// The branch and message out of a stash's subject.
///
/// Git writes either `WIP on main: 3b11460 subject` for an unnamed stash or
/// `On main: my message` for a named one. Anything else is handed back whole:
/// a stash from a detached HEAD says `WIP on (no branch)`, and inventing
/// structure for it would be worse than showing what git said.
fn parse_stash_subject(subject: &str) -> (Option<String>, String) {
    for prefix in ["WIP on ", "On "] {
        if let Some(rest) = subject.strip_prefix(prefix) {
            if let Some((branch, message)) = rest.split_once(": ") {
                let branch = branch.trim();
                let named = (!branch.is_empty() && branch != "(no branch)")
                    .then(|| branch.to_string());
                return (named, message.trim().to_string());
            }
        }
    }
    (None, subject.trim().to_string())
}

pub fn stash_list(root: &Path) -> Result<Vec<GitStash>, String> {
    let format = format!("--format=%H{FIELD}%gs{FIELD}%cI");
    let raw = git(root, &["stash", "list", &format])?;

    Ok(raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(index, line)| {
            let mut fields = line.split(FIELD);
            let sha = fields.next().unwrap_or("").trim().to_string();
            let (branch, message) = parse_stash_subject(fields.next().unwrap_or(""));
            let date = fields.next().unwrap_or("").trim().to_string();
            GitStash {
                sha,
                index,
                branch,
                message,
                date,
            }
        })
        .collect())
}

/// Puts the working tree away, optionally under a name.
///
/// Untracked files go too. Leaving them behind is the behaviour that makes
/// people think a stash "didn't work": you stash to get a clean tree, switch
/// branch, and the new file you had just created is still sitting there — and
/// on a branch where it does not belong.
pub fn stash_push(root: &Path, message: &str) -> Result<String, String> {
    let message = message.trim();
    let mut args = vec!["stash", "push", "--include-untracked"];
    if !message.is_empty() {
        args.push("--message");
        args.push(message);
    }
    git(root, &args)
}

/// The `stash@{n}` for a stash commit, resolved fresh.
///
/// Indices are positions in a stack, so every push and drop renumbers every
/// entry below. The frontend holds a list from whenever it last looked, and
/// acting on the index it remembers is how the wrong stash gets dropped. The
/// SHA is stable, so it is what crosses the wire and this turns it back into
/// the reference git's commands take.
fn stash_ref(root: &Path, sha: &str) -> Result<String, String> {
    let sha = revision_arg(sha)?;
    stash_list(root)?
        .into_iter()
        .find(|stash| stash.sha.starts_with(sha) || sha.starts_with(&stash.sha))
        .map(|stash| format!("stash@{{{}}}", stash.index))
        .ok_or_else(|| "That stash is no longer in the list.".to_string())
}

/// What a stash would bring back, as a file list.
///
/// `git stash show` rather than `git show`: a stash is a merge commit whose
/// *third* parent holds the untracked files, so `git show --first-parent` —
/// what the commit drawer uses — would list the tracked changes and quietly
/// omit the new files. Since these stashes are made with
/// `--include-untracked`, omitting them would hide exactly the work that is
/// easiest to forget having stashed.
pub fn stash_files(root: &Path, sha: &str) -> Result<Vec<GitCommitFile>, String> {
    let reference = stash_ref(root, sha)?;

    // `--include-untracked` reached `git stash show` in 2.32. Older git refuses
    // the option outright, so the second attempt drops it and lists the tracked
    // changes — a shorter answer, not a failed one.
    let show = |format: &str| -> Result<String, String> {
        let with = ["stash", "show", "--include-untracked", format, "--no-color", "-z", &reference];
        match git(root, &with) {
            Ok(raw) => Ok(raw),
            Err(_) => git(root, &["stash", "show", format, "--no-color", "-z", &reference]),
        }
    };

    let mut files = statuses(&show("--name-status")?);
    merge_counts(&show("--numstat")?, &mut files);

    Ok(files)
}

/// Restores a stash. `pop` also removes it once it has applied cleanly.
pub fn stash_restore(root: &Path, sha: &str, pop: bool) -> Result<String, String> {
    let reference = stash_ref(root, sha)?;
    git(root, &["stash", if pop { "pop" } else { "apply" }, &reference])
}

pub fn stash_drop(root: &Path, sha: &str) -> Result<String, String> {
    let reference = stash_ref(root, sha)?;
    git(root, &["stash", "drop", &reference])
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

    #[test]
    fn ref_arg_takes_the_branch_names_people_actually_use() {
        assert!(ref_arg("main").is_ok());
        assert!(ref_arg("feature/code-editor").is_ok());
        assert!(ref_arg("origin/feature/code-editor").is_ok());
        assert!(ref_arg("release-1.2.3").is_ok());
        assert!(ref_arg("fix_#42").is_ok());
    }

    #[test]
    fn ref_arg_refuses_what_git_would_refuse_or_misread() {
        // The one with teeth: an argument starting with a dash is an option.
        assert!(ref_arg("-f").is_err());
        assert!(ref_arg("--track=evil").is_err());
        assert!(ref_arg("").is_err());
        assert!(ref_arg("has space").is_err());
        assert!(ref_arg("a..b").is_err());
        assert!(ref_arg("main@{1}").is_err());
        assert!(ref_arg("head:ref").is_err());
        assert!(ref_arg("star*").is_err());
        assert!(ref_arg("tilde~1").is_err());
        assert!(ref_arg(".hidden").is_err());
        assert!(ref_arg("trailing.").is_err());
        assert!(ref_arg("branch.lock").is_err());
    }

    #[test]
    fn a_conflict_marker_is_exactly_seven_angle_brackets() {
        assert!(is_conflict_start("<<<<<<< HEAD"));
        assert!(is_conflict_start("<<<<<<<"));
        // Eight is not a marker, and neither is one that has been indented or
        // quoted — which is how this text appears in documentation and in the
        // editor's own source.
        assert!(!is_conflict_start("<<<<<<<< HEAD"));
        assert!(!is_conflict_start("  <<<<<<< HEAD"));
        assert!(!is_conflict_start("// <<<<<<< HEAD"));
        assert!(!is_conflict_start("<<<<<<<HEAD"));
        assert!(!is_conflict_start("<<<<<< HEAD"));
        assert!(!is_conflict_start(""));
    }

    #[test]
    fn a_merge_message_names_the_branch_between_its_quotes() {
        // Exactly what git writes into `.git/MERGE_MSG`.
        assert_eq!(merged_branch("Merge branch 'feature/thing'\n"), Some("feature/thing".into()));
        assert_eq!(
            merged_branch("Merge branch 'fix' into main\n\n# Conflicts:\n#\tf.txt\n"),
            Some("fix".into())
        );
        assert_eq!(merged_branch("Merge remote-tracking branch 'origin/main'"), Some("origin/main".into()));
    }

    #[test]
    fn a_merge_message_without_a_branch_names_nothing() {
        // A merge of a bare commit: the caller falls back to the short SHA.
        assert_eq!(merged_branch("Merge commit 3b11460"), None);
        assert_eq!(merged_branch(""), None);
    }

    #[test]
    fn stash_subject_splits_git_own_two_shapes() {
        assert_eq!(
            parse_stash_subject("WIP on main: 3b11460 Add the thing"),
            (Some("main".into()), "3b11460 Add the thing".into())
        );
        assert_eq!(
            parse_stash_subject("On feature/code-editor: half a refactor"),
            (Some("feature/code-editor".into()), "half a refactor".into())
        );
    }

    #[test]
    fn a_stash_from_a_detached_head_names_no_branch() {
        let (branch, message) = parse_stash_subject("WIP on (no branch): 3b11460 Add the thing");
        assert_eq!(branch, None);
        assert_eq!(message, "3b11460 Add the thing");
    }

    #[test]
    fn an_unrecognised_stash_subject_is_kept_whole() {
        // Better a message that reads oddly than one invented from a shape git
        // turns out not to have written.
        assert_eq!(
            parse_stash_subject("something else entirely"),
            (None, "something else entirely".into())
        );
    }
}

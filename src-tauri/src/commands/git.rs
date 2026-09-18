//! The editor's git commands.
//!
//! The IPC surface over `git/operations.rs`, arranged the way `fs.rs` is: the
//! *directory* argument is confined to a registered workspace root before
//! anything runs, and file arguments are the repo-relative strings git itself
//! emitted, checked by `relative_arg`.
//!
//! One asymmetry worth stating, because it looks like a hole and isn't: the
//! repository top level can sit *above* the open folder — `~/project/src` open
//! on a repo rooted at `~/project` — so git legitimately reports, stages and
//! discards files the filesystem commands would refuse to touch. That is the
//! repository the user opened the editor inside, and scoping git to a
//! subdirectory of it would report a status no `git` command agrees with.

use std::path::PathBuf;

use tauri::State;

use crate::commands::fs::{resolve, FsState};
use crate::git::operations::{
    self, GitBranch, GitCommit, GitCommitDetail, GitCommitFile, GitConflictFile, GitFileDiff,
    GitRepo, GitStash, Side, LOG_PAGE,
};

/// Resolves the workspace directory, then asks git where the repository is.
///
/// Both halves are needed: the first confines what the frontend can point this
/// at, and the second is what every `git` invocation runs in.
fn repo_root(state: &State<FsState>, dir: &str) -> Result<PathBuf, String> {
    let resolved = resolve(state, dir)?;
    operations::top_level(&resolved)
        .ok_or_else(|| format!("{} is not inside a git repository", resolved.display()))
}

#[tauri::command]
pub fn git_status(state: State<FsState>, dir: String) -> Result<GitRepo, String> {
    let resolved = resolve(&state, &dir)?;
    operations::status(&resolved)
}

/// Which paths git is ignoring, for greying them out in the tree.
///
/// `async` because it shells out and the explorer asks for it on the same
/// watcher events as `git_status`; a synchronous command would run it on the
/// UI thread.
#[tauri::command(async)]
pub fn git_ignored(state: State<FsState>, dir: String) -> Result<Vec<String>, String> {
    let resolved = resolve(&state, &dir)?;
    operations::ignored(&resolved)
}

#[tauri::command]
pub fn git_file_hunks(
    state: State<FsState>,
    dir: String,
    path: String,
) -> Result<GitFileDiff, String> {
    let root = repo_root(&state, &dir)?;
    operations::file_hunks(&root, &path)
}

#[tauri::command]
pub fn git_file_diff(state: State<FsState>, dir: String, path: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::file_diff(&root, &path)
}

#[tauri::command]
pub fn git_stage(state: State<FsState>, dir: String, paths: Vec<String>) -> Result<(), String> {
    let root = repo_root(&state, &dir)?;
    operations::stage(&root, &paths)
}

#[tauri::command]
pub fn git_unstage(state: State<FsState>, dir: String, paths: Vec<String>) -> Result<(), String> {
    let root = repo_root(&state, &dir)?;
    operations::unstage(&root, &paths)
}

#[tauri::command]
pub fn git_discard(state: State<FsState>, dir: String, paths: Vec<String>) -> Result<(), String> {
    let root = repo_root(&state, &dir)?;
    operations::discard(&root, &paths)
}

#[tauri::command]
pub fn git_commit(state: State<FsState>, dir: String, message: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::commit(&root, &message)
}

#[tauri::command]
pub fn git_log(
    state: State<FsState>,
    dir: String,
    skip: usize,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>, String> {
    let root = repo_root(&state, &dir)?;
    operations::log(&root, limit.unwrap_or(LOG_PAGE), skip)
}

/// Everything the history drawer shows: the message body and the file list.
#[tauri::command]
pub fn git_commit_detail(
    state: State<FsState>,
    dir: String,
    sha: String,
) -> Result<GitCommitDetail, String> {
    let root = repo_root(&state, &dir)?;
    operations::commit_detail(&root, &sha)
}

#[tauri::command]
pub fn git_commit_diff(
    state: State<FsState>,
    dir: String,
    sha: String,
    path: String,
) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::commit_diff(&root, &sha, &path)
}

/*
  The three that reach the network are `async`, which for a non-async function
  means "run it on the threadpool". The default is `Blocking`, and blocking
  here is the event loop: a fetch over a slow link held the main thread for as
  long as it took — up to the two-minute timeout — with the window unable to
  answer anything, including the IPC that would have reported it. The panel's
  own spinner was being driven by a thread that was not going to come back.
*/

/// Updates the remote-tracking refs. Touches nothing in the working tree.
#[tauri::command(async)]
pub fn git_fetch(state: State<FsState>, dir: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::fetch(&root)
}

/// Merges (or rebases, if that is what the repository is configured for) the
/// upstream into the current branch. Unlike fetch, this touches the tree.
#[tauri::command(async)]
pub fn git_pull(state: State<FsState>, dir: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::pull(&root)
}

#[tauri::command(async)]
pub fn git_push(state: State<FsState>, dir: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::push(&root)
}

/// Where the markers are in each conflicted file, for the "why can't I
/// commit" dialog.
#[tauri::command(async)]
pub fn git_conflict_marks(
    state: State<FsState>,
    dir: String,
    paths: Vec<String>,
) -> Result<Vec<GitConflictFile>, String> {
    let root = repo_root(&state, &dir)?;
    operations::conflict_marks(&root, &paths)
}

/// Takes one whole side of a conflict, and marks those files resolved.
#[tauri::command(async)]
pub fn git_resolve_with(
    state: State<FsState>,
    dir: String,
    paths: Vec<String>,
    side: String,
) -> Result<(), String> {
    let root = repo_root(&state, &dir)?;
    let side = match side.as_str() {
        "ours" => Side::Ours,
        "theirs" => Side::Theirs,
        other => return Err(format!("{other} is not a side of a conflict")),
    };
    operations::resolve_with(&root, &paths, side)
}

/// Marks conflicted files resolved as they stand — the hand-edited case.
#[tauri::command(async)]
pub fn git_mark_resolved(
    state: State<FsState>,
    dir: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let root = repo_root(&state, &dir)?;
    operations::mark_resolved(&root, &paths)
}

#[tauri::command(async)]
pub fn git_merge_abort(state: State<FsState>, dir: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::merge_abort(&root)
}

/// Every local and remote-tracking branch, for the picker.
#[tauri::command(async)]
pub fn git_branches(state: State<FsState>, dir: String) -> Result<Vec<GitBranch>, String> {
    let root = repo_root(&state, &dir)?;
    operations::branches(&root)
}

/// Checks out a branch, creating a tracking one for a remote.
///
/// `async` like the network three: a checkout rewrites the working tree, which
/// on a large repository is seconds of disk.
#[tauri::command(async)]
pub fn git_switch(
    state: State<FsState>,
    dir: String,
    name: String,
    remote: bool,
) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::switch_branch(&root, &name, remote)
}

#[tauri::command(async)]
pub fn git_stash_list(state: State<FsState>, dir: String) -> Result<Vec<GitStash>, String> {
    let root = repo_root(&state, &dir)?;
    operations::stash_list(&root)
}

#[tauri::command(async)]
pub fn git_stash_push(
    state: State<FsState>,
    dir: String,
    message: String,
) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::stash_push(&root, &message)
}

/// Applies a stash, and with `pop` removes it once it has applied cleanly.
///
/// Keyed by the stash's own commit rather than its `stash@{n}` position; see
/// `stash_ref` for why that distinction is not pedantry.
#[tauri::command(async)]
pub fn git_stash_restore(
    state: State<FsState>,
    dir: String,
    sha: String,
    pop: bool,
) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::stash_restore(&root, &sha, pop)
}

/// The files a stash would bring back, with their line counts.
#[tauri::command(async)]
pub fn git_stash_files(
    state: State<FsState>,
    dir: String,
    sha: String,
) -> Result<Vec<GitCommitFile>, String> {
    let root = repo_root(&state, &dir)?;
    operations::stash_files(&root, &sha)
}

#[tauri::command(async)]
pub fn git_stash_drop(state: State<FsState>, dir: String, sha: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::stash_drop(&root, &sha)
}

/// The tracked remote's URL, raw. Empty when the repository has no remote.
#[tauri::command]
pub fn git_remote_url(state: State<FsState>, dir: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::remote_url(&root)
}

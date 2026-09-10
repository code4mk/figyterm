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
    self, GitCommit, GitCommitDetail, GitFileDiff, GitRepo, LOG_PAGE,
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

/// Updates the remote-tracking refs. Touches nothing in the working tree.
#[tauri::command]
pub fn git_fetch(state: State<FsState>, dir: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::fetch(&root)
}

#[tauri::command]
pub fn git_push(state: State<FsState>, dir: String) -> Result<String, String> {
    let root = repo_root(&state, &dir)?;
    operations::push(&root)
}

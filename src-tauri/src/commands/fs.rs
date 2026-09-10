//! The editor's filesystem commands.
//!
//! Every path that arrives from the frontend passes through [`resolve`] before
//! anything touches the disk: it is canonicalised — so `..`, symlinks and `~`
//! are all resolved before the check rather than after — and then required to
//! sit inside one of the workspace roots the editor has registered.
//!
//! What that is and isn't:
//!
//! - It **is** a guard against a path-handling bug turning into a write
//!   somewhere surprising, and against the editor wandering out of the project
//!   the user opened it on (a breadcrumb click, a symlinked `node_modules`, a
//!   search result outside the tree).
//! - It **is not** a sandbox. `fs_set_roots` is itself a command, so a
//!   compromised frontend could widen the roots and then read what it liked.
//!   Anything stronger has to live in Tauri's capability layer, not here.
//!
//! The actual operations are in `filesystem/operations.rs`; this module is the
//! IPC surface, the confinement, and the two things that need to stream —
//! project search and the file watcher's events.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::filesystem::operations::{
    self, Encoding, FileEntry, LineEnding, OpenedFile, SearchMatch, SearchOptions,
};

pub const SEARCH_RESULT_EVENT: &str = "editor://search-result";
pub const SEARCH_DONE_EVENT: &str = "editor://search-done";

/// Results are sent in batches: one event per match turns a busy search into
/// thousands of IPC hops and the UI spends longer re-rendering than the walker
/// spends searching.
const SEARCH_BATCH: usize = 40;

/// Where a search stops. Past a couple of thousand hits the answer is "refine
/// the query", and the results panel says so rather than pretending to be
/// exhaustive.
const SEARCH_MAX_RESULTS: usize = 2000;

/// How many paths quick open will hold. Enough for any repo somebody edits by
/// hand; past it the list says it was truncated rather than pretending.
const QUICK_OPEN_MAX_FILES: usize = 20_000;

#[derive(Default)]
pub struct FsState {
    /// Canonical, display-form paths the editor is allowed to touch.
    roots: Mutex<Vec<PathBuf>>,
    /// Bumped by every new or cancelled search, so an in-flight walk can notice
    /// it has been superseded and stop.
    search_generation: AtomicU64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WriteStatus {
    Written,
    /// The file changed since the buffer was loaded; nothing was written.
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub status: WriteStatus,
    /// After a write, the file's new mtime. After a conflict, the mtime it
    /// actually has — which is what the editor shows the diff against.
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// The canonical root the paths are relative to.
    pub root: String,
    pub files: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResultPayload {
    id: u64,
    matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDonePayload {
    id: u64,
    total: usize,
    /// False when the walk stopped at [`SEARCH_MAX_RESULTS`] rather than
    /// running out of files.
    complete: bool,
    error: Option<String>,
}

// ─── Path handling ──────────────────────────────────────────────────────────

/// Removes Windows' `\\?\` extended-length prefix.
///
/// `fs::canonicalize` always returns one there, and it must not reach the UI:
/// `\\?\C:\Users\me\project\src` is not a path anyone recognises, and it would
/// then come back through the breadcrumb and the tab title looking like that.
/// Windows accepts the stripped form for every path short enough to display,
/// and [`canonicalize`] puts the prefix back if it turns out to be needed.
#[cfg(target_os = "windows")]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(r"\\?\") {
        // A UNC share canonicalises to `\\?\UNC\server\share`; the leading
        // double backslash has to go back on or the path names nothing.
        Some(rest) => match rest.strip_prefix("UNC\\") {
            Some(unc) => PathBuf::from(format!(r"\\{unc}")),
            None => PathBuf::from(rest),
        },
        None => path,
    }
}

#[cfg(not(target_os = "windows"))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

/// Canonicalises a path that exists.
///
/// The Windows retry covers paths past the 260-character limit: those need the
/// `\\?\` prefix to be opened at all, and the frontend only ever holds the
/// stripped form.
fn canonicalize(path: &Path) -> Result<PathBuf, String> {
    match std::fs::canonicalize(path) {
        Ok(resolved) => Ok(strip_verbatim(resolved)),
        Err(first) => {
            #[cfg(target_os = "windows")]
            if path.is_absolute() && !path.to_string_lossy().starts_with(r"\\?\") {
                let prefixed = PathBuf::from(format!(r"\\?\{}", path.to_string_lossy()));
                if let Ok(resolved) = std::fs::canonicalize(&prefixed) {
                    return Ok(strip_verbatim(resolved));
                }
            }
            Err(format!("Could not resolve {}: {first}", path.display()))
        }
    }
}

/// Whether `path` is `root` or sits underneath it.
///
/// Compared component by component rather than as strings, so `/home/me/proj2`
/// isn't treated as being inside `/home/me/proj`. macOS and Windows preserve
/// the case a name was created with but match without it, so a root registered
/// as `~/Project` has to accept a path that arrived as `~/project` — on Linux
/// those are genuinely different directories and the comparison stays exact.
fn is_under(root: &Path, path: &Path) -> bool {
    let mut root_parts = root.components();
    let mut path_parts = path.components();

    loop {
        match (root_parts.next(), path_parts.next()) {
            (None, _) => return true,
            (Some(_), None) => return false,
            (Some(a), Some(b)) => {
                if !components_match(a, b) {
                    return false;
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn components_match(a: Component, b: Component) -> bool {
    a == b
}

#[cfg(not(target_os = "linux"))]
fn components_match(a: Component, b: Component) -> bool {
    a.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}

/// Expands a leading `~`, which the frontend passes through from recent
/// directories and from anything the user typed.
fn expand_home(raw: &str) -> PathBuf {
    if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        if let Some(home) = operations::get_home_dir() {
            if raw.len() <= 1 {
                return PathBuf::from(home);
            }
            return PathBuf::from(home).join(&raw[2..]);
        }
    }
    PathBuf::from(raw)
}

/// Turns a path from the frontend into one we're willing to act on.
///
/// A path that doesn't exist yet is still resolvable — that's the "save as" and
/// "new file" case — by canonicalising the parent and re-joining the name. The
/// name itself is checked for separators and `..` first, since a canonical
/// parent plus `../../etc/passwd` would otherwise escape the root the parent
/// was checked against.
pub fn resolve(state: &FsState, raw: &str) -> Result<PathBuf, String> {
    let requested = expand_home(raw.trim());
    if requested.as_os_str().is_empty() {
        return Err("No path given".into());
    }

    let resolved = if requested.exists() {
        canonicalize(&requested)?
    } else {
        let parent = requested
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("{} does not exist", requested.display()))?;
        let name = requested
            .file_name()
            .ok_or_else(|| format!("{} is not a file path", requested.display()))?;
        if Path::new(name).components().count() != 1
            || matches!(
                Path::new(name).components().next(),
                Some(Component::ParentDir) | Some(Component::CurDir)
            )
        {
            return Err(format!("{} is not a valid name", name.to_string_lossy()));
        }
        canonicalize(parent)?.join(name)
    };

    let roots = state
        .roots
        .lock()
        .map_err(|_| "The workspace root list is unavailable".to_string())?;

    if roots.is_empty() {
        return Err("No workspace is open in the editor".into());
    }
    if roots.iter().any(|root| is_under(root, &resolved)) {
        return Ok(resolved);
    }

    Err(format!(
        "{} is outside the folders open in the editor",
        resolved.display()
    ))
}

fn to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Declares which folders the editor may read and write.
///
/// Called whenever the user opens a folder, so it replaces the list rather than
/// adding to it: a root nobody is looking at any more shouldn't stay writable
/// for the rest of the session. Returns the canonical form of each, which is
/// what the explorer then uses as its tree root — resolving it here means the
/// frontend and the backend never disagree about what the root is called.
#[tauri::command]
pub fn fs_set_roots(state: State<FsState>, paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut resolved = Vec::with_capacity(paths.len());
    for raw in &paths {
        let path = expand_home(raw.trim());
        // A root that has gone away (an ejected volume, a deleted checkout) is
        // skipped rather than failing the whole call, so one stale entry in a
        // restored session can't stop the editor opening.
        if let Ok(canonical) = canonicalize(&path) {
            if canonical.is_dir() {
                resolved.push(canonical);
            }
        }
    }

    let display = resolved.iter().map(|p| to_string(p)).collect();
    *state
        .roots
        .lock()
        .map_err(|_| "The workspace root list is unavailable".to_string())? = resolved;
    Ok(display)
}

#[tauri::command]
pub fn fs_list_dir(
    state: State<FsState>,
    path: String,
    show_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    let resolved = resolve(&state, &path)?;
    operations::list_directory(&resolved, show_hidden)
}

#[tauri::command]
pub fn fs_stat(state: State<FsState>, path: String) -> Result<FileEntry, String> {
    let resolved = resolve(&state, &path)?;
    operations::stat(&resolved)
}

#[tauri::command]
pub fn fs_read_text(state: State<FsState>, path: String) -> Result<OpenedFile, String> {
    let resolved = resolve(&state, &path)?;
    operations::read_text_file(&resolved)
}

/// Saves a buffer, refusing to overwrite a file that changed underneath it.
///
/// `expected_mtime` is the mtime the buffer was loaded (or last saved) at. When
/// it no longer matches, nothing is written and the editor is told what the
/// file's mtime actually is — the user then chooses to overwrite (calling again
/// with `None`), reload, or look at the difference. Silently winning that race
/// is how editors eat other people's work.
#[tauri::command]
pub fn fs_write_text(
    state: State<FsState>,
    path: String,
    content: String,
    encoding: Encoding,
    line_ending: LineEnding,
    expected_mtime: Option<u64>,
) -> Result<WriteOutcome, String> {
    let resolved = resolve(&state, &path)?;

    if let Some(expected) = expected_mtime {
        if let Some(actual) = operations::mtime_of(&resolved) {
            // Equality, not "newer than": a file restored from a backup or
            // touched backwards in time has still changed.
            if actual != expected {
                return Ok(WriteOutcome {
                    status: WriteStatus::Conflict,
                    mtime: actual,
                });
            }
        }
    }

    let mtime = operations::write_text_file(&resolved, &content, encoding, line_ending)?;
    Ok(WriteOutcome {
        status: WriteStatus::Written,
        mtime,
    })
}

#[tauri::command]
pub fn fs_create(state: State<FsState>, path: String, is_dir: bool) -> Result<String, String> {
    let resolved = resolve(&state, &path)?;
    operations::create(&resolved, is_dir)?;
    Ok(to_string(&resolved))
}

#[tauri::command]
pub fn fs_rename(state: State<FsState>, from: String, to: String) -> Result<String, String> {
    let source = resolve(&state, &from)?;
    let target = resolve(&state, &to)?;
    operations::rename(&source, &target)?;
    Ok(to_string(&target))
}

#[tauri::command]
pub fn fs_delete(state: State<FsState>, path: String, to_trash: bool) -> Result<(), String> {
    let resolved = resolve(&state, &path)?;
    operations::delete(&resolved, to_trash)
}

/// Shows a path in the system file manager, selected.
#[tauri::command]
pub fn fs_reveal(state: State<FsState>, path: String) -> Result<(), String> {
    let resolved = resolve(&state, &path)?;
    let target = to_string(&resolved);

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&target);
        c
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        // `/select,` takes the path as one argument with no space after the
        // comma, and explorer.exe exits non-zero even when it works.
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(format!("/select,{target}"));
        c
    };

    // No file manager on Linux takes a "select this file" argument portably, so
    // the containing directory is opened instead.
    #[cfg(target_os = "linux")]
    let mut command = {
        let dir = resolved
            .parent()
            .map(|p| to_string(p))
            .unwrap_or_else(|| target.clone());
        let mut c = std::process::Command::new("xdg-open");
        c.arg(dir);
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not reveal {target}: {e}"))
}

/// The file list quick open filters against.
///
/// Returned whole rather than streamed: it's names only, it's capped, and the
/// finder needs the full set in hand to rank against as the user types.
#[tauri::command]
pub fn fs_list_files(
    state: State<FsState>,
    root: String,
    show_hidden: bool,
) -> Result<FileList, String> {
    let resolved = resolve(&state, &root)?;
    let (files, truncated) = operations::list_files(&resolved, QUICK_OPEN_MAX_FILES, show_hidden);
    Ok(FileList {
        root: to_string(&resolved),
        files,
        truncated,
    })
}

/// Starts a project-wide search, streaming results back as events.
///
/// Returns immediately with the search's id; matches arrive on
/// `editor://search-result` and the walk's end on `editor://search-done`, both
/// carrying that id so a stale search's results can be ignored. Calling again
/// supersedes whatever was running.
#[tauri::command]
pub fn fs_search(
    app: AppHandle,
    state: State<FsState>,
    root: String,
    query: String,
    options: SearchOptions,
) -> Result<u64, String> {
    let resolved = resolve(&state, &root)?;
    let id = state.search_generation.fetch_add(1, Ordering::SeqCst) + 1;

    // The walk is blocking and can run for seconds on a large tree, so it gets
    // its own thread; the command itself has to return for the UI to show the
    // "searching" state at all.
    std::thread::spawn(move || {
        let generation = app.state::<FsState>();
        let mut batch: Vec<SearchMatch> = Vec::with_capacity(SEARCH_BATCH);
        let mut total = 0usize;
        let mut complete = true;

        let flush = |app: &AppHandle, batch: &mut Vec<SearchMatch>| {
            if batch.is_empty() {
                return;
            }
            let _ = app.emit(
                SEARCH_RESULT_EVENT,
                SearchResultPayload {
                    id,
                    matches: std::mem::take(batch),
                },
            );
        };

        let outcome = operations::search_files(&resolved, &query, &options, &mut |hit| {
            // Superseded or cancelled: stop walking rather than finish a search
            // whose results the UI has already thrown away.
            if generation.search_generation.load(Ordering::SeqCst) != id {
                complete = false;
                return false;
            }

            total += 1;
            batch.push(hit);
            if batch.len() >= SEARCH_BATCH {
                flush(&app, &mut batch);
            }

            if total >= SEARCH_MAX_RESULTS {
                complete = false;
                return false;
            }
            true
        });

        flush(&app, &mut batch);

        let _ = app.emit(
            SEARCH_DONE_EVENT,
            SearchDonePayload {
                id,
                total,
                complete,
                error: outcome.err(),
            },
        );
    });

    Ok(id)
}

/// Stops the running search, if any.
#[tauri::command]
pub fn fs_cancel_search(state: State<FsState>) {
    state.search_generation.fetch_add(1, Ordering::SeqCst);
}

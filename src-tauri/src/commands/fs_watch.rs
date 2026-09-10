//! Tells the editor when a file changed underneath it.
//!
//! Without this, the shell in the pane behind the modal is a way to desynchronise
//! the editor from the disk: `git checkout`, a formatter, a rebuild, or plain
//! `vim` on the same file, and the buffer is quietly stale. Losing that race is
//! the single most common way an embedded editor destroys work.
//!
//! What arrives here is deliberately coarse. FSEvents coalesces, inotify emits
//! rename pairs, and `ReadDirectoryChangesW` reports writes in fragments — so
//! rather than trying to reconstruct precise per-file events from three
//! disagreeing sources, this emits *invalidations*: "these paths changed, look
//! again". The frontend re-reads what it cares about and ignores the rest.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::fs::{resolve, FsState};

pub const CHANGE_EVENT: &str = "editor://fs-change";

/// How long a quiet period ends a burst. A `git checkout` or an `npm install`
/// produces thousands of events; the explorer only needs to hear about it once.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// A burst that never goes quiet is still flushed this often, so a long-running
/// build doesn't hold every event until it finishes.
const MAX_HOLD: Duration = Duration::from_millis(600);

/// Past this many distinct paths in one burst, the individual list stops being
/// useful and the frontend is told to reload the tree wholesale.
const OVERFLOW_PATHS: usize = 400;

/// How often the fallback watcher looks, when the platform's real one can't be
/// used. Deliberately slow: it costs a full `stat` walk of the tree each time.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct WatchState {
    /// Dropping the watcher is what stops it, and dropping its event closure
    /// closes the channel that stops the coalescing thread — so `None` here
    /// means nothing is running.
    active: Mutex<Option<Box<dyn Watcher + Send>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangePayload {
    /// Files and directories that changed. Empty when `overflow` is set.
    paths: Vec<String>,
    /// The burst was too large to itemise; reload everything that's open.
    overflow: bool,
}

/// Whether a path is one the editor should hear about.
///
/// Two exclusions earn their place:
///
/// - **Our own temp files.** Every atomic save creates and renames a
///   `.name.figytmp` sibling (see `filesystem/operations.rs`), so without this
///   filter saving a file makes the editor tell itself the directory changed,
///   twice.
/// - **`.git`.** It churns constantly — index locks, refs, objects — and none
///   of it is a file anybody has open. Git integration, when it arrives, will
///   want a deliberate refresh rather than this firehose.
fn is_interesting(path: &Path) -> bool {
    let mut components = path.components();
    if components.any(|c| c.as_os_str() == ".git") {
        return false;
    }

    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => !(name.starts_with('.') && name.ends_with(".figytmp")),
        None => true,
    }
}

fn relevant_kind(kind: &EventKind) -> bool {
    // `Access` fires on every read — including our own — and says nothing about
    // the content. Everything else is worth a look.
    !matches!(kind, EventKind::Access(_))
}

/// The closure the platform watcher calls, on its own thread.
///
/// It does as little as possible: filtering and a channel send. Anything
/// slower here backs up the OS notification queue, and on inotify a backed-up
/// queue drops events.
fn handler(tx: Sender<Vec<PathBuf>>) -> impl Fn(notify::Result<Event>) + Send + 'static {
    move |result| {
        let Ok(event) = result else { return };
        if !relevant_kind(&event.kind) {
            return;
        }
        let paths: Vec<PathBuf> = event
            .paths
            .into_iter()
            .filter(|p| is_interesting(p))
            .collect();
        if paths.is_empty() {
            return;
        }
        // A send failure means the editor closed and the receiver is gone.
        let _ = tx.send(paths);
    }
}

/// Coalesces bursts of raw events into at most one app event per [`DEBOUNCE`].
fn spawn_coalescer(app: AppHandle, rx: mpsc::Receiver<Vec<PathBuf>>) {
    std::thread::spawn(move || {
        let mut pending: HashSet<String> = HashSet::new();
        let mut oldest: Option<Instant> = None;

        let emit = |paths: &mut HashSet<String>| {
            if paths.is_empty() {
                return;
            }
            let overflow = paths.len() > OVERFLOW_PATHS;
            let payload = ChangePayload {
                paths: if overflow {
                    Vec::new()
                } else {
                    paths.iter().cloned().collect()
                },
                overflow,
            };
            paths.clear();
            let _ = app.emit(CHANGE_EVENT, payload);
        };

        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(paths) => {
                    if oldest.is_none() {
                        oldest = Some(Instant::now());
                    }
                    for path in paths {
                        pending.insert(path.to_string_lossy().to_string());
                    }
                    // A continuous stream never lets the timeout fire, so the
                    // hold time is what bounds latency during a long build.
                    if oldest.map(|t| t.elapsed() >= MAX_HOLD).unwrap_or(false) {
                        emit(&mut pending);
                        oldest = None;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    emit(&mut pending);
                    oldest = None;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    emit(&mut pending);
                    return;
                }
            }
        }
    });
}

/// Watches one directory tree, replacing whatever was being watched before.
///
/// One watcher, not one per root: the editor shows a single tree at a time, and
/// a recursive watch is the expensive kind of resource on every platform —
/// inotify spends a watch descriptor per directory and a large monorepo can
/// exhaust the user's whole limit.
///
/// Returns the name of the mechanism in use, so the UI can say when it fell
/// back to polling rather than leaving the user to wonder why changes take
/// three seconds to show up.
#[tauri::command]
pub fn fs_watch_root(
    app: AppHandle,
    fs_state: State<FsState>,
    state: State<WatchState>,
    path: String,
) -> Result<String, String> {
    let root = resolve(&fs_state, &path)?;

    let mut active = state
        .active
        .lock()
        .map_err(|_| "The file watcher is unavailable".to_string())?;
    // Dropped before the new one is built, so two recursive watchers never
    // exist over the same tree.
    *active = None;

    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();

    let native: Result<Box<dyn Watcher + Send>, notify::Error> =
        RecommendedWatcher::new(handler(tx.clone()), Config::default()).and_then(|mut w| {
            w.watch(&root, RecursiveMode::Recursive)?;
            Ok(Box::new(w) as Box<dyn Watcher + Send>)
        });

    let (watcher, mechanism) = match native {
        Ok(watcher) => (watcher, "native"),
        Err(native_error) => {
            // The common cause on Linux is `max_user_watches` exhaustion, which
            // a big `node_modules` reaches on a default install. Polling is
            // slow and does real IO, but it is much better than an editor that
            // silently stops noticing changes.
            log::warn!("editor: native file watching unavailable ({native_error}); polling");
            let poll = PollWatcher::new(
                handler(tx),
                Config::default().with_poll_interval(POLL_INTERVAL),
            )
            .and_then(|mut w| {
                w.watch(&root, RecursiveMode::Recursive)?;
                Ok(Box::new(w) as Box<dyn Watcher + Send>)
            })
            .map_err(|poll_error| {
                format!("Could not watch {}: {native_error} (and polling failed: {poll_error})", root.display())
            })?;
            (poll, "poll")
        }
    };

    spawn_coalescer(app, rx);
    *active = Some(watcher);

    Ok(mechanism.to_string())
}

/// Stops watching. Called when the editor closes, so an unopened modal costs
/// nothing.
#[tauri::command]
pub fn fs_unwatch(state: State<WatchState>) -> Result<(), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "The file watcher is unavailable".to_string())?;
    *active = None;
    Ok(())
}

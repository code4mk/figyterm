//! Where the API client's collections live.
//!
//! SQLite, in the app's data directory, owned by Rust. The webview holds what
//! is on screen and nothing that must survive a crash — which is the opposite
//! of how the drawing window works, and deliberately so: a scene is one blob
//! per project, while a collection is a tree of thousands of rows that has to
//! be queried, reordered, and eventually copied row for row into Postgres. The
//! argument is in `docs/API-CLIENT.md`.
//!
//! **Every table carries its sync columns from the first migration**, long
//! before there is anything to sync with. `updated_at`, `deleted_at`, `rev` and
//! `device_id` are cheap to write now and a painful migration to add to a
//! database full of other people's collections later.
//!
//! **Deletes are tombstones.** Nothing is removed while a remote might still be
//! holding a copy; rows are marked and filtered out. The one exception is
//! history, which is local, capped, and pruned for real.

pub mod model;
pub mod queries;
pub mod schema;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// Milliseconds since the epoch — the app's one clock for stored times.
///
/// Sync will replace this with the server's clock on push, because two machines
/// disagreeing about the time is exactly how last-writer-wins picks the wrong
/// winner. Until then, local time is all there is.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The database and the files that belong to it.
#[derive(Default)]
pub struct StoreState {
    connection: Mutex<Option<Connection>>,
    /// Where response bodies for history entries are written.
    bodies: Mutex<Option<PathBuf>>,
}

/// A store failure, as the webview sees it.
///
/// One string: unlike a send, there is no remedy the UI can offer for a
/// database that will not open, and pretending otherwise would be decoration.
pub type StoreResult<T> = Result<T, String>;

impl StoreState {
    /// Runs `work` against the open database, opening it on first use.
    ///
    /// Opening lazily rather than at launch is the same bargain the rest of
    /// this window makes: a terminal that never opens the API client should not
    /// pay for its schema.
    pub fn with<T>(
        &self,
        app: &AppHandle,
        work: impl FnOnce(&Connection) -> StoreResult<T>,
    ) -> StoreResult<T> {
        let mut guard = self.connection.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(open(app)?);
        }
        let connection = guard.as_ref().expect("just opened");
        work(connection)
    }

    /// The directory response bodies are written to, created on first use.
    pub fn bodies_dir(&self, app: &AppHandle) -> StoreResult<PathBuf> {
        let mut guard = self.bodies.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let dir = data_dir(app)?.join("api-bodies");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            *guard = Some(dir);
        }
        Ok(guard.as_ref().expect("just created").clone())
    }
}

impl StoreState {
    /// Where the database and its neighbours live.
    pub fn data_path(&self, app: &AppHandle) -> StoreResult<PathBuf> {
        data_dir(app)
    }

    /// A second connection to the same file.
    ///
    /// For the sync worker, which holds one across every `await` in a pass
    /// while the window's connection stays available to the commands the
    /// window is making meanwhile. With write-ahead logging two connections to
    /// one file is the ordinary arrangement rather than a workaround.
    pub fn open_another(&self, app: &AppHandle) -> StoreResult<Connection> {
        open(app)
    }

    /// Replaces the database with a copy of another file.
    ///
    /// Used to go back to the state before syncing started. The open
    /// connection is dropped first: SQLite will not have the file swapped
    /// underneath it, and a handle to the old inode would keep writing to a
    /// file nothing reads.
    pub fn replace_with(&self, app: &AppHandle, from: &PathBuf) -> StoreResult<()> {
        let mut guard = self.connection.lock().map_err(|e| e.to_string())?;
        *guard = None;

        let path = data_dir(app)?.join("figyman.db");
        // The write-ahead log and its index belong to the file being replaced.
        for suffix in ["-wal", "-shm"] {
            let companion = path.with_extension(format!("db{suffix}"));
            let _ = std::fs::remove_file(companion);
        }
        std::fs::copy(from, &path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn data_dir(app: &AppHandle) -> StoreResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No application data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn open(app: &AppHandle) -> StoreResult<Connection> {
    let path = data_dir(app)?.join("figyman.db");
    let connection = Connection::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;

    // WAL so a long read cannot block a write, and foreign keys on because
    // SQLite otherwise ignores every one of them — the default is off, which
    // silently turns a schema's guarantees into documentation.
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    // NORMAL rather than FULL: with WAL this is durable against a process
    // crash, which is the failure that actually happens, and it does not fsync
    // on every keystroke's worth of autosave.
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| e.to_string())?;

    schema::migrate(&connection)?;
    Ok(connection)
}

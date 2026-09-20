//! Connecting to a remote, and running passes against it.
//!
//! The worker opens **its own connection** to the same database rather than
//! borrowing the one the window uses. A pass holds a connection across every
//! `await` in it, and the window's connection is behind a lock that other
//! commands need in the meantime; with write-ahead logging two connections to
//! one file is the ordinary arrangement, not a workaround.
//!
//! Only one pass runs at a time. A manual sync pressed while the timer's pass
//! is halfway through would otherwise push the same rows twice and race the
//! watermark.

use std::sync::{Mutex, RwLock};
use std::time::Duration;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::secrets::{self, Credential};
use crate::store::{queries, StoreResult, StoreState};
use crate::sync::direct::{Direct, DirectConfig};
use crate::sync::remote::{Probe, Remote};
use crate::sync::{rows, schema, worker, SyncConfig, SyncOutcome};

/// Emitted when a pass finishes, so the window can reload what changed.
/// Where a pass has got to, table by table.
pub const SYNC_STEP_EVENT: &str = "api://sync-step";

pub const SYNC_EVENT: &str = "api://sync";

/// Where the connection settings live. The key never appears here.
const CONFIG_KEY: &str = "sync_config";

/// How long one pass may take before it is stopped.
///
/// Generous: a first sync of a large collection is legitimately slow, and this
/// is a backstop against a pass that will never finish rather than a budget for
/// one that is merely big. See the note where it is used for why stopping is
/// safe.
const PASS_DEADLINE: Duration = Duration::from_secs(180);

#[derive(Default)]
pub struct SyncState {
    /// One pass at a time. A `tokio` mutex, because it is held across awaits.
    running: tokio::sync::Mutex<()>,
    last: Mutex<Option<SyncOutcome>>,
    /// Whether the interval task has been started for this run of the app.
    ticking: RwLock<bool>,
}

impl SyncState {
    fn remember(&self, outcome: &SyncOutcome) {
        if let Ok(mut last) = self.last.lock() {
            *last = Some(outcome.clone());
        }
    }
}

/// Everything the connection panel shows.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub config: SyncConfig,
    /// Whether a key is in the keychain for this project.
    pub has_key: bool,
    pub pending: usize,
    pub conflicts: usize,
    pub last: Option<SyncOutcome>,
}

fn read_config(connection: &Connection) -> SyncConfig {
    queries::get_meta(connection, CONFIG_KEY)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_config(connection: &Connection, config: &SyncConfig) -> StoreResult<()> {
    queries::set_meta(
        connection,
        CONFIG_KEY,
        &serde_json::to_string(config).map_err(|e| e.to_string())?,
    )
}

/// How many conflicted copies are sitting in the tree, for the badge.
fn conflicts(connection: &Connection) -> usize {
    let count: i64 = connection
        .query_row(
            "SELECT (SELECT count(*) FROM items WHERE conflicted_at IS NOT NULL AND deleted_at IS NULL)
                  + (SELECT count(*) FROM collections WHERE conflicted_at IS NOT NULL AND deleted_at IS NULL)
                  + (SELECT count(*) FROM environments WHERE conflicted_at IS NOT NULL AND deleted_at IS NULL)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    count as usize
}

/// The account a mode's credentials are filed under in the keychain.
///
/// One machine may sync more than one database, and a password filed under
/// "postgres" would be whichever was set up last.
/// The keychain account a password is filed under.
///
/// Built from the connection rather than stored, so pointing the app at a
/// different database asks for that database's password instead of quietly
/// offering the old one.
fn account(config: &SyncConfig) -> String {
    match config.direct.as_ref() {
        Some(direct) => format!(
            "postgres://{}@{}:{}/{}",
            direct.user, direct.host, direct.port, direct.database
        ),
        None => config.url.clone(),
    }
}

/// Builds the remote from what is saved, or says why it cannot.
async fn connect(config: &SyncConfig) -> StoreResult<Remote> {
    let direct = config
        .direct
        .as_ref()
        .ok_or("No database is connected yet")?;
    let password = secrets::read(Credential::Key, &account(config))?.unwrap_or_default();
    Remote::connect(direct.clone(), password).await
}

/// The SQL that prepares a Postgres database, for the modal to show and copy.
#[tauri::command(async)]
pub fn api_sync_setup_sql(schema: String) -> String {
    schema::setup_sql(&schema)
}

#[tauri::command(async)]
pub fn api_sync_status(app: AppHandle, state: State<'_, StoreState>) -> StoreResult<SyncStatus> {
    let sync = app.state::<SyncState>();
    state.with(&app, |connection| {
        let config = read_config(connection);

        // **The keychain is not read here.**
        //
        // This runs every time the window opens, and reading a keychain item
        // is not free on macOS: when the binary's signature does not match the
        // one that stored the item — which is every rebuild during development
        // — the system puts up a login-password prompt. Asking somebody for
        // their Mac password to draw a status dot is the worst possible reason
        // to ask, and on a machine that has never connected anything it is
        // being asked for nothing at all.
        //
        // The connection panel calls `api_sync_has_key` when it opens, which
        // is the moment the answer is actually wanted.
        let has_key = false;

        Ok(SyncStatus {
            has_key,
            pending: rows::pending(connection).unwrap_or(0),
            conflicts: conflicts(connection),
            last: sync.last.lock().ok().and_then(|last| last.clone()),
            config,
        })
    })
}

/// Whether a key is already in the keychain for what is configured.
///
/// Its own command, called when the connection panel opens rather than with
/// every status read — see the note in `api_sync_status`. A failure is `false`
/// rather than an error: the panel's question is "must I type the key again",
/// and a keychain that would not answer means yes.
#[tauri::command(async)]
pub fn api_sync_has_key(app: AppHandle, state: State<'_, StoreState>) -> StoreResult<bool> {
    state.with(&app, |connection| {
        let where_ = account(&read_config(connection));
        if where_.is_empty() {
            return Ok(false);
        }
        Ok(secrets::read(Credential::Key, &where_)
            .unwrap_or(None)
            .is_some())
    })
}

/// Tries a Postgres database without saving anything.
///
/// It connects, reports the server and the latency, and says which tables are
/// missing — it does *not* create them. Creating is what Connect does, and a
/// test that changed the database would not be a test.
#[tauri::command(async)]
pub async fn api_sync_test_direct(config: DirectConfig, password: String) -> Probe {
    match Direct::connect(&config, &password).await {
        Ok(direct) => direct.probe().await,
        Err(error) => Probe {
            message: error,
            ..Default::default()
        },
    }
}

/// Creates the tables, and nothing else.
///
/// Its own step because it was the one thing with no way to see it. It ran
/// inside Connect, between the connection and the probe, so a migration that
/// was refused looked exactly like a database that had simply not been set up:
/// the same "N missing" either way, with the reason somewhere underneath.
///
/// Here it is pressed on purpose, it reports what the database said, and it
/// saves nothing — so it can be tried, and read, and tried again.
#[tauri::command(async)]
pub async fn api_sync_migrate(config: DirectConfig, password: String) -> StoreResult<Probe> {
    let direct = Direct::connect(&config, &password).await?;
    direct.migrate().await?;
    Ok(direct.probe().await)
}

/// Saves a Postgres database, creating the schema if it is not there.
///
/// It sets itself up: the connection is to the database rather than to
/// something in front of it, so the setup SQL runs here instead of being
/// copied into somebody's console.
#[tauri::command(async)]
pub async fn api_sync_connect_direct(
    app: AppHandle,
    state: State<'_, StoreState>,
    config: DirectConfig,
    password: String,
    interval_secs: u64,
    sync_on_focus: bool,
) -> StoreResult<Probe> {
    let direct = Direct::connect(&config, &password).await?;
    direct.migrate().await?;
    let probe = direct.probe().await;

    let saved = SyncConfig {
        mode: "direct".into(),
        url: String::new(),
        schema: config.schema.clone(),
        email: None,
        interval_secs: interval_secs.max(30),
        sync_on_focus,
        sync_history: false,
        enabled: probe.schema_ready,
        direct: Some(config),
    };

    if !password.is_empty() {
        secrets::store(Credential::Key, &account(&saved), &password)?;
    }
    state.with(&app, |connection| write_config(connection, &saved))?;
    if saved.enabled {
        start_ticking(app.clone());
    }
    Ok(probe)
}

/// Forgets a project: the credentials go out of the keychain, and syncing stops.
/// The collections stay — they are this machine's, and always were.
#[tauri::command(async)]
pub fn api_sync_disconnect(app: AppHandle, state: State<'_, StoreState>) -> StoreResult<()> {
    state.with(&app, |connection| {
        let mut config = read_config(connection);
        let where_ = account(&config);
        if !where_.is_empty() {
            let _ = secrets::forget(Credential::Key, &where_);
            let _ = secrets::forget(Credential::Refresh, &where_);
        }
        config.enabled = false;
        write_config(connection, &config)
    })
}

#[tauri::command(async)]
pub fn api_sync_settings(
    app: AppHandle,
    state: State<'_, StoreState>,
    enabled: bool,
    interval_secs: u64,
    sync_on_focus: bool,
) -> StoreResult<()> {
    state.with(&app, |connection| {
        let mut config = read_config(connection);
        config.enabled = enabled;
        config.interval_secs = interval_secs.max(30);
        config.sync_on_focus = sync_on_focus;
        write_config(connection, &config)
    })?;
    if enabled {
        start_ticking(app);
    }
    Ok(())
}

/// One pass, now.
#[tauri::command(async)]
pub async fn api_sync_now(app: AppHandle) -> StoreResult<SyncOutcome> {
    run_pass(app).await
}

/// The pass itself, shared by the command and the timer.
async fn run_pass(app: AppHandle) -> StoreResult<SyncOutcome> {
    let sync = app.state::<SyncState>();
    let _one_at_a_time = sync.running.lock().await;

    let store = app.state::<StoreState>();
    let config = store.with(&app, |connection| Ok(read_config(connection)))?;
    if !config.enabled {
        return Err("Syncing is switched off".into());
    }

    let remote = connect(&config).await?;

    // The worker's own connection, behind its own lock: the window's is held
    // by commands the window is making meanwhile, and a pass needs one it can
    // borrow between every await.
    let db: worker::Db = Mutex::new(store.open_another(&app)?);

    // A copy to go back to. Taken once per run of the app rather than once per
    // pass — the point is the state from before syncing started, not from
    // before the most recent pass.
    let snapshot_path = store.data_path(&app)?.join("figyman-presync.db");
    if !snapshot_path.exists() {
        let taken = db
            .lock()
            .map_err(|_| "the database lock was poisoned".to_string())
            .and_then(|connection| worker::snapshot(&connection, &snapshot_path));
        if let Err(error) = taken {
            log::warn!("no pre-sync snapshot: {error}");
        }
    }

    /*
      Every step, as it happens.

      A pass of a few thousand rows is seconds of nothing followed by a number,
      and "seconds of nothing" looks exactly like "hung". The window listens
      for these and draws which table is moving and how much of it has gone.
      Emitting cannot fail in a way worth stopping a sync over, so it is
      ignored rather than handled.
    */
    let reporter = app.clone();
    /*
      A pass is bounded, and a bounded pass is why this is safe to bound.

      Only one runs at a time, and the lock that guarantees it is held for the
      duration — so a pass that hangs does not merely fail to finish, it stops
      every later pass from starting, for as long as the app is open. That is
      the state people describe as "sync stopped working".

      Cutting it off is safe because the work commits as it goes: each table's
      watermark is saved as its page lands, and pushed rows are dequeued in the
      same transaction that writes them back. A pass that runs out of time has
      done real work and the next one carries on from there, so the deadline
      costs a wait rather than progress.
    */
    let outcome = match tokio::time::timeout(
        PASS_DEADLINE,
        worker::run_watched(&db, &remote, &move |step| {
            let _ = reporter.emit(SYNC_STEP_EVENT, step);
        }),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => SyncOutcome {
            finished_at: crate::store::now_ms(),
            pending: db
                .lock()
                .ok()
                .and_then(|connection| rows::pending(&connection).ok())
                .unwrap_or(0),
            error: Some(format!(
                "This sync ran past {} seconds and was stopped. What it had already \
                 moved is kept, and the next one picks up from there.",
                PASS_DEADLINE.as_secs()
            )),
            ..Default::default()
        },
    };
    sync.remember(&outcome);
    let _ = app.emit(SYNC_EVENT, outcome.clone());
    Ok(outcome)
}

/// Starts the interval task, once per run of the app.
///
/// In Rust rather than in the window, so a sync happens whether or not the API
/// window is open — the point of syncing is that the other machine sees your
/// work, and that should not depend on which window has focus here.
pub fn start_ticking(app: AppHandle) {
    {
        let sync = app.state::<SyncState>();
        let Ok(mut ticking) = sync.ticking.write() else {
            return;
        };
        if *ticking {
            return;
        }
        *ticking = true;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            let interval = {
                let store = app.state::<StoreState>();
                let config = store
                    .with(&app, |connection| Ok(read_config(connection)))
                    .unwrap_or_default();
                if !config.enabled {
                    // Switched off: stop the task rather than spin. Turning it
                    // back on starts a new one.
                    if let Ok(mut ticking) = app.state::<SyncState>().ticking.write() {
                        *ticking = false;
                    }
                    return;
                }
                config.interval_secs
            };

            tokio::time::sleep(Duration::from_secs(interval)).await;

            if let Err(error) = run_pass(app.clone()).await {
                log::warn!("sync pass failed: {error}");
            }
        }
    });
}

/// Restores the copy taken before syncing started.
///
/// The honest answer to "what if the merge is wrong", and the reason the
/// snapshot is taken at all. It replaces the database wholesale, so the window
/// has to be reopened afterwards — which the command says rather than pretending
/// the change is live.
#[tauri::command(async)]
pub fn api_sync_restore(app: AppHandle, state: State<'_, StoreState>) -> StoreResult<()> {
    let snapshot = state.data_path(&app)?.join("figyman-presync.db");
    if !snapshot.exists() {
        return Err("There is no pre-sync copy to go back to".into());
    }
    state.replace_with(&app, &snapshot)
}

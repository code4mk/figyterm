//! One pass: push what is queued, pull what is new, decide, commit.
//!
//! The order matters and is not arbitrary. Pushing first means the remote has
//! this machine's work before we ask what it thinks, so a row we just edited
//! comes back as ours rather than as a conflict with our own earlier version.
//!
//! Three rules hold throughout:
//!
//! - **The watermark moves only when a table's pull has been applied.** A pass
//!   that dies halfway leaves the watermark where it was and re-reads those
//!   rows next time; the merge is idempotent, so re-reading costs nothing and
//!   skipping costs the row.
//! - **The outbox is suspended while remote rows are applied.** Applying is
//!   itself a write, and the triggers would otherwise queue every row that
//!   arrived straight back for pushing — a sync that runs for ever and changes
//!   nothing.
//! - **A secret's value never leaves the machine.** The row goes, marked, with
//!   an empty value. What that costs is written down in `docs/API-CLIENT.md`.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::Value;

use super::merge::{conflicted_name, decide, Decision, RemoteState};
use super::remote::Remote;
use super::rows::{self, Row};
use super::{table, SyncOutcome, SyncResult, SyncTable, Watermarks, TABLES};
use crate::store::{now_ms, queries};

/// How many rows cross in one request. Large enough that a first sync is not a
/// thousand round trips, small enough that a failure re-does little.
const BATCH: usize = 200;

/// The database, reachable from an async pass.
///
/// A `&Connection` cannot cross an `await` — `Connection` is `Send` but not
/// `Sync`, so a future holding a reference to one is not `Send`, and Tauri
/// requires that it is. Holding the connection behind a mutex and borrowing it
/// only *between* awaits is what makes the pass an ordinary async function
/// rather than a thread with a channel bolted to it.
///
/// Every lock in this file is taken and released inside one synchronous block.
/// A guard held across an await would be the same bug wearing a hat.
pub type Db = Mutex<Connection>;

fn locked<T>(db: &Db, work: impl FnOnce(&Connection) -> SyncResult<T>) -> SyncResult<T> {
    let connection = db.lock().map_err(|_| "the database lock was poisoned")?;
    work(&connection)
}

/// The key the watermarks live under in `meta`.
const WATERMARK_KEY: &str = "sync_watermarks";

/// Turns the outbox triggers off for the duration of applying a pull.
struct Suspended<'a>(&'a Connection);

impl<'a> Suspended<'a> {
    fn begin(connection: &'a Connection) -> SyncResult<Self> {
        queries::set_meta(connection, "outbox_suspended", "1")?;
        Ok(Self(connection))
    }
}

impl Drop for Suspended<'_> {
    fn drop(&mut self) {
        // Left set, a stale flag would stop every later edit from ever syncing,
        // so this is a drop guard rather than a pair of calls: a `?` in the
        // middle of applying must not be able to leave it on.
        let _ = self
            .0
            .execute("DELETE FROM meta WHERE key = 'outbox_suspended'", []);
    }
}

pub fn watermarks(connection: &Connection) -> Watermarks {
    queries::get_meta(connection, WATERMARK_KEY)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_watermarks(connection: &Connection, marks: &Watermarks) -> SyncResult<()> {
    queries::set_meta(
        connection,
        WATERMARK_KEY,
        &serde_json::to_string(marks).map_err(|e| e.to_string())?,
    )
}

/// A copy of the database, taken before the first pass of a session.
///
/// `VACUUM INTO` rather than a file copy: with write-ahead logging the file on
/// disk is not the whole database, and a copy of it alone is a corrupt one.
/// This is the thing to restore when a sync has gone wrong, which is the only
/// honest answer to "what if the merge is buggy" before it has ever run against
/// a real server.
pub fn snapshot(connection: &Connection, to: &PathBuf) -> SyncResult<()> {
    if to.exists() {
        std::fs::remove_file(to).map_err(|e| e.to_string())?;
    }
    connection
        .execute("VACUUM INTO ?1", [to.to_string_lossy().as_ref()])
        .map_err(|e| format!("Could not take a snapshot before syncing: {e}"))?;
    Ok(())
}

/// Strips what must not travel.
///
/// A variable marked secret goes as a row with an empty value: the remote
/// learns that the name exists and that it is a secret, and never learns what
/// it is. The alternative — not sending the row at all — would make the
/// variable vanish on the other machine, which looks like data loss.
fn redact(table: &SyncTable, row: &mut Row) {
    if table.name != "variables" {
        return;
    }
    let secret = matches!(row.get("secret"), Some(Value::Bool(true)))
        || matches!(row.get("secret"), Some(Value::Number(n)) if n.as_i64() == Some(1));
    if secret {
        row.insert("value".into(), Value::String(String::new()));
    }
}

/// Everything queued, sent table by table, parents first.
/// Where a pass has got to, as it gets there.
///
/// Emitted per table and per batch rather than per pass. A sync of a few
/// thousand rows is seconds of nothing followed by a number, and "seconds of
/// nothing" is indistinguishable from "hung" — which is the state people
/// actually need to tell apart.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep {
    /// `push`, `pull`, or `done`.
    pub phase: &'static str,
    pub table: &'static str,
    /// Which table this is, of how many. The only honest basis for a bar:
    /// nothing knows how many rows are coming until they stop coming.
    pub index: usize,
    pub total: usize,
    /// Rows moved for this table so far.
    pub rows: usize,
}

/// Somewhere to send progress. A pass that nobody is watching passes a
/// closure that drops it, so the worker has one code path rather than two.
pub type OnStep<'a> = &'a (dyn Fn(SyncStep) + Send + Sync);

async fn push(db: &Db, remote: &Remote, on_step: OnStep<'_>) -> SyncResult<usize> {
    let mut sent = 0;

    for (index, table) in TABLES.iter().enumerate() {
        let mut moved = 0;
        on_step(SyncStep {
            phase: "push",
            table: table.name,
            index,
            total: TABLES.len(),
            rows: 0,
        });
        loop {
            let started = now_ms();
            let mut batch = locked(db, |connection| rows::queued(connection, table, BATCH))?;
            if batch.is_empty() {
                break;
            }

            for row in &mut batch {
                redact(table, row);
            }

            let stored = remote.push(table, &batch).await?;
            moved += stored.len();
            on_step(SyncStep {
                phase: "push",
                table: table.name,
                index,
                total: TABLES.len(),
                rows: moved,
            });
            let ids: Vec<String> = batch
                .iter()
                .filter_map(|row| rows::key_of(table, row))
                .collect();

            // What comes back carries the server's `updated_at`. Writing it
            // back is what stops the next pull seeing our own row as newer
            // than the copy we just sent.
            //
            // One transaction for the page, as the pull side already does.
            // Without it each of these upserts was its own implicit
            // transaction, so a full batch meant two hundred commits — and on
            // a synchronous SQLite that is two hundred fsyncs to write two
            // hundred rows nobody is waiting on. It also means the write-back
            // and the dequeue land together: a crash between them used to
            // leave rows queued that the remote already had.
            locked(db, |connection| {
                let _quiet = Suspended::begin(connection)?;
                let transaction = connection
                    .unchecked_transaction()
                    .map_err(|e| e.to_string())?;
                for row in &stored {
                    rows::upsert(&transaction, table, row)?;
                }
                rows::dequeue(&transaction, table, &ids, started)?;
                transaction.commit().map_err(|e| e.to_string())
            })?;

            sent += batch.len();

            if batch.len() < BATCH {
                break;
            }
        }
    }
    Ok(sent)
}

/// Applies one remote row, and says whether it conflicted.
fn apply(connection: &Connection, table: &SyncTable, row: &Row, device: &str) -> SyncResult<bool> {
    let Some(id) = rows::key_of(table, row) else {
        return Err(format!(
            "A {} row arrived without its {}",
            table.name, table.key
        ));
    };

    let local = rows::local_state(connection, table, &id)?;
    let remote = RemoteState {
        updated_at: rows::number(row, "updated_at"),
        deleted: rows::is_set(row, "deleted_at"),
    };

    match decide(local, remote) {
        Decision::KeepLocal => Ok(false),
        Decision::TakeRemote => {
            rows::upsert(connection, table, row)?;
            Ok(false)
        }
        Decision::Conflict => {
            keep_a_copy(connection, table, &id, device)?;
            rows::upsert(connection, table, row)?;
            Ok(true)
        }
    }
}

/// Puts the local version somewhere it can still be found, before the remote
/// takes the identity.
///
/// A request is copied as a *new item* holding it: the conflict people actually
/// hit is two machines editing the same request, and a request row with no item
/// would be a body nobody can reach.
fn keep_a_copy(
    connection: &Connection,
    table: &SyncTable,
    id: &str,
    device: &str,
) -> SyncResult<()> {
    let Some(mine) = rows::read(connection, table, id)? else {
        return Ok(());
    };
    let now = now_ms();
    let copy_id = uuid::Uuid::new_v4().to_string();

    if table.name == "requests" {
        let items = table_of("items")?;
        let Some(item) = rows::read(connection, items, id)? else {
            return Ok(());
        };

        let mut copied_item = item.clone();
        copied_item.insert("id".into(), Value::String(copy_id.clone()));
        copied_item.insert(
            "name".into(),
            Value::String(conflicted_name(
                item.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Request"),
                device,
                now,
            )),
        );
        copied_item.insert("conflicted_at".into(), Value::from(now));
        copied_item.insert("updated_at".into(), Value::from(now));
        copied_item.insert("rev".into(), Value::from(1));
        copied_item.insert("device_id".into(), Value::String(device.to_string()));
        rows::upsert(connection, items, &copied_item)?;

        let mut copied_request = mine;
        copied_request.insert("item_id".into(), Value::String(copy_id));
        copied_request.insert("updated_at".into(), Value::from(now));
        copied_request.insert("rev".into(), Value::from(1));
        rows::upsert(connection, table, &copied_request)?;
        return Ok(());
    }

    if !table.named {
        // A variable or an example has no name to mark and nowhere of its own
        // to live. The remote wins, and the pass counts it so the status panel
        // can say how many were overwritten.
        return Ok(());
    }

    let mut copy = mine;
    copy.insert(table.key.into(), Value::String(copy_id));
    copy.insert(
        "name".into(),
        Value::String(conflicted_name(
            copy.get("name").and_then(Value::as_str).unwrap_or("Copy"),
            device,
            now,
        )),
    );
    copy.insert("conflicted_at".into(), Value::from(now));
    copy.insert("updated_at".into(), Value::from(now));
    copy.insert("rev".into(), Value::from(1));
    copy.insert("device_id".into(), Value::String(device.to_string()));
    rows::upsert(connection, table, &copy)
}

fn table_of(name: &str) -> SyncResult<&'static SyncTable> {
    table(name).ok_or_else(|| format!("No table called {name}"))
}

/// Everything new, in as few round trips as the rows allow.
///
/// **One request for the whole database first.** Asking table by table cost a
/// round trip each, so a pass with nothing to do still waited seven times
/// before it could say so — and against a database a few hundred milliseconds
/// away that was the pass. `pull_many` asks all seven at once with a watermark
/// each; only a table that filled its page is then paged on its own, because
/// only that table might have more.
///
/// The applying is unchanged: one transaction per table, in `TABLES` order, so
/// a parent is never written after the child that needs it.
async fn pull(
    db: &Db,
    remote: &Remote,
    device: &str,
    on_step: OnStep<'_>,
) -> SyncResult<(usize, usize)> {
    let mut marks = locked(db, |connection| Ok(watermarks(connection)))?;
    let mut taken = 0;
    let mut conflicts = 0;

    on_step(SyncStep {
        phase: "pull",
        table: "",
        index: 0,
        total: TABLES.len(),
        rows: 0,
    });

    let since: Vec<(&'static SyncTable, i64)> = TABLES
        .iter()
        .map(|table| (table, marks.pulled.get(table.name).copied().unwrap_or(0)))
        .collect();
    let first = remote.pull_many(&since, BATCH).await?;

    // Kept in `TABLES` order rather than in arrival order: the union makes no
    // promise about which branch comes back first, and applying a child before
    // its parent is exactly what the order exists to prevent.
    let mut pages: Vec<(&'static SyncTable, Vec<Row>)> = TABLES
        .iter()
        .map(|table| {
            let rows = first
                .iter()
                .filter(|(from, _)| from.name == table.name)
                .map(|(_, row)| row.clone())
                .collect();
            (table, rows)
        })
        .collect();

    for (index, (table, page)) in pages.iter_mut().enumerate() {
        let mut since = marks.pulled.get(table.name).copied().unwrap_or(0);
        let mut moved = 0;
        // The first page is in hand already; later ones are fetched below.
        let mut batch = std::mem::take(page);

        loop {
            if batch.is_empty() {
                break;
            }
            moved += batch.len();
            on_step(SyncStep {
                phase: "pull",
                table: table.name,
                index,
                total: TABLES.len(),
                rows: moved,
            });

            let mut highest = since;
            for row in &batch {
                highest = highest.max(rows::number(row, "updated_at"));
            }

            // One transaction for the page, with the outbox quiet inside it:
            // either every row of it lands or none does, and none of them is
            // queued straight back for pushing.
            let found = locked(db, |connection| {
                let _quiet = Suspended::begin(connection)?;
                let transaction = connection
                    .unchecked_transaction()
                    .map_err(|e| e.to_string())?;

                let mut conflicted = 0;
                for row in &batch {
                    if apply(&transaction, table, row, device)? {
                        conflicted += 1;
                    }
                }
                transaction.commit().map_err(|e| e.to_string())?;
                Ok(conflicted)
            })?;

            conflicts += found;
            taken += batch.len();
            marks.pulled.insert(table.name.to_string(), highest);
            locked(db, |connection| save_watermarks(connection, &marks))?;

            // A page that came back short is the end of the table. A full page
            // whose newest row is the one we started from would loop for ever,
            // so that ends it too.
            if batch.len() < BATCH || highest == since {
                break;
            }
            since = highest;

            // Only a table that filled its page can have more, and only that
            // table is asked again — the other six are already done.
            batch = remote.pull(table, since, BATCH).await?;
        }
    }

    Ok((taken, conflicts))
}

/// One pass. Never panics, never leaves the outbox suspended, and reports what
/// it did either way.
pub async fn run(db: &Db, remote: &Remote) -> SyncOutcome {
    run_watched(db, remote, &|_| {}).await
}

/// The same pass, with somewhere to report to as it goes.
pub async fn run_watched(db: &Db, remote: &Remote, on_step: OnStep<'_>) -> SyncOutcome {
    let device = locked(db, |connection| {
        Ok(queries::device_id(connection).unwrap_or_default())
    })
    .unwrap_or_default();
    let mut outcome = SyncOutcome {
        finished_at: now_ms(),
        ..Default::default()
    };

    match push(db, remote, on_step).await {
        Ok(sent) => outcome.pushed = sent,
        Err(error) => {
            outcome.error = Some(error);
            outcome.pending = locked(db, rows::pending).unwrap_or(0);
            outcome.finished_at = now_ms();
            return outcome;
        }
    }

    match pull(db, remote, &device, on_step).await {
        Ok((taken, conflicts)) => {
            outcome.pulled = taken;
            outcome.conflicts = conflicts;
        }
        Err(error) => outcome.error = Some(error),
    }

    outcome.pending = locked(db, rows::pending).unwrap_or(0);
    outcome.finished_at = now_ms();
    on_step(SyncStep {
        phase: "done",
        table: "",
        index: TABLES.len(),
        total: TABLES.len(),
        rows: outcome.pushed + outcome.pulled,
    });
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::schema as store_schema;
    use crate::sync::table;
    use serde_json::json;

    fn fresh() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        store_schema::migrate(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO workspaces (id, name, created_at, updated_at, device_id)
                 VALUES ('w', 'W', 1, 1, 'd')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collections (id, workspace_id, name, rank, updated_at, device_id)
                 VALUES ('c1', 'w', 'Mine', 'V', 100, 'd')",
                [],
            )
            .unwrap();
        connection.execute("DELETE FROM outbox", []).unwrap();
        connection
    }

    fn collection_row(name: &str, updated_at: i64) -> Row {
        serde_json::from_value(json!({
            "id": "c1",
            "workspace_id": "w",
            "name": name,
            "description": "",
            "rank": "V",
            "updated_at": updated_at,
            "rev": 2,
            "device_id": "other"
        }))
        .unwrap()
    }

    #[test]
    fn a_row_we_have_not_touched_is_taken() {
        let connection = fresh();
        let collections = table("collections").unwrap();

        let conflicted = apply(
            &connection,
            collections,
            &collection_row("Theirs", 200),
            "d",
        )
        .unwrap();
        assert!(!conflicted);

        let name: String = connection
            .query_row("SELECT name FROM collections WHERE id = 'c1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "Theirs");
    }

    /// Applying a pull must not queue what it applied, or the pass would push
    /// the remote's own rows back at it for ever.
    #[test]
    fn applying_does_not_queue_what_it_applied() {
        let connection = fresh();
        let collections = table("collections").unwrap();

        {
            let _quiet = Suspended::begin(&connection).unwrap();
            apply(
                &connection,
                collections,
                &collection_row("Theirs", 200),
                "d",
            )
            .unwrap();
        }

        let queued: i64 = connection
            .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
            .unwrap();
        assert_eq!(queued, 0);
    }

    /// And the flag comes off even when applying fails partway.
    #[test]
    fn the_suspension_lifts_even_when_something_goes_wrong() {
        let connection = fresh();
        {
            let _quiet = Suspended::begin(&connection).unwrap();
            assert!(queries::get_meta(&connection, "outbox_suspended")
                .unwrap()
                .is_some());
        }
        assert!(queries::get_meta(&connection, "outbox_suspended")
            .unwrap()
            .is_none());
    }

    #[test]
    fn both_sides_changed_keeps_ours_beside_theirs() {
        let connection = fresh();
        let collections = table("collections").unwrap();

        // Edited here since the last push, and edited there more recently.
        connection
            .execute(
                "UPDATE collections SET name = 'Mine edited', updated_at = 150 WHERE id = 'c1'",
                [],
            )
            .unwrap();

        let conflicted = apply(
            &connection,
            collections,
            &collection_row("Theirs", 200),
            "laptop",
        )
        .unwrap();
        assert!(conflicted);

        let names: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT name FROM collections ORDER BY conflicted_at IS NULL DESC, name")
                .unwrap();
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap();
            rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };

        assert_eq!(
            names.len(),
            2,
            "the remote takes the id, ours is kept beside it"
        );
        assert!(names.iter().any(|name| name == "Theirs"));
        assert!(names
            .iter()
            .any(|name| name.starts_with("Mine edited (conflicted copy · laptop")));
    }

    /// The conflict that actually happens: the same request edited twice. The
    /// local body has to survive, and a request row with no item would be a
    /// body nobody can reach.
    #[test]
    fn a_conflicted_request_is_kept_under_an_item_of_its_own() {
        let connection = fresh();
        connection
            .execute(
                "INSERT INTO items (id, collection_id, kind, name, rank, updated_at, device_id)
                 VALUES ('i1', 'c1', 'request', 'List users', 'V', 100, 'd')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO requests (item_id, method, url, updated_at, device_id)
                 VALUES ('i1', 'GET', 'https://mine.example.com', 150, 'd')",
                [],
            )
            .unwrap();

        let requests = table("requests").unwrap();
        let theirs: Row = serde_json::from_value(json!({
            "item_id": "i1",
            "method": "GET",
            "url": "https://theirs.example.com",
            "headers": "[]",
            "body": "{}",
            "updated_at": 200,
            "rev": 2,
            "device_id": "other"
        }))
        .unwrap();

        assert!(apply(&connection, requests, &theirs, "laptop").unwrap());

        let mine: String = connection
            .query_row(
                "SELECT r.url FROM requests r JOIN items i ON i.id = r.item_id
                  WHERE i.conflicted_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mine, "https://mine.example.com");

        let theirs_now: String = connection
            .query_row("SELECT url FROM requests WHERE item_id = 'i1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(theirs_now, "https://theirs.example.com");
    }

    #[test]
    fn a_secret_travels_as_a_name_without_its_value() {
        let variables = table("variables").unwrap();

        let mut secret: Row =
            serde_json::from_value(json!({ "key": "token", "value": "shhh", "secret": 1 }))
                .unwrap();
        redact(variables, &mut secret);
        assert_eq!(secret["value"], "");
        assert_eq!(secret["key"], "token", "the name still travels");

        let mut ordinary: Row =
            serde_json::from_value(json!({ "key": "host", "value": "example.com", "secret": 0 }))
                .unwrap();
        redact(variables, &mut ordinary);
        assert_eq!(ordinary["value"], "example.com");
    }

    #[test]
    fn watermarks_survive_a_round_trip() {
        let connection = fresh();
        let mut marks = watermarks(&connection);
        assert!(marks.pulled.is_empty());

        marks.pulled.insert("items".into(), 1_700_000_000_123);
        save_watermarks(&connection, &marks).unwrap();

        assert_eq!(
            watermarks(&connection).pulled.get("items"),
            Some(&1_700_000_000_123)
        );
    }
}

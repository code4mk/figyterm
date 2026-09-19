//! The schema, and the migrations that get an existing database to it.
//!
//! Versioned through `PRAGMA user_version`, which SQLite keeps in the file
//! header for exactly this. Migrations are append-only: a released one is never
//! edited, because someone's database has already run it.
//!
//! Only the tables the app actually uses are created. The plan listed
//! `examples`, `environments` and `variables` here too; they arrive with the
//! phases that read them. A schema full of tables nothing touches is a schema
//! that lies about what the app does, and adding a table in migration 2 is
//! three lines.

use rusqlite::Connection;

use super::StoreResult;

/// Every migration, in order. The index is the version it brings the database
/// to, so `MIGRATIONS[0]` takes a fresh file to version 1.
const MIGRATIONS: &[&str] = &[
    INITIAL, IMPORTED, SCOPED, EXAMPLED, SYNCED, DESCRIBED, CURRENT,
];

pub fn migrate(connection: &Connection) -> StoreResult<()> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let applied = version as usize;
    if applied > MIGRATIONS.len() {
        return Err(format!(
            "This collection database was written by a newer version of the app (schema {version}, this build understands {}).",
            MIGRATIONS.len()
        ));
    }

    for (index, migration) in MIGRATIONS.iter().enumerate().skip(applied) {
        connection
            .execute_batch(migration)
            .map_err(|e| format!("Migration {} failed: {e}", index + 1))?;
        // Not a bound parameter: SQLite does not allow one in a pragma, and the
        // value is an index into a constant array rather than anything typed.
        connection
            .pragma_update(None, "user_version", (index + 1) as i64)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Version 1.
///
/// Notes on the shape, since SQL says what but not why:
///
/// - `rank` is a **fractional index**, a sortable string rather than an integer
///   position. Two machines each dragging a request into the same folder while
///   offline must not have to renumber every sibling; with integers they
///   produce two irreconcilable renumberings, with fractional ranks they
///   produce two neighbouring keys and both survive. Generated in
///   `services/api/rank.ts`, where it is tested.
/// - `headers` and `body` are JSON. They are edited and displayed as a unit,
///   never queried by their contents, and normalising them into rows would buy
///   nothing but joins.
/// - `raw` on a collection is the document exactly as it was imported, so an
///   export can put back whatever this model does not understand. It is unused
///   until the interchange phase, and the column exists now so that phase does
///   not have to migrate a database full of collections.
/// - History keeps only the metadata of a response; the body goes to a file
///   under `api-bodies/`, because a table of megabyte bodies makes every query
///   against it slow for the sake of data nobody searches.
const INITIAL: &str = r#"
CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    rev         INTEGER NOT NULL DEFAULT 1,
    device_id   TEXT NOT NULL
);

CREATE TABLE collections (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    rank         TEXT NOT NULL,
    auth         TEXT,
    variables    TEXT,
    events       TEXT,
    raw          TEXT,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    rev          INTEGER NOT NULL DEFAULT 1,
    device_id    TEXT NOT NULL
);
CREATE INDEX collections_by_workspace ON collections(workspace_id, deleted_at);

CREATE TABLE items (
    id            TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id),
    parent_id     TEXT REFERENCES items(id),
    kind          TEXT NOT NULL CHECK (kind IN ('folder', 'request')),
    name          TEXT NOT NULL,
    rank          TEXT NOT NULL,
    auth          TEXT,
    events        TEXT,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER,
    rev           INTEGER NOT NULL DEFAULT 1,
    device_id     TEXT NOT NULL
);
CREATE INDEX items_by_collection ON items(collection_id, deleted_at);
CREATE INDEX items_by_parent ON items(parent_id);

CREATE TABLE requests (
    item_id    TEXT PRIMARY KEY REFERENCES items(id),
    method     TEXT NOT NULL,
    url        TEXT NOT NULL,
    headers    TEXT NOT NULL DEFAULT '[]',
    body       TEXT NOT NULL DEFAULT '{}',
    settings   TEXT,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev        INTEGER NOT NULL DEFAULT 1,
    device_id  TEXT NOT NULL
);

CREATE TABLE history (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    item_id      TEXT,
    sent_at      INTEGER NOT NULL,
    method       TEXT NOT NULL,
    url          TEXT NOT NULL,
    status       INTEGER,
    duration_ms  INTEGER,
    size_bytes   INTEGER,
    error        TEXT,
    request      TEXT NOT NULL,
    response     TEXT,
    body_path    TEXT
);
CREATE INDEX history_by_time ON history(workspace_id, sent_at DESC);

CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

/// Version 2, which the interchange phase needs.
///
/// - **`items.raw`.** A collection already kept the document it was imported
///   from; an *item* needs its own copy for the same reason at a finer grain.
///   Export rebuilds each entry by merging what this model owns over what was
///   imported, so a script, an auth block, a disabled query parameter or a
///   vendor-prefixed key nobody here has heard of all come back out intact.
///   Without it, a round trip through this app is a data-loss event for
///   whoever sent the file.
/// - **Environments.** Not because anything can use one yet — the scope chain
///   is the next phase — but because an import that silently dropped somebody's
///   environment file would do so at exactly the moment they were migrating,
///   which is the worst possible moment.
///
/// `variables` carries the scope it belongs to from the start, so the phase
/// that adds collection, folder and request variables adds rows rather than
/// columns.
const IMPORTED: &str = r#"
ALTER TABLE items ADD COLUMN raw TEXT;

CREATE TABLE environments (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name         TEXT NOT NULL,
    /* The one unnamed environment whose variables apply everywhere. */
    is_global    INTEGER NOT NULL DEFAULT 0,
    rank         TEXT NOT NULL DEFAULT 'V',
    raw          TEXT,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    rev          INTEGER NOT NULL DEFAULT 1,
    device_id    TEXT NOT NULL
);
CREATE INDEX environments_by_workspace ON environments(workspace_id, deleted_at);

CREATE TABLE variables (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL CHECK (scope IN
                   ('global', 'environment', 'collection', 'folder', 'request')),
    /* The environment, collection, folder or request it belongs to. */
    scope_id   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    /* Secrets never leave the machine in a synced row; see docs/API-CLIENT.md.
       The column marks which ones that will apply to. */
    secret     INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev        INTEGER NOT NULL DEFAULT 1,
    device_id  TEXT NOT NULL
);
CREATE INDEX variables_by_scope ON variables(scope, scope_id, deleted_at);
"#;

/// Version 3, which the scope chain needs.
///
/// A folder and a request can each carry variables of their own, and the chain
/// they sit in is the whole point of variables: the innermost value wins. The
/// column is separate from `raw` because these are edited, resolved and
/// compared on every send, and parsing a whole document to read two pairs would
/// be the wrong shape for that.
const SCOPED: &str = r#"
ALTER TABLE items ADD COLUMN variables TEXT;
"#;

/// Version 4: saved responses.
///
/// An example is a response somebody kept — the 200 that shows what the shape
/// is, the 422 that shows what a validation error looks like. The format calls
/// them `response[]` on a request, and they are the part of a collection that
/// makes it documentation rather than a list of URLs.
///
/// The body is a column rather than a file, unlike history's: an example is
/// chosen deliberately and is nearly always small, and keeping it in the row
/// means an export needs no second read.
const EXAMPLED: &str = r#"
CREATE TABLE examples (
    id          TEXT PRIMARY KEY,
    item_id     TEXT NOT NULL REFERENCES items(id),
    name        TEXT NOT NULL,
    status      INTEGER,
    status_text TEXT,
    headers     TEXT,
    body        TEXT,
    rank        TEXT NOT NULL DEFAULT 'V',
    raw         TEXT,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    rev         INTEGER NOT NULL DEFAULT 1,
    device_id   TEXT NOT NULL
);
CREATE INDEX examples_by_item ON examples(item_id, deleted_at);
"#;

/// Version 5: the outbox, and the row-level marks sync needs.
///
/// **The outbox is written by triggers, not by the writers.** Every mutation in
/// `queries.rs` would otherwise have to remember to enqueue, and the one that
/// forgot would produce a row that never syncs and never says why. A trigger
/// fires inside the same transaction as the write by definition, which is
/// exactly the guarantee the design asks for, and it cost no changes to the
/// thirty functions that already existed.
///
/// **One entry per row, not one per edit.** Sync copies rows, not operations:
/// what matters is that a row is dirty, and the second edit before a push adds
/// nothing. The upsert collapses them.
///
/// **`outbox_suspended`.** Applying what a pull brought back is itself a write,
/// and without this the merge would enqueue every remote row straight back for
/// pushing — a loop that syncs for ever and changes nothing. The worker sets
/// the flag while it applies, and the triggers check it.
///
/// `conflicted_at` marks a local copy kept when both sides changed a row. It is
/// a column rather than a name convention so the rail can badge it without
/// parsing titles.
const SYNCED: &str = r#"
CREATE TABLE outbox (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_id     TEXT NOT NULL,
    queued_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX outbox_row ON outbox(table_name, row_id);

ALTER TABLE collections ADD COLUMN conflicted_at INTEGER;
ALTER TABLE items ADD COLUMN conflicted_at INTEGER;
ALTER TABLE environments ADD COLUMN conflicted_at INTEGER;

CREATE TRIGGER workspaces_outbox_insert AFTER INSERT ON workspaces
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('workspaces', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER workspaces_outbox_update AFTER UPDATE ON workspaces
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('workspaces', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER collections_outbox_insert AFTER INSERT ON collections
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('collections', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER collections_outbox_update AFTER UPDATE ON collections
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('collections', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER items_outbox_insert AFTER INSERT ON items
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('items', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER items_outbox_update AFTER UPDATE ON items
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('items', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER requests_outbox_insert AFTER INSERT ON requests
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('requests', NEW.item_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER requests_outbox_update AFTER UPDATE ON requests
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('requests', NEW.item_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER examples_outbox_insert AFTER INSERT ON examples
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('examples', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER examples_outbox_update AFTER UPDATE ON examples
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('examples', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER environments_outbox_insert AFTER INSERT ON environments
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('environments', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER environments_outbox_update AFTER UPDATE ON environments
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('environments', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER variables_outbox_insert AFTER INSERT ON variables
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('variables', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;

CREATE TRIGGER variables_outbox_update AFTER UPDATE ON variables
WHEN (SELECT 1 FROM meta WHERE key = 'outbox_suspended') IS NULL
BEGIN
    INSERT INTO outbox (table_name, row_id, queued_at)
    VALUES ('variables', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(table_name, row_id) DO UPDATE SET queued_at = excluded.queued_at;
END;
"#;

/// Version 6: a folder has something to say for itself.
///
/// The format lets every level of the tree carry a description, and folder
/// descriptions were surviving a round trip only because they rode along inside
/// `raw`. That is enough to not lose them and not enough to show one, let alone
/// edit one — which the folder tab needs to do.
///
/// `NOT NULL DEFAULT ''` matches the column collections has had since version 1,
/// so the two levels answer the same way and the sync codec needs no special
/// case: it is a text column like any other.
const DESCRIBED: &str = r#"
ALTER TABLE items ADD COLUMN description TEXT NOT NULL DEFAULT '';
"#;

/// Version 7: a variable's *current* value, which is this machine's alone.
///
/// The format, and everyone who shares a collection, means `value` as the
/// **initial** value: the one that exports, the one that syncs, the one a
/// colleague gets when they open the file. It is also the one nobody wants to
/// put a real token in.
///
/// `current_value` is where the real token goes. It resolves in preference to
/// `value`, it is never exported, and — the point of the whole column — it is
/// **not in the sync table's column list**, so it never leaves this machine.
/// Null means "no separate current value", which is not the same as an empty
/// one: empty is a deliberate blank, null is "use the initial".
const CURRENT: &str = r#"
ALTER TABLE variables ADD COLUMN current_value TEXT;
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection
    }

    #[test]
    fn a_fresh_database_reaches_the_current_version() {
        let connection = fresh();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }

    /// Opening an already-migrated database must be a no-op, not a second run
    /// of a `CREATE TABLE` that would fail.
    #[test]
    fn migrating_twice_changes_nothing() {
        let connection = fresh();
        migrate(&connection).unwrap();
        let tables: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'items'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
    }

    /// A database from a newer build is refused rather than half-read. Opening
    /// it read-anyway would mean a downgrade silently dropping columns it does
    /// not know about on the next write.
    #[test]
    fn a_newer_database_is_refused() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "user_version", (MIGRATIONS.len() + 1) as i64)
            .unwrap();
        assert!(migrate(&connection).is_err());
    }

    #[test]
    fn an_item_must_be_a_folder_or_a_request() {
        let connection = fresh();
        connection
            .execute(
                "INSERT INTO workspaces (id, name, created_at, updated_at, device_id)
                 VALUES ('w', 'W', 0, 0, 'd')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collections (id, workspace_id, name, rank, updated_at, device_id)
                 VALUES ('c', 'w', 'C', 'V', 0, 'd')",
                [],
            )
            .unwrap();
        let bad = connection.execute(
            "INSERT INTO items (id, collection_id, kind, name, rank, updated_at, device_id)
             VALUES ('i', 'c', 'elephant', 'I', 'V', 0, 'd')",
            [],
        );
        assert!(bad.is_err());
    }
}

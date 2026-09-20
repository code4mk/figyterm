//! Every read and write the API client makes.
//!
//! Two rules hold throughout:
//!
//! - **Nothing is deleted while sync might still care.** `deleted_at` is set
//!   and `rev` bumped; every read filters tombstones out. History is the
//!   exception — it is local, capped and pruned for real.
//! - **A write and everything it implies go in one transaction.** Deleting a
//!   folder marks the folder, its whole subtree and the requests underneath it;
//!   a crash halfway through would otherwise leave a request alive under a
//!   folder that is gone, visible to nothing and syncable to a remote.
//!
//! Ranks are never computed here. They arrive from `services/api/rank.ts`,
//! where the arithmetic is tested, and this layer only stores them.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use uuid::Uuid;

use super::model::{
    Collection, Environment, Example, ExampleSummary, ExportBundle, ExportItem, ExportRequest,
    HistoryEntry,
    ImportCollection, ImportEnvironment, Item, ItemKind, NewExample, NewHistory, SavedRequest,
    Snapshot, Variable, Workspace,
};
use super::{now_ms, StoreResult};

/// How many history entries a workspace keeps. Older ones, and their body
/// files, are pruned as new ones arrive — an unbounded log of every response
/// anyone ever received is a disk leak, not a feature.
const HISTORY_LIMIT: usize = 500;

fn sql<T>(result: rusqlite::Result<T>) -> StoreResult<T> {
    result.map_err(|e| e.to_string())
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

// ─── Meta ────────────────────────────────────────────────────────────────────

pub fn get_meta(connection: &Connection, key: &str) -> StoreResult<Option<String>> {
    sql(connection
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional())
}

pub fn set_meta(connection: &Connection, key: &str, value: &str) -> StoreResult<()> {
    sql(connection.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    ))?;
    Ok(())
}

/// This installation's id, minted once and kept.
///
/// It is written into every row so that, once there is a remote, a conflict can
/// say *which machine* wrote the losing copy. A conflicted copy named after
/// nothing is much harder to reason about than one named after the laptop it
/// came from.
pub fn device_id(connection: &Connection) -> StoreResult<String> {
    if let Some(existing) = get_meta(connection, "device_id")? {
        return Ok(existing);
    }
    let id = new_id();
    set_meta(connection, "device_id", &id)?;
    Ok(id)
}

// ─── Workspace ───────────────────────────────────────────────────────────────

/// Which workspace is open, created on first run.
///
/// The chosen one is in `meta`, not in a column on the workspace itself: which
/// one somebody is looking at is a fact about this machine, and a column would
/// sync it — so switching workspace on a laptop would switch it on the desktop
/// halfway through somebody else's afternoon.
///
/// A stored id that no longer resolves — the workspace was deleted here, or
/// deleted on another machine and the deletion synced in — falls back to the
/// oldest one rather than failing. There is always somewhere to be.
pub fn workspace_id(connection: &Connection) -> StoreResult<String> {
    if let Some(chosen) = get_meta(connection, "active_workspace")? {
        let alive: Option<String> = sql(connection
            .query_row(
                "SELECT id FROM workspaces WHERE id = ?1 AND deleted_at IS NULL",
                [&chosen],
                |row| row.get(0),
            )
            .optional())?;
        if let Some(id) = alive {
            return Ok(id);
        }
    }

    let existing: Option<String> = sql(connection
        .query_row(
            "SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional())?;
    if let Some(id) = existing {
        return Ok(id);
    }

    let id = new_id();
    let now = now_ms();
    let device = device_id(connection)?;
    sql(connection.execute(
        "INSERT INTO workspaces (id, name, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?3, ?4)",
        params![id, "Personal", now, device],
    ))?;
    Ok(id)
}

/// Where a workspace's open tabs are kept.
pub fn session_key(workspace: &str) -> String {
    format!("session:{workspace}")
}

/// Every workspace, oldest first — which is the order they were made in, and
/// the only order that does not move under somebody who is used to where
/// theirs sits.
pub fn workspaces(connection: &Connection) -> StoreResult<Vec<Workspace>> {
    let mut statement = sql(connection.prepare(
        "SELECT id, name, created_at, updated_at
           FROM workspaces
          WHERE deleted_at IS NULL
          ORDER BY created_at",
    ))?;
    let rows = sql(statement.query_map([], |row| {
        Ok(Workspace {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    }))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn create_workspace(connection: &Connection, name: &str) -> StoreResult<String> {
    let id = new_id();
    let now = now_ms();
    let device = device_id(connection)?;
    sql(connection.execute(
        "INSERT INTO workspaces (id, name, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?3, ?4)",
        params![id, name.trim(), now, device],
    ))?;
    Ok(id)
}

pub fn rename_workspace(connection: &Connection, id: &str, name: &str) -> StoreResult<()> {
    let device = device_id(connection)?;
    sql(connection.execute(
        "UPDATE workspaces
            SET name = ?2, updated_at = ?3, rev = rev + 1, device_id = ?4
          WHERE id = ?1 AND deleted_at IS NULL",
        params![id, name.trim(), now_ms(), device],
    ))?;
    Ok(())
}

/// Switches which workspace is open.
///
/// Refuses an id that is not a live workspace rather than storing it: a
/// dangling choice would be found again on the next open, fall back, and leave
/// somebody wondering why the switch did not take.
pub fn set_active_workspace(connection: &Connection, id: &str) -> StoreResult<()> {
    let alive: Option<String> = sql(connection
        .query_row(
            "SELECT id FROM workspaces WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .optional())?;
    if alive.is_none() {
        return Err("that workspace is no longer there".into());
    }
    set_meta(connection, "active_workspace", id)
}

/// Deletes a workspace, and with it everything inside.
///
/// Soft, like every other delete here, so a sync carries the deletion rather
/// than silently resurrecting the rows from another machine. The collections
/// and environments go with it: they belong to the workspace and nothing else
/// can reach them once it is gone, and leaving them would be leaving rows that
/// no query will ever return.
///
/// The last one cannot be deleted. A window with no workspace has nowhere to
/// put the collection somebody makes next, and "it made you a new one" is a
/// worse answer than "you cannot".
pub fn delete_workspace(connection: &Connection, id: &str) -> StoreResult<()> {
    let live: i64 = sql(connection.query_row(
        "SELECT COUNT(*) FROM workspaces WHERE deleted_at IS NULL",
        [],
        |row| row.get(0),
    ))?;
    if live <= 1 {
        return Err("the last workspace cannot be deleted".into());
    }

    let now = now_ms();
    let device = device_id(connection)?;

    // Environments and collections first, then the workspace: each statement
    // reads the workspace id, and a deleted workspace would still match, but
    // the order is the one that reads correctly if it is ever interrupted.
    sql(connection.execute(
        "UPDATE environments
            SET deleted_at = ?2, rev = rev + 1, device_id = ?3
          WHERE workspace_id = ?1 AND deleted_at IS NULL",
        params![id, now, device],
    ))?;
    sql(connection.execute(
        "UPDATE collections
            SET deleted_at = ?2, rev = rev + 1, device_id = ?3
          WHERE workspace_id = ?1 AND deleted_at IS NULL",
        params![id, now, device],
    ))?;
    sql(connection.execute(
        "UPDATE workspaces
            SET deleted_at = ?2, rev = rev + 1, device_id = ?3
          WHERE id = ?1",
        params![id, now, device],
    ))?;

    // The choice goes with it, so the next read falls back to a live one
    // rather than resolving a workspace that has just been deleted.
    if get_meta(connection, "active_workspace")?.as_deref() == Some(id) {
        sql(connection.execute(
            "DELETE FROM meta WHERE key = 'active_workspace'",
            [],
        ))?;
    }
    Ok(())
}

// ─── Reading the tree ────────────────────────────────────────────────────────

fn read_collection(row: &Row) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        rank: row.get(4)?,
        updated_at: row.get(5)?,
        auth: row.get::<_, Option<String>>(6)?.and_then(parse_json),
        variables: row.get::<_, Option<String>>(7)?.and_then(parse_json),
        conflicted_at: row.get(8)?,
        events: row.get::<_, Option<String>>(9)?.and_then(parse_json),
    })
}

pub fn collections(connection: &Connection, workspace: &str) -> StoreResult<Vec<Collection>> {
    let mut statement = sql(connection.prepare(
        "SELECT id, workspace_id, name, description, rank, updated_at, auth, variables,
                conflicted_at, events
           FROM collections
          WHERE workspace_id = ?1 AND deleted_at IS NULL
          ORDER BY rank, name",
    ))?;
    let rows = sql(statement.query_map([workspace], read_collection))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn read_item(row: &Row) -> rusqlite::Result<Item> {
    let kind: String = row.get(3)?;
    Ok(Item {
        id: row.get(0)?,
        collection_id: row.get(1)?,
        parent_id: row.get(2)?,
        // A row that fails the schema's own CHECK cannot exist; treating an
        // unknown kind as a request would hide a corrupt database rather than
        // report it.
        kind: ItemKind::parse(&kind).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("unknown item kind {kind:?}").into(),
            )
        })?,
        name: row.get(4)?,
        rank: row.get(5)?,
        updated_at: row.get(6)?,
        method: row.get(7)?,
        url: row.get(8)?,
        auth: row.get::<_, Option<String>>(9)?.and_then(parse_json),
        variables: row.get::<_, Option<String>>(10)?.and_then(parse_json),
        conflicted_at: row.get(11)?,
        events: row.get::<_, Option<String>>(12)?.and_then(parse_json),
        description: row.get(13)?,
    })
}

/// Every item in the workspace, in one query.
///
/// Flat rather than nested: the webview builds the tree it draws, and a
/// recursive query per folder would be dozens of round trips to render one
/// rail. A collection of a few thousand requests is a few hundred kilobytes.
pub fn items(connection: &Connection, workspace: &str) -> StoreResult<Vec<Item>> {
    let mut statement = sql(connection.prepare(
        "SELECT i.id, i.collection_id, i.parent_id, i.kind, i.name, i.rank, i.updated_at,
                r.method, r.url, i.auth, i.variables, i.conflicted_at, i.events,
                i.description
           FROM items i
           JOIN collections c ON c.id = i.collection_id
           LEFT JOIN requests r ON r.item_id = i.id AND r.deleted_at IS NULL
          WHERE c.workspace_id = ?1 AND i.deleted_at IS NULL AND c.deleted_at IS NULL
          ORDER BY i.rank, i.name",
    ))?;
    let rows = sql(statement.query_map([workspace], read_item))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn snapshot(connection: &Connection) -> StoreResult<Snapshot> {
    let workspace = workspace_id(connection)?;
    /*
      The session is per workspace.

      A session is a list of open tabs, and a tab is a request in a collection
      that belongs to exactly one workspace — so one shared session would come
      back full of tabs pointing at rows the open workspace cannot see, and
      every switch would throw away the tabs of the workspace being left.

      The bare `session` key is what installations before workspaces wrote.
      Read as the fallback so the first open after this change still finds the
      tabs that were there; the next save writes the scoped key.
    */
    let session = get_meta(connection, &session_key(&workspace))?
        .or(get_meta(connection, "session")?)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());

    Ok(Snapshot {
        workspaces: workspaces(connection)?,
        collections: collections(connection, &workspace)?,
        items: items(connection, &workspace)?,
        history: list_history(connection, &workspace, 100)?,
        environments: environments(connection, &workspace)?,
        examples: example_index(connection, &workspace)?,
        session,
        workspace_id: workspace,
    })
}

// ─── Collections ─────────────────────────────────────────────────────────────

pub fn create_collection(
    connection: &Connection,
    workspace: &str,
    name: &str,
    rank: &str,
) -> StoreResult<Collection> {
    let id = new_id();
    let now = now_ms();
    let device = device_id(connection)?;
    sql(connection.execute(
        "INSERT INTO collections (id, workspace_id, name, rank, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, workspace, name, rank, now, device],
    ))?;
    Ok(Collection {
        id,
        workspace_id: workspace.to_string(),
        name: name.to_string(),
        description: String::new(),
        rank: rank.to_string(),
        updated_at: now,
        auth: None,
        variables: None,
        conflicted_at: None,
        events: None,
    })
}

pub fn rename_collection(connection: &Connection, id: &str, name: &str) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE collections SET name = ?2, updated_at = ?3, rev = rev + 1 WHERE id = ?1",
        params![id, name, now_ms()],
    ))?;
    Ok(())
}

/// Tombstones a collection, its whole tree and every request in it.
pub fn delete_collection(connection: &Connection, id: &str) -> StoreResult<()> {
    let transaction = sql(connection.unchecked_transaction())?;
    let now = now_ms();

    sql(transaction.execute(
        "UPDATE requests SET deleted_at = ?2, rev = rev + 1
          WHERE deleted_at IS NULL
            AND item_id IN (SELECT id FROM items WHERE collection_id = ?1)",
        params![id, now],
    ))?;
    sql(transaction.execute(
        "UPDATE items SET deleted_at = ?2, rev = rev + 1
          WHERE collection_id = ?1 AND deleted_at IS NULL",
        params![id, now],
    ))?;
    sql(transaction.execute(
        "UPDATE collections SET deleted_at = ?2, rev = rev + 1 WHERE id = ?1",
        params![id, now],
    ))?;

    sql(transaction.commit())
}

// ─── Items ───────────────────────────────────────────────────────────────────

pub fn create_item(
    connection: &Connection,
    collection_id: &str,
    parent_id: Option<&str>,
    kind: ItemKind,
    name: &str,
    rank: &str,
) -> StoreResult<Item> {
    let id = new_id();
    let now = now_ms();
    let device = device_id(connection)?;

    let transaction = sql(connection.unchecked_transaction())?;
    sql(transaction.execute(
        "INSERT INTO items (id, collection_id, parent_id, kind, name, rank, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            collection_id,
            parent_id,
            kind.as_str(),
            name,
            rank,
            now,
            device
        ],
    ))?;

    // A request without its row is an item that cannot be opened. The two go in
    // together so no state exists where one is there and the other is not.
    if kind == ItemKind::Request {
        sql(transaction.execute(
            "INSERT INTO requests (item_id, method, url, updated_at, device_id)
             VALUES (?1, 'GET', '', ?2, ?3)",
            params![id, now, device],
        ))?;
    }
    sql(transaction.commit())?;

    Ok(Item {
        id,
        collection_id: collection_id.to_string(),
        parent_id: parent_id.map(str::to_string),
        kind,
        name: name.to_string(),
        description: String::new(),
        rank: rank.to_string(),
        updated_at: now,
        method: (kind == ItemKind::Request).then(|| "GET".to_string()),
        url: (kind == ItemKind::Request).then(String::new),
        auth: None,
        variables: None,
        conflicted_at: None,
        events: None,
    })
}

pub fn rename_item(connection: &Connection, id: &str, name: &str) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE items SET name = ?2, updated_at = ?3, rev = rev + 1 WHERE id = ?1",
        params![id, name, now_ms()],
    ))?;
    Ok(())
}

/// Moves an item to a new parent and position — the same call whether it was
/// dragged within its folder or into another one.
pub fn move_item(
    connection: &Connection,
    id: &str,
    collection_id: &str,
    parent_id: Option<&str>,
    rank: &str,
) -> StoreResult<()> {
    let transaction = sql(connection.unchecked_transaction())?;
    let now = now_ms();

    sql(transaction.execute(
        "UPDATE items SET collection_id = ?2, parent_id = ?3, rank = ?4,
                          updated_at = ?5, rev = rev + 1
          WHERE id = ?1",
        params![id, collection_id, parent_id, rank, now],
    ))?;

    // A folder dragged into another collection takes its subtree with it. The
    // children keep their ranks, which are relative to their parent.
    sql(transaction.execute(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM items WHERE parent_id = ?1
             UNION ALL
             SELECT i.id FROM items i JOIN subtree s ON i.parent_id = s.id
         )
         UPDATE items SET collection_id = ?2, updated_at = ?3, rev = rev + 1
          WHERE id IN (SELECT id FROM subtree)",
        params![id, collection_id, now],
    ))?;

    sql(transaction.commit())
}

/// Tombstones an item and everything under it.
pub fn delete_item(connection: &Connection, id: &str) -> StoreResult<()> {
    let transaction = sql(connection.unchecked_transaction())?;
    let now = now_ms();

    sql(transaction.execute(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM items WHERE id = ?1
             UNION ALL
             SELECT i.id FROM items i JOIN subtree s ON i.parent_id = s.id
         )
         UPDATE requests SET deleted_at = ?2, rev = rev + 1
          WHERE item_id IN (SELECT id FROM subtree) AND deleted_at IS NULL",
        params![id, now],
    ))?;
    sql(transaction.execute(
        "WITH RECURSIVE subtree(id) AS (
             SELECT id FROM items WHERE id = ?1
             UNION ALL
             SELECT i.id FROM items i JOIN subtree s ON i.parent_id = s.id
         )
         UPDATE items SET deleted_at = ?2, rev = rev + 1
          WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL",
        params![id, now],
    ))?;

    sql(transaction.commit())
}

/// Copies an item, and a folder's whole subtree, returning every new row.
///
/// The copy is a new identity throughout — new ids, new `rev`, this device —
/// rather than a second row claiming to be the same request somewhere else,
/// which is what would reach a remote if the ids were reused.
pub fn duplicate_item(
    connection: &Connection,
    id: &str,
    name: &str,
    rank: &str,
) -> StoreResult<Vec<Item>> {
    let transaction = sql(connection.unchecked_transaction())?;
    let device = device_id(connection)?;
    let now = now_ms();

    let (collection_id, parent_id, kind): (String, Option<String>, String) = sql(transaction
        .query_row(
            "SELECT collection_id, parent_id, kind FROM items WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ))?;
    let kind = ItemKind::parse(&kind).ok_or("That item has a kind this build does not know")?;

    let mut made = Vec::new();
    copy_subtree(
        &transaction,
        CopyArgs {
            source: id,
            collection_id: &collection_id,
            parent_id: parent_id.as_deref(),
            name,
            rank,
            kind,
            device: &device,
            now,
        },
        &mut made,
    )?;

    sql(transaction.commit())?;
    Ok(made)
}

struct CopyArgs<'a> {
    source: &'a str,
    collection_id: &'a str,
    parent_id: Option<&'a str>,
    name: &'a str,
    rank: &'a str,
    kind: ItemKind,
    device: &'a str,
    now: i64,
}

fn copy_subtree(
    connection: &Connection,
    args: CopyArgs,
    made: &mut Vec<Item>,
) -> StoreResult<String> {
    let id = new_id();

    sql(connection.execute(
        "INSERT INTO items (id, collection_id, parent_id, kind, name, description, rank, auth,
                            events, variables, raw, updated_at, device_id)
         SELECT ?1, ?2, ?3, kind, ?4, description, ?5, auth, events, variables, raw, ?6, ?7
           FROM items WHERE id = ?8",
        params![
            id,
            args.collection_id,
            args.parent_id,
            args.name,
            args.rank,
            args.now,
            args.device,
            args.source
        ],
    ))?;

    let mut copied_method = None;
    let mut copied_url = None;
    if args.kind == ItemKind::Request {
        sql(connection.execute(
            "INSERT INTO requests (item_id, method, url, headers, body, settings,
                                   updated_at, device_id)
             SELECT ?1, method, url, headers, body, settings, ?2, ?3
               FROM requests WHERE item_id = ?4",
            params![id, args.now, args.device, args.source],
        ))?;
        let row: Option<(String, String)> = sql(connection
            .query_row(
                "SELECT method, url FROM requests WHERE item_id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional())?;
        if let Some((method, url)) = row {
            copied_method = Some(method);
            copied_url = Some(url);
        }
    }

    // Read back rather than guessed. The insert above copies the source's
    // description, auth, variables and scripts, and reporting them as absent
    // would leave the rail and the folder tab drawing a copy that looks emptier
    // than the row actually is until something forces a reload.
    let (description, auth, variables, events): (String, Option<String>, Option<String>, Option<String>) =
        sql(connection.query_row(
            "SELECT description, auth, variables, events FROM items WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ))?;

    made.push(Item {
        id: id.clone(),
        collection_id: args.collection_id.to_string(),
        parent_id: args.parent_id.map(str::to_string),
        kind: args.kind,
        name: args.name.to_string(),
        description,
        rank: args.rank.to_string(),
        updated_at: args.now,
        // Also read back: a duplicate carries the original's method and URL,
        // and the rail draws it the moment it appears.
        method: copied_method,
        url: copied_url,
        auth: auth.and_then(parse_json),
        variables: variables.and_then(parse_json),
        conflicted_at: None,
        events: events.and_then(parse_json),
    });

    // Children, in their own order, each keeping its name and rank.
    let children: Vec<(String, String, String, String)> = {
        let mut statement = sql(connection.prepare(
            "SELECT id, kind, name, rank FROM items
              WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY rank",
        ))?;
        let rows = sql(statement.query_map([args.source], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };

    for (child_id, child_kind, child_name, child_rank) in children {
        let kind =
            ItemKind::parse(&child_kind).ok_or("That item has a kind this build does not know")?;
        copy_subtree(
            connection,
            CopyArgs {
                source: &child_id,
                collection_id: args.collection_id,
                parent_id: Some(&id),
                name: &child_name,
                rank: &child_rank,
                kind,
                device: args.device,
                now: args.now,
            },
            made,
        )?;
    }

    Ok(id)
}

// ─── Requests ────────────────────────────────────────────────────────────────

pub fn load_request(connection: &Connection, item_id: &str) -> StoreResult<Option<SavedRequest>> {
    let row: Option<(String, String, String, String, Option<String>)> = sql(connection
        .query_row(
            "SELECT method, url, headers, body, settings FROM requests
              WHERE item_id = ?1 AND deleted_at IS NULL",
            [item_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional())?;

    Ok(
        row.map(|(method, url, headers, body, settings)| SavedRequest {
            item_id: item_id.to_string(),
            method,
            url,
            settings: settings.and_then(parse_json),
            // A column that will not parse becomes an empty value rather than an
            // error: a request whose headers are unreadable should still open, with
            // its URL intact, so it can be fixed.
            headers: serde_json::from_str(&headers).unwrap_or_else(|_| Value::Array(Vec::new())),
            body: serde_json::from_str(&body).unwrap_or_else(|_| Value::Object(Default::default())),
        }),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn save_request(
    connection: &Connection,
    item_id: &str,
    method: &str,
    url: &str,
    headers: &Value,
    body: &Value,
    settings: Option<&Value>,
) -> StoreResult<()> {
    let device = device_id(connection)?;
    sql(connection.execute(
        "INSERT INTO requests (item_id, method, url, headers, body, settings, updated_at,
                               device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(item_id) DO UPDATE SET
             method = excluded.method,
             url = excluded.url,
             headers = excluded.headers,
             body = excluded.body,
             settings = excluded.settings,
             updated_at = excluded.updated_at,
             deleted_at = NULL,
             rev = requests.rev + 1",
        params![
            item_id,
            method,
            url,
            headers.to_string(),
            body.to_string(),
            settings.map(Value::to_string),
            now_ms(),
            device
        ],
    ))?;
    Ok(())
}

/// The auth block on a folder or a request. `None` removes it, which is what
/// makes the row inherit again — the distinction the whole chain rests on.
pub fn save_item_auth(connection: &Connection, id: &str, auth: Option<&Value>) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE items SET auth = ?2, updated_at = ?3, rev = rev + 1 WHERE id = ?1",
        params![id, auth.map(Value::to_string), now_ms()],
    ))?;
    Ok(())
}

/// The scripts on a folder or a request. `None` removes them.
pub fn save_item_events(
    connection: &Connection,
    id: &str,
    events: Option<&Value>,
) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE items SET events = ?2, updated_at = ?3, rev = rev + 1 WHERE id = ?1",
        params![id, events.map(Value::to_string), now_ms()],
    ))?;
    Ok(())
}

/// A collection's own auth and variables — the outermost scope under the
/// environment.
pub fn save_collection_scope(
    connection: &Connection,
    id: &str,
    auth: Option<&Value>,
    variables: Option<&Value>,
) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE collections SET auth = ?2, variables = ?3, updated_at = ?4, rev = rev + 1
          WHERE id = ?1",
        params![
            id,
            auth.map(Value::to_string),
            variables.map(Value::to_string),
            now_ms()
        ],
    ))?;
    Ok(())
}

/// Everything the folder tab edits, in one statement.
///
/// One write rather than four, because these are saved together from one
/// surface: four writes would bump `rev` four times and enqueue the row four
/// times for a single save, and a failure halfway would leave a folder with its
/// new auth and its old scripts.
pub fn save_item_scope(
    connection: &Connection,
    id: &str,
    name: &str,
    description: &str,
    auth: Option<&Value>,
    variables: Option<&Value>,
    events: Option<&Value>,
) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE items
            SET name = ?2, description = ?3, auth = ?4, variables = ?5, events = ?6,
                updated_at = ?7, rev = rev + 1
          WHERE id = ?1",
        params![
            id,
            name,
            description,
            auth.map(Value::to_string),
            variables.map(Value::to_string),
            events.map(Value::to_string),
            now_ms()
        ],
    ))?;
    Ok(())
}

/// The same, one level up. `save_collection_scope` stays as it is because the
/// variable strip calls it with nothing else to say.
pub fn save_collection_overview(
    connection: &Connection,
    id: &str,
    name: &str,
    description: &str,
    auth: Option<&Value>,
    variables: Option<&Value>,
    events: Option<&Value>,
) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE collections
            SET name = ?2, description = ?3, auth = ?4, variables = ?5, events = ?6,
                updated_at = ?7, rev = rev + 1
          WHERE id = ?1",
        params![
            id,
            name,
            description,
            auth.map(Value::to_string),
            variables.map(Value::to_string),
            events.map(Value::to_string),
            now_ms()
        ],
    ))?;
    Ok(())
}

// ─── History ─────────────────────────────────────────────────────────────────

fn read_history(row: &Row) -> rusqlite::Result<HistoryEntry> {
    let request: String = row.get(8)?;
    let response: Option<String> = row.get(9)?;
    let body_path: Option<String> = row.get(10)?;
    Ok(HistoryEntry {
        id: row.get(0)?,
        item_id: row.get(1)?,
        sent_at: row.get(2)?,
        method: row.get(3)?,
        url: row.get(4)?,
        status: row.get(5)?,
        duration_ms: row.get(6)?,
        size_bytes: row.get(7)?,
        error: row.get(11)?,
        request: serde_json::from_str(&request).unwrap_or(Value::Null),
        response: response.and_then(|text| serde_json::from_str(&text).ok()),
        has_body: body_path.is_some(),
    })
}

pub fn list_history(
    connection: &Connection,
    workspace: &str,
    limit: usize,
) -> StoreResult<Vec<HistoryEntry>> {
    let mut statement = sql(connection.prepare(
        "SELECT id, item_id, sent_at, method, url, status, duration_ms, size_bytes,
                request, response, body_path, error
           FROM history
          WHERE workspace_id = ?1
          ORDER BY sent_at DESC
          LIMIT ?2",
    ))?;
    let rows = sql(statement.query_map(params![workspace, limit as i64], read_history))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Records a send. `body_path` is the file the response body was written to, if
/// there was one.
///
/// The id is the caller's, not ours: the body file is named after it, and
/// writing the file before the row means there is never a row pointing at a
/// file that does not exist yet.
pub fn add_history(
    connection: &Connection,
    workspace: &str,
    id: &str,
    entry: &NewHistory,
    body_path: Option<&str>,
) -> StoreResult<()> {
    sql(connection.execute(
        "INSERT INTO history (id, workspace_id, item_id, sent_at, method, url, status,
                              duration_ms, size_bytes, error, request, response, body_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            workspace,
            entry.item_id,
            now_ms(),
            entry.method,
            entry.url,
            entry.status,
            entry.duration_ms,
            entry.size_bytes,
            entry.error,
            entry.request.to_string(),
            entry.response.as_ref().map(|value| value.to_string()),
            body_path,
        ],
    ))?;
    Ok(())
}

/// The body files of entries that have fallen off the end of the list, so the
/// caller can delete them. Returns paths; the rows are already gone.
pub fn prune_history(connection: &Connection, workspace: &str) -> StoreResult<Vec<String>> {
    let transaction = sql(connection.unchecked_transaction())?;

    let orphaned: Vec<String> = {
        let mut statement = sql(transaction.prepare(
            "SELECT body_path FROM history
              WHERE workspace_id = ?1 AND body_path IS NOT NULL
                AND id NOT IN (
                    SELECT id FROM history WHERE workspace_id = ?1
                     ORDER BY sent_at DESC LIMIT ?2
                )",
        ))?;
        let rows = sql(
            statement.query_map(params![workspace, HISTORY_LIMIT as i64], |row| {
                row.get::<_, String>(0)
            }),
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };

    sql(transaction.execute(
        "DELETE FROM history
          WHERE workspace_id = ?1
            AND id NOT IN (
                SELECT id FROM history WHERE workspace_id = ?1
                 ORDER BY sent_at DESC LIMIT ?2
            )",
        params![workspace, HISTORY_LIMIT as i64],
    ))?;

    sql(transaction.commit())?;
    Ok(orphaned)
}

/// Empties the history, returning every body file to delete.
pub fn clear_history(connection: &Connection, workspace: &str) -> StoreResult<Vec<String>> {
    let transaction = sql(connection.unchecked_transaction())?;

    let paths: Vec<String> = {
        let mut statement = sql(transaction.prepare(
            "SELECT body_path FROM history WHERE workspace_id = ?1 AND body_path IS NOT NULL",
        ))?;
        let rows = sql(statement.query_map([workspace], |row| row.get::<_, String>(0)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };

    sql(transaction.execute("DELETE FROM history WHERE workspace_id = ?1", [workspace]))?;
    sql(transaction.commit())?;
    Ok(paths)
}

pub fn history_body_path(connection: &Connection, id: &str) -> StoreResult<Option<String>> {
    sql(connection
        .query_row("SELECT body_path FROM history WHERE id = ?1", [id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()
        .map(Option::flatten))
}

// ─── Interchange ─────────────────────────────────────────────────────────────

/// Creates a whole collection — tree, requests and original documents — in one
/// transaction.
///
/// All or nothing, deliberately: a partial import looks exactly like a complete
/// one, and the person who would have to notice the difference is the person
/// who has just moved their work over and does not yet know what it should
/// contain.
pub fn import_collection(
    connection: &Connection,
    workspace: &str,
    payload: &ImportCollection,
) -> StoreResult<String> {
    let transaction = sql(connection.unchecked_transaction())?;
    let device = device_id(&transaction)?;
    let now = now_ms();

    let collection_id = new_id();
    sql(transaction.execute(
        "INSERT INTO collections (id, workspace_id, name, description, rank, auth, variables,
                                  events, raw, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            collection_id,
            workspace,
            payload.name,
            payload.description,
            payload.rank,
            payload.auth.as_ref().map(Value::to_string),
            payload.variables.as_ref().map(Value::to_string),
            payload.events.as_ref().map(Value::to_string),
            payload.raw.as_ref().map(Value::to_string),
            now,
            device,
        ],
    ))?;

    // Index in the payload to the id it was given. The list is depth first, so
    // a parent has always been inserted before the child that names it.
    let mut ids: Vec<String> = Vec::with_capacity(payload.items.len());

    for (index, item) in payload.items.iter().enumerate() {
        let id = new_id();
        let parent_id = match item.parent {
            None => None,
            Some(parent) => {
                let resolved = ids.get(parent).ok_or_else(|| {
                    format!("Item {index} names parent {parent}, which comes after it")
                })?;
                Some(resolved.clone())
            }
        };

        sql(transaction.execute(
            "INSERT INTO items (id, collection_id, parent_id, kind, name, description, rank,
                                auth, events, variables, raw, updated_at, device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                collection_id,
                parent_id,
                item.kind.as_str(),
                item.name,
                item.description,
                item.rank,
                item.auth.as_ref().map(Value::to_string),
                item.events.as_ref().map(Value::to_string),
                item.variables.as_ref().map(Value::to_string),
                item.raw.as_ref().map(Value::to_string),
                now,
                device,
            ],
        ))?;

        if let Some(request) = &item.request {
            sql(transaction.execute(
                "INSERT INTO requests (item_id, method, url, headers, body, updated_at, device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    request.method,
                    request.url,
                    request.headers.to_string(),
                    request.body.to_string(),
                    now,
                    device,
                ],
            ))?;
        }

        // Saved responses come in with the request that owns them. Their order
        // is the document's, which is why the rank is the index rather than a
        // fractional key: an import is one writer, all at once.
        for (position, example) in item.examples.iter().enumerate() {
            save_example(&transaction, &id, &format!("{position:04}"), example)?;
        }

        ids.push(id);
    }

    sql(transaction.commit())?;
    Ok(collection_id)
}

/// Everything needed to write a collection back out, in tree order.
pub fn export_collection(connection: &Connection, id: &str) -> StoreResult<ExportBundle> {
    let (name, description, auth, variables, events, raw): (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = sql(connection.query_row(
        "SELECT name, description, auth, variables, events, raw
           FROM collections WHERE id = ?1 AND deleted_at IS NULL",
        [id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    ))?;

    let mut statement = sql(connection.prepare(
        "SELECT i.id, i.parent_id, i.kind, i.name, i.rank, i.auth, i.events, i.raw,
                r.method, r.url, r.headers, r.body, i.description, i.variables
           FROM items i
           LEFT JOIN requests r ON r.item_id = i.id AND r.deleted_at IS NULL
          WHERE i.collection_id = ?1 AND i.deleted_at IS NULL
          ORDER BY i.rank, i.name",
    ))?;

    let rows = sql(statement.query_map([id], |row| {
        let kind: String = row.get(2)?;
        let method: Option<String> = row.get(8)?;
        let url: Option<String> = row.get(9)?;
        let headers: Option<String> = row.get(10)?;
        let body: Option<String> = row.get(11)?;

        Ok(ExportItem {
            examples: Vec::new(),
            id: row.get(0)?,
            parent_id: row.get(1)?,
            kind: ItemKind::parse(&kind).unwrap_or(ItemKind::Folder),
            name: row.get(3)?,
            description: row.get(12)?,
            rank: row.get(4)?,
            auth: row.get::<_, Option<String>>(5)?.and_then(parse_json),
            events: row.get::<_, Option<String>>(6)?.and_then(parse_json),
            variables: row.get::<_, Option<String>>(13)?.and_then(parse_json),
            raw: row.get::<_, Option<String>>(7)?.and_then(parse_json),
            request: method.map(|method| ExportRequest {
                method,
                url: url.unwrap_or_default(),
                headers: headers.and_then(parse_json).unwrap_or(Value::Null),
                body: body.and_then(parse_json).unwrap_or(Value::Null),
            }),
        })
    }))?;

    let mut items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    // A second pass rather than a join: an item has many examples, and a join
    // would return the item once per example for the reader to fold back up.
    for item in &mut items {
        if item.kind == ItemKind::Request {
            item.examples = examples(connection, &item.id)?;
        }
    }

    Ok(ExportBundle {
        name,
        description,
        auth: auth.and_then(parse_json),
        variables: variables.and_then(parse_json),
        events: events.and_then(parse_json),
        raw: raw.and_then(parse_json),
        items,
    })
}

/// A stored JSON column, or `None` when it will not parse.
///
/// A column that has become unreadable must not stop a collection opening: the
/// rest of it is still someone's work, and an export that loses one auth block
/// is better than an app that will not start.
fn parse_json(text: String) -> Option<Value> {
    serde_json::from_str(&text).ok()
}

// ─── Examples ────────────────────────────────────────────────────────────────

fn read_example(row: &Row) -> rusqlite::Result<Example> {
    Ok(Example {
        id: row.get(0)?,
        item_id: row.get(1)?,
        name: row.get(2)?,
        status: row.get(3)?,
        status_text: row.get(4)?,
        headers: row.get::<_, Option<String>>(5)?.and_then(parse_json),
        body: row.get(6)?,
        rank: row.get(7)?,
        raw: row.get::<_, Option<String>>(8)?.and_then(parse_json),
    })
}

/// Every example in the workspace, without its body.
///
/// One query rather than one per request: the rail needs all of them to decide
/// which rows get a twisty, and a query per row would be hundreds of round
/// trips to draw one sidebar.
pub fn example_index(
    connection: &Connection,
    workspace: &str,
) -> StoreResult<Vec<ExampleSummary>> {
    let mut statement = sql(connection.prepare(
        "SELECT e.id, e.item_id, e.name, e.status, e.rank
           FROM examples e
           JOIN items i ON i.id = e.item_id
           JOIN collections c ON c.id = i.collection_id
          WHERE c.workspace_id = ?1
            AND e.deleted_at IS NULL
            AND i.deleted_at IS NULL
            AND c.deleted_at IS NULL
          ORDER BY e.rank, e.name",
    ))?;
    let rows = sql(statement.query_map([workspace], |row| {
        Ok(ExampleSummary {
            id: row.get(0)?,
            item_id: row.get(1)?,
            name: row.get(2)?,
            status: row.get(3)?,
            rank: row.get(4)?,
        })
    }))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn examples(connection: &Connection, item_id: &str) -> StoreResult<Vec<Example>> {
    let mut statement = sql(connection.prepare(
        "SELECT id, item_id, name, status, status_text, headers, body, rank, raw
           FROM examples
          WHERE item_id = ?1 AND deleted_at IS NULL
          ORDER BY rank, name",
    ))?;
    let rows = sql(statement.query_map([item_id], read_example))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn save_example(
    connection: &Connection,
    item_id: &str,
    rank: &str,
    example: &NewExample,
) -> StoreResult<String> {
    let id = new_id();
    let device = device_id(connection)?;
    sql(connection.execute(
        "INSERT INTO examples (id, item_id, name, status, status_text, headers, body, rank,
                               raw, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            item_id,
            example.name,
            example.status,
            example.status_text,
            example.headers.as_ref().map(Value::to_string),
            example.body,
            rank,
            example.raw.as_ref().map(Value::to_string),
            now_ms(),
            device,
        ],
    ))?;
    Ok(id)
}

pub fn rename_example(connection: &Connection, id: &str, name: &str) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE examples SET name = ?2, updated_at = ?3, rev = rev + 1 WHERE id = ?1",
        params![id, name, now_ms()],
    ))?;
    Ok(())
}

pub fn delete_example(connection: &Connection, id: &str) -> StoreResult<()> {
    sql(connection.execute(
        "UPDATE examples SET deleted_at = ?2, rev = rev + 1 WHERE id = ?1",
        params![id, now_ms()],
    ))?;
    Ok(())
}

// ─── Environments ────────────────────────────────────────────────────────────

pub fn environments(connection: &Connection, workspace: &str) -> StoreResult<Vec<Environment>> {
    let mut statement = sql(connection.prepare(
        "SELECT id, name, is_global, updated_at, raw, conflicted_at
           FROM environments
          WHERE workspace_id = ?1 AND deleted_at IS NULL
          ORDER BY is_global DESC, rank, name",
    ))?;

    let rows = sql(statement.query_map([workspace], |row| {
        Ok(Environment {
            id: row.get(0)?,
            name: row.get(1)?,
            is_global: row.get::<_, i64>(2)? != 0,
            updated_at: row.get(3)?,
            conflicted_at: row.get(5)?,
            raw: row.get::<_, Option<String>>(4)?.and_then(parse_json),
            variables: Vec::new(),
        })
    }))?;

    let mut environments = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    for environment in &mut environments {
        environment.variables = variables_of(connection, &environment.id)?;
    }
    Ok(environments)
}

fn variables_of(connection: &Connection, scope_id: &str) -> StoreResult<Vec<Variable>> {
    let mut statement = sql(connection.prepare(
        "SELECT id, key, value, enabled, secret, current_value FROM variables
          WHERE scope_id = ?1 AND deleted_at IS NULL
          ORDER BY position",
    ))?;
    let rows = sql(statement.query_map([scope_id], |row| {
        Ok(Variable {
            id: row.get(0)?,
            key: row.get(1)?,
            value: row.get(2)?,
            enabled: row.get::<_, i64>(3)? != 0,
            secret: row.get::<_, i64>(4)? != 0,
            current_value: row.get(5)?,
        })
    }))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Writes a scope's variables, keeping the identity of every row that survives.
///
/// **Wholesale replacement is the right meaning; `DELETE` was the wrong
/// mechanism for it.** The editor holds the entire list, so a save is the whole
/// truth and merging would resurrect a row somebody had just removed — that
/// part was never in doubt. What went wrong is that both writers expressed it
/// as `DELETE FROM variables WHERE scope_id = ?` followed by an `INSERT` with a
/// fresh `new_id()` for every row, and this table syncs.
///
/// Two consequences, and they compound:
///
/// 1. **A hard delete leaves no tombstone.** The outbox is trigger-driven, and
///    the triggers fire on `INSERT` and `UPDATE` only — there is no `DELETE`
///    trigger, because the rule everywhere else in this file is that nothing is
///    deleted while sync might still care. So the rows simply vanished, and the
///    remote was never told.
/// 2. **Fresh ids make every row look new.** Sync copies rows by `id`, so the
///    same key came back as a second row rather than as an update to the first.
///
/// Together: one save pushed a new set of rows to Postgres while the old set
/// stayed there unmentioned, and the next device to pull got both. `variables`
/// is keyed on `id` alone, so nothing at the database level stopped it.
///
/// So: update in place when the key is still there, insert only genuinely new
/// keys, and tombstone what the save dropped. A key that is *already*
/// duplicated keeps its newest row and tombstones the rest, which is what heals
/// an affected database — the tombstones push, and the other devices converge.
fn write_variables(
    transaction: &Connection,
    scope: &str,
    scope_id: &str,
    variables: &[super::model::ImportVariable],
    device: &str,
    now: i64,
) -> StoreResult<()> {
    // Oldest first, so the last row to claim a key is the newest one — which is
    // the one worth keeping when a key has been duplicated already.
    let live: Vec<(String, String)> = {
        let mut statement = sql(transaction.prepare(
            "SELECT id, key FROM variables
              WHERE scope_id = ?1 AND deleted_at IS NULL
              ORDER BY updated_at ASC, rowid ASC",
        ))?;
        let rows = sql(statement.query_map([scope_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }))?;
        sql(rows.collect::<rusqlite::Result<Vec<_>>>())?
    };

    let mut by_key: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // Rows displaced by a later one with the same key: duplicates that were
    // already in the database before this ran.
    let mut duplicates: Vec<String> = Vec::new();
    for (row_id, key) in live {
        if let Some(displaced) = by_key.insert(key, row_id) {
            duplicates.push(displaced);
        }
    }

    for (position, variable) in variables.iter().enumerate() {
        match by_key.remove(&variable.key) {
            // The row keeps its id, so the remote sees an edit rather than a
            // stranger with a familiar name.
            Some(row_id) => {
                sql(transaction.execute(
                    "UPDATE variables
                        SET scope = ?2, value = ?3, enabled = ?4, secret = ?5, position = ?6,
                            updated_at = ?7, device_id = ?8, current_value = ?9, rev = rev + 1
                      WHERE id = ?1",
                    params![
                        row_id,
                        scope,
                        variable.value,
                        variable.enabled as i64,
                        variable.secret as i64,
                        position as i64,
                        now,
                        device,
                        variable.current_value,
                    ],
                ))?;
            }
            None => {
                sql(transaction.execute(
                    "INSERT INTO variables (id, scope, scope_id, key, value, enabled, secret,
                                            position, updated_at, device_id, current_value)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        new_id(),
                        scope,
                        scope_id,
                        variable.key,
                        variable.value,
                        variable.enabled as i64,
                        variable.secret as i64,
                        position as i64,
                        now,
                        device,
                        variable.current_value,
                    ],
                ))?;
            }
        }
    }

    // What the save dropped, and any duplicate it inherited. Tombstoned rather
    // than deleted, which is the whole point: a row that vanishes is a row the
    // other side never hears about.
    for row_id in by_key.into_values().chain(duplicates) {
        sql(transaction.execute(
            "UPDATE variables SET deleted_at = ?2, rev = rev + 1 WHERE id = ?1",
            params![row_id, now],
        ))?;
    }

    Ok(())
}

/// Stores an imported environment. Replaces one of the same name rather than
/// stacking duplicates, because importing the same file twice is something
/// people do while they are moving over and it should be idempotent.
pub fn import_environment(
    connection: &Connection,
    workspace: &str,
    payload: &ImportEnvironment,
) -> StoreResult<String> {
    let transaction = sql(connection.unchecked_transaction())?;
    let device = device_id(&transaction)?;
    let now = now_ms();

    let existing: Option<String> = sql(transaction
        .query_row(
            "SELECT id FROM environments
              WHERE workspace_id = ?1 AND deleted_at IS NULL
                AND (name = ?2 OR (is_global = 1 AND ?3 = 1))",
            params![workspace, payload.name, payload.is_global as i64],
            |row| row.get(0),
        )
        .optional())?;

    let id = match existing {
        Some(id) => {
            sql(transaction.execute(
                "UPDATE environments SET name = ?2, raw = ?3, updated_at = ?4, rev = rev + 1
                  WHERE id = ?1",
                params![
                    id,
                    payload.name,
                    payload.raw.as_ref().map(Value::to_string),
                    now
                ],
            ))?;
            id
        }
        None => {
            let id = new_id();
            sql(transaction.execute(
                "INSERT INTO environments (id, workspace_id, name, is_global, raw, updated_at,
                                           device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    workspace,
                    payload.name,
                    payload.is_global as i64,
                    payload.raw.as_ref().map(Value::to_string),
                    now,
                    device
                ],
            ))?;
            id
        }
    };

    let scope = if payload.is_global {
        "global"
    } else {
        "environment"
    };
    // A re-import is the file's contents, not a merge with what was there
    // before — but the rows that survive it keep their identity. See
    // `write_variables`.
    write_variables(&transaction, scope, &id, &payload.variables, &device, now)?;

    sql(transaction.commit())?;
    Ok(id)
}

/// Creates or updates one environment and its variables.
///
/// The variables are replaced wholesale rather than merged: the editor holds
/// the whole list, and a merge would resurrect a row somebody had just deleted.
/// How that replacement is written down matters to sync, and `write_variables`
/// is where it is explained.
pub fn save_environment(
    connection: &Connection,
    workspace: &str,
    id: Option<&str>,
    name: &str,
    is_global: bool,
    variables: &[super::model::ImportVariable],
) -> StoreResult<String> {
    let transaction = sql(connection.unchecked_transaction())?;
    let device = device_id(&transaction)?;
    let now = now_ms();

    let id = match id {
        Some(id) => {
            sql(transaction.execute(
                "UPDATE environments SET name = ?2, updated_at = ?3, rev = rev + 1 WHERE id = ?1",
                params![id, name, now],
            ))?;
            id.to_string()
        }
        None => {
            let id = new_id();
            sql(transaction.execute(
                "INSERT INTO environments (id, workspace_id, name, is_global, rank, updated_at,
                                           device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, workspace, name, is_global as i64, "V", now, device],
            ))?;
            id
        }
    };

    let scope = if is_global { "global" } else { "environment" };
    write_variables(&transaction, scope, &id, variables, &device, now)?;

    sql(transaction.commit())?;
    Ok(id)
}

pub fn delete_environment(connection: &Connection, id: &str) -> StoreResult<()> {
    let transaction = sql(connection.unchecked_transaction())?;
    let now = now_ms();
    sql(transaction.execute(
        "UPDATE variables SET deleted_at = ?2, rev = rev + 1
          WHERE scope_id = ?1 AND deleted_at IS NULL",
        params![id, now],
    ))?;
    sql(transaction.execute(
        "UPDATE environments SET deleted_at = ?2, rev = rev + 1 WHERE id = ?1",
        params![id, now],
    ))?;
    sql(transaction.commit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::model::{ImportCollection, ImportEnvironment};
    use crate::store::schema;
    use serde_json::json;

    /// A database with a workspace, one collection, and a folder holding a
    /// request — the smallest tree that can go wrong.
    fn fixture() -> (Connection, String, String, String) {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        schema::migrate(&connection).unwrap();

        let workspace = workspace_id(&connection).unwrap();
        let collection = create_collection(&connection, &workspace, "API", "V").unwrap();
        let folder = create_item(
            &connection,
            &collection.id,
            None,
            ItemKind::Folder,
            "Users",
            "V",
        )
        .unwrap();
        let request = create_item(
            &connection,
            &collection.id,
            Some(&folder.id),
            ItemKind::Request,
            "List users",
            "V",
        )
        .unwrap();

        (connection, collection.id, folder.id, request.id)
    }

    // ─── Workspaces ──────────────────────────────────────────────────────────
    /// A session is a list of open tabs, and a tab is a request in a
    /// collection that belongs to one workspace. One shared session would come
    /// back full of tabs the open workspace cannot see.
    #[test]
    fn each_workspace_keeps_its_own_open_tabs() {
        let (connection, _, _, _) = fixture();
        let first = workspace_id(&connection).unwrap();
        let second = create_workspace(&connection, "Work").unwrap();

        set_meta(&connection, &session_key(&first), r#"{"tabs":["a"]}"#).unwrap();
        set_meta(&connection, &session_key(&second), r#"{"tabs":["b"]}"#).unwrap();

        assert_eq!(snapshot(&connection).unwrap().session.unwrap()["tabs"][0], "a");
        set_active_workspace(&connection, &second).unwrap();
        assert_eq!(snapshot(&connection).unwrap().session.unwrap()["tabs"][0], "b");
    }

    /// What installations before workspaces wrote. Read as a fallback, so the
    /// first open after this change still finds the tabs that were there.
    #[test]
    fn a_session_written_before_workspaces_is_still_found() {
        let (connection, _, _, _) = fixture();
        set_meta(&connection, "session", r#"{"tabs":["old"]}"#).unwrap();
        assert_eq!(snapshot(&connection).unwrap().session.unwrap()["tabs"][0], "old");
    }


    /// Which one is open is a fact about this machine. It lives in `meta`,
    /// which does not sync — a column would switch the desktop's workspace
    /// halfway through somebody else's afternoon.
    #[test]
    fn the_open_workspace_is_remembered() {
        let (connection, _, _, _) = fixture();
        let first = workspace_id(&connection).unwrap();
        let second = create_workspace(&connection, "Work").unwrap();

        assert_eq!(workspace_id(&connection).unwrap(), first, "making one does not open it");

        set_active_workspace(&connection, &second).unwrap();
        assert_eq!(workspace_id(&connection).unwrap(), second);
    }

    /// The deletion may have arrived from another machine, and the id stored
    /// here would then resolve to nothing. Falling back beats failing: there
    /// is always somewhere to be.
    #[test]
    fn a_workspace_that_vanished_falls_back_to_the_oldest() {
        let (connection, _, _, _) = fixture();
        let first = workspace_id(&connection).unwrap();
        let second = create_workspace(&connection, "Work").unwrap();
        set_active_workspace(&connection, &second).unwrap();

        delete_workspace(&connection, &second).unwrap();
        assert_eq!(workspace_id(&connection).unwrap(), first);
    }

    #[test]
    fn switching_to_one_that_is_not_there_is_refused_rather_than_stored() {
        let (connection, _, _, _) = fixture();
        let before = workspace_id(&connection).unwrap();
        assert!(set_active_workspace(&connection, "nonsense").is_err());
        assert_eq!(workspace_id(&connection).unwrap(), before);
    }

    /// A window with no workspace has nowhere to put the collection somebody
    /// makes next, and "it made you a new one" is a worse answer than "no".
    #[test]
    fn the_last_workspace_cannot_be_deleted() {
        let (connection, _, _, _) = fixture();
        let only = workspace_id(&connection).unwrap();
        assert!(delete_workspace(&connection, &only).is_err());
        assert_eq!(workspaces(&connection).unwrap().len(), 1);
    }

    /// Everything inside goes with it. Leaving the collections would leave
    /// rows no query will ever return, and a sync would carry them to the next
    /// machine as live data.
    #[test]
    fn deleting_a_workspace_takes_its_collections_and_environments() {
        let (connection, _, _, _) = fixture();
        let second = create_workspace(&connection, "Work").unwrap();
        let collection = create_collection(&connection, &second, "Theirs", "V").unwrap();
        save_environment(&connection, &second, None, "Staging", false, &[]).unwrap();

        delete_workspace(&connection, &second).unwrap();

        assert!(collections(&connection, &second).unwrap().is_empty());
        assert!(environments(&connection, &second).unwrap().is_empty());
        let deleted: Option<i64> = connection
            .query_row(
                "SELECT deleted_at FROM collections WHERE id = ?1",
                [&collection.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deleted.is_some(), "soft, so a sync carries the deletion");
    }

    /// The wall is the point: one workspace's tree must not appear in another.
    #[test]
    fn a_snapshot_shows_only_the_open_workspace() {
        let (connection, first_collection, _, _) = fixture();
        let second = create_workspace(&connection, "Work").unwrap();
        create_collection(&connection, &second, "Theirs", "V").unwrap();

        let here = snapshot(&connection).unwrap();
        assert_eq!(here.collections.len(), 1);
        assert_eq!(here.collections[0].id, first_collection);
        assert_eq!(here.workspaces.len(), 2, "both are listed, so the picker can draw");

        set_active_workspace(&connection, &second).unwrap();
        let there = snapshot(&connection).unwrap();
        assert_eq!(there.collections.len(), 1);
        assert_eq!(there.collections[0].name, "Theirs");
        assert!(there.items.is_empty(), "the other workspace's items stay there");
    }

    #[test]
    fn workspaces_come_back_oldest_first() {
        let (connection, _, _, _) = fixture();
        create_workspace(&connection, "Work").unwrap();
        create_workspace(&connection, "Scratch").unwrap();
        let names: Vec<String> = workspaces(&connection)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["Personal", "Work", "Scratch"]);
    }

    #[test]
    fn renaming_a_workspace_bumps_its_revision() {
        let (connection, _, _, _) = fixture();
        let id = workspace_id(&connection).unwrap();
        let before: i64 = connection
            .query_row("SELECT rev FROM workspaces WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
            .unwrap();

        rename_workspace(&connection, &id, "  Personal things  ").unwrap();

        let (name, after): (String, i64) = connection
            .query_row(
                "SELECT name, rev FROM workspaces WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Personal things", "trimmed");
        assert_eq!(after, before + 1);
    }

    /// Everything the folder tab writes, in one call — and the revision bumped
    /// once for it, because the row is queued for syncing per bump and a save
    /// that queued it four times would push the same folder four times.
    #[test]
    fn a_folder_keeps_what_the_tab_saved() {
        let (connection, _, folder, _) = fixture();
        let before: i64 = connection
            .query_row("SELECT rev FROM items WHERE id = ?1", [&folder], |row| {
                row.get(0)
            })
            .unwrap();

        save_item_scope(
            &connection,
            &folder,
            "People",
            "Everything under /users.",
            Some(&json!({ "type": "bearer", "bearer": [{ "key": "token", "value": "t" }] })),
            Some(&json!([{ "key": "page_size", "value": "25" }])),
            Some(&json!([{ "listen": "test", "script": { "exec": ["ok"] } }])),
        )
        .unwrap();

        let workspace = workspace_id(&connection).unwrap();
        let row = items(&connection, &workspace)
            .unwrap()
            .into_iter()
            .find(|item| item.id == folder)
            .unwrap();

        assert_eq!(row.name, "People");
        assert_eq!(row.description, "Everything under /users.");
        assert_eq!(row.auth.unwrap()["type"], "bearer");
        assert_eq!(row.variables.unwrap()[0]["key"], "page_size");
        assert_eq!(row.events.unwrap()[0]["listen"], "test");

        let after: i64 = connection
            .query_row("SELECT rev FROM items WHERE id = ?1", [&folder], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(after, before + 1, "one save, one revision");
    }

    /// A description is what the folder tab is for, and an export that dropped
    /// it would lose it silently.
    #[test]
    fn a_folder_description_reaches_the_export() {
        let (connection, collection, folder, _) = fixture();
        save_item_scope(&connection, &folder, "Users", "Read this first.", None, None, None)
            .unwrap();

        let bundle = export_collection(&connection, &collection).unwrap();
        let exported = bundle
            .items
            .iter()
            .find(|item| item.id == folder)
            .expect("the folder is in the export");
        assert_eq!(exported.description, "Read this first.");
    }

    /// A duplicate that reported empty columns would draw as a copy emptier
    /// than the row it came from until something forced a reload.
    #[test]
    fn a_duplicated_folder_reports_what_was_copied() {
        let (connection, _, folder, _) = fixture();
        save_item_scope(
            &connection,
            &folder,
            "Users",
            "Everything under /users.",
            None,
            Some(&json!([{ "key": "page_size", "value": "25" }])),
            None,
        )
        .unwrap();

        let made = duplicate_item(&connection, &folder, "Users copy", "W").unwrap();
        let copy = made.first().expect("the folder itself comes back first");
        assert_eq!(copy.description, "Everything under /users.");
        assert_eq!(copy.variables.as_ref().unwrap()[0]["key"], "page_size");
    }

    /// The rail needs every example at once and none of their bodies. A
    /// deleted request's examples must not come with them: the row they would
    /// hang under is gone, so they would have nowhere to be drawn.
    #[test]
    fn the_example_index_skips_bodies_and_deleted_rows() {
        let (connection, collection, folder, request) = fixture();
        let second = create_item(
            &connection,
            &collection,
            Some(&folder),
            ItemKind::Request,
            "Get user",
            "W",
        )
        .unwrap();

        for (item, name, status) in [
            (&request, "200 OK", 200),
            (&request, "422 invalid", 422),
            (&second.id, "404", 404),
        ] {
            save_example(
                &connection,
                item,
                "V",
                &NewExample {
                    name: name.into(),
                    status: Some(status),
                    status_text: None,
                    headers: None,
                    body: Some("x".repeat(5000)),
                    raw: None,
                },
            )
            .unwrap();
        }

        let workspace = workspace_id(&connection).unwrap();
        assert_eq!(example_index(&connection, &workspace).unwrap().len(), 3);

        delete_item(&connection, &second.id).unwrap();
        let index = example_index(&connection, &workspace).unwrap();
        assert_eq!(index.len(), 2, "the deleted request's example is gone too");
        assert!(index.iter().all(|row| row.item_id == request));
        assert!(index.iter().any(|row| row.status == Some(422)));
    }

    /// The initial value is shared; the current one is this machine's. The
    /// second half of that promise is kept by `current_value` being absent
    /// from the sync table's column list, which is asserted here rather than
    /// left to whoever next edits that list.
    #[test]
    fn a_current_value_is_kept_but_never_synced() {
        let connection = Connection::open_in_memory().unwrap();
        schema::migrate(&connection).unwrap();
        let workspace = workspace_id(&connection).unwrap();

        let id = save_environment(
            &connection,
            &workspace,
            None,
            "Staging",
            false,
            &[super::super::model::ImportVariable {
                key: "token".into(),
                value: "put-yours-here".into(),
                enabled: true,
                secret: true,
                current_value: Some("the-real-one".into()),
            }],
        )
        .unwrap();

        let variables = variables_of(&connection, &id).unwrap();
        assert_eq!(variables[0].value, "put-yours-here");
        assert_eq!(variables[0].current_value.as_deref(), Some("the-real-one"));

        let synced = crate::sync::table("variables").expect("variables is a synced table");
        assert!(
            !synced.columns.contains(&"current_value"),
            "a current value must never leave this machine"
        );
    }

    #[test]
    fn a_new_request_gets_a_row_to_open() {
        let (connection, _, _, request) = fixture();
        let saved = load_request(&connection, &request).unwrap().unwrap();
        assert_eq!(saved.method, "GET");
        assert_eq!(saved.url, "");
    }

    #[test]
    fn saving_a_request_twice_updates_rather_than_duplicates() {
        let (connection, _, _, request) = fixture();
        save_request(
            &connection,
            &request,
            "POST",
            "https://example.com",
            &json!([{ "name": "Accept", "value": "*/*" }]),
            &json!({ "mode": "raw", "text": "{}" }),
            None,
        )
        .unwrap();
        save_request(
            &connection,
            &request,
            "PUT",
            "https://example.com/2",
            &json!([]),
            &json!({ "mode": "none" }),
            None,
        )
        .unwrap();

        let saved = load_request(&connection, &request).unwrap().unwrap();
        assert_eq!(saved.method, "PUT");
        assert_eq!(saved.url, "https://example.com/2");

        let rev: i64 = connection
            .query_row(
                "SELECT rev FROM requests WHERE item_id = ?1",
                [&request],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rev, 3, "one insert and two updates");
    }

    /// The failure this guards against is a request left alive under a folder
    /// that is gone: invisible in the rail, and still pushed to a remote.
    #[test]
    fn deleting_a_folder_tombstones_everything_under_it() {
        let (connection, collection, folder, request) = fixture();
        delete_item(&connection, &folder).unwrap();

        let workspace = workspace_id(&connection).unwrap();
        assert!(items(&connection, &workspace).unwrap().is_empty());
        assert!(load_request(&connection, &request).unwrap().is_none());

        // Tombstoned, not gone — sync has to be able to see the deletion.
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 2);
        let orphans: i64 = connection
            .query_row(
                "SELECT count(*) FROM items WHERE collection_id = ?1 AND deleted_at IS NULL",
                [&collection],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn deleting_a_collection_takes_its_tree_with_it() {
        let (connection, collection, _, request) = fixture();
        delete_collection(&connection, &collection).unwrap();

        let workspace = workspace_id(&connection).unwrap();
        assert!(collections(&connection, &workspace).unwrap().is_empty());
        assert!(items(&connection, &workspace).unwrap().is_empty());
        assert!(load_request(&connection, &request).unwrap().is_none());
    }

    /// Dragging a folder into another collection has to take its children's
    /// `collection_id` with it, or they vanish from both trees.
    #[test]
    fn moving_a_folder_moves_its_subtree_into_the_new_collection() {
        let (connection, _, folder, request) = fixture();
        let workspace = workspace_id(&connection).unwrap();
        let other = create_collection(&connection, &workspace, "Other", "W").unwrap();

        move_item(&connection, &folder, &other.id, None, "V").unwrap();

        let moved: String = connection
            .query_row(
                "SELECT collection_id FROM items WHERE id = ?1",
                [&request],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(moved, other.id);
    }

    #[test]
    fn duplicating_a_folder_copies_its_children_under_new_ids() {
        let (connection, _, folder, request) = fixture();
        save_request(
            &connection,
            &request,
            "POST",
            "https://example.com",
            &json!([]),
            &json!({ "mode": "raw", "text": "hello" }),
            None,
        )
        .unwrap();

        let made = duplicate_item(&connection, &folder, "Users copy", "W").unwrap();
        assert_eq!(made.len(), 2, "the folder and its request");

        let copy_of_folder = &made[0];
        let copy_of_request = &made[1];
        assert_ne!(copy_of_folder.id, folder);
        assert_ne!(copy_of_request.id, request);
        assert_eq!(
            copy_of_request.parent_id.as_deref(),
            Some(copy_of_folder.id.as_str())
        );
        assert_eq!(copy_of_folder.name, "Users copy");
        // The child keeps its own name; only the top of the copy is renamed.
        assert_eq!(copy_of_request.name, "List users");

        let copied = load_request(&connection, &copy_of_request.id)
            .unwrap()
            .unwrap();
        assert_eq!(copied.method, "POST");
        assert_eq!(copied.body["text"], "hello");
    }

    #[test]
    fn history_keeps_the_newest_and_hands_back_the_files_to_delete() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        // One more than the cap, each with a body file to account for.
        for index in 0..(HISTORY_LIMIT + 1) {
            let id = format!("h{index:04}");
            connection
                .execute(
                    "INSERT INTO history (id, workspace_id, sent_at, method, url, request, body_path)
                     VALUES (?1, ?2, ?3, 'GET', 'https://example.com', '{}', ?4)",
                    params![id, workspace, index as i64, format!("/bodies/{id}")],
                )
                .unwrap();
        }

        let orphans = prune_history(&connection, &workspace).unwrap();
        assert_eq!(orphans, vec!["/bodies/h0000".to_string()]);

        let left: i64 = connection
            .query_row("SELECT count(*) FROM history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left as usize, HISTORY_LIMIT);
    }

    #[test]
    fn clearing_history_returns_every_body_file() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();
        let entry = NewHistory {
            item_id: None,
            method: "GET".into(),
            url: "https://example.com".into(),
            status: Some(200),
            duration_ms: Some(12),
            size_bytes: Some(34),
            error: None,
            request: json!({ "method": "GET" }),
            response: Some(json!({ "status": 200 })),
        };
        add_history(&connection, &workspace, "h1", &entry, Some("/bodies/h1")).unwrap();

        let listed = list_history(&connection, &workspace, 10).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].has_body);
        assert_eq!(listed[0].status, Some(200));

        let paths = clear_history(&connection, &workspace).unwrap();
        assert_eq!(paths, vec!["/bodies/h1".to_string()]);
        assert!(list_history(&connection, &workspace, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn an_imported_tree_arrives_whole_with_its_original_document() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        let payload: ImportCollection = serde_json::from_value(json!({
            "name": "Imported",
            "description": "From a file",
            "rank": "W",
            "raw": { "info": { "name": "Imported" }, "unknownKey": 1 },
            "items": [
                { "kind": "folder", "name": "Users", "rank": "A", "parent": null },
                {
                    "kind": "request",
                    "name": "List",
                    "rank": "A",
                    "parent": 0,
                    "raw": { "name": "List", "event": [{ "listen": "test" }] },
                    "request": {
                        "method": "GET",
                        "url": "https://example.com/users",
                        "headers": [{ "name": "Accept", "value": "*/*", "enabled": true }],
                        "body": { "mode": "none" }
                    }
                }
            ]
        }))
        .unwrap();

        let id = import_collection(&connection, &workspace, &payload).unwrap();
        let bundle = export_collection(&connection, &id).unwrap();

        assert_eq!(bundle.name, "Imported");
        assert_eq!(bundle.raw.unwrap()["unknownKey"], 1);
        assert_eq!(bundle.items.len(), 2);

        // Found by name, not position: the rows come back in rank order, and
        // it is the exporter that groups them under their parents.
        let folder = bundle.items.iter().find(|i| i.name == "Users").unwrap();
        let request = bundle.items.iter().find(|i| i.name == "List").unwrap();
        assert_eq!(folder.kind, ItemKind::Folder);
        assert_eq!(request.parent_id.as_deref(), Some(folder.id.as_str()));
        // The part that makes a round trip lossless: the entry's own document
        // came back, script and all.
        assert_eq!(request.raw.as_ref().unwrap()["event"][0]["listen"], "test");
        assert_eq!(request.request.as_ref().unwrap().method, "GET");
    }

    /// A parent named after its own child would be a tree that cannot be built.
    /// Refusing beats inserting half of it.
    #[test]
    fn an_import_that_names_a_parent_out_of_order_is_refused() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();
        let payload: ImportCollection = serde_json::from_value(json!({
            "name": "Broken",
            "rank": "W",
            "items": [{ "kind": "request", "name": "Child", "rank": "A", "parent": 4 }]
        }))
        .unwrap();

        assert!(import_collection(&connection, &workspace, &payload).is_err());
        // And nothing of it was left behind.
        assert_eq!(collections(&connection, &workspace).unwrap().len(), 1);
    }

    #[test]
    fn a_saved_response_comes_back_with_the_collection_it_belongs_to() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        let payload: ImportCollection = serde_json::from_value(json!({
            "name": "With examples",
            "rank": "W",
            "items": [{
                "kind": "request",
                "name": "List",
                "rank": "A",
                "parent": null,
                "request": {
                    "method": "GET",
                    "url": "https://example.com/users",
                    "headers": [],
                    "body": { "mode": "none" }
                },
                "examples": [
                    {
                        "name": "200 OK",
                        "status": 200,
                        "statusText": "OK",
                        "headers": [{ "name": "Content-Type", "value": "application/json" }],
                        "body": "{\"users\":[]}",
                        "raw": { "name": "200 OK", "_unknown": 1 }
                    },
                    {
                        "name": "422",
                        "status": 422,
                        "statusText": "Unprocessable",
                        "headers": null,
                        "body": null
                    }
                ]
            }]
        }))
        .unwrap();

        let id = import_collection(&connection, &workspace, &payload).unwrap();
        let bundle = export_collection(&connection, &id).unwrap();

        let request = &bundle.items[0];
        assert_eq!(request.examples.len(), 2);
        // In the document's order, which the import numbers rather than ranks:
        // one writer, all at once.
        assert_eq!(request.examples[0].name, "200 OK");
        assert_eq!(request.examples[0].status, Some(200));
        assert_eq!(request.examples[0].body.as_deref(), Some(r#"{"users":[]}"#));
        // And whatever the entry carried that this model has no column for.
        assert_eq!(request.examples[0].raw.as_ref().unwrap()["_unknown"], 1);
        assert_eq!(request.examples[1].name, "422");
    }

    #[test]
    fn an_example_can_be_kept_renamed_and_dropped() {
        let (connection, _, _, request) = fixture();

        let id = save_example(
            &connection,
            &request,
            "V",
            &super::super::model::NewExample {
                name: "200 OK".into(),
                status: Some(200),
                status_text: Some("OK".into()),
                headers: None,
                body: Some("{}".into()),
                raw: None,
            },
        )
        .unwrap();

        assert_eq!(examples(&connection, &request).unwrap().len(), 1);

        rename_example(&connection, &id, "Empty list").unwrap();
        assert_eq!(
            examples(&connection, &request).unwrap()[0].name,
            "Empty list"
        );

        delete_example(&connection, &id).unwrap();
        assert!(examples(&connection, &request).unwrap().is_empty());
    }

    /// Deleting a request takes its examples out of the tree with it — they
    /// hang off the row, and an example under a request that is gone would be
    /// exported against nothing.
    #[test]
    fn deleting_a_request_leaves_no_examples_in_an_export() {
        let (connection, collection, _, request) = fixture();
        save_example(
            &connection,
            &request,
            "V",
            &super::super::model::NewExample {
                name: "200 OK".into(),
                status: Some(200),
                status_text: None,
                headers: None,
                body: None,
                raw: None,
            },
        )
        .unwrap();

        delete_item(&connection, &request).unwrap();
        let bundle = export_collection(&connection, &collection).unwrap();
        assert!(bundle.items.iter().all(|item| item.examples.is_empty()));
    }

    #[test]
    fn importing_the_same_environment_twice_replaces_it() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        let first: ImportEnvironment = serde_json::from_value(json!({
            "name": "Staging",
            "variables": [
                { "key": "base_url", "value": "https://staging.example.com" },
                { "key": "token", "value": "abc", "secret": true, "enabled": false }
            ]
        }))
        .unwrap();
        import_environment(&connection, &workspace, &first).unwrap();

        let again: ImportEnvironment = serde_json::from_value(json!({
            "name": "Staging",
            "variables": [{ "key": "base_url", "value": "https://new.example.com" }]
        }))
        .unwrap();
        import_environment(&connection, &workspace, &again).unwrap();

        let found = environments(&connection, &workspace).unwrap();
        assert_eq!(found.len(), 1, "a re-import replaces rather than stacks");
        assert_eq!(found[0].variables.len(), 1);
        assert_eq!(found[0].variables[0].value, "https://new.example.com");
    }

    #[test]
    fn an_environment_keeps_what_each_variable_was_marked_as() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();
        let payload: ImportEnvironment = serde_json::from_value(json!({
            "name": "Staging",
            "variables": [
                { "key": "a", "value": "1" },
                { "key": "token", "value": "abc", "secret": true, "enabled": false }
            ]
        }))
        .unwrap();
        let id = import_environment(&connection, &workspace, &payload).unwrap();

        let found = environments(&connection, &workspace).unwrap();
        let variables = &found[0].variables;
        assert_eq!(variables[0].key, "a");
        assert!(variables[0].enabled);
        assert!(!variables[0].secret);
        assert!(!variables[1].enabled);
        assert!(variables[1].secret);

        delete_environment(&connection, &id).unwrap();
        assert!(environments(&connection, &workspace).unwrap().is_empty());
    }

    #[test]
    fn an_environment_can_be_made_and_then_edited() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        let made = save_environment(
            &connection,
            &workspace,
            None,
            "Staging",
            false,
            &[super::super::model::ImportVariable {
                key: "base_url".into(),
                value: "https://staging.example.com".into(),
                enabled: true,
                secret: false,
                current_value: None,
            }],
        )
        .unwrap();

        save_environment(
            &connection,
            &workspace,
            Some(&made),
            "Staging (EU)",
            false,
            &[
                super::super::model::ImportVariable {
                    key: "base_url".into(),
                    value: "https://eu.example.com".into(),
                    enabled: true,
                    secret: false,
                    current_value: None,
                },
                super::super::model::ImportVariable {
                    key: "token".into(),
                    value: "abc".into(),
                    enabled: false,
                    secret: true,
                    current_value: None,
                },
            ],
        )
        .unwrap();

        let found = environments(&connection, &workspace).unwrap();
        assert_eq!(found.len(), 1, "editing must not make a second one");
        assert_eq!(found[0].name, "Staging (EU)");
        assert_eq!(found[0].variables.len(), 2);
        assert_eq!(found[0].variables[0].value, "https://eu.example.com");
        assert!(found[0].variables[1].secret);
    }

    /// Clearing an auth block is not the same as setting one to "none": the
    /// first inherits from the folder above, the second sends nothing.
    #[test]
    fn clearing_an_auth_block_is_stored_as_nothing() {
        let (connection, _, _, request) = fixture();

        save_item_auth(&connection, &request, Some(&json!({ "type": "noauth" }))).unwrap();
        let workspace = workspace_id(&connection).unwrap();
        let stored = items(&connection, &workspace)
            .unwrap()
            .into_iter()
            .find(|item| item.id == request)
            .unwrap();
        assert_eq!(stored.auth.unwrap()["type"], "noauth");

        save_item_auth(&connection, &request, None).unwrap();
        let cleared = items(&connection, &workspace)
            .unwrap()
            .into_iter()
            .find(|item| item.id == request)
            .unwrap();
        assert!(cleared.auth.is_none());
    }

    #[test]
    fn a_collection_keeps_its_own_scope() {
        let (connection, collection, _, _) = fixture();
        save_collection_scope(
            &connection,
            &collection,
            Some(&json!({ "type": "bearer" })),
            Some(&json!([{ "key": "base_url", "value": "https://example.com" }])),
        )
        .unwrap();

        let workspace = workspace_id(&connection).unwrap();
        let stored = &collections(&connection, &workspace).unwrap()[0];
        assert_eq!(stored.auth.as_ref().unwrap()["type"], "bearer");
        assert_eq!(stored.variables.as_ref().unwrap()[0]["key"], "base_url");
    }

    #[test]
    fn request_settings_are_kept_with_the_request() {
        let (connection, _, _, request) = fixture();
        save_request(
            &connection,
            &request,
            "GET",
            "https://example.com",
            &json!([]),
            &json!({ "mode": "none" }),
            Some(&json!({ "followRedirects": false, "timeoutMs": 5000 })),
        )
        .unwrap();

        let saved = load_request(&connection, &request).unwrap().unwrap();
        assert_eq!(saved.settings.unwrap()["timeoutMs"], 5000);
    }

    // ─── The outbox ─────────────────────────────────────────────────────────

    fn pending(connection: &Connection) -> Vec<(String, String)> {
        let mut statement = connection
            .prepare("SELECT table_name, row_id FROM outbox ORDER BY table_name, row_id")
            .unwrap();
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    /// The whole point of doing this with triggers: no writer has to remember.
    #[test]
    fn every_write_enqueues_itself_without_being_asked() {
        let (connection, collection, folder, request) = fixture();

        let queued = pending(&connection);
        assert!(queued.contains(&("collections".into(), collection.clone())));
        assert!(queued.contains(&("items".into(), folder)));
        assert!(queued.contains(&("items".into(), request.clone())));
        assert!(queued.contains(&("requests".into(), request)));
        assert!(queued.iter().any(|(table, _)| table == "workspaces"));
    }

    /// Sync copies rows, not operations, so a second edit before a push adds
    /// nothing to do — it only moves when it was queued.
    #[test]
    fn a_second_edit_does_not_queue_a_second_time() {
        let (connection, collection, _, _) = fixture();
        connection.execute("DELETE FROM outbox", []).unwrap();

        rename_collection(&connection, &collection, "One").unwrap();
        rename_collection(&connection, &collection, "Two").unwrap();

        assert_eq!(
            pending(&connection),
            vec![("collections".into(), collection)]
        );
    }

    /// Applying what a pull brought back is itself a write. Without the flag
    /// the merge would queue every remote row straight back for pushing.
    #[test]
    fn applying_remote_changes_does_not_queue_them_again() {
        let (connection, collection, _, _) = fixture();
        connection.execute("DELETE FROM outbox", []).unwrap();

        set_meta(&connection, "outbox_suspended", "1").unwrap();
        rename_collection(&connection, &collection, "From the server").unwrap();
        assert!(
            pending(&connection).is_empty(),
            "nothing queued while suspended"
        );

        connection
            .execute("DELETE FROM meta WHERE key = 'outbox_suspended'", [])
            .unwrap();
        rename_collection(&connection, &collection, "From here").unwrap();
        assert_eq!(pending(&connection).len(), 1, "and queueing resumes after");
    }

    /// A delete is a tombstone, which is an update — so it queues like one, and
    /// the deletion reaches the remote instead of the row simply going quiet.
    #[test]
    fn a_delete_queues_the_tombstone() {
        let (connection, _, folder, request) = fixture();
        connection.execute("DELETE FROM outbox", []).unwrap();

        delete_item(&connection, &folder).unwrap();

        let queued = pending(&connection);
        assert!(queued.contains(&("items".into(), folder)));
        assert!(queued.contains(&("items".into(), request)));
    }

    #[test]
    fn the_device_id_is_minted_once() {
        let (connection, _, _, _) = fixture();
        let first = device_id(&connection).unwrap();
        let second = device_id(&connection).unwrap();
        assert_eq!(first, second);
    }

    // ─── Environment variables, and the duplicates they used to breed ────────

    fn variable(key: &str, value: &str) -> super::super::model::ImportVariable {
        super::super::model::ImportVariable {
            key: key.into(),
            value: value.into(),
            current_value: None,
            enabled: true,
            secret: false,
        }
    }

    /// Every live row for a scope, tombstones excluded — which is what the app
    /// reads and therefore what "a duplicate" means to anybody looking at it.
    fn live_keys(connection: &Connection, scope_id: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(
                "SELECT key FROM variables
                  WHERE scope_id = ?1 AND deleted_at IS NULL
                  ORDER BY position",
            )
            .unwrap();
        let rows = statement.query_map([scope_id], |row| row.get(0)).unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    fn row_id_of(connection: &Connection, scope_id: &str, key: &str) -> String {
        connection
            .query_row(
                "SELECT id FROM variables
                  WHERE scope_id = ?1 AND key = ?2 AND deleted_at IS NULL",
                params![scope_id, key],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// The bug, stated as a test: saving twice used to leave two rows per key
    /// on any device that pulled the result, because the first set was
    /// hard-deleted without a tombstone and the second set arrived with new
    /// ids.
    #[test]
    fn saving_an_environment_twice_leaves_one_row_per_key() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        let id = save_environment(
            &connection,
            &workspace,
            None,
            "staging",
            false,
            &[variable("authToken", "first"), variable("base_url", "x")],
        )
        .unwrap();

        save_environment(
            &connection,
            &workspace,
            Some(&id),
            "staging",
            false,
            &[variable("authToken", "second"), variable("base_url", "x")],
        )
        .unwrap();

        assert_eq!(live_keys(&connection, &id), vec!["authToken", "base_url"]);
    }

    /// The half that makes sync work: the row that survives a save is the *same*
    /// row, so the remote sees an edit rather than a stranger with a familiar
    /// name.
    #[test]
    fn a_surviving_variable_keeps_its_id() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        let id = save_environment(
            &connection,
            &workspace,
            None,
            "staging",
            false,
            &[variable("authToken", "first")],
        )
        .unwrap();
        let before = row_id_of(&connection, &id, "authToken");

        save_environment(
            &connection,
            &workspace,
            Some(&id),
            "staging",
            false,
            &[variable("authToken", "second")],
        )
        .unwrap();

        assert_eq!(row_id_of(&connection, &id, "authToken"), before);
        let value: String = connection
            .query_row(
                "SELECT value FROM variables WHERE id = ?1",
                [&before],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "second", "the same row, with the new value");
    }

    /// A removed variable has to leave something behind, or the remote keeps it
    /// for ever — which is the other half of how duplicates appeared.
    #[test]
    fn a_removed_variable_is_tombstoned_rather_than_deleted() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        let id = save_environment(
            &connection,
            &workspace,
            None,
            "staging",
            false,
            &[variable("keep", "1"), variable("drop", "2")],
        )
        .unwrap();
        let dropped = row_id_of(&connection, &id, "drop");

        save_environment(
            &connection,
            &workspace,
            Some(&id),
            "staging",
            false,
            &[variable("keep", "1")],
        )
        .unwrap();

        assert_eq!(live_keys(&connection, &id), vec!["keep"]);
        let deleted_at: Option<i64> = connection
            .query_row(
                "SELECT deleted_at FROM variables WHERE id = ?1",
                [&dropped],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deleted_at.is_some(), "the row is still there, marked gone");
        assert!(
            pending(&connection).contains(&("variables".into(), dropped)),
            "and queued, so the remote hears about it"
        );
    }

    /// A database that already caught the bug heals the next time anybody saves
    /// that environment, without needing to notice anything.
    #[test]
    fn a_save_clears_duplicates_that_were_already_there() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();
        let device = device_id(&connection).unwrap();

        let id = save_environment(
            &connection,
            &workspace,
            None,
            "staging",
            false,
            &[variable("authToken", "original")],
        )
        .unwrap();

        // Exactly what a pull from a remote holding the orphan would leave.
        connection
            .execute(
                "INSERT INTO variables (id, scope, scope_id, key, value, enabled, secret,
                                        position, updated_at, device_id)
                 VALUES ('orphan', 'environment', ?1, 'authToken', 'stale', 1, 0, 0, 1, ?2)",
                params![id, device],
            )
            .unwrap();
        assert_eq!(live_keys(&connection, &id).len(), 2, "two, as reported");

        save_environment(
            &connection,
            &workspace,
            Some(&id),
            "staging",
            false,
            &[variable("authToken", "fresh")],
        )
        .unwrap();

        assert_eq!(live_keys(&connection, &id), vec!["authToken"]);
        assert!(
            pending(&connection).contains(&("variables".into(), "orphan".into())),
            "the orphan's tombstone pushes, so the remote loses it too"
        );
    }

    /// Re-importing the same file is the other writer that used to churn ids.
    #[test]
    fn re_importing_an_environment_does_not_duplicate_its_variables() {
        let (connection, _, _, _) = fixture();
        let workspace = workspace_id(&connection).unwrap();

        let payload = ImportEnvironment {
            name: "staging".into(),
            is_global: false,
            variables: vec![variable("authToken", "x"), variable("base_url", "y")],
            raw: None,
        };

        let first = import_environment(&connection, &workspace, &payload).unwrap();
        let again = import_environment(&connection, &workspace, &payload).unwrap();

        assert_eq!(first, again, "the same environment, replaced");
        assert_eq!(live_keys(&connection, &first), vec!["authToken", "base_url"]);
    }
}

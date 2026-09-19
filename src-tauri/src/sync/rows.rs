//! Rows in and out of SQLite, generically.
//!
//! Seven tables, and a hand-written reader and writer for each would be
//! fourteen functions that must agree with the schema and with one another.
//! Driving both from `TABLES` instead means there is one place to be wrong, and
//! adding a table is an entry in a list.
//!
//! A row crosses as a JSON object keyed by column name — the same shape the
//! Postgres itself speaks as `jsonb`, so neither side needs a translation step.

use rusqlite::types::{ToSqlOutput, Value as SqlValue, ValueRef};
use rusqlite::{Connection, ToSql};
use serde_json::{Map, Value};

use super::merge::LocalState;
use super::{column_kind, ColumnKind, SyncResult, SyncTable};

/// One row, keyed by column name.
pub type Row = Map<String, Value>;

fn sql<T>(result: rusqlite::Result<T>) -> SyncResult<T> {
    result.map_err(|e| e.to_string())
}

/// Quoted for both dialects. SQLite and Postgres both take double quotes, and
/// a column called `value` or `key` is common enough to be worth the noise.
fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn column_list(table: &SyncTable) -> String {
    table
        .columns
        .iter()
        .map(|column| quoted(column))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A SQLite value as JSON, for the column it came from.
///
/// Two conversions matter and neither is cosmetic:
///
/// - **Integers stay integers**, not floats. `updated_at` is milliseconds, and
///   a millisecond that has been through an `f64` is no longer the millisecond
///   the remote stamped.
/// - **A boolean column becomes a boolean.** SQLite has no boolean type and
///   stores `enabled` as 0 or 1; Postgres has one and refuses a number for it.
///   Sending `"enabled": 1` would be rejected by the remote with a type error,
///   which is a baffling way to discover a difference between two databases.
fn to_json(value: ValueRef<'_>, column: &str) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => {
            if column_kind(column) == ColumnKind::Boolean {
                Value::Bool(number != 0)
            } else {
                Value::from(number)
            }
        }
        ValueRef::Real(number) => Value::from(number),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        // No column in this schema is a blob; if one appears, its length is
        // more useful in a log than a panic.
        ValueRef::Blob(bytes) => Value::from(format!("<{} bytes>", bytes.len())),
    }
}

/// JSON back to something SQLite can bind.
struct Bound(Value);

impl ToSql for Bound {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match &self.0 {
            Value::Null => ToSqlOutput::Owned(SqlValue::Null),
            Value::Bool(flag) => ToSqlOutput::Owned(SqlValue::Integer(i64::from(*flag))),
            Value::Number(number) => {
                if let Some(integer) = number.as_i64() {
                    ToSqlOutput::Owned(SqlValue::Integer(integer))
                } else {
                    ToSqlOutput::Owned(SqlValue::Real(number.as_f64().unwrap_or(0.0)))
                }
            }
            Value::String(text) => ToSqlOutput::Owned(SqlValue::Text(text.clone())),
            // A JSON column arriving as a structure rather than a string: store
            // it as the text the rest of the app expects to parse.
            other => ToSqlOutput::Owned(SqlValue::Text(other.to_string())),
        })
    }
}

/// The rows the outbox says are dirty, ready to push.
pub fn queued(connection: &Connection, table: &SyncTable, limit: usize) -> SyncResult<Vec<Row>> {
    let statement = format!(
        "SELECT {} FROM {} WHERE {} IN (
             SELECT row_id FROM outbox WHERE table_name = ?1 ORDER BY seq LIMIT ?2
         )",
        column_list(table),
        quoted(table.name),
        quoted(table.key)
    );

    let mut prepared = sql(connection.prepare(&statement))?;
    let mut found = Vec::new();
    let mut cursor = sql(prepared.query(rusqlite::params![table.name, limit as i64]))?;

    while let Some(row) = sql(cursor.next())? {
        let mut object = Row::new();
        for (index, column) in table.columns.iter().enumerate() {
            object.insert(
                (*column).to_string(),
                to_json(sql(row.get_ref(index))?, column),
            );
        }
        found.push(object);
    }
    Ok(found)
}

/// How many rows are still waiting, across every table.
pub fn pending(connection: &Connection) -> SyncResult<usize> {
    let count: i64 =
        sql(connection.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0)))?;
    Ok(count as usize)
}

/// Takes rows off the queue once the remote has them.
///
/// Only entries queued at or before `queued_before` are removed: an edit made
/// while the push was in flight has to stay queued, or it is lost silently —
/// which is the worst kind of lost.
pub fn dequeue(
    connection: &Connection,
    table: &SyncTable,
    ids: &[String],
    queued_before: i64,
) -> SyncResult<()> {
    for id in ids {
        sql(connection.execute(
            "DELETE FROM outbox WHERE table_name = ?1 AND row_id = ?2 AND queued_at <= ?3",
            rusqlite::params![table.name, id, queued_before],
        ))?;
    }
    Ok(())
}

/// What the local database knows about a row, for the decision table.
pub fn local_state(
    connection: &Connection,
    table: &SyncTable,
    id: &str,
) -> SyncResult<Option<LocalState>> {
    let statement = format!(
        "SELECT t.updated_at, t.deleted_at,
                (SELECT 1 FROM outbox WHERE table_name = ?1 AND row_id = ?2)
           FROM {} t WHERE t.{} = ?2",
        quoted(table.name),
        quoted(table.key)
    );

    let found = sql(connection
        .query_row(&statement, rusqlite::params![table.name, id], |row| {
            Ok(LocalState {
                updated_at: row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                deleted: row.get::<_, Option<i64>>(1)?.is_some(),
                dirty: row.get::<_, Option<i64>>(2)?.is_some(),
            })
        })
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        }))?;

    Ok(found)
}

/// Writes a row, replacing whatever was there.
///
/// An update where the row exists, an insert where it does not — rather than
/// one upsert. The difference matters: SQLite checks `NOT NULL` against the
/// *proposed* insert even when the conflict clause would have updated instead,
/// so a remote that sends only the columns it changed would be refused. Doing
/// it this way means a column nobody sent is left alone, which is what a
/// downgrade needs in order not to blank what it cannot see.
pub fn upsert(connection: &Connection, table: &SyncTable, row: &Row) -> SyncResult<()> {
    let present: Vec<&&str> = table
        .columns
        .iter()
        .filter(|column| row.contains_key(**column))
        .collect();

    if !present.iter().any(|column| **column == table.key) {
        return Err(format!(
            "A {} row arrived without its {}",
            table.name, table.key
        ));
    }

    let key = row
        .get(table.key)
        .cloned()
        .ok_or_else(|| format!("A {} row arrived without its {}", table.name, table.key))?;

    let exists = sql(connection
        .query_row(
            &format!(
                "SELECT 1 FROM {} WHERE {} = ?1",
                quoted(table.name),
                quoted(table.key)
            ),
            rusqlite::params![Bound(key.clone())],
            |_| Ok(()),
        )
        .map(|_| true)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(other),
        }))?;

    if exists {
        let changing: Vec<&&str> = present
            .iter()
            .filter(|column| ***column != table.key)
            .copied()
            .collect();
        if changing.is_empty() {
            return Ok(());
        }

        let assignments = changing
            .iter()
            .enumerate()
            .map(|(index, column)| format!("{} = ?{}", quoted(column), index + 1))
            .collect::<Vec<_>>()
            .join(", ");

        let statement = format!(
            "UPDATE {} SET {} WHERE {} = ?{}",
            quoted(table.name),
            assignments,
            quoted(table.key),
            changing.len() + 1
        );

        let mut values: Vec<Bound> = changing
            .iter()
            .map(|column| Bound(row.get(**column).cloned().unwrap_or(Value::Null)))
            .collect();
        values.push(Bound(key));
        let bound: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();

        sql(connection.execute(&statement, bound.as_slice()))?;
        return Ok(());
    }

    let columns = present
        .iter()
        .map(|column| quoted(column))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=present.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");

    let statement = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quoted(table.name),
        columns,
        placeholders
    );

    let values: Vec<Bound> = present
        .iter()
        .map(|column| Bound(row.get(**column).cloned().unwrap_or(Value::Null)))
        .collect();
    let bound: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();

    sql(connection.execute(&statement, bound.as_slice()))?;
    Ok(())
}

/// Reads one row as JSON, for making a conflicted copy of it.
pub fn read(connection: &Connection, table: &SyncTable, id: &str) -> SyncResult<Option<Row>> {
    let statement = format!(
        "SELECT {} FROM {} WHERE {} = ?1",
        column_list(table),
        quoted(table.name),
        quoted(table.key)
    );
    let mut prepared = sql(connection.prepare(&statement))?;
    let mut cursor = sql(prepared.query(rusqlite::params![id]))?;

    let Some(row) = sql(cursor.next())? else {
        return Ok(None);
    };

    let mut object = Row::new();
    for (index, column) in table.columns.iter().enumerate() {
        object.insert(
            (*column).to_string(),
            to_json(sql(row.get_ref(index))?, column),
        );
    }
    Ok(Some(object))
}

/// The value of a row's key, as text.
pub fn key_of(table: &SyncTable, row: &Row) -> Option<String> {
    row.get(table.key).and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

pub fn number(row: &Row, column: &str) -> i64 {
    row.get(column).and_then(Value::as_i64).unwrap_or(0)
}

pub fn is_set(row: &Row, column: &str) -> bool {
    !matches!(row.get(column), None | Some(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::schema;
    use crate::sync::table;
    use serde_json::json;

    fn fresh() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        schema::migrate(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO workspaces (id, name, created_at, updated_at, device_id)
                 VALUES ('w', 'W', 1, 1, 'd')",
                [],
            )
            .unwrap();
        connection
    }

    #[test]
    fn a_row_goes_out_and_comes_back_the_same() {
        let connection = fresh();
        let collections = table("collections").unwrap();

        let row: Row = serde_json::from_value(json!({
            "id": "c1",
            "workspace_id": "w",
            "name": "API",
            "description": "",
            "rank": "V",
            "auth": null,
            "variables": null,
            "events": null,
            "raw": null,
            "updated_at": 1_700_000_000_123i64,
            "deleted_at": null,
            "rev": 3,
            "device_id": "d"
        }))
        .unwrap();

        upsert(&connection, collections, &row).unwrap();
        let read_back = read(&connection, collections, "c1").unwrap().unwrap();

        assert_eq!(read_back["name"], "API");
        // The millisecond is still a millisecond, not a float that nearly is.
        assert_eq!(read_back["updated_at"], json!(1_700_000_000_123i64));
        assert_eq!(read_back["rev"], json!(3));
        assert_eq!(read_back["deleted_at"], Value::Null);
    }

    #[test]
    fn writing_the_same_row_twice_updates_it() {
        let connection = fresh();
        let collections = table("collections").unwrap();
        let mut row: Row = serde_json::from_value(json!({
            "id": "c1", "workspace_id": "w", "name": "One", "description": "",
            "rank": "V", "updated_at": 1, "rev": 1, "device_id": "d"
        }))
        .unwrap();

        upsert(&connection, collections, &row).unwrap();
        row.insert("name".into(), json!("Two"));
        upsert(&connection, collections, &row).unwrap();

        let count: i64 = connection
            .query_row("SELECT count(*) FROM collections", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            read(&connection, collections, "c1").unwrap().unwrap()["name"],
            "Two"
        );
    }

    /// A remote written by a newer build may send columns this one has never
    /// heard of, and may omit none — but a row that omits a column must not
    /// blank it here, or a downgrade quietly destroys data.
    #[test]
    fn a_column_the_remote_did_not_send_is_left_alone() {
        let connection = fresh();
        let collections = table("collections").unwrap();

        upsert(
            &connection,
            collections,
            &serde_json::from_value(json!({
                "id": "c1", "workspace_id": "w", "name": "One", "description": "kept",
                "rank": "V", "updated_at": 1, "rev": 1, "device_id": "d"
            }))
            .unwrap(),
        )
        .unwrap();

        upsert(
            &connection,
            collections,
            &serde_json::from_value(json!({ "id": "c1", "name": "Two" })).unwrap(),
        )
        .unwrap();

        let row = read(&connection, collections, "c1").unwrap().unwrap();
        assert_eq!(row["name"], "Two");
        assert_eq!(row["description"], "kept");
    }

    /// SQLite has no boolean type and Postgres will not take a number for one.
    /// A row that crossed with `"enabled": 1` would be rejected by the remote
    /// with a type error rather than anything that points at this.
    #[test]
    fn a_boolean_column_crosses_as_a_boolean() {
        let connection = fresh();
        let variables = table("variables").unwrap();

        connection
            .execute(
                "INSERT INTO variables (id, scope, scope_id, key, value, enabled, secret,
                                        updated_at, device_id)
                 VALUES ('v1', 'environment', 'e1', 'token', 'x', 0, 1, 1, 'd')",
                [],
            )
            .unwrap();

        let row = read(&connection, variables, "v1").unwrap().unwrap();
        assert_eq!(row["enabled"], json!(false));
        assert_eq!(row["secret"], json!(true));
        // And a timestamp is still a number, not a boolean-looking one.
        assert_eq!(row["updated_at"], json!(1));

        // Back the other way, a boolean binds as the integer SQLite stores.
        upsert(&connection, variables, &row).unwrap();
        let enabled: i64 = connection
            .query_row("SELECT enabled FROM variables WHERE id = 'v1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(enabled, 0);
    }

    #[test]
    fn a_row_with_no_key_is_refused_rather_than_guessed_at() {
        let connection = fresh();
        let collections = table("collections").unwrap();
        let error = upsert(
            &connection,
            collections,
            &serde_json::from_value(json!({ "name": "Nameless" })).unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("without its id"));
    }

    #[test]
    fn the_queue_reports_what_was_written_and_forgets_what_was_pushed() {
        let connection = fresh();
        let collections = table("collections").unwrap();

        connection
            .execute(
                "INSERT INTO collections (id, workspace_id, name, rank, updated_at, device_id)
                 VALUES ('c1', 'w', 'API', 'V', 5, 'd')",
                [],
            )
            .unwrap();

        let waiting = queued(&connection, collections, 100).unwrap();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0]["name"], "API");

        // A push that started before the edit must not clear the edit.
        dequeue(&connection, collections, &["c1".into()], 0).unwrap();
        assert_eq!(queued(&connection, collections, 100).unwrap().len(), 1);

        dequeue(&connection, collections, &["c1".into()], i64::MAX).unwrap();
        assert!(queued(&connection, collections, 100).unwrap().is_empty());
    }

    #[test]
    fn local_state_says_whether_a_row_is_ours_to_push() {
        let connection = fresh();
        let collections = table("collections").unwrap();

        assert!(local_state(&connection, collections, "nope")
            .unwrap()
            .is_none());

        connection
            .execute(
                "INSERT INTO collections (id, workspace_id, name, rank, updated_at, device_id)
                 VALUES ('c1', 'w', 'API', 'V', 5, 'd')",
                [],
            )
            .unwrap();

        let state = local_state(&connection, collections, "c1")
            .unwrap()
            .unwrap();
        assert_eq!(state.updated_at, 5);
        assert!(state.dirty);
        assert!(!state.deleted);

        dequeue(&connection, collections, &["c1".into()], i64::MAX).unwrap();
        assert!(
            !local_state(&connection, collections, "c1")
                .unwrap()
                .unwrap()
                .dirty
        );
    }
}

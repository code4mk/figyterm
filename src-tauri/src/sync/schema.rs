//! The SQL that makes a Postgres database ready to hold a copy.
//!
//! Generated rather than shipped as a file, because the schema name is the
//! user's choice and appears forty times. The modal shows it, offers to copy
//! it, and — in the direct-connection phase — runs it.
//!
//! Three things in here are decisions rather than transcription:
//!
//! - **`updated_at` is stamped by the server, in a trigger.** Last writer wins
//!   is only meaningful if both writers are measured by the same clock, and two
//!   laptops disagreeing about the time is exactly how it picks the wrong
//!   winner. The app sends a value; the trigger overwrites it.
//! - **Timestamps are `bigint` milliseconds**, matching SQLite, so a row is
//!   copied rather than converted. A `timestamptz` would be more idiomatic
//!   Postgres and would mean every read and write went through a conversion
//!   that could round.
//! - **Row-level security is optional but on by default**, keyed to the signed
//!   in user. Without it a project key can read every row in the database,
//!   which is fine for one person's own project and wrong for anything shared.

use super::{column_kind, ColumnKind, SyncTable, TABLES};

/// The Postgres type for a column, from the one place that knows.
fn column_type(column: &str) -> &'static str {
    match column_kind(column) {
        ColumnKind::Integer => "bigint",
        ColumnKind::Boolean => "boolean",
        ColumnKind::Text => "text",
    }
}

/// The whole setup, for a schema name.
///
/// One transaction: a half-created schema is worse than none, and every
/// statement here is `IF NOT EXISTS` so a rollback loses nothing that was
/// already there.
pub fn setup_sql(schema: &str) -> String {
    let schema = sanitise(schema);
    let mut sql = String::new();

    sql.push_str(&format!(
        "BEGIN;\n\n\
         {rule}\n\
         -- FigyMan — PostgreSQL schema\n\
         --\n\
         -- Safe to run repeatedly against an existing database.\n\
         -- Existing data is preserved.\n\
         {rule}\n\n\n\
         {rule}\n\
         -- 1. Schema\n\
         {rule}\n\n\
         CREATE SCHEMA IF NOT EXISTS {schema};\n\n\n\
         {rule}\n\
         -- 2. Updated-at trigger function\n\
         --\n\
         -- The server stamps every write, so both machines are measured by one\n\
         -- clock. Without this, last-writer-wins picks whichever laptop is fast.\n\
         {rule}\n\n\
         CREATE OR REPLACE FUNCTION {schema}.touch_updated_at()\n\
         RETURNS trigger\n\
         LANGUAGE plpgsql\n\
         AS $$\n\
         BEGIN\n\
         \x20   NEW.updated_at :=\n\
         \x20       (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;\n\n\
         \x20   RETURN NEW;\n\
         END;\n\
         $$;\n\n\n",
        rule = RULE
    ));

    for (index, table) in TABLES.iter().enumerate() {
        sql.push_str(&table_sql(&schema, table, index + 3));
    }

    sql.push_str(&triggers_sql(&schema, TABLES.len() + 3));
    sql.push_str(&defaults_sql(&schema, TABLES.len() + 4));
    sql.push_str(&grants_sql(&schema, TABLES.len() + 5));
    sql.push_str("COMMIT;\n");
    sql
}

/// The rule that separates the sections. A generated file nobody can skim is a
/// generated file people paste without reading.
const RULE: &str = "-- ============================================================";

/// One table: its columns, then the indexes the sync engine's own queries need.
fn table_sql(schema: &str, table: &SyncTable, section: usize) -> String {
    let mut sql = format!(
        "{RULE}\n-- {section}. {title}\n{RULE}\n\nCREATE TABLE IF NOT EXISTS {schema}.{name} (\n",
        title = title(table.name),
        name = table.name
    );

    // Padded to the widest name, because these are read by people deciding
    // whether to run them.
    let widest = table
        .columns
        .iter()
        .map(|column| column.len())
        .max()
        .unwrap_or(0);

    let columns = table
        .columns
        .iter()
        .map(|column| {
            let kind = column_type(column);
            if *column == table.key {
                format!("    {column:<widest$}  {kind} PRIMARY KEY")
            } else {
                format!("    {column:<widest$}  {kind}")
            }
        })
        .collect::<Vec<_>>()
        .join(",\n");
    sql.push_str(&columns);
    sql.push_str("\n);\n");

    for (name, on) in indexes(table) {
        sql.push_str(&format!(
            "\nCREATE INDEX IF NOT EXISTS {name}\n    ON {schema}.{table} ({on});\n",
            table = table.name
        ));
    }
    sql.push_str("\n\n");
    sql
}

/// The indexes a table gets, and why each one is there.
///
/// Derived from the columns rather than listed, so a column added to `TABLES`
/// arrives indexed instead of arriving and being noticed six months later in a
/// sequential scan.
///
/// - `updated_at` is what every pull filters and orders by.
/// - `deleted_at` is what every read excludes on.
/// - A `*_id` that is not the key and not this device is a parent somebody
///   fetches children by.
fn indexes(table: &SyncTable) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let name = table.name;

    // A scope is only ever looked up with its id, so the pair is one index
    // rather than two — `variables` is the whole table for every collection.
    if table.columns.contains(&"scope") && table.columns.contains(&"scope_id") {
        found.push((format!("{name}_scope_idx"), "scope, scope_id".to_string()));
    }

    for column in table.columns {
        if *column == table.key || *column == "device_id" || *column == "scope_id" {
            continue;
        }
        if column.ends_with("_id") {
            found.push((format!("{name}_{column}_idx"), (*column).to_string()));
        }
    }

    for column in ["updated_at", "deleted_at"] {
        if table.columns.contains(&column) {
            found.push((format!("{name}_{column}_idx"), column.to_string()));
        }
    }
    found
}

/// The triggers, each created only if it is not already there.
///
/// `DROP TRIGGER` then `CREATE TRIGGER` would be shorter and is what this used
/// to do — but dropping needs ownership of the table, and a role that may write
/// to a database it does not own is an ordinary arrangement. Asking `pg_trigger`
/// first needs no privilege at all.
fn triggers_sql(schema: &str, section: usize) -> String {
    let mut sql = format!(
        "{RULE}\n-- {section}. Triggers, created only when missing\n{RULE}\n\nDO $$\nBEGIN\n"
    );

    for table in TABLES {
        sql.push_str(&format!(
            "\n\x20   IF NOT EXISTS (\n\
             \x20       SELECT 1\n\
             \x20       FROM pg_trigger\n\
             \x20       WHERE tgname = '{name}_touch'\n\
             \x20         AND tgrelid = '{schema}.{name}'::regclass\n\
             \x20   ) THEN\n\
             \x20       CREATE TRIGGER {name}_touch\n\
             \x20       BEFORE INSERT OR UPDATE\n\
             \x20       ON {schema}.{name}\n\
             \x20       FOR EACH ROW\n\
             \x20       EXECUTE FUNCTION {schema}.touch_updated_at();\n\
             \x20   END IF;\n",
            name = table.name
        ));
    }

    sql.push_str("\nEND\n$$;\n\n\n");
    sql
}

/// `rev` starts at zero for a row this app did not write, so a row inserted by
/// hand still compares against one that was.
fn defaults_sql(schema: &str, section: usize) -> String {
    let mut sql = format!(
        "{RULE}\n\
         -- {section}. Default values for new rows\n\
         --\n\
         -- Only applies to future inserts. Existing data is NOT modified.\n\
         {RULE}\n\n"
    );
    for table in TABLES {
        sql.push_str(&format!(
            "ALTER TABLE {schema}.{name}\n    ALTER COLUMN rev SET DEFAULT 0;\n\n",
            name = table.name
        ));
    }
    sql.push('\n');
    sql
}

/// Takes away what Postgres grants by default, and shows — commented — how to
/// give a role of its own exactly what this app needs.
///
/// Commented because creating a role is the database owner's decision and
/// needs their credentials; a generated script that silently made one would be
/// a script nobody could safely run twice.
fn grants_sql(schema: &str, section: usize) -> String {
    format!(
        "{RULE}\n\
         -- {section}. Grants\n\
         {RULE}\n\n\
         -- Remove accidental PUBLIC access.\n\
         REVOKE ALL ON SCHEMA {schema} FROM PUBLIC;\n\
         REVOKE ALL ON ALL TABLES IN SCHEMA {schema} FROM PUBLIC;\n\
         REVOKE ALL ON ALL SEQUENCES IN SCHEMA {schema} FROM PUBLIC;\n\n\n\
         {RULE}\n\
         -- {next}. Application role\n\
         {RULE}\n\
         --\n\
         -- Create the role as the database owner, then uncomment the grants.\n\
         --\n\
         -- CREATE ROLE figy_app LOGIN PASSWORD 'strong-password';\n\
         --\n\
         -- GRANT USAGE ON SCHEMA {schema} TO figy_app;\n\
         --\n\
         -- GRANT SELECT, INSERT, UPDATE, DELETE\n\
         -- ON ALL TABLES IN SCHEMA {schema}\n\
         -- TO figy_app;\n\
         --\n\
         -- ALTER DEFAULT PRIVILEGES IN SCHEMA {schema}\n\
         -- GRANT SELECT, INSERT, UPDATE, DELETE\n\
         -- ON TABLES\n\
         -- TO figy_app;\n\n\n",
        next = section + 1
    )
}

/// A table's name as a heading: `status_text` never appears here, but
/// `workspaces` reads better capitalised.
fn title(name: &str) -> String {
    let mut characters = name.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

/// The schema name, as it will actually appear in SQL.
///
/// Public because it must be applied *once, early*, not per call site. It used
/// to be private and only `setup_sql` used it, which meant the tables were
/// created under the cleaned name while everything else — the probe, the pulls
/// and the pushes — used whatever was typed. A name that survives cleaning
/// unchanged hides the split entirely; one that does not, such as a trailing
/// space or a capital letter, creates the tables in one schema and then looks
/// for them in another, for ever.
pub fn sanitise(schema: &str) -> String {
    let cleaned: String = schema
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect();
    if cleaned.is_empty() || cleaned.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        "figyman".to_string()
    } else {
        cleaned.to_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_table_is_created_with_its_key_and_its_trigger() {
        let sql = setup_sql("figyman");
        for table in TABLES {
            assert!(
                sql.contains(&format!(
                    "CREATE TABLE IF NOT EXISTS figyman.{}",
                    table.name
                )),
                "{} is missing",
                table.name
            );
            assert!(
                sql.contains(&format!("CREATE TRIGGER {}_touch", table.name)),
                "{} is not stamped by the server",
                table.name
            );
        }
    }

    /// The key is a primary key, whatever it is called. `requests` keys on
    /// `item_id`, which is exactly the kind of thing a hard-coded "id" misses.
    #[test]
    fn the_key_of_each_table_is_its_primary_key() {
        let sql = setup_sql("figyman");
        // By the line rather than by a substring: the columns are padded to
        // line up, so how many spaces sit between a name and its type is a
        // formatting decision and not something a test should depend on.
        let keys: Vec<&str> = sql
            .lines()
            .filter(|line| line.contains("PRIMARY KEY"))
            .map(|line| line.split_whitespace().next().unwrap_or(""))
            .collect();

        for table in TABLES {
            assert!(
                keys.contains(&table.key),
                "{} has no primary key on {}",
                table.name,
                table.key
            );
        }
        assert_eq!(keys.len(), TABLES.len(), "one primary key per table");
    }

    #[test]
    fn timestamps_are_milliseconds_so_a_row_copies_rather_than_converts() {
        let sql = setup_sql("figyman");
        assert!(sql.contains("updated_at  bigint"));
        assert!(sql.contains("deleted_at  bigint"));
        assert!(sql.contains("enabled     boolean"));
    }

    /// One transaction: a half-created schema is worse than none.
    #[test]
    fn the_whole_thing_is_one_transaction() {
        let sql = setup_sql("figyman");
        assert!(sql.starts_with("BEGIN;"));
        assert!(sql.trim_end().ends_with("COMMIT;"));
    }

    /// Every statement is conditional, so running it twice is not an error —
    /// which is the only thing that makes "run this by hand" safe advice.
    #[test]
    fn nothing_in_it_fails_on_a_second_run() {
        let sql = setup_sql("figyman");
        for statement in ["CREATE SCHEMA", "CREATE TABLE", "CREATE INDEX"] {
            for line in sql.lines().filter(|line| line.trim_start().starts_with(statement)) {
                assert!(
                    line.contains("IF NOT EXISTS"),
                    "unconditional: {line}"
                );
            }
        }
        assert!(
            sql.contains("CREATE OR REPLACE FUNCTION"),
            "the function is replaced rather than created"
        );
    }

    /// Dropping a trigger needs ownership of the table, and a role that may
    /// write to a database it does not own is an ordinary arrangement. Asking
    /// `pg_trigger` first needs no privilege at all.
    #[test]
    fn triggers_are_asked_about_rather_than_dropped() {
        let sql = setup_sql("figyman");
        assert!(!sql.contains("DROP TRIGGER"));
        assert!(sql.contains("FROM pg_trigger"));
        for table in TABLES {
            assert!(sql.contains(&format!("tgname = '{}_touch'", table.name)));
        }
    }

    /// Indexes are derived from the columns, so a column added to `TABLES`
    /// arrives indexed rather than being found in a sequential scan later.
    #[test]
    fn every_table_is_indexed_on_what_the_engine_actually_queries() {
        let sql = setup_sql("figyman");
        for table in TABLES {
            assert!(
                sql.contains(&format!("{}_updated_at_idx", table.name)),
                "{}: every pull filters and orders by updated_at",
                table.name
            );
            assert!(
                sql.contains(&format!("{}_deleted_at_idx", table.name)),
                "{}: every read excludes on deleted_at",
                table.name
            );
        }

        assert!(sql.contains("collections_workspace_id_idx"));
        assert!(sql.contains("items_collection_id_idx"));
        assert!(sql.contains("items_parent_id_idx"));
        assert!(sql.contains("examples_item_id_idx"));
        // A scope is only ever looked up with its id, so the pair is one index.
        assert!(sql.contains("variables_scope_idx"));
        assert!(!sql.contains("variables_scope_id_idx"));
        // The key is already indexed by being the key, and nobody queries by
        // which device wrote a row.
        assert!(!sql.contains("requests_item_id_idx"));
        assert!(!sql.contains("device_id_idx"));
    }

    /// Row-level security went with the hosted mode: `auth.uid()` is a
    /// function some platforms install with their auth layer, and a plain
    /// Postgres database has never heard of it.
    #[test]
    fn nothing_here_depends_on_a_platform_specific_function() {
        let sql = setup_sql("figyman");
        assert!(!sql.contains("auth.uid()"));
        assert!(!sql.contains("ROW LEVEL SECURITY"));
        assert!(!sql.contains("anon"));
    }

    /// Creating a role needs the owner's credentials, so the script shows how
    /// and does not do it. A generated script that silently made a role would
    /// be one nobody could safely run twice.
    #[test]
    fn the_application_role_is_shown_but_not_created() {
        let sql = setup_sql("figyman");
        assert!(sql.contains("-- CREATE ROLE figy_app"));
        assert!(!sql.contains("\nCREATE ROLE"));
        assert!(sql.contains("REVOKE ALL ON SCHEMA figyman FROM PUBLIC;"));
    }

    /// The schema name is concatenated into SQL somebody runs as an owner, so
    /// it is reduced to an identifier rather than escaped and hoped for.
    #[test]
    fn a_schema_name_cannot_carry_anything_but_a_name() {
        assert!(setup_sql("public; DROP TABLE users; --")
            .contains("CREATE SCHEMA IF NOT EXISTS publicdroptableusers"));
        assert!(!setup_sql("public; DROP TABLE users; --").contains("DROP TABLE users"));
        assert!(setup_sql("").contains("CREATE SCHEMA IF NOT EXISTS figyman"));
        assert!(setup_sql("2fast").contains("CREATE SCHEMA IF NOT EXISTS figyman"));
        assert!(setup_sql("My_Schema").contains("CREATE SCHEMA IF NOT EXISTS my_schema"));
    }
}

#[cfg(test)]
mod dump {
    /// Prints the generated script, for eyeballing it against a hand-written
    /// one. `cargo test -- --ignored --nocapture dump`.
    #[test]
    #[ignore]
    fn print() {
        println!("{}", super::setup_sql("public"));
    }
}

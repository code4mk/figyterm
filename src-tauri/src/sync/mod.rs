//! Keeping a local collection and a Postgres one in step.
//!
//! The design is in `docs/API-CLIENT.md`; the shape of it here is:
//!
//! - **Local is always authoritative for writes.** Every mutation writes the
//!   row and queues it, in one transaction, by trigger. The UI never waits on
//!   the network, and there is no state in which a save appeared to work and
//!   did not.
//! - **A pass is push, pull, merge, watermark**, in that order, and the
//!   watermark only moves when the whole pass has committed.
//! - **Last writer wins per row**, decided by the *server's* clock — two
//!   machines disagreeing about the time is precisely how last-writer-wins
//!   picks the wrong winner, so the remote stamps `updated_at` and we take what
//!   it says.
//! - **A conflict is never a silent loss.** Where both sides changed a row, the
//!   remote keeps the identity and the local version is re-inserted beside it,
//!   marked, so the rail can badge it and a person can decide.
//!
//! **The remote is an enum, not a trait.** The plan said a trait; there are
//! exactly one implementation — Postgres over the wire — the set is closed, and
//! an enum gives the same seam without `async_trait` or a box per call.
//!
//! **Nothing here has been run against a real server.** Every part that can be
//! checked without one is tested — the decision table, the row codec, the
//! request construction, the outbox — and the rest is honest guesswork until
//! somebody points it at a project. See `docs/API-CLIENT-TASKS.md`.

pub mod direct;
pub mod merge;
pub mod remote;
pub mod rows;
pub mod schema;
pub mod worker;

use serde::{Deserialize, Serialize};

/// A table that syncs, and what its rows are made of.
///
/// Driving the codec from a description rather than writing seven readers and
/// seven writers is what keeps this module small enough to reason about — and
/// it means adding a table is one entry rather than four functions.
pub struct SyncTable {
    pub name: &'static str,
    /// The primary key column. `requests` is keyed by the item it belongs to.
    pub key: &'static str,
    pub columns: &'static [&'static str],
    /// Whether a conflicted copy of this row makes sense — it needs a `name`
    /// to append to, and somewhere in the tree to appear.
    pub named: bool,
}

/// Every table that crosses, parents before children.
///
/// The order is the push order and it matters: a remote with foreign keys
/// rejects an item whose collection has not arrived yet. History is absent
/// deliberately — it is local, it is large, and nobody wants their laptop's
/// traffic log in a shared database.
pub const TABLES: &[SyncTable] = &[
    SyncTable {
        name: "workspaces",
        key: "id",
        columns: &[
            "id",
            "name",
            "created_at",
            "updated_at",
            "deleted_at",
            "rev",
            "device_id",
        ],
        named: false,
    },
    SyncTable {
        name: "collections",
        key: "id",
        columns: &[
            "id",
            "workspace_id",
            "name",
            "description",
            "rank",
            "auth",
            "variables",
            "events",
            "raw",
            "updated_at",
            "deleted_at",
            "rev",
            "device_id",
            "conflicted_at",
        ],
        named: true,
    },
    SyncTable {
        name: "items",
        key: "id",
        columns: &[
            "id",
            "collection_id",
            "parent_id",
            "kind",
            "name",
            "description",
            "rank",
            "auth",
            "events",
            "variables",
            "raw",
            "updated_at",
            "deleted_at",
            "rev",
            "device_id",
            "conflicted_at",
        ],
        named: true,
    },
    SyncTable {
        name: "requests",
        key: "item_id",
        columns: &[
            "item_id",
            "method",
            "url",
            "headers",
            "body",
            "settings",
            "updated_at",
            "deleted_at",
            "rev",
            "device_id",
        ],
        named: false,
    },
    SyncTable {
        name: "examples",
        key: "id",
        columns: &[
            "id",
            "item_id",
            "name",
            "status",
            "status_text",
            "headers",
            "body",
            "rank",
            "raw",
            "updated_at",
            "deleted_at",
            "rev",
            "device_id",
        ],
        named: false,
    },
    SyncTable {
        name: "environments",
        key: "id",
        columns: &[
            "id",
            "workspace_id",
            "name",
            "is_global",
            "rank",
            "raw",
            "updated_at",
            "deleted_at",
            "rev",
            "device_id",
            "conflicted_at",
        ],
        named: true,
    },
    SyncTable {
        name: "variables",
        key: "id",
        columns: &[
            "id",
            "scope",
            "scope_id",
            "key",
            "value",
            "enabled",
            "secret",
            "position",
            "updated_at",
            "deleted_at",
            "rev",
            "device_id",
        ],
        named: false,
    },
];

pub fn table(name: &str) -> Option<&'static SyncTable> {
    TABLES.iter().find(|table| table.name == name)
}

/// What a column is, in one place.
///
/// Both the Postgres schema generator and the row codec read this, and they
/// have to agree: SQLite has no boolean type and stores `enabled` as 0 or 1,
/// while Postgres has one and refuses a number for it. A row that crossed with
/// `"enabled": 1` would be rejected by the remote with a type error, which is a
/// confusing way to find out about a disagreement between two constants.
#[derive(PartialEq, Eq, Clone, Copy)]
pub enum ColumnKind {
    Text,
    Integer,
    Boolean,
}

pub fn column_kind(column: &str) -> ColumnKind {
    match column {
        "created_at" | "updated_at" | "deleted_at" | "conflicted_at" | "position" | "status"
        | "rev" => ColumnKind::Integer,
        "is_global" | "enabled" | "secret" => ColumnKind::Boolean,
        _ => ColumnKind::Text,
    }
}

/// How to reach the remote. Kept in `meta`, and deliberately holding no secret:
/// the key and any token live in the OS keychain.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// Always `direct` now: Postgres, wherever it is. Kept as a field rather
    /// than dropped so a config written before the hosted mode went still
    /// deserialises instead of resetting somebody's settings to nothing.
    pub mode: String,
    /// Empty. What the hosted mode kept its base URL in, and read only so an
    /// older config still loads.
    pub url: String,
    /// The Postgres schema the tables live in.
    pub schema: String,
    /// The account signed in, when one is. Shown in the status panel.
    pub email: Option<String>,
    /// How often a pass runs with nothing else prompting it, in seconds.
    pub interval_secs: u64,
    pub sync_on_focus: bool,
    /// Off by default, and an explicit choice: history is large, and it holds
    /// response bodies that were never meant to be shared.
    pub sync_history: bool,
    /// Whether this machine is connected to a database at all. Set by
    /// connecting, cleared by disconnecting, and the one thing that decides
    /// whether syncing is possible.
    pub enabled: bool,
    /// Whether passes run **on their own** — the interval, and the window
    /// opening. Off is not "sync is switched off": pressing Sync still works,
    /// because pressing it is the whole of what it means to ask.
    ///
    /// Defaulted to true so a config written before this existed keeps the
    /// behaviour it had, which was always to run on a timer.
    #[serde(default = "yes")]
    pub auto: bool,
    /// Where the database is. Holds no password: that is in the keychain.
    #[serde(default)]
    pub direct: Option<direct::DirectConfig>,
}

fn yes() -> bool {
    true
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            mode: "direct".into(),
            url: String::new(),
            schema: "figyman".into(),
            email: None,
            interval_secs: 300,
            sync_on_focus: true,
            sync_history: false,
            enabled: false,
            auto: true,
            direct: None,
        }
    }
}

/// What a pass did, for the status panel.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub pushed: usize,
    pub pulled: usize,
    pub conflicts: usize,
    /// Rows still queued after the pass — non-zero when something failed.
    pub pending: usize,
    pub finished_at: i64,
    pub error: Option<String>,
    /// Stopped part-way, by the user or by the deadline.
    ///
    /// Separate from `error` because it is not one: what had already moved is
    /// kept and the next pass carries on from there, so the panel should say
    /// "stopped" rather than colour it like a failure.
    #[serde(default)]
    pub stopped: bool,
}

/// Where a pass got to, so the next one does not start from the beginning.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Watermarks {
    /// The highest `updated_at` seen from the remote, per table.
    pub pulled: std::collections::HashMap<String, i64>,
}

pub type SyncResult<T> = Result<T, String>;

#[cfg(test)]
mod tests {
    use super::*;

    /// Somebody who was syncing before `auto` existed was syncing on a timer,
    /// and must still be. A field that defaulted to false would switch every
    /// existing installation's automatic passes off on upgrade, silently, and
    /// the only symptom would be work not reaching the other machine.
    #[test]
    fn a_config_written_before_auto_existed_keeps_syncing_on_its_own() {
        let old = r#"{
            "mode": "direct", "url": "", "schema": "figyman", "email": null,
            "intervalSecs": 300, "syncOnFocus": true, "syncHistory": false,
            "enabled": true
        }"#;

        let config: SyncConfig = serde_json::from_str(old).unwrap();
        assert!(config.enabled, "still connected");
        assert!(config.auto, "and still on a timer");
    }

    /// The two are separate answers: connected, and running on its own. The
    /// whole point of the field is that the second can be no while the first
    /// is yes, so a round trip that quietly folded them together would undo it.
    #[test]
    fn connected_and_automatic_are_stored_apart() {
        let config = SyncConfig {
            enabled: true,
            auto: false,
            ..Default::default()
        };

        let text = serde_json::to_string(&config).unwrap();
        let read: SyncConfig = serde_json::from_str(&text).unwrap();

        assert!(read.enabled);
        assert!(!read.auto);
    }

    /// An outcome only ever travels outward, so the window can rely on the
    /// field being there — and on a pass that nobody stopped saying so.
    #[test]
    fn an_outcome_says_whether_it_was_stopped() {
        let text = serde_json::to_string(&SyncOutcome {
            pushed: 3,
            ..Default::default()
        })
        .unwrap();

        assert!(text.contains("\"stopped\":false"));
        assert!(text.contains("\"pushed\":3"));
    }

    /// Default is off for `enabled` and on for `auto`: a machine that has never
    /// connected anything syncs nothing, but the moment it connects, it keeps
    /// itself in step without anybody having to find the setting.
    #[test]
    fn a_fresh_config_is_not_connected_but_is_willing() {
        let config = SyncConfig::default();
        assert!(!config.enabled);
        assert!(config.auto);
    }
}

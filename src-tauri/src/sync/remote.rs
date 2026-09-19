//! The seam between the sync engine and whatever is holding the other copy.
//!
//! One implementation: Postgres, over the wire, wherever it is. There was a
//! second — a hosted project reached over its REST layer — and it went when
//! the plan settled on plain Postgres: any server reachable from this machine,
//! managed or not. A REST layer is a thing one vendor puts in front of a
//! database, and building against it meant building against that vendor.
//!
//! A newtype rather than a trait or an enum: it keeps the seam where it was,
//! so a second kind of remote is a change here and nowhere else, without
//! `async_trait`, a boxed future per call, or a lifetime through the worker.
//!
//! Everything below is request construction and response reading. Nothing here
//! decides anything: what to send is the worker's business, and which side wins
//! is `merge.rs`.

use super::rows::Row;
use super::{direct, SyncResult, SyncTable};

/// What a connection test found, for the modal to report.
#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub reachable: bool,
    /// Round trip in milliseconds.
    pub latency_ms: u64,
    /// Whether every table this needs is there.
    pub schema_ready: bool,
    /// The tables that are missing, so the message can name them.
    pub missing: Vec<String>,
    pub message: String,
}

/// Postgres, wherever it is: a server on this machine, one on the network, or
/// a managed one out on the internet. This app is trusted with the database it
/// is pointed at, which is why the panel says so in as many words.
pub struct Remote(pub direct::Direct);

impl Remote {
    /// Rows changed at or after `since`, oldest first.
    ///
    /// Inclusive rather than exclusive, and the watermark is the last
    /// *completed* pass's: a row written in the same millisecond as the
    /// watermark would otherwise never be seen again. Re-reading a row costs a
    /// comparison; missing one costs the row.
    pub async fn pull(&self, table: &SyncTable, since: i64, limit: usize) -> SyncResult<Vec<Row>> {
        self.0.pull(table, since, limit).await
    }

    /// Writes rows, and returns them as the remote stored them — which is where
    /// the server's `updated_at` comes from. That stamp is the whole basis of
    /// last-writer-wins, so it is read back rather than assumed.
    pub async fn push(&self, table: &SyncTable, rows: &[Row]) -> SyncResult<Vec<Row>> {
        self.0.push(table, rows).await
    }

    pub async fn probe(&self) -> Probe {
        self.0.probe().await
    }
}

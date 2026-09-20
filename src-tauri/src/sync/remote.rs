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

use tokio::sync::RwLock;

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
///
/// **It can open itself again.** A pass used to hold one connection from start
/// to finish and fail the whole thing if it dropped — and it drops for ordinary
/// reasons: a managed Postgres closing an idle connection, a laptop waking, a
/// network that moved. Every one of those surfaced as a sync error with a
/// timeout in it, for a condition that is fixed by dialling again. So the
/// connection lives behind a lock the operations can replace, and each one
/// retries itself once against a fresh connection before giving up.
///
/// The password is held for the life of the remote because reconnecting needs
/// it. It is already in memory for the first connection; what this changes is
/// how long, not whether.
pub struct Remote {
    direct: RwLock<direct::Direct>,
    config: direct::DirectConfig,
    password: String,
}

impl Remote {
    pub async fn connect(config: direct::DirectConfig, password: String) -> SyncResult<Self> {
        let direct = direct::Direct::connect(&config, &password).await?;
        Ok(Self {
            direct: RwLock::new(direct),
            config,
            password,
        })
    }

    /// Dials again, replacing the connection every later call will use.
    async fn reconnect(&self) -> SyncResult<()> {
        let fresh = direct::Direct::connect(&self.config, &self.password).await?;
        *self.direct.write().await = fresh;
        Ok(())
    }

    /// Whether the last failure was the connection going rather than the server
    /// objecting. Only the first is worth trying again: a statement the server
    /// refused will be refused just as fast the second time.
    async fn dropped(&self) -> bool {
        self.direct.read().await.is_closed()
    }

    /// Rows changed at or after `since`, oldest first.
    ///
    /// Inclusive rather than exclusive, and the watermark is the last
    /// *completed* pass's: a row written in the same millisecond as the
    /// watermark would otherwise never be seen again. Re-reading a row costs a
    /// comparison; missing one costs the row.
    pub async fn pull(&self, table: &SyncTable, since: i64, limit: usize) -> SyncResult<Vec<Row>> {
        match self.direct.read().await.pull(table, since, limit).await {
            Ok(rows) => return Ok(rows),
            Err(error) if !self.dropped().await => return Err(error),
            Err(_) => {}
        }
        self.reconnect().await?;
        self.direct.read().await.pull(table, since, limit).await
    }

    /// One page from every table in one round trip, which is what makes a pass
    /// that has nothing to do cost one wait instead of seven.
    pub async fn pull_many(
        &self,
        since: &[(&'static SyncTable, i64)],
        limit: usize,
    ) -> SyncResult<Vec<(&'static SyncTable, Row)>> {
        match self.direct.read().await.pull_many(since, limit).await {
            Ok(rows) => return Ok(rows),
            Err(error) if !self.dropped().await => return Err(error),
            Err(_) => {}
        }
        self.reconnect().await?;
        self.direct.read().await.pull_many(since, limit).await
    }

    /// Writes rows, and returns them as the remote stored them — which is where
    /// the server's `updated_at` comes from. That stamp is the whole basis of
    /// last-writer-wins, so it is read back rather than assumed.
    ///
    /// Safe to repeat: the statement is an upsert keyed on the row's own id, so
    /// a retry after a dropped connection writes the same rows to the same
    /// place rather than a second copy of them.
    pub async fn push(&self, table: &SyncTable, rows: &[Row]) -> SyncResult<Vec<Row>> {
        match self.direct.read().await.push(table, rows).await {
            Ok(stored) => return Ok(stored),
            Err(error) if !self.dropped().await => return Err(error),
            Err(_) => {}
        }
        self.reconnect().await?;
        self.direct.read().await.push(table, rows).await
    }

    pub async fn probe(&self) -> Probe {
        self.direct.read().await.probe().await
    }

    pub async fn migrate(&self) -> SyncResult<()> {
        self.direct.read().await.migrate().await
    }
}

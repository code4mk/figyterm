//! What every turn cost, written down at the time.
//!
//! `CODE-AGENT.md` puts this in phase 2, before the features, and the reason
//! is in one sentence: **cache discipline is invisible when it breaks.** An
//! agent whose prefix is being quietly invalidated looks exactly like one
//! whose prefix is not. It answers the same, it feels the same, and it costs
//! five times as much — and nobody finds out until the bill arrives, by
//! which point there is no way to tell which change did it.
//!
//! So: one row per turn, from the first turn, with the cached-read count in
//! it. A hit rate below ~70% across a long session with an unchanged prefix
//! is a bug to go and find, not a number to tune.
//!
//! The other reason it is early: it is the only honest way to compare two
//! designs. `$ per completed task` either side of a change to a tool's
//! output cap is the measurement that says whether the cap was worth it, and
//! it cannot be taken retrospectively.
//!
//! SQLite, in its own file beside the API client's. Not in `figyman.db`,
//! because that one is synced to a user's own Postgres and a token ledger is
//! nobody's business but this machine's.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::agent::message::Usage;

/// Where a turn happened, because the two surfaces will have very different
/// shapes and the comparison is how we find out whether the panel is paying
/// for itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    Window,
    Panel,
}

impl Surface {
    pub fn as_str(self) -> &'static str {
        match self {
            Surface::Window => "window",
            Surface::Panel => "panel",
        }
    }

    /// The other direction, for a row read back off disk.
    ///
    /// Anything unrecognised is the window, because a conversation that
    /// cannot be placed is better offered in the big surface than
    /// dropped — the column has no room to explain itself.
    pub fn parse(text: &str) -> Self {
        match text {
            "panel" => Surface::Panel,
            _ => Surface::Window,
        }
    }
}

/// One turn, as it is written down.
#[derive(Debug, Clone)]
pub struct TurnRecord {
    pub session_id: String,
    pub surface: Surface,
    pub turn: u32,
    pub model: String,
    pub usage: Usage,
    pub tool_calls: u32,
    /// What the tools themselves cost: Exa reports a price per call, and
    /// without this it is the one bill nobody can see.
    pub tool_cost_usd: f64,
    /// The biggest single tool result, in tokens. The early warning: a spike
    /// here is a tool misbehaving, and it shows up one turn after it starts
    /// rather than twenty.
    pub largest_tool_result: u32,
    pub wall_ms: u32,
}

/// What a model costs, per million tokens.
///
/// Carried as data rather than looked up, because the one thing certain
/// about a price table in a binary is that it is out of date. The window
/// shows what it was told; a wrong number here is a wrong number on screen,
/// not a wrong charge.
#[derive(Debug, Clone, Copy)]
pub struct Price {
    pub input: f64,
    pub cached_input: f64,
    pub output: f64,
}

impl Price {
    /// Dollars for one turn.
    ///
    /// Cached tokens are billed at their own rate and are **not** also
    /// billed at the full one — counting them twice overstates a
    /// well-cached session by about 10× at Anthropic's 0.1× read rate, which
    /// is precisely the session the cache was supposed to make cheap.
    pub fn cost(&self, usage: &Usage) -> f64 {
        let fresh = usage.input.saturating_sub(usage.cached) as f64;
        let cached = usage.cached as f64;
        let output = usage.output as f64;
        (fresh * self.input + cached * self.cached_input + output * self.output) / 1_000_000.0
    }
}

/// A session's running total, which is what the status bar shows.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub turns: u32,
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    pub cost_usd: f64,
    /// Spent by the tools rather than by the model — Exa, so far.
    pub tool_cost_usd: f64,
    /// 0–100. The honest health check on the whole caching strategy.
    pub hit_rate: u8,
    pub largest_tool_result: u32,
}

pub struct Ledger {
    connection: Mutex<Connection>,
}

impl Ledger {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        Self::from_connection(connection)
    }

    /// For tests, and for anything that wants a ledger that does not outlive
    /// the process.
    pub fn in_memory() -> Result<Self, String> {
        Self::from_connection(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE IF NOT EXISTS turns (
                   id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                   session_id          TEXT    NOT NULL,
                   surface             TEXT    NOT NULL,
                   turn                INTEGER NOT NULL,
                   model               TEXT    NOT NULL,
                   input_tokens        INTEGER NOT NULL,
                   cached_tokens       INTEGER NOT NULL,
                   output_tokens       INTEGER NOT NULL,
                   cost_usd            REAL    NOT NULL,
                   tool_calls          INTEGER NOT NULL,
                   tool_cost_usd       REAL    NOT NULL DEFAULT 0,
                   largest_tool_result INTEGER NOT NULL,
                   wall_ms             INTEGER NOT NULL,
                   at                  INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id);",
            )
            .map_err(|e| format!("The agent ledger would not open: {e}"))?;

        /*
          The column was added after the table existed.

          A migration rather than a schema bump because there is exactly
          one of them and the file is a local record, not something two
          machines have to agree about. The error when it is already there
          is the expected case and is dropped.
        */
        let _ = connection.execute(
            "ALTER TABLE turns ADD COLUMN tool_cost_usd REAL NOT NULL DEFAULT 0",
            [],
        );

        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn record(&self, record: &TurnRecord, price: Price) -> Result<f64, String> {
        let cost = price.cost(&record.usage);
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        connection
            .execute(
                "INSERT INTO turns (session_id, surface, turn, model, input_tokens,
                                    cached_tokens, output_tokens, cost_usd, tool_calls,
                                    largest_tool_result, wall_ms, at, tool_cost_usd)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    record.session_id,
                    record.surface.as_str(),
                    record.turn,
                    record.model,
                    record.usage.input,
                    record.usage.cached,
                    record.usage.output,
                    cost,
                    record.tool_calls,
                    record.largest_tool_result,
                    record.wall_ms,
                    now_ms(),
                    record.tool_cost_usd,
                ],
            )
            .map_err(|e| format!("The agent ledger would not write: {e}"))?;
        Ok(cost)
    }

    pub fn totals(&self, session_id: &str) -> Result<Totals, String> {
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let mut totals = connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(cached_tokens),0),
                        COALESCE(SUM(output_tokens),0), COALESCE(SUM(cost_usd),0),
                        COALESCE(MAX(largest_tool_result),0), COALESCE(SUM(tool_cost_usd),0)
                 FROM turns WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(Totals {
                        turns: row.get(0)?,
                        input: row.get(1)?,
                        cached: row.get(2)?,
                        output: row.get(3)?,
                        cost_usd: row.get(4)?,
                        tool_cost_usd: row.get(6)?,
                        hit_rate: 0,
                        largest_tool_result: row.get(5)?,
                    })
                },
            )
            .map_err(|e| format!("The agent ledger would not read: {e}"))?;

        totals.hit_rate = if totals.input == 0 {
            0
        } else {
            ((totals.cached as f64 / totals.input as f64) * 100.0).round() as u8
        };
        Ok(totals)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SONNET: Price = Price {
        input: 3.0,
        cached_input: 0.30,
        output: 15.0,
    };

    fn record(turn: u32, usage: Usage) -> TurnRecord {
        TurnRecord {
            session_id: "s1".into(),
            surface: Surface::Window,
            turn,
            model: "figy-pro".into(),
            usage,
            tool_calls: 2,
            tool_cost_usd: 0.0,
            largest_tool_result: 1200,
            wall_ms: 900,
        }
    }

    #[test]
    fn a_cached_token_is_billed_once_at_the_cached_rate() {
        // Billing it at both rates overstates a well-cached session roughly
        // tenfold — the exact session caching exists to make cheap.
        let usage = Usage { input: 1_000_000, output: 0, cached: 900_000 };
        // 100k fresh at $3 + 900k cached at $0.30 = 0.30 + 0.27
        assert!((SONNET.cost(&usage) - 0.57).abs() < 1e-9);
    }

    #[test]
    fn output_is_the_expensive_side_and_is_priced_as_such() {
        let usage = Usage { input: 0, output: 1_000_000, cached: 0 };
        assert!((SONNET.cost(&usage) - 15.0).abs() < 1e-9);
    }

    #[test]
    fn a_turn_with_no_usage_costs_nothing_rather_than_failing() {
        assert_eq!(SONNET.cost(&Usage::default()), 0.0);
    }

    #[test]
    fn more_cached_tokens_than_input_cannot_make_the_cost_negative() {
        // A provider reporting nonsense should produce a wrong number, not a
        // credit.
        let usage = Usage { input: 100, output: 0, cached: 900 };
        assert!(SONNET.cost(&usage) >= 0.0);
    }

    #[test]
    fn turns_add_up_into_the_number_the_status_bar_shows() {
        let ledger = Ledger::in_memory().unwrap();
        ledger
            .record(&record(1, Usage { input: 1000, output: 100, cached: 0 }), SONNET)
            .unwrap();
        ledger
            .record(&record(2, Usage { input: 3000, output: 100, cached: 2400 }), SONNET)
            .unwrap();

        let totals = ledger.totals("s1").unwrap();
        assert_eq!(totals.turns, 2);
        assert_eq!(totals.input, 4000);
        assert_eq!(totals.cached, 2400);
        assert_eq!(totals.hit_rate, 60);
        assert!(totals.cost_usd > 0.0);
        assert_eq!(totals.largest_tool_result, 1200);
    }

    #[test]
    fn one_session_does_not_see_another() {
        let ledger = Ledger::in_memory().unwrap();
        ledger
            .record(&record(1, Usage { input: 1000, output: 10, cached: 0 }), SONNET)
            .unwrap();
        let mut other = record(1, Usage { input: 9999, output: 10, cached: 0 });
        other.session_id = "s2".into();
        ledger.record(&other, SONNET).unwrap();

        assert_eq!(ledger.totals("s1").unwrap().input, 1000);
        assert_eq!(ledger.totals("s2").unwrap().input, 9999);
    }

    #[test]
    fn what_the_tools_spent_is_counted_apart_from_the_model() {
        // Exa bills per call. Folding it into the model's cost would make
        // a search-heavy session look like an expensive model.
        let ledger = Ledger::in_memory().unwrap();
        let mut turn = record(1, Usage { input: 100, output: 10, cached: 0 });
        turn.tool_cost_usd = 0.012;
        ledger.record(&turn, SONNET).unwrap();

        let totals = ledger.totals("s1").unwrap();
        assert!((totals.tool_cost_usd - 0.012).abs() < 1e-9);
        assert!(totals.cost_usd < 0.01, "the model's own cost is unchanged");
    }

    #[test]
    fn a_session_with_no_turns_reads_as_zero_rather_than_an_error() {
        let ledger = Ledger::in_memory().unwrap();
        let totals = ledger.totals("never-happened").unwrap();
        assert_eq!(totals.turns, 0);
        assert_eq!(totals.hit_rate, 0);
    }

    #[test]
    fn a_zero_hit_rate_across_a_long_session_is_visible() {
        // The whole reason the column exists: this is what a silently
        // invalidated prefix looks like, and it has to be readable at a
        // glance rather than inferred from the bill.
        let ledger = Ledger::in_memory().unwrap();
        for turn in 1..=20 {
            ledger
                .record(
                    &record(turn, Usage { input: 20_000, output: 300, cached: 0 }),
                    SONNET,
                )
                .unwrap();
        }
        let totals = ledger.totals("s1").unwrap();
        assert_eq!(totals.hit_rate, 0);
        assert_eq!(totals.turns, 20);
    }
}

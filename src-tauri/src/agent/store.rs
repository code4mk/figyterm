//! Conversations, written down so a restart does not end them.
//!
//! Sessions were a `HashMap` in `commands/agent.rs`. That is the right
//! place for the *live* one — it holds a shell, a bridge to the editor
//! and a cancel channel, none of which mean anything tomorrow — but it
//! meant that quitting the app in the middle of a long task threw away
//! the one thing in the session that was expensive to build: the
//! conversation itself. Forty turns of reading this codebase, gone, and
//! the next launch pays for all of it again.
//!
//! So this: one row per conversation, rewritten after every turn, in the
//! same SQLite file as the ledger. A separate connection rather than a
//! method on `Ledger`, because they answer different questions — the
//! ledger is an append-only record of what things cost and must never be
//! edited, and this is a mutable snapshot of right now.
//!
//! ## What is *not* in a row
//!
//! The root, the model and the messages are. The shell is not, the
//! language-server bridge is not, and the background jobs are not. A
//! resumed conversation is the text of one: the model is told what
//! happened, and whatever was running when the window closed is dead and
//! stays dead. Pretending otherwise — a resumed session that believes it
//! still has a `npm run dev` on port 1420 — would be worse than the
//! honest version, which is that the model reads what it did and looks
//! again if it needs to.
//!
//! ## And what it costs to come back
//!
//! Everything. The provider's cache is keyed on a prefix it saw minutes
//! ago, not days, so the first turn after a resume writes the whole
//! conversation again at full price. That is the price of the feature and
//! it is why resume is a thing you choose, from a list, rather than
//! something that happens to you on every launch.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::agent::ledger::Surface;
use crate::agent::message::{Message, Role};

/// A conversation, as it is kept between runs.
///
/// Everything a `Session` is apart from its collaborators: who it was
/// talking to, where, what was said, and the two running figures that
/// would otherwise reset to zero on the way back in.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub session_id: String,
    pub surface: Surface,
    /// The project it happened in, as the folder's path. What the list is
    /// filtered by: a conversation about another repository is noise.
    pub root: String,
    pub model: String,
    pub system: String,
    pub history: Vec<Message>,
    pub turn: u32,
    pub spent: f64,
    pub context_used: u32,
}

impl Snapshot {
    /// The first thing that was asked, as one line.
    ///
    /// The list needs a name and nobody is going to type one. The first
    /// user message is what the conversation was *for*, and it survives
    /// compaction, which keeps the first request at the front precisely
    /// so the model does not forget what it was doing either.
    pub fn title(&self) -> String {
        let first = self
            .history
            .iter()
            .find(|m| m.role == Role::User)
            .map(|m| m.content.as_str())
            .unwrap_or_default();
        let line = first
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("");
        if line.is_empty() {
            return "Untitled".into();
        }
        clip(line, TITLE_CHARS)
    }
}

/// Clipped on a character boundary, which a byte slice is not.
///
/// A prompt that opens in Bengali is one of the ones most worth being
/// able to find again, and `&line[..80]` panics in the middle of a
/// grapheme. Counting `char`s is not a grapheme count either, but it
/// cannot split one in half.
fn clip(line: &str, chars: usize) -> String {
    if line.chars().count() <= chars {
        return line.to_string();
    }
    let kept: String = line.chars().take(chars.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

const TITLE_CHARS: usize = 90;

/// One line in the resume list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub session_id: String,
    pub title: String,
    pub model: String,
    /// User messages, which is what "turns" means to a reader.
    pub turns: u32,
    /// Everything in the history, which is what it will cost to send.
    pub messages: u32,
    pub spent_usd: f64,
    /// Milliseconds since the epoch, formatted by the window in the
    /// user's own locale rather than guessed at here.
    pub updated_at: i64,
}

pub struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::from_connection(Connection::open(path).map_err(|e| e.to_string())?)
    }

    pub fn in_memory() -> Result<Self, String> {
        Self::from_connection(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE IF NOT EXISTS conversations (
                   session_id   TEXT    PRIMARY KEY,
                   surface      TEXT    NOT NULL,
                   root         TEXT    NOT NULL,
                   model        TEXT    NOT NULL,
                   title        TEXT    NOT NULL,
                   system       TEXT    NOT NULL,
                   history      TEXT    NOT NULL,
                   turn         INTEGER NOT NULL,
                   user_turns   INTEGER NOT NULL,
                   messages     INTEGER NOT NULL,
                   spent_usd    REAL    NOT NULL,
                   context_used INTEGER NOT NULL,
                   started_at   INTEGER NOT NULL,
                   updated_at   INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS conversations_by_root
                   ON conversations(root, surface, updated_at DESC);",
            )
            .map_err(|e| format!("The conversation store would not open: {e}"))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Writes the conversation as it stands, replacing the last copy.
    ///
    /// Called after every turn rather than at shutdown, because the case
    /// this exists for is the one where there is no shutdown: a crash, a
    /// force quit, a machine that went to sleep and did not come back.
    ///
    /// An empty history writes nothing. A conversation that was opened
    /// and never used is not one anybody wants to be offered.
    pub fn save(&self, snapshot: &Snapshot) -> Result<(), String> {
        if snapshot.history.is_empty() {
            return Ok(());
        }
        let history = serde_json::to_string(&snapshot.history).map_err(|e| e.to_string())?;
        let turns = snapshot
            .history
            .iter()
            .filter(|m| m.role == Role::User)
            .count() as u32;
        let now = now_ms();

        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        connection
            .execute(
                "INSERT INTO conversations
                   (session_id, surface, root, model, title, system, history,
                    turn, user_turns, messages, spent_usd, context_used,
                    started_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)
                 ON CONFLICT(session_id) DO UPDATE SET
                   model        = excluded.model,
                   title        = excluded.title,
                   history      = excluded.history,
                   turn         = excluded.turn,
                   user_turns   = excluded.user_turns,
                   messages     = excluded.messages,
                   spent_usd    = excluded.spent_usd,
                   context_used = excluded.context_used,
                   updated_at   = excluded.updated_at",
                params![
                    snapshot.session_id,
                    snapshot.surface.as_str(),
                    snapshot.root,
                    snapshot.model,
                    snapshot.title(),
                    snapshot.system,
                    history,
                    snapshot.turn,
                    turns,
                    snapshot.history.len() as u32,
                    snapshot.spent,
                    snapshot.context_used,
                    now,
                ],
            )
            .map_err(|e| format!("The conversation could not be saved: {e}"))?;
        Ok(())
    }

    /// The conversations in one project, newest first.
    ///
    /// Filtered by surface as well as root: the panel's three-message
    /// exchanges are not what somebody is looking for in the window's
    /// list, and offering them there would bury the one long task they
    /// actually want back.
    pub fn list(
        &self,
        root: &str,
        surface: Surface,
        limit: usize,
    ) -> Result<Vec<Conversation>, String> {
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT session_id, title, model, user_turns, messages, spent_usd, updated_at
                 FROM conversations
                 WHERE root = ?1 AND surface = ?2
                 ORDER BY updated_at DESC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![root, surface.as_str(), limit as i64], |row| {
                Ok(Conversation {
                    session_id: row.get(0)?,
                    title: row.get(1)?,
                    model: row.get(2)?,
                    turns: row.get(3)?,
                    messages: row.get(4)?,
                    spent_usd: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("The conversation list could not be read: {e}"))
    }

    /// One conversation, whole.
    ///
    /// A row whose history will not parse answers `None` rather than an
    /// error: the format changed under it, which is a conversation that
    /// cannot come back, not a store that is broken.
    pub fn load(&self, session_id: &str) -> Result<Option<Snapshot>, String> {
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        let row = connection
            .query_row(
                "SELECT session_id, surface, root, model, system, history,
                        turn, spent_usd, context_used
                 FROM conversations WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, u32>(6)?,
                        row.get::<_, f64>(7)?,
                        row.get::<_, u32>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("The conversation could not be read: {e}"))?;

        let Some((session_id, surface, root, model, system, history, turn, spent, context_used)) =
            row
        else {
            return Ok(None);
        };
        let Ok(history) = serde_json::from_str::<Vec<Message>>(&history) else {
            return Ok(None);
        };
        Ok(Some(Snapshot {
            session_id,
            surface: Surface::parse(&surface),
            root,
            model,
            system,
            history,
            turn,
            spent,
            context_used,
        }))
    }

    /// Removes one, for good.
    pub fn forget(&self, session_id: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|e| e.to_string())?;
        connection
            .execute(
                "DELETE FROM conversations WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|e| format!("The conversation could not be removed: {e}"))?;
        Ok(())
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
    use crate::agent::message::ToolCall;

    fn snapshot(id: &str, root: &str, history: Vec<Message>) -> Snapshot {
        Snapshot {
            session_id: id.into(),
            surface: Surface::Window,
            root: root.into(),
            model: "figy-pro".into(),
            system: "You are a coding agent.".into(),
            history,
            turn: 3,
            spent: 0.42,
            context_used: 18_000,
        }
    }

    #[test]
    fn a_conversation_comes_back_exactly_as_it_went_in() {
        let store = Store::in_memory().unwrap();
        let history = vec![
            Message::user("fix the build"),
            Message::assistant_calling(
                String::new(),
                vec![ToolCall {
                    id: "call_1".into(),
                    name: "read".into(),
                    // Raw, odd spacing and all: these bytes are in the
                    // cached prefix and must not be re-serialised.
                    arguments: "{\"path\":  \"src/main.rs\"}".into(),
                }],
            ),
            Message::tool_result("call_1", "fn main() {}"),
            Message::assistant("Found it."),
        ];
        store.save(&snapshot("s1", "/repo", history.clone())).unwrap();

        let back = store.load("s1").unwrap().expect("saved");
        assert_eq!(back.history, history);
        assert_eq!(back.turn, 3);
        assert_eq!(back.spent, 0.42);
        assert_eq!(back.context_used, 18_000);
        assert_eq!(back.system, "You are a coding agent.");
        assert_eq!(
            back.history[1].tool_calls[0].arguments,
            "{\"path\":  \"src/main.rs\"}",
            "the model's own bytes, not a round trip through serde_json::Value"
        );
    }

    #[test]
    fn saving_twice_updates_one_row_rather_than_making_two() {
        let store = Store::in_memory().unwrap();
        store
            .save(&snapshot("s1", "/repo", vec![Message::user("one")]))
            .unwrap();
        store
            .save(&snapshot(
                "s1",
                "/repo",
                vec![Message::user("one"), Message::assistant("two")],
            ))
            .unwrap();

        let list = store.list("/repo", Surface::Window, 10).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].messages, 2);
        assert_eq!(list[0].turns, 1, "turns counts what the user said");
    }

    #[test]
    fn the_list_is_this_project_and_this_surface_newest_first() {
        let store = Store::in_memory().unwrap();
        store
            .save(&snapshot("old", "/repo", vec![Message::user("first")]))
            .unwrap();
        store
            .save(&snapshot("new", "/repo", vec![Message::user("second")]))
            .unwrap();
        store
            .save(&snapshot("elsewhere", "/other", vec![Message::user("third")]))
            .unwrap();
        let mut panel = snapshot("panel", "/repo", vec![Message::user("fourth")]);
        panel.surface = Surface::Panel;
        store.save(&panel).unwrap();

        let list = store.list("/repo", Surface::Window, 10).unwrap();
        let ids: Vec<&str> = list.iter().map(|c| c.session_id.as_str()).collect();
        assert_eq!(ids.len(), 2, "not the other repo, and not the panel's");
        assert!(ids.contains(&"old") && ids.contains(&"new"));
        assert!(
            list[0].updated_at >= list[1].updated_at,
            "newest first, so the list opens on what was being worked on"
        );
    }

    #[test]
    fn a_conversation_nobody_used_is_not_offered() {
        let store = Store::in_memory().unwrap();
        store.save(&snapshot("empty", "/repo", Vec::new())).unwrap();
        assert!(store.list("/repo", Surface::Window, 10).unwrap().is_empty());
        assert!(store.load("empty").unwrap().is_none());
    }

    #[test]
    fn the_title_is_the_first_thing_that_was_asked() {
        let one = snapshot(
            "s1",
            "/repo",
            vec![
                Message::user("  make the composer\nsubmit on enter  "),
                Message::user("now the footer"),
            ],
        );
        assert_eq!(one.title(), "make the composer");
    }

    /// A prompt in Bengali is one of the ones most worth finding again,
    /// and a byte slice through it panics.
    #[test]
    fn a_long_title_in_a_non_latin_script_is_clipped_without_panicking() {
        let long = "আমাদের প্রজেক্টের ".repeat(20);
        let one = snapshot("s1", "/repo", vec![Message::user(long)]);
        let title = one.title();
        assert!(title.chars().count() <= TITLE_CHARS);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn forgetting_one_leaves_the_rest() {
        let store = Store::in_memory().unwrap();
        store
            .save(&snapshot("a", "/repo", vec![Message::user("one")]))
            .unwrap();
        store
            .save(&snapshot("b", "/repo", vec![Message::user("two")]))
            .unwrap();
        store.forget("a").unwrap();

        assert!(store.load("a").unwrap().is_none());
        assert_eq!(store.list("/repo", Surface::Window, 10).unwrap().len(), 1);
    }

    #[test]
    fn a_history_that_no_longer_parses_is_a_conversation_that_cannot_come_back() {
        let store = Store::in_memory().unwrap();
        store
            .save(&snapshot("s1", "/repo", vec![Message::user("one")]))
            .unwrap();
        store
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE conversations SET history = '{not an array}' WHERE session_id = 's1'",
                [],
            )
            .unwrap();
        assert!(store.load("s1").unwrap().is_none(), "None, not an error");
    }
}

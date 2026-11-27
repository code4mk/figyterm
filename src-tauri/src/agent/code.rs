//! Asking a language server, through the one that is already running.
//!
//! `docs/figy-code-plan/TOOLS.md` calls these the reason to build this agent
//! inside this app: Figylo hosts language servers, and no CLI agent does,
//! because warming one per invocation is not viable. `references` returning
//! the 7 real uses instead of grep's 200 textual hits is closer to a 30×
//! saving than a 2× one, on the operation an agent performs most often.
//!
//! ## Why this is a bridge and not a client
//!
//! The obvious implementation is an LSP client in Rust, next to the loop,
//! and it is the wrong one for a reason that has nothing to do with
//! architecture: **it would start a second `rust-analyzer`.** Gigabytes, and
//! thirty seconds of indexing before the first answer, on exactly the
//! projects where these tools matter — while an identical server sits warm
//! in the same process with the documents already open.
//!
//! So the tools ask the client that exists. It is in the frontend
//! (`src/services/lsp/manager.ts`, a module-level singleton for the same
//! reason: "two editor modals would otherwise each start one"), the request
//! goes out as an event, and the answer comes back through
//! `agent_lsp_reply`.
//!
//! The cost of that choice, stated plainly: these four tools need the
//! webview alive and the language-server switch on. Every one of them says
//! so when it is not, rather than failing in a way the model would retry.
//!
//! **The file's text travels with the request.** The frontend would
//! otherwise have to read it, and its filesystem commands are fenced by the
//! *editor's* roots — a folder the agent is working in that the editor has
//! never opened would simply not be readable. The agent already has the
//! file; sending it is one copy and no new permission.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// How long a request waits before giving up.
///
/// Generous, because the honest worst case is a cold `rust-analyzer` that
/// has not finished indexing and will answer properly in twenty seconds —
/// and a tool that gave up at two would send the model back to `grep` for
/// the rest of the session.
pub const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Definition,
    References,
    Diagnostics,
}

/// One question for the language server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub id: String,
    pub op: Op,
    /// Absolute, because the frontend hands it to the server as a URI.
    pub path: String,
    /// The file as the agent sees it. See the note above about roots.
    pub text: String,
    /// 1-based, as everything the model is shown is. The frontend converts.
    pub line: u32,
    pub column: u32,
}

/// What the tools call. A trait so they can be tested without a webview.
pub trait Lsp: Send + Sync {
    /// Blocking: the caller is on a blocking thread, by construction — see
    /// `session.rs`, which dispatches every tool through `spawn_blocking`.
    fn ask(&self, ask: Ask) -> Result<Value, String>;
}

/// The bridge to the window's client.
///
/// `emit` is a closure rather than a `Window` so this file does not depend
/// on Tauri and can be exercised in a test with a channel on the other end.
/// How a question gets to the window. A function rather than a `Window`,
/// so this file does not depend on Tauri and can be tested with a channel
/// on the other end.
type Emit = Box<dyn Fn(&Ask) -> Result<(), String> + Send + Sync>;

pub struct Bridge {
    emit: Emit,
    waiting: Mutex<HashMap<String, mpsc::SyncSender<Result<Value, String>>>>,
    next: AtomicU64,
    timeout: Duration,
}

impl Bridge {
    pub fn new(emit: impl Fn(&Ask) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self {
            emit: Box::new(emit),
            waiting: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            timeout: TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Hands an answer to whoever is waiting for it.
    ///
    /// An id nobody is waiting on is ignored rather than refused: the
    /// commonest cause is a reply arriving after its request timed out, and
    /// that is already reported at the other end.
    pub fn reply(&self, id: &str, result: Result<Value, String>) {
        let sender = self.waiting.lock().ok().and_then(|mut w| w.remove(id));
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }

    /// Nothing is waiting any more — the window went away mid-turn.
    pub fn abandon(&self) {
        if let Ok(mut waiting) = self.waiting.lock() {
            for (_, sender) in waiting.drain() {
                let _ = sender.send(Err("The window closed before the editor answered.".into()));
            }
        }
    }
}

impl Lsp for Bridge {
    fn ask(&self, mut ask: Ask) -> Result<Value, String> {
        let id = format!("lsp_{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        ask.id = id.clone();

        // A rendezvous channel: the slot is registered before the event goes
        // out, because a fast answer can arrive before `emit` returns.
        let (tx, rx) = mpsc::sync_channel(1);
        self.waiting
            .lock()
            .map_err(|_| "The editor bridge is unavailable".to_string())?
            .insert(id.clone(), tx);

        if let Err(error) = (self.emit)(&ask) {
            self.waiting.lock().ok().and_then(|mut w| w.remove(&id));
            return Err(error);
        }

        match rx.recv_timeout(self.timeout) {
            Ok(result) => result,
            Err(_) => {
                self.waiting.lock().ok().and_then(|mut w| w.remove(&id));
                Err(format!(
                    "the language server did not answer within {}s. It may still be \
                     indexing — grep works meanwhile.",
                    self.timeout.as_secs()
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn ask() -> Ask {
        Ask {
            id: String::new(),
            op: Op::Definition,
            path: "/p/src/main.rs".into(),
            text: "fn main() {}\n".into(),
            line: 1,
            column: 4,
        }
    }

    #[test]
    fn an_answer_reaches_the_caller() {
        // The reply arrives on another thread, as it does from a command.
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&seen);

        let bridge = Arc::new(Bridge::new(move |ask| {
            recorded.lock().unwrap().push(ask.id.clone());
            Ok(())
        }));

        let answerer = Arc::clone(&bridge);
        let seen_for_thread = Arc::clone(&seen);
        std::thread::spawn(move || loop {
            let id = seen_for_thread.lock().unwrap().first().cloned();
            if let Some(id) = id {
                answerer.reply(&id, Ok(json!({ "uri": "file:///p/src/lib.rs" })));
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        });

        let answer = bridge.ask(ask()).unwrap();
        assert_eq!(answer["uri"], "file:///p/src/lib.rs");
    }

    #[test]
    fn the_request_carries_an_id_the_reply_can_quote() {
        let seen: Arc<Mutex<Option<Ask>>> = Arc::new(Mutex::new(None));
        let recorded = Arc::clone(&seen);
        let bridge = Arc::new(
            Bridge::new(move |ask| {
                *recorded.lock().unwrap() = Some(ask.clone());
                Ok(())
            })
            .with_timeout(Duration::from_millis(50)),
        );

        let _ = bridge.ask(ask());
        let sent = seen.lock().unwrap().clone().unwrap();
        assert!(sent.id.starts_with("lsp_"));
        assert_eq!(sent.text, "fn main() {}\n");
        assert_eq!(sent.line, 1);
    }

    #[test]
    fn a_silent_editor_times_out_with_something_to_do_instead() {
        let bridge = Bridge::new(|_| Ok(())).with_timeout(Duration::from_millis(30));
        let error = bridge.ask(ask()).unwrap_err();
        assert!(error.contains("did not answer"));
        assert!(error.contains("grep"), "a dead end is worse than a slow answer");
    }

    #[test]
    fn a_failure_from_the_editor_comes_back_as_one() {
        let bridge = Arc::new(Bridge::new(|_| Ok(())).with_timeout(Duration::from_secs(5)));
        let answerer = Arc::clone(&bridge);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            answerer.reply("lsp_1", Err("no language server for .rs".into()));
        });
        assert_eq!(bridge.ask(ask()).unwrap_err(), "no language server for .rs");
    }

    #[test]
    fn an_event_that_cannot_be_sent_fails_at_once() {
        // No window: waiting thirty seconds to discover that helps nobody.
        let bridge = Bridge::new(|_| Err("no window".into()));
        assert_eq!(bridge.ask(ask()).unwrap_err(), "no window");
    }

    #[test]
    fn a_reply_nobody_is_waiting_for_is_dropped_quietly() {
        // A late answer to a request that already timed out.
        let bridge = Bridge::new(|_| Ok(()));
        bridge.reply("lsp_404", Ok(json!(null)));
    }

    #[test]
    fn abandoning_releases_every_waiting_call() {
        let bridge = Arc::new(Bridge::new(|_| Ok(())).with_timeout(Duration::from_secs(10)));
        let closer = Arc::clone(&bridge);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            closer.abandon();
        });
        assert!(bridge.ask(ask()).unwrap_err().contains("window closed"));
    }
}

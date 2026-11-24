//! Asking the person a question, and waiting for the answer.
//!
//! `TOOLS.md`: **`ask_user` must be structured.** A model that asks a
//! question in prose gets answered in prose, which is a turn — the run
//! ends, the person reads a paragraph, types a reply, and the whole
//! conversation is re-sent so the model can carry on from where it was
//! standing. A model that asks with three options gets answered with a
//! number, inside the turn it was already running, and nothing is
//! re-sent at all.
//!
//! The other half of it is that prose questions do not read as questions.
//! "I could add the field to the response type, though that would change
//! the public API" is a model thinking out loud, and it is answered by
//! being ignored about half the time.
//!
//! ## The same shape as the language-server bridge
//!
//! This is `code.rs` with a person on the other end: the question goes out
//! as an event, the tool blocks on a rendezvous channel, and a command
//! hands the answer back. It is a separate type rather than a generic one
//! because the two differ in the thing that matters — a language server
//! that has not answered in thirty seconds is broken, and a person who has
//! not answered in thirty seconds is reading.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::Serialize;

/// How long a question waits before giving up on being answered.
///
/// Long, because the honest case is somebody who went to look at the code
/// before deciding. It is a backstop against a leaked thread, not a
/// deadline: the person's real way out is Escape, which cancels the turn
/// and releases this with it.
pub const TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// One question for the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub question: String,
    /// What they can pick. The window numbers them and adds its own way
    /// out, so this is only what the model offered.
    pub options: Vec<String>,
}

/// What the tool calls. A trait so it can be tested without a webview.
pub trait Asker: Send + Sync {
    /// Blocking: tools are dispatched on a blocking thread by
    /// construction — see `session.rs`.
    ///
    /// The answer is the option as the person picked it, or whatever the
    /// window sent in its place when they declined all of them.
    fn ask(&self, question: Question) -> Result<String, String>;
}

type Emit = Box<dyn Fn(&Question) -> Result<(), String> + Send + Sync>;

pub struct Desk {
    emit: Emit,
    waiting: Mutex<HashMap<String, mpsc::SyncSender<String>>>,
    next: AtomicU64,
    timeout: Duration,
}

impl Desk {
    pub fn new(emit: impl Fn(&Question) -> Result<(), String> + Send + Sync + 'static) -> Self {
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
    /// An id nobody is waiting on is ignored: the commonest cause is a
    /// card answered just after its turn was cancelled, and there is
    /// nothing left to tell.
    pub fn answer(&self, id: &str, answer: String) {
        let sender = self.waiting.lock().ok().and_then(|mut w| w.remove(id));
        if let Some(sender) = sender {
            let _ = sender.send(answer);
        }
    }

    /// Nothing is waiting any more — the turn was cancelled, or the
    /// window went away.
    pub fn abandon(&self) {
        if let Ok(mut waiting) = self.waiting.lock() {
            for (_, sender) in waiting.drain() {
                let _ = sender.send(ABANDONED.to_string());
            }
        }
    }
}

/// What a tool reads when its question will never be answered.
///
/// A sentence rather than an error, because the turn is usually ending
/// anyway and a model that is told plainly stops rather than retrying.
pub const ABANDONED: &str = "(the question was dismissed and no answer was given)";

impl Asker for Desk {
    fn ask(&self, mut question: Question) -> Result<String, String> {
        let id = format!("ask_{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        question.id = id.clone();

        // Registered before the event goes out: an answer can arrive
        // before `emit` has returned.
        let (tx, rx) = mpsc::sync_channel(1);
        self.waiting
            .lock()
            .map_err(|_| "The window cannot be asked anything right now.".to_string())?
            .insert(id.clone(), tx);

        if let Err(error) = (self.emit)(&question) {
            self.waiting.lock().ok().and_then(|mut w| w.remove(&id));
            return Err(error);
        }

        match rx.recv_timeout(self.timeout) {
            Ok(answer) => Ok(answer),
            Err(_) => {
                self.waiting.lock().ok().and_then(|mut w| w.remove(&id));
                Ok(format!(
                    "(nobody answered within {} minutes)",
                    self.timeout.as_secs() / 60
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn question() -> Question {
        Question {
            id: String::new(),
            question: "Which one?".into(),
            options: vec!["this".into(), "that".into()],
        }
    }

    #[test]
    fn an_answer_reaches_the_caller() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&seen);
        let desk = Arc::new(Desk::new(move |q| {
            recorded.lock().unwrap().push(q.id.clone());
            Ok(())
        }));

        let answerer = Arc::clone(&desk);
        let ids = Arc::clone(&seen);
        std::thread::spawn(move || loop {
            if let Some(id) = ids.lock().unwrap().first().cloned() {
                answerer.answer(&id, "that".into());
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        });

        assert_eq!(desk.ask(question()).unwrap(), "that");
    }

    /// Escape cancels the turn, and the question has to come back with it
    /// — a tool thread parked on a card nobody can see any more is a turn
    /// that never ends.
    #[test]
    fn a_dismissed_question_releases_the_tool() {
        let desk = Arc::new(Desk::new(|_| Ok(())));
        let other = Arc::clone(&desk);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            other.abandon();
        });
        assert_eq!(desk.ask(question()).unwrap(), ABANDONED);
    }

    #[test]
    fn a_window_that_cannot_be_reached_is_an_error_not_a_wait() {
        let desk = Desk::new(|_| Err("the window has gone".into()));
        assert!(desk.ask(question()).is_err());
    }

    #[test]
    fn nobody_answering_is_said_plainly_rather_than_waited_on_for_ever() {
        let desk = Desk::new(|_| Ok(())).with_timeout(Duration::from_millis(20));
        assert!(desk.ask(question()).unwrap().contains("nobody answered"));
    }
}

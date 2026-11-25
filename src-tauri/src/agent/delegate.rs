//! A sub-agent: a whole conversation that happens inside one tool call.
//!
//! `TOOLS.md` calls this **the cost lever hiding in group E**, and the
//! arithmetic is the clearest in the whole document. "Which file handles
//! the retry, and does it respect the timeout?" is answered by reading
//! twenty files and returning one sentence. Asked on the main thread,
//! those twenty files enter the prefix and are re-sent on every turn for
//! the rest of the session. Asked here, they enter a context that is
//! thrown away, and what comes back is the sentence.
//!
//! The same document names the other half: this is **the only safe place
//! for a cheaper model**. It is off the main thread, so it forfeits no
//! cache — the parent's prefix is untouched while it runs. That is not
//! wired up yet; the sub-agent uses the one provider there is.
//!
//! ## What it is allowed to do
//!
//! Read, and nothing else. `tools::SUB_TOOLS` is the list and it is read
//! only on purpose:
//!
//! - **Nothing it changes could be reviewed.** Its conversation is
//!   discarded, so an edit it made would appear in the parent's history
//!   as a sentence claiming an edit was made, with no diff, no path and
//!   no row in the transcript to open.
//! - **Nobody can be asked.** `ask_user` and `plan` put a card on screen
//!   and wait; a card from a conversation the person cannot see is a card
//!   they cannot answer.
//! - **No `task`.** A sub-agent that can spawn one is a tree with no
//!   bottom and a bill with no ceiling.
//!
//! ## What it costs, and who pays
//!
//! Its turns are written to the same ledger under the parent's session
//! id, so `/usage` counts them. Its total comes back as `costUsd` on the
//! tool result, which is the hook `session.rs` already reads for Exa — so
//! the parent's budget covers a sub-agent, and a runaway one trips the
//! same ceiling rather than a separate invisible one.
//!
//! **It cannot be interrupted.** The tool is synchronous by construction;
//! Escape cancels the parent's turn and this keeps going underneath it.
//! The step limit is the whole of the protection, which is why it is low.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::agent::ledger::{Ledger, Price, Surface};
use crate::agent::message::ToolCall;
use crate::agent::policy::Mode;
use crate::agent::provider::Provider;
use crate::agent::session::{BoxFuture, Approver, Pick, Picker, Session, SessionConfig, Turn};
use crate::agent::tools::{self, ToolContext};

/// Short, because nothing can interrupt it.
///
/// A sub-task that has not answered in twelve round trips is not about
/// to: it is lost, and the honest thing is to hand back what it has and
/// let the model that asked decide.
pub const MAX_STEPS: usize = 12;

/// What a sub-agent came back with.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub answer: String,
    pub cost_usd: f64,
}

/// What the `task` tool calls. A trait so the tool can be tested with a
/// scripted one rather than a provider.
pub trait Delegate: Send + Sync {
    /// Blocking: tools are dispatched on a blocking thread.
    fn run(&self, prompt: &str) -> Result<Outcome, String>;
}

/// The preamble a sub-agent is given.
///
/// Frozen, like every other one, and short for a reason that is not
/// style: a sub-agent's whole value is the ratio between what it reads
/// and what it says, and half of that is telling it plainly that a
/// paragraph is the deliverable.
pub const SUB_SYSTEM: &str = "\
You are a sub-agent inside FigyCode, answering one question for the agent that \
called you. You can read the project — files, searches, the language server — \
and you cannot change anything or ask anyone a question.

Answer in a few hundred words at most. What you read is thrown away when you \
finish; only your answer is kept, so it has to stand on its own. Name files and \
lines exactly, say what you did not manage to find out, and do not describe how \
you looked.";

/// Hands the model only what a sub-agent may use.
struct ReadOnly;

impl Picker for ReadOnly {
    fn tools_for<'a>(&'a self, _prompt: &'a str) -> BoxFuture<'a, Pick> {
        Box::pin(async {
            Pick::free(tools::SUB_TOOLS.iter().map(|name| name.to_string()).collect())
        })
    }
}

/// Says no, because nobody is there to say yes.
///
/// With a read-only tool set nothing should ever reach it. It exists so
/// that a tool added to `SUB_TOOLS` carelessly is refused rather than
/// silently allowed.
struct NobodyHome;

impl Approver for NobodyHome {
    async fn approve(&self, _call: &ToolCall, _arguments: &Value) -> bool {
        false
    }

    fn remembered(&self, _key: &str) -> bool {
        false
    }
}

/// A sub-agent that runs against the same provider as its parent.
pub struct SubAgent<P: Provider> {
    handle: tokio::runtime::Handle,
    provider: Arc<P>,
    /// The parent's, so a sub-agent's turns land in the same `/usage`.
    session_id: String,
    surface: Surface,
    model: String,
    price: Price,
    context_window: Option<u32>,
    /// The parent's ceiling, applied again here. Not the parent's
    /// *remaining* budget, which the tool has no way to know — a looser
    /// bound than the ideal one, and still a bound.
    budget_usd: Option<f64>,
    ledger: Option<Arc<Ledger>>,
    /// Built fresh per run: the sub-agent gets the project and the
    /// language server, never the shell and never the person.
    root: std::path::PathBuf,
    lsp: Option<Arc<dyn crate::agent::code::Lsp>>,
}

impl<P: Provider> SubAgent<P> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        handle: tokio::runtime::Handle,
        provider: Arc<P>,
        session_id: String,
        surface: Surface,
        model: String,
        price: Price,
        root: std::path::PathBuf,
    ) -> Self {
        Self {
            handle,
            provider,
            session_id,
            surface,
            model,
            price,
            context_window: None,
            budget_usd: None,
            ledger: None,
            root,
            lsp: None,
        }
    }

    pub fn with_limits(mut self, context_window: Option<u32>, budget_usd: Option<f64>) -> Self {
        self.context_window = context_window;
        self.budget_usd = budget_usd;
        self
    }

    pub fn with_ledger(mut self, ledger: Option<Arc<Ledger>>) -> Self {
        self.ledger = ledger;
        self
    }

    pub fn with_lsp(mut self, lsp: Arc<dyn crate::agent::code::Lsp>) -> Self {
        self.lsp = Some(lsp);
        self
    }
}

impl<P: Provider> Delegate for SubAgent<P> {
    fn run(&self, prompt: &str) -> Result<Outcome, String> {
        let mut session = Session::new(
            SessionConfig {
                session_id: self.session_id.clone(),
                surface: self.surface,
                model: self.model.clone(),
                price: self.price,
                // Read-only tools, so the mode decides nothing. `Plan`
                // rather than `Ask` anyway: if something that writes
                // ever reaches this list, the mode refuses it with an
                // explanation instead of hanging on an approver that
                // always says no.
                mode: Mode::Plan,
                context_window: self.context_window,
                budget_usd: self.budget_usd,
                max_steps: Some(MAX_STEPS),
            },
            SUB_SYSTEM,
        );

        let mut ctx = ToolContext::new(self.root.clone());
        if let Some(lsp) = &self.lsp {
            ctx = ctx.with_lsp(Arc::clone(lsp));
        }

        /*
          The events go nowhere.

          A sub-agent's tool calls interleaved into the parent's
          transcript would read as the parent doing them, which is the
          one thing this is not. What the window sees is the row for the
          `task` call itself, open to its answer.
        */
        let (events, _dropped) = tokio::sync::mpsc::unbounded_channel();
        let (_never, cancel) = oneshot::channel();

        let result = self.handle.block_on(session.send(
            prompt,
            // A sub-agent is handed a question, never a picture: what
            // it reads is thrown away, and an image that reached it
            // would be paid for and then discarded unseen.
            Vec::new(),
            Turn {
                provider: self.provider.as_ref(),
                picker: &ReadOnly,
                approver: &NobodyHome,
                ctx: &ctx,
                ledger: self.ledger.as_deref(),
            },
            events,
            cancel,
        ));
        result?;

        let answer = session
            .history()
            .iter()
            .rev()
            .find(|message| {
                message.role == crate::agent::message::Role::Assistant
                    && !message.content.trim().is_empty()
            })
            .map(|message| message.content.trim().to_string())
            .unwrap_or_default();

        if answer.is_empty() {
            return Err(
                "the sub-agent stopped without an answer — ask it something narrower, \
                 or look yourself"
                    .into(),
            );
        }

        Ok(Outcome {
            answer,
            cost_usd: session.spent(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::message::Usage;
    use crate::agent::provider::{Completion, StreamEvent, TurnRequest};
    use std::sync::Mutex;
    use tokio::sync::mpsc::UnboundedSender;

    /// A provider that answers from a script and records what it was
    /// offered, which is how the tool set is checked.
    struct Scripted {
        answers: Mutex<Vec<Completion>>,
        tools: Mutex<Vec<Value>>,
    }

    impl Provider for Scripted {
        async fn complete(
            &self,
            request: TurnRequest,
            _events: UnboundedSender<StreamEvent>,
            _cancel: oneshot::Receiver<()>,
        ) -> Result<Completion, String> {
            self.tools.lock().unwrap().push(request.tools);
            let mut answers = self.answers.lock().unwrap();
            if answers.is_empty() {
                return Ok(Completion {
                    content: "done".into(),
                    finish_reason: "stop".into(),
                    ..Completion::default()
                });
            }
            Ok(answers.remove(0))
        }
    }

    fn said(text: &str) -> Completion {
        Completion {
            content: text.into(),
            tool_calls: Vec::new(),
            usage: Usage { input: 4000, output: 100, cached: 0 },
            finish_reason: "stop".into(),
        }
    }

    fn sub(provider: Arc<Scripted>) -> SubAgent<Scripted> {
        SubAgent::new(
            tokio::runtime::Handle::current(),
            provider,
            "s1".into(),
            Surface::Window,
            "test".into(),
            Price { input: 3.0, cached_input: 0.3, output: 15.0 },
            std::env::temp_dir(),
        )
    }

    /// Blocking, inside a runtime, which is how a tool calls it.
    async fn run_on_a_blocking_thread(
        agent: SubAgent<Scripted>,
        prompt: &'static str,
    ) -> Result<Outcome, String> {
        tokio::task::spawn_blocking(move || agent.run(prompt))
            .await
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn what_comes_back_is_the_answer_and_what_it_cost() {
        let provider = Arc::new(Scripted {
            answers: Mutex::new(vec![said("`src/net/api.rs:88` ignores the timeout.")]),
            tools: Mutex::new(Vec::new()),
        });
        let outcome = run_on_a_blocking_thread(sub(Arc::clone(&provider)), "where are retries?")
            .await
            .unwrap();

        assert_eq!(outcome.answer, "`src/net/api.rs:88` ignores the timeout.");
        assert!(
            outcome.cost_usd > 0.0,
            "it reaches the parent's budget as the tool's own charge"
        );
    }

    /// The whole argument for a sub-agent is that it cannot change
    /// anything, because nothing it changed could be reviewed.
    #[tokio::test(flavor = "multi_thread")]
    async fn it_is_offered_nothing_that_writes_runs_asks_or_delegates() {
        let provider = Arc::new(Scripted {
            answers: Mutex::new(vec![said("nothing to report")]),
            tools: Mutex::new(Vec::new()),
        });
        run_on_a_blocking_thread(sub(Arc::clone(&provider)), "have a look")
            .await
            .unwrap();

        let offered = provider.tools.lock().unwrap()[0].clone();
        let names: Vec<String> = offered
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
            .collect();

        assert!(names.contains(&"read".to_string()));
        assert!(names.contains(&"grep".to_string()));
        for forbidden in ["edit", "write", "bash", "git_commit", "ask_user", "plan", "task"] {
            assert!(
                !names.contains(&forbidden.to_string()),
                "a sub-agent must not be offered {forbidden}"
            );
        }
    }

    /// A model that stops without saying anything has not answered, and
    /// an empty tool result is worse than a sentence saying so.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_sub_agent_that_says_nothing_is_an_error_rather_than_an_empty_answer() {
        let provider = Arc::new(Scripted {
            answers: Mutex::new(vec![said("   ")]),
            tools: Mutex::new(Vec::new()),
        });
        let error = run_on_a_blocking_thread(sub(provider), "look into it")
            .await
            .unwrap_err();
        assert!(error.contains("without an answer"));
    }
}

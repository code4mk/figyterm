//! The turn loop.
//!
//! Ask the model. If it asked for tools, run them and ask again. Stop when
//! it stops asking. Everything else in this file is about the three ways
//! that goes wrong: the prefix changing underneath the cache, a tool running
//! that should have been asked about, and a loop that will not end.
//!
//! ## The prefix is frozen, and that is a decision with teeth
//!
//! Order on the wire is `tools → system → messages`, and caching is a prefix
//! match: any byte that changes invalidates everything after it. So the
//! system prompt is built **once**, at session start, and may not contain a
//! timestamp, a branch name, a `cwd` or anything else that moves. Those
//! facts go in the first user message, after the breakpoint, where changing
//! them costs one message instead of the whole session.
//!
//! This is easy to get wrong in a desktop app, where the workspace, the
//! branch and the open file are all right there and tempting. [`Session`]
//! stores the system prompt as a `String` built in `new` and has no method
//! that touches it afterwards.
//!
//! ## History is append-only
//!
//! Nothing rewrites an earlier message. Not to tidy a tool result, not to
//! renumber an id, not to compact — compaction, when it arrives, replaces a
//! *prefix* once and deliberately, and pays for the rewrite knowingly.
//!
//! ## Where tool picking plugs in
//!
//! [`Picker`] is the seam. The default hands the model every tool and lets
//! it choose, which is what an OpenAI-compatible endpoint does natively.
//! A router — typesafe.ai — implements the same trait and chooses on the
//! model's behalf.
//!
//! **The warning that belongs with that:** a picker that narrows the tool
//! list per turn changes the first bytes of the request, which is the worst
//! possible place to change bytes. Either it narrows once per session, or
//! the cache saving it is competing with is larger than the routing saving
//! it is buying. Measure it with the ledger before believing otherwise.

use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc::UnboundedSender, oneshot};

use crate::agent::ledger::{Ledger, Price, Surface, TurnRecord};
use crate::agent::message::{Message, ToolCall};
use crate::agent::policy::{approval_key, decide, Decision, Mode};
use crate::agent::provider::{Provider, StreamEvent, TurnRequest, CANCELLED};
use crate::agent::tools::{self, output::approx_tokens, ToolContext};

/// How many model round trips one user message may take.
///
/// Not a safety rail so much as a bill rail: an agent looping on a test it
/// cannot fix spends real money fast, and "a few cents a turn" stops being
/// true at turn two hundred. Hit it and the user is told, with the work so
/// far intact.
const MAX_STEPS: usize = 40;

/// Decides which tools the model is offered for a turn.
pub trait Picker: Send + Sync {
    /// The tool definitions to send. See the warning in the module docs
    /// about narrowing this per turn.
    fn tools_for(&self, prompt: &str) -> Value;
}

/// Every tool, every turn. The cache-stable default.
pub struct OfferEverything;

impl Picker for OfferEverything {
    fn tools_for(&self, _prompt: &str) -> Value {
        tools::openai_tools()
    }
}

/// What the window is told as a turn proceeds.
///
/// A superset of the provider's stream: the provider knows about text and
/// tool calls, and only the loop knows what a tool *returned*, what was
/// refused, and what the turn cost.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnEvent {
    Text {
        text: String,
    },
    ToolStarted {
        id: String,
        name: String,
    },
    ToolFinished {
        id: String,
        name: String,
        text: String,
        detail: Option<Value>,
        /// What this result will cost on every remaining turn of the
        /// session, which is the number that makes a bad tool obvious.
        tokens: usize,
    },
    ToolFailed {
        id: String,
        name: String,
        error: String,
    },
    /// A tool the mode would not allow. Not a failure — an answer.
    ToolRefused {
        id: String,
        name: String,
        reason: String,
    },
    /// A tool that needs the user, before it can run.
    NeedsApproval {
        id: String,
        name: String,
        arguments: Value,
    },
    Turn {
        input: u32,
        cached: u32,
        output: u32,
        cost_usd: f64,
        hit_rate: u8,
    },
    Finished {
        reason: String,
    },
    Failed {
        error: String,
    },
}

/// Answers "may this run?" — the window, or a test.
///
/// `approve` is a future because the real implementation is a person: the
/// window draws the permission card and the loop waits, for as long as it
/// takes. A synchronous version of this trait would have forced the answer
/// to be known in advance, which is the one thing it never is.
pub trait Approver: Send + Sync {
    /// Called only when the policy says to ask. `true` runs it.
    fn approve(
        &self,
        call: &ToolCall,
        arguments: &Value,
    ) -> impl std::future::Future<Output = bool> + Send;
    /// Whether this command has already been approved for the session.
    fn remembered(&self, key: &str) -> bool;
}

/// Everything a turn needs that is not the conversation.
///
/// Grouped rather than passed as five more arguments, and the grouping says
/// something true: these are the four collaborators a turn is run *against*
/// — where the model is, which tools it may see, who answers for the user,
/// and which folder it all happens in. Swapping any of them is how this is
/// tested.
pub struct Turn<'a, P: Provider, K: Picker, A: Approver> {
    pub provider: &'a P,
    pub picker: &'a K,
    pub approver: &'a A,
    pub ctx: &'a ToolContext,
    pub ledger: Option<&'a Ledger>,
}

/// What a session needs to know that is not the conversation.
pub struct SessionConfig {
    pub session_id: String,
    pub surface: Surface,
    pub model: String,
    pub price: Price,
    pub mode: Mode,
}

pub struct Session {
    config: SessionConfig,
    /// Built once. Nothing in this file writes to it again — see the module
    /// docs on the frozen prefix.
    system: String,
    history: Vec<Message>,
    turn: u32,
}

impl Session {
    /// `system` is frozen here. Volatile facts — the branch, the time, the
    /// open file — belong in the first user message instead.
    pub fn new(config: SessionConfig, system: impl Into<String>) -> Self {
        Self {
            config,
            system: system.into(),
            history: Vec::new(),
            turn: 0,
        }
    }

    pub fn history(&self) -> &[Message] {
        &self.history
    }

    /// What the ledger's rows are keyed by.
    pub fn id(&self) -> &str {
        &self.config.session_id
    }

    /// The messages for a request: the frozen system prompt, then everything
    /// that has happened, in order, unmodified.
    fn messages(&self) -> Vec<Message> {
        let mut out = Vec::with_capacity(self.history.len() + 1);
        out.push(Message::system(self.system.clone()));
        out.extend(self.history.iter().cloned());
        out
    }

    /// One user message, carried to the end of whatever it sets off.
    ///
    /// Returns when the model stops asking for tools, the step limit is
    /// reached, the user cancels, or the provider fails. Every exit leaves
    /// the history consistent: a tool call in it always has its result after
    /// it, because a dangling call is a request every later turn rejects.
    pub async fn send(
        &mut self,
        prompt: &str,
        turn: Turn<'_, impl Provider, impl Picker, impl Approver>,
        events: UnboundedSender<TurnEvent>,
        mut cancel: oneshot::Receiver<()>,
    ) -> Result<(), String> {
        let Turn { provider, picker, approver, ctx, ledger } = turn;
        self.history.push(Message::user(prompt));
        let tools = picker.tools_for(prompt);

        for step in 0..MAX_STEPS {
            self.turn += 1;
            let started = Instant::now();

            // The provider's events are forwarded as the loop's own, so the
            // window has one stream to render rather than two to interleave.
            let (raw, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
            let forward = events.clone();
            let pump = tokio::spawn(async move {
                while let Some(event) = rx.recv().await {
                    let out = match event {
                        StreamEvent::Text { text } => Some(TurnEvent::Text { text }),
                        StreamEvent::ToolCallStarted { id, name } => {
                            Some(TurnEvent::ToolStarted { id, name })
                        }
                        StreamEvent::Done { .. } => None,
                    };
                    if let Some(out) = out {
                        let _ = forward.send(out);
                    }
                }
            });

            let (inner_cancel, inner_rx) = oneshot::channel();
            let request = TurnRequest {
                messages: self.messages(),
                tools: tools.clone(),
            };

            let outcome = tokio::select! {
                biased;
                _ = &mut cancel => {
                    let _ = inner_cancel.send(());
                    Err(CANCELLED.to_string())
                }
                result = provider.complete(request, raw, inner_rx) => result,
            };
            pump.abort();

            let completion = match outcome {
                Ok(completion) => completion,
                Err(error) => {
                    let _ = events.send(TurnEvent::Failed {
                        error: error.clone(),
                    });
                    return Err(error);
                }
            };

            // Measured around the model call alone. Mixing the tools' time
            // into it would hide which half of a slow turn was slow, and
            // they are slow for entirely different reasons.
            let model_ms = started.elapsed().as_millis() as u32;

            if completion.tool_calls.is_empty() {
                self.record(ledger, &completion, model_ms, 0, &events);
                self.history.push(Message::assistant(completion.content));
                let _ = events.send(TurnEvent::Finished {
                    reason: completion.finish_reason,
                });
                return Ok(());
            }

            self.history.push(Message::assistant_calling(
                completion.content.clone(),
                completion.tool_calls.clone(),
            ));

            let mut biggest = 0u32;
            for call in &completion.tool_calls {
                if cancel.try_recv().is_ok() {
                    // Still answered, so the history has no dangling call.
                    self.history
                        .push(Message::tool_result(&call.id, "Interrupted by the user."));
                    self.record(ledger, &completion, model_ms, biggest, &events);
                    let _ = events.send(TurnEvent::Failed {
                        error: CANCELLED.into(),
                    });
                    return Err(CANCELLED.into());
                }

                let text = self.run(call, approver, ctx, &events).await;
                biggest = biggest.max(approx_tokens(&text) as u32);
                self.history.push(Message::tool_result(&call.id, text));
            }

            /*
              Written once the results are in, because `largest_tool_result`
              is the early warning this row exists for — a spike in it is a
              tool misbehaving, and it is only knowable after the tools have
              run.
            */
            self.record(ledger, &completion, model_ms, biggest, &events);

            if step + 1 == MAX_STEPS {
                let note = format!(
                    "Stopped after {MAX_STEPS} steps without finishing. The work so far is \
                     kept — say what to do next."
                );
                self.history.push(Message::assistant(note.clone()));
                let _ = events.send(TurnEvent::Finished {
                    reason: "step_limit".into(),
                });
                return Ok(());
            }
        }
        Ok(())
    }

    /// One tool call: the policy, then the tool, then the event.
    ///
    /// Every path returns a string for the history, including the refusals
    /// and the failures. A tool call with no result is a malformed
    /// conversation that the next request rejects outright, so "nothing
    /// happened" still has to be said out loud.
    async fn run(
        &self,
        call: &ToolCall,
        approver: &impl Approver,
        ctx: &ToolContext,
        events: &UnboundedSender<TurnEvent>,
    ) -> String {
        let arguments = match call.parsed() {
            Ok(value) => value,
            Err(error) => {
                let _ = events.send(TurnEvent::ToolFailed {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    error: error.clone(),
                });
                return error;
            }
        };

        let Some(spec) = tools::specs().into_iter().find(|s| s.name == call.name) else {
            let error = format!("no tool called `{}`", call.name);
            let _ = events.send(TurnEvent::ToolFailed {
                id: call.id.clone(),
                name: call.name.clone(),
                error: error.clone(),
            });
            return error;
        };

        let command = arguments.get("cmd").and_then(Value::as_str);
        let key = approval_key(spec.name, command);
        match decide(self.config.mode, spec.class, approver.remembered(&key)) {
            Decision::Allow => {}
            Decision::Refuse(why) => {
                let _ = events.send(TurnEvent::ToolRefused {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    reason: why.clone(),
                });
                return why;
            }
            Decision::Ask => {
                let _ = events.send(TurnEvent::NeedsApproval {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: arguments.clone(),
                });
                if !approver.approve(call, &arguments).await {
                    let refused =
                        "The user declined this. Ask what to do instead, or try another way."
                            .to_string();
                    let _ = events.send(TurnEvent::ToolRefused {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        reason: refused.clone(),
                    });
                    return refused;
                }
            }
        }

        match tools::call(ctx, &call.name, &arguments) {
            Ok(out) => {
                let _ = events.send(TurnEvent::ToolFinished {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    text: out.text.clone(),
                    detail: out.detail.clone(),
                    tokens: approx_tokens(&out.text),
                });
                out.text
            }
            Err(error) => {
                let _ = events.send(TurnEvent::ToolFailed {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    error: error.clone(),
                });
                error
            }
        }
    }

    /// Writes the turn down and tells the window what it cost.
    fn record(
        &self,
        ledger: Option<&Ledger>,
        completion: &crate::agent::provider::Completion,
        wall_ms: u32,
        largest_tool_result: u32,
        events: &UnboundedSender<TurnEvent>,
    ) {
        let usage = completion.usage;
        let cost = ledger
            .and_then(|ledger| {
                ledger
                    .record(
                        &TurnRecord {
                            session_id: self.config.session_id.clone(),
                            surface: self.config.surface,
                            turn: self.turn,
                            model: self.config.model.clone(),
                            usage,
                            tool_calls: completion.tool_calls.len() as u32,
                            largest_tool_result,
                            wall_ms,
                        },
                        self.config.price,
                    )
                    .ok()
            })
            .unwrap_or_else(|| self.config.price.cost(&usage));

        let _ = events.send(TurnEvent::Turn {
            input: usage.input,
            cached: usage.cached,
            output: usage.output,
            cost_usd: cost,
            hit_rate: usage.hit_rate(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::message::{Role, Usage};
    use crate::agent::provider::Completion;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// A provider that replays prepared answers, so the loop can be tested
    /// without a model — and so the awkward cases (a tool call, then a
    /// sentence) are reproducible rather than hoped for.
    struct Scripted {
        answers: Mutex<Vec<Completion>>,
        /// Every request it was handed, to assert on the prefix.
        seen: Mutex<Vec<Vec<Message>>>,
    }

    impl Scripted {
        fn new(answers: Vec<Completion>) -> Self {
            Self {
                answers: Mutex::new(answers),
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl Provider for Scripted {
        async fn complete(
            &self,
            request: TurnRequest,
            _events: UnboundedSender<StreamEvent>,
            _cancel: oneshot::Receiver<()>,
        ) -> Result<Completion, String> {
            self.seen.lock().unwrap().push(request.messages);
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

    struct Yes;
    impl Approver for Yes {
        async fn approve(&self, _call: &ToolCall, _args: &Value) -> bool {
            true
        }
        fn remembered(&self, _key: &str) -> bool {
            false
        }
    }

    struct No;
    impl Approver for No {
        async fn approve(&self, _call: &ToolCall, _args: &Value) -> bool {
            false
        }
        fn remembered(&self, _key: &str) -> bool {
            false
        }
    }

    fn scratch(name: &str) -> ToolContext {
        let dir = std::env::temp_dir().join(format!("figy-session-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        ToolContext {
            root: std::fs::canonicalize(&dir).unwrap(),
        }
    }

    fn session(mode: Mode) -> Session {
        Session::new(
            SessionConfig {
                session_id: "s1".into(),
                surface: Surface::Window,
                model: "test".into(),
                price: Price { input: 3.0, cached_input: 0.3, output: 15.0 },
                mode,
            },
            "You are a coding agent.",
        )
    }

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: format!("call_{name}"),
            name: name.into(),
            arguments: args.to_string(),
        }
    }

    fn answers(completions: Vec<Completion>) -> Scripted {
        Scripted::new(completions)
    }

    fn tool_turn(calls: Vec<ToolCall>) -> Completion {
        Completion {
            content: String::new(),
            tool_calls: calls,
            usage: Usage { input: 1000, output: 20, cached: 800 },
            finish_reason: "tool_calls".into(),
        }
    }

    fn text_turn(text: &str) -> Completion {
        Completion {
            content: text.into(),
            tool_calls: Vec::new(),
            usage: Usage { input: 1200, output: 40, cached: 1000 },
            finish_reason: "stop".into(),
        }
    }

    async fn run(
        session: &mut Session,
        provider: &Scripted,
        approver: &impl Approver,
        ctx: &ToolContext,
        ledger: Option<&Ledger>,
    ) -> (Result<(), String>, Vec<TurnEvent>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let result = session
            .send(
                "do the thing",
                Turn { provider, picker: &OfferEverything, approver, ctx, ledger },
                tx,
                cancel_rx,
            )
            .await;
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        (result, events)
    }

    #[tokio::test]
    async fn a_turn_with_no_tool_calls_ends_after_one_round_trip() {
        let ctx = scratch("plain");
        let provider = answers(vec![text_turn("Here is the answer.")]);
        let mut session = session(Mode::Ask);

        let (result, events) = run(&mut session, &provider, &Yes, &ctx, None).await;
        assert!(result.is_ok());
        assert_eq!(provider.seen.lock().unwrap().len(), 1);
        assert!(events
            .iter()
            .any(|e| matches!(e, TurnEvent::Finished { reason } if reason == "stop")));
    }

    #[tokio::test]
    async fn a_tool_call_runs_and_the_loop_goes_round_again() {
        let ctx = scratch("tool");
        let provider = answers(vec![
            tool_turn(vec![call("read", json!({ "path": "src/main.rs" }))]),
            text_turn("It is an empty main."),
        ]);
        let mut session = session(Mode::Ask);

        let (result, events) = run(&mut session, &provider, &Yes, &ctx, None).await;
        assert!(result.is_ok());
        assert_eq!(provider.seen.lock().unwrap().len(), 2);
        assert!(events.iter().any(|e| matches!(
            e,
            TurnEvent::ToolFinished { name, text, .. } if name == "read" && text.contains("fn main")
        )));
    }

    #[tokio::test]
    async fn every_tool_call_gets_a_result_in_the_history() {
        // A call with no result is a conversation the next request rejects,
        // so refusals and failures are still answers.
        let ctx = scratch("paired");
        let provider = answers(vec![
            tool_turn(vec![
                call("read", json!({ "path": "src/nope.rs" })),
                call("edit", json!({ "path": "src/main.rs", "old": "x", "new": "y" })),
            ]),
            text_turn("Neither worked."),
        ]);
        let mut session = session(Mode::Ask);
        run(&mut session, &provider, &Yes, &ctx, None).await.0.unwrap();

        let calls: usize = session
            .history()
            .iter()
            .map(|m| m.tool_calls.len())
            .sum();
        let results = session
            .history()
            .iter()
            .filter(|m| m.role == Role::Tool)
            .count();
        assert_eq!(calls, results, "every call must have exactly one result");
    }

    #[tokio::test]
    async fn plan_mode_refuses_an_edit_without_asking_and_without_writing() {
        let ctx = scratch("plan");
        let before = std::fs::read_to_string(ctx.root().join("src/main.rs")).unwrap();
        let provider = answers(vec![
            tool_turn(vec![call(
                "edit",
                json!({ "path": "src/main.rs", "old": "fn main", "new": "fn nope" }),
            )]),
            text_turn("Here is the plan instead."),
        ]);
        let mut session = session(Mode::Plan);

        let (_, events) = run(&mut session, &provider, &Yes, &ctx, None).await;
        assert!(events
            .iter()
            .any(|e| matches!(e, TurnEvent::ToolRefused { reason, .. } if reason.contains("Plan mode"))));
        assert_eq!(
            std::fs::read_to_string(ctx.root().join("src/main.rs")).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn a_declined_edit_changes_nothing_and_tells_the_model_so() {
        let ctx = scratch("declined");
        let before = std::fs::read_to_string(ctx.root().join("src/main.rs")).unwrap();
        let provider = answers(vec![
            tool_turn(vec![call(
                "edit",
                json!({ "path": "src/main.rs", "old": "fn main", "new": "fn other" }),
            )]),
            text_turn("Understood."),
        ]);
        let mut session = session(Mode::Ask);

        let (_, events) = run(&mut session, &provider, &No, &ctx, None).await;
        assert!(events.iter().any(|e| matches!(e, TurnEvent::NeedsApproval { .. })));
        assert!(events.iter().any(|e| matches!(e, TurnEvent::ToolRefused { .. })));
        assert_eq!(
            std::fs::read_to_string(ctx.root().join("src/main.rs")).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn reading_is_never_put_to_the_user() {
        let ctx = scratch("silent-read");
        let provider = answers(vec![
            tool_turn(vec![call("read", json!({ "path": "src/main.rs" }))]),
            text_turn("ok"),
        ]);
        let mut session = session(Mode::Ask);

        let (_, events) = run(&mut session, &provider, &No, &ctx, None).await;
        assert!(!events.iter().any(|e| matches!(e, TurnEvent::NeedsApproval { .. })));
    }

    #[tokio::test]
    async fn the_system_prompt_is_the_same_bytes_on_every_turn() {
        // The cache is a prefix match. This test is the whole argument.
        let ctx = scratch("prefix");
        let provider = answers(vec![
            tool_turn(vec![call("read", json!({ "path": "src/main.rs" }))]),
            tool_turn(vec![call("grep", json!({ "pattern": "main" }))]),
            text_turn("done"),
        ]);
        let mut session = session(Mode::Ask);
        run(&mut session, &provider, &Yes, &ctx, None).await.0.unwrap();

        let seen = provider.seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        let first = seen[0][0].clone();
        for request in seen.iter() {
            assert_eq!(request[0], first, "the system message moved");
        }
    }

    #[tokio::test]
    async fn history_only_ever_grows_and_earlier_messages_are_untouched() {
        let ctx = scratch("append");
        let provider = answers(vec![
            tool_turn(vec![call("read", json!({ "path": "src/main.rs" }))]),
            text_turn("done"),
        ]);
        let mut session = session(Mode::Ask);
        run(&mut session, &provider, &Yes, &ctx, None).await.0.unwrap();

        let seen = provider.seen.lock().unwrap();
        let (first, second) = (&seen[0], &seen[1]);
        assert!(second.len() > first.len());
        for (a, b) in first.iter().zip(second.iter()) {
            assert_eq!(a, b, "an earlier message was rewritten");
        }
    }

    #[tokio::test]
    async fn a_malformed_tool_call_is_answered_rather_than_fatal() {
        let ctx = scratch("malformed");
        let bad = ToolCall {
            id: "c1".into(),
            name: "read".into(),
            arguments: "{not json".into(),
        };
        let provider = answers(vec![tool_turn(vec![bad]), text_turn("I will try again.")]);
        let mut session = session(Mode::Ask);

        let (result, events) = run(&mut session, &provider, &Yes, &ctx, None).await;
        assert!(result.is_ok());
        assert!(events.iter().any(|e| matches!(e, TurnEvent::ToolFailed { .. })));
    }

    #[tokio::test]
    async fn a_provider_failure_ends_the_turn_and_says_so() {
        struct Broken;
        impl Provider for Broken {
            async fn complete(
                &self,
                _request: TurnRequest,
                _events: UnboundedSender<StreamEvent>,
                _cancel: oneshot::Receiver<()>,
            ) -> Result<Completion, String> {
                Err("Rate limited by the provider (429)".into())
            }
        }

        let ctx = scratch("broken");
        let mut session = session(Mode::Ask);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (_c, cancel_rx) = oneshot::channel();
        let result = session
            .send(
                "hi",
                Turn {
                    provider: &Broken,
                    picker: &OfferEverything,
                    approver: &Yes,
                    ctx: &ctx,
                    ledger: None,
                },
                tx,
                cancel_rx,
            )
            .await;

        assert!(result.is_err());
        let mut failed = false;
        while let Ok(event) = rx.try_recv() {
            if matches!(&event, TurnEvent::Failed { error } if error.contains("429")) {
                failed = true;
            }
        }
        assert!(failed);
    }

    #[tokio::test]
    async fn what_a_turn_cost_is_written_down_and_announced() {
        let ctx = scratch("ledger");
        let ledger = Ledger::in_memory().unwrap();
        let provider = answers(vec![text_turn("done")]);
        let mut session = session(Mode::Ask);

        let (_, events) = run(&mut session, &provider, &Yes, &ctx, Some(&ledger)).await;
        let totals = ledger.totals("s1").unwrap();
        assert_eq!(totals.turns, 1);
        assert_eq!(totals.input, 1200);
        assert_eq!(totals.hit_rate, 83);
        assert!(events.iter().any(|e| matches!(
            e,
            TurnEvent::Turn { hit_rate, cost_usd, .. } if *hit_rate == 83 && *cost_usd > 0.0
        )));
    }

    #[tokio::test]
    async fn a_model_that_will_not_stop_is_stopped() {
        let ctx = scratch("runaway");
        let forever: Vec<Completion> = (0..MAX_STEPS + 5)
            .map(|_| tool_turn(vec![call("read", json!({ "path": "src/main.rs" }))]))
            .collect();
        let provider = answers(forever);
        let mut session = session(Mode::Ask);

        let (result, events) = run(&mut session, &provider, &Yes, &ctx, None).await;
        assert!(result.is_ok());
        assert_eq!(provider.seen.lock().unwrap().len(), MAX_STEPS);
        assert!(events
            .iter()
            .any(|e| matches!(e, TurnEvent::Finished { reason } if reason == "step_limit")));
    }

    #[tokio::test]
    async fn cancelling_before_the_first_answer_leaves_no_half_turn() {
        let ctx = scratch("cancel");
        let provider = answers(vec![text_turn("never seen")]);
        let mut session = session(Mode::Ask);

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        cancel_tx.send(()).unwrap();

        let result = session
            .send(
                "hi",
                Turn {
                    provider: &provider,
                    picker: &OfferEverything,
                    approver: &Yes,
                    ctx: &ctx,
                    ledger: None,
                },
                tx,
                cancel_rx,
            )
            .await;
        assert_eq!(result.unwrap_err(), CANCELLED);
    }

    #[test]
    fn the_default_picker_offers_the_whole_registry_unchanged() {
        // Narrowing per turn would change the first bytes of the request,
        // which is the worst place to change bytes.
        let first = OfferEverything.tools_for("anything");
        let second = OfferEverything.tools_for("something else");
        assert_eq!(first, second);
        assert_eq!(first, tools::openai_tools());
    }

    #[test]
    fn a_session_starts_with_nothing_but_its_system_prompt() {
        let session = session(Mode::Ask);
        assert!(session.history().is_empty());
        assert_eq!(session.messages().len(), 1);
        assert_eq!(session.messages()[0].role, Role::System);
    }

    #[test]
    fn the_context_a_tool_gets_is_only_the_root() {
        let ctx = ToolContext {
            root: PathBuf::from("/tmp"),
        };
        assert_eq!(ctx.root(), PathBuf::from("/tmp"));
    }
}

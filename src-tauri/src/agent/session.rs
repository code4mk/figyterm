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
use crate::agent::message::{Message, Role, ToolCall};
use crate::agent::policy::{approval_key, decide, Decision, Mode};
use crate::agent::provider::{Provider, StreamEvent, TurnRequest, CANCELLED};
use crate::agent::tools::{self, output::approx_tokens, ToolContext};

/* ─── Compaction ─────────────────────────────────────────────────────────── */

/// How full the window gets before the conversation is summarised.
///
/// Late, and once. `CODE-AGENT.md` is blunt about why: **pruning and
/// compaction both destroy the cache.** Everything after the edited
/// point has to be written again at 1.25×, so the arithmetic is often
/// negative — dropping 20K tokens to save 2K a turn while forfeiting a
/// cache that was saving 25K. Letting it grow with cache behind it and
/// then compacting hard, once, beats trimming continuously.
const COMPACT_AT_PERCENT: u8 = 85;

/// User turns kept verbatim at the end. Everything before them, except
/// the first request, becomes a summary.
const KEEP_RECENT_TURNS: usize = 2;

/// Where the kept tail of a conversation begins, or `None` when there
/// is not enough history to be worth summarising.
///
/// Three rules, and each one is a thing that goes wrong without it:
///
/// - **The split lands on a user message.** Cutting between an
///   assistant's tool calls and their results leaves an orphaned call,
///   which every provider rejects outright.
/// - **The first request is never summarised** — it is what the whole
///   conversation is for, and a summary of it is a worse version of a
///   sentence that was already short.
/// - **The last two turns stay verbatim.** They are what the model is
///   working on; a summary of the thing in progress is how an agent
///   loses its place.
pub fn compaction_split(history: &[Message], keep_turns: usize) -> Option<usize> {
    let user_turns: Vec<usize> = history
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == Role::User)
        .map(|(i, _)| i)
        .collect();

    // The first, plus the kept tail, plus at least one in between worth
    // summarising.
    if user_turns.len() < keep_turns + 2 {
        return None;
    }
    let split = user_turns[user_turns.len() - keep_turns];
    // Never before the first request, and never the whole history.
    if split <= user_turns[0] {
        return None;
    }
    Some(split)
}

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

/// Every tool this surface has, every turn. The cache-stable default.
///
/// "Every tool" is per surface, not absolute: the panel is offered a
/// narrower set than the window, decided here once and then unchanging
/// for the life of the session. See `tools::PANEL_TOOLS` for the argument
/// about which ones.
pub struct OfferEverything(pub Surface);

impl Picker for OfferEverything {
    fn tools_for(&self, _prompt: &str) -> Value {
        tools::openai_tools_for(self.0)
    }
}

/// What the window is told as a turn proceeds.
///
/// A superset of the provider's stream: the provider knows about text and
/// tool calls, and only the loop knows what a tool *returned*, what was
/// refused, and what the turn cost.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
    /// The provider would not take it, and this is the wait. A silent
    /// thirty-second pause is indistinguishable from a hang.
    Retrying {
        attempt: u32,
        total: u32,
        seconds: u64,
        reason: String,
    },
    Turn {
        input: u32,
        cached: u32,
        output: u32,
        cost_usd: f64,
        hit_rate: u8,
        /// How full the window is, when its size is known.
        context_percent: Option<u8>,
    },
    /// The conversation is being summarised. Worth saying: it is a
    /// model call, so there is a pause with nothing streaming.
    Compacting,
    Compacted {
        messages: u32,
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
    /// The model's context window, in tokens.
    ///
    /// A configuration value beside the model name, because nothing on
    /// the wire says it: the provider reports how many tokens a request
    /// used and never how many it was allowed. Without it, nothing can
    /// know how close a conversation is to its limit — which is the
    /// number compaction, and the warning before it, are decided on.
    pub context_window: Option<u32>,
    /// Dollars this session may spend before it stops and says so.
    ///
    /// `CODE-AGENT.md`: "an agent looping on a broken test spends real
    /// money fast, and 'a few cents a turn' stops being true at turn
    /// 200." The ledger could always answer *how much*; this is the
    /// first thing that acts on the answer.
    pub budget_usd: Option<f64>,
}

pub struct Session {
    config: SessionConfig,
    /// What this session has spent, against `budget_usd`.
    spent: f64,
    /// The last turn's input count, which is the best estimate of how
    /// full the window is: the next request re-sends all of it.
    context_used: u32,
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
            spent: 0.0,
            context_used: 0,
            turn: 0,
        }
    }

    /// How full the context window is, 0–100, or `None` when the window
    /// size was never configured.
    pub fn context_percent(&self) -> Option<u8> {
        let window = self.config.context_window.filter(|w| *w > 0)?;
        Some(((self.context_used as f64 / window as f64) * 100.0).round().min(100.0) as u8)
    }

    pub fn spent(&self) -> f64 {
        self.spent
    }

    /// Whether the session has spent what it was allowed.
    ///
    /// Checked before a request rather than after: the point is not to
    /// report the overspend, it is not to make it.
    fn over_budget(&self) -> bool {
        self.config
            .budget_usd
            .is_some_and(|budget| budget > 0.0 && self.spent >= budget)
    }

    pub fn history(&self) -> &[Message] {
        &self.history
    }

    /// Whether the conversation is close enough to the window's edge to
    /// be worth the cost of summarising it.
    pub fn should_compact(&self) -> bool {
        self.context_percent()
            .is_some_and(|percent| percent >= COMPACT_AT_PERCENT)
    }

    /// Replaces the middle of the conversation with a summary of it.
    ///
    /// Asked of the model itself, in a request of its own — this is the
    /// one place the agent talks to the provider about something other
    /// than the user's task, and it is deliberately a separate call
    /// rather than an instruction bolted onto a turn.
    ///
    /// Called **at a task boundary**, never mid-edit: the loop does it
    /// after a turn that asked for no tools, which is the only moment
    /// the model is not holding something half-finished.
    pub async fn compact(&mut self, provider: &impl Provider) -> Result<bool, String> {
        let Some(split) = compaction_split(&self.history, KEEP_RECENT_TURNS) else {
            return Ok(false);
        };

        let transcript: Vec<Message> = self.history[..split].to_vec();
        let (events, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (_cancel, cancel_rx) = oneshot::channel();

        let mut ask = transcript.clone();
        ask.push(Message::user(
            "Summarise everything above for your own use: what was asked, what you              found out about this codebase, what you changed and what is still              outstanding. Keep file paths and symbol names exactly. Leave out              anything you would not need to carry on.",
        ));

        let summary = provider
            .complete(
                TurnRequest {
                    messages: ask,
                    // No tools: this is not a turn, and offering them
                    // invites the model to go and look things up again.
                    tools: Value::Array(Vec::new()),
                },
                events,
                cancel_rx,
            )
            .await?;

        if summary.content.trim().is_empty() {
            return Ok(false);
        }

        /*
          Rebuilt in one go rather than edited in place.

          The first request stays at the front, the summary stands for
          everything between, and the last turns are untouched. Note
          what this costs: every byte after the system prompt has
          changed, so the next request writes the whole prefix again.
          That is the price, it is paid once, and it is why the
          threshold is 85% rather than 50%.
        */
        let first = self.history[0].clone();
        let tail = self.history[split..].to_vec();
        let mut rebuilt = Vec::with_capacity(tail.len() + 2);
        rebuilt.push(first);
        rebuilt.push(Message::assistant(format!(
            "[Earlier turns, summarised]\n{}",
            summary.content.trim()
        )));
        rebuilt.extend(tail);
        self.history = rebuilt;

        // The old figure described a conversation that no longer exists.
        self.context_used = 0;
        Ok(true)
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
            /*
              The ceiling, checked before the request rather than after.

              The point is not to report the overspend but to not make
              it — and the place a runaway shows up is the next request,
              not the last one.
            */
            if self.over_budget() {
                let budget = self.config.budget_usd.unwrap_or(0.0);
                let note = format!(
                    "Stopped: this session has spent ${:.2} of its ${budget:.2} budget. \
                     The work so far is kept — raise the budget or start a new \
                     conversation.",
                    self.spent
                );
                self.history.push(Message::assistant(note));
                let _ = events.send(TurnEvent::Finished {
                    reason: "budget".into(),
                });
                return Ok(());
            }

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
                        StreamEvent::Retrying {
                            attempt,
                            total,
                            seconds,
                            reason,
                        } => Some(TurnEvent::Retrying {
                            attempt,
                            total,
                            seconds,
                            reason,
                        }),
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
                self.record(ledger, &completion, model_ms, 0, 0.0, &events);
                self.history.push(Message::assistant(completion.content));

                /*
                  A task boundary: the model asked for no tools, so it is
                  not holding anything half-finished. The only safe
                  moment to rewrite the conversation underneath it, and
                  the reason compaction lives here rather than in a
                  timer.
                */
                if self.should_compact() {
                    let _ = events.send(TurnEvent::Compacting);
                    // A summary that could not be made is not a failed
                    // turn: the answer above it is still the answer, and
                    // the next turn is merely expensive.
                    if let Ok(true) = self.compact(provider).await {
                        let _ = events.send(TurnEvent::Compacted {
                            messages: self.history.len() as u32,
                        });
                    }
                }

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
            // Exa bills per call. Summed here because this is the only
            // place that sees every tool's result in a turn.
            let mut tool_cost = 0f64;
            for call in &completion.tool_calls {
                if cancel.try_recv().is_ok() {
                    // Still answered, so the history has no dangling call.
                    self.history
                        .push(Message::tool_result(&call.id, "Interrupted by the user."));
                    self.record(ledger, &completion, model_ms, biggest, tool_cost, &events);
                    let _ = events.send(TurnEvent::Failed {
                        error: CANCELLED.into(),
                    });
                    return Err(CANCELLED.into());
                }

                let (text, charged) = self.run(call, approver, ctx, &events).await;
                tool_cost += charged;
                biggest = biggest.max(approx_tokens(&text) as u32);
                self.history.push(Message::tool_result(&call.id, text));
            }

            /*
              Written once the results are in, because `largest_tool_result`
              is the early warning this row exists for — a spike in it is a
              tool misbehaving, and it is only knowable after the tools have
              run.
            */
            self.record(ledger, &completion, model_ms, biggest, tool_cost, &events);

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
    ) -> (String, f64) {
        let arguments = match call.parsed() {
            Ok(value) => value,
            Err(error) => {
                let _ = events.send(TurnEvent::ToolFailed {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    error: error.clone(),
                });
                return (error, 0.0);
            }
        };

        let Some(spec) = tools::specs().into_iter().find(|s| s.name == call.name) else {
            let error = format!("no tool called `{}`", call.name);
            let _ = events.send(TurnEvent::ToolFailed {
                id: call.id.clone(),
                name: call.name.clone(),
                error: error.clone(),
            });
            return (error, 0.0);
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
                return (why, 0.0);
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
                    return (refused, 0.0);
                }
            }
        }

        /*
          Off the async thread.

          Every tool here does blocking work — a walk, a write, a process,
          and now a round trip to the window's language server that can
          wait thirty seconds for a cold `rust-analyzer`. Running that on a
          runtime worker would stall every other task in the process,
          including the command that delivers the answer it is waiting for,
          which deadlocks rather than merely stalling.
        */
        let dispatch = {
            let ctx = ctx.clone();
            let name = call.name.clone();
            let arguments = arguments.clone();
            tokio::task::spawn_blocking(move || tools::call(&ctx, &name, &arguments)).await
        };
        let outcome = match dispatch {
            Ok(result) => result,
            Err(error) => Err(format!("{}: the tool did not finish ({error})", call.name)),
        };

        match outcome {
            Ok(out) => {
                let _ = events.send(TurnEvent::ToolFinished {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    text: out.text.clone(),
                    detail: out.detail.clone(),
                    tokens: approx_tokens(&out.text),
                });
                /* What the tool itself charged, if it charges. */
                let charged = out
                    .detail
                    .as_ref()
                    .and_then(|d| d.get("costUsd"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                (out.text, charged)
            }
            Err(error) => {
                let _ = events.send(TurnEvent::ToolFailed {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    error: error.clone(),
                });
                (error, 0.0)
            }
        }
    }

    /// Writes the turn down and tells the window what it cost.
    fn record(
        &mut self,
        ledger: Option<&Ledger>,
        completion: &crate::agent::provider::Completion,
        wall_ms: u32,
        largest_tool_result: u32,
        tool_cost_usd: f64,
        events: &UnboundedSender<TurnEvent>,
    ) {
        let usage = completion.usage;
        // Both before the event, so what the window is told and what the
        // budget check reads are the same numbers.
        self.context_used = usage.input + usage.output;
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
                            tool_cost_usd,
                            largest_tool_result,
                            wall_ms,
                        },
                        self.config.price,
                    )
                    .ok()
            })
            .unwrap_or_else(|| self.config.price.cost(&usage));
        self.spent += cost + tool_cost_usd;

        let _ = events.send(TurnEvent::Turn {
            input: usage.input,
            cached: usage.cached,
            output: usage.output,
            cost_usd: cost,
            hit_rate: usage.hit_rate(),
            context_percent: self.context_percent(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::message::Usage;
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
        ToolContext::new(std::fs::canonicalize(&dir).unwrap())
            .with_shell(std::sync::Arc::new(crate::agent::shell::SystemShell::new()))
    }

    fn session(mode: Mode) -> Session {
        Session::new(
            SessionConfig {
                session_id: "s1".into(),
                surface: Surface::Window,
                model: "test".into(),
                price: Price { input: 3.0, cached_input: 0.3, output: 15.0 },
                mode,
                context_window: Some(200_000),
                budget_usd: None,
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
                Turn { provider, picker: &OfferEverything(Surface::Window), approver, ctx, ledger },
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
                    picker: &OfferEverything(Surface::Window),
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
    async fn a_session_stops_when_it_has_spent_its_budget() {
        // The ceiling is about not making the overspend, so it is
        // checked before the request rather than reported after it.
        let ctx = scratch("budget");
        let provider = answers(vec![text_turn("one"), text_turn("two")]);
        let mut session = Session::new(
            SessionConfig {
                session_id: "s1".into(),
                surface: Surface::Window,
                model: "test".into(),
                // A price that makes one turn blow a tiny budget.
                price: Price { input: 1000.0, cached_input: 1000.0, output: 1000.0 },
                mode: Mode::Ask,
                context_window: Some(200_000),
                budget_usd: Some(0.001),
            },
            "system",
        );

        run(&mut session, &provider, &Yes, &ctx, None).await.0.unwrap();
        let spent_after_one = session.spent();
        assert!(spent_after_one > 0.001, "the first turn went over");

        let (_, events) = run(&mut session, &provider, &Yes, &ctx, None).await;
        assert!(
            events
                .iter()
                .any(|e| matches!(e, TurnEvent::Finished { reason } if reason == "budget")),
            "the second message should have been refused"
        );
        assert_eq!(
            session.spent(),
            spent_after_one,
            "nothing more should have been spent"
        );
    }

    #[tokio::test]
    async fn how_full_the_window_is_rides_on_every_turn() {
        let ctx = scratch("context");
        // 1200 input + 40 output of a 200,000 window is 1%.
        let provider = answers(vec![text_turn("done")]);
        let mut session = session(Mode::Ask);
        let (_, events) = run(&mut session, &provider, &Yes, &ctx, None).await;

        assert!(events.iter().any(|e| matches!(
            e,
            TurnEvent::Turn { context_percent: Some(p), .. } if *p == 1
        )));
        assert_eq!(session.context_percent(), Some(1));
    }

    #[test]
    fn with_no_window_configured_there_is_no_percentage_to_invent() {
        let mut config = SessionConfig {
            session_id: "s".into(),
            surface: Surface::Window,
            model: "m".into(),
            price: Price { input: 0.0, cached_input: 0.0, output: 0.0 },
            mode: Mode::Ask,
            context_window: None,
            budget_usd: None,
        };
        assert_eq!(Session::new(config, "s").context_percent(), None);

        config = SessionConfig {
            session_id: "s".into(),
            surface: Surface::Window,
            model: "m".into(),
            price: Price { input: 0.0, cached_input: 0.0, output: 0.0 },
            mode: Mode::Ask,
            // Zero is "not configured" rather than "divide by zero".
            context_window: Some(0),
            budget_usd: None,
        };
        assert_eq!(Session::new(config, "s").context_percent(), None);
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
                    picker: &OfferEverything(Surface::Window),
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
        let picker = OfferEverything(Surface::Window);
        let first = picker.tools_for("anything");
        let second = picker.tools_for("something else");
        assert_eq!(first, second);
        assert_eq!(first, tools::openai_tools());
    }

    #[test]
    fn a_panel_session_is_offered_the_panel_s_tools() {
        let offered = OfferEverything(Surface::Panel).tools_for("fix this");
        assert_eq!(offered, tools::openai_tools_for(Surface::Panel));
        assert!(
            offered.as_array().unwrap().len() < tools::specs().len(),
            "the panel's set is the smaller one"
        );
    }

    fn conversation(turns: usize) -> Vec<Message> {
        let mut history = Vec::new();
        for i in 0..turns {
            history.push(Message::user(format!("ask {i}")));
            history.push(Message::assistant_calling(
                "",
                vec![ToolCall {
                    id: format!("c{i}"),
                    name: "read".into(),
                    arguments: "{}".into(),
                }],
            ));
            history.push(Message::tool_result(format!("c{i}"), "a result"));
            history.push(Message::assistant(format!("answer {i}")));
        }
        history
    }

    #[test]
    fn a_short_conversation_is_not_worth_summarising() {
        // Nothing in the middle: the first request plus the kept tail is
        // the whole of it.
        assert_eq!(compaction_split(&conversation(1), 2), None);
        assert_eq!(compaction_split(&conversation(3), 2), None);
        assert_eq!(compaction_split(&[], 2), None);
    }

    #[test]
    fn the_split_lands_on_a_user_message() {
        // Cutting between an assistant's tool calls and their results
        // leaves an orphaned call, which every provider rejects.
        let history = conversation(6);
        let split = compaction_split(&history, 2).expect("six turns is worth compacting");
        assert_eq!(history[split].role, Role::User);
    }

    #[test]
    fn the_last_turns_stay_verbatim() {
        let history = conversation(6);
        let split = compaction_split(&history, 2).unwrap();
        let kept_users = history[split..].iter().filter(|m| m.role == Role::User).count();
        assert_eq!(kept_users, 2);
    }

    #[test]
    fn the_first_request_is_never_inside_the_summarised_part() {
        // It is what the conversation is for, and a summary of it is a
        // worse version of a sentence that was already short.
        let history = conversation(6);
        let split = compaction_split(&history, 2).unwrap();
        assert!(split > 0, "the split must leave the original request in front");
    }

    #[tokio::test]
    async fn compacting_keeps_the_ends_and_replaces_the_middle() {
        let provider = answers(vec![Completion {
            content: "Earlier: looked at the parser, changed two files.".into(),
            ..Completion::default()
        }]);
        let mut session = session(Mode::Ask);
        session.history = conversation(6);
        let before = session.history.len();

        assert!(session.compact(&provider).await.unwrap());
        let after = session.history();

        assert!(after.len() < before);
        assert_eq!(after[0].content, "ask 0", "the original request survives");
        assert!(after[1].content.contains("Earlier: looked at the parser"));
        assert!(
            after.last().unwrap().content.contains("answer 5"),
            "the last turn survives verbatim"
        );
    }

    #[tokio::test]
    async fn a_summary_that_comes_back_empty_changes_nothing() {
        // Better an expensive next turn than a conversation with its
        // middle replaced by nothing.
        let provider = answers(vec![Completion::default()]);
        let mut session = session(Mode::Ask);
        session.history = conversation(6);
        let before = session.history.clone();

        assert!(!session.compact(&provider).await.unwrap());
        assert_eq!(session.history(), before.as_slice());
    }

    #[tokio::test]
    async fn the_summary_is_asked_for_without_tools() {
        // Offering them invites the model to go and look things up
        // again, which is the opposite of the point.
        let provider = answers(vec![Completion {
            content: "a summary".into(),
            ..Completion::default()
        }]);
        let mut session = session(Mode::Ask);
        session.history = conversation(6);
        session.compact(&provider).await.unwrap();

        let asked = provider.seen.lock().unwrap();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].last().unwrap().content.contains("Summarise everything above"));
    }

    #[test]
    fn compaction_waits_until_the_window_is_nearly_full() {
        let mut session = session(Mode::Ask);
        session.context_used = 100_000; // half of 200,000
        assert!(!session.should_compact());
        session.context_used = 180_000;
        assert!(session.should_compact());
    }

    #[test]
    fn the_wire_names_are_the_ones_typescript_reads() {
        // The window matches on these strings. A serde default that
        // produced `cost_usd` here would leave the status bar reading
        // `undefined` with nothing in the build to say why.
        let turn = serde_json::to_value(TurnEvent::Turn {
            input: 10,
            cached: 5,
            output: 2,
            cost_usd: 0.01,
            hit_rate: 50,
            context_percent: Some(12),
        })
        .unwrap();
        assert_eq!(turn["kind"], "turn");
        assert!(turn.get("costUsd").is_some());
        assert!(turn.get("hitRate").is_some());
        assert_eq!(turn["contextPercent"], 12);

        let finished = serde_json::to_value(TurnEvent::Finished {
            reason: "stop".into(),
        })
        .unwrap();
        assert_eq!(finished["kind"], "finished");

        let asked = serde_json::to_value(TurnEvent::NeedsApproval {
            id: "c1".into(),
            name: "bash".into(),
            arguments: json!({ "cmd": "ls" }),
        })
        .unwrap();
        assert_eq!(asked["kind"], "needsApproval");
        assert_eq!(asked["arguments"]["cmd"], "ls");
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
        let ctx = ToolContext::new(PathBuf::from("/tmp"));
        assert_eq!(ctx.root(), PathBuf::from("/tmp"));
    }
}

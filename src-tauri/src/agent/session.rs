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
//! it choose, which is what an OpenAI-compatible endpoint does natively,
//! and it is what ships. A router that chose on the model's behalf would
//! implement the same trait.
//!
//! **The warning that belongs with that, and the reason there is no
//! router:** a picker that narrows the tool list per turn changes the
//! first bytes of the request, which is the worst possible place to
//! change bytes. Either it narrows once per session, or
//! the cache saving it is competing with is larger than the routing saving
//! it is buying. Measure it with the ledger before believing otherwise.

use std::collections::{BTreeSet, HashMap};
use std::mem::take;
use std::sync::Arc;
use std::pin::Pin;
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc::UnboundedSender, oneshot};

use crate::agent::ledger::{Ledger, Price, Surface, TurnRecord};
use crate::agent::message::{Image, Message, Role, ToolCall};
use crate::agent::store::Snapshot;
use crate::agent::policy::{approval_key, decide, Decision, Mode, ModeCell};
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

/// What a tool call gets as its result when the turn was stopped.
///
/// A result rather than nothing: the assistant message above carries
/// the call, and a call with no result is a conversation every provider
/// rejects outright.
const INTERRUPTED: &str = "Interrupted by the user.";

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

/// The one argument worth putting on a row beside the verb.
///
/// The window works this out too, from the same arguments, and
/// having it here as well is deliberate rather than an oversight:
/// this is what the row shows *before* anything has happened, and
/// the window's copy is what it shows afterwards from the tool's own
/// `detail`. They agree because they are reading the same fields.
fn subject_of(arguments: &Value) -> String {
    for key in ["cmd", "path", "pattern", "url", "query", "prompt", "from", "id"] {
        if let Some(found) = arguments.get(key).and_then(Value::as_str) {
            let flat = found.split_whitespace().collect::<Vec<_>>().join(" ");
            if !flat.is_empty() {
                return flat;
            }
        }
    }
    String::new()
}

/// Forwards a running tool's output to the window, as the call it
/// belongs to.
///
/// The channel is unbounded and the send is fire-and-forget: a window
/// that has gone away is not a reason to stop a build, and a dropped
/// receiver fails the send rather than blocking the shell's wait loop.
struct Reporter {
    id: String,
    events: UnboundedSender<TurnEvent>,
}

impl tools::Progress for Reporter {
    fn line(&self, text: &str) {
        let _ = self.events.send(TurnEvent::ToolProgress {
            id: self.id.clone(),
            line: text.to_string(),
        });
    }
}

/// What a picker answers with.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Pick {
    /// Tool names. The session turns these into the schema, which is
    /// what lets it tell "the same set" from "a different set" — the
    /// distinction the whole cache depends on.
    pub names: Vec<String>,
    /// What the picking itself cost, if it cost anything. Goes into
    /// the turn's row the same way Exa's does: a router nobody can see
    /// the price of is exactly what the ledger exists to prevent.
    pub cost_usd: f64,
    /// One line about what just happened, for `/context` to show.
    ///
    /// `None` from a picker that is a constant — there is nothing to
    /// say about a set that was never in question. A router sets it
    /// whether it worked or not, because "it narrowed to seven" and
    /// "it could not be reached, so everything" are the two answers
    /// somebody is looking for and they are indistinguishable from
    /// the transcript.
    pub note: Option<String>,
}

impl Pick {
    pub fn free(names: Vec<String>) -> Self {
        Self {
            names,
            cost_usd: 0.0,
            note: None,
        }
    }
}

/// Decides which tools the model is offered.
///
/// **Async, and boxed.** Both halves of that were learned the hard way.
///
/// Async because the only implementation that is not a constant is an
/// HTTP call, and this is called from inside the turn — which is async
/// code on a runtime worker. A synchronous version that reached for
/// `Handle::block_on` panicked with "cannot start a runtime from
/// within a runtime", took the whole turn's task with it, and left a
/// window waiting for an event that was never coming. Tools get away
/// with blocking clients because they are dispatched through
/// `spawn_blocking`; the picker is not.
///
/// Boxed because the choice between implementations is a *setting*, so
/// the caller holds `&dyn Picker`, and `async fn` in a trait is not
/// object safe. One allocation per message, against a round trip.
pub trait Picker: Send + Sync {
    /// See the warning in the module docs about narrowing this per
    /// turn, and [`Session::offer`] for what the session does with an
    /// answer that changes.
    fn tools_for<'a>(&'a self, prompt: &'a str) -> BoxFuture<'a, Pick>;
}

/// What a `Picker` answers with, before it has answered.
pub type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Every tool this surface has, every turn. The cache-stable default.
///
/// "Every tool" is per surface, not absolute: the panel is offered a
/// narrower set than the window, decided here once and then unchanging
/// for the life of the session. See `tools::PANEL_TOOLS` for the argument
/// about which ones.
pub struct OfferEverything(pub Surface);

impl Picker for OfferEverything {
    fn tools_for<'a>(&'a self, _prompt: &'a str) -> BoxFuture<'a, Pick> {
        let names = tools::specs_for(self.0)
            .into_iter()
            .map(|spec| spec.name.to_string())
            .collect();
        Box::pin(async move { Pick::free(names) })
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
    /// The arguments are in, and the tool is about to run.
    ///
    /// Separate from `ToolStarted` because that one comes off the
    /// stream the moment the model names a tool — before it has
    /// finished saying what to do with it. So the row appears
    /// immediately with a verb and nothing else, and this is what
    /// fills it in: what it is acting on, and, where the tool asks
    /// for one, why.
    ToolRunning {
        id: String,
        /// Carried again because the row may have to be rebuilt: an
        /// approved call had its row taken away while the permission
        /// card stood in its place.
        name: String,
        target: String,
        why: String,
    },
    /// A line from a tool that is still running.
    ///
    /// Only `bash` sends these, and only because a two-minute build
    /// used to show a spinner and then two hundred lines at once. The
    /// output existed the whole time and the window had no way to be
    /// handed it. None of this reaches the model, which still gets
    /// the whole thing once, at the end.
    ToolProgress {
        id: String,
        line: String,
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
    /// A question of the model's own, with the answers it will accept.
    ///
    /// Not emitted by the loop: `ask_user` goes out through its own desk
    /// in `agent/ask.rs`, on this channel, so the window has one stream
    /// to render rather than two to interleave. It is in this enum
    /// because this enum *is* the window's vocabulary.
    AskingUser {
        id: String,
        question: String,
        options: Vec<String>,
        /// A plan's steps, when that is what is being asked about.
        steps: Vec<String>,
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
/// `K` is `?Sized` so a caller can hold `&dyn Picker` and decide
/// between two implementations at runtime, which is what a router that
/// is a *setting* requires. The other two stay monomorphised: there is
/// only ever one provider and one approver per turn, and they are on
/// the hot path.
pub struct Turn<'a, P: Provider, K: Picker + ?Sized, A: Approver> {
    pub provider: &'a P,
    pub picker: &'a K,
    pub approver: &'a A,
    pub ctx: &'a ToolContext,
    pub ledger: Option<&'a Ledger>,
}

/// Roughly what one picture costs a request.
///
/// A flat figure, and flat is the only honest option: providers
/// charge by tile and the tiling depends on the dimensions, which
/// are inside the base64 and not worth decoding for a number the
/// breakdown already calls an estimate. A screenshot lands near
/// enough to this.
///
/// What it must *not* be is `approx_tokens` of the data. That is
/// characters over four over a megabyte of base64 — about 250,000
/// tokens for one screenshot, which would read as a full window,
/// fire compaction on the next message and summarise a conversation
/// that had barely started.
pub const IMAGE_TOKENS: usize = 1_100;

/// Where the context window is going, as `/context` draws it.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakdown {
    pub model: String,
    /// The window, when it is configured. Nothing on the wire says it.
    pub window: Option<u32>,
    /// The provider's own count for the last turn. The exact one.
    pub measured: u32,
    /// Everything below is `approx_tokens` — characters over four.
    pub system: usize,
    pub tools: usize,
    pub user: usize,
    pub assistant: usize,
    pub tool_results: usize,
    pub messages: u32,
    pub turns: u32,
    /// Pictures in the conversation, and roughly what they cost.
    /// Counted apart because they are the one thing in here that
    /// cannot be trimmed: a long tool result can be re-run smaller,
    /// and an image is the size it is for the rest of the session.
    pub images: u32,
    pub image_tokens: usize,
    /// Tools on the table, and how many this surface has. They differ
    /// only when a router has narrowed the set.
    pub tools_offered: usize,
    pub tools_total: usize,
    /// What the picker did on the last message, when there is a
    /// picker. The only place a silent fallback is visible.
    pub picker: Option<String>,
    /// The five largest tool results, which is where a window usually
    /// goes. Each one is re-sent on every later turn of the session.
    pub heaviest: Vec<ToolWeight>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolWeight {
    pub name: String,
    pub tokens: usize,
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
    /// How many model round trips one message may take, when the
    /// default is wrong for this session.
    ///
    /// A sub-agent's. Forty is right for a person's task and far too
    /// many for one the model set itself: nothing can interrupt a
    /// sub-agent, so the step limit is the only ceiling on how long one
    /// can hold the turn it is running inside.
    pub max_steps: Option<usize>,
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
    /// Shared with whoever answers the cards: an approved plan and
    /// "allow all edits this session" both change what the rest of
    /// *this* turn may do.
    mode: ModeCell,
    /// Every tool this session has offered, ever. See [`Session::offer`]
    /// for why it never shrinks.
    offered: BTreeSet<String>,
    /// The schema built from it, rebuilt only when the names change —
    /// which is the difference between a cached prefix and a rewritten
    /// one.
    tools: Option<Value>,
    /// What the picker said it did, last message. Shown by `/context`,
    /// which is the only place a silent fallback can be seen.
    last_pick: Option<String>,
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
            mode: ModeCell::new(config.mode),
            config,
            system: system.into(),
            history: Vec::new(),
            offered: BTreeSet::new(),
            tools: None,
            last_pick: None,
            spent: 0.0,
            context_used: 0,
            turn: 0,
        }
    }

    /// The conversation as something that can be written to disk.
    ///
    /// The root is passed in rather than held: a session knows what was
    /// said and the workspace knows where, and duplicating the second
    /// into the first would be two answers to one question.
    pub fn snapshot(&self, root: impl Into<String>) -> Snapshot {
        Snapshot {
            session_id: self.config.session_id.clone(),
            surface: self.config.surface,
            root: root.into(),
            model: self.config.model.clone(),
            system: self.system.clone(),
            history: self.history.clone(),
            turn: self.turn,
            spent: self.spent,
            context_used: self.context_used,
        }
    }

    /// A conversation picked back up.
    ///
    /// The id, the surface and the **system prompt** come from the row;
    /// everything else — the model, the prices, the mode, the window
    /// size, the budget — comes from the settings as they are now. That
    /// split is deliberate. The prompt is part of the cached prefix and
    /// of what the model was told it was doing, so changing it on the
    /// way back in would be rewriting history; a price that has changed
    /// since yesterday is just a price that has changed.
    ///
    /// `spent` comes back with it, so a budget is a budget for the
    /// conversation rather than for each sitting at it.
    pub fn resume(mut config: SessionConfig, snapshot: Snapshot) -> Self {
        config.session_id = snapshot.session_id;
        config.surface = snapshot.surface;
        Self {
            mode: ModeCell::new(config.mode),
            config,
            offered: BTreeSet::new(),
            tools: None,
            last_pick: None,
            system: snapshot.system,
            history: snapshot.history,
            spent: snapshot.spent,
            context_used: snapshot.context_used,
            turn: snapshot.turn,
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

    fn max_steps(&self) -> usize {
        self.config.max_steps.unwrap_or(MAX_STEPS)
    }

    /// The permission mode, for the turn about to start.
    ///
    /// Set per message rather than at construction. The mode was frozen
    /// into `SessionConfig` when a session was made, which meant
    /// shift+tab moved a label on screen and nothing else: the second
    /// message of a conversation ran under whatever the first one did.
    ///
    /// Within a turn it stays put, which is the honest behaviour —
    /// a run that changes what it is allowed to do half-way through is a
    /// run nobody can reason about afterwards.
    pub fn set_mode(&mut self, mode: Mode) {
        self.config.mode = mode;
        self.mode.set(mode);
    }

    /// The cell the window writes to when an answer changes what is
    /// allowed. Held for the length of a turn and dropped after it.
    pub fn mode_cell(&self) -> ModeCell {
        self.mode.clone()
    }

    /// Which model this conversation is talking to now.
    ///
    /// Set per message, like the mode, because the model is a setting
    /// and the person can change it mid-conversation. The provider was
    /// already rebuilt from the settings on every turn; what was not,
    /// and should have been, is **what the turn is costed at** — a
    /// session that switched from a cheap model to an expensive one
    /// went on reporting the cheap one's prices for the rest of its
    /// life, which is the exact failure the ledger exists to prevent.
    ///
    /// Switching is not free and nothing here hides it: the next
    /// request re-sends the whole conversation to a provider that has
    /// never seen it, so there is no cache behind it.
    pub fn use_model(&mut self, model: String, price: Price, context_window: Option<u32>) {
        self.config.model = model;
        self.config.price = price;
        self.config.context_window = context_window;
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

    /// Where the context window is going.
    ///
    /// Two kinds of number, and the difference is the whole reason
    /// this is worth drawing. `measured` is the provider's own count
    /// from the last turn and is exact; every other figure here is
    /// `approx_tokens`, which is characters over four. They will not
    /// add up, and saying so is better than scaling the parts until
    /// they do — the parts are what tells you *what* is filling the
    /// window, and the total is what tells you how full it is.
    ///
    /// `tools` is passed in because the set belongs to the surface
    /// rather than to the session, and because it is the one piece
    /// that is paid for on every turn before anybody has said
    /// anything.
    pub fn breakdown(&self, tool_tokens: usize) -> Breakdown {
        /*
          Which tool produced which result.

          A tool result is a permanent subscription — it is re-sent on
          every later turn until the session ends — so the useful
          question is not "how much is in tool results" but "which
          call is costing me this". The id is on the assistant message
          that asked for it, and the text is on the message after.
        */
        let mut names: HashMap<&str, &str> = HashMap::new();
        for message in &self.history {
            for call in &message.tool_calls {
                names.insert(call.id.as_str(), call.name.as_str());
            }
        }

        let mut out = Breakdown {
            model: self.config.model.clone(),
            window: self.config.context_window,
            measured: self.context_used,
            system: approx_tokens(&self.system),
            tools: tool_tokens,
            messages: self.history.len() as u32,
            tools_offered: self.offered.len(),
            tools_total: tools::specs_for(self.config.surface).len(),
            picker: self.last_pick.clone(),
            ..Breakdown::default()
        };

        let mut results: Vec<ToolWeight> = Vec::new();
        for message in &self.history {
            let tokens = approx_tokens(&message.content);
            match message.role {
                Role::User => {
                    out.user += tokens;
                    out.turns += 1;
                    out.images += message.images.len() as u32;
                    out.image_tokens += message.images.len() * IMAGE_TOKENS;
                }
                Role::Assistant => {
                    out.assistant += tokens;
                    // The arguments travel with the call and are
                    // re-sent with it, so they are not free either.
                    out.assistant += message
                        .tool_calls
                        .iter()
                        .map(|call| approx_tokens(&call.arguments) + approx_tokens(&call.name))
                        .sum::<usize>();
                }
                Role::Tool => {
                    out.tool_results += tokens;
                    results.push(ToolWeight {
                        name: message
                            .tool_call_id
                            .as_deref()
                            .and_then(|id| names.get(id).copied())
                            .unwrap_or("tool")
                            .to_string(),
                        tokens,
                    });
                }
                Role::System => out.system += tokens,
            }
        }

        // Biggest first: the one worth knowing about is the one that
        // will be re-sent for the rest of the session.
        results.sort_by_key(|weight| std::cmp::Reverse(weight.tokens));
        results.truncate(5);
        out.heaviest = results;
        out
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

    /// Answers any tool call left hanging, so the conversation can
    /// still be sent.
    ///
    /// For the one case the loop's own exits do not cover: something
    /// went wrong between a model asking for tools and the results
    /// being written. Every planned exit already pairs them — an
    /// interrupt answers every remaining call for exactly this reason
    /// — and this is the net under a panic, which is unplanned by
    /// definition.
    ///
    /// Returns how many it had to answer, which is zero on every path
    /// that did not go wrong.
    pub fn seal(&mut self) -> usize {
        let answered: std::collections::HashSet<String> = self
            .history
            .iter()
            .filter_map(|message| message.tool_call_id.clone())
            .collect();
        let dangling: Vec<String> = self
            .history
            .iter()
            .flat_map(|message| message.tool_calls.iter())
            .map(|call| call.id.clone())
            .filter(|id| !answered.contains(id))
            .collect();

        for id in &dangling {
            self.history
                .push(Message::tool_result(id, "This did not finish."));
        }
        dangling.len()
    }

    /// What the ledger's rows are keyed by.
    pub fn id(&self) -> &str {
        &self.config.session_id
    }

    /// The tool schema for this message, given what the picker chose.
    ///
    /// **The offered set only ever grows.** Three things fall out of
    /// that one rule, and all three are the cache:
    ///
    /// - A pick that matches what is already offered rebuilds nothing.
    ///   The bytes are identical, so the prefix is identical, so the
    ///   whole conversation behind it is still cached. A router whose
    ///   answers are stable costs one round trip and nothing else.
    /// - A pick that adds something — `bash`, on message five of a
    ///   session that started by reading — rewrites the prefix once.
    ///   Once, because it is in the set from then on.
    /// - A pick that *drops* something changes nothing. Shrinking would
    ///   thrash the cache, and worse, would take away a tool the model
    ///   has already seen and may be mid-way through reasoning about.
    ///
    /// The floor is **not** applied here. It belongs to the thing that
    /// narrows — `tools::FLOOR` is unioned into a router's answer by
    /// the router — because a picker that states its set exactly, like
    /// the sub-agent's, means it exactly. A sub-agent handed `ask_user`
    /// because a constant in this function said so would be a
    /// conversation nobody can see, waiting on a card nobody can
    /// answer.
    fn offer(&mut self, picked: Vec<String>) -> Value {
        let available: Vec<String> = tools::specs_for(self.config.surface)
            .into_iter()
            .map(|spec| spec.name.to_string())
            .collect();

        let mut grew = false;
        for name in picked {
            // A name the surface does not have is a router answering
            // about a tool that is not on the table. Ignored rather
            // than passed on: the schema is built from the registry.
            if !available.contains(&name) || self.offered.contains(&name) {
                continue;
            }
            self.offered.insert(name);
            grew = true;
        }

        if grew || self.tools.is_none() {
            let names: Vec<&str> = available
                .iter()
                .filter(|name| self.offered.contains(*name))
                .map(String::as_str)
                .collect();
            self.tools = Some(tools::openai_tools_named(&names));
        }
        self.tools.clone().unwrap_or_else(|| Value::Array(Vec::new()))
    }

    /// How many tools are on the table, out of how many this surface
    /// has. What `/context` shows, so a narrowed session says so.
    pub fn offered(&self) -> (usize, usize) {
        (
            self.offered.len(),
            tools::specs_for(self.config.surface).len(),
        )
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
    ///
    /// `images` are pictures attached to *this* message, and they are
    /// a parameter for a reason worth keeping. The first version took
    /// them as far as the command, checked them against the model's
    /// `vision` flag, and then built the user message without them.
    /// Everything looked right — the chip was in the transcript, the
    /// attachment was in the request object, the model said it could
    /// not see anything — and the compiler was no help, because the
    /// check counted as a use.
    pub async fn send<P: Provider, K: Picker + ?Sized, A: Approver>(
        &mut self,
        prompt: &str,
        images: Vec<Image>,
        turn: Turn<'_, P, K, A>,
        events: UnboundedSender<TurnEvent>,
        mut cancel: oneshot::Receiver<()>,
    ) -> Result<(), String> {
        let Turn { provider, picker, approver, ctx, ledger } = turn;
        self.history.push(Message::user_seeing(prompt, images));
        let pick = picker.tools_for(prompt).await;
        let mut picker_cost = pick.cost_usd;
        self.last_pick = pick.note;
        let tools = self.offer(pick.names);

        let max_steps = self.max_steps();
        for step in 0..max_steps {
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
                // The router's bill, if there was one, goes on the
                // first turn it paid for and then stops — it is
                // charged once per message, not once per step.
                self.record(ledger, &completion, model_ms, 0, take(&mut picker_cost), &events);
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
            // Exa bills per call, and so does the router. Summed here
            // because this is the only place that sees every charge in
            // a turn.
            let mut tool_cost = take(&mut picker_cost);
            /*
              Escape has to land during a tool, not only between two.

              This used to check `cancel` before each call and then
              await the call itself with nothing watching, so pressing
              Escape during `npm test` did nothing for two minutes —
              the window said it had interrupted and the agent carried
              on. A `select` on the same receiver makes the wait
              interruptible.

              What it does **not** do is reach into the tool: an
              abandoned `bash` keeps running until it finishes or the
              window closes, because the child belongs to the shell and
              not to this loop. The turn stops waiting for it, which is
              the half that was broken.
            */
            let mut interrupted = cancel.try_recv().is_ok();
            for call in &completion.tool_calls {
                if interrupted {
                    /*
                      Every remaining call is answered, not just the one
                      that was in flight.

                      The assistant message above carries all of them,
                      and a call with no result is a message every
                      provider rejects — so interrupting a turn with
                      three tool calls in it used to leave a
                      conversation that could not be continued at all.
                    */
                    self.history.push(Message::tool_result(&call.id, INTERRUPTED));
                    continue;
                }

                let (text, charged) = tokio::select! {
                    biased;
                    _ = &mut cancel => {
                        interrupted = true;
                        (INTERRUPTED.to_string(), 0.0)
                    }
                    out = self.run(call, approver, ctx, &events) => out,
                };
                if interrupted {
                    // The row is still spinning in the window: say what
                    // became of it rather than leaving it there.
                    let _ = events.send(TurnEvent::ToolRefused {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        reason: "Interrupted by you".into(),
                    });
                }
                tool_cost += charged;
                biggest = biggest.max(approx_tokens(&text) as u32);
                self.history.push(Message::tool_result(&call.id, text));
            }

            if interrupted {
                self.record(ledger, &completion, model_ms, biggest, tool_cost, &events);
                let _ = events.send(TurnEvent::Failed {
                    error: CANCELLED.into(),
                });
                return Err(CANCELLED.into());
            }

            /*
              Written once the results are in, because `largest_tool_result`
              is the early warning this row exists for — a spike in it is a
              tool misbehaving, and it is only knowable after the tools have
              run.
            */
            self.record(ledger, &completion, model_ms, biggest, tool_cost, &events);

            if step + 1 == max_steps {
                let note = format!(
                    "Stopped after {max_steps} steps without finishing. The work so far is \
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
        match decide(self.mode.get(), spec.class, approver.remembered(&key)) {
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
        /*
          What it is about to do, now that the arguments have arrived.

          The row has been on screen since the model said "bash",
          with a verb and nothing beside it. For a command that runs
          for two minutes that is two minutes of a spinner that could
          have been saying what it is building and why.
        */
        let _ = events.send(TurnEvent::ToolRunning {
            id: call.id.clone(),
            name: call.name.clone(),
            target: subject_of(&arguments),
            why: arguments
                .get("why")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
        });

        let dispatch = {
            /*
              The context, plus somewhere to put output as it appears.

              Bound per call because it carries the call's id: the
              window has to know which row a line belongs to, and the
              tool knows nothing about rows.
            */
            let ctx = ctx.clone().with_progress(Arc::new(Reporter {
                id: call.id.clone(),
                events: events.clone(),
            }));
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
                max_steps: None,
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
                Vec::new(),
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

    /*
      Switching model mid-conversation changes what a turn costs.

      The provider was always rebuilt from the settings each turn, so
      the *answers* came from the new model straight away. The prices
      did not follow, and a session that moved from a cheap model to an
      expensive one went on reporting the cheap one's numbers — the
      exact failure the ledger exists to catch.
    */
    #[tokio::test]
    async fn a_session_switched_to_another_model_is_costed_at_the_new_one() {
        let ctx = scratch("switch");
        let ledger = Ledger::in_memory().unwrap();
        let mut session = session(Mode::Ask);

        let cheap = answers(vec![text_turn("one")]);
        run(&mut session, &cheap, &Yes, &ctx, Some(&ledger)).await.0.unwrap();
        let after_cheap = session.spent();

        session.use_model(
            "expensive".into(),
            Price { input: 300.0, cached_input: 30.0, output: 1500.0 },
            Some(400_000),
        );
        let dear = answers(vec![text_turn("two")]);
        run(&mut session, &dear, &Yes, &ctx, Some(&ledger)).await.0.unwrap();

        let second = session.spent() - after_cheap;
        assert!(
            second > after_cheap * 50.0,
            "the second turn is costed at the new model's prices, not the old ones"
        );
        // And the window it is measured against is the new model's.
        assert_eq!(session.context_percent(), Some(0));
    }

    /*
      A conversation survives the process it was had in.

      The snapshot is what goes to disk and the resume is what comes
      back; what this asserts is the join between them. The system
      prompt comes from the row rather than from the caller, because it
      is both part of the cached prefix and part of what the model was
      told it was doing — rewriting it on the way back in would be
      editing history.
    */
    /*
      The test that was missing, which is why this shipped broken.

      Pictures reached the command, were checked against the model's
      `vision` flag, and were then dropped: the user message was
      built from the words alone. Every surface of it looked right —
      the chip was in the transcript, the attachment was in the
      request — and the only symptom was a model saying it could not
      see an image that was, as far as anybody could tell, attached.

      So this asserts the end of the chain rather than the middle:
      what the provider is actually handed.
    */
    #[tokio::test]
    async fn a_picture_attached_to_a_message_reaches_the_provider() {
        let ctx = scratch("images");
        let provider = answers(vec![text_turn("A login form.")]);
        let mut session = session(Mode::Ask);

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (_cancel, cancel_rx) = oneshot::channel();
        session
            .send(
                "summarise this",
                vec![Image {
                    mime: "image/png".into(),
                    data: "iVBORw0KGgo=".into(),
                }],
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
            .await
            .unwrap();

        // In the history, so it is re-sent on every later turn.
        let asked = &session.history()[0];
        assert_eq!(asked.images.len(), 1);

        // And on the wire, which is the part that was broken: the
        // parts array rather than a bare string.
        let sent = provider.seen.lock().unwrap().clone();
        let user = sent[0]
            .iter()
            .find(|m| m.role == Role::User)
            .expect("a user message")
            .as_openai();
        let parts = user["content"]
            .as_array()
            .expect("an array — a string here is the bug this exists for");
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,iVBORw0KGgo=");
    }

    #[tokio::test]
    async fn a_resumed_session_carries_its_history_its_prompt_and_its_spend() {
        let ctx = scratch("resume");
        let provider = answers(vec![
            tool_turn(vec![call("read", json!({ "path": "src/main.rs" }))]),
            text_turn("It prints nothing."),
        ]);
        let mut session = session(Mode::AcceptEdits);
        let ledger = Ledger::in_memory().unwrap();
        let (result, _) = run(&mut session, &provider, &Yes, &ctx, Some(&ledger)).await;
        result.unwrap();

        let snapshot = session.snapshot("/repo");
        assert!(snapshot.spent > 0.0, "the turn cost something");
        assert_eq!(snapshot.root, "/repo");

        // A different prompt and a different price, as a later launch
        // would have: the row's prompt must win, the new price must.
        let resumed = Session::resume(
            SessionConfig {
                session_id: "ignored".into(),
                surface: Surface::Panel,
                model: "test".into(),
                price: Price { input: 1.0, cached_input: 0.1, output: 5.0 },
                mode: Mode::Ask,
                context_window: Some(200_000),
                budget_usd: Some(10.0),
                max_steps: None,
            },
            snapshot.clone(),
        );

        assert_eq!(resumed.history(), session.history());
        assert_eq!(resumed.spent(), session.spent());
        assert_eq!(resumed.id(), "s1", "the row's id, not the caller's");
        assert_eq!(
            resumed.messages()[0],
            Message::system("You are a coding agent."),
            "the prompt the conversation actually ran under"
        );
    }

    /*
      The mode is the window's, read fresh each message.

      It used to be read once, at construction, so a conversation that
      began in `ask` stayed in `ask` for ever and shift+tab moved a
      label and nothing else. The test switches a live session into plan
      mode and expects the next edit to be refused.
    */
    #[tokio::test]
    async fn a_mode_set_after_the_session_began_is_the_one_that_applies() {
        let ctx = scratch("mode-change");
        let before = std::fs::read_to_string(ctx.root().join("src/main.rs")).unwrap();
        let provider = answers(vec![
            tool_turn(vec![call(
                "edit",
                json!({ "path": "src/main.rs", "old": "fn main", "new": "fn nope" }),
            )]),
            text_turn("Here is the plan instead."),
        ]);
        let mut session = session(Mode::AcceptEdits);
        session.set_mode(Mode::Plan);

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
                Vec::new(),
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
                max_steps: None,
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
            max_steps: None,
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
            max_steps: None,
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
                Vec::new(),
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

    /*
      Interrupting a turn with several tool calls in it.

      Two things used to go wrong here, and the second is the worse
      one. The cancel was only checked *between* calls, so Escape
      during a two-minute `bash` did nothing until it finished — the
      window said "interrupted" and the agent carried on. And the
      remaining calls were never answered, which leaves an assistant
      message carrying three calls and two results: a conversation
      every provider rejects outright, so the interrupted session could
      not be continued at all.
    */
    #[tokio::test(flavor = "multi_thread")]
    async fn interrupting_a_turn_answers_every_call_it_had_started() {
        let ctx = scratch("cancel-tools");
        // The first one takes three seconds; Escape arrives after a
        // tenth of one. The gap between those is the whole test — the
        // runtime still waits for the abandoned command on the way
        // out, which is why it is three and not thirty.
        let provider = answers(vec![tool_turn(vec![
            call("bash", json!({ "cmd": "sleep 3" })),
            call("ls", json!({})),
        ])]);
        let mut session = session(Mode::Ask);

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = cancel_tx.send(());
        });

        let started = Instant::now();
        let result = session
            .send(
                "run the tests",
                Vec::new(),
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
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "Escape lands during the tool, not after it"
        );

        let calls: usize = session.history().iter().map(|m| m.tool_calls.len()).sum();
        let results = session
            .history()
            .iter()
            .filter(|m| m.role == Role::Tool)
            .count();
        assert_eq!(calls, 2);
        assert_eq!(
            results, calls,
            "an interrupted turn still leaves a conversation that can be sent"
        );
    }

    /*
      What `/context` draws.

      The useful half is `heaviest`: a tool result is re-sent on every
      later turn until the session ends, so "which call is costing me
      this" is the question somebody opens that dialog to answer, and
      it cannot be answered from the totals.
    */
    #[tokio::test]
    async fn the_breakdown_says_what_is_filling_the_window() {
        let ctx = scratch("breakdown");
        std::fs::write(ctx.root().join("big.txt"), "x".repeat(8000)).unwrap();
        let provider = answers(vec![
            tool_turn(vec![
                call("read", json!({ "path": "big.txt" })),
                call("ls", json!({})),
            ]),
            text_turn("That file is mostly x."),
        ]);
        let mut session = session(Mode::Ask);
        run(&mut session, &provider, &Yes, &ctx, None).await.0.unwrap();

        let out = session.breakdown(1234);
        assert_eq!(out.tools, 1234, "the set is paid for before anybody speaks");
        assert!(out.system > 0);
        assert_eq!(out.turns, 1);
        assert!(out.user > 0 && out.assistant > 0);

        // The `read` dwarfs the `ls`, and that is the point of the list.
        assert_eq!(out.heaviest.len(), 2);
        assert_eq!(out.heaviest[0].name, "read");
        assert!(out.heaviest[0].tokens > out.heaviest[1].tokens);
        assert_eq!(
            out.tool_results,
            out.heaviest.iter().map(|w| w.tokens).sum::<usize>(),
            "every result is in the list while there are fewer than five"
        );
        assert_eq!(out.window, Some(200_000));
    }

    /*
      The net under a panic.

      Every planned exit pairs calls with results already. This is for
      the unplanned one, and what it protects is not the turn that
      failed — that turn is lost either way — but the *next* message:
      an assistant message carrying a call with no result is a
      conversation every provider rejects outright.
    */
    #[test]
    fn sealing_answers_a_call_that_never_finished() {
        let mut session = session(Mode::Ask);
        session.history = vec![
            Message::user("do two things"),
            Message::assistant_calling(
                String::new(),
                vec![
                    ToolCall { id: "a".into(), name: "read".into(), arguments: "{}".into() },
                    ToolCall { id: "b".into(), name: "ls".into(), arguments: "{}".into() },
                ],
            ),
            Message::tool_result("a", "the file"),
        ];

        assert_eq!(session.seal(), 1);
        assert_eq!(session.seal(), 0, "a sealed conversation is already sealed");

        let calls: usize = session.history().iter().map(|m| m.tool_calls.len()).sum();
        let results = session
            .history()
            .iter()
            .filter(|m| m.role == Role::Tool)
            .count();
        assert_eq!(calls, results);
    }

    #[test]
    fn a_conversation_with_nothing_in_it_still_costs_its_prefix() {
        // The tools and the preamble are in every request from the
        // first, which is the number people are surprised by.
        let session = session(Mode::Ask);
        let out = session.breakdown(2000);
        assert_eq!(out.tools, 2000);
        assert!(out.system > 0);
        assert_eq!(out.messages, 0);
        assert_eq!(out.measured, 0, "nothing has been sent, so nothing is measured");
        assert!(out.heaviest.is_empty());
    }

    /*
      The rule the whole router rests on.

      Tools are the first bytes of the request, so a set that changes
      rewrites every byte after it. Growing-only turns that from a cost
      per message into a cost per *new tool*: a stable answer produces
      identical bytes and the cache holds, and a turn that needs `bash`
      on message five pays once and never again.
    */
    #[test]
    fn the_offered_set_grows_and_never_shrinks() {
        let mut session = session(Mode::Ask);

        let first = session.offer(vec!["read".into(), "grep".into()]);
        assert_eq!(names_in(&first), vec!["read", "grep"]);
        assert_eq!(session.offered(), (2, tools::specs().len()));

        // The same answer again is the same bytes, which is the whole
        // point: an unchanged prefix is a cached one.
        let again = session.offer(vec!["grep".into(), "read".into()]);
        assert_eq!(first, again);

        // A narrower answer takes nothing away. The model has already
        // seen these, and shrinking would thrash the cache for nothing.
        let narrower = session.offer(vec!["read".into()]);
        assert_eq!(first, narrower);

        // A wider one grows, once.
        let wider = session.offer(vec!["bash".into()]);
        assert_eq!(names_in(&wider), vec!["read", "grep", "bash"]);
        assert_eq!(session.offered().0, 3);
    }

    #[test]
    fn a_name_the_surface_does_not_have_is_ignored() {
        // A router answering about a tool that is not on the table, or
        // about one this surface is not given. The schema is built
        // from the registry, so there is nothing to put in it.
        let mut session = session(Mode::Ask);
        let offered = session.offer(vec!["read".into(), "summon".into()]);
        assert_eq!(names_in(&offered), vec!["read"]);
    }

    /// In registry order, which is what keeps two sessions sharing a
    /// prefix: a set assembled in the order a router happened to
    /// mention things would be different bytes for the same tools.
    #[test]
    fn the_schema_is_in_registry_order_whatever_order_it_was_picked_in() {
        let mut backwards = session(Mode::Ask);
        let mut forwards = session(Mode::Ask);
        assert_eq!(
            backwards.offer(vec!["bash".into(), "edit".into(), "read".into()]),
            forwards.offer(vec!["read".into(), "edit".into(), "bash".into()])
        );
    }

    fn names_in(schema: &Value) -> Vec<String> {
        schema
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
            .collect()
    }

    #[tokio::test]
    async fn the_default_picker_offers_the_whole_registry_unchanged() {
        // Narrowing per turn would change the first bytes of the request,
        // which is the worst place to change bytes.
        let picker = OfferEverything(Surface::Window);
        let first = picker.tools_for("anything").await;
        let second = picker.tools_for("something else").await;
        assert_eq!(first, second);
        assert_eq!(first.names.len(), tools::specs().len());
        assert_eq!(first.cost_usd, 0.0, "the default picker is a constant");
    }

    #[tokio::test]
    async fn a_panel_session_is_offered_the_panel_s_tools() {
        let offered = OfferEverything(Surface::Panel).tools_for("fix this").await;
        assert_eq!(offered.names, tools::PANEL_TOOLS);
        assert!(
            offered.names.len() < tools::specs().len(),
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

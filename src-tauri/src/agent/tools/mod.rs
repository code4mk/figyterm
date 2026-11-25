//! The tool registry: what the model is offered, and what runs when it picks
//! one.
//!
//! Every tool is one implementation of [`Tool`], which answers two questions
//! and nothing else — *how do I describe myself to a model* and *what happens
//! when I am called*. The registry turns the first into the JSON the provider
//! wants and the second into a dispatch by name.
//!
//! ## The wire format is OpenAI's
//!
//! ```json
//! { "type": "function",
//!   "function": { "name": "read", "description": "…", "parameters": { … } } }
//! ```
//!
//! Not because it is the best shape, but because it is the one every provider
//! and every router speaks. **The model does its own tool picking**, which
//! is what this format is for; a router choosing on its behalf would consume
//! the same schema through the same seam, and `TASKS.md` section 3 has the
//! arithmetic for why none does. The short version is that this whole block
//! is 3.8K tokens read from cache at a tenth of a cent, and anything that
//! varies it per turn pays full price for it and for every byte after it.
//!
//! ## Two things about the spec that are easy to get wrong
//!
//! **The description is the API.** The model never sees the implementation,
//! so a parameter with no description is a parameter that gets guessed. The
//! other half of that: every byte of every description sits in the cached
//! prefix of every request for the whole session, so a three-paragraph
//! description is three paragraphs paid for on every turn.
//!
//! **The set must be decided once per session and then frozen.** Order on the
//! wire is `tools → system → messages`, and caching is a prefix match: any
//! byte that changes invalidates everything after it. A registry that grew a
//! tool when a language server came up would rewrite the cache on the turn it
//! happened, which is a bill nobody can trace back to the cause.

pub mod bash;
pub mod edit;
pub mod fsops;
pub mod git;
pub mod grep;
pub mod ls;
pub mod lsp;
pub mod output;
pub mod plan;
pub mod ask;
pub mod read;
pub mod task;
pub mod todo;
pub mod web;
pub mod write;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use crate::agent::ledger::Surface;

/// What a tool does to the world, which is what a permission prompt is about.
///
/// Not a severity. It decides which question the window asks and what
/// "accept edits for this session" actually accepts — a mode that silently
/// also accepted `exec` would be a mode nobody could grant safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    /// Reads the project. Never asks.
    Read,
    /// Changes a file. Asks, unless the session says otherwise.
    Write,
    /// Runs a program. Asks every time until told otherwise per command.
    Exec,
    /// Leaves the machine. Asks every time, with the URL shown.
    Net,
}

/// How a tool presents itself to the model.
#[derive(Debug, Clone, Serialize)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema for the arguments, as the provider expects it.
    pub parameters: Value,
    pub class: Class,
}

impl ToolSpec {
    /// The OpenAI-compatible form, which is what goes on the wire.
    pub fn as_openai(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": with_why(self.parameters.clone()),
            }
        })
    }
}

/// Every tool takes a `why`, added here rather than written out
/// twenty-four times.
///
/// A transcript of `Read`, `Grep`, `Read`, `Bash` says what happened
/// and not what for, and the row the person is looking at the
/// longest — a two-minute build — is the one that says least. So the
/// model names its own reason, in four or five words, and the window
/// shows that where it would have shown a path.
///
/// **It is not free**, and the measurement is why the sentence below
/// is as short as it is. Written out properly — what to put in it,
/// with examples — it cost 1,631 tokens of prefix across twenty-four
/// schemas, which is a 43% increase in the block that is re-sent on
/// every request of the session. Said tersely here and explained
/// once in the system prompt: 659.
///
/// That is the whole principle for anything that goes in a schema: a
/// line here is paid per tool, a line in the preamble is paid once,
/// and the two read identically to the model.
///
/// Optional, always. A tool call that arrives without one still runs;
/// the row falls back to the path or the command, which is what it
/// showed before this existed.
fn with_why(mut parameters: Value) -> Value {
    let Some(object) = parameters.as_object_mut() else {
        return parameters;
    };
    let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) else {
        return parameters;
    };
    properties.insert(
        "why".to_string(),
        json!({
            "type": "string",
            "description": "Four or five words on what this call is for, for the person watching."
        }),
    );
    parameters
}

/// What a tool is given, and nothing more.
///
/// Deliberately not the window, the app handle or the store. A tool that can
/// reach the rest of the process is a tool whose blast radius is the rest of
/// the process, and every one of them would have to be read with that in
/// mind. Anything a tool genuinely needs is added here, explicitly, once —
/// which so far is two things.
///
/// The shell is optional, and that is how the editor panel gets a narrower
/// tool set: not by remembering to leave `bash` out of a list, but by having
/// nowhere to run it. A tool that needs one and has none says so and stops.
/// The bridge to the language server is the same arrangement, for a
/// different reason: it needs a live window on the other end.
/// Somewhere to put a line while a tool is still running.
///
/// A build takes two minutes and used to show nothing at all until it
/// was over — a spinner, and then two hundred lines at once. The
/// output existed the whole time; the window simply had no way to be
/// handed it, because a tool answers once and answers at the end.
///
/// So tools that produce output as they go take this and use it. It
/// is not the result: nothing sent here reaches the model, which
/// still gets the whole thing in one piece when the tool returns.
/// This is for the person watching.
pub trait Progress: Send + Sync {
    fn line(&self, text: &str);
}

#[derive(Clone)]
pub struct ToolContext {
    pub root: PathBuf,
    /// Folders the window may also reach. See `workspace.rs` — these
    /// were a label in the settings and nothing in the enforcement
    /// for a while, which is the worst way for a permission to exist.
    pub extra: Vec<PathBuf>,
    pub shell: Option<Arc<dyn crate::agent::shell::Shell>>,
    pub lsp: Option<Arc<dyn crate::agent::code::Lsp>>,
    pub web: Option<Arc<dyn crate::agent::web::Web>>,
    pub asker: Option<Arc<dyn crate::agent::ask::Asker>>,
    pub delegate: Option<Arc<dyn crate::agent::delegate::Delegate>>,
    /// Where a long tool puts its output while it is still going.
    /// Bound per call by the loop, because it carries the call's id.
    pub progress: Option<Arc<dyn Progress>>,
    /// Which surface this turn belongs to — `"window"` or `"panel"`.
    ///
    /// Only background jobs use it, and only to record who started
    /// one: both surfaces watch the same shell, so without an owner
    /// both would report the same finished build to their own model.
    pub surface: String,
}

impl ToolContext {
    /// A context that can read and write, and cannot run or ask anything.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            extra: Vec::new(),
            shell: None,
            lsp: None,
            web: None,
            asker: None,
            delegate: None,
            progress: None,
            // The window unless told otherwise, which is what a test
            // and a one-off `agent_call_tool` both are.
            surface: "window".into(),
        }
    }

    /// Which surface this turn is for. See the field.
    pub fn with_surface(mut self, surface: &str) -> Self {
        self.surface = surface.to_string();
        self
    }

    pub fn with_extra(mut self, extra: Vec<PathBuf>) -> Self {
        self.extra = extra;
        self
    }

    pub fn with_shell(mut self, shell: Arc<dyn crate::agent::shell::Shell>) -> Self {
        self.shell = Some(shell);
        self
    }

    pub fn with_lsp(mut self, lsp: Arc<dyn crate::agent::code::Lsp>) -> Self {
        self.lsp = Some(lsp);
        self
    }

    pub fn with_web(mut self, web: Arc<dyn crate::agent::web::Web>) -> Self {
        self.web = Some(web);
        self
    }

    pub fn with_asker(mut self, asker: Arc<dyn crate::agent::ask::Asker>) -> Self {
        self.asker = Some(asker);
        self
    }

    pub fn with_delegate(mut self, delegate: Arc<dyn crate::agent::delegate::Delegate>) -> Self {
        self.delegate = Some(delegate);
        self
    }

    pub fn with_progress(mut self, progress: Arc<dyn Progress>) -> Self {
        self.progress = Some(progress);
        self
    }

    /// Reports a line, if anybody is listening. Tools call this
    /// freely: with no listener it costs a branch.
    pub fn progress(&self, line: &str) {
        if let Some(progress) = &self.progress {
            progress.line(line);
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Everything this context may touch: the root, then the extras.
    pub fn roots(&self) -> Vec<PathBuf> {
        let mut all = vec![self.root.clone()];
        all.extend(self.extra.iter().cloned());
        all
    }

    /// A tool's path argument, turned into one it may act on.
    ///
    /// Every file tool goes through this rather than through
    /// `resolve_in(ctx.root(), …)`, which is what they all used to do
    /// and what made the extra folders unreachable: the check was
    /// against one folder because the context only had one.
    pub fn resolve(&self, raw: &str) -> Result<PathBuf, ToolError> {
        if self.extra.is_empty() {
            return crate::agent::workspace::resolve_in(&self.root, raw);
        }
        crate::agent::workspace::resolve_within(&self.roots(), raw)
    }

    /// What to call a path in a result: relative to the project, or
    /// prefixed with the extra folder's name.
    pub fn display(&self, path: &Path) -> String {
        if self.extra.is_empty() {
            return crate::agent::workspace::display_path(&self.root, path);
        }
        crate::agent::workspace::display_within(&self.roots(), path)
    }

    /// The shell, or the sentence a tool returns when there is none.
    pub fn shell(&self) -> Result<&dyn crate::agent::shell::Shell, ToolError> {
        self.shell
            .as_deref()
            .ok_or_else(|| "Commands cannot be run from here.".to_string())
    }

    /// The language-server bridge, or the reason there is not one.
    ///
    /// Phrased as a fact about this session rather than as a failure: the
    /// model should fall back to `grep` and carry on, not retry.
    pub fn lsp(&self) -> Result<&dyn crate::agent::code::Lsp, ToolError> {
        self.lsp.as_deref().ok_or_else(|| {
            "no language server is available in this session — use grep instead".to_string()
        })
    }

    /// The search provider, or why there is not one.
    pub fn web(&self) -> Result<&dyn crate::agent::web::Web, ToolError> {
        self.web
            .as_deref()
            .ok_or_else(|| "no Exa key is set, so the web is unreachable from here".to_string())
    }

    /// The sub-agent, or why there is not one.
    ///
    /// Absent inside a sub-agent, which is the point: a tree of them has
    /// no bottom and the bill has no ceiling.
    pub fn delegate(&self) -> Result<&dyn crate::agent::delegate::Delegate, ToolError> {
        self.delegate.as_deref().ok_or_else(|| {
            "no sub-agent is available here — read the project yourself".to_string()
        })
    }

    /// The person, or the reason they cannot be reached.
    ///
    /// Phrased as what to do instead: a model told "ask in your answer"
    /// ends the turn with a question, which is the fallback this tool
    /// exists to improve on rather than replace.
    pub fn asker(&self) -> Result<&dyn crate::agent::ask::Asker, ToolError> {
        self.asker.as_deref().ok_or_else(|| {
            "nobody can be asked from here — put the question in your answer instead"
                .to_string()
        })
    }
}

/// What a call produced.
///
/// `text` is what the model is shown and pays for. `detail` is for the window
/// — a diff to render, the matches to list — and never crosses into the
/// conversation, which is the whole reason the two are separate fields.
#[derive(Debug, Clone, Serialize)]
pub struct ToolOutput {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }
}

/// A failure, phrased for the model.
///
/// It goes back as the tool result, so it is one short line and, where there
/// is one, a next step: `no such file: src/mian.rs — did you mean
/// src/main.rs?` beats fifty lines of backtrace and costs one percent of it.
pub type ToolError = String;

pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError>;
}

/// The editor panel's old tool set, kept as a record of a decision that
/// was reversed.
///
/// `TOOLS.md` argued the panel was a different product from the window
/// rather than a smaller copy: "fix *this*, here" in one to five turns,
/// against "do this across the repo" in twenty to sixty. So it was given
/// seven tools — read, grep, edit, the three language-server ones and
/// `ask_user` — and no `bash`, no git, nothing on the network.
///
/// The argument was not wrong about what a *panel* is. It was wrong about
/// who decides. In practice the panel is where somebody already has the
/// file open, and the question that starts there does not stay inside the
/// buffer: "why does this test fail" needs to run the test, and a panel
/// that answers "open the FigyCode window and ask again" has made the
/// person do the routing. The cost it was protecting — a two-minute wait
/// in a sidebar — is a cost they can see and stop with Escape.
///
/// What actually keeps the panel cheap was never this list. It is the
/// seed: the open file and the selection go in the first message, so the
/// panel's turns start with the context the window spends a round trip
/// discovering. That is still true, and it is in `figycode-panel.ts`.
///
/// Left here because the next person to wonder "why does the panel have
/// `git_commit`" deserves the whole argument rather than its conclusion.
/// Nothing reads it.
#[allow(dead_code)]
pub const PANEL_TOOLS_WAS: &[&str] = &[
    "read",
    "grep",
    "edit",
    "definition",
    "references",
    "diagnostics",
    "ask_user",
];

/// The tools a session is always offered, however it was narrowed.
///
/// A router answers about the message in front of it, and a session is
/// longer than one message. Somebody who opens with "explain this
/// file" will ask a second question, and a set picked from the first
/// one that could not read a second file would be a cage rather than a
/// saving.
///
/// So: reading, searching, and the two that are about the conversation
/// rather than the project. They are also the cheap ones — the floor
/// is about a third of the registry's tokens, not a third of its
/// power.
pub const FLOOR: &[&str] = &["read", "grep", "ls", "todo_write", "ask_user"];

/// What a sub-agent may use.
///
/// Read, and nothing else. `delegate.rs` has the argument in full; the
/// short version is that a sub-agent's conversation is thrown away, so
/// anything it changed would reach the parent as a sentence claiming a
/// change — no diff, no path, no row to open. It also has nobody to ask
/// and must not be able to spawn another of itself.
pub const SUB_TOOLS: &[&str] = &[
    "read",
    "grep",
    "ls",
    "definition",
    "references",
    "diagnostics",
];

/// Every tool, in a fixed order.
///
/// The order is part of the cache prefix, so it is the declaration order here
/// and never a sort by anything that could change.
pub fn registry() -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(read::Read),
        Box::new(grep::Grep),
        Box::new(edit::Edit),
        Box::new(write::Write),
        Box::new(ls::Ls),
        Box::new(fsops::Move),
        Box::new(fsops::Delete),
        Box::new(bash::Bash),
        Box::new(bash::BashOutput),
        // Beside the one it replaces in practice: `bash_output` is a
        // glance and this is the wait, and a model that has both stops
        // polling.
        Box::new(bash::BashWait),
        Box::new(bash::BashKill),
        Box::new(lsp::Definition),
        Box::new(lsp::References),
        Box::new(lsp::Diagnostics),
        Box::new(web::SearchWeb),
        Box::new(web::FetchUrl),
        Box::new(git::Status),
        Box::new(git::Diff),
        Box::new(git::Log),
        Box::new(git::Blame),
        Box::new(git::Show),
        Box::new(git::Commit),
        Box::new(todo::TodoWrite),
        Box::new(ask::AskUser),
        Box::new(plan::Plan),
        Box::new(task::Task),
    ]
}

pub fn specs() -> Vec<ToolSpec> {
    registry().iter().map(|tool| tool.spec()).collect()
}

/// What this surface is offered, in the registry's order.
///
/// Every surface gets everything. The panel was once given seven of
/// these — `PANEL_TOOLS_WAS` has that argument and why it was dropped.
///
/// The function stays rather than collapsing into `specs()`, and not out
/// of sentiment: it is the one place a surface's set is decided, every
/// caller goes through it, and the *next* reason to narrow a set will not
/// be the last one. It is also the seam the tool picker's fallback uses.
///
/// Decided once, at session start, and then frozen — the tool list is the
/// *first* thing in the request and caching is a prefix match, so a set
/// that varied per turn would rewrite the cache on the turn it varied.
pub fn specs_for(_surface: Surface) -> Vec<ToolSpec> {
    specs()
}

/// The whole set as the provider wants it.
pub fn openai_tools() -> Value {
    Value::Array(specs().iter().map(ToolSpec::as_openai).collect())
}

/// A named subset, in the registry's order.
///
/// For the sub-agent, which is not a surface: it is a different
/// conversation with a different prefix, and the order still has to be
/// the registry's so two sub-agents in one session share a cache.
pub fn openai_tools_named(names: &[&str]) -> Value {
    Value::Array(
        specs()
            .iter()
            .filter(|spec| names.contains(&spec.name))
            .map(ToolSpec::as_openai)
            .collect(),
    )
}

pub fn openai_tools_for(surface: Surface) -> Value {
    Value::Array(specs_for(surface).iter().map(ToolSpec::as_openai).collect())
}

/// Runs the tool the model asked for.
///
/// An unknown name is a tool result rather than a hard error: a model that
/// invents a tool should be told so in the conversation, where it can try
/// something else, rather than having the turn fail underneath it.
pub fn call(ctx: &ToolContext, name: &str, args: &Value) -> Result<ToolOutput, ToolError> {
    for tool in registry() {
        if tool.spec().name == name {
            return tool.call(ctx, args);
        }
    }
    Err(format!(
        "no tool called `{name}`. Available: {}",
        specs()
            .iter()
            .map(|s| s.name)
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/* ─── Argument helpers ───────────────────────────────────────────────────── */

/// A required string argument.
///
/// Phrased as advice rather than as a type error, because the reader is a
/// model that is about to try again: `read: "path" is required` is actionable
/// where `invalid type: null, expected a string` is a stack trace.
pub fn arg_str(args: &Value, key: &str, tool: &str) -> Result<String, ToolError> {
    match args.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.clone()),
        Some(Value::String(_)) | None => Err(format!("{tool}: `{key}` is required")),
        Some(other) => Err(format!(
            "{tool}: `{key}` must be a string, not {}",
            kind_of(other)
        )),
    }
}

/// An optional positive integer, clamped rather than refused.
///
/// A model that asks for ten thousand lines has not made an error worth a
/// round trip; it has asked for more than it may have, and the honest answer
/// is the maximum plus a note that it was capped.
pub fn arg_usize(args: &Value, key: &str, default: usize, max: usize) -> usize {
    match args.get(key) {
        Some(Value::Number(n)) => n
            .as_u64()
            .map(|v| (v as usize).clamp(1, max))
            .unwrap_or(default),
        // Models hand back "200" as often as 200.
        Some(Value::String(s)) => s
            .trim()
            .parse::<usize>()
            .map(|v| v.clamp(1, max))
            .unwrap_or(default),
        _ => default,
    }
}

pub fn arg_bool(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_described_well_enough_to_be_picked() {
        for spec in specs() {
            assert!(!spec.name.is_empty());
            assert!(
                spec.description.len() > 40,
                "{} needs a description a model can choose on",
                spec.name
            );
            assert_eq!(spec.parameters["type"], "object");
            /*
              Every property is described: an undescribed parameter is one
              the model guesses at.

              No properties at all is fine — `git_status` asks nothing —
              and this used to insist on at least one, which is a rule
              about the tools we happened to have rather than about tools.
            */
            let props = spec.parameters["properties"].as_object().unwrap();
            for (key, schema) in props {
                assert!(
                    schema.get("description").is_some(),
                    "{}.{key} has no description",
                    spec.name
                );
            }
        }
    }

    #[test]
    fn every_surface_is_offered_every_tool() {
        /*
          The panel used to get seven of these, and the symptom was a
          sidebar that answered "I cannot run commands — open the
          FigyCode window". Both surfaces are offered the same set now;
          `PANEL_TOOLS_WAS` holds the argument that was.
        */
        let all: Vec<&str> = specs().iter().map(|s| s.name).collect();
        for surface in [Surface::Window, Surface::Panel] {
            let offered: Vec<&str> = specs_for(surface).iter().map(|s| s.name).collect();
            assert_eq!(offered, all, "{surface:?} is not offered everything");
        }
    }

    #[test]
    fn the_things_a_panel_needed_a_window_for_are_in_its_set() {
        // The four the old list left out, which is what sent somebody
        // to the other surface mid-question.
        let panel: Vec<&str> = specs_for(Surface::Panel).iter().map(|s| s.name).collect();
        for present in ["bash", "git_commit", "write", "todo_write"] {
            assert!(panel.contains(&present), "the panel should have {present}");
        }
    }

    #[test]
    fn a_surface_sees_the_same_tools_in_the_same_order_every_time() {
        // It is the first thing in the cache prefix.
        let first = openai_tools_for(Surface::Panel);
        let second = openai_tools_for(Surface::Panel);
        assert_eq!(first, second);
    }

    #[test]
    fn no_two_tools_share_a_name() {
        let mut names: Vec<&str> = specs().iter().map(|s| s.name).collect();
        let before = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), before);
    }

    #[test]
    fn the_wire_form_is_what_an_openai_provider_expects() {
        let tools = openai_tools();
        let first = &tools[0];
        assert_eq!(first["type"], "function");
        assert!(first["function"]["name"].is_string());
        assert!(first["function"]["parameters"]["type"] == "object");
    }

    #[test]
    fn the_order_is_the_declaration_order_and_not_sorted() {
        // It is part of the cache prefix; a sort would reorder it the day
        // somebody renames a tool.
        let names: Vec<&str> = specs().iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            vec![
                "read", "grep", "edit", "write", "ls", "move", "delete", "bash",
                "bash_output", "bash_wait", "bash_kill", "definition", "references",
                "diagnostics",
                "search_web", "fetch_url", "git_status", "git_diff", "git_log",
                "git_blame", "git_show", "git_commit", "todo_write", "ask_user", "plan",
                "task"
            ]
        );
    }

    #[test]
    fn an_invented_tool_is_answered_rather_than_thrown() {
        let ctx = ToolContext::new(PathBuf::from("/tmp"));
        let err = call(&ctx, "summon", &json!({})).unwrap_err();
        assert!(err.contains("no tool called `summon`"));
        // And it is told what there is, so the next turn is not another guess.
        assert!(err.contains("read"));
    }

    #[test]
    fn a_missing_string_argument_is_named() {
        let err = arg_str(&json!({}), "path", "read").unwrap_err();
        assert_eq!(err, "read: `path` is required");
    }

    #[test]
    fn a_wrong_type_says_what_it_got() {
        let err = arg_str(&json!({ "path": 7 }), "path", "read").unwrap_err();
        assert!(err.contains("must be a string, not a number"));
    }

    #[test]
    fn numbers_are_clamped_rather_than_refused() {
        assert_eq!(arg_usize(&json!({ "limit": 10_000 }), "limit", 200, 1000), 1000);
        assert_eq!(arg_usize(&json!({ "limit": 0 }), "limit", 200, 1000), 1);
        assert_eq!(arg_usize(&json!({}), "limit", 200, 1000), 200);
    }

    #[test]
    fn a_number_sent_as_a_string_still_counts() {
        // Models do this constantly, and refusing it costs a whole turn.
        assert_eq!(arg_usize(&json!({ "limit": "50" }), "limit", 200, 1000), 50);
        assert!(arg_bool(&json!({ "all": "true" }), "all"));
    }
}

#[cfg(test)]
mod prefix_cost {
    use super::*;

    /// What the tool list costs before anybody has said anything.
    ///
    /// This number is the whole argument about tool picking. Every
    /// definition sits in the cached prefix of every request for the
    /// session, so it is paid once at full price and then at the
    /// cache-read rate — and anything that *varies* it per turn pays
    /// the full price again, for the definitions and for every byte
    /// after them.
    ///
    /// The ceiling is a regression guard rather than a target. A tool
    /// whose description grows by three paragraphs is a bill nobody
    /// traces back to the commit that wrote them.
    /*
      Every schema is one a provider will accept.

      This exists because of a 400 that reached a user: `git_commit`
      had its `message` field renamed to `subject` and `required`
      was left pointing at the old name. The schema was then a
      contract demanding a key it did not define, which a strict
      endpoint rejects for the whole request — so the tool was not
      merely broken, *every* turn was, with an error naming
      `oneOf`/`anyOf` and nothing that was actually wrong.

      Nothing in Rust was going to catch it: the schemas are
      `json!` literals, and a `required` list is a list of strings
      that match nothing in particular. So they are checked here,
      where a rename is cheap to notice.
    */
    #[test]
    fn every_required_argument_is_one_the_schema_defines() {
        for spec in specs() {
            let parameters = spec.as_openai()["function"]["parameters"].clone();
            let properties = parameters["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("{}: parameters have no properties", spec.name))
                .clone();

            for required in parameters["required"].as_array().unwrap_or(&Vec::new()) {
                let name = required.as_str().unwrap_or_default();
                assert!(
                    properties.contains_key(name),
                    "{}: `{name}` is required and not defined — a strict endpoint \
                     refuses the whole request for this, not just the tool",
                    spec.name
                );
            }
        }
    }

    /// The shape OpenAI-compatible endpoints insist on at the top.
    #[test]
    fn every_schema_is_a_plain_object_at_the_top_level() {
        for spec in specs() {
            let parameters = spec.as_openai()["function"]["parameters"].clone();
            assert_eq!(
                parameters["type"], "object",
                "{}: the top level must be an object",
                spec.name
            );
            for forbidden in ["oneOf", "anyOf", "allOf", "not", "enum", "const"] {
                assert!(
                    parameters.get(forbidden).is_none(),
                    "{}: `{forbidden}` at the top level is refused",
                    spec.name
                );
            }
        }
    }

    #[test]
    fn the_tool_definitions_stay_small_enough_to_offer_all_of_them() {
        let window = output::approx_tokens(&openai_tools().to_string());
        let panel = output::approx_tokens(&openai_tools_for(Surface::Panel).to_string());
        println!("tool definitions: window {window} tokens, panel {panel} tokens");

        /*
          This is the bound that matters now that both surfaces carry
          the whole registry. It sits in the cached prefix of every
          request on both of them, so growing it is paid for twice —
          and past about six thousand tokens, narrowing per session
          starts to be worth its complexity.
        */
        assert!(
            window < 6000,
            "the tool definitions are {window} tokens — past this, picking a \
             subset per session starts to be worth its complexity"
        );
        assert_eq!(panel, window, "both surfaces carry the same prefix");
    }
}

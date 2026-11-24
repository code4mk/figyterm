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
//! and every router speaks. Tool *picking* goes through typesafe.ai, which
//! consumes the same schema — so the model choosing directly and a router
//! choosing on its behalf are the same code path, and swapping one for the
//! other is a change of transport rather than of tool.
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
pub mod grep;
pub mod ls;
pub mod output;
pub mod read;
pub mod write;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

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
                "parameters": self.parameters,
            }
        })
    }
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
pub struct ToolContext {
    pub root: PathBuf,
    pub shell: Option<Arc<dyn crate::agent::shell::Shell>>,
}

impl ToolContext {
    /// A context that can read and write, and cannot run anything.
    pub fn new(root: PathBuf) -> Self {
        Self { root, shell: None }
    }

    pub fn with_shell(mut self, shell: Arc<dyn crate::agent::shell::Shell>) -> Self {
        self.shell = Some(shell);
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The shell, or the sentence a tool returns when there is none.
    pub fn shell(&self) -> Result<&dyn crate::agent::shell::Shell, ToolError> {
        self.shell
            .as_deref()
            .ok_or_else(|| "Commands cannot be run from here.".to_string())
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
        Box::new(bash::BashKill),
    ]
}

pub fn specs() -> Vec<ToolSpec> {
    registry().iter().map(|tool| tool.spec()).collect()
}

/// The whole set as the provider wants it.
pub fn openai_tools() -> Value {
    Value::Array(specs().iter().map(ToolSpec::as_openai).collect())
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
            // Every property is described: an undescribed parameter is one
            // the model guesses at.
            let props = spec.parameters["properties"].as_object().unwrap();
            assert!(!props.is_empty(), "{} has no parameters", spec.name);
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
                "bash_output", "bash_kill"
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

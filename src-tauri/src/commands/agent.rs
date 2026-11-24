//! The agent's IPC surface.
//!
//! Two commands, and deliberately only two until there is a loop to run:
//! *what tools are there* and *run one*. They exist before the model does so
//! the tools can be exercised for real — from the window, from a test, by
//! hand — rather than being written blind against a provider that is also
//! being written.
//!
//! `agent_call_tool` is **not** how the agent will call tools. The loop will
//! dispatch in-process, because a turn is a dozen calls and a round trip
//! through IPC per call is latency for nothing. This is the development
//! surface, and when the loop lands it stays exactly as useful: a way to ask
//! "what does `grep` actually return for that?" without a model in the way.

use serde::Serialize;
use serde_json::Value;
use tauri::{State, Window};

use crate::agent::tools::{self, ToolContext};
use crate::agent::workspace::Workspace;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub class: String,
    /// The OpenAI-compatible definition, exactly as it goes on the wire.
    pub schema: Value,
}

/// Every tool, in the order the prefix will hold them.
#[tauri::command]
pub fn agent_tools() -> Vec<ToolInfo> {
    tools::specs()
        .into_iter()
        .map(|spec| ToolInfo {
            name: spec.name.to_string(),
            description: spec.description.to_string(),
            class: serde_json::to_value(spec.class)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default(),
            schema: spec.as_openai(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// What the model would be shown, and pay for on every later turn.
    pub text: String,
    /// What the window can render instead. Never enters the conversation.
    pub detail: Option<Value>,
    /// Roughly what `text` costs, so the cost of a tool is visible while it
    /// is being designed rather than after a thousand turns of it.
    pub approx_tokens: usize,
}

/// Runs one tool against the folder this window has open.
///
/// A tool failure comes back as `Err`, and the string in it is the same one
/// the model would be handed — short, and with a next step where there is
/// one. Seeing it in the window is the point: an error a person finds
/// confusing is an error the model will loop on.
#[tauri::command(async)]
pub fn agent_call_tool(
    window: Window,
    workspace: State<Workspace>,
    name: String,
    args: Value,
) -> Result<ToolResult, String> {
    let root = workspace
        .root(window.label())
        .ok_or_else(|| "No folder is open in FigyCode".to_string())?;

    let ctx = ToolContext { root };
    let out = tools::call(&ctx, &name, &args)?;
    Ok(ToolResult {
        approx_tokens: tools::output::approx_tokens(&out.text),
        text: out.text,
        detail: out.detail,
    })
}

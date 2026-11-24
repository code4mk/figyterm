//! `todo_write(items)` — the plan, where both of us can see it.
//!
//! `TOOLS.md`: **this is not decoration.** On a twenty-turn task the list is
//! the only thing keeping the model's own intent in the prefix without
//! re-stating it in prose every turn. An agent four tool calls deep in step
//! three has, in its context, forty thousand tokens of file contents and no
//! sentence anywhere saying what it set out to do — which is how a run ends
//! having fixed the test it was looking at and forgotten the two it was
//! asked about.
//!
//! It is also the window's best status display, and the two uses are the
//! same object: the text goes to the model, the `detail` goes to the
//! window, and there is no third copy for either to disagree with.
//!
//! ## No state on this side
//!
//! The tool stores nothing. Each call carries the **whole** list, and the
//! last one wins — which is not laziness, it is the only version that
//! survives the thing this is for. A server-side list mutated by `add` and
//! `complete` would be a second source of truth that a compaction, a
//! resume, or a retried turn could silently desynchronise from the
//! conversation the model is actually reading.
//!
//! ## One thing at a time
//!
//! At most one item may be `running`. The rule is cheap to enforce and it
//! is the whole value of the list: a plan where four things are in progress
//! is a plan that has stopped being a sequence, and a model that is allowed
//! to say so will do it rather than choose.

use serde_json::{json, Value};

use super::{Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};

/// More than this is not a plan, it is a backlog. The model can write the
/// next twenty when it has done these.
const MAX_ITEMS: usize = 20;

/// One line, not a paragraph. The list is re-sent on every later turn.
const MAX_CHARS: usize = 140;

pub struct TodoWrite;

impl Tool for TodoWrite {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "todo_write",
            description:
                "Write down the plan for a task with several steps, and keep it up to \
                 date as you go. Send the whole list every time: the last call replaces \
                 the one before it. Use it when a request needs more than two or three \
                 steps — it keeps the plan in front of both of us, and the person can \
                 see where you are. Mark exactly one item `running` while you work on \
                 it, and call this again the moment it is done.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description":
                            "The whole plan, in order, replacing any earlier one.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {
                                    "type": "string",
                                    "description":
                                        "The step, as one short line: what will be \
                                         true when it is done."
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "running", "done"],
                                    "description":
                                        "`running` for the one you are on — at most \
                                         one at a time."
                                }
                            },
                            "required": ["text", "status"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["items"],
                "additionalProperties": false
            }),
            // Nothing outside the conversation changes, so there is nobody
            // to ask. A permission prompt for writing down a plan would
            // teach people to approve without reading.
            class: Class::Read,
        }
    }

    fn call(&self, _ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let items = parse(args)?;

        let done = items.iter().filter(|i| i.status == Status::Done).count();
        let running = items.iter().filter(|i| i.status == Status::Running).count();
        if running > 1 {
            return Err(
                "todo_write: only one item can be `running`. Pick the one you are \
                 working on now and leave the rest `pending`."
                    .into(),
            );
        }

        /*
          What the model reads back.

          Terse on purpose: this result is in the conversation for the rest
          of the session, and so is the next one, and the one after that. A
          twenty-turn task updating a six-item list is twenty copies of it —
          at one line each that is affordable and worth it, and at a
          paragraph each it is the most expensive thing in the session.
        */
        let lines: Vec<String> = items
            .iter()
            .map(|item| format!("{} {}", item.status.glyph(), item.text))
            .collect();
        let text = format!(
            "{} of {} done\n{}\n",
            done,
            items.len(),
            lines.join("\n")
        );

        Ok(ToolOutput::text(text).with_detail(json!({
            "items": items
                .iter()
                .map(|item| json!({ "text": item.text, "status": item.status.as_str() }))
                .collect::<Vec<_>>(),
            "done": done,
        })))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Pending,
    Running,
    Done,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Running => "running",
            Status::Done => "done",
        }
    }

    /// For the model's copy. The window draws its own.
    fn glyph(self) -> char {
        match self {
            Status::Pending => '○',
            Status::Running => '▸',
            Status::Done => '✓',
        }
    }

    /*
      The spellings other agents use are accepted too.

      A model that has written `in_progress` ten thousand times will write
      it here, and refusing it buys nothing: the turn is spent, the plan is
      lost, and the model's next move is to guess again. Taking the synonym
      costs one match arm.
    */
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pending" | "todo" | "open" => Some(Status::Pending),
            "running" | "in_progress" | "in-progress" | "active" | "doing" => {
                Some(Status::Running)
            }
            "done" | "completed" | "complete" | "finished" => Some(Status::Done),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Item {
    text: String,
    status: Status,
}

fn parse(args: &Value) -> Result<Vec<Item>, ToolError> {
    let raw = args
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "todo_write: `items` must be an array of steps.".to_string())?;

    if raw.is_empty() {
        return Err("todo_write: the list is empty. Send the steps, or do not call this \
                    tool."
            .into());
    }
    if raw.len() > MAX_ITEMS {
        return Err(format!(
            "todo_write: {} items is a backlog rather than a plan. Send at most \
             {MAX_ITEMS}, and write the next ones when these are done.",
            raw.len()
        ));
    }

    let mut items = Vec::with_capacity(raw.len());
    for (index, value) in raw.iter().enumerate() {
        let text = value
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| format!("todo_write: item {} has no `text`.", index + 1))?;

        let status = value
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("todo_write: item {} has no `status`.", index + 1))?;
        let status = Status::parse(status).ok_or_else(|| {
            format!(
                "todo_write: item {} has status `{status}`. Use `pending`, `running` \
                 or `done`.",
                index + 1
            )
        })?;

        items.push(Item {
            text: clip(text),
            status,
        });
    }
    Ok(items)
}

/// One line, cut on a character boundary.
fn clip(text: &str) -> String {
    // Newlines would break the one-line-per-item shape the window and the
    // model both read.
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_CHARS {
        return flat;
    }
    let kept: String = flat.chars().take(MAX_CHARS - 1).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ToolContext {
        ToolContext::new(std::env::temp_dir())
    }

    fn call(args: Value) -> Result<ToolOutput, ToolError> {
        TodoWrite.call(&ctx(), &args)
    }

    #[test]
    fn the_list_comes_back_as_text_for_the_model_and_detail_for_the_window() {
        let out = call(json!({ "items": [
            { "text": "read the handler", "status": "done" },
            { "text": "add the timeout", "status": "running" },
            { "text": "test it", "status": "pending" },
        ] }))
        .unwrap();

        assert!(out.text.starts_with("1 of 3 done"));
        assert!(out.text.contains("✓ read the handler"));
        assert!(out.text.contains("▸ add the timeout"));
        assert!(out.text.contains("○ test it"));

        let detail = out.detail.expect("the window needs the structured list");
        let items = detail["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1]["status"], "running");
        assert_eq!(detail["done"], 1);
    }

    /// The whole value of a list is that it is a sequence.
    #[test]
    fn two_things_at_once_is_refused_with_the_fix_in_the_message() {
        let error = call(json!({ "items": [
            { "text": "one", "status": "running" },
            { "text": "two", "status": "running" },
        ] }))
        .unwrap_err();
        assert!(error.contains("only one item can be `running`"));
        assert!(error.contains("Pick the one"));
    }

    #[test]
    fn the_spellings_other_agents_use_are_taken_rather_than_argued_with() {
        let out = call(json!({ "items": [
            { "text": "one", "status": "completed" },
            { "text": "two", "status": "in_progress" },
            { "text": "three", "status": "todo" },
        ] }))
        .unwrap();
        let detail = out.detail.unwrap();
        assert_eq!(detail["items"][0]["status"], "done");
        assert_eq!(detail["items"][1]["status"], "running");
        assert_eq!(detail["items"][2]["status"], "pending");
    }

    #[test]
    fn a_status_nobody_recognises_says_what_the_three_are() {
        let error = call(json!({ "items": [{ "text": "one", "status": "maybe" }] })).unwrap_err();
        assert!(error.contains("`pending`, `running` or `done`"), "{error}");
    }

    #[test]
    fn an_empty_list_is_refused_rather_than_drawn_as_an_empty_card() {
        assert!(call(json!({ "items": [] })).is_err());
    }

    #[test]
    fn a_backlog_is_refused_with_a_number_in_the_message() {
        let items: Vec<Value> = (0..MAX_ITEMS + 1)
            .map(|n| json!({ "text": format!("step {n}"), "status": "pending" }))
            .collect();
        let error = call(json!({ "items": items })).unwrap_err();
        assert!(error.contains("backlog"));
        assert!(error.contains(&MAX_ITEMS.to_string()));
    }

    #[test]
    fn an_item_is_one_line_however_it_arrives() {
        let out = call(json!({ "items": [
            { "text": "  fix the\n  wrapping   bug  ", "status": "pending" },
        ] }))
        .unwrap();
        assert!(out.text.contains("○ fix the wrapping bug"));
        assert_eq!(out.text.lines().count(), 2, "a header and one item");
    }

    /// A step written in Bengali is cut on a character, not a byte.
    #[test]
    fn a_long_item_in_a_non_latin_script_is_clipped_without_panicking() {
        let long = "প্রতিটি ".repeat(60);
        let out = call(json!({ "items": [{ "text": long, "status": "pending" }] })).unwrap();
        let item = out.detail.unwrap()["items"][0]["text"].as_str().unwrap().to_string();
        assert!(item.chars().count() <= MAX_CHARS);
        assert!(item.ends_with('…'));
    }
}

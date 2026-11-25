//! `task(prompt)` — hand a question to a sub-agent and get a paragraph.
//!
//! The economics are in `agent/delegate.rs` and come down to one
//! sentence from `TOOLS.md`: the forty files a sub-agent read to find the
//! answer never enter the main session's prefix, so they are never paid
//! for again.
//!
//! What this file adds is the description, which is most of whether the
//! tool works. A model that reaches for this when it should have run one
//! `grep` has turned a four-hundred-token lookup into a conversation; one
//! that never reaches for it reads twenty files into a context that will
//! carry them for the next fifty turns. The description has to draw that
//! line, and it does it with the only test that holds up: **is the answer
//! a paragraph, or is it the files?**

use serde_json::{json, Value};

use super::{arg_str, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};

pub struct Task;

impl Tool for Task {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "task",
            description:
                "Send a question to a sub-agent that can read the project, and get back \
                 a short written answer. Use it for anything whose answer is a \
                 paragraph but whose research is many files — \"which module owns \
                 retries, and does it honour the timeout?\", \"is this pattern used \
                 anywhere else?\". The sub-agent's reading is thrown away, so none of \
                 it is in your context afterwards; only its answer is. Do not use it \
                 when you need the file itself, when one grep would do, or when \
                 anything has to be changed — it can only read.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description":
                            "The question, in full. The sub-agent sees none of this \
                             conversation, so say what the project is, what you are \
                             doing and what you already know — and say what shape of \
                             answer you want back."
                    }
                },
                "required": ["prompt"],
                "additionalProperties": false
            }),
            // It reads, and what it returns is text. The sub-agent has no
            // tool that changes anything, so there is nothing here that a
            // permission card would be protecting.
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let delegate = ctx.delegate()?;
        let prompt = arg_str(args, "prompt", "task")?;

        if prompt.trim().chars().count() < MIN_PROMPT {
            return Err(format!(
                "task: the sub-agent cannot see this conversation, so a {MIN_PROMPT}-character \
                 brief is not enough to act on. Say what the question is and what you \
                 already know."
            ));
        }

        let outcome = delegate.run(&prompt)?;

        /*
          `costUsd` is the hook `session.rs` already reads for Exa.

          Reporting it here is what puts a sub-agent inside the parent's
          budget: without it the ceiling would cover every turn except
          the one that can spend the most.
        */
        Ok(
            ToolOutput::text(format!("{}\n", outcome.answer.trim())).with_detail(json!({
                "costUsd": outcome.cost_usd,
                "why": arg_str(args, "why", "task").unwrap_or_default(),
            })),
        )
    }
}

/// Short enough to allow a sharp question, long enough to exclude "find
/// the bug".
const MIN_PROMPT: usize = 24;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::delegate::{Delegate, Outcome};
    use std::sync::{Arc, Mutex};

    struct Scripted {
        answer: String,
        cost: f64,
        seen: Mutex<Option<String>>,
    }

    impl Delegate for Scripted {
        fn run(&self, prompt: &str) -> Result<Outcome, String> {
            *self.seen.lock().unwrap() = Some(prompt.to_string());
            Ok(Outcome {
                answer: self.answer.clone(),
                cost_usd: self.cost,
            })
        }
    }

    fn with(answer: &str, cost: f64) -> (ToolContext, Arc<Scripted>) {
        let scripted = Arc::new(Scripted {
            answer: answer.into(),
            cost,
            seen: Mutex::new(None),
        });
        let ctx = ToolContext::new(std::env::temp_dir())
            .with_delegate(Arc::clone(&scripted) as Arc<dyn Delegate>);
        (ctx, scripted)
    }

    const BRIEF: &str = "Which module owns retries, and does it honour the timeout?";

    #[test]
    fn the_answer_comes_back_and_so_does_what_it_cost() {
        let (ctx, _) = with("`src/net/api.rs:88` ignores the timeout.", 0.0132);
        let out = Task.call(&ctx, &json!({ "prompt": BRIEF })).unwrap();

        assert_eq!(out.text.trim(), "`src/net/api.rs:88` ignores the timeout.");
        // The hook the session reads for Exa, which is what puts a
        // sub-agent inside the parent's budget.
        assert_eq!(out.detail.unwrap()["costUsd"], 0.0132);
    }

    #[test]
    fn the_brief_goes_through_whole_because_it_is_all_the_sub_agent_sees() {
        let (ctx, scripted) = with("…", 0.0);
        Task.call(&ctx, &json!({ "prompt": BRIEF })).unwrap();
        assert_eq!(scripted.seen.lock().unwrap().clone().unwrap(), BRIEF);
    }

    #[test]
    fn a_brief_too_short_to_act_on_is_refused_with_the_reason() {
        let (ctx, _) = with("…", 0.0);
        let error = Task.call(&ctx, &json!({ "prompt": "find the bug" })).unwrap_err();
        assert!(error.contains("cannot see this conversation"));
    }

    #[test]
    fn with_no_sub_agent_available_the_model_is_told_to_look_itself() {
        let ctx = ToolContext::new(std::env::temp_dir());
        let error = Task.call(&ctx, &json!({ "prompt": BRIEF })).unwrap_err();
        assert!(error.contains("read the project yourself"), "{error}");
    }
}

//! `plan(steps, note)` — the way out of plan mode.
//!
//! `policy.rs` built the refusal half of plan mode on the first day: an
//! edit is declined with a sentence explaining the mode rather than a
//! "denied" the model would retry. What was missing was the other half.
//! A model that has read the codebase, worked out what to do, and written
//! it in prose has produced something nobody can *approve* — the person
//! reads a paragraph, agrees with it, and then has to say so in words,
//! change the mode by hand, and hope the model remembers what it just
//! proposed.
//!
//! This ends plan mode with an object: the steps, a card, and three ways
//! to answer. Approving it changes the mode in the running turn, so the
//! model carries on with the plan it just had agreed rather than waiting
//! for a new message to re-establish what it was doing.
//!
//! ## Why the options are the tool's and not the model's
//!
//! Unlike `ask_user`, the answers here are fixed. The tool has to know
//! what the answer *meant* — approved, approved and stop asking about
//! edits, or not approved — and comparing against labels it wrote itself
//! is the only version of that which cannot be broken by a model
//! phrasing an option differently.

use serde_json::{json, Value};

use super::{arg_str, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::agent::ask::Question;

const MAX_STEPS: usize = 12;
const MAX_CHARS: usize = 160;

/// The three answers, in the order they are offered.
///
/// Public because the window's answer comes back as one of these
/// strings, and `commands/agent.rs` reads it to know which mode the
/// session continues in.
pub const GO_AHEAD: &str = "Go ahead with this plan";
pub const GO_AHEAD_NO_ASKING: &str = "Go ahead, and don't ask about edits";
pub const NOT_YET: &str = "No — I'll say what to change";

pub struct Plan;

impl Tool for Plan {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "plan",
            description:
                "Put a plan to the person and wait for them to approve it. This is how \
                 plan mode ends: list the steps you intend to carry out, in order, and \
                 if they approve, plan mode is lifted and you carry them out in the \
                 same turn. Call it once you understand the problem — not before you \
                 have read enough to be specific. Each step should name what you will \
                 change, not what you will look at.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "description":
                            "The steps, in order. Each one a short line naming the \
                             change and where it lands.",
                        "items": { "type": "string" }
                    },
                    "note": {
                        "type": "string",
                        "description":
                            "One sentence of context if the plan needs it: a trade-off \
                             you made, or what you are deliberately not doing."
                    }
                },
                "required": ["steps"],
                "additionalProperties": false
            }),
            // Proposing changes nothing. What the *answer* changes is the
            // mode, and that is the window's to do.
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let asker = ctx.asker()?;
        let steps = steps(args)?;
        let note = arg_str(args, "note", "plan").unwrap_or_default();
        let note = note.trim().to_string();

        let answer = asker.ask(Question {
            id: String::new(),
            question: if note.is_empty() {
                "Go ahead with this plan?".to_string()
            } else {
                format!("{note}\n\nGo ahead with this plan?")
            },
            options: vec![
                GO_AHEAD.to_string(),
                GO_AHEAD_NO_ASKING.to_string(),
                NOT_YET.to_string(),
            ],
            steps: steps.clone(),
        })?;

        let approved = answer == GO_AHEAD || answer == GO_AHEAD_NO_ASKING;

        /*
          The plan is written into the result, approved or not.

          It is the only copy: the steps went out in an event, which the
          conversation never sees. A model that re-reads this history on
          turn nine has to find what it agreed to do, and "approved" on
          its own is not that.
        */
        let listed = steps
            .iter()
            .enumerate()
            .map(|(i, step)| format!("{}. {step}", i + 1))
            .collect::<Vec<_>>()
            .join("\n");

        let text = if approved {
            format!(
                "The plan was approved. Plan mode is lifted — carry it out now, in this \
                 turn, without asking again.\n{listed}\n"
            )
        } else {
            format!(
                "The plan was not approved: {answer}\nStay in plan mode. Wait for what \
                 they say, then propose a changed plan.\nWhat was proposed:\n{listed}\n"
            )
        };

        Ok(ToolOutput::text(text).with_detail(json!({
            "approved": approved,
            "answer": answer,
            "steps": steps,
        })))
    }
}

fn steps(args: &Value) -> Result<Vec<String>, ToolError> {
    let raw = args
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "plan: `steps` must be an array of steps.".to_string())?;

    if raw.is_empty() {
        return Err("plan: a plan with no steps is not a plan. Say what you would do.".into());
    }
    if raw.len() > MAX_STEPS {
        return Err(format!(
            "plan: {} steps is too many to approve at once. Give at most {MAX_STEPS} — \
             the detail belongs in the work, not in the proposal.",
            raw.len()
        ));
    }

    let mut steps = Vec::with_capacity(raw.len());
    for value in raw {
        let text = value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "plan: every step must be a non-empty string.".to_string())?;
        steps.push(clip(text));
    }
    Ok(steps)
}

fn clip(text: &str) -> String {
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
    use crate::agent::ask::Asker;
    use std::sync::{Arc, Mutex};

    struct Answers {
        with: String,
        seen: Mutex<Option<Question>>,
    }

    impl Asker for Answers {
        fn ask(&self, question: Question) -> Result<String, String> {
            *self.seen.lock().unwrap() = Some(question);
            Ok(self.with.clone())
        }
    }

    fn asking(answer: &str) -> (ToolContext, Arc<Answers>) {
        let answers = Arc::new(Answers {
            with: answer.into(),
            seen: Mutex::new(None),
        });
        let ctx = ToolContext::new(std::env::temp_dir())
            .with_asker(Arc::clone(&answers) as Arc<dyn Asker>);
        (ctx, answers)
    }

    fn two_steps() -> Value {
        json!({ "steps": ["add the field to Config", "read it in agent_send"] })
    }

    #[test]
    fn an_approved_plan_says_the_mode_is_lifted_and_repeats_the_steps() {
        let (ctx, asked) = asking(GO_AHEAD);
        let out = Plan.call(&ctx, &two_steps()).unwrap();

        assert_eq!(out.detail.as_ref().unwrap()["approved"], true);
        assert!(out.text.contains("Plan mode is lifted"));
        // The only copy: the steps went out in an event the conversation
        // never sees.
        assert!(out.text.contains("1. add the field to Config"));
        assert!(out.text.contains("2. read it in agent_send"));

        let question = asked.seen.lock().unwrap().clone().unwrap();
        assert_eq!(question.steps.len(), 2, "the card draws them above the options");
        assert_eq!(question.options.len(), 3);
    }

    #[test]
    fn a_refused_plan_keeps_the_mode_and_keeps_the_plan() {
        let (ctx, _) = asking(NOT_YET);
        let out = Plan.call(&ctx, &two_steps()).unwrap();
        assert_eq!(out.detail.as_ref().unwrap()["approved"], false);
        assert!(out.text.contains("Stay in plan mode"));
        assert!(out.text.contains("What was proposed:"));
    }

    #[test]
    fn the_note_goes_above_the_question_rather_than_into_a_step() {
        let (ctx, asked) = asking(GO_AHEAD);
        Plan.call(
            &ctx,
            &json!({ "steps": ["one"], "note": "Not touching the migration." }),
        )
        .unwrap();
        let question = asked.seen.lock().unwrap().clone().unwrap();
        assert!(question.question.starts_with("Not touching the migration."));
        assert!(question.question.ends_with("Go ahead with this plan?"));
        assert_eq!(question.steps, vec!["one"]);
    }

    #[test]
    fn a_plan_with_no_steps_is_refused() {
        let (ctx, _) = asking(GO_AHEAD);
        assert!(Plan.call(&ctx, &json!({ "steps": [] })).is_err());
    }

    #[test]
    fn a_plan_nobody_could_read_is_refused_with_the_limit_in_it() {
        let (ctx, _) = asking(GO_AHEAD);
        let steps: Vec<Value> = (0..MAX_STEPS + 1).map(|n| json!(format!("step {n}"))).collect();
        let error = Plan.call(&ctx, &json!({ "steps": steps })).unwrap_err();
        assert!(error.contains(&MAX_STEPS.to_string()));
    }

    #[test]
    fn with_nobody_to_ask_it_says_so_rather_than_approving_itself() {
        let ctx = ToolContext::new(std::env::temp_dir());
        assert!(Plan.call(&ctx, &two_steps()).is_err());
    }
}

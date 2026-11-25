//! `ask_user(question, options)` — a question with an answer shape.
//!
//! The alternative is not "no question", it is a question in prose, and
//! `TOOLS.md` is clear about what that costs: the run ends, the person
//! reads a paragraph, types a reply, and the next turn re-sends the whole
//! conversation to carry on from a standing start. This asks inside the
//! turn, and comes back with a word.
//!
//! It also gets *answered*. "I could add it to the response type, though
//! that changes the public API" is a model thinking out loud; about half
//! the time nobody realises it was a question at all. Three options and a
//! cursor cannot be mistaken for anything else.
//!
//! ## When it is the wrong tool
//!
//! When the model does not need an answer to carry on. A tool that stops
//! the run is a tool that is expensive to use wrongly — the person is
//! waiting on a card, and the thing they are waiting to be asked had a
//! reasonable default. The description says so in those words, because
//! this is the tool most likely to be over-used.

use serde_json::{json, Value};

use super::{arg_str, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::agent::ask::Question;

/// Enough to be a choice, few enough to be read at a glance.
const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 5;

/// One line each, like the window draws them.
const MAX_CHARS: usize = 120;

pub struct AskUser;

impl Tool for AskUser {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "ask_user",
            description:
                "Ask the person a question with a short list of answers, and wait. Use \
                 it only when you cannot sensibly carry on without the answer — a \
                 decision that is theirs to make, or a fork where guessing wrong means \
                 throwing work away. It stops the run while they read, so do not use it \
                 for anything that has a reasonable default: pick the default, do the \
                 work, and say what you assumed.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description":
                            "The question, as one sentence. Say what turns on the \
                             answer, not just what the options are."
                    },
                    "options": {
                        "type": "array",
                        "description":
                            "Two to five answers, each a short phrase. Put the one you \
                             would choose first.",
                        "items": { "type": "string" }
                    }
                },
                "required": ["question", "options"],
                "additionalProperties": false
            }),
            // Nothing outside the conversation changes. Asking permission
            // to ask a question is a card about a card.
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let asker = ctx.asker()?;
        let question = arg_str(args, "question", "ask_user")?;
        let options = options(args)?;

        let answer = asker.ask(Question {
            id: String::new(),
            question: question.clone(),
            options: options.clone(),
            steps: Vec::new(),
        })?;

        /*
          The question goes in the result as well as the answer.

          This result sits in the conversation for the rest of the
          session, and "the person said: the second one" is unreadable
          twenty turns later — to the model re-reading its own history
          as much as to anybody looking at a transcript.
        */
        Ok(ToolOutput::text(format!(
            "Asked: {question}\nThey answered: {answer}\n"
        ))
        .with_detail(json!({ "question": question, "answer": answer })))
    }
}

fn options(args: &Value) -> Result<Vec<String>, ToolError> {
    let raw = args
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| "ask_user: `options` must be an array of answers.".to_string())?;

    let mut options: Vec<String> = Vec::with_capacity(raw.len());
    for value in raw {
        let text = value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "ask_user: every option must be a non-empty string.".to_string())?;
        options.push(clip(text));
    }

    if options.len() < MIN_OPTIONS {
        return Err(format!(
            "ask_user: give at least {MIN_OPTIONS} options. A question with one answer \
             is a statement, and one with none belongs in your reply."
        ));
    }
    if options.len() > MAX_OPTIONS {
        return Err(format!(
            "ask_user: {} options is a menu. Give at most {MAX_OPTIONS}, or ask a \
             narrower question.",
            options.len()
        ));
    }

    // Two identical rows is a choice nobody can make, and it is usually a
    // model that meant to write two different things.
    for (i, option) in options.iter().enumerate() {
        if options[..i].iter().any(|earlier| earlier == option) {
            return Err(format!("ask_user: two options both say “{option}”."));
        }
    }
    Ok(options)
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
    use std::sync::Arc;

    /// An asker that answers with whatever it was told to, and records
    /// the question it was given.
    struct Picks {
        answer: String,
        seen: std::sync::Mutex<Option<Question>>,
    }

    impl Asker for Picks {
        fn ask(&self, question: Question) -> Result<String, String> {
            *self.seen.lock().unwrap() = Some(question);
            Ok(self.answer.clone())
        }
    }

    fn with_asker(answer: &str) -> (ToolContext, Arc<Picks>) {
        let picks = Arc::new(Picks {
            answer: answer.into(),
            seen: std::sync::Mutex::new(None),
        });
        let ctx = ToolContext::new(std::env::temp_dir())
            .with_asker(Arc::clone(&picks) as Arc<dyn Asker>);
        (ctx, picks)
    }

    #[test]
    fn the_answer_comes_back_with_the_question_beside_it() {
        let (ctx, picks) = with_asker("Rename it");
        let out = AskUser
            .call(
                &ctx,
                &json!({
                    "question": "The field is used in two places. Rename both?",
                    "options": ["Rename it", "Leave it and add the new one"]
                }),
            )
            .unwrap();

        assert!(out.text.contains("They answered: Rename it"));
        // Readable twenty turns later, to the model as much as to anybody
        // reading the transcript.
        assert!(out.text.contains("Rename both?"));

        let asked = picks.seen.lock().unwrap().clone().unwrap();
        assert_eq!(asked.options.len(), 2);
    }

    #[test]
    fn one_option_is_a_statement_and_is_refused() {
        let (ctx, _) = with_asker("x");
        let error = AskUser
            .call(&ctx, &json!({ "question": "Go on?", "options": ["yes"] }))
            .unwrap_err();
        assert!(error.contains("at least 2"));
    }

    #[test]
    fn a_menu_is_refused_with_the_number_in_the_message() {
        let (ctx, _) = with_asker("x");
        let error = AskUser
            .call(
                &ctx,
                &json!({ "question": "Which?", "options": ["a", "b", "c", "d", "e", "f"] }),
            )
            .unwrap_err();
        assert!(error.contains("6 options is a menu"));
    }

    #[test]
    fn two_options_that_say_the_same_thing_are_refused() {
        let (ctx, _) = with_asker("x");
        let error = AskUser
            .call(&ctx, &json!({ "question": "Which?", "options": ["keep it", "keep it"] }))
            .unwrap_err();
        assert!(error.contains("both say"));
    }

    /// The panel has no window of its own to put a card in, and a tool
    /// that cannot work says what to do instead of failing.
    #[test]
    fn with_nobody_to_ask_the_model_is_told_to_ask_in_its_answer() {
        let ctx = ToolContext::new(std::env::temp_dir());
        let error = AskUser
            .call(&ctx, &json!({ "question": "Which?", "options": ["a", "b"] }))
            .unwrap_err();
        assert!(error.contains("put the question in your answer"));
    }
}

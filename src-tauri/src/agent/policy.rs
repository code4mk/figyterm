//! Who is allowed to do what, and when the user is asked.
//!
//! The permission mode is the three-state thing the window cycles with
//! shift+tab, and it is three rather than a checkbox because the middle one
//! is the point: an agent you have decided to trust for the next ten minutes
//! should not ask eleven times, and one you have not should not be able to
//! write anything at all.
//!
//! This module is the whole of that decision and it is pure. The loop asks
//! it; the window renders the question. Nothing here does IO, which is what
//! makes "would this have been allowed?" a thing that can be tested rather
//! than discovered.

use serde::{Deserialize, Serialize};

use crate::agent::tools::Class;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Ask before anything that changes the project.
    Ask,
    /// Edits land without asking. Commands and the network still ask.
    AcceptEdits,
    /// Read and think, change nothing.
    Plan,
}

/// The mode, held somewhere a running turn and the window can both
/// reach.
///
/// It was a plain field, read once when the session was made, which made
/// shift+tab decorative. Reading it per message fixed that and left one
/// thing it could not: a decision taken *during* a turn. "Yes, allow all
/// edits this session" and an approved plan are both answers that change
/// what the rest of the turn may do, and the rest of the turn is already
/// running by the time they are given.
///
/// So: one cell, cloned into the session and into the command that
/// answers the card. Cheap, and small enough to reason about — the only
/// writers are a person pressing a key.
#[derive(Debug, Clone)]
pub struct ModeCell(std::sync::Arc<std::sync::Mutex<Mode>>);

impl ModeCell {
    pub fn new(mode: Mode) -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(mode)))
    }

    /// A poisoned lock answers `Ask`, which is the mode that asks about
    /// everything — the safe reading of "we do not know".
    pub fn get(&self) -> Mode {
        self.0.lock().map(|mode| *mode).unwrap_or(Mode::Ask)
    }

    pub fn set(&self, mode: Mode) {
        if let Ok(mut held) = self.0.lock() {
            *held = mode;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum Decision {
    /// Run it without asking.
    Allow,
    /// Put the question to the user.
    Ask,
    /// Not in this mode, and asking would be theatre. The string is the tool
    /// result the model gets, which has to explain the mode rather than
    /// merely refuse — a model told "denied" tries again.
    Refuse(String),
}

/// What happens when the model asks for `class` in `mode`.
///
/// Reads are never asked about. A prompt that fires on every `read` is a
/// prompt nobody reads by the fourth one, and a pattern of pressing Yes
/// without looking is worse than no prompt at all — it is where the one that
/// mattered gets approved.
pub fn decide(mode: Mode, class: Class, remembered: bool) -> Decision {
    match (mode, class) {
        (_, Class::Read) => Decision::Allow,

        (Mode::Plan, Class::Write) => Decision::Refuse(
            "Plan mode: nothing is changed. When you know what to do, put it to the \
             person with `plan` — approving it lifts plan mode and you carry it out \
             in this same turn."
                .into(),
        ),
        (Mode::Plan, Class::Exec) => Decision::Refuse(
            "Plan mode: no commands are run. Name the command in a step of your `plan` \
             instead."
                .into(),
        ),
        (Mode::Plan, Class::Net) => {
            Decision::Refuse("Plan mode: no network requests are made.".into())
        }

        (Mode::AcceptEdits, Class::Write) => Decision::Allow,

        // Remembering is per command and per session — "don't ask again for
        // `npm test` here". It is never a blanket grant for the class, which
        // is why `exec` is still asked about in acceptEdits.
        (_, _) if remembered => Decision::Allow,

        (Mode::Ask, Class::Write) => Decision::Ask,
        (_, Class::Exec) => Decision::Ask,
        (_, Class::Net) => Decision::Ask,
    }
}

/// The key a remembered approval is stored under.
///
/// For a command it is the first two words — `npm test`, `cargo build` —
/// because "don't ask again" means the command, not the exact invocation
/// with its arguments. For everything else it is the tool name.
///
/// Two words rather than one: `npm` alone would let `npm publish` through on
/// the strength of having approved `npm test` once.
pub fn approval_key(tool: &str, command: Option<&str>) -> String {
    match command {
        Some(cmd) => {
            let head: Vec<&str> = cmd.split_whitespace().take(2).collect();
            format!("{tool}:{}", head.join(" "))
        }
        None => tool.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_is_never_asked_about_in_any_mode() {
        for mode in [Mode::Ask, Mode::AcceptEdits, Mode::Plan] {
            assert_eq!(decide(mode, Class::Read, false), Decision::Allow);
        }
    }

    #[test]
    fn plan_mode_refuses_rather_than_asks() {
        // Asking would be theatre: the answer cannot be yes.
        let refusal = decide(Mode::Plan, Class::Write, false);
        match refusal {
            Decision::Refuse(why) => assert!(why.contains("Plan mode")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn plan_mode_is_not_overridden_by_a_remembered_approval() {
        // The mode is the stronger statement; a yes from ten minutes ago
        // does not survive being switched into plan mode.
        assert!(matches!(
            decide(Mode::Plan, Class::Exec, true),
            Decision::Refuse(_)
        ));
    }

    #[test]
    fn accept_edits_accepts_edits_and_nothing_else() {
        assert_eq!(decide(Mode::AcceptEdits, Class::Write, false), Decision::Allow);
        assert_eq!(decide(Mode::AcceptEdits, Class::Exec, false), Decision::Ask);
        assert_eq!(decide(Mode::AcceptEdits, Class::Net, false), Decision::Ask);
    }

    #[test]
    fn a_remembered_command_stops_being_asked_about() {
        assert_eq!(decide(Mode::Ask, Class::Exec, true), Decision::Allow);
        assert_eq!(decide(Mode::Ask, Class::Exec, false), Decision::Ask);
    }

    #[test]
    fn the_network_always_asks_unless_remembered() {
        assert_eq!(decide(Mode::Ask, Class::Net, false), Decision::Ask);
        assert_eq!(decide(Mode::AcceptEdits, Class::Net, false), Decision::Ask);
    }

    #[test]
    fn remembering_a_command_remembers_two_words_of_it() {
        assert_eq!(
            approval_key("bash", Some("npm test -- --watch")),
            "bash:npm test"
        );
        // Not one word: approving `npm test` must not approve `npm publish`.
        assert_ne!(
            approval_key("bash", Some("npm publish")),
            approval_key("bash", Some("npm test"))
        );
    }

    #[test]
    fn a_tool_with_no_command_is_remembered_by_name() {
        assert_eq!(approval_key("edit", None), "edit");
    }
}

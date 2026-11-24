//! The project's own instructions, read into the prefix at session start.
//!
//! `TOOLS.md` is blunt about why this exists and why the obvious
//! alternative does not: **a memory tool is deliberately absent.** An
//! agent that writes notes to itself in a hidden file is a second,
//! invisible source of behaviour — it drifts, nobody reviews it, and the
//! day it starts doing something unwanted there is no diff to point at.
//! Rules belong in a file the user wrote, can read, can change, and can
//! see in `git log`.
//!
//! So: one file at the top of the project, read once when the session is
//! made, and appended to the preamble the surface supplied.
//!
//! ## Frozen, like everything else in the prefix
//!
//! Order on the wire is `tools → system → messages` and caching is a
//! prefix match, so the rules are read **once** and never re-read. An
//! edit to `FIGY.md` applies to the next conversation, not to this one —
//! the alternative is a file the user can touch to invalidate the cache
//! of a session that is already thirty turns deep, which is a worse
//! surprise than the one it fixes. `/clear` is how you pick up a change.
//!
//! ## And it is not free
//!
//! Every byte here is in the cached prefix of every request for the whole
//! session. A thousand-line coding standard is a thousand lines the model
//! re-reads before every turn, and the window says what it costs on the
//! first screen so it is a choice rather than a surprise. Past
//! [`MAX_CHARS`] it is cut, and the cut is announced in the prompt itself
//! — an agent silently given half a rule is worse than one given none.

use std::path::Path;

/// What the file may contribute to the prefix, in characters.
///
/// Roughly 3K tokens, which is already a large fraction of what a short
/// conversation costs. Generous enough for a real set of house rules,
/// small enough that nobody discovers it by looking at a bill.
pub const MAX_CHARS: usize = 12_000;

/// The names looked for, in order.
///
/// `FIGY.md` is ours. `AGENTS.md` is read as well because a repository
/// that already has one has already written down the things we would be
/// asking for a second time, and two files saying the same thing is how
/// they start disagreeing. Ours wins where both exist.
pub const CANDIDATES: [&str; 2] = ["FIGY.md", "AGENTS.md"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    /// The file's name, as the window shows it.
    pub name: String,
    /// Its full path, for the window to open.
    pub path: String,
    /// The text, capped. Never empty — an empty file is no rules at all.
    pub text: String,
    pub truncated: bool,
}

/// The project's rules, if it has written any down.
///
/// A file that is only whitespace answers `None` rather than an empty
/// heading: the question being asked is "does this project have rules",
/// and a file somebody created and never filled in is a no.
pub fn read(root: &Path) -> Option<Rules> {
    for name in CANDIDATES {
        let path = root.join(name);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if raw.trim().is_empty() {
            continue;
        }
        let truncated = raw.chars().count() > MAX_CHARS;
        let text = if truncated {
            raw.chars().take(MAX_CHARS).collect::<String>()
        } else {
            raw
        };
        return Some(Rules {
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            text: text.trim_end().to_string(),
            truncated,
        });
    }
    None
}

/// The preamble with the project's rules under it.
///
/// Under, not over. The surface's preamble says what this agent *is* —
/// which tools it has, how long its answers should be, what a tool
/// result costs — and the project's rules say how to work in this
/// repository. When they disagree the repository wins, and the text says
/// so, because a model given two sets of instructions and no order
/// between them picks one at random.
pub fn attach(system: &str, rules: Option<&Rules>) -> String {
    let Some(rules) = rules else {
        return system.to_string();
    };
    let mut out = String::with_capacity(system.len() + rules.text.len() + 400);
    out.push_str(system.trim_end());
    out.push_str("\n\n---\n\n");
    out.push_str(&format!(
        "The following are this project's own instructions, from `{}`. They were \
written by the person you are working for and describe how this repository is \
worked in. Where they disagree with anything above, they win.\n\n",
        rules.name
    ));
    out.push_str(&rules.text);
    if rules.truncated {
        out.push_str(&format!(
            "\n\n[{} was longer than {MAX_CHARS} characters and was cut here. \
Anything past this point was not given to you — say so rather than guessing \
if a rule looks unfinished.]",
            rules.name
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("figy-rules-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_project_with_no_rules_has_none() {
        assert_eq!(read(&scratch("none")), None);
    }

    #[test]
    fn a_file_somebody_created_and_never_filled_in_is_not_rules() {
        let dir = scratch("empty");
        std::fs::write(dir.join("FIGY.md"), "\n\n   \n").unwrap();
        assert_eq!(read(&dir), None);
    }

    #[test]
    fn ours_wins_where_a_project_has_both() {
        let dir = scratch("both");
        std::fs::write(dir.join("AGENTS.md"), "run the other thing").unwrap();
        std::fs::write(dir.join("FIGY.md"), "run `npm test`").unwrap();
        let rules = read(&dir).expect("found");
        assert_eq!(rules.name, "FIGY.md");
        assert_eq!(rules.text, "run `npm test`");
    }

    /// A repository that already has one has already written down what we
    /// would otherwise ask for twice.
    #[test]
    fn an_existing_agents_file_is_read_rather_than_asked_for_again() {
        let dir = scratch("agents");
        std::fs::write(dir.join("AGENTS.md"), "never commit to main").unwrap();
        assert_eq!(read(&dir).unwrap().name, "AGENTS.md");
    }

    #[test]
    fn a_rule_file_nobody_could_afford_is_cut_and_says_so() {
        let dir = scratch("long");
        std::fs::write(dir.join("FIGY.md"), "x".repeat(MAX_CHARS + 500)).unwrap();
        let rules = read(&dir).expect("found");
        assert!(rules.truncated);
        assert_eq!(rules.text.chars().count(), MAX_CHARS);

        let prompt = attach("You are an agent.", Some(&rules));
        assert!(
            prompt.contains("was cut here"),
            "a model given half a rule must be told it is half a rule"
        );
    }

    /// Non-Latin text is where a byte-counted cap turns into a panic.
    #[test]
    fn rules_in_a_non_latin_script_survive_the_cap() {
        let dir = scratch("bangla");
        std::fs::write(dir.join("FIGY.md"), "প্রতিটি".repeat(4000)).unwrap();
        let rules = read(&dir).expect("found");
        assert!(rules.truncated);
        assert_eq!(rules.text.chars().count(), MAX_CHARS);
    }

    #[test]
    fn the_rules_come_after_the_preamble_and_are_said_to_win() {
        let rules = Rules {
            name: "FIGY.md".into(),
            path: "/repo/FIGY.md".into(),
            text: "Commit straight to main.".into(),
            truncated: false,
        };
        let prompt = attach("You are FigyCode.", Some(&rules));
        let preamble = prompt.find("You are FigyCode.").unwrap();
        let project = prompt.find("Commit straight to main.").unwrap();
        assert!(preamble < project, "the surface says what it is, first");
        assert!(prompt.contains("they win"));
        assert!(prompt.contains("`FIGY.md`"), "named, so the user can go and edit it");
    }

    #[test]
    fn no_rules_leaves_the_preamble_byte_for_byte_alone() {
        // It is the cache prefix: an extra newline here is a different
        // prefix for every session in every project without one.
        assert_eq!(attach("You are FigyCode.", None), "You are FigyCode.");
    }
}

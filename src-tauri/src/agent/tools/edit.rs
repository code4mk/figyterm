//! `edit(path, old, new, all)` — a replacement, never a rewrite.
//!
//! The fourth rule in `TOOLS.md`, and the one that is about safety as much as
//! cost. A `write(whole_file)` silently drops whatever the model forgot to
//! repeat, and the loss looks exactly like a deliberate deletion in the diff.
//! An exact-match replacement cannot: text that is not there is an error with
//! nothing written, which the model can see and correct.
//!
//! The cost argument is the other half. A 500-line rewrite is ~6K **output**
//! tokens — the expensive ones, several times the input rate — against ~80
//! for the hunk that changed.
//!
//! ## Ambiguity is refused, not resolved
//!
//! Three occurrences of the old text and no `all` is not a thing to guess at.
//! Replacing the first is how an agent edits the wrong call site in a file
//! with four similar ones, and the user finds out a build later. The error
//! says how many there are and what to do, which is a cheap turn.
//!
//! ## What is still missing
//!
//! **The dirty-buffer handshake.** The file is written atomically, with its
//! own encoding and line endings preserved — that much matches what the
//! editor's save path does. What this cannot see is a buffer with unsaved
//! changes open on the same file in the editor window; writing underneath
//! one would destroy work. It is the first unchecked item in `TASKS.md` for
//! that reason, and until it exists this tool is for files nobody is editing
//! by hand.

use serde_json::json;

use super::{arg_bool, arg_str, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::filesystem::operations::{self, FileKind};

pub struct Edit;

impl Tool for Edit {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "edit",
            description: "Replace an exact piece of text in a file. `old` must appear in the \
                file character for character, including indentation, and must appear \
                exactly once unless `all` is true — include a line or two around the \
                change to make it unique rather than replacing every copy. Fails without \
                writing anything if the text is not found.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file, relative to the project root."
                    },
                    "old": {
                        "type": "string",
                        "description":
                            "The exact text to replace, copied from a `read` of this file."
                    },
                    "new": {
                        "type": "string",
                        "description": "What to put there. Empty string deletes the text."
                    },
                    "all": {
                        "type": "boolean",
                        "description":
                            "Replace every occurrence instead of requiring exactly one. \
                             Default false."
                    }
                },
                "required": ["path", "old", "new"],
                "additionalProperties": false
            }),
            class: Class::Write,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let raw = arg_str(args, "path", "edit")?;
        let old = arg_str(args, "old", "edit")?;
        // `new` may legitimately be empty — that is a deletion — so it is read
        // directly rather than through the non-empty helper.
        let new = match args.get("new") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(other) => return Err(format!("edit: `new` must be a string, not {other}")),
            None => return Err("edit: `new` is required".into()),
        };
        let all = arg_bool(args, "all");

        let path = ctx.resolve(&raw)?;
        let shown = ctx.display(&path);

        let file = operations::read_text_file(&path).map_err(|e| format!("edit: {e}"))?;
        match file.kind {
            FileKind::Missing => {
                return Err(format!(
                    "edit: no such file: {shown}. Use `write` to create it."
                ))
            }
            FileKind::Binary | FileKind::TooLarge => {
                return Err(format!("edit: {shown} is not editable as text"))
            }
            FileKind::Text => {}
        }

        if old == new {
            return Err(format!("edit: `old` and `new` are identical, so {shown} is unchanged"));
        }

        /*
          Exactly, or allowing for the indentation.

          A model does not copy a `read` result byte for byte. It
          reads `  42 │     <div className="…">`, strips what it
          thinks is the prefix, and writes back something with four
          spaces where the file has six — and the edit fails, every
          time, on text that is unmistakably there.

          This used to be an error that explained itself and sent the
          model round again. Explaining the same thing on every edit
          is not a diagnosis, it is a tax: the retry costs a turn,
          the whole conversation is re-sent to pay for it, and the
          second attempt is a guess at an indent nobody can see.

          So an exact match wins, and failing that a match on the
          lines with their indentation taken off — *if* it is unique.
          Unique is the whole safety argument: ambiguity is still an
          error, because re-indenting the wrong block of a file is a
          worse outcome than asking again.
        */
        let mut old = old;
        let mut new = new;
        let mut realigned = false;
        if !file.content.contains(&old) {
            if let Some(found) = realign(&file.content, &old, &new) {
                old = found.old;
                new = found.new;
                realigned = true;
            }
        }

        let count = file.content.matches(&old).count();
        match count {
            0 => return Err(not_found(&shown, &old, &file.content)),
            1 => {}
            n if !all => {
                return Err(format!(
                    "edit: that text appears {n} times in {shown}. Include more of the \
                     surrounding lines so it is unique, or pass all=true to replace every \
                     one."
                ))
            }
            _ => {}
        }

        let updated = if all {
            file.content.replace(&old, &new)
        } else {
            file.content.replacen(&old, &new, 1)
        };

        /*
          Written the way the editor writes.

          `write_text_file` is the atomic save: a sibling temp file and a
          rename, so a crash cannot leave a half-written file. The encoding
          and line ending come back out of the file we just read, so a CRLF
          file stays CRLF and a BOM survives — getting that wrong rewrites
          every line of the file in the diff, which hides the one line that
          actually changed.
        */
        operations::write_text_file(&path, &updated, file.encoding, file.line_ending)
            .map_err(|e| format!("edit: {e}"))?;

        let (added, removed) = count_lines(&old, &new, if all { count } else { 1 });
        let where_ = first_line_of(&file.content, &old);
        let replaced = if all { count } else { 1 };

        Ok(ToolOutput::text(format!(
            "Edited {shown}: {replaced} replacement{} at line {where_}, +{added} -{removed}{}",
            if replaced == 1 { "" } else { "s" },
            // Said, not silent. The file now differs from what was
            // asked for, by exactly the indentation, and a model
            // that is not told will write the next edit the same
            // way.
            if realigned {
                ". The indentation you gave did not match; the file's own was used"
            } else {
                ""
            }
        ))
        .with_detail(json!({
            "path": shown,
            "line": where_,
            "replacements": replaced,
            "added": added,
            "removed": removed,
            "old": old,
            "new": new,
        })))
    }
}

/// What a realignment found: the text as the file really has it,
/// and the replacement re-indented to match.
struct Realigned {
    old: String,
    new: String,
}

/// The same lines, with the file's indentation instead of the
/// model's.
///
/// Lines are compared with their leading whitespace removed. One
/// match and it is taken; none or several and this answers `None`,
/// because re-indenting the wrong block is worse than asking again.
///
/// The replacement is shifted by the difference between the two
/// indents rather than re-indented absolutely. A model that wrote
/// four spaces where the file has six, and eight on the line below,
/// meant *one level deeper* — so every line moves by the same two,
/// and the shape it intended survives.
fn realign(content: &str, old: &str, new: &str) -> Option<Realigned> {
    let wanted: Vec<&str> = old.lines().collect();
    if wanted.is_empty() {
        return None;
    }
    // A single line with nothing around it is the one case where
    // indentation is not enough to be sure: `}` trimmed matches
    // every closing brace in the file. Unique-after-trimming already
    // rules most of that out, and this rules out the rest.
    let lines: Vec<&str> = content.lines().collect();

    let mut at: Option<usize> = None;
    for start in 0..lines.len().saturating_sub(wanted.len() - 1) {
        let matches = wanted
            .iter()
            .enumerate()
            .all(|(i, line)| lines[start + i].trim() == line.trim());
        if !matches {
            continue;
        }
        if at.is_some() {
            return None; // Ambiguous: the model has to be clearer.
        }
        at = Some(start);
    }
    let at = at?;

    let found: Vec<&str> = lines[at..at + wanted.len()].to_vec();
    let shift = indent_of(found[0]) as isize - indent_of(wanted[0]) as isize;

    Some(Realigned {
        old: found.join("\n"),
        new: new
            .lines()
            .map(|line| shift_line(line, shift))
            .collect::<Vec<_>>()
            .join("\n"),
    })
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Moves a line by `shift` spaces, never past its own indent.
fn shift_line(line: &str, shift: isize) -> String {
    if line.trim().is_empty() {
        return line.to_string();
    }
    let indent = indent_of(line);
    let moved = (indent as isize + shift).max(0) as usize;
    format!("{}{}", " ".repeat(moved), line.trim_start())
}

/// Not found, with the reason it is usually not found.
///
/// Nine times in ten the text is there and the indentation is not, because
/// the model retyped the line instead of copying it. Saying so turns a
/// repeated failure into one correction.
fn not_found(shown: &str, old: &str, content: &str) -> ToolError {
    let trimmed: String = old
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n");
    let haystack: String = content
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n");

    if !trimmed.is_empty() && haystack.contains(&trimmed) {
        return format!(
            "edit: that text is in {shown} but the whitespace differs. Copy the lines \
             exactly as `read` returned them, including indentation."
        );
    }
    format!("edit: that text was not found in {shown}. Read the file and copy the lines to replace.")
}

/// Lines added and removed, for the one-line summary.
fn count_lines(old: &str, new: &str, times: usize) -> (usize, usize) {
    let old_lines = old.lines().count().max(1);
    let new_lines = new.lines().count().max(usize::from(!new.is_empty()));
    (new_lines * times, old_lines * times)
}

/// Which line the first occurrence starts on, 1-based.
fn first_line_of(content: &str, needle: &str) -> usize {
    content
        .find(needle)
        // Newlines before it, not lines before it: `lines()` on text that
        // ends in a newline counts one fewer than the line the next
        // character is on, which is off by one on every match but the first.
        .map(|at| content[..at].matches('\n').count() + 1)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str, body: &str) -> (ToolContext, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("figy-edit-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        let file = dir.join("src/main.rs");
        fs::write(&file, body).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let file = fs::canonicalize(&file).unwrap();
        (ToolContext::new(root), file)
    }

    #[test]
    fn a_unique_match_is_replaced_and_nothing_else_moves() {
        let (ctx, file) = scratch("unique", "let a = 1;\nlet b = 2;\n");
        let out = Edit
            .call(
                &ctx,
                &json!({ "path": "src/main.rs", "old": "let b = 2;", "new": "let b = 3;" }),
            )
            .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "let a = 1;\nlet b = 3;\n");
        assert!(out.text.contains("1 replacement"));
        assert!(out.text.contains("line 2"));
    }

    #[test]
    fn an_ambiguous_match_is_refused_with_the_count() {
        let (ctx, file) = scratch("ambiguous", "x();\nx();\nx();\n");
        let err = Edit
            .call(&ctx, &json!({ "path": "src/main.rs", "old": "x();", "new": "y();" }))
            .unwrap_err();
        assert!(err.contains("appears 3 times"), "got: {err}");
        // And nothing was written.
        assert_eq!(fs::read_to_string(&file).unwrap(), "x();\nx();\nx();\n");
    }

    #[test]
    fn all_replaces_every_occurrence() {
        let (ctx, file) = scratch("all", "x();\nx();\n");
        let out = Edit
            .call(
                &ctx,
                &json!({ "path": "src/main.rs", "old": "x();", "new": "y();", "all": true }),
            )
            .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "y();\ny();\n");
        assert!(out.text.contains("2 replacements"));
    }

    #[test]
    fn text_that_is_not_there_writes_nothing() {
        let (ctx, file) = scratch("absent", "let a = 1;\n");
        let err = Edit
            .call(&ctx, &json!({ "path": "src/main.rs", "old": "let z = 9;", "new": "" }))
            .unwrap_err();
        assert!(err.contains("not found"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "let a = 1;\n");
    }

    #[test]
    fn an_indent_that_does_not_match_is_realigned_rather_than_refused() {
        /*
          The commonest failure by a long way, and it used to be a
          refusal with an explanation attached.

          A model reads `  2 │     let a = 1;`, strips what it takes
          to be the prefix, and writes back a line indented by four
          spaces where the file has four — or a tab, or two. The text
          is unmistakably there. Sending it round again costs a turn
          and re-sends the whole conversation to pay for a guess at
          an indent nobody can see.
        */
        let (ctx, path) = scratch("realign", "fn main() {\n    let a = 1;\n}\n");
        let out = Edit
            .call(
                &ctx,
                &json!({ "path": "src/main.rs", "old": "\tlet a = 1;", "new": "\tlet a = 2;" }),
            )
            .unwrap();

        // The file keeps its own indentation, not the one it was given.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "fn main() {\n    let a = 2;\n}\n"
        );
        // And the model is told, so the next edit is not the same guess.
        assert!(out.text.contains("indentation you gave did not match"), "{}", out.text);
    }

    #[test]
    fn realigning_keeps_the_shape_the_edit_was_written_with() {
        // Four spaces where the file has eight means *one level
        // deeper*, so every line moves by the same four and the
        // nesting the model intended survives.
        let (ctx, path) = scratch(
            "realign-shape",
            "fn main() {\n    if x {\n        a();\n    }\n}\n",
        );
        Edit.call(
            &ctx,
            &json!({
                "path": "src/main.rs",
                "old": "if x {\n    a();\n}",
                "new": "if x {\n    a();\n    b();\n}"
            }),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "fn main() {\n    if x {\n        a();\n        b();\n    }\n}\n"
        );
    }

    #[test]
    fn text_that_is_simply_not_there_is_still_not_found() {
        // Its own directory. Two tests sharing one is a failure that
        // depends on which finishes first, and this file has had it
        // before.
        let (ctx, _) = scratch("absent-lines", "fn main() {\n    let a = 1;\n}\n");
        let err = Edit
            .call(
                &ctx,
                &json!({ "path": "src/main.rs", "old": "let a = 1;\nlet b = 2;", "new": "x" }),
            )
            .unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn an_indent_that_could_mean_two_places_is_refused() {
        /*
          The safety argument for all of this, in one test.

          Realigning is only sound while there is one candidate.
          Re-indenting the wrong block of a file is a worse outcome
          than asking the model to be clearer, so an ambiguous match
          goes back as the error it always was.
        */
        let (ctx, before) = scratch(
            "realign-ambiguous",
            "fn a() {\n    go();\n}\n\nfn b() {\n        go();\n}\n",
        );
        let content = std::fs::read_to_string(&before).unwrap();

        let err = Edit
            .call(&ctx, &json!({ "path": "src/main.rs", "old": "go();", "new": "stop();" }))
            .unwrap_err();
        assert!(err.contains("appears 2 times") || err.contains("whitespace"), "got: {err}");
        assert_eq!(
            std::fs::read_to_string(&before).unwrap(),
            content,
            "nothing is written when it is not clear what to write"
        );
    }

    #[test]
    fn an_empty_replacement_deletes() {
        let (ctx, file) = scratch("delete", "keep\nremove\n");
        Edit.call(&ctx, &json!({ "path": "src/main.rs", "old": "remove\n", "new": "" }))
            .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep\n");
    }

    #[test]
    fn crlf_survives_the_edit() {
        // Getting this wrong rewrites every line in the diff and hides the
        // one that changed.
        let (ctx, file) = scratch("crlf", "let a = 1;\r\nlet b = 2;\r\n");
        Edit.call(
            &ctx,
            &json!({ "path": "src/main.rs", "old": "let b = 2;", "new": "let b = 3;" }),
        )
        .unwrap();
        let after = fs::read_to_string(&file).unwrap();
        assert!(after.contains("\r\n"), "line endings were not preserved");
        assert!(!after.contains("let b = 2"));
    }

    #[test]
    fn a_no_op_edit_is_refused_rather_than_written() {
        let (ctx, _) = scratch("noop", "same\n");
        let err = Edit
            .call(&ctx, &json!({ "path": "src/main.rs", "old": "same", "new": "same" }))
            .unwrap_err();
        assert!(err.contains("identical"));
    }

    #[test]
    fn a_missing_file_points_at_write() {
        let (ctx, _) = scratch("missing", "x\n");
        let err = Edit
            .call(&ctx, &json!({ "path": "src/nope.rs", "old": "a", "new": "b" }))
            .unwrap_err();
        assert!(err.contains("Use `write`"), "got: {err}");
    }

    #[test]
    fn a_path_outside_the_project_is_refused() {
        let (ctx, _) = scratch("escape", "x\n");
        let err = Edit
            .call(&ctx, &json!({ "path": "../escape.txt", "old": "a", "new": "b" }))
            .unwrap_err();
        assert!(err.contains("outside"));
    }
}

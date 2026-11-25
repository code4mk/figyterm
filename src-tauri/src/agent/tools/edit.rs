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
            "Edited {shown}: {replaced} replacement{} at line {where_}, +{added} -{removed}",
            if replaced == 1 { "" } else { "s" }
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
    fn whitespace_that_differs_is_said_out_loud() {
        // The commonest failure by a long way: the model retyped the line
        // instead of copying it, and lost the indentation.
        let (ctx, _) = scratch("whitespace", "fn main() {\n    let a = 1;\n}\n");
        let err = Edit
            .call(&ctx, &json!({ "path": "src/main.rs", "old": "let a = 1;\nlet b = 2;", "new": "x" }))
            .unwrap_err();
        assert!(err.contains("not found"), "got: {err}");

        // A tab where the file has spaces: the line is there, and the text
        // is not — which is the failure this message exists for, and the one
        // a model makes by retyping a line instead of copying it.
        let err = Edit
            .call(
                &ctx,
                &json!({ "path": "src/main.rs", "old": "\tlet a = 1;", "new": "\tlet a = 2;" }),
            )
            .unwrap_err();
        assert!(err.contains("whitespace differs"), "got: {err}");
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

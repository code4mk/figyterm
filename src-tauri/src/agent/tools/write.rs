//! `write(path, content)` — for a file that does not exist yet.
//!
//! **Not the normal way to change a file**, which is the whole design of it.
//! `TOOLS.md` lists "`write` as the ordinary edit" among the things we do
//! not build: an agent that rewrites a file to change one line is an agent
//! deleting the parts it forgot, and the loss reads in the diff exactly like
//! a deliberate deletion. `edit` cannot make that mistake, because text it
//! cannot find is an error with nothing written.
//!
//! So this refuses to overwrite by default and says to use `edit` instead.
//! `overwrite: true` exists because regenerating a generated file is a real
//! thing to want, and the refusal has to have an answer — but it is a
//! sentence the model has to choose to write, which is the point.

use serde_json::json;

use super::output::approx_tokens;
use super::{arg_bool, arg_str, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::filesystem::operations::{self, Encoding, FileKind, LineEnding};

/// How much of a written file the window is shown. The model already has
/// the whole of it — it wrote it.
const PREVIEW_LINES: usize = 300;

pub struct Write;

impl Tool for Write {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "write",
            description: "Create a new file with the given contents. Refuses to overwrite a \
                file that already exists — use `edit` to change one, which cannot \
                silently drop the parts you did not repeat. Parent folders are created.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path for the new file, relative to the project root."
                    },
                    "content": {
                        "type": "string",
                        "description": "The whole contents of the file."
                    },
                    "overwrite": {
                        "type": "boolean",
                        "description":
                            "Replace the file if it already exists. Default false. Only for \
                             a file you mean to regenerate whole."
                    }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
            class: Class::Write,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let raw = arg_str(args, "path", "write")?;
        let content = match args.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(other) => {
                return Err(format!(
                    "write: `content` must be a string, not {}",
                    match other {
                        serde_json::Value::Object(_) => "an object",
                        serde_json::Value::Array(_) => "an array",
                        _ => "that",
                    }
                ))
            }
            None => return Err("write: `content` is required".into()),
        };

        let path = ctx.resolve(&raw)?;
        let shown = ctx.display(&path);
        let existing = operations::read_text_file(&path).map_err(|e| format!("write: {e}"))?;

        /*
          The encoding question, which only arises when overwriting.

          A new file is UTF-8 with LF, because that is what everything in
          this repository is and inventing a BOM would be a surprise. An
          existing one keeps what it had: a CRLF file rewritten as LF shows
          every line as changed in the diff and hides the one that was.
        */
        let (encoding, line_ending) = match existing.kind {
            FileKind::Missing => (Encoding::Utf8, LineEnding::Lf),
            FileKind::Text => {
                if !arg_bool(args, "overwrite") {
                    return Err(format!(
                        "write: {shown} already exists. Use `edit` to change part of it, or \
                         pass overwrite=true to replace the whole file."
                    ));
                }
                (existing.encoding, existing.line_ending)
            }
            FileKind::Binary | FileKind::TooLarge => {
                return Err(format!("write: {shown} exists and is not a text file"))
            }
        };

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("write: could not create {}: {e}", parent.display()))?;
        }
        operations::write_text_file(&path, &content, encoding, line_ending)
            .map_err(|e| format!("write: {e}"))?;

        let lines = content.lines().count();
        let created = matches!(existing.kind, FileKind::Missing);
        let verb = if created { "Created" } else { "Replaced" };
        /*
          The content goes in `detail`, not in the text.

          The window draws the new file as a diff of added lines — the
          same view an edit gets, because "what did it just write" is the
          same question. It must not go into the tool *result*: the model
          wrote that text, it is already in the conversation once as the
          call's arguments, and sending it back would be paying for it
          twice on every later turn.

          Capped, because the window is not where a 4,000-line generated
          file should be read either.
        */
        let preview: String = content
            .lines()
            .take(PREVIEW_LINES)
            .collect::<Vec<_>>()
            .join("\n");

        Ok(
            ToolOutput::text(format!("{verb} {shown}, {lines} lines")).with_detail(json!({
                "path": shown,
                "lines": lines,
                "bytes": content.len(),
                "created": created,
                "tokens": approx_tokens(&content),
                "content": preview,
                "contentTruncated": lines > PREVIEW_LINES,
            })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> ToolContext {
        let dir = std::env::temp_dir().join(format!("figy-write-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        ToolContext::new(fs::canonicalize(&dir).unwrap())
    }

    #[test]
    fn a_new_file_is_created_with_its_parents() {
        let ctx = scratch("new");
        let out = Write
            .call(
                &ctx,
                &json!({ "path": "src/deep/new.rs", "content": "fn main() {}\n" }),
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(ctx.root().join("src/deep/new.rs")).unwrap(),
            "fn main() {}\n"
        );
        assert!(out.text.contains("Created src/deep/new.rs"));
    }

    #[test]
    fn an_existing_file_is_refused_and_pointed_at_edit() {
        // The whole design of this tool: an agent rewriting a file to change
        // a line is an agent deleting what it forgot to repeat.
        let ctx = scratch("exists");
        fs::write(ctx.root().join("a.txt"), "original\n").unwrap();

        let err = Write
            .call(&ctx, &json!({ "path": "a.txt", "content": "new" }))
            .unwrap_err();
        assert!(err.contains("already exists"));
        assert!(err.contains("`edit`"), "got: {err}");
        assert_eq!(
            fs::read_to_string(ctx.root().join("a.txt")).unwrap(),
            "original\n"
        );
    }

    #[test]
    fn overwrite_is_available_to_a_caller_that_means_it() {
        let ctx = scratch("overwrite");
        fs::write(ctx.root().join("gen.ts"), "old\n").unwrap();
        let out = Write
            .call(
                &ctx,
                &json!({ "path": "gen.ts", "content": "new\n", "overwrite": true }),
            )
            .unwrap();
        assert_eq!(fs::read_to_string(ctx.root().join("gen.ts")).unwrap(), "new\n");
        assert!(out.text.contains("Replaced"));
    }

    #[test]
    fn overwriting_keeps_the_line_endings_the_file_had() {
        let ctx = scratch("crlf");
        fs::write(ctx.root().join("win.txt"), "a\r\nb\r\n").unwrap();
        Write
            .call(
                &ctx,
                &json!({ "path": "win.txt", "content": "c\nd\n", "overwrite": true }),
            )
            .unwrap();
        assert!(fs::read_to_string(ctx.root().join("win.txt"))
            .unwrap()
            .contains("\r\n"));
    }

    #[test]
    fn a_path_outside_the_project_is_refused() {
        let ctx = scratch("escape");
        assert!(Write
            .call(&ctx, &json!({ "path": "../escape.txt", "content": "x" }))
            .unwrap_err()
            .contains("outside"));
    }

    #[test]
    fn content_sent_as_an_object_is_named_rather_than_stringified() {
        // Models do this when the file is JSON, and `[object Object]` on
        // disk is a worse outcome than a sentence.
        let ctx = scratch("object");
        let err = Write
            .call(&ctx, &json!({ "path": "a.json", "content": { "a": 1 } }))
            .unwrap_err();
        assert!(err.contains("must be a string, not an object"));
    }
}

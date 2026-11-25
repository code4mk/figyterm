//! `definition`, `references`, `diagnostics` — asking something that
//! understands the language.
//!
//! | Question | grep answers with | this answers with |
//! |---|---|---|
//! | Where is `claimFront` used? | ~200 hits, comments and strings included | **the 7 real references** |
//! | What is this symbol? | read the file and find out | **one range** |
//! | Did my edit break anything? | run the whole build | **the file's errors, now** |
//!
//! The saving is not incremental. A `references` that returns seven ranges
//! instead of two hundred textual hits is closer to 30× than 2×, on the
//! operation an agent performs most often — and `diagnostics` closes the
//! slowest loop an agent has, edit → build → read errors → fix, into a few
//! hundred tokens instead of a build log.
//!
//! All three go through `agent/code.rs` to the language server the app is
//! already running. See that file for why there is not a second one.
//!
//! **Positions are 1-based here and 0-based in LSP.** The model reads line
//! numbers out of `read` and `grep`, which number from one as every editor
//! does; the protocol numbers from zero. The conversion happens at the
//! frontend edge, once, and `read`'s numbering is what the model should be
//! copying from.

use serde_json::{json, Value};

use super::output::{cap_lines, clip_line};
use super::{arg_str, arg_usize, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::agent::code::{Ask, Op};
use crate::filesystem::operations::{self, FileKind};

const MAX_REFERENCES: usize = 60;
const MAX_DIAGNOSTICS: usize = 40;

/// Everything these three need to ask: the file, its text, and a position.
fn prepare(
    ctx: &ToolContext,
    args: &Value,
    tool: &str,
    positioned: bool,
) -> Result<(Ask, String), ToolError> {
    let raw = arg_str(args, "path", tool)?;
    let path = ctx.resolve(&raw)?;
    let shown = ctx.display(&path);

    let file = operations::read_text_file(&path).map_err(|e| format!("{tool}: {e}"))?;
    match file.kind {
        FileKind::Missing => return Err(format!("{tool}: no such file: {shown}")),
        FileKind::Text => {}
        _ => return Err(format!("{tool}: {shown} is not a text file")),
    }

    let (line, column) = if positioned {
        let line = arg_usize(args, "line", 0, u32::MAX as usize);
        if args.get("line").is_none() {
            return Err(format!(
                "{tool}: `line` is required — the line the symbol is on, as `read` \
                 numbered it"
            ));
        }
        (line as u32, arg_usize(args, "column", 1, u32::MAX as usize) as u32)
    } else {
        (1, 1)
    };

    Ok((
        Ask {
            id: String::new(),
            op: Op::Definition,
            path: path.to_string_lossy().to_string(),
            text: file.content,
            line,
            column,
        },
        shown,
    ))
}

/// `file:///a/b/c.rs` → `src/c.rs`, against the project root.
fn location_line(ctx: &ToolContext, value: &Value) -> Option<String> {
    let uri = value
        .get("uri")
        .or_else(|| value.get("targetUri"))
        .and_then(Value::as_str)?;
    let range = value
        .get("range")
        .or_else(|| value.get("targetSelectionRange"))
        .or_else(|| value.get("targetRange"))?;
    let line = range.get("start")?.get("line")?.as_u64()? + 1;
    let column = range.get("start")?.get("character")?.as_u64()? + 1;

    let path = uri.strip_prefix("file://").unwrap_or(uri);
    let decoded = path.replace("%20", " ");
    let shown = ctx.display(std::path::Path::new(&decoded));
    Some(format!("{shown}:{line}:{column}"))
}

/// One location, or a list of them, as a flat list.
fn locations(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(items) => items.iter().collect(),
        Value::Null => Vec::new(),
        single => vec![single],
    }
}

pub struct Definition;

impl Tool for Definition {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "definition",
            description: "Where a symbol is defined, from the language server rather than \
                from a text search. Give the file and the 1-based line and column of a \
                use of it — the numbers `read` and `grep` print. Exact where grep is a \
                guess.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File the symbol appears in." },
                    "line": { "type": "integer", "description": "1-based line, as `read` numbers them." },
                    "column": { "type": "integer", "description": "1-based column. Defaults to 1." }
                },
                "required": ["path", "line"],
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let (mut ask, shown) = prepare(ctx, args, "definition", true)?;
        ask.op = Op::Definition;
        let answer = ctx.lsp()?.ask(ask).map_err(|e| format!("definition: {e}"))?;

        let found: Vec<String> = locations(&answer)
            .into_iter()
            .filter_map(|loc| location_line(ctx, loc))
            .collect();

        if found.is_empty() {
            return Ok(ToolOutput::text(format!(
                "No definition found for that position in {shown}."
            )));
        }
        Ok(ToolOutput::text(found.join("\n")).with_detail(json!({ "locations": found })))
    }
}

pub struct References;

impl Tool for References {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "references",
            description: "Every real use of a symbol, from the language server. Give the \
                file and the 1-based line and column of the symbol. Prefer this to \
                grepping a name: it excludes comments, strings and unrelated symbols \
                that happen to share the name, and it finds uses that are spelled \
                differently.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File the symbol appears in." },
                    "line": { "type": "integer", "description": "1-based line, as `read` numbers them." },
                    "column": { "type": "integer", "description": "1-based column. Defaults to 1." }
                },
                "required": ["path", "line"],
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let (mut ask, shown) = prepare(ctx, args, "references", true)?;
        ask.op = Op::References;
        let answer = ctx.lsp()?.ask(ask).map_err(|e| format!("references: {e}"))?;

        let found: Vec<String> = locations(&answer)
            .into_iter()
            .filter_map(|loc| location_line(ctx, loc))
            .collect();

        if found.is_empty() {
            return Ok(ToolOutput::text(format!("No references found from {shown}.")));
        }

        let total = found.len();
        let (kept, note) = cap_lines(found, MAX_REFERENCES, "ask about a narrower symbol");
        let mut text = format!("{total} reference{}\n{}\n", if total == 1 { "" } else { "s" }, kept.join("\n"));
        if let Some(note) = note {
            text.push_str(&note);
            text.push('\n');
        }
        Ok(ToolOutput::text(text).with_detail(json!({ "count": total })))
    }
}

pub struct Diagnostics;

impl Tool for Diagnostics {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "diagnostics",
            description: "The errors and warnings the language server has for a file, as \
                it stands on disk. Use it after an edit instead of running the build: it \
                answers in a few hundred tokens where a build log is thousands, and it \
                answers immediately.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The file to check." }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let (mut ask, shown) = prepare(ctx, args, "diagnostics", false)?;
        ask.op = Op::Diagnostics;
        let answer = ctx.lsp()?.ask(ask).map_err(|e| format!("diagnostics: {e}"))?;

        let items = answer.as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            return Ok(ToolOutput::text(format!("{shown}: no errors or warnings.")));
        }

        let lines: Vec<String> = items
            .iter()
            .map(|item| {
                let line = item
                    .get("range")
                    .and_then(|r| r.get("start"))
                    .and_then(|s| s.get("line"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    + 1;
                // 1 error, 2 warning, 3 information, 4 hint.
                let severity = match item.get("severity").and_then(Value::as_u64) {
                    Some(1) => "error",
                    Some(2) => "warning",
                    Some(3) => "note",
                    _ => "hint",
                };
                let message = item
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("(no message)")
                    .replace('\n', " ");
                format!("{line}: {severity}: {}", clip_line(&message, 200))
            })
            .collect();

        let total = lines.len();
        let (kept, note) = cap_lines(lines, MAX_DIAGNOSTICS, "fix these first and ask again");
        let mut text = format!("{shown} — {total} problem{}\n{}\n", if total == 1 { "" } else { "s" }, kept.join("\n"));
        if let Some(note) = note {
            text.push_str(&note);
            text.push('\n');
        }
        Ok(ToolOutput::text(text).with_detail(json!({ "path": shown, "count": total })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::code::Lsp;
    use std::sync::{Arc, Mutex};

    /// A language server that answers from a script.
    struct Fake {
        answer: Value,
        seen: Mutex<Option<Ask>>,
    }

    impl Lsp for Fake {
        fn ask(&self, ask: Ask) -> Result<Value, String> {
            *self.seen.lock().unwrap() = Some(ask);
            Ok(self.answer.clone())
        }
    }

    /// A project of its own per test: these run in parallel, and one
    /// `remove_dir_all` of a shared name takes the others' files with it.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("figy-lsp-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {\n    go();\n}\n").unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn ctx_at(root: std::path::PathBuf, answer: Value) -> (ToolContext, Arc<Fake>) {
        let fake = Arc::new(Fake {
            answer,
            seen: Mutex::new(None),
        });
        let ctx = ToolContext::new(root).with_lsp(Arc::clone(&fake) as Arc<dyn Lsp>);
        (ctx, fake)
    }

    fn ctx_with(name: &str, answer: Value) -> (ToolContext, Arc<Fake>) {
        ctx_at(scratch(name), answer)
    }

    fn location(path: &str, line: u64) -> Value {
        json!({
            "uri": format!("file://{path}"),
            "range": { "start": { "line": line, "character": 7 },
                       "end": { "line": line, "character": 12 } }
        })
    }

    #[test]
    fn a_definition_comes_back_as_one_place_relative_to_the_project() {
        let root = scratch("definition");
        let (ctx, _) = ctx_at(
            root.clone(),
            location(&format!("{}/src/lib.rs", root.to_string_lossy()), 41),
        );

        let out = Definition
            .call(&ctx, &json!({ "path": "src/main.rs", "line": 2, "column": 5 }))
            .unwrap();
        // 0-based on the wire, 1-based everywhere the model reads.
        assert_eq!(out.text, "src/lib.rs:42:8");
    }

    #[test]
    fn the_position_goes_out_as_the_model_wrote_it() {
        // 1-based both ways here; the conversion is the frontend's, once.
        let (ctx, fake) = ctx_with("position", Value::Null);
        let _ = Definition.call(&ctx, &json!({ "path": "src/main.rs", "line": 2, "column": 5 }));
        let sent = fake.seen.lock().unwrap().clone().unwrap();
        assert_eq!((sent.line, sent.column), (2, 5));
        assert_eq!(sent.op, Op::Definition);
        // And the text travels with it, so the frontend needs no file access.
        assert!(sent.text.contains("fn main"));
    }

    #[test]
    fn nothing_found_is_an_answer_rather_than_an_error() {
        let (ctx, _) = ctx_with("nothing", Value::Null);
        let out = Definition
            .call(&ctx, &json!({ "path": "src/main.rs", "line": 1 }))
            .unwrap();
        assert!(out.text.contains("No definition found"));
    }

    #[test]
    fn references_are_counted_and_listed() {
        let dir = scratch("references");
        let root = dir.to_string_lossy().to_string();
        let (ctx, _) = ctx_at(
            dir.clone(),
            json!([
                location(&format!("{root}/src/main.rs"), 1),
                location(&format!("{root}/src/other.rs"), 9),
            ]),
        );
        let out = References
            .call(&ctx, &json!({ "path": "src/main.rs", "line": 2 }))
            .unwrap();
        assert!(out.text.starts_with("2 references"));
        assert!(out.text.contains(":2:8"));
        assert!(out.text.contains(":10:8"));
    }

    #[test]
    fn a_long_reference_list_is_capped() {
        let dir = scratch("capped");
        let root = dir.to_string_lossy().to_string();
        let many: Vec<Value> = (0..200).map(|i| location(&format!("{root}/src/a.rs"), i)).collect();
        let (ctx, _) = ctx_at(dir, Value::Array(many));
        let out = References
            .call(&ctx, &json!({ "path": "src/main.rs", "line": 2 }))
            .unwrap();
        assert!(out.text.starts_with("200 references"));
        assert!(out.text.contains("140 more lines"));
    }

    #[test]
    fn diagnostics_read_as_a_compiler_would_print_them() {
        let (ctx, _) = ctx_with("diagnostics", json!([
            { "range": { "start": { "line": 1, "character": 4 } },
              "severity": 1, "message": "cannot find function `go`" },
            { "range": { "start": { "line": 0, "character": 0 } },
              "severity": 2, "message": "unused import" }
        ]));
        let out = Diagnostics.call(&ctx, &json!({ "path": "src/main.rs" })).unwrap();
        assert!(out.text.contains("2 problems"));
        assert!(out.text.contains("2: error: cannot find function `go`"));
        assert!(out.text.contains("1: warning: unused import"));
    }

    #[test]
    fn a_clean_file_says_so_in_one_line() {
        // The cheapest possible answer to "did my edit break anything".
        let (ctx, _) = ctx_with("clean", json!([]));
        let out = Diagnostics.call(&ctx, &json!({ "path": "src/main.rs" })).unwrap();
        assert_eq!(out.text, "src/main.rs: no errors or warnings.");
    }

    #[test]
    fn a_missing_line_says_where_to_get_one() {
        let (ctx, _) = ctx_with("no-line", Value::Null);
        let err = Definition.call(&ctx, &json!({ "path": "src/main.rs" })).unwrap_err();
        assert!(err.contains("`line` is required"));
        assert!(err.contains("read"));
    }

    #[test]
    fn a_context_with_no_editor_says_so_instead_of_hanging() {
        let ctx = ToolContext::new(scratch("no-editor"));
        let err = Diagnostics.call(&ctx, &json!({ "path": "src/main.rs" })).unwrap_err();
        assert!(err.contains("language server"), "got: {err}");
    }
}

//! `read(path, offset, limit)` — a window onto a file, never the whole thing.
//!
//! The first rule in `TOOLS.md`, and the one that pays for itself fastest.
//! `fs_read_text` hands back an entire file because an editor needs an entire
//! file; an agent that is given one has bought it for the rest of the
//! session. Two hundred lines is enough to understand a function and cheap
//! enough to ask for again.
//!
//! Lines are numbered, for two reasons that both matter later: the model can
//! cite `claude-project.ts:44` back to the user, and it can see exactly how
//! much context it has around the text it is about to hand to `edit`.

use serde_json::json;

use super::output::{approx_tokens, clip_line, truncation_note};
use super::{arg_str, arg_usize, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::filesystem::operations::{self, FileKind};

/// Lines per call when the model does not say. Enough for a whole small file
/// or a long function, and about 2K tokens of typical source.
const DEFAULT_LIMIT: usize = 200;

/// The most it may ask for in one call. A file that needs more than this read
/// at once is a file that should be searched instead.
const MAX_LIMIT: usize = 2_000;

/// Where one line stops being worth reading. A minified bundle is one line of
/// two hundred thousand characters.
const MAX_LINE: usize = 500;

pub struct Read;

impl Tool for Read {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read",
            description: "Read lines from a file in the project. Returns numbered lines and \
                says how many the file has in total, so you can ask for another range. \
                Prefer a range you have a reason for — from a grep hit, or a symbol's \
                line — over reading a file from the top to find out what is in it.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file, relative to the project root."
                    },
                    "offset": {
                        "type": "integer",
                        "description": "First line to read, 1-based. Defaults to 1."
                    },
                    "limit": {
                        "type": "integer",
                        "description":
                            "How many lines to read. Defaults to 200, maximum 2000."
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let raw = arg_str(args, "path", "read")?;
        let path = ctx.resolve(&raw)?;
        let shown = ctx.display(&path);

        let file = operations::read_text_file(&path).map_err(|e| format!("read: {e}"))?;
        match file.kind {
            FileKind::Missing => return Err(missing(ctx, &raw, &shown)),
            FileKind::Binary => {
                /*
                  An image gets a different sentence from a `.so`.

                  "Nothing to read as text" is true of both and useful
                  about neither: faced with a PNG the model said it had
                  no image-to-text step and asked the person to paste
                  the file in — which they had already mentioned with
                  `@`. The honest answer names the one route a picture
                  has into a conversation, because there is exactly
                  one.
                */
                let image = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| {
                        matches!(
                            e.to_ascii_lowercase().as_str(),
                            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" | "avif"
                        )
                    })
                    .unwrap_or(false);
                if image {
                    return Err(format!(
                        "read: {shown} is an image, and this tool only reads text. A picture \
                         reaches you when the person attaches it to a message — mentioning it \
                         with @, pasting it, or dropping it on the box. Ask them to do that \
                         rather than describing what you cannot see."
                    ));
                }
                return Err(format!(
                    "read: {shown} is binary ({} bytes). Nothing to read as text.",
                    file.size
                ));
            }
            FileKind::TooLarge => {
                return Err(format!(
                    "read: {shown} is {} bytes, too large to open. Use grep to find the part \
                     you need.",
                    file.size
                ))
            }
            FileKind::Text => {}
        }

        let lines: Vec<&str> = file.content.lines().collect();
        let total = lines.len();
        // Clamped only at the top of the range it could ever be: clamping it to
        // the file's length would turn "line 900 of a 10-line file" into a
        // silent read of line 10, where the model needs to be told.
        let offset = arg_usize(args, "offset", 1, u32::MAX as usize);
        let limit = arg_usize(args, "limit", DEFAULT_LIMIT, MAX_LIMIT);

        if offset > total {
            return Err(format!(
                "read: {shown} has {total} lines, so line {offset} does not exist"
            ));
        }

        let start = offset - 1;
        let end = (start + limit).min(total);
        let width = end.to_string().len();

        let mut body = String::new();
        for (i, line) in lines[start..end].iter().enumerate() {
            body.push_str(&format!(
                "{:>width$}  {}\n",
                start + i + 1,
                clip_line(line, MAX_LINE),
                width = width
            ));
        }

        /*
          The header, and why the totals are in it.

          Without them a short answer and a cut one look identical, and the
          model's next move is to read the file again from the top — which is
          the single most expensive mistake it can make with this tool.
        */
        let header = if start == 0 && end == total {
            format!("{shown} ({total} lines)")
        } else {
            format!("{shown} (lines {}–{end} of {total})", start + 1)
        };

        let mut text = format!("{header}\n{body}");
        if end < total {
            text.push_str(&truncation_note(
                total - end,
                "line",
                &format!("read again with offset {}", end + 1),
            ));
            text.push('\n');
        }

        Ok(ToolOutput::text(text).with_detail(json!({
            "path": shown,
            "from": start + 1,
            "to": end,
            "total": total,
            "tokens": approx_tokens(&body),
        })))
    }
}

/// A missing file, with the nearest name in the same folder if there is one.
///
/// `did you mean src/main.rs?` turns a dead turn into a correction. The
/// comparison is deliberately crude — same first letter, similar length,
/// shared prefix — because anything cleverer would be a dependency for a
/// hint.
fn missing(ctx: &ToolContext, raw: &str, shown: &str) -> ToolError {
    let path = ctx.root().join(raw);
    let Some(parent) = path.parent() else {
        return format!("read: no such file: {shown}");
    };
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
        return format!("read: no such file: {shown}");
    };

    let near = std::fs::read_dir(parent).ok().and_then(|entries| {
        entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .find(|candidate| {
                let lower = candidate.to_lowercase();
                lower != name
                    && lower.chars().next() == name.chars().next()
                    && lower.len().abs_diff(name.len()) <= 2
                    && shares_most(&lower, &name)
            })
    });

    match near {
        Some(suggestion) => format!("read: no such file: {shown} — did you mean {suggestion}?"),
        None => format!("read: no such file: {shown}"),
    }
}

/// Over half the characters in the same positions, which catches a
/// transposition (`mian`/`main`) without matching unrelated names.
fn shares_most(a: &str, b: &str) -> bool {
    let same = a.chars().zip(b.chars()).filter(|(x, y)| x == y).count();
    same * 2 >= a.len().min(b.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::ToolContext;
    use std::fs;

    fn scratch(name: &str, body: &str) -> ToolContext {
        let dir = std::env::temp_dir().join(format!("figy-read-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/main.rs"), body).unwrap();
        ToolContext::new(fs::canonicalize(&dir).unwrap())
    }

    fn lines(n: usize) -> String {
        (1..=n)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_small_file_comes_back_whole_and_numbered() {
        let ctx = scratch("small", "alpha\nbeta\n");
        let out = Read.call(&ctx, &json!({ "path": "src/main.rs" })).unwrap();
        assert!(out.text.contains("src/main.rs (2 lines)"));
        assert!(out.text.contains("1  alpha"));
        assert!(out.text.contains("2  beta"));
        assert!(!out.text.contains("truncated"));
    }

    #[test]
    fn a_long_file_stops_at_the_default_and_says_where_to_resume() {
        let ctx = scratch("long", &lines(500));
        let out = Read.call(&ctx, &json!({ "path": "src/main.rs" })).unwrap();
        assert!(out.text.contains("lines 1–200 of 500"));
        assert!(out.text.contains("300 more lines"));
        assert!(out.text.contains("offset 201"));
    }

    #[test]
    fn a_range_is_honoured() {
        let ctx = scratch("range", &lines(500));
        let out = Read
            .call(&ctx, &json!({ "path": "src/main.rs", "offset": 100, "limit": 3 }))
            .unwrap();
        assert!(out.text.contains("lines 100–102 of 500"));
        assert!(out.text.contains("100  line 100"));
        assert!(!out.text.contains("line 103\n"));
    }

    #[test]
    fn a_limit_past_the_maximum_is_clamped_rather_than_refused() {
        let ctx = scratch("clamp", &lines(10));
        let out = Read
            .call(&ctx, &json!({ "path": "src/main.rs", "limit": 999_999 }))
            .unwrap();
        assert!(out.text.contains("(10 lines)"));
    }

    #[test]
    fn an_offset_past_the_end_says_how_long_the_file_is() {
        let ctx = scratch("past-end", &lines(10));
        let err = Read
            .call(&ctx, &json!({ "path": "src/main.rs", "offset": 99 }))
            .unwrap_err();
        assert!(err.contains("has 10 lines"));
    }

    #[test]
    fn a_misspelled_name_gets_a_suggestion() {
        let ctx = scratch("typo", "fn main() {}\n");
        let err = Read.call(&ctx, &json!({ "path": "src/mian.rs" })).unwrap_err();
        assert!(err.contains("did you mean main.rs?"), "got: {err}");
    }

    #[test]
    fn a_path_outside_the_project_is_refused() {
        let ctx = scratch("escape", "x\n");
        let err = Read
            .call(&ctx, &json!({ "path": "../../../etc/passwd" }))
            .unwrap_err();
        assert!(err.contains("outside"));
    }

    #[test]
    fn a_minified_line_is_clipped_rather_than_returned() {
        let ctx = scratch("minified", &"x".repeat(200_000));
        let out = Read.call(&ctx, &json!({ "path": "src/main.rs" })).unwrap();
        assert!(out.text.len() < 2_000);
        assert!(out.text.contains("more characters"));
    }
}

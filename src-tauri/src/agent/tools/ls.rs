//! `ls(path)` — what is in a folder.
//!
//! The tool that looks least necessary next to `glob` and earns its place on
//! the first turn of every session: *what kind of project is this?* is
//! answered by the top-level listing and by nothing else as cheaply. A
//! `glob("**/*")` answers it too, at four thousand paths.
//!
//! Folders first, then files, each sorted — not because order is pretty but
//! because a stable listing is a cacheable one. The same `ls` on the next
//! turn produces the same bytes, which is the difference between a prefix
//! that holds and one that is rewritten for no reason.

use serde_json::json;

use super::output::cap_lines;
use super::{arg_str, arg_usize, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::filesystem::operations;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 400;

pub struct Ls;

impl Tool for Ls {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "ls",
            description: "List what is in a folder: sub-folders first, then files with their \
                sizes. Hidden entries are included only when asked for. Use it to find \
                your way around a project; use `glob` when you know the shape of the \
                name you want.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description":
                            "Folder to list, relative to the project root. Defaults to the \
                             root itself."
                    },
                    "hidden": {
                        "type": "boolean",
                        "description": "Include dotfiles. Default false."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum entries. Default 100, maximum 400."
                    }
                },
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        // The only tool whose path argument is optional: "what is in this
        // project" is the question it is usually asked.
        let raw = arg_str(args, "path", "ls").unwrap_or_else(|_| ".".to_string());
        let path = ctx.resolve(&raw)?;
        let shown = {
            let relative = ctx.display(&path);
            if relative.is_empty() || relative == "." {
                ".".to_string()
            } else {
                relative
            }
        };

        if !path.is_dir() {
            return Err(format!("ls: {shown} is not a folder. Use `read` for a file."));
        }

        let hidden = super::arg_bool(args, "hidden");
        let limit = arg_usize(args, "limit", DEFAULT_LIMIT, MAX_LIMIT);

        let mut entries =
            operations::list_directory(&path, hidden).map_err(|e| format!("ls: {e}"))?;

        // Folders first, then names, so two calls a turn apart produce the
        // same bytes. `read_dir` order is the filesystem's and is not stable
        // across machines or across a write.
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));

        let folders = entries.iter().filter(|e| e.is_dir).count();
        let files = entries.len() - folders;

        let lines: Vec<String> = entries
            .iter()
            .map(|entry| {
                if entry.is_dir {
                    format!("{}/", entry.name)
                } else {
                    format!("{}  {}", entry.name, size(entry.size))
                }
            })
            .collect();

        /*
          The other folders, named where they will be found.

          `ls` with no argument is the first thing an agent runs and
          what it learns from it is what it believes the project is.
          A window that has been granted `~/work/acme-mcp` and does
          not say so here has an agent that will tell the user, with
          confidence, that no such folder exists — which is what it
          did.

          Listed only at the root, and by name rather than by path,
          because the name is what `resolve` accepts back.
        */
        let mut lines = lines;
        if shown == "." && !ctx.extra.is_empty() {
            for dir in &ctx.extra {
                let name = dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| dir.to_string_lossy().to_string());
                lines.push(format!("{name}/  (also reachable, outside the project)"));
            }
        }

        let (kept, note) = cap_lines(lines, limit, "list a sub-folder, or use glob");
        let mut text = format!(
            "{shown} — {folders} folder{}, {files} file{}\n{}\n",
            if folders == 1 { "" } else { "s" },
            if files == 1 { "" } else { "s" },
            kept.join("\n")
        );
        if let Some(note) = note {
            text.push_str(&note);
            text.push('\n');
        } else if entries.is_empty() {
            text = format!("{shown} is empty\n");
        }

        Ok(ToolOutput::text(text).with_detail(json!({
            "path": shown,
            "folders": folders,
            "files": files,
        })))
    }
}

/// Short enough to sit at the end of a line without being the line.
fn size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes}B");
    }
    if bytes < 1024 * 1024 {
        return format!("{}K", bytes / 1024);
    }
    format!("{:.1}M", bytes as f64 / (1024.0 * 1024.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> ToolContext {
        let dir = std::env::temp_dir().join(format!("figy-ls-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("docs")).unwrap();
        fs::write(dir.join("README.md"), "# hi\n").unwrap();
        fs::write(dir.join("Cargo.toml"), "[package]\n").unwrap();
        fs::write(dir.join(".hidden"), "x").unwrap();
        ToolContext::new(fs::canonicalize(&dir).unwrap())
    }

    #[test]
    fn the_root_is_the_default_and_folders_come_first() {
        let ctx = scratch("default");
        let out = Ls.call(&ctx, &json!({})).unwrap();
        let lines: Vec<&str> = out.text.lines().collect();
        assert!(lines[0].contains("2 folders, 2 files"));
        assert_eq!(lines[1], "docs/");
        assert_eq!(lines[2], "src/");
        assert!(lines[3].starts_with("Cargo.toml"));
    }

    #[test]
    fn the_same_listing_twice_is_the_same_bytes() {
        // Unstable order would rewrite the cache prefix for nothing.
        let ctx = scratch("stable");
        let first = Ls.call(&ctx, &json!({})).unwrap().text;
        let second = Ls.call(&ctx, &json!({})).unwrap().text;
        assert_eq!(first, second);
    }

    #[test]
    fn dotfiles_are_left_out_until_they_are_asked_for() {
        let ctx = scratch("hidden");
        assert!(!Ls.call(&ctx, &json!({})).unwrap().text.contains(".hidden"));
        assert!(Ls
            .call(&ctx, &json!({ "hidden": true }))
            .unwrap()
            .text
            .contains(".hidden"));
    }

    #[test]
    fn a_long_listing_is_capped_and_says_so() {
        let ctx = scratch("many");
        for i in 0..50 {
            fs::write(ctx.root().join(format!("f{i:03}.txt")), "x").unwrap();
        }
        let out = Ls.call(&ctx, &json!({ "limit": 10 })).unwrap();
        assert!(out.text.contains("more lines"));
        assert!(out.text.contains("glob"));
    }

    #[test]
    fn a_file_is_pointed_at_read() {
        let ctx = scratch("file");
        let err = Ls.call(&ctx, &json!({ "path": "README.md" })).unwrap_err();
        assert!(err.contains("not a folder"));
        assert!(err.contains("`read`"));
    }

    #[test]
    fn an_empty_folder_says_it_is_empty() {
        let ctx = scratch("empty");
        fs::create_dir_all(ctx.root().join("nothing")).unwrap();
        let out = Ls.call(&ctx, &json!({ "path": "nothing" })).unwrap();
        assert!(out.text.contains("is empty"));
    }

    #[test]
    fn sizes_are_short_enough_to_sit_at_the_end_of_a_line() {
        assert_eq!(size(512), "512B");
        assert_eq!(size(2048), "2K");
        assert_eq!(size(5 * 1024 * 1024), "5.0M");
    }

    #[test]
    fn a_folder_outside_the_project_is_refused() {
        let ctx = scratch("escape");
        assert!(Ls
            .call(&ctx, &json!({ "path": "../.." }))
            .unwrap_err()
            .contains("outside"));
    }
}

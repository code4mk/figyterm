//! `move` and `delete` — the two that change the shape of a project rather
//! than its contents.
//!
//! Both are small and both are riskier than their size suggests, so both
//! are narrower than the filesystem allows.
//!
//! **`delete` goes to the trash.** `TOOLS.md` is explicit: it is the only
//! tool whose mistake is unrecoverable without git, so either it goes to the
//! trash or it is not offered. The `trash` crate is already a dependency
//! because the editor made the same decision. There is no "permanently"
//! flag, and that is not an omission — an agent that can empty the trash on
//! its own has the capability the trash exists to deny it.
//!
//! **`move` refuses to land on something.** `fs::rename` overwrites
//! silently, which here would mean a file disappearing because the model
//! guessed a destination that was already taken.

use serde_json::json;

use super::{arg_str, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::filesystem::operations;

pub struct Move;

impl Tool for Move {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "move",
            description: "Move or rename a file or folder inside the project. Refuses if \
                something is already at the destination. This does not update imports or \
                references — search for them afterwards.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "from": {
                        "type": "string",
                        "description": "What to move, relative to the project root."
                    },
                    "to": {
                        "type": "string",
                        "description": "Where it goes. Parent folders are created."
                    }
                },
                "required": ["from", "to"],
                "additionalProperties": false
            }),
            class: Class::Write,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let from_raw = arg_str(args, "from", "move")?;
        let to_raw = arg_str(args, "to", "move")?;

        let from = ctx.resolve(&from_raw)?;
        let to = ctx.resolve(&to_raw)?;
        let from_shown = ctx.display(&from);
        let to_shown = ctx.display(&to);

        if !from.exists() {
            return Err(format!("move: no such file: {from_shown}"));
        }
        if from == to {
            return Err(format!("move: {from_shown} is already where it is"));
        }

        operations::rename(&from, &to).map_err(|e| format!("move: {e}"))?;

        Ok(
            ToolOutput::text(format!("Moved {from_shown} → {to_shown}")).with_detail(json!({
                "from": from_shown,
                "to": to_shown,
            })),
        )
    }
}

pub struct Delete;

impl Tool for Delete {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "delete",
            description: "Move a file or folder to the system trash. It is recoverable from \
                there; nothing here deletes permanently.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "What to delete, relative to the project root."
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            class: Class::Write,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let raw = arg_str(args, "path", "delete")?;
        let path = ctx.resolve(&raw)?;
        let shown = ctx.display(&path);

        if !path.exists() {
            return Err(format!("delete: no such file: {shown}"));
        }
        // Deleting the folder the session is rooted at would leave every
        // other tool resolving against something that is not there.
        if path == ctx.root() {
            return Err("delete: that is the project folder itself".into());
        }

        let was_dir = path.is_dir();
        // `true`: the trash, always. See the module docs.
        operations::delete(&path, true).map_err(|e| format!("delete: {e}"))?;

        Ok(ToolOutput::text(format!(
            "Moved {shown} to the trash{}",
            if was_dir { " (a folder)" } else { "" }
        ))
        .with_detail(json!({ "path": shown, "isDir": was_dir })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> ToolContext {
        let dir = std::env::temp_dir().join(format!("figy-fsops-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/a.rs"), "a\n").unwrap();
        fs::write(dir.join("src/b.rs"), "b\n").unwrap();
        ToolContext::new(fs::canonicalize(&dir).unwrap())
    }

    #[test]
    fn a_file_moves_and_its_parents_are_made() {
        let ctx = scratch("move");
        let out = Move
            .call(&ctx, &json!({ "from": "src/a.rs", "to": "src/deep/a.rs" }))
            .unwrap();
        assert!(!ctx.root().join("src/a.rs").exists());
        assert_eq!(
            fs::read_to_string(ctx.root().join("src/deep/a.rs")).unwrap(),
            "a\n"
        );
        assert!(out.text.contains("src/a.rs → src/deep/a.rs"));
    }

    #[test]
    fn moving_onto_something_is_refused_rather_than_silent() {
        // `fs::rename` would destroy `b.rs` without a word.
        let ctx = scratch("clobber");
        let err = Move
            .call(&ctx, &json!({ "from": "src/a.rs", "to": "src/b.rs" }))
            .unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(fs::read_to_string(ctx.root().join("src/b.rs")).unwrap(), "b\n");
    }

    #[test]
    fn moving_something_that_is_not_there_says_so() {
        let ctx = scratch("absent");
        assert!(Move
            .call(&ctx, &json!({ "from": "src/nope.rs", "to": "src/x.rs" }))
            .unwrap_err()
            .contains("no such file"));
    }

    #[test]
    fn neither_end_of_a_move_may_leave_the_project() {
        let ctx = scratch("escape");
        assert!(Move
            .call(&ctx, &json!({ "from": "src/a.rs", "to": "../stolen.rs" }))
            .unwrap_err()
            .contains("outside"));
        assert!(ctx.root().join("src/a.rs").exists());
    }

    #[test]
    fn the_project_folder_itself_cannot_be_deleted() {
        let ctx = scratch("root");
        let err = Delete.call(&ctx, &json!({ "path": "." })).unwrap_err();
        assert!(err.contains("project folder itself"));
        assert!(ctx.root().exists());
    }

    #[test]
    fn deleting_something_that_is_not_there_says_so() {
        let ctx = scratch("gone");
        assert!(Delete
            .call(&ctx, &json!({ "path": "src/nope.rs" }))
            .unwrap_err()
            .contains("no such file"));
    }

    #[test]
    fn there_is_no_way_to_ask_for_a_permanent_delete() {
        // The capability the trash exists to deny. If this ever passes with
        // a flag in the schema, the argument in the module docs was lost.
        let schema = Delete.spec().parameters;
        let properties = schema["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 1);
        assert!(properties.contains_key("path"));
        assert!(Delete.spec().description.contains("trash"));
    }
}

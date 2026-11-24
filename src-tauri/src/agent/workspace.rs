//! The folder the agent is pointed at, and the fence around it.
//!
//! One root per window, because two windows can be open on two projects and a
//! root kept globally would answer each of them with the other's files. Every
//! path a tool is handed goes through [`resolve`] before anything touches the
//! disk: it is canonicalised first — so `..`, a symlink and `~` are all
//! resolved *before* the check rather than after — and then required to sit
//! inside the root.
//!
//! ## Why this is not the editor's root list
//!
//! `commands/fs.rs` has the same idea, and `fs_set_roots` **replaces** the
//! whole list rather than adding to it: it is called whenever the editor opens
//! a folder, and a root nobody is looking at should not stay writable. That is
//! right for the editor and fatal for a second feature — Figy Code calling it
//! would silently take the editor's folder away, and the bug would surface
//! somewhere else entirely, much later.
//!
//! `docs/figy-code-plan/TOOLS.md` lists reconciling the two as a prerequisite
//! for the read tool. This module is that reconciliation, done the narrow way:
//! the agent keeps its own root, the `@` file index reads it from here rather
//! than holding a second copy, and the editor's list is untouched. If the two
//! ever need to be one thing, this is the file that becomes it.
//!
//! What this is not: a sandbox. The root arrives from the frontend, exactly as
//! the editor's does, and a compromised frontend can set it to anything. It is
//! a guard against a path-handling mistake — a `../..` in a model-authored
//! argument, a symlinked `node_modules` — turning into a write somewhere
//! surprising. Anything stronger belongs in Tauri's capability layer.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use crate::commands::fs::{canonicalize, expand_home, to_string};

/// Per window. Entries are dropped when the window closes.
#[derive(Default)]
pub struct Workspace {
    roots: Mutex<HashMap<String, PathBuf>>,
}

impl Workspace {
    /// Points `label`'s window at `path`, and returns the canonical form.
    ///
    /// The canonical form is what the frontend should then display and
    /// compare against, so the two sides never disagree about what the folder
    /// is called — `/tmp` against `/private/tmp` on macOS, a `\\?\` prefix on
    /// Windows.
    pub fn open(&self, label: &str, path: &str) -> Result<PathBuf, String> {
        let requested = expand_home(path.trim());
        if requested.as_os_str().is_empty() {
            return Err("No folder given".into());
        }
        let root = canonicalize(&requested)?;
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        self.roots
            .lock()
            .map_err(|_| "The workspace is unavailable".to_string())?
            .insert(label.to_string(), root.clone());
        Ok(root)
    }

    pub fn root(&self, label: &str) -> Option<PathBuf> {
        self.roots.lock().ok()?.get(label).cloned()
    }

    /// Drops what a window had open. Called when the window goes away.
    pub fn forget(&self, label: &str) {
        if let Ok(mut roots) = self.roots.lock() {
            roots.remove(label);
        }
    }

    /// Turns a tool's path argument into one it may act on.
    ///
    /// Relative paths are taken against the root, which is what a model
    /// writes nine times in ten — it has been reading `src/main.rs` out of
    /// search results all session. Absolute paths are allowed and then
    /// checked, because the tenth time it pastes back something it was given.
    pub fn resolve(&self, label: &str, raw: &str) -> Result<PathBuf, String> {
        let root = self
            .root(label)
            .ok_or_else(|| "No folder is open in FigyCode".to_string())?;
        resolve_in(&root, raw)
    }
}

/// The path arithmetic, split out so it can be tested without a window.
pub fn resolve_in(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("No path given".into());
    }

    let requested = expand_home(trimmed);
    let joined = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };

    let resolved = match canonical_target(&joined) {
        Ok(path) => path,
        Err(unresolvable) => {
            /*
              It would not resolve. Two reasons, and they deserve different
              sentences.

              `../../../etc/passwd` fails here because the directory above
              the project does not contain what was asked for — but the
              interesting thing about it is that it left the project, and
              "no such file" would send the model looking for a typo. So a
              path that walks out of the root *textually* is reported as
              being outside, and only a path that stays inside and still
              will not resolve is reported as missing.
            */
            if !is_under(root, &lexical(&joined)) {
                return Err(outside(&joined));
            }
            return Err(unresolvable);
        }
    };

    if !is_under(root, &resolved) {
        return Err(outside(&resolved));
    }
    Ok(resolved)
}

fn outside(path: &Path) -> String {
    format!(
        "{} is outside the folder FigyCode is open on",
        path.display()
    )
}

/// Canonicalises a path, including one that does not exist yet.
///
/// Symlinks are resolved *before* the containment check rather than after
/// it, which is the whole reason this is not string arithmetic: a symlinked
/// `node_modules` pointing at `/` would otherwise read as being inside the
/// project. A file about to be created has no symlinks of its own, so its
/// parent is canonicalised and its last component checked for being a name
/// rather than another step of a traversal.
fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return canonicalize(path);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("{} does not exist", path.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("{} is not a file path", path.display()))?;
    if Path::new(name).components().count() != 1
        || matches!(
            Path::new(name).components().next(),
            Some(Component::ParentDir) | Some(Component::CurDir)
        )
    {
        return Err(format!("{} is not a valid name", name.to_string_lossy()));
    }
    Ok(canonicalize(parent)?.join(name))
}

/// `a/b/../c` → `a/c`, without touching the disk.
///
/// Only used to choose the better error message above. It is not the
/// containment check: `..` cancelled textually says nothing about symlinks,
/// which is exactly what the real check is for.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            // At the root this does nothing, which is also what the
            // filesystem does with `/..`.
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// `src/main.rs`, for a message or a tool result — never the absolute path.
///
/// Absolute paths in tool output are tokens spent on the same prefix over and
/// over: forty results under `/Users/someone/GitHub/project/` is that string
/// forty times, on every turn for the rest of the session.
pub fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|rel| {
            rel.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|_| to_string(path))
}

/// Component-wise rather than string-wise: `/a/bc` must not count as being
/// inside `/a/b`.
fn is_under(root: &Path, path: &Path) -> bool {
    let mut root_parts = root.components();
    let mut path_parts = path.components();
    loop {
        match (root_parts.next(), path_parts.next()) {
            (None, _) => return true,
            (Some(_), None) => return false,
            (Some(a), Some(b)) if a != b => return false,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A real directory, because `resolve` canonicalises and canonicalising
    /// something that is not there is the case it handles separately.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("figy-ws-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn a_relative_path_is_taken_against_the_root() {
        let root = scratch("relative");
        let got = resolve_in(&root, "src/main.rs").unwrap();
        assert_eq!(got, root.join("src").join("main.rs"));
    }

    #[test]
    fn an_absolute_path_inside_the_root_is_allowed() {
        let root = scratch("absolute");
        let inside = root.join("src/main.rs");
        assert!(resolve_in(&root, &inside.to_string_lossy()).is_ok());
    }

    #[test]
    fn a_traversal_out_of_the_root_is_refused() {
        let root = scratch("traversal");
        let err = resolve_in(&root, "../../../etc/passwd").unwrap_err();
        assert!(err.contains("outside"), "unexpected error: {err}");
    }

    #[test]
    fn a_traversal_that_comes_back_inside_is_fine() {
        // Refusing this would be refusing a path that is, after resolution,
        // exactly where it is allowed to be.
        let root = scratch("roundtrip");
        assert!(resolve_in(&root, "src/../src/main.rs").is_ok());
    }

    #[test]
    fn a_file_that_does_not_exist_yet_resolves_to_where_it_would_go() {
        let root = scratch("new-file");
        let got = resolve_in(&root, "src/new.rs").unwrap();
        assert_eq!(got, root.join("src").join("new.rs"));
    }

    #[test]
    fn a_new_file_outside_the_root_is_refused_too() {
        let root = scratch("new-outside");
        assert!(resolve_in(&root, "../escape.txt").is_err());
    }

    #[test]
    fn an_empty_path_is_an_error_rather_than_the_root() {
        let root = scratch("empty");
        assert!(resolve_in(&root, "   ").is_err());
    }

    #[test]
    fn a_sibling_folder_with_a_shared_prefix_is_outside() {
        // `/tmp/figy-ws-prefix` and `/tmp/figy-ws-prefix-other` share a string
        // prefix and are different folders.
        let root = scratch("prefix");
        let sibling = scratch("prefix-other");
        let err = resolve_in(&root, &sibling.join("src/main.rs").to_string_lossy()).unwrap_err();
        assert!(err.contains("outside"), "unexpected error: {err}");
    }

    #[test]
    fn paths_are_shown_relative_to_the_root() {
        let root = PathBuf::from("/a/b");
        assert_eq!(display_path(&root, Path::new("/a/b/src/main.rs")), "src/main.rs");
        // Outside it, there is nothing to shorten and the whole path is used.
        assert_eq!(display_path(&root, Path::new("/x/y.rs")), "/x/y.rs");
    }
}

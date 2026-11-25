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

/// Per window **and surface**, for the reason the sessions are.
///
/// The editor is a modal in the same Tauri window as FigyCode, so a
/// root keyed by window alone is one root between two agents. That
/// is harmless right up until the panel exists and somebody has the
/// editor open on one repository and FigyCode on another — at which
/// point whichever spoke last decides where the other one's `edit`
/// lands. A key that is the same shape as the session's is the whole
/// fix, and it is cheaper to do before there is a panel than after.
///
/// Entries are dropped when the window closes.
#[derive(Default)]
pub struct Workspace {
    roots: Mutex<HashMap<String, PathBuf>>,
    /// Folders a window may also reach, beyond its root.
    ///
    /// These existed in the window's `localStorage` for a while and
    /// nowhere else, which made them a label rather than a grant: the
    /// settings said the agent could read `~/acme-mcp` and every tool
    /// refused it, because the only folder the backend had ever been
    /// told about was the root. A permission the enforcement has never
    /// heard of is worse than no permission at all — it is a promise
    /// the window makes on the agent's behalf.
    extra: Mutex<HashMap<String, Vec<PathBuf>>>,
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

    /// Replaces the folders this window may also reach.
    ///
    /// Replaces rather than adds, because the window owns the list and
    /// sends the whole of it: a backend that accumulated would keep a
    /// folder alive after it had been taken away, which is the half of
    /// a permission that has to be right.
    ///
    /// Anything that will not canonicalise is dropped quietly — a
    /// folder that has been renamed or unmounted is not an error worth
    /// failing a turn over, and `/project` shows it as unreadable.
    pub fn set_extra(&self, label: &str, dirs: &[String]) -> Vec<PathBuf> {
        let root = self.root(label);
        let resolved: Vec<PathBuf> = dirs
            .iter()
            .filter_map(|dir| canonicalize(&expand_home(dir.trim())).ok())
            .filter(|dir| dir.is_dir())
            // The root is never also an extra: a folder listed twice
            // is a folder reported twice in every message that names
            // what the agent can reach.
            .filter(|dir| root.as_deref() != Some(dir.as_path()))
            .collect();

        if let Ok(mut extra) = self.extra.lock() {
            extra.insert(label.to_string(), resolved.clone());
        }
        resolved
    }

    pub fn extra(&self, label: &str) -> Vec<PathBuf> {
        self.extra
            .lock()
            .ok()
            .and_then(|all| all.get(label).cloned())
            .unwrap_or_default()
    }

    /// Everything this window may touch: the root first, then the rest.
    ///
    /// Order matters. The root is where a relative path is taken from
    /// and what a path is shown relative to, and the extras are the
    /// places it is also allowed to end up.
    pub fn reachable(&self, label: &str) -> Vec<PathBuf> {
        let mut all: Vec<PathBuf> = self.root(label).into_iter().collect();
        all.extend(self.extra(label));
        all
    }

    /// Drops what a window had open. Called when the window goes away.
    pub fn forget(&self, label: &str) {
        // Every surface of that window: the key carries both, and a
        // closed window takes its panel with it.
        let mine = format!("{label}/");
        if let Ok(mut roots) = self.roots.lock() {
            roots.retain(|key, _| key != label && !key.starts_with(&mine));
        }
        if let Ok(mut extra) = self.extra.lock() {
            extra.retain(|key, _| key != label && !key.starts_with(&mine));
        }
    }

    /// Turns a tool's path argument into one it may act on.
    ///
    /// Relative paths are taken against the root, which is what a model
    /// writes nine times in ten — it has been reading `src/main.rs` out of
    /// search results all session. Absolute paths are allowed and then
    /// checked, because the tenth time it pastes back something it was given.
    pub fn resolve(&self, label: &str, raw: &str) -> Result<PathBuf, String> {
        let roots = self.reachable(label);
        if roots.is_empty() {
            return Err("No folder is open in FigyCode".into());
        }
        resolve_within(&roots, raw)
    }
}

/// The same arithmetic, over every folder the window may touch.
///
/// `roots[0]` is the project and the rest are the extras, and the
/// order is the whole of the rule: a relative path means the project
/// unless it cannot, because that is what a model writes nine times
/// in ten after a session of reading `src/main.rs` out of search
/// results.
///
/// Three ways a path can land in an extra folder, in the order they
/// are tried:
///
/// 1. **By its own name.** `acme-mcp/README.md`, where `acme-mcp` is
///    the basename of an extra folder. This is the one that matters —
///    a model told it can also reach `~/work/acme-mcp` will write
///    exactly that, and nothing else here would have accepted it.
/// 2. **Absolutely.** It was given the full path and pasted it back.
/// 3. **Relatively, after the project refused.** A fallback rather
///    than a rule, so a file that exists in both is the project's.
///
/// The error comes from the *project*, not from the last folder
/// tried: "outside the folder FigyCode is open on" is the sentence
/// that explains the situation, and "no such file in ~/notes" would
/// send the model looking for a typo in the wrong place.
pub fn resolve_within(roots: &[PathBuf], raw: &str) -> Result<PathBuf, String> {
    let Some((root, extra)) = roots.split_first() else {
        return Err("No folder is open in FigyCode".into());
    };

    let trimmed = raw.trim();
    if !extra.is_empty() {
        // By name, before anything else: the leading component of a
        // relative path naming one of the extra folders.
        let requested = expand_home(trimmed);
        if requested.is_relative() {
            if let Some(first) = requested.components().next() {
                let head = first.as_os_str();
                if let Some(dir) = extra.iter().find(|d| d.file_name() == Some(head)) {
                    let rest: PathBuf = requested.components().skip(1).collect();
                    let within = if rest.as_os_str().is_empty() {
                        ".".to_string()
                    } else {
                        rest.to_string_lossy().to_string()
                    };
                    if let Ok(found) = resolve_in(dir, &within) {
                        return Ok(found);
                    }
                }
            }
        }
    }

    let first = resolve_in(root, trimmed);
    if first.is_ok() || extra.is_empty() {
        return first;
    }
    for dir in extra {
        if let Ok(found) = resolve_in(dir, trimmed) {
            return Ok(found);
        }
    }
    first
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

/// What to call a path, given everything the window can reach.
///
/// Relative to the project where it is in the project, and prefixed
/// with the extra folder's own name where it is not — `acme-mcp/src/
/// index.ts` rather than an absolute path, because that is the name
/// the model was given and the one it can write back.
pub fn display_within(roots: &[PathBuf], path: &Path) -> String {
    for (index, root) in roots.iter().enumerate() {
        if let Ok(rel) = path.strip_prefix(root) {
            let tail = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if index == 0 {
                return tail;
            }
            let name = root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| to_string(root));
            return if tail.is_empty() {
                name
            } else {
                format!("{name}/{tail}")
            };
        }
    }
    to_string(path)
}

/// Canonicalises a path, including one that does not exist yet.
///
/// Symlinks are resolved *before* the containment check rather than after
/// it, which is the whole reason this is not string arithmetic: a symlinked
/// `node_modules` pointing at `/` would otherwise read as being inside the
/// project.
///
/// A path that is not there yet is resolved against the deepest ancestor
/// that **is**, and the rest re-appended. Not just the immediate parent:
/// `write` and `move` both create folders on the way, so `src/deep/new.rs`
/// in a project with no `src/deep` is an ordinary request and not an error.
/// Each re-appended component is checked for being a name rather than
/// another step of a traversal, since nothing on disk can vouch for it.
fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return canonicalize(path);
    }

    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    loop {
        let name = cursor
            .file_name()
            .ok_or_else(|| format!("{} is not a file path", path.display()))?;
        if matches!(
            Path::new(name).components().next(),
            Some(Component::ParentDir) | Some(Component::CurDir)
        ) {
            return Err(format!("{} is not a valid name", name.to_string_lossy()));
        }
        tail.push(name.to_os_string());

        let parent = cursor
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("{} does not exist", path.display()))?;
        if parent.exists() {
            let mut out = canonicalize(parent)?;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return Ok(out);
        }
        cursor = parent;
    }
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
    fn a_new_file_under_folders_that_do_not_exist_yet_resolves() {
        // `write` and `move` both create the folders on the way, so this is
        // an ordinary request rather than an error.
        let root = scratch("new-deep");
        let got = resolve_in(&root, "src/one/two/new.rs").unwrap();
        assert_eq!(got, root.join("src").join("one").join("two").join("new.rs"));
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

    /* ─── Folders beyond the root ──────────────────────────────────────── */

    /*
      The bug these are for.

      An extra folder lived in the window's `localStorage` and nowhere
      else, so the settings said the agent could reach `~/acme-mcp`
      and every tool refused it. Asked for a file tree, the agent
      listed the project and told the user — correctly, from where it
      was standing — that no such folder existed. A permission the
      enforcement has never heard of is a promise the window makes on
      the agent's behalf.
    */
    /// A folder whose basename is exactly what is asked for, which
    /// `scratch` cannot give: it prefixes every name with `figy-ws-`,
    /// and the whole point here is the name a model would type.
    fn named(parent: &str, name: &str) -> PathBuf {
        let dir = scratch(parent).join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn a_file_in_an_extra_folder_resolves_by_that_folder_s_name() {
        let root = scratch("extra-root");
        let other = named("extra-home", "acme-mcp");
        std::fs::write(other.join("README.md"), "hi").unwrap();
        let roots = vec![root.clone(), other.clone()];

        // The way a model writes it, having been told the name.
        let found = resolve_within(&roots, "acme-mcp/README.md").unwrap();
        assert_eq!(found, canonicalize(&other.join("README.md")).unwrap());

        // And the way it writes it back after being handed a path.
        let absolute = other.join("README.md").to_string_lossy().to_string();
        assert_eq!(resolve_within(&roots, &absolute).unwrap(), found);
    }

    #[test]
    fn the_project_wins_a_name_that_exists_in_both() {
        let root = scratch("both-root");
        let other = named("both-home", "both-extra");
        std::fs::write(root.join("README.md"), "project").unwrap();
        std::fs::write(other.join("README.md"), "extra").unwrap();

        let found = resolve_within(&vec![root.clone(), other], "README.md").unwrap();
        assert_eq!(std::fs::read_to_string(found).unwrap(), "project");
    }

    #[test]
    fn a_folder_that_was_never_granted_is_still_outside() {
        let root = scratch("granted-root");
        let granted = scratch("granted-extra");
        let stranger = scratch("granted-stranger");
        std::fs::write(stranger.join("secrets.env"), "no").unwrap();

        let err = resolve_within(
            &vec![root, granted],
            &stranger.join("secrets.env").to_string_lossy(),
        )
        .unwrap_err();
        // And the sentence is the project's, because that is the one
        // that explains the situation.
        assert!(err.contains("outside"), "unexpected error: {err}");
    }

    #[test]
    fn an_extra_folder_is_shown_by_its_name_rather_than_its_path() {
        // The name is what `resolve_within` accepts back, so it is the
        // name a result has to use — an absolute path in a search
        // result is one the model cannot shorten again.
        let roots = vec![PathBuf::from("/a/b"), PathBuf::from("/x/acme-mcp")];
        assert_eq!(display_within(&roots, Path::new("/a/b/src/main.rs")), "src/main.rs");
        assert_eq!(
            display_within(&roots, Path::new("/x/acme-mcp/src/index.ts")),
            "acme-mcp/src/index.ts"
        );
        assert_eq!(display_within(&roots, Path::new("/x/acme-mcp")), "acme-mcp");
        assert_eq!(display_within(&roots, Path::new("/nowhere/z.rs")), "/nowhere/z.rs");
    }

    /*
      Two surfaces in one window, on two folders.

      The editor is a modal in the same Tauri window as FigyCode, so
      a root keyed by the window alone is one root between two
      agents. Harmless until the panel exists — and then whichever
      opened last decides where the other one's `edit` lands, which
      is a file written to the wrong repository with nothing on
      screen to suggest it.
    */
    #[test]
    fn a_window_s_two_surfaces_keep_their_own_folders() {
        let workspace = Workspace::default();
        let window = scratch("surface-window");
        let panel = scratch("surface-panel");

        workspace.open("main/window", &window.to_string_lossy()).unwrap();
        workspace.open("main/panel", &panel.to_string_lossy()).unwrap();

        assert_eq!(workspace.root("main/window").as_deref(), Some(window.as_path()));
        assert_eq!(workspace.root("main/panel").as_deref(), Some(panel.as_path()));

        // And each resolves into its own, not into the other's.
        let found = workspace.resolve("main/panel", "src/main.rs").unwrap();
        assert!(found.starts_with(&panel), "{found:?}");
    }

    #[test]
    fn closing_a_window_takes_every_surface_of_it() {
        let workspace = Workspace::default();
        let one = scratch("forget-window");
        let two = scratch("forget-panel");
        workspace.open("main/window", &one.to_string_lossy()).unwrap();
        workspace.open("main/panel", &two.to_string_lossy()).unwrap();
        workspace.set_extra("main/panel", &[one.to_string_lossy().to_string()]);

        workspace.forget("main");
        assert!(workspace.root("main/window").is_none());
        assert!(workspace.root("main/panel").is_none(), "the panel goes too");
        assert!(workspace.extra("main/panel").is_empty());
    }

    #[test]
    fn setting_the_extras_replaces_them_and_never_includes_the_root() {
        let workspace = Workspace::default();
        let root = scratch("set-root");
        let one = scratch("set-one");
        let two = scratch("set-two");
        workspace.open("w", &root.to_string_lossy()).unwrap();

        let kept = workspace.set_extra(
            "w",
            &[
                one.to_string_lossy().to_string(),
                two.to_string_lossy().to_string(),
                root.to_string_lossy().to_string(),
                "/nowhere/at/all".to_string(),
            ],
        );
        assert_eq!(kept.len(), 2, "the root and the missing one are dropped");
        assert_eq!(workspace.reachable("w").len(), 3, "root first, then both");

        // Replaced, not added: taking one away has to take it away.
        workspace.set_extra("w", &[one.to_string_lossy().to_string()]);
        assert_eq!(workspace.extra("w").len(), 1);
        assert!(workspace
            .resolve("w", &two.join("x.txt").to_string_lossy())
            .is_err());
    }

    #[test]
    fn paths_are_shown_relative_to_the_root() {
        let root = PathBuf::from("/a/b");
        assert_eq!(display_path(&root, Path::new("/a/b/src/main.rs")), "src/main.rs");
        // Outside it, there is nothing to shorten and the whole path is used.
        assert_eq!(display_path(&root, Path::new("/x/y.rs")), "/x/y.rs");
    }
}

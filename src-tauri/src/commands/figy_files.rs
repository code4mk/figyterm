//! The `@` file search behind the Figy Code window.
//!
//! Quick-open, in the shape that window needs it: the project is declared
//! once, the tree is walked once into an index, and every keystroke after
//! that is a ranking pass over strings already in memory. A walk per
//! keystroke is what makes this feel broken on a repository of any size —
//! the first few hundred files arrive instantly and then the list stutters
//! for a second behind every letter.
//!
//! ## Why this is not `fs_list_files`
//!
//! The editor's filesystem commands all go through `fs::resolve`, which
//! requires the path to sit inside the roots that window's editor registered
//! — and `fs_set_roots` **replaces** the list rather than adding to it. A
//! second feature calling it would silently take the editor's folder away,
//! which is a bug that shows up much later and somewhere else entirely. So
//! Figy Code keeps its own root, in its own state, and this module is the
//! only thing that reads it. When the agent in `docs/CODE-AGENT.md` arrives
//! and needs real read and edit tools, the two root lists are what have to
//! be reconciled; until then they stay apart on purpose.
//!
//! What this is not: a sandbox. The root arrives from the frontend, like the
//! editor's does, and `commands/fs.rs` says the same thing about its own
//! guard. Canonicalising it and requiring a directory is a guard against a
//! path-handling mistake, not against a hostile caller.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use serde::Serialize;
use tauri::{State, Window};

/*
  The root is the agent's, not this module's.

  It had one of its own, which meant two answers to "what folder is FigyCode
  open on" that agreed only by accident. `agent/workspace.rs` owns it now and
  this module asks: the `@` index and the tools are looking at the same tree
  by construction rather than by convention.
*/
use crate::agent::workspace::Workspace;
use crate::commands::fs::{canonicalize, expand_home};

/// Where the index stops.
///
/// Enough for any repository somebody edits by hand. Past it the answer is
/// "your mention list was never going to help you find this file", and the
/// frontend is told the list was cut rather than being left to believe it saw
/// everything.
const INDEX_MAX_ENTRIES: usize = 40_000;

/// How long an index is trusted before the next search rebuilds it.
///
/// A mention list that cannot see a file created a minute ago is annoying;
/// one that re-walks the tree on every keystroke is unusable. Twenty seconds
/// is the compromise, and it is re-walked on demand rather than watched —
/// the watcher is the editor's, and subscribing a second consumer to it for
/// a list that is read in bursts of ten seconds would cost more than the
/// occasional walk.
const INDEX_TTL: Duration = Duration::from_secs(20);

/// The most hits one query can return, whatever it asks for.
const MAX_HITS: usize = 60;

/// One path in the index.
///
/// The lower-cased copy and the basename offset are precomputed because they
/// are read on every keystroke for every entry: forty thousand
/// `to_lowercase()` calls per letter typed is the difference between a list
/// that keeps up and one that does not.
struct Entry {
    rel: String,
    lower: String,
    /// Byte offset of the basename inside `lower`.
    base_at: usize,
    is_dir: bool,
}

struct Index {
    root: PathBuf,
    entries: Vec<Entry>,
    files: usize,
    folders: usize,
    truncated: bool,
    built: Instant,
}

/// Per window, like every other piece of filesystem state in this app: two
/// windows can be open on two projects, and an index keyed globally would
/// answer each of them with the other's files.
#[derive(Default)]
pub struct FigyState {
    indexes: Mutex<HashMap<String, Index>>,
}

/// Drops the index a window had built. Called when the window goes away.
pub fn forget_window(state: &FigyState, label: &str) {
    if let Ok(mut indexes) = state.indexes.lock() {
        indexes.remove(label);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// The canonical form, which is what the frontend should then display and
    /// compare against — so the two sides never disagree about the folder's
    /// name (`/tmp` against `/private/tmp` on macOS).
    pub root: String,
    pub files: usize,
    pub folders: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// Relative to the project root, with `/` separators on every platform —
    /// it is shown to a person and used in a prompt, not opened.
    pub path: String,
    pub is_dir: bool,
    /// Bytes, or 0 for a folder and for anything that would not stat.
    pub size: u64,
}

/* ─── The walk ───────────────────────────────────────────────────────────── */

/// Everything under `root`, files and folders, as forward-slashed relative
/// paths.
///
/// `WalkBuilder` is the `ignore` crate's, which the editor's own search
/// already uses: it honours `.gitignore`, `.git/info/exclude` and the global
/// ignore file, and it prunes an ignored directory rather than walking into
/// it. That is the difference between indexing a repository and indexing its
/// `node_modules`.
///
/// Folders are included. `@src/services/` is a useful thing to mention — it
/// says "this part of the tree" in one token — and a list that offered only
/// files would make it unsayable.
fn build_index(root: &Path) -> Index {
    let mut entries = Vec::new();
    let mut files = 0usize;
    let mut folders = 0usize;
    let mut truncated = false;

    let walker = WalkBuilder::new(root)
        .hidden(true)
        // Symlinked directories are not followed: a link back up the tree
        // turns the walk into an infinite one.
        .follow_links(false)
        .build();

    for entry in walker {
        let Ok(entry) = entry else { continue };
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        // The root walks as an empty path; it is not a thing to mention.
        if relative.as_os_str().is_empty() {
            continue;
        }
        if entries.len() >= INDEX_MAX_ENTRIES {
            truncated = true;
            break;
        }

        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let mut rel = relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if is_dir {
            folders += 1;
            // A trailing slash, so a folder reads as one in the list and in
            // the prompt the agent will eventually be handed.
            rel.push('/');
        } else {
            files += 1;
        }

        let lower = rel.to_lowercase();
        let base_at = basename_offset(&lower);
        entries.push(Entry {
            rel,
            lower,
            base_at,
            is_dir,
        });
    }

    Index {
        root: root.to_path_buf(),
        entries,
        files,
        folders,
        truncated,
        built: Instant::now(),
    }
}

/// Where the last path segment starts, ignoring a trailing slash on a folder.
fn basename_offset(path: &str) -> usize {
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    trimmed.rfind('/').map(|i| i + 1).unwrap_or(0)
}

/* ─── Ranking ────────────────────────────────────────────────────────────── */

/// How well `path` answers `query`, or `None` when it does not answer it at
/// all.
///
/// A subsequence match with bonuses, which is the shape every quick-open
/// converges on, and the bonuses are the whole design:
///
/// - **Consecutive characters** are worth far more than scattered ones, so
///   `claude-pro` beats a path that merely contains those ten letters spread
///   across three directories.
/// - **The filename** outranks the path, because `api` typed into a mention
///   is nearly always about a file called that and not about the forty files
///   under `src/api/`.
/// - **Segment and word starts** score, so `cpt` finds `claude-project.ts`.
/// - **Length is a tiebreak**, lightly: of two files that match equally,
///   the shallower one is usually the one meant.
///
/// Greedy rather than optimal. A full dynamic-programming match is better on
/// pathological queries and costs an allocation per candidate on every
/// keystroke; against forty thousand paths that trade is the wrong way round.
/// `lower_query` must already be lower-cased — it is hoisted out of the loop
/// by the caller.
fn score_path(entry: &Entry, lower_query: &str) -> Option<i32> {
    if lower_query.is_empty() {
        // No query: everything matches, shallow things first.
        return Some(-(entry.lower.len() as i32));
    }

    let hay = entry.lower.as_bytes();
    let needle = lower_query.as_bytes();

    let mut score = 0i32;
    let mut qi = 0usize;
    let mut previous: Option<usize> = None;

    for (i, byte) in hay.iter().enumerate() {
        if qi >= needle.len() {
            break;
        }
        if *byte != needle[qi] {
            continue;
        }

        let mut points = 1;
        if previous == Some(i.wrapping_sub(1)) {
            points += 8;
        }
        if i >= entry.base_at {
            points += 6;
        }
        if i == 0 || matches!(hay[i - 1], b'/' | b'_' | b'-' | b'.' | b' ') {
            points += 5;
        }

        score += points;
        previous = Some(i);
        qi += 1;
    }

    if qi < needle.len() {
        return None;
    }

    // A run of the query, spelled exactly, is worth more than any
    // arrangement of the same letters — and in the filename, more again.
    if entry.lower[entry.base_at..].contains(lower_query) {
        score += 24;
        if entry.lower[entry.base_at..].starts_with(lower_query) {
            score += 16;
        }
    } else if entry.lower.contains(lower_query) {
        score += 10;
    }

    // Shallower and shorter, all else equal.
    score -= (entry.lower.len() as i32) / 8;
    score -= (entry.lower.matches('/').count() as i32) * 2;

    Some(score)
}

/// The best `limit` entries for `query`, best first.
fn rank(index: &Index, query: &str, limit: usize) -> Vec<FileHit> {
    let lower_query = query.trim().to_lowercase();

    let mut scored: Vec<(i32, &Entry)> = index
        .entries
        .iter()
        .filter_map(|entry| score_path(entry, &lower_query).map(|score| (score, entry)))
        .collect();

    /*
      Sorted by score, then by path, so an equal score is not an arbitrary
      order that changes between two identical queries — a list that
      reshuffles under the cursor is a list nobody can click.
    */
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.rel.cmp(&b.1.rel)));

    scored
        .into_iter()
        .take(limit.clamp(1, MAX_HITS))
        .map(|(_, entry)| FileHit {
            path: entry.rel.clone(),
            is_dir: entry.is_dir,
            // Statted here rather than during the walk: this is at most sixty
            // files, against forty thousand, and the number is only ever
            // shown beside a row somebody is already looking at.
            size: if entry.is_dir {
                0
            } else {
                index
                    .root
                    .join(&entry.rel)
                    .metadata()
                    .map(|m| m.len())
                    .unwrap_or(0)
            },
        })
        .collect()
}

/* ─── Commands ───────────────────────────────────────────────────────────── */

/// Points the window at a folder, and indexes it.
///
/// `async` because the walk is the slow part and the UI thread is not where
/// it belongs: on a cold cache a large repository takes a second or two, and
/// a synchronous command would freeze every window in the app while it ran.
#[tauri::command(async)]
pub fn figy_open_project(
    window: Window,
    state: State<FigyState>,
    workspace: State<Workspace>,
    path: String,
) -> Result<ProjectInfo, String> {
    // The workspace does the validating and the remembering; this command is
    // only the index on top of it. One answer to "which folder", shared with
    // every tool the agent has.
    let root = workspace.open(window.label(), &path)?;

    let index = build_index(&root);
    let info = ProjectInfo {
        root: root.to_string_lossy().to_string(),
        files: index.files,
        folders: index.folders,
        truncated: index.truncated,
    };

    state
        .indexes
        .lock()
        .map_err(|_| "The project index is unavailable".to_string())?
        .insert(window.label().to_string(), index);

    Ok(info)
}

/// Replaces the folders this window may reach beyond its project.
///
/// The window owns the list — it is in its `localStorage` and edited
/// in `/project` — and sends the whole of it whenever it changes.
/// Replacing rather than adding is the half that has to be right: a
/// backend that accumulated would keep a folder reachable after it
/// had been taken away.
///
/// Answers with the ones that resolved, so the window can show a
/// folder that has been renamed or unmounted as unreadable rather
/// than pretending it is still granted.
#[tauri::command]
pub fn figy_set_extra_dirs(
    window: Window,
    workspace: State<Workspace>,
    dirs: Vec<String>,
) -> Result<Vec<String>, String> {
    Ok(workspace
        .set_extra(window.label(), &dirs)
        .iter()
        .map(|dir| dir.to_string_lossy().to_string())
        .collect())
}

/// How much is in a folder, without adopting it.
///
/// For the extra folders in `/project`: a count beside each one, the
/// same two numbers the project itself shows, so "this agent may also
/// reach here" comes with a sense of *how much* here is.
///
/// Deliberately **not** `figy_open_project`, which would be the
/// obvious reuse and is the wrong one twice over. That command points
/// the whole window at the folder and replaces the `@` index with it,
/// so counting a second folder would silently move the project out
/// from under the conversation. This walks and throws the walk away.
///
/// `async` for the reason the index is: a large folder is a second or
/// two and the UI thread is not where that belongs.
#[tauri::command(async)]
pub fn figy_count_dir(path: String) -> Result<DirCount, String> {
    // The same expansion and canonicalisation the workspace does, so
    // `~/notes` and `/Users/me/notes` are one folder and not two.
    let root = canonicalize(&expand_home(path.trim()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let index = build_index(&root);
    Ok(DirCount {
        files: index.files,
        folders: index.folders,
        truncated: index.truncated,
    })
}

/// What is in a folder, as `/project` lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirCount {
    pub files: usize,
    pub folders: usize,
    /// The walk stopped at the limit, so these are a floor.
    pub truncated: bool,
}

/// The best matches for what has been typed after an `@`.
///
/// Rebuilds the index when it has gone stale, which is why this can be slow
/// once in a while and is `async` for the same reason as the open.
#[tauri::command(async)]
pub fn figy_find_files(
    window: Window,
    state: State<FigyState>,
    query: String,
    limit: usize,
) -> Result<Vec<FileHit>, String> {
    let label = window.label().to_string();

    // The root is read, and the lock released, before the walk: rebuilding
    // while holding it would block the other window's searches behind this
    // one's filesystem.
    let stale_root = {
        let indexes = state
            .indexes
            .lock()
            .map_err(|_| "The project index is unavailable".to_string())?;
        let Some(index) = indexes.get(&label) else {
            return Err("No folder is open in FigyCode".into());
        };
        if index.built.elapsed() > INDEX_TTL {
            Some(index.root.clone())
        } else {
            None
        }
    };

    if let Some(root) = stale_root {
        let rebuilt = build_index(&root);
        let mut indexes = state
            .indexes
            .lock()
            .map_err(|_| "The project index is unavailable".to_string())?;
        // Only if the window is still on the same folder: the user may have
        // switched projects while this walk was running, and overwriting the
        // new index with the old folder's files is the race that produces a
        // mention list from the wrong repository.
        match indexes.get(&label) {
            Some(current) if current.root == root => {
                indexes.insert(label.clone(), rebuilt);
            }
            _ => {}
        }
    }

    let indexes = state
        .indexes
        .lock()
        .map_err(|_| "The project index is unavailable".to_string())?;
    let Some(index) = indexes.get(&label) else {
        return Err("No folder is open in FigyCode".into());
    };
    Ok(rank(index, &query, limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(rel: &str) -> Entry {
        let is_dir = rel.ends_with('/');
        let lower = rel.to_lowercase();
        let base_at = basename_offset(&lower);
        Entry {
            rel: rel.to_string(),
            lower,
            base_at,
            is_dir,
        }
    }

    fn score(rel: &str, query: &str) -> Option<i32> {
        score_path(&entry(rel), &query.to_lowercase())
    }

    /// The order the list comes out in, for a set of candidates.
    fn order(paths: &[&str], query: &str) -> Vec<String> {
        let index = Index {
            root: PathBuf::from("/tmp"),
            entries: paths.iter().map(|p| entry(p)).collect(),
            files: paths.len(),
            folders: 0,
            truncated: false,
            built: Instant::now(),
        };
        rank(&index, query, 10)
            .into_iter()
            .map(|hit| hit.path)
            .collect()
    }

    #[test]
    fn a_path_that_does_not_contain_the_letters_does_not_match() {
        assert!(score("src/main.rs", "zzz").is_none());
    }

    #[test]
    fn the_letters_have_to_be_in_order() {
        assert!(score("src/main.rs", "niam").is_none());
        assert!(score("src/main.rs", "main").is_some());
    }

    #[test]
    fn the_filename_outranks_the_folder() {
        // `api` typed into a mention is about a file called that, not about
        // everything underneath a folder called that.
        let rows = order(&["src/api/handlers.rs", "src/net/api.rs"], "api");
        assert_eq!(rows[0], "src/net/api.rs");
    }

    #[test]
    fn a_spelled_out_run_beats_scattered_letters() {
        let rows = order(
            &["s/r/c/other.ts", "src/claude-project.ts", "claude-project.ts"],
            "claude-project",
        );
        assert_eq!(rows[0], "claude-project.ts");
    }

    #[test]
    fn initials_find_a_hyphenated_name() {
        // `cpt` → claude-project.ts, which is the thing word-start bonuses
        // exist for.
        assert!(score("src/services/claude-project.ts", "cpt").is_some());
        let rows = order(
            &["src/services/claude-project.ts", "src/c/p/t/unrelated.md"],
            "cpt",
        );
        assert_eq!(rows[0], "src/services/claude-project.ts");
    }

    #[test]
    fn the_shallower_of_two_equal_matches_wins() {
        let rows = order(&["a/b/c/d/main.rs", "main.rs"], "main.rs");
        assert_eq!(rows[0], "main.rs");
    }

    #[test]
    fn an_empty_query_offers_the_shallowest_paths_first() {
        let rows = order(&["a/b/c/deep.ts", "top.ts"], "");
        assert_eq!(rows[0], "top.ts");
    }

    #[test]
    fn an_equal_score_is_broken_the_same_way_every_time() {
        // Two identical names in different folders score alike; the order has
        // to be stable or the list reshuffles under the pointer.
        let first = order(&["b/same.ts", "a/same.ts"], "same");
        let second = order(&["a/same.ts", "b/same.ts"], "same");
        assert_eq!(first, second);
    }

    #[test]
    fn a_folder_keeps_its_slash_and_is_still_matched_by_name() {
        let hit = entry("src/services/");
        assert!(hit.is_dir);
        assert!(score_path(&hit, "services").is_some());
        // The basename is `services`, not the empty string after the slash.
        assert_eq!(&hit.lower[hit.base_at..], "services/");
    }

    #[test]
    fn matching_ignores_case() {
        assert!(score("src/ClaudeModal.tsx", "claudemodal").is_some());
        assert!(score("src/claudemodal.tsx", "ClaudeModal").is_some());
    }

    #[test]
    fn the_limit_is_honoured_and_clamped() {
        let paths: Vec<String> = (0..100).map(|i| format!("file{i}.ts")).collect();
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        let index = Index {
            root: PathBuf::from("/tmp"),
            entries: refs.iter().map(|p| entry(p)).collect(),
            files: refs.len(),
            folders: 0,
            truncated: false,
            built: Instant::now(),
        };
        assert_eq!(rank(&index, "file", 5).len(), 5);
        assert_eq!(rank(&index, "file", 10_000).len(), MAX_HITS);
    }
}

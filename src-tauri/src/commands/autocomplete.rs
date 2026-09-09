use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
}

/// Separators a user might type.
///
/// Windows accepts both, since people type either and PowerShell tolerates
/// both. POSIX takes only `/` — a backslash there is a legitimate character in a
/// filename, and treating it as a separator would break completing those names.
#[cfg(target_os = "windows")]
const SEPARATORS: &[char] = &['/', '\\'];

#[cfg(not(target_os = "windows"))]
const SEPARATORS: &[char] = &['/'];

fn ends_with_separator(path: &str) -> bool {
    path.ends_with(SEPARATORS)
}

fn contains_separator(path: &str) -> bool {
    path.contains(SEPARATORS)
}

/// Whether the input is already anchored, so it must not be joined onto a base
/// directory.
///
/// `Path::is_absolute` isn't the right question: it answers for the host rather
/// than for the text, and on Windows it says no to a bare `\tools`, which is
/// drive-relative but still must not be appended to the working directory.
fn is_rooted(path: &str) -> bool {
    #[cfg(target_os = "windows")]
    return is_rooted_windows(path);

    #[cfg(not(target_os = "windows"))]
    return path.starts_with('/');
}

/// The Windows anchored forms: `C:\x`, `C:/x`, `C:`, `\\server\share`, and a
/// bare `\x` or `/x`.
///
/// Compiled everywhere so the tests can exercise it from any host — it's only
/// ever called on Windows.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_rooted_windows(path: &str) -> bool {
    if path.starts_with('\\') || path.starts_with('/') {
        return true;
    }
    matches!(path.as_bytes(), [drive, b':', ..] if drive.is_ascii_alphabetic())
}

/// The user's home directory, or `.` if the platform won't say.
fn home_path() -> PathBuf {
    crate::filesystem::operations::get_home_dir()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Expands a leading `~`, if there is one.
fn expand_tilde(path: &str) -> Option<PathBuf> {
    let rest = path.strip_prefix('~')?;
    let rest = rest.trim_start_matches(SEPARATORS);
    Some(if rest.is_empty() {
        home_path()
    } else {
        home_path().join(rest)
    })
}

fn expand_path(base_dir: &str, path: &str) -> PathBuf {
    if let Some(expanded) = expand_tilde(path) {
        return expanded;
    }
    if is_rooted(path) {
        return PathBuf::from(path);
    }
    if path.is_empty() {
        return PathBuf::from(base_dir);
    }
    resolve_base(base_dir).join(path)
}

fn resolve_base(base_dir: &str) -> PathBuf {
    if let Some(expanded) = expand_tilde(base_dir) {
        return expanded;
    }
    if base_dir.is_empty() {
        return home_path();
    }
    PathBuf::from(base_dir)
}

/// `async` so a directory listing never runs on the main thread: this fires on
/// every keystroke, and `read_dir` against a slow disk, a network share or a
/// mapped drive takes as long as it takes.
#[tauri::command(async)]
pub fn list_path_completions(
    base_dir: String,
    partial: String,
) -> Result<Vec<CompletionEntry>, String> {
    let base = resolve_base(&base_dir);

    let (search_dir, prefix) = if partial.is_empty() {
        (base.clone(), String::new())
    } else if ends_with_separator(&partial) {
        let dir = expand_path(base.to_str().unwrap_or("."), &partial);
        (dir, String::new())
    } else if contains_separator(&partial) {
        let expanded = expand_path(base.to_str().unwrap_or("."), &partial);
        let parent = expanded.parent().unwrap_or(&base).to_path_buf();
        let file_prefix = expanded
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        (parent, file_prefix)
    } else {
        (base.clone(), partial.clone())
    };

    if !search_dir.is_dir() {
        return Ok(vec![]);
    }

    let entries = match fs::read_dir(&search_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(vec![]),
    };

    let prefix_lower = prefix.to_lowercase();

    let mut prefix_matches: Vec<CompletionEntry> = Vec::new();
    let mut contains_matches: Vec<CompletionEntry> = Vec::new();

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_hidden = name.starts_with('.');

        if is_hidden && !prefix.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let is_dir = path.is_dir();
        let name_lower = name.to_lowercase();

        let item = CompletionEntry {
            name: name.clone(),
            path: path.to_string_lossy().to_string(),
            is_dir,
            is_hidden,
        };

        if prefix_lower.is_empty() {
            prefix_matches.push(item);
        } else if name_lower.starts_with(&prefix_lower) {
            prefix_matches.push(item);
        } else if name_lower.contains(&prefix_lower) {
            contains_matches.push(item);
        }
    }

    prefix_matches.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return b.is_dir.cmp(&a.is_dir);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    contains_matches.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return b.is_dir.cmp(&a.is_dir);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    let mut results = prefix_matches;
    results.extend(contains_matches);
    results.truncate(30);
    Ok(results)
}

#[tauri::command]
pub fn get_home_dir() -> String {
    // Via the filesystem helper, which knows Windows keeps this in USERPROFILE.
    home_path().to_string_lossy().to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub command: String,
    pub timestamp: Option<u64>,
}

/// PSReadLine's history file: one command per line, no timestamps.
///
/// This is PowerShell's, not the shell's own — `cmd.exe` keeps no persistent
/// history at all, so a cmd user simply gets none. PSReadLine ships with
/// PowerShell 5.1 and later, so in practice any Windows install has it.
#[cfg(target_os = "windows")]
fn windows_history_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("PowerShell")
            .join("PSReadLine")
            .join("ConsoleHost_history.txt"),
    )
}

/// `async` for the same reason: this reads and parses a history file that can
/// run to thousands of lines.
#[tauri::command(async)]
pub fn read_shell_history(max_entries: Option<usize>) -> Vec<HistoryEntry> {
    let limit = max_entries.unwrap_or(2000);

    #[cfg(target_os = "windows")]
    {
        return windows_history_path()
            .filter(|path| path.exists())
            // PSReadLine's format is the same shape as bash's: bare lines.
            .map(|path| parse_bash_history(&path, limit))
            .unwrap_or_default();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() {
            return vec![];
        }

        // Try zsh first, then bash
        let zsh_path = PathBuf::from(&home).join(".zsh_history");
        let bash_path = PathBuf::from(&home).join(".bash_history");

        if zsh_path.exists() {
            parse_zsh_history(&zsh_path, limit)
        } else if bash_path.exists() {
            parse_bash_history(&bash_path, limit)
        } else {
            vec![]
        }
    }
}

fn parse_zsh_history(path: &PathBuf, limit: usize) -> Vec<HistoryEntry> {
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let content = String::from_utf8_lossy(&data);

    let mut entries: Vec<HistoryEntry> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in content.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let (timestamp, command) = if line.starts_with(": ") {
            // Extended format: ": 1234567890:0;command here"
            if let Some(semi) = line.find(';') {
                let meta = &line[2..semi];
                let ts = meta.split(':').next()
                    .and_then(|s| s.trim().parse::<u64>().ok());
                (ts, line[semi + 1..].to_string())
            } else {
                (None, line.to_string())
            }
        } else {
            (None, line.to_string())
        };

        let cmd = command.trim().to_string();
        if cmd.is_empty() || cmd.len() < 2 {
            continue;
        }

        if seen.contains(&cmd) {
            continue;
        }
        seen.insert(cmd.clone());

        entries.push(HistoryEntry {
            command: cmd,
            timestamp,
        });

        if entries.len() >= limit {
            break;
        }
    }

    entries
}

fn parse_bash_history(path: &PathBuf, limit: usize) -> Vec<HistoryEntry> {
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let content = String::from_utf8_lossy(&data);

    let mut entries: Vec<HistoryEntry> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in content.lines().rev() {
        let cmd = line.trim().to_string();
        if cmd.is_empty() || cmd.len() < 2 || cmd.starts_with('#') {
            continue;
        }

        if seen.contains(&cmd) {
            continue;
        }
        seen.insert(cmd.clone());

        entries.push(HistoryEntry {
            command: cmd,
            timestamp: None,
        });

        if entries.len() >= limit {
            break;
        }
    }

    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows anchoring, exercised from any host — `is_rooted_windows` is
    /// deliberately host-independent so this doesn't need a Windows runner.
    #[test]
    fn recognises_every_windows_anchored_form() {
        for rooted in [
            "C:\\Users\\me",  // drive + backslash
            "c:/users/me",    // drive + forward slash, lowercase
            "C:",             // bare drive
            "\\\\server\\share", // UNC
            "\\tools",        // drive-relative root
            "/tools",         // ditto, forward slash
        ] {
            assert!(is_rooted_windows(rooted), "should be rooted: {rooted}");
        }

        for relative in ["src", "src\\main.rs", "./src", "..\\sibling", "", "1:\\x"] {
            assert!(
                !is_rooted_windows(relative),
                "should be relative: {relative}"
            );
        }
    }

    #[test]
    fn separator_checks_follow_the_platform() {
        assert!(ends_with_separator("src/"));
        assert!(contains_separator("src/main.rs"));

        // A backslash is a separator on Windows and a filename character on
        // POSIX, so this is one of the few places the two must disagree.
        assert_eq!(ends_with_separator("src\\"), cfg!(target_os = "windows"));
        assert_eq!(
            contains_separator("src\\main.rs"),
            cfg!(target_os = "windows")
        );
    }

    #[test]
    fn tilde_expands_to_the_home_directory() {
        let home = home_path();

        assert_eq!(expand_tilde("~"), Some(home.clone()));
        assert_eq!(expand_tilde("~/src"), Some(home.join("src")));
        // A trailing separator on `~` shouldn't produce an empty segment.
        assert_eq!(expand_tilde("~/"), Some(home.clone()));
        assert_eq!(expand_tilde("src"), None);
    }

    #[test]
    fn an_anchored_partial_ignores_the_base_directory() {
        // The base is irrelevant once the input stands on its own — this is what
        // stops `/etc` being resolved as `<cwd>/etc`.
        let absolute = if cfg!(target_os = "windows") {
            "C:\\Windows"
        } else {
            "/etc"
        };
        assert_eq!(
            expand_path("/some/base", absolute),
            PathBuf::from(absolute)
        );
    }

    #[test]
    fn a_relative_partial_hangs_off_the_base_directory() {
        assert_eq!(
            expand_path("/some/base", "src"),
            PathBuf::from("/some/base").join("src")
        );
    }

    #[test]
    fn an_empty_base_falls_back_to_home() {
        assert_eq!(resolve_base(""), home_path());
    }
}

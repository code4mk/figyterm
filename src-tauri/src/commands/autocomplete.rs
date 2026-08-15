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

fn expand_path(base_dir: &str, path: &str) -> PathBuf {
    if path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(path.replacen('~', &home, 1));
        }
    }
    if path.starts_with('/') {
        return PathBuf::from(path);
    }
    if path.is_empty() {
        return PathBuf::from(base_dir);
    }
    let base = if base_dir.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(base_dir.replacen('~', &home, 1))
        } else {
            PathBuf::from(base_dir)
        }
    } else if base_dir.is_empty() {
        std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(base_dir)
    };
    base.join(path)
}

fn resolve_base(base_dir: &str) -> PathBuf {
    if base_dir.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(base_dir.replacen('~', &home, 1));
        }
    }
    if base_dir.is_empty() {
        return std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
    }
    PathBuf::from(base_dir)
}

#[tauri::command]
pub fn list_path_completions(
    base_dir: String,
    partial: String,
) -> Result<Vec<CompletionEntry>, String> {
    let base = resolve_base(&base_dir);

    let (search_dir, prefix) = if partial.is_empty() {
        (base.clone(), String::new())
    } else if partial.ends_with('/') {
        let dir = expand_path(base.to_str().unwrap_or("."), &partial);
        (dir, String::new())
    } else if partial.contains('/') {
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
    std::env::var("HOME").unwrap_or_else(|_| String::from("/tmp"))
}

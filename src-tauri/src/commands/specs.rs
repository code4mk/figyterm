use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

fn specs_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let dir = PathBuf::from(home).join(".figyterm").join("specs");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

fn icons_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let dir = PathBuf::from(home).join(".figyterm").join("icons");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Resolve a spec name (possibly with slashes like "aws/s3") to its file path.
/// Creates parent directories as needed.
fn spec_path(name: &str) -> PathBuf {
    let path = specs_dir().join(format!("{}.ts", name));
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            let _ = fs::create_dir_all(parent);
        }
    }
    path
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSpec {
    pub name: String,
    pub file_size: u64,
    pub has_icon: bool,
}

fn collect_specs(dir: &PathBuf, prefix: &str, specs: &mut Vec<InstalledSpec>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                let dir_name = entry.file_name().to_string_lossy().to_string();
                let sub_prefix = if prefix.is_empty() {
                    dir_name
                } else {
                    format!("{}/{}", prefix, dir_name)
                };
                collect_specs(&path, &sub_prefix, specs);
            } else {
                let fname = entry.file_name().to_string_lossy().to_string();
                if !fname.ends_with(".ts") {
                    continue;
                }
                let base = fname.trim_end_matches(".ts");
                let spec_name = if prefix.is_empty() {
                    base.to_string()
                } else {
                    format!("{}/{}", prefix, base)
                };
                let metadata = entry.metadata().ok();
                let file_size = metadata.map(|m| m.len()).unwrap_or(0);
                // Icon lookup: use the root name (first segment) for icon
                let root_name = spec_name.split('/').next().unwrap_or(&spec_name);
                let icon_path = icons_dir().join(format!("{}.png", root_name));
                let has_icon = icon_path.exists();

                specs.push(InstalledSpec {
                    name: spec_name,
                    file_size,
                    has_icon,
                });
            }
        }
    }
}

#[tauri::command]
pub fn list_installed_specs() -> Vec<InstalledSpec> {
    let dir = specs_dir();
    let mut specs = Vec::new();
    collect_specs(&dir, "", &mut specs);
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}

#[tauri::command]
pub fn read_spec_file(name: String) -> Result<String, String> {
    let path = spec_path(&name);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_spec_file(name: String, content: String) -> Result<(), String> {
    let path = spec_path(&name);
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_spec_icon(name: String, data: Vec<u8>) -> Result<(), String> {
    let path = icons_dir().join(format!("{}.png", name));
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_spec(name: String) -> Result<(), String> {
    let path = spec_path(&name);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    // Also remove subdirectory if it exists (e.g., specs/aws/ folder)
    let sub_dir = specs_dir().join(&name);
    if sub_dir.is_dir() {
        let _ = fs::remove_dir_all(&sub_dir);
    }
    let icon_path = icons_dir().join(format!("{}.png", name));
    if icon_path.exists() {
        let _ = fs::remove_file(&icon_path);
    }
    Ok(())
}

#[tauri::command]
pub fn get_spec_icon_path(name: String) -> Option<String> {
    let path = icons_dir().join(format!("{}.png", name));
    if path.exists() {
        Some(path.to_string_lossy().to_string())
    } else {
        None
    }
}

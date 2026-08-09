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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSpec {
    pub name: String,
    pub file_size: u64,
    pub has_icon: bool,
}

#[tauri::command]
pub fn list_installed_specs() -> Vec<InstalledSpec> {
    let dir = specs_dir();
    let mut specs = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".ts") {
                continue;
            }
            let spec_name = name.trim_end_matches(".ts").to_string();
            let metadata = entry.metadata().ok();
            let file_size = metadata.map(|m| m.len()).unwrap_or(0);
            let icon_path = icons_dir().join(format!("{}.png", &spec_name));
            let has_icon = icon_path.exists();

            specs.push(InstalledSpec {
                name: spec_name,
                file_size,
                has_icon,
            });
        }
    }

    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}

#[tauri::command]
pub fn read_spec_file(name: String) -> Result<String, String> {
    let path = specs_dir().join(format!("{}.ts", name));
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_spec_file(name: String, content: String) -> Result<(), String> {
    let path = specs_dir().join(format!("{}.ts", name));
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_spec_icon(name: String, data: Vec<u8>) -> Result<(), String> {
    let path = icons_dir().join(format!("{}.png", name));
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_spec(name: String) -> Result<(), String> {
    let spec_path = specs_dir().join(format!("{}.ts", name));
    let icon_path = icons_dir().join(format!("{}.png", name));
    if spec_path.exists() {
        fs::remove_file(&spec_path).map_err(|e| e.to_string())?;
    }
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

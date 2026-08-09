use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub modified_files: Vec<String>,
    pub untracked_files: Vec<String>,
}

pub fn get_git_status(cwd: &str) -> GitStatus {
    let path = Path::new(cwd);
    if !path.join(".git").exists() {
        return GitStatus {
            is_repo: false,
            branch: None,
            modified_files: vec![],
            untracked_files: vec![],
        };
    }

    let branch = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });

    let (modified_files, untracked_files) = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(cwd)
        .output()
        .map(|o| {
            let output = String::from_utf8_lossy(&o.stdout);
            let mut modified = vec![];
            let mut untracked = vec![];
            for line in output.lines() {
                if line.starts_with("??") {
                    untracked.push(line[3..].to_string());
                } else if line.len() > 3 {
                    modified.push(line[3..].to_string());
                }
            }
            (modified, untracked)
        })
        .unwrap_or_default();

    GitStatus {
        is_repo: true,
        branch,
        modified_files,
        untracked_files,
    }
}

pub fn get_branches(cwd: &str) -> Vec<String> {
    Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(cwd)
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

use serde::Serialize;
use sysinfo::System;
use std::sync::Mutex;

static SYSTEM: Mutex<Option<System>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_usage: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub memory_percent: f32,
}

#[tauri::command]
pub fn get_system_stats() -> SystemStats {
    let mut guard = SYSTEM.lock().unwrap();
    let sys = guard.get_or_insert_with(|| {
        let mut s = System::new();
        s.refresh_cpu_all();
        s.refresh_memory();
        s
    });

    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_usage();
    let memory_used = sys.used_memory();
    let memory_total = sys.total_memory();
    let memory_percent = if memory_total > 0 {
        (memory_used as f64 / memory_total as f64 * 100.0) as f32
    } else {
        0.0
    };

    SystemStats {
        cpu_usage,
        memory_used,
        memory_total,
        memory_percent,
    }
}

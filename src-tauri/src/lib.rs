pub mod commands;
pub mod filesystem;
pub mod git;
pub mod state;
pub mod terminal;

use commands::browser::BrowserState;
use state::app_state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .manage(BrowserState::default())
        .setup(|app| {
            commands::browser::start_url_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_terminal_session,
            commands::terminal::write_terminal_session,
            commands::terminal::resize_terminal_session,
            commands::terminal::close_terminal_session,
            commands::terminal::get_default_shell,
            commands::terminal::get_default_working_directory,
            commands::autocomplete::list_path_completions,
            commands::autocomplete::get_home_dir,
            commands::autocomplete::read_shell_history,
            commands::shell_exec::execute_shell_command,
            commands::specs::list_installed_specs,
            commands::specs::read_spec_file,
            commands::specs::save_spec_file,
            commands::specs::save_spec_icon,
            commands::specs::remove_spec,
            commands::specs::get_spec_icon_path,
            commands::system::get_system_stats,
            commands::browser::browser_open_tab,
            commands::browser::browser_close_tab,
            commands::browser::browser_close_all,
            commands::browser::browser_set_bounds,
            commands::browser::browser_set_visible,
            commands::browser::browser_navigate,
            commands::browser::browser_go_back,
            commands::browser::browser_go_forward,
            commands::browser::browser_reload,
            commands::browser::browser_stop,
            commands::browser::browser_focus,
            commands::browser::browser_set_zoom,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

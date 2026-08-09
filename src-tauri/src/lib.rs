pub mod commands;
pub mod filesystem;
pub mod git;
pub mod state;
pub mod terminal;

use state::app_state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_terminal_session,
            commands::terminal::write_terminal_session,
            commands::terminal::resize_terminal_session,
            commands::terminal::close_terminal_session,
            commands::terminal::get_default_shell,
            commands::terminal::get_default_working_directory,
            commands::autocomplete::list_path_completions,
            commands::autocomplete::get_home_dir,
            commands::shell_exec::execute_shell_command,
            commands::specs::list_installed_specs,
            commands::specs::read_spec_file,
            commands::specs::save_spec_file,
            commands::specs::save_spec_icon,
            commands::specs::remove_spec,
            commands::specs::get_spec_icon_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub mod commands;
pub mod filesystem;
pub mod git;
pub mod menu;
pub mod state;
pub mod terminal;
pub mod updater;

use commands::browser::BrowserState;
use state::app_state::AppState;
use tauri::{AppHandle, Manager, RunEvent};
use updater::UpdaterState;

/// Ends every shell before the process goes away.
///
/// Nothing else does. On POSIX that was survivable by accident: the process
/// exits, the kernel closes the pty, the shell takes SIGHUP and follows. Windows
/// has no hangup and no parent-child lifetime link, so a shell left running when
/// FigyTerm quit simply kept running — an orphaned `powershell.exe` per tab,
/// still attached to a pseudoconsole with no owner.
///
/// `PtyInstance::shutdown` is what does the work; this only makes sure it is
/// reached. It must not block: see the note on `PtyInstance::drop`.
fn shutdown_terminals(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(mut manager) = state.terminal_manager.lock() else {
        return;
    };
    if let Some(manager) = manager.as_mut() {
        manager.shutdown_all();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .manage(BrowserState::default())
        .manage(UpdaterState::default())
        .setup(|app| {
            let menu = menu::build_app_menu(app.handle())?;
            app.set_menu(menu)?;
            commands::browser::start_url_watcher(app.handle().clone());
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_menu_event(app, event);
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
            commands::autocomplete::read_project_file,
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
            commands::browser::browser_set_theme,
            updater::check_for_updates,
            updater::get_current_version,
            updater::running_foreground_commands,
            updater::restart_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // `Exit` rather than `ExitRequested`: by here every window is gone
            // and nothing can veto the quit, so it is the last point at which
            // the shells are still ours to close.
            if matches!(event, RunEvent::Exit) {
                shutdown_terminals(app);
            }
        });
}

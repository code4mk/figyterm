use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Wry};

pub const MENU_NEW_TAB: &str = "shell_new_tab";
pub const MENU_NEW_TAB_SAME_DIR: &str = "shell_new_tab_same_dir";
pub const MENU_SPLIT_RIGHT: &str = "shell_split_right";
pub const MENU_SPLIT_DOWN: &str = "shell_split_down";
pub const MENU_CLOSE_PANE: &str = "shell_close_pane";
pub const MENU_CLEAR_TERMINAL: &str = "shell_clear_terminal";
pub const MENU_BROWSER: &str = "shell_browser";
pub const MENU_MONITOR: &str = "shell_monitor";
pub const MENU_COMMAND_PALETTE: &str = "shell_command_palette";
pub const MENU_SETTINGS: &str = "shell_settings";

const EVENT_NEW_TAB: &str = "menu://new-tab";
const EVENT_NEW_TAB_SAME_DIR: &str = "menu://new-tab-same-dir";
const EVENT_SPLIT_RIGHT: &str = "menu://split-right";
const EVENT_SPLIT_DOWN: &str = "menu://split-down";
const EVENT_CLOSE_PANE: &str = "menu://close-pane";
const EVENT_CLEAR_TERMINAL: &str = "menu://clear-terminal";
const EVENT_BROWSER: &str = "menu://browser";
const EVENT_MONITOR: &str = "menu://monitor";
const EVENT_COMMAND_PALETTE: &str = "menu://command-palette";
const EVENT_SETTINGS: &str = "menu://settings";

pub fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = tauri::menu::AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let new_tab = MenuItem::with_id(
        app,
        MENU_NEW_TAB,
        "New Tab",
        true,
        Some("CmdOrCtrl+T"),
    )?;
    let new_tab_same_dir = MenuItem::with_id(
        app,
        MENU_NEW_TAB_SAME_DIR,
        "New Tab in Same Directory",
        true,
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let split_right = MenuItem::with_id(
        app,
        MENU_SPLIT_RIGHT,
        "Split Pane Right",
        true,
        Some("CmdOrCtrl+D"),
    )?;
    let split_down = MenuItem::with_id(
        app,
        MENU_SPLIT_DOWN,
        "Split Pane Down",
        true,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let close_pane = MenuItem::with_id(
        app,
        MENU_CLOSE_PANE,
        "Close Pane",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    let clear_terminal = MenuItem::with_id(
        app,
        MENU_CLEAR_TERMINAL,
        "Clear Terminal",
        true,
        Some("CmdOrCtrl+K"),
    )?;
    let browser = MenuItem::with_id(
        app,
        MENU_BROWSER,
        "Browser",
        true,
        Some("CmdOrCtrl+Shift+B"),
    )?;
    let monitor = MenuItem::with_id(
        app,
        MENU_MONITOR,
        "System Monitor",
        true,
        Some("CmdOrCtrl+Shift+M"),
    )?;
    let command_palette = MenuItem::with_id(
        app,
        MENU_COMMAND_PALETTE,
        "Command Palette",
        true,
        Some("CmdOrCtrl+Shift+P"),
    )?;
    let settings = MenuItem::with_id(
        app,
        MENU_SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;

    let shell_menu = Submenu::with_id_and_items(
        app,
        "shell",
        "Shell",
        true,
        &[
            &new_tab,
            &new_tab_same_dir,
            &sep1,
            &split_right,
            &split_down,
            &close_pane,
            &sep2,
            &clear_terminal,
            &sep3,
            &browser,
            &monitor,
            &sep4,
            &command_palette,
            &settings,
        ],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        "window",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id(app, "help", "Help", true)?;

    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_id_and_items(
                app,
                "figyterm",
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &shell_menu,
            &Submenu::with_id_and_items(
                app,
                "edit",
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_id_and_items(
                app,
                "view",
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )?;

    Ok(menu)
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    let result = match id {
        MENU_NEW_TAB => app.emit(EVENT_NEW_TAB, ()),
        MENU_NEW_TAB_SAME_DIR => app.emit(EVENT_NEW_TAB_SAME_DIR, ()),
        MENU_SPLIT_RIGHT => app.emit(EVENT_SPLIT_RIGHT, ()),
        MENU_SPLIT_DOWN => app.emit(EVENT_SPLIT_DOWN, ()),
        MENU_CLOSE_PANE => app.emit(EVENT_CLOSE_PANE, ()),
        MENU_CLEAR_TERMINAL => app.emit(EVENT_CLEAR_TERMINAL, ()),
        MENU_BROWSER => app.emit(EVENT_BROWSER, ()),
        MENU_MONITOR => app.emit(EVENT_MONITOR, ()),
        MENU_COMMAND_PALETTE => app.emit(EVENT_COMMAND_PALETTE, ()),
        MENU_SETTINGS => app.emit(EVENT_SETTINGS, ()),
        _ => Ok(()),
    };
    if let Err(err) = result {
        log::warn!("menu event '{id}' failed: {err}");
    }
}

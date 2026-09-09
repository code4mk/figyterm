use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Wry};
use tauri_plugin_shell::ShellExt;

pub const MENU_CHECK_UPDATES: &str = "app_check_updates";
pub const MENU_HELP_DOCS: &str = "help_docs";
pub const MENU_HELP_RELEASES: &str = "help_releases";
pub const MENU_HELP_ISSUE: &str = "help_report_issue";
pub const MENU_HELP_LICENSE: &str = "help_license";

const URL_DOCS: &str = "https://github.com/code4mk/figyterm#readme";
const URL_RELEASES: &str = "https://github.com/code4mk/figyterm/releases";
const URL_ISSUE: &str = "https://github.com/code4mk/figyterm/issues/new";
const URL_LICENSE: &str = "https://github.com/code4mk/figyterm/blob/main/LICENSE";

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
pub const MENU_COPY: &str = "edit_copy";
pub const MENU_PASTE: &str = "edit_paste";

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
const EVENT_CHECK_UPDATES: &str = "menu://check-updates";
const EVENT_COPY: &str = "menu://copy";
const EVENT_PASTE: &str = "menu://paste";

/// An accelerator spelled for the platform it runs on.
///
/// macOS can give the app ⌘ and leave Ctrl to the shell. Nothing else has a ⌘,
/// and a bare Ctrl+letter is already the shell's — Ctrl+C interrupts, Ctrl+D is
/// EOF, Ctrl+K kills the line — so binding one in the menu would take it away
/// from the terminal underneath. Off macOS the app uses Ctrl+Shift instead,
/// exactly as GNOME Terminal and Konsole do, and Ctrl+Alt where a macOS ⌘X/⌘⇧X
/// pair would otherwise collapse onto the same chord.
///
/// **Windows registers none of them.** Tauri installs a message hook that runs
/// `TranslateAcceleratorW` over every menu accelerator before tao dispatches
/// the message, and returning "translated" stops the dispatch dead — so a key
/// that matches an accelerator never reaches WebView2, and `WM_COMMAND` goes to
/// whichever HWND had focus. When that's the webview's own child window rather
/// than the frame, muda never sees the command either and the keystroke is
/// simply lost. `src/services/shortcuts.ts` implements every one of these in
/// the webview already, so on Windows the accelerator is dropped and the chord
/// is shown as label text instead (see `hint`), leaving the key free to arrive.
///
/// This mirrors `src/services/shortcuts.ts`, which spells the same bindings for
/// the in-app handlers and the labels. Change one, change the other.
fn accel(mac: &str, other: &str) -> Option<String> {
    if cfg!(target_os = "windows") {
        return None;
    }
    Some(if cfg!(target_os = "macos") {
        mac.to_string()
    } else {
        other.to_string()
    })
}

/// A menu item's text, with the shortcut appended where the accelerator was
/// dropped.
///
/// A tab in a Win32 menu string right-aligns everything after it — the standard
/// way a shortcut hint is drawn — and unlike an accelerator it claims no key.
fn label(text: &str, hint: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{text}\t{hint}")
    } else {
        text.to_string()
    }
}

pub fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    // These three feed the app submenu and its About item, which exist only on
    // macOS — elsewhere they'd be unused bindings, and the Linux build would
    // warn about every one of them.
    #[cfg(target_os = "macos")]
    let pkg_info = app.package_info();
    #[cfg(target_os = "macos")]
    let config = app.config();
    #[cfg(target_os = "macos")]
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
        label("New Tab", "Ctrl+Shift+T"),
        true,
        accel("CmdOrCtrl+T", "Ctrl+Shift+T"),
    )?;
    let new_tab_same_dir = MenuItem::with_id(
        app,
        MENU_NEW_TAB_SAME_DIR,
        label("New Tab in Same Directory", "Ctrl+Alt+T"),
        true,
        accel("CmdOrCtrl+Shift+T", "Ctrl+Alt+T"),
    )?;
    let split_right = MenuItem::with_id(
        app,
        MENU_SPLIT_RIGHT,
        label("Split Pane Right", "Ctrl+Shift+D"),
        true,
        accel("CmdOrCtrl+D", "Ctrl+Shift+D"),
    )?;
    let split_down = MenuItem::with_id(
        app,
        MENU_SPLIT_DOWN,
        label("Split Pane Down", "Ctrl+Alt+D"),
        true,
        accel("CmdOrCtrl+Shift+D", "Ctrl+Alt+D"),
    )?;
    let close_pane = MenuItem::with_id(
        app,
        MENU_CLOSE_PANE,
        label("Close Pane", "Ctrl+Shift+W"),
        true,
        accel("CmdOrCtrl+Shift+W", "Ctrl+Shift+W"),
    )?;
    let clear_terminal = MenuItem::with_id(
        app,
        MENU_CLEAR_TERMINAL,
        label("Clear Terminal", "Ctrl+Shift+K"),
        true,
        accel("CmdOrCtrl+K", "Ctrl+Shift+K"),
    )?;
    let browser = MenuItem::with_id(
        app,
        MENU_BROWSER,
        label("Browser", "Ctrl+Shift+B"),
        true,
        accel("CmdOrCtrl+Shift+B", "Ctrl+Shift+B"),
    )?;
    let monitor = MenuItem::with_id(
        app,
        MENU_MONITOR,
        label("System Monitor", "Ctrl+Shift+M"),
        true,
        accel("CmdOrCtrl+Shift+M", "Ctrl+Shift+M"),
    )?;
    let command_palette = MenuItem::with_id(
        app,
        MENU_COMMAND_PALETTE,
        label("Command Palette", "Ctrl+Shift+P"),
        true,
        accel("CmdOrCtrl+Shift+P", "Ctrl+Shift+P"),
    )?;
    let settings = MenuItem::with_id(
        app,
        MENU_SETTINGS,
        label("Settings…", "Ctrl+,"),
        true,
        accel("CmdOrCtrl+,", "Ctrl+,"),
    )?;

    // macOS convention puts this directly under "About", with no accelerator.
    let check_updates = MenuItem::with_id(
        app,
        MENU_CHECK_UPDATES,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;

    let help_docs = MenuItem::with_id(
        app,
        MENU_HELP_DOCS,
        "FigyTerm Documentation",
        true,
        None::<&str>,
    )?;
    let help_releases =
        MenuItem::with_id(app, MENU_HELP_RELEASES, "Release Notes", true, None::<&str>)?;
    let help_issue = MenuItem::with_id(
        app,
        MENU_HELP_ISSUE,
        "Report an Issue…",
        true,
        None::<&str>,
    )?;
    let help_license =
        MenuItem::with_id(app, MENU_HELP_LICENSE, "View License", true, None::<&str>)?;

    // Off macOS the Edit menu is built by hand rather than from
    // `PredefinedMenuItem`, whose accelerators are fixed at CmdOrCtrl and so
    // resolve to the bare Ctrl chords the shell needs for itself: Ctrl+C
    // (SIGINT), Ctrl+V, Ctrl+X, Ctrl+A (start of line), Ctrl+Z and Ctrl+Y
    // (PSReadLine's undo and yank). A menu that owns those is a menu that has
    // taken interrupt away from the terminal, so only Copy and Paste survive,
    // on the app's own Ctrl+Shift chords, routed to the focused pane.
    #[cfg(not(target_os = "macos"))]
    let copy_item = MenuItem::with_id(
        app,
        MENU_COPY,
        label("Copy", "Ctrl+Shift+C"),
        true,
        accel("CmdOrCtrl+C", "Ctrl+Shift+C"),
    )?;
    #[cfg(not(target_os = "macos"))]
    let paste_item = MenuItem::with_id(
        app,
        MENU_PASTE,
        label("Paste", "Ctrl+Shift+V"),
        true,
        accel("CmdOrCtrl+V", "Ctrl+Shift+V"),
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

    // `PredefinedMenuItem::minimize` carries CmdOrCtrl+M, and off macOS that is
    // Ctrl+M — which is carriage return. A menu that holds it swallows every
    // Enter the user presses, so the item is macOS-only. Maximize has no
    // accelerator but goes with it; both are a click away on the title bar.
    let window_menu = Submenu::with_id_and_items(
        app,
        "window",
        "Window",
        true,
        &[
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::minimize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        "help",
        "Help",
        true,
        &[
            // On macOS this lives under the app menu instead, per platform convention.
            #[cfg(not(target_os = "macos"))]
            &check_updates,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(app)?,
            &help_docs,
            &help_releases,
            &PredefinedMenuItem::separator(app)?,
            &help_issue,
            &help_license,
        ],
    )?;

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
                    &check_updates,
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
            #[cfg(target_os = "macos")]
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
            #[cfg(not(target_os = "macos"))]
            &Submenu::with_id_and_items(app, "edit", "Edit", true, &[&copy_item, &paste_item])?,
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

    // Help entries are pure "open a URL" actions; no need to round-trip
    // through the frontend for them.
    let external_url = match id {
        MENU_HELP_DOCS => Some(URL_DOCS),
        MENU_HELP_RELEASES => Some(URL_RELEASES),
        MENU_HELP_ISSUE => Some(URL_ISSUE),
        MENU_HELP_LICENSE => Some(URL_LICENSE),
        _ => None,
    };
    if let Some(url) = external_url {
        // Deprecated in favour of tauri-plugin-opener, but the frontend already
        // opens external links through plugin-shell (see BrowserModal.tsx), so
        // stay on one plugin until both sides migrate together.
        #[allow(deprecated)]
        if let Err(err) = app.shell().open(url, None) {
            log::warn!("menu event '{id}' could not open '{url}': {err}");
        }
        return;
    }

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
        MENU_CHECK_UPDATES => app.emit(EVENT_CHECK_UPDATES, ()),
        MENU_COPY => app.emit(EVENT_COPY, ()),
        MENU_PASTE => app.emit(EVENT_PASTE, ()),
        _ => Ok(()),
    };
    if let Err(err) = result {
        log::warn!("menu event '{id}' failed: {err}");
    }
}

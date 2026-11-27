//! Opening another Figylo window.
//!
//! A window is the unit of isolation here, and that is the whole feature: its
//! own tabs and panes, its own shells, its own editor workspace, its own
//! browser tabs. Two projects open side by side is what people do with a
//! terminal, and before this the only way to have two was to run the app twice
//! — which on macOS the Dock will not even let you do.
//!
//! **What is shared and what is not.** The process is shared, so settings, the
//! theme, the API collections and the spec store are one copy and a change in
//! one window shows up in the other, which is what anybody would expect of a
//! preference. Everything that belongs to *what you are looking at* is keyed by
//! window label on the Rust side — see `commands/fs.rs`, `commands/fs_watch.rs`
//! and `commands/browser.rs` — because one global each is how window B ends up
//! pulling window A's editor out from under it.
//!
//! The label is the key to all of that, so it has to be stable and unique:
//! `main` for the first window (the one `tauri.conf.json` declares) and
//! `main-2`, `main-3` … for the rest. The capability file matches them with a
//! glob, and a window whose label does not match gets no permissions at all —
//! every `invoke` from it is rejected, which looks exactly like the app being
//! broken rather than like a missing line of configuration.

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

/// The window `tauri.conf.json` declares, and the one every other is modelled on.
pub const MAIN_LABEL: &str = "main";

/// How far a new window is offset from the one it was opened from.
///
/// Native windows cascade rather than stacking exactly, so that the one
/// underneath is still visibly there. A new window landing pixel-for-pixel on
/// top of the old one reads as the old one having been emptied.
const CASCADE: i32 = 32;

/// Names for a window the user did not name.
///
/// Fruit, because the point of the name is to be *said* — "it's in the mango
/// one" — and for that it has to be a word somebody already knows, short
/// enough to read on a tab in the Dock, and nothing like a file path or a
/// branch, which is what everything else on screen is. Numbers would do the
/// distinguishing and none of the remembering: nobody has ever thought "window
/// three" and gone straight to it.
///
/// Deliberately ordinary ones. Half the value is that the word is already
/// familiar, so `Rambutan` and `Jabuticaba` are left out however good they look
/// in a list.
const FRUIT: &[&str] = &[
    "Mango", "Papaya", "Lychee", "Guava", "Apricot", "Clementine", "Peach", "Plum", "Cherry",
    "Melon", "Apple", "Pear", "Lime", "Lemon", "Olive", "Date", "Grape", "Kiwi", "Mulberry",
    "Nectarine", "Quince", "Tangerine", "Banana", "Coconut", "Pomelo", "Persimmon", "Damson",
    "Jackfruit", "Passionfruit", "Starfruit",
];

/// Every window title currently on screen, so a name is not handed out twice.
fn titles_in_use(app: &AppHandle) -> Vec<String> {
    app.webview_windows()
        .values()
        .filter_map(|window| window.title().ok())
        .collect()
}

/// A fruit no window is already called.
///
/// Pseudo-random without a dependency: the clock's nanoseconds are a perfectly
/// good seed for picking a word, and pulling `rand` into the build to name a
/// window would be the wrong trade. From that start it walks the list rather
/// than re-rolling, so with a few windows open it still terminates at once and
/// with all thirty taken it comes back round to a repeat instead of looping.
fn pick_name(app: &AppHandle) -> String {
    let taken = titles_in_use(app);
    let start = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as usize)
        .unwrap_or(0);

    for step in 0..FRUIT.len() {
        let name = FRUIT[(start + step) % FRUIT.len()];
        if !taken.iter().any(|title| title.starts_with(name)) {
            return name.to_string();
        }
    }
    FRUIT[start % FRUIT.len()].to_string()
}

/// How a window's name is written in its title bar.
///
/// The name first, because that is the part being looked for and the part a
/// truncated title keeps; the app's name after it, so a window in a
/// screenshot or the Window menu still says what application it belongs to.
fn title_for(name: &str) -> String {
    format!("{name} — Figylo")
}

/// A label no live window is using.
///
/// Counted up from 2 rather than from a monotonic counter, so closing a window
/// and opening another reuses the gap instead of climbing forever — the label
/// is also what the capability glob and every per-window map are keyed on, and
/// a short stable set of them is easier to read in a log.
fn next_label(app: &AppHandle) -> String {
    let mut n = 2u32;
    loop {
        let label = format!("{MAIN_LABEL}-{n}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
        n += 1;
    }
}

/// Opens another window, and returns its label.
///
/// Built from the same `WindowConfig` the first window uses rather than from a
/// second list of sizes and flags here: the title, the minimum size, the theme
/// and `dragDropEnabled` are decisions already made in `tauri.conf.json`, and
/// two copies of them is one copy that quietly goes stale.
///
/// `name` is what the user typed. Blank — which includes never being asked —
/// gets a fruit, so every window has something to be called either way.
pub fn open_window(app: &AppHandle, name: Option<String>) -> tauri::Result<String> {
    let label = next_label(app);
    let name = name
        .map(|given| given.trim().to_string())
        .filter(|given| !given.is_empty())
        .unwrap_or_else(|| pick_name(app));

    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    config.label = label.clone();
    config.title = title_for(&name);
    // The config's position belongs to the first window; this one cascades off
    // whichever window the user was looking at, below.
    config.center = false;

    let mut builder = WebviewWindowBuilder::from_config(app, &config)?;

    /*
      Off macOS a menu belongs to a window, so a new window with no menu of its
      own is a window with no menu bar at all. On macOS the menu is the
      application's and is already on screen, and `WindowBuilder::menu` is not
      offered there.
    */
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.menu(crate::menu::build_app_menu(app)?);
    }

    /*
      Converted through the scale factor, not used raw. `outer_position` is in
      physical pixels and `position` takes logical ones, so on any display with
      a scale factor the offset would come out wrong — halved on a Retina Mac,
      which is most of them, and the new window would land almost exactly on
      top of the old one. Which is the thing the cascade exists to avoid.
    */
    if let Some(from) = app.get_focused_window() {
        if let (Ok(position), Ok(scale)) = (from.outer_position(), from.scale_factor()) {
            let origin = position.to_logical::<f64>(scale);
            builder = builder.position(origin.x + f64::from(CASCADE), origin.y + f64::from(CASCADE));
        }
    }

    let window = builder.build()?;

    // Built windows are not necessarily in front on every platform, and a
    // window the user just asked for should be the one they are typing into.
    let _ = window.set_focus();

    Ok(label)
}

/// Opens another window, named.
///
/// The name is asked for in the window the request came from, because that is
/// the only place there is a UI to ask in — the menu event goes there too, so
/// every route in (menu, chord, palette) shows the same prompt. An empty
/// answer is a real answer and means "you pick".
#[tauri::command]
pub fn new_window(app: AppHandle, name: Option<String>) -> Result<String, String> {
    open_window(&app, name).map_err(|e| e.to_string())
}

/// Every window label currently alive, for the per-window maps to prune against.
pub fn live_labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows().keys().cloned().collect()
}

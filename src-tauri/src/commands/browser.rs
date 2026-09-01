use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder, Color};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window};

/// Child webviews are addressed by label, so tab ids get a namespace to keep them
/// from ever colliding with the app's own `main` webview.
const LABEL_PREFIX: &str = "figy-browser-";
const HOST_LABEL: &str = "main";
const STATE_EVENT: &str = "browser://state";
const POPUP_EVENT: &str = "browser://popup";
const CLOSED_EVENT: &str = "browser://closed";
const SEARCH_ENDPOINT: &str = "https://www.google.com/search";
pub const HOME_URL: &str = "https://www.google.com";

/// Only the visible tab is polled, so this stays a couple of main-thread hops a second.
const URL_POLL_INTERVAL: Duration = Duration::from_millis(350);
const PENDING_NAV_TIMEOUT: Duration = Duration::from_millis(1500);

/// WKWebView's stock user agent omits the `Version`/`Safari` tokens, which makes a
/// number of sites serve an "unsupported browser" interstitial.
#[cfg(target_os = "macos")]
const USER_AGENT: Option<&str> = Some(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
);
#[cfg(not(target_os = "macos"))]
const USER_AGENT: Option<&str> = None;

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabState {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PopupPayload {
    opener_tab_id: String,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedPayload {
    tab_id: String,
}

/// Session history for a tab.
///
/// The webview engine owns the real history list and exposes no way to query
/// whether `back`/`forward` are available, so depth is tracked here. Navigations we
/// trigger via `history.back()`/`history.forward()` also produce a URL change, and
/// `pending_history_navs` keeps those from being counted as new entries.
#[derive(Debug, Default)]
struct TabNav {
    url: String,
    title: String,
    loading: bool,
    visible: bool,
    committed_loads: u32,
    back: u32,
    forward: u32,
    pending_history_navs: u32,
    /// When the outstanding history move was requested, used to drop moves that never
    /// produce an observable URL change.
    pending_since: Option<Instant>,
}

impl TabNav {
    fn snapshot(&self, tab_id: &str) -> BrowserTabState {
        BrowserTabState {
            tab_id: tab_id.to_string(),
            url: self.url.clone(),
            title: self.title.clone(),
            loading: self.loading,
            can_go_back: self.back > 0,
            can_go_forward: self.forward > 0,
        }
    }

    fn commit(&mut self, url: &str) {
        self.url = url.to_string();

        if self.pending_history_navs > 0 {
            self.pending_history_navs -= 1;
            if self.pending_history_navs == 0 {
                self.pending_since = None;
            }
        } else if self.committed_loads > 0 {
            self.back += 1;
            self.forward = 0;
        }

        self.committed_loads += 1;
    }
}

#[derive(Default)]
pub struct BrowserState {
    tabs: Mutex<HashMap<String, TabNav>>,
    theme: Mutex<String>,
}

fn current_theme(state: &BrowserState) -> String {
    state
        .theme
        .lock()
        .map(|theme| theme.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
}

fn set_stored_theme(state: &BrowserState, theme: String) {
    if let Ok(mut stored) = state.theme.lock() {
        *stored = theme;
    }
}

fn normalize_theme(theme: &str) -> &'static str {
    if theme == "light" {
        "light"
    } else {
        "dark"
    }
}

fn color_scheme_init_script(theme: &str) -> String {
    let theme = normalize_theme(theme);
    format!(
        r#"(function() {{
  const apply = () => {{
    const prefersDark = (window.__figyTheme || "{theme}") === "dark";
    let style = document.getElementById("figy-color-scheme");
    if (!style) {{
      style = document.createElement("style");
      style.id = "figy-color-scheme";
      (document.documentElement || document.head || document.body).appendChild(style);
    }}
    style.textContent = ":root {{ color-scheme: " + (prefersDark ? "dark" : "light") + "; }}";
  }};
  window.__figyTheme = "{theme}";
  window.__figyApplyColorScheme = apply;
  apply();
  if (!window.__figyMatchMediaPatched) {{
    window.__figyMatchMediaPatched = true;
    const original = window.matchMedia.bind(window);
    window.matchMedia = function(query) {{
      const result = original(query);
      if (typeof query === "string" && query.includes("prefers-color-scheme")) {{
        const prefersDark = (window.__figyTheme || "{theme}") === "dark";
        const q = query.toLowerCase();
        let matches = result.matches;
        if (q.includes("dark")) matches = prefersDark;
        else if (q.includes("light")) matches = !prefersDark;
        return {{
          media: query,
          matches,
          addListener: result.addListener?.bind(result),
          removeListener: result.removeListener?.bind(result),
          addEventListener: result.addEventListener?.bind(result),
          removeEventListener: result.removeEventListener?.bind(result),
          onchange: result.onchange,
          dispatchEvent: result.dispatchEvent?.bind(result),
        }};
      }}
      return result;
    }};
  }}
}})();"#
    )
}

fn theme_runtime_script(theme: &str) -> String {
    let theme = normalize_theme(theme);
    format!(
        r#"window.__figyTheme = "{theme}";
if (window.__figyApplyColorScheme) window.__figyApplyColorScheme();"#
    )
}

#[cfg(target_os = "macos")]
fn apply_native_webview_theme(view: &tauri::Webview, theme: &str) {
    let dark = normalize_theme(theme) == "dark";
    let _ = view.with_webview(move |platform| {
        let ptr = platform.inner();
        if ptr.is_null() {
            return;
        }

        unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            use objc2_app_kit::{NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua};

            let webview = ptr as *mut AnyObject;
            let name = if dark {
                NSAppearanceNameDarkAqua
            } else {
                NSAppearanceNameAqua
            };
            if let Some(appearance) = NSAppearance::appearanceNamed(name) {
                let _: () = msg_send![webview, setAppearance: &*appearance];
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn apply_native_webview_theme(_view: &tauri::Webview, _theme: &str) {}

/// Child WKWebViews default to autoresizing with the parent window, which makes them
/// grow over the React browser chrome. Pin them to the explicit bounds we set instead.
fn configure_child_webview(view: &tauri::Webview) {
    let _ = view.with_webview(|platform| {
        #[cfg(target_os = "macos")]
        unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;

            let ptr = platform.inner();
            if ptr.is_null() {
                return;
            }
            let webview = ptr as *mut AnyObject;
            let _: () = msg_send![webview, setAutoresizingMask: 0usize];
        }
    });
}

fn apply_webview_theme(view: &tauri::Webview, theme: &str) {
    apply_native_webview_theme(view, theme);
    let _ = view.eval(&theme_runtime_script(theme));
}

fn apply_theme_to_all_tabs(app: &AppHandle, theme: &str) {
    let state = app.state::<BrowserState>();
    set_stored_theme(&state, theme.to_string());

    let tab_ids: Vec<String> = state
        .tabs
        .lock()
        .map(|tabs| tabs.keys().cloned().collect())
        .unwrap_or_default();

    for tab_id in tab_ids {
        if let Ok(view) = webview(app, &tab_id) {
            apply_webview_theme(&view, theme);
        }
    }
}

fn label_for(tab_id: &str) -> String {
    format!("{LABEL_PREFIX}{tab_id}")
}

fn tab_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX)
}

fn webview(app: &AppHandle, tab_id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&label_for(tab_id))
        .ok_or_else(|| format!("browser tab '{tab_id}' is not open"))
}

/// Applies `edit` to a tab's history. `edit` returns whether the change is worth
/// publishing, which keeps the URL watcher from emitting an event on every idle tick.
fn update<F>(app: &AppHandle, tab_id: &str, edit: F)
where
    F: FnOnce(&mut TabNav) -> bool,
{
    let snapshot = {
        let state = app.state::<BrowserState>();
        let mut tabs = match state.tabs.lock() {
            Ok(tabs) => tabs,
            Err(poisoned) => poisoned.into_inner(),
        };
        tabs.get_mut(tab_id).and_then(|tab| {
            if edit(&mut *tab) {
                Some(tab.snapshot(tab_id))
            } else {
                None
            }
        })
    };

    if let Some(snapshot) = snapshot {
        let _ = app.emit_to(HOST_LABEL, STATE_EVENT, snapshot);
    }
}

/// Records a URL change from any source.
///
/// Real page loads surface through `on_page_load`, but SPA route changes only show up
/// in the engine's URL property, so the watcher reports those. Both funnel through here
/// and the call that notices a given URL first is the one that counts it.
fn commit_url(app: &AppHandle, tab_id: &str, url: &str) {
    update(app, tab_id, |tab| {
        if tab.url == url {
            return false;
        }
        tab.commit(url);
        true
    });
}

/// Turns whatever the user typed into the address bar into a URL, falling back to a
/// web search when the input isn't host-like.
fn resolve_input(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Url::parse(HOME_URL).map_err(|e| e.to_string());
    }

    if let Ok(url) = Url::parse(trimmed) {
        if matches!(url.scheme(), "http" | "https" | "file" | "about") {
            return Ok(url);
        }
    }

    let host = trimmed.split(['/', '?', '#']).next().unwrap_or(trimmed);
    let host_like = !trimmed.contains(char::is_whitespace)
        && (host.contains('.') || host == "localhost" || host.starts_with("localhost:"));

    if host_like {
        if let Ok(url) = Url::parse(&format!("https://{trimmed}")) {
            return Ok(url);
        }
    }

    Url::parse_with_params(SEARCH_ENDPOINT, &[("q", trimmed)]).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_open_tab(
    app: AppHandle,
    window: Window,
    tab_id: String,
    url: String,
    bounds: Bounds,
) -> Result<BrowserTabState, String> {
    let target = resolve_input(&url)?;
    let label = label_for(&tab_id);

    // Reuse an existing webview so a stale tab id (e.g. after a dev reload) recovers
    // instead of failing on a duplicate label.
    if let Some(existing) = app.get_webview(&label) {
        existing.navigate(target.clone()).map_err(|e| e.to_string())?;
        apply_bounds(&existing, bounds)?;
        existing.show().map_err(|e| e.to_string())?;
        let theme = current_theme(&app.state::<BrowserState>());
        apply_webview_theme(&existing, &theme);
    } else {
        let theme = current_theme(&app.state::<BrowserState>());
        let builder = build_webview(&app, &label, &tab_id, target.clone(), &theme);
        window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
            )
            .map_err(|e| e.to_string())?;
        if let Some(view) = app.get_webview(&label) {
            configure_child_webview(&view);
            apply_webview_theme(&view, &theme);
        }
    }

    // The opening URL is itself the first history entry, so later navigations correctly
    // start enabling the back button.
    let initial = TabNav {
        url: target.to_string(),
        loading: true,
        visible: true,
        committed_loads: 1,
        ..TabNav::default()
    };

    let snapshot = initial.snapshot(&tab_id);
    let state = app.state::<BrowserState>();
    state
        .tabs
        .lock()
        .map_err(|_| "browser state lock poisoned".to_string())?
        .insert(tab_id, initial);

    Ok(snapshot)
}

fn build_webview(
    app: &AppHandle,
    label: &str,
    tab_id: &str,
    url: Url,
    theme: &str,
) -> WebviewBuilder<tauri::Wry> {
    let dark = normalize_theme(theme) == "dark";
    let background = if dark {
        Color(26, 29, 35, 255)
    } else {
        Color(255, 255, 255, 255)
    };

    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .zoom_hotkeys_enabled(true)
        .enable_clipboard_access()
        .disable_drag_drop_handler()
        .background_color(background)
        .initialization_script(color_scheme_init_script(theme));

    if let Some(agent) = USER_AGENT {
        builder = builder.user_agent(agent);
    }

    let load_app = app.clone();
    let load_tab = tab_id.to_string();
    builder = builder.on_page_load(move |_, payload| {
        let url = payload.url().to_string();
        commit_url(&load_app, &load_tab, &url);

        let loading = matches!(payload.event(), PageLoadEvent::Started);
        update(&load_app, &load_tab, |tab| {
            if tab.loading == loading {
                return false;
            }
            tab.loading = loading;
            true
        });
    });

    let title_app = app.clone();
    let title_tab = tab_id.to_string();
    builder = builder.on_document_title_changed(move |_, title| {
        update(&title_app, &title_tab, |tab| {
            if tab.title == title {
                return false;
            }
            tab.title = title.clone();
            true
        });
    });

    // `window.open` and `target="_blank"` become new tabs in our own tab strip rather
    // than detached OS windows.
    let popup_app = app.clone();
    let popup_tab = tab_id.to_string();
    builder = builder.on_new_window(move |url, _features| {
        let _ = popup_app.emit_to(
            HOST_LABEL,
            POPUP_EVENT,
            PopupPayload {
                opener_tab_id: popup_tab.clone(),
                url: url.to_string(),
            },
        );
        NewWindowResponse::Deny
    });

    builder
}

fn apply_bounds(view: &tauri::Webview, bounds: Bounds) -> Result<(), String> {
    configure_child_webview(view);
    view.set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(
        bounds.width.max(1.0),
        bounds.height.max(1.0),
    ))
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_bounds(app: AppHandle, tab_id: String, bounds: Bounds) -> Result<(), String> {
    apply_bounds(&webview(&app, &tab_id)?, bounds)
}

#[tauri::command]
pub fn browser_set_visible(
    app: AppHandle,
    tab_id: String,
    visible: bool,
    bounds: Option<Bounds>,
) -> Result<(), String> {
    let view = webview(&app, &tab_id)?;

    // Recorded so the URL watcher only polls the tab the user can actually see.
    update(&app, &tab_id, |tab| {
        tab.visible = visible;
        false
    });

    if visible {
        if let Some(bounds) = bounds {
            apply_bounds(&view, bounds)?;
        }
        view.show().map_err(|e| e.to_string())
    } else {
        view.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let target = resolve_input(&url)?;
    webview(&app, &tab_id)?
        .navigate(target.clone())
        .map_err(|e| e.to_string())?;

    // An explicit navigation invalidates any in-flight history move. The URL itself is
    // left for `commit_url` to record, so the entry still counts toward history depth.
    update(&app, &tab_id, |tab| {
        tab.pending_history_navs = 0;
        tab.pending_since = None;
        tab.loading = true;
        true
    });

    Ok(())
}

#[tauri::command]
pub fn browser_go_back(app: AppHandle, tab_id: String) -> Result<(), String> {
    let view = webview(&app, &tab_id)?;
    let allowed = {
        let state = app.state::<BrowserState>();
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| "browser state lock poisoned".to_string())?;
        match tabs.get_mut(&tab_id) {
            Some(tab) if tab.back > 0 => {
                tab.back -= 1;
                tab.forward += 1;
                tab.pending_history_navs += 1;
                tab.pending_since = Some(Instant::now());
                true
            }
            _ => false,
        }
    };

    if allowed {
        view.eval("history.back()").map_err(|e| e.to_string())?;
        update(&app, &tab_id, |_| true);
    }

    Ok(())
}

#[tauri::command]
pub fn browser_go_forward(app: AppHandle, tab_id: String) -> Result<(), String> {
    let view = webview(&app, &tab_id)?;
    let allowed = {
        let state = app.state::<BrowserState>();
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| "browser state lock poisoned".to_string())?;
        match tabs.get_mut(&tab_id) {
            Some(tab) if tab.forward > 0 => {
                tab.forward -= 1;
                tab.back += 1;
                tab.pending_history_navs += 1;
                tab.pending_since = Some(Instant::now());
                true
            }
            _ => false,
        }
    };

    if allowed {
        view.eval("history.forward()").map_err(|e| e.to_string())?;
        update(&app, &tab_id, |_| true);
    }

    Ok(())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, tab_id: String) -> Result<(), String> {
    webview(&app, &tab_id)?.reload().map_err(|e| e.to_string())?;
    // A reload lands on the same URL, so it produces no history entry to discount.
    update(&app, &tab_id, |tab| {
        tab.loading = true;
        true
    });
    Ok(())
}

#[tauri::command]
pub fn browser_stop(app: AppHandle, tab_id: String) -> Result<(), String> {
    webview(&app, &tab_id)?
        .eval("window.stop()")
        .map_err(|e| e.to_string())?;
    update(&app, &tab_id, |tab| {
        tab.loading = false;
        true
    });
    Ok(())
}

#[tauri::command]
pub fn browser_focus(app: AppHandle, tab_id: String) -> Result<(), String> {
    webview(&app, &tab_id)?
        .set_focus()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let normalized = normalize_theme(&theme).to_string();
    apply_theme_to_all_tabs(&app, &normalized);
    Ok(())
}

#[tauri::command]
pub fn browser_set_zoom(app: AppHandle, tab_id: String, factor: f64) -> Result<(), String> {
    webview(&app, &tab_id)?
        .set_zoom(factor.clamp(0.25, 5.0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_close_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label_for(&tab_id)) {
        view.close().map_err(|e| e.to_string())?;
    }

    if let Ok(mut tabs) = app.state::<BrowserState>().tabs.lock() {
        tabs.remove(&tab_id);
    }

    let _ = app.emit_to(
        HOST_LABEL,
        CLOSED_EVENT,
        ClosedPayload {
            tab_id: tab_id.clone(),
        },
    );

    Ok(())
}

/// Watches the visible tab's URL so single-page apps stay in sync.
///
/// `pushState`/`replaceState` and same-document `popstate` changes fire no page-load
/// event in any platform webview, but they do update the engine's own URL property, so
/// polling that is the only portable way to observe SPA routing.
pub fn start_url_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(URL_POLL_INTERVAL);

        let watched: Vec<String> = {
            let state = app.state::<BrowserState>();
            let tabs = match state.tabs.lock() {
                Ok(tabs) => tabs,
                Err(poisoned) => poisoned.into_inner(),
            };
            tabs.iter()
                .filter(|(_, tab)| tab.visible)
                .map(|(tab_id, _)| tab_id.clone())
                .collect()
        };

        for tab_id in watched {
            expire_pending_nav(&app, &tab_id);

            if let Some(view) = app.get_webview(&label_for(&tab_id)) {
                if let Ok(url) = view.url() {
                    commit_url(&app, &tab_id, url.as_str());
                }
            }
        }
    });
}

/// Drops a history move that never produced a URL change, which happens when adjacent
/// entries share a URL. Without this the move would silently absorb the next real
/// navigation and leave the back button wrong.
fn expire_pending_nav(app: &AppHandle, tab_id: &str) {
    update(app, tab_id, |tab| match tab.pending_since {
        Some(since) if since.elapsed() > PENDING_NAV_TIMEOUT => {
            tab.pending_history_navs = 0;
            tab.pending_since = None;
            tab.loading = false;
            true
        }
        _ => false,
    });
}

/// Tears down every browser webview. Used when the modal closes or the app shuts down.
#[tauri::command]
pub fn browser_close_all(app: AppHandle) -> Result<(), String> {
    let labels: Vec<String> = app
        .webviews()
        .keys()
        .filter(|label| label.starts_with(LABEL_PREFIX))
        .cloned()
        .collect();

    for label in labels {
        if let Some(view) = app.get_webview(&label) {
            let _ = view.close();
        }
        if let Some(tab_id) = tab_id_from_label(&label) {
            if let Ok(mut tabs) = app.state::<BrowserState>().tabs.lock() {
                tabs.remove(tab_id);
            }
        }
    }

    Ok(())
}

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
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
    } else {
        let builder = build_webview(&app, &label, &tab_id, target.clone());
        window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
            )
            .map_err(|e| e.to_string())?;
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
) -> WebviewBuilder<tauri::Wry> {
    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .zoom_hotkeys_enabled(true)
        .enable_clipboard_access()
        .disable_drag_drop_handler();

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

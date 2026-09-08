//! Positions the browser's native webviews inside the app window on Linux.
//!
//! Tauri parents a child webview to the window's *vertical* `gtk::Box`, so GTK
//! divides the window between the app's own webview and each browser view: they
//! stack instead of floating, and `Webview::set_bounds` does nothing at all,
//! because wry only repositions a webview whose parent is a `gtk::Fixed`
//! (<https://github.com/tauri-apps/tauri/issues/10420>).
//!
//! So the container is built here instead, in the shape wry's own
//! `gtk_multiwebview` example uses: one `gtk::Fixed` filling the window, with
//! every webview placed in it at explicit coordinates. The app's own webview
//! goes in first at (0, 0) so it sits underneath, and browser views are added
//! after it, which puts them on top — `GtkFixed` draws its children in the order
//! they were added.
//!
//! Positioning goes through `gtk::Fixed::move_` rather than a bare
//! `size_allocate`, because the container re-allocates every child back to its
//! stored put-coordinate on the next layout pass; an allocation on its own holds
//! only until the first resize.
//!
//! macOS needs none of this — `set_position`/`set_size` work there — so this
//! module is Linux-only and `browser::apply_bounds` picks between the two.

use std::cell::Cell;

use gtk::prelude::*;
use gtk::{Fixed, Widget};
use webkit2gtk::WebView as GtkWebView;

use super::browser::Bounds;

/// Names our container so it can be found again among the window's children.
const FIXED_NAME: &str = "figy-browser-layout";

/// Places a browser webview at `bounds`, building the shared container and
/// adopting the app's webview into it on the first call.
///
/// Dispatches onto the GTK main thread, which is the only thread allowed to
/// touch widgets. Failures are logged rather than returned: this runs on every
/// layout tick while the modal is open, and a caller can't do anything useful
/// with the error.
pub fn place(view: &tauri::Webview, bounds: Bounds) -> Result<(), String> {
    view.with_webview(move |platform| {
        if let Err(e) = apply(platform.inner().upcast(), bounds) {
            log::error!("could not place the browser webview: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

fn apply(widget: Widget, bounds: Bounds) -> Result<(), String> {
    let fixed = ensure_container(&widget)?;

    let x = bounds.x.round() as i32;
    let y = bounds.y.round() as i32;
    let width = bounds.width.max(1.0).round() as i32;
    let height = bounds.height.max(1.0).round() as i32;

    let already_placed = widget
        .parent()
        .map(|parent| parent.widget_name().as_str() == FIXED_NAME)
        .unwrap_or(false);

    if already_placed {
        fixed.move_(&widget, x, y);
    } else {
        // Tauri packed it into the window's box on creation; take it back out.
        if let Some(parent) = widget
            .parent()
            .and_then(|parent| parent.downcast::<gtk::Container>().ok())
        {
            parent.remove(&widget);
        }
        fixed.put(&widget, x, y);
    }

    widget.set_size_request(width, height);
    widget.show();

    Ok(())
}

/// The `gtk::Fixed` every webview in this window lives in, created on first use.
fn ensure_container(widget: &Widget) -> Result<Fixed, String> {
    let vbox = content_box(widget)?;

    if let Some(existing) = vbox
        .children()
        .into_iter()
        .find(|child| child.widget_name().as_str() == FIXED_NAME)
    {
        return existing
            .downcast::<Fixed>()
            .map_err(|_| format!("`{FIXED_NAME}` is not a GtkFixed"));
    }

    // First call for this window. The app's webview is whichever WebKitWebView in
    // the box isn't the one being placed — matching by type rather than position
    // because the box also holds the menu bar.
    let app_view = vbox
        .children()
        .into_iter()
        .find(|child| child.is::<GtkWebView>() && child.as_ptr() != widget.as_ptr())
        .ok_or("could not find the app's webview to place the browser above")?;

    let fixed = Fixed::new();
    fixed.set_widget_name(FIXED_NAME);

    vbox.remove(&app_view);
    fixed.put(&app_view, 0, 0);
    vbox.pack_start(&fixed, true, true, 0);

    track_size(&fixed, &app_view);

    fixed.show_all();
    Ok(fixed)
}

/// The window's content box — the widget Tauri packs webviews into.
fn content_box(widget: &Widget) -> Result<gtk::Box, String> {
    widget
        .toplevel()
        .ok_or("the browser webview has no window")?
        .downcast::<gtk::Window>()
        .map_err(|_| "the browser webview's toplevel is not a GtkWindow".to_string())?
        .child()
        .ok_or("the window has no content widget")?
        .downcast::<gtk::Box>()
        .map_err(|_| "the window's content is not a GtkBox".to_string())
}

/// Keeps the app's webview filling the container.
///
/// `GtkFixed` never resizes its children, so once the app's webview is moved in
/// it would otherwise keep whatever size it had at that moment and stop
/// following the window.
fn track_size(fixed: &Fixed, app_view: &Widget) {
    // `set_size_request` queues another layout pass, so without comparing
    // against the last size this handler would re-enter itself indefinitely.
    // Starting at (-1, -1) guarantees the first real allocation is applied.
    let last = Cell::new((-1, -1));
    let app_view = app_view.clone();

    fixed.connect_size_allocate(move |_, allocation| {
        let size = (allocation.width(), allocation.height());
        if last.get() == size {
            return;
        }
        last.set(size);
        app_view.set_size_request(size.0, size.1);
    });
}

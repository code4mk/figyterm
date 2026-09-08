/**
 * Which desktop FigyTerm is running on.
 *
 * Tauri's OS plugin would answer this too, but that's a Rust dependency and a
 * capability entry for a question the webview's own user agent already answers:
 * WKWebView reports `Macintosh`, WebKitGTK reports `Linux`, WebView2 reports
 * `Windows`. Linux is the fallback because it's the only one of the three whose
 * UA string varies by distro and desktop.
 *
 * Keyboard shortcuts differ per platform too — see `shortcuts.ts`.
 */

export type Platform = "mac" | "linux" | "windows";

function detect(): Platform {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  return "linux";
}

export const platform: Platform = detect();
export const isMac = platform === "mac";
export const isLinux = platform === "linux";

/**
 * Whether the in-app browser can be offered at all.
 *
 * It draws a native child webview underneath React chrome, and child webviews
 * can't be positioned on Linux/GTK: wry creates one as a separate X11 window and
 * moves it with `gtk_window.move_()`, which doesn't land in parent-relative
 * coordinates, so the site renders outside the modal entirely. That's upstream —
 * https://github.com/tauri-apps/tauri/issues/10420, open — and not something the
 * app can work around, so Linux hides the feature rather than advertising a
 * broken one. Revisit when that issue closes.
 */
export const EMBEDDED_BROWSER_SUPPORTED = !isLinux;

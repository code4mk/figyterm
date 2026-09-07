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

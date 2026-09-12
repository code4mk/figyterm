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
export const isWindows = platform === "windows";

/**
 * Whether the in-app browser can be offered.
 *
 * It draws a native child webview underneath React chrome. Tauri can't position
 * one of those on GTK — it parents them to the window's vertical box, so they
 * stack instead of floating and `set_bounds` does nothing
 * (https://github.com/tauri-apps/tauri/issues/10420). `browser_layout.rs` builds
 * the container Linux needs, so the feature works on both platforms.
 *
 * Kept as a single switch rather than deleted: flip it to `!isLinux` to hide the
 * browser everywhere it isn't wanted, without hunting down the menu item, the
 * palette entry, the shortcut and the settings row.
 */
export const EMBEDDED_BROWSER_SUPPORTED = true;

/**
 * Whether the Oh My Zsh theme picker can work here.
 *
 * It reads and rewrites `~/.zshrc` by shelling out to `sh -c`, `grep`, `ls` and
 * `sed -i` — none of which exist on Windows, where the shell is PowerShell and
 * the equivalent would be Oh My Posh. Porting it is a feature, not a port task,
 * so Windows hides the section rather than showing one that can't work.
 */
export const OH_MY_ZSH_SUPPORTED = platform !== "windows";

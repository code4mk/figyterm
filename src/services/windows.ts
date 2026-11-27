import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * More than one Figylo window.
 *
 * A window is the unit of isolation: its own tabs and panes, its own shells,
 * its own editor workspace and browser tabs. Settings, the theme and the API
 * collections are the process's and are shared, which is what anybody would
 * expect of a preference.
 *
 * The Rust side does the building — see `commands/window.rs` — because the
 * label has to be chosen against the windows that already exist, and because
 * the capability file only grants permissions to labels matching its glob. A
 * window built from here with a name of the frontend's choosing would come up
 * with no permissions at all and every `invoke` from it rejected.
 */

/** This window's label, which is also the key to its state on the Rust side. */
export function currentWindowLabel(): string {
  return getCurrentWindow().label;
}

/**
 * Opens another window, and resolves with its label.
 *
 * `name` is what the user typed into the prompt, and is what the window will
 * be called in its title bar, the Window menu and the Dock. Blank — or left
 * out — is a real answer: the Rust side picks a fruit nothing else is using,
 * so every window has something to be called and no two are called the same.
 */
export function openWindow(name?: string): Promise<string> {
  return invoke<string>("new_window", { name: name?.trim() || null });
}

/**
 * Sends an app event to this window and no other.
 *
 * The plain `emit` broadcasts to every window, which with one window was the
 * same thing. It is not with two: the command palette's Copy would have copied
 * in the other window's focused pane as well as this one's, and its Find would
 * have opened a search box in a window nobody was looking at. Anything aimed at
 * "the focused pane" means the focused pane *here*.
 */
export function emitToSelf(event: string, payload?: unknown): Promise<void> {
  return emitTo(currentWindowLabel(), event, payload);
}

/**
 * Listens for an event, **as this window**.
 *
 * Addressing an event is only half of it, and the half that does nothing on
 * its own. A bare `listen(event, handler)` registers with Tauri's `Any`
 * target, and `Any` is checked *before* the emit's target is consulted at all:
 *
 * ```rust
 * *target == EventTarget::Any || filter(target)   // event/listener.rs
 * ```
 *
 * So a listener that never says who it is receives everything, including
 * events addressed to a different window — which made every `emit_to(label)`
 * in the app a plain broadcast wearing a label. Opening the editor, the
 * browser or Claude in one window opened it in all of them, because the
 * handler that opens them was listening as `Any`.
 *
 * Naming the window fixes both directions at once: an event addressed here
 * arrives, an event addressed elsewhere does not, and a genuine broadcast
 * (`emit`, target `Any`) still arrives — the filter is skipped entirely for
 * those. So this is safe on events that are meant for everybody, and the rule
 * is simply that anything window-scoped listens through here.
 */
export function listenToSelf<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(event, (received) => handler(received.payload), {
    target: currentWindowLabel(),
  });
}

/**
 * Which floating overlay sits in front.
 *
 * The editor, the browser, the system monitor and history search can all float
 * at once, and each had a fixed z-index baked into its CSS — three of them the
 * same value, the editor's lower still. So the front one was decided by which
 * component happened to render last, and clicking a window behind another did
 * nothing to bring it forward.
 *
 * Claims rather than a bare counter, because two questions need answering and
 * only one of them is about painting:
 *
 * 1. **What z-index should I use?** The claimed value, which increases, so the
 *    most recently touched overlay wins. It has to go on the overlay's
 *    outermost *fixed* element — a positioned ancestor with a z-index creates a
 *    stacking context, and a child's z-index only competes inside it, which is
 *    why the editor's frame could never rise above the browser's however high
 *    it was set.
 *
 * 2. **Am I in front?** The browser needs this because its page is a native
 *    child webview, composited above the app's own webview entirely; no CSS can
 *    put anything over it, so it has to hide the page when something else comes
 *    forward. That makes *releasing* a claim matter: a counter alone left the
 *    editor's number on top after it closed, and the browser stayed blanked
 *    behind a window that was no longer there.
 */

/** Clear of the 240–250 range the overlays' stylesheets use. */
const BASE_Z = 260;

/** One entry per overlay that is currently open, holding its claimed z-index. */
const claims = new Map<string, number>();

let counter = BASE_Z;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Puts `id` in front and returns the z-index to render it at.
 *
 * Call when the overlay opens and whenever it's clicked.
 */
export function claimFront(id: string): number {
  counter += 1;
  claims.set(id, counter);
  notify();
  return counter;
}

/** Gives up `id`'s claim, so whatever is still open becomes frontmost. */
export function releaseFront(id: string): void {
  if (!claims.delete(id)) return;
  notify();
}

/** Whether `id` currently holds the highest claim. */
export function isFront(id: string): boolean {
  const mine = claims.get(id);
  if (mine === undefined) return false;
  for (const z of claims.values()) {
    if (z > mine) return false;
  }
  return true;
}

/**
 * Notifies when claims change.
 *
 * Returns the unsubscribe function, so it can be handed straight back from a
 * `useEffect`.
 */
export function subscribeOverlayStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

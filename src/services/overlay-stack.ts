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
 * 2. **Is anything covering me?** The browser needs this because its page is a
 *    native child webview, composited above the app's own webview entirely; no
 *    CSS can put anything over it, so it has to *hide* the page when something
 *    else is genuinely on top of it. That makes *releasing* a claim matter: a
 *    counter alone left the editor's number on top after it closed, and the
 *    browser stayed blanked behind a window that was no longer there.
 *
 *    "Genuinely on top" is why overlays register a rectangle. Asking only
 *    "am I frontmost?" blanked the browser the moment the editor was clicked
 *    even with the two side by side in picture-in-picture, not overlapping by
 *    a pixel — which looks exactly like the browser has broken. An overlay
 *    with *no* rectangle counts as covering everything, which is correct: a
 *    modal that isn't in picture-in-picture has a full-screen backdrop, and
 *    that really is over the whole window.
 */

/**
 * Ordering and painting are two different numbers.
 *
 * They used to be one. `claimFront` incremented a counter and handed it back as
 * the z-index, so the number an overlay painted at was however many claims had
 * ever been made — and a claim is made on *every pointer-down*, not just on
 * open. Click between two windows for a minute and the overlays are painting in
 * the four figures.
 *
 * Nothing in the app is above four figures, which is how Settings and the
 * new-window prompt ended up underneath windows they are supposed to sit over:
 * they hold a fixed number, and a counter that climbs forever will eventually
 * climb past any fixed number you choose.
 *
 * So the counter stays, and stays unbounded — it is a sequence number and a
 * good one. But it is never painted. The z-index is `BASE_Z + rank`, where rank
 * is the overlay's position in claim order, which cannot exceed the number of
 * overlays that are open. Seven exist. The band is reserved for a hundred.
 */

/** Clear of the 240–250 range the overlays' stylesheets use. */
const BASE_Z = 260;

/** How wide the overlay band is. Every claim lands inside it, always. */
const BAND = 100;

/**
 * The highest z-index any overlay can ever paint at.
 *
 * Anything that must sit above every floating window belongs above this, and
 * `APP_DIALOG_Z` is that place. Nothing should pick its own number here.
 */
export const OVERLAY_Z_MAX = BASE_Z + BAND - 1;

/**
 * For the app's own modal dialogs — Settings, the new-window prompt — which are
 * not overlays in this sense: they do not stack against the windows, they go
 * over all of them.
 *
 * Above `OVERLAY_Z_MAX`, and above the tab bar's drag ghost (500) and the
 * overlay error boundary (400), both of which are shell furniture that a modal
 * dialog still outranks.
 */
export const APP_DIALOG_Z = 600;

/**
 * One entry per open overlay, holding the sequence number of its last claim.
 *
 * Not a z-index. See the note above.
 */
const claims = new Map<string, number>();

/**
 * What `id` should paint at: the base plus its rank in claim order.
 *
 * `null` when it holds no claim, which is how a closed overlay says it has no
 * opinion. Recomputed rather than stored, because a claim by *one* overlay
 * changes the rank of every overlay above it.
 */
export function overlayZ(id: string): number | null {
  if (!claims.has(id)) return null;
  const order = [...claims.entries()].sort((a, b) => a[1] - b[1]);
  const rank = order.findIndex(([key]) => key === id);
  // Clamped rather than wrapped: a hundred simultaneous overlays is not a
  // state this app can reach, and if it ever did, painting the overflow at the
  // top of the band is better than painting it over Settings.
  return BASE_Z + Math.min(rank, BAND - 1);
}

/**
 * Where each overlay is, for the ones that are a window rather than a
 * full-screen modal. Absent means "assume it covers everything".
 */
const rects = new Map<string, OverlayRect>();

/** Viewport coordinates, as `getBoundingClientRect` gives them. */
export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

let counter = BASE_Z;

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Puts `id` in front and returns the z-index to render it at.
 *
 * Call when the overlay opens and whenever it's clicked.
 *
 * The returned value is a *rank*, so claiming the front changes what every
 * other open overlay should be painting at too. Callers that keep the number
 * in component state have to re-read it when the stack changes —
 * `useOverlayFront` does, and is how all seven overlays take theirs.
 */
export function claimFront(id: string): number {
  counter += 1;
  claims.set(id, counter);
  notify();
  return overlayZ(id) ?? BASE_Z;
}

/** Gives up `id`'s claim, so whatever is still open becomes frontmost. */
export function releaseFront(id: string): void {
  const had = claims.delete(id);
  rects.delete(id);
  if (!had) return;
  notify();
}

/**
 * Records where an overlay is, or that it covers the whole window.
 *
 * `null` for a modal with a backdrop — it does cover everything, and saying so
 * is simpler than registering a viewport-sized rectangle and keeping it in
 * step with the window.
 *
 * Silent when nothing moved, because this is called from a drag: a pointer
 * move that leaves the rectangle where it was must not wake every subscriber.
 */
export function setOverlayRect(id: string, rect: OverlayRect | null): void {
  const existing = rects.get(id);
  if (!rect) {
    if (!existing) return;
    rects.delete(id);
    notify();
    return;
  }
  if (
    existing &&
    existing.left === rect.left &&
    existing.top === rect.top &&
    existing.width === rect.width &&
    existing.height === rect.height
  ) {
    return;
  }
  rects.set(id, rect);
  notify();
}

function overlaps(a: OverlayRect, b: OverlayRect): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/**
 * Whether any overlay in front of `id` is actually over `rect`.
 *
 * The question the browser has to answer, and not the same as "am I
 * frontmost?": two windows side by side in picture-in-picture are both fully
 * visible however they are stacked.
 */
export function isCovered(id: string, rect: OverlayRect): boolean {
  const mine = claims.get(id);
  if (mine === undefined) return false;

  for (const [other, z] of claims) {
    if (other === id || z < mine) continue;
    const theirs = rects.get(other);
    // No rectangle: a full-screen modal, which covers everything.
    if (!theirs || overlaps(theirs, rect)) return true;
  }
  return false;
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

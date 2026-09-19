/**
 * Where the request and the response sit, and how much of the window each has.
 *
 * Below by default. Side by side wastes the shape of the window: a URL is wide
 * and short, a JSON body is narrow and tall, and at any ordinary width the
 * response ends up with half the window and wraps every line in it.
 *
 * Pure, and out of the store, because the interesting part is reading a saved
 * position back — which is a function of one untrusted value and has a failure
 * mode worth a test.
 */

/** Where the response goes relative to the request. */
export type SplitLayout = "bottom" | "right";

/** What the panel library calls a layout: a flex-grow per panel id. */
export type PanelLayout = Record<string, number>;

/** Response a little larger than the request in both layouts — it is the one
 * with the body in it. */
export const DEFAULT_SPLIT: Record<SplitLayout, PanelLayout> = {
  bottom: { request: 44, response: 56 },
  right: { request: 46, response: 54 },
};

/** A stored layout name, or the default. */
export function readSplit(saved: unknown): SplitLayout {
  return saved === "right" ? "right" : "bottom";
}

/**
 * A saved divider position, or the default if it is not usable.
 *
 * Checked rather than trusted, and all-or-nothing rather than per key. A zero,
 * a negative or a `NaN` collapses a panel to nothing, and a pane with no height
 * is one nobody can drag back — so a layout that is wrong anywhere is discarded
 * everywhere, rather than half-applied into a shape neither side chose.
 *
 * Keys the fallback does not name are dropped: they are panels this build does
 * not have, and passing them on would be handing the layout engine ids it
 * cannot place.
 */
export function readLayout(saved: unknown, fallback: PanelLayout): PanelLayout {
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return fallback;

  const layout: PanelLayout = {};
  for (const key of Object.keys(fallback)) {
    const value = (saved as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
    layout[key] = value;
  }
  return layout;
}

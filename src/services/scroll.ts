/**
 * Scrolls one container, and nothing else.
 *
 * `Element.scrollIntoView` walks *every* scrollable ancestor and moves each of
 * them on both axes. Inside nested layout that is a wrecking ball: keeping the
 * outline's current entry visible scrolled the preview pane sideways as well,
 * so the document was clipped down its left edge and the outline rail was
 * pushed out past the modal's frame. It looked like a layout bug and was really
 * a scroll one.
 *
 * This adjusts only `container.scrollTop`, only when the child is actually out
 * of view, and never touches the horizontal axis or anything further up the
 * tree.
 */

/** Keeps `child` visible inside `container` by the smallest vertical move. */
export function scrollIntoViewWithin(
  container: HTMLElement | null | undefined,
  child: HTMLElement | null | undefined,
  options: { block?: "nearest" | "center" } = {}
): void {
  if (!container || !child) return;

  const view = container.clientHeight;
  const top = child.offsetTop - container.offsetTop;
  const bottom = top + child.offsetHeight;
  const current = container.scrollTop;

  if (options.block === "center") {
    container.scrollTop = Math.max(0, top - (view - child.offsetHeight) / 2);
    return;
  }

  // "nearest": leave it alone when it's already visible, so a list being read
  // doesn't twitch every time the marked row changes.
  if (top < current) {
    container.scrollTop = top;
  } else if (bottom > current + view) {
    container.scrollTop = bottom - view;
  }
}

/**
 * The same idea sideways, for a tab strip.
 *
 * Separate from the vertical one rather than a mode of it, because the two
 * want different things. A list being read should not twitch, so the vertical
 * version leaves a visible row alone and jumps without animating. A tab strip
 * is *navigated* — the tab you asked for has to come into view, and the scroll
 * has to be visible or the strip appears to teleport and you lose track of
 * where in twenty tabs you now are.
 *
 * `scrollTo({ behavior: "smooth" })` rather than an animation of our own: the
 * platform interrupts and re-targets an in-flight smooth scroll when a second
 * one starts, which is exactly what holding ⌘⇧] needs and is fiddly to get
 * right by hand.
 *
 * A margin, because a tab flush against the edge reads as the last one when it
 * isn't — leaving a sliver of its neighbour showing is what says the strip
 * continues.
 */
export function scrollHorizontallyWithin(
  container: HTMLElement | null | undefined,
  child: HTMLElement | null | undefined,
  options: { margin?: number; smooth?: boolean } = {}
): void {
  if (!container || !child) return;

  const margin = options.margin ?? 24;
  const view = container.clientWidth;
  const left = child.offsetLeft;
  const right = left + child.offsetWidth;
  const current = container.scrollLeft;

  let target = current;
  if (left - margin < current) {
    target = Math.max(0, left - margin);
  } else if (right + margin > current + view) {
    target = right + margin - view;
  } else {
    // Already visible with room to spare: moving would be a twitch.
    return;
  }

  // Clamped, or a smooth scroll past the end bounces back and reads as a
  // rubber-band the user didn't ask for.
  target = Math.min(target, container.scrollWidth - view);

  if (options.smooth === false) {
    container.scrollLeft = target;
    return;
  }
  container.scrollTo({ left: target, behavior: "smooth" });
}

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

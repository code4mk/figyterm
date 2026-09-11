import { RefObject, useEffect } from "react";
import { setOverlayRect } from "../services/overlay-stack";

/**
 * Tells the overlay stack where a floating window is.
 *
 * Only the browser reads these, and only for one question: is something
 * genuinely on top of my page? Its page is a native child webview that no CSS
 * can cover, so the only way to occlude it is to hide it — and it used to hide
 * whenever anything else was merely *in front*, which blanked it the moment the
 * editor was clicked even with the two side by side in picture-in-picture,
 * touching nowhere. See `services/overlay-stack.ts`.
 *
 * `active` is "this is a window, and here is where it is". Pass false for a
 * modal with a backdrop: the stack treats a missing rectangle as covering
 * everything, which for a full-screen backdrop is exactly right.
 *
 * The measuring effect has **no dependency array**, deliberately. A drag moves
 * the element by re-rendering it with a new `style`, and nothing about that
 * shows up in a dependency list — so the only reliable moment to re-read the
 * geometry is after every render, which is once per drag frame. It costs one
 * `getBoundingClientRect` per frame, and `setOverlayRect` is silent when the
 * numbers haven't moved, so a render that didn't move the window wakes nobody.
 */
export function useOverlayRect(
  id: string,
  ref: RefObject<HTMLElement>,
  active: boolean
): void {
  useEffect(() => {
    if (!active) {
      setOverlayRect(id, null);
      return;
    }
    const element = ref.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    setOverlayRect(id, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  });

  // A window resize can move a window that clamps to the viewport without
  // re-rendering it, so the effect above would never run.
  useEffect(() => {
    if (!active) return;
    const remeasure = () => {
      const element = ref.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      setOverlayRect(id, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
  }, [id, ref, active]);

  useEffect(
    () => () => {
      // Unmounted, not merely hidden: leaving a rectangle behind would keep
      // blanking the browser's page on behalf of a window that is gone.
      setOverlayRect(id, null);
    },
    [id]
  );
}

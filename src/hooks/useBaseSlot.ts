import { useEffect } from "react";
import { baseSlotRect, type ModalPos, type ModalSize } from "./useDraggableModal";

/**
 * Pins a window to the base slot for as long as it is the base.
 *
 * A service that is the base is still a window — same component, same
 * `useDraggableModal`, same overlay — it simply never moves and never closes.
 * That is the whole of the base/window distinction as far as these components
 * are concerned, and it is deliberately that small: the alternative was a
 * second rendering path per service for the case where it happens to be the
 * thing underneath, six times over, each able to drift from the floating one.
 *
 * `fullscreen` has the same shape and is not the same thing. Fullscreen is a
 * window covering the status bar for as long as you hold it; this is a window
 * that stops behaving like one, and stops above the bar so the bar is still
 * readable — which is what makes the base feel like the app rather than like a
 * maximised dialog nobody can dismiss.
 */
export function useBaseSlot(
  docked: boolean,
  place: (pos: ModalPos | null, size: ModalSize) => void
): void {
  useEffect(() => {
    if (!docked) return;

    const follow = () => {
      const rect = baseSlotRect();
      place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
    };

    follow();
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [docked, place]);
}

/**
 * The base sits under every floating window, and over nothing.
 *
 * Floating windows take their z-index from the overlay stack, which hands out
 * numbers well above this one as they are raised. The base never joins that
 * stack — it must not be raisable, because there is nothing for it to be raised
 * above — so it takes a constant below the range the stack issues.
 */
export const BASE_SLOT_Z = 40;

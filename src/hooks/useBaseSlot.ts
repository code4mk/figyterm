import { useEffect, useRef } from "react";
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
 * window you are holding at full size and can restore; this is a service that
 * has stopped being a window at all — it cannot be dragged, resized, closed or
 * restored, because there is nothing to restore it to.
 */
export function useBaseSlot(
  docked: boolean,
  place: (pos: ModalPos | null, size: ModalSize) => void,
  /**
   * Called once when this service stops being the primary.
   *
   * It has to put the window back where a window goes. Being primary means
   * being `place()`d at the whole slot, and that position and size outlive the
   * promotion — so a service demoted when something else took the window would
   * reopen as a "popup" pinned to 0,0 at the full size of the screen, covering
   * the thing that replaced it. Implementations call `reset()`, which is the
   * centred default a window has before it has ever been dragged, and clear
   * any fullscreen they were holding, since the button that would have
   * restored it was hidden for as long as they were primary.
   */
  onUndock: () => void
): void {
  const wasDocked = useRef(false);

  useEffect(() => {
    if (!docked) {
      if (!wasDocked.current) return;
      wasDocked.current = false;
      onUndock();
      return;
    }

    wasDocked.current = true;

    const follow = () => {
      const rect = baseSlotRect();
      place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
    };

    follow();
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [docked, place, onUndock]);
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

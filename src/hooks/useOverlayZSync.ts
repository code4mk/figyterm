import { useEffect } from "react";
import { overlayZ, subscribeOverlayStack } from "../services/overlay-stack";

/**
 * Keeps an overlay's copy of its own z-index current.
 *
 * Every floating window holds the number `claimFront` gave it in `useState`.
 * That was safe while the number only ever went up: a claim changed the
 * claimant and nobody else. It is not safe now that the z-index is a **rank** —
 * see `overlay-stack.ts` for why it had to become one — because a claim by any
 * overlay renumbers every overlay above it, and a value captured once goes
 * stale the moment a neighbour is clicked.
 *
 * Stale, two windows end up holding the same number, and which of them is in
 * front is settled by document order: not a decision anybody made, and not a
 * stable one.
 *
 * Deliberately only this. The claim itself, the release, and when to re-raise
 * stay where they are — the browser re-claims when it enters
 * picture-in-picture, the editor releases from a long way below where it
 * claims, and folding those differences into one hook would be rewriting seven
 * working effects to fix a problem none of them has.
 */
export function useOverlayZSync(
  id: string,
  setZ: (z: number | null) => void
): void {
  // `setZ` is a `useState` setter at every call site, so its identity is
  // stable and this subscribes once.
  useEffect(() => subscribeOverlayStack(() => setZ(overlayZ(id))), [id, setZ]);
}

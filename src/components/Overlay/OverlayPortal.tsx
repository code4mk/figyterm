import { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders an overlay as a sibling of `#root` rather than inside it.
 *
 * Headless UI's `Dialog` — Settings, the update modal, the tab rename box —
 * makes the rest of the page inert while it is open. Not `pointer-events:
 * none`, not `aria-hidden` alone: it sets the real `inert` property, and it
 * picks its target with
 *
 *     mainTreeNode.closest('body > *:not(#headlessui-portal-root)')
 *
 * which resolves to `#root`. An inert subtree is skipped by hit testing and
 * refuses focus, so *everything* inside it stops responding to hover, focus and
 * clicks — which is correct for the app behind a modal, and wrong for the app's
 * other modals, because those were rendered inside `#root` too.
 *
 * So with Settings open, the command palette, the browser, the system monitor
 * and history search all still drew, still animated, and were completely dead
 * to the mouse. Reverse the order and it was worse: a click aimed at the
 * (inert) browser modal fell straight through to the Settings dialog's
 * full-screen backdrop underneath and dismissed it — which is why it looked
 * like the button worked sometimes and not others.
 *
 * These overlays are modals in their own right, not app chrome sitting behind
 * one, so they belong beside Headless UI's portal rather than under its inert
 * flag. Nothing about stacking changes: this container declares no position or
 * z-index, so its children take part in the same root stacking context they
 * always did.
 */

const CONTAINER_ID = "figy-overlays";

let container: HTMLElement | null = null;

function overlayRoot(): HTMLElement {
  // `isConnected` guards the dev-server case where the document is replaced
  // out from under a module that survived the reload.
  if (container?.isConnected) return container;

  container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = CONTAINER_ID;
    document.body.appendChild(container);
  }
  return container;
}

export function OverlayPortal({ children }: { children: ReactNode }) {
  return createPortal(children, overlayRoot());
}

/**
 * The grip that appears in the margin beside whichever block you are pointing
 * at, and reorders blocks when dragged.
 *
 * Lexical's `DraggableBlockPlugin_EXPERIMENTAL` does the hard part — tracking
 * which block the pointer is over, running the drag, and deciding where a drop
 * would land. What it does not do is draw anything: the handle and the
 * drop-target line are ours, and it portals them into `anchor`.
 *
 * It is flagged experimental upstream, so it is kept behind this one small
 * wrapper. If the API moves, this file is the only thing that has to follow.
 */

import { useRef } from "react";
import { DraggableBlockPlugin_EXPERIMENTAL } from "@lexical/react/LexicalDraggableBlockPlugin";
import { GripVertical } from "lucide-react";

const HANDLE_CLASS = "drawing-note-grip";

export function DragHandlePlugin({ anchor }: { anchor: HTMLElement | null }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLDivElement>(null);

  // The plugin measures against the anchor, so there is nothing to place until
  // the pane exists.
  if (!anchor) return null;

  return (
    <DraggableBlockPlugin_EXPERIMENTAL
      anchorElem={anchor}
      menuRef={menuRef}
      targetLineRef={targetLineRef}
      menuComponent={
        <div ref={menuRef} className={HANDLE_CLASS} aria-label="Drag to reorder">
          <GripVertical size={13} />
        </div>
      }
      targetLineComponent={<div ref={targetLineRef} className="drawing-note-drop-line" />}
      // Asked on every pointer move during a drag, so it stays a class check
      // rather than anything that touches layout.
      isOnMenu={(element) => !!element.closest(`.${HANDLE_CLASS}`)}
    />
  );
}
